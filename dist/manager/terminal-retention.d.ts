import { type RunStatus } from "../run-persistence.js";
/** Settled runs kept in memory by default. Their records are already on disk, so a few suffice. */
export declare const DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY = 20;
/**
 * FIFO eviction of settled (completed/failed/aborted) runs from the manager's
 * run map. A run is recorded only after its execution has persisted its final
 * state and released its lease; running and paused runs are never recorded.
 * The newest few stay so listeners of the final event still see the live
 * object. Evicted runs are read from disk like any run this process never had.
 */
export declare class TerminalRunRetention {
    /** Oldest first. A run resumed after eviction can appear twice; eviction re-checks it. */
    private readonly queue;
    private readonly runs;
    private readonly max;
    constructor(runs: Map<string, {
        status: RunStatus;
    }>, max: number);
    /** Make a settled run eviction-eligible and evict the oldest beyond the limit. */
    record(runId: string): void;
}
