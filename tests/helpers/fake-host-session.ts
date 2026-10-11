/**
 * A host AgentSession double for delivery tests. As on the real class, its
 * sendCustomMessage lives on the prototype, so the capture probe can intercept
 * it; a delivered result is appended to a session file, as Pi persists it, so
 * the confirmed send can read the delivery back.
 */

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type HostMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: { deliveryId?: string };
};

type SessionEntry = { id: string; type: string; customType: string; details?: unknown };

const sessionRoot = mkdtempSync(join(tmpdir(), "pi-fake-host-sessions-"));
process.on("exit", () => rmSync(sessionRoot, { recursive: true, force: true }));
let sessionFiles = 0;

export class FakeHostSession {
  /** Every message that reached this session's real send. */
  readonly received: Array<{ message: HostMessage; options: unknown }> = [];
  isStreaming = false;
  isIdle = true;
  readonly sessionManager: {
    getSessionId: () => string;
    getBranch: () => SessionEntry[];
    getSessionFile: () => string;
  };
  private readonly branch: SessionEntry[] = [];

  constructor(sessionId: string) {
    const file = join(sessionRoot, `session-${++sessionFiles}.jsonl`);
    writeFileSync(file, "\n");
    this.sessionManager = {
      getSessionId: () => sessionId,
      getBranch: () => this.branch,
      getSessionFile: () => file,
    };
  }

  subscribe(): () => void {
    return () => {};
  }

  sendCustomMessage(message: HostMessage, options?: unknown): Promise<void> {
    this.received.push({ message, options });
    if (message.details?.deliveryId) {
      const entry = {
        id: `entry-${this.branch.length}`,
        type: "custom_message",
        customType: message.customType,
        details: message.details,
      };
      this.branch.push(entry);
      appendFileSync(this.sessionManager.getSessionFile(), `${JSON.stringify(entry)}\n`);
    }
    return Promise.resolve();
  }
}

/**
 * A pi.sendMessage that reaches `session` the way Pi's bound runtime does: a
 * method call on the live session, its promise detached and errors swallowed.
 */
export function sendMessageTo(session: {
  sendCustomMessage(message: HostMessage, options?: unknown): Promise<unknown>;
}): (message: HostMessage, options?: unknown) => void {
  return (message, options) => {
    void session.sendCustomMessage(message, options).catch(() => {});
  };
}
