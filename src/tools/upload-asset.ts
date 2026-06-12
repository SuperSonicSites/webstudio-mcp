// Tool: webstudio_upload_asset — upload an image or font asset to a Webstudio project.
//
// Workflow (reverse-engineered from the builder):
//   1. POST /rest/assets (multipart) with metadata { assetId=sha256, projectId, type, filename }
//   2. POST /rest/assets/<name> with raw binary body + content-type=<mime>
//
// The asset id is the sha256 hex digest of the file content — pre-computed client-side.
// Re-uploading the exact same bytes is idempotent (same id → same asset).

import { z } from "zod";
import { createHash } from "node:crypto";
import type { ToolModule } from "./types.js";
import { textResult, errorResult, authErrorResult } from "./types.js";
import { requireAuth, requirePushAuth } from "../auth.js";
import { fetchBuild, invalidateBuildCache } from "../webstudio-client.js";
import { findAssetById } from "../lib/asset-helpers.js";
import { MIME_TO_TYPE, detectMime } from "./upload-asset/mime.js";
import { resolveBuffer } from "./upload-asset/io.js";
import { registerAsset, uploadAssetBytes } from "./upload-asset/http.js";

export const uploadAssetInputSchema = z
  .object({
    projectSlug: z.string(),
    filePath: z.string().optional(),
    base64Content: z.string().optional(),
    url: z.string().url().optional(),
    filename: z.string().optional(),
    contentType: z.string().optional(),
    dedupe: z.boolean().default(true),
    dryRun: z.boolean().default(false),
  }).strict()
  .refine(
    (v) => [v.filePath, v.base64Content, v.url].filter((x) => x !== undefined).length === 1,
    { message: "Provide exactly one of filePath, base64Content, or url." },
  );

export const uploadAssetTool: ToolModule = {
  definition: {
    name: "webstudio_upload_asset",
    description: `Use when: upload an IMAGE or FONT asset (webp/png/jpg/svg/avif/woff/woff2/ttf) to a Webstudio project. Returns the assetId (sha256 hex) — pass it to webstudio_instance_prop with type="asset" to bind on an Image's src.
Do NOT use when: the asset is already uploaded (check first with webstudio_list_assets or webstudio_find_asset_usage; dedupe=true does this automatically). To swap an existing asset reference project-wide, use webstudio_replace_asset (no upload). To remove an asset, use webstudio_delete_assets (accepts 1 or N ids/prefixes).
Returns: dry-run with computed assetId + dedupe hit (if any) OR upload result with {assetId, registeredName, served URL /cgi/asset/<name>}. Idempotent — same bytes → same sha256 → same asset id.
Provide EXACTLY ONE of: filePath (local absolute path), base64Content (+ filename required), or url (remote URL fetched then uploaded). MIME auto-detected from extension; override via contentType. dedupe=true (default) skips re-upload if assetId already exists in the project.
Side effects: push to Webstudio Cloud (requires allowPush). dryRun=false by default for this tool — set dryRun=true to preview.

Example: { projectSlug: "acme", filePath: "/tmp/hero.webp" }
Example: { projectSlug: "my-site", url: "https://drive.google.com/u/0/uc?id=...", filename: "logo.svg", contentType: "image/svg+xml" }`,
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: { type: "string" },
        filePath: { type: "string", description: "Local absolute path to the file. One of filePath/base64Content/url required." },
        base64Content: { type: "string", description: "Base64-encoded content. Requires filename + ideally contentType." },
        url: { type: "string", description: "Remote URL to fetch then upload (e.g. signed Drive URL)." },
        filename: { type: "string", description: "Filename visible in Webstudio (e.g. 'photo.webp'). Derived from filePath/url if omitted." },
        contentType: { type: "string", description: "MIME type (e.g. 'image/webp'). Auto-detected from filename extension if omitted." },
        dedupe: { type: "boolean", description: "Skip upload if assetId (sha256) already exists in the project (default true)." },
        dryRun: { type: "boolean" },
      },
      required: ["projectSlug"],
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
    const parsed = uploadAssetInputSchema.safeParse(args);
    if (!parsed.success) return errorResult("VALIDATION_FAILED", `Validation error: ${parsed.error.message}`);
    const input = parsed.data;

    let buffer: Buffer;
    let filename: string;
    try {
      ({ buffer, filename } = await resolveBuffer(input));
    } catch (err) {
      return errorResult("VALIDATION_FAILED", `Could not read file: ${(err as Error).message}`);
    }

    const mime = detectMime(filename, input.contentType);
    if (!mime) {
      return errorResult(
        "VALIDATION_FAILED",
        `Could not detect MIME type for "${filename}". Pass contentType explicitly (e.g. "image/webp").`,
      );
    }
    const assetType = MIME_TO_TYPE[mime];
    if (!assetType) {
      return errorResult(
        "VALIDATION_FAILED",
        `Unsupported MIME type "${mime}". Supported: ${Object.keys(MIME_TO_TYPE).join(", ")}.`,
      );
    }

    const assetId = createHash("sha256").update(buffer).digest("hex");
    const sizeKB = (buffer.byteLength / 1024).toFixed(1);

    // Dedup check: compute the sha256 and look it up in the project's existing assets.
    let existingAsset: { id: string; name: string } | undefined;
    if (input.dedupe) {
      try {
        const readAuth = input.dryRun ? requireAuth(input.projectSlug) : requirePushAuth(input.projectSlug);
        const build = await fetchBuild(readAuth);
        existingAsset = findAssetById(build, assetId) as typeof existingAsset;
      } catch {
        // Non-fatal — fall through to normal upload path.
      }
    }

    if (input.dryRun) {
      const dedupNote = existingAsset
        ? `\n\n♻ Asset already exists (dedupe match):\n  name: ${existingAsset.name}\n  → upload would be skipped, existing assetId returned.`
        : "";
      return textResult(`DRY-RUN upload_asset

File:      ${filename}
Size:      ${sizeKB} KB (${buffer.byteLength} bytes)
MIME:      ${mime}
Type:      ${assetType}
assetId:   ${assetId}${dedupNote}

If OK, re-run with dryRun=false to upload.`);
    }

    if (existingAsset) {
      return textResult(
        `Asset already in project (dedupe hit) — no upload performed.\n  filename:  ${filename}\n  size:      ${sizeKB} KB\n  assetId:   ${assetId}\n  name:      ${existingAsset.name}\n  served at: /cgi/asset/${existingAsset.name}\n\nPass dedupe=false to force re-upload.`,
      );
    }

    let auth;
    try {
      auth = requirePushAuth(input.projectSlug);
    } catch (err) {
      return authErrorResult(err);
    }

    // Server state is about to change (or may change even on failure — outcome
    // unknown on thrown errors): drop the cached build before the first POST,
    // mirroring applyTransaction. Otherwise reads within the cache TTL
    // (replace_asset, pages.update_meta, dedupe) can't see the new asset.
    invalidateBuildCache(auth.projectId);

    const reg = await registerAsset(auth, assetId, assetType, filename);
    if (!reg.ok) return reg.result;

    const up = await uploadAssetBytes(auth, reg.registeredName, buffer, mime);
    if (!up.ok) return up.result;

    return textResult(`Asset uploaded
  filename:  ${filename}
  size:      ${sizeKB} KB
  mime:      ${mime}
  type:      ${assetType}
  assetId:   ${assetId}
  name:      ${reg.registeredName}
  served at: /cgi/asset/${reg.registeredName}

To bind on an Image src:
  webstudio_instance_prop({
    projectSlug: "${input.projectSlug}",
    updates: [{ instanceId: "<id>", propName: "src", type: "asset", value: "${assetId}" }]
  })`);
  },
};
