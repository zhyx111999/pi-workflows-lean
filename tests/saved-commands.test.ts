import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeCommandRegistryPi, makeNotifyCtx } from "./helpers/mock-pi.js";

async function load() {
  return import("../src/saved-commands.js");
}

/** A manager whose startInBackground records the script and never finishes. */
function recordingManager(runId = "r1") {
  const started: string[] = [];
  const manager = {
    startInBackground: (script: string) => {
      started.push(script);
      return { runId, promise: new Promise(() => {}) };
    },
  };
  return { started, getManager: () => manager as never };
}

describe("parseCommandArgs", () => {
  it("parses key=value pairs", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar count=42");
    assert.equal(result.foo, "bar");
    assert.equal(result.count, "42");
  });

  it("collects positional args into _", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello world");
    assert.equal(result._, "hello world");
  });

  it("handles mixed positional and key=value", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("task=test hello world");
    assert.equal(result.task, "test");
    assert.equal(result._, "hello world");
  });

  it("sets _raw to the trimmed input", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("  foo=bar  ");
    assert.equal(result._raw, "foo=bar");
  });

  it("returns empty when input is empty", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("");
    assert.equal(result._, "");
    assert.equal(result._raw, "");
  });

  it("fills parameter defaults for missing keys", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("foo=bar", {
      foo: {},
      limit: { default: 10 },
      label: { default: "test" },
    });
    assert.equal(result.foo, "bar");
    assert.equal(result.limit, 10);
    assert.equal(result.label, "test");
  });

  it("does NOT override explicit values with defaults", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("limit=5", { limit: { default: 10 } });
    assert.equal(result.limit, "5");
  });

  it("handles value-only token as positional", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("hello key=value world");
    assert.equal(result._, "hello world");
    assert.equal(result.key, "value");
  });

  it("handles URLs as positional arguments", async () => {
    const { parseCommandArgs } = await load();
    const result = parseCommandArgs("https://example.com");
    assert.equal(result._, "https://example.com");
  });
});

describe("registerSavedWorkflow", () => {
  it("registers a command with the workflow name", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const wf = {
      name: "test-workflow",
      script: "export const meta = { name: 't', description: 't' };",
      description: "A test",
    };

    registerSavedWorkflow(pi, wf, recordingManager().getManager, () => wf);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "test-workflow");
  });

  it("is idempotent — second registration is skipped", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands } = makeCommandRegistryPi(["test-workflow"]);
    const wf = {
      name: "test-workflow",
      description: "t",
      script: "export const meta = { name: 't', description: 't' };",
    };

    registerSavedWorkflow(pi, wf, recordingManager().getManager, () => wf);
    assert.equal(commands.length, 0, "should not re-register when already present");
  });

  it("registers multiple saved workflows", async () => {
    const { registerAllSavedWorkflows } = await load();
    const { pi, commands } = makeCommandRegistryPi();
    const storage = {
      list: () => [
        { name: "wf1", script: "export..." },
        { name: "wf2", script: "export..." },
      ],
    };

    registerAllSavedWorkflows(pi, () => storage as never, recordingManager().getManager);
    assert.deepEqual(
      commands.map((c) => c.name),
      ["wf1", "wf2"],
    );
  });

  it("starts a background run — without blocking or duplicating delivery", async () => {
    const { registerSavedWorkflow } = await load();
    // The run never finishes: if the handler awaited it, this test would hang.
    const { started, getManager } = recordingManager("test-run");

    const { pi, commands, sent } = makeCommandRegistryPi();
    const wf = { name: "run-via-manager", description: "t", script: "export SOURCE" };
    registerSavedWorkflow(pi, wf, getManager, () => wf);

    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.deepEqual(started, ["export SOURCE"]);
    // Result delivery for managed background runs is installResultDelivery's job;
    // the handler sending its own copy too was the double-delivery bug.
    assert.equal(sent.length, 0, "handler must not send its own result message on the manager path");
    assert.equal(notified.length, 1);
    assert.equal(notified[0].type, "info");
    assert.ok(notified[0].message.includes("test-run"), "start notice should include the run id");
  });

  it("re-loads the workflow by name at invocation so a project switch picks up the target script", async () => {
    const { registerSavedWorkflow } = await load();
    const { started, getManager } = recordingManager();
    const { pi, commands } = makeCommandRegistryPi();
    const source = { name: "same", script: "export SOURCE_A", description: "a" };
    let current: typeof source | null = source;
    registerSavedWorkflow(pi, source, getManager, () => current);

    const { ctx } = makeNotifyCtx();
    // Project switch: same command name now resolves to the target project's script.
    current = { name: "same", script: "export TARGET_B", description: "b" };
    await commands[0].handler("", ctx);
    assert.deepEqual(
      started,
      ["export TARGET_B"],
      "must execute the live storage script, not the registration snapshot",
    );
  });

  it("notifies and does not run when the live loader returns null after a project switch", async () => {
    const { registerSavedWorkflow } = await load();
    const { started, getManager } = recordingManager();
    const { pi, commands, sent } = makeCommandRegistryPi();
    const sourceOnly = { name: "source-only", script: "export A", description: "a" };
    registerSavedWorkflow(pi, sourceOnly, getManager, () => null);
    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);
    assert.deepEqual(started, []);
    assert.equal(sent.length, 0);
    assert.match(notified[0]?.message ?? "", /not available/i);
  });

  it("a deleted workflow's lingering command notifies and does not run", async () => {
    const { registerSavedWorkflow } = await load();
    const { pi, commands, sent } = makeCommandRegistryPi();

    const wf = {
      name: "gone",
      description: "t",
      script: "export const meta = { name: 't', description: 't' };\nreturn 1;",
    };
    // The loader finds nothing: the workflow has been deleted from storage.
    registerSavedWorkflow(pi, wf, recordingManager().getManager, () => null);

    const { ctx, notified } = makeNotifyCtx();
    await commands[0].handler("", ctx);

    assert.equal(sent.length, 0, "a deleted workflow should not run or deliver a result");
    assert.equal(notified.length, 1, "the user should be told the command is stale");
    assert.match(notified[0].message, /not available|deleted/i);
  });
});
