// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"local-styles").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"local-styles", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_local_styles
//
// Project-wide scan of LOCAL style declarations (not tokens). Groups by
// (property, value) and reports counts so we can spot:
//   - Recurring hardcoded values that should become tokens / CSS vars
//   - Outliers (e.g. one local color="#FFF" while everywhere else uses var)
//
// Read-only.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import { scanLocalStyles, type ScanArgs } from "./audit-local-styles/scan.js";

export const auditLocalStylesInputSchema = z.object({
  projectSlug: z.string(),
  property: z.string().optional(),
  family: z.enum(["spacing", "color", "typography", "radius", "layout", "all"]).default("all"),
  pageId: z.string().optional(),
  pagePath: z.string().optional(),
  instanceLabel: z.string().optional(),
  component: z.string().optional(),
  tag: z.string().optional(),
  breakpoint: z.string().optional(),
  minCount: z.number().int().min(1).default(2),
  topN: z.number().int().min(1).max(500).default(30),
  verbose: z.boolean().default(false),
  excludeKeywords: z.boolean().default(true),
}).strict();

export const auditLocalStylesTool: ToolModule = {
  definition: {
    name: "webstudio_audit_local_styles",
    description: `Use when: you want to find recurring hardcoded local style values that should become tokens or CSS vars.
Project-wide scan of LOCAL decls grouped by (property, value) with counts. Filters: property, family
(spacing|color|typography|radius|layout|all), pageId|pagePath, instanceLabel|component|tag, breakpoint,
minCount (default 2 = recurring), topN (default 30), verbose.
excludeKeywords (default true) hides layout keywords (display:flex, position:relative, etc.) and
semantic zeros (0px on resets) which can't be tokenized — set false to see the full noise.
Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        property: { type: "string" },
        family: { type: "string", enum: ["spacing", "color", "typography", "radius", "layout", "all"] },
        pageId: { type: "string" },
        pagePath: { type: "string" },
        instanceLabel: { type: "string" },
        component: { type: "string" },
        tag: { type: "string" },
        breakpoint: { type: "string" },
        minCount: { type: "number" },
        topN: { type: "number" },
        verbose: { type: "boolean" },
        excludeKeywords: { type: "boolean", description: "Hide pure-layout keywords + semantic zeros (default true)." },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditLocalStylesInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const data = parsed.data;

    let auth;
    try { auth = requireAuth(data.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    let r;
    try { r = scanLocalStyles(build, data as ScanArgs); }
    catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("Page not found")) return errorResult("PAGE_NOT_FOUND", msg);
      if (msg.startsWith("Breakpoint not found")) return errorResult("VALIDATION_FAILED", msg);
      return errorResult("INTERNAL_ERROR", msg);
    }

    const lines: string[] = [];
    lines.push(`# Local styles audit — project ${data.projectSlug}`);
    lines.push(`Scanned local decls: ${r.totalScanned} | Distinct (prop,value) groups: ${r.totalGroups} | Recurring (≥${data.minCount}): ${r.recurringGroups} | Hardcoded decls in recurring groups: ${r.hardcodedRecurring}`);
    lines.push("");
    if (r.sorted.length === 0) {
      lines.push("(nothing recurring under current filters)");
    } else {
      lines.push(`## Top ${r.sorted.length} recurring values`);
      for (const g of r.sorted) {
        const flag = g.hardcoded ? "🔶 hardcoded" : "🟢 var()";
        lines.push(`  ${flag}  ${g.property} = ${g.valueStr}  ×${g.count}`);
        if (data.verbose) {
          for (const s of g.samples) lines.push(`      • [${s.instanceId}] "${s.instanceLabel}" @${s.breakpoint}`);
          if (g.count > g.samples.length) lines.push(`      … (+${g.count - g.samples.length} more)`);
        }
      }
    }
    return textResult(lines.join("\n"));
  },
};
