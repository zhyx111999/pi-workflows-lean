import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunOptions } from "../src/agent.js";
import type { AgentDefinition } from "../src/agent-registry.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { THINKING_LEVELS } from "../src/model-spec.js";
import { resolveIsolation } from "../src/runtime/agent-options.js";
import { runWorkflow } from "../src/workflow.js";
import {
  AGENT_OPTIONS,
  AGENT_PROMPT,
  type OptionDescriptor,
  type OptionValueRule,
} from "../src/workflow-capability-contract.js";

function recordingRunner() {
  const calls: Array<{ prompt: string; options: AgentRunOptions }> = [];
  return {
    calls,
    runner: {
      async run(prompt: string, options: AgentRunOptions) {
        calls.push({ prompt, options });
        return "ran";
      },
    },
  };
}

/** Values each declared rule must refuse; derived from the rule so a new option is covered automatically. */
function outOfContract(rule: OptionValueRule, missingDirectory: string): unknown[] {
  switch (rule.kind) {
    case "string":
      return rule.nonEmpty ? [null, 42, "  "] : [null, 42];
    case "boolean":
      return [null, "false", 0];
    case "literal":
      return [null, "none", 1];
    case "json-schema":
      return [null, "x", ["a"]];
    case "directory":
      return [null, "relative-dir", missingDirectory];
  }
}

const isValidationError = (error: unknown): error is WorkflowError =>
  error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR && !error.recoverable;

test("agent() rejects every out-of-contract prompt and option value before dispatch, naming accepted values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-options-"));
  const missingDirectory = join(root, "missing");
  const { calls, runner } = recordingRunner();
  const run = (args: string) =>
    runWorkflow(
      `export const meta = { name: 'option_values', description: 'option value validation' }
return await agent(${args})`,
      { agent: runner, persistLogs: false, cwd: root },
    );
  const cases = (descriptor: OptionDescriptor) => outOfContract(descriptor.accepts, missingDirectory);
  try {
    for (const value of [undefined, ...cases(AGENT_PROMPT)]) {
      await assert.rejects(
        run(value === undefined ? "" : JSON.stringify(value)),
        (error: unknown) => isValidationError(error) && /agent\(\) prompt .*non-empty string/.test(error.message),
        `prompt ${JSON.stringify(value)} must be rejected`,
      );
    }
    for (const descriptor of AGENT_OPTIONS.options) {
      for (const value of cases(descriptor)) {
        const options = `{ ${descriptor.name}: ${JSON.stringify(value)} }`;
        await assert.rejects(
          run(`'work', ${options}`),
          (error: unknown) => {
            if (!isValidationError(error) || !error.message.startsWith(`agent() ${descriptor.name} must be `)) {
              return false;
            }
            const { accepts } = descriptor;
            return accepts.kind !== "literal" || accepts.values.every((v) => error.message.includes(JSON.stringify(v)));
          },
          `agent('work', ${options}) must be rejected`,
        );
      }
    }
    assert.equal(calls.length, 0, "no out-of-contract call reaches the agent runner");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an out-of-contract isolation value cannot bypass an agentType worktree", async () => {
  // Not a git repository: honoring the agentType's worktree would fail closed, so any dispatch is a bypass.
  const cwd = mkdtempSync(join(tmpdir(), "pi-agent-isolation-"));
  const agentRegistry = new Map([
    ["isolated", { name: "isolated", prompt: "role", isolation: "worktree", source: "project" } as AgentDefinition],
  ]);
  const { calls, runner } = recordingRunner();
  try {
    for (const isolation of ["'none'", "null", "0", "'Worktree'"]) {
      await assert.rejects(
        runWorkflow(
          `export const meta = { name: 'isolation_bypass', description: 'isolation must fail closed' }
return await agent('edit files', { agentType: 'isolated', isolation: ${isolation} })`,
          { agent: runner, agentRegistry, persistLogs: false, cwd },
        ),
        (error: unknown) =>
          isValidationError(error) && /isolation must be one of: "worktree", false/.test(error.message),
      );
    }
    assert.equal(calls.length, 0, "the shared checkout is never used");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("contract values pass validation; thread is trimmed and a blank label uses the default", async () => {
  const { calls, runner } = recordingRunner();
  const result = await runWorkflow(
    `export const meta = { name: 'option_pass', description: 'valid option values' }
return await agent('work', { label: ' ', thinking: 'high', isolation: false, keepWorktree: false, thread: ' t ', model: 'm', tier: 'big', schema: { type: 'object' } })`,
    { agent: runner, persistLogs: false },
  );
  assert.equal(result.result, "ran");
  assert.equal(calls.length, 1);
  const [{ prompt, options }] = calls;
  assert.equal(prompt, "work");
  assert.equal(options.label, "agent 1");
  assert.equal(options.thinking, "high");
  assert.match(options.sessionName ?? "", / thread:t$/);
  // The schema object comes from the VM realm, so compare its JSON rather than its prototype.
  assert.equal(JSON.stringify(options.schema), '{"type":"object"}');
});

test("isolation resolution accepts only contract values", () => {
  assert.equal(resolveIsolation(undefined, "worktree"), "worktree");
  assert.equal(resolveIsolation(undefined, undefined), undefined);
  assert.equal(resolveIsolation(false, "worktree"), undefined);
  assert.equal(resolveIsolation("worktree", undefined), "worktree");
  assert.throws(
    () => resolveIsolation("none" as unknown as false, "worktree"),
    (error: unknown) => isValidationError(error),
  );
});

test("published option types are rendered from the rules the runtime enforces", () => {
  const byName = new Map(AGENT_OPTIONS.options.map((option) => [option.name, option]));
  assert.equal(byName.get("isolation")?.type, '"worktree" | false');
  assert.deepEqual(byName.get("isolation")?.accepts, { kind: "literal", values: ["worktree", false] });
  assert.equal(byName.get("thinking")?.type, THINKING_LEVELS.map((level) => `"${level}"`).join(" | "));
  assert.equal(byName.get("keepWorktree")?.type, "boolean");
  assert.deepEqual(AGENT_OPTIONS.positional, [AGENT_PROMPT]);
  assert.equal(AGENT_PROMPT.optional, false);
});
