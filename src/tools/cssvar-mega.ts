// Mega-tool `cssvar` — v2.0. CSS variable lifecycle.
//
// Tier mapping:
//   - delete                            → CRITICAL (refs would break)
//   - define, rewrite_refs              → STRUCTURING
//   - list                              → READ-ONLY
//
// v2 hard break:
//   - `define` accepts ONLY `{vars:{[name]:value}}` (v1 single form `{name, value}` GONE).
//   - `delete` accepts ONLY `{names:[...]}` (v1 single form `{name}` GONE).
//   - `rewrite_refs` accepts ONLY `{map:{[from]:to}}` (v1 single `{fromName, toName}` GONE).
//   - `scope` legacy field REMOVED.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { defineCssVarTool, defineCssVarInputSchema } from "./define-css-var.js";
import { listCssVarsTool, listCssVarsInputSchema } from "./list-css-vars.js";
import { deleteCssVarTool, deleteCssVarInputSchema } from "./delete-css-var.js";
import { rewriteVarReferencesTool, rewriteVarReferencesInputSchema } from "./rewrite-var-references.js";

const TIER: Record<string, Tier> = {
  define: "STRUCTURING",
  list: "READ-ONLY",
  delete: "CRITICAL",
  rewrite_refs: "STRUCTURING",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("define") }).passthrough(),
  Base.extend({ action: z.literal("list") }).passthrough(),
  Base.extend({ action: z.literal("delete") }).passthrough(),
  Base.extend({ action: z.literal("rewrite_refs") }).passthrough(),
]);

const D = {
  define: `Use when: define or update project-level CSS variables; batch vars map only. Do NOT use when: setting a local style decl (use styles.update). Batch form only: \`{vars:{[name]:value,...}, breakpoint?, overwrite?, strict?}\`; values can be strings (auto-parsed) or StyleValue objects. Returns: confirmation. Side effects: push. Example: {action:"define",label:"set-brand",projectSlug:"my-site",vars:{"brand-primary":"#FF0000","brand-space-s":"8px"}}\n[PATTERN] CSS var = UNIVERSAL primitive (brand color, spacing scale, base typo). Reused 10+ times site-wide. For a one-off value or a component-specific value (e.g. card height used twice) → use a token or a local style, NOT a var. Anti-pattern B: --card-height for 2 cards. ❌ Default bias: create the fewest vars possible. See pattern "component-architecture".`,
  list: `Use when: list all CSS variables defined on the project (with their scope). Do NOT use when: needing local tokens (use tokens.list_local). Returns: array of {name, value, scope}. Side effects: none. Example: {action:"list",label:"audit-vars",projectSlug:"my-site"}`,
  delete: `Use when: remove CSS variables from the project. Batch form only: \`{names:[...]}\`. Do NOT use when: refs to these vars still exist (use action:"rewrite_refs" first). Returns: confirmation. Side effects: push, CRITICAL — context required, refs to these vars will break. Example: {action:"delete",label:"drop-legacy",projectSlug:"my-site",names:["old-color"],context:"Removing the legacy color variable after rewriting all style references to the new design system token last week",dryRun:true}`,
  rewrite_refs: `Use when: bulk-rewrite var() REFERENCES across all style decls via a from-to map. Do NOT use when: renaming the var itself (delete + define). Typical uses: forked template missing vars, var name migration. Batch form only: \`{map:{[from]:to,...}, scopeRegex?}\`. Returns: refs rewritten count. Side effects: push. Example: {action:"rewrite_refs",label:"migrate-vars",projectSlug:"my-site",map:{"old-primary":"brand-primary"}}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  define: async (i: Record<string, unknown>) => defineCssVarTool.handler(strip(i)),
  list: async (i: Record<string, unknown>) => listCssVarsTool.handler(strip(i)),
  delete: async (i: Record<string, unknown>) => deleteCssVarTool.handler(strip(i)),
  rewrite_refs: async (i: Record<string, unknown>) => rewriteVarReferencesTool.handler(strip(i)),
};

export const cssvarTool: ToolModule = {
  definition: {
    name: "cssvar",
    description: `Mega-tool for CSS variable lifecycle (project-level :root vars). 4 actions: define, list, delete, rewrite_refs. delete is CRITICAL (existing var() refs would break — context required). v2: only batch forms accepted.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "define", description: D.define, zod: defineCssVarInputSchema },
      { action: "list", description: D.list, zod: listCssVarsInputSchema },
      { action: "delete", description: D.delete, zod: deleteCssVarInputSchema },
      { action: "rewrite_refs", description: D.rewrite_refs, zod: rewriteVarReferencesInputSchema },
    ]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  handler: async (args) => {
    const parsed = Schema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const input = parsed.data as Record<string, unknown> & { action: string; label: string; context?: string };
    const labelCheck = validateLabel(input.label);
    if (!labelCheck.ok) return errorResult("VALIDATION_FAILED", labelCheck.error);
    const tier = TIER[input.action];
    const ctxCheck = validateContext(input.context, tier);
    if (!ctxCheck.ok) return errorResult(ctxCheck.code, ctxCheck.error);
    logContext({ tool: "cssvar", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });
    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
