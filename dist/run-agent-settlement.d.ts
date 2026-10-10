import { WorkflowErrorCode } from "./errors.js";
import type { PersistedAgentState } from "./run-persistence.js";
export declare const INTERRUPTED_AGENT_CAUSE: {
    error: string;
    errorCode: WorkflowErrorCode;
};
export declare function agentHasNonTerminalStatus(status: PersistedAgentState["status"]): boolean;
/** Display-only settlement; replay remains keyed by the committed journal. */
export declare function settleInterruptedPersistedAgents(agents: PersistedAgentState[], cause: {
    error: string;
    errorCode?: WorkflowErrorCode;
}, endedAt: string): PersistedAgentState[];
