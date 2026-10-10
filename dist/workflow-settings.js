/**
 * User-level settings for pi-dynamic-workflows.
 *
 * Stored separately from Pi's own settings.json so extension preferences remain
 * stable without depending on host-internal config shape.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MAX_AGENT_RETRIES, MAX_CONCURRENCY, WORKFLOW_SETTINGS_FILE } from "./config.js";
import { workflowHomeDir, workflowProjectPaths } from "./workflow-paths.js";
/** Path to the user-level workflow settings JSON file (~/.pi/workflows/settings.json). */
export function getWorkflowSettingsPath() {
    return join(workflowHomeDir(), "settings.json");
}
/** Path to this project's optional workflow settings override. */
export function getWorkflowProjectSettingsPath(cwd) {
    return workflowProjectPaths(cwd).settingsPath;
}
/**
 * Path to the project-local (in-repo) workflow settings file
 * (`<cwd>/.pi/workflows/settings.json`). Lets a repository or its tooling ship
 * workflow defaults with the project, the same way project-local
 * `.pi/workflows/saved/` ships saved workflows.
 */
export function getProjectLocalWorkflowSettingsPath(cwd) {
    return resolve(cwd, WORKFLOW_SETTINGS_FILE);
}
/**
 * Load settings from disk. Missing, corrupt, or invalid files resolve to {}.
 * Precedence when a cwd is provided (later wins): global user settings, then
 * the project-local in-repo file (`<cwd>/.pi/workflows/settings.json`), then
 * the per-project override under `~/.pi/workflows/projects/<key>/` — so a
 * repo can ship defaults while a user's own project override still wins.
 */
export function loadWorkflowSettings(settingsPathOrOptions) {
    const options = normalizeOptions(settingsPathOrOptions);
    const globalSettings = readSettings(options.settingsPath ?? getWorkflowSettingsPath());
    const projectLocalPath = options.projectLocalSettingsPath ?? (options.cwd ? getProjectLocalWorkflowSettingsPath(options.cwd) : undefined);
    const projectPath = options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
    return {
        ...globalSettings,
        ...(projectLocalPath ? readSettings(projectLocalPath) : {}),
        ...(projectPath ? readSettings(projectPath) : {}),
    };
}
/** Merge known settings into the user-level settings file. */
export function saveWorkflowSettings(settings, settingsPathOrOptions) {
    const options = normalizeOptions(settingsPathOrOptions);
    const projectPath = options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
    const path = options.scope === "project" && projectPath ? projectPath : (options.settingsPath ?? getWorkflowSettingsPath());
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const existing = readObject(path);
    writeFileSync(path, `${JSON.stringify({ ...existing, ...normalizeSettings(settings) }, null, 2)}\n`, "utf-8");
}
/** Save a global preference and update an existing project override if one is present. */
export function saveWorkflowSettingsForCwd(settings, cwd) {
    saveWorkflowSettings(settings);
    const projectPath = getWorkflowProjectSettingsPath(cwd);
    if (existsSync(projectPath)) {
        saveWorkflowSettings(settings, { projectSettingsPath: projectPath, scope: "project" });
    }
}
function normalizeOptions(settingsPathOrOptions) {
    return typeof settingsPathOrOptions === "string"
        ? { settingsPath: settingsPathOrOptions }
        : (settingsPathOrOptions ?? {});
}
function readSettings(path) {
    if (!existsSync(path))
        return {};
    try {
        return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")));
    }
    catch {
        return {};
    }
}
/**
 * Copy only known, valid keys. Files written by older versions may still hold
 * keys for removed features; they are ignored here and left untouched on disk
 * by saveWorkflowSettings.
 */
function normalizeSettings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const raw = value;
    const settings = {};
    if (raw.defaultAgentTimeoutMs === null) {
        settings.defaultAgentTimeoutMs = null;
    }
    else if (typeof raw.defaultAgentTimeoutMs === "number" &&
        Number.isFinite(raw.defaultAgentTimeoutMs) &&
        raw.defaultAgentTimeoutMs > 0) {
        settings.defaultAgentTimeoutMs = raw.defaultAgentTimeoutMs;
    }
    if (raw.defaultTokenBudget === null) {
        settings.defaultTokenBudget = null;
    }
    else {
        const defaultTokenBudget = normalizeInteger(raw.defaultTokenBudget, 1, Number.MAX_SAFE_INTEGER);
        if (defaultTokenBudget !== undefined)
            settings.defaultTokenBudget = defaultTokenBudget;
    }
    const defaultConcurrency = normalizeInteger(raw.defaultConcurrency, 1, MAX_CONCURRENCY);
    if (defaultConcurrency !== undefined)
        settings.defaultConcurrency = defaultConcurrency;
    const defaultAgentRetries = normalizeInteger(raw.defaultAgentRetries, 0, MAX_AGENT_RETRIES);
    if (defaultAgentRetries !== undefined)
        settings.defaultAgentRetries = defaultAgentRetries;
    if (raw.progressPanelMode === "compact" || raw.progressPanelMode === "detailed") {
        settings.progressPanelMode = raw.progressPanelMode;
    }
    if (typeof raw.progressPanelMaxAgents === "number" &&
        Number.isFinite(raw.progressPanelMaxAgents) &&
        raw.progressPanelMaxAgents >= 1) {
        settings.progressPanelMaxAgents = Math.min(1000, Math.floor(raw.progressPanelMaxAgents));
    }
    if (typeof raw.persistAgentSessions === "boolean") {
        settings.persistAgentSessions = raw.persistAgentSessions;
    }
    if (typeof raw.inheritMainModel === "boolean") {
        settings.inheritMainModel = raw.inheritMainModel;
    }
    const deliveredResultMaxChars = normalizeInteger(raw.deliveredResultMaxChars, 1, 1_000_000);
    if (deliveredResultMaxChars !== undefined)
        settings.deliveredResultMaxChars = deliveredResultMaxChars;
    if (Array.isArray(raw.excludeSubagentTools)) {
        const names = raw.excludeSubagentTools.filter((t) => typeof t === "string" && t.trim().length > 0);
        if (names.length)
            settings.excludeSubagentTools = names;
    }
    if (Array.isArray(raw.providerMiddlewareExtensions)) {
        settings.providerMiddlewareExtensions = raw.providerMiddlewareExtensions
            .filter((name) => typeof name === "string" && name.trim().length > 0)
            .map((name) => name.trim());
    }
    return settings;
}
function normalizeInteger(value, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min)
        return undefined;
    return Math.min(max, Math.floor(value));
}
function readObject(path) {
    if (!existsSync(path))
        return {};
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
