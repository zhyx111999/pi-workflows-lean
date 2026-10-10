// Aborts a run's execution while recording who asked: a user pause/stop or the host's signal.

import { WorkflowError, WorkflowErrorCode } from "../errors.js";

/** A user pause()/stop() that aborted one execution; `abortReason` is the AbortSignal.reason it set. */
export interface LifecycleControl {
  action: "pause" | "stop";
  abortReason: object;
}

/** A host/tool signal that aborted one execution; `abortReason` is the AbortSignal.reason it set. */
export interface ExternalAbort {
  abortReason: object;
}

/** The parts of a managed run that record abort ownership. */
interface AbortableRun {
  controller: AbortController;
  lifecycleControl?: LifecycleControl;
  externalAbort?: ExternalAbort;
}

/**
 * Abort for an explicit user lifecycle action. The fresh reason object is an
 * execution-scoped identity token. An already-aborted controller keeps its
 * original reason, so the earlier cause stays observable when the execution settles.
 */
export function abortForLifecycleControl(run: AbortableRun, action: LifecycleControl["action"]): void {
  if (run.controller.signal.aborted) return;
  const abortReason = {};
  run.lifecycleControl = { action, abortReason };
  run.controller.abort(abortReason);
}

/** Abort for the host signal, remembering it so a non-cooperative agent's late result cannot replace the abort. */
function abortForExternalSignal(run: AbortableRun): void {
  if (run.controller.signal.aborted) return;
  const abortReason = {};
  run.externalAbort = { abortReason };
  run.controller.abort(abortReason);
}

/**
 * Ties one execution to a host AbortSignal (e.g. Esc during a blocking tool
 * call). The listener belongs to that execution alone: detach() removes it, so
 * a reused host signal neither retains a settled run nor aborts it later.
 */
export class ExternalAbortLink {
  private readonly signal: AbortSignal;
  private readonly onAbort: () => void;

  constructor(signal: AbortSignal, run: AbortableRun) {
    this.signal = signal;
    this.onAbort = () => abortForExternalSignal(run);
  }

  attach(): void {
    if (this.signal.aborted) {
      this.onAbort();
      return;
    }
    try {
      this.signal.addEventListener("abort", this.onAbort, { once: true });
    } catch (error) {
      throw new WorkflowError(
        `Failed to register external abort listener: ${error instanceof Error ? error.message : String(error)}`,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        { recoverable: false, details: error },
      );
    }
  }

  /** Safe on every path: removing a listener that already fired or was never added is a no-op. */
  detach(): void {
    try {
      this.signal.removeEventListener("abort", this.onAbort);
    } catch (error) {
      // Cleanup must never replace the execution's real result or error.
      console.warn("[workflow-manager] Failed to remove external abort listener:", error);
    }
  }
}
