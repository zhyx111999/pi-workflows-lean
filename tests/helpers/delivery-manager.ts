/**
 * A WorkflowManager double for delivery tests: live runs in memory plus a fake
 * record store with the semantics delivery relies on (merge into an existing
 * record, never create one, refuse a clear that belongs to another delivery).
 */

import { EventEmitter } from "node:events";
import type { PersistedRunState } from "../../src/run-persistence.js";
import type { ManagedRun, WorkflowManager } from "../../src/workflow-manager.js";

type Record = { [key: string]: unknown };

export interface DeliveryManagerDouble {
  manager: WorkflowManager;
  /** Start tracking a finished run whose result's verdict is `verdict`, owned by `sessionId`. */
  addRun(runId: string, verdict: string, sessionId?: string): ManagedRun;
  /** The run reports completion, as the real manager emits it. */
  complete(runId: string): void;
  /** The marker the run's record holds, if any. */
  pending(runId: string): { deliveryId?: string } | undefined;
  /** What a session switch does to the work the previous session owned. */
  adopt(newSessionId: string, previousSessionId: string): void;
}

export function deliveryManager(sessionId: string): DeliveryManagerDouble {
  let currentSession: string | undefined = sessionId;
  const runs = new Map<string, ManagedRun>();
  const disk = new Map<string, Record>();

  const persistence = {
    load: (id: string) => disk.get(id) ?? null,
    loadPreview: (id: string) => disk.get(id) ?? null,
    save: (state: PersistedRunState) => {
      disk.set(state.runId, { ...state });
    },
    updateMetadata: (id: string, patch: Record, expectedDeliveryId?: string) => {
      const current = disk.get(id);
      if (!current) return false;
      const marker = current.pendingDelivery as { deliveryId?: string } | undefined;
      if (expectedDeliveryId && marker?.deliveryId && marker.deliveryId !== expectedDeliveryId) return false;
      const next = { ...current, ...patch };
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete next[key];
      disk.set(id, next);
      return true;
    },
    list: () => [...disk.values()],
  };

  const emitter = new EventEmitter();
  const manager = Object.assign(emitter, {
    getRun: (id: string) => runs.get(id),
    getSessionId: () => currentSession,
    setSessionId: (id: string | undefined) => {
      currentSession = id;
    },
    listLiveRuns: () => [...runs.values()],
    getPersistence: () => persistence,
  }) as unknown as WorkflowManager;

  return {
    manager,
    addRun(runId, verdict, owner = sessionId) {
      const run = {
        runId,
        sessionId: owner,
        status: "completed",
        snapshot: { name: `flow-${runId}`, agentCount: 1 },
        result: { agentCount: 1, durationMs: 10, result: { verdict } },
      } as unknown as ManagedRun;
      runs.set(runId, run);
      return run;
    },
    complete: (runId) => emitter.emit("complete", { runId }),
    pending: (runId) => disk.get(runId)?.pendingDelivery as { deliveryId?: string } | undefined,
    adopt(newSessionId, previousSessionId) {
      for (const run of runs.values()) {
        if (run.pendingDelivery && run.sessionId === previousSessionId) run.sessionId = newSessionId;
      }
      for (const [id, record] of disk) {
        if (record.pendingDelivery && record.sessionId === previousSessionId) {
          disk.set(id, { ...record, sessionId: newSessionId });
        }
      }
    },
  };
}
