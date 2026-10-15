/**
 * Result delivery against a real Pi AgentSession (the installed SDK, a
 * controlled provider that can stop a response mid-stream, a persisted session
 * file): a result that completes while the parent is generating or running tools
 * waits, then enters the conversation when the model's current response and its
 * tool calls are complete, so the agent loop's next request already carries it
 * and nothing waits for the loop to finish. No live model is used.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  defineTool,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discardWorkflowRuntime, handoffWorkflowRuntime, WORKFLOW_EXTENSION_BUILD } from "../src/extension-reload.js";
import installExtension from "../src/pi-extension.js";
import { _resetDeliveryRegistriesForTests, bindSessionDelivery, installResultDelivery } from "../src/task-panel.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { type RealSession, streamHold, withRealSession } from "./helpers/real-session.js";

type Gate = { entered: Promise<void>; release: () => void };

/** A model reply that stays in flight until released, before it starts streaming. */
function heldReply(text: string): { step: FauxResponseFactory } & Gate {
  let release!: () => void;
  let enter!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    entered,
    release,
    step: async () => {
      enter();
      await open;
      return fauxAssistantMessage(text, { stopReason: "stop" });
    },
  };
}

const reply = (text: string) => fauxAssistantMessage(text, { stopReason: "stop" });
const toolTurn = (name: string) => fauxAssistantMessage([fauxToolCall(name, {})], { stopReason: "toolUse" });

/** A tool that finishes at once. */
function instantTool(name: string): ToolDefinition {
  return defineTool({
    name,
    label: name,
    description: `${name} finishes at once`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "tool output" }], details: undefined }),
  });
}

/** A tool that runs until released, or until the run is aborted. */
function gatedTool(name: string): { tool: ToolDefinition } & Gate {
  let release!: () => void;
  let enter!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const tool = defineTool({
    name,
    label: name,
    description: `${name} runs until released`,
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      enter();
      await Promise.race([
        open,
        new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })),
      ]);
      return {
        content: [{ type: "text", text: signal?.aborted ? "tool aborted" : "tool output" }],
        details: undefined,
      };
    },
  });
  return { tool, entered, release };
}

function flowScript(name: string): string {
  return `export const meta = { name: '${name}', description: 'queued delivery test' }
const result = await agent('${name}')
return { verdict: 'RESULT_OF_${name}' }`;
}

/** Background runs whose single agent call finishes only when the test says so. */
function controlledRuns(cwd: string) {
  const finish = new Map<string, () => void>();
  const runIds = new Map<string, string>();
  const manager = new WorkflowManager({
    cwd,
    agent: {
      run: (prompt: string) =>
        new Promise<unknown>((resolve) => {
          finish.set(prompt, () => resolve("done"));
        }),
    },
  });
  return {
    manager,
    start(name: string) {
      runIds.set(name, manager.startInBackground(flowScript(name)).runId);
    },
    status: (name: string) => manager.getRun(runIds.get(name) ?? "")?.status,
    /** Finish the named run and wait until its completion has been routed. */
    async complete(name: string) {
      for (let i = 0; i < 200 && !finish.has(name); i++) await new Promise((resolve) => setTimeout(resolve, 2));
      const routed = once(manager, "complete");
      finish.get(name)?.();
      await routed;
    },
  };
}

/** Pi's extension for these tests: the same delivery wiring pi-extension.ts installs. */
function deliveryExtension(
  manager: WorkflowManager,
  warnings: string[],
  extra: (pi: Parameters<ExtensionFactory>[0]) => void = () => {},
): ExtensionFactory {
  return (pi) => {
    installResultDelivery(pi, manager);
    pi.on("session_start", (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      manager.setSessionId(sessionId, ctx.sessionManager.getSessionFile());
      bindSessionDelivery(sessionId, pi, {
        manager,
        sessionManager: ctx.sessionManager,
        reportWarning: (message) => warnings.push(message),
      });
    });
    extra(pi);
  };
}

type Block = { type?: string; text?: string; name?: string };

/** What the session's current branch says happened, in order. Other extensions' hidden messages are left out. */
function transcript(session: AgentSession): string[] {
  return session.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type === "custom_message") {
      if (entry.customType !== "workflow-result") return [];
      const content = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
      return [`result:${/RESULT_OF_\w+/.exec(content)?.[0] ?? content}`];
    }
    if (entry.type !== "message" || entry.message.role === "system") return [];
    const message = entry.message as { role: string; content: unknown };
    const text = Array.isArray(message.content)
      ? (message.content as Block[])
          .map((block) => (block.type === "toolCall" ? `<call ${block.name}>` : (block.text ?? "")))
          .join("")
      : String(message.content);
    return [`${message.role}:${text}`];
  });
}

/** What the model was shown last time it was asked: roles, in order, with a tag where the result sits. */
function shownToModel(real: RealSession, request: number): string[] {
  return real.contexts[request].messages
    .filter((message) => message.role !== "system")
    .map((message) => (JSON.stringify(message).includes("RESULT_OF_") ? `${message.role}*result` : message.role));
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const pendingMarker = (manager: WorkflowManager, runId: string) =>
  manager.getPersistence().loadPreview(runId)?.pendingDelivery;

const resultEntriesInFile = (session: AgentSession) =>
  readFileSync(session.sessionManager.getSessionFile() as string, "utf8")
    .split("\n")
    .filter((line) => line.includes('"workflow-result"')).length;

/** Records the order in which Pi's lifecycle happens, with the number of model requests made so far at each insertion. */
function timelineOf(real: RealSession, log: string[]): void {
  real.session.subscribe((event) => {
    log.push(event.type === "entry_appended" ? `entry_appended(requests=${real.contexts.length})` : event.type);
  });
}

describe("result delivery against a real AgentSession", () => {
  let cwd: string;
  let warnings: string[];
  let log: string[];
  const beforeSettle = (pi: Parameters<ExtensionFactory>[0]) => {
    pi.on("agent_before_settle", () => {
      log.push("agent_before_settle");
    });
  };

  beforeEach(() => {
    _resetDeliveryRegistriesForTests();
    cwd = mkdtempSync(join(tmpdir(), "pi-dw-queued-delivery-"));
    warnings = [];
    log = [];
  });

  afterEach(() => {
    _resetDeliveryRegistriesForTests();
    discardWorkflowRuntime();
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("when the response that finishes is the last one", () => {
    it("queues while the model streams, enters the moment that response ends, and gets one request that answers it", async () => {
      const runs = controlledRuns(cwd);
      const hold = streamHold();

      const contexts = await withRealSession(
        {
          persist: true,
          extensionFactories: [deliveryExtension(runs.manager, warnings, beforeSettle)],
          responses: [reply("first reply, streamed"), reply("handled")],
          holds: { 0: hold },
        },
        async (real) => {
          const { session } = real;
          await session.bindExtensions({});
          timelineOf(real, log);
          runs.start("alpha");

          const prompt = session.prompt("hello");
          await hold.reached;
          await until(() => session.agent.state.streamingMessage !== undefined, "the response to be streaming");

          await runs.complete("alpha");
          const [run] = runs.manager.listLiveRuns();
          assert.ok(run.pendingDelivery, "the result is queued as a durable marker");
          assert.ok(pendingMarker(runs.manager, run.runId), "and the marker is on disk");
          assert.deepEqual(transcript(session), ["user:hello"], "nothing is inserted into the streaming response");
          assert.equal(session.agent.hasQueuedMessages(), false, "nothing sits in Pi's steering or follow-up queue");

          hold.release();
          await prompt;

          assert.deepEqual(transcript(session), [
            "user:hello",
            "assistant:first reply, streamed",
            "result:RESULT_OF_alpha",
            "assistant:handled",
          ]);
          assert.equal(pendingMarker(runs.manager, run.runId), undefined, "the persisted result clears its marker");
          assert.equal(run.pendingDelivery, undefined);
          assert.equal(resultEntriesInFile(session), 1);
          assert.deepEqual(shownToModel(real, 1), ["user", "assistant", "user*result"]);
        },
      );

      // One agent loop: the result entered after the first request and before the loop ended or settled.
      assert.equal(log.filter((type) => type === "agent_start").length, 1);
      const at = (type: string) => log.indexOf(type);
      assert.ok(at("entry_appended(requests=1)") !== -1, "inserted after the first request, before a second was made");
      assert.ok(at("entry_appended(requests=1)") < at("agent_end"), "without waiting for the loop to end");
      assert.ok(at("agent_end") < at("agent_before_settle"), "let alone the settle boundary");
      assert.equal(log.filter((type) => type === "agent_settled").length, 1, "the run settles once, after the answer");

      assert.equal(contexts.length, 2, "one request for the reply, one that answers the result");
      assert.doesNotMatch(JSON.stringify(contexts[0]), /RESULT_OF_alpha/, "the reply in flight never saw the result");
      assert.match(JSON.stringify(contexts[1]), /RESULT_OF_alpha/);
      assert.equal(contexts[1].messages.at(-1)?.role, "user", "as the last message the model must answer");
      assert.deepEqual(warnings, []);
    });

    it("inserts two results oldest first, together, without interleaving the parent's replies", async () => {
      const runs = controlledRuns(cwd);
      const first = heldReply("first reply");

      const contexts = await withRealSession(
        {
          persist: true,
          extensionFactories: [deliveryExtension(runs.manager, warnings)],
          responses: [first.step, reply("handled both")],
        },
        async ({ session }) => {
          await session.bindExtensions({});
          runs.start("alpha");
          runs.start("beta");

          const prompt = session.prompt("hello");
          await first.entered;
          // Completion order is the reverse of start order, which is what the live-run list reports.
          await runs.complete("beta");
          await runs.complete("alpha");
          first.release();
          await prompt;

          assert.deepEqual(transcript(session), [
            "user:hello",
            "assistant:first reply",
            "result:RESULT_OF_beta",
            "result:RESULT_OF_alpha",
            "assistant:handled both",
          ]);
          assert.deepEqual(
            runs.manager.listLiveRuns().map((run) => run.pendingDelivery),
            [undefined, undefined],
          );
        },
      );

      assert.equal(contexts.length, 2, "both results are answered by one request");
      assert.deepEqual(warnings, []);
    });
  });

  describe("when the agent loop has more requests to make", () => {
    it("a result that arrives while the model streams a tool call is in the loop's very next request", async () => {
      const runs = controlledRuns(cwd);
      const hold = streamHold();

      const contexts = await withRealSession(
        {
          persist: true,
          customTools: [instantTool("probe")],
          tools: ["probe"],
          extensionFactories: [deliveryExtension(runs.manager, warnings, beforeSettle)],
          responses: [toolTurn("probe"), reply("final answer")],
          holds: { 0: hold },
        },
        async (real) => {
          const { session } = real;
          await session.bindExtensions({});
          timelineOf(real, log);
          runs.start("alpha");

          const prompt = session.prompt("hello");
          await hold.reached;
          await runs.complete("alpha");
          assert.deepEqual(transcript(session), ["user:hello"], "the streaming response is not interrupted");

          hold.release();
          await prompt;

          assert.deepEqual(transcript(session), [
            "user:hello",
            "assistant:<call probe>",
            "toolResult:tool output",
            "result:RESULT_OF_alpha",
            "assistant:final answer",
          ]);
          assert.deepEqual(
            shownToModel(real, 1),
            ["user", "assistant", "toolResult", "user*result"],
            "the result follows the tool result, never sits between a call and its result",
          );
        },
      );

      // The loop was not over: the first response ended with a tool call, so a second request was due anyway.
      assert.equal(log.filter((type) => type === "agent_start").length, 1);
      const inserted = log.indexOf("entry_appended(requests=1)");
      assert.ok(inserted !== -1, "inserted before the second request was made");
      assert.ok(inserted < log.indexOf("agent_end") && inserted < log.indexOf("agent_before_settle"));
      assert.equal(contexts.length, 2, "the next request answers both the tool result and the workflow result");
      assert.deepEqual(warnings, []);
    });

    it("a result that arrives while a tool runs enters right after the tool result, not between call and result", async () => {
      const runs = controlledRuns(cwd);
      const slow = gatedTool("slow");

      const contexts = await withRealSession(
        {
          persist: true,
          customTools: [slow.tool],
          tools: ["slow"],
          extensionFactories: [deliveryExtension(runs.manager, warnings, beforeSettle)],
          responses: [toolTurn("slow"), reply("final answer")],
        },
        async (real) => {
          const { session } = real;
          await session.bindExtensions({});
          timelineOf(real, log);
          runs.start("alpha");

          const prompt = session.prompt("hello");
          await slow.entered;
          assert.equal(session.agent.state.streamingMessage, undefined, "no response is streaming; a tool is running");

          await runs.complete("alpha");
          assert.deepEqual(
            transcript(session),
            ["user:hello", "assistant:<call slow>"],
            "the result waits for the tool: a call's result must follow the call directly",
          );
          const [run] = runs.manager.listLiveRuns();
          assert.ok(pendingMarker(runs.manager, run.runId), "it stays a durable marker meanwhile");

          slow.release();
          await prompt;

          assert.deepEqual(transcript(session), [
            "user:hello",
            "assistant:<call slow>",
            "toolResult:tool output",
            "result:RESULT_OF_alpha",
            "assistant:final answer",
          ]);
          assert.deepEqual(shownToModel(real, 1), ["user", "assistant", "toolResult", "user*result"]);
        },
      );

      assert.ok(log.indexOf("tool_execution_end") < log.indexOf("entry_appended(requests=1)"));
      assert.ok(log.indexOf("entry_appended(requests=1)") < log.indexOf("agent_end"));
      assert.equal(contexts.length, 2);
      assert.deepEqual(warnings, []);
    });

    it("results from during the stream and during the tool enter together, oldest first, before one request", async () => {
      const runs = controlledRuns(cwd);
      const hold = streamHold();
      const slow = gatedTool("slow");

      const contexts = await withRealSession(
        {
          persist: true,
          customTools: [slow.tool],
          tools: ["slow"],
          extensionFactories: [deliveryExtension(runs.manager, warnings)],
          responses: [toolTurn("slow"), reply("answered both")],
          holds: { 0: hold },
        },
        async ({ session }) => {
          await session.bindExtensions({});
          runs.start("alpha");
          runs.start("beta");
          runs.start("gamma");

          const prompt = session.prompt("hello");
          await hold.reached;
          await runs.complete("gamma"); // while the model streams
          hold.release();
          await slow.entered;
          await runs.complete("alpha"); // while the tool runs
          await runs.complete("beta");
          slow.release();
          await prompt;

          assert.deepEqual(transcript(session), [
            "user:hello",
            "assistant:<call slow>",
            "toolResult:tool output",
            "result:RESULT_OF_gamma",
            "result:RESULT_OF_alpha",
            "result:RESULT_OF_beta",
            "assistant:answered both",
          ]);
        },
      );

      assert.equal(contexts.length, 2);
      assert.deepEqual(warnings, []);
    });

    it("a result that arrives during a later response waits for that response and enters at its end", async () => {
      const runs = controlledRuns(cwd);
      const hold = streamHold();

      const contexts = await withRealSession(
        {
          persist: true,
          customTools: [instantTool("probe")],
          tools: ["probe"],
          extensionFactories: [deliveryExtension(runs.manager, warnings, beforeSettle)],
          responses: [toolTurn("probe"), reply("second reply"), reply("answered gamma")],
          holds: { 1: hold },
        },
        async (real) => {
          const { session } = real;
          await session.bindExtensions({});
          timelineOf(real, log);
          runs.start("gamma");

          const prompt = session.prompt("hello");
          await hold.reached;
          assert.equal(real.contexts.length, 2, "the loop is on its second request");
          await runs.complete("gamma");
          assert.deepEqual(
            transcript(real.session),
            ["user:hello", "assistant:<call probe>", "toolResult:tool output"],
            "the second response streams on undisturbed",
          );

          hold.release();
          await prompt;

          assert.deepEqual(transcript(session), [
            "user:hello",
            "assistant:<call probe>",
            "toolResult:tool output",
            "assistant:second reply",
            "result:RESULT_OF_gamma",
            "assistant:answered gamma",
          ]);
        },
      );

      assert.ok(log.indexOf("entry_appended(requests=2)") !== -1, "inserted when the second response ended");
      assert.equal(contexts.length, 3);
      assert.doesNotMatch(JSON.stringify(contexts[1]), /RESULT_OF_gamma/, "the response in flight never saw it");
      assert.match(JSON.stringify(contexts[2]), /RESULT_OF_gamma/);
      assert.deepEqual(warnings, []);
    });
  });

  describe("when the user stops the main model", () => {
    it("delivers a result that waited through an aborted response as soon as the host is idle", async () => {
      const runs = controlledRuns(cwd);
      const hold = streamHold();
      const events: Array<{ type: string; aborted?: boolean }> = [];

      const contexts = await withRealSession(
        {
          persist: true,
          extensionFactories: [deliveryExtension(runs.manager, warnings)],
          responses: [reply("first reply"), reply("handled after abort")],
          holds: { 0: hold },
        },
        async ({ session }) => {
          await session.bindExtensions({});
          session.subscribe((event) =>
            events.push({ type: event.type, aborted: (event as { aborted?: boolean }).aborted }),
          );
          runs.start("alpha");

          const prompt = session.prompt("hello").catch(() => {});
          await hold.reached;
          await runs.complete("alpha");

          const aborting = session.abort();
          hold.release();
          await aborting;
          await prompt;

          // An aborted turn cannot take the result: the idle signal delivers it, with no further user input.
          await until(
            () => transcript(session).includes("assistant:handled after abort"),
            "the delivered result's turn",
          );
          const [run] = runs.manager.listLiveRuns();
          await until(() => run.pendingDelivery === undefined, "the marker to clear");

          const delivered = transcript(session).filter((line) => line.startsWith("result:"));
          assert.deepEqual(delivered, ["result:RESULT_OF_alpha"]);
          assert.equal(resultEntriesInFile(session), 1);
          const settled = events.find((event) => event.type === "agent_settled");
          assert.equal(settled?.aborted, true);
        },
      );

      assert.equal(contexts.length, 2);
      assert.match(JSON.stringify(contexts[1]), /RESULT_OF_alpha/);
    });

    it("does not cancel the background run, and its later result goes straight to the idle host", async () => {
      const runs = controlledRuns(cwd);
      const hold = streamHold();

      const contexts = await withRealSession(
        {
          persist: true,
          extensionFactories: [deliveryExtension(runs.manager, warnings)],
          responses: [reply("first reply"), reply("handled after abort")],
          holds: { 0: hold },
        },
        async ({ session }) => {
          await session.bindExtensions({});
          runs.start("alpha");

          const prompt = session.prompt("hello").catch(() => {});
          await hold.reached;
          const aborting = session.abort();
          hold.release();
          await aborting;
          await prompt;

          assert.equal(runs.status("alpha"), "running", "Esc stops the main model, not the background run");
          assert.equal(session.isIdle, true);

          await runs.complete("alpha");
          await until(
            () => transcript(session).includes("assistant:handled after abort"),
            "the idle host to take the result",
          );
          assert.deepEqual(
            transcript(session).filter((line) => line.startsWith("result:")),
            ["result:RESULT_OF_alpha"],
          );
        },
      );

      assert.equal(contexts.length, 2);
    });

    it("hands nothing over at the turn a stopped tool ended, and delivers once the host is idle", async () => {
      const runs = controlledRuns(cwd);
      const slow = gatedTool("slow");

      const contexts = await withRealSession(
        {
          persist: true,
          customTools: [slow.tool],
          tools: ["slow"],
          extensionFactories: [deliveryExtension(runs.manager, warnings)],
          // The stopped run's next request ends at once with an error response, before the provider is asked.
          responses: [toolTurn("slow"), reply("handled after abort")],
        },
        async ({ session }) => {
          await session.bindExtensions({});
          runs.start("alpha");

          const prompt = session.prompt("hello").catch(() => {});
          await slow.entered;
          await runs.complete("alpha");

          await session.abort();
          await prompt;
          await until(
            () => transcript(session).includes("assistant:handled after abort"),
            "the delivered result's turn",
          );

          const lines = transcript(session);
          assert.ok(
            lines.indexOf("toolResult:tool aborted") < lines.indexOf("result:RESULT_OF_alpha"),
            "the result did not take the stopped turn's boundary: it followed the stopped run",
          );
          assert.equal(resultEntriesInFile(session), 1);
          assert.equal(session.agent.hasQueuedMessages(), false);
        },
      );

      assert.match(JSON.stringify(contexts.at(-1)), /RESULT_OF_alpha/);
    });
  });

  describe("when the session file must hold the result before its marker clears", () => {
    it("keeps the marker, and offers the result again at the next turn, when Pi drops the boundary's entries", async () => {
      const runs = controlledRuns(cwd);
      const hold = streamHold();
      let dropped = false;
      let markerAtAppend: unknown = "unchecked";
      let afterDroppedBoundary: { pending: boolean; entriesInFile: number } | undefined;

      const contexts = await withRealSession(
        {
          persist: true,
          customTools: [instantTool("probe")],
          tools: ["probe"],
          extensionFactories: [
            // Registered first, so its entries are among the ones our handler receives: an entry
            // that cannot be applied makes Pi throw the whole boundary away, ours included.
            (pi) => {
              pi.on("turn_end", () => {
                if (dropped) return;
                dropped = true;
                return { entries: [{ type: "context_edit", targetId: "no-such-entry", replacement: null }] };
              });
            },
            deliveryExtension(runs.manager, warnings),
          ],
          responses: [toolTurn("probe"), reply("second reply"), reply("handled")],
          holds: { 0: hold },
        },
        async (real) => {
          const { session } = real;
          await session.bindExtensions({});
          timelineOf(real, log);
          runs.start("alpha");
          let turns = 0;
          session.subscribe((event) => {
            if (event.type === "turn_end" && ++turns === 1) {
              afterDroppedBoundary = {
                pending: !!runs.manager.listLiveRuns()[0]?.pendingDelivery,
                entriesInFile: resultEntriesInFile(session),
              };
            }
            if (event.type === "entry_appended") {
              // The marker clears only after Pi has appended the entry and the file is checked.
              markerAtAppend = runs.manager.listLiveRuns()[0]?.pendingDelivery ? "pending" : "cleared";
            }
          });

          const prompt = session.prompt("hello");
          await hold.reached;
          await runs.complete("alpha");
          hold.release();
          await prompt;

          const [run] = runs.manager.listLiveRuns();
          assert.deepEqual(transcript(session), [
            "user:hello",
            "assistant:<call probe>",
            "toolResult:tool output",
            "assistant:second reply",
            "result:RESULT_OF_alpha",
            "assistant:handled",
          ]);
          assert.deepEqual(
            afterDroppedBoundary,
            { pending: true, entriesInFile: 0 },
            "the dropped boundary left the result pending, and the session file held nothing",
          );
          assert.equal(markerAtAppend, "pending", "the marker outlives the append until the file is confirmed");
          assert.equal(run.pendingDelivery, undefined);
          assert.equal(pendingMarker(runs.manager, run.runId), undefined);
          assert.equal(resultEntriesInFile(session), 1, "offered again, appended once");
        },
      );

      const offeredAgain = log.indexOf("entry_appended(requests=2)");
      assert.ok(offeredAgain !== -1, "appended when the second response ended");
      assert.ok(offeredAgain < log.indexOf("agent_end"), "by the loop's next boundary, not by the end of the run");
      assert.equal(contexts.length, 3);
      assert.doesNotMatch(JSON.stringify(contexts[1]), /RESULT_OF_alpha/);
      assert.match(JSON.stringify(contexts[2]), /RESULT_OF_alpha/);
      assert.deepEqual(warnings, [], "a missed boundary is not a delivery failure");
    });

    it("does not deadlock or duplicate a result that completes while Pi is still announcing the settle", async () => {
      const runs = controlledRuns(cwd);
      let hold: Promise<void> | undefined;
      let announcing!: () => void;
      const announced = new Promise<void>((resolve) => {
        announcing = resolve;
      });
      let openAnnouncement!: () => void;

      const contexts = await withRealSession(
        {
          persist: true,
          extensionFactories: [
            deliveryExtension(runs.manager, warnings, (pi) => {
              // Pi awaits every agent_settled handler before the run is over.
              pi.on("agent_settled", async () => {
                if (!hold) return;
                announcing();
                await hold;
              });
            }),
          ],
          responses: [reply("first reply"), reply("handled")],
        },
        async ({ session }) => {
          await session.bindExtensions({});
          runs.start("alpha");
          hold = new Promise<void>((resolve) => {
            openAnnouncement = resolve;
          });

          const prompt = session.prompt("hello");
          await announced;
          assert.equal(session.isStreaming, false, "the run is over; only its announcement is pending");
          await runs.complete("alpha");
          await new Promise((resolve) => setTimeout(resolve, 30));
          assert.equal(
            transcript(session).filter((line) => line.startsWith("result:")).length,
            0,
            "Pi defers a send made now until the announcement ends",
          );

          hold = undefined;
          openAnnouncement();
          await prompt;
          const [run] = runs.manager.listLiveRuns();
          await until(() => run.pendingDelivery === undefined, "the marker to clear");
          // A later retry must find the result already delivered and send nothing more.
          await new Promise((resolve) => setTimeout(resolve, 400));

          assert.deepEqual(transcript(session), [
            "user:hello",
            "assistant:first reply",
            "result:RESULT_OF_alpha",
            "assistant:handled",
          ]);
          assert.equal(resultEntriesInFile(session), 1);
        },
      );

      assert.equal(contexts.length, 2);
      assert.deepEqual(warnings, []);
    });
  });

  describe("with the extension exactly as Pi loads it", () => {
    it("delivers a result that arrived mid-response into the loop's next request, with no wiring of the test's own", async () => {
      const runs = controlledRuns(cwd);
      // The shipped factory claims the staged manager, as it does across a /reload.
      handoffWorkflowRuntime({ cwd, extensionBuild: WORKFLOW_EXTENSION_BUILD, manager: runs.manager });
      const hold = streamHold();

      const contexts = await withRealSession(
        {
          root: cwd,
          persist: true,
          customTools: [instantTool("probe")],
          tools: ["probe"],
          extensionFactories: [installExtension, beforeSettle],
          responses: [toolTurn("probe"), reply("final answer")],
          holds: { 0: hold },
        },
        async (real) => {
          const { session } = real;
          await session.bindExtensions({});
          timelineOf(real, log);
          runs.start("alpha");

          const prompt = session.prompt("hello");
          await hold.reached;
          await runs.complete("alpha");
          assert.deepEqual(transcript(session), ["user:hello"], "queued while the model streams");

          hold.release();
          await prompt;

          assert.deepEqual(transcript(session), [
            "user:hello",
            "assistant:<call probe>",
            "toolResult:tool output",
            "result:RESULT_OF_alpha",
            "assistant:final answer",
          ]);
          assert.equal(resultEntriesInFile(session), 1);
          assert.equal(runs.manager.listLiveRuns()[0]?.pendingDelivery, undefined);
        },
      );

      assert.ok(log.indexOf("entry_appended(requests=1)") < log.indexOf("agent_end"));
      assert.ok(log.indexOf("agent_end") < log.indexOf("agent_before_settle"));
      assert.equal(contexts.length, 2);
      assert.match(JSON.stringify(contexts[1]), /RESULT_OF_alpha/);
    });
  });
});
