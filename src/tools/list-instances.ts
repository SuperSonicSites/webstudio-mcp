// Tool: webstudio_list_instances — search/filter the instances of a build.
// Useful for debugging, finding IDs, or before a targeted delete/replace.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";

export const listInstancesInputSchema = z.object({
  projectSlug: z.string(),
  /** Page ID to inspect. Defaults to the home page. */
  pageId: z.string().optional(),
  /** Page path (e.g. "/about"). Alternative to pageId. */
  pagePath: z.string().optional(),
  /** Filter by label (case-insensitive substring). */
  labelContains: z.string().optional(),
  /** Filter by component (exact match or suffix). E.g. "Dialog" matches the suffix of @webstudio-is/...:Dialog. */
  component: z.string().optional(),
  /** If true, only show direct children of root (top-level). */
  topLevelOnly: z.boolean().default(false),
  /** Max tree depth (0 = root only, undefined = unlimited). */
  maxDepth: z.number().int().min(0).optional(),
}).strict();

type Row = { id: string; label?: string; component: string; tag?: string; depth: number; parentId?: string };

type ResolvedPage = { pageId: string; rootInstanceId: string; name: string; path: string };

function resolvePage(build: WebstudioBuild, opts: z.infer<typeof listInstancesInputSchema>): ResolvedPage | { error: string } {
  // 1. Explicit pageId.
  if (opts.pageId) {
    const page = build.pages.pages.find((p) => p.id === opts.pageId);
    if (!page) return { error: `Page not found with pageId="${opts.pageId}"` };
    return { pageId: page.id, rootInstanceId: page.rootInstanceId, name: page.name, path: page.path };
  }
  // 2. Explicit pagePath.
  if (opts.pagePath) {
    const page = build.pages.pages.find((p) => p.path === opts.pagePath);
    if (!page) {
      const available = build.pages.pages.map((p) => p.path).join(", ");
      return { error: `Page not found with pagePath="${opts.pagePath}". Available pages: ${available}` };
    }
    return { pageId: page.id, rootInstanceId: page.rootInstanceId, name: page.name, path: page.path };
  }
  // 3. Fallback: home page.
  const home = build.pages.pages.find((p) => p.id === build.pages.homePageId);
  if (!home) return { error: "No home page defined in the build" };
  return { pageId: home.id, rootInstanceId: home.rootInstanceId, name: home.name, path: home.path };
}

function flattenInstances(build: WebstudioBuild, opts: z.infer<typeof listInstancesInputSchema>, rootInstanceId: string): Row[] {
  const rows: Row[] = [];
  const visit = (id: string, depth: number, parentId?: string) => {
    if (opts.maxDepth !== undefined && depth > opts.maxDepth) return;
    const inst = build.instances.find((i) => i.id === id);
    if (!inst) return;
    rows.push({
      id: inst.id,
      label: inst.label,
      component: inst.component,
      tag: inst.tag,
      depth,
      parentId,
    });
    if (opts.topLevelOnly && depth >= 1) return;
    for (const c of inst.children) {
      if (c.type === "id") visit(c.value, depth + 1, inst.id);
    }
  };

  const root = build.instances.find((i) => i.id === rootInstanceId);
  if (!root) return [];
  for (const c of root.children) {
    if (c.type === "id") visit(c.value, 0, root.id);
  }
  return rows;
}

function applyFilters(rows: Row[], opts: z.infer<typeof listInstancesInputSchema>): Row[] {
  return rows.filter((r) => {
    if (opts.labelContains) {
      if (!r.label || !r.label.toLowerCase().includes(opts.labelContains.toLowerCase())) return false;
    }
    if (opts.component) {
      // Exact match OR suffix after ':' (for Radix).
      const comp = r.component;
      const matchExact = comp === opts.component;
      const matchSuffix = comp.endsWith(`:${opts.component}`);
      const matchSimple = comp === opts.component || comp.split(":").pop() === opts.component;
      if (!matchExact && !matchSuffix && !matchSimple) return false;
    }
    return true;
  });
}

export const listInstancesTool: ToolModule = {
  definition: {
    name: "webstudio_list_instances",
    description: `Use when: find an instance ID by label, browse a page tree, or pick a target before update/delete/clone/wrap.
Do NOT use when: you already have an ID and need full props/styles/tokens — use webstudio_inspect(target:"instance") for that depth.
Returns: indented tree of {id, label, component, tag, depth, parentId} for the resolved page. Defaults to the home page.
Filters: labelContains (case-insensitive substring), component (exact OR Radix suffix like "Dialog"), topLevelOnly, maxDepth.
Side effects: none (read-only).

Example: { projectSlug: "acme", pagePath: "/", labelContains: "hero", topLevelOnly: true }
Example: { projectSlug: "my-site", pageId: "abc123", component: "Dialog", maxDepth: 3 }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        pageId: { type: "string", description: "Page ID to inspect (defaults to home)" },
        pagePath: { type: "string", description: "Page path (e.g. /about) — alternative to pageId" },
        labelContains: { type: "string" },
        component: { type: "string" },
        topLevelOnly: { type: "boolean" },
        maxDepth: { type: "number" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
    annotations: {
      title: "List instances on a page",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args) => {
    const parsed = listInstancesInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);

    let auth;
    try { auth = requireAuth(parsed.data.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const resolved = resolvePage(build, parsed.data);
    if ("error" in resolved) return errorResult("PAGE_NOT_FOUND", resolved.error);

    const all = flattenInstances(build, parsed.data, resolved.rootInstanceId);
    const filtered = applyFilters(all, parsed.data);

    const pageHeader = `Page: ${resolved.path || "/"} (${resolved.name}) — pageId=${resolved.pageId} rootInstanceId=${resolved.rootInstanceId}`;

    if (filtered.length === 0) {
      return textResult(`${pageHeader}\n\nNo instance matches the filters (${all.length} total on this page).`);
    }

    const lines = filtered.map((r) => {
      const indent = "  ".repeat(r.depth);
      const tagPart = r.tag ? ` <${r.tag}>` : "";
      const labelPart = r.label ? ` "${r.label}"` : "";
      const compShort = r.component.split(":").pop() || r.component;
      return `${indent}[${r.id}] ${compShort}${tagPart}${labelPart}`;
    });

    return textResult(`${pageHeader}\n\n${filtered.length} instance(s) of ${all.length}:\n\n${lines.join("\n")}`);
  },
};
