/** Run actions started from the navigator: confirmed pause and stop, and restart from the saved script. */
import type { ConfirmKind } from "./confirmation.js";
import type { NavigatorSession } from "./session.js";
/** Apply a confirmed pause or stop, re-checking the run's status first. */
export declare function executeRunConfirmation(session: NavigatorSession, action: ConfirmKind, runId: string): void;
/** Start a new background run from the selected run's script and arguments. */
export declare function restartRun(session: NavigatorSession, runId: string | undefined): void;
