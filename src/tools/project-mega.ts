// Mega-tool `project` — v2.0. Project lifecycle.
//
// Tier mapping:
//   - init           → STRUCTURING
//   - list           → READ-ONLY
//   - export         → READ-ONLY (writes a dump file, but no mutation on Webstudio side)
//   - nuke           → CRITICAL (project-wide wipe, irreversible)
//   - import_figma   → STRUCTURING (bulk variable import)

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { initProjectTool, listProjectsTool, initProjectInputSchema, listProjectsInputSchema } from "./projects.js";
import { exportProjectTool, exportProjectInputSchema } from "./export-project.js";
import { nukeProjectTool, nukeProjectInputSchema } from "./nuke-project.js";
import { importFigmaVariablesTool, importFigmaVariablesInputSchema } from "./import-figma-variables.js";

const TIER: Record<string, Tier> = {
  init: "STRUCTURING",
  list: "READ-ONLY",
  export: "READ-ONLY",
  nuke: "CRITICAL",
  import_figma: "STRUCTURING",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("init") }).passthrough(),
  Base.extend({ action: z.literal("list") }).passthrough(),
  Base.extend({ action: z.literal("export") }).passthrough(),
  Base.extend({ action: z.literal("nuke") }).passthrough(),
  Base.extend({ action: z.literal("import_figma") }).passthrough(),
]);

const DESCRIPTIONS = {
  init: `Use when: register a new Webstudio project in local config, mapping a slug to its projectId. Do NOT use when: project already registered (use auth.setup to update credentials). Returns: confirmation + local path. Side effects: writes ~/.webstudio-mcp/projects/<slug>/ (stores webstudioProjectId, prepares tokens.json). Example: {action:"init",label:"init-my-site",projectSlug:"my-site",webstudioProjectId:"...",projectName:"a production site"}`,
  list: `Use when: list all locally registered Webstudio projects. Do NOT use when: needing live data from Webstudio Cloud (this is local config only). Returns: array of {slug, projectName, webstudioProjectId, allowPush}. Side effects: none. Example: {action:"list",label:"list-projects"}`,
  export: `Use when: dump a project's full build state to a local JSON file for inspection or backup. Do NOT use when: wanting to read a specific subset (use read.fetch_pages or read.list_instances). Returns: path of the written dump + summary stats; dump covers pages, instances, props, styles, tokens, dataSources, resources. Side effects: writes to local disk (./backups/). Example: {action:"export",label:"backup-my-site",projectSlug:"my-site"}`,
  nuke: `Use when: wipe entire scopes of a project — destructive, project-wide cleanup. Do NOT use when: removing specific items (use pages.delete, assets.delete, etc.). Wipeable scopes: pages, instances, tokens, assets, resources, variables — typical use is cleanup after a botched experiment. Confirm must equal projectSlug verbatim. Returns: pre-flight summary OR final wipe report. Side effects: push to Webstudio Cloud, CRITICAL — context required, MASSIVE destruction. Example: {action:"nuke",label:"wipe-experiment",projectSlug:"my-site",confirm:"my-site",scope:{pages:true,instances:true},context:"Cleaning up the failed experimental builder branch with 200 orphan instances before re-importing the canonical pages from the production backup file",dryRun:true}`,
  import_figma: `Use when: bulk-import design tokens from a Figma Variables JSON export (colors, spacing, typography). Do NOT use when: adding 1 token (use tokens.create_tokens). Returns: per-collection import report. Side effects: push to Webstudio Cloud. dryRun defaults true. Example: {action:"import_figma",label:"import-brand-tokens",projectSlug:"my-site",variables:{"the project/color/primary":"#82BB25"},prefix:"brand"}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  init: async (i: Record<string, unknown>) => initProjectTool.handler(strip(i)),
  list: async (i: Record<string, unknown>) => listProjectsTool.handler(strip(i)),
  export: async (i: Record<string, unknown>) => exportProjectTool.handler(strip(i)),
  nuke: async (i: Record<string, unknown>) => nukeProjectTool.handler(strip(i)),
  import_figma: async (i: Record<string, unknown>) => importFigmaVariablesTool.handler(strip(i)),
};

export const projectTool: ToolModule = {
  definition: {
    name: "project",
    description: `Mega-tool for project lifecycle. 5 actions: init, list, export, nuke, import_figma. nuke is CRITICAL — context required, can wipe pages/instances/tokens/assets/resources/variables at project scope.`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "init", description: DESCRIPTIONS.init, zod: initProjectInputSchema },
      { action: "list", description: DESCRIPTIONS.list, zod: listProjectsInputSchema },
      { action: "export", description: DESCRIPTIONS.export, zod: exportProjectInputSchema },
      { action: "nuke", description: DESCRIPTIONS.nuke, zod: nukeProjectInputSchema },
      { action: "import_figma", description: DESCRIPTIONS.import_figma, zod: importFigmaVariablesInputSchema },
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
    logContext({ tool: "project", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });

    const result = await dispatchAction(input, HANDLERS);
    if (ctxCheck.ok && ctxCheck.hint && !result.isError) {
      const first = result.content[0];
      if (first?.type === "text") first.text = `${first.text}\n\n[hint] ${ctxCheck.hint}`;
    }
    return result;
  },
};
