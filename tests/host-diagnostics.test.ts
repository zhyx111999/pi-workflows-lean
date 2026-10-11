import assert from "node:assert/strict";
import test from "node:test";
import { bindDiagnosticSink, reportDiagnostic } from "../src/host-diagnostics.js";

test("diagnostics go to the bound sink, with their cause, and to stderr once released", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const shown: string[] = [];
  const release = bindDiagnosticSink((message) => shown.push(message));
  reportDiagnostic("Could not save workflow run r1", new Error("disk full"));
  assert.deepEqual(shown, ["Could not save workflow run r1: disk full"]);
  assert.equal(warn.mock.callCount(), 0, "a bound UI keeps raw output off the TUI");

  release();
  reportDiagnostic("after release");
  assert.deepEqual(shown, ["Could not save workflow run r1: disk full"]);
  assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["[workflow] after release"]);
});

test("a release from an older binding leaves a newer binding in place", () => {
  const first: string[] = [];
  const second: string[] = [];
  const releaseFirst = bindDiagnosticSink((message) => first.push(message));
  const releaseSecond = bindDiagnosticSink((message) => second.push(message));
  releaseFirst();
  reportDiagnostic("for the newer session");
  releaseSecond();
  assert.deepEqual(first, []);
  assert.deepEqual(second, ["for the newer session"]);
});

test("a sink that throws (a stale session UI) falls back to stderr", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const release = bindDiagnosticSink(() => {
    throw new Error("stale ctx");
  });
  try {
    reportDiagnostic("still recorded");
  } finally {
    release();
  }
  assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["[workflow] still recorded"]);
});
