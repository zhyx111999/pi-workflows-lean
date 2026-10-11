import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkflowCheckpointSuspensionError, WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { runWorkflow } from "../src/workflow.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHILD = fileURLToPath(new URL("./helpers/unawaited-run-child.ts", import.meta.url));
const ISOLATED_HOME = pathToFileURL(fileURLToPath(new URL("./helpers/isolated-home.ts", import.meta.url))).href;

const workflow = (body: string) => `export const meta = { name: 'unawaited', description: 'un-awaited call' }\n${body}`;

interface ChildRunState {
  status?: string;
  error?: string;
  checkpoint?: { id: string; status: string };
}

/**
 * Run a workflow in a fresh process with Node's default rejection handling, as
 * Pi has: there an unhandled rejection ends the process with exit code 1.
 */
function spawnChild(body: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "--import", ISOLATED_HOME, CHILD], {
    cwd: ROOT,
    env: { ...process.env, UNAWAITED_RUN_SCRIPT: workflow(body), ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
  });
}

function runInChildProcess(body: string): ChildRunState {
  const child = spawnChild(body);
  assert.equal(child.status, 0, `the process must survive the un-awaited call:\n${child.stderr}`);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "") as ChildRunState;
}

const fatalAgent = {
  async run(prompt: string) {
    if (prompt === "fatal") {
      throw new WorkflowError("fatal agent failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
    }
    return `ran:${prompt}`;
  },
};

test("an un-awaited checkpoint() keeps the process alive and pauses the run at the checkpoint", () => {
  const state = runInChildProcess(`checkpoint({ kind: 'approval', checkpointId: 'gate', payload: {} })
return 'must not complete'`);
  assert.equal(state.status, "paused");
  assert.deepEqual(state.checkpoint, { id: "gate", status: "waiting" });
});

test("an un-awaited parallel() with a nonrecoverable branch failure keeps the process alive and fails the run", () => {
  const state = runInChildProcess(`parallel([() => agent('fatal'), () => agent('sibling')])
return 'must not complete'`);
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /fatal agent failure/);
});

test("an un-awaited pipeline() with a nonrecoverable stage failure keeps the process alive and fails the run", () => {
  const state = runInChildProcess(`pipeline(['item'], () => agent('fatal'), (value) => agent('after ' + value))
return 'must not complete'`);
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /fatal agent failure/);
});

test("a promise the script rejects and never handles keeps the process alive and fails the run", () => {
  const state = runInChildProcess(`Promise.reject(new Error('bare script rejection'))
return 'must not complete'`);
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /bare script rejection/);
});

test("an async function the script never awaits keeps the process alive when it throws, and fails the run", () => {
  const state = runInChildProcess(`;(async () => { await agent('first'); throw new Error('async helper broke') })()
return 'must not complete'`);
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /async helper broke/);
});

test("a script that handles its own rejection later still completes", () => {
  const state = runInChildProcess(`const late = Promise.reject(new Error('handled later'))
await agent('between')
await late.catch(() => {})
return 'done'`);
  assert.equal(state.status, "completed");
});

test("a rejection outside any workflow still ends the process, as Node does by default", () => {
  const child = spawnChild("return 'done'", { UNAWAITED_FOREIGN_REJECTION: "1" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /a rejection outside any workflow/);
});

test("an un-awaited agent() with a nonrecoverable failure fails the run with that error", async () => {
  const logs: string[] = [];
  await assert.rejects(
    runWorkflow(workflow("agent('fatal')\nreturn 'must not complete'"), {
      agent: fatalAgent,
      persistLogs: false,
      onLog: (message) => logs.push(message),
    }),
    (error: unknown) => error instanceof WorkflowError && error.message === "fatal agent failure",
  );
  assert.ok(logs.some((line) => line.includes("agent() failed and the script never awaited it: fatal agent failure")));
});

test("a promise chained on an un-awaited call but never handled still fails the run", async () => {
  await assert.rejects(
    runWorkflow(workflow("agent('fatal').then((value) => log(value))\nreturn 'must not complete'"), {
      agent: fatalAgent,
      persistLogs: false,
    }),
    /fatal agent failure/,
  );
});

test("an un-awaited checkpoint inside parallel() pauses the run like an awaited one", async () => {
  await assert.rejects(
    runWorkflow(
      workflow(`parallel([() => checkpoint({ kind: 'approval', checkpointId: 'gate', payload: {} })])
return 'must not complete'`),
      { agent: fatalAgent, persistLogs: false, onWorkflowCheckpoint: () => {} },
    ),
    WorkflowCheckpointSuspensionError,
  );
});

test("a failure the script handles after starting other work does not fail the run", async () => {
  const result = await runWorkflow<string>(
    workflow(`const early = agent('fatal')
const other = await agent('other')
try { await early } catch (e) { return other + ' / handled: ' + e.message }
return 'unreachable'`),
    { agent: fatalAgent, persistLogs: false },
  );
  assert.equal(result.result, "ran:other / handled: fatal agent failure");
});

test("an un-awaited call's recoverable failure is logged and the run still completes", async () => {
  const logs: string[] = [];
  const result = await runWorkflow<string>(
    workflow(`parallel('not an array')
return await agent('main')`),
    { agent: fatalAgent, persistLogs: false, onLog: (message) => logs.push(message) },
  );
  assert.equal(result.result, "ran:main");
  assert.ok(logs.some((line) => line.includes("parallel() failed and the script never awaited it")));
});
