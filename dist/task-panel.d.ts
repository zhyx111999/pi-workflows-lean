/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */
import { AgentSession, type ExtensionAPI, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
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
export declare function deliverText(run: ManagedRun, opts?: {
    resultPath?: string;
    maxChars?: number;
}): string;
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
    details?: {
        deliveryId?: string;
    };
};
type DeliverySend = (message: DeliveryMessage, options: {
    triggerTurn: boolean;
    deliverAs: "followUp";
}) => unknown;
/**
 * Custom type for the session bind probe (see probeHostSessionSend). Sent
 * through pi.sendMessage ONLY so the sendCustomMessage capture patch can
 * identify the live host session. Capture-only: the patched sendCustomMessage
 * swallows probe messages — nothing is appended, persisted, or turned.
 */
export declare const DELIVERY_PROBE_CUSTOM_TYPE = "workflow-delivery-probe";
/** Bind delivery capture to the host loader's class, not a sibling SDK peer. */
export declare function installHostSessionCapture(sessionClass: typeof AgentSession): void;
interface StealCandidate {
    sendCustomMessage?: DeliverySend;
    isStreaming?: boolean;
    isIdle?: boolean;
    waitForIdle?: () => Promise<void>;
    agent?: {
        hasQueuedMessages?: () => boolean;
    };
    subscribe?: (listener: (event: {
        type?: string;
        message?: {
            role?: string;
            customType?: string;
            details?: unknown;
        };
        followUp?: readonly unknown[];
        steering?: readonly unknown[];
    }) => void) => () => void;
    sessionManager?: {
        persist?: boolean;
        getSessionId?: () => string;
        getSessionName?: () => string | undefined;
        getEntries?: () => Array<{
            type?: string;
            customType?: string;
            details?: unknown;
        }>;
        getBranch?: () => Array<{
            id?: string;
            type?: string;
            customType?: string;
            details?: unknown;
        }>;
        getSessionFile?: () => string | undefined;
        isPersisted?: () => boolean;
        isSessionOnDisk?: () => boolean;
    };
    _resourceLoader?: {
        noExtensions?: boolean;
    };
    _bindExtensionCore?: (...args: unknown[]) => unknown;
}
/** Scan the SDK's JSONL record without allocating the entire session history. */
export declare function sessionFileContainsEntry(path: string, entry: object): boolean;
export declare const WORKFLOW_LIFECYCLE_EVENT = "pi-dynamic-workflows:lifecycle";
export interface WorkflowLifecycleEvent {
    status: "started" | "resumed" | "paused" | "completed" | "failed" | "stopped";
    runId: string;
    name: string;
    sessionId?: string;
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
export declare function bindSessionDelivery(sessionId: string, pi: ExtensionAPI, opts?: {
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
        appendCustomMessageEntry?: (customType: string, content: string | unknown[], display: boolean, details?: unknown) => string;
    };
}): void;
/**
 * Suspend delivery for a session. Completions only mark disk pending until
 * {@link bindSessionDelivery} / {@link resumeSessionDelivery} runs again.
 */
export declare function suspendSessionDelivery(sessionId: string | undefined): void;
/**
 * Drop endpoint + stolen send for a session that will not come back (quit /
 * discard, or the *old* id after a successful replacement bind). Releases the
 * AgentSession closure retained by the steal map (#109).
 */
export declare function dropSessionDelivery(sessionId: string | undefined): void;
/**
 * Unsuspend and flush one session's pending deliveries (disk). Prefer
 * {@link bindSessionDelivery} on session_start (also refreshes send).
 */
export declare function resumeSessionDelivery(sessionId: string | undefined, manager?: WorkflowManager): void;
/**
 * Stop live sends for the manager's currently bound session. In-flight
 * completions only leave disk pending until the next bind/resume.
 *
 * Call from session_shutdown BEFORE handoff or discard so a completion that
 * races the teardown cannot deliver into the outgoing session (#143).
 */
export declare function suspendResultDelivery(manager: WorkflowManager): void;
/**
 * Unsuspend and flush queued deliveries for the manager's bound session.
 * Must run only after Pi has finished bindCore (i.e. from session_start).
 * Prefer {@link bindSessionDelivery} which also captures a fresh stable send.
 */
export declare function resumeResultDelivery(manager: WorkflowManager): void;
export declare function installResultDelivery(pi: ExtensionAPI, manager: WorkflowManager, opts?: {
    loadSettings?: () => WorkflowSettings;
}): void;
/** @internal test helper — reset process-wide delivery registries between cases. */
export declare function _resetDeliveryRegistriesForTests(): void;
export declare function _setStreamingAckTimeoutForTests(timeoutMs: number): void;
/** @internal test helper — register a thenable session-stable send (steal map). */
export declare function _registerBoundSessionSendForTests(sessionId: string, send: DeliverySend): void;
/** @internal test helper — register a host-shaped session (steal-map host filter). */
export declare function _registerHostSessionForTests(session: StealCandidate): void;
/** @internal test helper — inspect which session ids currently hold a stolen send. */
export declare function _getStealMapForTests(): ReadonlyMap<string, DeliverySend>;
/** @internal test helper — inspect whether a session is marked successfully probed. */
export declare function _isProbedForTests(sessionId: string): boolean;
/** @internal test helper — inspect endpoint suspended flag. */
export declare function _getSessionDeliveryEndpointForTests(sessionId: string): {
    suspended: boolean;
    generation: number;
    hasSend: boolean;
    hasAppend: boolean;
} | undefined;
export declare function renderPanel(manager: WorkflowManager, theme: Theme, width?: number): string[];
/** Record a token-total sample for `runId` at time `now` (ms). */
export declare function sampleTokens(runId: string, total: number, now: number, estimated?: boolean): void;
/** Tokens/second over the rolling window; 0 when too few samples or totals plateau. */
export declare function tokensPerSecond(runId: string): number;
/** Forget a run's samples (call when it finishes) so the map can't grow unbounded. */
export declare function clearTokenSamples(runId: string): void;
/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export declare function clampMaxAgents(value: number | undefined): number;
/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and a live token/s rate, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export declare function renderPanelDetailed(manager: WorkflowManager, theme: Theme, width: number | undefined, maxAgents: number, now: number): string[];
/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export declare function installTaskPanel(_pi: ExtensionAPI, manager: WorkflowManager, ui: ExtensionUIContext, opts?: TaskPanelOptions): void;
export {};
