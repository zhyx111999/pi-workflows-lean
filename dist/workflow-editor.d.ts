/**
 * Interactive-session wiring for the parent model: the hidden parent prompt
 * sent with typed messages, the `/workflows run` directive, and the
 * `/workflows-progress` panel preference command.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type WorkflowSettingsStore } from "./workflow-settings.js";
/**
 * The directive for the explicit `/workflows run <prompt>` command. The user
 * typed a command whose only purpose is to run a workflow, so the model is told
 * to call the tool rather than judge whether delegation is worthwhile. It
 * avoids MUST/ONLY wording, which produced a bare tool call that left the user
 * at an idle prompt (#88/#89), and says the turn ending is expected.
 */
export declare function buildForcedWorkflowPrompt(text: string): string;
/**
 * Send the parent prompt as a hidden message after each message the user types,
 * leaving the user's own text unchanged in the transcript.
 *
 * Only `input` knows where text came from, and only `before_agent_start` can add
 * a message, so `input` records eligible text and `before_agent_start` sends the
 * prompt when its prompt is exactly that text. Slash commands, steer and
 * follow-up messages typed during a run, and RPC or extension input are not
 * recorded.
 */
export declare function installParentPromptHook(pi: ExtensionAPI): void;
/**
 * Register the bottom progress-panel preference command:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export declare function registerWorkflowProgressCommands(pi: ExtensionAPI, settingsStore?: WorkflowSettingsStore): void;
