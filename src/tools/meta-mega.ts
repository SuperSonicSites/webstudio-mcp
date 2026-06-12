// Mega-tool `meta` — v2.0. Discovery + introspection.
//
// 5 actions:
//   - index            → list all registered MCP tools with names + categories
//   - list_patterns    → catalog of available pattern recipes (slug + name + category)
//   - describe_pattern → fetch a pattern recipe (docs/patterns/<slug>.md) or helper snippet
//   - get_more_tools   → BM25-ranked action recommendations from a free-text brief
//   - guide            → free-text triage: BM25 over patterns AND tool actions in one shot,
//                        returns the best pattern + matching high-level tool with next-action hint
//
// Tier mapping: all READ-ONLY.
//
// `index`, `get_more_tools`, and `guide` introspect the live TOOLS list (factory pattern) —
// the registry passes a `getToolsList` closure when constructing the mega-tool.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult, textResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { buildIndex, search } from "../lib/bm25.js";
import { describePatternTool, describePatternInputSchema } from "./describe-pattern.js";
import { listPatternResources, readPatternResource } from "../resources.js";

const TIER: Record<string, Tier> = {
  index: "READ-ONLY",
  list_patterns: "READ-ONLY",
  describe_pattern: "READ-ONLY",
  get_more_tools: "READ-ONLY",
  guide: "READ-ONLY",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("index") }).passthrough(),
  Base.extend({ action: z.literal("list_patterns") }).passthrough(),
  Base.extend({ action: z.literal("describe_pattern") }).passthrough(),
  Base.extend({ action: z.literal("get_more_tools") }).passthrough(),
  Base.extend({ action: z.literal("guide") }).passthrough(),
]);

// `index` takes no payload beyond the boilerplate.
const indexInputSchema = z.object({}).strict();

// `list_patterns` — optional substring filter on slug/name/description/category.
const listPatternsInputSchema = z.object({
  filter: z.string().optional().describe("Case-insensitive substring filter applied to slug/name/description/category."),
}).strict();

// `get_more_tools` is implemented inline below (no atomic file). Declare its
// Zod here so the v2 builder can derive the JSON schema.
const getMoreToolsInputSchema = z.object({
  brief: z.string().min(1).describe("Free-text intent to match against action descriptions."),
  category: z.string().optional().describe("Optional substring of the tool NAME to filter (e.g. 'tokens')."),
  topN: z.number().int().min(1).max(10).optional().describe("Number of results to return (default 5)."),
}).strict();

// `guide` — single-shot triage. BM25 over the union of pattern recipes (full body)
// and tool xActions, with a pattern→high-level-tool mapping appended to the output.
const guideInputSchema = z.object({
  brief: z.string().min(1).describe("Free-text intent — e.g. 'desktop mega menu with chevron', 'mobile burger drawer', 'image hero with overlay', 'occasions list from Directus', 'logos partenaires défilants'."),
  topN: z.number().int().min(1).max(10).optional().describe("Number of results to return (default 5)."),
  includeTools: z.boolean().optional().describe("Include tool actions in the corpus alongside patterns. Default true. Set false to restrict to pattern recipes only."),
}).strict();

// Pattern→tool recommendations are sourced from the frontmatter of each
// `docs/patterns/<slug>.md` (fields: `recommendedTool` + `recommendedToolNote`).
// See `src/resources.ts:extractFrontmatter`. To add a recommendation for a new
// pattern, drop the two fields in its frontmatter — no TS edit required.

const DESCRIPTIONS = {
  index: `Use when: discover the catalog of v1.0+ mega-tools (name + 1-line summary) at session start. Do NOT use when: looking for a specific pattern recipe (use action:"describe_pattern") or doing a free-text "how do I X" triage (use action:"guide"). Returns: list of {name, summary, actionCount} + a footer with the pattern catalog size and how to reach it. Side effects: none. Example: {action:"index",label:"discover"}`,
  list_patterns: `Use when: enumerating the pattern recipe catalog before describe_pattern — never guess slugs. Do NOT use when: you already know the slug (call describe_pattern directly) or doing a free-text "how do I X" triage (use action:"guide"). Guessing slugs re-invents existing wheels (bento, mega-menu, sheet-mobile, swiper…) — enumerate first. Returns: grouped list by category with {slug, name, description}. Optional \`filter\` does case-insensitive substring matching on slug/name/description/category. Side effects: none. Example: {action:"list_patterns",label:"discover-patterns"} or {action:"list_patterns",label:"find-bento",filter:"bento"}. Tip: patterns are also exposed as MCP Resources at webstudio://patterns/<slug> — clients with resources support can list them via the standard ListResources call without invoking this action.`,
  describe_pattern: `Use when: fetching the full recipe doc for a known pattern slug or helper snippet. Do NOT use when: needing tool documentation (use action:"index"), browsing the catalog (use action:"list_patterns"), or you don't know the slug (use action:"guide" with a free-text brief). Returns: full Webstudio markdown recipe from docs/patterns/<slug>.md with pitfalls — covers recipes like mega-menu, sheet mobile, swiper, sticky header. Side effects: none. Example: {action:"describe_pattern",label:"sheet-doc",pattern:"sheet-mobile-radix"}`,
  get_more_tools: `Use when: fetching one action's full doc by exact name, or BM25 search over tool actions only. Do NOT use when: you want patterns + tools combined (use action:"guide" — it covers both). Returns: exact "<tool>.<action>" brief → the full action doc (params, redirections, example); free text → top 1-5 (action, tool, BM25 score, description snippet) ranked by Okapi BM25. Wire schemas only carry one-line summaries — pass brief:"<tool>.<action>" (e.g. brief:"instances.append") to read an action's full doc. Optional category filters by tool name (e.g. category:"tokens" only matches tools whose name contains "tokens"). Side effects: none (read-only — builds an in-memory index over registered mega-tool action descriptions). Example: {action:"get_more_tools",label:"doc-append",brief:"instances.append"} or {action:"get_more_tools",label:"find-tools",category:"tokens",brief:"remove orphan style overrides"}`,
  guide: `Use when: free-text "how do I X" triage — one BM25 ranking over BOTH patterns AND tool actions. Do NOT use when: you already know the slug (call describe_pattern directly) or you only want tools without patterns (use get_more_tools). Always call this single-shot triage BEFORE improvising a build.push_fragment or instances.append on any non-trivial section; the ranking indexes pattern recipe full bodies plus tool xActions. Returns: top N results with [PATTERN]/[TOOL] markers + a "next action" hint mapping each pattern to its recommended high-level tool (e.g. navigation-menu-radix → build.create_navigation_menu). Side effects: none. Example: {action:"guide",label:"how-mega-menu",brief:"desktop mega menu with mobile burger drawer"}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

export function makeMetaTool(getToolsList: () => ToolModule[]): ToolModule {
  // Corpus/index cache (v2.13.0). `guide` re-read all 40 pattern bodies from
  // disk and rebuilt the BM25 index on EVERY call; `get_more_tools` rebuilt its
  // index too. Tools never change post-boot and patterns only change on disk
  // edits (dev), so a short TTL is safe. Scoped to the factory instance —
  // tests building meta tools over stub tool lists stay isolated.
  const INDEX_CACHE_TTL_MS = 30_000;
  type CachedCorpus = {
    docs: Array<{ payload: unknown; text: string }>;
    index: ReturnType<typeof buildIndex<unknown>>;
    builtAt: number;
  };
  const indexCache = new Map<string, CachedCorpus>();
  const cachedIndex = (
    key: string,
    build: () => Array<{ payload: unknown; text: string }>,
  ): CachedCorpus => {
    const hit = indexCache.get(key);
    if (hit && Date.now() - hit.builtAt < INDEX_CACHE_TTL_MS) return hit;
    const docs = build();
    const entry = { docs, index: buildIndex(docs), builtAt: Date.now() };
    indexCache.set(key, entry);
    return entry;
  };

  const HANDLERS = {
    index: async (_input: Record<string, unknown>) => {
      const tools = getToolsList();
      const lines: string[] = [];
      lines.push(`# Webstudio MCP — Tool index (${tools.length} tools)\n`);
      for (const t of tools) {
        const desc = t.definition.description ?? "";
        const summary = desc.split("\n")[0].slice(0, 200);
        const schema = t.definition.inputSchema as { xActions?: unknown[] } | undefined;
        const actionCount = schema?.xActions?.length ?? 0;
        const tag = actionCount > 0 ? ` [${actionCount} actions]` : "";
        lines.push(`- **${t.definition.name}**${tag} — ${summary}`);
      }
      // Footer: cross-reference the pattern catalog so agents stop guessing slugs.
      const patterns = listPatternResources();
      if (patterns.length > 0) {
        const cats = new Set<string>();
        for (const p of patterns) if (p.category) cats.add(p.category);
        const catList = [...cats].sort().join(", ") || "uncategorized";
        lines.push("");
        lines.push(`---`);
        lines.push(`${patterns.length} pattern recipes available (categories: ${catList}). Call \`meta.list_patterns\` to enumerate, or \`meta.describe_pattern\` for a specific slug. MCP-Resources clients can also list them via the standard \`resources/list\` request (uri: \`webstudio://patterns/<slug>\`).`);
      }
      return textResult(lines.join("\n"));
    },
    list_patterns: async (input: Record<string, unknown>) => {
      const parsed = listPatternsInputSchema.safeParse(strip(input));
      if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
      const { filter } = parsed.data;
      const all = listPatternResources();
      if (all.length === 0) return textResult("No pattern recipes found (docs/patterns/ is empty or missing).");
      const needle = filter?.toLowerCase().trim();
      const matches = needle
        ? all.filter((p) =>
            p.slug.toLowerCase().includes(needle) ||
            p.name.toLowerCase().includes(needle) ||
            p.description.toLowerCase().includes(needle) ||
            (p.category?.toLowerCase().includes(needle) ?? false))
        : all;
      if (matches.length === 0) {
        return textResult(`No pattern matched "${filter}". Try \`meta.list_patterns\` (no filter) to see all ${all.length} patterns.`);
      }
      // Group by category (uncategorized last).
      const byCat = new Map<string, typeof matches>();
      for (const p of matches) {
        const cat = p.category ?? "uncategorized";
        const arr = byCat.get(cat) ?? [];
        arr.push(p);
        byCat.set(cat, arr);
      }
      const cats = [...byCat.keys()].sort((a, b) => {
        if (a === "uncategorized") return 1;
        if (b === "uncategorized") return -1;
        return a.localeCompare(b);
      });
      const lines: string[] = [];
      const header = filter
        ? `# Pattern recipes matching "${filter}" (${matches.length}/${all.length})`
        : `# Pattern recipes (${all.length})`;
      lines.push(header);
      lines.push(`Fetch a full recipe with \`meta.describe_pattern({pattern:"<slug>"})\` or read directly via MCP resource \`webstudio://patterns/<slug>\`.\n`);
      for (const cat of cats) {
        lines.push(`\n## ${cat}`);
        for (const p of byCat.get(cat)!) {
          const desc = p.description.length > 160 ? p.description.slice(0, 160) + "…" : p.description;
          lines.push(`- **${p.slug}** — ${p.name}\n    ${desc}`);
        }
      }
      return textResult(lines.join("\n"));
    },
    describe_pattern: async (input: Record<string, unknown>) => describePatternTool.handler(strip(input)),
    guide: async (input: Record<string, unknown>) => {
      const parsed = guideInputSchema.safeParse(strip(input));
      if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
      const { brief, topN: topNRaw, includeTools: includeToolsRaw } = parsed.data;
      const topN = topNRaw ?? 5;
      const includeTools = includeToolsRaw ?? true;

      type GuideDoc =
        | { kind: "pattern"; slug: string; name: string; description: string; category?: string; recommendedTool?: string; recommendedToolNote?: string }
        | { kind: "tool"; tool: string; action: string; description: string };

      // Corpus is cached (30s TTL) — building it reads every pattern body from disk.
      const corpus = cachedIndex(`guide:tools=${includeTools}`, () => {
        const docs: Array<{ payload: GuideDoc; text: string }> = [];

        // Patterns: index slug + name + description + category + FULL body (markdown).
        // BM25's IDF naturally penalises common terms, so indexing the body is safe and
        // boosts recall on intent phrases like "burger menu" that only appear in the
        // recipe text, not in the short frontmatter description.
        // `recommendedTool` / `recommendedToolNote` come straight from the pattern's
        // frontmatter (see resources.ts) — no static mapping to maintain.
        for (const p of listPatternResources()) {
          let body = "";
          const res = readPatternResource(p.uri);
          if (res && res.contents.length > 0) {
            body = res.contents[0].text;
          }
          docs.push({
            payload: {
              kind: "pattern",
              slug: p.slug,
              name: p.name,
              description: p.description,
              category: p.category,
              recommendedTool: p.recommendedTool,
              recommendedToolNote: p.recommendedToolNote,
            },
            text: `${p.slug} ${p.name} ${p.description} ${p.category ?? ""} ${body}`,
          });
        }

        // Tool actions: same indexing strategy as get_more_tools, mixed into the same ranking.
        if (includeTools) {
          for (const t of getToolsList()) {
            const toolName = t.definition.name;
            const schema = t.definition.inputSchema as { xActions?: Array<{ action: string; description: string }> } | undefined;
            const actionsMeta = schema?.xActions;
            if (!actionsMeta || actionsMeta.length === 0) continue;
            for (const meta of actionsMeta) {
              docs.push({
                payload: { kind: "tool", tool: toolName, action: meta.action, description: meta.description },
                text: `${toolName} ${meta.action} ${meta.description}`,
              });
            }
          }
        }
        return docs;
      });

      const patterns = listPatternResources();
      if (corpus.docs.length === 0) {
        return textResult(`No corpus to search (no patterns + no tools registered).`);
      }

      const results = search(corpus.index, brief, topN) as Array<{ payload: GuideDoc; score: number }>;
      if (results.length === 0) {
        return textResult(
          `# Guide — "${brief}"\n\n` +
          `No match. Try broader terms, or call \`meta.list_patterns\` to browse pattern recipes, ` +
          `or \`meta.index\` for the tool catalog.`,
        );
      }

      const corpusBits: string[] = [`${patterns.length} pattern(s)`];
      if (includeTools) corpusBits.push("tool xActions");
      const lines: string[] = [];
      lines.push(`# Guide — "${brief}"`);
      lines.push(`Top ${results.length} match(es) — BM25 ranked across ${corpusBits.join(" + ")}.\n`);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const p = r.payload;
        if (p.kind === "pattern") {
          const desc = p.description.length > 200 ? p.description.slice(0, 200) + "…" : p.description;
          lines.push(`${i + 1}. **[PATTERN] ${p.slug}** — ${p.name} _(score ${r.score.toFixed(2)})_`);
          lines.push(`   ${desc}`);
          lines.push(`   → Read: \`meta.describe_pattern({pattern:"${p.slug}"})\``);
          if (p.recommendedTool) {
            lines.push(`   → Tool: \`${p.recommendedTool}\`${p.recommendedToolNote ? ` — ${p.recommendedToolNote}` : ""}`);
          }
          lines.push("");
        } else {
          const desc = p.description.split("\n")[0].slice(0, 200);
          lines.push(`${i + 1}. **[TOOL] ${p.tool}.${p.action}** _(score ${r.score.toFixed(2)})_`);
          lines.push(`   ${desc}${p.description.length > 200 ? "…" : ""}`);
          lines.push("");
        }
      }
      lines.push(`---`);
      lines.push(
        `**Next step**: if the top match is a [PATTERN], read it BEFORE pushing. ` +
        `If a high-level tool is listed (create_sheet, create_navigation_menu, bind_collection_to_instance, push_complete), prefer it over a raw \`build.push_fragment\`.`,
      );

      return textResult(lines.join("\n"));
    },
    get_more_tools: async (input: Record<string, unknown>) => {
      const args = strip(input);
      const brief = String(args.brief ?? "").trim();
      const category = String(args.category ?? "").toLowerCase().trim();
      const topN = typeof args.topN === "number" ? Math.max(1, Math.min(10, args.topN)) : 5;
      if (!brief) return errorResult("VALIDATION_FAILED", "brief is required");

      type Doc = { tool: string; action: string; description: string };
      // Corpus is cached per category filter (30s TTL).
      const corpus = cachedIndex(`more:cat=${category}`, () => {
        const docs: Array<{ payload: Doc; text: string }> = [];
        for (const t of getToolsList()) {
          const toolName = t.definition.name;
          if (category && !toolName.toLowerCase().includes(category)) continue;
          const schema = t.definition.inputSchema as { xActions?: Array<{ action: string; description: string }> } | undefined;
          const actionsMeta = schema?.xActions;
          if (!actionsMeta || actionsMeta.length === 0) {
            const description = t.definition.description ?? "";
            docs.push({
              payload: { tool: toolName, action: "(tool itself)", description },
              text: `${toolName} ${toolName} ${description}`,
            });
            continue;
          }
          for (const meta of actionsMeta) {
            docs.push({
              payload: { tool: toolName, action: meta.action, description: meta.description },
              text: `${toolName} ${meta.action} ${meta.description}`,
            });
          }
        }
        return docs;
      });
      const docs = corpus.docs as Array<{ payload: Doc; text: string }>;

      // Exact "<tool>.<action>" (or bare action name) lookup → full doc, no BM25.
      // This is the progressive-disclosure path of the wire-schema economy
      // (v2.12.0): wire schemas carry one-line summaries, the full description
      // (params, redirections, example) is fetched here on demand.
      const wanted = brief.toLowerCase();
      const exact = docs.filter(
        (d) =>
          `${d.payload.tool}.${d.payload.action}`.toLowerCase() === wanted ||
          d.payload.action.toLowerCase() === wanted,
      );
      if (exact.length > 0) {
        const lines = [`Full doc — ${exact.length} exact match(es) for "${brief}":\n`];
        for (const d of exact) {
          lines.push(`## ${d.payload.tool}.${d.payload.action}\n${d.payload.description}\n`);
        }
        return textResult(lines.join("\n"));
      }

      const results = search(corpus.index, brief, topN) as Array<{ payload: Doc; score: number }>;
      if (results.length === 0) {
        return textResult(`No actions matched "${brief}"${category ? ` in category "${category}"` : ""}. Try broader terms or use meta.index to see all tools.`);
      }

      const lines = [`Top ${results.length} action(s) matching "${brief}"${category ? ` in category "${category}"` : ""} (BM25 ranked):\n`];
      for (const r of results) {
        const snippet = r.payload.description.slice(0, 200).replace(/\n/g, " ");
        lines.push(`- **${r.payload.tool}.${r.payload.action}** (score ${r.score.toFixed(2)})\n    ${snippet}${r.payload.description.length > 200 ? "..." : ""}\n`);
      }
      return textResult(lines.join("\n"));
    },
  };

  return {
    definition: {
      name: "meta",
      description: `Mega-tool for tool discovery + pattern recipes. 5 actions: index (catalog of tools + footer w/ pattern count), list_patterns (catalog of pattern slugs), describe_pattern (Webstudio recipes from docs/patterns/<slug>.md), get_more_tools (BM25 search over action descriptions), guide (free-text triage matching patterns + tools in one BM25 ranking with next-action hint).`,
      inputSchema: buildJsonSchemaFromZodActions([
        { action: "index", description: DESCRIPTIONS.index, zod: indexInputSchema },
        { action: "list_patterns", description: DESCRIPTIONS.list_patterns, zod: listPatternsInputSchema },
        { action: "describe_pattern", description: DESCRIPTIONS.describe_pattern, zod: describePatternInputSchema },
        { action: "get_more_tools", description: DESCRIPTIONS.get_more_tools, zod: getMoreToolsInputSchema },
        { action: "guide", description: DESCRIPTIONS.guide, zod: guideInputSchema },
      ]),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
      logContext({ tool: "meta", action: input.action, tier, context: input.context });

      return dispatchAction(input, HANDLERS);
    },
  };
}
