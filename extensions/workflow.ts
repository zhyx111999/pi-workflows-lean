// Resolve the host SDK through Pi's loader, but load our compiled ESM graph
// with import semantics. Requiring the graph makes import-only SDK subpaths
// fall through the host's prefix aliases as invalid file-system paths.
// Node caches that graph for the life of the process, so /reload keeps the
// loaded build; the extension warns when the package on disk has changed.
const host = await import("@earendil-works/pi-coding-agent");
const extension = await import("../dist/pi-extension.js");
extension.useHostSessionClass(host.AgentSession);
export const sessionFileCwd = extension.sessionFileCwd;
export default extension.default;
