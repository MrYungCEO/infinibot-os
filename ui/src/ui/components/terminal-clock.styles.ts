/**
 * Topbar clock styles (pill + expanded panel). Injected once into <head> by
 * renderTerminalClock so the clock owns its look without touching the global
 * stylesheets. Colours come from theme tokens only (--g-primary, --bg-*,
 * --text*, --muted*, --border, --ok, --warn); the light theme gets its own
 * mix so gold text keeps contrast on white.
 *
 * Class prefix `ibc-` (InfiniBot clock). The legacy `.tc-*` rules in
 * styles/terminal-clock.css still style the alarm/timer rows; the overrides at
 * the end of this sheet re-skin them inside the new panel.
 */

const STYLE_ID = "ibc-clock-styles";

export const CLOCK_CSS = /* css */ `
.terminal-clock.ibc {
  --ibc-gold: var(--g-primary, #d4af37);
  --ibc-ink: color-mix(in srgb, var(--ibc-gold) 88%, #fff);
  --ibc-sub: color-mix(in srgb, var(--ibc-gold) 55%, var(--muted, #a1a1aa));
  --ibc-base: color-mix(in srgb, var(--bg-elevated, #111) 90%, var(--ibc-gold));
  --ibc-base-2: color-mix(in srgb, var(--bg, #050505) 94%, var(--ibc-gold));
  --ibc-edge-hi: color-mix(in srgb, var(--ibc-gold) 75%, #fff 10%);
  --ibc-edge-lo: color-mix(in srgb, var(--ibc-gold) 22%, transparent);
  --ibc-glow: color-mix(in srgb, var(--ibc-gold) 24%, transparent);
  --ibc-shadow: rgba(0, 0, 0, 0.5);
  --ibc-hi: rgba(255, 255, 255, 0.14);
  --ibc-panel-bg: color-mix(in srgb, var(--popover, #0f0f0f) 94%, var(--ibc-gold));
  position: relative;
  z-index: 9999;
  font-family: var(--mono, "JetBrains Mono", ui-monospace, monospace);
}
:root[data-theme="light"] .terminal-clock.ibc {
  --ibc-ink: color-mix(in srgb, var(--ibc-gold) 52%, #1a1204);
  --ibc-sub: color-mix(in srgb, var(--ibc-gold) 40%, #3f3f46);
  --ibc-base: color-mix(in srgb, #ffffff 90%, var(--ibc-gold));
  --ibc-base-2: color-mix(in srgb, #ffffff 80%, var(--ibc-gold));
  --ibc-edge-hi: color-mix(in srgb, var(--ibc-gold) 70%, #fff);
  --ibc-edge-lo: color-mix(in srgb, var(--ibc-gold) 45%, #6b4f0a);
  --ibc-glow: color-mix(in srgb, var(--ibc-gold) 20%, transparent);
  --ibc-shadow: rgba(80, 60, 10, 0.18);
  --ibc-hi: rgba(255, 255, 255, 0.9);
  --ibc-panel-bg: color-mix(in srgb, #ffffff 96%, var(--ibc-gold));
}
.terminal-clock--expanded.ibc { z-index: 99999; }

/* ── pill ─────────────────────────────────────────────────────────────── */
.ibc-pill {
  position: relative;
  isolation: isolate;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: var(--cb-h, 38px);
  padding: 0 14px 0 16px;
  border-radius: 999px;
  border: 1px solid transparent;
  cursor: pointer;
  color: var(--ibc-ink);
  font: inherit;
  white-space: nowrap;
  /* Layered glass: top sheen, gold bloom from above, deep body — then a
     gradient hairline border (bright top edge → dim bottom edge). */
  background:
    linear-gradient(180deg, var(--ibc-hi) 0%, transparent 46%) padding-box,
    radial-gradient(120% 150% at 50% -30%, color-mix(in srgb, var(--ibc-gold) 26%, transparent), transparent 62%) padding-box,
    linear-gradient(180deg, var(--ibc-base), var(--ibc-base-2)) padding-box,
    linear-gradient(180deg, var(--ibc-edge-hi), var(--ibc-edge-lo) 70%) border-box;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--ibc-hi) 80%, transparent),
    inset 0 -2px 6px rgba(0, 0, 0, 0.28),
    inset 0 0 0 1px rgba(0, 0, 0, 0.12),
    0 1px 2px var(--ibc-shadow),
    0 6px 18px var(--ibc-shadow),
    0 0 22px var(--ibc-glow);
  transition: box-shadow 0.25s ease, transform 0.18s ease, filter 0.25s ease;
  -webkit-tap-highlight-color: transparent;
}
.ibc-pill:hover {
  transform: translateY(-1px);
  filter: brightness(1.06);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--ibc-hi) 90%, transparent),
    inset 0 -2px 6px rgba(0, 0, 0, 0.28),
    inset 0 0 0 1px rgba(0, 0, 0, 0.12),
    0 2px 4px var(--ibc-shadow),
    0 10px 26px var(--ibc-shadow),
    0 0 34px color-mix(in srgb, var(--ibc-gold) 36%, transparent);
}
.ibc-pill:active { transform: translateY(0); }
.ibc-pill:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px var(--bg, #050505),
    0 0 0 4px var(--ibc-gold),
    0 0 24px var(--ibc-glow);
}
.terminal-clock--expanded .ibc-pill {
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--ibc-hi) 90%, transparent),
    inset 0 -2px 6px rgba(0, 0, 0, 0.3),
    0 0 0 1px color-mix(in srgb, var(--ibc-gold) 55%, transparent),
    0 10px 26px var(--ibc-shadow),
    0 0 34px color-mix(in srgb, var(--ibc-gold) 36%, transparent);
}
.ibc-pill__time {
  display: inline-flex;
  align-items: baseline;
  font-size: 19px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1, "zero" 0;
  text-shadow: 0 0 14px color-mix(in srgb, var(--ibc-gold) 45%, transparent);
}
:root[data-theme="light"] .ibc-pill__time { text-shadow: 0 1px 0 rgba(255, 255, 255, 0.8); }
.ibc-pill__colon { display: inline-block; width: 0.5em; text-align: center; animation: ibc-colon 2s steps(1, end) infinite; }
@keyframes ibc-colon { 50% { opacity: 0.45; } }
.ibc-pill__suffix { margin-left: 3px; font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: var(--ibc-sub); }
.ibc-pill__meta {
  display: inline-grid;
  gap: 2px;
  padding-left: 10px;
  border-left: 1px solid color-mix(in srgb, var(--ibc-gold) 28%, transparent);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ibc-sub);
  font-variant-numeric: tabular-nums;
}
.ibc-pill__wd { color: var(--ibc-ink); }
.ibc-pill__flag { display: inline-flex; color: var(--ibc-sub); }
.ibc-pill__flag svg { width: 13px; height: 13px; }
.ibc-pill__flag--alarm { color: var(--warn, #f59e0b); }
/* Seconds tick: a hairline along the bottom lip that fills over the minute.
   A transform, so it never moves the layout. */
.ibc-pill__tick {
  position: absolute;
  left: 18px;
  right: 18px;
  bottom: 3px;
  height: 1.5px;
  border-radius: 1px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--ibc-gold));
  opacity: 0.55;
  transform-origin: left center;
  transform: scaleX(var(--ibc-sec, 0));
  transition: transform 1s linear;
}
.ibc-pill__tick.is-reset { transition: none; }

/* Narrow bars drop the date column (the panel still shows it). */
.topbar[data-cb-clock="compact"] .ibc-pill__meta { display: none; }
.topbar[data-cb-clock="compact"] .ibc-pill { padding: 0 14px; }

/* ── panel ────────────────────────────────────────────────────────────── */
.ibc-panel {
  position: absolute;
  top: calc(100% + 10px);
  left: 50%;
  width: min(460px, calc(100vw - 16px));
  max-height: min(78vh, calc(100dvh - 96px));
  overflow: auto;
  overscroll-behavior: contain;
  transform: translateX(-50%);
  border-radius: 18px;
  border: 1px solid transparent;
  color: var(--text, #e4e4e7);
  font-family: var(--font-body, var(--mono, monospace));
  background:
    radial-gradient(120% 60% at 50% -10%, color-mix(in srgb, var(--ibc-gold) 14%, transparent), transparent 60%) padding-box,
    linear-gradient(180deg, var(--ibc-panel-bg), var(--ibc-panel-bg)) padding-box,
    linear-gradient(180deg, color-mix(in srgb, var(--ibc-gold) 60%, transparent), color-mix(in srgb, var(--ibc-gold) 14%, transparent)) border-box;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--ibc-hi) 70%, transparent),
    0 24px 60px rgba(0, 0, 0, 0.55),
    0 0 40px color-mix(in srgb, var(--ibc-gold) 12%, transparent);
  backdrop-filter: blur(22px) saturate(160%);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
  animation: ibc-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  cursor: default;
  text-align: left;
}
:root[data-theme="light"] .ibc-panel { box-shadow: inset 0 1px 0 #fff, 0 20px 50px rgba(60, 45, 10, 0.18); }
@keyframes ibc-in { from { opacity: 0; transform: translate(-50%, -6px) scale(0.985); } }

.ibc-tabs {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 10px 8px;
  background: linear-gradient(180deg, var(--ibc-panel-bg) 70%, transparent);
}
.ibc-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted, #a1a1aa);
  font: 600 12px/1 var(--font-body, monospace);
  letter-spacing: 0.02em;
  cursor: pointer;
}
.ibc-tab:hover { color: var(--text, #e4e4e7); background: color-mix(in srgb, var(--text, #e4e4e7) 6%, transparent); }
.ibc-tab.active {
  color: var(--ibc-ink);
  border-color: color-mix(in srgb, var(--ibc-gold) 40%, transparent);
  background: color-mix(in srgb, var(--ibc-gold) 12%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--ibc-hi) 60%, transparent);
}
.ibc-tab:focus-visible, .ibc-close:focus-visible, .ibc-chip:focus-within, .ibc-switch:focus-within {
  outline: 2px solid var(--ibc-gold);
  outline-offset: 2px;
}
.ibc-badge {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  display: inline-grid; place-items: center;
  font-size: 10px; font-weight: 700; color: #000; background: var(--ibc-gold);
}
.ibc-close {
  margin-left: auto;
  width: 32px; height: 32px; border-radius: 10px;
  border: 1px solid transparent; background: transparent;
  color: var(--muted, #a1a1aa); font-size: 20px; line-height: 1; cursor: pointer;
}
.ibc-close:hover { color: var(--text, #e4e4e7); background: color-mix(in srgb, var(--text, #e4e4e7) 6%, transparent); }
.ibc-content { display: grid; gap: 14px; padding: 4px 16px 16px; }

.ibc-hero { display: grid; justify-items: center; gap: 6px; padding: 10px 0 2px; }
.ibc-hero__time {
  display: inline-flex; align-items: baseline;
  font: 700 44px/1 var(--mono, monospace);
  letter-spacing: 0.03em;
  font-variant-numeric: tabular-nums;
  color: var(--ibc-ink);
  text-shadow: 0 0 24px color-mix(in srgb, var(--ibc-gold) 40%, transparent);
}
:root[data-theme="light"] .ibc-hero__time { text-shadow: none; }
.ibc-hero__colon { width: 0.45em; text-align: center; opacity: 0.8; }
.ibc-hero__sec { margin-left: 8px; font-size: 18px; color: var(--ibc-sub); }
.ibc-hero__suffix { margin-left: 6px; font-size: 13px; color: var(--ibc-sub); }
.ibc-hero__date { font-size: 13px; font-weight: 600; color: var(--text-strong, #fff); }
.ibc-hero__tz { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted, #a1a1aa); font-variant-numeric: tabular-nums; }
.ibc-dot-sep { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: 0.6; }

.ibc-world { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.ibc-world__item {
  display: grid; justify-items: center; gap: 4px; padding: 8px 4px; border-radius: 12px;
  border: 1px solid var(--border, #27272a);
  background: color-mix(in srgb, var(--text, #e4e4e7) 3%, transparent);
}
.ibc-world__code { font-size: 9.5px; font-weight: 700; letter-spacing: 0.12em; color: var(--muted, #a1a1aa); }
.ibc-world__time { font: 700 14px/1 var(--mono, monospace); font-variant-numeric: tabular-nums; color: var(--text-strong, #fff); white-space: nowrap; }
.ibc-world__time sup { margin-left: 2px; font-size: 8px; color: var(--ibc-sub); }

.ibc-panel .ibc-settings { display: flex; justify-content: center; gap: 8px; margin: 0; padding: 0; border: 0; }
.ibc-chip {
  position: relative; display: inline-flex; align-items: center; min-height: 30px; padding: 0 12px;
  border-radius: 999px; border: 1px solid var(--border, #27272a);
  color: var(--muted, #a1a1aa); font-size: 11.5px; font-weight: 600; cursor: pointer; user-select: none;
}
.ibc-chip input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.ibc-chip:has(input:checked) {
  color: var(--ibc-ink);
  border-color: color-mix(in srgb, var(--ibc-gold) 45%, transparent);
  background: color-mix(in srgb, var(--ibc-gold) 12%, transparent);
}

/* ── plugin clock sections ────────────────────────────────────────────── */
.ibc-sections { display: grid; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border, #27272a); }
.ibc-sections__toggles { display: grid; gap: 6px; }
.ibc-switch {
  position: relative; display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 10px;
  border-radius: 12px; cursor: pointer; user-select: none;
  background: color-mix(in srgb, var(--text, #e4e4e7) 3%, transparent);
  border: 1px solid var(--border, #27272a);
}
.ibc-switch input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.ibc-switch__track {
  position: relative; flex: 0 0 34px; height: 20px; border-radius: 10px;
  background: color-mix(in srgb, var(--text, #e4e4e7) 16%, transparent);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
  transition: background 0.2s ease;
}
.ibc-switch__thumb {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--text-strong, #fff); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.ibc-switch:has(input:checked) .ibc-switch__track { background: var(--ibc-gold); }
.ibc-switch:has(input:checked) .ibc-switch__thumb { transform: translateX(14px); background: #fff; }
.ibc-switch__label { font-size: 12.5px; font-weight: 650; color: var(--text-strong, #fff); }
.ibc-switch__source { margin-left: auto; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted-strong, #71717a); }
.ibc-section__empty { font-size: 12px; color: var(--muted, #a1a1aa); padding: 8px 2px; }

/* ── alarm stop ───────────────────────────────────────────────────────── */
.ibc-stop {
  display: inline-flex; align-items: center; gap: 8px; height: var(--cb-h, 38px); padding: 0 20px;
  border: 0; border-radius: 999px; cursor: pointer; font: 700 13px/1 var(--mono, monospace); color: #fff;
  background: linear-gradient(180deg, #ff5a5a, #c00);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 0 22px rgba(255, 0, 0, 0.55);
  animation: ibc-alarm 0.6s ease-in-out infinite alternate;
}
@keyframes ibc-alarm { to { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.3), 0 0 34px rgba(255, 0, 0, 0.85); } }

/* ── legacy alarm/timer rows, re-skinned inside the panel ─────────────── */
.ibc-panel .tc-add-form { gap: 6px; }
.ibc-panel .tc-input, .ibc-panel .tc-quick-btn, .ibc-panel .tc-btn { border-radius: 10px; }
.ibc-panel .tc-alarm-item, .ibc-panel .tc-timer-item { border-radius: 12px; }
:root[data-theme="light"] .ibc-panel .tc-input { background: #fff; color: var(--text, #18181b); }
:root[data-theme="light"] .ibc-panel .tc-alarm-time,
:root[data-theme="light"] .ibc-panel .tc-timer-display { color: var(--ibc-ink); text-shadow: none; }
:root[data-theme="light"] .ibc-panel .tc-empty { color: var(--muted, #52525b); }

@media (max-width: 600px) {
  .ibc-panel { top: calc(100% + 8px); border-radius: 16px; }
  .ibc-hero__time { font-size: 38px; }
  .ibc-world__time { font-size: 13px; }
}
@media (prefers-reduced-motion: reduce) {
  .ibc-pill, .ibc-pill__tick, .ibc-switch__thumb, .ibc-switch__track { transition: none; }
  .ibc-pill:hover { transform: none; }
  .ibc-pill__colon, .ibc-panel, .ibc-stop { animation: none; }
}
`;

/** Add the clock stylesheet to <head> once. */
export function ensureClockStyles(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CLOCK_CSS;
  doc.head.appendChild(el);
}
