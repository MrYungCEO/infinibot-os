import { describe, expect, it } from "vitest";
import { edgeScrollStep } from "./edge-scroll.js";

describe("edgeScrollStep", () => {
  it("does nothing away from the edges", () => {
    expect(edgeScrollStep(300, 0, 600)).toBe(0);
  });

  it("scrolls back near the start and forward near the end", () => {
    expect(edgeScrollStep(10, 0, 600)).toBeLessThan(0);
    expect(edgeScrollStep(590, 0, 600)).toBeGreaterThan(0);
  });

  it("ramps up to the max speed at (and past) the edge", () => {
    expect(edgeScrollStep(0, 0, 600)).toBe(-18);
    expect(edgeScrollStep(640, 0, 600)).toBe(18);
    expect(Math.abs(edgeScrollStep(40, 0, 600))).toBeLessThan(18);
  });

  it("shrinks the zone for short containers so the middle stays neutral", () => {
    expect(edgeScrollStep(45, 0, 90)).toBe(0);
    expect(edgeScrollStep(0, 0, 0)).toBe(0);
  });
});
