/**
 * Control bar (topbar) layout styles, scoped to `header.topbar[data-cb]` so
 * they win over the historical topbar rules in layout.css /
 * layout.mobile.css without editing them. Injected once by control-bar.ts.
 *
 * Levels are set by the planner (control-bar.ts): `data-cb-level="1"` etc. on
 * each managed control, `data-cb-hidden` when it moved into the ⋯ menu.
 */

const STYLE_ID = "cb-control-bar-styles";

export const CONTROL_BAR_CSS = /* css */ `
header.topbar[data-cb] {
  --cb-h: 36px;
  --cb-gap: 8px;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  column-gap: 14px;
  row-gap: 0;
  padding: 0 18px;
  height: var(--shell-topbar-height, 64px);
  min-height: 0;
}
header.topbar[data-cb] > .topbar-left,
header.topbar[data-cb] > .topbar-status {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--cb-gap);
  min-width: 0;
  overflow: visible;
}
header.topbar[data-cb] > .topbar-left { justify-content: flex-start; }
header.topbar[data-cb] > .topbar-status { justify-content: flex-end; }
header.topbar[data-cb] > .topbar-center { min-width: 0; }
header.topbar[data-cb] [data-cb-item] { flex: 0 0 auto; min-width: 0; }
header.topbar[data-cb] [data-cb-hidden] { display: none !important; }
header.topbar[data-cb] .cb-slot { display: inline-flex; align-items: center; }
header.topbar[data-cb] .cb-slot:empty { display: none; }
header.topbar[data-cb] .topbar-coder-cluster { gap: var(--cb-gap) !important; }

/* Uniform control height. */
header.topbar[data-cb] :is(
  .topbar-status .pill,
  .topbar-glass-btn,
  .topbar-health-pill,
  .topbar-instance-pill,
  .topbar-satellite-pill,
  .topbar-coder-pill,
  .learn-topbar-btn,
  .lang-select__control
) {
  box-sizing: border-box;
  height: var(--cb-h);
  min-height: var(--cb-h);
  display: inline-flex;
  align-items: center;
}
header.topbar[data-cb] .global-agency-switcher { height: var(--cb-h); box-sizing: border-box; }
header.topbar[data-cb] .nav-collapse-toggle {
  width: var(--cb-h);
  height: var(--cb-h);
  flex: 0 0 auto;
  display: inline-grid;
  place-items: center;
}
header.topbar[data-cb] .notif-bell { min-width: var(--cb-h); justify-content: center; }

/* Page context: never wider than a short title, always ellipsised. */
header.topbar[data-cb] [data-cb-item="tabctx"] { flex: 0 1 auto; max-width: 260px; }
header.topbar[data-cb][data-cb-measuring] [data-cb-item="tabctx"] { flex-shrink: 0; }
header.topbar[data-cb] [data-cb-item="tabctx"][data-cb-level="1"] { max-width: 132px; }
header.topbar[data-cb] .brand { flex: 0 0 auto; min-width: 0; }

/* ── level 1+: compact forms ─────────────────────────────────────────── */
/* Brand → logo only. */
header.topbar[data-cb] [data-cb-item="brand"][data-cb-level="1"] .brand-text { display: none; }
header.topbar[data-cb] [data-cb-item="brand"][data-cb-level="1"] { gap: 0; }

/* Icon-only buttons: hide the text, square the button. Works for bare text
   nodes too (font-size: 0), SVG sizes come from their attributes. */
header.topbar[data-cb] :is([data-cb-item="restart"], [data-cb-item="canvas"], [data-cb-item="chart"], [data-cb-item="chat"], [data-cb-item="live"])[data-cb-level="1"] :is(button, .pill),
header.topbar[data-cb] :is([data-cb-item="live"], [data-cb-item="chat"])[data-cb-level="1"]:is(button, .pill) {
  font-size: 0;
  gap: 0;
  padding: 0;
  width: var(--cb-h);
  min-width: var(--cb-h);
  justify-content: center;
}
header.topbar[data-cb] [data-cb-item][data-cb-level="1"] .cb-label,
header.topbar[data-cb] [data-cb-item="chat"][data-cb-level="1"] > span { display: none; }

/* Coder pill → logo only. */
header.topbar[data-cb] [data-cb-item="coder"][data-cb-level="1"] .topbar-coder-label,
header.topbar[data-cb] [data-cb-item="coder"][data-cb-level="1"] plan-badge { display: none; }
header.topbar[data-cb] [data-cb-item="coder"][data-cb-level="1"] .topbar-coder-pill { padding: 0; width: var(--cb-h); justify-content: center; }

/* Health: "Health OK" → dot + OK → dot. */
header.topbar[data-cb] [data-cb-item="health"][data-cb-level="1"] > span:not(.statusDot):not(.mono) { display: none; }
header.topbar[data-cb] [data-cb-item="health"][data-cb-level="2"] > span:not(.statusDot) { display: none; }
header.topbar[data-cb] [data-cb-item="health"][data-cb-level="2"] { padding: 0; width: var(--cb-h); justify-content: center; gap: 0; }

/* Instance / satellite → icon + dot. */
header.topbar[data-cb] [data-cb-item="instance"][data-cb-level="1"] .instance-name,
header.topbar[data-cb] [data-cb-item="satellite"][data-cb-level="1"] .topbar-satellite-label { display: none; }

/* Agency selector: full name up to 220px, compact 132px; always ellipsised. */
header.topbar[data-cb] [data-cb-item="agency"] .global-agency-switcher { min-width: 0; width: 212px; max-width: 212px; }
header.topbar[data-cb] [data-cb-item="agency"][data-cb-level="1"] .global-agency-switcher { width: 140px; }

/* ── ⋯ overflow menu ────────────────────────────────────────────────── */
header.topbar[data-cb] [data-cb-more] { position: relative; flex: 0 0 auto; display: inline-flex; }
header.topbar[data-cb]:not([data-cb-overflowing]):not([data-cb-measuring]) [data-cb-more] { display: none; }
header.topbar[data-cb] .cb-more__btn { width: var(--cb-h); min-width: var(--cb-h); height: var(--cb-h); padding: 0; justify-content: center; }
.cb-more__menu {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 100000;
  display: grid;
  gap: 2px;
  width: min(300px, calc(100vw - 16px));
  max-height: calc(100dvh - 96px);
  overflow: auto;
  padding: 6px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 35%, var(--border, #27272a));
  background: color-mix(in srgb, var(--popover, #0f0f0f) 96%, var(--g-primary, #d4af37));
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(18px);
  color: var(--text, #e4e4e7);
  font-family: var(--font-body, monospace);
}
:root[data-theme="light"] .cb-more__menu { background: #fff; box-shadow: 0 16px 40px rgba(40, 30, 5, 0.16); }
.cb-more__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: 600 13px/1.2 var(--font-body, monospace);
  text-align: left;
  cursor: pointer;
}
.cb-more__row:hover, .cb-more__row:focus-visible, .cb-more__row--select:focus-within {
  outline: none;
  background: color-mix(in srgb, var(--g-primary, #d4af37) 12%, transparent);
}
.cb-more__icon { display: inline-grid; place-items: center; width: 20px; height: 20px; flex: 0 0 20px; color: var(--g-primary, #d4af37); }
:root[data-theme="light"] .cb-more__icon { color: color-mix(in srgb, var(--g-primary, #d4af37) 60%, #1a1204); }
.cb-more__icon svg, .cb-more__icon img { width: 16px; height: 16px; }
.cb-more__text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cb-more__detail { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 500; color: var(--muted, #a1a1aa); }
/* Dropdown rows: label on top, the select on its own full-width line so
   long values (agency names) are never cut off. */
.cb-more__row--select { flex-wrap: wrap; row-gap: 6px; padding-top: 8px; padding-bottom: 8px; }
.cb-more__row--select .cb-more__select { box-sizing: border-box; flex: 0 0 calc(100% - 30px); width: calc(100% - 30px); max-width: calc(100% - 30px); min-width: 0; margin-left: 30px; }
.cb-more__select {
  max-width: 55%;
  min-height: 30px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--border, #27272a);
  background: var(--bg-elevated, #111);
  color: inherit;
  font: 500 12px/1 var(--font-body, monospace);
  text-overflow: ellipsis;
}

/* ── stacked shell (≤1100px): keep one row; never wrap onto the nav ──── */
@media (max-width: 1100px) {
  header.topbar[data-cb] { position: sticky; padding: 0 12px; column-gap: 10px; height: 60px; min-height: 60px; }
}
/* ── phones: 44px touch targets ─────────────────────────────────────── */
@media (max-width: 600px) {
  header.topbar[data-cb] { --cb-h: 44px; --cb-gap: 6px; padding: 0 8px; column-gap: 6px; height: 60px; min-height: 60px; }
  header.topbar[data-cb] .brand-logo { display: block; width: 36px; height: 36px; }
  header.topbar[data-cb] .brand { flex: 0 0 auto; }
  header.topbar[data-cb] .notif-bell { width: var(--cb-h); }
}
@media (max-width: 600px) and (min-width: 0px) {
  header.topbar[data-cb] [data-cb-item="health"] { min-width: var(--cb-h); justify-content: center; }
}
`;

export function ensureControlBarStyles(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CONTROL_BAR_CSS;
  doc.head.appendChild(el);
}
