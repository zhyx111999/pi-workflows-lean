import assert from "node:assert/strict";
import test from "node:test";
import { CallSequence } from "../src/runtime/call-position.js";
import { type JournalEntry, runWorkflow, type WorkflowRunOptions } from "../src/workflow.js";

const NESTED = 2 ** 52;

test("call positions: the script body and a fan-out's first calls keep small dense indexes", () => {
  const script = CallSequence.forScript();
  assert.equal(script.takeIndex(), 0);
  const branches = script.fork(3);
  assert.deepEqual(
    branches.map((branch) => branch.takeIndex()),
    [1, 2, 3],
    "each branch's first call takes its branch's position",
  );
  const later = branches.map((branch) => branch.takeIndex());
  assert.ok(later.every((index) => Number.isSafeInteger(index) && index >= NESTED));
  assert.equal(new Set(later).size, later.length);
  script.join(branches);
  assert.equal(script.takeIndex(), 4 + 6, "the body moves past the six calls its branches made");
});

test("call positions: a branch's calls get the same indexes whatever order the branches make them in", () => {
  const indexes = (order: number[]) => {
    const branches = CallSequence.forScript().fork(2);
    const taken = new Map<string, number>();
    const made = [0, 0];
    for (const branch of order) taken.set(`${branch}.${made[branch]++}`, branches[branch].takeIndex());
    return taken;
  };
  assert.deepEqual(indexes([0, 1, 0, 1, 1]), indexes([1, 1, 1, 0, 0]));
});

test("call positions: a nested fan-out numbers its branches below the branch that started it", () => {
  const script = CallSequence.forScript();
  const [outer] = script.fork(1);
  const inner = outer.fork(2);
  const nested = inner.map((branch) => branch.takeIndex());
  assert.ok(nested.every((index) => index >= NESTED));
  outer.join(inner);
  assert.ok(outer.takeIndex() >= NESTED, "the outer branch's first call came after its nested fan-out");
  script.join([outer]);
  assert.equal(script.takeIndex(), 1 + 3, "nested calls count toward the outer fan-out");
});

/** A runner that records each prompt it runs and holds a prompt until its gate opens. */
function gatedRunner(gates: Record<string, Promise<void>> = {}) {
  const ran: string[] = [];
  const started = new Map<string, () => void>();
  const startedPromise = (prompt: string) => new Promise<void>((resolve) => started.set(prompt, resolve));
  return {
    ran,
    startedPromise,
    runner: {
      async run(prompt: string) {
        ran.push(prompt);
        started.get(prompt)?.();
        await gates[prompt];
        return `ran:${prompt}`;
      },
    },
  };
}

async function runAndJournal(script: string, options: Partial<WorkflowRunOptions> & Pick<WorkflowRunOptions, "agent">) {
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    persistLogs: false,
    runId: "call-position-run",
    onAgentJournal: (entry) => journal.push(entry),
    ...options,
  });
  return journal;
}

async function resume(script: string, journal: JournalEntry[]): Promise<string[]> {
  const { ran, runner } = gatedRunner();
  await runWorkflow(script, {
    agent: runner,
    persistLogs: false,
    runId: "call-position-run",
    resumeJournal: new Map(journal.map((entry) => [entry.index, entry])),
  });
  return ran;
}

const pipelineScript = (fastStage2 = "s2 fast") => `export const meta = { name: 'pipe', description: 'pipeline resume' }
const results = await pipeline(['slow', 'fast'],
  (item) => agent('s1 ' + item, { label: 's1 ' + item }),
  (prev, item) => agent(item === 'fast' ? '${fastStage2}' : 's2 ' + item, { label: 's2 ' + item }))
return await agent('summary ' + results.join(' | '), { label: 'summary' })`;

/** First run of pipelineScript where the fast item reaches stage 2 before the slow one finishes stage 1. */
async function firstPipelineRun() {
  let release!: () => void;
  const slowStage1 = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = gatedRunner({ "s1 slow": slowStage1 });
  void first.startedPromise("s2 fast").then(release);
  const journal = await runAndJournal(pipelineScript(), { agent: first.runner });
  assert.deepEqual(first.ran, ["s1 slow", "s1 fast", "s2 fast", "s2 slow", "summary ran:s2 slow | ran:s2 fast"]);
  return journal;
}

test("resume replays a pipeline's later stages whichever item reached them first", async () => {
  const journal = await firstPipelineRun();
  assert.deepEqual(await resume(pipelineScript(), journal), [], "every completed call replays");
});

test("resume replays the calls a parallel() branch makes after an await", async () => {
  const script = `export const meta = { name: 'par', description: 'parallel resume' }
const results = await parallel([
  async () => agent('a2 ' + await agent('a1', { label: 'a1' }), { label: 'a2' }),
  async () => agent('b2 ' + await agent('b1', { label: 'b1' }), { label: 'b2' }),
])
return results`;
  let release!: () => void;
  const a1 = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = gatedRunner({ a1 });
  void first.startedPromise("b2 ran:b1").then(release);
  const journal = await runAndJournal(script, { agent: first.runner });
  assert.deepEqual(first.ran, ["a1", "b1", "b2 ran:b1", "a2 ran:a1"]);

  assert.deepEqual(await resume(script, journal), []);
});

test("resume re-runs an edited branch call and every call made after it", async () => {
  const journal = await firstPipelineRun();
  // Replay runs the items in order: the slow item's stage 2 replays before the
  // edited call misses, and the summary after it runs live.
  assert.deepEqual(await resume(pipelineScript("s2 fast edited"), journal), [
    "s2 fast edited",
    "summary ran:s2 slow | ran:s2 fast edited",
  ]);
});

test("resume re-runs what follows a fan-out whose branch no longer makes a call", async () => {
  const script = (
    secondCall: string,
    onlyCall: string,
  ) => `export const meta = { name: 'drop', description: 'dropped call' }
await parallel([
  async () => { await agent('a1', { label: 'a1' }); ${secondCall} },
  async () => { ${onlyCall} },
])
return await agent('after', { label: 'after' })`;
  const original = script("await agent('a2', { label: 'a2' })", "await agent('b', { label: 'b' })");
  const journal = await runAndJournal(original, { agent: gatedRunner().runner });
  assert.equal(journal.length, 4);

  assert.deepEqual(await resume(original, journal), []);
  assert.deepEqual(
    await resume(script("", "await agent('b', { label: 'b' })"), journal),
    ["after"],
    "a dropped later call in a branch",
  );
  assert.deepEqual(
    await resume(script("await agent('a2', { label: 'a2' })", ""), journal),
    ["after"],
    "a branch that dropped its only call",
  );
});
