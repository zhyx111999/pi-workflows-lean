import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { RunPersistence } from "../src/run-persistence.js";
import { stopRunWatchers } from "../src/run-watchers.js";
import { SUBAGENTS_TOOL_NAME } from "../src/subagents-tool.js";
import { registerWorkflowCommands } from "../src/workflow-commands.js";
import { buildForcedWorkflowPrompt } from "../src/workflow-editor.js";
import type { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { commandDeps } from "./helpers/command-deps.js";

type Handler = (args: string, ctx: any) => Promise<void>;

/** Capture the registered command + outputs for assertions. */
function harness(
  managerOverrides: Record<string, any> = {},
  commandOptions: Record<string, any> = {},
  initialTools: string[] = [SUBAGENTS_TOOL_NAME],
  sendMessageImpl?: (
    m: { customType?: string; content?: string },
    options?: { triggerTurn?: boolean; deliverAs?: string },
  ) => Promise<void>,
) {
  const printed: string[] = [];
  const sent: Array<{
    customType?: string;
    content?: string;
    options?: { triggerTurn?: boolean; deliverAs?: string };
  }> = [];
  const notified: Array<{ message: string; type?: string }> = [];
  const calls: string[] = [];
  const activeTools = [...initialTools];
  let handler: Handler | undefined;

  const pi: Partial<ExtensionAPI> = {
    getCommands: () => [],
    registerCommand: (_name: string, opts: { handler: Handler }) => {
      handler = opts.handler;
    },
    sendMessage: (async (
      m: { customType?: string; content?: string },
      options?: { triggerTurn?: boolean; deliverAs?: string },
    ) => {
      if (sendMessageImpl) return sendMessageImpl(m, options);
      sent.push({ ...m, options });
      if (!options && typeof m.content === "string") printed.push(m.content);
    }) as ExtensionAPI["sendMessage"],
    getActiveTools: () => [...activeTools],
    setActiveTools: (toolNames: string[]) => {
      activeTools.splice(0, activeTools.length, ...toolNames);
    },
  };

  const manager: Partial<WorkflowManager> = {
    listRuns: () => [],
    findRun: (id: string) => ({
      runId: id,
      workflowName: "demo",
      script: "",
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    getSnapshot: () => null,
    getRun: () => undefined,
    getPersistence: () => ({ loadPreview: () => null }) as unknown as RunPersistence,
    stop: (id: string) => {
      calls.push(`stop:${id}`);
      return true;
    },
    pause: (id: string) => {
      calls.push(`pause:${id}`);
      return true;
    },
    resume: async (id: string) => {
      calls.push(`resume:${id}`);
      return false;
    },
    deleteRun: (id: string) => {
      calls.push(`rm:${id}`);
      return true;
    },
    ...managerOverrides,
  };

  registerWorkflowCommands(pi as unknown as ExtensionAPI, commandDeps({ manager, ...commandOptions }));
  const ctx = { ui: { notify: (message: string, type?: string) => notified.push({ message, type }) } };
  const run = (args: string, ctxOverrides: Record<string, unknown> = {}) => {
    if (!handler) throw new Error("command not registered");
    return handler(args, { ...ctx, ...ctxOverrides });
  };
  return { run, printed, sent, notified, calls, activeTools };
}

test("/workflows list shows empty hint when no runs", async () => {
  const h = harness();
  await h.run("list");
  assert.match(h.printed[0], /No workflow runs yet/);
});

test("/workflows (no args) defaults to list", async () => {
  const h = harness({
    listRuns: () => [{ runId: "run-1", workflowName: "demo", status: "completed", phases: [], agents: [], logs: [] }],
  });
  await h.run("");
  assert.match(h.printed[0], /Workflow runs:/);
  assert.match(h.printed[0], /run-1/);
});

test("/workflows (no args) in RPC mode prints the text list even though hasUI is true", async () => {
  // RPC hosts (e.g. Paseo) report hasUI=true because dialogs and notifications
  // work over the extension-UI protocol — but the navigator is a ui.custom()
  // TUI component that no-ops there. The command must fall back to plain text.
  const h = harness({
    listRuns: () => [{ runId: "run-1", workflowName: "demo", status: "completed", phases: [], agents: [], logs: [] }],
  });
  await h.run("", { mode: "rpc", hasUI: true });
  assert.match(h.printed[0], /Workflow runs:/);
  assert.match(h.printed[0], /run-1/);
});

test("/workflows ui in RPC mode falls back to the text list", async () => {
  const h = harness();
  await h.run("ui", { mode: "rpc", hasUI: true });
  assert.match(h.printed[0], /No workflow runs yet/);
});

test("/workflows (no args) in TUI mode opens the navigator", async () => {
  let customCalled = false;
  const h = harness();
  await h.run("", {
    mode: "tui",
    hasUI: true,
    ui: {
      notify: () => {},
      custom: () => {
        customCalled = true;
        return Promise.resolve();
      },
    },
  });
  assert.equal(customCalled, true, "should open the ui.custom() navigator in the TUI");
  assert.equal(h.printed.length, 0, "should not print the text list when the navigator opened");
});

test("/workflows run without prompt warns usage", async () => {
  const h = harness();
  await h.run("run");
  assert.equal(h.sent.length, 0);
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage: \/workflows run <prompt>/);
});

test("/workflows run <prompt> sends a forced workflow follow-up turn", async () => {
  const h = harness();
  await h.run("run audit auth boundaries");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].customType, "workflow-run");
  // #P5: /workflows run is an explicit command → forcing directive (no question-escape).
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("audit auth boundaries"));
  assert.doesNotMatch(h.sent[0].content ?? "", /answer it directly and stay/i, "no question-answer escape");
  assert.match(h.sent[0].content ?? "", /Call the `subagents` tool now/i, "forces the tool call");
  assert.equal(h.sent[0].options?.triggerTurn, true);
  assert.equal(h.sent[0].options?.deliverAs, "followUp");
  assert.deepEqual(h.activeTools, [SUBAGENTS_TOOL_NAME], "does not duplicate an already-active subagents tool");
});

test("/workflows run <prompt> notifies error when sendMessage rejects and does not bubble", async () => {
  const failingSend = async () => {
    throw new Error("send failed");
  };
  const h = harness({}, {}, [SUBAGENTS_TOOL_NAME], failingSend);
  await h.run("run audit auth");
  assert.ok(
    h.notified.some((n) => n.message === "Could not start the workflow turn."),
    "should notify the error message",
  );
});

test("/workflows run adds the subagents tool when it is not active", async () => {
  const h = harness({}, {}, ["bash", "read"]);
  await h.run("run summarize the auth module");
  assert.deepEqual(h.activeTools, ["bash", "read", SUBAGENTS_TOOL_NAME]);
  assert.equal(h.sent[0].content, buildForcedWorkflowPrompt("summarize the auth module"));
});

test("/workflows stop <id> calls manager.stop", async () => {
  const h = harness();
  await h.run("stop run-9");
  assert.deepEqual(h.calls, ["stop:run-9"]);
});

test("/workflows status <id> renders a persisted run", async () => {
  const h = harness({
    findRun: (id: string) =>
      id === "run-7"
        ? {
            runId: "run-7",
            workflowName: "audit",
            status: "completed",
            phases: ["Scan"],
            agents: [{ id: 1, label: "scan files", status: "done", prompt: "x" }],
            logs: [],
            tokenUsage: { input: 10, output: 5, total: 15 },
          }
        : undefined,
  });
  await h.run("status run-7");
  assert.match(h.printed[0], /audit \(run-7\)/);
  assert.match(h.printed[0], /scan files/);
});

test("/workflows status without id warns", async () => {
  const h = harness();
  await h.run("status");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
});

test("registerWorkflowCommands is idempotent (skips when already registered)", () => {
  let registrations = 0;
  const pi: Partial<ExtensionAPI> = {
    getCommands: () => [{ name: "workflows" } as SlashCommandInfo],
    registerCommand: () => {
      registrations++;
    },
  };
  registerWorkflowCommands(pi as unknown as ExtensionAPI, commandDeps({ manager: {} as unknown as WorkflowManager }));
  assert.equal(registrations, 0);
});

test("/workflows status watches a running run: live status bar + prints on completion", async () => {
  const snapshot = {
    name: "demo",
    phases: ["Run"],
    currentPhase: "Run",
    logs: [],
    agents: [{ id: 1, label: "a", status: "running", prompt: "x" }],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
  };
  const manager: any = new EventEmitter();
  manager.getRun = (id: string) => (id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined);
  manager.getSnapshot = () => null;
  manager.listRuns = () => [];

  const statusLine: Array<string | undefined> = [];
  const printed: string[] = [];
  let handler: ((a: string, c: any) => Promise<void>) | undefined;
  const pi: any = {
    getCommands: () => [],
    registerCommand: (_n: string, o: any) => {
      handler = o.handler;
    },
    sendMessage: async (m: any) => printed.push(m.content),
  };
  registerWorkflowCommands(
    pi as unknown as ExtensionAPI,
    commandDeps({ manager: manager as unknown as WorkflowManager }),
  );
  const ctx = { ui: { notify: () => {}, setStatus: (_k: string, t?: string) => statusLine.push(t) } };

  assert.ok(handler, "handler should exist");
  await handler("status run-1", ctx);
  assert.ok(
    statusLine.some((s) => typeof s === "string"),
    "sets a live status line",
  );
  assert.equal(printed.length, 0, "does not print until the run finishes");

  // Mark done and emit completion -> watcher prints the final snapshot and clears status.
  snapshot.agents[0].status = "done";
  manager.emit("complete", { runId: "run-1" });
  assert.equal(printed.length, 1, "prints final snapshot on completion");
  assert.ok(statusLine.includes(undefined), "clears the status line");
});

// ═══════════════════════════════════════════════════════════════════════════
// pause — calls manager.pause, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows pause <id> calls manager.pause and notifies Paused", async () => {
  const h = harness();
  await h.run("pause run-p1");
  assert.deepEqual(h.calls, ["pause:run-p1"], "should call manager.pause");
  assert.equal(h.notified.length, 1);
  assert.match(h.notified[0].message, /Paused.+run-p1/);
});

test("/workflows pause without id warns usage", async () => {
  const h = harness();
  await h.run("pause");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows pause <id> warns when manager.pause returns false", async () => {
  const h = harness({ pause: () => false });
  await h.run("pause run-nonexistent");
  assert.ok(
    h.notified.some((n) => n.message.includes("Cannot pause")),
    "should show cannot pause",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// resume — calls manager.resume, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows resume <id> calls manager.resume and notifies Resumed", async () => {
  const h = harness({
    resume: async (id: string) => {
      h.calls.push(`resume:${id}`);
      return true;
    },
  });
  await h.run("resume run-r1");
  assert.ok(
    h.calls.some((c) => c.startsWith("resume:run-r1")),
    "should call manager.resume",
  );
  assert.ok(
    h.notified.some((n) => n.message.includes("Resumed")),
    "should notify Resumed",
  );
});

test("/workflows resume without id warns usage", async () => {
  const h = harness();
  await h.run("resume");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows resume <id> warns when resume returns false", async () => {
  const h = harness({ resume: async () => false });
  await h.run("resume run-fail");
  assert.ok(
    h.notified.some((n) => n.message.includes("Resume not available")),
    "should show not available",
  );
  assert.equal(h.notified.find((n) => n.message.includes("Resume not available"))?.type, "warning");
});

// ═══════════════════════════════════════════════════════════════════════════
// rm — calls manager.deleteRun, shows notify
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows rm <id> calls manager.deleteRun and notifies Removed", async () => {
  const h = harness();
  await h.run("rm run-del1");
  assert.deepEqual(h.calls, ["rm:run-del1"], "should call manager.deleteRun");
  assert.ok(
    h.notified.some((n) => n.message.includes("Removed")),
    "should notify Removed",
  );
});

test("/workflows rm without id warns usage", async () => {
  const h = harness();
  await h.run("rm");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows rm <id> warns when deleteRun returns false", async () => {
  const h = harness({ deleteRun: () => false, findRun: () => undefined });
  await h.run("rm run-missing");
  assert.ok(
    h.notified.some((n) => n.message.includes("No run")),
    "should show No run",
  );
});

test("/workflows rm <id> distinguishes a lease refusal from 'no such run' (audit2 #16 r1)", async () => {
  const h = harness({
    deleteRun: () => false,
    getRun: () => ({ runId: "run-busy", status: "running" }),
  });
  await h.run("rm run-busy");
  const note = h.notified.find((n) => n.message.includes("run-busy"));
  assert.ok(note, "should notify about run-busy");
  assert.match(note.message, /active in another live session/, "should explain the refusal");
  assert.equal(note.type, "warning");
  assert.ok(!h.notified.some((n) => n.message.includes("No run")), "must not claim the leased run does not exist");
});

// ═══════════════════════════════════════════════════════════════════════════
// stop without id — warn usage
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows stop without id warns usage", async () => {
  const h = harness();
  await h.run("stop");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

test("/workflows stop <id> shows Cannot stop when manager returns false", async () => {
  const h = harness({ stop: () => false, getRun: () => undefined });
  await h.run("stop run-nonexistent");
  assert.ok(
    h.notified.some((n) => n.message.includes("Cannot stop")),
    "should show cannot stop",
  );
  assert.equal(h.notified.find((n) => n.message.includes("Cannot stop"))?.type, "warning");
});

test("/workflows stop <id> notifies info (not warning) when stopped a real run", async () => {
  const h = harness({ stop: () => true, getRun: () => ({}) });
  await h.run("stop run-active");
  const stopMsg = h.notified.find((n) => n.message.includes("Stopped"));
  assert.ok(stopMsg, "should notify Stopped");
  assert.equal(stopMsg?.type, "info", "should be info when run was actually running");
});

// ═══════════════════════════════════════════════════════════════════════════
// save — saves a run's script as a saved workflow
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows save without name warns usage", async () => {
  const h = harness();
  await h.run("save");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Usage/);
});

/** A manager fake that finds runs in any session and lists this session's runs. */
function runsManager(runs: Array<Record<string, unknown>>, started: string[] = []) {
  return {
    listRuns: () => runs,
    findRun: (id: string) => runs.find((run) => run.runId === id),
    getSnapshot: () => null,
    getRun: () => undefined,
    pause: () => false,
    resume: async () => false,
    stop: () => false,
    deleteRun: () => false,
    startInBackground: (script: string) => {
      started.push(script);
      return { runId: "bg-from-save", promise: new Promise(() => {}) };
    },
  } as unknown as WorkflowManager;
}

/** The /workflows handler and its registered commands over a real project storage. */
function saveCommandHarness(manager: WorkflowManager, takenCommands: string[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "pwl-save-cmd-"));
  const storage = createWorkflowStorage(cwd);
  const commands: Array<{ name: string; handler: Handler }> = takenCommands.map((name) => ({
    name,
    handler: async () => {},
  }));
  registerWorkflowCommands(
    {
      getCommands: () => commands.map((c) => ({ name: c.name })),
      registerCommand: (name: string, opts: { handler: Handler }) => commands.push({ name, handler: opts.handler }),
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    commandDeps({ manager, storage, cwd }),
  );
  const notified: Array<{ message: string; type?: string }> = [];
  const run = async (args: string) => {
    const workflows = commands.find((c) => c.name === "workflows");
    assert.ok(workflows, "workflows command must register");
    await workflows.handler(args, {
      ui: { notify: (m: string, t?: string) => notified.push({ message: m, type: t }) },
    });
  };
  return { storage, commands, notified, run, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("/workflows save <name> saves the most recent run with a script and registers a live command", async () => {
  const runs = [
    { runId: "old", workflowName: "old", status: "completed", script: null, agents: [], logs: [] },
    {
      runId: "recent",
      workflowName: "scan",
      status: "completed",
      script: "export const meta = { name: 'scan', description: 'scan' }; export SCRIPT_V1",
      agents: [],
      logs: [],
    },
  ];
  const started: string[] = [];
  const h = saveCommandHarness(runsManager(runs, started));
  try {
    await h.run("save my-scan");
    assert.equal(h.storage.load("my-scan")?.script, runs[1].script);
    assert.ok(
      h.notified.some((n) => n.message.includes("Saved") && n.message.includes("recent")),
      "should notify Saved with the source run id",
    );
    const savedCmd = h.commands.find((c) => c.name === "my-scan");
    assert.ok(savedCmd, "save must register /my-scan");
    await savedCmd.handler("", { ui: { notify: () => {}, setStatus: () => {} } });
    assert.deepEqual(started, [runs[1].script], "registered command must run via manager.startInBackground");
  } finally {
    h.cleanup();
  }
});

test("/workflows save <name> <runId> saves the named run, wherever it was started", async () => {
  const target = {
    runId: "run-target",
    workflowName: "audit",
    status: "completed",
    script: "export const meta = { name: 'audit', description: 'audit' }",
    toolset: "web-research",
    agents: [],
    logs: [],
  };
  // The run belongs to another session, so this session's list does not show it.
  const manager = { ...runsManager([target]), listRuns: () => [] } as unknown as WorkflowManager;
  const h = saveCommandHarness(manager);
  try {
    await h.run("save target-name run-target");
    const saved = h.storage.load("target-name");
    assert.equal(saved?.script, target.script);
    assert.equal(saved?.toolset, "web-research", "the run's toolset goes with it");
    assert.ok(h.notified.some((n) => n.message.includes("Saved")));
  } finally {
    h.cleanup();
  }
});

test("/workflows save <name> <runId> warns when run has no script", async () => {
  const h = saveCommandHarness(
    runsManager([{ runId: "no-script", workflowName: "empty", status: "completed", agents: [], logs: [] }]),
  );
  try {
    await h.run("save empty no-script");
    assert.equal(h.notified.length, 1);
    assert.match(h.notified[0].message, /No run/, "should warn no script");
    assert.equal(h.storage.load("empty"), null);
  } finally {
    h.cleanup();
  }
});

const OLD_SCRIPT = "export const meta = { name: 'scan', description: 'old' }\nreturn 'old'";
const NEW_SCRIPT = "export const meta = { name: 'scan', description: 'new' }\nreturn 'new'";

/** `/workflows save scan` over a real project storage that already holds OLD_SCRIPT, with a run of NEW_SCRIPT. */
function replaceSaveHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "pwl-save-cmd-"));
  const storage = createWorkflowStorage(cwd);
  const seeded = storage.save({ name: "scan", description: "scan", script: OLD_SCRIPT });
  assert.ok(seeded.ok);
  const { path } = seeded.workflow;
  const run = { runId: "run-new", workflowName: "scan", status: "completed", script: NEW_SCRIPT, agents: [], logs: [] };
  const commands: string[] = [];
  let workflowsHandler: Handler | undefined;
  registerWorkflowCommands(
    {
      getCommands: () => commands.map((name) => ({ name })),
      registerCommand: (name: string, opts: { handler: Handler }) => {
        commands.push(name);
        if (name === "workflows") workflowsHandler = opts.handler;
      },
      sendMessage: async () => {},
    } as unknown as ExtensionAPI,
    commandDeps({ manager: runsManager([run]), storage, cwd }),
  );
  const notified: Array<{ message: string; type?: string }> = [];
  const questions: string[] = [];
  /** Run the save; `answer` is the confirm dialog's reply, or undefined for a host without UI. */
  const save = async (answer: boolean | undefined) => {
    assert.ok(workflowsHandler);
    await workflowsHandler("save scan", {
      hasUI: answer !== undefined,
      ui: {
        notify: (message: string, type?: string) => notified.push({ message, type }),
        confirm: async (title: string, message: string) => {
          questions.push(`${title} ${message}`);
          return answer ?? false;
        },
      },
    });
  };
  const files = () => {
    const read = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { script: string }).script;
    return { primary: read(path), backup: read(`${path}.bak`) };
  };
  return { path, notified, questions, save, files, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("/workflows save asks before replacing a different same-name workflow and keeps it when declined", async () => {
  const h = replaceSaveHarness();
  try {
    await h.save(false);
    assert.equal(h.questions.length, 1);
    assert.ok(h.questions[0].includes(h.path), "the question names the exact file being replaced");
    assert.equal(h.files().primary, OLD_SCRIPT);
    assert.deepEqual(h.notified.at(-1), { message: "Kept the existing /scan", type: "info" });
  } finally {
    h.cleanup();
  }
});

test("/workflows save replaces after confirmation and skips a repeated identical save, keeping the backup", async () => {
  const h = replaceSaveHarness();
  try {
    await h.save(true);
    assert.deepEqual(h.files(), { primary: NEW_SCRIPT, backup: OLD_SCRIPT });
    assert.match(h.notified.at(-1)?.message ?? "", /^Saved \/scan \(from run-new\)/);

    await h.save(true);
    assert.equal(h.questions.length, 1, "identical content needs no question");
    assert.deepEqual(h.files(), { primary: NEW_SCRIPT, backup: OLD_SCRIPT }, "the backup still holds the old script");
    assert.match(h.notified.at(-1)?.message ?? "", /already saved with this script/);
  } finally {
    h.cleanup();
  }
});

test("/workflows save refuses to replace a workflow without a UI to confirm", async () => {
  const h = replaceSaveHarness();
  try {
    await h.save(undefined);
    assert.equal(h.questions.length, 0);
    assert.equal(h.files().primary, OLD_SCRIPT);
    assert.equal(h.notified.at(-1)?.type, "warning");
    assert.match(h.notified.at(-1)?.message ?? "", /^Not saved: the project workflow \/scan .* needs confirmation/);
    assert.ok(h.notified.at(-1)?.message.includes(h.path));
  } finally {
    h.cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// unknown subcommand
// ═══════════════════════════════════════════════════════════════════════════

test("/workflows <unknown> warns usage", async () => {
  const h = harness();
  await h.run("bogus");
  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].type, "warning");
  assert.match(h.notified[0].message, /Unknown subcommand/);
});

test("/workflows status watch ends when the run is deleted (audit2 #34)", async () => {
  const snapshot = {
    name: "demo",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
  };
  const manager: any = new EventEmitter();
  manager.getRun = (id: string) => (id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined);
  manager.getSnapshot = () => null;
  manager.listRuns = () => [];

  const statusLine: Array<string | undefined> = [];
  let handler: ((a: string, c: any) => Promise<void>) | undefined;
  const pi: any = {
    getCommands: () => [],
    registerCommand: (_n: string, o: any) => {
      handler = o.handler;
    },
    sendMessage: async () => {},
  };
  registerWorkflowCommands(
    pi as unknown as ExtensionAPI,
    commandDeps({ manager: manager as unknown as WorkflowManager }),
  );
  const ctx = { ui: { notify: () => {}, setStatus: (_k: string, t?: string) => statusLine.push(t) } };
  assert.ok(handler);
  await handler("status run-1", ctx);
  const listenersBefore = progressAndFinalListenerCount(manager);
  assert.ok(listenersBefore > 0, "watch subscribed");

  // Deleting the watched run emits "deleted" — the watcher must finish and
  // remove every listener instead of leaking them for the process lifetime.
  manager.emit("deleted", { runId: "run-1" });
  assert.equal(progressAndFinalListenerCount(manager), 0, "all watch listeners removed on delete");
  assert.ok(statusLine.includes(undefined), "the status-bar entry is cleared");
});

function progressAndFinalListenerCount(manager: EventEmitter): number {
  return ["agentStart", "agentEnd", "phase", "log", "tokenUsage", "complete", "error", "stopped", "paused", "deleted"]
    .map((ev) => manager.listenerCount(ev))
    .reduce((a, b) => a + b, 0);
}

test("/workflows status watch survives a throwing sendMessage/setStatus (audit2 #37)", async () => {
  const snapshot = {
    name: "demo",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 1,
    runningCount: 0,
    doneCount: 1,
    errorCount: 0,
  };
  const manager: any = new EventEmitter();
  // "running" — with a terminal status watchRun returns early and zero
  // listeners exist, making this test vacuous (r2).
  manager.getRun = (id: string) => (id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined);
  manager.getSnapshot = () => null;
  manager.listRuns = () => [];
  let handler: ((a: string, c: any) => Promise<void>) | undefined;
  const pi: any = {
    getCommands: () => [],
    registerCommand: (_n: string, o: any) => {
      handler = o.handler;
    },
    sendMessage: () => {
      throw new Error("stale ctx");
    },
  };
  registerWorkflowCommands(
    pi as unknown as ExtensionAPI,
    commandDeps({ manager: manager as unknown as WorkflowManager }),
  );
  const ctx = {
    ui: {
      notify: () => {},
      setStatus: (_k: string, text?: string) => {
        // Throw only on the TEARDOWN call — the subscribe-time update() also
        // sets a status line and must succeed for listeners to register.
        if (text === undefined) throw new Error("stale ui");
      },
    },
  };
  assert.ok(handler);
  await handler("status run-1", ctx);
  assert.ok(progressAndFinalListenerCount(manager) > 0, "watch actually subscribed (non-vacuous)");
  assert.doesNotThrow(() => manager.emit("complete", { runId: "run-1" }), "finish swallows stale-ctx failures");
  assert.equal(progressAndFinalListenerCount(manager), 0, "listeners still torn down");
});

test("/workflows save refuses a name another extension owns before anything is written", async () => {
  const runs = [
    {
      runId: "recent",
      workflowName: "scan",
      status: "completed",
      script: "export const meta = { name: 'scan', description: 'scan' }",
      agents: [],
      logs: [],
    },
  ];
  const h = saveCommandHarness(runsManager(runs), ["host-owned"]);
  try {
    await h.run("save host-owned");
    assert.equal(h.storage.load("host-owned"), null, "nothing reaches disk");
    assert.equal(h.notified.length, 1);
    assert.equal(h.notified[0].type, "error");
    assert.match(h.notified[0].message, /^Not saved: \/host-owned is already provided/);
  } finally {
    h.cleanup();
  }
});

/** A /workflows handler over an event-emitting manager whose run-1 is running. */
function watchHarness() {
  const snapshot = { name: "demo", phases: [], logs: [], agents: [], agentCount: 1 };
  const manager: any = new EventEmitter();
  manager.getRun = (id: string) => (id === "run-1" ? { runId: "run-1", status: "running", snapshot } : undefined);
  manager.getSnapshot = () => null;
  manager.listRuns = () => [];
  let handler: Handler | undefined;
  const sent: unknown[] = [];
  registerWorkflowCommands(
    {
      getCommands: () => [],
      registerCommand: (_n: string, o: { handler: Handler }) => {
        handler = o.handler;
      },
      sendMessage: (message: unknown) => sent.push(message),
    } as unknown as ExtensionAPI,
    commandDeps({ manager: manager as unknown as WorkflowManager }),
  );
  return { manager: manager as EventEmitter, sent, watch: (ctx: unknown) => handler?.("watch run-1", ctx) };
}

test("/workflows watch of a run already watched replaces the watcher instead of adding one", async () => {
  const h = watchHarness();
  const ui = { notify: () => {}, setStatus: () => {} };
  await h.watch({ ui });
  const once = progressAndFinalListenerCount(h.manager);
  await h.watch({ ui });
  assert.equal(progressAndFinalListenerCount(h.manager), once, "one set of listeners per run");
  h.manager.emit("complete", { runId: "run-1" });
  assert.equal(h.sent.length, 1, "the final snapshot prints once");
});

test("a watcher whose session went stale stops quietly instead of throwing into the run", async () => {
  const h = watchHarness();
  let stale = false;
  await h.watch({
    ui: {
      notify: () => {},
      setStatus: () => {
        if (stale) throw new Error("This extension ctx is stale after session replacement");
      },
    },
  });
  stale = true;
  assert.doesNotThrow(() => h.manager.emit("phase", { runId: "run-1" }), "progress never throws into the run");
  assert.equal(progressAndFinalListenerCount(h.manager), 0, "the stale watcher is gone");
});

test("session shutdown ends every watcher", async () => {
  const h = watchHarness();
  await h.watch({ ui: { notify: () => {}, setStatus: () => {} } });
  assert.ok(progressAndFinalListenerCount(h.manager) > 0);
  stopRunWatchers();
  assert.equal(progressAndFinalListenerCount(h.manager), 0);
});
