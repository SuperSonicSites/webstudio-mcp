// v2.20.2 — assets.upload must invalidate the build cache.
//
// Bug: upload POSTs (/rest/assets) mutate the server-side build but never
// dropped the cached copy, so for up to a full TTL replace_asset,
// pages.update_meta, and upload dedupe could not see a just-uploaded asset.
// Dry-run and dedupe-hit paths do NOT POST and must keep the cache warm.
//
// node --test runs each file in its own process — stubbing globalThis.fetch
// here cannot leak into other test files.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "upload-invalidation-"));
process.env.WEBSTUDIO_PROJECTS_DIR = tmpRoot;

const { uploadAssetTool } = await import("../dist/tools/upload-asset.js");
const { fetchBuild, invalidateBuildCache } = await import("../dist/webstudio-client.js");

const slug = "uploadproj";
const projDir = path.join(tmpRoot, slug);
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, "webstudio-auth.json"), JSON.stringify({
  projectId: "proj-up", cookie: "c=1", csrfToken: "tok", appVersion: "v1", allowPush: true,
}));

const CONFIG = { projectId: "proj-up", cookie: "c=1", csrfToken: "tok", appVersion: "v1", allowPush: true };

// 1x1 PNG-ish payload — content only matters for its sha256.
const CONTENT = Buffer.from("fake-png-bytes-for-upload-test");
const CONTENT_SHA = createHash("sha256").update(CONTENT).digest("hex");

const makeBuild = (assets = []) => ({
  id: "build-up", projectId: "proj-up", version: 3,
  instances: [{ id: "root", type: "instance", component: "Body", children: [] }],
  props: [], styles: [], assets,
});

const realFetch = globalThis.fetch;
let restDataCalls = 0;
let assetPosts = 0;
let buildAssets = [];

beforeEach(() => {
  restDataCalls = 0;
  assetPosts = 0;
  buildAssets = [];
  invalidateBuildCache();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/rest/data/")) {
      restDataCalls += 1;
      return new Response(JSON.stringify(makeBuild(buildAssets)), { status: 200 });
    }
    if (/\/rest\/assets$/.test(u)) {
      assetPosts += 1;
      return new Response(JSON.stringify({ name: "registered-name.png" }), { status: 200 });
    }
    if (u.includes("/rest/assets/")) {
      assetPosts += 1;
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u} ${init?.method ?? "GET"}`);
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

const uploadArgs = (overrides = {}) => ({
  projectSlug: slug,
  base64Content: CONTENT.toString("base64"),
  filename: "hero.png",
  ...overrides,
});

test("non-dry-run upload invalidates the cache: next read re-fetches", async () => {
  await fetchBuild(CONFIG); // prime
  assert.equal(restDataCalls, 1);

  const r = await uploadAssetTool.handler(uploadArgs({ dedupe: false }));
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  assert.equal(assetPosts, 2, "register + bytes POSTs expected");

  await fetchBuild(CONFIG);
  assert.equal(restDataCalls, 2, "post-upload read must bypass the stale cache");
});

test("upload dedupe sees an asset uploaded moments earlier (regression)", async () => {
  await fetchBuild(CONFIG); // prime the cache with the pre-upload (assetless) build
  // First upload registers the asset server-side.
  const r1 = await uploadAssetTool.handler(uploadArgs({ dedupe: false }));
  assert.notEqual(r1.isError, true, r1.content?.[0]?.text);
  buildAssets = [{ id: CONTENT_SHA, type: "image", name: "hero.png" }];

  // Second upload with dedupe=true must FETCH a fresh build (cache was
  // invalidated by the first upload) and hit the dedupe early-return.
  const r2 = await uploadAssetTool.handler(uploadArgs({ dedupe: true }));
  assert.notEqual(r2.isError, true, r2.content?.[0]?.text);
  assert.match(r2.content[0].text, /dedupe hit/);
  assert.equal(assetPosts, 2, "second upload must not POST");
});

test("dry-run does NOT invalidate the cache", async () => {
  await fetchBuild(CONFIG); // prime
  const r = await uploadAssetTool.handler(uploadArgs({ dryRun: true, dedupe: false }));
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  assert.equal(assetPosts, 0);

  await fetchBuild(CONFIG);
  assert.equal(restDataCalls, 1, "dry-run must keep the cache warm");
});

test("dedupe-hit early return does NOT invalidate the cache", async () => {
  buildAssets = [{ id: CONTENT_SHA, type: "image", name: "hero.png" }];
  await fetchBuild(CONFIG); // prime (build already contains the asset)

  const r = await uploadAssetTool.handler(uploadArgs({ dedupe: true }));
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  assert.match(r.content[0].text, /dedupe hit/);
  assert.equal(assetPosts, 0, "dedupe hit must not POST");

  await fetchBuild(CONFIG);
  assert.equal(restDataCalls, 1, "dedupe hit must keep the cache warm");
});
