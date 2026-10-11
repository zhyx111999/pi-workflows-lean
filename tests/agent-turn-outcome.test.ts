/**
 * How a real subagent session's turn ends: a provider error is never a
 * successful answer, and teardown never decides the turn's outcome. These
 * drive the real WorkflowAgent.run → createAgentSession path on a scripted
 * faux provider (no network).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { WorkflowAgent } from "../src/agent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { fauxRegistry } from "./helpers/faux-registry.js";

const PROVIDER = "fauxtest-turn-outcome";
const MODEL = `${PROVIDER}/faux-model`;

type FauxCore = ReturnType<typeof createFauxCore>;

async function withFauxAgent(
  fn: (ctx: { agent: WorkflowAgent; core: FauxCore; cwd: string }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-turn-outcome-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-turn-outcome-cwd-"));
  const core = createFauxCore({
    provider: PROVIDER,
    models: [{ id: "faux-model", name: "Faux Model", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, async () => {
      const agent = new WorkflowAgent({ cwd, modelRegistry: await fauxRegistry(home, PROVIDER, core) });
      await fn({ agent, core, cwd });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** A dropped stream: the SDK keeps the partial text and ends the turn in an error instead of throwing. */
function droppedStream(partial: string) {
  return fauxAssistantMessage(partial, { stopReason: "error", errorMessage: "socket disconnected" });
}

function countDisposals(t: TestContext): () => number {
  const dispose = t.mock.method(AgentSession.prototype, "dispose");
  return () => dispose.mock.callCount();
}

const throwingUnregister = () => () => {
  throw new Error("unregister blew up");
};

test("a turn that ends in a provider error rejects as recoverable instead of returning its partial answer", () =>
  withFauxAgent(async ({ agent, core }) => {
    core.setResponses([droppedStream("half an ans")]);
    await assert.rejects(agent.run("task", { model: MODEL, label: "dropped" }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
      assert.equal(error.recoverable, true);
      assert.equal(error.message, "socket disconnected");
      assert.equal(error.agentLabel, "dropped");
      return true;
    });
  }));

test("runWorkflow retries a turn that ended in a provider error and journals only the complete answer", () =>
  withFauxAgent(async ({ agent, core, cwd }) => {
    core.setResponses([droppedStream("half an ans"), fauxAssistantMessage("the complete answer")]);
    const journal: JournalEntry[] = [];
    const run = await runWorkflow(
      `export const meta = { name: "dropped_stream_retry", description: "one agent" }
return await agent("task", { label: "worker", model: ${JSON.stringify(MODEL)} });`,
      {
        cwd,
        agent,
        agentRetries: 1,
        agentRetryBackoffMs: () => 0,
        onAgentJournal: (entry) => journal.push(entry),
      },
    );
    assert.equal(run.result, "the complete answer");
    assert.deepEqual(
      journal.map((entry) => entry.result),
      ["the complete answer"],
    );
  }));

test("a throwing steer unregister neither skips disposal nor replaces the turn's result", (t) =>
  withFauxAgent(async ({ agent, core }) => {
    const disposals = countDisposals(t);
    core.setResponses([fauxAssistantMessage("the answer")]);
    const result = await agent.run("task", { model: MODEL, registerSteer: throwingUnregister });
    assert.equal(result, "the answer");
    assert.equal(disposals(), 1);
  }));

test("a throwing steer unregister neither skips disposal, thread rollback, nor replaces the turn's error", (t) =>
  withFauxAgent(async ({ agent, core }) => {
    const disposals = countDisposals(t);
    const followUpContexts: string[] = [];
    core.setResponses([
      fauxAssistantMessage(""),
      (context) => {
        followUpContexts.push(JSON.stringify(context));
        return fauxAssistantMessage("followed up");
      },
    ]);
    const options = { model: MODEL, thread: "worker", registerSteer: throwingUnregister };

    await assert.rejects(agent.run("FAILED_TURN_MARKER", options), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.AGENT_EMPTY_OUTPUT);
      return true;
    });
    assert.equal(disposals(), 1);

    assert.equal(await agent.run("FOLLOWUP_TURN_MARKER", options), "followed up");
    assert.doesNotMatch(followUpContexts[0], /FAILED_TURN_MARKER/, "the failed turn was rolled back");
    assert.equal(disposals(), 2);
  }));
