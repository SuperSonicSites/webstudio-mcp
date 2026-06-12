// Mega-tool `pages` — v2.0. Page lifecycle in a Webstudio Cloud project.
//
// Tier mapping:
//   - delete, delete_folder   → CRITICAL  (context required)
//   - create                  → STRUCTURING (context recommended)
//   - update                  → TACTICAL
//   - list_folders            → READ-ONLY

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { createPageTool, createPageInputSchema } from "./pages/create.js";
import { updatePageTool, updatePageInputSchema } from "./update-page.js";
import { deletePagesBatchTool, deletePagesBatchInputSchema } from "./delete-pages-batch.js";
import { listFoldersTool, listFoldersInputSchema } from "./pages/folders-list.js";
import { deleteFolderTool, deleteFolderInputSchema } from "./pages/folders-delete.js";
import { createFolderTool, createFolderInputSchema } from "./pages/folders-create.js";
import { duplicatePageTool, duplicatePageInputSchema } from "./pages/duplicate.js";
import { getMetaTool, getMetaInputSchema } from "./pages/get-meta.js";
import { updateMetaTool, updateMetaInputSchema } from "./pages/update-meta.js";

const TIER: Record<string, Tier> = {
  create: "STRUCTURING",
  duplicate: "STRUCTURING",
  update: "TACTICAL",
  delete: "CRITICAL",
  list_folders: "READ-ONLY",
  create_folder: "STRUCTURING",
  delete_folder: "CRITICAL",
  get_meta: "READ-ONLY",
  update_meta: "TACTICAL",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("create") }).passthrough(),
  Base.extend({ action: z.literal("duplicate") }).passthrough(),
  Base.extend({ action: z.literal("update") }).passthrough(),
  Base.extend({ action: z.literal("delete") }).passthrough(),
  Base.extend({ action: z.literal("list_folders") }).passthrough(),
  Base.extend({ action: z.literal("create_folder") }).passthrough(),
  Base.extend({ action: z.literal("delete_folder") }).passthrough(),
  Base.extend({ action: z.literal("get_meta") }).passthrough(),
  Base.extend({ action: z.literal("update_meta") }).passthrough(),
]);

const DESCRIPTIONS = {
  create: `Use when: create a NEW page FROM SCRATCH — no comparable template page to reuse. Do NOT use when: (a) modifying an existing page (use action:"update"); (b) replicating an existing page's structure/content — use action:"duplicate" instead (preserves meta bindings + page-scoped dataSources/resources atomically, 1 call instead of 8+ via build.push_complete); (c) you only want to share Header/Footer across pages (use create THEN instances.share_slot_to_page). Returns: {pageId, rootInstanceId} (rootInstanceId = the new page's body root, both generated). Side effects: push to Webstudio Cloud (requires allowPush). dryRun defaults true. Example: {action:"create",label:"create-about",projectSlug:"my-site",name:"About",path:"/about"}\n[PATTERN] Decision tree create vs duplicate vs clone_page vs share_slot_to_page → meta.describe_pattern({pattern:"page-management"}).`,
  duplicate: `Use when: clone a FULL existing page into a new page — entire subtree, page data, meta included. Do NOT use when: cloning a fragment within an existing page (use instances.clone) or just cloning the anchor's children (use instances.clone_page). Returns: pageId, rootInstanceId (both newly generated), counts of cloned entities. FULL = header + main + footer + every slot. Auto-clones page-scoped dataSources & resources (re-scoped to the new root); copies title/meta with expression bindings preserved. Root-scoped (:root) variables are NEVER cloned — they remain shared. Pass variableSubstitutions=[{from,to}] to swap one dataSource ref for another in every cloned expression (typical SEO multi-city use case: same page, different city variable). Side effects: push to Webstudio Cloud (requires allowPush). dryRun defaults true. Example: {action:"duplicate",label:"dup-seo-springfield",projectSlug:"my-site",sourcePagePath:"/quads-acme",targetPath:"/quads-acme-springfield",targetName:"Quads Acme Springfield",variableSubstitutions:[{from:"qfmsrLjD7VoOJNB_xuFhr",to:"ZPW1L62eFHQhna7SSgAl7"}]}`,
  update: `Use when: modify an EXISTING page's name, path, title, or meta, OR move it to another folder. Do NOT use when: binding a meta field to a dynamic expression (use variables.bind_page_field). To delete a page use action:"delete". Returns: per-field summary + patch count. meta covers description, language, OG image, redirect, documentType. Folder move: updates.parentFolderId — combine with updates.path for atomic move+rename. path uniqueness is folder-scoped (Webstudio URLs resolve as cumulative folder slugs + page.path, so /offres at root and /offres in folder globex coexist). Move emits 2 patches (remove from source.children + append to target.children); same parentFolderId as current = no-op. Side effects: push to Webstudio Cloud. dryRun defaults true. Example: {action:"update",label:"set-meta",projectSlug:"my-site",pageId:"pg1",updates:{title:"Home",meta:{language:"en"}}}. Example move+rename: {action:"update",label:"move-offres-globex",projectSlug:"my-site",pageId:"pg3",updates:{parentFolderId:"fld_globex",path:"/offres"}}`,
  delete: `Use when: BATCH delete non-home pages in one consolidated transaction (continue-on-error). Do NOT use when: deleting a folder with all its pages cascading (use action:"delete_folder" with recursive:true). Returns: succeeded[]/failed[] report. Side effects: push to Webstudio Cloud, CRITICAL — context required. Example: {action:"delete",label:"purge-legacy",projectSlug:"my-site",pageIds:["pg_old1","pg_old2"],context:"Removing 3 deprecated landing pages no longer linked from navigation after the 2026 redesign refactor",dryRun:true}`,
  list_folders: `Use when: browse the FOLDER hierarchy — pick parentFolderId before creating pages or folders. Do NOT use when: needing the flat page list (use read.fetch_pages). Returns: indented tree with folder + page icons; each folder shows id, name, slug, children, and a [ROOT] marker. Typical precursor to action:"create" / action:"create_folder" (pick parentFolderId) or action:"delete_folder". Side effects: none (read-only). Example: {action:"list_folders",label:"browse-tree",projectSlug:"my-site"}`,
  create_folder: `Use when: create a NEW page-folder to structure the navigator. Do NOT use when: creating a page (use action:"create"), removing a folder (use action:"delete_folder"). To browse existing folders and pick parentFolderId, call action:"list_folders" first. Renaming/moving an existing folder is not supported — delete + re-create. Returns: {folderId, parent, slug} dry-run summary OR push result with finalVersion. slug must be kebab-case ('acme', 'globex-modeles-2026'); sibling folders cannot share a slug. parentFolderId defaults to "root". Typical case: one folder per brand on a multi-brand dealer site before pushing model pages into it. Side effects: push to Webstudio Cloud (requires allowPush). dryRun defaults true. Example: {action:"create_folder",label:"add-acme-folder",projectSlug:"my-site",name:"Acme",slug:"acme"}`,
  delete_folder: `Use when: delete a page-folder, optionally cascading sub-folders + pages via recursive:true. Do NOT use when: the folder is the ROOT (always refused). To delete pages without removing their folder, use action:"delete". Returns: cascade summary (folders/pages/instances counts, home-relocated flag). Recursive cascade also deletes the cascaded pages' instance trees. Side effects: push to Webstudio Cloud, CRITICAL — context required. force:true relocates home to root if it would otherwise be deleted (only meaningful with recursive:true). Example: {action:"delete_folder",label:"drop-legacy-folder",projectSlug:"my-site",folderId:"fld_legacy",recursive:true,context:"Removing the 2024 legacy folder structure now fully migrated to the new IA after the rebrand of the dealer site",dryRun:true}`,
  get_meta: `Use when: read the PROJECT-level meta — head Custom Code, siteName, branding fields. Do NOT use when: reading per-page title/description/OG override → use read.inspect on the page or read.fetch_pages. Returns: { meta: { code?, siteName?, contactEmail?, faviconAssetId?, socialImageAssetId? } } — sparse, only set fields are present. code = global head Custom Code (GTM/Consent Mode/JSON-LD/preconnect); branding = contactEmail, faviconAssetId, socialImageAssetId. Typical use: audit a project's global head + branding, or copy them to a sibling project. Side effects: none (read-only). Example: {action:"get_meta",label:"read-meta",projectSlug:"acme"}\n[PATTERN] Decision tree project-level vs page-level meta → meta.describe_pattern({pattern:"project-meta-head-code"}).`,
  update_meta: `Use when: write PROJECT-level meta — init a project's global head code or sync cloned projects. Do NOT use when: updating per-page meta → use action:"update" with updates.meta. Appending a snippet to existing head code: read-modify-write via action:"get_meta" then action:"update_meta" (server stores 'code' as a single blob, no atomic append). Returns: dry-run summary + patch count OR push result with applied fields list. Pass null on a field to remove the key. Typical init payload: global head Custom Code — GTM, Consent Mode v2, JSON-LD Organization/MotorcycleDealer, preconnects. Idempotent (no patch when values match current state). Side effects: push to Webstudio Cloud. dryRun=true by default. Example: {action:"update_meta",label:"init-head",projectSlug:"acme",meta:{code:"<script>gtag('config','G-XXX')</script>",siteName:"Acme"},dryRun:false}\n[PATTERN] meta.describe_pattern({pattern:"project-meta-head-code"}) for the full init recipe.`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  create: async (i: Record<string, unknown>) => createPageTool.handler(strip(i)),
  duplicate: async (i: Record<string, unknown>) => duplicatePageTool.handler(strip(i)),
  update: async (i: Record<string, unknown>) => updatePageTool.handler(strip(i)),
  delete: async (i: Record<string, unknown>) => deletePagesBatchTool.handler(strip(i)),
  list_folders: async (i: Record<string, unknown>) => listFoldersTool.handler(strip(i)),
  create_folder: async (i: Record<string, unknown>) => createFolderTool.handler(strip(i)),
  delete_folder: async (i: Record<string, unknown>) => deleteFolderTool.handler(strip(i)),
  get_meta: async (i: Record<string, unknown>) => getMetaTool.handler(strip(i)),
  update_meta: async (i: Record<string, unknown>) => updateMetaTool.handler(strip(i)),
};

export const pagesTool: ToolModule = {
  definition: {
    name: "pages",
    description: `Mega-tool for page lifecycle + project-level meta in a Webstudio Cloud project. 9 actions: create, duplicate, update, delete (batch), list_folders, create_folder, delete_folder, get_meta, update_meta. dryRun default true on every mutating action; CRITICAL actions (delete, delete_folder) also require context.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "create", description: DESCRIPTIONS.create, zod: createPageInputSchema },
      { action: "duplicate", description: DESCRIPTIONS.duplicate, zod: duplicatePageInputSchema },
      { action: "update", description: DESCRIPTIONS.update, zod: updatePageInputSchema },
      { action: "delete", description: DESCRIPTIONS.delete, zod: deletePagesBatchInputSchema },
      { action: "list_folders", description: DESCRIPTIONS.list_folders, zod: listFoldersInputSchema },
      { action: "create_folder", description: DESCRIPTIONS.create_folder, zod: createFolderInputSchema },
      { action: "delete_folder", description: DESCRIPTIONS.delete_folder, zod: deleteFolderInputSchema },
      { action: "get_meta", description: DESCRIPTIONS.get_meta, zod: getMetaInputSchema },
      { action: "update_meta", description: DESCRIPTIONS.update_meta, zod: updateMetaInputSchema },
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
    logContext({ tool: "pages", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });

    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
