/**
 * Shared filesystem primitives for JSON-backed persistence.
 *
 * Both run-persistence.ts (workflow runs) and workflow-saved.ts (saved
 * workflow commands) persist plain-JSON records to per-record files under a
 * project/user directory, and both need the same three guarantees:
 *
 *  1. Atomic writes with a recovery backup — a crash mid-write must never
 *     corrupt the live file, and a later-discovered-truncated primary must
 *     still be recoverable from the last good write.
 *  2. Corrupt-file recovery on read — a truncated/corrupt primary falls back
 *     to its `.bak` sidecar instead of losing the record.
 *  3. A missing or unreadable directory degrades to "no files" rather than
 *     throwing — a listing must never crash because one storage location is
 *     temporarily inaccessible (not yet created, deleted mid-race, EACCES).
 *
 * This module is the single implementation of all three; run-persistence.ts
 * and workflow-saved.ts both call into it rather than maintaining parallel
 * copies.
 */
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
/** Filesystem operations used by JSON persistence. Exposed for testing. */
export type PersistenceFsLayer = {
    linkSync: typeof linkSync;
    openSync: typeof openSync;
    readSync: typeof readSync;
    closeSync: typeof closeSync;
    truncateSync: typeof truncateSync;
    existsSync: typeof existsSync;
    mkdirSync: typeof mkdirSync;
    readdirSync: typeof readdirSync;
    readFileSync: typeof readFileSync;
    renameSync: typeof renameSync;
    statSync: typeof statSync;
    unlinkSync: typeof unlinkSync;
    writeFileSync: typeof writeFileSync;
};
/** The real node:fs implementations. */
export declare function defaultPersistenceFs(): PersistenceFsLayer;
/** Merge a partial test override on top of the real node:fs implementations. */
export declare function resolvePersistenceFs(overrides?: Partial<PersistenceFsLayer>): PersistenceFsLayer;
/** Ensure `dir` exists (recursive mkdir), idempotent. */
export declare function ensureDir(fs: PersistenceFsLayer, dir: string): void;
/**
 * Atomically write JSON to `path`: tmp-write + rename (atomic on the same
 * filesystem, so a crash mid-write can't corrupt the live file), then
 * best-effort refresh a `.bak` sidecar from the just-written good state —
 * the recovery fallback readJsonWithBackupRecovery() uses if the primary is
 * later found truncated (e.g. a rename that itself got interrupted by a
 * power loss on a filesystem/OS combination where rename isn't fully atomic).
 */
export declare function writeJsonAtomicWithBackup(fs: PersistenceFsLayer, path: string, data: unknown): void;
/**
 * The same tmp-write + atomic-rename protocol, but reports a backup-write
 * failure. Mutations that must retain a source record until a replacement is
 * fully recoverable (notably saved-workflow rename) use this stricter variant.
 */
export declare function writeJsonAtomicWithBackupStrict(fs: PersistenceFsLayer, path: string, data: unknown): void;
/**
 * Atomic write that preserves the file's PREVIOUS content as `.bak`
 * (version-history semantics, not crash-mirror semantics): an accidental
 * same-name overwrite leaves the prior version recoverable instead of
 * destroying it with zero remaining bytes (audit2 #36). Recovery via
 * readJsonWithBackupRecovery() then yields the previous version when the new
 * primary is unreadable — strictly better than an unrecoverable loss.
 *
 * The previous content is only used when it READS and PARSES: a corrupt
 * primary must not poison the backup (a later corruption would then lose
 * everything), and an unreadable primary must not fail the save (tmp+rename
 * needs no read permission) — in both cases the existing `.bak` is preserved
 * if it still parses, else replaced with the new content.
 */
export declare function writeJsonAtomicPreservingPreviousBackup(fs: PersistenceFsLayer, path: string, data: unknown): void;
/**
 * Read JSON from `path`, falling back to `path.bak` if the primary is
 * missing or fails to parse. Returns null if neither candidate parses.
 */
export declare function readJsonWithBackupRecovery<T>(fs: PersistenceFsLayer, path: string): T | null;
/**
 * List `.json` record files in `dir`. A missing directory (never created
 * yet) or an unreadable one (deleted between the existsSync check and
 * readdirSync, permission-denied, etc.) both degrade to an empty list
 * rather than throwing — callers (run listings, saved-workflow listings)
 * must never crash a navigator/listing because one storage location is
 * temporarily inaccessible.
 */
export declare function listJsonFilesSafe(fs: PersistenceFsLayer, dir: string): string[];
/** Best-effort unlink; ignores missing-file/permission errors, reports whether it deleted anything. */
export declare function unlinkIfExistsSafe(fs: PersistenceFsLayer, path: string): boolean;
