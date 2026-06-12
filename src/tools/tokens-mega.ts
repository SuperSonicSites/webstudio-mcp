// Mega-tool `tokens` — v2.0. Design token lifecycle.
//
// v2 hard breaks:
//   - `init_brand_kit`: top-level {colors, spacings, fonts, fontSizes, radii, overwrite} ONLY
//     (no more nested `brandKit:{...}`).
//   - `update_token_styles`: batch form `{updates:[...]}` ONLY (no single `{styles:{[prop]:value}}`).
//   - `extract_token`: `tokenName` (no `newTokenName` legacy alias).
//   - `extract_variant`: `sourceTokenName` + `state` (no `baseTokenName`/`variantState`).
//   - `bulk_rename_token_names`: native regex form `{fromPattern, toReplacement, flags?}` ONLY
//     (no more `{renames:{[from]:to}}` first-entry-only map sugar).

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { defineTokenTool, listTokensTool, defineTokenInputSchema, listTokensInputSchema } from "./projects.js";
import { initBrandTokensTool, initBrandTokensInputSchema } from "./init-brand-tokens.js";
import { applyTokenToInstancesTool, applyTokenToInstancesInputSchema } from "./apply-token-to-instances.js";
import { detachTokenFromInstancesTool, detachTokenFromInstancesInputSchema } from "./detach-token-from-instances.js";
import { extractTokenFromInstancesTool, extractTokenFromInstancesInputSchema } from "./extract-token-from-instances.js";
import { extractVariantTokenTool, extractVariantTokenInputSchema } from "./extract-variant-token.js";
import { deleteTokenTool, deleteTokenInputSchema } from "./delete-token.js";
import { bulkRenameTokensTool, bulkRenameTokensInputSchema } from "./bulk-rename-tokens.js";
import { replaceTokenTool, replaceTokenInputSchema } from "./replace-token.js";
import { updateTokenStylesTool, updateTokenStylesInputSchema } from "./update-token-styles.js";
import { deleteTokenDeclTool, deleteTokenDeclInputSchema } from "./delete-token-decl.js";
import { syncLocalTokensTool, syncLocalTokensInputSchema } from "./sync-local-tokens.js";
import { createTokensTool, createTokensInputSchema } from "./create-tokens.js";
import { listTokensCloudTool, listTokensCloudInputSchema } from "./list-tokens-cloud.js";
import { dedupeTokenLocalsTool, dedupeTokenLocalsInputSchema } from "./dedupe-token-locals.js";
import { cleanupOrphanLocalsTool, cleanupOrphanLocalsInputSchema } from "./cleanup-orphan-locals.js";

const TIER: Record<string, Tier> = {
  define_local: "STRUCTURING",
  list_local: "READ-ONLY",
  init_brand_kit: "STRUCTURING",
  sync_local: "STRUCTURING",
  create_tokens: "STRUCTURING",
  list_tokens_cloud: "READ-ONLY",
  update_token_styles: "STRUCTURING",
  delete_token_decl: "TACTICAL",
  attach_token: "TACTICAL",
  detach_token: "TACTICAL",
  extract_token: "STRUCTURING",
  extract_variant: "STRUCTURING",
  delete_token: "CRITICAL",
  bulk_rename_token_names: "CRITICAL",
  migrate_token_selections: "CRITICAL",
  dedupe_locals: "TACTICAL",
  cleanup_orphan_locals: "TACTICAL",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("define_local") }).passthrough(),
  Base.extend({ action: z.literal("list_local") }).passthrough(),
  Base.extend({ action: z.literal("init_brand_kit") }).passthrough(),
  Base.extend({ action: z.literal("sync_local") }).passthrough(),
  Base.extend({ action: z.literal("create_tokens") }).passthrough(),
  Base.extend({ action: z.literal("list_tokens_cloud") }).passthrough(),
  Base.extend({ action: z.literal("update_token_styles") }).passthrough(),
  Base.extend({ action: z.literal("delete_token_decl") }).passthrough(),
  Base.extend({ action: z.literal("attach_token") }).passthrough(),
  Base.extend({ action: z.literal("detach_token") }).passthrough(),
  Base.extend({ action: z.literal("extract_token") }).passthrough(),
  Base.extend({ action: z.literal("extract_variant") }).passthrough(),
  Base.extend({ action: z.literal("delete_token") }).passthrough(),
  Base.extend({ action: z.literal("bulk_rename_token_names") }).passthrough(),
  Base.extend({ action: z.literal("migrate_token_selections") }).passthrough(),
  Base.extend({ action: z.literal("dedupe_locals") }).passthrough(),
  Base.extend({ action: z.literal("cleanup_orphan_locals") }).passthrough(),
]);

const D = {
  define_local: `Use when: declare a LOCAL token in the local tokens.json file (project-side metadata). Do NOT use when: creating CLOUD tokens (use action:"create_tokens"). Returns: local registry path. Side effects: writes to ~/.webstudio-mcp/projects/<slug>/tokens.json. Example: {action:"define_local",label:"def-primary",projectSlug:"my-site",tokenSlug:"primary",name:"Primary",styles:{color:{type:"keyword",value:"red"}}}`,
  list_local: `Use when: list LOCAL tokens from the local registry. Do NOT use when: needing cloud tokens (use action:"list_tokens_cloud"). Returns: array of local token defs. Side effects: none. Example: {action:"list_local",label:"audit-local",projectSlug:"my-site"}`,
  init_brand_kit: `Use when: seed a full brand kit of color, typography and spacing tokens from a brand definition. Do NOT use when: adding 1 token (use action:"create_tokens"), or passing a nested brandKit object — pass top-level {colors, spacings, fonts, fontSizes, radii, overwrite} only. Returns: per-token report. Side effects: push; idempotent. Example: {action:"init_brand_kit",label:"seed-brand",projectSlug:"my-site",colors:{primary:"#FF0000"},spacings:{m:"16px"}}`,
  sync_local: `Use when: push LOCAL tokens to the cloud as actual Webstudio tokens (creates them if missing). Do NOT use when: tokens already in cloud (use action:"update_token_styles"). Returns: created/skipped count. Side effects: push. Example: {action:"sync_local",label:"sync-locals",projectSlug:"my-site"}`,
  create_tokens: `Use when: create N CLOUD tokens in one transaction (batched). Do NOT use when: syncing from local registry (use action:"sync_local"). Returns: created tokenIds. Side effects: push. Example: {action:"create_tokens",label:"create-batch",projectSlug:"my-site",tokens:[{name:"primary",styles:{...}},...]}\n[PATTERN] Token = COMPLETE component (typo + layout + spacing + decoration + effects). A button token typically carries 25-30 decls. Anti-pattern A: token with only font-* then 25 local decls duplicated per instance. ❌ Exception: pure typo tokens (Titre H1, Texte M) — font-* + margin:0 only. See pattern "component-architecture" via meta.describe_pattern.\n[PATTERN] transition*/animation* longhands: pass each as {type:"layers",value:[...]} — single typed values are auto-wrapped and missing longhands auto-completed with CSS defaults (parity with update_token_styles since v2.10.9). See pattern "transition-animation-format".`,
  list_tokens_cloud: `Use when: list CLOUD tokens currently in the project (StyleSource type="token") with their usage count. Do NOT use when: needing local registry (use action:"list_local"). Returns: array of {id, name, styles, usageCount}. Side effects: none. Example: {action:"list_tokens_cloud",label:"audit-cloud",projectSlug:"my-site"}`,
  update_token_styles: `Use when: modify a token's own styles or enrich an incomplete token with migrated local decls. Do NOT use when: modifying LOCAL overrides on an instance (use styles.update), or REMOVING a decl from a token (use action:"delete_token_decl"). Batch form ONLY: {tokenId|tokenName, updates:[{property, value, breakpoint?, state?, listed?}]}. Returns: confirmation. Side effects: push. Example: {action:"update_token_styles",label:"upd-primary",projectSlug:"my-site",tokenName:"primary",updates:[{property:"color",value:{type:"keyword",value:"blue"}}]}\n[PATTERN] Workflow to fix anti-pattern A: 1) update_token_styles to migrate the 25 duplicated button decls into the token; 2) dedupe_locals on the affected instances to strip the now-redundant locals. See pattern "component-architecture".`,
  delete_token_decl: `Use when: REMOVE one or more decls from a SHARED token without recreating it. Do NOT use when: adding or replacing decls (use action:"update_token_styles" — this is its removal counterpart), removing a LOCAL decl on an instance (use styles.delete_decl), or deleting the whole token (use action:"delete_token"). Pass {tokenId|tokenName, deletions:[{property, breakpoint?, state?}]}. Returns: matched decls report. Side effects: push. Example: {action:"delete_token_decl",label:"clean-padding",projectSlug:"my-site",tokenName:"Icon Badge",deletions:[{property:"padding"}],dryRun:true}`,
  attach_token: `Use when: apply a token to N instances (matched by id list). Do NOT use when: extracting a NEW token from locals (use action:"extract_token"). Returns: instances modified count. Side effects: push. Example: {action:"attach_token",label:"apply-primary",projectSlug:"my-site",tokenName:"primary",instanceIds:["abc","def"]}\n[PATTERN] If instances still carry many local decls that match the token after attach → run dedupe_locals to collapse them. See pattern "component-architecture".`,
  detach_token: `Use when: detach a token from N instances (keep their local override styles). Do NOT use when: deleting the token itself (use action:"delete_token"). Returns: instances modified count. Side effects: push. Example: {action:"detach_token",label:"detach-primary",projectSlug:"my-site",tokenName:"primary",instanceIds:["abc"]}`,
  extract_token: `Use when: create a new token from a set of LOCAL overrides on N instances (DRY refactor). Do NOT use when: adding a token from scratch (use action:"create_tokens"). Returns: new tokenId + instances modified. Side effects: push. Example: {action:"extract_token",label:"extract-card-shadow",projectSlug:"my-site",tokenName:"card-shadow",instanceIds:["abc","def"]}`,
  extract_variant: `Use when: create a new VARIANT token from breakpoint- or state-specific local overrides. Do NOT use when: extracting the base state (use action:"extract_token"), or passing legacy baseTokenName/variantState — use \`sourceTokenName\` + \`state\`. Returns: new tokenId. Side effects: push. Example: {action:"extract_variant",label:"extract-hover",projectSlug:"my-site",sourceTokenName:"button",state:":hover",newTokenName:"button-hover",instanceIds:["abc"]}\n[PATTERN] \`state\` is a CSS selector WITH its leading colon (":hover", "::before", "[data-state=open]"). A bare "hover" is a dead state that never triggers; recoverable forms are auto-coerced + hinted since v2.10.10. See pattern "state-selector-format".`,
  delete_token: `Use when: remove a token from the project (uninstall after attach). Do NOT use when: token still attached (use action:"detach_token" first). Returns: confirmation. Side effects: push, CRITICAL — context required, instances using this token lose their styles. Example: {action:"delete_token",label:"drop-legacy",projectSlug:"my-site",tokenName:"old-primary",context:"Removing the deprecated primary color token now superseded by the new design system token migrated to all instances last week",dryRun:true}`,
  bulk_rename_token_names: `Use when: rename N tokens at once via regex, for semantic renames. Do NOT use when: migrating selections to a different token (use action:"migrate_token_selections"). Pass {fromPattern, toReplacement, flags?, nameContains?}. Returns: renamed count. Side effects: push, CRITICAL — context required, project-wide. Example: {action:"bulk_rename_token_names",label:"rename-prefix",projectSlug:"my-site",fromPattern:"^old-",toReplacement:"brand-",context:"Standardising the token names to align with the new design system convention agreed during the 2026 rebrand kickoff meeting",dryRun:true}`,
  migrate_token_selections: `Use when: REPLACE every selection of token A with token B (instances using A start using B). Do NOT use when: just renaming names (use action:"bulk_rename_token_names"). Returns: instances migrated count. Side effects: push, CRITICAL — context required, project-wide. Example: {action:"migrate_token_selections",label:"migrate-token",projectSlug:"my-site",fromTokenName:"old-primary",toTokenName:"brand-primary",context:"Migrating all instance selections from the legacy primary token to the new brand primary token as part of the design system rebrand",dryRun:true}`,
  dedupe_locals: `Use when: POST-HOC sweep after applying a token — remove local decls made redundant by the token. Do NOT use when: removing orphan locals (use action:"cleanup_orphan_locals"). Scans instances using the token; a local decl is redundant when it matches the token value (the token decl is kept). Returns: per-instance dedupe report. Side effects: push; idempotent. Example: {action:"dedupe_locals",label:"dedupe-primary",projectSlug:"my-site",tokenName:"primary",dryRun:true}`,
  cleanup_orphan_locals: `Use when: remove orphan local styleSources no longer selected by any instance. Do NOT use when: deduping redundant locals covered by a token (use action:"dedupe_locals"). Orphans accumulate after deletes/refactors. Returns: orphan styleSources removed count. Side effects: push; idempotent. Example: {action:"cleanup_orphan_locals",label:"cleanup-orphans",projectSlug:"my-site",dryRun:true}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  define_local: async (i: Record<string, unknown>) => defineTokenTool.handler(strip(i)),
  list_local: async (i: Record<string, unknown>) => listTokensTool.handler(strip(i)),
  init_brand_kit: async (i: Record<string, unknown>) => initBrandTokensTool.handler(strip(i)),
  sync_local: async (i: Record<string, unknown>) => syncLocalTokensTool.handler(strip(i)),
  create_tokens: async (i: Record<string, unknown>) => createTokensTool.handler(strip(i)),
  list_tokens_cloud: async (i: Record<string, unknown>) => listTokensCloudTool.handler(strip(i)),
  update_token_styles: async (i: Record<string, unknown>) => updateTokenStylesTool.handler(strip(i)),
  delete_token_decl: async (i: Record<string, unknown>) => deleteTokenDeclTool.handler(strip(i)),
  attach_token: async (i: Record<string, unknown>) => applyTokenToInstancesTool.handler(strip(i)),
  detach_token: async (i: Record<string, unknown>) => detachTokenFromInstancesTool.handler(strip(i)),
  extract_token: async (i: Record<string, unknown>) => extractTokenFromInstancesTool.handler(strip(i)),
  extract_variant: async (i: Record<string, unknown>) => extractVariantTokenTool.handler(strip(i)),
  delete_token: async (i: Record<string, unknown>) => deleteTokenTool.handler(strip(i)),
  bulk_rename_token_names: async (i: Record<string, unknown>) => bulkRenameTokensTool.handler(strip(i)),
  migrate_token_selections: async (i: Record<string, unknown>) => replaceTokenTool.handler(strip(i)),
  dedupe_locals: async (i: Record<string, unknown>) => dedupeTokenLocalsTool.handler(strip(i)),
  cleanup_orphan_locals: async (i: Record<string, unknown>) => cleanupOrphanLocalsTool.handler(strip(i)),
};

export const tokensTool: ToolModule = {
  definition: {
    name: "tokens",
    description: `Mega-tool for design token lifecycle. 17 actions covering local registry, cloud lifecycle, attach/detach, extract/variant, rename/migrate, delete, dedupe/cleanup. Tiered safety: delete_token + bulk_rename_token_names + migrate_token_selections are CRITICAL (project-wide impact — context required). v2: all single-form sugar removed.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "define_local", description: D.define_local, zod: defineTokenInputSchema },
      { action: "list_local", description: D.list_local, zod: listTokensInputSchema },
      { action: "init_brand_kit", description: D.init_brand_kit, zod: initBrandTokensInputSchema },
      { action: "sync_local", description: D.sync_local, zod: syncLocalTokensInputSchema },
      { action: "create_tokens", description: D.create_tokens, zod: createTokensInputSchema },
      { action: "list_tokens_cloud", description: D.list_tokens_cloud, zod: listTokensCloudInputSchema },
      { action: "update_token_styles", description: D.update_token_styles, zod: updateTokenStylesInputSchema },
      { action: "delete_token_decl", description: D.delete_token_decl, zod: deleteTokenDeclInputSchema },
      { action: "attach_token", description: D.attach_token, zod: applyTokenToInstancesInputSchema },
      { action: "detach_token", description: D.detach_token, zod: detachTokenFromInstancesInputSchema },
      { action: "extract_token", description: D.extract_token, zod: extractTokenFromInstancesInputSchema },
      { action: "extract_variant", description: D.extract_variant, zod: extractVariantTokenInputSchema },
      { action: "delete_token", description: D.delete_token, zod: deleteTokenInputSchema },
      { action: "bulk_rename_token_names", description: D.bulk_rename_token_names, zod: bulkRenameTokensInputSchema },
      { action: "migrate_token_selections", description: D.migrate_token_selections, zod: replaceTokenInputSchema },
      { action: "dedupe_locals", description: D.dedupe_locals, zod: dedupeTokenLocalsInputSchema },
      { action: "cleanup_orphan_locals", description: D.cleanup_orphan_locals, zod: cleanupOrphanLocalsInputSchema },
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
    logContext({ tool: "tokens", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });
    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
