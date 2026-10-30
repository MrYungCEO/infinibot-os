/**
 * Plugins page styles — list + detail layout on core tokens (--card,
 * --border, --text, --muted, --accent, --ok/--warn/--danger), so it follows
 * the global light/dark theme. Stacks to one column at ≤ 760px.
 */

import { css } from "lit";

export const PLUGINS_STYLES = css`
  :host {
    display: block;
    padding: 16px;
    color: var(--pp-fg);
    font-family: var(--font-body, inherit);
    /* Body text: --card-foreground, not --text — the palette applier writes a
       dark-theme --text inline on :root even in light mode (core bug). */
    --pp-fg: var(--card-foreground, var(--text, #e4e4e7));
    --pp-line: var(--border, #27272a);
    --pp-line-strong: var(--border-strong, #3f3f46);
    --pp-card: var(--card, #0f0f0f);
    --pp-raised: var(--bg-elevated, #111111);
    --pp-hover: var(--bg-hover, #1a1a1a);
    --pp-muted: var(--muted, #a1a1aa);
    --pp-strong: var(--text-strong, #ffffff);
    --pp-accent: var(--accent, var(--g-primary, #fbbf24));
    --pp-ok: var(--ok, #22c55e);
    --pp-warn: var(--warn, #f59e0b);
    --pp-danger: var(--danger, #ef4444);
    --pp-radius: var(--radius-xl, 6px);
    /* Accent used as TEXT: pulled toward the strong text colour so it keeps
       contrast on both the dark and the light surface. */
    --pp-accent-text: color-mix(in srgb, var(--pp-accent) 62%, var(--pp-strong));
  }
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; }

  .pp-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .pp-title { font-size: 18px; font-weight: 600; color: var(--pp-strong); margin: 0; }
  .pp-sub { color: var(--pp-muted); font-size: 12px; margin-top: 2px; }
  .pp-search {
    background: var(--pp-raised); border: 1px solid var(--pp-line); border-radius: var(--pp-radius);
    color: var(--pp-fg); padding: 7px 10px; font-size: 12px; width: 220px; max-width: 100%;
  }
  .pp-search:focus { outline: 2px solid var(--pp-accent); outline-offset: 1px; }

  .pp-layout { display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); gap: 14px; align-items: start; }

  /* ── list ── */
  .pp-list { display: flex; flex-direction: column; gap: 6px; }
  .pp-item {
    display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; gap: 10px; align-items: center;
    padding: 10px; border: 1px solid var(--pp-line); border-radius: var(--pp-radius);
    background: var(--pp-card); cursor: pointer; text-align: left; width: 100%;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .pp-item:hover { background: var(--pp-hover); }
  .pp-item[aria-current="true"] { border-color: color-mix(in srgb, var(--pp-accent) 65%, transparent); box-shadow: inset 3px 0 0 var(--pp-accent); }
  .pp-item:focus-visible { outline: 2px solid var(--pp-accent); outline-offset: 2px; }
  .pp-mono {
    width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center;
    font-weight: 700; font-size: 12px; letter-spacing: 0.02em;
    color: color-mix(in srgb, var(--plugin-accent, var(--pp-accent)) 62%, var(--pp-strong));
    background: color-mix(in srgb, var(--plugin-accent, var(--pp-accent)) 14%, var(--pp-card));
    border: 1px solid color-mix(in srgb, var(--plugin-accent, var(--pp-accent)) 40%, transparent);
  }
  .pp-mono.lg { width: 48px; height: 48px; font-size: 15px; border-radius: 10px; }
  .pp-item-main { min-width: 0; }
  .pp-item-name { font-weight: 600; color: var(--pp-strong); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pp-item-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: 11px; color: var(--pp-muted); margin-top: 3px; align-items: center; }

  .pp-pill {
    display: inline-flex; align-items: center; gap: 4px; font-size: 10px; letter-spacing: 0.04em;
    padding: 1px 7px; border-radius: 100px; border: 1px solid var(--pp-line-strong); color: var(--pp-muted);
    white-space: nowrap; text-transform: uppercase;
  }
  .pp-pill.tier-first-party { color: var(--pp-accent-text); border-color: color-mix(in srgb, var(--pp-accent) 45%, transparent); }
  .pp-pill.tier-verified { color: var(--info, #3b82f6); border-color: color-mix(in srgb, var(--info, #3b82f6) 45%, transparent); }
  .pp-pill.update { color: var(--pp-ok); border-color: color-mix(in srgb, var(--pp-ok) 45%, transparent); }
  .pp-pill.live { color: var(--pp-ok); border-color: color-mix(in srgb, var(--pp-ok) 40%, transparent); text-transform: none; }
  .pp-pill.saved { text-transform: none; }

  .pp-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; background: var(--pp-muted); }
  .pp-dot.ok { background: var(--pp-ok); }
  .pp-dot.degraded { background: var(--pp-warn); }
  .pp-dot.error { background: var(--pp-danger); }
  .pp-dot.off { background: var(--pp-line-strong); }

  /* ── switch ── */
  .pp-switch {
    position: relative; width: 36px; height: 20px; flex: none; border-radius: 100px; cursor: pointer; padding: 0;
    border: 1px solid var(--pp-line-strong); background: var(--pp-raised);
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .pp-switch::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
    background: var(--pp-muted); transition: transform 0.15s ease, background 0.15s ease;
  }
  .pp-switch[aria-checked="true"] { background: color-mix(in srgb, var(--pp-accent) 28%, transparent); border-color: color-mix(in srgb, var(--pp-accent) 70%, transparent); }
  .pp-switch[aria-checked="true"]::after { transform: translateX(16px); background: var(--pp-accent); }
  .pp-switch:disabled { opacity: 0.45; cursor: not-allowed; }
  .pp-switch:focus-visible { outline: 2px solid var(--pp-accent); outline-offset: 2px; }

  /* ── detail ── */
  .pp-detail { border: 1px solid var(--pp-line); border-radius: var(--pp-radius); background: var(--pp-card); min-width: 0; }
  .pp-dhead { display: flex; gap: 12px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--pp-line); flex-wrap: wrap; }
  .pp-dhead-main { flex: 1; min-width: 180px; }
  .pp-dname { font-size: 16px; font-weight: 600; color: var(--pp-strong); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pp-dmeta { color: var(--pp-muted); font-size: 12px; margin-top: 3px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .pp-dactions { display: flex; align-items: center; gap: 10px; }
  .pp-back { display: none; }

  .pp-tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--pp-line); overflow-x: auto; scrollbar-width: none; }
  .pp-tabs::-webkit-scrollbar { display: none; }
  .pp-tab {
    background: none; border: none; border-bottom: 2px solid transparent; padding: 10px 10px 8px; cursor: pointer;
    font-size: 12px; color: var(--pp-muted); white-space: nowrap;
  }
  .pp-tab:hover { color: var(--pp-fg); }
  .pp-tab[aria-selected="true"] { color: var(--pp-strong); border-bottom-color: var(--pp-accent); }
  .pp-tab:focus-visible { outline: 2px solid var(--pp-accent); outline-offset: -2px; }
  .pp-body { padding: 16px; }

  .pp-section { margin-bottom: 18px; }
  .pp-section:last-child { margin-bottom: 0; }
  .pp-h { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--pp-muted); margin: 0 0 8px; font-weight: 600; }
  .pp-p { font-size: 13px; line-height: 1.5; margin: 0 0 8px; }
  .pp-muted { color: var(--pp-muted); }
  .pp-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; font-size: 12px; }
  .pp-kv dt { color: var(--pp-muted); }
  .pp-kv dd { margin: 0; overflow-wrap: anywhere; }
  .pp-code { font-family: var(--mono, monospace); font-size: 11px; }
  .pp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .pp-chip { font-size: 11px; padding: 3px 8px; border-radius: 6px; background: var(--pp-raised); border: 1px solid var(--pp-line); }

  .pp-rows { display: flex; flex-direction: column; border: 1px solid var(--pp-line); border-radius: var(--pp-radius); overflow: hidden; }
  .pp-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 12px; border-top: 1px solid var(--pp-line); }
  .pp-row:first-child { border-top: none; }
  .pp-row-title { font-size: 12px; color: var(--pp-strong); overflow-wrap: anywhere; }
  .pp-row-sub { font-size: 11px; color: var(--pp-muted); margin-top: 2px; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
  .pp-row.off .pp-row-title { color: var(--pp-muted); }
  .pp-group-h { font-size: 11px; color: var(--pp-muted); padding: 7px 12px; background: var(--pp-raised); border-top: 1px solid var(--pp-line); font-weight: 600; letter-spacing: 0.02em; }
  .pp-group-h:first-child { border-top: none; }

  .pp-btn {
    background: var(--pp-raised); border: 1px solid var(--pp-line-strong); color: var(--pp-fg);
    font-size: 12px; padding: 6px 12px; border-radius: var(--pp-radius); cursor: pointer; white-space: nowrap;
  }
  .pp-btn:hover:not(:disabled) { border-color: var(--pp-accent); }
  .pp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .pp-btn.primary { background: var(--pp-accent); color: #0a0a0a; border-color: var(--pp-accent); font-weight: 600; }
  .pp-btn.danger { color: var(--pp-danger); border-color: color-mix(in srgb, var(--pp-danger) 50%, transparent); }
  .pp-btn.danger.solid { background: var(--pp-danger); color: #fff; }
  .pp-btn:focus-visible { outline: 2px solid var(--pp-accent); outline-offset: 2px; }
  .pp-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }

  .pp-note { font-size: 12px; padding: 8px 10px; border-radius: var(--pp-radius); border: 1px solid var(--pp-line); background: var(--pp-raised); margin-bottom: 12px; line-height: 1.45; }
  .pp-note.ok { border-color: color-mix(in srgb, var(--pp-ok) 45%, transparent); }
  .pp-note.warn { border-color: color-mix(in srgb, var(--pp-warn) 55%, transparent); }
  .pp-note.err { border-color: color-mix(in srgb, var(--pp-danger) 55%, transparent); color: var(--pp-danger); }

  /* ── forms ── */
  .pp-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
  .pp-label { font-size: 12px; color: var(--pp-strong); font-weight: 500; }
  .pp-help { font-size: 11px; color: var(--pp-muted); }
  .pp-input, .pp-select {
    background: var(--pp-raised); border: 1px solid var(--pp-line); border-radius: var(--pp-radius);
    color: var(--pp-fg); padding: 7px 9px; font-size: 12px; width: 100%; max-width: 420px;
  }
  .pp-input:focus, .pp-select:focus { outline: 2px solid var(--pp-accent); outline-offset: 1px; }
  .pp-seg { display: inline-flex; border: 1px solid var(--pp-line-strong); border-radius: var(--pp-radius); overflow: hidden; }
  .pp-seg button { background: none; border: none; padding: 6px 12px; font-size: 12px; cursor: pointer; color: var(--pp-muted); }
  .pp-seg button[aria-pressed="true"] { background: color-mix(in srgb, var(--pp-accent) 22%, transparent); color: var(--pp-strong); }
  .pp-color { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pp-swatch {
    width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--pp-line-strong); cursor: pointer; padding: 0;
  }
  .pp-swatch[aria-pressed="true"] { outline: 2px solid var(--pp-strong); outline-offset: 2px; }
  input[type="color"].pp-swatch { background: none; }
  input[type="range"] { accent-color: var(--pp-accent); width: 180px; }

  /* ── appearance preview ── */
  .pp-app-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
  .pp-previews { display: grid; grid-template-columns: 1fr; gap: 10px; }
  .pp-preview { border-radius: 10px; padding: 12px; border: 1px solid; font-family: var(--font-body, inherit); }
  .pp-preview.dark { background: #0f0f0f; color: #e4e4e7; border-color: #27272a; }
  .pp-preview.light { background: #ffffff; color: #3f3f46; border-color: #e4e4e7; }
  .pp-pv-inner { border-radius: 8px; padding: calc(var(--plugin-space, 12px)); background: var(--plugin-surface, transparent); zoom: var(--plugin-font-scale, 1); }
  .pp-pv-top { display: flex; align-items: center; gap: 8px; margin-bottom: calc(var(--plugin-space, 12px) * 0.75); }
  .pp-pv-title { font-weight: 600; font-size: 13px; }
  .pp-pv-accent { color: var(--plugin-accent); font-size: 12px; font-weight: 600; }
  .pp-pv-btn { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; background: var(--plugin-accent); color: #000; margin-top: 6px; }
  .pp-pv-meta { font-size: 10px; opacity: 0.75; margin-top: 8px; font-family: var(--mono, monospace); }
  .pp-pv-row { height: calc(8px * var(--plugin-density-scale, 1)); margin: calc(5px * var(--plugin-density-scale, 1)) 0; border-radius: 4px; background: color-mix(in srgb, currentColor 12%, transparent); }

  .pp-logs {
    font-family: var(--mono, monospace); font-size: 11px; max-height: 280px; overflow: auto;
    border: 1px solid var(--pp-line); border-radius: var(--pp-radius); background: var(--pp-raised); padding: 8px 10px;
  }
  .pp-log { display: grid; grid-template-columns: 84px 44px minmax(0, 1fr); gap: 8px; padding: 2px 0; }
  .pp-log .lvl-error { color: var(--pp-danger); }
  .pp-log .lvl-warn { color: var(--pp-warn); }
  .pp-log .msg { overflow-wrap: anywhere; }

  /* ── modal ── */
  .pp-modal-bg { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: grid; place-items: center; z-index: 50; padding: 16px; }
  .pp-modal { background: var(--pp-card); border: 1px solid var(--pp-line-strong); border-radius: 10px; max-width: 460px; width: 100%; padding: 18px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45); }
  .pp-modal h3 { margin: 0 0 8px; font-size: 15px; color: var(--pp-strong); }
  .pp-radio { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; padding: 8px; border: 1px solid var(--pp-line); border-radius: var(--pp-radius); margin-bottom: 6px; cursor: pointer; }
  .pp-radio input { margin-top: 2px; accent-color: var(--pp-accent); }

  .pp-empty { color: var(--pp-muted); padding: 24px; text-align: center; font-size: 13px; }

  @media (max-width: 900px) {
    .pp-app-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 760px) {
    :host { padding: 10px; }
    .pp-layout { grid-template-columns: 1fr; }
    .pp-layout.has-detail .pp-list-col { display: none; }
    .pp-layout:not(.has-detail) .pp-detail { display: none; }
    .pp-back { display: inline-flex; }
    .pp-search { width: 100%; }
    .pp-body { padding: 12px; }
    .pp-dhead { padding: 12px; }
    .pp-kv { grid-template-columns: 1fr; gap: 2px; }
    .pp-kv dd { margin-bottom: 6px; }
    .pp-log { grid-template-columns: 80px minmax(0, 1fr); }
    .pp-log .lvl { display: none; }
  }
`;
