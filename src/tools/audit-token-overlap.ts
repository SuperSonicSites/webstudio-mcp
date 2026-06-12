// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"token-overlap").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"token-overlap", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_token_overlap
//
// For a given token, lists every instance that consumes it AND classifies
// each of that instance's local decls vs the token's decls into:
//   - DUPE: same (breakpoint, property, state) and same value  → safe to strip via cleanup_orphan_locals
//   - OVERRIDE: same (breakpoint, property, state), different value → intentional? candidate for extract_variant_token
//   - UNIQUE: local-only (no matching token decl on that (breakpoint, property, state))
//
// Read-only.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";
import { normalizeState, stateMatches } from "../lib/state-whitelist.js";

export const auditTokenOverlapInputSchema = z.object({
  projectSlug: z.string(),
  /** Identify the token by name (exact match) OR by id. One of the two is required. */
  tokenName: z.string().optional(),
  tokenId: z.string().optional(),
  /** Cap the number of instances detailed in the report (summary still totals all). Default 25. */
  maxInstances: z.number().int().min(1).default(25),
  /** Include per-decl detail (DUPE/OVERRIDE/UNIQUE lines) for each instance. Default true. */
  verbose: z.boolean().default(true),
}).strict();

type Decl = WebstudioBuild["styles"][number];

function valueSig(v: Decl["value"]): string {
  return JSON.stringify(v);
}

export function buildReport(build: WebstudioBuild, args: z.infer<typeof auditTokenOverlapInputSchema>) {
  const token = build.styleSources.find((s) => {
    if (s.type !== "token") return false;
    if (args.tokenId) return s.id === args.tokenId;
    if (args.tokenName) return s.name === args.tokenName;
    return false;
  });
  if (!token || token.type !== "token") return { error: "TOKEN_NOT_FOUND" as const };

  const bpLabels = new Map(build.breakpoints.map((b) => [b.id, b.label]));
  const instanceLabels = new Map(build.instances.map((i) => [i.id, i.label || i.component || i.id.slice(0, 8)]));

  const tokenDecls = build.styles.filter((d) => d.styleSourceId === token.id);
  // Token decls aren't indexed by string key anymore — we tolerate state corruption via
  // stateMatches (so `::hover` corruption matches a canonical `:hover` token decl).
  // Linear scan is fine at our scale (tokens have < 100 decls per consumer).

  // Find instances that consume this token
  const consumers: Array<{ instanceId: string; localSourceId: string | null }> = [];
  const localTypes = new Map(build.styleSources.map((s) => [s.id, s.type]));
  for (const sel of build.styleSourceSelections) {
    if (!sel.values?.includes(token.id)) continue;
    const localId = sel.values.find((v) => localTypes.get(v) === "local") ?? null;
    consumers.push({ instanceId: sel.instanceId, localSourceId: localId });
  }

  // For each consumer, classify local decls
  type Classified = { kind: "DUPE" | "OVERRIDE" | "UNIQUE"; bp: string; prop: string; state: string; localValue: Decl["value"]; tokenValue?: Decl["value"] };
  const perInstance = consumers.map((c) => {
    const localDecls = c.localSourceId
      ? build.styles.filter((d) => d.styleSourceId === c.localSourceId)
      : [];
    const classified: Classified[] = [];
    let dupes = 0, overrides = 0, uniques = 0;
    for (const d of localDecls) {
      const tokenDecl = tokenDecls.find(
        (t) =>
          t.breakpointId === d.breakpointId &&
          t.property === d.property &&
          stateMatches(t.state, d.state),
      );
      const bpLabel = bpLabels.get(d.breakpointId) ?? d.breakpointId;
      if (tokenDecl === undefined) {
        uniques++;
        classified.push({ kind: "UNIQUE", bp: bpLabel, prop: d.property, state: d.state ?? "", localValue: d.value });
      } else if (valueSig(tokenDecl.value) === valueSig(d.value)) {
        dupes++;
        classified.push({ kind: "DUPE", bp: bpLabel, prop: d.property, state: d.state ?? "", localValue: d.value, tokenValue: tokenDecl.value });
      } else {
        overrides++;
        classified.push({ kind: "OVERRIDE", bp: bpLabel, prop: d.property, state: d.state ?? "", localValue: d.value, tokenValue: tokenDecl.value });
      }
    }
    return {
      instanceId: c.instanceId,
      label: instanceLabels.get(c.instanceId) ?? c.instanceId,
      hasLocal: c.localSourceId !== null,
      classified,
      dupes,
      overrides,
      uniques,
    };
  });

  // Totals
  const totals = perInstance.reduce(
    (acc, p) => ({ dupes: acc.dupes + p.dupes, overrides: acc.overrides + p.overrides, uniques: acc.uniques + p.uniques }),
    { dupes: 0, overrides: 0, uniques: 0 }
  );

  // Token health check — flag token decls whose stored `state` value is not a recognized
  // pseudo-class / pseudo-element / attribute selector. These are typically the result of
  // an upstream bug (legacy single-colon writes, case mistakes, manual edits) and silently
  // break the matcher because the state field is treated as opaque elsewhere.
  type CorruptDecl = { decl: typeof tokenDecls[number]; bp: string; rawState: string; suggestion?: string; reason?: string };
  const corruptDecls: CorruptDecl[] = [];
  for (const d of tokenDecls) {
    if (d.state === undefined) continue;
    const n = normalizeState(d.state);
    if (n.isValid) continue;
    corruptDecls.push({
      decl: d,
      bp: bpLabels.get(d.breakpointId) ?? d.breakpointId,
      rawState: d.state,
      suggestion: n.suggestion,
      reason: n.reason,
    });
  }

  return {
    token: { id: token.id, name: token.name },
    tokenDecls,
    bpLabels,
    perInstance,
    totals,
    corruptDecls,
  };
}

function valueStr(v: Decl["value"]): string {
  if (!v) return "(null)";
  const anyV = v as { type: string; value?: unknown; unit?: string };
  if (anyV.type === "unit") return `${anyV.value}${anyV.unit ?? ""}`;
  if (anyV.type === "var") return `var(--${anyV.value})`;
  if (anyV.type === "keyword") return String(anyV.value);
  return JSON.stringify(v).slice(0, 50);
}

export const auditTokenOverlapTool: ToolModule = {
  definition: {
    name: "webstudio_audit_token_overlap",
    description: `Use when: you need to know which local decls duplicate or override a given token's decls (DS health check).
For each instance consuming the token, classifies its local decls as DUPE/OVERRIDE/UNIQUE per (breakpoint, property, state).
Outputs: token summary + per-instance breakdown + global totals + recommended next tools.
Identify the token by tokenName (exact) OR tokenId. Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        tokenName: { type: "string", description: "Exact token name (one of tokenName/tokenId required)." },
        tokenId: { type: "string", description: "Token id (one of tokenName/tokenId required)." },
        maxInstances: { type: "number" },
        verbose: { type: "boolean" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditTokenOverlapInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const data = parsed.data;
    if (!data.tokenName && !data.tokenId) {
      return errorResult("VALIDATION_FAILED", "Provide tokenName or tokenId.");
    }

    let auth;
    try { auth = requireAuth(data.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build: WebstudioBuild;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const r = buildReport(build, data);
    if ("error" in r) {
      return errorResult("TOKEN_NOT_FOUND", `Token not found: ${data.tokenName ?? data.tokenId}`);
    }

    const lines: string[] = [];
    lines.push(`# Token overlap audit — "${r.token.name}" [${r.token.id}]`);
    lines.push(`Project: ${data.projectSlug} | Consumers: ${r.perInstance.length} instances`);
    lines.push(`Token decls: ${r.tokenDecls.length} | Local totals → DUPE: ${r.totals.dupes} · OVERRIDE: ${r.totals.overrides} · UNIQUE: ${r.totals.uniques}`);
    lines.push("");

    // Token health — surface decls with malformed state field BEFORE the overlap analysis.
    // The matcher elsewhere uses stateMatches (tolerant) but corruption should still be
    // surfaced explicitly so the user can clean it up.
    lines.push(`## Token health`);
    if (r.corruptDecls.length === 0) {
      lines.push(`  ✅ ${r.tokenDecls.length} decl(s) validated — all states recognized`);
    } else {
      lines.push(`  ⚠️ ${r.corruptDecls.length} decl(s) have a malformed state field (rest of audit ignores these)`);
      for (const c of r.corruptDecls) {
        const suggestion = c.suggestion ? ` → suggested "${c.suggestion}"` : "";
        const reason = c.reason ? ` (${c.reason})` : "";
        lines.push(`    🛑 [${c.bp}] ${c.decl.property} state=${JSON.stringify(c.rawState)}${suggestion}${reason}`);
      }
      lines.push(`  Fix: webstudio_update_token_styles auto-cleans corrupted variants when you write the canonical form, OR target the literal raw state via webstudio_styles(action:"delete") for local decls.`);
    }
    lines.push("");

    // Token decls summary
    lines.push(`## Token decls`);
    if (r.tokenDecls.length === 0) {
      lines.push(`  (no decls — empty token)`);
    } else {
      for (const d of r.tokenDecls) {
        const bp = r.bpLabels.get(d.breakpointId) ?? d.breakpointId;
        lines.push(`  [${bp}] ${d.property}${d.state ?? ""} = ${valueStr(d.value)}`);
      }
    }
    lines.push("");

    // Per-instance breakdown
    const shown = r.perInstance.slice(0, data.maxInstances);
    lines.push(`## Consumers (showing ${shown.length}/${r.perInstance.length})`);
    for (const p of shown) {
      lines.push(`### [${p.instanceId.slice(0, 8)}] ${p.label}`);
      if (!p.hasLocal) {
        lines.push(`  (no local style source — token applied as-is, nothing to audit)`);
      } else {
        lines.push(`  ${p.dupes} DUPE · ${p.overrides} OVERRIDE · ${p.uniques} UNIQUE`);
        if (data.verbose && p.classified.length > 0) {
          for (const c of p.classified) {
            if (c.kind === "DUPE") {
              lines.push(`    🟢 DUPE [${c.bp}] ${c.prop}${c.state} = ${valueStr(c.localValue)}`);
            } else if (c.kind === "OVERRIDE") {
              lines.push(`    🟡 OVERRIDE [${c.bp}] ${c.prop}${c.state}: token=${valueStr(c.tokenValue!)} ≠ local=${valueStr(c.localValue)}`);
            } else {
              lines.push(`    🔵 UNIQUE [${c.bp}] ${c.prop}${c.state} = ${valueStr(c.localValue)}`);
            }
          }
        }
      }
      lines.push("");
    }
    if (r.perInstance.length > shown.length) {
      lines.push(`… (+${r.perInstance.length - shown.length} more consumers, increase maxInstances to see all)`);
      lines.push("");
    }

    // Recommendations
    lines.push(`## Recommended next steps`);
    if (r.totals.dupes > 0) {
      lines.push(`  - ${r.totals.dupes} DUPE decls → run webstudio_cleanup_orphan_locals (or webstudio_dedupe_token_locals) to strip them.`);
    }
    if (r.totals.overrides > 0) {
      lines.push(`  - ${r.totals.overrides} OVERRIDE decls → if intentional + shared by ≥2 consumers, promote via webstudio_extract_variant_token.`);
    }
    if (r.totals.dupes === 0 && r.totals.overrides === 0 && r.totals.uniques === 0) {
      lines.push(`  - No local conflicts on consumers (token health audited above).`);
    }

    return textResult(lines.join("\n"));
  },
};
