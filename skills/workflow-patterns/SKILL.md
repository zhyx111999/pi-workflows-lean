---
name: workflow-patterns
description: Argument shape for the built-in deep-research workflow, runnable via the workflow tool's name input. Not for authoring a new workflow script — see workflow-authoring.
metadata:
  version: "3.7.0"
---

# Built-in workflow patterns

This fork ships one built-in workflow pattern, `/deep-research`. It is also
reachable from the `workflow` tool: call it with `name` set to `deep-research`
and `args` matching the shape below, instead of writing an equivalent script.

A project or user saved workflow of the same name always takes precedence
over a built-in of that name — on the slash command, too.

`deep-research` is reachable only at the `workflow` tool's top-level `name`
input, not via the in-script `await workflow(savedName, childArgs)` helper —
that helper resolves saved workflows only. Calling `workflow('deep-research')`
from inside a script fails as an unknown saved workflow; use the top-level
`name` input instead.

## Patterns

| `name` | When to reach for it | `args` |
| --- | --- | --- |
| `deep-research` | Research a question across the web and return sourced claims | `{ question: string, angles?: number, minSupport?: number }` — `angles` (default 4) is the number of distinct search queries. Results are raw sources; the parent checks them |

## Example

```json
{ "name": "deep-research", "args": { "question": "What are the tradeoffs of X vs Y?" } }
```

This is a `workflow` tool call, not a script — omit `script` entirely. The run
starts in the background exactly like the slash-command form; `background`,
`maxAgents`, `concurrency`, `agentRetries`, `agentTimeoutMs`, and `tokenBudget`
all still apply.

## Writing a new workflow instead

If the request is not deep-research, author a script with
`script` as usual — see the workflow-authoring skill.
