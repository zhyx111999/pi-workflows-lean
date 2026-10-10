import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";
import type { TSchema } from "typebox";
import { type AgentRunOptions, WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { type AgentRegistry, agentDefinitionKey, loadAgentRegistry, resolveAgentType } from "./agent-registry.js";
import { type AgentUsage, createAgentCallUsageTracker, sumAgentUsage } from "./agent-usage.js";
import { DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_MAX_AGENTS, MAX_AGENT_RETRIES, MAX_CONCURRENCY } from "./config.js";
import { WorkflowCheckpointSuspensionError, WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { validateThinkingLevel } from "./model-spec.js";
import { assertDeterministicSource, DETERMINISM_PRELUDE } from "./runtime/determinism.js";
import { readMetaExport } from "./runtime/script-meta.js";
import { createAgentStoreTools, SharedStore } from "./shared-store.js";
import {
  AGENT_OPTIONS,
  WORKFLOW_CAPABILITY_CONTRACT,
  type WorkflowRuntimeImplementations,
} from "./workflow-capability-contract.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

/**
 * Batch-scoped cancellation for a single parallel()/pipeline() fan-out. When a
 * fan-out's agent() calls reserve past maxAgents, the breaching call throws and
 * the whole fan-out rejects — but agents already reserved and queued behind the
 * limiter would otherwise keep draining and spending. parallel()/pipeline()
 * establish a fresh store per call via fanoutScope.run(); agent() captures the
 * nearest enclosing store synchronously (before suspending on the limiter) so a
 * still-queued agent can bail once ITS OWN fan-out breaches, without touching
 * sibling fan-outs running concurrently or an enclosing fan-out when this one is
 * nested inside it (each nesting level gets its own store via ALS scoping).
 *
 * Scope note: cancellation is bounded PER breaching fan-out, not run-global — a
 * deliberate tradeoff. Deep-sixing the earlier run-global flag was required
 * because it wrongly cancelled an innocent, independently-caught sibling batch.
 * The consequence: if one fan-out breaches while an unrelated in-cap sibling or
 * a nested inner fan-out is mid-flight, that other batch is NOT cancelled and
 * finishes its already-reserved agents (still capped at maxAgents total). Only
 * the breaching fan-out's own queue is short-circuited.
 */
const fanoutScope = new AsyncLocalStorage<{ cancelled: boolean }>();

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
  onAgentSession?: (event: { callId: string; sessionId: string; sessionFile?: string }) => void;
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
  onAgentHistory?: (event: { id: string; label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  /**
   * Called when a live agent's session can take instructions, with `steer`
   * queueing one into it. Returns the function that unregisters the session
   * when it ends. `id` is the same per-call id as the onAgent* events.
   */
  registerAgentSteer?: (agent: { id: string; label: string; steer: (text: string) => Promise<void> }) => () => void;
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
  onAgentModel?: (event: { id: string; label: string; phase?: string; model: string }) => void;
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

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Logical agent()/checkpoint() slots reserved so far; capped by maxAgents. */
  agentCount: number;
  tokenUsage: AgentUsage;
  /** Set after the terminal drain seals abandoned agent callbacks. */
  agentCallbacksClosed: boolean;
  /** Active attempts whose usage must be finalized when an abort drain abandons them. */
  pendingUsageFinalizers: Set<() => void>;
  /** Exact durable checkpoint currently waiting or resuming. */
  activeCheckpointId: string | null;
  /** Persisted response currently being consumed by exactly one checkpoint. */
  activeCheckpointResponse: WorkflowCheckpoint | null;
  /** Every durable checkpoint ID encountered in this run; IDs must be unique. */
  seenCheckpointIds: Set<string>;
  /** A durably accepted suspension cannot be swallowed into a successful run. */
  checkpointSuspension?: WorkflowCheckpointSuspensionError;
  /**
   * Aborted once an error escapes the script uncaught (see runWorkflow's
   * catch), i.e. the run's fate is sealed. Not on the first fan-out rejection:
   * that would break parallel()'s null-on-recoverable-error contract and a
   * script's own try/catch around agent(). Every agent attempt links its
   * AbortController to this signal, alongside the caller's options.signal, so
   * in-flight sibling sessions abort instead of finishing a doomed run. An
   * AbortController (not a boolean) because workflow.ts never gets write access
   * to the caller-owned options.signal.
   */
  runFatalController: AbortController;
  /**
   * Every agent() promise spawned in this run, added on call and removed on
   * settle. Drained by runWorkflow's finally before the SharedStore is
   * disposed, so a script that forgets to `await agent(...)` can never mutate
   * the store or report results after the run is torn down.
   */
  inFlight: Set<Promise<unknown>>;
  /** Named conversations currently executing. */
  activeThreads: Set<string>;
  /** Whether a threaded call has invalidated journal replay for the rest of the run. */
  resumeBarrierReached: boolean;
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
  // An embedding host's invalid timeout must not fail the run (or spawn and
  // instantly abort sessions); coerce to the default and log instead.
  let agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  if (
    agentTimeoutMs !== null &&
    (typeof agentTimeoutMs !== "number" ||
      !Number.isFinite(agentTimeoutMs) ||
      agentTimeoutMs < 1 ||
      agentTimeoutMs > 2_147_483_647)
  ) {
    options.onLog?.(
      `ignoring invalid agentTimeoutMs (${String(options.agentTimeoutMs)}); using the configured default instead`,
    );
    agentTimeoutMs = DEFAULT_AGENT_TIMEOUT_MS;
  }
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });

  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  // options.initialTokenUsage (resume() only) seeds tokenUsage so the run's
  // reported totals stay cumulative across a pause/resume cycle.
  //
  // agentCount is NOT seeded, unlike tokenUsage — and doesn't need to be:
  // resume() always replays the whole script from callIndex 0, and agent()'s
  // `state.agentCount++` fires unconditionally for every call (cache-hit
  // replay or live) before the replay-vs-live branch runs. That replay alone
  // reconstructs the cumulative count by the time any new live agent
  // executes, so maxAgents stays a genuine cumulative cap across resume.
  // Token usage needs seeding precisely because its cache-hit branch
  // deliberately does NOT recommit usage (to avoid double-counting).
  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
    limiter: createLimiter(concurrency),
    agentCount: 0,
    tokenUsage: options.initialTokenUsage
      ? { ...options.initialTokenUsage }
      : { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    agentCallbacksClosed: false,
    pendingUsageFinalizers: new Set<() => void>(),
    activeCheckpointId: options.resumeCheckpoint?.checkpointId ?? null,
    activeCheckpointResponse: options.resumeCheckpoint ?? null,
    seenCheckpointIds: new Set<string>(),
    runFatalController: new AbortController(),
    inFlight: new Set<Promise<unknown>>(),
    activeThreads: new Set<string>(),
    resumeBarrierReached: false,
  };

  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const store = new SharedStore();

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    options.onPhase?.(title);
  };

  const agentLimitError = () =>
    new WorkflowError(
      `Agent limit exceeded (${state.agentCount}/${maxAgents}). Raise defaultMaxAgents in the workflow settings, reload, then resume run "${runId}" — the journaled prefix replays free.`,
      WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
      { recoverable: false },
    );

  /** Every logical agent() call and checkpoint consumes one slot of the run's maxAgents cap. */
  const ensureAgentCapacity = () => {
    if (state.agentCount >= maxAgents) throw agentLimitError();
  };

  // True on an intentional external abort (pause/stop/Esc, via options.signal)
  // OR once this run's fate has been sealed (state.runFatalController — see
  // its doc comment). Every abort check in this file goes through this so the
  // two sources compose identically everywhere instead of only some call
  // sites remembering to check the second one.
  const isAborted = () => Boolean(options.signal?.aborted || state.runFatalController.signal.aborted);

  const throwIfAborted = () => {
    if (!options.signal?.aborted && state.checkpointSuspension) throw state.checkpointSuspension;
    if (isAborted()) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  /** Validate the call synchronously, then start it; a validation failure throws. */
  const startAgentCall = (prompt: string, agentOptions: unknown): Promise<unknown> => {
    validateAgentOptions(agentOptions);
    const rawThread = agentOptions.thread;
    const thread = rawThread === undefined ? undefined : typeof rawThread === "string" ? rawThread.trim() : "";
    if (rawThread !== undefined && !thread) {
      throw new WorkflowError("agent() thread must be a non-empty string", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    if (!thread) return agentImpl(prompt, agentOptions);
    if (state.activeThreads.has(thread)) {
      throw new WorkflowError(
        `agent thread "${thread}" is already running; same-thread calls must be sequential`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    state.activeThreads.add(thread);
    return agentImpl(prompt, thread === rawThread ? agentOptions : { ...agentOptions, thread }).finally(() =>
      state.activeThreads.delete(thread),
    );
  };

  const agent = (prompt: string, agentOptions: unknown = {}): Promise<unknown> => {
    let call: Promise<unknown>;
    try {
      call = startAgentCall(prompt, agentOptions);
    } catch (error) {
      call = Promise.reject(error);
    }
    // Track every call (awaited or not) so the top-level run can drain
    // outstanding calls before completing (see RuntimeState.inFlight and the
    // drain in the finally below) — this is what stops a forgotten `await`
    // from letting an agent mutate state after the run is torn down.
    state.inFlight.add(call);
    // Attaching a handler here (independent of whatever the script itself does
    // with the returned promise) also means an un-awaited call's eventual
    // rejection never becomes a process-crashing unhandled rejection.
    call.catch(() => {}).finally(() => state.inFlight.delete(call));
    return call;
  };

  const agentImpl = async (prompt: string, agentOptions: AgentOptions = {}) => {
    throwIfAborted();
    validateThinkingLevel(agentOptions.thinking);

    // Resolve the definition and validate cwd before reserving a logical agent
    // slot. Invalid local configuration must not perturb the run's capacity or
    // scheduling state.
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    const resolvedIsolation =
      agentOptions.isolation === false ? undefined : (agentOptions.isolation ?? agentDef?.isolation);
    const requestedCwd = resolveAgentCwd(agentOptions.cwd);
    if (requestedCwd && resolvedIsolation === "worktree") {
      throw new WorkflowError(
        "agent cwd cannot be combined with worktree isolation",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }

    // Capture the enclosing parallel()/pipeline() fan-out's cancellation batch
    // (if any) synchronously, while the ALS context of the caller is still
    // active — i.e. before suspending on the limiter below. The limiter body
    // closes over this so a still-queued agent can bail once its OWN fan-out
    // breaches the cap, without affecting sibling or outer fan-outs.
    const batch = fanoutScope.getStore();

    // Check agent limit. A fan-out that overshoots the cap has already reserved
    // and queued up to `maxAgents` agents; the breaching call throws here, and
    // parallel()/pipeline() mark their own batch cancelled so the already-queued
    // agents short-circuit before their real API call (see the limiter body).
    ensureAgentCapacity();

    const assignedPhase = agentOptions.phase ?? state.currentPhase;

    const requestedLabel = agentOptions.label?.trim();

    if (agentOptions.thread && resolvedIsolation === "worktree") {
      throw new WorkflowError(
        `agent thread "${agentOptions.thread}" cannot use worktree isolation`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    if (agentOptions.agentType && !agentDef) {
      log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }

    // Model precedence: explicit agentOptions.model > agentType.model > tier > phase model.
    // The "explicit-level" model is opts.model, else the definition's model — either
    // beats tier/phase. When only a tier is set, pass undefined here so the tier (not
    // the phase model) decides inside WorkflowAgent.run().
    const explicitModel = agentOptions.model ?? agentDef?.model;
    const modelSpec =
      explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
    // For display in /workflows: a PRE-RESOLUTION guess — this agent's explicit/phase
    // spec, else the session's main model. It is only a guess: a `tier` deliberately
    // leaves modelSpec undefined so the agent layer picks, and an untagged agent is
    // implicitly routed through the "medium" tier when model-tiers.json exists, or
    // inherits the main model when the inheritMainModel setting is on. The real
    // resolved id replaces it via onModelResolved below, which also pushes the
    // correction out on onAgentModel so a RUNNING agent's row stops showing the
    // guess. When the implicit route degrades to the settings default, no spec
    // resolves, so nothing in this resolution path fires a correction (the
    // degrade itself is still logged via onModelFallback).
    let displayModel = modelSpec ?? options.mainModel;

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    const callIndex = state.callSeq++;
    const callHash = hashAgentCall(
      prompt,
      modelSpec,
      assignedPhase,
      agentOptions,
      agentDefinitionKey(agentDef),
      requestedCwd,
      resolvedIsolation,
    );
    const deltaKey = agentCallId(runId, callIndex);

    // Reserve the agent slot synchronously (no await between this and the
    // capacity check) so a parallel() fan-out can't all observe the same
    // agentCount and overshoot maxAgents. callIndex/agentCount stay lexical
    // for replay-key stability, so resume replays count identically.
    state.agentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal. Independent calls have no
    // downstream, so each replays on its own match.
    if (agentOptions.thread) state.resumeBarrierReached = true;
    const cached = agentOptions.thread ? undefined : options.resumeJournal?.get(callIndex);
    const hashMatches = cached != null && cached.hash === callHash;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    const withinReplay = options.independentCalls || callIndex < state.firstMiss;
    if (!state.resumeBarrierReached && hashMatches && !cachedEmptyOutput && withinReplay) {
      // Replay preserves the journaled model and historical session identity.
      const replayModel = cached.model ?? displayModel;
      options.onAgentStart?.({
        id: deltaKey,
        label,
        phase: assignedPhase,
        prompt,
        model: replayModel,
        replayed: true,
      });
      options.onAgentEnd?.({
        id: deltaKey,
        label,
        phase: assignedPhase,
        result: cached.result,
        tokens: 0,
        model: replayModel,
      });
      // Apply this agent's write delta so live agents later in the run see a
      // consistent store. Additive apply preserves parallel-agent writes that
      // came from higher-callIndex agents finishing before this one.
      if (cached.storeDelta) store.applyDelta(cached.storeDelta);
      return cached.result;
    }
    // A genuine miss (no journal entry, or the hash changed) marks where the
    // unchanged prefix ends; this call and every later one then run live.
    if (!hashMatches || cachedEmptyOutput) {
      state.firstMiss = Math.min(state.firstMiss, callIndex);
    }

    return state.limiter(async () => {
      // A queued call can obtain its slot after the top-level abort drain has
      // already abandoned it. Do not create a worktree or announce a new agent
      // for an execution whose callbacks have been closed.
      if (state.agentCallbacksClosed) {
        throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
      }
      const retryAttempts = normalizeAgentRetries(options.agentRetries ?? 0);
      const maxAttempts = retryAttempts + 1;

      // Requested isolation is mandatory for this call; retained trees belong
      // to their original execution, not a later retry/resume.
      // Precedence: isolation: false opts out; else call-site isolation > agentDef isolation.
      let worktree: Worktree | undefined;
      if (resolvedIsolation === "worktree") {
        worktree = await createWorktree(baseCwd, `${runId}-${callIndex}-${label}`);
        if (!worktree.isolated) {
          throw new WorkflowError(
            `worktree isolation failed for "${label}": ${worktree.reason}`,
            WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
            { recoverable: false },
          );
        }
      }
      const runCwd = requestedCwd ?? (worktree?.isolated ? worktree.cwd : undefined);

      // The tracker keeps provisional estimates separate from committed usage,
      // accumulates retries, and rejects callbacks from attempts that already settled.
      const usageTracker = createAgentCallUsageTracker((update) => {
        if (state.agentCallbacksClosed) return;
        if (update.committedUsage) {
          state.tokenUsage = sumAgentUsage(state.tokenUsage, update.committedUsage);
        }
        options.onAgentUsage?.({ id: deltaKey, label, phase: assignedPhase, ...update });
      });

      try {
        // Worktree creation above is asynchronous; abandonment may have
        // occurred while it was pending, before this first observer event.
        if (state.agentCallbacksClosed) {
          throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
        }
        options.onAgentStart?.({ id: deltaKey, label, phase: assignedPhase, prompt, model: displayModel });
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const attemptUsage = usageTracker.startAttempt();
          const finalizeAttemptUsage = () => attemptUsage.commitTerminalUsage();
          state.pendingUsageFinalizers.add(finalizeAttemptUsage);
          const externalSignal = options.signal;
          let onExternalAbort: (() => void) | undefined;
          let onRunFatal: (() => void) | undefined;
          let runPromise: Promise<unknown> | undefined;
          try {
            throwIfAborted();
            // This agent's own fan-out already breached maxAgents while this
            // call sat queued behind the limiter; bail before spending on the
            // real API call instead of draining the whole reserved queue.
            if (batch?.cancelled) throw agentLimitError();

            // Per-attempt abort: on timeout we abort THIS agent so its session is
            // disposed and its heavy state (messages, etc.) released, instead of
            // leaving it streaming in the background — retries would otherwise
            // stack live sessions on top of each other (#109). Linked to BOTH the
            // run's external signal (outer abort — pause/stop/Esc) AND
            // state.runFatalController (this run's fate has been sealed by a
            // sibling's non-recoverable error escaping the top-level script — see
            // RuntimeState.runFatalController) so an in-flight sibling actually
            // winds down instead of running to completion on a doomed run. Both
            // links are torn down per attempt in finally so listeners don't accrue.
            const agentController = new AbortController();
            if (isAborted()) {
              agentController.abort();
            } else {
              if (externalSignal) {
                onExternalAbort = () => agentController.abort();
                externalSignal.addEventListener("abort", onExternalAbort, { once: true });
              }
              onRunFatal = () => agentController.abort();
              state.runFatalController.signal.addEventListener("abort", onRunFatal, { once: true });
            }
            runPromise = agentRunner.run(prompt, {
              label,
              // Identifiable name for persisted sessions (persistAgentSessions).
              sessionName: agentOptions.thread
                ? `workflow:${runId} thread:${agentOptions.thread}`
                : `workflow:${runId} ${label}`,
              schema: agentOptions.schema,
              signal: agentController.signal,
              // The agentType body is the user's own role prompt; the plugin adds
              // no phase, isolation, or role text of its own.
              instructions: agentDef?.prompt || undefined,
              model: modelSpec,
              thinking: agentOptions.thinking ?? agentDef?.thinking,
              tier: agentOptions.tier,
              modelSource: agentOptions.model
                ? "explicit"
                : agentDef?.model
                  ? "explicit"
                  : agentOptions.tier
                    ? "tier"
                    : modelSpec
                      ? "phase"
                      : undefined,
              modelRegistry: options.modelRegistry,
              toolNames: agentDef?.tools,
              disallowedToolNames: agentDef?.disallowedTools,
              // Per-agent store tools attribute this agent's writes to its call
              // id so the delta can be journaled and replayed on resume.
              systemTools: createAgentStoreTools(store, deltaKey),
              cwd: runCwd,
              onModelResolved: (id: string) => {
                if (state.agentCallbacksClosed) return;
                displayModel = id;
                // Correct what /workflows shows for an agent that is STILL RUNNING.
                // onAgentEnd keeps carrying the same value so late subscribers and
                // the persisted snapshot stay consistent with this push.
                options.onAgentModel?.({ id: deltaKey, label, phase: assignedPhase, model: id });
              },
              onModelFallback: ({
                tier,
                requestedSpec,
                source,
              }: {
                tier: string;
                requestedSpec: string;
                source: "medium-tier" | "inherit-main";
              }) => {
                if (state.agentCallbacksClosed) return;
                // An untagged agent's implicit route degrading to the session
                // default must stay visible in the run's own log/event stream,
                // not just a console.warn (#131) — an explicit model/tier pin
                // instead throws MODEL_NOT_FOUND and never reaches this
                // callback. Name the route honestly: with inheritMainModel on
                // the unavailable spec is the inherited main model, not a tier.
                log(
                  source === "inherit-main"
                    ? `inherited main model "${requestedSpec}" unavailable — using the session default`
                    : `default "${tier}" tier model "${requestedSpec}" unavailable — using the session default`,
                );
              },
              onUsageProgress: attemptUsage.reportProgress,
              onUsage: attemptUsage.reportTerminal,
              onSessionCreated: ({ sessionId, sessionFile }: { sessionId: string; sessionFile?: string }) => {
                if (state.agentCallbacksClosed) return;
                options.onAgentSession?.({ callId: deltaKey, sessionId, sessionFile });
              },
              onHistory: (history: AgentHistoryEntry[]) => {
                if (state.agentCallbacksClosed) return;
                options.onAgentHistory?.({ id: deltaKey, label, phase: assignedPhase, history });
              },
              registerSteer: (steer: (text: string) => Promise<void>) => {
                // An abandoned execution must not hand a late session to the host.
                const unregister = state.agentCallbacksClosed
                  ? undefined
                  : options.registerAgentSteer?.({ id: deltaKey, label, steer });
                return unregister ?? (() => {});
              },
              thread: agentOptions.thread,
            });
            // Attach a rejection handler immediately: a timed-out run can reject
            // before the timeout catch awaits its teardown for usage reconciliation.
            void runPromise.catch(() => undefined);
            const result = await withTimeout(runPromise, agentTimeoutMs, label, () => agentController.abort());

            // Abort-only check, deliberately NOT throwIfAborted(): the result is
            // paid for at this point, so a pending durable checkpoint suspension
            // must not discard it un-journaled (audit2 #2 — the suspension
            // re-checks at the next script-level gate and at the top level).
            if (isAborted()) {
              throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
            }
            if (isEmptyTextAgentResult(result, agentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }

            const usageCommit = attemptUsage.commitWithFallback(() => estimateTokens(result) + estimateTokens(prompt));
            if (!agentOptions.thread) {
              options.onAgentJournal?.({
                index: callIndex,
                hash: callHash,
                result,
                // displayModel is post-resolution here; recording it keeps a
                // resumed run's replayed rows from regressing to mainModel.
                // Deliberately NOT part of callHash (see hashAgentCall): the
                // cache key stays spec-level, so no cached agent is invalidated.
                model: displayModel,
                storeDelta: store.commitDelta(deltaKey),
              });
            } else {
              store.commitDelta(deltaKey);
            }
            options.onAgentEnd?.({
              id: deltaKey,
              label,
              phase: assignedPhase,
              result,
              tokens: usageCommit.tokens,
              tokenUsage: usageCommit.tokenUsage,
              worktree: worktree?.isolated ? worktree.cwd : undefined,
              model: displayModel,
            });
            return result;
          } catch (error) {
            // A named thread cannot start its next turn while an aborted wrapper
            // is still unwinding against the shared SessionManager. Wait for the
            // wrapper to restore its prior leaf before retrying or returning.
            if (agentOptions.thread && runPromise) await runPromise.catch(() => {});
            if (isAborted()) {
              attemptUsage.commitTerminalUsage();
              throw error;
            }

            const workflowError = wrapError(error, { agentLabel: label });
            if (workflowError.code === WorkflowErrorCode.AGENT_TIMEOUT && runPromise) {
              await runPromise.catch(() => undefined);
            }
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            const usageCommit = attemptUsage.commitWithFallback(() => estimateTokens(prompt));
            // This attempt's store writes must not survive it — a failed
            // attempt shares this call's deltaKey with every other attempt
            // (retried or not), so without rolling back here its writes would
            // stay live in the store (visible to concurrently-running sibling
            // agents) and merge into whatever a later, successful attempt
            // commits — corrupting both the live run's state and the delta
            // that resume replay reconstructs from. Unconditional: this
            // covers the about-to-retry case AND the exhausted/non-recoverable
            // case, since neither leaves behind a call that "produced" a
            // result this attempt's writes should be attributed to.
            store.discardDelta(deltaKey);

            if (workflowError.recoverable && attempt < maxAttempts) {
              log(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              // Small capped backoff between attempts (audit2 #7) — an
              // immediate retry storms the provider when a parallel() batch
              // fails together. The abort check after the wait keeps pause/stop
              // responsive (bounded by the 2s cap).
              const defaultBackoffMs = Math.min(250 * 2 ** (attempt - 1), 2_000);
              let backoffMs = defaultBackoffMs;
              if (options.agentRetryBackoffMs) {
                try {
                  const injected = options.agentRetryBackoffMs(attempt);
                  // 0 disables (documented); negative/NaN/Infinity fall back to
                  // the default — a non-finite value clamped to 2^31-1 would
                  // otherwise park the retry for ~24.8 days.
                  backoffMs =
                    injected === 0
                      ? 0
                      : typeof injected === "number" && Number.isFinite(injected) && injected > 0
                        ? Math.min(injected, 2_000) // capped: setTimeout overflows >2^31-1, and a
                        : // multi-day park would ignore aborts for its whole duration
                          defaultBackoffMs;
                } catch {
                  backoffMs = defaultBackoffMs; // a throwing callback must not abandon the retry
                }
              }
              if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
              throwIfAborted();
              continue;
            }

            options.onAgentEnd?.({
              id: deltaKey,
              label,
              phase: assignedPhase,
              result: null,
              tokens: usageCommit.tokens,
              tokenUsage: usageCommit.tokenUsage,
              worktree: worktree?.isolated ? worktree.cwd : undefined,
              model: displayModel,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
            });

            if (workflowError.recoverable) {
              log(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              return null;
            }
            throw workflowError;
          } finally {
            state.pendingUsageFinalizers.delete(finalizeAttemptUsage);
            // Drop this attempt's abort listeners so they don't accrue one entry
            // per attempt on the run's signal / runFatalController for the whole
            // run (#109 hygiene).
            if (onExternalAbort) externalSignal?.removeEventListener("abort", onExternalAbort);
            if (onRunFatal) state.runFatalController.signal.removeEventListener("abort", onRunFatal);
          }
        }
        return null;
      } finally {
        if (worktree?.isolated) {
          if (agentOptions.keepWorktree === false) {
            await removeWorktree(worktree);
          } else {
            log(`worktree kept: ${worktree.cwd}${worktree.branch ? ` (${worktree.branch})` : ""}`);
          }
        }
      }
    });
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    // Batch-scoped cancellation: agent() calls made (directly or transitively)
    // from these thunks see this store via fanoutScope.getStore(). A breach in
    // THIS fan-out flips `cancelled` so its own still-queued agents bail, without
    // touching a sibling fan-out running concurrently or an enclosing one.
    const batch = { cancelled: false };
    return fanoutScope.run(batch, () =>
      Promise.all(
        thunks.map(async (thunk, index) => {
          try {
            return await thunk();
          } catch (error) {
            if (error instanceof WorkflowCheckpointSuspensionError) throw error;
            if (isAborted()) throw error;
            const workflowError = wrapError(error);
            // Non-recoverable failures (e.g. agent limit exhausted) must halt
            // the whole run, exactly like a directly-awaited agent() — not be
            // swallowed into a null in the result array.
            if (!workflowError.recoverable) {
              // Only a breached agent cap cancels the rest of this batch; other
              // non-recoverable errors don't imply the rest of the batch is doomed.
              if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) batch.cancelled = true;
              throw workflowError;
            }
            log(`parallel[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }),
      ),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    // Batch-scoped cancellation — see parallel() for the rationale.
    const batch = { cancelled: false };
    return fanoutScope.run(batch, () =>
      Promise.all(
        items.map(async (item, index) => {
          let value: unknown = item;
          for (const stage of stages) {
            try {
              throwIfAborted();
              value = await stage(value, item, index);
              throwIfAborted();
            } catch (error) {
              if (error instanceof WorkflowCheckpointSuspensionError) throw error;
              if (isAborted()) throw error;
              const workflowError = wrapError(error);
              // Non-recoverable failures halt the whole run (see parallel()).
              if (!workflowError.recoverable) {
                if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) batch.cancelled = true;
                throw workflowError;
              }
              log(`pipeline[${index}] failed: ${workflowError.message}`);
              return null;
            }
          }
          return value;
        }),
      ),
    );
  };

  // Deterministic, journaled checkpoint: suspends the workflow until
  // WorkflowManager persists and supplies a response for this exact ID.
  const checkpoint = async (input: WorkflowCheckpointInput) => {
    throwIfAborted();
    if (!isWorkflowCheckpointInput(input)) {
      throw new TypeError("checkpoint() needs exactly { kind, checkpointId, payload } with valid string identifiers");
    }
    ensureAgentCapacity();

    const callIndex = state.callSeq++;
    const durableInput: WorkflowCheckpointInput = {
      ...input,
      payload: cloneDurableJsonValue(input.payload, "checkpoint payload"),
    };
    if (state.seenCheckpointIds.has(durableInput.checkpointId)) {
      throw new WorkflowError(
        `durable checkpoint ID ${JSON.stringify(durableInput.checkpointId)} must be unique within the run`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    state.seenCheckpointIds.add(durableInput.checkpointId);
    const activeResumeCheckpoint = state.activeCheckpointResponse;
    const callHash = hashWorkflowCheckpoint(durableInput);
    const cached = options.resumeJournal?.get(callIndex);
    const replayingActiveCheckpoint = activeResumeCheckpoint?.checkpointId === durableInput.checkpointId;
    if (
      !state.resumeBarrierReached &&
      cached != null &&
      cached.hash === callHash &&
      callIndex < state.firstMiss &&
      !replayingActiveCheckpoint
    ) {
      state.agentCount++;
      return cached.result;
    }
    if (cached == null || cached.hash !== callHash) {
      state.firstMiss = Math.min(state.firstMiss, callIndex);
    }
    state.agentCount++;

    if (activeResumeCheckpoint) {
      if (state.activeCheckpointId !== durableInput.checkpointId) {
        throw new WorkflowError(
          `durable checkpoint ${JSON.stringify(durableInput.checkpointId)} does not own the active reservation`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
    } else if (state.activeCheckpointId !== null) {
      throw new WorkflowError(
        `durable checkpoint ${JSON.stringify(state.activeCheckpointId)} is already active`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    } else {
      state.activeCheckpointId = durableInput.checkpointId;
    }
    if (activeResumeCheckpoint) {
      const active = activeResumeCheckpoint;
      if (
        active.version !== 1 ||
        active.status !== "resuming" ||
        active.checkpointId !== durableInput.checkpointId ||
        active.kind !== durableInput.kind ||
        !isDeepStrictEqual(active.payload, durableInput.payload) ||
        !Object.hasOwn(active, "response")
      ) {
        throw new WorkflowError(
          `durable checkpoint ${JSON.stringify(durableInput.checkpointId)} does not match the persisted response`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
      options.onAgentJournal?.({ index: callIndex, hash: callHash, result: active.response });
      const consumed: WorkflowCheckpoint = {
        ...active,
        status: "consumed",
        consumedAt: new Date().toISOString(),
      };
      options.onWorkflowCheckpoint?.(consumed);
      state.activeCheckpointResponse = null;
      state.activeCheckpointId = null;
      return active.response;
    }

    const waiting: WorkflowCheckpoint = {
      version: 1,
      ...durableInput,
      status: "waiting",
      createdAt: new Date().toISOString(),
    };
    options.onWorkflowCheckpoint?.(waiting);
    state.checkpointSuspension = new WorkflowCheckpointSuspensionError(waiting.checkpointId);
    throw state.checkpointSuspension;
  };

  const runtimeImplementations = {
    agent,
    parallel,
    pipeline,
    checkpoint,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
  } satisfies WorkflowRuntimeImplementations;
  const { globals: projectGlobals, diagnostics: bindingDiagnostics } =
    WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(runtimeImplementations);
  for (const diagnostic of bindingDiagnostics) logger.warn(diagnostic.message);
  const context = vm.createContext({
    ...projectGlobals,
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  let runSucceeded = false;
  // The returned object is captured so the finally can refresh its tokenUsage
  // AFTER the drain — agents settling during the drain commit usage last, and
  // the result payload must reflect the true final total (audit2 #5).
  let successResult: WorkflowRunResult<T> | undefined;
  try {
    const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
    // Even a script-level catch must not convert an accepted durable pause to
    // completion. External cancellation retains priority over suspension.
    if (state.checkpointSuspension) throwIfAborted();

    // Persist logs
    const logFile = logger.persist();
    if (logFile) {
      log(`Logs persisted to ${logFile}`);
    }

    runSucceeded = true;
    successResult = {
      meta,
      result: result as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: state.agentCount,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: state.tokenUsage,
    };
    return successResult;
  } catch (error) {
    // This error escaped the script completely uncaught: nothing in the call
    // chain (this script, any enclosing try/catch around parallel()/agent())
    // caught it, so the run's fate is genuinely sealed now (see
    // RuntimeState.runFatalController). Sealing it here, not inside
    // agent()/parallel(), is what preserves parallel()'s "a thrown thunk
    // resolves to null without failing the others" contract and a script's
    // own try/catch around agent(): both those cases are swallowed well before
    // an error would ever reach this catch. Idempotent: if this is already an
    // intentional pause/stop (options.signal aborted) or a second escape after
    // the fatal signal already fired, aborting an already-aborted controller
    // is a no-op.
    //
    // This also fires on a PROVIDER_USAGE_LIMIT escape (a quota/rate-limit
    // hit), not just a genuine bug — that error is non-recoverable too (see
    // errors.ts), so it escapes exactly like any other run-fatal error and
    // seals the same way. Deliberate tradeoff: any sibling still in flight
    // when the quota was hit gets aborted rather than allowed to finish and
    // journal — this stops burning an already-exhausted quota right now, at
    // the cost of that sibling's work being thrown away and re-run live when
    // the paused run resumes (it was never journaled, so it isn't cached).
    // A durable checkpoint suspension is an intentional pause, not a fatal
    // error: do NOT seal the run for it. Sealing would abort every in-flight
    // sibling mid-call — their paid work is discarded un-journaled and re-run
    // (double-paid) on resume. The finally drain below waits them out so their
    // results journal for free before the suspension propagates.
    const isCheckpointSuspension = state.checkpointSuspension !== undefined && error === state.checkpointSuspension;
    if (!isCheckpointSuspension) {
      // Notify the host before the cooperative drain below. A pause/stop can be
      // requested while siblings settle, but it must not erase a provider-limit
      // error that had already escaped this top-level workflow.
      try {
        const observation = options.onRunFatal?.(error);
        // The hook is observational, but consumers can still accidentally
        // return a rejecting thenable. Explicitly consume it so it cannot turn
        // a workflow's own failure into an unhandled rejection.
        if (observation != null && typeof (observation as { then?: unknown }).then === "function") {
          void Promise.resolve(observation).catch(() => {});
        }
      } catch {
        // Instrumentation must never mask the workflow's own terminal error.
      }
      state.runFatalController.abort();
    }
    throw error;
  } finally {
    // Wait out every agent() call spawned anywhere in this run — including
    // ones the script never awaited — before the store goes away. Without
    // this, a forgotten `await agent(...)` could keep mutating store/journal
    // state after the run is marked complete/failed and torn down. Loop
    // (not a single Promise.allSettled) because draining can itself let a
    // still-running call schedule further work that adds to the set.
    //
    // Caveat: without an abort the SUCCESS drain still blocks indefinitely —
    // those results are wanted, including paid siblings at a checkpoint.
    // Once the run's abort has fired the wait is bounded by
    // drainAbortGraceMs (default 10s): a run-fatal abort (see the catch
    // above) aborts the AbortSignal passed to each in-flight agent, but that
    // is cooperative — an agent runner that ignores its signal (or one still
    // waiting out a real subagent process that won't die) never settles on
    // its own. Combined with agentTimeoutMs: null (no hard timeout, the
    // default), a single hung, signal-ignoring, un-awaited agent() call would
    // otherwise wedge this drain — and therefore the whole run's completion —
    // forever (audit2 #3).
    if (state.inFlight.size > 0) {
      log(`waiting for ${state.inFlight.size} outstanding agent() call(s) to settle before this run completes`);
    }
    const graceOption = options.drainAbortGraceMs;
    const drainAbortGraceMs =
      graceOption === undefined
        ? 10_000
        : graceOption === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : typeof graceOption === "number" && graceOption >= 1 && graceOption <= 2_147_483_647
            ? Math.floor(graceOption)
            : 10_000; // NaN/0/negative/overflow → default
    // Wakes the drain loop the moment the run aborts (either source), so a
    // drain that started un-aborted re-enters promptly and the grace clock
    // starts instead of blocking on allSettled forever.
    let wakeAbort: () => void = () => {};
    const abortWake = new Promise<void>((resolve) => {
      wakeAbort = resolve;
    });
    const externalWake = () => wakeAbort();
    const fatalWake = () => wakeAbort();
    options.signal?.addEventListener("abort", externalWake, { once: true });
    state.runFatalController.signal.addEventListener("abort", fatalWake, { once: true });
    try {
      while (state.inFlight.size > 0) {
        const pending = Array.from(state.inFlight);
        if (!isAborted() || drainAbortGraceMs === Number.POSITIVE_INFINITY) {
          // Not aborted: wait, but wake promptly if the abort fires
          // mid-wait. Already-aborted with an unbounded grace: plain wait —
          // racing the (already-resolved) abortWake here would busy-spin
          // the microtask queue and starve the event loop (r1 B1).
          if (isAborted()) {
            await Promise.allSettled(pending);
          } else {
            await Promise.race([Promise.allSettled(pending), abortWake]);
          }
          continue;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<"timeout">((resolve) => {
          // Deliberately ref'd (no unref): this timer is load-bearing for
          // the run's terminal transition — an unref'd one would let the
          // process exit before the run settles when nothing else holds the
          // loop open.
          timer = setTimeout(() => resolve("timeout"), drainAbortGraceMs);
        });
        const winner = await Promise.race([Promise.allSettled(pending).then(() => "settled" as const), grace]);
        if (timer) clearTimeout(timer);
        if (winner === "timeout") {
          // Leave the calls behind. No rejection-swallowing needed here:
          // every inFlight promise already carries a noop catch from its
          // creation site (:712), so a late rejection is handled. The store
          // disposes below; no journal can follow (the completion path's
          // abort check precedes journaling); manager persists are
          // staleness-gated.
          log(
            `abandoning ${pending.length} outstanding agent() call(s) that did not settle within ${drainAbortGraceMs}ms of the drain's abort grace`,
          );
          break;
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", externalWake);
      state.runFatalController.signal.removeEventListener("abort", fatalWake);
    }
    // A bounded abort drain can intentionally leave a signal-ignoring runner
    // in flight. Reconcile the latest terminal/provisional usage while the
    // manager is still live, then seal every callback retained by that runner.
    for (const finalizeUsage of state.pendingUsageFinalizers) {
      try {
        finalizeUsage();
      } catch {
        // A finalizer is best-effort; one broken callback cannot leave later
        // attempts open or prevent the terminal drain from completing.
      }
    }
    state.pendingUsageFinalizers.clear();
    state.agentCallbacksClosed = true;
    // Final token-usage flush, deliberately AFTER the drain: agents that
    // settle during the drain commit their usage last, and a pre-drain flush
    // would silently drop them from the run's final accounting (audit2 #5).
    // Success path only — error/abort accounting is owned by the catch
    // paths (e.g. the provisional-usage rollback), and firing here would
    // clobber their deliberately-empty records.
    if (runSucceeded) {
      // Refresh the result payload to the post-drain totals too — it was
      // captured before the drain (audit2 #5's result-payload half).
      if (successResult) successResult.tokenUsage = { ...state.tokenUsage };
      try {
        options.onTokenUsage?.(state.tokenUsage);
      } catch {
        // Instrumentation must never break teardown (dispose below) or mask
        // the run's own outcome.
      }
    }
    store.dispose();
  }
}

/**
 * Identity of one agent() call: its store delta key, the id carried by every
 * onAgent* event, and its persisted agent row's callId. Prefixed with the run
 * id so it stays unique when hosts aggregate agents across runs.
 */
export function agentCallId(runId: string, callIndex: number): string {
  return `${runId}:${callIndex}`;
}

/** Split a script into its validated literal `meta` and the body that runs in the vm. */
export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  assertDeterministicSource(script);
  const { meta, start, end } = readMetaExport(script);
  return { meta, body: script.slice(0, start) + script.slice(end) };
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function isWorkflowCheckpointInput(value: unknown): value is WorkflowCheckpointInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).length === 3 &&
    Object.hasOwn(input, "payload") &&
    typeof input.checkpointId === "string" &&
    /^[A-Za-z0-9._:-]{1,200}$/u.test(input.checkpointId) &&
    typeof input.kind === "string" &&
    /^[A-Za-z0-9._:-]{1,200}$/u.test(input.kind)
  );
}

export function cloneDurableJsonValue(value: unknown, label: string): unknown {
  const active = new WeakSet<object>();
  const invalid = (cause?: unknown): never => {
    throw new TypeError(`${label} must be a lossless JSON value`, cause === undefined ? undefined : { cause });
  };
  const clone = (item: unknown, depth: number): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : invalid();
    if (typeof item !== "object" || depth > 100) return invalid();
    if (active.has(item)) return invalid();
    active.add(item);
    try {
      if (Array.isArray(item)) {
        const ownKeys = Reflect.ownKeys(item);
        if (
          ownKeys.some(
            (key) =>
              typeof key !== "string" ||
              (key !== "length" && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)),
          )
        ) {
          return invalid();
        }
        const arrayCopy: unknown[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
          arrayCopy.push(clone(descriptor.value, depth + 1));
        }
        return arrayCopy;
      }

      const prototype = Object.getPrototypeOf(item);
      const objectConstructor =
        prototype === null ? Object : Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      if (prototype !== null && (typeof objectConstructor !== "function" || objectConstructor.name !== "Object")) {
        return invalid();
      }
      const copy: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== "string") return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
        Object.defineProperty(copy, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: clone(descriptor.value, depth + 1),
        });
      }
      return copy;
    } catch (error) {
      return invalid(error);
    } finally {
      active.delete(item);
    }
  };
  return clone(value, 0);
}

function hashWorkflowCheckpoint(input: WorkflowCheckpointInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
  cwd: string | undefined,
  resolvedIsolation?: "worktree",
): string {
  const identity = JSON.stringify({
    prompt,
    model: model ?? null,
    tier: options.tier ?? null,
    ...(options.thinking ? { thinking: options.thinking } : {}),
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    ...(options.thread ? { thread: options.thread } : {}),
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
    // Omit the field entirely when cwd was not supplied so journals generated by
    // older releases retain their exact hash and resume behavior.
    ...(cwd === undefined ? {} : { cwd }),
    ...(options.isolation !== undefined ? { isolation: options.isolation } : {}),
    ...(resolvedIsolation === "worktree" ? { keepWorktree: options.keepWorktree !== false } : {}),
  });
  return createHash("sha256").update(identity).digest("hex");
}

const AGENT_OPTION_NAMES: readonly string[] = AGENT_OPTIONS.options.map((option) => option.name);

/**
 * Reject agent() options the runtime would otherwise drop, so a misspelled or
 * unsupported key fails before dispatch instead of seeming to take effect.
 */
function validateAgentOptions(options: unknown): asserts options is AgentOptions {
  const accepted = `accepted options: ${AGENT_OPTION_NAMES.join(", ")}`;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new WorkflowError(
      `agent() options must be an object; ${accepted}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  const unknown = Object.keys(options).filter((key) => !AGENT_OPTION_NAMES.includes(key));
  if (unknown.length > 0) {
    throw new WorkflowError(
      `agent() does not accept ${unknown.map((key) => `"${key}"`).join(", ")}; ${accepted}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
}

/** Validate a script-supplied agent cwd without allocating an agent slot. */
function resolveAgentCwd(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkflowError(
      "agent cwd must be a non-empty absolute directory",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  const cwd = value;
  if (!isAbsolute(cwd)) {
    throw new WorkflowError("agent cwd must be an absolute directory", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  try {
    const resolved = realpathSync(cwd);
    if (!statSync(resolved).isDirectory()) {
      throw new Error("not a directory");
    }
    return resolved;
  } catch {
    throw new WorkflowError(
      `agent cwd must be an existing directory: ${cwd}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

/**
 * Run a promise with a timeout.
 *
 * `onTimeout` fires when the deadline hits, BEFORE the timeout rejection wins the
 * race — the caller uses it to abort the underlying work (e.g. the subagent
 * session) so it can release its resources instead of streaming on in the
 * background with the whole session graph (messages, etc.) retained (#109). The
 * losing promise still settles later; the caller must await its teardown before
 * committing usage or starting a retry.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Best-effort cleanup; never let it mask the timeout error.
      }
      reject(
        new WorkflowError(
          `Agent "${label}" timed out after ${ms}ms; raise defaultAgentTimeoutMs in the workflow settings to allow longer runs`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
