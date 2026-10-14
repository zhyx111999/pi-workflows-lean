import assert from "node:assert/strict";
import test from "node:test";
import { SessionSlots } from "../src/manager/session-slots.js";
import { SlotPool, SlotWaitCancelled } from "../src/runtime/slot-pool.js";

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a free pool starts the call synchronously", () => {
  const pool = new SlotPool(2);
  let started = 0;
  void pool.run(async () => {
    started++;
  });
  assert.equal(started, 1, "no microtask hop before the body runs");
});

test("never more than the limit at once, and queued calls start in arrival order", async () => {
  const pool = new SlotPool(2);
  const gates = Array.from({ length: 5 }, () => deferred());
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const runs = gates.map((gate, index) =>
    pool.run(async () => {
      started.push(index);
      peak = Math.max(peak, ++active);
      await gate.promise;
      active--;
    }),
  );
  await tick();
  assert.deepEqual(started, [0, 1]);

  gates[0].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2], "the oldest waiter takes the freed slot");
  gates[2].resolve();
  gates[1].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  for (const gate of gates) gate.resolve();
  await Promise.all(runs);
  assert.equal(peak, 2);
});

test("a stress of random durations never overshoots the limit", async () => {
  const pool = new SlotPool(3);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      pool.run(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, i % 4));
        active--;
      }),
    ),
  );
  assert.equal(active, 0);
  assert.equal(peak, 3);
});

test("a slot is counted when it is granted, so a newcomer cannot slip in before the waiter starts", async () => {
  const pool = new SlotPool(1);
  const aGate = deferred();
  const bGate = deferred();
  const events: string[] = [];
  let c: Promise<void> | undefined;
  const a = pool.run(async () => {
    await aGate.promise;
    // Two hops land c's arrival between a's release and the start of b, the waiter it granted.
    queueMicrotask(() =>
      queueMicrotask(() => {
        c = pool.run(async () => {
          events.push("c");
        });
      }),
    );
  });
  const b = pool.run(async () => {
    events.push("b");
    await bGate.promise;
  });
  aGate.resolve();
  await tick();
  assert.deepEqual(events, ["b"], "c queues behind b instead of running beside it");
  bGate.resolve();
  await Promise.all([a, b, c]);
  assert.deepEqual(events, ["b", "c"]);
});

test("a call cancelled while queued never runs and does not disturb the order of the others", async () => {
  const pool = new SlotPool(1);
  const gate = deferred();
  const started: string[] = [];
  const holder = pool.run(async () => {
    await gate.promise;
  });
  const controller = new AbortController();
  const cancelled = pool.run(async () => {
    started.push("cancelled");
  }, controller.signal);
  const next = pool.run(async () => {
    started.push("next");
  });
  controller.abort();
  await assert.rejects(cancelled, SlotWaitCancelled);

  gate.resolve();
  await Promise.all([holder, next]);
  assert.deepEqual(started, ["next"]);
});

test("a cancellation that fires after the slot was granted leaves the slot counted once", async () => {
  const pool = new SlotPool(1);
  const gate = deferred();
  const holder = pool.run(async () => {
    await gate.promise;
  });
  const controller = new AbortController();
  const grantee = deferred();
  const queued = pool.run(async () => {
    await grantee.promise;
    return "ran";
  }, controller.signal);
  gate.resolve();
  await holder;
  controller.abort(); // granted already: too late to leave the queue
  grantee.resolve();
  assert.equal(await queued, "ran");

  // The slot came back exactly once: one call runs at a time, none is stuck.
  let active = 0;
  let peak = 0;
  await Promise.all(
    [1, 2, 3].map(() =>
      pool.run(async () => {
        peak = Math.max(peak, ++active);
        await tick();
        active--;
      }),
    ),
  );
  assert.equal(peak, 1);
});

test("an already cancelled call leaves a full pool at once but still starts on a free one", async () => {
  const controller = new AbortController();
  controller.abort();

  const full = new SlotPool(1);
  const gate = deferred();
  const holder = full.run(async () => {
    await gate.promise;
  });
  await assert.rejects(
    full.run(async () => "never", controller.signal),
    SlotWaitCancelled,
  );
  gate.resolve();
  await holder;

  // The caller's own check decides what a call that arrives cancelled does.
  assert.equal(await new SlotPool(1).run(async () => "ran", controller.signal), "ran");
});

test("a call that throws or rejects gives its slot back", async () => {
  const pool = new SlotPool(1);
  await assert.rejects(
    pool.run(async () => {
      throw new Error("rejects");
    }),
    /rejects/,
  );
  await assert.rejects(
    pool.run((() => {
      throw new Error("throws synchronously");
    }) as () => Promise<never>),
    /throws synchronously/,
  );
  assert.equal(await pool.run(async () => "free"), "free");
});

test("raising the limit admits the queue at once; lowering it never stops a running call", async () => {
  const pool = new SlotPool(1);
  const gates = Array.from({ length: 4 }, () => deferred());
  const started: number[] = [];
  const runs = gates.map((gate, index) =>
    pool.run(async () => {
      started.push(index);
      await gate.promise;
    }),
  );
  await tick();
  assert.deepEqual(started, [0]);

  pool.setLimit(3);
  await tick();
  assert.deepEqual(started, [0, 1, 2], "queued calls fill the new room immediately");

  pool.setLimit(1);
  gates[0].resolve();
  gates[1].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2], "two still run, so nothing new starts below the new limit");
  gates[2].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[3].resolve();
  await Promise.all(runs);
});

test("a pool that retains abandoned work keeps the slot until that work ends", async () => {
  const pool = new SlotPool(1, { retainAbandoned: true });
  const lingering = deferred();
  const started: string[] = [];
  await pool.run(async (hold) => {
    hold.retainUntil(lingering.promise);
  });
  const next = pool.run(async () => {
    started.push("next");
  });
  await tick();
  assert.deepEqual(started, [], "the call returned, the slot did not");

  lingering.reject(new Error("the abandoned work failed")); // a failure also ends it
  await next;
  assert.deepEqual(started, ["next"]);
});

test("a pool without retention frees the slot when the call returns", async () => {
  const pool = new SlotPool(1);
  await pool.run(async (hold) => {
    hold.retainUntil(new Promise(() => {}));
  });
  assert.equal(await pool.run(async () => "free"), "free");
});

test("onIdle fires only once nothing runs, waits, or lingers", async () => {
  let idle = 0;
  const pool = new SlotPool(1, { retainAbandoned: true, onIdle: () => idle++ });

  const gate = deferred();
  const first = pool.run(async () => {
    await gate.promise;
  });
  const second = pool.run(async () => {});
  gate.resolve();
  await first;
  await tick();
  assert.equal(idle, 1, "fires after the last call, not between a call and the one waiting behind it");
  await second;

  const lingering = deferred();
  await pool.run(async (hold) => {
    hold.retainUntil(lingering.promise);
  });
  await tick();
  assert.equal(idle, 1, "the lingering work still holds the slot");
  lingering.resolve();
  await tick();
  assert.equal(idle, 2);
});

test("sessions have separate ceilings, runs of one session share one", async () => {
  const slots = new SessionSlots(2);
  const limiters = { a1: slots.limiterFor("A"), a2: slots.limiterFor("A"), b: slots.limiterFor("B") };
  const gate = deferred();
  const active = { A: 0, B: 0 };
  const peak = { A: 0, B: 0 };
  const hold = (session: "A" | "B") => async () => {
    peak[session] = Math.max(peak[session], ++active[session]);
    await gate.promise;
    active[session]--;
  };
  const runs = [
    ...[0, 1, 2].map(() => limiters.a1(hold("A"))),
    ...[0, 1, 2].map(() => limiters.a2(hold("A"))),
    ...[0, 1, 2].map(() => limiters.b(hold("B"))),
  ];
  await tick();
  assert.deepEqual(active, { A: 2, B: 2 }, "each session reaches its own ceiling");
  gate.resolve();
  await Promise.all(runs);
  assert.deepEqual(peak, { A: 2, B: 2 });
});

test("runs without a parent session share one ceiling", async () => {
  const slots = new SessionSlots(1);
  const gate = deferred();
  let active = 0;
  let peak = 0;
  const body = async () => {
    peak = Math.max(peak, ++active);
    await gate.promise;
    active--;
  };
  const runs = [slots.limiterFor(undefined)(body), slots.limiterFor(undefined)(body)];
  await tick();
  assert.equal(active, 1);
  gate.resolve();
  await Promise.all(runs);
  assert.equal(peak, 1);
});

test("a new concurrency reaches the sessions that are running and the ones that start later", async () => {
  const slots = new SessionSlots(1);
  let gate = deferred();
  let active = 0;
  const body = async () => {
    active++;
    await gate.promise;
    active--;
  };
  const runs = [0, 1, 2].map(() => slots.limiterFor("A")(body));
  await tick();
  assert.equal(active, 1);

  slots.setConcurrency(3);
  await tick();
  assert.equal(active, 3, "the running session is raised");

  gate.resolve();
  await Promise.all(runs);
  gate = deferred();
  slots.setConcurrency(2);
  const later = [0, 1, 2].map(() => slots.limiterFor("A")(body));
  const other = [0, 1, 2].map(() => slots.limiterFor("B")(body));
  await tick();
  assert.equal(active, 4, "sessions that start later use the new value too");
  gate.resolve();
  await Promise.all([...later, ...other]);
});

test("the ceiling is clamped to a usable value", async () => {
  const slots = new SessionSlots(0);
  assert.equal(await slots.limiterFor("A")(async () => "runs at 1"), "runs at 1");
  let active = 0;
  let peak = 0;
  slots.setConcurrency(10_000);
  await Promise.all(
    Array.from({ length: 40 }, () =>
      slots.limiterFor("A")(async () => {
        peak = Math.max(peak, ++active);
        await tick();
        active--;
      }),
    ),
  );
  assert.equal(peak, 16);
});
