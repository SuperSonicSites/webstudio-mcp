// Tool: webstudio_push_complete — atomic push combining fragment + cloud tokens
// + bindings + pattern repeat in ONE transaction.
//
// Built to replace the a production site footer workflow (2026-05-21) where a single section
// required ~14 sequential calls: create_tokens → update_token_styles ×2 →
// instances.append → instances.update_label → push_fragment → attach_token ×3 →
// update_text expression ×4 → prop_bind ×5. With push_complete the same outcome
// is one cloud call.
//
// Key combos handled inline:
//   - `tokens[]` with `attachToInstances` → create token + selections atomically
//   - `bindings[]` → inject expression children / expression props into the fragment
//   - `pattern.repeat` → expand a subtree template N times with {{var}} substitution
//   - `fromFile` → read the whole payload from a JSON file on disk
//
// Tokens, bindings, and pattern attachments target FRAGMENT-LOCAL instances (those
// listed in `instances`). To attach a NEW token to an EXISTING cloud instance, the
// caller still uses webstudio_apply_token afterward — keeps v1 narrow.

import { z } from "zod";
import { BindingSchema } from "../lib/zod-binding.js";
import { readFileSync } from "node:fs";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { findReplaceTargets } from "../lib/find-replace-targets.js";
import { stagePush } from "../lib/push-stage.js";
import { coerceRawImgInstances } from "../lib/coerce-image-component.js";
import { coerceRawVideoInstances } from "../lib/coerce-video-component.js";
import { lintShowBindingProps } from "../lib/lint-show-binding.js";
import {
  BuildFragmentSchema,
  StyleValueSchema,
  buildFromArgs,
  type BuildArgs,
} from "../build-from-args.js";
import { requireAuth, requirePushAuth, saveAuth } from "../auth.js";
import { fetchBuild, pushWithRetry } from "../webstudio-client.js";
import { logCoerce } from "../lib/telemetry.js";
import type {
  WebstudioBuild,
  BuildPatchTransaction,
  BuildPatchChange,
  BuildPatchOperation,
} from "../webstudio-client.js";
import { fragmentToTransaction } from "../fragment-to-patches.js";
import {
  buildInstanceRemovalChanges,
  buildParentChildrenPatch,
} from "../cleanup-helpers.js";
import { assertSafeRadixProp } from "../lib/radix-wrappers.js";
import { bindingToExpression, lintBinding, type Binding } from "../expressions.js";
import { expandStylesMap } from "./create-token/shared.js";
import {
  coerceStyleValueWithMeta,
  completeTransitionAnimationLonghands,
} from "../lib/style-coerce.js";
import type { InstanceChild, StyleValue } from "../types.js";

const TRANSITION_LONGHANDS_SET = new Set<string>([
  "transitionProperty",
  "transitionDuration",
  "transitionTimingFunction",
  "transitionDelay",
  "transitionBehavior",
]);
const ANIMATION_LONGHANDS_SET = new Set<string>([
  "animationName",
  "animationDuration",
  "animationTimingFunction",
  "animationDelay",
  "animationIterationCount",
  "animationDirection",
  "animationFillMode",
  "animationPlayState",
]);

// ── Schemas ─────────────────────────────────────────────────────────────────


const BindingEntrySchema = z.object({
  instanceId: z.string(),
  /** When set → bind a prop with this name. When absent → replace the first
   *  text/expression child of the instance (sugar for update_text mode=expression). */
  propName: z.string().optional(),
  binding: BindingSchema,
  /** Only meaningful for text bindings: index of the text/expression child to replace. Default 0. */
  childIndex: z.number().int().min(0).optional(),
}).strict();

const TokenInputSchema = z.object({
  name: z.string(),
  /** Free-form map property → StyleValue. Accepts every StyleValue variant (color, var, layers, tuple,
   *  function, shadow, fontFamily, image, keyword, unit, unparsed). Uniform shorthands are auto-expanded
   *  to longhands via expandStylesMap; non-uniform shorthands (flex, border) are rejected with a hint. */
  styles: z.record(z.string(), StyleValueSchema),
  /** Instance IDs (FRAGMENT-LOCAL only — must be present in the `instances` array) that should
   *  receive the token after creation. The token's styleSource and the attachment selection
   *  both land in the same transaction. */
  attachToInstances: z.array(z.string()).default([]),
}).strict();

const PatternPropSchema = z.object({
  instanceId: z.string(),
  name: z.string(),
  type: z.enum([
    "string", "boolean", "number", "expression", "json", "asset", "page",
    "string[]", "parameter", "resource", "action", "animationAction",
  ]),
  value: z.unknown(),
}).strict();

const PatternStyleSchema = z.object({
  instanceId: z.string(),
  property: z.string(),
  value: StyleValueSchema,
  breakpoint: z.enum(["base", "tablet", "mobile-landscape", "mobile-portrait"]).default("base"),
  state: z.string().optional(),
  listed: z.boolean().optional(),
}).strict();

const PatternInstanceSchema = z.object({
  id: z.string(),
  component: z.string(),
  tag: z.string().optional(),
  label: z.string().optional(),
  parentId: z.string().optional(),
  children: z.array(z.union([
    z.object({ type: z.literal("text"), value: z.string() }),
    z.object({ type: z.literal("expression"), value: z.string() }),
  ])).default([]),
}).strict();

const RepeatEntrySchema = z.object({
  idSuffix: z.string().optional(),
  vars: z.record(z.string(), z.string()),
}).strict();

const PatternSchema = z.object({
  /** Template subtree — instance IDs serve as placeholders to be reified per repeat entry. */
  subtree: z.array(PatternInstanceSchema).min(1),
  patternProps: z.array(PatternPropSchema).default([]),
  patternStyles: z.array(PatternStyleSchema).default([]),
  /** Bindings on subtree instances; {{vars}} are substituted in expression strings / template parts. */
  patternBindings: z.array(BindingEntrySchema).default([]),
  /** Optional id prefix for the cloned subtree. Each clone's id becomes `<idPrefix><origId>-<idSuffix>`
   *  or `<origId>-<idSuffix>` when idPrefix is absent. */
  idPrefix: z.string().optional(),
  /** N >= 1 entries — each entry expands the template once with `vars` substituted into
   *  any `{{<key>}}` placeholder in children.value, prop.value (when string), label,
   *  and style values when `unparsed`-typed. */
  repeat: z.array(RepeatEntrySchema).min(1),
}).strict();

const PushToSchema = z.object({
  projectSlug: z.string(),
  parentInstanceId: z.string().optional(),
  pageId: z.string().optional(),
  dryRun: z.boolean().default(true),
  forceConfirmed: z.boolean().default(false),
  insertIndex: z.number().int().nonnegative().optional(),
  ignoreWrapperWarning: z.boolean().default(false),
});

const ReplaceSchema = z.object({
  labels: z.array(z.string()).min(1),
  componentMatch: z.string().optional(),
});

export const pushCompleteInputSchema = BuildFragmentSchema.extend({
  // Override `instances` to allow empty (pattern.repeat or fromFile can fill it in later).
  // push_fragment keeps the original required-shape; push_complete is more flexible.
  instances: BuildFragmentSchema.shape.instances.default([]),
  pushTo: PushToSchema,
  replace: ReplaceSchema.optional(),
  /** Absolute path to a JSON file containing the full fragment payload. Fields read from the
   *  file are MERGED with inline arrays (file fields take precedence on conflict). Keeps the
   *  tool params under the wire limit when pushing 100+ instances. */
  fromFile: z.string().optional(),
  /** Cloud-aware tokens — create + attach in the same transaction. Overrides any `tokens` field
   *  inherited from BuildFragmentSchema (which uses a different shape without attachments). */
  cloudTokens: z.array(TokenInputSchema).default([]),
  /** Inline bindings (prop or text expression) applied as fragment payload mutations
   *  (no separate post-push patches). Target instances must be FRAGMENT-LOCAL. */
  bindings: z.array(BindingEntrySchema).default([]),
  pattern: PatternSchema.optional(),
}).strict();

type Input = z.infer<typeof pushCompleteInputSchema>;
type RepeatEntry = z.infer<typeof RepeatEntrySchema>;
type BindingEntry = z.infer<typeof BindingEntrySchema>;
type TokenInput = z.infer<typeof TokenInputSchema>;
type PatternInstance = z.infer<typeof PatternInstanceSchema>;
type PatternProp = z.infer<typeof PatternPropSchema>;
type PatternStyle = z.infer<typeof PatternStyleSchema>;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Substitute every `{{key}}` occurrence in a string with the matching var value.
 *  Returns null when the input is unchanged (no placeholder). Throws on a missing var. */
function substituteInString(s: string, vars: Record<string, string>): string {
  return s.replace(/\{\{([^}]+)\}\}/g, (_, rawKey) => {
    const key = String(rawKey).trim();
    if (!(key in vars)) {
      throw new Error(`Pattern var "{{${key}}}" not provided in repeat entry`);
    }
    return vars[key];
  });
}

/** Recursive substitution on a StyleValue: only `unparsed` carries free text. */
function substituteStyleValue(value: StyleValue, vars: Record<string, string>): StyleValue {
  if (value.type === "unparsed") {
    return { type: "unparsed", value: substituteInString(value.value, vars) };
  }
  // Other StyleValue variants only carry numbers/enums/structured children. The structured
  // ones could in theory hold an unparsed leaf, but in practice we never put `{{x}}` there.
  return value;
}

/** Substitute `{{x}}` in any string-shaped binding fragment (raw expression or template parts). */
function substituteBinding(binding: Binding, vars: Record<string, string>): Binding {
  if (binding.kind === "raw") {
    return { kind: "raw", expression: substituteInString(binding.expression, vars) };
  }
  if (binding.kind === "template") {
    return {
      kind: "template",
      parts: binding.parts.map((p) =>
        p.type === "text" ? { type: "text", value: substituteInString(p.value, vars) } : p,
      ),
    };
  }
  return binding;
}

/** Resolve a template id into a per-iteration id using idPrefix and (optional) idSuffix. */
function rewriteId(origId: string, idPrefix: string | undefined, idSuffix: string | undefined, idx: number): string {
  const suffix = idSuffix ?? String(idx + 1);
  return idPrefix ? `${idPrefix}${origId}-${suffix}` : `${origId}-${suffix}`;
}

/** Expand pattern.repeat into concrete instance/prop/style/binding arrays.
 *  Returns the lists augmented with the expanded subtree clones. */
function expandPattern(
  pattern: NonNullable<Input["pattern"]>,
  baseInstances: Input["instances"],
  baseProps: Input["props"],
  baseStyles: Input["styles"],
  baseBindings: BindingEntry[],
): {
  instances: Input["instances"];
  props: Input["props"];
  styles: Input["styles"];
  bindings: BindingEntry[];
} {
  const subtreeIds = new Set(pattern.subtree.map((i) => i.id));
  const outInstances: Input["instances"] = [...baseInstances];
  const outProps: Input["props"] = [...baseProps];
  const outStyles: Input["styles"] = [...baseStyles];
  const outBindings: BindingEntry[] = [...baseBindings];

  pattern.repeat.forEach((entry, idx) => {
    const idMap = new Map<string, string>();
    for (const inst of pattern.subtree) {
      idMap.set(inst.id, rewriteId(inst.id, pattern.idPrefix, entry.idSuffix, idx));
    }
    const remap = (origId: string): string => idMap.get(origId) ?? origId;

    // Clone subtree instances with substituted ids, labels, text children.
    for (const inst of pattern.subtree) {
      const newId = remap(inst.id);
      const newParentId = inst.parentId ? remap(inst.parentId) : undefined;
      const newLabel = inst.label ? substituteInString(inst.label, entry.vars) : undefined;
      // Subtree only allows text|expression children at the Zod boundary — no id children possible here.
      const newChildren = inst.children.map((c) =>
        c.type === "text"
          ? { type: "text" as const, value: substituteInString(c.value, entry.vars) }
          : { type: "expression" as const, value: substituteInString(c.value, entry.vars) },
      );
      outInstances.push({
        id: newId,
        component: inst.component,
        tag: inst.tag,
        label: newLabel,
        ...(newParentId !== undefined && { parentId: newParentId }),
        children: newChildren,
      });
    }

    // Clone patternProps with substituted value (if string) + remapped instanceId.
    for (const p of pattern.patternProps) {
      if (!subtreeIds.has(p.instanceId)) {
        throw new Error(`pattern.patternProps[].instanceId "${p.instanceId}" is not in pattern.subtree`);
      }
      const newValue = typeof p.value === "string"
        ? substituteInString(p.value, entry.vars)
        : p.value;
      outProps.push({
        instanceId: remap(p.instanceId),
        name: p.name,
        type: p.type,
        value: newValue,
      });
    }

    // Clone patternStyles.
    for (const s of pattern.patternStyles) {
      if (!subtreeIds.has(s.instanceId)) {
        throw new Error(`pattern.patternStyles[].instanceId "${s.instanceId}" is not in pattern.subtree`);
      }
      outStyles.push({
        instanceId: remap(s.instanceId),
        property: s.property,
        value: substituteStyleValue(s.value as StyleValue, entry.vars),
        breakpoint: s.breakpoint,
        state: s.state,
        listed: s.listed,
      });
    }

    // Clone patternBindings.
    for (const b of pattern.patternBindings) {
      if (!subtreeIds.has(b.instanceId)) {
        throw new Error(`pattern.patternBindings[].instanceId "${b.instanceId}" is not in pattern.subtree`);
      }
      outBindings.push({
        instanceId: remap(b.instanceId),
        propName: b.propName,
        binding: substituteBinding(b.binding as Binding, entry.vars),
        childIndex: b.childIndex,
      });
    }
  });

  return { instances: outInstances, props: outProps, styles: outStyles, bindings: outBindings };
}

/** Merge file content into the inline input. File fields take precedence on each array key. */
function mergeFromFile(input: Input): Input {
  if (!input.fromFile) return input;
  let raw: string;
  try {
    raw = readFileSync(input.fromFile, "utf8");
  } catch (err) {
    throw new Error(`fromFile read failed (${input.fromFile}): ${(err as Error).message}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`fromFile JSON parse failed (${input.fromFile}): ${(err as Error).message}`);
  }
  const merged: Record<string, unknown> = { ...input };
  for (const k of [
    "instances", "props", "styles", "dataSources", "useTokens",
    "cloudTokens", "bindings", "pattern",
  ]) {
    if (k in parsed) merged[k] = parsed[k];
  }
  // The merged object still needs to pass the schema — caller validates afterward.
  return merged as Input;
}

/** Apply a binding to either a prop or a text/expression child of a fragment instance.
 *  Mutates instances/props in place. Returns a short detail line. */
function applyBindingToFragment(
  instances: Input["instances"],
  props: Input["props"],
  entry: BindingEntry,
): string {
  const expression = bindingToExpression(entry.binding as Binding);
  const inst = instances.find((i) => i.id === entry.instanceId);
  if (!inst) {
    throw new Error(`bindings[].instanceId "${entry.instanceId}" not in instances (must be fragment-local)`);
  }

  if (entry.propName !== undefined) {
    const propIdx = props.findIndex(
      (p) => p.instanceId === entry.instanceId && p.name === entry.propName,
    );
    if (propIdx >= 0) {
      props[propIdx] = {
        instanceId: entry.instanceId,
        name: entry.propName,
        type: "expression",
        value: expression,
      };
      return `replace prop ${entry.instanceId}.${entry.propName} = ${expression}`;
    }
    props.push({
      instanceId: entry.instanceId,
      name: entry.propName,
      type: "expression",
      value: expression,
    });
    return `add prop ${entry.instanceId}.${entry.propName} = ${expression}`;
  }

  // Text child binding: replace the targeted text|expression child with an expression child.
  const targetSlot = entry.childIndex ?? 0;
  const childIdx = inst.children.reduce<number[]>((acc, c, i) => {
    if (c.type === "text" || c.type === "expression") acc.push(i);
    return acc;
  }, [])[targetSlot];
  const expressionChild: InstanceChild = { type: "expression", value: expression };
  if (childIdx === undefined) {
    if (targetSlot !== 0) {
      throw new Error(
        `bindings[]: instance "${entry.instanceId}" has no text/expression child at slot ${targetSlot}`,
      );
    }
    inst.children.push(expressionChild);
    return `add expression child on ${entry.instanceId} = ${expression}`;
  }
  inst.children[childIdx] = expressionChild;
  return `replace expression child on ${entry.instanceId}[${targetSlot}] = ${expression}`;
}

/** Validate that every dataSourceId referenced by bindings exists either in the fragment's
 *  own dataSources (we are pushing them now) or in the cloud build (pre-existing). */
function validateBindingRefs(
  bindings: BindingEntry[],
  fragmentDataSourceIds: Set<string>,
  buildDataSourceIds: Set<string>,
): string | null {
  const missing = new Set<string>();
  for (const b of bindings) {
    const binding = b.binding as Binding;
    if (binding.kind === "variable") {
      if (!fragmentDataSourceIds.has(binding.dataSourceId) && !buildDataSourceIds.has(binding.dataSourceId)) {
        missing.add(binding.dataSourceId);
      }
    } else if (binding.kind === "template") {
      for (const p of binding.parts) {
        if (p.type === "variable") {
          if (!fragmentDataSourceIds.has(p.dataSourceId) && !buildDataSourceIds.has(p.dataSourceId)) {
            missing.add(p.dataSourceId);
          }
        }
      }
    }
    // raw: opaque expression — can't validate ID refs reliably (could be encoded), so skip.
  }
  if (missing.size === 0) return null;
  return `dataSourceId(s) not found in fragment.dataSources nor in build.dataSources: ${[...missing].join(", ")}`;
}

/**
 * Pre-process tokens: expand shorthand styles, validate attachToInstances are fragment-local,
 * wrap single typed values on transition / animation longhands into layers[1], and auto-complete
 * missing transition / animation longhands so the Webstudio UI panels render correctly.
 *
 * Returns:
 *  - `expanded`: tokens with their styles normalized (post-coerce + post-completer)
 *  - `coerceHints`: pedagogical strings the caller should surface in the response
 *  - `coerceTelemetry`: events to fire via logCoerce after the push goes through
 */
function preprocessTokens(
  tokens: TokenInput[],
  fragmentInstanceIds: Set<string>,
  existingTokenNames: Set<string>,
):
  | { ok: true; expanded: Array<TokenInput>; coerceHints: string[]; coerceTelemetry: Array<{ key: string; extra?: Record<string, unknown> }> }
  | { ok: false; error: string } {
  const expanded: TokenInput[] = [];
  const coerceHints: string[] = [];
  const coerceTelemetry: Array<{ key: string; extra?: Record<string, unknown> }> = [];
  for (const t of tokens) {
    if (existingTokenNames.has(t.name)) {
      return {
        ok: false,
        error: `Token name "${t.name}" already exists in the project. push_complete creates fresh tokens — to extend an existing token, use webstudio_update_token_styles. To attach an existing token, use webstudio_apply_token.`,
      };
    }
    const expRes = expandStylesMap(t.styles as Record<string, StyleValue>);
    if (!expRes.ok) {
      return { ok: false, error: `token "${t.name}" styles: ${expRes.error}` };
    }
    for (const id of t.attachToInstances) {
      if (!fragmentInstanceIds.has(id)) {
        return {
          ok: false,
          error: `token "${t.name}".attachToInstances "${id}" is not a fragment-local instance. push_complete v1 only attaches to instances created in this push.`,
        };
      }
    }

    // Coerce single typed values on transition*/animation* longhands into layers[1] so the UI decodes them.
    const coercedMap: Record<string, StyleValue> = {};
    for (const [property, value] of Object.entries(expRes.styles)) {
      const meta = coerceStyleValueWithMeta(property, value as StyleValue);
      coercedMap[property] = meta.value;
      if (meta.telemetryKey) {
        coerceTelemetry.push({
          key: meta.telemetryKey,
          extra: { source: "build.push_complete", property, sourceType: (value as StyleValue).type, tokenName: t.name },
        });
        if (meta.hint) coerceHints.push(`token "${t.name}" → ${meta.hint}`);
      }
    }

    // Auto-complete missing transition*/animation* longhands so all layers render in the UI panel.
    const incoming = Object.entries(coercedMap).map(([property, value]) => ({ property, value }));
    const completed = completeTransitionAnimationLonghands([], incoming);
    const incomingProps = new Set(Object.keys(coercedMap));
    const finalMap: Record<string, StyleValue> = {};
    const addedTransition: string[] = [];
    const addedAnimation: string[] = [];
    for (const d of completed) {
      finalMap[d.property] = d.value;
      if (!incomingProps.has(d.property)) {
        if (TRANSITION_LONGHANDS_SET.has(d.property)) addedTransition.push(d.property);
        else if (ANIMATION_LONGHANDS_SET.has(d.property)) addedAnimation.push(d.property);
      }
    }
    if (addedTransition.length > 0) {
      coerceTelemetry.push({
        key: "coerce:completeTransitionLonghands",
        extra: { source: "build.push_complete", tokenName: t.name, added: addedTransition },
      });
      coerceHints.push(
        `token "${t.name}": missing transition longhand(s) ${addedTransition.join(", ")} auto-completed with CSS defaults (ease, 0ms, normal) at matching layer count so the Webstudio Transition panel renders all layers. Push the 5 longhands explicitly to silence this hint.`,
      );
    }
    if (addedAnimation.length > 0) {
      coerceTelemetry.push({
        key: "coerce:completeAnimationLonghands",
        extra: { source: "build.push_complete", tokenName: t.name, added: addedAnimation },
      });
      coerceHints.push(
        `token "${t.name}": missing animation longhand(s) ${addedAnimation.join(", ")} auto-completed with CSS defaults at matching layer count. Push the 8 longhands explicitly to silence this hint.`,
      );
    }

    expanded.push({ ...t, styles: finalMap });
  }
  return { ok: true, expanded, coerceHints, coerceTelemetry };
}

// ── Main handler ────────────────────────────────────────────────────────────

export const pushCompleteTool: ToolModule = {
  definition: {
    name: "webstudio_push_complete",
    description: `Use when: push a full section (instances + props + styles + dataSources) AND create/attach tokens AND apply expression bindings AND optionally expand a repeated subtree — all in ONE atomic transaction.
Do NOT use when: pushing just a fragment with no tokens/bindings (use webstudio_push_fragment), or attaching a token to instances that ALREADY exist in cloud (use webstudio_apply_token).
Returns: dry-run report with the planned transaction summary, OR push result with finalVersion. Same two-stage protocol as push_fragment (dryRun true then dryRun false + forceConfirmed true).
Side effects: push to Webstudio Cloud (requires allowPush).

The key combos handled inline:
  - tokens[] with attachToInstances → creates token styleSource AND inserts selections in the same transaction. attachToInstances must reference instances listed in the \`instances\` array.
  - bindings[] → inject expression-typed props (or expression text children) on fragment instances. instanceId must be fragment-local. propName absent → text binding (replaces first text/expression child).
  - pattern.repeat → expand subtree+patternProps+patternStyles+patternBindings N times with {{var}} substitution. Each clone's id becomes \`<idPrefix><origId>-<idSuffix>\` (idSuffix defaults to 1..N).
  - fromFile → read the whole payload from a JSON file on disk. File fields override inline arrays.

Pre-flight: token shorthand boundary (same guard as create_tokens), dataSourceId ref validation, Radix wrapper safety. If any check fails, the whole transaction is rolled back (never sent).

Example (footer column with 3 links, 1 token attached): { projectSlug:"my-site", pushTo:{projectSlug:"my-site",parentInstanceId:"footer-row",dryRun:true}, instances:[{id:"col-1",component:"ws:element",tag:"div",label:"Col"},{id:"head-1",component:"ws:element",tag:"h3",parentId:"col-1",label:"Heading",children:[{type:"text",value:"Quads"}]}], cloudTokens:[{name:"Footer Link",styles:{color:{type:"keyword",value:"white"}},attachToInstances:["head-1"]}], pattern:{ subtree:[{id:"link-tpl",component:"ws:element",tag:"a",parentId:"col-1",children:[{type:"text",value:"{{label}}"}]}], patternProps:[{instanceId:"link-tpl",name:"href",type:"string",value:"{{href}}"}], idPrefix:"link-", repeat:[{idSuffix:"1",vars:{label:"700cc",href:"/quad/700"}},{idSuffix:"2",vars:{label:"800cc",href:"/quad/800"}}] }, bindings:[{instanceId:"head-1",binding:{kind:"variable",dataSourceId:"ds_section_title"}}] }`,
    inputSchema: {
      type: "object",
      properties: {
        instances: { type: "array", description: "Fragment instances (same shape as push_fragment)." },
        props: { type: "array" },
        styles: { type: "array" },
        dataSources: { type: "array" },
        useTokens: { type: "array", description: "⚠️ Consumes the LOCAL registry (~/.webstudio-mcp/projects/<slug>/tokens.json), NOT the cloud. DO NOT use to reference a token that ALREADY EXISTS in Webstudio Cloud — silently duplicates it (refused since v2.7.6). To attach an existing cloud token, use tokens.attach_token({tokenName} or {tokenId}) AFTER this push. For new tokens with attachments in one call, use cloudTokens instead. See pattern tokens-cloud-vs-local." },
        tokens: { type: "array", description: "In-fragment tokens (legacy shape from push_fragment). For cloud-aware tokens with attachToInstances, use `cloudTokens` instead." },
        projectSlug: { type: "string" },
        pushTo: {
          type: "object",
          properties: {
            projectSlug: { type: "string" },
            parentInstanceId: { type: "string" },
            pageId: { type: "string" },
            dryRun: { type: "boolean" },
            forceConfirmed: { type: "boolean" },
            insertIndex: { type: "number" },
            ignoreWrapperWarning: { type: "boolean" },
          },
          required: ["projectSlug"],
        },
        replace: {
          type: "object",
          properties: {
            labels: { type: "array", items: { type: "string" } },
            componentMatch: { type: "string" },
          },
          required: ["labels"],
        },
        fromFile: { type: "string", description: "Absolute path to a JSON file with {instances?,props?,styles?,dataSources?,useTokens?,cloudTokens?,bindings?,pattern?}. File fields override inline arrays." },
        cloudTokens: {
          type: "array",
          description: "Tokens to CREATE and (optionally) attach to fragment instances in the same transaction. Schema: {name, styles, attachToInstances?}. Token name must not already exist in the project.",
        },
        bindings: {
          type: "array",
          description: "Inline bindings on fragment instances. {instanceId, propName?, binding, childIndex?}. propName set = prop binding; propName absent = replace first text/expression child of the instance.",
        },
        pattern: {
          type: "object",
          description: "Repeat a subtree template N times. {subtree, patternProps?, patternStyles?, patternBindings?, idPrefix?, repeat:[{idSuffix?, vars:{...}}]}. {{key}} placeholders in children.value, prop.value (string), instance.label, unparsed StyleValue, and bindings get substituted per repeat entry.",
        },
      },
      required: ["pushTo"],
      additionalProperties: false,
    },
    annotations: {
      title: "Push complete section to Webstudio",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (rawArgs) => {
    // First parse: validate the raw shape.
    const firstParse = pushCompleteInputSchema.safeParse(rawArgs);
    if (!firstParse.success) {
      return errorResult("VALIDATION_FAILED", `Validation error: ${firstParse.error.message}`);
    }
    let input = firstParse.data;

    // Merge fromFile into the input then re-validate (file fields could be malformed).
    try { input = mergeFromFile(input); }
    catch (err) { return errorResult("VALIDATION_FAILED", (err as Error).message); }
    if (input.fromFile) {
      const reParse = pushCompleteInputSchema.safeParse(input);
      if (!reParse.success) {
        return errorResult("VALIDATION_FAILED", `Post-fromFile validation error: ${reParse.error.message}`);
      }
      input = reParse.data;
    }

    const { pushTo, replace, fromFile: _f, cloudTokens, bindings, pattern, ...buildArgsBase } = input;
    void _f;
    const isDryRun = pushTo.dryRun === true;

    if (!isDryRun && pushTo.forceConfirmed !== true) {
      return errorResult(
        "VALIDATION_FAILED",
        "Two-stage push protocol required. Run with dryRun:true first to read the server-reported project name, get explicit user confirmation, then re-call with dryRun:false AND forceConfirmed:true.",
      );
    }

    // Expand pattern.repeat into the working arrays BEFORE everything else.
    let workingInstances = [...buildArgsBase.instances];
    let workingProps = [...buildArgsBase.props];
    let workingStyles = [...buildArgsBase.styles];
    let workingBindings = [...bindings];
    if (pattern) {
      try {
        const expanded = expandPattern(pattern, workingInstances, workingProps, workingStyles, workingBindings);
        workingInstances = expanded.instances;
        workingProps = expanded.props;
        workingStyles = expanded.styles;
        workingBindings = expanded.bindings;
      } catch (err) {
        return errorResult("VALIDATION_FAILED", `pattern expansion: ${(err as Error).message}`);
      }
    }

    // Apply bindings as fragment-payload mutations (no separate post-push patches).
    // Each `raw` binding is linted against Webstudio's allowlist first (see lib/lint-expression):
    // error = unparseable → refuse; warning = runs at runtime but the editor flags it → educate.
    const bindingDetails: string[] = [];
    const bindingLintHints: string[] = [];
    try {
      for (const b of workingBindings) {
        const where = `${b.instanceId}${b.propName ? "." + b.propName : ""}`;
        const lint = lintBinding(b.binding as Binding);
        if (lint?.severity === "error") {
          return errorResult("EXPRESSION_INVALID", `binding ${where}: ${lint.message}`, lint.hint);
        }
        if (lint?.severity === "warning") {
          void logCoerce(lint.telemetryKey, {
            source: "build.push_complete",
            projectSlug: pushTo.projectSlug,
            instanceId: b.instanceId,
            propName: b.propName,
            violations: lint.violations.map((v) => `${v.type}:${v.detail}`),
          });
          bindingLintHints.push(`binding ${where} → ${lint.hint}`);
        }
        bindingDetails.push(applyBindingToFragment(workingInstances, workingProps, b));
      }
    } catch (err) {
      return errorResult("VALIDATION_FAILED", `binding: ${(err as Error).message}`);
    }

    // Auth + fetch build.
    let auth;
    try { auth = isDryRun ? requireAuth(pushTo.projectSlug) : requirePushAuth(pushTo.projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    // Validate dataSourceId refs against fragment + build dataSources.
    const fragmentDataSourceIds = new Set(buildArgsBase.dataSources.map((d) => d.id));
    const buildDataSourceIds = new Set(
      ((build as unknown as { dataSources?: Array<{ id: string }> }).dataSources ?? []).map((d) => d.id),
    );
    const refError = validateBindingRefs(workingBindings, fragmentDataSourceIds, buildDataSourceIds);
    if (refError) return errorResult("VARIABLE_NOT_FOUND", refError);

    // Pre-process cloud tokens: expand shorthands, check name conflicts, check attachToInstances are fragment-local.
    const fragmentInstanceIds = new Set(workingInstances.map((i) => i.id));
    const existingTokenNames = new Set(
      (build.styleSources as Array<{ type: string; name?: string }>)
        .filter((s) => s.type === "token" && typeof s.name === "string")
        .map((s) => s.name!),
    );
    const tokensRes = preprocessTokens(cloudTokens, fragmentInstanceIds, existingTokenNames);
    if (!tokensRes.ok) {
      return errorResult("VALIDATION_FAILED", tokensRes.error);
    }
    const expandedTokens = tokensRes.expanded;
    // Fire telemetry for silent coercions emitted by preprocessTokens (composedSingleToLayers,
    // completeTransitionLonghands, completeAnimationLonghands). No-op when WEBSTUDIO_MCP_TELEMETRY≠1.
    for (const ev of tokensRes.coerceTelemetry) {
      void logCoerce(ev.key, { ...ev.extra, projectSlug: pushTo.projectSlug });
    }
    const tokenCoerceHints = [...new Set(tokensRes.coerceHints)];
    const tokenHintBlock = tokenCoerceHints.length > 0
      ? `\n\n[hints]\n${tokenCoerceHints.map((h) => `- ${h}`).join("\n")}`
      : "";
    const bindingHintBlock = bindingLintHints.length > 0
      ? `\n\n[expression warnings]\n${bindingLintHints.map((h) => `- ${h}`).join("\n")}`
      : "";

    // Pre-flight (v2.7.6): refuse `useTokens` whose tokenSlug matches an existing
    // cloud token by name-normalized. `useTokens` consumes the LOCAL registry
    // (~/.webstudio-mcp/projects/<slug>/tokens.json) — if a homonym already
    // exists in cloud, Webstudio creates a silent duplicate (no error, no warning).
    // See pattern tokens-cloud-vs-local for full diagnostic + fix workflow.
    // a production site incident 2026-05-22: "Titre H1" / "Body M" silently duplicated.
    const useTokensInput = buildArgsBase.useTokens ?? [];
    if (useTokensInput.length > 0) {
      const normalize = (s: string) => s.toLowerCase().trim().replace(/[\s_]+/g, "-");
      const cloudByNormName = new Map<string, { id: string; name: string }>();
      for (const s of build.styleSources as Array<{ type: string; id: string; name?: string }>) {
        if (s.type === "token" && typeof s.name === "string") {
          cloudByNormName.set(normalize(s.name), { id: s.id, name: s.name });
        }
      }
      const conflicts: Array<{ slug: string; cloudName: string; cloudId: string }> = [];
      for (const u of useTokensInput) {
        const match = cloudByNormName.get(normalize(u.tokenSlug));
        if (match) {
          conflicts.push({ slug: u.tokenSlug, cloudName: match.name, cloudId: match.id });
        }
      }
      if (conflicts.length > 0) {
        // Telemetry: one event per conflict (so the report aggregates by usage scale).
        for (const c of conflicts) {
          void logCoerce("coerce:useTokens-duplicate-blocked", {
            source: "build.push_complete",
            projectSlug: buildArgsBase.projectSlug,
            slug: c.slug,
            cloudName: c.cloudName,
          });
        }
        const conflictLines = conflicts.map(
          (c) => `  - useTokens slug "${c.slug}" matches existing cloud token "${c.cloudName}" (id: ${c.cloudId})`,
        );
        return errorResult(
          "VALIDATION_FAILED",
          `useTokens would silently duplicate ${conflicts.length} existing cloud token(s):\n${conflictLines.join("\n")}\n\n` +
            `useTokens consumes the LOCAL registry (~/.webstudio-mcp/projects/<slug>/tokens.json), not the cloud. ` +
            `Pushing matching slugs creates duplicated cloud tokens (visually identical name but distinct ids → broken DS unicity).\n\n` +
            `Use one of:\n` +
            `  • tokens.attach_token({ tokenName: "<exact name>" or tokenId: "<short id>", instanceIds: [...] }) ` +
            `to attach the EXISTING cloud token to instances.\n` +
            `  • build.push_complete with cloudTokens:[{ name: "<unique name>", ... }] ` +
            `if you really want to create a NEW token (then verify the name isn't already in use).\n\n` +
            `See pattern: meta.describe_pattern({pattern:"tokens-cloud-vs-local"})`,
        );
      }
    }

    // Build the fragment via buildFromArgs (already handles shorthand+coerce on styles).
    // We pass the standard fields (instances/props/styles/dataSources/useTokens/projectSlug,
    // plus any in-fragment `tokens` from BuildFragmentSchema). Then we manually inject the
    // cloudTokens via the builder's addToken/applyToken so we can record their ids.
    const buildArgs: BuildArgs = {
      instances: workingInstances,
      props: workingProps,
      styles: workingStyles,
      dataSources: buildArgsBase.dataSources,
      useTokens: buildArgsBase.useTokens,
      projectSlug: buildArgsBase.projectSlug,
      tokens: buildArgsBase.tokens,
    };

    let builder;
    try { builder = buildFromArgs(buildArgs); }
    catch (err) { return errorResult("VALIDATION_FAILED", `Build error: ${(err as Error).message}`); }

    // Inject cloudTokens into the in-fragment builder. Token styleSource ends up in the
    // fragment payload alongside its attachments — atomic with the rest of the push.
    const tokenDetails: string[] = [];
    for (const t of expandedTokens) {
      const tokenId = builder.addToken(t.name, t.styles as Record<string, StyleValue>);
      for (const instanceId of t.attachToInstances) {
        builder.applyToken(instanceId, tokenId);
      }
      tokenDetails.push(`+ token "${t.name}" → ${t.attachToInstances.length} attach(es)`);
    }

    const fragment = builder.build();

    // Coerce raw <img> instances to the native Image component (v2.18.0 —
    // covers the assembled fragment incl. expanded pattern.repeat subtrees).
    const imgCoerce = coerceRawImgInstances(fragment["@webstudio/instance/v0.1"].instances);
    if (imgCoerce.count > 0) {
      void logCoerce(imgCoerce.telemetryKey!, {
        source: "build.push_complete",
        projectSlug: input.projectSlug,
        count: imgCoerce.count,
      });
    }
    const payload0 = fragment["@webstudio/instance/v0.1"];
    const videoCoerce = coerceRawVideoInstances(payload0.instances, payload0.props);
    const showLint = lintShowBindingProps(payload0.props);
    for (const t of [...videoCoerce.telemetry, ...showLint.telemetry]) {
      void logCoerce(t.key, { source: "build.push_complete", projectSlug: input.projectSlug, count: t.count });
    }
    const allHints = [
      ...(imgCoerce.hint ? [imgCoerce.hint] : []),
      ...videoCoerce.hints,
      ...showLint.hints,
    ];
    const imgHint = allHints.length > 0 ? `\n\n⚠ ${allHints.join("\n⚠ ")}` : "";

    // Pre-flight: refuse class/style/id props on Radix non-rendering wrappers.
    if (!pushTo.ignoreWrapperWarning) {
      const payload = fragment["@webstudio/instance/v0.1"];
      const instById = new Map(payload.instances.map((i) => [i.id, i]));
      const errors: string[] = [];
      for (const p of payload.props) {
        const inst = instById.get(p.instanceId);
        if (!inst) continue;
        const check = assertSafeRadixProp(inst.component, p.name);
        if (!check.ok) {
          errors.push(
            `prop "${p.name}" on ${inst.component.split(":").pop()} "${inst.label ?? inst.id}":\n  ${check.reason}\n  → ${check.hint}`,
          );
        }
      }
      if (errors.length > 0) {
        return errorResult(
          "RADIX_TRIGGER_POLLUTION",
          `${errors.length} prop pollution(s) in fragment:\n\n${errors.join("\n\n")}\n\nMove the prop(s) to the rendering child, or pass pushTo.ignoreWrapperWarning=true.`,
        );
      }
    }

    const resolveParent = (b: typeof build): string => {
      if (pushTo.parentInstanceId) return pushTo.parentInstanceId;
      const targetPageId = pushTo.pageId ?? b.pages.homePageId;
      const page = b.pages.pages.find((p) => p.id === targetPageId);
      if (!page) throw new Error(`Page ${targetPageId} not found`);
      return page.rootInstanceId;
    };

    let parentId: string;
    try { parentId = resolveParent(build); }
    catch (err) {
      const msg = (err as Error).message;
      if (/Page .* not found/.test(msg)) return errorResult("PAGE_NOT_FOUND", msg);
      return errorResult("INTERNAL_ERROR", msg);
    }

    const buildFullTransaction = (cur: typeof build, pid: string): BuildPatchTransaction => {
      const baseTx = fragmentToTransaction(fragment, cur, {
        parentInstanceId: pid,
        insertIndex: pushTo.insertIndex,
      });
      if (!replace) return baseTx;
      const targets = findReplaceTargets(cur, pid, replace.labels, replace.componentMatch);
      if (targets.length === 0) return baseTx;
      const cleanupChanges = buildInstanceRemovalChanges(cur, targets);
      const instCleanup = cleanupChanges.find((c) => c.namespace === "instances");
      if (instCleanup) instCleanup.patches.unshift(buildParentChildrenPatch(cur, pid, targets));
      const merged: BuildPatchChange[] = [];
      const seen = new Set<string>();
      for (const c of cleanupChanges) {
        const fragChange = baseTx.payload.find((bc) => bc.namespace === c.namespace);
        if (fragChange) merged.push({ namespace: c.namespace, patches: [...c.patches, ...fragChange.patches] });
        else merged.push(c);
        seen.add(c.namespace);
      }
      for (const bc of baseTx.payload) {
        if (!seen.has(bc.namespace)) merged.push(bc);
      }
      return { id: baseTx.id, payload: merged };
    };

    let transaction: BuildPatchTransaction;
    try { transaction = buildFullTransaction(build, parentId); }
    catch (err) { return errorResult("INTERNAL_ERROR", `Transaction generation failed: ${(err as Error).message}`); }

    const projectTitle = build.project?.title ?? "(title unavailable)";
    const summary = transaction.payload.map((c) => `  - ${c.namespace}: ${c.patches.length} patches`).join("\n");
    const tokensSummary = tokenDetails.length > 0 ? `\nTokens:\n  ${tokenDetails.join("\n  ")}` : "";
    const bindingsSummary = bindingDetails.length > 0 ? `\nBindings:\n  ${bindingDetails.join("\n  ")}` : "";
    const patternSummary = pattern ? `\nPattern: subtree×${pattern.subtree.length} × repeat×${pattern.repeat.length}` : "";

    if (isDryRun) {
      // Stage the post-fromFile-merge input (fromFile stripped: the merge
      // already happened, so the confirm replays EXACTLY what was previewed
      // even if the file changes meanwhile) — see lib/push-stage.ts (v2.21.1).
      const { fromFile: _omitFromFile, ...stagedInput } = input;
      void _omitFromFile;
      const stageId = stagePush("push_complete", pushTo.projectSlug, stagedInput as Record<string, unknown>);
      return textResult(`DRY-RUN push_complete

Target:
  projectSlug: ${pushTo.projectSlug}
  projectId: ${auth.projectId}
  Real name: ${projectTitle}
  parentInstanceId: ${parentId}

Fragment: ${fragment["@webstudio/instance/v0.1"].instances.length} instance(s), build version ${build.version}
Transaction: ${transaction.payload.length} namespaces
${summary}${tokensSummary}${bindingsSummary}${patternSummary}

If OK: build.push_staged({stageId:"${stageId}"}) pushes exactly this (single-use, 10 min) — or re-run with dryRun=false AND forceConfirmed=true.${tokenHintBlock}${bindingHintBlock}`);
    }

    try {
      const { result, finalVersion, appVersionUpdated } = await pushWithRetry(auth, (cur) => {
        const pid = resolveParent(cur);
        return buildFullTransaction(cur, pid);
      });
      if (appVersionUpdated) saveAuth(pushTo.projectSlug, auth);
      const refreshMsg = appVersionUpdated
        ? `\nappVersion auto-refreshed → ${appVersionUpdated.slice(0, 12)}…`
        : "";
      return textResult(`push_complete to "${projectTitle}" (slug: ${pushTo.projectSlug})
${fragment["@webstudio/instance/v0.1"].instances.length} instance(s) — version → ${finalVersion}
status: ${result.status}${refreshMsg}${tokensSummary}${bindingsSummary}${patternSummary}${tokenHintBlock}${bindingHintBlock}`);
    } catch (err) {
      return runtimeErrorResult(err, "Push failed");
    }
  },
};

// ── Pure helpers exported for testing ───────────────────────────────────────
//
// Tests import these to validate pattern expansion, binding application, and
// token preprocessing WITHOUT touching the network. The handler above wires
// them together with fetchBuild + pushWithRetry.

export const _pure = {
  expandPattern,
  applyBindingToFragment,
  validateBindingRefs,
  preprocessTokens,
  substituteInString,
  mergeFromFile,
};
