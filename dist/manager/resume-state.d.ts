import type { AgentUsage } from "../agent-usage.js";
import { type PersistedRunState, type RunLease } from "../run-persistence.js";
import type { JournalEntry } from "../workflow.js";
import type { ManagedRun } from "../workflow-manager.js";
import { type TaskListMoves } from "./task-list-reuse.js";
export interface ResumeInput {
    runId: string;
    /** The record, already re-read under `lease`. */
    persisted: PersistedRunState;
    /** The script and args to run: the record's own, or the edit being resumed with. */
    script: string;
    args: unknown;
    /** Where an edited task list moved its unchanged tasks. */
    taskMoves?: TaskListMoves;
    lease: RunLease;
    /** The manager's session, used only for old records without a session of their own. */
    currentSessionId?: string;
}
export interface ResumedRun {
    managed: ManagedRun;
    /** The journal entries the new execution may replay. */
    journal: JournalEntry[];
    /** The record's token total, so the resumed run reports cumulative usage. */
    priorTokenUsage?: AgentUsage;
}
/**
 * The live run for a resume. The snapshot is seeded with the recorded agents,
 * so the record never loses its earlier agents (an edited script may never
 * replay them); replayed calls update their seeded row instead of adding one.
 * Rows of agents that were still queued or running settle as interrupted.
 * Every field of the record is shape-checked, because nothing may throw once
 * the lease is held.
 */
export declare function resumedRun(input: ResumeInput): ResumedRun;
