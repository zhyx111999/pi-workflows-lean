/**
 * Deep research workflow.
 * Built-in workflow for comprehensive research across multiple sources.
 */
export interface DeepResearchConfig {
    /** Number of distinct search angles/queries to explore. */
    angles: number;
}
/**
 * Generate a deep-research workflow that uses the real web_search/web_fetch tools.
 *
 * The script is static and reads its inputs from `args` (question/angles),
 * so the question is never string-interpolated into source — no escaping hazards.
 * The run supplies the web tools (see builtin-workflows.ts). Every gathered source
 * goes back to the parent model, which checks the claims itself.
 */
export declare function generateDeepResearchWorkflow(): string;
