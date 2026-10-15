import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  createFauxCore,
  type FauxResponseStep,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * A model response withheld mid-stream: Pi has the message and its first
 * delta, and the rest of the response waits for `release()`.
 */
export interface StreamHold {
  /** Resolves once the response is streaming and held. */
  reached: Promise<void>;
  release(): void;
  /** @internal Used by the provider to withhold the stream. */
  hold(): Promise<void>;
}

export function streamHold(): StreamHold {
  let release!: () => void;
  let reach!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return {
    reached,
    release,
    hold: () => {
      reach();
      return released;
    },
  };
}

/** Forwards `source` to the caller, pausing after its first content delta until `hold` is released. */
function heldStream(source: AssistantMessageEventStream, hold: StreamHold): AssistantMessageEventStream {
  const held = createAssistantMessageEventStream();
  void (async () => {
    let paused = false;
    for await (const event of source) {
      held.push(event);
      if (!paused && event.type.endsWith("_delta")) {
        paused = true;
        await hold.hold();
      }
    }
    held.end();
  })();
  return held;
}

/** A real Pi session over a faux model that answers every turn with "ok". */
export interface RealSession {
  session: AgentSession;
  /** Every request the model received, in order. */
  contexts: Context[];
  /** The session's working directory (also its agent dir). */
  root: string;
}

/**
 * Run `drive` against a real AgentSession with only `extensionFactories`
 * installed and no network. `persist` gives the session a session file, which
 * delivery confirmation reads; otherwise it lives in memory. `responses` script
 * the model's replies in order (a function step may wait, to keep a turn in
 * flight); by default every turn answers "ok". `holds` keeps the response to
 * the request with that index (counting from 0) mid-stream.
 */
export async function withRealSession(
  options: {
    extensionFactories?: ExtensionFactory[];
    persist?: boolean;
    responses?: FauxResponseStep[];
    customTools?: ToolDefinition[];
    tools?: string[];
    holds?: Record<number, StreamHold>;
    /** Use this directory as the session's cwd and agent dir instead of a fresh temporary one. It is removed afterwards. */
    root?: string;
  },
  drive: (real: RealSession) => Promise<void>,
): Promise<Context[]> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "pi-dw-real-session-")));
  const provider = "fauxtest-real-session";
  const core = createFauxCore({ provider, models: [{ id: "faux-model" }] });
  const contexts: Context[] = [];
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
    modelRuntime.registerProvider(provider, {
      name: "Faux real session",
      baseUrl: "http://127.0.0.1:9/faux",
      apiKey: "faux-dummy-key-not-used",
      api: core.api,
      streamSimple: (model, context, streamOptions) => {
        const request = contexts.push(structuredClone(context)) - 1;
        const stream = core.streamSimple(model, context, streamOptions);
        const hold = options.holds?.[request];
        return hold ? heldStream(stream, hold) : stream;
      },
      models: core.models.map((model) => ({
        ...model,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      })),
    });
    core.setResponses(
      options.responses ?? Array.from({ length: 8 }, () => fauxAssistantMessage("ok", { stopReason: "stop" })),
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      extensionFactories: options.extensionFactories ?? [],
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime,
      model: core.getModel(),
      tools: options.tools ?? [],
      customTools: options.customTools,
      resourceLoader,
      sessionManager: options.persist
        ? SessionManager.create(root, join(root, "sessions"))
        : SessionManager.inMemory(root),
      settingsManager: SettingsManager.inMemory(),
    });
    try {
      await drive({ session, contexts, root });
    } finally {
      session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return contexts;
}
