import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowErrorCode } from "../src/errors.js";
import { createLoopGuard, guardLoops, LOOP_GUARD_NAME } from "../src/runtime/loop-guard.js";
import { readMetaExport } from "../src/runtime/script-meta.js";
import { runWorkflow } from "../src/workflow.js";

const META = "export const meta = { name: 'loops', description: 'loop guard' }\n";
const guarded = (body: string) => {
  const script = META + body;
  return guardLoops(script, readMetaExport(script).program).slice(META.length);
};

test("every loop body starts with the guard, without moving any line", () => {
  const body = [
    "while (a) { step() }",
    "for (;;) i++",
    "do x(); while (b)",
    "for (const k in o) for (const v of k) use(v)",
    "label: for (let i = 0; i < 3; i++) continue label",
  ].join("\n");
  const call = `${LOOP_GUARD_NAME}();`;
  assert.equal(
    guarded(body),
    [
      `while (a) {${call} step() }`,
      `for (;;) {${call}i++}`,
      `do {${call}x();} while (b)`,
      `for (const k in o) {${call}for (const v of k) {${call}use(v)}}`,
      `label: for (let i = 0; i < 3; i++) {${call}continue label}`,
    ].join("\n"),
  );
});

test("the guard ends a script that keeps the thread past its budget, and stays tripped", () => {
  let now = 0;
  const realNow = Date.now;
  Date.now = () => now;
  const guard = createLoopGuard(() => {}, 1000);
  try {
    now = 900;
    assert.doesNotThrow(() => guard.check());
    now = 1001;
    assert.throws(
      () => guard.check(),
      (error: { code?: string }) => error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    );
    now = 0;
    assert.throws(() => guard.check(), "a caught guard error does not reopen the loop");
    assert.match(guard.tripped()?.message ?? "", /without awaiting anything/);
  } finally {
    Date.now = realNow;
    guard.dispose();
  }
});

test("the guard ends the script once the run is stopped", () => {
  let stopped = false;
  const guard = createLoopGuard(() => {
    if (stopped) throw new Error("workflow aborted");
  });
  try {
    assert.doesNotThrow(() => guard.check());
    stopped = true;
    assert.throws(() => guard.check(), /workflow aborted/);
  } finally {
    guard.dispose();
  }
});

test("a script cannot name, shadow or replace its loop guard", async () => {
  for (const body of [`${LOOP_GUARD_NAME} = () => {}`, `const ${LOOP_GUARD_NAME} = () => {}`]) {
    await assert.rejects(
      runWorkflow(
        `${META}${body}
return 1`,
        { persistLogs: false, agent: { run: async () => "" } },
      ),
      (error: { code?: string; message?: string }) =>
        error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR && /reserved/.test(error.message ?? ""),
    );
  }
});

test("an endless loop that never yields fails the run instead of freezing Pi, even when the script catches", async () => {
  const started = Date.now();
  await assert.rejects(
    runWorkflow(`${META}try { while (true) {} } catch {}\nreturn 'escaped'`, {
      persistLogs: false,
      agent: { run: async () => "" },
    }),
    (error: { code?: string; message?: string }) =>
      error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR && /without awaiting anything/.test(error.message ?? ""),
  );
  assert.ok(Date.now() - started < 15_000, "the run ends near the budget");
});
