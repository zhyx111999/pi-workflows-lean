import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunOptions } from "../src/agent.js";
import { WorkflowManager } from "../src/workflow-manager.js";

/**
 * Fake runner that registers every session like WorkflowAgent does. The
 * "worker" call stays mid-session until released; steered text is recorded.
 */
function steerableAgent() {
  const steered: string[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    steered,
    release: () => release(),
    runner: {
      async run(prompt: string, options?: AgentRunOptions<undefined>) {
        const unregister = options?.registerSteer?.(async (text) => {
          steered.push(text);
        });
        try {
          if (options?.label === "worker") await released;
          return `${prompt}: ${steered.join(" | ") || "-"}`;
        } finally {
          unregister?.();
        }
      },
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "condition not reached in time");
}

const script = `export const meta = { name: 'steer', description: 'steer a running agent' }
const [worker, quick] = await parallel([
  () => agent('work', { label: 'worker' }),
  () => agent('quick', { label: 'quick' }),
])
return { worker, quick }`;

test("steerAgent reaches only a running agent with that label, and nothing once it ends", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-steer-run-"));
  try {
    const fake = steerableAgent();
    const manager = new WorkflowManager({ cwd, agent: fake.runner });
    const { runId, promise } = manager.startInBackground(script);
    const agents = () => manager.getRun(runId)?.snapshot.agents ?? [];
    await until(() => agents().some((agent) => agent.label === "quick" && agent.status === "done"));
    await until(() => agents().some((agent) => agent.label === "worker" && agent.status === "running"));

    assert.equal(await manager.steerAgent(runId, "quick", "too late"), 0, "a finished agent is unregistered");
    assert.equal(await manager.steerAgent(runId, "missing", "nobody"), 0);
    assert.equal(await manager.steerAgent("no-such-run", "worker", "nobody"), 0);
    assert.equal(await manager.steerAgent(runId, "worker", "focus on edge cases"), 1);

    fake.release();
    const result = (await promise).result as { worker: string; quick: string };
    assert.deepEqual(fake.steered, ["focus on edge cases"]);
    assert.equal(result.worker, "work: focus on edge cases");
    assert.equal(await manager.steerAgent(runId, "worker", "after the run"), 0, "a finished run has no sessions");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("steerAgent sends to every running agent that shares the label", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-steer-shared-"));
  try {
    const fake = steerableAgent();
    const manager = new WorkflowManager({ cwd, agent: fake.runner });
    const shared = `export const meta = { name: 'steer_shared', description: 'two agents, one label' }
return await parallel([1, 2].map((n) => () => agent('part ' + n, { label: 'worker' })))`;
    const { runId, promise } = manager.startInBackground(shared);
    await until(
      () => (manager.getRun(runId)?.snapshot.agents ?? []).filter((agent) => agent.status === "running").length === 2,
    );

    assert.equal(await manager.steerAgent(runId, "worker", "both"), 2);
    fake.release();
    await promise;
    assert.deepEqual(fake.steered, ["both", "both"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
