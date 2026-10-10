<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->
# Workflow capability index

Contract format: `2.0.0`<br>
Contract content / skill / extension: `3.13.0-lean.1`

This compact generated index covers supported runtime globals and workflow-tool inputs. For constraints, compatibility behavior, internal boundaries, and dynamic-reference ownership, follow the [exhaustive generated facts](capability-details.md).

## Supported capability index

<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
| Name | Classification | Signature | Options and defaults |
| --- | --- | --- | --- |
| agent | runtime-global | `agent(prompt, options?) => Promise<string \| structured value \| null>` | `label`: string (optional; default: derived from phase and call count)<br>`phase`: string (optional; default: current phase)<br>`schema`: plain JSON Schema (optional)<br>`model`: string (optional)<br>`thinking`: "off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max" (optional)<br>`tier`: string (optional)<br>`isolation`: "worktree" \| false (optional)<br>`keepWorktree`: boolean (optional; default: true)<br>`cwd`: string (optional)<br>`thread`: string (optional)<br>`agentType`: string (optional)<br>`timeoutMs`: number \| null (optional; default: run timeout, finite ms in [1, 2^31-1]; null disables)<br>`retries`: number (optional; default: run retry count) |
| parallel | runtime-global | `parallel(thunks) => Promise<Array<unknown \| null>>` | — |
| pipeline | runtime-global | `pipeline(items, ...stages) => Promise<Array<unknown \| null>>` | — |
| checkpoint | runtime-global | `checkpoint({ kind, checkpointId, payload }) => Promise<unknown>` | — |
| log | runtime-global | `log(message) => void` | — |
| phase | runtime-global | `phase(title) => void` | — |
| args | runtime-global | `args: unknown` | — |
| cwd | runtime-global | `cwd: string` | — |
| process | runtime-global | `process: { cwd(): string }` | — |
| script | workflow-tool-input | `script?: string` | — |
| name | workflow-tool-input | `name?: string` | — |
| args | workflow-tool-input | `args?: unknown` | — |
| maxAgents | workflow-tool-input | `maxAgents?: number = 1000` | — |
| concurrency | workflow-tool-input | `concurrency?: number` | — |
| agentRetries | workflow-tool-input | `agentRetries?: number = configured value or 0` | — |
| agentTimeoutMs | workflow-tool-input | `agentTimeoutMs?: number = configured default or unbounded` | — |
| resumeFromRunId | workflow-tool-input | `resumeFromRunId?: string` | — |
<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
