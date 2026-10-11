/**
 * A resumed run lists each agent() call once. Every resume re-runs the calls
 * the journal cannot replay; the re-run takes over its call's row, and the
 * superseded execution is kept on that row as history, so counts, listings
 * and status reports count calls rather than executions.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent-usage.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedAgentState, PersistedRunState } from "../src/run-persistence.js";
import { runSummary } from "../src/run-record-store.js";
import { formatRunSummary, summarizeRun } from "../src/run-report.js";
import { SUBAGENT_TASKS_SCRIPT } from "../src/subagent-tasks.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { writeRunRecord } from "./helpers/run-records.js";

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-rows-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-rows-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(1);
  }
}

/** The execution has written its last record and released the run. */
function settled(manager: WorkflowManager, runId: string): () => boolean {
  return () => {
    const run = manager.getRun(runId);
    return run !== undefined && run.status !== "running" && run.lease === undefined;
  };
}

const USAGE: AgentUsage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: 0 };

/**
 * Every call reports usage and then waits to be aborted, except `limited`,
 * which hits the provider usage limit once all calls of the execution started.
 */
function quotaRunner(callsPerExecution: number, limited: string) {
  let started = 0;
  return {
    async run(prompt: string, options?: { onUsage?: (usage: AgentUsage) => void; signal?: AbortSignal }) {
      started++;
      options?.onUsage?.(USAGE);
      if (prompt === limited) {
        await until(() => started % callsPerExecution === 0, "every call of the execution to start");
        throw new WorkflowError("usage limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
          recoverable: false,
          resetHint: "Resets soon",
        });
      }
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
}

function assertOneRowPerCall(record: PersistedRunState | null | undefined, calls: number): PersistedAgentState[] {
  assert.ok(record, "the record exists");
  const agents = record.agents;
  assert.equal(agents.length, calls, "one row per call");
  assert.equal(new Set(agents.map((agent) => agent.callId)).size, calls, "no call has two rows");
  assert.equal(new Set(agents.map((agent) => agent.id)).size, calls, "row ids stay unique");
  assert.equal(runSummary(record).total, calls, "the record's summary counts calls");
  const summary = summarizeRun(record);
  assert.equal(summary.counts.total, calls, "status counts calls");
  assert.match(formatRunSummary(summary), new RegExp(` total=${calls} `));
  return agents;
}

test(
  "a usage-limit pause, a resume and a second pause keep one row per task",
  withTempCwd(async (cwd) => {
    const tasks = [
      { label: "alpha", task: "A" },
      { label: "beta", task: "B" },
      { label: "gamma", task: "C" },
    ];
    const manager = new WorkflowManager({ cwd, agent: quotaRunner(tasks.length, "B") });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(SUBAGENT_TASKS_SCRIPT, tasks);
    await promise.catch(() => {});
    await until(settled(manager, runId), "the first execution to settle");
    const firstPause = manager.getPersistence().load(runId);
    assert.equal(firstPause?.status, "paused");
    assert.equal(firstPause?.pauseReason, "usage_limit");
    assertOneRowPerCall(firstPause, tasks.length);
    const usageOfOneExecution = runSummary(firstPause as PersistedRunState).usage.fresh;
    assert.ok(usageOfOneExecution > 0);

    // The automatic resume after a usage-limit pause calls resume(runId).
    assert.equal(await manager.resume(runId), true);
    await until(settled(manager, runId), "the second execution to settle");
    assert.equal(manager.getSnapshot(runId)?.agentCount, tasks.length, "the live snapshot counts calls");

    const secondPause = manager.getPersistence().load(runId);
    assert.equal(secondPause?.status, "paused");
    const rows = assertOneRowPerCall(secondPause, tasks.length);
    assert.deepEqual(
      rows.map((row) => [row.label, row.status]),
      [
        ["alpha", "skipped"],
        ["beta", "error"],
        ["gamma", "skipped"],
      ],
      "each row shows the latest execution, in task order",
    );
    for (const row of rows) {
      assert.equal(row.priorExecutions?.length, 1, `${row.label} keeps its first execution as history`);
      assert.equal(row.priorExecutions?.[0]?.status, row.status, "the first execution ended the same way");
      assert.ok(row.priorExecutions?.[0]?.startedAt && row.priorExecutions[0].endedAt);
    }
    assert.equal(
      runSummary(secondPause as PersistedRunState).usage.fresh,
      2 * usageOfOneExecution,
      "spend of the superseded execution still counts",
    );
  }),
);

test(
  "a stopped script run lists each call once after resume, while running and when done",
  withTempCwd(async (cwd) => {
    const script = `export const meta = { name: 'stop_resume_rows', description: 'three parallel agents' }
phase('Work')
return await parallel([1, 2, 3].map((n) => () => agent('job ' + n, { label: 'job-' + n })))`;
    let finish = false;
    let running = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string, options?: { signal?: AbortSignal }) {
          if (finish) return `done:${prompt}`;
          running++;
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => {
                running--;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
        },
      },
    });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(script);
    promise.catch(() => {});
    await until(() => running === 3, "all three agents to start");
    assert.equal(manager.stop(runId), true);
    await until(settled(manager, runId), "the stopped execution to settle");
    const stopped = manager.getPersistence().load(runId);
    assert.equal(stopped?.status, "aborted");
    assertOneRowPerCall(stopped, 3);

    // Resumed agents stay running until released, so the check sees the live state.
    assert.equal(await manager.resume(runId), true);
    await until(() => running === 3, "the resumed agents to start");
    const live = manager.getSnapshot(runId);
    assert.equal(live?.agents.length, 3, "the live snapshot lists each call once");
    assert.deepEqual(
      live?.agents.map((agent) => agent.status),
      ["running", "running", "running"],
    );
    const whileRunning = manager.getPersistence().load(runId);
    assertOneRowPerCall(whileRunning, 3);
    const summary = summarizeRun(whileRunning as PersistedRunState, live);
    assert.deepEqual(summary.counts, { total: 3, done: 0, running: 3, queued: 0, error: 0, skipped: 0 });

    finish = true;
    assert.equal(manager.stop(runId), true);
    await until(settled(manager, runId), "the second stop to settle");
    assert.equal(await manager.resume(runId), true);
    await until(settled(manager, runId), "the final execution to settle");
    const done = manager.getPersistence().load(runId);
    assert.equal(done?.status, "completed");
    const rows = assertOneRowPerCall(done, 3);
    for (const row of rows) {
      assert.equal(row.status, "done");
      assert.deepEqual(
        row.priorExecutions?.map((prior) => prior.status),
        ["skipped", "skipped"],
        "both stopped executions are history of the call",
      );
    }
  }),
);

test(
  "resume folds rows a record already lists twice for one call into that call's row",
  withTempCwd(async (cwd) => {
    const runId = "doubled-rows";
    const tasks = [
      { label: "alpha", task: "A" },
      { label: "beta", task: "B" },
    ];
    const row = (
      index: number,
      status: PersistedAgentState["status"],
      startedAt: string,
      extra: Partial<PersistedAgentState> = {},
    ): PersistedAgentState => ({
      id: 0,
      callId: `${runId}:${index}`,
      label: tasks[index].label,
      prompt: tasks[index].task,
      status,
      startedAt,
      endedAt: startedAt,
      ...extra,
    });
    writeRunRecord(workflowProjectPaths(cwd).runsDir, {
      runId,
      workflowName: "subagents",
      script: SUBAGENT_TASKS_SCRIPT,
      args: tasks,
      status: "aborted",
      phases: [],
      // Two executions of both calls, as earlier releases recorded them.
      agents: [
        row(0, "skipped", "2026-01-01T00:00:00.000Z", { tokens: 50, sessionFile: "/s/alpha-1.jsonl" }),
        row(1, "error", "2026-01-01T00:00:01.000Z", { errorCode: WorkflowErrorCode.PROVIDER_USAGE_LIMIT }),
        row(0, "skipped", "2026-01-01T00:01:00.000Z", { sessionFile: "/s/alpha-2.jsonl" }),
        row(1, "running", "2026-01-01T00:01:01.000Z"),
      ].map((agent, i) => ({ ...agent, id: i + 1 })),
      logs: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });
    const manager = new WorkflowManager({ cwd, agent: { run: async (prompt: string) => `done:${prompt}` } });
    manager.on("error", () => {});

    assert.equal(await manager.resume(runId), true);
    await until(settled(manager, runId), "the resumed execution to settle");
    const record = manager.getPersistence().load(runId);
    assert.equal(record?.status, "completed");
    const rows = assertOneRowPerCall(record, 2);
    assert.deepEqual(
      rows.map((agent) => [agent.label, agent.status, agent.priorExecutions?.map((prior) => prior.status)]),
      [
        ["alpha", "done", ["skipped", "skipped"]],
        ["beta", "done", ["error", "skipped"]],
      ],
      "earlier executions become history in order; an unsettled one settles as interrupted",
    );
    assert.deepEqual(
      rows[0].priorExecutions?.map((prior) => prior.sessionFile),
      ["/s/alpha-1.jsonl", "/s/alpha-2.jsonl"],
      "history keeps each execution's session link",
    );
    assert.equal(rows[0].priorExecutions?.[0]?.tokens, 50);
  }),
);
