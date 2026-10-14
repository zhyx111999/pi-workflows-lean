import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  WORKFLOW_EXTENSION_BUILD,
} from "../src/extension-reload.js";
import { type SlotLimiter, SlotPool } from "../src/runtime/slot-pool.js";
import { runWorkflow } from "../src/workflow.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// defaultConcurrency is one ceiling per parent session: shared by all of that session's simultaneous
// runs, independent of every other session's. Prompts are "<session>:<run>:<task>" so a probe agent
// can count the live children of each session.

const CEILING = 2;
const LIMITS = { timeout: 30_000 };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await pause(5);
  }
  assert.fail(`timed out waiting until ${what}`);
}

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-slots-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-slots-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

interface ProbeOptions {
  /** Prompts whose runner keeps going after it is told to stop, like a hung child process. */
  ignoreAbort?: (prompt: string) => boolean;
}

/** Agent runner that stays live until the test finishes it, and counts live children per session. */
function probeAgent(options: ProbeOptions = {}) {
  const started: string[] = [];
  const live = new Map<string, (value: unknown) => void>();
  const active: Record<string, number> = {};
  const peak: Record<string, number> = {};
  const runner = {
    run(prompt: string, runOptions?: { signal?: AbortSignal }) {
      const session = prompt.split(":")[0];
      started.push(prompt);
      active[session] = (active[session] ?? 0) + 1;
      peak[session] = Math.max(peak[session] ?? 0, active[session]);
      return new Promise((resolve, reject) => {
        const leave = () => {
          active[session]--;
          live.delete(prompt);
        };
        live.set(prompt, (value) => {
          leave();
          resolve(value);
        });
        if (options.ignoreAbort?.(prompt)) return;
        const abort = () => {
          if (!live.has(prompt)) return;
          leave();
          reject(new Error(`${prompt} aborted`));
        };
        if (runOptions?.signal?.aborted) abort();
        else runOptions?.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  return {
    runner,
    started,
    active: (session: string) => active[session] ?? 0,
    peak: (session: string) => peak[session] ?? 0,
    finish: (prompt: string, value: unknown = "ok") => live.get(prompt)?.(value),
    finishAll: () => {
      for (const settle of [...live.values()]) settle("ok");
    },
  };
}

type Probe = ReturnType<typeof probeAgent>;

/** Finish whatever is live until every run has settled. */
async function finishUntilSettled(probe: Probe, ...runs: Array<Promise<unknown>>): Promise<void> {
  let done = false;
  const settled = Promise.allSettled(runs).then(() => {
    done = true;
  });
  while (!done) {
    probe.finishAll();
    await pause(2);
  }
  await settled;
}

const fanOutScript = (session: string, name: string, tasks: number) =>
  `export const meta = { name: '${name}', description: 'session ceiling probe' }
const results = await parallel(Array.from({ length: ${tasks} }, (_, i) => () => agent('${session}:${name}:' + i, { label: 'task ' + i })))
return results`;

/** Start a fan-out run as `session`, the way a tool call from that session would. */
function startRun(manager: WorkflowManager, session: string, name: string, tasks: number) {
  manager.setSessionId(session);
  const run = manager.startInBackground(fanOutScript(session, name, tasks));
  run.promise.catch(() => {});
  return { ...run, prompt: (task: number) => `${session}:${name}:${task}` };
}

function newManager(cwd: string, probe: Probe, extra: ConstructorParameters<typeof WorkflowManager>[0] = {}) {
  const manager = new WorkflowManager({ cwd, agent: probe.runner, concurrency: CEILING, ...extra });
  manager.on("error", () => {});
  return manager;
}

/** Track when a run's promise settles, without failing the test on a rejection. */
function watch(run: { promise: Promise<unknown> }) {
  const state = { settled: false };
  void run.promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

// ─── The ceiling is per parent session ──────────────────────────────────────────

test(
  "two sessions each reach the full ceiling at the same time",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe);
    const a = startRun(manager, "A", "a1", 5);
    const b = startRun(manager, "B", "b1", 5);

    await waitUntil(
      () => probe.active("A") === CEILING && probe.active("B") === CEILING,
      "both sessions at the ceiling",
    );
    await pause(40);
    assert.equal(probe.active("A"), CEILING, "A is held at its ceiling");
    assert.equal(probe.active("B"), CEILING, "B is not held back by A, nor A by B");

    await finishUntilSettled(probe, a.promise, b.promise);
    assert.equal(probe.peak("A"), CEILING);
    assert.equal(probe.peak("B"), CEILING);
    assert.equal(manager.findRun(a.runId)?.status, "completed");
    assert.equal(manager.findRun(b.runId)?.status, "completed");
  }),
);

test(
  "simultaneous runs of one session share a single ceiling, served in arrival order",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe);
    const runs = [startRun(manager, "A", "a1", 4), startRun(manager, "A", "a2", 4), startRun(manager, "A", "a3", 4)];

    await waitUntil(() => probe.active("A") === CEILING, "the session at its ceiling");
    await pause(40);
    assert.equal(probe.active("A"), CEILING, "three runs together stay at one ceiling, not three");
    assert.deepEqual(probe.started, [runs[0].prompt(0), runs[0].prompt(1)]);

    probe.finish(runs[0].prompt(0));
    await waitUntil(() => probe.started.length === 3, "the freed slot to be taken");
    assert.equal(probe.started[2], runs[0].prompt(2), "the oldest waiting call gets it, whichever run it belongs to");

    await finishUntilSettled(probe, ...runs.map((run) => run.promise));
    assert.equal(probe.peak("A"), CEILING);
    assert.equal(probe.started.length, 12);
  }),
);

// ─── Cancellation ────────────────────────────────────────────────────────────────

test(
  "stopping a run with active agents hands its slots to the session's waiting run",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe);
    const first = startRun(manager, "A", "a1", 2);
    await waitUntil(() => probe.active("A") === CEILING, "the first run to fill the ceiling");
    const second = startRun(manager, "A", "a2", 2);
    await pause(30);
    assert.deepEqual(probe.started, [first.prompt(0), first.prompt(1)], "the second run waits");

    assert.equal(manager.stop(first.runId), true);
    await waitUntil(() => probe.started.length === 4, "the second run to take over");
    assert.deepEqual(probe.started.slice(2), [second.prompt(0), second.prompt(1)]);
    assert.equal(probe.active("A"), CEILING, "the stopped run's slots were given back, not kept");

    await finishUntilSettled(probe, first.promise, second.promise);
    assert.equal(manager.findRun(first.runId)?.status, "aborted");
    assert.equal(manager.findRun(second.runId)?.status, "completed");
    assert.equal(probe.peak("A"), CEILING);
  }),
);

test(
  "stopping a run whose calls are still queued ends it at once, without waiting for another run's agents",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe);
    const holder = startRun(manager, "A", "a1", 2);
    await waitUntil(() => probe.active("A") === CEILING, "the holder to fill the ceiling");
    const queued = startRun(manager, "A", "a2", 3);
    await pause(30);
    const queuedRun = watch(queued);

    assert.equal(manager.stop(queued.runId), true);
    await waitUntil(() => queuedRun.settled, "the stopped run to settle while the holder still runs");
    assert.equal(probe.active("A"), CEILING, "the holder's agents are untouched");
    assert.equal(manager.findRun(queued.runId)?.status, "aborted");

    // Nothing of the stopped run starts later, and no slot is lost to it.
    probe.finishAll();
    await pause(40);
    assert.deepEqual(probe.started, [holder.prompt(0), holder.prompt(1)]);
    await holder.promise;
    const after = startRun(manager, "A", "a3", 2);
    await waitUntil(() => probe.active("A") === CEILING, "the whole ceiling to be available again");
    await finishUntilSettled(probe, after.promise);
  }),
);

test(
  "a checkpoint pause sends the run's queued calls away at once",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe, { concurrency: 1 });
    const holder = startRun(manager, "A", "a1", 1);
    await waitUntil(() => probe.active("A") === 1, "the holder to fill the ceiling");

    manager.setSessionId("A");
    const gated =
      manager.startInBackground(`export const meta = { name: 'gated', description: 'queued siblings and a checkpoint' }
await parallel([
  () => agent('A:gated:0', { label: 'q0' }),
  () => agent('A:gated:1', { label: 'q1' }),
  () => checkpoint({ kind: 'hold', checkpointId: 'gate-1', payload: {} }),
])`);
    gated.promise.catch(() => {});
    // The record says "paused" as soon as the checkpoint is created; the execution only ends once its queued calls are gone.
    const execution = watch(gated);
    await waitUntil(() => execution.settled, "the run's execution to end while the holder still runs");
    assert.equal(manager.findRun(gated.runId)?.status, "paused");
    assert.equal(probe.active("A"), 1, "the holder still runs: the pause did not wait for a free slot");

    probe.finishAll();
    await holder.promise;
    await pause(40);
    assert.deepEqual(probe.started, [holder.prompt(0)], "the queued siblings never ran");
  }),
);

test(
  "a fan-out that breaches maxAgents sends its queued agents away at once when the script catches it",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe, { concurrency: 1, maxAgents: 3 });
    const holder = startRun(manager, "A", "a1", 1);
    await waitUntil(() => probe.active("A") === 1, "the holder to fill the ceiling");

    manager.setSessionId("A");
    const breaching =
      manager.startInBackground(`export const meta = { name: 'breach', description: 'catches the agent cap' }
const outcome = await parallel(Array.from({ length: 6 }, (_, i) => () => agent('A:breach:' + i, { label: 'b' + i }))).then(() => 'ok', () => 'caught')
return outcome`);
    breaching.promise.catch(() => {});
    const run = watch(breaching);
    await waitUntil(() => run.settled, "the run to finish while the holder still runs");
    assert.equal((await breaching.promise).result, "caught");
    assert.equal(probe.active("A"), 1);
    assert.deepEqual(probe.started, [holder.prompt(0)]);

    await finishUntilSettled(probe, holder.promise);
  }),
);

// ─── Errors, retries, pause and resume ───────────────────────────────────────────

test(
  "a run that fails gives every slot back",
  LIMITS,
  withTempCwd(async (cwd) => {
    const fatal = new WorkflowError("bad input", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
    const probe = probeAgent();
    const failing = {
      run: (prompt: string, options?: { signal?: AbortSignal }) =>
        prompt === "A:a1:0" ? Promise.reject(fatal) : probe.runner.run(prompt, options),
    };
    const manager = newManager(cwd, probe, { agent: failing });
    const doomed = startRun(manager, "A", "a1", 5);
    await assert.rejects(doomed.promise, /bad input/);
    await waitUntil(() => probe.active("A") === 0, "the failed run's other agents to stop");
    assert.equal(manager.findRun(doomed.runId)?.status, "failed");

    const next = startRun(manager, "A", "a2", 4);
    await waitUntil(() => probe.active("A") === CEILING, "the whole ceiling to be available again");
    await finishUntilSettled(probe, next.promise);
  }),
);

test(
  "an agent that fails recoverably gives its slot to the next call",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe, { concurrency: 1 });
    const run = startRun(manager, "A", "a1", 3);
    await waitUntil(() => probe.active("A") === 1, "the first agent");
    probe.finish(run.prompt(0), ""); // an empty answer is a recoverable failure: the call ends with null
    await waitUntil(() => probe.started.length === 2, "the next call to take the slot");
    await finishUntilSettled(probe, run.promise);
    assert.deepEqual((await run.promise).result, [null, "ok", "ok"]);
    assert.equal(probe.peak("A"), 1);
  }),
);

test(
  "a retry keeps its slot through the backoff",
  LIMITS,
  withTempCwd(async (cwd) => {
    const order: string[] = [];
    let retryCalls = 0;
    const agent = {
      async run(prompt: string) {
        order.push(prompt);
        if (prompt !== "A:retry") return "ok";
        return ++retryCalls === 1 ? "" : "ok"; // empty first: recoverable, so retried
      },
    };
    const manager = new WorkflowManager({ cwd, agent, concurrency: 1, agentRetries: 1 });
    manager.on("error", () => {});
    manager.setSessionId("A");
    const first = manager.startInBackground(`export const meta = { name: 'retrying', description: 'one flaky agent' }
return await agent('A:retry', { label: 'retry' })`);
    await waitUntil(() => order.length === 1, "the flaky agent's first attempt");
    const second =
      manager.startInBackground(`export const meta = { name: 'waiting', description: 'queued behind the retry' }
return await agent('A:other', { label: 'other' })`);

    await pause(120); // inside the default 250 ms backoff
    assert.deepEqual(order, ["A:retry"], "the queued call does not slip into the backoff");
    await Promise.all([first.promise, second.promise]);
    assert.deepEqual(order, ["A:retry", "A:retry", "A:other"]);
  }),
);

test(
  "a paused run resumes under the session's ceiling and replays finished work without a slot",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe);
    const first = startRun(manager, "A", "a1", 4);
    await waitUntil(() => probe.active("A") === CEILING, "the run at the ceiling");
    probe.finish(first.prompt(0));
    probe.finish(first.prompt(1));
    await waitUntil(() => probe.started.length === 4, "the remaining two to start");

    assert.equal(manager.pause(first.runId), true);
    await waitUntil(() => probe.active("A") === 0, "the paused run's agents to stop");
    const other = startRun(manager, "A", "a2", 2);
    await waitUntil(() => probe.active("A") === CEILING, "another run of the session to use the freed slots");

    assert.equal(await manager.resume(first.runId), true);
    await pause(60);
    assert.equal(probe.active("A"), CEILING, "the resumed run queues instead of adding to the session");
    assert.equal(
      probe.started.filter((prompt) => prompt === first.prompt(0) || prompt === first.prompt(1)).length,
      2,
      "finished tasks replay from the journal without starting a runner",
    );

    probe.finish(other.prompt(0));
    probe.finish(other.prompt(1));
    await waitUntil(() => manager.findRun(other.runId)?.status === "completed", "the other run to finish");
    await waitUntil(() => probe.active("A") === CEILING, "the resumed run to take the slots");
    for (let i = 0; i < 400 && manager.findRun(first.runId)?.status !== "completed"; i++) {
      probe.finishAll();
      await pause(5);
    }
    assert.equal(manager.findRun(first.runId)?.status, "completed");
    assert.equal(probe.peak("A"), CEILING, "the session never went past its ceiling");
  }),
);

// ─── Session adoption and settings reload ────────────────────────────────────────

test(
  "adopting a run into another session moves its delivery, not its slots",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe);
    const adopted = startRun(manager, "A", "a1", 4);
    await waitUntil(() => probe.active("A") === CEILING, "A at its ceiling");

    // What session_start does after /new: the new session takes over the old one's running work.
    assert.equal(manager.adoptLiveRunsToSession("B", "A"), 1);
    manager.setSessionId("B");
    assert.equal(manager.getRun(adopted.runId)?.sessionId, "B", "results now go to B");
    assert.equal(manager.getRun(adopted.runId)?.parentSessionId, "A", "the lineage stays");

    const own = startRun(manager, "B", "b1", 4);
    await waitUntil(() => probe.active("B") === CEILING, "B's own run to get B's whole ceiling");
    assert.equal(probe.active("A"), CEILING, "the adopted run is still counted against A, not against B");

    probe.finish(adopted.prompt(0));
    await waitUntil(() => probe.started.includes(adopted.prompt(2)), "the adopted run's next call to start");
    assert.equal(probe.active("A"), CEILING, "it refills A's ceiling");
    assert.equal(probe.active("B"), CEILING, "and takes nothing from B's");

    await finishUntilSettled(probe, adopted.promise, own.promise);
    assert.equal(probe.peak("A"), CEILING);
    assert.equal(probe.peak("B"), CEILING);
  }),
);

test(
  "resuming another session's run from here claims its delivery but keeps its parent's ceiling",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe);
    const old = startRun(manager, "A", "a1", 3);
    await waitUntil(() => probe.active("A") === CEILING, "A at its ceiling");
    assert.equal(manager.pause(old.runId), true);
    await waitUntil(() => probe.active("A") === 0, "the paused run to stop");

    const own = startRun(manager, "B", "b1", 3); // the current session is B
    assert.equal(await manager.resume(old.runId, { claimDelivery: true }), true);
    assert.equal(manager.getRun(old.runId)?.sessionId, "B");
    assert.equal(manager.getRun(old.runId)?.parentSessionId, "A");

    await waitUntil(() => probe.active("A") === CEILING && probe.active("B") === CEILING, "both ceilings full");
    await pause(40);
    assert.equal(probe.active("A"), CEILING);
    assert.equal(probe.active("B"), CEILING, "the claimed run draws on A's ceiling, so B's own run keeps all of B's");

    for (let i = 0; i < 400 && manager.findRun(old.runId)?.status !== "completed"; i++) {
      probe.finishAll();
      await pause(5);
    }
    await finishUntilSettled(probe, own.promise);
    assert.equal(probe.peak("A"), CEILING);
    assert.equal(probe.peak("B"), CEILING);
  }),
);

test(
  "a settings reload changes the ceiling of running sessions at once and never stops a running agent",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent();
    const manager = newManager(cwd, probe);
    const run = startRun(manager, "A", "a1", 8);
    await waitUntil(() => probe.active("A") === CEILING, "A at its ceiling");

    // /reload hands the live manager to the next extension generation, which refreshes its settings.
    const handoff = { cwd, extensionBuild: WORKFLOW_EXTENSION_BUILD, manager };
    discardWorkflowRuntime();
    try {
      handoffWorkflowRuntime(handoff);
      const claimed = claimWorkflowRuntime().compatible;
      assert.equal(claimed?.manager, manager, "the same manager, so the same slot accounting");

      claimed?.manager.reconfigureAfterReload({ concurrency: 4 });
      await waitUntil(() => probe.active("A") === 4, "the queued agents to fill the raised ceiling");

      claimed?.manager.reconfigureAfterReload({ concurrency: 1 });
      await pause(30);
      assert.equal(probe.active("A"), 4, "lowering the ceiling does not stop running agents");
      probe.finish(run.prompt(0));
      probe.finish(run.prompt(1));
      probe.finish(run.prompt(2));
      await pause(40);
      assert.equal(probe.active("A"), 1);
      assert.equal(probe.started.length, 4, "nothing new starts while the session is at or above the lowered ceiling");

      probe.finish(run.prompt(3));
      await waitUntil(() => probe.started.length === 5, "one agent to start once the session is under the new ceiling");
      assert.equal(probe.active("A"), 1);

      // Without a configured value the manager's default of 8 applies: the three still queued join the one running.
      claimed?.manager.reconfigureAfterReload({});
      await waitUntil(() => probe.active("A") === 4, "the default of 8 admits the rest");
    } finally {
      discardWorkflowRuntime(handoff);
    }
    await finishUntilSettled(probe, run.promise);
  }),
);

// ─── A runner a run gave up on still counts ──────────────────────────────────────

const singleAgentScript = (name: string, prompt: string) =>
  `export const meta = { name: '${name}', description: 'one agent' }
return await agent('${prompt}', { label: 'only' })`;

test(
  "a timed-out runner that ignores its abort keeps its session slot until it exits",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent({ ignoreAbort: (prompt) => prompt.includes("hung") });
    const manager = newManager(cwd, probe, { concurrency: 1, agentTimeoutMs: 100 });
    manager.setSessionId("A");
    const abandoned = manager.startInBackground(singleAgentScript("hang", "A:hung"), undefined, {
      drainAbortGraceMs: 20,
    });
    abandoned.promise.catch(() => {});
    const settled = watch(abandoned);
    await waitUntil(() => settled.settled, "the run to settle on time despite the hung runner");
    assert.equal(probe.active("A"), 1, "the runner is still alive");

    const waiting = manager.startInBackground(singleAgentScript("next", "A:next"));
    waiting.promise.catch(() => {});
    manager.setSessionId("B");
    const elsewhere = manager.startInBackground(singleAgentScript("other", "B:other"));
    elsewhere.promise.catch(() => {});
    await waitUntil(() => probe.started.includes("B:other"), "another session to be unaffected");
    probe.finish("B:other");
    await elsewhere.promise;

    await pause(80);
    assert.ok(!probe.started.includes("A:next"), "no second child while the hung one lives in session A");

    probe.finish("A:hung"); // the runner finally exits
    await waitUntil(() => probe.started.includes("A:next"), "the slot to come back");
    probe.finish("A:next");
    assert.equal((await waiting.promise).result, "ok");
  }),
);

test(
  "a stopped run whose runner ignores the abort settles on time but the session slot stays taken until it exits",
  LIMITS,
  withTempCwd(async (cwd) => {
    const probe = probeAgent({ ignoreAbort: (prompt) => prompt.includes("hung") });
    const manager = newManager(cwd, probe, { concurrency: 1 });
    manager.setSessionId("A");
    // The script returns without awaiting the agent, so only the bounded final drain is left to wait for it.
    const hung = manager.startInBackground(
      `export const meta = { name: 'hang', description: 'one agent nobody awaits' }
void agent('A:hung', { label: 'only' })
return 'script-done'`,
      undefined,
      { drainAbortGraceMs: 20 },
    );
    hung.promise.catch(() => {});
    await waitUntil(() => probe.active("A") === 1, "the hung runner to start");
    const waiting = manager.startInBackground(singleAgentScript("next", "A:next"));
    waiting.promise.catch(() => {});
    await pause(30);

    const stopped = watch(hung);
    assert.equal(manager.stop(hung.runId), true);
    await waitUntil(() => stopped.settled, "the stopped run to settle within its grace");
    assert.equal(manager.findRun(hung.runId)?.status, "aborted");

    await pause(60);
    assert.ok(!probe.started.includes("A:next"), "the live child still counts against the session");
    probe.finish("A:hung");
    await waitUntil(() => probe.started.includes("A:next"), "the slot to come back once it exits");
    probe.finish("A:next");
    await waiting.promise;
  }),
);

// ─── runWorkflow on its own ──────────────────────────────────────────────────────

/** Fake agent that counts how many runs it serves at once. */
function countingAgent() {
  const state = { active: 0, peak: 0, release: [] as Array<() => void> };
  return {
    state,
    runner: {
      run: () =>
        new Promise<string>((resolve) => {
          state.peak = Math.max(state.peak, ++state.active);
          state.release.push(() => {
            state.active--;
            resolve("ok");
          });
        }),
    },
    releaseAll: () => {
      for (const release of state.release.splice(0)) release();
    },
  };
}

const standaloneScript = `export const meta = { name: 'standalone', description: 'fan out' }
return await parallel(Array.from({ length: 4 }, (_, i) => () => agent('t' + i, { label: 't' + i })))`;

/** Release the agents wave after wave until every run has returned. */
async function releaseUntilSettled(counting: ReturnType<typeof countingAgent>, ...runs: Array<Promise<unknown>>) {
  let done = false;
  const all = Promise.all(runs).then(() => {
    done = true;
  });
  while (!done) {
    counting.releaseAll();
    await pause(2);
  }
  await all;
}

test("standalone runWorkflow calls keep one private ceiling per run", LIMITS, async () => {
  const counting = countingAgent();
  const runs = [1, 2].map(() =>
    runWorkflow(standaloneScript, { agent: counting.runner, concurrency: CEILING, persistLogs: false }),
  );
  await waitUntil(() => counting.state.active === CEILING * 2, "both runs at their own ceiling");
  await releaseUntilSettled(counting, ...runs);
  assert.equal(counting.state.peak, CEILING * 2, "two runs add up, as before");
});

test("runWorkflow calls given one limiter share its ceiling", LIMITS, async () => {
  const pool = new SlotPool(CEILING);
  const limiter: SlotLimiter = (fn, cancel) => pool.run(fn, cancel);
  const counting = countingAgent();
  const runs = [1, 2].map(() => runWorkflow(standaloneScript, { agent: counting.runner, limiter, persistLogs: false }));
  await waitUntil(() => counting.state.active === CEILING, "the shared ceiling to fill");
  await pause(30);
  assert.equal(counting.state.active, CEILING);
  await releaseUntilSettled(counting, ...runs);
  assert.equal(counting.state.peak, CEILING);
});

test("an aborted runWorkflow leaves a shared limiter's queue without waiting for its slots", LIMITS, async () => {
  const pool = new SlotPool(1);
  const limiter: SlotLimiter = (fn, cancel) => pool.run(fn, cancel);
  const blocker = deferredBlocker();
  const blocking = limiter(() => blocker.promise);
  const counting = countingAgent();
  const controller = new AbortController();
  const run = runWorkflow(standaloneScript, {
    agent: counting.runner,
    limiter,
    signal: controller.signal,
    persistLogs: false,
  });
  run.catch(() => {});
  await pause(30);
  controller.abort();
  await assert.rejects(run, /abort/i);
  assert.equal(counting.state.peak, 0, "no agent of the aborted run ever started");

  blocker.open();
  await blocking;
  assert.equal(await limiter(async () => "free"), "free", "no slot was lost to the aborted run");
});

function deferredBlocker() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
