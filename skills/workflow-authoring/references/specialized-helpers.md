# Specialized helpers

Preserve candidate or work identity outside helper results that may omit failed agents.

## Iteration

| Helper | Authoring contract |
| --- | --- |
| `loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` | `round(index)` is zero-based. Defaults: `JSON.stringify` key, two dry rounds, 50 rounds. Null, non-array, and duplicate-only rounds are dry. Token-budget or agent-limit exhaustion returns the partial array without a termination reason; keep failed-round identity and stopping state outside the helper. |

## Control

| Helper | Authoring contract |
| --- | --- |
| `gate(thunk, validator, { attempts })` | Calls `thunk(feedback, attempt)` with initial `undefined` feedback and a zero-based attempt. `validator(value)` returns `{ ok, feedback? }`, synchronously or asynchronously; a bare boolean is not accepted. Three attempts by default. Returns `{ ok, value, attempts }`, including the last value on exhaustion. See [validated gate](../examples/validated-gate.js). |
| `checkpoint(prompt, options?)` | Journals a default decision. Runs are always background, so it returns `default` (`true` when omitted) or aborts when `headless: "abort"`; `kind`, `choices`, and `timeoutMs` are declared-only. |
| `checkpoint({ kind, checkpointId, payload })` | Durably suspends the run until a controller attaches a JSON response for that exact ID and resumes it; replay returns the journaled response. |

For durable checkpoints, use a stable, unique `checkpointId` and lossless JSON payload. The host controller calls `WorkflowManager.attachCheckpointResponse(runId, checkpointId, response)` before `resume(runId, { checkpointId })`; attachment alone does not restart execution. The response survives process restart. Do not catch checkpoint suspension to continue work: it remains a run-level pause, including inside helpers. This overload does not display a confirmation dialog or grant permission to perform external actions.

Always `await gate()`. A thunk containing `await` must itself be declared `async`; await `agent()` before adding its resolved value to a ledger. Runtime agent retries repeat recoverable execution failures; helper attempts are new semantic calls. Bound both layers and ledger exhaustion.
