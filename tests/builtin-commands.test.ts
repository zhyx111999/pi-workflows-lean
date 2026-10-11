import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinWorkflows } from "../src/builtin-commands.js";
import { registerSavedWorkflow, savedWorkflowCommandAvailability } from "../src/saved-commands.js";
import { parseWorkflowScript } from "../src/workflow.js";
import type { WorkflowManager } from "../src/workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "../src/workflow-saved.js";
import { commandDeps } from "./helpers/command-deps.js";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

/** Fake WorkflowStorage exposing only fixed `load()` results — enough for the shadow tests. */
function makeFakeStorage(saved: Record<string, Pick<SavedWorkflow, "script" | "parameters">>): WorkflowStorage {
  return {
    load(name: string) {
      const entry = saved[name];
      if (!entry) return null;
      return {
        name,
        description: "saved override",
        script: entry.script,
        parameters: entry.parameters,
        location: "project",
        path: `/fake/${name}.json`,
        savedAt: new Date(0).toISOString(),
      };
    },
    save() {
      throw new Error("not implemented in this fake");
    },
    list() {
      return [];
    },
    delete(workflow) {
      return { ok: false, code: "missing", message: `${workflow.name} is not saved in this fake` };
    },
    rename(workflow) {
      return { ok: false, code: "missing", message: `${workflow.name} is not saved in this fake` };
    },
  };
}

/**
 * Fake manager that records startInBackground calls. The returned promise never
 * resolves — so any handler that (incorrectly) awaited it would hang its test,
 * which is how a handler that blocks the session would show up.
 */
function makeFakeManager() {
  const started: Array<{ script: string; args: unknown; exec: { tools?: unknown[] } }> = [];
  const manager = {
    startInBackground(script: string, args?: unknown, exec: { tools?: unknown[] } = {}) {
      started.push({ script, args, exec });
      return { runId: `run-test-${started.length}`, promise: new Promise(() => {}) };
    },
  } as unknown as WorkflowManager;
  return { manager, started };
}

test("registerBuiltinWorkflows registers the deep-research command", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager: makeFakeManager().manager }));
  assert.deepEqual(
    commands.map((c) => c.name),
    ["deep-research"],
  );
});

test("registerBuiltinWorkflows is idempotent — skips already registered commands", () => {
  const { pi, commands } = makeCommandRegistryPi(["deep-research"]);
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager: makeFakeManager().manager }));
  assert.equal(commands.length, 0, "should not re-register when already present");
});

test("saved workflow cannot claim a built-in name occupied by a third-party command", () => {
  const { pi, commands } = makeCommandRegistryPi(["deep-research"]);
  const availability = savedWorkflowCommandAvailability(pi, "deep-research");
  assert.equal(availability.ok, false);
  const result = registerSavedWorkflow(
    pi,
    {
      name: "deep-research",
      description: "third-party collision",
    },
    () => makeFakeManager().manager,
    () => null,
  );
  assert.equal(result.ok, false);
  assert.equal(commands.length, 0, "the rejected command must not be registered");
});

test("saved workflow may shadow a built-in only after this extension owns its handler", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager: makeFakeManager().manager }));
  assert.equal(savedWorkflowCommandAvailability(pi, "deep-research").ok, true);
  const result = registerSavedWorkflow(
    pi,
    {
      name: "deep-research",
      description: "saved shadow",
    },
    () => makeFakeManager().manager,
    () => null,
  );
  assert.equal(result.ok, true);
  assert.equal(commands.filter((command) => command.name === "deep-research").length, 1);
});

test("saved workflow rejects an ordinary third-party command name", () => {
  const { pi, commands } = makeCommandRegistryPi(["ordinary-command"]);
  const result = registerSavedWorkflow(
    pi,
    {
      name: "ordinary-command",
      description: "collision",
    },
    () => makeFakeManager().manager,
    () => null,
  );
  assert.equal(result.ok, false);
  assert.equal(commands.length, 0);
});

test("registerBuiltinWorkflows deep-research handler validates empty args (returns early)", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(
    pi,
    commandDeps({ cwd: "/tmp", manager: makeFakeManager().manager, storage: makeFakeStorage({}) }),
  );
  const deepResearchHandler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(deepResearchHandler, "deep-research handler should exist");

  // Calling with empty args should warn and return early (before running any workflow)
  const { ctx, notified } = makeNotifyCtx();
  await deepResearchHandler("", ctx);
  assert.equal(notified.length, 1, "should notify with warning");
  assert.equal(notified[0].type, "warning", "should be a warning");
  assert.ok(notified[0].message.includes("Usage"), "should tell the user how to use it");
});

test("built-in handlers start a background run and return immediately", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager, storage: makeFakeStorage({}) }));
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);

  const { ctx, notified } = makeNotifyCtx();
  // The fake manager's promise never resolves — if the handler awaited the run
  // (the old inline behavior), this await would hang the test.
  await handler("audit the error paths", ctx);

  assert.equal(started.length, 1, "should start exactly one managed background run");
  assert.deepEqual(started[0].args, { question: "audit the error paths" });
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "info");
  assert.ok(notified[0].message.includes("run-test-1"), "start notice should include the run id");
  assert.ok(notified[0].message.includes("background"), "start notice should say it runs in the background");
});

test("background start notice is mode-aware: TUI points at the task panel, other hosts at /workflows status", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager } = makeFakeManager();
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager, storage: makeFakeStorage({}) }));
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);

  const tui = makeNotifyCtx("tui");
  await handler("audit the error paths", tui.ctx);
  assert.ok(tui.notified[0].message.includes("task panel"), "TUI notice should point at the task panel");

  // RPC hosts (e.g. Paseo) cannot render the TUI task panel or navigator —
  // the notice must point at the plain-text status command instead.
  const rpc = makeNotifyCtx("rpc");
  await handler("audit the error paths", rpc.ctx);
  assert.ok(!rpc.notified[0].message.includes("task panel"), "RPC notice must not mention the task panel");
  assert.ok(
    rpc.notified[0].message.includes("/workflows status run-test-2"),
    `RPC notice should point at /workflows status <id>, got: ${rpc.notified[0].message}`,
  );
});

test("deep-research passes web tools on top of coding tools to its run", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager, storage: makeFakeStorage({}) }));
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);

  const { ctx } = makeNotifyCtx();
  await handler("what is pi?", ctx);

  assert.equal(started.length, 1);
  assert.deepEqual(started[0].args, { question: "what is pi?" });
  assert.ok(Array.isArray(started[0].exec.tools), "deep-research must pass an explicit tool set");
  const toolNames = (started[0].exec.tools as Array<{ name: string }>).map((t) => t.name);
  assert.ok(
    toolNames.some((n) => /search|fetch|web/i.test(n)),
    `tool set should include web tools, got: ${toolNames.join(", ")}`,
  );
  // The persistable tag is what lets a resumed run re-resolve these tools.
  assert.equal((started[0].exec as { toolset?: string }).toolset, "web-research");
});

test("startInBackground throwing synchronously surfaces as an error notify, not an unhandled throw", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const manager = {
    startInBackground() {
      throw new Error("lease unavailable");
    },
  } as unknown as WorkflowManager;
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager, storage: makeFakeStorage({}) }));
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);

  const { ctx, notified } = makeNotifyCtx();
  await handler("some question", ctx);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "error");
  assert.ok(notified[0].message.includes("lease unavailable"));
});

test("registerBuiltinWorkflows creates handlers with expected structure", () => {
  const { pi, commands } = makeCommandRegistryPi();
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager: makeFakeManager().manager }));

  const deepResearchCmd = commands.find((c) => c.name === "deep-research");
  assert.ok(deepResearchCmd, "deep-research should be registered");
  assert.ok(deepResearchCmd.description?.includes("Research"), "should have research description");
  assert.equal(typeof deepResearchCmd.handler, "function");
});

// ─── Precedence: a saved workflow shadows a built-in of the same name ──────────
//
// Builtins register their commands before saved workflows do (see
// extensions/workflow.ts), and registerSavedWorkflow skips a name that's
// already registered — so without a dynamic check here, a saved workflow
// named e.g. "deep-research" would never actually run from its slash command,
// contradicting the `subagents` tool's `name` path (where saved always wins).
// These tests pin "saved wins" on the slash-command path too.

test("a saved workflow shadows the built-in slash command of the same name", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  const customScript = "export const meta = { name: 'custom_deep_research', description: 'override' }\nreturn 1";
  const storage = makeFakeStorage({ "deep-research": { script: customScript } });
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager, storage }));
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);

  const { ctx, notified } = makeNotifyCtx();
  await handler("what is pi?", ctx);

  assert.equal(started.length, 1, "should start exactly one run");
  assert.equal(started[0].script, customScript, "the saved script should run, not the built-in's");
  assert.deepEqual(
    started[0].exec,
    { toolset: undefined },
    "the shadow runs with the saved workflow's own toolset (none here), not the built-in's web tools",
  );
  assert.equal(notified.length, 1);
  assert.equal(notified[0].type, "info");
});

test("a saved workflow shadow skips the built-in's own argument validation", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  const customScript = "export const meta = { name: 'custom_research', description: 'override' }\nreturn 1";
  const storage = makeFakeStorage({ "deep-research": { script: customScript } });
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager, storage }));
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);

  const { ctx } = makeNotifyCtx();
  // An empty question would fail the built-in's own "Usage" guard, but the
  // shadow behaves like any other saved workflow command and just forwards
  // the parsed args.
  await handler("", ctx);

  assert.equal(started.length, 1, "the shadow should start a run even with args the built-in would reject");
  assert.equal(started[0].script, customScript);
  assert.deepEqual(started[0].args, { _: "", _raw: "" });
});

test("deep-research still runs the built-in when no saved workflow shadows it", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  const storage = makeFakeStorage({});
  registerBuiltinWorkflows(pi, commandDeps({ cwd: "/tmp", manager, storage }));
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);

  const { ctx } = makeNotifyCtx();
  await handler("what is pi?", ctx);

  assert.equal(started.length, 1);
  const { meta } = parseWorkflowScript(started[0].script);
  assert.equal(meta.name, "deep_research", "the built-in should run when nothing shadows it");
});

test("a saved shadow of a builtin receives the builtin's positional argument", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(
    pi,
    commandDeps({
      cwd: "/tmp",
      manager,
      storage: makeFakeStorage({
        "deep-research": { script: "export const meta = { name: 'shadow', description: 's' }" },
      }),
    }),
  );
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);
  const { ctx } = makeNotifyCtx();
  await handler("quantum computing advances", ctx);
  assert.equal(started.length, 1, "the shadow ran");
  const args = started[0].args as Record<string, unknown>;
  assert.equal(args.question, "quantum computing advances", "bare positional maps to the builtin's question contract");
});

test("a saved shadow does not override an explicitly named argument", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(
    pi,
    commandDeps({
      cwd: "/tmp",
      manager,
      storage: makeFakeStorage({
        "deep-research": { script: "export const meta = { name: 'shadow', description: 's' }" },
      }),
    }),
  );
  const handler = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(handler);
  const { ctx } = makeNotifyCtx();
  await handler("question=explicit-topic extra words", ctx);
  const args = started[0].args as Record<string, unknown>;
  assert.equal(args.question, "explicit-topic", "the named arg wins; positionals stay in _");
});

test("shadow positional mapping: equals-only topics and declared defaults", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(
    pi,
    commandDeps({
      cwd: "/tmp",
      manager,
      storage: makeFakeStorage({
        "deep-research": {
          script: "export const meta = { name: 'shadow', description: 's' }",
          parameters: { question: { type: "string", default: "DEFAULT" } },
        },
      }),
    }),
  );
  const { ctx } = makeNotifyCtx();
  const deep = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(deep);

  // "="-containing topic survives (parseCommandArgs treats it as key=value).
  await deep("a=b=c", ctx);
  assert.equal((started[0].args as Record<string, unknown>).question, "a=b=c");

  // A bare positional beats the declared parameter default.
  await deep("explicit topic", ctx);
  assert.equal((started[1].args as Record<string, unknown>).question, "explicit topic");
});

test("shadow whole-string mapping keeps equals-containing topics whole", async () => {
  const { pi, commands } = makeCommandRegistryPi();
  const { manager, started } = makeFakeManager();
  registerBuiltinWorkflows(
    pi,
    commandDeps({
      cwd: "/tmp",
      manager,
      storage: makeFakeStorage({
        "deep-research": { script: "export const meta = { name: 'shadow', description: 's' }" },
      }),
    }),
  );
  const deep = commands.find((c) => c.name === "deep-research")?.handler;
  assert.ok(deep);
  const { ctx } = makeNotifyCtx();
  await deep("what does a=b mean", ctx);
  assert.equal(
    (started[0].args as Record<string, unknown>).question,
    "what does a=b mean",
    "the full trimmed string, exactly like the builtin",
  );
});
