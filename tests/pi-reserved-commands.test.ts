import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isCommandTaken } from "../src/command-registry.js";
import { commitRename, saveRunAsWorkflow } from "../src/navigator/saved-actions.js";
import type { NavigatorSession } from "../src/navigator/session.js";
import { PI_RESERVED_COMMANDS } from "../src/pi-reserved-commands.js";
import { registerSavedWorkflow, savedWorkflowCommandAvailability } from "../src/saved-commands.js";
import { registerWorkflowCommands } from "../src/workflow-commands.js";
import type { WorkflowManager } from "../src/workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "../src/workflow-saved.js";
import { NavigatorState } from "../src/workflow-ui.js";
import { commandDeps } from "./helpers/command-deps.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

// Pi's editor runs these itself, and `getCommands()` does not list them.
const HOST_COMMANDS = ["new", "reload", "resume", "fork", "model"];

const SCRIPT = "export const meta = { name: 'scan', description: 'scan' }";

function savedWorkflow(name: string): SavedWorkflow {
  return {
    name,
    description: name,
    script: SCRIPT,
    location: "project",
    path: `/saved/${name}.json`,
    savedAt: "2026-01-01",
  };
}

/** Storage that records every write, so a test can tell whether a refusal happened before disk. */
function recordingStorage() {
  const writes: string[] = [];
  const storage = {
    list: () => [],
    load: () => null,
    delete: () => ({ ok: false, code: "missing", message: "Saved workflow no longer exists." }),
    save: (workflow: { name: string }) => {
      writes.push(workflow.name);
      return { ok: true as const, workflow: savedWorkflow(workflow.name) };
    },
    rename: (_workflow: SavedWorkflow, name: string) => {
      writes.push(name);
      return { ok: true as const, workflow: savedWorkflow(name) };
    },
  } as unknown as WorkflowStorage;
  return { storage, writes };
}

function managerWithRun(workflowName: string): WorkflowManager {
  const run = { runId: "run-1", workflowName, status: "completed", script: SCRIPT, agents: [], logs: [] };
  return {
    listRuns: () => [run],
    findRun: (id: string) => (id === run.runId ? run : undefined),
  } as unknown as WorkflowManager;
}

function navigatorSession(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  storage: WorkflowStorage,
  saved: SavedWorkflow[] = [],
) {
  const notified: Array<{ message: string; type?: string }> = [];
  const state = new NavigatorState();
  const session = {
    pi,
    manager,
    ui: {
      notify: (message: string, type?: string) => notified.push({ message, type }),
    } as unknown as ExtensionUIContext,
    options: { getStorage: () => storage, getManager: () => manager },
    model: {
      saved: () => saved,
      renameSaved: (workflow: SavedWorkflow, name: string) => storage.rename(workflow, name),
    },
    state,
  } as unknown as NavigatorSession;
  return { session, state, notified };
}

test("the reserved list covers every command the installed Pi editor runs itself", async () => {
  // The SDK keeps both sources internal, so read them from the installed build.
  const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { BUILTIN_SLASH_COMMANDS } = (await import(new URL("core/slash-commands.js", sdkEntry).href)) as {
    BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string }>;
  };
  const editor = readFileSync(fileURLToPath(new URL("modes/interactive/interactive-mode.js", sdkEntry)), "utf8");
  const matched = [...editor.matchAll(/text === "\/([^"\s]+)"/g)].map((match) => match[1]);
  assert.ok(matched.length > 0, "the editor's command matching was not found; re-read the SDK source");

  // The list spans every supported Pi release, so it may hold names this one lacks.
  const installed = new Set([...BUILTIN_SLASH_COMMANDS.map((command) => command.name), ...matched]);
  assert.deepEqual(
    [...installed].filter((name) => !PI_RESERVED_COMMANDS.has(name)),
    [],
    "names the installed Pi reserves but the list misses",
  );
});

test("a reserved name counts as taken even though getCommands does not list it", () => {
  const { pi } = makeCommandRegistryPi();
  for (const name of HOST_COMMANDS) assert.equal(isCommandTaken(pi, name), true, `/${name}`);
  assert.equal(isCommandTaken(pi, "scan"), false);
  assert.equal(isCommandTaken(makeCommandRegistryPi(["scan"]).pi, "scan"), true);
});

test("saved workflows cannot claim Pi's own commands, which getCommands does not list", () => {
  for (const name of HOST_COMMANDS) {
    const { pi, commands } = makeCommandRegistryPi();
    const availability = savedWorkflowCommandAvailability(pi, name);
    assert.equal(availability.ok, false, `/${name} must be refused`);
    assert.match(availability.ok ? "" : availability.message, /built-in Pi command/);

    const registration = registerSavedWorkflow(
      pi,
      savedWorkflow(name),
      () => managerWithRun(name),
      () => null,
    );
    assert.equal(registration.ok, false, `registering /${name} must fail`);
    assert.deepEqual(commands, [], `/${name} must not be registered`);
  }
});

test("navigator refuses to save a run under a Pi command name before writing it", () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { storage, writes } = recordingStorage();
  const { session, notified } = navigatorSession(pi, managerWithRun("new"), storage);

  saveRunAsWorkflow(session, "run-1");

  assert.deepEqual(writes, [], "nothing reaches disk");
  assert.deepEqual(commands, []);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "error");
  assert.match(notified[0].message, /\/new is a built-in Pi command/);
});

test("navigator refuses to rename a saved workflow to a Pi command name before writing it", () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { storage, writes } = recordingStorage();
  const workflow = savedWorkflow("scan");
  const { session, state, notified } = navigatorSession(pi, managerWithRun("scan"), storage, [workflow]);

  state.beginRename(workflow);
  state.draft = "reload";
  commitRename(session);

  assert.deepEqual(writes, [], "nothing reaches disk");
  assert.deepEqual(commands, []);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "error");
  assert.match(notified[0].message, /\/reload is a built-in Pi command/);
});

test("/workflows save under a Pi command name is refused before anything is written", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { storage, writes } = recordingStorage();
  registerWorkflowCommands(pi, commandDeps({ manager: managerWithRun("scan"), storage }));
  const workflows = commands.find((command) => command.name === "workflows");
  assert.ok(workflows);

  const { ctx, notified } = makeNotifyCtx();
  await workflows.handler("save new", ctx);

  assert.deepEqual(
    commands.map((command) => command.name),
    ["workflows"],
    "/new must not be registered",
  );
  assert.deepEqual(writes, [], "nothing reaches disk");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "error");
  assert.equal(notified[0].message, "Not saved: /new is a built-in Pi command.");
});
