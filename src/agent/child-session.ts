// Opens a subagent's AgentSession with the call's own settings taking precedence over injected defaults, and disposes it.
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  type ModelRegistry,
  type ResourceLoader,
  type SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { pinChildCacheRetention } from "../child-cache-retention.js";
import { runtimeOf } from "./model-registry.js";

export interface ChildSessionSpec {
  /** Canonical working directory of this call. */
  cwd: string;
  /** The caller chose cwd for this call, so it also overrides an injected cwd. */
  cwdIsExplicit: boolean;
  agentDir: string;
  sessionManager: SessionManager;
  /** A named thread keeps its own manager even when a default one was injected. */
  keepSessionManager: boolean;
  customTools: ToolDefinition[];
  /** Used only when no resourceLoader was injected. */
  sharedResourceLoader: () => Promise<ResourceLoader>;
  modelRegistry: ModelRegistry;
  model?: Model<any>;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  excludeTools: string[];
  /** Embedder/test overrides; the call-specific fields above still win. */
  injected: Partial<CreateAgentSessionOptions>;
}

export interface ChildSession {
  session: AgentSession;
  /** Emit session_shutdown, then dispose. Never throws. */
  dispose(): Promise<void>;
}

export async function openChildSession(spec: ChildSessionSpec): Promise<ChildSession> {
  const { injected, modelRegistry } = spec;
  const { session } = await createAgentSession({
    cwd: spec.cwd,
    agentDir: spec.agentDir,
    sessionManager: spec.sessionManager,
    // A real SettingsManager inherits the user's default provider/model.
    // SettingsManager.inMemory() skips ~/.pi settings, so subagents would fall
    // back to the first available model, which may lack auth and answer empty.
    settingsManager: SettingsManager.create(spec.cwd, spec.agentDir),
    customTools: spec.customTools,
    // An injected resourceLoader wins and skips the shared build entirely.
    resourceLoader: injected.resourceLoader ?? (await spec.sharedResourceLoader()),
    // The registry's backing runtime, so subagents share the host catalog and auth.
    modelRuntime: runtimeOf(modelRegistry),
    ...injected,
    ...(spec.cwdIsExplicit ? { cwd: spec.cwd } : {}),
    // The injected spread above would otherwise replace a thread's retained
    // manager, breaking turn continuity and failed-turn rollback.
    ...(spec.keepSessionManager ? { sessionManager: spec.sessionManager } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
    // Last, so the recursive-orchestration denylist always applies.
    excludeTools: spec.excludeTools,
  });
  pinChildCacheRetention(session.agent);
  const dispose = async () => {
    try {
      // dispose() alone does not emit shutdown; give opted-in extension
      // factories a chance to release session-local listeners and resources.
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      // Cleanup must not replace the original result or failure.
    } finally {
      session.dispose();
    }
  };
  // Child sessions do not auto-bind a supplied ResourceLoader. Bind middleware
  // before the first provider request (also supports injected resource loaders).
  try {
    await session.bindExtensions({});
  } catch (error) {
    await dispose();
    throw error;
  }
  return { session, dispose };
}
