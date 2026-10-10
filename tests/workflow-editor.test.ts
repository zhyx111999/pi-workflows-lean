import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendParentWorkflowPrompt, PARENT_WORKFLOW_PROMPT } from "../src/parent-prompt.js";
import {
  buildForcedWorkflowPrompt,
  installParentPromptHook,
  registerWorkflowProgressCommands,
} from "../src/workflow-editor.js";

type InputHandler = (event: { source?: string; text?: string }) => { action: string; text?: string };

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
  assert.ok(input, "input handler should be registered");
  return { handlers, input, setActiveToolsCalls: () => setActiveToolsCalls };
}

describe("installParentPromptHook", () => {
  it("registers exactly one input hook and nothing else", () => {
    const { handlers, setActiveToolsCalls } = hookHarness();
    assert.deepEqual(Object.keys(handlers), ["input"]);
    assert.equal(handlers.input.length, 1);
    assert.equal(setActiveToolsCalls(), 0, "installing the hook does not touch active tools");
  });

  it("appends the parent prompt verbatim to an interactive message", () => {
    const { input, setActiveToolsCalls } = hookHarness();
    for (const text of ["hello", "please run a workflow over src/", "WORKFLOWS are great"]) {
      const result = input({ source: "interactive", text });
      assert.deepEqual(result, { action: "transform", text: `${text}\n\n---\n${PARENT_WORKFLOW_PROMPT}` });
      assert.equal(result.text, appendParentWorkflowPrompt(text));
    }
    assert.equal(setActiveToolsCalls(), 0, "the hook never changes the active tool set");
  });

  it("leaves slash commands, empty input, and already-tagged text unchanged", () => {
    const { input } = hookHarness();
    for (const text of ["/workflows list", "  /deep-research what is pi?", "", "   "]) {
      assert.deepEqual(input({ source: "interactive", text }), { action: "continue" }, JSON.stringify(text));
    }
    const tagged = appendParentWorkflowPrompt("hello");
    assert.deepEqual(input({ source: "interactive", text: tagged }), { action: "continue" });
  });

  it("ignores input that is not typed interactively", () => {
    const { input } = hookHarness();
    for (const source of ["rpc", "extension", undefined]) {
      assert.deepEqual(input({ source, text: "run a workflow" }), { action: "continue" }, String(source));
    }
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
