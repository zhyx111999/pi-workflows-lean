import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowManager } from "./workflow-manager.js";
export declare const WORKFLOW_TAIL_CHARS = 8000;
export declare const WORKFLOW_TAIL_TOOL_NAME = "workflow_tail";
declare const workflowTailSchema: Type.TObject<{
    runId: Type.TOptional<Type.TString>;
    label: Type.TOptional<Type.TString>;
}>;
type TailAgent = {
    id: number;
    label: string;
    phase?: string;
    status: string;
    history?: AgentHistoryEntry[];
    result?: unknown;
    error?: string;
    endedAt?: string;
};
export interface WorkflowTailToolOptions {
    getManager: () => WorkflowManager;
}
export declare function selectTailAgent(agents: readonly TailAgent[], label?: string): TailAgent | undefined;
export declare function renderAgentTail(agent: TailAgent, maxChars?: number): string;
export declare function createWorkflowTailTool(options: WorkflowTailToolOptions): ToolDefinition<typeof workflowTailSchema>;
export {};
