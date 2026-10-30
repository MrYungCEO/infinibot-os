/**
 * Composition thumbnails — cached PNG previews.
 *
 * Drives `@hyperframes/producer`'s `captureFrame` at a single midpoint
 * time, saves the result as a 480×270 PNG to
 * `<state>/composition-thumbs/<compositionId>-<rev>.png`, and serves it
 * via a gateway HTTP route. Operator-visible spots:
 *
 *   - Templates gallery: card thumbnails replace the live mini-stages
 *     after the first render lands. Live stages remain as the warm-up
 *     placeholder, then swap to the cached PNG when ready.
 *   - Composition picker dropdown.
 *   - Compositions list view.
 *
 * Concurrency: we serialize all captures through a single in-flight
 * mutex — spawning N puppeteers in parallel for thumbnails would
 * starve the actual render pipeline. Cache by `(compositionId, rev)`
 * where rev = `comp.updatedAt`; a fresh save just produces a new
 * filename, leaving the old PNG behind for the GC pass to reap.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("comp-thumb");

const WIDTH = 480;
const HEIGHT = 270;
const THUMB_DIR_NAME = "composition-thumbs";

export function thumbsDir(): string {
  const dir = join(resolveStateDir(), THUMB_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function thumbPathFor(compositionId: string, rev: number | string): string {
  return join(thumbsDir(), `${compositionId}-${rev}.png`);
}

export interface ThumbnailInfo {
  /** Absolute disk path. May not exist yet. */
  path: string;
  /** Public URL the gateway serves at. */
  url: string;
  /** Whether the file already exists on disk. */
  ready: boolean;
}

/** Inspect cache without triggering generation. */
export function lookupThumbnail(compositionId: string, rev: number | string): ThumbnailInfo {
  const path = thumbPathFor(compositionId, rev);
  return {
    path,
    url: `/api/compositions/${encodeURIComponent(compositionId)}/thumbnail.png?rev=${rev}`,
    ready: existsSync(path),
  };
}

// ── Generation ──────────────────────────────────────────────────────

let inFlight: Promise<void> = Promise.resolve();

/**
 * Ensure a thumbnail exists for `(compositionId, rev)`. Triggers
 * generation if missing. Returns the disk path once written. Multiple
 * concurrent callers for the same composition share the same
 * generation promise; cross-composition callers serialize through the
 * single in-flight mutex.
 */
export async function ensureThumbnail(
  compositionId: string,
  rev: number | string,
  gatewayPort: number,
): Promise<string> {
  const info = lookupThumbnail(compositionId, rev);
  if (info.ready) return info.path;

  // Serialize across all callers — one puppeteer at a time.
  const tail = inFlight.catch(() => undefined);
  inFlight = tail.then(async () => {
    // Re-check inside the lock: a competing caller may have produced
    // the file while we waited.
    if (existsSync(info.path)) return;
    try {
      await captureAndWrite(compositionId, rev, gatewayPort);
    } catch (err) {
      log.warn(`thumbnail capture failed for ${compositionId}@${rev}: ${(err as Error).message}`);
    }
  });
  await inFlight;
  return info.path;
}

async function captureAndWrite(
  compositionId: string,
  rev: number | string,
  gatewayPort: number,
): Promise<void> {
  // Use puppeteer-core directly — the producer's `createCaptureSession`
  // is built around a full render pipeline (BeginFrame loops, perf
  // counters, file servers) which is overkill for a single PNG. We
  // just need: open page → seek to midpoint → screenshot → save.
  const puppeteerMod = await import("puppeteer-core");
  const puppeteer = (puppeteerMod as { default?: unknown }).default ?? puppeteerMod;
  const launch = (puppeteer as { launch: (opts: unknown) => Promise<unknown> }).launch;

  const chromePath = resolveChromePath();
  if (!chromePath) {
    throw new Error(
      "No Chrome binary found. Set PRODUCER_HEADLESS_SHELL_PATH or install chrome-headless-shell via puppeteer.",
    );
  }
  const browser = (await launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  })) as {
    newPage: () => Promise<unknown>;
    close: () => Promise<void>;
  };
  try {
    const page = (await browser.newPage()) as {
      setViewport: (opts: {
        width: number;
        height: number;
        deviceScaleFactor?: number;
      }) => Promise<void>;
      goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
      setExtraHTTPHeaders: (headers: Record<string, string>) => Promise<void>;
      evaluate: (fn: () => unknown | Promise<unknown>) => Promise<unknown>;
      screenshot: (opts: {
        path?: string;
        type?: string;
        clip?: { x: number; y: number; width: number; height: number };
      }) => Promise<Buffer>;
      close: () => Promise<void>;
    };
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    // The preview page and its /media/ assets are gateway HTTP routes, which
    // require the gateway credential (no loopback exemption).
    const { resolveSelfCallAuthHeaders } = await import("../gateway/http-auth.js");
    await page.setExtraHTTPHeaders(await resolveSelfCallAuthHeaders());
    const url = `http://127.0.0.1:${gatewayPort}/api/compositions/${encodeURIComponent(compositionId)}/preview.html`;
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    // Wait for the runtime to install + seek to ~40% of total duration
    // (same midpoint trick the inline preview uses).
    await page.evaluate(async () => {
      const w = window as unknown as {
        __player?: { seek: (t: number) => void; pause: () => void; duration?: number };
      };
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 50 && !w.__player; i++) await wait(60);
      if (!w.__player) return;
      const t = Math.max(0.1, (w.__player.duration ?? 5) * 0.4);
      w.__player.seek(t);
      w.__player.pause();
      // Give a frame to commit before screenshot.
      await wait(120);
    });
    const buf = await page.screenshot({ type: "png" });
    writeFileSync(thumbPathFor(compositionId, rev), buf);
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}

function resolveChromePath(): string | null {
  const env = process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if (env && existsSync(env)) return env;
  // Look for puppeteer's downloaded chrome.
  const home = process.env.HOME ?? "";
  const guesses = [
    join(home, ".cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome"),
    join(home, ".cache/puppeteer"),
  ];
  for (const path of guesses) {
    if (existsSync(path)) {
      if (path.endsWith("chrome")) return path;
      // path is a dir — let the engine's resolver figure it out via the
      // browser-pool flow if we ever wire that.
    }
  }
  return null;
}

// ── House-keeping ──────────────────────────────────────────────────

/** Cheap upper bound on what counts as "this is stale" — files older than
 *  this should be reaped on the next garbage pass. Defaults to 14 days. */
const STALE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function isStaleThumbnail(path: string): boolean {
  try {
    const stat = statSync(path);
    return Date.now() - stat.mtimeMs > STALE_AGE_MS;
  } catch {
    return false;
  }
}
