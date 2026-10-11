/**
 * Sends a result through its own session's endpoint, clears the pending marker
 * only after the send is confirmed, and redelivers whatever is still pending.
 */
import { resolveDeliverySessionId, sessionEndpoints, warnDelivery, } from "./delivery-endpoints.js";
import { cancelDeliveryRetry, scheduleDeliveryRetry } from "./delivery-retry.js";
import { abandonDeletedDelivery, clearRunPending, deliveredAwaitingClear, markerWithId, markRunPending, persistDiskMarker, persistRunPending, } from "./pending-markers.js";
let renderPendingText;
/** Installed once by task-panel.ts, which owns the delivered wording. */
export function setPendingTextRenderer(render) {
    renderPendingText = render;
}
/** Ownership-token locks prevent stale promise chains from releasing newer sends. */
const inFlightDeliveries = new Map();
let inFlightSeq = 0;
/**
 * Resolve true only after the endpoint's thenable send settles while the
 * session is still live. Void sends and durable appends are not an ACK: an
 * append writes history without starting a turn. Never clears markers.
 */
function tryDeliverEndpoint(endpoint, content, deliveryId) {
    if (endpoint.suspended)
        return Promise.resolve(false);
    // A stale endpoint object left behind by a rebind or drop must not send.
    if (endpoint.sessionId && sessionEndpoints.get(endpoint.sessionId) !== endpoint)
        return Promise.resolve(false);
    if (typeof endpoint.send !== "function")
        return Promise.resolve(false);
    try {
        const ret = endpoint.send({ customType: "workflow-result", content, display: true, details: { deliveryId } }, { triggerTurn: true, deliverAs: "followUp" });
        if (ret != null && typeof ret.then === "function") {
            const sessionId = endpoint.sessionId;
            return Promise.resolve(ret).then(() => {
                const current = sessionEndpoints.get(sessionId);
                // Succeeded under this or a newer live endpoint for the same session.
                return !!current && !current.suspended;
            }, (err) => {
                const msg = err instanceof Error ? err.message : String(err);
                warnDelivery(sessionId, `Workflow result remains pending: ${msg}`);
                return false;
            });
        }
        warnDelivery(endpoint.sessionId, `[workflow-delivery] send for session ${endpoint.sessionId} did not return a thenable; ` +
            "not treating as delivered (fail closed).");
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnDelivery(endpoint.sessionId, `Workflow result remains pending: ${msg}`);
    }
    return Promise.resolve(false);
}
function releaseDelivery(runId, token) {
    if (inFlightDeliveries.get(runId)?.token === token)
        inFlightDeliveries.delete(runId);
}
function retryLater(manager, runId, sessionId, generation) {
    scheduleDeliveryRetry(runId, sessionId, generation, (endpoint) => flushSessionDiskPending(manager, sessionId, endpoint));
}
function deliverAndAck(manager, runId, sessionId, content, deliveryId, run) {
    if (inFlightDeliveries.has(runId))
        return;
    const endpoint = sessionEndpoints.get(sessionId);
    if (!endpoint || endpoint.suspended)
        return;
    // Already confirmed on this endpoint generation: only the marker clear is left.
    const delivered = deliveredAwaitingClear.get(runId);
    if (delivered?.deliveryId === deliveryId &&
        delivered.sessionId === sessionId &&
        delivered.generation === endpoint.generation) {
        const clear = clearRunPending(manager, runId, deliveryId, run ?? manager.getRun(runId));
        if (clear !== "failed") {
            deliveredAwaitingClear.delete(runId);
            cancelDeliveryRetry(runId);
        }
        else {
            retryLater(manager, runId, sessionId, endpoint.generation);
        }
        return;
    }
    // Fail closed without a send, and without taking the lock: a synchronous
    // rebind + flush (e.g. the probe retry on the next session_start) must not be
    // locked out by a microtask that has not run yet.
    if (typeof endpoint.send !== "function") {
        warnDelivery(sessionId, `[workflow-delivery] delivery for ${runId} deferred: endpoint for session ${sessionId} has no thenable send function`);
        return;
    }
    const token = ++inFlightSeq;
    inFlightDeliveries.set(runId, { token, sessionId });
    const startedGeneration = endpoint.generation;
    void tryDeliverEndpoint(endpoint, content, deliveryId)
        .then((ok) => {
        if (ok) {
            cancelDeliveryRetry(runId);
            const current = sessionEndpoints.get(sessionId);
            if (!current || current.suspended || current.generation !== startedGeneration || current !== endpoint) {
                return;
            }
            const clear = clearRunPending(manager, runId, deliveryId, run ?? manager.getRun(runId));
            if (clear === "failed") {
                deliveredAwaitingClear.set(runId, { deliveryId, sessionId, generation: startedGeneration });
                retryLater(manager, runId, sessionId, startedGeneration);
            }
            else if (clear === "stale") {
                // This send belonged to an older marker. Release before flushing the
                // newer delivery, and let the ownership token protect its lock.
                releaseDelivery(runId, token);
                const active = sessionEndpoints.get(sessionId);
                if (active && !active.suspended && active.manager) {
                    flushSessionDiskPending(active.manager, sessionId, active);
                }
            }
            return;
        }
        releaseDelivery(runId, token);
        const current = sessionEndpoints.get(sessionId);
        if (!current || current.suspended || !current.manager)
            return;
        if (current.generation !== startedGeneration) {
            cancelDeliveryRetry(runId);
            flushSessionDiskPending(current.manager, sessionId, current);
        }
        else {
            retryLater(manager, runId, sessionId, startedGeneration);
        }
    })
        .finally(() => {
        releaseDelivery(runId, token);
        const liveRun = manager.getRun(runId);
        const owner = liveRun
            ? resolveDeliverySessionId(liveRun, manager)
            : (manager.getPersistence().loadPreview(runId)?.sessionId ?? sessionId);
        const current = owner ? sessionEndpoints.get(owner) : undefined;
        // A rebind may have tried to flush while this send still owned the lock.
        // Hand off after either settlement, including a successful stale ACK.
        if (current && !current.suspended && current.manager && current !== endpoint) {
            flushSessionDiskPending(current.manager, current.sessionId, current);
        }
    });
}
/**
 * Deliver a live background run's result: save the marker first so a crash or
 * a missing endpoint cannot lose it, then send only through the originating
 * session's endpoint.
 */
export function routeBackgroundDelivery(manager, run, marker, content) {
    const pending = markRunPending(run, marker);
    const deliveryId = pending.deliveryId;
    if (!deliveryId)
        return;
    const saved = persistRunPending(manager, run);
    if (saved === "deleted") {
        abandonDeletedDelivery(run.runId, run);
        return;
    }
    const sessionId = resolveDeliverySessionId(run, manager);
    if (!sessionId)
        return;
    if (saved === "failed") {
        const endpoint = sessionEndpoints.get(sessionId);
        if (endpoint && !endpoint.suspended)
            retryLater(manager, run.runId, sessionId, endpoint.generation);
        return;
    }
    deliverAndAck(manager, run.runId, sessionId, content, deliveryId, run);
}
/** Deliver every result still pending for a session, from live runs and from disk. */
export function flushSessionDiskPending(manager, sessionId, endpoint) {
    if (endpoint.suspended)
        return;
    const tryOne = (runId, marker, run, persisted) => {
        if (inFlightDeliveries.has(runId))
            return;
        // A live run re-persists its marker; a disk-only run only needs a missing id.
        const identified = run ? markRunPending(run, marker) : marker.deliveryId ? marker : markerWithId(marker);
        const saved = run
            ? persistRunPending(manager, run)
            : identified === marker
                ? "saved"
                : persistDiskMarker(manager, runId, identified);
        if (saved === "deleted") {
            abandonDeletedDelivery(runId, run);
            return;
        }
        if (saved === "failed") {
            if (run)
                retryLater(manager, runId, sessionId, endpoint.generation);
            else
                warnDelivery(sessionId, `Workflow ${runId}: delivery deferred because its marker could not be saved.`);
            return;
        }
        const deliveryId = identified.deliveryId;
        if (!deliveryId)
            return;
        const content = renderPendingText?.(manager, runId, identified, endpoint.loadSettings, run, persisted);
        if (content === undefined)
            return;
        deliverAndAck(manager, runId, sessionId, content, deliveryId, run);
    };
    // Live in-memory runs for this session. A null sessionId is claimable only for
    // this manager's own live runs (completions before the first bind), never
    // from a foreign manager.
    try {
        for (const run of manager.listLiveRuns()) {
            if (!run.pendingDelivery)
                continue;
            if (run.sessionId != null && run.sessionId !== sessionId)
                continue;
            if (run.sessionId == null)
                run.sessionId = sessionId;
            tryOne(run.runId, run.pendingDelivery, run);
        }
    }
    catch {
        // listLiveRuns may be absent on stubs
    }
    // Disk runs, including terminal runs already evicted from memory. Require an
    // exact sessionId match: claiming null-sessionId rows would race a second
    // manager on the same cwd. Session handoff re-homes earlier pendings first.
    try {
        for (const state of manager.getPersistence().list()) {
            if (!state.pendingDelivery)
                continue;
            if (state.sessionId !== sessionId)
                continue;
            // Skip if the live copy still carries the marker — the loop above owns it.
            const live = manager.getRun(state.runId);
            if (live?.pendingDelivery)
                continue;
            try {
                tryOne(state.runId, state.pendingDelivery, live, state);
            }
            catch {
                // The list can still show a run another process just deleted, whose
                // record then fails to read; skip it so the other results still go out.
            }
        }
    }
    catch {
        // best-effort
    }
}
/** @internal test helper — drop every in-flight lock. */
export function _resetDeliveryDispatchForTests() {
    inFlightDeliveries.clear();
    inFlightSeq = 0;
}
