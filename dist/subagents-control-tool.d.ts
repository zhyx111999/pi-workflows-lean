/**
 * The `subagents_control` tool: list, inspect, read, stop, resume, and message
 * background runs started by `subagents`.
 */
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type SubagentTask } from "./subagent-tasks.js";
import type { WorkflowManager } from "./workflow-manager.js";
export declare const SUBAGENTS_CONTROL_TOOL_NAME = "subagents_control";
declare const ACTIONS: readonly ["list", "status", "read", "stop", "resume", "message"];
export type SubagentsControlAction = (typeof ACTIONS)[number];
declare const subagentsControlSchema: Type.TObject<{
    action: Type.TUnsafe<"stop" | "status" | "message" | "read" | "resume" | "list">;
    runId: Type.TOptional<Type.TString>;
    label: Type.TOptional<Type.TString>;
    text: Type.TOptional<Type.TString>;
    tasks: Type.TOptional<Type.TUnsafe<SubagentTask[]>>;
    script: Type.TOptional<Type.TString>;
    checkpointId: Type.TOptional<Type.TString>;
    response: Type.TOptional<Type.TUnknown>;
}>;
/** One validated request; only the fields its action uses survive. */
export type SubagentsControlInput = {
    action: "list";
} | {
    action: "status" | "stop";
    runId: string;
} | {
    action: "read";
    runId?: string;
    label?: string;
} | {
    action: "message";
    runId: string;
    label: string;
    text: string;
} | {
    action: "resume";
    runId: string;
    tasks?: SubagentTask[];
    script?: string;
} | {
    action: "resume";
    runId: string;
    checkpointId: string;
    response: unknown;
};
export interface SubagentsControlToolHost {
    getManager(): WorkflowManager;
}
export declare function createSubagentsControlTool(host: SubagentsControlToolHost): ToolDefinition<typeof subagentsControlSchema, Record<string, unknown>>;
export {};
