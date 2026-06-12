// Tool: webstudio_create_navigation_menu — one-call creation of a desktop Radix
// NavigationMenu with optional mega-menus, animation override, and chevron rotation.
//
// Replaces the manual 55-instances / 119-styles flow used for a production site desktop nav.
// Reusable for all GD France dealer sites.
//
// Pattern reference: pattern:"navigation-menu-radix" (full recipe + 4 critical pitfalls handled).

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth, requirePushAuth, saveAuth } from "../auth.js";
import { fetchBuild, pushWithRetry } from "../webstudio-client.js";
import type { BuildPatchTransaction, BuildPatchChange, WebstudioBuild } from "../webstudio-client.js";
import { FragmentBuilder } from "../builder.js";
import { addMegaNavigationMenu, type MegaNavItem } from "../components/navigation-menu-mega.js";
import { fragmentToTransaction } from "../fragment-to-patches.js";
import { buildInstanceRemovalChanges, buildParentChildrenPatch } from "../cleanup-helpers.js";
import { parseStringToStyleValue } from "./define-css-var/parse-style-value.js";
import type { StyleValue } from "../types.js";

const ItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("link"),
    label: z.string().min(1),
    href: z.string().min(1),
    active: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("mega"),
    label: z.string().min(1),
    panel: z.object({
      columns: z.array(z.object({
        title: z.string().optional(),
        items: z.array(z.object({ label: z.string().min(1), href: z.string().min(1) })).min(1),
      })).min(1),
      image: z.object({
        assetId: z.string().min(1),
        alt: z.string().optional(),
        width: z.string().optional(),
      }).optional(),
    }),
  }),
]);

export const createNavigationMenuInputSchema = z.object({
  projectSlug: z.string(),
  parentInstanceId: z.string().describe("Where to insert the NavigationMenu (typically the header glass container)."),
  items: z.array(ItemSchema).min(1),
  label: z.string().default("Navigation").describe("NavigationMenu label — used as the replace target for idempotent re-runs."),
  idPrefix: z.string().optional().describe("Prefix for deterministic instance IDs."),
  insertIndex: z.number().int().nonnegative().optional().describe("Position in parent.children (default: append at end)."),
  // ── Colors (hex)
  textColor: z.string().optional().describe('Hex color for trigger labels / flat links (default "#FFFFFF").'),
  hoverColor: z.string().optional().describe('Hex color on :hover (default "#82BB25").'),
  panelBg: z.string().optional().describe('Hex color for the mega panel background (default "#262525").'),
  panelTextColor: z.string().optional().describe('Hex color for text inside mega panels (default "#FFFFFF").'),
  // ── Spacing (CSS strings auto-parsed)
  panelPadding: z.string().optional().describe('Mega panel padding (all 4 sides). CSS value. Default 24px.'),
  panelColumnGap: z.string().optional().describe('Gap between columns inside mega panel. CSS value. Default 24px.'),
  panelRadius: z.string().optional().describe('Border-radius of mega panel. CSS value. Default 16px.'),
  colMinWidth: z.string().optional().describe('Min-width of each column inside a mega panel. CSS value. Default 200px.'),
  colRowGap: z.string().optional().describe('Vertical gap between sub-links inside a column. CSS value. Default 8px.'),
  imageWidth: z.string().optional().describe('Width of optional panel image. CSS value. Default 320px.'),
  listColumnGap: z.string().optional().describe('Gap between top-level nav items in the list. CSS value. Default 32px.'),
  viewportOffset: z.string().optional().describe('Margin-top on the viewport container — gap between the nav and the open mega panel. CSS value. Default 48px.'),
  triggerColumnGap: z.string().optional().describe('Gap between trigger label and chevron icon. CSS value. Default 4px.'),
  // ── Behavior
  animation: z.enum(["fade", "fade-down", "none"]).default("fade-down").describe('Mega panel entrance animation. Default "fade-down" (subtle from-top slide + fade).'),
  animSlug: z.string().optional().describe('data-role + keyframes namespace (default "mega") — make project-specific to avoid CSS collisions.'),
  triggerChevron: z.boolean().default(true).describe('Show a chevron icon next to mega-menu triggers, rotating 180° on hover.'),
  dryRun: z.boolean().default(true),
}).strict();

export const createNavigationMenuTool: ToolModule = {
  definition: {
    name: "webstudio_create_navigation_menu",
    description: `Use when: build a desktop Radix NavigationMenu in ONE call — flat links + optional mega-menus (multi-column dropdowns with optional right-side image). Idempotent: re-runs replace any old nav matching the label.
Do NOT use when: you want a mobile drawer (burger / Sheet) — use webstudio_create_sheet. For a non-standard nav, hand-assemble + webstudio_push_fragment.
Returns: { navId, listId, viewportId, megaIds[], flatIds[], finalVersion }.
Side effects: push to Webstudio Cloud (requires allowPush). dryRun=true by default. Handles all 4 pitfalls automatically (no viewport transition, viewport container positioning, root max-content, animation override).
Pattern reference: webstudio_describe_pattern(pattern:"navigation-menu-radix") — full architecture + the 4 pitfalls.

items[]: each entry is either { kind:"link", label, href, active? } OR { kind:"mega", label, panel: { columns: [{title?, items:[{label,href}]}], image?:{assetId,alt?,width?} } }.

Example: { projectSlug: "my-site", parentInstanceId: "headerGlassId", items: [{ kind: "link", label: "Home", href: "/" }, { kind: "mega", label: "Motorcycles", panel: { columns: [{ items: [{label:"Sport",href:"/sport"}, {label:"Touring",href:"/routier"}] }] } }], animation: "fade-down" }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        parentInstanceId: { type: "string" },
        items: { type: "array", description: "See discriminated union: link or mega." },
        label: { type: "string" },
        idPrefix: { type: "string" },
        insertIndex: { type: "number" },
        textColor: { type: "string" },
        hoverColor: { type: "string" },
        panelBg: { type: "string" },
        panelTextColor: { type: "string" },
        panelPadding: { type: "string" },
        panelColumnGap: { type: "string" },
        panelRadius: { type: "string" },
        colMinWidth: { type: "string" },
        colRowGap: { type: "string" },
        imageWidth: { type: "string" },
        listColumnGap: { type: "string" },
        viewportOffset: { type: "string" },
        triggerColumnGap: { type: "string" },
        animation: { type: "string", enum: ["fade", "fade-down", "none"] },
        animSlug: { type: "string" },
        triggerChevron: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["projectSlug", "parentInstanceId", "items"],
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
    const parsed = createNavigationMenuInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const a = parsed.data;

    let auth;
    try { auth = a.dryRun ? requireAuth(a.projectSlug) : requirePushAuth(a.projectSlug); }
    catch (err) { return authErrorResult(err); }

    const sv = (s?: string): StyleValue | undefined => (s ? parseStringToStyleValue(s) : undefined);

    const builder = new FragmentBuilder();
    let result;
    try {
      result = addMegaNavigationMenu(builder, {
        id: a.idPrefix,
        items: a.items as MegaNavItem[],
        textColor: a.textColor,
        hoverColor: a.hoverColor,
        panelBg: a.panelBg,
        panelTextColor: a.panelTextColor,
        panelPadding: sv(a.panelPadding),
        panelColumnGap: sv(a.panelColumnGap),
        panelRadius: sv(a.panelRadius),
        colMinWidth: sv(a.colMinWidth),
        colRowGap: sv(a.colRowGap),
        imageWidth: sv(a.imageWidth),
        listColumnGap: sv(a.listColumnGap),
        viewportOffset: sv(a.viewportOffset),
        triggerColumnGap: sv(a.triggerColumnGap),
        animation: a.animation,
        animSlug: a.animSlug,
        triggerChevron: a.triggerChevron,
      });
    } catch (err) {
      return errorResult("VALIDATION_FAILED", `NavigationMenu build error: ${(err as Error).message}`);
    }

    // Tag root with the user-facing label for idempotent replace.
    // (FragmentBuilder doesn't expose post-hoc label setting; relabel via mutation.)
    const fragment = builder.build();
    const rootInstance = fragment["@webstudio/instance/v0.1"].instances.find((i) => i.id === result.navId);
    if (rootInstance) rootInstance.label = a.label;

    let build;
    try { build = await fetchBuild(auth); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    if (!build.instances.find((i) => i.id === a.parentInstanceId)) {
      return errorResult("INSTANCE_NOT_FOUND", `parentInstanceId "${a.parentInstanceId}" not found in build.`);
    }

    const buildFullTransaction = (cur: WebstudioBuild, pid: string): BuildPatchTransaction => {
      const baseTx = fragmentToTransaction(fragment, cur, { parentInstanceId: pid, insertIndex: a.insertIndex });
      const targets = findReplaceTargets(cur, pid, [a.label]);
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

    const existingTargets = findReplaceTargets(build, a.parentInstanceId, [a.label]);
    const replaceInfo = existingTargets.length
      ? `Replace mode: ${existingTargets.length} old tree(s) will be removed (${existingTargets.join(", ")})`
      : `Replace mode: no old match (first push)`;

    const idsSummary = `nav=${result.navId} list=${result.listId} viewport=${result.viewportId} mega=${result.megaIds.length} flat=${result.flatIds.length}`;

    if (a.dryRun) {
      let tx;
      try { tx = buildFullTransaction(build, a.parentInstanceId); }
      catch (err) { return errorResult("INTERNAL_ERROR", `Transaction generation failed: ${(err as Error).message}`); }
      const ns = tx.payload.map((c) => `  - ${c.namespace}: ${c.patches.length} patches`).join("\n");
      return textResult(`DRY-RUN create_navigation_menu

Target:
  projectSlug: ${a.projectSlug}
  parentInstanceId: ${a.parentInstanceId}
  ${replaceInfo}

Items: ${a.items.length} (${a.items.filter((i) => i.kind === "mega").length} mega, ${a.items.filter((i) => i.kind === "link").length} flat)
Animation: ${a.animation}
Chevron: ${a.triggerChevron}

Transaction: ${tx.payload.length} namespaces
${ns}

IDs that will be created:
  ${idsSummary}

If OK, re-run with dryRun=false (and allowPush=true).`);
    }

    try {
      const { result: pushResult, finalVersion, appVersionUpdated } = await pushWithRetry(auth, (cur) =>
        buildFullTransaction(cur, a.parentInstanceId),
      );
      if (appVersionUpdated) saveAuth(a.projectSlug, auth);
      return textResult(`NavigationMenu created — version → ${finalVersion}
status: ${pushResult.status}
${existingTargets.length ? `(replaced ${existingTargets.length} old "${a.label}" tree(s))` : "(first push)"}

IDs:
  ${idsSummary}`);
    } catch (err) {
      return runtimeErrorResult(err, "create_navigation_menu push failed");
    }
  },
};

function findReplaceTargets(
  build: WebstudioBuild,
  parentId: string,
  labels: string[],
): string[] {
  const parent = build.instances.find((i) => i.id === parentId);
  if (!parent) return [];
  const labelSet = new Set(labels);
  const found: string[] = [];
  for (const c of parent.children) {
    if (c.type !== "id") continue;
    const inst = build.instances.find((i) => i.id === c.value);
    if (!inst || !inst.label || !labelSet.has(inst.label)) continue;
    found.push(inst.id);
  }
  return found;
}
