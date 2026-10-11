/** Process-wide registry of per-session delivery endpoints, and which session owns a run's result. */

import type { ManagedRun, WorkflowManager } from "../workflow-manager.js";
import type { WorkflowSettings } from "../workflow-settings.js";

export type DeliveryMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: { deliveryId?: string };
};

export type DeliverySend = (
  message: DeliveryMessage,
  options: { triggerTurn: boolean; deliverAs: "followUp" },
) => unknown;

export interface SessionDeliveryEndpoint {
  sessionId: string;
  reportWarning?: (message: string) => void;
  warned?: boolean;
  /**
   * Session-stable send that must return a thenable to count as an ACK: the
   * captured host AgentSession.sendCustomMessage, never the void
   * actions.sendMessage wrapper or a durable-only append.
   */
  send?: DeliverySend;
  loadSettings?: () => WorkflowSettings;
  /**
   * When true, do not call send — leave disk pending. Set for the whole window
   * between session_shutdown and the next bind for this sessionId so a
   * completion cannot land on a dying session.
   */
  suspended: boolean;
  /**
   * Generation counter bumped on every bind. An in-flight send captures the
   * generation it started under; on failure, if a newer generation has already
   * bound, we re-flush disk pending onto it.
   */
  generation: number;
  /** Owning manager used to recompute complete-text and clear pending markers. */
  manager?: WorkflowManager;
}

/** One live endpoint per pi session id. */
export const sessionEndpoints = new Map<string, SessionDeliveryEndpoint>();

/** Report the first actionable delivery problem for a session through its UI-safe channel. */
export function warnDelivery(sessionId: string | undefined, message: string): void {
  const endpoint = sessionId ? sessionEndpoints.get(sessionId) : undefined;
  if (!endpoint || endpoint.warned || !endpoint.reportWarning) return;
  endpoint.warned = true;
  try {
    endpoint.reportWarning(message);
  } catch {
    // Diagnostics must never affect delivery or write raw stderr over the TUI.
  }
}

/** The session that receives a run's result. Never invents one. */
export function resolveDeliverySessionId(run: ManagedRun, manager: WorkflowManager): string | undefined {
  // The originating run wins; the manager binding covers runs that predate a
  // per-run sessionId.
  return run.sessionId ?? manager.getSessionId();
}
