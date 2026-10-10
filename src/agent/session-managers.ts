// Provides the SessionManager behind each subagent call: one-shot in memory or on disk, or retained per named thread.
import { randomUUID } from "node:crypto";
import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";

interface ThreadSession {
  manager: SessionManager;
  /** Canonical cwd fixed when this named conversation starts. */
  cwd: string;
}

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
export class SessionManagers {
  private readonly options: SessionManagerOptions;
  private readonly threads = new Map<string, ThreadSession>();

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  /**
   * The manager for one call. A named thread reuses its manager, so the
   * conversation continues, and must keep the canonical cwd it started in.
   * Without a thread every call gets a fresh one-shot manager.
   */
  forCall(thread?: string, cwd?: string): SessionManager {
    if (!thread) return this.createOneShot();
    // WorkflowAgent.run passes an already canonical cwd. Without one, keep the
    // runner cwd as given so SessionManager can still create it lazily.
    const threadCwd = cwd === undefined ? this.options.cwd : realpathSync(cwd);
    const existing = this.threads.get(thread);
    if (existing) {
      if (existing.cwd !== threadCwd) {
        throw new WorkflowError(
          `agent thread "${thread}" cannot change cwd from "${existing.cwd}" to "${threadCwd}"`,
          WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
          { recoverable: false },
        );
      }
      return existing.manager;
    }
    const manager = this.createOneShot();
    this.threads.set(thread, { manager, cwd: threadCwd });
    return manager;
  }

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
  private createOneShot(): SessionManager {
    if (!this.options.persist) return SessionManager.inMemory();
    try {
      const manager = SessionManager.create(this.options.cwd);
      // create() starts a session without lineage. Restart it with the host
      // session as parent before createAgentSession() writes the header.
      if (this.options.parentSessionFile) {
        manager.newSession({ parentSession: this.options.parentSessionFile });
      }
      assertDirWritable(manager.getSessionDir());
      warnPersistSecretsOnce(manager.getSessionDir());
      return manager;
    } catch (error) {
      console.warn(
        `[workflow] persistAgentSessions: could not persist this agent's session (${
          error instanceof Error ? error.message : String(error)
        }); continuing with an in-memory session`,
      );
      return SessionManager.inMemory();
    }
  }
}

/** Best-effort write probe: throws if the directory isn't actually writable. */
function assertDirWritable(dir: string): void {
  const probePath = join(dir, `.write-probe-${randomUUID()}`);
  writeFileSync(probePath, "");
  unlinkSync(probePath);
}

/**
 * Once per process, when a session is actually persisted: full subagent
 * transcripts, which may contain secrets, are being written to disk. Surface
 * that trade-off at run time, not only in the docs.
 */
let warnedPersistSecrets = false;
function warnPersistSecretsOnce(sessionDir: string): void {
  if (warnedPersistSecrets) return;
  warnedPersistSecrets = true;
  console.warn(
    `[workflow] persistAgentSessions is ON: full subagent transcripts (which may include secrets or other sensitive context) are being written to disk under ${sessionDir}. Disable persistAgentSessions if that isn't intended.`,
  );
}
