import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { WorkflowAgent } from "../src/agent.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { fauxRegistry } from "./helpers/faux-registry.js";

/** Run one subagent turn and return the tool names its provider request offered. */
async function offeredTools(policy: { toolNames?: string[]; disallowedToolNames?: string[] }): Promise<string[]> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-tool-policy-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tool-policy-cwd-"));
  const provider = "fauxtest-tool-policy";
  const core = createFauxCore({
    provider,
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    return await withFakeHomeAsync(home, async () => {
      const registry = await fauxRegistry(home, provider, core);
      let names: string[] = [];
      core.setResponses([
        (context) => {
          names = (context.tools ?? []).map((tool) => tool.name).sort();
          return fauxAssistantMessage("done", { stopReason: "stop" });
        },
      ]);
      const agent = new WorkflowAgent({ cwd, modelRegistry: registry });
      await agent.run("list your tools", { model: `${provider}/faux-model`, ...policy });
      return names;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("an agent type's allowlist is the whole tool set the provider sees", async () => {
  assert.deepEqual(await offeredTools({ toolNames: ["read"] }), ["read"]);
});

test("an agent type's denylist also removes Pi's built-in tool of that name", async () => {
  assert.deepEqual(await offeredTools({ disallowedToolNames: ["bash", "write"] }), ["edit", "read"]);
});

test("without a policy the subagent gets exactly the coding tools bound to its cwd", async () => {
  assert.deepEqual(await offeredTools({}), ["bash", "edit", "read", "write"]);
});
