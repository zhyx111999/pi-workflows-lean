import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import { CapabilityClassification } from "../src/enums.js";
import { runWorkflow } from "../src/workflow.js";
import {
  CAPABILITY_TABLE_PUBLICATION_PATHS,
  checkWorkflowCapabilityPublications,
  renderSupportedCapabilityTable,
  renderWorkflowCapabilityDetails,
  renderWorkflowCapabilityReference,
} from "../src/workflow-authoring-reference.js";
import { WORKFLOW_CAPABILITY_CONTRACT } from "../src/workflow-capability-contract.js";
import { measuredTools, permanentToolPromptLines } from "../src/workflow-context-measurement.js";

const ROOT = join(import.meta.dirname, "..");
const SKILL_ROOT = "skills/workflow-authoring";
const SKILL_PATH = `${SKILL_ROOT}/SKILL.md`;
// Markdown links, including same-file `(#anchor)` links: group 1 is the path, group 2 the anchor.
const MARKDOWN_LINK = /\[[^\]]+\]\(([^)#]*)(?:#([^)]+))?\)/g;

/** Every file in the skill as a package-relative POSIX path. */
function skillFiles(): string[] {
  return readdirSync(join(ROOT, SKILL_ROOT), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

function skillMarkdown(): Array<{ path: string; source: string }> {
  return skillFiles()
    .filter((path) => path.endsWith(".md"))
    .map((path) => ({ path, source: readFileSync(join(ROOT, path), "utf8") }));
}

function hasAnchor(markdown: string, anchor: string): boolean {
  if (markdown.includes(`<a id="${anchor}"></a>`)) return true;
  return markdown
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6} /, "")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/ +/g, "-"),
    )
    .includes(anchor);
}

function requiredSchemaFields(schema?: Record<string, unknown>): unknown[] {
  return Array.isArray(schema?.required) ? Array.from(schema.required) : [];
}

test("workflow-authoring skill links resolve and every skill file is reachable from SKILL.md", () => {
  // workflow-patterns (argument shapes for the built-in workflows reachable by
  // the `subagents` tool's `name` input) and subagents-setup (configuration
  // files) are separate, smaller skills.
  assert.deepEqual(packageJson.pi.skills, [SKILL_ROOT, "skills/workflow-patterns", "skills/subagents-setup"]);
  const versionLine = new RegExp(`^  version: ["']?${packageJson.version.replaceAll(".", "\\.")}["']?$`, "m");
  for (const root of packageJson.pi.skills) {
    const source = readFileSync(join(ROOT, root, "SKILL.md"), "utf8");
    assert.match(source, versionLine, `${root}/SKILL.md metadata version must match package.json`);
  }

  const skill = readFileSync(join(ROOT, SKILL_PATH), "utf8");
  const description = /^description:\s*(.+)$/m.exec(skill)?.[1] ?? "";
  for (const trigger of ["writing", "editing", "reviewing", "debugging"]) {
    assert.match(description, new RegExp(`\\b${trigger}\\b`, "i"));
  }
  assert.match(description, /not (?:for )?(?:merely )?running an existing workflow/i);
  assert.ok(skill.split("\n").length <= 80, "SKILL.md should remain a short progressive-disclosure router");

  // Walk links from SKILL.md: every link must resolve inside the skill, and no
  // skill file may be orphaned, because a model can only find what is linked.
  const files = new Set(skillFiles());
  const reachable = new Set([SKILL_PATH]);
  const pending = [SKILL_PATH];
  for (let sourcePath = pending.pop(); sourcePath !== undefined; sourcePath = pending.pop()) {
    if (!sourcePath.endsWith(".md")) continue;
    const source = readFileSync(join(ROOT, sourcePath), "utf8");
    for (const [, linkPath, anchor] of source.matchAll(MARKDOWN_LINK)) {
      const target = linkPath ? posix.normalize(posix.join(posix.dirname(sourcePath), linkPath)) : sourcePath;
      assert.ok(files.has(target), `${sourcePath} links to ${target}, which is not a file in the skill`);
      if (anchor) {
        assert.ok(
          hasAnchor(readFileSync(join(ROOT, target), "utf8"), anchor),
          `${sourcePath} links to missing anchor ${target}#${anchor}`,
        );
      }
      if (!reachable.has(target)) {
        reachable.add(target);
        pending.push(target);
      }
    }
  }
  assert.deepEqual([...reachable].sort(), [...files], "every skill file must be reachable from SKILL.md");
});

test("skill guidance calls only functions the workflow runtime injects", () => {
  const runtimeGlobals = new Set(
    WORKFLOW_CAPABILITY_CONTRACT.definition.capabilities.flatMap(({ classification, runtimeBinding }) =>
      classification === CapabilityClassification.RUNTIME_GLOBAL && runtimeBinding ? [runtimeBinding.global] : [],
    ),
  );
  // Call-shaped names in the guidance that are not runtime globals, and why each is legitimate.
  const notGlobals = new Set([
    "cwd", // process.cwd()
    "resume", // host WorkflowManager.resume() in the durable checkpoint handoff
    "attempt", // prose "attempt(s)"
    "require", // named as unavailable
    "Date", // `new Date()`, named as unavailable
  ]);
  for (const { path, source } of skillMarkdown()) {
    for (const [, name] of source.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\(/g)) {
      assert.ok(
        runtimeGlobals.has(name) || notGlobals.has(name),
        `${path} teaches ${name}(), which the workflow runtime does not provide`,
      );
    }
  }
  for (const removed of [
    "verify",
    "judgePanel",
    "completenessCheck",
    "retry",
    "gate",
    "loopUntilDry",
    "workflow",
    "budget",
  ]) {
    assert.equal(runtimeGlobals.has(removed), false, `${removed} must stay removed from the runtime contract`);
  }
});

test("skill guidance does not require an agent() call, matching a runtime that accepts agent-free scripts", async () => {
  const run = await runWorkflow(
    "export const meta = { name: 'no_agents', description: 'returns data only' }\nreturn { ok: true }",
    { agent: { run: async () => assert.fail("no agent may run") }, persistLogs: false },
  );
  assert.equal(run.agentCount, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(run.result)), { ok: true });
  for (const { path, source } of skillMarkdown()) {
    assert.doesNotMatch(source, /at least (once|one agent)/i, `${path} states a rule the runtime never enforces`);
  }
});

test("always-read skill guidance preserves identity and payload across downstream agent calls", () => {
  const skill = readFileSync(join(ROOT, SKILL_ROOT, "SKILL.md"), "utf8");

  assert.match(
    skill,
    /when one agent consumes another's selected result, include both its stable ID and actual data in the downstream prompt/i,
  );
});

test("one generated supported-capability table is fresh across skill, README, and website docs", () => {
  assert.deepEqual(CAPABILITY_TABLE_PUBLICATION_PATHS, [
    "skills/workflow-authoring/references/capabilities.md",
    "README.md",
    "docs/workflow-authoring.md",
  ]);
  assert.deepEqual(checkWorkflowCapabilityPublications(ROOT), []);

  const generatedTable = renderSupportedCapabilityTable();
  for (const path of CAPABILITY_TABLE_PUBLICATION_PATHS) {
    const publication = readFileSync(join(ROOT, path), "utf8");
    assert.equal(publication.split(generatedTable).length - 1, 1, `${path} must reuse the exact generated table once`);
  }
  assert.match(generatedTable, /agent\(prompt, options\?\)/);
  assert.match(generatedTable, /label.*string.*optional.*derived from phase and call count/i);
  assert.doesNotMatch(generatedTable, /\| background \|/, "ignored compatibility inputs stay out of the table");
  assert.match(
    readFileSync(join(ROOT, "README.md"), "utf8"),
    /\[workflow authoring guide\]\(docs\/workflow-authoring\.md\)/,
  );
  assert.match(readFileSync(join(ROOT, "docs/workflow-authoring.md"), "utf8"), /^## Supported capabilities$/m);
  assert.doesNotMatch(generatedTable, /console|VM realm|compatibility-behavior|internal-substrate/);
  assert.doesNotMatch(generatedTable, /openai|gpt-|agentType catalogue|model route entries/i);

  const installedReference = renderWorkflowCapabilityDetails();
  for (const expectedMetadata of [
    "Dynamic reference owner: `model-tier-config`",
    "Item shape: `{ name: string; description?: string }`",
    "Live lookup: `loadModelTierConfig`",
    "Dynamic reference owner: `agent-registry`",
    "Live lookup: `loadAgentRegistry`",
  ]) {
    assert.match(installedReference, new RegExp(expectedMetadata.replace(/[{}?]/g, "\\$&")));
  }
  assert.doesNotMatch(installedReference, /Dynamic reference.*items:/i);

  const stale = checkWorkflowCapabilityPublications(ROOT, {
    "README.md": readFileSync(join(ROOT, "README.md"), "utf8").replace("| agent |", "| stale-agent |"),
    "docs/workflow-authoring.md": "missing generated anchors",
  });
  assert.deepEqual(stale, ["README.md", "docs/workflow-authoring.md"]);
});

test("generated capability index and exhaustive details are fresh and absent from permanent context surfaces", () => {
  const index = readFileSync(join(ROOT, SKILL_ROOT, "references/capabilities.md"), "utf8");
  const details = readFileSync(join(ROOT, SKILL_ROOT, "references/capability-details.md"), "utf8");
  assert.equal(index, renderWorkflowCapabilityReference());
  assert.equal(details, renderWorkflowCapabilityDetails());
  assert.equal(index.split(renderSupportedCapabilityTable()).length - 1, 1);
  assert.match(index, /exhaustive generated facts.*capability-details\.md/i);
  assert.doesNotMatch(index, /<a id="agent"><\/a>/);
  assert.match(details, /<a id="agent"><\/a>/);
  assert.doesNotMatch(details, /BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES/);
  assert.ok(Buffer.byteLength(index, "utf8") < Buffer.byteLength(details, "utf8"));
  for (const fact of WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts()) {
    assert.equal(fact.reference?.split("#")[0], `${SKILL_ROOT}/references/capability-details.md`);
  }

  const tools = measuredTools();
  const permanentPrompt = permanentToolPromptLines(tools).join("\n");
  const providerVisibleDefinitions = JSON.stringify(
    tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  );
  for (const surface of [permanentPrompt, providerVisibleDefinitions]) {
    assert.doesNotMatch(surface, /generated from WORKFLOW_CAPABILITY_CONTRACT/i);
    assert.doesNotMatch(surface, /Workflow capability reference|Supported capability index/i);
    assert.doesNotMatch(surface, /skills\/workflow-authoring|references\/capabilities\.md/i);
  }
});

test("generated facts cover the lifecycle constraints taught by the skill", () => {
  const facts = new Map(WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts().map((fact) => [fact.id, fact]));
  const exactFacts = [
    "workflow.runtime.agent",
    "workflow.runtime.checkpoint",
    "workflow.script.return-value",
    "workflow.script.determinism",
  ]
    .flatMap((id) => {
      const fact = facts.get(id);
      return fact ? [fact.signature ?? "", ...fact.constraints] : [];
    })
    .join(" ");

  for (const requiredFact of [
    /recoverable failures return null/i,
    /selector priority/i,
    /longest unchanged prefix/i,
    /consumes one agent slot and no tokens/i,
    /JSON-serializable/i,
    /Date\.now\(\).*Math\.random\(\)/i,
  ]) {
    assert.match(exactFacts, requiredFact);
  }
});

test("generated facts and skill references agree on result and failure contracts", () => {
  const facts = new Map(WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts().map((fact) => [fact.id, fact]));
  const pipeline = facts.get("workflow.runtime.pipeline");
  const agent = facts.get("workflow.runtime.agent");
  const checkpoint = facts.get("workflow.runtime.checkpoint");
  const tasks = facts.get("workflow.subagents-input.tasks");
  const metadata = facts.get("workflow.script.metadata");

  assert.match(pipeline?.constraints.join(" ") ?? "", /null.*next stage/i);
  assert.match(agent?.constraints.join(" ") ?? "", /schema noncompliance.*nonrecoverable/i);
  assert.match(agent?.constraints.join(" ") ?? "", /explicit model.*unavailable.*throws MODEL_NOT_FOUND/i);
  assert.match(agent?.constraints.join(" ") ?? "", /implicit default medium tier.*session default when unavailable/i);
  assert.match(agent?.constraints.join(" ") ?? "", /worktree isolation fails closed.*never falls back/i);
  assert.match(checkpoint?.constraints.join(" ") ?? "", /persists its JSON payload, and pauses the run/i);
  assert.match(tasks?.constraints.join(" ") ?? "", /one subagent per task/i);
  assert.match(metadata?.signature ?? "", /phases\?: Array<\{ title: string; detail\?: string; model\?: string \}>/);
  assert.match(metadata?.constraints.join(" ") ?? "", /only legal export/i);
  assert.match(metadata?.constraints.join(" ") ?? "", /literal.*string concatenation.*template interpolation/i);

  const checkpointReference = readFileSync(join(ROOT, SKILL_ROOT, "references/checkpoint.md"), "utf8");
  assert.match(checkpointReference, /attachCheckpointResponse\(runId, checkpointId, response\).*before.*resume/i);
  assert.match(checkpointReference, /`subagents_control` `status`.*`resume`.*`checkpointId`.*`response`/);
  const runtime = readFileSync(join(ROOT, SKILL_ROOT, "references/runtime.md"), "utf8");
  assert.match(runtime, /pipeline.*null.*next stage/i);
  assert.match(runtime, /schema noncompliance.*throw/i);
  assert.match(runtime, /phases.*\[\{.*title.*detail.*model/i);
  assert.match(runtime, /only legal export.*meta/i);
  assert.match(runtime, /export default.*other exports.*invalid/i);
  assert.match(runtime, /agent\(prompt.*label.*schema/i);
  const lifecycle = readFileSync(join(ROOT, SKILL_ROOT, "references/lifecycle.md"), "utf8");
  assert.match(lifecycle, /every run starts in the background/i);
  assert.match(lifecycle, /`subagents_control` with `action: "resume"`.*edited `script`/);
  assert.doesNotMatch(lifecycle, /checkpoint\(prompt|headless/i);
  assert.match(lifecycle, /agent execution retries do not add slots/i);
  assert.match(lifecycle, /run limits come only from the workflow settings/i);
  assert.match(lifecycle, /raising the setting and resuming/i);
});

test("fan-out-and-synthesize example waits for the complete result set and preserves failures", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/fan-out-and-synthesize.js"), "utf8");
  const work = [
    { id: "alpha", task: "A" },
    { id: "beta", task: "B" },
    { id: "gamma", task: "C" },
  ];
  const finished = new Set<string>();
  const labels: string[] = [];
  let synthesisSawCompleteFanOut = false;

  const result = await runWorkflow<{
    ledger: Array<{ id: string; status: string; result: unknown }>;
    synthesis: unknown;
  }>(script, {
    args: { work },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(prompt: string, options: { label?: string; schema?: unknown }) {
        if (options.label === "synthesize-complete-set") {
          synthesisSawCompleteFanOut = finished.size === work.length;
          assert.match(prompt, /"id":"beta"/);
          assert.match(prompt, /"status":"failed"/);
          return { summary: "complete", coveredIds: ["alpha", "gamma"], failedIds: ["beta"] };
        }
        const id = options.label?.split(":").at(-1) ?? "unknown";
        finished.add(id);
        return id === "beta" ? "" : `result:${id}`;
      },
    },
  });

  assert.equal(synthesisSawCompleteFanOut, true);
  assert.deepEqual(labels, ["fanout:0:alpha", "fanout:1:beta", "fanout:2:gamma", "synthesize-complete-set"]);
  assert.equal(new Set(labels).size, labels.length, "all agent labels must be unique");
  assert.deepEqual(
    result.result.ledger.map(({ id, status, result: itemResult }) => ({ id, status, result: itemResult })),
    [
      { id: "alpha", status: "complete", result: "result:alpha" },
      { id: "beta", status: "failed", result: null },
      { id: "gamma", status: "complete", result: "result:gamma" },
    ],
  );
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("classify-and-act classifies the complete set before routed action", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/classify-and-act.js"), "utf8");
  const labels: string[] = [];
  const classified = new Set<string>();
  let actionsStartedAfterClassification = true;

  const result = await runWorkflow<{
    handled: Array<{ id: string; category: string }>;
    failed: { classification: string[]; action: string[] };
  }>(script, {
    args: { items: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(_prompt: string, options: { label?: string }) {
        const label = options.label ?? "";
        if (label.startsWith("classify:")) {
          const id = label.split(":").at(-1) ?? "";
          classified.add(id);
          return id === "beta" ? null : { category: id === "alpha" ? "direct" : "iterative", reason: "fixture" };
        }
        actionsStartedAfterClassification &&= classified.size === 3;
        return label.endsWith(":gamma") ? null : { outcome: "handled" };
      },
    },
  });

  assert.equal(actionsStartedAfterClassification, true);
  assert.deepEqual(labels, ["classify:0:alpha", "classify:1:beta", "classify:2:gamma", "act:0:alpha", "act:1:gamma"]);
  assert.deepEqual([...result.result.failed.classification], ["beta"]);
  assert.deepEqual([...result.result.failed.action], ["gamma"]);
  assert.deepEqual(
    result.result.handled.map(({ id, category }) => ({ id, category })),
    [{ id: "alpha", category: "direct" }],
  );
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("generate-and-filter deterministically deduplicates before rubric filtering", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/generate-and-filter.js"), "utf8");
  const labels: string[] = [];
  const filteredCandidates: string[] = [];

  const result = await runWorkflow<{
    candidates: string[];
    survivors: string[];
    failed: { batches: number[]; filters: string[] };
  }>(script, {
    args: { batches: 3, maxCandidates: 3, topic: "names", rubric: "clear" },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(prompt: string, options: { label?: string }) {
        const label = options.label ?? "";
        if (label === "generate:1") return { candidates: ["Alpha", " Beta "] };
        if (label === "generate:2") return { candidates: [" alpha ", "Gamma"] };
        if (label === "generate:3") return null;
        const candidate = /Candidate: (.*)$/.exec(prompt)?.[1] ?? "";
        filteredCandidates.push(candidate);
        return candidate.trim() === "Beta" ? null : { keep: candidate === "Alpha", reason: "fixture" };
      },
    },
  });

  assert.deepEqual(filteredCandidates, ["Alpha", " Beta ", "Gamma"]);
  assert.deepEqual([...result.result.candidates], ["Alpha", " Beta ", "Gamma"]);
  assert.deepEqual([...result.result.survivors], ["Alpha"]);
  assert.deepEqual([...result.result.failed.batches], [3]);
  assert.deepEqual([...result.result.failed.filters], [" Beta "]);
  assert.equal(new Set(labels).size, labels.length);
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("generate-and-filter bounds rubric calls after deterministic deduplication", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/generate-and-filter.js"), "utf8");
  const filterLabels: string[] = [];
  const result = await runWorkflow<{ candidates: string[]; omitted: string[] }>(script, {
    args: { batches: 1, maxCandidates: 2 },
    persistLogs: false,
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        if (label === "generate:1") return { candidates: ["Alpha", "alpha", "Beta", "Gamma"] };
        filterLabels.push(label ?? "");
        return { keep: true, reason: "fixture" };
      },
    },
  });

  assert.deepEqual([...result.result.candidates], ["Alpha", "Beta"]);
  assert.deepEqual([...result.result.omitted], ["Gamma"]);
  assert.deepEqual(filterLabels, ["filter:1", "filter:2"]);
});

test("tournament keeps a bounded bracket in JavaScript and agents judge only pairs", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/tournament.js"), "utf8");
  const labels: string[] = [];
  const judgePrompts: string[] = [];

  const result = await runWorkflow<{
    winner: { id: string } | null;
    bracket: Array<{ round: number; match: number; leftId: string; rightId: string | null }>;
    failed: { contenders: number[]; matches: string[] };
  }>(script, {
    args: { contenders: 4, task: "pick", rubric: "best" },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(prompt: string, options: { label?: string }) {
        const label = options.label ?? "";
        if (label.startsWith("contender:")) return { candidate: label, rationale: "fixture" };
        judgePrompts.push(prompt);
        return { winnerIndex: 0, reason: "fixture" };
      },
    },
  });

  assert.equal(judgePrompts.length, 3, "four contenders require exactly three pairwise judgments");
  assert.ok(judgePrompts.every((prompt) => /Candidate 0:/.test(prompt) && /Candidate 1:/.test(prompt)));
  assert.deepEqual(
    Array.from(result.result.bracket, ({ leftId, rightId }) => [leftId, rightId]),
    [
      ["contender-1", "contender-2"],
      ["contender-3", "contender-4"],
      ["contender-1", "contender-3"],
    ],
  );
  assert.equal(result.result.winner?.id, "contender-1");
  assert.equal(new Set(labels).size, labels.length);
  assert.doesNotThrow(() => JSON.stringify(result.result));

  const failedResult = await runWorkflow<{
    failed: { contenders: number[]; matches: string[] };
  }>(script, {
    args: { contenders: 3 },
    persistLogs: false,
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        if (label === "contender:2") return null;
        if (label?.startsWith("contender:")) return { candidate: label, rationale: "fixture" };
        return null;
      },
    },
  });
  assert.deepEqual([...failedResult.result.failed.contenders], [2]);
  assert.deepEqual([...failedResult.result.failed.matches], ["round-1-match-1"]);
});

test("tournament advances an odd contender by bye without an agent judgment", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/tournament.js"), "utf8");
  const judgeLabels: string[] = [];
  const result = await runWorkflow<{ bracket: Array<{ rightId: string | null }>; winner: { id: string } }>(script, {
    args: { contenders: 3 },
    persistLogs: false,
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        if (label?.startsWith("contender:")) return { candidate: label, rationale: "fixture" };
        judgeLabels.push(label ?? "");
        return { winnerIndex: 0, reason: "fixture" };
      },
    },
  });

  assert.deepEqual(judgeLabels, ["judge:1:1", "judge:2:1"]);
  assert.equal(
    result.result.bracket.some(({ rightId }) => rightId === null),
    true,
  );
  assert.equal(result.result.winner.id, "contender-1");
});

test("loop-until-done uses stable identities, dry-round termination, and a maximum bound", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/loop-until-done.js"), "utf8");
  const dryLabels: string[] = [];
  const rounds = [
    {
      findings: [
        { id: "alpha", detail: "first" },
        { id: "alpha", detail: "same-round duplicate" },
      ],
    },
    { findings: [{ id: "alpha", detail: "duplicate" }] },
    { findings: [{ id: "beta", detail: "second" }] },
    { findings: [] },
    { findings: [] },
  ];
  const dryResult = await runWorkflow<{ findings: Array<{ id: string }>; failedRounds: number[] }>(script, {
    args: { maxRounds: 10 },
    persistLogs: false,
    onAgentStart: ({ label }) => dryLabels.push(label),
    agent: { run: async () => rounds.shift() ?? { findings: [{ id: "unexpected", detail: "too late" }] } },
  });

  assert.deepEqual(dryLabels, ["discover:1", "discover:2", "discover:3", "discover:4", "discover:5"]);
  assert.deepEqual(
    Array.from(dryResult.result.findings, ({ id }) => id),
    ["alpha", "beta"],
  );

  const boundedLabels: string[] = [];
  const boundedResult = await runWorkflow<{ complete: boolean; termination: string }>(script, {
    args: { maxRounds: 3 },
    persistLogs: false,
    onAgentStart: ({ label }) => boundedLabels.push(label),
    agent: {
      run: async (_prompt: string, { label }: { label?: string }) => ({
        findings: [{ id: label, detail: "new" }],
      }),
    },
  });
  assert.deepEqual(boundedLabels, ["discover:1", "discover:2", "discover:3"]);
  assert.equal(boundedResult.result.complete, false);
  assert.equal(boundedResult.result.termination, "max-rounds");

  const failedResult = await runWorkflow<{ complete: boolean; failedRounds: number[]; termination: string }>(script, {
    args: { maxRounds: 5 },
    persistLogs: false,
    agent: { run: async () => null },
  });
  assert.deepEqual([...failedResult.result.failedRounds], [1, 2, 3, 4, 5]);
  assert.equal(failedResult.result.complete, false);
  assert.equal(failedResult.result.termination, "max-rounds");
  assert.equal(new Set(dryLabels).size, dryLabels.length);
  assert.doesNotThrow(() => JSON.stringify(dryResult.result));
});

test("loop-until-done resets its consecutive dry streak after missing coverage", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/loop-until-done.js"), "utf8");
  const labels: string[] = [];
  const responses = [{ findings: [] }, null, { findings: [] }, { findings: [] }];
  const result = await runWorkflow<{ complete: boolean; failedRounds: number[]; termination: string }>(script, {
    args: { maxRounds: 5 },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      run: async () => {
        const response = responses.shift();
        return response === undefined ? { findings: [{ id: "late", detail: "too late" }] } : response;
      },
    },
  });

  assert.deepEqual(labels, ["discover:1", "discover:2", "discover:3", "discover:4"]);
  assert.deepEqual([...result.result.failedRounds], [2]);
  assert.equal(result.result.termination, "dry");
  assert.equal(result.result.complete, false);
});

test("bounded-retry recipe preserves every semantic attempt", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/bounded-semantic-retry.js"), "utf8");
  const labels: string[] = [];
  const result = await runWorkflow<{
    ok: boolean;
    exhausted: boolean;
    attempts: Array<{ attempt: number; status: string; result: unknown }>;
  }>(script, {
    args: { maxSemanticAttempts: 3 },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        if (label === "semantic-attempt:1") return null;
        return { accepted: false, answer: `answer:${label}`, feedback: "try again" };
      },
    },
  });

  assert.deepEqual(labels, ["semantic-attempt:1", "semantic-attempt:2", "semantic-attempt:3"]);
  assert.deepEqual(
    Array.from(result.result.attempts, ({ attempt, status }) => ({ attempt, status })),
    [
      { attempt: 1, status: "missing" },
      { attempt: 2, status: "rejected" },
      { attempt: 3, status: "rejected" },
    ],
  );
  assert.equal(result.result.ok, false);
  assert.equal(result.result.exhausted, true);
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("structured-output recipe requires schema validation before consuming fields", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/structured-output.js"), "utf8");
  const labels: string[] = [];
  const result = await runWorkflow<{
    outputs: Array<{ id: string; status: string; summary: string | null }>;
    missing: string[];
  }>(script, {
    args: { work: [{ id: "alpha" }, { id: "alpha" }, { id: "beta" }] },
    persistLogs: false,
    onAgentStart: ({ label }) => labels.push(label),
    agent: {
      async run(_prompt: string, { label, schema }: { label?: string; schema?: Record<string, unknown> }) {
        assert.deepEqual(requiredSchemaFields(schema), ["summary", "confidence"]);
        return label === "structured:2:beta" ? null : { summary: "validated", confidence: 0.8 };
      },
    },
  });

  assert.deepEqual(labels, ["structured:0:alpha", "structured:1:alpha", "structured:2:beta"]);
  assert.equal(new Set(labels).size, labels.length);
  assert.deepEqual(
    Array.from(result.result.outputs, ({ id, status, summary }) => ({ id, status, summary })),
    [
      { id: "alpha", status: "complete", summary: "VALIDATED" },
      { id: "alpha", status: "complete", summary: "VALIDATED" },
      { id: "beta", status: "missing", summary: null },
    ],
  );
  assert.deepEqual(Array.from(result.result.missing), ["beta"]);
  assert.doesNotThrow(() => JSON.stringify(result.result));
});

test("defensive-json-parsing recipe flags unparseable text instead of reading undefined fields", async () => {
  const script = readFileSync(join(ROOT, SKILL_ROOT, "examples/defensive-json-parsing.js"), "utf8");
  const responses: Record<string, string | null> = {
    "defensive:0:alpha": '```json\n{"verdict": "pass", "reason": "looks fine"}\n```',
    "defensive:1:beta": "Sure, this passes the review.", // not JSON at all
    "defensive:2:gamma": null,
  };
  const result = await runWorkflow<{
    outputs: Array<{ id: string; status: string; verdict: string | null }>;
    missing: string[];
    unparseable: string[];
    complete: boolean;
  }>(script, {
    args: { work: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] },
    persistLogs: false,
    agent: {
      async run(_prompt: string, { label }: { label?: string }) {
        return responses[label ?? ""];
      },
    },
  });

  assert.deepEqual(
    Array.from(result.result.outputs, ({ id, status, verdict }) => ({ id, status, verdict })),
    [
      { id: "alpha", status: "complete", verdict: "pass" },
      { id: "beta", status: "unparseable", verdict: null },
      { id: "gamma", status: "missing", verdict: null },
    ],
  );
  assert.deepEqual(Array.from(result.result.unparseable), ["beta"]);
  assert.deepEqual(Array.from(result.result.missing), ["gamma"]);
  assert.equal(result.result.complete, false);
  assert.doesNotThrow(() => JSON.stringify(result.result));
});
