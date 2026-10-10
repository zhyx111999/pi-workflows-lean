/** Ends a run: seals a failed run, drains outstanding agent() calls, and closes the callbacks of abandoned agents. */

import type { WorkflowRunResult } from "../workflow.js";
import type { RunContext } from "./run-context.js";
import { resolveDrainAbortGraceMs } from "./run-limits.js";

/**
 * Called only for an error that escaped the script uncaught; errors that
 * parallel() or a script's own try/catch swallowed never get here. Aborting
 * in-flight siblings also covers a provider usage limit: work still running on
 * an exhausted quota is thrown away and re-runs on resume, rather than burning
 * more quota now.
 */
export function sealRunFatal(ctx: RunContext, error: unknown): void {
  // Notify the host before the drain: a pause/stop requested while siblings
  // settle must not erase the error that already ended this run.
  try {
    const observation = ctx.options.onRunFatal?.(error);
    // The hook is observational; consume a rejecting thenable so it cannot
    // become an unhandled rejection.
    if (observation != null && typeof (observation as { then?: unknown }).then === "function") {
      void Promise.resolve(observation).catch(() => {});
    }
  } catch {
    // Instrumentation must never mask the workflow's own terminal error.
  }
  ctx.state.runFatalController.abort();
}

/**
 * Wait out every agent() call of the run, including ones the script never
 * awaited, then close late callbacks and dispose the store. `success` is the
 * result object of a completed run, refreshed here with the final usage.
 */
export async function finishRun(ctx: RunContext, success: WorkflowRunResult | undefined): Promise<void> {
  const { options, state } = ctx;
  if (state.inFlight.size > 0) {
    ctx.log(`waiting for ${state.inFlight.size} outstanding agent() call(s) to settle before this run completes`);
  }
  // A completed run waits for its outstanding agents without limit: their
  // results are wanted. Once the run is aborted the wait is bounded, because
  // abort is cooperative and a runner that ignores its signal (with no agent
  // timeout configured) would otherwise block the run from ending forever.
  const graceMs = resolveDrainAbortGraceMs(options.drainAbortGraceMs);
  // Wakes the wait as soon as either abort source fires, so the grace clock starts.
  let wakeAbort: () => void = () => {};
  const abortWake = new Promise<void>((resolve) => {
    wakeAbort = resolve;
  });
  const externalWake = () => wakeAbort();
  const fatalWake = () => wakeAbort();
  options.signal?.addEventListener("abort", externalWake, { once: true });
  state.runFatalController.signal.addEventListener("abort", fatalWake, { once: true });
  try {
    // Loop: settling calls can start further calls that join the set.
    while (state.inFlight.size > 0) {
      const pending = Array.from(state.inFlight);
      if (!ctx.isAborted() || graceMs === Number.POSITIVE_INFINITY) {
        // Already aborted with unlimited grace: a plain wait. Racing the
        // resolved abortWake there would spin the microtask queue.
        if (ctx.isAborted()) {
          await Promise.allSettled(pending);
        } else {
          await Promise.race([Promise.allSettled(pending), abortWake]);
        }
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<"timeout">((resolve) => {
        // Deliberately ref'd: an unref'd timer would let the process exit
        // before the run reaches its terminal state.
        timer = setTimeout(() => resolve("timeout"), graceMs);
      });
      const winner = await Promise.race([Promise.allSettled(pending).then(() => "settled" as const), grace]);
      if (timer) clearTimeout(timer);
      if (winner === "timeout") {
        // Abandoned calls already carry a no-op rejection handler from agent().
        // Nothing they do later is kept: the store is disposed below, the
        // abort check precedes journaling, and the host ignores stale writes.
        ctx.log(
          `abandoning ${pending.length} outstanding agent() call(s) that did not settle within ${graceMs}ms of the drain's abort grace`,
        );
        break;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", externalWake);
    state.runFatalController.signal.removeEventListener("abort", fatalWake);
  }

  // An abandoned runner may still be live: record its latest usage while the
  // host is listening, then close every callback it still holds.
  for (const finalizeUsage of state.pendingUsageFinalizers) {
    try {
      finalizeUsage();
    } catch {
      // Best-effort: one broken finalizer must not leave the others open.
    }
  }
  state.pendingUsageFinalizers.clear();
  state.agentCallbacksClosed = true;

  // Reported after the drain, because agents settling during it commit usage
  // last. Success only: failed and aborted runs own their usage records.
  if (success) {
    success.tokenUsage = { ...state.tokenUsage };
    try {
      options.onTokenUsage?.(state.tokenUsage);
    } catch {
      // Instrumentation must never break teardown or mask the run's outcome.
    }
  }
  ctx.store.dispose();
}
