/** Runs a live agent() call under the concurrency limit: its worktree, usage accounting, retries and journaling. */

import type { TSchema } from "typebox";
import type { AgentDefinition } from "../agent-registry.js";
import { createAgentCallUsageTracker, sumAgentUsage } from "../agent-usage.js";
import { WorkflowError, WorkflowErrorCode, workflowAbortedError, wrapError } from "../errors.js";
import type { AgentOptions } from "../workflow.js";
import { createWorktree, removeWorktree, type Worktree } from "../worktree.js";
import { type AttemptAbort, dispatchAttempt, linkAttemptAbort, withTimeout } from "./agent-attempt.js";
import type { FanoutBatch } from "./fanout.js";
import type { RunContext } from "./run-context.js";
import { normalizeAgentRetries, retryBackoffMs } from "./run-limits.js";

/** A validated agent() call with its reserved slot, resume identity and display state. */
export interface AgentCall {
  readonly prompt: string;
  readonly options: AgentOptions;
  readonly definition: AgentDefinition | undefined;
  readonly isolation: "worktree" | undefined;
  /** Script-requested cwd, already resolved to its real path. */
  readonly cwd: string | undefined;
  readonly phase: string | undefined;
  readonly label: string;
  /** Explicit, definition or phase model; undefined lets the agent layer pick (tier or default). */
  readonly modelSpec: string | undefined;
  /** Lexical call index, the journal key. */
  readonly index: number;
  readonly hash: string;
  /** Per-call id carried by every onAgent* event and used as the store delta key. */
  readonly id: string;
  /** The enclosing fan-out, whose breach cancels this call while it is still queued. */
  readonly batch: FanoutBatch | undefined;
  /**
   * What /workflows shows as the model: first a guess (this call's spec, else the
   * session's main model), then the real model once the agent layer resolves it.
   */
  displayModel: string | undefined;
}

/** A string result that is blank means the subagent produced no answer at all. */
export function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

export function runLiveAgent(ctx: RunContext, call: AgentCall): Promise<unknown> {
  const { state, options, store } = ctx;
  const { id, label, phase, prompt } = call;
  return state.limiter(async () => {
    // A queued call can obtain its slot after the abort drain abandoned it; it
    // must not create a worktree or announce a new agent.
    if (state.agentCallbacksClosed) throw workflowAbortedError();
    const maxAttempts = normalizeAgentRetries(options.agentRetries ?? 0) + 1;

    // Requested isolation is mandatory. A kept tree belongs to this execution,
    // not to a later retry or resume.
    let worktree: Worktree | undefined;
    if (call.isolation === "worktree") {
      worktree = await createWorktree(ctx.baseCwd, `${ctx.runId}-${call.index}-${label}`);
      if (!worktree.isolated) {
        throw new WorkflowError(
          `worktree isolation failed for "${label}": ${worktree.reason}`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
    }
    const runCwd = call.cwd ?? (worktree?.isolated ? worktree.cwd : undefined);
    const worktreePath = worktree?.isolated ? worktree.cwd : undefined;

    // Keeps provisional estimates apart from committed usage, sums retries, and
    // ignores callbacks from attempts that already settled.
    const usageTracker = createAgentCallUsageTracker((update) => {
      if (state.agentCallbacksClosed) return;
      if (update.committedUsage) {
        state.tokenUsage = sumAgentUsage(state.tokenUsage, update.committedUsage);
      }
      options.onAgentUsage?.({ id, label, phase, ...update });
    });

    try {
      // Worktree creation awaited; the run may have been abandoned meanwhile.
      if (state.agentCallbacksClosed) throw workflowAbortedError();
      options.onAgentStart?.({ id, label, phase, prompt, model: call.displayModel });
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const attemptUsage = usageTracker.startAttempt();
        const finalizeAttemptUsage = () => attemptUsage.commitTerminalUsage();
        state.pendingUsageFinalizers.add(finalizeAttemptUsage);
        let abort: AttemptAbort | undefined;
        let runPromise: Promise<unknown> | undefined;
        try {
          ctx.throwIfAborted();
          // This call's own fan-out breached maxAgents while it sat queued; bail before paying for it.
          if (call.batch?.cancelled) throw ctx.agentLimitError();

          abort = linkAttemptAbort(ctx);
          runPromise = dispatchAttempt(ctx, call, runCwd, abort.signal, attemptUsage);
          // A timed-out run can reject before the timeout path awaits its teardown.
          void runPromise.catch(() => undefined);
          const result = await withTimeout(runPromise, ctx.agentTimeoutMs, label, abort.abort);

          // Abort only, not throwIfAborted(): this result is paid for, so a pending
          // checkpoint suspension must not discard it unjournaled. The suspension
          // is raised at the next script-level check instead.
          if (ctx.isAborted()) throw workflowAbortedError();
          if (isEmptyTextAgentResult(result, call.options.schema)) {
            throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
              recoverable: true,
              agentLabel: label,
            });
          }

          const usageCommit = attemptUsage.commitWithFallback(() => estimateTokens(result) + estimateTokens(prompt));
          if (!call.options.thread) {
            // The resolved model is journaled (not hashed) so replayed rows show what really ran.
            options.onAgentJournal?.({
              index: call.index,
              hash: call.hash,
              result,
              model: call.displayModel,
              storeDelta: store.commitDelta(id),
            });
          } else {
            store.commitDelta(id);
          }
          options.onAgentEnd?.({
            id,
            label,
            phase,
            result,
            tokens: usageCommit.tokens,
            tokenUsage: usageCommit.tokenUsage,
            worktree: worktreePath,
            model: call.displayModel,
          });
          return result;
        } catch (error) {
          // A thread's next turn cannot start while an aborted wrapper is still
          // unwinding against the shared SessionManager.
          if (call.options.thread && runPromise) await runPromise.catch(() => {});
          if (ctx.isAborted()) {
            attemptUsage.commitTerminalUsage();
            throw error;
          }

          const workflowError = wrapError(error, { agentLabel: label });
          if (workflowError.code === WorkflowErrorCode.AGENT_TIMEOUT && runPromise) {
            await runPromise.catch(() => undefined);
          }
          ctx.logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
          const usageCommit = attemptUsage.commitWithFallback(() => estimateTokens(prompt));
          // Every attempt shares this call's delta key. A failed attempt's writes
          // must not stay visible to siblings or merge into a later attempt's
          // journaled delta, whether or not a retry follows.
          store.discardDelta(id);

          if (workflowError.recoverable && attempt < maxAttempts) {
            ctx.log(
              `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
            );
            const backoffMs = retryBackoffMs(attempt, options);
            if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
            ctx.throwIfAborted();
            continue;
          }

          options.onAgentEnd?.({
            id,
            label,
            phase,
            result: null,
            tokens: usageCommit.tokens,
            tokenUsage: usageCommit.tokenUsage,
            worktree: worktreePath,
            model: call.displayModel,
            error: workflowError.message,
            errorCode: workflowError.code,
            recoverable: workflowError.recoverable,
          });

          if (workflowError.recoverable) {
            ctx.log(
              `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
            );
            return null;
          }
          throw workflowError;
        } finally {
          state.pendingUsageFinalizers.delete(finalizeAttemptUsage);
          abort?.unlink();
        }
      }
      return null;
    } finally {
      if (worktree?.isolated) {
        if (call.options.keepWorktree === false) {
          await removeWorktree(worktree);
        } else {
          ctx.log(`worktree kept: ${worktree.cwd}${worktree.branch ? ` (${worktree.branch})` : ""}`);
        }
      }
    }
  });
}
