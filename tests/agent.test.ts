import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listAvailableModelSpecs } from "../src/agent/available-models.js";
import { runtimeOf } from "../src/agent/model-registry.js";
import { AgentModelSelector, routeAgentModel } from "../src/agent/model-selection.js";
import { isProviderMiddlewareExtensionPath } from "../src/agent/provider-middleware.js";
import type { SessionManagers } from "../src/agent/session-managers.js";
import { DEFAULT_EXCLUDED_SUBAGENT_TOOLS, subagentExcludedTools } from "../src/agent/session-tools.js";
import { usageFromStats } from "../src/agent/session-usage.js";
import { finalAssistantText, lastAssistantText } from "../src/agent/turn-result.js";
import type { AgentRunOptions } from "../src/agent.js";
import { DEFAULT_PROVIDER_MIDDLEWARE_EXTENSIONS, WorkflowAgent } from "../src/agent.js";
import type { AgentUsage } from "../src/agent-usage.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { resolveModelSpecWithThinking } from "../src/model-spec.js";
import {
  getModelTierConfigPath,
  getProjectModelTierConfigPath,
  type ModelTierConfig,
} from "../src/model-tier-config.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { withFakeHome, withFakeHomeAsync } from "./helpers/fake-home.js";
import { fauxRegistry, fauxRegistryFor } from "./helpers/faux-registry.js";
import { catalogModel, catalogRegistry } from "./helpers/model-catalog.js";
import { readProviderSystemPrompt } from "./helpers/pi-context.js";

// Private methods used for testing - cast to this type to access them without `any`
type WorkflowAgentPrivates = {
  buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string;
  sessionManagers: SessionManagers;
  restoreThreadLeaf(manager: SessionManager, leafId: string | null): void;
  getRegistry(perRunRegistry?: ModelRegistry): Promise<ModelRegistry>;
  getSharedResourceLoader(agentDir: string, cwd?: string): Promise<DefaultResourceLoader>;
};

function bashToolResultText(context: unknown): string {
  const messages = (context as { messages?: Array<Record<string, unknown>> }).messages ?? [];
  const result = messages.find((message) => message.role === "toolResult" && message.toolName === "bash");
  assert.ok(result, "the follow-up request must contain the bash tool result");
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

/**
 * Prints the bash tool's working directory. Git Bash's `pwd` prints an MSYS
 * path (/tmp/...) while `pwd -W` prints the Windows path; other shells reject
 * `-W` and fall back to plain `pwd`.
 */
const PRINT_CWD_COMMAND = "pwd -W 2>/dev/null || pwd";

/** The directory PRINT_CWD_COMMAND reported, as a native path. */
function bashCwd(context: unknown): string {
  // Strip only the newline: a trailing space belongs to the directory name.
  return resolve(bashToolResultText(context).replace(/\n$/, ""));
}

// ═══════════════════════════════════════════════════════════════════════
// persistAgentSessions — in-memory by default, file-backed keyed by project cwd
// ═══════════════════════════════════════════════════════════════════════

test("WorkflowAgent uses an in-memory session manager by default", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const manager = (agent as unknown as WorkflowAgentPrivates).sessionManagers.forCall();
  assert.equal(manager.isPersisted(), false, "default must stay in-memory (back-compat)");
});

test("WorkflowAgent with persistAgentSessions=false explicitly stays in-memory", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", persistAgentSessions: false });
  const manager = (agent as unknown as WorkflowAgentPrivates).sessionManagers.forCall();
  assert.equal(manager.isPersisted(), false);
});

test("WorkflowAgent with persistAgentSessions=true creates a file-backed manager keyed by the project cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-persist-agent-"));
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      const agent = new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true });
      const manager = (agent as unknown as WorkflowAgentPrivates).sessionManagers.forCall();
      assert.equal(manager.isPersisted(), true, "flag must yield a file-backed session manager");
      // Sessions must be keyed by the runner's project cwd — never a per-call
      // worktree cwd — so transcripts group under the project's session dir.
      // The optional per-call cwd validates thread continuity only; the
      // manager must still use the project cwd.
      assert.equal(manager.getCwd(), projectCwd);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistent child sessions record the parentSession header without inheriting messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-lineage-"));
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      const parentDir = join(dir, "parent-sessions");
      const parent = SessionManager.create(projectCwd, parentDir);
      parent.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);
      const parentSessionFile = parent.getSessionFile();
      assert.ok(parentSessionFile);

      const agent = new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true, parentSessionFile });
      const child = (agent as unknown as WorkflowAgentPrivates).sessionManagers.forCall();
      assert.equal(child.getHeader()?.parentSession, parentSessionFile);
      assert.deepEqual(child.getEntries(), [], "parent messages must not be inherited");

      // Pi flushes the lazily-created header when the first assistant message
      // arrives; inspect the durable JSONL header as the graph will do.
      child.appendMessage({ role: "assistant", content: [], timestamp: Date.now() } as never);
      const header = JSON.parse(readFileSync(child.getSessionFile() as string, "utf8").split("\n", 1)[0]);
      assert.equal(header.parentSession, parentSessionFile);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistent and in-memory child sessions omit parentSession without a parent file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-no-parent-"));
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      const persistent = (
        new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true }) as unknown as WorkflowAgentPrivates
      ).sessionManagers.forCall();
      assert.equal(persistent.getHeader()?.parentSession, undefined);

      const ephemeral = (
        new WorkflowAgent({
          cwd: projectCwd,
          persistAgentSessions: false,
          parentSessionFile: "/parent.jsonl",
        }) as unknown as WorkflowAgentPrivates
      ).sessionManagers.forCall();
      assert.equal(ephemeral.isPersisted(), false);
      assert.equal(ephemeral.getSessionFile(), undefined, "ephemeral children must not claim a session file");
      assert.equal(ephemeral.getHeader()?.parentSession, undefined);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onSessionCreated reports the effective manager before prompting and preserves thread cwd and lineage", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-session-created-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-session-created-cwd-"));
  const worktree = mkdtempSync(join(tmpdir(), "pi-dw-session-created-worktree-"));
  const core = createFauxCore({
    provider: "fauxtest-session-created",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-session-created", core);
      const injected = SessionManager.inMemory();
      const parentSessionFile = join(home, "parent.jsonl");
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry: registry,
        persistAgentSessions: true,
        parentSessionFile,
        session: { sessionManager: injected },
      });
      const identities: Array<{ sessionId: string; sessionFile?: string }> = [];
      let prompts = 0;
      core.setResponses(
        [1, 2, 3].map(() => () => {
          prompts++;
          assert.equal(identities.length, prompts, "identity must arrive before each provider request");
          return fauxAssistantMessage("identity captured", { stopReason: "stop" });
        }),
      );
      const options = {
        model: "fauxtest-session-created/faux-model",
        cwd: worktree,
        onSessionCreated: (identity: { sessionId: string; sessionFile?: string }) => identities.push(identity),
      };
      await agent.run("one shot", options);
      assert.deepEqual(identities[0], { sessionId: injected.getSessionId(), sessionFile: undefined });
      assert.ok(injected.getEntries().length > 0, "the reported injected manager must be the one prompted");

      await agent.run("first threaded turn", { ...options, thread: "worker" });
      await agent.run("second threaded turn", { ...options, thread: "worker" });
      assert.deepEqual(identities[2], identities[1], "thread turns must report one stable identity");
      assert.notEqual(identities[1].sessionId, injected.getSessionId());
      const threadManager = (agent as unknown as WorkflowAgentPrivates).sessionManagers.forCall("worker", worktree);
      assert.equal(identities[1].sessionId, threadManager.getSessionId());
      assert.equal(identities[1].sessionFile, threadManager.getSessionFile());
      assert.equal(threadManager.getCwd(), cwd, "persistence stays grouped by the project, not worktree");
      assert.equal(threadManager.getHeader()?.parentSession, parentSessionFile);
      await assert.rejects(agent.run("wrong cwd", { ...options, thread: "worker", cwd }), /cannot change cwd/);
      assert.equal(identities.length, 3, "a rejected cwd must not announce a new child session");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("registerSteer queues host instructions into the live session and unregisters before disposal", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-steer-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-steer-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-steer",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-steer", core);
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      let steer: ((text: string) => Promise<void>) | undefined;
      let unregistered = 0;
      core.setResponses([
        async () => {
          assert.ok(steer, "the session is steerable before its first provider request");
          await steer("Also cover the steered detail.");
          return fauxAssistantMessage("first answer", { stopReason: "stop" });
        },
        (context) => {
          const users = context.messages.filter((message) => message.role === "user");
          assert.match(JSON.stringify(users.at(-1)?.content), /steered detail/);
          assert.equal(unregistered, 0, "still registered while the session runs");
          return fauxAssistantMessage("answer with the steered detail", { stopReason: "stop" });
        },
      ]);

      const result = await agent.run("original task", {
        model: "fauxtest-steer/faux-model",
        registerSteer: (fn) => {
          steer = fn;
          return () => unregistered++;
        },
      });

      assert.equal(result, "answer with the steered detail");
      assert.equal(unregistered, 1, "unregistered exactly once when the session ends");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent retains one session manager per named thread", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentPrivates;
  const first = agent.sessionManagers.forCall("implementer");
  const again = agent.sessionManagers.forCall("implementer");
  const reviewer = agent.sessionManagers.forCall("reviewer");

  assert.equal(again, first);
  assert.equal(again.getSessionId(), first.getSessionId());
  assert.notEqual(reviewer.getSessionId(), first.getSessionId());
  const nextInvocation = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentPrivates;
  assert.notEqual(nextInvocation.sessionManagers.forCall("implementer").getSessionId(), first.getSessionId());
  assert.notEqual(agent.sessionManagers.forCall(), agent.sessionManagers.forCall(), "unthreaded calls remain one-shot");
});

test("WorkflowAgent rejects a named thread when its canonical cwd changes", () => {
  const firstCwd = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-thread-cwd-first-"));
  const secondCwd = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-thread-cwd-second-"));
  try {
    const agent = new WorkflowAgent({ cwd: firstCwd }) as unknown as WorkflowAgentPrivates;
    const first = agent.sessionManagers.forCall("implementer", firstCwd);
    assert.equal(
      agent.sessionManagers.forCall("implementer", firstCwd),
      first,
      "same canonical cwd retains the conversation",
    );
    assert.throws(
      () => agent.sessionManagers.forCall("implementer", secondCwd),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        return true;
      },
    );
  } finally {
    rmSync(firstCwd, { recursive: true, force: true });
    rmSync(secondCwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run keeps constructor tools when its cwd is a symlink", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-cwd-symlink-home-"));
  const root = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-cwd-symlink-"));
  const linked = join(root, "linked");
  symlinkSync(root, linked);
  const core = createFauxCore({
    provider: "fauxtest-cwd-symlink",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-cwd-symlink", core);
      let customToolCalls = 0;
      const customTool = defineTool({
        name: "constructor_cwd_sentinel",
        label: "Constructor cwd sentinel",
        description: "Proves constructor-provided tools survive cwd canonicalization.",
        parameters: Type.Object({}),
        execute: async () => {
          customToolCalls++;
          return { content: [{ type: "text", text: "sentinel reached" }], details: undefined };
        },
      });
      core.setResponses([
        fauxAssistantMessage(fauxToolCall("constructor_cwd_sentinel", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("custom tool survived", { stopReason: "stop" }),
      ]);

      const agent = new WorkflowAgent({ cwd: linked, tools: [customTool], modelRegistry: registry });
      const result = await agent.run("call the constructor cwd sentinel", {
        model: "fauxtest-cwd-symlink/faux-model",
      });

      assert.equal(customToolCalls, 1, "the canonicalized default cwd must retain constructor tools");
      assert.match(result, /custom tool survived/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run preserves a valid trailing-space cwd", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-cwd-space-home-"));
  const root = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-cwd-space-"));
  // Windows starts a process in "target" when asked for "target " and in
  // "outer" for "outer."; only an inner segment keeps its trailing space.
  const windows = process.platform === "win32";
  const trailing = windows ? join(root, "outer ", "inner") : join(root, "target ");
  // The stripped twin exists so a silent redirect would land somewhere real.
  mkdirSync(windows ? join(root, "outer", "inner") : join(root, "target"), { recursive: true });
  mkdirSync(trailing, { recursive: true });
  const rewritten = [join(root, "target "), join(root, "outer.", "inner")];
  const core = createFauxCore({
    provider: "fauxtest-cwd-space",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-cwd-space", core);
      const contexts: unknown[] = [];
      core.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: PRINT_CWD_COMMAND }), { stopReason: "toolUse" }),
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("observed cwd", { stopReason: "stop" });
        },
      ]);

      const agent = new WorkflowAgent({ cwd: root, modelRegistry: registry });
      if (windows) {
        for (const cwd of rewritten) {
          mkdirSync(cwd, { recursive: true });
          await assert.rejects(
            agent.run("run pwd", { cwd, model: "fauxtest-cwd-space/faux-model" }),
            (error: unknown) => {
              assert.ok(error instanceof WorkflowError);
              assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
              assert.ok(error.message.includes(realpathSync(cwd)), error.message);
              assert.match(error.message, /Windows/);
              return true;
            },
          );
        }
      }
      await agent.run("run pwd", { cwd: trailing, model: "fauxtest-cwd-space/faux-model" });

      assert.equal(
        bashCwd(contexts.at(-1)),
        realpathSync(trailing),
        "bash must execute in the literal trailing-space directory",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run gives an explicit cwd precedence over an injected session cwd", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-session-cwd-home-"));
  const oldCwd = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-session-cwd-old-"));
  const targetCwd = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-session-cwd-target-"));
  const core = createFauxCore({
    provider: "fauxtest-session-cwd",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-session-cwd", core);
      const contexts: unknown[] = [];
      core.setResponses([
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage(fauxToolCall("bash", { command: PRINT_CWD_COMMAND }), { stopReason: "toolUse" });
        },
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("observed explicit cwd", { stopReason: "stop" });
        },
      ]);

      const agent = new WorkflowAgent({
        cwd: oldCwd,
        modelRegistry: registry,
        session: { cwd: oldCwd },
      });
      await agent.run("run pwd from the selected directory", {
        cwd: targetCwd,
        model: "fauxtest-session-cwd/faux-model",
      });

      assert.equal(
        bashCwd(contexts.at(-1)),
        realpathSync(targetCwd),
        "bash must execute in the explicit cwd, not the injected session cwd",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(oldCwd, { recursive: true, force: true });
    rmSync(targetCwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run keeps injected settings and resources while using the explicit cwd", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-injected-session-home-"));
  const injectedCwd = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-injected-session-old-"));
  const targetCwd = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-injected-session-target-"));
  writeFileSync(join(injectedCwd, "AGENTS.md"), "INJECTED_RESOURCE_LOADER_MARKER");
  writeFileSync(join(targetCwd, "AGENTS.md"), "TARGET_RESOURCE_LOADER_MARKER");
  const core = createFauxCore({
    provider: "fauxtest-injected-session",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-injected-session", core);
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd: injectedCwd,
        agentDir: home,
        settingsManager,
        noExtensions: true,
        extensionFactories: [
          (pi) => {
            pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\nINJECTED_HOOK_BOUND` }));
          },
        ],
      });
      await resourceLoader.reload();
      let injectedSettingsReads = 0;
      const originalGetCompactionSettings = settingsManager.getCompactionSettings.bind(settingsManager);
      settingsManager.getCompactionSettings = () => {
        injectedSettingsReads++;
        return originalGetCompactionSettings();
      };
      const contexts: unknown[] = [];
      core.setResponses([
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage(fauxToolCall("bash", { command: PRINT_CWD_COMMAND }), { stopReason: "toolUse" });
        },
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("observed injected dependencies", { stopReason: "stop" });
        },
      ]);

      const agent = new WorkflowAgent({
        cwd: injectedCwd,
        modelRegistry: registry,
        session: { settingsManager, resourceLoader },
      });
      await agent.run("prove the host dependencies remain in effect", {
        cwd: targetCwd,
        model: "fauxtest-injected-session/faux-model",
      });

      const initialRequest = JSON.stringify(contexts[0]);
      assert.match(initialRequest, /INJECTED_RESOURCE_LOADER_MARKER/);
      assert.match(initialRequest, /INJECTED_HOOK_BOUND/, "injected resource loaders bypass middleware discovery");
      assert.doesNotMatch(initialRequest, /TARGET_RESOURCE_LOADER_MARKER/);
      assert.ok(injectedSettingsReads > 0, "the SDK session must retain the host-injected SettingsManager");
      assert.equal(
        bashCwd(contexts[1]),
        realpathSync(targetCwd),
        "injected dependencies must not override explicit cwd",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(injectedCwd, { recursive: true, force: true });
    rmSync(targetCwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run lets the default resource loader use an injected SettingsManager", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-settings-loader-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-settings-loader-cwd-"));
  const projectPiDir = join(cwd, ".pi");
  const marker = "INJECTED_SETTINGS_APPEND_SYSTEM_MARKER";
  mkdirSync(projectPiDir);
  writeFileSync(join(projectPiDir, "APPEND_SYSTEM.md"), marker);
  const core = createFauxCore({
    provider: "fauxtest-settings-loader",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-settings-loader", core);
      const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
      const contexts: unknown[] = [];
      core.setResponses([
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("settings loader marker observed", { stopReason: "stop" });
        },
      ]);

      const agent = new WorkflowAgent({
        cwd,
        modelRegistry: registry,
        // Deliberately inject only settingsManager: the default loader must be
        // built by WorkflowAgent with this manager and the run cwd.
        session: { settingsManager },
      });
      const result = await agent.run("confirm the project append-system marker", {
        model: "fauxtest-settings-loader/faux-model",
      });

      assert.match(result, /settings loader marker observed/);
      assert.match(
        readProviderSystemPrompt(contexts[0]),
        new RegExp(marker),
        "the default loader must read project APPEND_SYSTEM.md using the injected trust settings",
      );
      const loaders = (agent as unknown as { resourceLoaders: Map<string, unknown> }).resourceLoaders;
      assert.equal(loaders.size, 1, "the default loader path must be used when resourceLoader is not injected");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run fixes a named thread to its first canonical cwd", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-thread-cwd-run-home-"));
  const first = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-thread-cwd-run-first-"));
  const second = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-thread-cwd-run-second-"));
  const firstAlias = join(first, "alias");
  symlinkSync(first, firstAlias);
  const core = createFauxCore({
    provider: "fauxtest-thread-cwd-run",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-thread-cwd-run", core);
      const contexts: unknown[] = [];
      core.setResponses([
        fauxAssistantMessage("first answer", { stopReason: "stop" }),
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("same thread answer", { stopReason: "stop" });
        },
      ]);
      const agent = new WorkflowAgent({ cwd: first, modelRegistry: registry });
      const options = { thread: "implementer", model: "fauxtest-thread-cwd-run/faux-model" } as const;

      await agent.run("FIRST_THREAD_MARKER", { ...options, cwd: first });
      await assert.rejects(agent.run("MUST_NOT_RUN", { ...options, cwd: second }), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        assert.match(error.message, /cannot change cwd/);
        return true;
      });
      await agent.run("ALIAS_THREAD_MARKER", { ...options, cwd: firstAlias });

      const transcript = JSON.stringify(contexts);
      assert.match(transcript, /FIRST_THREAD_MARKER/, "a same-realpath alias must reuse the existing transcript");
      assert.match(transcript, /ALIAS_THREAD_MARKER/);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run loads AGENTS resources per canonical cwd and reuses only the matching loader", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-cwd-resources-home-"));
  const root = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-cwd-resources-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const firstAlias = join(root, "first-alias");
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, firstAlias);
  writeFileSync(join(first, "AGENTS.md"), "FIRST_CWD_AGENTS_MARKER");
  writeFileSync(join(second, "AGENTS.md"), "SECOND_CWD_AGENTS_MARKER");
  const core = createFauxCore({
    provider: "fauxtest-cwd-resources",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-cwd-resources", core);
      const contexts: unknown[] = [];
      core.setResponses([
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("first", { stopReason: "stop" });
        },
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("second", { stopReason: "stop" });
        },
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("first again", { stopReason: "stop" });
        },
      ]);
      const agent = new WorkflowAgent({ cwd: first, modelRegistry: registry });
      const model = "fauxtest-cwd-resources/faux-model";

      await agent.run("first cwd", { cwd: first, model });
      await agent.run("second cwd", { cwd: second, model });
      await agent.run("first alias", { cwd: firstAlias, model });

      const transcripts = contexts.map((context) => JSON.stringify(context));
      assert.match(transcripts[0], /FIRST_CWD_AGENTS_MARKER/);
      assert.doesNotMatch(transcripts[0], /SECOND_CWD_AGENTS_MARKER/);
      assert.match(transcripts[1], /SECOND_CWD_AGENTS_MARKER/);
      assert.doesNotMatch(transcripts[1], /FIRST_CWD_AGENTS_MARKER/);
      assert.match(transcripts[2], /FIRST_CWD_AGENTS_MARKER/, "a same-realpath alias must use the first loader");

      const loaders = (agent as unknown as { resourceLoaders: Map<string, unknown> }).resourceLoaders;
      assert.equal(loaders.size, 2, "one loader per canonical cwd; the alias must not allocate a third");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("WorkflowAgent restores a failed named turn to its previous leaf", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentPrivates;
  const manager = agent.sessionManagers.forCall("implementer");
  const acceptedLeaf = manager.appendSessionInfo("accepted");
  manager.appendSessionInfo("failed-attempt");

  agent.restoreThreadLeaf(manager, acceptedLeaf);
  assert.equal(manager.getLeafId(), acceptedLeaf);
});

test("persistAgentSessions uses one file per named thread", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-thread-files-"));
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      const agent = new WorkflowAgent({
        cwd: projectCwd,
        persistAgentSessions: true,
      }) as unknown as WorkflowAgentPrivates;
      const implementer = agent.sessionManagers.forCall("implementer");
      implementer.appendSessionInfo("first turn");
      agent.sessionManagers.forCall("implementer").appendSessionInfo("second turn");
      agent.sessionManagers.forCall("reviewer").appendSessionInfo("review");

      const sessionFiles = new Set([
        implementer.getSessionFile(),
        agent.sessionManagers.forCall("implementer").getSessionFile(),
        agent.sessionManagers.forCall("reviewer").getSessionFile(),
      ]);
      assert.equal(sessionFiles.size, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a persisted agent session warns once per WorkflowAgent that transcripts are written to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-persist-notice-"));
  try {
    withFakeHome(join(dir, "home"), () => {
      const notices: string[] = [];
      const agent = new WorkflowAgent({ cwd: join(dir, "project"), persistAgentSessions: true });
      const managers = (agent as unknown as WorkflowAgentPrivates).sessionManagers;
      managers.forCall(undefined, undefined, (m) => notices.push(m));
      managers.forCall(undefined, undefined, (m) => notices.push(m));
      assert.equal(notices.length, 1);
      assert.match(notices[0], /persistAgentSessions is on: full subagent transcripts, which may include secrets/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WorkflowAgent degrades to in-memory when the session directory can't be created", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-persist-agent-fail-"));
  const projectCwd = join(dir, "project");
  const fakeHome = join(dir, "home");
  try {
    withFakeHome(fakeHome, () => {
      // Pre-occupy the sessions directory with a plain file so the SDK's
      // mkdirSync(recursive) inside SessionManager.create() throws ENOTDIR —
      // simulating a permissions/disk-full failure at session-creation time.
      const sessionsPath = join(fakeHome, ".pi", "agent", "sessions");
      mkdirSync(dirname(sessionsPath), { recursive: true });
      writeFileSync(sessionsPath, "not a directory");

      const notices: string[] = [];
      const agent = new WorkflowAgent({ cwd: projectCwd, persistAgentSessions: true });
      const manager = (agent as unknown as WorkflowAgentPrivates).sessionManagers.forCall(undefined, undefined, (m) =>
        notices.push(m),
      );
      assert.equal(manager.isPersisted(), false, "must degrade to in-memory rather than throw");
      assert.equal(notices.length, 1, "the degrade is reported to the run, not the console");
      assert.match(notices[0], /persistAgentSessions: could not persist this agent's session .*continuing in memory/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listAvailableModelSpecs returns an array (empty when no auth configured)", () => {
  const result = listAvailableModelSpecs();
  assert.ok(Array.isArray(result), "should always return an array");
  // On CI or fresh installs there may be no models configured
  // The important thing is it doesn't throw
});

test("listAvailableModelSpecs entries have provider/model format when non-empty", () => {
  const result = listAvailableModelSpecs();
  for (const spec of result) {
    assert.ok(spec.includes("/"), `model spec "${spec}" should use provider/id format`);
    const [provider, id] = spec.split("/");
    assert.ok(provider.length > 0, "provider should not be empty");
    assert.ok(id.length > 0, "model id should not be empty");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// routeAgentModel — explicit model > tier > inherited main model > medium tier > session default
// ═══════════════════════════════════════════════════════════════════════════

const tierConfig: ModelTierConfig = {
  tiers: { small: "vendor/small", medium: "vendor/medium", big: "vendor/big" },
};

test("routeAgentModel: an explicit model wins over a tier, with or without a tier config", () => {
  for (const config of [tierConfig, null]) {
    assert.deepEqual(routeAgentModel({ model: "explicit/model", tier: "small" }, "main/model", config), {
      kind: "model",
      spec: "explicit/model",
    });
  }
});

test("routeAgentModel: a tier resolves from the config", () => {
  assert.deepEqual(routeAgentModel({ tier: "big" }, "main/model", tierConfig), {
    kind: "tier",
    tier: "big",
    spec: "vendor/big",
  });
});

test("routeAgentModel: a tier the saved config does not define fails instead of running another model", () => {
  assert.throws(
    () => routeAgentModel({ tier: "bigg", label: "typo" }, "main/model", tierConfig),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.MODEL_NOT_FOUND &&
      !error.recoverable &&
      error.agentLabel === "typo" &&
      /tier "bigg" is not defined in model-tiers\.json \(defined: small, medium, big\)/.test(error.message),
  );
});

test("routeAgentModel: with no tier config the current main model stands in for a tier", () => {
  assert.deepEqual(routeAgentModel({ tier: "medium" }, "start-prov/model-a", null), {
    kind: "tier-without-config",
    tier: "medium",
    spec: "start-prov/model-a",
  });
  assert.deepEqual(routeAgentModel({ tier: "medium" }, "live-prov/model-b", null), {
    kind: "tier-without-config",
    tier: "medium",
    spec: "live-prov/model-b",
  });
  assert.deepEqual(routeAgentModel({ tier: "small" }, undefined, null), {
    kind: "tier-without-config",
    tier: "small",
    spec: undefined,
  });
});

test("routeAgentModel: an untagged agent takes the configured medium tier, else the session default", () => {
  assert.deepEqual(routeAgentModel({}, "main/model", tierConfig), { kind: "medium-tier", spec: "vendor/medium" });
  assert.deepEqual(routeAgentModel({}, "main/model", null), { kind: "session-default" });
  assert.deepEqual(routeAgentModel({}, "main/model", { tiers: { small: "vendor/small" } }), {
    kind: "session-default",
  });
});

test("routeAgentModel: inheritMainModel routes only untagged agents to the main model", () => {
  for (const config of [tierConfig, null]) {
    assert.deepEqual(routeAgentModel({}, "main/model", config, true), { kind: "inherit-main", spec: "main/model" });
  }
  assert.deepEqual(routeAgentModel({ model: "explicit/model" }, "main/model", tierConfig, true), {
    kind: "model",
    spec: "explicit/model",
  });
  assert.deepEqual(routeAgentModel({ tier: "big" }, "main/model", tierConfig, true), {
    kind: "tier",
    tier: "big",
    spec: "vendor/big",
  });
});

test("AgentModelSelector: a tier with no model-tiers.json runs on the main model and says so once", () => {
  const registry = catalogRegistry([catalogModel("prov", "main")]);
  const selector = new AgentModelSelector({
    mainModel: "prov/main",
    inheritMainModel: false,
    loadTierConfig: () => null,
    listModels: () => [],
  });
  const notices: string[] = [];
  for (const tier of ["small", "big"]) {
    const choice = selector.select({ tier, onNotice: (m) => notices.push(m) }, registry);
    assert.equal(choice.model?.id, "main");
  }
  assert.equal(notices.length, 1);
  assert.match(
    notices[0],
    /requested a tier but no model-tiers\.json is configured, so tiers currently fall back to prov\/main/,
  );
});

test("AgentModelSelector: an unavailable main model standing in for a tier is named as the main model", () => {
  const selector = new AgentModelSelector({
    mainModel: "gone/model",
    inheritMainModel: false,
    loadTierConfig: () => null,
    listModels: () => [],
  });
  assert.throws(
    () => selector.select({ tier: "small", label: "t" }, catalogRegistry([catalogModel("prov", "other")])),
    (error: unknown) =>
      error instanceof WorkflowError &&
      error.code === WorkflowErrorCode.MODEL_NOT_FOUND &&
      /tier "small" \(no model-tiers\.json, so the session's main model "gone\/model"\) cannot be used/.test(
        error.message,
      ),
  );
});

test("routeAgentModel: inheritMainModel with no main model takes the untagged route", () => {
  assert.deepEqual(routeAgentModel({}, undefined, tierConfig, true), { kind: "medium-tier", spec: "vendor/medium" });
  assert.deepEqual(routeAgentModel({}, undefined, null, true), { kind: "session-default" });
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkflowAgent#loadTierConfig — memoize model-tiers.json once per instance
// (a sync fs read on the hot per-agent path otherwise)
// ═══════════════════════════════════════════════════════════════════════════

type WorkflowAgentTierPrivates = {
  loadTierConfig(loader?: () => ModelTierConfig | null): ModelTierConfig | null;
};

test("WorkflowAgent#loadTierConfig: the loader is invoked at most once across repeated calls", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentTierPrivates;
  let calls = 0;
  const loader = () => {
    calls++;
    return tierConfig;
  };

  const first = agent.loadTierConfig(loader);
  const second = agent.loadTierConfig(loader);
  // Even a loader that would blow up if called proves the memoized branch
  // never reaches the loader again.
  const third = agent.loadTierConfig(() => {
    throw new Error("loader must not be invoked again once memoized");
  });

  assert.equal(calls, 1, "the real loader should only run once");
  assert.deepEqual(first, tierConfig);
  assert.equal(second, first, "repeated calls must return the memoized value");
  assert.equal(third, first);
});

test("WorkflowAgent#loadTierConfig: a legitimately-null config (no file) is memoized too, not re-checked", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentTierPrivates;
  let calls = 0;
  const loader = () => {
    calls++;
    return null;
  };

  assert.equal(agent.loadTierConfig(loader), null);
  assert.equal(agent.loadTierConfig(loader), null);
  assert.equal(calls, 1, "null is a valid memoized result, not a 'try again' signal");
});

test("WorkflowAgent#loadTierConfig: memoization is per-instance (two agents, two runs, don't leak into each other)", () => {
  const a = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentTierPrivates;
  const b = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentTierPrivates;
  const cfgA: ModelTierConfig = { tiers: { medium: "vendor-a/model" } };
  const cfgB: ModelTierConfig = { tiers: { medium: "vendor-b/model" } };

  assert.equal(
    a.loadTierConfig(() => cfgA),
    cfgA,
  );
  assert.equal(
    b.loadTierConfig(() => cfgB),
    cfgB,
  );
  // `a` stays pinned to cfgA even when handed a different loader later — a
  // fresh WorkflowAgent per run (the production lifetime; see workflow.ts's
  // `new WorkflowAgent(options)` per runWorkflow() call) means two runs with
  // different on-disk configs still each see their own correct snapshot,
  // without a process-global cache leaking state across them.
  assert.equal(
    a.loadTierConfig(() => cfgB),
    cfgA,
  );
});

test("WorkflowAgent#loadTierConfig: default loader overlays project tiers over global", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-overlay-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-overlay-cwd-"));
  try {
    withFakeHome(home, () => {
      const globalPath = getModelTierConfigPath();
      const projectPath = getProjectModelTierConfigPath(cwd);
      mkdirSync(join(globalPath, ".."), { recursive: true });
      mkdirSync(join(projectPath, ".."), { recursive: true });
      writeFileSync(globalPath, JSON.stringify({ tiers: { small: "global/small", medium: "global/medium" } }));
      writeFileSync(projectPath, JSON.stringify({ tiers: { small: "project/small" } }));

      const agent = new WorkflowAgent({ cwd }) as unknown as WorkflowAgentTierPrivates;
      const loaded = agent.loadTierConfig();
      assert.deepEqual(loaded, { tiers: { small: "project/small", medium: "global/medium" } });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): tier routing resolves correctly through the real (non-injected) disk loader, read only once across two run() calls", async () => {
  // End-to-end proof that memoization doesn't break the real wiring: writes an
  // actual model-tiers.json to a fake home, runs two real subagents against a
  // faux (no-network) provider, and confirms both resolve the tier-configured
  // model AND that the underlying config object is reused (same reference)
  // across both run() calls rather than re-read/re-parsed.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-memo-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-memo-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { medium: "fauxtest/faux-model" } }));

      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest", {
        name: "Faux Test",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      const registry = new ModelRegistry(runtime);
      core.setResponses([
        fauxAssistantMessage("tier-routed-first", { stopReason: "stop" }),
        fauxAssistantMessage("tier-routed-second", { stopReason: "stop" }),
      ]);

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      const spy = test.mock.method(agent as unknown as WorkflowAgentTierPrivates, "loadTierConfig");

      const first = await agent.run("task one", { label: "a", tier: "medium" });
      const second = await agent.run("task two", { label: "b", tier: "medium" });

      assert.ok(first.includes("tier-routed-first"), "first agent should route through the tiered faux model");
      assert.ok(second.includes("tier-routed-second"), "second agent should route through the tiered faux model");

      assert.equal(spy.mock.callCount(), 2, "loadTierConfig() is called once per run(), as expected");
      const [firstResult, secondResult] = spy.mock.calls.map((c) => c.result);
      assert.equal(
        firstResult,
        secondResult,
        "the SAME config object must be reused across run() calls — the file was read/parsed only once",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run() reports per-turn in-flight usage for a named thread", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-live-usage-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-live-usage-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-live-usage",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
    tokenSize: { min: 1, max: 1 },
    tokensPerSecond: 200,
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-live-usage", {
        name: "Faux Test Live Usage",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple,
        models: core.models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.contextWindow ?? 128000,
          maxTokens: model.maxTokens ?? 4096,
        })),
      });
      core.setResponses([
        fauxAssistantMessage("streaming output proves this agent is active", { stopReason: "stop" }),
        fauxAssistantMessage("the second threaded turn has independent usage", { stopReason: "stop" }),
      ]);

      const registry = new ModelRegistry(runtime);
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry: registry,
        mainModel: "fauxtest-live-usage/faux-model",
      });
      let settled = false;
      let terminalCalls = 0;
      let resolveFirstProgress: (usage: AgentUsage) => void = () => {};
      const firstProgress = new Promise<AgentUsage>((resolve) => {
        resolveFirstProgress = resolve;
      });

      const thread = "live-usage-thread";
      const run = agent
        .run("respond slowly", {
          thread,
          model: "fauxtest-live-usage/faux-model",
          onUsageProgress: (usage) => {
            if (usage.total > 0) {
              resolveFirstProgress(usage);
            }
          },
          onUsage: () => {
            terminalCalls++;
          },
        })
        .finally(() => {
          settled = true;
        });
      let progressTimeout: ReturnType<typeof setTimeout> | undefined;
      const missingProgress = new Promise<never>((resolve, reject) => {
        void resolve;
        progressTimeout = setTimeout(() => reject(new Error("No in-flight usage was reported")), 30_000);
      });
      const progress = await Promise.race([firstProgress, missingProgress]);
      if (progressTimeout) {
        clearTimeout(progressTimeout);
      }

      assert.equal(settled, false, "progress must arrive before the subagent settles");
      assert.ok(progress.output > 0, "streaming text should produce a positive output estimate");
      await run;
      assert.equal(terminalCalls, 1, "onUsage remains a once-only terminal callback");

      const secondProgress: AgentUsage[] = [];
      let secondTerminal: AgentUsage | undefined;
      await agent.run("continue in the same thread", {
        thread,
        model: "fauxtest-live-usage/faux-model",
        onUsageProgress: (usage) => secondProgress.push(usage),
        onUsage: (usage) => {
          secondTerminal = usage;
        },
      });

      assert.ok(secondProgress.length > 0, "the second turn should stream usage");
      assert.deepEqual(
        secondProgress.at(-1),
        secondTerminal,
        "the last live update must describe this turn only, matching its terminal usage",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkflowAgent.run(): opts.schema must be a top-level JSON object schema
// — a non-object schema (e.g. array/primitive) would otherwise
// reach a strict OpenAI-compatible provider (DeepSeek) as an invalid tool
// parameters schema and fail with an opaque transport-level 400.
// ═══════════════════════════════════════════════════════════════════════════

test("failed or empty named turns restore the active transcript before the next call", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-thread-rollback-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-thread-rollback-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-thread",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-thread", {
        name: "Faux Thread",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((model) => ({
          ...model,
          input: ["text"] as ("text" | "image")[],
        })),
      });
      const contexts: unknown[] = [];
      core.setResponses([
        () => {
          throw new Error("attempt failed");
        },
        fauxAssistantMessage("accepted", { stopReason: "stop" }),
        fauxAssistantMessage("", { stopReason: "stop" }),
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("followed up", { stopReason: "stop" });
        },
      ]);
      const injectedManager = SessionManager.inMemory();
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry: new ModelRegistry(runtime),
        session: { sessionManager: injectedManager },
      });
      const runOptions = { thread: "implementer", model: "fauxtest-thread/faux-model" } as const;

      await assert.rejects(agent.run("FAILED_TURN_MARKER", runOptions));
      await agent.run("ACCEPTED_TURN_MARKER", runOptions);
      await assert.rejects(agent.run("EMPTY_TURN_MARKER", runOptions), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
        return true;
      });
      await agent.run("FOLLOWUP_TURN_MARKER", runOptions);

      const contextText = JSON.stringify(contexts[0]);
      assert.doesNotMatch(contextText, /FAILED_TURN_MARKER|EMPTY_TURN_MARKER/);
      assert.match(contextText, /ACCEPTED_TURN_MARKER/);
      assert.match(contextText, /FOLLOWUP_TURN_MARKER/);
      assert.equal(injectedManager.getLeafId(), null, "a named thread must not use the injected one-shot manager");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Turn isolation must survive auto-compaction. Pi compaction (on by default)
// can rewrite session.messages inside prompt() — the array is rebuilt shorter
// (summary + kept tail) — so isolating a threaded turn by a pre-prompt()
// length snapshot slices an empty window and misclassifies a successful turn
// as AGENT_EMPTY_OUTPUT. These tests trigger REAL auto-compaction (tiny
// reserve threshold + a huge reply) and assert the turn's output survives.
// ═══════════════════════════════════════════════════════════════════════

/** Compaction settings that trip auto-compaction on a ~50k-token reply
 * (threshold = contextWindow 128k - reserveTokens 98k = 30k) while leaving
 * the small pad turns alone. keepRecentTokens: 1 forces the cut right at the
 * huge reply, exercising the split-turn path (history + prefix summaries). */
function writeCompactionSettings(home: string): void {
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: 98000, keepRecentTokens: 1 } }),
  );
}

test("a threaded turn whose prompt() triggers auto-compaction still returns its output", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-thread-compaction-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-thread-compaction-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-compaction",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 16384 }],
    tokenSize: { min: 8000, max: 8000 },
  });
  try {
    await withFakeHomeAsync(home, async () => {
      writeCompactionSettings(home);
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-compaction", {
        name: "Faux Compaction",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((model) => ({
          ...model,
          input: ["text"] as ("text" | "image")[],
        })),
      });
      // ~216k chars ≈ 54k estimated tokens: over the 30k compaction threshold,
      // under the 128k context window (threshold path, not overflow).
      const hugeAnswer = `COMPACTED_TURN_ANSWER ${"lorem ipsum dolor ".repeat(12000)}`;
      core.setResponses([
        fauxAssistantMessage("first pad answer", { stopReason: "stop" }),
        fauxAssistantMessage("second pad answer", { stopReason: "stop" }),
        fauxAssistantMessage(hugeAnswer, { stopReason: "stop" }),
        // Consumed by auto-compaction inside the third prompt(): history summary,
        // then the split-turn prefix summary.
        fauxAssistantMessage("history summary", { stopReason: "stop" }),
        fauxAssistantMessage("turn prefix summary", { stopReason: "stop" }),
      ]);
      const agent = new WorkflowAgent({ cwd, modelRegistry: new ModelRegistry(runtime) });
      const runOptions = { thread: "implementer", model: "fauxtest-compaction/faux-model" } as const;

      await agent.run("pad turn one", runOptions);
      await agent.run("pad turn two", runOptions);
      const text = await agent.run("big turn", runOptions);

      assert.match(String(text), /^COMPACTED_TURN_ANSWER /, "the compacted turn's real answer must survive");
      assert.equal(core.getPendingResponseCount(), 0, "auto-compaction must have run (both summaries consumed)");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a threaded structured turn recovers its prose payload across auto-compaction", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-thread-compaction-schema-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-thread-compaction-schema-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-compaction-schema",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 16384 }],
    tokenSize: { min: 8000, max: 8000 },
  });
  try {
    await withFakeHomeAsync(home, async () => {
      writeCompactionSettings(home);
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-compaction-schema", {
        name: "Faux Compaction Schema",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((model) => ({
          ...model,
          input: ["text"] as ("text" | "image")[],
        })),
      });
      // Prose JSON (the model never calls structured_output) big enough to trip
      // compaction; the prose-extraction fallback must still see this turn's text.
      const structuredValue = { finding: `STRUCTURED_ANSWER ${"pad ".repeat(54000)}` };
      core.setResponses([
        fauxAssistantMessage("first pad answer", { stopReason: "stop" }),
        fauxAssistantMessage("second pad answer", { stopReason: "stop" }),
        fauxAssistantMessage(JSON.stringify(structuredValue), { stopReason: "stop" }),
        fauxAssistantMessage("history summary", { stopReason: "stop" }),
        fauxAssistantMessage("turn prefix summary", { stopReason: "stop" }),
      ]);
      const agent = new WorkflowAgent({ cwd, modelRegistry: new ModelRegistry(runtime) });
      const runOptions = { thread: "implementer", model: "fauxtest-compaction-schema/faux-model" } as const;

      await agent.run("pad turn one", runOptions);
      await agent.run("pad turn two", runOptions);
      const result = await agent.run("big structured turn", {
        ...runOptions,
        schema: Type.Object({ finding: Type.String() }),
        maxSchemaRetries: 0,
      });

      assert.deepEqual(result, structuredValue, "the compacted turn's structured payload must survive");
      assert.equal(core.getPendingResponseCount(), 0, "auto-compaction must have run (both summaries consumed)");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run() rejects a non-object top-level schema before touching the model registry", async () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  await assert.rejects(
    agent.run("task", { schema: Type.Array(Type.Object({ finding: Type.String() })) }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
      assert.match(error.message, /opts\.schema must be a top-level JSON object schema/);
      assert.match(error.message, /got type: array/);
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkflowAgent.run(): an unresolvable `model` spec must fail loud — no
// more silent fallback to the session default with only a console.warn.
// ═══════════════════════════════════════════════════════════════════════════

test("WorkflowAgent.run() throws MODEL_NOT_FOUND for an unresolvable model spec instead of silently using the session default", async () => {
  const registry = catalogRegistry([catalogModel("openrouter", "anthropic/claude-opus-4-8", "Claude")]);

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: registry });
  await assert.rejects(
    agent.run("task", { model: "totally-unknown/does-not-exist", label: "pin" }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
      assert.equal(error.recoverable, false, "a bad pin is deterministic — retrying it is pointless");
      assert.match(error.message, /totally-unknown\/does-not-exist/);
      assert.equal(error.agentLabel, "pin");
      return true;
    },
  );
});

test("WorkflowAgent.run() still resolves a known model spec normally (no regression)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-model-pin-ok-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-model-pin-ok-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-pin",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-pin", {
        name: "Faux Test Pin",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      const registry = new ModelRegistry(runtime);
      core.setResponses([fauxAssistantMessage("pinned-model-answer", { stopReason: "stop" })]);

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      const text = await agent.run("task", { model: "fauxtest-pin/faux-model", label: "pin-ok" });
      assert.ok(text.includes("pinned-model-answer"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run() runs a bare model id shared by two providers on the only authenticated one", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-shared-id-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-shared-id-cwd-"));
  // The unauthenticated provider is registered first, so catalog order alone would pick it.
  const providers = [
    { provider: "fauxtest-shared-noauth", apiKey: undefined },
    { provider: "fauxtest-shared-auth", apiKey: "faux-dummy-key-not-used" },
  ].map((entry) => ({
    ...entry,
    core: createFauxCore({
      provider: entry.provider,
      models: [{ id: "shared-model", name: "Shared Model", contextWindow: 128000, maxTokens: 4096 }],
    }),
  }));
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      for (const { provider, apiKey, core } of providers) {
        runtime.registerProvider(provider, {
          baseUrl: "http://127.0.0.1:9/faux",
          ...(apiKey ? { apiKey } : {}),
          api: core.api,
          streamSimple: core.streamSimple as never,
          models: [
            {
              id: "shared-model",
              name: "Shared Model",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        });
        core.setResponses([fauxAssistantMessage(`answered-by-${provider}`, { stopReason: "stop" })]);
      }

      const agent = new WorkflowAgent({ cwd, modelRegistry: new ModelRegistry(runtime) });
      const resolvedSpecs: string[] = [];
      const text = await agent.run("task", {
        model: "shared-model:high",
        label: "shared-id",
        onModelResolved: (spec) => resolvedSpecs.push(spec),
      });
      assert.deepEqual(resolvedSpecs, ["fauxtest-shared-auth/shared-model:high"]);
      assert.ok(text.includes("answered-by-fauxtest-shared-auth"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WorkflowAgent.run(): asymmetric fail-loud behavior for a tier that resolves
// to an unavailable model —
//   - an EXPLICIT tier (script wrote `tier: "x"`) is just as loud as an
//     explicit model pin: MODEL_NOT_FOUND, naming the tier and what it
//     resolved to.
//   - the IMPLICIT default "medium" tier an UNTAGGED agent (no model, no
//     tier) gets routed through never asked for that model, so it degrades
//     to the session default instead — but only after reporting it through onNotice
//     so the degrade is still visible in the run's own log stream, not a
//     silent continuation.
// ═══════════════════════════════════════════════════════════════════════════

test("WorkflowAgent.run() throws MODEL_NOT_FOUND naming the tier when an EXPLICIT tier resolves to an unavailable model", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-dead-explicit-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-dead-explicit-cwd-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { big: "deadprov/ghost-model" } }));

      const registry = catalogRegistry([catalogModel("fauxtest", "faux-model")]);

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      await assert.rejects(agent.run("task", { tier: "big", label: "explicit-tier" }), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.MODEL_NOT_FOUND);
        assert.equal(error.recoverable, false);
        assert.match(error.message, /tier "big"/);
        assert.match(error.message, /model-tiers\.json/);
        assert.match(error.message, /deadprov\/ghost-model/);
        assert.equal(error.agentLabel, "explicit-tier");
        return true;
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): an untagged agent's IMPLICIT default medium tier degrades to the session default (not a throw) when it resolves to an unavailable model, and reports it through onNotice once per instance", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tier-dead-implicit-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tier-dead-implicit-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-implicit",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      // "medium" (the implicit default) resolves to a dead spec; the run must
      // still complete by falling back to the configured session default.
      // Pin it explicitly so provider credentials inherited from the test
      // process cannot change which available model Pi selects by default.
      writeFileSync(join(tiersDir, "model-tiers.json"), JSON.stringify({ tiers: { medium: "deadprov/ghost-model" } }));
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fauxtest-implicit", defaultModel: "faux-model" }),
      );

      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-implicit", {
        name: "Faux Test Implicit",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      const registry = new ModelRegistry(runtime);
      core.setResponses([
        fauxAssistantMessage("untagged-first", { stopReason: "stop" }),
        fauxAssistantMessage("untagged-second", { stopReason: "stop" }),
      ]);

      const notices: string[] = [];
      const resolvedModels: string[] = [];
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      const onNotice = (message: string) => notices.push(message);

      const first = await agent.run("task one", {
        label: "untagged-1",
        onNotice,
        onModelResolved: (id) => resolvedModels.push(id),
      });
      const second = await agent.run("task two", {
        label: "untagged-2",
        onNotice,
        onModelResolved: (id) => resolvedModels.push(id),
      });

      assert.ok(first.includes("untagged-first"), "first untagged agent should still complete via session default");
      assert.ok(second.includes("untagged-second"), "second untagged agent should still complete via session default");
      assert.deepEqual(
        notices,
        ['default "medium" tier model "deadprov/ghost-model" unavailable — using the session default'],
        "the degrade is reported exactly once across both run() calls on the same instance",
      );
      assert.deepEqual(
        resolvedModels,
        ["fauxtest-implicit/faux-model", "fauxtest-implicit/faux-model"],
        "a degraded agent must still report the model it ACTUALLY runs on, not the dead spec or the mainModel guess",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): an untagged agent reports the REAL session model (settings default), not the mainModel guess", async () => {
  // Regression test for the display divergence: with no model, no tier, and no
  // model-tiers.json, an untagged agent binds the settings.json default — but
  // the run display showed mainModel forever because onModelResolved only fired
  // for agents WITH a resolvable spec. It must now fire post-creation with the
  // session's real model.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-truthful-display-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-truthful-display-cwd-"));
  const defaultCore = createFauxCore({
    provider: "fauxtest-default",
    models: [{ id: "default-model", name: "Default Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  const mainCore = createFauxCore({
    provider: "fauxtest-main",
    models: [{ id: "main-model", name: "Main Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      // The settings default is a DIFFERENT model than the session's main model,
      // so the actual binding is observable in both the response and the report.
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fauxtest-default", defaultModel: "default-model" }),
      );

      const registry = await fauxRegistryFor(home, [
        ["fauxtest-default", defaultCore],
        ["fauxtest-main", mainCore],
      ]);
      defaultCore.setResponses([fauxAssistantMessage("ran-on-settings-default", { stopReason: "stop" })]);
      mainCore.setResponses([fauxAssistantMessage("ran-on-main-model", { stopReason: "stop" })]);

      const resolved: string[] = [];
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: "fauxtest-main/main-model" });
      const result = await agent.run("task", { label: "untagged", onModelResolved: (id) => resolved.push(id) });

      assert.ok(
        result.includes("ran-on-settings-default"),
        "routing is unchanged: untagged binds the settings default",
      );
      assert.deepEqual(
        resolved,
        ["fauxtest-default/default-model"],
        "onModelResolved must report the model the session ACTUALLY bound, correcting the mainModel guess",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): the real-model report keeps the caller's thinking suffix", async () => {
  // The spec'd path appends `:level` when the caller set `thinking`; the
  // post-creation report must mirror that or a thinking-aware display still
  // under-reports what the provider actually received.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-truthful-thinking-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-truthful-thinking-cwd-"));
  const defaultCore = createFauxCore({
    provider: "fauxtest-default",
    models: [{ id: "default-model", name: "Default Model", reasoning: true, contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fauxtest-default", defaultModel: "default-model" }),
      );
      const registry = await fauxRegistryFor(home, [["fauxtest-default", defaultCore]]);
      defaultCore.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);

      const resolved: string[] = [];
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: "fauxtest-main/main-model" });
      await agent.run("task", { label: "untagged", thinking: "high", onModelResolved: (id) => resolved.push(id) });

      assert.deepEqual(resolved, ["fauxtest-default/default-model:high"]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): a throwing onModelResolved propagates but still disposes the session (finally runs)", async () => {
  // The real-model report sits inside the lifecycle try so a throwing host
  // callback cannot leak the session. Lock the invariant: run() rejects with
  // the host's error AND the finally still emits history (which sits directly
  // above session.dispose() — its firing proves the disposal path ran).
  const home = mkdtempSync(join(tmpdir(), "pi-dw-throwing-callback-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-throwing-callback-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-throw",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-throw", core);
      core.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
      const sentinel = new Error("host callback blew up");
      const histories: unknown[] = [];
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      await assert.rejects(
        agent.run("task", {
          label: "untagged",
          onModelResolved: () => {
            throw sentinel;
          },
          onHistory: (history) => histories.push(history),
        }),
        (error) => error === sentinel,
      );
      assert.equal(
        histories.length,
        1,
        "the finally must still emit history, proving it ran (non-threaded run here, so dispose is the next unguarded statement)",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): named-thread turns each report the real bound model", async () => {
  // The fire site is once per attempt/turn; a reused thread session must not
  // suppress (or duplicate) the truthful report on later turns.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-truthful-thread-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-truthful-thread-cwd-"));
  const defaultCore = createFauxCore({
    provider: "fauxtest-default",
    models: [{ id: "default-model", name: "Default Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fauxtest-default", defaultModel: "default-model" }),
      );
      const registry = await fauxRegistryFor(home, [["fauxtest-default", defaultCore]]);
      defaultCore.setResponses([
        fauxAssistantMessage("turn-1", { stopReason: "stop" }),
        fauxAssistantMessage("turn-2", { stopReason: "stop" }),
      ]);

      const resolved: string[] = [];
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, mainModel: "fauxtest-main/main-model" });
      const turn1 = await agent.run("turn one", {
        label: "worker",
        thread: "worker",
        onModelResolved: (id) => resolved.push(id),
      });
      const turn2 = await agent.run("turn two", {
        label: "worker",
        thread: "worker",
        onModelResolved: (id) => resolved.push(id),
      });

      assert.equal(turn1, "turn-1");
      assert.equal(turn2, "turn-2");
      assert.deepEqual(resolved, ["fauxtest-default/default-model", "fauxtest-default/default-model"]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runWorkflow(): an untagged agent's row, end record, and journal all carry the real bound model", async () => {
  // End-to-end through the workflow context: onAgentStart still carries the
  // pre-resolution mainModel guess, then onAgentModel corrects the running row
  // and onAgentEnd/onAgentJournal persist the model that actually ran.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-truthful-run-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-truthful-run-cwd-"));
  const defaultCore = createFauxCore({
    provider: "fauxtest-default",
    models: [{ id: "default-model", name: "Default Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  const mainCore = createFauxCore({
    provider: "fauxtest-main",
    models: [{ id: "main-model", name: "Main Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fauxtest-default", defaultModel: "default-model" }),
      );
      const registry = await fauxRegistryFor(home, [
        ["fauxtest-default", defaultCore],
        ["fauxtest-main", mainCore],
      ]);
      defaultCore.setResponses([fauxAssistantMessage("ran-on-settings-default", { stopReason: "stop" })]);

      const starts: Array<{ label: string; model?: string }> = [];
      const corrections: string[] = [];
      const ends: Array<{ label: string; model?: string }> = [];
      const journalModels: Array<string | undefined> = [];
      const result = await runWorkflow(
        `export const meta = { name: "truthful_display_demo", description: "one untagged agent" }
await agent("task", { label: "untagged" });
return "done";`,
        {
          cwd,
          modelRegistry: registry,
          mainModel: "fauxtest-main/main-model",
          onAgentStart: (event) => starts.push({ label: event.label, model: event.model }),
          onAgentModel: (event) => corrections.push(event.model),
          onAgentEnd: (event) => ends.push({ label: event.label, model: event.model }),
          onAgentJournal: (entry) => journalModels.push(entry.model),
        },
      );

      assert.equal(result.result, "done");
      assert.deepEqual(starts, [{ label: "untagged", model: "fauxtest-main/main-model" }]);
      assert.deepEqual(corrections, ["fauxtest-default/default-model"]);
      assert.deepEqual(ends, [{ label: "untagged", model: "fauxtest-default/default-model" }]);
      assert.deepEqual(journalModels, ["fauxtest-default/default-model"]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): inheritMainModel makes an untagged agent run on the session's main model", async () => {
  // The native inheritance opt-in end-to-end: no model, no tier, no
  // model-tiers.json — with the setting on, the subagent binds mainModel
  // instead of the settings.json defaultProvider/defaultModel.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-inherit-main-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-inherit-main-cwd-"));
  const mainCore = createFauxCore({
    provider: "fauxtest-main",
    models: [{ id: "main-model", name: "Main Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  const defaultCore = createFauxCore({
    provider: "fauxtest-default",
    models: [{ id: "default-model", name: "Default Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      // The settings default is a DIFFERENT model than the session's main model,
      // so a fall-through to the settings default is observable in the response.
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fauxtest-default", defaultModel: "default-model" }),
      );

      const registry = await fauxRegistryFor(home, [
        ["fauxtest-main", mainCore],
        ["fauxtest-default", defaultCore],
      ]);
      mainCore.setResponses([fauxAssistantMessage("ran-on-main-model", { stopReason: "stop" })]);
      defaultCore.setResponses([fauxAssistantMessage("ran-on-settings-default", { stopReason: "stop" })]);

      const resolved: string[] = [];
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry: registry,
        mainModel: "fauxtest-main/main-model",
        inheritMainModel: true,
      });
      const result = await agent.run("task", { label: "untagged", onModelResolved: (id) => resolved.push(id) });

      assert.ok(result.includes("ran-on-main-model"), "untagged agent must run on the session's main model");
      assert.deepEqual(resolved, ["fauxtest-main/main-model"], "the resolved id must reach onModelResolved");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): an unavailable inherited main model degrades loudly, reported as inherit-main (not a medium-tier fallback)", async () => {
  // With inheritMainModel on, an unresolvable mainModel must still degrade to
  // the session default (never throw, never silently) — and the fallback
  // payload must say inherit-main, not medium-tier, or debugging a routing
  // surprise sends the user to a model-tiers.json that was never consulted.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-inherit-degrade-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-inherit-degrade-cwd-"));
  const defaultCore = createFauxCore({
    provider: "fauxtest-default",
    models: [{ id: "default-model", name: "Default Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fauxtest-default", defaultModel: "default-model" }),
      );
      const registry = await fauxRegistryFor(home, [["fauxtest-default", defaultCore]]);
      defaultCore.setResponses([fauxAssistantMessage("ran-on-settings-default", { stopReason: "stop" })]);

      const notices: string[] = [];
      const agent = new WorkflowAgent({
        cwd,
        modelRegistry: registry,
        mainModel: "fauxtest-ghost/ghost-model",
        inheritMainModel: true,
      });
      const result = await agent.run("task", {
        label: "untagged",
        onNotice: (message) => notices.push(message),
      });

      assert.ok(result.includes("ran-on-settings-default"), "an unavailable inherited model degrades, not throws");
      assert.deepEqual(notices, [
        'inherited main model "fauxtest-ghost/ghost-model" unavailable — using the session default',
      ]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run(): inheritMainModel with NO main model takes the medium-tier route, and its degrade is reported as medium-tier", async () => {
  // The notice must follow the route actually taken, not the setting: flag on
  // and no mainModel falls through to the medium tier, so a ghost medium entry
  // is blamed (blaming a main model that does not exist would misdirect debugging).
  const home = mkdtempSync(join(tmpdir(), "pi-dw-no-main-degrade-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-no-main-degrade-cwd-"));
  const defaultCore = createFauxCore({
    provider: "fauxtest-default",
    models: [{ id: "default-model", name: "Default Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(
        join(tiersDir, "model-tiers.json"),
        JSON.stringify({ tiers: { medium: "fauxtest-ghost/ghost-model" } }),
      );
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fauxtest-default", defaultModel: "default-model" }),
      );
      const registry = await fauxRegistryFor(home, [["fauxtest-default", defaultCore]]);
      defaultCore.setResponses([fauxAssistantMessage("ran-on-settings-default", { stopReason: "stop" })]);

      const notices: string[] = [];
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry, inheritMainModel: true });
      const result = await agent.run("task", {
        label: "untagged",
        onNotice: (message) => notices.push(message),
      });

      assert.ok(result.includes("ran-on-settings-default"));
      assert.deepEqual(notices, [
        'default "medium" tier model "fauxtest-ghost/ghost-model" unavailable — using the session default',
      ]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runWorkflow(): the degrade log names the route that actually degraded (inherit-main vs medium tier)", async () => {
  // The degrade log must not blame the medium tier when the
  // inheritMainModel route degraded — pinning both messages end-to-end so a
  // swapped branch or renamed message fails CI.
  const home = mkdtempSync(join(tmpdir(), "pi-dw-fallback-log-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-fallback-log-cwd-"));
  const defaultCore = createFauxCore({
    provider: "fauxtest-default",
    models: [{ id: "default-model", name: "Default Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultProvider: "fauxtest-default", defaultModel: "default-model" }),
      );
      const registry = await fauxRegistryFor(home, [["fauxtest-default", defaultCore]]);
      const script = `export const meta = { name: "fallback_log_demo", description: "one untagged agent" }
await agent("task", { label: "untagged" });
return "done";`;

      // inheritMainModel on, inherited model unavailable → inherit-main message.
      defaultCore.setResponses([fauxAssistantMessage("degraded-1", { stopReason: "stop" })]);
      const inheritLogs: string[] = [];
      await runWorkflow(script, {
        cwd,
        modelRegistry: registry,
        mainModel: "fauxtest-ghost/ghost-model",
        inheritMainModel: true,
        onLog: (message) => inheritLogs.push(message),
      });
      assert.ok(
        inheritLogs.some(
          (m) => m === 'inherited main model "fauxtest-ghost/ghost-model" unavailable — using the session default',
        ),
        `expected the inherit-main degrade message, got: ${JSON.stringify(inheritLogs)}`,
      );

      // Untagged route: medium tier configured but unavailable → medium-tier message.
      const tiersDir = join(home, ".pi", "workflows");
      mkdirSync(tiersDir, { recursive: true });
      writeFileSync(
        join(tiersDir, "model-tiers.json"),
        JSON.stringify({ tiers: { medium: "fauxtest-ghost/ghost-model" } }),
      );
      defaultCore.setResponses([fauxAssistantMessage("degraded-2", { stopReason: "stop" })]);
      const tierLogs: string[] = [];
      await runWorkflow(script, {
        cwd,
        modelRegistry: registry,
        mainModel: "fauxtest-default/default-model",
        onLog: (message) => tierLogs.push(message),
      });
      assert.ok(
        tierLogs.some(
          (m) =>
            m === 'default "medium" tier model "fauxtest-ghost/ghost-model" unavailable — using the session default',
        ),
        `expected the medium-tier degrade message, got: ${JSON.stringify(tierLogs)}`,
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run() still completes with a normal object schema (no regression)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-schema-ok-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-schema-ok-cwd-"));
  const core = createFauxCore({
    provider: "fauxtest-schema",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null });
      runtime.registerProvider("fauxtest-schema", {
        name: "Faux Test Schema",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: core.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          reasoning: false,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 4096,
        })),
      });
      const registry = new ModelRegistry(runtime);
      core.setResponses([
        fauxAssistantMessage(fauxToolCall("structured_output", { verdict: "ok" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("", { stopReason: "stop" }),
      ]);

      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      const runOptions = {
        model: "fauxtest-schema/faux-model",
        schema: Type.Object({ verdict: Type.String() }),
        thread: "structured",
      } as const;
      const result = await agent.run("task", runOptions);

      assert.deepEqual(result, { verdict: "ok" });
      await assert.rejects(agent.run("empty follow-up", { ...runOptions, maxSchemaRetries: 0 }), (error: unknown) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
        return true;
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("WorkflowAgent constructor accepts all option shapes without throwing", () => {
  const optionSets = [
    undefined,
    { cwd: "/tmp" },
    { cwd: "/tmp", instructions: "custom instruction" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test" },
    { cwd: "/tmp", excludeTools: ["pi-subagents"] },
    { cwd: "/tmp", mainModel: "openai/gpt-4.1" },
    { cwd: "/tmp", tools: [], session: {}, instructions: "test", mainModel: "openai/gpt-4.1" },
    {
      cwd: "/tmp",
      modelRegistry: {
        getAvailable: () => [{ provider: "mock", id: "model" }],
        find: () => undefined,
        getAll: () => [],
      } as any,
    },
  ];
  for (const opts of optionSets) {
    const agent = opts ? new WorkflowAgent(opts) : new WorkflowAgent();
    assert.ok(agent instanceof WorkflowAgent, `agent should be constructed for options: ${JSON.stringify(opts)}`);
  }
});

test("DEFAULT_EXCLUDED_SUBAGENT_TOOLS denies the recursive orchestration tools", () => {
  // Subagents must never see the globally-registered orchestration tools, or they
  // could start or steer independent runs that bypass the parent run's caps.
  // This is the always-on denylist folded into every subagent session; the guard
  // is a regression fence so it can't be silently narrowed.
  assert.deepEqual(DEFAULT_EXCLUDED_SUBAGENT_TOOLS, ["subagents", "subagents_control"]);
});

test("subagentExcludedTools always includes the defaults, plus caller/session names", () => {
  // This is what run() passes to createAgentSession as excludeTools. Fencing the
  // merge here catches a spread-order regression that drops the defaults — which
  // a deepEqual on the constant alone would miss.
  assert.deepEqual(subagentExcludedTools(), ["subagents", "subagents_control"]);
  assert.deepEqual(subagentExcludedTools(["pi-subagents"]), ["subagents", "subagents_control", "pi-subagents"]);
  const merged = subagentExcludedTools(["extra"], ["session-denied"]);
  assert.ok(merged.includes("subagents") && merged.includes("subagents_control"), "defaults are never dropped");
  assert.ok(merged.includes("session-denied") && merged.includes("extra"), "both caller lists are folded in");
});

test("the subagent resource loader is built once per directory and shared across subagents", async () => {
  // One filtered loader per directory, reused by every
  // subagent there, instead of createAgentSession re-running every extension factory
  // (and rooting each disposed session) per subagent. Memoization is the invariant.
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  type Priv = { getSharedResourceLoader(agentDir: string): Promise<unknown> };
  const a = agent as unknown as Priv;
  const first = a.getSharedResourceLoader("/tmp/agentdir");
  const second = a.getSharedResourceLoader("/tmp/agentdir");
  assert.equal(first, second, "same promise — the loader is built once and shared, not rebuilt per subagent");
  // reload() may reject in a bare temp dir; we only assert memoization here.
  await Promise.allSettled([first, second]);
});

test("provider middleware approval does not inherit from unrelated ancestor directories", () => {
  const allowed = ["example-provider-adapter"];
  assert.equal(isProviderMiddlewareExtensionPath("/example-provider-adapter/project/unrelated.js", allowed), false);
  assert.equal(
    isProviderMiddlewareExtensionPath("/node_modules/@other/example-provider-adapter/index.js", allowed),
    false,
  );
  assert.equal(
    isProviderMiddlewareExtensionPath("/packages/adapter/index.js", allowed, "npm:example-provider-adapter@1.0.0"),
    true,
  );
  assert.equal(
    isProviderMiddlewareExtensionPath("/packages/adapter/index.js", allowed, "/local/example-provider-adapter"),
    true,
  );
  assert.equal(
    isProviderMiddlewareExtensionPath("/packages/adapter/index.js", allowed, "/example-provider-adapter/unrelated"),
    false,
  );
});

test("provider middleware path matching uses exact identities and always denies recursion", () => {
  const allowed = [" Example-Provider-Adapter ", "workflow", "pi-dynamic-workflows", "pi-subagents"];
  for (const path of [
    "/extensions/example-provider-adapter.ts",
    "/node_modules/example-provider-adapter/src/index.js",
    "C:\\extensions\\EXAMPLE-PROVIDER-ADAPTER.cjs",
  ]) {
    assert.equal(isProviderMiddlewareExtensionPath(path, allowed), true, path);
    assert.equal(isProviderMiddlewareExtensionPath(path, []), false, path);
  }
  for (const path of [
    "/extensions/not-example-provider-adapter.ts",
    "/extensions/workflow.ts",
    "/extensions/pi-subagents.js",
    "/node_modules/pi-dynamic-workflows/extensions/index.ts",
    "/example-provider-adapter/workflow.mjs",
    "/pi-subagents/example-provider-adapter.ts",
  ]) {
    assert.equal(isProviderMiddlewareExtensionPath(path, allowed), false, path);
  }
});

for (const allowlist of [
  undefined,
  [],
  ["example-provider-adapter", "workflow", "pi-subagents", "pi-dynamic-workflows"],
]) {
  test(`child middleware binds before prompting only when opted in (${JSON.stringify(allowlist)})`, async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-dw-middleware-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-middleware-cwd-"));
    const extensionDir = join(home, ".pi", "agent", "extensions");
    const core = createFauxCore({
      provider: "fauxtest-middleware",
      models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
    });
    try {
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        join(extensionDir, "example-provider-adapter.js"),
        `export default function (pi) {
          let started = false;
          pi.on("session_start", () => { started = true; });
          pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nADAPTER_BOUND" }));
          pi.on("before_provider_request", (event) => ({ ...event.payload, adapterStarted: started }));
        }`,
      );
      for (const name of ["workflow", "pi-subagents", "pi-dynamic-workflows", "unrelated-extension"]) {
        writeFileSync(
          join(extensionDir, `${name}.js`),
          `export default function () { throw new Error("excluded extension factory loaded"); }`,
        );
      }
      await withFakeHomeAsync(home, async () => {
        const registry = await fauxRegistry(home, "fauxtest-middleware", core);
        const agent = new WorkflowAgent({ cwd, modelRegistry: registry, providerMiddlewareExtensions: allowlist });
        const loader = await (agent as unknown as WorkflowAgentPrivates).getSharedResourceLoader(
          join(home, ".pi", "agent"),
        );
        const result = loader.getExtensions();
        assert.deepEqual(DEFAULT_PROVIDER_MIDDLEWARE_EXTENSIONS, []);
        assert.deepEqual(result.errors, [], "excluded factories must never execute");
        assert.deepEqual(
          result.extensions.map((entry) => entry.path),
          allowlist?.length ? [join(extensionDir, "example-provider-adapter.js")] : [],
        );
        let requests = 0;
        core.setResponses([
          async (context, options, _state, model) => {
            requests++;
            assert.equal(JSON.stringify(context).includes("ADAPTER_BOUND"), Boolean(allowlist?.length));
            // Faux transport does not serialize HTTP payloads. Exercise the SDK's
            // actual request hook locally, without contacting an external provider.
            assert.ok(options?.onPayload);
            const payload = await options.onPayload({ task: "example" }, model);
            assert.deepEqual(
              payload,
              allowlist?.length ? { task: "example", adapterStarted: true } : { task: "example" },
            );
            return fauxAssistantMessage("middleware checked", { stopReason: "stop" });
          },
        ]);
        await agent.run("task", { model: "fauxtest-middleware/faux-model" });
        assert.equal(requests, 1, "the real child SDK session must reach the faux provider");
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("provider middleware resolves package entrypoints without loading disabled or recursive factories", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-middleware-package-"));
  try {
    const packageDir = join(root, "example-provider-adapter");
    mkdirSync(packageDir);
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ pi: { extensions: ["index.js", "disabled.js", "workflow.js"] } }),
    );
    writeFileSync(join(packageDir, "index.js"), "export default function () {}");
    for (const file of ["disabled.js", "workflow.js"]) {
      writeFileSync(
        join(packageDir, file),
        'export default function () { throw new Error("excluded factory loaded"); }',
      );
    }
    const agent = new WorkflowAgent({
      cwd: root,
      providerMiddlewareExtensions: ["example-provider-adapter", "workflow"],
      session: {
        settingsManager: SettingsManager.inMemory({
          packages: [{ source: packageDir, extensions: ["index.js", "workflow.js"] }],
        }),
      },
    });
    const loader = await (agent as unknown as WorkflowAgentPrivates).getSharedResourceLoader(join(root, "agent"));
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(
      loader.getExtensions().extensions.map((entry) => entry.path),
      [join(packageDir, "index.js")],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider middleware resolves per run cwd using injected project trust settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-middleware-cwd-home-"));
  const root = mkdtempSync(join(tmpdir(), "pi-dw-middleware-cwd-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const core = createFauxCore({
    provider: "fauxtest-middleware-cwd",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    for (const [cwd, marker] of [
      [first, "FIRST_ADAPTER_BOUND"],
      [second, "SECOND_ADAPTER_BOUND"],
    ]) {
      const extensionDir = join(cwd, ".pi", "extensions");
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        join(extensionDir, "example-provider-adapter.js"),
        `export default function (pi) {
          let turns = 0;
          pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n${marker}:" + (++turns) }));
        }`,
      );
    }
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-middleware-cwd", core);
      const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
      const agent = new WorkflowAgent({
        cwd: first,
        modelRegistry: registry,
        providerMiddlewareExtensions: ["example-provider-adapter"],
        session: { settingsManager },
      });
      const contexts: unknown[] = [];
      core.setResponses(
        [1, 2, 3].map(() => (context) => {
          contexts.push(context);
          return fauxAssistantMessage("cwd middleware bound", { stopReason: "stop" });
        }),
      );
      const model = "fauxtest-middleware-cwd/faux-model";
      await agent.run("first", { cwd: first, model });
      await agent.run("second", { cwd: second, model });
      await agent.run("first again", { cwd: first, model });
      const requests = contexts.map((context) => JSON.stringify(context));
      assert.match(requests[0], /FIRST_ADAPTER_BOUND:1/);
      assert.doesNotMatch(requests[0], /SECOND_ADAPTER_BOUND/);
      assert.match(requests[1], /SECOND_ADAPTER_BOUND:1/);
      assert.doesNotMatch(requests[1], /FIRST_ADAPTER_BOUND/);
      assert.match(
        requests[2],
        /FIRST_ADAPTER_BOUND:1/,
        "each child needs its own extension runtime and factory state",
      );
      const privateAgent = agent as unknown as WorkflowAgentPrivates;
      const agentDir = join(home, ".pi", "agent");
      const [firstLoader, repeatedLoader, secondLoader] = await Promise.all([
        privateAgent.getSharedResourceLoader(agentDir, first),
        privateAgent.getSharedResourceLoader(agentDir, first),
        privateAgent.getSharedResourceLoader(agentDir, second),
      ]);
      assert.notEqual(firstLoader, repeatedLoader);
      assert.notEqual(firstLoader, secondLoader);
      const untrusted = new WorkflowAgent({
        cwd: first,
        providerMiddlewareExtensions: ["example-provider-adapter"],
        session: { settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }) },
      });
      const untrustedLoader = await (untrusted as unknown as WorkflowAgentPrivates).getSharedResourceLoader(agentDir);
      assert.deepEqual(untrustedLoader.getExtensions().extensions, [], "allowlist must not bypass project trust");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed per-directory resource loader is evicted before the next attempt", async () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  type Priv = { getSharedResourceLoader(agentDir: string, cwd: string): Promise<unknown> };
  const privateAgent = agent as unknown as Priv;
  const originalReload = DefaultResourceLoader.prototype.reload;
  let reloadAttempts = 0;
  DefaultResourceLoader.prototype.reload = async function reloadForFailureTest() {
    reloadAttempts++;
    throw new Error("injected loader reload failure");
  };
  try {
    const first = privateAgent.getSharedResourceLoader("/tmp/agentdir", "/tmp");
    await assert.rejects(first, /injected loader reload failure/);
    const second = privateAgent.getSharedResourceLoader("/tmp/agentdir", "/tmp");
    assert.notEqual(second, first, "a rejected promise must not stay memoized for this directory");
    await assert.rejects(second, /injected loader reload failure/);
    assert.equal(reloadAttempts, 2, "the next call must construct and reload a fresh loader");
  } finally {
    DefaultResourceLoader.prototype.reload = originalReload;
  }
});

test("the shared resource-loader memo is bounded while loaders are still pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-loader-pending-root-"));
  const agentDir = mkdtempSync(join(root, "agent-"));
  try {
    const agent = new WorkflowAgent({ cwd: root });
    type Priv = { getSharedResourceLoader(agentDir: string, cwd: string): Promise<unknown> };
    const privateAgent = agent as unknown as Priv;
    const promises = Array.from({ length: 12 }, (_, i) => {
      const cwd = mkdtempSync(join(root, `cwd-${i}-`));
      return privateAgent.getSharedResourceLoader(agentDir, cwd);
    });
    const loaders = (agent as unknown as { resourceLoaders: Map<string, unknown> }).resourceLoaders;

    assert.ok(loaders.size <= 8, `the memo must be bounded before any loader resolves (got ${loaders.size})`);
    await Promise.all(promises);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// finalAssistantText — the unstructured result must come AFTER the last tool
// result, so stale progress text can't be reported as a completed answer
// ═══════════════════════════════════════════════════════════════════════

const progressThenToolResult = [
  { role: "assistant", content: [{ type: "text", text: "I'll inspect the repository now." }] },
  { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
  { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "command output" }] },
];

test("finalAssistantText rejects progress text before a terminal tool result", () => {
  const text = finalAssistantText(progressThenToolResult);
  assert.equal(text, "", "text emitted before the final tool result is not a final answer");
});

test("finalAssistantText accepts a real assistant answer AFTER tools", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "Let me check." }] },
    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "output" }] },
    { role: "assistant", content: [{ type: "text", text: "The answer is 42." }] },
  ];
  const text = finalAssistantText(messages);
  assert.equal(text, "The answer is 42.", "a genuine post-tool answer still counts");
});

test("finalAssistantText returns a plain answer when no tools were used", () => {
  const messages = [{ role: "assistant", content: [{ type: "text", text: "Direct answer." }] }];
  const text = finalAssistantText(messages);
  assert.equal(text, "Direct answer.");
});

test("lastAssistantText stays lenient for schema prose extraction", () => {
  // The schema path's JSON recovery may read the payload from any assistant
  // message, so lastAssistantText must NOT adopt finalAssistantText's stricter
  // "after the last tool result" rule.
  const text = lastAssistantText(progressThenToolResult);
  assert.equal(text, "I'll inspect the repository now.", "lastAssistantText still finds earlier assistant text");
});

test("WorkflowAgent reuses an injected ModelRegistry instead of building its own", async () => {
  const mockModel = catalogModel("mock", "shared");
  const registry = catalogRegistry([mockModel]);

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: registry });
  const resolvedRegistry = await (agent as any).getRegistry();
  assert.equal(resolvedRegistry, registry, "should hand back the injected registry");
  const resolved = resolveModelSpecWithThinking("mock/shared", runtimeOf(resolvedRegistry));
  assert.equal(resolved.model, mockModel, "should resolve via the injected registry");
});

test("WorkflowAgent falls back to building a disk registry when no registry is injected", async () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  // Should not reject; getRegistry() lazily builds a ModelRegistry from disk
  // (async since pi 0.80.8: registries wrap an async-created ModelRuntime).
  await assert.doesNotReject(() => (agent as any).getRegistry());
});

test("WorkflowAgent.resolveModel resolves via a per-run registry when the constructor got none", async () => {
  // Regression test for the per-run `modelRegistry` AgentRunOptions field: a
  // model present only in a registry passed to run() (not the constructor)
  // must still resolve.
  const perRunModel = catalogModel("router", "per-run-only");
  const perRunRegistry = catalogRegistry([perRunModel]);

  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const resolved = resolveModelSpecWithThinking(
    "router/per-run-only",
    runtimeOf(await (agent as any).getRegistry(perRunRegistry)),
  );
  assert.equal(resolved.model, perRunModel, "should resolve via the per-run registry, not a disk registry");
});

test("WorkflowAgent.resolveModel: per-run registry takes precedence over the constructor's shared registry", async () => {
  const constructorModel = catalogModel("ctor", "shared");
  const constructorRegistry = catalogRegistry([constructorModel]);

  const perRunModel = catalogModel("run", "override");
  const perRunRegistry = catalogRegistry([perRunModel]);

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  // The per-run registry, not the constructor's, is consulted when both are set.
  const resolved = resolveModelSpecWithThinking(
    "run/override",
    runtimeOf(await (agent as any).getRegistry(perRunRegistry)),
  );
  assert.equal(resolved.model, perRunModel, "per-run registry should win over the constructor's shared registry");
  // And the constructor registry is still used when no per-run registry is given.
  const fallback = resolveModelSpecWithThinking("ctor/shared", runtimeOf(await (agent as any).getRegistry()));
  assert.equal(fallback.model, constructorModel, "constructor registry should still apply without a per-run override");
});

test("WorkflowAgent.getRegistry: per-run registry wins, then constructor's shared registry, then disk", async () => {
  const constructorRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;
  const perRunRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;

  const agent = new WorkflowAgent({ cwd: "/tmp", modelRegistry: constructorRegistry });
  assert.equal(await (agent as any).getRegistry(perRunRegistry), perRunRegistry);
  assert.equal(await (agent as any).getRegistry(), constructorRegistry);

  const bareAgent = new WorkflowAgent({ cwd: "/tmp" });
  await assert.doesNotReject(() => (bareAgent as any).getRegistry());
});

// ═══════════════════════════════════════════════════════════════════════════
// buildPrompt — verifies that the agent's internal prompt assembly is correct
// ═══════════════════════════════════════════════════════════════════════════

test("buildPrompt includes base instructions and the user prompt, but not the task label", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a helper." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "analyze this",
    { label: "analyzer" },
    false,
  );
  assert.ok(built.includes("You are a helper."), "should include base instructions");
  assert.ok(built.includes("analyze this"), "should include user prompt");
  assert.ok(!built.includes("analyzer"), "the label is display metadata, not prompt text");
});

test("buildPrompt includes per-call instructions when provided", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Base." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "do it",
    { label: "x", instructions: "Extra." },
    false,
  );
  assert.ok(built.includes("Base."), "base instructions");
  assert.ok(built.includes("Extra."), "per-call instructions");
  assert.ok(built.includes("do it"), "user prompt");
});

test("buildPrompt injects structured output contract when schema is used", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("return result", { label: "t" }, true);
  assert.ok(built.includes("structured_output"), "should mention structured_output");
  assert.ok(built.includes("Final output contract:"), "should include contract header");
  assert.ok(built.includes("Do not emit a prose final answer"), "should discourage prose");
  assert.ok(built.includes("call structured_output exactly once"), "should enforce single call");
});

test("buildPrompt works without base instructions", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp" });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", { label: "greeter" }, false);
  assert.equal(built, "hello", "the user prompt is sent unchanged");
});

test("buildPrompt works without label", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "Help." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt("hello", {}, false);
  assert.ok(built.includes("Help."), "should contain Help.");
  assert.ok(built.includes("hello"), "should contain hello");
  assert.ok(!built.includes("Task label:"), "no label when omitted");
});

test("buildPrompt includes both instructions when both base and per-call are set", () => {
  const agent = new WorkflowAgent({ cwd: "/tmp", instructions: "You are a code reviewer." });
  const built: string = (agent as unknown as WorkflowAgentPrivates).buildPrompt(
    "check this file",
    { label: "reviewer", instructions: "Focus on security." },
    true,
  );
  // Order: base instructions, per-call instructions, prompt, structured contract
  assert.ok(built.indexOf("You are a code reviewer.") < built.indexOf("Focus on security."), "base before per-call");
  assert.ok(built.indexOf("Focus on security.") < built.indexOf("check this file"), "per-call before prompt");
  assert.ok(
    built.indexOf("check this file") < built.indexOf("Final output contract:"),
    "prompt before structured contract",
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// lastAssistantText — verifies text extraction from session messages
// ═══════════════════════════════════════════════════════════════════════════

test("lastAssistantText extracts last assistant text content", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ];
  const text: string = lastAssistantText(messages);
  assert.equal(text, "hi there");
});

test("lastAssistantText joins multiple text parts", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    },
  ];
  const text: string = lastAssistantText(messages);
  assert.equal(text, "part1part2");
});

test("lastAssistantText skips non-text content parts", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1" },
        { type: "text", text: "result" },
      ],
    },
  ];
  const text: string = lastAssistantText(messages);
  assert.equal(text, "result");
});

test("lastAssistantText returns empty string when no assistant text", () => {
  const text: string = lastAssistantText([]);
  assert.equal(text, "");
});

test("lastAssistantText returns empty for non-assistant messages", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const text: string = lastAssistantText(messages);
  assert.equal(text, "");
});

test("lastAssistantText picks the last assistant message, not first", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "more" }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];
  const text: string = lastAssistantText(messages);
  assert.equal(text, "final");
});

// ═══════════════════════════════════════════════════════════════════════════
// Full agent() pipeline inside runWorkflow — verifies the agent() function
// in workflow.ts correctly invokes the runner with all options.
// ═══════════════════════════════════════════════════════════════════════════

/** A smart mock agent runner that records every call and validates options shape. */
class CallRecordingAgent {
  calls: Array<{
    prompt: string;
    options: Record<string, unknown>;
  }> = [];

  result: unknown = "mock-result";

  async run(prompt: string, options: any) {
    this.calls.push({ prompt, options: { ...options } });
    // Fire callbacks with synthetic data to test the full pipeline
    options.onUsage?.({
      input: 20,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      total: 30,
      cost: 0.001,
    } satisfies AgentUsage);
    options.onModelResolved?.("openai/gpt-4.1-mini");
    return this.result;
  }
}

test("agent() in workflow passes prompt and label to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze this', { label: 'analyzer' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].prompt, "analyze this");
});

test("agent() in workflow forwards modelRegistry to the runner", async () => {
  const rec = new CallRecordingAgent();
  const fakeRegistry = { getAvailable: () => [], find: () => undefined, getAll: () => [] } as any;
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't' })
     return r`,
    { agent: rec, persistLogs: false, modelRegistry: fakeRegistry },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { modelRegistry?: any }).modelRegistry, fakeRegistry);
});

test("agent() in workflow passes model spec to runner", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { model?: string }).model, "fast-llm/model");
});

test("agent() in workflow forwards modelRegistry for CLI-style model parsing", async () => {
  const rec = new CallRecordingAgent();
  const modelRegistry = { getAll: () => [] };
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('task', { label: 't', model: 'fast-llm/model:xhigh' })
     return r`,
    { agent: rec, modelRegistry: modelRegistry as never, persistLogs: false },
  );
  assert.equal(rec.calls.length, 1);
  assert.equal((rec.calls[0].options as { modelRegistry?: unknown }).modelRegistry, modelRegistry);
  assert.equal((rec.calls[0].options as { model?: string }).model, "fast-llm/model:xhigh");
});

test("agent() in workflow fires onAgentStart and onAgentEnd callbacks", async () => {
  const rec = new CallRecordingAgent();
  const events: string[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => events.push(`start:${e.label}`),
      onAgentEnd: (e) => events.push(`end:${e.label}`),
    },
  );
  assert.deepEqual(events, ["start:greeter", "end:greeter"]);
});

test("agent() in workflow forwards compact subagent history snapshots", async () => {
  const historyRunner = {
    async run(_prompt: string, options: any) {
      options.onHistory?.([{ role: "assistant", kind: "text", text: "working" }]);
      return "done";
    },
  };
  const histories: Array<{ label: string; history: Array<{ text: string }> }> = [];

  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('hello', { label: 'greeter' })
     return 1`,
    {
      agent: historyRunner,
      persistLogs: false,
      onAgentHistory: (event) => histories.push(event),
    },
  );

  assert.equal(histories.length, 1);
  assert.equal(histories[0].label, "greeter");
  assert.equal(histories[0].history[0].text, "working");
});

test("agent() in workflow fires onAgentStart with phase info", async () => {
  const rec = new CallRecordingAgent();
  const starts: Array<{ label: string; phase?: string }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't', phases: [{ title: 'Phase1' }] }
     phase('Phase1')
     await agent('work', { label: 'w' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: (e) => starts.push({ label: e.label, phase: e.phase }),
    },
  );
  assert.equal(starts.length, 1);
  assert.equal(starts[0].phase, "Phase1");
});

test("agent() in workflow returns runner result", async () => {
  const rec = new CallRecordingAgent();
  rec.result = { findings: ["issue1"] };
  const result = await runWorkflow<{ findings: string[] }>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('analyze', { label: 'a' })
     return r`,
    { agent: rec, persistLogs: false },
  );
  assert.deepEqual(result.result, { findings: ["issue1"] });
});

test("agent() in workflow returns null for recoverable errors", async () => {
  const failer = {
    async run() {
      throw new Error("recoverable agent error");
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('failing task', { label: 'f' })
     return r`,
    { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );
  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "recoverable agent error");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow treats empty text output as a recoverable failure", async () => {
  const rec = new CallRecordingAgent();
  rec.result = "   ";
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     const r = await agent('empty task', { label: 'empty' })
     return r`,
    { agent: rec, persistLogs: false, onAgentEnd: (e) => (end = e) },
  );

  assert.equal(result.result, null);
  assert.equal(end?.result, null);
  assert.equal(end?.error, "Subagent produced no assistant output");
  assert.equal(end?.errorCode, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
  assert.equal(end?.recoverable, true);
});

test("agent() in workflow reports non-recoverable errors before throwing", async () => {
  const failer = {
    async run() {
      throw new WorkflowError("schema failed", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
    },
  };
  let end:
    | {
        result: unknown;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
      }
    | undefined;

  await assert.rejects(
    () =>
      runWorkflow<unknown>(
        `export const meta = { name: 'test', description: 't' }
         await agent('schema task', { label: 'schema' })
         return 1`,
        { agent: failer, persistLogs: false, onAgentEnd: (e) => (end = e) },
      ),
    (err) => err instanceof WorkflowError && err.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
  );

  assert.equal(end?.result, null);
  assert.equal(end?.error, "schema failed");
  assert.equal(end?.errorCode, WorkflowErrorCode.SCHEMA_NONCOMPLIANCE);
  assert.equal(end?.recoverable, false);
});

test("agent() in workflow fires onTokenUsage after run", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ input: number; output: number; total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ input: u.input, output: u.output, total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "should fire onTokenUsage once");
  assert.equal(usageEvents[0].total, 30, "should accumulate from agent usage");
});

test("agent() passes onModelResolved callback for display model updates", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't', model: 'some/model' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentEnd: (e) => {
        assert.equal(e.model, "openai/gpt-4.1-mini");
      },
    },
  );
  assert.ok(rec.calls.length > 0, "rec.calls should not be empty");
});

test("onAgentModel corrects a RUNNING agent's model, not just the finished one", async () => {
  const rec = new CallRecordingAgent();
  const order: string[] = [];
  let startEvent: { id: string; model?: string } | undefined;
  let modelEvent: { id: string; model: string } | undefined;
  let endModel: string | undefined;
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      mainModel: "main-prov/main-model",
      onAgentStart: (e) => {
        order.push("start");
        startEvent = { id: e.id, model: e.model };
      },
      onAgentModel: (e) => {
        order.push("model");
        modelEvent = { id: e.id, model: e.model };
      },
      onAgentEnd: (e) => {
        order.push("end");
        endModel = e.model;
      },
    },
  );
  assert.equal(startEvent?.model, "main-prov/main-model", "onAgentStart can only carry the pre-resolution guess");
  assert.equal(modelEvent?.model, "openai/gpt-4.1-mini", "onAgentModel carries the id the agent actually runs on");
  assert.equal(modelEvent?.id, startEvent?.id, "same per-call id, so the host can match it to the started row");
  assert.deepEqual(order, ["start", "model", "end"], "the correction must land BEFORE the agent finishes");
  assert.equal(endModel, "openai/gpt-4.1-mini", "onAgentEnd still carries the resolved model");
});

test("onAgentModel fires for a tier-tagged agent, whose start event cannot know the tier's model", async () => {
  const rec = new CallRecordingAgent();
  const models: string[] = [];
  let startModel: string | undefined;
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't', tier: 'big' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      mainModel: "main-prov/main-model",
      onAgentStart: (e) => {
        startModel = e.model;
      },
      onAgentModel: (e) => models.push(e.model),
    },
  );
  // A tier defers the choice to the agent layer, so agent() deliberately passes
  // model: undefined and the start event falls back to the session's main model.
  assert.equal(rec.calls[0].options.model, undefined, "a tier must not be pre-resolved into an explicit model");
  assert.equal(rec.calls[0].options.tier, "big");
  assert.equal(startModel, "main-prov/main-model");
  assert.deepEqual(models, ["openai/gpt-4.1-mini"], "the tier's real model is pushed while the agent runs");
});

test("a replayed (cache-hit) agent reports the model it actually ran on, not the main model", async () => {
  const rec = new CallRecordingAgent();
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't' })
     return 1`;
  await runWorkflow(script, {
    agent: rec,
    persistLogs: false,
    runId: "replay-model-run",
    mainModel: "main-prov/main-model",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(journal.length, 1);
  assert.equal(journal[0].model, "openai/gpt-4.1-mini", "the resolved model is journaled with the result");

  const replayed: Array<string | undefined> = [];
  const secondRec = new CallRecordingAgent();
  await runWorkflow(script, {
    agent: secondRec,
    persistLogs: false,
    runId: "replay-model-run",
    mainModel: "main-prov/main-model",
    resumeJournal: new Map(journal.map((e) => [e.index, e] as const)),
    onAgentStart: (e) => replayed.push(e.model),
    onAgentEnd: (e) => replayed.push(e.model),
  });
  assert.equal(secondRec.calls.length, 0, "the call must cache-hit, so nothing re-resolves the model");
  assert.deepEqual(
    replayed,
    ["openai/gpt-4.1-mini", "openai/gpt-4.1-mini"],
    "resume must not regress a replayed row back to the main model",
  );
});

test("a journal entry without a model shows the pre-resolution guess", async () => {
  const rec = new CallRecordingAgent();
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'test', description: 't' }
     await agent('task', { label: 't' })
     return 1`;
  await runWorkflow(script, {
    agent: rec,
    persistLogs: false,
    runId: "no-model-run",
    mainModel: "main-prov/main-model",
    onAgentJournal: (e) => journal.push(e),
  });
  // A runner that never reports its model journals no model.
  const withoutModel = journal.map(({ model: _dropped, ...rest }) => rest as JournalEntry);
  const replayed: Array<string | undefined> = [];
  await runWorkflow(script, {
    agent: new CallRecordingAgent(),
    persistLogs: false,
    runId: "no-model-run",
    mainModel: "main-prov/main-model",
    resumeJournal: new Map(withoutModel.map((e) => [e.index, e] as const)),
    onAgentStart: (e) => replayed.push(e.model),
  });
  assert.deepEqual(replayed, ["main-prov/main-model"], "no journaled model => the replayed row shows the main model");
});

test("agent() accumulates usage across multiple agents", async () => {
  const rec = new CallRecordingAgent();
  const usageEvents: Array<{ total: number }> = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('first', { label: 'a' })
     await agent('second', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onTokenUsage: (u) => usageEvents.push({ total: u.total }),
    },
  );
  assert.equal(usageEvents.length, 1, "one final usage event");
  assert.equal(usageEvents[0].total, 60, "two agents × 30 tokens each");
});

test("agent() with timeout should handle gracefully (timeout returns null)", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 50));
      return "slow";
    },
  };
  let errorMessage = "";
  const result = await runWorkflow<unknown>(
    `export const meta = { name: 'test', description: 't' }
     let val = null
     try { val = await agent('slow', { label: 's' }) } catch (e) { val = 'error:' + (e && e.message || e) }
     return { val }`,
    {
      agent: slow,
      agentTimeoutMs: 5,
      persistLogs: false,
      onAgentEnd: (event) => {
        if (event.error) errorMessage = event.error;
      },
    },
  );
  const r = result.result as { val: unknown };
  // agent() catches timeout internally (recoverable) and returns null
  assert.equal(r.val, null, "timeout agent should return null (recoverable)");
  assert.match(errorMessage, /timed out after 5ms/);
  assert.match(errorMessage, /raise defaultAgentTimeoutMs in the workflow settings/);
});

test("agent() default timeout is unbounded", async () => {
  const slow = {
    async run() {
      await new Promise((r) => setTimeout(r, 25));
      return "slow";
    },
  };
  const result = await runWorkflow<{ val: string }>(
    `export const meta = { name: 'test', description: 't' }
     const val = await agent('slow', { label: 's' })
     return { val }`,
    { agent: slow, persistLogs: false },
  );

  assert.equal(result.result.val, "slow");
});

test("agent() with parallel invokes all agents", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await parallel(['a','b','c'].map(p => () => agent(p, { label: p })))
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 3);
  const prompts = rec.calls.map((c) => c.prompt).sort();
  assert.deepEqual(prompts, ["a", "b", "c"]);
});

test("agent() with pipeline invokes agent per stage per item", async () => {
  const rec = new CallRecordingAgent();
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     const rs = await pipeline(['x','y'],
       item => agent('stage1 ' + item, { label: 's1-' + item }),
       result => agent('stage2 ' + result, { label: 's2-' + result }),
     )
     return rs`,
    { agent: rec, persistLogs: false },
  );
  assert.equal(rec.calls.length, 4); // 2 items × 2 stages
});

test("agent() monitors agent count and calls onAgentStart/End for each", async () => {
  const rec = new CallRecordingAgent();
  const counts: number[] = [];
  await runWorkflow(
    `export const meta = { name: 'test', description: 't' }
     await agent('a', { label: 'a' })
     await agent('b', { label: 'b' })
     return 1`,
    {
      agent: rec,
      persistLogs: false,
      onAgentStart: () => {},
      onAgentEnd: (e) => counts.push(e.tokens ?? 0),
    },
  );
  assert.equal(counts.length, 2);
  assert.ok(counts[0] > 0, "first agent tokens");
  assert.ok(counts[1] > 0, "second agent tokens");
});

// ═══════════════════════════════════════════════════════════════════════════
// usageFromStats — the guard between session stats and the onUsage callback.
// ═══════════════════════════════════════════════════════════════════════════

test("usageFromStats maps real stats to an AgentUsage", () => {
  const usage = usageFromStats({
    tokens: { input: 100, output: 50, cacheRead: 900, cacheWrite: 30, total: 1080 },
    cost: 0.42,
  });
  assert.deepEqual(usage, { input: 100, output: 50, cacheRead: 900, cacheWrite: 30, total: 1080, cost: 0.42 });
});

test("usageFromStats returns undefined for all-zero stats (provider reported nothing)", () => {
  const usage = usageFromStats({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  });
  assert.equal(usage, undefined);
});

test("usageFromStats keeps cost-only stats (billed but tokens unreported)", () => {
  const usage = usageFromStats({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0.01,
  });
  assert.equal(usage?.cost, 0.01);
});
// ═══════════════════════════════════════════════════════════════════════
// runtimeOf and the fallback registry
// ═══════════════════════════════════════════════════════════════════════

test("runtimeOf returns the ModelRuntime behind a registry", async () => {
  const authDir = mkdtempSync(join(tmpdir(), "pi-dw-runtime-of-"));
  try {
    const runtime = await ModelRuntime.create({ authPath: join(authDir, "auth.json"), modelsPath: null });
    assert.equal(runtimeOf(new ModelRegistry(runtime)), runtime, "subagent sessions share the host's runtime");
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
});

test("fallback registry resolves to a real ModelRegistry on stock pi and is cached across agents (never undefined)", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-fallback-home-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const agent1 = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentPrivates;
      const agent2 = new WorkflowAgent({ cwd: "/tmp" }) as unknown as WorkflowAgentPrivates;
      const first = await agent1.getRegistry();
      assert.ok(first instanceof ModelRegistry, "fallback must resolve to a real registry, never undefined");
      assert.ok(runtimeOf(first), "stock-pi fallback registry must carry a runtime for subagent handoff");
      assert.equal(await agent1.getRegistry(), first, "per-agent fallback must be reused");
      assert.equal(await agent2.getRegistry(), first, "module-level fallback registry must be shared across agents");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("WorkflowAgent.run bounds the loader memo: one-off cwds are LRU-evicted", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-loader-lru-home-"));
  const root = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-loader-lru-root-"));
  const core = createFauxCore({
    provider: "fauxtest-loader-lru",
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, "fauxtest-loader-lru", core);
      core.setResponses(
        Array.from({ length: 12 }, (_, i) => fauxAssistantMessage(`answer ${i}`, { stopReason: "stop" })),
      );
      const agent = new WorkflowAgent({ cwd: root, modelRegistry: registry });
      // Worktree-style fan-out: every call has a unique explicit cwd.
      for (let i = 0; i < 12; i++) {
        const dir = mkdtempSync(join(root, `wt-${i}-`));
        await agent.run(`call ${i}`, { cwd: dir, model: "fauxtest-loader-lru/faux-model" });
      }
      const loaders = (agent as unknown as { resourceLoaders: Map<string, unknown> }).resourceLoaders;
      assert.ok(loaders.size <= 8, `one-off worktree loaders are LRU-evicted (got ${loaders.size}, cap is 8)`);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
