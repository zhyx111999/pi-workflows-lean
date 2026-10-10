import type { TSchema } from "typebox";
import { type AgentRunOptions, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { type AgentRegistry } from "./agent-registry.js";
import { type AgentUsage } from "./agent-usage.js";
import { WorkflowCheckpointSuspensionError, WorkflowErrorCode } from "./errors.js";
import { SharedStore } from "./shared-store.js";
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
/** One cached agent/checkpoint result, keyed by its deterministic workflow call identity. */
export interface JournalEntry {
    index: number;
    /**
     * The runId of the frame (top-level run, or a nested workflow()'s own run)
     * this entry's `index` is scoped to. A nested workflow() restarts its own
     * callSeq at 0, so `index` alone collides between a parent's and a child's
     * same-numbered calls — see `resumeJournal`'s key format, which namespaces
     * on this the same way SharedStore's deltaKey already does. Absent on
     * journal entries persisted before this field existed; such legacy entries
     * are treated as belonging to the run's own top-level runId (see
     * WorkflowManager.resume()) — a legacy entry that actually belonged to a
     * nested frame simply cache-misses on resume (safe degradation: it re-runs
     * live, it does not apply to the wrong call).
     */
    runId?: string;
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
/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
    limiter: <T>(fn: () => Promise<T>) => Promise<T>;
    agentCount: number;
    spent: number;
    tokenUsage: AgentUsage;
    /** Set after the top-level drain seals abandoned agent callbacks. */
    agentCallbacksClosed?: boolean;
    /** Active attempts whose usage must be finalized when an abort drain abandons them. */
    pendingUsageFinalizers?: Set<() => void>;
    /** @deprecated Nesting depth is async-context scoped; retained for injected runtime compatibility. */
    depth: number;
    /**
     * Monotonic count of every workflow() call anywhere in this run tree,
     * regardless of nesting depth — used (instead of `depth`) to build each
     * nested run's runId suffix (see workflowFn below). `depth` alone is NOT
     * enough: it returns to 0 after each nested call finishes, so two
     * SEQUENTIAL nested workflow() calls at the same depth (`await
     * workflow('a'); await workflow('b')`) would otherwise both compute the
     * exact same `${runId}-nested1` suffix. That collision matters because a
     * child's own callSeq restarts at 0, so its deltaKey (`${childRunId}:
     * ${callIndex}`) — the same id used as SharedStore's delta key AND as the
     * onAgentStart/onAgentEnd/onAgentHistory event id (see item 2's identity
     * model) — would collide between the two children's same-callIndex calls.
     * That's a real, not just theoretical, collision risk: an un-awaited
     * stray agent() call from the first child (still in SharedRuntime.inFlight,
     * not yet drained — only the top-level frame drains) can still be pending
     * when the second child starts and mints the very same id.
     */
    nestedCallSeq: number;
    /** Exact durable checkpoint currently waiting or resuming across this run tree. */
    activeCheckpointId: string | null;
    /** Persisted response currently being consumed by exactly one checkpoint in the run tree. */
    activeCheckpointResponse: WorkflowCheckpoint | null;
    /** Every durable checkpoint ID encountered across outer and nested workflow frames. */
    seenCheckpointIds: Set<string>;
    /** A durably accepted suspension cannot be swallowed into a successful run. */
    checkpointSuspension?: WorkflowCheckpointSuspensionError;
    /**
     * Fires exactly once a run-fatal error is determined: an error that escaped
     * the TOP-level script's own execution completely uncaught (see runWorkflow's
     * catch below) — i.e. nothing anywhere in the call chain, at any nesting
     * depth, caught it, so the run really is failing. Shared (not per-nesting-
     * level) so a nested workflow()'s in-flight siblings wind down too, the
     * instant the fate of the WHOLE run is sealed — not the instant any single
     * fan-out rejects, which would break parallel()'s null-on-recoverable-error
     * contract and a script's own try/catch around agent()/workflow(). Every
     * agent() call (this level and any nested workflow()) links its per-attempt
     * AbortController to this signal, alongside the caller's own options.signal,
     * so already-in-flight sibling subagent sessions actually abort instead of
     * running to completion on a run whose outcome is already decided. Wrapped
     * in an AbortController (not a bare boolean) purely so workflow.ts never
     * needs write access to the caller-owned options.signal/AbortController.
     */
    runFatalController: AbortController;
    /**
     * Every agent() promise spawned anywhere in this run (this level's script
     * and any nested workflow()'s), added on call and removed on settle. Drained
     * (awaited to completion) by the TOP-level runWorkflow's finally, before the
     * SharedStore is disposed — so a script that forgets to `await agent(...)`
     * can never have that call still mutating the store (or reporting results)
     * after the run has been marked complete and torn down. See the drain below.
     */
    inFlight: Set<Promise<unknown>>;
    /** Named conversations currently executing anywhere in this run tree. */
    activeThreads: Set<string>;
    /** Whether a threaded call has invalidated journal replay for the remaining run tree. */
    resumeBarrierReached: boolean;
}
/** Runtime instrumentation for workflow boundaries, quality helpers, and control attempts. */
export type WorkflowRuntimeEvent = {
    type: "phase";
    title: string;
    budget: number | null;
} | {
    type: "workflow";
    stage: "start" | "end";
    name: string;
    args: unknown;
} | {
    type: "quality";
    stage: "start" | "end";
    helper: "verify" | "judgePanel" | "completenessCheck";
} | {
    type: "control-attempt";
    helper: "retry" | "gate";
    attempt: number;
    accepted: boolean;
};
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
    concurrency?: number;
    /** Retry attempts after a recoverable agent failure. Default 0. */
    agentRetries?: number;
    tokenBudget?: number | null;
    signal?: AbortSignal;
    /** Maximum number of agents allowed in this run. Default: 1000 */
    maxAgents?: number;
    /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
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
    /**
     * Resume: cached agent/checkpoint results keyed by `${runId}:${callIndex}`
     * — the same namespacing SharedStore's deltaKey uses — so a nested
     * workflow() call's callIndex-0 (its callSeq restarts at 0) can never
     * collide with the parent's own callIndex-0 entry. A legacy entry with no
     * `runId` (persisted before namespacing existed) is looked up under the
     * run's own top-level runId only; see `JournalEntry.runId`.
     */
    resumeJournal?: Map<string, JournalEntry>;
    /** Resume: the run being resumed (informational; enables resume mode). */
    resumeFromRunId?: string;
    /** Called after each live agent completes so the caller can persist the journal. */
    onAgentJournal?: (entry: JournalEntry) => void;
    /** Active durable checkpoint response supplied by WorkflowManager.resume(). */
    resumeCheckpoint?: WorkflowCheckpoint;
    /** Persist a durable checkpoint transition before it becomes externally observable. */
    onWorkflowCheckpoint?: (checkpoint: WorkflowCheckpoint) => void;
    /**
     * Called once per failed-and-retried attempt with that attempt's finalized token cost.
     * @deprecated Use `onAgentUsage` for per-agent display and `onTokenUsage` for
     * finalized run accounting. Do not combine those cumulative callbacks with this delta.
     */
    onRetrySpend?: (tokens: number) => void;
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
    /** Internal: shared runtime inherited by a nested workflow() call. */
    sharedRuntime?: SharedRuntime;
    /**
     * Seed the FRESH SharedRuntime's cumulative spend/tokenUsage counters from a
     * previously-persisted total (resume()), instead of starting at zero. Used
     * only on the fresh-SharedRuntime branch below — never applied when
     * `sharedRuntime` is supplied (a nested workflow() call inherits the
     * parent's live, already-correct counters and must not be re-seeded).
     * Without this, a resumed run's tokenBudget cap silently resets: it would
     * enforce the ceiling against only what THIS execution spends, ignoring
     * whatever was already spent before the pause.
     */
    initialTokenUsage?: AgentUsage;
    /**
     * Shared store for this run. One instance is created per top-level run and
     * propagated into nested workflow() calls. Pass an existing instance to share
     * state across a parent and child run; omit to create a fresh isolated store.
     */
    sharedStore?: SharedStore;
    /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
    loadSavedWorkflow?: (name: string) => string | undefined;
    /**
     * Ask the human a checkpoint() question and resolve to their reply. Threaded from
     * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
     * default (and journals it), so a detached/background run never hangs.
     */
    confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
    onLog?: (message: string) => void;
    onPhase?: (title: string) => void;
    /**
     * Persisted per-phase sub-budgets from a previous execution (resume() only),
     * keyed by `${frameRunId}:${phaseTitle}` (a nested workflow()'s frame runId
     * is stable across resume — `${parentRunId}-nested${seq}`). Each frame adopts
     * only ITS slice on first re-declaration, so a phase ceiling holds
     * CUMULATIVELY across a pause/resume cycle (audit2 #4) instead of silently
     * re-granting the full allowance per resume — and frames can never
     * cross-contaminate each other's baselines.
     */
    initialPhaseBudgets?: Record<string, {
        budget: number;
        startSpent: number;
        warned?: boolean;
    }>;
    /**
     * Fired whenever this frame's phase-budget table changes, so the manager can
     * persist it. Keys are already frame-namespaced (`${frameRunId}:${title}`).
     */
    onPhaseBudgets?: (budgets: Record<string, {
        budget: number;
        startSpent: number;
        warned: boolean;
    }>) => void;
    /** Runtime behavior trace used by diagnostics and comprehension evidence. */
    onRuntimeEvent?: (event: WorkflowRuntimeEvent) => void;
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
     * across a later workflow-tool invocation.
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
    /**
     * Override timeout for this specific agent. null means no hard timeout.
     * Must be a finite number in [1, 2^31-1] — anything else (0, negatives,
     * NaN, Infinity) throws SCRIPT_VALIDATION_ERROR instead of
     * spawn-then-instantly-aborting a real session.
     */
    timeoutMs?: number | null;
    /** Retry attempts after a recoverable failure for this specific agent. */
    retries?: number;
}
/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
    /** Reply used when no UI is available (headless/background) and headless != "abort". */
    default?: unknown;
    /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
    headless?: "default" | "abort";
    /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
    kind?: "confirm" | "input" | "select";
    /** For kind "select". */
    choices?: string[];
    /** Per-checkpoint timeout in ms for the interactive prompt. */
    timeoutMs?: number;
}
export declare function runWorkflow<T = unknown>(script: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult<T>>;
export declare function parseWorkflowScript(script: string): {
    meta: WorkflowMeta;
    body: string;
};
export declare function cloneDurableJsonValue(value: unknown, label: string): unknown;
