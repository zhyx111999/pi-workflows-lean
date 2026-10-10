import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { PersistedRunState, RunStatus } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";
declare const workflowControlSchema: Type.TObject<{
    action: Type.TUnion<[Type.TLiteral<"list">, Type.TLiteral<"status">, Type.TLiteral<"pause">, Type.TLiteral<"resume">, Type.TLiteral<"stop">]>;
    runId: Type.TOptional<Type.TString>;
    checkpointId: Type.TOptional<Type.TString>;
}>;
export type WorkflowControlInput = Static<typeof workflowControlSchema>;
export interface WorkflowControlToolOptions {
    manager?: WorkflowManager;
    /** Live manager accessor; prefer over a closed-over manager when the extension may replace it. */
    getManager?: () => WorkflowManager;
}
export interface WorkflowControlRunDetails {
    runId: string;
    workflowName: string;
    status: RunStatus;
    phase: string | null;
    checkpoint: Pick<NonNullable<PersistedRunState["checkpoint"]>, "checkpointId" | "kind" | "status"> | null;
    counts: {
        total: number;
        done: number;
        running: number;
        queued: number;
        error: number;
        skipped: number;
    };
    activeLabels: string[];
    tokenTotal: number;
    /** True when tokenTotal includes character-heuristic estimates (#209). */
    /** Always emitted by the built-in tool; optional only for external constructors of this exported shape. */
    tokenTotalEstimated?: boolean;
}
export declare function createWorkflowControlTool(options: WorkflowControlToolOptions): ToolDefinition<typeof workflowControlSchema, Record<string, unknown>>;
export {};
