import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  WORKFLOW_HOME_RELATIVE_DIR,
  WORKFLOW_PROJECTS_SUBDIR,
  workflowHomeDir,
  workflowProjectKey,
  workflowProjectPaths,
  workflowUserSavedDir,
} from "../src/workflow-paths.js";
import { withFakeHome } from "./helpers/fake-home.js";

function withIsolatedHome(fn: (home: string, cwd: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-project-"));
  try {
    withFakeHome(home, () => fn(home, cwd));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("workflow paths", () => {
  it("resolves workflow home under the user home", () => {
    withIsolatedHome((home) => {
      assert.equal(workflowHomeDir(), join(home, WORKFLOW_HOME_RELATIVE_DIR));
      assert.equal(workflowUserSavedDir(), join(home, WORKFLOW_HOME_RELATIVE_DIR, "saved"));
    });
  });

  it("creates stable project namespaces from cwd", () => {
    withIsolatedHome((_home, cwd) => {
      const key = workflowProjectKey(cwd);
      assert.equal(key, workflowProjectKey(cwd));
      assert.match(key, /^[a-z0-9._-]+-[a-f0-9]{12}$/);
      assert.ok(key.startsWith(basename(cwd).toLowerCase()));
    });
  });

  it("keeps new project storage under workflow home and legacy paths under cwd", () => {
    withIsolatedHome((home, cwd) => {
      const paths = workflowProjectPaths(cwd);
      assert.ok(paths.rootDir.startsWith(join(home, WORKFLOW_HOME_RELATIVE_DIR, WORKFLOW_PROJECTS_SUBDIR)));
      assert.equal(paths.runsDir, join(paths.rootDir, "runs"));
      assert.equal(paths.savedDir, join(paths.rootDir, "saved"));
      assert.equal(paths.settingsPath, join(paths.rootDir, "settings.json"));
      assert.equal(paths.modelTiersPath, join(paths.rootDir, "model-tiers.json"));
      assert.equal(paths.legacyRunsDir, normalize(join(cwd, ".pi/workflows/runs")));
      assert.equal(paths.legacySavedDir, normalize(join(cwd, ".pi/workflows/saved")));
    });
  });
});

/** The key a spelling got before keys followed the on-disk path; existing project directories carry it. */
function spelledKey(spelling: string): string {
  const path = resolve(spelling);
  const folder = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${folder}-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
}

/** Seed a project directory the way an earlier session opened with `spelling` left it. */
function seedProject(spelling: string, file = "settings.json"): string {
  const root = join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR, spelledKey(spelling));
  mkdirSync(join(root, "runs"), { recursive: true });
  writeFileSync(join(root, file), spelling);
  return root;
}

describe("workflow paths on Windows", {
  skip: process.platform !== "win32" && "Windows paths are case-insensitive",
}, () => {
  /** A project directory spelled as stored on disk, plus other spellings of it. */
  function spellings(cwd: string) {
    const project = join(realpathSync.native(cwd), "MixedCase");
    mkdirSync(project);
    return {
      project,
      lower: project.toLowerCase(),
      upperLeaf: join(dirname(project), "MIXEDCASE"),
      lowerDrive: project[0].toLowerCase() + project.slice(1),
      slashes: project.replaceAll("\\", "/"),
    };
  }

  it("gives every spelling of one directory the key its on-disk spelling always had", () => {
    withIsolatedHome((_home, cwd) => {
      const { project, ...others } = spellings(cwd);
      assert.equal(workflowProjectKey(project), spelledKey(project));
      for (const [name, spelling] of Object.entries(others)) {
        assert.equal(workflowProjectKey(spelling), workflowProjectKey(project), name);
        assert.equal(workflowProjectPaths(spelling).rootDir, workflowProjectPaths(project).rootDir, name);
      }
    });
  });

  it("moves a project directory stored under another spelling's key to the canonical key", () => {
    withIsolatedHome((_home, cwd) => {
      const { project, lower } = spellings(cwd);
      const oldRoot = seedProject(lower);
      writeFileSync(join(oldRoot, "runs", "r1.json"), "{}");

      const paths = workflowProjectPaths(lower);
      assert.equal(paths.rootDir, join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR, workflowProjectKey(project)));
      assert.equal(paths.key, workflowProjectKey(project));
      assert.equal(existsSync(oldRoot), false, "the data moved rather than being copied");
      assert.equal(readFileSync(paths.settingsPath, "utf8"), lower);
      assert.ok(existsSync(join(paths.runsDir, "r1.json")));
      assert.equal(workflowProjectPaths(project).settingsPath, paths.settingsPath, "the canonical spelling finds it");
    });
  });

  it("leaves a spelling's directory in place while a run holds a lock in it, for the rest of the process", () => {
    withIsolatedHome((_home, cwd) => {
      const { lowerDrive } = spellings(cwd);
      const oldRoot = seedProject(lowerDrive);
      writeFileSync(join(oldRoot, "runs", "r1.lock"), "{}");

      assert.equal(workflowProjectPaths(lowerDrive).rootDir, oldRoot);
      rmSync(join(oldRoot, "runs", "r1.lock"));
      assert.equal(workflowProjectPaths(lowerDrive).rootDir, oldRoot, "one process never switches roots");
    });
  });

  it("keeps a spelling's own directory when the canonical key already has one", () => {
    withIsolatedHome((_home, cwd) => {
      const { project, upperLeaf } = spellings(cwd);
      const canonicalRoot = seedProject(project);
      const oldRoot = seedProject(upperLeaf);

      assert.equal(workflowProjectPaths(upperLeaf).rootDir, oldRoot, "what this spelling showed before stays visible");
      assert.equal(workflowProjectPaths(project).rootDir, canonicalRoot);
      assert.equal(
        readFileSync(join(canonicalRoot, "settings.json"), "utf8"),
        project,
        "nothing is merged or overwritten",
      );
    });
  });
});
