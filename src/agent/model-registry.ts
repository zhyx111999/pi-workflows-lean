// Builds the disk-backed fallback ModelRegistry and reads a registry's backing runtime across pi host shapes.
import { getAgentDir, ModelRegistry, type ModelRuntime } from "@earendil-works/pi-coding-agent";

// Built lazily on first use; synchronous readers see undefined until it resolves.
let fallbackRegistryPromise: Promise<ModelRegistry> | undefined;
let fallbackRegistry: ModelRegistry | undefined;

/** The fallback registry once it has been built, else undefined. */
export function builtFallbackRegistry(): ModelRegistry | undefined {
  return fallbackRegistry;
}

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
export function ensureFallbackRegistry(): Promise<ModelRegistry> {
  if (!fallbackRegistryPromise) {
    const dir = getAgentDir();
    fallbackRegistryPromise = (async () => {
      // Dynamic import on purpose: discoverAuthStorage exists only in omp's
      // bundled pi; a static named import would fail to resolve on stock pi,
      // and the host shape must be feature-detected at runtime.
      const ompExports = (await import("@earendil-works/pi-coding-agent").catch(() => undefined)) as
        | {
            discoverAuthStorage?: (dir: string) => Promise<unknown>;
            ModelRuntime?: { create?: (options?: unknown) => Promise<ModelRuntime> };
          }
        | undefined;
      if (typeof ompExports?.discoverAuthStorage === "function") {
        const authStorage = (await ompExports.discoverAuthStorage(dir)) as ConstructorParameters<
          typeof ModelRegistry
        >[0];
        return new ModelRegistry(authStorage);
      }
      const legacyCreate = (
        ModelRegistry as unknown as {
          create?: (opts: { dir: string }) => Promise<ModelRegistry>;
        }
      ).create;
      if (typeof legacyCreate === "function") return legacyCreate({ dir });
      const runtimeCreate = ompExports?.ModelRuntime?.create;
      if (typeof runtimeCreate === "function") {
        // No options: defaults to getAgentDir()/auth.json and models.json —
        // the same disk layout the omp and legacy paths read.
        return new ModelRegistry(await runtimeCreate());
      }
      throw new Error(
        "[workflow] no ModelRegistry construction path in @earendil-works/pi-coding-agent (expected discoverAuthStorage, ModelRegistry.create, or ModelRuntime.create)",
      );
    })();
    // Don't cache a rejection: a transient failure (e.g. auth.json lock) would
    // otherwise wedge the fallback for the rest of the process.
    fallbackRegistryPromise.catch(() => {
      fallbackRegistryPromise = undefined;
    });
  }
  return fallbackRegistryPromise.then((registry) => {
    fallbackRegistry ??= registry;
    return registry;
  });
}

/**
 * The ModelRuntime behind a registry facade (pi 0.80.8+ wraps a ModelRuntime but
 * exposes no getter). Subagent sessions need it to share the host session's exact
 * catalog and auth. omp's registry is auth-storage-backed and has no runtime, so
 * this returns undefined there and callers pass the registry itself.
 */
export function runtimeOf(registry: ModelRegistry): unknown {
  return (registry as unknown as { runtime?: unknown }).runtime;
}
