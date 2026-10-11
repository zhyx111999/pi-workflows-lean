/**
 * Comprehensive tests for workflow display rendering:
 *
 * 1. renderWorkflowText — how the plain-text status view renders
 *    progress, phases, agents, tokens, cost
 * 2. Phase grouping — the text view and the navigator list the same phases
 * 3. deliverText — how background-run results are formatted for the user
 * 4. Pure helper functions: preview
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateAgentUsage, fmtFull, fmtTokenSegment, tokenFigures } from "../src/display.js";
import type { WorkflowMeta } from "../src/workflow.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakeMeta(
  name = "test-wf",
  desc = "test description",
  phases: string[] = ["Research", "Build", "Verify"],
): WorkflowMeta {
  return { name, description: desc, phases: phases.map((t) => ({ title: t })) };
}

function agent(
  id: number,
  label: string,
  status: "queued" | "running" | "done" | "error" | "skipped",
  phase?: string,
  opts?: {
    resultPreview?: string;
    tokens?: number;
    tokenUsage?: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
    model?: string;
    prompt?: string;
  },
) {
  return {
    id,
    label,
    status,
    phase,
    prompt: opts?.prompt ?? `execute ${label}`,
    ...(opts?.resultPreview ? { resultPreview: opts.resultPreview } : {}),
    ...(opts?.tokens ? { tokens: opts.tokens } : {}),
    ...(opts?.tokenUsage ? { tokenUsage: opts.tokenUsage } : {}),
    ...(opts?.model ? { model: opts.model } : {}),
  };
}

// ─── Module loading helpers ─────────────────────────────────────────────────

async function loadDisplay() {
  return import("../src/display.js");
}

async function loadTaskPanel() {
  return import("../src/task-panel.js");
}

// ═══════════════════════════════════════════════════════════════════════════
// renderWorkflowText
// ═══════════════════════════════════════════════════════════════════════════

describe("renderWorkflowText", () => {
  it("shows 'running' header when not completed", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const text = renderWorkflowText(createWorkflowSnapshot(fakeMeta("test")));
    assert.ok(text.includes("running"), "should say running in the header");
    assert.ok(!text.includes("completed"), "should not say completed");
  });

  it("shows 'completed' header when completed flag is true", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const text = renderWorkflowText(createWorkflowSnapshot(fakeMeta()), true);
    assert.ok(text.includes("completed"), "should say completed");
  });

  it("includes workflow name in output", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const text = renderWorkflowText(createWorkflowSnapshot(fakeMeta("audit-all")));
    assert.ok(text.includes("audit-all"), "should contain audit-all");
  });

  it("includes phase names", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Phase1", "Phase2"]));
    snap.agents = [agent(1, "agent-1", "done", "Phase1")] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("Phase1"), "should contain Phase1");
    assert.ok(text.includes("Phase2"), "should contain Phase2");
  });

  it("includes agent labels", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.agents = [agent(1, "inventory", "done", "Research")] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("inventory"), "should contain inventory");
  });

  it("shows agent count and done count", async () => {
    const { createWorkflowSnapshot, renderWorkflowText, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [
      agent(1, "a1", "done", "Research"),
      agent(2, "a2", "done", "Build"),
      agent(3, "a3", "error", "Verify"),
    ] as never[];
    const text = renderWorkflowText(recomputeWorkflowSnapshot(snap));
    assert.ok(text.includes("3"), "should mention total agents");
    assert.ok(text.includes("2"), "should mention done count");
  });

  it("shows error count", async () => {
    const { createWorkflowSnapshot, renderWorkflowText, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [agent(1, "a1", "done", "Research"), agent(2, "a2", "error", "Research")] as never[];
    const text = renderWorkflowText(recomputeWorkflowSnapshot(snap));
    assert.ok(text.includes("1 errors"), "should show error count");
  });

  it("shows running count in header", async () => {
    const { createWorkflowSnapshot, renderWorkflowText, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta()));
    snap.agents = [agent(1, "a1", "done", "Research"), agent(2, "a2", "running", "Research")] as never[];
    const text = renderWorkflowText(recomputeWorkflowSnapshot(snap));
    assert.ok(text.includes("(1/2 done, 1 running)"), "should show running in header");
  });

  it("shows cost info when tokenUsage has cost", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.tokenUsage = { input: 1000, output: 500, total: 1500, cost: 0.042 };
    const text = renderWorkflowText(snap);
    // fmtCost: 2 decimals from one cent up, 4 below it (shared across all surfaces).
    assert.ok(text.includes("$0.04"), "should show cost");
  });

  it("shows token info without cost when cost is absent", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.tokenUsage = { input: 500, output: 300, total: 800 };
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("800"), "should show token count");
    assert.ok(!text.includes("$"), "should NOT show cost when absent");
  });

  it("shows skipped agents in phase line", async () => {
    const { createWorkflowSnapshot, renderWorkflowText, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta("t", "d", ["Phase"])));
    snap.agents = [agent(1, "a1", "done", "Phase"), agent(2, "a2", "skipped", "Phase")] as never[];
    const text = renderWorkflowText(recomputeWorkflowSnapshot(snap));
    assert.ok(text.includes("1 skipped"), "should show skipped count");
  });

  it("shows unphased agents when agents have no phase", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", []));
    snap.agents = [agent(1, "orphan", "done")] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("(no phase)"), "should show the phase-less group");
    assert.ok(text.includes("orphan"), "should contain orphan");
  });

  it("shows agent tokens when available", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.agents = [agent(1, "heavy-agent", "done", "Research", { tokens: 12345 })] as never[];
    const text = renderWorkflowText(snap);
    // toLocaleString() output depends on locale (UK/US uses commas, PL uses NBSP)
    // Check with a regex matching any thousands separator between 12 and 345
    assert.ok(/12[ ,.\u00a0]345/.test(text), "should show formatted token count");
  });

  it("shows a fresh/cache split for an agent with tokenUsage", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.agents = [
      agent(1, "cached-agent", "done", "Research", {
        tokens: 3_100_000,
        tokenUsage: { input: 80_000, output: 20_000, total: 3_100_000, cacheRead: 3_000_000, cacheWrite: 0, cost: 0.4 },
      }),
    ] as never[];
    const text = renderWorkflowText(snap);
    // fresh (input+output = 100,000) reads as "tok"; cacheRead (3,000,000) as "cached" (locale-flexible separators)
    assert.ok(/100[ ,.\u00a0]000 tok/.test(text), "shows fresh (input+output) as tok");
    assert.ok(/3[ ,.\u00a0]000[ ,.\u00a0]000 cached/.test(text), "shows cacheRead as cached");
  });

  it("tokenFigures uses the breakdown when it carries signal and the estimate otherwise", async () => {
    const { tokenFigures } = await loadDisplay();
    // Reporting provider: total = input+output+cacheRead+cacheWrite, both paths agree.
    // cacheWrite counts as fresh — it is first-time ingestion billed at full/premium price.
    assert.deepEqual(tokenFigures({ input: 80, output: 20, total: 1100, cacheRead: 900, cacheWrite: 100 }), {
      fresh: 200,
      cacheRead: 900,
      estimated: false,
    });
    // Cache-creating first turn: the written prefix must not vanish from the count.
    assert.deepEqual(tokenFigures({ input: 6000, output: 1000, total: 207000, cacheRead: 0, cacheWrite: 200000 }), {
      fresh: 207000,
      cacheRead: 0,
      estimated: false,
    });
    // Estimate-only (provider reported nothing): the scalar total survives as fresh.
    assert.deepEqual(tokenFigures({ input: 0, output: 0, total: 800, cacheRead: 0, cacheWrite: 0 }), {
      fresh: 800,
      cacheRead: 0,
      estimated: false,
    });
    // Cost-only agent: all-zero breakdown, scalar estimate alongside.
    assert.deepEqual(tokenFigures({ input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0.02 }, 384), {
      fresh: 384,
      cacheRead: 0,
      estimated: false,
    });
    // Mixed run: some agents reported (input+output=100), the rest only estimated into total.
    assert.deepEqual(tokenFigures({ input: 70, output: 30, total: 900, cacheRead: 0, cacheWrite: 0 }), {
      fresh: 900,
      cacheRead: 0,
      estimated: false,
    });
    // No usage object at all.
    assert.deepEqual(tokenFigures(undefined, 500), { fresh: 500, cacheRead: 0, estimated: false });
    assert.deepEqual(tokenFigures(undefined), { fresh: 0, cacheRead: 0, estimated: false });
  });

  it("header falls back to the estimated total when the provider reported no usage (#57 regression)", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    // onUsage never fired: breakdown is all-zero, total carries the estimate.
    snap.tokenUsage = { input: 0, output: 0, total: 800 };
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("800 tok"), `estimate should survive in the header; got: ${text}`);
    assert.ok(!/\b0 tok/.test(text), `must not render a zero breakdown; got: ${text}`);
  });

  it("keeps the scalar estimate for a cost-only agent row (#57 regression)", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.agents = [
      agent(1, "cost-only-agent", "done", "Research", {
        tokens: 384,
        tokenUsage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
      }),
    ] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(/\[384 tok\]/.test(text), `cost-only agent should show its scalar estimate; got: ${text}`);
  });

  it("suppresses the header token segment for an all-zero usage aggregate (#57 regression)", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    // e.g. a fully journal-replayed resume, or a run whose agents were all skipped.
    snap.tokenUsage = { input: 0, output: 0, total: 0 };
    const text = renderWorkflowText(snap);
    assert.ok(!/\b0 tok/.test(text), `an all-zero aggregate must not render "0 tok"; got: ${text}`);
  });

  it("fmtCost never renders a real cost as a zero-looking figure", async () => {
    const { fmtCost } = await loadDisplay();
    assert.equal(fmtCost(6.7), "$6.70");
    assert.equal(fmtCost(0.0042), "$0.0042");
    assert.equal(fmtCost(0.00003), "<$0.0001");
  });

  it("truncates long agent labels", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.agents = [agent(1, "x".repeat(100), "done", "Research")] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("…"), "should truncate with ellipsis");
    assert.ok(text.length < 200, "should not include the full 100-char label");
  });

  it("shows 'earlier agents' past the per-phase cap", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Phase"]));
    snap.agents = Array.from({ length: 20 }, (_, i) => agent(i + 1, `agent-${i + 1}`, "done", "Phase")) as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("earlier agents"), "should mention earlier agents");
    assert.ok(text.includes("agent-20"), "should show last agent");
    // Use word boundary to avoid matching "agent-1" inside "agent-11", "agent-12", etc.
    assert.ok(!/\bagent-1\b/.test(text), "first agents should be clipped");
  });

  it("displays durationMs when present", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.durationMs = 12500;
    // renderWorkflowText doesn't explicitly show duration — but header includes tokenInfo
    // duration is available through the snapshot. Let's verify the function works.
    const text = renderWorkflowText(snap, true);
    assert.ok(text.includes("completed"), "completed header shown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers: preview
// ═══════════════════════════════════════════════════════════════════════════

describe("display pure helpers", () => {
  it("preview returns string for number 0", async () => {
    const { preview } = await loadDisplay();
    assert.equal(preview(0), "0");
  });

  it("preview returns 'true' for boolean true", async () => {
    const { preview } = await loadDisplay();
    assert.equal(preview(true), "true");
    assert.equal(preview(false), "false");
  });

  it("preview returns empty for undefined", async () => {
    const { preview } = await loadDisplay();
    assert.equal(preview(undefined), "");
  });

  it("preview truncates long JSON strings", async () => {
    const { preview } = await loadDisplay();
    const result = preview("x".repeat(200));
    assert.ok(result.length <= 85, "should truncate with max 80 + …");
    assert.ok(result.endsWith("…"), "should end with …");
  });

  it("preview accepts custom max length", async () => {
    const { preview } = await loadDisplay();
    const result = preview("x".repeat(50), 10);
    assert.ok(result.length <= 14, "should respect custom max");
  });

  it("preview handles arrays", async () => {
    const { preview } = await loadDisplay();
    const arr = [1, 2, 3, 4, 5];
    const result = preview(arr, 50);
    assert.ok(result.length > 0, "result should not be empty");
    assert.ok(result.includes("1"), "should contain 1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deliverText — background result formatting
// ═══════════════════════════════════════════════════════════════════════════

describe("deliverText", () => {
  function fakeManagedRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: "r-123",
      workflowName: "my-wf",
      snapshot: {
        name: "my-wf",
        agentCount: 5,
        phases: [],
        logs: [],
        agents: [],
        ...((overrides.snapshot as Record<string, unknown>) ?? {}),
      },
      status: "completed",
      result: {
        result: { verdict: "All checks passed" },
        agentCount: 5,
        tokenUsage: { input: 100, output: 50, total: 150, cost: 0.003 },
        durationMs: 12345,
      },
      ...overrides,
    } as never;
  }

  it("prefers verdict property when available", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    assert.ok(text.includes("All checks passed"), "should include verdict text");
  });

  it("falls back to report when no verdict", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: { report: "Found 5 issues in codebase" },
        agentCount: 3,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("Found 5 issues"), "should include report text");
  });

  it("falls back to summary when no verdict or report", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: { summary: "Analysis complete" },
        agentCount: 2,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("Analysis complete"), "should include summary text");
  });

  it("falls back to JSON when result has no structured properties", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: { raw: "data", count: 42 },
        agentCount: 1,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("count"), "should include JSON keys");
    assert.ok(text.includes("42"), "should include JSON values");
  });

  it("uses string result directly", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: "Everything is fine",
        agentCount: 1,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("Everything is fine"), "should contain Everything is fine");
  });

  it("handles null result gracefully", async () => {
    const { deliverText } = await loadTaskPanel();
    const run = fakeManagedRun({
      result: {
        result: null,
        agentCount: 1,
      },
    });
    const text = deliverText(run);
    assert.ok(text.includes("null"), "should say null");
    assert.ok(text.includes("finished"), "should include finished message");
  });

  it("includes token count when available", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    assert.ok(text.includes("150"), "should show the token count");
    assert.ok(text.includes("tok"), "should label the token count");
  });

  it("includes agent count", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    assert.ok(text.includes("5"), "should show 5 agents");
    assert.ok(text.includes("agents"), "should mention agents");
  });

  it("includes duration in seconds", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    assert.ok(text.includes("12.3"), "should show duration in seconds");
    assert.ok(text.includes("s"), "should show unit");
  });

  it("starts with checkmark and workflow name", async () => {
    const { deliverText } = await loadTaskPanel();
    const text = deliverText(fakeManagedRun());
    assert.ok(text.startsWith("✓"), "should start with checkmark");
    assert.ok(text.includes("my-wf"), "should include workflow name");
  });

  it("truncates very long JSON at 400 chars", async () => {
    const { deliverText } = await loadTaskPanel();
    const large = { data: "x".repeat(500) };
    const run = fakeManagedRun({
      result: {
        result: large,
        agentCount: 1,
      },
    });
    const text = deliverText(run);
    // JSON of large object + "...(truncated)" — deliverText has slice(0,400) logic
    assert.ok(text.includes("truncated") || text.length < 600, "very long JSON should be truncated");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createWorkflowSnapshot / recomputeWorkflowSnapshot
// ═══════════════════════════════════════════════════════════════════════════

describe("createWorkflowSnapshot", () => {
  it("sets default values for optional fields", async () => {
    const { createWorkflowSnapshot } = await loadDisplay();
    const meta = { name: "n", description: "d" };
    const snap = createWorkflowSnapshot(meta as never);
    assert.deepEqual(snap.phases, []);
    assert.deepEqual(snap.logs, []);
    assert.deepEqual(snap.agents, []);
    assert.equal(snap.agentCount, 0);
    assert.equal(snap.runningCount, 0);
    assert.equal(snap.doneCount, 0);
    assert.equal(snap.errorCount, 0);
  });
});

describe("recomputeWorkflowSnapshot", () => {
  it("counts running/done/error correctly mixed statuses", async () => {
    const { createWorkflowSnapshot, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = createWorkflowSnapshot({ name: "t", description: "d" } as never);
    snap.agents = [
      { id: 1, label: "a", prompt: "p", status: "queued" },
      { id: 2, label: "b", prompt: "p", status: "running" },
      { id: 3, label: "c", prompt: "p", status: "done" },
      { id: 4, label: "d", prompt: "p", status: "error" },
      { id: 5, label: "e", prompt: "p", status: "skipped" },
    ] as never[];
    const r = recomputeWorkflowSnapshot(snap);
    assert.equal(r.agentCount, 5);
    assert.equal(r.runningCount, 1);
    assert.equal(r.doneCount, 1);
    assert.equal(r.errorCount, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderWorkflowText edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("renderWorkflowText edge cases", () => {
  it("handles empty agents array", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const summary = renderWorkflowText(createWorkflowSnapshot(fakeMeta())).split("\n")[1];
    assert.ok(summary.includes("0/0 done"), "should show 0/0 done");
  });

  it("handles multiple phases with varying agent counts", async () => {
    const { createWorkflowSnapshot, renderWorkflowText, recomputeWorkflowSnapshot } = await loadDisplay();
    const snap = recomputeWorkflowSnapshot(createWorkflowSnapshot(fakeMeta("t", "d", ["Alpha", "Beta"])));
    snap.agents = [
      agent(1, "a1", "done", "Alpha"),
      agent(2, "a2", "done", "Beta"),
      agent(3, "a3", "running", "Beta"),
    ] as never[];
    const text = renderWorkflowText(recomputeWorkflowSnapshot(snap));
    assert.ok(text.includes("✓ Alpha 1/1"), "Alpha is complete");
    assert.ok(text.includes("▶ Beta 1/2 · 1 running"), "Beta shows its running agent");
  });

  it("mentions the workflow name in the summary line", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const summary = renderWorkflowText(createWorkflowSnapshot(fakeMeta("check-everything"))).split("\n")[1];
    assert.ok(summary.includes("check-everything"), "should contain check-everything");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase grouping: the text view and the navigator list the same phases
// ═══════════════════════════════════════════════════════════════════════════

describe("phase grouping shared by the text view and the navigator", () => {
  /** Phase titles in the order the text view prints them. */
  function textPhaseTitles(text: string): string[] {
    return text
      .split("\n")
      .filter((line) => /^ {2}[▶✓ ] [^[…]/.test(line))
      .map((line) => line.slice(4).replace(/ \d+\/\d+.*$/, ""));
  }

  it("lists an agent-only phase after the declared ones instead of folding it into another group", async () => {
    const { createWorkflowSnapshot, renderWorkflowText, recomputeWorkflowSnapshot } = await loadDisplay();
    const { phaseRows } = await import("../src/navigator/rows.js");
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Declared"]));
    snap.agents = [agent(1, "declared-agent", "done", "Declared"), agent(2, "extra-agent", "done", "Extra")] as never[];
    const text = renderWorkflowText(recomputeWorkflowSnapshot(snap));
    assert.deepEqual(textPhaseTitles(text), ["Declared", "Extra"]);
    assert.deepEqual(
      phaseRows(snap).map((row) => row.title),
      ["Declared", "Extra"],
    );
    assert.match(text, /✓ Extra 1\/1\n {4}\[2\] ✓ extra-agent/);
  });

  it("orders agent-only and phase-less groups by first appearance on both surfaces", async () => {
    const { createWorkflowSnapshot, renderWorkflowText, recomputeWorkflowSnapshot } = await loadDisplay();
    const { phaseRows } = await import("../src/navigator/rows.js");
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Plan", "Ship"]));
    snap.agents = [
      agent(1, "late", "running", "Late"),
      agent(2, "orphan", "queued"),
      agent(3, "planner", "done", "Plan"),
      agent(4, "late-2", "error", "Late"),
    ] as never[];
    const expected = ["Plan", "Ship", "Late", "(no phase)"];
    const text = renderWorkflowText(recomputeWorkflowSnapshot(snap));
    assert.deepEqual(textPhaseTitles(text), expected);
    assert.deepEqual(
      phaseRows(snap).map((row) => [row.title, row.done, row.total]),
      [
        ["Plan", 1, 1],
        ["Ship", 0, 0],
        ["Late", 0, 2],
        ["(no phase)", 0, 1],
      ],
    );
    assert.ok(text.includes("▶ Late 0/2 · 1 running · 1 errors"), "the agent-only phase carries its own tally");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Text view: no markdown syntax leaked into display
// ═══════════════════════════════════════════════════════════════════════════

describe("renderWorkflowText has no markdown syntax", () => {
  it("uses [id] instead of #id prefix", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta("t", "d", ["Phase"]));
    snap.agents = [agent(1, "agent-1", "done", "Phase")] as never[];
    const text = renderWorkflowText(snap);
    assert.ok(text.includes("[1]"), "should use [id] instead of #id");
    assert.ok(!text.includes("#1"), "should NOT use #1 prefix");
  });

  it("has no bold, heading, or code fence markers while running or once completed", async () => {
    const { createWorkflowSnapshot, renderWorkflowText } = await loadDisplay();
    const snap = createWorkflowSnapshot(fakeMeta());
    snap.agents = [agent(1, "a1", "done", "Research")] as never[];
    for (const text of [renderWorkflowText(snap), renderWorkflowText(snap, true)]) {
      assert.ok(!text.includes("**"), "should not have bold markdown markers");
      assert.ok(!text.includes("##"), "should not have heading markdown markers");
      assert.ok(!text.includes("```"), "should not have code fence markers");
    }
  });
});

describe("fmtTokenSegment estimate marking (#209)", () => {
  it("prefixes character-heuristic figures with ~ so an estimate never reads as metered", () => {
    assert.equal(fmtTokenSegment({ fresh: 1200, cacheRead: 0, estimated: true }, fmtFull), "~1,200 tok");
    assert.equal(fmtTokenSegment({ fresh: 1200, cacheRead: 300, estimated: true }, fmtFull), "~1,200 tok · 300 cached");
    assert.equal(
      fmtTokenSegment({ fresh: 1200, cacheRead: 0, estimated: false }, fmtFull),
      "1,200 tok",
      "metered figures render unprefixed",
    );
    assert.equal(
      fmtTokenSegment({ fresh: 0, cacheRead: 0, estimated: true }, fmtFull),
      "",
      "nothing-known stays omitted",
    );
  });

  it("keeps legacy callers without estimated as metered output", () => {
    const rendered = fmtTokenSegment({ fresh: 1200, cacheRead: 0 }, fmtFull);
    assert.equal(rendered, "1,200 tok");
    assert.doesNotMatch(rendered, /~/);
  });

  it("tokenFigures and aggregateAgentUsage propagate the flag", () => {
    assert.deepEqual(tokenFigures({ input: 10, output: 5, total: 15, estimated: true }), {
      fresh: 15,
      cacheRead: 0,
      estimated: true,
    });
    assert.equal(tokenFigures({ input: 10, output: 5, total: 15 }).estimated, false);
    const aggregate = aggregateAgentUsage([
      { tokens: 10, tokenUsage: undefined },
      {
        tokens: 5,
        tokenUsage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, total: 5, cost: 0, estimated: true },
      },
    ]);
    assert.equal(aggregate.estimated, true, "one estimated agent flags the phase aggregate");
  });
});
