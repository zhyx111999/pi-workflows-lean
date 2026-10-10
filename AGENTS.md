# Repository guidance

pi-workflows-lean is an independent fork of pi-dynamic-workflows 3.13.0. It does not follow upstream: do not merge, cherry-pick, or keep compatibility code for upstream changes.

Read [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) first: it maps every module and explains the main flow and the design decisions.

## Before finishing a change

- Run `npm test`; [CONTRIBUTING.md](CONTRIBUTING.md) lists what it checks.
- Write code, comments, and docs in English. Comments explain why, not history.
- Remove a feature completely: its callers, tests, docs, and skill guidance go in the same change.

## Capability contract and generated docs

- `src/workflow-capability-contract.ts` declares every workflow runtime global and `subagents` tool input; `runWorkflow` assembles the script globals from it. Change it together with the runtime or tool schema.
- Never hand-edit generated content. Run `npm run docs:generate` after a contract change and `npm run context:generate` after changing a tool prompt, tool schema text, or skill files.
- Keep detailed authoring guidance in the on-demand `workflow-authoring` skill, not in the always-on prompt or tool description. `tests/workflow-prompt-budget.test.ts` fails when an always-on surface grows; raise its budget only after reviewing the new wording.
- Do not copy live model routes or agent-type names into static guidance.
