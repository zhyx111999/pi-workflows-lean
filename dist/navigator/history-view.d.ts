/** Renders one entry of an agent's session history: messages, tool calls, written source, and edit diffs. */
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot } from "../display.js";
import type { NavigatorTextRenderCache } from "./render-cache.js";
type AgentHistory = NonNullable<WorkflowAgentSnapshot["history"]>;
export declare function renderHistoryEntryLines(history: AgentHistory, index: number, width: number, markdownTheme: MarkdownTheme | undefined, dim: (text: string) => string, renderCache?: NavigatorTextRenderCache): string[];
export {};
