// Decides how a finished execution is reported: failure cause, final status, empty-result warning.
import { emptyFleetSummary } from "../display.js";
import { isProviderUsageLimit, WorkflowCheckpointSuspensionError, WorkflowError, WorkflowErrorCode, } from "../errors.js";
function abortedError() {
    return new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
}
/** The escaped error as a WorkflowError. A checkpoint suspension during an abort is just the abort. */
function asWorkflowError(error, aborted) {
    if (error instanceof WorkflowCheckpointSuspensionError && aborted)
        return abortedError();
    if (error instanceof WorkflowError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    return new WorkflowError(message, WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
}
/**
 * Classify an error that escaped runWorkflow. Several causes can race: a
 * provider limit, the host's abort, a user pause()/stop(), a real failure.
 * Each abort carries the reason object of whoever caused it, so the first
 * cause decides; a later one never relabels it.
 */
export function classifyFailure(managed, error) {
    const signal = managed.controller.signal;
    const workflowError = asWorkflowError(error, signal.aborted);
    const usageLimitPaused = isProviderUsageLimit(workflowError) &&
        (managed.usageLimitEscapedBeforeLifecycleControl === workflowError ||
            (!signal.aborted && managed.lifecycleControl === undefined));
    const lifecycleControlOwnsExecution = managed.lifecycleControl !== undefined && signal.reason === managed.lifecycleControl.abortReason;
    const externalAbortOwnsExecution = managed.externalAbort !== undefined && signal.reason === managed.externalAbort.abortReason;
    // pause()/stop() already reported its own AbortError, and a provider result
    // that arrives after it must not revive a stop or arm quota auto-resume.
    const announced = lifecycleControlOwnsExecution &&
        (workflowError.code === WorkflowErrorCode.WORKFLOW_ABORTED ||
            (isProviderUsageLimit(workflowError) && !usageLimitPaused));
    const terminalError = externalAbortOwnsExecution ? abortedError() : workflowError;
    let status;
    if (usageLimitPaused) {
        // A limit that escaped before a later pause()/stop() stays a quota pause.
        status = "paused";
    }
    else if (externalAbortOwnsExecution) {
        // The host abort came first; a late agent result cannot turn it into a failure.
        status = "aborted";
    }
    else if (announced) {
        status = undefined;
    }
    else if (signal.aborted && workflowError.code === WorkflowErrorCode.WORKFLOW_ABORTED) {
        status = "aborted";
    }
    else {
        // A real failure wins even when a pause()/stop() arrived after it escaped.
        status = "failed";
    }
    return { error: workflowError, terminalError, status, usageLimitPaused, announced };
}
/**
 * A warning when every agent of this execution returned nothing. agent()
 * resolves an exhausted recoverable failure (e.g. an empty response) to null,
 * so such a run still completes; without the warning it looks successful.
 * Rows seeded from the record at resume are history and do not count.
 */
export function emptyFleetWarning(managed) {
    const fleet = emptyFleetSummary(managed.snapshot.agents.filter((agent) => agent.id > (managed.seededAgentCount ?? 0) ||
        (agent.callId !== undefined && managed.replayedAgentCalls.has(agent.callId))));
    if (!fleet.allEmpty)
        return undefined;
    const labels = fleet.emptyLabels.join(", ");
    const overflow = fleet.emptyCount > fleet.emptyLabels.length ? ` (+${fleet.emptyCount - fleet.emptyLabels.length} more)` : "";
    return [
        `⚠  Workflow produced no usable results: all ${fleet.emptyCount} agent(s) returned nothing (${labels}${overflow}).`,
        `   agent() resolves recoverable failures (e.g. an empty model response) to null once retries are exhausted, so the run reports "completed" even though nothing was produced.`,
        `   Common fixes: set defaultAgentRetries to 1-2 in the workflow settings for models that occasionally return empty, check the model's max output tokens, and read the per-agent errors above.`,
    ].join("\n");
}
