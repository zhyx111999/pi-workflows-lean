/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a
 * command that runs its script, passing parsed arguments through as `args`.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";
/**
 * Pi cannot unregister a slash command. Distinguish commands this extension
 * owns from built-ins/other extensions before a save or rename reaches disk.
 */
export declare function savedWorkflowCommandAvailability(pi: ExtensionAPI, name: string): {
    ok: true;
} | {
    ok: false;
    message: string;
};
export declare function parseCommandArgs(raw: string, parameters?: SavedWorkflow["parameters"]): Record<string, unknown>;
/** Register one saved workflow as a dynamically loaded slash command. */
export declare function registerSavedWorkflow(pi: ExtensionAPI, cwd: string | (() => string), wf: Pick<SavedWorkflow, "name" | "description" | "script" | "parameters">, manager?: WorkflowManager | (() => WorkflowManager | undefined), exists?: () => boolean, loadWorkflow?: () => Pick<SavedWorkflow, "name" | "description" | "script" | "parameters"> | null | undefined): {
    ok: true;
} | {
    ok: false;
    message: string;
};
export declare function registerAllSavedWorkflows(pi: ExtensionAPI, cwd: string | (() => string), storage: WorkflowStorage | (() => WorkflowStorage), manager?: WorkflowManager | (() => WorkflowManager | undefined)): void;
