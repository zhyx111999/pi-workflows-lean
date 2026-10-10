/** Validates script-supplied agent() options before the call reserves a slot. */
import type { AgentOptions } from "../workflow.js";
/**
 * Reject options the runtime would otherwise drop, so a misspelled or
 * unsupported key fails before dispatch instead of seeming to take effect.
 */
export declare function validateAgentOptions(options: unknown): asserts options is AgentOptions;
/** The trimmed thread name, or undefined when the call is not threaded. */
export declare function normalizeThread(value: unknown): string | undefined;
/** Resolve a script-supplied cwd to its real path, so coding tools and agent identity agree. */
export declare function resolveAgentCwd(value: unknown): string | undefined;
