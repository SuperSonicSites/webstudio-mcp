// Mega-tool `styles` — v2.0. Local style operations on instances.
//
// Tier mapping:
//   - get_decls      → READ-ONLY
//   - update         → TACTICAL
//   - delete_decl    → TACTICAL
//   - replace_value  → STRUCTURING
//
// v2 hard break:
//   - `update`/`delete_decl` accept ONLY batch form (`updates:[...]` / `deletions:[...]`).
//     The v1 single form (`{instanceId, property, value, breakpoint?, state?}`) is GONE.
//   - `breakpointId` legacy alias REMOVED — pass `breakpoint` directly.
//   - `instanceLabelContains` legacy alias REMOVED — pass `instanceLabel` directly.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { updateStylesTool, updateStylesWireSchema } from "./update-styles.js";
import { deleteLocalStyleDeclTool, deleteLocalStyleDeclInputSchema } from "./delete-local-style-decl.js";
import { replaceLocalValueTool, replaceLocalValueInputSchema } from "./replace-local-value.js";
import { getDeclsTool, getDeclsInputSchema } from "./get-decls.js";

const TIER: Record<string, Tier> = {
  get_decls: "READ-ONLY",
  update: "TACTICAL",
  delete_decl: "TACTICAL",
  replace_value: "STRUCTURING",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("get_decls") }).passthrough(),
  Base.extend({ action: z.literal("update") }).passthrough(),
  Base.extend({ action: z.literal("delete_decl") }).passthrough(),
  Base.extend({ action: z.literal("replace_value") }).passthrough(),
]);

const D = {
  get_decls: `Use when: read effective style declarations on instance(s) before mutating styles. Do NOT use when: you need the full project state (use project.export) or the style sources only (use read.inspect target:"instance"). Returns: for each instance, the list of {property, value, source:"local"|"token", sourceName?, breakpoint, state?}. Pass json:true for structured output. Selection: pass instanceIds OR labelContains+pagePath. Optional filters: propertyFilter (substring), breakpoint (label), state, includeTokens (default true, set false for LOCAL only). Reading before mutating fills the read gap so agents stop improvising (e.g. box-shadow overlay hacks). Side effects: none. Example: {action:"get_decls",label:"audit-hero",projectSlug:"my-site",instanceIds:["abc"],propertyFilter:"background"} or {action:"get_decls",label:"local-only",projectSlug:"my-site",pagePath:"/",labelContains:"card",includeTokens:false}`,
  update: `Use when: tweak LOCAL styles on instances without re-pushing a fragment; batch updates only. Do NOT use when: modifying a TOKEN's own styles (use tokens.update_token_styles). Returns: decls applied. Pass updates as a batch: \`{updates:[{instanceId, property, value, breakpoint?, state?}, ...]}\`. Side effects: push. Example: {action:"update",label:"hero-color",projectSlug:"my-site",updates:[{instanceId:"abc",property:"color",value:{type:"keyword",value:"red"}}]}\n[PATTERN] Local = punctual override ONLY (one instance, one specific case). If you're pushing N identical decls on 2+ instances → wrong tool: create/enrich a token (tokens.create_tokens / tokens.update_token_styles) then dedupe_locals instead. See pattern "component-architecture".\n[READ-FIRST] Before pushing, consider calling styles.get_decls on the same instance to see the current state — avoids redundant overrides + lets you reason about cascade order.`,
  delete_decl: `Use when: remove specific LOCAL style decls from instances; batch deletions only. Do NOT use when: removing an entire local override (set styles to {}). Returns: decls removed. Pass deletions as a batch: \`{deletions:[{instanceId, property, breakpoint?, state?}, ...]}\`. Side effects: push. Example: {action:"delete_decl",label:"clear-padding",projectSlug:"my-site",deletions:[{instanceId:"abc",property:"paddingTop"}]}`,
  replace_value: `Use when: bulk-replace local style decls matching property+fromValue with toValue project-wide. Do NOT use when: applying a token (use tokens.attach_token). Returns: replacement count. Targets LOCAL only by default. Swap hardcoded values for token var(). Use \`instanceLabel\` for exact-match label filter. Side effects: push. Example: {action:"replace_value",label:"px-to-token",projectSlug:"my-site",property:"rowGap",fromValue:{type:"unit",value:8,unit:"px"},toValue:{type:"var",value:"space-s"}}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  get_decls: async (i: Record<string, unknown>) => getDeclsTool.handler(strip(i)),
  update: async (i: Record<string, unknown>) => updateStylesTool.handler(strip(i)),
  delete_decl: async (i: Record<string, unknown>) => deleteLocalStyleDeclTool.handler(strip(i)),
  replace_value: async (i: Record<string, unknown>) => replaceLocalValueTool.handler(strip(i)),
};

export const stylesMegaTool: ToolModule = {
  definition: {
    name: "styles",
    description: `Mega-tool for instance style declarations (read + write). 4 actions: get_decls (READ effective decls), update, delete_decl, replace_value (all LOCAL only — for TOKEN lifecycle use tokens mega-tool; for CSS variables use cssvar). v2: write actions only accept batch forms (updates:[...] / deletions:[...]). Recommended workflow: get_decls → reason → update.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "get_decls", description: D.get_decls, zod: getDeclsInputSchema },
      { action: "update", description: D.update, zod: updateStylesWireSchema },
      { action: "delete_decl", description: D.delete_decl, zod: deleteLocalStyleDeclInputSchema },
      { action: "replace_value", description: D.replace_value, zod: replaceLocalValueInputSchema },
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
    logContext({ tool: "styles", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });
    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
