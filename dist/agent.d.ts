import { type CreateAgentSessionOptions, type ModelRegistry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { AgentUsage } from "./agent-usage.js";
import { type ModelThinkingLevel } from "./model-spec.js";
import type { ModelSource, PreSpawnModelResolver } from "./pre-spawn-model.js";
export type { AgentUsage } from "./agent-usage.js";
/** Child sessions load no host extensions unless explicitly opted in. */
export declare const DEFAULT_PROVIDER_MIDDLEWARE_EXTENSIONS: readonly string[];
export interface WorkflowAgentOptions {
    cwd?: string;
    /** Extra tools available to the subagent in addition to the structured output tool. */
    tools?: ToolDefinition[];
    /**
     * Extra tool names to deny in the subagent session, on top of the always-denied
     * orchestration tools. Lets the host exclude other recursive-orchestration
     * tools it registers (e.g. a pi-subagents tool) so a subagent cannot fan out
     * through them either.
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
     * Without it, `{ tier: "small" }` with no saved config would fall through to
     * the session default.
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
     * Optional host policy run after model-intent resolution and before
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
     * of an in-memory session that is discarded when the run ends. Default: false.
     */
    persistAgentSessions?: boolean;
}
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
     * Model tier name (e.g. "small", "medium", "big"), resolved from the user's
     * model-tiers.json when no explicit `model` is given, falling back to the
     * session's main model when the tier has no configured entry. A requested
     * tier that resolves to an unavailable spec throws MODEL_NOT_FOUND naming the
     * tier and the spec, just like an explicit `model`. Only the implicit route of
     * an untagged agent degrades instead (see onModelFallback), because the
     * script never asked for that model.
     */
    tier?: string;
    /**
     * Provenance of `model`/`tier` as known by the caller (workflow layer).
     * When omitted, it is inferred from model/tier/resolved spec.
     */
    modelSource?: ModelSource;
    /** Per-run host policy; overrides the instance and process resolvers. */
    preSpawnModel?: PreSpawnModelResolver;
    /**
     * Called with the resolved model id once known (for display/telemetry). When
     * no spec resolved (settings default, implicit-route degrade, or an empty
     * tier) it fires after session creation with the session's real model, so
     * the agent never keeps displaying the pre-resolution mainModel guess.
     */
    onModelResolved?: (modelId: string) => void;
    /**
     * Called at most once per WorkflowAgent instance when an untagged agent's
     * implicit route — the default "medium" tier, or the inherited main model
     * when inheritMainModel is on — resolves to an unavailable spec. That case
     * degrades to the session default instead of throwing, so the run's own
     * log must still record it. `tier` is only meaningful when
     * `source === "medium-tier"`; key on `source`.
     */
    onModelFallback?: (info: {
        tier: string;
        requestedSpec: string;
        source: "medium-tier" | "inherit-main";
    }) => void;
    /** Called with a compact snapshot of this subagent's message/tool history. */
    onHistory?: (history: AgentHistoryEntry[]) => void;
    /**
     * Called once the child session can take instructions, with a function that
     * queues one into it (AgentSession.steer). The returned function runs before
     * the session is disposed, so a host never steers a finished session.
     */
    registerSteer?: (steer: (text: string) => Promise<void>) => () => void;
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
     * `modelRegistry` for both model resolution and this run's session, which
     * otherwise fall back to the constructor's registry, then a lazily-built disk
     * registry.
     */
    modelRegistry?: ModelRegistry;
    /** Re-enter a named conversation retained by this WorkflowAgent instance. */
    thread?: string;
}
export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema ? Static<TSchemaDef> : string;
/**
 * Runs subagents for one workflow invocation. Production creates one instance
 * per run, so per-instance caches (tier config, resource loaders, threads) live
 * exactly as long as the run.
 */
export declare class WorkflowAgent {
    private readonly cwd;
    private readonly baseTools;
    /** Extra subagent tool-name denylist, merged with the always-on defaults. */
    private readonly excludeTools;
    private readonly sessionOptions;
    private readonly persistAgentSessions;
    private readonly instructions?;
    /** Shared registry from the host session, when provided. */
    private readonly sharedRegistry?;
    /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
    private registry?;
    /** Memoized model-tiers snapshot, boxed so a missing config (null) differs from "not read yet". */
    private tierConfigBox?;
    private readonly models;
    private readonly resourceLoaders;
    private readonly sessionManagers;
    private readonly activeThreads;
    /** Unique per-instance identity: agent ids must never collide across WorkflowAgent instances. */
    private readonly agentInstanceId;
    constructor(options?: WorkflowAgentOptions);
    run<TSchemaDef extends TSchema | undefined = undefined>(prompt: string, options?: AgentRunOptions<TSchemaDef>): Promise<AgentRunResult<TSchemaDef>>;
    private runTurn;
    /** Coding tools bound to `runCwd`; tools capture their cwd at construction and cannot be moved. */
    private codingToolsFor;
    /** A per-run registry wins, then the host's shared registry, then the disk-backed fallback. */
    private getRegistry;
    /**
     * The cwd-aware model-tiers overlay, read once per instance. Every untagged
     * or tiered agent consults it, and a synchronous disk read per agent would
     * stall a large fan-out. One instance per run means each run still sees the
     * file as it was when the run started. `loader` is for tests and only matters
     * on the first call.
     */
    private loadTierConfig;
    private getSharedResourceLoader;
    private createSessionManager;
    /** Roll a thread back to its leaf before a failed turn, so the next turn continues from there. */
    private restoreThreadLeaf;
    /**
     * Unique id in the SDK's process-global agent registry. Concurrent sessions
     * created without one all default to "Main" and replace each other there.
     * One-shot calls embed a per-process sequence, so retries and concurrent runs
     * never reuse an id; a named thread keeps one id per instance because it is
     * one continuing session.
     */
    private agentIdFor;
    private buildPrompt;
    private lastAssistantText;
    private finalAssistantText;
}
