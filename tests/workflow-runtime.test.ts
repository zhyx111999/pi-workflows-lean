import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunOptions } from "../src/agent.js";
import type { AgentDefinition } from "../src/agent-registry.js";
import type { AgentUsage } from "../src/agent-usage.js";
import { WorkflowCheckpointSuspensionError, WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { CallSequence } from "../src/runtime/call-position.js";
import { createParallel, createPipeline } from "../src/runtime/fanout.js";
import type { RunContext } from "../src/runtime/run-context.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { WORKFLOW_CAPABILITY_CONTRACT } from "../src/workflow-capability-contract.js";

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("agent cwd is normalized before dispatch and invalid cwd does not reserve capacity", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-cwd-"));
  const linked = join(root, "linked");
  symlinkSync(root, linked);
  const seen: string[] = [];
  const runner = {
    async run(_prompt: string, options: AgentRunOptions) {
      seen.push(options.cwd ?? "");
      return "ok";
    },
  };
  try {
    const script = `export const meta = { name: 'cwd', description: 'cwd validation' }
return await agent('inspect', { cwd: ${JSON.stringify(linked)} })`;
    await runWorkflow(script, { agent: runner, persistLogs: false });
    assert.deepEqual(seen, [realpathSync(root)], "runner receives the canonical realpath");

    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'bad_cwd', description: 'bad cwd' }
await agent('never runs', { cwd: 'relative-path' })`,
          { agent: runner, persistLogs: false, maxAgents: 0 },
        ),
      /cwd must be an absolute directory/,
      "cwd validation precedes capacity reservation",
    );
    assert.equal(seen.length, 1, "invalid cwd never dispatches an agent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("script agent cwd preserves a directory's significant trailing space", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-cwd-space-"));
  const target = join(root, "directory ");
  mkdirSync(join(root, "directory"));
  mkdirSync(target);
  try {
    let seen: string | undefined;
    await runWorkflow(
      `export const meta = { name: 'cwd_space', description: 'literal directory binding' }
return await agent('inspect', { cwd: ${JSON.stringify(target)} })`,
      {
        agent: {
          async run(_prompt, options) {
            seen = options?.cwd;
            return "ok";
          },
        },
        persistLogs: false,
      },
    );
    assert.equal(seen, realpathSync(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit cwd can opt out of agent-type isolation without claiming worktree ownership", async () => {
  const target = mkdtempSync(join(tmpdir(), "pi-agent-cwd-optout-"));
  const registry = new Map([
    [
      "isolated",
      {
        name: "isolated",
        prompt: "inspect",
        isolation: "worktree",
        source: "project",
      } as AgentDefinition,
    ],
  ]);
  const script = `export const meta = { name: 'cwd_optout', description: 'existing directory ownership' }
return await agent('inspect', { cwd: ${JSON.stringify(target)}, agentType: 'isolated', isolation: false })`;
  try {
    for (const fail of [false, true]) {
      const ended: Array<string | undefined> = [];
      const run = runWorkflow(script, {
        persistLogs: false,
        agentRegistry: registry,
        agent: {
          async run(_prompt, options) {
            assert.equal(options?.cwd, realpathSync(target));
            if (fail)
              throw new WorkflowError("test failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
            return "ok";
          },
        },
        onAgentEnd: (event) => ended.push(event.worktree),
      });
      if (fail) await assert.rejects(run, /test failure/);
      else await run;
      assert.deepEqual(ended, [undefined], "an existing directory is not an owned worktree");
      assert.ok(existsSync(target));
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("agent cwd cannot be combined with worktree isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-cwd-isolation-"));
  try {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'cwd_isolation', description: 'cwd and isolation' }
await agent('never runs', { cwd: ${JSON.stringify(root)}, isolation: 'worktree' })`,
          { agent: countingAgent().runner, persistLogs: false },
        ),
      /cwd cannot be combined with worktree isolation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent cwd participates in resume identity while omitted cwd preserves cache replay", async () => {
  const firstDir = mkdtempSync(join(tmpdir(), "pi-agent-cwd-first-"));
  const secondDir = mkdtempSync(join(tmpdir(), "pi-agent-cwd-second-"));
  const calls: string[] = [];
  const journal = new Map<number, JournalEntry>();
  const runner = {
    async run(_prompt: string, options: AgentRunOptions) {
      calls.push(options.cwd ?? "default");
      return `ran:${options.cwd ?? "default"}`;
    },
  };
  const script = (cwd?: string) => `export const meta = { name: 'cwd_resume', description: 'cwd resume identity' }
return await agent('inspect', { label: 'inspect'${cwd ? `, cwd: ${JSON.stringify(cwd)}` : ""} })`;
  try {
    await runWorkflow(script(), {
      agent: runner,
      persistLogs: false,
      runId: "cwd-resume",
      onAgentJournal: (entry) => journal.set(entry.index, entry),
    });
    await runWorkflow(script(), {
      agent: runner,
      persistLogs: false,
      runId: "cwd-resume",
      resumeJournal: journal,
    });
    assert.deepEqual(calls, ["default"], "omitted cwd retains the existing resume hash");

    await runWorkflow(script(firstDir), {
      agent: runner,
      persistLogs: false,
      runId: "cwd-resume",
      resumeJournal: journal,
    });
    await runWorkflow(script(secondDir), {
      agent: runner,
      persistLogs: false,
      runId: "cwd-resume",
      resumeJournal: journal,
    });
    assert.deepEqual(
      calls,
      ["default", realpathSync(firstDir), realpathSync(secondDir)],
      "each canonical cwd invalidates the prior journal entry",
    );
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});
function createGitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

test("runWorkflow concurrency caps parallel agents", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const started: Array<string> = [];
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(prompt);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'concurrency_cap', description: 'cap parallelism' }
const xs = await parallel(['a','b','c','d'].map((p) => () => agent(p, { label: p })))
return xs`;

  const run = runWorkflow(script, { agent: runner, concurrency: 2, persistLogs: false });
  while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started.length, 2, "only the first two agents should start before the gate opens");
  release.resolve();
  const result = await run;

  assert.equal(maxActive, 2);
  assert.deepEqual(result.result, ["ok:a", "ok:b", "ok:c", "ok:d"]);
  assert.equal(result.agentCount, 4);
});

test("named agent threads can be re-entered around a separate reviewer", async () => {
  const calls: Array<{ prompt: string; thread?: string }> = [];
  const result = await runWorkflow(
    `export const meta = { name: 'thread_reentry', description: 're-enter implementer' }
const first = await agent('implement', { thread: 'implementer' })
const review = await agent('review', { thread: 'reviewer' })
const second = await agent('address review', { thread: 'implementer' })
return { first, review, second }`,
    {
      agent: {
        async run(prompt, options) {
          calls.push({ prompt, thread: options?.thread });
          return `${options?.thread}:${prompt}`;
        },
      },
      persistLogs: false,
    },
  );

  assert.deepEqual(calls, [
    { prompt: "implement", thread: "implementer" },
    { prompt: "review", thread: "reviewer" },
    { prompt: "address review", thread: "implementer" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), {
    first: "implementer:implement",
    review: "reviewer:review",
    second: "implementer:address review",
  });
});

test("concurrent calls on one named thread are rejected before a second agent starts", async () => {
  let starts = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'thread_concurrency', description: 'reject overlap' }
return await parallel([
  () => agent('first', { thread: 'implementer' }),
  () => agent('second', { thread: 'implementer' })
])`,
      {
        agent: {
          async run() {
            starts++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return "ok";
          },
        },
        persistLogs: false,
      },
    ),
    /same-thread calls must be sequential/,
  );
  assert.equal(starts, 1);
});

test("named threads reject worktree isolation", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'thread_worktree', description: 'reject worktree' }
return await agent('work', { thread: 'implementer', isolation: 'worktree' })`,
      { agent: countingAgent().runner, persistLogs: false },
    ),
    /cannot use worktree isolation/,
  );
});

test("threaded calls are live resume barriers and are not journaled", async () => {
  const firstJournal: JournalEntry[] = [];
  const first = countingAgent();
  await runWorkflow(
    `export const meta = { name: 'thread_resume', description: 'thread barrier' }
const before = await agent('before')
const threaded = await agent('threaded', { thread: 'implementer' })
const after = await agent('after')
return { before, threaded, after }`,
    {
      agent: first.runner,
      runId: "thread-run",
      persistLogs: false,
      onAgentJournal: (entry) => firstJournal.push(entry),
    },
  );
  assert.deepEqual(
    firstJournal.map((entry) => entry.index),
    [0, 2],
  );

  const resumed = countingAgent();
  await runWorkflow(
    `export const meta = { name: 'thread_resume', description: 'thread barrier' }
const before = await agent('before')
const threaded = await agent('threaded', { thread: 'implementer' })
const after = await agent('after')
return { before, threaded, after }`,
    {
      agent: resumed.runner,
      runId: "thread-run",
      persistLogs: false,
      resumeJournal: new Map(firstJournal.map((entry) => [entry.index, entry])),
    },
  );
  assert.equal(resumed.state.calls, 2, "the prefix replays, then the threaded call and all later calls run live");
});

test("a timed-out named turn fully settles before retrying the thread", async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'thread_timeout_retry', description: 'safe retry' }
return await agent('work', { thread: 'implementer' })`,
    {
      agentTimeoutMs: 5,
      agentRetries: 1,
      agent: {
        async run(_prompt, options) {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          if (calls === 1) {
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }).finally(() => active--);
          } else {
            active--;
            return "ok";
          }
        },
      },
      persistLogs: false,
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(maxActive, 1);
});

test("runWorkflow retries recoverable empty output then succeeds", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_success', description: 'retry success' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1, "retries should not allocate extra logical agent slots");
  assert.equal(journal.length, 1, "only the final success is journaled");
});

test("runWorkflow reconciles timeout fallback with exact abort-teardown usage", { timeout: 2_500 }, async () => {
  const exactUsage: AgentUsage = {
    input: 900,
    output: 100,
    total: 1_000,
    cost: 0.5,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const result = await runWorkflow(
    `export const meta = { name: 'timeout_usage', description: 'timeout usage' }
return await agent('short prompt', { label: 'slow' })`,
    {
      agentTimeoutMs: 5,
      agent: {
        async run(prompt: string, options?: AgentRunOptions) {
          void prompt;
          return new Promise((resolve, reject) => {
            void resolve;
            options?.signal?.addEventListener(
              "abort",
              () => {
                setTimeout(() => {
                  options.onUsage?.(exactUsage);
                  reject(new Error("aborted after exact usage"));
                }, 1_100);
              },
              { once: true },
            );
          });
        },
      },
      persistLogs: false,
    },
  );

  assert.equal(result.result, null);
  assert.deepEqual(result.tokenUsage, exactUsage);
});

test("runWorkflow waits for timed-out teardown before starting a retry", { timeout: 3_000 }, async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const releaseFirstAttempt = createDeferred<void>();
  const run = runWorkflow(
    `export const meta = { name: 'slow_teardown', description: 'slow timeout teardown' }
return await agent('stuck', { label: 'stuck' })`,
    {
      agentTimeoutMs: 5,
      agentRetries: 1,
      agent: {
        async run(prompt: string) {
          void prompt;
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            if (calls === 1) {
              await releaseFirstAttempt.promise;
              throw new Error("aborted after slow teardown");
            }
            return "retry-result";
          } finally {
            active--;
          }
        },
      },
      persistLogs: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(calls, 1, "a retry must not overlap a timed-out runner still tearing down");
  releaseFirstAttempt.resolve(undefined);
  const result = await run;

  assert.equal(result.result, "retry-result");
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test("a timed-out runner that ignores its abort is abandoned after the grace", { timeout: 5_000 }, async () => {
  type LooseTool = { name: string; execute: (...args: unknown[]) => Promise<{ details?: { found?: boolean } }> };
  let stuck: AgentRunOptions | undefined;
  let stuckCalls = 0;
  const events: string[] = [];
  const ended: Array<{ label: string; result: unknown; errorCode?: WorkflowErrorCode }> = [];
  const logs: string[] = [];
  let lateWriteVisible: boolean | undefined;
  const startedAt = Date.now();
  const result = await runWorkflow<{ stuck: unknown; next: unknown }>(
    `export const meta = { name: 'abandon_timeout', description: 'signal-ignoring runner' }
const stuck = await agent('stuck', { label: 'stuck' })
const next = await agent('next', { label: 'next' })
return { stuck, next }`,
    {
      concurrency: 1,
      agentTimeoutMs: 30,
      agentRetries: 1,
      agentRetryBackoffMs: () => 0,
      drainAbortGraceMs: 100,
      persistLogs: false,
      onLog: (message) => logs.push(message),
      onAgentStart: (event) => events.push(`start:${event.label}`),
      onAgentHistory: (event) => events.push(`history:${event.label}`),
      onAgentModel: (event) => events.push(`model:${event.label}`),
      onAgentSession: (event) => events.push(`session:${event.callId}`),
      registerAgentSteer: (event) => {
        events.push(`steer:${event.label}`);
        return () => events.push(`unsteer:${event.label}`);
      },
      onAgentEnd: (event) => ended.push({ label: event.label, result: event.result, errorCode: event.errorCode }),
      agent: {
        async run(prompt, options) {
          if (prompt === "stuck") {
            stuckCalls++;
            stuck = options;
            // Registered while live, never withdrawn by this hung runner.
            options?.registerSteer?.(async () => {});
            return new Promise(() => {});
          }
          // The abandoned runner is still alive; nothing it reports may reach the run.
          stuck?.onHistory?.([]);
          stuck?.onModelResolved?.("late/model");
          stuck?.onSessionCreated?.({ sessionId: "late" });
          stuck?.registerSteer?.(async () => {});
          const stuckPut = stuck?.systemTools?.find((tool) => tool.name === "store_put") as LooseTool | undefined;
          await assert.rejects(stuckPut?.execute("late", { key: "late", value: 1 }) ?? Promise.resolve());
          const get = options?.systemTools?.find((tool) => tool.name === "store_get") as LooseTool | undefined;
          lateWriteVisible = (await get?.execute("read", { key: "late" }))?.details?.found;
          return "next-done";
        },
      },
    },
  );

  assert.equal(result.result.stuck, null);
  assert.equal(result.result.next, "next-done");
  assert.ok(Date.now() - startedAt < 2_000, "the run does not wait for the abandoned runner");
  assert.equal(stuckCalls, 1, "an abandoned runner is never retried alongside itself");
  assert.deepEqual(ended, [
    { label: "stuck", result: null, errorCode: WorkflowErrorCode.AGENT_TIMEOUT },
    { label: "next", result: "next-done", errorCode: undefined },
  ]);
  assert.deepEqual(
    events,
    ["start:stuck", "steer:stuck", "unsteer:stuck", "start:next"],
    "abandonment withdraws the hung session's steer registration",
  );
  assert.equal(lateWriteVisible, false, "the abandoned runner's store write is rejected");
  assert.ok(logs.some((message) => message.includes("abandon")));
});

test("runWorkflow returns null when recoverable retries are exhausted", async () => {
  let calls = 0;
  const logs: string[] = [];
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_exhausted', description: 'retry exhausted' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return "";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onLog: (message) => logs.push(message),
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, null);
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1);
  assert.equal(journal.length, 0, "failed/null recoverable results are not journaled");
  assert.ok(
    logs.some((message) => /retrying/i.test(message)),
    "logs should mention retrying",
  );
  assert.ok(
    logs.some((message) => /exhausted/i.test(message)),
    "logs should mention exhaustion",
  );
});

test("runWorkflow does not retry nonrecoverable errors", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'no_retry_nonrecoverable', description: 'nonrecoverable' }
const a = await agent('work', { label: 'a' })
return a`,
      {
        agent: {
          async run() {
            calls++;
            throw new WorkflowError("hard stop", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
        agentRetries: 2,
        persistLogs: false,
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(calls, 1);
});

test("runWorkflow accumulates real per-agent usage (incl. cost + cache tokens)", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002, cacheRead: 50, cacheWrite: 10 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9, "should be within tolerance");
  assert.equal(result.tokenUsage?.cacheRead, 100, "cacheRead accumulates across agents");
  assert.equal(result.tokenUsage?.cacheWrite, 20, "cacheWrite accumulates across agents");
});

test("runWorkflow streams cumulative token usage before an agent returns", async () => {
  const release = createDeferred<void>();
  const usageEvents: number[] = [];
  const finalizedUsageEvents: number[] = [];
  let settled = false;
  const run = runWorkflow(
    `export const meta = { name: 'live_usage', description: 'live token usage' }
     return await agent('work', { label: 'worker' })`,
    {
      agent: {
        async run(prompt, options) {
          void prompt;
          options?.onUsageProgress?.({ input: 7, output: 3, total: 10, cost: 0.01, cacheRead: 0, cacheWrite: 0 });
          options?.onUsageProgress?.({ input: 17, output: 8, total: 25, cost: 0.02, cacheRead: 0, cacheWrite: 0 });
          await release.promise;
          options?.onUsage?.({ input: 12, output: 8, total: 20, cost: 0.02, cacheRead: 0, cacheWrite: 0 });
          return "done";
        },
      },
      persistLogs: false,
      onAgentUsage: (event) => usageEvents.push(event.tokenUsage.total),
      onTokenUsage: (usage) => finalizedUsageEvents.push(usage.total),
    },
  ).finally(() => {
    settled = true;
  });

  while (usageEvents.length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(settled, false, "usage should be observable while the agent is still running");
  assert.deepEqual(usageEvents, [10, 25]);
  assert.deepEqual(finalizedUsageEvents, [], "progress estimates must not change finalized budget accounting");

  release.resolve();
  const result = await run;
  assert.equal(result.tokenUsage?.total, 20, "the exact terminal total must replace the progress estimate");
});

test("onAgentEnd reports cumulative settled usage across retries", async () => {
  let attempts = 0;
  let endedTokens: number | undefined;
  let endedUsage: AgentUsage | undefined;
  const result = await runWorkflow(
    `export const meta = { name: 'retry_usage', description: 'retry usage' }
     return await agent('work', { label: 'worker' })`,
    {
      agentRetries: 1,
      agent: {
        async run(prompt, options) {
          void prompt;
          attempts++;
          const total = attempts === 1 ? 40 : 25;
          options?.onUsageProgress?.({ input: 0, output: 100, total: 100, cost: 0, cacheRead: 0, cacheWrite: 0 });
          options?.onUsage?.({ input: 0, output: total, total, cost: 0, cacheRead: 0, cacheWrite: 0 });
          return attempts === 1 ? "" : "done";
        },
      },
      persistLogs: false,
      onAgentEnd: (event) => {
        endedTokens = event.tokens;
        endedUsage = event.tokenUsage;
      },
    },
  );

  assert.equal(result.result, "done");
  assert.equal(attempts, 2);
  assert.equal(endedTokens, 65);
  assert.equal(endedUsage?.total, 65);
});

test("meta.model is parsed and routes as the default model for agents", async () => {
  let seenModel: string | undefined;
  const recorder = {
    async run(_p: string, o: { model?: string }) {
      seenModel = o.model;
      return "ok";
    },
  };
  const script = `export const meta = { name: 'm', description: 'd', model: 'meta/default-model' }
await agent('x', { label: 'x' })
return 1`;
  await runWorkflow(script, { agent: recorder, persistLogs: false });
  assert.equal(seenModel, "meta/default-model", "an agent with no model/tier/phase route uses meta.model");
});

test("runWorkflow preserves authoritative cost-only terminal usage", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'cost_only', description: 'cost-only provider usage' }
     return await agent('work', { label: 'worker' })`,
    {
      agent: fakeAgent({ input: 0, output: 0, total: 0, cost: 0.25, cacheRead: 0, cacheWrite: 0 }),
      persistLogs: false,
    },
  );

  assert.equal(result.tokenUsage?.total, 0);
  assert.equal(result.tokenUsage?.cost, 0.25);
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("agents default to the first declared phase when the script omits phase()", async () => {
  // Regression for the "(no phase) has agents, declared phase 0/0" bug: a script
  // that declares meta.phases but never calls phase() should still group its
  // agents under the first declared phase, not an orphan "(no phase)" bucket.
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'Research' }, { title: 'Synthesize' }] }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["Research"]);
});

test("explicit phase() overrides the default first phase", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
     phase('B')
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["B"]);
});

test("no declared phases => agent phase stays undefined (no synthetic phase)", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd' }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, [undefined]);
});

test("runWorkflow routes models: explicit opts.model > phase model > default", async () => {
  const seen: Array<string | undefined> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; onUsage?: (u: AgentUsage) => void }) {
      seen.push(options.model);
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'routing', description: 'model routing',
    phases: [{ title: 'A', model: 'phase-a-model' }, { title: 'B' }]
  }
  phase('A')
  await agent('explicit wins', { label: 'e', model: 'explicit-model' })
  await agent('phase routed', { label: 'p' })
  phase('B')
  await agent('no model -> default', { label: 'n' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  assert.deepEqual(seen, ["explicit-model", "phase-a-model", undefined]);
});

test("runWorkflow plumbs opts.tier through to the agent with correct precedence", async () => {
  // Regression guard: tier must reach WorkflowAgent.run() (it was previously
  // dropped). Precedence: explicit model > tier > phase model.
  const seen: Array<{ model?: string; tier?: string }> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; tier?: string }) {
      seen.push({ model: options.model, tier: options.tier });
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'tier_routing', description: 'tier routing',
    phases: [{ title: 'A', model: 'phase-a-model' }]
  }
  phase('A')
  await agent('tier beats phase', { label: 't', tier: 'small' })
  await agent('explicit beats tier', { label: 'e', tier: 'small', model: 'explicit-model' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  // 1) tier set, no explicit model: model is left undefined so the tier (resolved
  //    inside run()) wins over the phase model; tier is forwarded.
  assert.deepEqual(seen[0], { model: undefined, tier: "small" });
  // 2) explicit model + tier: explicit model is forwarded and still wins.
  assert.deepEqual(seen[1], { model: "explicit-model", tier: "small" });
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("resume replays cached results without re-running agents", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "resume-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
    [0, 1],
  );

  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "resume-run",
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("script thinking is forwarded, validates before dispatch, and changes journal identity", async () => {
  const journal: JournalEntry[] = [];
  const seen: Array<string | undefined> = [];
  const script = (thinking: string) => `export const meta = { name: 'thinking_identity', description: 'thinking' }
return await agent('work', { thinking: '${thinking}' })`;
  await runWorkflow(script("low"), {
    persistLogs: false,
    runId: "thinking-run",
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run(_prompt, options) {
        seen.push(options.thinking);
        return "low";
      },
    },
  });
  await runWorkflow(script("high"), {
    persistLogs: false,
    runId: "thinking-run",
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
    agent: {
      async run(_prompt, options) {
        seen.push(options.thinking);
        return "high";
      },
    },
  });
  assert.deepEqual(seen, ["low", "high"], "changed thinking must not replay the old journal result");

  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'bad_thinking', description: 'bad' }
return await agent('work', { thinking: 'ultra' })`,
      {
        persistLogs: false,
        agent: {
          async run() {
            calls++;
            return "unexpected";
          },
        },
      },
    ),
    /thinking/i,
  );
  assert.equal(calls, 0, "invalid script thinking rejects before agent dispatch");
});

test("agent() rejects unknown or non-object options before dispatch and lists the accepted options", async () => {
  const accepted =
    WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts()
      .find((fact) => fact.id === "workflow.runtime.agent")
      ?.options?.options.map((option) => option.name) ?? [];
  assert.ok(accepted.includes("label") && accepted.includes("thread"), "the contract declares the agent options");
  let calls = 0;
  const runner = {
    async run() {
      calls++;
      return "ran";
    },
  };
  const run = (options: string) =>
    runWorkflow(
      `export const meta = { name: 'agent_options', description: 'agent option validation' }
return await agent('work', ${options})`,
      { agent: runner, persistLogs: false },
    );

  for (const [options, named] of [
    ["{ label: 'a', timeoutMs: 1000, retries: 3 }", /"timeoutMs", "retries"/],
    ["{ lable: 'typo' }", /"lable"/],
    ["'just a label'", /must be an object/],
    ["null", /must be an object/],
    ["['label']", /must be an object/],
  ] as const) {
    await assert.rejects(
      run(options),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
        !error.recoverable &&
        named.test(error.message) &&
        accepted.every((name) => error.message.includes(name)),
      `agent('work', ${options}) must fail loudly`,
    );
  }
  assert.equal(calls, 0, "invalid options never dispatch an agent");

  // Every declared option name is accepted; undefined values behave as omitted.
  const everyOption = `{ ${accepted.map((name) => `${name}: undefined`).join(", ")} }`;
  assert.equal((await run(everyOption)).result, "ran");
  assert.equal(calls, 1);
});

test("requested worktree isolation fails closed before starting a non-git agent", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-worktree-fail-closed-"));
  let runs = 0;
  let starts = 0;
  try {
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'fail_closed', description: 'no shared fallback' }
return await agent('must not run', { isolation: 'worktree' })`,
        {
          cwd,
          agent: {
            async run() {
              runs++;
              return "unexpected";
            },
          },
          persistLogs: false,
          onAgentStart: () => starts++,
        },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
        error.recoverable === false,
    );
    assert.equal(runs, 0, "isolation failure must not invoke the shared-checkout agent");
    assert.equal(starts, 0, "the host must not observe an agent start before isolation succeeds");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a journal entry from isolation: false cannot replay after worktree isolation is requested", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-worktree-cache-mode-"));
  const journal: JournalEntry[] = [];
  let runs = 0;
  const script = (isolation: string) => `export const meta = { name: 'cache_mode', description: 'isolation identity' }
return await agent('same prompt', { label: 'same', isolation: ${isolation} })`;
  try {
    await runWorkflow(script("false"), {
      cwd,
      runId: "cache-mode",
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
      agent: {
        async run() {
          runs++;
          return "cached without isolation";
        },
      },
    });
    await assert.rejects(
      runWorkflow(script("'worktree'"), {
        cwd,
        runId: "cache-mode",
        persistLogs: false,
        resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
        agent: {
          async run() {
            runs++;
            return "must not run in a shared checkout";
          },
        },
      }),
      (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
    assert.equal(runs, 1, "the false-to-worktree cache miss must fail closed before agent.run");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("keepWorktree changes invalidate isolated journal entries while retained worktrees replay", async () => {
  const repo = createGitRepo("pi-worktree-cache-retention-");
  const journal: JournalEntry[] = [];
  const script = (
    keepWorktree: boolean,
  ) => `export const meta = { name: 'cache_retention', description: 'retention identity' }
return await agent('same prompt', { label: 'same', isolation: 'worktree', keepWorktree: ${keepWorktree} })`;
  let runs = 0;
  let liveCwd = "";
  const runner = {
    async run(_prompt: string, options: AgentRunOptions) {
      runs++;
      liveCwd = options.cwd ?? "";
      return `live-${runs}`;
    },
  };
  try {
    await runWorkflow(script(false), {
      cwd: repo,
      runId: "cache-retention",
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
      agent: runner,
    });
    assert.equal(existsSync(liveCwd), false, "the first keepWorktree: false tree was removed");

    await runWorkflow(script(true), {
      cwd: repo,
      runId: "cache-retention",
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      onAgentJournal: (entry) => journal.push(entry),
      agent: runner,
    });
    assert.equal(runs, 2, "changing retention must not replay an entry whose tree was removed");
    assert.ok(existsSync(liveCwd), "the keepWorktree: true live retry retains its new tree");

    await runWorkflow(script(true), {
      cwd: repo,
      runId: "cache-retention",
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      agent: runner,
    });
    assert.equal(runs, 2, "an unchanged valid keepWorktree: true entry replays without agent.run");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("onAgentStart failure still honors worktree retention cleanup", async () => {
  const repo = createGitRepo("pi-worktree-start-failure-");
  const script = (keepWorktree: boolean) => `export const meta = { name: 'start_failure', description: 'start cleanup' }
return await agent('same prompt', { label: 'same', isolation: 'worktree', keepWorktree: ${keepWorktree} })`;
  try {
    for (const keepWorktree of [false, true]) {
      const logs: string[] = [];
      let runs = 0;
      await assert.rejects(
        runWorkflow(script(keepWorktree), {
          cwd: repo,
          persistLogs: false,
          onLog: (message) => logs.push(message),
          onAgentStart: () => {
            throw new Error("start callback failed");
          },
          agent: {
            async run() {
              runs++;
              return "unexpected";
            },
          },
        }),
        /start callback failed/,
      );
      assert.equal(runs, 0, "a throwing start callback must prevent agent.run");
      const kept = logs.find((message) => message.startsWith("worktree kept: "));
      if (!keepWorktree) {
        assert.equal(kept, undefined, "keepWorktree: false cleans up after the callback failure");
      } else {
        assert.ok(kept, "keepWorktree: true still records the retained path through onLog");
        const cwd = kept?.slice("worktree kept: ".length).split(" (")[0] ?? "";
        assert.ok(existsSync(cwd), "the logged retained path remains inspectable");
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("repeated live executions with the same run id and long slug retain independent worktrees", async () => {
  const repo = createGitRepo("pi-worktree-repeat-");
  const seen: string[] = [];
  const script = `export const meta = { name: 'repeat_tree', description: 'unique retained worktrees' }
return await agent('edit', { label: 'this-is-a-very-long-label-that-shares-the-entire-slug-prefix', isolation: 'worktree' })`;
  try {
    const runner = {
      async run(_prompt: string, options: AgentRunOptions) {
        const cwd = options.cwd ?? "";
        seen.push(cwd);
        if (seen.length === 1) writeFileSync(join(cwd, "first-only.txt"), "first\n");
        return "ok";
      },
    };
    await runWorkflow(script, { cwd: repo, runId: "same-run-id", agent: runner, persistLogs: false });
    await runWorkflow(script, { cwd: repo, runId: "same-run-id", agent: runner, persistLogs: false });

    assert.notEqual(seen[0], seen[1], "same run id and truncated slug must not reuse a retained tree");
    assert.equal(readFileSync(join(seen[0] ?? "", "first-only.txt"), "utf8"), "first\n");
    assert.equal(existsSync(join(seen[1] ?? "", "first-only.txt")), false);
    assert.equal(existsSync(join(repo, "first-only.txt")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree success, failure, and abort are retained by default; keepWorktree false cleans up", async () => {
  const repo = createGitRepo("pi-worktree-retention-");
  const script = (
    name: string,
    options = "",
  ) => `export const meta = { name: '${name}', description: 'worktree retention' }
return await agent('${name}', { isolation: 'worktree'${options} })`;
  try {
    let successCwd = "";
    await runWorkflow(script("success"), {
      cwd: repo,
      persistLogs: false,
      agent: {
        async run(_prompt, options) {
          successCwd = options.cwd ?? "";
          writeFileSync(join(successCwd, "success.txt"), "retained\n");
          return "ok";
        },
      },
    });
    assert.ok(existsSync(successCwd), "successful worktree is retained");

    let failureCwd = "";
    await assert.rejects(
      runWorkflow(script("failure"), {
        cwd: repo,
        persistLogs: false,
        agent: {
          async run(_prompt, options) {
            failureCwd = options.cwd ?? "";
            writeFileSync(join(failureCwd, "failure.txt"), "retained\n");
            throw new WorkflowError("intentional", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
      }),
      /intentional/,
    );
    assert.ok(existsSync(failureCwd), "failed worktree is retained for inspection");

    const abort = new AbortController();
    const started = createDeferred<void>();
    let abortedCwd = "";
    const abortedRun = runWorkflow(script("abort"), {
      cwd: repo,
      signal: abort.signal,
      persistLogs: false,
      agent: {
        async run(_prompt, options) {
          abortedCwd = options.cwd ?? "";
          started.resolve();
          return new Promise<string>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
    });
    await started.promise;
    abort.abort();
    await assert.rejects(abortedRun, /aborted/);
    assert.ok(existsSync(abortedCwd), "aborted worktree is retained for inspection");

    let ephemeralCwd = "";
    await runWorkflow(script("ephemeral", ", keepWorktree: false"), {
      cwd: repo,
      persistLogs: false,
      agent: {
        async run(_prompt, options) {
          ephemeralCwd = options.cwd ?? "";
          return "ok";
        },
      },
    });
    assert.equal(existsSync(ephemeralCwd), false, "explicit keepWorktree: false removes the worktree");
    for (const name of ["success.txt", "failure.txt"]) {
      assert.equal(existsSync(join(repo, name)), false, `${name} must not pollute the base checkout`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("calls still queued when the run aborts create no worktree and never start", async () => {
  const repo = createGitRepo("pi-worktree-queued-abort-");
  const abort = new AbortController();
  const firstRunning = createDeferred<void>();
  const started: string[] = [];
  const ended: string[] = [];
  let dispatched = 0;
  try {
    const run = runWorkflow(
      `export const meta = { name: 'queued_abort', description: 'queued worktree calls' }
return await parallel([1, 2, 3].map((n) => () => agent('work ' + n, { label: 'w' + n, isolation: 'worktree' })))`,
      {
        cwd: repo,
        concurrency: 1,
        signal: abort.signal,
        persistLogs: false,
        onAgentStart: (event) => started.push(event.label),
        onAgentEnd: (event) => ended.push(event.label),
        agent: {
          async run(_prompt, options) {
            dispatched++;
            firstRunning.resolve();
            return new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          },
        },
      },
    );
    await firstRunning.promise;
    abort.abort();
    await assert.rejects(run, /aborted/);

    assert.equal(dispatched, 1);
    assert.deepEqual(started, ["w1"], "queued calls must not announce an agent after the abort");
    assert.deepEqual(ended, [], "an abort is not reported as an agent failure");
    const trees = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    assert.equal(trees.length, 2, "only the base checkout and the started agent's tree exist");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a checkpoint suspension stops queued calls without reporting them as failed", async () => {
  const releaseFirst = createDeferred<void>();
  const firstRunning = createDeferred<void>();
  const started: string[] = [];
  const ended: Array<{ label: string; result: unknown; errorCode?: WorkflowErrorCode }> = [];
  const journal: JournalEntry[] = [];
  let dispatched = 0;
  const run = runWorkflow(
    `export const meta = { name: 'queued_suspension', description: 'queued call at a checkpoint' }
await parallel([
  () => agent('one', { label: 'one' }),
  () => agent('two', { label: 'two' }),
  () => checkpoint({ kind: 'approval', checkpointId: 'gate', payload: {} }),
])
return 'must not complete'`,
    {
      concurrency: 1,
      persistLogs: false,
      onWorkflowCheckpoint: () => {},
      onAgentJournal: (entry) => journal.push(entry),
      onAgentStart: (event) => started.push(event.label),
      onAgentEnd: (event) => ended.push({ label: event.label, result: event.result, errorCode: event.errorCode }),
      agent: {
        async run(prompt) {
          dispatched++;
          firstRunning.resolve();
          await releaseFirst.promise;
          return `${prompt}-done`;
        },
      },
    },
  );
  await firstRunning.promise;
  releaseFirst.resolve();
  await assert.rejects(run, WorkflowCheckpointSuspensionError);

  assert.equal(dispatched, 1);
  assert.deepEqual(started, ["one"], "the queued call never starts once the run is suspended");
  assert.deepEqual(ended, [{ label: "one", result: "one-done", errorCode: undefined }]);
  assert.deepEqual(
    journal.map((entry) => entry.result),
    ["one-done"],
    "the in-flight result is journaled; the queued call re-runs on resume",
  );
});

test("replay does not create a worktree; a resume miss creates a fresh tree without base pollution", async () => {
  const repo = createGitRepo("pi-worktree-resume-");
  const journal: JournalEntry[] = [];
  const script = (prompt: string) => `export const meta = { name: 'resume_tree', description: 'retained trees' }
return await agent('${prompt}', { label: 'same-label', isolation: 'worktree' })`;
  try {
    let firstCwd = "";
    await runWorkflow(script("first"), {
      cwd: repo,
      runId: "same-run-id",
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
      agent: {
        async run(_prompt, options) {
          firstCwd = options.cwd ?? "";
          writeFileSync(join(firstCwd, "marker.txt"), "first\n");
          return "first";
        },
      },
    });

    let replayCalls = 0;
    await runWorkflow(script("first"), {
      cwd: repo,
      runId: "same-run-id",
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      agent: {
        async run() {
          replayCalls++;
          return "unexpected";
        },
      },
    });
    assert.equal(replayCalls, 0, "a journal hit must not create or run an agent worktree");

    let missCwd = "";
    await runWorkflow(script("changed"), {
      cwd: repo,
      runId: "same-run-id",
      persistLogs: false,
      resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
      agent: {
        async run(_prompt, options) {
          missCwd = options.cwd ?? "";
          writeFileSync(join(missCwd, "marker.txt"), "miss\n");
          return "miss";
        },
      },
    });
    assert.notEqual(missCwd, firstCwd, "a resume miss owns a new worktree despite the same run id and label");
    assert.equal(readFileSync(join(firstCwd, "marker.txt"), "utf8"), "first\n", "replay history remains inspectable");
    assert.equal(readFileSync(join(missCwd, "marker.txt"), "utf8"), "miss\n");
    assert.equal(existsSync(join(repo, "marker.txt")), false, "neither live execution mutates the base checkout");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("unthreaded agent journal hashes remain compatible with pre-thread runs", async () => {
  const journal: JournalEntry[] = [];
  await runWorkflow(
    `export const meta = { name: 'hash_compat', description: 'stable unthreaded hash' }
return await agent('work')`,
    {
      agent: countingAgent().runner,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  const oldIdentity = JSON.stringify({
    prompt: "work",
    model: null,
    tier: null,
    phase: null,
    agentType: null,
    agentDef: null,
    schema: null,
  });
  assert.equal(journal[0]?.hash, createHash("sha256").update(oldIdentity).digest("hex"));
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "resume-run-2",
    onAgentJournal: (e) => journal.push(e),
  });

  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "resume-run-2",
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

const threeCallScript = `export const meta = { name: 'prefix', description: 'prefix resume' }
const a = await agent('A', { label: 'a' })
const b = await agent('B', { label: 'b' })
const c = await agent('C', { label: 'c' })
return { a, b, c }`;

test("resume re-runs the changed call AND everything after it (longest-unchanged-prefix)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "prefix-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  // Edit the MIDDLE call (index 1). Index 0 is an unchanged prefix → cache hit.
  // Index 1 changed → re-run; index 2 is unchanged but AFTER the first miss, so
  // it must re-run too (the bug was serving it stale from the journal).
  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "prefix-run",
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "edited call (1) + its suffix (2) re-run; only the prefix (0) is cached");
});

test("resume in parallel(): editing one thunk re-runs that index and every later one", async () => {
  // Three identical-prompt thunks; editing the middle one must invalidate it and
  // the same-or-later index, not just the single changed call.
  const script = (mid: string) => `export const meta = { name: 'par_prefix', description: 'parallel prefix' }
  const xs = await parallel([
    () => agent('x', { label: 'p0' }),
    () => agent('${mid}', { label: 'p1' }),
    () => agent('x', { label: 'p2' }),
  ])
  return xs`;
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(script("x"), {
    agent: first.runner,
    persistLogs: false,
    runId: "par-prefix-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  const second = countingAgent();
  await runWorkflow(script("x-edited"), {
    agent: second.runner,
    persistLogs: false,
    runId: "par-prefix-run",
    resumeJournal: new Map(journal.map((e) => [e.index, e])),
  });
  assert.equal(second.state.calls, 2, "changed thunk (index 1) + later index (2) re-run; index 0 cached");
});

test("call indexes are deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("non-recoverable agent-limit propagates out of pipeline() too", async () => {
  const script = `export const meta = { name: 'mp', description: 'agent limit pipeline' }
const xs = await pipeline([0, 1, 2, 3], (n) => agent('x' + n, { label: 'p' + n }))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("maxAgents is enforced under a parallel() fan-out (atomic slot reservation)", async () => {
  // Four agents fan out with maxAgents=2. With the synchronous slot reservation,
  // the 3rd agent() throws AGENT_LIMIT instead of all four passing the gate.
  const script = `export const meta = { name: 'ma', description: 'agent limit' }
const xs = await parallel([0, 1, 2, 3].map((i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("a fan-out past maxAgents cancels queued agents instead of draining the reserved queue", async () => {
  // A parallel() overshoot reserves and queues up to maxAgents agents behind the
  // limiter. Before the fix, every reserved agent ran its real API call (spending)
  // even though the fan-out had already rejected; now the breach short-circuits the
  // still-queued agents so at most ~concurrency of them execute.
  const fanout = 100;
  const maxAgents = 50;
  const concurrency = 4;
  const calls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const runner = {
    async run(prompt: string) {
      calls.count++;
      await gate; // stay in-flight/queued while the limit breach propagates
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'c4', description: 'fanout cancel' }
const xs = await parallel(Array.from({ length: ${fanout} }, (_, i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  const run = runWorkflow(script, { agent: runner, maxAgents, concurrency, persistLogs: false });
  // The run now drains every in-flight agent() call (including these
  // gate-blocked ones) before its own promise settles — see the run-fatal
  // drain in runWorkflow's finally — so `run` will NOT reject until `gate`
  // resolves. Release it concurrently instead of after awaiting the
  // rejection (which would deadlock: nothing else ever calls release()).
  const releaseSoon = new Promise<void>((r) => setTimeout(r, 20)).then(() => release());
  await assert.rejects(run, /limit/i);
  await releaseSoon;
  // Deterministically exactly `concurrency`: the limiter runs the first
  // `concurrency` submissions' bodies synchronously during the reservation
  // pass (each immediately calls runner.run() and then suspends on `gate`);
  // every submission after that suspends on the limiter's internal queue
  // before it ever reaches runner.run(), and the batch is cancelled (via
  // fanoutScope) before any of them get their turn.
  assert.equal(calls.count, concurrency);
});

test("sibling parallel() batches are isolated: one breaching maxAgents does not cancel the other", async () => {
  // Two independent parallel() fan-outs run CONCURRENTLY inside the same run
  // (sharing one shared.agentCount / maxAgents), each isolated via its own
  // .then(ok, err). Batch A (3 agents) never breaches; batch B (40 agents)
  // does. Before batch-scoped cancellation, a run-global "limitReached" flag
  // would wrongly cancel A's still-queued agents too, purely because B (an
  // unrelated fan-out) breached the shared cap — that's the regression this
  // guards against.
  const maxAgents = 10;
  const concurrency = 2;
  const runner = {
    async run(prompt: string) {
      await new Promise((r) => setTimeout(r, 5));
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'sib', description: 'sibling isolation' }
const batchA = parallel(Array.from({ length: 3 }, (_, i) => () => agent('a' + i, { label: 'a' + i })))
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e && e.code }))
const batchB = parallel(Array.from({ length: 40 }, (_, i) => () => agent('b' + i, { label: 'b' + i })))
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e && e.code }))
const [a, b] = await Promise.all([batchA, batchB])
return { a, b }`;
  const res = await runWorkflow<{
    a: { ok: boolean; r?: unknown[] };
    b: { ok: boolean; code?: string };
  }>(script, { agent: runner, maxAgents, concurrency, persistLogs: false });

  assert.equal(res.result.a.ok, true, "batch A (never breaches) must resolve, not be cancelled by sibling B");
  assert.equal(res.result.a.r?.length, 3);
  assert.ok((res.result.a.r as unknown[]).every((r) => typeof r === "string" && r.startsWith("ran:")));

  assert.equal(res.result.b.ok, false, "batch B (breaches maxAgents) must reject");
  assert.equal(res.result.b.code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
});

test("a breach in a nested parallel() doesn't corrupt the outer batch's state", async () => {
  // Outer parallel() of two thunks; one thunk runs an inner parallel() that
  // breaches a low maxAgents. The breach should propagate as a rejection of
  // the whole run (agent limit is non-recoverable) without throwing anything
  // unexpected (e.g. an ALS/ordering bug corrupting shared.agentCount).
  const runner = {
    async run(prompt: string) {
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'nest', description: 'nested fanout' }
const xs = await parallel([
  () => agent('outer-1', { label: 'outer-1' }),
  () => parallel(Array.from({ length: 5 }, (_, i) => () => agent('inner' + i, { label: 'inner' + i }))),
])
return xs`;
  await assert.rejects(
    () => runWorkflow(script, { agent: runner, maxAgents: 2, concurrency: 2, persistLogs: false }),
    /limit/i,
  );
});

// ─── Additional edge case tests ─────────────────────────────────────────────────

test("runWorkflow returns meta, logs, phases, and duration", async () => {
  const ONE_AGENT = `export const meta = { name: 'meta_test', description: 'check metadata' }
const a = await agent('test', { label: 'a' })
return a`;

  const result = await runWorkflow(ONE_AGENT, {
    agent: fakeAgent({ total: 50 }),
    persistLogs: false,
  });

  assert.equal(result.meta.name, "meta_test");
  assert.equal(result.meta.description, "check metadata");
  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
  assert.ok(Array.isArray(result.phases), "result.phases should be an array");
  assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
  assert.ok(typeof result.runId === "string" && result.runId.length > 0, "runId should be a non-empty string");
});

test("runWorkflow handles empty script without phases gracefully", async () => {
  const SIMPLE = `export const meta = { name: 'simple', description: 'simple' }
const a = await agent('hello', { label: 'greeter' })
return a`;

  const result = await runWorkflow(SIMPLE, {
    agent: fakeAgent({ total: 50 }, "done"),
    persistLogs: false,
  });
  assert.equal(result.result, "done");
  assert.equal(result.agentCount, 1);
});

test("runWorkflow parallel returns results in input order", async () => {
  const script = `export const meta = { name: 'parallel_order', description: 'check order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n, { label: 't' + n })))
return results`;

  let callIndex = 0;
  const agent = {
    async run(prompt: string) {
      return `result-${++callIndex}:${prompt}`;
    },
  };

  const result = await runWorkflow<unknown[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 3);
});

test("runWorkflow pipeline stages in order", async () => {
  const script = `export const meta = { name: 'pipeline_test', description: 'test pipeline' }
const results = await pipeline(['a','b'], item => agent('stage1 ' + item), result => agent('stage2 ' + result))
return results`;

  const log: string[] = [];
  const agent = {
    async run(prompt: string) {
      log.push(prompt);
      return prompt.replace("stage1", "stage1-done").replace("stage2", "stage2-done");
    },
  };

  const result = await runWorkflow<string[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 2);
});

test("pipeline forwards a recoverable null to the next stage with original item and index", async () => {
  const script = `export const meta = { name: 'pipeline_null', description: 'null forwarding' }
const results = await pipeline(
  ['alpha'],
  (item) => agent('first ' + item, { label: 'first' }),
  (previousValue, originalItem, index) => ({ previousValue, originalItem, index }),
)
return results`;
  const agent = {
    async run() {
      throw new Error("recoverable first-stage failure");
    },
  };

  const result = await runWorkflow<Array<{ previousValue: null; originalItem: string; index: number }>>(script, {
    agent,
    persistLogs: false,
  });

  assert.deepEqual(
    Array.from(result.result, ({ previousValue, originalItem, index }) => ({ previousValue, originalItem, index })),
    [{ previousValue: null, originalItem: "alpha", index: 0 }],
  );
});

test("runWorkflow agent with different labels", async () => {
  const script = `export const meta = { name: 'label_test', description: 'labels' }
const a = await agent('task1', { label: 'worker-1' })
const b = await agent('task2', { label: 'worker-2' })
return { a, b }`;

  const seenLabels: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentStart: (e) => seenLabels.push(e.label),
  });

  assert.deepEqual(seenLabels, ["worker-1", "worker-2"]);
});

test("runWorkflow with phases assignment to agents", async () => {
  const script = `export const meta = { name: 'phase_test', description: 'phases', phases: [{ title: 'Phase1' }, { title: 'Phase2' }] }
phase('Phase1')
const a = await agent('phase1 work', { label: 'p1' })
phase('Phase2')
const b = await agent('phase2 work', { label: 'p2' })
return { a, b }`;

  const phases: string[] = [];
  const agentPhases: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onPhase: (title) => phases.push(title),
    onAgentStart: (e) => {
      if (e.phase) agentPhases.push(e.phase);
    },
  });

  assert.ok(phases.includes("Phase1"), "should contain Phase1");
  assert.ok(phases.includes("Phase2"), "should contain Phase2");
});

test("runWorkflow can send args to the script", async () => {
  const script = `export const meta = { name: 'args_test', description: 'test args' }
return { received: args && args.value }`;

  const result = await runWorkflow<{ received: unknown }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    args: { value: 42 },
  });

  // No agent calls means 0 agents
  assert.equal(result.result.received, 42);
});

test("runWorkflow gives the script a deeply frozen copy of args, so the persisted args never change", async () => {
  const args = { items: [3, 1, 2], nested: { value: 1 } };
  const result = await runWorkflow<{ sortError: string; editError: string; sorted: number[] }>(
    `export const meta = { name: 'args_frozen', description: 'frozen args' }
const attempt = (edit) => { try { edit(); return 'none' } catch (e) { return e.name } }
return {
  sortError: attempt(() => args.items.sort()),
  editError: attempt(() => { args.nested.value = 2 }),
  sorted: [...args.items].sort(),
}`,
    { agent: countingAgent().runner, persistLogs: false, args },
  );

  assert.equal(result.result.sortError, "TypeError");
  assert.equal(result.result.editError, "TypeError");
  assert.deepEqual([...result.result.sorted], [1, 2, 3]);
  assert.deepEqual(args, { items: [3, 1, 2], nested: { value: 1 } });
  assert.equal(Object.isFrozen(args), false, "the caller's own object is left alone");
});

test("runWorkflow rejects args that would not survive persistence unchanged", async () => {
  await assert.rejects(
    runWorkflow("export const meta = { name: 'args_lossy', description: 'lossy args' }\nreturn args", {
      agent: countingAgent().runner,
      persistLogs: false,
      args: { ratio: Number.NaN },
    }),
    /workflow args must be a lossless JSON value/,
  );
});

test("runWorkflow log function works inside script", async () => {
  const script = `export const meta = { name: 'log_test', description: 'logging' }
log('hello from script')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("hello from script")),
    "should contain hello from script",
  );
});

test("runWorkflow console.log works inside script", async () => {
  const script = `export const meta = { name: 'console_test', description: 'console' }
console.log('console log')
console.warn('console warn')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("console log")),
    "should contain console log",
  );
  assert.ok(
    result.logs.some((l) => l.includes("console warn")),
    "should contain console warn",
  );
});

test("runWorkflow process.cwd() works inside script", async () => {
  const script = `export const meta = { name: 'cwd_test', description: 'cwd' }
return { cwd: process.cwd() }`;

  const result = await runWorkflow<{ cwd: string }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.equal(typeof result.result.cwd, "string");
  assert.ok(result.result.cwd.length > 0, "result.cwd should not be empty");
});

test("runWorkflow process.cwd() stays the run's cwd when the host process changes directory", async () => {
  const hostCwd = process.cwd();
  const elsewhere = mkdtempSync(join(tmpdir(), "pi-run-cwd-"));
  try {
    const result = await runWorkflow<{ cwd: string; processCwd: string }>(
      `export const meta = { name: 'cwd_stable', description: 'cwd' }
await agent('move')
return { cwd, processCwd: process.cwd() }`,
      {
        agent: {
          async run() {
            process.chdir(elsewhere);
            return "moved";
          },
        },
        persistLogs: false,
      },
    );
    assert.equal(result.result.cwd, hostCwd);
    assert.equal(result.result.processCwd, hostCwd);
  } finally {
    process.chdir(hostCwd);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("runWorkflow returns empty logs array when nothing logged", async () => {
  const script = `export const meta = { name: 'no_log', description: 'no logs' }
await agent('silent', { label: 's' })
return 1`;

  const result = await runWorkflow(script, {
    agent: fakeAgent({ total: 10 }),
    persistLogs: false,
  });

  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
});

// ── Run-fatal abort: a non-recoverable error that will fail the whole run
// must stop in-flight siblings from continuing to spend, while preserving
// parallel()'s null-on-recoverable-error contract and a script's own
// try/catch around agent()/parallel(). ──

/** An agent runner whose in-flight calls actually respect an abort signal. */
function abortAwareAgent(delayMs: number) {
  const state = { started: 0, completed: 0, aborted: 0 };
  return {
    state,
    runner: {
      async run(prompt: string, options: { signal?: AbortSignal } = {}) {
        state.started++;
        if (prompt === "failer") {
          throw new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
        }
        if (prompt === "flaky") throw new Error("transient failure");
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            state.completed++;
            resolve(`done:${prompt}`);
          }, delayMs);
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              state.aborted++;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    },
  };
}

test("onRunFatal consumes an asynchronous observer rejection without masking the workflow error", async () => {
  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  const script = `export const meta = { name: 'fatal_observer', description: 'fatal observer' }
await agent('failer')`;
  const runner = {
    async run() {
      throw new WorkflowError("primary workflow failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
        recoverable: false,
      });
    },
  };

  try {
    await assert.rejects(
      runWorkflow(script, {
        agent: runner,
        persistLogs: false,
        onRunFatal: async () => {
          throw new Error("observer rejection");
        },
      }),
      /primary workflow failure/,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(unhandled, undefined, "observer rejection must be consumed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a run-fatal error aborts in-flight parallel() siblings instead of letting them run to completion", async () => {
  const { state, runner } = abortAwareAgent(200);
  const script = `export const meta = { name: 'fatal_abort', description: 'sibling abort' }
const xs = await parallel([
  () => agent('failer', { label: 'failer' }),
  () => agent('sib1', { label: 'sib1' }),
  () => agent('sib2', { label: 'sib2' }),
])
return xs`;
  await assert.rejects(runWorkflow(script, { agent: runner, persistLogs: false }), /boom/);
  // Both in-flight siblings must have been aborted before their (200ms)
  // delay would otherwise have let them complete and return a result.
  assert.equal(state.started, 3, "all three agent() calls actually started");
  assert.equal(state.aborted, 2, "both siblings were aborted once the run's fate was sealed");
  assert.equal(state.completed, 0, "no sibling ran to completion on a run that's already failing");
});

test("a script's own try/catch around parallel() preserves in-flight siblings — no run-fatal abort", async () => {
  const { state, runner } = abortAwareAgent(20);
  const script = `export const meta = { name: 'fatal_abort_caught', description: 'sibling survives caught failure' }
let caught = false
try {
  await parallel([
    () => agent('failer', { label: 'failer' }),
    () => agent('sib1', { label: 'sib1' }),
  ])
} catch (e) {
  caught = true
}
// A later agent() call must still work normally — the run's fate was never
// sealed because the script caught parallel()'s escaping error.
const after = await agent('after', { label: 'after' })
return { caught, after }`;
  const result = await runWorkflow<{ caught: boolean; after: string }>(script, {
    agent: runner,
    persistLogs: false,
  });
  assert.equal(result.result.caught, true, "the script's own try/catch saw parallel()'s escaping error");
  assert.equal(result.result.after, "done:after", "a later agent() call still runs normally, unaborted");
  assert.equal(state.aborted, 0, "the caught sibling was never aborted — the run's fate was never sealed");
  assert.equal(state.completed, 2, "the caught sibling and the later agent() both ran to completion");
});

test("a recoverable agent() failure inside parallel() becomes null without aborting siblings", async () => {
  const { state, runner } = abortAwareAgent(20);
  const script = `export const meta = { name: 'recoverable_null', description: 'recoverable swallowed' }
const xs = await parallel([
  () => agent('flaky', { label: 'flaky' }),
  () => agent('sib', { label: 'sib' }),
])
return xs`;
  const result = await runWorkflow<Array<unknown>>(script, { agent: runner, persistLogs: false });
  assert.deepEqual(result.result, [null, "done:sib"], "the failed branch resolves to null; the sibling still succeeds");
  assert.equal(state.aborted, 0, "a recoverable failure must never trigger a run-fatal abort");
  assert.equal(state.completed, 1);
});

for (const [name, fanout] of [
  ["parallel() thunk", "parallel([() => agent('sib', { label: 'sib' }), () => BUG])"],
  ["pipeline() stage", "pipeline(['sib', 'bug'], (item) => (item === 'bug' ? BUG : agent(item, { label: item })))"],
] as const) {
  for (const [errorName, bug] of [
    ["ReferenceError", "missingBinding"],
    ["TypeError", "null.field"],
  ] as const) {
    test(`a ${errorName} in a ${name} rejects the fan-out instead of becoming null`, async () => {
      const { state, runner } = abortAwareAgent(200);
      const script = `export const meta = { name: 'fanout_bug', description: 'script bug in a branch' }
return await ${fanout.replace("BUG", bug)}`;
      await assert.rejects(runWorkflow(script, { agent: runner, persistLogs: false }), (error: Error) => {
        assert.equal(error.name, errorName, "the script's own error propagates unchanged");
        return true;
      });
      assert.equal(state.completed, 0, "the sibling is aborted with the failed run instead of completing");
    });
  }
}

test("parallel() and pipeline() turn only a recoverable WorkflowError into null", async () => {
  const logs: string[] = [];
  const ctx = {
    state: { scriptCalls: CallSequence.forScript() },
    throwIfAborted: () => {},
    isAborted: () => false,
    log: (line: string) => logs.push(line),
  };
  const recoverable = () => {
    throw new WorkflowError("transient", WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true });
  };
  const fatal = new WorkflowError("fatal", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
  const parallel = createParallel(ctx as unknown as RunContext);
  const pipeline = createPipeline(ctx as unknown as RunContext);

  assert.deepEqual(await parallel([recoverable, async () => "ok"]), [null, "ok"]);
  const firstFails = (n: unknown) => (n === 1 ? recoverable() : n);
  assert.deepEqual(await pipeline([1, 2], firstFails, (n) => n), [null, 2]);
  assert.deepEqual(logs, ["parallel[0] failed: transient", "pipeline[0] failed: transient"]);
  await assert.rejects(
    parallel([
      async () => {
        throw fatal;
      },
    ]),
    (error) => error === fatal,
  );
});

// ── Un-awaited agent() calls must not outlive the run: the run drains every
// spawned agent() call (awaited or not) before it is allowed to complete. ──

test("an un-awaited agent() call is drained before the run completes", async () => {
  let strayCompleted = false;
  const runner = {
    async run(prompt: string) {
      if (prompt === "stray") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        strayCompleted = true;
        return "stray-done";
      }
      return "main-done";
    },
  };
  const script = `export const meta = { name: 'stray_demo', description: 'un-awaited agent' }
// Deliberately NOT awaited — a script bug the run must tolerate without
// letting this call outlive the run's completion.
agent('stray', { label: 'stray' })
const main = await agent('main', { label: 'main' })
return main`;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow<string>(script, {
    agent: runner,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(result.result, "main-done");
  assert.equal(strayCompleted, true, "the run must not complete until the un-awaited agent has settled");
  assert.ok(
    journal.some((e) => e.result === "stray-done"),
    "the stray agent's completion must be journaled before the run ends",
  );
});

test("an un-awaited agent() call replays deterministically from the journal on resume", async () => {
  const calls = { stray: 0, main: 0 };
  const runner = {
    async run(prompt: string) {
      if (prompt === "stray") {
        calls.stray++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "stray-done";
      }
      calls.main++;
      return "main-done";
    },
  };
  const script = `export const meta = { name: 'stray_resume_demo', description: 'un-awaited agent replay' }
agent('stray', { label: 'stray' })
const main = await agent('main', { label: 'main' })
return main`;
  const journalEntries = new Map<number, JournalEntry>();
  const first = await runWorkflow<string>(script, {
    agent: runner,
    persistLogs: false,
    runId: "prior-run",
    onAgentJournal: (entry) => journalEntries.set(entry.index, entry),
  });
  assert.equal(first.result, "main-done");
  assert.equal(calls.stray, 1);
  assert.equal(calls.main, 1);

  const second = await runWorkflow<string>(script, {
    agent: runner,
    persistLogs: false,
    runId: "prior-run",
    resumeJournal: journalEntries,
  });
  assert.equal(second.result, "main-done");
  // Resume replays BOTH cached calls (including the un-awaited 'stray') from
  // the journal — neither runner.run() is invoked again.
  assert.equal(calls.stray, 1, "the un-awaited agent's cached result must replay, not re-run, on resume");
  assert.equal(calls.main, 1, "the awaited agent's cached result must replay, not re-run, on resume");
});

test("an agent() call reached after the run ended neither replays nor reports", async () => {
  type LooseTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
  const journal = new Map<number, JournalEntry>();
  await runWorkflow(
    `export const meta = { name: 'late_call', description: 'journal source' }
return await agent('remember', { label: 'r' })`,
    {
      persistLogs: false,
      onAgentJournal: (entry) => journal.set(entry.index, entry),
      agent: {
        async run(_prompt, options) {
          const put = options?.systemTools?.find((tool) => tool.name === "store_put") as LooseTool | undefined;
          await put?.execute("put", { key: "k", value: "v" });
          return "remembered";
        },
      },
    },
  );
  assert.deepEqual(journal.get(0)?.storeDelta, { k: "v" });

  const events: string[] = [];
  // args must be lossless JSON, so the script hands its own gate back through the result.
  const result = await runWorkflow<{ status: string; release: () => void; settled: Promise<unknown> }>(
    `export const meta = { name: 'late_call', description: 'late un-awaited chain' }
let release
const later = new Promise((resolve) => { release = resolve })
const settled = later.then(() => agent('remember', { label: 'r' })).then((value) => value, (error) => error)
return { status: 'done', release, settled }`,
    {
      resumeJournal: journal,
      persistLogs: false,
      onAgentStart: (event) => events.push(`start:${event.label}`),
      onAgentEnd: (event) => events.push(`end:${event.label}`),
      agent: {
        async run() {
          events.push("run");
          return "unexpected";
        },
      },
    },
  );
  assert.equal(result.result.status, "done");

  result.result.release();
  const outcome = await result.result.settled;
  assert.ok(outcome instanceof WorkflowError, "the late call is rejected");
  assert.match(outcome.message, /after the run ended/);
  assert.deepEqual(events, [], "a finished run reports no further agents");
});

test("agent() retries back off between attempts (audit2 #7)", async () => {
  const script = `export const meta = { name: 'retry_bo', description: 'retry backoff' }
const r = await agent('flaky', { label: 'flaky' })
return r`;
  const backoffs: number[] = [];
  let attempts = 0;
  const started = Date.now();
  const result = await runWorkflow<string>(script, {
    agent: {
      async run() {
        attempts++;
        if (attempts < 3) {
          throw new WorkflowError("empty", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true });
        }
        return "recovered";
      },
    },
    agentRetries: 3,
    agentRetryBackoffMs: (failedAttempt) => {
      backoffs.push(failedAttempt);
      return 40;
    },
    persistLogs: false,
  });
  assert.equal(result.result, "recovered");
  assert.deepEqual(backoffs, [1, 2], "backoff consulted per failed attempt");
  assert.ok(Date.now() - started >= 75, "the waits actually elapsed (2 × 40ms)");
});

test("agent() uses the default 250ms backoff for the first retry when no callback is injected", async () => {
  const script = `export const meta = { name: 'retry_default', description: 'default backoff' }
return await agent('flaky')`;
  let attempts = 0;
  const started = Date.now();
  const result = await runWorkflow<string>(script, {
    agent: {
      async run() {
        attempts++;
        if (attempts === 1) {
          throw new WorkflowError("empty", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true });
        }
        return "recovered";
      },
    },
    agentRetries: 1,
    persistLogs: false,
  });
  assert.equal(result.result, "recovered");
  assert.ok(
    Date.now() - started >= 240,
    `default first-retry backoff (~250ms) elapsed (took ${Date.now() - started}ms)`,
  );
});

test("a run-level invalid agentTimeoutMs coerces to the default", async () => {
  // An embedding host's 0 must not fail the run or instantly abort sessions; coerce + log.
  const script = `export const meta = { name: 't3', description: 't3' }
return await agent('x')`;
  const logs: string[] = [];
  const result = await runWorkflow<string>(script, {
    agent: fakeAgent({}),
    agentTimeoutMs: 0,
    persistLogs: false,
    onLog: (m) => logs.push(m),
  });
  assert.equal(result.result, "ok");
  assert.ok(
    logs.some((l) => l.includes("ignoring invalid agentTimeoutMs")),
    "the coercion is logged",
  );
});

test("the usage fallback estimate is LAZY when the provider reported terminal usage (audit2 #9)", async () => {
  // A result whose JSON.stringify throws: if the fallback estimate were
  // computed eagerly, the run would crash even though real usage exists.
  const script = `export const meta = { name: 'lazy_est', description: 'lazy estimate' }
return await agent('x')`;
  const poisoned = {
    toJSON() {
      throw new Error("stringify must not run");
    },
  };
  const result = await runWorkflow(script, {
    agent: {
      async run(_p: string, o: { onUsage?: (u: AgentUsage) => void }) {
        o.onUsage?.({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0, total: 10, cost: 0 });
        return poisoned;
      },
    },
    persistLogs: false,
  });
  assert.equal(result.result, poisoned, "the agent call itself succeeded — an eager stringify would have failed it");
  assert.equal(result.tokenUsage?.total, 10, "real usage committed without ever stringifying the result");
});

test("agentRetryBackoffMs guard: 0 disables, Infinity/throwing fall back to the default", async () => {
  const script = `export const meta = { name: 'bo_guard', description: 'bo guard' }
return await agent('flaky')`;
  const flaky = () => {
    let attempts = 0;
    return {
      state: { attempts: 0 },
      async run() {
        attempts++;
        this.state.attempts = attempts;
        if (attempts === 1) {
          throw new WorkflowError("empty", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, { recoverable: true });
        }
        return "recovered";
      },
    };
  };
  // 0 disables: no wait at all.
  {
    const started = Date.now();
    const result = await runWorkflow<string>(script, {
      agent: flaky(),
      agentRetries: 1,
      agentRetryBackoffMs: () => 0,
      persistLogs: false,
    });
    assert.equal(result.result, "recovered");
    assert.ok(Date.now() - started < 100, "0 disables the backoff");
  }
  // Infinity falls back to the default (a 2^31-1 clamp would park ~24.8 days).
  for (const injected of [
    () => Number.POSITIVE_INFINITY,
    () => {
      throw new Error("boom");
    },
    () => 1e12, // finite but huge: clamped to the 2000ms cap, NOT a ~1ms overflow storm
  ]) {
    const started = Date.now();
    const result = await runWorkflow<string>(script, {
      agent: flaky(),
      agentRetries: 1,
      agentRetryBackoffMs: injected as () => number,
      persistLogs: false,
    });
    assert.equal(result.result, "recovered");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 240 && elapsed < 5_000, `default backoff used (${elapsed}ms)`);
  }
});

test("an aborted run's drain abandons signal-ignoring agents after drainAbortGraceMs (audit2 #3)", async () => {
  // Un-awaited agent whose runner NEVER settles and ignores its abort signal:
  // without the grace the drain (and the run) would wedge forever.
  const script = `export const meta = { name: 'hung_drain', description: 'hung drain' }
void agent('wedged', { label: 'wedged' })
return 'script-done'`;
  for (const abortTiming of ["during-drain", "before-drain"] as const) {
    const controller = new AbortController();
    const logs: string[] = [];
    const started = Date.now();
    let agentStarted!: () => void;
    const agentGate = new Promise<void>((resolve) => (agentStarted = resolve));
    const pending = runWorkflow<string>(script, {
      agent: {
        async run() {
          agentStarted();
          return new Promise<string>(() => {}); // never settles, ignores signal
        },
      },
      signal: controller.signal,
      drainAbortGraceMs: 50,
      persistLogs: false,
      onLog: (m) => logs.push(m),
    });
    await agentGate; // the hung agent is in-flight
    if (abortTiming === "before-drain") {
      // Abort immediately: the script may not have returned yet — the drain
      // starts already-aborted.
      controller.abort();
    } else {
      // Wait for the drain to start (its log line), then abort mid-drain.
      for (let i = 0; i < 2000 && !logs.some((l) => l.includes("outstanding agent()")); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      controller.abort();
    }
    await pending.catch(() => {});
    assert.ok(
      Date.now() - started < 5_000,
      `${abortTiming}: the run settles promptly after the grace instead of wedging`,
    );
    assert.ok(
      logs.some((l) => l.includes("abandoning 1 outstanding agent()")),
      `${abortTiming}: the abandonment is logged`,
    );
  }
});

test("drainAbortGraceMs: Infinity restores unbounded waiting (no busy-spin) (audit2 #3)", async () => {
  const script = `export const meta = { name: 'hung_inf', description: 'hung inf' }
void agent('wedged', { label: 'wedged' })
return 'script-done'`;
  const controller = new AbortController();
  const logs: string[] = [];
  let agentStarted!: () => void;
  const agentGate = new Promise<void>((resolve) => (agentStarted = resolve));
  const pending = runWorkflow<string>(script, {
    agent: {
      async run() {
        agentStarted();
        return new Promise<string>(() => {});
      },
    },
    signal: controller.signal,
    drainAbortGraceMs: Number.POSITIVE_INFINITY,
    persistLogs: false,
    onLog: (m) => logs.push(m),
  });
  await agentGate;
  controller.abort();
  // With Infinity the drain must NOT abandon: it keeps waiting. Give it ample
  // time to (wrongly) abandon or (wrongly) busy-spin, then confirm neither.
  const settled = await Promise.race([
    pending.then(
      () => true,
      () => true,
    ),
    new Promise((r) => setTimeout(() => r(false), 300)),
  ]);
  assert.equal(settled, false, "Infinity grace: the drain must not abandon the hung agent");
  assert.ok(!logs.some((l) => l.includes("abandoning")), "no abandonment logged");
  // Cleanup: not observable further (the run stays wedged by design) — the
  // process exits because nothing else holds the loop (agent promise is not a
  // handle).
});

test("a NON-abort (success) drain still waits without a bound for a slow un-awaited agent (audit2 #3)", async () => {
  // The success-path drain must not be grace-limited: the slow sibling's
  // result is still wanted (it journals when it completes).
  const script = `export const meta = { name: 'slow_drain', description: 'slow drain' }
const pending = agent('slow', { label: 'slow' })
return 'script-done'`;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = Date.now();
  const result = await runWorkflow<string>(script, {
    agent: {
      async run() {
        setTimeout(release, 150);
        await gate;
        return "slow-done";
      },
    },
    drainAbortGraceMs: 10, // even with a tiny grace, the success drain waits
    persistLogs: false,
  });
  assert.equal(result.result, "script-done");
  assert.ok(Date.now() - started >= 140, "the success drain waited out the slow sibling");
});

test("aborted drain finalizes reported terminal usage before flushing the returned totals", async () => {
  const controller = new AbortController();
  const totals: number[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'abandon_usage', description: 'usage' }
void agent('reported but hung')
return 'script-done'`,
    {
      agent: {
        async run(_prompt, options) {
          options?.onUsage?.({ input: 40, output: 2, total: 42, cost: 0, cacheRead: 0, cacheWrite: 0 });
          return new Promise(() => {});
        },
      },
      signal: controller.signal,
      drainAbortGraceMs: 5,
      persistLogs: false,
      onLog: (message) => {
        if (message.includes("outstanding agent()")) controller.abort();
      },
      onTokenUsage: (usage) => totals.push(usage.total),
    },
  );
  assert.equal(result.tokenUsage?.total, 42);
  assert.deepEqual(totals, [42]);
});

test("runWorkflow's final onTokenUsage flush includes agents that settle during the drain (audit2 #5)", async () => {
  // The script returns while an un-awaited sibling is still running; the drain
  // waits it out, and the final flush must carry the sibling's spend.
  const script = `export const meta = { name: 'drain_flush', description: 'drain flush' }
const pending = agent('slow-sibling', { label: 'sibling' })
return 'script-done'`;
  const flushes: number[] = [];
  let releaseSibling!: () => void;
  const siblingGate = new Promise<void>((resolve) => (releaseSibling = resolve));
  let calls = 0;
  const result = await runWorkflow<string>(script, {
    agent: {
      async run(prompt: string) {
        calls++;
        if (prompt === "slow-sibling") {
          setTimeout(releaseSibling, 30);
          await siblingGate;
        }
        return "done";
      },
    },
    onAgentUsage: () => {},
    onTokenUsage: (usage) => flushes.push(usage.total),
    persistLogs: false,
  });
  assert.equal(result.result, "script-done");
  assert.equal(calls, 1, "the sibling ran exactly once");
  assert.equal(flushes.length, 1, "exactly one final flush");
  assert.ok(flushes[0] > 0, "the drain-settled sibling's usage is in the final flush");
  assert.equal(flushes[0], result.tokenUsage?.total, "the flush IS the final total (no partial/double accounting)");
});

test("runWorkflow initialTokenUsage keeps a resumed run's reported totals cumulative", async () => {
  // Replayed calls commit no usage, so resume() seeds the persisted
  // total-at-pause; both the returned totals and the final flush include it.
  const flushes: number[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'seeded_usage', description: 'seeded usage' }
return await agent('live', { label: 'live' })`,
    {
      agent: fakeAgent({ input: 8, output: 2, total: 10, cost: 0.01 }),
      persistLogs: false,
      initialTokenUsage: { input: 50, output: 10, total: 60, cost: 0.06, cacheRead: 0, cacheWrite: 0 },
      onTokenUsage: (usage) => flushes.push(usage.total),
    },
  );
  assert.equal(result.tokenUsage?.total, 70);
  assert.deepEqual(flushes, [70]);
});
