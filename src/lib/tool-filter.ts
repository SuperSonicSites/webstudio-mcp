// Reduced tool-surface mode (v2.15.0 — item 5 of the 2026-06-10 audit backlog).
//
// WEBSTUDIO_MCP_TOOLS="meta,read,audit" registers only the named mega-tools.
// Two motivations, both routine-driven (cron crawls / audits run headless):
//   - safety: a read-only routine has no business mounting mutation tools;
//   - context: a 3-tool surface costs ~8k tokens instead of ~26k per session.
//
// Rules:
//   - unset / empty → inactive, every tool registered (default unchanged);
//   - names are trimmed + case-insensitive;
//   - "meta" is ALWAYS kept (discovery is core; meta.index reflects the
//     filtered list via its closure);
//   - named PRESETS (v2.21.0) expand before per-name matching and compose
//     with explicit names ("readonly,assets" = the readonly trio + assets);
//   - unknown names are reported (caller prints them on stderr);
//   - active filter matching ZERO known tools → fail-safe: keep meta only.
//     Serving the full surface on a typo would defeat the safety use case.

// Named profiles for common deployment modes. Keep these aligned with the
// README's "Reduced tool surface" section.
export const TOOL_FILTER_PRESETS: Record<string, string[]> = {
  /** Safe crawl/audit instance — no mutation tools. */
  readonly: ["meta", "read", "audit"],
  /** Copy/content editing — text, styles, tokens, CMS; no fragment pushes. */
  content: ["meta", "read", "styles", "tokens", "instances", "cms"],
  /** Section building — fragment construction + instance tree + styling. */
  builder: ["meta", "read", "build", "instances", "styles", "tokens"],
};

export type ToolFilterResult = {
  /** False when the env var is unset/empty — register everything. */
  active: boolean;
  /** Tool names to register (lowercase match, original casing preserved). */
  keep: Set<string>;
  /** Names from the env var that matched no known tool. */
  unknown: string[];
};

export function applyToolFilter(
  knownToolNames: string[],
  envValue: string | undefined,
): ToolFilterResult {
  const raw = (envValue ?? "").trim();
  if (raw === "") {
    return { active: false, keep: new Set(knownToolNames), unknown: [] };
  }
  const wanted = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    // Preset expansion happens before name matching, so presets compose with
    // explicit names and with each other.
    .flatMap((w) => TOOL_FILTER_PRESETS[w] ?? [w]);
  const byLower = new Map(knownToolNames.map((n) => [n.toLowerCase(), n]));
  const keep = new Set<string>();
  const unknown: string[] = [];
  for (const w of wanted) {
    if (w === "meta") continue; // always present, declared or not
    const match = byLower.get(w);
    if (match) keep.add(match);
    else unknown.push(w);
  }
  return { active: true, keep, unknown };
}
