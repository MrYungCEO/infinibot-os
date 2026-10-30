import * as PIXI from "pixi.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  bakeGalacticTextures,
  galacticTexturesUsable,
  getGalacticTextures,
  resetGalacticTextures,
} from "./galactic-assets";

// Regression: the mesh map lost its floors/furniture after idle, a tab switch
// or a WS-reconnect remount. Baked RenderTextures only exist inside the GL
// context that drew them, so the cache must be per renderer and must re-bake
// once its textures are destroyed.
describe("galactic bake cache", () => {
  const renderers: PIXI.Renderer[] = [];
  const make = () => {
    const r = new PIXI.Renderer({ width: 64, height: 64 });
    renderers.push(r);
    return r;
  };

  afterEach(() => {
    for (const r of renderers.splice(0)) {
      resetGalacticTextures(r);
      r.destroy(true);
    }
  });

  it("reuses the set for the same renderer", () => {
    const r = make();
    const a = bakeGalacticTextures(r);
    expect(bakeGalacticTextures(r)).toBe(a);
    expect(getGalacticTextures(r)).toBe(a);
    expect(galacticTexturesUsable(a)).toBe(true);
  });

  it("bakes a separate set per renderer (one GL context each)", () => {
    const r1 = make();
    const r2 = make();
    const a = bakeGalacticTextures(r1);
    const b = bakeGalacticTextures(r2);
    expect(b).not.toBe(a);
    expect(b.desk).not.toBe(a.desk);
    expect(getGalacticTextures(r1)).toBe(a);
    expect(getGalacticTextures(r2)).toBe(b);
  });

  it("resetting one renderer leaves another engine's textures intact", () => {
    const r1 = make();
    const r2 = make();
    const a = bakeGalacticTextures(r1);
    const b = bakeGalacticTextures(r2);
    resetGalacticTextures(r1);
    expect(galacticTexturesUsable(a)).toBe(false);
    expect(galacticTexturesUsable(b)).toBe(true);
    expect(getGalacticTextures(r1)).toBeNull();
  });

  it("re-bakes when a cached texture was destroyed elsewhere", () => {
    const r = make();
    const a = bakeGalacticTextures(r);
    a.floorA.destroy(true);
    expect(galacticTexturesUsable(a)).toBe(false);
    const b = bakeGalacticTextures(r);
    expect(b).not.toBe(a);
    expect(galacticTexturesUsable(b)).toBe(true);
  });

  it("keeps the shared agent sprite cache across re-bakes", () => {
    const r = make();
    const a = bakeGalacticTextures(r);
    resetGalacticTextures(r);
    expect(bakeGalacticTextures(r).agentSprite).toBe(a.agentSprite);
  });
});
