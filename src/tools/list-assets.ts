// Tool: webstudio_list_assets — read-only inventory of a project's assets.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import { getAssets, countAllUsages, formatBytes } from "../lib/asset-helpers.js";

export const listAssetsInputSchema = z.object({
  projectSlug: z.string(),
  /** Filter by asset type ("image" | "font" | substring). */
  type: z.string().optional(),
  /** Substring match on the asset name (case-insensitive). */
  filter: z.string().optional(),
  /** Sort: name | size | createdAt | usage. */
  sort: z.enum(["name", "size", "createdAt", "usage"]).default("name"),
  /** Descending (default ascending). */
  desc: z.boolean().default(false),
  /** Include usage count (slightly slower — walks all props and styles). Default true. */
  withUsage: z.boolean().default(true),
  /** Show untruncated sha256 ids (usable as-is for delete_asset). Default false. */
  fullIds: z.boolean().default(false),
}).strict();

export const listAssetsTool: ToolModule = {
  definition: {
    name: "webstudio_list_assets",
    description: `Use when: CATALOG project assets (images + fonts) with size, format, dimensions, usage counts — useful before audit_assets, dedupe analysis, or picking orphans to delete.
Do NOT use when: you want to find WHERE a specific asset is referenced — use webstudio_find_asset_usage (per-prop / per-style / per-page-meta details). For audit reports (large images, orphans, missing alt), use webstudio_audit({kind:"assets"}) / webstudio_audit({kind:"images"}).
Returns: table of {id, type, format, size, dims, usage count, name} + totals + breakdown by type + orphan count (assets with 0 usages).
Filters: type ("image"|"font"|substring), filter (substring on name, case-insensitive). Sort: name|size|createdAt|usage; desc=true to reverse. withUsage=true (default) walks props+styles+pageMeta for refs (slightly slower). fullIds=true returns untruncated sha256 ids (usable as-is for delete_asset).
Side effects: none (read-only).

Example: { projectSlug: "acme", type: "image", sort: "size", desc: true, fullIds: true }
Example: { projectSlug: "my-site", sort: "usage", desc: false }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        type: { type: "string" },
        filter: { type: "string" },
        sort: { type: "string", enum: ["name", "size", "createdAt", "usage"] },
        desc: { type: "boolean" },
        withUsage: { type: "boolean" },
        fullIds: { type: "boolean", description: "Show untruncated sha256 ids (usable as-is for delete_asset)." },
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
    const parsed = listAssetsInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const input = parsed.data;

    let auth;
    try { auth = requireAuth(input.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    let assets = getAssets(build);

    if (input.type) {
      const t = input.type.toLowerCase();
      assets = assets.filter((a) => a.type?.toLowerCase().includes(t));
    }
    if (input.filter) {
      const f = input.filter.toLowerCase();
      assets = assets.filter((a) => a.name.toLowerCase().includes(f));
    }

    const usageCounts = input.withUsage ? countAllUsages(build) : new Map();

    const sorted = [...assets].sort((a, b) => {
      let cmp = 0;
      switch (input.sort) {
        case "size": cmp = a.size - b.size; break;
        case "createdAt": cmp = a.createdAt.localeCompare(b.createdAt); break;
        case "usage": cmp = (usageCounts.get(a.id) ?? 0) - (usageCounts.get(b.id) ?? 0); break;
        case "name":
        default: cmp = a.name.localeCompare(b.name);
      }
      return input.desc ? -cmp : cmp;
    });

    if (sorted.length === 0) return textResult("No assets matched.");

    const lines: string[] = [];
    let totalSize = 0;
    const byType = new Map<string, { count: number; size: number }>();

    for (const a of sorted) {
      const dims = a.meta?.width && a.meta?.height ? `${a.meta.width}x${a.meta.height}` : "—";
      const usage = input.withUsage ? `  used=${usageCounts.get(a.id) ?? 0}` : "";
      const idCol = input.fullIds ? a.id : `${a.id.slice(0, 12)}…`;
      lines.push(
        `${idCol}  ${(a.type ?? "?").padEnd(5)}  ${(a.format ?? "?").padEnd(5)}  ${formatBytes(a.size).padStart(9)}  ${dims.padStart(11)}${usage}  ${a.name}`,
      );
      totalSize += a.size;
      const t = a.type ?? "?";
      const slot = byType.get(t) ?? { count: 0, size: 0 };
      slot.count++;
      slot.size += a.size;
      byType.set(t, slot);
    }

    const breakdown = [...byType.entries()]
      .map(([t, v]) => `  ${t}: ${v.count} (${formatBytes(v.size)})`)
      .join("\n");

    const orphanCount = input.withUsage
      ? sorted.filter((a) => (usageCounts.get(a.id) ?? 0) === 0).length
      : 0;
    const orphanLine = input.withUsage ? `\nOrphans (0 usages): ${orphanCount}` : "";

    return textResult(
      `# Assets — ${build.project?.title ?? input.projectSlug}\nTotal: ${sorted.length} | Size: ${formatBytes(totalSize)}${orphanLine}\nBreakdown:\n${breakdown}\n\n${lines.join("\n")}`,
    );
  },
};
