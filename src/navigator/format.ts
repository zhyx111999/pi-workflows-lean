/** Compact number, model label, plural, and truncation formatting shared by navigator cells. */

import { asText } from "./as-text.js";

/** Marks text cut to fit its cell. */
export const ELLIPSIS = "…";

/** Compact token count: 842, 35k, 35.7k, 1.3M (trailing .0 trimmed). */
export function compactTokens(t: number): string {
  if (!t || t <= 0) return "0";
  if (t < 1000) return String(Math.round(t));
  if (t < 1_000_000) {
    const k = t / 1000;
    const s = k >= 100 ? Math.round(k).toString() : trimZero(k.toFixed(1));
    return `${s}k`;
  }
  const m = t / 1_000_000;
  return `${trimZero(m.toFixed(1))}M`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function pluralize(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}

/** Short, human-friendly model label: drop the provider prefix for display. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = asText(model);
  const slash = m.indexOf("/");
  return slash > 0 ? m.slice(slash + 1) : m;
}
