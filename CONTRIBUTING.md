# Contributing

pi-workflows-lean is a personal fork of pi-dynamic-workflows 3.13.0, maintained independently. It is not published to npm and does not take upstream updates.

## Checks

```bash
npm install
npm test
```

`npm test` runs exactly what CI runs:

1. `npm run check`: Biome lint and format check, then a type check of `scripts/` and `src/`.
2. `npm run build`: compiles `src/` to `dist/`, which the Pi extension entry loads.
3. `npm run docs:check`: fails when generated capability docs are stale.
4. `npm run context:check`: fails when the context-size measurement is stale.
5. `npm run test:unit`: unit tests with fake agents.

Run one test file with `npx tsx --test tests/<name>.test.ts`. After changing `src/`, run `npm run build` and `/reload` in Pi to load the new `dist/`.

## Generated files

| After changing | Run | Rewrites |
| --- | --- | --- |
| `src/workflow-capability-contract.ts` | `npm run docs:generate` | the capability table in `README.md` and `docs/workflow-authoring.md`, and `skills/workflow-authoring/references/capabilities.md` and `capability-details.md` |
| the `subagents` or `subagents_control` tool prompt or schema text, any skill file, or `pi.skills` | `npm run context:generate` | `docs/workflow-context-surfaces.json` |

Commit generated files in the same commit as the change that produced them.

## Runtime changes

- Keep the contract equal to the runtime. `tests/workflow-capability-contract.test.ts` compares the declared globals with what `runWorkflow` injects and the declared tool inputs with the `subagents` tool schema.
- Fake-agent tests do not exercise the real SDK path. When a change affects how agents run (retries, timeouts, model routing, token accounting, concurrency, resume), also try it in a real Pi session.
- Settings in `~/.pi/workflows/settings.json` are user data: new settings must be optional, and settings files that still contain removed keys must keep loading. Document new settings and tool parameters in `README.md`.

## Commits

- Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- Keep one concern per commit, with its tests and generated files.
- Format with `npm run format`; do not reformat files you are not otherwise changing.
