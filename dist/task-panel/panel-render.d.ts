/** Renders the rows of the live workflows panel, compact or detailed with a rolling token/s rate. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager } from "../workflow-manager.js";
/** Compact panel: one line per active or delivery-pending run. */
export declare function renderPanel(manager: WorkflowManager, theme: Theme, width?: number): string[];
/** Record a token-total sample for `runId` at time `now` (ms). */
export declare function sampleTokens(runId: string, total: number, now: number, estimated?: boolean): void;
/** Tokens/second over the rolling window; 0 when too few samples or totals plateau. */
export declare function tokensPerSecond(runId: string): number;
/** Forget a run's samples (call when it finishes) so the map can't grow unbounded. */
export declare function clearTokenSamples(runId: string): void;
/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export declare function clampMaxAgents(value: number | undefined): number;
/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and a live token/s rate, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export declare function renderPanelDetailed(manager: WorkflowManager, theme: Theme, width: number | undefined, maxAgents: number, now: number): string[];
