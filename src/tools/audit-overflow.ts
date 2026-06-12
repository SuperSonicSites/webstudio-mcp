// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"overflow").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"overflow", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_overflow — detect potential sources of horizontal overflow (scroll-x)
// on a page at a given breakpoint. Scans styles + props + inline SVGs and flags common culprits.
//
// 🔴 critical: fixed widths > viewport, grid 1fr without minmax, flex-wrap nowrap, negative margins, SVG hardcoded > viewport
// 🟡 warning:  padding > 32 on Base without override, overflow-x explicit, font-size > 48 without override
// 🟠 hint:     extreme right/left absolute, long unbreakable text, white-space nowrap on long text
//
// Read-only — no push.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";
import { BP_LABEL_MAP, VIEWPORT_BY_BP, type Issue } from "./audit-overflow/types.js";
import { buildStylesByInstance, isInPageScope } from "./audit-overflow/helpers.js";
import { scanStyleBasedIssues, scanSvgIssues, scanTextWrapIssues, type ScanCtx } from "./audit-overflow/detectors.js";
import { buildReport } from "./audit-overflow/report.js";

export const auditOverflowInputSchema = z.object({
  projectSlug: z.string(),
  pageId: z.string().optional(),
  pagePath: z.string().optional(),
  breakpoint: z
    .enum(["mobile-portrait", "mobile-landscape", "tablet", "all"])
    .default("mobile-portrait"),
  minSeverity: z.enum(["hint", "warning", "critical"]).default("hint"),
  maxIssues: z.number().int().positive().default(50),
}).strict();

export const auditOverflowTool: ToolModule = {
  definition: {
    name: "webstudio_audit_overflow",
    description: `Use when: a page has horizontal scroll on mobile and you need to find the cause.
Scans styles + props + inline SVGs at a breakpoint (default mobile-portrait, or "all"). Returns
issues tagged critical/warning/hint with offending property+value, breakpoint, and suggested fix.
Common detectors: fixed px > viewport, grid 1fr without minmax(0,_), flex-wrap nowrap, negative
margins, large padding without mobile override, long unbreakable text without overflow-wrap.
Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        pageId: { type: "string" },
        pagePath: { type: "string" },
        breakpoint: { type: "string", enum: ["mobile-portrait", "mobile-landscape", "tablet", "all"] },
        minSeverity: { type: "string", enum: ["hint", "warning", "critical"] },
        maxIssues: { type: "number" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditOverflowInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const opts = parsed.data;

    let auth;
    try {
      auth = requireAuth(opts.projectSlug);
    } catch (err) {
      return authErrorResult(err);
    }

    let build: WebstudioBuild;
    try {
      build = await fetchBuild(auth, { readonly: true });
    } catch (err) {
      return runtimeErrorResult(err, "fetch build failed");
    }

    const page = opts.pageId
      ? build.pages.pages.find((p) => p.id === opts.pageId)
      : opts.pagePath !== undefined
        ? build.pages.pages.find((p) => p.path === opts.pagePath)
        : build.pages.pages.find((p) => p.id === build.pages.homePageId);
    if (!page) {
      return errorResult("PAGE_NOT_FOUND", `Page not found (${opts.pageId ?? opts.pagePath ?? "home"})`);
    }

    const scope = isInPageScope(build, page.rootInstanceId);
    const stylesByInstance = buildStylesByInstance(build, scope);
    const bpById = new Map(build.breakpoints.map((b) => [b.id, b]));
    const bpByLabel = new Map(build.breakpoints.map((b) => [b.label, b]));

    const targetBpSlugs = opts.breakpoint === "all"
      ? ["mobile-portrait", "mobile-landscape", "tablet"]
      : [opts.breakpoint];
    const targetBps = targetBpSlugs.map((s) => ({
      slug: s,
      bp: bpByLabel.get(BP_LABEL_MAP[s]),
      viewport: VIEWPORT_BY_BP[s],
    }));

    const issues: Issue[] = [];
    const ctx: ScanCtx = { build, stylesByInstance, bpById, targetBps, issues };

    for (const inst of build.instances) {
      if (!scope.has(inst.id)) continue;
      scanStyleBasedIssues(ctx, inst);
      scanTextWrapIssues(ctx, inst);
      scanSvgIssues(ctx, inst);
    }

    return textResult(buildReport({
      page: { path: page.path ?? "/", name: page.name },
      breakpoint: opts.breakpoint,
      targetBpSlugs,
      issues,
      minSeverity: opts.minSeverity,
      maxIssues: opts.maxIssues,
    }));
  },
};
