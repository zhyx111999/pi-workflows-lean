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
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync, } from "node:fs";
/** The real node:fs implementations. */
export function defaultPersistenceFs() {
    return {
        linkSync,
        openSync,
        readSync,
        closeSync,
        truncateSync,
        existsSync,
        mkdirSync,
        readdirSync,
        readFileSync,
        renameSync,
        statSync,
        unlinkSync,
        writeFileSync,
    };
}
/** Merge a partial test override on top of the real node:fs implementations. */
export function resolvePersistenceFs(overrides) {
    const base = defaultPersistenceFs();
    return overrides ? { ...base, ...overrides } : base;
}
/** Ensure `dir` exists (recursive mkdir), idempotent. */
export function ensureDir(fs, dir) {
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
}
/**
 * Atomically write JSON to `path`: tmp-write + rename (atomic on the same
 * filesystem, so a crash mid-write can't corrupt the live file), then
 * best-effort refresh a `.bak` sidecar from the just-written good state —
 * the recovery fallback readJsonWithBackupRecovery() uses if the primary is
 * later found truncated (e.g. a rename that itself got interrupted by a
 * power loss on a filesystem/OS combination where rename isn't fully atomic).
 */
export function writeJsonAtomicWithBackup(fs, path, data) {
    writeJsonAtomic(fs, path, data, false);
}
/**
 * The same tmp-write + atomic-rename protocol, but reports a backup-write
 * failure. Mutations that must retain a source record until a replacement is
 * fully recoverable (notably saved-workflow rename) use this stricter variant.
 */
export function writeJsonAtomicWithBackupStrict(fs, path, data) {
    writeJsonAtomic(fs, path, data, true);
}
function writeJsonAtomic(fs, path, data, strictBackup) {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(`${path}.tmp`, json);
    fs.renameSync(`${path}.tmp`, path);
    if (strictBackup) {
        fs.writeFileSync(`${path}.bak`, json);
        return;
    }
    try {
        fs.writeFileSync(`${path}.bak`, json);
    }
    catch {
        // Backup is best-effort; the primary write already succeeded.
    }
}
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
export function writeJsonAtomicPreservingPreviousBackup(fs, path, data) {
    let previous;
    try {
        if (fs.existsSync(path)) {
            const raw = fs.readFileSync(path, "utf8");
            JSON.parse(raw); // validate — corrupt bytes are not a recoverable version
            previous = raw;
        }
    }
    catch {
        previous = undefined; // preserve the existing .bak instead of copying garbage
    }
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(`${path}.tmp`, json);
    fs.renameSync(`${path}.tmp`, path);
    if (previous === undefined && fs.existsSync(`${path}.bak`)) {
        // Keep the existing backup only when it still parses — a corrupt .bak is
        // not a recovery source, and the new content is strictly better (r2 NIT).
        try {
            JSON.parse(fs.readFileSync(`${path}.bak`, "utf8"));
            return; // keep the last good backup
        }
        catch {
            // fall through and mirror the new content
        }
    }
    try {
        fs.writeFileSync(`${path}.bak`, previous ?? json);
    }
    catch {
        // Backup is best-effort; the primary write already succeeded.
    }
}
/**
 * Read JSON from `path`, falling back to `path.bak` if the primary is
 * missing or fails to parse. Returns null if neither candidate parses.
 */
export function readJsonWithBackupRecovery(fs, path) {
    for (const candidate of [path, `${path}.bak`]) {
        try {
            if (!fs.existsSync(candidate))
                continue;
            return JSON.parse(fs.readFileSync(candidate, "utf-8"));
        }
        catch {
            // Corrupt candidate -> fall through to the next candidate.
        }
    }
    return null;
}
/**
 * List `.json` record files in `dir`. A missing directory (never created
 * yet) or an unreadable one (deleted between the existsSync check and
 * readdirSync, permission-denied, etc.) both degrade to an empty list
 * rather than throwing — callers (run listings, saved-workflow listings)
 * must never crash a navigator/listing because one storage location is
 * temporarily inaccessible.
 */
export function listJsonFilesSafe(fs, dir) {
    try {
        if (!fs.existsSync(dir))
            return [];
        return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    }
    catch {
        return [];
    }
}
/** Best-effort unlink; ignores missing-file/permission errors, reports whether it deleted anything. */
export function unlinkIfExistsSafe(fs, path) {
    try {
        if (fs.existsSync(path)) {
            fs.unlinkSync(path);
            return true;
        }
    }
    catch {
        // ignore
    }
    return false;
}
