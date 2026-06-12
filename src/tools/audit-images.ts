// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"images").
//
// As of v0.3.0 this file is NOT exposed as a standalone tool in the MCP manifest.
// It remains as a handler delegated to by src/tools/audit.ts. Editing this file:
//   - The `description` field is irrelevant (the dispatcher's description wins).
//   - The `handler` is what runs when `audit({kind:"images", ...})` is called.
//   - The Zod `Schema` still validates the dispatched args.
// To expose this back as a standalone tool: add `webstudio_<name>` to TOOLS in
// src/index.ts and add an entry in src/tools/index-tool-categories.ts.
// ─────────────────────────────────────────────────────────────────────────────
// Tool: webstudio_audit_images — project-wide image performance audit.
//
// Detects performance/CLS issues per Webstudio best-practices:
//   - <Image> instances missing `loading` attr.
//   - Hero images (depth <= heroDepth) without loading="eager" → LCP regression.
//   - Below-fold images without loading="lazy" → wasted bandwidth.
//   - Raw <img> inside HtmlEmbed / ContentEmbed (no auto WebP/AVIF/responsive sizes).
//   - Raw <img> without width/height → CLS risk.
//
// Read-only. Reports per page.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";
import type { Instance, Prop } from "../types.js";

export const auditImagesInputSchema = z.object({
  projectSlug: z.string(),
  verbose: z.boolean().default(false),
  heroDepth: z.number().int().min(0).default(3),
}).strict();

/** Components that can hold raw HTML (regex-scanned for <img>). */
const EMBED_COMPONENTS = new Set(["HtmlEmbed", "ContentEmbed"]);

type ImageRecord = {
  instanceId: string;
  label?: string;
  depth: number;
  loading?: string;
  hasAlt: boolean;
  hasWidth: boolean;
  hasHeight: boolean;
};

type RawImgRecord = {
  instanceId: string;
  component: string;
  label?: string;
  src: string;
  loading?: string;
  hasWidth: boolean;
  hasHeight: boolean;
  snippet: string;
};

type PageAudit = {
  pagePath: string;
  pageName: string;
  images: ImageRecord[];
  rawImgs: RawImgRecord[];
};

/** Walk the instance tree from a root, calling visit(id, depth). */
function walkInstances(
  build: WebstudioBuild,
  rootId: string,
  visit: (inst: Instance, depth: number) => void,
): void {
  const byId = new Map(build.instances.map((i) => [i.id, i]));
  const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const inst = byId.get(id);
    if (!inst) continue;
    visit(inst, depth);
    for (const c of inst.children) {
      if (c.type === "id") stack.push({ id: c.value, depth: depth + 1 });
    }
  }
}

/** Index props by instanceId → name → prop. */
function indexProps(build: WebstudioBuild): Map<string, Map<string, Prop>> {
  const index = new Map<string, Map<string, Prop>>();
  for (const p of build.props) {
    let slot = index.get(p.instanceId);
    if (!slot) { slot = new Map(); index.set(p.instanceId, slot); }
    slot.set(p.name, p);
  }
  return index;
}

function readStringProp(props: Map<string, Prop> | undefined, name: string): string | undefined {
  const p = props?.get(name);
  if (!p) return undefined;
  if (typeof p.value === "string") return p.value;
  if (typeof p.value === "number") return String(p.value);
  return undefined;
}

/** Extract attribute value from a single <img ...> tag substring. */
function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

/** Scan raw HTML code for <img> tags and return one record per match. */
function scanRawImgs(code: string, instanceId: string, component: string, label?: string): RawImgRecord[] {
  const out: RawImgRecord[] = [];
  const re = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const tag = m[0];
    out.push({
      instanceId,
      component,
      label,
      src: attr(tag, "src") ?? "(no src)",
      loading: attr(tag, "loading"),
      hasWidth: attr(tag, "width") !== undefined,
      hasHeight: attr(tag, "height") !== undefined,
      snippet: tag.length > 120 ? tag.slice(0, 117) + "..." : tag,
    });
  }
  return out;
}

function auditPage(build: WebstudioBuild, page: WebstudioBuild["pages"]["pages"][number], propsIdx: Map<string, Map<string, Prop>>): PageAudit {
  const images: ImageRecord[] = [];
  const rawImgs: RawImgRecord[] = [];
  walkInstances(build, page.rootInstanceId, (inst, depth) => {
    if (inst.component === "Image") {
      const ps = propsIdx.get(inst.id);
      images.push({
        instanceId: inst.id,
        label: inst.label,
        depth,
        loading: readStringProp(ps, "loading"),
        hasAlt: ps?.has("alt") === true,
        hasWidth: ps?.has("width") === true,
        hasHeight: ps?.has("height") === true,
      });
    } else if (inst.component === "ws:element" && (inst as { tag?: string }).tag === "img") {
      // Legacy raw <img> instance (pre-v2.18.0 — push paths now auto-convert
      // these to Image). Invisible to the Image checks above, so surface it
      // here with a migration nudge.
      const ps = propsIdx.get(inst.id);
      rawImgs.push({
        instanceId: inst.id,
        component: "ws:element",
        label: inst.label,
        src: readStringProp(ps, "src") ?? "(no src)",
        loading: readStringProp(ps, "loading"),
        hasWidth: ps?.has("width") === true,
        hasHeight: ps?.has("height") === true,
        snippet: `ws:element tag="img" — legacy, convert to the native Image component (pattern image-component)`,
      });
    } else if (EMBED_COMPONENTS.has(inst.component)) {
      const code = readStringProp(propsIdx.get(inst.id), "code");
      if (code && code.includes("<img")) {
        rawImgs.push(...scanRawImgs(code, inst.id, inst.component, inst.label));
      }
    }
  });
  return { pagePath: page.path || "/", pageName: page.name, images, rawImgs };
}

/** Render one page block; returns null if everything is clean. */
function renderPage(p: PageAudit, heroDepth: number, verbose: boolean): string[] {
  const noLoading: ImageRecord[] = [];
  const heroBad: ImageRecord[] = [];
  const belowFoldBad: ImageRecord[] = [];
  for (const img of p.images) {
    if (img.loading === undefined) noLoading.push(img);
    else if (img.depth <= heroDepth && img.loading !== "eager") heroBad.push(img);
    else if (img.depth > heroDepth && img.loading !== "lazy") belowFoldBad.push(img);
  }
  const clsRisk = p.rawImgs.filter((r) => !r.hasWidth || !r.hasHeight);

  const issueCount = noLoading.length + heroBad.length + belowFoldBad.length + p.rawImgs.length;
  if (issueCount === 0) return [`✅ ${p.pagePath}: clean (${p.images.length} Image, 0 raw <img>)`];

  const out: string[] = [];
  out.push(`\n── ${p.pagePath} (${p.pageName}) ──`);
  out.push(`   Images=${p.images.length} | raw <img>=${p.rawImgs.length}`);

  const cap = verbose ? Infinity : 10;
  const trunc = <T,>(arr: T[]) => arr.length > cap ? `   … (+${arr.length - cap} more, use verbose=true)` : null;

  if (noLoading.length > 0) {
    out.push(`\n  📸 Images missing loading attr (${noLoading.length}) — hero ⇒ "eager", otherwise "lazy":`);
    for (const img of noLoading.slice(0, cap)) {
      out.push(`     - [${img.instanceId}] depth=${img.depth}${img.label ? ` "${img.label}"` : ""}`);
    }
    const t = trunc(noLoading); if (t) out.push(t);
  }
  if (heroBad.length > 0) {
    out.push(`\n  ⚡ Hero images (depth<=${heroDepth}) without loading="eager" (${heroBad.length}) — LCP risk:`);
    for (const img of heroBad.slice(0, cap)) {
      out.push(`     - [${img.instanceId}] depth=${img.depth} loading=${img.loading ?? "∅"}${img.label ? ` "${img.label}"` : ""}`);
    }
    const t = trunc(heroBad); if (t) out.push(t);
  }
  if (belowFoldBad.length > 0) {
    out.push(`\n  🐌 Below-fold without loading="lazy" (${belowFoldBad.length}) — wasted bandwidth:`);
    for (const img of belowFoldBad.slice(0, cap)) {
      out.push(`     - [${img.instanceId}] depth=${img.depth} loading=${img.loading ?? "∅"}${img.label ? ` "${img.label}"` : ""}`);
    }
    const t = trunc(belowFoldBad); if (t) out.push(t);
  }
  if (p.rawImgs.length > 0) {
    out.push(`\n  🚫 Raw <img> (${p.rawImgs.length} — Embed HTML or legacy ws:element instances) — optimization bypassed, use the Image component:`);
    for (const r of p.rawImgs.slice(0, cap)) {
      out.push(`     - [${r.instanceId}] (${r.component})${r.label ? ` "${r.label}"` : ""}`);
      out.push(`         ${r.snippet}`);
    }
    const t = trunc(p.rawImgs); if (t) out.push(t);
  }
  if (clsRisk.length > 0) {
    out.push(`\n  📐 CLS risk — raw <img> without width/height (${clsRisk.length}):`);
    for (const r of clsRisk.slice(0, cap)) {
      out.push(`     - [${r.instanceId}] w=${r.hasWidth ? "✓" : "✗"} h=${r.hasHeight ? "✓" : "✗"}  src=${r.src.slice(0, 60)}`);
    }
    const t = trunc(clsRisk); if (t) out.push(t);
  }
  return out;
}

export const auditImagesTool: ToolModule = {
  definition: {
    name: "webstudio_audit_images",
    description: `Use when: you want to audit a Webstudio project's images (perf, LCP, CLS).
Scans all pages and flags:
- Image components without \`loading\` prop (should be eager for the hero, lazy otherwise)
- Hero images (depth <= heroDepth, default 3) without loading="eager" → LCP risk
- Below-fold images without loading="lazy" → wasted bandwidth
- Raw HTML <img> in HtmlEmbed/ContentEmbed (WebP/AVIF/sizes optimization bypassed)
- Raw <img> without width/height → CLS risk
verbose=true for the full list (otherwise top 10 per category). Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        verbose: { type: "boolean", description: "Show all entries instead of top 10 per category." },
        heroDepth: { type: "number", description: "Depth threshold for hero images (default 3)." },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditImagesInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const input = parsed.data;

    let auth;
    try { auth = requireAuth(input.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const propsIdx = indexProps(build);
    const pages = build.pages.pages;
    const audits = pages.map((p) => auditPage(build, p, propsIdx));

    // Summary
    let totalImages = 0, totalRaw = 0, totalNoLoading = 0, totalHeroBad = 0, totalBelowFoldBad = 0, totalCls = 0;
    for (const a of audits) {
      totalImages += a.images.length;
      totalRaw += a.rawImgs.length;
      for (const img of a.images) {
        if (img.loading === undefined) totalNoLoading++;
        else if (img.depth <= input.heroDepth && img.loading !== "eager") totalHeroBad++;
        else if (img.depth > input.heroDepth && img.loading !== "lazy") totalBelowFoldBad++;
      }
      for (const r of a.rawImgs) if (!r.hasWidth || !r.hasHeight) totalCls++;
    }

    const lines: string[] = [];
    lines.push(`🔍 audit_images — ${build.project?.title ?? input.projectSlug} (${pages.length} page${pages.length > 1 ? "s" : ""})`);
    lines.push(``);
    lines.push(`📊 Summary:`);
    lines.push(`  - Image components: ${totalImages} | raw <img> (embeds + ws:element instances): ${totalRaw}`);
    lines.push(`  - 📸 No loading attr: ${totalNoLoading}`);
    lines.push(`  - ⚡ Hero (depth<=${input.heroDepth}) not eager: ${totalHeroBad}`);
    lines.push(`  - 🐌 Below-fold not lazy: ${totalBelowFoldBad}`);
    lines.push(`  - 🚫 Raw <img> in embed: ${totalRaw}`);
    lines.push(`  - 📐 CLS risk (raw img, no w/h): ${totalCls}`);

    for (const a of audits) {
      const block = renderPage(a, input.heroDepth, input.verbose);
      lines.push(...block);
    }

    return textResult(lines.join("\n"));
  },
};
