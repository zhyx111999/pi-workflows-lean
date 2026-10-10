# Checkpoints

| Form | Authoring contract |
| --- | --- |
| `checkpoint(prompt, options?)` | Journals a default decision. Runs are always background, so it returns `default` (`true` when omitted) or aborts when `headless: "abort"`; `kind`, `choices`, and `timeoutMs` are declared-only. |
| `checkpoint({ kind, checkpointId, payload })` | Durably suspends the run until a controller attaches a JSON response for that exact ID and resumes it; replay returns the journaled response. |

For durable checkpoints, use a stable, unique `checkpointId` and lossless JSON payload. The host controller calls `WorkflowManager.attachCheckpointResponse(runId, checkpointId, response)` before `resume(runId, { checkpointId })`; attachment alone does not restart execution. The response survives process restart. Do not catch checkpoint suspension to continue work: it remains a run-level pause. This form does not display a confirmation dialog or grant permission to perform external actions.
