/** Validates script-supplied agent() options before the call reserves a slot. */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { AGENT_OPTIONS } from "../workflow-capability-contract.js";
const AGENT_OPTION_NAMES = AGENT_OPTIONS.options.map((option) => option.name);
const invalidOption = (message) => new WorkflowError(message, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
/**
 * Reject options the runtime would otherwise drop, so a misspelled or
 * unsupported key fails before dispatch instead of seeming to take effect.
 */
export function validateAgentOptions(options) {
    const accepted = `accepted options: ${AGENT_OPTION_NAMES.join(", ")}`;
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
        throw invalidOption(`agent() options must be an object; ${accepted}`);
    }
    const unknown = Object.keys(options).filter((key) => !AGENT_OPTION_NAMES.includes(key));
    if (unknown.length > 0) {
        throw invalidOption(`agent() does not accept ${unknown.map((key) => `"${key}"`).join(", ")}; ${accepted}`);
    }
}
/** The trimmed thread name, or undefined when the call is not threaded. */
export function normalizeThread(value) {
    if (value === undefined)
        return undefined;
    const thread = typeof value === "string" ? value.trim() : "";
    if (!thread)
        throw invalidOption("agent() thread must be a non-empty string");
    return thread;
}
/** Resolve a script-supplied cwd to its real path, so coding tools and agent identity agree. */
export function resolveAgentCwd(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !value.trim()) {
        throw invalidOption("agent cwd must be a non-empty absolute directory");
    }
    if (!isAbsolute(value))
        throw invalidOption("agent cwd must be an absolute directory");
    try {
        const resolved = realpathSync(value);
        if (!statSync(resolved).isDirectory())
            throw new Error("not a directory");
        return resolved;
    }
    catch {
        throw invalidOption(`agent cwd must be an existing directory: ${value}`);
    }
}
