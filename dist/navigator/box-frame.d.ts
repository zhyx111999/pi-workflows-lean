/** Draws the run view's box borders: titled top rules and the two-pane frame with one shared divider. */
import type { ThemeLike } from "../display.js";
export declare const BX: {
    readonly h: "─";
    readonly v: "│";
    readonly tl: "┌";
    readonly tr: "┐";
    readonly bl: "└";
    readonly br: "┘";
    readonly tj: "┬";
    readonly bj: "┴";
};
/** Compose a titled top rule for one box side (between two join chars). */
export declare function topTitleSegment(title: string, innerW: number, leading: boolean, theme: ThemeLike): string;
export interface TwoPaneArgs {
    width: number;
    bodyRows: number;
    left: string[];
    right: string[];
    leftTitle: string;
    rightTitle: string;
    leftW: number;
    theme: ThemeLike;
}
/** Emit the full combined frame (top rule, body rows, bottom rule). */
export declare function renderTwoPaneFrame(a: TwoPaneArgs): string[];
