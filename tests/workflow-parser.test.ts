import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { parseWorkflowScript } from "../src/workflow.js";

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  model: 'provider/default-model',
  phases: [{ title: 'Scan', detail: 'Collect inputs', model: 'default' }]
}

phase('Scan')
return { ok: true }
`;

test("parseWorkflowScript accepts literal workflow metadata", () => {
  const parsed = parseWorkflowScript(validScript);
  assert.equal(parsed.meta.name, "demo_workflow");
  assert.equal(parsed.meta.description, "A useful workflow");
  assert.deepEqual(parsed.meta.phases, [{ title: "Scan", detail: "Collect inputs", model: "default" }]);
  assert.match(parsed.body, /phase\('Scan'\)/);
  assert.doesNotMatch(parsed.body, /export const meta/);
});

test("parseWorkflowScript accepts static template literals", () => {
  const parsed = parseWorkflowScript("export const meta = { name: `demo`, description: `static` }\nreturn true");
  assert.equal(parsed.meta.name, "demo");
  assert.equal(parsed.meta.description, "static");
});

test("parseWorkflowScript requires meta export first", () => {
  assert.throws(
    () => parseWorkflowScript("const x = 1\nexport const meta = { name: 'demo', description: 'desc' }"),
    /must be the first statement/,
  );
});

test("parseWorkflowScript requires name and description", () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: 'demo' }"), /meta.description/);
  assert.throws(() => parseWorkflowScript("export const meta = { description: 'desc' }"), /meta.name/);
});

test("parseWorkflowScript rejects non-literal metadata", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: makeName(), description: 'desc' }"),
    /non-literal node type.*CallExpression/,
  );
  assert.throws(
    () => parseWorkflowScript("const name = 'demo'; export const meta = { name, description: 'desc' }"),
    /must be the first statement/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: name, description: 'desc' }"),
    /non-literal node type.*Identifier/,
  );
});

test("parseWorkflowScript rejects object hazards", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { ...base, name: 'demo', description: 'desc' }"),
    /spread not allowed/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { ['name']: 'demo', description: 'desc' }"),
    /computed keys not allowed/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { __proto__: {}, name: 'demo', description: 'desc' }"),
    /reserved key name/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { get name() { return 'demo' }, description: 'desc' }"),
    /methods\/accessors not allowed/,
  );
});

test("parseWorkflowScript rejects array hazards", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [,,] }"),
    /sparse arrays not allowed/,
  );
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [...items] }"),
    /spread not allowed/,
  );
});

test("parseWorkflowScript rejects template interpolation", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: `demo_$" + "{id}`, description: 'desc' }"),
    /template interpolation not allowed/,
  );
});

// ─── Negative / error-path tests ───────────────────────────────────────────────

test("parseWorkflowScript rejects empty string", () => {
  assert.throws(() => parseWorkflowScript(""), /must be the first statement/);
});

test("parseWorkflowScript rejects whitespace-only string", () => {
  assert.throws(() => parseWorkflowScript("   "), /must be the first statement/);
});

test("parseWorkflowScript rejects script without meta export", () => {
  assert.throws(() => parseWorkflowScript("return 42"), /must be the first statement/);
});

test("parseWorkflowScript rejects meta without const keyword", () => {
  assert.throws(
    () => parseWorkflowScript("export var meta = { name: 'demo', description: 'desc' }"),
    /must be `export const meta/,
  );
});

test("parseWorkflowScript rejects meta with wrong variable name", () => {
  assert.throws(
    () => parseWorkflowScript("export const x = { name: 'demo', description: 'desc' }"),
    /must declare `meta`/,
  );
});

test("parseWorkflowScript rejects multiple declarations", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }, x = 1"),
    /must declare only/,
  );
});

test("parseWorkflowScript rejects meta without init value", () => {
  assert.throws(() => parseWorkflowScript("export const meta"), /not valid JavaScript: Unexpected token \(1:17\)/);
});

test("parseWorkflowScript rejects empty name string", () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: '', description: 'desc' }"), /non-empty string/);
});

test("parseWorkflowScript rejects empty description string", () => {
  assert.throws(() => parseWorkflowScript("export const meta = { name: 'demo', description: '' }"), /non-empty string/);
});

test("parseWorkflowScript rejects phases that is not an array", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: 'scalar' }"),
    /must be an array/,
  );
});

test("parseWorkflowScript rejects phases without title", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [{ detail: 'x' }] }"),
    /must have a title string/,
  );
});

test("parseWorkflowScript rejects meta.model with wrong type", () => {
  assert.throws(
    () => parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', model: 123 }"),
    /must be a string/,
  );
});

test("parseWorkflowScript still parses a removed/unknown meta field (e.g. whenToUse)", () => {
  // whenToUse is no longer an official field; a script that still sets it must keep
  // parsing (it's just ignored), not throw.
  const parsed = parseWorkflowScript(
    "export const meta = { name: 'demo', description: 'desc', whenToUse: 'legacy' }\nreturn 1",
  );
  assert.equal(parsed.meta.name, "demo");
});

const META = "export const meta = { name: 'demo', description: 'desc' }\n";

const isScriptValidationError = (error: unknown) =>
  error instanceof WorkflowError &&
  error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
  error.recoverable === false;

test("parseWorkflowScript rejects every visible nondeterministic call with its line", () => {
  const calls = [
    ["return Date.now()", "Date.now()"],
    ["return Math.random()", "Math.random()"],
    ["return new Date()", "new Date()"],
    ["return new Date", "new Date()"],
    ["return Date()", "Date()"],
    ["return Date(0)", "Date()"],
    ["return Date?.now()", "Date.now()"],
    ["return Math.random?.()", "Math.random()"],
    ["const pick = (items) => items[Math.floor(Math.random() * items.length)]", "Math.random()"],
    ["return `at $" + "{Date.now()}`", "Date.now()"],
  ];
  for (const [body, call] of calls) {
    assert.throws(
      () => parseWorkflowScript(`${META}${body}`),
      (error: unknown) =>
        isScriptValidationError(error) &&
        /must be deterministic/.test((error as Error).message) &&
        (error as Error).message.includes(`${call} (line 2)`),
      body,
    );
  }
});

test("parseWorkflowScript names every nondeterministic call in source order", () => {
  assert.throws(
    () => parseWorkflowScript(`${META}const a = Math.random()\nconst b = Date.now()\nreturn [a, b]`),
    /Math\.random\(\) \(line 2\), Date\.now\(\) \(line 3\)/,
  );
});

test("parseWorkflowScript ignores blocked names in strings, comments, and regexes", () => {
  const script = `export const meta = { name: 'demo', description: 'never calls Date.now()' }
// Date.now(), Math.random() and new Date() are unavailable in a workflow.
/* new Date() */
const prompt = 'Explain why Math.random is unsafe and new Date() breaks resume'
const note = \`Date.now() is passed via args\`
const pattern = /Date\\.now\\(\\)/
return agent(prompt + note + String(pattern))`;
  assert.doesNotThrow(() => parseWorkflowScript(script));
});

test("parseWorkflowScript allows deterministic Date and Math use", () => {
  for (const body of [
    "return new Date(0)",
    "return new Date(args.startedAt).toISOString()",
    "return Date.UTC(2026, 0, 1)",
    "return Date.parse('2026-01-01T00:00:00Z')",
    "return Math.max(1, 2)",
    "return typeof Date.now",
    "return typeof Math.random",
  ]) {
    assert.doesNotThrow(() => parseWorkflowScript(`${META}${body}`), body);
  }
});

test("parseWorkflowScript reports every script problem as a non-recoverable validation error", () => {
  for (const script of [
    "return 42",
    "export const x = { name: 'demo', description: 'desc' }",
    "export const meta = { name: makeName(), description: 'desc' }",
    "export const meta = { ...base, name: 'demo', description: 'desc' }",
    "export const meta = { ['name']: 'demo', description: 'desc' }",
    "export const meta = { name: 'demo', description: 'desc', phases: [,,] }",
    "export const meta = { name: `demo_$" + "{id}`, description: 'desc' }",
    "export const meta = { name: -name, description: 'desc' }",
    "export const meta = { name: '', description: 'desc' }",
    "export const meta = { name: 'demo', description: 'desc', phases: 'scalar' }",
    "export const meta = { name: 'demo', description: 'desc', model: 123 }",
    "export const meta",
    `${META}return (`,
    `${META}return Date.now()`,
  ]) {
    assert.throws(() => parseWorkflowScript(script), isScriptValidationError, script);
  }
});
