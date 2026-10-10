import type { WorkflowRunOptions } from "../workflow.js";
import type { ManagedRun } from "../workflow-manager.js";
/** A running agent session that can take an instruction mid-run. */
export interface SteerableAgent {
    label: string;
    steer: (text: string) => Promise<void>;
}
/** What the event handlers need from the manager for one execution. */
export interface RunEventSink {
    /** Emit a manager event while this execution is still the run's current one. */
    emit(event: string, payload: unknown): void;
    /** Hand the live snapshot to this execution's progress callback. */
    progress(): void;
    /** Write the run now; with `required`, a failed write throws. */
    persist(required?: boolean): void;
    /** Write the run after the throttle window. */
    schedulePersist(): void;
}
export type RunEventHooks = Pick<WorkflowRunOptions, "onWorkflowCheckpoint" | "onAgentJournal" | "onLog" | "onPhase" | "onAgentStart" | "onAgentModel" | "onAgentUsage" | "onAgentSession" | "onAgentEnd" | "onAgentHistory" | "registerAgentSteer" | "onRunFatal" | "onTokenUsage">;
/**
 * runWorkflow callbacks for one execution of `managed`. Per-agent events are
 * matched through `agentsById`, keyed by the call's unique id: concurrent
 * agents often share a label, so matching by label would update the wrong row.
 */
export declare function runEventHooks(managed: ManagedRun, sink: RunEventSink): RunEventHooks;
