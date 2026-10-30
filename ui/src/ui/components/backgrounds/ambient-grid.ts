/**
 * Ambient Grid — deep-noir dark grid background.
 *
 * A pure-CSS animated background that slots into the same lifecycle as the
 * other entries in app-branding.ts's EFFECTS registry: a factory that takes
 * the bg container + theme tokens and returns an EffectHandle
 * ({ update, dispose }). Unlike the reactbits / FaultyTerminal / Grainient
 * effects, this one ships NO WebGL and NO requestAnimationFrame loop — it is
 * 100% CSS keyframes on transform/opacity, so the GPU compositor carries the
 * whole animation and the main thread stays idle.
 *
 * Lighthouse / frame-budget notes:
 *   • Zero JS executes per frame — no RAF, no canvas, no shader. The two
 *     moving layers animate `transform: translate3d(...)` only, which the
 *     compositor handles off the main thread (no layout, no paint after the
 *     first composite). TBT/INP contribution is ~0.
 *   • The grid itself is two repeating-linear-gradients (1px gold lines on
 *     transparent) — cheap to rasterize once, then just translated.
 *   • will-change:transform is set only on the moving layers, scoped to this
 *     background, and torn down on dispose.
 *   • Respects prefers-reduced-motion: both keyframes are paused.
 *
 * The module owns a single <style> tag (scoped by a unique class) plus the
 * DOM layers it injects into the provided container, and cleans both up on
 * dispose so switching backgrounds leaves nothing behind.
 */

import type { ThemeTokens } from "../../theme-glass.js";

export interface AmbientGridHandle {
  update(opts: ThemeTokens | Record<string, unknown>): void;
  dispose(): void;
}

// Grid line color — extremely subtle gold, independent of palette so the grid
// reads consistently even when the user nudges the primary color. Kept as the
// brand gold at very low alpha per the design spec (rgba(212,175,55,0.045)).
const GRID_LINE = "rgba(212, 175, 55, 0.045)";
const GRID_SIZE = 32; // px square cell — also the per-loop translate distance.

let counter = 0;

export function createAmbientGrid(
  container: HTMLElement,
  _tokens: ThemeTokens = {},
): AmbientGridHandle {
  const id = `ambient-grid-${++counter}`;

  // Scoped stylesheet. All rules are namespaced under `.${id}` so multiple
  // mounts (should never happen, but the pipeline guards against races) can't
  // collide, and dispose can remove exactly this block.
  const style = document.createElement("style");
  style.setAttribute("data-ambient-grid", id);
  style.textContent = `
    .${id} {
      position: absolute;
      inset: 0;
      overflow: hidden;
      /* Let the document/body background show through; we only overlay. */
      background: transparent;
    }
    /* Deep black radial vignette — darkens toward the edges so the grid
       fades into the corners. Static (no animation). */
    .${id}__vignette {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: radial-gradient(
        ellipse at center,
        rgba(15, 15, 15, 0) 0%,
        rgba(0, 0, 0, 0.7) 80%
      );
    }
    /* The grid layer is drawn 1 cell larger on each side and translated by
       exactly one cell over the loop, so the motion is seamless/infinite.
       Two repeating-linear-gradients = horizontal + vertical hairlines. */
    .${id}__grid {
      position: absolute;
      inset: -${GRID_SIZE}px;
      pointer-events: none;
      will-change: transform;
      background-image:
        repeating-linear-gradient(
          0deg,
          ${GRID_LINE} 0,
          ${GRID_LINE} 1px,
          transparent 1px,
          transparent ${GRID_SIZE}px
        ),
        repeating-linear-gradient(
          90deg,
          ${GRID_LINE} 0,
          ${GRID_LINE} 1px,
          transparent 1px,
          transparent ${GRID_SIZE}px
        );
      animation: ${id}-drift 24s linear infinite;
    }
    /* A single low-alpha gold beam sweeping left→right, opacity peaking at
       0.04. Wide + soft so it reads as ambient light, not a hard line. */
    .${id}__beam {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 60%;
      pointer-events: none;
      will-change: transform, opacity;
      background: radial-gradient(
        ellipse 60% 120% at 50% 50%,
        rgba(212, 175, 55, 0.04) 0%,
        rgba(212, 175, 55, 0) 70%
      );
      opacity: 0;
      transform: translateX(-100%);
      animation: ${id}-beam 30s linear infinite;
    }
    @keyframes ${id}-drift {
      from { transform: translate3d(0, 0, 0); }
      to   { transform: translate3d(${GRID_SIZE}px, ${GRID_SIZE}px, 0); }
    }
    @keyframes ${id}-beam {
      0%   { transform: translateX(-100%); opacity: 0; }
      15%  { opacity: 0.04; }
      85%  { opacity: 0.04; }
      100% { transform: translateX(220%); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .${id}__grid,
      .${id}__beam {
        animation: none !important;
      }
      .${id}__beam { opacity: 0 !important; }
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.className = id;
  root.setAttribute("aria-hidden", "true");

  const vignette = document.createElement("div");
  vignette.className = `${id}__vignette`;

  const grid = document.createElement("div");
  grid.className = `${id}__grid`;

  const beam = document.createElement("div");
  beam.className = `${id}__beam`;

  // Order: grid (bottom), beam (over grid), vignette (top, darkens edges).
  root.appendChild(grid);
  root.appendChild(beam);
  root.appendChild(vignette);
  container.appendChild(root);

  return {
    // No theme-derived uniforms — the grid is intentionally palette-stable.
    // Present to satisfy the EffectHandle contract / reskin calls.
    update() {
      /* no-op: ambient grid is static across token changes */
    },
    dispose() {
      if (root.parentNode === container) container.removeChild(root);
      if (style.parentNode) style.parentNode.removeChild(style);
    },
  };
}
