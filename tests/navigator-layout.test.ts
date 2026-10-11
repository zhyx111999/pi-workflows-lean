import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type OverlayOptions,
  type Terminal,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "../src/display.js";
import { listPaneRows } from "../src/navigator/viewport.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import type { ManagedRun, WorkflowManager } from "../src/workflow-manager.js";
import { NavigatorModel, NavigatorState, openWorkflowNavigator, renderNavigator } from "../src/workflow-ui.js";

/** One run with one phase per entry of `agentsPerPhase`, plus `extraRuns` empty runs to fill the runs list. */
function fakeManager(agentsPerPhase: number[], extraRuns = 0): WorkflowManager {
  const phases = agentsPerPhase.map((_, p) => `Phase ${p}`);
  const agents: WorkflowAgentSnapshot[] = agentsPerPhase.flatMap((count, p) =>
    Array.from({ length: count }, (_, a) => ({
      id: p * 100 + a,
      label: `agent ${p}.${a}`,
      phase: phases[p],
      prompt: "do it",
      status: "done",
      tokens: 10,
    })),
  );
  const snapshot = {
    name: "wf",
    phases,
    currentPhase: phases[0],
    logs: [],
    agents,
    agentCount: agents.length,
    runningCount: 0,
    doneCount: agents.length,
    errorCount: 0,
  } as WorkflowSnapshot;
  const runs = [
    { runId: "r0", workflowName: "wf", status: "running", phases, agents, logs: [] },
    ...Array.from({ length: extraRuns }, (_, i) => ({
      runId: `r${i + 1}`,
      workflowName: `wf-${i + 1}`,
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
    })),
  ] as unknown as PersistedRunState[];
  return {
    on: () => {},
    off: () => {},
    listRuns: () => runs,
    getRun: (id: string) => (id === "r0" ? ({ runId: "r0", status: "running", snapshot } as ManagedRun) : undefined),
  } as unknown as WorkflowManager;
}

/** pi-tui's own overlay compositor, so the test checks the allocation the host really makes. */
class HostProbe extends TuiMainScreen {
  override requestRender(): void {}
  composite(columns: number, rows: number): string[] {
    return this.compositeOverlays([], columns, rows);
  }
}

const noopTerminal = new Proxy(
  {},
  { get: (_target, key) => (key === "columns" || key === "rows" ? 24 : () => {}) },
) as unknown as Terminal;

/** Render the run view drilled to `kind`, with the cursor moved to row `cursor` of that pane. */
function renderRun(
  kind: "phases" | "agents",
  agentsPerPhase: number[],
  cursor: number,
  width: number,
  viewportRows: number,
): string[] {
  const model = new NavigatorModel(fakeManager(agentsPerPhase));
  const state = new NavigatorState();
  state.drill(model);
  if (kind === "agents") state.drill(model);
  state.move(cursor, kind === "agents" ? agentsPerPhase[0] : agentsPerPhase.length);
  return renderNavigator(state, model, width, undefined, viewportRows);
}

const MARKER_ROW = /^│ {2}[↑↓] … *│/;

test("listPaneRows keeps the active item visible and marks hidden items above and below on rows of their own", () => {
  for (let total = 0; total <= 8; total++) {
    for (let cap = 1; cap <= 6; cap++) {
      for (let active = 0; active < Math.max(1, total); active++) {
        const rows = listPaneRows(
          total,
          active,
          cap,
          (i) => `item ${i}`,
          (overflow) => overflow,
        );
        const where = `total=${total} cap=${cap} active=${active}`;
        assert.ok(rows.length <= cap, `${where}: ${rows.length} rows exceed the cap`);
        if (total === 0) {
          assert.deepEqual(rows, [], where);
          continue;
        }
        const items = rows.filter((row) => row.startsWith("item ")).map((row) => Number(row.slice("item ".length)));
        assert.ok(items.includes(active), `${where}: active item hidden in ${JSON.stringify(rows)}`);
        items.forEach((index, k) => {
          if (k > 0) assert.equal(index, items[k - 1] + 1, `${where}: window is not contiguous`);
        });
        const [first, last] = [items[0], items[items.length - 1]];
        const below = rows.at(-1) === "below";
        const above = rows[0] === "above";
        assert.ok(!rows.slice(1, -1).some((row) => !row.startsWith("item ")), `${where}: a marker inside the window`);
        assert.equal(below, cap > 1 && last < total - 1, `${where}: below marker ${below} with last item ${last}`);
        if (above) assert.ok(first > 0, `${where}: an above marker with nothing above`);
        if (cap >= 3) assert.equal(above, first > 0, `${where}: above marker ${above} with first item ${first}`);
      }
    }
  }
});

// viewportRows 7 leaves the run view one body row and 8 leaves two; width 80 shows two panes, 30 one.
test("run view keeps the selected agent visible when the pane fits one or two rows", () => {
  for (const width of [80, 30]) {
    for (const viewportRows of [7, 8]) {
      for (let cursor = 0; cursor < 3; cursor++) {
        const text = renderRun("agents", [3], cursor, width, viewportRows).join("\n");
        assert.match(text, new RegExp(`› ● agent 0\\.${cursor}`), `width=${width} rows=${viewportRows}\n${text}`);
      }
    }
  }
});

test("run view keeps the selected phase visible and marks more phases on a row of their own", () => {
  for (const width of [80, 30]) {
    for (const viewportRows of [7, 8]) {
      for (let cursor = 0; cursor < 5; cursor++) {
        const text = renderRun("phases", [1, 1, 1, 1, 1], cursor, width, viewportRows).join("\n");
        assert.match(
          text,
          new RegExp(`› ${cursor + 1} Phase ${cursor}`),
          `width=${width} rows=${viewportRows}\n${text}`,
        );
      }
    }
    const lines = renderRun("phases", [1, 1, 1, 1, 1], 1, width, 8);
    assert.ok(
      lines.some((line) => MARKER_ROW.test(line)),
      `width=${width}: no marker row\n${lines.join("\n")}`,
    );
  }
});

test("navigator overlay stays inside the host's allocation at every terminal size", async () => {
  const terminal = { rows: 24 };
  let overlayOptions: OverlayOptions | undefined;
  let component: Component | undefined;
  const ui = {
    notify: () => {},
    custom: (
      factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => Component,
      options: { overlayOptions?: OverlayOptions },
    ) => {
      const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
      component = factory({ requestRender: () => {}, terminal }, theme, {}, () => {});
      overlayOptions = options.overlayOptions;
      return new Promise(() => {});
    },
  } as unknown as ExtensionUIContext;
  openWorkflowNavigator({} as ExtensionAPI, fakeManager([2, 3], 20), ui);
  assert.ok(component && overlayOptions);
  const navigator = component;
  let drawn: string[] = [];
  const probe: Component = { render: (width) => (drawn = navigator.render(width)), invalidate: () => {} };

  const sweep = (view: string) => {
    for (const columns of [1, 2, 5, 12, 13, 14, 15, 16, 24, 40, 80, 120]) {
      for (let rows = 1; rows <= 30; rows++) {
        terminal.rows = rows;
        const host = new HostProbe(noopTerminal);
        const handle = host.showOverlay(probe, overlayOptions);
        host.composite(columns, rows);
        const bounds = handle.getBounds();
        const where = `${view} ${columns}x${rows}`;
        assert.ok(bounds, where);
        assert.equal(drawn.length, bounds.height, `${where}: the host cut overlay rows`);
        for (const line of drawn) assert.equal(visibleWidth(line), bounds.width, `${where}: line width`);
      }
    }
  };

  sweep("runs");
  // At 80x10 the host allows 8 rows: the footer and the bottom border must both survive.
  terminal.rows = 10;
  const host = new HostProbe(noopTerminal);
  host.showOverlay(probe, overlayOptions);
  host.composite(80, 10);
  assert.equal(drawn.length, 8);
  assert.match(drawn[drawn.length - 1], /^╰─+╯$/);
  assert.match(drawn[drawn.length - 2], /enter open/);

  navigator.handleInput?.("\r");
  assert.match(navigator.render(80).join("\n"), /Phases/);
  sweep("phases");
});

test("the one-pane phase list colours each phase by its agents' status, as the two-pane view does", () => {
  const manager = fakeManager([2, 1, 1]);
  const run = manager.getRun("r0");
  assert.ok(run);
  run.snapshot.agents[0].status = "running";
  run.snapshot.agents[2].status = "error";
  // Colour names as distinct ANSI codes, which take no width, so layout is unchanged.
  const codes: Record<string, number> = { error: 31, success: 32, warning: 33, accent: 36, muted: 37, dim: 90 };
  const ansi = { fg: (c: string, s: string) => `\x1b[${codes[c] ?? 39}m${s}\x1b[39m`, bold: (s: string) => s };
  const colours = (width: number) => {
    const model = new NavigatorModel(manager);
    const state = new NavigatorState();
    state.drill(model);
    state.move(1, 3); // leave the first row, whose selection styling hides its status colour
    const text = renderNavigator(state, model, width, ansi as never, 20).join("\n");
    return [...text.matchAll(/\x1b\[(\d+)m(\d\/\d)/g)].map((m) => `${m[2]}:${m[1]}`);
  };
  const twoPane = colours(80);
  assert.ok(twoPane.includes(`1/2:${codes.warning}`), JSON.stringify(twoPane));
  assert.deepEqual(colours(30), twoPane);
});
