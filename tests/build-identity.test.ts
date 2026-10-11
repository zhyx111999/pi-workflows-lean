import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildIdentityOnDisk, LOADED_BUILD, loadedBuildIsStale } from "../src/build-identity.js";

function withPackage(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pi-dw-build-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "a.js"), "export const a = 1;");
    writeFileSync(join(root, "nested", "b.js"), "export const b = 1;");
    writeFileSync(join(root, "types.d.ts"), "export declare const a: number;");
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the build identity follows module content, not timestamps or declarations", () => {
  withPackage((root) => {
    const before = buildIdentityOnDisk(root);
    assert.ok(before);
    utimesSync(join(root, "a.js"), new Date(0), new Date(0));
    writeFileSync(join(root, "types.d.ts"), "export declare const a: string;");
    assert.equal(buildIdentityOnDisk(root), before, "a touched file or a changed declaration is the same build");
    writeFileSync(join(root, "nested", "b.js"), "export const b = 2;");
    assert.notEqual(buildIdentityOnDisk(root), before, "changed code is a new build");
  });
});

test("the loaded build is stale only when the package on disk differs from it", () => {
  assert.notEqual(LOADED_BUILD, "unknown");
  assert.equal(loadedBuildIsStale(), false, "the running code is what is on disk");
  withPackage((root) => {
    assert.equal(loadedBuildIsStale(root), true, "different code on disk is a newer build");
  });
  assert.equal(loadedBuildIsStale(join(tmpdir(), "pi-dw-missing-build")), false, "unreadable code is not reported");
});
