import type { EventEmitter } from "node:events";
import type { RunPersistence } from "../run-persistence.js";
import type { ManagedRun } from "../workflow-manager.js";
/**
 * The write side of the manager's run map. When resume() replaces a run's
 * entry or deleteRun() removes it, the old execution is no longer current: it
 * may still settle later, but must not write the record, touch the lease, or
 * emit events, or it would recreate a deleted run or overwrite a newer one.
 */
export declare class LiveRuns {
    readonly persistence: RunPersistence;
    private readonly runs;
    private readonly events;
    private readonly throttle;
    private readonly retention;
    /** Runs deleted here or by another process; an execution still winding down finishes their deletion. */
    private readonly deleted;
    constructor(runs: Map<string, ManagedRun>, persistence: RunPersistence, events: EventEmitter, maxTerminalRunsInMemory: number);
    get(runId: string): ManagedRun | undefined;
    /** Whether `managed` is still the entry for its run id. */
    isCurrent(managed: ManagedRun): boolean;
    /**
     * Emit an event for an execution that is still current. A superseded one's
     * "complete" would otherwise deliver a result for a run that is gone or
     * replaced. Lifecycle commands emit directly: they are current when they fire.
     */
    emit(managed: ManagedRun, event: string, payload: unknown): void;
    hasListeners(event: string): boolean;
    /**
     * Write the run now, replacing any pending throttled write, so the newest
     * state lands last. Every lifecycle change writes through here.
     */
    persistRun(managed: ManagedRun, required?: boolean): void;
    /** Write the run after the throttle window (progress only). */
    schedulePersist(managed: ManagedRun): void;
    /**
     * The single path to disk. The current-entry check repeats persistRun()'s
     * because the throttled write arrives here directly. Progress writes are
     * best-effort; `required` writes (checkpoints) throw.
     */
    private writeRunToDisk;
    releaseLease(managed: ManagedRun): void;
    /** A run whose execution settled to a terminal status may now be evicted from memory. */
    recordTerminalRun(runId: string): void;
    /** Remove a run being deleted: its entry and any pending write go; its execution, if any, finishes the deletion. */
    remove(runId: string, managed: ManagedRun | undefined): void;
    /**
     * After an execution ends, delete a deleted run's files again: its script
     * may have caught the abort and kept writing its run log.
     */
    deleteLeftovers(managed: ManagedRun): void;
    /**
     * Another process deleted this run's record. Mirror a local deleteRun(): stop
     * any live execution, drop the in-memory copy, and notify watchers, so no
     * later write can recreate the run.
     */
    forget(managed: ManagedRun): void;
    /**
     * Drop a settled local copy whose record another process deleted. A copy
     * still executing holds the lease, and its next write detects the deletion;
     * a record that exists but fails validation is damaged, not deleted.
     */
    dropIfDeleted(cached: ManagedRun | undefined): void;
}
