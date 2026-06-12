// Mega-tool dispatcher helpers (v1.0 prep).
//
// A mega-tool exposes a single MCP tool definition but routes to N internal action
// handlers via a discriminated-union input (`action: "create" | "update" | ...`).
// This module ships the type alias, the dispatcher, and a JSON Schema builder
// so each mega-tool stays lean (no boilerplate dispatch logic per file).

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "../tools/types.js";
import { dedupeSchemaDefs } from "./schema-dedupe.js";

export type ActionHandler<T = unknown> = (input: T) => Promise<CallToolResult>;

/**
 * Dispatch a parsed input to its matching handler. Returns INVALID_ACTION if
 * the action key isn't in the handlers map. Callers MUST have parsed the input
 * (typically via a Zod discriminated union) before calling this.
 */
export async function dispatchAction<TInput extends { action: string }>(
  input: TInput,
  handlers: Record<string, ActionHandler<TInput>>,
): Promise<CallToolResult> {
  const handler = handlers[input.action];
  if (!handler) {
    const known = Object.keys(handlers).join(", ");
    return errorResult(
      "VALIDATION_FAILED",
      `Unknown action "${input.action}". Known actions: ${known}`,
    );
  }
  return handler(input);
}

export type ActionDef = {
  /** Discriminator value for this action (e.g. "create"). */
  action: string;
  /** Description rendered in the JSON Schema for documentation/agent guidance. */
  description: string;
  /** JSON Schema `properties` for THIS action's params (excluding `action` + `label`). */
  schema: Record<string, unknown>;
  /** Required property names within this action's schema (excluding `action` + `label`). */
  required?: string[];
};

/**
 * Action metadata kept alongside the flat JSON Schema. Consumed by `meta.index` and
 * `meta.get_more_tools` to count + BM25-rank actions without parsing the schema.
 * Not standard JSON Schema — Anthropic API tolerates extra top-level fields.
 */
export type ActionMeta = {
  action: string;
  description: string;
  required: string[];
  /** Per-action JSON schema property names (the keys the wrapper advertises for THIS
   *  action only). Excludes `action` + `label` which are always present at the mega-tool
   *  level. Used by `test/wrapper-schema-coherence.test.mjs` to assert wrapper-claimed
   *  params match the sub-handler's accepted params. */
  schemaKeys: string[];
};

/**
 * MCP Tool inputSchema shape — typed for the @modelcontextprotocol/sdk Tool definition.
 *
 * Flat schema (no top-level `oneOf` — Anthropic API rejects `oneOf/allOf/anyOf` at the
 * top of `tools[].custom.input_schema`). Per-action discrimination happens at runtime
 * via the Zod `discriminatedUnion` in each mega-tool's handler.
 */
export type MegaToolInputSchema = {
  type: "object";
  properties: Record<string, object>;
  required: string[];
  additionalProperties: boolean;
  /** Per-action metadata (action name + description + required-when-active). Non-standard. */
  xActions: ActionMeta[];
};

// Canonical section markers of the tool-description structure (see CLAUDE.md
// "Tool description structure"). Everything from the first marker onward is
// detail an agent can fetch on demand — only the "Use when:" lead travels on
// the wire (v2.12.0 wire-schema economy; see pattern wire-schema-economy).
const DESCRIPTION_DETAIL_MARKERS = [
  " Do NOT use when:",
  " Returns:",
  " Side effects:",
  " Example:",
  " [PATTERN]",
];

// v2.20.3: 110 (was 220) — the joined summary lines are the single largest
// prose block on the wire (~23 kB across 108 actions at the old cap). Leads
// longer than the cap get ellipsis-truncated; keep "Use when:" leads ≤~100
// chars in the action definitions so nothing truncates mid-thought.
const SUMMARY_HARD_CAP = 110;

/**
 * Compress a full action description to its one-line lead for the wire schema.
 *
 * - Cuts at the first canonical detail marker (Do NOT use when / Returns /
 *   Side effects / Example) — the "Use when:" lead must be self-sufficient.
 * - Short free-form descriptions (no markers) pass through unchanged.
 * - Hard cap at SUMMARY_HARD_CAP chars as a backstop for long leads.
 * - The "CRITICAL — context required" safety marker is always preserved (the
 *   agent must see it BEFORE calling, not after a CONTEXT_REQUIRED error).
 *
 * Full descriptions stay available in `xActions` (in-memory: meta.get_more_tools,
 * meta.guide BM25) — they are no longer duplicated on the wire.
 */
export function summarizeActionDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  let cut = oneLine.length;
  for (const marker of DESCRIPTION_DETAIL_MARKERS) {
    const idx = oneLine.indexOf(marker);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  let summary = oneLine.slice(0, cut).trim();
  if (summary.length > SUMMARY_HARD_CAP) {
    summary = summary.slice(0, SUMMARY_HARD_CAP - 1).trimEnd() + "…";
  }
  if (/CRITICAL/.test(oneLine) && !/CRITICAL/.test(summary)) {
    summary += " [CRITICAL — context required]";
  }
  return summary;
}

// Wire definitions are immutable post-boot and the dedupe pass is pure —
// compute once per definition, serve from cache on every ListTools.
const wireDefCache = new WeakMap<object, unknown>();

/**
 * Wire-facing view of a tool definition:
 *   1. minus the non-standard `xActions` metadata (server-side consumers
 *      only — shipping it duplicated every action description, ~80k chars
 *      across 15 tools measured v2.11.0);
 *   2. repeated schema subtrees hoisted into `$defs`/`$ref` (v2.17.0 —
 *      zod-to-json-schema inlines StyleValue & friends at every use site).
 * In-memory definitions stay untouched (guard tests + meta BM25 read them).
 */
export function toWireToolDefinition<T extends { inputSchema: object }>(definition: T): T {
  const cached = wireDefCache.get(definition);
  if (cached) return cached as T;

  const schema = definition.inputSchema as Partial<MegaToolInputSchema> & Record<string, unknown>;
  let wireSchema: Record<string, unknown> = schema;
  if ("xActions" in wireSchema) {
    const { xActions: _x, ...rest } = wireSchema;
    wireSchema = rest;
  }
  wireSchema = dedupeSchemaDefs(wireSchema);

  const wire = wireSchema === schema ? definition : ({ ...definition, inputSchema: wireSchema } as T);
  wireDefCache.set(definition, wire);
  return wire;
}

// Annotation keys that never change what validates: differences in these must
// not fork an `anyOf` variant (v2.20.3 — default/examples-only forks shipped
// 12 two-variant anyOfs across 10 tools, ~2.9 kB of duplicated shapes).
const SHAPE_ANNOTATION_KEYS = new Set(["description", "default", "examples"]);

/**
 * Structural equality of two JSON-schema fragments, ignoring annotation-only
 * keys (description/default/examples) at every level. Two schemas that
 * validate identically are the same variant — annotation-only differences
 * must not fork an `anyOf` (first description wins; conflicting defaults are
 * dropped by dropConflictingDefaults).
 */
function schemaShapeEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => schemaShapeEquals(v, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const ka = Object.keys(a).filter((k) => !SHAPE_ANNOTATION_KEYS.has(k)).sort();
    const kb = Object.keys(b).filter((k) => !SHAPE_ANNOTATION_KEYS.has(k)).sort();
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k, i) =>
        k === kb[i] &&
        schemaShapeEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

const jsonEquals = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * `kept` and `incoming` are shape-equal modulo annotations. Where they
 * disagree on `default` (different values, or only one side advertises one),
 * the merged schema must NOT advertise any default: e.g. build.pushTo's
 * nested dryRun runtime-defaults false for push_fragment but true for
 * push_complete — advertising either could trigger an unintended live push.
 * Copy-on-write: returns `kept` untouched when nothing conflicts (the
 * fragments are module-scope zod-to-json-schema output shared with xActions).
 * Descriptions and examples stay first-wins.
 */
function dropConflictingDefaults(kept: unknown, incoming: unknown): unknown {
  if (Array.isArray(kept) && Array.isArray(incoming)) {
    let changed = false;
    const out = kept.map((v, i) => {
      const r = dropConflictingDefaults(v, incoming[i]);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : kept;
  }
  if (kept !== null && incoming !== null && typeof kept === "object" && typeof incoming === "object") {
    const k = kept as Record<string, unknown>;
    const inc = incoming as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    if ("default" in k && (!("default" in inc) || !jsonEquals(k.default, inc.default))) {
      out = { ...k };
      delete out.default;
    }
    for (const key of Object.keys(k)) {
      if (SHAPE_ANNOTATION_KEYS.has(key)) continue;
      const r = dropConflictingDefaults(k[key], inc[key]);
      if (r !== k[key]) {
        out = out ?? { ...k };
        out[key] = r;
      }
    }
    return out ?? kept;
  }
  return kept;
}

/**
 * Build the JSON Schema for a mega-tool's `inputSchema`. Returns a **flat** schema:
 *   - `action`: enum of all branch discriminator values, description lists each
 *     variant's one-line summary (full docs live in `xActions` / meta.get_more_tools)
 *   - `label`: 3-30 chars action label
 *   - all branch properties merged by name. When two actions advertise the SAME
 *     key with DIFFERENT shapes (e.g. instances' `updates[]` item is
 *     {instanceId,label} for update_label but {instanceId,text} for update_text),
 *     the property becomes a nested `anyOf` of the distinct shapes, each variant
 *     tagged with the action(s) it applies to. First-wins merging here made
 *     update_text/prop_update UNCALLABLE (v2.20.0 incident: the advertised item
 *     shape required `label`, which the sub-handler rejects — no payload could
 *     satisfy both). Nested anyOf is fine — only TOP-LEVEL oneOf/allOf/anyOf is
 *     rejected by the Anthropic API, and zod unions already emit nested anyOf.
 *   - `required: ["action", "label"]` — per-action required fields are enforced at
 *     runtime by the Zod discriminated union, not by JSON Schema (the API rejects
 *     `oneOf` at the top level so we can't express per-branch required[] there).
 *   - `xActions`: full per-action metadata for the `meta` mega-tool (index + BM25
 *     ranking). Stripped from the wire by `toWireToolDefinition` at ListTools time.
 */
export function buildJsonSchemaForActions(actions: ActionDef[]): MegaToolInputSchema {
  if (actions.length === 0) {
    throw new Error("buildJsonSchemaForActions: at least 1 action required");
  }
  const actionEnum = actions.map((a) => a.action);
  // Per-tool wire prose is paid ×15 every session — keep these descriptions
  // one line each; the full context policy and the get_more_tools pointer live
  // once in SERVER_INSTRUCTIONS (src/index.ts).
  // Bare `name — summary` lines (the action="..." prefix cost ~1 kB over 108
  // actions). NOTE: the action="..." tags inside anyOf VARIANT descriptions
  // (see below) are load-bearing for variant→action mapping and keep the prefix.
  const actionDescription = actions
    .map((a) => `${a.action} — ${summarizeActionDescription(a.description)}`)
    .join("\n");
  const properties: Record<string, object> = {
    action: { type: "string", enum: actionEnum, description: actionDescription },
    label: {
      type: "string",
      minLength: 3,
      maxLength: 30,
      description: "Short unique label for this call.",
    },
    // `context` is mega-tool-level (declared in each mega-tool's Base Zod). Optional in
    // the JSON schema because the API rejects top-level oneOf/allOf/anyOf — we cannot
    // express "required IFF tier=CRITICAL" via the schema. The runtime validator
    // (lib/context-validator.ts) enforces the tier-based requirement (and the
    // PII/secrets/third-person policy stated in SERVER_INSTRUCTIONS) and returns
    // CONTEXT_REQUIRED_FOR_CRITICAL when missing for a CRITICAL action.
    //
    // INCIDENT 2026-05-26: `context` must STAY a declared property here — without
    // it, `additionalProperties:false` rejects `context` client-side before it
    // reaches the server (instances.delete was unusable despite the description
    // listing context in the example). Only the description may shrink.
    context: {
      type: "string",
      minLength: 60,
      maxLength: 200,
      description:
        "Third-person reason for this call (15-25 words). REQUIRED for actions marked CRITICAL. See server instructions for the policy.",
    },
  };
  // Collect the distinct shapes each key is advertised with across actions.
  type PropertyVariant = { schema: Record<string, unknown>; actions: string[] };
  const variantsByKey = new Map<string, PropertyVariant[]>();
  for (const a of actions) {
    for (const [key, propSchema] of Object.entries(a.schema)) {
      // action/label/context are mega-tool-level — defined above, never overridden.
      if (key === "action" || key === "label" || key === "context") continue;
      if (propSchema === null || typeof propSchema !== "object") continue;
      let variants = variantsByKey.get(key);
      if (!variants) {
        variants = [];
        variantsByKey.set(key, variants);
      }
      const existing = variants.find((v) => schemaShapeEquals(v.schema, propSchema));
      if (existing) {
        existing.actions.push(a.action);
        existing.schema = dropConflictingDefaults(existing.schema, propSchema) as Record<string, unknown>;
      } else {
        variants.push({ schema: propSchema as Record<string, unknown>, actions: [a.action] });
      }
    }
  }
  for (const [key, variants] of variantsByKey) {
    if (variants.length === 1) {
      properties[key] = variants[0].schema;
      continue;
    }
    properties[key] = {
      description: "Shape depends on `action` — use the anyOf variant whose description names your action.",
      anyOf: variants.map((v) => {
        const applies = `[${v.actions.map((x) => `action="${x}"`).join(", ")}]`;
        const desc = typeof v.schema.description === "string" && v.schema.description.length > 0
          ? `${applies} ${v.schema.description}`
          : applies;
        return { ...v.schema, description: desc };
      }),
    };
  }
  const xActions: ActionMeta[] = actions.map((a) => ({
    action: a.action,
    description: a.description,
    required: a.required ?? [],
    schemaKeys: Object.keys(a.schema).filter((k) => k !== "action" && k !== "label"),
  }));
  return {
    type: "object",
    properties,
    required: ["action", "label"],
    additionalProperties: false,
    xActions,
  };
}
