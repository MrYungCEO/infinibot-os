import { describe, expect, it } from "vitest";

import { CONTROL_BAR_ITEMS, planControlBar, sideWidth, type PlanItem } from "./control-bar";

const item = (id: string, side: "left" | "right", widths: number[], orders: number[], lastHidden = true): PlanItem => ({
  id,
  side,
  widths,
  orders,
  lastHidden,
});

// A right side like the real bar: labelled buttons that can go icon-only, then away.
const right = (): PlanItem[] => [
  item("language", "right", [110, 0], [15]),
  item("restart", "right", [96, 36, 0], [22, 62]),
  item("chat", "right", [80, 36, 0], [28, 68]),
  item("live", "right", [74, 36, 0], [32, 82]),
  item("activity", "right", [36, 0], [67]),
];
const left = (): PlanItem[] => [
  item("tabctx", "left", [220, 0], [10]),
  item("brand", "left", [170, 64], [20], false),
  item("agency", "left", [212, 140, 0], [55, 80]),
];

describe("planControlBar", () => {
  it("changes nothing when everything fits", () => {
    const plan = planControlBar({ items: [...left(), ...right()], budgets: { left: 900, right: 900 }, gap: 8, moreWidth: 36 });
    expect(plan.hidden).toEqual([]);
    expect(Object.values(plan.levels).every((l) => l === 0)).toBe(true);
  });

  it("degrades the lowest order first, one step at a time", () => {
    // right needs 110+96+80+74+36 + 4*8 = 428. Budget 330 → language (order 15)
    // goes first (−118 → 310 + more 44 = 354 still > 330), then restart icon (−60).
    const plan = planControlBar({ items: right(), budgets: { left: 0, right: 330 }, gap: 8, moreWidth: 36 });
    expect(plan.hidden).toEqual(["language"]);
    expect(plan.levels.restart).toBe(1);
    expect(plan.levels.chat).toBe(0);
    expect(plan.levels.live).toBe(0);
  });

  it("reserves room for the ⋯ button once anything is hidden", () => {
    const input = { items: right(), budgets: { left: 0, right: 200 }, gap: 8, moreWidth: 36 };
    const plan = planControlBar(input);
    expect(plan.hidden.length).toBeGreaterThan(0);
    expect(sideWidth(input, "right", plan.levels, true)).toBeLessThanOrEqual(200);
  });

  it("labels go icon-only before anything but the language menu is moved away", () => {
    const plan = planControlBar({ items: right(), budgets: { left: 0, right: 240 }, gap: 8, moreWidth: 36 });
    expect(plan.hidden).toEqual(["language"]);
    expect([plan.levels.restart, plan.levels.chat, plan.levels.live]).toEqual([1, 1, 1]);
  });

  it("keeps the sides independent: a crowded right never strips the left", () => {
    const plan = planControlBar({ items: [...left(), ...right()], budgets: { left: 900, right: 60 }, gap: 8, moreWidth: 36 });
    expect(plan.levels.tabctx).toBe(0);
    expect(plan.levels.brand).toBe(0);
    expect(plan.levels.agency).toBe(0);
    expect(plan.hidden).not.toContain("agency");
  });

  it("never hides an item without a hidden level (brand keeps its logo)", () => {
    const plan = planControlBar({ items: left(), budgets: { left: 10, right: 1000 }, gap: 8, moreWidth: 36 });
    expect(plan.levels.brand).toBe(1);
    expect(plan.hidden).toEqual(expect.arrayContaining(["tabctx", "agency"]));
    expect(plan.hidden).not.toContain("brand");
  });

  it("accounts for pinned controls on a side", () => {
    const items = [item("chat", "right", [80, 36, 0], [28, 68])];
    const roomy = planControlBar({ items, budgets: { left: 0, right: 140 }, gap: 8, moreWidth: 36 });
    expect(roomy.levels.chat).toBe(0);
    // A pinned bell (36) + gap now makes the label not fit.
    const tight = planControlBar({ items, budgets: { left: 0, right: 110 }, pinned: { right: 36 }, gap: 8, moreWidth: 36 });
    expect(tight.levels.chat).toBe(1);
  });

  it("drop-only items never summon the ⋯ menu", () => {
    const items = [{ ...item("tabctx", "left", [220, 120, 0], [8, 10]), dropOnly: true }, item("brand", "left", [170, 64], [20], false)];
    const plan = planControlBar({ items, budgets: { left: 180, right: 500 }, gap: 8, moreWidth: 36 });
    expect(plan.hidden).toEqual(["tabctx"]);
    expect(plan.overflow).toEqual([]);
    // The right side is not charged for a ⋯ button.
    const withRight = planControlBar({ items: [...items, item("chat", "right", [80, 36, 0], [28, 68])], budgets: { left: 180, right: 80 }, gap: 8, moreWidth: 36 });
    expect(withRight.levels.chat).toBe(0);
  });

  it("is deterministic", () => {
    const input = { items: [...left(), ...right()], budgets: { left: 250, right: 150 }, gap: 8, moreWidth: 36 };
    expect(planControlBar(input)).toEqual(planControlBar(input));
  });
});

describe("CONTROL_BAR_ITEMS", () => {
  it("has unique ids and increasing orders per item", () => {
    const ids = CONTROL_BAR_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const it of CONTROL_BAR_ITEMS) {
      expect([...it.orders].sort((a, b) => a - b)).toEqual(it.orders);
    }
  });

  it("button labels shrink before any core action leaves the bar", () => {
    const orderOf = (id: string, level: number) => CONTROL_BAR_ITEMS.find((i) => i.id === id)!.orders[level - 1];
    const firstCoreHide = Math.min(...["restart", "canvas", "chart", "chat", "live"].map((id) => orderOf(id, 2)));
    for (const id of ["restart", "canvas", "chart", "chat", "live"]) expect(orderOf(id, 1)).toBeLessThan(firstCoreHide);
    // Live Action is the last right-side control to go.
    const rightHides = CONTROL_BAR_ITEMS.filter((i) => i.side === "right").map((i) => i.orders[i.orders.length - 1]);
    expect(Math.max(...rightHides)).toBe(orderOf("live", 2));
  });
});
