import { WorkflowError, WorkflowErrorCode } from "./errors.js";
const PROCESS_RESOLVER_SLOT = Symbol.for("@quintinshaw/pi-dynamic-workflows.preSpawnModelResolver");
/** Process-wide host policy. Last write wins. Pass `undefined` to clear. Uses globalThis so src/dist duplicate copies still share one slot. */
export function setPreSpawnModelResolver(resolver) {
    const g = globalThis;
    if (resolver)
        g[PROCESS_RESOLVER_SLOT] = resolver;
    else
        delete g[PROCESS_RESOLVER_SLOT];
}
export function getPreSpawnModelResolver() {
    return globalThis[PROCESS_RESOLVER_SLOT];
}
export function classifyModelSource(input) {
    if (input.modelSource)
        return input.modelSource;
    if (input.model)
        return "explicit";
    if (input.tier)
        return "tier";
    if (input.resolvedModel)
        return "default";
    return "session";
}
/**
 * Run a host policy. Reject and unexpected throw never fall back to the
 * session/parent model — the caller must not createAgentSession afterwards.
 */
export async function applyPreSpawnModel(resolver, ctx) {
    let decision;
    try {
        decision = await resolver(ctx);
    }
    catch (error) {
        if (error instanceof WorkflowError)
            throw error;
        throw new WorkflowError(error instanceof Error ? error.message : String(error), WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: false,
            agentLabel: ctx.label,
        });
    }
    if (!decision || typeof decision !== "object" || typeof decision.action !== "string") {
        throw new WorkflowError("preSpawnModel returned an invalid decision", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: false,
            agentLabel: ctx.label,
        });
    }
    const action = decision.action;
    if (action !== "unchanged" && action !== "use" && action !== "reject") {
        throw new WorkflowError(`preSpawnModel returned unknown action "${action}"`, WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: false,
            agentLabel: ctx.label,
        });
    }
    if (decision.action === "reject") {
        throw new WorkflowError(decision.reason || "preSpawnModel rejected this agent spawn", WorkflowErrorCode.MODEL_SPAWN_REJECTED, {
            recoverable: false,
            agentLabel: ctx.label,
            details: { reason: decision.reason },
        });
    }
    if (decision.action === "use" && (typeof decision.model !== "string" || !decision.model.trim())) {
        throw new WorkflowError(`Model "${String(decision.model)}" not found. Use /workflows-models to choose an available model.`, WorkflowErrorCode.MODEL_NOT_FOUND, { recoverable: false, agentLabel: ctx.label });
    }
    return decision;
}
