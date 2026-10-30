/**
 * Glass layer for the Sovereign Memory page (/memory?view=memory).
 *
 * Light-DOM CSS, rendered after glassAgentsStyle() and scoped under
 * `.gm-page` so nothing leaks. Colours come from the `--gt-*` aliases that
 * `.gt-scope` sets (which read the shared `--glass-*` tokens).
 */
export const MEMORY_HOST_SUBTABS_CSS = /* css */ `
@media (max-width: 640px) {
  .content > .host-subtabs[data-host-subtabs="memory"] {
    flex: 0 0 auto !important;
    flex-wrap: nowrap !important;
    align-self: flex-start;
    width: auto;
    min-height: 42px;
    max-width: calc(100vw - 24px) !important;
    margin: 0 0 12px !important;
    padding: 4px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    scrollbar-width: none;
  }
  .content > .host-subtabs[data-host-subtabs="memory"]::-webkit-scrollbar { display: none; }
  .content > .host-subtabs[data-host-subtabs="memory"] .host-subtabs__tab {
    flex: 0 0 auto;
    min-height: 32px;
    display: inline-flex;
    align-items: center;
  }
}
`;

/**
 * Memory Agents is a shadow-root component while the shared host sub-tabs live
 * beside it in the app shadow root. Install this tiny, memory-scoped rule in
 * that parent root so the mobile segmented control keeps its natural height.
 */
export function ensureMemoryHostSubtabsStyle(root: Document | ShadowRoot): void {
  const id = "glass-memory-host-subtabs";
  const target = root instanceof Document ? root.head : root;
  if (target.querySelector(`style[data-style-id="${id}"]`)) return;
  const style = document.createElement("style");
  style.dataset.styleId = id;
  style.textContent = MEMORY_HOST_SUBTABS_CSS;
  target.append(style);
}

export const GLASS_MEMORY_CSS = /* css */ `
${MEMORY_HOST_SUBTABS_CSS}
.gm-page {
  --gm-ok: var(--ok, #22c55e);
  --gm-warn: var(--warn, #f59e0b);
  --gm-danger: var(--danger, #ef4444);
  --gm-line-gold: color-mix(in srgb, var(--gt-gold) 22%, transparent);
  --gm-well: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 4px 28px;
  color: var(--gt-fg);
  min-width: 0;
}
.gm-page *, .gm-page *::before, .gm-page *::after { box-sizing: border-box; }
.gm-page h2, .gm-page h3, .gm-page p { margin: 0; }
.gm-page code, .gm-page .gm-mono { font-family: var(--glass-font-mono, var(--mono, ui-monospace, monospace)); }
.gm-page .gt-hero { padding-bottom: 4px; }
.gm-hero-copy { min-width: 0; flex: 1 1 360px; }
.gm-hero-side { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
.gm-hero-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.gm-page .gt-stat-value { display: inline-flex; align-items: center; gap: 8px; }

/* Small buttons + icons */
.gm-page .gt-btn svg { width: 14px; height: 14px; flex: none; }
.gm-page .gm-btn-sm { height: 30px; padding: 0 11px; border-radius: 10px; font-size: 12px; gap: 6px; }
.gm-page .gm-btn-icon { width: 36px; padding: 0; }
.gm-page .gm-btn-icon svg { transition: transform 500ms var(--gt-ease); }
.gm-page .gm-btn-icon:hover svg { transform: rotate(140deg); }
.gm-page a.gt-btn { text-decoration: none; }
.gm-page label.gt-btn { cursor: pointer; }
.gm-page .gt-seg button { display: inline-flex; align-items: center; min-height: 26px; box-sizing: border-box; text-transform: capitalize; }

/* Notices */
.gm-note {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 10px 14px; border-radius: var(--gt-radius-sm);
  font-size: 12.5px; line-height: 1.5;
  border: 1px solid var(--gt-line); background: var(--gm-well); color: var(--gt-dim);
}
.gm-note svg { width: 15px; height: 15px; flex: none; margin-top: 2px; }
.gm-note[data-tone="ok"] { color: var(--gm-ok); border-color: color-mix(in srgb, var(--gm-ok) 30%, transparent); background: color-mix(in srgb, var(--gm-ok) 8%, transparent); }
.gm-note[data-tone="danger"] { color: var(--gm-danger); border-color: color-mix(in srgb, var(--gm-danger) 32%, transparent); background: color-mix(in srgb, var(--gm-danger) 8%, transparent); }
.gm-note strong { color: inherit; }
.gm-note code, .gm-cmd {
  display: inline-block; padding: 2px 8px; border-radius: 7px; font-size: 11.5px;
  color: var(--gt-gold-ink); background: var(--gt-gold-faint); border: 1px solid var(--gm-line-gold);
}

/* Identity files panel */
.gm-identity { scroll-margin-top: 12px; display: flex; flex-direction: column; gap: 14px; }
.gm-identity .ga-section-head { margin: 0; }
.gm-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.gm-panel-head .ga-section-head { flex: 1; min-width: 200px; }
.gm-panel-tools { display: flex; align-items: center; gap: 8px; color: var(--gt-dim); font-size: 12px; }
.gm-picker { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.gm-picker label { font: 500 10px/1 var(--glass-font-mono, var(--mono)); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gt-faint); }
.gm-page select.gt-input { min-width: 200px; max-width: 100%; padding-right: 30px; cursor: pointer; }
.gm-workspace { font-size: 11px; color: var(--gt-faint); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

.gm-drop {
  display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap;
  padding: 18px 16px; border-radius: var(--gt-radius-sm); text-align: center;
  border: 1.5px dashed color-mix(in srgb, var(--gt-gold) 26%, var(--gt-line));
  background: radial-gradient(120% 140% at 50% 0%, var(--gt-gold-faint), transparent 70%);
  color: var(--gt-dim); font-size: 12.5px;
  transition: border-color 220ms ease, background 220ms ease, transform 320ms var(--gt-ease);
}
.gm-drop.is-drag { border-color: var(--gt-gold); background: color-mix(in srgb, var(--gt-gold) 12%, transparent); transform: scale(1.005); }
.gm-drop-orb {
  width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; flex: none; color: var(--gt-gold-ink);
  background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--gt-gold) 30%, transparent), color-mix(in srgb, var(--gt-gold) 6%, transparent) 72%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 30%, transparent);
}
.gm-drop-orb svg { width: 18px; height: 18px; }
.gm-drop code { color: var(--gt-gold-ink); }

.gm-files { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
.gm-file { padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.gm-file:hover { transform: translateY(-2px); }
.gm-file.is-missing { background: transparent; border-style: dashed; }
.gm-file-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gm-file-name { font-size: 12.5px; font-weight: 500; color: var(--gt-fg); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.gm-file.is-missing .gm-file-name { color: var(--gt-dim); }
.gm-file-lock { width: 12px; height: 12px; color: var(--gt-faint); flex: none; }
.gm-file-lock svg { width: 12px; height: 12px; }
.gm-file-meta { font-size: 11px; color: var(--gt-faint); font-variant-numeric: tabular-nums; }
.gm-file-actions { display: flex; gap: 6px; }
.gm-file-actions > :first-child { flex: 1; }
.gm-file .gt-light { width: 7px; height: 7px; }

.gm-editor { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.gm-editor-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.gm-editor-name { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--gt-gold-ink); }
.gm-page textarea.gt-input {
  height: auto; width: 100%; min-height: 280px; padding: 12px 14px; resize: vertical;
  font: 12px/1.6 var(--glass-font-mono, var(--mono, monospace));
}
.gm-page textarea.gt-input[readonly] { color: var(--gt-dim); cursor: default; }
.gm-hint { font-size: 11.5px; color: var(--gt-faint); line-height: 1.5; }

.gm-sync { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-top: 14px; border-top: 1px solid var(--gt-line); }
.gm-sync-sep { width: 1px; height: 22px; background: var(--gt-line); margin: 0 2px; }
.gm-sync .gm-peer-url { flex: 1 1 220px; min-width: 0; }
.gm-sync .gm-peer-token { flex: 0 1 170px; min-width: 0; }

/* Sovereign memory grid */
.gm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.gm-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.gm-identity-core { background: radial-gradient(120% 160% at 0% 0%, color-mix(in srgb, var(--gt-gold) 14%, transparent), transparent 60%), var(--gt-surface); }
.gm-identity-name { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; margin-bottom: 6px; }
.gm-identity-nature { font-size: 13px; line-height: 1.6; color: var(--gt-dim); }
.gm-muted { font-size: 12.5px; color: var(--gt-dim); }
.gm-list { display: flex; flex-direction: column; gap: 8px; }
.gm-scroll { max-height: 300px; overflow-y: auto; padding-right: 2px; scrollbar-width: thin; scrollbar-color: var(--gm-line-gold) transparent; }
.gm-item { padding: 11px 12px; }
.gm-item.has-rail::after {
  content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 2px; border-radius: 2px;
  background: linear-gradient(180deg, var(--gt-gold), color-mix(in srgb, var(--gt-gold) 20%, transparent));
}
.gm-item-text { font-size: 12.5px; line-height: 1.5; color: var(--gt-fg); }
.gm-item-title { font-weight: 600; font-size: 13px; color: var(--gt-fg); }
.gm-item-sub { font-size: 11.5px; color: var(--gt-dim); margin-top: 3px; line-height: 1.45; }
.gm-item-meta { margin-top: 8px; display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; font-size: 11px; color: var(--gt-faint); font-variant-numeric: tabular-nums; }
.gm-item-meta .gt-chip { height: 20px; padding: 0 8px; font-size: 10px; }
.gm-item-meta .gm-score { color: var(--gt-gold-ink); }
.gm-item-meta .gt-btn { margin-left: auto; }
.gm-values { display: flex; flex-wrap: wrap; gap: 8px; }
.gm-value { padding: 9px 12px; min-width: 0; max-width: 100%; }
.gm-covenants { margin-top: 8px; padding-left: 10px; border-left: 1px solid var(--gm-line-gold); display: grid; gap: 4px; }
.gm-covenants div { font-size: 11px; color: var(--gt-dim); }
.gm-trust { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 11px; color: var(--gt-faint); }
.gm-bar { flex: 0 0 80px; height: 4px; border-radius: 3px; background: color-mix(in srgb, var(--gt-fg) 8%, transparent); overflow: hidden; }
.gm-bar i { display: block; height: 100%; background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 55%, transparent), var(--gt-gold)); }

.gm-form { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--gt-line); display: flex; flex-direction: column; gap: 10px; }
.gm-form .gt-input { width: 100%; }
.gm-form-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.gm-form-row select.gt-input { width: auto; min-width: 140px; }
.gm-range { flex: 1 1 120px; min-width: 100px; accent-color: var(--gt-gold); }
.gm-range-val { font: 600 11.5px/1 var(--glass-font-mono, var(--mono)); color: var(--gt-gold-ink); min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; }
.gm-search { display: flex; gap: 8px; margin-bottom: 12px; }
.gm-search .gt-input { flex: 1; min-width: 0; }
.gm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.gm-actions + .gm-note { margin-top: 12px; }

/* Import dialog (rendered outside any blurred panel so position:fixed works) */
.gm-modal-backdrop {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center; padding: 32px;
  background: color-mix(in srgb, var(--glass-base, #000) 72%, transparent);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  animation: gm-fade 220ms ease both;
}
.gm-modal {
  width: 100%; max-width: 920px; max-height: 90vh; overflow: auto; padding: 20px;
  background: var(--glass-4, var(--gt-surface-solid));
  -webkit-backdrop-filter: none; backdrop-filter: none;
  animation: gm-pop 420ms var(--glass-spring, var(--gt-ease)) both;
}
.gm-modal-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
.gm-modal-title { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
.gm-modal-sub { font-size: 12.5px; color: var(--gt-dim); margin-bottom: 16px; }
.gm-modal-sub strong { color: var(--gt-gold-ink); }
.gm-import { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.gm-import-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.gm-import-name { font-size: 13px; color: var(--gt-gold-ink); }
.gm-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 11px; }
.gm-diff-label { color: var(--gt-faint); margin-bottom: 4px; font-family: var(--glass-font-mono, var(--mono)); }
.gm-diff-label.is-incoming { color: var(--gt-gold-ink); }
.gm-diff pre {
  margin: 0; padding: 9px 10px; max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 11px/1.5 var(--glass-font-mono, var(--mono, monospace)); color: var(--gt-dim);
  background: var(--gm-well); border: 1px solid var(--gt-line); border-radius: 10px;
}
.gm-diff pre.is-incoming { border-color: var(--gm-line-gold); background: var(--gt-gold-faint); color: var(--gt-fg); }
.gm-modal-foot { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
@keyframes gm-fade { from { opacity: 0; } }
@keyframes gm-pop { from { opacity: 0; transform: translateY(14px) scale(0.98); } }

/* Light theme */
:root[data-theme="light"] .gm-page { --gm-well: color-mix(in srgb, var(--gt-fg) 3%, #fff); }
:root[data-theme="light"] .gm-page .ga-card { background: rgba(255, 255, 255, 0.72); box-shadow: inset 0 1px 0 #fff, 0 1px 2px rgba(24, 24, 27, 0.05); }
:root[data-theme="light"] .gm-page .gm-file.is-missing { background: transparent; box-shadow: none; }
:root[data-theme="light"] .gm-modal-backdrop { background: rgba(24, 24, 27, 0.32); }

/* Responsive */
@media (max-width: 1000px) {
  .gm-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .gm-page { padding: 0 0 24px; gap: 12px; }
  .gm-hero-side { align-items: stretch; width: 100%; }
  .gm-hero-actions { justify-content: flex-start; }
  .gm-page .gt-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .gm-page .gt-stat-label { font-size: 9px; letter-spacing: 0.08em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gm-files { grid-template-columns: 1fr 1fr; gap: 8px; }
  .gm-file { padding: 10px; }
  .gm-file-actions { flex-wrap: wrap; }
  .gm-file-actions > * { flex: 1 1 auto; }
  .gm-page select.gt-input { min-width: 0; flex: 1 1 auto; }
  .gm-sync-sep { display: none; }
  .gm-sync .gm-peer-url, .gm-sync .gm-peer-token { flex: 1 1 100%; }
  .gm-diff { grid-template-columns: 1fr; }
  .gm-modal-backdrop { padding: 12px; }
  .gm-modal { padding: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .gm-drop, .gm-modal-backdrop, .gm-modal, .gm-page .gm-btn-icon svg { animation: none !important; transition: none !important; }
  .gm-file:hover, .gm-drop.is-drag { transform: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .gm-modal-backdrop { -webkit-backdrop-filter: none; backdrop-filter: none; }
  .gm-modal { background: var(--gt-surface-solid); }
}
:root.perf-mode .gm-modal-backdrop { -webkit-backdrop-filter: none; backdrop-filter: none; }
`;
