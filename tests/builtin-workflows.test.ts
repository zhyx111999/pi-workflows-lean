import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { generateDeepResearchWorkflow } from "../src/deep-research.js";
import { createWebTools } from "../src/web-tools.js";
import { parseWorkflowScript, runWorkflow } from "../src/workflow.js";

// ─── Deep Research ──────────────────────────────────────────────────────────────

test("generateDeepResearchWorkflow produces a valid, parseable script", () => {
  const { meta, body } = parseWorkflowScript(generateDeepResearchWorkflow());
  assert.equal(meta.name, "deep_research");
  assert.deepEqual(
    meta.phases?.map((p) => p.title),
    ["Queries", "Gather"],
  );
  assert.match(body, /return \{ question, queries, sources: allSources \}/, "returns raw sources to the parent");
  assert.match(body, /args && args\.question/);
  assert.match(body, /web_search/);
  assert.match(body, /web_fetch/);
});

test("generateDeepResearchWorkflow uses configurable angles", () => {
  assert.match(generateDeepResearchWorkflow(), /args\.angles/);
});

test("deep_research returns every gathered source to the parent and takes no filtering argument", async () => {
  // The parent model checks the sources; the script filters nothing, so it must
  // not accept or echo a support threshold that would suggest otherwise.
  const runner = {
    async run(prompt: string) {
      if (prompt.includes("planning web research")) return { queries: ["q1", "q2"] };
      const query = prompt.includes("Query: q1") ? "a" : "b";
      return { sources: [{ url: `https://${query}.example`, claims: [`only-${query}`] }] };
    },
  };
  const result = await runWorkflow(generateDeepResearchWorkflow(), {
    agent: runner as never,
    persistLogs: false,
    args: { question: "Q", angles: 2, minSupport: 3 },
  });
  const output = JSON.parse(JSON.stringify(result.result));
  assert.deepEqual(Object.keys(output), ["question", "queries", "sources"]);
  assert.deepEqual(output.sources, [
    { url: "https://a.example", claims: ["only-a"] },
    { url: "https://b.example", claims: ["only-b"] },
  ]);
});

test("workflow-patterns skill documents exactly the args the deep-research script reads", () => {
  const skill = readFileSync(join(import.meta.dirname, "../skills/workflow-patterns/SKILL.md"), "utf8");
  const row = skill.split("\n").find((line) => line.startsWith("| `deep-research` |")) ?? "";
  const shape = /`\{ ([^`]*) \}`/.exec(row)?.[1] ?? "";
  const documented = [...shape.matchAll(/(\w+)\??:/g)].map(([, name]) => name).sort();
  const read = [
    ...new Set([...generateDeepResearchWorkflow().matchAll(/args\.(\w+)/g)].map(([, name]) => name)),
  ].sort();
  assert.deepEqual(documented, ["angles", "question"]);
  assert.deepEqual(read, documented);
});

test("generateDeepResearchWorkflow guards the planner result before reading queries (#86)", () => {
  const body = generateDeepResearchWorkflow();
  assert.match(body, /Array\.isArray\(plan\.queries\)/);
  assert.match(body, /\[question\]/); // falls back to the question when the planner yields nothing
});

test("deep_research tolerates a null query planner and falls back to the question (#86)", async () => {
  // Regression for #86: the planner agent() can return null (e.g. a subagent that
  // died on a terminal provider error). The Queries phase must not crash on
  // plan.queries — it should fall back to the original question so research proceeds.
  const gatherPrompts: string[] = [];
  const runner = {
    async run(prompt: string) {
      if (prompt.includes("planning web research")) return null; // planner "failed"
      if (prompt.includes("Research this query")) {
        gatherPrompts.push(prompt);
        return { sources: [] };
      }
      return null; // the workflow has no other agent() prompts
    },
  };
  // Would reject (crash) before the fix; must resolve now.
  const result = await runWorkflow(generateDeepResearchWorkflow(), {
    agent: runner as never,
    persistLogs: false,
    args: { question: "What is WebGPU?", angles: 3 },
  });
  assert.ok(gatherPrompts.length >= 1, "Gather should still run using the fallback query");
  assert.ok(
    gatherPrompts.some((p) => p.includes("What is WebGPU?")),
    "the fallback query should be the original question",
  );
  // Value-compare (not deepEqual): the script runs in a vm realm, so its arrays
  // have the realm's Array prototype and fail a strict reference-equal check.
  const queries = (result.result as { queries?: string[] })?.queries;
  assert.equal(queries?.length, 1, "a null planner should fall back to exactly one query");
  assert.equal(queries?.[0], "What is WebGPU?", "the fallback query should be the original question");
});

// ─── Web Tools ──────────────────────────────────────────────────────────────────

test("createWebTools exposes web_search and web_fetch", () => {
  const tools = createWebTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["web_fetch", "web_search"]);
});
