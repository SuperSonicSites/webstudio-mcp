// Tool: webstudio_create_sheet — one-call creation of a mobile drawer (Sheet/Dialog) with
// burger trigger, animated hamburger, slide-in panel, and an optional set of collapsible
// sub-menus. Wraps the addSheet helper + push_fragment cleanup/replace semantics so callers
// don't have to assemble the fragment by hand.
//
// Idempotence: pushes with replace mode over the Dialog label AND the CSS embed label, so
// re-running the tool with the same labels swaps the old sheet out cleanly.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
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
import { addSheet, type SheetLink } from "../components/sheet.js";
import { parseStringToStyleValue } from "./define-css-var/parse-style-value.js";
import type { StyleValue } from "../types.js";

const SheetLinkSchema: z.ZodType<SheetLink> = z.lazy(() =>
  z.object({
    label: z.string().min(1),
    href: z.string().optional(),
    children: z
      .array(z.object({ label: z.string().min(1), href: z.string().min(1) }))
      .optional(),
  }).refine((l) => (l.href && l.href.length > 0) || (l.children && l.children.length > 0), {
    message: "Each sheet link needs either an href (leaf) or children (collapsible group).",
  }),
);

export const createSheetInputSchema = z.object({
  projectSlug: z.string(),
  parentInstanceId: z.string().describe("Instance ID where the Sheet (Dialog + CSS embed) will be inserted as children."),
  links: z.array(SheetLinkSchema).min(1),
  label: z.string().default("Mobile menu").describe("Dialog label — also used as replace target for idempotent re-runs."),
  cssLabel: z.string().default("CSS animation menu").describe("CSS HtmlEmbed label — also used as replace target."),
  direction: z.enum(["left", "right"]).default("right"),
  idPrefix: z.string().optional().describe("Prefix for deterministic instance IDs (default: nanoid)."),
  panelBg: z.string().optional().describe("Hex color for the drawer panel background (default #111111)."),
  textColor: z.string().optional().describe("Hex color for links/labels (default #E5E5E5)."),
  hoverColor: z.string().optional().describe("Hex color for link hover state (default #E07B1A)."),
  burgerColor: z.string().optional().describe("Hex color for the hamburger bars (default #111111)."),
  overlayBgRgba: z
    .object({ r: z.number(), g: z.number(), b: z.number(), a: z.number() })
    .optional()
    .describe("Custom overlay background (default rgba(0,0,0,0.7))."),
  panelPadding: z.string().optional().describe('Panel padding (all 4 sides). Pass a CSS value like "var(--brand-space-l)", "24px", "1.5rem". Default px(24).'),
  panelRowGap: z.string().optional().describe('Vertical gap between top-level nav items. Pass a CSS value. Default px(8).'),
  linkFontSize: z.string().optional().describe('Font-size of flat links AND collapsible-group summary labels. Pass a CSS value. Default rem(1.125).'),
  subLinkFontSize: z.string().optional().describe('Font-size of sub-links inside collapsible groups (should be ≤ linkFontSize). Pass a CSS value. Default rem(1).'),
  // ── Floating drawer + responsive ──────────────────────────────────────────
  topOffset: z.string().optional().describe('Offset from viewport top (CSS value) — keeps the header visible above the open drawer. Default 0.'),
  panelInset: z.object({
    top: z.string().optional(),
    right: z.string().optional(),
    bottom: z.string().optional(),
    left: z.string().optional(),
  }).optional().describe('Overlay padding per side — gap between overlay edges and the panel (floating drawer effect). Each side is a CSS value.'),
  panelRadius: z.string().optional().describe('Border-radius of the panel (all 4 corners). CSS value. Default: none (square edges).'),
  noPanelShadow: z.boolean().optional().describe('Drop the default outset box-shadow on the panel (useful for floating drawers where the shadow looks off). Default false.'),
  responsiveBurger: z.object({
    visibleAt: z.enum(["tablet", "mobile-landscape", "mobile-portrait"]),
  }).optional().describe('Auto-hide the burger button at base + show it at the given breakpoint label (≤991px / ≤767px / ≤479px).'),
  // ── Optional top logo ─────────────────────────────────────────────────────
  topLogo: z.object({
    assetId: z.string(),
    alt: z.string().optional(),
    width: z.string().optional(),
    marginBottom: z.string().optional(),
  }).optional().describe('Logo Image at the top of the drawer (above the nav). assetId is the Webstudio sha256 id.'),
  // ── Optional socials row ──────────────────────────────────────────────────
  socials: z.array(z.object({
    platform: z.enum(["facebook", "instagram", "linkedin", "twitter", "youtube", "tiktok"]),
    href: z.string().optional(),
    hrefExpression: z.string().optional().describe('Webstudio expression for dynamic binding, e.g. "$ws$dataSource$<varId>". Mutually exclusive with href.'),
    ariaLabel: z.string().optional(),
  })).optional().describe('Row of social icons at the bottom of the drawer. Built-in SVGs for the listed platforms.'),
  // ── Accessibility (Radix Dialog requires Title + Description) ─────────────
  a11yTitle: z.string().nullable().optional().describe('Sr-only DialogTitle (Radix requirement). Default "Navigation menu"; null opts out (NOT recommended).'),
  a11yDescription: z.string().nullable().optional().describe('Sr-only DialogDescription (Radix requirement). Default provided; null opts out (NOT recommended).'),
  dryRun: z.boolean().default(true),
}).strict();

export const createSheetTool: ToolModule = {
  definition: {
    name: "webstudio_create_sheet",
    description: `Use when: build a mobile drawer / burger nav in ONE call (Dialog + animated burger + slide-in panel + CSS keyframes + optional logo/socials). Idempotent: re-runs replace the old Sheet matching labels.
Do NOT use when: you want a desktop navigation menu (multi-column mega-panels) — use webstudio_create_navigation_menu. For a custom drawer not fitting this template, hand-assemble + webstudio_push_fragment with replace mode.
Returns: { dialogId, buttonId, panelId, navId, cssEmbedId?, linkIds[], finalVersion }.
Side effects: push to Webstudio Cloud (requires allowPush). dryRun=true by default. A11y by default: visually-hidden DialogTitle + DialogDescription are injected (override via a11yTitle / a11yDescription, or null to opt out — NOT recommended).
Pattern reference: webstudio_describe_pattern(pattern:"sheet-mobile-radix") — full recipe + 4 critical pitfalls.

links[]: each entry is either a leaf { label, href } or a collapsible group { label, children: [{label, href}, ...] } rendered as <details><summary>.

Example: { projectSlug: "acme", parentInstanceId: "headerContainerId", links: [{ label: "Models", children: [{label:"700cc",href:"/700"},{label:"800cc",href:"/800"}] }, { label: "Contact", href: "/contact" }], direction: "right" }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        parentInstanceId: { type: "string", description: "Where to insert the Dialog + CSS embed (typically the header container)." },
        links: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              href: { type: "string", description: "Required if no children." },
              children: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    href: { type: "string" },
                  },
                  required: ["label", "href"],
                },
                description: "If provided, the entry renders as <details><summary> with collapsible sub-links.",
              },
            },
            required: ["label"],
          },
        },
        label: { type: "string", description: "Dialog label (default 'Mobile menu') — used as the replace target." },
        cssLabel: { type: "string", description: "CSS embed label (default 'CSS animation menu') — used as the replace target." },
        direction: { type: "string", enum: ["left", "right"], description: "Slide direction (default 'right')." },
        idPrefix: { type: "string", description: "Prefix for stable IDs." },
        panelBg: { type: "string" },
        textColor: { type: "string" },
        hoverColor: { type: "string" },
        burgerColor: { type: "string" },
        overlayBgRgba: {
          type: "object",
          properties: { r: { type: "number" }, g: { type: "number" }, b: { type: "number" }, a: { type: "number" } },
        },
        panelPadding: { type: "string", description: 'Panel padding all 4 sides — CSS value (e.g. "var(--brand-space-l)", "24px"). Default 24px.' },
        panelRowGap: { type: "string", description: 'Vertical gap between nav items — CSS value. Default 8px.' },
        linkFontSize: { type: "string", description: 'Font-size of flat links + group summaries — CSS value. Default 1.125rem.' },
        subLinkFontSize: { type: "string", description: 'Font-size of sub-links in collapsibles — CSS value (≤ linkFontSize). Default 1rem.' },
        topOffset: { type: "string", description: 'Overlay top offset (e.g. header-height). CSS value. Default 0.' },
        panelInset: {
          type: "object",
          properties: { top: { type: "string" }, right: { type: "string" }, bottom: { type: "string" }, left: { type: "string" } },
          description: 'Per-side overlay padding for floating drawer gap.',
        },
        panelRadius: { type: "string", description: 'Border-radius of the panel — CSS value. Default none.' },
        noPanelShadow: { type: "boolean", description: 'Drop the default panel box-shadow.' },
        responsiveBurger: {
          type: "object",
          properties: { visibleAt: { type: "string", enum: ["tablet", "mobile-landscape", "mobile-portrait"] } },
          description: 'Auto-hide burger at base + show at the given breakpoint.',
        },
        topLogo: {
          type: "object",
          properties: {
            assetId: { type: "string" },
            alt: { type: "string" },
            width: { type: "string" },
            marginBottom: { type: "string" },
          },
          description: 'Image at the top of the drawer.',
        },
        socials: {
          type: "array",
          items: {
            type: "object",
            properties: {
              platform: { type: "string", enum: ["facebook", "instagram", "linkedin", "twitter", "youtube", "tiktok"] },
              href: { type: "string" },
              hrefExpression: { type: "string" },
              ariaLabel: { type: "string" },
            },
            required: ["platform"],
          },
          description: 'Row of social icons at the bottom of the drawer.',
        },
        a11yTitle: { type: ["string", "null"], description: 'Visually-hidden DialogTitle injected in the panel (a11y). Default "Navigation menu". Pass null to opt out (NOT recommended).' },
        a11yDescription: { type: ["string", "null"], description: 'Visually-hidden DialogDescription injected in the panel (a11y). Default "Links to the main sections of the site.". Pass null to opt out (NOT recommended).' },
        dryRun: { type: "boolean" },
      },
      required: ["projectSlug", "parentInstanceId", "links"],
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
    const parsed = createSheetInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const {
      projectSlug, parentInstanceId, links, label, cssLabel, direction, idPrefix,
      panelBg, textColor, hoverColor, burgerColor, overlayBgRgba,
      panelPadding, panelRowGap, linkFontSize, subLinkFontSize,
      topOffset, panelInset, panelRadius, noPanelShadow, responsiveBurger,
      topLogo, socials, a11yTitle, a11yDescription, dryRun,
    } = parsed.data;

    // CSS-string options → StyleValue (accepts "var(--x)", "24px", "1rem", etc.)
    const sv = (s?: string): StyleValue | undefined => (s ? parseStringToStyleValue(s) : undefined);
    const insetParsed = panelInset && {
      top: sv(panelInset.top),
      right: sv(panelInset.right),
      bottom: sv(panelInset.bottom),
      left: sv(panelInset.left),
    };

    let auth;
    try { auth = dryRun ? requireAuth(projectSlug) : requirePushAuth(projectSlug); }
    catch (err) { return authErrorResult(err); }

    // Build the fragment via the helper.
    const builder = new FragmentBuilder();
    let result;
    try {
      // Note: do NOT pass parentId to addSheet — the Dialog + CSS embed must be at the
      // fragment root so push_fragment can attach them to parentInstanceId in the live build.
      result = addSheet(builder, {
        id: idPrefix,
        label,
        cssLabel,
        direction,
        links,
        panelBg,
        textColor,
        hoverColor,
        burgerColor,
        overlayBgRgba,
        withCssEmbed: true,
        panelPadding: sv(panelPadding),
        panelRowGap: sv(panelRowGap),
        linkFontSize: sv(linkFontSize),
        subLinkFontSize: sv(subLinkFontSize),
        topOffset: sv(topOffset),
        panelInset: insetParsed,
        panelRadius: sv(panelRadius),
        noPanelShadow,
        responsiveBurger,
        topLogo: topLogo && {
          assetId: topLogo.assetId,
          alt: topLogo.alt,
          width: sv(topLogo.width),
          marginBottom: sv(topLogo.marginBottom),
        },
        socials,
        a11yTitle,
        a11yDescription,
      });
    } catch (err) {
      return errorResult("VALIDATION_FAILED", `Sheet build error: ${(err as Error).message}`);
    }
    const fragment = builder.build();

    let build;
    try { build = await fetchBuild(auth); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    // Sanity: parentInstanceId exists.
    if (!build.instances.find((i) => i.id === parentInstanceId)) {
      return errorResult("INSTANCE_NOT_FOUND", `parentInstanceId "${parentInstanceId}" not found in build.`);
    }

    // Idempotent replace: target the Dialog label AND the CSS embed label.
    const replaceLabels = [label, cssLabel];

    const buildFullTransaction = (cur: WebstudioBuild, pid: string): BuildPatchTransaction =>
      buildReplaceMergeTransaction(fragment, cur, pid, replaceLabels);

    const existingTargets = findReplaceTargets(build, parentInstanceId, replaceLabels);
    const replaceInfo = existingTargets.length
      ? `Replace mode: ${existingTargets.length} old tree(s) will be removed (${existingTargets.join(", ")})`
      : `Replace mode: no old match (first push)`;

    const idsSummary = `dialog=${result.dialogId} button=${result.buttonId} panel=${result.panelId} nav=${result.navId} ${result.cssEmbedId ? `cssEmbed=${result.cssEmbedId} ` : ""}links=[${result.linkIds.join(", ")}]`;

    if (dryRun) {
      let tx;
      try { tx = buildFullTransaction(build, parentInstanceId); }
      catch (err) { return errorResult("INTERNAL_ERROR", `Transaction generation failed: ${(err as Error).message}`); }
      const ns = tx.payload.map((c) => `  - ${c.namespace}: ${c.patches.length} patches`).join("\n");
      return textResult(`DRY-RUN create_sheet

Target:
  projectSlug: ${projectSlug}
  parentInstanceId: ${parentInstanceId}
  ${replaceInfo}

Sheet:
  direction: ${direction}
  links: ${links.length} (${links.filter((l) => l.children?.length).length} collapsible group(s), ${links.filter((l) => !l.children?.length).length} flat link(s))

Transaction: ${tx.payload.length} namespaces
${ns}

IDs that will be created:
  ${idsSummary}

If OK, re-run with dryRun=false (and allowPush=true).`);
    }

    try {
      const { result: pushResult, finalVersion, appVersionUpdated } = await pushWithRetry(auth, (cur) =>
        buildFullTransaction(cur, parentInstanceId),
      );
      if (appVersionUpdated) saveAuth(projectSlug, auth);
      return textResult(`Sheet created — version → ${finalVersion}
status: ${pushResult.status}
${existingTargets.length ? `(replaced ${existingTargets.length} old "${label}"/"${cssLabel}" tree(s))` : "(first push)"}

IDs:
  ${idsSummary}`);
    } catch (err) {
      return runtimeErrorResult(err, "create_sheet push failed");
    }
  },
};

