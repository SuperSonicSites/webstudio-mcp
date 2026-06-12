// Mega-tool `cms` — v2.0 (Directus adapter; more in v2.x).
//
// Schema-agnostic CMS adapter — v1.0 ships Directus only. Auth config in
// ~/.webstudio-mcp/cms/directus.json: { baseUrl: string, token: string }.
//
// Tier mapping:
//   - delete_item, bind_collection_to_instance → CRITICAL
//   - create_item, update_item                 → STRUCTURING
//   - list_collections, list_items, discover_schema → READ-ONLY

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult, textResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { getAdapterBySource, type CmsAdapter, type CollectionDef } from "../lib/cms-adapter.js";
import { createResourceTool } from "./resources.js";

const TIER: Record<string, Tier> = {
  list_collections: "READ-ONLY",
  discover_schema: "READ-ONLY",
  list_items: "READ-ONLY",
  create_item: "STRUCTURING",
  update_item: "STRUCTURING",
  delete_item: "CRITICAL",
  bind_collection_to_instance: "CRITICAL",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("list_collections") }).passthrough(),
  Base.extend({ action: z.literal("discover_schema") }).passthrough(),
  Base.extend({ action: z.literal("list_items") }).passthrough(),
  Base.extend({ action: z.literal("create_item") }).passthrough(),
  Base.extend({ action: z.literal("update_item") }).passthrough(),
  Base.extend({ action: z.literal("delete_item") }).passthrough(),
  Base.extend({ action: z.literal("bind_collection_to_instance") }).passthrough(),
]);

// v2.1: every action accepts an optional `source` to select the CMS adapter.
// Defaults to "directus" for back-compat. Accepts named sources for multi-site:
//   "directus" | "wordpress" | "wordpress:crs" | "n8n" | "n8n:prod"
const sourceField = z.string().optional().describe(
  'CMS source selector — default "directus". Use "wordpress[:name]" or "n8n[:name]" for the other adapters (see ~/.webstudio-mcp/cms/<adapter>.json).',
);

// Per-action Zod schemas declared inline (no atomic files — this mega-tool is self-contained).
const listCollectionsInputSchema = z.object({ source: sourceField }).strict();
const discoverSchemaInputSchema = z.object({ source: sourceField, collection: z.string() }).strict();
const listItemsInputSchema = z.object({
  source: sourceField,
  collection: z.string(),
  filter: z.record(z.string(), z.unknown()).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
}).strict();
const createItemInputSchema = z.object({
  source: sourceField,
  collection: z.string(),
  data: z.record(z.string(), z.unknown()),
}).strict();
const updateItemInputSchema = z.object({
  source: sourceField,
  collection: z.string(),
  itemId: z.string(),
  data: z.record(z.string(), z.unknown()),
}).strict();
const deleteItemInputSchema = z.object({
  source: sourceField,
  collection: z.string(),
  itemId: z.string(),
  dryRun: z.boolean().default(true),
}).strict();
const bindCollectionToInstanceInputSchema = z.object({
  source: sourceField,
  projectSlug: z.string(),
  collection: z.string(),
  scopeInstanceId: z.string(),
  dryRun: z.boolean().default(true),
}).strict();

const D = {
  list_collections: `Use when: listing collection names available in the configured CMS source. Do NOT use when: you know the collection name (use discover_schema). Returns: array of collection names. Side effects: read network. Pass \`source\` to pick the adapter ("directus" default | "wordpress[:name]" | "n8n[:name]"). Example: {action:"list_collections",label:"audit",source:"wordpress:crs"}`,
  discover_schema: `Use when: discovering a collection's fields and types before mapping to Webstudio props. Do NOT use when: needing field VALUES (use list_items). WordPress: collection = rest_base ("posts","pages","motos"). n8n: collection = workflow name. Returns: {collection, fields:[{field, type, required}]}. Side effects: read network. Example: {action:"discover_schema",label:"schema-motos",source:"directus",collection:"products"}`,
  list_items: `Use when: listing items from a CMS collection with filter and pagination. Do NOT use when: just wanting the schema (use discover_schema). Filter syntax depends on adapter (Directus: Directus query language ; WordPress: REST query params like {status:"publish", search:"moto"} ; n8n: {status:"success"}). Returns: array of items. Side effects: read network. Example: {action:"list_items",label:"list-motos",source:"directus",collection:"products",limit:10}`,
  create_item: `Use when: insert a new item in the CMS collection (Directus/WordPress) OR trigger a workflow webhook (n8n). Do NOT use when: pushing a Webstudio fragment (use build.push_fragment). Returns: created item with id, or webhook response (n8n). Side effects: network mutation on the CMS source. Example: {action:"create_item",label:"add-post",source:"wordpress:crs",collection:"posts",data:{title:"Hello",content:"<p>Body</p>",status:"publish"}}`,
  update_item: `Use when: modifying an existing CMS item's fields. Do NOT use when: changing the binding (use bind_collection_to_instance). n8n: NOT SUPPORTED (executions are immutable — call create_item again to start a new run). Returns: updated item. Side effects: network mutation. Example: {action:"update_item",label:"upd-price",source:"directus",collection:"products",itemId:"abc",data:{price:5500}}`,
  delete_item: `Use when: removing an item from a CMS collection by id. Do NOT use when: just unbinding the instance (delete the binding instead). Returns: confirmation. Side effects: network mutation, CRITICAL — context required, irreversible. dryRun defaults true. WordPress uses force-delete (bypass trash). n8n: deletes an execution by id. Example: {action:"delete_item",label:"drop-moto",source:"directus",collection:"products",itemId:"abc",context:"Removing the discontinued 2024 model after the rebrand cleanup operation requested by the dealer last week",dryRun:false}`,
  bind_collection_to_instance: `Use when: binding a CMS collection to a Webstudio instance so it renders one item per row. Do NOT use when: binding a single field (use variables.bind_page_field or instances.prop_update). Returns: created resourceId + dataSourceId + binding summary. Side effects: push to Webstudio Cloud, CRITICAL — context required, structural change. Creates an HTTP Resource pointing at the collection endpoint plus a ws:collection variable on the instance. The resource URL is adapter-specific (Directus: /items/<col>, WordPress: /wp-json/wp/v2/<col>, n8n: webhook URL). Example: {action:"bind_collection_to_instance",label:"bind-motos-grid",source:"directus",projectSlug:"my-site",collection:"products",scopeInstanceId:"abc",context:"Binding the motos collection to the dealer catalog grid so each row renders one moto from the cms.example.com Directus source",dryRun:true}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

/** Extract the `source` descriptor from a stripped action input (defaults to "directus"). */
const resolveSource = (args: Record<string, unknown>): string =>
  typeof args.source === "string" && args.source.trim() ? args.source.trim() : "directus";

const HANDLERS = {
  list_collections: async (input: Record<string, unknown>) => {
    const source = resolveSource(strip(input));
    let adapter: CmsAdapter;
    try { adapter = await getAdapterBySource(source); }
    catch (err) { return errorResult("AUTH_MISSING", (err as Error).message); }
    try {
      const collections = await adapter.listCollections();
      return textResult(`Collections (${collections.length}):\n${collections.map((c) => `- ${c}`).join("\n")}`);
    } catch (err) {
      return errorResult("INTERNAL_ERROR", `listCollections failed: ${(err as Error).message}`);
    }
  },
  discover_schema: async (input: Record<string, unknown>) => {
    const args = strip(input);
    const source = resolveSource(args);
    const collection = String(args.collection);
    let adapter: CmsAdapter;
    try { adapter = await getAdapterBySource(source); }
    catch (err) { return errorResult("AUTH_MISSING", (err as Error).message); }
    try {
      const schema: CollectionDef = await adapter.discoverSchema(collection);
      const lines = [`Collection "${schema.collection}" — ${schema.fields.length} field(s):`];
      for (const f of schema.fields) {
        const req = f.required ? " (required)" : "";
        const note = f.description ? ` — ${f.description}` : "";
        lines.push(`  - ${f.field}: ${f.type}${req}${note}`);
      }
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult("INTERNAL_ERROR", `discoverSchema failed: ${(err as Error).message}`);
    }
  },
  list_items: async (input: Record<string, unknown>) => {
    const args = strip(input);
    const source = resolveSource(args);
    const collection = String(args.collection);
    const limit = typeof args.limit === "number" ? args.limit : 25;
    const offset = typeof args.offset === "number" ? args.offset : 0;
    const filter = (args.filter as Record<string, unknown> | undefined);
    let adapter: CmsAdapter;
    try { adapter = await getAdapterBySource(source); }
    catch (err) { return errorResult("AUTH_MISSING", (err as Error).message); }
    try {
      const items = await adapter.listItems(collection, { limit, offset, filter });
      return textResult(`Items in "${collection}" (${items.length}):\n${JSON.stringify(items, null, 2)}`);
    } catch (err) {
      return errorResult("INTERNAL_ERROR", `listItems failed: ${(err as Error).message}`);
    }
  },
  create_item: async (input: Record<string, unknown>) => {
    const args = strip(input);
    const source = resolveSource(args);
    const collection = String(args.collection);
    const data = (args.data as Record<string, unknown>) ?? {};
    let adapter: CmsAdapter;
    try { adapter = await getAdapterBySource(source); }
    catch (err) { return errorResult("AUTH_MISSING", (err as Error).message); }
    try {
      const created = await adapter.createItem(collection, data);
      return textResult(`Created in "${collection}":\n${JSON.stringify(created, null, 2)}`);
    } catch (err) {
      return errorResult("INTERNAL_ERROR", `createItem failed: ${(err as Error).message}`);
    }
  },
  update_item: async (input: Record<string, unknown>) => {
    const args = strip(input);
    const source = resolveSource(args);
    const collection = String(args.collection);
    const itemId = String(args.itemId);
    const data = (args.data as Record<string, unknown>) ?? {};
    let adapter: CmsAdapter;
    try { adapter = await getAdapterBySource(source); }
    catch (err) { return errorResult("AUTH_MISSING", (err as Error).message); }
    try {
      const updated = await adapter.updateItem(collection, itemId, data);
      return textResult(`Updated "${collection}/${itemId}":\n${JSON.stringify(updated, null, 2)}`);
    } catch (err) {
      return errorResult("INTERNAL_ERROR", `updateItem failed: ${(err as Error).message}`);
    }
  },
  delete_item: async (input: Record<string, unknown>) => {
    const args = strip(input);
    const source = resolveSource(args);
    const collection = String(args.collection);
    const itemId = String(args.itemId);
    const dryRun = args.dryRun !== false;
    if (dryRun) {
      return textResult(`DRY-RUN delete_item — would remove "${collection}/${itemId}" via ${source}. Re-run with dryRun=false to commit.`);
    }
    let adapter: CmsAdapter;
    try { adapter = await getAdapterBySource(source); }
    catch (err) { return errorResult("AUTH_MISSING", (err as Error).message); }
    try {
      await adapter.deleteItem(collection, itemId);
      return textResult(`Deleted "${collection}/${itemId}".`);
    } catch (err) {
      return errorResult("INTERNAL_ERROR", `deleteItem failed: ${(err as Error).message}`);
    }
  },
  bind_collection_to_instance: async (input: Record<string, unknown>) => {
    const args = strip(input);
    const source = resolveSource(args);
    const projectSlug = String(args.projectSlug);
    const collection = String(args.collection);
    const scopeInstanceId = String(args.scopeInstanceId);
    const dryRun = args.dryRun !== false;
    let adapter: CmsAdapter;
    try { adapter = await getAdapterBySource(source); }
    catch (err) { return errorResult("AUTH_MISSING", (err as Error).message); }
    let schema: CollectionDef;
    try { schema = await adapter.discoverSchema(collection); }
    catch (err) { return errorResult("INTERNAL_ERROR", `schema discovery failed: ${(err as Error).message}`); }
    const resourceUrl = adapter.resourceUrl(collection);

    if (dryRun) {
      return textResult(
        `DRY-RUN bind_collection_to_instance\n` +
        `  projectSlug: ${projectSlug}\n` +
        `  collection: ${collection} (${schema.fields.length} fields)\n` +
        `  scopeInstanceId: ${scopeInstanceId}\n` +
        `  resourceUrl: ${resourceUrl}\n` +
        `  Plan: 1) create Webstudio Resource pointing at the URL. 2) create a ws:collection variable scoped to the instance. 3) configure the instance's children to iterate via the 'item' parameter.\n\n` +
        `Re-run with dryRun=false to commit the binding.`,
      );
    }

    // Source-specific Webstudio Resource headers placeholder. Caller substitutes
    // the real credentials in Webstudio before publishing.
    const headers = (() => {
      if (source.startsWith("directus")) return [{ name: "Authorization", value: "Bearer <DIRECTUS_TOKEN>" }];
      if (source.startsWith("wordpress")) return [{ name: "Authorization", value: "Basic <WP_APP_PASSWORD_BASE64>" }];
      if (source.startsWith("n8n")) return []; // n8n webhooks are typically public; add header in WS if auth needed.
      return [];
    })();
    const headerNote = headers.length > 0
      ? `Note: the credential header is a placeholder — substitute with your real value in the Webstudio resource header before publishing.\n\n`
      : `Note: no auth header set (typical for public endpoints). Add one in the Webstudio resource header if your source requires authentication.\n\n`;

    const resourceRes = await createResourceTool.handler({
      projectSlug,
      scopeInstanceId,
      name: `cms_${collection}`,
      url: resourceUrl,
      method: "get",
      headers,
      dryRun: false,
    });
    return {
      content: [
        { type: "text" as const, text:
          `Bound collection "${collection}" → instance ${scopeInstanceId} via ${source} (resource created).\n\n` +
          headerNote +
          `Schema discovered: ${schema.fields.length} field(s) — ${schema.fields.slice(0, 5).map((f) => f.field).join(", ")}${schema.fields.length > 5 ? ", ..." : ""}` },
        ...resourceRes.content,
      ],
    };
  },
};

export const cmsTool: ToolModule = {
  definition: {
    name: "cms",
    description: `Mega-tool for CMS integration. 7 actions: list_collections, discover_schema, list_items, create_item, update_item, delete_item (CRITICAL), bind_collection_to_instance (CRITICAL — killer feature: creates Resource + ws:collection scaffold in 1 call). v2.1 supports 3 adapters via the \`source\` param:
  - "directus" (default) — Directus REST. Config: ~/.webstudio-mcp/cms/directus.json {baseUrl, token}.
  - "wordpress" or "wordpress:<site>" — WordPress REST + Application Passwords. Config: ~/.webstudio-mcp/cms/wordpress.json (single-site OR multi-site {sites:{...}}).
  - "n8n" or "n8n:<instance>" — n8n workflows (collection = workflow name, item = execution). Config: ~/.webstudio-mcp/cms/n8n.json (single OR multi {instances:{...}}). update_item not supported (executions are immutable).`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "list_collections", description: D.list_collections, zod: listCollectionsInputSchema },
      { action: "discover_schema", description: D.discover_schema, zod: discoverSchemaInputSchema },
      { action: "list_items", description: D.list_items, zod: listItemsInputSchema },
      { action: "create_item", description: D.create_item, zod: createItemInputSchema },
      { action: "update_item", description: D.update_item, zod: updateItemInputSchema },
      { action: "delete_item", description: D.delete_item, zod: deleteItemInputSchema },
      { action: "bind_collection_to_instance", description: D.bind_collection_to_instance, zod: bindCollectionToInstanceInputSchema },
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
    logContext({ tool: "cms", action: input.action, tier, context: input.context });
    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
