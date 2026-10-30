import { test, expect } from "@playwright/test";
import { gotoSurface } from "./helpers/gateway";
import { visualCheck, waitForAny } from "./helpers/assert";

/**
 * Dashboard surface — the default `/dashboard` route.
 *
 * Covers: the agent world-map band (<agency-world-viz>), overall page layout,
 * and the presence of the proactive overhaul panel as it materialises. This
 * spec is the catch-all for the proactive-overhaul-v2 work (per the coverage
 * matrix); add component-level checks below as those panels gain stable hooks.
 *
 * TODO(testid): dashboard top-level cards have no data-testid. Once the
 * dashboard owner adds e.g. data-testid="proactive-panel" / "kpi-strip", tighten
 * the component screenshots below to those instead of nth-of-type heuristics.
 */
test.describe("dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await gotoSurface(page, "/dashboard");
  });

  test("renders the dashboard shell and world-map band", async ({ page }, info) => {
    // The world map is the canonical "the app actually booted" signal.
    await waitForAny(page, ["agency-world-viz", "main", ".app-shell"]);
    await expect(page.locator("agency-world-viz")).toBeVisible({ timeout: 20_000 });

    await visualCheck(page, "dashboard-full", info, { fullPage: true, soft: true });
  });

  test("world-map band screenshot is stable", async ({ page }, info) => {
    const viz = page.locator("agency-world-viz").first();
    await expect(viz).toBeVisible({ timeout: 20_000 });
    // Component-scoped screenshot: catches viz regressions without the whole
    // page's volatile data tiles polluting the diff.
    await visualCheck(viz, "dashboard-worldmap", info, { soft: true });
  });

  test("proactive panel appears when present", async ({ page }, info) => {
    // Proactive overhaul v2 mounts <proactive-panel>; absent on installs without
    // commitments. Treat as soft coverage — screenshot only if it rendered.
    const panel = page.locator("proactive-panel, .proactive-section").first();
    if (await panel.count().catch(() => 0)) {
      await expect(panel).toBeVisible();
      await visualCheck(panel, "dashboard-proactive", info);
    } else {
      info.annotations.push({ type: "skip", description: "proactive-panel not mounted on this install" });
    }
  });
});
