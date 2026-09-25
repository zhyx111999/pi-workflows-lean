/**
 * Bundled workflow command: `/deep-research`.
 *
 * Each command starts its generated workflow through the WorkflowManager's
 * background path — the command returns immediately, progress is visible in
 * the task panel and `/workflows` (pause/stop work like any managed run), and
 * the report is delivered back into the conversation on completion by
 * installResultDelivery. Running inline in the handler instead would block the
 * whole session until the workflow finished (#104).
 */

import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BuiltinWorkflowInvocation } from "./builtin-workflows.js";
import { findBuiltinWorkflow } from "./builtin-workflows.js";
import { claimCommand, isCommandRegistered } from "./command-registry.js";
import { backgroundStartNotice } from "./display.js";
import { parseCommandArgs } from "./saved-commands.js";
import type { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";

function alreadyRegistered(pi: ExtensionAPI, name: string): boolean {
  return isCommandRegistered(pi, name);
}

/** Split a command argument string into tokens, respecting single/double quotes. */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  for (const m of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

/**
 * Start a built-in workflow through the manager's background path and tell the
 * user where to watch it. startInBackground can throw synchronously (script
 * parse, run lease) — surface that as a notify instead of an unhandled error.
 * Async failures are handled by the manager's generic delivery ("✗ Background
 * workflow … failed"), so no handler-side await is needed — that await is
 * exactly what used to hang the session (#104).
 */
function startBackground(
  manager: WorkflowManager,
  ctx: ExtensionCommandContext,
  name: string,
  script: string,
  args?: unknown,
  exec?: { tools?: ToolDefinition[]; toolset?: string },
): void {
  try {
    const { runId } = manager.startInBackground(script, args, exec ?? {});
    ctx.ui.notify(backgroundStartNotice(name, runId, ctx.mode, "report"), "info");
  } catch (error) {
    ctx.ui.notify(`${name} failed to start: ${error instanceof Error ? error.message : error}`, "error");
  }
}

/**
 * Look up a built-in descriptor by its fixed, hardcoded name. Every call site
 * below passes one of the 5 literal names in BUILTIN_WORKFLOWS, so this can
 * only throw if that registry and this file's command names fall out of sync
 * — a programming error, not a user-input problem (tests pin the names stay
 * in sync, see builtin-commands.test.ts).
 */
function requireBuiltin(name: string) {
  const found = findBuiltinWorkflow(name);
  if (!found) throw new Error(`internal error: no built-in workflow registered for "${name}"`);
  return found;
}

/**
 * Resolve a built-in's script/exec context for the given args, surfacing an
 * invalid-args error (e.g. a whitespace-only string that passes the handler's
 * cheap `!value` check but fails the registry's real validation) as the same
 * kind of warning notify the handlers already use for their own validation,
 * rather than an uncaught rejection.
 */
function resolveBuiltinOrNotify(
  name: string,
  cwd: string,
  args: unknown,
  ctx: ExtensionCommandContext,
): BuiltinWorkflowInvocation | undefined {
  try {
    return requireBuiltin(name).resolve(cwd, args);
  } catch (error) {
    ctx.ui.notify(`/${name}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    return undefined;
  }
}

export function registerBuiltinWorkflows(
  pi: ExtensionAPI,
  opts: {
    cwd?: string;
    manager?: WorkflowManager;
    storage?: WorkflowStorage;
    /** Live accessors — preferred when the extension may replace manager/cwd after session_start. */
    getManager?: () => WorkflowManager;
    getCwd?: () => string;
    getStorage?: () => WorkflowStorage;
  },
): void {
  const getManager = (): WorkflowManager => {
    const m = opts.getManager?.() ?? opts.manager;
    if (!m) throw new Error("registerBuiltinWorkflows: no WorkflowManager");
    return m;
  };
  const getCwd = () => opts.getCwd?.() ?? opts.cwd ?? process.cwd();
  const getStorage = () => opts.getStorage?.() ?? opts.storage ?? createWorkflowStorage(getCwd());

  /**
   * A project/user saved workflow always takes precedence over a built-in of
   * the same name — on every path, not just the `workflow` tool's `name`
   * input. Builtins are registered as commands before saved workflows
   * (registerAllSavedWorkflows skips a name that's already registered), so
   * without this dynamic check a same-named saved workflow would silently
   * never run from its slash command. Checking here, at invocation time
   * rather than registration time, makes "saved wins" hold regardless of
   * registration order. Mirrors registerSavedWorkflow's own handler exactly
   * (same parseCommandArgs call, same startBackground path, no builtin exec
   * context) so a shadowed command behaves identically to how it would if the
   * saved workflow itself had been registered under this name.
   */
  // Positional-argument contract for saved workflows that shadow a built-in.
  const SHADOW_WHOLE_STRING_PRIMARY: Record<string, string> = {
    "deep-research": "question",
  };
  const SHADOW_TOKENIZED_PRIMARY: Record<string, { primary: string; rest: string }> = {};

  function runSavedShadowIfPresent(name: string, rawArgs: string, ctx: ExtensionCommandContext): boolean {
    const saved = getStorage().load(name);
    if (!saved) return false;
    const parsed = parseCommandArgs(rawArgs, saved.parameters);
    const raw = typeof parsed._raw === "string" ? parsed._raw.trim() : "";
    // An explicit `key=value` for the primary beats the positional mapping;
    // the user's bare positional beats a declared parameter default.
    const wholeKey = SHADOW_WHOLE_STRING_PRIMARY[name];
    if (wholeKey && !new RegExp(`(?:^|\\s)${wholeKey}=`).test(rawArgs) && raw) {
      // The WHOLE raw string is the primary — exactly the builtin's
      // args.trim(), including "="-containing topics (r2 NIT).
      parsed[wholeKey] = raw;
    }
    const tokenized = SHADOW_TOKENIZED_PRIMARY[name];
    if (tokenized && !new RegExp(`(?:^|\\s)${tokenized.primary}=`).test(rawArgs) && raw) {
      // Quote-aware tokenization, mirroring the builtin handler's own
      // Quote-aware tokenization of the raw argument string.
      const tokens = tokenizeArgs(raw);
      // A leading key=value token means a named-arg-style invocation —
      // mirror how any saved workflow parses it (no positional mapping).
      if (tokens.length && !tokens[0].includes("=")) {
        parsed[tokenized.primary] = tokens[0];
        if (tokens.length > 1 && parsed[tokenized.rest] === undefined) parsed[tokenized.rest] = tokens.slice(1);
      }
    }
    startBackground(getManager(), ctx, name, saved.script, parsed);
    return true;
  }

  if (!alreadyRegistered(pi, "deep-research")) {
    pi.registerCommand("deep-research", {
      description: "Research a question across the web and return sourced claims",
      async handler(args: string, ctx: ExtensionCommandContext) {
        if (runSavedShadowIfPresent("deep-research", args, ctx)) return;
        const question = args.trim();
        if (!question) return ctx.ui.notify("Usage: /deep-research <question>", "warning");
        // Resolve through the shared builtin registry (builtin-workflows.ts) so
        // this command and the workflow tool's `name` input always run the exact
        // same generated script and exec context (tools/toolset) for this pattern.
        const resolved = resolveBuiltinOrNotify("deep-research", getCwd(), { question }, ctx);
        if (!resolved) return;
        startBackground(
          getManager(),
          ctx,
          "deep-research",
          resolved.script,
          { question },
          {
            tools: resolved.tools,
            toolset: resolved.toolset,
          },
        );
      },
    });
    claimCommand(pi, "deep-research", "builtin");
  }

}
