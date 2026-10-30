import { describe, expect, it } from "vitest";
import { getDockZone, type GridEnv, type GridRect } from "./grid-geometry";

const env: GridEnv = {
  containerWidth: 1200,
  containerHeight: 800,
  snapSize: 10,
  snapThreshold: 15,
  minWidth: 240,
  minHeight: 160,
  gridMode: "free",
};

const rects: GridRect[] = [
  { id: "drag", x: 620, y: 200, width: 300, height: 300, zIndex: 2 },
  { id: "target", x: 0, y: 0, width: 600, height: 800, zIndex: 1 },
];

describe("getDockZone", () => {
  it("preserves nearest-edge docking by default", () => {
    expect(getDockZone(rects, "drag", 40, 20, env)?.edge).toBe("n");
  });

  it("can favor full-height side docking while hovering a corner", () => {
    const zone = getDockZone(rects, "drag", 40, 20, env, {
      preferFullHeightSides: true,
    });

    expect(zone?.edge).toBe("w");
    expect(zone?.rect.height).toBe(800);
    expect(zone?.targetRect?.height).toBe(800);
  });
});
