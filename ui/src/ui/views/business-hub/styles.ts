/**
 * Business hub — page-scoped glass design system (shadow DOM, so nothing
 * leaks into other pages). Builds on the app tokens (--g-primary, --text,
 * --bg …) and adds its own `--bh-*` layer:
 *   frosted panels with depth · hairline gold gradient borders · a specular
 *   top edge · a slow aurora behind the page · black-gold brand.
 * Light theme, reduced motion and reduced transparency are first-class.
 */

import { css } from "lit";

export const hubStyles = css`
  :host {
    --bh-gold: #d9b45f;
    --bh-gold-2: #f1d38a;
    --bh-bronze: #a8762c;
    --bh-ink-3: #6f5a33;
    --bh-ink-4: #4a3f2a;
    --bh-ink-5: #35302a;
    --bh-text: var(--text-strong, #f4f1ea);
    --bh-text-2: color-mix(in srgb, var(--bh-text) 72%, transparent);
    --bh-text-3: color-mix(in srgb, var(--bh-text) 48%, transparent);
    --bh-bg: #07070a;
    --bh-glass: rgba(24, 22, 18, 0.56);
    --bh-glass-strong: rgba(30, 27, 22, 0.78);
    --bh-glass-hover: rgba(40, 35, 26, 0.62);
    --bh-line: rgba(217, 180, 95, 0.16);
    --bh-line-strong: rgba(217, 180, 95, 0.34);
    --bh-hairline: linear-gradient(135deg, rgba(241, 211, 138, 0.55), rgba(217, 180, 95, 0.08) 38%, rgba(217, 180, 95, 0.04) 62%, rgba(241, 211, 138, 0.32));
    --bh-specular: linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0) 42%);
    --bh-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 18px 50px -18px rgba(0, 0, 0, 0.7), 0 2px 10px rgba(0, 0, 0, 0.35);
    --bh-shadow-lift: 0 1px 0 rgba(255, 255, 255, 0.06) inset, 0 28px 70px -20px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(217, 180, 95, 0.12);
    --bh-blur: blur(22px) saturate(165%);
    --bh-radius: 18px;
    --bh-radius-sm: 12px;
    --bh-ok: #4cc98a;
    --bh-bad: #e36b6b;
    --bh-warn: #e7a74b;
    --bh-font: var(--g-font-family, "Inter", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    --bh-mono: var(--mono, ui-monospace, "SF Mono", Menlo, monospace);
    --bh-ease: cubic-bezier(0.22, 1, 0.36, 1);
    display: block;
    position: relative;
    min-height: 100%;
    color: var(--bh-text);
    font-family: var(--bh-font);
    font-size: 14px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    isolation: isolate;
  }
  :host-context([data-theme="light"]),
  :host-context([data-theme-mode="light"]) {
    --bh-gold: #a77a1e;
    --bh-gold-2: #c8963a;
    --bh-bronze: #8a5d17;
    --bh-ink-3: #d8c08a;
    --bh-ink-4: #e8dab8;
    --bh-ink-5: #f1e9d6;
    --bh-text: #17140f;
    --bh-bg: #f6f3ec;
    --bh-glass: rgba(255, 255, 255, 0.62);
    --bh-glass-strong: rgba(255, 255, 255, 0.86);
    --bh-glass-hover: rgba(255, 255, 255, 0.78);
    --bh-line: rgba(140, 104, 30, 0.16);
    --bh-line-strong: rgba(140, 104, 30, 0.34);
    --bh-hairline: linear-gradient(135deg, rgba(167, 122, 30, 0.5), rgba(167, 122, 30, 0.08) 40%, rgba(167, 122, 30, 0.05) 60%, rgba(167, 122, 30, 0.3));
    --bh-specular: linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0) 40%);
    --bh-shadow: 0 1px 0 rgba(255, 255, 255, 0.9) inset, 0 16px 40px -18px rgba(70, 50, 10, 0.28), 0 2px 8px rgba(70, 50, 10, 0.08);
    --bh-shadow-lift: 0 1px 0 rgba(255, 255, 255, 0.9) inset, 0 26px 60px -20px rgba(70, 50, 10, 0.32), 0 0 0 1px rgba(167, 122, 30, 0.14);
    --bh-ok: #1f9a5c;
    --bh-bad: #c84040;
    --bh-warn: #b9741b;
  }

  * { box-sizing: border-box; }
  button, input, select, textarea { font: inherit; color: inherit; }
  a { color: inherit; }
  [hidden] { display: none !important; }
  :focus-visible { outline: 2px solid var(--bh-gold); outline-offset: 2px; border-radius: 8px; }

  /* ── page + aurora ─────────────────────────────────────────── */
  .page { position: relative; padding: 22px clamp(14px, 2.6vw, 34px) 60px; max-width: 1480px; margin: 0 auto; }
  .aurora { position: absolute; inset: 0; overflow: hidden; z-index: -1; pointer-events: none; }
  .aurora::before, .aurora::after {
    content: ""; position: absolute; width: 62vmax; height: 62vmax; border-radius: 50%; filter: blur(90px); opacity: 0.32;
    background: radial-gradient(circle, rgba(217, 180, 95, 0.55), transparent 62%);
    top: -34vmax; left: -12vmax; animation: drift 38s var(--bh-ease) infinite alternate;
  }
  .aurora::after {
    background: radial-gradient(circle, rgba(168, 118, 44, 0.42), transparent 60%);
    top: auto; bottom: -40vmax; left: auto; right: -18vmax; animation-duration: 46s; opacity: 0.22;
  }
  :host-context([data-theme="light"]) .aurora::before { opacity: 0.22; }
  :host-context([data-theme="light"]) .aurora::after { opacity: 0.14; }
  @keyframes drift { from { transform: translate3d(0, 0, 0) scale(1); } to { transform: translate3d(8vmax, 5vmax, 0) scale(1.12); } }

  /* ── glass surface ─────────────────────────────────────────── */
  .glass {
    position: relative; background: var(--bh-glass); border-radius: var(--bh-radius);
    backdrop-filter: var(--bh-blur); -webkit-backdrop-filter: var(--bh-blur); box-shadow: var(--bh-shadow);
  }
  /* hairline gradient border */
  .glass::before {
    content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;
    background: var(--bh-hairline);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude;
  }
  /* specular top edge */
  .glass::after { content: ""; position: absolute; inset: 1px; border-radius: inherit; background: var(--bh-specular); pointer-events: none; opacity: 0.9; }
  .glass > * { position: relative; z-index: 1; }

  /* ── hero / header ─────────────────────────────────────────── */
  .hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .eyebrow { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--bh-gold); font-weight: 600; }
  h1 { margin: 4px 0 0; font-size: clamp(24px, 2.6vw, 34px); font-weight: 650; letter-spacing: -0.025em; line-height: 1.1; }
  h1 .gold, .gold-text { background: linear-gradient(120deg, var(--bh-gold-2), var(--bh-gold) 45%, var(--bh-bronze)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  h2 { margin: 0; font-size: 15px; font-weight: 620; letter-spacing: -0.01em; }
  h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--bh-text-2); }
  .sub { color: var(--bh-text-2); margin-top: 6px; max-width: 720px; }
  .hero-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  /* segmented nav */
  .nav { position: sticky; top: 0; z-index: 20; margin: 0 -4px 20px; padding: 4px; }
  .seg { display: flex; gap: 2px; padding: 5px; overflow-x: auto; scrollbar-width: none; border-radius: 16px; }
  .seg::-webkit-scrollbar { display: none; }
  .seg button {
    position: relative; flex: 0 0 auto; border: 0; background: transparent; padding: 8px 14px; border-radius: 11px; cursor: pointer;
    color: var(--bh-text-2); font-weight: 560; font-size: 13px; transition: color 0.2s, background 0.25s var(--bh-ease);
    display: inline-flex; align-items: center; gap: 7px; white-space: nowrap;
  }
  .seg button:hover { color: var(--bh-text); background: color-mix(in srgb, var(--bh-gold) 7%, transparent); }
  .seg button[aria-current="page"] {
    color: var(--bh-text); background: linear-gradient(180deg, color-mix(in srgb, var(--bh-gold) 22%, transparent), color-mix(in srgb, var(--bh-gold) 10%, transparent));
    box-shadow: inset 0 0 0 1px var(--bh-line-strong), 0 6px 18px -8px color-mix(in srgb, var(--bh-gold) 60%, transparent);
  }
  .seg .count { font-size: 11px; color: var(--bh-text-3); font-variant-numeric: tabular-nums; }
  .seg svg { width: 15px; height: 15px; opacity: 0.85; }

  /* ── buttons / inputs ──────────────────────────────────────── */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 0 14px; border-radius: 11px;
    border: 1px solid var(--bh-line-strong); background: color-mix(in srgb, var(--bh-glass-strong) 70%, transparent); cursor: pointer;
    font-weight: 560; font-size: 13px; transition: transform 0.15s var(--bh-ease), background 0.2s, border-color 0.2s, box-shadow 0.2s; white-space: nowrap;
  }
  .btn:hover { border-color: var(--bh-gold); background: var(--bh-glass-hover); }
  .btn:active { transform: translateY(1px) scale(0.99); }
  .btn[disabled] { opacity: 0.5; cursor: not-allowed; }
  .btn.primary {
    border-color: transparent; color: #16110a;
    background: linear-gradient(180deg, var(--bh-gold-2), var(--bh-gold) 55%, var(--bh-bronze));
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.45) inset, 0 10px 24px -10px color-mix(in srgb, var(--bh-gold) 80%, transparent);
  }
  .btn.primary:hover { filter: brightness(1.06); }
  :host-context([data-theme="light"]) .btn.primary { color: #fff; }
  .btn.ghost { background: transparent; border-color: transparent; color: var(--bh-text-2); }
  .btn.ghost:hover { color: var(--bh-text); background: color-mix(in srgb, var(--bh-gold) 8%, transparent); }
  .btn.danger { color: var(--bh-bad); border-color: color-mix(in srgb, var(--bh-bad) 40%, transparent); }
  .btn.sm { min-height: 30px; padding: 0 10px; font-size: 12px; border-radius: 9px; }
  .btn svg { width: 15px; height: 15px; }
  .icon-btn { width: 34px; height: 34px; padding: 0; }

  select.input { min-width: 0; max-width: 100%; }
  .maprow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px 12px; align-items: center; }
  .input, select.input, textarea.input {
    width: 100%; min-height: 38px; padding: 8px 12px; border-radius: 11px; border: 1px solid var(--bh-line);
    background: color-mix(in srgb, var(--bh-bg) 40%, transparent); outline: none; transition: border-color 0.2s, box-shadow 0.2s;
  }
  textarea.input { min-height: 120px; resize: vertical; line-height: 1.5; }
  .input:focus { border-color: var(--bh-gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--bh-gold) 18%, transparent); }
  .input::placeholder { color: var(--bh-text-3); }
  label.field { display: grid; gap: 6px; font-size: 12px; color: var(--bh-text-2); font-weight: 550; }
  .field-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .search { position: relative; flex: 1 1 240px; min-width: 0; }
  .search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; opacity: 0.55; }
  .search .input { padding-left: 34px; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .toolbar .spacer { flex: 1; }
  .period-control { display: grid; gap: 7px; justify-items: end; }
  .active-range { display: inline-flex; align-items: center; gap: 7px; color: var(--bh-text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
  .range-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bh-gold); box-shadow: 0 0 10px color-mix(in srgb, var(--bh-gold) 70%, transparent); }
  .custom-range { display: flex; align-items: end; gap: 8px; }
  .custom-range label { display: grid; gap: 3px; color: var(--bh-text-3); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
  .custom-range .input { min-height: 32px; padding: 5px 8px; font-size: 12px; }
  .revenue-range { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 16px; margin-bottom: 14px; }
  .revenue-range > div { display: grid; gap: 3px; }
  .revenue-range b { font-size: 14px; font-variant-numeric: tabular-nums; }
  .mapping-table { max-height: 640px; }
  .mapping-cards { display: none; }
  .mapping-card { display: grid; gap: 9px; padding: 13px; border: 1px solid var(--bh-line); border-radius: 13px; background: color-mix(in srgb, var(--bh-glass-strong) 76%, transparent); }
  .mapping-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .mapping-card-head > div { display: grid; gap: 3px; min-width: 0; }
  .mapping-card-head b { overflow-wrap: anywhere; }
  .mapping-card-head span:not(.chip) { color: var(--bh-text-3); font-size: 11px; }
  .legend.inline { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px; }
  .legend.inline .legend-row { width: auto; }
  .check { display: inline-flex; gap: 8px; align-items: center; font-size: 13px; color: var(--bh-text-2); cursor: pointer; }
  .check input { accent-color: var(--bh-gold); width: 16px; height: 16px; }
  .drill-link { color: var(--bh-gold-2); font-weight: 620; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--bh-gold) 35%, transparent); text-underline-offset: 3px; }
  .invoice-cards { display: none; }
  .invoice-card { width: 100%; display: grid; gap: 7px; padding: 13px; border: 1px solid var(--bh-line); border-radius: 13px; background: color-mix(in srgb, var(--bh-glass-strong) 76%, transparent); text-align: left; cursor: pointer; }
  .invoice-card-head, .invoice-card-money { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .invoice-card-head b { white-space: nowrap; }
  .invoice-card-money { padding-top: 7px; border-top: 1px solid var(--bh-line); }
  .invoice-card-money > span { display: grid; gap: 2px; min-width: 0; }
  .invoice-card-money small { color: var(--bh-text-3); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
  .invoice-card-money b { font-size: 12px; font-variant-numeric: tabular-nums; }

  /* ── layout ────────────────────────────────────────────────── */
  .grid { display: grid; gap: 16px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 16px; }
  .kpis.k3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .kpis.k4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .kpis.k6 { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .kpis.k6 .kpi .value { font-size: clamp(20px, 1.7vw, 26px); }
  svg.i { flex: 0 0 auto; }
  .li > svg.i { width: 18px; height: 18px; color: var(--bh-gold); }
  .cols-2 { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); }
  .cols-2e { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .card { padding: 18px; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .card-head .meta { color: var(--bh-text-3); font-size: 12px; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
  .section-head > .row { flex-wrap: wrap; }
  .stack { display: grid; gap: 10px; }
  .row { display: flex; gap: 10px; align-items: center; }
  .muted { color: var(--bh-text-2); }
  .faint { color: var(--bh-text-3); }
  .small { font-size: 12px; }
  .mono { font-family: var(--bh-mono); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
  .ok { color: var(--bh-ok); }
  .bad { color: var(--bh-bad); }
  .warn { color: var(--bh-warn); }
  .divider { height: 1px; background: var(--bh-line); margin: 14px 0; }

  /* KPI tile */
  .kpi { padding: 16px 18px 14px; min-height: 118px; display: flex; flex-direction: column; gap: 6px; overflow: hidden; transition: transform 0.35s var(--bh-ease), box-shadow 0.35s var(--bh-ease); }
  .kpi:hover { transform: translateY(-2px); box-shadow: var(--bh-shadow-lift); }
  .kpi .label { font-size: 12px; color: var(--bh-text-2); font-weight: 560; display: flex; align-items: center; gap: 6px; }
  .kpi .value { font-size: clamp(22px, 2.1vw, 30px); font-weight: 660; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .kpi .foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; font-size: 12px; color: var(--bh-text-3); }
  .delta { font-weight: 620; font-size: 12px; padding: 2px 7px; border-radius: 999px; font-variant-numeric: tabular-nums; }
  .delta.up { color: var(--bh-ok); background: color-mix(in srgb, var(--bh-ok) 12%, transparent); }
  .delta.down { color: var(--bh-bad); background: color-mix(in srgb, var(--bh-bad) 12%, transparent); }
  .delta.flat { color: var(--bh-text-3); background: color-mix(in srgb, var(--bh-text) 6%, transparent); }

  /* chips / badges */
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 560; border: 1px solid var(--bh-line); color: var(--bh-text-2); background: color-mix(in srgb, var(--bh-gold) 5%, transparent); white-space: nowrap; }
  .chip.gold { color: var(--bh-gold); border-color: var(--bh-line-strong); }
  .chip.ok { color: var(--bh-ok); border-color: color-mix(in srgb, var(--bh-ok) 35%, transparent); background: color-mix(in srgb, var(--bh-ok) 8%, transparent); }
  .chip.bad { color: var(--bh-bad); border-color: color-mix(in srgb, var(--bh-bad) 35%, transparent); background: color-mix(in srgb, var(--bh-bad) 8%, transparent); }
  .chip.warn { color: var(--bh-warn); border-color: color-mix(in srgb, var(--bh-warn) 35%, transparent); background: color-mix(in srgb, var(--bh-warn) 8%, transparent); }
  :host-context([data-theme="light"]) .eyebrow,
  :host-context([data-theme-mode="light"]) .eyebrow { color: #77520d; }
  :host-context([data-theme="light"]) .chip.gold,
  :host-context([data-theme-mode="light"]) .chip.gold { color: #6f4b08; background: rgba(167, 122, 30, .12); }
  button.chip { cursor: pointer; }
  button.chip[aria-pressed="true"] { color: var(--bh-text); border-color: var(--bh-gold); background: color-mix(in srgb, var(--bh-gold) 16%, transparent); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .dot-s { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--stage, var(--bh-gold)); box-shadow: 0 0 10px var(--stage, var(--bh-gold)); }

  .avatar { width: 34px; height: 34px; border-radius: 11px; flex: 0 0 auto; display: grid; place-items: center; font-weight: 650; font-size: 12px; letter-spacing: 0.02em; color: #1a1408;
    background: linear-gradient(135deg, hsl(var(--h, 40) 70% 72%), hsl(var(--h, 40) 55% 48%)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.4); }
  .avatar.lg { width: 52px; height: 52px; border-radius: 16px; font-size: 17px; }

  /* table */
  .table { width: 100%; border-collapse: separate; border-spacing: 0; }
  .table th { text-align: left; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--bh-text-3); font-weight: 600; padding: 10px 12px; border-bottom: 1px solid var(--bh-line); position: sticky; top: 0; background: var(--bh-glass-strong); backdrop-filter: var(--bh-blur); z-index: 1; }
  .table td { padding: 11px 12px; border-bottom: 1px solid color-mix(in srgb, var(--bh-line) 60%, transparent); vertical-align: middle; }
  .table tr.click { cursor: pointer; transition: background 0.15s; }
  .table tr.click:hover td { background: color-mix(in srgb, var(--bh-gold) 6%, transparent); }
  .table .r { text-align: right; }
  .table-wrap { overflow: auto; max-height: min(68vh, 900px); border-radius: var(--bh-radius); }
  .who { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .who .t { min-width: 0; }
  .who .t b { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px; }
  .who .t span { display: block; color: var(--bh-text-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px; }
  .score { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
  .score i { display: block; width: 44px; height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--bh-text) 10%, transparent); overflow: hidden; }
  .score i::after { content: ""; display: block; height: 100%; width: var(--w); background: linear-gradient(90deg, var(--bh-bronze), var(--bh-gold-2)); }

  /* list rows (attention, activity) */
  .list { display: grid; }
  .li { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid color-mix(in srgb, var(--bh-line) 55%, transparent); }
  .li:last-child { border-bottom: 0; }
  .li.click { cursor: pointer; border-radius: 10px; padding: 10px 8px; }
  .li.click:hover { background: color-mix(in srgb, var(--bh-gold) 6%, transparent); }
  .li .grow { flex: 1; min-width: 0; }
  .li .grow b { display: block; font-weight: 580; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .li .grow span { display: block; font-size: 12px; color: var(--bh-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* setup checklist */
  .setup { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .step { display: flex; gap: 10px; align-items: center; padding: 12px; border-radius: 14px; border: 1px dashed var(--bh-line-strong); cursor: pointer; background: transparent; text-align: left; transition: background 0.2s, border-color 0.2s; }
  .step:hover { background: color-mix(in srgb, var(--bh-gold) 7%, transparent); border-color: var(--bh-gold); }
  .step.done { border-style: solid; border-color: color-mix(in srgb, var(--bh-ok) 30%, transparent); opacity: 0.75; }
  .step .tick { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; border: 1px solid var(--bh-line-strong); flex: 0 0 auto; font-size: 12px; }
  .step.done .tick { background: var(--bh-ok); border-color: transparent; color: #fff; }

  /* charts */
  .chart { position: relative; width: 100%; }
  .chart-svg { width: 100%; height: 180px; display: block; overflow: visible; }
  .chart .grid { stroke: var(--bh-line); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .chart .tick { fill: var(--bh-text-3); font-size: 10.5px; font-family: var(--bh-font); }
  .chart .line { fill: none; stroke: var(--bh-gold); stroke-width: 2.2; vector-effect: non-scaling-stroke; stroke-linejoin: round; filter: drop-shadow(0 4px 10px color-mix(in srgb, var(--bh-gold) 45%, transparent)); }
  .chart .cmp { fill: none; stroke: var(--bh-text-3); stroke-width: 1.4; stroke-dasharray: 4 4; vector-effect: non-scaling-stroke; }
  .chart .dot { fill: var(--bh-gold-2); stroke: var(--bh-bg); stroke-width: 2; opacity: 0; transition: opacity 0.15s; }
  .chart .hit:hover .dot { opacity: 1; }
  .chart-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--bh-text-3); font-size: 13px; }
  .bars { display: grid; gap: 9px; }
  .bar-row { display: grid; grid-template-columns: minmax(90px, 1.2fr) 2fr minmax(56px, auto); gap: 10px; align-items: center; font-size: 13px; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-sub { color: var(--bh-text-3); margin-left: 6px; font-size: 11.5px; }
  .bar-track { height: 8px; border-radius: 5px; background: color-mix(in srgb, var(--bh-text) 7%, transparent); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 5px; background: linear-gradient(90deg, var(--bh-bronze), var(--bh-gold) 60%, var(--bh-gold-2)); transform-origin: left; animation: grow 0.9s var(--bh-ease) both; }
  .bar-value { text-align: right; font-variant-numeric: tabular-nums; color: var(--bh-text-2); }
  @keyframes grow { from { transform: scaleX(0); } }
  .funnel { display: grid; gap: 8px; }
  .funnel-step { display: grid; grid-template-columns: 96px 1fr 46px; gap: 10px; align-items: center; font-size: 13px; }
  .funnel-label { color: var(--bh-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .funnel-track { height: 26px; display: flex; justify-content: center; }
  .funnel-fill { height: 100%; border-radius: 8px; display: grid; place-items: center; font-weight: 640; font-size: 12px; color: #1a1408; min-width: 28px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--stage, var(--bh-gold)) 75%, #000 0%), var(--stage, var(--bh-gold))); box-shadow: 0 6px 18px -8px var(--stage, var(--bh-gold)); animation: grow 0.9s var(--bh-ease) both; transform-origin: center; }
  .funnel-conv { color: var(--bh-text-3); font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
  .donut-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .donut { width: 132px; height: 132px; flex: 0 0 auto; }
  .donut-bg { fill: none; stroke: color-mix(in srgb, var(--bh-text) 8%, transparent); stroke-width: 12; }
  .donut-v { fill: var(--bh-text); font-size: 17px; font-weight: 660; font-family: var(--bh-font); }
  .donut-l { fill: var(--bh-text-3); font-size: 9px; font-family: var(--bh-font); letter-spacing: 0.06em; text-transform: uppercase; }
  .legend { display: grid; gap: 6px; flex: 1; min-width: 140px; }
  .legend-row { display: grid; grid-template-columns: 10px 1fr auto; gap: 8px; align-items: center; font-size: 12.5px; }
  .legend-row i { width: 10px; height: 10px; border-radius: 3px; }
  .legend-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--bh-text-2); }
  .spark { width: 96px; height: 28px; overflow: visible; }
  .spark path { fill: none; stroke: var(--bh-gold); stroke-width: 1.8; vector-effect: non-scaling-stroke; }
  .spark-flat { stroke: var(--bh-line-strong); stroke-dasharray: 3 3; }
  .cohort { display: grid; gap: 3px; overflow-x: auto; font-size: 12px; }
  .cohort-row { display: grid; grid-template-columns: 82px 74px repeat(var(--cols), minmax(42px, 1fr)); gap: 3px; align-items: center; }
  .cohort-row.head span { color: var(--bh-text-3); font-size: 11px; text-align: center; }
  .cohort-row.head span:first-child, .cohort-row span:first-child { text-align: left; }
  .cell { height: 28px; border-radius: 6px; display: grid; place-items: center; font-variant-numeric: tabular-nums; font-size: 11px;
    background: color-mix(in srgb, var(--bh-gold) calc(var(--a) * 85%), transparent); color: var(--bh-text); }
  .cell.none { background: color-mix(in srgb, var(--bh-text) 3%, transparent); }
  .empty-mini { color: var(--bh-text-3); font-size: 13px; padding: 14px 0; }

  /* ── pipeline board ───────────────────────────────────────── */
  .board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(260px, 1fr); gap: 12px; overflow-x: auto; padding-bottom: 12px; scroll-snap-type: x proximity; }
  .col { display: flex; flex-direction: column; min-height: 420px; padding: 12px; scroll-snap-align: start; transition: box-shadow 0.2s, transform 0.2s; }
  .col.over { box-shadow: var(--bh-shadow-lift), 0 0 0 2px var(--bh-gold) inset; }
  .col-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px 10px; }
  .col-head b { font-weight: 620; display: flex; align-items: center; gap: 8px; }
  .col-head .sum { font-size: 12px; color: var(--bh-text-3); font-variant-numeric: tabular-nums; }
  .col-body { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 60px; }
  .deal { padding: 11px 12px; border-radius: 13px; cursor: grab; background: var(--bh-glass-strong); border: 1px solid var(--bh-line); box-shadow: 0 6px 16px -10px rgba(0,0,0,0.6);
    transition: transform 0.18s var(--bh-ease), border-color 0.2s, box-shadow 0.2s; }
  .deal:hover { transform: translateY(-1px); border-color: var(--bh-line-strong); box-shadow: 0 14px 30px -14px rgba(0,0,0,0.7); }
  .deal.dragging { opacity: 0.4; }
  .deal b { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .deal .meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--bh-text-3); }
  .deal .val { color: var(--bh-gold); font-weight: 620; font-variant-numeric: tabular-nums; }
  .deal .next { margin-top: 7px; font-size: 12px; color: var(--bh-text-2); display: flex; gap: 6px; align-items: center; }
  .deal.rot { border-color: color-mix(in srgb, var(--bh-warn) 45%, transparent); }
  .col-empty { flex: 1; display: grid; place-items: center; border: 1px dashed var(--bh-line); border-radius: 12px; color: var(--bh-text-3); font-size: 12px; min-height: 80px; text-align: center; padding: 10px; }

  /* ── drawer / modal ───────────────────────────────────────── */
  /* Sheets start below the app chrome: --bh-top is the scroll container's top edge. */
  .scrim { position: fixed; inset: var(--bh-top, 0px) 0 0 0; background: rgba(4, 3, 2, 0.5); backdrop-filter: blur(4px); z-index: 80; animation: fade 0.25s ease both; }
  :host-context([data-theme="light"]) .scrim { background: rgba(40, 30, 10, 0.18); }
  .drawer { position: fixed; top: var(--bh-top, 0px); right: 0; bottom: 0; width: min(620px, 100vw); z-index: 81; display: flex; flex-direction: column;
    border-radius: 22px 0 0 22px; background: var(--bh-glass-strong); animation: slide 0.38s var(--bh-ease) both; overflow: hidden; }
  .drawer-head { padding: 20px 22px 14px; display: flex; gap: 14px; align-items: flex-start; border-bottom: 1px solid var(--bh-line); }
  .drawer-body { padding: 18px 22px 40px; overflow-y: auto; flex: 1; }
  .modal { position: fixed; z-index: 82; left: 50%; top: calc(50% + var(--bh-top, 0px) / 2); transform: translate(-50%, -50%); width: min(640px, calc(100vw - 24px)); max-height: calc(100vh - var(--bh-top, 0px) - 32px); overflow: auto;
    padding: 22px; background: var(--bh-glass-strong); animation: pop 0.32s var(--bh-ease) both; }
  .modal.wide { width: min(980px, calc(100vw - 24px)); }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes slide { from { transform: translateX(40px); opacity: 0; } }
  @keyframes pop { from { transform: translate(-50%, -46%) scale(0.98); opacity: 0; } }
  .tabs-mini { display: flex; gap: 4px; margin: 4px 0 14px; flex-wrap: wrap; }
  .kv { display: grid; grid-template-columns: 120px 1fr; gap: 8px 14px; font-size: 13px; }
  .kv dt { color: var(--bh-text-3); }
  .kv dd { margin: 0; overflow-wrap: anywhere; }

  /* timeline */
  .timeline { position: relative; display: grid; gap: 2px; padding-left: 18px; }
  .timeline::before { content: ""; position: absolute; left: 5px; top: 6px; bottom: 6px; width: 1px; background: linear-gradient(var(--bh-line-strong), transparent); }
  .tl { position: relative; padding: 8px 0 10px; }
  .tl::before { content: ""; position: absolute; left: -17px; top: 13px; width: 9px; height: 9px; border-radius: 50%; background: var(--bh-bg); border: 2px solid var(--tl, var(--bh-gold)); }
  .tl .tl-head { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--bh-text-3); }
  .tl .tl-body { margin-top: 3px; overflow-wrap: anywhere; }

  /* skeleton + empty */
  .sk { border-radius: 10px; background: linear-gradient(90deg, color-mix(in srgb, var(--bh-text) 5%, transparent) 0%, color-mix(in srgb, var(--bh-text) 11%, transparent) 50%, color-mix(in srgb, var(--bh-text) 5%, transparent) 100%);
    background-size: 220% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { to { background-position: -220% 0; } }
  .empty { text-align: center; padding: 46px 20px; display: grid; justify-items: center; gap: 10px; }
  .empty .glyph { width: 62px; height: 62px; border-radius: 20px; display: grid; place-items: center; color: var(--bh-gold);
    background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--bh-gold) 30%, transparent), transparent 70%), color-mix(in srgb, var(--bh-gold) 8%, transparent); box-shadow: inset 0 0 0 1px var(--bh-line-strong); }
  .empty .glyph svg { width: 28px; height: 28px; }
  .empty h2 { font-size: 18px; }
  .empty p { margin: 0; color: var(--bh-text-2); max-width: 440px; }
  .empty .row { justify-content: center; flex-wrap: wrap; margin-top: 6px; }

  .toast { position: fixed; right: 20px; bottom: 20px; z-index: 90; padding: 12px 16px; max-width: min(420px, calc(100vw - 40px)); animation: pop-t 0.3s var(--bh-ease) both; display: flex; gap: 10px; align-items: center; }
  .toast.err { box-shadow: var(--bh-shadow), 0 0 0 1px color-mix(in srgb, var(--bh-bad) 50%, transparent); }
  @keyframes pop-t { from { transform: translateY(10px); opacity: 0; } }
  .banner { padding: 12px 16px; display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .progress { height: 6px; border-radius: 4px; overflow: hidden; background: color-mix(in srgb, var(--bh-text) 8%, transparent); }
  .progress i { display: block; height: 100%; background: linear-gradient(90deg, var(--bh-bronze), var(--bh-gold-2)); transition: width 0.5s var(--bh-ease); }
  .progress.indet i { width: 35%; animation: indet 1.3s var(--bh-ease) infinite; }
  @keyframes indet { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
  pre.code { margin: 0; padding: 14px; border-radius: 12px; background: color-mix(in srgb, var(--bh-bg) 70%, transparent); border: 1px solid var(--bh-line); overflow: auto; font-family: var(--bh-mono); font-size: 12px; white-space: pre-wrap; word-break: break-all; }

  /* ── Lead Autopilot ───────────────────────────────────────── */
  .autopilot-shell { display: grid; grid-template-columns: minmax(230px, .72fr) minmax(0, 2fr); gap: var(--glass-space-4, 16px); align-items: start; }
  .offer-list { position: sticky; top: 12px; min-width: 0; max-height: calc(100vh - 170px); overflow: auto; }
  .offer-list .stack { min-width: 0; overflow: hidden; }
  .offer-editor { display: grid; gap: var(--glass-space-4, 16px); background: var(--glass-sheen, linear-gradient(rgba(255,255,255,.04), transparent)), var(--glass-2, var(--bh-glass)); border-color: var(--glass-stroke, var(--bh-line)); box-shadow: var(--glass-elev-2, var(--bh-shadow)); }
  .offer-row, .campaign-row, .reply-row { box-sizing: border-box; min-width: 0; max-width: 100%; width: 100%; display: flex; align-items: center; gap: 10px; justify-content: space-between; padding: 12px; border: 1px solid transparent; border-radius: var(--glass-radius-sm, 12px); color: var(--glass-fg, var(--bh-text)); background: transparent; text-align: left; cursor: pointer; transition: border-color var(--glass-dur-fast, .16s), background var(--glass-dur-fast, .16s), transform var(--glass-dur-fast, .16s); }
  .offer-row:hover, .campaign-row:hover, .reply-row:hover { background: var(--glass-hover, color-mix(in srgb, var(--bh-gold) 7%, transparent)); transform: var(--glass-lift, translateY(-1px)); }
  .offer-row.active, .campaign-row.active, .reply-row.active { border-color: var(--glass-stroke-gold, var(--bh-gold)); background: var(--glass-gold-tint, color-mix(in srgb, var(--bh-gold) 13%, transparent)); }
  .offer-row > span:first-child, .campaign-row > span:first-child { min-width: 0; }
  .offer-row b, .campaign-row b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .offer-row small, .campaign-row small, .reply-row small { display: block; margin-top: 3px; color: var(--glass-fg-3, var(--bh-text-3)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .form-grid { display: grid; gap: 12px; }
  .form-grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .form-grid label, .offer-editor > label, .playbook-panel label, .wizard-pane label, .reply-copy label { display: grid; gap: 6px; color: var(--glass-fg-2, var(--bh-text-2)); font-size: 12px; font-weight: 620; }
  .area { min-height: 104px; resize: vertical; line-height: 1.55; }
  .area.sm { min-height: 78px; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .split.money { grid-template-columns: 2fr 1fr; }
  .checkline { display: flex !important; align-items: center; gap: 8px !important; min-height: 42px; padding: 10px 12px; border: 1px solid var(--glass-stroke, var(--bh-line)); border-radius: var(--glass-radius-sm, 10px); background: var(--glass-3, rgba(255,255,255,.03)); }
  .checkline input { accent-color: var(--glass-gold, var(--bh-gold)); }
  .check-grid { display: flex; gap: 10px; flex-wrap: wrap; }
  .playbook-panel, .pitch-lab { display: grid; gap: 12px; padding: 18px; border: 1px solid var(--glass-stroke-gold, var(--bh-line-strong)); border-radius: var(--glass-radius-lg, 18px); background: var(--glass-gold-a06, color-mix(in srgb, var(--bh-gold) 6%, transparent)); }
  .pitch-preview { display: grid; gap: 9px; padding: 14px; border-radius: var(--glass-radius, 14px); background: var(--glass-3, var(--bh-glass-strong)); border: 1px solid var(--glass-stroke, var(--bh-line)); }
  .pitch-preview pre { margin: 0; white-space: pre-wrap; font: 12px/1.6 var(--bh-font); color: var(--glass-fg-2, var(--bh-text-2)); }
  .pitch-preview details pre { color: var(--glass-fg-3, var(--bh-text-3)); font-family: var(--bh-mono); }
  .autopilot-layout { display: grid; grid-template-columns: minmax(260px,.75fr) minmax(0,1.65fr); gap: 14px; align-items: start; }
  .run-console { min-height: 430px; }
  .campaign-summary { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 8px; margin: 8px 0 20px; }
  .campaign-summary span { padding: 12px; border-radius: var(--glass-radius-sm, 10px); border: 1px solid var(--glass-stroke, var(--bh-line)); background: var(--glass-3, rgba(255,255,255,.035)); }
  .campaign-summary small, .campaign-summary b { display: block; }
  .campaign-summary small { color: var(--glass-fg-3, var(--bh-text-3)); margin-bottom: 4px; }
  .run-timeline { display: grid; gap: 0; }
  .timeline-event { display: grid; grid-template-columns: 18px 1fr; gap: 8px; min-height: 52px; }
  .timeline-event i { width: 9px; height: 9px; margin-top: 5px; border: 2px solid var(--glass-gold, var(--bh-gold)); border-radius: 50%; position: relative; }
  .timeline-event i::after { content:""; position:absolute; top:9px; left:2px; width:1px; height:39px; background: var(--glass-stroke, var(--bh-line)); }
  .timeline-event:last-child i::after { display:none; }
  .timeline-event b { text-transform: capitalize; }
  .timeline-event small { display:block; color:var(--glass-fg-3,var(--bh-text-3)); margin-top:3px; }
  .wizard-steps { display: grid; grid-template-columns: repeat(5,1fr); gap: 7px; margin: 18px 0; }
  .wizard-steps span { display:flex; align-items:center; gap:7px; padding:9px 10px; border:1px solid var(--glass-stroke,var(--bh-line)); border-radius:var(--glass-radius-sm,10px); color:var(--glass-fg-3,var(--bh-text-3)); font-size:11px; }
  .wizard-steps span i { width:20px; height:20px; display:grid; place-items:center; border-radius:50%; border:1px solid currentColor; font-style:normal; }
  .wizard-steps span.active { color:var(--glass-gold,var(--bh-gold)); border-color:var(--glass-stroke-gold,var(--bh-gold)); background:var(--glass-gold-a10,color-mix(in srgb,var(--bh-gold) 10%,transparent)); }
  .wizard-steps span.done { color:var(--bh-ok); }
  .wizard-pane { min-height: 340px; display:grid; align-content:start; gap:14px; padding:20px; border:1px solid var(--glass-stroke,var(--bh-line)); border-radius:var(--glass-radius-lg,18px); background:var(--glass-3,rgba(255,255,255,.025)); }
  .wizard-pane > p { margin:0; color:var(--glass-fg-2,var(--bh-text-2)); max-width:720px; }
  .sequence-row { display:grid; grid-template-columns:32px 90px 1fr 1.25fr; gap:8px; align-items:center; }
  .step-num { width:28px; height:28px; display:grid; place-items:center; border-radius:50%; background:var(--glass-gold-fill,var(--bh-gold)); color:var(--glass-ink,#211807); font-weight:800; }
  .safety-note { display:flex; gap:9px; padding:13px; border-radius:var(--glass-radius-sm,10px); background:color-mix(in srgb,var(--bh-ok) 9%,transparent); color:var(--glass-fg-2,var(--bh-text-2)); }
  .review-flow { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .review-flow span { padding:10px 12px; border:1px solid var(--glass-stroke-gold,var(--bh-line-strong)); border-radius:999px; background:var(--glass-gold-a10,color-mix(in srgb,var(--bh-gold) 10%,transparent)); }
  .inbox-layout { display:grid; grid-template-columns:minmax(280px,.85fr) minmax(0,1.4fr); gap:14px; align-items:start; }
  .inbox-list { padding:8px; max-height:70vh; overflow:auto; }
  .reply-row { justify-content:flex-start; }
  .reply-row .grow { flex:1; min-width:0; }
  .reply-avatar { width:36px; height:36px; display:grid; place-items:center; border-radius:12px; background:var(--glass-gold-fill,var(--bh-gold)); color:var(--glass-ink,#211807); font-weight:800; flex:0 0 auto; }
  .reply-detail { min-height:470px; }
  .reply-copy { display:grid; gap:16px; }
  .reply-original { padding:16px; border-left:2px solid var(--glass-gold,var(--bh-gold)); background:var(--glass-3,rgba(255,255,255,.03)); border-radius:0 var(--glass-radius-sm,10px) var(--glass-radius-sm,10px) 0; }
  .reply-original small, .reply-copy label > span { color:var(--glass-fg-3,var(--bh-text-3)); text-transform:uppercase; letter-spacing:.08em; font-size:10px; }
  .reply-original p { white-space:pre-wrap; line-height:1.55; }
  .reply-draft { min-height:190px; }
  .booking-layout { display:grid; grid-template-columns:minmax(0,1.5fr) minmax(280px,.72fr); gap:14px; align-items:start; }
  .agenda-day { display:grid; gap:7px; margin-top:16px; }
  .agenda-day h4 { color:var(--glass-gold,var(--bh-gold)); margin:0 0 2px; }
  .booking-row { display:grid; grid-template-columns:80px 1fr auto; gap:12px; align-items:center; padding:12px; border:1px solid var(--glass-stroke,var(--bh-line)); border-radius:var(--glass-radius-sm,10px); background:var(--glass-3,rgba(255,255,255,.025)); }
  .booking-row time { font-weight:760; color:var(--glass-gold-hi,var(--bh-gold-2)); white-space:nowrap; }
  .booking-row span small { display:block; color:var(--glass-fg-3,var(--bh-text-3)); margin-top:3px; }
  .copy-url { display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; margin:16px 0; }
  .copy-url code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:11px; border:1px solid var(--glass-stroke,var(--bh-line)); border-radius:var(--glass-radius-sm,10px); color:var(--glass-gold-hi,var(--bh-gold-2)); }
  .booking-settings { display:grid; gap:10px; }
  .external-link { color:var(--glass-gold-hi,var(--bh-gold-2)); display:flex; align-items:center; gap:6px; }
  .slot-preview { display:grid; gap:7px; }
  .slot-preview span { padding:9px 11px; border:1px solid var(--glass-stroke,var(--bh-line)); border-radius:var(--glass-radius-sm,10px); color:var(--glass-fg-2,var(--bh-text-2)); }
  .compact { width:auto; min-width:190px; }
  .banner.error { color:var(--bh-bad); border-color:color-mix(in srgb,var(--bh-bad) 40%,transparent); }

  /* ── responsive ───────────────────────────────────────────── */
  @media (max-width: 1280px) {
    .kpis.k6 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (max-width: 1100px) {
    .cols-2, .cols-3 { grid-template-columns: minmax(0, 1fr); }
    .kpis.k4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 720px) {
    .page { padding: 14px 12px 70px; }
    .cols-2e { grid-template-columns: minmax(0, 1fr); }
    .kpis, .kpis.k3, .kpis.k4, .kpis.k6 { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .kpi { min-height: 104px; padding: 13px 14px 12px; }
    .kpi .foot .spark { display: none; }
    .card { padding: 14px; }
    .hero { align-items: flex-start; }
    .hero-actions { width: 100%; }
    .hero-actions .btn { flex: 1; }
    .table .hide-sm { display: none; }
    .toolbar > .btn { flex: 1 1 auto; }
    .period-control { width: 100%; justify-items: stretch; }
    /* Period is financial context, not optional chrome: keep every preset and
       the selected value visible instead of hiding All time off-screen. */
    .period-control .chips { flex-wrap: wrap; overflow: visible; padding-bottom: 3px; }
    .active-range { justify-content: center; }
    .custom-range { display: grid; grid-template-columns: 1fr 1fr; }
    .revenue-range { align-items: flex-start; flex-direction: column; }
    .revenue-range .chip { white-space: normal; }
    .maprow { grid-template-columns: minmax(0, 1fr); }
    .invoice-table-wrap { display: none; }
    .invoice-cards { display: grid; gap: 9px; }
    .mapping-table { display: none; }
    .mapping-cards { display: grid; gap: 9px; }
    .who .t b, .who .t span { max-width: 170px; }
    .drawer { width: 100vw; border-radius: 0; }
    .board { grid-auto-columns: minmax(82vw, 1fr); }
    .kv { grid-template-columns: 96px 1fr; }
    .bar-row { grid-template-columns: minmax(70px, 1fr) 1.2fr auto; }
    .funnel-step { grid-template-columns: 76px 1fr 38px; }
    .toast { left: 12px; right: 12px; bottom: 12px; }
    .autopilot-shell, .autopilot-layout, .inbox-layout, .booking-layout { grid-template-columns:minmax(0,1fr); }
    .offer-list { position:static; max-height:none; }
    .form-grid.two { grid-template-columns:minmax(0,1fr); }
    .campaign-summary { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .wizard-steps { display:flex; overflow:auto; }
    .wizard-steps span { min-width:max-content; }
    .sequence-row { grid-template-columns:30px 74px minmax(0,1fr); }
    .sequence-row input:last-child { grid-column:2 / -1; }
    .booking-row { grid-template-columns:62px minmax(0,1fr); }
    .booking-row .chip { grid-column:2; justify-self:start; }
    .compact { width:100%; }
  }

  /* ── accessibility preferences ────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .glass, .drawer, .modal, .table th { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--bh-glass-strong); }
    :host { --bh-glass: var(--bh-glass-strong); }
    .aurora { display: none; }
  }
  :host-context(.low-power) .aurora, :host-context([data-low-power]) .aurora { display: none; }
`;
