/**
 * Shared ambience for the SaaS new-member flow: the near-black ground (aurora,
 * perspective grid, scanlines, vignette) and the boot screen the onboarding
 * gate shows while it asks the gateway about the workspace.
 *
 * Kept tiny and dependency-free because the gate imports it eagerly; the
 * quickstart view (lazy chunk) renders the same ground so the boot screen
 * hands off to the console without a visible seam.
 *
 * All styles are scoped under `.sob-*` and only exist in SaaS mode — the local
 * setup wizard never renders any of this.
 */
import { html, type TemplateResult } from "lit";

/** Tight-cropped brand mark (354×384); the full logo PNG is mostly empty canvas. */
const BOOT_MARK = "./infinibot-mark.png";

/** Grid drift period — the phase is pinned to the clock so remounts don't jump. */
const GRID_PERIOD_MS = 7000;

export function renderTerminalGround(): TemplateResult {
  const phase = `-${Math.round(performance.now() % GRID_PERIOD_MS)}ms`;
  return html`<div class="sob-ground" aria-hidden="true">
    <div class="sob-aurora sob-aurora--a"></div>
    <div class="sob-aurora sob-aurora--b"></div>
    <div class="sob-aurora sob-aurora--c"></div>
    <div class="sob-floor">
      <div class="sob-floor__plane"><div class="sob-floor__grid" style="animation-delay:${phase}"></div></div>
    </div>
    <div class="sob-scan"></div>
    <div class="sob-vignette"></div>
  </div>`;
}

const BOOT_LINES = [
  "Gateway link established",
  "Resolving your workspace",
  "Preparing the terminal",
];

/** `lines` lets the cloud shell (no gateway) describe its own boot steps. */
export function renderSaasBootScreen(lines: readonly string[] = BOOT_LINES): TemplateResult {
  return html`${terminalAmbientStyles()}
    <div class="sob-screen sob-boot" role="status" aria-live="polite" aria-label="Loading your workspace">
      ${renderTerminalGround()}
      <div class="sob-boot__core">
        <div class="sob-boot__mark">
          <span class="sob-boot__ring"></span>
          <span class="sob-boot__ring sob-boot__ring--sweep"></span>
          <img src=${BOOT_MARK} width="42" height="46" alt="" />
        </div>
        <div class="sob-boot__title">InfiniBot</div>
        <div class="sob-boot__term">
          <ol class="sob-boot__log">
            ${lines.map(
              (line, i) =>
                html`<li style="--i:${i}"><span class="sob-boot__tick"></span>${line}</li>`,
            )}
          </ol>
          <div class="sob-boot__bar"><span></span></div>
        </div>
      </div>
    </div>`;
}

/**
 * A full-screen message with actions, for when setup can't be loaded: the
 * member always gets an explanation and a way forward, never an empty page.
 */
export function renderSaasSetupNotice(opts: {
  title: string;
  detail: string;
  testid?: string;
  actions: Array<{ label: string; onClick: () => void; primary?: boolean; testid?: string }>;
}): TemplateResult {
  return html`${terminalAmbientStyles()}
    <div class="sob-screen sob-boot" role="alert" data-testid=${opts.testid ?? "saas-setup-notice"}>
      ${renderTerminalGround()}
      <div class="sob-boot__core sob-notice">
        <div class="sob-boot__mark">
          <span class="sob-boot__ring"></span>
          <img src=${BOOT_MARK} width="42" height="46" alt="" />
        </div>
        <div class="sob-boot__title">InfiniBot</div>
        <h1 class="sob-notice__title">${opts.title}</h1>
        <p class="sob-notice__detail">${opts.detail}</p>
        <div class="sob-notice__actions">
          ${opts.actions.map(
            (a) => html`<button
              type="button"
              class="sob-notice__btn ${a.primary ? "is-primary" : ""}"
              data-testid=${a.testid ?? "saas-setup-action"}
              @click=${a.onClick}
            >
              ${a.label}
            </button>`,
          )}
        </div>
      </div>
    </div>`;
}

/**
 * Ground + boot-screen styles. The quickstart view layers its own console
 * styles on top of these.
 */
export function terminalAmbientStyles(): TemplateResult {
  return html`<style>
    .sob-screen {
      /* Palette: the live gold accent and the neon-glow layer (base.css) with
         dark-safe fallbacks — the flow is dark by design in every theme. */
      --sob-gold: var(--g-primary, #fbbf24);
      /* Derived from gold, not --g-accent: the light theme's accent is violet. */
      --sob-amber: color-mix(in srgb, var(--sob-gold) 70%, #ff8a00 30%);
      --sob-warm: color-mix(in srgb, var(--sob-gold) 80%, #ff8a00 20%);
      --sob-ink: #030303;
      --sob-fg: #f5f2ea;
      --sob-fg-2: rgba(245, 242, 234, 0.7);
      --sob-fg-3: rgba(245, 242, 234, 0.46);
      --sob-fg-4: rgba(245, 242, 234, 0.26);
      --sob-line: color-mix(in srgb, var(--sob-gold) 14%, rgba(255, 255, 255, 0.07));
      --sob-line-2: color-mix(in srgb, var(--sob-gold) 36%, transparent);
      --sob-glow-soft: var(--glow-gold-soft, 0 0 8px color-mix(in srgb, var(--sob-gold) 35%, transparent));
      --sob-glow: var(
        --glow-gold-strong,
        0 0 10px color-mix(in srgb, var(--sob-gold) 55%, transparent),
        0 0 20px color-mix(in srgb, var(--sob-warm) 30%, transparent)
      );
      --sob-text-glow: var(
        --neon-text-shadow,
        0 0 4px color-mix(in srgb, var(--sob-gold) 60%, transparent),
        0 0 12px color-mix(in srgb, var(--sob-warm) 40%, transparent)
      );
      --sob-ok: color-mix(in srgb, var(--ok, #22c55e) 72%, #ffffff);
      --sob-danger: #f87171;
      --sob-sans: "Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif;
      --sob-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sob-ease: cubic-bezier(0.16, 1, 0.3, 1);

      position: fixed;
      inset: 0;
      z-index: 50;
      overflow-x: hidden;
      overflow-y: auto;
      background: var(--sob-ink);
      color: var(--sob-fg);
      color-scheme: dark;
      font-family: var(--sob-sans);
      font-size: 15px;
      line-height: 1.55;
      letter-spacing: 0;
      -webkit-font-smoothing: antialiased;
    }
    /* The laptop band zooms <body> to 0.7 for the dense operating surfaces.
       Onboarding is a focused, single-console screen — render it 1:1. */
    @media (min-width: 1101px) and (max-width: 1680px) {
      .sob-screen { zoom: calc(1 / var(--ui-viewport-zoom, 0.7)); }
    }
    :root[data-viewport-scale="off"] .sob-screen { zoom: 1; }

    /* ── Ground ───────────────────────────────────────────── */
    .sob-ground {
      position: fixed; inset: 0; pointer-events: none; overflow: hidden;
      background:
        radial-gradient(120% 90% at 50% 0%, #0d0b07 0%, var(--sob-ink) 62%);
    }
    .sob-aurora {
      position: absolute; border-radius: 50%;
      will-change: transform;
      animation: sob-drift 26s ease-in-out infinite alternate;
    }
    .sob-aurora--a {
      width: 110vmax; height: 60vmax; left: 50%; top: -34vmax; margin-left: -55vmax;
      background: radial-gradient(closest-side, color-mix(in srgb, var(--sob-gold) 17%, transparent), transparent 72%);
    }
    .sob-aurora--b {
      width: 70vmax; height: 50vmax; right: -24vmax; bottom: -22vmax;
      background: radial-gradient(closest-side, color-mix(in srgb, var(--sob-warm) 11%, transparent), transparent 70%);
      animation-duration: 32s; animation-direction: alternate-reverse;
    }
    .sob-aurora--c {
      width: 56vmax; height: 40vmax; left: -22vmax; top: 30vh;
      background: radial-gradient(closest-side, color-mix(in srgb, var(--sob-amber) 7%, transparent), transparent 70%);
      animation-duration: 38s;
    }
    @keyframes sob-drift {
      0% { transform: translate3d(0, 0, 0) scale(1); }
      50% { transform: translate3d(3vmax, 2vmax, 0) scale(1.06); }
      100% { transform: translate3d(-2vmax, 1vmax, 0) scale(0.97); }
    }
    /* Receding floor grid: the plane pivots on its near (bottom) edge and runs
       away to a horizon, so line spacing shrinks with distance. */
    .sob-floor {
      position: absolute; left: 0; right: 0; bottom: 0; height: 46vh;
      perspective: 420px; perspective-origin: 50% 0%;
      overflow: hidden;
      -webkit-mask-image: linear-gradient(to top, rgba(0,0,0,.9) 0%, rgba(0,0,0,.4) 55%, transparent 100%);
      mask-image: linear-gradient(to top, rgba(0,0,0,.9) 0%, rgba(0,0,0,.4) 55%, transparent 100%);
    }
    .sob-floor__plane {
      position: absolute; left: -60%; right: -60%; bottom: 0; height: 260%;
      transform-origin: 50% 100%; transform: rotateX(76deg);
      overflow: hidden; opacity: 0.7;
    }
    /* Drift is a transform on a layer one cell taller than the plane, so the
       grid never repaints — it only moves on the compositor. */
    .sob-floor__grid {
      position: absolute; left: 0; right: 0; top: -56px; bottom: 0;
      background-image:
        linear-gradient(color-mix(in srgb, var(--sob-gold) 30%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--sob-gold) 26%, transparent) 1px, transparent 1px);
      background-size: 56px 56px;
      background-position: 50% 0;
      will-change: transform;
      animation: sob-grid 7s linear infinite; /* = GRID_PERIOD_MS */
    }
    @keyframes sob-grid { to { transform: translateY(56px); } }
    .sob-scan {
      position: absolute; inset: 0;
      background: repeating-linear-gradient(0deg, rgba(255,255,255,0.022) 0 1px, transparent 1px 3px);
      mix-blend-mode: overlay;
    }
    .sob-scan::after {
      content: ""; position: absolute; left: 0; right: 0; height: 22vh; top: -22vh;
      background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--sob-gold) 5%, transparent) 50%, transparent);
      animation: sob-sweep 9s linear infinite;
    }
    @keyframes sob-sweep { to { transform: translateY(144vh); } }
    .sob-vignette {
      position: absolute; inset: 0;
      background: radial-gradient(130% 100% at 50% 40%, transparent 55%, rgba(0,0,0,0.75) 100%);
    }

    /* ── Boot screen ──────────────────────────────────────── */
    .sob-boot { display: grid; place-items: center; }
    .sob-boot__core {
      position: relative; display: flex; flex-direction: column; align-items: center;
      gap: 18px; padding: 24px; animation: sob-fade-in 0.6s var(--sob-ease) both;
    }
    .sob-boot__mark {
      position: relative; width: 92px; height: 92px; display: grid; place-items: center;
      border-radius: 50%;
      background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--sob-gold) 14%, transparent), rgba(255,255,255,0.02) 70%);
      box-shadow: var(--sob-glow-soft), inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .sob-boot__mark img { width: auto; height: 46px; aspect-ratio: 354 / 384; object-fit: contain; filter: drop-shadow(0 0 10px color-mix(in srgb, var(--sob-gold) 40%, transparent)); }
    .sob-boot__ring {
      position: absolute; inset: -1px; border-radius: 50%;
      border: 1px solid var(--sob-line-2);
    }
    .sob-boot__ring--sweep {
      inset: -7px; border: none;
      background: conic-gradient(from 0deg, transparent 0 70%, color-mix(in srgb, var(--sob-gold) 85%, transparent) 96%, transparent);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1px));
      animation: sob-spin 1.6s linear infinite;
    }
    @keyframes sob-spin { to { transform: rotate(360deg); } }
    .sob-boot__title {
      font-family: var(--sob-mono); font-size: 12px; font-weight: 500;
      letter-spacing: 0.42em; text-transform: uppercase; padding-left: 0.42em;
      color: var(--sob-gold); text-shadow: var(--sob-text-glow);
    }
    .sob-boot__term { display: flex; flex-direction: column; gap: 16px; width: max-content; margin-top: 4px; }
    .sob-boot__log {
      list-style: none; margin: 0; padding: 0;
      font-family: var(--sob-mono); font-size: 12px; line-height: 1.9; color: var(--sob-fg-3);
    }
    .sob-boot__log li {
      display: flex; align-items: center; gap: 10px;
      /* Hidden only while the animation waits its turn (fill: both), so the
         lines still show when low-power mode strips animations. */
      animation: sob-line-in 0.45s var(--sob-ease) both;
      animation-delay: calc(0.25s + var(--i) * 0.38s);
    }
    .sob-boot__log li:last-child::after {
      content: ""; width: 7px; height: 13px; margin-left: 2px; background: var(--sob-gold);
      animation: sob-caret 1s steps(1) infinite;
    }
    .sob-boot__tick {
      width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
      background: var(--sob-gold); box-shadow: 0 0 8px var(--sob-gold);
    }
    @keyframes sob-line-in { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }
    @keyframes sob-caret { 50% { opacity: 0; } }
    @keyframes sob-fade-in { from { opacity: 0; } to { opacity: 1; } }
    .sob-boot__bar {
      width: 100%; height: 1px; overflow: hidden; position: relative;
      background: var(--sob-line);
    }
    .sob-boot__bar span {
      position: absolute; top: 0; bottom: 0; width: 38%;
      background: linear-gradient(90deg, transparent, var(--sob-gold), transparent);
      animation: sob-bar 1.3s var(--sob-ease) infinite;
    }
    @keyframes sob-bar { from { transform: translateX(-100%); } to { transform: translateX(270%); } }

    /* ── Setup notice (error / retry) ─────────────────────── */
    .sob-notice { max-width: min(480px, calc(100vw - 48px)); text-align: center; }
    .sob-notice__title {
      margin: 4px 0 0; font: 600 clamp(22px, 3.2vw, 28px)/1.15 var(--sob-sans);
      letter-spacing: -0.01em; color: var(--sob-fg);
    }
    .sob-notice__detail { margin: 0; color: var(--sob-fg-2); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
    .sob-notice__actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 6px; }
    .sob-notice__btn {
      appearance: none; cursor: pointer; min-height: 44px; padding: 10px 22px; border-radius: 10px;
      font: 600 13px/1 var(--sob-sans); letter-spacing: 0.02em; color: var(--sob-fg-2);
      background: rgba(255, 255, 255, 0.03); border: 1px solid var(--sob-line-2);
      transition: transform 0.2s var(--sob-ease), box-shadow 0.2s var(--sob-ease), color 0.2s;
    }
    .sob-notice__btn:hover { color: var(--sob-fg); transform: translateY(-1px); }
    .sob-notice__btn.is-primary {
      color: var(--sob-ink); background: linear-gradient(180deg, var(--sob-gold), var(--sob-amber));
      border-color: color-mix(in srgb, var(--sob-gold) 60%, transparent); box-shadow: var(--sob-glow-soft);
    }
    .sob-notice__btn.is-primary:hover { box-shadow: var(--sob-glow); }
    .sob-notice__btn:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 3px; }

    @media (prefers-reduced-motion: reduce) {
      .sob-screen *, .sob-screen *::before, .sob-screen *::after {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        animation-delay: 0s !important;
        transition-duration: 0.001ms !important;
      }
    }
  </style>`;
}
