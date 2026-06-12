// Wire-payload measurement: loads dist tool modules directly and computes the
// exact tools/list bytes a client pays per session (deduped, xActions-stripped),
// plus a breakdown of description prose, enums, anyOf forks, $defs reuse.
//
//   node scripts/measure-wire.mjs          # compact per-tool summary + totals
//   node scripts/measure-wire.mjs --full   # full JSON report
//
// Promoted from the 2026-06-11 audit's scratch analysis; use it to record
// byte deltas in commit messages.
import { Buffer } from "node:buffer";

const B = (v) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");

const { toWireToolDefinition } = await import("../dist/lib/mega-tool.js");
const { makeMetaTool } = await import("../dist/tools/meta-mega.js");

const mods = [
  ["auth", "../dist/tools/auth-mega.js", "authTool"],
  ["project", "../dist/tools/project-mega.js", "projectTool"],
  ["read", "../dist/tools/read-mega.js", "readTool"],
  ["build", "../dist/tools/build-mega.js", "buildTool"],
  ["instances", "../dist/tools/instances-mega.js", "instancesTool"],
  ["pages", "../dist/tools/pages.js", "pagesTool"],
  ["styles", "../dist/tools/styles-mega.js", "stylesMegaTool"],
  ["tokens", "../dist/tools/tokens-mega.js", "tokensTool"],
  ["cssvar", "../dist/tools/cssvar-mega.js", "cssvarTool"],
  ["variables", "../dist/tools/variables-mega.js", "variablesTool"],
  ["resources", "../dist/tools/resources-mega.js", "resourcesTool"],
  ["assets", "../dist/tools/assets.js", "assetsTool"],
  ["audit", "../dist/tools/audit-mega.js", "auditMegaTool"],
  ["cms", "../dist/tools/cms-mega.js", "cmsTool"],
];

function walk(node, fn, path = "$") {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, fn, `${path}[${i}]`));
  } else if (node && typeof node === "object") {
    fn(node, path);
    for (const [k, v] of Object.entries(node)) walk(v, fn, `${path}.${k}`);
  }
}

// Load the 14 static tools, then prepend meta exactly like src/index.ts does.
const loaded = [];
for (const [name, path, exp] of mods) {
  const mod = await import(path);
  loaded.push({ name, tool: mod[exp] });
}
const toolModules = loaded.map((l) => l.tool);
const metaTool = makeMetaTool(() => toolModules);
toolModules.unshift(metaTool);
loaded.unshift({ name: "meta", tool: metaTool });

const report = [];
const defBodiesGlobal = new Map(); // json -> {bytes, tools:Set}

for (const { name, tool: def } of loaded) {
  const inMem = def.definition;
  const wire = toWireToolDefinition(inMem);
  const schema = wire.inputSchema;

  // description prose inside the wire schema
  let descBytes = 0, descCount = 0, maxDesc = 0, maxDescPath = "";
  let enumStats = [];
  let anyOfForks = [];
  walk(schema, (n, p) => {
    if (typeof n.description === "string") {
      const b = B(n.description);
      descBytes += b; descCount += 1;
      if (b > maxDesc) { maxDesc = b; maxDescPath = p; }
    }
    if (Array.isArray(n.enum)) {
      enumStats.push({ path: p, size: n.enum.length, bytes: B(n.enum) });
    }
    if (Array.isArray(n.anyOf)) {
      anyOfForks.push({ path: p, variants: n.anyOf.length, bytes: B(n.anyOf) });
    }
    if (n.default !== undefined && B(n.default) > 100) {
      anyOfForks.push({ path: p + " (LARGE default)", variants: 0, bytes: B(n.default) });
    }
  });
  enumStats.sort((a, b) => b.bytes - a.bytes);
  anyOfForks.sort((a, b) => b.bytes - a.bytes);

  const props = schema.properties ?? {};
  const propSizes = Object.entries(props)
    .map(([k, v]) => ({ key: k, bytes: B(v) }))
    .sort((a, b) => b.bytes - a.bytes);

  const defs = schema.$defs ?? {};
  const defSizes = Object.entries(defs)
    .map(([k, v]) => ({ def: k, bytes: B(v) }))
    .sort((a, b) => b.bytes - a.bytes);
  for (const [k, v] of Object.entries(defs)) {
    const j = JSON.stringify(v);
    if (!defBodiesGlobal.has(j)) defBodiesGlobal.set(j, { bytes: B(v), tools: new Set() });
    defBodiesGlobal.get(j).tools.add(name);
  }

  // count $ref usages
  let refCount = 0;
  walk(schema, (n) => { if (typeof n.$ref === "string") refCount += 1; });

  const inMemSchemaBytes = B(inMem.inputSchema);
  const { xActions, ...inMemNoX } = inMem.inputSchema;
  const inMemNoXBytes = B(inMemNoX);
  const xActionsBytes = B(xActions ?? []);

  report.push({
    tool: name,
    actions: (xActions ?? []).length,
    wireToolBytes: B(wire),
    wireSchemaBytes: B(schema),
    inMemSchemaBytes,
    xActionsBytes,
    preDedupBytes: inMemNoXBytes,
    dedupSavedBytes: inMemNoXBytes - B(schema),
    toolDescriptionBytes: B(wire.description ?? ""),
    actionEnumDescBytes: B(props.action?.description ?? ""),
    schemaDescriptionProse: { totalBytes: descBytes, count: descCount, maxBytes: maxDesc, maxPath: maxDescPath },
    propCount: Object.keys(props).length,
    topProps: propSizes.slice(0, 6),
    defs: { count: defSizes.length, totalBytes: defSizes.reduce((s, d) => s + d.bytes, 0), top: defSizes.slice(0, 5), refCount },
    topEnums: enumStats.slice(0, 5),
    anyOfForks: anyOfForks.slice(0, 6),
  });
}

// cross-tool duplicated def bodies
const crossDup = [...defBodiesGlobal.entries()]
  .filter(([, v]) => v.tools.size >= 2)
  .map(([j, v]) => ({ bytes: v.bytes, tools: [...v.tools], preview: j.slice(0, 120) }))
  .sort((a, b) => b.bytes * b.tools.length - a.bytes * a.tools.length);

const totals = {
  tools: report.length,
  wireTotal: report.reduce((s, r) => s + r.wireToolBytes, 0),
  preDedupTotal: report.reduce((s, r) => s + r.preDedupBytes + r.toolDescriptionBytes, 0),
  xActionsTotalStripped: report.reduce((s, r) => s + r.xActionsBytes, 0),
  proseTotal: report.reduce((s, r) => s + r.schemaDescriptionProse.totalBytes, 0),
  totalActions: report.reduce((s, r) => s + r.actions, 0),
};

if (process.argv.includes("--full")) {
  console.log(JSON.stringify({ totals, crossDupTop: crossDup.slice(0, 12), report }, null, 1));
} else {
  const pad = (s, n) => String(s).padStart(n);
  console.log("tool        wire B   actions  prose B");
  for (const r of [...report].sort((a, b) => b.wireToolBytes - a.wireToolBytes)) {
    console.log(`${r.tool.padEnd(11)}${pad(r.wireToolBytes, 7)}${pad(r.actions, 9)}${pad(r.schemaDescriptionProse.totalBytes, 9)}`);
  }
  console.log("─".repeat(36));
  console.log(
    `TOTAL tools/list wire: ${totals.wireTotal} B (~${Math.round(totals.wireTotal / 4 / 100) / 10}k tokens) — ` +
    `${totals.tools} tools, ${totals.totalActions} actions, prose ${totals.proseTotal} B`,
  );
}
