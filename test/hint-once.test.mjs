// v2.20.3 — hintOnce: per-process rate limiting for pedagogical hints.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { hintOnce, resetHintCounters } = await import("../dist/lib/hint-once.js");

beforeEach(() => resetHintCounters());

test("emits on the first call, suppresses until every Nth", () => {
  assert.equal(hintOnce("k", "HINT", 5), "HINT");
  assert.equal(hintOnce("k", "HINT", 5), "");
  assert.equal(hintOnce("k", "HINT", 5), "");
  assert.equal(hintOnce("k", "HINT", 5), "");
  assert.equal(hintOnce("k", "HINT", 5), "HINT", "5th call re-emits");
  assert.equal(hintOnce("k", "HINT", 5), "");
});

test("keys are independent", () => {
  assert.equal(hintOnce("a", "A"), "A");
  assert.equal(hintOnce("b", "B"), "B");
  assert.equal(hintOnce("a", "A"), "");
});

test("default everyN is 10", () => {
  assert.equal(hintOnce("d", "X"), "X");
  for (let i = 2; i <= 9; i++) assert.equal(hintOnce("d", "X"), "", `call ${i} suppressed`);
  assert.equal(hintOnce("d", "X"), "X", "10th call re-emits");
});
