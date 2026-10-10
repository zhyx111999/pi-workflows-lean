/**
 * User-level settings for pi-dynamic-workflows.
 *
 * Stored separately from Pi's own settings.json so extension preferences remain
 * stable without depending on host-internal config shape.
 */
export interface WorkflowSettings {
    defaultAgentTimeoutMs?: number | null;
    /**
     * Default hard token budget applied to runs that don't pass their own
     * `tokenBudget` (#68). null explicitly means "no budget" (useful in a
     * project override to cancel a global budget); omitted also means no budget.
     */
    defaultTokenBudget?: number | null;
    /** Default max concurrent agents per run. Clamped to the runtime maximum. */
    defaultConcurrency?: number;
    /** Default retry attempts after recoverable agent failures. */
    defaultAgentRetries?: number;
    /** Bottom task-panel display mode: "compact" (default, one line per run) | "detailed". */
    progressPanelMode?: "compact" | "detailed";
    /** Max agents shown per phase in detailed progress mode (default 8). */
    progressPanelMaxAgents?: number;
    /**
     * Persist each workflow subagent transcript as a real pi session file under
     * the standard sessions directory (~/.pi/agent/sessions/<encoded-cwd>/),
     * keyed by the project cwd. Default false: subagent sessions stay in-memory
     * and only the compacted history embedded in the run JSON survives.
     */
    persistAgentSessions?: boolean;
    /**
     * Route UNTAGGED agent() calls (no `model`, no `tier`) to the orchestrating
     * session's main model instead of the implicit medium tier (when
     * configured) or the settings default. Default false (legacy routing).
     * Explicit `model`/`tier` tags are unaffected. Applies when the session has
     * a main model; with none set, legacy routing applies. The inherited model
     * is the main model in effect when the RUN starts; a mid-run /model switch
     * applies to subsequent runs. An unavailable inherited model degrades to
     * the settings default with a run-visible warning instead of throwing.
     */
    inheritMainModel?: boolean;
    /**
     * Character cap on a delivered background-run result's JSON-dump fallback
     * before truncation (default 400). String results and `verdict`/`report`/
     * `summary`/`synthesis` fields are never truncated.
     */
    deliveredResultMaxChars?: number;
    /**
     * Extra tool names to deny in workflow subagent sessions, on top of the
     * always-on `workflow`/`workflow_control` defaults (#107). Use it to block
     * other recursive-orchestration tools you have installed (e.g. a pi-subagents
     * tool) so a subagent can't fan out through them.
     */
    excludeSubagentTools?: string[];
    /**
     * Trusted provider/auth middleware extension names allowed in child sessions.
     * Omitted or [] loads no host extensions. Recursive workflow/subagent
     * extensions are always excluded.
     */
    providerMiddlewareExtensions?: string[];
}
export interface WorkflowSettingsStore {
    load(): WorkflowSettings;
    save(settings: WorkflowSettings): void;
}
export interface WorkflowSettingsOptions {
    /** Explicit settings path, primarily for tests and migrations. */
    settingsPath?: string;
    /** Project cwd whose project-level settings should override global settings. */
    cwd?: string;
    /** Explicit project settings path, primarily for tests. */
    projectSettingsPath?: string;
    /** Explicit project-local (in-repo) settings path, primarily for tests. */
    projectLocalSettingsPath?: string;
    /** Save destination when using saveWorkflowSettings with cwd. Default: global. */
    scope?: "global" | "project";
}
/** Path to the user-level workflow settings JSON file (~/.pi/workflows/settings.json). */
export declare function getWorkflowSettingsPath(): string;
/** Path to this project's optional workflow settings override. */
export declare function getWorkflowProjectSettingsPath(cwd: string): string;
/**
 * Path to the project-local (in-repo) workflow settings file
 * (`<cwd>/.pi/workflows/settings.json`). Lets a repository or its tooling ship
 * workflow defaults with the project, the same way project-local
 * `.pi/workflows/saved/` ships saved workflows.
 */
export declare function getProjectLocalWorkflowSettingsPath(cwd: string): string;
/**
 * Load settings from disk. Missing, corrupt, or invalid files resolve to {}.
 * Precedence when a cwd is provided (later wins): global user settings, then
 * the project-local in-repo file (`<cwd>/.pi/workflows/settings.json`), then
 * the per-project override under `~/.pi/workflows/projects/<key>/` — so a
 * repo can ship defaults while a user's own project override still wins.
 */
export declare function loadWorkflowSettings(settingsPathOrOptions?: string | WorkflowSettingsOptions): WorkflowSettings;
/** Merge known settings into the user-level settings file. */
export declare function saveWorkflowSettings(settings: WorkflowSettings, settingsPathOrOptions?: string | WorkflowSettingsOptions): void;
/** Save a global preference and update an existing project override if one is present. */
export declare function saveWorkflowSettingsForCwd(settings: WorkflowSettings, cwd: string): void;
