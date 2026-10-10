/** Redraws an open navigator when the workflow manager reports run progress. */
import type { WorkflowManager } from "../workflow-manager.js";
import type { NavigatorState } from "../workflow-ui.js";
/** Subscribe to manager events; returns the function that unsubscribes. */
export declare function subscribeToRunUpdates(manager: WorkflowManager, state: NavigatorState, rerender: () => void): () => void;
