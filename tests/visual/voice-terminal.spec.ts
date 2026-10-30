import { test, expect } from "@playwright/test";
import { gotoSurface } from "./helpers/gateway";
import { visualCheck, waitForAny } from "./helpers/assert";

/**
 * Voice terminal — the `/voice` route (live-action voice surface).
 *
 * Covers layout + that the terminal accepts text input (the typed fallback for
 * the voice orchestrator). We do NOT touch src/gateway/voice/* or the voice CLI;
 * this is a pure UI-surface check.
 *
 * TODO(testid): the voice terminal input/orb have no data-testid. Once added
 * (e.g. data-testid="voice-input", "voice-send"), replace the role/placeholder
 * heuristics below.
 */
test.describe("voice terminal", () => {
  test.beforeEach(async ({ page }) => {
    await gotoSurface(page, "/voice");
  });

  test("renders the voice surface", async ({ page }, info) => {
    await waitForAny(page, [
      "voice-chat",
      "voice-terminal-controller",
      "voice-mini-orb",
      "infinibot-app",
    ]);
    await visualCheck(page, "voice-terminal-full", info, { fullPage: true, soft: true });
  });

  test("accepts typed input", async ({ page }, info) => {
    // Find the primary text entry (textarea preferred, then a text input).
    const input = page.locator('textarea, input[type="text"]').first();
    if (!(await input.count().catch(() => 0))) {
      info.annotations.push({ type: "skip", description: "no text input found on /voice surface" });
      return;
    }
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.click();
    await input.fill("visual verification probe");
    await expect(input).toHaveValue("visual verification probe");
    await visualCheck(page, "voice-terminal-typed", info, { fullPage: false, soft: true });
  });
});
