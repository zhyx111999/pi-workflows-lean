import type { CommandDeps } from "../../src/command-registry.js";
import type { WorkflowManager } from "../../src/workflow-manager.js";
import type { WorkflowStorage } from "../../src/workflow-saved.js";

/** A storage with nothing saved; tests that save pass their own. */
function emptyStorage(): WorkflowStorage {
  return {
    list: () => [],
    load: () => null,
    save: () => {
      throw new Error("this test has no saved-workflow storage");
    },
    delete: () => false,
    rename: () => ({ ok: false, code: "missing", message: "this test has no saved-workflow storage" }),
  };
}

/** Command dependencies over fixed test values. */
export function commandDeps(deps: { manager: unknown; storage?: unknown; cwd?: string }): CommandDeps {
  const storage = (deps.storage ?? emptyStorage()) as WorkflowStorage;
  return {
    getManager: () => deps.manager as WorkflowManager,
    getStorage: () => storage,
    getCwd: () => deps.cwd ?? process.cwd(),
  };
}
