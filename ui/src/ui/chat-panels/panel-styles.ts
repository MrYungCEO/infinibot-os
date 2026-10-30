/**
 * Shared black-gold HUD styles for chat panels (card + modal shadow roots).
 * Global :root tokens (--accent/--text/--muted/--border/--ok/--warn/--danger)
 * inherit through the shadow boundary and are used with fallbacks.
 */
import { css } from "lit";

export const panelTokens = css`
  :host {
    /* Black-gold HUD palette. Fixed dark values (not the global --border /
       --bg tokens) so the modal, which mounts at the app root outside the
       dark chat scopes, looks identical to the inline card. */
    --gold: var(--g-primary, #d4af37);
    --surface: #0e0e11;
    --surface-2: rgba(255, 255, 255, 0.035);
    --line: rgba(212, 175, 55, 0.16);
    --edge: rgba(212, 175, 55, 0.32);
    --ink: #e8e6e3;
    --ink-mute: #9a9aa3;
    --pos: #34d399;
    --neg: #fb7185;
    --mid: #f5b04a;
    font-family: var(--font-body, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
    color: var(--ink);
  }
  * { box-sizing: border-box; }
  button { font: inherit; }
`;

export const panelBodyStyles = css`
  .muted { color: var(--ink-mute); }
  .mono { font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
  .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .wrap { flex-wrap: wrap; }
  .grow { flex: 1; min-width: 0; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sec { margin-top: 12px; }
  .sec:first-child { margin-top: 0; }
  .sec-h {
    font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 650;
    color: var(--ink-mute); margin-bottom: 6px; display: flex; align-items: center; gap: 6px;
  }
  .sec-h .n { color: var(--gold); }
  .pill {
    display: inline-flex; align-items: center; gap: 5px; font-size: 11px; line-height: 1;
    padding: 4px 8px; border-radius: 999px; border: 1px solid var(--line);
    background: var(--surface-2); color: var(--ink); white-space: nowrap;
  }
  .pill.gold { color: var(--gold); border-color: color-mix(in srgb, var(--gold) 45%, transparent); }
  .pill.ok { color: var(--pos); border-color: color-mix(in srgb, var(--pos) 40%, transparent); }
  .pill.warn { color: var(--mid); border-color: color-mix(in srgb, var(--mid) 40%, transparent); }
  .pill.danger { color: var(--neg); border-color: color-mix(in srgb, var(--neg) 40%, transparent); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
  .dot.live { box-shadow: 0 0 8px currentColor; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .bar { height: 6px; border-radius: 999px; background: rgba(255, 255, 255, 0.06); overflow: hidden; flex: 1; min-width: 60px; }
  .bar > i {
    display: block; height: 100%; border-radius: inherit;
    background: linear-gradient(90deg, color-mix(in srgb, var(--gold) 70%, #fff 0%), var(--gold));
    box-shadow: 0 0 10px color-mix(in srgb, var(--gold) 50%, transparent);
  }
  .pct { font-size: 12px; font-weight: 650; color: var(--gold); min-width: 36px; text-align: right; }
  .list { display: flex; flex-direction: column; gap: 4px; }
  .li {
    display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px;
    background: var(--surface-2); border: 1px solid transparent; font-size: 12.5px; min-width: 0;
  }
  .li:hover { border-color: var(--line); }
  .li .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .li .s { font-size: 11px; color: var(--ink-mute); white-space: nowrap; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; }
  .tile {
    padding: 9px 10px; border-radius: 9px; border: 1px solid var(--line);
    background: linear-gradient(180deg, color-mix(in srgb, var(--gold) 5%, transparent), transparent);
  }
  .tile .v { font-size: 18px; font-weight: 700; color: var(--ink); line-height: 1.1; }
  .tile .v.gold { color: var(--gold); }
  .tile .v.danger { color: var(--neg); }
  .tile .v.warn { color: var(--mid); }
  .tile .v.ok { color: var(--pos); }
  .tile .k { font-size: 10.5px; color: var(--ink-mute); margin-top: 3px; letter-spacing: 0.02em; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th {
    text-align: left; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 650;
    color: var(--ink-mute); padding: 6px 8px; border-bottom: 1px solid var(--line); position: sticky; top: 0;
    background: var(--surface);
  }
  td { padding: 7px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr:hover td { background: var(--surface-2); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .prose { font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; color: var(--ink); }
  .clamp { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .check { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; padding: 3px 0; }
  .box {
    width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--line); flex: none; margin-top: 1px;
    display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: #000;
  }
  .box.on { background: var(--gold); border-color: var(--gold); }
  .check.done span.txt { color: var(--ink-mute); text-decoration: line-through; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    font-size: 11.5px; padding: 5px 10px; border-radius: 999px; cursor: pointer;
    background: var(--surface-2); color: var(--ink-mute); border: 1px solid var(--line); transition: all 0.12s;
  }
  .chip:hover { color: var(--ink); border-color: var(--gold); }
  .chip.on { background: var(--gold); color: #0b0b0d; border-color: var(--gold); font-weight: 650; cursor: default; }
  .chip[disabled] { opacity: 0.5; cursor: default; }
  .confirm {
    margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px;
    padding: 8px 10px; border-radius: 9px; border: 1px solid color-mix(in srgb, var(--gold) 40%, transparent);
    background: color-mix(in srgb, var(--gold) 8%, transparent);
  }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; font-weight: 600;
    height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--surface-2); color: var(--ink);
  }
  .btn:hover { border-color: var(--gold); color: var(--gold); }
  .btn.primary { background: var(--gold); color: #0b0b0d; border-color: var(--gold); }
  .btn.primary:hover { filter: brightness(1.08); color: #0b0b0d; }
  .btn svg { width: 14px; height: 14px; }
  .viz {
    position: relative; border-radius: 10px; overflow: hidden; border: 1px solid var(--line);
    background: radial-gradient(ellipse at 50% 40%, color-mix(in srgb, var(--gold) 8%, #0b0b0d), #070708);
  }
  .viz agency-world-viz { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
  .viz-ph {
    position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; color: var(--ink-mute); font-size: 12px;
  }
  .state {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center;
    padding: 22px 12px; color: var(--ink-mute); font-size: 12.5px;
  }
  .state.err { color: var(--neg); }
  .state svg { width: 22px; height: 22px; }
  .skel { display: flex; flex-direction: column; gap: 6px; }
  .skel i {
    display: block; height: 12px; border-radius: 6px;
    background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.09), rgba(255,255,255,0.04));
    background-size: 200% 100%; animation: sh 1.2s linear infinite;
  }
  @keyframes sh { to { background-position: -200% 0; } }
  .spin { width: 13px; height: 13px; border: 2px solid var(--line); border-top-color: var(--gold); border-radius: 50%; animation: sp 0.7s linear infinite; flex: none; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
  /* ── plugin panel blocks (plugin-panel.ts) ── */
  .btn.danger { color: var(--neg); border-color: color-mix(in srgb, var(--neg) 40%, transparent); }
  .btn.on { border-color: var(--gold); color: var(--gold); }
  .btn[disabled] { opacity: 0.5; cursor: default; }
  .btn[disabled]:hover { border-color: var(--line); color: var(--ink); }
  .btn.primary[disabled]:hover { color: #0b0b0d; border-color: var(--gold); }
  .p-alert {
    display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 10px;
    border: 1px solid var(--line); background: var(--surface-2); font-size: 12.5px; line-height: 1.45;
  }
  .p-alert.danger { border-color: color-mix(in srgb, var(--neg) 45%, transparent); background: color-mix(in srgb, var(--neg) 8%, transparent); }
  .p-alert.warn { border-color: color-mix(in srgb, var(--mid) 45%, transparent); background: color-mix(in srgb, var(--mid) 7%, transparent); }
  .p-alert.ok { border-color: color-mix(in srgb, var(--pos) 40%, transparent); background: color-mix(in srgb, var(--pos) 7%, transparent); }
  .p-alert-ic { flex: none; margin-top: 1px; }
  .p-alert-ic svg { width: 16px; height: 16px; }
  .p-alert.danger .p-alert-ic { color: var(--neg); }
  .p-alert.warn .p-alert-ic { color: var(--mid); }
  .p-alert.ok .p-alert-ic { color: var(--pos); }
  .p-alert-t { font-weight: 650; margin-bottom: 2px; }
  .p-alert-m { color: var(--ink); overflow-wrap: anywhere; }
  .p-kv, .p-fields { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 8px 0 0; font-size: 12px; }
  .p-fields { margin: 0; }
  .p-kv dt, .p-fields dt { color: var(--ink-mute); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; padding-top: 1px; }
  .p-kv dd, .p-fields dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .p-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .p-prog { display: flex; flex-direction: column; gap: 7px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); font-size: 12.5px; }
  .p-clock { font-size: 12px; color: var(--gold); white-space: nowrap; }
  .p-bar { height: 7px; }
  .p-bar > i { transition: width 0.9s linear; }
  .p-bar.over > i {
    background: linear-gradient(90deg, transparent, var(--gold), transparent); background-size: 50% 100%;
    background-repeat: no-repeat; animation: pbar 1.4s linear infinite;
  }
  @keyframes pbar { from { background-position: -50% 0; } to { background-position: 150% 0; } }
  .p-hint { font-size: 11px; }
  .p-media { display: grid; gap: 6px; }
  .p-media.multi { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .p-media img, .p-media video {
    display: block; width: 100%; height: auto; max-height: 520px; object-fit: contain; border-radius: 10px;
    border: 1px solid var(--line); background: #050506;
  }
  .p-media.card img, .p-media.card video { max-height: 220px; }
  .p-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .p-input { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--gold) 40%, transparent); background: color-mix(in srgb, var(--gold) 6%, transparent); }
  .p-input-l { font-size: 11.5px; color: var(--ink-mute); }
  .p-input textarea, .p-input input, .p-search input {
    width: 100%; font: inherit; font-size: 13px; color: var(--ink); background: rgba(0, 0, 0, 0.35);
    border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; resize: vertical;
  }
  .p-input textarea:focus, .p-input input:focus, .p-search input:focus { outline: none; border-color: var(--gold); }
  .p-filters { display: flex; flex-direction: column; gap: 8px; }
  .p-search { position: relative; display: flex; align-items: center; }
  .p-search svg { position: absolute; left: 10px; width: 14px; height: 14px; color: var(--ink-mute); pointer-events: none; }
  .p-search input { padding-left: 30px; height: 32px; }
  .p-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
  .p-tile {
    position: relative; display: block; aspect-ratio: 1; padding: 0; overflow: hidden; cursor: pointer; text-align: left;
    border-radius: 10px; border: 1px solid var(--line); background: #050506; color: var(--ink);
  }
  .p-tile:hover, .p-tile:focus-visible { border-color: var(--gold); outline: none; }
  .p-tile img, .p-tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .p-tile .p-ph { position: absolute; inset: 0; display: grid; place-items: center; color: var(--ink-mute); }
  .p-tile .p-play { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: rgba(0,0,0,0.6); color: #fff; }
  .p-tile .p-play svg { width: 11px; height: 11px; }
  .p-tile-b { position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; }
  .p-tile-b .pill { padding: 3px 6px; background: rgba(0, 0, 0, 0.6); }
  .p-tile-t {
    position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 7px 6px; font-size: 11px; line-height: 1.25;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.85)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .p-list { display: flex; flex-direction: column; gap: 6px; }
  .p-row {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 10px; border-radius: 9px;
    background: var(--surface-2); border: 1px solid transparent;
  }
  .p-row:hover { border-color: var(--line); }
  .p-row > .grow { flex: 1 1 180px; }
  .p-row .p-actions { flex: none; }
  .p-row .p-input { flex: 1 1 100%; }
  .p-row-t { font-size: 13px; font-weight: 600; min-width: 0; }
  .p-row-s { font-size: 11.5px; margin-top: 2px; }
  .p-detail { display: flex; flex-direction: column; gap: 10px; }
  .p-detail > .btn { align-self: flex-start; }
  .p-spawned chat-panel-card { margin: 4px 0 0; }
  @media (prefers-reduced-motion: reduce) {
    .dot.live, .skel i, .spin, .p-bar.over > i { animation: none; }
    .p-bar > i { transition: none; }
  }
`;
