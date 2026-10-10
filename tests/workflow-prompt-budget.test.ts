import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { measuredTools, permanentToolPromptLines } from "../src/workflow-context-measurement.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// Each budget is the measured size of the currently accepted wording, so any growth
// fails here and must be reviewed before the budget is raised. The prompt is measured
// with an empty agentType registry so user configuration cannot alter it.
// docs/workflow-context-surfaces.json records the same sizes.
//
// Always-on prompt (165 bytes): the subagents promptSnippet plus the single gate
// guideline that defers the call decision to the hidden note after user messages.
// subagents_control adds no prompt lines.
const RENDERED_PROMPT_BUDGET_BYTES = 165;
// Provider-visible tool definitions (1,951 bytes for both tools): `subagents`
// names its three start modes and points script authors at the skill in one line;
// `subagents_control` documents each action's fields in its description so most
// parameters need no description of their own.
const TOOL_DEFINITIONS_BUDGET_BYTES = 1_951;

test("rendered tool prompt contribution stays within its accepted size", async () => {
  await withRenderedTools(async ({ systemPrompt, promptLines }) => {
    const expectedLines = new Set(promptLines);
    const renderedLines = systemPrompt.split("\n").filter((line) => expectedLines.has(line));
    assert.deepEqual(renderedLines, promptLines, "Pi should render each tool prompt line exactly once");

    const renderedContribution = renderedLines.join("\n");
    const actualBytes = Buffer.byteLength(renderedContribution, "utf8");
    assert.ok(
      actualBytes <= RENDERED_PROMPT_BUDGET_BYTES,
      `Rendered tool prompt is ${actualBytes} bytes; budget is ${RENDERED_PROMPT_BUDGET_BYTES}.\n${renderedContribution}`,
    );
  });
});

test("provider-visible tool definitions stay within their accepted size", async () => {
  await withRenderedTools(async ({ wrappedTools }) => {
    const definitions = wrappedTools.map((tool) =>
      JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
    );
    const actualBytes = definitions.reduce((sum, definition) => sum + Buffer.byteLength(definition, "utf8"), 0);

    assert.ok(
      actualBytes <= TOOL_DEFINITIONS_BUDGET_BYTES,
      `Tool definitions are ${actualBytes} bytes; budget is ${TOOL_DEFINITIONS_BUDGET_BYTES}.\n${definitions.join("\n")}`,
    );
  });
});

async function withRenderedTools(
  inspect: (surface: {
    systemPrompt: string;
    promptLines: string[];
    wrappedTools: Array<{ name: string; description: string; parameters: unknown }>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workflow-prompt-budget-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await withFakeHomeAsync(root, async () => {
      const tools = measuredTools();
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        tools: tools.map((tool) => tool.name),
        customTools: tools as never,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
        settingsManager: SettingsManager.inMemory(),
      });

      try {
        const wrappedTools = tools.map((tool) => {
          const wrapped = session.agent.state.tools.find((candidate) => candidate.name === tool.name);
          assert.ok(wrapped, `Pi should expose the wrapped ${tool.name} tool`);
          return wrapped;
        });
        await inspect({
          systemPrompt: session.systemPrompt,
          promptLines: permanentToolPromptLines(tools),
          wrappedTools,
        });
      } finally {
        session.dispose();
      }
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}
