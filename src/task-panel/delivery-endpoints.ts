/** Process-wide registry of per-session delivery endpoints, and which session owns a run's result. */

import { refreshRunSession } from "../manager/session-owner.js";
import type { ManagedRun, WorkflowManager } from "../workflow-manager.js";
import type { WorkflowSettings } from "../workflow-settings.js";
import type { HostSessionLink } from "./host-session-link.js";

/** Custom message type of a delivered result, in the host's history and in the boundary entries Pi appends. */
export const RESULT_MESSAGE_TYPE = "workflow-result";

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

/** A result as the conversation records it, whether sent into an idle host or inserted at its boundary. */
export function resultMessage(content: string, deliveryId: string): DeliveryMessage {
  return { customType: RESULT_MESSAGE_TYPE, content, display: true, details: { deliveryId } };
}

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
  /**
   * The captured host session behind `send`: its busy state decides whether a
   * result goes out now or waits for the host's boundary. A bare `send` has no
   * host, is never busy, and cannot take boundary insertions.
   */
  host?: HostSessionLink;
  /** Stops listening for the host's idle signal. */
  unwatch?: () => void;
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

/** One live endpoint per pi session id. Change it through the functions below, which stop the host listening. */
export const sessionEndpoints = new Map<string, SessionDeliveryEndpoint>();

export function replaceEndpoint(endpoint: SessionDeliveryEndpoint): void {
  sessionEndpoints.get(endpoint.sessionId)?.unwatch?.();
  sessionEndpoints.set(endpoint.sessionId, endpoint);
}

export function removeEndpoint(sessionId: string): void {
  sessionEndpoints.get(sessionId)?.unwatch?.();
  sessionEndpoints.delete(sessionId);
}

export function clearEndpoints(): void {
  for (const endpoint of sessionEndpoints.values()) endpoint.unwatch?.();
  sessionEndpoints.clear();
}

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

/**
 * The session that receives a run's result: its record's owner, read now
 * because another process may have moved it since this copy last wrote. The
 * manager binding covers a run nobody owns yet. Never invents one.
 */
export function resolveDeliverySessionId(run: ManagedRun, manager: WorkflowManager): string | undefined {
  return refreshRunSession(manager.getPersistence(), run) ?? manager.getSessionId();
}
