import { WorkflowError } from "../errors.js";
import type { ManagedRun } from "../workflow-manager.js";
/** How a failed execution settles its run. */
export interface FailedExecution {
    /** The error rethrown to whoever awaits the execution. */
    error: WorkflowError;
    /** The error recorded on the run. */
    terminalError: WorkflowError;
    /** The new status; undefined keeps the one pause()/stop() already set. */
    status?: "paused" | "aborted" | "failed";
    /** A provider usage limit pauses the run so it can resume automatically. */
    usageLimitPaused: boolean;
    /** pause()/stop() already announced this outcome, so no error event follows. */
    announced: boolean;
}
/**
 * Classify an error that escaped runWorkflow. Several causes can race: a
 * provider limit, the host's abort, a user pause()/stop(), a real failure.
 * Each abort carries the reason object of whoever caused it, so the first
 * cause decides; a later one never relabels it.
 */
export declare function classifyFailure(managed: ManagedRun, error: unknown): FailedExecution;
/**
 * A warning when every agent of this execution returned nothing. agent()
 * resolves an exhausted recoverable failure (e.g. an empty response) to null,
 * so such a run still completes; without the warning it looks successful.
 * Rows seeded from the record at resume are history and do not count.
 */
export declare function emptyFleetWarning(managed: ManagedRun): string | undefined;
