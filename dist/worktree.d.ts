/**
 * it runs in a git worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged. The path is logged
 * and kept by default (`keepWorktree: false` deletes after the call).
 */
/** Options for the git invocations behind worktree creation/removal. */
export interface WorktreeExecOptions {
    /** Per-invocation timeout; defaults to 30s (see GIT_EXEC_OPTIONS). 0 disables. */
    timeoutMs?: number;
}
export interface Worktree {
    /** True when a real worktree was created; false means isolation failed. */
    isolated: boolean;
    /** cwd the agent should run in (worktree path when isolated, else the base cwd). */
    cwd: string;
    branch?: string;
    /** Repo root the worktree was added to (for teardown). */
    repoRoot?: string;
    /** Why isolation was skipped, when isolated === false. */
    reason?: string;
}
/**
 * Create an isolated worktree under `<repoRoot>/.pi/worktrees/<name>` on branch
 * `pi/wf/<name>`. A unique suffix gives each live execution its own ownership;
 * retained results from earlier executions are never reused or overwritten.
 * Journal identity is independent of this path. Returns a failed Worktree on error.
 */
export declare function createWorktree(baseCwd: string, name: string, execOptions?: WorktreeExecOptions): Promise<Worktree>;
/** Remove a worktree and its branch. Best-effort; safe to call on a no-op Worktree. */
export declare function removeWorktree(wt: Worktree, execOptions?: WorktreeExecOptions): Promise<void>;
