/**
 * Task-list runs: the `subagents` tool's `tasks` input starts one subagent per
 * task through a fixed script that receives the list as `args`. The tasks are
 * independent, so a resume with an edited list reuses every unchanged task
 * wherever it moved instead of only an unchanged prefix.
 */
/** One task of a task-list run. */
export interface SubagentTask {
    /** Unique within the run; names the subagent for read, message, and reuse. */
    label: string;
    task: string;
    model?: string;
}
/**
 * The script every task-list run executes. The list travels as `args` rather
 * than being embedded, so task text can never trip script validation (for
 * example a task that mentions Date.now()). The result is one text report
 * because delivery shows strings in full.
 */
export declare const SUBAGENT_TASKS_SCRIPT: string;
/** True for a run started from a task list rather than a script or a name. */
export declare function isTaskListScript(script: string): boolean;
/**
 * Validate a task list: a non-empty array of `{ label, task, model? }` with
 * unique non-blank labels and non-blank tasks. Labels and models are trimmed;
 * a null model counts as omitted because some providers fill every optional
 * field.
 */
export declare function parseSubagentTasks(value: unknown): SubagentTask[];
/**
 * Where each unchanged task of `previous` sits in `next`, as old index → new
 * index. A task is unchanged when its label, task, and model all match; the
 * index is the task's call index in the fixed script.
 */
export declare function unchangedTaskMoves(previous: readonly SubagentTask[], next: readonly SubagentTask[]): Map<number, number>;
