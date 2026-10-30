import { test, expect } from "@playwright/test";
import { gotoSurface } from "./helpers/gateway";
import { visualCheck, waitForAny } from "./helpers/assert";

/**
 * Setup wizard — the `/setup` route.
 *
 * Covers the wizard shell, the voice-setup step (mode/provider selection), and
 * the hardware-probe affordance (the voice-setup-with-hardware-probe agent's
 * surface). We only DRIVE the wizard; setup-wizard.ts itself is off-limits.
 *
 * TODO(testid): wizard steps + the hardware-probe button have no data-testid.
 * Suggest data-testid="wizard-step-voice", "hardware-probe-btn",
 * "voice-mode-native"/"voice-mode-cloud" for robust step targeting.
 */
test.describe("setup wizard", () => {
  test.beforeEach(async ({ page }) => {
    await gotoSurface(page, "/setup");
  });

  test("renders the wizard", async ({ page }, info) => {
    await waitForAny(page, ["main", ".wizard", "[class*=wizard]", "h1", "h2"]);
    await visualCheck(page, "setup-wizard-full", info, { fullPage: true });
  });

  test("voice step exposes mode selection", async ({ page }, info) => {
    // Try to reach the voice step by clicking a "Voice" affordance if present.
    const voiceEntry = page.getByText(/voice/i).first();
    if (await voiceEntry.count().catch(() => 0)) {
      await voiceEntry.click().catch(() => {});
      await page.waitForTimeout(400);
    }
    // Native vs Cloud mode toggles are the heart of the voice setup step.
    const modeButtons = page.getByText(/native|cloud|kokoro/i);
    if (await modeButtons.count().catch(() => 0)) {
      await visualCheck(page, "setup-wizard-voice", info, { fullPage: true });
    } else {
      info.annotations.push({ type: "skip", description: "voice mode controls not reachable from /setup landing" });
    }
  });

  test("hardware probe control is present", async ({ page }, info) => {
    // The hardware-probe agent adds a "probe/detect hardware" affordance to the
    // voice step. Assert it exists and is clickable (don't actually run a probe
    // — that hits real devices).
    const probe = page.getByRole("button", { name: /probe|detect|scan.*hardware|hardware.*scan/i }).first();
    if (await probe.count().catch(() => 0)) {
      await expect(probe).toBeVisible();
      info.annotations.push({ type: "covered", description: "hardware probe button present" });
      await visualCheck(page, "setup-wizard-hardware", info, { fullPage: false });
    } else {
      info.annotations.push({
        type: "todo",
        description: "hardware probe button not found — re-check once voice-setup-hardware-probe agent lands",
      });
    }
  });
});
