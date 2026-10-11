import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow } from "../src/workflow.js";

const echoAgent = {
  async run(prompt: string) {
    return `ran:${prompt}`;
  },
};

test("stack traces point at the script's own line numbers", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const script = [
      "export const meta = {",
      "  name: 'lines',",
      "  description: 'line numbers',",
      "}",
      "await agent('first')",
      "const value = null",
      "value.missing",
    ].join(newline);
    await assert.rejects(runWorkflow(script, { agent: echoAgent, persistLogs: false }), (error: Error) => {
      assert.match(String(error.stack), /lines\.js:7:7/);
      return true;
    });
  }
});

test("the script body runs in strict mode with the determinism prelude applied", async () => {
  const result = await runWorkflow<{ sloppyAssignment: string; random: string }>(
    `export const meta = { name: 'strict', description: 'strict mode' }
const attempt = (fn) => { try { fn(); return 'none' } catch (e) { return e.name } }
return { sloppyAssignment: attempt(() => { undeclaredGlobal = 1 }), random: attempt(() => Math['random']()) }`,
    { agent: echoAgent, persistLogs: false },
  );
  assert.equal(result.result.sloppyAssignment, "ReferenceError");
  assert.equal(result.result.random, "Error");
});
