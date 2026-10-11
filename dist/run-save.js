/**
 * Saving a run's script as a project workflow, shared by `/workflows save` and
 * the navigator. A name that already holds a different workflow is replaced
 * only after the caller has asked the user; saving identical content again
 * writes nothing, so the backup still holds the version before it.
 */
import { savedWorkflowRevision } from "./workflow-saved.js";
export function planRunSave(storage, draft) {
    const existing = storage.load(draft.name);
    if (!existing)
        return { kind: "create", draft };
    return sameContent(existing, draft) ? { kind: "unchanged", existing } : { kind: "replace", draft, existing };
}
/** A save writes no parameters, so an existing workflow that declares some is different content. */
function sameContent(existing, draft) {
    return (existing.script === draft.script &&
        existing.description === draft.description &&
        Object.keys(existing.parameters ?? {}).length === 0);
}
/** Which workflow a replace affects, for the question the user answers; callers also show its path. */
export function replacedWorkflowLabel(existing) {
    return `${existing.location} workflow /${existing.name}`;
}
/**
 * Write a planned save, but only while `/name` still resolves to what the plan
 * was made against: a workflow saved, edited, or deleted since then is not
 * what the user agreed to replace.
 */
export function commitRunSave(storage, plan) {
    const { name } = plan.draft;
    try {
        const expected = plan.kind === "replace" ? plan.existing : null;
        if (!sameSource(storage.load(name), expected)) {
            return { ok: false, code: "stale", message: `/${name} changed after it was checked; nothing was saved.` };
        }
        return { ok: true, workflow: storage.save({ ...plan.draft, location: "project" }) };
    }
    catch (error) {
        return { ok: false, code: "failed", message: error instanceof Error ? error.message : String(error) };
    }
}
function sameSource(current, expected) {
    if (!current || !expected)
        return current === expected;
    return current.path === expected.path && savedWorkflowRevision(current) === savedWorkflowRevision(expected);
}
