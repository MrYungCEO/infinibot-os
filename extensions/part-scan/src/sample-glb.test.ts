import { describe, expect, it } from "vitest";
import { SAMPLE_DIMS, sampleGlb } from "./sample-glb.js";

describe("bundled known-size GLB fixture", () => {
  it("is a valid GLB 2 container for a 40 × 20 × 10 mm box", () => {
    const glb = sampleGlb();
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    expect(SAMPLE_DIMS.orientedBboxMm).toEqual({ length: 40, width: 20, height: 10 });
  });
});
