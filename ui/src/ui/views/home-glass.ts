/** Shared premium treatment for the main entry surfaces.
 *
 * These views are light-DOM templates with historically independent styles.
 * One late, token-only sheet lets them share the Business Hub's glass language
 * without stacking extra backdrop filters or changing any of their behavior.
 */

const STYLE_ID = "infinibot-home-glass-g6";
let visibilityWired = false;

export function ensureHomeGlassStyles(): void {
  if (typeof document === "undefined") return;
  if (!visibilityWired) {
    visibilityWired = true;
    const syncVisibility = () => {
      document.documentElement.dataset.pageVisibility = document.hidden ? "hidden" : "visible";
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility, { passive: true });
  }
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = HOME_GLASS_CSS;
  document.head.appendChild(style);
}

const HOME_GLASS_CSS = `
/* ── Shared entry-page stage ─────────────────────────────── */
.dash-page,
.core-home,
.lv2,
.learn-page,
.term-page,
.bz-page,
.frc-root {
  color: var(--glass-fg);
  font-family: var(--glass-font, var(--font-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif));
  isolation: isolate;
}

.dash-page::before,
.core-home::before,
.lv2::before,
.learn-page::before,
.term-page::before,
.bz-page::before,
.frc-root::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  opacity: .34;
  background-image:
    linear-gradient(var(--glass-gold-a06) 1px, transparent 1px),
    linear-gradient(90deg, var(--glass-gold-a06) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: linear-gradient(to bottom, transparent, black 18%, black 72%, transparent);
}

/* ── Page chrome and glass planes ────────────────────────── */
.core-home__head,
.lv2-hero,
.learn-header,
.grid-toolbar,
.bz-header,
.frc-head {
  position: relative;
  border: 1px solid var(--glass-stroke);
  border-radius: var(--glass-radius-xl);
  background: var(--glass-sheen), var(--glass-2);
  box-shadow: var(--glass-elev-2), var(--glass-specular), var(--glass-inner-shade);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}

.core-home__head,
.lv2-hero,
.learn-header,
.frc-head { padding: clamp(22px, 3vw, 34px); overflow: hidden; }

.core-home__head::after,
.lv2-hero::after,
.learn-header::after,
.frc-head::after,
.dash-needs-now::after {
  content: "";
  position: absolute;
  width: 240px;
  height: 240px;
  right: -84px;
  top: -128px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--glass-gold-a16), transparent 68%);
  pointer-events: none;
}

.core-home__eyebrow,
.frc-eyebrow,
.lv2-kicker,
.learn-kicker,
.bz-eyebrow,
.term-title {
  color: var(--glass-gold-hi) !important;
  font-family: var(--glass-font-mono, ui-monospace, monospace);
  letter-spacing: var(--glass-tracking-caps) !important;
  text-transform: uppercase;
}

.core-home__title,
.frc-title,
.lv2 h1,
.learn-header h2,
.bz-title {
  color: var(--glass-fg) !important;
  font-family: var(--font-ui-display, var(--glass-font));
  font-weight: 720 !important;
  letter-spacing: -.035em !important;
  text-wrap: balance;
}

.core-home__sub,
.frc-sub,
.learn-sub,
.bz-meta,
.lv2-sub { color: var(--glass-fg-3) !important; }

/* ── Core home ───────────────────────────────────────────── */
.core-home {
  width: 100%;
  min-width: 0;
  max-width: 1240px !important;
  padding: 28px clamp(14px, 3vw, 34px) 64px !important;
  overflow-x: clip;
}
.core-home__command { width: 100%; min-width: 0; max-width: 100%; }
.core-home__grid { gap: 14px !important; grid-template-columns: repeat(auto-fit, minmax(238px, 1fr)) !important; }
.core-home__tile {
  position: relative;
  min-height: 118px;
  padding: 20px !important;
  border-color: var(--glass-stroke) !important;
  border-radius: var(--glass-radius-lg) !important;
  background: var(--glass-sheen), var(--glass-3) !important;
  box-shadow: var(--glass-elev-1), var(--glass-specular) !important;
  transition: transform var(--glass-dur) var(--glass-spring), border-color var(--glass-dur-fast), background var(--glass-dur-fast) !important;
}
.core-home__tile::after {
  content: "OPEN  ↗";
  position: absolute;
  right: 16px;
  top: 16px;
  color: var(--glass-fg-4);
  font: 600 9px/1 var(--glass-font-mono, monospace);
  letter-spacing: .12em;
}
.core-home__tile:hover,
.core-home__tile:focus-visible {
  transform: var(--glass-lift) !important;
  border-color: var(--glass-stroke-gold) !important;
  background: var(--glass-sheen), var(--glass-hover) !important;
  box-shadow: var(--glass-elev-3), var(--glass-glow-soft) !important;
  outline: none;
}
.core-home__ic { color: var(--glass-gold-hi) !important; background: var(--glass-gold-a10) !important; border: 1px solid var(--glass-gold-a16); }
.core-home__name { color: var(--glass-fg); letter-spacing: -.015em; }
.core-home__blurb { color: var(--glass-fg-3) !important; }
.core-home__link { background: var(--glass-2); border-color: var(--glass-stroke) !important; }

/* ── Launchpad / command palette ─────────────────────────── */
.lp-overlay { background: color-mix(in srgb, var(--glass-base) 76%, transparent) !important; backdrop-filter: blur(10px) saturate(110%) !important; }
.lp-panel {
  border-color: var(--glass-stroke-gold) !important;
  border-radius: var(--glass-radius-xl) !important;
  background: var(--glass-sheen), var(--glass-4) !important;
  box-shadow: var(--glass-elev-4), var(--glass-glow-soft), var(--glass-specular) !important;
}
.lp-panel::before,
.term-dialog::before {
  content: "";
  position: absolute;
  inset: 10px;
  pointer-events: none;
  background:
    linear-gradient(var(--glass-gold), var(--glass-gold)) left top / 18px 1px no-repeat,
    linear-gradient(var(--glass-gold), var(--glass-gold)) left top / 1px 18px no-repeat,
    linear-gradient(var(--glass-gold), var(--glass-gold)) right top / 18px 1px no-repeat,
    linear-gradient(var(--glass-gold), var(--glass-gold)) right top / 1px 18px no-repeat;
  opacity: .46;
}
.lp-searchbar { background: var(--glass-1) !important; border-color: var(--glass-stroke) !important; }
.lp-searchbar:focus-within { border-color: var(--glass-stroke-gold) !important; box-shadow: var(--glass-focus-ring) !important; }
.lp-searchbar__input { color: var(--glass-fg) !important; }
.lp-card { border-color: var(--glass-stroke) !important; background: var(--glass-3) !important; }
.lp-card:hover, .lp-card.is-selected { border-color: var(--glass-stroke-gold) !important; background: var(--glass-hover) !important; transform: translateY(-1px); }

/* ── Learn / onboarding ──────────────────────────────────── */
.lv2, .learn-page { max-width: 1360px; margin-inline: auto; }
.lv2-tabs, .learn-tabs {
  border: 1px solid var(--glass-stroke) !important;
  background: var(--glass-2) !important;
  box-shadow: var(--glass-elev-1), var(--glass-specular);
  border-radius: var(--glass-radius-pill) !important;
}
.lv2-tab, .learn-tab { border-radius: var(--glass-radius-pill) !important; }
.lv2-tab.on, .learn-tab.active { color: var(--glass-ink) !important; background: var(--glass-gold-fill) !important; box-shadow: var(--glass-glow-soft); }
.lv2-card, .lv2-track, .lv2-overview, .lv2-section, .lv2-missions,
.learn-card, .learn-track-card, .learn-cert-card,
.frc-item, .bz-card {
  border-color: var(--glass-stroke) !important;
  background: var(--glass-sheen), var(--glass-3) !important;
  box-shadow: var(--glass-elev-1), var(--glass-specular) !important;
}
.lv2-card:hover, .lv2-track:hover, .learn-card:hover, .learn-track-card:hover {
  border-color: var(--glass-stroke-gold) !important;
  transform: var(--glass-lift);
  box-shadow: var(--glass-elev-3), var(--glass-glow-soft) !important;
}
.lv2-btn.primary, .learn-btn-primary, .frc-cta.is-primary { background: var(--glass-gold-fill) !important; color: var(--glass-ink) !important; border-color: transparent !important; }
.lv2-search, .lv2-search input, .learn-input, .bz-input { background: var(--glass-1) !important; color: var(--glass-fg) !important; border-color: var(--glass-stroke) !important; }
.lv2-search:focus-within, .learn-input:focus, .bz-input:focus { box-shadow: var(--glass-focus-ring) !important; outline: none !important; border-color: var(--glass-stroke-gold) !important; }
.frc-bar { background: var(--glass-1) !important; border: 1px solid var(--glass-stroke); height: 8px !important; }
.frc-bar__fill { background: var(--glass-gold-fill) !important; box-shadow: var(--glass-glow); }
.frc-item { transition: transform var(--glass-dur) var(--glass-spring), border-color var(--glass-dur-fast), opacity var(--glass-dur-fast); }
.frc-item:hover { transform: translateX(3px); border-color: var(--glass-stroke-gold) !important; }

/* ── Terminals ───────────────────────────────────────────── */
.term-page { background: transparent !important; }
.term-page .grid-container { background: transparent !important; }
.term-page .grid-toolbar {
  margin: 10px 12px 0;
  padding: 10px 12px !important;
  border-color: var(--glass-stroke) !important;
  border-radius: var(--glass-radius-lg) !important;
}
.term-card, .terminal-card, .term-session, .term-side-panel, .term-activity-bar {
  border-color: var(--glass-stroke) !important;
  background: var(--glass-sheen), var(--glass-2) !important;
  box-shadow: var(--glass-elev-1), var(--glass-specular) !important;
}
.term-btn, .term-btn-icon, .term-quicklaunch-btn, .term-browse-btn {
  border-color: var(--glass-stroke) !important;
  background: var(--glass-3) !important;
  color: var(--glass-fg-2) !important;
}
.term-btn:hover, .term-btn-icon:hover, .term-quicklaunch-btn:hover, .term-browse-btn:hover { border-color: var(--glass-stroke-gold) !important; background: var(--glass-hover) !important; color: var(--glass-gold-hi) !important; }
.term-dialog-overlay { background: color-mix(in srgb, var(--glass-base) 78%, transparent) !important; backdrop-filter: blur(9px); }
.term-dialog { position: relative; background: var(--glass-sheen), var(--glass-4) !important; border-color: var(--glass-stroke-gold) !important; box-shadow: var(--glass-elev-4), var(--glass-glow-soft) !important; }

/* ── Browser setup ───────────────────────────────────────── */
.bz-page { max-width: 1420px; margin: 0 auto; padding: 24px clamp(14px, 3vw, 34px) 56px !important; gap: 18px !important; }
.bz-header, .bz-card { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
.bz-header { background: var(--glass-sheen), var(--glass-2) !important; border-color: var(--glass-stroke-gold) !important; }
.bz-card { border-radius: var(--glass-radius-lg) !important; }
.bz-check, .bz-profile-row, .bz-snap-row { background: var(--glass-1) !important; border-color: var(--glass-stroke) !important; }
.bz-btn { border-color: var(--glass-stroke) !important; background: var(--glass-3) !important; color: var(--glass-fg-2) !important; }
.bz-btn:hover { border-color: var(--glass-stroke-gold) !important; background: var(--glass-hover) !important; color: var(--glass-gold-hi) !important; }
.bz-btn--primary { background: var(--glass-gold-fill) !important; color: var(--glass-ink) !important; }
.bz-card-title, .bz-check-title, .bz-profile-name { color: var(--glass-fg) !important; }
.bz-card-sub, .bz-check-detail, .bz-profile-path, .bz-snap-meta { color: var(--glass-fg-3) !important; }
.bz-cmd { background: var(--glass-1) !important; color: var(--glass-fg-2) !important; border: 1px solid var(--glass-stroke); }

/* ── Header subtabs + sidebar utilities ──────────────────── */
.host-subtabs, .topbar-tabctx__lens {
  background: var(--glass-2) !important;
  border: 1px solid var(--glass-stroke) !important;
  border-radius: var(--glass-radius-pill) !important;
  box-shadow: var(--glass-elev-1), var(--glass-specular);
}
.host-subtabs__tab, .topbar-tabctx__lens-chip { color: var(--glass-fg-3) !important; border-radius: var(--glass-radius-pill) !important; }
.host-subtabs__tab:hover, .topbar-tabctx__lens-chip:hover { color: var(--glass-fg) !important; background: var(--glass-hover) !important; }
.host-subtabs__tab.is-active { color: var(--glass-ink) !important; background: var(--glass-gold-fill) !important; box-shadow: var(--glass-glow-soft); }
.nav-strip { border-color: var(--glass-stroke) !important; background: var(--glass-sheen), var(--glass-2) !important; box-shadow: var(--glass-elev-1), var(--glass-specular); }
.nav-strip__cycle, .sbw-btn, .sidebar-upd { background: var(--glass-3) !important; border-color: var(--glass-stroke) !important; color: var(--glass-fg-3) !important; }
.nav-strip__cycle:hover, .sbw-btn:hover, .sidebar-upd:hover:not(:disabled) { background: var(--glass-hover) !important; border-color: var(--glass-stroke-gold) !important; color: var(--glass-gold-hi) !important; }

/* ── Keyboard and focus contract ─────────────────────────── */
.core-home a:focus-visible, .core-home button:focus-visible,
.lp-panel button:focus-visible, .lp-panel input:focus-visible,
.lv2 button:focus-visible, .lv2 a:focus-visible, .lv2 input:focus-visible,
.learn-page button:focus-visible, .learn-page a:focus-visible, .learn-page input:focus-visible,
.term-page button:focus-visible, .term-page input:focus-visible, .term-page select:focus-visible,
.bz-page button:focus-visible, .bz-page input:focus-visible,
.frc-root button:focus-visible,
.host-subtabs a:focus-visible, .topbar-tabctx__lens a:focus-visible,
.nav-strip button:focus-visible {
  outline: none !important;
  box-shadow: var(--glass-focus-ring) !important;
}

/* ── Light / accessible / low-power modes ────────────────── */
:root[data-theme="light"] .dash-page::before,
:root[data-theme="light"] .core-home::before,
:root[data-theme="light"] .lv2::before,
:root[data-theme="light"] .learn-page::before,
:root[data-theme="light"] .term-page::before,
:root[data-theme="light"] .bz-page::before,
:root[data-theme="light"] .frc-root::before { opacity: .2; }

@media (prefers-reduced-transparency: reduce) {
  .core-home__head, .lv2-hero, .learn-header, .grid-toolbar, .bz-header, .frc-head,
  .lp-panel, .host-subtabs, .topbar-tabctx__lens, .nav-strip {
    background: var(--glass-solid) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .core-home__tile, .lv2-card, .lv2-track, .learn-card, .learn-track-card, .frc-item,
  .lp-card, .term-btn, .term-btn-icon, .term-quicklaunch-btn { transition: none !important; transform: none !important; }
}

:root.perf-mode .dash-page::before,
:root.perf-mode .core-home::before,
:root.perf-mode .lv2::before,
:root.perf-mode .learn-page::before,
:root.perf-mode .term-page::before,
:root.perf-mode .bz-page::before,
:root.perf-mode .frc-root::before,
:root[data-page-visibility="hidden"] .dash-page::before { animation-play-state: paused !important; opacity: 0; }

@media (max-width: 640px) {
  .dash-page, .core-home, .lv2, .learn-page, .bz-page, .frc-root { padding-inline: 12px !important; }
  .core-home__head, .lv2-hero, .learn-header, .frc-head { padding: 20px !important; border-radius: var(--glass-radius-lg) !important; }
  .core-home__grid { grid-template-columns: 1fr !important; }
  .core-home__tile { min-height: 96px; }
  .lp-panel { width: calc(100vw - 20px) !important; max-height: calc(100dvh - 20px) !important; border-radius: var(--glass-radius-lg) !important; }
  .term-page .grid-toolbar { margin-inline: 6px; }
  .bz-grid-2 { grid-template-columns: 1fr !important; }
  .bz-check, .bz-profile-row, .bz-snap-row { align-items: flex-start !important; flex-wrap: wrap; }
  .host-subtabs { max-width: calc(100vw - 24px); overflow-x: auto; scrollbar-width: none; }
}
`;
