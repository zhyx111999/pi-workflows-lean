import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

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
 * delivery confirmation reads; otherwise it lives in memory.
 */
export async function withRealSession(
  options: { extensionFactories?: ExtensionFactory[]; persist?: boolean },
  drive: (real: RealSession) => Promise<void>,
): Promise<Context[]> {
  const root = await mkdtemp(join(tmpdir(), "pi-dw-real-session-"));
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
        contexts.push(structuredClone(context));
        return core.streamSimple(model, context, streamOptions);
      },
      models: core.models.map((model) => ({
        ...model,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      })),
    });
    core.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("ok", { stopReason: "stop" })));
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
      tools: [],
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
