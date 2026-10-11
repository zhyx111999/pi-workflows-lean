import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PersistedRunState } from "../src/run-persistence.js";
import type { DeliverySend } from "../src/task-panel/delivery-endpoints.js";
import { _resetDeliveryRegistriesForTests, bindSessionDelivery } from "../src/task-panel.js";
import type { WorkflowManager } from "../src/workflow-manager.js";

const SESSION = "dispatch-session";
const RUN_ID = "disk-only-run";
const pi = {} as ExtensionAPI;

/** A manager whose only pending result lives on disk, with a record that can be made unreadable. */
function diskOnlyManager() {
  let record: Record<string, unknown> | undefined = {
    runId: RUN_ID,
    sessionId: SESSION,
    status: "completed",
    pendingDelivery: { kind: "text", text: "workflow finished", deliveryId: "delivery-1" },
  };
  let unreadable = false;
  const read = () => {
    if (unreadable) throw new Error("Unsupported run record format");
    return record;
  };
  const persistence = {
    list: () => (record ? [{ ...record }] : []),
    loadPreview: () => read() ?? null,
    updateMetadata: (_runId: string, patch: Record<string, unknown>, expectedDeliveryId?: string) => {
      const current = read();
      if (!current) return false;
      const marker = current.pendingDelivery as { deliveryId?: string } | undefined;
      if (expectedDeliveryId && marker?.deliveryId && marker.deliveryId !== expectedDeliveryId) return false;
      const next = { ...current, ...patch };
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
      record = next;
      return true;
    },
  };
  const manager = {
    getRun: () => undefined,
    getSessionId: () => SESSION,
    listLiveRuns: () => [],
    getPersistence: () => persistence,
  } as unknown as WorkflowManager;
  return {
    manager,
    pendingDelivery: () => record?.pendingDelivery as PersistedRunState["pendingDelivery"],
    setUnreadable(value: boolean) {
      unreadable = value;
    },
  };
}

/** Collect unhandled rejections for the duration of one test. */
function watchUnhandledRejections() {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => reasons.push(reason);
  process.on("unhandledRejection", listener);
  return {
    reasons,
    stop: () => process.off("unhandledRejection", listener),
  };
}

describe("delivery dispatch failures", () => {
  let unhandled: ReturnType<typeof watchUnhandledRejections>;

  beforeEach(() => {
    _resetDeliveryRegistriesForTests();
    unhandled = watchUnhandledRejections();
  });

  afterEach(() => {
    unhandled.stop();
    _resetDeliveryRegistriesForTests();
  });

  it("keeps a result pending and hands it to the rebound endpoint when its record turns unreadable mid-send", async () => {
    const disk = diskOnlyManager();
    const warnings: string[] = [];
    let settleOldSend: (() => void) | undefined;
    const oldSend: DeliverySend = () =>
      new Promise<void>((resolve) => {
        settleOldSend = resolve;
      });
    const delivered: string[] = [];
    const newSend: DeliverySend = (message) => {
      delivered.push(message.content);
      return Promise.resolve();
    };

    bindSessionDelivery(SESSION, pi, { manager: disk.manager, stableSend: oldSend });
    assert.ok(settleOldSend, "the first endpoint owns the in-flight send");
    bindSessionDelivery(SESSION, pi, {
      manager: disk.manager,
      stableSend: newSend,
      reportWarning: (message) => warnings.push(message),
    });
    assert.deepEqual(delivered, [], "the rebound endpoint's flush skips the locked run");

    disk.setUnreadable(true);
    settleOldSend?.();
    await delay(0);

    assert.deepEqual(unhandled.reasons, [], "the settlement failure must not escape as an unhandled rejection");
    assert.match(warnings.join("\n"), /remains pending: Unsupported run record format/);
    assert.ok(disk.pendingDelivery(), "the marker stays on disk");

    disk.setUnreadable(false);
    await delay(400);

    assert.deepEqual(delivered, ["workflow finished"], "the retry delivers the kept result to the rebound endpoint");
    assert.equal(disk.pendingDelivery(), undefined, "the confirmed delivery clears its marker");
  });

  for (const [mode, fail] of [
    ["rejects", () => Promise.reject(Object.create(null))],
    [
      "throws",
      () => {
        throw Object.create(null);
      },
    ],
  ] as const) {
    it(`retries a send that ${mode} with a reason that cannot be converted to text`, async () => {
      const disk = diskOnlyManager();
      const warnings: string[] = [];
      let sends = 0;
      const send: DeliverySend = () => {
        sends++;
        return sends === 1 ? fail() : Promise.resolve();
      };

      bindSessionDelivery(SESSION, pi, {
        manager: disk.manager,
        stableSend: send,
        reportWarning: (message) => warnings.push(message),
      });
      await delay(0);

      assert.deepEqual(unhandled.reasons, [], "the failed send must not escape as an unhandled rejection");
      assert.match(warnings.join("\n"), /remains pending/);
      assert.ok(disk.pendingDelivery(), "the marker stays on disk after the failed send");

      await delay(400);

      assert.equal(sends, 2, "the released lock lets the bounded retry send again");
      assert.equal(disk.pendingDelivery(), undefined, "the confirmed retry clears its marker");
    });
  }
});
