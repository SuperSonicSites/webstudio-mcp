// Mega-tool `variables` — v2.0.
//
// Consolidates 5 atomic variable tools (create / list / update / delete / bind_page_field)
// behind a single MCP tool. v2.0 derives the JSON schema from the Zod schema of each
// atomic sub-handler (single source of truth), drops all v1 wrapper sugar and legacy
// aliases.
//
// Tier mapping:
//   - delete           → CRITICAL (breaks bindings — context required)
//   - create           → STRUCTURING (context recommended)
//   - update           → TACTICAL
//   - bind_page_field  → TACTICAL
//   - list             → READ-ONLY

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { createVariableTool, listVariablesTool, createVariableInputSchema, listVariablesInputSchema } from "./variables.js";
import { updateVariableTool, updateVariableInputSchema } from "./update-variable.js";
import { deleteVariablesBatchTool, deleteVariablesBatchInputSchema } from "./delete-variables-batch.js";
import { bindPageFieldTool, bindPageFieldInputSchema } from "./bind-page-field.js";

const TIER: Record<string, Tier> = {
  create: "STRUCTURING",
  list: "READ-ONLY",
  update: "TACTICAL",
  delete: "CRITICAL",
  bind_page_field: "TACTICAL",
};

const Base = z.object({
  action: z.string(),
  label: z.string(),
  context: z.string().optional(),
});

// v2: each branch's payload is .strict() — no passthrough — so the wrapper rejects
// unknown keys at parse time, matching the sub-handler's strictness.
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("create") }).passthrough(),
  Base.extend({ action: z.literal("list") }).passthrough(),
  Base.extend({ action: z.literal("update") }).passthrough(),
  Base.extend({ action: z.literal("delete") }).passthrough(),
  Base.extend({ action: z.literal("bind_page_field") }).passthrough(),
]);

const DESCRIPTIONS = {
  create: `Use when: creating an in-page state variable to bind to props or page fields. Do NOT use when: needing HTTP data (use resources.create). Typical uses: site config like email/phone, page-local state. Returns: {dataSourceId} — pass to bind_page_field or instances.prop_update. Side effects: push to Webstudio Cloud. Example: {action:"create",label:"create-email",projectSlug:"my-site",scopeInstanceId:":root",name:"contactEmail",value:{type:"string",value:"contact@example.com"}}`,
  list: `Use when: listing a project's variables to discover dataSourceIds before update/delete/bind. Do NOT use when: needing HTTP resources (use resources.list). Variables are dataSources type="variable". Returns: array of {id, name, scopeInstanceId, value}. Side effects: none (read-only). Example: {action:"list",label:"audit-vars",projectSlug:"my-site"}`,
  update: `Use when: changing a variable's name and/or value, located by dataSourceId or name. Do NOT use when: changing an HTTP resource (use resources.update). Name match is case-sensitive; provide newName, value, or both. Typical: rotate a config value, flip a flag, rename. Returns: dry-run summary or push result. Side effects: push to Webstudio Cloud. dryRun defaults true. Example: {action:"update",label:"toggle-banner",projectSlug:"my-site",dataSourceId:"abc",value:{type:"boolean",value:false}}`,
  delete: `Use when: batch-deleting variables by id or name in one continue-on-error call. Do NOT use when: deleting an HTTP resource (use resources.delete). Pass dataSourceIdsOrNames as an array of ids and/or names. Returns: succeeded[]/failed[] report. Side effects: push to Webstudio Cloud, CRITICAL — context required, breaks every binding pointing to these variables. Example: {action:"delete",label:"purge-legacy",projectSlug:"my-site",dataSourceIdsOrNames:["v1","v2"],context:"Removing the 2 deprecated banner toggle variables now superseded by the new condition system across all pages of the site",dryRun:true}`,
  bind_page_field: `Use when: binding a page field to a variable or expression for dynamic per-page metadata. Do NOT use when: setting a literal value (use pages.update). Fields include title, meta.description, etc. Pass binding={kind:"variable"|"template"|"raw", ...}. Returns: patch summary. Side effects: push to Webstudio Cloud. Example: {action:"bind_page_field",label:"bind-title",projectSlug:"my-site",pageId:"pg1",field:"title",binding:{kind:"variable",dataSourceId:"abc"}}`,
};

// Strip mega-tool boilerplate (action/label/context) before dispatching to the
// atomic sub-handler — those fields are not part of the sub-handler's contract.
const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  create: async (i: Record<string, unknown>) => createVariableTool.handler(strip(i)),
  list: async (i: Record<string, unknown>) => listVariablesTool.handler(strip(i)),
  update: async (i: Record<string, unknown>) => updateVariableTool.handler(strip(i)),
  delete: async (i: Record<string, unknown>) => deleteVariablesBatchTool.handler(strip(i)),
  bind_page_field: async (i: Record<string, unknown>) => bindPageFieldTool.handler(strip(i)),
};

export const variablesTool: ToolModule = {
  definition: {
    name: "variables",
    description: `Mega-tool for in-page state variable lifecycle. 5 actions: create, list, update, delete, bind_page_field. Each action takes a unique \`label\` (3-30 chars) and an optional \`context\` (15-25 words, third-person — required for CRITICAL delete). Variables are dataSources type="variable", scoped to an instance (:root for site-global).`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "create", description: DESCRIPTIONS.create, zod: createVariableInputSchema },
      { action: "list", description: DESCRIPTIONS.list, zod: listVariablesInputSchema },
      { action: "update", description: DESCRIPTIONS.update, zod: updateVariableInputSchema },
      { action: "delete", description: DESCRIPTIONS.delete, zod: deleteVariablesBatchInputSchema },
      { action: "bind_page_field", description: DESCRIPTIONS.bind_page_field, zod: bindPageFieldInputSchema },
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

    logContext({ tool: "variables", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });

    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
