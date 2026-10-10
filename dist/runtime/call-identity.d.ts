/** Hashes agent() and checkpoint() calls into the identities that decide whether a journaled result may replay. */
import type { AgentOptions, WorkflowCheckpointInput } from "../workflow.js";
/** Everything that, when edited, must make a journaled agent() result stale. */
export interface AgentCallIdentity {
    prompt: string;
    /** Spec-level model (explicit, definition or phase); the resolved model is not part of the key. */
    model: string | undefined;
    phase: string | undefined;
    options: AgentOptions;
    /** Resolved agentType definition (tools/model/prompt), so editing an agent .md invalidates the call. */
    agentDefinitionKey: string | null;
    cwd: string | undefined;
    isolation: "worktree" | undefined;
}
export declare function hashAgentCall(call: AgentCallIdentity): string;
export declare function hashCheckpointCall(input: WorkflowCheckpointInput): string;
/**
 * Identity of one agent() call: its store delta key, the id carried by every
 * onAgent* event, and its persisted agent row's callId. Prefixed with the run
 * id so it stays unique when hosts aggregate agents across runs.
 */
export declare function agentCallId(runId: string, callIndex: number): string;
