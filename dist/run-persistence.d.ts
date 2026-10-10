/**
 * Workflow run state persistence for pause/resume support.
 */
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { WorkflowErrorCode } from "./errors.js";
import { type PersistenceFsLayer } from "./fs-persistence.js";
export { agentHasNonTerminalStatus, INTERRUPTED_AGENT_CAUSE, settleInterruptedPersistedAgents, } from "./run-agent-settlement.js";
import type { WorkflowCheckpoint } from "./workflow.js";
export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
export interface PersistedAgentState {
    id: number;
    /** Runtime call identity (`${runId}:${callIndex}`), used to rehydrate journaled results. */
    callId?: string;
    label: string;
    phase?: string;
    prompt: string;
    status: "queued" | "running" | "done" | "error" | "skipped";
    result?: unknown;
    /** Compact result written by releases before full agent results were retained. */
    resultPreview?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    history?: AgentHistoryEntry[];
    startedAt?: string;
    endedAt?: string;
    /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
    tokens?: number;
    /** Per-agent token usage breakdown, when the provider reported one. */
    tokenUsage?: AgentUsage;
    /** The model this agent ran on (provider/id), when known. */
    model?: string;
    /** Child SessionManager identity, captured before the first prompt. */
    sessionId?: string;
    /** Child session file, absent for in-memory child sessions. */
    sessionFile?: string;
}
/** Serialized journal entry, keyed by the call's lexical index. */
export interface PersistedJournalEntry {
    index: number;
    hash: string;
    result: unknown;
    storeDelta?: Record<string, unknown>;
    /** The model the call ran on; absent on journals written before this field existed. */
    model?: string;
}
/**
 * Sanitize a persisted/incoming auto-resume attempt counter: corrupt or
 * foreign values (non-number, NaN, Infinity, negative, non-integer) become
 * undefined — a NaN/negative counter would defeat the scheduler's give-up
 * cap and produce NaN timer delays (#207).
 */
export declare function sanitizeAutoResumeAttempts(value: unknown): number | undefined;
export interface PersistedRunState {
    runId: string;
    workflowName: string;
    script: string;
    args?: unknown;
    /** The pi session currently used for run ownership/delivery. Runs persist on
     * disk across sessions but the navigator shows only the current session's
     * runs (undefined = legacy/global). */
    sessionId?: string;
    /** Immutable parent session identity for this workflow run. */
    parentSessionId?: string;
    /** Immutable parent session file for this workflow run, when persisted. */
    parentSessionFile?: string;
    status: RunStatus;
    /**
     * Terminal failure/abort message. Written for `failed` and `aborted` runs;
     * absent on running/paused/completed and on records persisted before this field.
     */
    error?: string;
    /**
     * Classified terminal cause. Written with `error` for `failed` and `aborted`
     * runs; absent on running/paused/completed and on legacy records.
     */
    errorCode?: WorkflowErrorCode;
    /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
    pauseReason?: string;
    /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
    resetHint?: string;
    /** Durable workflow-controlled suspension and its at-most-once response. */
    checkpoint?: WorkflowCheckpoint;
    phases: string[];
    currentPhase?: string;
    agents: PersistedAgentState[];
    logs: string[];
    result?: unknown;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    durationMs?: number;
    tokenUsage?: {
        input: number;
        output: number;
        total: number;
        cost?: number;
        cacheRead?: number;
        cacheWrite?: number;
        /** True when the totals include character-heuristic estimates (#209). */
        estimated?: boolean;
    };
    /**
     * Cached agent/checkpoint results for resume, keyed by deterministic call
     * index. `storeDelta` is this call's SharedStore write delta, replayed
     * additively on resume.
     */
    journal?: PersistedJournalEntry[];
    /**
     * Opt-out of auto-resume for this run (default true, i.e. eligible unless
     * explicitly set to false via ExecOptions.autoResume). Set once at run start
     * and carried through resumes; see UsageLimitScheduler.
     */
    autoResume?: boolean;
    /**
     * Named toolset tag (WorkflowManagerOptions.toolsets). ToolDefinitions are
     * functions and can't be serialized, so this tag is how a resumed run (e.g.
     * /deep-research with web tools) re-resolves the tool set it started with.
     */
    toolset?: string;
    /**
     * Auto-resume attempt counter for the current usage_limit pause-cycle.
     * Owned by WorkflowManager (written on every persistRun; the scheduler
     * records through recordAutoResumeAttempts, never a raw save — #207).
     * Absent/0 means no auto-resume attempt has been recorded yet.
     */
    autoResumeAttempts?: number;
    /**
     * Undelivered background-result payload waiting for the originating session's
     * delivery endpoint. Written before the send attempt (fail-closed); cleared
     * only after a successful session-routed delivery. `complete` recomputes text
     * from the persisted result on flush so we don't retain a second full copy.
     */
    pendingDelivery?: PendingDeliveryMarker;
}
/**
 * Disk/memory marker for a background result that still needs conversation
 * delivery. Kept small on purpose — never store full agent transcripts here.
 */
export type PendingDeliveryMarker = {
    kind: "complete";
    deliveryId?: string;
} | {
    kind: "text";
    text: string;
    deliveryId?: string;
};
export interface RunPersistence {
    /** Immutable, directly readable result artifact for conversation delivery. */
    exportResult?(runId: string, result: unknown): string;
    /** Read routing metadata without hydrating history; detail fields are lazy. */
    loadPreview?(runId: string): PersistedRunState | null;
    /** Under the caller's run lease, settle orphaned agents using a log delta. */
    recoverInterrupted?(runId: string): boolean;
    /**
     * Save current run state. Throws RunRecordDeletedError instead of recreating a
     * run this instance has written or read after another writer deleted it.
     */
    save(state: PersistedRunState): void;
    /** Merge small delivery/ownership fields without hydrating the run history. */
    updateMetadata?(runId: string, patch: Partial<Pick<PersistedRunState, "sessionId" | "pendingDelivery" | "autoResumeAttempts">>, expectedDeliveryId?: string): boolean;
    /** Load a persisted run by ID. */
    load(runId: string): PersistedRunState | null;
    /** List all persisted runs. */
    list(): PersistedRunState[];
    /** Delete a persisted run with its sidecars, exported results, and run log. */
    delete(runId: string): boolean;
    /**
     * Acquire an exclusive cross-process lease for a run. Returns null when another
     * live process owns the run; stale/corrupt lock files are removed and retried.
     */
    acquireRunLease(runId: string): RunLease | null;
    /** Release a lease previously returned by acquireRunLease(). */
    releaseRunLease(lease: RunLease): void;
    /** Get runs directory path. */
    getRunsDir(): string;
}
export interface RunLease {
    runId: string;
    token: string;
}
/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 * (Alias of the shared PersistenceFsLayer — see fs-persistence.ts.)
 */
export type FsLayer = PersistenceFsLayer;
/**
 * Retention policy for terminal (completed/failed/aborted) runs kept on
 * disk. Bounded so a long-lived project directory can't accumulate an
 * unbounded number of run files (each polled/listed on every list() call).
 * A run in "running" or "paused" status is NEVER counted against this cap
 * or evicted by it — only genuinely finished runs age out, oldest (by
 * updatedAt) first, once the terminal-run count exceeds the cap. 300 is
 * generous enough to cover weeks of typical usage while keeping list()'s
 * per-call directory scan bounded.
 */
export declare const DEFAULT_MAX_TERMINAL_RUNS_ON_DISK = 300;
export declare const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus>;
declare const PERSISTED_AGENT_STATUSES: readonly ["queued", "running", "done", "error", "skipped"];
type AssertNever<T extends never> = T;
export type _PersistedAgentStatusExhaustiveCheck = AssertNever<Exclude<PersistedAgentState["status"], (typeof PERSISTED_AGENT_STATUSES)[number]>>;
/** Every status a persisted agent row may validly carry — exhaustively
 * checked against PersistedAgentState["status"] by the assertion above.
 * Forward-compat note: resume seeding DROPS rows with out-of-union statuses
 * (e.g. written by a newer release) — deliberate garbage-vs-unknown tradeoff:
 * an unknown status cannot be ghost-settled or displayed safely, so the row
 * is treated as corrupt rather than re-persisted as a lie. */
export declare const VALID_PERSISTED_AGENT_STATUSES: ReadonlySet<PersistedAgentState["status"]>;
/** Cause stamped onto leftover in-flight agents when a run reaches a terminal status. */
export declare function terminalRunInterruptCause(status: RunStatus, error?: {
    message?: string;
    code?: WorkflowErrorCode;
}): {
    error: string;
    errorCode?: WorkflowErrorCode;
};
/**
 * Fail-closed rewrite of leftover queued/running agents on a terminal run.
 * Completed/failed/aborted must never persist a still-`running` agent.
 */
export declare function settleNonTerminalPersistedAgents(agents: PersistedAgentState[], status: RunStatus, error: {
    message?: string;
    code?: WorkflowErrorCode;
} | undefined, endedAt: string): PersistedAgentState[];
export interface RunPersistenceOptions {
    /** Override DEFAULT_MAX_TERMINAL_RUNS_ON_DISK (tests; advanced tuning). */
    maxTerminalRunsOnDisk?: number;
}
export declare function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>, options?: RunPersistenceOptions): RunPersistence;
/**
 * Generate a unique run ID.
 */
export declare function generateRunId(): string;
