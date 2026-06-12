// Snapshot capture (workstream #4, v1.0).
//
// Implementation of the read.snapshot action — POC validated 2026-05-19
// (tasks/poc-snapshot-2026-05-19.md). Uses playwright-core to drive the
// Webstudio builder canvas and capture an element via data-ws-id.
//
// Architecture:
//   1. Load auth cookie from ~/.webstudio-mcp/projects/<slug>/webstudio-auth.json
//   2. Launch headless Chromium (binary from ~/.cache/ms-playwright)
//   3. Inject cookie scoped to https://p-{projectId}.apps.webstudio.is/
//   4. Navigate to the builder shell + wait for canvas iframe (URL endsWith /canvas)
//   5. Dismiss the "Browser not supported" overlay if present
//   6. Locate element by [data-ws-id="..."] in the canvas frame
//   7. element.screenshot() → PNG → base64

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { chromium } from "playwright-core";
import { z } from "zod";

// playwright-core is an OPTIONAL runtime dependency since v2.21.0 (it was 43%
// of the installed bytes for a feature most sessions never touch). It stays a
// devDependency for the type-only import above and is marked external in the
// bundle, so this dynamic import resolves from the CONSUMER's node_modules.
async function loadChromium(): Promise<typeof chromium> {
  let mod: typeof import("playwright-core");
  try {
    mod = await import("playwright-core");
  } catch {
    throw new Error(
      "playwright-core is not installed (optional since v2.21.0 — it tripled the install size). " +
        "To enable snapshots, launch with it on the module path: " +
        "`npx -y -p playwright-core -p @densrt/webstudio-mcp webstudio-mcp`, " +
        "or run `npm i playwright-core` in the directory the server starts from. " +
        "(`npm i -g` does NOT work — ESM resolution never searches the global tree.) " +
        "Then install the browser once: `npx playwright install chromium`.",
    );
  }
  return mod.chromium;
}

type PwBrowser = Awaited<ReturnType<typeof chromium.launch>>;
type PwPage = Awaited<ReturnType<PwBrowser["newPage"]>>;
type PwFrame = ReturnType<PwPage["frames"]>[number];

// ── Warm browser (v2.17.0) ──────────────────────────────────────────────────
// Launching headless Chromium costs 1-3s per capture. One shared instance is
// kept across calls (contexts stay per-capture, so cookies never leak between
// projects) and closed after 60s idle. Refcounted: a capture in flight blocks
// the idle close.
const BROWSER_IDLE_MS = 60_000;
let sharedBrowser: PwBrowser | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let activeUsers = 0;

async function acquireBrowser(executablePath?: string): Promise<PwBrowser> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  activeUsers += 1;
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  sharedBrowser = await (await loadChromium()).launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    ...(executablePath ? { executablePath } : {}),
  });
  return sharedBrowser;
}

function releaseBrowser(): void {
  activeUsers = Math.max(0, activeUsers - 1);
  if (activeUsers > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const b = sharedBrowser;
    sharedBrowser = null;
    void b?.close().catch(() => {});
  }, BROWSER_IDLE_MS);
  idleTimer.unref();
}

/**
 * Poll for the canvas iframe AND its hydration (first [data-ws-id] present)
 * instead of a fixed 4s sleep (v2.17.0 — typical hydration is 1-2s; the
 * fixed wait paid the worst case on every capture). Null after timeoutMs.
 */
async function waitForCanvasFrame(page: PwPage, timeoutMs = 15_000): Promise<PwFrame | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const canvas = page.frames().find((f) => f.url().endsWith("/canvas"));
    if (canvas) {
      try {
        await canvas.waitForSelector("[data-ws-id]", { timeout: Math.max(500, deadline - Date.now()) });
        return canvas;
      } catch {
        return null;
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

/** v2 — exported Zod schema for the `read.snapshot` action. */
export const snapshotInputSchema = z.object({
  projectSlug: z.string(),
  instanceId: z.string(),
  breakpoint: z.enum(["Base", "Tablet", "Mobile"]).optional()
    .describe("Single breakpoint (default Base). Mutually exclusive with breakpoints."),
  breakpoints: z.array(z.enum(["Base", "Tablet", "Mobile"])).optional()
    .describe("Multi-breakpoint capture in one browser session. Returns one PNG per entry, in input order."),
}).strict();

const BREAKPOINT_VIEWPORTS = {
  Base: { width: 1920, height: 1080 },
  Tablet: { width: 991, height: 800 },
  Mobile: { width: 479, height: 800 },
};

export type Breakpoint = keyof typeof BREAKPOINT_VIEWPORTS;

export type SnapshotResult = {
  ok: true;
  png: string; // base64
  width: number;
  height: number;
  capturedAt: string;
} | { ok: false; code: string; error: string };

export type MultiSnapshotEntry = {
  breakpoint: Breakpoint;
  png: string;
  width: number;
  height: number;
};

export type MultiSnapshotResult = {
  ok: true;
  entries: MultiSnapshotEntry[];
  capturedAt: string;
} | { ok: false; code: string; error: string };

type AuthFile = {
  projectId: string;
  cookie: string;
};

async function loadAuth(projectSlug: string): Promise<AuthFile | null> {
  const path = join(homedir(), ".webstudio-mcp", "projects", projectSlug, "webstudio-auth.json");
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as AuthFile;
  } catch {
    return null;
  }
}

type PwCookie = Parameters<Awaited<ReturnType<typeof chromium.launch>>["newContext"]>;

function parseCookies(cookieHeader: string, builderUrl: string) {
  const cookies: Array<{ name: string; value: string; url: string; secure: boolean; httpOnly: boolean; sameSite: "Lax" }> = [];
  for (const raw of cookieHeader.split(";")) {
    const trimmed = raw.trim();
    if (!trimmed.includes("=")) continue;
    const [name, value] = trimmed.split("=", 2) as [string, string];
    cookies.push({
      name: name.trim(),
      value: value.trim(),
      url: builderUrl + "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
  }
  return cookies;
}

/**
 * Try to find a Playwright-installed chromium binary in ~/.cache/ms-playwright.
 * playwright-core doesn't bundle browsers, so we point to whatever's already there.
 */
async function findChromiumBinary(): Promise<string | undefined> {
  const cacheRoot = join(homedir(), ".cache", "ms-playwright");
  try {
    const entries = await readdir(cacheRoot);
    const chromiumDirs = entries.filter((e) => e.startsWith("chromium-") && !e.includes("headless"));
    if (chromiumDirs.length === 0) return undefined;
    // Take the highest version number
    chromiumDirs.sort();
    const latest = chromiumDirs[chromiumDirs.length - 1];
    return join(cacheRoot, latest, "chrome-linux64", "chrome");
  } catch {
    return undefined;
  }
}

export async function captureSnapshot(
  projectSlug: string,
  instanceId: string,
  breakpoint: Breakpoint = "Base",
): Promise<SnapshotResult> {
  const auth = await loadAuth(projectSlug);
  if (!auth) {
    return { ok: false, code: "AUTH_MISSING", error: `No auth for project "${projectSlug}". Run auth.setup first.` };
  }

  const builderUrl = `https://p-${auth.projectId}.apps.webstudio.is`;
  const viewport = BREAKPOINT_VIEWPORTS[breakpoint];
  const executablePath = await findChromiumBinary();

  const browser = await acquireBrowser(executablePath);
  const ctx = await browser.newContext({
    viewport,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  });

  try {
    await ctx.addCookies(parseCookies(auth.cookie, builderUrl));
    const page = await ctx.newPage();

    const response = await page.goto(`${builderUrl}/`, { waitUntil: "networkidle", timeout: 30000 });
    if (!response || response.status() >= 400) {
      return { ok: false, code: "BUILDER_UNREACHABLE", error: `HTTP ${response?.status() ?? "N/A"} on builder shell` };
    }

    // Dismiss browser-not-supported overlay if present (parent shell warning)
    try {
      const dismiss = await page.$("button:has-text('Dismiss')");
      if (dismiss) {
        await dismiss.click();
        await page.waitForTimeout(500);
      }
    } catch {
      // ignore — overlay may not be present
    }

    // Poll for canvas + hydration (was: fixed 4s sleep).
    const canvas = await waitForCanvasFrame(page);
    if (!canvas) {
      return { ok: false, code: "CANVAS_NOT_FOUND", error: `No hydrated canvas iframe within 15s (frames: ${page.frames().map((f) => f.url()).join(", ")})` };
    }

    let element = null;
    try { element = await canvas.waitForSelector(`[data-ws-id="${instanceId}"]`, { timeout: 3000 }); }
    catch { /* not rendered */ }
    if (!element) {
      return { ok: false, code: "INSTANCE_NOT_RENDERED", error: `Element with data-ws-id="${instanceId}" not found in canvas DOM` };
    }

    const bbox = await element.boundingBox();
    if (!bbox || bbox.width === 0 || bbox.height === 0) {
      return { ok: false, code: "ELEMENT_EMPTY", error: `Element bbox is empty (display:none or 0×0)` };
    }

    const buffer = await element.screenshot({ type: "png" });
    return {
      ok: true,
      png: buffer.toString("base64"),
      width: Math.round(bbox.width),
      height: Math.round(bbox.height),
      capturedAt: new Date().toISOString(),
    };
  } finally {
    await ctx.close().catch(() => {});
    releaseBrowser();
  }
}

/**
 * Capture the same instance at N breakpoints in a single browser session.
 *
 * Reuses one browser + context + page across all breakpoints, only changing the
 * viewport between captures. Saves ~3-5s per extra breakpoint vs N independent
 * captureSnapshot() calls.
 *
 * Returns an array of {breakpoint, png, width, height} on success, or a single
 * error if any setup step fails. Per-breakpoint errors are surfaced as missing
 * entries in the array — the caller compares the input list to the result list.
 */
export async function captureSnapshotMulti(
  projectSlug: string,
  instanceId: string,
  breakpoints: Breakpoint[],
): Promise<MultiSnapshotResult> {
  if (breakpoints.length === 0) {
    return { ok: false, code: "VALIDATION_FAILED", error: "breakpoints array must not be empty" };
  }
  const auth = await loadAuth(projectSlug);
  if (!auth) {
    return { ok: false, code: "AUTH_MISSING", error: `No auth for project "${projectSlug}". Run auth.setup first.` };
  }

  const builderUrl = `https://p-${auth.projectId}.apps.webstudio.is`;
  const executablePath = await findChromiumBinary();

  const browser = await acquireBrowser(executablePath);
  // Open with the largest viewport first to maximise initial canvas hydration.
  const sortedBreakpoints = [...breakpoints].sort(
    (a, b) => BREAKPOINT_VIEWPORTS[b].width - BREAKPOINT_VIEWPORTS[a].width,
  );
  const ctx = await browser.newContext({
    viewport: BREAKPOINT_VIEWPORTS[sortedBreakpoints[0]],
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  });

  try {
    await ctx.addCookies(parseCookies(auth.cookie, builderUrl));
    const page = await ctx.newPage();

    const response = await page.goto(`${builderUrl}/`, { waitUntil: "networkidle", timeout: 30000 });
    if (!response || response.status() >= 400) {
      return { ok: false, code: "BUILDER_UNREACHABLE", error: `HTTP ${response?.status() ?? "N/A"} on builder shell` };
    }

    try {
      const dismiss = await page.$("button:has-text('Dismiss')");
      if (dismiss) {
        await dismiss.click();
        await page.waitForTimeout(500);
      }
    } catch {
      // ignore
    }

    // Poll for canvas + hydration (was: fixed 4s sleep).
    const firstCanvas = await waitForCanvasFrame(page);
    if (!firstCanvas) {
      return { ok: false, code: "CANVAS_NOT_FOUND", error: `No hydrated canvas iframe within 15s (frames: ${page.frames().map((f) => f.url()).join(", ")})` };
    }

    const entries: MultiSnapshotEntry[] = [];
    for (const breakpoint of sortedBreakpoints) {
      const viewport = BREAKPOINT_VIEWPORTS[breakpoint];
      await page.setViewportSize(viewport);
      // Re-locate canvas frame after viewport change — Webstudio may re-render.
      // Short settle then poll (was: fixed 1.5s sleep).
      await page.waitForTimeout(300);
      const canvas = await waitForCanvasFrame(page, 5_000);
      if (!canvas) continue; // surface as missing entry
      let element = null;
      try { element = await canvas.waitForSelector(`[data-ws-id="${instanceId}"]`, { timeout: 3000 }); }
      catch { /* not rendered at this viewport */ }
      if (!element) continue;
      const bbox = await element.boundingBox();
      if (!bbox || bbox.width === 0 || bbox.height === 0) continue;
      const buffer = await element.screenshot({ type: "png" });
      entries.push({
        breakpoint,
        png: buffer.toString("base64"),
        width: Math.round(bbox.width),
        height: Math.round(bbox.height),
      });
    }

    if (entries.length === 0) {
      return {
        ok: false,
        code: "INSTANCE_NOT_RENDERED",
        error: `Element with data-ws-id="${instanceId}" not captured at any requested breakpoint.`,
      };
    }

    // Restore original input ordering for predictable caller experience.
    entries.sort(
      (a, b) => breakpoints.indexOf(a.breakpoint) - breakpoints.indexOf(b.breakpoint),
    );

    return { ok: true, entries, capturedAt: new Date().toISOString() };
  } finally {
    await ctx.close().catch(() => {});
    releaseBrowser();
  }
}
