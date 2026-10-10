/** Lists the models that have auth configured, in the SDK-agnostic shape tier ranking and the model picker use. */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RankableModel } from "../model-tier-config.js";
/**
 * List the user's currently available models (those with auth configured) with
 * the minimal fields tier ranking needs: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built (or while the disk-backed fallback is still initializing).
 */
export declare function listAvailableModels(registry?: ModelRegistry): RankableModel[];
/** The available models as `provider/modelId` specs, for telling a workflow author where agents may route. */
export declare function listAvailableModelSpecs(registry?: ModelRegistry): string[];
