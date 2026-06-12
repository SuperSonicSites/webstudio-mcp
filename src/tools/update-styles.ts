// Tool: webstudio_styles — surgical patch on existing instance styles.
// Avoids re-pushing a whole fragment just to tweak a color or size.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { StyleValueSchema, StyleValueWireSchema } from "../build-from-args.js";
import { requireAuth, requirePushAuth } from "../auth.js";
import { fetchBuild, pushWithRetry } from "../webstudio-client.js";
import { buildUpdateStylesTransaction, type StyleUpdate } from "./update-styles/build-patches.js";
import { coerceStyleValue, validateStyleValue, applyListedDefault } from "../lib/style-coerce.js";
import { expandShorthand, coerceGridChildLonghand, coerceAspectRatio, detectManualSingleCellPattern } from "../lib/expand-shorthand.js";
import { resolveStateForWrite } from "../lib/state-whitelist.js";
import { logCoerce } from "../lib/telemetry.js";

const StyleUpdateSchema = z.object({
  instanceId: z.string(),
  property: z.string(),
  value: StyleValueSchema,
  breakpoint: z.string().default("base"),
  state: z.string().optional(),
  listed: z.boolean().optional(),
  createLocalIfMissing: z.boolean().default(false),
  ignoreWrapperWarning: z.boolean().default(false),
}).strict();

export const updateStylesInputSchema = z.object({
  projectSlug: z.string(),
  updates: z.array(StyleUpdateSchema).min(1),
  dryRun: z.boolean().default(true),
}).strict();

// Advertised (wire) variant: compact StyleValue stand-in instead of the
// inlined 11-variant union. Runtime stays on updateStylesInputSchema — the
// handler's safeParse re-validates every update strictly.
export const updateStylesWireSchema = updateStylesInputSchema.extend({
  updates: z.array(StyleUpdateSchema.extend({ value: StyleValueWireSchema })).min(1),
});

export const updateStylesTool: ToolModule = {
  definition: {
    name: "webstudio_update_styles",
    description: `Use when: tweak LOCAL styles on a single instance (color, padding, etc.) without re-pushing a fragment.
Do NOT use when: editing a shared token (use webstudio_update_token_styles), creating a reusable pattern for ≥2 instances (use webstudio_extract_variant_token), or removing a decl entirely (use webstudio_styles — update_styles can only add/replace, never remove).
Returns: dry-run report listing each patch (replace/add) per instanceId+property+breakpoint+state, or push result with finalVersion.
Side effects: push to Webstudio Cloud (requires allowPush). dryRun=true by default. createLocalIfMissing=true auto-creates a local styleSource + selection if the instance has none. Refuses non-rendering Radix wrappers (DialogTrigger, etc.) unless ignoreWrapperWarning=true.

Patterns: hover-cascade-via-css-vars (parent:hover → child via CSS vars), reset-margins-global. See webstudio_describe_pattern.

Example: { projectSlug: "acme", updates: [{ instanceId: "abc", property: "color", value: { type: "rgb", r: 224, g: 123, b: 26, alpha: 1 }, breakpoint: "base" }], dryRun: true }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              instanceId: { type: "string" },
              property: { type: "string" },
              value: { type: "object" },
              breakpoint: { type: "string" },
              state: { type: "string" },
              listed: { type: "boolean" },
              createLocalIfMissing: { type: "boolean", description: "Create a local styleSource (+ selection) if the instance has none yet. Default false." },
              ignoreWrapperWarning: { type: "boolean", description: "Skip the safety check that blocks styles on non-rendering Radix wrappers (DialogTrigger, etc.). Default false." },
            },
            required: ["instanceId", "property", "value"],
          },
        },
        dryRun: { type: "boolean" },
      },
      required: ["projectSlug", "updates"],
      additionalProperties: false,
    },
    annotations: {
      title: "Update styles on instances",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args) => {
    const parsed = updateStylesInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const { projectSlug, updates, dryRun } = parsed.data;

    let auth;
    try { auth = dryRun ? requireAuth(projectSlug) : requirePushAuth(projectSlug); }
    catch (err) { return authErrorResult(err); }

    // Pre-flight: expand CSS shorthands (flex, padding, margin, gridColumn/gridRow…)
    // into longhand decls, and coerce grid-child longhands whose value is an unparsed
    // digit string (e.g. gridColumnStart: "4") into the canonical unit/number shape
    // required by the Webstudio Grid Child Manual panel. Pedagogical hints emitted
    // by these silent coercions are collected and appended to the response so the
    // caller learns why their input was rewritten. See lib/expand-shorthand.ts.
    const expandedUpdates: typeof updates = [];
    const coerceHints: string[] = [];
    // Telemetry (v2.7.4): collect every coerce.telemetryKey emitted so we can log
    // them once we know the push went through (or at dry-run boundary). Each event
    // counts in scripts/telemetry-report.mjs to surface "what does the model keep
    // getting wrong". No-op when WEBSTUDIO_MCP_TELEMETRY≠1.
    const telemetryEvents: Array<{ key: string; extra?: Record<string, unknown> }> = [];
    for (const u of updates) {
      // Normalize `state` to its canonical selector form (":hover", "::before"): a bare
      // "hover" would be stored as a dead state that never triggers. Recoverable forms are
      // coerced (hint + telemetry), unrecoverable ones rejected. See lib/state-whitelist.ts.
      const sr = resolveStateForWrite(u.state);
      if (!sr.ok) {
        return errorResult("VALIDATION_FAILED", `Invalid state on instance ${u.instanceId}: ${sr.error}`);
      }
      if (sr.hint) {
        coerceHints.push(sr.hint);
        telemetryEvents.push({ key: sr.telemetryKey, extra: { source: "styles.update", projectSlug, instanceId: u.instanceId, from: sr.from, to: sr.state, reason: sr.reason } });
      }
      let exp = expandShorthand(u.property, u.value as never);
      if (exp.kind === "passthrough") {
        exp = coerceGridChildLonghand(u.property, u.value as never);
      }
      if (exp.kind === "passthrough") {
        exp = coerceAspectRatio(u.property, u.value as never);
      }
      if (exp.kind === "error") {
        return errorResult("VALIDATION_FAILED", `Invalid shorthand on instance ${u.instanceId}: ${exp.message}`);
      }
      if (exp.kind === "ok") {
        for (const d of exp.decls) {
          expandedUpdates.push({ ...u, state: sr.state, property: d.property, value: d.value as never });
        }
        if (exp.hint) coerceHints.push(exp.hint);
        if (exp.telemetryKey) {
          telemetryEvents.push({ key: exp.telemetryKey, extra: { source: "styles.update", projectSlug, property: u.property } });
        }
      } else {
        expandedUpdates.push({ ...u, state: sr.state });
      }
    }

    // Soft warning (v2.7.3): if ≥3 instances are pushed with Manual single-cell
    // grid placement on the same breakpoint, suggest Area span 1 (auto-flow).
    // Detects the a production site anti-pattern C — "Manual partout par mimétisme".
    // Does NOT block the push. See pattern grid-child-placement.
    const spanHits = detectManualSingleCellPattern(
      expandedUpdates.map((u) => ({
        instanceId: u.instanceId,
        property: u.property,
        value: u.value as never,
        breakpoint: u.breakpoint,
        state: (u as { state?: string }).state,
      })),
    );
    for (const hit of spanHits) {
      coerceHints.push(hit.hint);
      telemetryEvents.push({
        key: hit.telemetryKey,
        extra: { source: "styles.update", projectSlug, breakpoint: hit.breakpoint, count: hit.count },
      });
    }

    // Fire telemetry events for all silent coercions emitted above. Best-effort
    // (logCoerce is a no-op when WEBSTUDIO_MCP_TELEMETRY≠1). Awaited in series so
    // any error doesn't break the request, but the order of events is preserved
    // in the JSONL log. See src/lib/telemetry.ts.
    for (const ev of telemetryEvents) {
      await logCoerce(ev.key, ev.extra);
    }

    // Pre-flight: refuse shadow values that Webstudio Cloud silently drops
    // (e.g. boxShadow={type:"unparsed", value:"var(--xxx)"}). See lib/style-coerce.ts.
    for (const u of expandedUpdates) {
      const verr = validateStyleValue(u.property, u.value as never);
      if (verr) {
        return errorResult("VALIDATION_FAILED", `Invalid style value on instance ${u.instanceId}: ${verr}`);
      }
    }

    let build;
    try { build = await fetchBuild(auth); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    // Cast zod inferred type to the explicit StyleUpdate (StyleValue lineage).
    // Auto-coerce tuple/function shapes so the Webstudio UI panel decodes them properly
    // (see lib/style-coerce.ts — affects filter/backdropFilter/transform/transition*/animation*).
    const upd = expandedUpdates.map((u) => ({
      ...u,
      value: coerceStyleValue(u.property, u.value as never),
      // CSS custom properties (--foo) need listed:true to appear in the Styles panel; auto-set if absent.
      listed: applyListedDefault(u.property, (u as { listed?: boolean }).listed),
    })) as unknown as StyleUpdate[];
    const tx = buildUpdateStylesTransaction(build, upd);
    const patchCount = tx.transaction.payload.reduce((sum, p) => sum + p.patches.length, 0);

    if (patchCount === 0) {
      const hasFailure = tx.details.some((d) => d.startsWith("!") || d.startsWith("⚠"));
      if (hasFailure) {
        const firstFail = tx.details.find((d) => d.startsWith("!") || d.startsWith("⚠")) ?? "";
        const code = firstFail.startsWith("!") && firstFail.includes("instance not found") ? "INSTANCE_NOT_FOUND" : "VALIDATION_FAILED";
        return errorResult(code, `No patches generated:\n${tx.details.join("\n")}`);
      }
      return textResult(`No-op (all updates already match):\n${tx.details.join("\n")}`);
    }

    // Dedup hints (multiple updates touching the same shortcut produce identical hints).
    const dedupedHints = [...new Set(coerceHints)];
    const hintBlock = dedupedHints.length > 0
      ? `\n\n[hints]\n${dedupedHints.map((h) => `- ${h}`).join("\n")}`
      : "";

    if (dryRun) {
      return textResult(`DRY-RUN update_styles\n\n${patchCount} patch(es) over ${updates.length} update(s):\n${tx.details.join("\n")}\n\nIf OK, re-run with dryRun=false.${hintBlock}`);
    }

    try {
      const { result, finalVersion } = await pushWithRetry(auth, (cur) => buildUpdateStylesTransaction(cur, upd).transaction);
      return textResult(`${patchCount} style(s) updated — version → ${finalVersion}\nstatus: ${result.status}\n\n${tx.details.join("\n")}${hintBlock}`);
    } catch (err) {
      return runtimeErrorResult(err, "Update failed");
    }
  },
};

