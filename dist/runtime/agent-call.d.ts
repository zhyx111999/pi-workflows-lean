/** Implements agent(): validates a call, reserves its slot, then replays it from the journal or runs it live. */
import type { RunContext } from "./run-context.js";
/** Build the script's agent() global for this run. */
export declare function createAgent(ctx: RunContext): (prompt: string, agentOptions?: unknown) => Promise<unknown>;
