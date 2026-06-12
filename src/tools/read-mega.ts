// Mega-tool `read` — v2.0. Read-only build inspection.
//
// Tier mapping: all READ-ONLY.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { errorResult } from "./types.js";
import { validateContext, logContext, type Tier } from "../lib/context-validator.js";
import { validateLabel } from "../lib/action-label.js";
import { dispatchAction } from "../lib/mega-tool.js";
import { buildJsonSchemaFromZodActions } from "../lib/zod-action-def.js";
import { fetchPagesTool, fetchPagesInputSchema } from "./pages/fetch.js";
import { listInstancesTool, listInstancesInputSchema } from "./list-instances.js";
import { readTextsTool, readTextsInputSchema } from "./read-texts.js";
import { inspectTool, inspectInputSchema } from "./inspect.js";
import { captureSnapshot, captureSnapshotMulti, snapshotInputSchema, type Breakpoint } from "../lib/snapshot.js";

const TIER: Record<string, Tier> = {
  fetch_pages: "READ-ONLY",
  list_instances: "READ-ONLY",
  read_texts: "READ-ONLY",
  inspect: "READ-ONLY",
  snapshot: "READ-ONLY",
};

const Base = z.object({ action: z.string(), label: z.string(), context: z.string().optional() });
const Schema = z.discriminatedUnion("action", [
  Base.extend({ action: z.literal("fetch_pages") }).passthrough(),
  Base.extend({ action: z.literal("list_instances") }).passthrough(),
  Base.extend({ action: z.literal("read_texts") }).passthrough(),
  Base.extend({ action: z.literal("inspect") }).passthrough(),
  Base.extend({ action: z.literal("snapshot") }).passthrough(),
]);

const DESCRIPTIONS = {
  fetch_pages: `Use when: list a project's pages flat (id, path, name, rootInstanceId). Do NOT use when: needing folder hierarchy (use pages.list_folders). Returns: array. Side effects: none. Example: {action:"fetch_pages",label:"audit-pages",projectSlug:"my-site"}`,
  list_instances: `Use when: list instances in a page (filtered by component, tag, label substring). Do NOT use when: needing only text content (use action:"read_texts"). Returns: array of {id, component, tag, label, children}. Side effects: none. Example: {action:"list_instances",label:"audit-cards",projectSlug:"my-site",pagePath:"/",component:"Box",labelContains:"card"}`,
  read_texts: `Use when: extract all text nodes from a page (or subtree) for translation, audit, or text replacement. Do NOT use when: needing the full instance tree (use action:"list_instances"). Returns: array of {instanceId, text, path}. Side effects: none. Example: {action:"read_texts",label:"extract-fr",projectSlug:"my-site",pagePath:"/"}`,
  inspect: `Use when: inspect ONE instance, form, or resource in depth; the resource target EXECUTES it. Do NOT use when: scanning many items (use action:"list_instances"). Returns: by target — "instance" ((pageId | pagePath) + instanceIds): props + styles + immediate children summary; "form" ((pageId | pagePath)): form fields, action, method, validation for every <Form> in scope; "resource" ((resourceId | resourceName)): executes the HTTP resource, returns response shape + sample data. Side effects: none for instance/form, network read for resource. Example:
  {action:"inspect",label:"inspect-hero",projectSlug:"my-site",target:"instance",pagePath:"/",instanceIds:["abc"]}
  {action:"inspect",label:"inspect-form",projectSlug:"my-site",target:"form",pagePath:"/contact"}
  {action:"inspect",label:"exec-bikes",projectSlug:"my-site",target:"resource",resourceName:"bikes-list"}`,
  snapshot: `Use when: capture PNG screenshot(s) of one instance at one or many breakpoints via the builder. Do NOT use when: needing full-page only or visual diff without an instanceId (no full-page mode yet). Returns: content array with a metadata text + one image entry per captured breakpoint (type:"image", base64 PNG, mimeType:"image/png"). Side effects: 5-10s capture per call (Chromium launch + canvas hydration); targets the instance's data-ws-id on the Webstudio builder canvas (Playwright headless); pass a single \`breakpoint\` for 1 capture, or a \`breakpoints\` array (e.g. ["Base","Tablet","Mobile"]) for multi-breakpoint capture in one browser session (~5-7s total, faster than 3 separate calls). Example single: {action:"snapshot",label:"check-hero",projectSlug:"my-site",instanceId:"abc",breakpoint:"Base"}. Example multi: {action:"snapshot",label:"check-responsive",projectSlug:"my-site",instanceId:"abc",breakpoints:["Base","Tablet","Mobile"]}`,
};

const strip = (input: Record<string, unknown>): Record<string, unknown> => {
  const { action: _a, label: _l, context: _c, ...rest } = input;
  void _a; void _l; void _c;
  return rest;
};

const HANDLERS = {
  fetch_pages: async (i: Record<string, unknown>) => fetchPagesTool.handler(strip(i)),
  list_instances: async (i: Record<string, unknown>) => listInstancesTool.handler(strip(i)),
  read_texts: async (i: Record<string, unknown>) => readTextsTool.handler(strip(i)),
  inspect: async (i: Record<string, unknown>) => inspectTool.handler(strip(i)),
  snapshot: async (input: Record<string, unknown>) => {
    const stripped = strip(input);
    const projectSlug = String(stripped.projectSlug ?? "");
    const instanceId = String(stripped.instanceId ?? "");
    if (!projectSlug || !instanceId) {
      return errorResult("VALIDATION_FAILED", "snapshot requires projectSlug + instanceId");
    }

    if (Array.isArray(stripped.breakpoints) && stripped.breakpoints.length > 0) {
      const breakpoints = stripped.breakpoints as Breakpoint[];
      try {
        const multi = await captureSnapshotMulti(projectSlug, instanceId, breakpoints);
        if (!multi.ok) return errorResult("INTERNAL_ERROR", `[${multi.code}] ${multi.error}`);
        const summary = multi.entries.map((e) => {
          const sizeKB = Math.round(e.png.length * 0.75 / 1024);
          return `  - ${e.breakpoint}: ${e.width}×${e.height}px, ${sizeKB}KB`;
        }).join("\n");
        const missing = breakpoints.filter((bp) => !multi.entries.find((e) => e.breakpoint === bp));
        const missingNote = missing.length > 0 ? `\nMissing breakpoints: ${missing.join(", ")} (instance not rendered or 0×0 at that viewport)` : "";
        return {
          content: [
            { type: "text" as const, text: `Multi-snapshot captured (${multi.entries.length}/${breakpoints.length}):\n${summary}\n\ncapturedAt: ${multi.capturedAt}\ninstanceId: ${instanceId}${missingNote}` },
            ...multi.entries.map((e) => ({ type: "image" as const, data: e.png, mimeType: "image/png" as const })),
          ],
        };
      } catch (err) {
        return errorResult("INTERNAL_ERROR", `snapshot multi failed: ${(err as Error).message}`);
      }
    }

    const breakpoint = (stripped.breakpoint as Breakpoint | undefined) ?? "Base";
    try {
      const result = await captureSnapshot(projectSlug, instanceId, breakpoint);
      if (!result.ok) return errorResult("INTERNAL_ERROR", `[${result.code}] ${result.error}`);
      const sizeKB = Math.round(result.png.length * 0.75 / 1024);
      return {
        content: [
          { type: "text" as const, text: `Snapshot captured: ${result.width}×${result.height}px, ${sizeKB}KB.\n\ncapturedAt: ${result.capturedAt}\nbreakpoint: ${breakpoint}\ninstanceId: ${instanceId}` },
          { type: "image" as const, data: result.png, mimeType: "image/png" },
        ],
      };
    } catch (err) {
      return errorResult("INTERNAL_ERROR", `snapshot failed: ${(err as Error).message}`);
    }
  },
};

export const readTool: ToolModule = {
  definition: {
    name: "read",
    description: `Mega-tool for read-only build inspection. 5 actions: fetch_pages, list_instances, read_texts, inspect, snapshot. All actions are side-effect-free (snapshot does a Chromium launch + page navigation).`,
    inputSchema: buildJsonSchemaFromZodActions([
      { action: "fetch_pages", description: DESCRIPTIONS.fetch_pages, zod: fetchPagesInputSchema },
      { action: "list_instances", description: DESCRIPTIONS.list_instances, zod: listInstancesInputSchema },
      { action: "read_texts", description: DESCRIPTIONS.read_texts, zod: readTextsInputSchema },
      { action: "inspect", description: DESCRIPTIONS.inspect, zod: inspectInputSchema },
      { action: "snapshot", description: DESCRIPTIONS.snapshot, zod: snapshotInputSchema },
    ]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    logContext({ tool: "read", action: input.action, tier, context: input.context, projectSlug: (input as { projectSlug?: string }).projectSlug });

    return dispatchAction(input, HANDLERS);
  },
};
