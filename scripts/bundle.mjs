#!/usr/bin/env node
// Bundle the compiled server into a single ESM file (v2.21.0).
//
// Why: "npx -y @densrt/webstudio-mcp" re-validates the whole installed tree on
// every launch — measured ~13 s warm with 106 packages / 3,890 files, of which
// ~950 ms of direct-node boot was ESM resolution fs work across ~470 modules.
// Shipping ONE file with all deps inlined collapses the install to the package
// itself and removes per-module resolution at boot.
//
// Bundles dist/ (the compiled output) — tsc stays the single type gate and the
// 80+ test files keep deep-importing dist/. The bundle is a SEPARATE artifact:
// bin/main point at bundle/index.js; dist/ is not shipped.
//
// playwright-core stays EXTERNAL: it is an optional, dynamically-imported
// peer (read.snapshot + browser version recovery). The dynamic import must
// survive as a real runtime import that resolves from the consumer's
// node_modules when present.

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const outfile = join(root, "bundle", "index.js");
mkdirSync(join(root, "bundle"), { recursive: true });

const result = await build({
  entryPoints: [join(root, "dist", "index.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  external: ["playwright-core"],
  metafile: true,
  // ESM-bundle shim: some deps (and the MCP SDK's ajv chain) use CJS
  // require/__dirname idioms that esbuild preserves under format:"esm".
  banner: {
    js: [
      "import { createRequire as __wsmCreateRequire } from 'node:module';",
      "import { fileURLToPath as __wsmFileURLToPath } from 'node:url';",
      "import { dirname as __wsmDirname } from 'node:path';",
      "const require = __wsmCreateRequire(import.meta.url);",
      "const __filename = __wsmFileURLToPath(import.meta.url);",
      "const __dirname = __wsmDirname(__filename);",
    ].join("\n"),
  },
});

// Sanity checks the CI smoke also relies on.
const out = readFileSync(outfile, "utf8");
if (!out.startsWith("#!/usr/bin/env node")) {
  // esbuild preserves the entry hashbang; fail loudly if that ever changes.
  writeFileSync(outfile, "#!/usr/bin/env node\n" + out);
}
const shebangCount = (out.match(/^#!\/usr\/bin\/env node/gm) ?? []).length;
if (shebangCount > 1) {
  console.error(`bundle: ${shebangCount} shebang lines found — expected 1`);
  process.exit(1);
}
if (!/import\(["']playwright-core["']\)/.test(out)) {
  console.error("bundle: dynamic import of playwright-core was rewritten — it must stay external");
  process.exit(1);
}

const inputs = Object.keys(result.metafile.inputs).length;
const bytes = Buffer.byteLength(out);
console.log(`bundle/index.js: ${(bytes / 1024).toFixed(0)} kB from ${inputs} modules (playwright-core external)`);
