import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { lastAssistantError, throwIfProviderLimit } from "../src/agent/provider-limit.js";
import {
  assertTurnCompleted,
  extractValidated,
  finalAssistantText,
  lastAssistantText,
  resolveStructuredOutput,
  type StructuredSession,
} from "../src/agent/turn-result.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { StructuredOutputCapture } from "../src/structured-output.js";

const Schema = Type.Object({ word: Type.String() });
const USAGE_LIMIT = "Codex usage limit reached. Resets in ~3h.";

function assistant(text: string, end: { stopReason?: string; errorMessage?: string } = {}) {
  return { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason: "stop", ...end };
}

function isWorkflowError(code: WorkflowErrorCode, recoverable: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof WorkflowError, `expected a WorkflowError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.recoverable, recoverable);
    return true;
  };
}

describe("extractValidated", () => {
  it("extracts a fenced ```json block that validates", () => {
    assert.deepEqual(extractValidated('blah\n```json\n{"word":"hi"}\n```\nmore', Schema), { word: "hi" });
  });

  it("extracts a bare {...} object embedded in prose", () => {
    assert.deepEqual(extractValidated('here it is: {"word":"hi"} done', Schema), { word: "hi" });
  });

  it("coerces types toward the schema, then validates", () => {
    const NumSchema = Type.Object({ n: Type.Number() });
    assert.deepEqual(extractValidated('{"n":"5"}', NumSchema), { n: 5 });
  });

  it("returns undefined for prose with no JSON", () => {
    assert.equal(extractValidated("there is no json here", Schema), undefined);
  });

  it("returns undefined when the JSON does not satisfy the schema (no fabrication)", () => {
    assert.equal(extractValidated('{"notWord": 1}', Schema), undefined);
  });

  it("returns undefined for malformed JSON", () => {
    assert.equal(extractValidated("{word: ", Schema), undefined);
  });

  it("ignores brackets inside JSON strings", () => {
    assert.deepEqual(extractValidated('result: {"word":"a } character"} done', Schema), { word: "a } character" });
    assert.deepEqual(extractValidated('see {"word":"[ unclosed"} above', Schema), { word: "[ unclosed" });
  });

  it("honors escaped quotes and backslashes inside JSON strings", () => {
    assert.deepEqual(extractValidated('answer: {"word":"say \\"}\\" now"}.', Schema), { word: 'say "}" now' });
    assert.deepEqual(extractValidated('answer: {"word":"ends in \\\\"} ok', Schema), { word: "ends in \\" });
  });

  it("parses an answer that is entirely JSON before looking for fences or brackets", () => {
    assert.deepEqual(extractValidated('{"word":"use ```json fences```"}', Schema), { word: "use ```json fences```" });
  });

  it("finds the payload behind a stray or mismatched bracket in the prose", () => {
    assert.deepEqual(extractValidated('See [1] and { this note: {"word":"hi"}', Schema), { word: "hi" });
    assert.deepEqual(extractValidated('a [ mismatched } pair, then {"word":"hi"}', Schema), { word: "hi" });
  });
});

describe("assertTurnCompleted", () => {
  it("accepts a turn that ended normally, even when its text mentions a rate limit", () => {
    assert.doesNotThrow(() => assertTurnCompleted([assistant("I handled the rate limit gracefully")], {}));
    assert.doesNotThrow(() => assertTurnCompleted([], {}));
  });

  it("rejects a cancelled turn as WORKFLOW_ABORTED", () => {
    const controller = new AbortController();
    controller.abort();
    assert.throws(
      () => assertTurnCompleted([assistant("finished anyway")], { signal: controller.signal }),
      isWorkflowError(WorkflowErrorCode.WORKFLOW_ABORTED, true),
    );
    assert.throws(
      () => assertTurnCompleted([assistant("half an ans", { stopReason: "aborted" })], {}),
      isWorkflowError(WorkflowErrorCode.WORKFLOW_ABORTED, true),
    );
  });

  it("rejects a provider limit as a non-recoverable PROVIDER_USAGE_LIMIT", () => {
    assert.throws(
      () => assertTurnCompleted([assistant("", { stopReason: "error", errorMessage: USAGE_LIMIT })], { label: "l" }),
      (error: unknown) => {
        isWorkflowError(WorkflowErrorCode.PROVIDER_USAGE_LIMIT, false)(error);
        assert.equal((error as WorkflowError).resetHint, "Resets in ~3h");
        assert.equal((error as WorkflowError).agentLabel, "l");
        return true;
      },
    );
  });

  it("rejects any other provider error as a recoverable AGENT_EXECUTION_ERROR with the provider message", () => {
    const failed = [assistant("half an ans", { stopReason: "error", errorMessage: "socket disconnected" })];
    assert.throws(
      () => assertTurnCompleted(failed, { label: "l" }),
      (error: unknown) => {
        isWorkflowError(WorkflowErrorCode.AGENT_EXECUTION_ERROR, true)(error);
        assert.equal((error as WorkflowError).message, "socket disconnected");
        assert.equal((error as WorkflowError).agentLabel, "l");
        return true;
      },
    );
  });

  it("judges the turn by its last assistant message, so a request the SDK retried successfully passes", () => {
    const retried = [assistant("half", { stopReason: "error", errorMessage: "socket hang up" }), assistant("full")];
    assert.doesNotThrow(() => assertTurnCompleted(retried, {}));
  });
});

describe("assistant text never comes from a failed message", () => {
  it("skips the fragment left by a request the SDK retried or aborted", () => {
    const retried = [assistant("half an ans", { stopReason: "error", errorMessage: "socket hang up" }), assistant("")];
    assert.equal(finalAssistantText(retried), "");
    assert.equal(lastAssistantText(retried), "");
    assert.equal(lastAssistantText([assistant('{"word":"cut', { stopReason: "aborted" })]), "");
  });
});

describe("resolveStructuredOutput", () => {
  const opts = { maxSchemaRetries: 2 };
  type Capture = StructuredOutputCapture<{ word: string }>;

  /** A repair session whose prompts append each scripted reply to the turn transcript. */
  function makeSession(
    replies: Array<(capture: Capture) => unknown> = [],
    turnMessages: unknown[] = [],
  ): { session: StructuredSession; turnMessages: unknown[]; capture: Capture; prompts: () => number } {
    let prompts = 0;
    const capture: Capture = { called: false, value: undefined };
    const session: StructuredSession = {
      async prompt() {
        const reply = replies[prompts++];
        turnMessages.push(reply ? reply(capture) : assistant(""));
      },
      setActiveToolsByName() {},
    };
    return { session, turnMessages, capture, prompts: () => prompts };
  }

  function callsTool(capture: Capture) {
    capture.called = true;
    capture.value = { word: "ok" };
    return { role: "assistant", content: [{ type: "toolCall", name: "structured_output" }], stopReason: "toolUse" };
  }

  it("returns the captured value without re-prompting when already called", async () => {
    const { session, turnMessages, capture, prompts } = makeSession();
    capture.called = true;
    capture.value = { word: "done" };
    assert.deepEqual(await resolveStructuredOutput(session, turnMessages, capture, Schema, opts), { word: "done" });
    assert.equal(prompts(), 0, "no repair prompts when already called");
  });

  it("recovers via a bounded repair re-prompt", async () => {
    const { session, turnMessages, capture, prompts } = makeSession([callsTool]);
    assert.deepEqual(await resolveStructuredOutput(session, turnMessages, capture, Schema, opts), { word: "ok" });
    assert.equal(prompts(), 1, "one repair prompt recovered it");
  });

  it("falls back to strict prose extraction from the turn transcript when repair fails", async () => {
    const { session, turnMessages, capture } = makeSession([], [assistant('{"word":"fromProse"}')]);
    const r = await resolveStructuredOutput(session, turnMessages, capture, Schema, opts);
    assert.deepEqual(r, { word: "fromProse" });
  });

  it("throws SCHEMA_NONCOMPLIANCE when repair and extraction both fail", async () => {
    const { session, turnMessages, capture } = makeSession([], [assistant("no json at all")]);
    await assert.rejects(
      () => resolveStructuredOutput(session, turnMessages, capture, Schema, opts),
      isWorkflowError(WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, false),
    );
  });

  it("surfaces a provider limit hit during repair instead of returning earlier prose JSON", async () => {
    const { session, turnMessages, capture, prompts } = makeSession(
      [() => assistant("", { stopReason: "error", errorMessage: USAGE_LIMIT })],
      [assistant('{"word":"stale"}')],
    );
    await assert.rejects(
      () => resolveStructuredOutput(session, turnMessages, capture, Schema, opts),
      isWorkflowError(WorkflowErrorCode.PROVIDER_USAGE_LIMIT, false),
    );
    assert.equal(prompts(), 1, "no further repair prompt after the limit");
  });

  it("retries a repair turn that ended in another provider error instead of returning earlier prose JSON", async () => {
    const { session, turnMessages, capture } = makeSession(
      [() => assistant('{"word":"cut', { stopReason: "error", errorMessage: "socket disconnected" })],
      [assistant('{"word":"stale"}')],
    );
    await assert.rejects(
      () => resolveStructuredOutput(session, turnMessages, capture, Schema, opts),
      isWorkflowError(WorkflowErrorCode.AGENT_EXECUTION_ERROR, true),
    );
  });

  it("rejects when the last repair turn is cancelled instead of returning earlier prose JSON", async () => {
    const controller = new AbortController();
    const { session, turnMessages, capture } = makeSession(
      [
        () => assistant("still prose"),
        () => {
          controller.abort();
          return assistant("", { stopReason: "aborted" });
        },
      ],
      [assistant('{"word":"stale"}')],
    );
    await assert.rejects(
      () => resolveStructuredOutput(session, turnMessages, capture, Schema, { ...opts, signal: controller.signal }),
      isWorkflowError(WorkflowErrorCode.WORKFLOW_ABORTED, true),
    );
  });

  it("does not accept a value captured by a repair turn that was then cancelled", async () => {
    const controller = new AbortController();
    const { session, turnMessages, capture } = makeSession([
      (turnCapture) => {
        const message = callsTool(turnCapture);
        controller.abort();
        return message;
      },
    ]);
    await assert.rejects(
      () => resolveStructuredOutput(session, turnMessages, capture, Schema, { ...opts, signal: controller.signal }),
      isWorkflowError(WorkflowErrorCode.WORKFLOW_ABORTED, true),
    );
  });
});

describe("lastAssistantError / throwIfProviderLimit", () => {
  it("reads stopReason/errorMessage off the most recent assistant message", () => {
    const messages = [
      { role: "user", content: [] },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
    ];
    assert.deepEqual(lastAssistantError(messages), { stopReason: "error", errorMessage: "boom" });
  });

  it("throws PROVIDER_USAGE_LIMIT only when stopReason is error AND the message matches a limit", () => {
    assert.throws(
      () =>
        throwIfProviderLimit(
          [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "usage limit reached. Resets in ~3h.",
            },
          ],
          "lbl",
        ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
        assert.equal((err as { resetHint?: string }).resetHint, "Resets in ~3h");
        assert.equal((err as { agentLabel?: string }).agentLabel, "lbl");
        return true;
      },
    );
  });

  it("does not throw for a successful turn whose text merely mentions 'rate limit'", () => {
    assert.doesNotThrow(() =>
      throwIfProviderLimit([
        {
          role: "assistant",
          content: [{ type: "text", text: "I handled the rate limit gracefully" }],
          stopReason: "stop",
        },
      ]),
    );
  });

  it("does not throw for a non-limit error turn", () => {
    assert.doesNotThrow(() =>
      throwIfProviderLimit([{ role: "assistant", content: [], stopReason: "error", errorMessage: "network blip" }]),
    );
  });
});
