import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { createSubagentsControlTool } from "../src/subagents-control-tool.js";
import { _resetDeliveryRegistriesForTests, bindSessionDelivery, installResultDelivery } from "../src/task-panel.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const oneAgentScript = `export const meta = { name: 'ownership_demo', description: 'one agent' }
const a = await agent('do it', { label: 'a' })
return { a }`;

function withTempProject(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-owner-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-owner-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      _resetDeliveryRegistriesForTests();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await pause(10);
  }
  assert.fail(`timed out waiting until ${what}`);
}

/** Agent that waits until its attempt is aborted, so a run can be paused. */
function waitingAgent() {
  return {
    run: (_prompt: string, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const abort = () => reject(new Error("waiting agent aborted"));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      }),
  };
}

/** Agent that finishes when the test opens its gate. */
function gatedAgent() {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    agent: {
      run: async () => {
        await gate;
        return "done";
      },
    },
    open: () => open(),
  };
}

/** Start a run, pause it, and wait until its execution settles: the manager keeps only a cached copy. */
async function settledPausedRun(manager: WorkflowManager): Promise<string> {
  const { runId, promise } = manager.startInBackground(oneAgentScript);
  await pause(30);
  assert.equal(manager.pause(runId), true);
  await promise.catch(() => {});
  assert.equal(manager.getRun(runId)?.lease, undefined, "the paused execution settled");
  return runId;
}

function deliveryPi(): ExtensionAPI {
  return {
    events: { emit: () => {}, on: () => () => {} },
    on: () => () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
}

/** Bind a recording delivery endpoint for each session, all in this test process. */
function recordDeliveries(manager: WorkflowManager, sessionIds: string[]): Map<string, string[]> {
  const pi = deliveryPi();
  installResultDelivery(pi, manager);
  const sent = new Map<string, string[]>();
  for (const sessionId of sessionIds) {
    const messages: string[] = [];
    sent.set(sessionId, messages);
    bindSessionDelivery(sessionId, pi, {
      manager,
      stableSend: (message) => {
        messages.push(message.content);
        return Promise.resolve();
      },
    });
  }
  return sent;
}

async function controlResume(manager: WorkflowManager, runId: string) {
  const tool = createSubagentsControlTool({ getManager: () => manager });
  const result = await (
    tool.execute as (
      ...args: unknown[]
    ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>
  )("control-call", { action: "resume", runId }, undefined, undefined, {});
  return { text: result.content[0].text, details: result.details };
}

function record(runId: string, sessionId: string): PersistedRunState {
  const now = new Date().toISOString();
  return {
    runId,
    workflowName: "record",
    script: "",
    sessionId,
    parentSessionId: sessionId,
    status: "running",
    phases: [],
    agents: [],
    logs: [],
    startedAt: now,
    updatedAt: now,
  };
}

test(
  "a full save keeps the session owner another writer moved, and reports it back",
  withTempProject(async (cwd) => {
    const executor = createRunPersistence(cwd);
    const other = createRunPersistence(cwd);
    executor.save(record("owned", "session-1"));

    assert.deepEqual(
      other.moveSession("owned", "session-2", (owner) => owner === "session-1"),
      { moved: true, sessionId: "session-2" },
    );
    const stale = { ...record("owned", "session-1"), status: "paused" as const };
    executor.save(stale);

    assert.equal(executor.load("owned")?.sessionId, "session-2", "the full save did not write the old owner back");
    assert.equal(executor.load("owned")?.status, "paused", "the rest of the save landed");
    assert.equal(stale.sessionId, "session-2", "the saved state carries the committed owner");
    assert.deepEqual(
      other.moveSession("owned", "session-3", (owner) => owner === "session-1"),
      { moved: false, sessionId: "session-2" },
      "a move from an owner the record no longer has is refused",
    );
    assert.equal(
      other.moveSession("missing", "session-3", () => true),
      null,
    );
  }),
);

test(
  "a session move by a cached copy survives the executing manager's saves and routes its delivery",
  withTempProject(async (cwd) => {
    const cached = new WorkflowManager({ cwd, sessionId: "session-1", agent: waitingAgent() });
    const runId = await settledPausedRun(cached);

    const gated = gatedAgent();
    const executor = new WorkflowManager({ cwd, sessionId: "sibling-session", agent: gated.agent });
    const sent = recordDeliveries(executor, ["session-1", "session-2", "sibling-session"]);
    assert.equal(await executor.resume(runId), true);
    assert.ok(executor.getRun(runId)?.lease, "the executor holds the lease");
    assert.equal(executor.findRun(runId)?.sessionId, "session-1", "an automatic resume keeps the run's session");

    // The cached copy's conversation continues as session-2 (/new, fork, switch).
    assert.equal(cached.adoptLiveRunsToSession("session-2", "session-1"), 1);
    assert.equal(executor.findRun(runId)?.sessionId, "session-2");

    // A full save by the executor, e.g. its usage-limit counter.
    executor.recordAutoResumeAttempts(runId, 1);
    assert.equal(executor.findRun(runId)?.sessionId, "session-2", "the executor's full save kept the move");
    assert.equal(executor.getRun(runId)?.sessionId, "session-2", "the executor follows the record");

    const completed = new Promise<void>((resolve) => executor.once("complete", () => resolve()));
    gated.open();
    await completed;
    await waitUntil(() => (sent.get("session-2")?.length ?? 0) > 0, "the result reaches session-2");

    assert.equal(sent.get("session-1")?.length, 0, "the old session receives nothing");
    assert.equal(sent.get("sibling-session")?.length, 0, "the executing session receives nothing");
    const persisted = executor.getPersistence().load(runId);
    assert.equal(persisted?.status, "completed");
    assert.equal(persisted?.sessionId, "session-2");
    assert.equal(persisted?.parentSessionId, "session-1", "parent lineage never moves");
  }),
);

test(
  "the executing manager delivers to the session its record names when the move lands after its last save",
  withTempProject(async (cwd) => {
    const cached = new WorkflowManager({ cwd, sessionId: "session-1", agent: waitingAgent() });
    const runId = await settledPausedRun(cached);

    const gated = gatedAgent();
    const executor = new WorkflowManager({ cwd, sessionId: "sibling-session", agent: gated.agent });
    const sent = recordDeliveries(executor, ["session-1", "session-2"]);
    assert.equal(await executor.resume(runId), true);
    assert.equal(cached.adoptLiveRunsToSession("session-2", "session-1"), 1);
    assert.equal(executor.getRun(runId)?.sessionId, "session-1", "the executor has not written since the move");

    const completed = new Promise<void>((resolve) => executor.once("complete", () => resolve()));
    gated.open();
    await completed;
    await waitUntil(() => (sent.get("session-2")?.length ?? 0) > 0, "the result reaches session-2");
    assert.equal(sent.get("session-1")?.length, 0, "the stale in-memory owner receives nothing");
    assert.equal(executor.findRun(runId)?.sessionId, "session-2");
  }),
);

test(
  "resuming another session's run through subagents_control delivers it to the resuming session",
  withTempProject(async (cwd) => {
    const origin = new WorkflowManager({
      cwd,
      sessionId: "session-a",
      sessionFile: "/sessions/a.jsonl",
      agent: waitingAgent(),
    });
    const runId = await settledPausedRun(origin);

    const gated = gatedAgent();
    const resumer = new WorkflowManager({ cwd, sessionId: "session-b", agent: gated.agent });
    const sent = recordDeliveries(resumer, ["session-a", "session-b"]);
    const resumed = await controlResume(resumer, runId);
    assert.equal(resumed.details.result, "resumed");
    assert.match(resumed.text, /The result is delivered here when the run finishes\./);

    const persisted = resumer.findRun(runId);
    assert.equal(persisted?.sessionId, "session-b", "delivery moved to the resuming session");
    assert.equal(persisted?.parentSessionId, "session-a", "parent lineage stays with the starting session");
    assert.equal(persisted?.parentSessionFile, "/sessions/a.jsonl");
    assert.deepEqual(
      resumer.listRuns().map((run) => run.runId),
      [runId],
      "the resuming session lists the run",
    );
    assert.deepEqual(origin.listRuns(), [], "the starting session no longer lists it");

    const completed = new Promise<void>((resolve) => resumer.once("complete", () => resolve()));
    gated.open();
    await completed;
    await waitUntil(() => (sent.get("session-b")?.length ?? 0) > 0, "the result reaches session-b");
    assert.equal(sent.get("session-a")?.length, 0);
  }),
);

test(
  "a result finished before any session bound is claimed by the first session that flushes it",
  withTempProject(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: { run: async () => "done" } });
    installResultDelivery(deliveryPi(), manager);
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise;
    assert.equal(manager.findRun(runId)?.sessionId, undefined, "nobody owns the result yet");
    assert.ok(manager.findRun(runId)?.pendingDelivery, "the result waits for a session");

    const sent = recordDeliveries(manager, ["first-session"]);
    await waitUntil(() => manager.findRun(runId)?.pendingDelivery === undefined, "the delivery is acknowledged");
    assert.equal(sent.get("first-session")?.length, 1);
    assert.equal(manager.findRun(runId)?.sessionId, "first-session", "the claim is on the record");
  }),
);

test(
  "session adoption by a cached copy does not take back a run another session resumed",
  withTempProject(async (cwd) => {
    const cached = new WorkflowManager({ cwd, sessionId: "session-1", agent: waitingAgent() });
    const runId = await settledPausedRun(cached);

    const resumer = new WorkflowManager({ cwd, sessionId: "session-b", agent: waitingAgent() });
    assert.equal((await controlResume(resumer, runId)).details.result, "resumed");

    assert.equal(cached.adoptLiveRunsToSession("session-2", "session-1"), 0);
    assert.equal(resumer.findRun(runId)?.sessionId, "session-b", "the claim by session-b stands");
    assert.equal(cached.getRun(runId)?.sessionId, "session-b", "the cached copy learns the owner");

    assert.equal(resumer.stop(runId), true);
    await waitUntil(() => resumer.getRun(runId)?.lease === undefined, "the stopped execution settles");
  }),
);
