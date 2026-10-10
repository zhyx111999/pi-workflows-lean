import { Check, Convert } from "typebox/value";
import { WorkflowError, WorkflowErrorCode } from "../errors.js";
import { throwIfProviderLimit } from "./provider-limit.js";
/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable, so it surfaces instead of a silent
 * null). `lastText` is injected so tests can drive it without a real session.
 */
export async function resolveStructuredOutput(session, capture, schema, options, lastText) {
    if (capture.called)
        return capture.value;
    const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
    // Restrict to the schema tool so the only useful next action is calling it
    // (takes effect on the next prompt turn). Best-effort.
    try {
        session.setActiveToolsByName?.(["structured_output"]);
    }
    catch {
        // ignore — the re-prompt alone still drives most models to comply
    }
    for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
        if (options.signal?.aborted)
            throw new Error("Subagent was aborted");
        await session.prompt("You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.");
    }
    if (capture.called)
        return capture.value;
    const extracted = extractValidated(lastText(session.messages), schema);
    if (extracted !== undefined) {
        console.warn("[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model");
        return extracted;
    }
    // A repair re-prompt can itself hit the provider limit. Surface that real,
    // resumable cause instead of a misleading SCHEMA_NONCOMPLIANCE.
    throwIfProviderLimit(session.messages, options.label);
    throw new WorkflowError("Subagent did not produce valid structured_output after repair attempts", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false, agentLabel: options.label });
}
/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated(text, schema) {
    const json = findJsonBlock(text);
    if (json === undefined)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return undefined;
    }
    try {
        const converted = Convert(schema, parsed);
        if (Check(schema, converted))
            return converted;
    }
    catch {
        // typebox can throw on exotic schemas; treat as no match.
    }
    return undefined;
}
/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1])
        return fence[1].trim();
    const start = text.search(/[{[]/);
    if (start === -1)
        return undefined;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === open)
            depth++;
        else if (text[i] === close && --depth === 0)
            return text.slice(start, i + 1);
    }
    return undefined;
}
/**
 * The newest non-blank assistant text anywhere in the turn. Deliberately
 * lenient: prose-JSON recovery may find the structured payload in any
 * assistant message, not only the terminal one.
 */
export function lastAssistantText(messages) {
    return assistantTextAfter(messages, -1);
}
/**
 * An unstructured agent's final answer: assistant text after the last tool
 * result. Earlier text is stale progress (the agent's last real action was a
 * tool call), so accepting it would report an incomplete run as successful and
 * suppress the AGENT_EMPTY_OUTPUT retry.
 */
export function finalAssistantText(messages) {
    return assistantTextAfter(messages, lastToolResultIndex(messages));
}
function lastToolResultIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "toolResult")
            return i;
    }
    return -1;
}
/** The newest non-blank assistant text strictly after index `after`, or "" when there is none. */
function assistantTextAfter(messages, after) {
    for (let i = messages.length - 1; i > after; i--) {
        const message = messages[i];
        if (message?.role !== "assistant" || !Array.isArray(message.content))
            continue;
        const text = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
        if (text.trim())
            return text;
    }
    return "";
}
