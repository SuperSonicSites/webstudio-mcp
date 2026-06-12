// v2.13.0 — build cache guard tests.
//
// fetchBuild re-downloaded the FULL project build on every tool call (182 call
// sites, ~0.5-2s each — audit 2026-06-10). v2.13.0 adds a short-TTL in-memory
// cache: reads serve a structuredClone; any applyTransaction invalidates the
// entry up front; pushWithRetry forces fresh fetches on retries.
//
// node --test runs each file in its own process — stubbing globalThis.fetch
// here cannot leak into other test files.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  fetchBuild,
  applyTransaction,
  pushWithRetry,
  invalidateBuildCache,
} from "../dist/webstudio-client.js";

const CONFIG = { projectId: "proj-1", cookie: "c=1", csrfToken: "tok", appVersion: "v1", allowPush: true };

const fakeBuild = () => ({
  id: "build-1",
  projectId: "proj-1",
  version: 7,
  instances: [{ id: "root", type: "instance", component: "Body", children: [] }],
  props: [],
  styles: [],
});

const realFetch = globalThis.fetch;
let restCalls = 0;
let trpcCalls = 0;
let trpcResults = [];

beforeEach(() => {
  restCalls = 0;
  trpcCalls = 0;
  trpcResults = [];
  invalidateBuildCache();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/data/")) {
      restCalls += 1;
      return new Response(JSON.stringify(fakeBuild()), { status: 200 });
    }
    if (u.includes("/trpc/build.patch")) {
      trpcCalls += 1;
      const data = trpcResults.shift() ?? { status: "ok", version: 8, entries: [] };
      return new Response(JSON.stringify([{ result: { data } }]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

test("fetchBuild: second call within TTL is served from cache (no network)", async () => {
  await fetchBuild(CONFIG);
  await fetchBuild(CONFIG);
  assert.equal(restCalls, 1);
});

test("fetchBuild: fresh:true bypasses the cache", async () => {
  await fetchBuild(CONFIG);
  await fetchBuild(CONFIG, { fresh: true });
  assert.equal(restCalls, 2);
});

test("fetchBuild: cached reads are clone-isolated (caller mutations do not poison the cache)", async () => {
  const first = await fetchBuild(CONFIG);
  first.instances.push({ id: "evil", type: "instance", component: "Box", children: [] });
  first.version = 999;
  const second = await fetchBuild(CONFIG);
  assert.equal(second.version, 7);
  assert.equal(second.instances.length, 1);
});

test("fetchBuild: projects are cached independently", async () => {
  await fetchBuild(CONFIG);
  await fetchBuild({ ...CONFIG, projectId: "proj-2" });
  assert.equal(restCalls, 2);
});

test("applyTransaction invalidates the cached build up front", async () => {
  await fetchBuild(CONFIG);
  await applyTransaction(CONFIG, "build-1", 7, { id: "tx", payload: [] });
  await fetchBuild(CONFIG);
  assert.equal(restCalls, 2, "post-push read must re-fetch");
  assert.equal(trpcCalls, 1);
});

test("invalidateBuildCache() clears everything", async () => {
  await fetchBuild(CONFIG);
  invalidateBuildCache();
  await fetchBuild(CONFIG);
  assert.equal(restCalls, 2);
});

test("pushWithRetry: attempt 0 reuses a freshly cached build (dry-run → push pattern)", async () => {
  await fetchBuild(CONFIG); // the dry-run primed the cache
  const { result } = await pushWithRetry({ ...CONFIG }, (build) => ({ id: "tx", payload: [] }));
  assert.equal(result.status, "ok");
  assert.equal(restCalls, 1, "attempt 0 must not re-fetch a 0s-old build");
  assert.equal(trpcCalls, 1);
});

test("pushWithRetry: version_mismatched retry forces a FRESH fetch", async () => {
  await fetchBuild(CONFIG); // prime
  trpcResults = [
    { status: "version_mismatched", errors: "boom" },
    { status: "ok", version: 9, entries: [] },
  ];
  const { result, finalVersion } = await pushWithRetry({ ...CONFIG }, () => ({ id: "tx", payload: [] }));
  assert.equal(result.status, "ok");
  assert.equal(finalVersion, 9);
  assert.equal(trpcCalls, 2);
  // 1 prime + 1 fresh on the retry (attempt 0 served from cache).
  assert.equal(restCalls, 2);
});

// ── readonly fetches (v2.20.2 — frozen shared reference, no per-hit clone) ──

test("fetchBuild readonly: cache hit returns the same deep-frozen reference (no clone)", async () => {
  const a = await fetchBuild(CONFIG, { readonly: true });
  const b = await fetchBuild(CONFIG, { readonly: true });
  assert.equal(restCalls, 1);
  assert.equal(a, b, "readonly hits must share one reference");
  assert.ok(Object.isFrozen(a), "top level frozen");
  assert.ok(Object.isFrozen(a.instances), "arrays frozen");
  assert.ok(Object.isFrozen(a.instances[0]), "nested objects frozen");
  assert.throws(() => { a.version = 999; }, TypeError, "mutation must throw in strict mode");
});

test("fetchBuild readonly: non-readonly callers still get a mutable clone", async () => {
  await fetchBuild(CONFIG, { readonly: true });
  const mutable = await fetchBuild(CONFIG);
  assert.equal(restCalls, 1, "both served from cache");
  mutable.instances.push({ id: "extra", type: "instance", component: "Box", children: [] });
  assert.equal(mutable.instances.length, 2);
  const ro = await fetchBuild(CONFIG, { readonly: true });
  assert.equal(ro.instances.length, 1, "mutation of a clone must not reach the shared copy");
});

test("fetchBuild readonly: miss path also returns a frozen build", async () => {
  const a = await fetchBuild(CONFIG, { readonly: true });
  assert.equal(restCalls, 1, "miss path fetched");
  assert.ok(Object.isFrozen(a));
});

// ── retryDelayMs (v2.14.1 — exponential backoff + jitter on push retries) ───

test("retryDelayMs: attempt 0 has no delay, then exponential with bounded jitter", async () => {
  const { retryDelayMs } = await import("../dist/webstudio-client.js");
  assert.equal(retryDelayMs(0), 0);
  // jitter=0 → exact base; jitter=1 → +40%
  assert.equal(retryDelayMs(1, () => 0), 250);
  assert.equal(retryDelayMs(2, () => 0), 500);
  assert.equal(retryDelayMs(1, () => 1), 350);
  assert.equal(retryDelayMs(2, () => 1), 700);
  // real random stays within [base, base*1.4]
  for (let i = 0; i < 20; i++) {
    const d = retryDelayMs(1);
    assert.ok(d >= 250 && d <= 350, `delay ${d} out of bounds`);
  }
});
