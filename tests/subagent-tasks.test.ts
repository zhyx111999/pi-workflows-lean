import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunOptions } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  isTaskListScript,
  parseSubagentTasks,
  SUBAGENT_TASKS_SCRIPT,
  type SubagentTask,
  unchangedTaskMoves,
} from "../src/subagent-tasks.js";
import { WorkflowManager } from "../src/workflow-manager.js";

test("parseSubagentTasks accepts { label, task, model? } with unique labels", () => {
  assert.deepEqual(
    parseSubagentTasks([
      { label: " a ", task: "do a" },
      { label: "b", task: "do b", model: " p/m:high " },
      { label: "c", task: "do c", model: null },
    ]),
    [
      { label: "a", task: "do a" },
      { label: "b", task: "do b", model: "p/m:high" },
      { label: "c", task: "do c" },
    ],
  );

  assert.throws(() => parseSubagentTasks(undefined), /non-empty array/);
  assert.throws(() => parseSubagentTasks([]), /non-empty array/);
  assert.throws(() => parseSubagentTasks(["do a"]), /tasks\[0\] must be an object/);
  assert.throws(() => parseSubagentTasks([{ task: "do a" }]), /tasks\[0\]\.label/);
  assert.throws(() => parseSubagentTasks([{ label: "a", task: "  " }]), /tasks\[0\]\.task/);
  assert.throws(() => parseSubagentTasks([{ label: "a", task: "x", model: "" }]), /tasks\[0\]\.model/);
  assert.throws(() => parseSubagentTasks([{ label: "a", task: "x", tier: "big" }]), /tasks\[0\] does not accept tier/);
  assert.throws(
    () =>
      parseSubagentTasks([
        { label: "a", task: "x" },
        { label: "a ", task: "y" },
      ]),
    /label "a" is used more than once/,
  );
});

test("unchangedTaskMoves maps every task whose label, task, and model all match, wherever it moved", () => {
  const previous: SubagentTask[] = [
    { label: "a", task: "do a" },
    { label: "b", task: "do b" },
    { label: "c", task: "do c", model: "p/m" },
    { label: "gone", task: "dropped" },
  ];
  const next: SubagentTask[] = [
    { label: "c", task: "do c", model: "p/m" },
    { label: "b", task: "do b, better" },
    { label: "a", task: "do a" },
    { label: "new", task: "added" },
  ];
  assert.deepEqual(
    [...unchangedTaskMoves(previous, next)],
    [
      [0, 2],
      [2, 0],
    ],
  );
  assert.equal(unchangedTaskMoves([{ label: "a", task: "x" }], [{ label: "a", task: "x", model: "p/m" }]).size, 0);
  assert.equal(unchangedTaskMoves([{ label: "a", task: "x" }], [{ label: "renamed", task: "x" }]).size, 0);
});

/** Records live prompts; `fail` makes one task throw a provider limit after its siblings settle. */
function taskAgent(fail?: { prompt: string }) {
  const live: string[] = [];
  const runner = {
    async run(prompt: string, options?: AgentRunOptions<undefined>) {
      live.push(prompt);
      if (fail && prompt === fail.prompt) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
      }
      return `${options?.label}:${options?.model ?? "default"}:${prompt}`;
    },
  };
  return { live, runner };
}

async function settled(manager: WorkflowManager, runId: string): Promise<void> {
  for (let i = 0; i < 400 && manager.getRun(runId)?.status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function withTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tasks-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

test(
  "a task list runs one labeled subagent per task and returns one report in task order",
  withTempCwd(async (cwd) => {
    const fake = taskAgent();
    const manager = new WorkflowManager({ cwd, agent: fake.runner });
    const tasks: SubagentTask[] = [
      { label: "dates", task: "Replace Date.now() and Math.random() in src/" },
      { label: "docs", task: "Update the docs", model: "p/m" },
    ];
    assert.ok(isTaskListScript(SUBAGENT_TASKS_SCRIPT));

    const { runId, promise } = manager.startInBackground(SUBAGENT_TASKS_SCRIPT, tasks);
    const result = await promise;

    assert.match(runId, /^subagents-/);
    assert.equal(
      result.result,
      "## dates\n\ndates:default:Replace Date.now() and Math.random() in src/\n\n## docs\n\ndocs:p/m:Update the docs",
    );
    assert.deepEqual(
      manager.getRun(runId)?.snapshot.agents.map(({ label, status }) => ({ label, status })),
      [
        { label: "dates", status: "done" },
        { label: "docs", status: "done" },
      ],
    );
  }),
);

test(
  "a plain resume of a task list reruns only tasks without a result, even after an earlier miss",
  withTempCwd(async (cwd) => {
    const fake = taskAgent({ prompt: "do b" });
    const manager = new WorkflowManager({ cwd, agent: fake.runner });
    const tasks: SubagentTask[] = [
      { label: "a", task: "do a" },
      { label: "b", task: "do b" },
      { label: "c", task: "do c" },
    ];
    const { runId, promise } = manager.startInBackground(SUBAGENT_TASKS_SCRIPT, tasks);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    const resumedFake = taskAgent();
    const resumer = new WorkflowManager({ cwd, agent: resumedFake.runner });
    assert.equal(await resumer.resume(runId), true);
    await settled(resumer, runId);

    assert.deepEqual(resumedFake.live, ["do b"], "c follows the missing b but still replays");
    assert.equal(resumer.getPersistence().load(runId)?.status, "completed");
  }),
);

test(
  "resume with an edited task list reuses unchanged tasks wherever they moved and runs only edited or new ones",
  withTempCwd(async (cwd) => {
    const fake = taskAgent({ prompt: "do b" });
    const manager = new WorkflowManager({ cwd, agent: fake.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(SUBAGENT_TASKS_SCRIPT, [
      { label: "a", task: "do a" },
      { label: "b", task: "do b" },
      { label: "c", task: "do c" },
    ]);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");
    const liveBefore = fake.live.length;

    const edited: SubagentTask[] = [
      { label: "c", task: "do c" },
      { label: "b", task: "do b, smaller" },
      { label: "a", task: "do a" },
      { label: "d", task: "do d" },
    ];
    assert.equal(await manager.resume(runId, { tasks: edited }), true);
    await settled(manager, runId);

    assert.deepEqual(fake.live.slice(liveBefore), ["do b, smaller", "do d"]);
    const record = manager.getPersistence().load(runId);
    assert.equal(record?.status, "completed");
    assert.deepEqual(record?.args, edited, "the edited list becomes the run's task list");
    assert.equal(
      record?.result,
      [
        "## c\n\nc:default:do c",
        "## b\n\nb:default:do b, smaller",
        "## a\n\na:default:do a",
        "## d\n\nd:default:do d",
      ].join("\n\n"),
    );
    // Reused rows moved with their task; the edited task's old row stays as history without a call id.
    const rows = (record?.agents ?? []).map(({ label, prompt, callId }) => ({ label, prompt, callId }));
    assert.deepEqual(
      rows.filter((row) => row.callId !== undefined).sort((x, y) => (x.callId < y.callId ? -1 : 1)),
      [
        { label: "c", prompt: "do c", callId: `${runId}:0` },
        { label: "b", prompt: "do b, smaller", callId: `${runId}:1` },
        { label: "a", prompt: "do a", callId: `${runId}:2` },
        { label: "d", prompt: "do d", callId: `${runId}:3` },
      ],
    );
    assert.deepEqual(
      rows.filter((row) => row.callId === undefined),
      [{ label: "b", prompt: "do b", callId: undefined }],
    );
  }),
);

test(
  "a finished task list reruns with an edited list, reusing every unchanged task, even from another process",
  withTempCwd(async (cwd) => {
    const fake = taskAgent();
    const manager = new WorkflowManager({ cwd, agent: fake.runner });
    const { runId, promise } = manager.startInBackground(SUBAGENT_TASKS_SCRIPT, [
      { label: "a", task: "do a" },
      { label: "b", task: "do b" },
    ]);
    await promise;
    assert.equal(manager.getPersistence().load(runId)?.status, "completed");
    assert.equal(await manager.resume(runId), false, "a finished run has nothing to continue without an edit");

    // A fresh manager reads only the persisted record, as after a Pi restart.
    const rerunFake = taskAgent();
    const rerunner = new WorkflowManager({ cwd, agent: rerunFake.runner });
    const edited: SubagentTask[] = [
      { label: "a", task: "do a" },
      { label: "b", task: "do b again" },
    ];
    assert.equal(await rerunner.resume(runId, { tasks: edited }), true);
    await settled(rerunner, runId);

    assert.deepEqual(rerunFake.live, ["do b again"], "only the edited task runs");
    const record = rerunner.getPersistence().load(runId);
    assert.equal(record?.status, "completed");
    assert.equal(record?.result, "## a\n\na:default:do a\n\n## b\n\nb:default:do b again");
  }),
);

test(
  "resume rejects a task list for a script run and a task list combined with a script",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false });
        },
      },
    });
    const script = `export const meta = { name: 'plain', description: 'script run' }
return await agent('x', { label: 'x' })`;
    const scripted = manager.startInBackground(script);
    await scripted.promise.catch(() => {});
    const tasked = manager.startInBackground(SUBAGENT_TASKS_SCRIPT, [{ label: "a", task: "do a" }]);
    await tasked.promise.catch(() => {});

    await assert.rejects(
      manager.resume(scripted.runId, { tasks: [{ label: "x", task: "x" }] }),
      /did not start from a task list; resume it with an edited script/,
    );
    await assert.rejects(manager.resume(tasked.runId, { tasks: [{ label: "a", task: "do a" }], script }), /not both/);
    await assert.rejects(manager.resume(tasked.runId, { tasks: [] }), /non-empty array/);
    assert.equal(manager.getPersistence().load(tasked.runId)?.status, "paused", "a rejected resume changes nothing");
  }),
);
