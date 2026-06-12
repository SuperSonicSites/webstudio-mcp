// v2.21.0 — unified docs/patterns resolver (lib/patterns-dir).
// Guards the bundle-layout regression class: a resolver that walks above the
// package root silently falls back to process.cwd(), which is wrong under
// Claude Desktop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

import { findPatternsDir } from "../dist/lib/patterns-dir.js";
import { listPatternResources } from "../dist/resources.js";
import { LONG_PATTERN_DOCS } from "../dist/tools/describe-pattern/long-patterns.js";

test("findPatternsDir resolves from the dist layout", () => {
  const dir = findPatternsDir();
  assert.ok(dir, "patterns dir must resolve");
  const mdCount = readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  assert.ok(mdCount >= 40, `expected >=40 pattern docs, got ${mdCount}`);
});

test("resources and describe-pattern agree on the same pattern set", () => {
  const resources = listPatternResources();
  const longPatterns = Object.keys(LONG_PATTERN_DOCS);
  assert.ok(resources.length >= 40, `resources: ${resources.length}`);
  assert.equal(resources.length, longPatterns.length, "both consumers must see the same dir");
});
