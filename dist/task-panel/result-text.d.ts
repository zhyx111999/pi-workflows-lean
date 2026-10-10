/** Wording and size limits for the messages delivered when a background run finishes, fails, or pauses. */
import type { WorkflowManager } from "../workflow-manager.js";
import type { WorkflowSettings } from "../workflow-settings.js";
/**
 * Pick a clean human-readable summary from a workflow result, in order of
 * preference: a `verdict`/`report`/`summary`/`synthesis` string field, a bare
 * string result, else a JSON dump capped at `maxChars`. When the dump is truncated
 * the dropped size is reported; the full result stays reachable through the
 * "Full result" pointer the delivered message appends.
 */
export declare function summarizeResult(result: unknown, maxChars?: number): string;
/** Absolute path to a run's persisted result JSON. Undefined if the persistence
 *  layer can't be resolved — delivery must never throw in the complete handler. */
export declare function persistedResultPath(manager: WorkflowManager, runId: string, result?: unknown): string | undefined;
/** Delivered JSON-dump truncation threshold from settings (already normalized),
 *  defaulting to 400 when unset or unreadable. */
export declare function deliveredMaxChars(loadSettings?: () => WorkflowSettings): number;
export declare function failedRunText(runId: string, error?: {
    message?: string;
}): string;
export interface PausedEvent {
    runId: string;
    reason?: string;
    error?: {
        message?: string;
    };
    resetHint?: string;
    checkpoint?: {
        checkpointId: string;
        kind: string;
        payload?: unknown;
    };
}
/** The delivered notice for a pause the model must act on, or undefined for a manual pause. */
export declare function pausedRunText({ runId, reason, error, resetHint, checkpoint }: PausedEvent): string | undefined;
