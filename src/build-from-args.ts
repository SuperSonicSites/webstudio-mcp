// Zod schemas and the buildFromArgs helper, shared between webstudio_build_fragment and webstudio_push_fragment.

import { z } from "zod";
import { FragmentBuilder } from "./builder.js";
import type { StyleValue, BreakpointId } from "./types.js";
import {
  coerceStyleValue,
  assertValidStyleValue,
  applyListedDefault,
  completeTransitionAnimationLonghands,
} from "./lib/style-coerce.js";
import { expandShorthand } from "./lib/expand-shorthand.js";
import { resolveStateForWrite } from "./lib/state-whitelist.js";
import { logCoerce } from "./lib/telemetry.js";

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
import { encodeExpressionRefs } from "./utils/expression-encoding.js";

export const StyleValueSchema: z.ZodType<StyleValue> = z.lazy(() => z.union([
  z.object({ type: z.literal("unit"), value: z.number(), unit: z.string() }),
  z.object({ type: z.literal("keyword"), value: z.string() }),
  z.object({
    type: z.literal("color"),
    colorSpace: z.enum(["hex", "rgb", "hsl", "lab", "lch", "oklab", "oklch"]),
    components: z.array(z.number()),
    alpha: z.number(),
  }),
  z.object({ type: z.literal("var"), value: z.string(), fallback: StyleValueSchema.optional() }),
  z.object({ type: z.literal("unparsed"), value: z.string() }),
  z.object({ type: z.literal("fontFamily"), value: z.array(z.string()) }),
  z.object({
    type: z.literal("image"),
    value: z.union([
      z.object({ type: z.literal("asset"), value: z.string() }),
      z.object({ type: z.literal("url"), url: z.string() }),
    ]),
  }),
  z.object({ type: z.literal("layers"), value: z.array(StyleValueSchema) }),
  // Tuple = ordered list of values (used for transform args, transition longhand layers, etc.).
  z.object({ type: z.literal("tuple"), value: z.array(StyleValueSchema) }),
  // Function = single CSS function call (blur(...), translate(...), drop-shadow(...), ...). Args are a tuple.
  z.object({ type: z.literal("function"), name: z.string(), args: StyleValueSchema }),
  z.object({
    type: z.literal("shadow"),
    position: z.enum(["outset", "inset"]),
    offsetX: StyleValueSchema,
    offsetY: StyleValueSchema,
    blur: StyleValueSchema,
    spread: StyleValueSchema,
    color: StyleValueSchema,
  }),
]));

// Wire-only stand-in for StyleValueSchema (v2.20.3). zod-to-json-schema
// inlines the 11-variant recursive union (~2.4 kB) at every ADVERTISED use
// site — and recursive refs degrade to {} anyway, so the advertised union was
// already lossy. Tools pass this to the schema builder while their RUNTIME
// parse keeps the real StyleValueSchema (sub-handlers re-validate strictly).
export const StyleValueWireSchema = z.record(z.string(), z.unknown()).describe(
  'StyleValue object — e.g. {type:"unit",value:6,unit:"rem"}, {type:"keyword",value:"red"}, {type:"var",value:"--x"}. Any raw CSS string: {type:"unparsed",value:"<css>"} (coerced server-side).',
);

export const BuildFragmentSchema = z.object({
  instances: z.array(z.object({
    id: z.string(),
    component: z.string(),
    tag: z.string().optional(),
    label: z.string().optional(),
    parentId: z.string().optional(),
    children: z.array(z.union([
      z.object({ type: z.literal("text"), value: z.string() }),
      z.object({ type: z.literal("expression"), value: z.string() }),
    ])).default([]),
  })),
  props: z.array(z.object({
    instanceId: z.string(),
    name: z.string(),
    type: z.enum(["string", "boolean", "number", "expression", "json", "asset", "page", "string[]", "parameter", "resource", "action", "animationAction"]),
    value: z.unknown(),
  })).default([]),
  styles: z.array(z.object({
    instanceId: z.string(),
    property: z.string(),
    value: StyleValueSchema,
    breakpoint: z.enum(["base", "tablet", "mobile-landscape", "mobile-portrait"]).default("base"),
    state: z.string().optional(),
    /** For CSS custom properties (--foo): listed=true makes them visible in the Webstudio Styles panel. */
    listed: z.boolean().optional(),
  })).default([]),
  tokens: z.array(z.object({
    name: z.string(),
    styles: z.record(z.string(), StyleValueSchema),
  })).default([]),
  projectSlug: z.string().optional(),
  useTokens: z.array(z.object({
    instanceId: z.string(),
    tokenSlug: z.string(),
  })).default([]).describe(
    "Consumes the LOCAL token registry. ⚠️ NEVER for tokens already in the cloud (silent duplicate; " +
    "refused when the slug matches) — use tokens.attach_token instead. See pattern tokens-cloud-vs-local.",
  ),
  /**
   * Raw dataSource entries pushed alongside instances/props/styles. Required to
   * push a `ws:collection` whose `item` prop references a `parameter`
   * dataSource (the runtime-injected per-iteration variable). Atomic with the
   * rest of the fragment — same transaction = no orphans.
   *
   * `variable` entries carry an initial value object; `parameter` entries do
   * NOT (the parent component injects the value at render time). See
   * `docs/patterns/ws-collection-bindings.md` for the full recipe.
   */
  dataSources: z.array(z.discriminatedUnion("type", [
    z.object({
      type: z.literal("variable"),
      id: z.string(),
      scopeInstanceId: z.string(),
      name: z.string(),
      value: z.object({
        type: z.enum(["string", "number", "boolean", "json"]),
        value: z.unknown(),
      }),
    }),
    z.object({
      type: z.literal("parameter"),
      id: z.string(),
      scopeInstanceId: z.string(),
      name: z.string(),
    }),
  ])).default([]),
});

export type BuildArgs = z.infer<typeof BuildFragmentSchema>;

export function buildFromArgs(args: BuildArgs): FragmentBuilder {
  const { instances, props, styles, tokens, projectSlug, useTokens, dataSources } = args;
  const builder = new FragmentBuilder();

  if (projectSlug) builder.loadProject(projectSlug);

  for (const token of tokens) {
    builder.addToken(token.name, token.styles as Record<string, StyleValue>);
  }

  for (const inst of instances) {
    const children = inst.children.map((c) =>
      c.type === "text"
        ? { type: "text" as const, value: c.value }
        // Auto-encode `-` → `__DASH__` in dataSourceId refs (idempotent).
        : { type: "expression" as const, value: encodeExpressionRefs(c.value) },
    );
    builder.addInstance(inst.component, {
      id: inst.id,
      tag: inst.tag,
      label: inst.label,
      children,
      parentId: inst.parentId,
    });
  }

  for (const prop of props) {
    // Auto-encode dataSourceId refs in expression-typed props (idempotent).
    const value =
      prop.type === "expression" && typeof prop.value === "string"
        ? encodeExpressionRefs(prop.value)
        : prop.value;
    builder.addProp(prop.instanceId, prop.name, prop.type as never, value);
  }

  // Phase 1: expand shorthands, validate, coerce. Collect decls grouped by (instance, bp, state)
  // so the transition*/animation* longhand completer can synthesize missing longhands per cohort
  // before flushing to the builder. Otherwise, callers pushing only 2 of the 5 transition longhands
  // would push an incomplete cohort that the Webstudio UI overrides with CSS defaults.
  type CollectedDecl = {
    instanceId: string;
    breakpoint: BreakpointId;
    state: string | undefined;
    property: string;
    value: StyleValue;
    listed: boolean | undefined;
  };
  const collected: CollectedDecl[] = [];
  for (const style of styles) {
    // Normalize `state` to its canonical selector form (":hover", "::before"): a bare
    // "hover" would be stored as a dead state that never triggers at runtime. Recoverable
    // forms are coerced (telemetry only — parity with the longhand completer below, no
    // textual hint is threaded out of this pure builder); unrecoverable ones throw.
    // See lib/state-whitelist.ts + pattern state-selector-format.
    const sr = resolveStateForWrite(style.state);
    if (!sr.ok) {
      throw new Error(`Invalid state on ${style.instanceId}.${style.property}: ${sr.error}`);
    }
    if (sr.hint) {
      void logCoerce(sr.telemetryKey, { source: "build.from_args", instanceId: style.instanceId, property: style.property, from: sr.from, to: sr.state, reason: sr.reason });
    }
    // Pre-flight: expand CSS shorthands (flex, padding, margin, ...) into longhand decls.
    // Shorthand-as-unparsed crashes Webstudio at publish time. See lib/expand-shorthand.ts.
    const exp = expandShorthand(style.property, style.value as StyleValue);
    if (exp.kind === "error") {
      throw new Error(`Invalid shorthand on ${style.instanceId}.${style.property}: ${exp.message}`);
    }
    const decls = exp.kind === "ok"
      ? exp.decls
      : [{ property: style.property, value: style.value as StyleValue }];

    for (const d of decls) {
      // Validate shadow properties + transform:function(var) — Webstudio Cloud silently drops
      // certain shapes. See lib/style-coerce.ts § validateStyleValue.
      assertValidStyleValue(d.property, d.value);
      // Auto-coerce tuple/function shapes (incl. transition*/animation* single typed values → layers[1])
      // so the Webstudio UI panel decodes them. See lib/style-coerce.ts § coerceStyleValue.
      const coercedValue = coerceStyleValue(d.property, d.value);
      collected.push({
        instanceId: style.instanceId,
        breakpoint: (style.breakpoint ?? "base") as BreakpointId,
        state: sr.state,
        property: d.property,
        value: coercedValue,
        listed: applyListedDefault(d.property, style.listed),
      });
    }
  }

  // Phase 2: group by (instance, bp, state), apply transition*/animation* longhand completer
  // (existing=[] because this is an offline build with no prior cloud state for the cohort).
  const cohorts = new Map<string, CollectedDecl[]>();
  for (const c of collected) {
    const key = `${c.instanceId}::${c.breakpoint}::${c.state ?? ""}`;
    let arr = cohorts.get(key);
    if (!arr) { arr = []; cohorts.set(key, arr); }
    arr.push(c);
  }
  for (const group of cohorts.values()) {
    const incoming = group.map((g) => ({ property: g.property, value: g.value }));
    const completed = completeTransitionAnimationLonghands([], incoming);
    const incomingProps = new Set(incoming.map((d) => d.property));
    const ref = group[0]!;
    for (const d of completed) {
      const existing = group.find((g) => g.property === d.property);
      if (existing) {
        // The completer may have upgraded a `layers[1]` to `layers[N]` with default fills.
        existing.value = d.value;
        builder.addStyle(existing.instanceId, existing.property, existing.value, existing.breakpoint, existing.state, existing.listed);
      } else {
        // Synthesized longhand (was missing from the incoming batch).
        builder.addStyle(ref.instanceId, d.property, d.value, ref.breakpoint, ref.state, applyListedDefault(d.property, undefined));
      }
    }
    // Telemetry: log the synthesized longhands (no-op when WEBSTUDIO_MCP_TELEMETRY≠1).
    const transitionAdded = completed.filter((d) => !incomingProps.has(d.property) && TRANSITION_LONGHANDS_SET.has(d.property)).map((d) => d.property);
    const animationAdded = completed.filter((d) => !incomingProps.has(d.property) && ANIMATION_LONGHANDS_SET.has(d.property)).map((d) => d.property);
    if (transitionAdded.length > 0) {
      void logCoerce("coerce:completeTransitionLonghands", { source: "build.from_args", instanceId: ref.instanceId, breakpoint: ref.breakpoint, state: ref.state, added: transitionAdded });
    }
    if (animationAdded.length > 0) {
      void logCoerce("coerce:completeAnimationLonghands", { source: "build.from_args", instanceId: ref.instanceId, breakpoint: ref.breakpoint, state: ref.state, added: animationAdded });
    }
  }

  if (useTokens.length > 0) {
    if (!projectSlug) {
      throw new Error(`useTokens provided without projectSlug.`);
    }
    for (const usage of useTokens) {
      builder.useToken(usage.instanceId, usage.tokenSlug);
    }
  }

  for (const ds of dataSources) {
    // Cast through DataSource: Zod's z.unknown() infers the optional shape
    // `{ value?: unknown }`, but our runtime DataSource type marks `value`
    // required. The discriminated union guarantees structural correctness.
    builder.addRawDataSource(ds as never);
  }

  return builder;
}
