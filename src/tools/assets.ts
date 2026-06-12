// Mega-tool `assets` — v2.0. Asset lifecycle (images, fonts).
//
// Tier mapping:
//   - replace, delete   → CRITICAL  (project-wide swap / irreversible — context required)
//   - upload            → STRUCTURING
//   - list, find_usage  → READ-ONLY
//
// v2 hard break: `delete` no longer accepts the legacy `assetIds` alias — pass
// `assetIdsOrPrefixes` directly (the sub-handler accepts both ids and id-prefixes).

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { uploadAssetTool, uploadAssetInputSchema } from "./upload-asset.js";
import { listAssetsTool, listAssetsInputSchema } from "./list-assets.js";
import { findAssetUsageTool, findAssetUsageInputSchema } from "./find-asset-usage.js";
import { replaceAssetTool, replaceAssetInputSchema } from "./replace-asset.js";
import { deleteAssetsBatchTool, deleteAssetsBatchInputSchema } from "./delete-assets-batch.js";

const TIER: Record<string, Tier> = {
  upload: "STRUCTURING",
  list: "READ-ONLY",
  find_usage: "READ-ONLY",
  replace: "CRITICAL",
  delete: "CRITICAL",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("upload") }).passthrough(),
  Base.extend({ action: z.literal("list") }).passthrough(),
  Base.extend({ action: z.literal("find_usage") }).passthrough(),
  Base.extend({ action: z.literal("replace") }).passthrough(),
  Base.extend({ action: z.literal("delete") }).passthrough(),
]);

const DESCRIPTIONS = {
  upload: `Use when: uploading an image or font file to a project from a path, URL, or base64 content. Do NOT use when: replacing an existing asset everywhere (use action:"replace" after upload). Pass filePath, base64Content, or url; supported formats: webp/png/jpg/svg/avif/woff/woff2/ttf. Returns: {assetId: sha256 hex string} — pass to instance_prop with type="asset" to bind on an Image's src, or to other actions that accept assetId. Side effects: push to Webstudio Cloud (uploads to CDN, requires allowPush). Example: {action:"upload",label:"upload-hero",projectSlug:"my-site",filePath:"/path/to/hero.webp"}`,
  list: `Use when: list a project's assets with size/type/usage counts. Do NOT use when: searching references to ONE specific asset (use action:"find_usage"). Returns: array of {id, name, type, format, size, width, height, usageCount}. Side effects: none (read-only). Example: {action:"list",label:"asset-catalog",projectSlug:"my-site"}`,
  find_usage: `Use when: locating every reference to one asset before deleting or replacing it. Do NOT use when: needing the full catalog (use action:"list"). Returns: asset header + per-kind references (props, styles, page meta). Side effects: none (read-only). Example: {action:"find_usage",label:"audit-hero-usage",projectSlug:"my-site",assetName:"hero"}`,
  replace: `Use when: swapping an asset for another project-wide, updating every reference at once. Do NOT use when: replacing in 1 spot only (use instances.prop_update). Typical jobs: new logo with same dimensions, image variant update, file format upgrade. Returns: per-reference report (succeeded/failed). Side effects: push to Webstudio Cloud, CRITICAL — context required, affects ALL pages. Example: {action:"replace",label:"swap-logo-v2",projectSlug:"my-site",fromAssetId:"sha1...",toAssetId:"sha2...",context:"Updating the dealer logo across the entire site after the 2026 rebrand kickoff approved by the marketing lead last week",dryRun:true}`,
  delete: `Use when: batch-deleting assets by id or id-prefix with continue-on-error semantics. Do NOT use when: replacing an asset with a new version (use action:"replace" instead — preserves references). Pass assetIdsOrPrefixes — each entry is a full sha256 id or a prefix matching multiple assets. Returns: succeeded[]/failed[] report. Side effects: push to Webstudio Cloud, CRITICAL — context required, irreversible. Example: {action:"delete",label:"purge-orphan",projectSlug:"my-site",assetIdsOrPrefixes:["sha1","sha2"],context:"Removing 12 orphan images uploaded during the abandoned redesign experiment that are no longer referenced anywhere in the build",dryRun:true}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  upload: async (i: Record<string, unknown>) => uploadAssetTool.handler(strip(i)),
  list: async (i: Record<string, unknown>) => listAssetsTool.handler(strip(i)),
  find_usage: async (i: Record<string, unknown>) => findAssetUsageTool.handler(strip(i)),
  replace: async (i: Record<string, unknown>) => replaceAssetTool.handler(strip(i)),
  delete: async (i: Record<string, unknown>) => deleteAssetsBatchTool.handler(strip(i)),
};

export const assetsTool: ToolModule = {
  definition: {
    name: "assets",
    description: `Mega-tool for asset lifecycle (images, fonts). 5 actions: upload, list, find_usage, replace, delete. Assets are sha256-content-addressed; uploading the same bytes is idempotent. dryRun default true on every mutating action; CRITICAL actions (replace, delete) also require context.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "upload", description: DESCRIPTIONS.upload, zod: uploadAssetInputSchema },
      { action: "list", description: DESCRIPTIONS.list, zod: listAssetsInputSchema },
      { action: "find_usage", description: DESCRIPTIONS.find_usage, zod: findAssetUsageInputSchema },
      { action: "replace", description: DESCRIPTIONS.replace, zod: replaceAssetInputSchema },
      { action: "delete", description: DESCRIPTIONS.delete, zod: deleteAssetsBatchInputSchema },
    ]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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
    logContext({ tool: "assets", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });

    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
