/**
 * Parallax starfield background for Galactic HQ.
 *
 * Three TilingSprite layers sit on the stage BEHIND the viewport; each layer
 * scrolls its tilePosition against the viewport center at a different factor,
 * giving cheap depth parallax with automatic wrapping. Star textures are
 * baked once from PIXI.Graphics — no shipped assets.
 */

import * as PIXI from 'pixi.js';
import type { Viewport } from 'pixi-viewport';
import { GALACTIC } from './galactic-theme';

const TEX_SIZE = 512;

interface LayerSpec {
  count: number;
  minSize: number;
  maxSize: number;
  baseAlpha: number;
  /** Parallax scroll factor vs viewport center (0 = fixed, 1 = world-locked). */
  factor: number;
  /** Chance a star is gold instead of white. */
  goldChance: number;
}

const LAYER_SPECS: LayerSpec[] = [
  { count: 110, minSize: 1, maxSize: 1, baseAlpha: 0.4, factor: 0.04, goldChance: 0.25 },
  { count: 70, minSize: 1, maxSize: 2, baseAlpha: 0.6, factor: 0.1, goldChance: 0.3 },
  { count: 32, minSize: 2, maxSize: 3, baseAlpha: 0.85, factor: 0.22, goldChance: 0.4 },
];

/** Tiny deterministic PRNG (mulberry32). Seeding the starfield bake makes the
 *  skybox identical every run — a precondition for §5 determinism + the
 *  screenshot-regression / replay-clip pipeline (same input → same frames). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bakeStarTexture(
  renderer: PIXI.Renderer | PIXI.AbstractRenderer,
  spec: LayerSpec,
  seed: number,
): PIXI.RenderTexture {
  const g = new PIXI.Graphics();
  const rng = mulberry32(seed);
  for (let i = 0; i < spec.count; i++) {
    const size = spec.minSize + Math.floor(rng() * (spec.maxSize - spec.minSize + 1));
    const color = rng() < spec.goldChance ? GALACTIC.goldLt : 0xffffff;
    const alpha = 0.5 + rng() * 0.5;
    g.beginFill(color, alpha);
    // Square stars — crisp under SCALE_MODES.NEAREST
    g.drawRect(
      Math.floor(rng() * (TEX_SIZE - spec.maxSize)),
      Math.floor(rng() * (TEX_SIZE - spec.maxSize)),
      size,
      size,
    );
    g.endFill();
  }
  const texture = renderer.generateTexture(g, {
    region: new PIXI.Rectangle(0, 0, TEX_SIZE, TEX_SIZE),
  });
  g.destroy();
  return texture;
}

export class Starfield {
  container: PIXI.Container;

  private layers: { sprite: PIXI.TilingSprite; spec: LayerSpec }[] = [];
  private time = 0;

  constructor(renderer: PIXI.Renderer | PIXI.AbstractRenderer, width: number, height: number) {
    this.container = new PIXI.Container();

    for (let li = 0; li < LAYER_SPECS.length; li++) {
      const spec = LAYER_SPECS[li];
      // Fixed per-layer seed → reproducible skybox across runs (determinism).
      const texture = bakeStarTexture(renderer, spec, 0x9e37 + li * 0x1f1f);
      // generateTexture can hand back a texture with no baseTexture if the
      // renderer isn't ready (observed under high-DPR / cold GL contexts).
      // TilingSprite's TextureMatrix then reads `baseTexture.valid` on null and
      // throws inside the ActivityMap constructor — which blanks the ENTIRE map
      // ("Failed to initialise…"). Skip the layer instead so the world renders.
      if (!texture || !texture.baseTexture) continue;
      const sprite = new PIXI.TilingSprite(texture, width, height);
      sprite.alpha = spec.baseAlpha;
      this.container.addChild(sprite);
      this.layers.push({ sprite, spec });
    }
  }

  /** Call each frame: scrolls layers against the viewport for parallax + twinkle. */
  update(viewport: Viewport, delta = 1): void {
    this.time += delta;
    const cx = viewport.center.x;
    const cy = viewport.center.y;
    this.layers.forEach(({ sprite, spec }, i) => {
      sprite.tilePosition.set(-cx * spec.factor, -cy * spec.factor);
      sprite.alpha = spec.baseAlpha + Math.sin(this.time * 0.02 + i * 2.1) * 0.06;
    });
  }

  resize(width: number, height: number): void {
    for (const { sprite } of this.layers) {
      sprite.width = width;
      sprite.height = height;
    }
  }

  destroy(): void {
    for (const { sprite } of this.layers) {
      sprite.texture.destroy(true);
    }
    this.container.destroy({ children: true });
  }
}
