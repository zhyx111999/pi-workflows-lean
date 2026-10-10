/**
 * Workflow manager for background execution, pause/resume, and run management.
 */
import { EventEmitter } from "node:events";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.js";
import { type AgentUsage } from "./agent-usage.js";
import { type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import { WorkflowError } from "./errors.js";
import { type PendingDeliveryMarker, type PersistedAgentState, type PersistedRunState, type RunLease, type RunPersistence, type RunStatus } from "./run-persistence.js";
import { type SubagentTask } from "./subagent-tasks.js";
import { type JournalEntry, type WorkflowCheckpoint, type WorkflowRunResult } from "./workflow.js";
/** Per-execution identity for an abort initiated by pause()/stop(). */
interface LifecycleControl {
    action: "pause" | "stop";
    abortReason: object;
}
/** Per-execution identity for an abort received from the host/tool signal. */
interface ExternalAbort {
    abortReason: object;
}
/** @internal test hook — shrink the settle grace without 10s-long tests. */
export declare function _setPausedExecutionSettleTimeoutForTests(ms: number | undefined): void;
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
    /** Accumulated agent results for resume (deterministic call index -> result). */
    journal: JournalEntry[];
    /** Latest durable checkpoint transition for this run. */
    checkpoint?: WorkflowCheckpoint;
    /** Cross-process execution lease for this run, when it is actively executing. */
    lease?: RunLease;
    /**
     * True when the run was started in the background (or resumed) and the caller is
     * not awaiting its result inline. Only background runs deliver their result back
     * into the conversation; a foreground sync run already returns it as the tool
     * result, so re-delivering would duplicate it.
     */
    background: boolean;
    /**
     * Pi session that owns delivery for this run (initially the session bound at
     * start, and intentionally changed only by adoptLiveRunsToSession()). It is
     * never re-read from the manager's current sessionId during execution.
     */
    sessionId?: string;
    /** Immutable parent session identity captured when this run started. */
    parentSessionId?: string;
    /** Immutable parent session file captured when this run started, if any. */
    parentSessionFile?: string;
    /**
     * Background result still waiting for session-routed conversation delivery.
     * Set before the send attempt and cleared only after a successful deliver so a
     * missing/suspended endpoint cannot lose the result (see task-panel delivery).
     */
    pendingDelivery?: PendingDeliveryMarker;
    /**
     * Auto-resume eligibility for this run (see ExecOptions.autoResume). Set once
     * at creation and carried through resume() so it survives pause/resume cycles.
     * Undefined means eligible (default-on); false opts out.
     */
    autoResume?: boolean;
    /**
     * Usage-limit auto-resume backoff counter, owned in-memory here and persisted
     * on every manager write — a raw side-channel persistence.save would be
     * erased by the next writeRunToDisk (#207). Written through
     * recordAutoResumeAttempts(); read on cold start by the scheduler.
     */
    autoResumeAttempts?: number;
    /**
     * A user-requested lifecycle transition that aborted this exact execution.
     *
     * `pause` and `stop` already emit their own semantic events synchronously.
     * Their later cooperative AbortError is teardown, not an unexpected workflow
     * failure, so executeRun() must not emit a second generic `error` event (which
     * would otherwise cause background-result delivery to start a new turn). The
     * reason identity is compared with AbortSignal.reason: a later lifecycle action
     * must never mask an error that had already escaped the workflow.
     * This is deliberately transient: the status is the durable lifecycle fact.
     */
    lifecycleControl?: LifecycleControl;
    /**
     * External abort that owns this execution. Its identity keeps a provider,
     * timeout, or other late agent result from reviving an already-aborted run.
     */
    externalAbort?: ExternalAbort;
    /**
     * Provider limit that escaped the top-level workflow before any manager
     * lifecycle control could race with runWorkflow's cooperative sibling drain.
     * This preserves the true terminal cause if pause()/stop() arrives later.
     */
    usageLimitEscapedBeforeLifecycleControl?: WorkflowError;
    /** A provider-limit pause accepted as this run's durable pause reason. */
    usageLimitPause?: WorkflowError;
    /**
     * Named toolset tag for this run (see WorkflowManagerOptions.toolsets).
     * ToolDefinitions are functions and can't be persisted, so the tag is what
     * survives on disk — resume() re-resolves it so e.g. a resumed
     * `/deep-research` run keeps its web tools instead of silently degrading to
     * the default coding tools.
     */
    toolset?: string;
    /**
     * Per-agent start/end timestamps keyed by the agent's snapshot id. Live rows
     * carry real onAgentStart/onAgentEnd captures; resume seeding (#206) carries
     * persisted values, and a ghost without a persisted startedAt gets the
     * settle wall-clock (documented fabrication, clamped to >= the record's
     * last write). A running agent has an entry with no endedAt; persistRun() reads from here instead of stamping
     * every agent with the run's startedAt / "now".
     */
    agentTimestamps: Map<number, {
        startedAt: string;
        endedAt?: string;
    }>;
    /**
     * Live snapshot-agent lookup keyed by the agent CALL's unique id (see
     * WorkflowRunOptions.onAgentStart/onAgentEnd/onAgentHistory's `id` field in
     * workflow.ts — unique per call, never per label). onAgentEnd/onAgentHistory
     * must resolve the snapshot entry to update through this map, never by
     * scanning managed.snapshot.agents for a label match: two concurrent agents
     * routinely share a label (e.g. parallel()'s default `"${phase} agent N"`
     * labeling, or an author-supplied label reused across a fan-out), and a
     * label+status scan would update whichever same-label entry it happens to
     * find first — misattributing one agent's end/history event to a different,
     * still-running sibling.
     */
    agentsById: Map<string, WorkflowAgentSnapshot>;
    /** Session identity carried across journal replay for a resumed run. */
    agentSessionsByCallId: Map<string, {
        sessionId?: string;
        sessionFile?: string;
    }>;
    /** Persisted per-agent details carried into replayed snapshot entries. */
    replayedAgentStatesByCallId: Map<string, PersistedAgentState>;
    /** Timestamps carried into replayed snapshot entries. */
    agentTimestampsByCallId: Map<string, {
        startedAt: string;
        endedAt?: string;
    }>;
    /** Rows seeded from the persisted record at resume (#206): snapshot ids
     * 1..seededAgentCount are history; anything above ran (or was appended) in
     * this execution. Used to scope completion diagnostics to the current
     * execution rather than preserved history. */
    seededAgentCount?: number;
    /** Calls whose onAgentStart/onAgentEnd pair was journal replay, not a launch. */
    replayedAgentCalls: Set<string>;
    /** Sessions of this execution's running agents, keyed by call id, for steerAgent(). */
    steerable: Map<string, SteerableAgent>;
}
/** A running agent session that can take an instruction mid-run. */
interface SteerableAgent {
    label: string;
    steer: (text: string) => Promise<void>;
}
/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
    /** Replay these journaled agent/checkpoint results for the unchanged prefix (resume), keyed by call index. */
    resumeJournal?: Map<number, JournalEntry>;
    /** Durable checkpoint response being replayed by this execution. */
    resumeCheckpoint?: WorkflowCheckpoint;
    /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
    externalSignal?: AbortSignal;
    /**
     * Grace (ms) for the terminal drain once this run's abort has fired
     * (default 10_000; Infinity = unbounded). Not frozen/persisted — a host
     * reliability knob, not run semantics. See WorkflowRunOptions.drainAbortGraceMs.
     */
    drainAbortGraceMs?: number;
    /** Called with the live snapshot on every progress event. */
    onProgress?: (snapshot: WorkflowSnapshot) => void;
    /**
     * Tool set for this run's subagents, replacing the default coding tools —
     * e.g. built-in `/deep-research` appends web tools. Omit for the default.
     * Not persistable (functions): pair with `toolset` so a resumed run can
     * re-resolve the same tools.
     */
    tools?: ToolDefinition[];
    /**
     * Named toolset tag, resolved via WorkflowManagerOptions.toolsets. Persisted
     * with the run and re-resolved on resume(). When both `tools` and `toolset`
     * are given, `tools` wins for this execution and `toolset` is what resumes use.
     */
    toolset?: string;
    /**
     * Whether this run is eligible for auto-resume when it pauses on a provider
     * usage limit. Default-on: omit or pass true to stay eligible, pass false to
     * opt out. Persisted on the run so a cold-start UsageLimitScheduler respects
     * it too. See usage-limit-scheduler.ts.
     */
    autoResume?: boolean;
    /**
     * Seed for the execution's cumulative token usage — passed through to
     * runWorkflow's WorkflowRunOptions.initialTokenUsage. Only resume() sets
     * this (from the persisted run's tokenUsage-at-pause), so the resumed
     * execution reports totals that include the already-spent usage.
     */
    initialTokenUsage?: AgentUsage;
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
    /**
     * Route untagged agents (no `model`/`tier`) to the session's main model
     * instead of the implicit medium tier / settings default. Mirrors the
     * inheritMainModel user setting; default false (legacy routing).
     */
    inheritMainModel?: boolean;
    /**
     * The host Pi session's model registry. When provided, workflow subagents
     * resolve models against the same registry as the main session, including
     * extension-registered providers such as ollama-cloud.
     */
    modelRegistry?: ModelRegistry;
    /** The pi session id to tag runs with (see setSessionId). */
    sessionId?: string;
    /** The current pi session file, used as the parent of persistent child sessions. */
    sessionFile?: string;
    /**
     * Named toolsets resolvable by ExecOptions.toolset — e.g.
     * `{ "web-research": () => [...createCodingTools(cwd), ...createWebTools()] }`.
     * Called lazily per execution (including on resume). An unknown tag resolves
     * to the default coding tools.
     */
    toolsets?: Record<string, () => ToolDefinition[]>;
    /**
     * Extra tool NAMES to deny in every subagent session, on top of the always-on
     * `subagents`/`subagents_control` defaults (see DEFAULT_EXCLUDED_SUBAGENT_TOOLS).
     * Host wiring passes settings.excludeSubagentTools here so users can also block
     * other recursive-orchestration tools (#107).
     */
    excludeSubagentTools?: string[];
    /** Trusted provider/auth middleware extension names allowed in children. Default []. */
    providerMiddlewareExtensions?: string[];
    /**
     * Persist each subagent transcript as a real pi session file under the
     * standard sessions directory. Default false (in-memory, discarded).
     */
    persistAgentSessions?: boolean;
    /**
     * How many terminal (completed/failed/aborted) runs to retain full
     * in-memory state for before the oldest is evicted from `runs` (see the
     * class-level doc comment on that field). Defaults to
     * DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY; exposed mainly for tests that want
     * to observe eviction without creating dozens of runs.
     */
    maxTerminalRunsInMemory?: number;
}
/** Options that a fresh extension generation may safely refresh on a live
 * manager handed across `/reload`. Execution identity (`cwd`, persistence,
 * injected agent, and in-memory runs) is intentionally excluded. */
export type WorkflowManagerReloadOptions = Pick<WorkflowManagerOptions, "concurrency" | "maxAgents" | "agentTimeoutMs" | "agentRetries" | "toolsets" | "excludeSubagentTools" | "providerMiddlewareExtensions" | "persistAgentSessions" | "inheritMainModel">;
export declare class WorkflowManager extends EventEmitter {
    /**
     * Lifecycle contract for `runs`:
     *
     *  - An entry is added when a run starts (startInBackground/runSync) or is
     *    resumed (resume()), always with a live AbortController and (usually)
     *    an active RunLease.
     *  - While status is "running" or "paused", the entry is NEVER evicted —
     *    its execution could still settle (a pending executeRun() promise) or
     *    it is mid-usage-limit-checkpoint/manually-paused and still considered
     *    "the current state of this run" by callers. Eviction only ever
     *    considers an entry AFTER executeRun() has fully settled it to
     *    "completed" | "failed" | "aborted" (see IN_MEMORY_TERMINAL_STATUSES)
     *    and persisted + released its lease — i.e. strictly after the same
     *    isCurrent()-gated persistRun()/releaseRunLease() calls in
     *    executeRun()'s success/catch tails.
     *  - Once terminal, an entry becomes eviction-ELIGIBLE (recordTerminalRun())
     *    but is not necessarily evicted immediately: up to
     *    maxTerminalRunsInMemory terminal entries are kept, oldest evicted
     *    first, so a `getRun()` call immediately after completion (e.g. the
     *    "complete" event's own synchronous listeners — task-panel's result
     *    delivery, `/workflows watch`) still sees the live object. Once
     *    evicted, the entry is simply removed from `runs`; nothing else reads
     *    or writes it again.
     *  - Every caller of getRun()/getSnapshot() must treat "undefined"/null as
     *    "no live in-memory copy right now" and fall back to listRuns() (backed
     *    by run-persistence.ts, which is what's authoritative for a run once
     *    the in-memory copy is gone) — this mirrors how those callers already
     *    treat any run this process never had in memory (e.g. one started by a
     *    different process and only ever seen via listRuns()). resume() never
     *    depends on `runs` for a run's state either: it always reloads from
     *    persistence, so an evicted runId resumes exactly like one from a
     *    prior process.
     *  - isCurrent(managed) composes with eviction the same way it composes
     *    with resume()/deleteRun() replacing or removing an entry: eviction
     *    removes the map entry outright, so a stale execution's later settle
     *    (isCurrent() check) sees `this.runs.get(runId) !== managed` (in fact
     *    undefined) and correctly no-ops, exactly as it would after
     *    resume()/deleteRun().
     */
    private runs;
    /**
     * FIFO of runIds that reached IN_MEMORY_TERMINAL_STATUSES, oldest first —
     * the eviction order for `runs` (see its doc comment). A runId can appear
     * more than once (e.g. resumed after eviction, then terminates again);
     * evicting is idempotent (recordTerminalRun() re-checks the CURRENT status
     * of the current map entry for that id before deleting), so duplicates
     * are harmless.
     */
    private terminalRunQueue;
    private maxTerminalRunsInMemory;
    /** Executions by managed run, so pause/resume can wait for settlement before overlapping. */
    private readonly executions;
    /** Runs deleted here or by another process; an execution still winding down finishes their deletion. */
    private readonly deletedRuns;
    private persistence;
    private cwd;
    private concurrency;
    private agent?;
    /** The session's main model (provider/id), for auto-tiering explore agents and inheritMainModel routing. */
    private mainModel?;
    /** The host Pi session's model registry, shared with subagents. */
    private modelRegistry?;
    /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
    private sessionId?;
    /** The current host session file; copied to a run as immutable parent lineage. */
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
    /** Bind the manager to the current pi session, so new runs are tagged with it and
     * the navigator/task-panel show only this session's runs (set on session_start).
     * The optional file is retained as the immutable parent lineage for new runs.
     */
    setSessionId(id: string | undefined, sessionFile?: string): void;
    /** Currently bound pi session id (set on session_start), if any. */
    getSessionId(): string | undefined;
    /** Currently bound pi session file (set on session_start), if any. */
    getSessionFile(): string | undefined;
    /** Project cwd this manager was constructed for (persistence + agent tools). */
    getCwd(): string;
    /**
     * Every live in-memory run, regardless of the navigator's session filter.
     * Stranded-pause / cross-session recovery must use this — listRuns() hides
     * runs whose frozen sessionId no longer matches the bound session.
     */
    listLiveRuns(): ManagedRun[];
    /**
     * After an in-process session replacement keeps this manager, re-home work
     * that still needs this conversation onto `sessionId`:
     *  - still-running / paused-in-memory runs (panel, subagents_control, stranded-pause)
     *  - any run (live or disk-only) with an undelivered `pendingDelivery` marker
     *
     * Terminal runs *without* pending keep their original sessionId so history
     * stays with the session that ran them. This delivery-owner migration never
     * changes a run's parentSessionId or parentSessionFile. `previousSessionId` scopes disk-only
     * pending re-home so a parallel sibling in the same runsDir cannot steal
     * another session's undelivered work. No-op when `sessionId` is undefined.
     */
    adoptLiveRunsToSession(sessionId: string | undefined, previousSessionId?: string): number;
    /**
     * Re-home one in-memory run; false when it turned out to be deleted. The
     * execution holding the lease owns the record and rewrites it. A settled copy
     * only caches a record that another process may have resumed, finished, or
     * deleted since, so it moves the owner field alone.
     */
    private moveRunToSession;
    /** Point a record at another delivery session, leaving the rest as written. False when it is gone. */
    private rehomeRecord;
    /**
     * On startup, any persisted run still marked "running" belongs to a process
     * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
     * to "paused" — never "failed" — so its journal is preserved and resume() can
     * replay the completed prefix and finish the rest.
     */
    private recoverStaleRuns;
    /**
     * Refresh host configuration after Pi reloads the extension while retaining
     * this manager's live runs, controllers, leases, and event listeners.
     * Existing executions keep the options they captured at start; subsequent
     * runs and resumes use the refreshed values.
     */
    reconfigureAfterReload(options: WorkflowManagerReloadOptions): void;
    /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
    setMainModel(spec: string | undefined): void;
    /** Set the host session's model registry so subagents resolve models consistently. */
    setModelRegistry(registry: ModelRegistry): void;
    /**
     * Expose the host session's model registry to integrations sharing this
     * manager. Workflow execution reads the same registry internally.
     */
    getModelRegistry(): ModelRegistry | undefined;
    /**
     * Start a workflow in the background.
     * Returns immediately with a run ID; the workflow executes asynchronously.
     */
    startInBackground(script: string, args?: unknown, exec?: ExecOptions): {
        runId: string;
        promise: Promise<WorkflowRunResult>;
    };
    /**
     * Execute a workflow synchronously (blocking) while still tracking it like a
     * background run, so the `/workflows` navigator and the live task panel see it.
     * `onProgress` fires on every progress event with the current snapshot, letting
     * a caller drive its own inline display.
     */
    runSync(script: string, args?: unknown, exec?: ExecOptions): Promise<WorkflowRunResult>;
    /** Build a fresh managed run with an empty snapshot. */
    private createManaged;
    private executeRun;
    /**
     * True when `managed` is still the live, current entry for its runId in
     * `this.runs` — false once resume() has replaced it with a new ManagedRun
     * object for the same runId, or deleteRun() has removed it entirely. A
     * superseded ManagedRun's async completion (executeRun's promise settling
     * well after something else already took over or tore down that runId)
     * must not write to disk or touch lease state on the newer execution's
     * behalf — see writeRunToDisk() and executeRun()'s post-await persist calls.
     */
    private isCurrent;
    /**
     * Emit an event on behalf of `managed`, but only while it's still the
     * current entry for its runId (see isCurrent()) — mirrors the disk/lease
     * guard for the observer-facing side of the same problem. A superseded
     * execution's progress/terminal events (log, phase, agentStart/End,
     * tokenUsage, complete, error, paused) are not just stale-but-harmless:
     * "complete" in particular can drive background result delivery into the
     * conversation, so letting a deleted/superseded run's stale settle still
     * fire it would deliver a result for a run that, from the caller's POV, no
     * longer exists (or has since been superseded by a newer execution whose
     * own events already tell the true story). No event in this set has a
     * legitimate reason to still reach listeners once superseded — unlike
     * disk writes there's no "expected race, harmless no-op" nuance here, it's
     * simply wrong to notify twice (or for a run that's gone). Events emitted
     * directly by pause()/stop()/resume()/deleteRun() themselves are NOT routed
     * through this helper — those methods own the transition and ARE current
     * at the moment they fire, same precedent as their persist/lease calls.
     */
    private emitLive;
    /**
     * Mark `runId` as eviction-eligible now that its execution has genuinely
     * settled to a terminal status (completed/failed/aborted — see
     * IN_MEMORY_TERMINAL_STATUSES), and evict the oldest eligible entries
     * beyond maxTerminalRunsInMemory. Callers must only invoke this after the
     * same isCurrent()-gated persistRun()/releaseRunLease() sequence executeRun()
     * already uses (see the `runs` field doc comment for the full contract) —
     * this method itself re-validates the CURRENT entry's status before
     * deleting anything, so it never evicts a run that isn't (or is no longer)
     * genuinely terminal, including one resumed back to "running" after being
     * queued here but before its turn to be evicted came up.
     */
    private recordTerminalRun;
    /** Add one settled logical agent's exact usage to the persisted run aggregate. */
    private commitFinalizedAgentUsage;
    /** Abort this execution for a host/tool signal, retaining provenance so a
     * non-cooperative agent's late result cannot overwrite the external abort. */
    private abortForExternalSignal;
    /** Abort this execution for an explicit user lifecycle action.
     *
     * AbortSignal.reason is an execution-scoped identity token. If the controller
     * had already been aborted externally, do not replace or annotate it: the
     * original external failure must remain observable when executeRun() settles.
     */
    private abortForLifecycleControl;
    private releaseRunLease;
    /** Trailing-edge throttle window for high-frequency progress persists (see schedulePersist). */
    private static readonly PERSIST_THROTTLE_MS;
    /** Pending trailing-edge persist timers for high-frequency progress events, keyed by runId. */
    private persistTimers;
    /**
     * Coalesce rapid progress persists (currently: onAgentJournal, which fires
     * once per completed agent and can burst under concurrency) to at most one
     * disk write per PERSIST_THROTTLE_MS (trailing edge) instead of one write
     * per tick. Delta persistence still compares the current state and performs
     * synchronous log/head writes, so concurrent completions should share work.
     *
     * Lifecycle-critical writes (status transitions, run end, pause/resume/stop)
     * must NOT use this — call persistRun() directly, which flushes (and cancels)
     * any pending timer first so a stale trailing write can never fire after, and
     * resurrect, a terminal state.
     */
    private schedulePersist;
    /**
     * Fail-closed: leftover queued/running agents are display-only after the
     * execution that owned them has gone. Replay is journal-keyed.
     */
    private settleManagedInterruptedAgents;
    private settleManagedAgentsForTerminalRun;
    /**
     * Persist immediately and synchronously. Cancels any pending throttled write
     * for this run first, so the write that lands is always the caller's current
     * (final) state — never superseded by a stale deferred write. Use this for
     * every lifecycle-critical persist: run start, status transitions, run end,
     * pause()/resume()/stop().
     */
    private persistRun;
    private writeRunToDisk;
    /**
     * Another process deleted this run's record. Mirror a local deleteRun(): stop
     * any live execution, drop the in-memory copy, and notify watchers, so no later
     * lifecycle write can recreate the run.
     */
    private forgetDeletedRun;
    /**
     * Pause a running workflow.
     */
    pause(runId: string): boolean;
    /**
     * Attach a human/controller response to a durable checkpoint that is waiting
     * (or resuming). Fail-closed: the response is durable on disk before this
     * resolves, so it survives a process restart.
     *
     * While the suspended execution is still draining its in-flight siblings (the
     * run is deliberately not sealed), the response is written through the LIVE
     * managed record with a fail-closed persist (the manager owns this run's
     * lease via the draining execution) — so attach works immediately instead of
     * blocking on the 1s settle guard. resume() still refuses until the drain
     * settles; hosts should attach first and resume on the "paused" event (the
     * documented flow).
     */
    attachCheckpointResponse(runId: string, checkpointId: string, responseValue: unknown): Promise<void>;
    /**
     * Resume a paused, failed, or stopped run, or rerun a finished one with an
     * edit: replay journaled results for unchanged calls and run the rest live.
     * Returns false if there is nothing resumable.
     *
     * `opts.script` lets the orchestrating model resume with an EDITED script
     * (cached-prefix reuse / iteration): unchanged agent() calls whose content
     * hash still matches the journal entry at their call index replay from
     * cache, while the first changed or newly inserted call and everything after
     * it re-runs live. `opts.tasks` does the same for a task-list run, where
     * every unchanged task replays wherever it moved. Without either, resume
     * uses the persisted script and args (auto-resume, TUI resume).
     */
    resume(runId: string, opts?: WorkflowResumeOptions): Promise<boolean>;
    /**
     * Stop a running or paused workflow.
     *
     * Only the execution that holds the run's lease owns it: abort it and persist
     * "aborted". Like pause(), it keeps the lease: the execution may drain for a
     * while and its executeRun() tail writes the run once more, so releasing now
     * would let another process resume the run and then lose that record to the
     * tail. The tail releases the lease and makes the run eviction-eligible. Any
     * other run is stopped through its record under a fresh lease (see stopRecord()).
     */
    stop(runId: string): boolean;
    /**
     * Stop a run that no execution in this process owns: one from an earlier
     * session, or one whose execution here has settled. A settled local copy only
     * caches the record, which another process may since have resumed (and still
     * be running), finished, or deleted, so the record decides. It is re-read
     * under the lease; a run another live process executes cannot be leased.
     */
    private stopRecord;
    private markStopped;
    /**
     * Queue an instruction into every running agent of a live run that has this
     * label. Resolves to the number of sessions that received it: 0 when the run
     * is not running here or no agent with that label is mid-session.
     */
    steerAgent(runId: string, label: string, text: string): Promise<number>;
    /**
     * Get status of a specific run.
     */
    getRun(runId: string): ManagedRun | undefined;
    /**
     * List all runs (active + persisted).
     */
    /**
     * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
     * that session's runs are returned — runs from other sessions stay on disk and
     * reappear when you switch back. Unbound (tests/legacy) returns everything.
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
    private readRecordPreview;
    /**
     * Drop a settled local copy whose record another process deleted. A copy
     * still executing holds the lease, and its next write detects the deletion;
     * a record that exists but fails validation is damaged, not deleted.
     */
    private dropIfDeleted;
    /**
     * Get snapshot of a run.
     */
    getSnapshot(runId: string): WorkflowSnapshot | null;
    /**
     * Delete a persisted run.
     *
     * If `runId` is still live in this process (running or paused-in-memory),
     * abort its controller FIRST, before any teardown below — a live run left
     * un-aborted would otherwise keep executing in the background indefinitely
     * (burning API calls/tokens/holding a worktree) after its record is gone.
     * Aborting first, while `managed` is still `this.runs.get(runId)`, costs
     * nothing extra: the abort signal is fire-and-forget (cooperative — the
     * execution winds down on its own schedule), so the exact instant we flip
     * `this.runs`/release the lease/delete files relative to it doesn't matter
     * for correctness. What DOES matter is that once this method returns, the
     * aborted execution's eventual settle (executeRun's success/catch path,
     * asynchronously, possibly much later) must be a harmless no-op rather than
     * a resurrection — that's what isCurrent() guarantees: `this.runs.delete()`
     * below means executeRun's later persistRun()/releaseRunLease() calls on
     * this same `managed` object find `this.runs.get(runId) !== managed` (in
     * fact `undefined`, since the entry is gone) and skip writing/releasing.
     */
    deleteRun(runId: string): boolean;
    /** Best-effort lease probe for deleteRun: any fs failure means REFUSE the
     * delete (r1 MINOR 1 — deleteRun must keep its no-throw contract; a probe
     * failure cannot prove ownership). */
    private tryAcquireDeleteLease;
    /**
     * Record the usage-limit scheduler's auto-resume backoff counter for a run.
     * Only a live run that still holds its lease goes through managed state (so
     * the next persistRun carries it). Disk-only rows and stale in-memory rows
     * whose execution released its lease merge the current persisted record under
     * a fresh lease — skipped on contention, since the owner persists
     * authoritatively. Never write this field via a raw persistence.save
     * side-channel — writeRunToDisk would erase it (#207).
     */
    recordAutoResumeAttempts(runId: string, attempts: number): void;
    /** Get the persistence layer (for saving workflows). */
    getPersistence(): RunPersistence;
}
export {};
