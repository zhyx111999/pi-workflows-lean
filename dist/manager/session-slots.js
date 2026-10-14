// The concurrency ceiling of each parent session. defaultConcurrency is shared by every run of one
// parent session, however many are running, and by none of another session's runs.
//
// A run belongs to the session in its `parentSessionId`. That lineage never changes: adopting a run
// into another session, or resuming it from there, moves its result delivery (`sessionId`) but not
// its slots. A run without a parent session shares one ceiling with the others like it.
import { resolveConcurrency } from "../runtime/run-limits.js";
import { SlotPool } from "../runtime/slot-pool.js";
export class SessionSlots {
    /**
     * A session's pool exists only while one of its agents runs or waits, and
     * every limiter looks it up when a call arrives, so a session that has
     * gone quiet leaves nothing behind and two live pools never share a key.
     */
    pools = new Map();
    limit;
    constructor(concurrency) {
        this.limit = resolveConcurrency(concurrency);
    }
    /**
     * Apply a new defaultConcurrency to every session at once, running executions
     * included. Raising it admits queued agents immediately; lowering it never
     * stops a running agent, new ones wait until the session is below the new ceiling.
     */
    setConcurrency(concurrency) {
        this.limit = resolveConcurrency(concurrency);
        for (const pool of this.pools.values())
            pool.setLimit(this.limit);
    }
    /** The limiter for runs whose parent session is `parentSessionId`. */
    limiterFor(parentSessionId) {
        return (fn, cancel) => this.poolFor(parentSessionId).run(fn, cancel);
    }
    poolFor(parentSessionId) {
        const existing = this.pools.get(parentSessionId);
        if (existing)
            return existing;
        // A runner a run gave up on is still a child of the session, so it keeps its slot until it exits.
        const pool = new SlotPool(this.limit, {
            retainAbandoned: true,
            onIdle: () => {
                if (this.pools.get(parentSessionId) === pool)
                    this.pools.delete(parentSessionId);
            },
        });
        this.pools.set(parentSessionId, pool);
        return pool;
    }
}
