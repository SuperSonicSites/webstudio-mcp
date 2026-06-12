#!/usr/bin/env node
// MCP server entry point — aggregates the tool modules.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolModule } from "./tools/types.js";
import { textResult } from "./tools/types.js";
import { toWireToolDefinition } from "./lib/mega-tool.js";
import { applyToolFilter } from "./lib/tool-filter.js";
import { listPatternResources, readPatternResource } from "./resources.js";
import { logTelemetry } from "./lib/telemetry.js";

// ─── Core meta / setup / fetch ─────────────────────────────────────────────
// buildFragmentTool, pushFragmentTool, createSheetTool, createNavigationMenuTool consolidated into buildTool
// helpersTool removed from registry in v0.4.0 — use webstudio_describe_pattern(helper:"<query>") instead.
// The SNIPPETS source remains in src/tools/helpers.ts and is imported by describe-pattern.ts.
// v1.0 mega-tools — auth + project + pages + read + meta
// (listTokensTool, defineTokenTool from projects.js are imported by tokens-mega.ts directly)
import { authTool } from "./tools/auth-mega.js";
import { projectTool } from "./tools/project-mega.js";
import { pagesTool } from "./tools/pages.js";
import { readTool } from "./tools/read-mega.js";
import { makeMetaTool } from "./tools/meta-mega.js";

// build mega-tool (consolidates buildFragmentTool + pushFragmentTool + createSheetTool + createNavigationMenuTool)
import { buildTool } from "./tools/build-mega.js";
import { instancesTool } from "./tools/instances-mega.js";

// ─── Variables & resources — v1.0 mega-tools (atomics consolidated, source files kept as internal handlers) ──
import { variablesTool } from "./tools/variables-mega.js";
import { resourcesTool } from "./tools/resources-mega.js";

// ─── Instances atomics — consolidated into instancesTool ──
// (all instance atomic source files kept as internal handlers, accessed by instancesTool)

// ─── Styles / tokens / cssvar — v1.0 mega-tools ──
import { stylesMegaTool } from "./tools/styles-mega.js";
import { tokensTool } from "./tools/tokens-mega.js";
import { cssvarTool } from "./tools/cssvar-mega.js";
// dedupeTokenLocalsTool, cleanupOrphanLocalsTool absorbed into tokensTool
// (actions:"dedupe_locals" and "cleanup_orphan_locals" — see tokens-mega.ts).

// ─── Pages atomic tools (legacy, consolidated into pagesTool — kept as internal handlers) ──

// ─── Assets — v1.0 mega-tool (5 atomics consolidated, source files kept as internal handlers) ──
import { assetsTool } from "./tools/assets.js";

// ─── Audit — v1.0 mega-tool (absorbs audit_page in action:"page") ──
import { auditMegaTool } from "./tools/audit-mega.js";

// ─── CMS — v1.0 mega-tool (Directus adapter, workstream #11) ──
import { cmsTool } from "./tools/cms-mega.js";

// ─── Project lifecycle (atomic source files — consolidated in projectTool mega-tool) ──

// NOTE: no per-tool action enumerations here — they drift (the 2026-06-10
// audit found 4 stale counts). The authoritative list is each mega-tool's
// xActions (live via meta.index) — comments below only state the domain.
const ALL_TOOLS: ToolModule[] = [
  authTool,                // local Webstudio credential management
  projectTool,             // project lifecycle (init / export / nuke / Figma import)
  readTool,                // read-only build inspection + canvas snapshots

  buildTool,               // fragment construction + push (cloud mutation entry point)
  instancesTool,           // instance tree operations (append/delete/clone/wrap/props…)

  pagesTool,               // page + folder lifecycle, project-level meta

  stylesMegaTool,          // LOCAL style declarations (tokens live in tokensTool)
  tokensTool,              // design token lifecycle (local registry + cloud)
  cssvarTool,              // project-level :root CSS variables

  variablesTool,           // in-page state variables
  resourcesTool,           // SSR HTTP resources (REST endpoints + dataSources)

  assetsTool,              // asset lifecycle (images, fonts — sha256-addressed)

  auditMegaTool,           // project audits (all READ-ONLY)

  cmsTool,                 // CMS integration (Directus adapter)
];

// Reduced surface mode (v2.15.0): WEBSTUDIO_MCP_TOOLS="meta,read,audit"
// registers only the named tools — safety + ~3x cheaper handshake for
// read-only routines. Unset = full surface (unchanged default).
const toolFilter = applyToolFilter(
  ALL_TOOLS.map((t) => t.definition.name),
  process.env.WEBSTUDIO_MCP_TOOLS,
);
const TOOLS: ToolModule[] = toolFilter.active
  ? ALL_TOOLS.filter((t) => toolFilter.keep.has(t.definition.name))
  : [...ALL_TOOLS];

// Prepend the meta mega-tool — ALWAYS registered (discovery is core); its
// index/guide reflect the filtered list via the closure.
TOOLS.unshift(makeMetaTool(() => TOOLS));

if (toolFilter.unknown.length > 0) {
  process.stderr.write(
    `[webstudio-mcp] WEBSTUDIO_MCP_TOOLS: unknown tool name(s) ignored: ${toolFilter.unknown.join(", ")} ` +
      `(known: meta, ${ALL_TOOLS.map((t) => t.definition.name).join(", ")})\n`,
  );
}
if (toolFilter.active && toolFilter.keep.size === 0) {
  process.stderr.write(
    `[webstudio-mcp] WEBSTUDIO_MCP_TOOLS matched no known tool — fail-safe: only "meta" is registered.\n`,
  );
}

const handlers = new Map(TOOLS.map((t) => [t.definition.name, t.handler]));

const SERVER_NAME = "webstudio";
const SERVER_VERSION = "2.21.1";

// MCP `instructions` — sent once at handshake (per the MCP spec, the host can
// surface these to the model as a system-level preamble). Use it for cross-cutting
// workflow guidance that's painful to learn one tool at a time. Keep terse:
// every agent pays this token cost on connect.
const SERVER_INSTRUCTIONS = `Webstudio MCP v${SERVER_VERSION} — workflow rules.

1. **Discovery first.** Before building or pushing ANY section/component, call \`meta.guide({brief:"..."})\` — returns the best pattern + matching high-level tool. Alternatives: \`meta.index\` (tool catalog), \`meta.list_patterns\` (recipe slugs). Guessing pattern slugs re-invents existing patterns.
2. **Read before mutating styles.** Call \`styles.get_decls\` on the target instance(s) before \`styles.update\` / \`tokens.update_token_styles\`. \`read.inspect\` returns style SOURCES (names + ids), NOT CSS values — without get_decls you cannot reason about the cascade (pattern inline-bg-image-overlay).
3. **Overlay over background image** → \`backgroundImage: { type:"layers", value:[gradient, image] }\` on the element itself. Do NOT nest absolute-positioned divs or fake it with \`box-shadow\`.
4. **Local vs token.** \`styles.update\` writes LOCAL overrides — for 2+ instances sharing decls, prefer \`tokens.create_tokens\` / \`tokens.update_token_styles\` then \`tokens.dedupe_locals\` (pattern component-architecture).
5. **Dry-run by default.** Most mutating tools default to \`dryRun: true\`. Inspect the patch list, then confirm pushes with \`build.push_staged({stageId})\` from the dry-run report — do NOT re-send the payload.
6. **Images = native \`Image\` component.** \`src\` accepts an asset id, a URL string, or an expression — NEVER \`ws:element\` with \`tag:"img"\`. Upload via \`assets.upload\` first when possible (pattern image-component).
7. **\`context\` policy.** Actions marked CRITICAL require \`context\`: 15-25 words, third person ("the caller wants…"), stating WHY. No PII (email/IP), no secrets (tokens/passwords/api keys), no first-person pronouns.
8. **Full action docs** (params, redirections, example): \`meta.get_more_tools({brief:"<tool>.<action>"})\`.
`;

// WEBSTUDIO_MCP_RESOURCES=0 (v2.21.0) drops the MCP resources capability —
// the 42-pattern listing costs ~6.6 kB per session, paid by EVERY connected
// instance. A second (filtered) instance in the same client has no use for a
// duplicate copy; patterns stay reachable in-band via meta.list_patterns /
// meta.describe_pattern. Deliberately independent of WEBSTUDIO_MCP_TOOLS — no
// implicit coupling between env vars; the README documents the recommended
// read-only combo (WEBSTUDIO_MCP_TOOLS=readonly WEBSTUDIO_MCP_RESOURCES=0).
const resourcesEnabled = process.env.WEBSTUDIO_MCP_RESOURCES !== "0";

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: resourcesEnabled ? { tools: {}, resources: {} } : { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  },
);

// Wire-schema economy (v2.12.0): the non-standard `xActions` metadata stays
// in-memory (meta mega-tool + guard tests read it from TOOLS) but is stripped
// from what clients receive — it duplicated every action description on the
// wire (~57k tokens measured for the 15-tool handshake in v2.11.0).
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => toWireToolDefinition(t.definition)),
}));

// MCP resources — expose docs/patterns/*.md at webstudio://patterns/<slug>.
// The LLM can cite a pattern passively (no tool call required) — Notion v2 / Linear pattern.
if (resourcesEnabled) {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listPatternResources().map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const result = readPatternResource(req.params.uri);
    if (!result) throw new Error(`Resource not found: ${req.params.uri}`);
    return result;
  });
}

// Claude Code sometimes serializes arrays/objects/booleans/numbers as JSON strings inside MCP parameters.
// We coerce string values back to their natural types before passing them to handlers.
function parseArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      if (v.startsWith("[") || v.startsWith("{")) {
        try { out[k] = JSON.parse(v); } catch { out[k] = v; }
      } else if (v === "true") {
        out[k] = true;
      } else if (v === "false") {
        out[k] = false;
      } else {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Telemetry — see src/lib/telemetry.ts. Opt-in via WEBSTUDIO_MCP_TELEMETRY=1.
// Two event families: "tool_call" (every MCP invocation) + "coerce" (silent
// server-side normalisations, emitted by lib/expand-shorthand.ts etc.).
// Used by scripts/telemetry-report.mjs to surface top coerces over time.

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = handlers.get(request.params.name);
  if (!handler) return textResult(`Unknown tool: ${request.params.name}`, true);
  const args = parseArgs(request.params.arguments ?? {});
  const startedAt = Date.now();
  try {
    const result = await handler(args);
    await logTelemetry({
      event: "tool_call",
      ts: new Date(startedAt).toISOString(),
      tool: request.params.name,
      args_keys: Object.keys(args),
      success: result.isError !== true,
      duration_ms: Date.now() - startedAt,
      error_class: result.isError ? "tool_error" : undefined,
    });
    return result;
  } catch (err) {
    await logTelemetry({
      event: "tool_call",
      ts: new Date(startedAt).toISOString(),
      tool: request.params.name,
      args_keys: Object.keys(args),
      success: false,
      duration_ms: Date.now() - startedAt,
      error_class: (err as Error)?.name ?? "exception",
    });
    throw err;
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Boot banner on stderr (stdout reserved for MCP framing). Surfaces the running
// version in `claude mcp logs` and host UIs that pipe stderr → debug pane.
const filterNote = toolFilter.active ? ` (WEBSTUDIO_MCP_TOOLS filter active — full surface: ${ALL_TOOLS.length + 1})` : "";
process.stderr.write(`[${SERVER_NAME}-mcp] v${SERVER_VERSION} started — ${TOOLS.length} tools registered${filterNote}\n`);
