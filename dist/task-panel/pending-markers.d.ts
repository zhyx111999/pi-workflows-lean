/**
 * Durable pending-delivery markers: give each delivery a stable id, save the
 * marker before sending, and clear it only after the send is confirmed.
 */
import type { PendingDeliveryMarker, PersistedRunState } from "../run-persistence.js";
import type { ManagedRun, WorkflowManager } from "../workflow-manager.js";
/** Confirmed deliveries whose pending marker still needs to be cleared durably. */
export declare const deliveredAwaitingClear: Map<string, {
    deliveryId: string;
    sessionId: string;
    generation: number;
}>;
export type ClearPendingResult = "cleared" | "stale" | "failed";
/** Outcome of making a delivery marker durable before its send. */
export type PendingSaveResult = "saved" | "deleted" | "failed";
/** Reuse the existing id for the same delivery so host history can deduplicate retries. */
export declare function markerWithId(marker: PendingDeliveryMarker, existing?: PendingDeliveryMarker): PendingDeliveryMarker;
export declare function markRunPending(run: ManagedRun, marker: PendingDeliveryMarker): PendingDeliveryMarker;
export declare function clearRunPending(manager: WorkflowManager, runId: string, deliveryId: string, run?: ManagedRun): ClearPendingResult;
/**
 * Make a live run's delivery marker durable before sending it. A run that has
 * never been written is seeded with a minimal record; persistence refuses to
 * recreate a record that another process deleted, which reports "deleted".
 */
export declare function persistRunPending(manager: WorkflowManager, run: ManagedRun): PendingSaveResult;
/** Give a disk-only pending run its delivery id. It never creates a record. */
export declare function persistDiskMarker(manager: WorkflowManager, runId: string, marker: PendingDeliveryMarker, state?: PersistedRunState): PendingSaveResult;
/** A run deleted by another process is no longer deliverable; drop its delivery state. */
export declare function abandonDeletedDelivery(runId: string, run?: ManagedRun): void;
/** Forget a session's confirmed-but-uncleared deliveries; the disk markers stay for the next flush. */
export declare function forgetAwaitingClear(sessionId: string): void;
