import { ModelRegistry } from "@earendil-works/pi-coding-agent";
/** The fallback registry once it has been built, else undefined. */
export declare function builtFallbackRegistry(): ModelRegistry | undefined;
/**
 * Build (once per process) a registry from the same auth.json/models.json that
 * createAgentSession uses by default, so a model resolved here carries valid
 * credentials. Three host shapes are tried in order; only a real registry ever
 * resolves:
 * 1. omp's bundled pi exports discoverAuthStorage (auth-storage-backed registry).
 * 2. pi before 0.80.8 has a static ModelRegistry.create({ dir }).
 * 3. pi 0.80.8 and later split registry and runtime: ModelRuntime.create(), then
 *    new ModelRegistry(runtime).
 */
export declare function ensureFallbackRegistry(): Promise<ModelRegistry>;
/**
 * The ModelRuntime behind a registry facade (pi 0.80.8+ wraps a ModelRuntime but
 * exposes no getter). Subagent sessions need it to share the host session's exact
 * catalog and auth. omp's registry is auth-storage-backed and has no runtime, so
 * this returns undefined there and callers pass the registry itself.
 */
export declare function runtimeOf(registry: ModelRegistry): unknown;
