/** Rebuilds a display snapshot from a persisted run record so finished and other-session runs can be browsed. */
import { asText } from "./as-text.js";
export function persistedToSnapshot(p) {
    // Corrupt arrays must not crash the overlay. Resumable runs keep each full
    // result only in the journal, not also in agents[], so done agents are
    // rehydrated by call identity; the positional index is the fallback for
    // records written before callId existed.
    const agents = (Array.isArray(p.agents) ? p.agents : []).filter((agent) => agent && typeof agent === "object");
    const journalByIndex = new Map();
    const journalByCallId = new Map();
    for (const entry of Array.isArray(p.journal) ? p.journal : []) {
        if (entry && typeof entry === "object" && typeof entry.index === "number") {
            journalByIndex.set(entry.index, entry.result);
            // Records from releases that could nest saved workflows tag child-frame
            // entries with the child's runId; honour it so those rows still rehydrate.
            const frameRunId = entry.runId;
            journalByCallId.set(`${typeof frameRunId === "string" ? frameRunId : p.runId}:${entry.index}`, entry.result);
        }
    }
    const snapshotAgents = agents.map((a, callIndex) => {
        const journalResult = a.callId ? journalByCallId.get(a.callId) : journalByIndex.get(callIndex);
        const result = a.result === undefined && a.status === "done" ? journalResult : a.result;
        return {
            id: a.id,
            callId: a.callId,
            label: a.label,
            phase: a.phase,
            prompt: a.prompt,
            status: a.status,
            result,
            // A string result is its own preview; anything else is stringified once
            // here, and the model caches this snapshot per record.
            resultPreview: result === undefined ? a.resultPreview : String(typeof result === "string" ? result : JSON.stringify(result)),
            error: a.error,
            errorCode: a.errorCode,
            recoverable: a.recoverable,
            history: a.history,
            tokens: a.tokens,
            tokenUsage: a.tokenUsage,
            model: a.model,
            sessionId: a.sessionId,
            sessionFile: a.sessionFile,
            priorExecutions: a.priorExecutions,
        };
    });
    return {
        name: asText(p.workflowName),
        phases: Array.isArray(p.phases) ? p.phases : [],
        currentPhase: p.currentPhase,
        logs: Array.isArray(p.logs) ? p.logs : [],
        agents: snapshotAgents,
        agentCount: snapshotAgents.length,
        runningCount: snapshotAgents.filter((a) => a.status === "running").length,
        doneCount: snapshotAgents.filter((a) => a.status === "done").length,
        errorCount: snapshotAgents.filter((a) => a.status === "error").length,
        tokenUsage: p.tokenUsage ? { ...p.tokenUsage } : undefined,
        runId: p.runId,
    };
}
