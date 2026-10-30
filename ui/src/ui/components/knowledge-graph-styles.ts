/**
 * Styles for the knowledge graph's interactive layer: proactive HUD, hover
 * overlay, context menu, bulk command bar, dialogs, drag/link/lasso overlay
 * and the AI drawer. Gold (`--g-primary`) carries status and structure; cyan
 * marks interaction (selection, links being drawn, drop targets).
 *
 * Light-DOM component, so every selector is prefixed `kg-` / `kgai-`.
 */

import { html } from "lit";

export const kgOverlayStyles = html`<style>
  .kg-host { --kg-gold: var(--g-primary, #d4af37); --kg-cyan: #5ee7ff; --kg-glass: color-mix(in srgb, var(--g-bg-deep, #07050e) 82%, transparent); }
  .kg-btn--icon { padding: 5px 7px; }
  .kg-btn--icon svg, .kg-btn svg { width: 15px; height: 15px; }
  .kg-btn--danger { border-color: rgba(240, 82, 95, 0.55); color: #ffb3b9; background: rgba(240, 82, 95, 0.12); }
  .kg-btn--danger:hover:not(:disabled) { background: rgba(240, 82, 95, 0.22) !important; border-color: rgba(240, 82, 95, 0.8) !important; color: #fff !important; }
  .kg-btn-badge--hot { background: rgba(240, 82, 95, 0.55); animation: kg-hot 1.6s ease-in-out infinite; }
  @keyframes kg-hot { 50% { box-shadow: 0 0 0 4px rgba(240, 82, 95, 0.18); } }
  .kg-spin { display: inline-flex; animation: kg-rot 0.9s linear infinite; }
  @keyframes kg-rot { to { transform: rotate(360deg); } }
  .kg-seg { display: inline-flex; gap: 2px; }
  .kg-group-pick {
    display: inline-flex; align-items: center; gap: 5px; padding: 0 6px 0 8px; height: 28px; border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--kg-gold) 22%, transparent);
    background: color-mix(in srgb, var(--kg-gold) 6%, rgba(0,0,0,0.35)); color: var(--g-fg, #e4e4e7);
  }
  .kg-group-pick svg { width: 14px; height: 14px; color: var(--kg-gold); }
  .kg-group-pick select { background: transparent; border: 0; color: inherit; font: inherit; font-size: 0.76rem; cursor: pointer; outline: none; }
  .kg-group-pick option { background: #0d0a1c; }
  .kg-group-lbl { font-size: 0.6rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--g-fg-dim, #a1a1aa); }

  /* ── Connections toggle (all / selected / none) ── */
  .kg-conn {
    display: inline-flex; align-items: center; gap: 2px; padding: 2px; height: 28px; border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--kg-cyan) 24%, transparent); background: rgba(0,0,0,0.35);
  }
  .kg-conn-lbl { display: inline-flex; padding: 0 3px 0 4px; color: var(--kg-cyan); }
  .kg-conn-lbl svg { width: 13px; height: 13px; }
  .kg-conn-b {
    font: inherit; font-size: 0.68rem; padding: 0 8px; height: 22px; border-radius: 4px; cursor: pointer;
    color: var(--g-fg-dim, #a1a1aa); background: none; border: 0;
  }
  .kg-conn-b:hover { color: #fff; }
  .kg-conn-b.on { color: #061216; background: linear-gradient(135deg, #5ee7ff, #8ff0ff); font-weight: 700; }

  /* ── Legend: size note + link colours ── */
  .kg-legend-note { display: inline-flex; align-items: center; gap: 6px; font-size: 0.66rem; color: #efe6cf; white-space: nowrap; }
  .kg-size-dots { display: inline-flex; align-items: flex-end; gap: 2px; }
  .kg-size-dots i { display: block; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #fff3c4, #d4af37 70%); }
  .kg-size-dots i:nth-child(1) { width: 5px; height: 5px; }
  .kg-size-dots i:nth-child(2) { width: 8px; height: 8px; }
  .kg-size-dots i:nth-child(3) { width: 12px; height: 12px; }
  .kg-legend-links { display: inline-flex; align-items: center; gap: 9px; margin-left: 8px; }
  .kg-lk { display: inline-flex; align-items: center; gap: 4px; font-size: 0.62rem; color: var(--g-fg-dim, #a1a1aa); white-space: nowrap; }
  .kg-lk i { display: block; width: 16px; border-radius: 2px; box-shadow: 0 0 6px currentColor; }

  /* ── Consolidate sub-projects dialog ── */
  .kg-subs-modes { margin-bottom: 6px; flex-wrap: nowrap !important; }
  .kg-subs-modes > button { flex: 1 1 0; min-width: 0; white-space: normal; line-height: 1.25; }
  .kg-subs-note { display: flex; align-items: center; gap: 6px; font-size: 0.7rem; color: #cfe9d9; margin: 4px 0 8px; }
  .kg-subs-note svg { width: 13px; height: 13px; color: #4fd1a5; }
  .kg-subs-cl { border: 1px solid rgba(212,175,55,0.18); border-radius: 9px; padding: 6px; margin-bottom: 7px; background: rgba(255,255,255,0.02); }
  .kg-subs-cl--others { max-height: 220px; overflow: auto; }
  .kg-subs-clh { display: flex; align-items: center; gap: 8px; padding: 0 2px 4px; font-size: 0.66rem; }
  .kg-tier { font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.6rem; padding: 2px 7px; border-radius: 999px; }
  .kg-tier--duplicate { color: #1a1200; background: #f5c542; }
  .kg-tier--near { color: #f5c542; border: 1px solid rgba(245,197,66,0.5); }
  .kg-subs-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 6px; font-size: 0.76rem; color: #ebe6d8; cursor: pointer; }
  .kg-subs-row:hover { background: rgba(255,255,255,0.04); }
  .kg-subs-row--keep { background: rgba(245,197,66,0.08); }
  .kg-subs-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kg-subs-row em { font-style: normal; font-size: 0.64rem; color: var(--g-fg-dim, #a1a1aa); white-space: nowrap; }
  .kg-subs-keep { font: inherit; font-size: 0.6rem; padding: 1px 7px; border-radius: 999px; cursor: pointer; color: var(--g-fg-dim, #a1a1aa); background: none; border: 1px solid rgba(255,255,255,0.15); }
  .kg-subs-keep.on { color: #1a1200; background: #f5c542; border-color: #f5c542; font-weight: 700; }
  .kg-subs-more { margin: 2px 0 8px; font-size: 0.7rem; }
  .kg-subs-plan { max-height: 190px; overflow: auto; border-radius: 8px; background: rgba(0,0,0,0.3); padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
  .kg-subs-pi { font-size: 0.72rem; color: #e9e3d2; line-height: 1.35; }
  .kg-subs-pi em { display: block; font-style: normal; font-size: 0.64rem; color: var(--g-fg-dim, #a1a1aa); }
  .kg-subs-st { font-size: 0.6rem; padding: 0 6px; border-radius: 999px; background: rgba(94,231,255,0.12); color: #9ff1ff; }
  .kg-subs-st--keep { background: rgba(245,197,66,0.16); color: #f5c542; }
  .kg-subs-prog { position: relative; height: 18px; margin-top: 8px; border-radius: 6px; background: rgba(255,255,255,0.05); overflow: hidden; font-size: 0.66rem; }
  .kg-subs-prog i { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, rgba(94,231,255,0.35), rgba(245,197,66,0.45)); }
  .kg-subs-prog span { position: relative; padding-left: 8px; line-height: 18px; }
  @media (max-width: 640px) {
    .kg-subs-row { grid-template-columns: auto minmax(0, 1fr) auto; }
    .kg-subs-row em { grid-column: 2 / -1; white-space: normal; }
    .kg-subs-modes > button { font-size: 0.66rem; padding: 6px 4px; }
    .kg-subs-note { font-size: 0.64rem; margin: 2px 0 6px; }
    .kg-conn-b { padding: 0 6px; }
    .kg-legend-links .kg-lk:nth-child(n+4) { display: none; }
  }

  /* ── Overlay SVG (drag line, lasso, drop ring) ── */
  .kg-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2; overflow: visible; }
  .kg-dl { fill: none; stroke: url(#kg-dl-grad); stroke-width: 2.4; stroke-dasharray: 7 6; animation: kg-dash 0.6s linear infinite; filter: drop-shadow(0 0 6px rgba(94,231,255,0.6)); }
  .kg-dl--ok { stroke: var(--kg-cyan); stroke-dasharray: none; stroke-width: 3; }
  .kg-dl--bad { stroke: #f0525f; filter: drop-shadow(0 0 6px rgba(240,82,95,0.6)); }
  @keyframes kg-dash { to { stroke-dashoffset: -26; } }
  .kg-lasso { fill: rgba(94, 231, 255, 0.07); stroke: var(--kg-cyan); stroke-width: 1.5; stroke-dasharray: 5 4; stroke-linejoin: round; }
  .kg-drop { fill: rgba(94,231,255,0.06); stroke: rgba(94,231,255,0.5); stroke-width: 1.5; stroke-dasharray: 4 5; }
  .kg-drop--armed { fill: rgba(94,231,255,0.14); stroke: var(--kg-cyan); stroke-width: 2.6; stroke-dasharray: none; animation: kg-pulse-ring 0.9s ease-in-out infinite; filter: drop-shadow(0 0 10px rgba(94,231,255,0.8)); }
  .kg-drop--bad { fill: rgba(240,82,95,0.05); stroke: rgba(240,82,95,0.6); }
  @keyframes kg-pulse-ring { 50% { stroke-opacity: 0.55; } }
  .kg-dl-tip, .kg-drop-tip {
    position: absolute; left: 0; top: 0; z-index: 4; pointer-events: none; white-space: nowrap;
    font: 600 11px Inter, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.01em;
    padding: 4px 9px; border-radius: 999px; color: #e9fbff;
    background: rgba(6, 18, 26, 0.88); border: 1px solid rgba(94,231,255,0.45);
    box-shadow: 0 6px 18px rgba(0,0,0,0.5);
  }
  .kg-dl-tip.ok, .kg-drop-tip.armed { border-color: var(--kg-cyan); color: #fff; box-shadow: 0 0 0 1px rgba(94,231,255,0.25), 0 0 18px rgba(94,231,255,0.35); }
  .kg-dl-tip.bad, .kg-drop-tip.bad { border-color: rgba(240,82,95,0.6); color: #ffc9ce; }
  .kg-mode-hint {
    position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 4;
    display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px;
    font-size: 0.74rem; color: #e9fbff; background: rgba(6, 18, 26, 0.85); border: 1px solid rgba(94,231,255,0.45);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  }
  .kg-mode-hint svg { width: 14px; height: 14px; color: var(--kg-cyan); }

  /* ── Proactive HUD ── */
  .kg-hud {
    position: absolute; top: 12px; left: 12px; width: 286px; max-height: calc(100% - 24px); z-index: 3;
    display: flex; flex-direction: column; overflow: hidden;
    background: linear-gradient(180deg, color-mix(in srgb, var(--kg-gold) 7%, var(--kg-glass)), var(--kg-glass));
    border: 1px solid color-mix(in srgb, var(--kg-gold) 28%, transparent); border-radius: 12px;
    backdrop-filter: blur(16px) saturate(150%); -webkit-backdrop-filter: blur(16px) saturate(150%);
    box-shadow: 0 14px 40px rgba(0,0,0,0.55), inset 0 1px 0 color-mix(in srgb, var(--kg-gold) 22%, transparent);
    font-size: 0.76rem; animation: kg-slide-in 0.18s ease;
  }
  .kg-hud-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
  .kg-hud-beacon { width: 8px; height: 8px; border-radius: 50%; background: var(--kg-gold); box-shadow: 0 0 10px var(--kg-gold); animation: kg-beacon 2.4s ease-in-out infinite; }
  .kg-hud-beacon.hot { background: #f0525f; box-shadow: 0 0 12px #f0525f; }
  @keyframes kg-beacon { 50% { opacity: 0.35; } }
  .kg-hud-fps { margin-left: auto; font-size: 0.62rem; color: var(--g-fg-dim, #8b8b94); font-variant-numeric: tabular-nums; }
  .kg-hud-x { background: none; border: 0; color: var(--g-fg-dim, #a1a1aa); cursor: pointer; padding: 2px; display: inline-flex; transform: rotate(180deg); }
  .kg-hud-x:hover { color: #fff; }
  .kg-hud-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; padding: 2px 10px 8px; }
  .kg-hud-stats div { display: flex; flex-direction: column; align-items: center; padding: 5px 0; border-radius: 7px; background: rgba(255,255,255,0.03); border: 1px solid color-mix(in srgb, var(--kg-gold) 10%, transparent); }
  .kg-hud-stats b { font-size: 0.92rem; color: #f3eee0; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .kg-hud-stats span { font-size: 0.54rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--g-fg-dim, #9a9aa3); }
  .kg-live { color: #3ddc97 !important; text-shadow: 0 0 10px rgba(61,220,151,0.7); }
  .kg-hud-tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid color-mix(in srgb, var(--kg-gold) 14%, transparent); }
  .kg-hud-tabs button { flex: 1; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--g-fg-dim, #a1a1aa); font: inherit; font-size: 0.68rem; padding: 6px 2px; cursor: pointer; letter-spacing: 0.04em; }
  .kg-hud-tabs button.on { color: #fff3cf; border-bottom-color: var(--kg-gold); }
  .kg-hud-tabs i { font-style: normal; font-size: 0.6rem; opacity: 0.7; margin-left: 3px; }
  .kg-hud-body { overflow: auto; padding: 8px 10px 10px; scrollbar-width: thin; }
  .kg-hud-pill {
    position: absolute; top: 12px; left: 12px; z-index: 3; display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 11px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 0.72rem; color: #fff3cf;
    background: var(--kg-glass); border: 1px solid color-mix(in srgb, var(--kg-gold) 40%, transparent);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  }
  .kg-hud-pill svg { width: 14px; height: 14px; color: var(--kg-gold); }
  .kg-hud-pill--hot { border-color: rgba(240,82,95,0.7); animation: kg-hot 1.6s ease-in-out infinite; }
  .kg-hud-pill span { color: var(--g-fg-dim, #a1a1aa); }

  .kg-insight { display: block; padding: 0; cursor: default; }
  .kg-insight-main { display: flex; flex-direction: column; gap: 3px; width: 100%; background: none; border: 0; color: inherit; font: inherit; text-align: left; padding: 8px 10px 4px; cursor: pointer; }
  .kg-insight-actions { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px 7px 8px; }
  .kg-ia {
    display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border-radius: 6px; cursor: pointer;
    font: inherit; font-size: 0.64rem; color: #e9e4d6; background: rgba(255,255,255,0.04);
    border: 1px solid color-mix(in srgb, var(--sev) 30%, transparent);
  }
  .kg-ia svg { width: 12px; height: 12px; }
  .kg-ia:hover { background: color-mix(in srgb, var(--sev) 18%, transparent); color: #fff; }
  .kg-ia--x { margin-left: auto; border-color: transparent; background: none; color: var(--g-fg-dim, #8b8b94); }
  .kg-act { display: grid; grid-template-columns: 10px 1fr auto; gap: 7px; align-items: center; width: 100%; background: none; border: 0; border-radius: 6px; padding: 5px 6px; color: #e9e4d6; font: inherit; font-size: 0.7rem; text-align: left; cursor: pointer; }
  .kg-act:hover { background: color-mix(in srgb, var(--kg-gold) 8%, transparent); }
  .kg-act-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--kg-gold); }
  .kg-act--new .kg-act-dot { background: var(--kg-cyan); box-shadow: 0 0 6px var(--kg-cyan); }
  .kg-act--live .kg-act-dot { background: #3ddc97; box-shadow: 0 0 6px #3ddc97; }
  .kg-act-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kg-act time { font-size: 0.6rem; color: var(--g-fg-dim, #8b8b94); }
  .kg-grp { display: grid; grid-template-columns: 10px 1fr auto auto auto; gap: 6px; align-items: center; padding: 3px 0; }
  .kg-grp-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); }
  .kg-grp-name { background: none; border: 0; color: #ece6d6; font: inherit; font-size: 0.72rem; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0; }
  .kg-grp-name:hover { color: #fff3cf; }

  .kg-mini {
    display: inline-flex; align-items: center; gap: 4px; padding: 4px 7px; border-radius: 6px; cursor: pointer;
    font: inherit; font-size: 0.66rem; color: #e9e4d6; background: rgba(255,255,255,0.04);
    border: 1px solid color-mix(in srgb, var(--kg-gold) 18%, transparent);
  }
  .kg-mini svg { width: 12px; height: 12px; }
  .kg-mini:hover { border-color: color-mix(in srgb, var(--kg-gold) 55%, transparent); color: #fff3cf; }

  /* ── Hover overlay ── */
  .kg-hovercard {
    position: absolute; left: 0; top: 0; z-index: 5; width: 296px; padding: 11px 12px 10px;
    background: linear-gradient(160deg, color-mix(in srgb, var(--kg-gold) 10%, rgba(10,8,22,0.94)), rgba(6,5,14,0.94));
    border: 1px solid color-mix(in srgb, var(--kg-gold) 38%, transparent); border-radius: 12px;
    box-shadow: 0 18px 44px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03) inset, 0 0 30px color-mix(in srgb, var(--kg-gold) 12%, transparent);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    font-size: 0.74rem; transition: opacity 0.14s ease; will-change: transform;
  }
  .kg-hc-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
  .kg-hc-title { font: 700 0.95rem/1.25 Inter, -apple-system, "Segoe UI", sans-serif; color: #f6f1e4; margin-bottom: 7px; }
  .kg-hc-row { font-size: 0.7rem; color: var(--g-fg-dim, #a1a1aa); margin: 5px 0 4px; font-variant-numeric: tabular-nums; }
  .kg-hc-row b { color: #fff3cf; }
  .kg-hc-counts { display: flex; gap: 8px; flex-wrap: wrap; font-size: 0.7rem; color: var(--g-fg-dim, #a1a1aa); margin-bottom: 6px; }
  .kg-hc-counts .hot { color: #ff8a93; }
  .kg-hc-counts .warn { color: #f5c77a; }
  .kg-hc-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 0.7rem; color: var(--g-fg-dim, #a1a1aa); padding: 6px 0; border-top: 1px solid color-mix(in srgb, var(--kg-gold) 12%, transparent); }
  .kg-hc-meta span { display: inline-flex; align-items: center; gap: 4px; }
  .kg-hc-meta svg { width: 12px; height: 12px; color: var(--kg-gold); }
  .kg-hc-links { display: flex; flex-direction: column; gap: 2px; margin-bottom: 7px; }
  .kg-hc-links span { display: flex; align-items: center; gap: 6px; font-size: 0.68rem; color: #ddd6c4; }
  .kg-hc-links i { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .kg-hc-actions { display: flex; gap: 4px; flex-wrap: wrap; }

  /* ── Context menu ── */
  .kg-menu {
    position: absolute; left: 0; top: 0; z-index: 8; width: 264px; padding: 6px;
    background: rgba(9, 7, 20, 0.96); border: 1px solid color-mix(in srgb, var(--kg-gold) 35%, transparent); border-radius: 11px;
    box-shadow: 0 18px 48px rgba(0,0,0,0.65); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    animation: kg-slide-in 0.12s ease; max-height: calc(100% - 16px); overflow: auto;
  }
  .kg-menu-head { padding: 5px 8px 6px; font-weight: 700; font-size: 0.74rem; color: #fff3cf; border-bottom: 1px solid color-mix(in srgb, var(--kg-gold) 14%, transparent); margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kg-menu-sec { padding: 6px 8px 2px; font-size: 0.56rem; letter-spacing: 0.24em; text-transform: uppercase; color: color-mix(in srgb, var(--kg-gold) 75%, #888); }
  .kg-mi { display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 8px; border: 0; border-radius: 7px; background: none; color: #ebe6d8; font: inherit; font-size: 0.74rem; text-align: left; cursor: pointer; }
  .kg-mi svg { width: 14px; height: 14px; color: var(--kg-gold); flex-shrink: 0; }
  .kg-mi--ai svg { color: var(--kg-cyan); }
  .kg-mi:hover { background: color-mix(in srgb, var(--kg-gold) 12%, transparent); color: #fff; }
  .kg-mi--danger { color: #ffb3b9; }
  .kg-mi--danger svg { color: #f0525f; }
  .kg-mi kbd, .kg-keys kbd { margin-left: auto; font: 600 0.58rem "JetBrains Mono", monospace; padding: 1px 5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.14); color: var(--g-fg-dim, #a1a1aa); }
  .kg-mi-row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 5px 8px; font-size: 0.74rem; color: #ebe6d8; }
  .kg-mi-row svg { width: 14px; height: 14px; color: var(--kg-gold); }
  .kg-mi-row > span { margin-right: 4px; }
  .kg-mi-chip { font: inherit; font-size: 0.62rem; padding: 2px 6px; border-radius: 999px; cursor: pointer; color: #e9e4d6; background: rgba(255,255,255,0.04); border: 1px solid color-mix(in srgb, var(--kg-gold) 22%, transparent); }
  .kg-mi-chip:hover { border-color: var(--kg-gold); color: #fff3cf; }

  /* ── Bulk command bar ── */
  .kg-bulk {
    position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 6; max-width: calc(100% - 24px);
    display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 14px; border-radius: 14px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--kg-cyan) 7%, rgba(9,8,20,0.95)), rgba(6,5,14,0.95));
    border: 1px solid rgba(94,231,255,0.38);
    box-shadow: 0 16px 44px rgba(0,0,0,0.6), 0 0 26px rgba(94,231,255,0.12), inset 0 1px 0 rgba(255,255,255,0.05);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); animation: kg-rise 0.18s ease;
  }
  @keyframes kg-rise { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
  .kg-bulk-count { display: flex; flex-direction: column; gap: 2px; font-size: 0.66rem; color: var(--g-fg-dim, #a1a1aa); white-space: nowrap; }
  .kg-bulk-count b { font-size: 0.98rem; color: #e9fbff; margin-right: 3px; }
  .kg-bulk-kinds { display: flex; gap: 6px; font-size: 0.7rem; color: #cfd8dc; }
  .kg-bulk-kinds span { display: inline-flex; align-items: center; gap: 3px; }
  .kg-bulk-kinds i { width: 6px; height: 6px; border-radius: 50%; }
  .kg-bulk-actions { display: flex; align-items: center; gap: 3px; overflow-x: auto; scrollbar-width: none; }
  .kg-bb, .kg-ai-row .kg-bb {
    display: inline-flex; flex-direction: column; align-items: center; gap: 2px; min-width: 50px; padding: 5px 6px; border-radius: 8px;
    background: none; border: 1px solid transparent; color: #e9e4d6; font: inherit; font-size: 0.6rem; cursor: pointer; white-space: nowrap;
  }
  .kg-bb svg { width: 16px; height: 16px; color: var(--kg-gold); }
  .kg-bb--ai svg { color: var(--kg-cyan); }
  .kg-bb:hover, .kg-bb.on { background: rgba(255,255,255,0.05); border-color: color-mix(in srgb, var(--kg-gold) 30%, transparent); color: #fff; }
  .kg-bb--danger svg { color: #f0525f; }
  .kg-bb-sep { width: 1px; align-self: stretch; margin: 4px 3px; background: rgba(255,255,255,0.12); }
  .kg-status-pop { position: relative; }
  .kg-pop { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; min-width: 130px; padding: 5px; border-radius: 10px; background: rgba(9,7,20,0.97); border: 1px solid color-mix(in srgb, var(--kg-gold) 35%, transparent); box-shadow: 0 12px 30px rgba(0,0,0,0.6); }
  .kg-pop--bar { left: auto; right: 150px; transform: none; z-index: 2; }
  @media (max-width: 900px) { .kg-pop--bar { right: 8px; } }
  .kg-pop button { background: none; border: 0; border-radius: 6px; color: #ebe6d8; font: inherit; font-size: 0.72rem; padding: 6px 9px; text-align: left; cursor: pointer; }
  .kg-pop button:hover { background: color-mix(in srgb, var(--kg-gold) 14%, transparent); }
  .kg-ai-row { display: flex; gap: 2px; margin: 10px -4px 0; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--kg-gold) 14%, transparent); }
  .kg-ai-row .kg-bb { flex: 1; min-width: 0; }

  /* ── Settings ── */
  .kg-settings { right: 12px; top: 12px; width: 300px; z-index: 7; display: flex; flex-direction: column; gap: 4px; }
  .kg-settings label, .kg-lbl { font-size: 0.6rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--g-fg-dim, #a1a1aa); margin-top: 6px; display: block; }
  .kg-seg2 { display: flex; flex-wrap: wrap; gap: 3px; }
  .kg-seg2 button { flex: 1 1 auto; font: inherit; font-size: 0.68rem; padding: 5px 8px; border-radius: 6px; cursor: pointer; color: #ddd6c4; background: rgba(255,255,255,0.03); border: 1px solid color-mix(in srgb, var(--kg-gold) 16%, transparent); }
  .kg-seg2 button.on { color: #1a1406; background: linear-gradient(180deg, #f5d36b, #d4af37); border-color: #f5d36b; font-weight: 700; }
  .kg-settings-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .kg-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; margin-top: 10px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--kg-gold) 12%, transparent); font-size: 0.62rem; color: var(--g-fg-dim, #a1a1aa); }
  .kg-keys kbd { margin: 0 2px 0 0; }

  /* ── Dialogs ── */
  .kg-modal { position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: rgba(2,1,6,0.55); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
  .kg-dialog {
    width: min(440px, calc(100% - 24px)); max-height: calc(100% - 24px); display: flex; flex-direction: column;
    background: linear-gradient(170deg, color-mix(in srgb, var(--kg-gold) 9%, rgba(11,9,24,0.98)), rgba(6,5,14,0.98));
    border: 1px solid color-mix(in srgb, var(--kg-gold) 40%, transparent); border-radius: 14px;
    box-shadow: 0 30px 80px rgba(0,0,0,0.7), 0 0 40px color-mix(in srgb, var(--kg-gold) 10%, transparent);
    font-size: 0.78rem; animation: kg-slide-in 0.16s ease;
  }
  .kg-dialog--wide { width: min(620px, calc(100% - 24px)); }
  .kg-dialog-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 8px; }
  .kg-dialog-body { padding: 0 14px 10px; overflow: auto; }
  .kg-dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 14px 12px; border-top: 1px solid color-mix(in srgb, var(--kg-gold) 14%, transparent); flex-wrap: wrap; }
  .kg-input { width: 100%; box-sizing: border-box; margin-top: 4px; background: rgba(0,0,0,0.4); color: var(--g-fg, #e4e4e7); border: 1px solid color-mix(in srgb, var(--kg-gold) 25%, transparent); border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 0.8rem; resize: vertical; }
  .kg-input:focus { outline: none; border-color: color-mix(in srgb, var(--kg-gold) 65%, transparent); }
  .kg-mono { font-family: "JetBrains Mono", "SF Mono", monospace; font-size: 0.72rem; line-height: 1.5; }
  .kg-warn { color: #f5c77a; font-size: 0.72rem; margin: 6px 0; }
  .kg-list { margin: 6px 0; padding-left: 18px; color: #ddd6c4; max-height: 200px; overflow: auto; }
  .kg-pick { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; max-height: 320px; overflow: auto; }
  .kg-pick-item { display: grid; grid-template-columns: 10px 1fr auto; gap: 8px; align-items: center; padding: 7px 8px; border-radius: 7px; border: 0; background: none; color: #ebe6d8; font: inherit; font-size: 0.76rem; text-align: left; cursor: pointer; }
  .kg-pick-item:hover { background: color-mix(in srgb, var(--kg-gold) 12%, transparent); }
  .kg-pick-item i { width: 8px; height: 8px; border-radius: 50%; }
  .kg-pick-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kg-pick-item em { font-style: normal; font-size: 0.62rem; color: var(--g-fg-dim, #8b8b94); }
  .kg-sugg { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; background: rgba(255,255,255,0.025); border: 1px solid color-mix(in srgb, var(--kg-gold) 10%, transparent); }
  .kg-sugg > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 0.74rem; }
  .kg-radio { display: flex; flex-direction: column; gap: 3px; margin-top: 4px; }
  .kg-radio label { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; padding: 5px 8px; border-radius: 7px; background: rgba(255,255,255,0.025); text-transform: none; letter-spacing: 0; font-size: 0.76rem; color: #ebe6d8; margin: 0; cursor: pointer; }
  .kg-radio em { font-style: normal; font-size: 0.62rem; color: var(--g-fg-dim, #8b8b94); }
  .kg-merge-sum { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 2px; font-size: 0.66rem; color: var(--g-fg-dim, #a1a1aa); }
  .kg-merge-sum span { display: inline-flex; align-items: center; gap: 4px; }
  .kg-merge-sum svg { width: 12px; height: 12px; color: var(--kg-cyan); }

  /* ── Toast + busy ── */
  .kg-toast {
    position: absolute; left: 50%; bottom: 84px; transform: translateX(-50%); z-index: 9; max-width: calc(100% - 32px);
    display: inline-flex; align-items: center; gap: 8px; padding: 8px 10px 8px 12px; border-radius: 999px;
    font-size: 0.76rem; color: #f3eee0; background: rgba(9,8,20,0.95); border: 1px solid color-mix(in srgb, var(--kg-gold) 40%, transparent);
    box-shadow: 0 12px 34px rgba(0,0,0,0.55); animation: kg-rise 0.18s ease;
  }
  .kg-toast span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kg-toast svg { width: 15px; height: 15px; flex-shrink: 0; color: #3ddc97; }
  .kg-toast--warn svg { color: #f5a524; }
  .kg-toast--err { border-color: rgba(240,82,95,0.6); }
  .kg-toast--err svg { color: #f0525f; }
  .kg-toast-undo { font: inherit; font-size: 0.72rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; cursor: pointer; color: #1a1406; background: linear-gradient(180deg, #f5d36b, #d4af37); border: 0; }
  .kg-busy { position: absolute; left: 0; right: 0; top: 0; height: 2px; z-index: 9; background: linear-gradient(90deg, transparent, var(--kg-cyan), transparent); background-size: 40% 100%; background-repeat: no-repeat; animation: kg-busy 1s linear infinite; }
  @keyframes kg-busy { from { background-position: -40% 0; } to { background-position: 140% 0; } }

  /* ── 3D group labels ── */
  .kg3d-label--group {
    font: 700 10px Inter, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.22em; line-height: 18px;
    color: color-mix(in srgb, var(--gc, #d4af37) 85%, #fff); padding: 0 7px; border-radius: 4px;
    background: color-mix(in srgb, var(--gc, #d4af37) 10%, rgba(4,3,10,0.6));
    border: 1px solid color-mix(in srgb, var(--gc, #d4af37) 35%, transparent);
    text-shadow: 0 0 10px color-mix(in srgb, var(--gc, #d4af37) 60%, transparent);
  }

  /* ── AI drawer ── */
  .kgai {
    position: absolute; top: 12px; right: 12px; bottom: 12px; width: min(400px, calc(100% - 24px)); z-index: 10;
    display: flex; flex-direction: column; overflow: hidden;
    background: linear-gradient(180deg, color-mix(in srgb, var(--kg-cyan) 6%, rgba(9,8,22,0.97)), rgba(5,4,12,0.97));
    border: 1px solid rgba(94,231,255,0.35); border-radius: 14px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.65), 0 0 36px rgba(94,231,255,0.1);
    backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); font-size: 0.8rem; animation: kg-slide-in 0.18s ease;
  }
  .kgai-head { display: flex; align-items: center; gap: 10px; padding: 12px 12px 8px; }
  .kgai-badge { width: 30px; height: 30px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; color: #071216; background: linear-gradient(135deg, #5ee7ff, #d4af37); box-shadow: 0 0 18px rgba(94,231,255,0.4); }
  .kgai-badge svg { width: 16px; height: 16px; }
  .kgai-title { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .kgai-title b { font-size: 0.84rem; color: #e9fbff; }
  .kgai-title span { font-size: 0.68rem; color: var(--g-fg-dim, #a1a1aa); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kgai-icon { display: inline-flex; padding: 5px; border-radius: 7px; background: none; border: 1px solid transparent; color: var(--g-fg-dim, #a1a1aa); cursor: pointer; }
  .kgai-icon:hover:not(:disabled) { color: #fff; border-color: rgba(94,231,255,0.35); }
  .kgai-icon svg { width: 15px; height: 15px; }
  .kgai-chips { display: flex; gap: 5px; padding: 0 12px 8px; flex-wrap: wrap; }
  .kgai-chip { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 0.66rem; padding: 4px 9px; border-radius: 999px; cursor: pointer; color: #dff7fb; background: rgba(94,231,255,0.06); border: 1px solid rgba(94,231,255,0.3); }
  .kgai-chip svg { width: 12px; height: 12px; }
  .kgai-chip:hover:not(:disabled) { background: rgba(94,231,255,0.14); }
  .kgai-chip:disabled { opacity: 0.45; cursor: default; }
  .kgai-msgs { flex: 1; overflow: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid rgba(94,231,255,0.14); scrollbar-width: thin; }
  .kgai-msg { max-width: 92%; padding: 8px 11px; border-radius: 11px; line-height: 1.5; }
  .kgai-msg--user { align-self: flex-end; color: #1a1406; background: linear-gradient(180deg, #f5d36b, #d4af37); font-weight: 600; font-size: 0.74rem; }
  .kgai-msg--assistant { align-self: flex-start; color: #ece8dc; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); }
  .kgai-md p { margin: 0 0 6px; } .kgai-md p:last-child { margin: 0; }
  .kgai-md ul, .kgai-md ol { margin: 4px 0; padding-left: 18px; }
  .kgai-md code { font-size: 0.72rem; background: rgba(0,0,0,0.35); padding: 1px 4px; border-radius: 4px; }
  .kgai-typing { display: inline-flex; gap: 4px; }
  .kgai-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--kg-cyan); animation: kg-beacon 1s ease-in-out infinite; }
  .kgai-typing i:nth-child(2) { animation-delay: 0.15s; } .kgai-typing i:nth-child(3) { animation-delay: 0.3s; }
  .kgai-muted { color: var(--g-fg-dim, #8b8b94); font-size: 0.72rem; }
  .kgai-err { display: flex; gap: 6px; align-items: flex-start; color: #ffb3b9; font-size: 0.72rem; padding: 8px; border-radius: 8px; background: rgba(240,82,95,0.08); border: 1px solid rgba(240,82,95,0.3); }
  .kgai-err svg { width: 14px; height: 14px; flex-shrink: 0; }
  .kgai-compose { display: flex; gap: 6px; padding: 10px 12px 12px; border-top: 1px solid rgba(94,231,255,0.14); }
  .kgai-compose textarea { flex: 1; resize: none; background: rgba(0,0,0,0.45); color: #e9fbff; border: 1px solid rgba(94,231,255,0.25); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 0.78rem; }
  .kgai-compose textarea:focus { outline: none; border-color: rgba(94,231,255,0.6); }
  .kgai-send { width: 40px; border-radius: 9px; cursor: pointer; color: #071216; background: linear-gradient(135deg, #5ee7ff, #39b8d6); border: 0; display: inline-flex; align-items: center; justify-content: center; }
  .kgai-send:disabled { opacity: 0.4; cursor: default; }
  .kgai-send svg { width: 16px; height: 16px; }

  .kg-hide-sm { display: inline; }
  @media (max-width: 900px) {
    .kg-hud { top: auto; bottom: 10px; left: 8px; right: 8px; width: auto; max-height: 46%; }
    .kg-bulk { bottom: 8px; padding: 6px; gap: 6px; }
    .kg-bulk-count { padding-right: 2px; }
    .kg-bulk-lbl, .kg-bulk-kinds { display: none; }
    .kg-bulk-count b { display: inline-flex; min-width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: 999px; margin: 0; font-size: 0.8rem; color: #071216; background: var(--kg-cyan); }
    .kg-bulk-actions { -webkit-mask-image: linear-gradient(90deg, #000 85%, transparent); mask-image: linear-gradient(90deg, #000 85%, transparent); padding-right: 18px; }
    .kg-bb { min-width: 44px; }
    .kg-hovercard { width: 240px; }
    .kg-toast { bottom: 76px; }
    .kg-settings { left: 8px; right: 8px; width: auto; }
    .kgai { top: 8px; right: 8px; left: 8px; bottom: 8px; width: auto; }
  }
  @media (max-width: 900px) {
    .kg-stage:has(.kg-bulk) .kg-hud, .kg-stage:has(.kgai) .kg-hud { display: none; }
  }
  @media (max-width: 640px) {
    .kg-hide-sm { display: none; }
    .kg-title { display: none; }
    .kg-legend {
      flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; padding: 6px 10px;
      /* Fade the trailing edge so the row reads as scrollable. */
      -webkit-mask-image: linear-gradient(90deg, #000 68%, transparent 98%);
      mask-image: linear-gradient(90deg, #000 68%, transparent 98%);
    }
    .kg-legend > * { flex-shrink: 0; }
    .kg-bb span { display: none; }
    .kg-bb { min-width: 38px; padding: 7px 6px; }
    .kg-bulk-actions { gap: 1px; }
    .kg-hud-pill { top: 8px; left: 8px; }
    .kg3d-label { font-size: 10px; }
    /* Context menu becomes a bottom sheet (inline transform positions it on desktop). */
    .kg-menu { left: 8px; right: 8px; top: auto; bottom: 8px; width: auto; transform: none !important; max-height: 62%; padding-top: 14px; }
    /* Sheet affordances: grab handle + a sticky fade that says "more below". */
    .kg-menu::before { content: ""; position: absolute; top: 5px; left: 50%; width: 36px; height: 4px; margin-left: -18px; border-radius: 999px; background: rgba(255,255,255,0.22); }
    .kg-menu::after { content: ""; position: sticky; bottom: -6px; display: block; height: 30px; margin-top: -30px; pointer-events: none; background: linear-gradient(180deg, transparent, rgba(9,7,20,0.98)); }
    .kg-mi { padding: 9px 8px; }
    .kg3d-label--anchor { font-size: 11px; }
    .kg3d-label--tag { font-size: 8.5px; letter-spacing: 0.12em; line-height: 15px; padding: 0 5px; }
    .kg3d-label--pocket { font-size: 8px; letter-spacing: 0.1em; line-height: 14px; padding: 0 5px; }
    .kg3d-label--super { font-size: 10px; line-height: 15px; padding: 0 6px; }
    .kg-mode-hint { top: auto; bottom: 74px; max-width: calc(100% - 24px); white-space: nowrap; overflow: hidden; }
    .kg-group-pick select { max-width: 92px; }
    .kg-toolbar { flex-wrap: wrap; row-gap: 6px; }
    .kg-search { flex-basis: 100%; order: 10; }
  }
  /* 3D node-shape legend (bottom-right of the stage). */
  .kg-shape-legend {
    position: absolute; right: 10px; bottom: 10px; z-index: 4;
    display: flex; flex-wrap: wrap; gap: 4px 10px; max-width: min(520px, 62%);
    padding: 6px 10px; border-radius: 10px;
    background: color-mix(in srgb, #07060c 78%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 26%, transparent);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    font: 500 10px/1.2 var(--font-mono, ui-monospace, monospace); letter-spacing: 0.04em;
    color: color-mix(in srgb, #f5e9c8 82%, transparent);
    pointer-events: auto;
  }
  .kg-sl { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .kg-sl svg { width: 14px; height: 14px; fill: none; stroke: #5ee7ff; stroke-width: 1.4; stroke-linejoin: round; stroke-linecap: round; }
  .kg-sl--main svg { width: 18px; height: 18px; stroke: #f5c542; stroke-width: 1.6; filter: drop-shadow(0 0 3px #f5c54299); }
  .kg-sl--main .kg-sl-t { color: #f5c542; font-weight: 700; }
  .kg-sl--sub svg { stroke: #b8962e; }
  @media (max-width: 640px) {
    .kg-shape-legend { right: 6px; bottom: 6px; gap: 2px 7px; padding: 4px 7px; max-width: calc(100% - 12px); font-size: 9px; }
    .kg-sl svg { width: 12px; height: 12px; }
    .kg-sl--main svg { width: 15px; height: 15px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .kg-dl, .kg-drop--armed, .kg-hud-beacon, .kg-btn-badge--hot, .kg-hud-pill--hot, .kg-busy, .kgai-typing i, .kg-spin { animation: none; }
  }
  /* ── Mobile-app embed (?embed=mobile / ?embed=1): edge-to-edge, one-row HUD,
     44px-class touch targets, safe areas (env() is 0 unless the view really
     runs under a notch / home indicator). ── */
  .kg-host--embed { border: 0; box-shadow: none; }
  .kg-host--embed .kg-corner { display: none; }
  .kg-tb-tools { display: contents; }
  /* Toolbar = [back][count][search] + a swipeable tools strip: one row when
     wide (landscape), the strip on its own row in portrait. */
  .kg-host--embed .kg-toolbar {
    flex-wrap: nowrap; gap: 6px; row-gap: 6px;
    padding: max(7px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 7px max(10px, env(safe-area-inset-left));
  }
  .kg-host--embed .kg-tb-tools {
    display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0;
    overflow-x: auto; overflow-y: hidden; scrollbar-width: none; overscroll-behavior-x: contain;
    -webkit-mask-image: linear-gradient(90deg, #000 86%, transparent); mask-image: linear-gradient(90deg, #000 86%, transparent);
    padding-right: 22px;
  }
  .kg-host--embed .kg-tb-tools::-webkit-scrollbar, .kg-host--embed .kg-legend::-webkit-scrollbar { display: none; }
  .kg-host--embed .kg-tb-tools > *, .kg-host--embed .kg-toolbar > .kg-btn, .kg-host--embed .kg-node-count { flex-shrink: 0; }
  .kg-host--embed .kg-title { display: none; }
  .kg-host--embed .kg-search { order: 0; flex: 0 1 240px; min-width: 120px; min-height: 38px; font-size: 16px; padding: 6px 10px; }
  @media (max-width: 640px) {
    .kg-host--embed .kg-toolbar { flex-wrap: wrap; }
    .kg-host--embed .kg-search { flex: 1 1 0; }
    .kg-host--embed .kg-tb-tools { flex: 1 1 100%; order: 11; }
  }
  .kg-host--embed .kg-btn { min-height: 38px; min-width: 38px; justify-content: center; touch-action: manipulation; }
  .kg-host--embed .kg-btn svg { width: 17px; height: 17px; }
  .kg-host--embed .kg-conn-b { min-height: 34px; padding: 0 10px; }
  .kg-host--embed .kg-group-pick { min-height: 38px; }
  .kg-host--embed .kg-group-pick select { min-height: 34px; max-width: 108px; }
  .kg-host--embed .kg-back { border-color: color-mix(in srgb, var(--g-primary, #d4af37) 45%, transparent); }
  .kg-host--embed .kg-legend {
    flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: contain;
    padding: 5px max(10px, env(safe-area-inset-right)) 5px max(10px, env(safe-area-inset-left));
    -webkit-mask-image: linear-gradient(90deg, #000 80%, transparent 99%); mask-image: linear-gradient(90deg, #000 80%, transparent 99%);
  }
  .kg-host--embed .kg-legend > * { flex-shrink: 0; }
  .kg-host--embed .kg-chip { min-height: 30px; }
  /* --kg-host-bottom: set by the app for its floating dock; the stage runs
     under it, floating panels stay above it. */
  .kg-host--embed { --kg-bottom: max(env(safe-area-inset-bottom), var(--kg-host-bottom, 0px)); }
  .kg-host--embed .kg-shape-legend { bottom: calc(6px + var(--kg-bottom)); right: max(6px, env(safe-area-inset-right)); }
  .kg-host--embed .kg-stage:has(.kg-detail) .kg-shape-legend, .kg-host--embed .kg-stage:has(.kg-hovercard) .kg-shape-legend { display: none; }
  .kg-host--embed .kg-hud-pill { left: max(8px, env(safe-area-inset-left)); }
  .kg-host--embed .kg-bulk { bottom: calc(8px + var(--kg-bottom)); }
  .kg-host--embed .kg-toast { bottom: calc(76px + var(--kg-bottom)); }
  @media (max-width: 900px) {
    .kg-host--embed .kg-hud { bottom: calc(10px + var(--kg-bottom)); max-height: calc(46% - var(--kg-bottom) / 2); }
    .kg-host--embed .kg-detail { bottom: calc(12px + var(--kg-bottom)); max-height: calc(58% - var(--kg-bottom) / 2); }
    .kg-host--embed .kgai { bottom: calc(8px + var(--kg-bottom)); }
  }
  @media (max-width: 640px) {
    .kg-host--embed .kg-menu { bottom: calc(8px + var(--kg-bottom)); }
    .kg-host--embed .kg-mode-hint { bottom: calc(74px + var(--kg-bottom)); }
  }
  .kg-host--embed .kg-hovercard .kg-mini { min-height: 36px; }
  /* Touch peek (a tapped node's card) is pinned where a thumb reaches it and
     always fits: a bottom sheet above the dock (portrait), a side panel
     (landscape). Hover cards (mouse) keep floating by the node. */
  .kg-host--embed.kg-host--peek .kg-hovercard {
    transform: none !important; opacity: 1 !important;
    left: max(8px, env(safe-area-inset-left)); right: max(8px, env(safe-area-inset-right)); top: auto;
    bottom: calc(8px + var(--kg-bottom)); width: auto;
    max-height: calc(58% - var(--kg-bottom) / 2); overflow-y: auto; overscroll-behavior: contain;
  }
  .kg-host--embed .kg-mini--details { border-color: color-mix(in srgb, var(--kg-cyan) 50%, transparent); }
  /* Landscape phone: the stage is ~300px tall — tighter rows, smaller shape key. */
  @media (max-height: 500px) {
    .kg-host--embed .kg-toolbar { padding-top: max(5px, env(safe-area-inset-top)); padding-bottom: 5px; }
    .kg-host--embed .kg-btn { min-height: 34px; min-width: 34px; }
    .kg-host--embed .kg-search { min-height: 34px; }
    .kg-host--embed .kg-legend { padding-top: 3px; padding-bottom: 3px; }
    .kg-host--embed .kg-chip { min-height: 26px; }
    .kg-host--embed .kg-shape-legend { max-width: 46%; font-size: 9px; gap: 2px 7px; padding: 4px 7px; }
    /* Detail + signals become side panels (a bottom sheet would leave ~150px). */
    .kg-host--embed .kg-hud, .kg-host--embed .kg-detail {
      top: 8px; bottom: calc(8px + var(--kg-bottom)); left: auto; right: max(8px, env(safe-area-inset-right));
      width: min(360px, 48%); max-height: none;
    }
    .kg-host--embed .kg-menu { max-height: calc(100% - 16px - var(--kg-bottom)); }
    .kg-host--embed.kg-host--peek .kg-hovercard {
      left: auto; top: 8px; width: min(340px, 46%); max-height: none;
    }
  }
  /* ── Project scope bar (?project=<id>) ── */
  .kg-scope {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex-shrink: 0; z-index: 3;
    padding: 6px 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent);
    background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary, #d4af37) 9%, transparent), transparent 70%);
  }
  .kg-scope-chip {
    display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 46ch;
    padding: 3px 10px 3px 8px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 55%, transparent);
    background: color-mix(in srgb, var(--g-primary, #d4af37) 14%, rgba(0,0,0,0.35));
    box-shadow: 0 0 14px color-mix(in srgb, var(--g-primary, #d4af37) 22%, transparent);
    color: #fff3c4; font-size: 0.74rem;
  }
  .kg-scope-chip svg { width: 13px; height: 13px; flex-shrink: 0; stroke: currentColor; fill: none; }
  .kg-scope-k { font-size: 0.58rem; letter-spacing: 0.2em; text-transform: uppercase; color: color-mix(in srgb, var(--g-primary, #d4af37) 75%, #999); }
  .kg-scope-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kg-scope-count { font-size: 0.7rem; color: var(--g-fg-dim, #a1a1aa); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .kg-scope-hops { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.25); }
  .kg-scope-hops .kg-scope-k { margin: 0 4px 0 4px; }
  .kg-scope-hops .kg-conn-b { min-width: 24px; }
  .kg-scope-hops .kg-conn-b:disabled { opacity: 0.4; cursor: default; }
  .kg-scope-sp { flex: 1; }
  .kg-scope .kg-btn span { margin-left: 4px; }
  .kg-scope-empty {
    position: absolute; left: 50%; top: 58%; transform: translate(-50%, 0); z-index: 4;
    width: min(380px, calc(100% - 32px)); text-align: center; padding: 18px 20px;
    border-radius: 14px; border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 30%, transparent);
    background: rgba(8, 8, 10, 0.82); backdrop-filter: blur(10px);
    box-shadow: 0 18px 50px rgba(0,0,0,0.5);
  }
  .kg-scope-empty-ic svg { width: 26px; height: 26px; stroke: var(--g-primary, #d4af37); fill: none; }
  .kg-scope-empty-t { margin-top: 6px; font-weight: 700; color: #fff3c4; font-size: 0.9rem; }
  .kg-scope-empty-d { margin-top: 6px; font-size: 0.76rem; line-height: 1.45; color: var(--g-fg-dim, #a1a1aa); }
  .kg-scope-empty-a { margin-top: 12px; display: flex; gap: 8px; justify-content: center; }
  @media (max-width: 720px) {
    /* Two rows on a phone: the project + count, then depth + Show all. */
    .kg-scope { gap: 6px 8px; padding: 6px 10px; }
    .kg-scope-chip { max-width: calc(100% - 120px); }
    .kg-scope-count { margin-left: auto; }
    .kg-scope-sp { display: none; }
    .kg-scope-hops { order: 1; }
    .kg-scope .kg-btn { order: 2; }
    .kg-scope [data-kg-scope-clear] { margin-left: auto; }
    /* Short phone stage: the card sits at the top, clear of the bottom legends. */
    .kg-scope-empty { top: 56px; padding: 14px 16px; z-index: 6; }
    .kg-scope-empty-a { margin-top: 10px; }
  }
  .kg-host--embed .kg-scope .kg-btn { min-height: 34px; }
</style>`;
