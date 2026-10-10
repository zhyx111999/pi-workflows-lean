/** Run actions started from the navigator: confirmed pause and stop, and restart from the saved script. */
/** Apply a confirmed pause or stop, re-checking the run's status first. */
export function executeRunConfirmation(session, action, runId) {
    const { manager, ui, model } = session;
    const item = model.runs().find((candidate) => candidate.runId === runId);
    if (!item)
        return;
    const status = item.status;
    if (action === "pause") {
        if (status !== "running") {
            ui.notify(`Cannot pause ${runId}`, "warning");
            return;
        }
        ui.notify(manager.pause(runId) ? `Paused ${runId}` : `Cannot pause ${runId}`, "info");
    }
    else if (action === "stop") {
        if (status !== "running" && status !== "paused") {
            ui.notify(`Cannot stop ${runId}`, "warning");
            return;
        }
        ui.notify(manager.stop(runId) ? `Stopped ${runId}` : `Cannot stop ${runId}`, "info");
    }
}
/** Start a new background run from the selected run's script and arguments. */
export function restartRun(session, runId) {
    const { manager, ui } = session;
    const run = runId ? manager.listRuns().find((candidate) => candidate.runId === runId) : undefined;
    if (!run?.script) {
        ui.notify(runId ? `Cannot restart ${runId} (no script saved)` : "No run selected to restart", "warning");
        return;
    }
    try {
        const { runId: newId } = manager.startInBackground(run.script, run.args);
        ui.notify(`Restarted ${run.workflowName || "workflow"} as ${newId}`, "info");
    }
    catch (error) {
        ui.notify(`Failed to restart ${run.workflowName || "workflow"}: ${error instanceof Error ? error.message : error}`, "error");
    }
}
