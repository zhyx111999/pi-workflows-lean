import { type CreateAgentSessionOptions, type LoadExtensionsResult, ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { type AgentHistoryEntry } from "./agent-history.js";
import { type AgentUsage } from "./agent-usage.js";
export type { AgentUsage } from "./agent-usage.js";
import { type ModelThinkingLevel } from "./model-spec.js";
import { type ModelTierConfig, type RankableModel } from "./model-tier-config.js";
import { type ModelSource, type PreSpawnModelResolver } from "./pre-spawn-model.js";
import { type StructuredOutputCapture } from "./structured-output.js";
/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export declare function extractValidated<T>(text: string, schema: TSchema): T | undefined;
/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export declare function lastAssistantError(messages: unknown[]): {
    stopReason?: string;
    errorMessage?: string;
} | undefined;
/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export declare function throwIfProviderLimit(messages: unknown[], label?: string): void;
/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
    prompt(text: string): Promise<void>;
    setActiveToolsByName?(names: string[]): void;
    messages: unknown[];
}
/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export declare function resolveStructuredOutput<T>(session: StructuredSession, capture: StructuredOutputCapture<T>, schema: TSchema, options: {
    maxSchemaRetries?: number;
    signal?: AbortSignal;
    label?: string;
}, lastText: (messages: unknown[]) => string): Promise<T>;
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
export declare function resolveAgentModelSpec(options: {
    model?: string;
    tier?: string;
}, mainModel: string | undefined, loadConfig?: () => ModelTierConfig | null, onTierWithoutConfig?: (tier: string) => void, routing?: {
    inheritMainModel?: boolean;
}): string | undefined;
/** Child sessions load no host extensions unless explicitly opted in. */
export declare const DEFAULT_PROVIDER_MIDDLEWARE_EXTENSIONS: readonly string[];
/**
 * Keep only explicitly approved provider/auth middleware paths. Recursive
 * orchestration extensions are always rejected, even if explicitly allowlisted.
 */
export declare function isProviderMiddlewareExtensionPath(extensionPath: string, allowlist: readonly string[], packageSource?: string): boolean;
export declare function filterProviderMiddlewareExtensions(base: LoadExtensionsResult, allowlist: readonly string[], packageSources?: ReadonlyMap<string, string>): LoadExtensionsResult;
export interface WorkflowAgentOptions {
    cwd?: string;
    /** Extra tools available to the subagent in addition to the structured output tool. */
    tools?: ToolDefinition[];
    /**
     * Extra tool NAMES to deny in the subagent session, on top of the always-on
     * defaults ({@link DEFAULT_EXCLUDED_SUBAGENT_TOOLS}). Lets the host exclude
     * other recursive-orchestration tools it registers (e.g. a pi-subagents tool)
     * so a workflow subagent can't fan out through them either (#107).
     */
    excludeTools?: string[];
    /**
     * Trusted provider/auth middleware extension names allowed in child sessions.
     * Defaults to [] (no host extensions). Recursive orchestration stays excluded.
     */
    providerMiddlewareExtensions?: string[];
    /**
     * Override createAgentSession dependencies (model, settingsManager, resourceLoader, etc.).
     * An explicit per-call cwd and the computed agent identity remain authoritative.
     */
    session?: Partial<CreateAgentSessionOptions>;
    /** Extra system guidance prepended to every subagent task. */
    instructions?: string;
    /**
     * The session's main model (`provider/modelId`). Used as a fallback when
     * resolving opts.tier and no model-tiers.json config exists, and as the
     * routing target for untagged agents when `inheritMainModel` is on.
     * Without this, a workflow using `{ tier: "small" }` would log a warning
     * and fall through to the session default when no config is saved yet.
     */
    mainModel?: string;
    /**
     * When true, untagged agents (no `model`, no `tier`) inherit `mainModel` —
     * the orchestrating session's model as of run start — instead of the
     * implicit medium tier (when configured) or the settings default. Mirrors
     * the inheritMainModel user setting; explicit model/tier tags are
     * unaffected, and an unavailable inherited model degrades to the settings
     * default with a run-visible warning instead of throwing.
     */
    inheritMainModel?: boolean;
    /**
     * Optional host policy run after DW model-intent resolution and before
     * createAgentSession. Per-instance; a per-run `AgentRunOptions.preSpawnModel`
     * overrides this, which overrides {@link setPreSpawnModelResolver}.
     */
    preSpawnModel?: PreSpawnModelResolver;
    /**
     * Shared model registry from the host Pi session. When provided, subagents
     * resolve tier/model specs against the same registry the main session uses,
     * including dynamically-registered providers such as ollama-cloud. Without
     * this, the agent builds an isolated registry from disk and may miss models
     * that are only available via extension registration.
     */
    modelRegistry?: ModelRegistry;
    /** Persisted host session file used as the parent of persistent child sessions. */
    parentSessionFile?: string;
    /**
     * Persist each subagent transcript as a real pi session file under the
     * standard sessions directory (keyed by the runner's project cwd), instead
     * of the default in-memory session that is discarded when the run ends.
     * Default: false (current behavior).
     */
    persistAgentSessions?: boolean;
}
/**
 * The ModelRuntime behind a registry facade (pi >= 0.80.8 shape: ModelRegistry
 * wraps a ModelRuntime but exposes no getter). Subagent sessions need it to
 * share the host session's exact catalog and auth. omp's fork is
 * auth-storage-backed (registry has no `runtime` field and createAgentSession
 * takes modelRegistry instead), so this returns undefined there and callers
 * pass the registry itself.
 */
export declare function runtimeOf(registry: ModelRegistry): unknown;
/**
 * List the user's currently available models (those with auth configured) with
 * the minimal fields tier ranking needs: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built (or while the disk-backed fallback is still initializing).
 */
export declare function listAvailableModels(registry?: ModelRegistry): RankableModel[];
/**
 * List the user's currently available models as `provider/modelId` specs. Used
 * to tell the workflow author which models it may route agents to. Best-effort:
 * returns [] if the registry can't be built.
 */
export declare function listAvailableModelSpecs(registry?: ModelRegistry): string[];
/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined — instead of a zero
 * breakdown — lets displays fall back to their scalar token count, so setups
 * on non-reporting providers render the same as before the split existed.
 */
export declare function usageFromStats(stats: {
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
    cost: number;
}): AgentUsage | undefined;
export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
    label?: string;
    /**
     * Display name recorded on the persisted session (session_info entry) when
     * `persistAgentSessions` is enabled, so transcripts are identifiable in
     * session pickers (e.g. `workflow:<runId> <label>`). Ignored for in-memory
     * sessions or when an explicit session.sessionManager override is injected.
     */
    sessionName?: string;
    schema?: TSchemaDef;
    tools?: ToolDefinition[];
    instructions?: string;
    signal?: AbortSignal;
    /**
     * Called as soon as the child SessionManager is created, before prompting.
     * The file is absent for in-memory sessions (and for a persistence fallback).
     */
    onSessionCreated?: (session: {
        sessionId: string;
        sessionFile?: string;
    }) => void;
    /** Called once before disposal with exact cumulative provider usage, when reported. */
    onUsage?: (usage: AgentUsage) => void;
    /**
     * Called with cumulative progress while the subagent runs. The current
     * streaming response uses an output-token estimate until the provider's exact
     * terminal usage replaces it.
     */
    onUsageProgress?: (usage: AgentUsage) => void;
    /**
     * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
     * bare `modelId`, parsed with the same grammar as Pi CLI's `--model`. When it
     * can't be resolved to a known model, `run()` throws MODEL_NOT_FOUND rather
     * than silently substituting the session default — a wrong-model run would
     * otherwise look successful while quietly answering with different (or
     * unauthenticated) weights. When omitted, the session default applies.
     */
    model?: string;
    /**
     * Pi thinking level. Used when `model` has no `:thinking` suffix.
     * A model-id suffix still wins.
     */
    thinking?: ModelThinkingLevel;
    /**
     * Model tier name (e.g. "small", "medium", "big"). When set (and no explicit
     * `model` is given), the model is resolved from the user's model-tiers.json
     * config before `run()` starts, falling back to the session's main model when
     * the tier has no configured entry. An explicit `model` always takes priority,
     * so workflow scripts can use `{ tier: "small" }` for coarse routing without
     * caring which concrete model backs that tier.
     *
     * A script-requested tier that resolves to an unavailable model spec is just
     * as loud as an explicit `model` pin — `run()` throws MODEL_NOT_FOUND naming
     * the tier and the spec it resolved to, e.g. `tier "big" from
     * model-tiers.json resolves to "deadprov/x", which is not available`.
     *
     * That's deliberately asymmetric with the IMPLICIT default tier an untagged
     * agent (neither `model` nor `tier` set) gets routed through: since the
     * script never asked for that tier, a broken default degrades to the
     * session default instead of failing every untagged agent in the run — see
     * onModelFallback below for how that degrade stays visible.
     */
    tier?: string;
    /**
     * Provenance of `model`/`tier` as known by the caller (workflow layer).
     * When omitted, {@link classifyModelSource} infers it from model/tier/resolved spec.
     */
    modelSource?: ModelSource;
    /** Per-run host policy; overrides the instance and process resolvers. */
    preSpawnModel?: PreSpawnModelResolver;
    /** Called with the resolved model id once known (for display/telemetry).
     * Also fires right after session creation with the session's REAL model when
     * no spec resolved (an untagged agent's settings-default binding, an
     * implicit-route degrade, or a requested tier that resolved to nothing) —
     * otherwise those agents would keep displaying the pre-resolution mainModel
     * guess for their whole lifetime. */
    onModelResolved?: (modelId: string) => void;
    /**
     * Called (at most once per WorkflowAgent instance) when an UNTAGGED agent's
     * implicit route — the default "medium" tier, or the inherited main model
     * when the inheritMainModel setting is on (source discriminates which) —
     * resolves to a model spec that isn't available. This is the one case that
     * degrades to the session default instead of throwing MODEL_NOT_FOUND (see
     * `tier` above) — but the degrade must still land in the run's own
     * log/event stream, not just a console.warn, or a broken implicit route
     * silently drifts every untagged agent's model with zero trace in the run
     * itself. In the payload, `tier` is the legacy medium-tier field and is only
     * meaningful when `source === "medium-tier"`; key on `source` instead.
     */
    onModelFallback?: (info: {
        tier: string;
        requestedSpec: string;
        source: "medium-tier" | "inherit-main";
    }) => void;
    /** Called with a compact snapshot of this subagent's message/tool history. */
    onHistory?: (history: AgentHistoryEntry[]) => void;
    /** Run this agent in a different working directory (e.g. an isolated worktree). */
    cwd?: string;
    /**
     * Restrict the subagent's coding tools to these names (an agentType
     * definition's `tools` allowlist). Undefined = all coding tools. The
     * structured_output tool is always added after this filter, so a schema
     * still works under a restrictive allowlist.
     */
    toolNames?: string[];
    /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
    disallowedToolNames?: string[];
    /**
     * With `schema`: how many extra repair turns to allow if the model finishes
     * without calling structured_output. Each retry re-prompts (tools restricted to
     * structured_output) before falling back to strict prose extraction. Default 2.
     */
    maxSchemaRetries?: number;
    /**
     * Tools that are always injected AFTER the tool-policy filter (`toolNames` /
     * `disallowedToolNames`), so they are available even under a restrictive
     * allowlist. Used by the workflow runtime to inject shared-store tools into
     * every agent regardless of its agentType definition.
     */
    systemTools?: ToolDefinition[];
    /**
     * Per-run model registry override. Takes precedence over the constructor's
     * `modelRegistry` (WorkflowAgentOptions.modelRegistry) for both model
     * resolution and the `createAgentSession` call this run makes. Falls back to
     * the constructor's shared registry, then a lazily-built disk registry, when
     * omitted.
     */
    modelRegistry?: ModelRegistry;
    /** Re-enter a named conversation retained by this WorkflowAgent instance. */
    thread?: string;
}
export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema ? Static<TSchemaDef> : string;
/**
 * Orchestration tools ALWAYS denied to workflow subagents. The `workflow` and
 * `workflow_control` tools are registered globally by the extension, so — unless
 * excluded — a subagent's session sees them and can start its own independent
 * background workflows. Those nested runs recursively fan out and are NOT bounded
 * by the parent run's maxAgents / concurrency / progress / accounting, and can
 * drain a shared provider quota and pile up paused runs (#107). Callers may deny
 * additional tool names via WorkflowAgentOptions.excludeTools.
 */
export declare const DEFAULT_EXCLUDED_SUBAGENT_TOOLS: string[];
/**
 * The full subagent tool denylist: the always-on defaults plus any names the
 * caller added (via WorkflowAgentOptions.excludeTools) or set on the injected
 * session options. Extracted so the merge — and its order — is unit-testable;
 * a spread-order regression that dropped the defaults would slip past a test
 * that only asserts the constant. The SDK dedupes, so overlap is harmless.
 */
export declare function subagentExcludedTools(extra?: string[], sessionExclude?: string[]): string[];
export declare class WorkflowAgent {
    private readonly cwd;
    private readonly baseTools;
    /** Extra subagent tool-name denylist, merged with the always-on defaults. */
    private readonly excludeTools;
    private readonly providerMiddlewareExtensions;
    private readonly sessionOptions;
    private readonly persistAgentSessions;
    private readonly instructions?;
    private readonly mainModel?;
    private readonly inheritMainModel;
    private readonly preSpawnModel?;
    /** Shared registry from the host session, when provided. */
    private readonly sharedRegistry?;
    /** Frozen host session file used for child-session lineage in this run. */
    private readonly parentSessionFile?;
    /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
    private registry?;
    /**
     * Memoized model-tiers.json snapshot, boxed so a legitimately-null config
     * (file absent/invalid) is distinguishable from "not loaded yet". See
     * loadTierConfig() below for why this is scoped per-instance.
     */
    private tierConfigBox?;
    /**
     * Resource loaders shared by subagents using the same directory in this run. See
     * getSharedResourceLoader — this is the #109 memory mitigation.
     */
    private readonly resourceLoaders;
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
    private warnedImplicitRouteUnavailable;
    /**
     * Named conversations live for this WorkflowAgent instance. Production creates
     * one instance per workflow invocation; embedders that inject and reuse an
     * agent are responsible for choosing the longer thread lifetime deliberately.
     */
    private readonly threadSessions;
    private readonly activeThreads;
    /** Unique per-instance identity: agent ids must never collide across WorkflowAgent instances. */
    private readonly agentInstanceId;
    constructor(options?: WorkflowAgentOptions);
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
    private getSharedResourceLoader;
    /**
     * Bound the loader memo (audit2 #41): worktree isolation gives every agent
     * a unique cwd, so N worktree agents would otherwise retain N
     * fully-reloaded loaders until run end. LRU-by-touch (hits re-insert in
     * getSharedResourceLoader) keeps the hot entries — the base cwd is touched
     * by every default call — while one-off worktree loaders are evicted first.
     */
    private static readonly MAX_SHARED_RESOURCE_LOADERS;
    private pruneSharedResourceLoaders;
    private buildSharedResourceLoader;
    /**
     * Resolve the registry for a run: an explicit per-run registry wins, then the
     * constructor's shared registry, then a lazily-built disk registry (shared
     * shared across calls once built). Async because omp builds registries from an
     * async-discovered AuthStorage.
     */
    private getRegistry;
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
    private loadTierConfig;
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
    private createSessionManager;
    /** Best-effort write probe: throws if the session directory isn't actually writable. */
    private assertSessionDirWritable;
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
    private agentIdFor;
    run<TSchemaDef extends TSchema | undefined = undefined>(prompt: string, options?: AgentRunOptions<TSchemaDef>): Promise<AgentRunResult<TSchemaDef>>;
    private runTurn;
    private restoreThreadLeaf;
    private buildPrompt;
    private lastAssistantText;
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
    private finalAssistantText;
}
