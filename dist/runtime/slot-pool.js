/** A ceiling on simultaneous agents that any number of runs can share, with FIFO admission and cancellable waits. */
/** A call left the queue before it got a slot, because its cancellation signal fired. */
export class SlotWaitCancelled extends Error {
    constructor() {
        super("cancelled while waiting for a concurrency slot");
        this.name = "SlotWaitCancelled";
    }
}
/** At most `limit` calls run at once; later callers queue in arrival order. `limit` must be at least 1. */
export class SlotPool {
    limit;
    options;
    active = 0;
    waiting = new Set();
    constructor(limit, options = {}) {
        this.limit = limit;
        this.options = options;
    }
    /**
     * Change the ceiling. Raising it admits queued calls at once; lowering it
     * never interrupts running ones, new calls just wait until enough finish.
     */
    setLimit(limit) {
        this.limit = limit;
        this.admit();
    }
    /** Runs synchronously up to `fn` when a slot is free, so a free pool adds no delay. */
    async run(fn, cancel) {
        if (this.active < this.limit)
            this.active++;
        else
            await this.wait(cancel);
        const retained = [];
        const retainUntil = (done) => {
            if (this.options.retainAbandoned)
                retained.push(done);
        };
        try {
            return await fn({ retainUntil });
        }
        finally {
            if (retained.length === 0)
                this.release();
            else
                void Promise.allSettled(retained).then(() => this.release());
        }
    }
    /** Queue for a slot. The slot is counted when it is granted, so no caller can slip in between grant and start. */
    wait(cancel) {
        return new Promise((resolve, reject) => {
            if (cancel?.aborted)
                return reject(new SlotWaitCancelled());
            // Once granted the listener is gone, so a late cancel can never double-release the slot.
            const onCancel = () => {
                this.waiting.delete(waiter);
                reject(new SlotWaitCancelled());
            };
            const waiter = {
                grant: () => {
                    cancel?.removeEventListener("abort", onCancel);
                    resolve();
                },
            };
            cancel?.addEventListener("abort", onCancel, { once: true });
            this.waiting.add(waiter);
        });
    }
    release() {
        this.active--;
        this.admit();
        if (this.active === 0 && this.waiting.size === 0)
            this.options.onIdle?.();
    }
    admit() {
        for (const waiter of this.waiting) {
            if (this.active >= this.limit)
                return;
            this.waiting.delete(waiter);
            this.active++;
            waiter.grant();
        }
    }
}
