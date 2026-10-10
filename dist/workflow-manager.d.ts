/**
 * Workflow manager: owns every run's lifecycle. A run starts in the background
 * (or inline via runSync), executes through runWorkflow, and can be paused,
 * stopped, resumed, re-homed to another session, or deleted. Each execution
 * holds a cross-process lease on its run and writes the run record as it goes.
 */
import { EventEmitter } from "node:events";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.js";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";
import { WorkflowError } from "./errors.js";
import { type ExternalAbort, type LifecycleControl } from "./manager/abort-control.js";
import type { SteerableAgent } from "./manager/run-events.js";
import { type ExecOptions } from "./manager/run-execution.js";
import { type PendingDeliveryMarker, type PersistedAgentState, type PersistedRunState, type RunLease, type RunPersistence, type RunStatus } from "./run-persistence.js";
import type { SubagentTask } from "./subagent-tasks.js";
import type { JournalEntry, WorkflowCheckpoint, WorkflowRunResult } from "./workflow.js";
type AgentTimestamps = {
    startedAt: string;
    endedAt?: string;
};
export interface ManagedRun {
    runId: string;
    status: RunStatus;
    snapshot: WorkflowSnapshot;
    result?: WorkflowRunResult;
    error?: WorkflowError;
    controller: AbortController;
    startedAt: Date;
    /** The real script, kept so the run can be resumed. */
    script: string;
    args?: unknown;
    /** Finished agent and checkpoint results by call index, replayed on resume. */
    journal: JournalEntry[];
    /** Latest durable checkpoint transition for this run. */
    checkpoint?: WorkflowCheckpoint;
    /** Cross-process lease, held while an execution in this process owns the run. */
    lease?: RunLease;
    /**
     * True unless runSync started the run. Only background runs deliver their
     * result into the conversation; runSync already returns it to its caller.
     */
    background: boolean;
    /** The session that receives this run's result. Only adoptLiveRunsToSession() changes it. */
    sessionId?: string;
    /** The session that started the run; never changes. */
    parentSessionId?: string;
    /** That session's file, if any; never changes. */
    parentSessionFile?: string;
    /** Background result still waiting for delivery; cleared only after a successful send. */
    pendingDelivery?: PendingDeliveryMarker;
    /** Auto-resume eligibility (see ExecOptions.autoResume), kept across resumes. */
    autoResume?: boolean;
    /**
     * The usage-limit scheduler's backoff counter. It lives here because every
     * manager write rewrites the whole record; the scheduler sets it through
     * recordAutoResumeAttempts().
     */
    autoResumeAttempts?: number;
    /**
     * The pause()/stop() that aborted this execution. That method already emitted
     * its own event, so the AbortError it causes is not reported as a failure.
     */
    lifecycleControl?: LifecycleControl;
    /** The host signal that aborted this execution; later agent results cannot override it. */
    externalAbort?: ExternalAbort;
    /** A provider limit that escaped before any pause()/stop(), so it still counts as a quota pause. */
    usageLimitEscapedBeforeLifecycleControl?: WorkflowError;
    /** The provider limit this run is paused on. */
    usageLimitPause?: WorkflowError;
    /**
     * Named toolset (see WorkflowManagerOptions.toolsets). Tools are functions and
     * cannot be persisted, so resume() re-resolves this name instead.
     */
    toolset?: string;
    /** Start and end time of each agent row, by snapshot id; a running agent has no end yet. */
    agentTimestamps: Map<number, AgentTimestamps>;
    /**
     * Running agents' rows by the call's unique id. Concurrent agents often share
     * a label, so per-agent events must never be matched by label.
     */
    agentsById: Map<string, WorkflowAgentSnapshot>;
    /** Child session of each recorded call, kept for replayed calls on resume. */
    agentSessionsByCallId: Map<string, {
        sessionId?: string;
        sessionFile?: string;
    }>;
    /** Recorded agent rows by call id, for replayed calls that have no seeded row. */
    replayedAgentStatesByCallId: Map<string, PersistedAgentState>;
    /** Agent timestamps by call id, kept for replayed calls. */
    agentTimestampsByCallId: Map<string, AgentTimestamps>;
    /** Rows 1..seededAgentCount came from the record at resume; later rows belong to this execution. */
    seededAgentCount?: number;
    /** Calls whose start/end events are a journal replay, not a launch. */
    replayedAgentCalls: Set<string>;
    /** Sessions of this execution's running agents, by call id, for steerAgent(). */
    steerable: Map<string, SteerableAgent>;
}
export interface WorkflowResumeOptions {
    /** Edited script: journaled calls replay only within the unchanged prefix. */
    script?: string;
    /** Edited task list for a task-list run: every unchanged task replays wherever it moved. */
    tasks?: SubagentTask[];
    checkpointId?: string;
}
export interface WorkflowManagerOptions {
    cwd?: string;
    /** Max concurrent agents per run. Default 8; the runtime clamps to 16. */
    concurrency?: number;
    /** Max logical agent()/checkpoint() calls per run. Default 1000. */
    maxAgents?: number;
    /** Timeout per agent attempt in ms. null/omitted means no hard timeout. */
    agentTimeoutMs?: number | null;
    /** Retry attempts after recoverable agent failures. Default 0. */
    agentRetries?: number;
    /** Inject a custom agent runner (tests); defaults to a real subagent session. */
    agent?: Pick<WorkflowAgent, "run">;
    /** The session's main model (provider/id), for auto-tiering explore agents and inheritMainModel routing. */
    mainModel?: string;
    /** Route agents without `model`/`tier` to the session's main model. Default false. */
    inheritMainModel?: boolean;
    /**
     * The host session's model registry, so subagents resolve models like the
     * main session, including providers registered by extensions.
     */
    modelRegistry?: ModelRegistry;
    /** The pi session id to tag runs with (see setSessionId). */
    sessionId?: string;
    /** The current pi session file, used as the parent of persistent child sessions. */
    sessionFile?: string;
    /**
     * Named toolsets for ExecOptions.toolset, e.g.
     * `{ "web-research": () => [...createCodingTools(cwd), ...createWebTools()] }`.
     * Called per execution, resumes included. An unknown name gets the default coding tools.
     */
    toolsets?: Record<string, () => ToolDefinition[]>;
    /**
     * Extra tool names denied in every subagent session, on top of the always-denied
     * `subagents`/`subagents_control`, to block other recursive orchestration tools.
     */
    excludeSubagentTools?: string[];
    /** Trusted provider/auth middleware extension names allowed in children. Default []. */
    providerMiddlewareExtensions?: string[];
    /** Persist each subagent transcript as a real pi session file. Default false (in memory). */
    persistAgentSessions?: boolean;
    /** Finished runs kept in memory before the oldest is evicted (default 20). */
    maxTerminalRunsInMemory?: number;
}
/**
 * Options a reloaded extension may refresh on a live manager. Execution
 * identity (cwd, persistence, injected agent, in-memory runs) stays as is.
 */
export type WorkflowManagerReloadOptions = Pick<WorkflowManagerOptions, "concurrency" | "maxAgents" | "agentTimeoutMs" | "agentRetries" | "toolsets" | "excludeSubagentTools" | "providerMiddlewareExtensions" | "persistAgentSessions" | "inheritMainModel">;
export declare class WorkflowManager extends EventEmitter {
    /**
     * In-memory runs. Running and paused runs always stay; a finished run stays
     * until evicted (see TerminalRunRetention). A missing entry means "read the
     * record" (listRuns/findRun), and resume() always reloads from disk.
     */
    private runs;
    /** Guarded writes for `runs`: record writes, lease release, events, deletion. */
    private readonly live;
    /** Executions by managed run, so pause/resume can wait for settlement before overlapping. */
    private readonly executions;
    private persistence;
    private cwd;
    private concurrency;
    private agent?;
    private mainModel?;
    private modelRegistry?;
    /** The current pi session id; new runs are tagged with it and listRuns() filters by it. */
    private sessionId?;
    /** The current host session file; new runs record it as their parent. */
    private sessionFile?;
    private maxAgents;
    private agentTimeoutMs;
    private agentRetries;
    private toolsets?;
    private excludeSubagentTools?;
    private providerMiddlewareExtensions?;
    private persistAgentSessions;
    private inheritMainModel;
    constructor(options?: WorkflowManagerOptions);
    /**
     * Refresh host configuration after Pi reloads the extension, keeping live
     * runs, leases, and listeners. Running executions keep the options they
     * started with; later runs and resumes use the new ones.
     */
    reconfigureAfterReload(options: WorkflowManagerReloadOptions): void;
    /** Bind to the current pi session (on session_start): new runs belong to it, and listRuns() shows only its runs. */
    setSessionId(id: string | undefined, sessionFile?: string): void;
    getSessionId(): string | undefined;
    getSessionFile(): string | undefined;
    /** Project cwd this manager was constructed for (persistence + agent tools). */
    getCwd(): string;
    /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
    setMainModel(spec: string | undefined): void;
    /** Set the host session's model registry so subagents resolve models consistently. */
    setModelRegistry(registry: ModelRegistry): void;
    /**
     * After a session replacement keeps this manager, move the work that still
     * needs this conversation to `sessionId`: running and paused runs, and any
     * run with an undelivered result. Finished, delivered runs keep their
     * session so history stays where it ran; parent lineage never moves.
     * Disk-only results move only from `previousSessionId`, so a sibling session
     * sharing the runs directory cannot take another session's results.
     */
    adoptLiveRunsToSession(sessionId: string | undefined, previousSessionId?: string): number;
    /**
     * Re-home one in-memory run; false when it turned out to be deleted. An
     * execution holding the lease rewrites its own record. A settled copy only
     * caches a record another process may have changed since, so it moves just
     * the session field.
     */
    private moveRunToSession;
    /** Start a workflow in the background. Returns the run ID at once; `promise` settles with the run. */
    startInBackground(script: string, args?: unknown, exec?: ExecOptions): {
        runId: string;
        promise: Promise<WorkflowRunResult>;
    };
    /**
     * Run a workflow and wait for its result, tracked like a background run so
     * the navigator and task panel show it. Only tests use this today.
     */
    runSync(script: string, args?: unknown, exec?: ExecOptions): Promise<WorkflowRunResult>;
    /** Create a run, take its lease, and add it to `runs`. Throws when the lease is taken. */
    private registerNewRun;
    /** Start one execution of `managed` with the manager's current settings and track it. */
    private execute;
    /** Pause a running workflow. */
    pause(runId: string): boolean;
    /**
     * Attach a response to a waiting checkpoint; it is on disk before this
     * resolves. resume() still waits for the paused execution to settle, so
     * hosts attach first and resume on the "paused" event.
     */
    attachCheckpointResponse(runId: string, checkpointId: string, responseValue: unknown): Promise<void>;
    /**
     * Resume a paused, failed, or stopped run, or rerun a finished one with an
     * edit: journaled results replay for unchanged calls and the rest run live.
     * Returns false when there is nothing to resume.
     *
     * `opts.script` resumes with an edited script: calls replay up to the first
     * changed or inserted call. `opts.tasks` edits a task-list run, where every
     * unchanged task replays wherever it moved. Without either, the recorded
     * script and args run again (auto-resume, TUI resume).
     */
    resume(runId: string, opts?: WorkflowResumeOptions): Promise<boolean>;
    /**
     * Stop a running or paused workflow. The execution holding the run's lease
     * is aborted and the run written as aborted. Like pause(), it keeps the
     * lease: the execution's last write comes after the drain, and releasing
     * now would let another process resume the run and then lose that write.
     * Any other run is stopped through its record (see stopRecord()).
     */
    stop(runId: string): boolean;
    /**
     * Stop a run no execution here owns: one from an earlier session, or one
     * whose execution here has settled. Such a copy only caches the record,
     * which another process may since have resumed, finished, or deleted, so
     * the record decides; a run another live process executes cannot be leased.
     */
    private stopRecord;
    private markStopped;
    /**
     * Queue an instruction into every running agent of a live run that has this
     * label. Resolves to the number of sessions that received it: 0 when the run
     * is not running here or no agent with that label is mid-session.
     */
    steerAgent(runId: string, label: string, text: string): Promise<number>;
    /** The live in-memory run, if this process has one. */
    getRun(runId: string): ManagedRun | undefined;
    /** The live snapshot of an in-memory run, or null. */
    getSnapshot(runId: string): WorkflowSnapshot | null;
    /**
     * Every live in-memory run, regardless of session. Cross-session recovery
     * uses this, because listRuns() hides runs that belong to another session.
     */
    listLiveRuns(): ManagedRun[];
    /**
     * Run records for the navigator and task panel: only the bound session's
     * runs, or all of them when no session is bound.
     */
    listRuns(): PersistedRunState[];
    /** All persisted runs regardless of session (used by cross-session recovery). */
    listAllRuns(): PersistedRunState[];
    /**
     * One run's record, read now rather than from the list cache, in any session;
     * undefined when it does not exist. A settled local copy of a run that another
     * process deleted is dropped here, so every caller agrees the run is gone.
     */
    findRun(runId: string): PersistedRunState | undefined;
    getPersistence(): RunPersistence;
    /**
     * Delete a run and its files. A live run is aborted first so it stops
     * spending; its execution winds down on its own, and its late writes are
     * dropped because it is no longer current. Returns false when another
     * process holds the run's lease or the run does not exist. Never throws on
     * a lease probe failure.
     */
    deleteRun(runId: string): boolean;
    /**
     * Record the usage-limit scheduler's backoff counter. A run whose execution
     * holds the lease carries it into its next write; any other run's record is
     * merged under a fresh lease, skipped on contention because the owner writes
     * the record itself. Never write the field with a raw save: the next full
     * write would erase it.
     */
    recordAutoResumeAttempts(runId: string, attempts: number): void;
}
export {};
