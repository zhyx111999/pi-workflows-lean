/**
 * What delivery needs from a host AgentSession: whether it is busy, a send that
 * counts as delivered only once the session file holds the result, the wait
 * for a result Pi appends at its turn_end boundary, and a signal when the
 * session can take a prompt again.
 *
 * Nothing here waits for the host to become idle and nothing runs on a timer: a
 * busy host is never sent to, and its owner is told when to try again.
 */

import { type DeliverySend, RESULT_MESSAGE_TYPE } from "./delivery-endpoints.js";
import { sessionFileContainsEntry } from "./session-file-scan.js";

interface HostEntry {
  id?: string;
  type?: string;
  customType?: string;
  details?: unknown;
}

type HostEvent = { type?: string; entry?: HostEntry };

/** The parts of an AgentSession delivery relies on; optional so test doubles can supply only what they use. */
export interface HostSession {
  sendCustomMessage?: DeliverySend;
  isStreaming?: boolean;
  isIdle?: boolean;
  subscribe?: (listener: (event: HostEvent) => void) => () => void;
  sessionManager?: {
    getSessionId?: () => string;
    getBranch?: () => HostEntry[];
    getSessionFile?: () => string | undefined;
  };
}

/** How a result handed to Pi's turn_end boundary ended: in the session file, or passed over. */
export type InsertionOutcome = "persisted" | "missed";

export interface HostSessionLink {
  /** Sends into an idle host and resolves once the result is persisted. Rejects, sending nothing, while the host is busy. */
  send: DeliverySend;
  /** A run, compaction, or retry owns the host: anything sent now would sit in Pi's unobservable follow-up queue. */
  isBusy(): boolean;
  /** Whether the session file already holds the result; undefined when the host cannot say, which counts as not delivered and not safe to insert. */
  hasDelivery(deliveryId: string): boolean | undefined;
  /**
   * Waits for the outcome of a result handed to Pi's turn_end boundary. Pi
   * appends the entries before it announces the turn's end, so "persisted"
   * means the session file holds the result, and "missed" means the turn ended
   * (or the host settled) without it, for example because another extension's
   * entries made Pi drop the whole boundary. Rejects when
   * {@link cancelInsertionWaits} cancels the wait.
   */
  awaitInsertion(deliveryId: string): Promise<InsertionOutcome>;
  /** Calls `listener` each time the host reaches a point where it can take a prompt; returns the unsubscribe. */
  onIdle(listener: () => void): () => void;
}

interface InsertionWait {
  sessionId: string;
  cancel: (error: Error) => void;
}
const insertionWaits = new Set<InsertionWait>();

function deliveryIdFromDetails(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const deliveryId = (details as { deliveryId?: unknown }).deliveryId;
  return typeof deliveryId === "string" && deliveryId ? deliveryId : undefined;
}

/** Whether the session's current branch holds this delivery and the session file has it on disk. */
function sessionHasDelivery(session: HostSession, deliveryId: string): boolean | undefined {
  const sm = session.sessionManager;
  if (typeof sm?.getBranch !== "function" || typeof sm.getSessionFile !== "function") return undefined;
  try {
    const entries = sm
      .getBranch()
      .filter(
        (entry) =>
          typeof entry.id === "string" &&
          entry.type === "custom_message" &&
          entry.customType === RESULT_MESSAGE_TYPE &&
          deliveryIdFromDetails(entry.details) === deliveryId,
      );
    const file = sm.getSessionFile();
    // getEntries includes abandoned branches; even getBranch can contain a
    // memory-only entry after a failed/lazy persist. Neither alone is an ACK.
    return !!file && entries.some((entry) => sessionFileContainsEntry(file, entry));
  } catch {
    return undefined;
  }
}

function isBusy(session: HostSession): boolean {
  return session.isStreaming === true || session.isIdle === false;
}

interface PersistenceWatch {
  /** true: the session file holds the result. false: the watch ended without it. */
  done: Promise<boolean>;
  persisted(): void;
  fail(error: unknown): void;
}

/**
 * Watch the host until the result is in its session file or the watch gives
 * up. Pi tells listeners about a message just before it appends it, so each
 * notice is rechecked a microtask later. It gives up when the host settles and
 * stays idle without the result; a host that has already started its next turn
 * by then (a send Pi deferred past the settle) is given that turn. With
 * `endsWithTurn` it also gives up when the turn ends, which a boundary entry
 * must beat: Pi appends boundary entries before it announces the turn's end.
 * Nothing else ends the watch without the result but the caller (a rejected
 * send, a cancel): elapsed time proves nothing about a prompt Pi has accepted.
 */
function watchPersistence(session: HostSession, deliveryId: string, endsWithTurn: boolean): PersistenceWatch {
  let ended = false;
  let unsubscribe = () => {};
  let resolveDone!: (persisted: boolean) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<boolean>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const end = (settle: () => void) => {
    if (ended) return;
    ended = true;
    unsubscribe();
    settle();
  };

  unsubscribe =
    session.subscribe?.((event) => {
      if (event.type === "message_end" || event.type === "entry_appended") {
        queueMicrotask(() => {
          if (sessionHasDelivery(session, deliveryId) === true) end(() => resolveDone(true));
        });
      } else if (event.type === "turn_end" && endsWithTurn) {
        queueMicrotask(() => end(() => resolveDone(sessionHasDelivery(session, deliveryId) === true)));
      } else if (event.type === "agent_settled") {
        queueMicrotask(() => {
          const persisted = sessionHasDelivery(session, deliveryId) === true;
          if (persisted || !isBusy(session)) end(() => resolveDone(persisted));
        });
      }
    }) ?? unsubscribe;

  return {
    done,
    persisted: () => end(() => resolveDone(true)),
    fail: (error) => end(() => rejectDone(error)),
  };
}

/**
 * A send into the idle host `session` (id `sid`). The idle check and the send
 * share one synchronous step, so the result is never queued behind a turn.
 */
function sendIntoIdleHost(session: HostSession, sid: string, send: DeliverySend): DeliverySend {
  return (message, options) => {
    const deliveryId = deliveryIdFromDetails(message.details);
    if (!deliveryId) return send.call(session, message, options);

    const delivered = sessionHasDelivery(session, deliveryId);
    if (delivered === true) return Promise.resolve();
    if (delivered === undefined || typeof session.subscribe !== "function") {
      return Promise.reject(new Error("host cannot confirm workflow result delivery"));
    }
    if (isBusy(session))
      return Promise.reject(new Error("host is busy; workflow results are not queued behind a turn"));
    if (session.sessionManager?.getSessionId?.() !== sid) {
      return Promise.reject(new Error("host session identity changed before delivery"));
    }

    const watch = watchPersistence(session, deliveryId, false);
    try {
      const pending = send.call(session, message, options);
      if (pending == null || typeof (pending as { then?: unknown }).then !== "function") {
        watch.fail(new Error("workflow result send did not return a thenable"));
      } else {
        // An idle host starts the turn inside this call. One that does not is
        // still announcing that it settled, and Pi defers the send until that
        // announcement ends: it resolves at once, persists later, and the
        // next settle (not the send) decides whether it landed.
        const started = isBusy(session);
        Promise.resolve(pending).then(
          () => {
            if (sessionHasDelivery(session, deliveryId) === true) watch.persisted();
            else if (started) watch.fail(new Error("host send settled without persisting workflow result"));
          },
          (error) => {
            if (sessionHasDelivery(session, deliveryId) === true) watch.persisted();
            else watch.fail(error);
          },
        );
      }
    } catch (error) {
      watch.fail(error);
    }
    return watch.done.then((persisted) => {
      if (!persisted) throw new Error("host settled without persisting workflow result");
    });
  };
}

/** The link to the host session `session`, whose id is `sid`; undefined when it has no sendCustomMessage. */
export function hostSessionLink(session: HostSession, sid: string): HostSessionLink | undefined {
  const send = session.sendCustomMessage;
  if (typeof send !== "function") return undefined;

  return {
    send: sendIntoIdleHost(session, sid, send),
    isBusy: () => isBusy(session),
    hasDelivery: (deliveryId) =>
      typeof session.subscribe === "function" ? sessionHasDelivery(session, deliveryId) : undefined,
    async awaitInsertion(deliveryId) {
      const watch = watchPersistence(session, deliveryId, true);
      const wait: InsertionWait = { sessionId: sid, cancel: watch.fail };
      insertionWaits.add(wait);
      const release = () => insertionWaits.delete(wait);
      watch.done.then(release, release);
      return (await watch.done) ? "persisted" : "missed";
    },
    onIdle(listener) {
      return (
        session.subscribe?.((event) => {
          // agent_settled is awaited by Pi and notification-only: act on it a
          // microtask later, outside the notification, so a send made here is
          // never deferred behind the very event that announced the idle host.
          if (event.type === "agent_settled" || event.type === "compaction_end") queueMicrotask(listener);
        }) ?? (() => {})
      );
    },
  };
}

/**
 * Cancel a session's waits for results Pi was handed at a boundary. Pi commits
 * those on its own, so cancelling only frees the delivery to be checked again:
 * the next flush finds the result in the session file or sends it afresh.
 */
export function cancelInsertionWaits(sessionId: string, reason: string): void {
  for (const wait of insertionWaits) {
    if (wait.sessionId === sessionId) wait.cancel(new Error(reason));
  }
}

/** @internal test helper — cancel every wait. */
export function _resetHostLinksForTests(): void {
  for (const wait of insertionWaits) wait.cancel(new Error("test reset"));
  insertionWaits.clear();
}
