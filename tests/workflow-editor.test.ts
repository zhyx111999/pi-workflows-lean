import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Context, createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PARENT_PROMPT_MESSAGE_TYPE, PARENT_WORKFLOW_PROMPT } from "../src/parent-prompt.js";
import {
  buildForcedWorkflowPrompt,
  installParentPromptHook,
  registerWorkflowProgressCommands,
} from "../src/workflow-editor.js";

type InputEvent = {
  source: "interactive" | "rpc" | "extension";
  text: string;
  streamingBehavior?: "steer" | "followUp";
};
type InputHandler = (event: InputEvent) => unknown;
type BeforeAgentStartHandler = (event: { prompt: string }) => unknown;

const HIDDEN_PARENT_PROMPT = {
  message: { customType: PARENT_PROMPT_MESSAGE_TYPE, content: PARENT_WORKFLOW_PROMPT, display: false },
};

/** Capture every `pi.on` registration and any attempt to change the active tools. */
function hookHarness() {
  const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  let setActiveToolsCalls = 0;
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    getActiveTools: () => ["bash", "read"],
    setActiveTools: () => {
      setActiveToolsCalls++;
    },
  } as unknown as ExtensionAPI;
  installParentPromptHook(pi);
  const input = handlers.input?.[0] as InputHandler | undefined;
  const beforeAgentStart = handlers.before_agent_start?.[0] as BeforeAgentStartHandler | undefined;
  assert.ok(input, "input handler should be registered");
  assert.ok(beforeAgentStart, "before_agent_start handler should be registered");
  /** Pi's order for a prompt that starts a run: `input`, then `before_agent_start` with the expanded text. */
  const submit = (event: InputEvent, prompt = event.text) => {
    const inputResult = input(event);
    return { inputResult, startResult: beforeAgentStart({ prompt }) };
  };
  return { handlers, input, beforeAgentStart, submit, setActiveToolsCalls: () => setActiveToolsCalls };
}

describe("installParentPromptHook", () => {
  it("registers one input and one before_agent_start hook and nothing else", () => {
    const { handlers, setActiveToolsCalls } = hookHarness();
    assert.deepEqual(Object.keys(handlers).sort(), ["before_agent_start", "input"]);
    assert.equal(handlers.input.length, 1);
    assert.equal(handlers.before_agent_start.length, 1);
    assert.equal(setActiveToolsCalls(), 0, "installing the hook does not touch active tools");
  });

  it("adds the parent prompt as a hidden message after a typed message and leaves the text unchanged", () => {
    const { submit, setActiveToolsCalls } = hookHarness();
    for (const text of ["hello", "please run a workflow over src/", "WORKFLOWS are great"]) {
      const { inputResult, startResult } = submit({ source: "interactive", text });
      assert.equal(inputResult, undefined, "the user message is never transformed");
      assert.deepEqual(startResult, HIDDEN_PARENT_PROMPT, text);
    }
    assert.equal(setActiveToolsCalls(), 0, "the hook never changes the active tool set");
  });

  it("does not add it for slash commands", () => {
    const { submit } = hookHarness();
    for (const text of ["/workflows list", "  /deep-research what is pi?", "/skill:review src"]) {
      const { inputResult, startResult } = submit({ source: "interactive", text });
      assert.equal(inputResult, undefined);
      assert.equal(startResult, undefined, text);
    }
    // A prompt template expands before before_agent_start; the expansion must not match either.
    assert.equal(submit({ source: "interactive", text: "/fix-bug 42" }, "Fix bug 42").startResult, undefined);
  });

  it("does not add it for input from RPC or other extensions", () => {
    const { submit } = hookHarness();
    for (const source of ["rpc", "extension"] as const) {
      assert.equal(submit({ source, text: "run a workflow" }).startResult, undefined, source);
    }
  });

  it("does not add it for steer or follow-up messages typed during a run", () => {
    const { input, beforeAgentStart, submit } = hookHarness();
    assert.deepEqual(submit({ source: "interactive", text: "start" }).startResult, HIDDEN_PARENT_PROMPT);
    for (const streamingBehavior of ["steer", "followUp"] as const) {
      // Pi queues these into the running turn; before_agent_start does not fire for them.
      assert.equal(input({ source: "interactive", text: "also check tests", streamingBehavior }), undefined);
      assert.equal(beforeAgentStart({ prompt: "also check tests" }), undefined, streamingBehavior);
    }
  });

  it("does not carry a recorded message into a later run", () => {
    const { input, beforeAgentStart, submit } = hookHarness();

    // Typed text that never started a run (another extension handled it, or the submit failed),
    // followed by the same text sent by an extension: the stale record must not match.
    input({ source: "interactive", text: "hello" });
    assert.equal(submit({ source: "extension", text: "hello" }).startResult, undefined);

    // Another extension transformed the typed text after this hook recorded it.
    input({ source: "interactive", text: "hello" });
    assert.equal(beforeAgentStart({ prompt: "hello (rewritten)" }), undefined);
    assert.equal(beforeAgentStart({ prompt: "hello" }), undefined, "a mismatch still consumes the record");

    // A matched record is used once.
    assert.deepEqual(submit({ source: "interactive", text: "hello" }).startResult, HIDDEN_PARENT_PROMPT);
    assert.equal(beforeAgentStart({ prompt: "hello" }), undefined);
  });

  it("leaves earlier messages that already carry the old appended prompt alone", () => {
    const { handlers, submit } = hookHarness();
    const legacyText = `hello\n\n---\n${PARENT_WORKFLOW_PROMPT}`;
    // Only input and before_agent_start are hooked, so stored history is never rewritten.
    assert.equal(handlers.context, undefined);
    // Re-sending such text passes through as typed; the prompt still travels separately.
    const { inputResult, startResult } = submit({ source: "interactive", text: legacyText });
    assert.equal(inputResult, undefined);
    assert.deepEqual(startResult, HIDDEN_PARENT_PROMPT);
  });
});

describe("installParentPromptHook in a real Pi session", () => {
  /** Run `drive` against a faux-model session with only the parent-prompt hook installed. */
  async function withHookedSession(
    drive: (session: Awaited<ReturnType<typeof createAgentSession>>["session"]) => Promise<void>,
  ): Promise<Context[]> {
    const root = await mkdtemp(join(tmpdir(), "pi-dw-parent-prompt-"));
    const provider = "fauxtest-parent-prompt";
    const core = createFauxCore({ provider, models: [{ id: "faux-model" }] });
    const contexts: Context[] = [];
    try {
      const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
      modelRuntime.registerProvider(provider, {
        name: "Faux parent prompt",
        baseUrl: "http://127.0.0.1:9/faux",
        apiKey: "faux-dummy-key-not-used",
        api: core.api,
        streamSimple: (model, context, options) => {
          contexts.push(structuredClone(context));
          return core.streamSimple(model, context, options);
        },
        models: core.models.map((model) => ({
          ...model,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        })),
      });
      core.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("ok", { stopReason: "stop" })));
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        extensionFactories: [(pi) => installParentPromptHook(pi)],
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        modelRuntime,
        model: core.getModel(),
        tools: [],
        resourceLoader,
        sessionManager: SessionManager.inMemory(root),
        settingsManager: SettingsManager.inMemory(),
      });
      try {
        await drive(session);
      } finally {
        session.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return contexts;
  }

  const lastTurnTexts = (context: Context | undefined) =>
    (context?.messages ?? []).slice(-3).map((message) => {
      const content = message.content;
      return typeof content === "string" ? content : content.map((part) => ("text" in part ? part.text : "")).join("");
    });

  it("sends the prompt to the model after the typed text and stores it as a hidden message", async () => {
    let stored: unknown[] = [];
    const contexts = await withHookedSession(async (session) => {
      await session.prompt("audit src/");
      stored = session.messages.slice();
    });
    assert.equal(contexts.length, 1);
    const sent = contexts[0].messages;
    assert.deepEqual(
      sent.map((message) => message.role),
      ["user", "user"],
    );
    assert.deepEqual(lastTurnTexts(contexts[0]).slice(-2), ["audit src/", PARENT_WORKFLOW_PROMPT]);
    assert.deepEqual(
      stored.slice(0, 2).map((message) => {
        const { role, content, customType, display } = message as Record<string, unknown>;
        return { role, content, customType, display };
      }),
      [
        { role: "user", content: [{ type: "text", text: "audit src/" }], customType: undefined, display: undefined },
        { role: "custom", content: PARENT_WORKFLOW_PROMPT, customType: PARENT_PROMPT_MESSAGE_TYPE, display: false },
      ],
    );
  });

  it("skips slash text and extension messages, and leaves earlier turns untouched", async () => {
    const contexts = await withHookedSession(async (session) => {
      await session.prompt("/not-a-command keep this literal");
      await session.sendUserMessage("queued by another extension");
      await session.prompt("next typed message");
    });
    assert.equal(contexts.length, 3);
    assert.deepEqual(lastTurnTexts(contexts[0]).slice(-1), ["/not-a-command keep this literal"]);
    assert.deepEqual(lastTurnTexts(contexts[1]).slice(-2), ["ok", "queued by another extension"]);
    assert.deepEqual(lastTurnTexts(contexts[2]).slice(-2), ["next typed message", PARENT_WORKFLOW_PROMPT]);
    // Earlier turns reach the model exactly as they were first sent.
    assert.deepEqual(contexts[2].messages.slice(0, contexts[1].messages.length), contexts[1].messages);
  });
});

describe("buildForcedWorkflowPrompt (/workflows run)", () => {
  it("forces the tool call instead of leaving room for a prose answer (#P5)", () => {
    const result = buildForcedWorkflowPrompt("audit the repo");
    assert.ok(result.startsWith("audit the repo"), "starts with the original prompt");
    assert.match(result, /\/workflows run/, "identifies the explicit command");
    assert.match(result, /Call the `workflow` tool now/i, "tells the model to run the workflow");
    assert.match(result, /do not answer in prose instead of running the workflow/i);
  });

  it("says the turn ends and the result is delivered back (#89)", () => {
    const result = buildForcedWorkflowPrompt("audit the repo");
    assert.match(result, /always runs in the background/i);
    assert.match(result, /delivered back into the conversation automatically/i);
    assert.match(result, /that's expected, not a stall/i);
    assert.doesNotMatch(result, /background:\s*false/i, "blocking runs no longer exist");
  });

  it("does NOT reintroduce the MUST/ONLY forcing language that caused #88/#89", () => {
    const result = buildForcedWorkflowPrompt("audit the repo");
    assert.ok(!/\bMUST\b/.test(result), "no MUST");
    assert.ok(!/ONLY acceptable/i.test(result), "no 'ONLY acceptable'");
  });
});

describe("registerWorkflowProgressCommands", () => {
  function setup() {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const sent: Array<{ content?: string }> = [];
    let settings: Record<string, unknown> = {};
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
      sendMessage: (message: { content?: string }) => {
        sent.push(message);
      },
    } as unknown as ExtensionAPI;
    const settingsStore = {
      load: () => ({ ...settings }),
      save: (next: Record<string, unknown>) => {
        settings = { ...settings, ...next };
      },
    };
    return { commands, sent, settingsStore, getSettings: () => settings, pi };
  }

  it("registers a single merged /workflows-progress command (no separate -max command)", async () => {
    const { commands, settingsStore, pi } = setup();
    registerWorkflowProgressCommands(pi, settingsStore);

    assert.ok(commands.get("workflows-progress"), "registers /workflows-progress");
    assert.equal(commands.get("workflows-progress-max"), undefined, "no separate /workflows-progress-max command");
    assert.equal(commands.size, 1, "only one command is registered");
  });

  it("persists a valid mode and reports both mode and max on status", async () => {
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("detailed", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed" });
    assert.match(sent.at(-1)?.content ?? "", /detailed/i);

    await cmd.handler("compact", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "compact" });
    assert.match(sent.at(-1)?.content ?? "", /compact/i);

    await cmd.handler("status", {});
    assert.match(sent.at(-1)?.content ?? "", /panel is compact/i);
    assert.match(sent.at(-1)?.content ?? "", /up to \d+ agents per phase/i);

    await cmd.handler("", {});
    assert.match(sent.at(-1)?.content ?? "", /panel is compact/i);
    assert.match(sent.at(-1)?.content ?? "", /Usage: \/workflows-progress compact \| detailed \| status \| max <N>/);
  });

  it("ignores an invalid/unrecognized subverb without persisting, reporting current status", async () => {
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    registerWorkflowProgressCommands(pi, settingsStore);

    await commands.get("workflows-progress")?.handler("verbose", {});
    assert.deepEqual(getSettings(), {}, "invalid mode is not saved");
    assert.match(sent.at(-1)?.content ?? "", /Usage:/);
  });

  it("max <N> clamps and persists the per-phase agent cap, rejecting non-numbers", async () => {
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("max 12", {});
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 12 });
    assert.match(sent.at(-1)?.content ?? "", /up to 12 agents per phase/);

    await cmd.handler("max 5000", {});
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "clamps to 1000");

    await cmd.handler("max abc", {});
    assert.match(sent.at(-1)?.content ?? "", /Invalid value/);
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "invalid value does not overwrite");

    await cmd.handler("max 0", {});
    assert.match(sent.at(-1)?.content ?? "", /Invalid value/);
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "invalid value does not overwrite");
  });

  it("max with no number reports the current max and usage", async () => {
    const { commands, sent, settingsStore, pi } = setup();
    registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("max", {});
    assert.match(sent.at(-1)?.content ?? "", /shows up to \d+ agents per phase/);
    assert.match(sent.at(-1)?.content ?? "", /Usage: \/workflows-progress max <1-1000>/);
  });

  it("is case-insensitive for subverbs", async () => {
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("DETAILED", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed" });

    await cmd.handler("MAX 7", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed", progressPanelMaxAgents: 7 });
    assert.match(sent.at(-1)?.content ?? "", /up to 7 agents per phase/);
  });
});
