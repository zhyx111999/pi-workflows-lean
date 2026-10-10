/** Renders prompts, results, source code, and edit diffs as width-wrapped terminal lines. */
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { NavigatorTextRenderCache } from "./render-cache.js";
/** Render prose as Markdown when the host theme is available. Fenced code blocks
 * are syntax highlighted by pi's Markdown renderer. */
export declare function renderMarkdownLines(text: unknown, width: number, markdownTheme?: MarkdownTheme, renderCache?: NavigatorTextRenderCache): string[];
/** Render Pi's display-oriented edit diff inside the navigator's bounded
 * viewport while preserving its ANSI colors and intra-line highlights. */
export declare function renderDiffLines(diff: string, width: number, renderCache?: NavigatorTextRenderCache): string[];
/** Render a known-language source block without requiring Markdown fences (a
 * workflow script can itself contain backticks). */
export declare function renderCodeLines(text: unknown, language: string, width: number, markdownTheme?: MarkdownTheme, renderCache?: NavigatorTextRenderCache): string[];
/** Structured results render as highlighted JSON; text results as Markdown. */
export declare function renderResultLines(result: unknown, preview: string | undefined, width: number, markdownTheme?: MarkdownTheme, renderCache?: NavigatorTextRenderCache): string[];
