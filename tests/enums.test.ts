import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityClassification, CapabilityOrigin, CapabilitySupport, DiagnosticSeverity } from "../src/enums.js";

test("capability contract enums preserve their wire values", () => {
  assert.deepEqual(Object.values(CapabilityClassification), [
    "runtime-global",
    "subagents-tool-input",
    "script-contract",
    "compatibility-behavior",
    "internal-substrate",
    "dynamic-reference",
  ]);
  assert.deepEqual(Object.values(CapabilitySupport), ["supported", "compatibility", "internal"]);
  assert.deepEqual(Object.values(CapabilityOrigin), ["project", "tool-adapter", "vm-realm", "live-configuration"]);
  assert.deepEqual(Object.values(DiagnosticSeverity), ["error", "warning"]);
});
