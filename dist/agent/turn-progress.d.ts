import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type AgentHistoryEntry } from "../agent-history.js";
import { type AgentUsage } from "../agent-usage.js";
import { type SessionUsageStats } from "./session-usage.js";
/** The host callbacks a turn reports to (a subset of AgentRunOptions). */
export interface TurnProgressCallbacks {
    onHistory?: (history: AgentHistoryEntry[]) => void;
    onUsageProgress?: (usage: AgentUsage) => void;
    onUsage?: (usage: AgentUsage) => void;
}
/** The session surface progress reporting reads. */
interface ProgressSession {
    readonly messages: unknown[];
    getSessionStats(): SessionUsageStats;
}
export declare class TurnProgress {
    private readonly session;
    private readonly callbacks;
    /** Stats before this turn: a threaded session already holds earlier turns' usage. */
    private readonly baseline;
    private lastHistoryEmit;
    private lastUsageEmit;
    private lastUsage;
    constructor(session: ProgressSession, callbacks: TurnProgressCallbacks, baseline: SessionUsageStats | undefined);
    /** Whether the host asked for live progress, i.e. whether onEvent needs a subscription. */
    get live(): boolean;
    /** Session event listener: a throttled history snapshot, then live usage. */
    readonly onEvent: (event: AgentSessionEvent) => void;
    /** The last history snapshot, sent when the turn ends. */
    emitFinalHistory(): void;
    /** Report this turn's exact usage. Call before disposal, which tears down the stats. */
    reportFinalUsage(): void;
    private emitHistory;
    private maybeEmitHistory;
    private emitUsageProgress;
}
export {};
