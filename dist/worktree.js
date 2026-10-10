/**
 * it runs in a git worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged. The path is logged
 * and kept by default (`keepWorktree: false` deletes after the call).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
/**
 * Bound every git invocation (audit2 #21): a hung git (network FS, credential
 * helper prompt) must not block agent spawn or teardown forever. 30s is far
 * above any local worktree add/remove; maxBuffer caps a noisy stderr.
 */
const GIT_EXEC_OPTIONS = { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 };
const gitOptions = (opts) => opts?.timeoutMs !== undefined ? { ...GIT_EXEC_OPTIONS, timeout: opts.timeoutMs } : GIT_EXEC_OPTIONS;
function slug(name) {
    return (name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "agent");
}
/**
 * Create an isolated worktree under `<repoRoot>/.pi/worktrees/<name>` on branch
 * `pi/wf/<name>`. A unique suffix gives each live execution its own ownership;
 * retained results from earlier executions are never reused or overwritten.
 * Journal identity is independent of this path. Returns a failed Worktree on error.
 */
export async function createWorktree(baseCwd, name, execOptions) {
    const id = `${slug(name)}-${randomUUID()}`;
    let repoRoot;
    try {
        const { stdout } = await exec("git", ["-C", baseCwd, "rev-parse", "--show-toplevel"], gitOptions(execOptions));
        repoRoot = stdout.trim();
    }
    catch (error) {
        return { isolated: false, cwd: baseCwd, reason: describeGitFailure(error, "not a git repository") };
    }
    const path = join(repoRoot, ".pi", "worktrees", id);
    const branch = `pi/wf/${id}`;
    try {
        await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"], gitOptions(execOptions));
        return { isolated: true, cwd: path, branch, repoRoot };
    }
    catch (error) {
        // A timed-out/failed `worktree add` can leave a created branch and a
        // partially checked-out tree behind (r1 MAJOR): git rolls back its
        // registration but never deletes the `-b` branch or the directory.
        await cleanupFailedWorktreeAdd(repoRoot, path, branch);
        return { isolated: false, cwd: baseCwd, reason: describeGitFailure(error, String(error)) };
    }
}
/** Honest failure text: a killed (timed-out) git is not "not a git repository". */
function describeGitFailure(error, fallback) {
    if (typeof error === "object" && error !== null && error.killed) {
        return "git timed out (slow or hung filesystem?)";
    }
    return error instanceof Error ? error.message : fallback;
}
/** Best-effort cleanup after a failed `worktree add`: drop the half-created
 * branch and any partial checkout left by a killed git. All steps short-timeout
 * and failure-tolerant — the spawn path must not hang on cleanup. */
async function cleanupFailedWorktreeAdd(repoRoot, path, branch) {
    const quick = { timeout: 5_000, maxBuffer: 1024 * 1024 };
    // Order matters (r3 MAJOR): if the killed `worktree add` had already
    // REGISTERED the worktree, `branch -D` is refused ("used by worktree")
    // until the registration is gone. Deregister first, then delete the branch.
    try {
        // Registered case: removes the tree AND the registration in one step.
        await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", path], quick);
    }
    catch {
        // best-effort — unregistered partial tree falls through to rm + targeted retry
    }
    try {
        // maxRetries: a SIGTERM'd git can keep writing for a few hundred ms after
        // the exec rejects — an unretried recursive rm aborts on the first
        // ENOTEMPTY and leaves the partial tree behind (r2 MINOR).
        await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
    catch {
        // best-effort
    }
    try {
        // If manual removal left THIS tree registered, retry its removal now that
        // the path is gone. Do not run `git worktree prune`: that mutates unrelated
        // stale registrations elsewhere in the repository.
        await exec("git", ["-C", repoRoot, "worktree", "remove", "--force", path], quick);
    }
    catch {
        // best-effort
    }
    try {
        await exec("git", ["-C", repoRoot, "branch", "-D", branch], quick);
    }
    catch {
        // best-effort
    }
}
/** Remove a worktree and its branch. Best-effort; safe to call on a no-op Worktree. */
export async function removeWorktree(wt, execOptions) {
    if (!wt.isolated || !wt.repoRoot)
        return;
    try {
        await exec("git", ["-C", wt.repoRoot, "worktree", "remove", "--force", wt.cwd], gitOptions(execOptions));
    }
    catch {
        // A failed removal (e.g. a locked tree) does not authorize deleting its branch.
        return;
    }
    if (wt.branch) {
        try {
            await exec("git", ["-C", wt.repoRoot, "branch", "-D", wt.branch], gitOptions(execOptions));
        }
        catch {
            // branch already deleted
        }
    }
}
