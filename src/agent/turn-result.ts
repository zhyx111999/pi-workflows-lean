// Derives a subagent turn's return value from its transcript: first that the turn completed, then the structured_output capture or the assistant text.
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { WorkflowError, WorkflowErrorCode, workflowAbortedError } from "../errors.js";
import type { StructuredOutputCapture } from "../structured-output.js";
import { lastAssistantError, throwIfProviderLimit } from "./provider-limit.js";

const REPAIR_PROMPT =
  "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.";

/** What a turn check needs: the caller's cancellation signal and the label its errors carry. */
export interface TurnCheckOptions {
  signal?: AbortSignal;
  label?: string;
}

/**
 * Throw unless the prompt() that just returned completed its turn. The SDK does
 * not throw for a cancelled or failed turn: it ends the turn with an assistant
 * message whose stopReason is "aborted" or "error", and that message can hold a
 * partial answer. So every prompt() is followed by this check before anything
 * it produced is accepted:
 * - cancelled: WORKFLOW_ABORTED;
 * - a provider usage/quota/rate limit: PROVIDER_USAGE_LIMIT, which pauses the run;
 * - any other provider error (a dropped connection, ...): a recoverable
 *   AGENT_EXECUTION_ERROR, so the attempt is retried instead of journaling a fragment.
 * `turnMessages` is the turn's own transcript.
 */
export function assertTurnCompleted(turnMessages: unknown[], options: TurnCheckOptions): void {
  const end = lastAssistantError(turnMessages);
  if (options.signal?.aborted || end?.stopReason === "aborted") throw workflowAbortedError();
  throwIfProviderLimit(turnMessages, options.label);
  if (end?.stopReason === "error") {
    throw new WorkflowError(
      end.errorMessage || "Subagent turn ended in a provider error",
      WorkflowErrorCode.AGENT_EXECUTION_ERROR,
      { recoverable: true, agentLabel: options.label },
    );
  }
}

/** The session surface the repair loop drives (a real AgentSession or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
}

/**
 * Resolve a schema agent's result after its first prompt passed
 * assertTurnCompleted. If the tool was called, return the captured value.
 * Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), checking each repair turn like the first, then try strict
 * schema-validated prose extraction, else throw SCHEMA_NONCOMPLIANCE
 * (non-recoverable, so it surfaces instead of a silent null). `turnMessages` is
 * the turn's own transcript; the caller keeps appending to it as repair turns run.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  turnMessages: unknown[],
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: TurnCheckOptions & { maxSchemaRetries?: number },
): Promise<T> {
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  // Restrict to the schema tool so the only useful next action is calling it
  // (takes effect on the next prompt turn). Best-effort.
  try {
    session.setActiveToolsByName?.(["structured_output"]);
  } catch {
    // ignore — the re-prompt alone still drives most models to comply
  }
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    await session.prompt(REPAIR_PROMPT);
    assertTurnCompleted(turnMessages, options);
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastAssistantText(turnMessages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/**
 * Last-resort structured-output recovery: find JSON in prose, coerce it toward
 * the schema, and accept it only if it then validates. Never fabricates —
 * returns undefined unless a parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(text: string, schema: TSchema): T | undefined {
  for (const candidate of jsonCandidates(text)) {
    const value = validatedJson<T>(candidate, schema);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Where a JSON payload can sit in an answer, most likely first: the whole text,
 * a fenced code block, then each balanced {...} or [...] in the prose. Lazy, so
 * the scan only runs when the cheaper candidates fail.
 */
function* jsonCandidates(text: string): Generator<string> {
  yield text;
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) yield fence[1];
  yield* balancedJsonSpans(text);
}

function validatedJson<T>(json: string, schema: TSchema): T | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * Each balanced {...} or [...] span, left to right. A bracket that closes with
 * the wrong kind or never closes was prose, not JSON, so the scan resumes right
 * after it and a payload behind a stray bracket is still found.
 */
function* balancedJsonSpans(text: string): Generator<string> {
  const opener = /[{[]/g;
  let match = opener.exec(text);
  while (match) {
    const end = closingBracketIndex(text, match.index);
    if (end !== -1) yield text.slice(match.index, end + 1);
    opener.lastIndex = end === -1 ? match.index + 1 : end + 1;
    match = opener.exec(text);
  }
}

/**
 * The index of the bracket that closes the one at `start`, or -1. Brackets inside
 * JSON strings, including after escaped quotes, do not count.
 */
function closingBracketIndex(text: string, start: number): number {
  const expected: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      expected.push("}");
    } else if (char === "[") {
      expected.push("]");
    } else if (char === "}" || char === "]") {
      if (expected.pop() !== char) return -1;
      if (expected.length === 0) return i;
    }
  }
  return -1;
}

/**
 * The newest non-blank assistant text anywhere in the turn. Deliberately
 * lenient: prose-JSON recovery may find the structured payload in any
 * assistant message, not only the terminal one.
 */
export function lastAssistantText(messages: unknown[]): string {
  return assistantTextAfter(messages, -1);
}

/**
 * An unstructured agent's final answer: assistant text after the last tool
 * result. Earlier text is stale progress (the agent's last real action was a
 * tool call), so accepting it would report an incomplete run as successful and
 * suppress the AGENT_EMPTY_OUTPUT retry.
 */
export function finalAssistantText(messages: unknown[]): string {
  return assistantTextAfter(messages, lastToolResultIndex(messages));
}

function lastToolResultIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string } | undefined)?.role === "toolResult") return i;
  }
  return -1;
}

/** The newest non-blank assistant text strictly after index `after`, or "" when there is none. */
function assistantTextAfter(messages: unknown[], after: number): string {
  for (let i = messages.length - 1; i > after; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    // A message that ended in an error or abort holds a fragment, never an
    // answer. The SDK leaves one in the turn when it retries a request itself.
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const text = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}
