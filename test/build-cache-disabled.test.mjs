// v2.20.2 — readonly fetchBuild guarantees with the cache DISABLED.
//
// WEBSTUDIO_MCP_BUILD_CACHE_TTL_MS is read at module load, so this file sets
// it before importing and relies on node --test's process-per-file isolation.
// readonly returns must be deep-frozen regardless of cache configuration —
// callers' immutability assumptions cannot depend on an env knob.

process.env.WEBSTUDIO_MCP_BUILD_CACHE_TTL_MS = "0";

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const { fetchBuild } = await import("../dist/webstudio-client.js");

const CONFIG = { projectId: "proj-nc", cookie: "c=1", csrfToken: "tok", appVersion: "v1", allowPush: true };

const realFetch = globalThis.fetch;
let restCalls = 0;

beforeEach(() => {
  restCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/rest/data/")) {
      restCalls += 1;
      return new Response(JSON.stringify({
        id: "b", projectId: "proj-nc", version: 1,
        instances: [{ id: "root", type: "instance", component: "Body", children: [] }],
        props: [], styles: [],
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

test("TTL=0: every fetch hits the network (cache disabled)", async () => {
  await fetchBuild(CONFIG);
  await fetchBuild(CONFIG);
  assert.equal(restCalls, 2);
});

test("TTL=0: readonly returns are still deep-frozen", async () => {
  const build = await fetchBuild(CONFIG, { readonly: true });
  assert.ok(Object.isFrozen(build));
  assert.ok(Object.isFrozen(build.instances[0]));
  assert.throws(() => { build.version = 99; }, TypeError);
});

test("TTL=0: non-readonly returns stay mutable", async () => {
  const build = await fetchBuild(CONFIG);
  build.version = 42;
  assert.equal(build.version, 42);
});
