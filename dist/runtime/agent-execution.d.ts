/** Runs a live agent() call under the concurrency limit: its worktree, usage accounting, retries and journaling. */
import type { TSchema } from "typebox";
import type { AgentDefinition } from "../agent-registry.js";
import type { AgentOptions } from "../workflow.js";
import type { FanoutBatch } from "./fanout.js";
import { type RunContext } from "./run-context.js";
/** A validated agent() call with its reserved slot, resume identity and display state. */
export interface AgentCall {
    readonly prompt: string;
    readonly options: AgentOptions;
    readonly definition: AgentDefinition | undefined;
    readonly isolation: "worktree" | undefined;
    /** Script-requested cwd, already resolved to its real path. */
    readonly cwd: string | undefined;
    readonly phase: string | undefined;
    readonly label: string;
    /** Explicit, definition or phase model; undefined lets the agent layer pick (tier or default). */
    readonly modelSpec: string | undefined;
    /** Lexical call index, the journal key. */
    readonly index: number;
    readonly hash: string;
    /** Per-call id carried by every onAgent* event and used as the store delta key. */
    readonly id: string;
    /** The enclosing fan-out, whose breach cancels this call while it is still queued. */
    readonly batch: FanoutBatch | undefined;
    /**
     * What /workflows shows as the model: first a guess (this call's spec, else the
     * session's main model), then the real model once the agent layer resolves it.
     */
    displayModel: string | undefined;
}
/** A string result that is blank means the subagent produced no answer at all. */
export declare function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean;
export declare function runLiveAgent(ctx: RunContext, call: AgentCall): Promise<unknown>;
