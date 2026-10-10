/** Two-step confirmation for destructive actions, bound to the exact view and target that asked. */
import { sameIdentity } from "./items.js";
export function sameConfirmationContext(current, requested) {
    return (current.kind === requested.kind &&
        current.runId === requested.runId &&
        current.phase === requested.phase &&
        current.agentId === requested.agentId &&
        ((!current.savedIdentity && !requested.savedIdentity) ||
            sameIdentity(current.savedIdentity, requested.savedIdentity)));
}
