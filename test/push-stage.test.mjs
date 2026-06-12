// v2.21.1 — staged push handles (build.push_staged).
//
// The two-stage protocol made the model re-send the ENTIRE fragment on the
// confirm call. A dry-run now stores its validated input under a single-use
// stageId; the confirm call carries ~60 chars. The replay re-runs the full
// push pipeline (requirePushAuth, coercions, retries) — staging skips
// re-transmission, never validation.
//
// node --test runs each file in its own process — fetch stubbing stays local.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "push-stage-"));
process.env.WEBSTUDIO_PROJECTS_DIR = tmpRoot;

const { stagePush, takeStagedPush, clearStagedPushes } = await import("../dist/lib/push-stage.js");
const { buildTool } = await import("../dist/tools/build-mega.js");
const { invalidateBuildCache } = await import("../dist/webstudio-client.js");

const slug = "stageproj";
const projDir = path.join(tmpRoot, slug);
fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(path.join(projDir, "webstudio-auth.json"), JSON.stringify({
  projectId: "proj-st", cookie: "c=1", csrfToken: "tok", appVersion: "v1", allowPush: true,
}));

const fakeBuild = () => ({
  id: "build-st", projectId: "proj-st", version: 4,
  instances: [{ id: "page-root", type: "instance", component: "Body", children: [] }],
  props: [], styles: [], styleSources: [], styleSourceSelections: [], assets: [],
  breakpoints: [{ id: "bp", label: "Base" }],
  pages: {
    homePageId: "home", rootFolderId: "rf",
    pages: [{ id: "home", rootInstanceId: "page-root", path: "", name: "Home" }],
    folders: [],
  },
  project: { title: "Stage Test Project" },
});

const realFetch = globalThis.fetch;
let restCalls = 0;
let trpcCalls = 0;

beforeEach(() => {
  restCalls = 0;
  trpcCalls = 0;
  invalidateBuildCache();
  clearStagedPushes();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/data/")) {
      restCalls += 1;
      return new Response(JSON.stringify(fakeBuild()), { status: 200 });
    }
    if (u.includes("/trpc/build.patch")) {
      trpcCalls += 1;
      return new Response(JSON.stringify([{ result: { data: { status: "ok", version: 5, entries: [] } } }]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

// ── unit: the stage store ────────────────────────────────────────────────────

test("stagePush returns an st_ id; takeStagedPush is single-use", () => {
  const id = stagePush("push_fragment", "proj", { a: 1 });
  assert.match(id, /^st_/);
  const staged = takeStagedPush(id);
  assert.equal(staged.handler, "push_fragment");
  assert.deepEqual(staged.args, { a: 1 });
  assert.equal(takeStagedPush(id), null, "second take must fail (single-use)");
});

test("takeStagedPush: unknown id → null", () => {
  assert.equal(takeStagedPush("st_nope"), null);
});

// ── e2e: dry-run stages, push_staged replays ────────────────────────────────

const dryRunArgs = () => ({
  action: "push_fragment",
  label: "stage-dry",
  instances: [{ id: "hero-1", component: "ws:element", tag: "div", label: "Hero" }],
  pushTo: { projectSlug: slug, parentInstanceId: "page-root", dryRun: true },
});

const extractStageId = (text) => text.match(/stageId:"(st_[A-Za-z0-9_-]+)"/)?.[1];

test("push_fragment dry-run report carries a stageId; push_staged executes the real push", async () => {
  const dry = await buildTool.handler(dryRunArgs());
  assert.notEqual(dry.isError, true, dry.content?.[0]?.text);
  const text = dry.content[0].text;
  assert.match(text, /DRY-RUN/);
  const stageId = extractStageId(text);
  assert.ok(stageId, `stageId expected in dry-run report:\n${text}`);
  assert.equal(trpcCalls, 0, "dry-run must not push");

  const confirm = await buildTool.handler({ action: "push_staged", label: "stage-go", stageId });
  assert.notEqual(confirm.isError, true, confirm.content?.[0]?.text);
  assert.match(confirm.content[0].text, /Fragment pushed to "Stage Test Project"/);
  assert.match(confirm.content[0].text, /version → 5/);
  assert.equal(trpcCalls, 1, "exactly one real push");
});

test("a stageId is single-use end-to-end", async () => {
  const dry = await buildTool.handler(dryRunArgs());
  const stageId = extractStageId(dry.content[0].text);
  const first = await buildTool.handler({ action: "push_staged", label: "go-once", stageId });
  assert.notEqual(first.isError, true);
  const second = await buildTool.handler({ action: "push_staged", label: "go-twice", stageId });
  assert.equal(second.isError, true);
  assert.match(second.content[0].text, /single-use|not found/);
  assert.equal(trpcCalls, 1, "the second attempt must not push");
});

test("unknown stageId fails with an actionable error and no push", async () => {
  const res = await buildTool.handler({ action: "push_staged", label: "go-bad", stageId: "st_doesnotexist" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Re-run the dry-run/);
  assert.equal(trpcCalls, 0);
});

test("push_complete dry-run also stages and replays", async () => {
  const dry = await buildTool.handler({
    action: "push_complete",
    label: "stage-complete",
    instances: [{ id: "sec-1", component: "ws:element", tag: "section", label: "Section" }],
    pushTo: { projectSlug: slug, parentInstanceId: "page-root", dryRun: true },
  });
  assert.notEqual(dry.isError, true, dry.content?.[0]?.text);
  const stageId = extractStageId(dry.content[0].text);
  assert.ok(stageId, `stageId expected in push_complete dry-run:\n${dry.content[0].text}`);

  const confirm = await buildTool.handler({ action: "push_staged", label: "go-complete", stageId });
  assert.notEqual(confirm.isError, true, confirm.content?.[0]?.text);
  assert.match(confirm.content[0].text, /push_complete to "Stage Test Project"/);
  assert.equal(trpcCalls, 1);
});

test("replay enforces allowPush (requirePushAuth runs on the staged path)", async () => {
  // Stage against a project whose auth has allowPush=false.
  const roSlug = "stage-readonly";
  const roDir = path.join(tmpRoot, roSlug);
  fs.mkdirSync(roDir, { recursive: true });
  fs.writeFileSync(path.join(roDir, "webstudio-auth.json"), JSON.stringify({
    projectId: "proj-st", cookie: "c=1", csrfToken: "tok", appVersion: "v1", allowPush: false,
  }));
  const dry = await buildTool.handler({
    ...dryRunArgs(),
    pushTo: { projectSlug: roSlug, parentInstanceId: "page-root", dryRun: true },
  });
  assert.notEqual(dry.isError, true, dry.content?.[0]?.text);
  const stageId = extractStageId(dry.content[0].text);
  assert.ok(stageId);

  const confirm = await buildTool.handler({ action: "push_staged", label: "go-denied", stageId });
  assert.equal(confirm.isError, true, "push without allowPush must be refused");
  assert.match(confirm.content[0].text, /allowPush/);
  assert.equal(trpcCalls, 0);
});
