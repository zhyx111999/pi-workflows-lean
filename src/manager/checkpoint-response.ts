// Validates checkpoint responses: attaching a reply, and resuming past a checkpoint.

import { isDeepStrictEqual } from "node:util";
import type { PersistedRunState } from "../run-persistence.js";
import type { WorkflowCheckpoint } from "../workflow.js";

function staleCheckpointError(expected: string, received: string): Error {
  return new Error(
    `stale checkpoint response: expected ${JSON.stringify(expected)}, received ${JSON.stringify(received)}`,
  );
}

/**
 * The checkpoint with `response` attached, or undefined when that same response
 * is already attached. Throws for another checkpoint or a conflicting response.
 */
export function withCheckpointResponse(
  checkpoint: WorkflowCheckpoint,
  checkpointId: string,
  response: unknown,
): WorkflowCheckpoint | undefined {
  if (checkpoint.checkpointId !== checkpointId) throw staleCheckpointError(checkpoint.checkpointId, checkpointId);
  if (checkpoint.status !== "waiting") {
    if (isDeepStrictEqual(checkpoint.response, response)) return undefined;
    throw new Error(`conflicting response for checkpoint ${JSON.stringify(checkpointId)}`);
  }
  return { ...checkpoint, status: "resuming", response };
}

/**
 * Check that a resume may continue past the run's checkpoint. A run waiting at
 * a checkpoint resumes only with its exact ID and an attached response. Returns
 * true when that checkpoint was already consumed by a completed run, so there
 * is nothing left to resume.
 */
export function checkpointAlreadyConsumed(persisted: PersistedRunState, checkpointId: string | undefined): boolean {
  const checkpoint = persisted.checkpoint;
  if (checkpointId !== undefined) {
    if (!checkpoint) throw new Error("run has no durable checkpoint");
    if (checkpoint.checkpointId !== checkpointId) throw staleCheckpointError(checkpoint.checkpointId, checkpointId);
    if (checkpoint.status === "waiting") {
      throw new Error(`checkpoint ${JSON.stringify(checkpointId)} has no attached response`);
    }
    return checkpoint.status === "consumed" && persisted.status === "completed";
  }
  if (checkpoint?.status === "waiting" || checkpoint?.status === "resuming") {
    throw new Error(
      `run is waiting at checkpoint ${JSON.stringify(checkpoint.checkpointId)}; resume requires its exact checkpoint ID`,
    );
  }
  return false;
}
