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
export function generateDeepResearchWorkflow(): string {
  return `export const meta = {
  name: 'deep_research',
  description: 'Deep research: plan queries, gather sourced claims, return them to the parent',
  phases: [
    { title: 'Queries' },
    { title: 'Gather' },
  ],
}

const question = (args && args.question) || ''
const angles = (args && args.angles) || 4
const minSupport = (args && args.minSupport) || 2

phase('Queries')
const plan = await agent(
  'You are planning web research for this question:\\n' + question +
  '\\n\\nProduce ' + angles + ' diverse, specific search queries that together cover the question from different angles.',
  { label: 'plan queries', schema: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] } }
)
// The planner agent() can return null (e.g. a subagent that died on a terminal
// provider error) or omit a usable queries array. Mirror the null-tolerance the
// Gather phase uses below and fall back to the original question as a single
// query so research still proceeds (degraded) instead of crashing on plan.queries.
const planned = plan && Array.isArray(plan.queries) ? plan.queries.filter((q) => typeof q === 'string' && q.trim().length > 0) : []
const queries = (planned.length > 0 ? planned : [question]).slice(0, angles)

phase('Gather')
const gathered = await parallel(queries.map((q, i) => () =>
  agent(
    'Research this query using the web_search and web_fetch tools.\\nQuery: ' + q +
    '\\n\\nSteps: (1) call web_search with the query; (2) web_fetch the 2 most relevant result URLs; ' +
    '(3) extract concrete, verifiable factual claims, each tagged with the exact source URL it came from. ' +
    'Do NOT invent sources or claims — report only what the fetched pages actually say.',
    { label: 'research ' + (i + 1), schema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, claims: { type: 'array', items: { type: 'string' } } }, required: ['url', 'claims'] } } }, required: ['sources'] } }
  )
))
const allSources = gathered.filter(Boolean).flatMap((g) => (g && g.sources) || [])

return { question, queries, minSupport, sources: allSources }`;
}
