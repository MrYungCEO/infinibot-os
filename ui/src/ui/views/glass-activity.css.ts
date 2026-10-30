/**
 * Glass layer for the Activity surfaces:
 *
 *   • /activity page            → `.gaa-page`   (views/agent-activity.ts)
 *   • agent dashboard body      → `.iad-root`   (views/agent-activity-dashboard.ts)
 *   • focused chat modal        → `.gaa-modal`  (views/agent-activity.ts)
 *   • slide-out Activity panel  → `.gaa-drawer` (views/activity-panel.ts)
 *   • grid feed body            → `.gaa-feed`   (views/activity-panel.ts)
 *   • recently-completed feed   → `.rcf-*`, re-skinned only inside the roots above
 *
 * Built on the `.gt-*` / `.ga-*` primitives (glass-tools-shared.ts,
 * glass-agents-shared.ts). Every selector is scoped under one of the roots
 * above so nothing leaks into other pages.
 *
 * Several of these renderers are also embedded in the masonry grid's shadow
 * root (dashboard, chat modal, feed body), where `:root[data-theme="light"]`
 * and `:root.perf-mode` never match. `activityGlassStyle()` therefore appends
 * a shadow-DOM copy of just the theme / perf rules (rewritten to
 * `:host-context(...)`). In the light DOM those extra rules simply never
 * match, so the same `<style>` works in both places.
 */
import { html, type TemplateResult } from "lit";
import { GLASS_AGENTS_LIGHT_CSS, toShadowCss } from "./glass-agents-shared";

const THEME_RULE_RE = /([^{}]+)\{([^{}]*)\}/g;

/**
 * Pull out top-level rules whose every selector starts with
 * `:root[data-theme="light"]` or `:root.perf-mode`, rewritten for shadow roots.
 */
export function shadowThemeShim(cssText: string): string {
  const out: string[] = [];
  for (const m of cssText.matchAll(THEME_RULE_RE)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!selector || selector.startsWith("@")) continue;
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    if (!parts.every((p) => p.startsWith(':root[data-theme="light"]') || p.startsWith(":root.perf-mode"))) continue;
    out.push(`${toShadowCss(parts.map((p) => `${p} `).join(", "))}{${m[2]}}`);
  }
  return out.join("\n");
}

const PRIMITIVES = GLASS_AGENTS_LIGHT_CSS + shadowThemeShim(GLASS_AGENTS_LIGHT_CSS);
const shimCache = new Map<string, string>();

/**
 * `<style>` with the shared glass primitives + `extra`, plus the shadow-root
 * copy of their theme rules. Safe to render more than once.
 */
export function activityGlassStyle(extra: string, opts: { primitives?: boolean } = {}): TemplateResult {
  let shim = shimCache.get(extra);
  if (shim === undefined) {
    shim = shadowThemeShim(extra);
    shimCache.set(extra, shim);
  }
  return html`<style>${opts.primitives === false ? "" : PRIMITIVES}${extra}${shim}</style>`;
}

/**
 * The token HUD is a reusable shadow-root widget whose original world-map
 * scanline treatment is intentionally dark. Activity mounts it in a light
 * glass page too, so install a host-local light override without changing the
 * shared component used by the world map.
 */
export function installActivityTokenGlass(host: Element | undefined): void {
  if (!host) return;
  queueMicrotask(() => {
    const root = host.shadowRoot;
    if (!root || root.querySelector('style[data-style-id="activity-token-glass"]')) return;
    const style = document.createElement("style");
    style.dataset.styleId = "activity-token-glass";
    style.textContent = `
      :host-context([data-theme="light"]) .hud-overlay {
        background: linear-gradient(145deg, rgba(255,255,255,.96), rgba(250,246,238,.82));
        border-color: color-mix(in srgb, var(--gx-gold) 34%, rgba(80,58,16,.14));
        box-shadow: inset 0 1px 0 #fff, 0 14px 32px -24px rgba(74,52,14,.34), 0 0 0 1px rgba(138,95,0,.06);
        backdrop-filter: blur(16px) saturate(120%);
      }
      :host-context([data-theme="light"]) .hud-overlay::after {
        background: radial-gradient(120% 70% at 50% -10%, rgba(255,255,255,.9), transparent 58%);
      }
      :host-context([data-theme="light"]) .hud-scanline { display: none; }
      :host-context([data-theme="light"]) .hud-eyebrow,
      :host-context([data-theme="light"]) .total { color: #765000; text-shadow: none; }
      :host-context([data-theme="light"]) .empty { color: #50483d; }
      :host-context([data-theme="light"]) .hud-footer-strip { background: linear-gradient(90deg, #a87300, #d8a51f); opacity: .7; }
    `;
    root.append(style);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Shared bits
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Gold hairline gradient border painted on ::before (mask trick). */
const HAIRLINE = (sel: string, inset = "0") => `
${sel} {
  content: "";
  position: absolute;
  inset: ${inset};
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(140deg, var(--gt-gold-hair) 0%, color-mix(in srgb, var(--gt-gold) 8%, transparent) 30%, var(--gt-line) 55%, color-mix(in srgb, var(--gt-gold) 26%, transparent) 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}`;

/** Specular top edge painted on ::after. */
const SPECULAR = (sel: string) => `
${sel} {
  content: "";
  position: absolute;
  left: 14%; right: 14%; top: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent);
  opacity: 0.55;
  pointer-events: none;
}`;

/* ═══════════════════════════════════════════════════════════════════════════
 * /activity page
 * ═══════════════════════════════════════════════════════════════════════════ */

export const ACTIVITY_PAGE_CSS = /* css */ `
.gaa-page.gt-scope {
  min-height: 100%;
  width: 100%;
  max-width: 1480px;
  margin: 0 auto;
  padding: 26px clamp(14px, 3vw, 36px) 48px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-sizing: border-box;
  color: var(--gt-fg);
}
.gaa-page .gt-hero { padding-bottom: 2px; }
.gaa-page .gaa-hero-copy { min-width: 0; }
.gaa-hero-side { display: flex; gap: 10px; flex-wrap: wrap; align-items: stretch; }
.gaa-hero-side .gt-stat { min-width: 104px; }
.gaa-stat-row { display: inline-flex; align-items: center; gap: 9px; }

/* Toolbar */
.gaa-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 14px;
  padding: 10px 12px 10px 14px;
}
.gaa-breakdown { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.gaa-breakdown-label {
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--gt-faint);
  margin-right: 4px;
}
.gaa-page .gaa-chip-btn {
  cursor: pointer;
  font-family: var(--mono);
  transition: border-color 200ms ease, background 200ms ease, color 200ms ease, transform 160ms ease;
}
.gaa-page .gaa-chip-btn:hover { border-color: color-mix(in srgb, var(--gt-gold) 40%, transparent); color: var(--gt-fg); }
.gaa-page .gaa-chip-btn:active { transform: scale(0.96); }
.gaa-page .gaa-chip-btn:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.gaa-page .gaa-chip-btn[aria-pressed="true"] {
  color: var(--gt-gold-ink);
  background: var(--gt-gold-faint);
  border-color: color-mix(in srgb, var(--gt-gold) 45%, transparent);
}
.gaa-chip-glyph { display: inline-flex; align-items: center; color: var(--gt-gold-ink); }
.gaa-chip-glyph svg { width: 12px; height: 12px; }
.gaa-chip-num { color: var(--gt-fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.gaa-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.gaa-poll {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.gaa-page .gaa-select {
  height: 34px;
  padding: 0 28px 0 12px;
  border-radius: 999px;
  font: 500 12px var(--mono);
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--gt-dim) 50%), linear-gradient(135deg, var(--gt-dim) 50%, transparent 50%);
  background-position: calc(100% - 15px) 15px, calc(100% - 10px) 15px;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
.gaa-page .gaa-select option { background: var(--gt-surface-solid); color: var(--gt-fg); }
.gaa-page .gaa-sync { height: 34px; border-radius: 999px; padding: 0 16px; }
.gaa-sync svg { width: 14px; height: 14px; }
.gaa-sync[data-busy] svg { animation: gaa-spin 900ms linear infinite; }
@keyframes gaa-spin { to { transform: rotate(360deg); } }

.gaa-slot { min-width: 0; }
.gaa-slot:empty { display: none; }
.gaa-body { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.gaa-credit { width: 100%; max-width: none; }

/* The two telemetry widgets predate the shared glass primitives and own
   shadow roots. Bridge their existing theme variables at the host boundary;
   the queue strip also needs luminance inversion because its legacy surface
   is hard-coded dark inside that shadow root. */
:root[data-theme="light"] .gaa-page queue-activity-strip {
  filter: invert(1) hue-rotate(180deg) saturate(0.85);
}
:root[data-theme="light"] .gaa-page credit-usage-breakdown {
  --g-primary: #765000;
  --g-accent: #9a6a00;
  --g-fg: #241b0d;
  --g-fg-dim: #655c50;
  --g-bg-deep: #fffaf0;
  --g-surface: rgba(255, 255, 255, 0.86);
}

/* Mesh messages */
.gaa-mesh { overflow: hidden; }
.gaa-mesh-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.gaa-mesh-head .ga-section-head { flex: 1; margin: 0; }
.gaa-mesh-sync { font: 500 10px/1 var(--mono); color: var(--gt-faint); letter-spacing: 0.06em; }
.gaa-mesh-list { max-height: 260px; overflow-y: auto; display: grid; gap: 6px; }
.gaa-mesh-row { display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px; }
.gaa-mesh-row[data-read] { opacity: 0.6; }
.gaa-mesh-glyph { color: var(--gt-gold-ink); flex: none; width: 16px; text-align: center; }
.gaa-mesh-main { flex: 1; min-width: 0; }
.gaa-mesh-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
.gaa-mesh-from { color: var(--gt-gold-ink); font-weight: 600; }
.gaa-mesh-to { color: var(--gt-fg); }
.gaa-mesh-arrow, .gaa-mesh-time { color: var(--gt-faint); font: 500 10.5px var(--mono); }
.gaa-mesh-type { height: 20px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em; }
.gaa-mesh-msg { margin-top: 3px; font-size: 12px; color: var(--gt-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Spawn toasts */
.gaa-toasts {
  position: fixed;
  top: 80px;
  right: 20px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(360px, calc(100vw - 24px));
}
.gaa-toast {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 14px;
  border-radius: 16px;
  background: var(--glass-sheen, linear-gradient(transparent, transparent)), var(--glass-4, var(--gt-surface-solid));
  -webkit-backdrop-filter: var(--gt-blur);
  backdrop-filter: var(--gt-blur);
  box-shadow: var(--glass-elev-4, var(--gt-shadow-hover));
  animation: gaa-toast-in 520ms var(--glass-spring, var(--gt-ease)) both;
}
${HAIRLINE(".gaa-toast::before")}
@keyframes gaa-toast-in { from { opacity: 0; transform: translateX(24px) scale(0.98); } }
.gaa-toast-orb {
  flex: none;
  width: 30px; height: 30px;
  display: grid; place-items: center;
  border-radius: 10px;
  color: var(--gt-gold-ink);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 32%, transparent), color-mix(in srgb, var(--gt-gold) 6%, transparent) 70%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 32%, transparent);
}
.gaa-toast-orb svg { width: 15px; height: 15px; }
.gaa-toast-main { flex: 1; min-width: 0; }
.gaa-toast-title { font: 600 10px/1 var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--gt-gold-ink); }
.gaa-toast-line { margin-top: 6px; font-size: 12.5px; color: var(--gt-dim); }
.gaa-toast-line b { color: var(--gt-fg); font-weight: 600; }
.gaa-toast-task { margin-top: 4px; font-size: 11.5px; color: var(--gt-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Shared icon button (toasts, modal, drawer) */
.gaa-icon-btn {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 30px; height: 30px;
  padding: 0;
  border-radius: 10px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  color: var(--gt-dim);
  cursor: pointer;
  transition: color 180ms ease, background 200ms ease, border-color 200ms ease, transform 160ms ease;
}
.gaa-icon-btn svg { width: 14px; height: 14px; }
.gaa-icon-btn:hover { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 35%, transparent); background: color-mix(in srgb, var(--gt-fg) 8%, transparent); }
.gaa-icon-btn:active { transform: scale(0.94); }
.gaa-icon-btn:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.gaa-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }

:root[data-theme="light"] .gaa-toast { background: var(--glass-4, var(--gt-surface-solid)); }

@media (max-width: 640px) {
  .gaa-page { padding: 16px 12px 40px; gap: 12px; }
  .gaa-hero-side { width: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .gaa-hero-side .gt-stat { min-width: 0; }
  .gaa-toolbar { padding: 10px; }
  .gaa-controls { width: 100%; }
  .gaa-controls .gt-seg { flex: 1 1 auto; justify-content: space-between; }
  .gaa-controls .gt-seg button { flex: 1; text-align: center; }
  .gaa-poll > span { display: none; }
  .gaa-controls .gaa-sync { margin-left: auto; }
  .gaa-credit { max-width: none; }
  .gaa-toasts { top: 68px; right: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .gaa-toast, .gaa-sync[data-busy] svg { animation: none !important; }
  .gaa-page .gaa-chip-btn, .gaa-icon-btn { transition: none !important; }
}
:root.perf-mode .gaa-toast { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--gt-surface-solid); }
@media (prefers-reduced-transparency: reduce) {
  .gaa-toast { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important; }
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
 * Recently-completed feed re-skin (scoped)
 * ═══════════════════════════════════════════════════════════════════════════ */

function rcfGlass(scope: string): string {
  const s = (sel: string) => sel.split(",").map((p) => `${scope} ${p.trim()}`).join(", ");
  return /* css */ `
${s(".rcf-root")} {
  background: transparent;
  border: 0;
  border-image: none;
  border-radius: var(--gt-radius-sm);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: none;
  font-family: var(--glass-font, inherit);
}
${s(".rcf-header")} { padding: 10px 6px; border-radius: 12px; min-height: 40px; }
${s(".rcf-header:hover")} { background: color-mix(in srgb, var(--gt-fg) 5%, transparent); }
${s(".rcf-header:focus-visible")} { outline: none; box-shadow: var(--gt-focus); }
${s(".rcf-header-icon, .rcf-card-check")} { color: var(--gt-gold-ink); }
${s(".rcf-header-title")} { font-size: 13px; font-weight: 600; letter-spacing: -0.005em; color: var(--gt-fg); }
${s(".rcf-count-chip")} {
  background: var(--gt-gold-faint);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 30%, transparent);
  color: var(--gt-gold-ink);
  font: 600 10px/1.6 var(--mono);
}
${s(".rcf-loading-dot")} { background: var(--gt-gold); }
${s(".rcf-chevron")} { color: var(--gt-faint); }

/* Filters */
${s(".rcf-compact-filter, .rcf-filter-bar")} { border-bottom: 1px solid var(--gt-line); }
${s(".rcf-compact-filter")} { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; flex-wrap: wrap; }
${s(".rcf-chip")} {
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  color: var(--gt-dim);
  font: 500 11px/1 var(--glass-font, inherit);
  transition: color 200ms ease, background 260ms var(--gt-ease), box-shadow 260ms ease, border-color 200ms ease;
}
${s(".rcf-chip:hover")} { color: var(--gt-fg); background: color-mix(in srgb, var(--gt-fg) 7%, transparent); }
${s(".rcf-chip:focus-visible")} { outline: none; box-shadow: var(--gt-focus); }
${s(".rcf-chip--active, .rcf-chip--success.rcf-chip--active, .rcf-chip--error.rcf-chip--active")} {
  color: var(--gt-fg);
  border-color: color-mix(in srgb, var(--gt-gold) 40%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 22%, transparent), color-mix(in srgb, var(--gt-gold) 8%, transparent));
  box-shadow: 0 4px 14px -6px color-mix(in srgb, var(--gt-gold) 60%, transparent);
}
${s(".rcf-chip--error.rcf-chip--active")} { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); background: var(--danger-subtle); box-shadow: none; }
${s(".rcf-search, .rcf-select")} {
  height: 30px;
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--bg, #050505) 55%, transparent);
  color: var(--gt-fg);
  font: 12px var(--glass-font, inherit);
}
${s(".rcf-search:focus, .rcf-select:focus")} { border-color: color-mix(in srgb, var(--gt-gold) 55%, transparent); box-shadow: 0 0 0 4px var(--gt-gold-faint); background: color-mix(in srgb, var(--bg, #050505) 70%, transparent); }
${s(".rcf-search::placeholder")} { color: var(--gt-faint); }
${s(".rcf-select option")} { background: var(--gt-surface-solid); color: var(--gt-fg); }
${s(".rcf-icon-btn")} { width: 30px; height: 30px; border-radius: 10px; border-color: var(--gt-line); color: var(--gt-dim); }
${s(".rcf-icon-btn:hover")} { color: var(--gt-fg); background: color-mix(in srgb, var(--gt-fg) 7%, transparent); }
${s(".rcf-icon-btn--active")} { color: var(--gt-gold-ink); border-color: color-mix(in srgb, var(--gt-gold) 40%, transparent); background: var(--gt-gold-faint); }
${s(".rcf-proj-menu")} { background: var(--gt-surface-solid); border-color: var(--gt-line); -webkit-backdrop-filter: none; backdrop-filter: none; }
${s(".rcf-proj-option input[type=checkbox]")} { accent-color: var(--gt-gold); }

/* Group header */
${s(".rcf-group-label")} { font: 600 10px/1 var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--gt-gold-ink); }
${s(".rcf-group-line")} { background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 35%, transparent), transparent); }

/* Compact rows */
${s(".rcf-list--compact")} { padding: 6px 8px; gap: 2px; }
${s(".rcf-row")} {
  gap: 10px;
  min-height: 42px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 12px;
  transition: background 220ms ease, border-color 220ms ease, transform 360ms var(--glass-spring, var(--gt-ease));
}
${s(".rcf-row:hover, .rcf-row:focus-visible")} {
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  border-color: color-mix(in srgb, var(--gt-gold) 22%, transparent);
}
${s(".rcf-row:focus-visible")} { box-shadow: var(--gt-focus); }
${s(".rcf-row:active")} { transform: scale(0.995); }
${s(".rcf-row--pinned")} { background: var(--gt-gold-faint); }
${s(".rcf-row-check")} {
  width: 22px; height: 22px;
  display: grid; place-items: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--rcf-status-color) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rcf-status-color) 30%, transparent);
}
${s(".rcf-row-title")} { font-size: 12.5px; font-weight: 500; color: var(--gt-fg); }
${s(".rcf-row-action-btn")} { color: var(--gt-faint); border-radius: 8px; padding: 4px; }
${s(".rcf-row-action-btn:hover")} { color: var(--gt-fg); background: color-mix(in srgb, var(--gt-fg) 8%, transparent); }

/* Cards (comfortable) — no blur: they sit on a blurred panel already */
${s(".rcf-list--comfortable")} { gap: 8px; padding: 8px 2px 4px; }
${s(".rcf-card")} {
  border-radius: var(--gt-radius-sm);
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  transition: transform 420ms var(--glass-spring, var(--gt-ease)), border-color 220ms ease, box-shadow 360ms var(--gt-ease), background 220ms ease;
}
${s(".rcf-card:hover")} {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent);
  background: color-mix(in srgb, var(--gt-fg) 5.5%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent), 0 14px 34px -18px color-mix(in srgb, var(--gt-gold) 45%, transparent);
}
${s(".rcf-card--pinned")} { border-color: color-mix(in srgb, var(--gt-gold) 40%, transparent); }
${s(".rcf-corner")} { display: none; }
${s(".rcf-pin-dot")} { background: var(--gt-gold); box-shadow: 0 0 8px var(--gt-gold); }
${s(".rcf-card-title")} { font-size: 13px; color: var(--gt-fg); letter-spacing: -0.005em; }
${s(".rcf-card-title-btn:hover .rcf-card-title")} { color: var(--gt-gold-ink); }
${s(".rcf-card-title-btn:focus-visible")} { outline: none; box-shadow: var(--gt-focus); border-radius: 6px; }
${s(".rcf-status-pill")} { border-radius: 999px; font: 600 9.5px/1.6 var(--mono); }
${s(".rcf-card-desc")} { font-size: 12px; color: var(--gt-dim); }
${s(".rcf-assignee-chip")} { border-radius: 999px; border-color: var(--gt-line); background: color-mix(in srgb, var(--gt-fg) 5%, transparent); color: var(--gt-dim); font: 500 10.5px var(--mono); }
${s(".rcf-actions")} { border-top-color: var(--gt-line); }
${s(".rcf-card:hover .rcf-actions, .rcf-card:focus-within .rcf-actions")} { max-height: 44px; opacity: 1; padding-top: 8px; border-top: 1px solid var(--gt-line); }
${s(".rcf-action-btn")} {
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  color: var(--gt-dim);
  box-shadow: none;
}
${s(".rcf-action-btn:hover")} { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 35%, transparent); background: color-mix(in srgb, var(--gt-fg) 8%, transparent); box-shadow: none; }
${s(".rcf-action-btn:active")} { transform: scale(0.96); }
${s(".rcf-action-btn--active")} { color: var(--gt-gold-ink); border-color: color-mix(in srgb, var(--gt-gold) 40%, transparent); background: var(--gt-gold-faint); box-shadow: none; }
${s(".rcf-action-btn--danger:hover")} { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); background: var(--danger-subtle); box-shadow: none; }

/* Pills */
${s(".rcf-project-chip")} {
  border-radius: 999px;
  background: var(--gt-gold-faint);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 26%, transparent);
  color: var(--gt-gold-ink);
  font: 500 10.5px/1.5 var(--mono);
  padding: 1px 8px;
}
${s(".rcf-time-ago")} { color: var(--gt-faint); font: 500 10.5px var(--mono); }
${s(".rcf-duration-pill")} { font: 600 10px/1.5 var(--mono); }
${s(".rcf-review-badge")} { color: var(--gt-gold-ink); background: var(--gt-gold-faint); border-color: color-mix(in srgb, var(--gt-gold) 35%, transparent); border-radius: 999px; }

/* Footer */
${s(".rcf-footer")} { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 4px; border-top: 1px solid var(--gt-line); }
${s(".rcf-view-all")} { color: var(--gt-gold-ink); font: 600 11.5px var(--glass-font, inherit); background: none; border: 0; cursor: pointer; padding: 4px 0; }
${s(".rcf-view-all:hover")} { color: var(--gt-fg); }
${s(".rcf-footer-count")} { color: var(--gt-faint); font: 500 10.5px var(--mono); }

/* Empty / error / skeleton */
${s(".rcf-empty")} { padding: 30px 18px; gap: 10px; }
${s(".rcf-empty-icon")} {
  width: 56px; height: 56px;
  display: grid; place-items: center;
  margin-bottom: 2px;
  border-radius: 18px;
  color: var(--gt-gold-ink);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 30%, transparent), color-mix(in srgb, var(--gt-gold) 6%, transparent) 70%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 32%, transparent), 0 18px 40px -16px color-mix(in srgb, var(--gt-gold) 55%, transparent);
}
${s(".rcf-empty-icon svg")} { width: 24px; height: 24px; }
${s(".rcf-empty-text")} { font-size: 14px; font-weight: 600; color: var(--gt-fg); }
${s(".rcf-empty-sub")} { margin: 0; font-size: 12.5px; color: var(--gt-dim); }
${s(".rcf-empty-cta, .rcf-error-retry")} {
  display: inline-flex; align-items: center; gap: 7px;
  height: 34px; padding: 0 16px; margin-top: 4px;
  border-radius: 999px;
  border: 1px solid transparent;
  color: var(--glass-ink, #120c00);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 80%, #fff 20%), var(--gt-gold) 55%, color-mix(in srgb, var(--gt-gold) 80%, #7a4b00 20%));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 8px 22px -8px color-mix(in srgb, var(--gt-gold) 70%, transparent);
  font: 600 12px/1 var(--glass-font, inherit);
  cursor: pointer;
  transition: transform 160ms ease, filter 200ms ease, box-shadow 260ms ease;
}
${s(".rcf-empty-cta:hover, .rcf-error-retry:hover")} { filter: brightness(1.06); }
${s(".rcf-empty-cta:active, .rcf-error-retry:active")} { transform: scale(0.97); }
${s(".rcf-empty-cta:focus-visible, .rcf-error-retry:focus-visible")} { outline: none; box-shadow: var(--gt-focus); }
${s(".rcf-error-card")} { border-radius: var(--gt-radius-sm); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); background: var(--danger-subtle); }
${s(".rcf-skeleton")} { border-radius: 12px; border-color: var(--gt-line); background: color-mix(in srgb, var(--gt-fg) 3%, transparent); }
${s(".rcf-skel-line, .rcf-skel-chip, .rcf-skel-desc")} { background: color-mix(in srgb, var(--gt-fg) 7%, transparent); }

@media (prefers-reduced-motion: reduce) {
  ${s(".rcf-row, .rcf-card, .rcf-chip, .rcf-empty-cta")} { transition: none !important; }
  ${s(".rcf-card:hover")} { transform: none; }
}
`;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Agent dashboard (embedded by /activity and the grid Activity panel)
 * ═══════════════════════════════════════════════════════════════════════════ */

export const ACTIVITY_DASH_CSS = /* css */ `
.iad-root.gt-scope {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 0 0 8px;
  min-width: 0;
  color: var(--gt-fg);
  font-family: var(--glass-font, inherit);
}

/* ── Section heads ─────────────────────────────────────────── */
.iad-root .iad-section-hdr {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
}
.iad-root .iad-section-hdr::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 40%, transparent), transparent);
}
.iad-root .iad-section-title {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: var(--gt-fg);
}
.iad-root .iad-section-eyebrow {
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.iad-root .iad-section-badge {
  height: 22px;
  padding: 0 9px;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.iad-root .iad-filter-note { order: 9; }

/* ── Hero stat tiles ───────────────────────────────────────── */
.iad-root .iad-hero-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}
.iad-root .iad-hero-tile {
  --tile-accent: var(--gt-gold);
  position: relative;
  min-width: 0;
  min-height: 148px;
  padding: 16px 18px 12px;
  display: flex;
  flex-direction: column;
  border-radius: var(--gt-radius);
  background: var(--gt-surface);
  -webkit-backdrop-filter: var(--gt-blur);
  backdrop-filter: var(--gt-blur);
  box-shadow: var(--gt-shadow);
  transition: transform 460ms var(--glass-spring, var(--gt-ease)), box-shadow 420ms var(--gt-ease);
}
${HAIRLINE(".iad-root .iad-hero-tile::before")}
${SPECULAR(".iad-root .iad-hero-tile::after")}
.iad-root .iad-hero-tile:hover { transform: translateY(-3px); box-shadow: var(--gt-shadow-hover); }
.iad-root .iad-hero-tile.iad-warn { --tile-accent: var(--warn, #f59e0b); }
.iad-root .iad-hero-tile.iad-danger { --tile-accent: var(--danger, #ef4444); animation: iad-danger-glow 2.4s ease-in-out infinite; }
@keyframes iad-danger-glow {
  50% { box-shadow: var(--gt-shadow), 0 0 0 1px color-mix(in srgb, var(--danger, #ef4444) 35%, transparent), 0 0 34px -6px color-mix(in srgb, var(--danger, #ef4444) 45%, transparent); }
}
.iad-root .iad-hero-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font: 600 10px/1.2 var(--mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.iad-root .iad-hero-label .gt-light { --gt-l: var(--tile-accent); width: 6px; height: 6px; }
.iad-root .iad-hero-trend {
  margin-left: auto;
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.04em;
  color: var(--tile-accent);
}
.iad-root .iad-hero-num {
  margin-top: 14px;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
  font-size: clamp(30px, 3.2vw, 42px);
  font-weight: 650;
  line-height: 1;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
}
.iad-root .iad-hero-val {
  background: linear-gradient(180deg, var(--gt-fg) 35%, color-mix(in srgb, var(--gt-fg) 50%, var(--tile-accent)) 130%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.iad-root .iad-warn .iad-hero-val, .iad-root .iad-danger .iad-hero-val { background: none; color: var(--tile-accent); }
.iad-root .iad-hero-sub {
  font: 500 10.5px/1.2 var(--mono);
  letter-spacing: 0.04em;
  color: var(--gt-faint);
  white-space: nowrap;
}
.iad-root .iad-sparkline { margin-top: auto; padding-top: 12px; color: var(--tile-accent); }
.iad-root .iad-sparkline svg { display: block; width: 100%; height: 30px; overflow: visible; }

/* ── Notification strip ────────────────────────────────────── */
.iad-root .iad-notif-strip { display: flex; flex-wrap: wrap; gap: 8px; }
.iad-root .iad-notif-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(360px, 100%);
  min-width: 0;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  font-size: 12px;
  transition: border-color 200ms ease, background 200ms ease, transform 160ms ease;
}
.iad-root .iad-notif-pill .gt-light { --gt-l: var(--pill-accent); width: 6px; height: 6px; }
.iad-root .iad-notif-pill--link { cursor: pointer; }
.iad-root .iad-notif-pill--link:hover { border-color: color-mix(in srgb, var(--gt-gold) 35%, transparent); background: color-mix(in srgb, var(--gt-fg) 7%, transparent); }
.iad-root .iad-notif-pill--link:active { transform: scale(0.97); }
.iad-root .iad-notif-pill--link:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.iad-root .iad-notif-pill-title { flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--gt-fg); }
.iad-root .iad-notif-pill-body { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gt-dim); }
.iad-root .iad-notif-pill-age { flex: none; font: 500 10.5px var(--mono); color: var(--gt-faint); }

/* ── Goal spotlight + autonomous goal groups ────────────────── */
.iad-root .iad-spot-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.iad-root .iad-spot-card { padding: 14px 15px 13px; display: flex; flex-direction: column; gap: 8px; }
.iad-root .iad-spot-top { display: flex; align-items: center; gap: 8px; }
.iad-root .iad-spot-turns { margin-left: auto; font: 500 10.5px var(--mono); color: var(--gt-faint); }
.iad-root .iad-spot-goal { font-size: 13px; font-weight: 600; line-height: 1.4; color: var(--gt-fg); }
.iad-root .iad-spot-verdict { font-size: 11.5px; font-style: italic; line-height: 1.4; color: var(--gt-dim); }
.iad-root .iad-meter { height: 3px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--gt-fg) 8%, transparent); }
.iad-root .iad-meter > i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 55%, transparent), var(--gt-gold)); box-shadow: 0 0 10px color-mix(in srgb, var(--gt-gold) 60%, transparent); transition: width 600ms var(--gt-ease); }
.iad-root .iad-spot-card .gt-btn { align-self: flex-start; height: 30px; padding: 0 12px; font-size: 11.5px; }

.iad-root .iad-goal-section { padding: 16px 16px 18px; }
.iad-root .iad-goal-cluster + .iad-goal-cluster { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--gt-line); }
.iad-root .iad-goal-header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.iad-root .iad-goal-glyph { color: var(--gt-gold-ink); display: inline-flex; }
.iad-root .iad-goal-glyph svg { width: 15px; height: 15px; }
.iad-root .iad-goal-title-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 600; color: var(--gt-fg); }
.iad-root .iad-goal-turns-chip { font: 500 10.5px var(--mono); color: var(--gt-faint); }

/* ── Running agent cards ───────────────────────────────────── */
.iad-root .iad-agents-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); gap: 14px; }
.iad-root .iad-agent-card {
  --card-accent: var(--gt-gold);
  position: relative;
  isolation: isolate;
  overflow: hidden;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 16px 18px;
  border-radius: var(--gt-radius);
  background: var(--gt-surface);
  box-shadow: var(--gt-shadow);
  transition: transform 460ms var(--glass-spring, var(--gt-ease)), box-shadow 420ms var(--gt-ease), opacity 220ms ease;
}
${HAIRLINE(".iad-root .iad-agent-card::before")}
${SPECULAR(".iad-root .iad-agent-card::after")}
.iad-root .iad-agent-card:hover { transform: translateY(-3px); box-shadow: var(--gt-shadow-hover); }
.iad-root .iad-card-clickable { cursor: pointer; }
.iad-root .iad-card-clickable:active { transform: translateY(-1px) scale(0.995); }
.iad-root .iad-card-clickable:focus-visible { outline: none; box-shadow: var(--gt-shadow-hover), var(--gt-focus); }
.iad-root .iad-agent-card.iad-state-completed { opacity: 0.86; }
.iad-root .iad-agent-card.iad-state-completed:hover { opacity: 1; }

.iad-root .iad-agent-header { display: flex; align-items: center; gap: 10px; min-width: 0; }
.iad-root .iad-backend-icon {
  flex: none;
  width: 32px; height: 32px;
  display: grid; place-items: center;
  border-radius: 10px;
  color: var(--card-accent);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--card-accent) 26%, transparent), color-mix(in srgb, var(--card-accent) 6%, transparent) 72%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--card-accent) 30%, transparent);
}
.iad-root .iad-backend-icon svg { width: 16px; height: 16px; display: block; }
.iad-root .iad-agent-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.iad-root .iad-agent-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em; color: var(--gt-fg); }
.iad-root .iad-brand-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.iad-root .iad-brand-badge { font: 600 9.5px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--gt-gold-ink); }
.iad-root .iad-source-tag { font: 500 9.5px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gt-faint); }
.iad-root .iad-source-tag::before { content: "·"; margin-right: 6px; color: var(--gt-faint); }

.iad-root .iad-state-pill { flex: none; height: 24px; font-size: 10px; letter-spacing: 0.06em; }
.iad-root .iad-state-pill .gt-light { width: 6px; height: 6px; }
.iad-root .iad-pill-icon { display: inline-flex; }
.iad-root .iad-pill-icon svg { width: 11px; height: 11px; display: block; }
.iad-root .iad-state-pill-cancelled { color: var(--gt-faint); }

.iad-root .iad-files-badge, .iad-root .iad-fed-chip { flex: none; height: 22px; font-size: 10px; padding: 0 8px; gap: 4px; }
.iad-root .iad-files-badge svg, .iad-root .iad-fed-chip svg { width: 11px; height: 11px; display: block; }
.iad-root .iad-fed-chip { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }

.iad-root .iad-agent-goal {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--gt-dim);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.iad-root .iad-agent-mid { display: flex; align-items: center; gap: 16px; min-width: 0; }
.iad-root .iad-ring-wrap { position: relative; flex: none; width: 60px; height: 60px; color: var(--ring-color, var(--ok)); }
.iad-root .iad-ring-track { stroke: color-mix(in srgb, var(--gt-fg) 8%, transparent); }
.iad-root .iad-ring-bar { stroke: currentColor; filter: drop-shadow(0 0 4px color-mix(in srgb, currentColor 55%, transparent)); }
.iad-root .iad-ring-label { position: absolute; inset: 0; display: grid; place-items: center; font: 600 11.5px/1 var(--mono); letter-spacing: -0.02em; color: var(--gt-fg); }
.iad-root .iad-agent-stats { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 14px; }
.iad-root .iad-stat { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.iad-root .iad-stat-k { font: 600 9px/1 var(--mono); letter-spacing: 0.16em; color: var(--gt-faint); }
.iad-root .iad-stat-v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12.5px/1.2 var(--glass-font, inherit); font-variant-numeric: tabular-nums; color: var(--gt-fg); }
.iad-root .iad-project-chip { color: var(--gt-gold-ink); font-weight: 600; }
.iad-root .iad-checkpoint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg, #050505) 45%, transparent);
  border: 1px solid var(--gt-line);
  font: 500 11px/1.4 var(--mono);
  color: var(--gt-dim);
  min-width: 0;
}
.iad-root .iad-checkpoint > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.iad-root .iad-checkpoint::before { content: "›"; color: var(--gt-gold-ink); flex: none; }
.iad-root .iad-agent-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.iad-root .iad-footer-spacer { flex: 1; }
.iad-root .iad-model-chip { height: 22px; font-size: 10px; }
.iad-root .iad-mini-btn { height: 28px; padding: 0 11px; border-radius: 999px; font-size: 11.5px; gap: 6px; }
.iad-root .iad-mini-btn svg { width: 12px; height: 12px; }
.iad-root .iad-kanban-btn { background: none; border: 0; padding: 4px 0; cursor: pointer; font: 600 11.5px var(--glass-font, inherit); color: var(--gt-gold-ink); }
.iad-root .iad-kanban-btn:hover { color: var(--gt-fg); }
.iad-root .iad-kanban-btn:focus-visible { outline: none; box-shadow: var(--gt-focus); border-radius: 6px; }

.iad-root .iad-progress-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; overflow: hidden; pointer-events: none; background: color-mix(in srgb, var(--gt-gold) 10%, transparent); }
.iad-root .iad-progress-fill { height: 100%; background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 45%, transparent), var(--gt-gold)); box-shadow: 0 0 10px color-mix(in srgb, var(--gt-gold) 60%, transparent); transition: width 600ms var(--gt-ease); }

/* ── Oversight row (recently completed + pending queue) ────── */
.iad-root .iad-oversight-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
.iad-root .iad-oversight-card { padding: 0; overflow: hidden; }
.iad-root .iad-card-hdr { display: flex; align-items: center; gap: 10px; padding: 16px 18px 12px; }
.iad-root .iad-card-title { flex: 1; min-width: 0; font-size: 14.5px; font-weight: 650; letter-spacing: -0.015em; color: var(--gt-fg); }
.iad-root .iad-card-count { height: 22px; font-size: 10.5px; }
.iad-root .iad-oversight-body { max-height: 360px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--gt-gold) 25%, transparent) transparent; border-top: 1px solid var(--gt-line); }
.iad-root .iad-fade-edges {
  -webkit-mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 16px), transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 16px), transparent 100%);
}
.iad-root .iad-oversight-body .gt-empty { padding: 30px 18px 34px; }

.iad-root .iad-pq-list { padding: 6px 8px; display: grid; gap: 2px; }
.iad-root .iad-pq-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 12px;
  border: 1px solid transparent;
  transition: background 220ms ease, border-color 220ms ease;
}
.iad-root .iad-pq-row:hover { background: color-mix(in srgb, var(--gt-fg) 5%, transparent); border-color: color-mix(in srgb, var(--gt-gold) 22%, transparent); }
.iad-root .iad-pq-left { flex: 1; min-width: 0; }
.iad-root .iad-pq-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 4px; font-size: 12.5px; font-weight: 500; color: var(--gt-fg); }
.iad-root .iad-pq-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font: 500 10.5px var(--mono); color: var(--gt-faint); }
.iad-root .iad-pq-proj { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gt-gold-ink); }
.iad-root .iad-pq-status { display: inline-flex; align-items: center; gap: 6px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--gt-dim); }
.iad-root .iad-pq-status .gt-light { width: 6px; height: 6px; }
.iad-root .iad-spawn-btn { width: 28px; height: 28px; border-radius: 9px; }

/* Running agents empty state */
.iad-root .iad-empty-state { padding: 6px 0; }
.iad-root .iad-empty-state .gt-empty { padding: 36px 20px 40px; }

${rcfGlass(".iad-root")}

/* ── Responsive ───────────────────────────────────────────── */
@media (max-width: 1100px) { .iad-root .iad-hero-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 900px) { .iad-root .iad-oversight-row { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) {
  .iad-root { gap: 18px; }
  .iad-root .iad-hero-row { gap: 10px; }
  .iad-root .iad-hero-tile { min-height: 118px; padding: 13px 13px 10px; }
  .iad-root .iad-hero-label { font-size: 9px; letter-spacing: 0.12em; }
  .iad-root .iad-hero-num { margin-top: 10px; font-size: 28px; }
  .iad-root .iad-sparkline svg { height: 22px; }
  .iad-root .iad-agent-card { padding: 14px 13px 16px; }
  .iad-root .iad-card-hdr { padding: 14px 14px 10px; }
  .iad-root .iad-notif-pill { max-width: 100%; }
  .iad-root .rcf-row .rcf-time-ago { min-width: 0; }
}

/* ── Reduced motion / transparency / perf ──────────────────── */
@media (prefers-reduced-motion: reduce) {
  .iad-root .iad-hero-tile, .iad-root .iad-agent-card, .iad-root .iad-pq-row, .iad-root .iad-notif-pill { transition: none !important; }
  .iad-root .iad-hero-tile:hover, .iad-root .iad-agent-card:hover { transform: none; }
  .iad-root .iad-hero-tile.iad-danger { animation: none !important; }
}
:root.perf-mode .iad-root .iad-hero-tile { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--gt-surface-solid); }
:root.perf-mode .iad-root .iad-agent-card { background: var(--gt-surface-solid); }
@media (prefers-reduced-transparency: reduce) {
  .iad-root .iad-hero-tile, .iad-root .iad-agent-card { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important; }
}
:root[data-theme="light"] .iad-root .iad-hero-tile::after,
:root[data-theme="light"] .iad-root .iad-agent-card::after { background: linear-gradient(90deg, transparent, #fff, transparent); opacity: 1; }
:root[data-theme="light"] .iad-root .iad-hero-tile,
:root[data-theme="light"] .iad-root .iad-agent-card,
:root[data-theme="light"] .iad-root .iad-oversight-card {
  background: linear-gradient(145deg, rgba(255,255,255,0.96), rgba(250,246,238,0.76));
  border-color: color-mix(in srgb, var(--gt-gold) 28%, var(--gt-line));
  box-shadow: inset 0 1px 0 #fff, 0 14px 32px -24px rgba(74, 52, 14, 0.35);
}
:root[data-theme="light"] .iad-root .iad-checkpoint { background: rgba(255, 255, 255, 0.7); }
:root[data-theme="light"] .iad-root .rcf-search,
:root[data-theme="light"] .iad-root .rcf-select { background: rgba(255, 255, 255, 0.8); }
:root[data-theme="light"] .gaa-page .gaa-body .iad-root .iad-hero-tile,
:root[data-theme="light"] .gaa-page .gaa-body .iad-root .iad-agent-card,
:root[data-theme="light"] .gaa-page .gaa-body .iad-root .iad-oversight-card {
  background: linear-gradient(145deg, rgba(255,255,255,0.98), rgba(252,248,240,0.9)) !important;
  border-color: color-mix(in srgb, var(--gt-gold) 30%, rgba(80,58,16,.12)) !important;
  box-shadow: inset 0 1px 0 #fff, 0 16px 34px -26px rgba(74,52,14,.32) !important;
}
:root[data-theme="light"] .gaa-page .iad-root .rcf-chip--active,
:root[data-theme="light"] .gaa-page .iad-root .rcf-chip--success.rcf-chip--active {
  color: #765000 !important;
  border-color: rgba(154,106,0,.34) !important;
  background: rgba(190,137,22,.12) !important;
}
:root[data-theme="light"] .gaa-page .iad-root .rcf-empty-action {
  color: #765000 !important;
  border-color: rgba(154,106,0,.34) !important;
  background: rgba(190,137,22,.12) !important;
}
:root[data-theme="light"] .gaa-page .iad-root .iad-empty { color: #655c50 !important; }
`;

/* ═══════════════════════════════════════════════════════════════════════════
 * Focused chat modal (right-hand drawer)
 * ═══════════════════════════════════════════════════════════════════════════ */

export const ACTIVITY_MODAL_CSS = /* css */ `
.gaa-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: color-mix(in srgb, #000 50%, transparent);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  animation: gaa-fade 240ms ease both;
}
:root[data-theme="light"] .gaa-modal-backdrop { background: rgba(24, 24, 27, 0.22); }
.gaa-modal.gt-scope {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  z-index: 10000;
  width: min(720px, 100vw);
  display: flex;
  flex-direction: column;
  color: var(--gt-fg);
  font-family: var(--glass-font, inherit);
  background: var(--glass-sheen, linear-gradient(transparent, transparent)), var(--glass-4, var(--gt-surface-solid));
  -webkit-backdrop-filter: blur(28px) saturate(170%);
  backdrop-filter: blur(28px) saturate(170%);
  box-shadow: var(--glass-elev-4, -24px 0 60px rgba(0, 0, 0, 0.5));
  border-left: 1px solid color-mix(in srgb, var(--gt-gold) 26%, transparent);
  animation: gaa-drawer-in 460ms var(--glass-spring, var(--gt-ease)) both;
}
@keyframes gaa-drawer-in { from { transform: translateX(40px); opacity: 0; } }
@keyframes gaa-fade { from { opacity: 0; } }
.gaa-modal-head {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 16px 18px 14px;
  border-bottom: 1px solid var(--gt-line);
}
.gaa-modal-title-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.gaa-modal-eyebrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gaa-modal-title { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; font-weight: 650; letter-spacing: -0.02em; color: var(--gt-fg); }
.gaa-modal-badge svg { width: 12px; height: 12px; }
.gaa-modal-dur { font: 500 10.5px var(--mono); color: var(--gt-faint); }
.gaa-modal-tools {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 2.5%, transparent);
}
.gaa-modal-tools .gt-btn { height: 30px; padding: 0 12px; border-radius: 999px; font-size: 11.5px; }
.gaa-modal-count { margin-left: auto; font: 500 10.5px var(--mono); color: var(--gt-faint); display: inline-flex; align-items: center; gap: 8px; }
.gaa-modal-sending { color: var(--gt-gold-ink); }
.gaa-modal-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 14px 0 10px; scroll-behavior: smooth; }
.gaa-modal-skel { padding: 18px; display: grid; gap: 12px; }
.gaa-modal-skel .gt-skel { height: 44px; border-radius: 14px; }
.gaa-modal-skel .gt-skel:nth-child(2n) { width: 70%; justify-self: end; }

.gaa-msg { display: flex; flex-direction: column; gap: 5px; padding: 6px 18px; animation: gaa-fade 200ms ease both; }
.gaa-msg[data-role="user"] { align-items: flex-end; }
.gaa-msg[data-role="assistant"] { align-items: flex-start; }
.gaa-bubble {
  position: relative;
  max-width: 86%;
  padding: 11px 34px 11px 14px;
  border-radius: 18px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--gt-fg);
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 4.5%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
}
.gaa-msg[data-role="user"] .gaa-bubble {
  border-bottom-right-radius: 6px;
  border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent);
  background: var(--glass-gold-tint, color-mix(in srgb, var(--gt-gold) 12%, transparent));
}
.gaa-msg[data-role="assistant"] .gaa-bubble { border-bottom-left-radius: 6px; }
.gaa-bubble[data-streaming] { border-color: color-mix(in srgb, var(--gt-gold) 40%, transparent); }
.gaa-caret { display: inline-block; width: 8px; height: 15px; vertical-align: -2px; border-radius: 2px; background: var(--gt-gold); animation: gaa-blink 1s steps(2) infinite; }
@keyframes gaa-blink { 50% { opacity: 0; } }
.gaa-copy {
  position: absolute;
  top: 6px; right: 6px;
  width: 22px; height: 22px;
  display: grid; place-items: center;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--gt-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity 160ms ease, background 160ms ease, color 160ms ease;
}
.gaa-copy svg { width: 12px; height: 12px; }
.gaa-bubble:hover .gaa-copy, .gaa-copy:focus-visible, .gaa-tool summary:hover .gaa-copy { opacity: 1; }
.gaa-copy:hover { color: var(--gt-fg); background: color-mix(in srgb, var(--gt-fg) 8%, transparent); }
.gaa-copy:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.gaa-meta { font: 500 10px var(--mono); color: var(--gt-faint); }

.gaa-tool-wrap { padding: 3px 18px; }
.gaa-tool { border-radius: 12px; border: 1px solid var(--gt-line); background: color-mix(in srgb, var(--gt-fg) 3%, transparent); overflow: hidden; }
.gaa-tool[data-kind="result"] { border-color: color-mix(in srgb, var(--ok) 22%, transparent); }
.gaa-tool summary {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 36px 8px 12px;
  list-style: none;
  cursor: pointer;
  user-select: none;
  font: 600 10.5px/1.3 var(--mono);
  letter-spacing: 0.06em;
  color: var(--gt-gold-ink);
}
.gaa-tool summary::-webkit-details-marker { display: none; }
.gaa-tool summary::before { content: "▸"; font-size: 10px; color: var(--gt-faint); transition: transform 200ms var(--gt-ease); }
.gaa-tool[open] summary::before { transform: rotate(90deg); }
.gaa-tool[data-kind="result"] summary { color: var(--ok); }
.gaa-tool summary .gaa-tool-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gaa-tool summary .gaa-copy { top: 50%; transform: translateY(-50%); }
.gaa-tool pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 300px;
  overflow-y: auto;
  border-top: 1px solid var(--gt-line);
  font: 11px/1.5 var(--mono);
  color: var(--gt-dim);
  white-space: pre-wrap;
  word-break: break-all;
  background: color-mix(in srgb, var(--bg, #050505) 35%, transparent);
}
.gaa-think {
  margin: 3px 18px;
  padding: 8px 12px;
  max-height: 180px;
  overflow-y: auto;
  border-left: 2px solid color-mix(in srgb, var(--gt-gold) 40%, transparent);
  border-radius: 0 10px 10px 0;
  background: color-mix(in srgb, var(--gt-gold) 5%, transparent);
  font-size: 12px;
  font-style: italic;
  line-height: 1.55;
  color: var(--gt-dim);
  white-space: pre-wrap;
  word-break: break-word;
}
.gaa-step-err {
  margin: 4px 18px;
  padding: 9px 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
  background: var(--danger-subtle);
  color: var(--danger);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.gaa-modal-error {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-top: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  background: var(--danger-subtle);
  color: var(--danger);
  font-size: 12px;
}
.gaa-modal-error > span:first-of-type { flex: 1; min-width: 0; }
.gaa-composer {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 18px calc(14px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 2.5%, transparent);
}
.gaa-composer textarea.gt-input {
  flex: 1;
  min-width: 0;
  height: auto;
  min-height: 46px;
  max-height: 180px;
  padding: 12px 14px;
  border-radius: 16px;
  resize: none;
  line-height: 1.45;
  font-size: 13px;
}
.gaa-composer .gt-btn { height: 46px; border-radius: 14px; padding: 0 18px; }
.gaa-composer .gt-btn svg { width: 14px; height: 14px; }
.gaa-empty-session { padding: 20px 0; }

@media (max-width: 640px) {
  .gaa-modal-head { padding: 14px 14px 12px; }
  .gaa-modal-tools { padding: 8px 14px; }
  .gaa-msg, .gaa-tool-wrap { padding-left: 12px; padding-right: 12px; }
  .gaa-think, .gaa-step-err { margin-left: 12px; margin-right: 12px; }
  .gaa-bubble { max-width: 92%; }
  .gaa-composer { padding-left: 12px; padding-right: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .gaa-modal, .gaa-modal-backdrop, .gaa-msg, .gaa-caret { animation: none !important; }
}
:root.perf-mode .gaa-modal { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--gt-surface-solid); }
:root.perf-mode .gaa-modal-backdrop { -webkit-backdrop-filter: none; backdrop-filter: none; }
@media (prefers-reduced-transparency: reduce) {
  .gaa-modal { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important; }
  .gaa-modal-backdrop { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
}
:root[data-theme="light"] .gaa-composer textarea.gt-input { background: rgba(255, 255, 255, 0.85); }
`;

/* ═══════════════════════════════════════════════════════════════════════════
 * Slide-out Activity panel + grid feed body
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Top-bar button badge — rendered on every page, so kept tiny and separate. */
export const ACTIVITY_CB_CSS = /* css */ `
.gaa-cb-btn { position: relative; cursor: pointer; }
.gaa-cb-btn[data-live] { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--glass-gold, var(--g-primary, #fbbf24)) 40%, transparent); }
.gaa-cb-badge {
  position: absolute;
  top: 1px; right: 1px;
  min-width: 15px; height: 15px;
  padding: 0 4px;
  display: grid; place-items: center;
  border-radius: 999px;
  font: 700 9px/1 var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--glass-ink, #120c00);
  background: linear-gradient(180deg, color-mix(in srgb, var(--glass-gold, #fbbf24) 80%, #fff 20%), var(--glass-gold, #fbbf24));
  box-shadow: 0 0 0 2px var(--glass-base, var(--bg, #050505)), 0 0 10px color-mix(in srgb, var(--glass-gold, #fbbf24) 55%, transparent);
}
.gaa-cb-badge[data-kind="live"] {
  color: #04140a;
  background: linear-gradient(180deg, color-mix(in srgb, var(--ok, #22c55e) 75%, #fff 25%), var(--ok, #22c55e));
  box-shadow: 0 0 0 2px var(--glass-base, var(--bg, #050505)), 0 0 10px color-mix(in srgb, var(--ok, #22c55e) 55%, transparent);
  animation: gaa-cb-breathe 2.4s ease-in-out infinite;
}
@keyframes gaa-cb-breathe { 50% { box-shadow: 0 0 0 2px var(--glass-base, var(--bg, #050505)), 0 0 16px color-mix(in srgb, var(--ok, #22c55e) 75%, transparent); } }
@media (prefers-reduced-motion: reduce) { .gaa-cb-badge { animation: none !important; } }
`;

export const ACTIVITY_PANEL_CSS = /* css */ `
.gaa-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 89;
  background: color-mix(in srgb, #000 45%, transparent);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
  animation: gaa-fade 240ms ease both;
}
:root[data-theme="light"] .gaa-drawer-backdrop { background: rgba(24, 24, 27, 0.2); }
@keyframes gaa-fade { from { opacity: 0; } }
.gaa-drawer.gt-scope {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  z-index: 90;
  width: min(420px, 100vw);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--gt-fg);
  font-family: var(--glass-font, inherit);
  background: var(--glass-sheen, linear-gradient(transparent, transparent)), var(--glass-4, var(--gt-surface-solid));
  -webkit-backdrop-filter: blur(28px) saturate(170%);
  backdrop-filter: blur(28px) saturate(170%);
  border-left: 1px solid color-mix(in srgb, var(--gt-gold) 26%, transparent);
  box-shadow: var(--glass-elev-4, -24px 0 60px rgba(0, 0, 0, 0.5));
  transform: translateX(100%);
  visibility: hidden;
  transition: transform 520ms var(--glass-spring, var(--gt-ease)), visibility 0s linear 520ms;
}
.gaa-drawer.gt-scope[data-open] { transform: none; visibility: visible; transition: transform 520ms var(--glass-spring, var(--gt-ease)), visibility 0s; }
.gaa-drawer .gt-aurora { height: 260px; inset: -60px 0 auto; }

.gaa-feed.gt-scope {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--gt-fg);
  font-family: var(--glass-font, inherit);
}

.gaa-dhead { flex: none; padding: 18px 18px 14px; display: flex; flex-direction: column; gap: 14px; border-bottom: 1px solid var(--gt-line); }
.gaa-dhead-top { display: flex; align-items: flex-start; gap: 10px; }
.gaa-dhead-copy { flex: 1; min-width: 0; }
.gaa-dtitle { margin: 8px 0 0; font-size: 22px; font-weight: 650; line-height: 1.1; letter-spacing: -0.025em; color: var(--gt-fg); }
.gaa-dstats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.gaa-dstat { padding: 9px 11px; border-radius: 12px; }
.gaa-dstat .gt-stat-value { font-size: 18px; display: inline-flex; align-items: center; gap: 8px; }
.gaa-dlist { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 10px 10px 14px; display: flex; flex-direction: column; gap: 6px; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--gt-gold) 25%, transparent) transparent; }
.gaa-dsection { margin: 10px 6px 4px; font: 600 10px/1 var(--mono); letter-spacing: 0.2em; text-transform: uppercase; color: var(--gt-gold-ink); display: flex; align-items: center; gap: 10px; }
.gaa-dsection::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 40%, transparent), transparent); }

/* Session rows */
.gaa-srow {
  position: relative;
  border-radius: 14px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 3%, transparent);
  transition: border-color 220ms ease, background 220ms ease, transform 420ms var(--glass-spring, var(--gt-ease)), box-shadow 360ms var(--gt-ease);
}
.gaa-srow[data-active] { border-color: color-mix(in srgb, var(--gt-gold) 28%, transparent); background: color-mix(in srgb, var(--gt-gold) 6%, transparent); }
.gaa-srow:hover { border-color: color-mix(in srgb, var(--gt-gold) 34%, transparent); background: color-mix(in srgb, var(--gt-fg) 5.5%, transparent); box-shadow: 0 14px 34px -20px color-mix(in srgb, var(--gt-gold) 45%, transparent); }
.gaa-srow-head {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 11px 12px;
  cursor: pointer;
  border-radius: inherit;
}
.gaa-srow-head:focus-visible { box-shadow: var(--gt-focus); }
.gaa-srow-head:active { transform: scale(0.995); }
.gaa-avatar {
  position: relative;
  flex: none;
  width: 32px; height: 32px;
  display: grid; place-items: center;
  border-radius: 10px;
  font: 650 12px/1 var(--glass-font, inherit);
  letter-spacing: -0.02em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 26%, transparent), color-mix(in srgb, var(--gt-gold) 6%, transparent) 72%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 30%, transparent);
}
.gaa-avatar svg { width: 15px; height: 15px; }
.gaa-avatar .gt-light { position: absolute; right: -2px; bottom: -2px; width: 8px; height: 8px; }
.gaa-smain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.gaa-sname-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.gaa-sname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; letter-spacing: -0.01em; color: var(--gt-fg); }
.gaa-skind { flex: none; height: 18px; padding: 0 7px; font-size: 9px; letter-spacing: 0.1em; }
.gaa-schan { flex: none; font: 500 9.5px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--gt-faint); }
.gaa-stask { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--gt-dim); }
.gaa-srow[data-sub] .gaa-stask { color: var(--gt-fg); }
.gaa-sprog { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
.gaa-sbar { flex: 1; height: 3px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--gt-fg) 8%, transparent); }
.gaa-sbar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 30%, transparent), var(--gt-gold), color-mix(in srgb, var(--gt-gold) 30%, transparent));
  background-size: 200% 100%;
  animation: gaa-flow 2.2s linear infinite;
  box-shadow: 0 0 10px color-mix(in srgb, var(--gt-gold) 55%, transparent);
  transition: width 600ms var(--gt-ease);
}
@keyframes gaa-flow { from { background-position: 200% 0; } to { background-position: 0 0; } }
.gaa-sphase { flex: none; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 9.5px/1 var(--mono); letter-spacing: 0.1em; color: var(--gt-gold-ink); }
.gaa-sdone { font: 500 10.5px var(--mono); color: var(--ok); }
.gaa-sside { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.gaa-sago { font: 500 10.5px var(--mono); color: var(--gt-gold-ink); }
.gaa-stok { font: 500 10px var(--mono); color: var(--gt-faint); }
.gaa-schev { color: var(--gt-faint); transition: transform 260ms var(--gt-ease); display: inline-flex; }
.gaa-schev svg { width: 12px; height: 12px; }
.gaa-srow[data-open] .gaa-schev { transform: rotate(180deg); }
.gaa-ssteps { padding: 0 12px 11px 55px; display: flex; flex-direction: column; gap: 5px; }
.gaa-sstep { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11.5px; }
.gaa-sstep-ico { flex: none; width: 14px; text-align: center; font-size: 11px; color: var(--gt-faint); }
.gaa-sstep[data-type="tool_call"] .gaa-sstep-ico, .gaa-sstep[data-type="user"] .gaa-sstep-ico, .gaa-sstep[data-type="spawn"] .gaa-sstep-ico { color: var(--gt-gold-ink); }
.gaa-sstep[data-type="tool_result"] .gaa-sstep-ico { color: var(--ok); }
.gaa-sstep[data-type="error"] .gaa-sstep-ico { color: var(--danger); }
.gaa-sstep-txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gt-dim); }
.gaa-sstep[data-type="user"] .gaa-sstep-txt { color: var(--gt-gold-ink); }
.gaa-sstep-time { flex: none; font: 500 9.5px var(--mono); color: var(--gt-faint); }
.gaa-smeta { display: flex; gap: 10px; margin-top: 4px; padding-top: 7px; border-top: 1px solid var(--gt-line); font: 500 10px var(--mono); color: var(--gt-faint); min-width: 0; }
.gaa-smeta-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--gt-gold-ink); }
.gaa-snone { font: 500 10.5px var(--mono); color: var(--gt-faint); }
.gaa-drawer .gt-empty, .gaa-feed .gt-empty { padding: 40px 20px; }
.gaa-rcf { margin-top: 8px; padding: 4px 6px 6px; border-radius: 16px; border: 1px solid var(--gt-line); background: color-mix(in srgb, var(--gt-fg) 2.5%, transparent); }

/* Footer */
.gaa-dfoot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px calc(12px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 2.5%, transparent);
}
.gaa-dfoot-poll { display: inline-flex; align-items: center; gap: 7px; font: 500 10.5px var(--mono); letter-spacing: 0.08em; color: var(--gt-faint); margin-right: auto; min-width: 0; white-space: nowrap; }
.gaa-dfoot .gt-btn { height: 32px; padding: 0 13px; border-radius: 999px; font-size: 12px; }
.gaa-dfoot .gt-btn svg { width: 13px; height: 13px; }
.gaa-dfoot-live { min-width: 18px; height: 18px; padding: 0 5px; display: inline-grid; place-items: center; border-radius: 999px; font: 700 10px/1 var(--mono); color: #04140a; background: var(--ok); }

${rcfGlass(".gaa-drawer")}
.gaa-drawer .rcf-list--comfortable { max-height: none; }

@media (max-width: 480px) {
  .gaa-dhead { padding: 14px 14px 12px; }
  .gaa-dtitle { font-size: 20px; }
  .gaa-ssteps { padding-left: 12px; }
  .gaa-dfoot .gaa-dfoot-poll span { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .gaa-drawer, .gaa-drawer[data-open] { transition: visibility 0s !important; }
  .gaa-drawer-backdrop, .gaa-sbar > i { animation: none !important; }
  .gaa-srow, .gaa-schev { transition: none !important; }
}
:root.perf-mode .gaa-drawer { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--gt-surface-solid); }
:root.perf-mode .gaa-drawer-backdrop { -webkit-backdrop-filter: none; backdrop-filter: none; }
:root.perf-mode .gaa-sbar > i { animation: none; }
@media (prefers-reduced-transparency: reduce) {
  .gaa-drawer { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important; }
  .gaa-drawer-backdrop { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
}
`;
