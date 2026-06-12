// Tool: webstudio_get_decls — READ-ONLY effective style declarations for instance(s).
//
// Why: the `styles` mega-tool only exposed write actions (update/delete_decl/replace_value).
// The closest read primitive was `read.inspect`, which returns style *sources* (names + ids)
// but not the actual CSS decls. Agents that wanted to reason about current styles before
// mutating had to call `project.export` (a full dump) or improvise (e.g. box-shadow overlay
// hack — see issue #1 on Densrt/webstudio-mcp).
//
// This handler is wired as `styles.get_decls` (mega-tool action). Same Zod export pattern
// as the other styles sub-handlers so `buildJsonSchemaFromZodActions` derives the schema.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";
import { hintOnce } from "../lib/hint-once.js";
import { resolvePageInstanceIds } from "./inspect-instance/resolve.js";

export const getDeclsInputSchema = z.object({
  projectSlug: z.string(),
  /** Direct list of instance ids to inspect. Provide EITHER instanceIds OR labelContains (+pagePath/pageId). */
  instanceIds: z.array(z.string()).optional(),
  /** Resolve instance ids by case-insensitive substring match on instance label, scoped to a page. */
  labelContains: z.string().optional(),
  pageId: z.string().optional(),
  pagePath: z.string().optional(),
  /** Case-insensitive substring filter on the CSS property name (e.g. "color", "padding"). */
  propertyFilter: z.string().optional(),
  /** Breakpoint LABEL (e.g. "base", "Tablet", "Mobile portrait"). Default: all breakpoints. */
  breakpoint: z.string().optional(),
  /** State filter (e.g. ":hover", "::before"). Default: all states (including base-state decls). */
  state: z.string().optional(),
  /** Whether to include token-sourced decls (false → LOCAL decls only). Default true. */
  includeTokens: z.boolean().default(true),
  /** Maximum number of instances to report on (safety against accidental whole-page scans). Default 20. */
  maxInstances: z.number().int().min(1).max(500).default(20),
  /** Truncate each value's stringified form at this length. Default 200. */
  maxValueLength: z.number().int().min(0).default(200),
  /** Return structured JSON instead of the human-readable text report. Default false. */
  json: z.boolean().default(false),
}).strict();

type EffectiveDecl = {
  property: string;
  value: unknown;
  source: "local" | "token";
  sourceName?: string;
  sourceId: string;
  breakpoint: string;
  breakpointId: string;
  state?: string;
  listed?: boolean;
};

type InstanceReport = {
  instanceId: string;
  label?: string;
  component?: string;
  tag?: string;
  decls: EffectiveDecl[];
};

function truncate(s: string, n: number): string {
  if (n <= 0 || s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function describeValue(v: unknown, max: number): string {
  if (typeof v === "string") return `"${truncate(v, max)}"`;
  return truncate(JSON.stringify(v), max);
}

export function collectDecls(
  build: WebstudioBuild,
  opts: z.infer<typeof getDeclsInputSchema>,
  targetIds: string[],
): InstanceReport[] {
  const bpById = new Map(build.breakpoints.map((b) => [b.id, b]));
  const bpFilterLc = opts.breakpoint?.toLowerCase().trim();
  const stateFilter = opts.state?.trim();
  const propFilterLc = opts.propertyFilter?.toLowerCase().trim();

  const sourceById = new Map(build.styleSources.map((s) => [s.id, s]));
  const selectionByInstance = new Map(build.styleSourceSelections.map((sel) => [sel.instanceId, sel]));
  const instanceById = new Map(build.instances.map((i) => [i.id, i]));

  // Group styles by styleSourceId for fast lookup.
  const stylesBySource = new Map<string, typeof build.styles>();
  for (const decl of build.styles) {
    const arr = stylesBySource.get(decl.styleSourceId) ?? [];
    arr.push(decl);
    stylesBySource.set(decl.styleSourceId, arr);
  }

  const reports: InstanceReport[] = [];
  for (const id of targetIds) {
    const inst = instanceById.get(id);
    const sel = selectionByInstance.get(id);
    const decls: EffectiveDecl[] = [];

    if (sel) {
      // Iterate sources in selection order — Webstudio's cascade order.
      for (const sid of sel.values) {
        const source = sourceById.get(sid);
        if (!source) continue;
        if (source.type === "token" && !opts.includeTokens) continue;
        const sourceDecls = stylesBySource.get(sid) ?? [];
        for (const d of sourceDecls) {
          if (propFilterLc && !d.property.toLowerCase().includes(propFilterLc)) continue;
          const bp = bpById.get(d.breakpointId);
          const bpLabel = bp?.label ?? d.breakpointId;
          if (bpFilterLc && bpLabel.toLowerCase() !== bpFilterLc) continue;
          if (stateFilter !== undefined && (d.state ?? "") !== stateFilter) continue;
          decls.push({
            property: d.property,
            value: d.value,
            source: source.type,
            sourceName: source.type === "token" ? source.name : undefined,
            sourceId: sid,
            breakpoint: bpLabel,
            breakpointId: d.breakpointId,
            state: d.state,
            listed: d.listed,
          });
        }
      }
    }

    reports.push({
      instanceId: id,
      label: inst?.label,
      component: inst?.component.split(":").pop() || inst?.component,
      tag: inst?.tag,
      decls,
    });
  }

  return reports;
}

function renderReports(reports: InstanceReport[], opts: z.infer<typeof getDeclsInputSchema>): string {
  const lines: string[] = [];
  let totalDecls = 0;
  for (const r of reports) totalDecls += r.decls.length;
  lines.push(`# styles.get_decls — ${reports.length} instance(s), ${totalDecls} decl(s)`);
  if (opts.breakpoint) lines.push(`breakpoint filter: ${opts.breakpoint}`);
  if (opts.state !== undefined) lines.push(`state filter: ${opts.state || "(base only)"}`);
  if (opts.propertyFilter) lines.push(`property filter: ${opts.propertyFilter}`);
  if (!opts.includeTokens) lines.push(`scope: LOCAL only (includeTokens=false)`);

  for (const r of reports) {
    const compPart = r.component ? ` ${r.component}` : "";
    const tagPart = r.tag ? ` <${r.tag}>` : "";
    const labelPart = r.label ? ` "${r.label}"` : "";
    lines.push(`\n## [${r.instanceId}]${compPart}${tagPart}${labelPart}`);
    if (r.decls.length === 0) {
      lines.push(`  (no decls matching the filters)`);
      continue;
    }
    for (const d of r.decls) {
      const src = d.source === "token" ? `token "${d.sourceName ?? "?"}"` : "local";
      const statePart = d.state ? ` ${d.state}` : "";
      lines.push(`  - **${d.property}**${statePart} @ ${d.breakpoint} = ${describeValue(d.value, opts.maxValueLength)}  _(${src})_`);
    }
  }

  // Rate-limited per process (v2.20.3) — a fixed footer on every text response
  // is pure token overhead after the first read of a chained workflow.
  const tip = hintOnce(
    "get-decls-json-tip",
    "\n---\nTip: pass `json:true` to receive a structured payload for downstream tooling. Use `includeTokens:false` to scope to LOCAL overrides only.",
  );
  return lines.join("\n") + tip;
}

export const getDeclsTool: ToolModule = {
  definition: {
    name: "webstudio_get_decls",
    description: `Read-only effective style declarations for one or more instances. Internal handler dispatched by styles.get_decls.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        instanceIds: { type: "array", items: { type: "string" } },
        labelContains: { type: "string" },
        pageId: { type: "string" },
        pagePath: { type: "string" },
        propertyFilter: { type: "string" },
        breakpoint: { type: "string" },
        state: { type: "string" },
        includeTokens: { type: "boolean" },
        maxInstances: { type: "number" },
        maxValueLength: { type: "number" },
        json: { type: "boolean" },
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
    const parsed = getDeclsInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const opts = parsed.data;

    if (!opts.instanceIds?.length && !opts.labelContains && !opts.pageId && opts.pagePath === undefined) {
      return errorResult(
        "VALIDATION_FAILED",
        "Provide either instanceIds, or labelContains+pagePath|pageId. Pass pagePath alone (with no labelContains) to dump every instance on the page — capped by maxInstances.",
      );
    }

    let auth;
    try { auth = requireAuth(opts.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build: WebstudioBuild;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    let targetIds: string[] = [];
    if (opts.instanceIds && opts.instanceIds.length > 0) {
      targetIds = opts.instanceIds;
    } else {
      const r = resolvePageInstanceIds(build, opts);
      if (typeof r === "string") return errorResult("PAGE_NOT_FOUND", r);
      targetIds = r;
    }

    if (targetIds.length === 0) {
      return errorResult("INSTANCE_NOT_FOUND", "No instances matched. Provide instanceIds or labelContains+pagePath.");
    }

    const totalMatched = targetIds.length;
    const truncated = totalMatched > opts.maxInstances;
    if (truncated) targetIds = targetIds.slice(0, opts.maxInstances);

    const reports = collectDecls(build, opts, targetIds);

    if (opts.json) {
      const payload = {
        projectSlug: opts.projectSlug,
        instanceCount: reports.length,
        truncated,
        truncatedFrom: truncated ? totalMatched : undefined,
        filters: {
          propertyFilter: opts.propertyFilter,
          breakpoint: opts.breakpoint,
          state: opts.state,
          includeTokens: opts.includeTokens,
        },
        reports,
      };
      // MCP structuredContent (spec 2025-06-18): typed clients consume the
      // payload directly without re-parsing the text block (kept for compat).
      // Round-tripped through JSON so undefined-valued keys are dropped —
      // structuredContent must be plain JSON, and both views stay identical.
      const json = JSON.stringify(payload, null, 2);
      return {
        content: [{ type: "text" as const, text: json }],
        structuredContent: JSON.parse(json) as Record<string, unknown>,
      };
    }

    const text = renderReports(reports, opts);
    const footer = truncated ? `\n\n[truncated: ${reports.length}/${totalMatched} instances — increase maxInstances to see more]` : "";
    return textResult(text + footer);
  },
};
