#!/usr/bin/env node
// Lint MCP Webstudio v1.0 action descriptions against the gold-standard template.
//
// v1.0 model:
//   - Top-level mega-tool description = short domain summary (50-300 chars).
//   - Each action's description (in the file's DESCRIPTIONS object) follows the
//     canonical template: Use when / Do NOT use when / Returns / Side effects / Example.
//
// Checks per mega-tool:
//   1. Name      — must NOT start with "webstudio_" (those are v0.4 internal handlers).
//   2. Top-level description length — 50-400 chars (brief summary).
// Checks per action:
//   3. Length    — error if <100, warning if <200.
//   4. Template  — must contain "Use when:", "Returns:", "Side effects:", "Example".
//                  "Do NOT use when:" warned if missing.
//   5. Patterns  — `pattern:"<slug>"` references must resolve to docs/patterns/<slug>.md.
//   6. Tool refs — webstudio_X mentions trigger a warning (v0.4 names obsolete).
//
// Exit codes: 0 if no errors (warnings printed), 1 if any error.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadToolNames } from "./lib/load-tool-names.mjs";

// fileURLToPath, not URL.pathname — the latter yields "/D:/..." on win32.
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");
const TOOLS_DIR = join(ROOT, "src/tools");
const PATTERNS_DIR = join(ROOT, "docs/patterns");

// ─── Load valid pattern slugs ───────────────────────────────────────────────
function loadValidPatternSlugs() {
  if (!existsSync(PATTERNS_DIR)) return new Set();
  const out = new Set();
  for (const entry of readdirSync(PATTERNS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.add(entry.name.replace(/\.md$/, ""));
    }
  }
  return out;
}

// ─── Resolve mega-tool file paths from src/index.ts imports ────────────────
function resolveMegaToolFiles() {
  const indexSrc = readFileSync(join(ROOT, "src/index.ts"), "utf8");
  const out = new Set();
  const importRe = /from\s+"\.\/tools\/([^"]+)\.js"/g;
  let m;
  while ((m = importRe.exec(indexSrc)) !== null) {
    const filePath = join(TOOLS_DIR, `${m[1]}.ts`);
    if (existsSync(filePath)) out.add(filePath);
  }
  return [...out];
}

// ─── Extract top-level tool name + description from a file source ──────────
function extractTopLevel(source) {
  // Match `definition: { name: "..." }` then the description template literal.
  const m = /definition\s*:\s*\{\s*name:\s*"([a-z][\w-]*)"\s*,?\s*description:\s*`([^`]*)`/s.exec(source);
  if (!m) return null;
  return { name: m[1], description: m[2] };
}

// ─── Extract per-action descriptions from the DESCRIPTIONS = {...} object ─
function extractActions(source) {
  // Match the DESCRIPTIONS object — supports `const DESCRIPTIONS = { ... }` and
  // `const D = { ... }` patterns. Returns array of {action, description}.
  const out = [];
  // Match the whole DESCRIPTIONS or D = { ... } block. Naive but works for our files.
  const blockMatch = /const\s+(?:DESCRIPTIONS|D)\s*=\s*\{([\s\S]*?)\n\}\s*;/s.exec(source);
  if (!blockMatch) return out;
  const block = blockMatch[1];
  // Each entry: `actionName: \` ... \`,`
  const entryRe = /^\s*(\w+):\s*`([\s\S]*?)`\s*,/gm;
  let m;
  while ((m = entryRe.exec(block)) !== null) {
    out.push({ action: m[1], description: m[2] });
  }
  return out;
}

// ─── Lint one action description ────────────────────────────────────────────
function lintAction({ action, description }, validPatterns) {
  const issues = [];
  const len = description.length;
  if (len < 100) {
    issues.push({ level: "error", msg: `Description too short (${len} chars, min 100)` });
  } else if (len < 200) {
    issues.push({ level: "warning", msg: `Description short (${len} chars, target ≥200)` });
  }

  const sections = [
    { key: "Use when:", re: /Use when:/, level: "error" },
    { key: "Do NOT use when:", re: /Do NOT use when:/i, level: "warning" },
    { key: "Returns:", re: /Returns:/i, level: "error" },
    { key: "Side effects:", re: /Side effects:/i, level: "error" },
    { key: "Example", re: /Example[:\s]/i, level: "error" },
  ];
  for (const s of sections) {
    if (!s.re.test(description)) {
      issues.push({ level: s.level, msg: `Missing "${s.key}" section` });
    }
  }

  // Pattern references must resolve.
  const patternRe = /pattern\s*[:=]\s*"([a-z][a-z0-9-]+)"/g;
  let pm;
  while ((pm = patternRe.exec(description)) !== null) {
    if (!validPatterns.has(pm[1])) {
      issues.push({ level: "error", msg: `pattern:"${pm[1]}" → docs/patterns/${pm[1]}.md does not exist` });
    }
  }

  // Cross-ref to obsolete webstudio_* names (warning).
  const obsoleteRe = /\bwebstudio_[a-z_]+\b/g;
  const matches = description.match(obsoleteRe);
  if (matches && matches.length > 0) {
    issues.push({
      level: "warning",
      msg: `References v0.4 names: ${[...new Set(matches)].slice(0, 3).join(", ")} (rephrase as mega-tool actions in v1.0)`,
    });
  }

  return issues;
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
  const validMegaNames = loadToolNames();
  const validPatterns = loadValidPatternSlugs();
  const megaFiles = resolveMegaToolFiles();

  let totalErrors = 0;
  let totalWarnings = 0;
  let megaToolsLinted = 0;
  let actionsLinted = 0;

  for (const file of megaFiles) {
    const source = readFileSync(file, "utf8");
    const top = extractTopLevel(source);
    if (!top) continue;
    if (!validMegaNames.has(top.name)) continue;

    megaToolsLinted += 1;
    const relFile = relative(ROOT, file);
    const issues = [];

    // 1. Naming
    if (top.name.startsWith("webstudio_")) {
      issues.push({ level: "error", msg: `Mega-tool name "${top.name}" still uses v0.4 prefix — drop "webstudio_"` });
    }

    // 2. Top-level description length (brief summary expected)
    const topLen = top.description.length;
    if (topLen < 50) {
      issues.push({ level: "error", msg: `Top-level description too short (${topLen} chars, min 50)` });
    } else if (topLen > 600) {
      issues.push({ level: "warning", msg: `Top-level description long (${topLen} chars) — should be a brief domain summary; details belong in actions[]` });
    }

    // 3+. Lint each action's description
    const actions = extractActions(source);
    for (const a of actions) {
      actionsLinted += 1;
      const actionIssues = lintAction(a, validPatterns);
      for (const i of actionIssues) issues.push({ ...i, action: a.action });
    }

    if (issues.length === 0) continue;

    console.log(`\n${top.name} (${relFile})`);
    for (const i of issues) {
      const tag = i.level === "error" ? "ERROR" : "WARN";
      const prefix = i.action ? `[${i.action}] ` : "";
      console.log(`  ${tag}: ${prefix}${i.msg}`);
      if (i.level === "error") totalErrors++;
      else totalWarnings++;
    }
  }

  console.log("");
  console.log(`Mega-tools linted: ${megaToolsLinted}/${validMegaNames.size}`);
  console.log(`Actions linted:    ${actionsLinted}`);
  console.log(`Errors: ${totalErrors}, Warnings: ${totalWarnings}`);

  process.exit(totalErrors > 0 ? 1 : 0);
}

main();
