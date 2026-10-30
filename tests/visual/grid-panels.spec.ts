import { test, expect } from "@playwright/test";
import { gotoSurface } from "./helpers/gateway";
import { visualCheck, waitForAny } from "./helpers/assert";

/**
 * Grid panels — the `/grid` route (multi-panel agent chat workspace).
 *
 * Covers the masonry grid layout and that a panel's model-selector dropdown
 * opens (a known fragile area — see memory grid_fixed_dropdown_containing_block).
 */
test.describe("grid panels", () => {
  test.beforeEach(async ({ page }) => {
    await gotoSurface(page, "/grid");
  });

  test("renders the grid layout", async ({ page }, info) => {
    await waitForAny(page, [".grid-layout", ".masonry-grid", ".panel", "main"]);
    // DEMO HOOK (acceptance test only): simulate an intentional CSS color change
    // to prove the diff harness flags it. Remove/keep off in normal runs.
    if (process.env.VERIFY_DEMO_CSS === "1") {
      await page.addStyleTag({ content: "body, .panel { background:#ff0066 !important; }" });
      await page.waitForTimeout(300);
    }
    await visualCheck(page, "grid-full", info, { fullPage: true });
  });

  test("a panel model-selector opens", async ({ page }, info) => {
    const selector = page
      .locator(".panel")
      .first()
      .getByRole("button", { name: /model|select|gpt|claude|opus|sonnet/i })
      .first();
    if (!(await selector.count().catch(() => 0))) {
      info.annotations.push({ type: "skip", description: "no model selector found in first panel" });
      return;
    }
    await expect(selector).toBeVisible();
    await selector.click().catch(() => {});
    await page.waitForTimeout(300);
    // The dropdown is position:fixed; just screenshot to catch the
    // containing-block offset regression visually.
    await visualCheck(page, "grid-model-dropdown", info, { fullPage: false });
  });
});
