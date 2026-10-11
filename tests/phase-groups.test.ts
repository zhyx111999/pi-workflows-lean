import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "../src/display.js";
import { groupAgentsByPhase, phaseTitle } from "../src/phase-groups.js";

function agent(id: number, status: string, phase?: unknown): WorkflowAgentSnapshot {
  return { id, label: `a${id}`, prompt: "p", status, phase } as WorkflowAgentSnapshot;
}

function snapshot(phases: unknown, agents: unknown): Pick<WorkflowSnapshot, "phases" | "agents"> {
  return { phases, agents } as Pick<WorkflowSnapshot, "phases" | "agents">;
}

test("declared phases come first, then agent-only and phase-less groups by first appearance", () => {
  const groups = groupAgentsByPhase(
    snapshot(
      ["Plan", "Ship"],
      [agent(1, "done", "Extra"), agent(2, "done"), agent(3, "done", "Plan"), agent(4, "running", "Extra")],
    ),
  );
  assert.deepEqual(
    groups.map((g) => [g.phase, g.agents.map((a) => a.id)]),
    [
      ["Plan", [3]],
      ["Ship", []],
      ["Extra", [1, 4]],
      [null, [2]],
    ],
  );
});

test("counts every known status and ignores an unknown one", () => {
  const [group] = groupAgentsByPhase(
    snapshot(
      ["P"],
      ["queued", "running", "done", "done", "error", "skipped", "bogus"].map((s, i) => agent(i + 1, s, "P")),
    ),
  );
  assert.equal(group.agents.length, 7);
  assert.deepEqual(group.counts, { queued: 1, running: 1, done: 2, error: 1, skipped: 1 });
});

test("coerces titles so a non-string phase groups with its text form, and repeated titles collapse", () => {
  const groups = groupAgentsByPhase(snapshot([42, "42", "A", "A"], [agent(1, "done", 42), agent(2, "done", "42")]));
  assert.deepEqual(
    groups.map((g) => [g.title, g.agents.length]),
    [
      ["42", 2],
      ["A", 0],
    ],
  );
});

test("reads non-array phases and agents from a corrupt record as empty", () => {
  assert.deepEqual(groupAgentsByPhase(snapshot(null, { 0: agent(1, "done") })), []);
  assert.deepEqual(
    groupAgentsByPhase(snapshot(undefined, [agent(1, "done", "P")])).map((g) => g.title),
    ["P"],
  );
});

test("a phase named like the phase-less group stays a group of its own", () => {
  const groups = groupAgentsByPhase(snapshot([], [agent(1, "done", "(no phase)"), agent(2, "done")]));
  assert.deepEqual(
    groups.map((g) => [g.phase, g.agents.map((a) => a.id)]),
    [
      ["(no phase)", [1]],
      [null, [2]],
    ],
  );
});

test("phase titles give blank names and the phase-less group a readable stand-in", () => {
  assert.equal(phaseTitle(null), "(no phase)");
  assert.equal(phaseTitle(""), "(unnamed phase)");
  assert.equal(phaseTitle("  "), "(unnamed phase)");
  assert.equal(phaseTitle("Plan"), "Plan");
});
