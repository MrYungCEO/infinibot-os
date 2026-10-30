import { describe, expect, it } from "vitest";
import {
  countdown,
  gatePlans,
  gateTitle,
  isDailyLimitError,
  meterLabel,
  meterTone,
  nextUpsell,
  passedUpsells,
  upsellCopy,
  upsellFor,
  usedFraction,
  viewFromLimitError,
  type DailyUsageView,
  type UpsellId,
} from "./daily-limit-model";

const view = (used: number, over: Partial<DailyUsageView> = {}): DailyUsageView => ({
  limited: true,
  plan: "free",
  limitMinutes: 30,
  usedMinutes: used,
  remainingMinutes: Math.max(0, 30 - used),
  reached: used >= 30,
  day: "2026-10-06",
  resetsAt: "2026-10-07T00:00:00.000Z",
  ...over,
});

/** A view against an arbitrary limit (an owner grant or an admin-edited plan). */
const at = (limit: number, used: number): DailyUsageView =>
  view(used, { limitMinutes: limit, remainingMinutes: Math.max(0, limit - used), reached: used >= limit });

describe("upsell thresholds (10 used / 10 left / 3 left on the 30 min Free day)", () => {
  it("none before 10 minutes", () => {
    expect(upsellFor(view(0))).toBeNull();
    expect(upsellFor(view(9))).toBeNull();
  });
  it("10 used -> used10; 10 left -> left10; 3 left -> left3", () => {
    expect(upsellFor(view(10))).toBe("used10");
    expect(upsellFor(view(19))).toBe("used10");
    expect(upsellFor(view(20))).toBe("left10");
    expect(upsellFor(view(26))).toBe("left10");
    expect(upsellFor(view(27))).toBe("left3");
    expect(upsellFor(view(29))).toBe("left3");
  });
  it("nothing at the limit (that's the gate) or on an unlimited plan", () => {
    expect(upsellFor(view(30))).toBeNull();
    expect(upsellFor({ ...view(15), limited: false, limitMinutes: null, remainingMinutes: null })).toBeNull();
  });
  it("thresholds follow an owner grant (remaining, not used, drives the late ones)", () => {
    expect(upsellFor(view(30, { limitMinutes: 60, remainingMinutes: 30, reached: false }))).toBe("used10");
    expect(upsellFor(view(52, { limitMinutes: 60, remainingMinutes: 8, reached: false }))).toBe("left10");
  });
  it("other limits never show '10 used' after '10 left', and skip thresholds the limit never crosses", () => {
    // 60 min: used10 at 10..49, left10 at 50..56, left3 at 57..59.
    expect([at(60, 10), at(60, 49), at(60, 50), at(60, 57)].map(upsellFor)).toEqual(["used10", "used10", "left10", "left3"]);
    // 20 min: 10 used == 10 left, so used10 is skipped; left10 from minute 10.
    expect([at(20, 9), at(20, 10), at(20, 16), at(20, 17)].map(upsellFor)).toEqual([null, "left10", "left10", "left3"]);
    // 15 min: no used10 (left <= 10 by then), left10 at 5 used.
    expect([at(15, 4), at(15, 5), at(15, 12)].map(upsellFor)).toEqual([null, "left10", "left3"]);
    // 10 min: "10 left" from the first minute is skipped; only the last call.
    expect([at(10, 0), at(10, 6), at(10, 7)].map(upsellFor)).toEqual([null, null, "left3"]);
    // 3 min or less: nothing to warn about before the gate.
    expect([at(3, 0), at(3, 2)].map(upsellFor)).toEqual([null, null]);
  });
  it("each is shown once per day; a later one supersedes the earlier ones", () => {
    const shown = new Set<UpsellId>();
    expect(nextUpsell(view(10), shown)).toBe("used10");
    for (const id of passedUpsells("used10")) shown.add(id);
    expect(nextUpsell(view(11), shown)).toBeNull();
    expect(nextUpsell(view(20), shown)).toBe("left10");
    // Jumping straight to 3 left marks all three as done.
    expect(passedUpsells("left3")).toEqual(["used10", "left10", "left3"]);
  });
  it("copy is benefit-led with an Upgrade to Pro CTA; 3 left is a dialog", () => {
    for (const [id, used] of [["used10", 10], ["left10", 20], ["left3", 27]] as const) {
      const u = upsellCopy(id, view(used));
      expect(u.cta).toBe("Upgrade to Pro");
      expect(u.bullets.join(" ")).toMatch(/Unlimited time/);
      expect(`${u.title} ${u.body} ${u.eyebrow}`).not.toMatch(/hour/i);
    }
    expect(upsellCopy("used10", view(10)).title).toBe("10 of your 30 free minutes used");
    expect(upsellCopy("left10", view(20)).title).toBe("10 min left of today's free 30 minutes");
    expect(upsellCopy("left3", view(27))).toMatchObject({ style: "modal", title: "3 minutes left today" });
    expect(upsellCopy("used10", view(10)).style).toBe("toast");
  });
  it("gate headline names the allowance", () => {
    expect(gateTitle(view(30))).toBe("You've used today's free 30 minutes");
    expect(gateTitle(viewFromLimitError({ resetsAt: "r" }))).toBe("You've used today's free time");
  });
});

describe("meter", () => {
  it("labels", () => {
    expect(meterLabel(view(8))).toBe("22 min left today");
    expect(meterLabel(view(0))).toBe("30 min left today");
    expect(meterLabel(view(0, { limitMinutes: 90, remainingMinutes: 75 }))).toBe("1 h 15 min left today");
    expect(meterLabel(view(0, { limitMinutes: 60, remainingMinutes: 60 }))).toBe("1 h left today");
    expect(meterLabel(view(30))).toBe("Daily limit reached");
  });
  it("tone and fill", () => {
    expect(meterTone(view(10))).toBe("ok");
    expect(meterTone(view(20))).toBe("warn");
    expect(meterTone(view(27))).toBe("low");
    expect(meterTone(view(30))).toBe("out");
    expect(usedFraction(view(15))).toBe(0.5);
    expect(usedFraction(view(45, { reached: true }))).toBe(1);
  });
});

describe("gate", () => {
  it("countdown to the reset, never negative", () => {
    const resetsAt = "2026-10-07T00:00:00.000Z";
    expect(countdown(resetsAt, Date.parse("2026-10-06T16:17:47Z"))).toBe("07:42:13");
    expect(countdown(resetsAt, Date.parse("2026-10-07T00:00:05Z"))).toBe("00:00:00");
  });
  it("recognises the typed 402 from the APIs and from resolve", () => {
    expect(isDailyLimitError({ ok: false, code: "daily_limit_reached", resetsAt: "x" })).toBe(true);
    expect(isDailyLimitError({ status: "daily_limit_reached", code: "daily_limit_reached", resetsAt: "x" })).toBe(true);
    expect(isDailyLimitError({ status: "upgrade_required" })).toBe(false);
    expect(isDailyLimitError(null)).toBe(false);
    expect(viewFromLimitError({ resetsAt: "r" })).toMatchObject({ reached: true, resetsAt: "r", limited: true });
  });
  it("plan cards come from the real plans data, Pro highlighted, paid only", () => {
    const cards = gatePlans([
      { id: "starter", name: "Starter", priceUsdMonth: 19, alwaysOn: false, idleMinutes: 15, memoryMb: 2048, parallelAgents: 4, parallelCoders: 1, voice: true },
      { id: "pro", name: "Pro", priceUsdMonth: 49, alwaysOn: true, idleMinutes: null, memoryMb: 2048, parallelAgents: 8, parallelCoders: 2, voice: true },
      { id: "business", name: "Business", priceUsdMonth: 99, alwaysOn: true, idleMinutes: null, memoryMb: 4096, parallelAgents: 16, parallelCoders: 4, voice: true },
      { id: "scale", name: "Scale", priceUsdMonth: 199, alwaysOn: true, idleMinutes: null, memoryMb: 8192, parallelAgents: 24, parallelCoders: 12, voice: true },
    ]);
    expect(cards.map((c) => c.id)).toEqual(["starter", "pro", "business"]);
    expect(cards.find((c) => c.hot)?.id).toBe("pro");
    expect(cards[1].perks).toContain("Always-on hosted gateway");
    expect(cards[0].perks).toContain("Wakes on use, sleeps after 15 min idle");
    expect(cards[2].perks).toContain("16 agents in parallel (4 coding)");
  });
});
