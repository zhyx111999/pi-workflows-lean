/** The top-level list: runs, then saved workflows, under a title showing the filter and scroll range. */
import type { ThemeLike } from "../display.js";
import type { NavigatorState } from "../workflow-ui.js";
import { type NavigatorSnapshot } from "./items.js";
/**
 * Every row, range, and separator comes from the one `snapshot` taken for
 * this frame, so the list stays coherent while the manager changes underneath.
 */
export declare function renderRunsList(state: NavigatorState, snapshot: NavigatorSnapshot, theme: ThemeLike, viewportRows: number): string[];
