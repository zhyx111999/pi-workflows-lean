// Resolve the host SDK through Pi's loader, but load our compiled ESM graph
// with import semantics. Requiring the graph makes import-only SDK subpaths
// fall through the host's prefix aliases as invalid file-system paths.
// The mtime query bypasses Node's module cache so /reload picks up a rebuilt dist.
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, "../dist/pi-extension.js");
const distUrl = `${pathToFileURL(distPath).href}?v=${statSync(distPath).mtimeMs}`;

const host = await import("@earendil-works/pi-coding-agent");
const extension = await import(distUrl);
extension.installHostSessionCapture(host.AgentSession);
export const sessionFileCwd = extension.sessionFileCwd;
export default extension.default;
