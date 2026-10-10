// Runs one execution of a managed run through the workflow runtime and records how it ended.
import { WorkflowCheckpointSuspensionError } from "../errors.js";
import { INTERRUPTED_AGENT_CAUSE, TERMINAL_RUN_STATUSES } from "../run-persistence.js";
import { isTaskListScript } from "../subagent-tasks.js";
import { runWorkflow, } from "../workflow.js";
import { ExternalAbortLink } from "./abort-control.js";
import { runEventHooks } from "./run-events.js";
import { classifyFailure, emptyFleetWarning } from "./run-outcome.js";
import { settleInterruptedAgents } from "./run-record.js";
/** Execute `script` for `managed` and record the outcome on the run. Rejects with the run's error. */
export async function executeRun(live, managed, script, args, exec, settings) {
    const { onProgress } = exec;
    // Explicit tools win; otherwise re-resolve the run's toolset name (how a
    // resumed /deep-research keeps its web tools); otherwise the default tools.
    const resolvedTools = exec.tools ?? (managed.toolset ? settings.toolsets?.[managed.toolset]?.() : undefined);
    const events = runEventHooks(managed, {
        emit: (event, payload) => live.emit(managed, event, payload),
        progress: () => {
            if (live.isCurrent(managed))
                onProgress?.(managed.snapshot);
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
    }
    catch (error) {
        throw settleFailure(live, managed, error);
    }
    finally {
        externalAbort?.detach();
        live.deleteLeftovers(managed);
    }
}
/** Record a returned script. A pause() that arrived during the final drain keeps the run paused. */
function settleCompleted(live, managed, result) {
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
        if (live.isCurrent(managed))
            live.releaseLease(managed);
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
function settleFailure(live, managed, error) {
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
    if (outcome.status)
        managed.status = outcome.status;
    if (outcome.usageLimitPaused)
        managed.usageLimitPause = outcome.error;
    managed.error = outcome.terminalError;
    if (outcome.usageLimitPaused) {
        live.emit(managed, "paused", {
            runId: managed.runId,
            reason: "usage_limit",
            error: outcome.error,
            resetHint: outcome.error.resetHint,
        });
    }
    else if (!outcome.announced && live.hasListeners("error")) {
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
        if (TERMINAL_RUN_STATUSES.has(managed.status))
            live.recordTerminalRun(managed.runId);
    }
    return outcome.error;
}
