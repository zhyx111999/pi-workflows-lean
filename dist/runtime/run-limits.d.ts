/** Turns host-supplied run settings into the bounded limits the runtime enforces, including the concurrency gate. */
import type { WorkflowRunOptions } from "../workflow.js";
/**
 * Per-attempt timeout. An embedding host's invalid value must not fail the run
 * (or spawn and instantly abort sessions), so it falls back to the default and logs.
 */
export declare function resolveAgentTimeoutMs(options: Pick<WorkflowRunOptions, "agentTimeoutMs" | "onLog">): number | null;
/** Concurrent agents, clamped to 1..MAX_CONCURRENCY; defaults to the core count minus two. */
export declare function resolveConcurrency(value: number | undefined): number;
/** Retries after a recoverable failure, clamped to 0..MAX_AGENT_RETRIES. */
export declare function normalizeAgentRetries(value: unknown): number;
/** Grace for the aborted drain: Infinity waits forever; NaN, 0, negatives and overflow use the default. */
export declare function resolveDrainAbortGraceMs(value: number | undefined): number;
/**
 * Wait before retrying after `failedAttempt`. Immediate retries let a whole
 * parallel() batch hammer the provider together, so the default backs off
 * exponentially. A host override of 0 disables the wait; negative, non-finite
 * or throwing overrides use the default.
 */
export declare function retryBackoffMs(failedAttempt: number, options: Pick<WorkflowRunOptions, "agentRetryBackoffMs">): number;
/** Run at most `limit` tasks at once; later callers queue in arrival order. */
export declare function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T>;
