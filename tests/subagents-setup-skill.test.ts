/**
 * The subagents-setup skill tells the model which files to write. These tests
 * feed its examples and path rules to the real loaders so the guidance cannot
 * drift from what the plugin reads.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, it } from "node:test";
import packageJson from "../package.json" with { type: "json" };
import { loadAgentRegistry, parseAgentDefinition } from "../src/agent-registry.js";
import { THINKING_LEVELS } from "../src/model-spec.js";
import { loadModelTierConfig } from "../src/model-tier-config.js";
import { workflowProjectKey } from "../src/workflow-paths.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { loadWorkflowSettings } from "../src/workflow-settings.js";
import { withFakeHome } from "./helpers/fake-home.js";

const ROOT = join(import.meta.dirname, "..");
const SKILL_ROOT = "skills/subagents-setup";
const skill = readFileSync(join(ROOT, SKILL_ROOT, "SKILL.md"), "utf8");

/** Body of one `## heading` section. */
function section(heading: string): string {
  const start = skill.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const next = skill.indexOf("\n## ", start + 1);
  return skill.slice(start, next === -1 ? undefined : next);
}

/** The single fenced block of `lang` inside a section. */
function fenced(heading: string, lang: string): string {
  const match = new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\\n\`\`\``).exec(section(heading));
  assert.ok(match, `missing ${lang} block in ${heading}`);
  return match[1];
}

/** Map `~/...` and `<project>/...` paths from the skill onto a test home and project. */
function localPath(documented: string, home: string, project: string, key: string): string {
  const relative = documented.replace("<key>", key);
  if (relative.startsWith("~/")) return join(home, relative.slice(2));
  if (relative.startsWith("<project>/")) return join(project, relative.slice("<project>/".length));
  throw new Error(`unexpected documented path: ${documented}`);
}

function withHomeAndProject(fn: (home: string, project: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-setup-home-"));
  // A space and capitals exercise the folder-name part of the project key.
  const project = mkdtempSync(join(tmpdir(), "Subagents Setup-"));
  // Pi reads ~/.pi/agent from this override first; keep it on the fake home.
  const agentDirOverride = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    withFakeHome(home, () => fn(home, project));
  } finally {
    if (agentDirOverride !== undefined) process.env.PI_CODING_AGENT_DIR = agentDirOverride;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

describe("subagents-setup skill", () => {
  it("is registered with a discovery description that names the settings users ask about", () => {
    assert.ok(packageJson.pi.skills.includes(SKILL_ROOT));
    assert.match(skill, /^---\nname: subagents-setup\n/);
    const description = /^description:\s*(.+)$/m.exec(skill)?.[1] ?? "";
    for (const topic of ["subagents", "models", "concurrency", "retries", "timeouts", "agent roles", "workflow"]) {
      assert.match(description, new RegExp(topic, "i"), topic);
    }
  });

  it("derives the project key the same way the plugin does", () => {
    withHomeAndProject((_home, project) => {
      assert.match(skill, /runs of characters outside `a-z0-9\._-` turned into `-`/);
      assert.match(skill, /first 12 hex digits of SHA-256 of the absolute project path/);
      const folder = basename(project)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-");
      const hash = createHash("sha256").update(resolve(project)).digest("hex").slice(0, 12);
      assert.equal(`${folder}-${hash}`, workflowProjectKey(project));
    });
  });

  it("documents a model-tiers example and overlay that the loader accepts", () => {
    withHomeAndProject((home, project) => {
      const key = workflowProjectKey(project);
      const [globalPath, projectPath] = [...section("Model tiers").matchAll(/`(~\/[^`]+model-tiers\.json)`/g)].map(
        ([, path]) => localPath(path, home, project, key),
      );
      const example = JSON.parse(fenced("Model tiers", "json"));
      mkdirSync(join(globalPath, ".."), { recursive: true });
      writeFileSync(globalPath, JSON.stringify(example));
      assert.deepEqual(loadModelTierConfig({ cwd: project }), example);

      mkdirSync(join(projectPath, ".."), { recursive: true });
      writeFileSync(projectPath, JSON.stringify({ tiers: { big: "other/model" } }));
      assert.deepEqual(loadModelTierConfig({ cwd: project })?.tiers, { ...example.tiers, big: "other/model" });

      const suffixes = /Suffix sets thinking: `([^`]+)`/.exec(section("Model tiers"))?.[1].split("|");
      assert.deepEqual(suffixes, [...THINKING_LEVELS]);
    });
  });

  it("lists settings files in the order the loader applies them", () => {
    withHomeAndProject((home, project) => {
      const key = workflowProjectKey(project);
      const order = /Later files win per key: (.+)\./.exec(section("settings.json"))?.[1] ?? "";
      const paths = [...order.matchAll(/`([^`]+)`/g)].map(([, path]) => localPath(path, home, project, key));
      assert.equal(paths.length, 3);
      paths.forEach((path, index) => {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, JSON.stringify({ defaultConcurrency: index + 2, defaultAgentRetries: index }));
      });
      assert.deepEqual(loadWorkflowSettings({ cwd: project }), { defaultConcurrency: 4, defaultAgentRetries: 2 });
      rmSync(paths[2]);
      assert.deepEqual(loadWorkflowSettings({ cwd: project }), { defaultConcurrency: 3, defaultAgentRetries: 1 });
    });
  });

  it("documents an agent role file that the registry reads from the user directory", () => {
    withHomeAndProject((home, project) => {
      const example = `${fenced("Agent roles", "markdown")}\n`;
      assert.deepEqual(parseAgentDefinition(example, "user", "reviewer.md"), {
        name: "reviewer",
        tools: ["read", "bash"],
        disallowedTools: ["write"],
        model: "<provider>/<model>",
        thinking: "high",
        isolation: "worktree",
        prompt: "Role instructions.",
        source: "user",
      });

      const userDir = /wins over `(~\/[^`]+)\/<name>\.md`/.exec(section("Agent roles"))?.[1];
      assert.ok(userDir);
      mkdirSync(localPath(userDir, home, project, ""), { recursive: true });
      writeFileSync(join(localPath(userDir, home, project, ""), "reviewer.md"), example);
      assert.equal(loadAgentRegistry(project).get("reviewer")?.prompt, "Role instructions.");
    });
  });

  it("documents a saved workflow file that storage loads by name, project copy first", () => {
    withHomeAndProject((home, project) => {
      const key = workflowProjectKey(project);
      const [userPath, projectPath] = [...section("Saved workflows").matchAll(/`(~\/[^`]+<name>\.json)`/g)].map(
        ([, path]) => localPath(path.replace("<name>", "audit"), home, project, key),
      );
      const script = "export const meta = { name: 'audit', description: 'Audit' }\nreturn await agent('audit')";
      const example = JSON.parse(
        fenced("Saved workflows", "json").replace("<name>", "audit").replace("<workflow script>", "SCRIPT"),
      );
      mkdirSync(join(userPath, ".."), { recursive: true });
      writeFileSync(userPath, JSON.stringify({ ...example, script }));
      assert.equal(createWorkflowStorage(project).load("audit")?.script, script);

      mkdirSync(join(projectPath, ".."), { recursive: true });
      writeFileSync(projectPath, JSON.stringify({ name: "audit", description: "Project", scriptPath: "audit.js" }));
      writeFileSync(join(projectPath, "..", "audit.js"), script.replace("Audit", "Project audit"));
      assert.match(createWorkflowStorage(project).load("audit")?.script ?? "", /Project audit/);
    });
  });
});
