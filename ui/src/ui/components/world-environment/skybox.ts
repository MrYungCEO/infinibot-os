/**
 * skybox.ts — holographic sky backdrop for <world-environment>.
 *
 * Pure-CSS layered sky: deep radial base, a slowly-rotating holographic wash,
 * 2–3 drifting nebula blobs, and three parallax star fields. No canvas — every
 * layer is a DOM node animated by CSS so the GPU compositor does the work.
 *
 * The parallax offset is applied by the host via the `--we-pan-x/--we-pan-y`
 * custom properties (see world-environment.ts). Star layers multiply that pan
 * by their depth factor so near stars travel further than far stars.
 */
import { css, html, type TemplateResult } from "lit";

export type SkyTheme = "night" | "dusk" | "dawn";

/** Theme → CSS custom-property palette (wash + nebula colors). */
export const SKY_THEMES: Record<SkyTheme, Record<string, string>> = {
  night: {
    "--we-sky-center": "#0a0a12",
    "--we-sky-edge": "#000000",
    "--we-wash": "rgba(212,175,55,0.05)",
    "--we-neb-a": "rgba(212,175,55,0.22)", // gold
    "--we-neb-b": "rgba(245,200,90,0.16)", // amber
    "--we-neb-c": "rgba(60,90,200,0.20)", // deep blue
  },
  dusk: {
    "--we-sky-center": "#140d16",
    "--we-sky-edge": "#040208",
    "--we-wash": "rgba(255,150,90,0.06)",
    "--we-neb-a": "rgba(255,140,80,0.22)",
    "--we-neb-b": "rgba(212,120,160,0.18)",
    "--we-neb-c": "rgba(90,70,180,0.20)",
  },
  dawn: {
    "--we-sky-center": "#10141c",
    "--we-sky-edge": "#020409",
    "--we-wash": "rgba(140,200,255,0.06)",
    "--we-neb-a": "rgba(120,200,255,0.20)",
    "--we-neb-b": "rgba(245,210,140,0.16)",
    "--we-neb-c": "rgba(110,90,210,0.18)",
  },
};

export const skyboxStyles = css`
  .we-sky {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    /* Base: deep radial gradient (center → edges). */
    background: radial-gradient(
      120% 120% at 50% 45%,
      var(--we-sky-center, #0a0a12) 0%,
      #060608 55%,
      var(--we-sky-edge, #000000) 100%
    );
  }

  /* Mid: faint holographic wash, slowly rotating. */
  .we-wash {
    position: absolute;
    inset: -40%;
    background: conic-gradient(
      from 0deg at 50% 50%,
      transparent 0deg,
      var(--we-wash, rgba(212, 175, 55, 0.05)) 60deg,
      transparent 140deg,
      var(--we-wash, rgba(212, 175, 55, 0.05)) 240deg,
      transparent 320deg
    );
    mix-blend-mode: screen;
    animation: we-wash-spin 32s linear infinite;
    will-change: transform;
  }
  @keyframes we-wash-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Nebulae: large soft blurred blobs drifting very slowly. */
  .we-neb {
    position: absolute;
    border-radius: 50%;
    filter: blur(60px);
    mix-blend-mode: screen;
    will-change: transform, opacity;
  }
  .we-neb.a {
    width: 46%;
    height: 46%;
    left: 8%;
    top: 14%;
    background: radial-gradient(circle, var(--we-neb-a) 0%, transparent 70%);
    animation: we-neb-a 46s ease-in-out infinite;
  }
  .we-neb.b {
    width: 38%;
    height: 38%;
    right: 6%;
    top: 30%;
    background: radial-gradient(circle, var(--we-neb-b) 0%, transparent 70%);
    animation: we-neb-b 58s ease-in-out infinite;
  }
  .we-neb.c {
    width: 52%;
    height: 52%;
    left: 26%;
    bottom: 2%;
    background: radial-gradient(circle, var(--we-neb-c) 0%, transparent 70%);
    animation: we-neb-c 64s ease-in-out infinite;
  }
  @keyframes we-neb-a {
    0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.85; }
    50% { transform: translate(6%, -4%) scale(1.12); opacity: 1; }
  }
  @keyframes we-neb-b {
    0%, 100% { transform: translate(0, 0) scale(1.05); opacity: 0.7; }
    50% { transform: translate(-5%, 5%) scale(0.95); opacity: 0.95; }
  }
  @keyframes we-neb-c {
    0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.6; }
    50% { transform: translate(4%, -6%) scale(1.1); opacity: 0.85; }
  }

  /* Parallax star layers. Each multiplies the host pan by its depth factor. */
  .we-stars {
    position: absolute;
    inset: -10%;
    will-change: transform;
  }
  .we-stars.far {
    transform: translate(
      calc(var(--we-pan-x, 0px) * 0.15),
      calc(var(--we-pan-y, 0px) * 0.15)
    );
  }
  .we-stars.mid {
    transform: translate(
      calc(var(--we-pan-x, 0px) * 0.45),
      calc(var(--we-pan-y, 0px) * 0.45)
    );
  }
  .we-stars.near {
    transform: translate(
      calc(var(--we-pan-x, 0px) * 0.9),
      calc(var(--we-pan-y, 0px) * 0.9)
    );
  }
  .we-star {
    position: absolute;
    border-radius: 50%;
    background: #fff;
    animation: we-twinkle var(--tw, 4s) ease-in-out infinite;
    animation-delay: var(--td, 0s);
    will-change: opacity, transform;
  }
  @keyframes we-twinkle {
    0%, 100% { opacity: var(--o0, 0.25); transform: scale(0.85); }
    50% { opacity: var(--o1, 0.95); transform: scale(1.15); }
  }

  @media (prefers-reduced-motion: reduce) {
    .we-wash,
    .we-neb,
    .we-star {
      animation: none !important;
    }
  }
`;

type Star = { x: number; y: number; s: number; tw: number; td: number; o0: number; o1: number };

/** Deterministic-ish star field for one depth layer. */
function makeStars(count: number, sizeRange: [number, number], rnd: () => number): Star[] {
  const out: Star[] = [];
  for (let i = 0; i < count; i++) {
    const s = sizeRange[0] + rnd() * (sizeRange[1] - sizeRange[0]);
    out.push({
      x: rnd() * 100,
      y: rnd() * 100,
      s,
      tw: 2.5 + rnd() * 4.5,
      td: -rnd() * 5,
      o0: 0.12 + rnd() * 0.25,
      o1: 0.6 + rnd() * 0.4,
    });
  }
  return out;
}

function starLayer(cls: string, stars: Star[]): TemplateResult {
  return html`<div class="we-stars ${cls}">
    ${stars.map(
      (st) => html`<span
        class="we-star"
        style="left:${st.x}%;top:${st.y}%;width:${st.s}px;height:${st.s}px;--tw:${st.tw}s;--td:${st.td}s;--o0:${st.o0};--o1:${st.o1}"
      ></span>`,
    )}
  </div>`;
}

/** Build the three parallax star fields once (call from firstUpdated/constructor). */
export function buildStarLayers(rnd: () => number = Math.random): TemplateResult[] {
  return [
    starLayer("far", makeStars(55, [1, 1.6], rnd)),
    starLayer("mid", makeStars(40, [1.4, 2.2], rnd)),
    starLayer("near", makeStars(25, [2, 3.2], rnd)),
  ];
}

/** Full sky markup (base + wash + nebulae + stars). */
export function renderSky(starLayers: TemplateResult[]): TemplateResult {
  return html`
    <div class="we-sky">
      <div class="we-wash"></div>
      <div class="we-neb a"></div>
      <div class="we-neb b"></div>
      <div class="we-neb c"></div>
      ${starLayers}
    </div>
  `;
}
