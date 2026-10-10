import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type AgentUsage } from "../agent-usage.js";
/** The token/cost part of the SDK's session stats. */
export interface SessionUsageStats {
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
    cost: number;
}
/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined instead of a zero
 * breakdown lets displays fall back to their scalar token count, so
 * non-reporting providers render as plain token totals.
 */
export declare function usageFromStats(stats: SessionUsageStats): AgentUsage | undefined;
/** `stats` minus `baseline` (never below zero); `stats` itself when there is no baseline. */
export declare function subtractSessionUsageStats(stats: SessionUsageStats, baseline?: SessionUsageStats): SessionUsageStats;
/**
 * Combine usage from completed messages with the current streaming message.
 * AgentSession notifies subscribers before it appends a message_end event to
 * SessionManager, so the event's assistant usage is absent from stats and must
 * be added exactly once. The real-session regression test pins this ordering.
 */
export declare function usageFromSessionProgress(stats: SessionUsageStats, event: AgentSessionEvent): AgentUsage | undefined;
