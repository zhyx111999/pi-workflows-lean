// Bounds how many settled runs keep their full state in the manager's memory.

import { type RunStatus, TERMINAL_RUN_STATUSES } from "../run-persistence.js";

/** Settled runs kept in memory by default. Their records are already on disk, so a few suffice. */
export const DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY = 20;

/**
 * FIFO eviction of settled (completed/failed/aborted) runs from the manager's
 * run map. A run is recorded only after its execution has persisted its final
 * state and released its lease; running and paused runs are never recorded.
 * The newest few stay so listeners of the final event still see the live
 * object. Evicted runs are read from disk like any run this process never had.
 */
export class TerminalRunRetention {
  /** Oldest first. A run resumed after eviction can appear twice; eviction re-checks it. */
  private readonly queue: string[] = [];
  private readonly runs: Map<string, { status: RunStatus }>;
  private readonly max: number;

  constructor(runs: Map<string, { status: RunStatus }>, max: number) {
    this.runs = runs;
    this.max = max;
  }

  /** Make a settled run eviction-eligible and evict the oldest beyond the limit. */
  record(runId: string): void {
    this.queue.push(runId);
    while (this.queue.length > this.max) {
      const oldest = this.queue.shift();
      if (oldest === undefined) break;
      // Check the current entry, not the one queued: a resume may have replaced
      // it with a live execution, which must stay.
      const current = this.runs.get(oldest);
      if (current && TERMINAL_RUN_STATUSES.has(current.status)) {
        this.runs.delete(oldest);
      }
    }
  }
}
