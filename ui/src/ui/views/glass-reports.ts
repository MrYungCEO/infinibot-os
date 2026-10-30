/**
 * Premium glass layer for the Reports page (/reports): hero, tab bar,
 * Gallery, History (cards, preview / insights pane), Schedules and Triggers.
 *
 * Builds on the shared `.gt-*` / `.ga-*` primitives (glass-agents-shared.ts).
 * Every selector is scoped under `.ga-reports` (the page root) so nothing
 * leaks; the overlays rendered outside the root (associate picker, gallery
 * modals and toast) use their own `.rep-*` / `.rgal-*` classes, which only
 * this page renders.
 *
 * Colours come from tokens (--gt-*, --glass-*, --ok / --warn / --danger), so
 * light theme, reduced transparency, reduced motion and perf mode all follow.
 */

export const REPORTS_GLASS_CSS = /* css */ `
@keyframes rep-spin { to { transform: rotate(360deg); } }
@keyframes rep-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@keyframes rep-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes rgal-toast-in { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }

/* ── Root ─────────────────────────────────────────────────────── */
.ga-reports {
  --rep-gold: var(--gt-gold);
  --rep-danger: var(--danger, #ef4444);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--gt-fg);
  overflow: hidden;
}
.ga-reports .gt-aurora { height: 360px; }

/* ── Hero ─────────────────────────────────────────────────────── */
.ga-reports .rep-hero { flex-shrink: 0; padding: 22px 26px 0; }
.ga-reports .gt-hero { padding-bottom: 18px; align-items: flex-end; }
.ga-reports .gt-title { margin: 8px 0 4px; }
.ga-reports .gt-stats { align-items: stretch; }
.ga-reports .rep-stat-tile { display: flex; flex-direction: column; justify-content: center; }
.ga-reports .rep-stat-tile .gt-stat-value { display: inline-flex; align-items: center; gap: 8px; }
.ga-reports .rep-generate-wrap { position: relative; display: flex; align-items: center; }
.ga-reports .rep-generate-btn { height: 100%; min-height: 44px; padding: 0 18px; border-radius: 14px; }
.ga-reports .rep-kind-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 40;
  min-width: 232px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: var(--gt-radius-sm);
  background: var(--glass-4, var(--gt-surface-solid));
  -webkit-backdrop-filter: var(--gt-blur);
  backdrop-filter: var(--gt-blur);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 28%, transparent);
  box-shadow: var(--glass-elev-4, var(--gt-shadow));
  animation: rep-in 160ms var(--gt-ease);
}
.ga-reports .rep-kind-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; text-align: left; cursor: pointer;
  background: none; border: 1px solid transparent; border-radius: 9px;
  color: var(--gt-dim); font: 500 12.5px/1 var(--glass-font, inherit);
  padding: 10px 12px;
  transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
}
.ga-reports .rep-kind-item:hover:not(:disabled) { background: var(--gt-gold-faint); border-color: color-mix(in srgb, var(--gt-gold) 26%, transparent); color: var(--gt-fg); }
.ga-reports .rep-kind-item:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.ga-reports .rep-kind-item:disabled { opacity: 0.6; cursor: progress; }

/* Tab bar: one frosted pill rail, gold-tinted active pill. */
.ga-reports .rep-subtabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  margin-bottom: 16px;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  border-radius: 14px;
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  border: 1px solid var(--gt-line);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent);
}
.ga-reports .rep-subtabs::-webkit-scrollbar { display: none; }
.ga-reports .rep-subtab {
  all: unset;
  display: inline-flex; align-items: center; gap: 7px;
  flex-shrink: 0;
  padding: 8px 14px;
  border-radius: 10px;
  cursor: pointer;
  color: var(--gt-dim);
  font: 550 12.5px/1 var(--glass-font, inherit);
  transition: color 200ms ease, background 260ms var(--gt-ease), box-shadow 260ms ease, transform 160ms ease;
}
.ga-reports .rep-subtab svg { width: 14px; height: 14px; opacity: 0.8; }
.ga-reports .rep-subtab:hover { color: var(--gt-fg); background: color-mix(in srgb, var(--gt-fg) 5%, transparent); }
.ga-reports .rep-subtab:active { transform: scale(0.97); }
.ga-reports .rep-subtab:focus-visible { box-shadow: var(--gt-focus); }
.ga-reports .rep-subtab--active,
.ga-reports .rep-subtab--active:hover {
  color: var(--gt-fg);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 22%, transparent), color-mix(in srgb, var(--gt-gold) 8%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 40%, transparent), 0 6px 18px -8px color-mix(in srgb, var(--gt-gold) 60%, transparent);
}
.ga-reports .rep-subtab--active svg { color: var(--gt-gold-ink); opacity: 1; }
.ga-reports .rep-tab-count {
  min-width: 18px; padding: 2px 6px; border-radius: 999px;
  font: 600 10px/1.2 var(--mono); text-align: center;
  color: var(--gt-faint); background: color-mix(in srgb, var(--gt-fg) 7%, transparent);
}
.ga-reports .rep-subtab--active .rep-tab-count { color: var(--gt-gold-ink); background: var(--gt-gold-faint); }

/* ── Shared controls ───────────────────────────────────────── */
.ga-reports .rep-input,
.ga-reports .rep-search,
.ga-reports .rgal-search input,
.ga-reports .rgal-select {
  box-sizing: border-box;
  height: 36px;
  padding: 0 12px;
  border-radius: 11px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--bg, #050505) 55%, transparent);
  color: var(--gt-fg);
  font: 12.5px var(--glass-font, inherit);
  outline: none;
  transition: border-color 200ms ease, box-shadow 260ms ease;
}
:root[data-theme="light"] .ga-reports .rep-input,
:root[data-theme="light"] .ga-reports .rep-search,
:root[data-theme="light"] .ga-reports .rgal-search input,
:root[data-theme="light"] .ga-reports .rgal-select { background: rgba(255, 255, 255, 0.8); }
.ga-reports .rep-input { width: 100%; height: 32px; padding: 0 10px; font-size: 12px; }
.ga-reports .rep-input--sm { width: auto; min-width: 140px; height: 36px; }
.ga-reports .rep-input--mono { font-family: var(--mono); }
.ga-reports select.rep-input, .ga-reports .rgal-select { cursor: pointer; }
.ga-reports select option { background: var(--glass-solid, #161616); color: var(--gt-fg); }
.ga-reports .rep-input:focus,
.ga-reports .rep-search:focus,
.ga-reports .rgal-search input:focus,
.ga-reports .rgal-select:focus { border-color: color-mix(in srgb, var(--gt-gold) 55%, transparent); box-shadow: 0 0 0 4px var(--gt-gold-faint); }
.ga-reports .rep-search::placeholder,
.ga-reports .rgal-search input::placeholder { color: var(--gt-faint); }
.ga-reports .rep-search-wrap,
.ga-reports .rgal-search { position: relative; display: flex; align-items: center; }
.ga-reports .rep-search-icon,
.ga-reports .rgal-search svg { position: absolute; left: 12px; color: var(--gt-faint); display: flex; pointer-events: none; }
.ga-reports .rep-search,
.ga-reports .rgal-search input { width: 100%; padding-left: 34px; }

/* Chips (kind / category filters) */
.ga-reports .rep-chip-row,
.ga-reports .rgal-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ga-reports .rep-chip,
.ga-reports .rgal-chip {
  height: 30px; padding: 0 13px;
  border-radius: 999px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  color: var(--gt-dim);
  font: 550 12px/1 var(--glass-font, inherit);
  cursor: pointer;
  transition: color 180ms ease, border-color 180ms ease, background 220ms ease, transform 160ms ease, box-shadow 260ms ease;
}
.ga-reports .rep-chip:hover,
.ga-reports .rgal-chip:hover { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent); }
.ga-reports .rep-chip:active,
.ga-reports .rgal-chip:active { transform: scale(0.96); }
.ga-reports .rep-chip:focus-visible,
.ga-reports .rgal-chip:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.ga-reports .rep-chip--active,
.ga-reports .rgal-chip.is-active {
  color: var(--gt-fg);
  border-color: color-mix(in srgb, var(--gt-gold) 45%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 22%, transparent), color-mix(in srgb, var(--gt-gold) 8%, transparent));
  box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--gt-gold) 60%, transparent);
}

/* Buttons (shared .rep-btn / .rgal-btn system) */
.ga-reports .rep-btn,
.ga-reports .rgal-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 13px;
  border-radius: 10px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 5%, transparent);
  color: var(--gt-fg);
  font: 550 12px/1 var(--glass-font, inherit);
  white-space: nowrap;
  cursor: pointer;
  transition: transform 160ms ease, background 220ms ease, border-color 220ms ease, box-shadow 260ms ease, filter 200ms ease;
}
.ga-reports .rep-btn svg, .ga-reports .rgal-btn svg { width: 13px; height: 13px; flex-shrink: 0; }
.ga-reports .rep-btn:hover:not(:disabled),
.ga-reports .rgal-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--gt-fg) 9%, transparent); border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent); }
.ga-reports .rep-btn:active:not(:disabled),
.ga-reports .rgal-btn:active:not(:disabled) { transform: scale(0.97); }
.ga-reports .rep-btn:focus-visible,
.ga-reports .rgal-btn:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.ga-reports .rep-btn:disabled, .ga-reports .rgal-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ga-reports .rep-btn--primary {
  color: var(--glass-ink, #120c00);
  border-color: transparent;
  background: var(--glass-gold-fill, linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 80%, #fff 20%), var(--gt-gold) 55%, color-mix(in srgb, var(--gt-gold) 80%, #7a4b00 20%)));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 8px 22px -8px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.ga-reports .rep-btn--primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--glass-gold-fill, var(--gt-gold)); border-color: transparent; }
.ga-reports .rep-btn--danger { color: #fff; border-color: transparent; background: color-mix(in srgb, var(--rep-danger) 85%, transparent); }
.ga-reports .rep-btn--danger:hover:not(:disabled) { background: var(--rep-danger); border-color: transparent; }
.ga-reports .rep-btn--danger-ghost,
.ga-reports .rgal-btn--danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 32%, transparent); background: var(--danger-subtle, transparent); }
.ga-reports .rep-btn--danger-ghost:hover:not(:disabled),
.ga-reports .rgal-btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 18%, transparent); border-color: var(--danger); }
.ga-reports .rgal-btn--ghost { background: none; color: var(--gt-dim); }
.ga-reports .rep-btn--loading { opacity: 0.85; cursor: progress; }
.ga-reports .rep-btn-spin {
  width: 11px; height: 11px; flex-shrink: 0; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: rep-spin 0.7s linear infinite;
}

/* Icon buttons */
.ga-reports .rgal-ico, .rgal-overlay .rgal-ico,
.ga-reports .rep-preview-iconbtn,
.ga-reports .rgal-dir {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; flex-shrink: 0;
  border-radius: 9px;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
  color: var(--gt-dim);
  cursor: pointer; text-decoration: none;
  font-size: 13px;
  transition: color 160ms ease, border-color 200ms ease, background 200ms ease, transform 160ms ease;
}
.ga-reports .rgal-dir { width: 36px; height: 36px; border-radius: 11px; color: var(--gt-gold-ink); font-size: 15px; }
.ga-reports .rgal-ico:hover:not(:disabled), .rgal-overlay .rgal-ico:hover:not(:disabled),
.ga-reports .rep-preview-iconbtn:hover,
.ga-reports .rgal-dir:hover { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 36%, transparent); background: var(--gt-gold-faint); }
.ga-reports .rgal-ico:active:not(:disabled), .rgal-overlay .rgal-ico:active,
.ga-reports .rgal-dir:active { transform: scale(0.92); }
.ga-reports .rgal-ico:focus-visible, .rgal-overlay .rgal-ico:focus-visible,
.ga-reports .rgal-dir:focus-visible,
.ga-reports .rep-preview-iconbtn:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.ga-reports .rgal-ico:disabled { opacity: 0.5; cursor: progress; }
.ga-reports .rgal-ico.is-busy { color: var(--gt-gold-ink); border-color: color-mix(in srgb, var(--gt-gold) 36%, transparent); }
.ga-reports .rgal-ico.is-busy:disabled svg { animation: rep-spin 0.8s linear infinite; }
.ga-reports .rgal-ico--danger { color: #fff; background: color-mix(in srgb, var(--danger) 85%, transparent); border-color: transparent; }
.ga-reports .rgal-ico--danger:hover:not(:disabled) { color: #fff; background: var(--danger); border-color: transparent; }
.ga-reports .rgal-ico--danger-ghost:hover:not(:disabled) { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); border-color: color-mix(in srgb, var(--danger) 50%, transparent); }

/* Spinners */
.ga-reports .rep-preview-spin, .ga-reports .rgal-spin, .rgal-overlay .rgal-spin {
  width: 20px; height: 20px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--gt-gold) 22%, transparent);
  border-top-color: var(--gt-gold);
  animation: rep-spin 0.7s linear infinite;
}
.ga-reports .rep-preview-spin--sm { width: 12px; height: 12px; border-width: 1.5px; }

/* ── Gallery ──────────────────────────────────────────────── */
.ga-reports .rep-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.ga-reports .rgal {
  display: flex; flex-direction: column; flex: 1; min-height: 0;
  overflow-y: auto;
  padding: 0 26px 28px;
  scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--gt-gold) 25%, transparent) transparent;
}
.ga-reports .rgal-bar,
.ga-reports .rep-filters {
  position: relative;
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
  padding: 12px 14px;
  margin-bottom: 18px;
}
.ga-reports .rgal-bar { position: sticky; top: 0; z-index: 6; }
.ga-reports .rgal-controls,
.ga-reports .rep-filter-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ga-reports .rgal-search { width: 260px; }
.ga-reports .rep-search-wrap { flex: 1; min-width: 200px; max-width: 340px; }

.ga-reports .rgal-bulk {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  margin: -6px 0 18px; padding: 10px 14px;
  border-radius: var(--gt-radius-sm);
  background: linear-gradient(92deg, color-mix(in srgb, var(--gt-gold) 14%, transparent), color-mix(in srgb, var(--gt-gold) 4%, transparent));
  border: 1px solid color-mix(in srgb, var(--gt-gold) 32%, transparent);
  animation: rep-in 180ms var(--gt-ease);
}
.ga-reports .rgal-bulk-count { display: inline-flex; align-items: center; gap: 8px; font: 600 12px/1 var(--mono); color: var(--gt-gold-ink); }
.ga-reports .rgal-bulk-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.ga-reports .rgal-select--sm { height: 32px; font-size: 12px; }

.ga-reports .rgal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
.ga-reports .rgal-card {
  position: relative;
  display: flex; flex-direction: column;
  border-radius: var(--gt-radius);
  overflow: hidden;
  background: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  border: 1px solid var(--gt-line);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent), 0 10px 30px -18px rgba(0, 0, 0, 0.6);
  transition: transform 420ms var(--gt-ease), border-color 220ms ease, box-shadow 420ms var(--gt-ease);
}
:root[data-theme="light"] .ga-reports .rgal-card { background: rgba(255, 255, 255, 0.72); box-shadow: inset 0 1px 0 #fff, 0 10px 28px -16px rgba(24, 24, 27, 0.22); }
.ga-reports .rgal-card:hover { transform: translateY(-4px); border-color: color-mix(in srgb, var(--gt-gold) 36%, transparent); box-shadow: var(--gt-shadow-hover); }
.ga-reports .rgal-card.is-selected { border-color: color-mix(in srgb, var(--gt-gold) 60%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--gt-gold) 45%, transparent), var(--gt-shadow-hover); }
.ga-reports .rgal-check { position: absolute; top: 10px; left: 10px; z-index: 3; }
.ga-reports .rgal-check input { width: 17px; height: 17px; accent-color: var(--gt-gold); cursor: pointer; filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.5)); }
.ga-reports .rgal-thumb { position: relative; cursor: pointer; overflow: hidden; }
.ga-reports .rgal-thumb::after {
  content: ""; position: absolute; inset: auto 0 0; height: 40%;
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--glass-base, #000) 35%, transparent));
  pointer-events: none; opacity: 0; transition: opacity 260ms ease;
}
.ga-reports .rgal-card:hover .rgal-thumb::after { opacity: 1; }
.ga-reports .rgal-badges { position: absolute; top: 9px; right: 9px; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; z-index: 2; }
.ga-reports .rgal-badge {
  display: inline-flex; align-items: center; gap: 5px;
  font: 600 9px/1.3 var(--mono); letter-spacing: 0.08em;
  padding: 3px 8px 3px 7px; border-radius: 999px;
  color: var(--bc);
  background: color-mix(in srgb, var(--bc) 16%, var(--glass-solid, #0b0b0d));
  border: 1px solid color-mix(in srgb, var(--bc) 40%, transparent);
}
.ga-reports .rgal-badge::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; box-shadow: 0 0 6px currentColor; }
.ga-reports .rgal-info { padding: 12px 14px 8px; }
.ga-reports .rgal-title { font: 600 13px/1.35 var(--glass-font, inherit); letter-spacing: -0.005em; color: var(--gt-fg); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ga-reports .rgal-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 6px; font: 10.5px/1.4 var(--mono); color: var(--gt-faint); }
.ga-reports .rgal-cat { color: var(--gt-gold-ink); }
.ga-reports .rgal-ver {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 1px 8px; border-radius: 999px; font-weight: 600;
  color: var(--gt-gold-ink); background: var(--gt-gold-faint);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 40%, transparent);
}
.ga-reports .rgal-ver-tl { display: flex; align-items: center; margin-top: 7px; }
.ga-reports .rgal-ver-line { width: 18px; height: 2px; background: linear-gradient(90deg, var(--gt-line), color-mix(in srgb, var(--gt-gold) 45%, transparent)); }
.ga-reports .rgal-ver-dot {
  width: 9px; height: 9px; border-radius: 50%; cursor: pointer; flex-shrink: 0;
  background: var(--glass-solid, #15151c); border: 2px solid color-mix(in srgb, var(--gt-fg) 22%, transparent);
  transition: transform 260ms var(--glass-spring, var(--gt-ease)), border-color 160ms ease;
}
.ga-reports .rgal-ver-dot:hover { border-color: var(--gt-gold); transform: scale(1.25); }
.ga-reports .rgal-ver-dot.is-current { width: 12px; height: 12px; border-color: var(--gt-gold); background: color-mix(in srgb, var(--gt-gold) 40%, var(--glass-solid, #15151c)); box-shadow: 0 0 8px color-mix(in srgb, var(--gt-gold) 55%, transparent); }
.ga-reports .rgal-actions { display: flex; align-items: center; gap: 4px; padding: 8px 10px 10px; border-top: 1px solid var(--gt-line); }
.ga-reports .rgal-spacer { flex: 1; }
.ga-reports .rgal-recat { position: relative; }
.ga-reports .rgal-recat-menu {
  position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 20;
  min-width: 170px; max-height: 240px; overflow-y: auto;
  padding: 5px; display: flex; flex-direction: column; gap: 1px;
  border-radius: var(--gt-radius-sm);
  background: var(--glass-4, var(--gt-surface-solid));
  -webkit-backdrop-filter: var(--gt-blur); backdrop-filter: var(--gt-blur);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 28%, transparent);
  box-shadow: var(--glass-elev-4, var(--gt-shadow));
  animation: rep-in 140ms var(--gt-ease);
}
.ga-reports .rgal-recat-item { text-align: left; background: none; border: 1px solid transparent; border-radius: 8px; color: var(--gt-dim); font: 12px/1 var(--glass-font, inherit); padding: 8px 10px; cursor: pointer; transition: background 140ms ease, color 140ms ease; }
.ga-reports .rgal-recat-item:hover { background: var(--gt-gold-faint); color: var(--gt-fg); }
.ga-reports .rgal-recat-item.is-cur { color: var(--gt-gold-ink); }

.ga-reports .rgal-skel { border-radius: var(--gt-radius); overflow: hidden; border: 1px solid var(--gt-line); padding-bottom: 14px; background: color-mix(in srgb, var(--gt-fg) 2.5%, transparent); }
.ga-reports .rgal-skel-thumb { aspect-ratio: 1 / 1.32; border-radius: 0; }
.ga-reports .rgal-skel-line { height: 11px; margin: 12px 14px 0; }
.ga-reports .rgal-skel-line--sm { height: 9px; }

/* ── History ──────────────────────────────────────────────── */
.ga-reports .rep-history { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0 26px 22px; }
.ga-reports .rep-filters { flex-shrink: 0; }
.ga-reports .rep-history-body { flex: 1; min-height: 0; display: flex; gap: 16px; overflow: hidden; }
.ga-reports .rep-history-body--split .rep-list-pane { flex: 0 0 46%; max-width: 46%; }
.ga-reports .rep-list-pane { flex: 1; min-width: 0; overflow-y: auto; padding: 2px 4px 8px 2px; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--gt-gold) 25%, transparent) transparent; }
.ga-reports .rep-right-pane { flex: 1; min-width: 0; display: flex; overflow: hidden; padding: 0; }
.ga-reports .rep-list { display: flex; flex-direction: column; gap: 10px; }

.ga-reports .rep-card {
  position: relative; overflow: hidden;
  border-radius: var(--gt-radius-sm);
  background: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  border: 1px solid var(--gt-line);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
  transition: transform 360ms var(--gt-ease), border-color 220ms ease, box-shadow 360ms var(--gt-ease), background 220ms ease;
  animation: rep-in 260ms var(--gt-ease);
}
:root[data-theme="light"] .ga-reports .rep-card { background: rgba(255, 255, 255, 0.7); }
.ga-reports .rep-card::before {
  content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 0 3px 3px 0;
  background: var(--rep-color, var(--gt-gold)); box-shadow: 0 0 10px var(--rep-color, var(--gt-gold));
  opacity: 0.85;
}
.ga-reports .rep-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent); box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent), 0 14px 34px -18px color-mix(in srgb, var(--gt-gold) 45%, transparent); }
.ga-reports .rep-card--expanded { border-color: color-mix(in srgb, var(--gt-gold) 34%, transparent); }
.ga-reports .rep-card--selected { border-color: color-mix(in srgb, var(--gt-gold) 60%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--gt-gold) 40%, transparent), 0 14px 34px -18px color-mix(in srgb, var(--gt-gold) 55%, transparent); }
.ga-reports .rep-card-main { display: flex; align-items: center; gap: 10px; padding: 13px 16px 13px 20px; cursor: pointer; min-width: 0; }
.ga-reports .rep-card-main:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--gt-gold) 60%, transparent); border-radius: var(--gt-radius-sm); }
.ga-reports .rep-status-pill {
  display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
  font: 600 9px/1.4 var(--mono); letter-spacing: 0.1em;
  padding: 3px 9px; border: 1px solid; border-radius: 999px;
}
.ga-reports .rep-pulse { width: 6px; height: 6px; border-radius: 50%; animation: rep-pulse 1.1s ease-in-out infinite; }
.ga-reports .rep-title { flex: 1; min-width: 0; font: 600 13.5px/1.3 var(--glass-font, inherit); letter-spacing: -0.005em; color: var(--gt-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ga-reports .rep-kind-badge,
.ga-reports .rep-theme-badge {
  flex-shrink: 0; white-space: nowrap;
  font: 500 10.5px/1 var(--mono); letter-spacing: 0.02em;
  padding: 4px 9px; border-radius: 999px;
}
.ga-reports .rep-kind-badge { color: var(--gt-gold-ink); background: var(--gt-gold-faint); border: 1px solid color-mix(in srgb, var(--gt-gold) 30%, transparent); }
.ga-reports .rep-theme-badge { color: var(--gt-dim); background: color-mix(in srgb, var(--gt-fg) 5%, transparent); border: 1px solid var(--gt-line); }
.ga-reports .rep-insights-badge { display: inline-flex; align-items: center; gap: 3px; flex-shrink: 0; font: 600 10.5px/1 var(--mono); color: var(--gt-gold-ink); }
.ga-reports .rep-meta { flex-shrink: 0; white-space: nowrap; font: 10.5px/1 var(--mono); color: var(--gt-faint); font-variant-numeric: tabular-nums; }
.ga-reports .rep-meta--size { min-width: 54px; text-align: right; }
.ga-reports .rep-chev { flex-shrink: 0; display: flex; color: var(--gt-faint); transition: transform 300ms var(--gt-ease); }
.ga-reports .rep-card-detail { border-top: 1px solid var(--gt-line); padding: 14px 16px 16px 20px; animation: rep-in 220ms var(--gt-ease); }
.ga-reports .rep-detail-section { margin-bottom: 12px; }
.ga-reports .rep-detail-label { margin-bottom: 6px; font: 600 9.5px/1 var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--gt-gold-ink); }
.ga-reports .rep-summary { margin: 0; font-size: 13px; line-height: 1.6; color: var(--gt-dim); }
.ga-reports .rep-summary--empty { color: var(--gt-faint); font-style: italic; }
.ga-reports .rep-detail-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.ga-reports .rep-stat { font: 10.5px/1 var(--mono); color: var(--gt-dim); padding: 6px 10px; border-radius: 999px; background: color-mix(in srgb, var(--gt-fg) 4%, transparent); border: 1px solid var(--gt-line); }
.ga-reports .rep-stat b { color: var(--gt-gold-ink); font-weight: 600; margin-right: 5px; }
.ga-reports .rep-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.ga-reports .rep-actions-spacer { flex: 1; }
.ga-reports .rep-confirm-text { font-size: 12px; font-weight: 600; color: var(--danger); }

/* Preview / insights pane: one frosted surface. */
.ga-reports .rep-preview {
  position: relative;
  display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0;
  overflow: hidden;
  border-radius: var(--gt-radius);
  background: var(--gt-surface);
  -webkit-backdrop-filter: var(--gt-blur); backdrop-filter: var(--gt-blur);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 22%, transparent);
  box-shadow: var(--gt-shadow);
}
.ga-reports .rep-preview-bar { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--gt-line); }
.ga-reports .rep-preview-title { display: inline-flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 13px/1.3 var(--glass-font, inherit); color: var(--gt-fg); }
.ga-reports .rep-preview-title svg { color: var(--gt-gold-ink); flex-shrink: 0; }
.ga-reports .rep-preview-bar-actions { display: flex; gap: 6px; flex-shrink: 0; }
.ga-reports .rep-preview-body { flex: 1; min-height: 0; position: relative; background: color-mix(in srgb, var(--glass-base, #050505) 40%, transparent); }
.ga-reports .rep-preview-frame { width: 100%; height: 100%; border: none; background: #fff; }
.ga-reports .rep-preview-state { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; color: var(--gt-dim); font-size: 13px; }
.ga-reports .rep-preview-state .gt-empty { padding: 0; }
.ga-reports .rep-preview-state-sub { font-size: 11.5px; color: var(--gt-faint); max-width: 300px; }
.ga-reports .rep-insights-body { overflow-y: auto; padding: 14px; background: none; }
.ga-reports .rep-insights-stack { display: flex; flex-direction: column; gap: 10px; }
.ga-reports .rep-insight-card {
  position: relative; overflow: hidden;
  padding: 13px 15px 13px 18px;
  border-radius: var(--gt-radius-sm);
  background: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  border: 1px solid var(--gt-line);
}
.ga-reports .rep-insight-card::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0; background: var(--ins-color, var(--gt-gold)); box-shadow: 0 0 10px var(--ins-color, var(--gt-gold)); }
.ga-reports .rep-insight-head { display: flex; align-items: center; gap: 9px; margin-bottom: 7px; flex-wrap: wrap; }
.ga-reports .rep-insight-kind { flex-shrink: 0; font: 600 9px/1.4 var(--mono); letter-spacing: 0.1em; padding: 2px 8px; border-radius: 999px; color: var(--ins-color); border: 1px solid color-mix(in srgb, var(--ins-color) 40%, transparent); background: color-mix(in srgb, var(--ins-color) 10%, transparent); }
.ga-reports .rep-insight-title { flex: 1; min-width: 0; font: 600 13px/1.35 var(--glass-font, inherit); color: var(--gt-fg); }
.ga-reports .rep-insight-sev { font: 10px/1 var(--mono); color: var(--gt-faint); }
.ga-reports .rep-insight-body { margin: 0 0 8px; font-size: 12.5px; line-height: 1.55; color: var(--gt-dim); }
.ga-reports .rep-insight-action { font-size: 12px; line-height: 1.5; color: var(--gt-dim); padding: 8px 11px; border-radius: 10px; background: var(--gt-gold-faint); border: 1px solid color-mix(in srgb, var(--gt-gold) 22%, transparent); }
.ga-reports .rep-insight-action b { color: var(--gt-gold-ink); margin-right: 5px; }

.ga-reports .rep-skel-row { display: flex; align-items: center; gap: 12px; padding: 0 18px; height: 50px; margin-bottom: 10px; border-radius: var(--gt-radius-sm); border: 1px solid var(--gt-line); }
.ga-reports .rep-skel-pill { width: 64px; height: 18px; border-radius: 999px; flex-shrink: 0; }
.ga-reports .rep-skel-line { height: 11px; border-radius: 6px; }
.ga-reports .rep-error-title { color: var(--danger); }

/* ── Schedules / Triggers ─────────────────────────────────── */
.ga-reports .rep-sub { flex: 1; min-height: 0; overflow-y: auto; padding: 0 26px 26px; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--gt-gold) 25%, transparent) transparent; }
.ga-reports .rep-sub-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.ga-reports .rep-sub-title { margin: 0 0 4px; font: 600 17px/1.2 var(--glass-font, inherit); letter-spacing: -0.015em; color: var(--gt-fg); }
.ga-reports .rep-sub-desc { margin: 0; max-width: 60ch; font-size: 12.5px; line-height: 1.55; color: var(--gt-dim); }
.ga-reports .rep-inline-error { margin-bottom: 12px; padding: 9px 13px; border-radius: 11px; font-size: 12px; color: var(--danger); background: var(--danger-subtle, transparent); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); }
.ga-reports .rep-table { padding: 6px; }
.ga-reports .rep-trow { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; transition: background 200ms ease; }
.ga-reports .rep-trow + .rep-trow { box-shadow: 0 -1px 0 var(--gt-line); }
.ga-reports .rep-trow:not(.rep-trow--head):hover { background: color-mix(in srgb, var(--gt-fg) 3.5%, transparent); }
.ga-reports .rep-trow--head { padding-top: 10px; padding-bottom: 10px; font: 600 9.5px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--gt-faint); }
.ga-reports .rep-trow--head span { white-space: nowrap; }
.ga-reports .rep-trow--editing,
.ga-reports .rep-trow--editing:hover { background: var(--gt-gold-faint); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 26%, transparent); }
.ga-reports .rep-cell { flex: var(--f, 1) 1 0; min-width: 0; }
.ga-reports .rep-cell--on { flex: 0 0 46px; }
.ga-reports .rep-cell--actions { flex: 0 0 168px; display: flex; gap: 6px; justify-content: flex-end; }
.ga-reports .rep-trow--head .rep-cell--actions { text-align: right; display: block; }
.ga-reports .rep-cell-strong { font-size: 13px; font-weight: 600; color: var(--gt-fg); }
.ga-reports .rep-cell-dim { font: 11px/1.3 var(--mono); color: var(--gt-dim); font-variant-numeric: tabular-nums; }
.ga-reports .rep-cron { font: 11.5px/1 var(--mono); color: var(--gt-gold-ink); background: var(--gt-gold-faint); border: 1px solid color-mix(in srgb, var(--gt-gold) 24%, transparent); border-radius: 8px; padding: 4px 8px; }
.ga-reports .rep-sinks-cell { display: flex; gap: 5px; flex-wrap: wrap; }
.ga-reports .rep-sink-chip {
  font: 550 11px/1 var(--glass-font, inherit); color: var(--gt-faint);
  background: color-mix(in srgb, var(--gt-fg) 4%, transparent); border: 1px solid var(--gt-line);
  border-radius: 999px; padding: 5px 10px; cursor: pointer;
  transition: color 160ms ease, background 200ms ease, border-color 200ms ease, transform 160ms ease;
}
.ga-reports .rep-sink-chip:not(:disabled):hover { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 32%, transparent); }
.ga-reports .rep-sink-chip:not(:disabled):active { transform: scale(0.95); }
.ga-reports .rep-sink-chip:disabled { cursor: default; }
.ga-reports .rep-sink-chip--on { color: var(--gt-gold-ink); background: var(--gt-gold-faint); border-color: color-mix(in srgb, var(--gt-gold) 40%, transparent); }
.ga-reports .rep-toggle {
  position: relative; width: 38px; height: 22px; padding: 0;
  border-radius: 999px; cursor: pointer;
  border: 1px solid var(--gt-line);
  background: color-mix(in srgb, var(--gt-fg) 9%, transparent);
  transition: background 260ms var(--gt-ease), border-color 200ms ease, box-shadow 260ms ease;
}
.ga-reports .rep-toggle:focus-visible { outline: none; box-shadow: var(--gt-focus); }
.ga-reports .rep-toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--gt-fg); opacity: 0.75;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  transition: transform 360ms var(--glass-spring, var(--gt-ease)), background 200ms ease, opacity 200ms ease;
}
.ga-reports .rep-toggle--on { border-color: transparent; background: var(--glass-gold-fill, var(--gt-gold)); box-shadow: 0 0 14px -2px color-mix(in srgb, var(--gt-gold) 60%, transparent); }
.ga-reports .rep-toggle--on .rep-toggle-knob { transform: translateX(16px); background: #fff; opacity: 1; }

/* ── Overlays (rendered as siblings of the page root) ─────── */
.rep-assoc-scrim,
.rgal-overlay.rgal-modal-scrim {
  position: fixed; inset: 0; z-index: 120;
  display: flex; align-items: center; justify-content: center; padding: 28px;
  background: color-mix(in srgb, var(--glass-base, #040404) 70%, transparent);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  animation: rep-in 160ms var(--gt-ease);
}
.rep-assoc-modal,
.rgal-overlay .rgal-modal {
  position: relative;
  width: min(720px, 94vw); max-height: 86vh;
  display: flex; flex-direction: column; overflow: hidden;
  border-radius: var(--gt-radius);
  background: var(--glass-4, var(--gt-surface-solid));
  border: 1px solid color-mix(in srgb, var(--gt-gold) 26%, transparent);
  box-shadow: var(--glass-elev-4, 0 30px 80px rgba(0, 0, 0, 0.6));
  color: var(--gt-fg);
}
.rep-assoc-modal { width: min(520px, calc(100vw - 32px)); max-height: min(70vh, 620px); overflow: auto; padding: 14px 16px 16px; }
.rgal-overlay .rgal-modal--wide { width: min(1040px, 96vw); height: 86vh; }
.rep-assoc-bar,
.rgal-overlay .rgal-modal-bar { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.rep-assoc-bar { margin-bottom: 6px; }
.rgal-overlay .rgal-modal-bar { padding: 12px 14px 12px 18px; border-bottom: 1px solid var(--gt-line); }
.rep-assoc-title,
.rgal-overlay .rgal-modal-title { flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 8px; font: 600 14px/1.3 var(--glass-font, inherit); color: var(--gt-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rgal-overlay .rgal-modal-title svg { color: var(--gt-gold-ink); flex-shrink: 0; }
.rgal-overlay .rgal-modal-body { flex: 1; min-height: 0; overflow: auto; }
.rgal-overlay .rgal-modal-state { display: flex; align-items: center; justify-content: center; min-height: 200px; padding: 30px; text-align: center; color: var(--gt-dim); font-size: 13px; }
.rgal-overlay .rgal-modal-state--err { color: var(--danger); }
.rgal-overlay .rgal-md-render { padding: 24px 28px; color: var(--gt-fg); font-size: 14px; line-height: 1.7; }
.rgal-overlay .rgal-md-render :is(h1, h2, h3) { color: var(--gt-fg); letter-spacing: -0.015em; }
.rgal-overlay .rgal-md-render code { background: color-mix(in srgb, var(--gt-fg) 8%, transparent); padding: 1px 5px; border-radius: 5px; font-family: var(--mono); }
.rgal-overlay .rgal-md-render pre { background: color-mix(in srgb, var(--glass-base, #000) 50%, transparent); padding: 12px; border-radius: 10px; overflow: auto; border: 1px solid var(--gt-line); }
.rgal-overlay .rgal-md-render a { color: var(--gt-gold-ink); }
.rgal-overlay .rgal-orig { background: #525659; }
.rgal-overlay .rgal-orig-frame { width: 100%; height: 100%; border: none; background: #525659; }
.rgal-overlay .rgal-assoc-body { padding: 12px 16px 16px; }
.rgal-toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 200;
  max-width: min(80vw, 520px);
  padding: 11px 18px; border-radius: 14px;
  background: var(--glass-4, var(--gt-surface-solid));
  -webkit-backdrop-filter: var(--gt-blur); backdrop-filter: var(--gt-blur);
  border: 1px solid color-mix(in srgb, var(--gt-gold) 40%, transparent);
  box-shadow: var(--glass-elev-4, 0 14px 40px rgba(0, 0, 0, 0.55));
  color: var(--gt-fg); font: 550 13px/1.4 var(--glass-font, inherit);
  animation: rgal-toast-in 220ms var(--gt-ease);
}

/* ── Responsive ───────────────────────────────────────────── */
@media (max-width: 920px) {
  .ga-reports .rep-history-body--split { flex-direction: column; }
  .ga-reports .rep-history-body--split .rep-list-pane { flex: 1; max-width: 100%; }
  .ga-reports .rep-right-pane { position: fixed; inset: 0; z-index: 110; padding: 12px; background: color-mix(in srgb, var(--glass-base, #060606) 80%, transparent); }
}
@media (max-width: 760px) {
  .ga-reports { height: auto; min-height: 100%; overflow: visible; }
  .ga-reports .rep-hero { padding: 16px 14px 0; }
  .ga-reports .gt-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .ga-reports .rep-generate-wrap { grid-column: 1 / -1; }
  .ga-reports .rep-generate-btn { width: 100%; }
  .ga-reports .rep-kind-menu { left: 0; right: 0; min-width: 0; }
  .ga-reports .rep-subtabs { width: auto; }
  .ga-reports .rep-subtab { flex: 1 0 auto; justify-content: center; padding: 8px 11px; }
  .ga-reports .rgal,
  .ga-reports .rep-history,
  .ga-reports .rep-sub { padding: 0 14px 22px; overflow: visible; }
  .ga-reports .rep-list-pane { overflow: visible; }
  .ga-reports .rep-history-body { overflow: visible; }
  .ga-reports .rgal-bar { position: relative; }
  .ga-reports .rgal-controls,
  .ga-reports .rep-filter-controls { width: 100%; }
  .ga-reports .rgal-search,
  .ga-reports .rep-search-wrap { flex: 1 1 100%; width: auto; max-width: none; min-width: 0; }
  .ga-reports .rgal-select { flex: 1; min-width: 0; }
  .ga-reports .rep-input--sm { flex: 1; min-width: 0; }
  .ga-reports .rep-chip-row,
  .ga-reports .rgal-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; width: 100%; padding-bottom: 2px; }
  .ga-reports .rep-chip, .ga-reports .rgal-chip { flex-shrink: 0; }
  .ga-reports .rgal-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .ga-reports .rgal-actions { flex-wrap: wrap; }
  .ga-reports .rep-card-main { flex-wrap: wrap; row-gap: 8px; }
  .ga-reports .rep-title { flex: 1 1 100%; order: -1; white-space: normal; }
  .ga-reports .rep-theme-badge, .ga-reports .rep-meta--size { display: none; }
  .ga-reports .rep-chev { margin-left: auto; }
  /* Tables → stacked cards */
  .ga-reports .rep-trow--head { display: none; }
  .ga-reports .rep-trow { flex-wrap: wrap; align-items: flex-start; gap: 10px 12px; padding: 14px 12px; }
  .ga-reports .rep-cell { flex: 1 1 calc(50% - 12px); }
  .ga-reports .rep-cell[data-label]::before { content: attr(data-label); display: block; margin-bottom: 6px; font: 600 9px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--gt-faint); }
  .ga-reports .rep-cell--on { flex: 0 0 auto; order: -1; }
  .ga-reports .rep-cell--wide { flex-basis: 100%; }
  .ga-reports .rep-cell--actions { flex: 1 1 100%; justify-content: flex-start; }
  .rgal-overlay.rgal-modal-scrim, .rep-assoc-scrim { padding: 12px; }
  .rgal-overlay .rgal-modal, .rgal-overlay .rgal-modal--wide { width: 100%; }
}
@media (max-width: 420px) {
  .ga-reports .rgal-grid { gap: 10px; }
  .ga-reports .rgal-info { padding: 10px 11px 6px; }
  .ga-reports .rgal-title { font-size: 12.5px; }
  .ga-reports .rgal-ico { width: 28px; height: 28px; }
}

/* ── Fallbacks ────────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  .ga-reports .rep-pulse, .ga-reports .rep-preview-spin, .ga-reports .rgal-spin, .rgal-overlay .rgal-spin,
  .ga-reports .rgal-ico.is-busy svg, .ga-reports .rep-btn-spin,
  .ga-reports .rep-card, .ga-reports .rep-card-detail, .ga-reports .rgal-bulk, .ga-reports .rep-kind-menu,
  .ga-reports .rgal-recat-menu, .rep-assoc-scrim, .rgal-overlay, .rgal-toast { animation: none !important; }
  .ga-reports .rgal-card, .ga-reports .rep-card, .ga-reports .rep-toggle-knob, .ga-reports .rep-subtab,
  .ga-reports .rep-chip, .ga-reports .rgal-chip, .ga-reports .rep-btn, .ga-reports .rgal-btn, .ga-reports .rgal-ico { transition: none !important; }
  .ga-reports .rgal-card:hover, .ga-reports .rep-card:hover { transform: none; }
}
:root.perf-mode .ga-reports .rep-preview,
:root.perf-mode .ga-reports .rep-kind-menu,
:root.perf-mode .ga-reports .rgal-recat-menu,
:root.perf-mode .rgal-toast,
:root.perf-mode .rep-assoc-scrim,
:root.perf-mode .rgal-overlay.rgal-modal-scrim { -webkit-backdrop-filter: none; backdrop-filter: none; }
:root.perf-mode .ga-reports .rep-preview { background: var(--gt-surface-solid); }
@media (prefers-reduced-transparency: reduce) {
  .ga-reports .rep-preview, .ga-reports .rep-kind-menu, .ga-reports .rgal-recat-menu,
  .rgal-toast, .rep-assoc-modal, .rgal-overlay .rgal-modal {
    -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important;
  }
  .rep-assoc-scrim, .rgal-overlay.rgal-modal-scrim { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
}
`;
