/** Implements parallel() and pipeline(): fan-outs that turn recoverable branch failures into null. */

import { AsyncLocalStorage } from "node:async_hooks";
import { WorkflowCheckpointSuspensionError, WorkflowErrorCode, wrapError } from "../errors.js";
import type { CallSequence } from "./call-position.js";
import type { RunContext } from "./run-context.js";

/**
 * Cancellation flag of one parallel()/pipeline() call. When a fan-out breaches
 * maxAgents, the breaching agent() throws and the fan-out rejects, but agents
 * it already reserved would keep waiting in the limiter and then spend money.
 * They check this flag before dispatch and bail instead.
 */
export interface FanoutBatch {
  cancelled: boolean;
}

/** What a branch's code sees of the fan-out it runs in. */
interface FanoutBranch {
  readonly batch: FanoutBatch;
  /** Numbers the branch's own calls, so their journal keys do not depend on timing. */
  readonly calls: CallSequence;
}

/**
 * Each fan-out runs its branches inside its own batch, so a breach cancels only
 * that fan-out's queued agents: a concurrent sibling or an enclosing fan-out
 * keeps running its already-reserved agents (still within maxAgents overall).
 */
const fanoutScope = new AsyncLocalStorage<FanoutBranch>();

/**
 * The batch of the innermost fan-out enclosing the caller. agent() must read it
 * synchronously, before it suspends on the limiter and loses the caller's context.
 */
export function currentFanoutBatch(): FanoutBatch | undefined {
  return fanoutScope.getStore()?.batch;
}

/** The call sequence of the caller's branch, or of the script body outside any fan-out. Read it synchronously too. */
export function currentCallSequence(ctx: RunContext): CallSequence {
  return fanoutScope.getStore()?.calls ?? ctx.state.scriptCalls;
}

/** Build the script's parallel() global: run thunks concurrently. */
export function createParallel(ctx: RunContext) {
  return async (thunks: Array<() => Promise<unknown>>) => {
    ctx.throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    const batch: FanoutBatch = { cancelled: false };
    return runBranches(ctx, batch, thunks, async (thunk, index) => {
      try {
        return await thunk();
      } catch (error) {
        return settleBranchFailure(ctx, batch, error, `parallel[${index}]`);
      }
    });
  };
}

/** Build the script's pipeline() global: pass each item through the stages in order, items concurrently. */
export function createPipeline(ctx: RunContext) {
  return async (items: unknown[], ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>) => {
    ctx.throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    const batch: FanoutBatch = { cancelled: false };
    return runBranches(ctx, batch, items, async (item, index) => {
      let value: unknown = item;
      for (const stage of stages) {
        try {
          ctx.throwIfAborted();
          value = await stage(value, item, index);
          ctx.throwIfAborted();
        } catch (error) {
          return settleBranchFailure(ctx, batch, error, `pipeline[${index}]`);
        }
      }
      return value;
    });
  };
}

/**
 * Run one branch per item concurrently, each in its own scope: the fan-out's
 * batch, and a call sequence forked from the caller's, so every call keeps the
 * same journal index whichever branch reaches it first.
 */
function runBranches<T>(
  ctx: RunContext,
  batch: FanoutBatch,
  items: readonly T[],
  branch: (item: T, index: number) => Promise<unknown>,
): Promise<unknown[]> {
  const parent = currentCallSequence(ctx);
  const sequences = parent.fork(items.length);
  return Promise.all(
    items.map((item, index) => fanoutScope.run({ batch, calls: sequences[index] }, () => branch(item, index))),
  ).finally(() => parent.join(sequences));
}

/**
 * A recoverable branch failure becomes null so the other branches still count.
 * Suspensions, aborts and non-recoverable errors propagate and halt the run,
 * exactly like a directly awaited agent(); only a breached agent cap also
 * cancels the rest of this batch, since other errors do not doom it.
 */
function settleBranchFailure(ctx: RunContext, batch: FanoutBatch, error: unknown, branch: string): null {
  if (error instanceof WorkflowCheckpointSuspensionError) throw error;
  if (ctx.isAborted()) throw error;
  const workflowError = wrapError(error);
  if (!workflowError.recoverable) {
    if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) batch.cancelled = true;
    throw workflowError;
  }
  ctx.log(`${branch} failed: ${workflowError.message}`);
  return null;
}
