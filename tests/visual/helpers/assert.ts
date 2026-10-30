/**
 * Screenshot + behavioural assertion helpers shared by every surface spec.
 */
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

const reportOnly = process.env.VERIFY_REPORT_ONLY === "1";

/**
 * Take a named screenshot and diff it against the committed baseline.
 *
 * - First run (no baseline): Playwright writes the baseline and the assertion
 *   passes (it reports "A snapshot doesn't exist … writing actual"). We swallow
 *   that as a non-failure so the very first `verify-ui` run produces baselines
 *   and exits 0 ("baselines created").
 * - Rerun: real pixel diff. In --report-only mode a mismatch is logged and the
 *   diff artifacts are still written, but the test is not failed.
 */
export async function visualCheck(
  target: Page | Locator,
  name: string,
  info: TestInfo,
  opts: { fullPage?: boolean; soft?: boolean } = {},
): Promise<void> {
  const fileName = `${name}.png`;
  try {
    if ("goto" in target) {
      await expect(target).toHaveScreenshot(fileName, { fullPage: opts.fullPage ?? true });
    } else {
      await expect(target).toHaveScreenshot(fileName);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Baseline-creation path: not a real diff failure.
    if (/snapshot doesn't exist|writing actual|is missing in snapshots/i.test(message)) {
      info.annotations.push({ type: "baseline-created", description: fileName });
      return;
    }
    // Soft surfaces (live world-map canvas, voice connect state, …) are
    // data-driven: agent positions move and the canvas even reflows width
    // run-to-run, so pixel/size diffs are noise, not regressions. We still
    // capture the shot + log the measured delta to the report, but never gate
    // the build on it. See docs/visual-verification.md › "Volatile surfaces".
    if (opts.soft || reportOnly) {
      info.annotations.push({
        type: opts.soft ? "soft-visual-diff" : "visual-diff",
        description: `${fileName}: ${firstLine(message)}`,
      });
      return;
    }
    throw err;
  }
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim()) ?? s;
}

/** Assert an element exists, is visible, and is actually clickable (enabled). */
export async function assertClickable(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible({ timeout: 10_000 });
  await expect(locator, `${label} should be enabled`).toBeEnabled();
}

/** Wait for at least one of several candidate selectors to appear (resilience). */
export async function waitForAny(page: Page, selectors: string[], timeout = 20_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) return sel;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`none of the selectors became visible: ${selectors.join(", ")}`);
}
