// Lease-guarded edits to run records that no execution in this process owns.
import { WorkflowErrorCode } from "../errors.js";
import { INTERRUPTED_AGENT_CAUSE, settleInterruptedPersistedAgents, settleNonTerminalPersistedAgents, } from "../run-persistence.js";
import { runSummary } from "../run-record-store.js";
/** A run's record from the cheap preview read when the store has one. */
export function readRecordPreview(persistence, runId) {
    return persistence.loadPreview ? persistence.loadPreview(runId) : persistence.load(runId);
}
/** A lease for `runId`, or undefined when it is held elsewhere or the probe fails. */
export function tryAcquireRunLease(persistence, runId) {
    try {
        return persistence.acquireRunLease(runId) ?? undefined;
    }
    catch {
        return undefined;
    }
}
/** Point a record at another delivery session, leaving the rest as written. False when it is gone. */
export function rehomeRecord(persistence, runId, sessionId) {
    if (persistence.updateMetadata)
        return persistence.updateMetadata(runId, { sessionId });
    const state = persistence.load(runId);
    if (!state)
        return false;
    persistence.save({ ...state, sessionId });
    return true;
}
/**
 * Move undelivered results of `previousSessionId` that are only on disk to
 * `sessionId`. Never claims another session's results or ones without a
 * session. Best-effort: returns how many moved before any failure.
 */
export function rehomePendingRecords(persistence, sessionId, previousSessionId, inMemory) {
    let moved = 0;
    try {
        for (const state of persistence.list()) {
            if (!state.pendingDelivery)
                continue;
            if (inMemory(state.runId))
                continue;
            if (state.sessionId === sessionId)
                continue;
            if (previousSessionId == null || state.sessionId !== previousSessionId)
                continue;
            if (rehomeRecord(persistence, state.runId, sessionId))
                moved++;
        }
    }
    catch {
        // Best-effort: the in-memory runs are the ones that matter most.
    }
    return moved;
}
/**
 * At startup, a record still marked running belongs to a process that died
 * mid-run. Pause it, never fail it, so its journal survives and resume() can
 * replay the finished calls. The same applies to a paused record with agents
 * still marked active.
 */
export function recoverStaleRuns(persistence) {
    try {
        for (const p of persistence.list()) {
            const staleRunning = p.status === "running";
            const pausedWithInterruptedAgents = p.status === "paused" && runSummary(p).active > 0;
            if (!staleRunning && !pausedWithInterruptedAgents)
                continue;
            const lease = persistence.acquireRunLease(p.runId);
            if (!lease)
                continue;
            try {
                if (persistence.recoverInterrupted) {
                    persistence.recoverInterrupted(p.runId);
                    continue;
                }
                const fresh = persistence.load(p.runId);
                if (!fresh || (fresh.status !== "running" && fresh.status !== "paused"))
                    continue;
                const endedAt = new Date().toISOString();
                persistence.save({
                    ...fresh,
                    status: "paused",
                    updatedAt: endedAt,
                    agents: settleInterruptedPersistedAgents(fresh.agents, INTERRUPTED_AGENT_CAUSE, endedAt),
                });
            }
            finally {
                persistence.releaseRunLease(lease);
            }
        }
    }
    catch {
        // Recovery is best-effort; it must never block manager construction.
    }
}
/**
 * Mark a running or paused record aborted under a fresh lease. False when the
 * lease is held elsewhere, or the record is gone (after `onMissing`, still under
 * the lease) or no longer active.
 */
export function abortRecord(persistence, runId, onMissing) {
    const lease = persistence.acquireRunLease(runId);
    if (!lease)
        return false;
    try {
        const persisted = persistence.load(runId);
        if (!persisted) {
            onMissing();
            return false;
        }
        if (persisted.status !== "running" && persisted.status !== "paused")
            return false;
        const endedAt = new Date().toISOString();
        const errorMessage = persisted.error ?? "workflow aborted";
        const errorCode = persisted.errorCode ?? WorkflowErrorCode.WORKFLOW_ABORTED;
        persistence.save({
            ...persisted,
            status: "aborted",
            updatedAt: endedAt,
            completedAt: persisted.completedAt ?? endedAt,
            error: errorMessage,
            errorCode,
            agents: settleNonTerminalPersistedAgents(persisted.agents, "aborted", { message: errorMessage, code: errorCode }, endedAt),
        });
        return true;
    }
    finally {
        persistence.releaseRunLease(lease);
    }
}
/**
 * Merge the auto-resume counter into a record under a fresh lease. True when
 * the record now holds `attempts`. Skipped on contention, because the owner of
 * the lease writes the record itself; `onMissing` runs, under the lease, when
 * the record is gone.
 */
export function writeAutoResumeAttempts(persistence, runId, attempts, onMissing) {
    const lease = persistence.acquireRunLease(runId);
    if (!lease)
        return false;
    try {
        const current = readRecordPreview(persistence, runId);
        if (!current) {
            onMissing();
            return false;
        }
        if ((current.autoResumeAttempts ?? 0) !== attempts) {
            if (persistence.updateMetadata) {
                if (!persistence.updateMetadata(runId, { autoResumeAttempts: attempts }))
                    return false;
            }
            else
                persistence.save({ ...current, autoResumeAttempts: attempts });
        }
        return true;
    }
    finally {
        persistence.releaseRunLease(lease);
    }
}
