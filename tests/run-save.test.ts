import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitRunSave, planRunSave, replacedWorkflowLabel, runSaveDraft } from "../src/run-save.js";
import { createWorkflowStorage, type SavedWorkflowDraft, type WorkflowStorage } from "../src/workflow-saved.js";

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
  "a run's toolset is part of what it saves, and of whether content is unchanged",
  withStorage((storage) => {
    const draftFor = (toolset?: string) =>
      runSaveDraft({ workflowName: "research", script: "return 1", toolset }, "research") as SavedWorkflowDraft;
    assert.equal(draftFor("web-research").toolset, "web-research");
    const created = planRunSave(storage, draftFor("web-research"));
    assert.ok(created.kind === "create" && commitRunSave(storage, created).ok);
    assert.equal(planRunSave(storage, draftFor("web-research")).kind, "unchanged");
    assert.equal(planRunSave(storage, draftFor(undefined)).kind, "replace", "losing the toolset is a change");
  }),
);

test(
  "planRunSave treats declared parameters as different content",
  withStorage((storage) => {
    assert.ok(storage.save({ ...draft, parameters: { topic: { default: "x" } } }).ok);
    assert.equal(planRunSave(storage, draft).kind, "replace");
  }),
);

test(
  "replacing a user workflow writes a project copy and leaves the user file",
  withStorage((storage) => {
    // User workflows live under the shared home, so this one gets its own name.
    const shadowing = { ...draft, name: "shadowed" };
    const saved = storage.save({ ...shadowing, script: "return 'user'" }, { location: "user" });
    assert.ok(saved.ok);
    const user = saved.workflow;
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
    assert.ok(storage.save({ ...draft, script: "return 'other'" }).ok);
    const result = commitRunSave(storage, plan);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "stale");
    assert.equal(storage.load("scan")?.script, "return 'other'");
  }),
);
