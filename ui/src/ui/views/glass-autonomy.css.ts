/**
 * Autonomy page — premium black-gold glass layer (light DOM).
 *
 * Rendered with `glassAgentsStyle(AUTONOMY_GLASS_CSS)` inside the dashboard
 * root (`.auto-dashboard.gt-scope.ga-autonomy`), so it ships together with the
 * shared `.gt-*` / `.ga-*` primitives and wins over the legacy
 * `autonomyStyles` (injected once into <head>) by specificity + order.
 *
 * Every selector is prefixed with `.ga-autonomy` so nothing leaks. Colours come
 * from the glass tokens (`--gt-*` set on `.gt-scope`, `--glass-*`) plus the
 * semantic `--ok/--warn/--danger`, so dark, light, reduced transparency,
 * reduced motion and perf mode all follow automatically.
 *
 * Blur budget: only `.auto-panel`, the tab bar, the hero stat tiles and the
 * modal blur. Everything that sits on a panel (cards, sections, rows,
 * buttons) is flat glass without `backdrop-filter`.
 */
export const AUTONOMY_GLASS_CSS = /* css */ `
/* ── Root ───────────────────────────────────────────────────── */
.ga-autonomy.auto-dashboard.auto-v2 {
  /* Not isolated: the create-task modal is position:fixed and must compete
     with the app chrome. The aurora sits at z 0, content at z 1. */
  isolation: auto;
  gap: 18px;
  padding: 8px 24px 40px;
  font-family: var(--glass-font, var(--font-ui, system-ui, sans-serif));
  color: var(--gt-fg);
  -webkit-font-smoothing: antialiased;
  --ga-auto-well: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  --ga-auto-well-hi: color-mix(in srgb, var(--gt-fg) 6%, transparent);
  --ga-auto-sunk: color-mix(in srgb, var(--glass-base, var(--bg, #050505)) 55%, transparent);
  --ga-auto-hair: color-mix(in srgb, var(--gt-gold) 16%, var(--gt-line));
  --ga-auto-mono: var(--glass-font-mono, var(--mono, ui-monospace, monospace));
  --ga-auto-display: var(--font-ui-display, var(--glass-font, system-ui, sans-serif));
}
:root[data-theme="light"] .ga-autonomy.auto-dashboard.auto-v2 {
  --gt-fg: var(--glass-fg, var(--text-strong, #18181b));
  --gt-dim: color-mix(in srgb, var(--text-strong, #18181b) 68%, transparent);
  --gt-faint: var(--muted-strong, #52525b);
  --ga-auto-well: rgba(255, 255, 255, 0.55);
  --ga-auto-well-hi: rgba(255, 255, 255, 0.85);
  --ga-auto-sunk: rgba(255, 255, 255, 0.78);
}
.ga-autonomy.auto-dashboard > .gt-aurora { position: absolute; z-index: 0; }
.ga-autonomy code,
.ga-autonomy .mono,
.ga-autonomy .auto-session-key { font-family: var(--ga-auto-mono); }
.ga-autonomy svg { flex-shrink: 0; }
.ga-autonomy button { -webkit-tap-highlight-color: transparent; }
.ga-autonomy .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* ── Hero ───────────────────────────────────────────────────── */
.ga-autonomy .auto-v2-head.ga-auto-hero {
  align-items: flex-end;
  gap: 18px 24px;
  padding: 18px 2px 4px;
}
.ga-autonomy .ga-auto-hero-copy { min-width: 0; display: grid; gap: 0; }
.ga-autonomy .auto-v2-title h1.gt-title {
  margin: 10px 0 6px;
  font-family: var(--ga-auto-display);
  font-size: clamp(28px, 3.4vw, 40px);
  font-weight: 650;
  letter-spacing: -0.03em;
}
.ga-autonomy .ga-auto-hero .gt-sub { font-size: 13.5px; }
.ga-autonomy .ga-auto-status { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.ga-autonomy .ga-auto-status .gt-chip { font-family: var(--glass-font, inherit); font-size: 11.5px; font-weight: 550; letter-spacing: 0; }
.ga-autonomy .ga-auto-status .gt-chip .gt-light { width: 7px; height: 7px; }
.ga-autonomy .auto-v2-actions { gap: 8px; align-items: center; }

/* Glass buttons (hero + toolbars) */
.ga-autonomy .auto-v2-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 16px;
  border-radius: 12px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  color: var(--gt-fg);
  font: 550 12.5px/1 var(--glass-font, inherit);
  transition: transform 160ms ease, background 220ms ease, border-color 220ms ease, box-shadow 260ms ease;
}
.ga-autonomy .auto-v2-btn svg { width: 15px; height: 15px; }
.ga-autonomy .auto-v2-btn:hover { background: color-mix(in srgb, var(--gt-fg) 9%, transparent); border-color: color-mix(in srgb, var(--gt-gold) 34%, transparent); }
.ga-autonomy .auto-v2-btn:active { transform: scale(0.97); }
.ga-autonomy .auto-v2-btn:focus-visible,
.ga-autonomy .auto-v2-tab:focus-visible,
.ga-autonomy .auto-v2-subtab:focus-visible,
.ga-autonomy .auto-btn:focus-visible,
.ga-autonomy .auto-task-card:focus-visible,
.ga-autonomy .auto-settings-chip:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.ga-autonomy .auto-v2-btn.icon { width: 38px; padding: 0; }
.ga-autonomy .auto-v2-btn.primary {
  color: var(--glass-ink, #120c00);
  border-color: transparent;
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 80%, #fff 20%), var(--gt-gold) 55%, color-mix(in srgb, var(--gt-gold) 80%, #7a4b00 20%));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 8px 22px -8px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.ga-autonomy .auto-v2-btn.primary:hover { filter: brightness(1.06); }

/* Telegram status chip */
.ga-autonomy .auto-telegram-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 4px 0 12px;
  border-radius: 12px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-well);
  max-width: 100%;
  min-width: 0;
}
.ga-autonomy .auto-telegram-label {
  font-size: 12px;
  color: var(--gt-dim);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.ga-autonomy .auto-telegram-chip .auto-btn.icon {
  width: 30px;
  height: 30px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 9px;
}
.ga-autonomy .auto-telegram-chip .auto-btn.icon svg { width: 14px; height: 14px; }

/* ── Section tab bar ────────────────────────────────────────── */
.ga-autonomy .auto-v2-nav {
  position: relative;
  gap: 4px;
  padding: 5px;
  border: 0;
  border-radius: 16px;
  background: var(--gt-surface);
  -webkit-backdrop-filter: var(--gt-blur);
  backdrop-filter: var(--gt-blur);
  box-shadow: var(--gt-shadow);
  scroll-padding: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  scroll-snap-type: x proximity;
}
.ga-autonomy .auto-v2-nav::-webkit-scrollbar { height: 3px; }
.ga-autonomy .auto-v2-nav::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--gt-gold) 34%, transparent); border-radius: 999px; }
.ga-autonomy .auto-v2-tab {
  position: relative;
  min-height: 38px;
  padding: 0 14px;
  border: 0;
  border-radius: 11px;
  color: var(--gt-dim);
  font: 550 13px/1 var(--glass-font, inherit);
  letter-spacing: -0.005em;
  gap: 8px;
  flex-shrink: 0;
  scroll-snap-align: start;
  transition: color 200ms ease, background 260ms var(--gt-ease), box-shadow 260ms ease, transform 160ms ease;
}

/* The goals surface owns a shadow root, so pass the glass recipe through the
   semantic variables it already consumes instead of stacking another blur. */
.ga-autonomy autonomy-goals-view,
.ga-autonomy autonomy-phases-view,
.ga-autonomy autonomy-scheduled-view {
  display: block;
  font-family: var(--glass-font, var(--font-ui, Inter, system-ui, sans-serif));
  --bg-muted: var(--ga-auto-sunk);
  --text-strong: var(--gt-fg);
  --border-strong: color-mix(in srgb, var(--gt-gold) 40%, var(--gt-line));
  --radius-full: 999px;
  --card: linear-gradient(145deg, color-mix(in srgb, #fff 7%, transparent), transparent 38%), color-mix(in srgb, var(--gt-fg) 5%, var(--gt-surface));
  --border: color-mix(in srgb, var(--gt-gold) 27%, var(--gt-line));
  --input: var(--ga-auto-sunk);
  --bg-elevated: var(--ga-auto-sunk);
  --bg-hover: var(--ga-auto-well-hi);
  --panel: var(--ga-auto-well);
  --text: var(--gt-fg);
  --muted: var(--gt-faint);
  --muted-strong: var(--gt-dim);
  --accent: var(--gt-gold);
  --accent-hover: var(--gt-gold-ink);
  --accent-subtle: var(--gt-gold-faint);
  --focus: var(--gt-gold);
  --radius-lg: 18px;
  --radius-md: 11px;
  --radius-sm: 8px;
  --font-body: var(--glass-font, var(--font-ui, Inter, system-ui, sans-serif));
  filter: drop-shadow(0 18px 34px color-mix(in srgb, var(--glass-base, #000) 32%, transparent));
}
.ga-autonomy .auto-v2-tab svg { width: 15px; height: 15px; opacity: 0.75; }
.ga-autonomy .auto-v2-tab:hover { color: var(--gt-fg); background: color-mix(in srgb, var(--gt-fg) 4%, transparent); }
.ga-autonomy .auto-v2-tab:active { transform: scale(0.97); }
.ga-autonomy .auto-v2-tab.on {
  color: var(--gt-fg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 22%, transparent), color-mix(in srgb, var(--gt-gold) 8%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 42%, transparent), 0 6px 18px -8px color-mix(in srgb, var(--gt-gold) 65%, transparent);
}
.ga-autonomy .auto-v2-tab.on svg { opacity: 1; color: var(--gt-gold-ink); }
.ga-autonomy .auto-v2-badge {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font: 600 10.5px/1 var(--ga-auto-mono);
  font-variant-numeric: tabular-nums;
  color: var(--glass-ink, #120c00);
  background: var(--gt-gold);
}

/* Tasks sub-bar */
.ga-autonomy .auto-v2-subbar { gap: 10px; }
.ga-autonomy .auto-v2-subtabs.gt-seg .auto-v2-subtab {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 999px;
  font: 550 12px/1 var(--glass-font, inherit);
  color: var(--gt-dim);
  transition: color 200ms ease, background 260ms var(--gt-ease), box-shadow 260ms ease;
}
.ga-autonomy .auto-v2-subtabs.gt-seg .auto-v2-subtab:hover { color: var(--gt-fg); }
.ga-autonomy .auto-v2-subtabs.gt-seg .auto-v2-subtab.on {
  color: var(--gt-fg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 22%, transparent), color-mix(in srgb, var(--gt-gold) 8%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 40%, transparent);
}
.ga-autonomy .auto-v2-subtabs.gt-seg .auto-v2-subtab:focus-visible { box-shadow: var(--gt-focus); }

/* ── Panels (one blur per stack) ────────────────────────────── */
.ga-autonomy .auto-panel {
  position: relative;
  overflow: visible;
  border: 0;
  border-radius: var(--gt-radius);
  background: var(--gt-surface);
  -webkit-backdrop-filter: var(--gt-blur);
  backdrop-filter: var(--gt-blur);
  box-shadow: var(--gt-shadow);
}
.ga-autonomy .auto-panel::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(140deg, var(--gt-gold-hair) 0%, color-mix(in srgb, var(--gt-gold) 8%, transparent) 30%, var(--gt-line) 55%, color-mix(in srgb, var(--gt-gold) 26%, transparent) 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}
.ga-autonomy .auto-panel::after {
  content: "";
  position: absolute;
  left: 14%; right: 14%; top: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.5), transparent);
  opacity: 0.5;
  pointer-events: none;
}
:root[data-theme="light"] .ga-autonomy .auto-panel::after { background: linear-gradient(90deg, transparent, #fff, transparent); opacity: 1; }
.ga-autonomy .auto-panel-header {
  gap: 10px;
  padding: 16px 18px 12px;
  border-bottom: 0;
}
.ga-autonomy .auto-panel-title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  font: 600 10.5px/1.2 var(--ga-auto-mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.ga-autonomy .auto-panel-title::after {
  content: "";
  flex: 1;
  height: 1px;
  min-width: 12px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 40%, transparent), transparent);
}
.ga-autonomy .auto-panel-count {
  display: inline-grid;
  place-items: center;
  min-width: 22px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  font: 600 11px/1 var(--ga-auto-mono);
  font-variant-numeric: tabular-nums;
  color: var(--gt-gold-ink);
  background: var(--gt-gold-faint);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 28%, transparent);
}
.ga-autonomy .auto-panel-body { padding: 4px 16px 16px; }
.ga-autonomy .auto-main-panel > .auto-panel-body { padding-top: 16px; }

/* Task grid */
.ga-autonomy.auto-v2 .auto-grid {
  grid-template-columns: minmax(250px, 300px) minmax(0, 1fr) minmax(280px, 340px);
  gap: 16px;
  min-height: 0;
  align-items: start;
}
.ga-autonomy .auto-grid > .auto-panel { min-width: 0; }
.ga-autonomy .auto-grid .auto-panel-body { max-height: min(76vh, 900px); }

/* ── Buttons on panels (flat, no blur) ──────────────────────── */
.ga-autonomy .auto-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  color: var(--gt-fg);
  font: 550 12px/1 var(--glass-font, inherit);
  letter-spacing: 0;
  transition: transform 160ms ease, background 220ms ease, border-color 220ms ease, box-shadow 260ms ease, filter 220ms ease;
}
.ga-autonomy .auto-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--gt-fg) 9%, transparent);
  border-color: color-mix(in srgb, var(--gt-gold) 34%, transparent);
  box-shadow: none;
}
.ga-autonomy .auto-btn:active:not(:disabled) { transform: scale(0.97); }
.ga-autonomy .auto-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ga-autonomy .auto-btn.small { min-height: 28px; padding: 0 11px; font-size: 11.5px; border-radius: 9px; }
.ga-autonomy .auto-btn.full { width: 100%; min-height: 40px; }
.ga-autonomy .auto-btn.gold {
  color: var(--glass-ink, #120c00);
  border-color: transparent;
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 80%, #fff 20%), var(--gt-gold) 55%, color-mix(in srgb, var(--gt-gold) 80%, #7a4b00 20%));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 6px 18px -8px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.ga-autonomy .auto-btn.gold:hover:not(:disabled) {
  filter: brightness(1.06);
  border-color: transparent;
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 80%, #fff 20%), var(--gt-gold) 55%, color-mix(in srgb, var(--gt-gold) 80%, #7a4b00 20%));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55), 0 10px 26px -8px color-mix(in srgb, var(--gt-gold) 80%, transparent);
}
.ga-autonomy .auto-btn.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: var(--danger-subtle, color-mix(in srgb, var(--danger) 10%, transparent)); }
.ga-autonomy .auto-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 18%, transparent); border-color: var(--danger); }
.ga-autonomy .auto-btn.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: var(--warn-subtle, color-mix(in srgb, var(--warn) 10%, transparent)); }
.ga-autonomy .auto-btn.warn:hover:not(:disabled) { background: color-mix(in srgb, var(--warn) 18%, transparent); border-color: var(--warn); }

/* ── Queue column ───────────────────────────────────────────── */
.ga-autonomy .auto-queue-section { margin-bottom: 16px; }
.ga-autonomy .auto-section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 8px;
  padding: 0 2px;
  border: 0;
  background: none;
  font: 600 10px/1.2 var(--ga-auto-mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.ga-autonomy .auto-section-label svg { width: 12px; height: 12px; }
.ga-autonomy .auto-section-label.gold { color: var(--gt-gold-ink); background: none; }
.ga-autonomy .auto-section-label::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--ga-auto-hair), transparent);
}
.ga-autonomy .auto-task-card {
  position: relative;
  margin-bottom: 8px;
  padding: 12px 12px 11px 14px;
  border-radius: var(--gt-radius-sm);
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-well);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  transition: transform 360ms var(--gt-spring, var(--gt-ease)), border-color 220ms ease, box-shadow 360ms var(--gt-ease), background 220ms ease;
}
.ga-autonomy .auto-task-card::before {
  content: "";
  position: absolute;
  left: 0; top: 10px; bottom: 10px;
  width: 2px;
  border-radius: 2px;
  background: transparent;
  transition: background 220ms ease;
}
.ga-autonomy .auto-task-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent);
  background: var(--ga-auto-well-hi);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent), 0 14px 34px -18px color-mix(in srgb, var(--gt-gold) 45%, transparent);
}
.ga-autonomy .auto-task-card:active { transform: scale(0.985); }
.ga-autonomy .auto-task-card.selected {
  border-color: color-mix(in srgb, var(--gt-gold) 50%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 10%, transparent), color-mix(in srgb, var(--gt-gold) 3%, transparent));
}
.ga-autonomy .auto-task-card.selected::before,
.ga-autonomy .auto-task-card.running::before { background: var(--gt-gold); box-shadow: 0 0 10px var(--gt-gold); }
.ga-autonomy .auto-task-card.running { box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent), 0 0 0 1px color-mix(in srgb, var(--gt-gold) 18%, transparent); }
.ga-autonomy .auto-task-card.completed { opacity: 0.7; }
.ga-autonomy .auto-task-header { gap: 9px; margin-bottom: 6px; min-width: 0; }
.ga-autonomy .auto-task-header .gt-light { width: 7px; height: 7px; }
.ga-autonomy .auto-task-title { font-size: 13px; font-weight: 600; letter-spacing: -0.005em; color: var(--gt-fg); min-width: 0; }
.ga-autonomy .auto-task-meta { flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; }
.ga-autonomy .auto-task-priority {
  font: 600 9.5px/1 var(--ga-auto-mono);
  letter-spacing: 0.12em;
  padding: 4px 7px;
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  color: var(--gt-dim);
}
.ga-autonomy .auto-task-priority.critical { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 8%, transparent); }
.ga-autonomy .auto-task-priority.high { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); background: color-mix(in srgb, var(--warn) 8%, transparent); }
.ga-autonomy .auto-task-priority.normal,
.ga-autonomy .auto-task-priority.medium { color: var(--gt-gold-ink); border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); background: var(--gt-gold-faint); }
.ga-autonomy .auto-task-project,
.ga-autonomy .auto-task-runtime { color: var(--gt-faint); font-size: 11px; }
.ga-autonomy .auto-task-runtime { font-family: var(--ga-auto-mono); font-variant-numeric: tabular-nums; }
.ga-autonomy .auto-backend-badge {
  font-size: 10.5px;
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--gt-gold-ink);
  background: var(--gt-gold-faint);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 26%, transparent);
}
.ga-autonomy .auto-task-oversight { border-top: 1px solid var(--gt-line); margin-top: 10px; padding-top: 9px; gap: 5px; }
.ga-autonomy .auto-task-oversight-row { font-size: 11px; letter-spacing: 0; }
.ga-autonomy .auto-task-oversight-label { font: 600 9.5px/1.3 var(--ga-auto-mono); letter-spacing: 0.14em; color: var(--gt-faint); }
.ga-autonomy .auto-task-oversight-value { color: var(--gt-fg); font-weight: 550; }
.ga-autonomy .auto-task-oversight-value.gold,
.ga-autonomy .auto-oversight-cell-value.gold,
.ga-autonomy .auto-oversight-cell-value .gold { color: var(--gt-gold-ink); }
.ga-autonomy .auto-task-oversight-value.green,
.ga-autonomy .auto-oversight-cell-value.green { color: var(--ok); }
.ga-autonomy .auto-task-oversight-value.red,
.ga-autonomy .auto-oversight-cell-value.red,
.ga-autonomy .auto-oversight-cell-value .danger { color: var(--danger); }
.ga-autonomy .auto-task-oversight-value.muted,
.ga-autonomy .auto-oversight-cell-value.muted,
.ga-autonomy .auto-oversight-cell-value .muted { color: var(--gt-faint); }

/* Continuous loop daemon card */
.ga-autonomy .auto-task-card.auto-daemon-card::before { background: var(--gt-gold); }
.ga-autonomy .auto-daemon-card .auto-task-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ga-autonomy .auto-daemon-card .auto-task-card-title { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ga-autonomy .auto-daemon-card .auto-task-card-title svg { width: 13px; height: 13px; color: var(--gt-gold-ink); }
.ga-autonomy .auto-daemon-card .auto-task-card-meta { margin-top: 6px; font: 500 11px/1.4 var(--ga-auto-mono); color: var(--gt-dim); }
.ga-autonomy .auto-daemon-card .auto-daemon-fail { color: var(--danger); }
.ga-autonomy .auto-daemon-card .auto-task-card-actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }

/* ── Overview ───────────────────────────────────────────────── */
.ga-autonomy .auto-overview { gap: 16px; }
.ga-autonomy .auto-stats-row { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.ga-autonomy .auto-stat-card {
  position: relative;
  gap: 12px;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-well);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  transition: transform 360ms var(--gt-spring, var(--gt-ease)), border-color 220ms ease, box-shadow 360ms var(--gt-ease);
}
.ga-autonomy .auto-stat-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent), 0 14px 30px -18px color-mix(in srgb, var(--gt-gold) 45%, transparent);
}
.ga-autonomy .auto-stat-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  font-size: 14px;
  color: var(--gt-dim);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  box-shadow: inset 0 0 0 1px var(--gt-line);
}
.ga-autonomy .auto-stat-icon.gold {
  color: var(--gt-gold-ink);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 30%, transparent), color-mix(in srgb, var(--gt-gold) 6%, transparent) 70%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 32%, transparent);
}
.ga-autonomy .auto-stat-icon.green { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ok) 28%, transparent); }
.ga-autonomy .auto-stat-icon.red { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 28%, transparent); }
.ga-autonomy .auto-stat-content { min-width: 0; }
.ga-autonomy .auto-stat-value {
  font: 650 22px/1.05 var(--ga-auto-display);
  letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;
  color: var(--gt-fg);
}
.ga-autonomy .auto-stat-label { margin-top: 5px; font: 500 9.5px/1 var(--ga-auto-mono); letter-spacing: 0.16em; color: var(--gt-faint); }
.ga-autonomy .auto-section {
  border-radius: 14px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-well);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
}
.ga-autonomy .auto-section-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 6px;
  border-bottom: 0;
  font: 600 10px/1.2 var(--ga-auto-mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.ga-autonomy .auto-section-header::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 35%, transparent), transparent);
}
.ga-autonomy .auto-current-task { padding: 10px 16px 16px; }
.ga-autonomy .auto-current-title { font: 600 15px/1.35 var(--ga-auto-display); letter-spacing: -0.01em; color: var(--gt-fg); }
.ga-autonomy .auto-current-meta { align-items: center; }
.ga-autonomy .auto-current-desc { font-size: 13px; color: var(--gt-dim); line-height: 1.55; }
.ga-autonomy .auto-duration { font: 500 11.5px/1 var(--ga-auto-mono); color: var(--gt-dim); font-variant-numeric: tabular-nums; }
.ga-autonomy .auto-empty-section { padding: 18px 16px 20px; color: var(--gt-faint); font-size: 13px; }
.ga-autonomy .auto-system-grid { padding: 10px 16px 16px; gap: 12px; }
.ga-autonomy .auto-system-item { grid-template-columns: 48px 1fr 44px; }
.ga-autonomy .auto-system-label { font: 600 9.5px/1 var(--ga-auto-mono); letter-spacing: 0.16em; color: var(--gt-faint); }
.ga-autonomy .auto-system-value { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 550; }
.ga-autonomy .auto-system-value.active { color: var(--ok); }
.ga-autonomy .auto-system-value.idle { color: var(--warn); }
.ga-autonomy .auto-progress {
  height: 6px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--gt-fg) 8%, transparent);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.25);
}
.ga-autonomy .auto-progress-fill {
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 55%, transparent), var(--gt-gold));
  box-shadow: 0 0 10px color-mix(in srgb, var(--gt-gold) 45%, transparent);
  transition: width 600ms var(--gt-ease);
}
.ga-autonomy .auto-system-percent { font: 600 12px/1 var(--ga-auto-mono); color: var(--gt-fg); font-variant-numeric: tabular-nums; }
.ga-autonomy .auto-checklist { padding: 10px 16px 16px; gap: 8px; }
.ga-autonomy .auto-check-item { gap: 10px; font-size: 12.5px; color: var(--gt-fg); }
.ga-autonomy .auto-check-item .dim { color: var(--gt-faint); }
.ga-autonomy .auto-check {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 10px;
  flex: none;
}
.ga-autonomy .auto-check.gold { color: var(--glass-ink, #120c00); background: var(--gt-gold); }
.ga-autonomy .auto-check.pending { color: var(--gt-faint); box-shadow: inset 0 0 0 1px var(--gt-line); }

/* Tags */
.ga-autonomy .auto-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font: 500 10.5px/1 var(--glass-font, inherit);
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  color: var(--gt-dim);
}
.ga-autonomy .auto-tag.critical,
.ga-autonomy .auto-tag.fail { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, transparent); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
.ga-autonomy .auto-tag.high { color: var(--warn); background: color-mix(in srgb, var(--warn) 9%, transparent); border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
.ga-autonomy .auto-tag.medium,
.ga-autonomy .auto-tag.normal { color: var(--gt-gold-ink); background: var(--gt-gold-faint); border-color: color-mix(in srgb, var(--gt-gold) 28%, transparent); }
.ga-autonomy .auto-tag.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 9%, transparent); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.ga-autonomy .auto-tag.warn,
.ga-autonomy .auto-tag.pending { color: var(--warn); background: color-mix(in srgb, var(--warn) 9%, transparent); border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
.ga-autonomy .auto-tag.project { color: var(--gt-dim); background: color-mix(in srgb, var(--gt-fg) 5%, transparent); }
.ga-autonomy .auto-tag.queued { color: var(--gt-gold-ink); border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); }
.ga-autonomy .auto-tag.mono { font-family: var(--ga-auto-mono); }

/* ── Projects ───────────────────────────────────────────────── */
.ga-autonomy .auto-projects { gap: 12px; }
.ga-autonomy .auto-projects-toolbar {
  flex-wrap: wrap;
  gap: 10px;
  padding: 0 2px 4px;
  border: 0;
  background: none;
  font-size: 12.5px;
  letter-spacing: 0;
  color: var(--gt-dim);
}
.ga-autonomy .auto-projects-toolbar > div { flex-wrap: wrap; }
.ga-autonomy .auto-project-card {
  padding: 16px;
  border-radius: 14px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-well);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  transition: border-color 220ms ease, box-shadow 360ms var(--gt-ease);
}
.ga-autonomy .auto-project-card:hover { border-color: color-mix(in srgb, var(--gt-gold) 28%, transparent); }
.ga-autonomy .auto-project-head { flex-wrap: wrap; }
.ga-autonomy .auto-project-name { font: 600 14.5px/1.3 var(--ga-auto-display); letter-spacing: -0.01em; color: var(--gt-fg); flex-wrap: wrap; min-width: 0; }
.ga-autonomy .auto-project-stats { font: 500 11px/1 var(--ga-auto-mono); color: var(--gt-faint); }
.ga-autonomy .auto-project-stats .gold { color: var(--gt-gold-ink); }
.ga-autonomy .auto-project-desc { font-size: 12.5px; color: var(--gt-dim); line-height: 1.5; }
.ga-autonomy .auto-project-empty { font-size: 12px; color: var(--gt-faint); font-style: normal; }
.ga-autonomy .auto-project-task {
  padding: 10px 12px;
  border-radius: 11px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-sunk);
  transition: border-color 220ms ease, transform 300ms var(--gt-ease);
}
.ga-autonomy .auto-project-task:hover { border-color: color-mix(in srgb, var(--gt-gold) 28%, transparent); }
.ga-autonomy .auto-project-task-title { font-size: 13px; color: var(--gt-fg); font-weight: 500; }
.ga-autonomy .auto-project-more { font-size: 11.5px; color: var(--gt-faint); }

/* ── Detail panel ───────────────────────────────────────────── */
.ga-autonomy .auto-detail { gap: 12px; }
.ga-autonomy .auto-detail-title { font: 650 17px/1.3 var(--ga-auto-display); letter-spacing: -0.015em; color: var(--gt-fg); overflow-wrap: anywhere; }
.ga-autonomy .auto-detail-status {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 600 10px/1 var(--ga-auto-mono);
  letter-spacing: 0.14em;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  color: var(--gt-dim);
}
.ga-autonomy .auto-detail-status.in_progress,
.ga-autonomy .auto-detail-status.running { color: var(--gt-gold-ink); background: var(--gt-gold-faint); border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent); }
.ga-autonomy .auto-detail-status.completed,
.ga-autonomy .auto-detail-status.complete { color: var(--ok); background: color-mix(in srgb, var(--ok) 9%, transparent); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.ga-autonomy .auto-detail-status.blocked,
.ga-autonomy .auto-detail-status.failed { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, transparent); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
.ga-autonomy .auto-detail-section {
  padding: 12px 13px;
  border-radius: 12px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-well);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
.ga-autonomy .auto-detail-section.auto-prefire-toggle { padding-bottom: 12px; margin-bottom: 0; }
.ga-autonomy .auto-detail-label {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  font: 600 9.5px/1.3 var(--ga-auto-mono);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.ga-autonomy .auto-detail-label .auto-tag { margin-left: 2px; letter-spacing: 0.02em; text-transform: none; }
.ga-autonomy .auto-detail-text { font-size: 13px; color: var(--gt-fg); line-height: 1.55; overflow-wrap: anywhere; }
.ga-autonomy .auto-detail-text code {
  font-size: 11.5px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--ga-auto-sunk);
  border: 1px solid var(--gt-line);
}
.ga-autonomy .auto-detail-hint { font-size: 12px; color: var(--gt-faint); line-height: 1.5; }
.ga-autonomy .auto-detail-muted { color: var(--gt-faint); }
.ga-autonomy .auto-detail-warn { color: var(--warn); }
.ga-autonomy .auto-detail-btns { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.ga-autonomy .auto-detail-actions { gap: 8px; margin-top: 4px; padding-top: 14px; border-top: 1px solid var(--gt-line); }
.ga-autonomy .auto-oversight-grid { gap: 6px; }
.ga-autonomy .auto-oversight-cell {
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-sunk);
  min-width: 0;
}
.ga-autonomy .auto-oversight-cell-label { font: 600 9px/1.2 var(--ga-auto-mono); letter-spacing: 0.14em; color: var(--gt-faint); }
.ga-autonomy .auto-oversight-cell-value { font-size: 13px; font-weight: 600; color: var(--gt-fg); overflow-wrap: anywhere; }
.ga-autonomy .auto-session-key { font-size: 10.5px; color: var(--gt-dim); }
.ga-autonomy .auto-session-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.ga-autonomy .auto-session-row .auto-detail-hint { min-width: 56px; }
.ga-autonomy .auto-session-row .auto-session-key { flex: 1; min-width: 0; }
.ga-autonomy .auto-activity-feed::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--gt-gold) 22%, transparent); }
.ga-autonomy .auto-activity-entry {
  border-radius: 10px;
  border: 1px solid var(--gt-line);
  border-left: 2px solid var(--gt-faint);
  background: var(--ga-auto-sunk);
  padding: 9px 11px;
}
.ga-autonomy .auto-activity-entry.success { border-left-color: var(--ok); }
.ga-autonomy .auto-activity-entry.danger { border-left-color: var(--danger); }
.ga-autonomy .auto-activity-entry.warn { border-left-color: var(--warn); }
.ga-autonomy .auto-activity-icon.success,
.ga-autonomy .auto-activity-outcome.success { color: var(--ok); }
.ga-autonomy .auto-activity-icon.danger,
.ga-autonomy .auto-activity-outcome.danger { color: var(--danger); }
.ga-autonomy .auto-activity-icon.warn,
.ga-autonomy .auto-activity-outcome.warn { color: var(--warn); }
.ga-autonomy .auto-activity-icon.muted,
.ga-autonomy .auto-activity-outcome.muted { color: var(--gt-faint); }
.ga-autonomy .auto-activity-title { font-size: 12.5px; color: var(--gt-fg); text-transform: none; }
.ga-autonomy .auto-activity-title::first-letter { text-transform: uppercase; }
.ga-autonomy .auto-activity-time { font-family: var(--ga-auto-mono); color: var(--gt-faint); }
.ga-autonomy .auto-activity-outcome { font-family: var(--ga-auto-mono); border-radius: 999px; padding: 2px 7px; }
.ga-autonomy .auto-activity-detail,
.ga-autonomy .auto-activity-list li { color: var(--gt-dim); opacity: 1; }
.ga-autonomy .auto-activity-list li::before { color: var(--gt-gold); }
.ga-autonomy .auto-activity-sublabel { font-family: var(--ga-auto-mono); color: var(--gt-faint); }
.ga-autonomy .auto-outcome { border-radius: 10px; font-size: 12.5px; }
.ga-autonomy .auto-outcome.success { color: var(--ok); background: color-mix(in srgb, var(--ok) 9%, transparent); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.ga-autonomy .auto-outcome.error { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, transparent); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
.ga-autonomy .auto-iter-card {
  margin-top: 8px;
  padding: 10px 11px;
  border-radius: 10px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-sunk);
}
.ga-autonomy .auto-iter-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; color: var(--gt-fg); }
.ga-autonomy .auto-iter-card details { margin-top: 6px; }
.ga-autonomy .auto-iter-card summary { cursor: pointer; }
.ga-autonomy .auto-iter-card ul { margin: 4px 0 0 16px; padding: 0; }
.ga-autonomy .auto-target-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  margin-top: 6px;
  border-radius: 10px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-sunk);
}
.ga-autonomy .auto-prefire-check { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
.ga-autonomy .auto-prefire-check > span { font-size: 13px; font-weight: 600; color: var(--gt-fg); }
.ga-autonomy .auto-prefire-check .auto-prefire-skipped { font: 600 10px/1 var(--ga-auto-mono); letter-spacing: 0.12em; color: var(--ok); }
.ga-autonomy input[type="checkbox"] { accent-color: var(--gt-gold); }
.ga-autonomy .auto-prefire-dim { position: relative; pointer-events: none; opacity: 0.38; user-select: none; }
.ga-autonomy .auto-field-req { color: var(--danger); margin-left: 4px; }
.ga-autonomy .auto-detail-empty { padding: 8px 0; height: auto; }

/* ── Activity (audit + API) ─────────────────────────────────── */
.ga-autonomy .auto-v2-activity { gap: 16px; align-items: start; }
.ga-autonomy .auto-v2-activity > .auto-panel { min-width: 0; }
.ga-autonomy .auto-audit { gap: 12px; }
.ga-autonomy .auto-audit-header { flex-wrap: wrap; gap: 8px; justify-content: flex-start; }
.ga-autonomy .auto-audit-header > .auto-btn { margin-left: auto; }
.ga-autonomy .auto-chain-status,
.ga-autonomy .auto-cage-alert {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  font: 600 10.5px/1 var(--ga-auto-mono);
  letter-spacing: 0.14em;
}
.ga-autonomy .auto-chain-status.valid { color: var(--ok); background: color-mix(in srgb, var(--ok) 9%, transparent); border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent); }
.ga-autonomy .auto-chain-status.invalid,
.ga-autonomy .auto-cage-alert { color: var(--danger); background: color-mix(in srgb, var(--danger) 9%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); }
.ga-autonomy .auto-audit-toolbar { gap: 10px; padding: 0; }
.ga-autonomy .auto-audit-count { font: 500 11.5px/1 var(--ga-auto-mono); color: var(--gt-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ga-autonomy .auto-audit-list { gap: 0; border-radius: 12px; border: 1px solid var(--gt-line); background: var(--ga-auto-sunk); overflow: hidden; }
.ga-autonomy .auto-audit-list > .gt-empty { padding: 28px 16px; }
.ga-autonomy .auto-audit-entry {
  grid-template-columns: 54px minmax(110px, 160px) minmax(0, 1fr) auto;
  gap: 12px;
  padding: 11px 14px;
  border: 0;
  border-bottom: 1px solid var(--gt-line);
  border-radius: 0;
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  font-size: 12.5px;
  transition: background 200ms ease;
}
.ga-autonomy .auto-audit-entry:last-child { border-bottom: 0; }
.ga-autonomy .auto-audit-entry:hover { background: color-mix(in srgb, var(--gt-gold) 5%, transparent); }
.ga-autonomy .auto-audit-entry.cage { box-shadow: inset 2px 0 0 var(--danger); }
.ga-autonomy .auto-audit-time { font: 500 11.5px/1.3 var(--ga-auto-mono); color: var(--gt-faint); font-variant-numeric: tabular-nums; }
.ga-autonomy .auto-audit-type { font: 500 11.5px/1.3 var(--ga-auto-mono); color: var(--gt-gold-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ga-autonomy .auto-audit-desc { color: var(--gt-dim); min-width: 0; }
.ga-autonomy .auto-audit-outcome {
  justify-self: end;
  font: 600 9.5px/1 var(--ga-auto-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  color: var(--gt-dim);
}
.ga-autonomy .auto-audit-outcome:empty { display: none; }
.ga-autonomy .auto-audit-outcome.success { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 30%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent); }
.ga-autonomy .auto-audit-outcome.failure { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, transparent); background: color-mix(in srgb, var(--danger) 8%, transparent); }
.ga-autonomy .auto-audit-outcome.pending { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 30%, transparent); background: color-mix(in srgb, var(--warn) 8%, transparent); }
.ga-autonomy .auto-api { gap: 16px; }
.ga-autonomy .auto-api-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.ga-autonomy .auto-api-stat {
  text-align: left;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-well);
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
}
.ga-autonomy .auto-api-value { font: 650 24px/1.05 var(--ga-auto-display); letter-spacing: -0.025em; color: var(--gt-fg); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.ga-autonomy .auto-api-label { margin-top: 6px; font: 500 9.5px/1 var(--ga-auto-mono); letter-spacing: 0.16em; color: var(--gt-faint); }
.ga-autonomy .auto-usage-bar { height: 10px; margin: 10px 16px 0; border: 0; border-radius: 999px; background: color-mix(in srgb, var(--gt-fg) 8%, transparent); }
.ga-autonomy .auto-usage-fill.auto { border-radius: inherit; background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 55%, transparent), var(--gt-gold)); box-shadow: 0 0 12px color-mix(in srgb, var(--gt-gold) 45%, transparent); }
.ga-autonomy .auto-usage-legend { flex-wrap: wrap; gap: 6px 12px; margin: 10px 16px 16px; font-size: 12px; }
.ga-autonomy .auto-legend-item.auto { color: var(--gt-gold-ink); }
.ga-autonomy .auto-legend-item.interactive { color: var(--gt-faint); }

/* ── Settings ───────────────────────────────────────────────── */
.ga-autonomy .auto-v2-settings { max-width: 920px; }
.ga-autonomy .auto-v2-settings > .auto-panel-body { padding: 20px; }
.ga-autonomy .auto-settings-card-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font: 600 10.5px/1.2 var(--ga-auto-mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gt-gold-ink);
}
.ga-autonomy .auto-settings-card-title::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 40%, transparent), transparent); }
.ga-autonomy .auto-settings-card-desc { margin: 10px 0 16px; max-width: 62ch; font-size: 13.5px; line-height: 1.55; color: var(--gt-dim); }
.ga-autonomy .auto-settings-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
.ga-autonomy .auto-settings-chip {
  all: unset;
  box-sizing: border-box;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-well);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  cursor: pointer;
  transition: transform 360ms var(--gt-spring, var(--gt-ease)), border-color 220ms ease, box-shadow 360ms var(--gt-ease), background 220ms ease;
}
.ga-autonomy .auto-settings-chip:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent); box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent), 0 14px 32px -18px color-mix(in srgb, var(--gt-gold) 45%, transparent); }
.ga-autonomy .auto-settings-chip:active { transform: scale(0.985); }
.ga-autonomy .auto-settings-chip.active {
  border-color: color-mix(in srgb, var(--gt-gold) 55%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 14%, transparent), color-mix(in srgb, var(--gt-gold) 4%, transparent));
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 10%, transparent), 0 12px 30px -16px color-mix(in srgb, var(--gt-gold) 60%, transparent);
}
.ga-autonomy .auto-settings-chip.active::after {
  content: "";
  position: absolute;
  top: 14px; right: 14px;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--gt-gold);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--gt-gold) 18%, transparent), 0 0 12px var(--gt-gold);
}
.ga-autonomy .auto-settings-chip-title { font: 600 14px/1.3 var(--ga-auto-display); letter-spacing: -0.01em; color: var(--gt-fg); padding-right: 18px; }
.ga-autonomy .auto-settings-chip-sub { font-size: 12px; line-height: 1.45; color: var(--gt-dim); }
.ga-autonomy .auto-settings-current { margin-top: 16px; font-size: 12.5px; color: var(--gt-dim); }
.ga-autonomy .auto-settings-current strong { color: var(--gt-gold-ink); font-weight: 600; }

/* ── Inputs ─────────────────────────────────────────────────── */
.ga-autonomy .auto-input {
  min-height: 38px;
  padding: 8px 12px;
  border-radius: 11px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-sunk);
  color: var(--gt-fg);
  font: 13px/1.4 var(--glass-font, inherit);
  transition: border-color 200ms ease, box-shadow 260ms ease, background 200ms ease;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.ga-autonomy .auto-input::placeholder { color: var(--gt-faint); }
.ga-autonomy .auto-input:focus { border-color: color-mix(in srgb, var(--gt-gold) 55%, transparent); box-shadow: 0 0 0 4px var(--gt-gold-faint); }
.ga-autonomy .auto-textarea { min-height: 96px; line-height: 1.5; }
.ga-autonomy .auto-field { min-width: 0; }
.ga-autonomy .auto-field-label { font: 600 9.5px/1.2 var(--ga-auto-mono); letter-spacing: 0.16em; color: var(--gt-faint); }
.ga-autonomy .auto-field-check { font-size: 12.5px; color: var(--gt-dim); }
.ga-autonomy .auto-field-hint { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--gt-faint); }
.ga-autonomy .auto-field-hint.indent { margin-left: 26px; }
.ga-autonomy .auto-goal-toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.ga-autonomy .auto-goal-toggle > span { font-size: 13px; font-weight: 600; color: var(--gt-fg); }

/* ── Create-task modal ──────────────────────────────────────── */
.ga-autonomy.auto-dashboard > .auto-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  padding: 24px;
  overflow-y: auto;
  background: color-mix(in srgb, var(--glass-base, #000) 55%, transparent);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  animation: ga-auto-fade 220ms ease both;
}
.ga-autonomy .auto-modal {
  position: relative;
  width: min(600px, 100%);
  max-height: calc(100dvh - 48px);
  margin: auto;
  border: 0;
  border-radius: var(--glass-radius-xl, 22px);
  background: var(--glass-4, var(--gt-surface-solid));
  -webkit-backdrop-filter: blur(28px) saturate(170%);
  backdrop-filter: blur(28px) saturate(170%);
  box-shadow: var(--glass-elev-4, 0 30px 80px -20px rgba(0, 0, 0, 0.7));
  overflow: auto;
  animation: ga-auto-pop 420ms var(--gt-spring, var(--gt-ease)) both;
}
.ga-autonomy .auto-modal::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(140deg, var(--gt-gold-hair), transparent 40%, var(--gt-line) 60%, color-mix(in srgb, var(--gt-gold) 30%, transparent));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}
.ga-autonomy .auto-modal-header {
  padding: 20px 22px 6px;
  border-bottom: 0;
  font: 650 19px/1.2 var(--ga-auto-display);
  letter-spacing: -0.02em;
  color: var(--gt-fg);
}
.ga-autonomy .auto-modal-header .gt-eyebrow { display: flex; margin-bottom: 8px; }
.ga-autonomy .auto-modal-close {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  color: var(--gt-dim);
  transition: background 200ms ease, color 200ms ease, transform 160ms ease;
}
.ga-autonomy .auto-modal-close svg { width: 15px; height: 15px; }
.ga-autonomy .auto-modal-close:hover { color: var(--gt-fg); background: color-mix(in srgb, var(--gt-fg) 7%, transparent); }
.ga-autonomy .auto-modal-close:active { transform: scale(0.94); }
.ga-autonomy .auto-modal-body { padding: 14px 22px 8px; gap: 14px; }
.ga-autonomy .auto-modal-actions { padding: 14px 22px 22px; }
.ga-autonomy .auto-modal-actions .auto-btn { min-height: 38px; padding: 0 18px; font-size: 13px; }
.ga-autonomy .auto-mode-toggle { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
.ga-autonomy .auto-mode-chip {
  all: unset;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 13px;
  border-radius: 12px;
  border: 1px solid var(--gt-line);
  background: var(--ga-auto-well);
  cursor: pointer;
  transition: border-color 220ms ease, background 220ms ease, transform 160ms ease;
}
.ga-autonomy .auto-mode-chip:hover { border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent); }
.ga-autonomy .auto-mode-chip:active { transform: scale(0.98); }
.ga-autonomy .auto-mode-chip:focus-visible { box-shadow: var(--gt-focus); }
.ga-autonomy .auto-mode-chip.active {
  border-color: color-mix(in srgb, var(--gt-gold) 55%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 14%, transparent), color-mix(in srgb, var(--gt-gold) 4%, transparent));
}
.ga-autonomy .auto-mode-chip-title { font-size: 13px; font-weight: 600; color: var(--gt-fg); }
.ga-autonomy .auto-mode-chip-sub { font-size: 11.5px; color: var(--gt-dim); line-height: 1.4; }
@keyframes ga-auto-fade { from { opacity: 0; } }
@keyframes ga-auto-pop { from { opacity: 0; transform: translateY(12px) scale(0.98); } }

/* ── Loading / error / empty ────────────────────────────────── */
.ga-autonomy .ga-auto-skel-hero { display: grid; gap: 12px; padding: 18px 2px 4px; }
.ga-autonomy .ga-auto-skel-line { height: 12px; border-radius: 6px; }
.ga-autonomy .ga-auto-skel-title { height: 36px; width: 240px; max-width: 70%; border-radius: 10px; }
.ga-autonomy .ga-auto-skel-tabs { height: 48px; border-radius: 16px; }
.ga-autonomy .ga-auto-skel-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 16px; }
.ga-autonomy .ga-auto-skel-grid .gt-skel { height: 320px; border-radius: var(--gt-radius); }
.ga-autonomy .ga-auto-state { padding: 40px 16px; }
.ga-autonomy .ga-auto-state .gt-empty { padding: 56px 24px; }
.ga-autonomy .gt-empty .auto-btn,
.ga-autonomy .gt-empty .ga-auto-empty-actions { margin-top: 6px; }
.ga-autonomy .ga-auto-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.ga-autonomy .auto-panel .gt-empty { padding: 32px 12px; }
.ga-autonomy .auto-panel .gt-empty-orb { width: 52px; height: 52px; border-radius: 17px; }
.ga-autonomy .auto-panel .gt-empty-orb svg { width: 22px; height: 22px; }
.ga-autonomy .gt-empty-title { font-family: var(--ga-auto-display); letter-spacing: -0.01em; }

/* ── Fallbacks ──────────────────────────────────────────────── */
:root.perf-mode .ga-autonomy .auto-panel,
:root.perf-mode .ga-autonomy .auto-v2-nav,
:root.perf-mode .ga-autonomy .auto-modal { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--gt-surface-solid); }
:root.perf-mode .ga-autonomy.auto-dashboard > .auto-modal-backdrop { -webkit-backdrop-filter: none; backdrop-filter: none; }
@media (prefers-reduced-transparency: reduce) {
  .ga-autonomy .auto-panel,
  .ga-autonomy .auto-v2-nav,
  .ga-autonomy .auto-modal { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important; }
  .ga-autonomy.auto-dashboard > .auto-modal-backdrop { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
}
@media (prefers-reduced-motion: reduce) {
  .ga-autonomy .auto-task-card,
  .ga-autonomy .auto-stat-card,
  .ga-autonomy .auto-settings-chip,
  .ga-autonomy .auto-v2-tab,
  .ga-autonomy .auto-btn,
  .ga-autonomy .auto-v2-btn,
  .ga-autonomy .auto-progress-fill { transition: none !important; }
  .ga-autonomy .auto-task-card:hover,
  .ga-autonomy .auto-stat-card:hover,
  .ga-autonomy .auto-settings-chip:hover { transform: none; }
  .ga-autonomy .auto-modal,
  .ga-autonomy.auto-dashboard > .auto-modal-backdrop,
  .ga-autonomy .auto-v2-pill.running { animation: none !important; }
}

/* ── Responsive ─────────────────────────────────────────────── */
@media (max-width: 1200px) {
  .ga-autonomy.auto-v2 .auto-grid { grid-template-columns: minmax(230px, 260px) minmax(0, 1fr) minmax(250px, 290px); }
}
@media (max-width: 1080px) {
  .ga-autonomy.auto-v2 .auto-grid { grid-template-columns: minmax(230px, 280px) minmax(0, 1fr); }
  .ga-autonomy.auto-v2 .auto-grid > .auto-detail-panel { grid-column: 1 / -1; }
}
@media (max-width: 900px) {
  .ga-autonomy.auto-dashboard.auto-v2 { padding: 4px 14px 28px; gap: 14px; }
  .ga-autonomy.auto-v2 .auto-grid { grid-template-columns: minmax(0, 1fr); }
  .ga-autonomy .auto-grid .auto-panel-body { max-height: none; }
  .ga-autonomy .auto-v2-nav {
    -webkit-mask-image: linear-gradient(90deg, #000 85%, transparent);
    mask-image: linear-gradient(90deg, #000 85%, transparent);
  }
  .ga-autonomy .auto-v2-nav:has(.auto-v2-tab:last-child.on) { -webkit-mask-image: none; mask-image: none; }
}
@media (max-width: 640px) {
  .ga-autonomy .auto-v2-head.ga-auto-hero { padding-top: 10px; gap: 14px; }
  .ga-autonomy .ga-auto-hero .gt-sub { font-size: 13px; }
  .ga-autonomy .auto-v2-actions { width: 100%; flex-wrap: nowrap; min-width: 0; }
  .ga-autonomy .auto-v2-actions .auto-telegram-chip { flex: 1; min-width: 0; }
  .ga-autonomy .auto-telegram-label { max-width: none; flex: 1; }
  .ga-autonomy .auto-v2-actions > .auto-v2-btn { flex: 0 0 auto; }
  .ga-autonomy .auto-v2-nav { max-width: 100%; padding-bottom: 7px; }
  .ga-autonomy .auto-v2-tab { padding: 0 12px; }
  .ga-autonomy .auto-stats-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ga-autonomy .auto-stat-card { padding: 12px; gap: 10px; }
  .ga-autonomy .auto-stat-icon { width: 30px; height: 30px; border-radius: 10px; }
  .ga-autonomy .auto-stat-value { font-size: 19px; }
  .ga-autonomy .auto-checklist { grid-template-columns: minmax(0, 1fr); }
  .ga-autonomy .auto-audit-entry {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: "time type outcome" "desc desc desc";
    row-gap: 4px;
    padding: 11px 12px;
  }
  .ga-autonomy .auto-audit-time { grid-area: time; }
  .ga-autonomy .auto-audit-type { grid-area: type; }
  .ga-autonomy .auto-audit-desc { grid-area: desc; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .ga-autonomy .auto-audit-outcome { grid-area: outcome; }
  .ga-autonomy .auto-field-row,
  .ga-autonomy .auto-mode-toggle { grid-template-columns: minmax(0, 1fr); }
  .ga-autonomy.auto-dashboard > .auto-modal-backdrop { padding: 12px; align-items: flex-end; }
  .ga-autonomy .auto-modal { max-height: calc(100dvh - 24px); }
  .ga-autonomy .ga-auto-skel-grid { grid-template-columns: minmax(0, 1fr); }
  .ga-autonomy .auto-v2-settings > .auto-panel-body { padding: 16px 14px; }
}
`;
