/** A ceiling on simultaneous agents that any number of runs can share, with FIFO admission and cancellable waits. */

/** A call left the queue before it got a slot, because its cancellation signal fired. */
export class SlotWaitCancelled extends Error {
  constructor() {
    super("cancelled while waiting for a concurrency slot");
    this.name = "SlotWaitCancelled";
  }
}

/** What a call holding a slot can tell the pool about it. */
export interface SlotHold {
  /**
   * Report work the call stopped waiting for but that still runs, such as an
   * agent that ignored its abort. The call can end on time; a pool that
   * retains abandoned work keeps the slot until `done` settles, so the ceiling
   * keeps counting the live child.
   */
  retainUntil(done: Promise<unknown>): void;
}

interface SlotPoolOptions {
  /** Fires when the last slot is released and nothing waits, so an owner can drop the pool. */
  onIdle?: () => void;
  /**
   * Keep the slot of abandoned work until it really ends. For a pool shared by
   * several runs, where the ceiling is about live children. A pool private to
   * one run leaves it off: that run has given up on the work and moves on.
   */
  retainAbandoned?: boolean;
}

/**
 * Runs `fn` once a slot is free. `cancel` only matters while the call is
 * queued: when it fires, the call leaves the queue and rejects with
 * SlotWaitCancelled without ever running `fn`.
 */
export type SlotLimiter = <T>(fn: (hold: SlotHold) => Promise<T>, cancel?: AbortSignal) => Promise<T>;

interface Waiter {
  /** Called with the slot already counted for this waiter. */
  readonly grant: () => void;
}

/** At most `limit` calls run at once; later callers queue in arrival order. `limit` must be at least 1. */
export class SlotPool {
  private active = 0;
  private readonly waiting = new Set<Waiter>();

  constructor(
    private limit: number,
    private readonly options: SlotPoolOptions = {},
  ) {}

  /**
   * Change the ceiling. Raising it admits queued calls at once; lowering it
   * never interrupts running ones, new calls just wait until enough finish.
   */
  setLimit(limit: number): void {
    this.limit = limit;
    this.admit();
  }

  /** Runs synchronously up to `fn` when a slot is free, so a free pool adds no delay. */
  async run<T>(fn: (hold: SlotHold) => Promise<T>, cancel?: AbortSignal): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await this.wait(cancel);

    const retained: Array<Promise<unknown>> = [];
    const retainUntil = (done: Promise<unknown>) => {
      if (this.options.retainAbandoned) retained.push(done);
    };
    try {
      return await fn({ retainUntil });
    } finally {
      if (retained.length === 0) this.release();
      else void Promise.allSettled(retained).then(() => this.release());
    }
  }

  /** Queue for a slot. The slot is counted when it is granted, so no caller can slip in between grant and start. */
  private wait(cancel: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (cancel?.aborted) return reject(new SlotWaitCancelled());
      // Once granted the listener is gone, so a late cancel can never double-release the slot.
      const onCancel = () => {
        this.waiting.delete(waiter);
        reject(new SlotWaitCancelled());
      };
      const waiter: Waiter = {
        grant: () => {
          cancel?.removeEventListener("abort", onCancel);
          resolve();
        },
      };
      cancel?.addEventListener("abort", onCancel, { once: true });
      this.waiting.add(waiter);
    });
  }

  private release(): void {
    this.active--;
    this.admit();
    if (this.active === 0 && this.waiting.size === 0) this.options.onIdle?.();
  }

  private admit(): void {
    for (const waiter of this.waiting) {
      if (this.active >= this.limit) return;
      this.waiting.delete(waiter);
      this.active++;
      waiter.grant();
    }
  }
}
