/**
 * Queued result delivery against a host double that plays Pi's events: results
 * wait while the host is busy, go in at the turn_end boundary oldest first, and
 * stay durable and deduplicated through cancellation, rebinds, session
 * switches, and retries. The real-session ordering is in queued-delivery.test.ts.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { _useHostSessionClassForTests } from "../src/task-panel/host-session-capture.js";
import {
  _resetDeliveryRegistriesForTests,
  bindSessionDelivery,
  dropSessionDelivery,
  installResultDelivery,
  suspendSessionDelivery,
} from "../src/task-panel.js";
import { type DeliveryManagerDouble, deliveryManager } from "./helpers/delivery-manager.js";
import { FakeHostSession, type HostMessage, sendMessageTo } from "./helpers/fake-host-session.js";

const SESSION = "boundary-session";

type Draft = { type: string; customType: string; content: string; display: boolean; details?: { deliveryId?: string } };
type BoundaryOutcome = { entries: Draft[]; continue: boolean } | undefined;
type TurnOptions = {
  /** The turn's outcome as Pi reports it. */
  outcome?: "completed" | "aborted" | "error";
  /** The run's signal has been aborted, as when Esc interrupts the tools the turn ran. */
  cancelling?: boolean;
  /** Pi throws the boundary's entries away, as when another extension's entries are invalid. */
  piDropsEntries?: boolean;
};

/** An ExtensionAPI whose handlers can be fired, and whose sendMessage reaches `session` as Pi's does. */
function extensionApi(session: FakeHostSession) {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  let stale = false;
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: (message: HostMessage, options?: unknown) => {
      if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
      sendMessageTo(session)(message, options);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    handlerCount: (event: string) => handlers.get(event)?.length ?? 0,
    /** Pi stops serving this instance once its session is replaced. */
    goStale: () => {
      stale = true;
    },
    fire: (event: string, payload: unknown, ctx: unknown): unknown => {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) result = handler(payload, ctx) ?? result;
      return result;
    },
  };
}

/** One bound session: a host double, its extension, and a manager that owns the runs. */
function startSession(sessionId = SESSION, manager?: DeliveryManagerDouble) {
  const session = new FakeHostSession(sessionId);
  const api = extensionApi(session);
  const owner = manager ?? deliveryManager(sessionId);
  const warnings: string[] = [];
  installResultDelivery(api.pi, owner.manager);
  owner.manager.setSessionId(sessionId);
  bindSessionDelivery(sessionId, api.pi, { manager: owner.manager, reportWarning: (m) => warnings.push(m) });

  const busy = () => {
    session.isStreaming = true;
    session.isIdle = false;
  };
  const settle = async (aborted = false) => {
    session.isStreaming = false;
    session.isIdle = true;
    session.emit({ type: "agent_settled", aborted } as never);
    await tick();
  };
  /** The handlers' view of one turn's end, before Pi appends anything. */
  const fireTurnEnd = ({ outcome = "completed", cancelling = false }: TurnOptions = {}) =>
    api.fire(
      "turn_end",
      { type: "turn_end", outcome, entries: [], continue: false },
      { sessionManager: session.sessionManager, signal: cancelling ? { aborted: true } : undefined },
    ) as BoundaryOutcome;
  /** Pi's turn_end boundary: every handler sees the chosen entries, Pi appends what comes back, then announces the turn's end. */
  const turnEnd = async (options: TurnOptions = {}): Promise<BoundaryOutcome> => {
    const outcome = fireTurnEnd(options);
    if (!options.piDropsEntries) {
      for (const entry of outcome?.entries ?? []) {
        if (entry.type === "custom_message") session.append(entry);
      }
    }
    session.emit({ type: "turn_end" });
    await tick();
    return outcome;
  };
  return { session, api, owner, warnings, busy, settle, fireTurnEnd, turnEnd };
}

const verdictOf = (draft: Draft) => /RESULT_\w+/.exec(draft.content)?.[0];

beforeEach(() => {
  _resetDeliveryRegistriesForTests();
  _useHostSessionClassForTests(FakeHostSession);
});

afterEach(() => {
  mock.timers.reset();
  _resetDeliveryRegistriesForTests();
});

describe("results queued for a busy host", () => {
  it("wait with no send, no warning, and no timer to give up, then go in oldest first at the turn's end", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const s = startSession();
    s.busy();
    for (const id of ["r1", "r2", "r3"]) s.owner.addRun(id, `RESULT_${id}`);

    // Completion order is the reverse of the live-run order for two of them.
    for (const id of ["r3", "r1", "r2"]) s.owner.complete(id);
    mock.timers.tick(10 * 60_000);
    await tick();

    assert.equal(s.session.received.length, 0, "a busy host is never sent to");
    assert.deepEqual(s.warnings, [], "waiting is not a failure, however long the run takes");
    assert.ok(
      ["r1", "r2", "r3"].every((id) => s.owner.pending(id)),
      "every result is a durable marker",
    );

    const outcome = await s.turnEnd();

    assert.deepEqual(outcome?.entries.map(verdictOf), ["RESULT_r3", "RESULT_r1", "RESULT_r2"]);
    assert.equal(outcome?.continue, true);
    assert.ok(outcome?.entries.every((entry) => entry.type === "custom_message" && entry.display));
    assert.equal(s.session.received.length, 0, "still nothing was sent into the queue");
    assert.ok(
      ["r1", "r2", "r3"].every((id) => s.owner.pending(id) === undefined),
      "persisted entries clear markers",
    );
    assert.deepEqual(s.warnings, []);
  });

  it("go out oldest first from the idle signal when the run ends without a turn that can take them", async () => {
    const s = startSession();
    s.busy();
    for (const id of ["r1", "r2"]) s.owner.addRun(id, `RESULT_${id}`);
    s.owner.complete("r2");
    s.owner.complete("r1");
    assert.equal(s.session.received.length, 0);

    await s.settle(true);

    const delivered = s.session.received.map(({ message }) => verdictOf(message as unknown as Draft));
    assert.equal(delivered[0], "RESULT_r2", "the oldest result goes first, with no user message needed");
    assert.deepEqual(s.session.received[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.ok(s.owner.pending("r2") === undefined);
  });

  it("wait through a compaction and go out when it ends", async () => {
    const s = startSession();
    s.session.isIdle = false; // compacting: no run is streaming, but the host cannot take a prompt
    s.owner.addRun("r1", "RESULT_r1");
    s.owner.complete("r1");
    await tick();
    assert.equal(s.session.received.length, 0, "nothing is sent into a compaction");
    assert.ok(s.owner.pending("r1"));

    s.session.isIdle = true;
    s.session.emit({ type: "compaction_end" });
    await tick();

    assert.equal(s.session.received.length, 1);
    assert.equal(s.owner.pending("r1"), undefined);
  });

  it("are offered at every completed turn: only what is still pending, and what arrived since", async () => {
    const s = startSession();
    s.busy();
    s.owner.addRun("r1", "RESULT_r1");
    s.owner.complete("r1");

    const first = await s.turnEnd();
    assert.equal(first?.entries.length, 1);
    s.owner.addRun("r2", "RESULT_r2");
    s.owner.complete("r2");
    const second = await s.turnEnd();
    const third = await s.turnEnd();

    assert.deepEqual(second?.entries.map(verdictOf), ["RESULT_r2"], "an inserted result is not inserted again");
    assert.equal(third, undefined, "a turn with nothing waiting hands Pi nothing");
  });

  it("add to the entries other extensions chose, and never replace them", async () => {
    const s = startSession();
    s.busy();
    s.owner.addRun("r1", "RESULT_r1");
    s.owner.complete("r1");

    const outcome = s.api.fire(
      "turn_end",
      { type: "turn_end", outcome: "completed", entries: [{ type: "custom", customType: "other" }], continue: false },
      { sessionManager: s.session.sessionManager },
    ) as BoundaryOutcome;

    assert.deepEqual(
      outcome?.entries.map((entry) => entry.customType),
      ["other", "workflow-result"],
    );
  });

  it("insert nothing for a result another session owns", async () => {
    const s = startSession();
    s.busy();
    s.owner.addRun("mine", "RESULT_mine");
    s.owner.addRun("theirs", "RESULT_theirs", "someone-else");
    s.owner.complete("theirs");
    s.owner.complete("mine");

    const outcome = await s.turnEnd();

    assert.deepEqual(outcome?.entries.map(verdictOf), ["RESULT_mine"]);
    assert.ok(s.owner.pending("theirs"), "the other session's result stays pending for it");
  });

  it("are not inserted blind when the host cannot show its history", async () => {
    const s = startSession();
    s.busy();
    s.owner.addRun("r1", "RESULT_r1");
    s.owner.complete("r1");
    s.session.sessionManager.getBranch = () => {
      throw new Error("history unavailable");
    };

    assert.equal(await s.turnEnd(), undefined);
    assert.ok(s.owner.pending("r1"));
  });

  it("are not inserted again when the session file already holds them", async () => {
    const s = startSession();
    s.busy();
    s.owner.addRun("r1", "RESULT_r1");
    s.owner.complete("r1");
    // Pi persisted the result, then the process died before the marker was cleared.
    const deliveryId = s.owner.pending("r1")?.deliveryId;
    s.session.append({ customType: "workflow-result", content: "x", display: true, details: { deliveryId } });

    assert.equal(await s.turnEnd(), undefined, "no duplicate entry is handed to Pi");
    await tick();
    assert.equal(s.owner.pending("r1"), undefined, "the persisted result only needs its marker cleared");
  });
});

describe("turns that cannot answer a result", () => {
  for (const [name, options] of [
    ["a failed turn", { outcome: "error" }],
    ["an aborted turn", { outcome: "aborted" }],
    ["a turn of a run that is being cancelled", { cancelling: true }],
  ] as const) {
    it(`${name} hands Pi nothing, and the idle signal delivers the result`, async () => {
      const s = startSession();
      s.busy();
      s.owner.addRun("r1", "RESULT_r1");
      s.owner.complete("r1");

      assert.equal(await s.turnEnd(options), undefined);
      assert.ok(s.owner.pending("r1"), "the marker stays");
      assert.equal(s.session.received.length, 0);

      await s.settle(true);
      assert.equal(s.session.received.length, 1, "the host's idle signal sends it, and that send starts a turn");
      assert.equal(s.owner.pending("r1"), undefined);
    });
  }
});

describe("entries Pi does not append", () => {
  it("are offered again at the next turn's end, with no timer and no warning", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const s = startSession();
    s.busy();
    s.owner.addRun("r1", "RESULT_r1");
    s.owner.complete("r1");
    const deliveryId = s.owner.pending("r1")?.deliveryId;

    const dropped = await s.turnEnd({ piDropsEntries: true });
    assert.equal(dropped?.entries[0]?.details?.deliveryId, deliveryId);
    assert.ok(s.owner.pending("r1"), "a result Pi did not append keeps its marker");
    mock.timers.tick(10 * 60_000);
    await tick();
    assert.deepEqual(s.warnings, [], "a missed boundary is not a failed delivery");

    const next = await s.turnEnd();
    assert.equal(next?.entries[0]?.details?.deliveryId, deliveryId, "the same delivery id is offered again");
    assert.equal(s.owner.pending("r1"), undefined);
    assert.equal(s.session.received.length, 0);
  });

  it("are delivered by the idle signal with the same delivery id when no further turn comes", async () => {
    const s = startSession();
    s.busy();
    s.owner.addRun("r1", "RESULT_r1");
    s.owner.complete("r1");
    const deliveryId = s.owner.pending("r1")?.deliveryId;

    await s.turnEnd({ piDropsEntries: true });
    await s.settle();

    assert.equal(s.session.received.length, 1);
    assert.equal(s.session.received[0]?.message.details?.deliveryId, deliveryId);
    assert.equal(s.owner.pending("r1"), undefined);
  });
});

describe("cancellation, rebind, and session switch", () => {
  it("suspended delivery inserts nothing, and the replacement generation inserts at its boundary", async () => {
    const s = startSession();
    s.busy();
    s.owner.addRun("r1", "RESULT_r1");
    s.owner.complete("r1");

    suspendSessionDelivery(SESSION);
    assert.equal(await s.turnEnd(), undefined, "a dying generation hands Pi nothing");
    assert.equal(s.session.subscribers, 0, "and no longer listens to the host");
    assert.ok(s.owner.pending("r1"));

    bindSessionDelivery(SESSION, s.api.pi, { manager: s.owner.manager });
    const outcome = await s.turnEnd();
    assert.deepEqual(outcome?.entries.map(verdictOf), ["RESULT_r1"]);
    assert.equal(s.owner.pending("r1"), undefined);
  });

  it("a rebind while Pi holds the entries finds them in the session file instead of sending again", async () => {
    const s = startSession();
    s.busy();
    s.owner.addRun("r1", "RESULT_r1");
    s.owner.complete("r1");
    const outcome = s.fireTurnEnd();
    assert.equal(outcome?.entries.length, 1);

    // /reload lands between the handler's return and Pi's append.
    suspendSessionDelivery(SESSION);
    bindSessionDelivery(SESSION, s.api.pi, { manager: s.owner.manager });
    for (const entry of outcome?.entries ?? []) s.session.append(entry);
    await s.settle();
    await tick();

    assert.equal(s.session.received.length, 0, "the result was not sent a second time");
    assert.equal(s.owner.pending("r1"), undefined, "the new generation cleared the marker");
  });

  it("a session switch moves the waiting result to the new session, which gets it at once", async () => {
    const old = startSession("session-old");
    old.busy();
    old.owner.addRun("r1", "RESULT_r1", "session-old");
    old.owner.complete("r1");

    // /new: the old generation shuts down and goes stale; the new session adopts its work.
    suspendSessionDelivery("session-old");
    old.api.goStale();
    old.owner.adopt("session-next", "session-old");
    dropSessionDelivery("session-old");
    const next = startSession("session-next", old.owner);
    await tick();

    assert.equal(await old.turnEnd(), undefined, "the replaced session's boundary hands Pi nothing");
    assert.equal(old.session.received.length, 0, "the old session never receives the result");
    assert.equal(next.session.received.length, 1, "the idle new session receives it at once");
    assert.equal(old.owner.pending("r1"), undefined);
  });

  it("a send that fails when the host goes idle is retried with the same delivery id", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const attempts: Array<string | undefined> = [];
    class FlakyHost extends FakeHostSession {
      sendCustomMessage(message: HostMessage, options?: unknown): Promise<void> {
        attempts.push(message.details?.deliveryId);
        return attempts.length === 1
          ? Promise.reject(new Error("network blip"))
          : super.sendCustomMessage(message, options);
      }
    }
    _useHostSessionClassForTests(FlakyHost);
    const session = new FlakyHost(SESSION);
    const api = extensionApi(session);
    const owner = deliveryManager(SESSION);
    const warnings: string[] = [];
    installResultDelivery(api.pi, owner.manager);
    bindSessionDelivery(SESSION, api.pi, { manager: owner.manager, reportWarning: (m) => warnings.push(m) });
    session.isStreaming = true;
    session.isIdle = false;
    owner.addRun("r1", "RESULT_r1");
    owner.complete("r1");

    session.isStreaming = false;
    session.isIdle = true;
    session.emit({ type: "agent_settled" });
    await tick();
    assert.equal(attempts.length, 1);
    assert.match(warnings.join("\n"), /remains pending: network blip/);
    assert.ok(owner.pending("r1"));

    mock.timers.tick(250);
    await tick();

    assert.equal(attempts.length, 2);
    assert.equal(attempts[1], attempts[0], "a retry keeps the id, so history can deduplicate it");
    assert.equal(owner.pending("r1"), undefined);
  });
});

describe("the turn boundary handler", () => {
  it("is registered once per ExtensionAPI however often delivery is installed, and the old boundary is gone", () => {
    const s = startSession();
    installResultDelivery(s.api.pi, s.owner.manager);
    installResultDelivery(s.api.pi, deliveryManager(SESSION).manager);

    assert.equal(s.api.handlerCount("turn_end"), 1);
    assert.equal(s.api.handlerCount("agent_before_settle"), 0, "nothing waits for the end of the run");
  });
});
