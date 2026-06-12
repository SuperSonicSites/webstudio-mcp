// Mega-tool `resources` — v2.0. SSR HTTP resource lifecycle.
//
// Tier mapping:
//   - delete           → CRITICAL  (breaks bindings — context required)
//   - create           → STRUCTURING
//   - update           → TACTICAL
//   - list             → READ-ONLY

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { createResourceTool, deleteResourceTool } from "./resources.js";
import { createResourceInputSchema } from "./resources/create.js";
import { listResourcesTool, listResourcesInputSchema } from "./resources/list.js";
import { deleteResourceInputSchema } from "./resources/delete.js";
import { updateResourceTool, updateResourceInputSchema } from "./update-resource.js";

const TIER: Record<string, Tier> = {
  create: "STRUCTURING",
  list: "READ-ONLY",
  update: "TACTICAL",
  delete: "CRITICAL",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("create") }).passthrough(),
  Base.extend({ action: z.literal("list") }).passthrough(),
  Base.extend({ action: z.literal("update") }).passthrough(),
  Base.extend({ action: z.literal("delete") }).passthrough(),
]);

const DESCRIPTIONS = {
  create: `Use when: create an SSR resource — GET data fetch with dataSource, or standalone Form POST action. Do NOT use when: creating in-page state (use variables.create). Returns: {resourceId, dataSourceId?}. Side effects: push. Form actions are created ALONE (no dataSource) and bind via the Form's action prop. searchParams + headers each support mode:"literal" (JSON-encoded) or mode:"expression" (raw Webstudio expr, e.g. $ws$dataSource$<varId> for dynamic auth headers). Method-aware defaults (v2.20.0): a dataSource is fetched on EVERY render of its scope, so POST/PUT/DELETE default to NO dataSource + no cache header (cas réel: empty webhook POSTs fired on page render, 2026-06-10) — override via exposeAsDataSource/cacheMaxAge. Example (data): {action:"create",label:"create-api",projectSlug:"my-site",scopeInstanceId:":root",name:"motoData",url:"https://api.example.com/motos"}. Example (form action): {action:"create",label:"form-action",projectSlug:"my-site",name:"action",method:"post",url:"$ws$dataSource$<webhookVarId>",urlExpression:"$ws$dataSource$<webhookVarId>"} then instances.prop_update {name:"action",type:"resource",value:"<resourceId>"} on the Form. [PATTERN] form-action-resource.`,
  list: `Use when: list HTTP resources + their dataSources — discover ids before update/delete/bind. Do NOT use when: needing in-page variables (use variables.list). Returns: array of {id, name, method, url, dataSourceId, scopeInstanceId, searchParams[], headers[], body chars}. Side effects: none (read-only). Example: {action:"list",label:"audit-resources",projectSlug:"my-site"}`,
  update: `Use when: change an existing resource's URL/method/searchParams/headers/body. Do NOT use when: changing a variable's value (use variables.update). Returns: dry-run summary or push result. Side effects: push to Webstudio Cloud. dryRun defaults true. Each value supports mode:"literal" or "expression". searchParams/headers REPLACE the array entirely. Typical jobs: rebrand endpoint, rotate auth header, repoint backend. Example: {action:"update",label:"rotate-token",projectSlug:"my-site",resourceId:"abc",headers:[{name:"Authorization",value:"Bearer xyz",mode:"literal"}]}`,
  delete: `Use when: delete a resource + its linked dataSource. Refuses if referenced unless force=true. Do NOT use when: deleting a variable (use variables.delete). Returns: dry-run with references found or push result. Side effects: push to Webstudio Cloud, CRITICAL — context required, breaks bindings. Example: {action:"delete",label:"drop-old-api",projectSlug:"my-site",resourceId:"abc",context:"Removing the deprecated v1 API endpoint that has been migrated to the v2 production resource last week",dryRun:true}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  create: async (i: Record<string, unknown>) => createResourceTool.handler(strip(i)),
  list: async (i: Record<string, unknown>) => listResourcesTool.handler(strip(i)),
  update: async (i: Record<string, unknown>) => updateResourceTool.handler(strip(i)),
  delete: async (i: Record<string, unknown>) => deleteResourceTool.handler(strip(i)),
};

export const resourcesTool: ToolModule = {
  definition: {
    name: "resources",
    description: `Mega-tool for SSR HTTP resource lifecycle (REST endpoints + their dataSources). 4 actions: create, list, update, delete. Resources are server-rendered fetches whose response is bound to instance props. dryRun default true on every mutating action; CRITICAL delete also requires context.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "create", description: DESCRIPTIONS.create, zod: createResourceInputSchema },
      { action: "list", description: DESCRIPTIONS.list, zod: listResourcesInputSchema },
      { action: "update", description: DESCRIPTIONS.update, zod: updateResourceInputSchema },
      { action: "delete", description: DESCRIPTIONS.delete, zod: deleteResourceInputSchema },
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
    logContext({ tool: "resources", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });

    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
