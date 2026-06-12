// v2.15.0 — reduced tool-surface mode (WEBSTUDIO_MCP_TOOLS).
//
// Safety + context economy for headless routines: a read-only cron has no
// business mounting mutation tools, and a 3-tool surface costs ~8k tokens
// instead of ~26k. Pure-function tests + one end-to-end spawn of the real
// server with the env var set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { applyToolFilter } from "../dist/lib/tool-filter.js";

const KNOWN = ["auth", "project", "read", "build", "audit", "tokens"];

// ── applyToolFilter (pure) ──────────────────────────────────────────────────

test("unset / empty / whitespace env → inactive, full surface", () => {
  for (const v of [undefined, "", "   "]) {
    const r = applyToolFilter(KNOWN, v);
    assert.equal(r.active, false);
    assert.deepEqual([...r.keep].sort(), [...KNOWN].sort());
    assert.deepEqual(r.unknown, []);
  }
});

test("filters by name — trimmed, case-insensitive, original casing kept", () => {
  const r = applyToolFilter(KNOWN, "  READ , Audit,tokens ");
  assert.equal(r.active, true);
  assert.deepEqual([...r.keep].sort(), ["audit", "read", "tokens"]);
  assert.deepEqual(r.unknown, []);
});

test("'meta' in the list is accepted silently (always registered anyway)", () => {
  const r = applyToolFilter(KNOWN, "meta,read");
  assert.deepEqual([...r.keep], ["read"]);
  assert.deepEqual(r.unknown, []);
});

test("unknown names are collected, valid ones still apply", () => {
  const r = applyToolFilter(KNOWN, "read,bogus,instnaces");
  assert.deepEqual([...r.keep], ["read"]);
  assert.deepEqual(r.unknown, ["bogus", "instnaces"]);
});

test("all-unknown filter → keep is empty (fail-safe: caller registers meta only)", () => {
  const r = applyToolFilter(KNOWN, "bogus,nope");
  assert.equal(r.active, true);
  assert.equal(r.keep.size, 0);
  assert.deepEqual(r.unknown, ["bogus", "nope"]);
});

// ── named presets (v2.21.0) ─────────────────────────────────────────────────

test("preset 'readonly' expands to meta+read+audit", () => {
  const r = applyToolFilter(KNOWN, "readonly");
  assert.equal(r.active, true);
  assert.deepEqual([...r.keep].sort(), ["audit", "read"]);
  assert.deepEqual(r.unknown, []);
});

test("presets are case-insensitive", () => {
  const r = applyToolFilter(KNOWN, " ReadOnly ");
  assert.deepEqual([...r.keep].sort(), ["audit", "read"]);
});

test("presets compose with explicit names", () => {
  const r = applyToolFilter(KNOWN, "readonly,tokens");
  assert.deepEqual([...r.keep].sort(), ["audit", "read", "tokens"]);
  assert.deepEqual(r.unknown, []);
});

test("preset members unknown to this server are reported, not fatal", () => {
  // 'builder' includes instances/styles which are not in KNOWN here.
  const r = applyToolFilter(KNOWN, "builder");
  assert.deepEqual([...r.keep].sort(), ["build", "read", "tokens"]);
  assert.deepEqual(r.unknown.sort(), ["instances", "styles"]);
});

// ── end-to-end: real server with the filter active ──────────────────────────

function fetchToolsList(env) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["dist/index.js"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("no tools/list answer within 15s")); }, 15_000);
    let buf = "";
    const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        }
        if (msg.id === 2) { clearTimeout(timer); proc.kill(); resolve(msg.result); }
      }
    });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tool-filter-test", version: "1.0" } },
    });
  });
}

test("WEBSTUDIO_MCP_TOOLS=read,audit → server registers exactly meta+read+audit", async () => {
  const result = await fetchToolsList({ WEBSTUDIO_MCP_TOOLS: "read,audit" });
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["audit", "meta", "read"]);
});

test("WEBSTUDIO_MCP_TOOLS=readonly (preset) → same surface as meta+read+audit", async () => {
  const result = await fetchToolsList({ WEBSTUDIO_MCP_TOOLS: "readonly" });
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["audit", "meta", "read"]);
});
