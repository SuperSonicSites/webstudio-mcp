// Tool: webstudio_push_fragment — direct push to Webstudio Cloud with dry-run.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { BuildFragmentSchema, buildFromArgs } from "../build-from-args.js";
import { requireAuth, requirePushAuth, saveAuth } from "../auth.js";
import { fetchBuild, pushWithRetry } from "../webstudio-client.js";
import { fragmentToTransaction } from "../fragment-to-patches.js";
import { coerceRawImgInstances } from "../lib/coerce-image-component.js";
import { stagePush } from "../lib/push-stage.js";
import { coerceRawVideoInstances } from "../lib/coerce-video-component.js";
import { lintShowBindingProps } from "../lib/lint-show-binding.js";
import { findReplaceTargets } from "../lib/find-replace-targets.js";
import { logCoerce } from "../lib/telemetry.js";
import { buildInstanceRemovalChanges, buildParentChildrenPatch } from "../cleanup-helpers.js";
import type { BuildPatchTransaction, WebstudioBuild, BuildPatchChange } from "../webstudio-client.js";
import { assertSafeRadixProp } from "../lib/radix-wrappers.js";

export const pushFragmentInputSchema = BuildFragmentSchema.extend({
  pushTo: z.object({
    projectSlug: z.string(),
    parentInstanceId: z.string().optional(),
    pageId: z.string().optional(),
    dryRun: z.boolean().default(false),
    /** Mandatory two-stage protocol: the first push MUST be dryRun=true so the caller can
     *  read the server-reported project name. Then the real push must explicitly set both
     *  dryRun=false AND forceConfirmed=true. This prevents accidental writes to a wrong
     *  project (the auth cookie is account-scoped, so all user's projects are reachable). */
    forceConfirmed: z.boolean().default(false),
    /** Position in parent.children where the fragment root(s) are inserted. Default = end (append).
     *  Use 0 to prepend, N to insert before index N. Useful to inject between existing siblings
     *  (e.g. add a sibling between Logo and CTA in a flex container) without resorting to CSS order. */
    insertIndex: z.number().int().nonnegative().optional(),
    /** Bypass the RADIX_TRIGGER_POLLUTION guard that scans the fragment for class/style/id
     *  props on Radix non-rendering wrappers. Default false — the guard catches a class of
     *  SPA-navigation bugs (cf. docs/patterns/sheet-mobile-radix.md § Major pitfall). */
    ignoreWrapperWarning: z.boolean().default(false),
  }),
  /**
   * Idempotent replace mode: before pushing, remove the parent's top-level instances
   * whose label matches one of the provided labels. Also catches orphans (props, etc.).
   * Useful to iterate on a pattern (Sheet, header, etc.) without duplicating.
   */
  replace: z.object({
    /** Labels to match at the parent's top level (exact match). */
    labels: z.array(z.string()).min(1),
    /** Restrict the match to a component (Radix suffix accepted, e.g. "Dialog"). */
    componentMatch: z.string().optional(),
  }).optional(),
});

export const pushFragmentTool: ToolModule = {
  definition: {
    name: "webstudio_push_fragment",
    description: `Use when: push a new section/fragment to Webstudio Cloud (hero, swiper, sheet, header, footer, generic Box tree). The workhorse push tool.
Do NOT use when: simple text change → use webstudio_update_instance_text. Single prop edit → webstudio_instance_prop. Single style decl → webstudio_styles. Delete an existing tree → webstudio_delete_instance. For a Sheet specifically (mobile drawer), prefer webstudio_create_sheet (handles a11y + replace). For a desktop NavigationMenu, prefer webstudio_create_navigation_menu.
Returns: dry-run report (server-reported project name, target parentInstanceId, transaction summary) OR push result with finalVersion + appVersion auto-refresh.
Side effects: push to Webstudio Cloud (requires allowPush). ENFORCED two-stage protocol: dryRun=true first → user confirms server-reported project name → re-call with dryRun=false AND forceConfirmed=true. Real push without forceConfirmed=true is REFUSED. Auto-retries on version_mismatched (3 attempts). Builder open during push triggers a reload toast. replace:{labels, componentMatch?} removes old top-level trees matching labels (required when re-pushing the same pattern). insertIndex controls position in parent.children (default = append). Pre-flight scans fragment for class/style/id props on Radix non-rendering wrappers (RADIX_TRIGGER_POLLUTION — SPA-navigation bug class); opt-out via pushTo.ignoreWrapperWarning=true.

Patterns embedded in fragments — see webstudio_describe_pattern(pattern:"<slug>"):
  - "swiper-carousel" (Swiper.js + html,body{overflow-x:hidden} MANDATORY)
  - "sheet-mobile-radix" (mobile nav drawer — prefer create_sheet tool)
  - "hover-cascade-via-css-vars" (parent:hover → child styles via --vars)
  - "video-component" (use native Video component, never ws:element tag="video")
  - "image-component" (native Image — src accepts asset | URL string | expression; raw ws:element tag="img" is auto-converted, coerce:image-component)
  - "ws-collection-bindings" (ws:collection + parameter dataSource via the new dataSources field — push lists with per-item bindings atomically)

Example dry-run: { projectSlug: "acme", pushTo: { projectSlug: "acme", dryRun: true }, instances: [...], replace: { labels: ["HeroSection"] } }
Example real push (after user confirms project name from dry-run): { projectSlug: "my-site", pushTo: { projectSlug: "my-site", parentInstanceId: "headerId", dryRun: false, forceConfirmed: true }, instances: [...], replace: { labels: ["MobileMenu"] } }`,
    inputSchema: {
      type: "object",
      properties: {
        instances: { type: "array" },
        props: { type: "array" },
        styles: { type: "array" },
        tokens: { type: "array" },
        projectSlug: { type: "string" },
        useTokens: { type: "array" },
        dataSources: { type: "array", description: "Raw dataSource entries (variable / parameter) pushed atomically with the fragment. Required for ws:collection's `item` parameter. See pattern:\"ws-collection-bindings\"." },
        pushTo: {
          type: "object",
          properties: {
            projectSlug: { type: "string" },
            parentInstanceId: { type: "string" },
            pageId: { type: "string" },
            dryRun: { type: "boolean", description: "Run with dryRun:true FIRST. Reads back the server-reported project name without mutating." },
            forceConfirmed: { type: "boolean", description: "Mandatory two-stage protocol: real push (dryRun:false) MUST set forceConfirmed:true. Refuses otherwise to guard against pushing to the wrong project." },
            insertIndex: { type: "number", description: "Position in parent.children where fragment root(s) are inserted (0 = prepend). Default = append at end." },
            ignoreWrapperWarning: { type: "boolean", description: "Bypass the RADIX_TRIGGER_POLLUTION pre-flight scan. Default false." },
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
      },
      required: ["instances", "pushTo"],
      additionalProperties: false,
    },
    annotations: {
      title: "Push fragment to Webstudio",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args) => {
    const parsed = pushFragmentInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const { pushTo, replace, ...buildArgs } = parsed.data;
    const isDryRun = pushTo.dryRun === true;

    // Two-stage protocol enforcement: a real push (dryRun=false) must explicitly set
    // forceConfirmed=true. The expected flow is dryRun=true → read project name → user
    // confirms → re-call with dryRun=false AND forceConfirmed=true.
    if (!isDryRun && pushTo.forceConfirmed !== true) {
      return errorResult(
        "VALIDATION_FAILED",
        "Two-stage push protocol required. Run with dryRun:true first to read the server-reported project name, get explicit user confirmation, then re-call with dryRun:false AND forceConfirmed:true. This guards against pushing to the wrong project (the auth cookie is account-scoped — all your projects are reachable).",
      );
    }

    let auth;
    try {
      auth = isDryRun ? requireAuth(pushTo.projectSlug) : requirePushAuth(pushTo.projectSlug);
    } catch (err) {
      return authErrorResult(err);
    }

    let builder;
    try {
      builder = buildFromArgs(buildArgs);
    } catch (err) {
      return errorResult("VALIDATION_FAILED", `Build error: ${(err as Error).message}`);
    }
    const fragment = builder.build();

    // Coerce raw <img> instances to the native Image component (v2.18.0 —
    // see lib/coerce-image-component.ts). Runs BEFORE the Radix prop check
    // and before any transaction is derived from the fragment.
    const imgCoerce = coerceRawImgInstances(fragment["@webstudio/instance/v0.1"].instances);
    if (imgCoerce.count > 0) {
      void logCoerce(imgCoerce.telemetryKey!, {
        source: "build.push_fragment",
        projectSlug: pushTo.projectSlug,
        count: imgCoerce.count,
      });
    }
    // v2.19.0: raw <video> conversion + iframe video detection + data-ws-show lint.
    const payload0 = fragment["@webstudio/instance/v0.1"];
    const videoCoerce = coerceRawVideoInstances(payload0.instances, payload0.props);
    const showLint = lintShowBindingProps(payload0.props);
    for (const t of [...videoCoerce.telemetry, ...showLint.telemetry]) {
      void logCoerce(t.key, { source: "build.push_fragment", projectSlug: pushTo.projectSlug, count: t.count });
    }
    const allHints = [
      ...(imgCoerce.hint ? [imgCoerce.hint] : []),
      ...videoCoerce.hints,
      ...showLint.hints,
    ];
    const imgHint = allHints.length > 0 ? `\n\n⚠ ${allHints.join("\n⚠ ")}` : "";

    // Pre-flight: refuse class/style/id props on Radix non-rendering wrappers
    // inside the fragment. Catches the SPA-navigation cloneElement merge bug
    // before the patch is even computed. Opt-out: pushTo.ignoreWrapperWarning=true.
    if (!pushTo.ignoreWrapperWarning) {
      const payload = fragment["@webstudio/instance/v0.1"];
      const instById = new Map(payload.instances.map((i) => [i.id, i]));
      const errors: string[] = [];
      for (const p of payload.props) {
        const inst = instById.get(p.instanceId);
        if (!inst) continue;
        const check = assertSafeRadixProp(inst.component, p.name);
        if (!check.ok) {
          errors.push(`prop "${p.name}" on ${inst.component.split(":").pop()} "${inst.label ?? inst.id}":\n  ${check.reason}\n  → ${check.hint}`);
        }
      }
      if (errors.length > 0) {
        return errorResult(
          "RADIX_TRIGGER_POLLUTION",
          `${errors.length} prop pollution(s) in fragment:\n\n${errors.join("\n\n")}\n\nMove the prop(s) to the rendering child Button/Link, or pass pushTo.ignoreWrapperWarning=true.`,
        );
      }
    }

    let build;
    try {
      build = await fetchBuild(auth);
    } catch (err) {
      return runtimeErrorResult(err, "fetch build failed");
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

    // Helper that builds the transaction (with optional inline replace cleanup).
    const buildFullTransaction = (cur: typeof build, pid: string): BuildPatchTransaction => {
      const baseTx = fragmentToTransaction(fragment, cur, { parentInstanceId: pid, insertIndex: pushTo.insertIndex });
      if (!replace) return baseTx;
      const targets = findReplaceTargets(cur, pid, replace.labels, replace.componentMatch);
      if (targets.length === 0) return baseTx;
      const cleanupChanges = buildInstanceRemovalChanges(cur, targets);
      // Also strip references from the parent's children (in the cleanup's instances namespace).
      const instCleanup = cleanupChanges.find((c) => c.namespace === "instances");
      if (instCleanup) instCleanup.patches.unshift(buildParentChildrenPatch(cur, pid, targets));
      // Prepend cleanup patches BEFORE fragment patches, namespace by namespace.
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

    let transaction;
    try { transaction = buildFullTransaction(build, parentId); }
    catch (err) { return errorResult("INTERNAL_ERROR", `Transaction generation failed: ${(err as Error).message}`); }

    const insts = parsed.data.instances.length;
    const projectTitle = build.project?.title ?? "(title unavailable)";
    const summary = transaction.payload.map((c) => `  - ${c.namespace}: ${c.patches.length} patches`).join("\n");

    let replaceTargetsInfo = "";
    if (replace) {
      const targets = findReplaceTargets(build, parentId, replace.labels, replace.componentMatch);
      if (targets.length > 0) {
        replaceTargetsInfo = `\nReplace mode: ${targets.length} old tree(s) will be removed (${targets.join(", ")})`;
      } else {
        replaceTargetsInfo = `\nReplace mode: no old match (first push)`;
      }
    }

    if (isDryRun) {
      // Stage the validated input so confirming doesn't re-transmit the whole
      // payload (v2.21.1) — see lib/push-stage.ts.
      const stageId = stagePush("push_fragment", pushTo.projectSlug, parsed.data as Record<string, unknown>);
      return textResult(`DRY-RUN

Target:
  projectSlug: ${pushTo.projectSlug}
  projectId: ${auth.projectId}
  Real name: ${projectTitle}
  parentInstanceId: ${parentId}${replaceTargetsInfo}

Fragment: ${insts} instance(s), build version ${build.version}
Transaction: ${transaction.payload.length} namespaces
${summary}

If OK: build.push_staged({stageId:"${stageId}"}) pushes exactly this (single-use, 10 min) — or re-run with dryRun=false AND forceConfirmed=true.${imgHint}`);
    }

    try {
      const { result, finalVersion, appVersionUpdated } = await pushWithRetry(auth, (cur) => {
        const pid = resolveParent(cur);
        return buildFullTransaction(cur, pid);
      });
      // Persist the new appVersion if it was auto-refreshed during the push.
      if (appVersionUpdated) saveAuth(pushTo.projectSlug, auth);
      const replaceMsg = replace
        ? ` (replace mode — old "${replace.labels.join('", "')}" replaced)`
        : "";
      const refreshMsg = appVersionUpdated ? `\nappVersion auto-refreshed → ${appVersionUpdated.slice(0, 12)}…` : "";
      return textResult(`Fragment pushed to "${projectTitle}" (slug: ${pushTo.projectSlug})${replaceMsg}
${insts} instance(s) — version → ${finalVersion}
status: ${result.status}${refreshMsg}${imgHint}`);
    } catch (err) {
      return runtimeErrorResult(err, "Push failed");
    }
  },
};
