/**
 * Per-agent git worktree isolation. When an agent requests `isolation: "worktree"`,
 * it runs in a git worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged. The path is logged
 * and kept by default (`keepWorktree: false` deletes after the call).
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Bound every git invocation (audit2 #21): a hung git (network FS, credential
 * helper prompt) must not block agent spawn or teardown forever. 30s is far
 * above any local worktree add/remove.
 */
const GIT_TIMEOUT_MS = 30_000;
/** Cleanup after a failed add must not stall the spawn path. */
const CLEANUP_TIMEOUT_MS = 5_000;
/** Keep at most this much of each git output stream (caps a noisy stderr). */
const GIT_OUTPUT_LIMIT = 1024 * 1024;

/** Options for the git invocations behind worktree creation/removal. */
export interface WorktreeExecOptions {
  /** Per-invocation timeout; defaults to 30s (see GIT_TIMEOUT_MS). 0 disables. */
  timeoutMs?: number;
}

const timeoutOf = (opts?: WorktreeExecOptions) => opts?.timeoutMs ?? GIT_TIMEOUT_MS;

class GitTimeoutError extends Error {}

/**
 * Run git and resolve with its stdout. A timeout ends git's whole process
 * tree before rejecting: killing git alone leaves its hooks running, and on
 * Windows a hook whose cwd is the new worktree keeps that directory busy.
 */
function git(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // On POSIX git leads its own process group, so one signal reaches its hooks too.
    const child = spawn("git", args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < GIT_OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < GIT_OUTPUT_LIMIT) stderr += chunk;
    });
    let treeEnded: Promise<void> | undefined;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            treeEnded = endProcessTree(child);
          }, timeoutMs)
        : undefined;
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (treeEnded) {
        void treeEnded.then(() => reject(new GitTimeoutError(`git ${args.join(" ")} timed out after ${timeoutMs}ms`)));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        const status = signal ? `signal ${signal}` : `exit code ${code}`;
        reject(new Error(`git ${args.join(" ")} failed (${status}): ${stderr.trim()}`));
      }
    });
  });
}

/** End a running child and every process it started; resolves once the kill was delivered. */
function endProcessTree(child: ChildProcess): Promise<void> {
  // A descendant that inherited git's output pipes must not hold "close" open.
  child.stdout?.destroy();
  child.stderr?.destroy();
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    return Promise.resolve();
  }
  // TerminateProcess (child.kill) would end git.exe alone. taskkill /T finds
  // the descendants through their parent, so it must run while git is alive.
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: CLEANUP_TIMEOUT_MS, windowsHide: true }, () => {
      child.kill();
      resolve();
    });
  });
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

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent"
  );
}

/**
 * Create an isolated worktree at `<repoRoot>/.pi/worktrees/<id>` on branch
 * `pi/wf/<name slug>-<id>`. Each live execution owns a fresh id, so retained
 * results from earlier executions are never reused or overwritten. Journal
 * identity is independent of this path. Returns a failed Worktree on error.
 */
export async function createWorktree(
  baseCwd: string,
  name: string,
  execOptions?: WorktreeExecOptions,
): Promise<Worktree> {
  const timeoutMs = timeoutOf(execOptions);
  let repoRoot: string;
  try {
    repoRoot = (await git(["-C", baseCwd, "rev-parse", "--show-toplevel"], timeoutMs)).trim();
  } catch (error) {
    return { isolated: false, cwd: baseCwd, reason: describeGitFailure(error, "not a git repository") };
  }

  let path: string;
  let branch: string;
  try {
    ({ path, branch } = await reserveWorktree(repoRoot, name, timeoutMs));
  } catch (error) {
    return { isolated: false, cwd: baseCwd, reason: describeGitFailure(error, String(error)) };
  }
  try {
    await git(["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"], timeoutMs);
    return { isolated: true, cwd: path, branch, repoRoot };
  } catch (error) {
    // A timed-out/failed `worktree add` can leave a created branch and a
    // partially checked-out tree behind (r1 MAJOR): git rolls back its
    // registration but never deletes the `-b` branch or the directory.
    await cleanupFailedWorktreeAdd(repoRoot, path, branch);
    return { isolated: false, cwd: baseCwd, reason: describeGitFailure(error, String(error)) };
  }
}

/** Random worktree id length in bytes; two hex characters each. */
const WORKTREE_ID_BYTES = 4;
/** Collisions are practically impossible; this only bounds a broken environment. */
const WORKTREE_ID_ATTEMPTS = 8;

/**
 * Claim a fresh worktree path and branch. The id stays short because every
 * checked-out path grows by the worktree location's length, and Git for
 * Windows cannot create paths beyond MAX_PATH unless core.longpaths is set.
 * Creating the empty directory is atomic, so no concurrent execution can
 * claim the same id; skipping an id whose branch survives (its tree deleted by
 * hand) means failure cleanup only ever removes what this execution created.
 */
async function reserveWorktree(
  repoRoot: string,
  name: string,
  timeoutMs: number,
): Promise<{ path: string; branch: string }> {
  const parent = join(repoRoot, ".pi", "worktrees");
  await mkdir(parent, { recursive: true });
  for (let attempt = 0; attempt < WORKTREE_ID_ATTEMPTS; attempt++) {
    const id = randomBytes(WORKTREE_ID_BYTES).toString("hex");
    const path = join(parent, id);
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const branch = `pi/wf/${slug(name)}-${id}`;
    let free = false;
    try {
      free = !(
        await git(["-C", repoRoot, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`], timeoutMs)
      ).trim();
    } finally {
      if (!free) await rmdir(path);
    }
    if (free) return { path, branch };
  }
  throw new Error(`no free worktree id under ${parent}`);
}

/** Honest failure text: a killed (timed-out) git is not "not a git repository". */
function describeGitFailure(error: unknown, fallback: string): string {
  if (error instanceof GitTimeoutError) return "git timed out (slow or hung filesystem?)";
  return error instanceof Error ? error.message : fallback;
}

/** Best-effort cleanup after a failed `worktree add`: drop the half-created
 * branch and any partial checkout left by a killed git. All steps short-timeout
 * and failure-tolerant — the spawn path must not hang on cleanup. */
async function cleanupFailedWorktreeAdd(repoRoot: string, path: string, branch: string): Promise<void> {
  // Order matters (r3 MAJOR): if the killed `worktree add` had already
  // REGISTERED the worktree, `branch -D` is refused ("used by worktree")
  // until the registration is gone. Deregister first, then delete the branch.
  try {
    // Registered case: removes the tree AND the registration in one step.
    await git(["-C", repoRoot, "worktree", "remove", "--force", path], CLEANUP_TIMEOUT_MS);
  } catch {
    // best-effort — unregistered partial tree falls through to rm + targeted retry
  }
  try {
    // git and its hooks have ended by now; the retries only absorb Windows
    // releasing a file handle a moment after its process exits.
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // best-effort
  }
  try {
    // If manual removal left THIS tree registered, retry its removal now that
    // the path is gone. Do not run `git worktree prune`: that mutates unrelated
    // stale registrations elsewhere in the repository.
    await git(["-C", repoRoot, "worktree", "remove", "--force", path], CLEANUP_TIMEOUT_MS);
  } catch {
    // best-effort
  }
  try {
    await git(["-C", repoRoot, "branch", "-D", branch], CLEANUP_TIMEOUT_MS);
  } catch {
    // best-effort
  }
}

/** Remove a worktree and its branch. Best-effort; safe to call on a no-op Worktree. */
export async function removeWorktree(wt: Worktree, execOptions?: WorktreeExecOptions): Promise<void> {
  if (!wt.isolated || !wt.repoRoot) return;
  try {
    await git(["-C", wt.repoRoot, "worktree", "remove", "--force", wt.cwd], timeoutOf(execOptions));
  } catch {
    // A failed removal (e.g. a locked tree) does not authorize deleting its branch.
    return;
  }
  if (wt.branch) {
    try {
      await git(["-C", wt.repoRoot, "branch", "-D", wt.branch], timeoutOf(execOptions));
    } catch {
      // branch already deleted
    }
  }
}
