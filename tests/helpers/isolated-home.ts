/**
 * Test-process preload, loaded with `--import` by `npm run test:unit`.
 *
 * Production code keeps user state under the home directory (~/.pi/workflows,
 * the SDK's ~/.pi/agent) and git reads ~/.gitconfig, so without this a test
 * run writes journals and auth files into the developer's real profile and
 * depends on their personal config. The node test runner forwards `--import`
 * to the child process it starts for each test file, so every file gets its
 * own empty home, removed when that process exits.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeHome } from "./fake-home.js";

const home = mkdtempSync(join(tmpdir(), "pi-test-home-"));
installFakeHome(home);
// The SDK honours this override before falling back to ~/.pi/agent.
delete process.env.PI_CODING_AGENT_DIR;

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
