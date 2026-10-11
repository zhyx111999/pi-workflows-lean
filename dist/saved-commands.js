/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a
 * command that runs its script, passing parsed arguments through as `args`.
 */
import { claimCommand, commandOwner, isCommandRegistered } from "./command-registry.js";
import { backgroundStartNotice } from "./display.js";
function savedCommandOwnedByExtension(pi, name) {
    const owner = commandOwner(pi, name);
    return owner === "builtin" || owner === "saved";
}
/**
 * Pi cannot unregister a slash command. Distinguish commands this extension
 * owns from built-ins/other extensions before a save or rename reaches disk.
 */
export function savedWorkflowCommandAvailability(pi, name) {
    if (!isCommandRegistered(pi, name) || savedCommandOwnedByExtension(pi, name))
        return { ok: true };
    return { ok: false, message: `/${name} is already provided by Pi or another extension.` };
}
export function parseCommandArgs(raw, parameters) {
    const out = {};
    const positional = [];
    for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
        const eq = token.indexOf("=");
        if (eq > 0)
            out[token.slice(0, eq)] = token.slice(eq + 1);
        else
            positional.push(token);
    }
    out._ = positional.join(" ");
    out._raw = raw.trim();
    for (const [key, spec] of Object.entries(parameters ?? {})) {
        if (out[key] === undefined && spec.default !== undefined)
            out[key] = spec.default;
    }
    return out;
}
/**
 * Register `/<name>` for a saved workflow. `load` re-reads the workflow at each
 * invocation: Pi cannot unregister a command, so after a rename or delete the
 * lingering command must find nothing rather than run a frozen script.
 */
export function registerSavedWorkflow(pi, wf, getManager, load) {
    const availability = savedWorkflowCommandAvailability(pi, wf.name);
    if (!availability.ok)
        return availability;
    if (isCommandRegistered(pi, wf.name))
        return { ok: true };
    try {
        pi.registerCommand(wf.name, {
            description: wf.description || `Saved workflow: ${wf.name}`,
            async handler(args, ctx) {
                const live = load();
                if (!live) {
                    ctx.ui.notify(`/${wf.name} is not available in this project — reload the session to drop the stale command.`, "warning");
                    return;
                }
                try {
                    const { runId } = getManager().startInBackground(live.script, parseCommandArgs(args, live.parameters));
                    ctx.ui.notify(backgroundStartNotice(live.name, runId, ctx.mode, "result"), "info");
                }
                catch (error) {
                    ctx.ui.notify(`/${live.name} failed: ${error instanceof Error ? error.message : error}`, "error");
                }
            },
        });
        claimCommand(pi, wf.name, "saved");
        return { ok: true };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
export function registerAllSavedWorkflows(pi, getStorage, getManager) {
    for (const workflow of getStorage().list()) {
        registerSavedWorkflow(pi, workflow, getManager, () => getStorage().load(workflow.name));
    }
}
