// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HANDLER — dispatched via webstudio_audit(kind:"radix-trigger-pollution").
//
// NOT exposed as a standalone tool in the MCP manifest. Reached through
// src/tools/audit.ts. The description on this file is irrelevant — the
// dispatcher's description wins. Adding new audit kinds: register a new entry
// in src/tools/audit.ts → KIND_TO_TOOL.
// ─────────────────────────────────────────────────────────────────────────────
// Audit kind: radix-trigger-pollution
//
// Scans the entire project build for Radix non-rendering wrappers
// (DialogTrigger, PopoverTrigger, SheetTrigger, NavigationMenuLink, Slot,
// *Portal, *Close, AccordionTrigger, TooltipTrigger, DropdownMenuTrigger,
// see src/lib/radix-wrappers.ts) that carry forbidden presentation props
// (class, className, style, id) OR local styles. These pollutions cause the
// SPA-navigation class-hash drop bug — cf. docs/patterns/sheet-mobile-radix.md
// § Major pitfall.
//
// Read-only. Suggests the first rendering descendant as the migration target.

import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";
import {
  isNonRenderingWrapper,
  BLOCKED_PRESENTATION_PROPS,
} from "../lib/radix-wrappers.js";

export const auditRadixTriggerPollutionInputSchema = z.object({
  projectSlug: z.string(),
  verbose: z.boolean().default(false),
}).strict();

type BuildInstance = WebstudioBuild["instances"][number];

export type RadixPollutionFinding = {
  instance: BuildInstance;
  pollutedProps: { name: string; value: unknown }[];
  hasLocalStyles: boolean;
  styleSourceCount: number;
  firstRenderingChild: BuildInstance | null;
};

/** Descend through children (id type only) until we find a component that
 *  actually renders DOM. Returns null if every descendant is also a wrapper
 *  or the parent has no id-children (rare — a polluted wrapper with no child
 *  to migrate to is itself a misconfig). Exported for testing. */
export function findFirstRenderingChild(build: WebstudioBuild, parent: BuildInstance): BuildInstance | null {
  const queue: BuildInstance[] = [parent];
  const seen = new Set<string>([parent.id]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const c of cur.children) {
      if (c.type !== "id" || seen.has(c.value)) continue;
      const child = build.instances.find((i) => i.id === c.value);
      if (!child) continue;
      seen.add(child.id);
      if (!isNonRenderingWrapper(child.component)) return child;
      queue.push(child);
    }
  }
  return null;
}

/** Exported for testing. Returns null when the wrapper is clean. */
export function scanInstance(build: WebstudioBuild, inst: BuildInstance): RadixPollutionFinding | null {
  const props = build.props.filter((p) => p.instanceId === inst.id);
  const pollutedProps = props
    .filter((p) => BLOCKED_PRESENTATION_PROPS.has(p.name))
    .map((p) => ({ name: p.name, value: p.value }));

  const selection = build.styleSourceSelections.find((s) => s.instanceId === inst.id);
  const styleSourceCount = selection?.values.length ?? 0;
  const hasLocalStyles = styleSourceCount > 0;

  if (pollutedProps.length === 0 && !hasLocalStyles) return null;

  return {
    instance: inst,
    pollutedProps,
    hasLocalStyles,
    styleSourceCount,
    firstRenderingChild: findFirstRenderingChild(build, inst),
  };
}

function shortComponent(component: string): string {
  return component.includes(":") ? component.split(":").pop() ?? component : component;
}

function renderFinding(f: RadixPollutionFinding, verbose: boolean): string {
  const inst = f.instance;
  const cName = shortComponent(inst.component);
  const label = inst.label ? ` "${inst.label}"` : "";
  const lines: string[] = [];
  lines.push(`• ${cName}${label} (id: ${inst.id})`);
  for (const p of f.pollutedProps) {
    const valStr = verbose ? ` = ${JSON.stringify(p.value)}` : "";
    lines.push(`  ✗ prop "${p.name}"${valStr}`);
  }
  if (f.hasLocalStyles) {
    lines.push(`  ✗ ${f.styleSourceCount} style source(s) attached (local/token)`);
  }
  if (f.firstRenderingChild) {
    const c = f.firstRenderingChild;
    const cLabel = c.label ? ` "${c.label}"` : "";
    lines.push(`  → move to: ${shortComponent(c.component)}${cLabel} (id: ${c.id})`);
  } else {
    lines.push(`  → no rendering descendant found — this wrapper has no Button/Link child to migrate to (broken structure).`);
  }
  return lines.join("\n");
}

export const auditRadixTriggerPollutionTool: ToolModule = {
  definition: {
    name: "webstudio_audit_radix_trigger_pollution",
    description: `INTERNAL — dispatched via webstudio_audit({ kind: "radix-trigger-pollution" }).
Scans all Radix non-rendering wrappers (DialogTrigger, *Portal, *Close, NavigationMenuLink, Slot, ...) for forbidden presentation props (class, className, style, id) or local style attachments — root cause of the SPA-navigation class-hash drop bug (see sheet-mobile-radix.md § Major pitfall).
Returns a markdown report with one entry per polluted instance + the suggested migration target (first rendering descendant). Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        verbose: { type: "boolean", description: "Include prop values in the output (default false)." },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
  },
  handler: async (args) => {
    const parsed = auditRadixTriggerPollutionInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const { projectSlug, verbose } = parsed.data;

    let auth;
    try { auth = requireAuth(projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const wrappers = build.instances.filter((i) => isNonRenderingWrapper(i.component));
    const findings = wrappers
      .map((inst) => scanInstance(build, inst))
      .filter((f): f is RadixPollutionFinding => f !== null);

    const projectTitle = build.project?.title ?? projectSlug;
    if (findings.length === 0) {
      return textResult(
        `# Radix trigger pollution — ${projectTitle}\n\n` +
        `✓ Clean. Scanned ${wrappers.length} non-rendering wrapper instance(s); none carry forbidden presentation props or local styles.\n`,
      );
    }

    const report = [
      `# Radix trigger pollution — ${projectTitle}`,
      ``,
      `Scanned ${wrappers.length} non-rendering wrapper(s) (DialogTrigger, *Portal, *Close, NavigationMenuLink, Slot, etc.).`,
      `Found ${findings.length} polluted instance(s) — these will likely cause the SPA-navigation class-hash drop bug.`,
      ``,
      `## Findings`,
      ``,
      findings.map((f) => renderFinding(f, verbose)).join("\n\n"),
      ``,
      `## Fix`,
      ``,
      `For each finding, move the prop/style from the wrapper to the listed rendering descendant.`,
      `Use webstudio_instance_prop({action:"delete"}) to remove from the wrapper, then webstudio_instance_prop({action:"update"}) on the child. For styles, use webstudio_styles({action:"delete-decl"}) + webstudio_styles({action:"update"}). Pattern: docs/patterns/sheet-mobile-radix.md § Major pitfall.`,
    ].join("\n");

    return textResult(report);
  },
};
