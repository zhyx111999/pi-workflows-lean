/** Process-wide registry of per-session delivery endpoints, and which session owns a run's result. */
import { refreshRunSession } from "../manager/session-owner.js";
/** Custom message type of a delivered result, in the host's history and in the boundary entries Pi appends. */
export const RESULT_MESSAGE_TYPE = "workflow-result";
/** A result as the conversation records it, whether sent into an idle host or inserted at its boundary. */
export function resultMessage(content, deliveryId) {
    return { customType: RESULT_MESSAGE_TYPE, content, display: true, details: { deliveryId } };
}
/** One live endpoint per pi session id. Change it through the functions below, which stop the host listening. */
export const sessionEndpoints = new Map();
export function replaceEndpoint(endpoint) {
    sessionEndpoints.get(endpoint.sessionId)?.unwatch?.();
    sessionEndpoints.set(endpoint.sessionId, endpoint);
}
export function removeEndpoint(sessionId) {
    sessionEndpoints.get(sessionId)?.unwatch?.();
    sessionEndpoints.delete(sessionId);
}
export function clearEndpoints() {
    for (const endpoint of sessionEndpoints.values())
        endpoint.unwatch?.();
    sessionEndpoints.clear();
}
/** Report the first actionable delivery problem for a session through its UI-safe channel. */
export function warnDelivery(sessionId, message) {
    const endpoint = sessionId ? sessionEndpoints.get(sessionId) : undefined;
    if (!endpoint || endpoint.warned || !endpoint.reportWarning)
        return;
    endpoint.warned = true;
    try {
        endpoint.reportWarning(message);
    }
    catch {
        // Diagnostics must never affect delivery or write raw stderr over the TUI.
    }
}
/**
 * The session that receives a run's result: its record's owner, read now
 * because another process may have moved it since this copy last wrote. The
 * manager binding covers a run nobody owns yet. Never invents one.
 */
export function resolveDeliverySessionId(run, manager) {
    return refreshRunSession(manager.getPersistence(), run) ?? manager.getSessionId();
}
