/**
 * Sends a result through its own session's endpoint, clears the pending marker
 * only after the send is confirmed, and redelivers whatever is still pending.
 * Nothing a send's settlement throws escapes: the marker stays, the session's
 * warning channel reports it, and a bounded retry follows.
 *
 * A result reaches a session at one of two points. An idle host gets it sent
 * at once. A busy host never does: the marker stays durable and the result
 * goes in at the end of the host's current assistant turn, the turn_end
 * boundary ({@link claimInsertion}), or, when the run ends without a turn that
 * can take it (an abort), in the flush that follows the host's idle signal.
 * Results always go out oldest first.
 */

import { errorMessage } from "../errors.js";
import { claimRunSession } from "../manager/session-owner.js";
import type { PendingDeliveryMarker, PersistedRunState } from "../run-persistence.js";
import type { ManagedRun, WorkflowManager } from "../workflow-manager.js";
import type { WorkflowSettings } from "../workflow-settings.js";
import {
  resolveDeliverySessionId,
  resultMessage,
  type SessionDeliveryEndpoint,
  sessionEndpoints,
  warnDelivery,
} from "./delivery-endpoints.js";
import { cancelDeliveryRetry, scheduleDeliveryRetry } from "./delivery-retry.js";
import {
  abandonDeletedDelivery,
  byIssueOrder,
  type ClearPendingResult,
  clearRunPending,
  deliveredAwaitingClear,
  markerWithId,
  markRunPending,
  persistDiskMarker,
  persistRunPending,
} from "./pending-markers.js";

/**
 * Rebuilds the message for a pending marker. A complete result is rendered again
 * from the live run or its record instead of storing the body twice on disk.
 */
export type PendingTextRenderer = (
  manager: WorkflowManager,
  runId: string,
  marker: PendingDeliveryMarker,
  loadSettings?: () => WorkflowSettings,
  run?: ManagedRun,
  persisted?: PersistedRunState,
) => string | undefined;

let renderPendingText: PendingTextRenderer | undefined;

/** Installed once by task-panel.ts, which owns the delivered wording. */
export function setPendingTextRenderer(render: PendingTextRenderer): void {
  renderPendingText = render;
}

/** A pending result whose marker is durable and whose text is rendered: ready to go out. */
export interface ReadyDelivery {
  runId: string;
  deliveryId: string;
  content: string;
  run?: ManagedRun;
}

/** Run id → token of the send that holds its lock, so a stale settlement cannot release a newer send. */
const inFlightDeliveries = new Map<string, number>();
let inFlightSeq = 0;

function takeLock(runId: string): number {
  const token = ++inFlightSeq;
  inFlightDeliveries.set(runId, token);
  return token;
}

function releaseDelivery(runId: string, token: number): void {
  if (inFlightDeliveries.get(runId) === token) inFlightDeliveries.delete(runId);
}

/**
 * How a delivery attempt ended. "missed" is not a failure: Pi's boundary passed
 * without taking the entry, and the next boundary or the host's idle signal
 * offers the result again, so nothing is retried on a timer.
 */
type Attempt = "delivered" | "failed" | "missed";

/**
 * "delivered" only after the endpoint's thenable send settles while the
 * session is still live. Void sends and durable appends are not an ACK: an
 * append writes history without starting a turn. Never clears markers.
 */
async function sendToIdleHost(
  endpoint: SessionDeliveryEndpoint,
  content: string,
  deliveryId: string,
): Promise<"delivered" | "failed"> {
  const { sessionId } = endpoint;
  if (endpoint.suspended || typeof endpoint.send !== "function") return "failed";
  // A stale endpoint object left behind by a rebind or drop must not send.
  if (sessionId && sessionEndpoints.get(sessionId) !== endpoint) return "failed";

  try {
    const ack = endpoint.send(resultMessage(content, deliveryId), { triggerTurn: true, deliverAs: "followUp" });
    if (typeof (ack as { then?: unknown } | null | undefined)?.then !== "function") {
      warnDelivery(
        sessionId,
        `[workflow-delivery] send for session ${sessionId} did not return a thenable; ` +
          "not treating as delivered (fail closed).",
      );
      return "failed";
    }
    await ack;
  } catch (error) {
    warnDelivery(sessionId, `Workflow result remains pending: ${errorMessage(error)}`);
    return "failed";
  }
  // Succeeded under this or a newer live endpoint for the same session.
  const current = sessionEndpoints.get(sessionId);
  return current && !current.suspended ? "delivered" : "failed";
}

/**
 * "delivered" once Pi has persisted a result it was handed at its boundary,
 * under this or a newer live endpoint. "missed" when the turn ended or the host
 * settled without it, or the wait was cancelled; the marker then stays.
 */
async function confirmInsertion(endpoint: SessionDeliveryEndpoint, deliveryId: string): Promise<Attempt> {
  try {
    if ((await endpoint.host?.awaitInsertion(deliveryId)) !== "persisted") return "missed";
  } catch {
    return "missed";
  }
  const current = sessionEndpoints.get(endpoint.sessionId);
  return current && !current.suspended ? "delivered" : "missed";
}

function retryLater(manager: WorkflowManager, runId: string, sessionId: string, generation: number): void {
  scheduleDeliveryRetry(runId, sessionId, generation, (endpoint) =>
    flushSessionDiskPending(manager, sessionId, endpoint),
  );
}

/** Clear a confirmed delivery's marker. A failed clear is remembered, so its retry clears without sending again. */
function clearConfirmedDelivery(
  manager: WorkflowManager,
  runId: string,
  deliveryId: string,
  endpoint: SessionDeliveryEndpoint,
  run?: ManagedRun,
): ClearPendingResult {
  const clear = clearRunPending(manager, runId, deliveryId, run ?? manager.getRun(runId));
  if (clear === "failed") {
    deliveredAwaitingClear.set(runId, { deliveryId, sessionId: endpoint.sessionId, generation: endpoint.generation });
    retryLater(manager, runId, endpoint.sessionId, endpoint.generation);
  } else {
    deliveredAwaitingClear.delete(runId);
    cancelDeliveryRetry(runId);
  }
  return clear;
}

/**
 * A rebind or session handoff may have flushed while this send held the lock,
 * skipping the run. After either outcome, including a confirmed stale send,
 * flush the owner's live endpoint when it is not the one this send used.
 */
function handOffToOwner(manager: WorkflowManager, runId: string, endpoint: SessionDeliveryEndpoint): void {
  const run = manager.getRun(runId);
  const owner = run
    ? resolveDeliverySessionId(run, manager)
    : (manager.getPersistence().loadPreview(runId)?.sessionId ?? endpoint.sessionId);
  const current = owner ? sessionEndpoints.get(owner) : undefined;
  if (current && current !== endpoint && !current.suspended && current.manager) {
    flushSessionDiskPending(current.manager, current.sessionId, current);
  }
}

/**
 * Wait, under the run's in-flight lock, for the delivery's outcome, then
 * settle the marker on the endpoint that carried it: clear it after a
 * confirmed delivery, retry on a timer after a failed send, and offer it again
 * at once after a missed insertion (a busy host sends nothing, so it waits for
 * the next boundary). A replaced, suspended, or dropped endpoint settles
 * nothing; its successor's flush, or the hand-off, delivers the marker instead.
 */
async function settleDelivery(
  manager: WorkflowManager,
  runId: string,
  endpoint: SessionDeliveryEndpoint,
  deliveryId: string,
  token: number,
  attempt: Promise<Attempt>,
  run?: ManagedRun,
): Promise<void> {
  let outcome: Attempt;
  try {
    outcome = await attempt;
  } finally {
    // Everything after the outcome is synchronous, so releasing here admits no
    // concurrent send, and lets a flush below start this run's next one.
    releaseDelivery(runId, token);
  }

  const live = sessionEndpoints.get(endpoint.sessionId) === endpoint && !endpoint.suspended;
  if (!live) {
    cancelDeliveryRetry(runId);
  } else if (outcome === "failed") {
    retryLater(manager, runId, endpoint.sessionId, endpoint.generation);
  } else if (outcome === "missed") {
    flushSessionDiskPending(manager, endpoint.sessionId, endpoint);
  } else if (clearConfirmedDelivery(manager, runId, deliveryId, endpoint, run) === "stale" && endpoint.manager) {
    // This delivery belonged to an older marker; deliver the newer one now.
    flushSessionDiskPending(endpoint.manager, endpoint.sessionId, endpoint);
  }
  handOffToOwner(manager, runId, endpoint);
}

/**
 * The last stop for anything a delivery's settlement throws, such as a run
 * record that has become unreadable. Only a confirmed clear removes a marker,
 * so the result is still pending: report it and retry on the session's live
 * endpoint, which may be a rebind whose own flush skipped the locked run.
 * Never throws.
 */
function keepPending(manager: WorkflowManager, runId: string, sessionId: string, error: unknown): void {
  warnDelivery(sessionId, `Workflow ${runId}: result remains pending: ${errorMessage(error)}`);
  const endpoint = sessionEndpoints.get(sessionId);
  if (endpoint && !endpoint.suspended) retryLater(manager, runId, sessionId, endpoint.generation);
}

/**
 * The live endpoint a result may go out on, or undefined when it must not go
 * out now: the run's result is already in flight, the endpoint is gone or
 * suspended, or the result was confirmed and only its marker clear was left
 * (done here).
 */
function endpointForDelivery(
  manager: WorkflowManager,
  runId: string,
  sessionId: string,
  deliveryId: string,
  run?: ManagedRun,
): SessionDeliveryEndpoint | undefined {
  if (inFlightDeliveries.has(runId)) return undefined;
  const endpoint = sessionEndpoints.get(sessionId);
  if (!endpoint || endpoint.suspended) return undefined;

  // Already confirmed on this endpoint generation: only the marker clear is left.
  const delivered = deliveredAwaitingClear.get(runId);
  if (
    delivered?.deliveryId === deliveryId &&
    delivered.sessionId === sessionId &&
    delivered.generation === endpoint.generation
  ) {
    clearConfirmedDelivery(manager, runId, deliveryId, endpoint, run);
    return undefined;
  }
  return endpoint;
}

function deliverAndAck(
  manager: WorkflowManager,
  runId: string,
  sessionId: string,
  content: string,
  deliveryId: string,
  run?: ManagedRun,
): void {
  const endpoint = endpointForDelivery(manager, runId, sessionId, deliveryId, run);
  if (!endpoint) return;

  // Fail closed without a send, and without taking the lock: a synchronous
  // rebind + flush (e.g. the probe retry on the next session_start) must not be
  // locked out by a microtask that has not run yet.
  if (typeof endpoint.send !== "function") {
    warnDelivery(
      sessionId,
      `[workflow-delivery] delivery for ${runId} deferred: endpoint for session ${sessionId} has no thenable send function`,
    );
    return;
  }
  // A busy host is never sent to. Its marker is durable; the result goes in at
  // the end of the host's current turn or when the host reports it is idle,
  // with no timer.
  if (endpoint.host?.isBusy()) return;

  const token = takeLock(runId);
  void settleDelivery(
    manager,
    runId,
    endpoint,
    deliveryId,
    token,
    sendToIdleHost(endpoint, content, deliveryId),
    run,
  ).catch((error: unknown) => keepPending(manager, runId, sessionId, error));
}

/**
 * Take a ready result for the host's turn_end boundary. Returns true when the
 * caller must hand it to Pi as a boundary entry: the run is locked and settles
 * once Pi has persisted the entry or passed the boundary without it. False when
 * nothing is to be inserted: the host cannot confirm its history (so the
 * result stays pending, never inserted blind), already holds the result (only
 * the clear is left), or the result is already in flight.
 */
export function claimInsertion(manager: WorkflowManager, sessionId: string, ready: ReadyDelivery): boolean {
  const { runId, deliveryId, run } = ready;
  const endpoint = endpointForDelivery(manager, runId, sessionId, deliveryId, run);
  const host = endpoint?.host;
  if (!endpoint || !host) return false;

  const held = host.hasDelivery(deliveryId);
  if (held === undefined) return false;
  const token = takeLock(runId);
  const attempt = held ? Promise.resolve<Attempt>("delivered") : confirmInsertion(endpoint, deliveryId);
  void settleDelivery(manager, runId, endpoint, deliveryId, token, attempt, run).catch((error: unknown) =>
    keepPending(manager, runId, sessionId, error),
  );
  return !held;
}

/**
 * Deliver a live background run's result: save the marker first so a crash or
 * a missing endpoint cannot lose it, then send only through the originating
 * session's endpoint.
 */
export function routeBackgroundDelivery(
  manager: WorkflowManager,
  run: ManagedRun,
  marker: PendingDeliveryMarker,
  content: string,
): void {
  const pending = markRunPending(run, marker);
  const deliveryId = pending.deliveryId;
  if (!deliveryId) return;
  const saved = persistRunPending(manager, run, "notification");
  if (saved === "deleted") {
    abandonDeletedDelivery(run.runId, run);
    return;
  }

  const sessionId = resolveDeliverySessionId(run, manager);
  if (!sessionId) return;

  if (saved === "failed") {
    const endpoint = sessionEndpoints.get(sessionId);
    if (endpoint && !endpoint.suspended) retryLater(manager, run.runId, sessionId, endpoint.generation);
    return;
  }

  deliverAndAck(manager, run.runId, sessionId, content, deliveryId, run);
}

/**
 * Every result still pending for a session, oldest first: from live runs and
 * from disk. Each has its marker made durable and its text rendered; one that
 * cannot be (a run another process deleted, a record that stays unwritable) is
 * left out and reported.
 */
export function readyDeliveries(
  manager: WorkflowManager,
  sessionId: string,
  endpoint: SessionDeliveryEndpoint,
): ReadyDelivery[] {
  const ready: ReadyDelivery[] = [];

  const prepare = (runId: string, marker: PendingDeliveryMarker, run?: ManagedRun, persisted?: PersistedRunState) => {
    if (inFlightDeliveries.has(runId)) return;
    // A live run re-persists its marker; a disk-only run only needs a missing id.
    const identified = run ? markRunPending(run, marker) : markerWithId(marker);
    const saved = run
      ? persistRunPending(manager, run, "retry")
      : identified === marker
        ? "saved"
        : persistDiskMarker(manager, runId, identified);
    if (saved === "deleted") {
      abandonDeletedDelivery(runId, run);
      return;
    }
    if (saved === "stale") {
      // A newer execution elsewhere owns the record's delivery; the disk pass
      // below delivers that one from the record.
      if (run) run.pendingDelivery = undefined;
      return;
    }
    if (saved === "failed") {
      if (run) retryLater(manager, runId, sessionId, endpoint.generation);
      else warnDelivery(sessionId, `Workflow ${runId}: delivery deferred because its marker could not be saved.`);
      return;
    }
    const deliveryId = identified.deliveryId;
    if (!deliveryId) return;
    const content = renderPendingText?.(manager, runId, identified, endpoint.loadSettings, run, persisted);
    if (content === undefined) return;
    ready.push({ runId, deliveryId, content, run });
  };

  // Live in-memory runs this session owns by their record. A run nobody owns is
  // claimable only from this manager's own live runs (completions before the
  // first bind), never from a foreign manager.
  // One failing run must not keep the others from going out.
  const tryEach = (collect: () => void) => {
    try {
      collect();
    } catch {
      // A run another process just deleted, or whose record is unreadable, is skipped.
    }
  };
  for (const run of manager.listLiveRuns()) {
    if (!run.pendingDelivery) continue;
    tryEach(() => {
      if (claimRunSession(manager.getPersistence(), run, sessionId) !== sessionId) return;
      if (run.pendingDelivery) prepare(run.runId, run.pendingDelivery, run);
    });
  }

  // Disk runs, including terminal runs already evicted from memory. Require an
  // exact sessionId match: claiming null-sessionId rows would race a second
  // manager on the same cwd. Session handoff re-homes earlier pendings first.
  try {
    for (const state of manager.getPersistence().list()) {
      if (!state.pendingDelivery) continue;
      if (state.sessionId !== sessionId) continue;
      // Skip if the live copy still carries the marker — the loop above owns it.
      const live = manager.getRun(state.runId);
      if (live?.pendingDelivery) continue;
      // Only an execution holding the lease is newer than the record. A settled
      // copy may predate a resume another process ran, so the record renders.
      const pending = state.pendingDelivery;
      tryEach(() => prepare(state.runId, pending, live?.lease ? live : undefined, state));
    }
  } catch {
    // best-effort
  }
  return ready.sort(byIssueOrder);
}

/** Deliver every result still pending for a session, oldest first, as far as its host allows. */
export function flushSessionDiskPending(
  manager: WorkflowManager,
  sessionId: string,
  endpoint: SessionDeliveryEndpoint,
): void {
  if (endpoint.suspended) return;
  for (const { runId, content, deliveryId, run } of readyDeliveries(manager, sessionId, endpoint)) {
    deliverAndAck(manager, runId, sessionId, content, deliveryId, run);
  }
}

/** @internal test helper — drop every in-flight lock. */
export function _resetDeliveryDispatchForTests(): void {
  inFlightDeliveries.clear();
  inFlightSeq = 0;
}
