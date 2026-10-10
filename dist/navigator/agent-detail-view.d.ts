/** The agent detail page: a compact summary by default and a scrollable full pager on demand. */
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../display.js";
import type { NavigatorModel, NavigatorState } from "../workflow-ui.js";
import type { NavigatorTextRenderCache } from "./render-cache.js";
export declare function renderAgentDetail(state: NavigatorState, model: NavigatorModel, runId: string, agentId: number, width: number, theme: ThemeLike, viewportRows: number, markdownTheme: MarkdownTheme | undefined, renderCache: NavigatorTextRenderCache | undefined): string[];
