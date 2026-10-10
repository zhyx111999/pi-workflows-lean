/** The rows under every view: a pending confirm or rename prompt, a blank line, and the key hints. */
import type { ThemeLike } from "../display.js";
import type { NavigatorModel, NavigatorState } from "../workflow-ui.js";
import type { NavigatorSnapshot } from "./items.js";
export declare function footerLines(state: NavigatorState, model: NavigatorModel, theme: ThemeLike, snapshot: NavigatorSnapshot | undefined): string[];
