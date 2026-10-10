// Runs one execution of a managed run through the workflow runtime and records how it ended.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentUsage } from "../agent-usage.js";
import type { WorkflowSnapshot } from "../display.js";
import { WorkflowCheckpointSuspensionError } from "../errors.js";
import { INTERRUPTED_AGENT_CAUSE, TERMINAL_RUN_STATUSES } from "../run-persistence.js";
import { isTaskListScript } from "../subagent-tasks.js";
import {
  type JournalEntry,
  runWorkflow,
  type WorkflowCheckpoint,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "../workflow.js";
import type { ManagedRun } from "../workflow-manager.js";
import { ExternalAbortLink } from "./abort-control.js";
import type { LiveRuns } from "./live-runs.js";
import { runEventHooks } from "./run-events.js";
import { classifyFailure, emptyFleetWarning } from "./run-outcome.js";
import { settleInterruptedAgents } from "./run-record.js";

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
  runtime: Pick<
    WorkflowRunOptions,
    | "cwd"
    | "agent"
    | "mainModel"
    | "modelRegistry"
    | "persistAgentSessions"
    | "inheritMainModel"
    | "concurrency"
    | "agentRetries"
    | "maxAgents"
    | "agentTimeoutMs"
    | "excludeTools"
    | "providerMiddlewareExtensions"
  >;
  toolsets?: Record<string, () => ToolDefinition[]>;
}

/** Execute `script` for `managed` and record the outcome on the run. Rejects with the run's error. */
export async function executeRun(
  live: LiveRuns,
  managed: ManagedRun,
  script: string,
  args: unknown,
  exec: ExecOptions,
  settings: ExecutionSettings,
): Promise<WorkflowRunResult> {
  const { onProgress } = exec;
  // Explicit tools win; otherwise re-resolve the run's toolset name (how a
  // resumed /deep-research keeps its web tools); otherwise the default tools.
  const resolvedTools = exec.tools ?? (managed.toolset ? settings.toolsets?.[managed.toolset]?.() : undefined);
  const events = runEventHooks(managed, {
    emit: (event, payload) => live.emit(managed, event, payload),
    progress: () => {
      if (live.isCurrent(managed)) onProgress?.(managed.snapshot);
    },
    persist: (required) => live.persistRun(managed, required),
    schedulePersist: () => live.schedulePersist(managed),
  });
  const externalAbort = exec.externalSignal ? new ExternalAbortLink(exec.externalSignal, managed) : undefined;
  try {
    externalAbort?.attach();
    const result = await runWorkflow(script, {
      ...settings.runtime,
      args,
      // The run's own id, so result.runId is the id listRuns() and resume() use.
      runId: managed.runId,
      parentSessionFile: managed.parentSessionFile,
      signal: managed.controller.signal,
      drainAbortGraceMs: exec.drainAbortGraceMs,
      tools: resolvedTools,
      resumeJournal: exec.resumeJournal,
      independentCalls: isTaskListScript(script),
      resumeCheckpoint: exec.resumeCheckpoint,
      initialTokenUsage: exec.initialTokenUsage,
      ...events,
    });
    return settleCompleted(live, managed, result);
  } catch (error) {
    throw settleFailure(live, managed, error);
  } finally {
    externalAbort?.detach();
    live.deleteLeftovers(managed);
  }
}

/** Record a returned script. A pause() that arrived during the final drain keeps the run paused. */
function settleCompleted(live: LiveRuns, managed: ManagedRun, result: WorkflowRunResult): WorkflowRunResult {
  const warning = emptyFleetWarning(managed);
  if (warning) {
    managed.snapshot.logs.push(warning);
    live.emit(managed, "log", { runId: managed.runId, message: warning });
    console.warn(`[workflow] ${warning.replace(/\n\s*/g, " ")}`);
  }
  managed.result = result;
  if (managed.status === "paused") {
    // The journal holds the work, so a resume replays it and completes at once.
    // Agents abandoned by the drain never report an end; settle their rows.
    settleInterruptedAgents(managed, INTERRUPTED_AGENT_CAUSE, new Date());
    live.persistRun(managed);
    if (live.isCurrent(managed)) live.releaseLease(managed);
    return result;
  }
  managed.status = "completed";
  live.emit(managed, "complete", { runId: managed.runId, result });
  live.persistRun(managed);
  if (live.isCurrent(managed)) {
    live.releaseLease(managed);
    live.recordTerminalRun(managed.runId);
  }
  return result;
}

/** Record an execution that threw. Returns the error to rethrow. */
function settleFailure(live: LiveRuns, managed: ManagedRun, error: unknown): unknown {
  if (error instanceof WorkflowCheckpointSuspensionError && !managed.controller.signal.aborted) {
    managed.status = "paused";
    managed.error = undefined;
    live.persistRun(managed);
    if (live.isCurrent(managed)) {
      live.releaseLease(managed);
      live.emit(managed, "paused", {
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
    live.emit(managed, "paused", {
      runId: managed.runId,
      reason: "usage_limit",
      error: outcome.error,
      resetHint: outcome.error.resetHint,
    });
  } else if (!outcome.announced && live.hasListeners("error")) {
    // EventEmitter throws on an unheard "error", which would skip the final
    // write, the lease release, and the rethrow.
    live.emit(managed, "error", { runId: managed.runId, error: outcome.terminalError });
  }
  // The drain has finished, so agents still marked active no longer run.
  if (managed.status === "paused") {
    settleInterruptedAgents(managed, INTERRUPTED_AGENT_CAUSE, new Date());
  }
  live.persistRun(managed);
  if (live.isCurrent(managed)) {
    live.releaseLease(managed);
    // A paused run stays resumable, so it is never evicted.
    if (TERMINAL_RUN_STATUSES.has(managed.status)) live.recordTerminalRun(managed.runId);
  }
  return outcome.error;
}
