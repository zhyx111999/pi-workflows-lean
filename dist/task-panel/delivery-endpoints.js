/** Process-wide registry of per-session delivery endpoints, and which session owns a run's result. */
/** One live endpoint per pi session id. */
export const sessionEndpoints = new Map();
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
/** The session that receives a run's result. Never invents one. */
export function resolveDeliverySessionId(run, manager) {
    // The originating run wins; the manager binding covers runs that predate a
    // per-run sessionId.
    return run.sessionId ?? manager.getSessionId();
}
