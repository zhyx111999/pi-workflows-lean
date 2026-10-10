/**
 * In-memory key-value store scoped to a single workflow run.
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Two MCP-compatible tool definitions (`store_put` / `store_get`) are
 * injected into every agent's tool list so parallel agents can share
 * intermediate state without coordinating through the script itself.
 *
 * Journal integration: callers capture `store.commitDelta(deltaKey)` alongside
 * each agent result in the journal. On resume, `store.applyDelta(delta)` rebuilds
 * the store state additively in callSeq order, so parallel-agent writes are
 * replayed correctly without the last-complete-wins ordering bug that a
 * whole-Map restore() would cause. Known limitation: when two PARALLEL agents
 * write the SAME key, live resolution follows last-WRITE order while replay
 * follows callSeq order, so the final value can differ between live and resume
 * (the deltas themselves are journaled and replayed faithfully; only the
 * same-key ordering is not reconstructible).
 *
 * Aliasing: values are structured-cloned on write AND on read, so a
 * caller can never mutate store state through a live reference — the journaled
 * delta and any rollback-restored value always match what resume replays.
 * Values must be structured-cloneable (functions/symbols throw at write time)
 * AND JSON-serializable for journal persistence (BigInt/cycles fail that) —
 * the two classes overlap but differ; both constraints apply.
 *
 * `deltaKey` must be unique per agent call for the store's lifetime: two calls
 * sharing a key would merge or clobber each other's journaled delta. Callers
 * use the call id `${runId}:${callIndex}`.
 */
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
export declare class SharedStore {
    private readonly map;
    private readonly agentDeltas;
    private readonly keyHistories;
    private historyFor;
    /**
     * Drop entries below the topmost untagged (permanent) write: an untagged
     * entry can never be removed by a discard, so everything below it is
     * unobservable and would otherwise grow the log without bound.
     */
    private compactHistory;
    /** Recompute a key's visible value as its last surviving write (or absent). */
    private recompute;
    /** Store a value under `key`. Overwrites any existing value. */
    put(key: string, value: unknown): void;
    /**
     * Store a value and record the write in the per-agent delta for `deltaKey`
     * (a run-unique `${runId}:${callIndex}` string — see class doc). Used by
     * per-agent tools created via `createAgentStoreTools` so that each agent's
     * writes can be journaled and replayed independently.
     */
    trackPut(key: string, value: unknown, deltaKey: string): void;
    /**
     * Retrieve a structured CLONE of the value for `key`, or `undefined` when
     * absent. Callers receive their own copy: in-place mutation through the
     * returned reference must never leak into the store, the journaled delta,
     * or a value a later rollback restores.
     */
    get(key: string): unknown;
    /** Whether `key` is present in the store. */
    has(key: string): boolean;
    /** Return a deep-copied plain-object snapshot of all entries. */
    snapshot(): Record<string, unknown>;
    /**
     * Extract and clear the write delta accumulated for `deltaKey`.
     * Called after an agent completes to get the set of keys it wrote. The
     * window's write-log entries stay: a committed write is permanent history
     * that later discards must not remove (resume replay re-applies it). A
     * later discardDelta for the same key is a no-op — the delta bookkeeping
     * is gone — so committed entries are unreachable by rollbacks.
     */
    commitDelta(deltaKey: string): Record<string, unknown>;
    /**
     * Undo the writes recorded for `deltaKey` and discard its bookkeeping,
     * without touching any other key. Used when a retry attempt fails: that
     * attempt's writes must not remain visible in the live store (e.g. to a
     * concurrently-running sibling agent's store_get, or to embedder code
     * reading `store.get` directly) and must not merge into the delta eventually
     * recorded when a later attempt of the SAME call succeeds — otherwise a
     * failed attempt's mutations would silently survive into the run's live
     * state while being absent from the journaled delta that resume replay
     * reconstructs from, leaving live execution and replay permanently
     * inconsistent.
     *
     * Exact undo semantics: the attempt's entries are removed from each
     * key's write log and the visible value recomputes as the last SURVIVING
     * write — a concurrent sibling's later write (even an Object.is-equal one)
     * survives, an untracked put()/replay applyDelta() survives, and a shadowed
     * write by an earlier window resurfaces only if that window itself is still
     * live or committed.
     *
     * A no-op if `deltaKey` never wrote anything (nothing to roll back).
     */
    discardDelta(deltaKey: string): void;
    /**
     * Apply a write delta additively — sets each key without clearing others.
     * Used during resume replay so parallel-agent deltas applied in callSeq
     * order accumulate correctly regardless of original completion order.
     * Replay writes are untagged log entries: they belong to no live window and
     * no window's discard may remove them.
     */
    applyDelta(delta: Record<string, unknown>): void;
    /**
     * Replace all entries with a snapshot (for full resets).
     * Prefer `applyDelta` for resume replay — see journal integration above.
     */
    restore(snap: Record<string, unknown>): void;
    /** Clear all entries (called when the run ends). */
    dispose(): void;
}
/**
 * Create per-agent store tools that attribute writes to `deltaKey`, the
 * agent call id `${runId}:${callIndex}` (see the `SharedStore` class doc).
 * Used internally by `runWorkflow` so each agent's puts are tracked in the
 * store's delta journal and can be replayed additively on resume.
 */
export declare function createAgentStoreTools(store: SharedStore, deltaKey: string): ToolDefinition[];
