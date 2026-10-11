/**
 * Save and load reusable workflow commands.
 */
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureDir as ensureDirFs, listJsonFilesSafe, readJsonWithBackupRecovery, resolvePersistenceFs, writeJsonAtomicPreservingPreviousBackup, writeJsonAtomicWithBackupStrict, } from "./fs-persistence.js";
import { workflowProjectPaths, workflowUserSavedDir } from "./workflow-paths.js";
/** Stable content fingerprint used to guard mutations against same-path races. */
export function savedWorkflowRevision(workflow) {
    return createHash("sha256")
        .update(JSON.stringify({
        name: workflow.name,
        description: workflow.description,
        script: workflow.script,
        parameters: workflow.parameters ?? null,
        savedAt: workflow.savedAt,
    }))
        .digest("hex");
}
export const SAVED_WORKFLOW_NAME_RULE = 'Saved workflow name must be 1-128 characters usable as a slash command and as a file name on every platform: no whitespace, control or format characters, slashes, or any of < > : " | ? *, no trailing dot, and not a Windows device name such as CON, NUL, COM1, or LPT1.';
/**
 * Whitespace, control and format characters (including bidi controls) make a
 * command name ambiguous or invisible; the rest cannot appear in a Windows file
 * name. A ':' would even "succeed" there by writing an NTFS alternate data stream.
 */
const FORBIDDEN_NAME_CHARACTER = /[\s\p{Cc}\p{Cf}/\\<>:"|?*]/u;
/** Windows maps these names to devices in any case and with any extension (`nul.tar.gz` is still NUL). */
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i;
/**
 * Saved workflow names are Pi slash-command names as well as file names, and a
 * workflow saved on one platform must stay usable on another, so the Windows
 * file-name rules apply everywhere. Save, rename, and load all use this one
 * rule. The input is `unknown` because loaded names come from untrusted JSON.
 */
export function isSafeSavedWorkflowName(name) {
    return (typeof name === "string" &&
        name.length > 0 &&
        name.length <= 128 &&
        !FORBIDDEN_NAME_CHARACTER.test(name) &&
        // A trailing dot is silently stripped by Windows; this also rules out "." and "..".
        !name.endsWith(".") &&
        !WINDOWS_DEVICE_NAME.test(name));
}
export function assertSafeSavedWorkflowName(name) {
    if (!isSafeSavedWorkflowName(name))
        throw new Error(SAVED_WORKFLOW_NAME_RULE);
}
function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parametersProblem(parameters) {
    for (const [key, spec] of Object.entries(parameters)) {
        if (!isJsonObject(spec) || typeof spec.type !== "string")
            return `parameter "${key}" needs a string "type"`;
        if (spec.description !== undefined && typeof spec.description !== "string")
            return `parameter "${key}" has a non-string "description"`;
        if (spec.required !== undefined && typeof spec.required !== "boolean")
            return `parameter "${key}" has a non-boolean "required"`;
    }
    return undefined;
}
/**
 * Check parsed saved-workflow JSON against the `SavedWorkflow` shape. These
 * files are also written by hand, so every field the runtime reads is checked
 * here instead of trusting a cast. Hand-written files often leave out
 * `description` and `savedAt`; those default to "". Fields outside the shape
 * (including stale `location` and `path`) are dropped.
 */
function checkSavedWorkflowFile(data) {
    const problem = (text) => ({ ok: false, problem: text });
    if (!isJsonObject(data))
        return problem("the file does not hold a JSON object");
    const { name, description = "", savedAt = "", parameters, script, scriptPath } = data;
    if (!isSafeSavedWorkflowName(name))
        return problem(`"name" is not valid. ${SAVED_WORKFLOW_NAME_RULE}`);
    if (typeof description !== "string")
        return problem('"description" must be a string');
    if (typeof savedAt !== "string")
        return problem('"savedAt" must be a string');
    if (parameters != null) {
        if (!isJsonObject(parameters))
            return problem('"parameters" must be an object');
        const parameterProblem = parametersProblem(parameters);
        if (parameterProblem)
            return problem(parameterProblem);
    }
    let source;
    if (Object.hasOwn(data, "script")) {
        if (typeof script !== "string")
            return problem('"script" must be a string');
        source = { script };
    }
    else if (typeof scriptPath === "string") {
        source = { scriptPath };
    }
    else {
        return problem('it needs a string "script" or "scriptPath"');
    }
    return {
        ok: true,
        file: {
            name,
            description,
            savedAt,
            ...(parameters != null && { parameters: parameters }),
            source,
        },
    };
}
/**
 * Resolve a saved-workflow `scriptPath` against that workflow's own saved
 * directory. Returns the resolved file path, or null if the value is empty,
 * absolute, contains NUL, or would escape the directory.
 */
export function resolveSavedScriptPath(savedDir, scriptPath) {
    if (typeof scriptPath !== "string")
        return null;
    if (scriptPath.length === 0 || scriptPath.trim().length === 0 || scriptPath.includes("\0"))
        return null;
    if (isAbsolute(scriptPath))
        return null;
    const asPosix = scriptPath.replace(/\\/g, "/");
    if (asPosix.startsWith("/") || /^[a-zA-Z]:/.test(asPosix))
        return null;
    const resolved = resolve(savedDir, scriptPath);
    const rel = relative(resolve(savedDir), resolved);
    if (rel === "")
        return null;
    if (isAbsolute(rel))
        return null;
    if (rel === ".." || rel.startsWith(`..${sep}`))
        return null;
    return resolved;
}
export function createWorkflowStorage(cwd, fsOverride) {
    const fs = resolvePersistenceFs(fsOverride);
    const paths = workflowProjectPaths(cwd);
    const dirs = {
        project: paths.savedDir,
        user: workflowUserSavedDir(),
    };
    const LOCATIONS = ["project", "user"];
    const ensureDir = (dir) => ensureDirFs(fs, dir);
    const locationPath = (name, location) => {
        assertSafeSavedWorkflowName(name);
        return join(dirs[location], `${name}.json`);
    };
    const hasRecord = (path) => {
        try {
            return fs.existsSync(path) || fs.existsSync(`${path}.bak`);
        }
        catch {
            return true; // unreadable means do not overwrite something we cannot verify
        }
    };
    // list() runs on every navigator refresh; one warning per file and problem is enough.
    const reported = new Set();
    const skipInvalid = (path, problem) => {
        const key = `${path}\n${problem}`;
        if (!reported.has(key)) {
            reported.add(key);
            console.warn(`[workflow] Skipped saved workflow ${path}: ${problem}`);
        }
        return null;
    };
    /** Load one saved file. An invalid file is skipped with a warning, so it never hides or breaks other rows. */
    const loadFromFile = (path, location) => {
        const data = readJsonWithBackupRecovery(fs, path);
        if (data === null)
            return hasRecord(path) ? skipInvalid(path, "the file is unreadable or not valid JSON") : null;
        const checked = checkSavedWorkflowFile(data);
        if (!checked.ok)
            return skipInvalid(path, checked.problem);
        const { source, ...fields } = checked.file;
        if ("script" in source)
            return { ...fields, script: source.script, location, path };
        const scriptFile = resolveSavedScriptPath(dirname(path), source.scriptPath);
        if (!scriptFile)
            return skipInvalid(path, '"scriptPath" must be a relative file path inside the saved directory');
        try {
            return { ...fields, script: fs.readFileSync(scriptFile, "utf-8"), location, path };
        }
        catch (error) {
            return skipInvalid(path, `cannot read "scriptPath": ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const exactCurrent = (workflow) => {
        const location = workflow.location === "user" ? "user" : "project";
        let expected;
        try {
            expected = locationPath(workflow.name, location);
        }
        catch (error) {
            return { ok: false, code: "invalid", message: error instanceof Error ? error.message : String(error) };
        }
        if (workflow.path !== expected) {
            return {
                ok: false,
                code: "stale",
                message: "Saved workflow source changed; refresh the navigator before retrying.",
            };
        }
        const current = loadFromFile(expected, location);
        if (!current) {
            return hasRecord(expected)
                ? { ok: false, code: "stale", message: "Saved workflow source is unreadable or no longer valid." }
                : { ok: false, code: "missing", message: "Saved workflow no longer exists." };
        }
        if (current.location !== location ||
            current.name !== workflow.name ||
            savedWorkflowRevision(current) !== savedWorkflowRevision(workflow)) {
            return { ok: false, code: "stale", message: "Saved workflow changed; refresh the navigator before retrying." };
        }
        return { ok: true, workflow: current };
    };
    const snapshotFile = (path) => {
        const existed = fs.existsSync(path);
        return existed ? { path, existed, contents: fs.readFileSync(path, "utf-8") } : { path, existed };
    };
    const restoreFile = (snapshot) => {
        if (snapshot.existed)
            fs.writeFileSync(snapshot.path, snapshot.contents ?? "");
        else if (fs.existsSync(snapshot.path))
            fs.unlinkSync(snapshot.path);
    };
    const cleanupTarget = (path) => {
        // Failure injection is intentionally transient. Retry cleanup so a failed
        // transaction cannot leave a target that blocks the next attempt.
        for (const candidate of [`${path}.tmp`, path, `${path}.bak`]) {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    if (!fs.existsSync(candidate))
                        break;
                    fs.unlinkSync(candidate);
                    break;
                }
                catch {
                    if (attempt === 1)
                        break;
                }
            }
        }
    };
    const removeSource = (path) => {
        let primary;
        let backup;
        try {
            primary = snapshotFile(path);
            backup = snapshotFile(`${path}.bak`);
        }
        catch (error) {
            return { ok: false, code: "io-error", message: error instanceof Error ? error.message : String(error) };
        }
        if (!primary.existed && !backup.existed)
            return { ok: false, code: "missing", message: "Saved workflow no longer exists." };
        try {
            // Remove recovery first. If primary removal fails, restore the sidecar so
            // neither deletion nor a later recovery read can observe a half-state.
            if (backup.existed)
                fs.unlinkSync(backup.path);
            if (primary.existed)
                fs.unlinkSync(primary.path);
            return { ok: true };
        }
        catch (error) {
            try {
                restoreFile(primary);
                restoreFile(backup);
            }
            catch {
                // Preserve the original I/O error; the source is restored when the
                // injected failure is transient, and retry remains safe either way.
            }
            return { ok: false, code: "io-error", message: error instanceof Error ? error.message : String(error) };
        }
    };
    return {
        save(workflow, location = "project") {
            assertSafeSavedWorkflowName(workflow.name);
            ensureDir(dirs[location]);
            const path = locationPath(workflow.name, location);
            const saved = {
                ...workflow,
                location,
                path,
                savedAt: new Date().toISOString(),
            };
            // Overwrite-safe save: keep the PREVIOUS version as .bak —
            // an accidental same-name save must not destroy the old script.
            writeJsonAtomicPreservingPreviousBackup(fs, path, saved);
            return saved;
        },
        load(name) {
            if (!isSafeSavedWorkflowName(name))
                return null;
            return loadFromFile(locationPath(name, "project"), "project") ?? loadFromFile(locationPath(name, "user"), "user");
        },
        list() {
            const workflows = [];
            const seen = new Set();
            for (const location of LOCATIONS) {
                for (const file of listJsonFilesSafe(fs, dirs[location])) {
                    const workflow = loadFromFile(join(dirs[location], file), location);
                    if (workflow && !seen.has(workflow.name)) {
                        seen.add(workflow.name);
                        workflows.push(workflow);
                    }
                }
            }
            return workflows.sort((a, b) => a.name.localeCompare(b.name));
        },
        delete(workflow, location) {
            if (typeof workflow === "string") {
                if (!isSafeSavedWorkflowName(workflow))
                    return false;
                let deleted = false;
                for (const tier of location ? [location] : LOCATIONS) {
                    const current = loadFromFile(locationPath(workflow, tier), tier);
                    if (!current)
                        continue;
                    const result = removeSource(current.path);
                    if (!result.ok)
                        return false;
                    deleted = true;
                }
                return deleted;
            }
            const current = exactCurrent(workflow);
            if (!current.ok)
                return current;
            return removeSource(current.workflow.path);
        },
        rename(workflow, name) {
            if (!isSafeSavedWorkflowName(name))
                return { ok: false, code: "invalid", message: SAVED_WORKFLOW_NAME_RULE };
            const current = exactCurrent(workflow);
            if (!current.ok)
                return current;
            if (name === current.workflow.name)
                return { ok: true, workflow: current.workflow };
            // A command name is globally resolved by precedence, so a target that is
            // occupied in any tier is ambiguous even when the current row is hidden by
            // another tier. Reject before writing instead of mutating a fallback by name.
            for (const tier of LOCATIONS) {
                const target = locationPath(name, tier);
                if (hasRecord(target)) {
                    return { ok: false, code: "conflict", message: `A saved workflow named /${name} already exists.` };
                }
            }
            const { location } = current.workflow;
            const targetPath = locationPath(name, location);
            const renamed = {
                ...current.workflow,
                name,
                path: targetPath,
                savedAt: new Date().toISOString(),
            };
            let sourcePrimary;
            let sourceBackup;
            try {
                ensureDir(dirs[location]);
                sourcePrimary = snapshotFile(current.workflow.path);
                sourceBackup = snapshotFile(`${current.workflow.path}.bak`);
                // The replacement must have both primary and backup before the source
                // can be touched. A failed strict write is cleaned before returning.
                writeJsonAtomicWithBackupStrict(fs, targetPath, renamed);
            }
            catch (error) {
                cleanupTarget(targetPath);
                return { ok: false, code: "io-error", message: error instanceof Error ? error.message : String(error) };
            }
            const removed = removeSource(current.workflow.path);
            if (!removed.ok) {
                cleanupTarget(targetPath);
                try {
                    restoreFile(sourcePrimary);
                    restoreFile(sourceBackup);
                }
                catch {
                    // The original bytes are restored whenever the injected failure is
                    // transient; cleanup makes the next retry deterministic.
                }
                return removed;
            }
            return { ok: true, workflow: renamed };
        },
    };
}
