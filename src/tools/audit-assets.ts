// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"assets").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"assets", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_assets — project-wide audit of asset health.
//
// Reports:
//   - Inventory totals (count, total size, breakdown by type/format)
//   - Orphans (usage = 0)
//   - Duplicate-name candidates (same base name, multiple suffixes — likely accidental re-uploads)
//   - Heavy assets (top N by size)
//   - Low-usage assets (used once, candidates for review)

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import { getAssets, countAllUsages, formatBytes } from "../lib/asset-helpers.js";

export const auditAssetsInputSchema = z.object({
  projectSlug: z.string(),
  /** Number of heavy assets to show. */
  heavyTopN: z.number().int().min(0).default(10),
  /** Show untruncated sha256 ids (usable as-is for delete_asset). Default false. */
  fullIds: z.boolean().default(false),
}).strict();

/** Strip Webstudio's "_<random8>" suffix to get a base name. */
function stripSuffix(name: string): string {
  // e.g. "photo_sP8U3ZU2bHIzhbwy8iEtH.webp" → "photo.webp"
  return name.replace(/_[A-Za-z0-9_-]{15,25}(\.[a-z0-9]+)$/i, "$1");
}

export const auditAssetsTool: ToolModule = {
  definition: {
    name: "webstudio_audit_assets",
    description: `Use when: you want a project-wide asset health overview (size, orphans, dupes, heavies).
Reports totals by type/format, orphan assets (0 usages → delete_asset candidates), duplicate-name
groups (accidental re-uploads with different sha256), top N heaviest (heavyTopN, default 10),
and low-usage assets (used once).
fullIds=true to get untruncated sha256 ids (usable as-is for delete_asset). Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        heavyTopN: { type: "number", description: "Top N heaviest assets to display (default 10)." },
        fullIds: { type: "boolean", description: "Show untruncated sha256 ids (usable as-is for delete_asset)." },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditAssetsInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const input = parsed.data;

    let auth;
    try { auth = requireAuth(input.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const assets = getAssets(build);
    if (assets.length === 0) return textResult("No assets in project.");

    const counts = countAllUsages(build);

    // Totals
    let totalSize = 0;
    const byType = new Map<string, { count: number; size: number }>();
    const byFormat = new Map<string, { count: number; size: number }>();
    for (const a of assets) {
      totalSize += a.size;
      const t = a.type ?? "?";
      const tSlot = byType.get(t) ?? { count: 0, size: 0 };
      tSlot.count++; tSlot.size += a.size;
      byType.set(t, tSlot);
      const f = a.format ?? "?";
      const fSlot = byFormat.get(f) ?? { count: 0, size: 0 };
      fSlot.count++; fSlot.size += a.size;
      byFormat.set(f, fSlot);
    }

    // Orphans
    const orphans = assets.filter((a) => (counts.get(a.id) ?? 0) === 0);

    // Duplicate-name groups
    const byBaseName = new Map<string, typeof assets>();
    for (const a of assets) {
      const base = stripSuffix(a.name);
      const arr = byBaseName.get(base) ?? [];
      arr.push(a);
      byBaseName.set(base, arr);
    }
    const dupeGroups = [...byBaseName.entries()].filter(([, arr]) => arr.length > 1);

    // Heavy
    const heavy = [...assets].sort((a, b) => b.size - a.size).slice(0, input.heavyTopN);

    // Low-usage
    const lowUsage = assets.filter((a) => (counts.get(a.id) ?? 0) === 1);

    const lines: string[] = [];
    lines.push(`# Assets audit — ${build.project?.title ?? input.projectSlug}`);
    lines.push(`Total: ${assets.length} assets | ${formatBytes(totalSize)}`);

    lines.push(`\nBy type:`);
    for (const [t, v] of byType) lines.push(`  ${t}: ${v.count} (${formatBytes(v.size)})`);

    lines.push(`\nBy format:`);
    for (const [f, v] of [...byFormat.entries()].sort((a, b) => b[1].count - a[1].count)) {
      lines.push(`  ${f}: ${v.count} (${formatBytes(v.size)})`);
    }

    const renderId = (id: string) => (input.fullIds ? id : `${id.slice(0, 12)}…`);

    lines.push(`\n## Orphans (0 usages): ${orphans.length}`);
    if (orphans.length > 0) {
      for (const a of orphans) {
        lines.push(`  - ${renderId(a.id)}  ${formatBytes(a.size).padStart(9)}  ${a.name}`);
      }
    }

    lines.push(`\n## Duplicate-name groups: ${dupeGroups.length}`);
    if (dupeGroups.length > 0) {
      for (const [base, arr] of dupeGroups) {
        lines.push(`  "${base}" (×${arr.length}):`);
        for (const a of arr) {
          lines.push(`    ${renderId(a.id)}  ${formatBytes(a.size).padStart(9)}  used=${counts.get(a.id) ?? 0}  ${a.name}`);
        }
      }
    }

    lines.push(`\n## Top ${heavy.length} heaviest:`);
    for (const a of heavy) {
      lines.push(`  ${formatBytes(a.size).padStart(9)}  used=${counts.get(a.id) ?? 0}  ${a.name}`);
    }

    if (lowUsage.length > 0) {
      lines.push(`\n## Used once (${lowUsage.length}):`);
      for (const a of lowUsage.slice(0, 20)) {
        lines.push(`  ${renderId(a.id)}  ${a.name}`);
      }
      if (lowUsage.length > 20) lines.push(`  … (+${lowUsage.length - 20} more)`);
    }

    return textResult(lines.join("\n"));
  },
};
