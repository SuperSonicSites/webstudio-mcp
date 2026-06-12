// Tool: webstudio_create_popup — one-call creation of a Radix Dialog promo popup with
// configurable trigger (auto-delay / exit-intent / scroll-depth / manual) and frequency
// (once-per-session / once-per-user / always). Wraps the addPopup helper + push_fragment
// cleanup/replace semantics so callers don't have to assemble the fragment by hand.
//
// Idempotence: re-runs replace the old wrapper Box matching `label` cleanly. The script
// + Dialog + Image + a11y instances all sit under that wrapper so removing it cascades.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import {
  textResult,
  errorResult,
  authErrorResult,
  runtimeErrorResult,
} from "./types.js";
import { requireAuth, requirePushAuth, saveAuth } from "../auth.js";
import { fetchBuild, pushWithRetry } from "../webstudio-client.js";
import { findReplaceTargets } from "../lib/find-replace-targets.js";
import { buildReplaceMergeTransaction } from "../lib/replace-merge-transaction.js";
import type {
  BuildPatchTransaction,
  BuildPatchChange,
  WebstudioBuild,
} from "../webstudio-client.js";
import { FragmentBuilder } from "../builder.js";
import { addPopup } from "../components/popup.js";

const PopupTriggerSchema = z
  .object({
    mode: z.enum(["auto-delay", "exit-intent", "scroll-depth", "manual"]),
    delayMs: z.number().int().nonnegative().optional(),
    scrollPercent: z.number().int().min(1).max(100).optional(),
    triggerId: z.string().optional(),
  })
  .refine(
    (t) => t.mode !== "manual" || (t.triggerId && t.triggerId.length > 0),
    { message: 'trigger.mode="manual" requires trigger.triggerId (HTML id of an external button).' },
  );

const PopupContentSchema = z.object({
  kind: z.literal("image"),
  assetId: z.string().min(1).describe("Webstudio assetId (sha256)."),
  alt: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  href: z.string().optional().describe("If provided, the image is wrapped in a <Link> with this href."),
});

export const createPopupInputSchema = z
  .object({
    projectSlug: z.string(),
    parentInstanceId: z
      .string()
      .describe("Instance ID where the popup wrapper Box will be inserted as a child (typically the page root)."),
    label: z
      .string()
      .default("Popup")
      .describe("Wrapper Box label — also used as replace target for idempotent re-runs."),
    scriptLabel: z
      .string()
      .default("Popup script")
      .describe("HtmlEmbed script label (rendered under the wrapper)."),
    content: PopupContentSchema,
    trigger: PopupTriggerSchema,
    frequency: z.enum(["once-per-session", "once-per-user", "always"]),
    storageKey: z
      .string()
      .optional()
      .describe('Storage flag key (default "popup_seen"). Use a project-unique key when multiple popups co-exist on a site.'),
    expiryDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('frequency="once-per-user" only — refresh window in days. Default 30.'),
    maxWidth: z
      .string()
      .optional()
      .describe('CSS value for the content max-width (default "500px"). Accepts "var(--token)" / "32rem" / "500px".'),
    overlayBgRgba: z
      .object({
        r: z.number(),
        g: z.number(),
        b: z.number(),
        a: z.number(),
      })
      .optional()
      .describe("Custom overlay background. Default rgba(0,0,0,0.7)."),
    borderRadius: z
      .string()
      .optional()
      .describe('CSS value for the content border-radius (default "8px").'),
    closePosition: z
      .enum(["top-right", "top-left", "top-center"])
      .optional()
      .describe('Close button corner. Default "top-right".'),
    idPrefix: z.string().optional().describe("Prefix for deterministic instance IDs (default: nanoid)."),
    a11yTitle: z
      .string()
      .nullable()
      .optional()
      .describe('Sr-only DialogTitle (Radix requirement). Default "Promotional offer"; null opts out (NOT recommended).'),
    a11yDescription: z
      .string()
      .nullable()
      .optional()
      .describe('Sr-only DialogDescription (Radix requirement). Default "Discover our latest offer"; null opts out (NOT recommended).'),
    dryRun: z.boolean().default(true),
  })
  .strict();

export const createPopupTool: ToolModule = {
  definition: {
    name: "webstudio_create_popup",
    description: `Use when: build a promo modal / newsletter popup in ONE call (Radix Dialog + hidden auto-trigger button + HtmlEmbed script handling trigger mode & frequency + Radix-native close + sr-only a11y). Idempotent: re-runs replace the old wrapper Box matching label.
Do NOT use when: you want a mobile drawer (use webstudio_create_sheet) or a desktop mega menu (use webstudio_create_navigation_menu). For a custom layout inside the popup, hand-assemble + webstudio_push_fragment with replace mode.
Returns: { wrapperId, dialogId, triggerBtnId, overlayId, contentId, imageId, scriptId, triggerBtnHtmlId, finalVersion }.
Side effects: push to Webstudio Cloud (requires allowPush). dryRun=true by default. A11y by default: visually-hidden DialogTitle + DialogDescription are injected.
Pattern reference: webstudio_describe_pattern(pattern:"popup-modal-radix") — full recipe + pitfalls.

trigger.mode:
  - "auto-delay" — opens after trigger.delayMs (default 2000ms)
  - "exit-intent" — opens on document mouseleave with clientY<=0 (desktop only — auto-fallback to delayed open on touch devices)
  - "scroll-depth" — opens after trigger.scrollPercent of page scrolled (default 50%)
  - "manual" — binds to click on document.getElementById(trigger.triggerId) — pass the id of an existing button on the page

frequency:
  - "once-per-session" — sessionStorage flag (cleared when tab/browser closes)
  - "once-per-user" — localStorage flag with TTL (refresh window in expiryDays, default 30)
  - "always" — opens every page load (use for testing only)

Example: { projectSlug:"my-project", parentInstanceId:"pageRootId", content:{kind:"image",assetId:"913a...4db",alt:"Promo",width:1254,height:1254,href:"/offres"}, trigger:{mode:"auto-delay",delayMs:3000}, frequency:"once-per-session" }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        parentInstanceId: {
          type: "string",
          description: "Where to insert the popup wrapper Box (typically the page root).",
        },
        label: {
          type: "string",
          description: "Wrapper Box label (default 'Popup') — used as the replace target.",
        },
        scriptLabel: {
          type: "string",
          description: "HtmlEmbed script label (default 'Popup script').",
        },
        content: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["image"] },
            assetId: { type: "string", description: "Webstudio assetId (sha256)." },
            alt: { type: "string" },
            width: { type: "number" },
            height: { type: "number" },
            href: { type: "string", description: "If set, image is wrapped in a <Link>." },
          },
          required: ["kind", "assetId", "alt"],
        },
        trigger: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["auto-delay", "exit-intent", "scroll-depth", "manual"],
            },
            delayMs: { type: "number", description: "auto-delay ms (default 2000)." },
            scrollPercent: { type: "number", description: "scroll-depth % (default 50)." },
            triggerId: {
              type: "string",
              description: 'HTML id of external trigger button — required for mode="manual".',
            },
          },
          required: ["mode"],
        },
        frequency: {
          type: "string",
          enum: ["once-per-session", "once-per-user", "always"],
        },
        storageKey: {
          type: "string",
          description: 'Storage flag key (default "popup_seen").',
        },
        expiryDays: {
          type: "number",
          description: 'frequency="once-per-user" only — refresh window in days. Default 30.',
        },
        maxWidth: {
          type: "string",
          description: 'CSS value for content max-width (default "500px").',
        },
        overlayBgRgba: {
          type: "object",
          properties: {
            r: { type: "number" },
            g: { type: "number" },
            b: { type: "number" },
            a: { type: "number" },
          },
        },
        borderRadius: {
          type: "string",
          description: 'CSS value for content border-radius (default "8px").',
        },
        closePosition: {
          type: "string",
          enum: ["top-right", "top-left", "top-center"],
        },
        idPrefix: { type: "string", description: "Prefix for stable IDs." },
        a11yTitle: {
          type: ["string", "null"],
          description: 'Visually-hidden DialogTitle (a11y). Default "Promotional offer". Pass null to opt out (NOT recommended).',
        },
        a11yDescription: {
          type: ["string", "null"],
          description: 'Visually-hidden DialogDescription (a11y). Default "Discover our latest offer". Pass null to opt out (NOT recommended).',
        },
        dryRun: { type: "boolean" },
      },
      required: ["projectSlug", "parentInstanceId", "content", "trigger", "frequency"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler: async (args) => {
    const parsed = createPopupInputSchema.safeParse(args);
    if (!parsed.success)
      return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const {
      projectSlug,
      parentInstanceId,
      label,
      scriptLabel,
      content,
      trigger,
      frequency,
      storageKey,
      expiryDays,
      maxWidth,
      overlayBgRgba,
      borderRadius,
      closePosition,
      idPrefix,
      a11yTitle,
      a11yDescription,
      dryRun,
    } = parsed.data;

    let auth;
    try {
      auth = dryRun ? requireAuth(projectSlug) : requirePushAuth(projectSlug);
    } catch (err) {
      return authErrorResult(err);
    }

    const builder = new FragmentBuilder();
    let result;
    try {
      // Note: do NOT pass parentId to addPopup — the wrapper Box must be at the fragment
      // root so push_fragment can attach it to parentInstanceId in the live build.
      result = addPopup(builder, {
        id: idPrefix,
        label,
        scriptLabel,
        content,
        trigger,
        frequency,
        storageKey,
        expiryDays,
        maxWidth,
        overlayBgRgba,
        borderRadius,
        closePosition,
        a11yTitle,
        a11yDescription,
      });
    } catch (err) {
      return errorResult("VALIDATION_FAILED", `Popup build error: ${(err as Error).message}`);
    }
    const fragment = builder.build();

    let build;
    try {
      build = await fetchBuild(auth);
    } catch (err) {
      return runtimeErrorResult(err, "fetch build failed");
    }

    if (!build.instances.find((i) => i.id === parentInstanceId)) {
      return errorResult(
        "INSTANCE_NOT_FOUND",
        `parentInstanceId "${parentInstanceId}" not found in build.`,
      );
    }

    // Idempotent replace: target the wrapper Box label (the popup is a single sub-tree).
    const replaceLabels = [label];

    const buildFullTransaction = (cur: WebstudioBuild, pid: string): BuildPatchTransaction =>
      buildReplaceMergeTransaction(fragment, cur, pid, replaceLabels);

    const existingTargets = findReplaceTargets(build, parentInstanceId, replaceLabels);
    const replaceInfo = existingTargets.length
      ? `Replace mode: ${existingTargets.length} old wrapper(s) will be removed (${existingTargets.join(", ")})`
      : `Replace mode: no old match (first push)`;

    const idsSummary = `wrapper=${result.wrapperId} dialog=${result.dialogId} triggerBtn=${result.triggerBtnId} content=${result.contentId} image=${result.imageId} close=${result.closeBtnId} script=${result.scriptId} htmlId=${result.triggerBtnHtmlId}`;

    if (dryRun) {
      let tx;
      try {
        tx = buildFullTransaction(build, parentInstanceId);
      } catch (err) {
        return errorResult(
          "INTERNAL_ERROR",
          `Transaction generation failed: ${(err as Error).message}`,
        );
      }
      const ns = tx.payload
        .map((c) => `  - ${c.namespace}: ${c.patches.length} patches`)
        .join("\n");
      return textResult(`DRY-RUN create_popup

Target:
  projectSlug: ${projectSlug}
  parentInstanceId: ${parentInstanceId}
  ${replaceInfo}

Popup:
  content.kind: ${content.kind}
  trigger.mode: ${trigger.mode}
  frequency: ${frequency}

Transaction: ${tx.payload.length} namespaces
${ns}

IDs that will be created:
  ${idsSummary}

If OK, re-run with dryRun=false (and allowPush=true).`);
    }

    try {
      const { result: pushResult, finalVersion, appVersionUpdated } =
        await pushWithRetry(auth, (cur) =>
          buildFullTransaction(cur, parentInstanceId),
        );
      if (appVersionUpdated) saveAuth(projectSlug, auth);
      return textResult(`Popup created — version → ${finalVersion}
status: ${pushResult.status}
${existingTargets.length ? `(replaced ${existingTargets.length} old "${label}" wrapper(s))` : "(first push)"}

IDs:
  ${idsSummary}`);
    } catch (err) {
      return runtimeErrorResult(err, "create_popup push failed");
    }
  },
};

