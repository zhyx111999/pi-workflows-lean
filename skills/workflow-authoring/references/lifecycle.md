# Lifecycle, limits, and resume

## Bounds

Set finite bounds that match the work for `maxAgents`, `concurrency`, and `agentRetries`; bound loops and semantic retries inside the script. `maxAgents` counts logical `agent()` and `checkpoint()` calls. Agent execution retries do not add slots, but every attempt of a script-level loop or semantic retry is a new `agent()` call and does. Treat an invocation-level `agentTimeoutMs` as an opt-in user constraint, not a precautionary default. An omitted `agentTimeoutMs` uses the configured `defaultAgentTimeoutMs` and is otherwise unbounded. Token usage is measured and reported, never capped.

## Checkpoints

A checkpoint consumes an agent slot but no tokens. Every workflow run starts in the background and the `workflow` tool ignores `background`, so the prompt overload `checkpoint(prompt, options?)` never reaches a human: it returns the declared `default` (or `true` when omitted), or aborts the run when `headless: "abort"` is selected. Use it only to record a deliberate default decision. `kind`, `choices`, and `timeoutMs` are declared but have no effect beyond resume identity.

The durable `checkpoint({ kind, checkpointId, payload })` overload instead pauses the run until a host controller persists a response and resumes the exact checkpoint ID. It does not choose a headless default or display UI. See [checkpoints](checkpoint.md) for the controller handoff and replay contract.

Checkpoint answers are journaled and can replay during an unchanged resume prefix. Do not describe checkpoints as guaranteed arbitrary forms or as remote steering.

## Retry and recoverable failure

Recoverable execution failures retry according to the per-agent option or invocation-time tool input, then return `null`. Nonrecoverable failures throw without becoming `null`. A semantic retry written as a script loop is separate: each attempt is a new agent call, and the script must record and handle exhaustion itself.

Always retain `{ id, status, result }` or an equivalent ledger for each intended work unit. Filtering `null` before recording identity turns an execution failure into invisible missing coverage.

`AGENT_EMPTY_OUTPUT` (whitespace-only text from a schema-less call) is recoverable and retries like any other transient failure. Some models occasionally produce it on an otherwise-working first attempt; a fleet built on such a model should set `agentRetries: 1-2` rather than treat one occurrence as a failed run. A `schema` call never trips this check — schema noncompliance is its own, nonrecoverable failure (see [serialization](#serialization)).

## Resume

Resume replays only the longest unchanged prefix of journaled calls. Once one call is new, changed, or unusable, that call and all later calls execute live. Stable lexical call ordering, prompts, labels, routing options, and inputs therefore matter. Semantic retry loops can cascade after an upstream miss.

Only a call that finishes with a real result is journaled. A call whose every attempt was recoverable (including one that only ever produced `AGENT_EMPTY_OUTPUT`) contributes no journal entry, so resuming that run reruns exactly that call and everything lexically after it live; the earlier, already-succeeded prefix still replays from cache.

The runtime blocks common accidental nondeterminism, but this is not a security boundary. Pass timestamps, randomness, and external decisions through `args`.

## Serialization

The workflow's explicit return value crosses the tool boundary. Keep it JSON-serializable and preserve coverage ledgers in the returned data. Structured agent schemas must be plain JSON Schema. Schema success guarantees the downstream field shape expected by JavaScript; without a schema, treat output as text or `null`. A prompt that asks the model to "return JSON" does not change this — without `schema`, parse and validate that text defensively before reading a field, and ledger an unparseable result instead of reading `undefined` off it (see [defensive text parsing](focused-recipes.md)).
