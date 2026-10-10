/** Saved-workflow actions started from the navigator: save a run, rename, and delete, keeping `/name` commands in sync. */
import { type ItemIdentity } from "./items.js";
import { type NavigatorSession } from "./session.js";
/** Save the selected run's script as a project workflow and register its command. */
export declare function saveRunAsWorkflow(session: NavigatorSession, runId: string | undefined): void;
/** Apply the typed rename to the workflow it was started on, then move its command. */
export declare function commitRename(session: NavigatorSession): void;
/** Delete the confirmed saved workflow, leaving its detail page if that is where the user was. */
export declare function deleteSavedWorkflow(session: NavigatorSession, target: ItemIdentity): void;
