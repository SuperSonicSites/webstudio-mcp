// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"token-usage").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"token-usage", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_token_usage
//
// Inventory of all design tokens with usage stats. Identifies:
//   - Tokens with 0 or 1 usage (candidates for deletion or refactor)
//   - Token name mismatches against expected prefix (residual template tokens)
//   - Tokens with semantically duplicate decl sets (candidates for merge via replace_token)
//
// Read-only.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";

export const auditTokenUsageInputSchema = z.object({
  projectSlug: z.string(),
  /** Project's expected token name prefix (e.g. "MyBrand "). Tokens not starting with it are flagged. */
  allowedPrefix: z.string().optional(),
  /** Threshold below which a token is flagged as "low usage". Default 1. */
  lowUsageThreshold: z.number().int().min(0).default(1),
  /** Detect tokens with strictly identical decl sets across all breakpoints/states (potential merge candidates). Default true. */
  detectDuplicates: z.boolean().default(true),
  /** Verbose: list each token's decls. Default false. */
  verbose: z.boolean().default(false),
  /** Sort: "usage-asc" (low usage first, default for cleanup) | "usage-desc" | "name". */
  sort: z.enum(["usage-asc", "usage-desc", "name"]).default("usage-asc"),
}).strict();

type Token = WebstudioBuild["styleSources"][number] & { type: "token"; name: string };
type Decl = WebstudioBuild["styles"][number];

function buildReport(build: WebstudioBuild, args: z.infer<typeof auditTokenUsageInputSchema>) {
  const tokens: Token[] = build.styleSources.filter((s): s is Token => s.type === "token");
  const tokenIds = new Set(tokens.map((t) => t.id));

  // Usage count: number of distinct instances selecting this token
  const usage = new Map<string, Set<string>>();
  for (const t of tokens) usage.set(t.id, new Set());
  for (const sel of build.styleSourceSelections) {
    for (const v of sel.values ?? []) {
      if (tokenIds.has(v)) usage.get(v)!.add(sel.instanceId);
    }
  }

  // Decl signature for duplicate detection: hash of sorted decls
  const declsByToken = new Map<string, Decl[]>();
  for (const t of tokens) declsByToken.set(t.id, []);
  for (const d of build.styles) {
    if (tokenIds.has(d.styleSourceId)) declsByToken.get(d.styleSourceId)!.push(d);
  }
  const sigByToken = new Map<string, string>();
  for (const [tid, decls] of declsByToken.entries()) {
    const sig = decls
      .map((d) => `${d.breakpointId}:${d.property}:${d.state ?? ""}=${JSON.stringify(d.value)}`)
      .sort()
      .join("\n");
    sigByToken.set(tid, sig || "(empty)");
  }

  // Group tokens by signature → duplicates
  const dupBuckets = new Map<string, string[]>();
  if (args.detectDuplicates) {
    for (const [tid, sig] of sigByToken.entries()) {
      if (sig === "(empty)") continue;
      if (!dupBuckets.has(sig)) dupBuckets.set(sig, []);
      dupBuckets.get(sig)!.push(tid);
    }
  }
  const duplicateGroups = [...dupBuckets.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([sig, ids]) => ({ sig, ids }));

  // Decorate tokens with stats
  const decorated = tokens.map((t) => ({
    id: t.id,
    name: t.name,
    instances: usage.get(t.id)!.size,
    decls: (declsByToken.get(t.id) ?? []).length,
    matchesPrefix: !args.allowedPrefix || t.name.startsWith(args.allowedPrefix),
  }));

  // Sort
  if (args.sort === "usage-asc") decorated.sort((a, b) => a.instances - b.instances || a.name.localeCompare(b.name));
  else if (args.sort === "usage-desc") decorated.sort((a, b) => b.instances - a.instances || a.name.localeCompare(b.name));
  else decorated.sort((a, b) => a.name.localeCompare(b.name));

  return { decorated, declsByToken, duplicateGroups };
}

export const auditTokenUsageTool: ToolModule = {
  definition: {
    name: "webstudio_audit_token_usage",
    description: `Use when: you want an inventory of design tokens with usage stats + refactor signals.
Per token: usage (distinct instances), decl count, prefix match. Flags: low-usage (≤lowUsageThreshold),
prefix mismatch (vs allowedPrefix → template residue), duplicate decl-sets → merge via replace_token.
sort: usage-asc (default) | usage-desc | name. Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        allowedPrefix: { type: "string" },
        lowUsageThreshold: { type: "number" },
        detectDuplicates: { type: "boolean" },
        verbose: { type: "boolean" },
        sort: { type: "string", enum: ["usage-asc", "usage-desc", "name"] },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditTokenUsageInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const data = parsed.data;

    let auth;
    try { auth = requireAuth(data.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const r = buildReport(build, data);

    const totalTokens = r.decorated.length;
    const lowUsage = r.decorated.filter((t) => t.instances <= data.lowUsageThreshold);
    const prefixMismatches = r.decorated.filter((t) => !t.matchesPrefix);

    const lines: string[] = [];
    lines.push(`# Tokens audit — ${data.projectSlug}`);
    lines.push(`Total tokens: ${totalTokens} | Low usage (≤${data.lowUsageThreshold}): ${lowUsage.length} | Prefix mismatch: ${prefixMismatches.length} | Duplicate groups: ${r.duplicateGroups.length}`);
    lines.push("");

    lines.push(`## All tokens (sorted: ${data.sort})`);
    for (const t of r.decorated) {
      const flags: string[] = [];
      if (t.instances === 0) flags.push("⚠ unused");
      else if (t.instances <= data.lowUsageThreshold) flags.push("🟡 low-usage");
      if (!t.matchesPrefix) flags.push("🔶 prefix");
      if (t.decls === 0) flags.push("⚠ empty");
      const flagStr = flags.length ? `  [${flags.join(", ")}]` : "";
      lines.push(`  ${t.instances.toString().padStart(3)} usages | ${t.decls.toString().padStart(3)} decls | "${t.name}"${flagStr}`);
      if (data.verbose) {
        const decls = r.declsByToken.get(t.id) ?? [];
        for (const d of decls.slice(0, 20)) {
          const v = JSON.stringify(d.value).slice(0, 80);
          lines.push(`      ${d.property}${d.state ?? ""} = ${v}`);
        }
        if (decls.length > 20) lines.push(`      … (+${decls.length - 20} more decls)`);
      }
    }

    if (r.duplicateGroups.length > 0) {
      lines.push("");
      lines.push(`## Duplicate decl-sets (potential merges)`);
      for (const dg of r.duplicateGroups) {
        const names = dg.ids.map((id) => {
          const t = r.decorated.find((x) => x.id === id);
          return `"${t?.name}" (${t?.instances} usages)`;
        }).join(" ≡ ");
        lines.push(`  ${names}`);
      }
      lines.push("");
      lines.push(`💡 To merge: webstudio_replace_token { fromTokenName, toTokenName }  (migrate all selections, then delete fromToken)`);
    }

    return textResult(lines.join("\n"));
  },
};
