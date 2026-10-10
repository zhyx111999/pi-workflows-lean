/** Starts one attempt of a live agent() call: abort wiring, the runner request, and the attempt deadline. */

import type { AgentHistoryEntry } from "../agent-history.js";
import type { createAgentCallUsageTracker } from "../agent-usage.js";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { createAgentStoreTools } from "../shared-store.js";
import type { AgentCall } from "./agent-execution.js";
import type { RunContext } from "./run-context.js";

type AttemptUsage = ReturnType<ReturnType<typeof createAgentCallUsageTracker>["startAttempt"]>;

/** The abort controller of one attempt and the way to detach it from the run's signals. */
export interface AttemptAbort {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly unlink: () => void;
}

/**
 * Each attempt gets its own controller so a timeout can dispose that session
 * (and release its messages) instead of leaving it streaming while a retry
 * starts another. It also follows the caller's signal (pause/stop/Esc) and the
 * run-fatal seal, so in-flight siblings of a lost run wind down. unlink() must
 * run when the attempt ends, or listeners pile up on the run's signals.
 */
export function linkAttemptAbort(ctx: RunContext): AttemptAbort {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (ctx.isAborted()) {
    abort();
    return { signal: controller.signal, abort, unlink: () => {} };
  }
  const external = ctx.options.signal;
  const fatal = ctx.state.runFatalController.signal;
  external?.addEventListener("abort", abort, { once: true });
  fatal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    abort,
    unlink: () => {
      external?.removeEventListener("abort", abort);
      fatal.removeEventListener("abort", abort);
    },
  };
}

/** Hand the call to the agent runner; every callback goes quiet once the run's terminal drain closes. */
export function dispatchAttempt(
  ctx: RunContext,
  call: AgentCall,
  cwd: string | undefined,
  signal: AbortSignal,
  usage: AttemptUsage,
): Promise<unknown> {
  const { options, state, runId } = ctx;
  const { options: agentOptions, definition, id, label, phase } = call;
  return ctx.agentRunner.run(call.prompt, {
    label,
    // Identifiable name for persisted sessions (persistAgentSessions).
    sessionName: agentOptions.thread ? `workflow:${runId} thread:${agentOptions.thread}` : `workflow:${runId} ${label}`,
    schema: agentOptions.schema,
    signal,
    // The agentType body is the user's own role prompt; the runtime adds no text of its own.
    instructions: definition?.prompt || undefined,
    model: call.modelSpec,
    thinking: agentOptions.thinking ?? definition?.thinking,
    tier: agentOptions.tier,
    modelSource:
      agentOptions.model || definition?.model
        ? "explicit"
        : agentOptions.tier
          ? "tier"
          : call.modelSpec
            ? "phase"
            : undefined,
    modelRegistry: options.modelRegistry,
    toolNames: definition?.tools,
    disallowedToolNames: definition?.disallowedTools,
    // Store tools attribute this agent's writes to its call id, so the delta can be journaled and replayed.
    systemTools: createAgentStoreTools(ctx.store, id),
    cwd,
    onModelResolved: (model: string) => {
      if (state.agentCallbacksClosed) return;
      // Replace the pre-resolution guess while the agent is still running;
      // onAgentEnd and the journal carry the same value afterwards.
      call.displayModel = model;
      options.onAgentModel?.({ id, label, phase, model });
    },
    onModelFallback: ({
      tier,
      requestedSpec,
      source,
    }: {
      tier: string;
      requestedSpec: string;
      source: "medium-tier" | "inherit-main";
    }) => {
      if (state.agentCallbacksClosed) return;
      // Only an untagged agent's implicit route degrades (an explicit model or
      // tier fails with MODEL_NOT_FOUND instead); log it so the run shows it.
      ctx.log(
        source === "inherit-main"
          ? `inherited main model "${requestedSpec}" unavailable — using the session default`
          : `default "${tier}" tier model "${requestedSpec}" unavailable — using the session default`,
      );
    },
    onUsageProgress: usage.reportProgress,
    onUsage: usage.reportTerminal,
    onSessionCreated: ({ sessionId, sessionFile }: { sessionId: string; sessionFile?: string }) => {
      if (state.agentCallbacksClosed) return;
      options.onAgentSession?.({ callId: id, sessionId, sessionFile });
    },
    onHistory: (history: AgentHistoryEntry[]) => {
      if (state.agentCallbacksClosed) return;
      options.onAgentHistory?.({ id, label, phase, history });
    },
    registerSteer: (steer: (text: string) => Promise<void>) => {
      // An abandoned execution must not hand a late session to the host.
      const unregister = state.agentCallbacksClosed ? undefined : options.registerAgentSteer?.({ id, label, steer });
      return unregister ?? (() => {});
    },
    thread: agentOptions.thread,
  });
}

/**
 * Race the attempt against its deadline. `onTimeout` runs before the timeout
 * error wins so the caller can abort the session and free its resources; the
 * losing promise still settles later, and the caller awaits it before
 * committing usage or retrying.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Best-effort cleanup; never let it mask the timeout error.
      }
      reject(
        new WorkflowError(
          `Agent "${label}" timed out after ${ms}ms; raise defaultAgentTimeoutMs in the workflow settings to allow longer runs`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
