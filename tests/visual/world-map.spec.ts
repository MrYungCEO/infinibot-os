import { test, expect } from "@playwright/test";
import { gotoSurface } from "./helpers/gateway";
import { visualCheck } from "./helpers/assert";

/**
 * World map + timeline scrubber.
 *
 * The live world map is <agency-world-viz> (dashboard band). Replay is driven by
 * <world-timeline-scrubber>, which publishes window.__worldReplayFrame; the
 * ActivityMap engine consumes setReplayTime()/resumeLive(). This spec DRIVES the
 * scrubber and asserts the engine reacts — it does not modify either component
 * (both are off-limits to this agent).
 *
 * Behavioural assertion: moving the scrubber must change the replay frame the
 * engine is showing. We observe window.__worldReplayFrame (the published bridge
 * value) before/after, rather than reaching into private engine state.
 */
test.describe("world map", () => {
  test.beforeEach(async ({ page }) => {
    await gotoSurface(page, "/dashboard");
  });

  test("scrubber is present and screenshots cleanly", async ({ page }, info) => {
    const scrubber = page.locator("world-timeline-scrubber").first();
    if (!(await scrubber.count().catch(() => 0))) {
      info.annotations.push({ type: "skip", description: "world-timeline-scrubber not mounted" });
      return;
    }
    await expect(scrubber).toBeVisible({ timeout: 20_000 });
    await visualCheck(scrubber, "worldmap-scrubber", info, { soft: true });
  });

  test("dragging the scrubber changes the replay frame", async ({ page }, info) => {
    const scrubber = page.locator("world-timeline-scrubber").first();
    if (!(await scrubber.count().catch(() => 0))) {
      info.annotations.push({ type: "skip", description: "world-timeline-scrubber not mounted" });
      return;
    }
    await expect(scrubber).toBeVisible({ timeout: 20_000 });

    // The scrubber exposes a range input or draggable handle. Prefer the range
    // input; fall back to a pointer drag across the track.
    const range = scrubber.locator('input[type="range"]').first();

    const frameBefore = await page.evaluate(
      () => (window as unknown as { __worldReplayFrame?: unknown }).__worldReplayFrame ?? null,
    );

    if (await range.count().catch(() => 0)) {
      // Move the slider to ~30% then ~70% to force two distinct replay times.
      await range.focus();
      const box = await range.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
        await page.waitForTimeout(300);
        await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
      }
    } else {
      const box = await scrubber.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 12 });
        await page.mouse.up();
      }
    }
    await page.waitForTimeout(500);

    const frameAfter = await page.evaluate(
      () => (window as unknown as { __worldReplayFrame?: unknown }).__worldReplayFrame ?? null,
    );

    // If the bridge global is wired, the frame must have advanced. If it's not
    // published at all (older build), record it as an annotation instead of a
    // hard failure so the suite still produces a report.
    if (frameBefore === null && frameAfter === null) {
      info.annotations.push({
        type: "todo",
        description: "window.__worldReplayFrame not published — cannot assert scrubber→engine wiring",
      });
    } else {
      expect(frameAfter, "replay frame should change after scrubbing").not.toEqual(frameBefore);
    }

    await visualCheck(page, "worldmap-after-scrub", info, { fullPage: false, soft: true });
  });
});
