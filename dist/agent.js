// Runs one workflow subagent: picks its tools, model, and session, prompts it, and returns its answer.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createCodingTools, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { listAvailableModels } from "./agent/available-models.js";
import { openChildSession } from "./agent/child-session.js";
import { ensureFallbackRegistry } from "./agent/model-registry.js";
import { AgentModelSelector } from "./agent/model-selection.js";
import { throwIfProviderLimit } from "./agent/provider-limit.js";
import { SharedResourceLoaders } from "./agent/resource-loaders.js";
import { SessionManagers } from "./agent/session-managers.js";
import { buildSubagentTools, subagentExcludedTools } from "./agent/session-tools.js";
import { TurnProgress } from "./agent/turn-progress.js";
import { finalAssistantText, lastAssistantText, resolveStructuredOutput } from "./agent/turn-result.js";
import { assertProcessesStartIn } from "./agent/windows-cwd.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { canonicalModelSpec, formatModelSpecWithThinking, validateThinkingLevel, } from "./model-spec.js";
import { loadModelTierConfig } from "./model-tier-config.js";
/** Child sessions load no host extensions unless explicitly opted in. */
export const DEFAULT_PROVIDER_MIDDLEWARE_EXTENSIONS = Object.freeze([]);
/** Process-global subagent id counter: unique across concurrent workflow runs. */
let workflowAgentSeq = 0;
/**
 * Runs subagents for one workflow invocation. Production creates one instance
 * per run, so per-instance caches (tier config, resource loaders, threads) live
 * exactly as long as the run.
 */
export class WorkflowAgent {
    cwd;
    baseTools;
    /** Extra subagent tool-name denylist, merged with the always-on defaults. */
    excludeTools;
    sessionOptions;
    persistAgentSessions;
    instructions;
    /** Shared registry from the host session, when provided. */
    sharedRegistry;
    /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
    registry;
    /** Memoized model-tiers snapshot, boxed so a missing config (null) differs from "not read yet". */
    tierConfigBox;
    models;
    resourceLoaders;
    sessionManagers;
    activeThreads = new Set();
    /** Unique per-instance identity: agent ids must never collide across WorkflowAgent instances. */
    agentInstanceId = randomUUID();
    constructor(options = {}) {
        this.cwd = options.cwd ?? process.cwd();
        this.baseTools = options.tools ?? createCodingTools(this.cwd);
        this.excludeTools = options.excludeTools ?? [];
        this.sessionOptions = options.session ?? {};
        this.persistAgentSessions = options.persistAgentSessions ?? false;
        this.instructions = options.instructions;
        this.sharedRegistry = options.modelRegistry;
        this.models = new AgentModelSelector({
            mainModel: options.mainModel,
            inheritMainModel: options.inheritMainModel ?? false,
            preSpawnModel: options.preSpawnModel,
            loadTierConfig: () => this.loadTierConfig(),
            listModels: listAvailableModels,
        });
        this.resourceLoaders = new SharedResourceLoaders([...(options.providerMiddlewareExtensions ?? DEFAULT_PROVIDER_MIDDLEWARE_EXTENSIONS)], this.sessionOptions);
        this.sessionManagers = new SessionManagers({
            cwd: this.cwd,
            persist: this.persistAgentSessions,
            parentSessionFile: options.parentSessionFile,
        });
    }
    async run(prompt, options = {}) {
        validateThinkingLevel(options.thinking);
        const thread = options.thread;
        if (thread && this.activeThreads.has(thread)) {
            throw new WorkflowError(`agent thread "${thread}" is already running; same-thread calls must be sequential`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false, agentLabel: options.label });
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
        // 1. Where the agent works and which tools it gets.
        const runCwd = realpathSync(options.cwd ?? this.cwd);
        assertProcessesStartIn(runCwd, options.label);
        const capture = { called: false, value: undefined };
        const customTools = buildSubagentTools({
            codingTools: this.codingToolsFor(runCwd),
            tools: options.tools,
            toolNames: options.toolNames,
            disallowedToolNames: options.disallowedToolNames,
            systemTools: options.systemTools,
            schema: options.schema,
            capture,
        });
        // 2. Which model it runs on.
        const modelRegistry = await this.getRegistry(options.modelRegistry);
        const choice = await this.models.select(options, modelRegistry);
        // 3. The session it runs in. Persisted sessions are keyed by the runner's
        //    project cwd, not runCwd, so short-lived worktree agents still group
        //    under the project.
        const agentDir = getAgentDir();
        const sessionManager = this.createSessionManager(options.thread, runCwd);
        const effectiveSessionManager = options.thread || !this.sessionOptions.sessionManager ? sessionManager : this.sessionOptions.sessionManager;
        // Report the child identity before the first prompt or usage event.
        options.onSessionCreated?.({
            sessionId: effectiveSessionManager.getSessionId(),
            sessionFile: effectiveSessionManager.isPersisted() ? effectiveSessionManager.getSessionFile() : undefined,
        });
        const threadLeaf = options.thread ? sessionManager.getLeafId() : null;
        let child;
        try {
            child = await openChildSession({
                cwd: runCwd,
                cwdIsExplicit: options.cwd !== undefined,
                agentDir,
                agentId: this.agentIdFor(options, runCwd),
                sessionManager,
                keepSessionManager: Boolean(options.thread),
                customTools,
                sharedResourceLoader: () => this.getSharedResourceLoader(agentDir, runCwd),
                modelRegistry,
                model: choice.model,
                thinkingLevel: choice.thinkingLevel,
                excludeTools: subagentExcludedTools(this.excludeTools, this.sessionOptions.excludeTools),
                injected: this.sessionOptions,
            });
        }
        catch (error) {
            if (options.thread)
                this.restoreThreadLeaf(sessionManager, threadLeaf);
            throw error;
        }
        const { session } = child;
        // 4. The turn itself.
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
        // Name a persisted session for session pickers: only when this agent owns
        // the manager, and for a thread only on its first turn. Best-effort.
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
        const progress = new TurnProgress(session, options, usageBeforeTurn);
        let threadTurnSucceeded = false;
        let unregisterSteer;
        let removeAbortListener;
        let removeProgressListener;
        let removeTurnListener;
        try {
            // With no resolved spec, the display still shows the pre-resolution
            // mainModel guess; report the model the session actually bound. Inside
            // the try so a throwing host callback cannot leak the session.
            if (!choice.model && session.model) {
                options.onModelResolved?.(formatModelSpecWithThinking(canonicalModelSpec(session.model), choice.thinkingLevel));
            }
            if (options.signal?.aborted)
                throw new Error("Subagent was aborted");
            unregisterSteer = options.registerSteer?.((text) => session.steer(text));
            if (options.signal) {
                const onAbort = () => void session.abort();
                options.signal.addEventListener("abort", onAbort, { once: true });
                removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
            }
            if (progress.live) {
                removeProgressListener = session.subscribe(progress.onEvent);
            }
            removeTurnListener = session.subscribe((event) => {
                if (event.type === "message_end")
                    turnMessages.push(event.message);
            });
            await session.prompt(this.buildPrompt(prompt, options, Boolean(options.schema)));
            if (options.signal?.aborted)
                throw new Error("Subagent was aborted");
            // The SDK reports a provider usage/quota limit inside the assistant message
            // instead of throwing. Check it before the result branches so it pauses the
            // run rather than reading as SCHEMA_NONCOMPLIANCE or an empty answer.
            throwIfProviderLimit(session.messages, options.label);
            if (options.schema) {
                const result = (await resolveStructuredOutput(session, capture, options.schema, options, () => this.lastAssistantText(turnMessages)));
                threadTurnSucceeded = true;
                return result;
            }
            // A threaded session's restored transcript never enters turnMessages, so
            // an empty turn cannot reuse an old answer.
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
            removeTurnListener?.();
            removeProgressListener?.();
            progress.emitFinalHistory();
            if (options.thread && !threadTurnSucceeded) {
                this.restoreThreadLeaf(sessionManager, threadLeaf);
            }
            progress.reportFinalUsage();
            await child.dispose();
        }
    }
    /** Coding tools bound to `runCwd`; tools capture their cwd at construction and cannot be moved. */
    codingToolsFor(runCwd) {
        try {
            if (runCwd === realpathSync(this.cwd))
                return this.baseTools;
        }
        catch {
            // An explicitly selected existing directory can outlive the constructor's
            // original directory. Its tools must not depend on that old path existing.
        }
        return createCodingTools(runCwd);
    }
    /** A per-run registry wins, then the host's shared registry, then the disk-backed fallback. */
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
     * The cwd-aware model-tiers overlay, read once per instance. Every untagged
     * or tiered agent consults it, and a synchronous disk read per agent would
     * stall a large fan-out. One instance per run means each run still sees the
     * file as it was when the run started. `loader` is for tests and only matters
     * on the first call.
     */
    loadTierConfig(loader) {
        if (!this.tierConfigBox) {
            const read = loader ?? (() => loadModelTierConfig({ cwd: this.cwd }));
            this.tierConfigBox = { value: read() };
        }
        return this.tierConfigBox.value;
    }
    getSharedResourceLoader(agentDir, cwd = this.cwd) {
        return this.resourceLoaders.get(agentDir, cwd);
    }
    createSessionManager(thread, cwd) {
        return this.sessionManagers.forCall(thread, cwd);
    }
    /** Roll a thread back to its leaf before a failed turn, so the next turn continues from there. */
    restoreThreadLeaf(sessionManager, leafId) {
        if (leafId)
            sessionManager.branch(leafId);
        else
            sessionManager.resetLeaf();
    }
    /**
     * Unique id in the SDK's process-global agent registry. Concurrent sessions
     * created without one all default to "Main" and replace each other there.
     * One-shot calls embed a per-process sequence, so retries and concurrent runs
     * never reuse an id; a named thread keeps one id per instance because it is
     * one continuing session.
     */
    agentIdFor(options, runCwd) {
        if (options.thread)
            return `workflow:${runCwd}:${this.agentInstanceId}:${options.thread}`;
        return `workflow:${runCwd}:${process.pid}:${++workflowAgentSeq}`;
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
        return lastAssistantText(messages);
    }
    finalAssistantText(messages) {
        return finalAssistantText(messages);
    }
}
