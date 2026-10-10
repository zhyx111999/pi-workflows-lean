import type { Model } from "@earendil-works/pi-ai";
import { type AgentSession, type CreateAgentSessionOptions, type ModelRegistry, type ResourceLoader, type SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
export interface ChildSessionSpec {
    /** Canonical working directory of this call. */
    cwd: string;
    /** The caller chose cwd for this call, so it also overrides an injected cwd. */
    cwdIsExplicit: boolean;
    agentDir: string;
    /** Unique id in the SDK's process-global agent registry. */
    agentId: string;
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
export declare function openChildSession(spec: ChildSessionSpec): Promise<ChildSession>;
