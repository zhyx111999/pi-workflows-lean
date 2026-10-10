/** Implements checkpoint(): a journaled pause that suspends the run until the host persists a response for its ID. */
import type { WorkflowCheckpointInput } from "../workflow.js";
import type { RunContext } from "./run-context.js";
/** Build the script's checkpoint() global for this run. */
export declare function createCheckpoint(ctx: RunContext): (input: WorkflowCheckpointInput) => Promise<unknown>;
