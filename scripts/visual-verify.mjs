#!/usr/bin/env node
/**
 * visual-verify.mjs — the SHARED visual-verification harness for agent runs.
 *
 * Captures a URL at the two artifact-contract viewports and saves screenshots
 * with contract naming (`<step>-<viewport>.png`) into a target directory
 * (normally `<artifactsDir>/shots/`). Agents: use THIS instead of writing your
 * own puppeteer script — it handles Chrome resolution, Clerk testing-token
 * auth, Turnstile (via Clerk testing mode), waits, and naming.
 *
 * Usage:
 *   node scripts/visual-verify.mjs --url <url> --step <step-id> --out <dir> [options]
 *
 * Options:
 *   --url <url>            Page to capture (required)
 *   --step <id>            Step id used in the filename (required, e.g. "02-dashboard")
 *   --out <dir>            Output directory (required; created if missing)
 *   --viewport <name>      "mobile" | "desktop" | "both" (default "both")
 *   --wait-selector <css>  Wait for this selector before shooting
 *   --wait-ms <n>          Extra settle delay after load (default 800)
 *   --full-page            Capture the full scrollable page (default: viewport only)
 *   --clerk-token <t>      Clerk testing token (or env CLERK_TESTING_TOKEN).
 *                          Appended as __clerk_testing_token=<t> — this is the
 *                          documented Clerk testing flow and ALSO bypasses
 *                          Cloudflare Turnstile on Clerk-hosted auth in testing mode.
 *   --chrome <path>        Chrome/Chromium binary (auto-resolved otherwise)
 *
 * Exit codes: 0 = all captures written, 1 = usage error, 2 = capture failure.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CONTRACT_VIEWPORTS = {
  mobile: { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
};

function parseArgs(argv) {
  const args = { viewport: "both", waitMs: 800, fullPage: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--url") args.url = next();
    else if (a === "--step") args.step = next();
    else if (a === "--out") args.out = next();
    else if (a === "--viewport") args.viewport = next();
    else if (a === "--wait-selector") args.waitSelector = next();
    else if (a === "--wait-ms") args.waitMs = Number(next());
    else if (a === "--full-page") args.fullPage = true;
    else if (a === "--clerk-token") args.clerkToken = next();
    else if (a === "--chrome") args.chrome = next();
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function resolveChrome(explicit) {
  const home = process.env.HOME ?? "";
  const candidates = [
    explicit,
    process.env.REPORTS_CHROME_PATH,
    home ? join(home, ".local/bin/google-chrome") : "",
    "/opt/google/chrome/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Append the Clerk testing token query param (documented Clerk testing flow). */
function withClerkToken(url, token) {
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set("__clerk_testing_token", token);
  return u.toString();
}

async function capture(browser, { url, step, out, viewportName, args }) {
  const vp = CONTRACT_VIEWPORTS[viewportName];
  const page = await browser.newPage();
  try {
    await page.setViewport(vp);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });

    if (args.waitSelector) {
      await page.waitForSelector(args.waitSelector, { timeout: 30_000 });
    }
    // Best-effort: if a Turnstile iframe is present without a testing token,
    // give it a chance to auto-solve (managed mode) before shooting.
    try {
      const hasTurnstile = await page.$('iframe[src*="challenges.cloudflare.com"]');
      if (hasTurnstile) {
        console.log(`[visual-verify] Turnstile detected on ${url} — waiting up to 10s`);
        await page
          .waitForFunction(
            () => !document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
            { timeout: 10_000 },
          )
          .catch(() => {});
      }
    } catch {
      /* best-effort */
    }
    if (args.waitMs > 0) await new Promise((r) => setTimeout(r, args.waitMs));

    const file = join(out, `${step}-${viewportName}.png`);
    await page.screenshot({ path: file, fullPage: args.fullPage });
    console.log(`[visual-verify] wrote ${file} (${vp.width}x${vp.height})`);
    return file;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.url || !args.step || !args.out) {
    console.log(
      "Usage: node scripts/visual-verify.mjs --url <url> --step <step-id> --out <dir> " +
        "[--viewport mobile|desktop|both] [--wait-selector <css>] [--wait-ms <n>] " +
        "[--full-page] [--clerk-token <t>] [--chrome <path>]",
    );
    process.exit(args.help ? 0 : 1);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(args.step)) {
    console.error(`[visual-verify] invalid --step "${args.step}" — use [a-zA-Z0-9._-] only`);
    process.exit(1);
  }
  const viewports =
    args.viewport === "both" ? ["mobile", "desktop"] : [args.viewport];
  for (const v of viewports) {
    if (!CONTRACT_VIEWPORTS[v]) {
      console.error(`[visual-verify] unknown viewport "${v}" (mobile|desktop|both)`);
      process.exit(1);
    }
  }

  const chromePath = resolveChrome(args.chrome);
  if (!chromePath) {
    console.error("[visual-verify] no Chrome/Chromium binary found — pass --chrome <path>");
    process.exit(2);
  }
  mkdirSync(args.out, { recursive: true });

  const clerkToken = args.clerkToken ?? process.env.CLERK_TESTING_TOKEN ?? "";
  const url = withClerkToken(args.url, clerkToken);
  if (clerkToken) console.log("[visual-verify] Clerk testing token attached");

  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });

  let failed = false;
  try {
    for (const viewportName of viewports) {
      try {
        await capture(browser, { url, step: args.step, out: args.out, viewportName, args });
      } catch (err) {
        failed = true;
        console.error(`[visual-verify] ${viewportName} capture failed: ${err?.message ?? err}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(failed ? 2 : 0);
}

main().catch((err) => {
  console.error(`[visual-verify] fatal: ${err?.stack ?? err}`);
  process.exit(2);
});
