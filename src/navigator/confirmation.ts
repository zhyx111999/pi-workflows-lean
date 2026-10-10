/** Two-step confirmation for destructive actions, bound to the exact view and target that asked. */

import type { ViewKind } from "../workflow-ui.js";
import { type ItemIdentity, type SavedItemIdentity, sameIdentity } from "./items.js";

export type ConfirmKind = "pause" | "stop" | "deleteSaved";

/** The view a confirmation was requested from; confirming anywhere else cancels it. */
export type ConfirmationContext = {
  kind: ViewKind;
  runId?: string;
  phase?: string;
  agentId?: number;
  savedIdentity?: SavedItemIdentity;
};

export type PendingConfirmation = {
  action: ConfirmKind;
  target: ItemIdentity;
  cursor: number;
  filter: string;
  context: ConfirmationContext;
};

export function sameConfirmationContext(current: ConfirmationContext, requested: ConfirmationContext): boolean {
  return (
    current.kind === requested.kind &&
    current.runId === requested.runId &&
    current.phase === requested.phase &&
    current.agentId === requested.agentId &&
    ((!current.savedIdentity && !requested.savedIdentity) ||
      sameIdentity(current.savedIdentity, requested.savedIdentity))
  );
}
