// Tool: webstudio_find_asset_usage — locate all references to a given asset.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import { findUsages, findAssetById } from "../lib/asset-helpers.js";

export const findAssetUsageInputSchema = z.object({
  projectSlug: z.string(),
  /** sha256 id of the asset (also the prop "asset" value). */
  assetId: z.string().optional(),
  /** Or look up by asset name (with or without random suffix). Case-insensitive substring match. */
  assetName: z.string().optional(),
}).strict().refine((v) => v.assetId || v.assetName, {
  message: "Provide assetId or assetName.",
});

export const findAssetUsageTool: ToolModule = {
  definition: {
    name: "webstudio_find_asset_usage",
    description: `Use when: SEARCH every reference to a specific asset (before delete_asset, replace_asset, or to audit if a hero image is actually used anywhere).
Do NOT use when: you want the full asset catalog with sizes/usage counts — use webstudio_list_assets (lists all, no per-ref details). For project-wide image audit (size limits, missing alt), use webstudio_audit({kind:"images"}) / webstudio_audit({kind:"assets"}).
Returns: asset header (name, id, type, format, size, dims, served URL) + per-kind references — props ({instanceId, label, propName}), styles ({styleSourceId, breakpoint, state, property, layerIndex}), page meta ({pageId, pageName, field}). Marks orphan assets explicitly.
Lookup by assetId (sha256 — exact match) OR assetName (case-insensitive substring, accepts truncated names like "logo" matching "logo-xY3.svg").
Side effects: none (read-only).

Example: { projectSlug: "acme", assetId: "abc123def..." }
Example: { projectSlug: "my-site", assetName: "old-logo" }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        assetId: { type: "string" },
        assetName: { type: "string" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args) => {
    const parsed = findAssetUsageInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const input = parsed.data;

    let auth;
    try { auth = requireAuth(input.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    let asset = input.assetId ? findAssetById(build, input.assetId) : undefined;
    if (!asset && input.assetName) {
      const needle = input.assetName.toLowerCase();
      const all = (build.assets ?? []) as Array<{ id: string; name: string }>;
      asset = all.find((a) => a.name.toLowerCase().includes(needle)) as typeof asset;
    }

    if (!asset) {
      return errorResult("ASSET_NOT_FOUND", `Asset not found in build. Looked for: ${input.assetId ?? input.assetName}`);
    }

    const usages = findUsages(build, asset.id);

    const propRefs = usages.filter((u) => u.kind === "prop");
    const styleRefs = usages.filter((u) => u.kind === "style");
    const pageMetaRefs = usages.filter((u) => u.kind === "pageMeta");

    const lines: string[] = [];
    lines.push(`# Asset usage`);
    lines.push(`Asset: ${asset.name}`);
    lines.push(`  id:     ${asset.id}`);
    lines.push(`  type:   ${asset.type} (${asset.format})`);
    lines.push(`  size:   ${asset.size} bytes`);
    if (asset.meta?.width) lines.push(`  dims:   ${asset.meta.width}x${asset.meta.height}`);
    lines.push(`  URL:    /cgi/asset/${asset.name}`);
    lines.push(``);
    lines.push(`Total references: ${usages.length}`);

    if (propRefs.length > 0) {
      lines.push(`\nProps (${propRefs.length}):`);
      for (const u of propRefs) {
        if (u.kind !== "prop") continue;
        const inst = build.instances.find((i) => i.id === u.instanceId);
        const label = inst?.label ?? inst?.component ?? "(?)";
        lines.push(`  - [${u.instanceId}] (${label}): ${u.propName}`);
      }
    }

    if (styleRefs.length > 0) {
      const bpMap = new Map(build.breakpoints.map((b) => [b.id, b.label]));
      lines.push(`\nStyles (${styleRefs.length}):`);
      for (const u of styleRefs) {
        if (u.kind !== "style") continue;
        const bp = bpMap.get(u.breakpointId) ?? u.breakpointId;
        const state = u.state ? `[${u.state}]` : "";
        const layer = u.layerIndex >= 0 ? ` layer[${u.layerIndex}]` : "";
        lines.push(`  - [${u.styleSourceId}] @${bp}${state}: ${u.property}${layer}`);
      }
    }

    if (pageMetaRefs.length > 0) {
      lines.push(`\nPage meta (${pageMetaRefs.length}):`);
      for (const u of pageMetaRefs) {
        if (u.kind !== "pageMeta") continue;
        lines.push(`  - [${u.pageId}] ${u.pageName || u.pagePath}: meta.${u.field}`);
      }
    }

    if (usages.length === 0) {
      lines.push(`\n✅ Orphan asset — safe to delete via webstudio_delete_asset.`);
    }

    return textResult(lines.join("\n"));
  },
};
