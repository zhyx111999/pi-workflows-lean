/** Composes one navigator frame: the active view, then the prompt and key-hint footer, clipped to the viewport. */
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { ThemeLike } from "../display.js";
import type { NavigatorModel, NavigatorState } from "../workflow-ui.js";
import type { NavigatorTextRenderCache } from "./render-cache.js";
/** Callers wrap this in `model.withRenderFrame` so every view reads one consistent data set. */
export declare function renderNavigatorFrame(state: NavigatorState, model: NavigatorModel, width: number, theme: ThemeLike, viewportRows: number, markdownTheme: MarkdownTheme | undefined, renderCache: NavigatorTextRenderCache | undefined): string[];
