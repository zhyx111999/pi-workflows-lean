/**
 * Sends a result through its own session's endpoint, clears the pending marker
 * only after the send is confirmed, and redelivers whatever is still pending.
 */
import type { PendingDeliveryMarker, PersistedRunState } from "../run-persistence.js";
import type { ManagedRun, WorkflowManager } from "../workflow-manager.js";
import type { WorkflowSettings } from "../workflow-settings.js";
import { type SessionDeliveryEndpoint } from "./delivery-endpoints.js";
/**
 * Rebuilds the message for a pending marker. A complete result is rendered again
 * from the live run or its record instead of storing the body twice on disk.
 */
export type PendingTextRenderer = (manager: WorkflowManager, runId: string, marker: PendingDeliveryMarker, loadSettings?: () => WorkflowSettings, run?: ManagedRun, persisted?: PersistedRunState) => string | undefined;
/** Installed once by task-panel.ts, which owns the delivered wording. */
export declare function setPendingTextRenderer(render: PendingTextRenderer): void;
/**
 * Deliver a live background run's result: save the marker first so a crash or
 * a missing endpoint cannot lose it, then send only through the originating
 * session's endpoint.
 */
export declare function routeBackgroundDelivery(manager: WorkflowManager, run: ManagedRun, marker: PendingDeliveryMarker, content: string): void;
/** Deliver every result still pending for a session, from live runs and from disk. */
export declare function flushSessionDiskPending(manager: WorkflowManager, sessionId: string, endpoint: SessionDeliveryEndpoint): void;
/** @internal test helper — drop every in-flight lock. */
export declare function _resetDeliveryDispatchForTests(): void;
