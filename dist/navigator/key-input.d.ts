/** Applies navigator key presses for each input mode: text entry, confirmation, and browsing. */
import type { NavAction } from "../workflow-ui.js";
import { type NavigatorSession } from "./session.js";
/** Filter and rename fields own every keystroke, so pasted text never reaches browse bindings. */
export declare function handleTextInput(session: NavigatorSession, key: string | undefined, data: string): void;
/** Only the key that asked confirms (p for pause, x for stop or delete); any other key cancels. */
export declare function handleConfirmKey(session: NavigatorSession, key: string | undefined): void;
/**
 * Apply a browse-mode action. Returns false when nothing should be redrawn:
 * the key did nothing, or the overlay closed.
 */
export declare function runBrowseAction(session: NavigatorSession, action: NavAction, close: () => void): boolean;
