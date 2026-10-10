/**
 * Filesystem layout for pi-dynamic-workflows state.
 *
 * New writes live under the user's workflow home so projects do not get
 * scattered `.pi/workflows` directories. Project-scoped state is still isolated
 * by a stable cwd-derived namespace.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { WORKFLOW_RUNS_DIR, WORKFLOW_SAVED_DIR } from "./config.js";
export const WORKFLOW_HOME_RELATIVE_DIR = ".pi/workflows";
export const WORKFLOW_PROJECTS_SUBDIR = "projects";
export function workflowHomeDir() {
    return join(homedir(), WORKFLOW_HOME_RELATIVE_DIR);
}
export function workflowUserSavedDir() {
    return join(workflowHomeDir(), "saved");
}
/**
 * Storage key of the project at `cwd`: its folder name and a hash of its path.
 * Windows paths are case-insensitive, so one directory has many spellings
 * (drive letter and name case, 8.3 names); the hash uses the spelling stored
 * on disk, which is also how Windows normally reports the path.
 */
export function workflowProjectKey(cwd) {
    return keyOf(projectPath(cwd));
}
function projectPath(cwd) {
    const path = resolve(cwd);
    if (process.platform !== "win32")
        return path;
    try {
        return realpathSync.native(path);
    }
    catch {
        // A directory that does not exist yet has no stored spelling.
        return path;
    }
}
function keyOf(path) {
    const slug = sanitizePathSegment(basename(path) || "project");
    const hash = createHash("sha256").update(path).digest("hex").slice(0, 12);
    return `${slug}-${hash}`;
}
export function workflowProjectPaths(cwd) {
    const rootDir = projectRootDir(cwd);
    return {
        key: basename(rootDir),
        rootDir,
        runsDir: join(rootDir, "runs"),
        savedDir: join(rootDir, "saved"),
        settingsPath: join(rootDir, "settings.json"),
        modelTiersPath: join(rootDir, "model-tiers.json"),
        legacyRunsDir: resolve(cwd, WORKFLOW_RUNS_DIR),
        legacySavedDir: resolve(cwd, WORKFLOW_SAVED_DIR),
    };
}
/** Root chosen for each spelled-key directory that differed from its canonical key, kept for the process. */
const chosenRoots = new Map();
/**
 * Storage root of the project at `cwd`. Keys used to hash the path as typed,
 * so data from a session opened with another spelling sits under that
 * spelling's key. A process keeps the root it picked first: its stores hold
 * paths, and switching mid-session would split one project's data.
 */
function projectRootDir(cwd) {
    const projectsDir = join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR);
    const canonicalRoot = join(projectsDir, workflowProjectKey(cwd));
    const spelledRoot = join(projectsDir, keyOf(resolve(cwd)));
    if (spelledRoot === canonicalRoot)
        return canonicalRoot;
    let root = chosenRoots.get(spelledRoot);
    if (root === undefined) {
        root = adoptSpelledRoot(spelledRoot, canonicalRoot);
        chosenRoots.set(spelledRoot, root);
    }
    return root;
}
/**
 * Move a spelling's directory to the canonical key when that key has none,
 * so every spelling finds the data. Otherwise the spelling keeps its own
 * directory, which is what it showed before: when the canonical key already
 * has data (nothing is merged), or while one of its runs holds a lock (the
 * lock records the old path and its owner may still be writing there).
 */
function adoptSpelledRoot(spelledRoot, canonicalRoot) {
    if (!existsSync(spelledRoot))
        return canonicalRoot;
    if (existsSync(canonicalRoot) || holdsRunLock(spelledRoot))
        return spelledRoot;
    try {
        renameSync(spelledRoot, canonicalRoot);
        return canonicalRoot;
    }
    catch {
        // A file inside is open, or another process moved it first.
        return existsSync(spelledRoot) ? spelledRoot : canonicalRoot;
    }
}
function holdsRunLock(rootDir) {
    try {
        return readdirSync(join(rootDir, "runs")).some((name) => name.endsWith(".lock"));
    }
    catch {
        return false;
    }
}
function sanitizePathSegment(value) {
    const sanitized = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
    return sanitized || "project";
}
