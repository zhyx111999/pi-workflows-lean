import type { PersistedAgentState, PersistedRunState } from "../run-persistence.js";
import { type SubagentTask } from "../subagent-tasks.js";
/** Unchanged tasks of an edited task list: old → new call index, and old → new agent call id. */
export interface TaskListMoves {
    indices: Map<number, number>;
    callIds: Map<string, string>;
}
/** Where each unchanged task moved. Throws when the run did not start from a task list, or a script edit is also given. */
export declare function taskListMoves(runId: string, persisted: PersistedRunState, edit: {
    script?: string;
    tasks?: SubagentTask[];
}): TaskListMoves;
/**
 * Point a reused task's agent row at its new call id so replay updates that
 * row; a changed or dropped task's row keeps its history but no call id.
 */
export declare function retargetAgentRow(agent: PersistedAgentState, moves: TaskListMoves): PersistedAgentState;
