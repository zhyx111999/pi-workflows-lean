import { SessionManager } from "@earendil-works/pi-coding-agent";
export interface SessionManagerOptions {
    /** The runner's project cwd; persisted sessions are grouped under it. */
    cwd: string;
    persist: boolean;
    /** Host session file recorded as the parent of persisted child sessions. */
    parentSessionFile?: string;
}
/**
 * Named threads live as long as this object. Production creates one per
 * workflow invocation; embedders that reuse a WorkflowAgent deliberately choose
 * a longer thread lifetime.
 */
export declare class SessionManagers {
    private readonly options;
    private readonly threads;
    constructor(options: SessionManagerOptions);
    /**
     * The manager for one call. A named thread reuses its manager, so the
     * conversation continues, and must keep the canonical cwd it started in.
     * Without a thread every call gets a fresh one-shot manager.
     */
    forCall(thread?: string, cwd?: string): SessionManager;
    /**
     * In memory by default. With persistence on, a file-backed session keyed by
     * the runner's project cwd (never a per-call worktree cwd), so worktree agents
     * still group under the project.
     *
     * SessionManager.create() only creates the directory; the SDK writes the file
     * lazily, with uncaught synchronous fs calls, on the first assistant message
     * deep inside session.prompt(). Probing writability up front lets a failure
     * (permissions, disk full) degrade this one agent to an in-memory session
     * instead of aborting it mid-run.
     */
    private createOneShot;
}
