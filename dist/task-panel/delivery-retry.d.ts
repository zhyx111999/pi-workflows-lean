/** Bounded backoff retries for results whose send or marker clear did not go through. */
import { type SessionDeliveryEndpoint } from "./delivery-endpoints.js";
/**
 * Retry a run's delivery on the same endpoint generation after the next backoff
 * delay. `flush` runs only if that endpoint is still live and unsuspended; a
 * rebind starts its own flush, so retries never cross generations.
 */
export declare function scheduleDeliveryRetry(runId: string, sessionId: string, generation: number, flush: (endpoint: SessionDeliveryEndpoint) => void): void;
export declare function cancelDeliveryRetry(runId: string): void;
export declare function cancelSessionRetries(sessionId: string): void;
/** @internal test helper — stop every pending retry timer. */
export declare function _resetDeliveryRetriesForTests(): void;
