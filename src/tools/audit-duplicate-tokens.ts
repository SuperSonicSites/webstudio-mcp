// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via audit({action:"duplicate_tokens"}).
//
// Scans cloud tokens of a project, groups them by name-normalized, and reports
// any group with ≥ 2 distinct tokens (silent duplicates introduced by the
// `useTokens` anti-pattern fixed in v2.7.6 — see pattern tokens-cloud-vs-local).
//
// Output: per-group "KEEP" (most-attached) + "DROP" candidates with the exact
// migrate_token_selections + delete_token calls to issue.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";

export const auditDuplicateTokensInputSchema = z.object({
  projectSlug: z.string(),
  /** Show full token ids (default false — short 8-char prefix only). */
  fullIds: z.boolean().default(false),
}).strict();

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[\s_]+/g, "-");
}

export const auditDuplicateTokensTool: ToolModule = {
  definition: {
    name: "webstudio_audit_duplicate_tokens",
    description: "Scans cloud tokens of a project, groups by name-normalized, reports duplicates.",
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        fullIds: { type: "boolean" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  handler: async (args) => {
    const parsed = auditDuplicateTokensInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const { projectSlug, fullIds } = parsed.data;

    let auth;
    try { auth = requireAuth(projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    // Count instance attachments per styleSource (cloud token id).
    const attachCounts = new Map<string, number>();
    for (const sel of build.styleSourceSelections ?? []) {
      for (const sourceId of (sel.values ?? [])) {
        attachCounts.set(sourceId, (attachCounts.get(sourceId) ?? 0) + 1);
      }
    }

    // Group cloud tokens by normalized name.
    const byNormName = new Map<string, Array<{ id: string; name: string; attachCount: number }>>();
    const totalCloudTokens = (build.styleSources as Array<{ type: string }>).filter((s) => s.type === "token").length;
    for (const s of build.styleSources as Array<{ type: string; id: string; name?: string }>) {
      if (s.type !== "token" || typeof s.name !== "string") continue;
      const norm = normalize(s.name);
      const arr = byNormName.get(norm) ?? [];
      arr.push({ id: s.id, name: s.name, attachCount: attachCounts.get(s.id) ?? 0 });
      byNormName.set(norm, arr);
    }

    // Filter to actual duplicates (group size ≥ 2).
    const duplicates = [...byNormName.entries()]
      .filter(([, tokens]) => tokens.length >= 2)
      .sort((a, b) => b[1].length - a[1].length);

    const shortId = (id: string) => (fullIds ? id : id.slice(0, 8));

    if (duplicates.length === 0) {
      return textResult(
        `✅ No duplicate cloud tokens detected in project "${projectSlug}".\n` +
        `   (${totalCloudTokens} unique cloud tokens scanned.)`,
      );
    }

    const lines: string[] = [];
    const dupCount = duplicates.reduce((sum, [, tokens]) => sum + tokens.length, 0);
    lines.push(`⚠️ ${duplicates.length} duplicate group(s) detected in project "${projectSlug}" — ${dupCount} token(s) total across duplicates.`);
    lines.push("");

    for (const [norm, tokens] of duplicates) {
      // Within each group, keep the most-attached; the others are drop candidates.
      const sorted = [...tokens].sort((a, b) => b.attachCount - a.attachCount);
      const keep = sorted[0];
      const drops = sorted.slice(1);
      lines.push(`## Group "${keep.name}" (normalized: "${norm}") — ${tokens.length} duplicates`);
      lines.push("");
      for (const t of sorted) {
        const role = t.id === keep.id ? "✓ KEEP" : "✗ DROP";
        lines.push(`  ${role}  id=${shortId(t.id)}  name="${t.name}"  ${t.attachCount} instance(s) attached`);
      }
      lines.push("");
      lines.push("  Migration plan (run in order):");
      for (const d of drops) {
        lines.push(`    tokens.migrate_token_selections({ projectSlug:"${projectSlug}", fromTokenId:"${shortId(d.id)}", toTokenId:"${shortId(keep.id)}", deleteOldStyles:true })`);
      }
      for (const d of drops) {
        lines.push(`    tokens.delete_token({ projectSlug:"${projectSlug}", tokenId:"${shortId(d.id)}" })`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push(`**Likely cause** : \`useTokens\` in \`build.push_complete\` consumed local registry slugs that matched existing cloud token names → silent duplication. See pattern \`tokens-cloud-vs-local\`.`);
    lines.push(`**Prevention** : v2.7.6+ refuses \`useTokens\` whose slug matches an existing cloud token (server-side guard).`);

    return textResult(lines.join("\n"));
  },
};
