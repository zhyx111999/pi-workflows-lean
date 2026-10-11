import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fsModule, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  type WriteFileOptions,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { RunRecordUnreadableError } from "../src/errors.js";
import { defaultPersistenceFs, type PersistenceFsLayer } from "../src/fs-persistence.js";
import { bindDiagnosticSink } from "../src/host-diagnostics.js";
import { persistedToSnapshot } from "../src/navigator/persisted-snapshot.js";
import { createRunPersistence, type PersistedRunState } from "../src/run-persistence.js";
import { createRunRecordStore } from "../src/run-record-store.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { workflowProjectPaths } from "../src/workflow-paths.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function withFixture(fn: (cwd: string) => Promise<void> | void) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-record-store-"));
    const home = mkdtempSync(join(tmpdir(), "pi-dw-record-home-"));
    try {
      await withFakeHomeAsync(home, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function state(runId: string, journal: PersistedRunState["journal"] = []): PersistedRunState {
  return {
    runId,
    workflowName: "record-store-test",
    script: "export const meta = { name: 'record-store-test', description: 'test' }",
    args: { runId },
    status: "completed",
    phases: [],
    agents: [],
    logs: [],
    journal,
    startedAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
}

function fsWith(overrides: Partial<PersistenceFsLayer>): PersistenceFsLayer {
  return { ...defaultPersistenceFs(), ...overrides };
}

/** A running run whose agent row changes on every save, as progress writes do. */
function revision(runId: string, i: number, fixed = ""): PersistedRunState {
  return {
    ...state(runId),
    status: "running",
    args: { fixed },
    agents: [
      {
        id: 1,
        label: "worker",
        prompt: "p".repeat(800),
        status: "running",
        resultPreview: `revision ${i} ${"o".repeat(200)}`,
      },
    ],
    updatedAt: new Date(Date.UTC(2026, 8, 20, 0, 0, i)).toISOString(),
  };
}

function generationOf(path: string): string {
  return JSON.parse(readFileSync(path, "utf8")).generation;
}

function stagedLogs(dir: string): string[] {
  return readdirSync(dir).filter((name) => /\.events\.[\w-]+\.jsonl$/.test(name));
}

/** Revisions whose saves grow one log until the last save starts a new generation. */
function revisionsUntilSwitch(runId: string): PersistedRunState[] {
  const dir = mkdtempSync(join(tmpdir(), "pi-dw-record-probe-"));
  try {
    const path = join(dir, `${runId}.json`);
    const store = createRunRecordStore(defaultPersistenceFs());
    const revisions: PersistedRunState[] = [];
    let first: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const next = revision(runId, i);
      revisions.push(next);
      store.save(path, next);
      first ??= generationOf(path);
      if (generationOf(path) !== first) return revisions;
    }
    throw new Error("the log never started a new generation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function bytesOf(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
}

test(
  "growing journal append writes stay close to linear rather than rewriting the full record",
  withFixture((cwd) => {
    const path = join(cwd, "run.json");
    let writeBytes = 0;
    const real = defaultPersistenceFs();
    const fs = fsWith({
      writeFileSync: ((file, data, options?: WriteFileOptions) => {
        writeBytes += bytesOf(data as string | Uint8Array);
        return real.writeFileSync(file, data as never, options as never);
      }) as PersistenceFsLayer["writeFileSync"],
    });
    const store = createRunRecordStore(fs);
    mkdirSync(cwd, { recursive: true });
    let bytesAt200 = 0;
    let current = state("growth");
    for (let i = 0; i < 400; i++) {
      current = {
        ...current,
        journal: [...(current.journal ?? []), { index: i, hash: `hash-${i}`, result: "x".repeat(2048) }],
      };
      store.save(path, current);
      if (i === 199) bytesAt200 = writeBytes;
    }
    assert.ok(bytesAt200 > 0);
    assert.ok(writeBytes / bytesAt200 < 2.5, `400-entry writes must stay subquadratic: ${writeBytes}/${bytesAt200}`);
  }),
);

test(
  "a committed head remains authoritative after append succeeds but head rename fails, then retry drops the tail",
  withFixture(async (cwd) => {
    const path = join(cwd, "run.json");
    const real = defaultPersistenceFs();
    let headRenames = 0;
    const fs = fsWith({
      renameSync: ((from, to) => {
        if (
          String(from).startsWith(`${path}.`) &&
          String(from).endsWith(".tmp") &&
          String(to) === path &&
          ++headRenames === 2
        )
          throw new Error("injected head rename failure");
        return real.renameSync(from, to);
      }) as PersistenceFsLayer["renameSync"],
    });
    const store = createRunRecordStore(fs);
    const first = state("commit-boundary", [{ index: 0, hash: "h0", result: "old" }]);
    store.save(path, first);
    const failed = { ...first, journal: [...(first.journal ?? []), { index: 1, hash: "h1", result: "tail" }] };
    assert.throws(() => store.save(path, failed), /injected head rename failure/);

    assert.deepEqual(store.read(path)?.journal, first.journal, "same instance must expose only the old committed head");
    const cold = createRunRecordStore(defaultPersistenceFs());
    assert.deepEqual(cold.read(path)?.journal, first.journal, "cold reader must ignore the uncommitted tail");

    const retried = { ...first, journal: [...(first.journal ?? []), { index: 1, hash: "h1", result: "retry" }] };
    store.save(path, retried);
    assert.deepEqual(createRunRecordStore(defaultPersistenceFs()).read(path)?.journal, retried.journal);
  }),
);

test(
  "truncating or modifying committed events causes load to fail closed",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    const truncatedId = "truncated-events";
    rp.save(state(truncatedId, [{ index: 0, hash: "h", result: "value" }]));
    const truncatedLog = join(runsDir, `${truncatedId}.json.events.jsonl`);
    truncateSync(truncatedLog, statSync(truncatedLog).size - 1);
    assert.throws(() => createRunPersistence(cwd).load(truncatedId), RunRecordUnreadableError);

    const modifiedId = "modified-events";
    rp.save(state(modifiedId, [{ index: 0, hash: "h", result: "value" }]));
    const modifiedLog = join(runsDir, `${modifiedId}.json.events.jsonl`);
    const raw = readFileSync(modifiedLog, "utf8");
    writeFileSync(modifiedLog, raw.replace("value", "tampered"), "utf8");
    assert.throws(() => createRunPersistence(cwd).load(modifiedId), RunRecordUnreadableError);
  }),
);

test(
  "fresh list and manager construction avoid opening 100 event logs; detail access hydrates one",
  withFixture(async (cwd) => {
    const rp = createRunPersistence(cwd);
    for (let i = 0; i < 100; i++) rp.save(state(`terminal-${i}`, [{ index: 0, hash: `${i}`, result: `result-${i}` }]));

    let opens = 0;
    const real = defaultPersistenceFs();
    const fs = fsWith({
      openSync: ((...args) => {
        opens++;
        return real.openSync(...args);
      }) as PersistenceFsLayer["openSync"],
    });
    const fresh = createRunPersistence(cwd, fs);
    const listed = fresh.list();
    assert.equal(listed.length, 100);
    assert.equal(opens, 0, "list must read heads/previews without opening event logs");

    const { WorkflowManager } = await import("../src/workflow-manager.js");
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.listAllRuns().length, 100, "manager construction/list must retain all terminal previews");

    assert.equal((listed[0]?.journal ?? [])[0]?.result, `result-${listed[0]?.runId.split("-")[1]}`);
    assert.ok(opens > 0, "detail access must hydrate the selected event log");
  }),
);

test(
  "metadata marker updates set and clear without opening events, and mismatched delivery IDs preserve the marker",
  withFixture((cwd) => {
    const opens = { count: 0 };
    const real = defaultPersistenceFs();
    const fs = fsWith({
      openSync: ((...args) => {
        opens.count++;
        return real.openSync(...args);
      }) as PersistenceFsLayer["openSync"],
    });
    const rp = createRunPersistence(cwd, fs);
    const runId = "metadata-marker";
    rp.save(state(runId));
    opens.count = 0;
    assert.equal(
      rp.updateMetadata?.(runId, { pendingDelivery: { kind: "text", text: "hello", deliveryId: "d1" } }),
      true,
    );
    assert.equal(opens.count, 0, "setting metadata must not hydrate the event log");
    assert.equal(rp.load(runId)?.pendingDelivery?.deliveryId, "d1");
    opens.count = 0;

    assert.equal(rp.updateMetadata?.(runId, { pendingDelivery: undefined }, "wrong"), false);
    assert.equal(opens.count, 0, "mismatched clear must not hydrate the event log");
    assert.equal(rp.load(runId)?.pendingDelivery?.deliveryId, "d1");
    opens.count = 0;

    assert.equal(rp.updateMetadata?.(runId, { pendingDelivery: undefined }, "d1"), true);
    assert.equal(opens.count, 0, "clearing metadata must not hydrate the event log");
    assert.equal(rp.load(runId)?.pendingDelivery, undefined);
  }),
);

test(
  "delete removes the head, backup, tmp, and event log and then load returns null",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    const runId = "delete-record-store";
    rp.save(state(runId));
    const path = join(workflowProjectPaths(cwd).runsDir, `${runId}.json`);
    const staged = `${path}.events.${randomUUID()}.jsonl`;
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, "stale tmp", "utf8");
    writeFileSync(staged, "interrupted generation switch", "utf8");
    assert.ok(existsSync(path));
    assert.ok(existsSync(`${path}.bak`));
    assert.ok(existsSync(`${path}.events.jsonl`));
    assert.equal(rp.delete(runId), true);
    for (const candidate of [path, `${path}.bak`, temporary, `${path}.events.jsonl`, staged])
      assert.equal(existsSync(candidate), false, `${candidate} should be deleted`);
    assert.equal(rp.load(runId), null);
  }),
);

test(
  "cache evicts old records after eight entries and caller mutation never poisons cached state",
  withFixture(async (cwd) => {
    const real = defaultPersistenceFs();
    const paths = Array.from({ length: 10 }, (_, i) => join(cwd, `cache-${i}.json`));
    const writer = createRunRecordStore(real);
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      assert.ok(path);
      writer.save(path, state(`cache-${i}`, [{ index: 0, hash: `${i}`, result: `v${i}` }]));
    }

    let opens = 0;
    const fs = fsWith({
      openSync: ((...args) => {
        opens++;
        return real.openSync(...args);
      }) as PersistenceFsLayer["openSync"],
    });
    const store = createRunRecordStore(fs);
    const firstPath = paths[0];
    assert.ok(firstPath);
    const first = store.read(firstPath);
    assert.ok(first);
    first.script = "caller mutation";
    first.journal?.push({ index: 99, hash: "caller", result: "caller" });
    const unchanged = store.read(firstPath);
    assert.ok(unchanged);
    assert.notEqual(unchanged.script, "caller mutation");
    assert.equal(unchanged.journal?.length, 1);
    opens = 0;
    for (let i = 1; i < paths.length; i++) {
      const path = paths[i];
      assert.ok(path);
      store.read(path);
    }
    opens = 0;
    assert.equal(store.read(firstPath)?.script, state("cache-0").script);
    assert.ok(opens > 0, "the oldest entry must be rehydrated after cache capacity is exceeded");
  }),
);

test(
  "save input mutation after commit does not alter a previously committed record",
  withFixture(async (cwd) => {
    const path = join(cwd, "input-isolation.json");
    const store = createRunRecordStore(defaultPersistenceFs());
    const input = state("input-isolation", [{ index: 0, hash: "h", result: { original: true } }]);
    store.save(path, input);
    input.script = "mutated after save";
    input.args = { changed: true };
    const firstEntry = input.journal?.[0];
    assert.ok(firstEntry);
    firstEntry.result = { changed: true };
    const loaded = createRunRecordStore(defaultPersistenceFs()).read(path);
    assert.equal(loaded?.script, "export const meta = { name: 'record-store-test', description: 'test' }");
    assert.deepEqual(loaded?.args, { runId: "input-isolation" });
    assert.deepEqual(loaded?.journal?.[0]?.result, { original: true });
  }),
);

test(
  "startup recovery and metadata routing never open historical event logs",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    for (let i = 0; i < 30; i++) rp.save(state(`history-${i}`, [{ index: 0, hash: "h", result: "x".repeat(65536) }]));
    rp.save({
      ...state("orphan", [{ index: 0, hash: "paid", result: "PAID_RESULT" }]),
      status: "running",
      sessionId: "old",
      agents: [{ id: 1, label: "interrupted", prompt: "p", status: "running" }],
      pendingDelivery: { kind: "complete", deliveryId: "pending" },
    });
    const original = fsModule.openSync;
    let opens = 0;
    fsModule.openSync = ((path, ...args) => {
      if (String(path).endsWith(".events.jsonl") && args[0] === "r") opens++;
      return original(path, ...args);
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      const manager = new WorkflowManager({ cwd, sessionId: "old" });
      assert.equal(manager.listAllRuns().length, 31);
      manager.adoptLiveRunsToSession("new", "old");
      manager.recordAutoResumeAttempts("orphan", 2);
      assert.equal(opens, 0, "startup, ownership and counter updates must only read index heads");
    } finally {
      fsModule.openSync = original;
      syncBuiltinESMExports();
    }
    const recovered = createRunPersistence(cwd).load("orphan");
    assert.equal(recovered?.status, "paused");
    assert.equal(recovered?.agents[0].status, "skipped");
    assert.equal(recovered?.agents[0].error, "interrupted");
    assert.equal(recovered?.journal?.[0].result, "PAID_RESULT");
    assert.equal(recovered?.sessionId, "new");
    assert.equal(recovered?.autoResumeAttempts, 2);
  }),
);

test(
  "live writer mutex refuses a second writer and releases after failure",
  withFixture((cwd) => {
    const first = createRunPersistence(cwd);
    first.save(state("mutex"));
    const lock = join(first.getRunsDir(), "mutex.json.write-lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "foreign" }));
    assert.throws(
      () => first.save({ ...state("mutex"), script: "must not commit" }),
      /being written by another process/,
    );
    assert.equal(first.load("mutex")?.script, state("mutex").script);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "foreign");
  }),
);

test(
  "cached reads reject a tampered commit hash and unsupported future heads",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(state("tampered-head"));
    const path = join(rp.getRunsDir(), "tampered-head.json");
    const head = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...head, hash: "invalid" }));
    assert.throws(() => rp.load("tampered-head"), RunRecordUnreadableError);
    writeFileSync(path, JSON.stringify({ ...head, format: "pi-workflow-run-v99" }));
    assert.throws(() => rp.load("tampered-head"), /Unsupported/);
    assert.throws(() => rp.save(state("tampered-head")), /Unsupported/);
  }),
);

test(
  "large pending text stays out of index heads and is read only for delivery",
  withFixture((cwd) => {
    const text = "large error details ".repeat(10000);
    const rp = createRunPersistence(cwd);
    rp.save({ ...state("large-marker"), pendingDelivery: { kind: "text", text, deliveryId: "marker" } });
    const head = readFileSync(join(rp.getRunsDir(), "large-marker.json"), "utf8");
    assert.ok(head.length < 5000);
    assert.ok(!head.includes("large error details"));
    let opens = 0;
    const real = defaultPersistenceFs();
    const fresh = createRunPersistence(cwd, {
      openSync: ((...args) => {
        opens++;
        return real.openSync(...args);
      }) as typeof real.openSync,
    });
    const marker = fresh.list()[0].pendingDelivery;
    assert.equal(marker?.deliveryId, "marker");
    assert.equal(opens, 0);
    assert.equal(marker?.kind === "text" ? marker.text : undefined, text);
    assert.equal(opens, 1);
  }),
);

test(
  "result artifacts remain directly readable and are removed with their run",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(state("export"));
    const result = { longAnswer: "result ".repeat(2000) };
    const path = rp.exportResult?.("export", result);
    assert.ok(path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { runId: "export", result });
    assert.equal(rp.exportResult?.("export", result), path);
    assert.equal(rp.list().length, 1, "artifacts are not indexed as additional runs");
    assert.equal(rp.delete("export"), true);
    assert.equal(existsSync(path), false);
    assert.throws(() => rp.exportResult?.("export", result), /disappeared/);
  }),
);

test(
  "object cell changes preserve removals, arrays, null and nested objects",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    const first = {
      ...state("object-cells"),
      args: { a: 1, b: [1, 2] },
      result: { a: { score: 10, seen: 0 } },
    };
    rp.save(first);
    rp.save({
      ...first,
      args: { b: null, c: "new" },
      result: { ...first.result, b: { score: 20, seen: 4 } },
    });
    const next = createRunPersistence(cwd).load(first.runId);
    assert.deepEqual(next?.args, { b: null, c: "new" });
    assert.deepEqual(next?.result, { a: { score: 10, seen: 0 }, b: { score: 20, seen: 4 } });
    const events = readFileSync(join(rp.getRunsDir(), `${first.runId}.json.events.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(Object.keys(events[1].delta.objects.result.set), ["b"]);
  }),
);

test(
  "dead writer reclamation excludes a concurrent reaper and recovers a dead reaper",
  withFixture((cwd) => {
    const real = defaultPersistenceFs();
    const base = createRunPersistence(cwd);
    base.save(state("reapers"));
    const lock = join(base.getRunsDir(), "reapers.json.write-lock");
    writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "dead" }));
    const guard = `${lock}.reap-${createHash("sha256").update(`${lock}\0dead`).digest("hex")}`;
    writeFileSync(guard, JSON.stringify({ pid: 2147483647, token: "dead-reaper" }));
    let tested = false;
    const first = createRunPersistence(cwd, {
      linkSync: ((from, to) => {
        real.linkSync(from, to);
        if (String(to) === guard && !tested) {
          tested = true;
          assert.throws(() => base.save(state("reapers")), /being written by another process/);
          assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "dead");
        }
      }) as typeof real.linkSync,
    });
    first.save({ ...state("reapers"), script: "recovered" });
    assert.ok(tested);
    assert.equal(base.load("reapers")?.script, "recovered");
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(guard), false);
  }),
);

test(
  "a stale observation cannot remove a newly claimed live writer mutex",
  withFixture((cwd) => {
    const real = defaultPersistenceFs();
    const base = createRunPersistence(cwd);
    base.save(state("replacement-owner"));
    const lock = join(base.getRunsDir(), "replacement-owner.json.write-lock");
    writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: "stale" }));
    let replaced = false;
    const contender = createRunPersistence(cwd, {
      linkSync: ((from, to) => {
        if (String(to).startsWith(`${lock}.reap-`) && !replaced) {
          replaced = true;
          // Another writer reclaimed and claimed the original lock while this
          // contender was paused after reading its old dead-owner identity.
          writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "new-live-owner" }));
        }
        real.linkSync(from, to);
      }) as typeof real.linkSync,
    });
    assert.throws(() => contender.save(state("replacement-owner")), /being written by another process/);
    assert.ok(replaced);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "new-live-owner");
  }),
);

test(
  "hot and cold reads both reject a head whose sequence or run id no longer matches its log",
  withFixture((cwd) => {
    const path = join(cwd, "commit-identity.json");
    const store = createRunRecordStore(defaultPersistenceFs());
    store.save(path, state("commit-identity"));
    const head = readFileSync(path, "utf8");
    const parsed = JSON.parse(head);
    for (const damaged of [
      { ...parsed, sequence: parsed.sequence + 1 },
      { ...parsed, index: { ...parsed.index, runId: "another-run" } },
    ]) {
      writeFileSync(path, head);
      assert.equal(store.read(path)?.runId, "commit-identity", "the intact head is cached");
      writeFileSync(path, JSON.stringify(damaged));
      assert.throws(() => store.read(path), /Run commit mismatch/, "a cached replay must not vouch for another commit");
      assert.throws(() => createRunRecordStore(defaultPersistenceFs()).read(path), /Run commit mismatch/);
    }
  }),
);

test(
  "a growing history is compacted into a snapshot generation, bounding what a cold load parses",
  withFixture((cwd) => {
    // Small runs stay under an absolute floor; large runs within a multiple of their own size.
    for (const [fixed, saves] of [
      ["", 100],
      ["f".repeat(24 * 1024), 200],
    ] as const) {
      const path = join(cwd, `compaction-${fixed.length}.json`);
      const store = createRunRecordStore(defaultPersistenceFs());
      const generations = new Set<string>();
      let largestLog = 0;
      let current = revision("compaction", 0, fixed);
      for (let i = 0; i < saves; i++) {
        current = revision("compaction", i, fixed);
        store.save(path, current);
        generations.add(generationOf(path));
        largestLog = Math.max(largestLog, statSync(`${path}.events.jsonl`).size);
      }
      const stateBytes = Buffer.byteLength(JSON.stringify(current));
      assert.ok(generations.size > 1, "the log must be rewritten as a snapshot");
      assert.ok(
        largestLog <= Math.max(24 * 1024, 5 * stateBytes),
        `log ${largestLog} bytes for a ${stateBytes}-byte run after ${saves} saves`,
      );
      assert.deepEqual(createRunRecordStore(defaultPersistenceFs()).read(path), current);
      assert.deepEqual(stagedLogs(cwd), []);
    }
  }),
);

test(
  "a generation switch interrupted at any filesystem step recovers the old or the new run",
  withFixture((cwd) => {
    const revisions = revisionsUntilSwitch("crash");
    const switching = revisions.at(-1) as PersistedRunState;
    const previous = revisions.at(-2) as PersistedRunState;
    const real = defaultPersistenceFs();
    let covered = 0;
    for (let crashAt = 1; ; crashAt++) {
      const dir = join(cwd, `crash-${crashAt}`);
      mkdirSync(dir);
      const path = join(dir, "crash.json");
      const setup = createRunRecordStore(real);
      for (const revision of revisions.slice(0, -1)) setup.save(path, revision);

      // Once crashed, the process performs no further filesystem changes; a
      // write it was in the middle of leaves a torn prefix behind.
      let steps = 0;
      let crashed = false;
      const step = () => {
        if (!crashed && ++steps === crashAt) crashed = true;
        return crashed;
      };
      const crashing = fsWith({
        writeFileSync: ((file, data, options?: WriteFileOptions) => {
          if (!crashed && step()) {
            const text = String(data);
            real.writeFileSync(file, text.slice(0, Math.floor(text.length / 2)), options);
          }
          if (crashed) throw new Error("injected crash");
          return real.writeFileSync(file, data, options);
        }) as PersistenceFsLayer["writeFileSync"],
        renameSync: ((from, to) => {
          if (step()) throw new Error("injected crash");
          return real.renameSync(from, to);
        }) as PersistenceFsLayer["renameSync"],
        truncateSync: ((file, length) => {
          if (step()) throw new Error("injected crash");
          return real.truncateSync(file, length);
        }) as PersistenceFsLayer["truncateSync"],
        unlinkSync: ((file) => {
          if (step()) throw new Error("injected crash");
          return real.unlinkSync(file);
        }) as PersistenceFsLayer["unlinkSync"],
      });
      try {
        createRunRecordStore(crashing).save(path, switching);
      } catch {
        // The process died here.
      }
      if (!crashed) break;
      covered++;

      // A restarted process reads exactly one of the two commits, from the
      // head or, when only the backup survives, from the backup.
      const restarted = createRunRecordStore(real).read(path);
      assert.ok(
        isDeepStrictEqual(restarted, previous) || isDeepStrictEqual(restarted, switching),
        `crash at step ${crashAt} must leave the old or the new run`,
      );
      let backupIntact = true;
      try {
        JSON.parse(readFileSync(`${path}.bak`, "utf8"));
      } catch {
        backupIntact = false;
      }
      if (backupIntact) {
        const fromBackup = createRunRecordStore(
          fsWith({ existsSync: ((file) => String(file) !== path && real.existsSync(file)) as typeof real.existsSync }),
        ).read(path);
        assert.ok(
          isDeepStrictEqual(fromBackup, previous) || isDeepStrictEqual(fromBackup, switching),
          `crash at step ${crashAt} must leave a backup of the old or the new run`,
        );
      }

      // The next writer finishes or discards the interrupted switch.
      const resumed = { ...switching, logs: [`resumed after step ${crashAt}`] };
      createRunRecordStore(real).save(path, resumed);
      assert.deepEqual(createRunRecordStore(real).read(path), resumed);
      assert.deepEqual(stagedLogs(dir), [], `crash at step ${crashAt} must not leave a staged log behind`);
    }
    assert.ok(covered >= 5, `every step of the switch must be a crash point (${covered})`);
  }),
);

test(
  "a reader racing a generation switch replays the new commit instead of the retired log",
  withFixture((cwd) => {
    const revisions = revisionsUntilSwitch("race");
    const switching = revisions.at(-1) as PersistedRunState;
    const path = join(cwd, "race.json");
    const real = defaultPersistenceFs();
    const writer = createRunRecordStore(real);
    for (const revision of revisions.slice(0, -1)) writer.save(path, revision);

    let raced = false;
    const reader = createRunRecordStore(
      fsWith({
        statSync: ((file, ...rest) => {
          // The writer switches generations after the reader read its head.
          if (!raced && String(file) === `${path}.events.jsonl`) {
            raced = true;
            writer.save(path, switching);
          }
          return real.statSync(file, ...rest);
        }) as typeof real.statSync,
      }),
    );
    assert.deepEqual(reader.read(path), switching);
    assert.ok(raced);

    const view = createRunRecordStore(real).peek(path);
    assert.ok(view);
    const viewed = generationOf(path);
    for (let i = 0; generationOf(path) === viewed; i++) {
      assert.ok(i < 1000, "the log never started a new generation");
      writer.save(path, { ...revision("race", i), logs: ["after the view"] });
    }
    assert.deepEqual(view.logs, ["after the view"], "a listed view still loads its fields after its log is retired");
  }),
);

test(
  "a stale lease observation cannot remove a lease another process just took",
  withFixture((cwd) => {
    const real = defaultPersistenceFs();
    const base = createRunPersistence(cwd);
    base.save(state("lease-race"));
    const runsDir = base.getRunsDir();
    const lock = join(runsDir, "lease-race.lock");
    const owner = (pid: number, token: string) =>
      JSON.stringify({ runId: "lease-race", runPath: join(runsDir, "lease-race.json"), pid, token, startedAt: "x" });
    writeFileSync(lock, owner(2147483647, "dead"));
    let replaced = false;
    const contender = createRunPersistence(cwd, {
      linkSync: ((from, to) => {
        if (String(to).startsWith(`${lock}.reap-`) && !replaced) {
          // Another process reclaimed the dead lease and took it while this
          // contender was still acting on its old observation.
          replaced = true;
          writeFileSync(lock, owner(process.pid, "new-live-owner"));
        }
        real.linkSync(from, to);
      }) as typeof real.linkSync,
    });
    assert.equal(contender.acquireRunLease("lease-race"), null);
    assert.ok(replaced);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "new-live-owner");
  }),
);

test(
  "a lease lock is published whole, and one that is not an owner record is never deleted on a guess",
  withFixture((cwd) => {
    const real = defaultPersistenceFs();
    const base = createRunPersistence(cwd);
    base.save(state("lease-publish"));
    const lock = join(base.getRunsDir(), "lease-publish.lock");
    const seen: string[] = [];
    const watcher = createRunPersistence(cwd, {
      linkSync: ((from, to) => {
        real.linkSync(from, to);
        if (String(to) === lock) seen.push(readFileSync(lock, "utf8"));
      }) as typeof real.linkSync,
    });
    const lease = watcher.acquireRunLease("lease-publish");
    assert.ok(lease);
    assert.equal(JSON.parse(seen[0] ?? "").token, lease.token, "the lock appeared with its complete owner record");
    assert.equal(base.acquireRunLease("lease-publish"), null, "a live owner keeps its lease");
    watcher.releaseRunLease(lease);

    writeFileSync(lock, "");
    assert.equal(base.acquireRunLease("lease-publish"), null);
    assert.equal(readFileSync(lock, "utf8"), "", "a damaged lock stays for inspection");
  }),
);

test(
  "retention holds a run's lease while it deletes, so no process can take the run over mid-delete",
  withFixture((cwd) => {
    const real = defaultPersistenceFs();
    const other = createRunPersistence(cwd);
    let leaseDuringDelete: unknown = "not reached";
    const pruner = createRunPersistence(
      cwd,
      {
        unlinkSync: ((path) => {
          if (String(path).endsWith(`${join("runs", "oldest.json")}`) && leaseDuringDelete === "not reached") {
            leaseDuringDelete = other.acquireRunLease("oldest");
          }
          real.unlinkSync(path);
        }) as typeof real.unlinkSync,
      },
      { maxTerminalRunsOnDisk: 1 },
    );
    pruner.save({ ...state("oldest"), updatedAt: "2026-01-01T00:00:00.000Z" });
    pruner.save(state("newest"));
    assert.equal(leaseDuringDelete, null, "the pruner held the lease at the commit point");
    assert.equal(pruner.load("oldest"), null);
    assert.ok(pruner.load("newest"));
  }),
);

test(
  "a record whose head and backup are both damaged fails closed and is never written over",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(state("both-damaged", [{ index: 0, hash: "h", result: "paid result" }]));
    const path = join(rp.getRunsDir(), "both-damaged.json");
    const log = `${path}.events.jsonl`;
    const before = readFileSync(log, "utf8");
    writeFileSync(path, "{ torn");
    writeFileSync(`${path}.bak`, "{ torn too");

    const reader = createRunPersistence(cwd);
    assert.throws(() => reader.load("both-damaged"), RunRecordUnreadableError);
    assert.throws(() => reader.loadPreview("both-damaged"), RunRecordUnreadableError);
    assert.throws(() => reader.save(state("both-damaged")), RunRecordUnreadableError);
    assert.equal(readFileSync(log, "utf8"), before, "the committed log is untouched");
  }),
);

test(
  "a record whose committed log is missing or short is skipped everywhere, reported once, and still removable",
  withFixture(async (cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(state("short-log"));
    rp.save(state("no-log"));
    rp.save(state("intact"));
    const runsDir = rp.getRunsDir();
    const shortLog = join(runsDir, "short-log.json.events.jsonl");
    writeFileSync(shortLog, readFileSync(shortLog, "utf8").slice(0, 10));
    rmSync(join(runsDir, "no-log.json.events.jsonl"));

    const reports: string[] = [];
    const release = bindDiagnosticSink((message) => reports.push(message));
    try {
      const reader = createRunPersistence(cwd);
      assert.deepEqual(
        reader.list().map((run) => run.runId),
        ["intact"],
        "a view is listed only when load() could read it",
      );
      reader.list();
      assert.throws(() => reader.loadPreview("short-log"), RunRecordUnreadableError);
      assert.throws(() => reader.loadPreview("no-log"), RunRecordUnreadableError);
      assert.equal(reports.length, 2, "each damaged record is reported once, not on every refresh");
      for (const runId of ["short-log", "no-log"]) {
        assert.ok(reports.some((message) => message.includes(`Remove it with /workflows rm ${runId}`)));
      }

      const manager = new WorkflowManager({ cwd });
      assert.equal(manager.findRun("short-log"), undefined);
      assert.equal(manager.deleteRun("short-log"), true, "a damaged record can still be removed by id");
    } finally {
      release();
    }
  }),
);

test(
  "damage inside a log of the right size fails a lazy field read as an unreadable record",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(state("bit-rot", [{ index: 0, hash: "h", result: "paid result" }]));
    const log = join(rp.getRunsDir(), "bit-rot.json.events.jsonl");
    const text = readFileSync(log, "utf8");
    writeFileSync(log, text.replace("paid result", "PAID RESULT"));

    const view = createRunPersistence(cwd)
      .list()
      .find((run) => run.runId === "bit-rot");
    assert.ok(view, "the head and a full-size log list the run");
    assert.throws(() => view.journal, RunRecordUnreadableError);
  }),
);

test(
  "a head that parses but is not a valid commit falls back to its backup like a torn one",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(state("bad-head"));
    const path = join(rp.getRunsDir(), "bad-head.json");
    const head = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...head, bytes: -1 }));

    const reader = createRunPersistence(cwd);
    assert.equal(reader.load("bad-head")?.runId, "bad-head");
    assert.ok(
      reader.list().some((run) => run.runId === "bad-head"),
      "listed exactly as load() reads it",
    );
  }),
);

test(
  "the navigator shows a listed run with a damaged log as damaged instead of failing",
  withFixture((cwd) => {
    const rp = createRunPersistence(cwd);
    rp.save(state("bit-rot-view", [{ index: 0, hash: "h", result: "paid result" }]));
    const log = join(rp.getRunsDir(), "bit-rot-view.json.events.jsonl");
    writeFileSync(log, readFileSync(log, "utf8").replace("paid result", "PAID RESULT"));

    const view = createRunPersistence(cwd)
      .list()
      .find((run) => run.runId === "bit-rot-view");
    assert.ok(view);
    const snapshot = persistedToSnapshot(view);
    assert.equal(snapshot.agents.length, 0);
    assert.match(snapshot.logs[0], /cannot be read: .*Remove it with \/workflows rm bit-rot-view/);
  }),
);
