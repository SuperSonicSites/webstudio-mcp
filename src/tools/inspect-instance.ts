// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_inspect(target:"instance").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/inspect.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `inspect({target:"instance", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_inspect_instance — read-only deep inspection of one or more instances.
// Returns: tag, label, component, props (filterable), text/expression children inline,
// child instance ids, and styleSourceSelections (token + local sources).

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import { hintOnce } from "../lib/hint-once.js";
import type { WebstudioBuild } from "../webstudio-client.js";
import { resolvePageInstanceIds } from "./inspect-instance/resolve.js";
import { buildIndexes, renderInstance } from "./inspect-instance/format.js";

export const inspectInstanceInputSchema = z.object({
  projectSlug: z.string(),
  instanceIds: z.array(z.string()).optional(),
  labelContains: z.string().optional(),
  pageId: z.string().optional(),
  pagePath: z.string().optional(),
  propNameContains: z.string().optional(),
  maxValueLength: z.number().int().min(0).default(200),
  childDepth: z.number().int().min(0).max(5).default(1),
}).strict();

export const inspectInstanceTool: ToolModule = {
  definition: {
    name: "webstudio_inspect_instance",
    description: `Use when: before patching an instance, you need to see its component, props, text/expression children, and style sources.
Target via instanceIds OR labelContains+pagePath|pageId. Returns child instance tree up to
childDepth (default 1) and filters props via propNameContains. childIndex on text/expression
children matches the convention used by update_instance_text.
Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        instanceIds: { type: "array", items: { type: "string" } },
        labelContains: { type: "string" },
        pageId: { type: "string" },
        pagePath: { type: "string" },
        propNameContains: { type: "string" },
        maxValueLength: { type: "number" },
        childDepth: { type: "number" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = inspectInstanceInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const opts = parsed.data;

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

    const idx = buildIndexes(build);
    const lines: string[] = [];
    for (const id of targetIds) {
      renderInstance(id, idx, opts, lines);
    }

    // Discoverability hint: this dump shows style SOURCES (ids + token names),
    // not the actual CSS values. Agents that miss this gap hack around it (the
    // box-shadow-overlay regression on a production site, May 2026). Nudge toward
    // the proper read primitive — rate-limited per process (v2.20.3): the fixed
    // string exceeded the data on small inspects when repeated on every call.
    const hint = hintOnce(
      "inspect-style-sources",
      "\n\n[hint] Style sources above are NAMES + IDs only — not actual CSS values. " +
        "Call `styles.get_decls` to read effective declarations on these instance(s) " +
        "(supports propertyFilter, breakpoint, state, includeTokens), or `project.export` " +
        "for the entire build state.",
    );

    return textResult(`Inspected ${targetIds.length} instance(s):${lines.join("\n")}${hint}`);
  },
};
