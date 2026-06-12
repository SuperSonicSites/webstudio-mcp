// Tool: webstudio_export_project
//
// Dump the entire Webstudio build to a JSON file on disk: pages, folders, instances,
// props, styles, styleSources, styleSourceSelections, dataSources, resources, assets,
// breakpoints, plus project metadata.
//
// Intended uses:
//   - One-shot backup before a destructive operation (typically called by
//     webstudio_nuke_project when `exportBackupTo` is set).
//   - Ad-hoc archive for diffing or external tooling.
//
// Read-only on Webstudio side (just calls fetchBuild). Writes one file locally.

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult, runtimeErrorResult } from "./types.js";
import { requireAuth } from "../auth.js";
import { fetchBuild } from "../webstudio-client.js";
import type { WebstudioBuild } from "../webstudio-client.js";

export const exportProjectInputSchema = z.object({
  projectSlug: z.string(),
  /** Output JSON file path. Default: ./backups/<slug>-<ISO timestamp>.json. */
  outputPath: z.string().optional(),
  /** Pretty-print JSON (2-space indent). Default true. */
  pretty: z.boolean().default(true),
}).strict();

export type BuildDump = {
  projectSlug: string;
  exportedAt: string;
  buildId: string;
  buildVersion: number;
  projectId: string;
  project?: WebstudioBuild["project"];
  publisherHost?: string;
  pages: WebstudioBuild["pages"];
  breakpoints: WebstudioBuild["breakpoints"];
  instances: WebstudioBuild["instances"];
  props: WebstudioBuild["props"];
  styles: WebstudioBuild["styles"];
  styleSources: WebstudioBuild["styleSources"];
  styleSourceSelections: WebstudioBuild["styleSourceSelections"];
  dataSources: WebstudioBuild["dataSources"];
  resources: WebstudioBuild["resources"];
  assets: WebstudioBuild["assets"];
  marketplaceProduct: WebstudioBuild["marketplaceProduct"];
};

/**
 * Build a structured dump of every meaningful field of a WebstudioBuild.
 * Stable shape — adding a new top-level field to WebstudioBuild should be reflected here.
 *
 * Re-usable by webstudio_nuke_project's `exportBackupTo` option.
 */
export function dumpBuild(build: WebstudioBuild, projectSlug: string): BuildDump {
  return {
    projectSlug,
    exportedAt: new Date().toISOString(),
    buildId: build.id,
    buildVersion: build.version,
    projectId: build.projectId,
    project: build.project,
    publisherHost: build.publisherHost,
    pages: build.pages,
    breakpoints: build.breakpoints,
    instances: build.instances,
    props: build.props,
    styles: build.styles,
    styleSources: build.styleSources,
    styleSourceSelections: build.styleSourceSelections,
    dataSources: build.dataSources,
    resources: build.resources,
    assets: build.assets,
    marketplaceProduct: build.marketplaceProduct,
  };
}

/** Default output path: ./backups/<slug>-<ISO timestamp>.json (timestamp is filesystem-safe). */
export function defaultExportPath(projectSlug: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return path.join("backups", `${projectSlug}-${ts}.json`);
}

/**
 * Write a build dump to disk. Creates parent directories as needed.
 * Returns the absolute path + size info for reporting.
 */
export async function writeBuildDump(
  dump: BuildDump,
  outputPath: string,
  pretty: boolean,
): Promise<{ absPath: string; sizeBytes: number; sizeMB: number }> {
  const absPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(process.cwd(), outputPath);
  const parent = path.dirname(absPath);
  await fs.mkdir(parent, { recursive: true });
  const json = JSON.stringify(dump, null, pretty ? 2 : 0);
  await fs.writeFile(absPath, json, "utf-8");
  const sizeBytes = Buffer.byteLength(json, "utf-8");
  return { absPath, sizeBytes, sizeMB: sizeBytes / (1024 * 1024) };
}

function countsLine(dump: BuildDump): string {
  return [
    `  pages:                  ${dump.pages.pages.length}`,
    `  folders:                ${(dump.pages.folders as unknown[]).length}`,
    `  instances:              ${dump.instances.length}`,
    `  props:                  ${dump.props.length}`,
    `  styles:                 ${dump.styles.length}`,
    `  styleSources:           ${dump.styleSources.length}`,
    `  styleSourceSelections:  ${dump.styleSourceSelections.length}`,
    `  dataSources:            ${(dump.dataSources as unknown[]).length}`,
    `  resources:              ${(dump.resources as unknown[]).length}`,
    `  assets:                 ${(dump.assets as unknown[]).length}`,
    `  breakpoints:            ${dump.breakpoints.length}`,
  ].join("\n");
}

export const exportProjectTool: ToolModule = {
  definition: {
    name: "webstudio_export_project",
    description: `Use when: full JSON snapshot of a Webstudio Cloud project for backup / diffing / external tooling — also auto-invoked by webstudio_nuke_project's exportBackupTo.
Do NOT use when: you only need a small slice (page tree, tokens) — use webstudio_list_instances or webstudio_audit_page. To restore a backup, there is no auto-import; paste manually via the builder.
Returns: { absPath, sizeBytes, sizeMB, counts:{pages,instances,props,styles,...} }. Dumps every namespace (pages, folders, instances, props, styles, styleSources, styleSourceSelections, dataSources, resources, assets, breakpoints + project meta).
Side effects: local mutation (writes JSON to disk). Read-only on Webstudio side.

Example: { projectSlug: "my-site" }
Example: { projectSlug: "acme", outputPath: "/tmp/acme-pre-nuke.json", pretty: false }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        outputPath: { type: "string", description: "Absolute or cwd-relative path. Defaults to ./backups/<slug>-<ISO>.json." },
        pretty: { type: "boolean" },
      },
      required: ["projectSlug"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler: async (args) => {
    const parsed = exportProjectInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const { projectSlug, outputPath, pretty } = parsed.data;

    let auth;
    try { auth = requireAuth(projectSlug); }
    catch (err) { return authErrorResult(err); }

    let build: WebstudioBuild;
    try { build = await fetchBuild(auth, { readonly: true }); }
    catch (err) { return runtimeErrorResult(err, "fetch build failed"); }

    const dump = dumpBuild(build, projectSlug);
    const target = outputPath ?? defaultExportPath(projectSlug);

    let written;
    try { written = await writeBuildDump(dump, target, pretty); }
    catch (err) { return runtimeErrorResult(err, "write dump failed"); }

    return textResult(
      `Project "${projectSlug}" (${build.project?.title ?? "?"}) exported.

  build version: ${build.version}
  file:          ${written.absPath}
  size:          ${written.sizeBytes.toLocaleString()} bytes (${written.sizeMB.toFixed(2)} MB)

Counts:
${countsLine(dump)}`,
    );
  },
};
