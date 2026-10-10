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
import { type DeliverySend } from "./task-panel/delivery-endpoints.js";
import { type StealCandidate } from "./task-panel/host-send-capture.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowSettings } from "./workflow-settings.js";
export declare const WORKFLOW_LIFECYCLE_EVENT = "pi-dynamic-workflows:lifecycle";
export interface WorkflowLifecycleEvent {
    status: "started" | "resumed" | "paused" | "completed" | "failed" | "stopped";
    runId: string;
    name: string;
    sessionId?: string;
}
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
/**
 * Install the live "workflows running" panel below the editor. It redraws on
 * every manager event and is informational only — the user opens the navigator
 * with /workflows. The unused `_pi` keeps the public signature stable.
 */
export declare function installTaskPanel(_pi: ExtensionAPI, manager: WorkflowManager, ui: ExtensionUIContext, opts?: TaskPanelOptions): void;
/** The message delivered when a background run completes, ending with a pointer to the full result. */
export declare function deliverText(run: ManagedRun, opts?: {
    resultPath?: string;
    maxChars?: number;
}): string;
/**
 * Custom type of the capture-only probe sent through pi.sendMessage. The patched
 * sendCustomMessage swallows it, so nothing is appended, persisted, or turned.
 */
export declare const DELIVERY_PROBE_CUSTOM_TYPE = "workflow-delivery-probe";
/** Bind delivery capture to the host loader's class, not a sibling SDK peer. */
export declare function installHostSessionCapture(sessionClass: typeof AgentSession): void;
/**
 * Register or refresh the delivery endpoint for a pi session, then flush what is
 * pending for that session only. Requires a confirming send (the captured host
 * sendCustomMessage, or `stableSend` in tests); a durable
 * appendCustomMessageEntry is not an ACK because it starts no turn.
 *
 * Call from session_start, after Pi's bindCore.
 */
export declare function bindSessionDelivery(sessionId: string, pi: ExtensionAPI, opts?: {
    loadSettings?: () => WorkflowSettings;
    /** UI-safe, rate-limited warning for actionable delivery failures only. */
    reportWarning?: (message: string) => void;
    manager?: WorkflowManager;
    /** Explicit confirming send (tests / DI); wins over the captured send. */
    stableSend?: DeliverySend;
    /** Used only to check the session identity; its append is not an ACK channel. */
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
 * Forget a session that will not come back (quit / discard, or the old id after
 * a successful replacement bind). Releases the AgentSession closure held by its
 * captured send; pending markers stay on disk.
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
 * Call from session_shutdown before handoff or discard, so a completion racing
 * the teardown cannot deliver into the outgoing session.
 */
export declare function suspendResultDelivery(manager: WorkflowManager): void;
/**
 * Unsuspend and flush queued deliveries for the manager's bound session.
 * Must run only after Pi has finished bindCore (i.e. from session_start).
 * Prefer {@link bindSessionDelivery} which also captures a fresh stable send.
 */
export declare function resumeResultDelivery(manager: WorkflowManager): void;
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
export declare function installResultDelivery(pi: ExtensionAPI, manager: WorkflowManager, opts?: {
    loadSettings?: () => WorkflowSettings;
}): void;
/** @internal test helper — reset process-wide delivery registries between cases. */
export declare function _resetDeliveryRegistriesForTests(): void;
/** @internal test helper — register a confirming session send directly. */
export declare function _registerBoundSessionSendForTests(sessionId: string, send: DeliverySend): void;
/** @internal test helper — capture a host-shaped session as the prototype patch would. */
export declare function _registerHostSessionForTests(session: StealCandidate): void;
/** @internal test helper — inspect which session ids currently hold a captured send. */
export declare function _getStealMapForTests(): ReadonlyMap<string, DeliverySend>;
/** @internal test helper — inspect whether a session is marked successfully probed. */
export declare function _isProbedForTests(sessionId: string): boolean;
/** @internal test helper — inspect a session's endpoint state. */
export declare function _getSessionDeliveryEndpointForTests(sessionId: string): {
    suspended: boolean;
    generation: number;
    hasSend: boolean;
    hasAppend: boolean;
} | undefined;
