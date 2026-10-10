/** Token and cost usage for one subagent attempt or logical agent call. */
export interface AgentUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
    /**
     * True when these figures come from a character-count heuristic because the
     * provider reported no usage — NOT a measurement. Propagates through
     * sumAgentUsage into run totals so persistence and display never present an
     * estimate as metered fact (#209). Rendering uses a "~" prefix.
     */
    estimated?: boolean;
}
/** Create an independent zero-valued agent usage record. */
export declare function createEmptyAgentUsage(): AgentUsage;
/** Add agent usage records without mutating either input. */
export declare function sumAgentUsage(...records: AgentUsage[]): AgentUsage;
/** Cumulative display usage plus the exact attempt delta when usage becomes committed. */
interface AgentCallUsageUpdate {
    tokenUsage: AgentUsage;
    committedUsage?: AgentUsage;
}
/** Settled cumulative usage for one logical agent call, including retries. */
interface AgentUsageCommit {
    tokens: number;
    tokenUsage?: AgentUsage;
}
/**
 * Track provisional and committed usage for one logical agent call across retries.
 * Starting a new attempt closes older attempts so their late callbacks are ignored.
 */
export declare function createAgentCallUsageTracker(onUpdate: (update: AgentCallUsageUpdate) => void): {
    startAttempt(): {
        reportProgress(usage: AgentUsage): void;
        reportTerminal(usage: AgentUsage): void;
        commitWithFallback(fallbackTotal: () => number): AgentUsageCommit;
        commitTerminalUsage(): AgentUsageCommit;
    };
};
/** Return whether two complete agent usage records contain the same values. */
export declare function agentUsageEquals(left: AgentUsage, right: AgentUsage): boolean;
export {};
