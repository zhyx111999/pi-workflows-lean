/** The navigator overlay's size and its rounded, background-filled border. */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
const BORDER_LEFT = "│ ";
const BORDER_RIGHT = " │";
/** A roomy overlay with a margin, so its border stands out from the terminal edge. */
export function overlayOptions() {
    // Keep maxHeight equal to the share used by overlayContentRows.
    return { width: "94%", maxHeight: "92%", anchor: "center", margin: 1 };
}
/** Columns left for navigator content inside the side borders. */
export function overlayInnerWidth(width) {
    return Math.max(10, width - BORDER_LEFT.length - BORDER_RIGHT.length);
}
/**
 * Rows left for navigator content. This must follow the overlay's maxHeight:
 * otherwise the host cuts the footer and bottom border before the pager can
 * scroll them into view.
 */
export function overlayContentRows(terminalRows) {
    const overlayRows = Math.max(8, Math.floor(terminalRows * 0.92));
    return Math.max(6, overlayRows - 2); // top + bottom box borders
}
/** Wrap content lines in the border; a brighter border marks the focused overlay. */
export function boxOverlayLines(lines, width, theme, focused) {
    const innerWidth = overlayInnerWidth(width);
    const borderColor = (s) => (focused ? theme.fg("accent", s) : theme.fg("borderMuted", s));
    const titleColor = (s) => (focused ? theme.fg("dim", theme.bold(s)) : theme.fg("muted", s));
    const bgColor = (s) => theme.bg("customMessageBg", s);
    const title = titleColor(" workflows ");
    const topBorder = borderColor("╭─") + title + borderColor("─".repeat(Math.max(0, innerWidth - 10))) + borderColor("╮");
    const bottomBorder = borderColor(`╰${"─".repeat(Math.max(0, innerWidth + 2))}╯`);
    const boxLine = (line) => {
        const padded = truncateToWidth(line, innerWidth, "", true);
        const fullLine = borderColor(BORDER_LEFT) + padded + borderColor(BORDER_RIGHT);
        // Pad to the full width so the background colour spans every row evenly.
        const trailingPad = width - visibleWidth(fullLine);
        return bgColor(fullLine + (trailingPad > 0 ? " ".repeat(trailingPad) : ""));
    };
    return [bgColor(topBorder), ...lines.map(boxLine), bgColor(bottomBorder)];
}
