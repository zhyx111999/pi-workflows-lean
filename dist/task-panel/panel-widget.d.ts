/** The live panel component: redraws on run events, and on a timer in detailed mode while a run is active. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { WorkflowManager } from "../workflow-manager.js";
import type { WorkflowSettings } from "../workflow-settings.js";
/** Widget factory for the panel. It takes no input; the user opens the navigator with /workflows. */
export declare function panelWidget(manager: WorkflowManager, loadSettings?: () => WorkflowSettings): (tui: TUI, theme: Theme) => Component & {
    dispose?(): void;
};
