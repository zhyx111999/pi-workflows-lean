/** The saved-workflow detail page: its metadata and highlighted script. */
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../display.js";
import type { NavigatorModel, NavigatorState } from "../workflow-ui.js";
import type { NavigatorTextRenderCache } from "./render-cache.js";
export declare function renderSavedDetail(state: NavigatorState, model: NavigatorModel, width: number, theme: ThemeLike, viewportRows: number, markdownTheme: MarkdownTheme | undefined, renderCache: NavigatorTextRenderCache | undefined): string[];
