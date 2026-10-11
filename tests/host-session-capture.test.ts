/**
 * The host session capture adapter: it reaches only the session bound to this
 * extension's own pi, wraps the host prototype only for the probe, and the
 * extension holds no host session once it shuts down or hands over.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  pauseStrandedWorkflowRuntime,
  takeWorkflowRuntime,
} from "../src/extension-reload.js";
import installExtension from "../src/pi-extension.js";
import { sessionEndpoints } from "../src/task-panel/delivery-endpoints.js";
import {
  captureSessionSend,
  DELIVERY_PROBE_CUSTOM_TYPE,
  useHostSessionClass,
} from "../src/task-panel/host-session-capture.js";
import { _resetDeliveryRegistriesForTests } from "../src/task-panel.js";
import type { ManagedRun } from "../src/workflow-manager.js";
import { FakeHostSession, type HostMessage, sendMessageTo } from "./helpers/fake-host-session.js";

const probe: HostMessage = { customType: DELIVERY_PROBE_CUSTOM_TYPE, content: "", display: false };

function piBoundTo(session: FakeHostSession): ExtensionAPI {
  return { sendMessage: sendMessageTo(session) } as unknown as ExtensionAPI;
}

function sendDescriptor(target: object): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(target, "sendCustomMessage");
}

function result(deliveryId: string): HostMessage {
  return { customType: "workflow-result", content: "done", display: true, details: { deliveryId } };
}

beforeEach(() => {
  _resetDeliveryRegistriesForTests();
  discardWorkflowRuntime();
  useHostSessionClass(FakeHostSession);
});

afterEach(() => {
  _resetDeliveryRegistriesForTests();
  discardWorkflowRuntime();
});

describe("captureSessionSend", () => {
  it("captures the session its own pi is bound to and restores the host prototype", async () => {
    const before = sendDescriptor(FakeHostSession.prototype);
    const session = new FakeHostSession("bound");

    const send = captureSessionSend(piBoundTo(session), "bound");

    assert.ok(send, "the bound session is captured");
    assert.deepEqual(session.received, [], "the probe never reaches the session's real send");
    assert.deepEqual(sendDescriptor(FakeHostSession.prototype), before, "no hook remains after the probe");
    await send(result("delivery-1"), { triggerTurn: true, deliverAs: "followUp" });
    assert.deepEqual(
      session.received.map(({ message }) => message.details?.deliveryId),
      ["delivery-1"],
      "the captured send delivers into that session",
    );
  });

  it("never intercepts a session outside its own probe", () => {
    captureSessionSend(piBoundTo(new FakeHostSession("bound")), "bound");
    const other = new FakeHostSession("other");

    void other.sendCustomMessage(probe);

    assert.equal(other.received.length, 1, "a probe-typed message from elsewhere reaches the real send");
  });

  it("refuses a session that is not the one being bound", () => {
    assert.equal(captureSessionSend(piBoundTo(new FakeHostSession("other")), "bound"), undefined);
  });

  it("captures nothing through a stale pi and still restores the prototype", () => {
    const before = sendDescriptor(FakeHostSession.prototype);
    const stale = {
      sendMessage: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    } as unknown as ExtensionAPI;

    assert.equal(captureSessionSend(stale, "bound"), undefined);
    assert.deepEqual(sendDescriptor(FakeHostSession.prototype), before);
  });

  it("leaves no own property on a host class that inherits sendCustomMessage", () => {
    class InheritingHostSession extends FakeHostSession {}
    useHostSessionClass(InheritingHostSession);

    assert.ok(captureSessionSend(piBoundTo(new InheritingHostSession("bound")), "bound"));
    assert.equal(Object.hasOwn(InheritingHostSession.prototype, "sendCustomMessage"), false);
  });

  it("keeps a wrapper another party stacked during the probe working", () => {
    const session = new FakeHostSession("bound");
    const wrapped: string[] = [];
    const pi = {
      sendMessage: (message: HostMessage, options?: unknown) => {
        const inner = FakeHostSession.prototype.sendCustomMessage;
        FakeHostSession.prototype.sendCustomMessage = function outer(this: FakeHostSession, ...args) {
          wrapped.push(args[0].customType);
          return inner.apply(this, args);
        };
        sendMessageTo(session)(message, options);
      },
    } as unknown as ExtensionAPI;
    const original = sendDescriptor(FakeHostSession.prototype);

    try {
      assert.ok(captureSessionSend(pi, "bound"));
      void session.sendCustomMessage(probe);
      assert.deepEqual(wrapped, [DELIVERY_PROBE_CUSTOM_TYPE, DELIVERY_PROBE_CUSTOM_TYPE]);
      assert.equal(session.received.length, 1, "after the probe the stacked layer reaches the real send");
    } finally {
      if (original) Object.defineProperty(FakeHostSession.prototype, "sendCustomMessage", original);
    }
  });
});

// ─── Extension lifecycle ──────────────────────────────────────────────────────

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** One extension generation whose pi Pi has bound to `session`. */
function startGeneration(session: FakeHostSession) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    getCommands: () => [],
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getActiveTools: () => [],
    setActiveTools: () => {},
    sendMessage: sendMessageTo(session),
  } as unknown as ExtensionAPI;
  installExtension(pi);
  const emit = (event: string, payload: unknown, ctx?: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
  };
  return {
    start(reason: string) {
      emit(
        "session_start",
        { reason },
        {
          cwd: process.cwd(),
          model: undefined,
          modelRegistry: {},
          sessionManager: session.sessionManager,
          ui: { setWidget: () => {}, notify: () => {} },
        },
      );
    },
    shutdown: (reason: string) => emit("session_shutdown", { reason }),
  };
}

function deliveredResults(session: FakeHostSession) {
  return session.received.filter(({ message }) => message.customType === "workflow-result");
}

describe("extension lifecycle", () => {
  for (const deactivation of ["quit", "reload nobody claims"] as const) {
    it(`after ${deactivation}, holds no host session and never captures a later one`, () => {
      const prototype = sendDescriptor(FakeHostSession.prototype);
      const first = new FakeHostSession("first");
      const generation = startGeneration(first);
      generation.start("startup");
      assert.deepEqual([...sessionEndpoints.keys()], ["first"]);

      if (deactivation === "quit") {
        generation.shutdown("quit");
      } else {
        // The extension was disabled: no generation claims the handoff, so it
        // expires through the stranded path.
        generation.shutdown("reload");
        const staged = takeWorkflowRuntime();
        assert.ok(staged);
        pauseStrandedWorkflowRuntime(staged);
      }
      assert.equal(sessionEndpoints.size, 0, "the outgoing session is released");

      const later = ["second", "third", "fourth"].map((id) => new FakeHostSession(id));
      for (const session of later) {
        void session.sendCustomMessage(probe);
        void session.sendCustomMessage(result(`${session.sessionManager.getSessionId()}-result`));
      }

      assert.equal(sessionEndpoints.size, 0, "sessions that never loaded the extension are not captured");
      for (const session of later) assert.equal(session.received.length, 2, "their sends reach the real method");
      assert.deepEqual(sendDescriptor(FakeHostSession.prototype), prototype, "no hook is left installed");
    });
  }

  it("hands over across /reload and /new without stacking hooks or holding old sessions", async () => {
    const prototype = sendDescriptor(FakeHostSession.prototype);
    const original = new FakeHostSession("original");
    const first = startGeneration(original);
    first.start("startup");

    first.shutdown("reload");
    const staged = takeWorkflowRuntime();
    assert.ok(staged, "the live manager is staged for the next generation");
    handoffWorkflowRuntime(staged);
    const reloaded = startGeneration(original);
    reloaded.start("reload");
    assert.equal(takeWorkflowRuntime(), undefined, "the reloaded generation claimed the runtime");
    assert.deepEqual([...sessionEndpoints.keys()], ["original"]);
    assert.deepEqual(sendDescriptor(FakeHostSession.prototype), prototype, "neither generation left a hook");

    const run = {
      runId: "reload-run",
      sessionId: "original",
      status: "completed",
      snapshot: { name: "reload-handoff", agentCount: 1 },
      result: { agentCount: 1, result: { verdict: "delivered after reload" } },
    } as unknown as ManagedRun;
    const manager = staged.manager;
    const getRun = manager.getRun.bind(manager);
    manager.getRun = (runId: string) => (runId === run.runId ? run : getRun(runId));
    manager.emit("complete", { runId: run.runId });
    await tick();
    await tick();

    const delivered = deliveredResults(original);
    assert.equal(delivered.length, 1, "the result reaches the session that started the run");
    assert.match(delivered[0]?.message.content ?? "", /delivered after reload/);
    assert.deepEqual(delivered[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.equal(run.pendingDelivery, undefined, "the confirmed delivery clears its marker");

    // Each /new binds a fresh session; the previous one is let go, so nothing grows.
    let current = reloaded;
    for (const id of ["new-1", "new-2", "new-3"]) {
      current.shutdown("new");
      current = startGeneration(new FakeHostSession(id));
      current.start("new");
      assert.deepEqual([...sessionEndpoints.keys()], [id]);
    }
    assert.deepEqual(sendDescriptor(FakeHostSession.prototype), prototype);
    current.shutdown("quit");
    assert.equal(sessionEndpoints.size, 0);
  });
});
