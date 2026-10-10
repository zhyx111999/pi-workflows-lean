/**
 * At most one pending write per run. Bursts of completed agents share one disk
 * write instead of one each. Lifecycle writes cancel the pending one and write
 * at once, so a stale trailing write can never land after them.
 */
export declare class PersistThrottle {
    private readonly timers;
    /** Write once after the window, unless a write is already pending; it reads live state anyway. */
    schedule(runId: string, write: () => void): void;
    /** Drop the pending write: an immediate write or a deletion supersedes it. */
    cancel(runId: string): void;
}
