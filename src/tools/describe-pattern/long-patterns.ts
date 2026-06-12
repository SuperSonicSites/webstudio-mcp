// Long-form pattern docs shipped as Markdown under /docs/patterns/.
//
// These are the deep recipes that don't fit the HELPER_DOCS schema (which is for ~1-screen helper
// reference cards). Use this for full reverse-engineered patterns with architecture diagrams,
// critical pitfalls, CSS var notes, and verified examples (e.g. mega-menu Radix structure).
//
// Add a new pattern by dropping a .md file into /docs/patterns/. The slug = filename without .md.
// Frontmatter is optional — if present, the first H1 or `name:` field is used for the index display.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findPatternsDir } from "../../lib/patterns-dir.js";

export type LongPatternDoc = {
  slug: string;
  title: string;
  description: string; // first paragraph after frontmatter, truncated
  body: string; // full markdown
};

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.+)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

function extractTitle(meta: Record<string, string>, body: string, slug: string): string {
  if (meta.name) return meta.name;
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return slug;
}

function extractDescription(meta: Record<string, string>, body: string): string {
  if (meta.description) return meta.description;
  // first non-empty paragraph after the title
  const lines = body.split("\n");
  let inBody = false;
  const buf: string[] = [];
  for (const line of lines) {
    if (!inBody) {
      if (line.startsWith("#")) {
        inBody = true;
        continue;
      }
      continue;
    }
    if (!line.trim()) {
      if (buf.length) break;
      continue;
    }
    if (line.startsWith("#")) break;
    buf.push(line.trim());
  }
  const desc = buf.join(" ").replace(/\s+/g, " ");
  return desc.length > 200 ? desc.slice(0, 197) + "..." : desc;
}

function loadAll(): Record<string, LongPatternDoc> {
  const dir = findPatternsDir();
  if (!dir) return {};
  const out: Record<string, LongPatternDoc> = {};
  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith(".md")) continue;
    const slug = filename.replace(/\.md$/, "");
    // Normalize CRLF (Windows checkouts) so the LF-only frontmatter regex matches.
    const raw = readFileSync(join(dir, filename), "utf8").replace(/\r\n/g, "\n");
    const { meta, body } = parseFrontmatter(raw);
    out[slug] = {
      slug,
      title: extractTitle(meta, body, slug),
      description: extractDescription(meta, body),
      body,
    };
  }
  return out;
}

// Load once at import time (cheap — a few KB total).
export const LONG_PATTERN_DOCS: Record<string, LongPatternDoc> = loadAll();
