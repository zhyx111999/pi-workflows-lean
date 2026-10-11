import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  DEEP_RESEARCH_DEFAULT_ANGLES,
  DEEP_RESEARCH_MAX_ANGLES,
  generateDeepResearchWorkflow,
} from "../src/deep-research.js";
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
  assert.match(body, /return \{ question, planning, results \}/, "returns the planning and per-query results");
  assert.match(body, /args\.question/);
  assert.match(body, /web_search/);
  assert.match(body, /web_fetch/);
});

test("generateDeepResearchWorkflow uses configurable angles", () => {
  assert.match(generateDeepResearchWorkflow(), /args\.angles/);
});

/** Run the deep-research script with a planner returning `queries` and a per-query gather stub. */
async function runDeepResearch(
  args: Record<string, unknown>,
  queries: string[],
  gather: (query: string) => unknown = () => ({ sources: [] }),
) {
  const prompts: string[] = [];
  const runner = {
    async run(prompt: string) {
      prompts.push(prompt);
      if (prompt.includes("planning web research")) return { queries };
      return gather(/Query: (.*)/.exec(prompt)?.[1] ?? "");
    },
  };
  const result = await runWorkflow(generateDeepResearchWorkflow(), {
    agent: runner as never,
    persistLogs: false,
    args,
  });
  // Round-trip through JSON: the script runs in a vm realm, whose objects fail
  // deepEqual's prototype check against this realm's literals.
  return { output: JSON.parse(JSON.stringify(result.result)), prompts };
}

test("deep_research returns every gathered source to the parent and takes no filtering argument", async () => {
  // The parent model checks the sources; the script filters nothing, so it must
  // not accept or echo a support threshold that would suggest otherwise.
  const { output } = await runDeepResearch({ question: "Q", angles: 2, minSupport: 3 }, ["q1", "q2"], (query) => {
    const host = query === "q1" ? "a" : "b";
    return { sources: [{ url: `https://${host}.example`, claims: [`only-${host}`] }] };
  });
  assert.deepEqual(output, {
    question: "Q",
    planning: { requestedAngles: 2, plannedQueries: 2, fellBackToQuestion: false },
    results: [
      { query: "q1", status: "ok", sources: [{ url: "https://a.example", claims: ["only-a"] }] },
      { query: "q2", status: "ok", sources: [{ url: "https://b.example", claims: ["only-b"] }] },
    ],
  });
});

test("deep_research keeps each query's outcome so a failed gather differs from one that found nothing", async () => {
  const { output } = await runDeepResearch({ question: "Q", angles: 3 }, ["dead", "empty", "found"], (query) => {
    if (query === "dead") return null; // what parallel() yields for a research agent that failed
    if (query === "empty") return { sources: [] };
    return { sources: [{ url: "https://found.example", claims: ["c"] }] };
  });
  assert.deepEqual(output.results, [
    { query: "dead", status: "failed" },
    { query: "empty", status: "ok", sources: [] },
    { query: "found", status: "ok", sources: [{ url: "https://found.example", claims: ["c"] }] },
  ]);
});

test("deep_research plans the default number of angles when args.angles is omitted or null", async () => {
  const planned = Array.from({ length: DEEP_RESEARCH_MAX_ANGLES }, (_, i) => `q${i + 1}`);
  for (const args of [{ question: "Q" }, { question: "Q", angles: null }]) {
    const { output, prompts } = await runDeepResearch(args, planned);
    assert.match(prompts[0], new RegExp(`Produce ${DEEP_RESEARCH_DEFAULT_ANGLES} diverse`));
    assert.equal(output.results.length, DEEP_RESEARCH_DEFAULT_ANGLES);
    assert.equal(
      JSON.stringify(output.planning),
      JSON.stringify({
        requestedAngles: DEEP_RESEARCH_DEFAULT_ANGLES,
        plannedQueries: DEEP_RESEARCH_DEFAULT_ANGLES,
        fellBackToQuestion: false,
      }),
    );
  }
});

test("workflow-patterns skill documents the deep-research result and angles bounds", () => {
  const skill = readFileSync(join(import.meta.dirname, "../skills/workflow-patterns/SKILL.md"), "utf8");
  assert.match(skill, new RegExp(`from 1 to ${DEEP_RESEARCH_MAX_ANGLES}, default ${DEEP_RESEARCH_DEFAULT_ANGLES}`));
  assert.match(skill, /`\{ question, planning, results \}`/);
  assert.match(skill, /`\{ requestedAngles, plannedQueries, fellBackToQuestion \}`/);
  assert.match(skill, /\{ query, status: "ok", sources: \[\{ url, claims \}\] \}/);
  assert.match(skill, /\{ query, status: "failed" \}/);
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

test("generateDeepResearchWorkflow guards the planner result before reading queries", () => {
  const body = generateDeepResearchWorkflow();
  assert.match(body, /Array\.isArray\(plan\.queries\)/);
  assert.match(body, /\[question\]/); // falls back to the question when the planner yields nothing
});

test("deep_research tolerates a null query planner and falls back to the question", async () => {
  // The planner agent() can return null (e.g. a subagent that
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
  const results = (result.result as { results?: Array<{ query: string; status: string }> })?.results;
  assert.equal(results?.length, 1, "a null planner should fall back to exactly one query");
  const planning = (result.result as { planning?: Record<string, unknown> })?.planning;
  assert.equal(
    JSON.stringify(planning),
    JSON.stringify({ requestedAngles: 3, plannedQueries: 1, fellBackToQuestion: true }),
  );
  assert.equal(results?.[0].query, "What is WebGPU?", "the fallback query should be the original question");
  assert.equal(results?.[0].status, "ok");
});

// ─── Web Tools ──────────────────────────────────────────────────────────────────

test("createWebTools exposes web_search and web_fetch", () => {
  const tools = createWebTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["web_fetch", "web_search"]);
});
