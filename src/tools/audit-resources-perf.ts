// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"resources-perf").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"resources-perf", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_resources_perf
//
// Project-wide perf audit of SSR resources (HTTP calls executed at render time).
// A slow resource degrades TTFB for the whole page. Common smells caught here:
//   - duplicated URLs (pure waste — same call N times)
//   - similar URLs (same origin+path, different params → candidate for one
//     dynamic resource with bound search params)
//   - sync dependency chains (resource B's URL references A's dataSource → serial)
//   - GET without Cache-Control max-age>0 (no SSR caching)
//   - pages with too many resources (> maxPerPageThreshold)
//
// Read-only. Pair with delete_resource / update_resource to fix.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import { analyzeResources } from "./audit-resources-perf/analyze.js";
import { renderReport } from "./audit-resources-perf/report.js";

export const auditResourcesPerfInputSchema = z.object({
  projectSlug: z.string(),
  verbose: z.boolean().default(false),
  maxPerPageThreshold: z.number().int().min(1).default(5),
}).strict();

export const auditResourcesPerfTool: ToolModule = {
  definition: {
    name: "webstudio_audit_resources_perf",
    description: `Use when: you suspect SSR resources are dragging TTFB on a Webstudio project (e.g. lots of
"Accessoires", "REST API …" duplicates accumulated over time).
Flags: duplicated URLs (ERROR — pure waste), similar URLs (INFO — factorisation candidates),
sync dependency chains (ERROR — serial SSR fetches), GET without Cache-Control (WARN),
and pages with > maxPerPageThreshold resources.
verbose=false: top 20 per section. verbose=true: full output. Read-only — no push.
Pair with delete_resource / update_resource to fix.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        verbose: { type: "boolean" },
        maxPerPageThreshold: {
          type: "number",
          description: "Pages with more than this many resources get WARN-flagged (default 5).",
        },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditResourcesPerfInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const data = parsed.data;

    let auth;
    try { auth = requireAuth(data.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const resources = analyzeResources(build);
    if (resources.length === 0) return textResult("No resources in project — nothing to audit.");

    const report = renderReport(
      data.projectSlug,
      build.project?.title,
      resources,
      data.maxPerPageThreshold,
      data.verbose,
    );
    return textResult(report);
  },
};
