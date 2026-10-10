/**
 * Captures each host session's sendCustomMessage and wraps it so a workflow
 * result counts as delivered only once that session has persisted it.
 */
import type { DeliverySend } from "./delivery-endpoints.js";
/** The parts of an AgentSession the capture relies on; every member is optional because host shapes vary. */
export interface StealCandidate {
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
/**
 * Confirming sends keyed by host sessionId. Workflow children (in-memory,
 * noExtensions, or named `workflow:…`) never enter this map, so a result can
 * never be routed into a subagent's session.
 */
export declare const boundSessionSends: Map<string, DeliverySend>;
/**
 * Register a confirming send for a host session. The wrapper waits until the
 * host is idle before sending, so a result never sits in the host's
 * unobservable follow-up queue, and resolves only once the result is persisted
 * in the session file.
 */
export declare function captureHostSessionSend(session: StealCandidate, probe?: boolean): void;
/**
 * Cancel a session's waits that have not sent yet. A started send can still
 * persist after shutdown or reload, so it keeps its lock until it settles.
 */
export declare function cancelUnsentWaiters(sessionId: string, reason: string): void;
export declare function _setStreamingAckTimeoutForTests(timeoutMs: number): void;
/** @internal test helper — cancel every wait and forget captured sends. */
export declare function _resetHostSendCaptureForTests(): void;
