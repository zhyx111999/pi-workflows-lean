/** Implements parallel() and pipeline(): fan-outs that turn recoverable workflow failures into null. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isWorkflowError, WorkflowErrorCode } from "../errors.js";
/**
 * Cancellation flag of one parallel()/pipeline() call. When a fan-out breaches
 * maxAgents, the breaching agent() throws and the fan-out rejects, but agents
 * it already reserved would keep waiting in the limiter and then spend money.
 * Their waits end when the batch is cancelled, and they bail instead.
 */
export class FanoutBatch {
    controller = new AbortController();
    /** Aborts when the batch is cancelled; a call still queued for a slot leaves the queue then. */
    get signal() {
        return this.controller.signal;
    }
    get cancelled() {
        return this.controller.signal.aborted;
    }
    cancel() {
        this.controller.abort();
    }
}
/**
 * Each fan-out runs its branches inside its own batch, so a breach cancels only
 * that fan-out's queued agents: a concurrent sibling or an enclosing fan-out
 * keeps running its already-reserved agents (still within maxAgents overall).
 */
const fanoutScope = new AsyncLocalStorage();
/**
 * The batch of the innermost fan-out enclosing the caller. agent() must read it
 * synchronously, before it suspends on the limiter and loses the caller's context.
 */
export function currentFanoutBatch() {
    return fanoutScope.getStore()?.batch;
}
/** The call sequence of the caller's branch, or of the script body outside any fan-out. Read it synchronously too. */
export function currentCallSequence(ctx) {
    return fanoutScope.getStore()?.calls ?? ctx.state.scriptCalls;
}
/** Build the script's parallel() global: run thunks concurrently. */
export function createParallel(ctx) {
    return async (thunks) => {
        ctx.throwIfAborted();
        if (!Array.isArray(thunks))
            throw new TypeError("parallel() expects an array of functions");
        if (thunks.some((thunk) => typeof thunk !== "function")) {
            throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
        }
        const batch = new FanoutBatch();
        return runBranches(ctx, batch, thunks, async (thunk, index) => {
            try {
                return await thunk();
            }
            catch (error) {
                return settleBranchFailure(ctx, batch, error, `parallel[${index}]`);
            }
        });
    };
}
/** Build the script's pipeline() global: pass each item through the stages in order, items concurrently. */
export function createPipeline(ctx) {
    return async (items, ...stages) => {
        ctx.throwIfAborted();
        if (!Array.isArray(items))
            throw new TypeError("pipeline() expects an array as the first argument");
        if (stages.some((stage) => typeof stage !== "function")) {
            throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
        }
        const batch = new FanoutBatch();
        return runBranches(ctx, batch, items, async (item, index) => {
            try {
                let value = item;
                for (const stage of stages) {
                    ctx.throwIfAborted();
                    value = await stage(value, item, index);
                }
                ctx.throwIfAborted();
                return value;
            }
            catch (error) {
                return settleBranchFailure(ctx, batch, error, `pipeline[${index}]`);
            }
        });
    };
}
/**
 * Run one branch per item concurrently, each in its own scope: the fan-out's
 * batch, and a call sequence forked from the caller's, so every call keeps the
 * same journal index whichever branch reaches it first.
 */
function runBranches(ctx, batch, items, branch) {
    const parent = currentCallSequence(ctx);
    const sequences = parent.fork(items.length);
    return Promise.all(items.map((item, index) => fanoutScope.run({ batch, calls: sequences[index] }, () => branch(item, index)))).finally(() => parent.join(sequences));
}
/**
 * Only a recoverable WorkflowError becomes null, the same value agent() itself
 * resolves to after such a failure, so the other branches still count. Every
 * other error propagates unchanged, exactly as if the branch were awaited
 * directly: a checkpoint suspension, an abort, a nonrecoverable failure, or a
 * bug in the script's own thunk or stage, which must fail the run instead of
 * passing for missing coverage. Only a breached agent cap also cancels the rest
 * of this batch, since other errors do not doom its queued agents.
 */
function settleBranchFailure(ctx, batch, error, branch) {
    if (isWorkflowError(error) && error.recoverable && !ctx.isAborted()) {
        ctx.log(`${branch} failed: ${error.message}`);
        return null;
    }
    if (isWorkflowError(error) && error.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED)
        batch.cancel();
    throw error;
}
