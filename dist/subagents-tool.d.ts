/**
 * The `subagents` tool: start a background run from a task list, a workflow
 * script, or a saved/built-in workflow name, and return its run ID at once.
 */
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type SubagentTask } from "./subagent-tasks.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
export declare const SUBAGENTS_TOOL_NAME = "subagents";
/** The single always-on gate: it authorizes delegation without forcing it. */
export declare const SUBAGENTS_GATE_GUIDELINE = "Whether to call subagents is decided by the note appended to the user message.";
declare const subagentsSchema: Type.TObject<{
    tasks: Type.TOptional<Type.TArray<Type.TObject<{
        label: Type.TString;
        task: Type.TString;
        model: Type.TOptional<Type.TString>;
    }>>>;
    script: Type.TOptional<Type.TString>;
    name: Type.TOptional<Type.TString>;
    args: Type.TOptional<Type.TUnsafe<Record<string, unknown>>>;
}>;
/** Exactly one way to start a run. */
export type SubagentsInput = {
    tasks: SubagentTask[];
} | {
    script: string;
    args?: Record<string, unknown>;
} | {
    name: string;
    args?: Record<string, unknown>;
};
/** Live host state, read at call time because the extension may rebuild it on session_start. */
export interface SubagentsToolHost {
    getManager(): WorkflowManager;
    getStorage(): WorkflowStorage;
    getCwd(): string;
}
export declare function createSubagentsTool(host: SubagentsToolHost): ToolDefinition<typeof subagentsSchema, {
    runId: string;
}>;
/** Tool result for a started run: where the result goes and what the turn should do now. */
export declare function startedText(runId: string, started: string): string;
/** Strip one whole-script Markdown fence that models sometimes wrap code in. */
export declare function normalizeScript(script: string): string;
/** A field counts as given only when it holds a value: providers may fill unused fields with null or "". */
export declare function isGiven(value: unknown): boolean;
export {};
