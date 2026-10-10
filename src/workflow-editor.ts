/**
 * Interactive-session wiring for the parent model: the tail prompt appended to
 * interactive messages, the `/workflows run` directive, and the
 * `/workflows-progress` panel preference command.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendParentWorkflowPrompt } from "./parent-prompt.js";
import {
  loadWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
  type WorkflowSettingsStore,
} from "./workflow-settings.js";

/** The exact name of the workflow tool that `/workflows run` makes sure is active. */
export const WORKFLOW_TOOL_NAME = "workflow";

/**
 * The directive for the explicit `/workflows run <prompt>` command. The user
 * typed a command whose only purpose is to run a workflow, so the model is told
 * to call the tool rather than judge whether delegation is worthwhile. It
 * avoids MUST/ONLY wording, which produced a bare tool call that left the user
 * at an idle prompt (#88/#89), and says the turn ending is expected.
 */
export function buildForcedWorkflowPrompt(text: string): string {
  return [
    text,
    "",
    "---",
    "[/workflows run — you ran an explicit command to execute a workflow for this request.",
    "Call the `workflow` tool now: write a script that fans this task out across subagents",
    "via agent()/parallel()/pipeline(). (This is a direct command, not a heuristic guess, so",
    "do not answer in prose instead of running the workflow.)",
    "The `workflow` tool always runs in the background: this turn will end and the result is delivered back into the conversation automatically when it finishes — that's expected, not a stall, so you do not need to stay and block.]",
  ].join("\n");
}

/**
 * Append the parent prompt to interactive messages. Slash commands and input
 * injected by RPC or other extensions pass through unchanged.
 */
export function installParentPromptHook(pi: ExtensionAPI): void {
  pi.on("input", (event: { source?: string; text?: string }) => {
    if (event.source !== "interactive" || !event.text) return { action: "continue" } as const;
    const text = appendParentWorkflowPrompt(event.text);
    if (text === event.text) return { action: "continue" } as const;
    return { action: "transform", text } as const;
  });
}

/**
 * Register the bottom progress-panel preference command:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export function registerWorkflowProgressCommands(
  pi: ExtensionAPI,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-progress", {
    description: "Bottom progress panel: compact | detailed | status | max <N>",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const trimmed = args.trim();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      const spaceIdx = trimmed.indexOf(" ");
      const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (verb === "compact" || verb === "detailed") {
        const saved = persistProgressSettings(settingsStore, { progressPanelMode: verb });
        await say(
          saved
            ? `Workflow progress panel set to ${verb} — takes effect on the next render of a live run (no restart needed).`
            : `Workflow progress panel set to ${verb} for this session, but the preference could not be saved.`,
        );
        return;
      }

      if (verb === "max") {
        if (!rest) {
          await say(
            `Detailed progress shows up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress max <1-1000>`,
          );
          return;
        }
        const n = Number.parseInt(rest, 10);
        if (!Number.isFinite(n) || n < 1) {
          await say(`Invalid value "${rest}". Usage: /workflows-progress max <1-1000> (a whole number ≥ 1).`);
          return;
        }
        const clamped = Math.min(1000, n);
        const saved = persistProgressSettings(settingsStore, { progressPanelMaxAgents: clamped });
        await say(
          saved
            ? `Detailed progress now shows up to ${clamped} agents per phase.`
            : `Set to ${clamped} for this session, but the preference could not be saved.`,
        );
        return;
      }

      await say(
        `Workflow progress panel is ${loadProgressMode(settingsStore)}, showing up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress compact | detailed | status | max <N>`,
      );
    },
  });
}

const DEFAULT_SETTINGS_STORE: WorkflowSettingsStore = {
  load: loadWorkflowSettings,
  save: saveWorkflowSettings,
};

function persistProgressSettings(settingsStore: WorkflowSettingsStore, settings: WorkflowSettings): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function loadProgressMode(settingsStore: WorkflowSettingsStore): "compact" | "detailed" {
  try {
    return settingsStore.load().progressPanelMode ?? "compact";
  } catch {
    return "compact";
  }
}

function loadProgressMaxAgents(settingsStore: WorkflowSettingsStore): number {
  try {
    return settingsStore.load().progressPanelMaxAgents ?? 8;
  } catch {
    return 8;
  }
}
