// Mega-tool `build` — v2.0. Fragment construction + push.
//
// Tier mapping: all STRUCTURING.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { buildFragmentTool, buildFragmentInputSchema } from "./build-fragment.js";
import { pushFragmentTool, pushFragmentInputSchema } from "./push-fragment.js";
import { pushCompleteTool, pushCompleteInputSchema } from "./push-complete.js";
import { createSheetTool, createSheetInputSchema } from "./create-sheet.js";
import { createNavigationMenuTool, createNavigationMenuInputSchema } from "./create-navigation-menu.js";
import { createPopupTool, createPopupInputSchema } from "./create-popup.js";
import { htmlToFragment } from "../lib/html-to-fragment.js";
import { takeStagedPush } from "../lib/push-stage.js";

const TIER: Record<string, Tier> = {
  build_fragment: "STRUCTURING",
  push_fragment: "STRUCTURING",
  push_complete: "STRUCTURING",
  push_staged: "STRUCTURING",
  create_sheet: "STRUCTURING",
  create_navigation_menu: "STRUCTURING",
  create_popup: "STRUCTURING",
  push_html: "STRUCTURING",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("build_fragment") }).passthrough(),
  Base.extend({ action: z.literal("push_fragment") }).passthrough(),
  Base.extend({ action: z.literal("push_complete") }).passthrough(),
  Base.extend({ action: z.literal("push_staged") }).passthrough(),
  Base.extend({ action: z.literal("create_sheet") }).passthrough(),
  Base.extend({ action: z.literal("create_navigation_menu") }).passthrough(),
  Base.extend({ action: z.literal("create_popup") }).passthrough(),
  Base.extend({ action: z.literal("push_html") }).passthrough(),
]);

// `push_staged` executes a payload captured by a prior dry-run — see
// lib/push-stage.ts. The confirm call carries ~60 chars instead of
// re-emitting the entire fragment (8-15 kB typical, tens of kB for big pushes).
const pushStagedInputSchema = z.object({
  stageId: z.string().min(6).describe('Stage id from a dry-run report ("st_…"). Single-use, expires after 10 minutes.'),
}).strict();

// `push_html` is implemented inline (HTML→fragment conversion then delegate to
// pushFragmentTool). Declare its Zod here — superset of pushFragment minus the
// fragment fields (instances/props/styles), plus the html+css inputs.
const pushHtmlInputSchema = z.object({
  projectSlug: z.string(),
  pushTo: z.object({
    projectSlug: z.string(),
    parentInstanceId: z.string().optional(),
    pageId: z.string().optional(),
    dryRun: z.boolean().default(true),
    forceConfirmed: z.boolean().default(false),
    insertIndex: z.number().int().nonnegative().optional(),
    ignoreWrapperWarning: z.boolean().default(false),
  }),
  html: z.string().min(1).describe("Raw HTML — exactly 1 root element. No <style> tags (pass CSS separately)."),
  css: z.string().optional().describe("Stylesheet text. Media queries limited to Webstudio breakpoints (max-width: 991/767/479). No @keyframes."),
}).strict();

const D = {
  build_fragment: `Use when: assembling a WebstudioFragment offline from a JSON tree spec, without pushing. Do NOT use when: pushing immediately (use action:"push_fragment"). Returns: full WebstudioFragment object (instances + props + styles). Side effects: writes a local JSON file in ~/.webstudio-mcp/fragments/. Example: {action:"build_fragment",label:"build-hero",instances:[...],props:[...]}\n[PATTERN] For a button/link/CTA: 1 single instance (Link or Button) with children:[{type:"expression",value:"\\"Mon texte\\""}] + props (href) + tokenSelections OR styles. Do NOT wrap with Box > Span containing just text. Anti-pattern C. ❌ See pattern "component-architecture".`,
  push_fragment: `Use when: pushing a prebuilt WebstudioFragment to a project page; basic push, no tokens/bindings. Do NOT use when: (a) building offline (use action:"build_fragment"); (b) replicating an existing page from this project — use pages.duplicate (full page, atomic, preserves meta + bindings + page-scoped resources) or instances.clone_page (sections from a template page via anchorLabel). Returns: push result + final build version. Side effects: push to Webstudio Cloud, inserting under pushTo.parentInstanceId. Mandatory two-stage protocol: dryRun=true first to confirm project, then dryRun=false + forceConfirmed=true. Example: {action:"push_fragment",label:"push-hero",projectSlug:"my-site",pushTo:{projectSlug:"my-site",parentInstanceId:"abc",dryRun:true},instances:[...]}\n[PATTERN] Pre-push checklist: (1) no CSS var used <10× site-wide — inline or tokenize; (2) every styled component carries a complete token (button token ≈ 25-30 decls, not just font-*); (3) no two instances share identical blocks of local decls; (4) no text-only wrapper instances; (5) after a token attach, plan a dedupe_locals pass. See pattern "component-architecture". For new page scaffolding decision tree (create vs duplicate vs clone_page vs share_slot_to_page): meta.describe_pattern({pattern:"page-management"}).`,
  push_complete: `Use when: pushing a full section in one call with cloud tokens, bindings, and pattern.repeat.\nDo NOT use when: (a) pushing without tokens/bindings (build.push_fragment is lighter); (b) attaching tokens to instances that ALREADY exist in cloud (use tokens.attach_token); (c) replicating an existing page from this project — use pages.duplicate (full page in 1 atomic call, preserves meta + bindings + page-scoped dataSources/resources; avoids re-declaring local style overrides and breakpoints from the template) or instances.clone_page (sections from a template page via anchorLabel + skipChildLabels). Decision tree: meta.describe_pattern({pattern:"page-management"}).\nReturns: dry-run summary with the planned transaction breakdown (namespaces + patch counts + token/binding/pattern stats), OR push result with finalVersion.\nSide effects: push to Webstudio Cloud (requires allowPush). Atomic: pre-flight failure (binding ref unknown, token name conflict, non-expandable shorthand on token styles, RADIX_TRIGGER_POLLUTION) → no patch is sent. Auto-retries on version_mismatched (3 attempts) and persists refreshed appVersion. Builder open during push triggers a reload toast. Same two-stage protocol as push_fragment. One call covers instances + props + styles + dataSources with inline bindings (expression props / text-expression children) and subtree templating with {{var}} substitution; replaces the legacy 10-14 sequential calls workflow (tokens.create_tokens → tokens.update_token_styles → build.push_fragment → tokens.attach_token → instances.update_text mode=expression → instances.prop_bind).\nKey fields beyond push_fragment: cloudTokens:[{name,styles,attachToInstances}] (token+attach atomic, attachToInstances must be fragment-local), bindings:[{instanceId,propName?,binding,childIndex?}] (propName set = prop binding, absent = replace text child), pattern:{subtree,patternProps?,patternStyles?,patternBindings?,idPrefix?,repeat:[{idSuffix?,vars}]} ({{key}} substitution), fromFile:"/abs/path.json" (override inline arrays).\nExample: {action:"push_complete",label:"push-footer",projectSlug:"my-site",pushTo:{projectSlug:"my-site",parentInstanceId:"footerId",dryRun:true},instances:[{id:"col-1",component:"ws:element",tag:"div",label:"Col"}],cloudTokens:[{name:"Footer Link",styles:{color:{type:"keyword",value:"white"}},attachToInstances:["col-1"]}],pattern:{subtree:[{id:"lnk",component:"ws:element",tag:"a",parentId:"col-1",children:[{type:"text",value:"{{label}}"}]}],patternProps:[{instanceId:"lnk",name:"href",type:"string",value:"{{href}}"}],idPrefix:"f-",repeat:[{idSuffix:"1",vars:{label:"700cc",href:"/700"}},{idSuffix:"2",vars:{label:"800cc",href:"/800"}}]},bindings:[{instanceId:"col-1",propName:"ariaLabel",binding:{kind:"variable",dataSourceId:"ds_title"}}]}
[PATTERN] transition*/animation* longhands in cloudTokens.styles or inline styles: pass each as {type:"layers", value:[...]} or as {type:"unparsed", value:"<css>"}. Single typed values ({type:"var"}, {type:"keyword"}, {type:"unit"}) are auto-wrapped to layers[1]; missing longhands of the cohort are auto-completed with CSS defaults at matching layer count since v2.7.10. See pattern "transition-animation-format".`,
  create_sheet: `Use when: one-call mobile drawer (Sheet) with collapsibles, accordion, CTA. Higher-level than push_fragment. Do NOT use when: needing a custom layout (use push_fragment with a built fragment). Returns: push result. Side effects: push. dryRun defaults true. Example: {action:"create_sheet",label:"sheet-menu",projectSlug:"my-site",parentInstanceId:"headerId",links:[{label:"Models",children:[{label:"700cc",href:"/700"}]}]}`,
  create_navigation_menu: `Use when: creating a desktop mega-menu in one call; higher-level than push_fragment. Do NOT use when: needing a custom layout (use push_fragment). Returns: push result. Builds a Radix NavigationMenu with flat links + optional mega panels + chevron rotation. Side effects: push. dryRun defaults true. Example: {action:"create_navigation_menu",label:"navmenu-desktop",projectSlug:"my-site",parentInstanceId:"headerId",items:[{kind:"link",label:"Home",href:"/"}]}`,
  create_popup: `Use when: creating a promo modal or newsletter popup in one call; higher-level than push_fragment. Do NOT use when: needing a mobile drawer (use create_sheet) or a desktop mega menu (use create_navigation_menu) or a custom layout (use push_fragment). Returns: push result + IDs. Builds a Radix Dialog with hidden auto-trigger, an HtmlEmbed script handling trigger mode & frequency, Radix-native close, and sr-only a11y. Side effects: push. dryRun defaults true.
trigger.mode: auto-delay | exit-intent | scroll-depth | manual. frequency: once-per-session | once-per-user (with expiryDays) | always.
Example: {action:"create_popup",label:"popup-promo",projectSlug:"my-site",parentInstanceId:"pageRootId",content:{kind:"image",assetId:"913a...4db",alt:"Promo",href:"/offres"},trigger:{mode:"auto-delay",delayMs:3000},frequency:"once-per-session"}`,
  push_html: `Use when: converting raw HTML+CSS into a fragment and pushing it; onboarding an existing section. Returns: push result + parse stats (rules applied/skipped). Side effects: push to Webstudio Cloud. HTML is converted to a WebstudioFragment. Limits: 1 root element only, no @keyframes, no <style> tags in HTML (pass CSS separately), media queries limited to Webstudio breakpoints (max-width: 991/767/479). Example: {action:"push_html",label:"import-section",projectSlug:"my-site",pushTo:{projectSlug:"my-site",parentInstanceId:"root",dryRun:true},html:"<div class='hero'><h1>Hello</h1></div>",css:".hero { padding: 40px; }"}`,
  push_staged: `Use when: confirming a push previewed by a dry-run — pass the stageId from the report. Do NOT use when: the payload changed since the dry-run (re-run the dry-run instead — stages replay EXACTLY what was previewed). Returns: the real push result (same as the underlying push_fragment/push_complete). Side effects: push to Webstudio Cloud (requires allowPush); the stage is single-use and expires after 10 minutes. The full push pipeline re-runs (auth, coercions, Radix pre-flight, version-mismatch retries) — staging skips re-transmission, never validation. Example: {action:"push_staged",label:"confirm-hero",stageId:"st_V1StGXR8_Z"}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  build_fragment: async (i: Record<string, unknown>) => buildFragmentTool.handler(strip(i)),
  push_fragment: async (i: Record<string, unknown>) => pushFragmentTool.handler(strip(i)),
  push_complete: async (i: Record<string, unknown>) => pushCompleteTool.handler(strip(i)),
  create_sheet: async (i: Record<string, unknown>) => createSheetTool.handler(strip(i)),
  create_navigation_menu: async (i: Record<string, unknown>) => createNavigationMenuTool.handler(strip(i)),
  create_popup: async (i: Record<string, unknown>) => createPopupTool.handler(strip(i)),
  push_staged: async (i: Record<string, unknown>) => {
    const stripped = strip(i);
    const parsed = pushStagedInputSchema.safeParse(stripped);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const staged = takeStagedPush(parsed.data.stageId);
    if (!staged) {
      return errorResult(
        "VALIDATION_FAILED",
        `stageId "${parsed.data.stageId}" not found — stages are single-use and expire after 10 minutes (or the server restarted). Re-run the dry-run to get a fresh stageId.`,
      );
    }
    // Replay the captured args with the confirm flags set. The underlying
    // handler re-runs its full pipeline (requirePushAuth, coercions, Radix
    // pre-flight, version-mismatch retries).
    const pushTo = (staged.args.pushTo ?? {}) as Record<string, unknown>;
    const replay = { ...staged.args, pushTo: { ...pushTo, dryRun: false, forceConfirmed: true } };
    if (staged.handler === "push_fragment") return pushFragmentTool.handler(replay);
    if (staged.handler === "push_complete") return pushCompleteTool.handler(replay);
    return errorResult("INTERNAL_ERROR", `Unknown staged handler "${staged.handler}".`);
  },
  push_html: async (i: Record<string, unknown>) => {
    const stripped = strip(i);
    const html = String(stripped.html ?? "");
    const css = String(stripped.css ?? "");
    if (!html.trim()) return errorResult("VALIDATION_FAILED", "html is required");
    let parsed;
    try { parsed = htmlToFragment(html, css); }
    catch (err) { return errorResult("VALIDATION_FAILED", `HTML parse failed: ${(err as Error).message}`); }
    delete stripped.html;
    delete stripped.css;
    const pushRes = await pushFragmentTool.handler({ ...stripped, fragment: parsed.fragment });
    const stats = `\n\n[push_html stats] root=${parsed.rootInstanceId}, ${parsed.applied} style rule(s) applied, ${parsed.skipped} skipped${parsed.warnings.length > 0 ? `\nWarnings:\n  - ${parsed.warnings.join("\n  - ")}` : ""}`;
    const first = pushRes.content[0];
    if (first?.type === "text") first.text = first.text + stats;
    return pushRes;
  },
};

export const buildTool: ToolModule = {
  definition: {
    name: "build",
    description: `Mega-tool for fragment construction + push (cloud mutation entry point). 8 actions: build_fragment (offline), push_fragment (cloud, basic), push_complete (cloud, full section: tokens+bindings+pattern.repeat in one transaction), push_staged (confirm a dry-run by stageId — no payload re-send), create_sheet, create_navigation_menu, create_popup, push_html. All STRUCTURING tier.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "build_fragment", description: D.build_fragment, zod: buildFragmentInputSchema },
      { action: "push_fragment", description: D.push_fragment, zod: pushFragmentInputSchema },
      { action: "push_complete", description: D.push_complete, zod: pushCompleteInputSchema },
      { action: "push_staged", description: D.push_staged, zod: pushStagedInputSchema },
      { action: "create_sheet", description: D.create_sheet, zod: createSheetInputSchema },
      { action: "create_navigation_menu", description: D.create_navigation_menu, zod: createNavigationMenuInputSchema },
      { action: "create_popup", description: D.create_popup, zod: createPopupInputSchema },
      { action: "push_html", description: D.push_html, zod: pushHtmlInputSchema },
    ]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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
    logContext({ tool: "build", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });
    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
