import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { AgentSession, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import { confirmedSessionSend } from "../src/task-panel/confirmed-send.js";
import { _useHostSessionClassForTests, DELIVERY_PROBE_CUSTOM_TYPE } from "../src/task-panel/host-session-capture.js";
import { UsageLimitScheduler } from "../src/usage-limit-scheduler.js";
import type { WorkflowRunResult } from "../src/workflow.js";
import { type ManagedRun, WorkflowManager } from "../src/workflow-manager.js";
import type { WorkflowSettings } from "../src/workflow-settings.js";
import { withRealSession } from "./helpers/real-session.js";

type DeliveryCall = { content: string; customType?: string; triggerTurn?: boolean };
type StableSend = (
  msg: { customType?: string; content?: string; display?: boolean; details?: { deliveryId?: string } },
  opts?: { triggerTurn?: boolean; deliverAs?: string },
) => unknown;

/** A host session double whose sendCustomMessage sits on the class prototype, as on AgentSession. */
class TestHostSession {
  declare send: StableSend;
  declare sessionManager: { getSessionId: () => string };

  constructor(fields: Record<string, unknown>) {
    Object.assign(this, fields);
  }

  sendCustomMessage(message: Parameters<StableSend>[0], options?: Parameters<StableSend>[1]): unknown {
    return this.send(message, options);
  }
}

const lifecycleScript = `export const meta = { name: 'lifecycle_delivery', description: 'delivery lifecycle test' }
const result = await agent('wait for control')
return { result }`;

function controlledAgent() {
  const resolvers: Array<(value: unknown) => void> = [];
  let calls = 0;
  return {
    runner: {
      async run() {
        calls++;
        return new Promise<unknown>((resolve) => resolvers.push(resolve));
      },
    },
    calls: () => calls,
    resolve(index: number, value = "done") {
      resolvers[index]?.(value);
    },
    async waitForCalls(expected: number) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (calls >= expected) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.fail(`agent did not reach ${expected} calls (saw ${calls})`);
    },
  };
}

const fatalControlRaceScript = `export const meta = { name: 'fatal_control_race', description: 'run-fatal lifecycle race' }
await parallel([
  () => agent('fatal', { label: 'fatal' }),
  () => agent('sibling', { label: 'sibling' }),
])
return 'unreachable'`;

function fatalThenDrainAgent() {
  let siblingAbortObserved = false;
  let rejectSibling: ((reason?: unknown) => void) | undefined;
  return {
    runner: {
      async run(prompt: string, options: { signal?: AbortSignal } = {}) {
        if (prompt === "fatal") {
          throw new WorkflowError("fatal sibling failure", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
            recoverable: false,
          });
        }
        return new Promise<unknown>((_resolve, reject) => {
          rejectSibling = reject;
          options.signal?.addEventListener(
            "abort",
            () => {
              siblingAbortObserved = true;
            },
            { once: true },
          );
        });
      },
    },
    async waitForSiblingAbort() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (siblingAbortObserved) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.fail("run-fatal signal did not reach the sibling");
    },
    settleSibling() {
      rejectSibling?.(new Error("sibling drained after run-fatal"));
    },
  };
}

const usageLimitControlRaceScript = `export const meta = { name: 'usage_limit_control_race', description: 'usage-limit lifecycle race' }
await parallel([
  () => agent('quota', { label: 'quota' }),
  () => agent('sibling', { label: 'sibling' }),
])
return 'unreachable'`;

function usageLimitThenDrainAgent() {
  let siblingAbortObserved = false;
  let rejectSibling: ((reason?: unknown) => void) | undefined;
  return {
    runner: {
      async run(prompt: string, options: { signal?: AbortSignal } = {}) {
        if (prompt === "quota") {
          throw new WorkflowError("quota exhausted", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
            recoverable: false,
            resetHint: "Resets in 1m",
          });
        }
        return new Promise<unknown>((_resolve, reject) => {
          rejectSibling = reject;
          options.signal?.addEventListener(
            "abort",
            () => {
              siblingAbortObserved = true;
            },
            { once: true },
          );
        });
      },
    },
    async waitForSiblingAbort() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (siblingAbortObserved) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.fail("usage-limit fatal signal did not reach the sibling");
    },
    settleSibling() {
      rejectSibling?.(new Error("sibling drained after usage limit"));
    },
  };
}

function lateUsageLimitAgent() {
  let rejectAgent: ((reason?: unknown) => void) | undefined;
  return {
    runner: {
      async run() {
        return new Promise<unknown>((_resolve, reject) => {
          rejectAgent = reject;
        });
      },
    },
    async waitForStart() {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (rejectAgent) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.fail("late provider-limit agent did not start");
    },
    rejectWithUsageLimit() {
      rejectAgent?.(
        new WorkflowError("late quota exhausted", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
          recoverable: false,
          resetHint: "Resets in 1m",
        }),
      );
    },
  };
}

// Loaded once before all tests
let mod: typeof import("../src/task-panel.js");

before(async () => {
  mod = await import("../src/task-panel.js");
});

// ─── Session-routed background result delivery ─────────────────────────────────

describe("installResultDelivery", () => {
  const SESSION = "sess-test";
  const deliveryHistoryRoots: string[] = [];

  function createPersistedDeliveryHistory() {
    const root = mkdtempSync(join(tmpdir(), "pi-delivery-history-"));
    deliveryHistoryRoots.push(root);
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, "\n");
    type Entry = { id: string; type: string; customType: string; details?: unknown };
    const branch: Entry[] = [];
    return {
      branch,
      sessionFile,
      append(entry: Entry) {
        branch.push(entry);
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      },
    };
  }
  type DeliveryHistory = ReturnType<typeof createPersistedDeliveryHistory>;

  after(() => {
    for (const root of deliveryHistoryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    mod._resetDeliveryRegistriesForTests();
  });

  /** A manager double over in-memory runs and a fake record store; only the members delivery uses. */
  function createMockManager(run?: Record<string, unknown> | ManagedRun, runsDir?: string): WorkflowManager {
    let sessionId: string | undefined = SESSION;
    const runs = new Map<string, Record<string, unknown>>();
    if (run) runs.set(String(run.runId ?? "test-run-1"), run as Record<string, unknown>);

    const disk = new Map<string, Record<string, unknown>>();

    const manager = new EventEmitter() as EventEmitter & {
      getRun: (id: string) => unknown;
      getPersistence: () => {
        getRunsDir: () => string;
        load: (id: string) => Record<string, unknown> | null;
        loadPreview: (id: string) => Record<string, unknown> | null;
        save: (state: PersistedRunState) => void;
        updateMetadata: (id: string, patch: Record<string, unknown>, expectedDeliveryId?: string) => boolean;
        exportResult: (id: string) => string;
        list: () => Record<string, unknown>[];
      };
      getSessionId: () => string | undefined;
      setSessionId: (id: string | undefined) => void;
      adoptLiveRunsToSession: (newId: string | undefined, previousSessionId?: string) => number;
      listLiveRuns: () => unknown[];
      listRuns?: () => unknown[];
    };
    manager.getRun = (id: string) => runs.get(id);
    manager.getSessionId = () => sessionId;
    manager.setSessionId = (id) => {
      sessionId = id;
    };
    manager.adoptLiveRunsToSession = (newId, previousSessionId) => {
      if (!newId) return 0;
      const prev = previousSessionId !== undefined ? previousSessionId : sessionId;
      let adopted = 0;
      for (const managed of runs.values()) {
        const status = managed.status as string | undefined;
        const active = status === "running" || status === "paused";
        const undelivered = managed.pendingDelivery != null;
        if (!active && !undelivered) continue;
        // Like the real manager: only runs the previous session owned move.
        if (managed.sessionId === newId || managed.sessionId !== prev) continue;
        managed.sessionId = newId;
        const existing = disk.get(String(managed.runId));
        if (existing) disk.set(String(existing.runId), { ...existing, sessionId: newId });
        adopted++;
      }
      for (const state of [...disk.values()]) {
        if (!state.pendingDelivery) continue;
        if (runs.has(String(state.runId))) continue;
        if (state.sessionId === newId) continue;
        if (prev == null || state.sessionId !== prev) continue;
        disk.set(String(state.runId), { ...state, sessionId: newId });
        adopted++;
      }
      return adopted;
    };
    manager.listLiveRuns = () => [...runs.values()];
    manager.getPersistence = () => ({
      getRunsDir: () => runsDir ?? "/runs",
      load: (id: string) => disk.get(id) ?? null,
      loadPreview: (id: string) => disk.get(id) ?? null,
      save: (state: PersistedRunState) => {
        disk.set(String(state.runId), { ...state });
      },
      // Like the real store: merge into an existing record, never create one,
      // and refuse when the record's marker belongs to another delivery.
      updateMetadata: (id: string, patch: Record<string, unknown>, expectedDeliveryId?: string) => {
        const current = disk.get(id);
        if (!current) return false;
        const marker = current.pendingDelivery as { deliveryId?: string } | undefined;
        if (expectedDeliveryId && marker?.deliveryId && marker.deliveryId !== expectedDeliveryId) return false;
        const next = { ...current, ...patch };
        for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
        disk.set(id, next);
        return true;
      },
      exportResult: (id: string) => join(runsDir ?? "/runs", `${id}.json.result`),
      list: () => [...disk.values()],
    });
    return manager as unknown as WorkflowManager;
  }

  function createMockPi(): ExtensionAPI & {
    _calls: DeliveryCall[];
    emit?: (event: string, ...args: unknown[]) => void;
    _onCount: (event: string) => number;
  } {
    const calls: DeliveryCall[] = [];
    const events = new EventEmitter();
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const registrations = new Map<string, number>();
    const obj = {
      events: {
        emit: (channel: string, data: unknown) => events.emit(channel, data),
        on: (channel: string, handler: (data: unknown) => void) => {
          events.on(channel, handler);
          return () => events.off(channel, handler);
        },
      },
      sendMessage(msg: unknown, _opts?: unknown) {
        calls.push({
          content: (msg as { content?: string }).content ?? "",
          customType: (msg as { customType?: string }).customType,
        });
      },
      registerTool: () => {},
      on: (event: string, handler: (...args: unknown[]) => void) => {
        registrations.set(event, (registrations.get(event) ?? 0) + 1);
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        };
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const handler of handlers.get(event) ?? []) {
          handler(...args);
        }
      },
      _onCount: (event: string) => registrations.get(event) ?? 0,
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
      _calls: calls,
    };
    return obj as unknown as ExtensionAPI & {
      _calls: DeliveryCall[];
      emit?: (event: string, ...args: unknown[]) => void;
      _onCount: (event: string) => number;
    };
  }

  /** Session-stable thenable send that records like the old sendMessage spy. */
  function recordingStableSend(pi: { _calls: DeliveryCall[] }): StableSend {
    return function recordingStableSend(this: unknown, msg, opts) {
      pi._calls.push({
        content: msg.content ?? "",
        customType: msg.customType,
        triggerTurn: opts?.triggerTurn,
      });
      const fixture = this as {
        __deliveryEntries?: Array<Record<string, unknown>>;
        __deliveryHistory?: DeliveryHistory;
      };
      const deliveryId = msg.details?.deliveryId;
      if (deliveryId && fixture.__deliveryHistory) {
        fixture.__deliveryHistory.append({
          id: `entry-${fixture.__deliveryHistory.branch.length}`,
          type: "custom_message",
          customType: msg.customType ?? "workflow-result",
          details: msg.details,
        });
      }
      if (deliveryId && fixture.__deliveryEntries) {
        fixture.__deliveryEntries.push({
          type: "custom_message",
          customType: msg.customType,
          details: msg.details,
        });
      }
      return Promise.resolve();
    };
  }

  type ExactSendCall = {
    message: { customType?: string; content?: string; display?: boolean; details?: { deliveryId?: string } };
    options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
  };
  /** Record the FULL message + options so tests can assert the exact payload
   *  the delivery path hands to the captured host send (T1). */
  function recordingSendExact(calls: ExactSendCall[]): StableSend {
    return function recordingSendExact(this: unknown, msg, opts) {
      calls.push({ message: { ...msg }, options: opts ? { ...opts } : undefined });
      const fixture = this as {
        __deliveryEntries?: Array<Record<string, unknown>>;
        __deliveryHistory?: DeliveryHistory;
      };
      const deliveryId = msg.details?.deliveryId;
      if (deliveryId && fixture.__deliveryHistory) {
        fixture.__deliveryHistory.append({
          id: `entry-${fixture.__deliveryHistory.branch.length}`,
          type: "custom_message",
          customType: msg.customType ?? "workflow-result",
          details: msg.details,
        });
      }
      if (deliveryId && fixture.__deliveryEntries) {
        fixture.__deliveryEntries.push({
          type: "custom_message",
          customType: msg.customType,
          details: msg.details,
        });
      }
      return Promise.resolve();
    };
  }

  /**
   * A host session `pi` is bound to, the way Pi's runtime binds it: pi.sendMessage
   * reaches the session's sendCustomMessage, which sits on the class prototype as
   * on AgentSession so the capture probe can intercept it. `send` is what that
   * sendCustomMessage really does; a delivered result is persisted to the
   * session's history so the confirmed send can see it.
   */
  function boundHostSession(
    pi: ExtensionAPI,
    sessionId: string,
    send: StableSend,
    fields: Record<string, unknown> = {},
  ): TestHostSession {
    const history = createPersistedDeliveryHistory();
    const { sessionManager, ...rest } = fields;
    const session = new TestHostSession({
      isIdle: true,
      subscribe: () => () => {},
      __deliveryHistory: history,
      send,
      ...rest,
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => history.branch,
        getSessionFile: () => history.sessionFile,
        ...(sessionManager as object | undefined),
      },
    });
    _useHostSessionClassForTests(TestHostSession);
    routePiTo(pi, session);
    return session;
  }

  /** Make `pi.sendMessage` reach `session`, detached and with errors swallowed, as Pi's runtime does. */
  function routePiTo(pi: ExtensionAPI, session: { sendCustomMessage: (m: never, o: never) => unknown }): void {
    (pi as unknown as { sendMessage: (m: never, o: never) => void }).sendMessage = (message, options) => {
      void Promise.resolve(session.sendCustomMessage(message, options)).catch(() => {});
    };
  }

  function piCalls(pi: ExtensionAPI): DeliveryCall[] {
    // The session_start probe rides the same sendMessage spy; only result
    // deliveries count.
    return (pi as unknown as { _calls: DeliveryCall[] })._calls.filter(
      (c) => c.customType !== DELIVERY_PROBE_CUSTOM_TYPE,
    );
  }

  /** A finished run with a result; fields the delivery code does not read are left out. */
  function makeRun(overrides: Record<string, unknown> = {}): ManagedRun {
    return {
      runId: "test-run-1",
      sessionId: SESSION,
      snapshot: {
        name: "test-workflow",
        agentCount: 3,
        agents: [
          { id: "a1", status: "done", step: "agent 1", phase: "phase-1" },
          { id: "a2", status: "done", step: "agent 2", phase: "phase-1" },
          { id: "a3", status: "done", step: "agent 3", phase: "phase-2" },
        ],
        phases: [{ title: "phase-1" }, { title: "phase-2" }],
        currentPhase: "phase-2",
        startedAt: new Date(),
        completedAt: new Date(),
      },
      result: {
        agentCount: 3,
        durationMs: 1500,
        tokenUsage: { total: 50000, input: 25000, output: 25000 },
        result: { verdict: "## All tests passed\n\nEverything looks good!" },
      },
      ...overrides,
    } as unknown as ManagedRun;
  }

  function setup(
    pi: ExtensionAPI,
    manager: ReturnType<typeof createMockManager>,
    sessionId = SESSION,
    bindOpts: { stableSend?: StableSend; loadSettings?: () => WorkflowSettings } = {},
  ) {
    mod.installResultDelivery(pi, manager, bindOpts.loadSettings ? { loadSettings: bindOpts.loadSettings } : undefined);
    manager.setSessionId(sessionId);
    const stableSend = bindOpts.stableSend ?? recordingStableSend(pi as unknown as { _calls: DeliveryCall[] });
    mod.bindSessionDelivery(sessionId, pi, { manager, ...bindOpts, stableSend });
  }

  // ── deliverText: verdict path ──

  it("delivers verdict when result.result has verdict", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].customType, "workflow-result");
    assert.ok(calls[0].content.includes("All tests passed"), "should contain All tests passed");
    assert.ok(calls[0].content.includes("test-workflow"), "should contain test-workflow");
    assert.ok(calls[0].content.includes("3 agents"), "should contain 3 agents");
    // deliverText shows "N tok"; the cached segment is omitted with no cache reads.
    assert.ok(calls[0].content.includes("50k tok"), "should show the token count (input+output)");
    assert.ok(!calls[0].content.includes("cached"), "omits the cached segment when cacheRead is 0");
    assert.ok(calls[0].content.includes("1.5s"), "should contain 1.5s");
  });

  it("shows the fresh/cache split and cost in the delivery line", () => {
    const pi = createMockPi();
    // A caching model: little fresh input+output, most of the tokens are cheap cache reads.
    const manager = createMockManager(
      makeRun({
        result: {
          agentCount: 2,
          durationMs: 1000,
          tokenUsage: { input: 80000, output: 20000, total: 6100000, cacheRead: 6000000, cacheWrite: 0, cost: 6.7 },
          result: { verdict: "done" },
        },
      }),
    );

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(content.includes("100k tok"), `fresh (input+output) should read as tok; got: ${content}`);
    assert.ok(content.includes("6M cached"), `cacheRead should read as cached; got: ${content}`);
    assert.ok(content.includes("$6.70"), `cost should be shown; got: ${content}`);
  });

  it("falls back to the estimated total when the provider reported no usage", () => {
    const pi = createMockPi();
    // Estimate-only run: onUsage never fired, so the breakdown is all-zero while
    // run-level `total` carries the scalar estimate.
    const manager = createMockManager(
      makeRun({
        result: {
          agentCount: 2,
          durationMs: 1000,
          tokenUsage: { input: 0, output: 0, total: 800, cacheRead: 0, cacheWrite: 0, cost: 0 },
          result: { verdict: "done" },
        },
      }),
    );

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(content.includes("800 tok"), `the estimate should survive as the token count; got: ${content}`);
    assert.ok(!/\b0 tok/.test(content), `must not render a zero breakdown; got: ${content}`);
  });

  it("suppresses the token segment when the run-level aggregate is all-zero", () => {
    const pi = createMockPi();
    // e.g. a fully journal-replayed resume: every agent came from cache, nothing accrued.
    const manager = createMockManager(
      makeRun({
        result: {
          agentCount: 3,
          durationMs: 1500,
          tokenUsage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          result: { verdict: "done" },
        },
      }),
    );

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(!/\b0 tok/.test(content), `an all-zero aggregate must not render "0 tok"; got: ${content}`);
    assert.ok(content.includes("3 agents"), "the rest of the line is intact");
  });

  // ── deliverText: fallback chain ──

  it("falls back to report when verdict is absent", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { report: "Report body", verdict: "" } } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes("Report body"), "should contain Report body");
  });

  it("falls back to summary when verdict and report are absent", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { summary: "Short summary" } } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes("Short summary"), "should contain Short summary");
  });

  it("falls back to string result when result is a plain string", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: "Plain string result" } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes("Plain string result"), "should contain Plain string result");
  });

  it("falls back to synthesis when present", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { synthesis: "Synth body" } } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes("Synth body"), "should contain Synth body");
  });

  it("JSON-dumps object results without preferred fields", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { ok: true, n: 2 } } });
    const manager = createMockManager(run);

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.ok(calls[0].content.includes('"ok": true'), "should dump JSON");
  });

  it("truncates long JSON dumps and appends the result pointer", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { note: "z".repeat(500) } } });
    const manager = createMockManager(run, "/runs");

    setup(pi, manager);
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(content.includes("truncated"), "long dump is truncated");
    assert.ok(content.includes(join("/runs", "test-run-1.json")), "pointer still appended");
  });

  it("honours deliveredResultMaxChars from settings", () => {
    const pi = createMockPi();
    const run = makeRun({ result: { result: { note: "z".repeat(200) } } });
    const manager = createMockManager(run, "/runs");

    setup(pi as unknown as ExtensionAPI, manager, SESSION, {
      loadSettings: () => ({ deliveredResultMaxChars: 40 }),
    });
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi)[0].content;
    assert.ok(content.includes("truncated"), "settings threshold is applied");
    assert.ok(!content.includes("z".repeat(200)), "the body is cut at the configured threshold");
    assert.ok(content.includes(join("/runs", "test-run-1.json")), "pointer still appended");
  });

  // ── installResultDelivery: guard / session routing ──

  it("installs delivery only once — second call skips listener registration", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    // Second call: should not add another listener
    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);

    manager.emit("complete", { runId: "test-run-1" });
    const calls = piCalls(pi);
    assert.equal(calls.length, 1); // exactly once, not twice
  });

  it("does not crash when sendMessage throws (stale ctx); queues and flushes on rebind", async () => {
    const stalePi = {
      sendMessage: (_msg: unknown, _opts?: unknown) => {
        throw new Error("This extension ctx is stale");
      },
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const freshPi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(stalePi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, stalePi as unknown as ExtensionAPI, {
      manager,
      stableSend: () => {
        throw new Error("This extension ctx is stale");
      },
    });
    // Must not throw — the failed send leaves disk/memory pending.
    manager.emit("complete", { runId: "test-run-1" });
    // Sync throw still ACKs via a rejected/false thenable; wait out in-flight.
    await Promise.resolve();
    await Promise.resolve();

    // Factory-time install only refreshes; session_start rebinds + flushes.
    mod.installResultDelivery(freshPi as unknown as ExtensionAPI, manager);
    assert.equal(piCalls(freshPi).length, 0, "install alone must not flush — runtime may still be unbound");
    mod.bindSessionDelivery(SESSION, freshPi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(freshPi),
    });
    const calls = piCalls(freshPi);
    assert.equal(calls.length, 1, "rebind must flush onto the fresh pi");
    assert.ok(calls[0].content.includes("test-workflow"));
  });

  it("suspends live sends and flushes the queue when the next generation binds", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi1, manager);
    mod.suspendResultDelivery(manager);
    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(pi1).length, 0, "suspended delivery must not call the dying pi");

    mod.installResultDelivery(pi2 as unknown as ExtensionAPI, manager);
    assert.equal(piCalls(pi2).length, 0, "install alone must not flush before runtime bind");
    mod.bindSessionDelivery(SESSION, pi2 as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi2),
    });
    const calls = piCalls(pi2);
    assert.equal(calls.length, 1, "bind must deliver pending completion into the new session");
    assert.ok(calls[0].content.includes("All tests passed"));
  });

  it("re-queues an async sendMessage rejection and flushes it on the next bind", async () => {
    let rejectSend: ((err: Error) => void) | undefined;
    const failingPi = {
      sendMessage: (_msg: unknown, _opts?: unknown) =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const freshPi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(failingPi as unknown as ExtensionAPI, manager, SESSION, {
      stableSend: () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
    });
    manager.emit("complete", { runId: "test-run-1" });
    assert.ok(rejectSend, "stableSend should have returned a pending promise");
    rejectSend?.(new Error("network blip"));
    // Let the rejection microtask run and re-queue.
    await Promise.resolve();
    await Promise.resolve();

    mod.bindSessionDelivery(SESSION, freshPi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(freshPi),
    });
    const calls = piCalls(freshPi);
    assert.equal(calls.length, 1, "async failure must be retried on the fresh pi after rebind");
  });

  it("flushes immediately when an in-flight send rejects AFTER the next generation bound", async () => {
    // The real race: generation N's promise is still pending when generation
    // N+1 binds and flushes (empty queue). N's rejection must not leave the
    // content stranded until some later N+2 bind.
    let rejectSend: ((err: Error) => void) | undefined;
    const failingPi = {
      sendMessage: (_msg: unknown, _opts?: unknown) =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const freshPi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(failingPi as unknown as ExtensionAPI, manager, SESSION, {
      stableSend: () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
    });
    manager.emit("complete", { runId: "test-run-1" });
    assert.ok(rejectSend);

    // Next generation binds BEFORE the rejection lands.
    mod.bindSessionDelivery(SESSION, freshPi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(freshPi),
    });
    assert.equal(piCalls(freshPi).length, 0, "nothing queued yet — the in-flight send has not rejected");

    rejectSend?.(new Error("late network blip"));
    await Promise.resolve();
    await Promise.resolve();

    const calls = piCalls(freshPi);
    assert.equal(calls.length, 1, "late rejection must self-flush onto the already-bound generation");
    assert.ok(calls[0].content.includes("test-workflow"));
  });

  it("flushes pending delivery when an old generation succeeds after a new generation binds", async () => {
    let resolveSend: (() => void) | undefined;
    const oldPi = createMockPi();
    const freshPi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(oldPi, manager, SESSION, {
      stableSend: () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    });
    manager.emit("complete", { runId: "test-run-1" });
    assert.ok(resolveSend, "old generation owns the in-flight send");

    mod.bindSessionDelivery(SESSION, freshPi, { manager, stableSend: recordingStableSend(freshPi) });
    assert.equal(piCalls(freshPi).length, 0, "the pending old send still owns the lock before it settles");

    resolveSend?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(piCalls(freshPi).length, 1, "old-generation success hands pending delivery to the new endpoint");
    assert.equal(
      manager.getPersistence?.().load("test-run-1")?.pendingDelivery,
      undefined,
      "the fresh endpoint clears its flushed pending marker",
    );
  });

  it("hands a disk-only delivery to its persisted owner after an old send settles", async () => {
    const oldSession = "old-session";
    const newSession = "new-session";
    let resolveOld: (() => void) | undefined;
    const oldPi = createMockPi();
    const newPi = createMockPi();
    const manager = createMockManager(makeRun({ sessionId: oldSession }));

    setup(oldPi, manager, oldSession, {
      stableSend: () =>
        new Promise<void>((resolve) => {
          resolveOld = resolve;
        }),
    });
    manager.emit("complete", { runId: "test-run-1" });
    assert.ok(resolveOld, "the old owner has an in-flight delivery");

    const persistence = manager.getPersistence?.();
    const state = persistence?.load("test-run-1");
    assert.ok(state?.pendingDelivery, "the marker is durable before ownership changes");
    persistence?.save({ ...state, sessionId: newSession });
    manager.getRun = () => undefined;

    mod.bindSessionDelivery(newSession, newPi, { manager, stableSend: recordingStableSend(newPi) });
    mod.dropSessionDelivery(oldSession);
    assert.equal(piCalls(newPi).length, 0, "the old in-flight lock prevents an early duplicate");

    resolveOld?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(piCalls(newPi).length, 1, "old settlement flushes to the persisted disk-only owner");
    assert.equal(persistence?.load("test-run-1")?.pendingDelivery, undefined);
  });

  it("a failed send overlapping a re-bind cannot double-deliver", async () => {
    // Generation N's send fails; the generation-change retry re-arms the lock
    // (new token) and starts send 2. N's stale .finally must NOT release the
    // lock T2 holds — otherwise a third caller could start a duplicate send.
    const resolvers: Array<(err: Error) => void> = [];
    let sends = 0;
    const pi = createMockPi();
    const manager = createMockManager(makeRun({ sessionId: SESSION, runId: "run-double" }));
    const stableSend: StableSend = () => {
      sends++;
      return new Promise<never>((_resolve, reject) => {
        resolvers.push(reject);
      });
    };
    setup(pi, manager, SESSION, { stableSend });
    manager.emit("complete", { runId: "run-double" });
    assert.equal(sends, 1, "first in-flight send");

    mod.bindSessionDelivery(SESSION, pi, { manager, stableSend }); // generation bump
    resolvers[0](new Error("send failed")); // fail send 1 → release + generation retry
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(sends, 2, "generation-change flush retries the send exactly once");

    manager.emit("complete", { runId: "run-double" });
    assert.equal(sends, 2, "the retried send keeps its lock — no third delivery");
    resolvers[1]?.(new Error("test cleanup"));
  });

  it("retries a transient rejection without waiting for another session bind", async () => {
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);
    let sends = 0;

    setup(pi, manager, SESSION, {
      stableSend: () => {
        sends++;
        return sends === 1 ? Promise.reject(new Error("temporary send failure")) : Promise.resolve();
      },
    });
    manager.emit("complete", { runId: "test-run-1" });

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(sends, 2, "the live endpoint retries once without a rebind");
    assert.equal(run.pendingDelivery, undefined, "the successful retry clears pending delivery");
  });

  it("does not send until the pending marker is durable", async () => {
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);
    const getPersistence = manager.getPersistence;
    let failSave = true;
    let sends = 0;
    manager.getPersistence = () => {
      const persistence = getPersistence?.();
      assert.ok(persistence);
      return {
        ...persistence,
        save: (state: PersistedRunState) => {
          if (failSave) {
            failSave = false;
            throw new Error("disk temporarily unavailable");
          }
          persistence.save(state);
        },
      };
    };

    setup(pi, manager, SESSION, {
      stableSend: () => {
        sends++;
        return Promise.resolve();
      },
    });
    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(sends, 0, "an unpersisted marker is never sent");

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(sends, 1, "delivery resumes after marker persistence recovers");
    assert.equal(run.pendingDelivery, undefined);
  });

  it("keeps a bind without work TUI-safe and reports only when a delivery remains pending", () => {
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);
    const reports: string[] = [];
    const originalWarn = console.warn;
    const startupWarnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => startupWarnings.push(args);
    try {
      mod.installResultDelivery(pi, manager);
      manager.setSessionId(SESSION);
      mod.bindSessionDelivery(SESSION, pi, {
        manager,
        reportWarning: (message) => reports.push(message),
      });

      assert.deepEqual(startupWarnings, [], "bind must not write raw startup diagnostics over the TUI");
      assert.deepEqual(reports, [], "no warning before there is a pending delivery");

      manager.emit("complete", { runId: "test-run-1" });
      assert.ok(run.pendingDelivery, "completion persists its marker before delivery is attempted");
      assert.equal(reports.length, 1, "a deferred pending delivery is surfaced through the UI-safe reporter");
      assert.deepEqual(startupWarnings, [], "delivery diagnostics must not use console.warn");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("waits for an idle host, ignores queue_update, and ACKs only durable history", async () => {
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);
    const history = createPersistedDeliveryHistory();
    const sent: Array<{ customType: string; content: string; display: boolean; details?: { deliveryId?: string } }> =
      [];
    const listeners = new Set<
      (event: {
        type?: string;
        message?: { role?: string; customType?: string; details?: unknown };
        followUp?: unknown[];
      }) => void
    >();
    const emit = (event: {
      type?: string;
      message?: { role?: string; customType?: string; details?: unknown };
      followUp?: unknown[];
    }) => {
      for (const listener of listeners) listener(event);
    };

    const session = {
      isStreaming: true,
      isIdle: false,
      sessionManager: {
        getSessionId: () => SESSION,
        getBranch: () => history.branch,
        getSessionFile: () => history.sessionFile,
      },
      subscribe: (
        next: (event: { type?: string; message?: { role?: string; customType?: string; details?: unknown } }) => void,
      ) => {
        listeners.add(next);
        return () => listeners.delete(next);
      },
      sendCustomMessage: (message: (typeof sent)[number]) => {
        assert.equal(session.isStreaming, false, "busy hosts must not receive a custom follow-up");
        sent.push(message);
        return Promise.resolve();
      },
    };
    const hostSend = confirmedSessionSend(session, SESSION);
    mod.installResultDelivery(pi, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: hostSend });
    manager.emit("complete", { runId: "test-run-1" });
    await Promise.resolve();

    assert.equal(sent.length, 0, "busy host receives no result send");
    emit({ type: "queue_update", followUp: [] });
    await Promise.resolve();
    assert.equal(sent.length, 0, "queue_update is not an idle or retry signal");
    session.isStreaming = false;
    session.isIdle = true;
    emit({ type: "agent_settled" });
    await Promise.resolve();
    assert.equal(sent.length, 1, "idle host receives exactly one result send");
    assert.ok(run.pendingDelivery, "send acceptance alone must not clear the marker");
    const details = sent[0].details;
    emit({ type: "message_end", message: { role: "custom", customType: "workflow-result", details } });
    history.append({ id: "delivery-entry", type: "custom_message", customType: "workflow-result", details });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(run.pendingDelivery, undefined, "matching durable message_end ACKs the delivery");
  });

  it("fails closed when idle-host message persistence cannot be inspected", async () => {
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);
    const hostSend = confirmedSessionSend(
      {
        isStreaming: true,
        isIdle: false,
        sessionManager: {
          getSessionId: () => SESSION,
          getBranch: () => {
            throw new Error("history unavailable");
          },
          getSessionFile: () => "/session.jsonl",
        },
        subscribe: () => () => {},
        sendCustomMessage: () => Promise.resolve(),
      },
      SESSION,
    );
    mod.installResultDelivery(pi, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: hostSend });
    manager.emit("complete", { runId: "test-run-1" });
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(run.pendingDelivery, "an unverifiable message_end cannot ACK delivery");
  });

  it("suspending an unsent idle waiter leaves its durable marker for the replacement", async () => {
    const oldPi = createMockPi();
    const freshPi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);
    let sent = 0;

    const hostSend = confirmedSessionSend(
      {
        isStreaming: true,
        isIdle: false,
        sessionManager: {
          getSessionId: () => SESSION,
        },
        subscribe: () => () => {},
        sendCustomMessage: () => {
          sent++;
          return Promise.resolve();
        },
      },
      SESSION,
    );
    mod.installResultDelivery(oldPi, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, oldPi, { manager, stableSend: hostSend });
    manager.emit("complete", { runId: "test-run-1" });
    await Promise.resolve();
    assert.equal(sent, 0, "the busy generation owns no custom queue item");
    assert.ok(run.pendingDelivery, "the unsent marker remains durable");

    mod.suspendSessionDelivery(SESSION);
    mod.bindSessionDelivery(SESSION, freshPi, { manager, stableSend: recordingStableSend(freshPi) });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(piCalls(freshPi).length, 1, "the replacement session receives the pending result");
    assert.equal(run.pendingDelivery, undefined);
  });

  it("retries a failed marker clear without delivering the result twice", async () => {
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);
    const getPersistence = manager.getPersistence;
    let failClear = true;
    let sends = 0;
    manager.getPersistence = () => {
      const persistence = getPersistence?.();
      assert.ok(persistence);
      return {
        ...persistence,
        save: (state: PersistedRunState) => {
          if (failClear && !("pendingDelivery" in state)) {
            failClear = false;
            throw new Error("disk temporarily unavailable");
          }
          persistence.save(state);
        },
      };
    };

    setup(pi, manager, SESSION, {
      stableSend: () => {
        sends++;
        return Promise.resolve();
      },
    });
    manager.emit("complete", { runId: "test-run-1" });
    await Promise.resolve();
    assert.ok(run.pendingDelivery, "failed clear keeps the marker until persistence recovers");

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(sends, 1, "clear retries never resend an already delivered result");
    assert.equal(run.pendingDelivery, undefined);
  });

  it("deduplicates a stale marker against the originating session history", async () => {
    const deliveryId = "existing-delivery";
    const pi = createMockPi();
    const run = makeRun({ pendingDelivery: { kind: "complete", deliveryId } });
    const manager = createMockManager(run);
    let sends = 0;
    const history = createPersistedDeliveryHistory();
    history.append({
      id: "persisted-delivery",
      type: "custom_message",
      customType: "workflow-result",
      details: { deliveryId },
    });

    const hostSend = confirmedSessionSend(
      {
        isStreaming: false,
        sessionManager: {
          getSessionId: () => SESSION,
          getBranch: () => history.branch,
          getSessionFile: () => history.sessionFile,
        },
        sendCustomMessage: () => {
          sends++;
          return Promise.resolve();
        },
      },
      SESSION,
    );
    mod.installResultDelivery(pi, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: hostSend });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(sends, 0, "an already persisted delivery is not sent twice");
    assert.equal(run.pendingDelivery, undefined, "the stale marker is cleared");
  });

  it("does not let an older ACK clear a newer delivery marker", async () => {
    const resolvers: Array<() => void> = [];
    const sent: Array<{ details?: { deliveryId?: string } }> = [];
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);

    setup(pi, manager, SESSION, {
      stableSend: (message) => {
        sent.push(message);
        return new Promise<void>((resolve) => resolvers.push(resolve));
      },
    });
    manager.emit("complete", { runId: "test-run-1" });
    const firstId = run.pendingDelivery?.deliveryId;
    manager.emit("error", { runId: "test-run-1", error: { message: "newer failure" } });
    const newer = run.pendingDelivery;
    assert.equal(newer?.kind, "text");
    assert.notEqual(newer?.deliveryId, firstId);

    resolvers[0]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2, "the newer marker is flushed after the older ACK settles");
    assert.equal(run.pendingDelivery?.deliveryId, newer?.deliveryId, "the old ACK cannot clear the newer marker");

    resolvers[1]();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(run.pendingDelivery, undefined);
  });

  it("a second result of one run is a new delivery even after the first was sent but not cleared", async () => {
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);
    const persistence = manager.getPersistence();
    persistence.save({ runId: "test-run-1", sessionId: SESSION, status: "completed" } as PersistedRunState);
    const sent: string[] = [];
    // The first send is confirmed, but clearing its marker fails once, as a
    // locked record file would make it.
    let refuseClear = true;
    const updateMetadata = persistence.updateMetadata;
    manager.getPersistence = () => ({
      ...persistence,
      updateMetadata: (id: string, patch: Record<string, unknown>, expected?: string) => {
        if (refuseClear && "pendingDelivery" in patch && patch.pendingDelivery === undefined) {
          refuseClear = false;
          throw new Error("EBUSY");
        }
        return updateMetadata(id, patch, expected);
      },
    });
    setup(pi, manager, SESSION, {
      stableSend: (message) => {
        sent.push(String(message.content));
        return Promise.resolve();
      },
    });

    run.result = { ...(run.result as WorkflowRunResult), result: { verdict: "FIRST_RESULT" } };
    manager.emit("complete", { runId: "test-run-1" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const first = run.pendingDelivery?.deliveryId;
    assert.ok(first, "the uncleared first delivery keeps its marker");

    run.result = { ...(run.result as WorkflowRunResult), result: { verdict: "SECOND_RESULT" } };
    manager.emit("complete", { runId: "test-run-1" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(
      sent.some((content) => content.includes("SECOND_RESULT")),
      "the second result is sent",
    );
    assert.equal(run.pendingDelivery, undefined);
  });

  it("a retry from a settled copy never overwrites the marker a newer execution wrote", async () => {
    const pi = createMockPi();
    const run = makeRun({ pendingDelivery: { kind: "complete", deliveryId: "old-delivery" } });
    const manager = createMockManager(run);
    const persistence = manager.getPersistence();
    persistence.save({
      runId: "test-run-1",
      sessionId: SESSION,
      status: "completed",
      result: "newer result",
      pendingDelivery: { kind: "text", text: "NEWER_TEXT", deliveryId: "new-delivery" },
    } as PersistedRunState);
    const sent: string[] = [];
    setup(pi, manager, SESSION, {
      stableSend: (message) => {
        sent.push(String(message.content));
        return Promise.resolve();
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      (persistence.loadPreview("test-run-1")?.pendingDelivery as { deliveryId?: string } | undefined)?.deliveryId ??
        "cleared",
      "cleared",
      "the newer delivery was sent and cleared, never replaced by the old one",
    );
    assert.ok(sent.some((content) => content.includes("NEWER_TEXT")));
    assert.ok(!sent.some((content) => content.includes("All tests passed")), "the stale copy's result is not sent");
  });

  it("a reloaded module copy replaces the previous listeners instead of adding a second set", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    mod.installResultDelivery(pi, manager);
    // A host that reloads the module graph starts with empty module state but
    // hands over the same manager.
    mod._resetDeliveryRegistriesForTests();
    mod.installResultDelivery(createMockPi(), manager);
    assert.equal(manager.listenerCount("complete"), 1);
    assert.equal(manager.listenerCount("error"), 1);
    assert.equal(manager.listenerCount("paused"), 1);
  });

  it("cancels active streaming waiters on suspend so they cannot ACK a later generation", async () => {
    const pi = createMockPi();
    const freshPi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);
    let gen1Listener:
      | ((event: { type?: string; message?: { role?: string; customType?: string; details?: unknown } }) => void)
      | undefined;

    const hostSend = confirmedSessionSend(
      {
        isStreaming: true,
        // A real host can confirm deliveries, so the send waits for idle
        // instead of rejecting at once; that wait is what suspend must cancel.
        sessionManager: {
          getSessionId: () => SESSION,
          getBranch: () => [],
          getSessionFile: () => join(tmpdir(), "streaming-waiter-session.jsonl"),
        },
        subscribe: (next: typeof gen1Listener) => {
          gen1Listener = next;
          return () => {
            if (gen1Listener === next) gen1Listener = undefined;
          };
        },
        sendCustomMessage: () => {
          return Promise.resolve();
        },
      },
      SESSION,
    );

    mod.installResultDelivery(pi, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: hostSend });
    manager.emit("complete", { runId: "test-run-1" });
    await Promise.resolve();
    assert.ok(run.pendingDelivery);
    assert.ok(gen1Listener, "the send is waiting for the streaming host to go idle");

    // Suspend generation 1
    mod.suspendSessionDelivery(SESSION);

    // Generation 1's subscriber should have been unsubscribed by suspend
    assert.equal(gen1Listener, undefined, "streaming waiter was unsubscribed on suspend");

    // Bind generation 2
    mod.bindSessionDelivery(SESSION, freshPi, { manager, stableSend: recordingStableSend(freshPi) });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(piCalls(freshPi).length, 1, "generation 2 received the pending delivery");
    assert.equal(run.pendingDelivery, undefined);
  });

  it("ignores late ACK if the endpoint generation has changed", async () => {
    let resolveSend: (() => void) | undefined;
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);

    setup(pi, manager, SESSION, {
      stableSend: () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    });
    manager.emit("complete", { runId: "test-run-1" });
    await Promise.resolve();
    const deliveryId = run.pendingDelivery?.deliveryId;
    assert.ok(deliveryId);

    // Rebind session (bumps endpoint generation)
    mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: () => Promise.resolve() });

    // Old send resolves late
    resolveSend?.();
    await Promise.resolve();
    await Promise.resolve();

    // The stale send resolution must not have cleared the pending marker
    assert.equal(run.pendingDelivery?.deliveryId, deliveryId, "stale generation send cannot ACK");
  });

  it("registers turn_end once per process and dispatches to the CURRENT manager", async () => {
    const pi = createMockPi();
    // m1 = the OLD project's manager; m2 = current after a cross-project
    // session_start rebuild. Per-manager registration would stack one handler
    // per rebuild, each closing over its own (stale) manager.
    const m1 = createMockManager(makeRun());
    m1.setSessionId("sess-old");
    const m2 = createMockManager(makeRun());
    m2.setSessionId("sess-new");

    mod.installResultDelivery(pi, m1);
    mod.installResultDelivery(pi, m2);
    boundHostSession(pi, "sess-new", recordingStableSend(pi));

    pi.emit?.("turn_end", {}, {});
    await Promise.resolve();

    assert.equal(pi._onCount("turn_end"), 1, "a rebuild does not stack another turn_end handler");
    assert.ok(mod._getSessionDeliveryEndpointForTests("sess-new"), "turn_end dispatched to the current manager");
    assert.equal(
      mod._getSessionDeliveryEndpointForTests("sess-old"),
      undefined,
      "no stale handler binding the old manager's session",
    );
  });

  it("registers turn_end per ExtensionAPI generation, not once per process", async () => {
    // The built dist module is cached across pi session
    // generations while pi re-runs the factory with a NEW ExtensionAPI — a
    // bare module-level boolean would leave generations 2+ with NO turn_end
    // handler (fail-closed deliveries never re-probed until session_start).
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const m1 = createMockManager(makeRun());
    m1.setSessionId("sess-g1");
    const m2 = createMockManager(makeRun());
    m2.setSessionId("sess-g2");

    mod.installResultDelivery(pi1, m1);
    mod.installResultDelivery(pi2, m2); // generation 2: same module, NEW pi
    boundHostSession(pi2, "sess-g2", recordingStableSend(pi2));

    pi2.emit?.("turn_end", {}, {});
    await Promise.resolve();

    assert.ok(mod._getSessionDeliveryEndpointForTests("sess-g2"), "generation-2 pi must have its own turn_end handler");
  });

  it("keeps A/B/A turn_end handlers per instance and dispatches each to its latest manager", async () => {
    const piA = createMockPi();
    const piB = createMockPi();
    const oldA = createMockManager(makeRun());
    oldA.setSessionId("sess-a-old");
    const managerB = createMockManager(makeRun());
    managerB.setSessionId("sess-b");
    const latestA = createMockManager(makeRun());
    latestA.setSessionId("sess-a-new");

    mod.installResultDelivery(piA, oldA);
    mod.installResultDelivery(piB, managerB);
    mod.installResultDelivery(piA, latestA);

    assert.equal(piA._onCount("turn_end"), 1, "A registers turn_end once across A/B/A installs");
    assert.equal(piB._onCount("turn_end"), 1, "B registers turn_end once");

    // Each pi is bound to its own live session; a probe for any other id fails.
    boundHostSession(piA, "sess-a-new", recordingStableSend(piA));
    boundHostSession(piB, "sess-b", recordingStableSend(piB));

    // No ctx means each callback must obtain the manager stored for ITS pi.
    piA.emit?.("turn_end", {}, {});
    piB.emit?.("turn_end", {}, {});
    await Promise.resolve();

    assert.ok(mod._getSessionDeliveryEndpointForTests("sess-a-new"), "A uses A's newest manager");
    assert.ok(mod._getSessionDeliveryEndpointForTests("sess-b"), "B keeps B's own manager");
    assert.equal(
      mod._getSessionDeliveryEndpointForTests("sess-a-old"),
      undefined,
      "A's stale manager is never consulted",
    );
  });

  it("refreshes a live same-pi endpoint to a newly installed manager without rebinding transport", async () => {
    const pi = createMockPi();
    const first = createMockManager(makeRun({ sessionId: SESSION }));
    first.setSessionId(SESSION);
    let sends = 0;
    const stableSend: StableSend = () => {
      sends++;
      return Promise.resolve();
    };
    mod.installResultDelivery(pi, first);
    mod.bindSessionDelivery(SESSION, pi, { manager: first, stableSend });
    const endpointBefore = mod._getSessionDeliveryEndpointForTests(SESSION);
    assert.ok(endpointBefore?.hasSend, "first manager binds the live session transport");

    const second = createMockManager(
      makeRun({ sessionId: SESSION, pendingDelivery: { kind: "text", text: "second-manager pending" } }),
    );
    second.setSessionId(SESSION);
    mod.installResultDelivery(pi, second);

    // No bind follows: turn_end must use the replacement manager but leave the
    // current session endpoint's transport/generation/suspension untouched.
    pi.emit?.("turn_end", {}, {});
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(sends, 1, "turn_end flushes the replacement manager's pending run");
    assert.equal(second.getRun("test-run-1")?.pendingDelivery, undefined, "replacement manager receives the ACK");
    assert.deepEqual(mod._getSessionDeliveryEndpointForTests(SESSION), endpointBefore);
  });

  it("recovers and flushes pending delivery on turn_end when sender becomes available", async () => {
    const pi = createMockPi();
    const run = makeRun({ sessionId: SESSION });
    const manager = createMockManager(run);
    manager.setSessionId(SESSION);

    // Initial install: endpoint has NO thenable send function (fail-closed)
    mod.installResultDelivery(pi, manager);
    mod.bindSessionDelivery(SESSION, pi, { manager });
    manager.emit("complete", { runId: "test-run-1" });
    await Promise.resolve();

    assert.equal(piCalls(pi).length, 0, "no send while sender is unavailable");
    assert.ok(run.pendingDelivery, "delivery stays pending");

    // Pi binds the runtime without a new session_start.
    boundHostSession(pi, SESSION, recordingStableSend(pi));

    // A normal conversation turn ends
    pi.emit?.("turn_end", {}, { sessionManager: { getSessionId: () => SESSION } });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(piCalls(pi).length, 1, "pending delivery flushed on turn_end idle recovery");
    assert.equal(run.pendingDelivery, undefined, "pending delivery cleared");
  });

  it("never silently drops pending deliveries when the queue grows past the soft cap", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    // Distinct run ids so each complete has its own pending marker.
    const runs = Array.from({ length: 40 }, (_, i) =>
      makeRun({ runId: `run-${i}`, result: { result: { verdict: `v-${i}` }, agentCount: 1, durationMs: 1 } }),
    );
    const manager = createMockManager(runs[0]);
    // Inject all runs into getRun/listLiveRuns
    const byId = new Map(runs.map((r) => [r.runId as string, r]));
    manager.getRun = (id: string) => byId.get(id);
    manager.listLiveRuns = () => [...byId.values()];

    setup(pi1, manager);
    mod.suspendResultDelivery(manager);
    for (const r of runs) {
      manager.emit("complete", { runId: r.runId });
    }

    mod.bindSessionDelivery(SESSION, pi2 as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi2),
    });
    const calls = piCalls(pi2);
    assert.equal(calls.length, 40, "soft-cap must warn, never shift() away a queued result");
  });

  it("keeps delivery suspended across factory install until bindSessionDelivery", () => {
    const unboundPi = {
      sendMessage: () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
      },
      registerTool: () => {},
      on: () => {},
      getActiveTools: () => [],
      setActiveTools: () => {},
      reload: () => Promise.resolve(),
    };
    const boundPi = createMockPi();
    const manager = createMockManager(makeRun());

    // Simulate extension factory: install only (no endpoint yet — fail closed).
    mod.installResultDelivery(unboundPi as unknown as ExtensionAPI, manager);
    manager.emit("complete", { runId: "test-run-1" });
    // Re-install as a fresh factory would (still pre-bindCore).
    mod.installResultDelivery(unboundPi as unknown as ExtensionAPI, manager);
    assert.equal(piCalls(boundPi).length, 0, "must not attempt send while runtime unbound");

    // session_start: bind the session endpoint with the live pi.
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, boundPi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(boundPi),
    });
    const calls = piCalls(boundPi);
    assert.equal(calls.length, 1, "session_start bind flushes the pre-bind disk pending");
  });

  // ── Only background runs are delivered ──

  // ── Error event ──

  it("delivers error message on error event for background runs", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    manager.emit("error", { runId: "test-run-1", error: { message: "Something went wrong" } });

    const calls = piCalls(pi);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("failed"), "should contain failed");
    assert.ok(calls[0].content.includes("Something went wrong"), "should contain Something went wrong");
  });

  // ── Paused (usage-limit checkpoint) event ──

  it("delivers a resumable checkpoint message on a usage-limit paused event", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    manager.emit("paused", {
      runId: "test-run-1",
      reason: "usage_limit",
      error: { message: "Codex usage limit reached (plus plan)." },
      resetHint: "Resets in ~3h",
    });

    const calls = piCalls(pi);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content.includes("paused"), "should say paused");
    assert.ok(
      calls[0].content.includes('subagents_control action "resume", runId "test-run-1"'),
      "should name the resume action",
    );
    assert.ok(calls[0].content.includes("Resets in ~3h"), "should include the reset hint");
    assert.ok(!calls[0].content.includes("failed"), "should not say failed");
  });

  it("ignores a manual pause (no reason) — no delivery", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    manager.emit("paused", { runId: "test-run-1" });

    const calls = piCalls(pi);
    assert.equal(calls.length, 0);
  });

  it("tells the model how to answer a script waiting at a durable checkpoint", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi, manager);
    manager.emit("paused", {
      runId: "test-run-1",
      reason: "workflow_checkpoint",
      checkpoint: { checkpointId: "publish-1", kind: "approval", payload: { draft: "x".repeat(900) } },
    });

    const calls = piCalls(pi);
    assert.equal(calls.length, 1);
    const content = calls[0].content;
    assert.match(content, /waiting at checkpoint "publish-1" \(approval\)/);
    assert.ok(
      content.includes('subagents_control action "resume", runId "test-run-1", checkpointId "publish-1"'),
      "names the exact resume call",
    );
    assert.ok(content.includes("…") && content.length < 900, "previews a long payload instead of copying it");
  });

  it("does not deliver or trigger a turn when a real background run is manually paused, then resumes only explicitly", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-pause-delivery-"));
    const agent = controlledAgent();
    const manager = new WorkflowManager({ cwd, agent: agent.runner });
    const pi = createMockPi();
    const errors: unknown[] = [];
    manager.on("error", (event) => errors.push(event));

    try {
      mod.installResultDelivery(pi, manager);
      manager.setSessionId(SESSION);
      mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: recordingStableSend(pi) });

      const { runId, promise } = manager.startInBackground(lifecycleScript);
      await agent.waitForCalls(1);

      assert.equal(manager.pause(runId), true);
      agent.resolve(0);
      await promise.catch(() => {});
      await Promise.resolve();

      assert.equal(manager.getRun(runId)?.status, "paused");
      assert.equal(agent.calls(), 1, "pause must not restart the workflow");
      assert.equal(errors.length, 0, "manual pause teardown is not an unexpected error");
      assert.equal(piCalls(pi).length, 0, "manual pause must not deliver a failed background result");

      assert.equal(await manager.resume(runId), true, "only an explicit resume restarts the workflow");
      await agent.waitForCalls(2);
      agent.resolve(1, "resumed");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const calls = piCalls(pi);
      assert.equal(calls.length, 1, "the explicitly resumed completion is delivered once");
      assert.equal(calls[0].triggerTurn, true, "only the real completion continues the conversation");
      assert.match(calls[0].content, /finished/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not deliver or trigger a turn when a real background run is manually stopped, then continues only explicitly", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-stop-delivery-"));
    const agent = controlledAgent();
    const manager = new WorkflowManager({ cwd, agent: agent.runner });
    const pi = createMockPi();
    const errors: unknown[] = [];
    manager.on("error", (event) => errors.push(event));

    try {
      mod.installResultDelivery(pi, manager);
      manager.setSessionId(SESSION);
      mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: recordingStableSend(pi) });

      const { runId, promise } = manager.startInBackground(lifecycleScript);
      await agent.waitForCalls(1);

      assert.equal(manager.stop(runId), true);
      agent.resolve(0);
      await promise.catch(() => {});
      await Promise.resolve();

      assert.equal(manager.getRun(runId)?.status, "aborted");
      assert.equal(errors.length, 0, "manual stop teardown is not an unexpected error");
      assert.equal(piCalls(pi).length, 0, "manual stop must not deliver a failed background result");

      assert.equal(await manager.resume(runId), true, "only an explicit resume continues a stopped run");
      await agent.waitForCalls(2);
      agent.resolve(1, "resumed");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const calls = piCalls(pi);
      assert.equal(calls.length, 1, "the explicitly resumed completion is delivered once");
      assert.match(calls[0].content, /finished/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  for (const action of ["pause", "stop"] as const) {
    it(`does not let a late ${action} hide a run-fatal error while a sibling drains`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), `pi-dw-fatal-${action}-`));
      const agent = fatalThenDrainAgent();
      const manager = new WorkflowManager({ cwd, agent: agent.runner });
      const pi = createMockPi();
      const errors: Array<{ error?: WorkflowError }> = [];
      manager.on("error", (event) => errors.push(event));

      try {
        mod.installResultDelivery(pi, manager);
        manager.setSessionId(SESSION);
        mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: recordingStableSend(pi) });

        const { runId, promise } = manager.startInBackground(fatalControlRaceScript);
        await agent.waitForSiblingAbort();
        assert.equal(manager[action](runId), true, `late ${action} request is accepted while the sibling drains`);

        agent.settleSibling();
        await promise.catch(() => {});
        await Promise.resolve();

        assert.equal(manager.getRun(runId)?.status, "failed", "the earlier run-fatal error wins the lifecycle state");
        assert.equal(errors.length, 1, "the earlier run-fatal error remains observable");
        assert.equal(errors[0]?.error?.code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
        const calls = piCalls(pi);
        assert.equal(calls.length, 1, "the real failure is delivered to the originating conversation");
        assert.equal(calls[0].triggerTurn, true);
        assert.match(calls[0].content, /fatal sibling failure/);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  for (const action of ["pause", "stop"] as const) {
    it(`keeps an earlier usage-limit checkpoint through a late ${action}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), `pi-dw-usage-before-${action}-`));
      const agent = usageLimitThenDrainAgent();
      const manager = new WorkflowManager({ cwd, agent: agent.runner });
      const pi = createMockPi();
      const errors: unknown[] = [];
      let arms = 0;
      const scheduler = new UsageLimitScheduler(manager, {
        setTimer: () => {
          arms++;
          return {};
        },
        clearTimer: () => {},
      });
      manager.on("error", (event) => errors.push(event));

      try {
        mod.installResultDelivery(pi, manager);
        manager.setSessionId(SESSION);
        mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: recordingStableSend(pi) });

        const { runId, promise } = manager.startInBackground(usageLimitControlRaceScript);
        await agent.waitForSiblingAbort();
        assert.equal(manager[action](runId), true, `late ${action} is accepted while the sibling drains`);

        agent.settleSibling();
        await promise.catch(() => {});
        await Promise.resolve();

        assert.equal(manager.getRun(runId)?.status, "paused", "the earlier quota checkpoint wins the final state");
        assert.equal(errors.length, 0, "a usage limit is not delivered as a generic error");
        const persisted = manager.getPersistence().load(runId);
        assert.equal(persisted?.pauseReason, "usage_limit");
        assert.equal(persisted?.resetHint, "Resets in 1m");
        assert.equal(arms, 1, "the usage-limit scheduler is armed after the final pause");
        const calls = piCalls(pi);
        assert.equal(calls.length, 1, "the quota checkpoint is delivered once");
        assert.equal(calls[0].triggerTurn, true);
        assert.match(calls[0].content, /paused.*Resets in 1m/i);
      } finally {
        scheduler.dispose();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  for (const action of ["pause", "stop"] as const) {
    it(`does not let a late usage-limit result revive an earlier ${action}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), `pi-dw-${action}-before-usage-`));
      const agent = lateUsageLimitAgent();
      const manager = new WorkflowManager({ cwd, agent: agent.runner });
      const pi = createMockPi();
      let arms = 0;
      const scheduler = new UsageLimitScheduler(manager, {
        setTimer: () => {
          arms++;
          return {};
        },
        clearTimer: () => {},
      });

      try {
        mod.installResultDelivery(pi, manager);
        manager.setSessionId(SESSION);
        mod.bindSessionDelivery(SESSION, pi, { manager, stableSend: recordingStableSend(pi) });

        const { runId, promise } = manager.startInBackground(lifecycleScript);
        await agent.waitForStart();
        assert.equal(manager[action](runId), true);

        agent.rejectWithUsageLimit();
        await promise.catch(() => {});
        await Promise.resolve();

        const expectedStatus = action === "pause" ? "paused" : "aborted";
        assert.equal(manager.getRun(runId)?.status, expectedStatus);
        assert.equal(manager.getPersistence().load(runId)?.pauseReason, undefined);
        assert.equal(arms, 0, "a late quota result after user control must not arm auto-resume");
        assert.equal(piCalls(pi).length, 0, "a late quota result after user control must not trigger a turn");
      } finally {
        scheduler.dispose();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  // ── Session routing ──

  it("session_start shape: a bind without stableSend captures the bound host session and delivers", async () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    boundHostSession(pi, SESSION, recordingStableSend(pi));

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    // Production session_start never passes stableSend.
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "test-run-1" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const calls = piCalls(pi);
    assert.equal(calls.length, 1, "the captured host send is the production ACK path");
    assert.equal(calls[0].triggerTurn, true, "host sendCustomMessage must triggerTurn");
    assert.ok(calls[0].content.includes("All tests passed"));
    assert.equal(manager.getPersistence().load("test-run-1")?.pendingDelivery, undefined, "cleared after the ACK");
  });

  it("parallel sessions: each pi captures only the session it is bound to", async () => {
    const piA = createMockPi();
    const piB = createMockPi();
    const managerA = createMockManager(makeRun({ sessionId: "sess-A", runId: "run-A" }));
    const managerB = createMockManager(
      makeRun({
        sessionId: "sess-B",
        runId: "run-B",
        result: { result: { verdict: "from-B" }, agentCount: 1, durationMs: 1 },
      }),
    );
    managerA.setSessionId("sess-A");
    managerB.setSessionId("sess-B");
    boundHostSession(piA, "sess-A", recordingStableSend(piA));
    boundHostSession(piB, "sess-B", recordingStableSend(piB));

    mod.installResultDelivery(piA as unknown as ExtensionAPI, managerA);
    mod.bindSessionDelivery("sess-A", piA as unknown as ExtensionAPI, { manager: managerA });
    mod.installResultDelivery(piB as unknown as ExtensionAPI, managerB);
    mod.bindSessionDelivery("sess-B", piB as unknown as ExtensionAPI, { manager: managerB });
    assert.equal(mod._getSessionDeliveryEndpointForTests("sess-A")?.hasSend, true);
    assert.equal(mod._getSessionDeliveryEndpointForTests("sess-B")?.hasSend, true);

    managerA.emit("complete", { runId: "run-A" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(piCalls(piA).length, 1, "origin A receives");
    assert.equal(piCalls(piB).length, 0, "sibling B must not receive A's result");
    assert.ok(piCalls(piA)[0].content.includes("All tests passed"));

    managerB.emit("complete", { runId: "run-B" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(piCalls(piA).length, 1, "A must not receive B's result");
    assert.equal(piCalls(piB).length, 1, "origin B receives its own result");
    assert.ok(piCalls(piB)[0].content.includes("from-B"));
  });

  it("each bind probes once through pi.sendMessage and delivers through the captured send", async () => {
    const pi = createMockPi();
    const manager = createMockManager(
      makeRun({
        sessionId: "sess-quiet",
        runId: "run-quiet",
        result: { result: { verdict: "delivered" }, agentCount: 1, durationMs: 1 },
      }),
    );
    const session = boundHostSession(pi, "sess-quiet", recordingStableSend(pi));
    let probeCalls = 0;
    (pi as unknown as { sendMessage: (m: { customType?: string }, o: unknown) => void }).sendMessage = (
      message,
      options,
    ) => {
      if (message.customType === DELIVERY_PROBE_CUSTOM_TYPE) probeCalls++;
      void Promise.resolve(session.sendCustomMessage(message, options as never)).catch(() => {});
    };

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId("sess-quiet");
    mod.bindSessionDelivery("sess-quiet", pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "run-quiet" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(probeCalls, 1, "exactly one probe per bind");
    assert.equal(piCalls(pi).length, 1, "delivery flows after probe capture");
    assert.ok(piCalls(pi)[0].content.includes("delivered"));

    mod.bindSessionDelivery("sess-quiet", pi as unknown as ExtensionAPI, { manager });
    assert.equal(probeCalls, 2, "a rebind captures the live session again");
  });

  it("a bind whose probe reaches a different session stays fail-closed", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun({ sessionId: "sess-expected", runId: "run-expected" }));
    boundHostSession(pi, "sess-other", recordingStableSend(pi));

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId("sess-expected");
    mod.bindSessionDelivery("sess-expected", pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "run-expected" });

    assert.equal(mod._getSessionDeliveryEndpointForTests("sess-expected")?.hasSend, false);
    assert.equal(piCalls(pi).length, 0, "another session never receives the result");
    assert.ok(manager.getPersistence?.().load("run-expected")?.pendingDelivery, "pending stays on disk");
  });

  it("probe failure keeps bind fail-closed with pending on disk", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun({ sessionId: "sess-throws", runId: "run-throws" }));
    let probeCalls = 0;
    (pi as unknown as { sendMessage: (m: unknown, o: unknown) => void }).sendMessage = () => {
      probeCalls++;
      throw new Error("Extension runtime not initialized.");
    };

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId("sess-throws");
    mod.bindSessionDelivery("sess-throws", pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "run-throws" });

    assert.equal(probeCalls, 1, "probe attempted");
    assert.equal(piCalls(pi).length, 0, "no delivery without a captured send");
    assert.ok(manager.getPersistence?.().load("run-throws")?.pendingDelivery, "pending stays on disk");
  });

  it("a rebind captures the session live now, never an earlier one with the same id", async () => {
    const oldPi = createMockPi();
    const newPi = createMockPi();
    const manager = createMockManager(makeRun());
    boundHostSession(oldPi, SESSION, recordingStableSend(oldPi));
    mod.installResultDelivery(oldPi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, oldPi as unknown as ExtensionAPI, { manager });

    // The id comes back in a new host session, e.g. /resume of the same file.
    mod.dropSessionDelivery(SESSION);
    boundHostSession(newPi, SESSION, recordingStableSend(newPi));
    mod.bindSessionDelivery(SESSION, newPi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "test-run-1" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(piCalls(oldPi).length, 0, "the earlier session is not used");
    assert.equal(piCalls(newPi).length, 1, "the live session receives the result");
  });

  it("the probe is capture-only: it never reaches the session's real send", () => {
    const pi = createMockPi();
    let realSends = 0;
    boundHostSession(pi, "sess-probe-only", () => {
      realSends++;
      return Promise.resolve();
    });

    mod.bindSessionDelivery("sess-probe-only", pi as unknown as ExtensionAPI);

    assert.equal(realSends, 0, "the probe is never appended, persisted, or turned");
    assert.equal(mod._getSessionDeliveryEndpointForTests("sess-probe-only")?.hasSend, true, "the probe captured");
  });

  it("failed probe is retried on the next bind", async () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun({ sessionId: "sess-retry", runId: "run-retry" }));
    let sendMessageCalls = 0;
    (pi as unknown as { sendMessage: (m: unknown, o: unknown) => void }).sendMessage = () => {
      sendMessageCalls++;
      throw new Error("Extension runtime not initialized.");
    };

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId("sess-retry");
    mod.bindSessionDelivery("sess-retry", pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "run-retry" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sendMessageCalls, 1);
    assert.equal(piCalls(pi).length, 0, "first bind fail-closed");
    assert.ok(manager.getPersistence?.().load("run-retry")?.pendingDelivery, "pending stays on disk");

    // Second bind: Pi has bound the runtime, so the probe reaches the session.
    boundHostSession(pi, "sess-retry", recordingStableSend(pi));
    mod.bindSessionDelivery("sess-retry", pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "run-retry" });

    assert.equal(piCalls(pi).length, 1, "delivery flows after the retried probe captures");
    assert.equal(piCalls(pi)[0].triggerTurn, true);
  });

  it("drop releases the captured host session", () => {
    const pi = createMockPi();
    boundHostSession(pi, "host-1", recordingStableSend(pi));
    mod.bindSessionDelivery("host-1", pi as unknown as ExtensionAPI);
    assert.equal(mod._getSessionDeliveryEndpointForTests("host-1")?.hasSend, true);

    mod.dropSessionDelivery("host-1");
    assert.equal(mod._getSessionDeliveryEndpointForTests("host-1"), undefined, "nothing holds the session any more");
  });

  it("captured host send receives the exact production payload (T1)", async () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    const exact: ExactSendCall[] = [];

    // The delivery path must invoke the captured send with EXACTLY the
    // arguments tryDeliverEndpoint sends: {customType:"workflow-result",
    // content, display:true} and {triggerTurn:true, deliverAs:"followUp"}.
    boundHostSession(pi, SESSION, recordingSendExact(exact));

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "test-run-1" });

    await Promise.resolve();
    await Promise.resolve();

    assert.equal(exact.length, 1, "captured host send is invoked exactly once");
    assert.equal(exact[0].message.customType, "workflow-result");
    assert.equal(exact[0].message.display, true);
    assert.ok(exact[0].message.content?.includes("All tests passed"), "content is the delivered result text");
    assert.equal(exact[0].options?.triggerTurn, true, "delivery must triggerTurn");
    assert.equal(exact[0].options?.deliverAs, "followUp", "delivery must be queued as followUp");
    // ACK cleared the pending marker.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      manager.getPersistence?.().load("test-run-1")?.pendingDelivery,
      undefined,
      "cleared after thenable ACK",
    );
  });

  it("an idle host's triggerTurn delivery starts a real turn and is acknowledged once persisted", async () => {
    const pi = createMockPi();
    await withRealSession({ persist: true }, async ({ session, contexts }) => {
      const sid = session.sessionManager.getSessionId();
      const run = makeRun({ sessionId: sid });
      const manager = createMockManager(run);
      _useHostSessionClassForTests(AgentSession);
      routePiTo(pi, session as unknown as { sendCustomMessage: (m: never, o: never) => unknown });

      mod.installResultDelivery(pi, manager);
      manager.setSessionId(sid);
      mod.bindSessionDelivery(sid, pi, { manager });
      manager.emit("complete", { runId: "test-run-1" });

      for (let i = 0; i < 400 && run.pendingDelivery; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(run.pendingDelivery, undefined, "cleared once the host persisted the result");
      assert.equal(manager.getPersistence().load("test-run-1")?.pendingDelivery, undefined);
      const delivered = session.messages.find(
        (message) => (message as { customType?: string }).customType === "workflow-result",
      ) as { display?: boolean } | undefined;
      assert.ok(delivered, "the result is in the host's transcript");
      assert.equal(delivered.display, true);
      assert.equal(contexts.length, 1, "triggerTurn started exactly one model turn");
      assert.match(JSON.stringify(contexts[0].messages), /All tests passed/, "the turn sees the delivered result");
    });
  });

  it("non-thenable captured send fails closed: pending stays (no false ACK)", async () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    // A captured host send that does not return a thenable (fire-and-forget)
    // must not be trusted as an ACK — content stays pending on disk.
    boundHostSession(pi, SESSION, () => {
      pi._calls.push({ content: "fired", customType: "workflow-result" });
      return undefined;
    });
    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "test-run-1" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The captured send IS attempted, but because it returns no thenable it must not be trusted as an ACK — no triggerTurn, and
    // the marker stays pending on disk.
    assert.equal(piCalls(pi).length, 1, "captured non-thenable send is attempted");
    assert.equal(piCalls(pi)[0].triggerTurn, undefined, "non-thenable send never ACKs (fail closed)");
    assert.ok(manager.getPersistence?.().load("test-run-1")?.pendingDelivery, "pending stays (fail closed)");
  });

  it("failed captured send leaves pending; next bind flushes", async () => {
    const pi = createMockPi();
    const freshPi = createMockPi();
    const manager = createMockManager(makeRun());

    // A captured host send that returns a rejecting thenable: no ACK, marker
    // stays pending until a healthy generation binds and flushes.
    boundHostSession(pi, SESSION, () => Promise.reject(new Error("network blip")));
    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "test-run-1" });

    // Let the failing send settle (reject + in-flight release) before rebinding,
    // so the next generation's flush picks the run up cleanly.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(manager.getPersistence?.().load("test-run-1")?.pendingDelivery, "pending stays after failed send");

    // Rebind with a healthy send: flush retries the delivery and clears pending.
    mod.bindSessionDelivery(SESSION, freshPi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(freshPi),
    });
    const calls = piCalls(freshPi);
    assert.equal(calls.length, 1, "healthy generation flushes the pending delivery");
    assert.ok(calls[0].content.includes("All tests passed"));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(manager.getPersistence?.().load("test-run-1")?.pendingDelivery, undefined, "cleared after ACK");
  });

  it("append-only is not an ACK; pending stays until a thenable send exists", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    const appended: string[] = [];

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, {
      manager,
      sessionManager: {
        getSessionId: () => SESSION,
        appendCustomMessageEntry: (_customType, content) => {
          appended.push(typeof content === "string" ? content : JSON.stringify(content));
          return "entry";
        },
      },
    });
    manager.emit("complete", { runId: "test-run-1" });

    assert.equal(piCalls(pi).length, 0, "never fall back to pi.sendMessage");
    assert.equal(appended.length, 0, "append must not be treated as delivery");
    assert.ok(manager.getPersistence?.().load("test-run-1")?.pendingDelivery, "pending stays on disk");
    assert.equal(mod._getSessionDeliveryEndpointForTests(SESSION)?.hasSend, false);
  });

  it("no endpoint → disk pending; later session_start bind flushes", async () => {
    const pi = createMockPi();
    const run = makeRun();
    const manager = createMockManager(run);

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    // No bindSessionDelivery yet.
    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(pi).length, 0, "fail closed without endpoint");

    const disk = manager.getPersistence?.().load("test-run-1");
    assert.ok(disk?.pendingDelivery, "pending marker persisted to disk");

    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi),
    });
    assert.equal(piCalls(pi).length, 1, "bind flushes disk pending");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(manager.getPersistence?.().load("test-run-1")?.pendingDelivery, undefined, "cleared after flush");
  });

  it("bind without stableSend stays fail-closed and keeps pending", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());

    mod.installResultDelivery(pi as unknown as ExtensionAPI, manager);
    manager.setSessionId(SESSION);
    // Registered fail-closed: steal map empty, no stableSend (and append is not ACK).
    mod.bindSessionDelivery(SESSION, pi as unknown as ExtensionAPI, { manager });
    manager.emit("complete", { runId: "test-run-1" });

    assert.equal(piCalls(pi).length, 0, "no stableSend → never fall back to pi.sendMessage");
    assert.ok(manager.getPersistence?.().load("test-run-1")?.pendingDelivery, "pending stays on disk");
  });

  it("suspended endpoint never sends", () => {
    const pi = createMockPi();
    const manager = createMockManager(makeRun());
    setup(pi, manager);
    mod.suspendSessionDelivery(SESSION);
    assert.equal(mod._getSessionDeliveryEndpointForTests(SESSION)?.suspended, true);

    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(pi).length, 0);
  });

  it("sessionId mismatch never sends to the wrong endpoint", () => {
    const piA = createMockPi();
    const piB = createMockPi();
    // Run belongs to A, but only B is bound.
    const manager = createMockManager(makeRun({ sessionId: "sess-A" }));
    manager.setSessionId("sess-B");
    mod.installResultDelivery(piB as unknown as ExtensionAPI, manager);
    mod.bindSessionDelivery("sess-B", piB as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(piB),
    });

    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(piB).length, 0, "B must not get A's run");
    assert.equal(piCalls(piA).length, 0);

    // Later A binds and receives the pending delivery.
    mod.bindSessionDelivery("sess-A", piA as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(piA),
    });
    assert.equal(piCalls(piA).length, 1, "origin A flushes pending");
  });

  it("suspend/resume still delivers after replacement bind", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi1, manager);
    // session_shutdown
    mod.suspendResultDelivery(manager);
    manager.emit("complete", { runId: "test-run-1" });
    assert.equal(piCalls(pi1).length, 0);

    // New generation session_start: adopt then rebind (do not poke run.sessionId).
    const newSession = "sess-replaced";
    const previous = manager.getSessionId();
    if (typeof manager.adoptLiveRunsToSession === "function") {
      manager.adoptLiveRunsToSession(newSession, previous);
    }
    manager.setSessionId(newSession);
    mod.bindSessionDelivery(newSession, pi2 as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi2),
    });

    assert.equal(piCalls(pi2).length, 1, "replacement session receives pending");
    assert.equal(piCalls(pi1).length, 0, "old session stays silent");
  });

  // ── Holder refresh on re-call ──

  it("rebinds send on bindSessionDelivery for stale ctx recovery", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun());

    setup(pi1, manager);
    // Re-bind with second pi (fresh after reload)
    mod.bindSessionDelivery(SESSION, pi2 as unknown as ExtensionAPI, {
      manager,
      stableSend: recordingStableSend(pi2),
    });

    manager.emit("complete", { runId: "test-run-1" });

    assert.equal(piCalls(pi1).length, 0, "pi1 should not be used after rebind");
    assert.equal(piCalls(pi2).length, 1, "pi2 should receive the delivery");
  });

  it("refreshes the live delivery settings loader across reload generations", () => {
    const pi1 = createMockPi();
    const pi2 = createMockPi();
    const manager = createMockManager(makeRun({ result: { result: { note: "z".repeat(200) } } }));

    mod.installResultDelivery(pi1 as unknown as ExtensionAPI, manager, {
      loadSettings: () => ({ deliveredResultMaxChars: 400 }),
    });
    manager.setSessionId(SESSION);
    mod.bindSessionDelivery(SESSION, pi1 as unknown as ExtensionAPI, {
      manager,
      loadSettings: () => ({ deliveredResultMaxChars: 400 }),
      stableSend: recordingStableSend(pi1),
    });
    mod.bindSessionDelivery(SESSION, pi2 as unknown as ExtensionAPI, {
      manager,
      loadSettings: () => ({ deliveredResultMaxChars: 40 }),
      stableSend: recordingStableSend(pi2),
    });
    manager.emit("complete", { runId: "test-run-1" });

    const content = piCalls(pi2)[0]?.content ?? "";
    assert.match(content, /truncated/, "the reused listener reads settings from the fresh generation");
  });
});

// ─── installTaskPanel ─────────────────────────────────────────────────────────

/** A panel manager double: the given runs and getRun, plus real events. */
function panelManager(
  listRuns: () => unknown[] = () => [],
  getRun: (id: string) => unknown = () => undefined,
): WorkflowManager {
  return Object.assign(new EventEmitter(), { listRuns, getRun }) as unknown as WorkflowManager;
}

/** A UI double that only receives the widget installTaskPanel registers. */
function widgetUi(setWidget: (...args: never[]) => void): ExtensionUIContext {
  return { setWidget } as unknown as ExtensionUIContext;
}

describe("installTaskPanel", () => {
  it("registers a widget named workflow-tasks with belowEditor placement", () => {
    const manager = panelManager();

    let registeredName = "";
    let registeredPlacement = "";
    const ui = widgetUi((name: string, _factory: unknown, opts: { placement?: string }) => {
      registeredName = name;
      registeredPlacement = opts.placement ?? "";
    });

    mod.installTaskPanel(manager, ui);
    assert.equal(registeredName, "workflow-tasks");
    assert.equal(registeredPlacement, "belowEditor");
  });

  it("repaints on agentModel, so a running agent's corrected model reaches the panel", () => {
    // The manager corrects agent.model IN PLACE on the live snapshot, so without a
    // repaint subscription the panel keeps showing the pre-resolution model until
    // some unrelated event happens to fire.
    const manager = panelManager();

    let factory: ((tui: { requestRender(): void }, theme: unknown) => { dispose?(): void }) | undefined;
    const ui = widgetUi((_name: string, registeredFactory: typeof factory) => {
      factory = registeredFactory;
    });

    mod.installTaskPanel(manager, ui);
    let renders = 0;
    const component = factory?.(
      { requestRender: () => renders++ },
      {
        fg: (_c: string, t: string) => t,
        bold: (t: string) => t,
      },
    );

    manager.emit("agentModel", { runId: "a", agentId: 1, id: "a:0", label: "x", model: "prov/real-model" });
    assert.equal(renders, 1, "agentModel must be in RUN_EVENTS");

    component?.dispose?.();
    manager.emit("agentModel", { runId: "a", agentId: 1, id: "a:0", label: "x", model: "prov/real-model" });
    assert.equal(renders, 1, "dispose must unsubscribe it again (symmetric with RUN_EVENTS)");
  });

  it("passes the render width through to the task panel", () => {
    const manager = panelManager(() => [
      {
        runId: "a",
        workflowName: "handle_gh_issues_11_12_with_a_long_suffix",
        status: "running",
        agents: [{ status: "done" }, { status: "running" }],
        logs: [],
      },
    ]);

    let factory:
      | ((
          tui: { requestRender(): void },
          theme: { fg(color: string, text: string): string; bold(text: string): string },
        ) => { render(width: number): string[] })
      | undefined;
    const ui = widgetUi((_name: string, registeredFactory: typeof factory) => {
      factory = registeredFactory;
    });
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

    mod.installTaskPanel(manager, ui);
    const component = factory?.({ requestRender: () => {} }, theme);
    const lines = component?.render(24) ?? [];

    assert.ok(lines.length > 0, "panel should render active runs");
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 24, `line exceeds width: ${visibleWidth(line)} > 24`);
    }
  });
});

describe("renderPanel", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  it("hints that finished runs are kept in /workflows history", async () => {
    const { renderPanel } = await import("../src/task-panel/panel-render.js");
    const manager = {
      listRuns: () => [
        { runId: "a", workflowName: "live", status: "running", agents: [{ status: "done" }], logs: [] },
        { runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] },
        { runId: "c", workflowName: "older", status: "aborted", agents: [], logs: [] },
      ],
      getRun: () => undefined,
    };
    const lines = renderPanel(manager as never, theme as never);
    assert.ok(
      lines.some((l) => /2 finished kept in history/.test(l)),
      "hint should report the finished-run count",
    );
    assert.ok(
      lines.some((l) => l.includes("/workflows")),
      "hint should point at /workflows",
    );
  });

  it("renders nothing when no run is active", async () => {
    const { renderPanel } = await import("../src/task-panel/panel-render.js");
    const manager = {
      listRuns: () => [{ runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] }],
      getRun: () => undefined,
    };
    assert.deepEqual(renderPanel(manager as never, theme as never), []);
  });

  it("renders each pending delivery row with its actual terminal status", async () => {
    const { renderPanel } = await import("../src/task-panel/panel-render.js");
    const manager = {
      listRuns: () => [
        {
          runId: "p",
          workflowName: "pending-completed",
          status: "completed",
          pendingDelivery: { kind: "complete" },
          agents: [],
          logs: [],
        },
        {
          runId: "f",
          workflowName: "pending-failed",
          status: "failed",
          pendingDelivery: { kind: "error" },
          agents: [],
          logs: [],
        },
        {
          runId: "a",
          workflowName: "pending-aborted",
          status: "aborted",
          pendingDelivery: { kind: "text" },
          agents: [],
          logs: [],
        },
      ],
      getRun: () => undefined,
    };
    const lines = renderPanel(manager as never, theme as never);
    assert.ok(lines.some((l) => l.includes("completed, result delivery pending")));
    assert.ok(lines.some((l) => l.includes("failed, result delivery pending")));
    assert.ok(lines.some((l) => l.includes("aborted, result delivery pending")));
    assert.ok(lines.some((l) => l.includes("Workflows pending delivery (3):")));
  });

  it("truncates every rendered line to the requested visible width", async () => {
    const { renderPanel } = await import("../src/task-panel/panel-render.js");
    const ansiTheme = {
      fg: (_c: string, t: string) => `\x1b[2m${t}\x1b[22m`,
      bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
    };
    const manager = {
      listRuns: () => [
        {
          runId: "a",
          workflowName: "handle_gh_issues_11_12_中文_🙂_very_long_workflow_name",
          status: "running",
          agents: [{ status: "done" }, { status: "running" }],
          logs: [],
        },
        { runId: "b", workflowName: "old", status: "completed", agents: [], logs: [] },
      ],
      getRun: () => ({
        snapshot: {
          currentPhase: "Issue implementation phase with a very long suffix",
          agents: [{ status: "done" }, { status: "running" }],
        },
      }),
    };

    const lines = renderPanel(manager as never, ansiTheme as never, 42);

    assert.ok(lines.length > 0, "panel should render active runs");
    assert.ok(
      lines.some((line) => line.includes("...")),
      "at least one line should be truncated",
    );
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= 42, `line exceeds width: ${visibleWidth(line)} > 42`);
    }
  });
});

// ─── token/s rolling-window math ────────────────────────────────────────────────

describe("token rate", () => {
  it("returns 0 with fewer than two samples and after clearing", async () => {
    const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel/panel-render.js");
    clearTokenSamples("rate-a");
    assert.equal(tokensPerSecond("rate-a"), 0);
    sampleTokens("rate-a", 100, 1000);
    assert.equal(tokensPerSecond("rate-a"), 0);
    sampleTokens("rate-a", 1100, 2000);
    assert.equal(tokensPerSecond("rate-a"), 1000, "1000 tokens over 1s = 1000 tok/s");
    clearTokenSamples("rate-a");
    assert.equal(tokensPerSecond("rate-a"), 0, "cleared samples reset the rate");
  });

  it("computes the rate over the oldest-to-newest window", async () => {
    const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel/panel-render.js");
    clearTokenSamples("rate-b");
    sampleTokens("rate-b", 0, 1000);
    sampleTokens("rate-b", 1000, 2000);
    sampleTokens("rate-b", 1500, 3000);
    // (1500 - 0) tokens over (3000 - 1000) ms = 750 tok/s
    assert.equal(tokensPerSecond("rate-b"), 750);
  });

  it("decays to 0 when the total plateaus (stall detection)", async () => {
    const { sampleTokens, tokensPerSecond, clearTokenSamples } = await import("../src/task-panel/panel-render.js");
    clearTokenSamples("rate-c");
    sampleTokens("rate-c", 0, 0);
    sampleTokens("rate-c", 1000, 1000);
    assert.equal(tokensPerSecond("rate-c"), 1000);
    // A stall: same total sampled > 10s later ages out the growth window → 0 tok/s.
    sampleTokens("rate-c", 1000, 12000);
    assert.equal(tokensPerSecond("rate-c"), 0, "stalled agent shows 0 tok/s");
  });
});

// ─── detailed progress panel ─────────────────────────────────────────────────────

describe("renderPanelDetailed", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  // `blueTokens` drives the first agent's live token count; the run aggregate and
  // token/s are summed from per-agent tokens (the run-level tokenUsage aggregate is
  // not live — see renderPanelDetailed), so growing blueTokens grows the rate.
  function detailedManager(blueTokens: number, status = "running", estimated = false) {
    const snapshot = {
      name: "auth_audit",
      phases: ["Scan", "Review"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        {
          id: 1,
          label: "discover_routes",
          status: "done",
          phase: "Scan",
          tokens: blueTokens,
          ...(estimated
            ? {
                tokenUsage: {
                  input: 0,
                  output: blueTokens,
                  total: blueTokens,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  estimated: true,
                },
              }
            : {}),
          model: "anthropic/claude-haiku-4-5",
        },
        { id: 2, label: "audit_auth", status: "running", phase: "Scan", tokens: 1800 },
        { id: 3, label: "scan_middleware", status: "queued", phase: "Scan" },
        { id: 4, label: "cross_check", status: "queued", phase: "Review" },
      ],
      // Only `cost` is read from the run-level aggregate (it lands when the run ends).
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0.02 },
    };
    return {
      listRuns: () => [
        { runId: "r1", workflowName: "auth_audit", status, agents: snapshot.agents, tokenUsage: snapshot.tokenUsage },
      ],
      getRun: (id: string) => (id === "r1" ? { snapshot, status } : undefined),
    };
  }

  it("shows an empty-named phase and the phase-less group, and never mixes them with a same-titled phase", async () => {
    const { renderPanelDetailed, renderPanel } = await import("../src/task-panel/panel-render.js");
    const snapshot = {
      name: "wf",
      phases: [""],
      currentPhase: "",
      logs: [],
      agents: [
        { id: 1, label: "in_blank", status: "running", phase: "" },
        { id: 2, label: "named_like_none", status: "done", phase: "(no phase)" },
        { id: 3, label: "no_phase", status: "done" },
      ],
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const manager = {
      listRuns: () => [{ runId: "r-phases", workflowName: "wf", status: "running", agents: snapshot.agents }],
      getRun: (id: string) => (id === "r-phases" ? { snapshot, status: "running" } : undefined),
    };
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
    const headers = lines.filter((line) => /^ {2}[▶✓ ] [^ []/.test(line)).map((line) => line.trim());
    assert.equal(headers.length, 3, `one header per group, got: ${JSON.stringify(lines)}`);
    assert.ok(headers[0].startsWith("▶ (unnamed phase)"), "the current blank phase is shown and marked");
    assert.ok(
      lines.some((line) => line.includes("· (unnamed phase)")),
      "the run header names the blank current phase",
    );
    assert.ok(renderPanel(manager as never, theme as never).some((line) => line.endsWith("· (unnamed phase)")));
  });

  it("renders a per-agent fresh/cache split when tokenUsage is present", async () => {
    const { renderPanelDetailed } = await import("../src/task-panel/panel-render.js");
    const snapshot = {
      name: "wf",
      phases: ["Scan"],
      currentPhase: "Scan",
      logs: [],
      agents: [
        {
          id: 1,
          label: "cached_agent",
          status: "done",
          phase: "Scan",
          tokens: 3100000,
          // Opus-style: little fresh input+output, most of it cheap cache reads.
          tokenUsage: { input: 80000, output: 20000, total: 3100000, cacheRead: 3000000, cacheWrite: 0, cost: 0.4 },
          model: "github-copilot/claude-opus-4.8",
        },
      ],
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0 },
    };
    const manager = {
      listRuns: () => [
        {
          runId: "r2",
          workflowName: "wf",
          status: "running",
          agents: snapshot.agents,
          tokenUsage: snapshot.tokenUsage,
        },
      ],
      getRun: (id: string) => (id === "r2" ? { snapshot, status: "running" } : undefined),
    };
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ cached_agent") && /100k tok/.test(l) && /3M cached/.test(l)),
      `expected a per-agent tok/cached row, got:\n${lines.join("\n")}`,
    );
  });

  it("keeps the scalar estimate for cost-only agents instead of a zero breakdown", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel/panel-render.js");
    clearTokenSamples("r3");
    const snapshot = {
      name: "wf3",
      phases: ["P"],
      currentPhase: "P",
      logs: [],
      agents: [
        {
          id: 1,
          label: "cost_only",
          status: "done",
          phase: "P",
          tokens: 384,
          // Provider billed cost but reported zero token counts.
          tokenUsage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
        },
      ],
      tokenUsage: { total: 0, input: 0, output: 0, cost: 0.02 },
    };
    const manager = {
      listRuns: () => [
        {
          runId: "r3",
          workflowName: "wf3",
          status: "running",
          agents: snapshot.agents,
          tokenUsage: snapshot.tokenUsage,
        },
      ],
      getRun: (id: string) => (id === "r3" ? { snapshot, status: "running" } : undefined),
    };
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ cost_only") && /384 tok/.test(l)),
      `cost-only agent should show its scalar estimate, got:\n${lines.join("\n")}`,
    );
    // The run header guard must agree with the value it gates (no "0 tok" beside a real cost).
    assert.ok(
      lines.some((l) => /wf3/.test(l) && /384 tok/.test(l) && /\$0\.02/.test(l)),
      `run header should show the estimate and the cost, got:\n${lines.join("\n")}`,
    );
    assert.ok(!lines.some((l) => /\b0 tok/.test(l)), `no zero breakdown anywhere:\n${lines.join("\n")}`);
  });

  it("renders aggregate tokens, cost, phases, and per-agent rows", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel/panel-render.js");
    clearTokenSamples("r1");
    // discover_routes 2100 + audit_auth 1800 = 3900 → "3.9k tok" aggregate.
    const lines = renderPanelDetailed(detailedManager(2100) as never, theme as never, undefined, 8, 1000);
    const text = lines.join("\n");

    assert.ok(/auth_audit/.test(text), "shows the run name");
    assert.ok(/1\/4 agents/.test(text), "shows done/total agents");
    assert.ok(/3\.9k tok/.test(text), "shows aggregate tokens summed from per-agent tokens");
    assert.ok(/\$0\.02/.test(text), "shows cost");
    // Phase headers
    assert.ok(
      lines.some((l) => l.includes("▶ Scan") && /1\/3 agents/.test(l) && /3\.9k tok/.test(l)),
      "Scan phase header with subtotal",
    );
    assert.ok(
      lines.some((l) => l.includes("Review") && /0\/1 agents/.test(l)),
      "Review phase header",
    );
    // Agent rows: status icons + label + tokens + model
    assert.ok(
      lines.some((l) => l.includes("[1] ✓ discover_routes") && /2\.1k tok/.test(l) && /claude-haiku-4-5/.test(l)),
      "done agent row with model",
    );
    assert.ok(
      lines.some((l) => l.includes("[2] ● audit_auth") && /1\.8k tok/.test(l)),
      "running agent row",
    );
    assert.ok(
      lines.some((l) => l.includes("[3] ○ scan_middleware")),
      "queued agent row",
    );
  });

  it("shows a live token/s after two growing samples", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel/panel-render.js");
    clearTokenSamples("r1");
    // aggregate goes 3900 → 5900 over 1s = 2000 tok/s
    renderPanelDetailed(detailedManager(2100) as never, theme as never, undefined, 8, 1000);
    const lines = renderPanelDetailed(detailedManager(4100) as never, theme as never, undefined, 8, 2000);
    assert.ok(
      lines.some((l) => /2000 tok\/s/.test(l)),
      `expected a tok/s readout, got:\n${lines.join("\n")}`,
    );
  });

  it("keeps token-rate estimate provenance for its rolling-window endpoints", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel/panel-render.js");

    clearTokenSamples("r1");
    renderPanelDetailed(detailedManager(2100, "running", true) as never, theme as never, undefined, 8, 1000);
    let lines = renderPanelDetailed(
      detailedManager(4100, "running", true) as never,
      theme as never,
      undefined,
      8,
      2000,
    );
    assert.ok(
      lines.some((line) => /~2000 tok\/s/.test(line)),
      "estimated → estimated rate is marked",
    );

    clearTokenSamples("r1");
    renderPanelDetailed(detailedManager(2100, "running", true) as never, theme as never, undefined, 8, 1000);
    lines = renderPanelDetailed(detailedManager(4100) as never, theme as never, undefined, 8, 2000);
    assert.ok(
      lines.some((line) => /~2000 tok\/s/.test(line)),
      "estimated → exact rate remains marked",
    );

    // The initial estimated endpoint ages out, leaving two exact endpoints for
    // the rate. The marker must then clear rather than sticking to the run.
    lines = renderPanelDetailed(detailedManager(6100) as never, theme as never, undefined, 8, 12001);
    assert.ok(
      lines.some((line) => /200 tok\/s/.test(line)),
      "two exact endpoints still render a rate",
    );
    assert.ok(!lines.some((line) => /~\d+ tok\/s/.test(line)), "two exact endpoints clear the estimate marker");

    // A duplicate render can correct its provenance without changing either
    // timestamp or total; retain one sample, but replace its marker.
    clearTokenSamples("r1");
    renderPanelDetailed(detailedManager(2100, "running", true) as never, theme as never, undefined, 8, 1000);
    renderPanelDetailed(detailedManager(2100) as never, theme as never, undefined, 8, 1000);
    lines = renderPanelDetailed(detailedManager(4100) as never, theme as never, undefined, 8, 2000);
    assert.ok(!lines.some((line) => /~\d+ tok\/s/.test(line)), "same-timestamp correction updates the endpoint marker");
  });

  it("caps agents per phase and reports the overflow", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel/panel-render.js");
    clearTokenSamples("r1");
    const lines = renderPanelDetailed(detailedManager(12400) as never, theme as never, undefined, 2, 1000);
    const text = lines.join("\n");
    // Scan has 3 agents, cap 2 → most recent 2 shown + "… 1 earlier agents"
    assert.ok(/… 1 earlier agents/.test(text), "overflow line present");
    assert.ok(!/discover_routes/.test(text), "oldest agent hidden when capped");
    assert.ok(/audit_auth/.test(text) && /scan_middleware/.test(text), "most recent agents shown");
  });

  it("suppresses tok/s for paused runs", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel/panel-render.js");
    clearTokenSamples("r1");
    renderPanelDetailed(detailedManager(1000, "paused") as never, theme as never, undefined, 8, 1000);
    const lines = renderPanelDetailed(detailedManager(3000, "paused") as never, theme as never, undefined, 8, 2000);
    assert.ok(!lines.some((l) => /tok\/s/.test(l)), "paused run shows no token rate");
  });

  it("renders actual terminal statuses for pending delivery rows in detailed mode", async () => {
    const { renderPanelDetailed } = await import("../src/task-panel/panel-render.js");
    const manager = {
      listRuns: () => [
        {
          runId: "p",
          workflowName: "pending-completed",
          status: "completed",
          pendingDelivery: { kind: "complete" },
          agents: [],
          logs: [],
        },
        {
          runId: "f",
          workflowName: "pending-failed",
          status: "failed",
          pendingDelivery: { kind: "error" },
          agents: [],
          logs: [],
        },
        {
          runId: "a",
          workflowName: "pending-aborted",
          status: "aborted",
          pendingDelivery: { kind: "text" },
          agents: [],
          logs: [],
        },
      ],
      getRun: () => undefined,
    };
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
    assert.ok(lines.some((l) => l.includes("completed, result delivery pending")));
    assert.ok(lines.some((l) => l.includes("failed, result delivery pending")));
    assert.ok(lines.some((l) => l.includes("aborted, result delivery pending")));
  });
});

// ─── mode selection in installTaskPanel ───────────────────────────────────────────

describe("installTaskPanel mode selection", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  function activeManager() {
    const snapshot = {
      name: "wf",
      phases: ["P1"],
      currentPhase: "P1",
      logs: [],
      agents: [{ id: 1, label: "a", status: "running", phase: "P1", tokens: 500 }],
      tokenUsage: { total: 500, input: 250, output: 250 },
    };
    return panelManager(
      () => [
        {
          runId: "r1",
          workflowName: "wf",
          status: "running",
          agents: snapshot.agents,
          tokenUsage: snapshot.tokenUsage,
        },
      ],
      (id) => (id === "r1" ? { snapshot, status: "running" } : undefined),
    );
  }

  function captureRender(loadSettings?: () => Record<string, unknown>) {
    const manager = activeManager();
    let factory:
      | ((tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[]; dispose?(): void })
      | undefined;
    const ui = widgetUi((_n: string, f: typeof factory) => {
      factory = f;
    });
    mod.installTaskPanel(manager, ui, loadSettings as (() => WorkflowSettings) | undefined);
    const comp = factory?.({ requestRender: () => {} }, theme);
    const lines = comp?.render(120) ?? [];
    comp?.dispose?.();
    return lines;
  }

  it("uses compact rendering when no loadSettings is provided", () => {
    const lines = captureRender();
    assert.ok(
      lines.some((l) => /1 agents/.test(l)),
      "compact one-liner",
    );
    assert.ok(!lines.some((l) => /▶ P1/.test(l)), "no per-phase detail in compact");
  });

  it("uses compact rendering when the mode is compact", () => {
    const lines = captureRender(() => ({ progressPanelMode: "compact" }));
    assert.ok(!lines.some((l) => /▶ P1/.test(l)), "no per-phase detail in compact");
  });

  it("uses detailed rendering when the mode is detailed", () => {
    const lines = captureRender(() => ({ progressPanelMode: "detailed" }));
    assert.ok(
      lines.some((l) => /▶ P1/.test(l)),
      "per-phase detail in detailed mode",
    );
    assert.ok(
      lines.some((l) => /\[1\] ● a/.test(l)),
      "per-agent row in detailed mode",
    );
  });
});

// ─── deliverText: pointer + truncation threshold ─────────────────────────────────

describe("deliverText", () => {
  function makeResult(result: unknown) {
    return { snapshot: { name: "wf", agentCount: 1 }, result: { agentCount: 1, result } };
  }

  it("appends the Full result pointer to a verdict result without altering it", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    // A verdict longer than the default cap must still pass through in full: the
    // verdict branch is never subject to the JSON-dump truncation.
    const verdict = "V".repeat(600);
    const text = deliverText(makeResult({ verdict }) as never, { resultPath: "/r/x.json" });
    assert.ok(text.includes(verdict), "long verdict passed through in full");
    assert.ok(text.includes("↳ Full result: /r/x.json"), "pointer appended");
    assert.ok(!/truncated/.test(text), "verdict branch bypasses truncation");
  });

  it("does not append a pointer when no resultPath is given", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    const text = deliverText(makeResult("plain string") as never);
    assert.ok(text.includes("plain string"), "string result passed through");
    assert.ok(!text.includes("Full result:"), "no pointer without a resultPath");
  });

  it("leaves a small JSON dump untouched (no truncation marker)", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    const text = deliverText(makeResult({ ok: true, changed: 2 }) as never, { resultPath: "/r/x.json" });
    assert.ok(text.includes('"ok": true'), "full JSON shown");
    assert.ok(!/truncated/.test(text), "no truncation under the threshold");
    assert.ok(text.includes("↳ Full result: /r/x.json"), "pointer still appended");
  });

  it("truncates the JSON dump at maxChars and reports the dropped size", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    const text = deliverText(makeResult({ note: "x".repeat(500) }) as never, {
      resultPath: "/r/x.json",
      maxChars: 100,
    });
    assert.ok(/…\(truncated [\d.]+ (B|KB|MB)\)/.test(text), "size hint present");
    assert.ok(text.includes("↳ Full result: /r/x.json"), "pointer still appended");
    // Body is capped near maxChars, so the 500-char tail is not delivered in full.
    assert.ok(!text.includes("x".repeat(500)), "the full tail is not inlined");
  });

  it("defaults the JSON-dump threshold to 400 chars", async () => {
    const { deliverText } = await import("../src/task-panel.js");
    // JSON length is note length + 16, so 380 → 396 (under 400) and 390 → 406 (over),
    // bracketing the default threshold tightly around 400.
    const under = deliverText(makeResult({ note: "y".repeat(380) }) as never);
    assert.ok(!/truncated/.test(under), "a 396-char dump is under the default 400");
    const over = deliverText(makeResult({ note: "y".repeat(390) }) as never);
    assert.ok(/…\(truncated/.test(over), "a 406-char dump exceeds the default 400");
  });
});

it("sessionFileContainsEntry finds entries before AND after the incremental scan offset", async () => {
  const { sessionFileContainsEntry } = await import("../src/task-panel/session-file-scan.js");
  const dir = mkdtempSync(join(tmpdir(), "pdw-scan-"));
  const file = join(dir, "session.jsonl");
  const entry1 = { id: "e1", type: "custom_message", customType: "workflow-result", details: { deliveryId: "d1" } };
  const entry2 = { id: "e2", type: "custom_message", customType: "workflow-result", details: { deliveryId: "d2" } };
  // A header line first: the needle carries a leading \n, so a first-line
  // entry is unmatchable by design (production session files always have one).
  writeFileSync(file, `${JSON.stringify({ id: "header" })}\n${JSON.stringify(entry1)}\n`);
  // First scan caches the offset at EOF (miss for an absent needle is fine).
  assert.equal(sessionFileContainsEntry(file, { id: "absent" }), false);
  // New content appended AFTER the cached offset: found via the tail scan.
  appendFileSync(file, `${JSON.stringify(entry2)}\n`);
  assert.equal(sessionFileContainsEntry(file, entry2), true, "appended entry found from the resumed offset");
  // Content written BEFORE the cached offset (interleaved delivery): head fallback.
  assert.equal(sessionFileContainsEntry(file, entry1), true, "pre-offset entry found via the head fallback");
  assert.equal(sessionFileContainsEntry(file, { id: "never" }), false);
  // REPEAT the same needle with nothing appended (the delivery-ACK poll
  // loop). NOTE: this pins CORRECTNESS only — the head fallback masks the
  // off-by-one cost of the tail window at the boolean level.
  assert.equal(sessionFileContainsEntry(file, entry2), true, "repeat check of the last entry still finds it");
});

it("sessionFileContainsEntry finds a needle that crosses the 64 KiB scan boundary", async () => {
  const { sessionFileContainsEntry } = await import("../src/task-panel/session-file-scan.js");
  const dir = mkdtempSync(join(tmpdir(), "pdw-scan-boundary-"));
  const file = join(dir, "session.jsonl");
  const entry = { id: "boundary", type: "custom_message", customType: "workflow-result" };
  const header = `${JSON.stringify({ type: "session", cwd: dir })}\n`;
  const boundary = 64 * 1024;
  const prefixLength = boundary - 2 - Buffer.byteLength(header) - 1;
  assert.ok(prefixLength > 0);
  writeFileSync(file, `${header}${"x".repeat(prefixLength)}\n${JSON.stringify(entry)}\n`);

  assert.equal(sessionFileContainsEntry(file, entry), true, "the record starts just before the 64 KiB boundary");
  rmSync(dir, { recursive: true, force: true });
});

it("sessionFileContainsEntry rescans from the head after a cached file offset becomes stale on truncate", async () => {
  const { sessionFileContainsEntry } = await import("../src/task-panel/session-file-scan.js");
  const dir = mkdtempSync(join(tmpdir(), "pdw-scan-truncate-"));
  const file = join(dir, "session.jsonl");
  const entry = { id: "kept-after-truncate", type: "custom_message", customType: "workflow-result" };
  const header = `${JSON.stringify({ type: "session", cwd: dir })}\n`;
  const retained = `${header}${JSON.stringify(entry)}\n`;
  writeFileSync(file, `${retained}${"z".repeat(70 * 1024)}\n`);

  assert.equal(sessionFileContainsEntry(file, { id: "absent" }), false, "cache the original larger offset");
  truncateSync(file, Buffer.byteLength(retained));
  assert.equal(sessionFileContainsEntry(file, entry), true, "the retained record remains discoverable after shrink");
  rmSync(dir, { recursive: true, force: true });
});

it("sessionFileContainsEntry invalidates a same-path rename replacement", async () => {
  const { sessionFileContainsEntry } = await import("../src/task-panel/session-file-scan.js");
  const dir = mkdtempSync(join(tmpdir(), "pdw-scan-rename-"));
  const file = join(dir, "session.jsonl");
  const replacement = join(dir, "session.replacement.jsonl");
  const header = `${JSON.stringify({ type: "session", cwd: dir })}\n`;
  const oldEntry = { id: "old-record", type: "custom_message", customType: "workflow-result" };
  const newEntry = { id: "new-record", type: "custom_message", customType: "workflow-result" };
  writeFileSync(file, `${header}${JSON.stringify(oldEntry)}\n`);
  assert.equal(sessionFileContainsEntry(file, oldEntry), true);

  writeFileSync(replacement, `${header}${JSON.stringify(newEntry)}\n`);
  renameSync(replacement, file);
  assert.equal(sessionFileContainsEntry(file, newEntry), true, "the replacement file's record is found");
  assert.equal(sessionFileContainsEntry(file, oldEntry), false, "the old file's record is not retained by the cache");
  rmSync(dir, { recursive: true, force: true });
});

it("sessionFileContainsEntry requires the complete record and rejects other substrings", async () => {
  const { sessionFileContainsEntry } = await import("../src/task-panel/session-file-scan.js");
  const dir = mkdtempSync(join(tmpdir(), "pdw-scan-record-"));
  const file = join(dir, "session.jsonl");
  const entry = { id: "duplicate-record", type: "custom_message", customType: "workflow-result" };
  const header = `${JSON.stringify({ type: "session", cwd: dir })}\n`;
  writeFileSync(file, `${header}${JSON.stringify(entry)}\n${JSON.stringify(entry)}\n`);

  assert.equal(sessionFileContainsEntry(file, entry), true, "a duplicated complete record matches");
  assert.equal(
    sessionFileContainsEntry(file, { id: "duplicate", type: "custom_message", customType: "workflow-result" }),
    false,
    "a similar substring is not treated as the full record",
  );
  rmSync(dir, { recursive: true, force: true });
});
