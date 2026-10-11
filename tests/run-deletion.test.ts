import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunRecordDeletedError } from "../src/errors.js";
import { createRunPersistence, type PersistedRunState, type RunPersistence } from "../src/run-persistence.js";
import { createSubagentsControlTool } from "../src/subagents-control-tool.js";
import {
  _resetDeliveryRegistriesForTests,
  bindSessionDelivery,
  installResultDelivery,
  resumeSessionDelivery,
  suspendSessionDelivery,
} from "../src/task-panel.js";
import { registerWorkflowCommands } from "../src/workflow-commands.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { commandDeps } from "./helpers/command-deps.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const SESSION = "deletion-session";
const oneAgentScript = `export const meta = { name: 'deletion_demo', description: 'one agent' }
const a = await agent('do it', { label: 'a' })
return { a }`;

function withTempProject(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-delete-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-delete-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      _resetDeliveryRegistriesForTests();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function record(runId: string, status: PersistedRunState["status"]): PersistedRunState {
  const now = new Date().toISOString();
  return {
    runId,
    workflowName: "record",
    script: "",
    status,
    phases: [],
    agents: [],
    logs: [],
    startedAt: now,
    updatedAt: now,
  };
}

function runFiles(persistence: RunPersistence, runId: string): string[] {
  return readdirSync(persistence.getRunsDir()).filter((name) => name.startsWith(runId));
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function quickAgent() {
  return { run: async () => "ok" };
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

function deliveryPi(): ExtensionAPI {
  return {
    events: { emit: () => {}, on: () => () => {} },
    on: () => () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
}

/** Start a run, pause it, and wait until its execution settles and releases the lease. */
async function settledPausedRun(manager: WorkflowManager): Promise<string> {
  const { runId, promise } = manager.startInBackground(oneAgentScript);
  await pause(30);
  assert.equal(manager.pause(runId), true);
  await promise.catch(() => {});
  assert.equal(manager.getRun(runId)?.lease, undefined, "the paused execution settled");
  return runId;
}

function deletedEvents(manager: WorkflowManager): string[] {
  const deleted: string[] = [];
  manager.on("deleted", (event: { runId: string }) => deleted.push(event.runId));
  return deleted;
}

async function controlTool(manager: WorkflowManager, params: Record<string, unknown>) {
  const tool = createSubagentsControlTool({ getManager: () => manager });
  const result = await (tool.execute as (...args: unknown[]) => Promise<{ details: Record<string, unknown> }>)(
    "control-call",
    params,
    undefined,
    undefined,
    {},
  );
  return result.details;
}

/** Run `/workflows <args>` against `manager`, returning what it printed and notified. */
function workflowsCommand(manager: WorkflowManager) {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const printed: string[] = [];
  const notified: string[] = [];
  const pi = {
    getCommands: () => [],
    registerCommand: (_name: string, options: { handler: typeof handler }) => {
      handler = options.handler;
    },
    sendMessage: async (message: { content: string }) => void printed.push(message.content),
  };
  registerWorkflowCommands(pi as unknown as ExtensionAPI, commandDeps({ manager }));
  const ctx = { ui: { notify: (message: string) => notified.push(message), setStatus: () => {} } };
  return { run: (args: string) => handler?.(args, ctx), printed, notified };
}

/** Another manager on the same project stands in for a separate Pi process. */
async function deleteFromAnotherManager(cwd: string, runId: string): Promise<void> {
  const other = new WorkflowManager({ cwd });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (other.deleteRun(runId)) return;
    await pause(10);
  }
  assert.fail(`run ${runId} could not be deleted`);
}

test(
  "persistence refuses to recreate a known run deleted by another process and removes its log",
  withTempProject(async (cwd) => {
    const owner = createRunPersistence(cwd);
    const reader = createRunPersistence(cwd);
    const deleter = createRunPersistence(cwd);

    owner.save(record("deleted-run", "completed"));
    writeFileSync(join(owner.getRunsDir(), "deleted-run.log"), "[log] entry\n");
    assert.ok(reader.load("deleted-run"), "another process observes the record");
    assert.equal(deleter.delete("deleted-run"), true);
    assert.deepEqual(runFiles(owner, "deleted-run"), [], "record, sidecars, results, and run log are removed");

    assert.throws(() => owner.save(record("deleted-run", "completed")), RunRecordDeletedError);
    assert.throws(() => reader.save(record("deleted-run", "completed")), RunRecordDeletedError);
    assert.equal(owner.updateMetadata?.("deleted-run", { pendingDelivery: { kind: "complete" } }), false);
    assert.deepEqual(runFiles(owner, "deleted-run"), [], "no stale writer recreated the run");

    owner.save(record("new-run", "running"));
    assert.ok(owner.load("new-run"), "a run this process has never seen can still be created");
    assert.equal(owner.delete("new-run"), true);
    assert.throws(() => owner.save(record("new-run", "completed")), RunRecordDeletedError);
  }),
);

test(
  "deleting a run that only its backup still holds reports the deletion",
  withTempProject(async (cwd) => {
    const owner = createRunPersistence(cwd);
    owner.save(record("lone-backup", "paused"));
    owner.save(record("manager-backup", "paused"));
    for (const runId of ["lone-backup", "manager-backup"]) {
      unlinkSync(join(owner.getRunsDir(), `${runId}.json`));
      assert.ok(createRunPersistence(cwd).load(runId), "the backup still recovers the record");
    }

    assert.equal(createRunPersistence(cwd).delete("lone-backup"), true);
    assert.deepEqual(runFiles(owner, "lone-backup"), []);

    const manager = new WorkflowManager({ cwd });
    const deleted: string[] = [];
    manager.on("deleted", (event: { runId: string }) => deleted.push(event.runId));
    assert.equal(manager.deleteRun("manager-backup"), true);
    assert.deepEqual(deleted, ["manager-backup"]);
    assert.deepEqual(runFiles(owner, "manager-backup"), []);
  }),
);

// Each file a deletion removes, in a run that has all of them. The backup and
// the head are the recovery candidates; the rest only matter while a head does.
const DELETED_FILES = [
  { file: "backup", matches: (name: string) => name === "doomed.json.bak", committed: false },
  { file: "head", matches: (name: string) => name === "doomed.json", committed: false },
  { file: "event log", matches: (name: string) => name === "doomed.json.events.jsonl", committed: true },
  {
    file: "staged generation log",
    matches: (name: string) => /^doomed.json.events.[0-9a-f-]{36}.jsonl$/.test(name),
    committed: true,
  },
  { file: "temporary head", matches: (name: string) => name === "doomed.json.tmp", committed: true },
  { file: "result artifact", matches: (name: string) => name.startsWith("doomed.json.result-"), committed: true },
  { file: "run log", matches: (name: string) => name === "doomed.log", committed: true },
];

for (const { file, matches, committed } of DELETED_FILES) {
  test(
    `a deletion that cannot remove the ${file} leaves a loadable record or none, and deleting again finishes it`,
    withTempProject(async (cwd) => {
      let refuse = true;
      const deleter = createRunPersistence(cwd, {
        unlinkSync(path) {
          if (refuse && matches(basename(String(path))))
            throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
          unlinkSync(path);
        },
      });
      const owner = createRunPersistence(cwd);
      owner.save(record("doomed", "completed"));
      owner.exportResult("doomed", { answer: 42 });
      writeFileSync(join(owner.getRunsDir(), "doomed.log"), "[log] entry\n");
      writeFileSync(join(owner.getRunsDir(), "doomed.json.tmp"), "{}");
      // A generation switch that crashed before committing leaves its staged log.
      writeFileSync(join(owner.getRunsDir(), `doomed.json.events.${randomUUID()}.jsonl`), "");

      assert.throws(() => deleter.delete("doomed"), /EPERM/, "the failure is reported");
      const reader = createRunPersistence(cwd);
      const listed = reader.list().some((run) => run.runId === "doomed");
      const loaded = reader.load("doomed");
      assert.equal(listed, !committed, committed ? "the record is gone" : "the record is intact");
      assert.equal(loaded !== null, listed, "a listed record is loadable and a loadable one is listed");
      if (committed) {
        assert.throws(() => owner.save(record("doomed", "completed")), RunRecordDeletedError);
      } else {
        assert.equal(reader.loadPreview("doomed")?.status, "completed");
      }

      refuse = false;
      assert.equal(deleter.delete("doomed"), true, "deleting again finishes the deletion");
      assert.deepEqual(runFiles(owner, "doomed"), []);
      assert.equal(deleter.delete("doomed"), false, "nothing is left to delete");
    }),
  );
}

test(
  "a deletion whose cleanup fails after the commit still tells watchers the run is gone",
  withTempProject(async (cwd) => {
    const owner = createRunPersistence(cwd);
    owner.save(record("half-deleted", "completed"));
    // A directory where the run log should be cannot be unlinked, so the
    // cleanup after the commit point fails.
    mkdirSync(join(owner.getRunsDir(), "half-deleted.log"));
    const manager = new WorkflowManager({ cwd });
    const deleted: string[] = [];
    manager.on("deleted", (event: { runId: string }) => deleted.push(event.runId));
    assert.throws(() => manager.deleteRun("half-deleted"));
    assert.deepEqual(deleted, ["half-deleted"]);
    assert.equal(manager.findRun("half-deleted"), undefined);
  }),
);

for (const write of ["updateMetadata", "moveSession", "recoverInterrupted"] as const) {
  test(
    `a run first written by ${write} is not recreated after another process deletes it`,
    withTempProject(async (cwd) => {
      const other = createRunPersistence(cwd);
      other.save(record("metadata-first", "running"));
      const writer = createRunPersistence(cwd);
      const written =
        write === "updateMetadata"
          ? writer.updateMetadata("metadata-first", { autoResumeAttempts: 1 })
          : write === "moveSession"
            ? writer.moveSession("metadata-first", "writer", () => true)?.moved
            : writer.recoverInterrupted("metadata-first");
      assert.equal(written, true);

      assert.equal(other.delete("metadata-first"), true);
      assert.throws(() => writer.save(record("metadata-first", "paused")), RunRecordDeletedError);
      assert.deepEqual(runFiles(writer, "metadata-first"), []);
    }),
  );
}

test(
  "an in-flight delivery acknowledged after another process deletes the run does not recreate it",
  withTempProject(async (cwd) => {
    const manager = new WorkflowManager({ cwd, sessionId: SESSION, agent: quickAgent() });
    const pi = deliveryPi();
    installResultDelivery(pi, manager);
    const sent: string[] = [];
    let acknowledge: (() => void) | undefined;
    bindSessionDelivery(SESSION, pi, {
      manager,
      stableSend: (message) => {
        sent.push(message.content);
        return new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      },
    });

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise;
    assert.equal(sent.length, 1, "the completed result is being delivered");

    await deleteFromAnotherManager(cwd, runId);
    acknowledge?.();
    await pause(700);

    assert.deepEqual(runFiles(manager.getPersistence(), runId), [], "delivery ACK and retries do not recreate files");
    assert.equal(sent.length, 1, "the delivery is not repeated");
    assert.equal(manager.getRun(runId)?.pendingDelivery, undefined);
  }),
);

test(
  "a pending delivery for a run deleted by another process is abandoned instead of recreated",
  withTempProject(async (cwd) => {
    const manager = new WorkflowManager({ cwd, sessionId: SESSION, agent: quickAgent() });
    const pi = deliveryPi();
    installResultDelivery(pi, manager);
    const sent: string[] = [];
    bindSessionDelivery(SESSION, pi, {
      manager,
      stableSend: (message) => {
        sent.push(message.content);
        return Promise.resolve();
      },
    });
    suspendSessionDelivery(SESSION);

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise;
    assert.ok(manager.getPersistence().load(runId)?.pendingDelivery, "the result waits for its session");

    await deleteFromAnotherManager(cwd, runId);
    resumeSessionDelivery(SESSION, manager);
    await pause(700);

    assert.equal(sent.length, 0, "a deleted run is not delivered");
    assert.deepEqual(runFiles(manager.getPersistence(), runId), [], "delivery does not recreate files");
    assert.equal(manager.getRun(runId)?.pendingDelivery, undefined, "the stale live marker is dropped");
  }),
);

test(
  "a listed pending result another process deleted does not hold back the other pending results",
  withTempProject(async (cwd) => {
    const manager = new WorkflowManager({ cwd, sessionId: SESSION, agent: quickAgent(), maxTerminalRunsInMemory: 0 });
    const pi = deliveryPi();
    installResultDelivery(pi, manager);
    const sent: string[] = [];
    bindSessionDelivery(SESSION, pi, {
      manager,
      stableSend: (message) => {
        sent.push(message.content);
        return Promise.resolve();
      },
    });
    suspendSessionDelivery(SESSION);
    const survivor = manager.startInBackground(oneAgentScript);
    await survivor.promise;
    await pause(10);
    const deleted = manager.startInBackground(oneAgentScript);
    await deleted.promise;
    assert.deepEqual(
      manager
        .getPersistence()
        .list()
        .filter((run) => run.pendingDelivery)
        .map((run) => run.runId),
      [deleted.runId, survivor.runId],
      "the list cache holds both results, the deleted one first",
    );

    await deleteFromAnotherManager(cwd, deleted.runId);
    resumeSessionDelivery(SESSION, manager);
    await pause(100);

    assert.equal(sent.length, 1, "the surviving result is delivered by the same flush");
    assert.deepEqual(runFiles(manager.getPersistence(), deleted.runId), []);
  }),
);

test(
  "stopping a paused run deleted by another process does not recreate it",
  withTempProject(async (cwd) => {
    const owner = new WorkflowManager({ cwd, agent: waitingAgent() });
    const { runId, promise } = owner.startInBackground(oneAgentScript);
    promise.catch(() => {});
    await pause(30);
    assert.equal(owner.pause(runId), true);

    await deleteFromAnotherManager(cwd, runId);
    const deleted: string[] = [];
    owner.on("deleted", (event: { runId: string }) => deleted.push(event.runId));
    owner.stop(runId);

    assert.deepEqual(runFiles(owner.getPersistence(), runId), [], "stop does not write the deleted run again");
    assert.equal(owner.getRun(runId), undefined, "the stale local copy is dropped");
    assert.deepEqual(deleted, [runId]);
  }),
);

test(
  "session adoption drops runs another process deleted and does not count them",
  withTempProject(async (cwd) => {
    const owner = new WorkflowManager({ cwd, sessionId: SESSION, agent: waitingAgent() });
    const deletedId = await settledPausedRun(owner);
    const keptId = await settledPausedRun(owner);
    await deleteFromAnotherManager(cwd, deletedId);
    const deleted = deletedEvents(owner);

    assert.equal(owner.adoptLiveRunsToSession("next-session", SESSION), 1, "only the surviving run is adopted");
    assert.equal(owner.getRun(deletedId), undefined);
    assert.deepEqual(deleted, [deletedId]);
    assert.equal(owner.getPersistence().load(keptId)?.sessionId, "next-session");
    assert.deepEqual(runFiles(owner.getPersistence(), deletedId), []);
  }),
);

test(
  "session adoption does not count an undelivered result another process deleted",
  withTempProject(async (cwd) => {
    const manager = new WorkflowManager({ cwd, sessionId: SESSION, agent: quickAgent() });
    const pi = deliveryPi();
    installResultDelivery(pi, manager);
    bindSessionDelivery(SESSION, pi, { manager, stableSend: () => Promise.resolve() });
    suspendSessionDelivery(SESSION);
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise;
    assert.ok(manager.getRun(runId)?.pendingDelivery, "the result waits for its session");

    await deleteFromAnotherManager(cwd, runId);
    assert.equal(manager.adoptLiveRunsToSession("next-session", SESSION), 0);
    assert.equal(manager.getRun(runId), undefined);
    assert.deepEqual(runFiles(manager.getPersistence(), runId), []);
  }),
);

test(
  "subagents_control stop on a paused run another process deleted reports it gone, even inside the list cache",
  withTempProject(async (cwd) => {
    const owner = new WorkflowManager({ cwd, agent: waitingAgent() });
    const runId = await settledPausedRun(owner);
    owner.listAllRuns(); // the task panel's poll keeps the list cache warm
    await deleteFromAnotherManager(cwd, runId);
    const events: string[] = [];
    for (const name of ["stopped", "deleted"]) owner.on(name, () => events.push(name));

    const details = await controlTool(owner, { action: "stop", runId });
    assert.equal(details.result, "error");
    assert.equal(details.error, "run not found");
    assert.deepEqual(events, ["deleted"], "no stopped event for a run that no longer exists");
    assert.equal(owner.getRun(runId), undefined);
    assert.deepEqual(runFiles(owner.getPersistence(), runId), []);
  }),
);

for (const action of ["resume", "stop", "findRun", "recordAutoResumeAttempts"] as const) {
  test(
    `${action} drops a settled local copy of a run another process deleted`,
    withTempProject(async (cwd) => {
      const owner = new WorkflowManager({ cwd, agent: waitingAgent() });
      const runId = await settledPausedRun(owner);
      await deleteFromAnotherManager(cwd, runId);
      const deleted = deletedEvents(owner);

      if (action === "resume") assert.equal(await owner.resume(runId), false);
      else if (action === "stop") assert.equal(owner.stop(runId), false);
      else if (action === "findRun") assert.equal(owner.findRun(runId), undefined);
      else owner.recordAutoResumeAttempts(runId, 1);

      assert.equal(owner.getRun(runId), undefined);
      assert.equal(owner.getSnapshot(runId), null);
      assert.deepEqual(deleted, [runId]);
      assert.deepEqual(runFiles(owner.getPersistence(), runId), []);
    }),
  );
}

test(
  "/workflows and subagents_control agree that a run another process deleted is gone",
  withTempProject(async (cwd) => {
    const owner = new WorkflowManager({ cwd, agent: waitingAgent() });
    const runId = await settledPausedRun(owner);
    await deleteFromAnotherManager(cwd, runId);
    const command = workflowsCommand(owner);

    await command.run(`status ${runId}`);
    await command.run(`resume ${runId}`);
    await command.run(`stop ${runId}`);
    assert.deepEqual(command.printed, [], "no stale snapshot is printed");
    assert.deepEqual(command.notified, [`No workflow run "${runId}"`, `No run ${runId}`, `No run ${runId}`]);
    assert.equal((await controlTool(owner, { action: "status", runId })).error, "run not found");
  }),
);

for (const variant of ["catches", "swallows"] as const) {
  test(
    `deleting a running run whose script ${variant} the abort leaves no run log behind`,
    withTempProject(async (cwd) => {
      const source =
        variant === "catches"
          ? `export const meta = { name: 'catching_demo', description: 'logs after its agent ends' }
try { await agent('do it', { label: 'a' }) } catch (error) { log('agent ended: ' + error.message) }
return 'done'`
          : `export const meta = { name: 'swallowing_demo', description: 'ignores its agent failing' }
return await agent('do it', { label: 'a' }).catch(() => null)`;
      const manager = new WorkflowManager({ cwd, agent: waitingAgent() });
      const { runId, promise } = manager.startInBackground(source);
      const outcome = promise.then(
        () => "resolved",
        () => "rejected",
      );
      const agentRunning = () => manager.getRun(runId)?.snapshot.agents.some((agent) => agent.status === "running");
      for (let i = 0; i < 200 && !agentRunning(); i++) await pause(5);
      assert.ok(agentRunning(), "the agent is running");

      assert.equal(manager.deleteRun(runId), true);
      assert.equal(await outcome, "resolved", "the script outlived its abort");
      assert.deepEqual(runFiles(manager.getPersistence(), runId), [], "the run log is not recreated");
    }),
  );
}
