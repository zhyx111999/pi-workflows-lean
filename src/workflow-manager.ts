/**
 * Workflow manager: owns every run's lifecycle. A run starts in the background
 * (or inline via runSync), executes through runWorkflow, and can be paused,
 * stopped, resumed, re-homed to another session, or deleted. Each execution
 * holds a cross-process lease on its run and writes the run record as it goes.
 */

import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.js";
import type { AgentUsage } from "./agent-usage.js";
import { DEFAULT_MAX_AGENTS } from "./config.js";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";
import {
  RunRecordDeletedError,
  WorkflowCheckpointSuspensionError,
  WorkflowError,
  WorkflowErrorCode,
} from "./errors.js";
import {
  abortForLifecycleControl,
  type ExternalAbort,
  ExternalAbortLink,
  type LifecycleControl,
} from "./manager/abort-control.js";
import { checkpointAlreadyConsumed, withCheckpointResponse } from "./manager/checkpoint-response.js";
import { waitForPausedExecutionSettlement } from "./manager/execution-settlement.js";
import { newManagedRun } from "./manager/new-run.js";
import { PersistThrottle } from "./manager/persist-throttle.js";
import {
  abortRecord,
  readRecordPreview,
  recoverStaleRuns,
  rehomePendingRecords,
  rehomeRecord,
  tryAcquireRunLease,
  writeAutoResumeAttempts,
} from "./manager/record-ops.js";
import { resumedRun } from "./manager/resume-state.js";
import { runEventHooks, type SteerableAgent } from "./manager/run-events.js";
import { classifyFailure, emptyFleetWarning } from "./manager/run-outcome.js";
import {
  initialRunRecord,
  runRecord,
  settleAgentsForTerminalRun,
  settleInterruptedAgents,
} from "./manager/run-record.js";
import { taskListMoves } from "./manager/task-list-reuse.js";
import { DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY, TerminalRunRetention } from "./manager/terminal-retention.js";
import {
  createRunPersistence,
  INTERRUPTED_AGENT_CAUSE,
  type PendingDeliveryMarker,
  type PersistedAgentState,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
  sanitizeAutoResumeAttempts,
  TERMINAL_RUN_STATUSES,
} from "./run-persistence.js";
import { isTaskListScript, type SubagentTask } from "./subagent-tasks.js";
import {
  cloneDurableJsonValue,
  type JournalEntry,
  runWorkflow,
  type WorkflowCheckpoint,
  type WorkflowRunResult,
} from "./workflow.js";

type AgentTimestamps = { startedAt: string; endedAt?: string };

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
  agentSessionsByCallId: Map<string, { sessionId?: string; sessionFile?: string }>;
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

export interface WorkflowResumeOptions {
  /** Edited script: journaled calls replay only within the unchanged prefix. */
  script?: string;
  /** Edited task list for a task-list run: every unchanged task replays wherever it moved. */
  tasks?: SubagentTask[];
  checkpointId?: string;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  // Run limits apply to every execution this manager starts, resumes included,
  // so raising one and resuming lets a run that hit it continue.
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
export type WorkflowManagerReloadOptions = Pick<
  WorkflowManagerOptions,
  | "concurrency"
  | "maxAgents"
  | "agentTimeoutMs"
  | "agentRetries"
  | "toolsets"
  | "excludeSubagentTools"
  | "providerMiddlewareExtensions"
  | "persistAgentSessions"
  | "inheritMainModel"
>;

export class WorkflowManager extends EventEmitter {
  /**
   * In-memory runs. Running and paused runs always stay; a finished run stays
   * until evicted (see TerminalRunRetention). A missing entry means "read the
   * record" (listRuns/findRun), and resume() always reloads from disk.
   */
  private runs = new Map<string, ManagedRun>();
  private readonly terminalRuns: TerminalRunRetention;
  private readonly persistThrottle = new PersistThrottle();
  /** Executions by managed run, so pause/resume can wait for settlement before overlapping. */
  private readonly executions = new WeakMap<ManagedRun, Promise<WorkflowRunResult>>();
  /** Runs deleted here or by another process; an execution still winding down finishes their deletion. */
  private readonly deletedRuns = new WeakSet<ManagedRun>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private agent?: Pick<WorkflowAgent, "run">;
  private mainModel?: string;
  private modelRegistry?: ModelRegistry;
  /** The current pi session id; new runs are tagged with it and listRuns() filters by it. */
  private sessionId?: string;
  /** The current host session file; new runs record it as their parent. */
  private sessionFile?: string;
  private maxAgents: number;
  private agentTimeoutMs: number | null;
  private agentRetries: number;
  private toolsets?: Record<string, () => ToolDefinition[]>;
  private excludeSubagentTools?: string[];
  private providerMiddlewareExtensions?: string[];
  private persistAgentSessions: boolean;
  private inheritMainModel: boolean;

  constructor(options: WorkflowManagerOptions = {}) {
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
    this.terminalRuns = new TerminalRunRetention(
      this.runs,
      options.maxTerminalRunsInMemory ?? DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY,
    );
    this.persistence = createRunPersistence(this.cwd);
    recoverStaleRuns(this.persistence);
  }

  /**
   * Refresh host configuration after Pi reloads the extension, keeping live
   * runs, leases, and listeners. Running executions keep the options they
   * started with; later runs and resumes use the new ones.
   */
  reconfigureAfterReload(options: WorkflowManagerReloadOptions): void {
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

  // ── Session and host binding ───────────────────────────────────────────────

  /** Bind to the current pi session (on session_start): new runs belong to it, and listRuns() shows only its runs. */
  setSessionId(id: string | undefined, sessionFile?: string): void {
    this.sessionId = id;
    this.sessionFile = sessionFile;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  /** Project cwd this manager was constructed for (persistence + agent tools). */
  getCwd(): string {
    return this.cwd;
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /** Set the host session's model registry so subagents resolve models consistently. */
  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
  }

  /**
   * After a session replacement keeps this manager, move the work that still
   * needs this conversation to `sessionId`: running and paused runs, and any
   * run with an undelivered result. Finished, delivered runs keep their
   * session so history stays where it ran; parent lineage never moves.
   * Disk-only results move only from `previousSessionId`, so a sibling session
   * sharing the runs directory cannot take another session's results.
   */
  adoptLiveRunsToSession(sessionId: string | undefined, previousSessionId?: string): number {
    if (!sessionId) return 0;
    const prev = previousSessionId !== undefined ? previousSessionId : this.sessionId;
    let adopted = 0;
    for (const managed of this.runs.values()) {
      const active = managed.status === "running" || managed.status === "paused";
      const undelivered = managed.pendingDelivery != null;
      if (!active && !undelivered) continue;
      if (managed.sessionId === sessionId) continue;
      if (this.moveRunToSession(managed, sessionId)) adopted++;
    }
    return adopted + rehomePendingRecords(this.persistence, sessionId, prev, (runId) => this.runs.has(runId));
  }

  /**
   * Re-home one in-memory run; false when it turned out to be deleted. An
   * execution holding the lease rewrites its own record. A settled copy only
   * caches a record another process may have changed since, so it moves just
   * the session field.
   */
  private moveRunToSession(managed: ManagedRun, sessionId: string): boolean {
    if (managed.lease) {
      managed.sessionId = sessionId;
      this.persistRun(managed);
      return this.isCurrent(managed);
    }
    try {
      if (!rehomeRecord(this.persistence, managed.runId, sessionId)) {
        this.dropIfDeleted(managed);
        return false;
      }
    } catch (error) {
      // Best-effort like every progress write: the local copy still moves.
      console.warn("[workflow-manager] Persist run failed:", error);
    }
    managed.sessionId = sessionId;
    return true;
  }

  // ── Starting runs ──────────────────────────────────────────────────────────

  /** Start a workflow in the background. Returns the run ID at once; `promise` settles with the run. */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const managed = this.registerNewRun(script, args, exec, true);
    try {
      this.persistence.save(initialRunRecord(managed));
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(managed.runId);
      throw err;
    }
    this.emit("started", { runId: managed.runId });
    const promise = this.execute(managed, script, args, exec);
    // The execution records its outcome itself; this catch only prevents an
    // unhandled rejection. Callers still get the original promise.
    promise.catch(() => {});
    return { runId: managed.runId, promise };
  }

  /**
   * Run a workflow and wait for its result, tracked like a background run so
   * the navigator and task panel show it. Only tests use this today.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const managed = this.registerNewRun(script, args, exec, false);
    // Write at once so listRuns() shows the run before its first agent finishes.
    this.persistRun(managed);
    return this.execute(managed, script, args, exec);
  }

  /** Create a run, take its lease, and add it to `runs`. Throws when the lease is taken. */
  private registerNewRun(script: string, args: unknown, exec: ExecOptions, background: boolean): ManagedRun {
    const managed = newManagedRun(script, args, {
      background,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
      autoResume: exec.autoResume,
      toolset: exec.toolset,
    });
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    this.runs.set(managed.runId, managed);
    return managed;
  }

  /** Start one execution of `managed` and track it, so pause/resume can wait for it to settle. */
  private execute(
    managed: ManagedRun,
    script: string,
    args: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const execution = this.executeRun(managed, script, args, exec);
    this.executions.set(managed, execution);
    return execution;
  }

  /** Execute `script` for `managed` and record the outcome on the run. Rejects with the run's error. */
  private async executeRun(
    managed: ManagedRun,
    script: string,
    args: unknown,
    exec: ExecOptions,
  ): Promise<WorkflowRunResult> {
    const { onProgress } = exec;
    // Explicit tools win; otherwise re-resolve the run's toolset name (how a
    // resumed /deep-research keeps its web tools); otherwise the default tools.
    const resolvedTools = exec.tools ?? (managed.toolset ? this.toolsets?.[managed.toolset]?.() : undefined);
    const events = runEventHooks(managed, {
      emit: (event, payload) => this.emitLive(managed, event, payload),
      progress: () => {
        if (this.isCurrent(managed)) onProgress?.(managed.snapshot);
      },
      persist: (required) => this.persistRun(managed, required),
      schedulePersist: () => this.schedulePersist(managed),
    });
    const externalAbort = exec.externalSignal ? new ExternalAbortLink(exec.externalSignal, managed) : undefined;
    try {
      externalAbort?.attach();
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        args,
        // The run's own id, so result.runId is the id listRuns() and resume() use.
        runId: managed.runId,
        agent: this.agent,
        mainModel: this.mainModel,
        modelRegistry: this.modelRegistry,
        persistAgentSessions: this.persistAgentSessions,
        inheritMainModel: this.inheritMainModel,
        parentSessionFile: managed.parentSessionFile,
        signal: managed.controller.signal,
        // Current limits, so a resume picks up limits raised since the run started.
        concurrency: this.concurrency,
        agentRetries: this.agentRetries,
        maxAgents: this.maxAgents,
        agentTimeoutMs: this.agentTimeoutMs,
        drainAbortGraceMs: exec.drainAbortGraceMs,
        tools: resolvedTools,
        excludeTools: this.excludeSubagentTools,
        providerMiddlewareExtensions: this.providerMiddlewareExtensions,
        resumeJournal: exec.resumeJournal,
        independentCalls: isTaskListScript(script),
        resumeCheckpoint: exec.resumeCheckpoint,
        initialTokenUsage: exec.initialTokenUsage,
        ...events,
      });
      return this.settleCompleted(managed, result);
    } catch (error) {
      throw this.settleFailure(managed, error);
    } finally {
      externalAbort?.detach();
      // A deleted run's script may catch the abort and keep writing its run log
      // after the files were removed. Nothing writes for it now, so delete again.
      if (this.deletedRuns.has(managed)) {
        try {
          this.persistence.delete(managed.runId);
        } catch {
          // Best-effort: a leftover log never resurrects the run.
        }
      }
    }
  }

  /** Record a returned script. A pause() that arrived during the final drain keeps the run paused. */
  private settleCompleted(managed: ManagedRun, result: WorkflowRunResult): WorkflowRunResult {
    const warning = emptyFleetWarning(managed);
    if (warning) {
      managed.snapshot.logs.push(warning);
      this.emitLive(managed, "log", { runId: managed.runId, message: warning });
      console.warn(`[workflow] ${warning.replace(/\n\s*/g, " ")}`);
    }
    managed.result = result;
    if (managed.status === "paused") {
      // The journal holds the work, so a resume replays it and completes at once.
      // Agents abandoned by the drain never report an end; settle their rows.
      settleInterruptedAgents(managed, INTERRUPTED_AGENT_CAUSE, new Date());
      this.persistRun(managed);
      if (this.isCurrent(managed)) this.releaseRunLease(managed);
      return result;
    }
    managed.status = "completed";
    this.emitLive(managed, "complete", { runId: managed.runId, result });
    this.persistRun(managed);
    if (this.isCurrent(managed)) {
      this.releaseRunLease(managed);
      this.terminalRuns.record(managed.runId);
    }
    return result;
  }

  /** Record an execution that threw. Returns the error to rethrow. */
  private settleFailure(managed: ManagedRun, error: unknown): unknown {
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
      return error;
    }

    const outcome = classifyFailure(managed, error);
    if (outcome.status) managed.status = outcome.status;
    if (outcome.usageLimitPaused) managed.usageLimitPause = outcome.error;
    managed.error = outcome.terminalError;
    if (outcome.usageLimitPaused) {
      this.emitLive(managed, "paused", {
        runId: managed.runId,
        reason: "usage_limit",
        error: outcome.error,
        resetHint: outcome.error.resetHint,
      });
    } else if (!outcome.announced && this.listenerCount("error") > 0) {
      // EventEmitter throws on an unheard "error", which would skip the final
      // write, the lease release, and the rethrow.
      this.emitLive(managed, "error", { runId: managed.runId, error: outcome.terminalError });
    }
    // The drain has finished, so agents still marked active no longer run.
    if (managed.status === "paused") {
      settleInterruptedAgents(managed, INTERRUPTED_AGENT_CAUSE, new Date());
    }
    this.persistRun(managed);
    if (this.isCurrent(managed)) {
      this.releaseRunLease(managed);
      // A paused run stays resumable, so it is never evicted.
      if (TERMINAL_RUN_STATUSES.has(managed.status)) this.terminalRuns.record(managed.runId);
    }
    return outcome.error;
  }

  /**
   * Whether `managed` is still the entry for its run id. False once resume()
   * replaced it or deleteRun() removed it: such an execution must not write the
   * record, touch the lease, or emit events for the run any more.
   */
  private isCurrent(managed: ManagedRun): boolean {
    return this.runs.get(managed.runId) === managed;
  }

  /**
   * Emit an event for an execution that is still current. A superseded one's
   * "complete" would otherwise deliver a result for a run that is gone or
   * replaced. Lifecycle commands emit directly: they are current when they fire.
   */
  private emitLive(managed: ManagedRun, event: string, payload: unknown): void {
    if (this.isCurrent(managed)) this.emit(event, payload);
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  // ── Writing the run record ─────────────────────────────────────────────────

  /**
   * Write the run now, replacing any pending throttled write, so the newest
   * state lands last. Every lifecycle change writes through here.
   */
  private persistRun(managed: ManagedRun, required = false): void {
    if (!this.isCurrent(managed)) return;
    this.persistThrottle.cancel(managed.runId);
    this.writeRunToDisk(managed, required);
  }

  /** Write the run after the throttle window (progress only). */
  private schedulePersist(managed: ManagedRun): void {
    this.persistThrottle.schedule(managed.runId, () => this.writeRunToDisk(managed));
  }

  /**
   * The single path to disk. A superseded execution writes nothing: it would
   * recreate a deleted record or overwrite the newer execution's. The check
   * repeats persistRun()'s because the throttled write arrives here directly.
   * Progress writes are best-effort; `required` writes (checkpoints) throw.
   */
  private writeRunToDisk(managed: ManagedRun, required = false): void {
    if (!this.isCurrent(managed)) return;
    try {
      const now = new Date();
      settleAgentsForTerminalRun(managed, now);
      this.persistence.save(runRecord(managed, now));
    } catch (err) {
      // Deletion by another process is authoritative: the local copy is stale.
      const deleted = err instanceof RunRecordDeletedError;
      if (deleted) this.forgetDeletedRun(managed);
      if (required) throw err;
      if (!deleted) console.warn("[workflow-manager] Persist run failed:", err);
    }
  }

  /**
   * Another process deleted this run's record. Mirror a local deleteRun(): stop
   * any live execution, drop the in-memory copy, and notify watchers, so no
   * later write can recreate the run.
   */
  private forgetDeletedRun(managed: ManagedRun): void {
    if (!this.isCurrent(managed)) return;
    if (!managed.controller.signal.aborted) managed.controller.abort();
    this.persistThrottle.cancel(managed.runId);
    this.runs.delete(managed.runId);
    this.deletedRuns.add(managed);
    this.releaseRunLease(managed);
    this.emit("deleted", { runId: managed.runId });
  }

  // ── Pause, checkpoint responses, resume, stop ─────────────────────────────

  /** Pause a running workflow. */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.status = "paused";
    abortForLifecycleControl(managed, "pause");
    this.emit("paused", { runId });
    // Write the new state now, but keep the lease until the execution settles
    // and writes its exact final usage.
    this.persistRun(managed);
    return true;
  }

  /**
   * Attach a response to a waiting checkpoint; it is on disk before this
   * resolves, so it survives a restart. While the suspended execution still
   * waits for its other agents, the response is written through the live run,
   * whose lease that execution holds; otherwise through the record under a
   * fresh lease. resume() still waits for the execution to settle, so hosts
   * attach first and resume on the "paused" event.
   */
  async attachCheckpointResponse(runId: string, checkpointId: string, responseValue: unknown): Promise<void> {
    const response = cloneDurableJsonValue(responseValue, "checkpoint response");
    const active = this.runs.get(runId);
    const settlingExecution = active ? this.executions.get(active) : undefined;
    // A .then on a settled promise runs within one microtask; on a pending one
    // it does not. That tells a still-draining execution from a settled one.
    let executionPending = false;
    if (settlingExecution) {
      let settled = false;
      void settlingExecution.then(
        () => (settled = true),
        () => (settled = true),
      );
      await Promise.resolve();
      executionPending = !settled;
    }
    if (settlingExecution && executionPending) {
      // The draining execution writes the run again after the drain and reads
      // the live checkpoint then, so the response reaches disk with it.
      if (active?.lease && this.isCurrent(active)) {
        if (!active.checkpoint) throw new Error("run has no durable checkpoint");
        const next = withCheckpointResponse(active.checkpoint, checkpointId, response);
        if (next === undefined) return;
        const previousCheckpoint = active.checkpoint;
        active.checkpoint = next;
        try {
          // Also write now, so the response survives a crash during the drain.
          this.persistRun(active, true);
        } catch (error) {
          // The caller is told the attach failed, so the live run must not keep it.
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
    if (!lease) throw new Error(`workflow run ${JSON.stringify(runId)} is busy`);
    try {
      const persisted = this.persistence.load(runId);
      if (!persisted?.checkpoint) throw new Error("run has no durable checkpoint");
      const next = withCheckpointResponse(persisted.checkpoint, checkpointId, response);
      if (next === undefined) return;
      this.persistence.save({ ...persisted, checkpoint: next });
      if (active && this.isCurrent(active)) {
        active.checkpoint = next;
      }
    } finally {
      this.persistence.releaseRunLease(lease);
    }
  }

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
  async resume(runId: string, opts?: WorkflowResumeOptions): Promise<boolean> {
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;

    // A stopped or paused run may still be draining its last agents.
    const settlingExecution = active ? this.executions.get(active) : undefined;
    if (settlingExecution) {
      if (!(await waitForPausedExecutionSettlement(settlingExecution))) return false;
      if (this.runs.get(runId) !== active) return false;
    }

    const persisted = this.persistence.load(runId);
    if (!persisted) {
      this.dropIfDeleted(active);
      return false;
    }
    if (checkpointAlreadyConsumed(persisted, opts?.checkpointId)) return true;

    // A finished run has nothing left to continue; it reruns only with an edit.
    const edited = opts?.script !== undefined || opts?.tasks !== undefined;
    if (!persisted.script || (persisted.status === "completed" && !edited)) return false;
    // Validated before the lease: nothing may throw once it is held.
    const taskMoves = opts?.tasks ? taskListMoves(runId, persisted, opts) : undefined;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    // Another process may have stopped, deleted, or advanced the run since the
    // first read. Re-read under the lease and give up on any change, rather
    // than overwrite newer journal, agent, or checkpoint data.
    let fresh: PersistedRunState | null;
    try {
      fresh = this.persistence.load(runId);
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      throw error;
    }
    if (!isDeepStrictEqual(fresh, persisted)) {
      this.persistence.releaseRunLease(lease);
      return false;
    }

    const script = opts?.script ?? persisted.script;
    const args = opts?.tasks ?? persisted.args;
    const { managed, journal, priorTokenUsage } = resumedRun({
      runId,
      persisted,
      script,
      args,
      taskMoves,
      lease,
      currentSessionId: this.sessionId,
    });
    this.runs.set(runId, managed);
    // Write before notifying: renderers read lifecycle status from the record.
    this.persistRun(managed);
    const resumeJournal = new Map(journal.map((e) => [e.index, e] as const));
    this.emit("resumed", { runId });
    // The agent count needs no seed: the script replays from call 0 and agent()
    // counts replayed calls too, so maxAgents stays a cumulative cap.
    const execution = this.execute(managed, script, args, {
      resumeJournal,
      resumeCheckpoint: persisted.checkpoint?.status === "resuming" ? persisted.checkpoint : undefined,
      initialTokenUsage: priorTokenUsage,
    });
    void execution.catch(() => {});
    return true;
  }

  /**
   * Stop a running or paused workflow. The execution holding the run's lease
   * is aborted and the run written as aborted. Like pause(), it keeps the
   * lease: the execution's last write comes after the drain, and releasing
   * now would let another process resume the run and then lose that write.
   * Any other run is stopped through its record (see stopRecord()).
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (!managed?.lease) return this.stopRecord(runId, managed);
    if (managed.status !== "running" && managed.status !== "paused") return false;
    this.markStopped(managed);
    abortForLifecycleControl(managed, "stop");
    this.emit("stopped", { runId });
    this.persistRun(managed);
    return true;
  }

  /**
   * Stop a run no execution here owns: one from an earlier session, or one
   * whose execution here has settled. Such a copy only caches the record,
   * which another process may since have resumed, finished, or deleted, so
   * the record decides; a run another live process executes cannot be leased.
   */
  private stopRecord(runId: string, cached: ManagedRun | undefined): boolean {
    // A cheap read first, so an unknown or finished run takes no lock.
    const current = this.findRun(runId)?.status;
    if (current !== "running" && current !== "paused") return false;
    if (!abortRecord(this.persistence, runId, () => this.dropIfDeleted(cached))) return false;
    // No execution will settle the cached copy, so it may be evicted now.
    if (cached && this.isCurrent(cached)) {
      this.markStopped(cached);
      this.terminalRuns.record(runId);
    }
    this.emit("stopped", { runId });
    return true;
  }

  private markStopped(managed: ManagedRun): void {
    managed.status = "aborted";
    managed.error ??= new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
      recoverable: true,
    });
  }

  /**
   * Queue an instruction into every running agent of a live run that has this
   * label. Resolves to the number of sessions that received it: 0 when the run
   * is not running here or no agent with that label is mid-session.
   */
  async steerAgent(runId: string, label: string, text: string): Promise<number> {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return 0;
    const targets = [...managed.steerable.values()].filter((agent) => agent.label === label);
    await Promise.all(targets.map((agent) => agent.steer(text)));
    return targets.length;
  }

  // ── Reading runs ───────────────────────────────────────────────────────────

  /** The live in-memory run, if this process has one. */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /** The live snapshot of an in-memory run, or null. */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Every live in-memory run, regardless of session. Cross-session recovery
   * uses this, because listRuns() hides runs that belong to another session.
   */
  listLiveRuns(): ManagedRun[] {
    return [...this.runs.values()];
  }

  /**
   * Run records for the navigator and task panel: only the bound session's
   * runs, or all of them when no session is bound.
   */
  listRuns(): PersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /**
   * One run's record, read now rather than from the list cache, in any session;
   * undefined when it does not exist. A settled local copy of a run that another
   * process deleted is dropped here, so every caller agrees the run is gone.
   */
  findRun(runId: string): PersistedRunState | undefined {
    let run: PersistedRunState | null;
    try {
      run = readRecordPreview(this.persistence, runId);
    } catch {
      // A damaged record is unreadable, not deleted; list() skips it as well.
      return undefined;
    }
    if (!run) this.dropIfDeleted(this.runs.get(runId));
    return run ?? undefined;
  }

  /**
   * Drop a settled local copy whose record another process deleted. A copy
   * still executing holds the lease, and its next write detects the deletion;
   * a record that exists but fails validation is damaged, not deleted.
   */
  private dropIfDeleted(cached: ManagedRun | undefined): void {
    if (!cached || cached.lease) return;
    try {
      if (readRecordPreview(this.persistence, cached.runId)) return;
    } catch {
      return;
    }
    this.forgetDeletedRun(cached);
  }

  getPersistence(): RunPersistence {
    return this.persistence;
  }

  // ── Deleting and record maintenance ────────────────────────────────────────

  /**
   * Delete a run and its files. A live run is aborted first so it stops
   * spending; its execution winds down on its own, and its late writes are
   * dropped because it is no longer current. Returns false when another
   * process holds the run's lease or the run does not exist. Never throws on
   * a lease probe failure.
   */
  deleteRun(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed && !managed.controller.signal.aborted) managed.controller.abort();
    // Hold a lease across the deletion; otherwise another process could take
    // the run and recreate its record with its next write. An entry that still
    // holds its execution's lease uses that one. Deleting the files removes the
    // lock too, so the release at the end is harmless.
    let heldLease: RunLease | undefined;
    if (managed?.lease) {
      heldLease = managed.lease;
      managed.lease = undefined;
    } else {
      heldLease = tryAcquireRunLease(this.persistence, runId);
      if (!heldLease) return false;
    }
    this.runs.delete(runId);
    if (managed) this.deletedRuns.add(managed);
    // A pending throttled write must not recreate the record after deletion.
    this.persistThrottle.cancel(runId);
    try {
      const deleted = this.persistence.delete(runId);
      // Watchers (e.g. /workflows watch) need the event to release their
      // listeners, even when the files were already gone.
      if (deleted || managed) this.emit("deleted", { runId });
      return deleted;
    } finally {
      this.persistence.releaseRunLease(heldLease);
    }
  }

  /**
   * Record the usage-limit scheduler's backoff counter. A run whose execution
   * holds the lease carries it into its next write; any other run's record is
   * merged under a fresh lease, skipped on contention because the owner writes
   * the record itself. Never write the field with a raw save: the next full
   * write would erase it.
   */
  recordAutoResumeAttempts(runId: string, attempts: number): void {
    // NaN or negative values would break the scheduler's give-up cap and timers.
    if (sanitizeAutoResumeAttempts(attempts) === undefined) return;
    const managed = this.runs.get(runId);
    if (managed?.lease) {
      if ((managed.autoResumeAttempts ?? 0) === attempts) return;
      managed.autoResumeAttempts = attempts;
      this.persistRun(managed);
      return;
    }
    // Without a lease the local entry is only a cache: update just this field.
    const recorded = writeAutoResumeAttempts(this.persistence, runId, attempts, () => this.dropIfDeleted(managed));
    if (recorded && managed) managed.autoResumeAttempts = attempts;
  }
}
