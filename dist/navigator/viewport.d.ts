/** Fits lists and long text bodies into a fixed number of terminal rows. */
import type { NavigatorState } from "../workflow-ui.js";
export interface ScrollWin {
    start: number;
    count: number;
    more: boolean;
}
/** Compute a scroll window of up to `cap` rows keeping `active` visible. */
export declare function scrollWindow(total: number, active: number, cap: number): ScrollWin;
/**
 * The slice of a detail body at the state's scroll offset, plus a position
 * indicator when it overflows. The viewport height is fixed so scrolling
 * toward the end never shrinks the overlay.
 */
export declare function scrollableBody(state: NavigatorState, body: string[], viewportRows: number, dim: (text: string) => string): string[];
/** The first screenful of a body. Summaries do not scroll; the full pager does. */
export declare function compactBody(body: string[], viewportRows: number, dim: (text: string) => string): string[];
