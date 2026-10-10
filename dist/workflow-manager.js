/**
 * Workflow manager for background execution, pause/resume, and run management.
 */
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { createEmptyAgentUsage, sumAgentUsage } from "./agent-usage.js";
import { DEFAULT_MAX_AGENTS } from "./config.js";
import { emptyFleetSummary, preview, recomputeWorkflowSnapshot, } from "./display.js";
import { isProviderUsageLimit, RunRecordDeletedError, WorkflowCheckpointSuspensionError, WorkflowError, WorkflowErrorCode, } from "./errors.js";
import { agentHasNonTerminalStatus, createRunPersistence, generateRunId, INTERRUPTED_AGENT_CAUSE, sanitizeAutoResumeAttempts, settleInterruptedPersistedAgents, settleNonTerminalPersistedAgents, terminalRunInterruptCause, VALID_PERSISTED_AGENT_STATUSES, } from "./run-persistence.js";
import { runSummary } from "./run-record-store.js";
import { isTaskListScript, parseSubagentTasks, unchangedTaskMoves } from "./subagent-tasks.js";
import { agentCallId, cloneDurableJsonValue, parseWorkflowScript, runWorkflow, } from "./workflow.js";
// A human's checkpoint reply fails with "still settling" when the pause tail
// (a full-state persist on a slow/synced disk) exceeds this cap (audit2 #19).
// 10s bounds the attach wait without flaking on Dropbox-hosted projects.
const DEFAULT_PAUSED_EXECUTION_SETTLE_TIMEOUT_MS = 10_000;
let pausedExecutionSettleTimeoutMs = DEFAULT_PAUSED_EXECUTION_SETTLE_TIMEOUT_MS;
/** @internal test hook — shrink the settle grace without 10s-long tests. */
export function _setPausedExecutionSettleTimeoutForTests(ms) {
    pausedExecutionSettleTimeoutMs = ms ?? DEFAULT_PAUSED_EXECUTION_SETTLE_TIMEOUT_MS;
}
async function waitForPausedExecutionSettlement(execution) {
    let timer;
    const settled = execution.then(() => true, () => true);
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), pausedExecutionSettleTimeoutMs);
        timer.unref?.();
    });
    const didSettle = await Promise.race([settled, timeout]);
    if (timer) {
        clearTimeout(timer);
    }
    return didSettle;
}
function taskListMoves(runId, persisted, opts) {
    if (opts.script !== undefined)
        throw new Error("resume takes an edited task list or an edited script, not both");
    if (!isTaskListScript(persisted.script)) {
        throw new Error(`run ${JSON.stringify(runId)} did not start from a task list; resume it with an edited script`);
    }
    const indices = unchangedTaskMoves(parseSubagentTasks(persisted.args), parseSubagentTasks(opts.tasks));
    const callIds = new Map([...indices].map(([from, to]) => [agentCallId(runId, from), agentCallId(runId, to)]));
    return { indices, callIds };
}
/**
 * Point a reused task's agent row at its new call id so replay updates that
 * row; a changed or dropped task's row keeps its history but no call id.
 */
function retargetAgentRow(agent, moves) {
    if (!agent || typeof agent !== "object" || typeof agent.callId !== "string")
        return agent;
    const callId = moves.callIds.get(agent.callId);
    if (callId)
        return { ...agent, callId };
    const { callId: _dropped, ...history } = agent;
    return history;
}
/**
 * Statuses in which a run's execution has genuinely settled — no promise is
 * still pending, no lease is still held, nothing will asynchronously mutate
 * this ManagedRun again. "paused" is deliberately excluded: both a manual
 * pause() and a usage-limit checkpoint leave the run resumable and, from the
 * in-memory-retention question's point of view, still "the run the user is
 * looking at" — only completed/failed/aborted runs are eviction candidates.
 * See the `runs` field doc comment for the full eviction lifecycle contract.
 */
const IN_MEMORY_TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);
/**
 * How many terminal (completed/failed/aborted) runs' full in-memory state
 * (agents array, journal, snapshot, agentTimestamps) to retain in `runs`
 * before the oldest is evicted. Kept small: a terminal run's data is fully
 * on disk (run-persistence.ts) by the time it's eviction-eligible, so the
 * in-memory copy exists only to serve a `getRun()`/`getSnapshot()` caller
 * that wants the LIVE object (vs. listRuns()'s persisted view) for a run
 * that *just* finished — a handful is enough for that; unbounded retention
 * is exactly the leak this bounds (run-level analog of the subagent
 * memory-retention mitigation in agent.ts).
 */
const DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY = 20;
export class WorkflowManager extends EventEmitter {
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
    runs = new Map();
    /**
     * FIFO of runIds that reached IN_MEMORY_TERMINAL_STATUSES, oldest first —
     * the eviction order for `runs` (see its doc comment). A runId can appear
     * more than once (e.g. resumed after eviction, then terminates again);
     * evicting is idempotent (recordTerminalRun() re-checks the CURRENT status
     * of the current map entry for that id before deleting), so duplicates
     * are harmless.
     */
    terminalRunQueue = [];
    maxTerminalRunsInMemory;
    /** Executions by managed run, so pause/resume can wait for settlement before overlapping. */
    executions = new WeakMap();
    persistence;
    cwd;
    concurrency;
    agent;
    /** The session's main model (provider/id), for auto-tiering explore agents and inheritMainModel routing. */
    mainModel;
    /** The host Pi session's model registry, shared with subagents. */
    modelRegistry;
    /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
    sessionId;
    /** The current host session file; copied to a run as immutable parent lineage. */
    sessionFile;
    maxAgents;
    agentTimeoutMs;
    agentRetries;
    toolsets;
    excludeSubagentTools;
    providerMiddlewareExtensions;
    persistAgentSessions;
    inheritMainModel;
    constructor(options = {}) {
        super();
        this.cwd = options.cwd ?? process.cwd();
        this.concurrency = options.concurrency ?? 8;
        this.agent = options.agent;
        this.mainModel = options.mainModel;
        this.modelRegistry = options.modelRegistry;
        this.sessionId = options.sessionId;
        this.sessionFile = options.sessionFile;
        this.maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
        this.agentTimeoutMs = options.agentTimeoutMs ?? null;
        this.agentRetries = options.agentRetries ?? 0;
        this.toolsets = options.toolsets;
        this.excludeSubagentTools = options.excludeSubagentTools;
        this.providerMiddlewareExtensions = options.providerMiddlewareExtensions;
        this.persistAgentSessions = options.persistAgentSessions ?? false;
        this.inheritMainModel = options.inheritMainModel ?? false;
        this.maxTerminalRunsInMemory = options.maxTerminalRunsInMemory ?? DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY;
        this.persistence = createRunPersistence(this.cwd);
        this.recoverStaleRuns();
    }
    /** Bind the manager to the current pi session, so new runs are tagged with it and
     * the navigator/task-panel show only this session's runs (set on session_start).
     * The optional file is retained as the immutable parent lineage for new runs.
     */
    setSessionId(id, sessionFile) {
        this.sessionId = id;
        this.sessionFile = sessionFile;
    }
    /** Currently bound pi session id (set on session_start), if any. */
    getSessionId() {
        return this.sessionId;
    }
    /** Currently bound pi session file (set on session_start), if any. */
    getSessionFile() {
        return this.sessionFile;
    }
    /** Project cwd this manager was constructed for (persistence + agent tools). */
    getCwd() {
        return this.cwd;
    }
    /**
     * Every live in-memory run, regardless of the navigator's session filter.
     * Stranded-pause / cross-session recovery must use this — listRuns() hides
     * runs whose frozen sessionId no longer matches the bound session.
     */
    listLiveRuns() {
        return [...this.runs.values()];
    }
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
    adoptLiveRunsToSession(sessionId, previousSessionId) {
        if (!sessionId)
            return 0;
        const prev = previousSessionId !== undefined ? previousSessionId : this.sessionId;
        let adopted = 0;
        for (const managed of this.runs.values()) {
            const active = managed.status === "running" || managed.status === "paused";
            const undelivered = managed.pendingDelivery != null;
            if (!active && !undelivered)
                continue;
            if (managed.sessionId === sessionId)
                continue;
            managed.sessionId = sessionId;
            this.persistRun(managed);
            adopted++;
        }
        // Disk-only undelivered rows (terminal runs already evicted from memory).
        // Re-home markers tagged with the previous session id; never claim foreign
        // or null sessionIds here (null live rows are claimed at bind flush).
        try {
            for (const state of this.persistence.list()) {
                if (!state.pendingDelivery)
                    continue;
                if (this.runs.has(state.runId))
                    continue;
                if (state.sessionId === sessionId)
                    continue;
                if (prev == null || state.sessionId !== prev)
                    continue;
                if (this.persistence.updateMetadata) {
                    if (!this.persistence.updateMetadata(state.runId, { sessionId }))
                        continue;
                }
                else
                    this.persistence.save({ ...state, sessionId });
                adopted++;
            }
        }
        catch {
            // best-effort — live adopt above is the critical path
        }
        return adopted;
    }
    /**
     * On startup, any persisted run still marked "running" belongs to a process
     * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
     * to "paused" — never "failed" — so its journal is preserved and resume() can
     * replay the completed prefix and finish the rest.
     */
    recoverStaleRuns() {
        try {
            for (const p of this.listAllRuns()) {
                if (this.runs.has(p.runId))
                    continue;
                const staleRunning = p.status === "running";
                const pausedWithGhostAgents = p.status === "paused" && runSummary(p).active > 0;
                if (!staleRunning && !pausedWithGhostAgents)
                    continue;
                const lease = this.persistence.acquireRunLease(p.runId);
                if (!lease)
                    continue;
                try {
                    if (this.persistence.recoverInterrupted) {
                        this.persistence.recoverInterrupted(p.runId);
                        continue;
                    }
                    const fresh = this.persistence.load(p.runId);
                    if (!fresh || (fresh.status !== "running" && fresh.status !== "paused"))
                        continue;
                    const endedAt = new Date().toISOString();
                    this.persistence.save({
                        ...fresh,
                        status: "paused",
                        updatedAt: endedAt,
                        agents: settleInterruptedPersistedAgents(fresh.agents, INTERRUPTED_AGENT_CAUSE, endedAt),
                    });
                }
                finally {
                    this.persistence.releaseRunLease(lease);
                }
            }
        }
        catch {
            // Recovery is best-effort; never let it block manager construction.
        }
    }
    /**
     * Refresh host configuration after Pi reloads the extension while retaining
     * this manager's live runs, controllers, leases, and event listeners.
     * Existing executions keep the options they captured at start; subsequent
     * runs and resumes use the refreshed values.
     */
    reconfigureAfterReload(options) {
        this.concurrency = options.concurrency ?? 8;
        this.maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
        this.agentTimeoutMs = options.agentTimeoutMs ?? null;
        this.agentRetries = options.agentRetries ?? 0;
        this.toolsets = options.toolsets;
        this.excludeSubagentTools = options.excludeSubagentTools;
        this.providerMiddlewareExtensions = options.providerMiddlewareExtensions;
        this.persistAgentSessions = options.persistAgentSessions ?? false;
        this.inheritMainModel = options.inheritMainModel ?? false;
    }
    /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
    setMainModel(spec) {
        this.mainModel = spec;
    }
    /** Set the host session's model registry so subagents resolve models consistently. */
    setModelRegistry(registry) {
        this.modelRegistry = registry;
    }
    /**
     * Expose the host session's model registry to integrations sharing this
     * manager. Workflow execution reads the same registry internally.
     */
    getModelRegistry() {
        return this.modelRegistry;
    }
    /**
     * Start a workflow in the background.
     * Returns immediately with a run ID; the workflow executes asynchronously.
     */
    startInBackground(script, args, exec = {}) {
        const parsed = parseWorkflowScript(script);
        const slug = parsed.meta.name
            ? parsed.meta.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 40) || "workflow"
            : "";
        const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
        const controller = new AbortController();
        const lease = this.persistence.acquireRunLease(runId);
        if (!lease)
            throw new Error(`Could not acquire workflow run lease for ${runId}`);
        const managed = {
            runId,
            status: "running",
            snapshot: {
                name: parsed.meta.name,
                description: parsed.meta.description,
                phases: parsed.meta.phases?.map((p) => p.title) ?? [],
                logs: [],
                agents: [],
                agentCount: 0,
                runningCount: 0,
                doneCount: 0,
                errorCount: 0,
            },
            controller,
            startedAt: new Date(),
            script,
            args,
            journal: [],
            background: true,
            sessionId: this.sessionId,
            parentSessionId: this.sessionId,
            parentSessionFile: this.sessionFile,
            lease,
            autoResume: exec.autoResume,
            toolset: exec.toolset,
            agentTimestamps: new Map(),
            agentsById: new Map(),
            agentSessionsByCallId: new Map(),
            replayedAgentStatesByCallId: new Map(),
            agentTimestampsByCallId: new Map(),
            replayedAgentCalls: new Set(),
            steerable: new Map(),
        };
        this.runs.set(runId, managed);
        try {
            // Persist initial state
            this.persistence.save({
                runId,
                workflowName: parsed.meta.name,
                script,
                args,
                sessionId: managed.sessionId,
                parentSessionId: managed.parentSessionId,
                parentSessionFile: managed.parentSessionFile,
                status: "running",
                phases: managed.snapshot.phases,
                agents: [],
                logs: [],
                startedAt: managed.startedAt.toISOString(),
                updatedAt: managed.startedAt.toISOString(),
                autoResume: managed.autoResume,
                // autoResumeAttempts deliberately omitted: the scheduler's counter
                // cannot exist before the run starts (ids are minted here).
                toolset: managed.toolset,
            });
        }
        catch (err) {
            this.releaseRunLease(managed);
            this.runs.delete(runId);
            throw err;
        }
        this.emit("started", { runId });
        // Run workflow asynchronously.
        // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
        // when a workflow is aborted/paused/stopped — executeRun()'s catch block
        // already records status/event/persist, but the promise still rejects.
        // The original promise is returned so callers can await it in try/catch.
        const promise = this.executeRun(managed, script, args, exec);
        this.executions.set(managed, promise);
        promise.catch(() => { });
        return { runId, promise };
    }
    /**
     * Execute a workflow synchronously (blocking) while still tracking it like a
     * background run, so the `/workflows` navigator and the live task panel see it.
     * `onProgress` fires on every progress event with the current snapshot, letting
     * a caller drive its own inline display.
     */
    async runSync(script, args, exec = {}) {
        const managed = this.createManaged(script, args);
        const lease = this.persistence.acquireRunLease(managed.runId);
        if (!lease)
            throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
        managed.lease = lease;
        managed.autoResume = exec.autoResume;
        managed.toolset = exec.toolset;
        this.runs.set(managed.runId, managed);
        // Persist the initial state immediately so listRuns()/the task panel can see
        // the run the moment it starts, not only after the first agent journals.
        this.persistRun(managed);
        const execution = this.executeRun(managed, script, args, exec);
        this.executions.set(managed, execution);
        return execution;
    }
    /** Build a fresh managed run with an empty snapshot. */
    createManaged(script, args) {
        const parsed = parseWorkflowScript(script);
        const slug = parsed.meta.name
            ? parsed.meta.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 40) || "workflow"
            : "";
        const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
        return {
            runId,
            status: "running",
            snapshot: {
                name: parsed.meta.name,
                description: parsed.meta.description,
                phases: parsed.meta.phases?.map((p) => p.title) ?? [],
                logs: [],
                agents: [],
                agentCount: 0,
                runningCount: 0,
                doneCount: 0,
                errorCount: 0,
            },
            controller: new AbortController(),
            startedAt: new Date(),
            script,
            args,
            journal: [],
            background: false,
            sessionId: this.sessionId,
            parentSessionId: this.sessionId,
            parentSessionFile: this.sessionFile,
            agentTimestamps: new Map(),
            agentsById: new Map(),
            agentSessionsByCallId: new Map(),
            replayedAgentStatesByCallId: new Map(),
            agentTimestampsByCallId: new Map(),
            replayedAgentCalls: new Set(),
            steerable: new Map(),
        };
    }
    async executeRun(managed, script, args, exec = {}) {
        const { resumeJournal, resumeCheckpoint, externalSignal, onProgress, tools, initialTokenUsage, drainAbortGraceMs } = exec;
        // Explicit tools win for this execution; else re-resolve the run's persisted
        // toolset tag (how a resumed /deep-research keeps its web tools); else the
        // agent layer's default coding tools.
        const resolvedTools = tools ?? (managed.toolset ? this.toolsets?.[managed.toolset]?.() : undefined);
        // Gated the same way as this.emitLive() below (see isCurrent()) — a stale
        // execution's progress callback would otherwise keep driving live UI
        // (task panel, etc.) for a run that's been superseded or deleted.
        const progress = () => {
            if (this.isCurrent(managed))
                onProgress?.(managed.snapshot);
        };
        // Live per-call display updates are keyed by the same unique `id` upstream
        // events carry (see managed.agentsById) — the manager keeps no separate map.
        // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
        // Own this listener for exactly this executeRun() invocation: a reused host
        // signal must not retain a settled manager/run closure or abort it later.
        let externalAbortListener;
        try {
            if (externalSignal) {
                externalAbortListener = () => this.abortForExternalSignal(managed);
                if (externalSignal.aborted) {
                    externalAbortListener();
                }
                else {
                    try {
                        externalSignal.addEventListener("abort", externalAbortListener, { once: true });
                    }
                    catch (error) {
                        throw new WorkflowError(`Failed to register external abort listener: ${error instanceof Error ? error.message : String(error)}`, WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false, details: error });
                    }
                }
            }
            const result = await runWorkflow(script, {
                cwd: this.cwd,
                args,
                // Use the managed run's persisted id as the workflow runId so the value
                // returned in result.runId matches the id that listRuns()/resume() use.
                // Otherwise runWorkflow mints an ephemeral `run-<ts>` id and the sync
                // path would surface a non-resumable id to the model.
                runId: managed.runId,
                agent: this.agent,
                mainModel: this.mainModel,
                modelRegistry: this.modelRegistry,
                persistAgentSessions: this.persistAgentSessions,
                inheritMainModel: this.inheritMainModel,
                parentSessionFile: managed.parentSessionFile,
                signal: managed.controller.signal,
                // Run limits come from the manager's current configuration for every
                // execution, so a resume picks up limits raised since the run started.
                concurrency: this.concurrency,
                agentRetries: this.agentRetries,
                maxAgents: this.maxAgents,
                agentTimeoutMs: this.agentTimeoutMs,
                drainAbortGraceMs,
                tools: resolvedTools,
                excludeTools: this.excludeSubagentTools,
                providerMiddlewareExtensions: this.providerMiddlewareExtensions,
                resumeJournal,
                independentCalls: isTaskListScript(script),
                resumeCheckpoint,
                onWorkflowCheckpoint: (checkpoint) => {
                    const previousCheckpoint = managed.checkpoint;
                    const previousStatus = managed.status;
                    managed.checkpoint = checkpoint;
                    if (checkpoint.status === "waiting")
                        managed.status = "paused";
                    try {
                        this.persistRun(managed, true);
                    }
                    catch (error) {
                        managed.checkpoint = previousCheckpoint;
                        managed.status = previousStatus;
                        throw error;
                    }
                },
                // Seed the run's token usage from the persisted total (resume()) so
                // the reported totals stay cumulative across a pause/resume cycle.
                initialTokenUsage,
                onAgentJournal: (entry) => {
                    // Append (crash-safe-ish): keep the latest entry per call index,
                    // then persist. This is the high-frequency progress persist (fires
                    // once per completed agent, can burst under concurrency) — throttled
                    // (trailing edge). Every lifecycle-critical persist below (status
                    // transitions, run end, pause/resume/stop) still calls persistRun()
                    // directly and flushes this.
                    managed.journal = managed.journal.filter((e) => e.index !== entry.index);
                    managed.journal.push(entry);
                    this.schedulePersist(managed);
                },
                onLog: (message) => {
                    managed.snapshot.logs.push(message);
                    this.emitLive(managed, "log", { runId: managed.runId, message });
                    progress();
                },
                onPhase: (title) => {
                    managed.snapshot.currentPhase = title;
                    if (!managed.snapshot.phases.includes(title)) {
                        managed.snapshot.phases.push(title);
                    }
                    this.emitLive(managed, "phase", { runId: managed.runId, title });
                    progress();
                },
                onAgentStart: (event) => {
                    // A replayed journaled call whose entry was seeded from the persisted
                    // snapshot (see resume(), #206) updates THAT entry in place — pushing
                    // a fresh one would duplicate every pre-pause agent in the record.
                    // Match the LAST seeded row with this callId: callIds are positional
                    // (`${runId}:${callIndex}`) and reused (ghost + live retry, edited
                    // scripts shifting indices), and the latest row is the most recent
                    // execution of that call.
                    let seeded;
                    if (event.replayed) {
                        for (let i = managed.snapshot.agents.length - 1; i >= 0; i--) {
                            const candidate = managed.snapshot.agents[i];
                            if (candidate.callId === event.id) {
                                seeded = candidate;
                                break;
                            }
                        }
                    }
                    let agentSnapshot;
                    if (seeded) {
                        // Keep the row's identity/history, refresh presentation fields from
                        // the replayed call — label is not part of the call hash, so a
                        // label-only script edit still replays and must not leave a stale
                        // label (or model) behind.
                        seeded.label = event.label;
                        seeded.phase = event.phase;
                        seeded.prompt = event.prompt;
                        if (event.model)
                            seeded.model = event.model;
                        agentSnapshot = seeded;
                    }
                    else {
                        const prior = event.replayed ? managed.replayedAgentStatesByCallId.get(event.id) : undefined;
                        const priorSession = event.replayed ? managed.agentSessionsByCallId.get(event.id) : undefined;
                        agentSnapshot = {
                            id: managed.snapshot.agents.length + 1,
                            callId: event.id,
                            label: event.label,
                            phase: event.phase,
                            prompt: event.prompt,
                            status: "running",
                            model: event.model ?? prior?.model,
                            sessionId: priorSession?.sessionId,
                            sessionFile: priorSession?.sessionFile,
                            tokens: prior?.tokens,
                            tokenUsage: prior?.tokenUsage,
                        };
                        managed.snapshot.agents.push(agentSnapshot);
                    }
                    const id = agentSnapshot.id;
                    // Index by the call's unique id (never label — see agentsById's doc
                    // comment) so onAgentEnd/onAgentHistory/onAgentUsage can resolve back
                    // to exactly THIS entry even when a concurrent sibling shares its
                    // label.
                    managed.agentsById.set(event.id, agentSnapshot);
                    // Journal replay does not launch a child. Preserve the original
                    // launch/completion timestamps; live calls capture a fresh launch.
                    const priorTimestamp = event.replayed ? managed.agentTimestampsByCallId.get(event.id) : undefined;
                    const timestamp = priorTimestamp ?? { startedAt: new Date().toISOString() };
                    managed.agentTimestamps.set(id, { ...timestamp });
                    // A replayed event is ALWAYS a replay (journal hit) — arm it even
                    // when the call left no persisted timestamp, so onAgentEnd never
                    // treats it as live and erases seeded endedAt/tokens.
                    if (event.replayed)
                        managed.replayedAgentCalls.add(event.id);
                    managed.agentTimestampsByCallId.set(event.id, { ...timestamp });
                    this.emitLive(managed, "agentStart", { runId: managed.runId, ...event });
                    progress();
                },
                onAgentModel: (event) => {
                    // The ONLY mid-run correction of a running agent's displayed model.
                    // agentsById is keyed by the per-CALL id (never the label), so a
                    // concurrent same-label sibling can't be misattributed.
                    const agent = managed.agentsById.get(event.id);
                    if (!agent) {
                        return;
                    }
                    agent.model = event.model;
                    // No persistRun() here: this fires once per attempt, and the throttled
                    // progress persist plus every terminal persist already pick the field up.
                    this.emitLive(managed, "agentModel", { runId: managed.runId, agentId: agent.id, ...event });
                    progress();
                },
                onAgentUsage: (event) => {
                    const agent = managed.agentsById.get(event.id);
                    if (!agent) {
                        return;
                    }
                    agent.tokens = event.tokenUsage.total;
                    agent.tokenUsage = event.tokenUsage;
                    if (event.committedUsage) {
                        this.commitFinalizedAgentUsage(managed, event.committedUsage);
                    }
                    this.emitLive(managed, "agentUsage", { runId: managed.runId, ...event });
                    // Detailed displays aggregate live per-agent usage; this event triggers
                    // their refresh without committing estimates into persisted run totals.
                    this.emitLive(managed, "tokenUsage", { runId: managed.runId, usage: managed.snapshot.tokenUsage });
                    progress();
                },
                onAgentSession: (event) => {
                    const agent = managed.agentsById.get(event.callId);
                    if (!agent)
                        return;
                    agent.sessionId = event.sessionId;
                    agent.sessionFile = event.sessionFile;
                    managed.agentSessionsByCallId.set(event.callId, {
                        sessionId: event.sessionId,
                        sessionFile: event.sessionFile,
                    });
                    // Session identity is available before the first prompt. Flush it so
                    // an immediate pause or process failure still leaves the child link.
                    this.persistRun(managed);
                    progress();
                },
                onAgentEnd: (event) => {
                    const agent = managed.agentsById.get(event.id);
                    if (agent) {
                        agent.status = event.result === null ? "error" : "done";
                        // Keep the full value for the interactive pager; compact surfaces
                        // continue to use resultPreview.
                        agent.result = event.result;
                        agent.resultPreview = preview(event.result);
                        agent.error = event.error;
                        agent.errorCode = event.errorCode;
                        agent.recoverable = event.recoverable;
                        const replayed = managed.replayedAgentCalls.has(event.id);
                        if (!replayed) {
                            if (event.tokenUsage) {
                                agent.tokenUsage = event.tokenUsage;
                                agent.tokens = event.tokenUsage.total;
                            }
                            else if (event.tokens !== undefined) {
                                agent.tokens = event.tokens;
                            }
                        }
                        if (event.model)
                            agent.model = event.model;
                        // Real per-agent end time — only terminal agents get one; a still-
                        // running agent's entry keeps endedAt undefined. Replayed entries
                        // retain the original completion time.
                        const ts = managed.agentTimestamps.get(agent.id);
                        if (ts && !replayed) {
                            ts.endedAt = new Date().toISOString();
                            managed.agentTimestampsByCallId.set(event.id, { ...ts });
                        }
                        managed.replayedAgentCalls.delete(event.id);
                        managed.agentsById.delete(event.id);
                    }
                    this.emitLive(managed, "agentEnd", { runId: managed.runId, ...event });
                    progress();
                },
                onAgentHistory: (event) => {
                    const agent = managed.agentsById.get(event.id);
                    if (agent) {
                        agent.history = event.history;
                    }
                    this.emitLive(managed, "agentHistory", { runId: managed.runId, agentId: agent?.id, ...event });
                    progress();
                },
                registerAgentSteer: ({ id, label, steer }) => {
                    const entry = { label, steer };
                    managed.steerable.set(id, entry);
                    // A retry registers a new session under the same call id; only remove our own.
                    return () => {
                        if (managed.steerable.get(id) === entry)
                            managed.steerable.delete(id);
                    };
                },
                onRunFatal: (error) => {
                    // Capture only provider limits that escaped BEFORE a manager lifecycle
                    // action. runWorkflow calls this before draining run-fatal siblings;
                    // a later pause()/stop() must not erase the quota checkpoint.
                    if (isProviderUsageLimit(error) &&
                        !managed.controller.signal.aborted &&
                        managed.lifecycleControl === undefined) {
                        managed.usageLimitEscapedBeforeLifecycleControl = error;
                    }
                },
                onTokenUsage: (usage) => {
                    managed.snapshot.tokenUsage = usage;
                    this.emitLive(managed, "tokenUsage", { runId: managed.runId, usage });
                    progress();
                },
            });
            // Guard against the "empty fleet" footgun: agent() resolves an exhausted
            // recoverable failure (e.g. AGENT_EMPTY_OUTPUT) to null rather than
            // throwing, so a run whose every agent came back null still reaches this
            // completed branch. Surface it loudly so an all-null result can't
            // masquerade as a successful fleet (the single per-agent log line is easy
            // to miss under concurrency). Emitted before the "complete" event.
            // Scope to THIS execution: rows seeded from the persisted record at
            // resume are history (#206) — a stale done row must not suppress the
            // all-empty warning when every live/replayed call returned null.
            const fleet = emptyFleetSummary(managed.snapshot.agents.filter((agent) => agent.id > (managed.seededAgentCount ?? 0) ||
                (agent.callId !== undefined && managed.replayedAgentCalls.has(agent.callId))));
            if (fleet.allEmpty) {
                const labels = fleet.emptyLabels.join(", ");
                const overflow = fleet.emptyCount > fleet.emptyLabels.length ? ` (+${fleet.emptyCount - fleet.emptyLabels.length} more)` : "";
                const warning = [
                    `⚠  Workflow produced no usable results: all ${fleet.emptyCount} agent(s) returned nothing (${labels}${overflow}).`,
                    `   agent() resolves recoverable failures (e.g. an empty model response) to null once retries are exhausted, so the run reports "completed" even though nothing was produced.`,
                    `   Common fixes: set defaultAgentRetries to 1-2 in the workflow settings for models that occasionally return empty, check the model's max output tokens, and read the per-agent errors above.`,
                ].join("\n");
                managed.snapshot.logs.push(warning);
                this.emitLive(managed, "log", { runId: managed.runId, message: warning });
                console.warn(`[workflow] ${warning.replace(/\n\s*/g, " ")}`);
            }
            // A pause() requested while the terminal drain was settling (the run's
            // script had already returned, so the drain was the only thing keeping
            // it non-terminal) owns the lifecycle: keep the run paused/resumable
            // instead of overwriting to completed — the result is already in
            // managed.result below and the journal carries the work, so a later
            // resume replays instantly and completes (audit2 #3 drain-grace makes
            // this window reachable for hung-then-abandoned agents).
            if (managed.status === "paused") {
                managed.result = result;
                // Fail-closed display: the drain's abandoned/slow siblings never get an
                // onAgentEnd post-abort — without this they would sit at "running"
                // forever on a settled, paused run (mirrors the catch-branch pause tail).
                this.settleManagedInterruptedAgents(managed, INTERRUPTED_AGENT_CAUSE, new Date());
                this.persistRun(managed);
                if (this.isCurrent(managed))
                    this.releaseRunLease(managed);
                return result;
            }
            managed.status = "completed";
            managed.result = result;
            // Gated the same way as disk/lease below (see emitLive()): a stale
            // execution's "complete" would otherwise still deliver a result for a
            // run that's been superseded or deleted (e.g. background result
            // delivery into the conversation) even though it's no longer current.
            this.emitLive(managed, "complete", { runId: managed.runId, result });
            // Persist final state. persistRun()/writeRunToDisk() already no-op if
            // `managed` has been superseded (resume()/deleteRun() took over this
            // runId) — see isCurrent(). Guard the lease release the same way: a
            // stale execution settling after resume() has already acquired a NEW
            // lease for this runId must not touch that newer lease's bookkeeping.
            this.persistRun(managed);
            if (this.isCurrent(managed)) {
                this.releaseRunLease(managed);
                // Now (and only now — after the run's data is safely on disk and its
                // lease released) does this run become eviction-eligible; see the
                // `runs` field doc comment.
                this.recordTerminalRun(managed.runId);
            }
            return result;
        }
        catch (error) {
            if (error instanceof WorkflowCheckpointSuspensionError && !managed.controller.signal.aborted) {
                managed.status = "paused";
                managed.error = undefined;
                this.persistRun(managed);
                if (this.isCurrent(managed)) {
                    this.releaseRunLease(managed);
                    this.emitLive(managed, "paused", {
                        runId: managed.runId,
                        reason: "workflow_checkpoint",
                        checkpoint: managed.checkpoint,
                    });
                }
                throw error;
            }
            const workflowError = error instanceof WorkflowCheckpointSuspensionError && managed.controller.signal.aborted
                ? new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })
                : error instanceof WorkflowError
                    ? error
                    : new WorkflowError(error instanceof Error ? error.message : String(error), WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
            const escapedUsageLimit = managed.usageLimitEscapedBeforeLifecycleControl;
            const usageLimitPaused = isProviderUsageLimit(workflowError) &&
                (escapedUsageLimit === workflowError ||
                    (!managed.controller.signal.aborted && managed.lifecycleControl === undefined));
            const lifecycleControlOwnsExecution = managed.lifecycleControl !== undefined &&
                managed.controller.signal.reason === managed.lifecycleControl.abortReason;
            const externalAbortOwnsExecution = managed.externalAbort !== undefined && managed.controller.signal.reason === managed.externalAbort.abortReason;
            const lifecycleControlledAbort = workflowError.code === WorkflowErrorCode.WORKFLOW_ABORTED && lifecycleControlOwnsExecution;
            const lateUsageLimitAfterLifecycleControl = isProviderUsageLimit(workflowError) && lifecycleControlOwnsExecution && !usageLimitPaused;
            const externalAbortError = externalAbortOwnsExecution
                ? new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true })
                : undefined;
            const terminalError = externalAbortError ?? workflowError;
            if (usageLimitPaused) {
                // A provider limit that escaped before a later pause()/stop() remains a
                // quota checkpoint. Preserve its reset hint and scheduler path instead
                // of letting the later control reclassify it as an ordinary failure.
                managed.status = "paused";
                managed.usageLimitPause = workflowError;
            }
            else if (externalAbortOwnsExecution) {
                // The host signal happened first. Its cancellation remains the terminal
                // cause; a non-cooperative agent's late provider/fatal/timeout result
                // must not turn the aborted run into a failure or quota checkpoint.
                managed.status = "aborted";
            }
            else if (lifecycleControlledAbort || lateUsageLimitAfterLifecycleControl) {
                // pause()/stop() already announced the requested state. Suppress only
                // their own AbortError, plus a provider result that arrived AFTER this
                // control cancelled the execution. The latter cannot revive a stop or
                // arm quota auto-resume after a human intentionally paused/stopped.
            }
            else if (managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.WORKFLOW_ABORTED) {
                // A host/external abort remains observable, but is not a failed workflow.
                managed.status = "aborted";
            }
            else {
                // A real failure wins even when the user requested pause/stop after it
                // escaped (for example, while runWorkflow is cooperatively draining a
                // run-fatal sibling). Never let a late control marker hide that failure.
                managed.status = "failed";
            }
            managed.error = terminalError;
            // Both branches gated via emitLive() (see its doc comment) — a stale
            // execution's "paused"/"error" is equally misleading once superseded.
            if (usageLimitPaused) {
                this.emitLive(managed, "paused", {
                    runId: managed.runId,
                    reason: "usage_limit",
                    error: workflowError,
                    resetHint: workflowError.resetHint,
                });
            }
            else if (!lifecycleControlledAbort && !lateUsageLimitAfterLifecycleControl && this.listenerCount("error") > 0) {
                // Guarded: EventEmitter throws on an unlistened "error" emit, which
                // would abort this catch block mid-way — skipping the final persist,
                // the lease release, and the real error rethrow below. Only the
                // AbortError proven to originate from pause()/stop() is excluded;
                // failures that raced with a later lifecycle control still surface.
                this.emitLive(managed, "error", { runId: managed.runId, error: terminalError });
            }
            // Persist final state (see the success-path comment above for the
            // isCurrent() rationale — same guard, same reason). Drain has finished,
            // so leftover queued/running agents are no longer in flight even when
            // pause() kept the run resumable.
            if (managed.status === "paused") {
                this.settleManagedInterruptedAgents(managed, INTERRUPTED_AGENT_CAUSE, new Date());
            }
            this.persistRun(managed);
            if (this.isCurrent(managed)) {
                this.releaseRunLease(managed);
                // "paused" (manual pause() or a usage-limit checkpoint) is
                // deliberately NOT eviction-eligible — only a genuinely settled
                // terminal status is (see IN_MEMORY_TERMINAL_STATUSES / the `runs`
                // field doc comment). recordTerminalRun() itself re-checks this too,
                // but skip the call entirely here so a paused run never even enters
                // the eviction queue.
                if (IN_MEMORY_TERMINAL_STATUSES.has(managed.status))
                    this.recordTerminalRun(managed.runId);
            }
            throw workflowError;
        }
        finally {
            // AbortSignal's once listener is removed when it fires, but explicit
            // removal is still required for normal/failing/paused executions where
            // it never fires. removeEventListener is idempotent for already-fired
            // listeners, so this is also safe across every terminal path.
            if (externalSignal && externalAbortListener) {
                try {
                    externalSignal.removeEventListener("abort", externalAbortListener);
                }
                catch (error) {
                    // Cleanup must never replace the workflow's real result/error. Keep a
                    // diagnostic for broken host signal implementations without changing
                    // lifecycle state, persistence, lease handling, or delivery.
                    console.warn("[workflow-manager] Failed to remove external abort listener:", error);
                }
            }
        }
    }
    /**
     * True when `managed` is still the live, current entry for its runId in
     * `this.runs` — false once resume() has replaced it with a new ManagedRun
     * object for the same runId, or deleteRun() has removed it entirely. A
     * superseded ManagedRun's async completion (executeRun's promise settling
     * well after something else already took over or tore down that runId)
     * must not write to disk or touch lease state on the newer execution's
     * behalf — see writeRunToDisk() and executeRun()'s post-await persist calls.
     */
    isCurrent(managed) {
        return this.runs.get(managed.runId) === managed;
    }
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
    emitLive(managed, event, payload) {
        if (this.isCurrent(managed))
            this.emit(event, payload);
    }
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
    recordTerminalRun(runId) {
        this.terminalRunQueue.push(runId);
        while (this.terminalRunQueue.length > this.maxTerminalRunsInMemory) {
            const oldest = this.terminalRunQueue.shift();
            if (oldest === undefined)
                break;
            const current = this.runs.get(oldest);
            // Re-check the CURRENT entry for this id (not the ManagedRun object
            // that was terminal when queued) — resume() may have since replaced
            // it with a fresh, live execution, which must never be evicted here.
            if (current && IN_MEMORY_TERMINAL_STATUSES.has(current.status)) {
                this.runs.delete(oldest);
            }
        }
    }
    /** Add one settled logical agent's exact usage to the persisted run aggregate. */
    commitFinalizedAgentUsage(managed, usage) {
        const prior = managed.snapshot.tokenUsage;
        const priorUsage = prior
            ? {
                input: prior.input,
                output: prior.output,
                total: prior.total,
                cost: prior.cost ?? 0,
                cacheRead: prior.cacheRead ?? 0,
                cacheWrite: prior.cacheWrite ?? 0,
                estimated: prior.estimated,
            }
            : createEmptyAgentUsage();
        managed.snapshot.tokenUsage = sumAgentUsage(priorUsage, usage);
    }
    /** Abort this execution for a host/tool signal, retaining provenance so a
     * non-cooperative agent's late result cannot overwrite the external abort. */
    abortForExternalSignal(managed) {
        if (managed.controller.signal.aborted)
            return;
        const abortReason = {};
        managed.externalAbort = { abortReason };
        managed.controller.abort(abortReason);
    }
    /** Abort this execution for an explicit user lifecycle action.
     *
     * AbortSignal.reason is an execution-scoped identity token. If the controller
     * had already been aborted externally, do not replace or annotate it: the
     * original external failure must remain observable when executeRun() settles.
     */
    abortForLifecycleControl(managed, action) {
        if (managed.controller.signal.aborted)
            return;
        const abortReason = {};
        managed.lifecycleControl = { action, abortReason };
        managed.controller.abort(abortReason);
    }
    releaseRunLease(managed) {
        if (!managed.lease)
            return;
        this.persistence.releaseRunLease(managed.lease);
        managed.lease = undefined;
    }
    /** Trailing-edge throttle window for high-frequency progress persists (see schedulePersist). */
    static PERSIST_THROTTLE_MS = 400;
    /** Pending trailing-edge persist timers for high-frequency progress events, keyed by runId. */
    persistTimers = new Map();
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
    schedulePersist(managed) {
        if (this.persistTimers.has(managed.runId))
            return; // already scheduled; the trailing write reads live state
        const timer = setTimeout(() => {
            this.persistTimers.delete(managed.runId);
            this.writeRunToDisk(managed);
        }, WorkflowManager.PERSIST_THROTTLE_MS);
        // A pending progress persist should never keep the process alive on its own.
        timer.unref?.();
        this.persistTimers.set(managed.runId, timer);
    }
    /**
     * Fail-closed: leftover queued/running agents are display-only after the
     * execution that owned them has gone. Replay is journal-keyed.
     */
    settleManagedInterruptedAgents(managed, cause, endedAt) {
        const endedAtIso = endedAt.toISOString();
        for (const agent of managed.snapshot.agents) {
            if (agent.status !== "running" && agent.status !== "queued")
                continue;
            agent.status = "skipped";
            agent.error = cause.error;
            agent.errorCode = cause.errorCode;
            agent.recoverable = false;
            const ts = managed.agentTimestamps.get(agent.id);
            if (ts)
                ts.endedAt ??= endedAtIso;
            else
                managed.agentTimestamps.set(agent.id, { startedAt: endedAtIso, endedAt: endedAtIso });
        }
        managed.snapshot = recomputeWorkflowSnapshot(managed.snapshot);
    }
    settleManagedAgentsForTerminalRun(managed, endedAt) {
        if (!IN_MEMORY_TERMINAL_STATUSES.has(managed.status))
            return;
        this.settleManagedInterruptedAgents(managed, terminalRunInterruptCause(managed.status, {
            message: managed.error?.message,
            code: managed.error?.code,
        }), endedAt);
    }
    /**
     * Persist immediately and synchronously. Cancels any pending throttled write
     * for this run first, so the write that lands is always the caller's current
     * (final) state — never superseded by a stale deferred write. Use this for
     * every lifecycle-critical persist: run start, status transitions, run end,
     * pause()/resume()/stop().
     */
    persistRun(managed, required = false) {
        // A superseded execution's persist call must not touch the CURRENT
        // execution's pending-timer bookkeeping for this runId (see isCurrent()).
        // writeRunToDisk() below re-checks this too (it's the sole choke point
        // schedulePersist()'s deferred timer also funnels through), so this is a
        // belt-and-suspenders early-out specifically for the timer-clearing side
        // effect, which writeRunToDisk() alone wouldn't prevent.
        if (!this.isCurrent(managed))
            return;
        const timer = this.persistTimers.get(managed.runId);
        if (timer) {
            clearTimeout(timer);
            this.persistTimers.delete(managed.runId);
        }
        this.writeRunToDisk(managed, required);
    }
    writeRunToDisk(managed, required = false) {
        // The sole choke point for every disk write (both persistRun()'s direct
        // calls and schedulePersist()'s deferred timer funnel through here) — skip
        // silently when `managed` is no longer the current entry for its runId
        // (see isCurrent()). This is an expected race outcome (resume() replaced
        // it, or deleteRun() removed it), not an error: writing anyway would
        // resurrect a torn-down run's file, or clobber a newer execution's
        // in-progress/completed state with this stale one's.
        //
        // This check is redundant with persistRun()'s own early-return for every
        // CURRENT call site — it earns its keep solely for schedulePersist()'s
        // deferred setTimeout callback, the one path into this method that skips
        // persistRun() entirely. That callback only fires from onAgentJournal, and
        // onAgentJournal only fires for a call that got PAST agent()'s
        // throwIfAborted() check (see workflow.ts) — which, since run-fatal abort
        // (runFatalController in workflow.ts) now seals every run the instant any
        // error escapes it uncaught, means a
        // genuinely superseded-but-never-aborted execution (the only kind that
        // could previously still journal a stray call after resume() replaced it)
        // is structurally impossible to construct anymore — see the "unreachable
        // defense-in-depth (#2)" test in workflow-manager.test.ts for the worked
        // example and its own note. This check is KEPT anyway: it costs nothing,
        // and removing it would silently reopen a stale-write path the moment any
        // future change (e.g. a new way to journal without throwIfAborted()'s
        // gate) reintroduces a producer for it.
        if (!this.isCurrent(managed))
            return;
        try {
            const now = new Date();
            const terminal = IN_MEMORY_TERMINAL_STATUSES.has(managed.status);
            if (terminal)
                this.settleManagedAgentsForTerminalRun(managed, now);
            // Every run keeps its journal: a finished or stopped run can be resumed with
            // an edited task list or script, reusing each unchanged call. Terminal runs
            // also keep full agent results for the navigator; live and paused runs hold
            // those in memory and in the journal.
            const keepsAgentResults = managed.status === "completed" || managed.status === "aborted";
            const persistError = terminal && managed.status !== "completed" ? managed.error : undefined;
            this.persistence.save({
                runId: managed.runId,
                workflowName: managed.snapshot.name,
                // Persist the real script + journal so the run can be resumed. Runs live
                // in workflow run storage — protect via directory permissions, not blanking.
                script: managed.script,
                args: managed.args,
                // Always the run's own delivery owner — never this.sessionId. A
                // mid-flight setSessionId() must not re-home it implicitly; only the
                // explicit adoptLiveRunsToSession() path may do so.
                sessionId: managed.sessionId,
                // Immutable lineage — unlike sessionId, these are never re-homed by a
                // session replacement or adoptLiveRunsToSession().
                parentSessionId: managed.parentSessionId,
                parentSessionFile: managed.parentSessionFile,
                // Fail-closed delivery marker — survives endpoint gaps / process restart.
                pendingDelivery: managed.pendingDelivery,
                journal: managed.journal,
                status: managed.status,
                error: persistError?.message,
                errorCode: persistError?.code,
                checkpoint: managed.checkpoint,
                // Persisted every write (not just at pause) so a stale read during the
                // "paused" event race (see UsageLimitScheduler) is still correct — this
                // is fixed at run-start and doesn't change over the run's lifetime.
                autoResume: managed.autoResume,
                // The scheduler's backoff counter — must round-trip or restarts reset
                // the give-up cap (#207).
                autoResumeAttempts: managed.autoResumeAttempts,
                // Start-time execution context, re-read by resume() (see ManagedRun).
                toolset: managed.toolset,
                pauseReason: managed.status === "paused"
                    ? managed.usageLimitPause
                        ? // usageLimitPause is only ever set when the escaping error is
                            // genuinely PROVIDER_USAGE_LIMIT, so it is unambiguous and wins:
                            // a checkpoint in ANY status (waiting/resuming/consumed) must
                            // never mask it — coldStartRearm filters on this value.
                            "usage_limit"
                        : managed.checkpoint
                            ? "workflow_checkpoint"
                            : undefined
                    : undefined,
                resetHint: managed.status === "paused" && managed.usageLimitPause ? managed.usageLimitPause.resetHint : undefined,
                phases: managed.snapshot.phases,
                currentPhase: managed.snapshot.currentPhase,
                // Real per-agent timestamps only (see agentTimestamps) — never the run's
                // own startedAt or "now" stamped onto every agent on every write. A
                // still-running agent on a live/paused run is persisted with no endedAt;
                // terminal persist stamps leftover in-flight agents first.
                agents: managed.snapshot.agents.map((a) => {
                    const { result, ...summary } = a;
                    const ts = managed.agentTimestamps.get(a.id);
                    return {
                        ...summary,
                        ...(keepsAgentResults && result !== undefined ? { result } : {}),
                        startedAt: ts?.startedAt,
                        endedAt: ts?.endedAt,
                    };
                }),
                logs: managed.snapshot.logs,
                result: managed.result?.result,
                tokenUsage: managed.snapshot.tokenUsage
                    ? {
                        input: managed.snapshot.tokenUsage.input,
                        output: managed.snapshot.tokenUsage.output,
                        total: managed.snapshot.tokenUsage.total,
                        cost: managed.snapshot.tokenUsage.cost,
                        cacheRead: managed.snapshot.tokenUsage.cacheRead,
                        cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
                        estimated: managed.snapshot.tokenUsage.estimated,
                    }
                    : undefined,
                startedAt: managed.startedAt.toISOString(),
                updatedAt: now.toISOString(),
                completedAt: terminal ? now.toISOString() : undefined,
                durationMs: managed.result?.durationMs ?? (terminal ? now.getTime() - managed.startedAt.getTime() : undefined),
            });
        }
        catch (err) {
            // Deletion by another process is authoritative: the local copy is stale.
            const deleted = err instanceof RunRecordDeletedError;
            if (deleted)
                this.forgetDeletedRun(managed);
            if (required)
                throw err;
            // Ordinary progress persistence remains best-effort. Durable checkpoint
            // transitions pass required=true and fail closed instead.
            if (!deleted)
                console.warn("[workflow-manager] Persist run failed:", err);
        }
    }
    /**
     * Another process deleted this run's record. Mirror a local deleteRun(): stop
     * any live execution, drop the in-memory copy, and notify watchers, so no later
     * lifecycle write can recreate the run.
     */
    forgetDeletedRun(managed) {
        if (!this.isCurrent(managed))
            return;
        if (!managed.controller.signal.aborted)
            managed.controller.abort();
        const timer = this.persistTimers.get(managed.runId);
        if (timer) {
            clearTimeout(timer);
            this.persistTimers.delete(managed.runId);
        }
        this.runs.delete(managed.runId);
        this.releaseRunLease(managed);
        this.emit("deleted", { runId: managed.runId });
    }
    /**
     * Pause a running workflow.
     */
    pause(runId) {
        const managed = this.runs.get(runId);
        if (managed?.status !== "running")
            return false;
        managed.status = "paused";
        this.abortForLifecycleControl(managed, "pause");
        this.emit("paused", { runId });
        // Persist the requested lifecycle state immediately, but retain the lease
        // until executeRun settles and writes exact abort-teardown usage.
        this.persistRun(managed);
        return true;
    }
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
    async attachCheckpointResponse(runId, checkpointId, responseValue) {
        const response = cloneDurableJsonValue(responseValue, "checkpoint response");
        const buildResuming = (checkpoint) => {
            if (checkpoint.checkpointId !== checkpointId) {
                throw new Error(`stale checkpoint response: expected ${JSON.stringify(checkpoint.checkpointId)}, received ${JSON.stringify(checkpointId)}`);
            }
            if (checkpoint.status !== "waiting") {
                if (isDeepStrictEqual(checkpoint.response, response))
                    return undefined;
                throw new Error(`conflicting response for checkpoint ${JSON.stringify(checkpointId)}`);
            }
            return { ...checkpoint, status: "resuming", response };
        };
        const active = this.runs.get(runId);
        const settlingExecution = active ? this.executions.get(active) : undefined;
        // Settled-execution probe: a .then handler attached to an already-settled
        // promise runs on the very next microtask, while one attached to a pending
        // promise does not. (Promise.race can't express this — a wrapped settled
        // entry still needs two hops.) Post-drain attaches keep the lease+disk path
        // so resume() sees the response on disk immediately; only a genuinely
        // draining execution takes the live-write path below.
        let executionPending = false;
        if (settlingExecution) {
            let settled = false;
            void settlingExecution.then(() => (settled = true), () => (settled = true));
            await Promise.resolve();
            executionPending = !settled;
        }
        if (settlingExecution && executionPending) {
            // The suspension's sibling drain (the run is deliberately not sealed, so
            // in-flight siblings finish and journal) can take as long as the slowest
            // agent — far past the 1s settle guard. The draining execution's final
            // persist happens strictly after the drain, so writing the response onto
            // the LIVE managed record is durable: that persist carries it to disk.
            // Attaching here keeps the documented host flow (attach, then resume on
            // the "paused" event) usable while siblings still settle.
            if (active?.lease && this.isCurrent(active)) {
                if (!active.checkpoint)
                    throw new Error("run has no durable checkpoint");
                const next = buildResuming(active.checkpoint);
                if (next === undefined)
                    return;
                const previousCheckpoint = active.checkpoint;
                active.checkpoint = next;
                try {
                    // Fail-closed durable write NOW: the manager owns this run's lease via
                    // the draining execution, and the checkpoint contract ("the response
                    // survives process restart") must hold even if the process dies
                    // mid-drain. The draining execution's later final persist reads
                    // managed.checkpoint live, so it carries this same resuming state.
                    this.persistRun(active, true);
                }
                catch (error) {
                    // Roll the live record back: the caller is told the attach failed, so
                    // the in-memory state must not keep a response that never reached
                    // disk (a retry with a different response must not conflict, and the
                    // drain's final persist must not silently write it).
                    active.checkpoint = previousCheckpoint;
                    throw error;
                }
                return;
            }
            if (!(await waitForPausedExecutionSettlement(settlingExecution))) {
                throw new Error(`workflow run ${JSON.stringify(runId)} is still settling`);
            }
        }
        const lease = this.persistence.acquireRunLease(runId);
        if (!lease)
            throw new Error(`workflow run ${JSON.stringify(runId)} is busy`);
        try {
            const persisted = this.persistence.load(runId);
            if (!persisted?.checkpoint)
                throw new Error("run has no durable checkpoint");
            const next = buildResuming(persisted.checkpoint);
            if (next === undefined)
                return;
            this.persistence.save({ ...persisted, checkpoint: next });
            if (active && this.isCurrent(active)) {
                active.checkpoint = next;
            }
        }
        finally {
            this.persistence.releaseRunLease(lease);
        }
    }
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
    async resume(runId, opts) {
        const active = this.runs.get(runId);
        if (active?.status === "running")
            return false;
        // A stopped or paused run may still be draining its last agents.
        const settlingExecution = active ? this.executions.get(active) : undefined;
        if (settlingExecution) {
            if (!(await waitForPausedExecutionSettlement(settlingExecution)))
                return false;
            if (this.runs.get(runId) !== active)
                return false;
        }
        const persisted = this.persistence.load(runId);
        const resumeCheckpoint = persisted?.checkpoint;
        if (opts?.checkpointId !== undefined) {
            if (!resumeCheckpoint)
                throw new Error("run has no durable checkpoint");
            if (resumeCheckpoint.checkpointId !== opts.checkpointId) {
                throw new Error(`stale checkpoint response: expected ${JSON.stringify(resumeCheckpoint.checkpointId)}, received ${JSON.stringify(opts.checkpointId)}`);
            }
            if (resumeCheckpoint.status === "waiting") {
                throw new Error(`checkpoint ${JSON.stringify(opts.checkpointId)} has no attached response`);
            }
            if (resumeCheckpoint.status === "consumed" && persisted?.status === "completed")
                return true;
        }
        else if (resumeCheckpoint?.status === "waiting" || resumeCheckpoint?.status === "resuming") {
            throw new Error(`run is waiting at checkpoint ${JSON.stringify(resumeCheckpoint.checkpointId)}; resume requires its exact checkpoint ID`);
        }
        // A finished run has nothing left to continue; it reruns only with an edit.
        const edited = opts?.script !== undefined || opts?.tasks !== undefined;
        if (!persisted?.script || (persisted.status === "completed" && !edited))
            return false;
        // Validated before the lease: nothing may throw once it is held.
        const taskMoves = opts?.tasks ? taskListMoves(runId, persisted, opts) : undefined;
        const lease = this.persistence.acquireRunLease(runId);
        if (!lease)
            return false;
        // The pre-lease read is stale the moment it returns: another process could
        // have stopped/deleted or otherwise updated the run in the window. Re-load
        // under the lease and fail closed on ANY change: resuming from the stale
        // snapshot could overwrite newer journal, agent, or checkpoint metadata.
        let fresh;
        try {
            fresh = this.persistence.load(runId);
        }
        catch (error) {
            this.persistence.releaseRunLease(lease);
            throw error;
        }
        if (!isDeepStrictEqual(fresh, persisted)) {
            this.persistence.releaseRunLease(lease);
            return false;
        }
        const script = opts?.script ?? persisted.script;
        const args = opts?.tasks ?? persisted.args;
        const recordedAgents = Array.isArray(persisted.agents) ? persisted.agents : [];
        const persistedAgents = taskMoves
            ? recordedAgents.map((agent) => retargetAgentRow(agent, taskMoves))
            : recordedAgents;
        // Normalize the persisted total-at-pause once: PersistedRunState.tokenUsage
        // has optional cost/cacheRead/cacheWrite (legacy runs may lack them), but
        // both the seeded snapshot and initialTokenUsage need concrete numbers.
        const priorTokenUsage = persisted.tokenUsage
            ? {
                input: persisted.tokenUsage.input,
                output: persisted.tokenUsage.output,
                total: persisted.tokenUsage.total,
                cost: persisted.tokenUsage.cost ?? 0,
                cacheRead: persisted.tokenUsage.cacheRead ?? 0,
                cacheWrite: persisted.tokenUsage.cacheWrite ?? 0,
                // The estimate flag is part of the value — an estimated prior total
                // must stay flagged through resume (#209).
                estimated: persisted.tokenUsage.estimated,
            }
            : undefined;
        const controller = new AbortController();
        // Seed the live snapshot from the persisted agents so the record never
        // regresses to an empty fleet across resume (#206): the persistRun below
        // would otherwise rewrite the run file with agents: [], and /workflows +
        // the task panel would lose every prior agent (permanently, for calls an
        // edited script never replays). Ghost entries (still queued/running when
        // the owning execution died) settle to "skipped" with the interrupt cause
        // and a wall-clock endedAt, mirroring settleManagedInterruptedAgents.
        // Replayed journaled calls update their seeded entry in place (see
        // onAgentStart) instead of pushing duplicates. Non-object entries (corrupt
        // or legacy records, #110-hardened everywhere else) are skipped.
        // Shape-guard the persisted journal, container AND elements: a corrupt
        // entry (null, non-object, index-less) must not throw AFTER the run lease
        // is acquired and the managed run registered (lease leak + phantom run).
        // Records from releases whose scripts could nest saved workflows also hold
        // entries tagged with a child frame's runId; those can never replay, so
        // they are dropped together with the obsolete tag.
        // An edited task list keeps each unchanged task's entry at its new index.
        const persistedJournal = (Array.isArray(persisted.journal) ? persisted.journal : []).flatMap((entry) => {
            if (!entry || typeof entry !== "object" || typeof entry.index !== "number")
                return [];
            const { runId: frameRunId, ...journalEntry } = entry;
            if (frameRunId !== undefined && frameRunId !== runId)
                return [];
            if (!taskMoves)
                return [journalEntry];
            const index = taskMoves.indices.get(journalEntry.index);
            return index === undefined ? [] : [{ ...journalEntry, index }];
        });
        const seededAgentTimestamps = new Map();
        // Settle ghosts at wall-clock, but never BEFORE the record's last write:
        // a backwards clock jump must not produce endedAt < updatedAt.
        const settledAt = new Date(Math.max(Date.now(), Date.parse(persisted.updatedAt) || 0)).toISOString();
        const seededAgents = [];
        // callId -> timestamp index, built alongside the rows (M3): ghosts carry
        // their SETTLE time here too, so a replayed journaled call on a ghost row
        // keeps those timestamps (recognition itself is the unconditional
        // replayedAgentCalls.add in onAgentStart; this map picks WHICH timestamps
        // survive the replay).
        const seededTimestampsByCallId = new Map();
        for (const agent of persistedAgents) {
            // Corrupt/legacy-entry guard (M1): only well-shaped rows seed — a plain
            // object with a valid status union member and string label/prompt.
            // Anything else (null, arrays, fieldless objects, unknown statuses) is
            // dropped instead of being seeded as a garbage row and re-persisted.
            if (!agent ||
                typeof agent !== "object" ||
                Array.isArray(agent) ||
                !VALID_PERSISTED_AGENT_STATUSES.has(agent.status) ||
                typeof agent.label !== "string" ||
                typeof agent.prompt !== "string") {
                continue;
            }
            const id = seededAgents.length + 1;
            const { startedAt: rawStartedAt, endedAt: rawEndedAt, callId: rawCallId, ...snapshotFields } = agent;
            // Per-field type hygiene (corrupt records): non-string timestamps/callIds
            // are dropped from the seeded row rather than re-persisted as garbage.
            const startedAt = typeof rawStartedAt === "string" ? rawStartedAt : undefined;
            const endedAt = typeof rawEndedAt === "string" ? rawEndedAt : undefined;
            const callId = typeof rawCallId === "string" ? rawCallId : undefined;
            const ghost = agentHasNonTerminalStatus(agent.status);
            const rowTimestamps = startedAt
                ? { startedAt, endedAt: endedAt ?? (ghost ? settledAt : undefined) }
                : ghost
                    ? { startedAt: settledAt, endedAt: settledAt }
                    : // Terminal row with only an endedAt (the codebase's own settle paths
                        // produce these): keep it, anchored as both ends, rather than
                        // dropping the only timing provenance the record has.
                        endedAt
                            ? { startedAt: endedAt, endedAt }
                            : undefined;
            if (callId !== undefined) {
                // Duplicate callIds: the LAST row wins, matching the onAgentStart
                // reverse-scan "latest row is the most recent execution" rule — even
                // when that last row has no usable timestamps (delete the stale entry:
                // the replay must not borrow a DIFFERENT execution's timestamps).
                if (rowTimestamps)
                    seededTimestampsByCallId.set(callId, rowTimestamps);
                else
                    seededTimestampsByCallId.delete(callId);
            }
            if (rowTimestamps) {
                seededAgentTimestamps.set(id, rowTimestamps);
            }
            seededAgents.push(ghost
                ? {
                    ...snapshotFields,
                    id,
                    callId,
                    // Align with settleInterruptedPersistedAgents: the interrupt cause
                    // overwrites unconditionally — a ghost's stale error field is not
                    // meaningful provenance.
                    status: "skipped",
                    error: INTERRUPTED_AGENT_CAUSE.error,
                    errorCode: INTERRUPTED_AGENT_CAUSE.errorCode,
                    recoverable: false,
                }
                : { ...snapshotFields, id, callId });
        }
        const managed = {
            runId,
            status: "running",
            snapshot: recomputeWorkflowSnapshot({
                name: persisted.workflowName,
                phases: Array.isArray(persisted.phases) ? persisted.phases : [],
                currentPhase: persisted.currentPhase,
                logs: Array.isArray(persisted.logs) ? persisted.logs : [],
                agents: seededAgents,
                agentCount: 0,
                runningCount: 0,
                doneCount: 0,
                errorCount: 0,
                // Seed the live snapshot's aggregate from the persisted total-at-pause
                // so a pause that lands before this resume's first agent
                // completes doesn't lose the prior spend — committed onAgentUsage
                // deltas accumulate on top of this rather than starting from scratch.
                tokenUsage: priorTokenUsage,
            }),
            controller,
            startedAt: new Date(),
            // The (possibly edited) script + args become the run's own — persistRun()
            // writes them below, so a later resume of this run sees the edited script.
            script,
            args,
            journal: persistedJournal,
            checkpoint: resumeCheckpoint,
            background: true,
            // Prefer the frozen owner on disk; fall back to the manager's current
            // session only for legacy runs that predate per-run sessionId. Resuming
            // may change the delivery owner, but never the run's parent lineage.
            sessionId: persisted.sessionId ?? this.sessionId,
            parentSessionId: persisted.parentSessionId ?? persisted.sessionId ?? this.sessionId,
            parentSessionFile: persisted.parentSessionFile,
            // Carry any undelivered conversation payload across resume so session_start
            // flush can still re-inject after a pause/restart gap.
            pendingDelivery: persisted.pendingDelivery,
            lease,
            // Carry the original opt-out forward across resumes; it's fixed at
            // run-start and persistRun() re-persists it on every subsequent write.
            autoResume: persisted.autoResume,
            // Same for the usage-limit backoff counter — it must survive manager
            // persists and process restarts or the give-up cap resets (#207).
            autoResumeAttempts: sanitizeAutoResumeAttempts(persisted.autoResumeAttempts),
            // The toolset tag executeRun re-resolves so e.g. a resumed /deep-research
            // keeps its web tools. Run limits are not restored: older records may
            // still carry them, but every execution uses the manager's current ones.
            toolset: persisted.toolset,
            // Seeded above from persisted agents: replayed journaled calls update
            // their seeded snapshot entry in place; live calls append. Replayed
            // calls do not recreate a child session, so carry their prior identities into the new snapshot.
            agentTimestamps: seededAgentTimestamps,
            agentsById: new Map(),
            agentSessionsByCallId: new Map(persistedAgents
                .filter((agent) => agent && typeof agent === "object" && agent.callId && (agent.sessionId || agent.sessionFile))
                .map((agent) => [agent.callId, { sessionId: agent.sessionId, sessionFile: agent.sessionFile }])),
            replayedAgentStatesByCallId: new Map(persistedAgents
                .filter((agent) => agent && typeof agent === "object" && agent.callId)
                .map((agent) => [agent.callId, agent])),
            agentTimestampsByCallId: seededTimestampsByCallId,
            seededAgentCount: seededAgents.length,
            replayedAgentCalls: new Set(),
            steerable: new Map(),
        };
        this.runs.set(runId, managed);
        // Persist before notifying renderers: listRuns() is their source of truth for
        // lifecycle status, while getRun() supplies the live in-memory snapshot.
        this.persistRun(managed);
        const resumeJournal = new Map(persistedJournal.map((e) => [e.index, e]));
        this.emit("resumed", { runId });
        // Run in the background; executeRun records status/errors on the managed run.
        // initialTokenUsage seeds the resumed execution's token usage from the
        // persisted total-at-pause, so reported totals stay cumulative. The agent
        // count needs no seeding: agent() counts every call, cache-hit or live,
        // before the replay check, and resume replays the whole script from
        // callIndex 0, so maxAgents stays a genuine cumulative cap.
        const execution = this.executeRun(managed, script, args, {
            resumeJournal,
            resumeCheckpoint: resumeCheckpoint?.status === "resuming" ? resumeCheckpoint : undefined,
            initialTokenUsage: priorTokenUsage,
        });
        this.executions.set(managed, execution);
        void execution.catch(() => { });
        return true;
    }
    /**
     * Stop a running workflow.
     *
     * Fast path: the run is live in this process (`this.runs`) — abort its
     * controller and persist "aborted" as before. Fallback: the run is not in
     * memory but is persisted as "running" or "paused" — e.g. it belongs to a
     * prior pi session that this process's recoverStaleRuns() flipped to
     * "paused" on disk without repopulating this.runs (see subagents-control-tool's
     * findRun(), which resolves candidates from disk via listAllRuns()). There is no
     * live controller to abort in that case — the run simply isn't executing in
     * this process — so mark it aborted on disk directly, mirroring resume()'s
     * persisted-fallback lease handling.
     */
    stop(runId) {
        const managed = this.runs.get(runId);
        if (managed) {
            if (managed.status !== "running" && managed.status !== "paused")
                return false;
            // Whether this run's OWN executeRun() promise has already fully settled
            // matters for whether stop() itself must be the one to call
            // recordTerminalRun(): a usage-limit checkpoint runs executeRun()'s
            // catch tail to completion before "paused" is ever observable (it
            // deliberately skipped recordTerminalRun() then, since "paused" isn't
            // terminal) — so there is no FUTURE tail left that will ever call it
            // for this managed object. A manual pause() sets "paused" while its
            // cooperative abort may still be settling; in that narrow window the
            // tail later settles this object to "aborted" (terminal) and records a
            // SECOND time — a tolerated duplicate: recordTerminalRun() is
            // idempotent-safe under duplicates (re-validates the current entry),
            // the lease was already cleared here, and the worst case is the
            // stopped run leaving memory earlier than FIFO order (persistence
            // fallback covers every consumer). A "running" run, by contrast,
            // always still has that tail pending;
            // it (not stop()) is what calls recordTerminalRun() once it actually
            // settles to "aborted" — see the `runs` field doc comment's rule that
            // eviction eligibility must wait for the real settle, not a request to
            // abort. Without this, stopping an already-paused run left it in
            // `runs` forever (no future tail to mark it eviction-eligible) — a
            // small leak in exactly the class this manager otherwise bounds.
            const hadNoPendingSettle = managed.status === "paused";
            managed.status = "aborted";
            managed.error ??= new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
                recoverable: true,
            });
            this.abortForLifecycleControl(managed, "stop");
            this.emit("stopped", { runId });
            this.persistRun(managed);
            this.releaseRunLease(managed);
            if (hadNoPendingSettle)
                this.recordTerminalRun(runId);
            return true;
        }
        const persisted = this.persistence.load(runId);
        if (!persisted || (persisted.status !== "running" && persisted.status !== "paused"))
            return false;
        const lease = this.persistence.acquireRunLease(runId);
        if (!lease)
            return false;
        try {
            const endedAt = new Date().toISOString();
            const errorMessage = persisted.error ?? "workflow aborted";
            const errorCode = persisted.errorCode ?? WorkflowErrorCode.WORKFLOW_ABORTED;
            this.persistence.save({
                ...persisted,
                status: "aborted",
                updatedAt: endedAt,
                completedAt: persisted.completedAt ?? endedAt,
                error: errorMessage,
                errorCode,
                agents: settleNonTerminalPersistedAgents(persisted.agents, "aborted", { message: errorMessage, code: errorCode }, endedAt),
            });
        }
        finally {
            this.persistence.releaseRunLease(lease);
        }
        this.emit("stopped", { runId });
        return true;
    }
    /**
     * Queue an instruction into every running agent of a live run that has this
     * label. Resolves to the number of sessions that received it: 0 when the run
     * is not running here or no agent with that label is mid-session.
     */
    async steerAgent(runId, label, text) {
        const managed = this.runs.get(runId);
        if (managed?.status !== "running")
            return 0;
        const targets = [...managed.steerable.values()].filter((agent) => agent.label === label);
        await Promise.all(targets.map((agent) => agent.steer(text)));
        return targets.length;
    }
    /**
     * Get status of a specific run.
     */
    getRun(runId) {
        return this.runs.get(runId);
    }
    /**
     * List all runs (active + persisted).
     */
    /**
     * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
     * that session's runs are returned — runs from other sessions stay on disk and
     * reappear when you switch back. Unbound (tests/legacy) returns everything.
     */
    listRuns() {
        const all = this.persistence.list();
        return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
    }
    /** All persisted runs regardless of session (used by cross-session recovery). */
    listAllRuns() {
        return this.persistence.list();
    }
    /**
     * Get snapshot of a run.
     */
    getSnapshot(runId) {
        return this.runs.get(runId)?.snapshot ?? null;
    }
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
    deleteRun(runId) {
        const managed = this.runs.get(runId);
        // Lease ownership gate (audit2 #16, r1 MAJOR 1): only skip the acquire
        // when the managed entry ACTUALLY owns its lease. A paused/terminal
        // in-memory entry released its lease at pause settle (:1144) — a foreign
        // process that resumed the run holds it, and an ungated delete here would
        // be resurrected by that process's next persist.
        let heldLease;
        if (managed) {
            if (!managed.controller.signal.aborted)
                managed.controller.abort();
            if (managed.lease) {
                // Hold across the delete (r1 MINOR 4): releasing before the unlink
                // opens a window for a foreign acquire whose next persist resurrects
                // the run after a "successful" delete. Release below; deleteRunFiles
                // already unlinks the lock sidecar, making that release a harmless
                // no-op.
                heldLease = managed.lease;
                managed.lease = undefined;
            }
            else {
                heldLease = this.tryAcquireDeleteLease(runId);
                if (!heldLease)
                    return false;
            }
        }
        else {
            // Cross-process delete (audit2 #16): the owning process's next persist
            // would silently resurrect a deleted run. Refuse while another live
            // process holds the run lease — mirroring stop()'s persisted-fallback
            // path.
            heldLease = this.tryAcquireDeleteLease(runId);
            if (!heldLease)
                return false;
        }
        this.runs.delete(runId);
        // Cancel any pending throttled write so a deferred persist can't fire after
        // deletion and resurrect the run's file on disk.
        const timer = this.persistTimers.get(runId);
        if (timer) {
            clearTimeout(timer);
            this.persistTimers.delete(runId);
        }
        try {
            const deleted = this.persistence.delete(runId);
            // Notify watchers (watchRun subscribes to "deleted"): without an event, a
            // /workflows watch on a deleted run leaks all of its listeners and strands
            // the status-bar entry forever (audit2 #34). Emit when the run existed in
            // memory even if the file was already gone out-of-band — the lifecycle
            // fact is what watchers need.
            if (deleted || managed)
                this.emit("deleted", { runId });
            return deleted;
        }
        finally {
            if (heldLease)
                this.persistence.releaseRunLease(heldLease);
        }
    }
    /** Best-effort lease probe for deleteRun: any fs failure means REFUSE the
     * delete (r1 MINOR 1 — deleteRun must keep its no-throw contract; a probe
     * failure cannot prove ownership). */
    tryAcquireDeleteLease(runId) {
        try {
            return this.persistence.acquireRunLease(runId) ?? undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Record the usage-limit scheduler's auto-resume backoff counter for a run.
     * Only a live run that still holds its lease goes through managed state (so
     * the next persistRun carries it). Disk-only rows and stale in-memory rows
     * whose execution released its lease merge the current persisted record under
     * a fresh lease — skipped on contention, since the owner persists
     * authoritatively. Never write this field via a raw persistence.save
     * side-channel — writeRunToDisk would erase it (#207).
     */
    recordAutoResumeAttempts(runId, attempts) {
        // A corrupt/foreign value must never reach the record: NaN/negative would
        // defeat the scheduler's give-up cap and produce NaN timer delays.
        if (sanitizeAutoResumeAttempts(attempts) === undefined)
            return;
        const managed = this.runs.get(runId);
        // Only an actively leased ManagedRun is authoritative. Paused and terminal
        // entries remain in `runs` after their execution releases its lease; another
        // process may then have resumed and rewritten the disk record. Persisting a
        // whole stale ManagedRun from here would clobber that newer status/journal.
        if (managed?.lease) {
            if ((managed.autoResumeAttempts ?? 0) === attempts)
                return;
            managed.autoResumeAttempts = attempts;
            this.persistRun(managed);
            return;
        }
        const lease = this.persistence.acquireRunLease(runId);
        if (!lease)
            return;
        try {
            const current = this.persistence.loadPreview ? this.persistence.loadPreview(runId) : this.persistence.load(runId);
            if (!current)
                return;
            if ((current.autoResumeAttempts ?? 0) !== attempts) {
                if (this.persistence.updateMetadata) {
                    if (!this.persistence.updateMetadata(runId, { autoResumeAttempts: attempts }))
                        return;
                }
                else
                    this.persistence.save({ ...current, autoResumeAttempts: attempts });
            }
            // A local entry without a lease is only a cache. Once the lease-guarded
            // merge succeeds, bring that cache up to date without making it an
            // authority for any other persisted field.
            if (managed)
                managed.autoResumeAttempts = attempts;
        }
        finally {
            this.persistence.releaseRunLease(lease);
        }
    }
    /** Get the persistence layer (for saving workflows). */
    getPersistence() {
        return this.persistence;
    }
}
