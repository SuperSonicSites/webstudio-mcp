// Mega-tool `auth` — v2.0. Local credential management (no Webstudio Cloud push).
//
// Tier mapping:
//   - setup, allow_push  → STRUCTURING (local config changes)
//   - update_app_version → TACTICAL
// No CRITICAL — these tools only touch local ~/.webstudio-mcp/projects/<slug>/ files.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import {
  setupAuthTool, allowPushTool, updateAppVersionTool,
  setupAuthInputSchema, allowPushInputSchema, updateAppVersionInputSchema,
} from "./auth-tools.js";

const TIER: Record<string, Tier> = {
  setup: "STRUCTURING",
  allow_push: "STRUCTURING",
  update_app_version: "TACTICAL",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("setup") }).passthrough(),
  Base.extend({ action: z.literal("allow_push") }).passthrough(),
  Base.extend({ action: z.literal("update_app_version") }).passthrough(),
]);

const DESCRIPTIONS = {
  setup: `Use when: register Webstudio credentials for a project in local config. Do NOT use when: project already authed and just toggling push permission (use action:"allow_push"). Returns: confirmation + local path. Side effects: writes credentials (cookie + csrfToken + webstudioProjectId + appVersion) to ~/.webstudio-mcp/projects/<slug>/webstudio-auth.json. Example: {action:"setup",label:"auth-my-site",projectSlug:"my-site",webstudioProjectId:"xxxx",cookie:"...",csrfToken:"...",allowPush:true}`,
  allow_push: `Use when: enable or disable push permission for an already-authed project. Do NOT use when: setting up auth from scratch (use action:"setup"). Returns: new allowPush state. Side effects: writes to local auth file. Note: safety toggle — the session cookie grants access to ALL projects, so allowPush prevents accidental pushes to the wrong slug. Example: {action:"allow_push",label:"enable-push",projectSlug:"my-site",allow:true}`,
  update_app_version: `Use when: bump the stored Webstudio appVersion after Cloud releases a new build hash. Do NOT use when: VERSION_MISMATCHED was already auto-resolved — appVersion (the x-webstudio-client-version header) is auto-fetched on push retry (v1.2+), so a manual call is rarely needed. Returns: new version + previous. Side effects: writes to local auth file. Example: {action:"update_app_version",label:"bump-version",projectSlug:"my-site",appVersion:"abc123def456..."}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  setup: async (i: Record<string, unknown>) => setupAuthTool.handler(strip(i)),
  allow_push: async (i: Record<string, unknown>) => allowPushTool.handler(strip(i)),
  update_app_version: async (i: Record<string, unknown>) => updateAppVersionTool.handler(strip(i)),
};

export const authTool: ToolModule = {
  definition: {
    name: "auth",
    description: `Mega-tool for local Webstudio credential management. 3 actions: setup, allow_push, update_app_version. Operates on ~/.webstudio-mcp/projects/<slug>/. No network mutations — these touch local files only.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "setup", description: DESCRIPTIONS.setup, zod: setupAuthInputSchema },
      { action: "allow_push", description: DESCRIPTIONS.allow_push, zod: allowPushInputSchema },
      { action: "update_app_version", description: DESCRIPTIONS.update_app_version, zod: updateAppVersionInputSchema },
    ]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    logContext({ tool: "auth", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });

    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
