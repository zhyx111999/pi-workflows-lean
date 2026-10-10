/** Rebuilds a display snapshot from a persisted run record so finished and other-session runs can be browsed. */
import type { WorkflowSnapshot } from "../display.js";
import type { PersistedRunState } from "../run-persistence.js";
export declare function persistedToSnapshot(p: PersistedRunState): WorkflowSnapshot;
