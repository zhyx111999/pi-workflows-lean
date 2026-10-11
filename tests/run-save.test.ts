import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitRunSave, planRunSave, replacedWorkflowLabel } from "../src/run-save.js";
import { createWorkflowStorage, type WorkflowStorage } from "../src/workflow-saved.js";

function withStorage(fn: (storage: WorkflowStorage) => void) {
  return () => {
    const cwd = mkdtempSync(join(tmpdir(), "pwl-run-save-"));
    try {
      fn(createWorkflowStorage(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

const draft = { name: "scan", description: "scan", script: "return 'new'" };

test(
  "planRunSave creates a missing workflow and skips identical content",
  withStorage((storage) => {
    const created = planRunSave(storage, draft);
    assert.equal(created.kind, "create");
    if (created.kind !== "create") return;
    const result = commitRunSave(storage, created);
    assert.ok(result.ok);
    assert.equal(planRunSave(storage, draft).kind, "unchanged");
  }),
);

test(
  "planRunSave treats declared parameters as different content",
  withStorage((storage) => {
    storage.save({ ...draft, parameters: { topic: { type: "string" } }, location: "project" });
    assert.equal(planRunSave(storage, draft).kind, "replace");
  }),
);

test(
  "replacing a user workflow writes a project copy and leaves the user file",
  withStorage((storage) => {
    // User workflows live under the shared home, so this one gets its own name.
    const shadowing = { ...draft, name: "shadowed" };
    const user = storage.save({ ...shadowing, script: "return 'user'", location: "user" }, "user");
    const plan = planRunSave(storage, shadowing);
    assert.equal(plan.kind, "replace");
    if (plan.kind !== "replace") return;
    assert.equal(replacedWorkflowLabel(plan.existing), "user workflow /shadowed");
    const result = commitRunSave(storage, plan);
    assert.ok(result.ok);
    assert.equal(result.workflow.location, "project");
    assert.equal(storage.load("shadowed")?.script, draft.script);
    assert.equal((JSON.parse(readFileSync(user.path, "utf8")) as { script: string }).script, "return 'user'");
  }),
);

test(
  "commitRunSave refuses a create once a workflow of that name appeared",
  withStorage((storage) => {
    const plan = planRunSave(storage, draft);
    assert.equal(plan.kind, "create");
    if (plan.kind !== "create") return;
    storage.save({ ...draft, script: "return 'other'", location: "project" });
    const result = commitRunSave(storage, plan);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "stale");
    assert.equal(storage.load("scan")?.script, "return 'other'");
  }),
);
