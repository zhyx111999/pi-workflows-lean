/**
 * Runs one workflow script: the entry point of the workflow runtime.
 *
 * runWorkflow() parses the script's literal `meta`, prepares the run (limits,
 * agent registry, logger, shared store), exposes the workflow globals in a vm
 * context, runs the script, and finally drains every outstanding agent() call.
 * The parts live in src/runtime/:
 *   - script-meta.ts, determinism.ts        parse-time checks and the in-realm guard
 *   - run-limits.ts                         host settings turned into enforced limits
 *   - run-context.ts                        per-run state and the helpers shared by the globals
 *   - agent-call.ts                         agent(): validation, slot, journal replay
 *   - agent-execution.ts, agent-attempt.ts  live runs: worktree, retries, timeout, usage
 *   - fanout.ts, checkpoint.ts              parallel()/pipeline() and checkpoint()
 *   - script-vm.ts                          the vm context and script execution
 *   - run-teardown.ts                       fatal seal, drain, final accounting
 */

import type { TSchema } from "typebox";
import { type AgentRunOptions, WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { type AgentRegistry, loadAgentRegistry } from "./agent-registry.js";
import type { AgentUsage } from "./agent-usage.js";
import { DEFAULT_MAX_AGENTS } from "./config.js";
import type { WorkflowErrorCode } from "./errors.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta } from "./model-routing.js";
import type { ModelThinkingLevel } from "./model-spec.js";
import { createAgent } from "./runtime/agent-call.js";
import { createCheckpoint } from "./runtime/checkpoint.js";
import { assertDeterministicSource } from "./runtime/determinism.js";
import { createParallel, createPipeline } from "./runtime/fanout.js";
import { createRunContext, createRuntimeState } from "./runtime/run-context.js";
import { resolveAgentTimeoutMs, resolveConcurrency } from "./runtime/run-limits.js";
import { finishRun, sealRunFatal } from "./runtime/run-teardown.js";
import { readMetaExport } from "./runtime/script-meta.js";
import { createScriptContext, runScript } from "./runtime/script-vm.js";
import { SharedStore } from "./shared-store.js";
import type { WorkflowRuntimeImplementations } from "./workflow-capability-contract.js";

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
   * Keys this agent set in the shared store. Resume applies the deltas in call
   * order, which rebuilds every agent's writes no matter which parallel agent
   * finished first. Absent on older journal entries.
   */
  storeDelta?: Record<string, unknown>;
  /**
   * The model this call actually ran on, so a replayed row shows what really
   * ran instead of the pre-resolution guess. Absent on checkpoints, which run
   * no model, and on older journal entries.
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
   * `~/.pi/agent/agents` (user). Injectable for tests.
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
   * Grace period (ms) for the final drain once the run is aborted (external
   * abort or a fatal error). Agents are signaled at abort, but the signal is
   * cooperative: a runner that ignores it would otherwise keep the run from
   * ever ending. After the grace the drain stops waiting; the store is
   * disposed, nothing more is journaled, and the host ignores stale writes.
   *
   * Until the run is aborted the drain waits without limit, also when it
   * paused at a checkpoint, because those results are wanted. Default 10_000;
   * Infinity always waits. Finite values in [1, 2^31-1] are rounded down;
   * anything else (NaN, 0, negatives, overflow) uses the default.
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
   * The agent's real model, pushed as soon as WorkflowAgent resolves it, long
   * before onAgentEnd. onAgentStart can only carry a guess (this call's
   * explicit/phase spec, else the session's main model), which is wrong for
   * tier-routed agents and for untagged agents that are routed through the
   * "medium" tier or inherit the main model (see resolveAgentModelSpec). When
   * that implicit route degrades to the settings default no spec resolves, so
   * this does not fire. Fires once per attempt (and per turn of a named
   * thread): treat it as idempotent. `id` is the per-call id of the other
   * onAgent* events.
   */
  onAgentModel?: (event: { id: string; label: string; phase?: string; model: string }) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** True when the totals include character-heuristic estimates. */
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
    /** True when the totals include character-heuristic estimates. */
    estimated?: boolean;
  };
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
   * Takes precedence over the agentType model, `tier` and the phase route; with
   * none of them set, the agent layer picks its default model.
   */
  model?: string;
  /** Pi thinking level. Used when `model` has no `:thinking` suffix. */
  thinking?: ModelThinkingLevel;
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

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);

  // 1. Prepare the run.
  // Per-phase models from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  const maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
  const agentTimeoutMs = resolveAgentTimeoutMs(options);
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  // Read once per run so agent() calls never see a mid-run edit; a resume reads it again.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);
  const logger = createWorkflowLogger({
    runId,
    cwd: baseCwd,
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });
  const ctx = createRunContext({
    options,
    runId,
    baseCwd,
    maxAgents,
    agentTimeoutMs,
    routingConfig,
    agentRegistry,
    logger,
    state: createRuntimeState(meta, options, resolveConcurrency(options.concurrency)),
    agentRunner: options.agent ?? new WorkflowAgent(options),
    store: new SharedStore(),
  });
  const { state, log } = ctx;

  // 2. Expose the workflow globals declared by the capability contract.
  const phase = (title: string) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    options.onPhase?.(title);
  };
  const context = createScriptContext(
    {
      agent: createAgent(ctx),
      parallel: createParallel(ctx),
      pipeline: createPipeline(ctx),
      checkpoint: createCheckpoint(ctx),
      log,
      phase,
      args: options.args,
      cwd: baseCwd,
      process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
      console: {
        log,
        info: log,
        warn: (m: unknown) => log(`[warn] ${String(m)}`),
        error: (m: unknown) => log(`[error] ${String(m)}`),
      },
    } satisfies WorkflowRuntimeImplementations,
    logger,
  );

  // 3. Run the script, then always drain its outstanding agent() calls.
  let successResult: WorkflowRunResult<T> | undefined;
  try {
    const result = await runScript(context, body, `${meta.name || "workflow"}.js`);
    // A script that caught its checkpoint suspension still pauses instead of
    // completing; an external abort keeps priority over the suspension.
    if (state.checkpointSuspension) ctx.throwIfAborted();

    const logFile = logger.persist();
    if (logFile) log(`Logs persisted to ${logFile}`);

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
    // A checkpoint suspension is an intentional pause, not a failure: in-flight
    // siblings are waited out so their paid results journal instead of being
    // aborted and paid for again on resume.
    const isCheckpointSuspension = state.checkpointSuspension !== undefined && error === state.checkpointSuspension;
    if (!isCheckpointSuspension) sealRunFatal(ctx, error);
    throw error;
  } finally {
    await finishRun(ctx, successResult);
  }
}

/** Split a script into its validated literal `meta` and the body that runs in the vm. */
export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  assertDeterministicSource(script);
  const { meta, start, end } = readMetaExport(script);
  return { meta, body: script.slice(0, start) + script.slice(end) };
}
