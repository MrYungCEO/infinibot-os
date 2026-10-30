/**
 * G8 onboarding + workspace glass layer.
 *
 * This is deliberately additive: the existing views retain their own layout,
 * state, events and validation while the shared shell supplies the materials,
 * focus treatment, motion and responsive polish. Every selector is rooted in
 * `.g8-page` so the broad compatibility selectors cannot leak to other views.
 */
import { html } from "lit";

export const g8GlassStyles = html`<style>
  :where(.g8-page) {
    --g8-gold: var(--glass-gold, var(--g-primary, #f5bd43));
    --g8-gold-hi: var(--glass-gold-hi, #ffe29a);
    --g8-ink: var(--glass-ink, #171006);
    --g8-fg: var(--glass-fg, var(--g-fg, var(--text, #f7f3e9)));
    --g8-fg-2: var(--glass-fg-2, var(--g-fg-dim, var(--muted, rgba(247,243,233,.72))));
    --g8-fg-3: var(--glass-fg-3, var(--g-fg-faint, rgba(247,243,233,.5)));
    --g8-panel: var(--glass-2, color-mix(in srgb, var(--g-surface, #12100d) 84%, transparent));
    --g8-card: var(--glass-3, color-mix(in srgb, var(--g-surface, #17130d) 90%, transparent));
    --g8-float: var(--glass-4, color-mix(in srgb, var(--g-surface, #1b160e) 96%, transparent));
    --g8-line: var(--glass-stroke, color-mix(in srgb, var(--g8-fg) 13%, transparent));
    --g8-line-gold: var(--glass-stroke-gold, color-mix(in srgb, var(--g8-gold) 42%, transparent));
    --g8-sheen: var(--glass-sheen, linear-gradient(180deg, rgba(255,255,255,.09), transparent 36%));
    --g8-shadow: var(--glass-elev-2, 0 22px 70px rgba(0,0,0,.3));
    position: relative;
    isolation: isolate;
    min-width: 0;
    color: var(--g8-fg);
    font-family: var(--glass-font, var(--g-font-family, Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif));
  }

  :where(.g8-page)::before {
    content: "";
    position: absolute;
    z-index: -2;
    inset: -18% -12% auto 18%;
    height: min(440px, 62vh);
    pointer-events: none;
    background:
      radial-gradient(ellipse at 42% 0%, color-mix(in srgb, var(--g8-gold) 19%, transparent), transparent 58%),
      radial-gradient(ellipse at 88% 14%, color-mix(in srgb, var(--g8-gold-hi) 8%, transparent), transparent 48%);
    filter: blur(20px);
    opacity: .84;
    animation: g8-aurora 16s ease-in-out infinite alternate;
  }

  :where(.g8-page)::after {
    content: "";
    position: absolute;
    z-index: -1;
    inset: 0;
    pointer-events: none;
    opacity: .2;
    background-image:
      linear-gradient(color-mix(in srgb, var(--g8-gold) 5%, transparent) 1px, transparent 1px),
      linear-gradient(90deg, color-mix(in srgb, var(--g8-gold) 5%, transparent) 1px, transparent 1px);
    background-size: 44px 44px;
    mask-image: linear-gradient(to bottom, black, transparent 74%);
  }

  :where(.g8-page) :is(h1, .sw-title, .sob-hero__title, .vo-hero h1) {
    color: var(--g8-fg);
    letter-spacing: -.035em;
    text-wrap: balance;
  }

  :where(.g8-page) :is(h2, h3, .niw-title, .nsp-title, .ncp-title) {
    letter-spacing: -.018em;
    color: var(--g8-fg);
  }

  :where(.g8-page) :is(p, .sub, .tagline, [class*="__sub"], [class*="-muted"]) {
    color: var(--g8-fg-2);
    line-height: 1.58;
  }

  :where(.g8-page) :is(
    .onboarding-content, .quickstart-hero, .install-section, .tunnel-section,
    .setup-header, .setup-nav, .setup-content, .sw-card, .sob-console,
    .niw, .nsp, .ncp, .ndb-sidebar, .ndb-main-area,
    .vo-step, .vault-deck-hero, .vault-courses-deck,
    .sb-header, .sb-sidebar, .sb-main, .room-header, .customizer-body,
    .element-library, .properties-panel, .room-settings, .canvas-toolbar
  ) {
    border: 1px solid var(--g8-line);
    background: var(--g8-sheen), var(--g8-panel);
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.08)), var(--g8-shadow);
    -webkit-backdrop-filter: var(--glass-blur, blur(18px) saturate(135%));
    backdrop-filter: var(--glass-blur, blur(18px) saturate(135%));
  }

  :where(.g8-page) :is(
    .belief-card, .name-option, .plan-card, .channel-btn,
    .platform-tab, .step-card, .setup-nav-item, .sw-provider, .sw-channel,
    .sob-prov, .sob-card, .niw-card, .niw-role-card, .nsp-role,
    .ncp-conflict, .ndb-card, .ndb-stat-card, .vo-tag, .vo-pill,
    .vo-summary-card, .vo-week-card, .sb-card, .room-card
  ) {
    border-color: var(--g8-line);
    background: var(--g8-card);
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.06));
    transition: transform var(--glass-dur, 220ms) var(--glass-spring, cubic-bezier(.2,.8,.2,1)),
      border-color var(--glass-dur-fast, 140ms) ease,
      background var(--glass-dur-fast, 140ms) ease,
      box-shadow var(--glass-dur, 220ms) ease;
  }

  :where(.g8-page) :is(
    .belief-card, .name-option, .plan-card, .channel-btn,
    .platform-tab, .step-card, .setup-nav-item, .sw-provider, .sw-channel,
    .sob-prov, .niw-role-card, .nsp-role, .ndb-card, .vo-tag, .vo-pill,
    .vo-week-card, .sb-card, .room-card
  ):hover {
    border-color: var(--g8-line-gold);
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.08)), var(--glass-glow-soft, 0 12px 32px rgba(198,143,25,.11));
    transform: translateY(-2px);
  }

  :where(.g8-page) :is(
    button, input, textarea, select, [role="button"], [tabindex="0"]
  ):focus-visible {
    outline: none;
    box-shadow: var(--glass-focus-ring, 0 0 0 3px color-mix(in srgb, var(--g8-gold) 36%, transparent));
  }

  :where(.g8-page) :is(input, textarea, select) {
    color: var(--g8-fg);
    border-color: var(--g8-line);
    background: color-mix(in srgb, var(--glass-base, #090806) 72%, transparent);
    border-radius: var(--glass-radius-sm, 10px);
    min-height: 42px;
    transition: border-color var(--glass-dur-fast, 140ms) ease, box-shadow var(--glass-dur-fast, 140ms) ease;
  }

  :where(.g8-page) :is(input, textarea, select):hover {
    border-color: color-mix(in srgb, var(--g8-gold) 28%, var(--g8-line));
  }

  :where(.g8-page) :is(button, .btn, [role="button"]) {
    min-height: 40px;
    border-radius: var(--glass-radius-sm, 10px);
    transition: transform var(--glass-dur-fast, 140ms) ease,
      border-color var(--glass-dur-fast, 140ms) ease,
      background var(--glass-dur-fast, 140ms) ease,
      box-shadow var(--glass-dur-fast, 140ms) ease;
  }

  :where(.g8-page) :is(button, .btn, [role="button"]):not(:disabled):active {
    transform: translateY(1px) scale(.985);
  }

  :where(.g8-page) :is(
    .primary, .btn-primary, [class*="-primary"], [class*="--primary"]
  ):not(.primary-action-card) {
    color: var(--g8-ink);
    border-color: color-mix(in srgb, var(--g8-gold-hi) 64%, var(--g8-gold));
    background: var(--glass-gold-fill, linear-gradient(135deg, var(--g8-gold-hi), var(--g8-gold) 48%, var(--glass-gold-deep, #a66f0c)));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.42), 0 10px 28px color-mix(in srgb, var(--g8-gold) 21%, transparent);
  }

  :where(.g8-page) :is(
    .onboarding-progress, .sw-progress, .sob-rail, .vo-progress
  ) {
    border: 1px solid var(--g8-line);
    background: var(--g8-sheen), var(--g8-panel);
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.07));
    -webkit-backdrop-filter: var(--glass-blur-sm, blur(12px));
    backdrop-filter: var(--glass-blur-sm, blur(12px));
  }

  :where(.g8-page) :is(
    .loading-spinner, [class*="-loading"], [class*="-skeleton"], .empty-state, [class*="-empty"]
  ) {
    border-color: var(--g8-line);
    color: var(--g8-fg-2);
    background: var(--g8-card);
  }

  :where(.g8-page) :is([class*="-skeleton"], .skeleton) {
    background-image: linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--g8-gold) 11%, transparent) 42%, transparent 64%);
    background-size: 220% 100%;
    animation: g8-shimmer 1.8s ease-in-out infinite;
  }

  :where(.g8-page) :is(.error, [class*="-error"]) {
    border-color: color-mix(in srgb, var(--g-state-danger, #ef4444) 35%, var(--g8-line));
    background: color-mix(in srgb, var(--g-state-danger, #ef4444) 8%, var(--g8-card));
  }

  :where(.g8-page) :is(.success, [class*="-success"]) {
    border-color: color-mix(in srgb, var(--g-state-success, #22c55e) 35%, var(--g8-line));
    background: color-mix(in srgb, var(--g-state-success, #22c55e) 7%, var(--g8-card));
  }

  /* The main onboarding experiences get a little more breathing room. */
  :where(.onboarding-container.g8-page, .quickstart-container.g8-page, .sw-root.g8-page) {
    max-width: 1180px;
    margin-inline: auto;
    padding: clamp(18px, 3.2vw, 48px);
  }

  :where(.sw-root.g8-page) .sw-card {
    border-radius: var(--glass-radius-xl, 26px);
    overflow: clip;
  }

  :where(.onboarding-container.g8-page) .onboarding-content > *,
  :where(.sw-root.g8-page) .sw-card > *,
  :where(.sob-screen.g8-page) .sob-panel > * {
    animation: g8-enter var(--glass-dur-slow, 420ms) var(--glass-spring, cubic-bezier(.2,.8,.2,1)) both;
  }

  :where(.sw-root.g8-page) .sw-progress__step.is-active .sw-progress__num,
  :where(.sw-root.g8-page) .sw-progress__step.is-done .sw-progress__num {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--g8-gold) 9%, transparent), 0 0 22px color-mix(in srgb, var(--g8-gold) 23%, transparent);
  }

  :where(.sob-screen.g8-page) .sob-console,
  :where(.niw.g8-page),
  :where(.nsp.g8-page),
  :where(.ncp.g8-page) {
    border-radius: var(--glass-radius-xl, 26px);
  }

  :where(.niw.g8-page, .nsp.g8-page, .ncp.g8-page) {
    border: 1px solid var(--g8-line-gold);
    background: var(--g8-sheen), var(--g8-panel);
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.08)), var(--g8-shadow);
    -webkit-backdrop-filter: var(--glass-blur, blur(18px) saturate(135%));
    backdrop-filter: var(--glass-blur, blur(18px) saturate(135%));
  }

  :where(.g8-overlay-host) .cnd-modal {
    border-color: var(--g8-line-gold);
    border-radius: var(--glass-radius-xl, 26px);
    background: var(--g8-sheen), var(--g8-float);
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.1)), var(--glass-elev-4, 0 30px 90px rgba(0,0,0,.56));
    -webkit-backdrop-filter: var(--glass-blur-lg, blur(26px) saturate(140%));
    backdrop-filter: var(--glass-blur-lg, blur(26px) saturate(140%));
  }

  :where(.g8-overlay-host) .cnd-card {
    border-color: var(--g8-line);
    background: var(--g8-card);
    border-radius: var(--glass-radius, 14px);
  }

  :where(.ndb-page.g8-page) .ndb-layout {
    gap: 14px;
  }

  :where(.ndb-page.g8-page) :is(.ndb-sidebar, .ndb-main-area) {
    border-radius: var(--glass-radius-lg, 20px);
    overflow: clip;
  }

  /* The Notion manager predates themes and still has fixed near-black fills.
     Keep its information-dense layout, but remap every surface tier here so
     the same markup reads correctly on porcelain as well as black. */
  :where(.ndb-page.g8-page) {
    color: var(--g8-fg) !important;
    background: transparent !important;
  }

  :where(.ndb-page.g8-page) :is(
    .ndb-sidebar, .ndb-topbar, .ndb-main-area, .ndb-detail,
    .ndb-dialog, .ndb-kanban-col
  ) {
    color: var(--g8-fg) !important;
    border-color: var(--g8-line) !important;
    background: var(--g8-sheen), var(--g8-panel) !important;
  }

  :where(.ndb-page.g8-page) :is(
    .ndb-card, .ndb-kanban-card, .ndb-discover-card, .ndb-detail-notes,
    .ndb-block-code, .ndb-block-bookmark, .ndb-form-input,
    .ndb-form-textarea, .ndb-search, .ndb-select
  ) {
    color: var(--g8-fg) !important;
    border-color: var(--g8-line) !important;
    background: var(--g8-card) !important;
  }

  :where(.ndb-page.g8-page) :is(
    .ndb-sidebar-action, .ndb-view-btn, .ndb-table th,
    .ndb-card-desc, .ndb-detail-notes
  ) { color: var(--g8-fg-2) !important; }

  /* Vault's inline style maps already route most materials through these
     variables. Repointing them once preserves every tab while making the
     entire HUD genuinely theme-aware. */
  :where(.vault-hud.g8-page) {
    --vault-bg: var(--glass-base, #070603);
    --vault-panel: var(--glass-2, rgba(15, 13, 9, .88));
    --vault-panel-border: var(--glass-stroke, rgba(255,255,255,.1));
    --vault-panel-glow: var(--glass-glow-soft, rgba(198,143,25,.12));
    --vault-accent: var(--g8-gold);
    --vault-accent-bright: var(--g8-gold-hi);
    --vault-accent-dim: var(--glass-gold-a40, color-mix(in srgb, var(--g8-gold) 40%, transparent));
    --vault-text: var(--g8-fg);
    --vault-text-dim: var(--g8-fg-3);
    color: var(--g8-fg) !important;
    background: var(--glass-base, #070603) !important;
  }

  :where(.vault-hud.g8-page) :is(
    [style*="background:#111"], [style*="background:#0a0a0a"],
    [style*="background:#050505"]
  ) {
    color: var(--g8-fg) !important;
    border-color: var(--g8-line) !important;
    background: var(--g8-card) !important;
  }

  :where(.vault-hud.g8-page) :is(
    [style*="color:#e5e5e5"], [style*="color: #e5e5e5"]
  ) { color: var(--g8-fg) !important; }

  :where(.room-customizer.g8-page) {
    width: 100%;
    min-width: 0;
    overflow-x: hidden;
    color: var(--g8-fg) !important;
    background: var(--glass-base, #070603) !important;
  }
  :where(.room-customizer.g8-page) :is(.customizer-header, .no-room-state) {
    color: var(--g8-fg) !important;
    border-color: var(--g8-line) !important;
    background: var(--g8-sheen), var(--g8-panel) !important;
  }
  :where(.room-customizer.g8-page) :is(.no-room-state, .room-cards) {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }
  :where(.room-customizer.g8-page) :is(.no-room-text, .no-room-hint) {
    max-width: 100%;
    color: var(--g8-fg-2) !important;
    overflow-wrap: anywhere;
    text-align: center;
  }

  :where(.canvas-overlay.g8-page, .sol-chart.g8-page) {
    background: var(--g8-sheen), var(--g8-float) !important;
    border-color: var(--g8-line-gold) !important;
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.1)), var(--glass-elev-4, 0 30px 90px rgba(0,0,0,.58)) !important;
  }

  :where(.canvas-overlay.g8-page, .sol-chart.g8-page)::before,
  :where(.canvas-overlay.g8-page, .sol-chart.g8-page)::after { display: none; }

  :where(.room-customizer.g8-page) :is(.element-library, .properties-panel, .room-settings) {
    border-color: var(--g8-line-gold);
    background: var(--g8-sheen), var(--g8-panel) !important;
  }

  :where(.room-customizer.g8-page) :is(.library-item, .element-card, .room-card, .property-group) {
    border-color: var(--g8-line) !important;
    background: var(--g8-card) !important;
    border-radius: var(--glass-radius-sm, 10px) !important;
  }

  @keyframes g8-aurora {
    from { transform: translate3d(-2%, -2%, 0) scale(.98); opacity: .64; }
    to { transform: translate3d(3%, 2%, 0) scale(1.04); opacity: .92; }
  }

  @keyframes g8-shimmer {
    from { background-position: 140% 0; }
    to { background-position: -80% 0; }
  }

  @keyframes g8-enter {
    from { opacity: 0; transform: translateY(10px) scale(.995); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  :host-context([data-theme="light"]) :where(.g8-page),
  [data-theme="light"] :where(.g8-page) {
    --g8-panel: var(--glass-2, rgba(255,252,244,.78));
    --g8-card: var(--glass-3, rgba(255,255,255,.7));
    --g8-float: var(--glass-4, rgba(255,255,255,.94));
    --g8-shadow: var(--glass-elev-2, 0 22px 64px rgba(90,66,22,.13));
  }

  :host-context([data-theme="light"]) :where(.vault-hud.g8-page),
  [data-theme="light"] :where(.vault-hud.g8-page) {
    --vault-bg: var(--glass-base, #f7f2e8);
    --vault-panel: var(--glass-2, rgba(255,252,244,.82));
    --vault-panel-border: var(--glass-stroke, rgba(90,66,22,.16));
    --vault-text: var(--glass-fg, #241c12);
    --vault-text-dim: var(--glass-fg-3, #786b58);
  }

  :host-context([data-theme="light"]) :where(.onboarding-container.g8-page),
  [data-theme="light"] :where(.onboarding-container.g8-page) {
    background:
      radial-gradient(circle at 50% 22%, color-mix(in srgb, var(--g8-gold) 12%, transparent), transparent 42%),
      var(--glass-base, #f7f2e8) !important;
  }

  :host-context([data-theme="light"]) :where(.vault-onboarding.g8-page),
  [data-theme="light"] :where(.vault-onboarding.g8-page) {
    --vo-bg: var(--glass-base, #f7f2e8);
    --vo-surface: var(--glass-2, rgba(255,252,244,.84));
    --vo-border: var(--glass-stroke-gold, rgba(157,108,15,.24));
    --vo-border-active: color-mix(in srgb, var(--g8-gold) 54%, transparent);
    --vo-text: var(--glass-fg, #241c12);
    --vo-text-dim: var(--glass-fg-2, #574b3a);
    --vo-text-muted: var(--glass-fg-3, #786b58);
    --vo-input-bg: var(--glass-3, rgba(255,255,255,.72));
    --vo-input-border: var(--glass-stroke, rgba(90,66,22,.16));
    --vo-card-bg: var(--glass-2, rgba(255,252,244,.8));
    --vo-card-border: var(--glass-stroke, rgba(90,66,22,.16));
    --vo-accent-bg: color-mix(in srgb, var(--g8-gold) 9%, transparent);
  }

  :host-context([data-theme="light"]) :where(.sob-screen.g8-page),
  [data-theme="light"] :where(.sob-screen.g8-page) {
    --sob-ink: var(--glass-base, #f7f2e8);
    --sob-fg: var(--glass-fg, #241c12);
    --sob-fg-2: var(--glass-fg-2, rgba(36,28,18,.72));
    --sob-fg-3: var(--glass-fg-3, rgba(36,28,18,.52));
    --sob-fg-4: color-mix(in srgb, var(--glass-fg, #241c12) 30%, transparent);
    --sob-line: var(--glass-stroke, rgba(90,66,22,.16));
    color-scheme: light;
  }
  :host-context([data-theme="light"]) :where(.sob-screen.g8-page) .sob-ground,
  [data-theme="light"] :where(.sob-screen.g8-page) .sob-ground {
    background: radial-gradient(120% 90% at 50% 0%, #fffdf8 0%, var(--sob-ink) 68%);
  }
  :host-context([data-theme="light"]) :where(.sob-screen.g8-page) .sob-console,
  [data-theme="light"] :where(.sob-screen.g8-page) .sob-console {
    background: var(--g8-sheen), var(--glass-2, rgba(255,252,244,.84));
    box-shadow: var(--glass-elev-3, 0 30px 90px rgba(90,66,22,.17));
  }
  :host-context([data-theme="light"]) :where(.sob-screen.g8-page) .sob-door,
  [data-theme="light"] :where(.sob-screen.g8-page) .sob-door {
    background: linear-gradient(180deg, #fffdf8, #eee5d5);
  }
  :host-context([data-theme="light"]) :where(.sob-screen.g8-page) .sob-hero__title,
  [data-theme="light"] :where(.sob-screen.g8-page) .sob-hero__title {
    background: linear-gradient(180deg, #2b2115 8%, #5b4421 62%, var(--g8-gold) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  :host-context([data-theme="light"]) :where(.g8-page)::before,
  [data-theme="light"] :where(.g8-page)::before { opacity: .38; }

  @media (max-width: 600px) {
    :where(.g8-page) {
      --g8-shadow: var(--glass-elev-1, 0 12px 34px rgba(0,0,0,.2));
    }
    :where(.onboarding-container.g8-page, .quickstart-container.g8-page, .sw-root.g8-page) {
      width: 100%;
      padding: 12px;
    }
    :where(.g8-page) :is(button, .btn, [role="button"], input, textarea, select) {
      min-height: 44px;
    }
    :where(.g8-page)::before { inset-inline: -42%; height: 300px; }
    :where(.g8-page) :is(.setup-grid, .ndb-layout) { gap: 10px; }

    /* Setup is navigation-heavy. On phones the section rail becomes one
       compact horizontal glass shelf so the active workflow stays above the
       fold instead of sitting below twelve full-width navigation cards. */
    :where(.setup-page.g8-page) { overflow-x: hidden; }
    :where(.setup-page.g8-page) .setup-nav {
      flex-direction: row;
      overflow-x: auto;
      overscroll-behavior-inline: contain;
      scroll-snap-type: inline proximity;
      padding: 8px;
      max-width: 100%;
    }
    :where(.setup-page.g8-page) .setup-nav-item {
      flex: 0 0 172px;
      min-width: 0;
      scroll-snap-align: start;
      padding: 10px 12px;
    }
    :where(.setup-page.g8-page) .setup-nav-item .nav-desc { display: none; }
    :where(.setup-page.g8-page) .setup-content { min-width: 0; }

    :where(.sw-root.g8-page) .sw-progress { max-width: 100%; }
    :where(.sw-root.g8-page) .sw-progress__label { display: none; }
    :where(.sw-root.g8-page) .sw-progress__step { min-width: 34px; }
    :where(.sw-root.g8-page) .sw-header {
      flex-direction: column;
      padding: 14px;
    }
    :where(.sw-root.g8-page) .sw-brand { width: 100%; }
    :where(.sw-root.g8-page) .sw-header > .sw-btn { align-self: flex-end; }

    :where(.onboarding-container.g8-page) { overflow-x: hidden; }
    :where(.onboarding-container.g8-page) .arrival-glow {
      width: min(300px, 78vw);
      max-width: 78vw;
      left: calc(50% - min(150px, 39vw));
      right: auto;
    }

    /* Storyboard retains its information architecture but changes from a
       side-by-side workstation into a stacked, independently scrolling view. */
    :where(.sb-container.g8-page) { overflow-x: hidden; }
    :where(.sb-container.g8-page) .sb-header {
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 10px;
      padding: 12px;
    }
    :where(.sb-container.g8-page) .sb-header-left {
      width: 100%;
      min-width: 0;
      justify-content: space-between;
      gap: 10px;
    }
    :where(.sb-container.g8-page) .sb-header-stats { flex: 0 0 auto; }
    :where(.sb-container.g8-page) .sb-header-right {
      width: 100%;
      max-width: 100%;
      overflow-x: auto;
      padding-bottom: 2px;
    }
    :where(.sb-container.g8-page) .sb-header-right > * { flex: 0 0 auto; }
    :where(.sb-container.g8-page) .sb-layout {
      height: auto;
      min-height: calc(100vh - 132px);
      flex-direction: column;
    }
    :where(.sb-container.g8-page) .sb-sidebar {
      width: 100%;
      min-width: 0;
      max-height: 36vh;
      border-right: 0;
      border-bottom: 1px solid var(--g8-line);
    }
    :where(.sb-container.g8-page) .sb-main {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
      padding: 14px 12px;
      overflow-x: hidden;
    }

    :where(.vault-hud.g8-page) { overflow-x: hidden; }
    :where(.vault-hud.g8-page) > div { padding: 12px !important; }
    :where(.vault-hud.g8-page) .vault-header {
      align-items: flex-start !important;
      flex-direction: column;
      gap: 12px;
      padding: 14px !important;
    }
    :where(.vault-hud.g8-page) .vault-header-actions {
      width: 100%;
      max-width: 100%;
      gap: 8px !important;
      overflow-x: auto;
      padding-bottom: 2px;
    }
    :where(.vault-hud.g8-page) .vault-header-actions > * { flex: 0 0 auto; }
    :where(.vault-hud.g8-page) .vault-tabs {
      max-width: 100%;
      overscroll-behavior-inline: contain;
      scrollbar-width: thin;
    }
    :where(.vault-hud.g8-page) .vault-stats {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }
    :where(.vault-hud.g8-page) .vault-courses-deck { padding: 14px !important; }

    :where(.room-customizer.g8-page) .customizer-header {
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 10px;
      padding: 12px;
    }
    :where(.room-customizer.g8-page) .room-selector {
      max-width: 100%;
      flex-wrap: wrap;
    }
    :where(.room-customizer.g8-page) .customizer-body { min-width: 0; }
    :where(.room-customizer.g8-page) .no-room-state { padding: 24px 14px; }
    :where(.room-customizer.g8-page) .room-cards {
      grid-template-columns: minmax(0, 1fr);
      padding-inline: 8px;
    }

    :where(.canvas-overlay.g8-page) {
      left: 6px !important;
      top: 64px !important;
      width: calc(100vw - 12px) !important;
      height: calc(100dvh - 76px) !important;
      max-width: calc(100vw - 12px);
      max-height: calc(100dvh - 76px);
      border-radius: 12px !important;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :where(.g8-page), :where(.g8-page)::before, :where(.g8-page) *, :where(.g8-page) *::before, :where(.g8-page) *::after {
      animation-duration: .001ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
    }
    :where(.g8-page) :is(button, [role="button"], .card):hover { transform: none; }
  }

  @media (prefers-reduced-transparency: reduce) {
    :where(.g8-page) :is(
      .onboarding-content, .quickstart-hero, .install-section, .tunnel-section,
      .setup-header, .setup-nav, .setup-content, .sw-card, .sob-console,
      .niw, .nsp, .ncp, .ndb-sidebar, .ndb-main-area,
      .vo-step, .vault-deck-hero, .vault-courses-deck,
      .sb-header, .sb-sidebar, .sb-main, .room-header, .customizer-body,
      .element-library, .properties-panel, .room-settings, .canvas-toolbar,
      .onboarding-progress, .sw-progress, .sob-rail, .vo-progress
    ) {
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
      background: var(--glass-solid, var(--g-surface, #14110d));
    }
    :where(.g8-page)::before, :where(.g8-page)::after { display: none; }
  }

  :host-context(.low-power) :where(.g8-page)::before,
  :host-context(.low-power) :where(.g8-page)::after,
  :host-context([data-low-power]) :where(.g8-page)::before,
  :host-context([data-low-power]) :where(.g8-page)::after { display: none; }
</style>`;
