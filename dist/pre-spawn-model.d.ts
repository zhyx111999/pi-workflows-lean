import type { ModelThinkingLevel } from "./model-spec.js";
/**
 * How DW arrived at the model intent for this agent, before a host policy runs.
 *
 * - explicit: script `model` or agentType `model`
 * - tier: script `tier` with no explicit model
 * - phase: workflow phase/meta routing (`phases[].model` or `meta.model`)
 * - default: untagged implicit routing — the configured medium tier, or the
 *   inherited main model when the inheritMainModel setting is on (not a
 *   script-level pin)
 * - session: no resolved spec; createAgentSession will use the session default
 */
export type ModelSource = "explicit" | "tier" | "phase" | "default" | "session";
/** Minimal fields a host policy needs to decide. No session/history. */
export interface PreSpawnModelContext {
    requestedModel?: string;
    /** Separate caller/agent-type option; a selected model's suffix takes precedence. */
    requestedThinking?: ModelThinkingLevel;
    tier?: string;
    resolvedModel?: string;
    modelSource: ModelSource;
    label?: string;
}
export type PreSpawnModelDecision = {
    action: "unchanged";
} | {
    action: "use";
    model: string;
} | {
    action: "reject";
    reason: string;
};
export type PreSpawnModelResolver = (ctx: PreSpawnModelContext) => PreSpawnModelDecision | Promise<PreSpawnModelDecision>;
/** Process-wide host policy. Last write wins. Pass `undefined` to clear. Uses globalThis so src/dist duplicate copies still share one slot. */
export declare function setPreSpawnModelResolver(resolver: PreSpawnModelResolver | undefined): void;
export declare function getPreSpawnModelResolver(): PreSpawnModelResolver | undefined;
export declare function classifyModelSource(input: {
    model?: string;
    tier?: string;
    resolvedModel?: string;
    modelSource?: ModelSource;
}): ModelSource;
/**
 * Run a host policy. Reject and unexpected throw never fall back to the
 * session/parent model — the caller must not createAgentSession afterwards.
 */
export declare function applyPreSpawnModel(resolver: PreSpawnModelResolver, ctx: PreSpawnModelContext): Promise<PreSpawnModelDecision>;
