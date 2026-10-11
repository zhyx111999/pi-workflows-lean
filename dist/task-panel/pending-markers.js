/**
 * Durable pending-delivery markers: give each delivery a stable id, save the
 * marker before sending, and clear it only after the send is confirmed.
 */
import { randomUUID } from "node:crypto";
import { RunRecordDeletedError } from "../errors.js";
import { warnDelivery } from "./delivery-endpoints.js";
import { cancelDeliveryRetry } from "./delivery-retry.js";
/** Confirmed deliveries whose pending marker still needs to be cleared durably. */
export const deliveredAwaitingClear = new Map();
function sameDelivery(a, b) {
    return a?.kind === b.kind && (a.kind !== "text" || (b.kind === "text" && a.text === b.text));
}
/** Reuse the existing id for the same delivery so host history can deduplicate retries. */
export function markerWithId(marker, existing) {
    const deliveryId = sameDelivery(existing, marker) ? existing?.deliveryId : undefined;
    return { ...marker, deliveryId: deliveryId ?? marker.deliveryId ?? randomUUID() };
}
export function markRunPending(run, marker) {
    const identified = markerWithId(marker, run.pendingDelivery);
    if (run.pendingDelivery?.deliveryId !== identified.deliveryId)
        deliveredAwaitingClear.delete(run.runId);
    run.pendingDelivery = identified;
    return identified;
}
export function clearRunPending(manager, runId, deliveryId, run) {
    // Clear disk first. If that fails, retain the live marker so the delivered
    // message remains visible to the bounded clear retry instead of being lost.
    // A record deleted by another process has no marker left to clear.
    try {
        const live = run ?? manager.getRun(runId);
        if (live?.pendingDelivery?.deliveryId && live.pendingDelivery.deliveryId !== deliveryId)
            return "stale";
        const persistence = manager.getPersistence();
        // A refused clear on a record that still exists means another delivery owns it.
        if (!persistence.updateMetadata(runId, { pendingDelivery: undefined }, deliveryId) &&
            persistence.loadPreview(runId))
            return "stale";
        if (live)
            live.pendingDelivery = undefined;
        return "cleared";
    }
    catch {
        warnDelivery(run?.sessionId ?? manager.getSessionId(), `Workflow ${runId}: result delivered, but its pending marker could not be cleared.`);
        return "failed";
    }
}
/**
 * Make a live run's delivery marker durable before sending it. A run that has
 * never been written is seeded with a minimal record; persistence refuses to
 * recreate a record that another process deleted, which reports "deleted".
 */
export function persistRunPending(manager, run) {
    try {
        // Merge into an existing on-disk record so we don't clobber the
        // manager's richer write that follows the complete/error emit.
        const persistence = manager.getPersistence();
        if (persistence.updateMetadata(run.runId, { pendingDelivery: run.pendingDelivery, sessionId: run.sessionId }))
            return "saved";
        if (run.pendingDelivery) {
            persistence.save({
                runId: run.runId,
                workflowName: run.snapshot.name,
                script: run.script ?? "",
                sessionId: run.sessionId,
                status: run.status,
                phases: run.snapshot.phases ?? [],
                agents: [],
                logs: run.snapshot.logs ?? [],
                result: run.result?.result,
                tokenUsage: run.result?.tokenUsage ?? run.snapshot.tokenUsage,
                durationMs: run.result?.durationMs,
                startedAt: run.startedAt?.toISOString?.() ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                pendingDelivery: run.pendingDelivery,
            });
        }
        return "saved";
    }
    catch (error) {
        if (error instanceof RunRecordDeletedError)
            return "deleted";
        warnDelivery(run.sessionId, `Workflow ${run.runId}: delivery deferred because its pending marker could not be saved.`);
        return "failed";
    }
}
/** Give a disk-only pending run its delivery id. It never creates a record. */
export function persistDiskMarker(manager, runId, marker) {
    try {
        return manager.getPersistence().updateMetadata(runId, { pendingDelivery: marker }) ? "saved" : "deleted";
    }
    catch (error) {
        return error instanceof RunRecordDeletedError ? "deleted" : "failed";
    }
}
/** A run deleted by another process is no longer deliverable; drop its delivery state. */
export function abandonDeletedDelivery(runId, run) {
    if (run)
        run.pendingDelivery = undefined;
    deliveredAwaitingClear.delete(runId);
    cancelDeliveryRetry(runId);
}
/** Forget a session's confirmed-but-uncleared deliveries; the disk markers stay for the next flush. */
export function forgetAwaitingClear(sessionId) {
    for (const [runId, delivered] of deliveredAwaitingClear) {
        if (delivered.sessionId === sessionId)
            deliveredAwaitingClear.delete(runId);
    }
}
