/** The run view: a two-line run header over the Phases | agents panes, collapsing to one pane on narrow terminals. */
import type { ThemeLike } from "../display.js";
import type { NavigatorModel, NavigatorState } from "../workflow-ui.js";
/** Lines for the "phases" and "agents" views; the cursor sits in the left or right pane respectively. */
export declare function renderRunView(state: NavigatorState, model: NavigatorModel, runId: string, width: number, theme: ThemeLike, viewportRows: number): string[];
