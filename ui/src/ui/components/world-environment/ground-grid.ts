/**
 * ground-grid.ts — volumetric pulsing floor for <world-environment>.
 *
 * A perspective-warped grid plane laid out to read as the isometric world
 * floor. Built entirely from layered CSS gradients (no canvas):
 *   - a fine line grid (the cells)
 *   - faint diagonal lines → triangular/hex hybrid for a premium, non-terminal feel
 *   - gold accent dots at the intersection nodes
 *   - an additive radial "pulse" ring that sweeps outward from centre, brightening
 *     whatever lines it crosses (period ~4s, reactive to activity via CSS vars)
 *
 * Activity reactivity is driven by two host-set custom properties:
 *   --we-activity      0..1   → line opacity + pulse strength
 *   --we-pulse-speed   s      → pulse period (faster as activity rises)
 */
import { css, html, type TemplateResult } from "lit";

export const groundGridStyles = css`
  .we-floor {
    position: absolute;
    left: 50%;
    top: 52%;
    width: 240%;
    height: 240%;
    /* Lay the plane down into the scene + rotate 45° so cells read as iso diamonds. */
    transform: translate(-50%, -50%) perspective(900px) rotateX(62deg) rotateZ(45deg);
    transform-origin: center center;
    pointer-events: none;
    /* Fade the far edges so the floor melts into the sky. */
    -webkit-mask-image: radial-gradient(60% 60% at 50% 50%, #000 38%, transparent 78%);
    mask-image: radial-gradient(60% 60% at 50% 50%, #000 38%, transparent 78%);
  }

  /* The static grid: cells + hex-hint diagonals + gold intersection nodes. */
  .we-grid {
    position: absolute;
    inset: 0;
    --cell: 68px;
    --line: rgba(120, 150, 210, calc(0.10 + 0.22 * var(--we-activity, 0.3)));
    --diag: rgba(110, 140, 200, calc(0.04 + 0.10 * var(--we-activity, 0.3)));
    --node: rgba(212, 175, 55, calc(0.45 + 0.5 * var(--we-activity, 0.3)));
    background-image:
      /* gold nodes at intersections */
      radial-gradient(circle at 0 0, var(--node) 0, var(--node) 2.1px, transparent 3px),
      /* hex-hint diagonals */
      repeating-linear-gradient(60deg, var(--diag) 0 1px, transparent 1px var(--cell)),
      repeating-linear-gradient(-60deg, var(--diag) 0 1px, transparent 1px var(--cell)),
      /* primary cell lines */
      linear-gradient(var(--line) 1px, transparent 1px),
      linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size:
      var(--cell) var(--cell),
      var(--cell) var(--cell),
      var(--cell) var(--cell),
      var(--cell) var(--cell),
      var(--cell) var(--cell);
    background-position:
      0 0,
      0 0,
      0 0,
      0 0,
      0 0;
  }

  /* Soft core glow under the atrium centre so the floor never feels empty. */
  .we-floor-core {
    position: absolute;
    inset: 0;
    mix-blend-mode: screen;
    background: radial-gradient(
      circle at 50% 50%,
      rgba(212, 175, 55, calc(0.10 + 0.22 * var(--we-activity, 0.3))) 0%,
      rgba(212, 175, 55, calc(0.04 + 0.08 * var(--we-activity, 0.3))) 14%,
      transparent 40%
    );
  }

  /* Additive pulse ring sweeping outward — brightens the lines it crosses. */
  .we-grid-pulse {
    position: absolute;
    inset: 0;
    mix-blend-mode: screen;
    background: radial-gradient(
      circle at 50% 50%,
      transparent 0%,
      transparent var(--r0, 0%),
      rgba(212, 175, 55, calc(0.18 + 0.5 * var(--we-activity, 0.3))) var(--r1, 8%),
      transparent var(--r2, 22%)
    );
    animation: we-pulse var(--we-pulse-speed, 4s) ease-out infinite;
    will-change: background;
  }
  /* Second, offset wave so the floor never feels static. */
  .we-grid-pulse.b {
    animation-delay: calc(var(--we-pulse-speed, 4s) * -0.5);
    opacity: 0.7;
  }
  @keyframes we-pulse {
    0% {
      --r0: 0%;
      --r1: 3%;
      --r2: 12%;
      opacity: calc(0.2 + 0.7 * var(--we-activity, 0.3));
    }
    100% {
      --r0: 60%;
      --r1: 72%;
      --r2: 92%;
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .we-grid-pulse {
      animation: none;
      opacity: 0.25;
      background: radial-gradient(
        circle at 50% 50%,
        rgba(212, 175, 55, 0.12) 0%,
        transparent 45%
      );
    }
  }
`;

/**
 * `--r0/--r1/--r2` are animated via @property-less keyframes which some engines
 * won't interpolate; register them as animatable so the pulse ring actually
 * expands. Injected once into the document (CSS.registerProperty is global).
 */
let registered = false;
export function registerGridProps(): void {
  if (registered) return;
  registered = true;
  const reg = (CSS as unknown as { registerProperty?: (d: PropertyDefinition) => void }).registerProperty;
  if (typeof reg !== "function") return;
  for (const name of ["--r0", "--r1", "--r2"]) {
    try {
      reg.call(CSS, { name, syntax: "<percentage>", inherits: false, initialValue: "0%" });
    } catch {
      /* already registered or unsupported — animation degrades gracefully */
    }
  }
}

type PropertyDefinition = { name: string; syntax: string; inherits: boolean; initialValue: string };

export function renderGround(): TemplateResult {
  return html`
    <div class="we-floor">
      <div class="we-floor-core"></div>
      <div class="we-grid"></div>
      <div class="we-grid-pulse"></div>
      <div class="we-grid-pulse b"></div>
    </div>
  `;
}
