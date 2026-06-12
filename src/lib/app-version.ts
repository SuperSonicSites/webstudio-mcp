// v1.2 — Recover x-webstudio-client-version via headless browser when HTML
// regex fails. Webstudio Cloud no longer leaks the version anywhere in raw
// HTTP responses (see design_webstudio_mcp_appversion_v12.md). The only
// reliable source is the hydrated builder, which signs every /trpc/* request
// with the current value. We intercept that header.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { AuthExpiredError } from "../webstudio-client.js";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const TRPC_TIMEOUT_MS = 15000;
const NAV_TIMEOUT_MS = 30000;

async function findChromiumBinary(): Promise<string | undefined> {
  const cacheRoot = join(homedir(), ".cache", "ms-playwright");
  try {
    const entries = await readdir(cacheRoot);
    const dirs = entries.filter((e) => e.startsWith("chromium-") && !e.includes("headless"));
    if (dirs.length === 0) return undefined;
    dirs.sort();
    return join(cacheRoot, dirs[dirs.length - 1], "chrome-linux64", "chrome");
  } catch {
    return undefined;
  }
}

// `__Host-` prefixed cookies require url-based registration (no `domain` field)
// per RFC 6265bis. We pass a `url:` so Playwright auto-derives secure + host-only.
function parseCookiesForUrl(cookieHeader: string, url: string) {
  const cookies: Array<{ name: string; value: string; url: string; secure: boolean; httpOnly: boolean; sameSite: "Lax" }> = [];
  for (const raw of cookieHeader.split(";")) {
    const trimmed = raw.trim();
    if (!trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({ name, value, url, secure: true, httpOnly: true, sameSite: "Lax" });
  }
  return cookies;
}

/**
 * Launch headless Chromium, navigate to the builder, intercept the first
 * /trpc/* request, and return the x-webstudio-client-version it carries.
 *
 * Throws with a clear message on any failure so the caller can fall back to
 * F12 instructions.
 */
export async function fetchAppVersionViaBrowser(projectId: string, cookie: string): Promise<string> {
  // Lazy import: playwright-core is an OPTIONAL dependency since v2.21.0 and
  // is resolved from the consumer's node_modules (external in the bundle).
  // Distinct failure layers: module missing (here) vs Chromium binary missing
  // (below) — keep the messages distinguishable.
  let chromium: (typeof import("playwright-core"))["chromium"];
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error(
      "playwright-core is not installed (optional since v2.21.0). The primary HTML-based " +
        "version detection already failed if you are reading this; to enable the browser " +
        "fallback, launch with `npx -y -p playwright-core -p @densrt/webstudio-mcp webstudio-mcp` " +
        "or `npm i playwright-core` in the server's working directory — or update the version " +
        "manually via auth.update_app_version (grab x-webstudio-client-version from DevTools).",
    );
  }

  const executablePath = await findChromiumBinary();
  if (!executablePath) {
    throw new Error(
      "Chromium not found in ~/.cache/ms-playwright. Run `npx playwright install chromium` then retry.",
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    executablePath,
  });

  try {
    const builderUrl = `https://p-${projectId}.apps.webstudio.is`;
    const ctx = await browser.newContext({ userAgent: USER_AGENT });
    // Mirror snapshot.ts: builder + trpc both live on the per-project subdomain.
    await ctx.addCookies(parseCookiesForUrl(cookie, `${builderUrl}/`));

    const page = await ctx.newPage();

    let resolver: ((v: string) => void) | undefined;
    let rejecter: ((e: Error) => void) | undefined;
    const versionPromise = new Promise<string>((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });
    const timer = setTimeout(() => {
      rejecter?.(new Error(`Timed out after ${TRPC_TIMEOUT_MS}ms waiting for first /trpc/* from hydrated builder`));
    }, TRPC_TIMEOUT_MS);

    const finish = (err?: Error, val?: string) => {
      if (!resolver) return;
      clearTimeout(timer);
      if (err) rejecter?.(err);
      else if (val !== undefined) resolver(val);
      resolver = undefined;
    };

    page.on("request", (req) => {
      if (!req.url().includes("/trpc/")) return;
      const v = req.headers()["x-webstudio-client-version"];
      if (v) finish(undefined, v);
    });

    // Detect expired session: any request to /login or /oauth/ on the builder
    // domain means we got bounced out. Fail fast (HTTP 302 won't show as a
    // page response, but the subsequent navigation request will).
    page.on("request", (req) => {
      const u = req.url();
      if (/\/login(\?|$)|\/oauth\/ws\//.test(u)) {
        finish(new AuthExpiredError(302));
      }
    });

    // Don't wait for full networkidle (the builder keeps polling). Intercept
    // races ahead of the navigation completing.
    page.goto(`${builderUrl}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => {
      // Navigation may abort once we resolve and close — that's expected.
    });

    return await versionPromise;
  } finally {
    await browser.close().catch(() => {});
  }
}
