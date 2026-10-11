import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { AgentRunOptions } from "../src/agent.js";
import type { WorkflowSnapshot } from "../src/display.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState, RunStatus } from "../src/run-persistence.js";
import type { RunSummaryDetails } from "../src/run-report.js";
import { SUBAGENT_TASKS_SCRIPT } from "../src/subagent-tasks.js";
import { createSubagentsControlTool, SUBAGENTS_CONTROL_TOOL_NAME } from "../src/subagents-control-tool.js";
import { WorkflowManager } from "../src/workflow-manager.js";

function run(status: RunStatus = "running", runId = "audit-abc123"): PersistedRunState {
  return {
    runId,
    workflowName: "audit",
    script: "export const meta = { name: 'audit', description: 'audit' }; return await agent('x')",
    status,
    phases: ["Inspect"],
    currentPhase: "Inspect",
    agents: [
      { id: 1, label: "active scan", prompt: "scan", status: status === "running" ? "running" : "done", tokens: 30 },
      { id: 2, label: "queued check", prompt: "check", status: "queued" },
      { id: 3, label: "failed check", prompt: "fail", status: "error" },
      { id: 4, label: "optional check", prompt: "optional", status: "skipped" },
    ],
    logs: [],
    startedAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
    tokenUsage: { input: 20, output: 10, total: 30 },
  };
}

/** Manager double over persisted records, recording every lifecycle call. */
function fakeManager(initial: PersistedRunState[], liveSnapshots: Record<string, WorkflowSnapshot> = {}) {
  const runs = new Map(initial.map((item) => [item.runId, item]));
  const calls: Array<{ action: string; runId: string; options?: unknown }> = [];
  const manager = {
    listRuns: () => [...runs.values()],
    listAllRuns: () => [...runs.values()],
    findRun: (runId: string) => runs.get(runId),
    getSnapshot: (runId: string) => liveSnapshots[runId] ?? null,
    getSessionId: () => "control-session",
    async resume(runId: string, options?: { tasks?: unknown; script?: unknown }) {
      calls.push({ action: "resume", runId, options });
      const item = runs.get(runId);
      // Mirrors WorkflowManager.resume: a finished run reruns only with an edit.
      const edited = options?.tasks !== undefined || options?.script !== undefined;
      if (!item || item.status === "running" || (item.status === "completed" && !edited)) return false;
      item.status = "running";
      return true;
    },
    stop(runId: string) {
      calls.push({ action: "stop", runId });
      const item = runs.get(runId);
      if (!item || (item.status !== "running" && item.status !== "paused")) return false;
      item.status = "aborted";
      return true;
    },
  } as unknown as WorkflowManager;
  return { manager, calls };
}

function control(manager: WorkflowManager) {
  return createSubagentsControlTool({ getManager: () => manager });
}

function prepare(value: unknown): Record<string, unknown> {
  const tool = createSubagentsControlTool({ getManager: () => fakeManager([]).manager });
  return (tool.prepareArguments as (value: unknown) => Record<string, unknown>)(value);
}

/** Validate like Pi does, then execute. */
async function execute(manager: WorkflowManager, params: Record<string, unknown>) {
  const tool = control(manager);
  const prepared = (tool.prepareArguments as (value: unknown) => Record<string, unknown>)(params);
  assert.equal(Check(tool.parameters, prepared), true, "prepared arguments satisfy the schema");
  const result = await (tool.execute as any)("control-call", prepared, undefined, undefined, {});
  return { text: result.content[0].text as string, details: result.details as Record<string, unknown> };
}

test("subagents_control exposes six actions in one strict object schema", () => {
  const tool = control(fakeManager([]).manager);
  assert.equal(tool.name, SUBAGENTS_CONTROL_TOOL_NAME);
  assert.equal(tool.name, "subagents_control");
  // A top-level union serializes to `anyOf` without `type: "object"`, which strict providers reject.
  const schema = tool.parameters as unknown as {
    type: string;
    required: string[];
    properties: Record<string, { enum?: string[] }>;
  };
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["action"]);
  assert.deepEqual(schema.properties.action.enum, ["list", "status", "read", "stop", "resume", "message"]);
  assert.deepEqual(Object.keys(schema.properties), [
    "action",
    "runId",
    "label",
    "text",
    "tasks",
    "script",
    "checkpointId",
    "response",
  ]);
  for (const removed of ["pause", "restart"]) assert.equal(Check(tool.parameters, { action: removed }), false);
  assert.equal(Check(tool.parameters, { action: "status", runId: "r", extra: true }), false);
  for (const action of ["list", "status", "read", "stop", "resume", "message"]) {
    assert.match(tool.description, new RegExp(`\\b${action}\\b`));
  }
});

test("prepareArguments keeps only the fields each action uses", () => {
  // Providers can fill every optional field; fields the action does not use are dropped.
  const filled = {
    runId: "r1",
    label: "worker",
    text: "focus",
    tasks: [{ label: "a", task: "do a" }],
    script: "",
    checkpointId: null,
    response: null,
  };
  assert.deepEqual(prepare({ action: "list", ...filled }), { action: "list" });
  assert.deepEqual(prepare({ action: "status", ...filled }), { action: "status", runId: "r1" });
  assert.deepEqual(prepare({ action: "stop", ...filled }), { action: "stop", runId: "r1" });
  assert.deepEqual(prepare({ action: "read", ...filled }), { action: "read", runId: "r1", label: "worker" });
  assert.deepEqual(prepare({ action: "message", ...filled }), {
    action: "message",
    runId: "r1",
    label: "worker",
    text: "focus",
  });
  assert.deepEqual(prepare({ action: "resume", ...filled }), {
    action: "resume",
    runId: "r1",
    tasks: [{ label: "a", task: "do a" }],
  });
  // Null and blank optional values count as omitted.
  assert.deepEqual(prepare({ action: "read", runId: "", label: null }), { action: "read" });
  assert.deepEqual(prepare({ action: "resume", runId: "r1", tasks: [], script: " ", checkpointId: "" }), {
    action: "resume",
    runId: "r1",
  });
  assert.deepEqual(prepare({ action: "resume", runId: "r1", response: "dropped without a checkpointId" }), {
    action: "resume",
    runId: "r1",
  });
});

test("prepareArguments rejects unknown fields and missing required fields", () => {
  assert.throws(() => prepare("x"), /object argument/);
  assert.throws(
    () => prepare({ action: "pause", runId: "r1" }),
    /requires action: list\|status\|read\|stop\|resume\|message/,
  );
  assert.throws(() => prepare({ action: "list", extra: true }), /does not accept extra/);
  for (const action of ["status", "stop", "resume", "message"]) {
    assert.throws(() => prepare({ action }), /requires runId/);
    assert.throws(() => prepare({ action, runId: "  " }), /requires runId/);
  }
  assert.throws(() => prepare({ action: "message", runId: "r1", text: "x" }), /requires label/);
  assert.throws(() => prepare({ action: "message", runId: "r1", label: "a" }), /requires text/);
  assert.throws(() => prepare({ action: "status", runId: 7 }), /runId must be a string/);
});

test("resume takes one of an edited task list, an edited script, or a checkpoint answer", () => {
  const script =
    "export const meta = { name: 'edited', description: 'edited' }\nreturn await agent('x', { label: 'x' })";
  assert.deepEqual(prepare({ action: "resume", runId: "r1", script: `\`\`\`js\n${script}\n\`\`\`` }), {
    action: "resume",
    runId: "r1",
    script,
  });
  assert.deepEqual(prepare({ action: "resume", runId: "r1", checkpointId: "approve-1", response: null }), {
    action: "resume",
    runId: "r1",
    checkpointId: "approve-1",
    response: null,
  });
  assert.throws(
    () => prepare({ action: "resume", runId: "r1", tasks: [{ label: "a", task: "x" }], script }),
    /one of tasks, script, or checkpointId/,
  );
  assert.throws(
    () => prepare({ action: "resume", runId: "r1", script, checkpointId: "c", response: 1 }),
    /one of tasks, script, or checkpointId/,
  );
  assert.throws(() => prepare({ action: "resume", runId: "r1", checkpointId: "c" }), /requires response/);
  assert.throws(() => prepare({ action: "resume", runId: "r1", tasks: [{ label: "a" }] }), /tasks\[0\]\.task/);
  assert.throws(() => prepare({ action: "resume", runId: "r1", script: "return 1" }), /export const meta/);
});

test("list and status report lifecycle, agent states, and token totals", async () => {
  const { manager } = fakeManager([run()]);

  const listed = await execute(manager, { action: "list" });
  assert.match(listed.text, /^action=list result=ok runs=1\n/);
  assert.match(listed.text, /runId=audit-abc123 name="audit" status=running phase="Inspect"/);
  assert.match(listed.text, /total=4 done=0 running=1 queued=1 error=1 skipped=1 active="active scan" tokens=30$/);
  assert.deepEqual(listed.details.runs, [
    {
      runId: "audit-abc123",
      workflowName: "audit",
      status: "running",
      phase: "Inspect",
      checkpoint: null,
      counts: { total: 4, done: 0, running: 1, queued: 1, error: 1, skipped: 1 },
      activeLabels: ["active scan"],
      tokenTotal: 30,
      tokenTotalEstimated: false,
    },
  ]);

  const status = await execute(manager, { action: "status", runId: "audit-abc123" });
  assert.match(status.text, /^action=status result=ok runId=audit-abc123 /);
  assert.match(status.text, /\nagents:\n- active scan: running\n- queued check: queued\n- failed check: error\n/);
  assert.deepEqual((status.details.agents as unknown[]).length, 4);
  assert.equal(status.details.waitingCheckpoint, null);

  const empty = await execute(fakeManager([]).manager, { action: "list" });
  assert.equal(empty.text, "action=list result=ok runs=0");
});

test("status shows a waiting checkpoint's ID, kind, and payload preview, never its response", async () => {
  const waiting = run("paused");
  waiting.checkpoint = {
    version: 1,
    checkpointId: "publish-1",
    kind: "approval",
    status: "waiting",
    payload: { draft: "x".repeat(800) },
    createdAt: "2026-07-14T00:00:01.000Z",
  };
  const answered = run("paused", "answered-1");
  answered.checkpoint = { ...waiting.checkpoint, status: "resuming", response: { privateReceipt: "do-not-show" } };
  const { manager } = fakeManager([waiting, answered]);

  const status = await execute(manager, { action: "status", runId: "audit-abc123" });
  assert.match(status.text, /waiting at checkpoint publish-1 \(approval\): \{"draft":"x+…\n/);
  assert.match(status.text, /Answer with resume, this checkpointId, and a response\./);
  const preview = (status.details.waitingCheckpoint as { payload: string }).payload;
  assert.equal(preview.length, 501, "the payload preview is bounded");

  const resuming = await execute(manager, { action: "status", runId: "answered-1" });
  assert.equal(resuming.details.waitingCheckpoint, null);
  assert.doesNotMatch(JSON.stringify(resuming), /do-not-show|privateReceipt/);
});

test("status uses agent usage when the live run aggregate is lagging", async () => {
  const live: WorkflowSnapshot = {
    name: "audit",
    phases: ["Inspect"],
    currentPhase: "Inspect",
    logs: [],
    agents: [
      { id: 1, label: "estimated", prompt: "scan", status: "running", tokens: 80 },
      {
        id: 2,
        label: "reported",
        prompt: "check",
        status: "done",
        tokens: 40,
        tokenUsage: { input: 15, output: 5, total: 40, cacheRead: 20, cacheWrite: 0, cost: 0 },
      },
    ],
    agentCount: 2,
    runningCount: 1,
    doneCount: 1,
    errorCount: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
  };
  const { manager } = fakeManager([run()], { "audit-abc123": live });
  const status = await execute(manager, { action: "status", runId: "audit-abc123" });
  assert.match(status.text, /tokens=120\n/);
  assert.match(status.text, /\n- estimated: running\n- reported: done$/, "live agents win over the persisted rows");
});

test("status marks heuristic-estimated token totals with ~", async () => {
  const persisted = await execute(
    fakeManager([{ ...run("completed"), tokenUsage: { input: 0, output: 0, total: 200, estimated: true } }]).manager,
    { action: "status", runId: "audit-abc123" },
  );
  assert.match(persisted.text, /tokens=~200\n/);
  assert.equal((persisted.details.run as RunSummaryDetails).tokenTotalEstimated, true);

  const liveTotal = {
    name: "audit",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
    tokenUsage: { input: 0, output: 0, total: 640, estimated: true },
  } as WorkflowSnapshot;
  const live = await execute(fakeManager([run()], { "audit-abc123": liveTotal }).manager, {
    action: "status",
    runId: "audit-abc123",
  });
  assert.match(live.text, /tokens=~640/);

  const agentSum = {
    ...liveTotal,
    agents: [
      {
        id: 1,
        label: "scan",
        prompt: "scan",
        status: "running",
        tokens: 0,
        tokenUsage: { input: 0, output: 80, cacheRead: 0, cacheWrite: 0, total: 80, cost: 0, estimated: true },
      },
    ],
    tokenUsage: { input: 5, output: 5, total: 10 },
  } as WorkflowSnapshot;
  const summed = await execute(fakeManager([run()], { "audit-abc123": agentSum }).manager, {
    action: "status",
    runId: "audit-abc123",
  });
  assert.match(summed.text, /tokens=~80/, "the agent-usage branch carries the flag");
});

test("read returns one subagent's tail: by label, else the latest updated in the latest run", async () => {
  const older = run("completed", "older-run");
  const newer: PersistedRunState = {
    ...run("running", "newer-run"),
    startedAt: "2026-07-15T00:00:00.000Z",
    agents: [
      {
        id: 1,
        label: "first",
        prompt: "p",
        status: "done",
        result: "first result",
        history: [{ role: "assistant", kind: "text", text: "early", timestamp: 10 }],
      },
      {
        id: 2,
        label: "second",
        prompt: "p",
        status: "running",
        history: [
          { role: "user", kind: "text", text: "steered", timestamp: 30 },
          { role: "assistant", kind: "toolCall", toolName: "bash", text: "ls", timestamp: 31 },
        ],
      },
    ],
  };
  const { manager } = fakeManager([older, newer]);

  const latest = await execute(manager, { action: "read" });
  assert.equal(latest.text, "label: second\nstatus: running\n[user] steered\n[assistant:bash] ls");
  assert.deepEqual(latest.details, {
    action: "read",
    result: "ok",
    runId: "newer-run",
    label: "second",
    status: "running",
  });

  const labeled = await execute(manager, { action: "read", runId: "newer-run", label: "first" });
  assert.equal(labeled.text, "label: first\nstatus: done\n[assistant] early\n[result] first result");

  const missing = await execute(manager, { action: "read", runId: "newer-run", label: "nobody" });
  assert.match(missing.text, /result=error runId=newer-run error=no subagent labeled "nobody"; labels: first, second/);
  assert.match((await execute(manager, { action: "read", runId: "gone" })).text, /error=run not found/);
  assert.match((await execute(fakeManager([]).manager, { action: "read" })).text, /error=no runs in this session/);
});

test("read keeps only the last 8000 characters of a long session", async () => {
  const long: PersistedRunState = {
    ...run("running"),
    agents: [
      {
        id: 1,
        label: "chatty",
        prompt: "p",
        status: "running",
        history: [{ role: "assistant", kind: "text", text: `${"a".repeat(9000)}END`, timestamp: 1 }],
      },
    ],
  };
  const read = await execute(fakeManager([long]).manager, { action: "read", label: "chatty" });
  assert.equal(read.text.length, 8000);
  assert.ok(read.text.endsWith("END"));
});

test("stop ends a run, including one only on disk, and explains a refused stop", async () => {
  const fixture = fakeManager([run("paused", "cold-restart-1"), run("completed", "done-1")]);
  const stopped = await execute(fixture.manager, { action: "stop", runId: "cold-restart-1" });
  assert.match(stopped.text, /^action=stop result=stopped runId=cold-restart-1 .*status=aborted/);

  const refused = await execute(fixture.manager, { action: "stop", runId: "done-1" });
  assert.match(refused.text, /result=error runId=done-1 error=cannot stop a completed run allowed=status,read,resume/);
  const unknown = await execute(fixture.manager, { action: "status", runId: "missing" });
  assert.match(unknown.text, /result=error runId=missing error=run not found allowed=list/);
});

test("resume continues a stopped run, reruns a finished one only with an edit, and explains a refusal", async () => {
  const fixture = fakeManager([run("completed", "done-1"), run("running", "live-1"), run("aborted", "stopped-1")]);
  assert.match(
    (await execute(fixture.manager, { action: "resume", runId: "done-1" })).text,
    /error=it already finished; pass edited tasks or script to rerun it, reusing unchanged work allowed=status,read,resume/,
  );
  assert.match(
    (
      await execute(fixture.manager, {
        action: "resume",
        runId: "done-1",
        script: "export const meta = { name: 'edited', description: 'edited' }\nreturn await agent('x')",
      })
    ).text,
    /^action=resume result=resumed runId=done-1 /,
  );
  assert.match(
    (await execute(fixture.manager, { action: "resume", runId: "live-1" })).text,
    /error=it is still running; message it, or stop it first allowed=status,read,message,stop/,
  );
  assert.match(
    (await execute(fixture.manager, { action: "resume", runId: "stopped-1" })).text,
    /^action=resume result=resumed runId=stopped-1 /,
  );
});

test("a manager failure becomes a structured error result", async () => {
  const throwing = run("paused", "throws-1");
  const manager = {
    listRuns: () => [throwing],
    listAllRuns: () => [throwing],
    findRun: () => throwing,
    getSnapshot: () => null,
    stop() {
      throw new Error("disk I/O failed");
    },
  } as unknown as WorkflowManager;
  const response = await execute(manager, { action: "stop", runId: "throws-1" });
  assert.match(response.text, /^action=stop result=error runId=throws-1 error=disk I\/O failed/);
  assert.equal(response.details.error, "disk I/O failed");
});

// ─── Against a real manager ────────────────────────────────────────────────────

function withCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-subagents-control-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "condition not reached in time");
}

test(
  "resume with an edited task list reruns only the edited and new tasks",
  withCwd(async (cwd) => {
    const live: string[] = [];
    let limited = true;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string, options?: AgentRunOptions<TSchema>) {
          live.push(prompt);
          if (limited && prompt === "do b") {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
          }
          return `${options?.label} done`;
        },
      },
    });
    const { runId, promise } = manager.startInBackground(SUBAGENT_TASKS_SCRIPT, [
      { label: "a", task: "do a" },
      { label: "b", task: "do b" },
    ]);
    await promise.catch(() => {});
    limited = false;
    live.length = 0;

    const resumed = await execute(manager, {
      action: "resume",
      runId,
      tasks: [
        { label: "c", task: "do c" },
        { label: "b", task: "do b" },
        { label: "a", task: "do a" },
      ],
    });
    assert.match(resumed.text, /^action=resume result=resumed /);
    assert.match(resumed.text, /Unchanged tasks reuse their results; edited and new tasks run\./);
    await until(() => manager.getRun(runId)?.status === "completed");
    assert.deepEqual(live.sort(), ["do b", "do c"]);
    assert.equal(manager.getRun(runId)?.result?.result, "## c\n\nc done\n\n## b\n\nb done\n\n## a\n\na done");
  }),
);

test(
  "resume with an edited script replays the unchanged prefix",
  withCwd(async (cwd) => {
    const live: string[] = [];
    let failSecond = true;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          live.push(prompt);
          if (failSecond && prompt === "SECOND") {
            throw new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
          }
          return `ran:${prompt}`;
        },
      },
    });
    const script = (second: string) => `export const meta = { name: 'iter', description: 'two' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('${second}', { label: 'second' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(script("SECOND"));
    await promise.catch(() => {});
    failSecond = false;
    live.length = 0;

    const resumed = await execute(manager, { action: "resume", runId, script: script("SECOND-EDITED") });
    assert.match(resumed.text, /Unchanged agent\(\) calls before the first edit reuse their results/);
    await until(() => manager.getRun(runId)?.status === "completed");
    assert.deepEqual(live, ["SECOND-EDITED"]);
    // The persisted copy is plain JSON; the live value comes from the script's VM realm.
    assert.deepEqual(manager.getPersistence().load(runId)?.result, { a: "ran:FIRST", b: "ran:SECOND-EDITED" });
  }),
);

test(
  "resume rejects an edited task list for a script run with a structured error",
  withCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
        },
      },
    });
    const { runId, promise } = manager.startInBackground(
      "export const meta = { name: 'plain', description: 'script run' }\nreturn await agent('x', { label: 'x' })",
    );
    await promise.catch(() => {});
    const response = await execute(manager, { action: "resume", runId, tasks: [{ label: "x", task: "x" }] });
    assert.match(response.text, /result=error .*did not start from a task list; resume it with an edited script/);
  }),
);

test(
  "a checkpoint is answered with checkpointId and response, and the run continues from it",
  withCwd(async (cwd) => {
    const live: string[] = [];
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          live.push(prompt);
          return `planned ${prompt}`;
        },
      },
    });
    const { runId, promise } =
      manager.startInBackground(`export const meta = { name: 'approve', description: 'checkpoint' }
const plan = await agent('plan', { label: 'plan' })
const answer = await checkpoint({ kind: 'approval', checkpointId: 'approve-1', payload: { plan } })
return { plan, answer }`);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    const status = await execute(manager, { action: "status", runId });
    assert.match(status.text, /waiting at checkpoint approve-1 \(approval\): \{"plan":"planned plan"\}/);
    assert.match(
      (await execute(manager, { action: "resume", runId, checkpointId: "wrong-id", response: true })).text,
      /result=error .*stale checkpoint response/,
    );

    const resumed = await execute(manager, {
      action: "resume",
      runId,
      checkpointId: "approve-1",
      response: { approved: true },
    });
    assert.match(resumed.text, /^action=resume result=resumed .*\nIt continues from the answered checkpoint\./);
    await until(() => manager.getRun(runId)?.status === "completed");
    assert.deepEqual(manager.getPersistence().load(runId)?.result, {
      plan: "planned plan",
      answer: { approved: true },
    });
    assert.deepEqual(live, ["plan"], "the planning agent replays instead of running again");
  }),
);

test(
  "message queues text into a running subagent and points at resume once it is not running",
  withCwd(async (cwd) => {
    const steered: string[] = [];
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string, options?: AgentRunOptions<TSchema>) {
          const unregister = options?.registerSteer?.(async (text) => {
            steered.push(text);
          });
          try {
            await released;
            return `${prompt} with ${steered.join(", ")}`;
          } finally {
            unregister?.();
          }
        },
      },
    });
    const { runId, promise } = manager.startInBackground(SUBAGENT_TASKS_SCRIPT, [{ label: "worker", task: "work" }]);
    await until(() => manager.getRun(runId)?.snapshot.agents[0]?.status === "running");

    const queued = await execute(manager, { action: "message", runId, label: "worker", text: "also check tests" });
    assert.match(queued.text, /^action=message result=queued runId=\S+ label="worker" subagents=1\n/);
    assert.match(queued.text, /if the subagent finishes first, the instruction is dropped/);
    const wrongLabel = await execute(manager, { action: "message", runId, label: "nobody", text: "x" });
    assert.match(wrongLabel.text, /result=error .*no running subagent labeled "nobody".*resume/);

    release();
    await promise;
    assert.deepEqual(steered, ["also check tests"]);
    assert.equal(manager.getRun(runId)?.result?.result, "## worker\n\nwork with also check tests");
    const late = await execute(manager, { action: "message", runId, label: "worker", text: "too late" });
    assert.match(late.text, /result=error .*message reaches only running subagents.*allowed=status,read,resume$/);
  }),
);
