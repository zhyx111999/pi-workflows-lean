import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { HOST_PACKAGES } from "../src/host-modules.js";

const DIST = join(import.meta.dirname, "../dist");

function distFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return distFiles(path);
    return entry.name.endsWith(".js") ? [path] : [];
  });
}

test("every Pi package the compiled modules import at run time is routed to the running Pi", () => {
  // Built by npm run test:unit; type-only imports are gone from dist/.
  const imported = new Set<string>();
  for (const file of distFiles(DIST)) {
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(/(?:from|import\()\s*"([^"]+)"/g)) {
      if (/^(@earendil-works\/|@mariozechner\/|typebox)/.test(specifier)) imported.add(specifier);
    }
  }
  assert.deepEqual([...imported].sort(), [...HOST_PACKAGES].sort());
});

test("the extension entry imports every routed package from Pi's loader", () => {
  const entry = readFileSync(join(import.meta.dirname, "../extensions/workflow.ts"), "utf8");
  const imported = [...entry.matchAll(/^import \* as \w+ from "([^"]+)";$/gm)].map(([, specifier]) => specifier);
  assert.deepEqual(imported.sort(), [...HOST_PACKAGES].sort());
});
