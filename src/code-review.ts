/**
 * Multi-angle parallel code review workflow.
 * 7 specialized finder agents return raw findings to the parent.
 */

/**
 * Hard cap on diff characters fed into the review. This bounds worst-case
 * prompt size across 7 parallel finders + a per-candidate verify pass, even
 * when the diff-source exec step (see builtin-commands.ts) already raised its
 * own maxBuffer and successfully read a very large diff. Oversized diffs are
 * truncated rather than rejected — findings in the untruncated prefix still
 * have value — and the truncation is surfaced to the user, not silent.
 */
export const MAX_DIFF_CHARS = 200_000;

/**
 * Generate a code-review workflow script.
 *
 * The workflow expects `args` to be passed with shape:
 *   { diff: string, diffSource: string }
 *
 * Model tier routing follows the spec:
 *   Finders A/B/C → medium (correctness)
 *   Finders D/E/F → small  (cleanup)
 *   Finder  G     → big    (altitude / abstraction)
 */
export function generateCodeReviewWorkflow(): string {
  return `export const meta = {
  name: 'code_review',
  description: 'Multi-angle parallel code review: 7 finder angles return raw findings',
  phases: [
    { title: 'Find' },
  ],
}

const MAX_DIFF_CHARS = ${MAX_DIFF_CHARS}
const rawDiff = (args && args.diff) || ''
const diffSource = (args && args.diffSource) || 'git diff HEAD'
const diffTruncated = rawDiff.length > MAX_DIFF_CHARS
const diff = diffTruncated ? rawDiff.slice(0, MAX_DIFF_CHARS) : rawDiff
if (diffTruncated) {
  log(
    'Diff truncated for review: showing the first ' + MAX_DIFF_CHARS + ' of ' + rawDiff.length +
    ' characters (' + (rawDiff.length - MAX_DIFF_CHARS) + ' omitted). Findings past the cut are not covered.'
  )
}
const candidateSchema = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
        required: ['file', 'line', 'summary', 'failure_scenario'],
      },
    },
  },
  required: ['candidates'],
}

const diffBlock = '\\n\\n<diff source=\\"' + diffSource + '\\"' + (diffTruncated ? ' truncated=\\"true\\"' : '') + '>\\n' +
  diff + (diffTruncated ? '\\n\\n[... diff truncated: ' + (rawDiff.length - MAX_DIFF_CHARS) + ' more characters omitted ...]' : '') +
  '\\n</diff>\\n'
const base = 'Use the read/grep tools to pull in any additional file context you need.' + diffBlock

phase('Find')
const finders = await parallel([
  () => agent(
    'You are a line-by-line correctness scanner. Hunt ONLY for: inverted conditions, off-by-one errors, ' +
    'null/nil dereferences, wrong variable used, swallowed errors. For each candidate name the exact file, ' +
    'line number, a one-line summary, and the concrete failure scenario. Return ONLY issues you can justify ' +
    'with a line in the diff.' + base,
    { label: 'A-line-scan', tier: 'medium', schema: candidateSchema }
  ),
  () => agent(
    'You are a removed-behavior auditor. For every deleted line or block in the diff: name the invariant ' +
    'or contract it enforced, then find where (or prove) that contract is re-established elsewhere. ' +
    'Report only gaps where the invariant is NOT re-established.' + base,
    { label: 'B-removed-behavior', tier: 'medium', schema: candidateSchema }
  ),
  () => agent(
    'You are a cross-file call-site tracer. For each function/method whose signature or behavior changed ' +
    'in the diff: grep the codebase for callers, then check whether each call site is still correct after ' +
    'the change. Report only call sites that are now broken or need updating.' + base,
    { label: 'C-cross-file-tracer', tier: 'medium', schema: candidateSchema }
  ),
  () => agent(
    'You are a reuse finder. Identify new code in the diff that duplicates existing helpers, utilities, ' +
    'or patterns already present in the codebase. Propose the existing symbol that should be used instead.' + base,
    { label: 'D-reuse', tier: 'small', schema: candidateSchema }
  ),
  () => agent(
    'You are a simplification finder. Look for: redundant state that could be derived, copy-paste ' +
    'variation that could be a shared function, and dead code introduced by the diff.' + base,
    { label: 'E-simplification', tier: 'small', schema: candidateSchema }
  ),
  () => agent(
    'You are an efficiency finder. Identify: redundant I/O or network calls, sequential work that could ' +
    'be parallel, and blocking operations on the startup or hot path introduced by the diff.' + base,
    { label: 'F-efficiency', tier: 'small', schema: candidateSchema }
  ),
  () => agent(
    'You are an altitude reviewer. Assess whether the change is made at the RIGHT abstraction level. ' +
    'Look for: bandaids on shared infrastructure that should be fixed at the root, fixes in the wrong ' +
    'layer (e.g. compensating in the UI for a data model problem), or the change solving a symptom ' +
    'rather than the cause.' + base,
    { label: 'G-altitude', tier: 'big', schema: candidateSchema }
  ),
])

// Collect and deduplicate candidates across all finders
const allRaw = finders.flatMap((r, fi) => {
  const label = ['A','B','C','D','E','F','G'][fi]
  return ((r && r.candidates) || []).map((c) => ({ ...c, angle: label }))
})

// Deduplicate: same file + line + first 40 chars of summary → keep first
const seen = new Set()
const allCandidates = allRaw.filter((c) => {
  const key = (c.file || '') + ':' + (c.line || 0) + ':' + (c.summary || '').slice(0, 40)
  if (seen.has(key)) return false
  seen.add(key)
  return true
})

return { total: allCandidates.length, findings: allCandidates, diffTruncated }`;
}
