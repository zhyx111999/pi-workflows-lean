/** Starts one attempt of a live agent() call: abort wiring, the runner request, and the attempt deadline. */
import type { createAgentCallUsageTracker } from "../agent-usage.js";
import type { AgentCall } from "./agent-execution.js";
import type { RunContext } from "./run-context.js";
type AttemptUsage = ReturnType<ReturnType<typeof createAgentCallUsageTracker>["startAttempt"]>;
/** The abort controller of one attempt and the way to detach it from the run's signals. */
export interface AttemptAbort {
    readonly signal: AbortSignal;
    readonly abort: () => void;
    readonly unlink: () => void;
}
/**
 * Each attempt gets its own controller so a timeout can dispose that session
 * (and release its messages) instead of leaving it streaming while a retry
 * starts another. It also follows the caller's signal (pause/stop/Esc) and the
 * run-fatal seal, so in-flight siblings of a lost run wind down. unlink() must
 * run when the attempt ends, or listeners pile up on the run's signals.
 */
export declare function linkAttemptAbort(ctx: RunContext): AttemptAbort;
/** Hand the call to the agent runner; every callback goes quiet once the run's terminal drain closes. */
export declare function dispatchAttempt(ctx: RunContext, call: AgentCall, cwd: string | undefined, signal: AbortSignal, usage: AttemptUsage): Promise<unknown>;
/**
 * Race the attempt against its deadline. `onTimeout` runs before the timeout
 * error wins so the caller can abort the session and free its resources; the
 * losing promise still settles later, and the caller awaits it before
 * committing usage or retrying.
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number | null, label: string, onTimeout?: () => void): Promise<T>;
export {};
