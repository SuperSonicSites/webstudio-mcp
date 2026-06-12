// Webstudio Cloud HTTP client — auth + fetch + push wrapper.
// Reproduces the auth pattern observed from the builder (cookies + csrf + sec-fetch headers).

import type { Instance, Prop, StyleDecl, StyleSource, StyleSourceSelection, Breakpoint } from "./types.js";
import { logTelemetry } from "./lib/telemetry.js";

export class AuthExpiredError extends Error {
  constructor(public readonly httpStatus: number) {
    super(
      `Webstudio session expired (HTTP ${httpStatus}) — run webstudio_setup_auth again ` +
        `with the new cookie. appVersion will be auto-fetched if you don't supply one.`,
    );
    this.name = "AuthExpiredError";
  }
}

/**
 * Try to extract appVersion (x-webstudio-client-version) from the builder HTML.
 * Returns the matched string, or null if no marker is present.
 * Throws on HTTP errors.
 */
async function fetchAppVersionViaHtml(projectId: string, cookie: string): Promise<string | null> {
  const url = `https://p-${projectId}.apps.webstudio.is/`;
  // redirect:"manual" lets us detect the OAuth-to-login redirect that signals
  // an expired session. Without it, fetch follows the chain and we'd see a 200
  // on the /login page, mistaking expired auth for "no marker found".
  const res = await fetch(url, {
    redirect: "manual",
    headers: {
      Cookie: cookie,
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    },
  });

  // 302 → /oauth/ws/authorize or /login means the cookie is no longer valid.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") || "";
    if (/\/oauth\/|\/login(\?|$)/.test(loc)) {
      throw new AuthExpiredError(res.status);
    }
    throw new Error(
      `Builder returned unexpected redirect (HTTP ${res.status} → ${loc}). ` +
        `Provide appVersion manually: F12 → Network → /trpc/... → Headers → x-webstudio-client-version.`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Could not fetch builder HTML (HTTP ${res.status}). ` +
        `Provide appVersion manually: F12 → Network → /trpc/... → Headers → x-webstudio-client-version.`,
    );
  }
  const html = await res.text();

  // Webstudio (Remix) used to expose env vars via window.ENV = { GIT_SHA: "..." }.
  // As of 2026-05 none of these markers are inlined anymore — kept as a fast path
  // in case Webstudio re-exposes them.
  const gitSha = html.match(/GIT_SHA["']?\s*:\s*["']([a-zA-Z0-9_-]{4,64})["']/);
  if (gitSha) return gitSha[1];

  const clientVersion = html.match(/clientVersion["']?\s*:\s*["']([a-zA-Z0-9_-]{4,64})["']/);
  if (clientVersion) return clientVersion[1];

  const metaTag = html.match(/name=["']x-webstudio-client-version["'][^>]*content=["']([^"']+)["']/);
  if (metaTag) return metaTag[1];

  return null;
}

// Test seam: tests inject a stub here to skip the headless browser.
// Default is the real Playwright implementation in ./lib/app-version.
let browserFetcher: ((projectId: string, cookie: string) => Promise<string>) | undefined;
export function __setBrowserAppVersionFetcher(fn: typeof browserFetcher) {
  browserFetcher = fn;
}

/**
 * Resolve appVersion using a fast-path HTML regex, then fall back to a headless
 * browser that intercepts the first /trpc/* request of the hydrated builder
 * (v1.2 — required since Webstudio Cloud stopped inlining the version in HTML).
 * Throws with explicit F12 instructions if both routes fail.
 */
export async function fetchAppVersion(projectId: string, cookie: string): Promise<string> {
  let htmlErr: unknown;
  try {
    const v = await fetchAppVersionViaHtml(projectId, cookie);
    if (v) return v;
  } catch (e) {
    // Auth-expired is terminal — no point trying the browser, it'll just land
    // on the same /login page. Surface immediately so the user knows to re-auth.
    if (e instanceof AuthExpiredError) throw e;
    htmlErr = e;
  }

  try {
    const fn = browserFetcher ?? (await import("./lib/app-version.js")).fetchAppVersionViaBrowser;
    return await fn(projectId, cookie);
  } catch (browserErr) {
    if (browserErr instanceof AuthExpiredError) throw browserErr;
    const browserMsg = browserErr instanceof Error ? browserErr.message : String(browserErr);
    const htmlMsg = htmlErr instanceof Error ? htmlErr.message : "no marker found in HTML";
    throw new Error(
      `appVersion auto-fetch failed. ` +
        `HTML regex: ${htmlMsg}. ` +
        `Headless browser: ${browserMsg}. ` +
        `Get it manually: F12 → Network → /trpc/... → Headers → x-webstudio-client-version, ` +
        `then call webstudio_update_app_version({projectSlug, appVersion}).`,
    );
  }
}

export type WebstudioConfig = {
  projectId: string;
  cookie: string;       // Full Cookie header (session + csrf cookies concatenated).
  csrfToken: string;    // x-csrf-token (extracted from the __Host-_csrf_1 cookie).
  appVersion: string;   // x-webstudio-client-version (server build hash).
  /**
   * Explicit allow-list: as long as `allowPush !== true`, the push tool refuses.
   * The session cookie is bound to the Webstudio user (not a project) → it grants access
   * to ALL projects on the account. allowPush prevents accidental pushes to the wrong project.
   */
  allowPush?: boolean;
};

export type WebstudioBuild = {
  id: string;
  projectId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  pages: {
    homePageId: string;
    rootFolderId: string;
    pages: Array<{ id: string; name: string; path: string; rootInstanceId: string; title?: string; meta?: Record<string, unknown> }>;
    folders: unknown[];
  };
  breakpoints: Breakpoint[];
  instances: Instance[];
  props: Prop[];
  styles: StyleDecl[];
  styleSources: StyleSource[];
  styleSourceSelections: StyleSourceSelection[];
  dataSources: unknown[];
  resources: unknown[];
  assets: unknown[];
  marketplaceProduct: unknown;
  project?: { id?: string; title?: string; domain?: string; [key: string]: unknown };
  publisherHost?: string;
};

export type BuildPatchOperation = {
  op: "add" | "replace" | "remove";
  path: Array<string | number>;
  value?: unknown;
};

export type BuildPatchChange = {
  namespace: string;
  patches: BuildPatchOperation[];
};

export type BuildPatchTransaction = {
  id: string;
  payload: BuildPatchChange[];
};

export type PatchResult =
  | { status: "ok"; version: number; entries: Array<{ transactionId: string; status: string }> }
  | { status: "partial"; version: number; entries: unknown[] }
  | { status: "version_mismatched"; errors: string }
  | { status: "authorization_error" | "error"; errors: string };

export function origin(projectId: string): string {
  return `https://p-${projectId}.apps.webstudio.is`;
}

export function commonHeaders(config: WebstudioConfig, withContent = false): Record<string, string> {
  const headers: Record<string, string> = {
    Cookie: config.cookie,
    "x-csrf-token": config.csrfToken,
    "x-webstudio-client": "browser",
    "x-webstudio-client-version": config.appVersion,
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-fetch-dest": "empty",
    Referer: `${origin(config.projectId)}/`,
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  };
  if (withContent) {
    headers["Content-Type"] = "application/json";
    headers["Origin"] = origin(config.projectId);
  }
  return headers;
}

// HTTP timeout in ms applied to every Webstudio Cloud call. 15s is generous for normal
// requests but caps hung connections (CDN issue, server hot reload) that would otherwise
// block a tool call indefinitely.
const HTTP_TIMEOUT_MS = 15_000;

// ── Build cache (v2.13.0; TTL raised v2.20.2) ──────────────────────────────
// Every tool used to re-download the FULL project build per call (~0.5-2s each,
// ~92 fetchBuild call sites across 87 files — recount 2026-06-11). Agent
// workflows chain reads and dry-runs against the same project within seconds,
// so a short-TTL in-memory cache eliminates most of that latency with no
// correctness loss:
//   - any push attempt invalidates the entry BEFORE hitting the network
//     (server state about to change → next read must re-fetch);
//   - asset uploads invalidate too (v2.20.2) — /rest/assets POSTs mutate the
//     server-side build outside the trpc patch path;
//   - pushWithRetry forces a fresh fetch on retries (version_mismatched means
//     our snapshot is stale by definition);
//   - reads are served a structuredClone — call sites can mutate their
//     copy freely without corrupting the cache;
//   - staleness from EXTERNAL edits (user typing in the builder) is bounded by
//     the TTL and, on push paths, self-heals via the version_mismatched retry.
// Default 120s (was 30s): the server offers no HTTP revalidation (Cache-Control:
// private, no-store; no ETag), so this TTL is the only read-dedup lever, and
// every mutation path above invalidates eagerly.
// Tune or disable via WEBSTUDIO_MCP_BUILD_CACHE_TTL_MS (0 disables).
const BUILD_CACHE_TTL_MS = (() => {
  const raw = process.env.WEBSTUDIO_MCP_BUILD_CACHE_TTL_MS;
  if (raw === undefined || raw === "") return 120_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
})();

const buildCache = new Map<string, { build: WebstudioBuild; fetchedAt: number }>();

/** Drop the cached build for one project (or all projects when omitted). */
export function invalidateBuildCache(projectId?: string): void {
  if (projectId === undefined) buildCache.clear();
  else buildCache.delete(projectId);
}

export type FetchBuildOptions = {
  /** Bypass the cache and hit the network (push/retry paths). Default false. */
  fresh?: boolean;
  /**
   * Return the cached build deep-frozen, WITHOUT cloning (v2.20.2). Pure-read
   * tools should opt in: a structuredClone of a multi-MB build per cache hit
   * is the single largest per-call CPU cost on read chains. Frozen objects
   * turn latent cache-corrupting mutations into loud TypeErrors (strict-mode
   * ESM). Readonly returns are frozen even when the cache is disabled so the
   * guarantee does not depend on TTL configuration. Default false.
   */
  readonly?: boolean;
};

/** Recursive Object.freeze (Object.freeze alone is shallow). Cycle-safe via frozen-check. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export async function fetchBuild(
  config: WebstudioConfig,
  opts: FetchBuildOptions = {},
): Promise<WebstudioBuild> {
  if (!opts.fresh && BUILD_CACHE_TTL_MS > 0) {
    const cached = buildCache.get(config.projectId);
    if (cached && Date.now() - cached.fetchedAt < BUILD_CACHE_TTL_MS) {
      // Telemetry (opt-in): hit/miss ratio feeds the weekly report — tells us
      // whether the TTL default is calibrated for real agent workflows.
      void logTelemetry({ event: "build_cache", hit: true, projectId: config.projectId });
      // The stored copy is deep-frozen at store time; readonly callers share
      // it directly. structuredClone of a frozen object yields a mutable clone,
      // so non-readonly callers are unaffected.
      return opts.readonly ? cached.build : structuredClone(cached.build);
    }
  }
  void logTelemetry({ event: "build_cache", hit: false, fresh: opts.fresh === true, projectId: config.projectId });
  const url = `${origin(config.projectId)}/rest/data/${config.projectId}`;
  const res = await fetch(url, {
    headers: commonHeaders(config),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError(res.status);
  if (!res.ok) {
    throw new Error(`fetchBuild failed: ${res.status} — ${(await res.text()).slice(0, 300)}`);
  }
  const build = (await res.json()) as WebstudioBuild;
  if (BUILD_CACHE_TTL_MS > 0) {
    const stored = deepFreeze(structuredClone(build));
    buildCache.set(config.projectId, { build: stored, fetchedAt: Date.now() });
    if (opts.readonly) return stored;
  }
  return opts.readonly ? deepFreeze(build) : build;
}

export async function applyTransaction(
  config: WebstudioConfig,
  buildId: string,
  version: number,
  transaction: BuildPatchTransaction,
): Promise<PatchResult> {
  // Server state is about to change (or may change even on failure — outcome
  // unknown on thrown errors): drop the cached build up front.
  invalidateBuildCache(config.projectId);
  const url = `${origin(config.projectId)}/trpc/build.patch?batch=1`;
  const body = JSON.stringify({
    "0": {
      source: "browser",
      appVersion: config.appVersion,
      buildId,
      projectId: config.projectId,
      version,
      entries: [{ transaction }],
    },
  });
  const res = await fetch(url, {
    method: "POST",
    headers: commonHeaders(config, true),
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError(res.status);
  if (!res.ok) {
    throw new Error(`applyTransaction failed: ${res.status} — ${(await res.text()).slice(0, 500)}`);
  }
  const json = (await res.json()) as Array<{ result: { data: PatchResult } } | { error: unknown }>;
  const first = json[0];
  if ("error" in first) {
    throw new Error(`tRPC error: ${JSON.stringify(first.error)}`);
  }
  return first.result.data;
}

/**
 * High-level helper: push a transaction with auto-retry on version_mismatched (max 3).
 *
 * Strategy:
 * 1. Fetch build → regenerate → apply
 * 2. On version_mismatched: retry (the build changed between fetch and apply)
 * 3. If the error mentions appVersion OR after one failed retry → automatically refresh
 *    config.appVersion (mutated in place) and try again.
 *    Saves users from re-running setup_auth manually after every Webstudio deploy.
 *
 * `appVersionUpdated` is exposed so tools can persist the new version to the auth file
 * (otherwise the refresh is lost on the next run).
 */
/**
 * Delay before retry attempt N (1-based): exponential, base 250ms doubling per
 * attempt, plus 0-40% jitter so concurrent agents don't re-collide on the same
 * build version. Attempt 0 (first try) = no delay. Pure — `random` injectable
 * for tests.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  if (attempt <= 0) return 0;
  const base = 250 * 2 ** (attempt - 1);
  return Math.round(base * (1 + 0.4 * random()));
}

export async function pushWithRetry(
  config: WebstudioConfig,
  regenerate: (build: WebstudioBuild) => BuildPatchTransaction,
  maxRetries = 3,
): Promise<{ result: PatchResult; finalVersion: number; appVersionUpdated?: string }> {
  let lastError: string | undefined;
  let appVersionRefreshed = false;
  let updatedAppVersion: string | undefined;

  const tryRefreshAppVersion = async (): Promise<boolean> => {
    if (appVersionRefreshed) return false;
    appVersionRefreshed = true;
    try {
      const fresh = await fetchAppVersion(config.projectId, config.cookie);
      if (fresh !== config.appVersion) {
        config.appVersion = fresh;
        updatedAppVersion = fresh;
        return true;
      }
    } catch (e) {
      // An expired session means there is no point in pretending this is a
      // version drift — re-throw so the caller surfaces AUTH_EXPIRED guidance
      // (re-run setup_auth with a fresh cookie). Other refresh failures stay
      // best-effort.
      if (e instanceof AuthExpiredError) throw e;
    }
    return false;
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Exponential backoff + jitter before each retry (v2.14.1 — retries were
    // immediate, re-colliding with whatever just bumped the build version).
    if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
    // Attempt 0 may serve from the build cache (a dry-run usually fetched the
    // same build seconds ago; our own pushes invalidate it). Retries force a
    // network fetch — version_mismatched means the snapshot is stale.
    const build = await fetchBuild(config, { fresh: attempt > 0 });
    const transaction = regenerate(build);
    const result = await applyTransaction(config, build.id, build.version, transaction);
    if (result.status === "ok" || result.status === "partial") {
      return { result, finalVersion: result.version, appVersionUpdated: updatedAppVersion };
    }
    if (result.status === "version_mismatched") {
      lastError = result.errors;
      // Heuristic: if the error mentions appVersion/clientVersion → refresh first.
      // tryRefreshAppVersion re-throws AuthExpiredError so we bail out of the
      // retry loop with a clear AUTH_EXPIRED message instead of exhausting all
      // attempts and reporting a misleading VERSION_MISMATCHED.
      if (!appVersionRefreshed && /app.{0,5}version|client.{0,5}version/i.test(result.errors)) {
        await tryRefreshAppVersion();
      }
      // On the 2nd failed attempt, try a "preventive" refresh (covers cases where the error
      // doesn't explicitly mention appVersion but it's still the cause).
      if (attempt === 1 && !appVersionRefreshed) await tryRefreshAppVersion();
      continue;
    }
    throw new Error(`Push failed: ${result.status} — ${"errors" in result ? result.errors : ""}`);
  }
  const versionHint =
    `\n\nWebstudio has likely deployed a new build and the stored appVersion is stale.` +
    `\nAuto-fetch could not recover it (GIT_SHA is no longer inlined in the Webstudio HTML).` +
    `\n\nTo fix:` +
    `\n  1. Open the Webstudio builder in your browser (https://apps.webstudio.is/).` +
    `\n  2. F12 → Network tab → click any /trpc/ request → Request Headers.` +
    `\n  3. Copy the value of x-webstudio-client-version.` +
    `\n  4. Run: webstudio_update_app_version({ projectSlug: "...", appVersion: "<copied value>" }).` +
    `\n  5. Retry the push.`;
  throw new Error(`Push failed after ${maxRetries} retries (version_mismatched). Last: ${lastError}${versionHint}`);
}
