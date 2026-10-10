/** Builds the navigator's run, phase, and agent rows from run snapshots. */
import type { AgentUsage } from "../agent.js";
import type { WorkflowSnapshot } from "../display.js";
import type { PersistedRunState } from "../run-persistence.js";
/** A run's snapshot and lifecycle status, from the live manager or rehydrated from disk. */
export interface RunSnapshot {
    snapshot: WorkflowSnapshot;
    status: string;
}
export interface RunRow {
    runId: string;
    name: string;
    status: string;
    done: number;
    total: number;
    /** Fresh tokens for the whole run (see tokenFigures for the fallback rule). */
    fresh: number;
    /** Cache-read tokens for the whole run. */
    cacheRead: number;
    /** True when the displayed figures include character-heuristic estimates. */
    estimated: boolean;
    cost: number;
}
export interface PhaseRow {
    title: string;
    done: number;
    total: number;
    /** Fresh tokens summed across the phase's agents. */
    fresh: number;
    /** Cache-read tokens summed across the phase's agents. */
    cacheRead: number;
    /** True when any of the phase's agents reported heuristic-estimated figures. */
    estimated: boolean;
}
export interface AgentRow {
    id: number;
    label: string;
    status: string;
    phase?: string;
    tokens?: number;
    tokenUsage?: AgentUsage;
    model?: string;
}
/** One runs-list row; the live run, when present, wins over the persisted record. */
export declare function runRow(record: PersistedRunState, live: RunSnapshot | undefined): RunRow;
/** Phase rows in declared order, followed by any phase only an agent mentions. */
export declare function phaseRows(snap: WorkflowSnapshot): PhaseRow[];
export declare function agentRowsInPhase(snap: WorkflowSnapshot, phase: string): AgentRow[];
/** Every agent row grouped by phase in one pass, for views that show all phases at once. */
export declare function agentRowsByPhase(snap: WorkflowSnapshot): Map<string, AgentRow[]>;
