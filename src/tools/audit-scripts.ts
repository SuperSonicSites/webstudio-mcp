// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"scripts").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"scripts", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_scripts — project-wide audit of third-party scripts &
// external assets injected into the document head or via HtmlEmbed instances.
//
// Read-only. Flags:
//   - <script src=...> without defer/async (render-blocking)
//   - External Google Fonts <link> (fonts.googleapis / fonts.gstatic)
//   - Inline <script> (info — verify size)
//   - External CSS <link> (info)
//   - Known trackers (GA / GTM / Meta Pixel / Hotjar / etc.)
//
// Sources scanned:
//   1. Project-level "head slot" HTML — string fields on build.project /
//      build.pages. NOTE: the exact field name for the global Head Slot is
//      NOT formally typed in this repo's WebstudioBuild — we scan all string
//      fields heuristically (looksLikeHeadHtml). TODO if Webstudio exposes a
//      stable property (e.g. build.project.headSlot), use it directly.
//   2. Per-page meta — every string field on page.meta (typically `custom`,
//      `customCode`, `headHtml`, ...). Webstudio Page Settings → "Custom
//      Code" lands here.
//   3. Every HtmlEmbed / ContentEmbed instance's `code` prop.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";
import {
  collectProjectHeadSources,
  collectPageMetaSources,
  collectEmbedSources,
} from "./audit-scripts/sources.js";
import { detectInSource } from "./audit-scripts/detectors.js";
import { renderReport } from "./audit-scripts/report.js";
import type { Finding, HtmlSource } from "./audit-scripts/types.js";

export const auditScriptsInputSchema = z.object({
  projectSlug: z.string(),
  verbose: z.boolean().default(false),
}).strict();

export const auditScriptsTool: ToolModule = {
  definition: {
    name: "webstudio_audit_scripts",
    description: `Use when: you want to verify third-party scripts & external assets injected in the document
head obey Webstudio perf best practices (defer/async, self-hosted fonts, no render-blocking).
Scans: project-level head slot (string fields on build.project / build.pages), every page.meta string
field, and every HtmlEmbed/ContentEmbed instance code prop. Flags render-blocking <script src>
without defer/async, Google Fonts external <link>, inline scripts (info), external CSS (info), and
known trackers (GA, GTM, Meta Pixel, Hotjar, Clarity, Plausible, Matomo, Intercom, Crisp, LinkedIn,
TikTok, HubSpot). verbose=true expands the inline/CSS lists. Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        verbose: { type: "boolean", description: "Expand inline/CSS lists (default false → top 10)." },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditScriptsInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const { projectSlug, verbose } = parsed.data;

    let auth;
    try { auth = requireAuth(projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build: WebstudioBuild;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const sources: HtmlSource[] = [
      ...collectProjectHeadSources(build),
      ...collectPageMetaSources(build),
      ...collectEmbedSources(build),
    ];

    const findings: Finding[] = [];
    for (const src of sources) findings.push(...detectInSource(src));

    const report = renderReport(projectSlug, build.project?.title, sources, findings, verbose);
    return textResult(report);
  },
};
