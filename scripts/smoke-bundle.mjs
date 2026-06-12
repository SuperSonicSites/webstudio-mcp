#!/usr/bin/env node
// Smoke-test the bundled server over real stdio (v2.21.0).
//
// Catches the regression classes a single-file bundle introduces:
//   - module-graph breakage (server fails to boot at all),
//   - import.meta.url-relative resolution (pattern resources must list 42 docs
//     from the bundle/ layout — the long-patterns resolver class),
//   - wire regressions (15 tools with intact schemas).
//
// Exit 0 on success; nonzero with a reason otherwise.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const entry = process.argv[2] ?? join(root, "bundle", "index.js");

const MIN_TOOLS = 15;
const MIN_RESOURCES = 40;

const p = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
p.stderr.on("data", (d) => (stderr += d));

const timeout = setTimeout(() => {
  console.error(`smoke: TIMEOUT after 30s. stderr:\n${stderr}`);
  p.kill();
  process.exit(1);
}, 30_000);

const send = (msg) => p.stdin.write(JSON.stringify(msg) + "\n");
const t0 = Date.now();
let buf = "";
let seenInit = false;
let seenTools = false;

p.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1 && !seenInit) {
      seenInit = true;
      console.log(`smoke: initialize OK in ${Date.now() - t0} ms (instructions ${msg.result.instructions?.length ?? 0} chars)`);
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    } else if (msg.id === 2 && !seenTools) {
      seenTools = true;
      const tools = msg.result.tools ?? [];
      const bytes = Buffer.byteLength(JSON.stringify(tools));
      console.log(`smoke: tools/list OK — ${tools.length} tools, ${bytes} B`);
      if (tools.length < MIN_TOOLS) {
        console.error(`smoke: expected >=${MIN_TOOLS} tools, got ${tools.length}`);
        process.exit(1);
      }
      const broken = tools.filter((t) => !t.inputSchema?.properties?.action && t.name !== "meta");
      if (broken.length > 0) {
        console.error(`smoke: tools without action schema: ${broken.map((t) => t.name).join(", ")}`);
        process.exit(1);
      }
      send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    } else if (msg.id === 3) {
      const n = msg.result.resources?.length ?? 0;
      console.log(`smoke: resources/list OK — ${n} pattern resources`);
      clearTimeout(timeout);
      p.kill();
      if (n < MIN_RESOURCES) {
        console.error(`smoke: expected >=${MIN_RESOURCES} pattern resources, got ${n} — docs/ resolution is broken in this layout`);
        process.exit(1);
      }
      process.exit(0);
    }
  }
});

send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-bundle", version: "0" } },
});
