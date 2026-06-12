// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"orphans").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"orphans", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_orphans
//
// Project-wide scan that lists orphan elements (never referenced) by category:
// variables, resources, assets, styleSources (local), tokens, CSS vars, folders.
//
// Read-only. Enables periodic cleanup without nuking blindly.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import { ALL_CATEGORIES, Category, type CategoryResult, type CategoryT } from "./audit-orphans/types.js";
import { CATEGORY_RUNNERS } from "./audit-orphans/scanners.js";
import { renderReport } from "./audit-orphans/report.js";

export const auditOrphansInputSchema = z.object({
  projectSlug: z.string(),
  categories: z.array(Category).optional(),
  verbose: z.boolean().default(false),
}).strict();

export const auditOrphansTool: ToolModule = {
  definition: {
    name: "webstudio_audit_orphans",
    description: `Use when: you want a project-wide list of orphan elements (never referenced) per category.
Categories: variables, resources, assets, styleSources (locals), tokens, cssVars, folders. Default = all.
verbose=true expands each list (else top 20 per category, sorted by name).
Read-only — no push. Pair with delete_variable / delete_asset / delete_token / delete_css_var / cleanup_orphan_locals.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        categories: {
          type: "array",
          items: {
            type: "string",
            enum: ["variables", "resources", "assets", "styleSources", "tokens", "cssVars", "folders"],
          },
        },
        verbose: { type: "boolean" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditOrphansInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const data = parsed.data;

    let auth;
    try { auth = requireAuth(data.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const picked: CategoryT[] =
      data.categories && data.categories.length > 0 ? data.categories : ALL_CATEGORIES;
    const results = new Map<CategoryT, CategoryResult>();
    try {
      for (const c of picked) {
        results.set(c, CATEGORY_RUNNERS[c](build));
      }
    } catch (err) {
      return errorResult("INTERNAL_ERROR", (err as Error).message);
    }

    const report = renderReport(data.projectSlug, build.project?.title, picked, results, data.verbose);
    return textResult(report);
  },
};
