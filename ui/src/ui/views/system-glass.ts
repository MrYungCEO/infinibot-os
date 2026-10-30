/**
 * System-pages glass kit (G7) — the shared premium layer for the Fleet,
 * Hardware, Ollama, Users, Profiles, Auth, Appearance, Branding, Design,
 * Apps, Sites, Mobile and Android pages.
 *
 * It matches the Business hub recipe (layered frosted glass, hairline gold
 * gradient edges, a specular top edge, a slow gold aurora, black-gold brand)
 * but reads only the global `--glass-*` tokens (docs/ui/GLASS.md), so it
 * follows theme, palette / custom brand tokens, reduced transparency,
 * reduced motion and perf mode with no per-page fallbacks.
 *
 * Use it in two ways:
 *   - Light-DOM render functions: call `ensureSystemGlass()` once while
 *     rendering (it injects one <style> into <head>, idempotent) and wrap
 *     the page in `<div class="sg-page">`.
 *   - Shadow-DOM components: add `systemGlassStyles` to `static styles`.
 *
 * Every class is prefixed `sg-` so nothing collides with other pages.
 */

import { css, html, nothing, svg, unsafeCSS, type TemplateResult } from "lit";

// ── Icons ────────────────────────────────────────────────────

export type SgIconName =
  | "activity" | "alert" | "android" | "apps" | "arrowRight" | "bolt" | "brush"
  | "check" | "chevron" | "chip" | "close" | "cloud" | "copy" | "cpu" | "database"
  | "download" | "edit" | "eye" | "file" | "globe" | "grid" | "key" | "layers"
  | "link" | "lock" | "network" | "palette" | "phone" | "play" | "plus" | "refresh"
  | "search" | "server" | "settings" | "shield" | "spark" | "sun" | "trash"
  | "upload" | "user" | "users" | "wifi";

const ICONS: Record<SgIconName, TemplateResult> = {
  activity: svg`<path d="M3 12h4l2.4-6 4.2 12 2.4-6h5"/>`,
  alert: svg`<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4m0 3h.01"/>`,
  android: svg`<rect x="5" y="9" width="14" height="10" rx="2.5"/><path d="M8 9a4 4 0 0 1 8 0M8 5l1.2 2M16 5l-1.2 2M9.5 13h.01M14.5 13h.01"/>`,
  apps: svg`<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>`,
  arrowRight: svg`<path d="M4 12h15m0 0-6-6m6 6-6 6"/>`,
  bolt: svg`<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>`,
  brush: svg`<path d="M14.5 4.5 19.5 9.5 11 18l-5-5 8.5-8.5Z"/><path d="M6 13c-2 0-3 1.5-3 3.5S2 20 2 20s4 .5 5.5-1 1.5-3.5 1.5-3.5"/>`,
  check: svg`<path d="m5 12 4 4L19 6"/>`,
  chevron: svg`<path d="m9 18 6-6-6-6"/>`,
  chip: svg`<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 1v3m6-3v3M9 20v3m6-3v3M20 9h3m-3 6h3M1 9h3m-3 6h3"/>`,
  close: svg`<path d="m7 7 10 10M17 7 7 17"/>`,
  cloud: svg`<path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.2 4.5 4.5 0 0 0 7 18Z"/>`,
  copy: svg`<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>`,
  cpu: svg`<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>`,
  database: svg`<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>`,
  download: svg`<path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16"/>`,
  edit: svg`<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m14.5 7.5 3 3"/>`,
  eye: svg`<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>`,
  file: svg`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>`,
  globe: svg`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z"/>`,
  grid: svg`<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/><rect x="3" y="3" width="18" height="18" rx="3"/>`,
  key: svg`<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 3 3m-6 0 2 2"/>`,
  layers: svg`<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>`,
  link: svg`<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/>`,
  lock: svg`<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>`,
  network: svg`<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5 6.5 17M12 11.5l5.5 5.5"/>`,
  palette: svg`<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-2 0-1.5-1.5-1.6-1.5-3 0-1.1.9-2 2-2H17a4 4 0 0 0 4-4c0-3.9-4-7-9-7Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>`,
  phone: svg`<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>`,
  play: svg`<path d="m9 6 9 6-9 6V6Z"/>`,
  plus: svg`<path d="M12 5v14M5 12h14"/>`,
  refresh: svg`<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8m0-4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16m0 4v-4h-4"/>`,
  search: svg`<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>`,
  server: svg`<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>`,
  settings: svg`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>`,
  shield: svg`<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-4"/>`,
  spark: svg`<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>`,
  sun: svg`<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  trash: svg`<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>`,
  upload: svg`<path d="M12 21V9m0 0-5 5m5-5 5 5M4 4h16"/>`,
  user: svg`<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`,
  users: svg`<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>`,
  wifi: svg`<path d="M2 8.5a15 15 0 0 1 20 0M5 12a10.5 10.5 0 0 1 14 0M8.5 15.5a5.5 5.5 0 0 1 7 0"/><path d="M12 19h.01"/>`,
};

/** Inline stroke icon (inherits currentColor). */
export function sgIcon(name: SgIconName, size = 16): TemplateResult {
  return html`<svg class="sg-ico" width=${size} height=${size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${ICONS[name]}</svg>`;
}

// ── Stylesheet ───────────────────────────────────────────────
// `__LIGHT__` becomes `:root[data-theme="light"]` in the document copy and
// `:host-context([data-theme="light"])` in the shadow-DOM copy.

const SG_CSS_SRC = String.raw`
.sg-page {
  --sg-gold: var(--glass-gold, var(--g-primary, #d9b45f));
  --sg-gold-hi: var(--glass-gold-hi, #f1d38a);
  --sg-gold-deep: var(--glass-gold-deep, #a8762c);
  --sg-fg: var(--glass-fg, var(--text-strong, #f4f1ea));
  --sg-fg-2: var(--glass-fg-2, rgba(244, 241, 234, 0.72));
  --sg-fg-3: var(--glass-fg-3, rgba(244, 241, 234, 0.5));
  --sg-fg-4: var(--glass-fg-4, rgba(244, 241, 234, 0.32));
  --sg-ok: #4cc98a;
  --sg-warn: #e7a74b;
  --sg-bad: #e36b6b;
  --sg-info: #7fb4ff;
  --sg-radius: var(--glass-radius-lg, 20px);
  --sg-radius-md: var(--glass-radius, 14px);
  --sg-radius-sm: var(--glass-radius-sm, 10px);
  --sg-ease: var(--glass-ease, cubic-bezier(0.22, 1, 0.36, 1));
  --sg-spring: var(--glass-spring, cubic-bezier(0.34, 1.36, 0.64, 1));
  --sg-dur: var(--glass-dur, 240ms);
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  gap: 18px;
  /* main.content is a flex row: without these the page shrinks to its content. */
  flex: 1 1 auto;
  align-self: stretch;
  width: 100%;
  max-width: 1480px;
  margin-inline: auto;
  min-width: 0;
  color: var(--sg-fg);
  font-family: var(--glass-font, var(--font-ui, "Inter", -apple-system, system-ui, sans-serif));
  font-size: var(--glass-text-md, 14px);
  letter-spacing: var(--glass-tracking-tight, -0.011em);
  -webkit-font-smoothing: antialiased;
}
__LIGHT__ .sg-page {
  --sg-ok: #1f9a5c;
  --sg-warn: #b9741b;
  --sg-bad: #c84040;
  --sg-info: #2f6fd1;
}
.sg-page *, .sg-page *::before, .sg-page *::after { box-sizing: border-box; }
.sg-page :focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--sg-gold)); }

/* ── Aurora (contained in the page box, never fixed over the app) ── */
.sg-aurora { position: absolute; inset: -12px 0 auto; height: 520px; overflow: hidden; z-index: -1; pointer-events: none; border-radius: var(--sg-radius); }
.sg-aurora::before, .sg-aurora::after {
  content: ""; position: absolute; width: 640px; height: 640px; border-radius: 50%; filter: blur(80px);
  background: radial-gradient(circle, var(--glass-orb-1, rgba(217, 180, 95, 0.3)), transparent 64%);
  top: -380px; left: -120px; opacity: 0.9; animation: sg-drift 38s var(--sg-ease) infinite alternate;
}
.sg-aurora::after {
  background: radial-gradient(circle, var(--glass-orb-2, rgba(168, 118, 44, 0.24)), transparent 62%);
  top: -300px; left: auto; right: -160px; animation-duration: 46s; opacity: 0.7;
}
@keyframes sg-drift { from { transform: translate3d(0, 0, 0) scale(1); } to { transform: translate3d(90px, 60px, 0) scale(1.12); } }

/* ── Surfaces ── */
.sg-glass, .sg-panel, .sg-hero, .sg-card, .sg-stat {
  position: relative;
  isolation: isolate;
}
.sg-glass::before, .sg-panel::before, .sg-hero::before, .sg-card::before, .sg-stat::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none; z-index: 0;
  background: var(--glass-edge-soft, rgba(255, 255, 255, 0.1));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
}
.sg-panel::before, .sg-hero::before { background: var(--glass-edge, rgba(217, 180, 95, 0.3)); }
.sg-glass, .sg-panel {
  background: var(--glass-sheen, none), var(--glass-tint, none), var(--glass-2, rgba(24, 22, 19, 0.56));
  backdrop-filter: var(--glass-blur, blur(20px));
  -webkit-backdrop-filter: var(--glass-blur, blur(20px));
  border-radius: var(--sg-radius);
  box-shadow: var(--glass-elev-2, 0 18px 44px -18px rgba(0, 0, 0, 0.7));
}
.sg-panel { padding: 20px; min-width: 0; }
.sg-card {
  background: var(--glass-sheen, none), var(--glass-3, rgba(30, 27, 23, 0.66));
  border-radius: var(--sg-radius-md);
  box-shadow: var(--glass-elev-1, 0 8px 24px -12px rgba(0, 0, 0, 0.55));
  padding: 16px;
  min-width: 0;
  transition: transform var(--sg-dur) var(--sg-spring), box-shadow var(--sg-dur) var(--sg-ease);
}
/* Cursor-following gloss: set --mx/--my with sgGloss on pointermove. */
.sg-card--interactive { cursor: pointer; overflow: hidden; }
.sg-card--interactive::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; opacity: 0; z-index: 0;
  background: radial-gradient(260px circle at var(--mx, 50%) var(--my, 0%), var(--glass-gold-a10, rgba(217, 180, 95, 0.1)), transparent 60%);
  transition: opacity var(--sg-dur) var(--sg-ease);
}
.sg-card--interactive:hover { transform: var(--glass-lift, translateY(-1px)); box-shadow: var(--glass-elev-3, 0 28px 60px -22px rgba(0, 0, 0, 0.78)), var(--glass-glow-soft, none); }
.sg-card--interactive:hover::before { background: var(--glass-edge); }
.sg-card--interactive:hover::after { opacity: 1; }
.sg-card--interactive:active { transform: scale(0.994); }
.sg-panel > *, .sg-card > *, .sg-hero > *, .sg-stat > * { position: relative; z-index: 1; }
.sg-noise::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 0;
  background-image: var(--glass-noise); opacity: var(--glass-noise-opacity, 0.035); mix-blend-mode: overlay;
}

/* ── Hero ── */
.sg-hero {
  display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 18px 24px;
  padding: clamp(20px, 2.6vw, 32px);
  border-radius: var(--glass-radius-xl, 26px);
  overflow: hidden;
  background:
    radial-gradient(120% 140% at 100% 0%, var(--glass-gold-a16, rgba(217, 180, 95, 0.16)), transparent 46%),
    var(--glass-sheen, none), var(--glass-2, rgba(24, 22, 19, 0.56));
  backdrop-filter: var(--glass-blur, blur(20px));
  -webkit-backdrop-filter: var(--glass-blur, blur(20px));
  box-shadow: var(--glass-elev-3, 0 28px 60px -22px rgba(0, 0, 0, 0.78));
}
.sg-hero__glow {
  position: absolute; z-index: 0; inset: auto -10% -60% auto; width: 60%; height: 140%; pointer-events: none;
  background: radial-gradient(closest-side, var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), transparent);
  filter: blur(30px); opacity: 0.55; animation: sg-breathe 9s ease-in-out infinite;
}
@keyframes sg-breathe { 50% { opacity: 0.85; transform: translate3d(-4%, -3%, 0) scale(1.05); } }
.sg-hero__main { display: flex; gap: 16px; align-items: flex-start; min-width: 0; flex: 1 1 360px; }
.sg-hero__icon {
  flex: none; display: grid; place-items: center; width: 52px; height: 52px; border-radius: 16px;
  color: var(--sg-gold);
  background: var(--glass-gold-tint, rgba(217, 180, 95, 0.14));
  box-shadow: inset 0 0 0 1px var(--glass-stroke-gold, rgba(217, 180, 95, 0.28)), var(--glass-glow-soft, none);
}
.sg-hero__copy { min-width: 0; }
.sg-eyebrow {
  display: inline-flex; align-items: center; gap: 8px; margin: 0 0 8px;
  color: var(--sg-gold); font-size: 10.5px; font-weight: 700; letter-spacing: var(--glass-tracking-caps, 0.16em); text-transform: uppercase;
}
.sg-eyebrow::before { content: ""; width: 18px; height: 1px; background: currentColor; box-shadow: 0 0 10px currentColor; }
.sg-title {
  margin: 0; color: var(--sg-fg);
  font: 650 clamp(24px, 2.8vw, 36px)/1.08 var(--font-ui-display, var(--glass-font, system-ui));
  letter-spacing: -0.03em;
}
.sg-gold-text {
  background: linear-gradient(120deg, var(--sg-gold-hi), var(--sg-gold) 45%, var(--sg-gold-deep));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.sg-sub { margin: 8px 0 0; max-width: 680px; color: var(--sg-fg-2); font-size: 13.5px; line-height: 1.55; }
.sg-hero__side { display: flex; flex-direction: column; align-items: flex-end; gap: 12px; flex: 0 1 auto; min-width: 0; }
.sg-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sg-hero .sg-stats { flex: 1 1 100%; }

/* ── Status pill + LEDs ── */
.sg-status {
  display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;
  background: var(--glass-3, rgba(30, 27, 23, 0.66)); color: var(--sg-fg-2);
  box-shadow: inset 0 0 0 1px var(--glass-stroke, rgba(255, 255, 255, 0.08)), var(--glass-specular, none);
  font-size: 11px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap;
}
.sg-led { --led: var(--sg-fg-4); flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--led); box-shadow: 0 0 0 3px color-mix(in srgb, var(--led) 18%, transparent), 0 0 10px var(--led); }
.sg-led--ok { --led: var(--sg-ok); animation: sg-pulse 2.4s ease-in-out infinite; }
.sg-led--warn { --led: var(--sg-warn); }
.sg-led--bad { --led: var(--sg-bad); }
.sg-led--gold { --led: var(--sg-gold); }
.sg-led--info { --led: var(--sg-info); }
.sg-led--off { --led: var(--sg-fg-4); box-shadow: none; }
@keyframes sg-pulse { 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--led) 8%, transparent), 0 0 14px var(--led); } }

/* ── Stat tiles + gauges ── */
.sg-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; min-width: 0; }
.sg-stat {
  min-width: 0; padding: 14px 16px 15px; border-radius: var(--sg-radius-md);
  background: var(--glass-sheen, none), var(--glass-3, rgba(30, 27, 23, 0.66));
  box-shadow: var(--glass-elev-1, none);
  transition: transform var(--sg-dur) var(--sg-spring), box-shadow var(--sg-dur) var(--sg-ease);
}
.sg-stat:hover { transform: var(--glass-lift, translateY(-1px)); box-shadow: var(--glass-elev-2, none), var(--glass-glow-soft, none); }
.sg-stat__row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sg-stat__label { display: flex; align-items: center; gap: 7px; color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-stat__label .sg-ico { color: var(--sg-gold); opacity: 0.9; flex: none; }
.sg-stat__value { display: block; margin-top: 8px; color: var(--sg-fg); font: 650 26px/1.05 var(--font-ui-display, system-ui); letter-spacing: -0.03em; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-stat__foot { display: block; margin-top: 6px; color: var(--sg-fg-3); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-stat--ok .sg-stat__value { color: var(--sg-ok); }
.sg-stat--warn .sg-stat__value { color: var(--sg-warn); }
.sg-stat--bad .sg-stat__value { color: var(--sg-bad); }
.sg-stat--gold .sg-stat__value { color: var(--sg-gold); }
.sg-meter { position: relative; height: 5px; margin-top: 10px; border-radius: 99px; overflow: hidden; background: var(--glass-hover, rgba(255, 255, 255, 0.06)); box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.2); }
.sg-meter > i { position: absolute; inset: 0 auto 0 0; width: var(--v, 0%); border-radius: inherit; background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: 0 0 10px var(--glass-gold-a40, transparent); transition: width var(--glass-dur-slow, 420ms) var(--sg-ease); }
.sg-meter--ok > i { background: var(--sg-ok); box-shadow: 0 0 10px color-mix(in srgb, var(--sg-ok) 45%, transparent); }
.sg-meter--warn > i { background: var(--sg-warn); }
.sg-meter--bad > i { background: var(--sg-bad); }
.sg-gauge { position: relative; display: inline-grid; place-items: center; flex: none; }
.sg-gauge svg { transform: rotate(-90deg); }
.sg-gauge__track { stroke: var(--glass-hover, rgba(255, 255, 255, 0.07)); }
.sg-gauge__arc { stroke: var(--sg-gold); filter: drop-shadow(0 0 4px var(--glass-gold-a40, transparent)); transition: stroke-dashoffset var(--glass-dur-slow, 420ms) var(--sg-ease); }
.sg-gauge--warn .sg-gauge__arc { stroke: var(--sg-warn); }
.sg-gauge--bad .sg-gauge__arc { stroke: var(--sg-bad); }
.sg-gauge__label { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; color: var(--sg-fg); font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; }
.sg-gauge__label small { display: block; color: var(--sg-fg-3); font-size: 9px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }

/* ── Section head ── */
.sg-section-head { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; color: var(--sg-fg-3); font-size: 11px; font-weight: 700; letter-spacing: var(--glass-tracking-caps, 0.14em); text-transform: uppercase; }
.sg-section-head::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--glass-stroke-gold, rgba(217, 180, 95, 0.28)), transparent); }
.sg-section-head .sg-count { color: var(--sg-gold); font-variant-numeric: tabular-nums; }
.sg-h2 { margin: 0; color: var(--sg-fg); font-size: 15px; font-weight: 640; letter-spacing: -0.012em; }
.sg-muted { color: var(--sg-fg-2); }
.sg-faint { color: var(--sg-fg-3); }
.sg-mono { font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 0.92em; }

/* ── Buttons + inputs ── */
.sg-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 0 14px;
  border: 0; border-radius: 11px; cursor: pointer; white-space: nowrap;
  color: var(--sg-fg); font: 560 13px/1 var(--glass-font, system-ui);
  background: var(--glass-sheen, none), var(--glass-3, rgba(30, 27, 23, 0.66));
  box-shadow: inset 0 0 0 1px var(--glass-stroke-strong, rgba(255, 255, 255, 0.13)), var(--glass-specular, none);
  transition: transform var(--glass-dur-fast, 140ms) var(--sg-ease), box-shadow var(--sg-dur) var(--sg-ease), background var(--sg-dur) var(--sg-ease);
}
.sg-btn:hover:not([disabled]) { background: var(--glass-sheen, none), var(--glass-hover, rgba(255, 255, 255, 0.05)), var(--glass-3); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold, rgba(217, 180, 95, 0.3)), var(--glass-glow-soft, none); }
.sg-btn:active:not([disabled]) { transform: translateY(1px) scale(0.985); }
.sg-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.sg-btn--primary { color: var(--glass-ink, #0b0906); background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 10px 24px -10px var(--glass-gold-a40, rgba(217, 180, 95, 0.4)); font-weight: 650; }
.sg-btn--primary:hover:not([disabled]) { background: var(--glass-gold-fill, var(--sg-gold)); filter: brightness(1.06); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), var(--glass-glow, none); }
.sg-btn--ghost { background: transparent; box-shadow: none; color: var(--sg-fg-2); }
.sg-btn--ghost:hover:not([disabled]) { background: var(--glass-hover); color: var(--sg-fg); box-shadow: none; }
.sg-btn--danger { color: var(--sg-bad); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-bad) 38%, transparent); }
.sg-btn--sm { min-height: 30px; padding: 0 10px; font-size: 12px; border-radius: 9px; }
.sg-btn--icon { width: 34px; padding: 0; }
.sg-input {
  width: 100%; min-height: 38px; padding: 8px 12px; border: 0; border-radius: 11px; outline: none;
  color: var(--sg-fg); font: inherit; font-size: 13.5px;
  background: color-mix(in srgb, var(--glass-base, #07070a) 45%, transparent);
  box-shadow: inset 0 0 0 1px var(--glass-stroke, rgba(255, 255, 255, 0.08)), inset 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: box-shadow var(--sg-dur) var(--sg-ease);
}
__LIGHT__ .sg-input { background: rgba(255, 255, 255, 0.7); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong), inset 0 1px 2px rgba(60, 45, 20, 0.06); }
.sg-input:focus { box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--sg-gold)); }
.sg-input::placeholder { color: var(--sg-fg-4); }

/* ── Chips ── */
.sg-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; color: var(--sg-fg-2); background: var(--glass-hover, rgba(255, 255, 255, 0.05)); box-shadow: inset 0 0 0 1px var(--glass-stroke, rgba(255, 255, 255, 0.08)); }
.sg-chip--gold { color: var(--sg-gold); background: var(--glass-gold-a10); box-shadow: inset 0 0 0 1px var(--glass-gold-a24); }
.sg-chip--ok { color: var(--sg-ok); background: color-mix(in srgb, var(--sg-ok) 11%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-ok) 26%, transparent); }
.sg-chip--warn { color: var(--sg-warn); background: color-mix(in srgb, var(--sg-warn) 11%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-warn) 26%, transparent); }
.sg-chip--bad { color: var(--sg-bad); background: color-mix(in srgb, var(--sg-bad) 11%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-bad) 26%, transparent); }

/* ── Segmented control ── */
.sg-seg { display: inline-flex; gap: 2px; padding: 4px; max-width: 100%; overflow-x: auto; scrollbar-width: none; border-radius: 14px; background: var(--glass-2); box-shadow: inset 0 0 0 1px var(--glass-stroke), var(--glass-elev-1, none); }
.sg-seg::-webkit-scrollbar { display: none; }
.sg-seg > button { flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 7px 13px; border: 0; border-radius: 10px; background: transparent; color: var(--sg-fg-2); font: 560 13px/1 var(--glass-font, system-ui); cursor: pointer; white-space: nowrap; transition: background var(--sg-dur) var(--sg-ease), color var(--sg-dur); }
.sg-seg > button:hover { color: var(--sg-fg); background: var(--glass-gold-a06); }
.sg-seg > button[aria-pressed="true"], .sg-seg > button[aria-selected="true"], .sg-seg > button.active { color: var(--sg-fg); background: linear-gradient(180deg, var(--glass-gold-a24), var(--glass-gold-a10)); box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), 0 6px 18px -8px var(--glass-gold-a40); }

/* ── Empty + skeleton ── */
.sg-empty { display: grid; justify-items: center; gap: 10px; padding: 40px 20px; text-align: center; }
.sg-empty__icon { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 18px; color: var(--sg-gold); background: var(--glass-gold-a10); box-shadow: inset 0 0 0 1px var(--glass-gold-a24), var(--glass-glow-soft, none); }
.sg-empty__title { margin: 4px 0 0; color: var(--sg-fg); font-size: 15px; font-weight: 640; }
.sg-empty__body { margin: 0; max-width: 420px; color: var(--sg-fg-2); font-size: 13px; line-height: 1.55; }
.sg-skel { display: block; height: 14px; border-radius: 8px; background: linear-gradient(90deg, var(--glass-hover) 0%, var(--glass-press, rgba(255, 255, 255, 0.08)) 40%, var(--glass-hover) 80%); background-size: 240% 100%; animation: sg-shimmer 1.5s linear infinite; }
.sg-skel--block { height: 92px; border-radius: var(--sg-radius-md); }
@keyframes sg-shimmer { to { background-position: -240% 0; } }

/* ── Table ── */
.sg-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
.sg-table th { padding: 9px 12px; text-align: left; color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; border-bottom: 1px solid var(--glass-stroke); }
.sg-table td { padding: 11px 12px; border-bottom: 1px solid var(--glass-stroke); color: var(--sg-fg-2); font-variant-numeric: tabular-nums; }
.sg-table tbody tr { transition: background var(--sg-dur) var(--sg-ease); }
.sg-table tbody tr:hover { background: var(--glass-gold-a06); }

/* ── Layout helpers ── */
.sg-grid { display: grid; gap: 14px; min-width: 0; }
.sg-grid--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sg-grid--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.sg-grid--auto { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.sg-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sg-spacer { flex: 1; }
.sg-divider { height: 1px; border: 0; margin: 14px 0; background: linear-gradient(90deg, transparent, var(--glass-stroke-strong), transparent); }

/* ── Modal (glass sheet) ── */
.sg-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 16px; background: color-mix(in srgb, var(--glass-base, #07070a) 62%, transparent); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); animation: sg-fade var(--sg-dur) var(--sg-ease); }
.sg-sheet { position: relative; width: min(560px, 100%); max-height: calc(100vh - 32px); overflow: auto; padding: 22px; border-radius: var(--glass-radius-xl, 24px); color: var(--sg-fg); background: var(--glass-sheen, none), var(--glass-4, rgba(18, 17, 15, 0.9)); backdrop-filter: var(--glass-blur-lg, blur(32px)); -webkit-backdrop-filter: var(--glass-blur-lg, blur(32px)); box-shadow: var(--glass-elev-4), inset 0 0 0 1px var(--glass-stroke-gold); animation: sg-rise var(--glass-dur-slow, 420ms) var(--sg-spring); }
@keyframes sg-fade { from { opacity: 0; } }
@keyframes sg-rise { from { opacity: 0; transform: translateY(10px) scale(0.98); } }

/* ── Entrance (rest state is visible: low-power / reduced motion skip it) ── */
.sg-enter { animation: sg-in var(--glass-dur-slow, 420ms) var(--sg-ease) both; }
.sg-enter:nth-child(2) { animation-delay: 40ms; }
.sg-enter:nth-child(3) { animation-delay: 80ms; }
.sg-enter:nth-child(4) { animation-delay: 120ms; }
@keyframes sg-in { from { opacity: 0; transform: translateY(6px); } }

/* ── Phones ── */
@media (max-width: 720px) {
  .sg-page { gap: 14px; }
  .sg-hero { padding: 18px; border-radius: var(--sg-radius); }
  .sg-hero__main { flex-basis: 100%; }
  .sg-hero__icon { width: 42px; height: 42px; border-radius: 13px; }
  .sg-hero__side { align-items: stretch; width: 100%; }
  .sg-actions { width: 100%; }
  .sg-actions > .sg-btn { flex: 1 1 auto; }
  .sg-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  /* Two narrow columns: let long labels wrap instead of clipping mid-word. */
  .sg-stat__foot { white-space: normal; overflow-wrap: anywhere; }
  .sg-stat__label { white-space: normal; align-items: flex-start; line-height: 1.3; letter-spacing: 0.08em; overflow-wrap: anywhere; }
  .sg-stat { padding: 12px 13px; }
  .sg-stat__value { font-size: 21px; }
  .sg-panel { padding: 16px; }
  .sg-grid--2, .sg-grid--3 { grid-template-columns: minmax(0, 1fr); }
  .sg-grid--auto { grid-template-columns: minmax(0, 1fr); }
  .sg-aurora::before, .sg-aurora::after { width: 380px; height: 380px; }
}

/* ── Degraded modes ── */
@media (prefers-reduced-motion: reduce) {
  .sg-aurora::before, .sg-aurora::after, .sg-hero__glow, .sg-led--ok, .sg-skel, .sg-enter, .sg-sheet, .sg-backdrop { animation: none !important; }
  .sg-card, .sg-stat, .sg-btn { transition: none !important; }
}
:root.perf-mode .sg-aurora, :root.low-power .sg-aurora, :root.perf-mode .sg-hero__glow, :root.low-power .sg-hero__glow { display: none; }
:root.low-power .sg-enter, :root.low-power .sg-led--ok, :root.low-power .sg-skel { animation: none; }
@media (prefers-reduced-transparency: reduce) {
  .sg-aurora, .sg-hero__glow { display: none; }
  .sg-backdrop { backdrop-filter: none; -webkit-backdrop-filter: none; }
}
`;

/** Document-scoped CSS text (for light-DOM pages). */
export const SYSTEM_GLASS_CSS = SG_CSS_SRC.replaceAll("__LIGHT__", ':root[data-theme="light"]');

/** Shadow-DOM copy: add to a LitElement's `static styles`. */
export const systemGlassStyles = css`${unsafeCSS(
  SG_CSS_SRC.replaceAll("__LIGHT__", ':host-context([data-theme="light"])')
    .replaceAll(":root.perf-mode ", ":host-context(.perf-mode) ")
    .replaceAll(":root.low-power ", ":host-context(.low-power) "),
)}`;

const STYLE_ID = "sg-system-glass";

/** Injects the kit into <head> once. Safe to call on every render. */
export function ensureSystemGlass(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = SYSTEM_GLASS_CSS;
  document.head.appendChild(el);
}

// ── Render helpers ───────────────────────────────────────────

export type SgTone = "ok" | "warn" | "bad" | "gold" | "info" | "off";

export type SgStat = {
  label: string;
  value: string | number;
  foot?: string;
  icon?: SgIconName;
  tone?: Exclude<SgTone, "info" | "off">;
  /** 0..1 — draws a gold meter under the value. */
  meter?: number;
  /**
   * How to colour the meter. "usage" (default) warns as it fills (VRAM, disk);
   * "health" is a share-that-should-be-full (nodes online) — green when full,
   * warn when partial, bad when empty.
   */
  meterKind?: "usage" | "health";
};

export type SgHeroOptions = {
  eyebrow: string;
  title: string;
  /** Trailing words of the title painted in the gold gradient. */
  accent?: string;
  sub?: string | TemplateResult;
  icon?: SgIconName;
  status?: { tone: SgTone; label: string };
  actions?: TemplateResult | typeof nothing;
  stats?: SgStat[];
};

/** Pointermove handler: feeds the cursor position to `.sg-card--interactive` gloss. */
export function sgGloss(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

export function sgLed(tone: SgTone = "ok"): TemplateResult {
  return html`<i class="sg-led sg-led--${tone}" aria-hidden="true"></i>`;
}

export function sgStatus(tone: SgTone, label: string): TemplateResult {
  return html`<span class="sg-status" role="status">${sgLed(tone)}${label}</span>`;
}

export function sgChip(label: string | TemplateResult, tone?: Exclude<SgTone, "off" | "info">, led = false): TemplateResult {
  return html`<span class="sg-chip ${tone ? `sg-chip--${tone}` : ""}">${led && tone ? sgLed(tone) : nothing}${label}</span>`;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

export function sgMeter(value: number, tone?: "ok" | "warn" | "bad"): TemplateResult {
  const pct = Math.round(clamp01(value) * 100);
  return html`<div class="sg-meter ${tone ? `sg-meter--${tone}` : ""}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}>
    <i style="--v:${pct}%"></i>
  </div>`;
}

/** Ring gauge. `value` is 0..1; tone auto-shifts to warn ≥ .75 and bad ≥ .9 unless `autoTone` is false. */
export function sgGauge(value: number, opts: { size?: number; label?: string; caption?: string; autoTone?: boolean } = {}): TemplateResult {
  const size = opts.size ?? 64;
  const v = clamp01(value);
  const stroke = Math.max(4, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const tone = opts.autoTone === false ? "" : v >= 0.9 ? "sg-gauge--bad" : v >= 0.75 ? "sg-gauge--warn" : "";
  const label = opts.label ?? `${Math.round(v * 100)}%`;
  return html`<span class="sg-gauge ${tone}" style="width:${size}px;height:${size}px" role="meter"
    aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(v * 100)} aria-label=${opts.caption ?? label}>
    <svg width=${size} height=${size} viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle class="sg-gauge__track" cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke-width=${stroke}></circle>
      <circle class="sg-gauge__arc" cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke-width=${stroke}
        stroke-linecap="round" stroke-dasharray=${c} stroke-dashoffset=${c * (1 - v)}></circle>
    </svg>
    <span class="sg-gauge__label">${label}${opts.caption ? html`<small>${opts.caption}</small>` : nothing}</span>
  </span>`;
}

function meterTone(v: number, kind: SgStat["meterKind"] = "usage"): "ok" | "warn" | "bad" | undefined {
  if (kind === "health") return v >= 0.999 ? "ok" : v <= 0 ? "bad" : "warn";
  return v >= 0.9 ? "bad" : v >= 0.75 ? "warn" : undefined;
}

export function sgStats(stats: SgStat[]): TemplateResult {
  return html`<div class="sg-stats">
    ${stats.map(
      (s) => html`<div class="sg-stat ${s.tone ? `sg-stat--${s.tone}` : ""}">
        <span class="sg-stat__label">${s.icon ? sgIcon(s.icon, 13) : nothing}${s.label}</span>
        <strong class="sg-stat__value" title=${String(s.value)}>${s.value}</strong>
        ${s.meter !== undefined ? sgMeter(s.meter, meterTone(s.meter, s.meterKind)) : nothing}
        ${s.foot ? html`<span class="sg-stat__foot">${s.foot}</span>` : nothing}
      </div>`,
    )}
  </div>`;
}

/** Page hero: eyebrow, display title (gold accent), subtitle, status pill, actions and stat tiles. */
export function sgHero(o: SgHeroOptions): TemplateResult {
  return html`<header class="sg-hero sg-noise">
    <span class="sg-hero__glow" aria-hidden="true"></span>
    <div class="sg-hero__main">
      ${o.icon ? html`<span class="sg-hero__icon">${sgIcon(o.icon, 24)}</span>` : nothing}
      <div class="sg-hero__copy">
        <p class="sg-eyebrow">${o.eyebrow}</p>
        <h1 class="sg-title">${o.title}${o.accent ? html` <span class="sg-gold-text">${o.accent}</span>` : nothing}</h1>
        ${o.sub ? html`<p class="sg-sub">${o.sub}</p>` : nothing}
      </div>
    </div>
    ${o.status || (o.actions && o.actions !== nothing)
      ? html`<div class="sg-hero__side">
          ${o.status ? sgStatus(o.status.tone, o.status.label) : nothing}
          ${o.actions && o.actions !== nothing ? html`<div class="sg-actions">${o.actions}</div>` : nothing}
        </div>`
      : nothing}
    ${o.stats?.length ? sgStats(o.stats) : nothing}
  </header>`;
}

/** The slow gold aurora behind a page. Put it first inside `.sg-page`. */
export function sgAurora(): TemplateResult {
  return html`<div class="sg-aurora" aria-hidden="true"></div>`;
}

export function sgEmpty(o: { icon?: SgIconName; title: string; body?: string | TemplateResult; action?: TemplateResult }): TemplateResult {
  return html`<div class="sg-empty">
    <span class="sg-empty__icon">${sgIcon(o.icon ?? "spark", 24)}</span>
    <p class="sg-empty__title">${o.title}</p>
    ${o.body ? html`<p class="sg-empty__body">${o.body}</p>` : nothing}
    ${o.action ?? nothing}
  </div>`;
}

export function sgSkeleton(rows = 3, block = false): TemplateResult {
  return html`<div class="sg-grid" aria-busy="true" aria-label="Loading">
    ${Array.from({ length: rows }, (_, i) =>
      html`<span class="sg-skel ${block ? "sg-skel--block" : ""}" style=${block ? "" : `width:${92 - i * 14}%`}></span>`)}
  </div>`;
}
