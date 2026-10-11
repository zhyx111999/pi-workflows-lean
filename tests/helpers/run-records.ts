import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolvePersistenceFs } from "../../src/fs-persistence.js";
import type { PersistedRunState } from "../../src/run-persistence.js";
import { createRunRecordStore } from "../../src/run-record-store.js";

/**
 * Write a run record exactly as given. RunPersistence.save() stamps updatedAt
 * with the current time; tests that need a specific updatedAt write through
 * the record store instead.
 */
export function writeRunRecord(runsDir: string, state: PersistedRunState): void {
  mkdirSync(runsDir, { recursive: true });
  createRunRecordStore(resolvePersistenceFs()).save(join(runsDir, `${state.runId}.json`), state);
}
