/**
 * Child-process entry for tests/unawaited-script-calls.test.ts. It runs the
 * workflow in UNAWAITED_RUN_SCRIPT through a WorkflowManager without any
 * unhandledRejection listener, so an unhandled rejection ends this process as
 * it would end Pi, and prints the persisted run state as one JSON line.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "../../src/errors.js";
import { WorkflowManager } from "../../src/workflow-manager.js";

const script = process.env.UNAWAITED_RUN_SCRIPT;
if (!script) throw new Error("UNAWAITED_RUN_SCRIPT is required");

const cwd = mkdtempSync(join(tmpdir(), "pi-unawaited-run-"));
try {
  const manager = new WorkflowManager({
    cwd,
    agent: {
      async run(prompt: string) {
        if (prompt === "fatal") {
          throw new WorkflowError("fatal agent failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: false,
          });
        }
        return `ran:${prompt}`;
      },
    },
  });
  manager.on("error", () => {});
  const { runId, promise } = manager.startInBackground(script);
  await promise.catch(() => {});
  // Node reports an unhandled rejection only after the current microtask
  // queue drains; give one a turn to end the process before reporting.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const record = manager.getPersistence().load(runId);
  process.stdout.write(
    `${JSON.stringify({
      unhandledRejectionListeners: process.listenerCount("unhandledRejection"),
      status: record?.status,
      error: record?.error,
      checkpoint: record?.checkpoint && { id: record.checkpoint.checkpointId, status: record.checkpoint.status },
    })}\n`,
  );
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
