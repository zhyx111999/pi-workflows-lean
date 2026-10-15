/**
 * The delivery link to a host session: a busy host is never sent to, a send
 * counts as delivered only once the session file holds the result, a result
 * Pi appends at its turn_end boundary is confirmed the same way (or reported
 * missed when the turn ends without it), and the host's idle signals reach the
 * endpoint without any timer.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { cancelInsertionWaits, type HostSessionLink, hostSessionLink } from "../src/task-panel/host-session-link.js";
import { _resetDeliveryRegistriesForTests } from "../src/task-panel.js";

const temporaryRoots: string[] = [];
afterEach(() => {
  _resetDeliveryRegistriesForTests();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Message = { customType: string; content: string; display: boolean; details?: { deliveryId?: string } };
type BranchEntry = { id: string; type: string; customType: string; details?: unknown };
type Event = { type: string; entry?: BranchEntry };

const message: Message = {
  customType: "workflow-result",
  content: "done",
  display: true,
  details: { deliveryId: "delivery-one" },
};

/** A host session double: its own history and session file, settable busy state, scripted events. */
function host(options: { sendDefersUntilSettled?: boolean } = {}) {
  const listeners = new Set<(event: Event) => void>();
  const branch: BranchEntry[] = [];
  const abandonedEntries: BranchEntry[] = [];
  const root = mkdtempSync(join(tmpdir(), "pi-delivery-history-"));
  temporaryRoots.push(root);
  const sessionFile = join(root, "session.jsonl");
  // The production scan searches for a full newline-delimited JSONL record.
  writeFileSync(sessionFile, "\n");
  const sent: Message[] = [];
  let resolveTurn = () => {};
  const session = {
    isStreaming: false,
    isIdle: true,
    sessionManager: {
      getSessionId: () => "link-host",
      getBranch: () => branch,
      getEntries: () => [...branch, ...abandonedEntries],
      getSessionFile: () => sessionFile,
    },
    subscribe(listener: (event: Event) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendCustomMessage(sentMessage: Message) {
      assert.equal(session.isStreaming, false, "never enqueue a custom follow-up while streaming");
      sent.push(sentMessage);
      // Pi starts the turn inside this call, except when it defers the send past a settle in progress.
      if (options.sendDefersUntilSettled) return Promise.resolve();
      session.isStreaming = true;
      session.isIdle = false;
      return new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });
    },
  };
  const link = hostSessionLink(session, "link-host") as HostSessionLink;
  assert.ok(link);
  const emit = (event: Event) => {
    for (const listener of [...listeners]) listener(event);
  };
  const append = (entryMessage: Message, into = branch) => {
    const entry: BranchEntry = {
      id: `entry-${into.length}`,
      type: "custom_message",
      customType: entryMessage.customType,
      details: entryMessage.details,
    };
    into.push(entry);
    return entry;
  };
  const persist = (entryMessage: Message) => {
    const entry = append(entryMessage);
    appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
    return entry;
  };
  return {
    session,
    link,
    sent,
    listeners,
    emit,
    persist,
    busy() {
      session.isStreaming = true;
      session.isIdle = false;
    },
    async idle() {
      session.isStreaming = false;
      session.isIdle = true;
      emit({ type: "agent_settled" });
      await tick();
    },
    /** Pi's order for a message that starts a turn: listeners hear about it, then it is appended. */
    persistWithSendEvent(sentMessage = sent[0]) {
      emit({ type: "message_end" });
      persist(sentMessage);
    },
    rememberOnly: (entryMessage: Message = sent[0]) => append(entryMessage),
    rememberAbandoned: (entryMessage: Message) => append(entryMessage, abandonedEntries),
    finishTurn: () => resolveTurn(),
  };
}

test("a busy host is never sent to, whatever events pass", async () => {
  const h = host();
  h.busy();
  assert.equal(h.link.isBusy(), true);
  await assert.rejects(Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" })), /busy/);
  h.emit({ type: "queue_update" });
  h.emit({ type: "agent_end" });
  await tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.listeners.size, 0, "a refused send leaves nothing subscribed");
  assert.equal(h.link.isBusy(), true);
  await h.idle();
  assert.equal(h.link.isBusy(), false);
});

test("compaction counts as busy", () => {
  const h = host();
  h.session.isIdle = false;
  assert.equal(h.link.isBusy(), true);
});

test("an idle send resolves once the result is persisted, before the model answers it", async () => {
  const h = host();
  const pending = Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" }));
  assert.equal(h.sent.length, 1);
  assert.equal(h.link.isBusy(), true, "the turn it started owns the host");
  h.persistWithSendEvent();
  await pending;
  assert.equal(h.listeners.size, 0);
  // A repeat of an accepted delivery is answered from history, whatever the host is doing.
  await h.link.send(message, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(h.sent.length, 1, "history deduplicates an already accepted delivery");
  h.finishTurn();
});

test("the send's own settlement is not an ACK without the persisted result", async () => {
  const h = host();
  const pending = Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" }));
  h.finishTurn();
  await assert.rejects(pending, /without persisting/);
});

test("a send Pi defers past a settle in progress waits for the next settle, not for its own resolution", async () => {
  const h = host({ sendDefersUntilSettled: true });
  let outcome: unknown = "unsettled";
  const pending = Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" })).then(
    () => {
      outcome = "delivered";
    },
    (error: Error) => {
      outcome = error.message;
    },
  );
  await tick();
  assert.equal(outcome, "unsettled", "resolving at once does not decide a deferred send");

  // Pi finishes announcing the settle, starts the deferred turn, and appends the result.
  h.emit({ type: "agent_settled" });
  h.busy();
  await tick();
  assert.equal(outcome, "unsettled", "a host that went on to run is given its turn");
  h.persistWithSendEvent();
  await pending;
  assert.equal(outcome, "delivered");
});

test("a deferred send that never lands is refused once the host settles idle without it", async () => {
  const h = host({ sendDefersUntilSettled: true });
  const pending = assert.rejects(
    Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" })),
    /settled without persisting/,
  );
  await h.idle();
  await pending;
  assert.equal(h.listeners.size, 0);
});

test("a memory-only branch entry is not an ACK and does not deduplicate a new send", async () => {
  const h = host();
  h.rememberOnly(message);
  const pending = Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" }));
  assert.equal(h.sent.length, 1, "an unpersisted branch entry must not suppress delivery");
  h.rememberOnly();
  h.finishTurn();
  await assert.rejects(pending, /without persisting/);
});

test("a later persisted entry with the same delivery id ACKs despite an earlier memory-only entry", async () => {
  const h = host();
  h.rememberOnly(message);
  const pending = Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" }));
  assert.equal(h.sent.length, 1, "memory-only history does not suppress the retry");
  h.persistWithSendEvent();
  await pending;
  h.finishTurn();
});

test("an abandoned branch entry is not durable delivery history", async () => {
  const h = host();
  h.rememberAbandoned(message);
  assert.equal(h.link.hasDelivery("delivery-one"), false);
  const pending = Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" }));
  assert.equal(h.sent.length, 1, "an abandoned branch cannot deduplicate a live delivery");
  h.persistWithSendEvent();
  await pending;
  h.finishTurn();
});

test("a host that cannot show its history confirms nothing", async () => {
  const link = hostSessionLink(
    {
      sendCustomMessage: () => Promise.resolve(),
      subscribe: () => () => {},
      sessionManager: {
        getSessionId: () => "blind",
        getBranch: () => {
          throw new Error("history unavailable");
        },
        getSessionFile: () => "/session.jsonl",
      },
    },
    "blind",
  ) as HostSessionLink;
  assert.equal(link.hasDelivery("delivery-one"), undefined);
  await assert.rejects(
    Promise.resolve(link.send(message, { triggerTurn: true, deliverAs: "followUp" })),
    /cannot confirm/,
  );
});

test("a result Pi appends at its boundary is confirmed once it is persisted, not before", async () => {
  const h = host();
  h.busy();
  let outcome: string | undefined;
  const waiting = h.link.awaitInsertion("delivery-one").then((result) => {
    outcome = result;
  });
  h.emit({ type: "message_end" });
  await tick();
  assert.equal(outcome, undefined, "an event without the result in the file decides nothing");

  // Pi appends the entry, then announces it, then announces the turn's end.
  const entry = h.persist(message);
  h.emit({ type: "entry_appended", entry });
  h.emit({ type: "turn_end" });
  await waiting;
  assert.equal(outcome, "persisted", "the turn's end does not undo an entry that landed first");
  assert.equal(h.listeners.size, 0);
});

test("a boundary result is missed when the turn ends without it, however busy the host stays", async () => {
  const h = host();
  h.busy();
  const waiting = h.link.awaitInsertion("delivery-one");
  h.emit({ type: "message_end" });
  await tick();
  assert.equal(h.listeners.size, 1, "still waiting while the turn is open");

  h.emit({ type: "turn_end" });
  assert.equal(await waiting, "missed");
  assert.equal(h.listeners.size, 0);
  assert.equal(h.link.isBusy(), true, "the run goes on; the next turn's boundary offers the result again");
});

test("a boundary result the host never appended is reported when the host settles idle", async () => {
  const h = host();
  h.busy();
  const waiting = h.link.awaitInsertion("delivery-one");
  await h.idle();
  assert.equal(await waiting, "missed");
  assert.equal(h.listeners.size, 0);
});

test("an idle send does not give up when a turn ends", async () => {
  const h = host({ sendDefersUntilSettled: true });
  let outcome: unknown = "unsettled";
  const pending = Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" })).then(
    () => {
      outcome = "delivered";
    },
    (error: Error) => {
      outcome = error.message;
    },
  );
  h.emit({ type: "turn_end" });
  await tick();
  assert.equal(outcome, "unsettled", "only the settle decides a send; a turn end is not a verdict on it");
  h.persistWithSendEvent();
  await pending;
  assert.equal(outcome, "delivered");
});

test("cancelling a session's insertion waits rejects them and frees the host listener", async () => {
  const h = host();
  h.busy();
  const waiting = assert.rejects(h.link.awaitInsertion("delivery-one"), /suspended/);
  cancelInsertionWaits("link-host", "suspended");
  await waiting;
  assert.equal(h.listeners.size, 0);
  // Pi still commits what it was handed; the next check finds it.
  h.persist(message);
  assert.equal(h.link.hasDelivery("delivery-one"), true);
});

test("cancelling insertion waits leaves a send that already started alone", async () => {
  const h = host();
  const pending = Promise.resolve(h.link.send(message, { triggerTurn: true, deliverAs: "followUp" }));
  assert.equal(h.sent.length, 1);
  cancelInsertionWaits("link-host", "suspended");
  h.persistWithSendEvent();
  await pending;
  assert.equal(h.sent.length, 1, "cancelling must not cancel or resend a started host send");
  h.finishTurn();
});

test("idle signals are the host's settles and compactions, delivered outside the notification", async () => {
  const h = host();
  let idles = 0;
  const stop = h.link.onIdle(() => {
    idles++;
  });
  h.emit({ type: "queue_update" });
  h.emit({ type: "agent_end" });
  h.emit({ type: "message_end" });
  await tick();
  assert.equal(idles, 0, "only settles and compactions are idle signals");

  h.emit({ type: "agent_settled" });
  assert.equal(idles, 0, "the listener runs after the notification returns");
  await tick();
  assert.equal(idles, 1);
  h.emit({ type: "compaction_end" });
  await tick();
  assert.equal(idles, 2);

  stop();
  h.emit({ type: "agent_settled" });
  await tick();
  assert.equal(idles, 2);
  assert.equal(h.listeners.size, 0);
});
