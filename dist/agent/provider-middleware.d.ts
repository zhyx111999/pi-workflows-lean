import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
/**
 * Keep only explicitly approved provider/auth middleware paths. Recursive
 * orchestration extensions are always rejected, even if explicitly allowlisted.
 */
export declare function isProviderMiddlewareExtensionPath(extensionPath: string, allowlist: readonly string[], packageSource?: string): boolean;
/** Drop every loaded extension that isProviderMiddlewareExtensionPath does not approve. */
export declare function filterProviderMiddlewareExtensions(base: LoadExtensionsResult, allowlist: readonly string[], packageSources?: ReadonlyMap<string, string>): LoadExtensionsResult;
