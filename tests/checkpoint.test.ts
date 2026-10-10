import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowCheckpointSuspensionError } from "../src/errors.js";
import type { JournalEntry, WorkflowCheckpoint } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

for (const [name, body] of [
  ["parallel", "await parallel([() => checkpoint(input)])"],
  ["pipeline", "await pipeline([1], () => checkpoint(input))"],
  ["caught", "try { await checkpoint(input) } catch {}"],
  [
    "caught before another agent",
    "try { await checkpoint(input) } catch {} await agent('must not run', {label:'after'})",
  ],
] as const) {
  test(`durable suspension survives ${name} without completing or starting more agents`, async () => {
    let calls = 0;
    const script = `export const meta = { name: 'suspension', description: 'durable pause propagation' }
const input = { kind: 'approval', checkpointId: 'gate', payload: {} };
${body}; return 'must not complete';`;
    await assert.rejects(
      () =>
        runWorkflow(script, {
          agent: {
            run: async () => {
              calls++;
              return "unexpected";
            },
          },
          persistLogs: false,
          onWorkflowCheckpoint: () => {},
        }),
      WorkflowCheckpointSuspensionError,
    );
    assert.equal(calls, 0);
  });
}

test("checkpoint(): counts against maxAgents (no tokens, but bounded)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await agent('a', { label: 'a' })
await agent('b', { label: 'b' })
await checkpoint({ kind: 'approval', checkpointId: 'gate', payload: {} })
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false, maxAgents: 2 }), /limit/i);
});

test("checkpoint(): rejects the removed prompt-string form before reserving a slot", async () => {
  let checkpoints = 0;
  const script = `export const meta = { name: 'prompt_checkpoint', description: 'prompt form' }
let error = ''
try { await checkpoint('Approve plan?', { default: true }) } catch (e) { error = String(e && e.message) }
return { error, after: await agent('after', { label: 'after' }) }`;
  const result = await runWorkflow<{ error: string; after: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    maxAgents: 1,
    onWorkflowCheckpoint: () => checkpoints++,
  });
  assert.match(result.result.error, /exactly \{ kind, checkpointId, payload \}/);
  assert.equal(result.result.after, "ok", "the rejected call consumed no agent slot");
  assert.equal(checkpoints, 0);
});

test("checkpoint(): durable object suspends, then replays its persisted response", async () => {
  const script = `export const meta = { name: 'durable', description: 'durable checkpoint' }
const publication = await checkpoint({ kind: 'proposal-ready', checkpointId: 'proposal-1', payload: { digest: 'abc' } })
return { publication }`;
  const updates: WorkflowCheckpoint[] = [];

  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "durable-checkpoint-run",
        onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
      }),
    (error) => error instanceof WorkflowCheckpointSuspensionError,
  );
  assert.deepEqual(updates, [
    {
      version: 1,
      checkpointId: "proposal-1",
      kind: "proposal-ready",
      status: "waiting",
      payload: { digest: "abc" },
      createdAt: updates[0]?.createdAt,
    },
  ]);

  const journal = new Map<number, JournalEntry>();
  const resumed = await runWorkflow<{ publication: unknown }>(script, {
    agent: noopAgent,
    persistLogs: false,
    runId: "durable-checkpoint-run",
    resumeCheckpoint: {
      ...updates[0],
      status: "resuming",
      response: { head: "def" },
    },
    onAgentJournal: (entry) => journal.set(entry.index, entry),
    onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
  });

  assert.deepEqual(resumed.result.publication, { head: "def" });
  assert.deepEqual(updates[1], {
    ...updates[0],
    status: "consumed",
    response: { head: "def" },
    consumedAt: updates[1]?.consumedAt,
  });
  assert.equal(journal.size, 1, "the resumed response is journaled before execution continues");
});

test("checkpoint(): durable payload rejects lossy non-JSON values", async () => {
  const scripts = [
    `export const meta = { name: 'nan', description: 'nan payload' }
await checkpoint({ kind: 'proposal-ready', checkpointId: 'nan', payload: { approved: NaN } })`,
    `export const meta = { name: 'undefined', description: 'undefined payload' }
await checkpoint({ kind: 'proposal-ready', checkpointId: 'undefined', payload: { approved: undefined } })`,
    `export const meta = { name: 'accessor', description: 'accessor payload' }
const values = []
Object.defineProperty(values, '0', { enumerable: true, get() { return true } })
values.length = 1
await checkpoint({ kind: 'proposal-ready', checkpointId: 'accessor', payload: { values } })`,
  ];
  for (const script of scripts) {
    await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false }), /lossless JSON value/);
  }
});

test("checkpoint(): durable object accepts an open checkpoint kind", async () => {
  const script = `export const meta = { name: 'kind', description: 'custom kind' }
await checkpoint({ kind: 'custom-controller-event', checkpointId: 'custom', payload: {} })`;
  await assert.rejects(
    () => runWorkflow(script, { agent: noopAgent, persistLogs: false }),
    WorkflowCheckpointSuspensionError,
  );
});

test("checkpoint(): concurrent distinct checkpoints expose only one active checkpoint", async () => {
  const script = `export const meta = { name: 'concurrent', description: 'concurrent checkpoints' }
const values = await Promise.all([
  checkpoint({ kind: 'proposal-ready', checkpointId: 'first', payload: { order: 1 } }),
  checkpoint({ kind: 'waiting-for-gitlab', checkpointId: 'second', payload: { order: 2 } }),
])
return values`;
  const updates: WorkflowCheckpoint[] = [];
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "concurrent-checkpoint-run",
        onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
      }),
    WorkflowCheckpointSuspensionError,
  );
  assert.deepEqual(
    updates.map(({ checkpointId, status }) => ({ checkpointId, status })),
    [{ checkpointId: "first", status: "waiting" }],
  );

  const first = updates[0];
  assert.ok(first);
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "concurrent-checkpoint-run",
        resumeCheckpoint: { ...first, status: "resuming", response: { accepted: true } },
        onWorkflowCheckpoint: (checkpoint) => updates.push(checkpoint),
      }),
    WorkflowCheckpointSuspensionError,
  );
  assert.deepEqual(
    updates.slice(1).map(({ checkpointId, status }) => ({ checkpointId, status })),
    [
      { checkpointId: "first", status: "consumed" },
      { checkpointId: "second", status: "waiting" },
    ],
  );
});

test("checkpoint(): durable checkpoint IDs cannot be reused within one run", async () => {
  const script = `export const meta = { name: 'duplicate', description: 'duplicate durable checkpoint' }
await checkpoint({ kind: 'proposal-ready', checkpointId: 'same-id', payload: { cycle: 1 } })
await checkpoint({ kind: 'waiting-for-gitlab', checkpointId: 'same-id', payload: { cycle: 2 } })
return 'unreachable'`;
  let waiting: WorkflowCheckpoint | undefined;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "duplicate-checkpoint-run",
        onWorkflowCheckpoint: (checkpoint) => {
          waiting = checkpoint;
        },
      }),
    WorkflowCheckpointSuspensionError,
  );
  assert.ok(waiting);

  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: noopAgent,
        persistLogs: false,
        runId: "duplicate-checkpoint-run",
        resumeCheckpoint: { ...waiting, status: "resuming", response: {} },
      }),
    /must be unique within the run/,
  );
});

// ─── Checkpoint resume-identity hash coverage ─────────────────────────────────
