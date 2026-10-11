import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test, { type TestContext } from "node:test";
import { bindDiagnosticSink } from "../src/host-diagnostics.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import {
  createWorkflowStorage,
  isSafeSavedWorkflowName,
  resolveSavedScriptPath,
  SAVED_WORKFLOW_NAME_RULE,
  type SavedWorkflow,
  type SavedWorkflowDraft,
  type SavedWorkflowLocation,
  type WorkflowStorage,
} from "../src/workflow-saved.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/**
 * Run tests with HOME overridden to a temp directory so the user-level
 * saved workflows directory (~/.pi/workflows/saved) is isolated.
 */
function withIsolatedHome(fn: (cwd: string, t: TestContext) => Promise<void>) {
  return async (t: TestContext) => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-ws-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd, t));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

/** Save through the guarded API, failing the test unless it wrote. */
function save(
  storage: WorkflowStorage,
  draft: SavedWorkflowDraft,
  location: SavedWorkflowLocation = "project",
  replacing?: SavedWorkflow,
): SavedWorkflow {
  const result = storage.save(draft, { location, replacing });
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.workflow;
}

/** Collect the diagnostics reported during one test. */
function captureWarnings(t: TestContext): () => string[] {
  const messages: string[] = [];
  t.after(bindDiagnosticSink((message) => messages.push(message)));
  return () => [...messages];
}

test(
  "createWorkflowStorage save creates directory and file",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = save(storage, {
      name: "test-wf",
      description: "A test workflow",
      script: "export const meta = { name: 'test', description: 'test' }",
    });
    assert.equal(saved.name, "test-wf");
    assert.equal(saved.location, "project");
    assert.ok(saved.path.endsWith("test-wf.json"), "should end with test-wf.json");
    assert.ok(saved.savedAt, "should have savedAt timestamp");
    const dir = workflowProjectPaths(cwd).savedDir;
    assert.ok(existsSync(dir), "project saved dir should exist");
    assert.ok(existsSync(join(dir, "test-wf.json")), "file should exist");
  }),
);

test(
  "createWorkflowStorage save to user location",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = save(
      storage,
      {
        name: "user-wf",
        description: "User workflow",
        script: "export const meta = { name: 'u', description: 'u' }",
      },
      "user",
    );
    assert.equal(saved.location, "user");
    assert.ok(saved.path.includes(`.pi${sep}workflows${sep}saved`), "should contain .pi/workflows/saved");
  }),
);

test(
  "createWorkflowStorage load returns project workflow (takes precedence)",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, {
      name: "shared",
      description: "Project version",
      script: "project script",
    });
    save(
      storage,
      {
        name: "shared",
        description: "User version",
        script: "user script",
      },
      "user",
    );
    const loaded = storage.load("shared");
    assert.ok(loaded, "should load");
    assert.equal(loaded?.script, "project script", "project should take precedence");
  }),
);

test(
  "createWorkflowStorage load returns null for nonexistent workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const loaded = storage.load("nonexistent");
    assert.equal(loaded, null);
  }),
);

test(
  "createWorkflowStorage load returns user workflow when no project version exists",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(
      storage,
      {
        name: "user-only",
        description: "Only in user",
        script: "user script",
      },
      "user",
    );
    const loaded = storage.load("user-only");
    assert.ok(loaded, "should load successfully");
    assert.equal(loaded?.script, "user script");
    assert.equal(loaded?.location, "user");
  }),
);

test(
  "createWorkflowStorage list combines project and user workflows sorted by name",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "b-project", description: "b", script: "b" });
    save(storage, { name: "a-project", description: "a", script: "a" });
    save(storage, { name: "c-user", description: "c", script: "c" }, "user");

    const list = storage.list();
    assert.equal(list.length, 3);
    assert.equal(list[0].name, "a-project");
    assert.equal(list[1].name, "b-project");
    assert.equal(list[2].name, "c-user");
  }),
);

test(
  "createWorkflowStorage list returns empty array when no workflows saved",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const list = storage.list();
    assert.deepEqual(list, []);
  }),
);

test(
  "createWorkflowStorage delete removes project workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "to-delete", description: "d", script: "d" });
    assert.ok(storage.load("to-delete"), "load() should succeed");
    const deleted = storage.delete(storage.load("to-delete") as SavedWorkflow);
    assert.deepEqual(deleted, { ok: true });
    assert.equal(storage.load("to-delete"), null);
  }),
);

test(
  "createWorkflowStorage delete reports a row whose workflow is already gone as missing",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const row = save(storage, { name: "gone", description: "d", script: "s" });
    assert.deepEqual(storage.delete(row), { ok: true });
    const again = storage.delete(row);
    assert.equal(again.ok === false && again.code, "missing");
  }),
);

test(
  "createWorkflowStorage delete removes from one location only",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "both", description: "p", script: "p" });
    save(storage, { name: "both", description: "u", script: "u" }, "user");
    assert.ok(storage.load("both"), "load() should succeed");
    // Deleting the visible (project) row leaves the user tier alone
    const deleted = storage.delete(storage.load("both") as SavedWorkflow);
    assert.deepEqual(deleted, { ok: true });
    // User version should still exist
    const userVersion = storage.load("both");
    assert.ok(userVersion, "user version should still exist");
    assert.equal(userVersion?.location, "user");
  }),
);

test(
  "createWorkflowStorage save preserves parameters",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = save(storage, {
      name: "param-wf",
      description: "Has params",
      script: "export const meta = { name: 'p', description: 'p' }",
      parameters: {
        input: { type: "string", description: "Input value", required: true },
        limit: { type: "number", description: "Max results", default: 10 },
      },
    });
    assert.ok(saved.parameters, "parameters should be truthy");
    assert.equal(saved.parameters?.input.type, "string");
    assert.equal(saved.parameters?.input.required, true);
    assert.equal(saved.parameters?.limit.default, 10);

    const loaded = storage.load("param-wf");
    assert.deepEqual(loaded?.parameters, saved.parameters);
  }),
);

test(
  "createWorkflowStorage rejects path-unsafe workflow names",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.deepEqual(storage.save({ name: "../escape", description: "bad", script: "bad" }), {
      ok: false,
      code: "invalid",
      message: SAVED_WORKFLOW_NAME_RULE,
    });
    assert.equal(storage.load("../escape"), null);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).rootDir, "escape.json")), false);
  }),
);

test(
  "createWorkflowStorage file contents are valid JSON with expected fields",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, {
      name: "check-json",
      description: "desc",
      script: "export const meta = { name: 'c', description: 'c' }",
    });
    const filePath = join(workflowProjectPaths(cwd).savedDir, "check-json.json");
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(raw.name, "check-json");
    assert.equal(raw.description, "desc");
    assert.equal(raw.script, "export const meta = { name: 'c', description: 'c' }");
    assert.ok(raw.savedAt, "savedAt should be truthy");
    assert.ok(raw.path, "path should be truthy");
  }),
);

test(
  "createWorkflowStorage handles corrupted files gracefully",
  withIsolatedHome(async (cwd, t) => {
    const warnings = captureWarnings(t);
    const storage = createWorkflowStorage(cwd);
    const projectDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "corrupted.json"), "not valid json{{{");

    const loaded = storage.load("corrupted");
    assert.equal(loaded, null, "corrupted file returns null");
    const list = storage.list();
    assert.ok(Array.isArray(list), "list should be an array");
    assert.equal(list.length, 0); // only corrupted file
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0], /corrupted\.json: the file is unreadable or not valid JSON$/);
  }),
);

test(
  "createWorkflowStorage skips files with unsafe workflow names",
  withIsolatedHome(async (cwd, t) => {
    const warnings = captureWarnings(t);
    const storage = createWorkflowStorage(cwd);
    const projectDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "unsafe.json"),
      JSON.stringify({
        name: "../unsafe",
        description: "unsafe",
        script: "unsafe",
        location: "project",
        savedAt: "2024-01-01T00:00:00.000Z",
        path: join(projectDir, "unsafe.json"),
      }),
      "utf-8",
    );

    assert.deepEqual(storage.list(), []);
    assert.deepEqual(warnings(), [
      `Skipped saved workflow ${join(projectDir, "unsafe.json")}: "name" is not valid. ${SAVED_WORKFLOW_NAME_RULE}`,
    ]);
  }),
);

test("saved workflow names are portable file names on every platform", () => {
  const rejected: unknown[] = [
    "review:branch",
    "a<b",
    "a>b",
    'a"b',
    "a|b",
    "a?b",
    "a*b",
    "trailing.",
    "trailing ",
    ".",
    "..",
    "CON",
    "con",
    "Prn",
    "AUX",
    "nul",
    "COM1",
    "com9",
    "COM¹",
    "LPT1",
    "lpt9",
    "LPT³",
    "CON.review",
    "nul.tar.gz",
    "",
    "x".repeat(129),
    ["review"],
    123,
    null,
    undefined,
    { length: 3 },
  ];
  for (const name of rejected) assert.equal(isSafeSavedWorkflowName(name), false, `rejects ${JSON.stringify(name)}`);

  const accepted = [
    "review-branch",
    "v1.2",
    "deep_research",
    "CONSOLE",
    "COM10",
    "LPT",
    "nullable",
    "con-review",
    "保存",
  ];
  for (const name of accepted) assert.equal(isSafeSavedWorkflowName(name), true, `accepts ${name}`);
});

test(
  "save and rename refuse Windows-unsafe names before anything reaches disk",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const source = save(storage, { name: "review", description: "d", script: "s" });
    const before = readdirSync(workflowProjectPaths(cwd).savedDir).sort();

    for (const name of ["review:branch", "CON", "lpt1.json", "review."]) {
      assert.deepEqual(
        storage.save({ name, description: "d", script: "s" }),
        { ok: false, code: "invalid", message: SAVED_WORKFLOW_NAME_RULE },
        `save ${name}`,
      );
      assert.deepEqual(storage.rename(source, name), {
        ok: false,
        code: "invalid",
        message: SAVED_WORKFLOW_NAME_RULE,
      });
      assert.equal(storage.load(name), null);
    }
    assert.deepEqual(readdirSync(workflowProjectPaths(cwd).savedDir).sort(), before, "no stray file or stream");
    assert.equal(storage.load("review")?.script, "s");
  }),
);

test(
  "list skips mistyped saved files with one warning each and keeps the valid rows",
  withIsolatedHome(async (cwd, t) => {
    const warnings = captureWarnings(t);
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "good", description: "kept", script: "s" });
    save(storage, { name: "shadowed", description: "user copy", script: "user script" }, "user");
    const dir = workflowProjectPaths(cwd).savedDir;
    const bad: Record<string, unknown> = {
      "array-name": { name: ["array-name"], description: "d", script: "s" },
      "object-name": { name: { length: 3 }, description: "d", script: "s" },
      "colon-name": { name: "review:branch", description: "d", script: "s" },
      "device-name": { name: "NUL", description: "d", script: "s" },
      "number-description": { name: "number-description", description: 7, script: "s" },
      "number-script": { name: "number-script", description: "d", script: 42 },
      "no-script": { name: "no-script", description: "d" },
      "number-saved-at": { name: "number-saved-at", description: "d", script: "s", savedAt: 1 },
      "array-parameters": { name: "array-parameters", description: "d", script: "s", parameters: [] },
      "null-parameter": { name: "null-parameter", description: "d", script: "s", parameters: { topic: null } },
      "untyped-parameter": { name: "untyped-parameter", description: "d", script: "s", parameters: { topic: {} } },
      "array-file": [{ name: "array-file", description: "d", script: "s" }],
      // A broken project copy must not hide the valid user copy of the same name.
      shadowed: { name: "shadowed", description: "project copy", script: false },
    };
    for (const [file, data] of Object.entries(bad)) writeFileSync(join(dir, `${file}.json`), JSON.stringify(data));
    writeFileSync(join(dir, "not-json.json"), "{ not json");

    const listed = storage.list();
    assert.deepEqual(
      listed.map((workflow) => [workflow.name, workflow.location]),
      [
        ["good", "project"],
        ["shadowed", "user"],
      ],
    );
    assert.equal(storage.load("shadowed")?.script, "user script");
    storage.list();

    for (const file of [...Object.keys(bad), "not-json"]) {
      const path = join(dir, `${file}.json`);
      assert.equal(warnings().filter((message) => message.includes(path)).length, 1, `one warning for ${file}`);
    }
    assert.equal(warnings().length, Object.keys(bad).length + 1);
  }),
);

test(
  "load accepts a hand-written file without description or savedAt",
  withIsolatedHome(async (cwd) => {
    const dir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "minimal.json"),
      JSON.stringify({ name: "minimal", script: "s", parameters: { topic: { type: "string", default: "x" } } }),
    );
    const loaded = createWorkflowStorage(cwd).load("minimal");
    assert.equal(loaded?.script, "s");
    assert.equal(loaded?.description, "");
    assert.equal(loaded?.savedAt, "");
    assert.deepEqual(loaded?.parameters, { topic: { type: "string", default: "x" } });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Write safety: atomic write-with-backup + corrupt-file recovery, unified
// with run-persistence.ts via fs-persistence.ts (previously saved-workflow
// writes were a plain writeFileSync with no backup/recovery).
// ═══════════════════════════════════════════════════════════════════════════

test(
  "createWorkflowStorage save writes atomically (tmp+rename, no leftover .tmp) and leaves a .bak",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "atomic-wf", description: "d", script: "s" });
    const path = join(workflowProjectPaths(cwd).savedDir, "atomic-wf.json");
    assert.ok(existsSync(path), "primary written");
    assert.ok(existsSync(`${path}.bak`), ".bak written");
    assert.equal(existsSync(`${path}.tmp`), false, "no leftover .tmp");
  }),
);

test(
  "createWorkflowStorage save survives a simulated crash mid-write: a rename that never completes leaves the previous good file intact",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd, {
      // Simulate a crash between the .tmp write and the rename: the .tmp
      // lands on disk but the atomic rename into place never happens. The
      // previously-saved good primary must still be there and loadable —
      // exactly the property tmp+rename is supposed to give us.
      renameSync: () => {
        throw new Error("simulated crash before rename completed");
      },
    });
    const goodStorage = createWorkflowStorage(cwd);
    save(goodStorage, { name: "crash-wf", description: "good version", script: "good script" });

    const replacing = goodStorage.load("crash-wf") as SavedWorkflow;
    const failed = storage.save({ name: "crash-wf", description: "new version", script: "new script" }, { replacing });
    assert.equal(failed.ok === false && failed.code, "io-error");
    assert.deepEqual(
      readdirSync(workflowProjectPaths(cwd).savedDir).filter((name) => name.endsWith(".tmp")),
      [],
      "the failed write leaves no temporary file",
    );

    // The primary file must be untouched — still the last good save.
    const recovered = goodStorage.load("crash-wf");
    assert.equal(recovered?.description, "good version", "primary is unaffected by the failed rename");
    assert.equal(recovered?.script, "good script");
  }),
);

test(
  "createWorkflowStorage load recovers from .bak when the primary is corrupt",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "corrupt-recovery", description: "good", script: "good script" });
    const path = join(workflowProjectPaths(cwd).savedDir, "corrupt-recovery.json");
    writeFileSync(path, "{ truncated by a crash", "utf-8");

    const loaded = storage.load("corrupt-recovery");
    assert.ok(loaded, "load falls back to the intact .bak");
    assert.equal(loaded?.script, "good script");
  }),
);

test(
  "createWorkflowStorage delete removes the .bak sidecar too",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "del-bak", description: "d", script: "s" });
    const path = join(workflowProjectPaths(cwd).savedDir, "del-bak.json");
    assert.ok(existsSync(`${path}.bak`), ".bak exists before delete");
    storage.delete(storage.load("del-bak") as SavedWorkflow);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.bak`), false, ".bak cleaned up too");
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Unguarded directory read: list() must degrade to "no files" for a missing
// or unreadable directory instead of throwing (same guard run-persistence.ts
// uses, via the shared listJsonFilesSafe()).
// ═══════════════════════════════════════════════════════════════════════════

test(
  "createWorkflowStorage list returns empty (not throw) when a saved-workflow directory is unreadable",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd, {
      readdirSync: () => {
        throw new Error("EACCES: permission denied, scandir");
      },
    });
    // Make sure the directory actually exists, so the throwing readdirSync
    // path (not the pre-existing existsSync-false path) is what's exercised.
    mkdirSync(workflowProjectPaths(cwd).savedDir, { recursive: true });

    assert.deepEqual(storage.list(), [], "an unreadable directory degrades to an empty list, not a thrown error");
  }),
);

test(
  "createWorkflowStorage list returns empty for a project directory that was never created",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    assert.equal(existsSync(workflowProjectPaths(cwd).savedDir), false, "directory really doesn't exist yet");
    assert.deepEqual(storage.list(), []);
  }),
);

test(
  "strict rename rolls back target and restores source after injected failures",
  withIsolatedHome(async (cwd) => {
    const good = createWorkflowStorage(cwd);
    const source = save(good, { name: "source", description: "source", script: "source" });
    let failBackup = true;
    const flakyBackup = createWorkflowStorage(cwd, {
      writeFileSync: ((path, data, options) => {
        if (failBackup && String(path).endsWith("target.json.bak")) {
          failBackup = false;
          throw new Error("backup write failed");
        }
        return writeFileSync(path, data, options);
      }) as typeof writeFileSync,
    });
    assert.equal(flakyBackup.rename(source, "target").ok, false);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).savedDir, "target.json")), false);
    assert.equal(existsSync(source.path), true);
    assert.equal(existsSync(`${source.path}.bak`), true);
    assert.equal(flakyBackup.rename(source, "target").ok, true);

    const source2 = save(good, { name: "source2", description: "source2", script: "source2" });
    let failDelete = true;
    const flakyDelete = createWorkflowStorage(cwd, {
      unlinkSync: ((path) => {
        if (failDelete && String(path) === source2.path) {
          failDelete = false;
          throw new Error("source delete failed");
        }
        return unlinkSync(path);
      }) as typeof unlinkSync,
    });
    assert.equal(flakyDelete.rename(source2, "target2").ok, false);
    assert.equal(existsSync(source2.path), true);
    assert.equal(existsSync(`${source2.path}.bak`), true);
    assert.equal(existsSync(join(workflowProjectPaths(cwd).savedDir, "target2.json")), false);
    assert.equal(flakyDelete.rename(source2, "target2").ok, true);
  }),
);

test(
  "saved mutations reject a same-path external overwrite as stale",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const source = save(storage, { name: "race", description: "old", script: "old" });
    writeFileSync(source.path, JSON.stringify({ ...source, script: "new" }));
    const renamed = storage.rename(source, "moved");
    const deleted = storage.delete(source);
    assert.equal(renamed.ok, false);
    assert.equal(deleted.ok, false);
    assert.equal(storage.load("race")?.script, "new");
  }),
);

test("resolveSavedScriptPath accepts a relative file inside the saved dir", () => {
  const savedDir = join(tmpdir(), "pi-dw-saved-dir");
  assert.equal(resolveSavedScriptPath(savedDir, "body.js"), resolve(savedDir, "body.js"));
  assert.equal(resolveSavedScriptPath(savedDir, "nested/body.js"), resolve(savedDir, "nested/body.js"));
  assert.equal(resolveSavedScriptPath(savedDir, "./body.js"), resolve(savedDir, "body.js"));
});

test("resolveSavedScriptPath refuses empty, absolute, NUL, and escaping paths", () => {
  const savedDir = join(tmpdir(), "pi-dw-saved-dir");
  assert.equal(resolveSavedScriptPath(savedDir, ""), null);
  assert.equal(resolveSavedScriptPath(savedDir, "   "), null);
  assert.equal(resolveSavedScriptPath(savedDir, "foo\0.js"), null);
  assert.equal(resolveSavedScriptPath(savedDir, "/tmp/outside.js"), null);
  assert.equal(resolveSavedScriptPath(savedDir, "../escape.js"), null);
  assert.equal(resolveSavedScriptPath(savedDir, "nested/../../escape.js"), null);
  assert.equal(resolveSavedScriptPath(savedDir, "."), null);
});

test(
  "createWorkflowStorage load fills script from a relative scriptPath inside the saved dir",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const savedDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(join(savedDir, "from-file.js"), "export const meta = { name: 'from-file' }\n");
    writeFileSync(
      join(savedDir, "from-file.json"),
      JSON.stringify({
        name: "from-file",
        description: "companion script",
        scriptPath: "from-file.js",
        savedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const loaded = storage.load("from-file");
    assert.ok(loaded, "should load");
    assert.equal(loaded?.script, "export const meta = { name: 'from-file' }\n");
    assert.equal("scriptPath" in (loaded as object), false, "scriptPath must not leak onto the loaded row");
  }),
);

test(
  "createWorkflowStorage load fills script from a nested relative scriptPath",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const savedDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(join(savedDir, "scripts"), { recursive: true });
    writeFileSync(join(savedDir, "scripts", "body.js"), "nested script body");
    writeFileSync(
      join(savedDir, "nested.json"),
      JSON.stringify({ name: "nested", description: "nested", scriptPath: "scripts/body.js" }),
    );
    assert.equal(storage.load("nested")?.script, "nested script body");
  }),
);

test(
  "createWorkflowStorage load refuses a scriptPath that escapes the saved dir",
  withIsolatedHome(async (cwd, t) => {
    const warnings = captureWarnings(t);
    const storage = createWorkflowStorage(cwd);
    const savedDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(join(savedDir, "..", "outside.js"), "escaped");
    writeFileSync(
      join(savedDir, "escape.json"),
      JSON.stringify({ name: "escape", description: "bad", scriptPath: "../outside.js" }),
    );
    assert.equal(storage.load("escape"), null);
    assert.deepEqual(storage.list(), []);
    assert.equal(warnings().length, 1, "load and list report the file once");
    assert.match(warnings()[0], /escape\.json: "scriptPath" must be a relative file path inside the saved directory$/);
  }),
);

test(
  "createWorkflowStorage load returns null when scriptPath is missing on disk",
  withIsolatedHome(async (cwd, t) => {
    const warnings = captureWarnings(t);
    const storage = createWorkflowStorage(cwd);
    const savedDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(
      join(savedDir, "missing-js.json"),
      JSON.stringify({ name: "missing-js", description: "gone", scriptPath: "nope.js" }),
    );
    assert.equal(storage.load("missing-js"), null);
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0], /missing-js\.json: cannot read "scriptPath": ENOENT/);
  }),
);

test(
  "createWorkflowStorage load prefers inline script when both script and scriptPath are present",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const savedDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(join(savedDir, "ignored.js"), "from file");
    writeFileSync(
      join(savedDir, "both.json"),
      JSON.stringify({
        name: "both",
        description: "both",
        script: "inline wins",
        scriptPath: "ignored.js",
      }),
    );
    const loaded = storage.load("both");
    assert.equal(loaded?.script, "inline wins");
    assert.equal("scriptPath" in (loaded as object), false);
  }),
);

test(
  "createWorkflowStorage load prefers an empty inline script over scriptPath",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const savedDir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(savedDir, { recursive: true });
    writeFileSync(join(savedDir, "ignored.js"), "from file");
    writeFileSync(
      join(savedDir, "empty-inline.json"),
      JSON.stringify({
        name: "empty-inline",
        description: "empty inline",
        script: "",
        scriptPath: "ignored.js",
      }),
    );
    assert.equal(storage.load("empty-inline")?.script, "");
  }),
);

test(
  "createWorkflowStorage load resolves scriptPath for a user-scoped saved workflow",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "placeholder", description: "create user dir", script: "x" }, "user");
    const userDir = dirname(storage.load("placeholder")?.path ?? "");
    writeFileSync(join(userDir, "user-body.js"), "user companion");
    writeFileSync(
      join(userDir, "user-path.json"),
      JSON.stringify({ name: "user-path", description: "user", scriptPath: "user-body.js" }),
    );
    const loaded = storage.load("user-path");
    assert.equal(loaded?.location, "user");
    assert.equal(loaded?.script, "user companion");
  }),
);

test("a replacing save keeps the previous version as .bak", () => {
  const storage = createWorkflowStorage(mkdtempSync(join(tmpdir(), "pi-dw-bak-")));
  const first = save(storage, { name: "demo", description: "v1", script: "SCRIPT_V1" });
  save(storage, { name: "demo", description: "v2", script: "SCRIPT_V2" }, "project", first);
  const loaded = storage.load("demo");
  assert.equal(loaded?.script, "SCRIPT_V2", "the new version is primary");
  // Corrupt the primary → recovery must yield the PREVIOUS version, not nothing.
  assert.ok(loaded);
  const path = loaded.path;
  writeFileSync(path, "{ truncated");
  const recovered = storage.load("demo");
  assert.equal(recovered?.script, "SCRIPT_V1", "an accidental overwrite leaves the old script recoverable");
});

test(
  "save keeps a valid old .bak when the old primary is corrupt",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const first = save(storage, { name: "corrupt-primary", description: "v1", script: "SCRIPT_V1" });
    writeFileSync(first.path, "{ corrupt primary", "utf8");

    // load() recovers v1 from the backup, and that is what the caller agrees to replace.
    const recovered = storage.load("corrupt-primary") as SavedWorkflow;
    save(storage, { name: "corrupt-primary", description: "v2", script: "SCRIPT_V2" }, "project", recovered);
    assert.equal(JSON.parse(readFileSync(first.path, "utf8")).script, "SCRIPT_V2");
    assert.equal(JSON.parse(readFileSync(`${first.path}.bak`, "utf8")).script, "SCRIPT_V1");
  }),
);

test(
  "a save never overwrites a target it cannot read",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const first = save(storage, { name: "corrupt-both", description: "v1", script: "SCRIPT_V1" });
    writeFileSync(first.path, "{ corrupt primary", "utf8");
    writeFileSync(`${first.path}.bak`, "{ corrupt backup", "utf8");

    const result = storage.save({ name: "corrupt-both", description: "v2", script: "SCRIPT_V2" });
    assert.equal(result.ok === false && result.code, "conflict");
    assert.match(result.ok === false ? result.message : "", /not a readable saved workflow/);
    assert.equal(readFileSync(first.path, "utf8"), "{ corrupt primary", "the damaged file stays for inspection");
  }),
);

test(
  "save succeeds with a backup-write failure and leaves the new primary readable",
  withIsolatedHome(async (cwd) => {
    let failBackupWrite = true;
    const storage = createWorkflowStorage(cwd, {
      writeFileSync: ((path, data, options) => {
        if (failBackupWrite && String(path).endsWith("backup-write-failure.json.bak")) {
          failBackupWrite = false;
          throw new Error("injected backup write failure");
        }
        return writeFileSync(path, data, options);
      }) as typeof writeFileSync,
    });

    assert.doesNotThrow(() =>
      save(storage, { name: "backup-write-failure", description: "new", script: "SCRIPT_NEW" }),
    );
    assert.equal(failBackupWrite, false, "the backup write failure must be exercised");
    const path = join(workflowProjectPaths(cwd).savedDir, "backup-write-failure.json");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).script, "SCRIPT_NEW");
  }),
);

test(
  "a save never overwrites a workflow its caller has not seen",
  withIsolatedHome(async (cwd) => {
    const windowA = createWorkflowStorage(cwd);
    const windowB = createWorkflowStorage(cwd);
    const original = save(windowA, { name: "shared", description: "v1", script: "V1" });

    const conflict = windowB.save({ name: "shared", description: "fresh", script: "FRESH" });
    assert.equal(conflict.ok === false && conflict.code, "conflict", "a create cannot land on an existing workflow");

    save(windowA, { name: "shared", description: "v2", script: "V2" }, "project", original);
    const stale = windowB.save({ name: "shared", description: "v3", script: "V3" }, { replacing: original });
    assert.equal(stale.ok === false && stale.code, "stale", "replacing a version another window replaced is refused");
    assert.equal(windowA.load("shared")?.script, "V2");

    const deleted = windowB.delete(original);
    assert.equal(deleted.ok === false && deleted.code, "stale", "deleting by an old row is refused");
    assert.equal(windowA.load("shared")?.script, "V2");
  }),
);

test(
  "a change while another live process holds the saved-workflow lock reports busy and writes nothing",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "placeholder", description: "creates both dirs", script: "x" });
    save(storage, { name: "user-placeholder", description: "creates the user dir", script: "x" }, "user");
    const lock = join(workflowProjectPaths(cwd).savedDir, ".saved-workflows.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "another-window" }));

    const result = storage.save({ name: "blocked", description: "d", script: "s" });
    assert.equal(result.ok === false && result.code, "busy");
    assert.equal(storage.load("blocked"), null);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "another-window", "the other window keeps its lock");
  }),
);

test(
  "a file whose name field does not match its file name is skipped",
  withIsolatedHome(async (cwd, t) => {
    const warnings = captureWarnings(t);
    const storage = createWorkflowStorage(cwd);
    const dir = workflowProjectPaths(cwd).savedDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "foo.json"), JSON.stringify({ name: "bar", description: "d", script: "s" }));
    writeFileSync(join(dir, "Mixed.json"), JSON.stringify({ name: "mixed", description: "d", script: "s" }));
    assert.deepEqual(
      storage.list().map((workflow) => workflow.name),
      [],
    );
    assert.equal(storage.load("bar"), null);
    assert.ok(warnings().some((message) => message.includes("must match exactly")));
  }),
);

test(
  "a saved workflow keeps the toolset its runs need",
  withIsolatedHome(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    save(storage, { name: "research", description: "d", script: "s", toolset: "web-research" });
    assert.equal(createWorkflowStorage(cwd).load("research")?.toolset, "web-research");
  }),
);
