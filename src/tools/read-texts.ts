// Tool: webstudio_read_texts — read all text and expression children of instances on a page.
// Useful for editorial passes, finding template residues (e.g. another client's brand name
// left over in a cloned template), and dumping content before mass updates.
//
// Reads ALL text/expression children (not just the first), so hidden 2nd/3rd children
// like dynamic bindings stuck behind a static text are surfaced.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";

export const readTextsInputSchema = z.object({
  projectSlug: z.string(),
  pageId: z.string().optional(),
  pagePath: z.string().optional(),
  /** Filter by instance label (case-insensitive substring). */
  labelContains: z.string().optional(),
  /** Filter by html tag (h1, p, span, a, button, ...). */
  tag: z.string().optional(),
  /** Filter by component (exact match or Radix suffix, e.g. "Heading"). */
  component: z.string().optional(),
  /** Substring match on the text/expression value (case-insensitive). */
  contains: z.string().optional(),
  /** Filter by child kind: text-only, expression-only, or both. Default: all. */
  mode: z.enum(["all", "text", "expression"]).default("all"),
  /** Forbidden terms — case-insensitive — flag any text/expression that contains them. */
  forbiddenTerms: z.array(z.string()).optional(),
  /** Truncate displayed text values to this length (default 300, 0 = no truncation). */
  maxValueLength: z.number().int().min(0).default(300),
  /** If true, only show instances that have at least one match (filters or forbidden term hit). */
  matchesOnly: z.boolean().default(false),
}).strict();

type ResolvedPage = { pageId: string; rootInstanceId: string; name: string; path: string };

function resolvePage(build: WebstudioBuild, opts: z.infer<typeof readTextsInputSchema>): ResolvedPage | { error: string } {
  if (opts.pageId) {
    const page = build.pages.pages.find((p) => p.id === opts.pageId);
    if (!page) return { error: `Page not found with pageId="${opts.pageId}"` };
    return { pageId: page.id, rootInstanceId: page.rootInstanceId, name: page.name, path: page.path };
  }
  if (opts.pagePath) {
    const page = build.pages.pages.find((p) => p.path === opts.pagePath);
    if (!page) {
      const available = build.pages.pages.map((p) => p.path).join(", ");
      return { error: `Page not found with pagePath="${opts.pagePath}". Available: ${available}` };
    }
    return { pageId: page.id, rootInstanceId: page.rootInstanceId, name: page.name, path: page.path };
  }
  const home = build.pages.pages.find((p) => p.id === build.pages.homePageId);
  if (!home) return { error: "No home page in build" };
  return { pageId: home.id, rootInstanceId: home.rootInstanceId, name: home.name, path: home.path };
}

function collectInstanceIds(build: WebstudioBuild, rootInstanceId: string): string[] {
  const ids: string[] = [];
  const visit = (id: string) => {
    const inst = build.instances.find((i) => i.id === id);
    if (!inst) return;
    ids.push(inst.id);
    for (const c of inst.children) {
      if (c.type === "id") visit(c.value);
    }
  };
  visit(rootInstanceId);
  return ids;
}

type Hit = {
  instanceId: string;
  childIndex: number;
  type: "text" | "expression";
  value: string;
  tag?: string;
  label?: string;
  component: string;
  forbiddenHits: string[];
};

function componentMatches(component: string, target: string): boolean {
  if (component === target) return true;
  if (component.endsWith(`:${target}`)) return true;
  if ((component.split(":").pop() || component) === target) return true;
  return false;
}

function truncate(s: string, max: number): string {
  if (max <= 0) return s;
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export const readTextsTool: ToolModule = {
  definition: {
    name: "webstudio_read_texts",
    description: `Use when: editorial pass, template cleanup, or hunting for residual brand names after cloning a template. Dumps every text/expression child on a page (not just the first), so hidden dynamic bindings stuck behind a static text are surfaced.
Do NOT use when: you only need the tree structure with IDs — use webstudio_list_instances (lighter). To edit a text after locating it, use webstudio_update_instance_text with the returned (instanceId, childIndex).
Returns: entries of {instanceId, childIndex, type:"text"|"expression", value, tag, label, component, forbiddenHits}.
Filters: labelContains, tag, component, contains (substring), mode (text|expression|all), forbiddenTerms (flag banned strings like "Lorem" or another client's brand), matchesOnly.
Side effects: none (read-only).

Example: { projectSlug: "acme", pagePath: "/", forbiddenTerms: ["the project", "Lorem ipsum"], matchesOnly: true }
Example: { projectSlug: "my-site", tag: "h1", mode: "text" }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        pageId: { type: "string", description: "Page ID (defaults to home)" },
        pagePath: { type: "string", description: "Page path (e.g. /contact)" },
        labelContains: { type: "string" },
        tag: { type: "string", description: "html tag filter (h1, p, span, a, ...)" },
        component: { type: "string" },
        contains: { type: "string", description: "substring match on the text/expression value" },
        mode: { type: "string", enum: ["all", "text", "expression"] },
        forbiddenTerms: { type: "array", items: { type: "string" }, description: "Flag any text/expression matching these (case-insensitive)" },
        maxValueLength: { type: "number", description: "Truncate displayed values; 0 = no truncate (default 300)" },
        matchesOnly: { type: "boolean", description: "Only show entries with a forbidden-term hit or contains-match" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
    annotations: {
      title: "Read text contents of a page",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args) => {
    const parsed = readTextsInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const opts = parsed.data;

    let auth;
    try { auth = requireAuth(opts.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const resolved = resolvePage(build, opts);
    if ("error" in resolved) return errorResult("PAGE_NOT_FOUND", resolved.error);

    const ids = collectInstanceIds(build, resolved.rootInstanceId);
    const idSet = new Set(ids);
    const hits: Hit[] = [];

    const containsLower = opts.contains?.toLowerCase();
    const labelLower = opts.labelContains?.toLowerCase();
    const forbiddenLower = (opts.forbiddenTerms ?? []).map((t) => t.toLowerCase());

    for (const inst of build.instances) {
      if (!idSet.has(inst.id)) continue;

      // Filtre instance-level
      if (labelLower && !(inst.label?.toLowerCase().includes(labelLower))) continue;
      if (opts.tag && inst.tag !== opts.tag) continue;
      if (opts.component && !componentMatches(inst.component, opts.component)) continue;

      const children = inst.children ?? [];
      // childIndex must be an index among text/expression children ONLY,
      // matching the convention used by webstudio_update_instance_text.
      let textExprIndex = -1;
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c.type !== "text" && c.type !== "expression") continue;
        textExprIndex++;

        if (opts.mode === "text" && c.type !== "text") continue;
        if (opts.mode === "expression" && c.type !== "expression") continue;

        const value = String(c.value ?? "");
        if (containsLower && !value.toLowerCase().includes(containsLower)) continue;

        const forbiddenHits = forbiddenLower
          .filter((t) => value.toLowerCase().includes(t))
          .map((t) => opts.forbiddenTerms!.find((orig) => orig.toLowerCase() === t)!);

        if (opts.matchesOnly && !containsLower && forbiddenHits.length === 0) continue;

        hits.push({
          instanceId: inst.id,
          childIndex: textExprIndex,
          type: c.type,
          value,
          tag: inst.tag,
          label: inst.label,
          component: inst.component,
          forbiddenHits,
        });
      }
    }

    const pageHeader = `Page: ${resolved.path || "/"} (${resolved.name}) — pageId=${resolved.pageId}`;

    if (hits.length === 0) {
      return textResult(`${pageHeader}\n\nNo text/expression matches.`);
    }

    const totalForbidden = hits.reduce((n, h) => n + h.forbiddenHits.length, 0);
    const lines: string[] = [];
    for (const h of hits) {
      const compShort = h.component.split(":").pop() || h.component;
      const tagPart = h.tag ? ` <${h.tag}>` : "";
      const labelPart = h.label ? ` "${h.label}"` : "";
      const flag = h.forbiddenHits.length > 0 ? ` ⚠️ FORBIDDEN: ${h.forbiddenHits.join(", ")}` : "";
      lines.push(
        `[${h.instanceId}][${h.childIndex}] ${compShort}${tagPart}${labelPart} (${h.type})${flag}\n  > ${truncate(h.value, opts.maxValueLength)}`,
      );
    }

    const summary = totalForbidden > 0
      ? `\n\n⚠️ ${totalForbidden} forbidden-term hit(s) across ${hits.filter((h) => h.forbiddenHits.length).length} entry(ies).`
      : "";

    return textResult(`${pageHeader}\n\n${hits.length} entry(ies):\n\n${lines.join("\n\n")}${summary}`);
  },
};
