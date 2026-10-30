/**
 * Page-scoped "luxury glass" styles for the Skills view (views/skills.ts).
 *
 * Builds on the shared primitives in glass-tools-shared.ts (`.gt-scope`,
 * `.gt-glass`, `.gt-seg`, `.gt-btn`, …). Everything here is scoped under
 * `.gs-page` (the /skills page) or `.gs-overlay` (drawers + the global
 * Browse Skills modal, which mount outside the page wrapper so their fixed
 * positioning / z-index is not trapped by `.gt-scope { isolation: isolate }`).
 *
 * Only existing tokens are used (--g-*, --bg*, --text*, --ok/--warn/--danger,
 * --mono …) plus the `--gt-*` / `--gs-*` local aliases.
 */
import { html } from "lit";

export const GLASS_SKILLS_CSS = /* css */ `
.gs-page, .gs-overlay {
  --gs-ink: var(--gt-fg);
  --gs-inner: color-mix(in srgb, var(--gt-fg) 3.5%, transparent);
  --gs-inner-hover: color-mix(in srgb, var(--gt-fg) 6%, transparent);
  --gs-well: color-mix(in srgb, var(--bg, #050505) 62%, transparent);
  --gs-r-lg: 22px;
}
:root[data-theme="light"] .gs-page,
:root[data-theme="light"] .gs-overlay {
  /* The brand preset keeps --g-fg / --text light even in light mode (inline
     on :root), so pin the page ink to tokens that do flip. */
  --gt-fg: var(--glass-fg, var(--text-strong, #18181b));
  --gt-dim: color-mix(in srgb, var(--text-strong, #18181b) 70%, transparent);
  --gt-faint: color-mix(in srgb, var(--text-strong, #18181b) 48%, transparent);
  color: var(--text-strong, #18181b);
  --gs-inner: rgba(255, 255, 255, 0.55);
  --gs-inner-hover: rgba(255, 255, 255, 0.85);
  --gs-well: rgba(250, 246, 238, 0.9);
}
.gs-page *, .gs-overlay * { box-sizing: border-box; }
.gs-page {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  padding-bottom: 40px;
}
.gs-page code, .gs-overlay code { font-family: var(--mono); font-size: 0.92em; }

/* Warm the shared aurora's secondary bloom toward champagne on this page. */
.gs-page > .gt-aurora::after {
  background: radial-gradient(closest-side, color-mix(in srgb, var(--gt-gold) 14%, #fde68a 6%), transparent);
}

/* ── Hero ───────────────────────────────────────────────────── */
.gs-hero { align-items: flex-end; padding-bottom: 6px; }
.gs-hero-copy { min-width: 0; flex: 1 1 380px; }
.gs-hero-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
.gs-stats { justify-content: flex-end; }
.gs-stat {
  appearance: none;
  -webkit-appearance: none;
  font: inherit;
  color: inherit;
  text-align: left;
  margin: 0;
  box-sizing: border-box;
  position: relative;
  display: grid;
  gap: 2px;
  min-width: 108px;
  padding: 12px 14px 11px;
  border-radius: 16px;
  cursor: default;
}
button.gs-stat { cursor: pointer; }
button.gs-stat:hover { transform: translateY(-2px); box-shadow: var(--gt-shadow-hover); }
button.gs-stat:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; }
.gs-stat .gt-light { position: absolute; top: 13px; right: 13px; width: 6px; height: 6px; }
.gs-stat .gt-stat-value { font-size: 24px; }
.gs-stat .gs-stat-of { font-size: 12px; font-weight: 500; color: var(--gt-faint); margin-left: 3px; }

/* ── Tabs ───────────────────────────────────────────────────── */
.gs-tabs-wrap { display: flex; min-width: 0; }
.gs-tabs {
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 4px;
  gap: 4px;
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  backdrop-filter: blur(16px) saturate(150%);
}
.gs-tabs::-webkit-scrollbar { display: none; }
.gs-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  font-size: 12.5px;
  font-weight: 550;
  white-space: nowrap;
}
.gs-tabs button svg { width: 15px; height: 15px; opacity: 0.85; }
.gs-badge {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font: 700 10px/1 var(--g-font-family, inherit);
  color: #120c00;
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 80%, #fff 20%), var(--gt-gold));
  box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}

/* ── Toolbar (search + filters) ─────────────────────────────── */
.gs-toolbar { padding: 16px; display: grid; gap: 14px; }
.gs-toolbar-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; min-width: 0; }
.gs-search { position: relative; flex: 1 1 320px; min-width: 0; }
.gs-search > svg {
  position: absolute; left: 15px; top: 50%;
  transform: translateY(-50%);
  width: 16px; height: 16px;
  color: var(--gt-faint);
  pointer-events: none;
}
.gs-search .gt-input { width: 100%; height: 44px; padding-left: 42px; font-size: 13.5px; border-radius: 14px; }
.gs-search .gt-input::-webkit-search-cancel-button { filter: grayscale(1); opacity: 0.6; }
.gs-statusseg { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
.gs-statusseg::-webkit-scrollbar { display: none; }
.gs-statusseg button { display: inline-flex; align-items: center; gap: 7px; padding: 9px 13px; white-space: nowrap; }
.gs-statusseg .gt-light { width: 6px; height: 6px; }
.gs-cats {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.gs-cat {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 13px;
  border-radius: 999px;
  font: 500 12px/1 var(--g-font-family, inherit);
  color: var(--gt-dim);
  background: var(--gs-inner);
  border: 1px solid var(--gt-line);
  white-space: nowrap;
  transition: color 200ms ease, background 240ms var(--gt-ease), border-color 240ms ease, box-shadow 240ms ease, transform 160ms ease;
}
.gs-cat:hover { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); background: var(--gs-inner-hover); }
.gs-cat:active { transform: scale(0.97); }
.gs-cat:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; }
.gs-cat-n {
  font: 500 10.5px/1 var(--mono);
  color: var(--gt-faint);
  font-variant-numeric: tabular-nums;
}
.gs-cat[aria-pressed="true"] {
  color: var(--gt-fg);
  border-color: color-mix(in srgb, var(--gt-gold) 50%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 20%, transparent), color-mix(in srgb, var(--gt-gold) 7%, transparent));
  box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.gs-cat[aria-pressed="true"] .gs-cat-n { color: var(--gt-gold-ink); }

/* ── Section heads ──────────────────────────────────────────── */
.gs-sec { display: grid; gap: 12px; min-width: 0; }
.gs-sec-head {
  display: flex;
  align-items: center;
  gap: 12px;
  font: 600 10.5px/1 var(--mono);
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--gt-dim);
}
.gs-sec-head svg { width: 14px; height: 14px; color: var(--gt-gold-ink); }
.gs-sec-head::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--gt-line), transparent);
}
.gs-sec-head .gs-count { color: var(--gt-gold-ink); letter-spacing: 0.06em; }
.gs-sec-head[data-tone="gold"] { color: var(--gt-gold-ink); }

/* ── Skill glyph (emoji or monogram) ────────────────────────── */
.gs-icon {
  --gs-tint: var(--gt-gold);
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 44px; height: 44px;
  border-radius: 14px;
  background:
    radial-gradient(120% 90% at 25% 15%, color-mix(in srgb, var(--gs-tint) 34%, transparent), transparent 60%),
    linear-gradient(160deg, color-mix(in srgb, var(--gs-tint) 16%, transparent), color-mix(in srgb, var(--gs-tint) 4%, transparent));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--gs-tint) 32%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 10px 24px -12px color-mix(in srgb, var(--gs-tint) 70%, transparent);
  overflow: hidden;
}
.gs-icon::after {
  content: "";
  position: absolute;
  inset: 0 0 50% 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.12), transparent);
  pointer-events: none;
}
.gs-icon[data-tint="1"] { --gs-tint: color-mix(in srgb, var(--gt-gold) 70%, #f97316 30%); }
.gs-icon[data-tint="2"] { --gs-tint: color-mix(in srgb, var(--gt-gold) 62%, #fde68a 38%); }
.gs-icon[data-tint="3"] { --gs-tint: color-mix(in srgb, var(--gt-gold) 72%, var(--g-accent, #a855f7) 28%); }
.gs-icon[data-tint="4"] { --gs-tint: color-mix(in srgb, var(--gt-gold) 68%, #fb7185 32%); }
.gs-icon[data-tint="5"] { --gs-tint: color-mix(in srgb, var(--gt-gold) 70%, #2dd4bf 30%); }
.gs-icon-emoji { font-size: 22px; line-height: 1; filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.35)); }
.gs-icon-mono {
  font: 650 15px/1 var(--g-font-family, inherit);
  letter-spacing: -0.02em;
  background: linear-gradient(180deg, color-mix(in srgb, var(--gs-tint) 55%, #fff 45%), var(--gs-tint));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
:root[data-theme="light"] .gs-icon-mono { background: linear-gradient(180deg, var(--gs-tint), color-mix(in srgb, var(--gs-tint) 60%, #3a2500)); -webkit-background-clip: text; background-clip: text; }
.gs-icon[data-size="sm"] { width: 34px; height: 34px; border-radius: 11px; }
.gs-icon[data-size="sm"] .gs-icon-emoji { font-size: 17px; }
.gs-icon[data-size="sm"] .gs-icon-mono { font-size: 12px; }
.gs-icon[data-size="lg"] { width: 64px; height: 64px; border-radius: 20px; }
.gs-icon[data-size="lg"] .gs-icon-emoji { font-size: 32px; }
.gs-icon[data-size="lg"] .gs-icon-mono { font-size: 22px; }

/* ── Status pill ────────────────────────────────────────────── */
.gs-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: none;
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--gt-dim);
  white-space: nowrap;
}
.gs-status .gt-light { width: 7px; height: 7px; }
.gs-status[data-tone="ok"] { color: var(--ok); }
.gs-status[data-tone="warn"] { color: var(--warn); }
.gs-status[data-tone="danger"] { color: var(--danger); }

/* ── Featured tiles ─────────────────────────────────────────── */
.gs-featured {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
@media (max-width: 1180px) { .gs-featured { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .gs-featured { grid-template-columns: minmax(0, 1fr); } }
.gs-feat {
  position: relative;
  box-sizing: border-box;
  cursor: pointer;
  outline: none;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  align-items: center;
  padding: 18px;
  overflow: hidden;
  min-width: 0;
}
.gs-feat > .gs-glow {
  position: absolute;
  inset: -40% -10% auto auto;
  width: 70%; height: 140%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--gt-gold) 18%, transparent), transparent);
  pointer-events: none;
  opacity: 0.7;
  transition: opacity 420ms var(--gt-ease), transform 620ms var(--gt-ease);
}
.gs-feat:hover > .gs-glow { opacity: 1; transform: translate3d(-8%, 6%, 0); }
.gs-feat:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 3px; }
.gs-feat .gs-icon { grid-row: span 2; width: 52px; height: 52px; border-radius: 16px; }
.gs-feat .gs-icon-emoji { font-size: 26px; }
.gs-feat .gs-icon-mono { font-size: 18px; }
.gs-feat-name {
  min-width: 0;
  font-size: 15.5px;
  font-weight: 620;
  letter-spacing: -0.012em;
  color: var(--gt-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs-feat-desc {
  grid-column: 1 / -1;
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--gt-dim);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 3.1em;
}
.gs-feat-foot {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
}

/* ── Gallery tiles ──────────────────────────────────────────── */
.gs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 272px), 1fr));
  gap: 14px;
}
.gs-tile {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  min-width: 0;
  cursor: pointer;
  overflow: hidden;
  outline: none;
}
.gs-tile > .gs-glow {
  position: absolute;
  inset: -60px auto auto -60px;
  width: 200px; height: 200px;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--gt-gold) 14%, transparent), transparent);
  opacity: 0;
  pointer-events: none;
  transition: opacity 420ms var(--gt-ease);
}
.gs-tile:hover > .gs-glow, .gs-tile[data-selected] > .gs-glow, .gs-tile:focus-visible > .gs-glow { opacity: 1; }
.gs-tile:focus-visible { box-shadow: var(--gt-shadow-hover), 0 0 0 2px color-mix(in srgb, var(--gt-gold) 60%, transparent); }
.gs-tile[data-selected] { box-shadow: var(--gt-shadow-hover), 0 0 0 1px color-mix(in srgb, var(--gt-gold) 55%, transparent); }
.gs-tile[data-state="disabled"] .gs-icon { filter: grayscale(0.7); opacity: 0.75; }
.gs-tile-top { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.gs-tile-id { flex: 1; min-width: 0; display: grid; gap: 4px; padding-top: 2px; }
.gs-tile-name {
  font-size: 14.5px;
  font-weight: 620;
  letter-spacing: -0.01em;
  color: var(--gt-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs-tile-key {
  font: 500 10.5px/1.2 var(--mono);
  color: var(--gt-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gs-tile-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--gt-dim);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 3.1em;
}
.gs-tile-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--gt-line);
  min-width: 0;
}
.gs-chips { display: flex; gap: 6px; flex-wrap: wrap; min-width: 0; }
.gs-chips .gt-chip { height: 22px; padding: 0 9px; font-size: 10.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.gs-tile .gt-btn, .gs-feat .gt-btn { height: 32px; padding: 0 14px; font-size: 12px; flex: none; }

/* ── Skeleton tiles ─────────────────────────────────────────── */
.gs-skel-tile { padding: 16px; display: grid; gap: 12px; }
.gs-skel-row { display: flex; gap: 12px; align-items: center; }

/* ── Generic glass panel ────────────────────────────────────── */
.gs-panel { padding: 20px; display: grid; gap: 16px; min-width: 0; }
.gs-panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.gs-panel-id { display: flex; gap: 14px; align-items: flex-start; min-width: 0; flex: 1 1 320px; }
.gs-ico-badge {
  flex: none;
  display: grid;
  place-items: center;
  width: 38px; height: 38px;
  border-radius: 12px;
  color: var(--gt-gold-ink);
  background: radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--gt-gold) 26%, transparent), color-mix(in srgb, var(--gt-gold) 6%, transparent) 70%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 30%, transparent);
}
.gs-ico-badge svg { width: 18px; height: 18px; }
.gs-panel-title { margin: 2px 0 4px; font-size: 16px; font-weight: 620; letter-spacing: -0.012em; color: var(--gt-fg); }
.gs-panel-sub { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--gt-dim); max-width: 72ch; }
.gs-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.gs-meta { font: 500 11px/1.2 var(--mono); color: var(--gt-faint); letter-spacing: 0.02em; }

/* ── Inner cards (drafts, healing, learned…) ────────────────── */
.gs-list { display: grid; gap: 10px; }
.gs-cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); }
.gs-card {
  position: relative;
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 16px;
  background: var(--gs-inner);
  border: 1px solid var(--gt-line);
  min-width: 0;
  transition: background 240ms ease, border-color 240ms ease;
}
.gs-card:hover { background: var(--gs-inner-hover); }
.gs-card[data-tone]::before {
  content: "";
  position: absolute;
  left: -1px; top: 14px; bottom: 14px;
  width: 2px;
  border-radius: 2px;
  background: var(--gs-accent, var(--gt-gold));
  box-shadow: 0 0 10px var(--gs-accent, var(--gt-gold));
}
.gs-card[data-tone="ok"] { --gs-accent: var(--ok); }
.gs-card[data-tone="warn"] { --gs-accent: var(--warn); }
.gs-card[data-tone="danger"] { --gs-accent: var(--danger); }
.gs-card[data-tone="idle"] { --gs-accent: var(--gt-line); }
.gs-card-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; min-width: 0; }
.gs-card-main { flex: 1 1 220px; min-width: 0; display: grid; gap: 5px; }
.gs-card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; font-weight: 600; color: var(--gt-fg); min-width: 0; word-break: break-word; }
.gs-card-sub { font-size: 12px; line-height: 1.5; color: var(--gt-dim); word-break: break-word; }
.gs-card-split { border-top: 1px solid var(--gt-line); padding-top: 12px; display: grid; gap: 10px; }
.gs-inline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.gs-inline .gt-input { flex: 1 1 200px; min-width: 0; }

/* ── Notes / callouts ───────────────────────────────────────── */
.gs-note {
  --gs-n: var(--gt-gold);
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 11px 14px;
  border-radius: 14px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--gt-fg);
  background: color-mix(in srgb, var(--gs-n) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--gs-n) 28%, transparent);
  word-break: break-word;
}
.gs-note > svg { flex: none; width: 16px; height: 16px; margin-top: 1px; color: var(--gs-n); }
.gs-note[data-tone="ok"] { --gs-n: var(--ok); }
.gs-note[data-tone="warn"] { --gs-n: var(--warn); }
.gs-note[data-tone="danger"] { --gs-n: var(--danger); }

/* ── Code / pre / diff ──────────────────────────────────────── */
.gs-code {
  margin: 0;
  padding: 12px 14px;
  max-height: 340px;
  overflow: auto;
  border-radius: 12px;
  background: var(--gs-well);
  border: 1px solid var(--gt-line);
  font: 11.5px/1.6 var(--mono);
  color: var(--gt-fg);
  white-space: pre-wrap;
  word-break: break-word;
}
.gs-code .gs-add { color: var(--ok); display: block; background: color-mix(in srgb, var(--ok) 8%, transparent); }
.gs-code .gs-del { color: var(--danger); display: block; background: color-mix(in srgb, var(--danger) 8%, transparent); }
.gs-code .gs-ctx { color: var(--gt-dim); display: block; }
.gs-textarea {
  width: 100%;
  min-height: 260px;
  height: auto;
  padding: 12px 14px;
  line-height: 1.6;
  resize: vertical;
  font: 12px/1.6 var(--mono);
}

/* ── Switch ─────────────────────────────────────────────────── */
.gs-setting { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; padding: 14px 16px; }
.gs-setting-label { font-size: 13.5px; font-weight: 600; color: var(--gt-fg); }
.gs-setting-desc { margin-top: 3px; font-size: 12px; line-height: 1.5; color: var(--gt-dim); }
.gs-switch {
  all: unset;
  flex: none;
  position: relative;
  width: 46px; height: 26px;
  border-radius: 999px;
  cursor: pointer;
  background: color-mix(in srgb, var(--gt-fg) 12%, transparent);
  box-shadow: inset 0 0 0 1px var(--gt-line), inset 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: background 260ms var(--gt-ease), box-shadow 260ms ease;
}
.gs-switch::after {
  content: "";
  position: absolute;
  top: 3px; left: 3px;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: linear-gradient(180deg, #fff, #e7e5e4);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  transition: transform 320ms var(--gt-ease);
}
.gs-switch[aria-checked="true"] {
  background: linear-gradient(180deg, color-mix(in srgb, var(--gt-gold) 85%, #fff 15%), var(--gt-gold));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 60%, transparent), 0 6px 18px -6px color-mix(in srgb, var(--gt-gold) 70%, transparent);
}
.gs-switch[aria-checked="true"]::after { transform: translateX(20px); }
.gs-switch:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 3px; }

/* ── Activity timeline ──────────────────────────────────────── */
.gs-timeline { display: grid; gap: 2px; position: relative; }
.gs-event {
  all: unset;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 12px;
  align-items: start;
  padding: 10px 12px;
  border-radius: 14px;
  transition: background 200ms ease;
}
.gs-event[data-link] { cursor: pointer; }
.gs-event[data-link]:hover { background: var(--gs-inner-hover); }
.gs-event:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 1px; }
.gs-event-dot {
  display: grid; place-items: center;
  width: 34px; height: 34px;
  border-radius: 11px;
  font-size: 15px;
  background: var(--gs-inner);
  border: 1px solid var(--gt-line);
}
.gs-event-msg { font-size: 13px; color: var(--gt-fg); line-height: 1.45; word-break: break-word; }
.gs-event-ts { margin-top: 3px; font: 500 10.5px/1 var(--mono); color: var(--gt-faint); }

/* ── Empty state ────────────────────────────────────────────── */
.gs-empty-panel { padding: 8px; }
.gs-empty-panel .gt-btn { margin-top: 6px; }

/* ── Overlays: drawers + modal ──────────────────────────────── */
.gt-scope.gs-overlay {
  position: fixed;
  inset: 0;
  /* The app topbar sits at z-index 99999 inside .shell; overlays must clear it. */
  z-index: 100400;
  display: flex;
  justify-content: flex-end;
  align-items: stretch;
  padding: 12px;
  isolation: isolate;
}
.gt-scope.gs-overlay[data-kind="author"] { z-index: 100450; }
.gt-scope.gs-overlay[data-kind="modal"] { z-index: 100500; justify-content: center; align-items: center; padding: 24px; }
.gs-scrim {
  position: absolute;
  inset: 0;
  z-index: -1;
  background:
    radial-gradient(80% 60% at 85% 20%, color-mix(in srgb, var(--gt-gold) 10%, transparent), transparent 70%),
    rgba(2, 2, 4, 0.58);
  -webkit-backdrop-filter: blur(8px) saturate(120%);
  backdrop-filter: blur(8px) saturate(120%);
  animation: gs-fade 320ms ease both;
}
:root[data-theme="light"] .gs-scrim {
  background:
    radial-gradient(80% 60% at 85% 20%, color-mix(in srgb, var(--gt-gold) 14%, transparent), transparent 70%),
    rgba(40, 32, 18, 0.28);
}
@keyframes gs-fade { from { opacity: 0; } }
.gs-drawer.gt-glass {
  --gt-radius: 26px;
  position: relative;
  width: min(520px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--gt-fg);
  background:
    linear-gradient(165deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.015) 40%),
    color-mix(in srgb, var(--bg-elevated, #0c0c0e) 84%, transparent);
  -webkit-backdrop-filter: blur(30px) saturate(170%);
  backdrop-filter: blur(30px) saturate(170%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.08) inset,
    -30px 0 80px -20px rgba(0, 0, 0, 0.7),
    0 40px 120px -40px color-mix(in srgb, var(--gt-gold) 30%, transparent);
  animation: gs-slide 520ms var(--gt-ease) both;
}
:root[data-theme="light"] .gs-drawer.gt-glass {
  background:
    linear-gradient(165deg, rgba(255, 255, 255, 0.96), rgba(255, 252, 245, 0.88));
  box-shadow:
    0 1px 0 #fff inset,
    -30px 0 80px -30px rgba(60, 40, 10, 0.3),
    0 40px 120px -40px color-mix(in srgb, var(--gt-gold) 40%, transparent);
}
.gs-overlay[data-kind="author"] .gs-drawer.gt-glass { width: min(560px, 100%); }
@keyframes gs-slide { from { opacity: 0; transform: translate3d(36px, 0, 0); } }
.gs-drawer-head {
  position: relative;
  display: flex;
  gap: 16px;
  align-items: flex-start;
  padding: 24px 24px 18px;
  border-bottom: 1px solid var(--gt-line);
}
.gs-drawer-head::before {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(70% 120% at 0% 0%, color-mix(in srgb, var(--gt-gold) 14%, transparent), transparent 70%);
  pointer-events: none;
}
.gs-drawer-id { flex: 1; min-width: 0; display: grid; gap: 6px; padding-top: 4px; position: relative; }
.gs-drawer-title { margin: 0; font-size: 22px; line-height: 1.15; font-weight: 650; letter-spacing: -0.022em; color: var(--gt-fg); word-break: break-word; }
.gs-drawer-key { font: 500 11.5px/1 var(--mono); color: var(--gt-faint); word-break: break-all; }
.gs-close {
  all: unset;
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 40px; height: 40px;
  border-radius: 50%;
  cursor: pointer;
  color: var(--gt-dim);
  background: var(--gs-inner);
  border: 1px solid var(--gt-line);
  transition: color 200ms ease, background 200ms ease, transform 320ms var(--gt-ease);
}
.gs-close:hover { color: var(--gt-fg); background: var(--gs-inner-hover); transform: rotate(90deg); }
.gs-close:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; }
.gs-drawer-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 24px 24px;
  display: grid;
  align-content: start;
  gap: 22px;
}
.gs-drawer-foot {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  padding: 16px 24px calc(16px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--gt-line);
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--gt-gold) 4%, transparent));
}
.gs-drawer-foot .gs-push { margin-left: auto; }
.gs-dsec { display: grid; gap: 10px; min-width: 0; }
.gs-dlabel {
  font: 600 10px/1 var(--mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--gt-faint);
}
.gs-dtext { margin: 0; font-size: 13.5px; line-height: 1.65; color: var(--gt-fg); white-space: pre-wrap; word-break: break-word; }
.gs-dtext[data-dim] { color: var(--gt-dim); font-size: 13px; }
.gs-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.gs-fact {
  display: grid;
  gap: 6px;
  padding: 11px 13px;
  border-radius: 14px;
  background: var(--gs-inner);
  border: 1px solid var(--gt-line);
  min-width: 0;
}
.gs-fact-v { font-size: 13px; font-weight: 560; color: var(--gt-fg); display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gs-reqs { display: grid; gap: 6px; }
.gs-req {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--gs-inner);
  border: 1px solid var(--gt-line);
  font: 500 12px/1.3 var(--mono);
  color: var(--gt-fg);
  min-width: 0;
}
.gs-req > span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gs-req-kind { font: 600 9.5px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--gt-faint); }
.gs-invoke {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 4px 4px 14px;
  border-radius: 12px;
  background: var(--gs-well);
  border: 1px solid var(--gt-line);
  min-width: 0;
}
.gs-invoke code { flex: 1; min-width: 0; color: var(--gt-gold-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.gs-copy {
  all: unset;
  flex: none;
  display: grid; place-items: center;
  width: 34px; height: 34px;
  border-radius: 9px;
  cursor: pointer;
  color: var(--gt-faint);
  transition: color 160ms ease, background 160ms ease;
}
.gs-copy:hover { color: var(--gt-fg); background: var(--gs-inner-hover); }
.gs-copy:focus-visible { outline: 2px solid var(--gt-gold); }
.gs-copy[data-done] { color: var(--ok); }
.gs-field { display: grid; gap: 7px; min-width: 0; }
.gs-field-label { font-size: 12.5px; font-weight: 600; color: var(--gt-fg); }
.gs-field-hint { margin-left: 6px; font: 500 10.5px/1 var(--mono); color: var(--gt-faint); }
.gs-field .gt-input { width: 100%; min-width: 0; }
.gs-field textarea.gt-input { height: auto; min-height: 76px; padding: 10px 14px; line-height: 1.5; resize: vertical; }
.gs-field select.gt-input { appearance: none; -webkit-appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--gt-faint) 50%), linear-gradient(135deg, var(--gt-faint) 50%, transparent 50%); background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 34px; }
.gs-field-row { display: grid; grid-template-columns: 1fr 92px; gap: 12px; }
.gs-field-row .gt-input[maxlength] { text-align: center; font-size: 18px; }

/* Browse modal */
.gs-modal.gt-glass {
  --gt-radius: 26px;
  width: min(1120px, 100%);
  height: min(720px, calc(100vh - 48px));
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  overflow: hidden;
  color: var(--gt-fg);
  background:
    linear-gradient(165deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.015) 40%),
    color-mix(in srgb, var(--bg-elevated, #0c0c0e) 86%, transparent);
  -webkit-backdrop-filter: blur(30px) saturate(170%);
  backdrop-filter: blur(30px) saturate(170%);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08) inset, 0 50px 140px -30px rgba(0, 0, 0, 0.8), 0 40px 120px -50px color-mix(in srgb, var(--gt-gold) 40%, transparent);
  animation: gs-pop 480ms var(--gt-ease) both;
}
:root[data-theme="light"] .gs-modal.gt-glass {
  background: linear-gradient(165deg, rgba(255, 255, 255, 0.97), rgba(255, 252, 245, 0.9));
  box-shadow: 0 1px 0 #fff inset, 0 50px 120px -40px rgba(60, 40, 10, 0.35);
}
@keyframes gs-pop { from { opacity: 0; transform: translate3d(0, 14px, 0) scale(0.985); } }
.gs-modal-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 14px 24px;
  border-bottom: 1px solid var(--gt-line);
  background: radial-gradient(60% 140% at 0% 0%, color-mix(in srgb, var(--gt-gold) 12%, transparent), transparent 70%);
}
.gs-modal-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.gs-modal-title h2 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -0.02em; color: var(--gt-fg); }
.gs-modal-tools {
  grid-column: 1 / -1;
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding: 14px 24px;
  border-bottom: 1px solid var(--gt-line);
  min-width: 0;
}
.gs-modal-tools .gs-search { flex: 1 1 300px; }
.gs-modal-list { overflow-y: auto; padding: 14px 16px 18px 20px; border-right: 1px solid var(--gt-line); display: grid; gap: 8px; align-content: start; min-height: 0; }
.gs-modal-detail { overflow-y: auto; padding: 22px 24px; min-height: 0; background: color-mix(in srgb, var(--gt-gold) 2%, transparent); }
.gs-row {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  border-radius: 16px;
  border: 1px solid transparent;
  background: var(--gs-inner);
  min-width: 0;
  transition: background 220ms ease, border-color 220ms ease, transform 220ms var(--gt-ease);
}
.gs-row:hover { background: var(--gs-inner-hover); border-color: color-mix(in srgb, var(--gt-gold) 22%, transparent); }
.gs-row:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 1px; }
.gs-row[aria-selected="true"] {
  border-color: color-mix(in srgb, var(--gt-gold) 50%, transparent);
  background: linear-gradient(100deg, color-mix(in srgb, var(--gt-gold) 14%, transparent), color-mix(in srgb, var(--gt-gold) 3%, transparent));
}
.gs-row-main { display: grid; gap: 3px; min-width: 0; }
.gs-row-name { font-size: 13.5px; font-weight: 600; color: var(--gt-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gs-row-desc { font-size: 11.5px; color: var(--gt-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gs-row-side { display: grid; justify-items: end; gap: 6px; }
.gs-row .gt-btn { height: 28px; padding: 0 12px; font-size: 11.5px; }
.gs-back { display: none; }

/* ── Mobile ─────────────────────────────────────────────────── */
@media (max-width: 720px) {
  .gs-modal.gt-glass {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr);
  }
  .gs-modal-list { border-right: 0; }
  .gs-modal[data-has-selection] .gs-modal-list { display: none; }
  .gs-modal:not([data-has-selection]) .gs-modal-detail { display: none; }
  .gs-back { display: inline-flex; margin-bottom: 14px; }
}
@media (max-width: 640px) {
  .gs-page { gap: 14px; }
  .gs-hero-actions { margin-top: 14px; }
  .gs-hero-actions .gt-btn { flex: 1 1 auto; }
  .gs-stats { justify-content: stretch; }
  .gs-stat { min-width: 0; padding: 10px 11px; }
  .gs-stat .gt-stat-value { font-size: 19px; }
  .gs-stat .gt-stat-label { font-size: 9px; letter-spacing: 0.1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gs-tabs-wrap { margin: 0 -2px; }
  .gs-tabs { width: 100%; }
  .gs-tabs button { min-height: 40px; padding: 0 14px; }
  .gs-toolbar { padding: 12px; gap: 12px; }
  .gs-statusseg { width: 100%; }
  .gs-statusseg button { min-height: 40px; padding: 0 13px; flex: 1 0 auto; justify-content: center; }
  .gs-stats { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .gs-stats > .gs-stat { grid-column: span 2; }
  .gs-stats > .gs-stat:nth-child(4):nth-last-child(2),
  .gs-stats > .gs-stat:nth-child(5):last-child { grid-column: span 3; }
  .gs-cats {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    margin: 0 -12px;
    padding: 2px 12px;
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 24px), transparent);
    mask-image: linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 24px), transparent);
  }
  .gs-cats::-webkit-scrollbar { display: none; }
  .gs-cat { height: 40px; padding: 0 15px; }
  .gs-page .gt-btn, .gs-overlay .gt-btn { min-height: 40px; }
  .gs-tile .gt-btn, .gs-feat .gt-btn, .gs-row .gt-btn { height: 40px; min-height: 40px; }
  .gs-tile { padding: 14px; }
  .gs-panel { padding: 16px; }
  .gs-card { padding: 13px 14px; }
  .gs-switch { width: 50px; height: 30px; }
  .gs-switch::after { width: 24px; height: 24px; }
  .gs-switch[aria-checked="true"]::after { transform: translateX(20px); }
  .gt-scope.gs-overlay { padding: 0; }
  .gt-scope.gs-overlay[data-kind="modal"] { padding: 0; }
  .gs-drawer.gt-glass, .gs-overlay[data-kind="author"] .gs-drawer.gt-glass {
    width: 100%;
    height: 100%;
    max-height: none;
    border-radius: 0;
    animation-name: gs-sheet;
  }
  .gs-modal.gt-glass { width: 100%; height: 100%; border-radius: 0; animation-name: gs-sheet; }
  .gs-drawer-head { padding: calc(18px + env(safe-area-inset-top, 0px)) 18px 16px; }
  .gs-drawer-body { padding: 18px; }
  .gs-drawer-foot { padding: 14px 18px calc(14px + env(safe-area-inset-bottom, 0px)); }
  .gs-drawer-foot .gt-btn { flex: 1 1 auto; }
  .gs-drawer-foot .gs-push { margin-left: 0; }
  .gs-modal-head { padding: calc(14px + env(safe-area-inset-top, 0px)) 14px 12px 18px; }
  .gs-modal-tools { padding: 12px 16px; }
  .gs-modal-list { padding: 12px 14px 18px; }
  .gs-modal-detail { padding: 18px; }
  .gs-row { grid-template-columns: auto minmax(0, 1fr); }
  .gs-row-side { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; }
  .gs-field-row { grid-template-columns: 1fr 76px; }
  .gs-close { width: 42px; height: 42px; }
  .gs-copy { width: 40px; height: 40px; }
}
@keyframes gs-sheet { from { opacity: 0; transform: translate3d(0, 28px, 0); } }

/* ── Fallbacks ──────────────────────────────────────────────── */
:root.perf-mode .gs-overlay .gs-drawer.gt-glass,
:root.perf-mode .gs-overlay .gs-modal.gt-glass {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  background: var(--gt-surface-solid);
}
:root.perf-mode .gs-scrim { -webkit-backdrop-filter: none; backdrop-filter: none; background: rgba(0, 0, 0, 0.66); }
:root.perf-mode .gs-tabs { -webkit-backdrop-filter: none; backdrop-filter: none; }
@media (prefers-reduced-transparency: reduce) {
  .gs-overlay .gs-drawer.gt-glass,
  .gs-overlay .gs-modal.gt-glass { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: var(--gt-surface-solid) !important; }
  .gs-scrim { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; background: rgba(0, 0, 0, 0.66); }
  .gs-tabs { -webkit-backdrop-filter: none; backdrop-filter: none; }
}
@media (prefers-reduced-motion: reduce) {
  .gs-scrim, .gs-drawer.gt-glass, .gs-modal.gt-glass { animation: none !important; }
  .gs-feat > .gs-glow, .gs-tile > .gs-glow, .gs-switch, .gs-switch::after, .gs-cat, .gs-close, .gs-row, .gs-card { transition: none !important; }
  .gs-feat:hover > .gs-glow { transform: none; }
  .gs-close:hover { transform: none; }
  button.gs-stat:hover { transform: none; }
}
`;

/** `<style>` tag for the Skills page styles. Safe to render more than once. */
export const glassSkillsStyle = () => html`<style>${GLASS_SKILLS_CSS}</style>`;
