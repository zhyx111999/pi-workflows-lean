import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { PersistedRunState } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowStorage, type SavedWorkflow, type WorkflowStorage } from "../src/workflow-saved.js";
import { openWorkflowNavigator } from "../src/workflow-ui.js";

const OLD_SCRIPT = "export const meta = { name: 'scan', description: 'old' }\nreturn 'old'";
const NEW_SCRIPT = "export const meta = { name: 'scan', description: 'new' }\nreturn 'new'";
const OTHER_SCRIPT = "export const meta = { name: 'scan', description: 'other' }\nreturn 'other'";

type Notification = { message: string; type?: string };

/** Open the navigator over `manager` and return its overlay component, rendered text, and notifications. */
async function openNavigator(manager: WorkflowManager, storage?: WorkflowStorage) {
  const notifications: Notification[] = [];
  let component: Component | undefined;
  const ui = {
    notify: (message: string, type?: string) => notifications.push({ message, type }),
    custom: <T>(factory: (tui: unknown, theme: unknown, keys: unknown, done: (r: T) => void) => Component) => {
      const tui = { requestRender: () => {}, terminal: { rows: 30 } };
      const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
      component = factory(tui, theme, {}, () => {});
      return new Promise<T>(() => {});
    },
  } as unknown as ExtensionUIContext;
  const commands: string[] = [];
  const pi = {
    getCommands: () => commands.map((name) => ({ name })),
    registerCommand: (name: string) => commands.push(name),
    sendMessage: () => {},
  } as unknown as ExtensionAPI;
  void openWorkflowNavigator(pi, manager, ui, { getStorage: () => storage, getManager: () => manager });
  await Promise.resolve();
  assert.ok(component, "the navigator should open an overlay");
  const overlay = component;
  return {
    notifications,
    commands,
    press: (key: string) => overlay.handleInput?.(key),
    text: () => overlay.render(400).join("\n"),
  };
}

/** A manager listing one finished run whose script is `run.script`. */
function managerWithRun(run: { workflowName: string; script: string }): WorkflowManager {
  const record = {
    runId: "run-1",
    workflowName: run.workflowName,
    status: "completed",
    phases: [],
    agents: [],
    logs: [],
    script: run.script,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as PersistedRunState;
  return {
    on: () => {},
    off: () => {},
    listRuns: () => [record],
    findRun: (id: string) => (id === record.runId ? record : undefined),
    getRun: () => undefined,
  } as unknown as WorkflowManager;
}

/** Save a project workflow /scan holding `script`, replacing `replacing` when given. */
function seed(storage: WorkflowStorage, script: string, replacing?: SavedWorkflow): SavedWorkflow {
  const result = storage.save({ name: "scan", description: "scan", script }, { replacing });
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.workflow;
}

function withProject(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pwl-nav-actions-"));
    try {
      await fn(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

function savedScripts(path: string): { primary: string; backup: string } {
  const read = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { script: string }).script;
  return { primary: read(path), backup: read(`${path}.bak`) };
}

test(
  "navigator restart keeps the recorded run's toolset",
  withProject(async (cwd) => {
    let resolutions = 0;
    const manager = new WorkflowManager({
      cwd,
      agent: { run: async () => "ok" },
      toolsets: {
        "web-research": () => {
          resolutions++;
          return [];
        },
      },
    });
    const script =
      "export const meta = { name: 'research', description: 'r' }\nreturn await agent('look', { label: 'a' })";
    const first = manager.startInBackground(script, { topic: "x" }, { toolset: "web-research" });
    await first.promise;

    const nav = await openNavigator(manager);
    nav.press("r");
    const notice = nav.notifications.find((n) => n.message.startsWith("Restarted"));
    assert.ok(notice, `restart should start a run: ${JSON.stringify(nav.notifications)}`);
    const restartedId = notice.message.split(" as ").pop() ?? "";
    for (let i = 0; i < 200 && manager.getRun(restartedId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const restarted = manager.getPersistence().load(restartedId);
    assert.equal(restarted?.toolset, "web-research", "the restarted run records the same toolset");
    assert.deepEqual(restarted?.args, { topic: "x" });
    assert.equal(resolutions, 2, "the restarted execution resolves the toolset's tools again");
  }),
);

test(
  "navigator save asks before replacing a different same-name workflow and never loses the old script",
  withProject(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const { path } = seed(storage, OLD_SCRIPT);
    const nav = await openNavigator(managerWithRun({ workflowName: "scan", script: NEW_SCRIPT }), storage);

    nav.press("s");
    assert.match(nav.text(), /Press s again to replace the project workflow \/scan, or Esc to cancel\. File: /);
    assert.ok(nav.text().includes(path), "the prompt names the exact file being replaced");
    assert.equal(savedScripts(path).primary, OLD_SCRIPT, "nothing is written before the confirmation");

    nav.press("s");
    assert.deepEqual(savedScripts(path), { primary: NEW_SCRIPT, backup: OLD_SCRIPT });
    assert.ok(nav.notifications.some((n) => n.message === "Saved /scan" && n.type === "info"));

    // A repeated save of the same script is skipped, so the backup keeps the old script.
    nav.press("s");
    assert.deepEqual(savedScripts(path), { primary: NEW_SCRIPT, backup: OLD_SCRIPT });
    assert.doesNotMatch(nav.text(), /Press s again/);
    assert.match(nav.notifications.at(-1)?.message ?? "", /already saved/);
  }),
);

test(
  "navigator save leaves an identical workflow untouched",
  withProject(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const saved = seed(storage, NEW_SCRIPT);
    const before = readFileSync(saved.path, "utf8");
    const nav = await openNavigator(managerWithRun({ workflowName: "scan", script: NEW_SCRIPT }), storage);

    nav.press("s");
    assert.equal(readFileSync(saved.path, "utf8"), before, "the file, savedAt included, is not rewritten");
    assert.deepEqual(nav.notifications, [{ message: "/scan is already saved with this script", type: "info" }]);
  }),
);

test(
  "navigator save replace is cancelled by Esc and refused when the target changed after asking",
  withProject(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const { path } = seed(storage, OLD_SCRIPT);
    const nav = await openNavigator(managerWithRun({ workflowName: "scan", script: NEW_SCRIPT }), storage);

    nav.press("s");
    nav.press("\x1b");
    assert.doesNotMatch(nav.text(), /Press s again/);
    assert.equal(savedScripts(path).primary, OLD_SCRIPT);

    nav.press("s");
    // Another window replaces the workflow after the prompt was shown.
    seed(storage, OTHER_SCRIPT, storage.load("scan") ?? undefined);
    nav.press("s");
    assert.equal(savedScripts(path).primary, OTHER_SCRIPT, "a workflow changed after the prompt is not replaced");
    assert.equal(nav.notifications.at(-1)?.type, "warning");
    assert.match(nav.notifications.at(-1)?.message ?? "", /changed/);
  }),
);
