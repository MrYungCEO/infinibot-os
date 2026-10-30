import { describe, expect, it } from "vitest";

import {
  placeAgentOverlays,
  placeFloatingRect,
  screenRectsOverlap,
  type LabelPlacementInput,
  type ScreenRect,
} from "../overlay-placement";

const rect = (x: number, y: number, width = 72, height = 18): ScreenRect => ({ x, y, width, height });

const label = (id: string, priority: number, preferred = rect(100, 100)): LabelPlacementInput => ({
  id,
  ownerId: id,
  preferred,
  fallbackTop: preferred.y + 70,
  priority,
  allowHide: false,
});

describe("placeAgentOverlays", () => {
  it("gives the preferred slot to the higher-priority label", () => {
    const result = placeAgentOverlays({
      sprites: [],
      bubbles: [],
      labels: [label("resting", 1), label("tool-active", 4)],
    });

    expect(result.labels["tool-active"].offsetX).toBe(0);
    expect(result.labels["tool-active"].offsetY).toBe(0);
    expect(result.labels.resting.rect).not.toEqual(result.labels["tool-active"].rect);
    expect(screenRectsOverlap(result.labels.resting.rect, result.labels["tool-active"].rect)).toBe(false);
  });

  it("nudges labels upward around sprites before using the below-feet fallback", () => {
    const result = placeAgentOverlays({
      sprites: [{ id: "neighbor", rect: rect(90, 88, 92, 48) }],
      bubbles: [],
      labels: [label("running", 3, rect(100, 110, 72, 18))],
    });

    const placed = result.labels.running;
    expect(placed.hidden).toBe(false);
    expect(screenRectsOverlap(placed.rect, rect(90, 88, 92, 48))).toBe(false);
    expect(placed.offsetY).toBeLessThan(0);
  });

  it("keeps a small previous displacement to prevent one-frame jitter", () => {
    const previousOffset = { x: 0, y: -6 };
    const item = { ...label("stable", 3), previousOffset };
    const result = placeAgentOverlays({ sprites: [], bubbles: [], labels: [item], hysteresisPx: 9 });

    expect(result.labels.stable.offsetX).toBe(previousOffset.x);
    expect(result.labels.stable.offsetY).toBe(previousOffset.y);
  });

  it("offsets overlapping tool bubbles so both remain readable", () => {
    const preferred = rect(120, 80, 84, 22);
    const result = placeAgentOverlays({
      sprites: [],
      bubbles: [
        { id: "a", ownerId: "a", preferred },
        { id: "b", ownerId: "b", preferred },
      ],
      labels: [],
    });

    expect(result.bubbles.a.hidden).toBe(false);
    expect(result.bubbles.b.hidden).toBe(false);
    expect(screenRectsOverlap(result.bubbles.a.rect, result.bubbles.b.rect)).toBe(false);
  });

  it("keeps a crowded 36-label fixture collision-free", () => {
    const labels: LabelPlacementInput[] = Array.from({ length: 36 }, (_, index) => ({
      ...label(`agent-${index}`, 4 - (index % 4), rect(420 + (index % 3) * 4, 360 + (index % 2) * 4, 68, 18)),
      fallbackTop: 470,
    }));
    const result = placeAgentOverlays({
      sprites: Array.from({ length: 8 }, (_, index) => ({
        id: `sprite-${index}`,
        rect: rect(330 + (index % 4) * 70, 300 + Math.floor(index / 4) * 72, 44, 62),
      })),
      bubbles: [],
      labels,
      bounds: { width: 1200, height: 900, padding: 8 },
    });

    const visible = Object.values(result.labels).filter((placement) => !placement.hidden);
    expect(visible).toHaveLength(36);
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        expect(screenRectsOverlap(visible[i].rect, visible[j].rect)).toBe(false);
      }
    }
  });
});

describe("placeFloatingRect", () => {
  const bounds = { width: 1000, height: 700 };
  const size = { width: 300, height: 200 };

  it("sits beside the anchor without covering it", () => {
    const anchor = { x: 400, y: 300, width: 80, height: 90 };
    const p = placeFloatingRect({ anchor, size, bounds });
    expect(p.side).toBe("right");
    expect(p.x).toBeGreaterThanOrEqual(anchor.x + anchor.width);
    expect(p.anchorOverlap).toBe(0);
  });

  it("flips to the left near the right edge", () => {
    const anchor = { x: 860, y: 300, width: 80, height: 90 };
    const p = placeFloatingRect({ anchor, size, bounds });
    expect(p.side).toBe("left");
    expect(p.x + size.width).toBeLessThanOrEqual(anchor.x);
    expect(p.anchorOverlap).toBe(0);
  });

  it("dodges a floor label on the preferred side", () => {
    const anchor = { x: 400, y: 300, width: 80, height: 90 };
    const sign = { x: 490, y: 240, width: 320, height: 220 };
    const p = placeFloatingRect({ anchor, size, bounds, obstacles: [sign] });
    expect(p.obstacleOverlap).toBe(0);
    expect(p.anchorOverlap).toBe(0);
    expect(p.side).not.toBe("right");
  });

  it("stays inside the viewport", () => {
    const anchor = { x: 5, y: 650, width: 40, height: 40 };
    const p = placeFloatingRect({ anchor, size, bounds, margin: 12 });
    expect(p.x).toBeGreaterThanOrEqual(12);
    expect(p.y).toBeGreaterThanOrEqual(12);
    expect(p.x + size.width).toBeLessThanOrEqual(bounds.width - 12);
    expect(p.y + size.height).toBeLessThanOrEqual(bounds.height - 12);
  });
});
