// Mega-tool `instances` — v2.0. Instance tree operations.
//
// Tier mapping:
//   - delete                                   → CRITICAL
//   - clone, clone_page, wrap, flatten         → STRUCTURING
//   - append, update_label, update_text,
//     prop_update, prop_delete, prop_bind      → TACTICAL
//
// v2 hard breaks (all normalisations + legacy aliases removed):
//   - delete: batch form `{instanceIds:[...]}` or `{labels:[...]}` ONLY. Single `{instanceId}` GONE.
//   - flatten: batch form `{instanceIds:[...]}` ONLY.
//   - update_label: batch form `{updates:[{instanceId, label}]}` ONLY. No more `{instanceId, newLabel}`.
//   - update_text: batch form `{updates:[{instanceId, text, childIndex?, mode?}]}` ONLY. No more `{instanceId, newText}`.
//   - clone: provide exactly ONE of `targetInstanceId` | `targetAnchor` | `targetAnchors`.
//   - clone_page: DEPRECATED (v2.9.0) — alias of clone with targetAnchors[] + mode:"replace".
//   - wrap: `component`/`tag` ONLY (no `wrapperComponent`/`wrapperTag`).
//   - prop_update: batch form `{updates:[{instanceId, propName, value, type, ...}]}` ONLY. No `propValue`/`propType`.
//   - prop_delete: batch form `{deletions:[...]}` ONLY.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { appendChildTool, appendChildInputSchema } from "./append-child.js";
import { deleteInstanceTool, deleteInstanceInputSchema } from "./delete-instance.js";
import { cloneSubtreeTool, cloneSubtreeInputSchema } from "./clone-subtree.js";
import { clonePageSubtreeTool, clonePageSubtreeInputSchema } from "./clone-page-subtree.js";
import { wrapInstanceTool, wrapInstanceInputSchema } from "./wrap-instance.js";
import { flattenInstanceTool, flattenInstanceInputSchema } from "./flatten-instance.js";
import { updateInstanceLabelTool, updateInstanceLabelInputSchema } from "./update-instance-label.js";
import { updateInstanceTagTool, updateInstanceTagInputSchema } from "./update-instance-tag.js";
import { updateInstanceTextTool, updateInstanceTextInputSchema } from "./update-instance-text.js";
import { updateInstancePropTool, updateInstancePropInputSchema } from "./update-instance-prop.js";
import { deleteInstancePropTool, deleteInstancePropInputSchema } from "./delete-instance-prop.js";
import { bindInstancePropTool, bindInstancePropInputSchema } from "./bind-instance-prop.js";
import { moveInstanceTool, moveInstanceInputSchema } from "./move-instance.js";
import { shareSlotToPageTool, shareSlotToPageInputSchema } from "./share-slot-to-page.js";

const TIER: Record<string, Tier> = {
  append: "TACTICAL",
  delete: "CRITICAL",
  clone: "STRUCTURING",
  clone_page: "STRUCTURING",
  wrap: "STRUCTURING",
  flatten: "STRUCTURING",
  move: "STRUCTURING",
  update_label: "TACTICAL",
  update_tag: "TACTICAL",
  update_text: "TACTICAL",
  prop_update: "TACTICAL",
  prop_delete: "TACTICAL",
  prop_bind: "TACTICAL",
  share_slot_to_page: "STRUCTURING",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("append") }).passthrough(),
  Base.extend({ action: z.literal("delete") }).passthrough(),
  Base.extend({ action: z.literal("clone") }).passthrough(),
  Base.extend({ action: z.literal("clone_page") }).passthrough(),
  Base.extend({ action: z.literal("wrap") }).passthrough(),
  Base.extend({ action: z.literal("flatten") }).passthrough(),
  Base.extend({ action: z.literal("move") }).passthrough(),
  Base.extend({ action: z.literal("update_label") }).passthrough(),
  Base.extend({ action: z.literal("update_tag") }).passthrough(),
  Base.extend({ action: z.literal("update_text") }).passthrough(),
  Base.extend({ action: z.literal("prop_update") }).passthrough(),
  Base.extend({ action: z.literal("prop_delete") }).passthrough(),
  Base.extend({ action: z.literal("prop_bind") }).passthrough(),
  Base.extend({ action: z.literal("share_slot_to_page") }).passthrough(),
]);

const D = {
  append: `Use when: append simple children under a parent — one via tag/text, or a batch via children:[...]. Do NOT use when: pushing a complete subtree (use build.push_fragment), OR you want to REUSE an existing Slot's content on a new page (use action:"share_slot_to_page" — preserves the DAG reference so edits propagate; append component:"Slot" creates an EMPTY slot disconnected from any shared content). Returns: new instanceId(s). Side effects: push. Batch children:[{tag,text,...}] appends N new children in ONE transaction (v2.16.0 — list items, nav links). Example: {action:"append",label:"add-card",projectSlug:"my-site",parentInstanceId:"abc",component:"Box",tag:"div"}. Example batch: {action:"append",label:"add-nav-links",projectSlug:"my-site",parentInstanceId:"nav",children:[{tag:"a",text:"Accueil"},{tag:"a",text:"Contact"}]}\n[PATTERN] For TEXT inside an empty parent (Link, Button, Span): prefer instances.update_text mode:"expression" with value:"\\"My text\\"" — since v2.3.2 it accepts adding the first child on an empty instance, no wrapper needed. See pattern "component-architecture" (anti-pattern C).`,
  delete: `Use when: delete instances and ALL their descendants, by instanceIds or labels batch. Do NOT use when: removing just a prop (use action:"prop_delete"). Returns: cascade summary. Batch forms: pass {instanceIds:[...]} or {labels:[...]} for batch match. Side effects: push, CRITICAL — context required, irreversible cascade. Example: {action:"delete",label:"drop-sections",projectSlug:"my-site",instanceIds:["abc"],context:"Removing the obsolete promo banner section that has been replaced by the new hero variant validated by the client this morning",dryRun:true}`,
  clone: `Use when: duplicate a subtree to one or many targets as independent copies with full ID remap. Do NOT use when: (a) you need the FULL page (meta + title + bindings + page-scoped dataSources/resources) — use pages.duplicate; (b) you want to SHARE a Slot across pages so edits propagate — use action:"share_slot_to_page" (DAG ref, no copy, ideal for Header/Footer). Returns: per-target outcome + id remap. Side effects: push. Three target forms (exactly one): (a) targetInstanceId — atomic same-build target; (b) targetAnchor:{pagePath|pageId,label,tag?} — single page identified by anchor label; (c) targetAnchors:[{...},...] — multi-page batch with per-target refetch+retry. mode "append" (default) | "prepend" | "replace". includeSource controls scope: false (default) clones the CHILDREN of sourceInstanceId only (used for "fill a container template" — the wrapper itself stays where it is); true includes sourceInstanceId as the root of the cloned subtree (used for "clone this section into another page" — the natural reading). Cannot combine includeSource:true with skipChildLabels. Example (atomic, children only): {action:"clone",label:"clone-card-kids",projectSlug:"p",sourceInstanceId:"main_a",targetInstanceId:"main_b"}. Example (clone a section into a page — INCLUDE source wrapper): {action:"clone",label:"hero-section-to-atelier",projectSlug:"p",sourceInstanceId:"hero_src",targetAnchor:{pagePath:"/atelier",label:"Main"},mode:"append",includeSource:true}. Example (multi-page template fill — children only, default): {action:"clone",label:"templ-to-N",projectSlug:"p",sourceInstanceId:"tpl_main",targetAnchors:[{pagePath:"/concession-1",label:"main"},{pagePath:"/concession-2",label:"main"}],mode:"replace",skipChildLabels:["Newsletter CTA"]}.\n[PATTERN] cross-page-section-cloning — workflow create page + append anchor + clone, with explicit Cas A (container fill) vs Cas B (clone whole section). Decision tree create vs duplicate vs clone vs share_slot_to_page → meta.describe_pattern({pattern:"page-management"}).`,
  clone_page: `Use when: DEPRECATED (v2.9.0) alias of clone — legacy back-compat callers only.
Do NOT use when: new code — prefer action:"clone" with targetAnchor (single page) or targetAnchors (multi-page batch) and an explicit mode ("append" / "prepend" / "replace") instead of the hardcoded "replace". Alias of action:"clone" with targetAnchors[] + mode:"replace" hardcoded. Legacy callers pass {sourcePagePath/Id, targetPagePaths/Ids, anchorLabel, anchorTag, skipChildLabels} — preserved for back-compat (emits detect:clone-page-deprecated-usage telemetry).
Returns: per-target outcome (delegated to clone — same shape as before: {pageRef, status:"ok"|"skipped", summary, patchCount, finalVersion} OR skip reason).
Side effects: push to Webstudio Cloud (delegated to clone; requires allowPush). dryRun=true by default.
Example: {action:"clone_page",label:"reuse-main",projectSlug:"p",sourcePagePath:"/about",targetPagePaths:["/contact"],anchorLabel:"main"} → equivalent in new API: {action:"clone",label:"reuse-main",projectSlug:"p",sourceInstanceId:"<resolved>",targetAnchors:[{pagePath:"/contact",label:"main"}],mode:"replace"}.`,
  wrap: `Use when: wrap an existing instance in a new parent via component + tag. Do NOT use when: appending a sibling (use action:"append"). Legacy \`wrapperComponent\`/\`wrapperTag\` are not accepted — pass \`component\` + \`tag\` only. Typical use: wrap an h1 in a section. Returns: new wrapper instanceId. Side effects: push. Example: {action:"wrap",label:"wrap-h1",projectSlug:"my-site",instanceId:"abc",component:"Box",tag:"section"}`,
  flatten: `Use when: remove instances but keep their children. Inverse of "wrap". Pass {instanceIds:[...]}. Do NOT use when: removing children too (use action:"delete"). Returns: removed + children promoted counts. Side effects: push. Example: {action:"flatten",label:"flat-wrap",projectSlug:"my-site",instanceIds:["abc"]}`,
  move: `Use when: re-parent or reorder existing instances — only the parent reference changes. Do NOT use when: cloning a subtree (use action:"clone") or wrapping a single instance (use action:"wrap"). Returns: per-move plan + push result. Side effects: push. Preserves all props, styles, tokens, children. Pass moves as a batch: {moves:[{instanceId, parentInstanceId, insertIndex?}, ...]}. insertIndex omitted = append at end. Refuses cycles (parent cannot be the instance itself or any of its descendants) and refuses moving a root instance. Typical use: group sibling instances into a brand-new wrapper (wrap one of them to create the parent, then move the others into it). Example: {action:"move",label:"group-heading",projectSlug:"my-site",moves:[{instanceId:"p_xyz",parentInstanceId:"heading_wrapper",insertIndex:1}]}`,
  update_label: `Use when: rename instance labels (navigator names). Batch form ONLY: {updates:[{instanceId, label}]}. Do NOT use when: updating text content (use action:"update_text"). Returns: confirmation. Side effects: push. Example: {action:"update_label",label:"rename-hero",projectSlug:"my-site",updates:[{instanceId:"abc",label:"Hero (Acme 850)"}]}`,
  update_tag: `Use when: change an instance's HTML tag, keeping component, children, props and styles. Do NOT use when: changing rendered text (use action:"update_text") or changing the component (not supported — delete + re-add). Batch form ONLY: {updates:[{instanceId, tag}]}. Also preserves label. Typical uses: demote duplicate H1 to H2, fix heading hierarchy, swap a div for a section/aside. Returns: per-update diff. Side effects: push. Example: {action:"update_tag",label:"fix-h1-hierarchy",projectSlug:"my-site",updates:[{instanceId:"abc",tag:"h2"}]}`,
  update_text: `Use when: replace a TextBlock or text child node's content — batch form only. Do NOT use when: binding a prop to a variable (use action:"prop_bind"). Batch form ONLY: {updates:[{instanceId, text, childIndex?, mode?}]}. childIndex (default 0) selects which text child to replace when the instance contains several (e.g. <p> with intercalated <strong>). mode="expression" sets dynamic binding. Multiple updates targeting the same instanceId are merged. Returns: per-update diff. Side effects: push. dryRun defaults true. Example: {action:"update_text",label:"upd-title",projectSlug:"my-site",updates:[{instanceId:"abc",text:"Nouveau slogan"}],dryRun:false}`,
  prop_update: `Use when: set or update instance props — literal value, asset id, or expression. Do NOT use when: binding to a variable/resource (use action:"prop_bind"). Batch form ONLY: {updates:[{instanceId, propName, value, type?, createIfMissing?, preserveExpressions?, force?, ignoreWrapperWarning?}]}. Returns: confirmation. Side effects: push. Example: {action:"prop_update",label:"set-href",projectSlug:"my-site",updates:[{instanceId:"abc",propName:"href",value:"/contact",type:"string"}]}`,
  prop_delete: `Use when: remove props from instances, reverting to defaults — batch deletions form. Do NOT use when: setting empty string (use action:"prop_update"). Batch form ONLY: {deletions:[{instanceId, propName}]}. Returns: confirmation. Side effects: push. Example: {action:"prop_delete",label:"clear-href",projectSlug:"my-site",deletions:[{instanceId:"abc",propName:"href"}]}`,
  prop_bind: `Use when: bind an instance prop to a variable, resource expression, or page field — dynamic per-instance data. Do NOT use when: setting a literal (use action:"prop_update"). Returns: confirmation. Side effects: push. Example: {action:"prop_bind",label:"bind-title",projectSlug:"my-site",instanceId:"abc",propName:"src",binding:{kind:"variable",dataSourceId:"def"}}`,
  share_slot_to_page: `Use when: share an existing Slot across pages by DAG reference — edits propagate. Do NOT use when: (a) duplicating a subtree with independent IDs (use action:"clone_page"), (b) source is not a Slot (only operates on component:"Slot"), (c) creating an empty Slot (use action:"append" with component:"Slot"). All wrappers across the N target pages reference the SAME child content (DAG, not a copy) — edits to the shared child instantly propagate everywhere. Canonical use: Header / Footer / Cookie banner / Newsletter signup reused on all pages. Idempotent — target parent already containing a Slot pointing to the same shared child is silently skipped. Returns: per-target outcome (ok/skipped/error) with new wrapper id. Side effects: push. dryRun=true by default. Pattern: meta.describe_pattern({pattern:"shared-slots-between-pages"}). Example: {action:"share_slot_to_page",label:"share-header",projectSlug:"my-site",sourceSlotInstanceId:"Gy8SFH0MCVTzJ0BacaQxW",targetPagePaths:["/offres","/contact"]}`,
};

/**
 * Strip mega-tool boilerplate. pagePath/pageId are also stripped because no instance
 * sub-handler uses them — instances are identified by id, not page.
 */
const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, pagePath: _pp, pageId: _pi, ...rest } = input;
  void _a; void _l; void _c; void _pp; void _pi;
  return rest;
};

const HANDLERS = {
  append: async (i: Record<string, unknown>) => appendChildTool.handler(strip(i)),
  delete: async (i: Record<string, unknown>) => deleteInstanceTool.handler(strip(i)),
  clone: async (i: Record<string, unknown>) => cloneSubtreeTool.handler(strip(i)),
  clone_page: async (i: Record<string, unknown>) => clonePageSubtreeTool.handler(strip(i)),
  wrap: async (i: Record<string, unknown>) => wrapInstanceTool.handler(strip(i)),
  flatten: async (i: Record<string, unknown>) => flattenInstanceTool.handler(strip(i)),
  move: async (i: Record<string, unknown>) => moveInstanceTool.handler(strip(i)),
  update_label: async (i: Record<string, unknown>) => updateInstanceLabelTool.handler(strip(i)),
  update_tag: async (i: Record<string, unknown>) => updateInstanceTagTool.handler(strip(i)),
  update_text: async (i: Record<string, unknown>) => updateInstanceTextTool.handler(strip(i)),
  prop_update: async (i: Record<string, unknown>) => updateInstancePropTool.handler(strip(i)),
  prop_delete: async (i: Record<string, unknown>) => deleteInstancePropTool.handler(strip(i)),
  prop_bind: async (i: Record<string, unknown>) => bindInstancePropTool.handler(strip(i)),
  share_slot_to_page: async (i: Record<string, unknown>) => shareSlotToPageTool.handler(strip(i)),
};

export const instancesTool: ToolModule = {
  definition: {
    name: "instances",
    description: `Mega-tool for instance tree operations. 14 actions: append, delete, clone, clone_page, wrap, flatten, move, update_label, update_tag, update_text, prop_update, prop_delete, prop_bind, share_slot_to_page. delete is CRITICAL (cascades). clone/clone_page/wrap/flatten/move/share_slot_to_page are STRUCTURING. share_slot_to_page reuses a Slot's content across pages via DAG reference (edits propagate) — distinct from clone_page (copy, independent edits). v2: only batch forms accepted on multi-item actions (delete/flatten/move/update_label/update_tag/update_text/prop_update/prop_delete).`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "append", description: D.append, zod: appendChildInputSchema },
      { action: "delete", description: D.delete, zod: deleteInstanceInputSchema },
      { action: "clone", description: D.clone, zod: cloneSubtreeInputSchema },
      { action: "clone_page", description: D.clone_page, zod: clonePageSubtreeInputSchema },
      { action: "wrap", description: D.wrap, zod: wrapInstanceInputSchema },
      { action: "flatten", description: D.flatten, zod: flattenInstanceInputSchema },
      { action: "move", description: D.move, zod: moveInstanceInputSchema },
      { action: "update_label", description: D.update_label, zod: updateInstanceLabelInputSchema },
      { action: "update_tag", description: D.update_tag, zod: updateInstanceTagInputSchema },
      { action: "update_text", description: D.update_text, zod: updateInstanceTextInputSchema },
      { action: "prop_update", description: D.prop_update, zod: updateInstancePropInputSchema },
      { action: "prop_delete", description: D.prop_delete, zod: deleteInstancePropInputSchema },
      { action: "prop_bind", description: D.prop_bind, zod: bindInstancePropInputSchema },
      { action: "share_slot_to_page", description: D.share_slot_to_page, zod: shareSlotToPageInputSchema },
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
    logContext({ tool: "instances", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });
    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
