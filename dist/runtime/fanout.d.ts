/** Implements parallel() and pipeline(): fan-outs that turn recoverable branch failures into null. */
import type { RunContext } from "./run-context.js";
/**
 * Cancellation flag of one parallel()/pipeline() call. When a fan-out breaches
 * maxAgents, the breaching agent() throws and the fan-out rejects, but agents
 * it already reserved would keep waiting in the limiter and then spend money.
 * They check this flag before dispatch and bail instead.
 */
export interface FanoutBatch {
    cancelled: boolean;
}
/**
 * The batch of the innermost fan-out enclosing the caller. agent() must read it
 * synchronously, before it suspends on the limiter and loses the caller's context.
 */
export declare function currentFanoutBatch(): FanoutBatch | undefined;
/** Build the script's parallel() global: run thunks concurrently. */
export declare function createParallel(ctx: RunContext): (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
/** Build the script's pipeline() global: pass each item through the stages in order, items concurrently. */
export declare function createPipeline(ctx: RunContext): (items: unknown[], ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>) => Promise<unknown[]>;
