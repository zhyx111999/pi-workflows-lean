/**
 * Deep research workflow.
 * Built-in workflow for comprehensive research across multiple sources.
 */
export interface DeepResearchConfig {
    /** Number of distinct search angles/queries to explore. */
    angles: number;
    /** Minimum distinct sources required for a claim to survive cross-checking. */
    minSupport: number;
}
/**
 * Generate a deep-research workflow that uses the real web_search/web_fetch tools.
 *
 * The script is static and reads its inputs from `args` (question/angles/minSupport),
 * so the question is never string-interpolated into source — no escaping hazards.
 * Inject the web tools at run time via the agent's `tools` option.
 */
export declare function generateDeepResearchWorkflow(): string;
