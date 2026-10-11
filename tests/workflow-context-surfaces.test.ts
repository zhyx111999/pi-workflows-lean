import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };
import {
  checkWorkflowContextMeasurement,
  measuredTools,
  measureWorkflowContextSurfaces,
  permanentToolPromptLines,
  renderWorkflowContextMeasurement,
  WORKFLOW_CONTEXT_MEASUREMENT_PATH,
  writeWorkflowContextMeasurement,
} from "../src/workflow-context-measurement.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const ROOT = join(import.meta.dirname, "..");
const CONTEXT_SCRIPT = "scripts/generate-workflow-context-measurement.ts";

test("workflow context measurement reports the Pi-rendered prompt and each provider tool definition", async () => {
  const artifact = measureWorkflowContextSurfaces(ROOT);
  assert.deepEqual(JSON.parse(renderWorkflowContextMeasurement()), artifact);

  assert.equal(artifact.formatVersion, 4);
  assert.equal(artifact.encoding, "utf8");
  assert.deepEqual(artifact.sources, [
    "src/subagents-tool.ts",
    "src/subagents-control-tool.ts",
    "skills/workflow-authoring",
    "package.json#pi.skills",
  ]);
  assert.equal(artifact.surfaces.permanentToolPrompt.serialization, "UTF-8 bytes of LF-joined Pi prompt lines");
  const definitions = artifact.surfaces.providerVisibleToolDefinitions;
  assert.equal(
    definitions.serialization,
    "sum of UTF-8 bytes of JSON.stringify({ name, description, parameters }) per tool",
  );
  assert.deepEqual(
    definitions.tools.map(({ name }) => name),
    ["subagents", "subagents_control"],
  );
  assert.equal(
    definitions.bytes,
    definitions.tools.reduce((sum, tool) => sum + tool.bytes, 0),
  );
  // Every skill in package.json's pi.skills contributes to the always-on
  // discovery tally — not just workflow-authoring — so adding a new skill
  // can't silently go untracked (see the workflow-patterns skill).
  assert.match(artifact.surfaces.registeredSkillsDiscovery.serialization, /pi\.skills/i);
  assert.ok(artifact.surfaces.registeredSkillsDiscovery.bytes > 0);
  assert.deepEqual(
    artifact.surfaces.registeredSkillsDiscovery.skills.map(({ root }) => root).sort(),
    [...packageJson.pi.skills].sort(),
  );
  assert.equal(
    artifact.surfaces.registeredSkillsDiscovery.bytes,
    artifact.surfaces.registeredSkillsDiscovery.skills.reduce((sum, skill) => sum + skill.bytes, 0),
    "the total must be the exact sum of each registered skill's own discovery bytes",
  );
  for (const skill of artifact.surfaces.registeredSkillsDiscovery.skills) {
    assert.ok(skill.bytes > 0, `${skill.root} should report a positive discovery byte count`);
  }
  assert.equal(
    artifact.surfaces.ordinaryWorkflowOwnedAlwaysOn.bytes,
    artifact.surfaces.permanentToolPrompt.bytes + definitions.bytes + artifact.surfaces.registeredSkillsDiscovery.bytes,
  );
  assert.equal(artifact.surfaces.workflowAuthoringSkillCorpus.files, 20);
  assert.ok(artifact.surfaces.workflowAuthoringSkillCorpus.bytes > 0);
  assert.equal(artifact.surfaces.representativeAuthoringProfiles.profiles.length, 6);
  assert.deepEqual(
    artifact.surfaces.representativeAuthoringProfiles.profiles.map(({ name }) => name),
    ["write", "edit", "review", "debug", "loop", "retry"],
  );
  for (const profile of artifact.surfaces.representativeAuthoringProfiles.profiles) {
    const expected = profile.files.reduce((sum, path) => sum + Buffer.byteLength(readFileSync(join(ROOT, path))), 0);
    assert.equal(profile.bytes, expected, `${profile.name} profile must sum its declared files`);
  }
  const profileBytes = artifact.surfaces.representativeAuthoringProfiles.profiles
    .map(({ bytes }) => bytes)
    .sort((a, b) => a - b);
  assert.equal(artifact.surfaces.representativeAuthoringProfiles.medianBytes, (profileBytes[2] + profileBytes[3]) / 2);

  await withRenderedTools(async ({ systemPrompt, promptLines, wrappedTools }) => {
    const expectedLines = new Set(promptLines);
    const renderedLines = systemPrompt.split("\n").filter((line) => expectedLines.has(line));
    assert.deepEqual(renderedLines, promptLines, "Pi should render each tool prompt line exactly once");
    assert.equal(artifact.surfaces.permanentToolPrompt.bytes, Buffer.byteLength(renderedLines.join("\n"), "utf8"));

    for (const [index, wrapped] of wrappedTools.entries()) {
      const providerDefinition = JSON.stringify({
        name: wrapped.name,
        description: wrapped.description,
        parameters: wrapped.parameters,
      });
      assert.equal(definitions.tools[index]?.bytes, Buffer.byteLength(providerDefinition, "utf8"));
    }
  });
});

test("workflow context measurement generation is deterministic and committed artifact is fresh", () => {
  const first = renderWorkflowContextMeasurement();
  const second = renderWorkflowContextMeasurement();

  assert.equal(first, second);
  assert.equal(readFileSync(join(ROOT, WORKFLOW_CONTEXT_MEASUREMENT_PATH), "utf8"), first);
  assert.equal(checkWorkflowContextMeasurement(ROOT), true);
  assert.equal(checkWorkflowContextMeasurement(ROOT, `${first}stale`), false);
  assert.equal(packageJson.scripts["context:check"], `tsx ${CONTEXT_SCRIPT} --check`);
  assert.match(packageJson.scripts.test, /npm run context:check/);
});

test("render, write, and freshness check all measure the package at the given root", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-context-root-"));
  try {
    await cp(join(ROOT, "package.json"), join(root, "package.json"));
    await cp(join(ROOT, "skills"), join(root, "skills"), { recursive: true });
    await mkdir(join(root, "docs"));
    await appendFile(join(root, "skills/workflow-authoring/references/runtime.md"), "\nBytes only this copy has.\n");

    const rendered = renderWorkflowContextMeasurement(root);
    assert.deepEqual(JSON.parse(rendered), measureWorkflowContextSurfaces(root));
    assert.notEqual(rendered, renderWorkflowContextMeasurement(ROOT));

    assert.deepEqual(writeWorkflowContextMeasurement(root), JSON.parse(rendered));
    assert.equal(readFileSync(join(root, WORKFLOW_CONTEXT_MEASUREMENT_PATH), "utf8"), rendered);
    assert.equal(checkWorkflowContextMeasurement(root), true);
    assert.equal(checkWorkflowContextMeasurement(ROOT, rendered), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context freshness command prints every current byte count", () => {
  // Run the script that `npm run context:check` runs through Node itself: spawning
  // `npm` directly fails on Windows, where it is a .cmd shim that needs a shell.
  const output = execFileSync(process.execPath, ["--import", "tsx", CONTEXT_SCRIPT, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.match(output, /Permanent tool prompt: \d+ bytes/);
  assert.match(output, /Provider-visible tool definitions: \d+ bytes/);
  assert.match(output, /- subagents: \d+ bytes/);
  assert.match(output, /- subagents_control: \d+ bytes/);
  assert.match(output, /Registered skills discovery \(all \d+\): \d+ bytes/);
  assert.match(output, /- skills\/workflow-authoring: \d+ bytes/);
  assert.match(output, /- skills\/workflow-patterns: \d+ bytes/);
  assert.match(output, /- skills\/subagents-setup: \d+ bytes/);
  assert.match(output, /Workflow-authoring skill corpus: \d+ bytes across \d+ files/);
  assert.match(output, /Representative authoring profile median: \d+(?:\.5)? bytes/);
  assert.match(output, /measurement is fresh/i);
});

async function withRenderedTools(
  inspect: (surface: {
    systemPrompt: string;
    promptLines: string[];
    wrappedTools: Array<{ name: string; description: string; parameters: unknown }>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workflow-context-measurement-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await withFakeHomeAsync(root, async () => {
      const tools = measuredTools();
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        tools: tools.map((tool) => tool.name),
        customTools: tools as never,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
        settingsManager: SettingsManager.inMemory(),
      });

      try {
        const wrappedTools = tools.map((tool) => {
          const wrapped = session.agent.state.tools.find((candidate) => candidate.name === tool.name);
          assert.ok(wrapped, `Pi should expose the wrapped ${tool.name} tool`);
          return wrapped;
        });
        await inspect({
          systemPrompt: session.systemPrompt,
          promptLines: permanentToolPromptLines(tools),
          wrappedTools,
        });
      } finally {
        session.dispose();
      }
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}
