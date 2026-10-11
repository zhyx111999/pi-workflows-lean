import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRegistry, type ModelRuntime } from "@earendil-works/pi-coding-agent";

/** A catalog entry with only the fields model resolution reads. */
export function catalogModel(provider: string, id: string, name = id): Model<Api> {
  return { provider, id, name } as Model<Api>;
}

/**
 * A ModelRuntime serving a fixed catalog, for resolving specs without building
 * a real runtime per property-test run. It implements the members the SDK's
 * resolveCliModel and the workflow resolver read; the cast is needed only
 * because ModelRuntime has a private constructor. Providers in `authenticated`
 * have configured auth; without the set, every provider does.
 */
export function catalogRuntime(models: readonly Model<Api>[], authenticated?: ReadonlySet<string>): ModelRuntime {
  const hasAuth = (providerId: string) => authenticated?.has(providerId) ?? true;
  return {
    getModels: (providerId?: string) =>
      providerId === undefined ? models : models.filter((model) => model.provider === providerId),
    getModel: (providerId: string, modelId: string) =>
      models.find((model) => model.provider === providerId && model.id === modelId),
    hasConfiguredAuth: hasAuth,
    getAvailableSnapshot: () => models.filter((model) => hasAuth(model.provider)),
  } as unknown as ModelRuntime;
}

/** The extension-facing registry facade over catalogRuntime, as the host hands it to WorkflowAgent. */
export function catalogRegistry(models: readonly Model<Api>[], authenticated?: ReadonlySet<string>): ModelRegistry {
  return new ModelRegistry(catalogRuntime(models, authenticated));
}
