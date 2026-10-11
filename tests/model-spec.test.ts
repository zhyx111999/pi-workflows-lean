import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";
import fc from "fast-check";
import {
  formatModelSpecWithThinking,
  resolveModelSpecWithThinking,
  splitModelSpecThinking,
  THINKING_LEVELS,
} from "../src/model-spec.js";
import { catalogRuntime, catalogModel as model } from "./helpers/model-catalog.js";

const letters = "abcdefghijklmnopqrstuvwxyz".split("");
const identifierChars = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");
const segment = fc
  .tuple(fc.constantFrom(...letters), fc.array(fc.constantFrom(...identifierChars), { maxLength: 12 }))
  .map(([head, tail]) => `${head}${tail.join("")}`);
const providerSpec = segment;
const modelIdSpec = fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/"));
const thinkingSpec = fc.constantFrom(...THINKING_LEVELS);

describe("model spec thinking suffixes", () => {
  it("resolves provider/model:thinking using Pi CLI-style parsing", () => {
    const gpt55 = model("openai-codex", "gpt-5.5");
    const resolved = resolveModelSpecWithThinking(
      "openai-codex/gpt-5.5:xhigh",
      catalogRuntime([gpt55, model("openrouter", "openai/gpt-5.5-pro")]),
    );

    assert.equal(resolved.model, gpt55);
    assert.equal(resolved.thinkingLevel, "xhigh");
    assert.equal(resolved.resolvedSpec, "openai-codex/gpt-5.5:xhigh");
  });

  it("prefers the active provider for an unqualified fuzzy workflow model", () => {
    const gatewayLuna = model("vercel-ai-gateway", "openai/gpt-5.6-luna");
    const openrouterLunaPro = model("openrouter", "openai/gpt-5.6-luna-pro");

    const resolved = resolveModelSpecWithThinking("gpt-5.6-luna", catalogRuntime([gatewayLuna, openrouterLunaPro]), {
      preferredProvider: "vercel-ai-gateway",
    });

    assert.equal(resolved.model, gatewayLuna);
    assert.equal(resolved.resolvedSpec, "vercel-ai-gateway/openai/gpt-5.6-luna");
  });

  it("uses global fuzzy matching when the preferred provider has no match", () => {
    const openrouterLunaPro = model("openrouter", "openai/gpt-5.6-luna-pro");

    const resolved = resolveModelSpecWithThinking("gpt-5.6-luna", catalogRuntime([openrouterLunaPro]), {
      preferredProvider: "vercel-ai-gateway",
    });

    assert.equal(resolved.model, openrouterLunaPro);
  });

  it("resolves max as a Pi thinking level instead of a synthetic model id", () => {
    const gpt56 = model("openai-codex", "gpt-5.6-sol");
    const resolved = resolveModelSpecWithThinking("openai-codex/gpt-5.6-sol:max", catalogRuntime([gpt56]));

    assert.equal(resolved.model, gpt56);
    assert.equal(resolved.thinkingLevel, "max");
    assert.equal(resolved.resolvedSpec, "openai-codex/gpt-5.6-sol:max");
    assert.equal(resolved.warning, undefined);
  });

  it("does not strip colon suffixes from exact model ids", () => {
    const exactColonModel = model("openrouter", "some:model");
    const resolved = resolveModelSpecWithThinking("openrouter/some:model", catalogRuntime([exactColonModel]));

    assert.equal(resolved.model, exactColonModel);
    assert.equal(resolved.thinkingLevel, undefined);
    assert.equal(resolved.resolvedSpec, "openrouter/some:model");
  });

  it("uses Pi CLI-style custom provider model fallback without a thinking suffix", () => {
    const base = model("openai-codex", "gpt-5.5");
    const resolved = resolveModelSpecWithThinking("openai-codex/custom-model", catalogRuntime([base]));

    assert.equal(resolved.model?.provider, "openai-codex");
    assert.equal(resolved.model?.id, "custom-model");
    assert.equal(resolved.thinkingLevel, undefined);
    assert.equal(resolved.resolvedSpec, "openai-codex/custom-model");
    assert.match(resolved.warning ?? "", /Using custom model id/);
  });

  it("preserves valid thinking suffixes for custom provider model ids", () => {
    const base = model("openai-codex", "gpt-5.5");
    const resolved = resolveModelSpecWithThinking("openai-codex/custom-model:xhigh", catalogRuntime([base]));

    assert.equal(resolved.model?.provider, "openai-codex");
    assert.equal(resolved.model?.id, "custom-model");
    assert.equal(resolved.thinkingLevel, "xhigh");
    assert.equal(resolved.resolvedSpec, "openai-codex/custom-model:xhigh");
  });

  it("property: invalid thinking-like suffixes stay part of unregistered provider model ids", () => {
    fc.assert(
      fc.property(
        modelIdSpec,
        fc.constantFrom("notalevel", "x-high", "HIGH", "reasoning", "ultra"),
        (modelId, suffix) => {
          const base = model("openai-codex", "gpt-5.5");
          const customId = `${modelId}:${suffix}`;
          const resolved = resolveModelSpecWithThinking(`openai-codex/${customId}`, catalogRuntime([base]));

          assert.equal(resolved.model?.provider, "openai-codex");
          assert.equal(resolved.model?.id, customId);
          assert.equal(resolved.thinkingLevel, undefined);
          assert.equal(resolved.resolvedSpec, `openai-codex/${customId}`);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("formats and splits model specs with optional thinking", () => {
    assert.equal(formatModelSpecWithThinking("openai-codex/gpt-5.5", "xhigh"), "openai-codex/gpt-5.5:xhigh");
    assert.equal(formatModelSpecWithThinking("openai-codex/gpt-5.5", undefined), "openai-codex/gpt-5.5");

    assert.deepEqual(splitModelSpecThinking("openai-codex/gpt-5.5:xhigh", ["openai-codex/gpt-5.5"]), {
      modelSpec: "openai-codex/gpt-5.5",
      thinkingLevel: "xhigh",
    });
    assert.deepEqual(splitModelSpecThinking("openrouter/some:model", ["openrouter/some:model"]), {
      modelSpec: "openrouter/some:model",
      thinkingLevel: undefined,
    });
  });

  it("property: formatting then splitting a known model spec preserves model and thinking", () => {
    fc.assert(
      fc.property(
        providerSpec,
        modelIdSpec,
        fc.option(thinkingSpec, { nil: undefined }),
        (provider, modelId, thinking) => {
          const canonical = `${provider}/${modelId}`;
          const stored = formatModelSpecWithThinking(canonical, thinking);
          assert.deepEqual(splitModelSpecThinking(stored, [canonical]), {
            modelSpec: canonical,
            thinkingLevel: thinking,
          });
        },
      ),
      { numRuns: 150 },
    );
  });

  it("property: resolver agrees with formatter for arbitrary known provider/model specs", () => {
    fc.assert(
      fc.property(
        providerSpec,
        modelIdSpec,
        fc.option(thinkingSpec, { nil: undefined }),
        (provider, modelId, thinking) => {
          const knownModel = model(provider, modelId);
          const spec = formatModelSpecWithThinking(`${provider}/${modelId}`, thinking);
          const resolved = resolveModelSpecWithThinking(spec, catalogRuntime([knownModel]));
          assert.equal(resolved.model, knownModel);
          assert.equal(resolved.thinkingLevel, thinking);
          assert.equal(resolved.resolvedSpec, spec);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("property: exact model ids containing colons are not treated as thinking suffixes", () => {
    fc.assert(
      fc.property(providerSpec, segment, segment, (provider, left, right) => {
        const colonModelId = `${left}:${right}`;
        const knownModel = model(provider, colonModelId);
        const spec = `${provider}/${colonModelId}`;
        const resolved = resolveModelSpecWithThinking(spec, catalogRuntime([knownModel]));

        assert.equal(resolved.model, knownModel);
        assert.equal(resolved.thinkingLevel, undefined);
        assert.equal(resolved.resolvedSpec, spec);
        assert.deepEqual(splitModelSpecThinking(spec, [spec]), { modelSpec: spec, thinkingLevel: undefined });
      }),
      { numRuns: 150 },
    );
  });
});

describe("resolveModelSpecWithThinking delegates to the SDK's resolveCliModel", () => {
  // Without a preferred provider and without a thinking suffix, the workflow
  // resolver must answer exactly as `pi --model` does for the same catalog.
  const compoundIdSegment = fc.array(segment, { minLength: 1, maxLength: 2 }).map((parts) => parts.join("/"));

  it("property: matches the SDK across provider-name/vendor-prefix collisions and any auth", () => {
    fc.assert(
      fc.property(
        providerSpec,
        providerSpec,
        compoundIdSegment,
        compoundIdSegment,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (providerA, providerB, idA, idB, qualified, authA, authB) => {
          fc.pre(providerA !== providerB);
          // providerA is both a registered provider and the vendor prefix of an
          // id cataloged under providerB, the shape where provider inference and
          // the raw-id auth preference interact; idA is shared by both providers.
          const models = [model(providerA, idA), model(providerB, `${providerA}/${idB}`), model(providerB, idA)];
          const authenticated = new Set([...(authA ? [providerA] : []), ...(authB ? [providerB] : [])]);
          const runtime = catalogRuntime(models, authenticated);
          const spec = qualified ? `${providerA}/${idB}` : idA;

          const ours = resolveModelSpecWithThinking(spec, runtime);
          const sdk = resolveCliModel({ cliModel: spec, modelRuntime: runtime });

          assert.equal(ours.model, sdk.model, `model mismatch for spec "${spec}"`);
          assert.equal(ours.thinkingLevel, sdk.thinkingLevel);
          assert.equal(ours.error, sdk.error);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: matches the SDK on plain provider/model[:thinking] specs", () => {
    fc.assert(
      fc.property(
        providerSpec,
        modelIdSpec,
        fc.option(thinkingSpec, { nil: undefined }),
        (provider, modelId, thinking) => {
          const runtime = catalogRuntime([model(provider, modelId)]);
          const spec = formatModelSpecWithThinking(`${provider}/${modelId}`, thinking);

          const ours = resolveModelSpecWithThinking(spec, runtime);
          const sdk = resolveCliModel({ cliModel: spec, modelRuntime: runtime });

          assert.equal(ours.model, sdk.model);
          assert.equal(ours.thinkingLevel, sdk.thinkingLevel);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("resolveModelSpecWithThinking auth-aware raw-id preference", () => {
  // "moonshotai" is a native provider that catalogs "kimi-k3"; "openrouter"
  // catalogs the same string as a vendor-prefixed compound id.
  const moonshotaiNative = model("moonshotai", "kimi-k3");
  const openrouterCompound = model("openrouter", "moonshotai/kimi-k3");

  it("prefers an authenticated aggregator's literal compound id over an unauthenticated native provider match", () => {
    const resolved = resolveModelSpecWithThinking(
      "moonshotai/kimi-k3",
      catalogRuntime([moonshotaiNative, openrouterCompound], new Set(["openrouter"])),
    );

    assert.equal(resolved.model, openrouterCompound);
    assert.equal(resolved.resolvedSpec, "openrouter/moonshotai/kimi-k3");
  });

  it("keeps the native-provider match when neither provider is authenticated", () => {
    const resolved = resolveModelSpecWithThinking(
      "moonshotai/kimi-k3",
      catalogRuntime([moonshotaiNative, openrouterCompound], new Set()),
    );

    assert.equal(resolved.model, moonshotaiNative);
  });

  it("keeps the native-provider match when it is authenticated", () => {
    const resolved = resolveModelSpecWithThinking(
      "moonshotai/kimi-k3",
      catalogRuntime([moonshotaiNative, openrouterCompound]),
    );

    assert.equal(resolved.model, moonshotaiNative);
  });
});

describe("resolveModelSpecWithThinking with a bare id shared by several providers", () => {
  const copilot = model("github-copilot", "gpt-5.5");
  const codex = model("openai-codex", "gpt-5.5");
  const shared = [copilot, codex];
  const onlyCodex = new Set(["openai-codex"]);

  it("resolves to the only authenticated provider", () => {
    const resolved = resolveModelSpecWithThinking("gpt-5.5", catalogRuntime(shared, onlyCodex));

    assert.equal(resolved.model, codex);
    assert.equal(resolved.resolvedSpec, "openai-codex/gpt-5.5");
  });

  it("resolves to the only authenticated provider even when the main session's provider is another", () => {
    const resolved = resolveModelSpecWithThinking("gpt-5.5", catalogRuntime(shared, onlyCodex), {
      preferredProvider: "github-copilot",
    });

    assert.equal(resolved.model, codex);
  });

  it("resolves to the only authenticated provider when the id carries a thinking suffix", () => {
    for (const preferredProvider of [undefined, "github-copilot"]) {
      const resolved = resolveModelSpecWithThinking("gpt-5.5:high", catalogRuntime(shared, onlyCodex), {
        preferredProvider,
      });

      assert.equal(resolved.model, codex);
      assert.equal(resolved.thinkingLevel, "high");
      assert.equal(resolved.resolvedSpec, "openai-codex/gpt-5.5:high");
    }
  });

  it("reports the ambiguity when several providers are authenticated and none is preferred", () => {
    for (const spec of ["gpt-5.5", "gpt-5.5:high"]) {
      const resolved = resolveModelSpecWithThinking(spec, catalogRuntime(shared));

      assert.equal(resolved.model, undefined);
      assert.match(
        resolved.error ?? "",
        /ambiguous across providers: github-copilot\/gpt-5\.5, openai-codex\/gpt-5\.5/,
      );
    }
  });

  it("settles the ambiguity on the main session's provider", () => {
    const resolved = resolveModelSpecWithThinking("gpt-5.5:xhigh", catalogRuntime(shared), {
      preferredProvider: "github-copilot",
    });

    assert.equal(resolved.model, copilot);
    assert.equal(resolved.resolvedSpec, "github-copilot/gpt-5.5:xhigh");
  });

  it("never settles an ambiguous id on a different model of the main session's provider", () => {
    const resolved = resolveModelSpecWithThinking(
      "gpt-5.5",
      catalogRuntime([...shared, model("openrouter", "gpt-5.5-mini")]),
      {
        preferredProvider: "openrouter",
      },
    );

    assert.equal(resolved.model, undefined);
    assert.match(resolved.error ?? "", /ambiguous/);
  });
});

describe("resolveModelSpecWithThinking main-provider preference limits", () => {
  it("does not replace an exact id in another provider with a fuzzy match in the main provider", () => {
    const exact = model("openai", "gpt-5");
    const resolved = resolveModelSpecWithThinking(
      "gpt-5",
      catalogRuntime([exact, model("openrouter", "openai/gpt-5-mini")]),
      {
        preferredProvider: "openrouter",
      },
    );

    assert.equal(resolved.model, exact);
  });

  it("does not redirect a provider-qualified spec", () => {
    const native = model("openai", "gpt-5.6-luna");
    const resolved = resolveModelSpecWithThinking(
      "openai/gpt-5.6-luna",
      catalogRuntime([native, model("openrouter", "openai/gpt-5.6-luna")]),
      { preferredProvider: "openrouter" },
    );

    assert.equal(resolved.model, native);
  });

  it("does not invent a custom model id under the main provider", () => {
    const resolved = resolveModelSpecWithThinking(
      "no-such-model",
      catalogRuntime([model("openrouter", "openai/gpt-5")]),
      {
        preferredProvider: "openrouter",
      },
    );

    assert.equal(resolved.model, undefined);
    assert.match(resolved.error ?? "", /not found/);
  });
});
