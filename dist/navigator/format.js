/** Model and phase labels, plurals, and truncation shared by navigator cells. */
import { asText } from "./as-text.js";
/** Marks text cut to fit its cell. */
export const ELLIPSIS = "…";
export function pluralize(word, n) {
    return n === 1 ? word : `${word}s`;
}
/** A phase title as drawn in a cell. Scripts may call phase(""), and a blank
 *  title would leave the row and the agents-pane heading with no visible name. */
export function phaseLabel(title) {
    return title.trim() ? title : "(unnamed phase)";
}
/** Short, human-friendly model label: drop the provider prefix for display. */
export function shortModel(model) {
    if (!model)
        return undefined;
    const m = asText(model);
    const slash = m.indexOf("/");
    return slash > 0 ? m.slice(slash + 1) : m;
}
