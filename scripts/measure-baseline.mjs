#!/usr/bin/env node
// Measure baseline metrics on the MCP tool manifest.
// Rough token estimation: chars / 4. Good enough for trend tracking.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — the latter yields "/D:/..." on win32.
const TOOLS_DIR = fileURLToPath(new URL("../src/tools", import.meta.url));

// Find every file that contains `definition: {`
function findToolFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findToolFiles(p));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Extract every `name: "webstudio_..."` and the surrounding description text.
function extractTools(source) {
  const out = [];
  // Match the whole ToolModule export block roughly.
  const re = /name:\s*"(webstudio_[a-z_]+)"[\s\S]*?description:\s*`([^`]+)`/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({ name: m[1], description: m[2] });
  }
  return out;
}

const files = findToolFiles(TOOLS_DIR);
const allTools = [];

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const tools = extractTools(src);
  for (const t of tools) {
    allTools.push({ ...t, file: f.replace(TOOLS_DIR + "/", "") });
  }
}

// Dedupe by name (some files have multiple tools).
const byName = new Map();
for (const t of allTools) {
  if (!byName.has(t.name)) byName.set(t.name, t);
}
const tools = [...byName.values()];

// Stats
const chars = tools.map((t) => t.description.length).sort((a, b) => a - b);
const totalChars = chars.reduce((a, b) => a + b, 0);
const totalTokens = Math.round(totalChars / 4);
const median = chars[Math.floor(chars.length / 2)];
const p95 = chars[Math.floor(chars.length * 0.95)];
const min = chars[0];
const max = chars[chars.length - 1];

// Score by length bucket
const under200 = chars.filter((c) => c < 200).length;
const between200_450 = chars.filter((c) => c >= 200 && c < 450).length;
const between450_700 = chars.filter((c) => c >= 450 && c < 700).length;
const over700 = chars.filter((c) => c >= 700).length;

// "Use when / Do NOT use when / Returns / Side effects / Example" coverage
const hasUseWhen = tools.filter((t) => /Use when:/i.test(t.description)).length;
const hasDoNotUse = tools.filter((t) => /Do NOT use when:/i.test(t.description)).length;
const hasReturns = tools.filter((t) => /Returns:/i.test(t.description)).length;
const hasSideEffects = tools.filter((t) => /Side effects:/i.test(t.description)).length;
const hasExample = tools.filter((t) => /Example/i.test(t.description)).length;

console.log("=== Webstudio MCP — Baseline Metrics ===");
console.log("Generated:", new Date().toISOString());
console.log("");
console.log("Tools found:", tools.length);
console.log("Description size (chars):");
console.log("  total:", totalChars);
console.log("  approx tokens (chars/4):", totalTokens);
console.log("  min:", min, "max:", max, "median:", median, "p95:", p95);
console.log("");
console.log("Length buckets:");
console.log("  < 200 chars (too short):", under200);
console.log("  200-450 chars (target):", between200_450);
console.log("  450-700 chars (rich):", between450_700);
console.log("  > 700 chars (critical):", over700);
console.log("");
console.log("Template coverage:");
console.log(`  Use when:        ${hasUseWhen}/${tools.length} (${Math.round(100 * hasUseWhen / tools.length)}%)`);
console.log(`  Do NOT use when: ${hasDoNotUse}/${tools.length} (${Math.round(100 * hasDoNotUse / tools.length)}%)`);
console.log(`  Returns:         ${hasReturns}/${tools.length} (${Math.round(100 * hasReturns / tools.length)}%)`);
console.log(`  Side effects:    ${hasSideEffects}/${tools.length} (${Math.round(100 * hasSideEffects / tools.length)}%)`);
console.log(`  Example:         ${hasExample}/${tools.length} (${Math.round(100 * hasExample / tools.length)}%)`);
console.log("");
console.log("Top 5 longest descriptions:");
const sorted = [...tools].sort((a, b) => b.description.length - a.description.length);
for (const t of sorted.slice(0, 5)) {
  console.log(`  ${t.description.length} chars — ${t.name}`);
}
console.log("");
console.log("Top 5 shortest descriptions:");
for (const t of sorted.slice(-5).reverse()) {
  console.log(`  ${t.description.length} chars — ${t.name}`);
}
