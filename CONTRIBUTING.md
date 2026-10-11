# Contributing

pi-workflows-lean is a personal fork of pi-dynamic-workflows 3.13.0, maintained independently. It is not published to npm and does not take upstream updates.

## Checks

```bash
npm install
npm test
```

`npm test` runs exactly what CI runs:

1. `npm run check`: Biome lint and format check, then a type check of `scripts/`, `src/` and `tests/`.
2. `npm run docs:check`: fails when generated capability docs are stale.
3. `npm run context:check`: fails when the context-size measurement is stale.
4. `npm run test:unit`: compiles `src/` to `dist/` (the published extension tests load it), then runs the unit tests.

CI also runs `npm run check:dist`, which fails when the committed `dist/` differs from a fresh build.

Run one test file with `npx tsx --test --import ./tests/helpers/isolated-home.ts tests/<name>.test.ts`; the import keeps the test off your real home directory. `tests/extension-host-modules.test.ts` loads the built extension, so run `npm run build` before running it alone. After changing `src/`, run `npm run build` and `/reload` in Pi to load the new `dist/`. If Pi loads this same checkout, its dev dependencies include copies of Pi's own packages, and the extension resolves those instead of the running Pi's (Pi maps them only when the package has none of its own); keep the dev dependencies at the Pi version you run, or point Pi at a separate checkout installed with `npm install --omit=dev`.

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
