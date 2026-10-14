/**
 * Puts the results waiting for a busy host into the conversation at the
 * boundary Pi provides for it: agent_before_settle, which runs once the run's
 * last assistant response is complete and before the run settles. Entries
 * returned there are appended by Pi itself, in order, after that response,
 * and `continue` asks for the one model request that answers them. So a
 * result that arrives mid-run never interrupts a response, and does not wait
 * for the user's next message either.
 *
 * Pi appends the entries after the handler returns, so the handler cannot
 * know they landed. Each one is locked to its run and confirmed from the
 * session file ({@link claimInsertion}); only then is its marker cleared.
 */

import type { CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager } from "../workflow-manager.js";
import { claimInsertion, readyDeliveries } from "./delivery-dispatch.js";
import { resultMessage, type SessionDeliveryEndpoint } from "./delivery-endpoints.js";

/** The entries to append for `sessionId`'s waiting results, oldest first; none when its host cannot confirm them. */
export function insertionDrafts(
  manager: WorkflowManager,
  sessionId: string,
  endpoint: SessionDeliveryEndpoint,
): CustomMessageEntryDraft[] {
  if (endpoint.suspended || !endpoint.host) return [];
  const drafts: CustomMessageEntryDraft[] = [];
  for (const ready of readyDeliveries(manager, sessionId, endpoint)) {
    if (!claimInsertion(manager, sessionId, ready)) continue;
    drafts.push({ type: "custom_message", ...resultMessage(ready.content, ready.deliveryId) });
  }
  return drafts;
}
