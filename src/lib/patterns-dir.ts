// Single source of truth for locating docs/patterns/ (v2.21.0).
//
// Two divergent resolvers used to live in resources.ts and
// describe-pattern/long-patterns.ts. The candidate lists are layout-sensitive:
// when the server is bundled into a single bundle/index.js, this module's code
// sits ONE level below the package root — the old long-patterns resolver
// (../../../docs) walked above the package root and silently fell back to
// process.cwd(), which is wrong under Claude Desktop.
//
// Candidates cover every layout this module can be evaluated from:
//   bundle/index.js                 → ../docs/patterns
//   dist/lib/patterns-dir.js        → ../../docs/patterns
//   src/lib/patterns-dir.ts (ts-node) → ../../docs/patterns
//   cwd fallback (npm-installed package run from the repo)

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null | undefined;

export function findPatternsDir(): string | null {
  if (cached !== undefined) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../docs/patterns"),
    resolve(here, "../../docs/patterns"),
    resolve(process.cwd(), "docs/patterns"),
  ];
  for (const p of candidates) {
    try {
      if (statSync(p).isDirectory()) return (cached = p);
    } catch { /* skip */ }
  }
  return (cached = null);
}
