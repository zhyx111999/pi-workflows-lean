import { randomUUID } from "node:crypto";
import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, createCodingTools, DefaultPackageManager, DefaultResourceLoader, getAgentDir, ModelRegistry, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { Check, Convert } from "typebox/value";
import { compactAgentHistory } from "./agent-history.js";
import { agentUsageEquals, createEmptyAgentUsage, sumAgentUsage } from "./agent-usage.js";
import { pinChildCacheRetention } from "./child-cache-retention.js";
import { applyToolPolicy } from "./agent-registry.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { canonicalModelSpec, formatModelSpecWithThinking, resolveModelSpecWithThinking, validateThinkingLevel, } from "./model-spec.js";
import { formatTierFallbackNotice, loadModelTierConfig, resolveTierModel, } from "./model-tier-config.js";
import { applyPreSpawnModel, classifyModelSource, getPreSpawnModelResolver, } from "./pre-spawn-model.js";
import { createStructuredOutputTool } from "./structured-output.js";
const LIVE_USAGE_EMIT_INTERVAL_MS = 250;
/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1])
        return fence[1].trim();
    const start = text.search(/[{[]/);
    if (start === -1)
        return undefined;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === open)
            depth++;
        else if (text[i] === close && --depth === 0)
            return text.slice(start, i + 1);
    }
    return undefined;
}
/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated(text, schema) {
    const json = findJsonBlock(text);
    if (json === undefined)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return undefined;
    }
    try {
        const converted = Convert(schema, parsed);
        if (Check(schema, converted))
            return converted;
    }
    catch {
        // typebox can throw on exotic schemas; treat as no match.
    }
    return undefined;
}
/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role !== "assistant")
            continue;
        return { stopReason: message.stopReason, errorMessage: message.errorMessage };
    }
    return undefined;
}
/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages, label) {
    const err = lastAssistantError(messages);
    if (err?.stopReason !== "error")
        return;
    const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
    if (!matched)
        return;
    throw new WorkflowError(err.errorMessage ?? "Provider usage/quota limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false, agentLabel: label, resetHint });
}
/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput(session, capture, schema, options, lastText) {
    if (capture.called)
        return capture.value;
    const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
    // Restrict to the schema tool so the only useful next action is calling it
    // (takes effect on the next prompt turn). Best-effort.
    try {
        session.setActiveToolsByName?.(["structured_output"]);
    }
    catch {
        // ignore — the re-prompt alone still drives most models to comply
    }
    for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
        if (options.signal?.aborted)
            throw new Error("Subagent was aborted");
        await session.prompt("You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.");
    }
    if (capture.called)
        return capture.value;
    const extracted = extractValidated(lastText(session.messages), schema);
    if (extracted !== undefined) {
        console.warn("[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model");
        return extracted;
    }
    // A repair re-prompt can itself hit the provider limit. Surface that as the real
    // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
    throwIfProviderLimit(session.messages, options.label);
    throw new WorkflowError("Subagent did not produce valid structured_output after repair attempts", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false, agentLabel: options.label });
}
/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. SESSION MODEL (opt-in) — with the inheritMainModel setting, untagged
 *      agents instead inherit the orchestrating session's main model as of
 *      run start (no tier config needed). With no main model set, the legacy
 *      route below applies. An unavailable inherited model still degrades
 *      loudly via onModelFallback rather than throwing.
 *   4. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to the global file.
 * WorkflowAgent passes a cwd-aware overlay loader so project tiers win.
 */
export function resolveAgentModelSpec(options, mainModel, loadConfig = loadModelTierConfig, onTierWithoutConfig, routing) {
    if (options.model)
        return options.model;
    if (options.tier) {
        // Tier requested but unconfigured → it silently falls back to mainModel.
        // Let the caller surface that (once) so the no-op is discoverable.
        const config = loadConfig();
        if (!config)
            onTierWithoutConfig?.(options.tier);
        return (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel;
    }
    // Untagged agent with inheritance enabled: the session's current main model.
    if (routing?.inheritMainModel && mainModel)
        return mainModel;
    // Untagged agent: default to the configured medium tier when one exists.
    const config = loadConfig();
    if (config) {
        const medium = resolveTierModel("medium", config);
        if (medium)
            return medium;
    }
    return undefined;
}
/** Child sessions load no host extensions unless explicitly opted in. */
export const DEFAULT_PROVIDER_MIDDLEWARE_EXTENSIONS = Object.freeze([]);
const RECURSIVE_SUBAGENT_EXTENSION_NAMES = new Set(["pi-dynamic-workflows", "workflow", "pi-subagents"]);
/**
 * Keep only explicitly approved provider/auth middleware paths. Recursive
 * orchestration extensions are always rejected, even if explicitly allowlisted.
 */
export function isProviderMiddlewareExtensionPath(extensionPath, allowlist, packageSource) {
    const allowed = new Set(allowlist.map((name) => name.trim().toLowerCase()).filter(Boolean));
    const segments = extensionPath
        .replaceAll("\\", "/")
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.toLowerCase());
    const file = segments.at(-1)?.replace(/\.(?:[cm]?[jt]s)$/i, "");
    if ([...segments, file ?? ""].some((name) => RECURSIVE_SUBAGENT_EXTENSION_NAMES.has(name)))
        return false;
    // Ancestor directory names are not extension identities: an allowlisted
    // name appearing in a project/home path must not approve all descendants.
    const identities = new Set(file ? [file] : []);
    const moduleIndex = segments.lastIndexOf("node_modules");
    const packageName = segments[moduleIndex + 1];
    if (moduleIndex >= 0 && packageName) {
        identities.add(packageName.startsWith("@") ? `${packageName}/${segments[moduleIndex + 2] ?? ""}` : packageName);
    }
    if (packageSource) {
        const source = packageSource.replaceAll("\\", "/").toLowerCase();
        const npmName = /^npm:((?:@[^/]+\/)?[^@]+)(?:@.*)?$/.exec(source)?.[1];
        const sourceName = npmName ??
            source
                .replace(/[?#].*$/, "")
                .replace(/\/+$/, "")
                .split("/")
                .at(-1)
                ?.replace(/\.git$/, "");
        if (sourceName)
            identities.add(sourceName);
    }
    if ([...identities].some((name) => RECURSIVE_SUBAGENT_EXTENSION_NAMES.has(name)))
        return false;
    return [...identities].some((name) => allowed.has(name));
}
export function filterProviderMiddlewareExtensions(base, allowlist, packageSources = new Map()) {
    return {
        ...base,
        extensions: base.extensions.filter((extension) => isProviderMiddlewareExtensionPath(extension.path, allowlist, packageSources.get(extension.path))),
    };
}
// omp's ModelRegistry is auth-storage-backed (no pi >= 0.80.8 sync-facade /
// runtime split): build it directly from the discovered AuthStorage. The
// disk-backed fallback is built lazily; sync callers see [] until it resolves
// and real specs on later reads.
let fallbackRuntimePromise;
let fallbackRegistry;
function ensureFallbackRegistry() {
    if (!fallbackRuntimePromise) {
        const dir = getAgentDir();
        // Same auth.json/models.json createAgentSession uses by default, so a model
        // resolved here carries valid credentials. Three host shapes, tried in
        // order; only a real registry ever resolves:
        // 1. omp's bundled pi exports discoverAuthStorage (auth-storage-backed
        //    registry, no runtime split).
        // 2. Legacy pi (< 0.80.8) had a static ModelRegistry.create({ dir }).
        // 3. pi >= 0.80.8 splits registry/runtime: ModelRuntime.create() then
        //    new ModelRegistry(runtime).
        fallbackRuntimePromise = (async () => {
            // Dynamic import on purpose: discoverAuthStorage exists only in omp's
            // bundled pi; a static named import would fail to resolve on stock pi,
            // and the host shape must be feature-detected at runtime.
            const ompExports = (await import("@earendil-works/pi-coding-agent").catch(() => undefined));
            if (typeof ompExports?.discoverAuthStorage === "function") {
                const authStorage = (await ompExports.discoverAuthStorage(dir));
                return new ModelRegistry(authStorage);
            }
            const legacyCreate = ModelRegistry.create;
            if (typeof legacyCreate === "function")
                return legacyCreate({ dir });
            const runtimeCreate = ompExports?.ModelRuntime?.create;
            if (typeof runtimeCreate === "function") {
                // No options: defaults to getAgentDir()/auth.json and models.json —
                // the same disk layout the omp and legacy paths read.
                return new ModelRegistry(await runtimeCreate());
            }
            throw new Error("[workflow] no ModelRegistry construction path in @earendil-works/pi-coding-agent (expected discoverAuthStorage, ModelRegistry.create, or ModelRuntime.create)");
        })();
        // Don't cache a rejection: a transient failure (e.g. auth.json lock) would
        // otherwise wedge the fallback for the rest of the process.
        fallbackRuntimePromise.catch(() => {
            fallbackRuntimePromise = undefined;
        });
    }
    return fallbackRuntimePromise.then((registry) => {
        fallbackRegistry ??= registry;
        return registry;
    });
}
/**
 * The ModelRuntime behind a registry facade (pi >= 0.80.8 shape: ModelRegistry
 * wraps a ModelRuntime but exposes no getter). Subagent sessions need it to
 * share the host session's exact catalog and auth. omp's fork is
 * auth-storage-backed (registry has no `runtime` field and createAgentSession
 * takes modelRegistry instead), so this returns undefined there and callers
 * pass the registry itself.
 */
export function runtimeOf(registry) {
    return registry.runtime;
}
/**
 * List the user's currently available models (those with auth configured) with
 * the minimal fields tier ranking needs: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built (or while the disk-backed fallback is still initializing).
 */
export function listAvailableModels(registry) {
    try {
        const modelRegistry = registry ?? fallbackRegistry;
        if (!modelRegistry) {
            // Kick off the async fallback build; this call reports [] and later
            // calls (e.g. the tool's lazy promptGuidelines re-reads) see real specs.
            void ensureFallbackRegistry().catch(() => { });
            return [];
        }
        return modelRegistry.getAvailable().map((model) => ({
            spec: canonicalModelSpec(model),
            costOutput: model.cost?.output,
            contextWindow: model.contextWindow,
        }));
    }
    catch {
        return [];
    }
}
/**
 * List the user's currently available models as `provider/modelId` specs. Used
 * to tell the workflow author which models it may route agents to. Best-effort:
 * returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(registry) {
    return listAvailableModels(registry).map((model) => model.spec);
}
/**
 * Emitted at most once per process: when an agent asks for a tier but no
 * model-tiers.json exists, the tier silently falls back to the session model.
 * Surface that once (with the mapping the user would get by configuring) so the
 * no-op is discoverable. Diagnostics only — never lets a failure break a run.
 */
let warnedTierUnconfigured = false;
function warnTierUnconfiguredOnce(mainModel, registry) {
    if (warnedTierUnconfigured)
        return;
    warnedTierUnconfigured = true;
    try {
        console.warn(formatTierFallbackNotice(mainModel, listAvailableModels(registry)));
    }
    catch {
        // best-effort diagnostic
    }
}
/**
 * Emitted at most once per process when persistAgentSessions is enabled and a
 * session is actually persisted: full subagent transcripts (which may include
 * secrets or other sensitive context) are being written to disk. Surface the
 * privacy trade-off at run time, not only in the docs.
 */
let warnedPersistSecrets = false;
function warnPersistSecretsOnce(sessionDir) {
    if (warnedPersistSecrets)
        return;
    warnedPersistSecrets = true;
    console.warn(`[workflow] persistAgentSessions is ON: full subagent transcripts (which may include secrets or other sensitive context) are being written to disk under ${sessionDir}. Disable persistAgentSessions if that isn't intended.`);
}
/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined — instead of a zero
 * breakdown — lets displays fall back to their scalar token count, so setups
 * on non-reporting providers render the same as before the split existed.
 */
export function usageFromStats(stats) {
    const { tokens, cost } = stats;
    if (tokens.total <= 0 && cost <= 0)
        return undefined;
    return {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        total: tokens.total,
        cost,
    };
}
function estimateStreamingAssistantUsage(event) {
    if (event.type !== "message_update" && event.type !== "message_end") {
        return undefined;
    }
    if (event.message.role !== "assistant") {
        return undefined;
    }
    const reported = event.message.usage;
    const reportedTotal = reported.input + reported.output + reported.cacheRead + reported.cacheWrite;
    if (reportedTotal > 0 || reported.cost.total > 0) {
        return {
            input: reported.input,
            output: reported.output,
            cacheRead: reported.cacheRead,
            cacheWrite: reported.cacheWrite,
            total: reportedTotal,
            cost: reported.cost.total,
        };
    }
    let streamedCharacters = 0;
    for (const content of event.message.content) {
        if (content.type === "text") {
            streamedCharacters += content.text.length;
        }
        else if (content.type === "thinking") {
            streamedCharacters += content.thinking.length;
        }
        else if (content.type === "toolCall") {
            streamedCharacters += JSON.stringify(content.arguments).length;
        }
    }
    if (streamedCharacters === 0) {
        return undefined;
    }
    const estimatedOutput = Math.max(1, Math.ceil(streamedCharacters / 4));
    // Character heuristic, not a provider measurement — tag it (#209).
    return {
        input: 0,
        output: estimatedOutput,
        cacheRead: 0,
        cacheWrite: 0,
        total: estimatedOutput,
        cost: 0,
        estimated: true,
    };
}
function subtractSessionUsageStats(stats, baseline) {
    if (!baseline) {
        return stats;
    }
    return {
        tokens: {
            input: Math.max(0, stats.tokens.input - baseline.tokens.input),
            output: Math.max(0, stats.tokens.output - baseline.tokens.output),
            cacheRead: Math.max(0, stats.tokens.cacheRead - baseline.tokens.cacheRead),
            cacheWrite: Math.max(0, stats.tokens.cacheWrite - baseline.tokens.cacheWrite),
            total: Math.max(0, stats.tokens.total - baseline.tokens.total),
        },
        cost: Math.max(0, stats.cost - baseline.cost),
    };
}
/**
 * Combine usage from completed messages with the current streaming message.
 * AgentSession notifies subscribers before it appends a message_end event to
 * SessionManager, so the event's assistant usage is absent from stats and must
 * be added exactly once. The real-session regression test pins this ordering.
 */
function usageFromSessionProgress(stats, event) {
    const persisted = usageFromStats(stats);
    const streaming = estimateStreamingAssistantUsage(event);
    if (!streaming) {
        return persisted;
    }
    return sumAgentUsage(persisted ?? createEmptyAgentUsage(), streaming);
}
/**
 * Orchestration tools ALWAYS denied to workflow subagents. The `subagents` and
 * `subagents_control` tools are registered globally by the extension, so — unless
 * excluded — a subagent's session sees them and can start or steer independent
 * background runs. Those nested runs recursively fan out and are NOT bounded
 * by the parent run's maxAgents / concurrency / progress / accounting, and can
 * drain a shared provider quota and pile up paused runs (#107). Callers may deny
 * additional tool names via WorkflowAgentOptions.excludeTools.
 */
export const DEFAULT_EXCLUDED_SUBAGENT_TOOLS = ["subagents", "subagents_control"];
/** Process-global subagent id counter: unique across concurrent workflow runs. */
let workflowAgentSeq = 0;
/**
 * The full subagent tool denylist: the always-on defaults plus any names the
 * caller added (via WorkflowAgentOptions.excludeTools) or set on the injected
 * session options. Extracted so the merge — and its order — is unit-testable;
 * a spread-order regression that dropped the defaults would slip past a test
 * that only asserts the constant. The SDK dedupes, so overlap is harmless.
 */
/**
 * Refuse a run directory that Windows would silently swap for another one.
 * fs calls reach it literally, but process creation normalizes the path: it
 * drops a single trailing period from inner segments and all trailing periods
 * and spaces from the last segment. The agent's shell would then run in a
 * different (possibly existing) directory than its file tools.
 */
function assertProcessesStartIn(cwd, label) {
    if (process.platform !== "win32")
        return;
    const segments = cwd.split("\\");
    const startsIn = segments
        .map((segment, index) => index === segments.length - 1 ? segment.replace(/[. ]+$/, "") : segment.replace(/([^.])\.$/, "$1"))
        .join("\\");
    if (startsIn === cwd)
        return;
    throw new WorkflowError(`agent cwd "${cwd}" cannot be used on Windows: processes started there run in "${startsIn}", because Windows drops trailing dots and spaces from path segments`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false, agentLabel: label });
}
export function subagentExcludedTools(extra, sessionExclude) {
    return [...DEFAULT_EXCLUDED_SUBAGENT_TOOLS, ...(sessionExclude ?? []), ...(extra ?? [])];
}
export class WorkflowAgent {
    cwd;
    baseTools;
    /** Extra subagent tool-name denylist, merged with the always-on defaults. */
    excludeTools;
    providerMiddlewareExtensions;
    sessionOptions;
    persistAgentSessions;
    instructions;
    mainModel;
    inheritMainModel;
    preSpawnModel;
    /** Shared registry from the host session, when provided. */
    sharedRegistry;
    /** Frozen host session file used for child-session lineage in this run. */
    parentSessionFile;
    /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
    registry;
    /**
     * Memoized model-tiers.json snapshot, boxed so a legitimately-null config
     * (file absent/invalid) is distinguishable from "not loaded yet". See
     * loadTierConfig() below for why this is scoped per-instance.
     */
    tierConfigBox;
    /**
     * Resource loaders shared by subagents using the same directory in this run. See
     * getSharedResourceLoader — this is the #109 memory mitigation.
     */
    resourceLoaders = new Map();
    /**
     * Emitted at most once per instance (~= once per run, see the class-level
     * lifetime note above): an untagged agent's implicit route — the default
     * "medium" tier, or the inherited main model when inheritMainModel is on —
     * resolved to a model spec that isn't available. Deliberately per-instance
     * rather than a MODEL_NOT_FOUND throw — an untagged agent never asked for
     * that specific model, so a broken implicit route shouldn't fail every
     * untagged agent in the run. See onModelFallback below for the (still-loud)
     * degrade path.
     */
    warnedImplicitRouteUnavailable = false;
    /**
     * Named conversations live for this WorkflowAgent instance. Production creates
     * one instance per workflow invocation; embedders that inject and reuse an
     * agent are responsible for choosing the longer thread lifetime deliberately.
     */
    threadSessions = new Map();
    activeThreads = new Set();
    /** Unique per-instance identity: agent ids must never collide across WorkflowAgent instances. */
    agentInstanceId = randomUUID();
    constructor(options = {}) {
        this.cwd = options.cwd ?? process.cwd();
        this.baseTools = options.tools ?? createCodingTools(this.cwd);
        this.excludeTools = options.excludeTools ?? [];
        this.providerMiddlewareExtensions = [
            ...(options.providerMiddlewareExtensions ?? DEFAULT_PROVIDER_MIDDLEWARE_EXTENSIONS),
        ];
        this.sessionOptions = options.session ?? {};
        this.persistAgentSessions = options.persistAgentSessions ?? false;
        this.instructions = options.instructions;
        this.mainModel = options.mainModel;
        this.inheritMainModel = options.inheritMainModel ?? false;
        this.preSpawnModel = options.preSpawnModel;
        this.sharedRegistry = options.modelRegistry;
        this.parentSessionFile = options.parentSessionFile;
    }
    /**
     * A resource loader shared per directory within this run (#109).
     *
     * Without a resourceLoader, createAgentSession() builds a fresh loader per
     * subagent and re-runs every installed extension factory. By default we keep
     * host extensions disabled. When opted in, resolve configured paths without
     * loading factories, then pass only allowlisted middleware paths as explicit
     * additions to a `noExtensions: true` loader. Recursive orchestration factories
     * never load, even if explicitly allowlisted.
     *
     * Extension-free loaders remain shared to avoid the churn fixed by #109.
     * Skills, prompts, AGENTS.md context, and workflow-supplied `customTools` remain
     * available. Other host extension-registered tools stay excluded. Allowlisted
     * middleware must be trusted and child-safe; this is not a sandbox. Opted-in
     * loaders are session-local: the SDK binds session actions into their runtime,
     * so sharing one would send a child's extension actions into another child.
     */
    getSharedResourceLoader(agentDir, cwd = this.cwd) {
        const key = JSON.stringify([agentDir, cwd]);
        const shared = this.providerMiddlewareExtensions.length === 0;
        const existing = shared ? this.resourceLoaders.get(key) : undefined;
        if (existing) {
            // LRU-by-touch: keep hot entries (base cwd) resident ahead of one-off
            // worktree loaders when pruneSharedResourceLoaders evicts.
            this.resourceLoaders.delete(key);
            this.resourceLoaders.set(key, existing);
            return existing;
        }
        return this.buildSharedResourceLoader(agentDir, cwd, key);
    }
    /**
     * Bound the loader memo (audit2 #41): worktree isolation gives every agent
     * a unique cwd, so N worktree agents would otherwise retain N
     * fully-reloaded loaders until run end. LRU-by-touch (hits re-insert in
     * getSharedResourceLoader) keeps the hot entries — the base cwd is touched
     * by every default call — while one-off worktree loaders are evicted first.
     */
    static MAX_SHARED_RESOURCE_LOADERS = 8;
    pruneSharedResourceLoaders() {
        while (this.resourceLoaders.size > WorkflowAgent.MAX_SHARED_RESOURCE_LOADERS) {
            const oldest = this.resourceLoaders.keys().next().value;
            if (oldest === undefined)
                return;
            this.resourceLoaders.delete(oldest);
        }
    }
    buildSharedResourceLoader(agentDir, cwd, key) {
        const shared = this.providerMiddlewareExtensions.length === 0;
        const pending = (async () => {
            const settingsManager = this.sessionOptions.settingsManager ?? SettingsManager.create(cwd, agentDir);
            let middlewarePaths = [];
            const packageSources = new Map();
            if (this.providerMiddlewareExtensions.length > 0) {
                await settingsManager.reload();
                const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
                const configured = await packageManager.resolve();
                middlewarePaths = configured.extensions
                    .filter((extension) => extension.enabled)
                    .filter((extension) => {
                    const source = extension.metadata.origin === "package" ? extension.metadata.source : undefined;
                    if (source)
                        packageSources.set(extension.path, source);
                    return isProviderMiddlewareExtensionPath(extension.path, this.providerMiddlewareExtensions, source);
                })
                    .map((extension) => extension.path);
            }
            const loader = new DefaultResourceLoader({
                cwd,
                agentDir,
                settingsManager,
                noExtensions: true,
                additionalExtensionPaths: middlewarePaths,
                extensionsOverride: (base) => filterProviderMiddlewareExtensions(base, this.providerMiddlewareExtensions, packageSources),
            });
            await loader.reload();
            return loader;
        })().catch((err) => {
            // Don't let a transient build failure (e.g. EMFILE during reload's disk
            // I/O) poison every subagent AND every retry of this run — clear the memo
            // so the next caller rebuilds instead of replaying the same rejection.
            // An evicted older build must not delete a newer entry for this key.
            if (shared && this.resourceLoaders.get(key) === pending)
                this.resourceLoaders.delete(key);
            throw err;
        });
        if (shared) {
            this.resourceLoaders.set(key, pending);
            this.pruneSharedResourceLoaders();
        }
        return pending;
    }
    /**
     * Resolve the registry for a run: an explicit per-run registry wins, then the
     * constructor's shared registry, then a lazily-built disk registry (shared
     * shared across calls once built). Async because omp builds registries from an
     * async-discovered AuthStorage.
     */
    async getRegistry(perRunRegistry) {
        if (perRunRegistry) {
            return perRunRegistry;
        }
        if (this.sharedRegistry) {
            return this.sharedRegistry;
        }
        if (!this.registry) {
            this.registry = await ensureFallbackRegistry();
        }
        return this.registry;
    }
    /**
     * Read+parse the cwd-aware model-tiers overlay at most once for this
     * instance's lifetime, instead of on every run() call. `resolveAgentModelSpec`
     * previously received `loadModelTierConfig` directly (sync existsSync +
     * readFileSync + JSON.parse from disk), which it calls unconditionally for
     * any agent without an explicit options.model — so a large fan-out did N
     * redundant synchronous disk reads that blocked the event loop and stalled
     * concurrent agents' I/O.
     *
     * `runWorkflow()` constructs a fresh `WorkflowAgent` per run (see
     * `new WorkflowAgent(options)` in workflow.ts, unless a caller injects its
     * own `options.agent` runner — a test-only escape hatch per
     * WorkflowManagerOptions.agent's doc comment), so a WorkflowAgent instance's
     * lifetime is one run in production. Memoizing on `this` therefore has the
     * same scope and lifetime as the agentRegistry snapshot workflow.ts already
     * takes once per run "for determinism" — the config file isn't expected to
     * change mid-run, and two different runs (= two different WorkflowAgent
     * instances) each get their own fresh read of whatever is on disk at the
     * time, so this does not leak stale config across runs or break tests that
     * construct fresh agents with different configs.
     *
     * `loader` is injectable for tests (defaults to the real disk read); it is
     * only ever consulted once, on the first call, regardless of what is passed
     * on later calls.
     */
    loadTierConfig(loader) {
        if (!this.tierConfigBox) {
            const read = loader ?? (() => loadModelTierConfig({ cwd: this.cwd }));
            this.tierConfigBox = { value: read() };
        }
        return this.tierConfigBox.value;
    }
    /**
     * Session manager for one subagent run. File-backed (persisted under the
     * standard sessions dir, keyed by the runner's project cwd — never a
     * per-call worktree cwd) when persistAgentSessions is on; in-memory otherwise.
     *
     * SessionManager.create() only creates the session directory — the SDK writes
     * the session file lazily (synchronous fs calls, uncaught) on the first
     * assistant message, deep inside session.prompt(). A failure there would
     * otherwise throw mid-run and abort this subagent. Probe writability up front
     * so any create/write failure (permissions, disk full) degrades this single
     * agent to an in-memory session instead — the run continues, just without a
     * persisted transcript.
     */
    createSessionManager(thread, cwd) {
        if (thread) {
            // runTurn always supplies its already-canonical runCwd. Keep the legacy
            // direct helper path (used by embedders that let SessionManager create a
            // project directory lazily) intact when no per-call cwd was supplied.
            const threadCwd = cwd === undefined ? this.cwd : realpathSync(cwd);
            const existing = this.threadSessions.get(thread);
            if (existing) {
                if (existing.cwd !== threadCwd) {
                    throw new WorkflowError(`agent thread "${thread}" cannot change cwd from "${existing.cwd}" to "${threadCwd}"`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
                }
                return existing.manager;
            }
            const manager = this.createSessionManager();
            this.threadSessions.set(thread, { manager, cwd: threadCwd });
            return manager;
        }
        let manager;
        if (!this.persistAgentSessions) {
            manager = SessionManager.inMemory();
        }
        else {
            try {
                manager = SessionManager.create(this.cwd);
                // SessionManager.create() starts a fresh session without lineage. Reset
                // it before createAgentSession() so the child header records the host
                // session, while retaining the default behavior for ephemeral parents.
                if (this.parentSessionFile) {
                    manager.newSession({ parentSession: this.parentSessionFile });
                }
                this.assertSessionDirWritable(manager.getSessionDir());
                warnPersistSecretsOnce(manager.getSessionDir());
            }
            catch (error) {
                console.warn(`[workflow] persistAgentSessions: could not persist this agent's session (${error instanceof Error ? error.message : String(error)}); continuing with an in-memory session`);
                manager = SessionManager.inMemory();
            }
        }
        return manager;
    }
    /** Best-effort write probe: throws if the session directory isn't actually writable. */
    assertSessionDirWritable(dir) {
        const probePath = join(dir, `.write-probe-${randomUUID()}`);
        writeFileSync(probePath, "");
        unlinkSync(probePath);
    }
    /**
     * Unique AgentRegistry id for the next spawned subagent. Concurrent
     * createAgentSession calls that omit agentId all default to "Main" and race
     * on the process-global registry (omp: "Agent \"Main\" was replaced during
     * session initialization"). Unthreaded calls embed a per-process monotonic
     * sequence so retries and concurrent runs never reuse an id. Named threads
     * stay stable within one WorkflowAgent instance (a thread is one continuing
     * session) but embed the instance id, so separate instances/runs never
     * collide in the process-global registry.
     */
    agentIdFor(options, runCwd) {
        if (options.thread)
            return `workflow:${runCwd}:${this.agentInstanceId}:${options.thread}`;
        return `workflow:${runCwd}:${process.pid}:${++workflowAgentSeq}`;
    }
    async run(prompt, options = {}) {
        validateThinkingLevel(options.thinking);
        const thread = options.thread;
        if (thread && this.activeThreads.has(thread)) {
            throw new WorkflowError(`agent thread "${thread}" is already running; same-thread calls must be sequential`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
                recoverable: false,
                agentLabel: options.label,
            });
        }
        if (thread)
            this.activeThreads.add(thread);
        try {
            return await this.runTurn(prompt, options);
        }
        finally {
            if (thread)
                this.activeThreads.delete(thread);
        }
    }
    async runTurn(prompt, options = {}) {
        const capture = { called: false, value: undefined };
        // Per-call cwd (e.g. a worktree) needs coding tools bound to that directory,
        // since tools capture their cwd at construction and can't be relocated.
        const runCwd = realpathSync(options.cwd ?? this.cwd);
        assertProcessesStartIn(runCwd, options.label);
        let usesBaseDirectory = false;
        try {
            usesBaseDirectory = runCwd === realpathSync(this.cwd);
        }
        catch {
            // An explicitly selected existing directory can outlive the constructor's
            // original directory. Its tools must not depend on that old path existing.
        }
        const baseTools = usesBaseDirectory ? this.baseTools : createCodingTools(runCwd);
        // Apply the agentType tool policy BEFORE adding structured_output, so a
        // restrictive allowlist never strips the schema tool.
        const customTools = applyToolPolicy([...baseTools, ...(options.tools ?? [])], options.toolNames, options.disallowedToolNames);
        // System tools bypass the allowlist/denylist filter (e.g. shared-store tools).
        if (options.systemTools?.length) {
            customTools.push(...options.systemTools);
        }
        if (options.schema) {
            // Strict OpenAI-compatible providers (e.g. DeepSeek) reject a tool whose top-level
            // parameters schema isn't a JSON object with a transport-level 400, before any of
            // this file's SCHEMA_NONCOMPLIANCE/empty-output classification ever runs. Fail fast
            // here instead, so a script's non-object opts.schema surfaces a clear workflow error.
            const schemaType = options.schema.type;
            if (schemaType !== "object") {
                throw new WorkflowError(`agent() opts.schema must be a top-level JSON object schema (type: "object") — got type: ${schemaType ?? "undefined"}; wrap array/primitive results in an object, e.g. { type: "object", properties: { items: <your schema> } }`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
            }
            customTools.push(createStructuredOutputTool({ schema: options.schema, capture }));
        }
        // Per-run modelRegistry wins over the constructor's shared registry, then
        // the lazily-built disk fallback. Used for tier diagnostics, model
        // resolution, and the subagent session's runtime below.
        const modelRegistry = await this.getRegistry(options.modelRegistry);
        // Resolve the model spec (explicit model > tier > inherited main model /
        // implicit medium tier > session default). This
        // composes with phase-based routing in workflow.ts, which only supplies
        // options.model when a phase pattern matches — so an explicit model wins.
        let modelSpec = resolveAgentModelSpec(options, this.mainModel, () => this.loadTierConfig(), () => warnTierUnconfiguredOnce(this.mainModel, modelRegistry), { inheritMainModel: this.inheritMainModel });
        const modelSource = classifyModelSource({
            model: options.model,
            tier: options.tier,
            resolvedModel: modelSpec,
            modelSource: options.modelSource,
        });
        const resolver = options.preSpawnModel ?? this.preSpawnModel ?? getPreSpawnModelResolver();
        let pinAfterPolicy = Boolean(options.model || options.tier);
        let policySelectedSpec;
        if (resolver) {
            const decision = await applyPreSpawnModel(resolver, {
                requestedModel: options.model,
                ...(options.thinking !== undefined ? { requestedThinking: options.thinking } : {}),
                tier: options.tier,
                resolvedModel: modelSpec,
                modelSource,
                label: options.label,
            });
            if (decision.action === "use") {
                modelSpec = decision.model;
                pinAfterPolicy = true;
                policySelectedSpec = decision.model;
            }
        }
        // Resolve a requested model spec to a Model object. Specs use Pi CLI-style
        // parsing, including an optional :thinking suffix such as gpt-5.5:xhigh.
        //
        // A given-but-unresolved spec's behavior is asymmetric by design (#131):
        //   - options.model or options.tier was explicitly set by the script (or by
        //     workflow.ts's phase-based routing, which only ever supplies
        //     options.model when the user configured that phase) → throw
        //     MODEL_NOT_FOUND naming the source. Resolution is deterministic, so
        //     retrying the same spec is pointless (recoverable:false), and a silent
        //     substitution would otherwise run real API calls against a different
        //     (or unauthenticated) model while the caller believes its pin/tier was
        //     honored.
        //   - neither was set: the agent is UNTAGGED and only got routed through
        //     an implicit route — the default "medium" tier (consulted because
        //     *some other* agent's tier is configured), or the inherited main
        //     model when inheritMainModel is on (see resolveAgentModelSpec). This
        //     agent never asked for that model, so a broken implicit route
        //     degrades to the session default instead of failing every untagged
        //     agent in the run — but the degrade still needs to be loud
        //     (onModelFallback, with source naming the route), not a silent
        //     continuation.
        const isExplicitRequest = pinAfterPolicy;
        let resolvedModel;
        let resolvedThinkingLevel;
        if (modelSpec) {
            const resolved = resolveModelSpecWithThinking(modelSpec, modelRegistry, {
                preferredProvider: this.mainModel?.split("/", 1)[0],
            });
            if (resolved.warning)
                console.warn(`[workflow] ${resolved.warning}`);
            if (!resolved.model) {
                if (isExplicitRequest) {
                    // Policy `use` pins the spec: name that spec, not the original tier/model.
                    // Otherwise a session/default `use` would report `tier "undefined"`.
                    const message = policySelectedSpec
                        ? `Model "${modelSpec}" selected by preSpawnModel policy was not found. Use /workflows-models to choose an available model.`
                        : options.model
                            ? (resolved.error ??
                                `Model "${modelSpec}" not found. Use /workflows-models to choose an available model.`)
                            : `tier "${options.tier}" from model-tiers.json resolves to "${modelSpec}", which is not available. Use /workflows-models to choose an available model.`;
                    throw new WorkflowError(message, WorkflowErrorCode.MODEL_NOT_FOUND, {
                        recoverable: false,
                        agentLabel: options.label,
                    });
                }
                if (!this.warnedImplicitRouteUnavailable) {
                    this.warnedImplicitRouteUnavailable = true;
                    options.onModelFallback?.({
                        tier: "medium",
                        requestedSpec: modelSpec,
                        source: this.inheritMainModel && this.mainModel ? "inherit-main" : "medium-tier",
                    });
                }
            }
            else {
                resolvedModel = resolved.model;
                resolvedThinkingLevel = resolved.thinkingLevel ?? options.thinking;
                options.onModelResolved?.(resolved.thinkingLevel !== undefined || options.thinking === undefined
                    ? (resolved.resolvedSpec ?? canonicalModelSpec(resolved.model))
                    : formatModelSpecWithThinking(resolved.resolvedSpec ?? canonicalModelSpec(resolved.model), options.thinking));
            }
        }
        resolvedThinkingLevel ??= options.thinking;
        const agentDir = getAgentDir();
        // Key persisted sessions by the runner's project cwd (this.cwd), NOT the
        // per-call runCwd: agents working in short-lived git worktrees should still
        // group under the project's session dir instead of scattering across
        // temporary worktree paths.
        const sessionManager = this.createSessionManager(options.thread, runCwd);
        const effectiveSessionManager = options.thread || !this.sessionOptions.sessionManager ? sessionManager : this.sessionOptions.sessionManager;
        // Capture the child identity from SessionManager immediately, before the
        // first prompt/usage event. In-memory sessions intentionally report no file.
        options.onSessionCreated?.({
            sessionId: effectiveSessionManager.getSessionId(),
            sessionFile: effectiveSessionManager.isPersisted() ? effectiveSessionManager.getSessionFile() : undefined,
        });
        const threadLeaf = options.thread ? sessionManager.getLeafId() : null;
        // Host split: pi >= 0.80.8 createAgentSession takes modelRuntime, not a
        // registry — hand over the registry's backing runtime so subagents share
        // the host catalog and auth. omp's fork is auth-storage-backed (registry
        // has no `.runtime`; it takes modelRegistry instead). Never spread
        // `modelRuntime: undefined` — it would shadow createAgentSession's own
        // default runtime.
        const modelRuntime = runtimeOf(modelRegistry);
        let session;
        try {
            ({ session } = await createAgentSession({
                cwd: runCwd,
                agentDir,
                sessionManager,
                // Use real SettingsManager to inherit user's default provider/model settings.
                // SettingsManager.inMemory() doesn't load ~/.pi/settings.json, so subagents
                // would fall back to the first available model (e.g. openai-codex) which may
                // not have valid auth, causing silent empty responses.
                settingsManager: SettingsManager.create(runCwd, agentDir),
                customTools,
                // Shared per-run loader with opt-in provider middleware (#109) — see
                // getSharedResourceLoader. An injected resourceLoader (tests / embedders)
                // wins and skips the shared build entirely; the ...this.sessionOptions
                // spread below re-applies the same injected value harmlessly.
                resourceLoader: this.sessionOptions.resourceLoader ?? (await this.getSharedResourceLoader(agentDir, runCwd)),
                // Host split (see modelRuntime above): stock pi takes modelRuntime;
                // omp's fork takes modelRegistry. Spread-cast keeps the runtime value
                // while satisfying the upstream CreateAgentSessionOptions type.
                ...(modelRuntime ? { modelRuntime } : { modelRegistry }),
                ...this.sessionOptions,
                ...(options.cwd !== undefined ? { cwd: runCwd } : {}),
                // The computed AgentRegistry id must win over any injected
                // sessionOptions value: a stable embedder-supplied agentId would
                // collide across runs in the process-global registry. `agentId` is
                // omp-fork-only (absent from upstream 0.83 types this package builds
                // against); spread-cast keeps the runtime value while satisfying the
                // upstream CreateAgentSessionOptions type.
                ...{ agentId: this.agentIdFor(options, runCwd) },
                // Named threads must retain their own manager even when an embedder
                // supplied a default manager for ordinary one-shot calls — the
                // sessionOptions spread above would otherwise overwrite the cached
                // thread manager with the injected one, breaking turn continuity and
                // failed-turn rollback.
                ...(options.thread ? { sessionManager } : {}),
                // Per-call model/thinking wins over any sessionOptions defaults.
                ...(resolvedModel ? { model: resolvedModel } : {}),
                ...(resolvedThinkingLevel ? { thinkingLevel: resolvedThinkingLevel } : {}),
                // Deny recursive-orchestration tools in the subagent (#107). Placed after
                // the sessionOptions spread so it always applies; folds in any denylist
                // the caller set on sessionOptions rather than dropping it.
                excludeTools: subagentExcludedTools(this.excludeTools, this.sessionOptions.excludeTools),
            }));
        }
        catch (error) {
            if (options.thread)
                this.restoreThreadLeaf(sessionManager, threadLeaf);
            throw error;
        }
        pinChildCacheRetention(session.agent);
        const disposeSession = async () => {
            try {
                // dispose() alone does not emit shutdown; give opted-in factories a
                // chance to release session-local listeners and other resources.
                await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            }
            catch {
                // Cleanup must not replace the original result or failure.
            }
            finally {
                session.dispose();
            }
        };
        // Child sessions do not auto-bind a supplied ResourceLoader. Bind middleware
        // before the first provider request (also supports injected resource loaders).
        try {
            await session.bindExtensions({});
        }
        catch (error) {
            await disposeSession();
            if (options.thread)
                this.restoreThreadLeaf(sessionManager, threadLeaf);
            throw error;
        }
        const usageBeforeTurn = options.thread ? session.getSessionStats() : undefined;
        // This turn's own transcript, collected from message_end events below rather
        // than sliced out of session.messages with a pre-prompt() length snapshot.
        // Auto-compaction (on by default) can rewrite session.messages inside
        // prompt() — the array is rebuilt shorter (summary + kept tail) — so any
        // index captured here goes stale and a slice from it comes back empty,
        // misclassifying a successful turn as AGENT_EMPTY_OUTPUT and rolling back a
        // threaded turn that actually landed. Events are append-only per turn, so
        // the collected window survives compaction, and it naturally spans the
        // schema path's repair re-prompts, which run on this same session.
        const turnMessages = [];
        // Name the persisted session so it's identifiable in session pickers.
        // Skip when an injected session.sessionManager override won (tests/embedders),
        // and name a threaded session only on its first turn.
        if (this.persistAgentSessions &&
            (!this.sessionOptions.sessionManager || options.thread) &&
            (!options.thread || !threadLeaf) &&
            options.sessionName) {
            try {
                sessionManager.appendSessionInfo(options.sessionName);
            }
            catch {
                // Naming is best-effort; never fail the run over it.
            }
        }
        let removeAbortListener;
        let removeHistoryListener;
        let removeTurnListener;
        let lastHistoryEmit = 0;
        let threadTurnSucceeded = false;
        let removeSessionListener;
        let unregisterSteer;
        let lastUsageProgressEmit = 0;
        let lastProgressUsage;
        const emitHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
        const maybeEmitHistory = () => {
            if (!options.onHistory)
                return;
            const now = Date.now();
            if (now - lastHistoryEmit < 250)
                return;
            lastHistoryEmit = now;
            emitHistory();
        };
        const emitUsageProgress = (event) => {
            if (!options.onUsageProgress) {
                return;
            }
            const now = Date.now();
            if (event.type === "message_update" &&
                lastProgressUsage &&
                now - lastUsageProgressEmit < LIVE_USAGE_EMIT_INTERVAL_MS) {
                return;
            }
            const usage = usageFromSessionProgress(subtractSessionUsageStats(session.getSessionStats(), usageBeforeTurn), event);
            if (!usage || (lastProgressUsage && agentUsageEquals(lastProgressUsage, usage))) {
                return;
            }
            lastUsageProgressEmit = now;
            lastProgressUsage = usage;
            options.onUsageProgress(usage);
        };
        const emitSessionProgress = (event) => {
            maybeEmitHistory();
            try {
                emitUsageProgress(event);
            }
            catch {
                // Usage progress is best-effort; never let stats failure interrupt the agent.
            }
        };
        try {
            // When no spec resolved (untagged → settings-default binding, an
            // implicit-route degrade, or a requested tier that resolved to
            // nothing), the display so far shows the pre-resolution mainModel guess
            // and nothing corrects it — onModelResolved above only fires for agents
            // WITH a resolvable spec. Report the session's REAL bound model now
            // that it exists, so /workflows, the persisted run record, and the
            // journal stop displaying a model the agent never ran (#167's fix
            // covered the spec'd paths only). Inside the lifecycle try so a
            // throwing host callback cannot leak the session (finally disposes it).
            if (!resolvedModel && session.model) {
                options.onModelResolved?.(formatModelSpecWithThinking(canonicalModelSpec(session.model), resolvedThinkingLevel));
            }
            if (options.signal?.aborted)
                throw new Error("Subagent was aborted");
            unregisterSteer = options.registerSteer?.((text) => session.steer(text));
            if (options.signal) {
                const onAbort = () => void session.abort();
                options.signal.addEventListener("abort", onAbort, { once: true });
                removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
            }
            if (options.onHistory || options.onUsageProgress) {
                removeSessionListener = session.subscribe(emitSessionProgress);
            }
            removeTurnListener = session.subscribe((event) => {
                if (event.type === "message_end")
                    turnMessages.push(event.message);
            });
            await session.prompt(this.buildPrompt(prompt, options, Boolean(options.schema)));
            if (options.signal?.aborted)
                throw new Error("Subagent was aborted");
            // The SDK buries a provider usage/quota limit in the assistant message rather
            // than throwing; detect it here (before the schema/empty-text branches) so it
            // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
            // (schema path) or a silent empty-output null (non-schema path).
            throwIfProviderLimit(session.messages, options.label);
            if (options.schema) {
                const result = (await resolveStructuredOutput(session, capture, options.schema, options, () => this.lastAssistantText(turnMessages)));
                threadTurnSucceeded = true;
                return result;
            }
            // Unstructured result: require assistant text AFTER the last tool result.
            // Text emitted before it is stale progress (the agent's last real action was
            // a tool call) — accepting it would report an incomplete run as successful
            // and suppress the AGENT_EMPTY_OUTPUT retry (#111). A threaded session's
            // restored transcript never enters turnMessages, so an empty turn cannot
            // reuse an old answer.
            const text = this.finalAssistantText(turnMessages);
            if (!text.trim()) {
                throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                    recoverable: true,
                    agentLabel: options.label,
                });
            }
            threadTurnSucceeded = true;
            return text;
        }
        finally {
            unregisterSteer?.();
            removeAbortListener?.();
            removeHistoryListener?.();
            removeTurnListener?.();
            removeSessionListener?.();
            try {
                emitHistory();
            }
            catch {
                // History is diagnostic only; never let it mask the real result/error.
            }
            if (options.thread && !threadTurnSucceeded) {
                this.restoreThreadLeaf(sessionManager, threadLeaf);
            }
            // Read real usage before disposing — dispose tears down the session state.
            if (options.onUsage) {
                try {
                    const stats = session.getSessionStats();
                    const usage = usageFromStats(subtractSessionUsageStats(stats, usageBeforeTurn));
                    if (usage)
                        options.onUsage(usage);
                }
                catch {
                    // Usage is best-effort; never let stats failure mask the real result/error.
                }
            }
            await disposeSession();
        }
    }
    restoreThreadLeaf(sessionManager, leafId) {
        if (leafId)
            sessionManager.branch(leafId);
        else
            sessionManager.resetLeaf();
    }
    buildPrompt(prompt, options, structured) {
        const parts = [this.instructions, options.instructions, prompt].filter(Boolean);
        if (structured) {
            parts.push([
                "Final output contract:",
                "- Your final action MUST be a structured_output tool call.",
                "- The structured_output arguments are the return value of this subagent.",
                "- Do not emit a prose final answer instead of structured_output.",
                "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
            ].join("\n"));
        }
        return parts.join("\n\n");
    }
    lastAssistantText(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message?.role !== "assistant" || !Array.isArray(message.content))
                continue;
            const text = message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
            if (text.trim())
                return text;
        }
        return "";
    }
    /**
     * The unstructured agent's FINAL answer: assistant text that appears after the
     * last tool result. Text before the final tool result is stale progress (the
     * agent's last real action was a tool call, not answering), so returning it
     * would mask an incomplete run and suppress AGENT_EMPTY_OUTPUT retries (#111).
     *
     * Distinct from lastAssistantText(), which stays deliberately lenient — the
     * schema path's prose-JSON recovery (resolveStructuredOutput) may need to read
     * the structured payload out of any assistant message, not only the terminal one.
     */
    finalAssistantText(messages) {
        // Locate the last tool result; only assistant text strictly after it counts.
        let lastToolResult = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === "toolResult") {
                lastToolResult = i;
                break;
            }
        }
        for (let i = messages.length - 1; i > lastToolResult; i--) {
            const message = messages[i];
            if (message?.role !== "assistant" || !Array.isArray(message.content))
                continue;
            const text = message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
            if (text.trim())
                return text;
        }
        return "";
    }
}
