// Tool: webstudio_audit_page — comprehensive style/content audit of a page.
//
// Detects: sections + backgrounds + tokens, tokens used, local styles, hardcoded
// px in spacing, hardcoded colors without var, residue vars/tokens not matching
// allowedPrefix, images with bad alt, links missing href, label-based
// inter-instance inconsistencies, dataSources + bindings. Optional dash flag.
// Read-only.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import { collectIds } from "./audit-page/helpers.js";
import {
  reportSections,
  reportTokens,
  reportLocalStyles,
} from "./audit-page/sections-tokens.js";
import {
  reportPxSpacings,
  reportHardcodedColors,
  reportResidues,
  reportDashes,
  reportImages,
  reportLinks,
} from "./audit-page/anomalies.js";
import { reportBindings, reportInconsistencies } from "./audit-page/bindings.js";

export const auditPageInputSchema = z.object({
  projectSlug: z.string(),
  pagePath: z.string().optional(),
  pageId: z.string().optional(),
  allowedPrefix: z.string().optional(),
  flagDashes: z.boolean().default(false),
  /** Response cap (v2.14.0 — reports were unbounded on instance-heavy pages). */
  maxChars: z.number().int().min(2_000).max(200_000).default(40_000)
    .describe("Max report size in chars (default 40 000). Truncated reports end with a note suggesting focused audits."),
}).strict().refine((d) => !!d.pagePath || !!d.pageId, { message: "Provide pagePath or pageId" });

/**
 * Cap an audit report at `maxChars` (v2.14.0 — reports were unbounded on
 * instance-heavy pages). Cuts at the last line boundary before the cap — a
 * half-line confuses more than it informs — and appends a note pointing to
 * the cheaper focused audits.
 */
export function truncateAuditReport(report: string, maxChars: number): string {
  if (report.length <= maxChars) return report;
  const cut = report.lastIndexOf("\n", maxChars);
  return (
    report.slice(0, cut > 0 ? cut : maxChars) +
    `\n\n[truncated: ${report.length} chars > maxChars=${maxChars} — raise maxChars, or run the focused project-wide audits instead: audit.overflow / audit.local_styles / audit.token_usage / audit.images]`
  );
}

export const auditPageTool: ToolModule = {
  definition: {
    name: "webstudio_audit_page",
    description: `Use when: comprehensive audit of a SINGLE page — sections, tokens used, local styles, anomalies, bindings — entry point for a "is this page healthy?" check.
Do NOT use when: you want a focused project-wide audit on ONE aspect (overflow, dead tokens, font usage, image alt) — use webstudio_audit(kind:"<X>") instead. For raw page tree, use webstudio_list_instances.
Returns: markdown report covering: sections+backgrounds+tokens, tokens used, local styles, hardcoded px in spacing, hardcoded colors (no var), residue vars/tokens not matching allowedPrefix, images with bad alt, links missing href, label-based inter-instance inconsistencies, dataSources + bindings.
Side effects: none (read-only). flagDashes=true also flags em/en-dashes in text nodes.

Example: { projectSlug: "my-site", pagePath: "/" }
Example: { projectSlug: "acme", pageId: "p1", allowedPrefix: "acme-", flagDashes: true }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        pagePath: { type: "string" },
        pageId: { type: "string" },
        allowedPrefix: { type: "string" },
        flagDashes: { type: "boolean" },
        maxChars: { type: "number", description: "Max report size in chars (default 40 000)." },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
    annotations: {
      title: "Comprehensive page audit",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args) => {
    const parsed = auditPageInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const { projectSlug, pagePath, pageId, allowedPrefix, flagDashes, maxChars } = parsed.data;

    let auth;
    try { auth = requireAuth(projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const page = build.pages.pages.find((p) => p.id === pageId || p.path === pagePath);
    if (!page) return errorResult("PAGE_NOT_FOUND", `Page not found: ${pagePath ?? pageId}`);

    const lines: string[] = [];
    const log = (s: string) => lines.push(s);

    log(`# Audit page "${page.path === "" ? "/" : page.path}" (${page.name}) — build v${build.version}`);
    log(`Page ID: ${page.id}, root: ${page.rootInstanceId}\n`);

    const pageIds = collectIds(page.rootInstanceId, build);
    log(`Total instances: ${pageIds.size}\n`);

    reportSections(build, pageIds, log);
    const usedTokens = reportTokens(build, pageIds, log);
    const { localSources, localDecls } = reportLocalStyles(build, pageIds, log);

    log(`\n## Anomalies`);
    reportPxSpacings(localDecls, log);
    reportHardcodedColors(localDecls, log);

    if (allowedPrefix) {
      reportResidues(build, localSources, usedTokens, allowedPrefix, log);
    }
    if (flagDashes) {
      reportDashes(build, pageIds, log);
    }
    reportImages(build, pageIds, log);
    reportLinks(build, pageIds, log);

    reportBindings(build, pageIds, page as { rootInstanceId: string; title?: unknown; meta?: unknown }, log);
    reportInconsistencies(build, pageIds, log);

    return textResult(truncateAuditReport(lines.join("\n"), maxChars));
  },
};
