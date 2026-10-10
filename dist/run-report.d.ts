/**
 * Model-facing reports of workflow runs: one-line run summaries, per-agent
 * status, the waiting checkpoint, and the tail of one subagent's session.
 */
import type { AgentHistoryEntry } from "./agent-history.js";
import { type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import type { PersistedAgentState, PersistedRunState, RunStatus } from "./run-persistence.js";
/** Characters of one subagent session returned by `read`. */
export declare const AGENT_TAIL_CHARS = 8000;
export interface RunSummaryDetails {
    runId: string;
    workflowName: string;
    status: RunStatus;
    phase: string | null;
    checkpoint: Pick<NonNullable<PersistedRunState["checkpoint"]>, "checkpointId" | "kind" | "status"> | null;
    counts: {
        total: number;
        done: number;
        running: number;
        queued: number;
        error: number;
        skipped: number;
    };
    activeLabels: string[];
    tokenTotal: number;
    /** True when tokenTotal includes character-heuristic estimates. */
    tokenTotalEstimated: boolean;
}
/** Summarize a run, preferring the live snapshot over the persisted record when one exists. */
export declare function summarizeRun(run: PersistedRunState, live?: WorkflowSnapshot | null): RunSummaryDetails;
/** One key=value line per run, stable for the model to scan. */
export declare function formatRunSummary(run: RunSummaryDetails): string;
export interface AgentStatusDetails {
    label: string;
    status: string;
    phase?: string;
}
/** Every agent's label and status, from the live snapshot when the run is in memory. */
export declare function agentStatuses(run: PersistedRunState, live?: WorkflowSnapshot | null): AgentStatusDetails[];
export declare function formatAgentStatuses(agents: readonly AgentStatusDetails[]): string;
/** The checkpoint a run is waiting at, with a bounded payload preview; null when it waits for none. */
export declare function waitingCheckpoint(run: PersistedRunState): {
    checkpointId: string;
    kind: string;
    payload: string;
} | null;
interface TailAgent {
    id: number;
    label: string;
    phase?: string;
    status: string;
    history?: AgentHistoryEntry[];
    result?: unknown;
    error?: string;
    endedAt?: string;
}
export declare function asTailAgent(agent: WorkflowAgentSnapshot | PersistedAgentState): TailAgent;
/** The agent with this label, or the most recently updated one; the later row wins a tie. */
export declare function selectTailAgent(agents: readonly TailAgent[], label?: string): TailAgent | undefined;
/** The last `maxChars` of one agent's session: header, history, then result or error. */
export declare function renderAgentTail(agent: TailAgent, maxChars?: number): string;
export {};
