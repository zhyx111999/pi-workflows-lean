import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowManager } from "./workflow-manager.js";
import { type WorkflowStorage } from "./workflow-saved.js";
/** The single always-on gate that authorizes workflow use without forcing it. */
export declare const WORKFLOW_GATE_GUIDELINE = "workflow runs a script's agent(), parallel(), and pipeline() calls as background subagents. Whether to call it is decided by the note appended to the user message.";
declare const workflowToolSchema: Type.TObject<{
    script: Type.TOptional<Type.TString>;
    name: Type.TOptional<Type.TString>;
    args: Type.TOptional<Type.TUnsafe<Record<string, unknown>>>;
    background: Type.TOptional<Type.TBoolean>;
    maxAgents: Type.TOptional<Type.TNumber>;
    concurrency: Type.TOptional<Type.TNumber>;
    agentRetries: Type.TOptional<Type.TNumber>;
    agentTimeoutMs: Type.TOptional<Type.TNumber>;
    tokenBudget: Type.TOptional<Type.TNumber>;
    resumeFromRunId: Type.TOptional<Type.TString>;
}>;
export type WorkflowToolInput = {
    script?: string;
    name?: string;
    args?: Record<string, unknown>;
    background?: boolean;
    maxAgents?: number;
    concurrency?: number;
    agentRetries?: number;
    agentTimeoutMs?: number;
    tokenBudget?: number;
    resumeFromRunId?: string;
};
export interface WorkflowToolOptions {
    cwd?: string;
    concurrency?: number;
    /** Shared manager so background runs are reachable from the `/workflows` command. */
    manager?: WorkflowManager;
    /**
     * Live manager accessor. Prefer this over a closed-over `manager` when the
     * extension may replace the manager after session_start (cross-project resume).
     * Falls back to `manager` / a freshly constructed default.
     */
    getManager?: () => WorkflowManager;
    /** Shared saved-workflow storage. */
    storage?: WorkflowStorage;
    /** Live storage accessor; same rationale as getManager. */
    getStorage?: () => WorkflowStorage;
    /** Live project cwd for name-resolution / settings. */
    getCwd?: () => string;
    /** Default per-agent timeout for runs created by this tool. null means no hard timeout. */
    defaultAgentTimeoutMs?: number | null;
    /** Default max concurrent agents when no tool-level concurrency is passed. */
    defaultConcurrency?: number;
    /** Default retry attempts after recoverable agent failures. */
    defaultAgentRetries?: number;
}
export declare function createWorkflowTool(options?: WorkflowToolOptions): ToolDefinition<typeof workflowToolSchema, any>;
/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export declare function backgroundStartedText(name: string, runId: string): string;
/**
 * One-line hint telling the model it can iterate on a finished/running run by
 * resuming it with an edited script instead of re-running the whole workflow.
 * Unchanged agent() calls replay from the journal (cache); only edited/new ones
 * re-run. Omitted when there is no runId to reference.
 */
export declare function reviseHint(runId: string | undefined): string;
/**
 * The tool result returned when the model resumes a run with an edited script.
 * The resumed run is always background, so its result is delivered back later.
 */
export declare function resumedText(name: string, runId: string): string;
/**
 * Explain why a resumeFromRunId could not be resumed, so the model gets a clear
 * tool error instead of a silent failure. Inspects live + persisted state to
 * name the concrete reason (not found / running / completed / stopped).
 */
export declare function resumeFailureText(manager: WorkflowManager, runId: string, requestedMaxAgents?: number): string;
export {};
