import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

// These control-helper scripts never call agent(); the stub replaces the default WorkflowAgent.
const yesAgent = {
  async run() {
    return "ok";
  },
};

test("loopUntilDry(): dedupes by key and stops after K empty rounds", async () => {
  const script = `export const meta = { name: 'l', description: 'loop' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return [1, 2]
    if (r === 1) return [2, 3]
    return []
  },
  consecutiveEmpty: 2,
})
return out`;
  const res = await runWorkflow<number[]>(script, { agent: yesAgent, persistLogs: false });
  assert.deepEqual([...res.result], [1, 2, 3], "deduped union across rounds");
});

test("loopUntilDry(): returns partial results when a round hits the budget", async () => {
  const script = `export const meta = { name: 'lp', description: 'loop partial' }
const out = await loopUntilDry({
  round: (r) => {
    if (r === 0) return [1]
    throw { code: 'TOKEN_BUDGET_EXHAUSTED' }
  },
})
return out`;
  const res = await runWorkflow<number[]>(script, { agent: yesAgent, persistLogs: false });
  assert.deepEqual([...res.result], [1], "partial result returned, not an abort");
});

test("loopUntilDry(): returns indistinguishable partial data for capacity exhaustion", async () => {
  for (const code of ["TOKEN_BUDGET_EXHAUSTED", "AGENT_LIMIT_EXCEEDED"]) {
    const script = `export const meta = { name: 'loop_capacity', description: 'partial capacity result' }
return await loopUntilDry({
  round: (index) => {
    if (index === 0) return [{ id: 'alpha' }]
    throw { code: '${code}' }
  },
  maxRounds: 4,
})`;
    const res = await runWorkflow<Array<{ id: string }>>(script, { agent: yesAgent, persistLogs: false });
    assert.deepEqual(
      Array.from(res.result, ({ id }) => ({ id })),
      [{ id: "alpha" }],
    );
  }

  await assert.rejects(() =>
    runWorkflow(
      `export const meta = { name: 'loop_error', description: 'unrelated errors escape' }
return await loopUntilDry({ round: () => { throw new Error('author bug') } })`,
      { agent: yesAgent, persistLogs: false },
    ),
  );
});

test("retry(): stops when until() is satisfied, else returns the last after exhausting", async () => {
  const script = `export const meta = { name: 'r', description: 'retry' }
let n = 0
const ok = await retry(() => { n++; return n }, { until: (r) => r >= 2, attempts: 5 })
let m = 0
const ex = await retry(() => { m++; return m }, { until: (r) => r > 99, attempts: 3 })
return { ok, n, ex, m }`;
  const res = await runWorkflow<{ ok: number; n: number; ex: number; m: number }>(script, {
    agent: yesAgent,
    persistLogs: false,
  });
  assert.equal(res.result.ok, 2, "stopped as soon as until() held");
  assert.equal(res.result.n, 2);
  assert.equal(res.result.ex, 3, "returned the last result after exhausting attempts");
  assert.equal(res.result.m, 3);
});

test("retry(): uses zero-based attempts, accepts immediately without until, and does not await until", async () => {
  const script = `export const meta = { name: 'retry_contract', description: 'exact retry contract' }
const omittedSeen = []
const omitted = await retry((attempt) => { omittedSeen.push(attempt); return attempt }, { attempts: 3 })
const syncSeen = []
const sync = await retry((attempt) => { syncSeen.push(attempt); return attempt }, { attempts: 3, until: value => value === 1 })
const asyncSeen = []
const asyncPredicate = await retry((attempt) => { asyncSeen.push(attempt); return attempt }, { attempts: 3, until: async () => false })
return { omitted, omittedSeen, sync, syncSeen, asyncPredicate, asyncSeen }`;
  const res = await runWorkflow<{
    omitted: number;
    omittedSeen: number[];
    sync: number;
    syncSeen: number[];
    asyncPredicate: number;
    asyncSeen: number[];
  }>(script, { agent: yesAgent, persistLogs: false });

  assert.equal(res.result.omitted, 0);
  assert.deepEqual([...res.result.omittedSeen], [0]);
  assert.equal(res.result.sync, 1);
  assert.deepEqual([...res.result.syncSeen], [0, 1]);
  assert.equal(res.result.asyncPredicate, 0, "a Promise is truthy because until is synchronous");
  assert.deepEqual([...res.result.asyncSeen], [0]);
});

test("gate(): passes the validator and feeds feedback into the next attempt", async () => {
  const script = `export const meta = { name: 'g', description: 'gate' }
const seen = []
const res = await gate(
  (feedback, i) => { seen.push(feedback ?? 'none'); return i },
  (r) => (r >= 1 ? { ok: true } : { ok: false, feedback: 'try higher' }),
  { attempts: 3 },
)
const legacyTruthy = await gate(() => 'legacy', () => ({ ok: 1 }), { attempts: 2 })
return { ok: res.ok, value: res.value, attempts: res.attempts, seen, legacyTruthy }`;
  const res = await runWorkflow<{
    ok: boolean;
    value: number;
    attempts: number;
    seen: string[];
    legacyTruthy: { ok: boolean; value: string; attempts: number };
  }>(script, {
    agent: yesAgent,
    persistLogs: false,
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.value, 1);
  assert.equal(res.result.attempts, 2);
  assert.deepEqual([...res.result.seen], ["none", "try higher"], "validator feedback is fed into the next attempt");
  assert.deepEqual(
    { ...res.result.legacyTruthy },
    { ok: true, value: "legacy", attempts: 1 },
    "legacy truthy validator verdicts remain accepted",
  );
});
