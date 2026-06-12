// Directus CMS adapter (extracted from cms-adapter.ts in v2.1).
//
// Config: ~/.webstudio-mcp/cms/directus.json
//   { baseUrl: string, token: string }
//
// Currently single-source — Directus is typically self-hosted per organisation
// (e.g. cms.example.com). Multi-source can be added later if needed.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CmsAdapter, CmsItem, CollectionDef, FieldDef, FieldType } from "../cms-adapter.js";

const DIRECTUS_TYPE_MAP: Record<string, FieldType> = {
  string: "string",
  text: "text",
  integer: "integer",
  bigInteger: "integer",
  float: "float",
  decimal: "float",
  boolean: "boolean",
  json: "json",
  uuid: "uuid",
  dateTime: "datetime",
  date: "date",
  file: "file",
  alias: "alias",
};

type DirectusConfig = { baseUrl: string; token: string };

async function loadDirectusConfig(): Promise<DirectusConfig | null> {
  const path = join(homedir(), ".webstudio-mcp", "cms", "directus.json");
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as DirectusConfig;
    if (!parsed.baseUrl || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

class DirectusAdapterImpl implements CmsAdapter {
  name = "directus";
  constructor(private cfg: DirectusConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        "content-type": "application/json",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`Directus ${method} ${path} → HTTP ${res.status}: ${await res.text().catch(() => "(no body)")}`);
    if (res.status === 204) return undefined as T;
    const data = await res.json();
    return data as T;
  }

  async listCollections(): Promise<string[]> {
    const data = await this.request<{ data: Array<{ collection: string }> }>("GET", "/collections");
    return data.data.map((c) => c.collection).filter((c) => !c.startsWith("directus_"));
  }

  async discoverSchema(collection: string): Promise<CollectionDef> {
    const data = await this.request<{ data: Array<{ field: string; type: string; meta?: { required?: boolean; note?: string } }> }>(
      "GET",
      `/fields/${collection}`,
    );
    const fields: FieldDef[] = data.data.map((f) => ({
      field: f.field,
      type: DIRECTUS_TYPE_MAP[f.type] ?? "unknown",
      required: Boolean(f.meta?.required),
      ...(f.meta?.note ? { description: f.meta.note } : {}),
    }));
    return { collection, fields };
  }

  async listItems(collection: string, opts: { filter?: Record<string, unknown>; limit?: number; offset?: number; fields?: string[] } = {}): Promise<CmsItem[]> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts.fields?.length) params.set("fields", opts.fields.join(","));
    if (opts.filter) params.set("filter", JSON.stringify(opts.filter));
    const qs = params.toString();
    const data = await this.request<{ data: CmsItem[] }>("GET", `/items/${collection}${qs ? `?${qs}` : ""}`);
    return data.data;
  }

  async createItem(collection: string, item: CmsItem): Promise<CmsItem> {
    const data = await this.request<{ data: CmsItem }>("POST", `/items/${collection}`, item);
    return data.data;
  }

  async updateItem(collection: string, id: string | number, item: CmsItem): Promise<CmsItem> {
    const data = await this.request<{ data: CmsItem }>("PATCH", `/items/${collection}/${id}`, item);
    return data.data;
  }

  async deleteItem(collection: string, id: string | number): Promise<void> {
    await this.request<void>("DELETE", `/items/${collection}/${id}`);
  }

  resourceUrl(collection: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, "")}/items/${collection}`;
  }
}

export async function getDirectusAdapter(): Promise<CmsAdapter> {
  const cfg = await loadDirectusConfig();
  if (!cfg) throw new Error("Directus config missing — create ~/.webstudio-mcp/cms/directus.json with { baseUrl, token }.");
  return new DirectusAdapterImpl(cfg);
}
