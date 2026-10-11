/** Saved-workflow actions started from the navigator: save a run, rename, and delete, keeping `/name` commands in sync. */
import { registerSavedWorkflow, savedWorkflowCommandAvailability } from "../saved-commands.js";
import { isSafeSavedWorkflowName } from "../workflow-saved.js";
import { sameIdentity, savedIdentity } from "./items.js";
import { currentStorage } from "./session.js";
/** Register `/<name>` for a saved workflow, resolving manager and storage live at run time. */
function registerSavedCommand(session, saved) {
    const { pi, manager, options } = session;
    return registerSavedWorkflow(pi, saved, options.getManager ?? (() => manager), () => currentStorage(session)?.load(saved.name));
}
function findSaved(session, target) {
    return session.model.saved().find((candidate) => sameIdentity(target, savedIdentity(candidate)));
}
/** Save the selected run's script as a project workflow and register its command. */
export function saveRunAsWorkflow(session, runId) {
    const { pi, manager, ui } = session;
    const run = runId ? manager.listRuns().find((candidate) => candidate.runId === runId) : undefined;
    const storage = currentStorage(session);
    if (!run?.script) {
        ui.notify("No saved run script to save", "warning");
        return;
    }
    if (!storage) {
        ui.notify("Saving is not available (no storage)", "error");
        return;
    }
    const name = run.workflowName || "workflow";
    const availability = savedWorkflowCommandAvailability(pi, name);
    if (!availability.ok) {
        ui.notify(availability.message, "error");
        return;
    }
    try {
        const saved = storage.save({ name, description: run.workflowName, script: run.script, location: "project" });
        const registered = registerSavedCommand(session, saved);
        ui.notify(registered.ok ? `Saved /${name}` : `Saved /${name}, but ${registered.message}`, registered.ok ? "info" : "error");
    }
    catch (error) {
        ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
}
/** Apply the typed rename to the workflow it was started on, then move its command. */
export function commitRename(session) {
    const { pi, ui, model, state } = session;
    if (!isSafeSavedWorkflowName(state.draft)) {
        ui.notify("Saved workflow name must be a non-empty slash-command-safe name without whitespace, controls, or paths.", "warning");
        return;
    }
    const rename = state.takeRename();
    if (!rename)
        return;
    const workflow = findSaved(session, rename.target);
    if (!workflow) {
        ui.notify("Saved workflow no longer exists.", "warning");
        return;
    }
    if (rename.name === workflow.name) {
        ui.notify(`Kept /${workflow.name}`, "info");
        return;
    }
    const availability = savedWorkflowCommandAvailability(pi, rename.name);
    if (!availability.ok) {
        ui.notify(availability.message, "error");
        return;
    }
    const result = model.renameSaved(workflow, rename.name);
    if (!result.ok) {
        ui.notify(result.message, "error");
        return;
    }
    if (!result.workflow) {
        ui.notify("Rename did not return a saved workflow.", "error");
        return;
    }
    const saved = result.workflow;
    state.replaceSavedIdentity(rename.target, saved);
    const registered = registerSavedCommand(session, saved);
    if (!registered.ok)
        ui.notify(`Renamed /${workflow.name} to /${saved.name}, but ${registered.message}`, "error");
    else
        ui.notify(`Renamed /${workflow.name} to /${saved.name}`, "info");
}
/** Delete the confirmed saved workflow, leaving its detail page if that is where the user was. */
export function deleteSavedWorkflow(session, target) {
    const { ui, model, state } = session;
    const workflow = findSaved(session, target);
    if (!workflow) {
        ui.notify("Saved workflow no longer exists.", "warning");
        return;
    }
    const result = model.deleteSaved(workflow);
    if (result.ok)
        ui.notify(`Deleted /${workflow.name}`, "info");
    else
        ui.notify(result.message, "error");
    if (result.ok && state.kind === "savedDetail")
        state.back();
}
