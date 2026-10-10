// Keeps the manager's in-memory runs in step with their records, ignoring superseded executions.
import { RunRecordDeletedError } from "../errors.js";
import { PersistThrottle } from "./persist-throttle.js";
import { readRecordPreview } from "./record-ops.js";
import { runRecord, settleAgentsForTerminalRun } from "./run-record.js";
import { TerminalRunRetention } from "./terminal-retention.js";
/**
 * The write side of the manager's run map. When resume() replaces a run's
 * entry or deleteRun() removes it, the old execution is no longer current: it
 * may still settle later, but must not write the record, touch the lease, or
 * emit events, or it would recreate a deleted run or overwrite a newer one.
 */
export class LiveRuns {
    persistence;
    runs;
    events;
    throttle = new PersistThrottle();
    retention;
    /** Runs deleted here or by another process; an execution still winding down finishes their deletion. */
    deleted = new WeakSet();
    constructor(runs, persistence, events, maxTerminalRunsInMemory) {
        this.runs = runs;
        this.persistence = persistence;
        this.events = events;
        this.retention = new TerminalRunRetention(runs, maxTerminalRunsInMemory);
    }
    get(runId) {
        return this.runs.get(runId);
    }
    /** Whether `managed` is still the entry for its run id. */
    isCurrent(managed) {
        return this.runs.get(managed.runId) === managed;
    }
    /**
     * Emit an event for an execution that is still current. A superseded one's
     * "complete" would otherwise deliver a result for a run that is gone or
     * replaced. Lifecycle commands emit directly: they are current when they fire.
     */
    emit(managed, event, payload) {
        if (this.isCurrent(managed))
            this.events.emit(event, payload);
    }
    hasListeners(event) {
        return this.events.listenerCount(event) > 0;
    }
    /**
     * Write the run now, replacing any pending throttled write, so the newest
     * state lands last. Every lifecycle change writes through here.
     */
    persistRun(managed, required = false) {
        if (!this.isCurrent(managed))
            return;
        this.throttle.cancel(managed.runId);
        this.writeRunToDisk(managed, required);
    }
    /** Write the run after the throttle window (progress only). */
    schedulePersist(managed) {
        this.throttle.schedule(managed.runId, () => this.writeRunToDisk(managed));
    }
    /**
     * The single path to disk. The current-entry check repeats persistRun()'s
     * because the throttled write arrives here directly. Progress writes are
     * best-effort; `required` writes (checkpoints) throw.
     */
    writeRunToDisk(managed, required = false) {
        if (!this.isCurrent(managed))
            return;
        try {
            const now = new Date();
            settleAgentsForTerminalRun(managed, now);
            this.persistence.save(runRecord(managed, now));
        }
        catch (err) {
            // Deletion by another process is authoritative: the local copy is stale.
            const deleted = err instanceof RunRecordDeletedError;
            if (deleted)
                this.forget(managed);
            if (required)
                throw err;
            if (!deleted)
                console.warn("[workflow-manager] Persist run failed:", err);
        }
    }
    releaseLease(managed) {
        if (!managed.lease)
            return;
        this.persistence.releaseRunLease(managed.lease);
        managed.lease = undefined;
    }
    /** A run whose execution settled to a terminal status may now be evicted from memory. */
    recordTerminalRun(runId) {
        this.retention.record(runId);
    }
    /** Remove a run being deleted: its entry and any pending write go; its execution, if any, finishes the deletion. */
    remove(runId, managed) {
        this.runs.delete(runId);
        if (managed)
            this.deleted.add(managed);
        this.throttle.cancel(runId);
    }
    /**
     * After an execution ends, delete a deleted run's files again: its script
     * may have caught the abort and kept writing its run log.
     */
    deleteLeftovers(managed) {
        if (!this.deleted.has(managed))
            return;
        try {
            this.persistence.delete(managed.runId);
        }
        catch {
            // Best-effort: a leftover log never resurrects the run.
        }
    }
    /**
     * Another process deleted this run's record. Mirror a local deleteRun(): stop
     * any live execution, drop the in-memory copy, and notify watchers, so no
     * later write can recreate the run.
     */
    forget(managed) {
        if (!this.isCurrent(managed))
            return;
        if (!managed.controller.signal.aborted)
            managed.controller.abort();
        this.remove(managed.runId, managed);
        this.releaseLease(managed);
        this.events.emit("deleted", { runId: managed.runId });
    }
    /**
     * Drop a settled local copy whose record another process deleted. A copy
     * still executing holds the lease, and its next write detects the deletion;
     * a record that exists but fails validation is damaged, not deleted.
     */
    dropIfDeleted(cached) {
        if (!cached || cached.lease)
            return;
        try {
            if (readRecordPreview(this.persistence, cached.runId))
                return;
        }
        catch {
            return;
        }
        this.forget(cached);
    }
}
