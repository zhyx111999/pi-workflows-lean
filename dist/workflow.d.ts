import type { TSchema } from "typebox";
import { type AgentRunOptions, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { type AgentRegistry } from "./agent-registry.js";
import { type AgentUsage } from "./agent-usage.js";
import { WorkflowErrorCode } from "./errors.js";
export interface WorkflowMetaPhase {
    title: string;
    detail?: string;
    model?: string;
}
export interface WorkflowMeta {
    name: string;
    description: string;
    phases?: WorkflowMetaPhase[];
    /** Default model for agents whose phase has no route and that set no model/tier. */
    model?: string;
}
/** One cached agent/checkpoint result, keyed by its deterministic call index. */
export interface JournalEntry {
    /** Lexical call index of the agent()/checkpoint() call within the run. */
    index: number;
    /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
    hash: string;
    result: unknown;
    /**
     * Per-agent write delta (keys set by this agent) for additive replay on resume.
     * Replaces the former full-map snapshot to fix parallel-agent ordering: applying
     * deltas in callSeq order accumulates all agents' writes correctly regardless of
     * which agent finished first. Absent on older journal entries.
     */
    storeDelta?: Record<string, unknown>;
    /**
     * The model this call actually ran on, captured post-resolution so a replayed
     * cache hit displays what really ran instead of the pre-resolution guess.
     * Absent on journal entries persisted before this field existed (and on
     * checkpoints, which run no model) — those degrade to the old behavior.
     */
    model?: string;
}
/** Minimal injected agent surface used by the workflow runtime and deterministic tests. */
export interface WorkflowAgentRunner {
    run(prompt: string, options?: AgentRunOptions<TSchema>): Promise<unknown>;
}
export interface WorkflowCheckpointInput {
    readonly checkpointId: string;
    readonly kind: string;
    readonly payload: unknown;
}
export interface WorkflowCheckpoint extends WorkflowCheckpointInput {
    readonly version: 1;
    readonly status: "waiting" | "resuming" | "consumed";
    readonly response?: unknown;
    readonly createdAt: string;
    readonly consumedAt?: string;
}
export interface WorkflowRunOptions extends WorkflowAgentOptions {
    args?: unknown;
    agent?: WorkflowAgentRunner;
    /** The session's main model (provider/id); the pre-resolution display guess and, with inheritMainModel on, the untagged routing target. */
    mainModel?: string;
    /**
     * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
     * run for determinism. Defaults to scanning `.pi/agents` (project) +
     * `~/.pi/agent/agents` (user, primary) + `~/.pi/agents` (user, deprecated
     * fallback). Injectable for tests.
     */
    agentRegistry?: AgentRegistry;
    /** Maximum concurrent agents, clamped to 1..16. Hosts pass the defaultConcurrency setting. */
    concurrency?: number;
    /** Retry attempts after a recoverable agent failure, clamped to 0..3. Default 0. */
    agentRetries?: number;
    signal?: AbortSignal;
    /** Maximum logical agent()/checkpoint() calls in this run. Default: 1000 */
    maxAgents?: number;
    /** Timeout per agent attempt in milliseconds. null/omitted means no hard timeout. */
    agentTimeoutMs?: number | null;
    /**
     * Grace period (ms) for the terminal drain once this run is ABORT-SIGNALED
     * (external abort or the run-fatal seal). A durable checkpoint suspension
     * alone does not abort its paid siblings. Agents are signaled at abort,
     * but the signal is cooperative — a signal-ignoring runner would otherwise
     * wedge the drain, and with it the run's terminal transition, forever
     * (audit2 #3). After the grace expires the drain stops waiting: the store is
     * disposed below (late writes re-populate a store nobody reads), no journal
     * can follow (the completion path's abort check precedes journaling), and
     * the manager's persist/emit paths are staleness-gated.
     *
     * Does NOT apply to the SUCCESS drain, which waits unbounded — those results
     * are still wanted. Default 10_000; Infinity restores unbounded waiting for
     * aborted runs too. Finite values in [1, 2^31-1] are rounded down; invalid
     * values (including NaN, 0, negatives, and overflow) use the default.
     */
    drainAbortGraceMs?: number;
    /** Whether to persist logs to disk. Default: true */
    persistLogs?: boolean;
    /** Run ID for persistence. Auto-generated if not provided. */
    runId?: string;
    /** Resume: cached agent/checkpoint results keyed by lexical call index. */
    resumeJournal?: Map<number, JournalEntry>;
    /**
     * No agent() call depends on another's result (a task-list run), so each
     * journaled call replays on its own hash match instead of only inside the
     * unchanged prefix.
     */
    independentCalls?: boolean;
    /** Called after each live agent completes so the caller can persist the journal. */
    onAgentJournal?: (entry: JournalEntry) => void;
    /** Active durable checkpoint response supplied by WorkflowManager.resume(). */
    resumeCheckpoint?: WorkflowCheckpoint;
    /** Persist a durable checkpoint transition before it becomes externally observable. */
    onWorkflowCheckpoint?: (checkpoint: WorkflowCheckpoint) => void;
    /**
     * Backoff (ms) before retry attempt N (1-based — the attempt that just
     * failed). Default: min(250 * 2^(N-1), 2000) — immediate retries let a whole
     * parallel() batch hammer the provider synchronously. The retry keeps its
     * concurrency slot during the backoff. Return 0 to disable; negative,
     * NaN, or non-finite returns fall back to the default; a throwing callback
     * is ignored (default used). Finite positive values are honored up to
     * 2000ms (above that, clamped — a multi-day park would ignore aborts for
     * its whole duration); abort latency during the wait is bounded by the
     * effective value.
     */
    agentRetryBackoffMs?: (failedAttempt: number) => number;
    /**
     * Seed the run's cumulative token usage from a previously-persisted total
     * (resume()). Replayed calls commit no usage, so without this the totals
     * reported for a resumed run would cover only what THIS execution spent.
     */
    initialTokenUsage?: AgentUsage;
    onLog?: (message: string) => void;
    onPhase?: (title: string) => void;
    onAgentStart?: (event: {
        id: string;
        label: string;
        phase?: string;
        prompt: string;
        model?: string;
        /** True when this event is a journal replay, not a new child launch. */
        replayed?: boolean;
    }) => void;
    /** Called immediately after a child SessionManager is created. */
    onAgentSession?: (event: {
        callId: string;
        sessionId: string;
        sessionFile?: string;
    }) => void;
    onAgentEnd?: (event: {
        /**
         * Unique per agent() CALL (not per label — concurrent agents routinely
         * share a label, e.g. parallel()'s default `"${phase} agent N"` labels or
         * an author-supplied label reused across a fan-out). Stable across this
         * call's start/end/history events. Callers must key any per-agent
         * bookkeeping on this, never on label, to avoid misattributing a
         * concurrent same-label agent's event to the wrong entry.
         */
        id: string;
        label: string;
        phase?: string;
        result: unknown;
        tokens?: number;
        tokenUsage?: AgentUsage;
        worktree?: string;
        model?: string;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
    }) => void;
    /** Called with cumulative display usage and an exact delta whenever usage becomes committed. */
    onAgentUsage?: (event: {
        id: string;
        label: string;
        phase?: string;
        tokenUsage: AgentUsage;
        committedUsage?: AgentUsage;
    }) => void;
    onAgentHistory?: (event: {
        id: string;
        label: string;
        phase?: string;
        history: AgentHistoryEntry[];
    }) => void;
    /**
     * Called when a live agent's session can take instructions, with `steer`
     * queueing one into it. Returns the function that unregisters the session
     * when it ends. `id` is the same per-call id as the onAgent* events.
     */
    registerAgentSteer?: (agent: {
        id: string;
        label: string;
        steer: (text: string) => Promise<void>;
    }) => () => void;
    /**
     * The agent's REAL model, pushed the moment WorkflowAgent resolves it — mid-run,
     * long before onAgentEnd. onAgentStart can only carry the pre-resolution guess
     * (this call's explicit/phase spec, else the session's main model), which is wrong
     * for every tier-routed agent: an explicit `tier` deliberately defers the choice to
     * the agent layer, and an untagged agent is implicitly routed through the "medium"
     * tier when model-tiers.json exists, or inherits the session's main model when the
     * inheritMainModel setting is on (see resolveAgentModelSpec). Without this channel
     * those agents display the main session model for their whole lifetime and only flip
     * to the truth once they finish — and when the implicit route DEGRADES to the
     * settings default (unavailable tier or inherited model), no spec resolves at
     * all, so nothing in this resolution path fires a correction. Fires once per ATTEMPT (and per turn for
     * a named thread), so treat it as idempotent, not once-per-agent. `id` is the same
     * per-CALL id as onAgentStart/onAgentEnd/onAgentHistory/onAgentUsage.
     */
    onAgentModel?: (event: {
        id: string;
        label: string;
        phase?: string;
        model: string;
    }) => void;
    onTokenUsage?: (usage: {
        input: number;
        output: number;
        total: number;
        cost: number;
        cacheRead?: number;
        cacheWrite?: number;
        /** True when the totals include character-heuristic estimates (#209). */
        estimated?: boolean;
    }) => void;
    /**
     * Top-level workflow error observed before runWorkflow drains in-flight agents.
     * This preserves error provenance for hosts whose own lifecycle control can race
     * with that cooperative drain. Observational only: callback failures (sync or
     * async) are ignored. A durable checkpoint suspension does NOT invoke this —
     * an intentional human-in-the-loop pause is not a fatal error (in-flight
     * siblings are waited out, not aborted).
     */
    onRunFatal?: (error: unknown) => void | PromiseLike<void>;
}
export interface WorkflowRunResult<T = unknown> {
    meta: WorkflowMeta;
    result: T;
    logs: string[];
    phases: string[];
    agentCount: number;
    durationMs: number;
    runId?: string;
    tokenUsage?: {
        input: number;
        output: number;
        total: number;
        cost: number;
        cacheRead?: number;
        cacheWrite?: number;
        /** True when the totals include character-heuristic estimates (#209). */
        estimated?: boolean;
    };
}
export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
    label?: string;
    phase?: string;
    schema?: TSchemaDef;
    /**
     * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
     * The workflow author chooses per-agent models per the routing policy in the
     * tool guidelines (e.g. a lighter model for exploration, the main model for
     * analysis). When omitted, the session's main model is used.
     */
    model?: string;
    /** Pi thinking level. Used when `model` has no `:thinking` suffix. */
    thinking?: import("./model-spec.js").ModelThinkingLevel;
    /**
     * Coarse model tier ("small" | "medium" | "big"), resolved from the user's
     * model-tiers config (see /workflows-models). An explicit `model` takes
     * precedence; a tier takes precedence over the phase model. When the tier has
     * no configured entry it falls back to the session's main model.
     */
    tier?: string;
    isolation?: "worktree" | false;
    /** Default true. False deletes the isolation worktree after the call (test runs). */
    keepWorktree?: boolean;
    /**
     * Bind this call to an existing absolute directory. The runtime resolves it
     * to its real path before dispatch so coding tools and agent identity agree.
     * Cannot be combined with worktree isolation.
     */
    cwd?: string;
    /**
     * Re-enter a named subagent conversation during this workflow invocation.
     * Calls using the same name must be sequential. Thread state is never resumed
     * across a later run or resume.
     */
    thread?: string;
    /**
     * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
     * user). Binds that definition's tool allow/denylist, model, and body prompt
     * to this agent. An explicit `model` overrides the definition's model; the
     * definition's model overrides `tier`/phase. An unknown name logs a warning
     * and falls back to default tools/model with no role prompt.
     */
    agentType?: string;
}
export declare function runWorkflow<T = unknown>(script: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult<T>>;
/**
 * Identity of one agent() call: its store delta key, the id carried by every
 * onAgent* event, and its persisted agent row's callId. Prefixed with the run
 * id so it stays unique when hosts aggregate agents across runs.
 */
export declare function agentCallId(runId: string, callIndex: number): string;
export declare function parseWorkflowScript(script: string): {
    meta: WorkflowMeta;
    body: string;
};
export declare function cloneDurableJsonValue(value: unknown, label: string): unknown;
