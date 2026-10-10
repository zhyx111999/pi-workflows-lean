/** Lays out single phase and agent rows, and the column widths they share, inside the run view's panes. */
import type { ThemeLike } from "../display.js";
import type { AgentRow, PhaseRow } from "./rows.js";
/** Narrowest usable Phases pane, in cells. */
export declare const LW_MIN = 14;
/** Narrowest usable agents pane, in cells. */
export declare const RW_MIN = 24;
/** The Phases box's outer width: fit the longest row, capped so the agents pane keeps most of the width. */
export declare function computeLeftWidth(phases: PhaseRow[], width: number): number;
/** Build a left-pane phase row (content field, exact width = innerW). */
export declare function leftPhaseRow(p: PhaseRow, i: number, selected: boolean, agents: AgentRow[], innerW: number, theme: ThemeLike): string;
/** Build a right-pane agent row (content field, exact width = innerW). */
export declare function rightAgentRow(a: AgentRow, selected: boolean, modelColStart: number, innerW: number, theme: ThemeLike): string;
/** Model column start aligned across agent rows, clamped to the field. */
export declare function computeModelColStart(agents: AgentRow[], innerW: number): number;
