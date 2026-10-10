---
name: subagents-setup
description: Install and configure pi-workflows-lean subagents. Use when the user wants to set up subagents, change subagent models or tiers, concurrency, retries, timeouts, max agents, or the progress panel, define agent roles, or save a reusable workflow.
metadata:
  version: "3.13.0-lean.1"
---

# Subagents setup

Edit these files for the user. Every file is optional; invalid values are ignored.

**Install:** `pi install git:github.com/zhyx111999/pi-workflows-lean`, then `/reload`. The repo is private, so git needs credentials, e.g. SSH: `git:git@github.com:zhyx111999/pi-workflows-lean`.

**`<key>`:** project folder name in lowercase with runs of characters outside `a-z0-9._-` turned into `-`, then `-`, then the first 12 hex digits of SHA-256 of the absolute project path. After a first run it exists under `~/.pi/workflows/projects/`.

## Model tiers

`~/.pi/workflows/model-tiers.json`; `~/.pi/workflows/projects/<key>/model-tiers.json` overrides per tier.

```json
{ "tiers": { "small": "<provider>/<model>:low", "medium": "<provider>/<model>", "big": "<provider>/<model>:high" } }
```

Suffix sets thinking: `off|minimal|low|medium|high|xhigh|max`. An empty value voids the file. Untiered subagents use `medium`.

## settings.json

Later files win per key: `~/.pi/workflows/settings.json`, `<project>/.pi/workflows/settings.json`, `~/.pi/workflows/projects/<key>/settings.json`.

| Key | Default | Meaning |
|---|---|---|
| `defaultConcurrency` | 8 (≤16) | parallel subagents |
| `defaultAgentRetries` | 0 (≤3) | retries after recoverable failures |
| `defaultAgentTimeoutMs` | none | ms per subagent; `null` clears an earlier file |
| `defaultMaxAgents` | 1000 | subagents per run |
| `progressPanelMode` | `"compact"` | or `"detailed"` |
| `progressPanelMaxAgents` | 8 | agents per phase when detailed |
| `persistAgentSessions` | false | keep subagent transcripts as Pi sessions |
| `inheritMainModel` | false | untiered subagents use the main model |
| `deliveredResultMaxChars` | 400 | cap on a result's JSON fallback |
| `excludeSubagentTools` | [] | extra tools denied to subagents |
| `providerMiddlewareExtensions` | [] | trusted provider/auth extensions for subagents |

## Agent roles

`<project>/.pi/agents/<name>.md` wins over `~/.pi/agent/agents/<name>.md` (old `~/.pi/agents/` still read). Scripts use `agentType: "<name>"`. All fields are optional; `name` defaults to the file name.

```markdown
---
description: One line
tools: read, bash
disallowedTools: write
model: <provider>/<model>
thinking: high
isolation: worktree
---
Role instructions.
```

## Saved workflows

`~/.pi/workflows/saved/<name>.json`; `~/.pi/workflows/projects/<key>/saved/<name>.json` wins.

```json
{ "name": "<name>", "description": "One line", "script": "<workflow script>" }
```

`name` equals the file name, without spaces or slashes. Write `script` per the workflow-authoring skill; `"scriptPath": "<file>.js"` in the same folder can replace it. Run with the `subagents` tool's `name` and `args`.

## When changes apply

- Next `subagents` run: tiers, roles, saved scripts, run limits.
- Live: progress panel; `deliveredResultMaxChars` on the next result.
- After `/reload` or a new session: the other settings, run limits for slash-command runs, a new saved workflow's `/<name>`, and plugin updates.
