/** Implements parallel() and pipeline(): fan-outs that turn recoverable branch failures into null. */
import { AsyncLocalStorage } from "node:async_hooks";
import { WorkflowCheckpointSuspensionError, WorkflowErrorCode, wrapError } from "../errors.js";
/**
 * Each fan-out runs its branches inside its own batch, so a breach cancels only
 * that fan-out's queued agents: a concurrent sibling or an enclosing fan-out
 * keeps running its already-reserved agents (still within maxAgents overall).
 */
const fanoutScope = new AsyncLocalStorage();
/**
 * The batch of the innermost fan-out enclosing the caller. agent() must read it
 * synchronously, before it suspends on the limiter and loses the caller's context.
 */
export function currentFanoutBatch() {
    return fanoutScope.getStore();
}
/** Build the script's parallel() global: run thunks concurrently. */
export function createParallel(ctx) {
    return async (thunks) => {
        ctx.throwIfAborted();
        if (!Array.isArray(thunks))
            throw new TypeError("parallel() expects an array of functions");
        if (thunks.some((thunk) => typeof thunk !== "function")) {
            throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
        }
        const batch = { cancelled: false };
        return fanoutScope.run(batch, () => Promise.all(thunks.map(async (thunk, index) => {
            try {
                return await thunk();
            }
            catch (error) {
                return settleBranchFailure(ctx, batch, error, `parallel[${index}]`);
            }
        })));
    };
}
/** Build the script's pipeline() global: pass each item through the stages in order, items concurrently. */
export function createPipeline(ctx) {
    return async (items, ...stages) => {
        ctx.throwIfAborted();
        if (!Array.isArray(items))
            throw new TypeError("pipeline() expects an array as the first argument");
        if (stages.some((stage) => typeof stage !== "function")) {
            throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
        }
        const batch = { cancelled: false };
        return fanoutScope.run(batch, () => Promise.all(items.map(async (item, index) => {
            let value = item;
            for (const stage of stages) {
                try {
                    ctx.throwIfAborted();
                    value = await stage(value, item, index);
                    ctx.throwIfAborted();
                }
                catch (error) {
                    return settleBranchFailure(ctx, batch, error, `pipeline[${index}]`);
                }
            }
            return value;
        })));
    };
}
/**
 * A recoverable branch failure becomes null so the other branches still count.
 * Suspensions, aborts and non-recoverable errors propagate and halt the run,
 * exactly like a directly awaited agent(); only a breached agent cap also
 * cancels the rest of this batch, since other errors do not doom it.
 */
function settleBranchFailure(ctx, batch, error, branch) {
    if (error instanceof WorkflowCheckpointSuspensionError)
        throw error;
    if (ctx.isAborted())
        throw error;
    const workflowError = wrapError(error);
    if (!workflowError.recoverable) {
        if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED)
            batch.cancelled = true;
        throw workflowError;
    }
    ctx.log(`${branch} failed: ${workflowError.message}`);
    return null;
}
