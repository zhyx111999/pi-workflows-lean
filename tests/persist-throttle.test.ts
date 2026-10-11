import assert from "node:assert/strict";
import test from "node:test";
import { PersistThrottle } from "../src/manager/persist-throttle.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("one pending write per run serves every request before it", async () => {
  const throttle = new PersistThrottle();
  let writes = 0;
  for (let i = 0; i < 5; i++) throttle.schedule("r", () => writes++, 20);
  await sleep(60);
  assert.equal(writes, 1);
});

test("a shorter window moves the pending write earlier; a longer one joins it", async () => {
  const throttle = new PersistThrottle();
  const writes: number[] = [];
  const started = Date.now();
  throttle.schedule("r", () => writes.push(Date.now() - started), 5_000);
  throttle.schedule("r", () => writes.push(Date.now() - started), 20);
  throttle.schedule("r", () => writes.push(Date.now() - started), 5_000);
  await sleep(80);
  assert.equal(writes.length, 1, "the burst write replaced the progress write");
  assert.ok(writes[0] < 1_000, `written after ${writes[0]}ms, not the progress window`);
  throttle.cancel("r");
});

test("cancel drops the pending write", async () => {
  const throttle = new PersistThrottle();
  let writes = 0;
  throttle.schedule("r", () => writes++, 20);
  throttle.cancel("r");
  await sleep(50);
  assert.equal(writes, 0);
});
