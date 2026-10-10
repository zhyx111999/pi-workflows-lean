/** Compact number, model label, plural, and truncation formatting shared by navigator cells. */
/** Marks text cut to fit its cell. */
export declare const ELLIPSIS = "\u2026";
/** Compact token count: 842, 35k, 35.7k, 1.3M (trailing .0 trimmed). */
export declare function compactTokens(t: number): string;
export declare function pluralize(word: string, n: number): string;
/** Short, human-friendly model label: drop the provider prefix for display. */
export declare function shortModel(model: string | undefined): string | undefined;
