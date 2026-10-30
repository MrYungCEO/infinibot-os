/**
 * Procedural sprite textures for the glow3d helpers — soft radial discs used
 * by halos, energy pulses, dust and stars. Canvas-drawn once per key and
 * cached, so every scene shares the same GPU textures.
 */

import * as THREE from "three";

const cache = new Map<string, THREE.Texture>();

/**
 * White radial disc (opaque centre → transparent rim). `core` is the
 * fraction of the radius kept fully bright; `power` shapes the falloff.
 */
export function radialSpriteTexture(size = 64, core = 0.05, power = 1.6): THREE.Texture {
  const key = `${size}:${core}:${power}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const data = radialSpritePixels(size, core, power);
  let tex: THREE.Texture;
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const img = ctx.createImageData(size, size);
      img.data.set(data);
      ctx.putImageData(img, 0, 0);
    }
    tex = new THREE.CanvasTexture(canvas);
  } else {
    // No DOM (React Native / expo-gl): the same pixels as a data texture.
    tex = new THREE.DataTexture(new Uint8Array(data.buffer), size, size, THREE.RGBAFormat);
  }
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** RGBA bytes of the radial disc (white, alpha falls off from `core`). */
export function radialSpritePixels(size: number, core: number, power: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      let a = d <= core ? 1 : Math.max(0, 1 - (d - core) / (1 - core));
      a = Math.pow(a, power);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  return data;
}

/** Parse a CSS hex / rgb(a) colour into a linear-space THREE.Color. */
export function toColor(css: string, fallback = "#9ca3af"): THREE.Color {
  const c = new THREE.Color();
  try {
    const m = css.trim().match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(",").map((s) => parseFloat(s));
      c.setRGB((p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, THREE.SRGBColorSpace);
      return c;
    }
    c.set(css.trim());
  } catch {
    c.set(fallback);
  }
  return c;
}
