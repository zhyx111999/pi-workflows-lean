import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
export { installHostSessionCapture } from "./task-panel.js";
/**
 * Read-only probe of a session JSONL file's project cwd from its header line.
 * Does NOT call SessionManager.open() — that API creates directories, may rewrite
 * empty/legacy files, and loads the full history. Used on session_shutdown for
 * resume/fork destination checks. Unreadable / oversized / non-session files
 * return undefined; callers decide fail-closed vs allow based on the shutdown reason.
 */
export declare function sessionFileCwd(sessionFile: string | undefined): string | undefined;
export default function extension(pi: ExtensionAPI): void;
