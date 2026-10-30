/**
 * Luxury-glass styles for the Integrations panel (ManyChat + Instagram).
 *
 * Builds on the shared `.gt-*` primitives in glass-tools-shared.ts. Every
 * selector is scoped under `.int-panel` (which is also a `.gt-scope`), so it
 * cannot leak into the funnel-flow-map modal that hosts it.
 *
 * NOTE: `.int-panel` deliberately has no backdrop-filter / transform / filter —
 * any of those would turn it into the containing block for the position:fixed
 * flow + media modals rendered inside it.
 */
export const GLASS_INTEGRATIONS_CSS = /* css */ `
.int-panel {
  --int-pad: 22px;
  --int-ig: linear-gradient(45deg, #feda75 0%, #fa7e1e 24%, #d62976 50%, #962fbf 76%, #4f5bd5 100%);
  --int-mc: linear-gradient(150deg, #4c9bff 0%, #1e6bf0 52%, #0f47b8 100%);
  position: relative;
  min-height: 400px;
  padding: var(--int-pad);
  border-radius: 22px;
  overflow: hidden;
  color: var(--gt-fg);
  font-family: var(--g-font-family, inherit);
  font-size: 13px;
  line-height: 1.45;
  background:
    radial-gradient(90% 60% at 0% 0%, color-mix(in srgb, var(--gt-gold) 9%, transparent), transparent 60%),
    radial-gradient(70% 50% at 100% 0%, color-mix(in srgb, var(--g-accent, #a855f7) 6%, transparent), transparent 60%),
    linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated, #111) 80%, transparent), color-mix(in srgb, var(--bg, #050505) 92%, transparent));
  box-shadow: inset 0 0 0 1px var(--gt-line), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
:root[data-theme="light"] .int-panel {
  background:
    radial-gradient(90% 60% at 0% 0%, color-mix(in srgb, var(--gt-gold) 12%, transparent), transparent 60%),
    radial-gradient(70% 50% at 100% 0%, color-mix(in srgb, var(--g-accent, #a855f7) 6%, transparent), transparent 60%),
    linear-gradient(180deg, #fbf8f1, #f4efe4);
  box-shadow: inset 0 0 0 1px var(--gt-line), inset 0 1px 0 #fff;
}
.int-panel *, .int-panel *::before, .int-panel *::after { box-sizing: border-box; }
.int-panel svg { flex: none; }
/* No negative side inset: keep the glow's box inside the panel so it never
   pokes past a 390px phone edge. */
.int-panel .gt-aurora { inset: -60px 0 auto; height: 300px; opacity: 0.7; }
.int-panel h2, .int-panel h3, .int-panel h4, .int-panel p { margin: 0; }
.int-panel a { color: var(--gt-gold-ink); }
.int-panel .gt-btn { text-decoration: none; white-space: nowrap; }
.int-panel .gt-btn svg { width: 15px; height: 15px; }
.int-panel .gt-chip svg { width: 12px; height: 12px; }
.int-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ── Hub header ─────────────────────────────────────────────── */
.int-panel .gt-hero { padding: 0 0 18px; align-items: flex-end; }
.int-panel .gt-title { font-size: clamp(22px, 2.6vw, 28px); margin: 8px 0 5px; }
.int-panel .gt-sub { font-size: 12.5px; max-width: 44ch; }
.int-panel .gt-stat { min-width: 78px; padding: 9px 12px; }
.int-panel .gt-stat-value { font-size: 18px; }
.int-panel .gt-stat-label { font-size: 9px; }

/* ── Connector toolbar (search + category) ─────────────────── */
.int-hub-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.int-hub-search {
  position: relative;
  flex: 1 1 180px;
  min-width: 0;
  display: flex;
  align-items: center;
}
.int-hub-search svg {
  position: absolute; left: 12px;
  width: 15px; height: 15px;
  color: var(--gt-faint);
  pointer-events: none;
}
.int-hub-search .gt-input { width: 100%; padding-left: 36px; height: 36px; }
.int-panel .gt-seg { flex: none; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.int-panel .gt-seg::-webkit-scrollbar { display: none; }
.int-panel .gt-seg button { white-space: nowrap; }
.int-seg-count {
  margin-left: 6px;
  font: 600 10px/1 var(--mono);
  color: var(--gt-faint);
}
.int-panel .gt-seg button[aria-pressed="true"] .int-seg-count { color: var(--gt-gold-ink); }

/* ── Connector cards ───────────────────────────────────────── */
.int-connectors {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 238px), 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
.int-connector {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  cursor: pointer;
  text-align: left;
  outline: none;
}
.int-connector:focus-visible { box-shadow: var(--gt-shadow-hover), 0 0 0 2px var(--gt-gold); }
.int-connector[aria-selected="true"] {
  background:
    radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--gt-gold) 13%, transparent), transparent 60%),
    var(--gt-surface);
  box-shadow: var(--gt-shadow), 0 0 0 1px color-mix(in srgb, var(--gt-gold) 45%, transparent), 0 18px 44px -22px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.int-connector[data-state="danger"] { box-shadow: var(--gt-shadow), 0 0 0 1px color-mix(in srgb, var(--danger) 35%, transparent); }
.int-connector-top { display: flex; align-items: center; gap: 12px; min-width: 0; }
.int-connector-name { display: block; font-size: 14.5px; font-weight: 620; letter-spacing: -0.01em; color: var(--gt-fg); }
.int-connector-cat {
  display: block;
  margin-top: 3px;
  font: 500 9.5px/1 var(--mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.int-connector-id { flex: 1; min-width: 0; }
.int-connector-desc { color: var(--gt-dim); font-size: 12.5px; line-height: 1.5; min-height: 2.9em; }
.int-connector-desc strong { color: var(--gt-fg); font-weight: 600; }
.int-connector-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--gt-line);
}
.int-connector-foot .gt-btn { height: 32px; padding: 0 14px; border-radius: 10px; font-size: 12px; }
.int-connector-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
.int-connector-account {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11.5px; color: var(--gt-dim);
}
.int-connector-arrow { width: 14px; height: 14px; transition: transform 300ms var(--gt-ease); }
.int-connector:hover .int-connector-arrow { transform: translateX(3px); }

/* Brand logo tiles */
.int-logo {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 44px; height: 44px;
  border-radius: 13px;
  color: #fff;
  background: var(--int-brand, var(--gt-gold));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    inset 0 -1px 0 rgba(0, 0, 0, 0.18),
    0 10px 24px -10px var(--int-brand-glow, color-mix(in srgb, var(--gt-gold) 70%, transparent));
  overflow: hidden;
}
.int-logo::after {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.32), rgba(255, 255, 255, 0) 48%);
  pointer-events: none;
}
.int-logo svg { position: relative; z-index: 1; width: 56%; height: 56%; filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.25)); }
.int-logo[data-brand="manychat"] { --int-brand: var(--int-mc); --int-brand-glow: rgba(30, 107, 240, 0.75); }
.int-logo[data-brand="instagram"] { --int-brand: var(--int-ig); --int-brand-glow: rgba(214, 41, 118, 0.7); }
.int-logo--lg { width: 64px; height: 64px; border-radius: 19px; }
.int-logo--sm { width: 34px; height: 34px; border-radius: 10px; }

.int-hub-empty { grid-column: 1 / -1; padding: 30px 20px; }

/* Stage = the area below the connector rail */
.int-stage { position: relative; }
.int-stage-label {
  display: flex; align-items: center; gap: 10px;
  margin: 0 0 12px;
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.int-stage-label::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--gt-line), transparent); }

/* ── Connect form ──────────────────────────────────────────── */
.int-connect { max-width: 560px; margin: 0 auto; padding: 26px 24px 22px; }
.int-connect-hero { display: flex; align-items: center; gap: 16px; margin-bottom: 22px; }
.int-connect-hero h2 { font-size: 19px; font-weight: 640; letter-spacing: -0.015em; color: var(--gt-fg); }
.int-connect-hero p { margin-top: 4px; color: var(--gt-dim); font-size: 12.5px; line-height: 1.5; }
.int-connect-form { display: grid; gap: 16px; }
.int-field { display: grid; gap: 8px; }
.int-field label {
  display: flex; align-items: center; gap: 8px;
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.int-field label .int-field-icon { display: inline-flex; width: 13px; height: 13px; }
.int-field label .int-field-icon svg { width: 100%; height: 100%; }
.int-input-group { display: flex; gap: 10px; }
.int-input-group .gt-input { flex: 1; min-width: 0; height: 42px; font-family: var(--mono); font-size: 12.5px; letter-spacing: 0.04em; }
.int-input-group .gt-btn { height: 42px; padding: 0 20px; }
.int-help {
  padding: 14px 16px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--gt-fg) 3%, transparent);
  border: 1px solid var(--gt-line);
  font-size: 12.5px;
}
.int-help-header { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--gt-fg); margin-bottom: 10px; }
.int-help-header svg { width: 15px; height: 15px; color: var(--gt-gold-ink); }
.int-help ol { margin: 0; padding: 0; list-style: none; counter-reset: int-step; display: grid; gap: 8px; color: var(--gt-dim); }
.int-help li { counter-increment: int-step; display: flex; gap: 10px; align-items: baseline; line-height: 1.5; overflow-wrap: anywhere; }
.int-help li::before {
  content: counter(int-step);
  flex: none;
  display: inline-grid; place-items: center;
  width: 20px; height: 20px;
  border-radius: 50%;
  font: 600 10px/1 var(--mono);
  color: var(--gt-gold-ink);
  background: var(--gt-gold-faint);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 32%, transparent);
  transform: translateY(-1px);
}
.int-help a { text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--gt-gold) 40%, transparent); }
.int-help a:hover { border-bottom-color: var(--gt-gold); }
.int-help-note { margin-top: 12px !important; font-size: 11.5px; color: var(--gt-faint); }
.int-result {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  font-size: 12.5px;
  animation: gt-rise 420ms var(--gt-ease) both;
}
.int-result svg { width: 17px; height: 17px; }
.int-result.success { color: var(--ok); background: var(--ok-subtle); border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent); }
.int-result.error { color: var(--danger); background: var(--danger-subtle); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); }

/* Spinners (kept for in-button feedback) */
.int-spinner {
  width: 14px; height: 14px;
  border: 2px solid rgba(0, 0, 0, 0.25);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: int-spin 0.8s linear infinite;
}
@keyframes int-spin { to { transform: rotate(360deg); } }

/* ── Dashboard ─────────────────────────────────────────────── */
.int-dashboard { display: flex; flex-direction: column; gap: 14px; }
.int-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 14px; flex-wrap: wrap;
  padding: 14px 16px;
}
.int-header-left { display: flex; align-items: center; gap: 14px; min-width: 0; flex: 1 1 220px; }
.int-header-right { display: flex; gap: 8px; flex-wrap: wrap; }
.int-brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.int-brand-info { min-width: 0; }
.int-brand-info h2 {
  font-size: 16px; font-weight: 640; letter-spacing: -0.015em;
  color: var(--gt-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.int-brand-status { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.int-brand-verified { font-size: 11px; color: var(--gt-faint); }

.int-error-banner {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 14px;
  border-radius: 14px;
  font-size: 12.5px; line-height: 1.5;
  color: var(--danger);
  background: var(--danger-subtle);
  border: 1px solid color-mix(in srgb, var(--danger) 32%, transparent);
  overflow-wrap: anywhere;
}
.int-error-banner .gt-light { margin-top: 5px; }

/* Stats */
.int-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.int-stat { display: flex; flex-direction: column; gap: 10px; padding: 12px 12px 11px; border-radius: 16px; min-width: 0; }
.int-stat-icon {
  display: grid; place-items: center;
  width: 28px; height: 28px;
  border-radius: 9px;
  color: var(--gt-gold-ink);
  background: var(--gt-gold-faint);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 22%, transparent);
}
.int-stat-icon svg { width: 14px; height: 14px; }
.int-stat-data { display: flex; flex-direction: column; gap: 4px; }
.int-stat-value { font-size: 22px; font-weight: 640; letter-spacing: -0.025em; line-height: 1; color: var(--gt-fg); font-variant-numeric: tabular-nums; }
.int-stat-label { font: 500 9px/1.2 var(--mono); letter-spacing: 0.06em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-transform: uppercase; color: var(--gt-faint); }
.int-stat.highlight {
  background:
    radial-gradient(120% 100% at 0% 0%, color-mix(in srgb, var(--gt-gold) 18%, transparent), transparent 70%),
    var(--gt-surface);
}
.int-stat.highlight .int-stat-value { color: var(--gt-gold-ink); }

/* Tabs → pill segmented */
.int-tabs {
  display: flex; gap: 2px;
  padding: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  border: 1px solid var(--gt-line);
  overflow-x: auto;
  scrollbar-width: none;
}
.int-tabs::-webkit-scrollbar { display: none; }
.int-tab {
  all: unset;
  flex: 1 0 auto;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  padding: 8px 14px;
  border-radius: 999px;
  font: 520 12px/1 var(--g-font-family, inherit);
  color: var(--gt-dim);
  cursor: pointer;
  white-space: nowrap;
  transition: color 200ms ease, background 280ms var(--gt-ease), box-shadow 280ms ease;
}
.int-tab svg { width: 14px; height: 14px; opacity: 0.8; }
.int-tab:hover { color: var(--gt-fg); background: color-mix(in srgb, var(--gt-fg) 5%, transparent); }
.int-tab:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 1px; }
.int-tab.active {
  color: var(--gt-fg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 24%, transparent), color-mix(in srgb, var(--gt-gold) 9%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 42%, transparent), 0 6px 16px -8px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.int-tab.active svg { color: var(--gt-gold-ink); opacity: 1; }

.int-content { min-height: 260px; }

/* Skeleton loading */
.int-loading { display: grid; gap: 12px; }
.int-skel-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--gt-line); }
.int-skel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.int-skel-card { height: 92px; border-radius: 16px; }
.int-loading-caption { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--gt-faint); }

/* Overview */
.int-overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 12px; }
.int-overview > *, .int-grid > *, .int-tags-list > * { min-width: 0; }
.int-section { border-radius: 18px; }
.int-section-header {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 13px 14px 11px 16px;
  border-bottom: 1px solid var(--gt-line);
}
.int-section-header h3 {
  display: flex; align-items: center; gap: 8px;
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.int-section-header h3 svg { width: 14px; height: 14px; }
.int-section-header .gt-btn { height: 28px; padding: 0 10px; font-size: 11.5px; border-radius: 9px; }
.int-section--bare { padding: 0; }
.int-section--bare .int-section-header { border-bottom: 0; padding: 4px 2px 0; }

/* Lists */
.int-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 6px; }
.int-list--lg { gap: 8px; padding: 0; }
.int-list-item {
  display: flex; align-items: center; gap: 12px;
  padding: 10px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 220ms ease, transform 300ms var(--gt-ease);
}
.int-list-item:hover { background: color-mix(in srgb, var(--gt-gold) 7%, transparent); }
.int-list--lg .int-list-item {
  padding: 12px 14px;
  background: var(--gt-surface);
  border: 1px solid var(--gt-line);
  border-radius: 14px;
}
.int-list--lg .int-list-item:hover { transform: translateX(2px); border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); }
.int-list-icon {
  display: grid; place-items: center;
  flex: none;
  width: 32px; height: 32px;
  border-radius: 10px;
  color: var(--gt-gold-ink);
  background: var(--gt-gold-faint);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 20%, transparent);
}
.int-list-icon svg { width: 15px; height: 15px; }
.int-list-content { flex: 1; min-width: 0; }
.int-list-title { display: block; font-size: 13px; font-weight: 560; color: var(--gt-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.int-list-meta { display: block; margin-top: 2px; font-size: 11.5px; color: var(--gt-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Badges */
.int-badge {
  flex: none;
  display: inline-flex; align-items: center; gap: 6px;
  height: 22px; padding: 0 9px;
  border-radius: 999px;
  font: 600 9.5px/1 var(--mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--gt-dim);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  border: 1px solid var(--gt-line);
}
.int-badge::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.int-badge.success { color: var(--ok); background: var(--ok-subtle); border-color: color-mix(in srgb, var(--ok) 28%, transparent); }
.int-badge.success::before { box-shadow: 0 0 6px var(--ok); }

/* Empty states */
.int-empty { padding: 22px 14px; text-align: center; color: var(--gt-faint); font-size: 12.5px; }
.int-empty-lg { display: grid; justify-items: center; gap: 10px; padding: 44px 20px; text-align: center; color: var(--gt-dim); font-size: 13px; }
.int-empty-lg > svg {
  width: 56px; height: 56px; padding: 15px;
  border-radius: 18px;
  color: var(--gt-gold-ink);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 26%, transparent), color-mix(in srgb, var(--gt-gold) 5%, transparent) 70%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 30%, transparent), 0 16px 34px -16px color-mix(in srgb, var(--gt-gold) 55%, transparent);
}
.int-empty-note { padding: 12px 14px; border-radius: 12px; border: 1px dashed var(--gt-line); color: var(--gt-faint); font-size: 12px; }
.int-empty-note code { font-family: var(--mono); font-size: 11px; color: var(--gt-gold-ink); }

/* Top tags grid */
.int-tags-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; padding: 10px; }
.int-tag-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
  padding: 11px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--gt-fg) 3%, transparent);
  border: 1px solid var(--gt-line);
  min-width: 0;
}
.int-tag-color { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 10px currentColor; flex: none; }
.int-tag-card .int-tag-name { max-width: 100%; font-size: 11.5px; color: var(--gt-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.int-tag-card .int-tag-count { font-size: 17px; font-weight: 640; letter-spacing: -0.02em; color: var(--gt-fg); font-variant-numeric: tabular-nums; }

/* Toolbar */
.int-toolbar { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
.int-toolbar-actions { display: flex; gap: 8px; align-items: center; }
.int-search {
  flex: 1 1 200px;
  min-width: 0;
  display: flex; align-items: center; gap: 10px;
  height: 38px; padding: 0 14px;
  border-radius: 12px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--bg, #050505) 55%, transparent);
  color: var(--gt-faint);
  transition: border-color 200ms ease, box-shadow 260ms ease;
}
:root[data-theme="light"] .int-search { background: rgba(255, 255, 255, 0.8); }
.int-search:focus-within { border-color: color-mix(in srgb, var(--gt-gold) 55%, transparent); box-shadow: 0 0 0 4px var(--gt-gold-faint); }
.int-search svg { width: 15px; height: 15px; }
.int-search input { flex: 1; min-width: 0; background: transparent; border: 0; outline: none; color: var(--gt-fg); font: 13px var(--g-font-family, inherit); }
.int-search input::placeholder { color: var(--gt-faint); }
.int-view-toggle { display: inline-flex; gap: 2px; padding: 3px; border-radius: 12px; border: 1px solid var(--gt-line); background: color-mix(in srgb, var(--gt-fg) 4%, transparent); }
.int-view-toggle .gt-btn { width: 30px; height: 30px; padding: 0; border: 0; background: transparent; border-radius: 9px; color: var(--gt-dim); }
.int-view-toggle .gt-btn.active { color: var(--gt-gold-ink); background: color-mix(in srgb, var(--gt-gold) 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 36%, transparent); }

/* Flow grid */
.int-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); gap: 10px; }
.int-flow-card { padding: 14px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.int-flow-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.int-flow-icon {
  display: grid; place-items: center;
  width: 32px; height: 32px;
  border-radius: 10px;
  color: #1a1203;
  background: linear-gradient(160deg, color-mix(in srgb, var(--gt-gold) 80%, #fff 20%), var(--gt-gold) 60%, color-mix(in srgb, var(--gt-gold) 80%, #7a4b00 20%));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 8px 18px -8px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.int-flow-icon svg { width: 15px; height: 15px; }
.int-flow-card h4 { font-size: 13.5px; font-weight: 600; color: var(--gt-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.int-flow-card p { font-size: 11.5px; color: var(--gt-faint); }
.int-flow-footer { display: flex; align-items: center; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--gt-line); }
.int-flow-date { display: inline-flex; align-items: center; gap: 6px; font: 500 10.5px/1 var(--mono); color: var(--gt-faint); }
.int-flow-date svg { width: 12px; height: 12px; }

/* Automations */
.int-automation-item {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--gt-surface);
  border: 1px solid var(--gt-line);
}
.int-automation-info { display: flex; align-items: center; gap: 12px; min-width: 0; }
.int-automation-info > div:last-child { min-width: 0; }
.int-automation-icon {
  display: grid; place-items: center; flex: none;
  width: 34px; height: 34px;
  border-radius: 11px;
  color: var(--gt-faint);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  border: 1px solid var(--gt-line);
  transition: color 260ms ease, background 260ms ease, box-shadow 260ms ease;
}
.int-automation-icon.active { color: var(--gt-gold-ink); background: var(--gt-gold-faint); border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); box-shadow: 0 0 18px -6px color-mix(in srgb, var(--gt-gold) 60%, transparent); }
.int-automation-icon svg { width: 15px; height: 15px; }
.int-automation-info h4 { font-size: 13px; font-weight: 560; color: var(--gt-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.int-automation-type { font: 500 10.5px/1.4 var(--mono); color: var(--gt-faint); }

/* Toggle */
.int-toggle { position: relative; flex: none; width: 44px; height: 26px; cursor: pointer; border-radius: 999px; }
.int-toggle:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; }
.int-toggle-track {
  position: absolute; inset: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--gt-fg) 10%, transparent);
  box-shadow: inset 0 0 0 1px var(--gt-line), inset 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: background 280ms var(--gt-ease), box-shadow 280ms ease;
}
.int-toggle.on .int-toggle-track {
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 85%, #fff 15%), var(--gt-gold));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 4px 14px -4px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.int-toggle-thumb {
  position: absolute; top: 3px; left: 3px;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: linear-gradient(180deg, #fff, #e9e6df);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.35);
  transition: transform 340ms var(--gt-ease);
}
.int-toggle.on .int-toggle-thumb { transform: translateX(18px); }

/* Tags list / fields */
.int-tags-list { display: grid; gap: 6px; }
.int-tag-row, .int-field-item {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px;
  border-radius: 13px;
  background: var(--gt-surface);
  border: 1px solid var(--gt-line);
  min-width: 0;
}
.int-tag-row .int-tag-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 540; color: var(--gt-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.int-tag-subs { flex: none; font: 500 11px/1 var(--mono); color: var(--gt-faint); font-variant-numeric: tabular-nums; }
.int-field-item .int-field-icon {
  display: grid; place-items: center; flex: none;
  width: 32px; height: 32px;
  border-radius: 10px;
  color: var(--g-accent, #a855f7);
  background: color-mix(in srgb, var(--g-accent, #a855f7) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-accent, #a855f7) 26%, transparent);
}
.int-field-item .int-field-icon svg { width: 15px; height: 15px; }
.int-field-info { flex: 1; min-width: 0; }
.int-field-info h4 { font-size: 13px; font-weight: 560; color: var(--gt-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.int-field-type { display: block; font-size: 11.5px; color: var(--gt-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.int-field-id { flex: none; font: 500 10.5px/1 var(--mono); color: var(--gt-gold-ink); background: var(--gt-gold-faint); padding: 5px 8px; border-radius: 7px; }

/* ── Modals (flow + media) ─────────────────────────────────── */
.int-modal-overlay, .int-media-modal-overlay {
  position: fixed; inset: 0;
  z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  background: rgba(3, 3, 5, 0.6);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  backdrop-filter: blur(10px) saturate(140%);
  animation: int-fade 260ms ease both;
}
:root[data-theme="light"] .int-modal-overlay,
:root[data-theme="light"] .int-media-modal-overlay { background: rgba(40, 32, 18, 0.28); }
@keyframes int-fade { from { opacity: 0; } }
.int-modal, .int-media-modal {
  width: 100%;
  max-height: 90vh;
  display: flex; flex-direction: column;
  border-radius: 22px;
  color: var(--gt-fg);
  background:
    radial-gradient(100% 60% at 0% 0%, color-mix(in srgb, var(--gt-gold) 10%, transparent), transparent 60%),
    color-mix(in srgb, var(--bg-elevated, #111) 88%, transparent);
  -webkit-backdrop-filter: blur(28px) saturate(170%);
  backdrop-filter: blur(28px) saturate(170%);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 28%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 40px 100px -30px rgba(0, 0, 0, 0.8),
    0 0 80px -40px color-mix(in srgb, var(--gt-gold) 60%, transparent);
  overflow: hidden;
  animation: int-pop 420ms var(--gt-ease) both;
}
:root[data-theme="light"] .int-modal,
:root[data-theme="light"] .int-media-modal { background: radial-gradient(100% 60% at 0% 0%, color-mix(in srgb, var(--gt-gold) 12%, transparent), transparent 60%), rgba(255, 253, 248, 0.94); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 30%, transparent), inset 0 1px 0 #fff, 0 40px 90px -30px rgba(60, 40, 10, 0.35); }
@keyframes int-pop { from { opacity: 0; transform: translateY(12px) scale(0.98); } }
.int-modal { max-width: 500px; }
.int-modal-header, .int-media-modal-header {
  display: flex; align-items: center; gap: 14px;
  padding: 18px 18px 16px 20px;
  border-bottom: 1px solid var(--gt-line);
}
.int-media-modal-header { justify-content: space-between; }
.int-modal-icon {
  display: grid; place-items: center; flex: none;
  width: 44px; height: 44px;
  border-radius: 13px;
  color: #1a1203;
  background: linear-gradient(160deg, color-mix(in srgb, var(--gt-gold) 80%, #fff 20%), var(--gt-gold) 60%, color-mix(in srgb, var(--gt-gold) 80%, #7a4b00 20%));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 10px 24px -10px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.int-modal-icon svg { width: 20px; height: 20px; }
.int-modal-title { flex: 1; min-width: 0; }
.int-modal-title h2 { font-size: 16.5px; font-weight: 640; letter-spacing: -0.015em; overflow-wrap: anywhere; }
.int-modal-type { font: 500 10px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gt-faint); }
.int-modal-body { padding: 18px 20px; display: grid; gap: 16px; overflow-y: auto; }
.int-modal-section h4 {
  display: flex; align-items: center; gap: 6px;
  margin: 0 0 7px;
  font: 600 9.5px/1 var(--mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.int-modal-section h4 svg { width: 12px; height: 12px; color: var(--gt-gold-ink); }
.int-modal-section p { font-size: 13px; color: var(--gt-fg); }
.int-modal-status {
  display: inline-flex; align-items: center; gap: 8px;
  height: 28px; padding: 0 12px;
  border-radius: 999px;
  font-size: 12px; font-weight: 600;
  border: 1px solid var(--gt-line);
}
.int-modal-status.active { color: var(--ok); background: var(--ok-subtle); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.int-modal-status.draft { color: var(--gt-gold-ink); background: var(--gt-gold-faint); border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); }
.int-modal-status.inactive { color: var(--gt-dim); background: color-mix(in srgb, var(--gt-fg) 5%, transparent); }
.int-status-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
.int-modal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }
.int-modal-code {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 6px 6px 12px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--bg, #050505) 60%, transparent);
  border: 1px solid var(--gt-line);
}
:root[data-theme="light"] .int-modal-code { background: rgba(255, 255, 255, 0.8); }
.int-modal-code code { flex: 1; min-width: 0; font: 500 11px/1.4 var(--mono); color: var(--gt-gold-ink); word-break: break-all; }
.int-modal-code .gt-btn { width: 28px; height: 28px; padding: 0; border-radius: 8px; }
.int-modal-code .gt-btn svg { width: 13px; height: 13px; }
.int-modal-triggers { display: flex; flex-wrap: wrap; gap: 6px; }
.int-modal-footer, .int-media-modal-footer {
  display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
  padding: 14px 18px;
  border-top: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 2.5%, transparent);
}
.int-media-modal-footer { justify-content: center; }
.int-icon-btn { width: 34px; height: 34px; padding: 0 !important; border-radius: 11px !important; flex: none; }

/* ── Instagram dashboard ───────────────────────────────────── */
.int-ig-profile { display: flex; align-items: center; gap: 20px; padding: 20px; flex-wrap: wrap; }
.int-ig-avatar { position: relative; flex: none; padding: 3px; border-radius: 50%; background: var(--int-ig); box-shadow: 0 14px 30px -14px rgba(214, 41, 118, 0.7); }
.int-ig-profile-pic { display: block; width: 76px; height: 76px; border-radius: 50%; object-fit: cover; border: 3px solid var(--bg-elevated, #111); background: var(--bg-elevated, #111); }
.int-ig-profile-info { flex: 1 1 220px; min-width: 0; }
.int-ig-profile-name { font-size: 19px; font-weight: 650; letter-spacing: -0.02em; color: var(--gt-fg); margin: 0 0 2px; overflow-wrap: anywhere; }
.int-ig-profile-username { font-size: 12.5px; color: var(--gt-faint); margin: 0 0 12px; }
.int-ig-profile-stats { display: flex; gap: 22px; flex-wrap: wrap; }
.int-ig-profile-stat { display: flex; flex-direction: column; gap: 3px; }
.int-ig-profile-stat-value { font-size: 17px; font-weight: 650; letter-spacing: -0.02em; color: var(--gt-fg); font-variant-numeric: tabular-nums; }
.int-ig-profile-stat-label { font: 500 9px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gt-faint); }
.int-ig-profile-bio { margin-top: 12px !important; font-size: 12.5px; color: var(--gt-dim); line-height: 1.55; }
.int-ig-insights-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 10px; }
.int-ig-insight-card { padding: 14px; border-radius: 16px; }
.int-ig-insight-value { font-size: 22px; font-weight: 650; letter-spacing: -0.025em; color: var(--gt-fg); font-variant-numeric: tabular-nums; }
.int-ig-insight-label { margin-top: 6px; font: 500 9px/1.2 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gt-faint); }
.int-ig-media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); gap: 10px; }
.int-ig-media-card {
  position: relative;
  border-radius: 16px;
  overflow: hidden;
  cursor: pointer;
  background: var(--gt-surface-solid);
  box-shadow: var(--gt-shadow), inset 0 0 0 1px var(--gt-line);
  transition: transform 420ms var(--gt-ease), box-shadow 420ms var(--gt-ease);
}
.int-ig-media-card:hover { transform: translateY(-3px); box-shadow: var(--gt-shadow-hover), inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 40%, transparent); }
.int-ig-media-card img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; transition: transform 700ms var(--gt-ease); }
.int-ig-media-card:hover img { transform: scale(1.05); }
.int-ig-media-type {
  position: absolute; top: 8px; right: 8px;
  display: inline-flex; align-items: center; gap: 5px;
  height: 22px; padding: 0 8px;
  border-radius: 999px;
  font: 600 9px/1 var(--mono); letter-spacing: 0.12em;
  color: #fff;
  background: rgba(10, 10, 12, 0.55);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
}
.int-ig-media-type svg { width: 10px; height: 10px; }
.int-ig-media-stats { display: flex; gap: 12px; padding: 10px 12px; }
.int-ig-media-stat { display: inline-flex; align-items: center; gap: 5px; font: 500 11px/1 var(--mono); color: var(--gt-dim); font-variant-numeric: tabular-nums; }
.int-ig-media-stat svg { width: 12px; height: 12px; color: var(--gt-gold-ink); }
.int-ig-media-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 54px;
  background: linear-gradient(180deg, transparent 35%, rgba(5, 5, 7, 0.72));
  opacity: 0;
  transition: opacity 300ms ease;
  pointer-events: none;
}
.int-ig-media-overlay span {
  display: inline-flex; align-items: center; height: 26px; padding: 0 12px;
  border-radius: 999px;
  font-size: 11.5px; font-weight: 600;
  color: #1a1203;
  background: var(--gt-gold);
  box-shadow: 0 8px 20px -6px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.int-ig-media-card:hover .int-ig-media-overlay, .int-ig-media-card:focus-visible .int-ig-media-overlay { opacity: 1; }
.int-ig-media-card:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; }

/* Media modal */
.int-media-modal { max-width: 900px; }
.int-media-modal-type {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 12px;
  border-radius: 999px;
  font-size: 12px; font-weight: 600;
  color: #1a1203;
  background: var(--gt-gold);
}
.int-media-modal-type svg { width: 13px; height: 13px; }
.int-media-modal-type.video { color: #fff; background: var(--int-ig); }
.int-media-modal-content { display: grid; grid-template-columns: 1fr 1fr; flex: 1; min-height: 0; overflow: hidden; }
.int-media-modal-preview { background: #000; display: flex; align-items: center; justify-content: center; max-height: 500px; overflow: hidden; }
.int-media-modal-preview img, .int-media-modal-preview video { width: 100%; height: 100%; object-fit: contain; }
.int-media-modal-analytics { padding: 18px 20px; overflow-y: auto; }
.int-media-modal-analytics h3 {
  display: flex; align-items: center; gap: 8px;
  margin: 0 0 14px;
  font: 600 10px/1 var(--mono); letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.int-media-modal-analytics h3 svg { width: 14px; height: 14px; }
.int-media-stats-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 18px; }
.int-media-stat-card {
  display: flex; flex-direction: column; gap: 6px;
  padding: 12px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  border: 1px solid var(--gt-line);
  min-width: 0;
}
.int-media-stat-card.highlight { background: radial-gradient(120% 100% at 0% 0%, color-mix(in srgb, var(--gt-gold) 18%, transparent), transparent 70%); border-color: color-mix(in srgb, var(--gt-gold) 36%, transparent); }
.int-media-stat-icon { display: inline-flex; color: var(--gt-gold-ink); }
.int-media-stat-icon svg { width: 14px; height: 14px; }
.int-media-stat-value { font-size: 18px; font-weight: 650; letter-spacing: -0.02em; color: var(--gt-fg); font-variant-numeric: tabular-nums; }
.int-media-stat-label { font: 500 9px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gt-faint); }
.int-media-caption { margin-bottom: 14px; }
.int-media-caption h4 { margin: 0 0 8px; font: 600 9.5px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--gt-faint); }
.int-media-caption p { font-size: 12.5px; line-height: 1.6; color: var(--gt-dim); padding: 12px; border-radius: 12px; background: color-mix(in srgb, var(--gt-fg) 3%, transparent); border: 1px solid var(--gt-line); overflow-wrap: anywhere; }
.int-media-meta { display: flex; align-items: center; gap: 6px; font: 500 11px/1 var(--mono); color: var(--gt-faint); }
.int-media-meta svg { width: 12px; height: 12px; }

/* ── Fallbacks ─────────────────────────────────────────────── */
:root.perf-mode .int-modal-overlay, :root.perf-mode .int-media-modal-overlay,
:root.perf-mode .int-modal, :root.perf-mode .int-media-modal,
:root.perf-mode .int-ig-media-type { -webkit-backdrop-filter: none; backdrop-filter: none; }
:root.perf-mode .int-modal, :root.perf-mode .int-media-modal { background: var(--gt-surface-solid); }
:root.perf-mode .int-modal-overlay, :root.perf-mode .int-media-modal-overlay { background: rgba(3, 3, 5, 0.82); }
@media (prefers-reduced-transparency: reduce) {
  .int-modal-overlay, .int-media-modal-overlay, .int-modal, .int-media-modal, .int-ig-media-type { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
  .int-modal, .int-media-modal { background: var(--gt-surface-solid) !important; }
  .int-modal-overlay, .int-media-modal-overlay { background: rgba(3, 3, 5, 0.82) !important; }
}
@media (prefers-reduced-motion: reduce) {
  .int-panel *, .int-panel *::before, .int-panel *::after { animation: none !important; transition: none !important; }
  .int-ig-media-card:hover, .int-ig-media-card:hover img, .int-list--lg .int-list-item:hover { transform: none; }
}

/* ── Narrow (mobile + slim modal) ──────────────────────────── */
@media (max-width: 640px) {
  .int-panel { --int-pad: 14px; border-radius: 18px; }
  .int-panel .gt-hero { padding-bottom: 14px; }
  .int-panel .gt-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  /* Four filters don't fit one row at 390px: two even rows, nothing clipped. */
  .int-panel .gt-seg { width: 100%; display: grid; grid-template-columns: 1fr 1fr; border-radius: 16px; overflow: visible; }
  .int-panel .gt-seg button { text-align: center; padding: 8px 8px; border-radius: 12px; }
  .int-connect { padding: 18px 16px; }
  .int-connect-hero { align-items: flex-start; }
  .int-connect-hero .int-logo--lg { width: 52px; height: 52px; border-radius: 16px; }
  .int-input-group { flex-direction: column; }
  .int-input-group .gt-input { flex: none; width: 100%; }
  .int-input-group .gt-btn { width: 100%; }
  .int-header { padding: 12px; }
  .int-header-right { width: 100%; }
  .int-header-right .gt-btn { flex: 1; }
  .int-stats { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
  .int-stats .int-stat { grid-column: span 2; padding: 10px; gap: 8px; }
  .int-stats .int-stat:nth-child(n + 4) { grid-column: span 3; }
  .int-stat-value { font-size: 19px; }
  .int-panel .gt-stat-label { letter-spacing: 0.08em; }
  /* Wrap onto two rows instead of side-scrolling, like the filter bar, so no
     tab sits hidden past the phone edge. */
  .int-tabs { flex-wrap: wrap; overflow: visible; border-radius: 16px; }
  .int-tab { flex: 1 1 auto; padding: 8px 12px; border-radius: 12px; }
  .int-ig-profile { padding: 16px; gap: 14px; }
  .int-ig-media-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .int-media-modal-content { grid-template-columns: 1fr; overflow-y: auto; }
  .int-media-stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .int-modal-overlay, .int-media-modal-overlay { padding: 12px; align-items: flex-end; }
  .int-toolbar-actions { width: 100%; justify-content: space-between; }
}
`;
