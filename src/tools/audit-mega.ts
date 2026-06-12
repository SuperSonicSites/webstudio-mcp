// Mega-tool `audit` — v2.0. Read-only project audits.
//
// 13 actions, all READ-ONLY. Each action delegates to one specialised sub-tool
// (auditPageTool for `page`, legacyAuditTool kind-dispatcher for the others).
// The v2 builder derives each action's JSON schema directly from the sub-tool's
// exported Zod schema — no more drift between wrapper params and what the
// sub-handler accepts.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { auditTool as legacyAuditTool } from "./audit.js";
import { auditPageTool, auditPageInputSchema } from "./audit-page.js";
import { auditOverflowInputSchema } from "./audit-overflow.js";
import { auditLocalStylesInputSchema } from "./audit-local-styles.js";
import { auditTokenUsageInputSchema } from "./audit-token-usage.js";
import { auditTokenOverlapInputSchema } from "./audit-token-overlap.js";
import { auditOrphansInputSchema } from "./audit-orphans.js";
import { auditAssetsInputSchema } from "./audit-assets.js";
import { auditFontsInputSchema } from "./audit-fonts.js";
import { auditImagesInputSchema } from "./audit-images.js";
import { auditScriptsInputSchema } from "./audit-scripts.js";
import { auditResourcesPerfInputSchema } from "./audit-resources-perf.js";
import { diffPagesTokensInputSchema } from "./diff-pages-tokens.js";
import { auditRadixTriggerPollutionInputSchema } from "./audit-radix-trigger-pollution.js";
import { auditDuplicateTokensTool, auditDuplicateTokensInputSchema } from "./audit-duplicate-tokens.js";

const KIND_BY_ACTION: Record<string, string> = {
  overflow: "overflow",
  local_styles: "local-styles",
  token_usage: "token-usage",
  token_overlap: "token-overlap",
  orphans: "orphans",
  assets: "assets",
  fonts: "fonts",
  images: "images",
  scripts: "scripts",
  resources_perf: "resources-perf",
  diff_pages_tokens: "diff-pages-tokens",
  radix_trigger_pollution: "radix-trigger-pollution",
};

const TIER: Record<string, Tier> = Object.fromEntries(
  ["page", "duplicate_tokens", ...Object.keys(KIND_BY_ACTION)].map((a) => [a, "READ-ONLY" as Tier]),
);

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("page") }).passthrough(),
  Base.extend({ action: z.literal("overflow") }).passthrough(),
  Base.extend({ action: z.literal("local_styles") }).passthrough(),
  Base.extend({ action: z.literal("token_usage") }).passthrough(),
  Base.extend({ action: z.literal("token_overlap") }).passthrough(),
  Base.extend({ action: z.literal("orphans") }).passthrough(),
  Base.extend({ action: z.literal("assets") }).passthrough(),
  Base.extend({ action: z.literal("fonts") }).passthrough(),
  Base.extend({ action: z.literal("images") }).passthrough(),
  Base.extend({ action: z.literal("scripts") }).passthrough(),
  Base.extend({ action: z.literal("resources_perf") }).passthrough(),
  Base.extend({ action: z.literal("diff_pages_tokens") }).passthrough(),
  Base.extend({ action: z.literal("radix_trigger_pollution") }).passthrough(),
  Base.extend({ action: z.literal("duplicate_tokens") }).passthrough(),
]);

const D = {
  page: `Use when: COMPREHENSIVE single-page audit — all page-scoped checks on ONE page in one call. Do NOT use when: project-wide checks (use specific kinds like action:"assets" or action:"token_usage"). Returns: aggregated multi-section report covering overflow + local-styles + images + scripts + orphans (best ROI for a single-page review). Side effects: none. Example: {action:"page",label:"audit-home",projectSlug:"my-site",pagePath:"/"}`,
  overflow: `Use when: detect horizontal scroll causes on a page (fixed widths, grid 1fr without minmax, flex nowrap...). Do NOT use when: needing project-wide audits (this is page-scoped). Returns: issue list per breakpoint. Side effects: none. Example: {action:"overflow",label:"check-mobile-overflow",projectSlug:"my-site",pagePath:"/",breakpoint:"Mobile"}`,
  local_styles: `Use when: find hardcoded values in local styles that should be tokens. Do NOT use when: needing project-wide token statistics (use action:"token_usage"). Returns: per-decl report. Side effects: none. Example: {action:"local_styles",label:"audit-hardcoded",projectSlug:"my-site",pagePath:"/"}`,
  token_usage: `Use when: list tokens vs their usage count across the project (identify dead tokens, over-used tokens). Do NOT use when: classifying local overrides vs tokens (use action:"token_overlap"). Returns: per-token usage. Side effects: none. Example: {action:"token_usage",label:"audit-tokens",projectSlug:"my-site"}`,
  token_overlap: `Use when: classify local overrides as DUPE/OVERRIDE/UNIQUE vs existing tokens. Do NOT use when: counting token usage (use action:"token_usage"). Returns: classified list — flags overrides that should be consolidated. Side effects: none. Example: {action:"token_overlap",label:"audit-overlap",projectSlug:"my-site"}`,
  orphans: `Use when: find styles/props/sources that reference deleted instances (cleanup candidates). Do NOT use when: needing to cleanup orphan styleSources detached from any instance (use tokens.cleanup_orphan_locals). Returns: orphan refs. Side effects: none. Example: {action:"orphans",label:"audit-orphans",projectSlug:"my-site"}`,
  assets: `Use when: project-wide audit of uploaded assets (unused, oversized, format issues). Do NOT use when: needing the live catalog (use assets.list). Returns: per-asset report. Side effects: none. Example: {action:"assets",label:"audit-assets",projectSlug:"my-site"}`,
  fonts: `Use when: cross-reference uploaded fonts against font-family/weights actually used. Do NOT use when: needing the asset catalog (use action:"assets"). Returns: per-font usage — flags prefetched-but-unused weights. Side effects: none. Example: {action:"fonts",label:"audit-fonts",projectSlug:"my-site"}`,
  images: `Use when: audit images (alt text quality, oversized, format-suitability). Do NOT use when: needing the asset catalog (use action:"assets"). Returns: per-image report. Side effects: none. Example: {action:"images",label:"audit-images",projectSlug:"my-site"}`,
  scripts: `Use when: audit HtmlEmbed scripts and inline JS (size, external loads, perf cost). Do NOT use when: needing the resources list (use action:"resources_perf"). Returns: per-script report. Side effects: none. Example: {action:"scripts",label:"audit-scripts",projectSlug:"my-site"}`,
  resources_perf: `Use when: audit project resources (REST calls) for perf cost (latency, payload size, caching). Do NOT use when: needing the resources catalog (use resources.list). Returns: per-resource perf report. Side effects: network reads (executes resources). Example: {action:"resources_perf",label:"audit-perf",projectSlug:"my-site"}`,
  diff_pages_tokens: `Use when: compare tokens used across two pages to find divergence. Do NOT use when: auditing one page (use action:"page"). Returns: per-token diff. Side effects: none. Example: {action:"diff_pages_tokens",label:"diff-home-about",projectSlug:"my-site",pagePathA:"/",pagePathB:"/about"}`,
  radix_trigger_pollution: `Use when: scan Radix non-rendering wrappers for forbidden class/style/id props or local styles. Do NOT use when: auditing local styles in general (use action:"local_styles"). Returns: findings + migration suggestions; scanned wrappers include DialogTrigger, *Portal, *Close, NavigationMenuLink, Slot, ... Side effects: none. Example: {action:"radix_trigger_pollution",label:"audit-radix",projectSlug:"my-site",verbose:true}`,
  duplicate_tokens: `Use when: detect silently duplicated cloud tokens sharing the same normalized name. Returns: groups of duplicates with KEEP (most-attached) and DROP candidates + the exact tokens.migrate_token_selections + tokens.delete_token calls to issue; duplicates are typically introduced by the useTokens anti-pattern — see pattern tokens-cloud-vs-local. Do NOT use when: auditing one token's usage (use action:"token_overlap") or token usage stats (use action:"token_usage"). Side effects: none. Example: {action:"duplicate_tokens",label:"audit-dupes",projectSlug:"my-site"}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS: Record<string, (i: Record<string, unknown>) => Promise<ReturnType<typeof errorResult>>> = {
  page: async (i: Record<string, unknown>) => auditPageTool.handler(strip(i)),
  duplicate_tokens: async (i: Record<string, unknown>) => auditDuplicateTokensTool.handler(strip(i)),
};
for (const action of Object.keys(KIND_BY_ACTION)) {
  HANDLERS[action] = async (i: Record<string, unknown>) =>
    legacyAuditTool.handler({ ...strip(i), kind: KIND_BY_ACTION[action] });
}

export const auditMegaTool: ToolModule = {
  definition: {
    name: "audit",
    description: `Mega-tool for project audits (all READ-ONLY). 14 actions: page (comprehensive single-page entry), overflow, local_styles, token_usage, token_overlap, orphans, assets, fonts, images, scripts, resources_perf, diff_pages_tokens, radix_trigger_pollution, duplicate_tokens. Each kind has its own specialised detector.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "page", description: D.page, zod: auditPageInputSchema },
      { action: "overflow", description: D.overflow, zod: auditOverflowInputSchema },
      { action: "local_styles", description: D.local_styles, zod: auditLocalStylesInputSchema },
      { action: "token_usage", description: D.token_usage, zod: auditTokenUsageInputSchema },
      { action: "token_overlap", description: D.token_overlap, zod: auditTokenOverlapInputSchema },
      { action: "orphans", description: D.orphans, zod: auditOrphansInputSchema },
      { action: "assets", description: D.assets, zod: auditAssetsInputSchema },
      { action: "fonts", description: D.fonts, zod: auditFontsInputSchema },
      { action: "images", description: D.images, zod: auditImagesInputSchema },
      { action: "scripts", description: D.scripts, zod: auditScriptsInputSchema },
      { action: "resources_perf", description: D.resources_perf, zod: auditResourcesPerfInputSchema },
      { action: "diff_pages_tokens", description: D.diff_pages_tokens, zod: diffPagesTokensInputSchema },
      { action: "radix_trigger_pollution", description: D.radix_trigger_pollution, zod: auditRadixTriggerPollutionInputSchema },
      { action: "duplicate_tokens", description: D.duplicate_tokens, zod: auditDuplicateTokensInputSchema },
    ]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  handler: async (args) => {
    const parsed = Schema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const input = parsed.data as Record<string, unknown> & { action: string; label: string; context?: string };
    const labelCheck = validateLabel(input.label);
    if (!labelCheck.ok) return errorResult("VALIDATION_FAILED", labelCheck.error);
    const tier = TIER[input.action];
    const ctxCheck = validateContext(input.context, tier);
    if (!ctxCheck.ok) return errorResult(ctxCheck.code, ctxCheck.error);
    logContext({ tool: "audit", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });
    return dispatchAction(input, HANDLERS);
  },
};
