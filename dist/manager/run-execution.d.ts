import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentUsage } from "../agent-usage.js";
import type { WorkflowSnapshot } from "../display.js";
import { type JournalEntry, type WorkflowCheckpoint, type WorkflowRunOptions, type WorkflowRunResult } from "../workflow.js";
import type { ManagedRun } from "../workflow-manager.js";
import type { LiveRuns } from "./live-runs.js";
/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
    /** Journaled results to replay by call index (resume). */
    resumeJournal?: Map<number, JournalEntry>;
    /** Durable checkpoint response being replayed by this execution. */
    resumeCheckpoint?: WorkflowCheckpoint;
    /** Host signal (e.g. tool/Esc) that aborts this run when fired. */
    externalSignal?: AbortSignal;
    /**
     * Grace (ms) for the final drain once this run is aborted (default 10_000;
     * Infinity = unbounded). A host setting, not persisted with the run.
     */
    drainAbortGraceMs?: number;
    /** Called with the live snapshot on every progress event. */
    onProgress?: (snapshot: WorkflowSnapshot) => void;
    /**
     * Tools for this run's subagents instead of the default coding tools, e.g.
     * /deep-research adds web tools. Pair with `toolset` so a resume finds them again.
     */
    tools?: ToolDefinition[];
    /**
     * Named toolset, resolved via WorkflowManagerOptions.toolsets and persisted
     * for resume(). With both set, `tools` serves this execution and `toolset` resumes.
     */
    toolset?: string;
    /**
     * Whether a usage-limit pause may resume automatically. Default on; false opts
     * out. Persisted so the scheduler honors it after a restart.
     */
    autoResume?: boolean;
    /** Token usage already spent (resume), so reported totals stay cumulative. */
    initialTokenUsage?: AgentUsage;
}
/** The manager's settings as an execution starts. Run limits are read anew for every execution, resumes included. */
export interface ExecutionSettings {
    runtime: Pick<WorkflowRunOptions, "cwd" | "agent" | "mainModel" | "modelRegistry" | "persistAgentSessions" | "inheritMainModel" | "concurrency" | "agentRetries" | "maxAgents" | "agentTimeoutMs" | "excludeTools" | "providerMiddlewareExtensions">;
    toolsets?: Record<string, () => ToolDefinition[]>;
}
/** Execute `script` for `managed` and record the outcome on the run. Rejects with the run's error. */
export declare function executeRun(live: LiveRuns, managed: ManagedRun, script: string, args: unknown, exec: ExecOptions, settings: ExecutionSettings): Promise<WorkflowRunResult>;
