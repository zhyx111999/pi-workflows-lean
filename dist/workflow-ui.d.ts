/**
 * Interactive `/workflows` navigator:
 *
 *   runs ──enter──▶ phases ──enter──▶ agents ──enter──▶ agent detail ──enter──▶ full pager
 *        ◀──esc───        ◀──esc────         ◀──esc────              ◀──esc────
 *        ◀── (saved items in runs view) ──enter──▶ saved detail
 *
 * Keys: ↑/↓ (or j/k) select · enter/→ drill in · esc/← back (esc at top closes)
 *       On runs: / filter · p pause · x stop · r restart · s save · q quit
 *       On saved: r rename · x delete · q quit
 *
 * How the pieces fit:
 * - NavigatorModel reads runs and saved workflows, preferring live snapshots.
 * - NavigatorState is the view stack, selection, input mode, and pending
 *   confirmation; it never touches the terminal.
 * - renderNavigator draws one frame from the two (views live in ./navigator/).
 * - keyToAction maps a key to an action; ./navigator/key-input.ts applies it.
 * - openWorkflowNavigator wires them into a pi-tui overlay that redraws on
 *   manager events.
 */
import { type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { ThemeLike, WorkflowAgentSnapshot } from "./display.js";
import { type ConfirmKind } from "./navigator/confirmation.js";
import { type ItemIdentity, type ItemKind, type NavigatorSnapshot, type SavedItemIdentity, type VisibleNavigatorItem } from "./navigator/items.js";
import { type AgentRow, type PhaseRow, type RunRow } from "./navigator/rows.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, SavedWorkflowMutationResult, WorkflowStorage } from "./workflow-saved.js";
export type ViewKind = "runs" | "phases" | "agents" | "detail" | "savedDetail";
export type NavigatorInputMode = "browse" | "filter" | "rename" | "confirm";
type NavigatorStorage = Pick<WorkflowStorage, "list" | "delete" | "rename">;
/** Reads run/phase/agent data from the manager, preferring live snapshots. */
export declare class NavigatorModel {
    private readonly manager;
    private readonly frame;
    private readonly getStorage;
    private rehydrated?;
    constructor(manager: Pick<WorkflowManager, "listRuns" | "getRun">, storage?: NavigatorStorage | (() => NavigatorStorage | undefined));
    /** Share persisted data across all model lookups performed by one render. */
    withRenderFrame<T>(render: () => T): T;
    private persistedRuns;
    private snapshot;
    runs(): RunRow[];
    /** Return saved workflows sorted by name, or [] when no storage configured. */
    saved(): SavedWorkflow[];
    /** Build the sole filtered item list used by list rendering, footer, drill, and actions. */
    visible(filter: string): NavigatorSnapshot;
    /** Delete exactly the currently visible saved source. */
    deleteSaved(workflow: SavedWorkflow): SavedWorkflowMutationResult;
    /** Rename exactly the currently visible saved source. */
    renameSaved(workflow: SavedWorkflow, name: string): SavedWorkflowMutationResult;
    runName(runId: string): string;
    runStatus(runId: string): string;
    phases(runId: string): PhaseRow[];
    agents(runId: string, phase: string): AgentRow[];
    /** All agents grouped by phase in one pass, for views that render every phase. */
    agentsByPhase(runId: string): Map<string, AgentRow[]>;
    agentDetail(runId: string, agentId: number): WorkflowAgentSnapshot | undefined;
}
/** Navigation state machine: view stack, selection, text input, and pending confirmation. */
export declare class NavigatorState {
    private stack;
    private pending?;
    private renameTarget?;
    private filterSelection?;
    mode: NavigatorInputMode;
    filter: string;
    draft: string;
    scroll: number;
    tailing: boolean;
    pagerOpen: boolean;
    private pageSize;
    private top;
    get kind(): ViewKind;
    get cursor(): number;
    set cursor(val: number);
    get runId(): string | undefined;
    get phase(): string | undefined;
    get agentId(): number | undefined;
    get savedName(): string | undefined;
    get confirmationAction(): ConfirmKind | undefined;
    /** Reconcile selection after any list/filter/manager change without drifting. */
    reconcile(snapshot: NavigatorSnapshot): void;
    currentItem(snapshot: NavigatorSnapshot): VisibleNavigatorItem | undefined;
    itemKindAt(model: NavigatorModel, cursor: number): ItemKind;
    clamp(count: number): void;
    moveRuns(delta: number, snapshot: NavigatorSnapshot): void;
    /** Detail pages scroll their body; moving in the agent detail opens its pager, and scrolling up stops tailing. */
    private scrollBody;
    move(delta: number, count: number, snapshot?: NavigatorSnapshot): void;
    setPageSize(rows: number): void;
    movePage(direction: -1 | 1, count: number, snapshot?: NavigatorSnapshot): void;
    jump(edge: "start" | "end", count: number, snapshot?: NavigatorSnapshot): void;
    openPager(): boolean;
    togglePager(): boolean;
    toggleTail(): boolean;
    drill(model: NavigatorModel, provided?: NavigatorSnapshot): boolean;
    back(): boolean;
    activeRunId(model: NavigatorModel, snapshot?: NavigatorSnapshot): string | undefined;
    activeSaved(snapshot: NavigatorSnapshot, allSaved: SavedWorkflow[]): SavedWorkflow | undefined;
    beginFilter(): void;
    /** Query used to render the live draft while filter text is being edited. */
    effectiveFilter(): string;
    beginRename(workflow: SavedWorkflow): void;
    appendInput(data: string): void;
    backspaceInput(): void;
    applyFilter(model: NavigatorModel): NavigatorSnapshot;
    takeRename(): {
        target: SavedItemIdentity;
        name: string;
    } | undefined;
    replaceSavedIdentity(previous: SavedItemIdentity, workflow: SavedWorkflow): void;
    cancelInput(): void;
    private confirmationContext;
    beginConfirmation(action: ConfirmKind, target: ItemIdentity, snapshot: NavigatorSnapshot): boolean;
    confirm(action: ConfirmKind, snapshot: NavigatorSnapshot): ItemIdentity | undefined;
    cancelConfirmation(): void;
}
/** Build the lines for the current view. Depends only on state, model, and theme, so it renders without a terminal. */
export declare function renderNavigator(state: NavigatorState, model: NavigatorModel, width: number, theme?: ThemeLike, viewportRows?: number, markdownTheme?: MarkdownTheme): string[];
/** What a key press should do. */
export type NavAction = {
    type: "move";
    delta: number;
} | {
    type: "page";
    direction: -1 | 1;
} | {
    type: "jump";
    edge: "start" | "end";
} | {
    type: "toggleTail";
} | {
    type: "togglePager";
} | {
    type: "openPager";
} | {
    type: "drill";
} | {
    type: "back";
} | {
    type: "close";
} | {
    type: "pause";
} | {
    type: "stop";
} | {
    type: "restart";
} | {
    type: "save";
} | {
    type: "deleteSaved";
} | {
    type: "filter";
} | {
    type: "rename";
} | {
    type: "none";
};
/** Pure mapping from a parsed key id to an action; a key's meaning depends on the view and the selected item's kind. */
export declare function keyToAction(keyId: string | undefined, kind: ViewKind, itemKind?: "run" | "saved"): NavAction;
export interface NavigatorOptions {
    storage?: WorkflowStorage;
    /** Live storage accessor when the extension may replace storage after session_start. */
    getStorage?: () => WorkflowStorage | undefined;
    cwd?: string;
    /** Live cwd accessor. */
    getCwd?: () => string;
    /**
     * Live manager accessor used when registering a saved `/name` command from the
     * navigator. Prefer this over the closed-over `manager` argument so saves run
     * through the current session's manager (background path), not a stale snapshot.
     */
    getManager?: () => WorkflowManager;
}
/**
 * Open the interactive `/workflows` navigator as a focused overlay. Resolves when
 * the user closes it (esc at the top level, or `q`).
 */
export declare function openWorkflowNavigator(pi: ExtensionAPI, manager: WorkflowManager, ui: ExtensionUIContext, opts?: NavigatorOptions): Promise<void>;
export {};
