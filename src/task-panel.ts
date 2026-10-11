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
 * endpoint, and cleared only after that send is confirmed. A missing or
 * suspended endpoint leaves it pending; nothing falls back to pi.sendMessage.
 *
 * The internals live in ./task-panel/: panel rendering, session endpoints, host
 * send capture, pending markers, retries, and dispatch.
 */

import { AgentSession, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fmtCost, fmtTokenSegment, tokenFigures } from "./display.js";
import type { PendingDeliveryMarker, PersistedRunState } from "./run-persistence.js";
import { fmtTokensShort } from "./task-panel/compact-format.js";
import {
  _resetDeliveryDispatchForTests,
  flushSessionDiskPending,
  routeBackgroundDelivery,
  setPendingTextRenderer,
} from "./task-panel/delivery-dispatch.js";
import {
  type DeliverySend,
  resolveDeliverySessionId,
  type SessionDeliveryEndpoint,
  sessionEndpoints,
} from "./task-panel/delivery-endpoints.js";
import { _resetDeliveryRetriesForTests, cancelSessionRetries } from "./task-panel/delivery-retry.js";
import {
  _resetHostSendCaptureForTests,
  boundSessionSends,
  cancelUnsentWaiters,
  captureHostSessionSend,
  type StealCandidate,
} from "./task-panel/host-send-capture.js";
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
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowSettings } from "./workflow-settings.js";

export interface TaskPanelOptions {
  storage?: WorkflowStorage;
  cwd?: string;
  /**
   * Live settings loader. When provided, the panel reads it fresh (with a short
   * TTL cache) on each render so `/workflows-progress` takes effect without a
   * restart. Omitted in tests / minimal hosts → always compact.
   */
  loadSettings?: () => WorkflowSettings;
}

// ─── Live panel ────────────────────────────────────────────────────────────────

/**
 * Install the live "workflows running" panel below the editor. It redraws on
 * every manager event and is informational only — the user opens the navigator
 * with /workflows. The unused `_pi` keeps the public signature stable.
 */
export function installTaskPanel(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: TaskPanelOptions = {},
): void {
  ui.setWidget("workflow-tasks", panelWidget(manager, opts.loadSettings), { placement: "belowEditor" });
}

// ─── Delivered messages ────────────────────────────────────────────────────────

/** The message delivered when a background run completes, ending with a pointer to the full result. */
export function deliverText(run: ManagedRun, opts: { resultPath?: string; maxChars?: number } = {}): string {
  const summary = summarizeResult(run.result?.result, opts.maxChars);
  const tu = run.result?.tokenUsage;
  const cost = tu?.cost ? ` · ${fmtCost(tu.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(tu), fmtTokensShort);
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

// ─── Host session hooks ────────────────────────────────────────────────────────

/**
 * Custom type of the capture-only probe sent through pi.sendMessage. The patched
 * sendCustomMessage swallows it, so nothing is appended, persisted, or turned.
 */
export const DELIVERY_PROBE_CUSTOM_TYPE = "workflow-delivery-probe";

/** Sessions whose probe captured a send. A failed probe stays unmarked and is retried on the next bind. */
const probedSessionIds = new Set<string>();

/**
 * A session constructed before the prototype patch (e.g. the one running when
 * the extension reloads) was never captured at construction, and may not send
 * a custom message on its own. One probe through pi.sendMessage forces the
 * capture: the host's void wrapper calls the live session's sendCustomMessage
 * synchronously, and the patch captures that receiver before this returns. A
 * pi.sendMessage that still throws during early startup leaves the session
 * unmarked, so the next bind probes again.
 */
function probeHostSessionSend(pi: ExtensionAPI, sessionId: string): void {
  if (probedSessionIds.has(sessionId)) return;
  try {
    pi.sendMessage({ customType: DELIVERY_PROBE_CUSTOM_TYPE, content: "", display: false }, { triggerTurn: false });
  } catch {
    // Best-effort; the bind stays fail-closed without a captured send.
    return;
  }
  if (boundSessionSends.has(sessionId)) probedSessionIds.add(sessionId);
}

let hostAgentSession = AgentSession;
const patchedSessionPrototypes = new WeakSet<object>();

/** Bind delivery capture to the host loader's class, not a sibling SDK peer. */
export function installHostSessionCapture(sessionClass: typeof AgentSession): void {
  hostAgentSession = sessionClass;
  patchAgentSessionCapture();
}

/**
 * Patch the host AgentSession so every host session's Promise-returning
 * sendCustomMessage is captured. bindCore's `actions.sendMessage` is
 * fire-and-forget and must never be treated as an ACK channel.
 */
function patchAgentSessionCapture(): void {
  try {
    const proto = hostAgentSession.prototype as unknown as StealCandidate;
    if (patchedSessionPrototypes.has(proto)) return;
    const original = proto.sendCustomMessage;
    // AgentSession shape changed: delivery stays fail-closed without a capture.
    if (typeof original !== "function") return;
    patchedSessionPrototypes.add(proto);
    // Primary hook: `_bindExtensionCore` runs at session construction, before
    // any extension code, so a new session is captured without a probe.
    if (typeof proto._bindExtensionCore === "function") {
      const bindCore = proto._bindExtensionCore;
      proto._bindExtensionCore = function patchedBindExtensionCore(this: StealCandidate, ...args: unknown[]) {
        try {
          captureHostSessionSend(this, false);
        } catch {
          // never break session construction
        }
        return bindCore.apply(this, args);
      };
    }
    // Forward with the live session as receiver. A `.bind(proto)` forward would
    // freeze `this` to the prototype (a bound function ignores `.call(this, …)`),
    // so `this.agent` would be undefined and every non-trigger send would reject.
    proto.sendCustomMessage = function patchedSendCustomMessage(
      this: StealCandidate,
      message: { customType: string; content: string; display: boolean },
      options: { triggerTurn: boolean; deliverAs: "followUp" },
    ) {
      const isProbe = message?.customType === DELIVERY_PROBE_CUSTOM_TYPE;
      try {
        captureHostSessionSend(this, isProbe);
      } catch {
        // never break the host send
      }
      // The probe exists only to trip this capture: never append it to the
      // agent state, write a session entry, or start a turn.
      if (isProbe) return Promise.resolve();
      return original.call(this, message, options);
    };
  } catch {
    // AgentSession unavailable: delivery stays fail-closed without a capture.
  }
}

// ─── Session endpoints ─────────────────────────────────────────────────────────

/**
 * Register or refresh the delivery endpoint for a pi session, then flush what is
 * pending for that session only. Requires a confirming send (the captured host
 * sendCustomMessage, or `stableSend` in tests); a durable
 * appendCustomMessageEntry is not an ACK because it starts no turn.
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
    /** Explicit confirming send (tests / DI); wins over the captured send. */
    stableSend?: DeliverySend;
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
  patchAgentSessionCapture();

  // Refuse to bind when the session manager reports a different session.
  try {
    const liveId = opts.sessionManager?.getSessionId?.();
    if (liveId && liveId !== sessionId) return;
  } catch {
    // getSessionId unavailable — continue
  }

  let send = opts.stableSend ?? boundSessionSends.get(sessionId);
  if (!send) {
    probeHostSessionSend(pi, sessionId);
    send = boundSessionSends.get(sessionId);
  }

  const prev = sessionEndpoints.get(sessionId);
  // Already-started sends keep their lock until they settle: a reload is not an
  // SDK abort barrier.
  cancelUnsentWaiters(sessionId, "session delivery rebound before send");
  const endpoint: SessionDeliveryEndpoint = {
    sessionId,
    send,
    loadSettings: opts.loadSettings ?? prev?.loadSettings,
    suspended: false,
    generation: (prev?.generation ?? 0) + 1,
    manager: opts.manager ?? prev?.manager,
    reportWarning: opts.reportWarning ?? prev?.reportWarning,
  };
  sessionEndpoints.set(sessionId, endpoint);

  if (endpoint.manager) flushSessionDiskPending(endpoint.manager, sessionId, endpoint);
}

/**
 * Suspend delivery for a session. Completions only mark disk pending until
 * {@link bindSessionDelivery} / {@link resumeSessionDelivery} runs again.
 */
export function suspendSessionDelivery(sessionId: string | undefined): void {
  if (!sessionId) return;
  const endpoint = sessionEndpoints.get(sessionId);
  if (endpoint) endpoint.suspended = true;
  cancelUnsentWaiters(sessionId, "session delivery suspended");
  cancelSessionRetries(sessionId);
}

/**
 * Forget a session that will not come back (quit / discard, or the old id after
 * a successful replacement bind). Releases the AgentSession closure held by its
 * captured send; pending markers stay on disk.
 */
export function dropSessionDelivery(sessionId: string | undefined): void {
  if (!sessionId) return;
  suspendSessionDelivery(sessionId);
  forgetAwaitingClear(sessionId);
  sessionEndpoints.delete(sessionId);
  boundSessionSends.delete(sessionId);
  // The id may be bound again later; let that bind probe afresh.
  probedSessionIds.delete(sessionId);
}

/**
 * Unsuspend and flush one session's pending deliveries (disk). Prefer
 * {@link bindSessionDelivery} on session_start (also refreshes send).
 */
export function resumeSessionDelivery(sessionId: string | undefined, manager?: WorkflowManager): void {
  if (!sessionId) return;
  const endpoint = sessionEndpoints.get(sessionId);
  if (!endpoint) return;
  endpoint.suspended = false;
  if (manager) endpoint.manager = manager;
  if (endpoint.manager) flushSessionDiskPending(endpoint.manager, sessionId, endpoint);
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

/**
 * Unsuspend and flush queued deliveries for the manager's bound session.
 * Must run only after Pi has finished bindCore (i.e. from session_start).
 * Prefer {@link bindSessionDelivery} which also captures a fresh stable send.
 */
export function resumeResultDelivery(manager: WorkflowManager): void {
  resumeSessionDelivery(manager.getSessionId(), manager);
}

// ─── Result delivery ───────────────────────────────────────────────────────────

type DeliveryManager = WorkflowManager & {
  __deliveryInstalled?: boolean;
  /** Last loadSettings seen on install — used when binding endpoints. */
  __deliveryLoadSettings?: () => WorkflowSettings;
};

function deliveryManager(manager: WorkflowManager): DeliveryManager {
  return manager as DeliveryManager;
}

// turn_end is registered once per ExtensionAPI instance (pi.on has no off()), and
// each handler looks up that instance's latest manager: several live pi
// instances can interleave installs, and a cross-project rebuild must not stack
// another handler.
let turnEndDeliveryManagers = new WeakMap<ExtensionAPI, { manager: WorkflowManager }>();

/**
 * When a background run finishes, fails, or pauses for the model, deliver it
 * into the originating conversation and continue the turn so the assistant can
 * act on it, without blocking the user meanwhile:
 *
 *  - Delivery is routed by `run.sessionId` through the session endpoints.
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle.
 *  - `deliverAs: "followUp"` queues behind an in-flight turn — never interrupts.
 *  - The durable pending marker clears only after the send is confirmed.
 *
 * Idempotent per manager. Across session replacement the manager and these
 * listeners survive via the handoff path; each new session calls
 * {@link bindSessionDelivery} on session_start.
 */
export function installResultDelivery(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: { loadSettings?: () => WorkflowSettings } = {},
): void {
  const m = deliveryManager(manager);
  m.__deliveryLoadSettings = opts.loadSettings;
  patchAgentSessionCapture();

  // After each turn, bind the session if its send was not captured yet, then
  // flush whatever is still pending for it.
  const existingTurnEnd = turnEndDeliveryManagers.get(pi);
  if (existingTurnEnd) {
    existingTurnEnd.manager = manager;
  } else {
    turnEndDeliveryManagers.set(pi, { manager });
    pi.on?.("turn_end", (_event: unknown, ctx?: { sessionManager?: { getSessionId?: () => string } }) => {
      const activeManager = turnEndDeliveryManagers.get(pi)?.manager;
      if (!activeManager) return;
      const active = deliveryManager(activeManager);
      let sid: string | undefined;
      try {
        sid = ctx?.sessionManager?.getSessionId?.() ?? activeManager.getSessionId?.();
      } catch {
        sid = activeManager.getSessionId?.();
      }
      if (!sid) return;

      let endpoint = sessionEndpoints.get(sid);
      if (!endpoint || typeof endpoint.send !== "function") {
        probeHostSessionSend(pi, sid);
        if (boundSessionSends.get(sid)) {
          bindSessionDelivery(sid, pi, {
            loadSettings: active.__deliveryLoadSettings,
            manager: activeManager,
            sessionManager: ctx?.sessionManager,
          });
          endpoint = sessionEndpoints.get(sid);
        }
      }

      if (endpoint && !endpoint.suspended && endpoint.manager) {
        flushSessionDiskPending(endpoint.manager, sid, endpoint);
      }
    });
  }

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

  if (m.__deliveryInstalled) return;
  m.__deliveryInstalled = true;

  manager.on("complete", ({ runId }: { runId: string }) => {
    const run = manager.getRun(runId);
    if (!run) return;
    const sessionId = resolveDeliverySessionId(run, manager);
    const endpoint = sessionId ? sessionEndpoints.get(sessionId) : undefined;
    const content = deliverText(run, {
      resultPath: persistedResultPath(manager, runId, run.result?.result),
      maxChars: deliveredMaxChars(endpoint?.loadSettings ?? m.__deliveryLoadSettings),
    });
    routeBackgroundDelivery(manager, run, { kind: "complete" }, content);
  });

  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    const run = manager.getRun(runId);
    if (!run) return;
    const text = failedRunText(runId, error);
    routeBackgroundDelivery(manager, run, { kind: "text", text }, text);
  });

  // Two pauses need the model: a provider usage limit (the run is resumable once
  // the limit resets, not dead) and a script waiting at a durable checkpoint (it
  // stays paused until someone answers). A manual pause() carries no reason and
  // is the user's own action, so it delivers nothing.
  manager.on("paused", (event: PausedEvent) => {
    const run = manager.getRun(event.runId);
    if (!run) return;
    const text = pausedRunText(event);
    if (text) routeBackgroundDelivery(manager, run, { kind: "text", text }, text);
  });
}

// ─── Test helpers ──────────────────────────────────────────────────────────────

/** @internal test helper — reset process-wide delivery registries between cases. */
export function _resetDeliveryRegistriesForTests(): void {
  _resetHostSendCaptureForTests();
  _resetDeliveryDispatchForTests();
  _resetDeliveryRetriesForTests();
  deliveredAwaitingClear.clear();
  sessionEndpoints.clear();
  probedSessionIds.clear();
  turnEndDeliveryManagers = new WeakMap<ExtensionAPI, { manager: WorkflowManager }>();
}

/** @internal test helper — register a confirming session send directly. */
export function _registerBoundSessionSendForTests(sessionId: string, send: DeliverySend): void {
  boundSessionSends.set(sessionId, send);
}

/** @internal test helper — capture a host-shaped session as the prototype patch would. */
export function _registerHostSessionForTests(session: StealCandidate): void {
  captureHostSessionSend(session);
}

/** @internal test helper — inspect which session ids currently hold a captured send. */
export function _getStealMapForTests(): ReadonlyMap<string, DeliverySend> {
  return boundSessionSends;
}

/** @internal test helper — inspect whether a session is marked successfully probed. */
export function _isProbedForTests(sessionId: string): boolean {
  return probedSessionIds.has(sessionId);
}

/** @internal test helper — inspect a session's endpoint state. */
export function _getSessionDeliveryEndpointForTests(
  sessionId: string,
): { suspended: boolean; generation: number; hasSend: boolean; hasAppend: boolean } | undefined {
  const ep = sessionEndpoints.get(sessionId);
  if (!ep) return undefined;
  return {
    suspended: ep.suspended,
    generation: ep.generation,
    hasSend: typeof ep.send === "function",
    // Append is never an ACK; the field stays so the inspected shape is unchanged.
    hasAppend: false,
  };
}
