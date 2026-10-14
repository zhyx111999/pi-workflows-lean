/**
 * Result delivery against a real Pi AgentSession (the installed SDK, a faux
 * model, a persisted session file): a result that completes while the parent is
 * generating waits, then goes in at the end of the run. No live model is used.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { _resetDeliveryRegistriesForTests, bindSessionDelivery, installResultDelivery } from "../src/task-panel.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { withRealSession } from "./helpers/real-session.js";

type Gate = { entered: Promise<void>; release: () => void };

/** A model reply that stays in flight until released, which keeps the parent busy. */
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

function flowScript(name: string): string {
  return `export const meta = { name: '${name}', description: 'queued delivery test' }
const result = await agent('${name}')
return { verdict: 'RESULT_OF_${name}' }`;
}

/** Background runs whose single agent call finishes only when the test says so. */
function controlledRuns(cwd: string) {
  const finish = new Map<string, () => void>();
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
      manager.startInBackground(flowScript(name));
    },
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

/** What the session's current branch says happened, in order. */
function transcript(session: AgentSession): string[] {
  return session.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type === "custom_message") {
      const content = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
      return [`result:${/RESULT_OF_\w+/.exec(content)?.[0] ?? content}`];
    }
    if (entry.type !== "message" || entry.message.role === "system") return [];
    const message = entry.message as { role: string; content: unknown };
    const text = Array.isArray(message.content)
      ? message.content.map((block: { text?: string }) => block.text ?? "").join("")
      : String(message.content);
    return [`${message.role}:${text}`];
  });
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

describe("result delivery against a real AgentSession", () => {
  let cwd: string;
  let warnings: string[];

  beforeEach(() => {
    _resetDeliveryRegistriesForTests();
    cwd = mkdtempSync(join(tmpdir(), "pi-dw-queued-delivery-"));
    warnings = [];
  });

  afterEach(() => {
    _resetDeliveryRegistriesForTests();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("waits while the parent is generating, then inserts at the end of that run without interrupting it", async () => {
    const runs = controlledRuns(cwd);
    const first = heldReply("first reply");
    const events: string[] = [];

    const contexts = await withRealSession(
      {
        persist: true,
        extensionFactories: [deliveryExtension(runs.manager, warnings)],
        responses: [first.step, reply("handled")],
      },
      async ({ session }) => {
        await session.bindExtensions({});
        session.subscribe((event) => events.push(event.type));
        runs.start("alpha");

        const prompt = session.prompt("hello");
        await first.entered;
        assert.equal(session.isStreaming, true, "the parent is generating");

        await runs.complete("alpha");
        const [run] = runs.manager.listLiveRuns();
        assert.ok(run.pendingDelivery, "the result is queued as a durable marker");
        assert.ok(pendingMarker(runs.manager, run.runId), "and the marker is on disk");
        assert.deepEqual(transcript(session), ["user:hello"], "nothing is inserted mid-response");
        assert.equal(session.agent.hasQueuedMessages(), false, "nothing sits in Pi's follow-up queue");

        first.release();
        await prompt;

        assert.deepEqual(transcript(session), [
          "user:hello",
          "assistant:first reply",
          "result:RESULT_OF_alpha",
          "assistant:handled",
        ]);
        // Pi continues a boundary insertion as part of the same run: it settles once, after the answer.
        assert.equal(events.filter((type) => type === "agent_settled").length, 1, "the run settles once");
        assert.ok(
          events.indexOf("entry_appended") < events.indexOf("agent_settled"),
          "the result is appended before the run settles",
        );
        assert.equal(pendingMarker(runs.manager, run.runId), undefined, "the persisted result clears its marker");
        assert.equal(run.pendingDelivery, undefined);
      },
    );

    assert.equal(contexts.length, 2, "one request for the reply, one that answers the result");
    assert.doesNotMatch(JSON.stringify(contexts[0]), /RESULT_OF_alpha/, "the reply in flight never saw the result");
    assert.match(JSON.stringify(contexts[1]), /RESULT_OF_alpha/, "the next request carries it");
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

  it("delivers a result that waited through an aborted run as soon as the host is idle", async () => {
    const runs = controlledRuns(cwd);
    const first = heldReply("first reply");
    const events: Array<{ type: string; aborted?: boolean }> = [];

    const contexts = await withRealSession(
      {
        persist: true,
        extensionFactories: [deliveryExtension(runs.manager, warnings)],
        responses: [first.step, reply("handled after abort")],
      },
      async ({ session }) => {
        await session.bindExtensions({});
        session.subscribe((event) =>
          events.push({ type: event.type, aborted: (event as { aborted?: boolean }).aborted }),
        );
        runs.start("alpha");

        const prompt = session.prompt("hello").catch(() => {});
        await first.entered;
        await runs.complete("alpha");

        const aborting = session.abort();
        first.release();
        await aborting;
        await prompt;

        // No boundary runs for an aborted run: the idle signal delivers, with no further user input.
        await until(() => transcript(session).includes("assistant:handled after abort"), "the delivered result's turn");
        const [run] = runs.manager.listLiveRuns();
        await until(() => run.pendingDelivery === undefined, "the marker to clear");

        const delivered = transcript(session).filter((line) => line.startsWith("result:"));
        assert.deepEqual(delivered, ["result:RESULT_OF_alpha"]);
        const settled = events.find((event) => event.type === "agent_settled");
        assert.equal(settled?.aborted, true);
      },
    );

    assert.equal(contexts.length, 2);
    assert.match(JSON.stringify(contexts[1]), /RESULT_OF_alpha/);
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
        const file = readFileSync(session.sessionManager.getSessionFile() as string, "utf8");
        assert.equal(file.split("\n").filter((line) => line.includes('"workflow-result"')).length, 1);
      },
    );

    assert.equal(contexts.length, 2);
    assert.deepEqual(warnings, []);
  });
});
