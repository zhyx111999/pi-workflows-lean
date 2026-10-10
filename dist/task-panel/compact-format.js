/** Short number formats shared by panel rows and delivered result summaries. */
/** Compact token count for space-constrained lines: 980, 12.4K, 1.3M. */
export function fmtTokensShort(n) {
    if (!Number.isFinite(n) || n <= 0)
        return "";
    if (n < 1000)
        return `${Math.round(n)}`;
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}
/** Human-readable byte size for the dropped-tail hint: 512 B, 3.2 KB, 1.4 MB. */
export function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
