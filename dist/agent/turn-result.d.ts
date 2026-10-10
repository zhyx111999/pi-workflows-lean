import type { TSchema } from "typebox";
import type { StructuredOutputCapture } from "../structured-output.js";
/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
    prompt(text: string): Promise<void>;
    setActiveToolsByName?(names: string[]): void;
    messages: unknown[];
}
/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable, so it surfaces instead of a silent
 * null). `lastText` is injected so tests can drive it without a real session.
 */
export declare function resolveStructuredOutput<T>(session: StructuredSession, capture: StructuredOutputCapture<T>, schema: TSchema, options: {
    maxSchemaRetries?: number;
    signal?: AbortSignal;
    label?: string;
}, lastText: (messages: unknown[]) => string): Promise<T>;
/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export declare function extractValidated<T>(text: string, schema: TSchema): T | undefined;
/**
 * The newest non-blank assistant text anywhere in the turn. Deliberately
 * lenient: prose-JSON recovery may find the structured payload in any
 * assistant message, not only the terminal one.
 */
export declare function lastAssistantText(messages: unknown[]): string;
/**
 * An unstructured agent's final answer: assistant text after the last tool
 * result. Earlier text is stale progress (the agent's last real action was a
 * tool call), so accepting it would report an incomplete run as successful and
 * suppress the AGENT_EMPTY_OUTPUT retry.
 */
export declare function finalAssistantText(messages: unknown[]): string;
