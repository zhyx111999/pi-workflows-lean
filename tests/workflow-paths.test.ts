import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

  it("keeps project storage under workflow home", () => {
    withIsolatedHome((home, cwd) => {
      const paths = workflowProjectPaths(cwd);
      assert.ok(paths.rootDir.startsWith(join(home, WORKFLOW_HOME_RELATIVE_DIR, WORKFLOW_PROJECTS_SUBDIR)));
      assert.equal(paths.runsDir, join(paths.rootDir, "runs"));
      assert.equal(paths.savedDir, join(paths.rootDir, "saved"));
      assert.equal(paths.settingsPath, join(paths.rootDir, "settings.json"));
      assert.equal(paths.modelTiersPath, join(paths.rootDir, "model-tiers.json"));
    });
  });
});

/** The key of one exact spelling: a hash of the path as given. */
function spelledKey(spelling: string): string {
  const path = resolve(spelling);
  const folder = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${folder}-${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
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
});
