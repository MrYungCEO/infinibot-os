/**
 * InfiCode — terminal-aesthetic stylesheet.
 *
 * Black background, gold accent (var(--g-primary)), box-drawing panel chrome,
 * JetBrains Mono. Every accent routes through the existing --g-* tokens so the
 * page recolors with the rest of the app — and with the owner's per-plugin
 * appearance, which the host scopes to this page's container (accent via the
 * scoped --g-primary, --plugin-tint, --plugin-font-scale). Kept theme-agnostic (works in the
 * app's dark shell) and responsive (right column collapses on narrow widths).
 */

import { css } from "lit";

export const INFICODE_STYLES = css`
  :host {
    --ic-bg: var(--glass-base, #070603);
    --ic-mono: "JetBrains Mono", "Fira Code", "SF Mono", ui-monospace, monospace;
    --ic-line: color-mix(in srgb, var(--g-primary) 26%, transparent);
    --ic-dim: var(--g-muted, #71717a);
    display: block;
    height: 100%;
    min-height: 0;
    /* Plugin appearance (Setup › Plugins): owner tint over the terminal bg. */
    background:
      radial-gradient(70% 46% at 54% -12%, color-mix(in srgb, var(--g-primary) 17%, transparent), transparent 72%),
      linear-gradient(var(--plugin-tint, transparent), var(--plugin-tint, transparent)), var(--ic-bg);
    color: var(--glass-fg, var(--g-fg, #f3ede0));
    font-family: var(--ic-mono);
    font-size: calc(12px * var(--plugin-font-scale, 1));
    line-height: 1.35;
  }

  * { box-sizing: border-box; }

  .ic-root {
    display: grid;
    grid-template-columns: minmax(0, 1.65fr) minmax(320px, 0.9fr);
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas:
      "left right"
      "cmd  cmd";
    gap: 8px;
    height: 100%;
    padding: 8px;
  }

  .ic-left {
    grid-area: left;
    display: grid;
    grid-template-rows: minmax(0, 1.5fr) minmax(0, 1fr);
    gap: 8px;
    min-height: 0;
  }
  .ic-right {
    grid-area: right;
    display: grid;
    grid-template-rows: minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1.1fr);
    gap: 8px;
    min-height: 0;
  }

  /* ── Panel chrome ─────────────────────────────────────────── */
  .ic-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--glass-stroke, var(--ic-line));
    border-radius: var(--glass-radius, 14px);
    background: var(--glass-sheen, linear-gradient(180deg, rgba(255,255,255,.07), transparent 34%)), var(--glass-2, color-mix(in srgb, var(--g-primary) 4%, var(--ic-bg)));
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.07)), var(--glass-elev-1, 0 12px 32px rgba(0,0,0,.25));
    backdrop-filter: var(--glass-blur-sm, blur(12px));
    overflow: hidden;
  }
  .ic-panel-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--ic-line);
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    color: var(--g-primary);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: calc(10.5px * var(--plugin-font-scale, 1));
    white-space: nowrap;
  }
  .ic-panel-head .ic-corner { color: var(--ic-dim); }
  .ic-panel-head .ic-title { font-weight: 600; }
  .ic-panel-head .ic-meta {
    margin-left: auto;
    color: var(--ic-dim);
    letter-spacing: 0.08em;
    text-transform: none;
    font-size: calc(10px * var(--plugin-font-scale, 1));
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .ic-mesh-iso-link {
    all: unset;
    cursor: pointer;
    color: var(--g-primary);
    letter-spacing: 0.08em;
  }
  .ic-mesh-iso-link:hover,
  .ic-mesh-iso-link:focus-visible { text-decoration: underline; }
  .ic-panel-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px;
  }
  .ic-panel-body::-webkit-scrollbar { width: 6px; height: 6px; }
  .ic-panel-body::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 24%, transparent);
  }

  .ic-dim { color: var(--ic-dim); }
  .ic-gold { color: var(--g-primary); }

  /* ── Mesh map ─────────────────────────────────────────────── */
  .ic-nodes-rail {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px;
    border-bottom: 1px dashed var(--ic-line);
  }
  .ic-node {
    display: grid;
    gap: 2px;
    min-width: 128px;
    padding: 5px 8px;
    border: 1px solid var(--ic-line);
    background: color-mix(in srgb, var(--g-primary) 5%, transparent);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .ic-node:hover { border-color: var(--g-primary); }
  .ic-node.sel {
    border-color: var(--g-primary);
    background: color-mix(in srgb, var(--g-primary) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-primary) 40%, transparent);
  }
  .ic-node-name { color: var(--g-primary); font-weight: 600; display: flex; gap: 6px; align-items: center; }
  .ic-node-role { font-size: calc(10px * var(--plugin-font-scale, 1)); letter-spacing: 0.1em; text-transform: uppercase; }
  .ic-node-stats { font-size: calc(10px * var(--plugin-font-scale, 1)); color: var(--ic-dim); display: flex; gap: 8px; }
  .ic-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }

  .ic-sector-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 6px;
    padding: 8px;
  }
  .ic-sector {
    border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
    background: color-mix(in srgb, var(--g-primary) 3%, transparent);
    min-height: 76px;
    padding: 4px 6px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .ic-sector:hover { border-color: color-mix(in srgb, var(--g-primary) 40%, transparent); }
  .ic-sector.active {
    border-color: var(--g-primary);
    background: color-mix(in srgb, var(--g-primary) 10%, transparent);
  }
  .ic-sector.sel { box-shadow: inset 0 0 0 1px var(--g-primary); }
  .ic-sector-head {
    display: flex; align-items: baseline; gap: 5px;
    color: var(--g-primary); font-size: calc(9.5px * var(--plugin-font-scale, 1)); letter-spacing: 0.08em;
    text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ic-sector-sys { color: var(--ic-dim); font-size: calc(8.5px * var(--plugin-font-scale, 1)); letter-spacing: 0; text-transform: none; }
  .ic-sector-agents { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .ic-agent {
    display: inline-flex; align-items: center; gap: 3px;
    font-size: calc(11px * var(--plugin-font-scale, 1)); cursor: pointer; padding: 0 2px;
    border: 1px solid transparent; border-radius: 2px;
  }
  .ic-agent:hover { border-color: var(--ic-line); }
  .ic-agent.sel { border-color: var(--g-primary); background: color-mix(in srgb, var(--g-primary) 16%, transparent); }
  .ic-agent-glyph { line-height: 1; }
  .ic-agent-label { font-size: calc(9px * var(--plugin-font-scale, 1)); color: var(--ic-dim); max-width: 66px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ic-agent-prog { font-size: calc(8px * var(--plugin-font-scale, 1)); color: var(--g-primary); }
  .ic-sector-empty { color: color-mix(in srgb, var(--ic-dim) 60%, transparent); font-size: calc(9px * var(--plugin-font-scale, 1)); margin-top: 6px; }

  .ic-map-links { padding: 0 8px 6px; }
  .ic-link-row { font-size: calc(10px * var(--plugin-font-scale, 1)); color: var(--ic-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ic-pulse { color: var(--g-primary); animation: ic-blink 1s steps(2) 3; }
  @keyframes ic-blink { 50% { opacity: 0.25; } }

  /* ── Lists / rows (devices, mesh log) ─────────────────────── */
  .ic-row {
    display: grid;
    gap: 3px;
    padding: 6px 6px;
    border: 1px solid transparent;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
  }
  .ic-row.sel { border-color: var(--g-primary); background: color-mix(in srgb, var(--g-primary) 8%, transparent); }
  .ic-row-top { display: flex; align-items: center; gap: 8px; }
  .ic-row-name { color: var(--g-primary); font-weight: 600; cursor: pointer; }
  .ic-row-badges { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .ic-badge {
    font-size: calc(9px * var(--plugin-font-scale, 1)); letter-spacing: 0.08em; text-transform: uppercase;
    padding: 1px 5px; border: 1px solid var(--ic-line); color: var(--ic-dim);
  }
  .ic-badge.on { color: var(--g-primary); border-color: color-mix(in srgb, var(--g-primary) 45%, transparent); }
  .ic-caps { font-size: calc(9.5px * var(--plugin-font-scale, 1)); color: var(--ic-dim); }

  .ic-ctx-line { display: flex; gap: 6px; align-items: center; margin-top: 3px; }
  .ic-inline-input, .ic-input, .ic-select {
    background: #000; color: #d4d4dc; border: 1px solid var(--ic-line);
    font-family: var(--ic-mono); font-size: calc(11px * var(--plugin-font-scale, 1)); padding: 3px 6px; outline: none;
  }
  .ic-inline-input:focus, .ic-input:focus, .ic-select:focus { border-color: var(--g-primary); }
  .ic-inline-input { flex: 1; min-width: 60px; }

  .ic-btn {
    background: transparent; color: var(--g-primary);
    border: 1px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
    font-family: var(--ic-mono); font-size: calc(10px * var(--plugin-font-scale, 1)); letter-spacing: 0.06em;
    text-transform: uppercase; padding: 3px 8px; cursor: pointer; white-space: nowrap;
  }
  .ic-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--g-primary) 16%, transparent); }
  .ic-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .ic-btn.on { background: var(--g-primary); color: #040404; border-color: var(--g-primary); }
  .ic-btn.danger { color: var(--g-state-danger, #f87171); border-color: color-mix(in srgb, #f87171 45%, transparent); }
  .ic-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, #f87171 16%, transparent); }
  .ic-btn-row { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 4px; }

  .ic-view-switch { display: flex; gap: 4px; margin-bottom: 6px; }

  /* ── Fleet: live pulse + site grouping ────────────────────── */
  .ic-dot-pulse { animation: ic-dot-pulse 1.4s ease-out 1; }
  @keyframes ic-dot-pulse {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--g-primary) 55%, transparent); }
    100% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--g-primary) 0%, transparent); }
  }
  .ic-site-head {
    font-weight: 700; font-size: calc(10.5px * var(--plugin-font-scale, 1));
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--ic-dim);
    padding: 8px 6px 3px; border-bottom: 1px dashed var(--ic-line);
    margin-bottom: 4px;
  }
  .ic-site-head:first-child { padding-top: 2px; }

  /* ── Mesh log + throughput ────────────────────────────────── */
  .ic-msg { font-size: calc(10.5px * var(--plugin-font-scale, 1)); display: flex; gap: 6px; padding: 2px 0; border-bottom: 1px dotted color-mix(in srgb, var(--g-primary) 8%, transparent); }
  .ic-msg-time { color: var(--ic-dim); }
  .ic-msg-from { color: var(--g-primary); }
  .ic-msg-arrow { color: var(--ic-dim); }
  .ic-msg-type { color: var(--ic-dim); font-size: calc(9px * var(--plugin-font-scale, 1)); margin-left: auto; text-transform: uppercase; }
  .ic-spark {
    font-size: calc(13px * var(--plugin-font-scale, 1)); letter-spacing: 1px; color: var(--g-primary);
    white-space: nowrap; overflow: hidden;
  }
  .ic-spark-label { font-size: calc(9.5px * var(--plugin-font-scale, 1)); color: var(--ic-dim); display: flex; justify-content: space-between; margin-top: 4px; }

  /* ── Hardware meters ──────────────────────────────────────── */
  .ic-meter-row { display: grid; grid-template-columns: 42px 1fr auto; gap: 8px; align-items: center; padding: 3px 0; }
  .ic-meter-label { color: var(--ic-dim); text-transform: uppercase; font-size: calc(10px * var(--plugin-font-scale, 1)); letter-spacing: 0.08em; }
  .ic-meter-bar { font-size: calc(12px * var(--plugin-font-scale, 1)); letter-spacing: 1px; white-space: nowrap; overflow: hidden; }
  .ic-meter-val { font-size: calc(11px * var(--plugin-font-scale, 1)); text-align: right; min-width: 38px; }
  .ic-hw-host { font-size: calc(10px * var(--plugin-font-scale, 1)); color: var(--ic-dim); margin-bottom: 4px; }

  /* ── Coder ────────────────────────────────────────────────── */
  .ic-coder-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .ic-coder-term { flex: 1; min-height: 120px; background: #040404; }
  .ic-coder-term .xterm-container { width: 100%; height: 100%; }
  .ic-coder-empty { color: var(--ic-dim); padding: 10px; font-size: calc(10.5px * var(--plugin-font-scale, 1)); }

  /* ── Command bar ──────────────────────────────────────────── */
  .ic-cmd {
    grid-area: cmd;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    border: 1px solid var(--glass-stroke-gold, var(--ic-line));
    border-radius: var(--glass-radius, 14px);
    background: var(--glass-sheen, linear-gradient(180deg, rgba(255,255,255,.07), transparent 34%)), var(--glass-2, color-mix(in srgb, var(--g-primary) 6%, var(--ic-bg)));
    box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.07)), var(--glass-elev-2, 0 18px 48px rgba(0,0,0,.3));
    padding: 6px 8px;
  }
  .ic-cmd-prompt { color: var(--g-primary); font-weight: 600; white-space: nowrap; }
  .ic-cmd .ic-input { flex: 1; min-width: 140px; }
  .ic-cmd-note { color: var(--ic-dim); font-size: calc(10px * var(--plugin-font-scale, 1)); margin-left: auto; }

  .ic-toast {
    position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
    z-index: 40; padding: 6px 12px; font-size: calc(11px * var(--plugin-font-scale, 1));
    border: 1px solid var(--g-primary); background: #0a0a0a; color: var(--g-primary);
    max-width: 80vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ic-toast.err { border-color: var(--g-state-danger, #f87171); color: var(--g-state-danger, #f87171); }

  /* ── Responsive: stack the right column under the map ─────── */
  @media (max-width: 900px) {
    .ic-root {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "left" "right" "cmd";
      grid-template-rows: minmax(0, 1.4fr) minmax(0, 1fr) auto;
    }
    .ic-right { grid-template-rows: auto auto auto; }
  }

  :host-context([data-theme="light"]) {
    --ic-bg: var(--glass-base, #f5f0e5);
    --ic-dim: var(--glass-fg-3, #756b59);
    color: var(--glass-fg, #211b13);
  }
  :host-context([data-theme="light"]) :is(.ic-input, .ic-select, .ic-inline-input, .ic-coder-term) {
    background: color-mix(in srgb, var(--glass-base, #fff) 88%, var(--g-primary) 2%);
    color: var(--glass-fg, #211b13);
  }
  @media (prefers-reduced-transparency: reduce) {
    .ic-panel, .ic-cmd { backdrop-filter: none; background: var(--glass-solid, var(--ic-bg)); }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
  }
`;
