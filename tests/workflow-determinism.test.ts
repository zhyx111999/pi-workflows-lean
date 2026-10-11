import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

interface Probe {
  err: string | null;
  val: unknown;
}

/** Evaluate `expr` inside a real workflow run; report its value or the message it threw. */
async function probe(expr: string): Promise<Probe> {
  const script = `export const meta = { name: 'det', description: 'determinism' }
let err = null, val = null
try { val = ${expr} } catch (e) { err = String((e && e.message) || e) }
await agent('noop', { label: 'x' })
return { err, val }`;
  const run = await runWorkflow<Probe>(script, { agent: noopAgent, persistLogs: false });
  return run.result;
}

async function assertBlocked(expr: string): Promise<void> {
  const { err, val } = await probe(expr);
  assert.match(err ?? "", /unavailable in a workflow/, `${expr} should throw, got ${String(val)}`);
}

async function assertValue(expr: string, expected: unknown): Promise<void> {
  const { err, val } = await probe(expr);
  assert.equal(err, null, `${expr} should not throw`);
  assert.deepEqual(val, expected, expr);
}

test("static check rejects literal Date.now / Math.random / new Date() before the run starts", async () => {
  for (const expr of ["Math.random()", "Date.now()", "new Date()"]) {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'lit', description: 'd' }\nconst v = ${expr}\nawait agent('x', { label: 'x' })\nreturn v`,
          { agent: noopAgent, persistLogs: false },
        ),
      /deterministic|unavailable/i,
      `${expr} literal should be rejected at parse time`,
    );
  }
});

test("a prompt that names a blocked API runs", async () => {
  const script = `export const meta = { name: 'prose', description: 'mentions Date.now()' }
// Math.random() and new Date() are only mentioned here.
return await agent('Explain why Math.random is unsafe and Date.now() breaks resume', { label: 'x' })`;
  const run = await runWorkflow(script, { agent: noopAgent, persistLogs: false });
  assert.equal(run.result, "ok");
});

test("runtime guard blocks computed and aliased access the static check does not see", async () => {
  await assertBlocked('Math["random"]()');
  await assertBlocked('Date["now"]()');
  await assertBlocked("(() => { const D = Date; return new D(); })()");
  await assertBlocked("(() => { const now = Date.now; return now(); })()");
  await assertBlocked("globalThis.Date()");
});

test("runtime guard: a Date instance's constructor is the guarded Date", async () => {
  await assertValue("new Date(0).constructor === Date", true);
  await assertBlocked("new (new Date(0).constructor)()");
  await assertBlocked("Object.getPrototypeOf(new Date(0)).constructor.now()");
  await assertValue("new (new Date(0).constructor)(7).getTime()", 7);
});

test("runtime guard: Date subclasses keep their own prototype and the no-argument guard", async () => {
  await assertValue("(() => { class Day extends Date {} return new Day(0) instanceof Day })()", true);
  await assertBlocked("(() => { class Day extends Date {} return new Day() })()");
});

test("runtime guard: Intl date formatting without a date is unavailable", async () => {
  await assertBlocked("new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format()");
  await assertBlocked("new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(undefined)");
  await assertBlocked("Intl.DateTimeFormat('en-US', { year: 'numeric' }).format()");
  await assertBlocked("new Intl.DateTimeFormat('en-US').formatToParts()");
  await assertBlocked("(() => { const format = new Intl.DateTimeFormat('en-US').format; return format(); })()");
});

test("runtime guard: Intl date formatting with an explicit date still works", async () => {
  const utc = "new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' })";
  await assertValue(`${utc}.format(new Date(0))`, "1/1/1970");
  await assertValue(`${utc}.format(0)`, "1/1/1970");
  await assertValue(`${utc}.formatToParts(0).map((part) => part.value).join('')`, "1/1/1970");
  await assertValue(`[0, 86400000].map(${utc}.format).join(' ')`, "1/1/1970 1/2/1970");
  await assertValue(`${utc}.formatRange(0, 86400000).endsWith('1/2/1970')`, true);
  await assertValue("new Date(0).toLocaleDateString('en-US', { timeZone: 'UTC' })", "1/1/1970");
});

test("runtime determinism: new Date(arg) and Math.max still work", async () => {
  await assertValue("new Date(0).getTime()", 0);
  await assertValue("Date.UTC(1970, 0, 2)", 86400000);
  await assertValue("Date.parse('1970-01-02T00:00:00Z')", 86400000);
  await assertValue("Math.max(1, 2, 3)", 3);
});

test("vm-realm builtins work and the constructor escape hits the neutered Date.now", async () => {
  const script = `export const meta = { name: 'vm', description: 'vm realm' }
let escaped = null
try { escaped = ({}).constructor.constructor('return Date.now()')() } catch (e) { escaped = 'blocked:' + String((e && e.message) || e) }
const arr = [1, 2, 3].map((x) => x * 2)
const j = JSON.stringify({ a: 1 })
const s = [...new Set([1, 1, 2])]
await agent('noop', { label: 'x' })
return { escaped, arr, j, s }`;
  const r = await runWorkflow<{ escaped: string; arr: number[]; j: string; s: number[] }>(script, {
    agent: noopAgent,
    persistLogs: false,
  });
  // Spread to a host array: vm-realm arrays don't deepStrictEqual host literals.
  assert.deepEqual([...r.result.arr], [2, 4, 6], "vm Array.map works");
  assert.equal(r.result.j, '{"a":1}', "vm JSON works");
  assert.deepEqual([...r.result.s], [1, 2], "vm Set works");
  // ({}).constructor.constructor is the vm Function; its code runs in the vm realm
  // where Date.now is neutered, so the call is blocked.
  assert.match(r.result.escaped, /blocked/, "constructor escape via vm objects is closed");
});
