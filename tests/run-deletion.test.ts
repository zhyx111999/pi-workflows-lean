import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RunRecordDeletedError } from "../src/errors.js";
import { createRunPersistence, type PersistedRunState, type RunPersistence } from "../src/run-persistence.js";
import {
  _resetDeliveryRegistriesForTests,
  bindSessionDelivery,
  installResultDelivery,
  resumeSessionDelivery,
  suspendSessionDelivery,
} from "../src/task-panel.js";
import { WorkflowManager } from "../src/workflow-manager.js";
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
