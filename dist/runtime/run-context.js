/** Holds one run's mutable state and the shared services that every workflow global uses. */
import { WorkflowError, WorkflowErrorCode, workflowAbortedError, } from "../errors.js";
import { CallSequence } from "./call-position.js";
import { createLimiter } from "./run-limits.js";
import { createScriptCalls } from "./script-calls.js";
export function createRuntimeState(meta, options, concurrency) {
    // The first declared phase is the default, so agents started before any
    // phase() call group under it instead of an orphan "(no phase)" bucket.
    const firstPhase = meta.phases?.[0]?.title;
    return {
        logs: [],
        phases: firstPhase ? [firstPhase] : [],
        currentPhase: firstPhase,
        scriptCalls: CallSequence.forScript(),
        journalMissed: false,
        limiter: createLimiter(concurrency),
        // Not seeded on resume: the script replays from call 0 and every replayed
        // call counts again, so maxAgents stays a cumulative cap on its own.
        agentCount: 0,
        // Seeded on resume because replayed calls deliberately commit no usage.
        tokenUsage: options.initialTokenUsage
            ? { ...options.initialTokenUsage }
            : { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
        agentCallbacksClosed: false,
        pendingUsageFinalizers: new Set(),
        activeCheckpointId: options.resumeCheckpoint?.checkpointId ?? null,
        activeCheckpointResponse: options.resumeCheckpoint ?? null,
        seenCheckpointIds: new Set(),
        runFatalController: new AbortController(),
        calls: createScriptCalls(),
        activeThreads: new Set(),
        resumeBarrierReached: false,
    };
}
export function createRunContext(setup) {
    const { options, state, logger, maxAgents, runId } = setup;
    const log = (message) => {
        const text = String(message);
        state.logs.push(text);
        logger.log(text);
    };
    // Both abort sources go through this one check, so no call site can forget the run-fatal seal.
    const isAborted = () => Boolean(options.signal?.aborted || state.runFatalController.signal.aborted);
    const throwIfAborted = () => {
        if (!options.signal?.aborted && state.checkpointSuspension)
            throw state.checkpointSuspension;
        if (isAborted())
            throw workflowAbortedError();
    };
    const agentLimitError = () => new WorkflowError(`Agent limit exceeded (${state.agentCount}/${maxAgents}). Raise defaultMaxAgents in the workflow settings, reload, then resume run "${runId}" — the journaled prefix replays free.`, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED, { recoverable: false });
    const ensureAgentCapacity = () => {
        if (state.agentCount >= maxAgents)
            throw agentLimitError();
    };
    return { ...setup, log, isAborted, throwIfAborted, agentLimitError, ensureAgentCapacity };
}
