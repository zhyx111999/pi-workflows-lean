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
import { createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

// Each budget is the measured size of the currently accepted wording, so any growth
// fails here and must be reviewed before the budget is raised. The prompt is measured
// with an empty agentType registry so user configuration cannot alter it.
// docs/workflow-context-surfaces.json records the same two sizes.
//
// Always-on prompt (336 bytes): the workflow promptSnippet plus the single gate
// guideline that defers the call decision to the note appended to user messages.
const RENDERED_PROMPT_BUDGET_BYTES = 336;
// Provider-visible tool definition (4,273 bytes): the `script` description spells
// out checkpoint, budget, phase budgets, and agent() routing options inline and
// forbids cross-check subagents, so authors need not load the skill for routine
// scripts; `background` is documented as ignored.
const TOOL_DEFINITION_BUDGET_BYTES = 4_273;

test("rendered workflow prompt contribution stays within its accepted size", async () => {
  await withRenderedWorkflow(async ({ systemPrompt, promptLines }) => {
    const expectedLines = new Set(promptLines);
    const renderedLines = systemPrompt.split("\n").filter((line) => expectedLines.has(line));
    assert.deepEqual(renderedLines, promptLines, "Pi should render each workflow prompt line exactly once");

    const renderedContribution = renderedLines.join("\n");
    const actualBytes = Buffer.byteLength(renderedContribution, "utf8");
    assert.ok(
      actualBytes <= RENDERED_PROMPT_BUDGET_BYTES,
      `Rendered workflow prompt is ${actualBytes} bytes; budget is ${RENDERED_PROMPT_BUDGET_BYTES}.\n${renderedContribution}`,
    );
  });
});

test("provider-visible workflow tool definition stays within its accepted size", async () => {
  await withRenderedWorkflow(async ({ wrappedWorkflow }) => {
    const definitionJson = JSON.stringify({
      name: wrappedWorkflow.name,
      description: wrappedWorkflow.description,
      parameters: wrappedWorkflow.parameters,
    });
    const actualBytes = Buffer.byteLength(definitionJson, "utf8");
    const parameterBytes = Buffer.byteLength(JSON.stringify(wrappedWorkflow.parameters), "utf8");

    assert.ok(
      actualBytes <= TOOL_DEFINITION_BUDGET_BYTES,
      `Workflow tool definition is ${actualBytes} bytes; budget is ${TOOL_DEFINITION_BUDGET_BYTES} (parameters: ${parameterBytes} bytes).\n${definitionJson}`,
    );
  });
});

async function withRenderedWorkflow(
  inspect: (surface: {
    systemPrompt: string;
    promptLines: string[];
    wrappedWorkflow: {
      name: string;
      description: string;
      parameters: unknown;
    };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workflow-prompt-budget-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await withFakeHomeAsync(root, async () => {
      const workflow = createWorkflowTool({ cwd: root });
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        tools: ["workflow"],
        customTools: [workflow],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
        settingsManager: SettingsManager.inMemory(),
      });

      try {
        const wrappedWorkflow = session.agent.state.tools.find((tool) => tool.name === "workflow");
        assert.ok(wrappedWorkflow, "Pi should expose the wrapped workflow tool");

        await inspect({
          systemPrompt: session.systemPrompt,
          promptLines: [
            `- workflow: ${workflow.promptSnippet}`,
            ...workflow.promptGuidelines.map((guideline) => `- ${guideline}`),
          ],
          wrappedWorkflow,
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
