import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { type StructuredOutputCapture } from "../structured-output.js";
/**
 * Orchestration tools always denied to workflow subagents. The extension
 * registers `subagents` and `subagents_control` globally, so a subagent would
 * otherwise see them and start or steer background runs of its own. Those
 * nested runs fan out recursively outside the parent run's maxAgents,
 * concurrency, progress, and accounting, and can drain a shared provider quota.
 */
export declare const DEFAULT_EXCLUDED_SUBAGENT_TOOLS: string[];
/**
 * The full denylist: the always-on defaults, then names set on the injected
 * session options, then the caller's extra names. The defaults come first so
 * no option can drop them; the SDK dedupes overlap.
 */
export declare function subagentExcludedTools(extra?: string[], sessionExclude?: string[]): string[];
export interface SubagentToolRequest {
    /** Coding tools bound to the call's working directory. */
    codingTools: ToolDefinition[];
    /** Extra per-call tools, subject to the tool policy. */
    tools?: ToolDefinition[];
    toolNames?: string[];
    disallowedToolNames?: string[];
    /** Tools added after the policy, so an allowlist cannot remove them (e.g. shared-store tools). */
    systemTools?: ToolDefinition[];
    schema?: TSchema;
    capture: StructuredOutputCapture<any>;
}
/**
 * The custom tools for one call. The agent type's policy runs before
 * structured_output is added, so a restrictive allowlist never strips the
 * schema tool.
 */
export declare function buildSubagentTools(request: SubagentToolRequest): ToolDefinition[];
