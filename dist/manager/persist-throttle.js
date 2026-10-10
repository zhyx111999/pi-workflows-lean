// Coalesces each run's high-frequency progress writes into one trailing write.
/** Trailing-edge window for progress writes. */
const PERSIST_THROTTLE_MS = 400;
/**
 * At most one pending write per run. Bursts of completed agents share one disk
 * write instead of one each. Lifecycle writes cancel the pending one and write
 * at once, so a stale trailing write can never land after them.
 */
export class PersistThrottle {
    timers = new Map();
    /** Write once after the window, unless a write is already pending; it reads live state anyway. */
    schedule(runId, write) {
        if (this.timers.has(runId))
            return;
        const timer = setTimeout(() => {
            this.timers.delete(runId);
            write();
        }, PERSIST_THROTTLE_MS);
        // A pending progress write should never keep the process alive on its own.
        timer.unref?.();
        this.timers.set(runId, timer);
    }
    /** Drop the pending write: an immediate write or a deletion supersedes it. */
    cancel(runId) {
        const timer = this.timers.get(runId);
        if (!timer)
            return;
        clearTimeout(timer);
        this.timers.delete(runId);
    }
}
