/** Fits lists and long text bodies into a fixed number of terminal rows. */
/** Compute a scroll window of up to `cap` rows keeping `active` visible. */
export function scrollWindow(total, active, cap) {
    if (total <= cap)
        return { start: 0, count: total, more: false };
    let start = Math.max(0, Math.min(active - Math.floor(cap / 2), total - cap));
    if (active < start)
        start = active;
    if (active >= start + cap)
        start = active - cap + 1;
    return { start, count: cap, more: start + cap < total };
}
/**
 * The slice of a detail body at the state's scroll offset, plus a position
 * indicator when it overflows. The viewport height is fixed so scrolling
 * toward the end never shrinks the overlay.
 */
export function scrollableBody(state, body, viewportRows, dim) {
    const confirmationRows = state.mode === "confirm" ? 1 : 0;
    const viewport = Math.max(1, viewportRows - 4 - confirmationRows); // title + blank + footer + indicator + confirm
    state.setPageSize(viewport);
    const maxScroll = Math.max(0, body.length - viewport);
    if (state.kind === "detail" && state.tailing)
        state.scroll = maxScroll;
    state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
    const out = body.slice(state.scroll, state.scroll + viewport);
    if (body.length > viewport) {
        const end = Math.min(state.scroll + viewport, body.length);
        const up = state.scroll > 0 ? "↑" : " ";
        const down = end < body.length ? "↓" : " ";
        const mode = state.kind === "detail" && state.tailing ? " TAIL" : "";
        out.push(dim(`  [${state.scroll + 1}-${end} / ${body.length}] ${up}${down}${mode}`));
    }
    return out;
}
/** The first screenful of a body. Summaries do not scroll; the full pager does. */
export function compactBody(body, viewportRows, dim) {
    const viewport = Math.max(1, viewportRows - 3); // title + blank + footer
    if (body.length <= viewport)
        return body;
    return [...body.slice(0, Math.max(1, viewport - 1)), dim("  … enter to open full pager")];
}
