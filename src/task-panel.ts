/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { AgentSession, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { fmtCost, fmtTokenSegment, tokenFigures } from "./display.js";
import { RunRecordDeletedError } from "./errors.js";
import type { PendingDeliveryMarker, PersistedRunState } from "./run-persistence.js";
import { fmtTokensShort, formatBytes } from "./task-panel/compact-format.js";
import { panelWidget } from "./task-panel/panel-widget.js";
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

/** Default cap on the JSON-dump fallback in a delivered result summary. Overridable
 *  via the `deliveredResultMaxChars` setting in ~/.pi/workflows/settings.json. */
const DEFAULT_DELIVERED_MAX_CHARS = 400;

/**
 * Pick a clean human-readable summary from a workflow result, in order of
 * preference: a `verdict`/`report`/`summary`/`synthesis` string field, a bare
 * string result, else a JSON dump capped at `maxChars`. When the dump is truncated the
 * dropped size is reported (the full result is still reachable via the pointer
 * that {@link deliverText} appends).
 */
function summarizeResult(result: unknown, maxChars: number = DEFAULT_DELIVERED_MAX_CHARS): string {
  if (typeof result === "string") return result;
  if (result == null) return "null";
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    for (const key of ["verdict", "report", "summary", "synthesis"] as const) {
      const val = obj[key];
      if (typeof val === "string" && val.trim()) return val;
    }
  }
  const json = JSON.stringify(result, null, 2);
  if (json.length <= maxChars) return json;
  // Slice once (the kept head); derive the dropped size by byte-length subtraction
  // so we don't also allocate the (potentially large) truncated tail to measure it.
  const kept = json.slice(0, maxChars);
  const droppedBytes = Buffer.byteLength(json, "utf8") - Buffer.byteLength(kept, "utf8");
  return `${kept}\n…(truncated ${formatBytes(droppedBytes)})`;
}

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

/** Absolute path to a run's persisted result JSON. Undefined if the persistence
 *  layer can't be resolved — delivery must never throw in the complete handler. */
function persistedResultPath(manager: WorkflowManager, runId: string, result?: unknown): string | undefined {
  try {
    const persistence = manager.getPersistence();
    return persistence.exportResult
      ? persistence.exportResult(runId, result)
      : join(persistence.getRunsDir(), `${runId}.json`);
  } catch {
    return undefined;
  }
}

/** Delivered JSON-dump truncation threshold from settings (already normalized),
 *  defaulting to 400 when unset or unreadable. */
function deliveredMaxChars(opts: { loadSettings?: () => WorkflowSettings }): number {
  try {
    return opts.loadSettings?.().deliveredResultMaxChars ?? DEFAULT_DELIVERED_MAX_CHARS;
  } catch {
    return DEFAULT_DELIVERED_MAX_CHARS;
  }
}

/**
 * Session-routed background result delivery.
 *
 * Root cause (#147): pi-coding-agent's ExtensionRunner.bindCore() writes
 * `runtime.sendMessage` on a shared runtime object (last-bindCore-wins). Calling
 * `pi.sendMessage` at completion time therefore delivers into whichever session
 * was constructed last — not the session that started the workflow. #143 only
 * covered same-manager session *replacement*; parallel sibling sessions steal
 * the route without any shutdown on the origin.
 *
 * Fix: process-wide endpoint registry keyed by sessionId. Each session_start
 * registers a session-stable send captured from the *host* AgentSession's
 * sendCustomMessage (returns a real Promise — unlike actions.sendMessage
 * which is void and swallows rejects). Completions resolve `run.sessionId`,
 * persist a pending marker first, then deliver only via that session's
 * endpoint. Clear the marker only after the send Promise settles successfully.
 * Missing/suspended endpoint or non-thenable send → leave pending (fail
 * closed). Never fall back to shared `pi.sendMessage` / runtime.sendMessage,
 * and never ACK on a durable append (that writes history without triggerTurn).
 */

type DeliveryMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: { deliveryId?: string };
};

type DeliverySend = (message: DeliveryMessage, options: { triggerTurn: boolean; deliverAs: "followUp" }) => unknown;

interface SessionDeliveryEndpoint {
  sessionId: string;
  reportWarning?: (message: string) => void;
  warned?: boolean;
  /**
   * Session-stable send that MUST return a thenable for ACK. Captured from
   * the host AgentSession.sendCustomMessage (not the void actions.sendMessage
   * wrapper, and not a durable-only append).
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

/** Process-wide: one live endpoint per pi session id. */
const sessionEndpoints = new Map<string, SessionDeliveryEndpoint>();

function warnDelivery(sessionId: string | undefined, message: string): void {
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
 * Session-stable thenable sends (host AgentSession.sendCustomMessage). Keyed
 * by host sessionId only — workflow children (in-memory, noExtensions, or
 * named `workflow:…`) must never enter this map (#109).
 */
const boundSessionSends = new Map<string, DeliverySend>();

type InFlightDelivery = { token: number; sessionId: string };

/** Ownership-token locks prevent stale promise chains from releasing newer sends. */
const inFlightDeliveries = new Map<string, InFlightDelivery>();
let inFlightSeq = 0;

const DEFAULT_STREAMING_ACK_TIMEOUT_MS = 60_000;
let streamingAckTimeoutMs = DEFAULT_STREAMING_ACK_TIMEOUT_MS;

interface ActiveStreamingWaiter {
  sessionId: string;
  deliveryId: string;
  hasStarted: () => boolean;
  cancel: (error: Error) => void;
}
const activeStreamingWaiters = new Set<ActiveStreamingWaiter>();

const DELIVERY_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;
type DeliveryRetry = {
  attempt: number;
  generation: number;
  sessionId: string;
  timer?: ReturnType<typeof setTimeout>;
};
const deliveryRetries = new Map<string, DeliveryRetry>();
/** ACKed messages whose pending marker still needs to be cleared durably. */
const deliveredAwaitingClear = new Map<string, { deliveryId: string; sessionId: string; generation: number }>();

/**
 * Custom type for the session bind probe (see probeHostSessionSend). Sent
 * through pi.sendMessage ONLY so the sendCustomMessage capture patch can
 * identify the live host session. Capture-only: the patched sendCustomMessage
 * swallows probe messages — nothing is appended, persisted, or turned.
 */
export const DELIVERY_PROBE_CUSTOM_TYPE = "workflow-delivery-probe";

/**
 * Session ids probed successfully. Marked only after a probe that captured a
 * send; a failed or missed probe stays unmarked and is retried on the next
 * bind.
 */
const probedSessionIds = new Set<string>();

/**
 * Quiet hosts (omp never sends custom messages itself) never trip the
 * AgentSession.prototype patch, so no thenable send is ever captured. One
 * capture-only probe through pi.sendMessage forces it: the host's void wrapper
 * calls the live session's sendCustomMessage synchronously, the prototype patch
 * captures the receiver (never forwarding the probe), and boundSessionSends is
 * populated by the time this returns.
 *
 * Retry-correct: the session is marked probed only when the probe actually
 * captured a send. A host whose pi.sendMessage throws (e.g. "Extension runtime
 * not initialized" during early startup) stays unmarked, so the next
 * bindSessionDelivery probes again instead of being permanently silent.
 */
function probeHostSessionSend(pi: ExtensionAPI, sessionId: string): void {
  if (probedSessionIds.has(sessionId)) return;
  try {
    pi.sendMessage({ customType: DELIVERY_PROBE_CUSTOM_TYPE, content: "", display: false }, { triggerTurn: false });
  } catch {
    // Probe is best-effort; bind stays fail-closed without a captured send.
    // Not marked probed — the next bindSessionDelivery retries.
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

interface StealCandidate {
  sendCustomMessage?: DeliverySend;
  isStreaming?: boolean;
  isIdle?: boolean;
  waitForIdle?: () => Promise<void>;
  agent?: {
    hasQueuedMessages?: () => boolean;
  };
  subscribe?: (
    listener: (event: {
      type?: string;
      message?: { role?: string; customType?: string; details?: unknown };
      followUp?: readonly unknown[];
      steering?: readonly unknown[];
    }) => void,
  ) => () => void;
  sessionManager?: {
    persist?: boolean;
    getSessionId?: () => string;
    getSessionName?: () => string | undefined;
    getEntries?: () => Array<{ type?: string; customType?: string; details?: unknown }>;
    getBranch?: () => Array<{ id?: string; type?: string; customType?: string; details?: unknown }>;
    getSessionFile?: () => string | undefined;
    isPersisted?: () => boolean;
    isSessionOnDisk?: () => boolean;
  };
  _resourceLoader?: { noExtensions?: boolean };
  _bindExtensionCore?: (...args: unknown[]) => unknown;
}

function hostSessionIdToSteal(session: StealCandidate, probe?: boolean): string | undefined {
  const sm = session.sessionManager;
  if (!sm) return undefined;
  if (session._resourceLoader?.noExtensions === true) return undefined;
  try {
    const name = sm.getSessionName?.();
    if (typeof name === "string" && name.startsWith("workflow:")) return undefined;
  } catch {
    // getSessionName unavailable — keep evaluating
  }
  if (typeof session.sendCustomMessage !== "function") return undefined;
  const sid = sm.getSessionId?.();
  // PROBE EXCEPTION: the probe bypasses ONLY this persistence gate; the
  // sessionManager presence, noExtensions, and workflow:-name gates above
  // still apply. Justification: unnamed in-memory workflow children are
  // excluded by noExtensions/isPersisted at the bindCore hook (probe=false),
  // and a probe is only ever sent through the pi.sendMessage of the session
  // running this extension — it cannot reach a foreign or child session. omp
  // print-mode hosts report isSessionOnDisk()===false at session_start
  // (persisted lazily after bind), so the gate must not reject a probe-bearing
  // send (#109).
  if (!probe) {
    try {
      if (typeof sm.isPersisted === "function") {
        if (!sm.isPersisted()) return undefined;
      } else if (typeof sm.isSessionOnDisk === "function") {
        if (!sm.isSessionOnDisk()) return undefined;
      } else if (sm.persist !== true) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return sid;
}

function deliveryIdFromDetails(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const deliveryId = (details as { deliveryId?: unknown }).deliveryId;
  return typeof deliveryId === "string" && deliveryId ? deliveryId : undefined;
}

/** Scan the SDK's JSONL record without allocating the entire session history. */
export function sessionFileContainsEntry(path: string, entry: object): boolean {
  const needle = Buffer.from(`\n${JSON.stringify(entry)}\n`);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    // Incremental scan (audit2 #29): the session file is append-only and the
    // delivery-ACK path re-scans it per check — resume from the last scanned
    // offset (with a needle-length overlap) instead of offset 0. On a tail
    // miss, fall back to one head scan: an entry can precede the cached offset
    // when two deliveries interleave.
    // - needle.length (NOT needle.length-1): the cached offset is one past
    // the last scanned byte and a needle straddling it can start at offset-1,
    // so the tail window must span needle.length bytes from resumeFrom. One
    // byte narrower and a repeat check for an already-present entry always
    // misses the tail and degenerates to a full head scan (r1 M1). An entry
    // followed by later writes still falls back to one head scan — acceptable.
    const resumeFrom = Math.max(0, (sessionScanOffsets.get(path) ?? 0) - needle.length);
    const foundInTail = scanRegion(fd, needle, resumeFrom);
    const end = lseekEnd(fd);
    rememberScanOffset(path, end);
    if (foundInTail) return true;
    if (resumeFrom > 0) return scanRegion(fd, needle, 0, resumeFrom + needle.length - 1);
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Last fully-scanned byte offset per session file (append-only). Bounded:
 * one entry per touched session file; LRU-evicted past 128 (delete+set on
 * every hit keeps the ACK hot path's entries resident). */
const sessionScanOffsets = new Map<string, number>();
const SESSION_SCAN_OFFSETS_CAP = 128;

function rememberScanOffset(path: string, end: number): void {
  sessionScanOffsets.delete(path);
  sessionScanOffsets.set(path, end);
  if (sessionScanOffsets.size > SESSION_SCAN_OFFSETS_CAP) {
    const oldest = sessionScanOffsets.keys().next().value;
    if (oldest !== undefined) sessionScanOffsets.delete(oldest);
  }
}

function lseekEnd(fd: number): number {
  try {
    return fstatSync(fd).size;
  } catch {
    return 0;
  }
}

function scanRegion(fd: number, needle: Buffer, start: number, end?: number): boolean {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = start;
  let tail: Buffer = Buffer.alloc(0);
  for (;;) {
    const budget = end === undefined ? chunk.length : Math.min(chunk.length, end - position);
    if (budget <= 0) return false;
    const count = readSync(fd, chunk, 0, budget, position);
    if (count === 0) return false;
    position += count;
    const window = Buffer.concat([tail, chunk.subarray(0, count)]);
    if (window.indexOf(needle) !== -1) return true;
    tail = window.subarray(Math.max(0, window.length - needle.length + 1));
  }
}

function sessionHasDelivery(session: StealCandidate, deliveryId: string): boolean | undefined {
  const sm = session.sessionManager;
  if (typeof sm?.getBranch !== "function" || typeof sm.getSessionFile !== "function") return undefined;
  try {
    const entries = sm
      .getBranch()
      .filter(
        (entry) =>
          typeof entry.id === "string" &&
          entry.type === "custom_message" &&
          entry.customType === "workflow-result" &&
          deliveryIdFromDetails(entry.details) === deliveryId,
      );
    const file = sm.getSessionFile();
    // getEntries includes abandoned branches; even getBranch can contain a
    // memory-only entry after a failed/lazy persist. Neither alone is an ACK.
    return !!file && entries.some((entry) => sessionFileContainsEntry(file, entry));
  } catch {
    return undefined;
  }
}

function captureHostSessionSend(session: StealCandidate, probe?: boolean): void {
  const sid = hostSessionIdToSteal(session, probe);
  const send = session.sendCustomMessage;
  if (!sid || typeof send !== "function") return;

  boundSessionSends.set(sid, (message, options) => {
    const deliveryId = deliveryIdFromDetails(message.details);
    if (deliveryId && sessionHasDelivery(session, deliveryId) === true) return Promise.resolve();

    if (!deliveryId) {
      return send.call(session, message, options);
    }
    if (typeof session.subscribe !== "function" || sessionHasDelivery(session, deliveryId) === undefined) {
      return Promise.reject(new Error("host cannot confirm workflow result delivery"));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let started = false;
      let waitingForIdle = false;
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        activeStreamingWaiters.delete(waiterRecord);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };

      const waiterRecord: ActiveStreamingWaiter = {
        sessionId: sid,
        deliveryId,
        hasStarted: () => started,
        cancel: (err) => finish(err),
      };
      activeStreamingWaiters.add(waiterRecord);

      if (streamingAckTimeoutMs > 0) {
        timer = setTimeout(() => {
          queueMicrotask(() => {
            if (settled) return;
            if (sessionHasDelivery(session, deliveryId) === true) finish();
            // No host queue item exists before start, so a retry is safe. Once
            // started, never infer non-delivery from elapsed time.
            else if (!started) finish(new Error("timed out waiting for an idle host"));
          });
        }, streamingAckTimeoutMs);
        timer.unref?.();
      }

      unsubscribe =
        session.subscribe?.((event) => {
          if (event.type === "message_end") {
            // A fresh session may flush the input only when its first assistant
            // message completes. Recheck disk, not just the custom input event.
            queueMicrotask(() => {
              if (settled) return;
              const persisted = sessionHasDelivery(session, deliveryId);
              if (persisted === true) finish();
              // A persistence failure is not proof that a started prompt was
              // cancelled. Its send promise remains the failure boundary.
            });
            return;
          }

          if (event.type === "agent_settled" || event.type === "compaction_end") {
            // An unrelated queue_update only describes user text; it cannot
            // establish ownership or consumption of a custom follow-up.
            queueMicrotask(startWhenIdle);
          }
        }) ?? (() => {});

      function startWhenIdle() {
        if (!deliveryId || !send) return;
        if (settled || started) return;
        if (session.isStreaming || session.isIdle === false) {
          if (!waitingForIdle && typeof session.waitForIdle === "function") {
            waitingForIdle = true;
            void session.waitForIdle().then(() => {
              waitingForIdle = false;
              startWhenIdle();
            }, finish);
          }
          return;
        }
        if (session.sessionManager?.getSessionId?.() !== sid) {
          finish(new Error("host session identity changed before delivery"));
          return;
        }
        if (sessionHasDelivery(session, deliveryId) === true) {
          finish();
          return;
        }
        // No await between idle inspection and send: this path never installs
        // a custom message in the host's unobservable follow-up queue.
        started = true;
        if (timer) clearTimeout(timer);
        try {
          const pending = send.call(session, message, options);
          if (pending == null || typeof (pending as { then?: unknown }).then !== "function") {
            finish(new Error("workflow result send did not return a thenable"));
            return;
          }
          Promise.resolve(pending).then(
            () =>
              finish(
                sessionHasDelivery(session, deliveryId) === true
                  ? undefined
                  : new Error("host send settled without persisting workflow result"),
              ),
            (error) => finish(sessionHasDelivery(session, deliveryId) === true ? undefined : error),
          );
        } catch (error) {
          finish(error);
        }
      }
      startWhenIdle();
    });
  });
}

/**
 * Capture a Promise-returning send from the *host* AgentSession. bindCore's
 * `actions.sendMessage` is fire-and-forget (void + swallowed reject) and must
 * not be treated as an ACK channel. Child sessions never enter the map.
 */
function patchAgentSessionCapture(): void {
  try {
    const proto = hostAgentSession.prototype as unknown as StealCandidate;
    if (patchedSessionPrototypes.has(proto)) return;
    const original = proto.sendCustomMessage;
    if (typeof original !== "function") {
      // AgentSession shape changed — bind stays fail-closed without steal.
      return;
    }
    patchedSessionPrototypes.add(proto);
    // PRIMARY capture hook: `_bindExtensionCore` runs at session construction,
    // before any extension code, so a stock pi host is captured without ever
    // probing. The omp fork bundle does not expose the symbol — guard with
    // typeof so the patch stays a no-op there and the probe fallback handles
    // capture. Full original gates apply (persistence gate included,
    // probe=false).
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
    // Invoke the original with the runtime's live session as receiver. A
    // `.bind(proto)` forward would freeze the receiver to the prototype, and a
    // bound function's receiver cannot be overridden by `.call(this, …)` — the
    // original would run with `this.agent` undefined and every non-trigger
    // send would reject, silently losing the delivery. Patch predates session
    // construction: this here is the session that later calls sendCustomMessage.
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
      // Capture-only probe: the probe exists only to trip this capture patch.
      // Never append to agent.state.messages, never write a session entry,
      // never inject an LLM user turn — swallow it entirely.
      if (isProbe) return Promise.resolve();
      return original.call(this, message, options);
    };
  } catch {
    // AgentSession unavailable or shape changed — bind stays fail-closed without steal
  }
}

export const WORKFLOW_LIFECYCLE_EVENT = "pi-dynamic-workflows:lifecycle";

export interface WorkflowLifecycleEvent {
  status: "started" | "resumed" | "paused" | "completed" | "failed" | "stopped";
  runId: string;
  name: string;
  sessionId?: string;
}

type DeliveryManager = WorkflowManager & {
  __deliveryInstalled?: boolean;
  __lifecycleEventInstalled?: boolean;
  __lifecycleEventEmitter?: (data: WorkflowLifecycleEvent) => void;
  /** Last loadSettings seen on install — used when binding endpoints. */
  __deliveryLoadSettings?: () => WorkflowSettings;
};

function deliveryManager(manager: WorkflowManager): DeliveryManager {
  return manager as DeliveryManager;
}

function resolveDeliverySessionId(run: ManagedRun, manager: WorkflowManager): string | undefined {
  // Originating run wins; manager binding is legacy fallback only when the run
  // predates per-run sessionId. Never invent a session.
  return run.sessionId ?? manager.getSessionId?.();
}

function sameDelivery(a: PendingDeliveryMarker | undefined, b: PendingDeliveryMarker): boolean {
  return a?.kind === b.kind && (a.kind !== "text" || (b.kind === "text" && a.text === b.text));
}

function markerWithId(marker: PendingDeliveryMarker, existing?: PendingDeliveryMarker): PendingDeliveryMarker {
  const deliveryId = sameDelivery(existing, marker) ? existing?.deliveryId : undefined;
  return { ...marker, deliveryId: deliveryId ?? marker.deliveryId ?? randomUUID() };
}

function markRunPending(run: ManagedRun, marker: PendingDeliveryMarker): PendingDeliveryMarker {
  const identified = markerWithId(marker, run.pendingDelivery);
  if (run.pendingDelivery?.deliveryId !== identified.deliveryId) deliveredAwaitingClear.delete(run.runId);
  run.pendingDelivery = identified;
  return identified;
}

type ClearPendingResult = "cleared" | "stale" | "failed";

/** Outcome of making a delivery marker durable before its send. */
type PendingSaveResult = "saved" | "deleted" | "failed";

function clearRunPending(
  manager: WorkflowManager,
  runId: string,
  deliveryId: string,
  run?: ManagedRun,
): ClearPendingResult {
  // Clear disk first. If that fails, retain the live marker so the delivered
  // message remains visible to the bounded clear retry instead of being lost.
  // A record deleted by another process has no marker left to clear.
  try {
    const live = run ?? manager.getRun(runId);
    if (live?.pendingDelivery?.deliveryId && live.pendingDelivery.deliveryId !== deliveryId) return "stale";

    const persistence = manager.getPersistence?.();
    if (persistence) {
      if (persistence.updateMetadata) {
        if (!persistence.updateMetadata(runId, { pendingDelivery: undefined }, deliveryId)) {
          const remaining = persistence.loadPreview ? persistence.loadPreview(runId) : persistence.load(runId);
          if (remaining) return "stale";
        }
      } else {
        const state = persistence.load(runId);
        if (state?.pendingDelivery?.deliveryId && state.pendingDelivery.deliveryId !== deliveryId) return "stale";
        if (state?.pendingDelivery) {
          const { pendingDelivery: _drop, ...rest } = state;
          persistence.save(rest as PersistedRunState);
        }
      }
    }
    if (live) live.pendingDelivery = undefined;
    return "cleared";
  } catch {
    warnDelivery(
      run?.sessionId ?? manager.getSessionId?.(),
      `Workflow ${runId}: result delivered, but its pending marker could not be cleared.`,
    );
    return "failed";
  }
}

/**
 * Make a live run's delivery marker durable before sending it. A run that has
 * never been written is seeded with a minimal record; persistence refuses to
 * recreate a record that another process deleted, which reports "deleted".
 */
function persistRunPending(manager: WorkflowManager, run: ManagedRun): PendingSaveResult {
  try {
    // Prefer merging into an existing on-disk record so we don't clobber the
    // manager's richer write that follows the complete/error emit.
    const persistence = manager.getPersistence?.();
    if (!persistence) return "saved";
    if (persistence.updateMetadata?.(run.runId, { pendingDelivery: run.pendingDelivery, sessionId: run.sessionId }))
      return "saved";
    const existing = persistence.load(run.runId);
    if (existing) {
      persistence.save({ ...existing, pendingDelivery: run.pendingDelivery, sessionId: run.sessionId });
      return "saved";
    }
    if (run.pendingDelivery) {
      persistence.save({
        runId: run.runId,
        workflowName: run.snapshot.name,
        script: run.script ?? "",
        sessionId: run.sessionId,
        status: run.status,
        phases: run.snapshot.phases ?? [],
        agents: [],
        logs: run.snapshot.logs ?? [],
        result: run.result?.result,
        tokenUsage: run.result?.tokenUsage ?? run.snapshot.tokenUsage,
        durationMs: run.result?.durationMs,
        startedAt: run.startedAt?.toISOString?.() ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pendingDelivery: run.pendingDelivery,
      });
    }
    return "saved";
  } catch (error) {
    if (error instanceof RunRecordDeletedError) return "deleted";
    warnDelivery(
      run.sessionId,
      `Workflow ${run.runId}: delivery deferred because its pending marker could not be saved.`,
    );
    return "failed";
  }
}

/** Give a disk-only pending run its delivery id. It never creates a record. */
function persistDiskMarker(
  manager: WorkflowManager,
  runId: string,
  marker: PendingDeliveryMarker,
  state?: PersistedRunState,
): PendingSaveResult {
  try {
    const persistence = manager.getPersistence?.();
    if (!persistence) return "saved";
    if (persistence.updateMetadata)
      return persistence.updateMetadata(runId, { pendingDelivery: marker }) ? "saved" : "deleted";
    const current = state ?? persistence.load(runId);
    if (!current) return "deleted";
    persistence.save({ ...current, pendingDelivery: marker });
    return "saved";
  } catch (error) {
    return error instanceof RunRecordDeletedError ? "deleted" : "failed";
  }
}

/** A run deleted by another process is no longer deliverable; drop its delivery state. */
function abandonDeletedDelivery(runId: string, run?: ManagedRun): void {
  if (run) run.pendingDelivery = undefined;
  deliveredAwaitingClear.delete(runId);
  cancelDeliveryRetry(runId);
}

function contentForPending(
  manager: WorkflowManager,
  runId: string,
  marker: PendingDeliveryMarker,
  loadSettings?: () => WorkflowSettings,
  run?: ManagedRun,
  persisted?: PersistedRunState,
): string | undefined {
  if (marker.kind === "text") return marker.text;
  // complete — recompute from live run or disk so we never store the body twice
  if (run) {
    return deliverText(run, {
      resultPath: persistedResultPath(manager, runId, run.result?.result),
      maxChars: deliveredMaxChars({ loadSettings }),
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
        maxChars: deliveredMaxChars({ loadSettings }),
      },
    );
  }
  return undefined;
}

/**
 * Attempt session-routed delivery. Resolves true only after a thenable
 * host sendCustomMessage / stableSend settles on a live endpoint. Void /
 * fire-and-forget sends and durable appends are NOT success (append writes
 * history without triggerTurn). Does not clear pending markers.
 */
function tryDeliverEndpoint(endpoint: SessionDeliveryEndpoint, content: string, deliveryId: string): Promise<boolean> {
  if (endpoint.suspended) return Promise.resolve(false);
  if (endpoint.sessionId && sessionEndpoints.get(endpoint.sessionId) !== endpoint) {
    // Stale endpoint object after rebind/drop.
    return Promise.resolve(false);
  }

  // Only a thenable session-stable send (host sendCustomMessage) may ACK.
  if (typeof endpoint.send === "function") {
    try {
      const ret = endpoint.send(
        { customType: "workflow-result", content, display: true, details: { deliveryId } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      if (ret != null && typeof (ret as { then?: unknown }).then === "function") {
        const startedGeneration = endpoint.generation;
        const sessionId = endpoint.sessionId;
        return Promise.resolve(ret).then(
          () => {
            const current = sessionEndpoints.get(sessionId);
            // Succeeded under this or a newer live endpoint for the same session.
            return !!current && !current.suspended;
          },
          (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            warnDelivery(sessionId, `Workflow result remains pending: ${msg}`);
            const current = sessionEndpoints.get(sessionId);
            // If a newer generation already bound, caller may re-flush; signal failure.
            if (current && current.generation !== startedGeneration && !current.suspended) {
              // Return false so disk marker stays; flush path retries.
            }
            return false;
          },
        );
      }
      // Non-thenable send (void fire-and-forget) — do not trust as ACK.
      warnDelivery(
        endpoint.sessionId,
        `[workflow-delivery] send for session ${endpoint.sessionId} did not return a thenable; ` +
          "not treating as delivered (fail closed).",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnDelivery(endpoint.sessionId, `Workflow result remains pending: ${msg}`);
      return Promise.resolve(false);
    }
  }

  return Promise.resolve(false);
}

function cancelDeliveryRetry(runId: string): void {
  const retry = deliveryRetries.get(runId);
  if (retry?.timer) clearTimeout(retry.timer);
  deliveryRetries.delete(runId);
}

function cancelSessionDeliveryState(sessionId: string): void {
  for (const [runId, retry] of deliveryRetries) {
    if (retry.sessionId === sessionId) cancelDeliveryRetry(runId);
  }
  for (const [runId, delivered] of deliveredAwaitingClear) {
    if (delivered.sessionId === sessionId) deliveredAwaitingClear.delete(runId);
  }
}

function scheduleDeliveryRetry(manager: WorkflowManager, runId: string, sessionId: string, generation: number): void {
  const current = deliveryRetries.get(runId);
  if (current?.timer && current.generation === generation) return;
  const attempt = current?.generation === generation ? current.attempt : 0;
  if (attempt >= DELIVERY_RETRY_DELAYS_MS.length) {
    warnDelivery(
      sessionId,
      `Workflow ${runId}: result remains pending after delivery retries. Open /workflows to inspect it.`,
    );
    return;
  }

  const retry: DeliveryRetry = { attempt: attempt + 1, generation, sessionId };
  retry.timer = setTimeout(() => {
    retry.timer = undefined;
    if (deliveryRetries.get(runId) !== retry) return;
    const endpoint = sessionEndpoints.get(sessionId);
    if (!endpoint || endpoint.suspended || endpoint.generation !== generation) return;
    flushSessionDiskPending(manager, sessionId, endpoint);
  }, DELIVERY_RETRY_DELAYS_MS[attempt]);
  retry.timer.unref?.();
  deliveryRetries.set(runId, retry);
}

function releaseDelivery(runId: string, token: number): void {
  if (inFlightDeliveries.get(runId)?.token === token) inFlightDeliveries.delete(runId);
}

function deliverAndAck(
  manager: WorkflowManager,
  runId: string,
  sessionId: string,
  content: string,
  deliveryId: string,
  run?: ManagedRun,
): void {
  if (inFlightDeliveries.has(runId)) return;
  const endpoint = sessionEndpoints.get(sessionId);
  if (!endpoint) {
    return;
  }
  if (endpoint.suspended) {
    return;
  }
  if (endpoint.sessionId !== sessionId) {
    warnDelivery(
      sessionId,
      `[workflow-delivery] delivery for ${runId} deferred: endpoint sessionId ${endpoint.sessionId} !== ${sessionId}`,
    );
    return;
  }

  const delivered = deliveredAwaitingClear.get(runId);
  if (
    delivered?.deliveryId === deliveryId &&
    delivered.sessionId === sessionId &&
    delivered.generation === endpoint.generation
  ) {
    const clear = clearRunPending(manager, runId, deliveryId, run ?? manager.getRun?.(runId));
    if (clear !== "failed") {
      deliveredAwaitingClear.delete(runId);
      cancelDeliveryRetry(runId);
    } else {
      scheduleDeliveryRetry(manager, runId, sessionId, endpoint.generation);
    }
    return;
  }

  // Fail-closed (no send): keep the run pending on disk with NO lock, so a
  // synchronous re-bind + flush (e.g. probe retry on the next session_start)
  // is not locked out by a microtask that has not run yet.
  if (typeof endpoint.send !== "function") {
    warnDelivery(
      sessionId,
      `[workflow-delivery] delivery for ${runId} deferred: endpoint for session ${sessionId} has no thenable send function`,
    );
    return;
  }

  const token = ++inFlightSeq;
  inFlightDeliveries.set(runId, { token, sessionId });
  const startedGeneration = endpoint.generation;
  void tryDeliverEndpoint(endpoint, content, deliveryId)
    .then((ok) => {
      if (ok) {
        cancelDeliveryRetry(runId);
        const current = sessionEndpoints.get(sessionId);
        if (!current || current.suspended || current.generation !== startedGeneration || current !== endpoint) {
          return;
        }
        const clear = clearRunPending(manager, runId, deliveryId, run ?? manager.getRun?.(runId));
        if (clear === "failed") {
          deliveredAwaitingClear.set(runId, { deliveryId, sessionId, generation: startedGeneration });
          scheduleDeliveryRetry(manager, runId, sessionId, startedGeneration);
        } else if (clear === "stale") {
          // This send belonged to an older marker. Release before flushing the
          // newer delivery, and let the ownership token protect its lock.
          releaseDelivery(runId, token);
          const active = sessionEndpoints.get(sessionId);
          if (active && !active.suspended && active.manager) {
            flushSessionDiskPending(active.manager, sessionId, active);
          }
        }
        return;
      }

      releaseDelivery(runId, token);
      const current = sessionEndpoints.get(sessionId);
      if (!current || current.suspended || !current.manager) return;
      if (current.generation !== startedGeneration) {
        cancelDeliveryRetry(runId);
        flushSessionDiskPending(current.manager, sessionId, current);
      } else {
        scheduleDeliveryRetry(manager, runId, sessionId, startedGeneration);
      }
    })
    .finally(() => {
      releaseDelivery(runId, token);
      const liveRun = manager.getRun?.(runId);
      const persistence = manager.getPersistence?.();
      const owner = liveRun
        ? resolveDeliverySessionId(liveRun, manager)
        : ((persistence?.loadPreview ? persistence.loadPreview(runId) : persistence?.load(runId))?.sessionId ??
          sessionId);
      const current = owner ? sessionEndpoints.get(owner) : undefined;
      // A rebind may have tried to flush while this send still owned the lock.
      // Hand off after either settlement, including a successful stale ACK.
      if (current && !current.suspended && current.manager && current !== endpoint) {
        flushSessionDiskPending(current.manager, current.sessionId, current);
      }
    });
}

function routeBackgroundDelivery(
  manager: WorkflowManager,
  run: ManagedRun,
  marker: PendingDeliveryMarker,
  content: string,
): void {
  // 1. Mark pending first (fail closed / crash safe). Repeated lifecycle
  // events reuse the same id so host-session history can deduplicate retries.
  const pending = markRunPending(run, marker);
  const deliveryId = pending.deliveryId;
  if (!deliveryId) return;
  const saved = persistRunPending(manager, run);
  if (saved === "deleted") {
    abandonDeletedDelivery(run.runId, run);
    return;
  }

  const sessionId = resolveDeliverySessionId(run, manager);
  if (!sessionId) {
    return;
  }

  if (saved === "failed") {
    const endpoint = sessionEndpoints.get(sessionId);
    if (endpoint && !endpoint.suspended) {
      scheduleDeliveryRetry(manager, run.runId, sessionId, endpoint.generation);
    }
    return;
  }

  // 2. Deliver only via the originating session's endpoint; clear after ACK.
  deliverAndAck(manager, run.runId, sessionId, content, deliveryId, run);
}

/**
 * Register or refresh the delivery endpoint for a pi session. Requires a
 * session-stable thenable send (stolen host AgentSession.sendCustomMessage, or
 * test DI). Never falls back to shared pi.sendMessage. A durable
 * appendCustomMessageEntry is not an ACK (no triggerTurn).
 *
 * Call from session_start AFTER Pi bindCore. Unsuspends and flushes disk pending
 * for this sessionId only.
 */
export function bindSessionDelivery(
  sessionId: string,
  pi: ExtensionAPI,
  opts: {
    loadSettings?: () => WorkflowSettings;
    /** UI-safe, rate-limited warning for actionable delivery failures only. */
    reportWarning?: (message: string) => void;
    manager?: WorkflowManager;
    /**
     * Optional explicit thenable send (tests / DI). Wins over the process-wide
     * steal map when provided.
     */
    stableSend?: DeliverySend;
    /**
     * Optional sessionManager. getSessionId is identity only — append is not
     * an ACK channel.
     */
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

  // Optional identity check — refuse to bind when sessionManager disagrees.
  try {
    const liveId = opts.sessionManager?.getSessionId?.();
    if (liveId && liveId !== sessionId) {
      return;
    }
  } catch {
    // getSessionId unavailable — continue
  }

  let stolen = opts.stableSend ?? boundSessionSends.get(sessionId);
  if (!stolen) {
    // Quiet hosts never call sendCustomMessage themselves, so the prototype
    // patch never captured. One invisible no-turn probe forces the host's void
    // send wrapper through AgentSession.sendCustomMessage, populating the
    // steal map synchronously.
    probeHostSessionSend(pi, sessionId);
    stolen = boundSessionSends.get(sessionId);
  }

  const prev = sessionEndpoints.get(sessionId);
  // Retire unsent waits from the previous endpoint. Already-started sends keep
  // their lock until actual settlement; reload is not an SDK abort barrier.
  for (const waiter of activeStreamingWaiters) {
    if (waiter.sessionId === sessionId && !waiter.hasStarted()) {
      waiter.cancel(new Error("session delivery rebound before send"));
    }
  }
  const endpoint: SessionDeliveryEndpoint = {
    sessionId,
    send: stolen,
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

  // Only an unsent wait is safe to cancel. A started send can still persist
  // after shutdown/reload, so retain ownership until its real outcome is known.
  for (const waiter of activeStreamingWaiters) {
    if (waiter.sessionId === sessionId && !waiter.hasStarted()) {
      waiter.cancel(new Error("session delivery suspended"));
    }
  }

  for (const [runId, retry] of deliveryRetries) {
    if (retry.sessionId === sessionId) cancelDeliveryRetry(runId);
  }
}

/**
 * Drop endpoint + stolen send for a session that will not come back (quit /
 * discard, or the *old* id after a successful replacement bind). Releases the
 * AgentSession closure retained by the steal map (#109).
 */
export function dropSessionDelivery(sessionId: string | undefined): void {
  if (!sessionId) return;
  suspendSessionDelivery(sessionId);
  cancelSessionDeliveryState(sessionId);
  sessionEndpoints.delete(sessionId);
  boundSessionSends.delete(sessionId);
  // A dropped session may be rebound fresh (e.g. replaced id): forget probe
  // bookkeeping so the next bindSessionDelivery probes again.
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

function flushSessionDiskPending(manager: WorkflowManager, sessionId: string, endpoint: SessionDeliveryEndpoint): void {
  if (endpoint.suspended) return;

  const tryOne = (runId: string, marker: PendingDeliveryMarker, run?: ManagedRun, persisted?: PersistedRunState) => {
    if (inFlightDeliveries.has(runId)) return;
    // A live run re-persists its marker; a disk-only run only needs a missing id.
    const identified = run ? markRunPending(run, marker) : marker.deliveryId ? marker : markerWithId(marker);
    const saved = run
      ? persistRunPending(manager, run)
      : identified === marker
        ? "saved"
        : persistDiskMarker(manager, runId, identified, persisted);
    if (saved === "deleted") {
      abandonDeletedDelivery(runId, run);
      return;
    }
    if (saved === "failed") {
      if (run) scheduleDeliveryRetry(manager, runId, sessionId, endpoint.generation);
      else warnDelivery(sessionId, `Workflow ${runId}: delivery deferred because its marker could not be saved.`);
      return;
    }
    const deliveryId = identified.deliveryId;
    if (!deliveryId) return;
    const content = contentForPending(manager, runId, identified, endpoint.loadSettings, run, persisted);
    if (content === undefined) return;
    deliverAndAck(manager, runId, sessionId, content, deliveryId, run);
  };

  // Live in-memory runs for this session. Null sessionId is claimable only for
  // THIS manager's live runs (pre-bind completions) — never from a foreign manager.
  try {
    for (const run of manager.listLiveRuns?.() ?? []) {
      if (!run.pendingDelivery) continue;
      if (run.sessionId != null && run.sessionId !== sessionId) continue;
      if (run.sessionId == null) run.sessionId = sessionId;
      tryOne(run.runId, run.pendingDelivery, run);
    }
  } catch {
    // listLiveRuns may be absent on stubs
  }

  // Disk runs (including terminal runs already evicted from memory). Require an
  // exact sessionId match — do not claim null-sessionId disk rows (same-cwd dual
  // manager race). Handoff re-homes previous-session pendings via adopt first.
  try {
    const persistence = manager.getPersistence?.();
    if (!persistence) return;
    for (const state of persistence.list()) {
      if (!state.pendingDelivery) continue;
      if (state.sessionId !== sessionId) continue;
      // Skip if the live copy still carries the marker — the loop above owns it.
      const live = manager.getRun?.(state.runId);
      if (live?.pendingDelivery) continue;
      try {
        tryOne(state.runId, state.pendingDelivery, live, state);
      } catch {
        // The list can still show a run another process just deleted, whose
        // record then fails to read; skip it so the other results still go out.
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Stop live sends for the manager's currently bound session. In-flight
 * completions only leave disk pending until the next bind/resume.
 *
 * Call from session_shutdown BEFORE handoff or discard so a completion that
 * races the teardown cannot deliver into the outgoing session (#143).
 */
export function suspendResultDelivery(manager: WorkflowManager): void {
  suspendSessionDelivery(manager.getSessionId?.());
}

/**
 * Unsuspend and flush queued deliveries for the manager's bound session.
 * Must run only after Pi has finished bindCore (i.e. from session_start).
 * Prefer {@link bindSessionDelivery} which also captures a fresh stable send.
 */
export function resumeResultDelivery(manager: WorkflowManager): void {
  resumeSessionDelivery(manager.getSessionId?.(), manager);
}

/**
 * When a background run finishes (or fails), deliver its result back into the
 * *originating* conversation AND continue the turn so the assistant can act on
 * it — without blocking the user meanwhile:
 *
 *  - Delivery is routed by `run.sessionId` through the process-wide endpoint
 *    registry (never "latest pi wins").
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle.
 *  - `deliverAs: "followUp"` queues behind an in-flight turn — never interrupts.
 *  - Durable pending marker clears only after verified delivery ACK.
 *
 * Set up once per manager; idempotent via an internal guard. Across session
 * replacement the manager (and these listeners) survive via the handoff path;
 * each new generation calls {@link bindSessionDelivery} on session_start.
 */
// Register turn_end once for each ExtensionAPI instance. The handler looks up
// its own latest manager rather than a process-global one: multiple live pi
// instances can interleave A/B/A installs, and each callback must stay scoped
// to the instance that emitted it.
let turnEndDeliveryManagers = new WeakMap<ExtensionAPI, { manager: WorkflowManager }>();

export function installResultDelivery(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: { loadSettings?: () => WorkflowSettings } = {},
): void {
  const m = deliveryManager(manager);
  m.__deliveryLoadSettings = opts.loadSettings;
  patchAgentSessionCapture();

  m.__lifecycleEventEmitter = (data) => pi.events?.emit(WORKFLOW_LIFECYCLE_EVENT, data);
  if (!m.__lifecycleEventInstalled) {
    m.__lifecycleEventInstalled = true;
    const emitLifecycle =
      (status: WorkflowLifecycleEvent["status"]) =>
      ({ runId }: { runId: string }) => {
        const run = manager.getRun(runId);
        const persistence = manager.getPersistence();
        const persisted = run
          ? undefined
          : persistence.loadPreview
            ? persistence.loadPreview(runId)
            : persistence.load(runId);
        const lifecycle = run?.background
          ? { name: run.snapshot.name, sessionId: resolveDeliverySessionId(run, manager) }
          : persisted
            ? { name: persisted.workflowName, sessionId: persisted.sessionId }
            : undefined;
        if (!lifecycle) return;
        m.__lifecycleEventEmitter?.({
          status,
          runId,
          name: lifecycle.name,
          ...(lifecycle.sessionId ? { sessionId: lifecycle.sessionId } : {}),
        });
      };
    manager.on("started", emitLifecycle("started"));
    manager.on("resumed", emitLifecycle("resumed"));
    manager.on("paused", emitLifecycle("paused"));
    manager.on("complete", emitLifecycle("completed"));
    manager.on("error", emitLifecycle("failed"));
    manager.on("stopped", emitLifecycle("stopped"));
  }

  // Per-instance turn_end dispatch (audit2 #33): within one pi generation,
  // per-manager registration would stack a handler per cross-project rebuild
  // (pi.on has no off()). Register once per pi, updating only that pi's latest
  // manager on repeat installs.
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
        const stolen = boundSessionSends.get(sid);
        if (stolen) {
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
  const sid = manager.getSessionId?.();
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
    // Only background/resumed runs are delivered: a foreground (sync) run already
    // returns its result inline as the tool result, so re-delivering would dup it.
    if (!run?.background) return;
    const sessionId = resolveDeliverySessionId(run, manager);
    const endpoint = sessionId ? sessionEndpoints.get(sessionId) : undefined;
    const content = deliverText(run, {
      resultPath: persistedResultPath(manager, runId, run.result?.result),
      maxChars: deliveredMaxChars({
        loadSettings: endpoint?.loadSettings ?? m.__deliveryLoadSettings,
      }),
    });
    routeBackgroundDelivery(manager, run, { kind: "complete" }, content);
  });

  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    const run = manager.getRun(runId);
    if (!run?.background) return;
    const text = `✗ Background workflow ${runId} failed: ${error?.message ?? "unknown error"}`;
    routeBackgroundDelivery(manager, run, { kind: "text", text }, text);
  });

  // Two pauses need the model: a provider usage limit (the run is resumable once
  // the limit resets, not dead) and a script waiting at a durable checkpoint (it
  // stays paused until someone answers). A manual pause() carries no reason and
  // is the user's own action, so it delivers nothing.
  manager.on("paused", (event: PausedEvent) => {
    const run = manager.getRun(event.runId);
    if (!run?.background) return;
    const text = pausedRunText(event);
    if (text) routeBackgroundDelivery(manager, run, { kind: "text", text }, text);
  });
}

interface PausedEvent {
  runId: string;
  reason?: string;
  error?: { message?: string };
  resetHint?: string;
  checkpoint?: { checkpointId: string; kind: string; payload?: unknown };
}

const CHECKPOINT_PAYLOAD_PREVIEW_CHARS = 500;

/** The delivered notice for a pause the model must act on, or undefined for a manual pause. */
function pausedRunText({ runId, reason, error, resetHint, checkpoint }: PausedEvent): string | undefined {
  if (reason === "usage_limit") {
    const when = resetHint ? ` (${resetHint})` : "";
    return (
      `⏸ Subagents run ${runId} paused: ${error?.message ?? "provider usage limit reached"}${when}. ` +
      `Finished work is saved — continue it with subagents_control action "resume", runId "${runId}" once the limit resets.`
    );
  }
  if (reason === "workflow_checkpoint" && checkpoint) {
    const payload = JSON.stringify(checkpoint.payload) ?? "undefined";
    const preview =
      payload.length > CHECKPOINT_PAYLOAD_PREVIEW_CHARS
        ? `${payload.slice(0, CHECKPOINT_PAYLOAD_PREVIEW_CHARS)}…`
        : payload;
    return (
      `⏸ Subagents run ${runId} is waiting at checkpoint "${checkpoint.checkpointId}" (${checkpoint.kind}). Payload: ${preview}
` +
      `Answer it with subagents_control action "resume", runId "${runId}", checkpointId "${checkpoint.checkpointId}", and your response.`
    );
  }
  return undefined;
}

/** @internal test helper — reset process-wide delivery registries between cases. */
export function _resetDeliveryRegistriesForTests(): void {
  for (const waiter of activeStreamingWaiters) {
    waiter.cancel(new Error("test reset"));
  }
  activeStreamingWaiters.clear();
  streamingAckTimeoutMs = DEFAULT_STREAMING_ACK_TIMEOUT_MS;
  sessionEndpoints.clear();
  boundSessionSends.clear();
  inFlightDeliveries.clear();
  for (const retry of deliveryRetries.values()) if (retry.timer) clearTimeout(retry.timer);
  deliveryRetries.clear();
  deliveredAwaitingClear.clear();
  inFlightSeq = 0;
  probedSessionIds.clear();
  turnEndDeliveryManagers = new WeakMap<ExtensionAPI, { manager: WorkflowManager }>();
}

export function _setStreamingAckTimeoutForTests(timeoutMs: number): void {
  streamingAckTimeoutMs = timeoutMs;
}

/** @internal test helper — register a thenable session-stable send (steal map). */
export function _registerBoundSessionSendForTests(sessionId: string, send: DeliverySend): void {
  boundSessionSends.set(sessionId, send);
}

/** @internal test helper — register a host-shaped session (steal-map host filter). */
export function _registerHostSessionForTests(session: StealCandidate): void {
  captureHostSessionSend(session);
}

/** @internal test helper — inspect which session ids currently hold a stolen send. */
export function _getStealMapForTests(): ReadonlyMap<string, DeliverySend> {
  return boundSessionSends;
}

/** @internal test helper — inspect whether a session is marked successfully probed. */
export function _isProbedForTests(sessionId: string): boolean {
  return probedSessionIds.has(sessionId);
}

/** @internal test helper — inspect endpoint suspended flag. */
export function _getSessionDeliveryEndpointForTests(
  sessionId: string,
): { suspended: boolean; generation: number; hasSend: boolean; hasAppend: boolean } | undefined {
  const ep = sessionEndpoints.get(sessionId);
  if (!ep) return undefined;
  return {
    suspended: ep.suspended,
    generation: ep.generation,
    hasSend: typeof ep.send === "function",
    // Append is never an ACK; kept on the inspect shape so existing tests compile.
    hasAppend: false,
  };
}

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
