/** Renders one entry of an agent's session history: messages, tool calls, written source, and edit diffs. */
import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { asText } from "./as-text.js";
import { renderCodeLines, renderDiffLines, renderMarkdownLines } from "./rich-text.js";
function historyLabel(entry) {
    if (entry.kind === "toolCall")
        return entry.toolName ? `assistant tool ${asText(entry.toolName)}` : "assistant tool";
    if (entry.role === "tool")
        return entry.toolName ? `tool ${asText(entry.toolName)}` : "tool";
    if (entry.kind === "error")
        return `${asText(entry.role)} error`;
    return asText(entry.role);
}
function editCallPath(entry) {
    if (entry.kind !== "toolCall" || entry.toolName !== "edit")
        return undefined;
    if (typeof entry.path === "string")
        return entry.path;
    // Older persisted histories kept the path only inside the JSON argument envelope.
    try {
        const args = JSON.parse(asText(entry.text));
        return typeof args.path === "string" ? args.path : undefined;
    }
    catch {
        return undefined;
    }
}
function writeCallSource(entry) {
    if (entry.kind !== "toolCall" || entry.toolName !== "write")
        return undefined;
    if (typeof entry.path === "string")
        return { path: entry.path, content: asText(entry.text) };
    // Older persisted histories stored the whole write argument envelope as JSON.
    try {
        const args = JSON.parse(asText(entry.text));
        return typeof args.path === "string" && typeof args.content === "string"
            ? { path: args.path, content: args.content }
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** Infer source language for history that pi stores as raw tool text rather than
 * Markdown. Tool-call arguments are JSON; file writes and read results inherit
 * their source language from the requested path. */
function historyEntryLanguage(history, index) {
    const entry = history[index];
    if (!entry)
        return undefined;
    if (entry.kind === "toolCall") {
        const write = writeCallSource(entry);
        return write ? (getLanguageFromPath(write.path) ?? "text") : "json";
    }
    if (entry.kind !== "toolResult" || entry.toolName !== "read")
        return undefined;
    for (let i = index - 1; i >= 0; i--) {
        const call = history[i];
        if (call?.kind !== "toolCall" || call.toolName !== "read")
            continue;
        try {
            const args = JSON.parse(asText(call.text));
            return typeof args.path === "string" ? getLanguageFromPath(args.path) : undefined;
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
export function renderHistoryEntryLines(history, index, width, markdownTheme, dim, renderCache) {
    const entry = history[index];
    // Corrupt persisted histories can hold null or primitive elements.
    if (!entry || typeof entry !== "object")
        return [];
    const write = writeCallSource(entry);
    const editPath = editCallPath(entry);
    const path = write?.path ?? editPath;
    const header = dim(`${historyLabel(entry)}:${path ? ` ${path}` : ""}`);
    // The edit result carries the same display-oriented diff used by Pi's built-in
    // edit renderer. Render it with Pi's native colors, line numbers, and
    // intra-line highlighting instead of showing the raw replacement JSON.
    if (entry.kind === "toolResult" && entry.toolName === "edit" && typeof entry.diff === "string") {
        return [header, ...renderDiffLines(entry.diff, width, renderCache)];
    }
    if (editPath)
        return [header];
    const language = historyEntryLanguage(history, index);
    const text = write?.content ?? asText(entry.text);
    return [
        header,
        ...(language
            ? renderCodeLines(text, language, width, markdownTheme, renderCache)
            : renderMarkdownLines(text, width, markdownTheme, renderCache)),
    ];
}
