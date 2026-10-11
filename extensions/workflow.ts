// Resolve the host SDK through Pi's loader, but load our compiled ESM graph
// with import semantics. Requiring the graph makes import-only SDK subpaths
// fall through the host's prefix aliases as invalid file-system paths.
// Pi imports extensions with its module cache off, so /reload evaluates this
// graph afresh, including an updated build.
const host = await import("@earendil-works/pi-coding-agent");
const extension = await import("../dist/pi-extension.js");
extension.useHostSessionClass(host.AgentSession);
export const sessionFileCwd = extension.sessionFileCwd;
export default extension.default;
