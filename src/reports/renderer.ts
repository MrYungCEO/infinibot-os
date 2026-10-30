/**
 * HTML → PDF renderer for the report worker.
 *
 * Uses puppeteer-core with a system Chrome. The plan calls for
 * `~/.local/bin/google-chrome`, but on this install that path is a *wrapper*
 * that forces `--profile-directory=InfiniBot --silent-debugger-extension-api`
 * (for the Browser Relay) — both of which are wrong for a throwaway headless
 * PDF render and would collide with a real browser holding the profile's
 * singleton lock. The wrapper simply `exec`s `/opt/google/chrome/google-chrome`,
 * so we prefer that real binary and keep the wrapper / system chrome as
 * fallbacks. Override with REPORTS_CHROME_PATH if needed.
 *
 * This module is imported only by the worker process — never the gateway — so
 * a puppeteer crash stays inside the worker's process boundary.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

function windowsChromeCandidates(): string[] {
  if (process.platform !== "win32") return [];
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const localAppData = process.env.LOCALAPPDATA || (home ? join(home, "AppData", "Local") : "");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData ? join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : "",
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    localAppData ? join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe") : "",
    join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  ].filter(Boolean);
}

const CHROME_CANDIDATES = [
  process.env.REPORTS_CHROME_PATH,
  ...windowsChromeCandidates(),
  "/opt/google/chrome/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  process.env.HOME ? join(process.env.HOME, ".local/bin/google-chrome") : undefined,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].filter((p): p is string => !!p);

export function resolveChromePath(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable candidates
    }
  }
  return null;
}

/**
 * Base URL of the remote HTML→PDF render service. Configurable via the
 * `REPORTS_PDF_RENDER_URL` env var (or the legacy `PDF_RENDER_URL`). Defaults
 * to `http://localhost:8091`. Set to an empty string to disable the remote
 * service and fall back to the local puppeteer-core renderer.
 *
 * The remote service is expected to accept `POST /render` with the HTML
 * document as the request body (Content-Type: text/html) and respond with
 * the rendered PDF bytes (Content-Type: application/pdf).
 */
export const DEFAULT_PDF_RENDER_URL = "http://localhost:8091";

export function resolvePdfRenderUrl(): string {
  return (
    process.env.REPORTS_PDF_RENDER_URL?.trim() ??
    process.env.PDF_RENDER_URL?.trim() ??
    DEFAULT_PDF_RENDER_URL
  );
}

async function renderViaRemoteService(html: string, outPath: string): Promise<boolean> {
  const baseUrl = resolvePdfRenderUrl();
  if (!baseUrl) return false; // disabled → fall back to local puppeteer

  const url = `${baseUrl.replace(/\/+$/, "")}/render`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: html,
    });
  } catch (err) {
    // Remote unreachable — fall back to local rendering instead of failing the
    // whole report. Log so the operator knows the service is down.
    console.warn(
      `[reports] remote PDF render service at ${url} unreachable (${(err as Error).message}); falling back to local puppeteer.`,
    );
    return false;
  }

  if (!res.ok) {
    console.warn(
      `[reports] remote PDF render service at ${url} returned HTTP ${res.status}; falling back to local puppeteer.`,
    );
    return false;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, buf);
  return true;
}

async function renderViaLocalPuppeteer(html: string, outPath: string): Promise<void> {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    throw new Error(
      `No Chrome binary found for report rendering (tried: ${CHROME_CANDIDATES.join(", ")}). Set REPORTS_CHROME_PATH or start the remote PDF render service at ${DEFAULT_PDF_RENDER_URL}.`,
    );
  }

  // Import puppeteer-core lazily so the gateway (which imports nothing from this
  // file) never pays for it, and so a missing dep fails the render, not boot.
  const puppeteerMod = (await import("puppeteer-core")) as {
    default?: { launch: (opts: unknown) => Promise<unknown> };
    launch?: (opts: unknown) => Promise<unknown>;
  };
  const launch = puppeteerMod.default?.launch ?? puppeteerMod.launch;
  if (!launch) throw new Error("puppeteer-core: launch() not found");

  const browser = (await launch({
    executablePath: chromePath,
    headless: true,
    // Fresh temp profile (set by puppeteer) — do NOT inherit the InfiniBot
    // profile. --no-sandbox is required when running as the gateway service user.
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  })) as {
    newPage: () => Promise<PuppeteerPage>;
    close: () => Promise<void>;
  };

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30_000 });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Render a standalone HTML document to a PDF file at `outPath`. Throws on
 * failure (the worker catches and marks the report failed).
 *
 * Tries the remote HTML→PDF render service first (see {@link resolvePdfRenderUrl},
 * default `http://localhost:8091`, `POST /render` with the HTML body). If the
 * remote service is disabled (empty URL) or unreachable, falls back to the
 * local puppeteer-core renderer.
 */
export async function renderHtmlToPdf(html: string, outPath: string): Promise<void> {
  const done = await renderViaRemoteService(html, outPath);
  if (done) return;
  await renderViaLocalPuppeteer(html, outPath);
}

interface PuppeteerPage {
  setContent: (html: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<void>;
  pdf: (opts: {
    path?: string;
    format?: string;
    printBackground?: boolean;
    margin?: { top?: string; bottom?: string; left?: string; right?: string };
  }) => Promise<Buffer>;
}
