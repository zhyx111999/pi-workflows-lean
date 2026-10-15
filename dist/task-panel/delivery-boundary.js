/**
 * Puts the results waiting for a busy host into the conversation at the end of
 * the model's current response: Pi's turn_end boundary, which runs once an
 * assistant response and the tool calls it made are complete and before the
 * agent loop decides what to request next. Entries returned there are appended
 * by Pi itself, in order, after the tool results, and `continue` asks for the
 * model request that answers them.
 *
 * So a result that arrives while the model streams never interrupts the
 * response, and it does not wait for the agent loop to finish: the loop's next
 * request, which exists whenever the response made tool calls, already carries
 * it, and a final response gets one more request to answer it. A result that
 * arrives while tools run waits only for them, since nothing may sit between a
 * tool call and its result. A turn that was cancelled or failed hands over
 * nothing; the host's idle signal delivers those.
 *
 * Pi appends the entries after the handler returns, so the handler cannot know
 * they landed. Each one is locked to its run and confirmed from the session
 * file ({@link claimInsertion}); only then is its marker cleared.
 */
import { claimInsertion, readyDeliveries } from "./delivery-dispatch.js";
import { resultMessage, sessionEndpoints } from "./delivery-endpoints.js";
import { captureHostLink } from "./host-session-capture.js";
/**
 * One handler per ExtensionAPI instance, delivering for that instance's latest
 * target: several live pi instances can interleave installs, and a
 * cross-project rebuild must not stack another handler.
 */
let boundaryTargets = new WeakMap();
/** The entries to append for `sessionId`'s waiting results, oldest first; none when its host cannot confirm them. */
export function insertionDrafts(manager, sessionId, endpoint) {
    if (endpoint.suspended || !endpoint.host)
        return [];
    const drafts = [];
    for (const ready of readyDeliveries(manager, sessionId, endpoint)) {
        if (!claimInsertion(manager, sessionId, ready))
            continue;
        drafts.push({ type: "custom_message", ...resultMessage(ready.content, ready.deliveryId) });
    }
    return drafts;
}
/** The session a turn belongs to and whether its run is being cancelled; the context throws once Pi has replaced it. */
function turnSession(ctx) {
    try {
        return { sessionId: ctx?.sessionManager?.getSessionId?.(), cancelling: ctx?.signal?.aborted === true };
    }
    catch {
        return { cancelling: false };
    }
}
/**
 * Deliver at every completed turn of `pi`'s sessions. Installing again for the
 * same `pi`, from this or a reloaded copy of the module, only retargets its
 * handler.
 */
export function installTurnBoundary(pi, target, bindHost) {
    const installed = boundaryTargets.get(pi);
    if (installed) {
        installed.manager = target.manager;
        installed.loadSettings = target.loadSettings;
        return;
    }
    const current = { ...target };
    boundaryTargets.set(pi, current);
    pi.on("turn_end", (event, ctx) => {
        // A failed or aborted turn cannot be answered, and neither can a run that
        // is being cancelled (its tools already returned "aborted"): the results
        // stay pending for the host's idle signal, which starts a turn of its own.
        const { sessionId = current.manager.getSessionId(), cancelling } = turnSession(ctx);
        if (event.outcome !== "completed" || cancelling || !sessionId)
            return;
        let endpoint = sessionEndpoints.get(sessionId);
        if (typeof endpoint?.send !== "function") {
            // Bind only once a host is captured; a failed capture leaves the
            // session as it was for the next turn to retry.
            const host = captureHostLink(pi, sessionId);
            if (!host)
                return;
            bindHost(current, sessionId, host, ctx?.sessionManager);
            endpoint = sessionEndpoints.get(sessionId);
        }
        if (!endpoint?.manager)
            return;
        // Pi hands every handler the entries chosen so far and keeps only what is returned.
        const drafts = insertionDrafts(endpoint.manager, sessionId, endpoint);
        if (!drafts.length)
            return;
        return { entries: [...event.entries, ...drafts], continue: true };
    });
}
/** @internal test helper — forget every installed handler's target. */
export function _resetTurnBoundaryForTests() {
    boundaryTargets = new WeakMap();
}
