/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep
 *    working. It is informational; /workflows opens the full navigator.
 *  - When a background run finishes, fails, or pauses for the model, the result
 *    is delivered back into the conversation that started it, so the paused task
 *    continues with the outcome.
 *
 * Delivery is routed per session because Pi's ExtensionRunner.bindCore() stores
 * `runtime.sendMessage` on a runtime object shared by every session: the session
 * constructed last wins, so pi.sendMessage at completion time would land in
 * whichever session was built last. Instead each session binds an endpoint that
 * holds its own host AgentSession.sendCustomMessage, which returns a real
 * Promise (actions.sendMessage is void and swallows rejections). A result is
 * saved as a pending marker first, sent only through its run's session
 * endpoint, and cleared only after the session file holds it. A missing or
 * suspended endpoint leaves it pending; nothing falls back to pi.sendMessage.
 *
 * A busy session is never sent to: its results queue as durable markers and go
 * in, oldest first, when the model's current response (and its tool calls) is
 * complete, at Pi's turn_end boundary, so the agent loop's next request already
 * carries them. A run that ends without such a turn (an abort) delivers as soon
 * as the host reports it is idle.
 *
 * The internals live in ./task-panel/: panel rendering, session endpoints, host
 * session capture and link, pending markers, retries, dispatch, and the boundary.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fmtCompact, fmtCost, fmtTokenSegment, tokenFigures } from "./display.js";
import { errorMessage } from "./errors.js";
import type { PendingDeliveryMarker, PersistedRunState } from "./run-persistence.js";
import { _resetTurnBoundaryForTests, type BindHost, installTurnBoundary } from "./task-panel/delivery-boundary.js";
import {
  _resetDeliveryDispatchForTests,
  flushSessionDiskPending,
  routeBackgroundDelivery,
  setPendingTextRenderer,
} from "./task-panel/delivery-dispatch.js";
import {
  clearEndpoints,
  type DeliverySend,
  removeEndpoint,
  replaceEndpoint,
  resolveDeliverySessionId,
  type SessionDeliveryEndpoint,
  sessionEndpoints,
  warnDelivery,
} from "./task-panel/delivery-endpoints.js";
import { _resetDeliveryRetriesForTests, cancelSessionRetries } from "./task-panel/delivery-retry.js";
import { _resetHostSessionCaptureForTests, captureHostLink } from "./task-panel/host-session-capture.js";
import { _resetHostLinksForTests, cancelInsertionWaits, type HostSessionLink } from "./task-panel/host-session-link.js";
import { panelWidget } from "./task-panel/panel-widget.js";
import { deliveredAwaitingClear, forgetAwaitingClear } from "./task-panel/pending-markers.js";
import {
  deliveredMaxChars,
  failedRunText,
  type PausedEvent,
  pausedRunText,
  persistedResultPath,
  summarizeResult,
} from "./task-panel/result-text.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowSettings } from "./workflow-settings.js";

// ─── Live panel ────────────────────────────────────────────────────────────────

/**
 * Install the live "workflows running" panel below the editor. It redraws on
 * every manager event and is informational only — the user opens the navigator
 * with /workflows. `loadSettings` is read fresh (with a short TTL cache) on each
 * render, so `/workflows-progress` takes effect without a restart; without it
 * the panel is always compact.
 */
export function installTaskPanel(
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  loadSettings?: () => WorkflowSettings,
): void {
  ui.setWidget("workflow-tasks", panelWidget(manager, loadSettings), { placement: "belowEditor" });
}

// ─── Delivered messages ────────────────────────────────────────────────────────

/** The message delivered when a background run completes, ending with a pointer to the full result. */
export function deliverText(run: ManagedRun, opts: { resultPath?: string; maxChars?: number } = {}): string {
  const summary = summarizeResult(run.result?.result, opts.maxChars);
  const tu = run.result?.tokenUsage;
  const cost = tu?.cost ? ` · ${fmtCost(tu.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(tu), fmtCompact);
  const tokens = `${segment ? ` · ${segment}` : ""}${cost}`;
  const agents = run.result?.agentCount ?? run.snapshot.agentCount;
  const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
  const lines = [
    `✓ Background workflow "${run.snapshot.name}" finished (${agents} agents${tokens}${duration}).`,
    "",
    summary,
  ];
  // Always point at the full persisted result so the tail is never lost — even when
  // the summary above is a complete verdict/summary field or an untruncated dump.
  if (opts.resultPath) lines.push("", `↳ Full result: ${opts.resultPath}`);
  return lines.join("\n");
}

/** Message for a pending marker; a complete result is rebuilt from the live run or its record. */
function pendingResultText(
  manager: WorkflowManager,
  runId: string,
  marker: PendingDeliveryMarker,
  loadSettings?: () => WorkflowSettings,
  run?: ManagedRun,
  persisted?: PersistedRunState,
): string | undefined {
  if (marker.kind === "text") return marker.text;
  if (run) {
    return deliverText(run, {
      resultPath: persistedResultPath(manager, runId, run.result?.result),
      maxChars: deliveredMaxChars(loadSettings),
    });
  }
  if (persisted) {
    return deliverText(
      {
        snapshot: { name: persisted.workflowName, agentCount: persisted.agents?.length ?? 0 },
        result: {
          result: persisted.result,
          tokenUsage: persisted.tokenUsage,
          agentCount: persisted.agents?.length ?? 0,
          durationMs: persisted.durationMs,
        },
      } as ManagedRun,
      {
        resultPath: persistedResultPath(manager, runId, persisted.result),
        maxChars: deliveredMaxChars(loadSettings),
      },
    );
  }
  return undefined;
}

setPendingTextRenderer(pendingResultText);

// ─── Session endpoints ─────────────────────────────────────────────────────────

/**
 * Register or refresh the delivery endpoint for a pi session, then flush what is
 * pending for that session only. Requires a confirming send: the host session
 * `pi` is bound to, captured afresh on every bind, or `stableSend`. A durable
 * appendCustomMessageEntry is not an ACK because it starts no turn. The endpoint
 * also listens for the host's idle signal, which flushes whatever a busy host
 * made wait.
 *
 * Call from session_start, after Pi's bindCore.
 */
export function bindSessionDelivery(
  sessionId: string,
  pi: ExtensionAPI,
  opts: {
    loadSettings?: () => WorkflowSettings;
    /** UI-safe, rate-limited warning for actionable delivery failures only. */
    reportWarning?: (message: string) => void;
    manager?: WorkflowManager;
    /** A bare confirming send (a test double); skips the capture. It has no host, so it is never busy. */
    stableSend?: DeliverySend;
    /** A host link already in hand (captured earlier); skips the capture. */
    host?: HostSessionLink;
    /** Used only to check the session identity; its append is not an ACK channel. */
    sessionManager?: {
      getSessionId?: () => string;
      appendCustomMessageEntry?: (
        customType: string,
        content: string | unknown[],
        display: boolean,
        details?: unknown,
      ) => string;
    };
  } = {},
): void {
  if (!sessionId) return;

  // Refuse to bind when the session manager reports a different session.
  try {
    const liveId = opts.sessionManager?.getSessionId?.();
    if (liveId && liveId !== sessionId) return;
  } catch {
    // getSessionId unavailable — continue
  }

  const host = opts.host ?? (opts.stableSend ? undefined : captureHostLink(pi, sessionId));
  const prev = sessionEndpoints.get(sessionId);
  // Already-started sends keep their lock until they settle: a reload is not an
  // SDK abort barrier. A result handed to Pi's boundary is committed by Pi
  // whatever this does, so its wait is only released to be checked afresh.
  cancelInsertionWaits(sessionId, "session delivery rebound");
  const endpoint: SessionDeliveryEndpoint = {
    sessionId,
    send: opts.stableSend ?? host?.send,
    host,
    loadSettings: opts.loadSettings ?? prev?.loadSettings,
    suspended: false,
    generation: (prev?.generation ?? 0) + 1,
    manager: opts.manager ?? prev?.manager,
    reportWarning: opts.reportWarning ?? prev?.reportWarning,
  };
  replaceEndpoint(endpoint);
  endpoint.unwatch = host?.onIdle(() => flushWhenIdle(endpoint));

  if (endpoint.manager) flushSessionDiskPending(endpoint.manager, sessionId, endpoint);
}

/** The host went idle (a run settled, a compaction ended): deliver what it made wait. Never throws. */
function flushWhenIdle(endpoint: SessionDeliveryEndpoint): void {
  if (sessionEndpoints.get(endpoint.sessionId) !== endpoint || endpoint.suspended || !endpoint.manager) return;
  try {
    flushSessionDiskPending(endpoint.manager, endpoint.sessionId, endpoint);
  } catch (error) {
    warnDelivery(endpoint.sessionId, `Workflow results remain pending: ${errorMessage(error)}`);
  }
}

/**
 * Suspend delivery for a session. Completions only mark disk pending until
 * {@link bindSessionDelivery} runs again.
 */
export function suspendSessionDelivery(sessionId: string | undefined): void {
  if (!sessionId) return;
  const endpoint = sessionEndpoints.get(sessionId);
  if (endpoint) {
    endpoint.suspended = true;
    endpoint.unwatch?.();
  }
  cancelInsertionWaits(sessionId, "session delivery suspended");
  cancelSessionRetries(sessionId);
}

/**
 * Forget a session that will not come back (quit / discard, a stranded handoff,
 * or the old id after a successful replacement bind). Dropping its endpoint
 * releases the host session its captured send holds; pending markers stay on
 * disk.
 */
export function dropSessionDelivery(sessionId: string | undefined): void {
  if (!sessionId) return;
  suspendSessionDelivery(sessionId);
  forgetAwaitingClear(sessionId);
  removeEndpoint(sessionId);
}

/**
 * Stop live sends for the manager's currently bound session. In-flight
 * completions only leave disk pending until the next bind/resume.
 *
 * Call from session_shutdown before handoff or discard, so a completion racing
 * the teardown cannot deliver into the outgoing session.
 */
export function suspendResultDelivery(manager: WorkflowManager): void {
  suspendSessionDelivery(manager.getSessionId());
}

// ─── Result delivery ───────────────────────────────────────────────────────────

/**
 * Managers whose delivery listeners are installed, with the last loadSettings
 * seen on install (used when binding endpoints).
 */
let deliveryInstalls = new WeakMap<WorkflowManager, { loadSettings?: () => WorkflowSettings }>();

/** Binds a session whose host the turn boundary captured only now, with the project's current manager. */
function bindCapturedHost(pi: ExtensionAPI): BindHost {
  return (target, sessionId, host, sessionManager) =>
    bindSessionDelivery(sessionId, pi, {
      loadSettings: target.loadSettings,
      manager: target.manager,
      sessionManager,
      host,
    });
}

/**
 * When a background run finishes, fails, or pauses for the model, deliver it
 * into the originating conversation so the assistant can act on it, without
 * blocking the user meanwhile:
 *
 *  - Delivery goes to the session the run's record names as its owner.
 *  - An idle host gets it at once, and `triggerTurn: true` starts the turn.
 *  - A busy host is never sent to, so a response in flight is never
 *    interrupted. The result waits as a durable marker and is inserted at the
 *    host's turn_end boundary, right after the current response and its tool
 *    calls complete: the agent loop's next request carries it, and a final
 *    response gets one more request to answer it. When the run ends without a
 *    turn that can take it (an abort), the host's idle signal sends it instead.
 *  - Waiting results go out oldest first, together at one boundary.
 *  - The durable pending marker clears only after the session file holds the result.
 *
 * One set of listeners per manager: installing again, from this or a reloaded
 * copy of the module, replaces the previous set. Across session replacement the
 * manager survives via the handoff path; each new session calls
 * {@link bindSessionDelivery} on session_start.
 */
export function installResultDelivery(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: { loadSettings?: () => WorkflowSettings } = {},
): void {
  const install = deliveryInstalls.get(manager) ?? {};
  install.loadSettings = opts.loadSettings;
  deliveryInstalls.set(manager, install);

  // The end of every completed turn: bind the session if its send was not
  // captured yet, then hand Pi the results that waited for the turn to finish.
  installTurnBoundary(pi, { manager, loadSettings: opts.loadSettings }, bindCapturedHost(pi));

  // A newly-created manager can replace the current project while this pi and
  // session endpoint remain live. Refresh only the routing pointers; preserve
  // the session transport, generation, and suspension state until bindCore.
  const sid = manager.getSessionId();
  if (sid) {
    const endpoint = sessionEndpoints.get(sid);
    if (endpoint) {
      endpoint.loadSettings = opts.loadSettings ?? endpoint.loadSettings;
      endpoint.manager = manager;
    }
  }

  replaceDeliveryListeners(manager, [
    [
      "complete",
      ({ runId }: { runId: string }) => {
        const run = manager.getRun(runId);
        if (!run) return;
        const sessionId = resolveDeliverySessionId(run, manager);
        const endpoint = sessionId ? sessionEndpoints.get(sessionId) : undefined;
        const content = deliverText(run, {
          resultPath: persistedResultPath(manager, runId, run.result?.result),
          maxChars: deliveredMaxChars(endpoint?.loadSettings ?? install.loadSettings),
        });
        routeBackgroundDelivery(manager, run, { kind: "complete" }, content);
      },
    ],
    [
      "error",
      ({ runId, error }: { runId: string; error?: { message?: string } }) => {
        const run = manager.getRun(runId);
        if (!run) return;
        const text = failedRunText(runId, error);
        routeBackgroundDelivery(manager, run, { kind: "text", text }, text);
      },
    ],
    // Two pauses need the model: a provider usage limit (the run is resumable
    // once the limit resets, not dead) and a script waiting at a durable
    // checkpoint (it stays paused until someone answers). A manual pause()
    // carries no reason and is the user's own action, so it delivers nothing.
    [
      "paused",
      (event: PausedEvent) => {
        const run = manager.getRun(event.runId);
        if (!run) return;
        const text = pausedRunText(event);
        if (text) routeBackgroundDelivery(manager, run, { kind: "text", text }, text);
      },
    ],
  ]);
}

/**
 * Where a manager keeps its delivery listeners, under a key every loaded copy of
 * this module shares. A host that reloads the module graph hands the same
 * manager to the new copy, whose install then replaces the old copy's listeners
 * instead of stacking a second set that would act on stale module state.
 */
const DELIVERY_LISTENERS = Symbol.for("pi-workflows-lean.result-delivery-listeners");
type DeliveryListener = [event: string, listener: (...args: any[]) => void];

function replaceDeliveryListeners(manager: WorkflowManager, listeners: DeliveryListener[]): void {
  const owner = manager as unknown as { [DELIVERY_LISTENERS]?: DeliveryListener[] };
  for (const [event, listener] of owner[DELIVERY_LISTENERS] ?? []) manager.off(event, listener);
  for (const [event, listener] of listeners) manager.on(event, listener);
  owner[DELIVERY_LISTENERS] = listeners;
}

// ─── Test helpers ──────────────────────────────────────────────────────────────

/** @internal test helper — reset process-wide delivery registries between cases. */
export function _resetDeliveryRegistriesForTests(): void {
  _resetHostLinksForTests();
  _resetHostSessionCaptureForTests();
  _resetDeliveryDispatchForTests();
  _resetDeliveryRetriesForTests();
  deliveredAwaitingClear.clear();
  clearEndpoints();
  _resetTurnBoundaryForTests();
  deliveryInstalls = new WeakMap<WorkflowManager, { loadSettings?: () => WorkflowSettings }>();
}

/** @internal test helper — inspect a session's endpoint state. */
export function _getSessionDeliveryEndpointForTests(
  sessionId: string,
): { suspended: boolean; generation: number; hasSend: boolean } | undefined {
  const ep = sessionEndpoints.get(sessionId);
  if (!ep) return undefined;
  return {
    suspended: ep.suspended,
    generation: ep.generation,
    hasSend: typeof ep.send === "function",
  };
}
