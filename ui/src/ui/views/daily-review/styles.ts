/**
 * Daily Review styles, scoped under `.dr-root` (inside a `.gt-scope` so the
 * shared glass tokens apply). Chart colours are role variables: the dark
 * values are the validated reference steps for a dark surface, the light
 * block swaps in the light steps (selected, not auto-flipped). The gold
 * sequential ramps (--dr-q1..5) pass the dataviz validator in --ordinal mode
 * against the dark (#15130e) and light (#fffdf8) surfaces.
 */
export const DAILY_REVIEW_CSS = /* css */ `
.dr-root {
  --dr-s1: #3987e5; --dr-s2: #d95926; --dr-s3: #199e70; --dr-s4: #c98500;
  --dr-s5: #d55181; --dr-s6: #008300; --dr-s7: #9085e9; --dr-s8: #e66767;
  --dr-other: #6b6a64;
  --dr-good: #0ca30c; --dr-warn: #fab219; --dr-serious: #ec835a; --dr-crit: #d03b3b;
  --dr-muted: #898781;
  --dr-gold: var(--gt-gold, #fbbf24);
  --dr-q0: rgba(255,255,255,0.05);
  --dr-q1: #5e4a1c; --dr-q2: #86682a; --dr-q3: #b08528; --dr-q4: #d9a832; --dr-q5: #f6cf5a;
  --dr-grid: rgba(255,255,255,0.07);
  --dr-axis: #898781;
  --dr-ink: var(--gt-fg, #f0efec);
  --dr-ink-2: var(--gt-dim, #c3c2b7);
  --dr-card: var(--gt-surface, rgba(255,255,255,0.04));
  --dr-line: var(--gt-line, rgba(255,255,255,0.07));
  display: flex; flex-direction: column; gap: 18px;
  padding: 4px 0 48px;
  color: var(--dr-ink);
  font-variant-numeric: normal;
}
:root[data-theme="light"] .dr-root {
  --dr-s1: #2a78d6; --dr-s2: #eb6834; --dr-s3: #1baf7a; --dr-s4: #eda100;
  --dr-s5: #e87ba4; --dr-s6: #008300; --dr-s7: #6250d6; --dr-s8: #e34948;
  --dr-other: #b5b3ab;
  --dr-q0: rgba(24,24,27,0.05);
  --dr-q1: #d9ad45; --dr-q2: #bf8e24; --dr-q3: #9c7016; --dr-q4: #78530d; --dr-q5: #553905;
  --dr-grid: rgba(24,24,27,0.08);
  --dr-axis: #6f6d66;
}
.dr-root * { box-sizing: border-box; }
.dr-root button { font: inherit; }

/* ── Header controls ─────────────────────────────── */
.dr-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.dr-tabs { display: inline-flex; padding: 3px; gap: 2px; border-radius: 999px; border: 1px solid var(--dr-line); background: var(--dr-card); }
.dr-tab { border: 0; background: transparent; color: var(--dr-ink-2); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; font-weight: 600; min-height: 34px; }
.dr-tab[aria-selected="true"] { background: color-mix(in srgb, var(--dr-gold) 18%, transparent); color: var(--dr-ink); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dr-gold) 45%, transparent); }
.dr-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dr-select, .dr-btn, .dr-date {
  height: 34px; border-radius: 10px; border: 1px solid var(--dr-line); background: var(--dr-card);
  color: var(--dr-ink); padding: 0 10px; font-size: 13px;
}
.dr-btn { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 600; }
.dr-btn svg { width: 15px; height: 15px; }
.dr-btn:hover, .dr-select:hover { border-color: color-mix(in srgb, var(--dr-gold) 45%, transparent); }
.dr-btn--gold { background: color-mix(in srgb, var(--dr-gold) 20%, transparent); border-color: color-mix(in srgb, var(--dr-gold) 50%, transparent); }
.dr-btn[disabled] { opacity: .55; cursor: progress; }
.dr-daynav { display: inline-flex; gap: 6px; align-items: center; }
.dr-note { font-size: 12px; color: var(--dr-ink-2); }
.dr-banner { border: 1px solid color-mix(in srgb, var(--dr-warn) 40%, transparent); background: color-mix(in srgb, var(--dr-warn) 8%, transparent); border-radius: 12px; padding: 10px 14px; font-size: 13px; color: var(--dr-ink-2); display: flex; gap: 8px; align-items: center; }
.dr-banner svg { width: 16px; height: 16px; color: var(--dr-warn); flex: none; }

/* ── Cards & grid ─────────────────────────────── */
.dr-grid-2 { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 16px; }
.dr-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.dr-card { border-radius: var(--gt-radius, 18px); border: 1px solid var(--dr-line); background: var(--dr-card); box-shadow: var(--gt-shadow); padding: 16px 18px; min-width: 0; }
.dr-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.dr-card-title { font-size: 14px; font-weight: 700; letter-spacing: .01em; margin: 0; display: flex; align-items: center; gap: 8px; }
.dr-card-title svg { width: 16px; height: 16px; color: var(--dr-gold); }
.dr-card-sub { font-size: 12px; color: var(--dr-ink-2); }

/* ── Hero score ─────────────────────────────── */
.dr-hero { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 22px; align-items: center; }
.dr-score { width: 148px; height: 148px; position: relative; }
.dr-score svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.dr-score-track { fill: none; stroke: var(--dr-q0); stroke-width: 10; }
.dr-score-arc { fill: none; stroke: var(--dr-gold); stroke-width: 10; stroke-linecap: round; transition: stroke-dasharray .6s var(--gt-ease, ease); }
.dr-score-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.dr-score-value { font-size: 44px; font-weight: 750; line-height: 1; letter-spacing: -.02em; }
.dr-score-grade { font-size: 12px; color: var(--dr-ink-2); margin-top: 4px; text-transform: uppercase; letter-spacing: .12em; }
.dr-hero-share { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--dr-line); }
.dr-stackbar { display: flex; gap: 2px; height: 14px; border-radius: 5px; overflow: hidden; margin-bottom: 12px; }
.dr-stackbar span { min-width: 3px; }
.dr-hero-meta { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dr-delta { font-size: 13px; color: var(--dr-ink-2); }
.dr-delta b { color: var(--dr-ink); }
.dr-spark { width: 100%; max-width: 320px; height: 52px; overflow: visible; }
.dr-spark-line { fill: none; stroke: var(--dr-gold); stroke-width: 2; stroke-linejoin: round; }
.dr-spark-avg, .dr-line-avg { stroke: var(--dr-axis); stroke-width: 1.5; stroke-dasharray: 4 4; fill: none; }
.dr-spark-dot { fill: var(--dr-gold); stroke: var(--bg, #0d0d0d); stroke-width: 2; }
.dr-hit { fill: transparent; }

/* ── Score breakdown ─────────────────────────────── */
.dr-breakdown { width: 100%; border-collapse: collapse; font-size: 13px; }
.dr-breakdown td { padding: 6px 4px; border-bottom: 1px solid var(--dr-line); vertical-align: top; }
.dr-breakdown td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dr-breakdown .neg { color: var(--dr-crit); }
.dr-breakdown .pos { color: var(--dr-ink); }
.dr-breakdown .dr-note { display: block; margin-top: 1px; }
.dr-formula { margin-top: 10px; font-size: 12px; color: var(--dr-ink-2); line-height: 1.5; }

/* ── KPI tiles ─────────────────────────────── */
.dr-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.dr-kpi { border-radius: 14px; border: 1px solid var(--dr-line); background: var(--dr-card); padding: 12px 14px; min-width: 0; }
.dr-kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--dr-ink-2); display: flex; gap: 6px; align-items: center; }
.dr-kpi-label svg { width: 13px; height: 13px; color: var(--dr-gold); }
.dr-kpi-value { font-size: 26px; font-weight: 720; margin-top: 4px; letter-spacing: -.01em; }
.dr-kpi-sub { font-size: 12px; color: var(--dr-ink-2); margin-top: 2px; }

/* ── Lists (shipped / in progress / needs you) ─────────────────────────────── */
.dr-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.dr-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 10px; border-radius: 12px; border: 1px solid var(--dr-line); background: color-mix(in srgb, var(--dr-card) 60%, transparent); }
.dr-item.dr-click:hover { border-color: color-mix(in srgb, var(--dr-gold) 45%, transparent); }
.dr-item-ico { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; background: color-mix(in srgb, var(--dr-gold) 12%, transparent); color: var(--dr-gold); }
.dr-item-ico svg { width: 15px; height: 15px; }
.dr-item-ico.good { color: var(--dr-good); background: color-mix(in srgb, var(--dr-good) 14%, transparent); }
.dr-item-ico.warn { color: var(--dr-warn); background: color-mix(in srgb, var(--dr-warn) 14%, transparent); }
.dr-item-ico.crit { color: var(--dr-crit); background: color-mix(in srgb, var(--dr-crit) 14%, transparent); }
.dr-item-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-item-meta { font-size: 12px; color: var(--dr-ink-2); display: flex; gap: 6px; align-items: center; overflow: hidden; white-space: nowrap; }
.dr-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dr-line); color: var(--dr-ink-2); white-space: nowrap; }
.dr-chip-dot { width: 8px; height: 8px; border-radius: 3px; display: inline-block; }
.dr-more { font-size: 12px; color: var(--dr-ink-2); padding: 4px 2px; }

/* ── Summary ─────────────────────────────── */
.dr-bullets { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; line-height: 1.45; }
.dr-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--dr-ink-2); cursor: pointer; }
.dr-switch input { accent-color: var(--dr-gold); width: 16px; height: 16px; }
.dr-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }

/* ── Charts ─────────────────────────────── */
.dr-scroll { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
.dr-gantt, .dr-treemap, .dr-cols, .dr-line, .dr-area { width: 100%; height: auto; display: block; }
.dr-grid { stroke: var(--dr-grid); stroke-width: 1; }
.dr-axis { fill: var(--dr-axis); font-size: 11px; }
.dr-axis-now { fill: var(--dr-gold); }
.dr-axis-html { font-size: 10px; color: var(--dr-axis); }
.dr-now { stroke: var(--dr-gold); stroke-width: 1.5; stroke-dasharray: 3 3; }
.dr-bar { cursor: pointer; }
.dr-bar rect:first-child { stroke: var(--bg, #0d0d0d); stroke-width: 1; }
.dr-bar:hover rect:first-child { filter: brightness(1.18); }
.dr-bar-running { animation: dr-pulse 1.6s ease-in-out infinite; }
@keyframes dr-pulse { 50% { opacity: .62; } }
.dr-bar-label { fill: #fff; font-size: 10.5px; pointer-events: none; font-weight: 600; }
.dr-tm-group { fill: color-mix(in srgb, var(--dr-card) 80%, transparent); stroke: var(--dr-line); }
.dr-tm-head { fill: var(--dr-ink); font-size: 12px; font-weight: 700; pointer-events: none; }
.dr-tm-label { fill: #fff; font-size: 11px; pointer-events: none; font-weight: 600; }
.dr-tm-leaf rect { stroke: var(--bg, #0d0d0d); stroke-width: 1; }
.dr-tm-leaf:hover rect { filter: brightness(1.15); }
.dr-line-main { fill: none; stroke: var(--dr-gold); stroke-width: 2; stroke-linejoin: round; }
.dr-line-dot { fill: var(--dr-gold); }
.dr-area-layer { stroke: var(--bg, #0d0d0d); stroke-width: 1; }
.dr-click { cursor: pointer; }
.dr-cal-cell:hover { stroke: var(--dr-ink); stroke-width: 1; }
.dr-cal-sel { stroke: var(--dr-gold); stroke-width: 2; }
.dr-hbars { display: flex; flex-direction: column; gap: 8px; }
.dr-hbar { display: grid; grid-template-columns: minmax(80px, 140px) minmax(0, 1fr) auto; gap: 10px; align-items: center; font-size: 13px; }
.dr-hbar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dr-hbar-track { height: 12px; border-radius: 4px; background: var(--dr-q0); overflow: hidden; }
.dr-hbar-fill { display: block; height: 100%; border-radius: 4px; }
.dr-hbar-val { font-variant-numeric: tabular-nums; color: var(--dr-ink-2); font-size: 12px; white-space: nowrap; }
.dr-heat { display: flex; flex-direction: column; gap: 3px; }
.dr-heat-row { display: grid; grid-template-columns: 120px repeat(24, minmax(0, 1fr)); gap: 3px; align-items: center; }
.dr-heat-label { font-size: 12px; color: var(--dr-ink-2); }
.dr-heat-cell { height: 22px; border-radius: 4px; }
.dr-heat-cell:hover { outline: 1px solid var(--dr-ink); }
.dr-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--dr-ink-2); margin-top: 10px; }
.dr-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.dr-legend-sw { width: 10px; height: 10px; border-radius: 3px; }
.dr-legend-line { width: 16px; height: 3px; border-radius: 2px; }
.dr-empty, .dr-empty-mini { color: var(--dr-ink-2); font-size: 13px; padding: 18px 4px; }
.dr-empty-mini { padding: 4px 0; font-size: 12px; }
.dr-tip { position: fixed; z-index: 9999; pointer-events: none; max-width: 320px; white-space: pre-line;
  background: var(--gt-surface-solid, #16150f); color: var(--dr-ink); border: 1px solid color-mix(in srgb, var(--dr-gold) 35%, transparent);
  border-radius: 10px; padding: 8px 10px; font-size: 12px; line-height: 1.4; box-shadow: 0 10px 30px rgba(0,0,0,.45); opacity: 0; transition: opacity .08s; }
.dr-tip.on { opacity: 1; }
.dr-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dr-table th { text-align: left; font-weight: 600; color: var(--dr-ink-2); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; padding: 6px; border-bottom: 1px solid var(--dr-line); }
.dr-table td { padding: 7px 6px; border-bottom: 1px solid var(--dr-line); font-variant-numeric: tabular-nums; }
.dr-table tr.dr-click:hover td { background: color-mix(in srgb, var(--dr-gold) 7%, transparent); }

@media (max-width: 1100px) {
  .dr-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .dr-grid-3 { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 820px) {
  .dr-grid-2 { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 520px) {
  .dr-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dr-hero { grid-template-columns: minmax(0, 1fr); justify-items: center; text-align: center; }
  .dr-hero-meta { align-items: center; }
  .dr-score { width: 128px; height: 128px; }
  .dr-score-value { font-size: 38px; }
  .dr-toolbar { flex-direction: column; align-items: stretch; }
  .dr-tabs { justify-content: space-between; }
  .dr-tab { flex: 1; padding: 7px 8px; }
  .dr-card { padding: 14px 12px; }
  .dr-hbar { grid-template-columns: 90px minmax(0, 1fr) auto; }
  .dr-heat-row { grid-template-columns: 96px repeat(24, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .dr-bar-running { animation: none; }
  .dr-score-arc { transition: none; }
}
`;
