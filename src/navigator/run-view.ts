/** The run view: a two-line run header over the Phases | agents panes, collapsing to one pane on narrow terminals. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../display.js";
import { fmtCompact, fmtTokenSegment } from "../display.js";
import type { NavigatorModel, NavigatorState } from "../workflow-ui.js";
import { BX, renderTwoPaneFrame, topTitleSegment } from "./box-frame.js";
import { ELLIPSIS, pluralize } from "./format.js";
import { computeLeftWidth, computeModelColStart, LW_MIN, leftPhaseRow, RW_MIN, rightAgentRow } from "./pane-rows.js";
import type { AgentRow, PhaseRow } from "./rows.js";
import { scrollWindow } from "./viewport.js";

/** Lines for the "phases" and "agents" views; the cursor sits in the left or right pane respectively. */
export function renderRunView(
  state: NavigatorState,
  model: NavigatorModel,
  runId: string,
  width: number,
  theme: ThemeLike,
  viewportRows: number,
): string[] {
  const phases = model.phases(runId);
  state.clamp(state.kind === "agents" && state.phase ? model.agents(runId, state.phase).length : phases.length);
  // Body cap: total height minus 2 header + 2 frame rules + blank + footer.
  const bodyCap = Math.max(1, viewportRows - 2 /*header*/ - 2 /*rules*/ - 2 /*blank+footer*/);
  return [
    ...runHeader(model, runId, phases, width, theme),
    ...renderPhasesAgents(state, model, runId, phases, width, theme, bodyCap),
  ];
}

/**
 * Two-line header above the Phases | agents frame:
 *   line 0: <name>                          (ACCENT_BOLD)
 *   line 1: <status>            <done>/<total> agent[s] · <tokens>   (DIM)
 * Right segment is built first and never truncated; the left segment is
 * truncated to the remaining width with an ellipsis.
 */
function runHeader(
  model: NavigatorModel,
  runId: string,
  phases: PhaseRow[],
  width: number,
  theme: ThemeLike,
): string[] {
  const name = model.runName(runId);
  const status = model.runStatus(runId);
  let done = 0;
  let total = 0;
  let fresh = 0;
  let cacheRead = 0;
  let estimated = false;
  for (const p of phases) {
    done += p.done;
    total += p.total;
    fresh += p.fresh;
    cacheRead += p.cacheRead;
    if (p.estimated) estimated = true;
  }
  // Line 0 — name (accent + bold), truncated to width if needed.
  const nameText = truncateToWidth(name, width, ELLIPSIS, false);
  const line0 = theme.fg("accent", theme.bold(nameText));

  // Line 1 — left status, right summary.
  const headerSegment = fmtTokenSegment({ fresh, cacheRead, estimated }, fmtCompact);
  const rightRaw = `${done}/${total} ${pluralize("agent", total)}${headerSegment ? ` · ${headerSegment}` : ""}`;
  const rightW = visibleWidth(rightRaw);
  const gap = 2;
  let line1: string;
  if (rightW >= width) {
    // No room for left content: right-align (truncate from the right as last resort).
    line1 = theme.fg("dim", truncateToWidth(rightRaw, width, ELLIPSIS, false));
  } else {
    const availL = width - rightW - gap;
    const leftText = availL > 0 ? truncateToWidth(status, availL, ELLIPSIS, false) : "";
    const leftW = visibleWidth(leftText);
    const fill = " ".repeat(Math.max(gap, width - leftW - rightW));
    line1 = theme.fg("dim", leftText) + fill + theme.fg("dim", rightRaw);
  }
  return [line0, line1];
}

function agentsTitle(phase: PhaseRow | undefined, agentCount: number): string {
  return `${phase ? phase.title : "(none)"} · ${agentCount} ${pluralize("agent", agentCount)}`;
}

/** The combined Phases | agents frame. The selected phase drives the right pane. */
function renderPhasesAgents(
  state: NavigatorState,
  model: NavigatorModel,
  runId: string,
  phases: PhaseRow[],
  width: number,
  theme: ThemeLike,
  bodyCap: number,
): string[] {
  // Group agents once per frame: every visible phase row needs its agents for
  // the status colour, and the selected phase's agents fill the right pane.
  const agentsByPhase = model.agentsByPhase(runId);
  const agentsOf = (title: string): AgentRow[] => agentsByPhase.get(title) ?? [];
  // In "phases" view the cursor selects the phase; in "agents" view it is the drilled-in phase.
  const inAgents = state.kind === "agents";
  let selPhaseIdx = inAgents ? phases.findIndex((p) => p.title === state.phase) : state.cursor;
  if (selPhaseIdx < 0) selPhaseIdx = 0;
  const selPhase = phases[selPhaseIdx];
  const agents = selPhase ? agentsOf(selPhase.title) : [];

  if (width < LW_MIN + RW_MIN - 1) {
    return renderSinglePane(state, phases, selPhaseIdx, agents, width, theme, bodyCap, inAgents);
  }

  const leftW = computeLeftWidth(phases, width);
  const rightW = width - leftW + 1; // shared divider overlaps 1 cell
  const leftInner = leftW - 2;
  const rightInner = rightW - 2;

  // Scroll each pane so its active item stays visible.
  const leftRows = scrollWindow(phases.length, inAgents ? selPhaseIdx : state.cursor, bodyCap);
  const rightRows = scrollWindow(agents.length, inAgents ? state.cursor : 0, bodyCap);
  const bodyRows = Math.max(1, Math.min(bodyCap, Math.max(leftRows.count, rightRows.count)));

  // Left column (Phases).
  const left: string[] = [];
  for (let k = 0; k < bodyRows; k++) {
    const idx = leftRows.start + k;
    if (idx >= phases.length) {
      left.push(" ".repeat(leftInner));
      continue;
    }
    const p = phases[idx];
    const selected = !inAgents && idx === state.cursor;
    let row = leftPhaseRow(p, idx, selected, agentsOf(p.title), leftInner, theme);
    if (k === bodyRows - 1 && leftRows.more) {
      row = truncateToWidth(theme.fg("dim", `  ${ELLIPSIS}`), leftInner, "", true);
    }
    left.push(row);
  }

  // Right column (agents of selected phase).
  const modelColStart = computeModelColStart(agents, rightInner);
  const right: string[] = [];
  if (agents.length === 0) {
    const msg = truncateToWidth(theme.fg("dim", "no agents"), rightInner, "", true);
    for (let k = 0; k < bodyRows; k++) right.push(k === 0 ? msg : " ".repeat(rightInner));
  } else {
    for (let k = 0; k < bodyRows; k++) {
      const idx = rightRows.start + k;
      if (idx >= agents.length) {
        right.push(" ".repeat(rightInner));
        continue;
      }
      const selected = inAgents && idx === state.cursor;
      let row = rightAgentRow(agents[idx], selected, modelColStart, rightInner, theme);
      if (k === bodyRows - 1 && rightRows.more) {
        row = truncateToWidth(theme.fg("dim", `  ${ELLIPSIS}`), rightInner, "", true);
      }
      right.push(row);
    }
  }

  return renderTwoPaneFrame({
    width,
    bodyRows,
    left,
    right,
    leftTitle: "Phases",
    rightTitle: agentsTitle(selPhase, agents.length),
    leftW,
    theme,
  });
}

/** Narrow terminals show only the active pane, full width. */
function renderSinglePane(
  state: NavigatorState,
  phases: PhaseRow[],
  selPhaseIdx: number,
  agents: AgentRow[],
  width: number,
  theme: ThemeLike,
  bodyCap: number,
  inAgents: boolean,
): string[] {
  const innerW = Math.max(1, width - 2);
  const bc = (s: string) => theme.fg("muted", s);
  const out: string[] = [];
  if (inAgents) {
    const title = agentsTitle(phases[selPhaseIdx], agents.length);
    out.push(bc(BX.tl) + topTitleSegment(title, innerW, false, theme) + bc(BX.tr));
    const win = scrollWindow(agents.length, state.cursor, bodyCap);
    const modelColStart = computeModelColStart(agents, innerW);
    const rows = Math.max(1, win.count);
    for (let k = 0; k < rows; k++) {
      const idx = win.start + k;
      if (idx >= agents.length) {
        out.push(bc(BX.v) + " ".repeat(innerW) + bc(BX.v));
        continue;
      }
      let row = rightAgentRow(agents[idx], idx === state.cursor, modelColStart, innerW, theme);
      if (k === rows - 1 && win.more) row = truncateToWidth(theme.fg("dim", `  ${ELLIPSIS}`), innerW, "", true);
      out.push(bc(BX.v) + row + bc(BX.v));
    }
  } else {
    out.push(bc(BX.tl) + topTitleSegment("Phases", innerW, false, theme) + bc(BX.tr));
    const win = scrollWindow(phases.length, state.cursor, bodyCap);
    const rows = Math.max(1, win.count);
    for (let k = 0; k < rows; k++) {
      const idx = win.start + k;
      if (idx >= phases.length) {
        out.push(bc(BX.v) + " ".repeat(innerW) + bc(BX.v));
        continue;
      }
      const p = phases[idx];
      let row = leftPhaseRow(p, idx, idx === state.cursor, [], innerW, theme);
      if (k === rows - 1 && win.more) row = truncateToWidth(theme.fg("dim", `  ${ELLIPSIS}`), innerW, "", true);
      out.push(bc(BX.v) + row + bc(BX.v));
    }
  }
  out.push(bc(BX.bl) + bc(BX.h.repeat(innerW)) + bc(BX.br));
  return out;
}
