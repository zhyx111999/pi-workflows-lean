import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { AgentRunOptions } from "../src/agent.js";
import { BUILTIN_WORKFLOW_NAMES } from "../src/builtin-workflows.js";
import { SUBAGENT_TASKS_SCRIPT } from "../src/subagent-tasks.js";
import {
  createSubagentsTool,
  SUBAGENTS_GATE_GUIDELINE,
  SUBAGENTS_TOOL_NAME,
  startedText,
} from "../src/subagents-tool.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "../src/workflow-saved.js";

const unused = (): never => {
  throw new Error("not used by this test");
};

/** Schema and normalization only: the host is never reached. */
function schemaTool() {
  return createSubagentsTool({ getManager: unused, getStorage: unused, getCwd: unused });
}

function prepare(value: unknown): Record<string, unknown> {
  return (schemaTool().prepareArguments as (value: unknown) => Record<string, unknown>)(value);
}

function properties(): Record<string, Record<string, unknown>> {
  return (schemaTool().parameters as unknown as { properties: Record<string, Record<string, unknown>> }).properties;
}

const script = `export const meta = { name: 'one_agent', description: 'one agent' }
return await agent('do it', { label: 'a' })`;

test("subagents is one background entry point with a short description and a single gate guideline", () => {
  const tool = schemaTool();
  assert.equal(tool.name, SUBAGENTS_TOOL_NAME);
  assert.equal(tool.name, "subagents");
  assert.match(tool.description, /background subagents with exactly one of tasks, script, or name/i);
  assert.match(tool.description, /Returns a runId at once.*Results queue until the main model's full turn ends/i);
  assert.match(tool.promptSnippet ?? "", /background subagents/);
  assert.deepEqual(tool.promptGuidelines, [SUBAGENTS_GATE_GUIDELINE]);
  assert.match(SUBAGENTS_GATE_GUIDELINE, /decided by the hidden note that follows the user message/);
  assert.deepEqual(Object.keys(properties()).sort(), ["args", "name", "script", "tasks"]);
});

test("subagents leaves script details to the skill and run limits to settings", () => {
  const { script: scriptSchema, name } = properties();
  assert.match(String(scriptSchema.description), /Load the workflow-authoring skill/);
  assert.doesNotMatch(String(scriptSchema.description), /export const meta|Date\.now|parallel\(\) requires/);
  assert.match(String(name.description), /workflow-patterns skill/);
  for (const builtin of BUILTIN_WORKFLOW_NAMES) assert.match(String(name.description), new RegExp(builtin));
  const surface = JSON.stringify({ description: schemaTool().description, parameters: schemaTool().parameters });
  for (const removed of ["resumeFromRunId", "maxAgents", "concurrency", "tokenBudget", "timeoutMs", "retries"]) {
    assert.doesNotMatch(surface, new RegExp(removed), `${removed} is not a subagents input`);
  }
  assert.equal(Object.hasOwn(properties(), "background"), false, "every run is a background run");
});

test("subagents declares `args` as an explicitly typed object", () => {
  // Some tool-calling bridges flatten a property with no `type` before the
  // handler sees it, which would drop every named workflow's required args.
  assert.equal(properties().args.type, "object");
});

test("subagents tasks require a label and a task per item", () => {
  const tasks = properties().tasks as { items: { required?: string[]; properties: Record<string, unknown> } };
  assert.deepEqual(tasks.items.required, ["label", "task"]);
  assert.deepEqual(Object.keys(tasks.items.properties), ["label", "task", "model"]);
});

test("prepareArguments keeps exactly one start mode and drops what does not apply", () => {
  assert.deepEqual(prepare({ tasks: [{ label: " a ", task: "do a" }], args: { ignored: true } }), {
    tasks: [{ label: "a", task: "do a" }],
  });
  assert.deepEqual(prepare({ script: "```js\nconst x = 1\n```" }), { script: "const x = 1" });
  assert.deepEqual(prepare({ script, args: { question: "q" } }), { script, args: { question: "q" } });
  assert.deepEqual(prepare({ name: " deep-research ", args: { question: "q" } }), {
    name: "deep-research",
    args: { question: "q" },
  });
  // Providers that fill every optional field send null or empty values for the unused ones.
  const filled = prepare({ tasks: [{ label: "a", task: "do a" }], script: "", name: null, args: null });
  assert.deepEqual(filled, { tasks: [{ label: "a", task: "do a" }] });
  assert.equal(Check(schemaTool().parameters, filled), true);
  assert.deepEqual(prepare({ tasks: [], script, name: "", args: null }), { script });
});

test("prepareArguments rejects unknown fields, missing or ambiguous modes, and malformed values", () => {
  assert.throws(() => prepare("not-an-object"), /object argument/);
  assert.throws(() => prepare({}), /exactly one of tasks, script, or name/);
  assert.throws(() => prepare({ script, name: "deep-research" }), /exactly one of tasks, script, or name/);
  assert.throws(() => prepare({ tasks: [{ label: "a", task: "x" }], script }), /exactly one/);
  for (const removed of ["background", "resumeFromRunId", "maxAgents", "tokenBudget"]) {
    assert.throws(() => prepare({ script, [removed]: 1 }), new RegExp(`does not accept ${removed}`));
  }
  assert.throws(() => prepare({ script: 123 }), /script must be a string/);
  assert.throws(() => prepare({ name: "deep-research", args: "q" }), /args must be a JSON object/);
  assert.throws(() => prepare({ tasks: [{ label: "a" }] }), /tasks\[0\]\.task/);
  assert.throws(
    () =>
      prepare({
        tasks: [
          { label: "a", task: "x" },
          { label: "a", task: "y" },
        ],
      }),
    /used more than once/,
  );
});

test("startedText names the run, says where the result goes, and points at subagents_control", () => {
  const text = startedText("subagents-abc", "2 subagents");
  assert.match(text, /Started 2 subagents in the background as run subagents-abc/);
  assert.match(text, /delivered to this conversation automatically/);
  assert.match(text, /queues until the current response and tools finish, then enters immediately/);
  assert.match(text, /wait or keep working/);
  assert.match(text, /subagents_control/);
});

function withHost(fn: (cwd: string, storage: WorkflowStorage) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-subagents-tool-"));
    try {
      await fn(cwd, createWorkflowStorage(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

function hostTool(manager: WorkflowManager, cwd: string, storage: WorkflowStorage) {
  return createSubagentsTool({ getManager: () => manager, getStorage: () => storage, getCwd: () => cwd });
}

async function run(tool: ReturnType<typeof hostTool>, params: Record<string, unknown>) {
  const prepared = (tool.prepareArguments as (value: unknown) => Record<string, unknown>)(params);
  const result = await (tool.execute as any)("call", prepared, undefined, undefined, undefined);
  return { text: result.content[0].text as string, runId: (result.details as { runId: string }).runId };
}

async function finished(manager: WorkflowManager, runId: string): Promise<void> {
  for (let i = 0; i < 400 && manager.getRun(runId)?.status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const echoAgent = {
  async run(prompt: string, options?: AgentRunOptions<TSchema>) {
    return `${options?.label}:${prompt}`;
  },
};

test(
  "tasks start one background run with a labeled subagent per task",
  withHost(async (cwd, storage) => {
    const manager = new WorkflowManager({ cwd, agent: echoAgent });
    const tool = hostTool(manager, cwd, storage);
    const { text, runId } = await run(tool, {
      tasks: [
        { label: "api", task: "Review the API" },
        { label: "ui", task: "Review the UI", model: "p/m" },
      ],
    });

    assert.match(text, new RegExp(`Started 2 subagents in the background as run ${runId}`));
    const managed = manager.getRun(runId);
    assert.equal(managed?.script, SUBAGENT_TASKS_SCRIPT);
    assert.deepEqual(managed?.args, [
      { label: "api", task: "Review the API" },
      { label: "ui", task: "Review the UI", model: "p/m" },
    ]);
    await finished(manager, runId);
    assert.equal(manager.getRun(runId)?.result?.result, "## api\n\napi:Review the API\n\n## ui\n\nui:Review the UI");
  }),
);

test(
  "a script starts a background run named by its meta",
  withHost(async (cwd, storage) => {
    const manager = new WorkflowManager({ cwd, agent: echoAgent });
    const { text, runId } = await run(hostTool(manager, cwd, storage), { script, args: { n: 1 } });
    assert.match(text, /Started workflow "one_agent" in the background/);
    assert.deepEqual(manager.getRun(runId)?.args, { n: 1 });
  }),
);

test(
  "a malformed script is rejected without creating a run",
  withHost(async (cwd, storage) => {
    const manager = new WorkflowManager({ cwd, agent: echoAgent });
    await assert.rejects(run(hostTool(manager, cwd, storage), { script: "return 1" }), /export const meta/);
    assert.equal(manager.listRuns().length, 0);
  }),
);

test(
  "name runs every built-in pattern, carrying deep-research's web tools",
  withHost(async (cwd, storage) => {
    const manager = new WorkflowManager({ cwd, agent: echoAgent });
    manager.on("error", () => {});
    const tool = hostTool(manager, cwd, storage);
    for (const name of BUILTIN_WORKFLOW_NAMES) {
      const { runId, text } = await run(tool, { name, args: { question: "what is pi?" } });
      assert.match(text, new RegExp(`Started workflow "${name}"`));
      assert.ok(manager.getRun(runId), `${name} should be tracked by the manager`);
    }
    const { runId } = await run(tool, { name: "deep-research", args: { question: "what is pi?" } });
    assert.equal(manager.getRun(runId)?.toolset, "web-research");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }),
);

test(
  "a saved workflow wins over a built-in of the same name",
  withHost(async (cwd, storage) => {
    storage.save({
      name: "deep-research",
      description: "custom override",
      script: "export const meta = { name: 'custom_deep_research', description: 'override' }\nreturn 1",
    });
    const manager = new WorkflowManager({ cwd, agent: echoAgent });
    const { runId } = await run(hostTool(manager, cwd, storage), {
      name: "deep-research",
      args: { question: "irrelevant" },
    });
    assert.equal(manager.getRun(runId)?.snapshot.name, "custom_deep_research");
    assert.equal(manager.getRun(runId)?.toolset, undefined);
  }),
);

test(
  "an unknown name or invalid built-in args fail with a clear error",
  withHost(async (cwd, storage) => {
    const manager = new WorkflowManager({ cwd, agent: echoAgent });
    const tool = hostTool(manager, cwd, storage);
    await assert.rejects(run(tool, { name: "not-a-real-workflow" }), /no saved or built-in workflow named/);
    await assert.rejects(run(tool, { name: "deep-research", args: {} }), /question/);
    assert.equal(manager.listRuns().length, 0);
  }),
);
