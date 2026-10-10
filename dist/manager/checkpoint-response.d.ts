import type { PersistedRunState } from "../run-persistence.js";
import type { ManagedRun } from "../workflow-manager.js";
import type { LiveRuns } from "./live-runs.js";
/**
 * Attach a response to a waiting checkpoint; it is on disk before this
 * resolves, so it survives a restart. While the suspended execution still
 * waits for its other agents, the response is written through the live run,
 * whose lease that execution holds; otherwise through the record under a
 * fresh lease.
 */
export declare function attachCheckpointResponse(live: LiveRuns, executionOf: (run: ManagedRun) => Promise<unknown> | undefined, runId: string, checkpointId: string, responseValue: unknown): Promise<void>;
/**
 * Check that a resume may continue past the run's checkpoint. A run waiting at
 * a checkpoint resumes only with its exact ID and an attached response. Returns
 * true when that checkpoint was already consumed by a completed run, so there
 * is nothing left to resume.
 */
export declare function checkpointAlreadyConsumed(persisted: PersistedRunState, checkpointId: string | undefined): boolean;
