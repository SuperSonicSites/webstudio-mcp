// MCP resources — exposes docs/patterns/ as readable resources at webstudio://patterns/<slug>.
//
// Why: pattern recipes (sheet-mobile-radix, swiper-carousel, video-component...) were
// only accessible via the webstudio_describe_pattern tool. With resources://, the LLM
// can cite them passively without a tool call — same approach as Notion v2 / Linear MCPs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PatternResource = {
  slug: string;
  uri: string;
  name: string;
  description: string;
  category?: string;
  complexity?: string;
  /** Recommended high-level Webstudio MCP tool/action for this pattern (e.g. "build.create_navigation_menu"). */
  recommendedTool?: string;
  /** Short note explaining why the tool is recommended (shown in meta.guide output). */
  recommendedToolNote?: string;
  mimeType: string;
  path: string;
};

function findPatternsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../docs/patterns"),     // dist/resources.js → repo root
    resolve(here, "../../docs/patterns"),  // src/resources.ts via ts-node
    resolve(process.cwd(), "docs/patterns"),
  ];
  for (const p of candidates) {
    try {
      if (statSync(p).isDirectory()) return p;
    } catch { /* skip */ }
  }
  return null;
}

function extractFrontmatter(body: string): {
  name?: string;
  description?: string;
  category?: string;
  complexity?: string;
  recommendedTool?: string;
  recommendedToolNote?: string;
  rest: string;
} {
  const fm = body.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) return { rest: body };
  const meta: Record<string, string> = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return {
    name: meta.name,
    description: meta.description,
    category: meta.category,
    complexity: meta.complexity,
    recommendedTool: meta.recommendedTool,
    recommendedToolNote: meta.recommendedToolNote,
    rest: fm[2],
  };
}

let cache: PatternResource[] | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 30_000;

export function listPatternResources(): PatternResource[] {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const dir = findPatternsDir();
  if (!dir) {
    cache = [];
    cacheAt = now;
    return cache;
  }

  const out: PatternResource[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const slug = entry.replace(/\.md$/, "");
    const path = join(dir, entry);
    let body = "";
    // Normalize CRLF: Windows checkouts (git autocrlf) would otherwise defeat
    // the LF-only frontmatter regex and ship 200-char fallback descriptions.
    try { body = readFileSync(path, "utf8").replace(/\r\n/g, "\n"); } catch { continue; }
    const { name, description, category, complexity, recommendedTool, recommendedToolNote, rest } = extractFrontmatter(body);
    // Fallback: first heading or filename
    const firstHeading = rest.match(/^#\s+(.+)$/m)?.[1];
    out.push({
      slug,
      uri: `webstudio://patterns/${slug}`,
      name: name ?? firstHeading ?? slug,
      description: description ?? rest.split("\n").find((l) => l.trim().length > 0)?.slice(0, 200) ?? "",
      category,
      complexity,
      recommendedTool,
      recommendedToolNote,
      mimeType: "text/markdown",
      path,
    });
  }

  cache = out.sort((a, b) => a.slug.localeCompare(b.slug));
  cacheAt = now;
  return cache;
}

export function readPatternResource(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } | null {
  if (!uri.startsWith("webstudio://patterns/")) return null;
  const slug = uri.slice("webstudio://patterns/".length);
  if (!slug.match(/^[a-z][a-z0-9-]+$/)) return null;
  const resources = listPatternResources();
  const res = resources.find((r) => r.slug === slug);
  if (!res) return null;
  const text = readFileSync(res.path, "utf8").replace(/\r\n/g, "\n");
  return {
    contents: [{
      uri: res.uri,
      mimeType: res.mimeType,
      text,
    }],
  };
}
