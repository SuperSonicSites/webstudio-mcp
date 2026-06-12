// Tests for src/auth.ts — local per-project Webstudio auth storage.
// We isolate the filesystem by setting WEBSTUDIO_PROJECTS_DIR to a fresh tmp dir
// BEFORE importing the dist modules (projects.ts reads the env at import time).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "webstudio-mcp-auth-"));
process.env.WEBSTUDIO_PROJECTS_DIR = tmpRoot;

// Import AFTER the env override so PROJECTS_DIR picks it up.
const { loadAuth, saveAuth, requireAuth, requirePushAuth, setAllowPush, authPath } = await import(
  "../dist/auth.js"
);

before(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

function freshSlug() {
  return "test-" + Math.random().toString(36).slice(2, 10);
}

// ─── loadAuth ─────────────────────────────────────────────────────────────────

test("loadAuth returns null when no auth file exists for the slug", () => {
  const slug = freshSlug();
  assert.equal(loadAuth(slug), null);
});

test("loadAuth returns the parsed config when the file exists", () => {
  const slug = freshSlug();
  const cfg = {
    projectId: "myproject",
    cookie: "session=abc",
    csrfToken: "csrf-1",
    appVersion: "v1",
  };
  saveAuth(slug, cfg);
  const loaded = loadAuth(slug);
  assert.deepEqual(loaded, cfg);
});

// ─── saveAuth ─────────────────────────────────────────────────────────────────

test("saveAuth writes JSON to projects/<slug>/webstudio-auth.json", () => {
  const slug = freshSlug();
  const cfg = {
    projectId: "p",
    cookie: "c",
    csrfToken: "t",
    appVersion: "v",
    allowPush: false,
  };
  saveAuth(slug, cfg);
  const expectedPath = path.join(tmpRoot, slug, "webstudio-auth.json");
  assert.equal(authPath(slug), expectedPath);
  assert.ok(fs.existsSync(expectedPath));
  const onDisk = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
  assert.deepEqual(onDisk, cfg);
});

test("saveAuth attempts to write file with 0600 mode (best effort)", { skip: process.platform === "win32" && "POSIX mode bits are not enforced on Windows" }, () => {
  const slug = freshSlug();
  saveAuth(slug, { projectId: "p", cookie: "c", csrfToken: "t", appVersion: "v" });
  const stat = fs.statSync(authPath(slug));
  // On filesystems that enforce mode bits, expect 0600. If running as root on a
  // permissive FS the bits may differ — only sanity check the file is not world-readable.
  const worldReadable = (stat.mode & 0o004) !== 0;
  assert.equal(worldReadable, false, `auth file should not be world-readable; mode=${(stat.mode & 0o777).toString(8)}`);
});

// ─── requireAuth ──────────────────────────────────────────────────────────────

test('requireAuth throws "auth not configured" when missing', () => {
  const slug = freshSlug();
  assert.throws(
    () => requireAuth(slug),
    /auth not configured/i,
  );
});

test("requireAuth returns the config when present", () => {
  const slug = freshSlug();
  saveAuth(slug, { projectId: "p", cookie: "c", csrfToken: "t", appVersion: "v" });
  const cfg = requireAuth(slug);
  assert.equal(cfg.projectId, "p");
});

// ─── requirePushAuth ──────────────────────────────────────────────────────────

test('requirePushAuth throws "Push refused" when allowPush !== true', () => {
  const slug = freshSlug();
  saveAuth(slug, { projectId: "p", cookie: "c", csrfToken: "t", appVersion: "v" });
  assert.throws(() => requirePushAuth(slug), /Push refused/);

  // Even allowPush=false is refused.
  saveAuth(slug, { projectId: "p", cookie: "c", csrfToken: "t", appVersion: "v", allowPush: false });
  assert.throws(() => requirePushAuth(slug), /Push refused/);
});

test("requirePushAuth returns the config when allowPush === true", () => {
  const slug = freshSlug();
  saveAuth(slug, { projectId: "p", cookie: "c", csrfToken: "t", appVersion: "v", allowPush: true });
  const cfg = requirePushAuth(slug);
  assert.equal(cfg.allowPush, true);
});

test("setAllowPush flips the allowPush flag in place", () => {
  const slug = freshSlug();
  saveAuth(slug, { projectId: "p", cookie: "c", csrfToken: "t", appVersion: "v", allowPush: false });
  assert.throws(() => requirePushAuth(slug), /Push refused/);
  setAllowPush(slug, true);
  const cfg = requirePushAuth(slug);
  assert.equal(cfg.allowPush, true);
  setAllowPush(slug, false);
  assert.throws(() => requirePushAuth(slug), /Push refused/);
});
