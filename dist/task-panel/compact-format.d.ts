/** Short number formats shared by panel rows and delivered result summaries. */
/** Compact token count for space-constrained lines: 980, 12.4K, 1.3M. */
export declare function fmtTokensShort(n: number): string;
/** Human-readable byte size for the dropped-tail hint: 512 B, 3.2 KB, 1.4 MB. */
export declare function formatBytes(n: number): string;
