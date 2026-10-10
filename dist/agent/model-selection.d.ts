import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ModelThinkingLevel } from "../model-spec.js";
import { type ModelTierConfig, type RankableModel } from "../model-tier-config.js";
import { type ModelSource, type PreSpawnModelResolver } from "../pre-spawn-model.js";
/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (the workflow layer also
 *      folds agentType and phase models into it).
 *   2. options.tier — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. Inherited main model — with the inheritMainModel setting, untagged
 *      agents use the orchestrating session's model as of run start.
 *   4. Default tier — untagged agents use the configured "medium" tier, so a
 *      configured tier set affects the whole workflow, not only tagged agents.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for tests; WorkflowAgent passes a cwd-aware,
 * memoized loader so project tiers win.
 */
export declare function resolveAgentModelSpec(options: {
    model?: string;
    tier?: string;
}, mainModel: string | undefined, loadConfig?: () => ModelTierConfig | null, onTierWithoutConfig?: (tier: string) => void, routing?: {
    inheritMainModel?: boolean;
}): string | undefined;
/** The model-routing fields of one subagent call (a subset of AgentRunOptions). */
export interface ModelRequest {
    model?: string;
    tier?: string;
    thinking?: ModelThinkingLevel;
    modelSource?: ModelSource;
    preSpawnModel?: PreSpawnModelResolver;
    label?: string;
    onModelResolved?: (modelId: string) => void;
    onModelFallback?: (info: {
        tier: string;
        requestedSpec: string;
        source: "medium-tier" | "inherit-main";
    }) => void;
}
/** Routing settings fixed for one WorkflowAgent. */
export interface ModelRouting {
    mainModel?: string;
    inheritMainModel: boolean;
    preSpawnModel?: PreSpawnModelResolver;
    loadTierConfig: () => ModelTierConfig | null;
    /** Lists available models for the one-time notice about an unconfigured tier. */
    listModels: (registry: ModelRegistry) => RankableModel[];
}
/** The chosen model, or none to keep the session's settings default. */
export interface ModelChoice {
    model?: Model<any>;
    thinkingLevel?: ModelThinkingLevel;
}
/**
 * Model selection for one WorkflowAgent. A spec that does not resolve is handled
 * by who asked for it:
 * - An explicit model or tier (including phase routing, which only fills
 *   options.model when the user configured that phase), or a pre-spawn policy
 *   `use`, throws MODEL_NOT_FOUND. Resolution is deterministic, so retrying is
 *   pointless, and silently substituting another model would run real calls
 *   against weights the caller never chose.
 * - An untagged agent only reached the spec through an implicit route (the
 *   default medium tier or the inherited main model). It degrades to the
 *   session default rather than failing every untagged agent, and reports the
 *   degrade once through onModelFallback so it lands in the run's own log.
 */
export declare class AgentModelSelector {
    private readonly routing;
    private warnedImplicitRouteUnavailable;
    constructor(routing: ModelRouting);
    select(request: ModelRequest, registry: ModelRegistry): Promise<ModelChoice>;
}
