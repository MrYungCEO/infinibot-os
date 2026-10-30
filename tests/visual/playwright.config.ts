import { defineConfig, devices } from "@playwright/test";
import { gatewayBaseUrl } from "./helpers/gateway";

/**
 * Visual-verification config for InfiniBot's UI surfaces.
 *
 * Run via scripts/verify-ui.sh (which boots the gateway, exports
 * VERIFY_GATEWAY_* env, then invokes `playwright test`). Can also be run
 * directly with `pnpm exec playwright test -c tests/visual/playwright.config.ts`
 * against an already-running gateway.
 *
 * Env knobs:
 *   VERIFY_GATEWAY_URL        http(s)/ws(s) base of the gateway (default :18789)
 *   VERIFY_GATEWAY_PASSWORD   gateway.auth.password, for the seeded localStorage
 *   VERIFY_BROWSERS           comma list: chromium,firefox,webkit,electron
 *   VERIFY_REPORT_DIR         per-run report dir (set by verify-ui.sh)
 *   VERIFY_REPORT_ONLY        "1" → never fail on diff (baseline/report mode)
 *   VERIFY_PIXEL_RATIO        max allowed diff ratio (default 0.001 = 0.1%)
 *   HEADED                    "1" → run headed for debugging
 */

const reportDir = process.env.VERIFY_REPORT_DIR || "tests/visual/__reports__/latest";
const headed = process.env.HEADED === "1";
const reportOnly = process.env.VERIFY_REPORT_ONLY === "1";
const maxDiffRatio = Number(process.env.VERIFY_PIXEL_RATIO || "0.001");

const requested = (process.env.VERIFY_BROWSERS || "chromium")
  .split(",")
  .map((b) => b.trim().toLowerCase())
  .filter(Boolean);

type ProjectDef = NonNullable<Parameters<typeof defineConfig>[0]["projects"]>[number];

const ALL_PROJECTS: Record<string, ProjectDef> = {
  chromium: { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  firefox: { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  webkit: { name: "webkit", use: { ...devices["Desktop Safari"] } },
  // "electron" is treated as a headed Chromium run pointed at the same gateway
  // UI. The InfiniBot desktop app (electron/main.js) loads the identical
  // control UI over ws, so a headed Chromium project reproduces the desktop
  // window's rendering without needing the _electron launcher + a packaged
  // build. If/when a stable test entrypoint exists, swap this for
  // `@playwright/test`'s electron fixture. See docs/visual-verification.md.
  electron: {
    name: "electron",
    use: { ...devices["Desktop Chrome"], headless: false, viewport: { width: 1440, height: 900 } },
  },
};

const projects = requested
  .map((name) => ALL_PROJECTS[name])
  .filter((p): p is ProjectDef => Boolean(p));

if (projects.length === 0) projects.push(ALL_PROJECTS.chromium);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  // Baselines live next to specs (Playwright default: <spec>-snapshots/).
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFilePath}/{arg}-{projectName}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // Tolerate sub-pixel AA noise per-pixel; gate on the overall ratio.
      maxDiffPixelRatio: maxDiffRatio,
      threshold: 0.2,
      animations: "disabled",
      caret: "hide",
    },
  },
  // In --report-only mode, mark screenshot mismatches as non-fatal by ignoring
  // the diff threshold (still writes diff artifacts to the report dir).
  ignoreSnapshots: false,
  reporter: [
    ["list"],
    ["html", { outputFolder: `${reportDir}/html`, open: "never" }],
    ["json", { outputFile: `${reportDir}/results.json` }],
  ],
  outputDir: `${reportDir}/artifacts`,
  use: {
    baseURL: gatewayBaseUrl(),
    headless: !headed,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  // Surface the report-only flag to specs via a global that they read.
  metadata: { reportOnly, maxDiffRatio },
  projects,
});
