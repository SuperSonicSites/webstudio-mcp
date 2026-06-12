// WordPress REST adapter (v2.1).
//
// Config: ~/.webstudio-mcp/cms/wordpress.json
//
// Single-site format:
//   { baseUrl: "https://example.com", username: "...", appPassword: "xxxx xxxx xxxx xxxx" }
//
// Multi-site format:
//   {
//     "sites": {
//       "crs": { baseUrl, username, appPassword },
//       "dealer-1": { ... }
//     }
//   }
//
// Auth: WordPress Application Passwords (Basic Auth). Generate one per site in
// wp-admin → Users → Profile → Application Passwords.
//
// "Collections" map to WP post types (posts, pages, custom post types).
// REST endpoints follow the standard /wp-json/wp/v2/<plural> convention.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CmsAdapter, CmsItem, CollectionDef, FieldDef, FieldType } from "../cms-adapter.js";

type WordPressSite = {
  baseUrl: string;
  username: string;
  appPassword: string;
};

type WordPressConfigSingle = WordPressSite;
type WordPressConfigMulti = { sites: Record<string, WordPressSite> };
type WordPressConfig = WordPressConfigSingle | WordPressConfigMulti;

async function loadWordPressConfig(): Promise<WordPressConfig | null> {
  const path = join(homedir(), ".webstudio-mcp", "cms", "wordpress.json");
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as WordPressConfig;
  } catch {
    return null;
  }
}

function isSingleConfig(cfg: WordPressConfig): cfg is WordPressConfigSingle {
  return typeof (cfg as WordPressConfigSingle).baseUrl === "string";
}

function pickSite(cfg: WordPressConfig, name?: string): { site: WordPressSite; siteName: string } {
  if (isSingleConfig(cfg)) {
    if (name) {
      throw new Error(
        `wordpress.json is in single-site format but source "wordpress:${name}" requested a named site. Either drop the name or migrate the config to the multi-site format.`,
      );
    }
    return { site: cfg, siteName: "default" };
  }
  // Multi-site format.
  const entries = Object.entries(cfg.sites);
  if (entries.length === 0) {
    throw new Error("wordpress.json multi-site config has empty `sites` object.");
  }
  if (!name) {
    // No name provided — refuse if multiple sites (caller must disambiguate),
    // accept if exactly one (the user probably means "the only one").
    if (entries.length > 1) {
      const list = entries.map(([n]) => `"wordpress:${n}"`).join(", ");
      throw new Error(`wordpress.json defines multiple sites — pass a named source (one of ${list}).`);
    }
    const [siteName, site] = entries[0];
    return { site, siteName };
  }
  const site = cfg.sites[name];
  if (!site) {
    const available = entries.map(([n]) => n).join(", ");
    throw new Error(`wordpress.json has no site named "${name}". Available: ${available}.`);
  }
  return { site, siteName: name };
}

// WP REST returns fields with various shapes. We focus on the common content fields.
// `description` of returned shape comes from /wp-json/wp/v2/types/<type> when available.
const WP_TYPE_MAP: Record<string, FieldType> = {
  string: "string",
  integer: "integer",
  number: "float",
  boolean: "boolean",
  object: "json",
  array: "json",
};

class WordPressAdapterImpl implements CmsAdapter {
  public name: string;
  constructor(private site: WordPressSite, siteName: string) {
    this.name = siteName === "default" ? "wordpress" : `wordpress:${siteName}`;
  }

  private authHeader(): string {
    const credentials = Buffer.from(`${this.site.username}:${this.site.appPassword}`).toString("base64");
    return `Basic ${credentials}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.site.baseUrl.replace(/\/$/, "")}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: this.authHeader(),
        "content-type": "application/json",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (!res.ok) {
      const errText = await res.text().catch(() => "(no body)");
      throw new Error(`WordPress ${method} ${path} → HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * List collections = post types. We filter out internal types (attachment, nav_menu_item,
   * wp_block, etc.) and surface only those that are typically content-bearing.
   */
  async listCollections(): Promise<string[]> {
    const data = await this.request<Record<string, { name: string; slug: string; rest_base?: string }>>(
      "GET",
      "/wp-json/wp/v2/types",
    );
    const internal = new Set(["attachment", "nav_menu_item", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles"]);
    return Object.entries(data)
      .filter(([slug]) => !internal.has(slug))
      .map(([, type]) => type.rest_base ?? type.slug);
  }

  /**
   * Discover schema by hitting /wp-json/wp/v2/types/<post_type>. Returns the schema
   * for the standard WP fields (title, content, excerpt, status, etc.) plus any
   * registered meta/custom fields when WP exposes them.
   */
  async discoverSchema(collection: string): Promise<CollectionDef> {
    // The endpoint takes the singular post_type slug, but our `collection` is rest_base
    // (the plural). Try the plural first; if it 404s, fall back to a best-effort guess.
    let typeData: { schema?: { properties?: Record<string, { type?: string | string[]; description?: string; required?: boolean }> } };
    try {
      typeData = await this.request("GET", `/wp-json/wp/v2/${collection}?context=edit&per_page=1`);
    } catch {
      typeData = {};
    }
    // /wp-json/wp/v2/types/<post_type> gives the schema authoritatively, but `collection`
    // here is `rest_base`. Try a reverse lookup via /types.
    let schemaProps: Record<string, { type?: string | string[]; description?: string; required?: boolean }> | undefined;
    try {
      const types = await this.request<Record<string, { rest_base?: string; slug: string }>>(
        "GET",
        "/wp-json/wp/v2/types",
      );
      const match = Object.values(types).find((t) => (t.rest_base ?? t.slug) === collection);
      if (match) {
        const detail = await this.request<{ schema?: { properties?: typeof schemaProps } }>(
          "GET",
          `/wp-json/wp/v2/types/${match.slug}`,
        );
        schemaProps = detail.schema?.properties;
      }
    } catch {
      // Schema unavailable — fall through to empty fields.
    }
    schemaProps ??= typeData.schema?.properties;

    const fields: FieldDef[] = [];
    if (schemaProps) {
      for (const [field, def] of Object.entries(schemaProps)) {
        const typeStr = Array.isArray(def.type) ? def.type[0] : def.type;
        fields.push({
          field,
          type: typeStr ? WP_TYPE_MAP[typeStr] ?? "unknown" : "unknown",
          required: Boolean(def.required),
          ...(def.description ? { description: def.description } : {}),
        });
      }
    }
    return { collection, fields };
  }

  async listItems(collection: string, opts: { filter?: Record<string, unknown>; limit?: number; offset?: number; fields?: string[] } = {}): Promise<CmsItem[]> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("per_page", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    // Server-side projection — content.rendered alone can be 100 kB per post.
    if (opts.fields?.length) params.set("_fields", opts.fields.join(","));
    if (opts.filter) {
      // WP REST accepts filters as flat query params (search, slug, status, categories…).
      // We forward the keys verbatim; user is responsible for using WP-supported filters.
      for (const [k, v] of Object.entries(opts.filter)) {
        if (v === null || v === undefined) continue;
        params.set(k, String(v));
      }
    }
    const qs = params.toString();
    const data = await this.request<CmsItem[]>("GET", `/wp-json/wp/v2/${collection}${qs ? `?${qs}` : ""}`);
    return data;
  }

  async createItem(collection: string, item: CmsItem): Promise<CmsItem> {
    return this.request<CmsItem>("POST", `/wp-json/wp/v2/${collection}`, item);
  }

  async updateItem(collection: string, id: string | number, item: CmsItem): Promise<CmsItem> {
    return this.request<CmsItem>("POST", `/wp-json/wp/v2/${collection}/${id}`, item);
  }

  async deleteItem(collection: string, id: string | number): Promise<void> {
    // WP REST requires ?force=true to bypass the trash. We do force-delete to match
    // the symmetric behaviour of the Directus adapter.
    await this.request<void>("DELETE", `/wp-json/wp/v2/${collection}/${id}?force=true`);
  }

  resourceUrl(collection: string): string {
    return `${this.site.baseUrl.replace(/\/$/, "")}/wp-json/wp/v2/${collection}`;
  }
}

export async function getWordPressAdapter(siteName?: string): Promise<CmsAdapter> {
  const cfg = await loadWordPressConfig();
  if (!cfg) {
    throw new Error(
      'WordPress config missing — create ~/.webstudio-mcp/cms/wordpress.json with either ' +
        '{ baseUrl, username, appPassword } (single-site) or { sites: { "<name>": { baseUrl, username, appPassword } } } (multi-site).',
    );
  }
  const { site, siteName: resolved } = pickSite(cfg, siteName);
  return new WordPressAdapterImpl(site, resolved);
}
