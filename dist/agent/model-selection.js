import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { canonicalModelSpec, formatModelSpecWithThinking, resolveModelSpecWithThinking, } from "../model-spec.js";
import { formatTierFallbackNotice, loadModelTierConfig, resolveTierModel, } from "../model-tier-config.js";
import { runtimeOf } from "./model-registry.js";
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
export function resolveAgentModelSpec(options, mainModel, loadConfig = loadModelTierConfig, onTierWithoutConfig, routing) {
    if (options.model)
        return options.model;
    if (options.tier) {
        // An unconfigured tier silently falls back to mainModel; let the caller
        // surface that so the no-op is discoverable.
        const config = loadConfig();
        if (!config)
            onTierWithoutConfig?.(options.tier);
        return (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel;
    }
    if (routing?.inheritMainModel && mainModel)
        return mainModel;
    const config = loadConfig();
    if (config) {
        const medium = resolveTierModel("medium", config);
        if (medium)
            return medium;
    }
    return undefined;
}
/**
 * Model selection for one WorkflowAgent. A spec that does not resolve is handled
 * by who asked for it:
 * - An explicit model or tier (including phase routing, which only fills
 *   options.model when the user configured that phase) throws MODEL_NOT_FOUND. Resolution is deterministic, so retrying is
 *   pointless, and silently substituting another model would run real calls
 *   against weights the caller never chose.
 * - An untagged agent only reached the spec through an implicit route (the
 *   default medium tier or the inherited main model). It degrades to the
 *   session default rather than failing every untagged agent, and reports the
 *   degrade once through onModelFallback so it lands in the run's own log.
 */
export class AgentModelSelector {
    routing;
    warnedImplicitRouteUnavailable = false;
    constructor(routing) {
        this.routing = routing;
    }
    select(request, registry) {
        const { mainModel, inheritMainModel } = this.routing;
        const modelSpec = resolveAgentModelSpec(request, mainModel, this.routing.loadTierConfig, () => warnTierUnconfiguredOnce(mainModel, () => this.routing.listModels(registry)), { inheritMainModel });
        if (!modelSpec)
            return { thinkingLevel: request.thinking };
        // Pi CLI-style parsing, including an optional :thinking suffix such as gpt-5.5:xhigh.
        const resolved = resolveModelSpecWithThinking(modelSpec, runtimeOf(registry), {
            preferredProvider: mainModel?.split("/", 1)[0],
        });
        if (resolved.warning)
            console.warn(`[workflow] ${resolved.warning}`);
        if (!resolved.model) {
            if (request.model || request.tier) {
                const message = request.model
                    ? (resolved.error ?? `Model "${modelSpec}" not found. Use /workflows-models to choose an available model.`)
                    : `tier "${request.tier}" from model-tiers.json resolves to "${modelSpec}", which is not available. Use /workflows-models to choose an available model.`;
                throw new WorkflowError(message, WorkflowErrorCode.MODEL_NOT_FOUND, {
                    recoverable: false,
                    agentLabel: request.label,
                });
            }
            if (!this.warnedImplicitRouteUnavailable) {
                this.warnedImplicitRouteUnavailable = true;
                request.onModelFallback?.({
                    tier: "medium",
                    requestedSpec: modelSpec,
                    source: inheritMainModel && mainModel ? "inherit-main" : "medium-tier",
                });
            }
            return { thinkingLevel: request.thinking };
        }
        const spec = resolved.resolvedSpec ?? canonicalModelSpec(resolved.model);
        request.onModelResolved?.(resolved.thinkingLevel !== undefined || request.thinking === undefined
            ? spec
            : formatModelSpecWithThinking(spec, request.thinking));
        return { model: resolved.model, thinkingLevel: resolved.thinkingLevel ?? request.thinking };
    }
}
/**
 * Once per process: a requested tier without a model-tiers config silently runs
 * on the session model. Say so, with the mapping configuring tiers would give.
 * Diagnostics only; a failure here never breaks a run.
 */
let warnedTierUnconfigured = false;
function warnTierUnconfiguredOnce(mainModel, listModels) {
    if (warnedTierUnconfigured)
        return;
    warnedTierUnconfigured = true;
    try {
        console.warn(formatTierFallbackNotice(mainModel, listModels()));
    }
    catch {
        // best-effort diagnostic
    }
}
