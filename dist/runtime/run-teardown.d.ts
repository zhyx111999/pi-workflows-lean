/** Ends a run: seals a failed run, drains outstanding agent() calls, and closes the callbacks of abandoned agents. */
import type { WorkflowRunResult } from "../workflow.js";
import type { RunContext } from "./run-context.js";
/**
 * Called only for an error that escaped the script uncaught; errors that
 * parallel() or a script's own try/catch swallowed never get here. Aborting
 * in-flight siblings also covers a provider usage limit: work still running on
 * an exhausted quota is thrown away and re-runs on resume, rather than burning
 * more quota now.
 */
export declare function sealRunFatal(ctx: RunContext, error: unknown): void;
/**
 * Wait out every agent() call of the run, including ones the script never
 * awaited, then close late callbacks and dispose the store. `success` is the
 * result object of a completed run, refreshed here with the final usage.
 */
export declare function finishRun(ctx: RunContext, success: WorkflowRunResult | undefined): Promise<void>;
