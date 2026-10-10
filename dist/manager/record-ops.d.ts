import { type PersistedRunState, type RunLease, type RunPersistence } from "../run-persistence.js";
/** A run's record from the cheap preview read when the store has one. */
export declare function readRecordPreview(persistence: RunPersistence, runId: string): PersistedRunState | null;
/** A lease for `runId`, or undefined when it is held elsewhere or the probe fails. */
export declare function tryAcquireRunLease(persistence: RunPersistence, runId: string): RunLease | undefined;
/** Point a record at another delivery session, leaving the rest as written. False when it is gone. */
export declare function rehomeRecord(persistence: RunPersistence, runId: string, sessionId: string): boolean;
/**
 * Move undelivered results of `previousSessionId` that are only on disk to
 * `sessionId`. Never claims another session's results or ones without a
 * session. Best-effort: returns how many moved before any failure.
 */
export declare function rehomePendingRecords(persistence: RunPersistence, sessionId: string, previousSessionId: string | undefined, inMemory: (runId: string) => boolean): number;
/**
 * At startup, a record still marked running belongs to a process that died
 * mid-run. Pause it, never fail it, so its journal survives and resume() can
 * replay the finished calls. The same applies to a paused record with agents
 * still marked active.
 */
export declare function recoverStaleRuns(persistence: RunPersistence): void;
/**
 * Mark a running or paused record aborted under a fresh lease. False when the
 * lease is held elsewhere, or the record is gone (after `onMissing`, still under
 * the lease) or no longer active.
 */
export declare function abortRecord(persistence: RunPersistence, runId: string, onMissing: () => void): boolean;
/**
 * Merge the auto-resume counter into a record under a fresh lease. True when
 * the record now holds `attempts`. Skipped on contention, because the owner of
 * the lease writes the record itself; `onMissing` runs, under the lease, when
 * the record is gone.
 */
export declare function writeAutoResumeAttempts(persistence: RunPersistence, runId: string, attempts: number, onMissing: () => void): boolean;
