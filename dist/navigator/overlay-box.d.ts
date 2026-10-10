/** The navigator overlay's size and its rounded, background-filled border. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions } from "@earendil-works/pi-tui";
/** A roomy overlay with a margin, so its border stands out from the terminal edge. */
export declare function overlayOptions(): OverlayOptions;
/** Columns left for navigator content inside the side borders. */
export declare function overlayInnerWidth(width: number): number;
/**
 * Rows left for navigator content. This must follow the overlay's maxHeight:
 * otherwise the host cuts the footer and bottom border before the pager can
 * scroll them into view.
 */
export declare function overlayContentRows(terminalRows: number): number;
/** Wrap content lines in the border; a brighter border marks the focused overlay. */
export declare function boxOverlayLines(lines: string[], width: number, theme: Theme, focused: boolean): string[];
