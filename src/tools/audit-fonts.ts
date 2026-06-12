// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"fonts").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"fonts", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_fonts — project-wide perf audit on uploaded fonts.
//
// Cross-references build.assets (uploaded fonts) with build.styles (font-family +
// font-weight actually used) and HtmlEmbed `code` props (Google Fonts CDN sniff).
// This is something Lighthouse cannot do: Webstudio prefetches ALL uploaded fonts
// even when never referenced in styles, so an uploaded-but-unused weight is a
// pure perf cost.
//
// Sections (Webstudio perf best-practices):
//   📁 Familles — uploaded vs used (≤ 2 families recommended)
//   ⚖️ Poids par famille — uploaded weights vs weights referenced in styles
//   📐 Format — flag anything not .woff2
//   📏 Tailles — flag fonts above sizeThresholdKB (subsetting candidate)
//   🔗 Google Fonts externes — flag fonts.googleapis.com / fonts.gstatic.com links
//
// Read-only.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import { buildFontsReport } from "./audit-fonts/report.js";

export const auditFontsInputSchema = z.object({
  projectSlug: z.string(),
  /** Regular-weight threshold above which a font is flagged as a subsetting candidate. */
  sizeThresholdKB: z.number().int().min(1).default(80),
  /** Show full lists per section (else top 20). */
  verbose: z.boolean().default(false),
}).strict();

export const auditFontsTool: ToolModule = {
  definition: {
    name: "webstudio_audit_fonts",
    description: `Use when: you want a project-wide perf audit on uploaded fonts.
Cross-references uploaded fonts (build.assets) with what's actually used in styles
(font-family + font-weight decls) and HtmlEmbed code props (Google Fonts CDN sniff).
Flags: >2 families, families uploaded with zero usage, weights uploaded but never
referenced (prefetched for nothing), non-woff2 files, oversized fonts (>sizeThresholdKB,
default 80 KB → subset Latin-only), and Google Fonts CDN links (3rd-party TLS + IP log).
verbose=true expands per-section lists (else top 20). Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        sizeThresholdKB: {
          type: "number",
          description: "KB threshold above which a font asset is flagged for subsetting (default 80).",
        },
        verbose: { type: "boolean" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditFontsInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const input = parsed.data;

    let auth;
    try { auth = requireAuth(input.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    try {
      const report = buildFontsReport(build, {
        projectSlug: input.projectSlug,
        sizeThresholdKB: input.sizeThresholdKB,
        verbose: input.verbose,
      });
      return textResult(report);
    } catch (err) {
      return errorResult("INTERNAL_ERROR", (err as Error).message);
    }
  },
};
