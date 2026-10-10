import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BUILTIN_WORKFLOW_NAMES, resolveWorkflowInvocation } from "./builtin-workflows.js";
import { renderWorkflowText, type WorkflowSnapshot } from "./display.js";
import { parseWorkflowScript } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";
import { loadWorkflowSettings, workflowRunLimits } from "./workflow-settings.js";

/** The single always-on gate that authorizes workflow use without forcing it. */
export const WORKFLOW_GATE_GUIDELINE =
  "workflow runs a script's agent(), parallel(), and pipeline() calls as background subagents. Whether to call it is decided by the note appended to the user message.";

const workflowToolSchema = Type.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Raw JavaScript workflow script, with no Markdown fences. Required unless `name` is given.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Add phases: [{ title: 'Phase' }] only when the workflow has named phases, and declare only phases it will use. With multiple phases, call phase('Exact Title') before each phase's work or set `phase` in the agent options.",
        "Subagents only do the task in the agent() prompt. Do not add a follow-up subagent to cross-check results.",
        "agent(prompt, { label, tier: 'small'|'medium'|'big', model, thinking, schema }). Untagged agents use the medium tier. An explicit model overrides tier. thinking is off|minimal|low|medium|high|xhigh|max and is separate from tier.",
        "The optional `agentType` option selects a named user or project definition that can bind tools, a model, and role instructions; use it only when its name and purpose are provided in context. Its bound model overrides `tier`; an explicit `model` overrides both.",
        "Use plain JavaScript only; imports, require(), filesystem modules, Date.now(), Math.random(), and new Date() are unavailable.",
        "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, cwd, and process.cwd(). The workflow must call agent() at least once.",
        "parallel() requires functions, not promises, and returns results in input order: await parallel(items.map(item => () => agent(...))).",
        "pipeline(items, ...stages) runs stages sequentially for each item while items proceed concurrently; each stage receives (previousValue, originalItem, index).",
      ].join(" "),
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Run a saved or built-in workflow by name instead of `script`; its args go in `args`. " +
        `Built-ins: ${BUILTIN_WORKFLOW_NAMES.join(", ")} — see the workflow-patterns skill for each one's args. ` +
        "A same-named saved workflow wins. Not combinable with resumeFromRunId.",
    }),
  ),
  args: Type.Optional(
    // Must be an explicitly typed object schema, not Type.Any(). Type.Any()
    // compiles to a schema with no "type" keyword at all (just
    // `{ description }`), and at least one MCP/tool-calling bridge observed
    // in the wild does not treat a typeless property as "accept any JSON
    // value" — it coerces/flattens it before the handler ever sees it, so
    // `args.scope` (etc.) arrives as `undefined` and every built-in pattern
    // that requires an args field fails validation regardless of what the
    // caller actually sent. Every built-in pattern's `args` is a JSON object
    // at the top level, so declaring `type: "object"` is lossless and fixes
    // the coercion. Type.Unsafe keeps the emitted schema minimal (no
    // `properties`/`additionalProperties` boilerplate — JSON Schema already
    // allows additional properties by default) to stay inside the
    // provider-visible tool definition's byte budget.
    Type.Unsafe<Record<string, unknown>>({
      type: "object",
      description: "Optional JSON value exposed to the workflow script as global `args`.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Ignored. Workflows always run in the background: the tool returns a run ID, this turn ends, and the result is delivered back when the run finishes.",
    }),
  ),
  resumeFromRunId: Type.Optional(
    Type.String({
      description: [
        "Resume a prior run (this ID) with an edited `script` instead of starting a new run.",
        "Unchanged agent() calls replay from that run's cache; the first changed/new call onward re-runs.",
        "Calls match by position: keep earlier good calls identical and in order. Always background.",
      ].join(" "),
    }),
  ),
});

/**
 * `details` of a workflow tool result: the started or resumed run. Results from
 * earlier blocking runs, still stored in session files, carry a full snapshot.
 */
type WorkflowToolDetails = { runId: string; background: true; resumedFrom?: string } | WorkflowSnapshot;

export type WorkflowToolInput = {
  script?: string;
  name?: string;
  args?: Record<string, unknown>;
  background?: boolean;
  resumeFromRunId?: string;
};

export interface WorkflowToolOptions {
  cwd?: string;
  /** Shared manager so background runs are reachable from the `/workflows` command. */
  manager?: WorkflowManager;
  /**
   * Live manager accessor. Prefer this over a closed-over `manager` when the
   * extension may replace the manager after session_start (cross-project resume).
   * Falls back to `manager` / a freshly constructed default.
   */
  getManager?: () => WorkflowManager;
  /** Shared saved-workflow storage. */
  storage?: WorkflowStorage;
  /** Live storage accessor; same rationale as getManager. */
  getStorage?: () => WorkflowStorage;
  /** Live project cwd for name-resolution / settings. */
  getCwd?: () => string;
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition<typeof workflowToolSchema, any> {
  const fallbackCwd = options.cwd ?? process.cwd();
  const fallbackStorage = options.storage ?? createWorkflowStorage(fallbackCwd);
  // Lazy (audit2 #38): WorkflowManager's constructor scans — and on stale-run
  // recovery, REWRITES — the cwd's run store. Callers that only need the
  // tool's schema/description (context measurement, contract tests) must not
  // touch the developer's real global store as a side effect.
  let fallbackManager: WorkflowManager | undefined;
  const getManager = () => {
    const provided = options.getManager?.() ?? options.manager;
    if (provided) return provided;
    if (!fallbackManager) {
      fallbackManager = new WorkflowManager({
        // Bind to the factory-time cwd, not a re-read of process.cwd() at
        // execute time (r1 NIT: split-brain with fallbackStorage).
        cwd: options.cwd ?? fallbackCwd,
        ...workflowRunLimits(loadWorkflowSettings({ cwd: fallbackCwd })),
      });
    }
    return fallbackManager;
  };
  const getStorage = () => options.getStorage?.() ?? fallbackStorage;
  const getCwd = () => options.getCwd?.() ?? fallbackCwd;

  return defineTool<typeof workflowToolSchema, WorkflowToolDetails>({
    name: "workflow",
    label: "Workflow",
    description:
      "Run a JavaScript workflow that delegates work to subagents with agent(), optionally composing calls with parallel() and pipeline().",
    promptSnippet:
      "Delegate substantive independent or staged work to subagents with a JavaScript workflow, optionally composing agent calls with parallel(), pipeline(), or both",
    get promptGuidelines() {
      return [WORKFLOW_GATE_GUIDELINE];
    },
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    async execute(_toolCallId, params) {
      const manager = getManager();
      const storage = getStorage();
      const cwd = getCwd();
      // `name` resolves through the same registry the built-in slash commands
      // and saved-workflow commands use (see builtin-workflows.ts /
      // workflow-saved.ts): a project/user saved workflow of that name wins on
      // a collision, else a curated built-in pattern. This lets the
      // model reach a curated pattern by name instead of having to author an
      // equivalent script from scratch (and, for patterns that need it, the
      // right exec context — e.g. deep-research's web tools — travels with it).
      let invocationTools: ToolDefinition[] | undefined;
      let invocationToolset: string | undefined;
      let script: string;
      if (params.name) {
        if (params.resumeFromRunId) {
          throw new Error(
            "workflow: `name` cannot be combined with `resumeFromRunId` — resume with an edited `script` instead.",
          );
        }
        const resolved = resolveWorkflowInvocation(params.name, params.args, { storage, cwd });
        if (!resolved) {
          throw new Error(
            `workflow: no saved or built-in workflow named "${params.name}". Built-in names: ${BUILTIN_WORKFLOW_NAMES.join(", ")}.`,
          );
        }
        script = normalizeWorkflowScript(resolved.script);
        invocationTools = resolved.tools;
        invocationToolset = resolved.toolset;
      } else {
        if (!params.script) throw new Error("workflow requires either `script` or `name`");
        script = normalizeWorkflowScript(params.script);
      }
      const parsed = parseWorkflowScript(script);

      // Iteration / cached-prefix reuse: resume a prior run with THIS (edited)
      // script instead of creating a brand-new run. Unchanged agent() calls
      // replay from the prior run's journal; the first edited/new call and
      // everything after it re-run live. Always background (the resumed run is
      // detached and its result is delivered back into the conversation).
      if (params.resumeFromRunId) {
        const runId = params.resumeFromRunId;
        const resumed = await manager.resume(runId, { script, args: params.args });
        if (!resumed) {
          throw new Error(resumeFailureText(manager, runId));
        }
        return {
          content: [{ type: "text", text: resumedText(parsed.meta.name, runId) }],
          details: { runId, background: true, resumedFrom: runId },
        };
      }

      // Runs never block the tool call: the run ID returns now and
      // installResultDelivery sends the result back when the run finishes.
      const { runId } = manager.startInBackground(script, params.args, {
        tools: invocationTools,
        toolset: invocationToolset,
      });
      return {
        content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
        details: { runId, background: true },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details;
      if (details && "name" in details && details.name) {
        return new Text(renderWorkflowText(details, !isPartial), 0, 0);
      }
      // Fallback: strip markdown syntax so the TUI doesn't display raw asterisks/hashes.
      // The `content` field is for the LLM (where markdown is preserved), but the TUI
      // renderer (Text component) shows text literally — so we strip markdown here.
      const text = result.content?.[0];
      const raw = text?.type === "text" ? text.text : theme.fg("muted", "workflow");
      const clean = raw
        .replace(/\*\*/g, "")
        .replace(/```[a-z]*\n/g, "")
        .replace(/```/g, "")
        .replace(/^##+\s*/gm, "")
        .trim();
      return new Text(clean || theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export function backgroundStartedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" started in the background.`,
    `Run ID: ${runId}`,
    "It keeps running on its own. When it finishes, the result is delivered back",
    "here and the conversation continues automatically — the user does not need to",
    "do anything. Tell the user they can simply wait here for it to finish (it will",
    "resume the conversation by itself), or keep chatting / working on other things",
    "in the meantime; either way the result will come back to this conversation.",
    `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
    reviseHint(runId),
  ].join("\n");
}

/**
 * One-line hint telling the model it can iterate on a finished/running run by
 * resuming it with an edited script instead of re-running the whole workflow.
 * Unchanged agent() calls replay from the journal (cache); only edited/new ones
 * re-run. Omitted when there is no runId to reference.
 */
export function reviseHint(runId: string | undefined): string {
  if (!runId) return "";
  return `To revise without re-running everything: re-call workflow with resumeFromRunId="${runId}" and an edited script — unchanged agent() calls replay from cache, only edited/new ones re-run.`;
}

/**
 * The tool result returned when the model resumes a run with an edited script.
 * The resumed run is always background, so its result is delivered back later.
 */
export function resumedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" resumed from run ${runId} with your edited script.`,
    "Unchanged agent() calls replay from that run's journal (cache); the first",
    "edited or newly inserted agent() call — and everything after it — re-runs live.",
    "It runs in the background; the result is delivered back here when it finishes,",
    "and the conversation continues automatically. The user can wait or keep working.",
    `Track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
  ].join("\n");
}

/**
 * Explain why a resumeFromRunId could not be resumed, so the model gets a clear
 * tool error instead of a silent failure. Inspects live + persisted state to
 * name the concrete reason (not found / running / completed / stopped).
 */
export function resumeFailureText(manager: WorkflowManager, runId: string): string {
  const active = manager.getRun(runId);
  if (active?.status === "running") {
    return `Cannot resume workflow run "${runId}": it is still running. Wait for it to finish (or /workflows stop ${runId}) before resuming with an edited script.`;
  }
  const persisted = manager.getPersistence().load(runId);
  if (!persisted) {
    return `Cannot resume workflow run "${runId}": no run with that ID was found. Use the runId from a prior workflow result, or omit resumeFromRunId to start a new run.`;
  }
  if (persisted.status === "completed") {
    return `Cannot resume workflow run "${runId}": it already completed. Start a new run instead (omit resumeFromRunId).`;
  }
  if (persisted.status === "aborted" || active?.status === "aborted") {
    return `Cannot resume workflow run "${runId}": it was stopped/aborted and is not resumable. Start a new run instead (omit resumeFromRunId).`;
  }
  if (!persisted.script) {
    return `Cannot resume workflow run "${runId}": it has no persisted script to resume. Start a new run instead (omit resumeFromRunId).`;
  }
  return `Cannot resume workflow run "${runId}": it is not currently resumable (it may be busy under another process). Try again shortly, or start a new run.`;
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (!args || typeof args !== "object")
    throw new Error("workflow requires an object argument with a `script` string or a `name`");
  const value = args as Record<string, unknown>;
  // `name` resolves a saved/built-in workflow at execute() time, so `script` is
  // optional here — but if `script` is present at all it must still be a
  // string (same requirement as the script-only path below), so a caller
  // passing a malformed `script` alongside `name` gets a clear error instead
  // of it being silently dropped.
  if (typeof value.name === "string" && value.name.trim()) {
    if (value.script !== undefined && typeof value.script !== "string") {
      throw new Error("workflow's `script` must be a string when provided alongside `name`");
    }
    return {
      ...value,
      name: value.name.trim(),
      script: typeof value.script === "string" ? normalizeWorkflowScript(value.script) : undefined,
    } as WorkflowToolInput;
  }
  if (typeof value.script !== "string") throw new Error("workflow requires either `script` or `name` to be a string");
  return { ...value, script: normalizeWorkflowScript(value.script) } as WorkflowToolInput;
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}
