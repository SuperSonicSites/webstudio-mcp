// CMS adapter interface (workstream #11, v1.0 / v2.1 multi-source).
//
// Schema-agnostic CRUD + schema discovery on a CMS source. v2.1 ships 3 adapters:
//   - directus (single source, ~/.webstudio-mcp/cms/directus.json)
//   - wordpress (single or multi-site, ~/.webstudio-mcp/cms/wordpress.json)
//   - n8n      (single or multi-instance, ~/.webstudio-mcp/cms/n8n.json)
//
// The mega-tool `cms` selects via `source: "directus" | "wordpress[:name]" | "n8n[:name]"`.

export type FieldType =
  | "string" | "text" | "integer" | "float" | "boolean" | "json"
  | "uuid" | "datetime" | "date" | "file" | "alias" | "unknown";

export type FieldDef = {
  field: string;
  type: FieldType;
  required: boolean;
  description?: string;
};

export type CollectionDef = {
  collection: string;
  fields: FieldDef[];
};

export type CmsItem = Record<string, unknown> & { id?: string | number };

export type CmsAdapter = {
  /** Adapter name (e.g. "directus", "wordpress:crs"). */
  name: string;
  /** List the collections available in the source. */
  listCollections(): Promise<string[]>;
  /** Discover the schema (fields + types) of a specific collection. */
  discoverSchema(collection: string): Promise<CollectionDef>;
  /**
   * List items with optional filter + pagination. `fields` requests
   * server-side projection where the backend supports it (WordPress _fields,
   * Directus fields); adapters without support ignore it — the caller applies
   * client-side projection as a fallback either way.
   */
  listItems(collection: string, opts?: { filter?: Record<string, unknown>; limit?: number; offset?: number; fields?: string[] }): Promise<CmsItem[]>;
  /** Create an item. Returns the created item with id. */
  createItem(collection: string, data: CmsItem): Promise<CmsItem>;
  /** Update an item by id. Returns the updated item. */
  updateItem(collection: string, id: string | number, data: CmsItem): Promise<CmsItem>;
  /** Delete an item by id. */
  deleteItem(collection: string, id: string | number): Promise<void>;
  /** Build the HTTP URL Webstudio resource should fetch for this collection (used by bind_collection_to_instance). */
  resourceUrl(collection: string): string;
};

// Re-export adapter factories for back-compat with cms-mega.ts.
export { getDirectusAdapter } from "./cms-adapters/directus.js";
export { getWordPressAdapter } from "./cms-adapters/wordpress.js";
export { getN8nAdapter } from "./cms-adapters/n8n.js";

/**
 * Resolve an adapter from a source descriptor:
 *   - "directus"            → Directus (~/.webstudio-mcp/cms/directus.json)
 *   - "wordpress"           → WordPress (single-site config) OR first site of multi-config
 *   - "wordpress:crs"       → WordPress for the named site "crs"
 *   - "n8n"                 → n8n (single-instance)
 *   - "n8n:prod"            → n8n for the named instance "prod"
 */
export async function getAdapterBySource(source: string): Promise<CmsAdapter> {
  const idx = source.indexOf(":");
  const type = idx === -1 ? source : source.slice(0, idx);
  const name = idx === -1 ? undefined : source.slice(idx + 1);
  switch (type) {
    case "directus": {
      const { getDirectusAdapter } = await import("./cms-adapters/directus.js");
      return getDirectusAdapter();
    }
    case "wordpress": {
      const { getWordPressAdapter } = await import("./cms-adapters/wordpress.js");
      return getWordPressAdapter(name);
    }
    case "n8n": {
      const { getN8nAdapter } = await import("./cms-adapters/n8n.js");
      return getN8nAdapter(name);
    }
    default:
      throw new Error(`Unknown CMS source "${source}". Use: directus | wordpress[:name] | n8n[:name].`);
  }
}
