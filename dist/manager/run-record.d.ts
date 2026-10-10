import type { WorkflowErrorCode } from "../errors.js";
import { type PersistedRunState } from "../run-persistence.js";
import type { ManagedRun } from "../workflow-manager.js";
/**
 * Mark the queued and running rows of a settled execution as skipped. Display
 * only: replay is keyed by the journal, not by these rows.
 */
export declare function settleInterruptedAgents(managed: ManagedRun, cause: {
    error: string;
    errorCode?: WorkflowErrorCode;
}, endedAt: Date): void;
/** Settle leftover rows of a run that reached a terminal status, with that status as the cause. */
export declare function settleAgentsForTerminalRun(managed: ManagedRun, endedAt: Date): void;
/** The first record of a background run, written before it starts executing. */
export declare function initialRunRecord(managed: ManagedRun): PersistedRunState;
/** The full record of `managed` as of `now`. */
export declare function runRecord(managed: ManagedRun, now: Date): PersistedRunState;
