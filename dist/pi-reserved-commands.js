/**
 * Slash commands Pi's interactive editor runs itself. The editor matches these
 * before it looks up extension commands, yet `pi.getCommands()` does not list
 * them and `pi.registerCommand()` does not reject them, so an extension command
 * with one of these names registers fine and never runs.
 *
 * The SDK does not export this list: `BUILTIN_SLASH_COMMANDS` lives in
 * `dist/core/slash-commands.js`, which the package's `exports` map hides.
 * Mirrors @earendil-works/pi-coding-agent 0.85.1: every `BUILTIN_SLASH_COMMANDS`
 * name, plus the unlisted names `InteractiveMode.setupEditorSubmitHandler`
 * also matches (`dist/modes/interactive/interactive-mode.js`).
 * `tests/pi-reserved-commands.test.ts` fails when the installed SDK differs.
 */
export const PI_RESERVED_COMMANDS = new Set([
    // BUILTIN_SLASH_COMMANDS
    "settings",
    "model",
    "tree",
    "thinking",
    "scoped-models",
    "export",
    "import",
    "share",
    "copy",
    "name",
    "session",
    "changelog",
    "hotkeys",
    "fork",
    "clone",
    "trust",
    "login",
    "logout",
    "new",
    "compact",
    "resume",
    "reload",
    "quit",
    // Matched by the editor, absent from autocomplete
    "debug",
    "arminsayshi",
    "dementedelves",
]);
