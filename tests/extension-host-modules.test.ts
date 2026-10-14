import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as hostSdk from "@earendil-works/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };
import { sessionStartContext } from "./helpers/mock-pi.js";

// These tests load the published entry, which imports the built dist/;
// npm run test:unit builds it first.
// A native path: URL.pathname would yield "/C:/..." on Windows.
const extensionEntry = fileURLToPath(new URL(`../${packageJson.pi.extensions[0]}`, import.meta.url));
const distRoot = new URL("../dist/", import.meta.url).href;

/** Run an ES module script in a clean Node process from the package root; fails on a non-zero exit or any stderr. */
function runIsolated(script: string): void {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    timeout: 60_000,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.stderr, "", "loading writes nothing to stderr, which would draw over Pi's TUI");
}

test("published extension loads through the unbundled host aliases and probes the actual host", () => {
  // Run without tsx/source-runtime hooks: the production Node host uses aliases,
  // not the embedded virtualModules path covered by the test below.
  const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const script = `
    import assert from "node:assert/strict";
    const sdkUrl = ${JSON.stringify(sdkEntry)};
    const sdk = await import(sdkUrl);
    const { loadExtensions, createExtensionRuntime } = await import(new URL("core/extensions/loader.js", sdkUrl));
    const { createEventBus } = await import(new URL("core/event-bus.js", sdkUrl));
    const original = sdk.AgentSession.prototype.sendCustomMessage;
    const runtime = createExtensionRuntime();
    const result = await loadExtensions([${JSON.stringify(extensionEntry)}], process.cwd(), createEventBus(), runtime);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.equal(sdk.AgentSession.prototype.sendCustomMessage, original, "loading installs nothing on the host");

    // Bind the runtime to a host session the way AgentSession._bindExtensionCore does.
    const receiver = Object.create(sdk.AgentSession.prototype);
    receiver.sessionManager = { getSessionId: () => "node-host-test" };
    receiver.subscribe = () => () => {};
    let hookedDuringProbe = false;
    let reachedRealSend;
    runtime.sendMessage = (message, options) => {
      hookedDuringProbe = sdk.AgentSession.prototype.sendCustomMessage !== original;
      receiver.sendCustomMessage(message, options).catch((error) => { reachedRealSend = error; });
    };
    runtime.getActiveTools = () => [];
    runtime.setActiveTools = () => {};
    runtime.getCommands = () => [];
    const handlers = result.extensions[0].handlers;
    handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, {
      cwd: process.cwd(),
      model: undefined,
      modelRegistry: {},
      sessionManager: { getSessionId: () => "node-host-test", getSessionFile: () => undefined },
      ui: { setWidget: () => {}, notify: () => {} },
    });
    await new Promise((resolve) => setImmediate(resolve));
    handlers.get("session_shutdown")[0]({ type: "session_shutdown", reason: "quit" });

    assert.equal(hookedDuringProbe, true, "the probe runs through the host class");
    assert.equal(reachedRealSend, undefined, "the probe never reaches the real send");
    assert.equal(sdk.AgentSession.prototype.sendCustomMessage, original, "no hook remains after the probe");
  `;
  runIsolated(script);
});

test("the compiled modules import Pi's packages from the loader that loaded the extension, never the package's own copies", () => {
  // The package's node_modules holds its own copies of Pi's packages (the dev
  // dependencies), so a plain Node import from dist/ would find them. The host
  // here is a set of modules the loader hands over; any import from dist/ that
  // reaches node_modules for one of them is a leak.
  const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const script = `
    import assert from "node:assert/strict";
    import { createRequire, registerHooks } from "node:module";
    import { pathToFileURL } from "node:url";
    const dist = ${JSON.stringify(distRoot)};
    const leaked = [];
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        if ((context.parentURL ?? "").startsWith(dist) && /\\/node_modules\\/(@earendil-works|typebox)\\//.test(result.url)) {
          leaked.push(specifier);
        }
        return result;
      },
    });
    const sdkUrl = ${JSON.stringify(sdkEntry)};
    const host = {
      "@earendil-works/pi-coding-agent": await import(sdkUrl),
      "@earendil-works/pi-tui": await import("@earendil-works/pi-tui"),
      typebox: await import("typebox"),
      "typebox/value": await import("typebox/value"),
    };
    const require = createRequire(sdkUrl);
    const jitiPackage = pathToFileURL(require.resolve("jiti/package.json"));
    const { createJiti } = await import(new URL("lib/jiti-static.mjs", jitiPackage).href);
    const jiti = createJiti(pathToFileURL(process.cwd() + "/").href, { moduleCache: false, tryNative: false, virtualModules: host });
    const factory = await jiti.import(${JSON.stringify(extensionEntry)}, { default: true });
    assert.equal(typeof factory, "function");
    assert.deepEqual(leaked, [], "dist/ resolved Pi's packages from node_modules");
  `;
  runIsolated(script);
});

test("published extension probes the host SDK class even when a native sibling peer is resolvable", async () => {
  // Deliberately distinct from the natively importable peer. This models the
  // embedded host's virtual modules without hiding/removing the sibling SDK.
  class HostSession extends hostSdk.AgentSession {}
  class HostRunner extends hostSdk.ExtensionRunner {}
  const originalSend = hostSdk.AgentSession.prototype.sendCustomMessage;
  const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const jitiPackage = pathToFileURL(require.resolve("jiti/package.json"));
  const { createJiti } = await import(new URL("lib/jiti-static.mjs", jitiPackage).href);

  // Each load re-runs the entry, as after /reload in an embedded host; the compiled graph stays loaded.
  for (const generation of ["first", "reloaded"]) {
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      virtualModules: {
        "@earendil-works/pi-coding-agent": { ...hostSdk, AgentSession: HostSession, ExtensionRunner: HostRunner },
      },
    });
    const factory = await jiti.import(extensionEntry, { default: true });
    assert.equal(typeof factory, "function");
    assert.equal(Object.hasOwn(HostSession.prototype, "sendCustomMessage"), false, `${generation}: load hooks nothing`);

    const receiver = Object.create(HostSession.prototype);
    receiver.sessionManager = { getSessionId: () => `host-module-${generation}` };
    receiver.subscribe = () => () => {};
    const duringProbe: Array<{ hostHooked: boolean; siblingUntouched: boolean }> = [];
    let reachedRealSend: unknown;
    const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
    factory({
      registerTool: () => {},
      registerCommand: () => {},
      getCommands: () => [],
      on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) =>
        handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      getActiveTools: () => [],
      setActiveTools: () => {},
      sendMessage: (message: unknown, options: unknown) => {
        duringProbe.push({
          hostHooked: Object.hasOwn(HostSession.prototype, "sendCustomMessage"),
          siblingUntouched: hostSdk.AgentSession.prototype.sendCustomMessage === originalSend,
        });
        receiver.sendCustomMessage(message, options).catch((error: unknown) => {
          reachedRealSend = error;
        });
      },
    });
    handlers.get("session_start")?.[0]?.({ reason: "startup" }, sessionStartContext(`host-module-${generation}`));
    await tick();
    handlers.get("session_shutdown")?.[0]?.({ reason: "quit" });

    assert.deepEqual(
      duringProbe,
      [{ hostHooked: true, siblingUntouched: true }],
      `${generation}: one probe on the host`,
    );
    assert.equal(reachedRealSend, undefined, `${generation}: the probe never reaches the real send`);
    assert.equal(Object.hasOwn(HostSession.prototype, "sendCustomMessage"), false, `${generation}: nothing stacked`);
    assert.equal(hostSdk.AgentSession.prototype.sendCustomMessage, originalSend);
  }
});
