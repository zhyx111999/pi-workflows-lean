/**
 * `/workflows` slash command: list, inspect, and control background workflow runs.
 * Shares the extension's single WorkflowManager so background runs are reachable.
 */
import { fmtFull, fmtTokenSegment, recomputeWorkflowSnapshot, renderWorkflowText, runStatusIcon, tokenFigures, } from "./display.js";
import { runSummary } from "./run-record-store.js";
import { commitRunSave, planRunSave, replacedWorkflowLabel } from "./run-save.js";
import { registerSavedWorkflow } from "./saved-commands.js";
import { SUBAGENTS_TOOL_NAME } from "./subagents-tool.js";
import { buildForcedWorkflowPrompt } from "./workflow-editor.js";
import { openWorkflowNavigator } from "./workflow-ui.js";
const USAGE = "Usage: /workflows [list] | run <prompt> | status <id> | watch <id> | stop <id> | pause <id> | resume <id> | rm <id> | save <name> [runId]";
const RUN_USAGE = "Usage: /workflows run <prompt> — force a dynamic workflow from the prompt";
function summarizeRun(run) {
    const icon = runStatusIcon(run.status);
    const { done, total } = runSummary(run);
    const segment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
    const tokens = segment ? ` · ${segment}` : "";
    return `${icon} ${run.runId}  ${run.workflowName} [${run.status}] ${done}/${total} agents${tokens}`;
}
function oneLineProgress(snapshot) {
    const total = snapshot.agents.length;
    const done = snapshot.agents.filter((a) => a.status === "done").length;
    const running = snapshot.agents.filter((a) => a.status === "running").length;
    const errs = snapshot.agents.filter((a) => a.status === "error").length;
    const phase = snapshot.currentPhase ? ` · ${snapshot.currentPhase}` : "";
    return `◆ ${snapshot.name}: ${done}/${total} done${running ? `, ${running} running` : ""}${errs ? `, ${errs} err` : ""}${phase}`;
}
/**
 * Subscribe to a running run's events and stream live progress to the status bar,
 * printing the final snapshot when it finishes. Non-blocking: returns true if the
 * run was active and is now being watched, false otherwise. Listeners clean up on
 * completion so nothing leaks.
 */
function watchRun(manager, pi, ctx, id) {
    const active = manager.getRun(id);
    if (active?.status !== "running")
        return false;
    const key = `wf:${id}`;
    const update = () => {
        const run = manager.getRun(id);
        if (run)
            ctx.ui.setStatus(key, oneLineProgress(run.snapshot));
    };
    const onEvent = (e) => {
        if (!e || e.runId === id)
            update();
    };
    let settled = false;
    const progressEvents = ["agentStart", "agentEnd", "phase", "log", "tokenUsage"];
    const finalEvents = ["complete", "error", "stopped", "paused", "deleted"];
    const finish = (e) => {
        if (e && e.runId !== id)
            return;
        if (settled)
            return;
        settled = true;
        for (const ev of progressEvents)
            manager.off(ev, onEvent);
        for (const ev of finalEvents)
            manager.off(ev, finish);
        try {
            ctx.ui.setStatus(key, undefined);
            const run = manager.getRun(id);
            if (run) {
                pi.sendMessage({
                    customType: "workflows",
                    content: renderWorkflowText(recomputeWorkflowSnapshot(run.snapshot), true),
                    display: true,
                });
            }
        }
        catch {
            // Listeners are already removed; a stale-ctx/UI failure is not actionable.
        }
    };
    for (const ev of progressEvents)
        manager.on(ev, onEvent);
    for (const ev of finalEvents)
        manager.on(ev, finish);
    update();
    return true;
}
function renderPersistedStatus(run) {
    const lines = [`${runStatusIcon(run.status)} ${run.workflowName} (${run.runId}) — ${run.status}`];
    if (run.currentPhase)
        lines.push(`  phase: ${run.currentPhase}`);
    for (const agent of run.agents) {
        const icon = agent.status === "done" ? "✓" : agent.status === "error" ? "✗" : agent.status === "running" ? "◆" : "·";
        lines.push(`  ${icon} ${agent.label}`);
    }
    const tokenSegment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
    if (tokenSegment)
        lines.push(`  tokens: ${tokenSegment}`);
    if (run.durationMs)
        lines.push(`  duration: ${(run.durationMs / 1000).toFixed(1)}s`);
    return lines.join("\n");
}
/**
 * Ask before a save replaces a different workflow of the same name. Without a
 * UI to ask, the save is refused rather than overwriting silently.
 */
async function confirmReplace(ctx, plan, runId) {
    const { name } = plan.draft;
    const target = `${replacedWorkflowLabel(plan.existing)} (${plan.existing.path})`;
    if (!ctx.hasUI) {
        ctx.ui.notify(`Not saved: the ${target} already exists. Replacing it needs confirmation in an interactive session; choose another name to save here.`, "warning");
        return false;
    }
    const shadowed = plan.existing.location === "user" ? " The user file stays; the new project workflow takes precedence." : "";
    if (await ctx.ui.confirm(`Replace /${name}?`, `Replace the ${target} with the script of run ${runId}?${shadowed}`)) {
        return true;
    }
    ctx.ui.notify(`Kept the existing /${name}`, "info");
    return false;
}
/**
 * `/workflows save <name> [runId]`: save the named run's script, else the most
 * recent one that kept its script, as a project workflow and register `/name`.
 * Saving the content `/name` already has writes nothing, so its backup keeps
 * the version before it.
 */
async function saveRunCommand(pi, { getManager, getStorage }, ctx, name, runIdArg) {
    const storage = getStorage();
    const runs = getManager().listRuns();
    const run = runIdArg ? runs.find((r) => r.runId === runIdArg) : runs.find((r) => r.script);
    if (!run?.script) {
        ctx.ui.notify(runIdArg ? `No run ${runIdArg} with a script` : "No saved run to save", "error");
        return;
    }
    const plan = planRunSave(storage, { name, description: run.workflowName, script: run.script });
    let saved;
    if (plan.kind === "unchanged") {
        saved = plan.existing;
    }
    else {
        if (plan.kind === "replace" && !(await confirmReplace(ctx, plan, run.runId)))
            return;
        const result = commitRunSave(storage, plan);
        if (!result.ok) {
            ctx.ui.notify(result.message, result.code === "stale" ? "warning" : "error");
            return;
        }
        saved = result.workflow;
    }
    // Always re-resolve storage at invocation — do not close over the
    // instance from this save call, or a later project switch leaves
    // the loader pointed at the source project's store.
    const registration = registerSavedWorkflow(pi, saved, getManager, () => getStorage().load(name));
    const unchanged = plan.kind === "unchanged";
    // Surface a refused registration: the file persisted,
    // but a host/extension-owned name never becomes a slash command —
    // reporting plain success would silently mislead.
    if (registration.ok) {
        ctx.ui.notify(`${unchanged ? `/${name} is already saved with this script` : `Saved /${name}`} (from ${run.runId})`, "info");
    }
    else {
        ctx.ui.notify(`${unchanged ? `"${name}" is already in the library` : `Saved "${name}" to the library`}, but it cannot be registered as a slash command: ${registration.message}`, "warning");
    }
}
/** Register the `/workflows` command against the shared manager. Idempotent. */
export function registerWorkflowCommands(pi, deps) {
    const { getManager, getStorage } = deps;
    try {
        const taken = (pi.getCommands?.() ?? []).some((c) => c.name === "workflows");
        if (taken)
            return;
    }
    catch {
        // getCommands may be unavailable in some hosts; fall through and try to register.
    }
    pi.registerCommand("workflows", {
        description: "Manage workflow runs — no args (opens navigator) | run <prompt> | status/stop/pause/resume <id> | rm <id> | save <name> [runId]",
        async handler(args, ctx) {
            const manager = getManager();
            const parts = args.trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "list").toLowerCase();
            const id = parts[1];
            const print = (text) => pi.sendMessage({ customType: "workflows", content: text, display: true });
            switch (sub) {
                case "run": {
                    const prompt = args
                        .trim()
                        .slice(parts[0]?.length ?? 0)
                        .trim();
                    if (!prompt) {
                        ctx.ui.notify(RUN_USAGE, "warning");
                        return;
                    }
                    // Best-effort: ensure the subagents tool is active (session_start usually has).
                    // Add-only so tools enabled by the user or other extensions stay active.
                    try {
                        const active = pi.getActiveTools?.() ?? [];
                        if (!active.includes(SUBAGENTS_TOOL_NAME))
                            pi.setActiveTools?.([...active, SUBAGENTS_TOOL_NAME]);
                    }
                    catch {
                        // ignore — the forced directive is the real forcing primitive
                    }
                    // The parent tail prompt leaves delegation to the model's judgement;
                    // this explicit command asks for a workflow, so it sends the forcing directive.
                    const directive = buildForcedWorkflowPrompt(prompt);
                    ctx.ui.notify(`Running workflow: ${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}`, "info");
                    try {
                        await pi.sendMessage({ customType: "workflow-run", content: directive, display: true }, { triggerTurn: true, deliverAs: "followUp" });
                    }
                    catch {
                        ctx.ui.notify("Could not start the workflow turn.", "error");
                    }
                    return;
                }
                case "ui":
                case "list": {
                    // Interactive navigator only in the TUI — it is a ui.custom()
                    // component, which no-ops in RPC hosts even though ctx.hasUI is true
                    // there (dialogs and notifications work over the RPC extension-UI
                    // protocol; custom components do not). Everything else, including
                    // an explicit `list`, gets the plain-text run list.
                    const wantsNavigator = sub !== "list" || parts.length === 0;
                    if (wantsNavigator && ctx.mode === "tui") {
                        await openWorkflowNavigator(pi, manager, ctx.ui, { getStorage, getManager });
                        return;
                    }
                    const runs = manager.listRuns();
                    if (!runs.length) {
                        await print("No workflow runs yet. Start one with /workflows run <prompt>.");
                        return;
                    }
                    await print(["Workflow runs:", ...runs.map(summarizeRun), "", USAGE].join("\n"));
                    return;
                }
                case "watch":
                case "status": {
                    if (!id) {
                        ctx.ui.notify(USAGE, "warning");
                        return;
                    }
                    // A running run streams live progress to the status bar and prints the
                    // final snapshot when it finishes — no need to re-run the command.
                    if (watchRun(manager, pi, ctx, id)) {
                        ctx.ui.notify(ctx.mode === "tui"
                            ? `Watching ${id} — live progress in the status bar; result prints when it finishes.`
                            : `Watching ${id} — the final status prints here when it finishes.`, "info");
                        return;
                    }
                    // The record decides whether the run exists, as it does for subagents_control.
                    const run = manager.findRun(id);
                    if (!run) {
                        ctx.ui.notify(`No workflow run "${id}"`, "error");
                        return;
                    }
                    const live = manager.getSnapshot(id);
                    await print(live ? renderWorkflowText(recomputeWorkflowSnapshot(live), false) : renderPersistedStatus(run));
                    return;
                }
                case "stop": {
                    if (!id)
                        return ctx.ui.notify(USAGE, "warning");
                    if (manager.stop(id))
                        return ctx.ui.notify(`Stopped ${id}`, "info");
                    ctx.ui.notify(manager.findRun(id) ? `Cannot stop ${id} (not running)` : `No run ${id}`, "warning");
                    return;
                }
                case "pause": {
                    if (!id)
                        return ctx.ui.notify(USAGE, "warning");
                    ctx.ui.notify(manager.pause(id) ? `Paused ${id}` : `Cannot pause ${id} (not running)`, "info");
                    return;
                }
                case "resume": {
                    if (!id)
                        return ctx.ui.notify(USAGE, "warning");
                    if (await manager.resume(id, { claimDelivery: true }))
                        return ctx.ui.notify(`Resumed ${id}`, "info");
                    ctx.ui.notify(manager.findRun(id) ? `Resume not available for ${id} yet` : `No run ${id}`, "warning");
                    return;
                }
                case "rm": {
                    if (!id)
                        return ctx.ui.notify(USAGE, "warning");
                    if (manager.deleteRun(id)) {
                        ctx.ui.notify(`Removed ${id}`, "info");
                        return;
                    }
                    // Distinguish a lease refusal from "no such run": the run may exist
                    // but be leased by a live process
                    // (resumed/running in another session) — saying "No run" would lie
                    // while that process burns tokens.
                    const known = manager.getRun(id) ?? manager.getPersistence().loadPreview(id);
                    ctx.ui.notify(known ? `Cannot remove ${id}: it is active in another live session` : `No run ${id}`, known ? "warning" : "info");
                    return;
                }
                case "save": {
                    if (!id)
                        return ctx.ui.notify("Usage: /workflows save <name> [runId]", "warning");
                    await saveRunCommand(pi, deps, ctx, id, parts[2]);
                    return;
                }
                default:
                    ctx.ui.notify(`Unknown subcommand "${sub}". ${USAGE}`, "warning");
            }
        },
    });
}
