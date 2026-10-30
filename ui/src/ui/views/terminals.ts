/**
 * Multi-Terminal Management View — V2
 * Sleek black & gold HUD with drag-drop reordering, resize handles,
 * and maximised terminal space.
 */

import { renderRepoDirButton } from "../project-repos/index";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import '@xterm/xterm/css/xterm.css';
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type {
  TerminalsState,
  TerminalSession,
  CliType,
  TerminalQuickPresetId,
} from "../controllers/terminals";
import type { ResizeEdge } from "../lib/grid-geometry";
import { t } from "../i18n";
import { icons } from "../icons";
import { ensureHomeGlassStyles } from "./home-glass";
import { renderLayoutsMenu, LAYOUTS_MENU_CSS } from "../components/layouts-menu";
// Shared activity components — the SAME custom elements the /activity page mounts.
// Imported (not re-implemented) so the terminal-page activity bar is visually
// indistinguishable from /activity and shares their self-polling data source.
import "../components/subagent-activity-panel";
import "../components/recently-finished-sessions-feed";
import { GRID_TOOLBAR_CSS, renderAutoLayoutButtons, renderWorkspaceTabs } from "../components/grid-toolbar";
import {
  CLI_CONFIGS,
  createTerminalSession,
  closeTerminalSession,
  toggleExpandTerminal,
  setActiveSession,
  toggleSidePanel,
  toggleLowerPanel,
  setLowerPanelHeight,
  loadTerminalsPage,
  openNativeFolderBrowser,
  pickPresetDir,
  togglePageFullscreen,
  startDrag,
  dragOver,
  dropOn,
  endDrag,
  toggleGitPanel,
  loadGitStatus,
  gitCheckout,
  gitStageAll,
  gitCommit,
  gitPush,
  gitPull,
  gitFetch,
  gitStash,
  quickLaunchTerminal,
  getXtermInstance,
  pickGitCwd,
  spawnBatchInDirectory,
  toggleDirsDropdown,
  setTerminalFilterNode,
  reconnectTerminalSession,
  handleTerminalsKeyboard,
  ensureTerminalTiles,
  setTerminalGridContainer,
  startTileDrag,
  startTileResize,
  switchTerminalWorkspace,
  addTerminalWorkspace,
  sendTerminalToWorkspace,
  toggleSendMenu,
  workspaceOf,
  workspaceTerminalCount,
  applyTerminalQuickPreset,
  toggleTerminalLayoutsMenu,
  closeTerminalLayoutsMenu,
  saveTerminalLayoutPreset,
  applyTerminalLayoutPreset,
  deleteTerminalLayoutPreset,
  loadOllamaModelsForNode,
  nodeHasOllama,
  resolveCliVersionForNode,
  TERM_MOBILE_BREAKPOINT,
} from "../controllers/terminals";
import { xterm } from "../directives/xterm";
import { renderFederationNodeSelect } from "../components/federation-node-select";
import { getRecentlyCompletedEntries } from "./recently-completed-feed";

// ── Styles ───────────────────────────────────────────────────

export const terminalsStyles = html`
<style>
  :root {
    --glass-bg: rgba(255, 255, 255, 0.04);
    --glass-card: rgba(255, 255, 255, 0.06);
    --glass-hover: rgba(255, 255, 255, 0.10);
    --glass-active: rgba(255, 255, 255, 0.14);
    --glass-border: linear-gradient(135deg, rgba(255,255,255,0.12), rgba(255,255,255,0.03), rgba(255,255,255,0.08));
    --glass-border-hover: linear-gradient(135deg, rgba(255,255,255,0.20), rgba(255,255,255,0.06), rgba(255,255,255,0.14));
    --glass-blur: blur(24px) saturate(1.6);
    --text-primary: rgba(255, 255, 255, 0.85);
    --text-secondary: rgba(255, 255, 255, 0.50);
    --text-tertiary: rgba(255, 255, 255, 0.30);
    --radius-card: 16px;
    --radius-btn: 10px;
    --radius-input: 12px;
    --radius-panel: 12px;
  }

  /* ── Page root — matches grid-container layout model ── */
  .term-page {
    padding: 0;
    font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
    color: var(--text-primary);
    position: relative;
    width: 100%;
    height: calc(100vh - 56px);
    overflow: hidden;
    background: transparent;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }

  .term-page:fullscreen,
  .term-page:-webkit-full-screen {
    background: transparent;
    height: 100vh;
  }

  .grid-container {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
    overscroll-behavior: contain;
  }

  .grid-layout {
    display: flex;
    position: absolute;
    top: 88px;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    background: transparent;
    contain: layout size;
  }

  .term-page[data-has-tabs="false"] .grid-layout {
    top: 48px;
  }

  .grid-workspace-with-sidebar {
    flex: 1;
    position: relative;
    overflow: hidden;
    background: transparent;
    overscroll-behavior: contain;
  }

  /* ── Shared grid-toolbar + toolbar-btn CSS (mirrors masonry-grid) ── */
  ${GRID_TOOLBAR_CSS}

  /* ── Terminals-specific toolbar layout overrides ── */
  .term-topbar-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .term-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--g-primary);
    font-weight: 700;
    white-space: nowrap;
  }
  .term-session-count {
    font-size: 10px;
    color: var(--text-secondary);
    letter-spacing: 0.08em;
    white-space: nowrap;
  }
  .term-topbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* ── Federation device filter (top-nav) ── */
  .term-fed-wrapper {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .term-fed-select select {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.10);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 10px;
    letter-spacing: 0.04em;
    padding: 3px 7px;
    border-radius: 8px;
    cursor: pointer;
    min-width: 0;
    max-width: 160px;
    transition: border-color 0.12s, background 0.12s;
  }
  .term-fed-select select:hover {
    background: rgba(255, 255, 255, 0.10);
    border-color: rgba(255, 255, 255, 0.18);
  }
  .term-fed-select select:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.25);
  }
  .term-fed-active .term-fed-select select {
    border-color: rgba(255, 255, 255, 0.25);
    color: var(--g-primary);
  }
  .term-fed-clear {
    background: none;
    border: none;
    color: var(--text-tertiary);
    font-size: 10px;
    cursor: pointer;
    padding: 2px 4px;
    line-height: 1;
    transition: color 0.12s;
  }
  .term-fed-clear:hover { color: #ef5b5b; }
  .term-filter-empty {
    padding: 24px 16px;
    font-size: 11px;
    color: var(--text-tertiary);
    letter-spacing: 0.05em;
  }

  /* ── Buttons ── */
  .term-btn {
    padding: 4px 12px;
    font-family: inherit;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    border: 1px solid rgba(255, 255, 255, 0.10);
    background: rgba(255, 255, 255, 0.06);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    color: var(--g-primary);
    cursor: pointer;
    border-radius: var(--radius-btn);
    transition: all 0.15s;
  }
  .term-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.10);
    border-color: rgba(255, 255, 255, 0.20);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.06);
  }
  .term-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .term-btn.primary {
    background: rgba(255, 255, 255, 0.10);
    border-color: rgba(255, 255, 255, 0.18);
  }
  .term-btn-icon {
    padding: 3px 5px;
    font-size: 13px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: var(--radius-btn);
    transition: all 0.15s;
    line-height: 1;
  }
  .term-btn-icon:hover {
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.16);
  }

  /* ── Body — contained within .grid-workspace-with-sidebar ── */
  .term-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    width: 100%;
    height: 100%;
  }

  /* ── Split container (lower panel + resize) ── */
  /* Replaces the old term-split-container which was a flex column.
     Now lives inside .grid-workspace-with-sidebar. */
  .term-workspace-inner {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Seamless masonry grid (no gaps, edge-to-edge) ── */
  .term-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
    grid-auto-rows: minmax(220px, 1fr);
    gap: 0;
    padding: 0;
    margin: 0;
    overflow: auto;
    align-content: start;
    background: #040404;
    font-size: 0;
    line-height: 0;
  }
  .term-grid > .term-card {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    min-height: 0;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    resize: none;
    font-size: 12px;
    line-height: normal;
    animation: none;
  }
  .term-grid > .term-card::before,
  .term-grid > .term-card::after {
    display: none !important;
  }
  .term-grid > .term-card .term-resize-handle { display: none; }
  /* Single-column stack used below the mobile breakpoint. */
  .term-grid-stack {
    grid-template-columns: 1fr;
  }
  .term-grid-stack > .term-card {
    border-right: 0;
  }

  @media (max-width: 900px) {
    .term-side-panel { display: none; }
  }

  /* Phones: the right-hand group used to take the whole bar (flex-shrink: 0),
     squeezing the quick-launch row to zero width and pushing its own last
     buttons off-screen. Stack it instead: every CLI quick-launch button in a
     3-column grid on top (all visible, no hidden scroll), the icon buttons in
     one row below with the device picker shrinking to fit. The toolbar never
     scrolls, so the DIRS / Layouts / device menus are not clipped, and the
     canvas below follows the measured toolbar height (--term-toolbar-bottom). */
  @media (max-width: 768px) {
    .term-page .grid-toolbar {
      height: auto !important;
      min-height: 48px;
      flex-wrap: wrap;
      align-content: center;
      row-gap: 8px;
      padding: 8px !important;
      margin: 8px 8px 0 !important;
    }
    .term-page .term-topbar-left {
      flex: 1 0 100%;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      min-width: 0;
      overflow: visible;
      height: auto;
    }
    .term-page .term-quicklaunch { display: contents; }
    .term-page .term-title,
    .term-page .term-session-count,
    .term-page .term-quicklaunch-divider { display: none; }
    .term-page .term-quicklaunch-btn {
      justify-content: center;
      min-width: 0;
      padding: 6px 4px;
      font-size: 10px;
    }
    .term-page .term-dirs-dropdown { display: block; min-width: 0; }
    .term-page .term-dirs-dropdown > .term-quicklaunch-btn { width: 100%; }
    .term-page .term-dirs-menu {
      left: auto;
      right: 0;
      min-width: 0;
      width: min(320px, calc(100vw - 32px));
    }
    .term-page .term-topbar-right {
      flex: 1 0 100%;
      justify-content: flex-end;
      min-width: 0;
      gap: 5px;
    }
    .term-page .term-fed-wrapper { flex: 1 1 auto; min-width: 0; }
    .term-page .term-fed-select { max-width: 100%; }
    .term-page .term-fed-select .fns-summary { max-width: 100%; min-width: 0; }
    .term-page .term-fed-select .fns-summary-name {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .term-page .term-fed-select .fns-pop { right: auto; left: 0; max-width: calc(100vw - 32px); }
    /* The side panel is hidden below 900px, so its toggle does nothing here. */
    .term-page .term-side-toggle { display: none; }
    .term-page .term-topbar-right > .term-btn-icon,
    .term-page .term-topbar-right > .term-btn,
    .term-page .term-layouts-btn { flex-shrink: 0; }
    .term-page[data-has-tabs="false"] .grid-layout { top: var(--term-toolbar-bottom, 140px); }
  }

  /* ── Snap-grid placement canvas (draggable / resizable tiles) ── */
  /* Edge-to-edge like the grid page: no outer margin, padding, or rounded clip. */
  .term-grid-canvas {
    position: relative;
    flex: 1;
    margin: 0;
    padding: 0;
    overflow: hidden;
    border-radius: 0;
  }
  .term-tile {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    min-width: 0;
    min-height: 0;
    transition: box-shadow 0.12s;
  }
  .term-tile.is-dragging { opacity: 0.92; cursor: grabbing; }
  .term-tile.is-dragging,
  .term-tile.is-resizing { transition: none; }
  /* Canvas mode: the tile owns placement + sizing; the card fills it with the
     same flush rectangular shell used by /grid's grid-panel-shell. */
  .term-grid-canvas .term-card {
    width: 100% !important;
    height: 100% !important;
    flex: 1 1 100% !important;
    align-self: stretch !important;
    min-width: 0 !important;
    min-height: 0 !important;
    max-width: none !important;
    box-sizing: border-box;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    background: rgba(8, 8, 8, 0.85);
    resize: none;
    -webkit-user-drag: none;
    user-select: auto;
    animation: none;
  }
  .term-grid-canvas .term-tile {
    display: block !important;
    overflow: hidden;
    background: transparent;
    padding: 0 !important;
    margin: 0 !important;
    border: 0 !important;
    box-sizing: border-box;
  }
  /* Node-color highlight — overrides the canvas !important resets.
     --tnc is set as an inline CSS var on the card element when the session
     belongs to a non-local federation node. Adding a second class (.term-node-hi)
     gives us a more-specific selector that wins over the bare reset above. */
  .term-grid-canvas .term-card.term-node-hi {
    border-top: 3px solid var(--tnc) !important;
    box-shadow: 0 -3px 14px color-mix(in srgb, var(--tnc) 45%, transparent), 0 8px 28px rgba(0,0,0,0.42) !important;
  }

  /* State feedback mirrors /grid's .panel active ring (gold inset). */
  .term-grid-canvas .term-card:hover {
    background: rgba(8, 8, 8, 0.85);
  }
  .term-grid-canvas .term-card.active {
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--g-primary) 45%, transparent);
  }
  .term-grid-canvas .term-card.focused {
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--g-primary) 35%, transparent);
  }
  .term-grid-canvas .term-card.drag-over {
    box-shadow: inset 0 0 0 2px var(--g-primary);
  }
  .term-grid-canvas .term-card-header { cursor: grab; }
  .term-grid-canvas .term-tile.is-dragging .term-card-header { cursor: grabbing; }

  /* ── Resize handles (canvas tiles) ──
     Fully scoped under .term-grid-canvas .term-tile so the geometry/look is
     immune to the two OTHER ".term-resize-handle" rules further down (the
     lower-panel splitter — height:6px/background-gradient — and the legacy
     card grip — opacity:0). Those used to bleed in via the shared class name
     and left the edge handles invisible and mis-sized. */
  .term-grid-canvas .term-tile .term-resize-handle {
    position: absolute;
    z-index: 7;
    touch-action: none;
    background: transparent;
    opacity: 1;
    display: block;
    margin: 0;
    padding: 0;
  }
  .term-grid-canvas .term-tile .term-resize-n { top: -3px; left: 10px; right: 10px; width: auto; height: 8px; cursor: ns-resize; }
  .term-grid-canvas .term-tile .term-resize-s { bottom: -3px; left: 10px; right: 10px; width: auto; height: 8px; cursor: ns-resize; }
  .term-grid-canvas .term-tile .term-resize-e { right: -3px; top: 10px; bottom: 10px; width: 8px; height: auto; cursor: ew-resize; }
  .term-grid-canvas .term-tile .term-resize-w { left: -3px; top: 10px; bottom: 10px; width: 8px; height: auto; cursor: ew-resize; }
  .term-grid-canvas .term-tile .term-resize-ne { top: -5px; right: -5px; width: 16px; height: 16px; cursor: nesw-resize; }
  .term-grid-canvas .term-tile .term-resize-nw { top: -5px; left: -5px; width: 16px; height: 16px; cursor: nwse-resize; }
  .term-grid-canvas .term-tile .term-resize-se { bottom: -5px; right: -5px; width: 16px; height: 16px; cursor: nwse-resize; }
  .term-grid-canvas .term-tile .term-resize-sw { bottom: -5px; left: -5px; width: 16px; height: 16px; cursor: nesw-resize; }

  /* Discoverable affordance — edges stay invisible until the tile is hovered,
     then a faint gold sliver hints they're grabbable; the hovered handle
     itself lights up. Pure visual: never affects layout / hit area. */
  .term-grid-canvas .term-tile .term-resize-handle::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 3px;
    background: transparent;
    transition: background 0.12s ease, box-shadow 0.12s ease;
    pointer-events: none;
  }
  .term-grid-canvas .term-tile:hover .term-resize-n::after,
  .term-grid-canvas .term-tile:hover .term-resize-s::after,
  .term-grid-canvas .term-tile:hover .term-resize-e::after,
  .term-grid-canvas .term-tile:hover .term-resize-w::after {
    background: color-mix(in srgb, var(--g-primary) 14%, transparent);
  }
  .term-grid-canvas .term-tile .term-resize-handle:hover::after {
    background: color-mix(in srgb, var(--g-primary) 70%, transparent);
    box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 45%, transparent);
  }
  /* Corner grips: small gold L-bracket that fades in on tile hover. */
  .term-grid-canvas .term-tile:hover .term-resize-ne::after,
  .term-grid-canvas .term-tile:hover .term-resize-nw::after,
  .term-grid-canvas .term-tile:hover .term-resize-se::after,
  .term-grid-canvas .term-tile:hover .term-resize-sw::after {
    inset: 4px;
    border-radius: 2px;
    background: transparent;
    border: 2px solid color-mix(in srgb, var(--g-primary) 55%, transparent);
  }
  .term-grid-canvas .term-tile .term-resize-ne:hover::after,
  .term-grid-canvas .term-tile .term-resize-nw:hover::after,
  .term-grid-canvas .term-tile .term-resize-se:hover::after,
  .term-grid-canvas .term-tile .term-resize-sw:hover::after {
    border-color: var(--g-primary);
    box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 45%, transparent);
  }
  /* While actively resizing, surface a gold ring on the live tile. */
  .term-grid-canvas .term-tile.is-resizing .term-card {
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--g-primary) 55%, transparent);
  }

  /* Legacy (kept for any non-canvas usage) */
  .term-resize-n { top: -3px; left: 8px; right: 8px; height: 7px; cursor: ns-resize; }
  .term-resize-s { bottom: -3px; left: 8px; right: 8px; height: 7px; cursor: ns-resize; }
  .term-resize-e { right: -3px; top: 8px; bottom: 8px; width: 7px; cursor: ew-resize; }
  .term-resize-w { left: -3px; top: 8px; bottom: 8px; width: 7px; cursor: ew-resize; }

  /* ── Snap guides + dock preview ── */
  .term-snap-guide {
    position: absolute;
    background: color-mix(in srgb, var(--g-primary) 70%, transparent);
    pointer-events: none;
    z-index: 9997;
  }
  .term-snap-guide.vertical { width: 1px; }
  .term-snap-guide.horizontal { height: 1px; }
  .term-dock-preview {
    position: absolute;
    pointer-events: none;
    z-index: 9998;
    border-radius: 8px;
    transition: left 0.06s ease-out, top 0.06s ease-out, width 0.06s ease-out, height 0.06s ease-out;
  }
  .term-dock-preview.drop {
    background: color-mix(in srgb, var(--g-primary) 22%, transparent);
    border: 2px dashed var(--g-primary);
    box-shadow: 0 0 28px color-mix(in srgb, var(--g-primary) 35%, transparent), inset 0 0 30px color-mix(in srgb, var(--g-primary) 10%, transparent);
  }
  .term-dock-preview.target {
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    border: 1px dashed color-mix(in srgb, var(--g-primary) 35%, transparent);
  }
  .term-dock-label {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 6px 14px;
    background: rgba(0, 0, 0, 0.78);
    color: var(--g-primary);
    border: 1px solid var(--g-primary);
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  /* ── Layouts dropdown button ── */
  .term-layouts-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  ${LAYOUTS_MENU_CSS}

  /* ── Terminal Card — Pale Glass Morphism ── */
  /* Base terminal card chrome. Canvas mode overrides this to the flush
     rectangular grid-panel shell used by /grid. */
  .term-card {
    display: flex;
    flex-direction: column;
    background: rgba(8, 8, 8, 0.75);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border-radius: 12px;
    min-height: 0;
    overflow: hidden;
    transition: border-color 0.15s, box-shadow 0.2s, background 0.15s;
    animation: termFadeIn 0.2s ease-out;
    position: relative;
    resize: both;
    min-width: 240px;
    min-height: 160px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }
  /* /grid's .panel uses a single solid border (no gradient edge, no CSS resize
     grip), so the decorative ::before / ::after are disabled to match it. */
  .term-card::before,
  .term-card::after { display: none; }
  .term-card.expanded {
    resize: none;
    position: fixed;
    inset: 0;
    z-index: 200;
    border-radius: 0;
    background: rgba(255, 255, 255, 0.06);
  }
  .term-card.focused {
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.15), 0 6px 32px rgba(0, 0, 0, 0.35);
  }
  @keyframes termFadeIn {
    from { opacity: 0; transform: scale(0.98); }
    to { opacity: 1; transform: scale(1); }
  }
  .term-card:hover {
    background: rgba(255, 255, 255, 0.08);
    box-shadow: 0 6px 30px rgba(0, 0, 0, 0.35);
  }
  .term-card.active {
    background: rgba(255, 255, 255, 0.10);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12), 0 6px 32px rgba(0, 0, 0, 0.35), 0 0 18px rgba(255, 255, 255, 0.04);
  }
  .term-card.drag-over {
    box-shadow: 0 0 20px rgba(255, 255, 255, 0.10);
  }
  .term-card.drag-over::before {
    background: linear-gradient(135deg, rgba(255,255,255,0.25), rgba(255,255,255,0.08), rgba(255,255,255,0.18));
    opacity: 1;
  }
  .term-card.dragging {
    opacity: 0.4;
    border-style: dashed;
  }

  /* ── Card Header ── */
  .term-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: rgba(255, 255, 255, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    flex-shrink: 0;
    cursor: grab;
    user-select: none;
  }
  .term-card-header:active { cursor: grabbing; }
  .term-status-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: all 0.3s;
  }
  .term-status-dot.idle { background: var(--text-tertiary); }
  .term-status-dot.running {
    background: var(--g-primary);
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.30);
    animation: termPulse 2s infinite;
  }
  .term-status-dot.claude-active {
    background: #a78bfa;
    box-shadow: 0 0 6px rgba(167,139,250,0.6);
    animation: termPulse 2s infinite;
  }
  .term-status-dot.exited { background: #ef4444; }
  @keyframes termPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .term-card-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-primary);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .term-cli-indicator {
    font-size: 9px;
    padding: 1px 6px;
    border: 1px solid;
    border-radius: 6px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    flex-shrink: 0;
    opacity: 0.7;
    background: rgba(255, 255, 255, 0.04);
  }
  .term-card-actions {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .term-card:hover .term-card-actions { opacity: 1; }
  .term-card.focused .term-card-actions { opacity: 0.6; }
  .term-card-action-btn {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 6px;
    color: var(--text-tertiary);
    cursor: pointer;
    padding: 2px 5px;
    font-size: 12px;
    transition: color 0.15s, background 0.15s;
    line-height: 1;
  }
  .term-card-action-btn:hover { color: var(--text-primary); background: rgba(255, 255, 255, 0.08); }
  .term-card-action-btn.close:hover { color: #f87171; }
  .term-card-action-btn.reconnect { color: var(--text-tertiary); }
  .term-card-action-btn.reconnect:hover { color: var(--g-primary); }
  .term-card.term-exited .term-card-actions { opacity: 1; }
  .term-card.term-exited .term-card-action-btn.reconnect {
    color: #ef4444;
    animation: termPulse 1.8s infinite;
  }
  .term-card.term-exited .term-card-action-btn.reconnect:hover {
    color: var(--g-primary);
    animation: none;
  }

  /* ── Card Output ── */
  .term-output {
    flex: 1;
    position: relative;
    background: rgba(0, 0, 0, 0.30);
    overflow: hidden;
    min-height: 0;
  }
  .term-output-host {
    position: absolute;
    inset: 0;
  }
  .term-output .xterm-container {
    width: 100%;
    height: 100%;
  }

  /* ── Reattach overlay (exited session / empty placeholder slot) ── */
  .term-reattach-overlay {
    position: absolute;
    inset: 0;
    z-index: 6;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    text-align: center;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
  }
  .term-reattach-overlay.placeholder { background: rgba(10, 10, 14, 0.78); }
  .term-reattach-icon { font-size: 26px; opacity: 0.7; }
  .term-reattach-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: rgba(255, 255, 255, 0.85);
  }
  .term-reattach-sub {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.45);
    max-width: 280px;
    line-height: 1.4;
  }
  .term-reattach-actions { display: flex; gap: 8px; margin-top: 4px; }
  .term-reattach-btn {
    font-size: 10px;
    letter-spacing: 0.04em;
    padding: 5px 12px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-secondary, rgba(255, 255, 255, 0.7));
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    transition: all 0.15s ease;
  }
  .term-reattach-btn:hover { background: rgba(255, 255, 255, 0.1); }
  .term-reattach-btn.primary {
    color: var(--g-primary);
    border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
  }
  .term-reattach-btn.primary:hover {
    background: color-mix(in srgb, var(--g-primary) 22%, transparent);
  }

  /* ── Card Footer ── */
  .term-card-footer {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.03);
    flex-shrink: 0;
    background: rgba(255, 255, 255, 0.02);
  }
  .term-pill {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding: 1px 6px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--text-tertiary);
  }
  .term-pill.project { color: var(--g-primary); border-color: rgba(255, 255, 255, 0.12); }
  .term-pill.task { color: #4ade80; border-color: rgba(74,222,128,0.15); }
  .term-timestamp { font-size: 8px; color: var(--text-tertiary); margin-left: auto; }

  /* ── Resize Handle ── */
  .term-resize-handle {
    position: absolute;
    bottom: 0; right: 0;
    width: 14px; height: 14px;
    cursor: nwse-resize;
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 5;
  }
  .term-resize-handle::after {
    content: '';
    position: absolute;
    bottom: 3px; right: 3px;
    width: 8px; height: 8px;
    border-right: 2px solid rgba(255, 255, 255, 0.25);
    border-bottom: 2px solid rgba(255, 255, 255, 0.25);
  }
  .term-card:hover .term-resize-handle { opacity: 1; }

  /* ── Side Panel ── */
  .term-side-panel {
    width: 240px;
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border-left: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-panel);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex-shrink: 0;
    margin: 8px 8px 8px 0;
  }
  .term-side-section {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }
  .term-side-title {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: var(--g-primary);
    margin-bottom: 8px;
    font-weight: 700;
  }
  .term-side-item {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 6px;
    margin-bottom: 1px;
    cursor: pointer;
    border-radius: 8px;
    transition: background 0.1s;
  }
  .term-side-item:hover { background: rgba(255, 255, 255, 0.06); }
  .term-side-item .term-status-dot { width: 4px; height: 4px; }
  .term-side-item-label {
    font-size: 10px;
    color: var(--text-secondary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .term-side-item-meta {
    font-size: 8px;
    color: var(--text-tertiary);
    text-transform: uppercase;
  }

  /* ── Create Dialog ── */
  .term-dialog-overlay {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.50);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(8px);
  }
  .term-dialog {
    background: rgba(255, 255, 255, 0.06);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: var(--radius-input);
    padding: 24px;
    width: 520px;
    max-width: 92vw;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 0 60px rgba(255, 255, 255, 0.04);
  }
  .term-dialog-title {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: var(--g-primary);
    margin-bottom: 20px;
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .term-cli-selector {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-bottom: 18px;
  }
  .term-cli-option {
    padding: 12px 14px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-input);
    cursor: pointer;
    transition: all 0.15s;
    text-align: center;
  }
  .term-cli-option:hover { border-color: rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.06); }
  .term-cli-option.selected {
    border-color: rgba(255, 255, 255, 0.22);
    background: rgba(255, 255, 255, 0.08);
    box-shadow: 0 0 12px rgba(255, 255, 255, 0.04);
  }
  .term-cli-option-icon { font-size: 20px; margin-bottom: 4px; display: block; }
  .term-cli-option-name { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-primary); font-weight: 600; }
  .term-cli-option-status { font-size: 8px; margin-top: 3px; color: var(--text-tertiary); }
  .term-cli-option-status.ok { color: #4ade80; }
  .term-form-group { margin-bottom: 12px; }
  .term-form-label { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: 0.15em; color: var(--text-secondary); margin-bottom: 5px; }
  .term-form-input {
    width: 100%; padding: 7px 9px; background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08); color: var(--text-primary);
    font-family: inherit; font-size: 11px; outline: none;
    border-radius: var(--radius-input);
    transition: border-color 0.15s; box-sizing: border-box;
  }
  .term-form-input:focus { border-color: rgba(255, 255, 255, 0.20); }
  .term-form-input::placeholder { color: var(--text-tertiary); }
  .term-form-select {
    width: 100%; padding: 7px 9px; background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08); color: var(--text-primary);
    font-family: inherit; font-size: 11px; outline: none;
    border-radius: var(--radius-input);
    box-sizing: border-box; appearance: none; cursor: pointer;
  }
  .term-form-select:focus { border-color: rgba(255, 255, 255, 0.20); }
  .term-form-hint { font-size: 9px; color: var(--text-tertiary); margin-top: 3px; }
  .term-browse-btn {
    padding: 7px 10px; background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.10); color: var(--g-primary);
    font-family: inherit; font-size: 10px; cursor: pointer;
    border-radius: var(--radius-btn);
    transition: all 0.15s; flex-shrink: 0;
  }
  .term-browse-btn:hover { background: rgba(255, 255, 255, 0.10); border-color: rgba(255, 255, 255, 0.18); }
  .term-dialog-actions {
    display: flex; justify-content: flex-end; gap: 8px;
    margin-top: 18px; padding-top: 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
  }

  /* ── Messages ── */
  .term-success {
    padding: 6px 12px; background: rgba(34,197,94,0.08);
    border: 1px solid rgba(34,197,94,0.15); color: #4ade80;
    font-size: 11px; margin: 4px; border-radius: var(--radius-panel);
    flex-shrink: 0;
  }
  .term-error {
    padding: 6px 12px; background: rgba(220,38,38,0.08);
    border: 1px solid rgba(220,38,38,0.15); color: #f87171;
    font-size: 11px; margin: 4px; border-radius: var(--radius-panel);
    display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
  }
  .term-error-dismiss { background: none; border: none; color: #f87171; cursor: pointer; font-size: 12px; padding: 0 4px; }

  /* ── Empty State ── */
  .term-empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; padding: 60px 20px; color: var(--text-tertiary); text-align: center; flex: 1;
  }
  .term-empty-icon { font-size: 40px; opacity: 0.2; }
  .term-empty-text { font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; }
  .term-empty-hint { font-size: 10px; color: rgba(255, 255, 255, 0.10); max-width: 320px; }

  /* ── Loading ── */
  .term-loading {
    text-align: center; padding: 60px 20px; color: var(--text-secondary);
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em;
  }
  .term-loading-dot { display: inline-block; animation: termLoadPulse 1.5s infinite; color: var(--g-primary); }
  @keyframes termLoadPulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }

  /* ── Git Panel ── */
  .git-section { padding: 10px 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
  .git-branch-badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; font-size: 10px; font-weight: 700;
    border-radius: 6px;
    color: #4ade80; border: 1px solid rgba(74,222,128,0.2); background: rgba(74,222,128,0.04);
  }
  .git-stat { display: flex; gap: 10px; margin-top: 6px; font-size: 9px; color: var(--text-secondary); }
  .git-stat-item { display: flex; align-items: center; gap: 3px; }
  .git-stat-num { color: var(--text-primary); font-weight: 600; }
  .git-stat-num.green { color: #4ade80; }
  .git-stat-num.yellow { color: var(--g-primary); }
  .git-stat-num.red { color: #f87171; }
  .git-actions { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
  .git-action-btn {
    padding: 3px 8px; font-family: inherit; font-size: 8px;
    text-transform: uppercase; letter-spacing: 0.08em;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-secondary); cursor: pointer; border-radius: var(--radius-btn);
    transition: all 0.15s;
  }
  .git-action-btn:hover { color: var(--text-primary); border-color: rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.08); }
  .git-branch-list { margin-top: 6px; max-height: 120px; overflow-y: auto; }
  .git-branch-item {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 6px; font-size: 10px; color: var(--text-secondary); cursor: pointer; border-radius: 6px;
    transition: background 0.1s;
  }
  .git-branch-item:hover { background: rgba(255, 255, 255, 0.04); }
  .git-branch-item.current { color: #4ade80; font-weight: 600; }
  .git-branch-dot { width: 4px; height: 4px; border-radius: 50%; flex-shrink: 0; background: var(--text-tertiary); }
  .git-branch-item.current .git-branch-dot { background: #4ade80; }
  .git-commit-list { margin-top: 6px; }
  .git-commit-item { padding: 3px 6px; font-size: 9px; border-bottom: 1px solid rgba(255,255,255,0.02); }
  .git-commit-hash { color: var(--g-primary); font-weight: 600; margin-right: 6px; }
  .git-commit-msg { color: var(--text-secondary); }
  .git-commit-meta { color: var(--text-tertiary); font-size: 8px; margin-top: 1px; }
  .git-files-list { margin-top: 6px; max-height: 100px; overflow-y: auto; }
  .git-file-item { display: flex; align-items: center; gap: 5px; padding: 2px 6px; font-size: 9px; }
  .git-file-status {
    font-weight: 700; font-size: 8px; width: 16px; text-align: center; flex-shrink: 0;
  }
  .git-file-status.modified { color: var(--g-primary); }
  .git-file-status.added { color: #4ade80; }
  .git-file-status.deleted { color: #f87171; }
  .git-file-status.untracked { color: var(--text-tertiary); }
  .git-file-path { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .git-commit-input {
    width: 100%; padding: 5px 7px; background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08); color: var(--text-primary);
    font-family: inherit; font-size: 10px; outline: none;
    border-radius: var(--radius-input);
    box-sizing: border-box; margin-top: 6px;
  }
  .git-commit-input:focus { border-color: rgba(255, 255, 255, 0.20); }
  .git-commit-input::placeholder { color: var(--text-tertiary); }

  /* ── Quick Launch Buttons ── */
  .term-quicklaunch {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .term-quicklaunch-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    font-family: inherit;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    border: 1px solid;
    background: rgba(255, 255, 255, 0.04);
    border-radius: var(--radius-btn);
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .term-quicklaunch-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    box-shadow: 0 0 10px var(--ql-color, rgba(255, 255, 255, 0.08));
  }
  /* CLI buttons keep their brand colour (text + border), also under the
     glass theme whose generic .term-quicklaunch-btn rule is !important. */
  .term-quicklaunch-btn.term-ql-brand {
    color: var(--ql-fg) !important;
    border-color: var(--ql-border) !important;
  }
  /* Not installed: dimmed on purpose; the tooltip says why. aria-disabled
     (not disabled) so the tooltip still shows on hover. */
  .term-quicklaunch-btn.term-ql-missing {
    opacity: 0.4;
    cursor: help;
    border-style: dashed !important;
  }
  .term-quicklaunch-btn.term-ql-missing:hover { box-shadow: none; }
  .term-quicklaunch-btn .ql-icon { font-size: 12px; }
  .term-quicklaunch-btn .ql-dot {
    width: 5px; height: 5px; border-radius: 50%;
    flex-shrink: 0;
  }
  .term-quicklaunch-divider {
    width: 1px;
    height: 16px;
    background: rgba(255, 255, 255, 0.06);
    margin: 0 4px;
  }

  /* ── Directory presets in create dialog ── */
  .term-dir-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }
  .term-dir-chip {
    padding: 3px 9px;
    font-family: inherit;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.12s;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 260px;
  }
  .term-dir-chip:hover {
    color: var(--text-primary);
    border-color: rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.08);
  }
  .term-dir-chip.active {
    color: var(--g-primary);
    border-color: rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.10);
  }
  .term-dir-chip-icon { font-size: 11px; line-height: 1; }
  .term-dir-chip-label { font-weight: 600; }
  .term-dir-chip-path {
    color: var(--text-tertiary);
    font-size: 8px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .term-dir-presets-divider {
    width: 100%;
    height: 1px;
    background: rgba(255, 255, 255, 0.04);
    margin: 4px 0;
  }
  .term-dir-recents-label {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: var(--text-tertiary);
    width: 100%;
    margin-top: 2px;
  }
  .term-dir-chip-node {
    font-size: 8px;
    color: #4ade80;
    border: 1px solid rgba(74,222,128,0.25);
    background: rgba(74,222,128,0.05);
    padding: 0 4px;
    margin-left: 4px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .term-dirs-menu-badge {
    font-size: 8px;
    margin-left: 6px;
    padding: 1px 5px;
    color: #4ade80;
    background: rgba(74,222,128,0.06);
    border: 1px solid rgba(74,222,128,0.25);
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .term-dirs-menu-badge.stale {
    color: #fbbf24;
    background: rgba(251,191,36,0.06);
    border-color: rgba(251,191,36,0.3);
  }
  .term-card-node {
    font-size: 8px;
    color: #4ade80;
    border: 1px solid rgba(74,222,128,0.25);
    background: rgba(74,222,128,0.04);
    padding: 1px 5px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    flex-shrink: 0;
  }

  /* ── Panel header spawn button — always visible, slightly dimmed ── */
  .term-card-action-btn.spawn-same {
    opacity: 0.7 !important;
    color: var(--g-primary) !important;
    font-size: 15px !important;
    font-weight: 700;
    line-height: 1;
    min-width: 20px;
    text-align: center;
  }
  .term-card:hover .term-card-action-btn.spawn-same { opacity: 1 !important; }
  .term-card-action-btn.spawn-same:hover {
    color: #fff !important;
    background: rgba(255, 255, 255, 0.14) !important;
  }

  /* ── Duplicate + send-to-workspace header buttons ── */
  .term-card-action-btn.term-dup:hover { color: var(--g-primary); }
  .term-card-action-btn.term-send:hover { color: var(--g-primary); }

  /* Full-viewport transparent backdrop that closes the popover on outside click. */
  .term-send-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9998;
    background: transparent;
  }
  /* Fixed-position "send to workspace" popover — escapes the card's overflow clip. */
  .term-send-menu {
    position: fixed;
    z-index: 9999;
    min-width: 176px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 6px;
    background: rgba(14, 14, 16, 0.96);
    backdrop-filter: blur(24px) saturate(1.4);
    -webkit-backdrop-filter: blur(24px) saturate(1.4);
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, rgba(255,255,255,0.12));
    border-radius: 12px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
  }
  .term-send-menu-title {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--g-primary);
    font-weight: 700;
    padding: 4px 8px 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 2px;
  }
  .term-send-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .term-send-menu-item:hover:not(:disabled) {
    background: color-mix(in srgb, var(--g-primary) 16%, transparent);
    color: #fff;
  }
  .term-send-menu-item:disabled { cursor: default; opacity: 0.55; }
  .term-send-menu-item.current { color: var(--text-secondary); }
  .term-send-menu-item.new {
    margin-top: 2px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    color: var(--g-primary);
  }
  .term-send-menu-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    border-radius: 6px;
    font-size: 10px;
    font-weight: 700;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--g-primary);
  }
  .term-send-menu-here {
    margin-left: auto;
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-tertiary);
  }

  /* ── Count stepper / batch spawn ── */
  .term-count-stepper {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--radius-btn);
    background: rgba(255, 255, 255, 0.04);
  }
  .term-count-btn {
    background: transparent;
    border: none;
    color: var(--g-primary);
    font-family: inherit;
    font-size: 14px;
    width: 26px;
    cursor: pointer;
    border-radius: 6px;
    transition: background 0.12s;
  }
  .term-count-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
  }
  .term-count-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .term-count-input {
    width: 56px;
    padding: 6px 0;
    background: transparent;
    border: none;
    border-left: 1px solid rgba(255, 255, 255, 0.06);
    border-right: 1px solid rgba(255, 255, 255, 0.06);
    color: var(--text-primary);
    font-family: inherit;
    font-size: 12px;
    text-align: center;
    outline: none;
    -moz-appearance: textfield;
  }
  .term-count-input::-webkit-outer-spin-button,
  .term-count-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .term-count-input:focus { background: rgba(255, 255, 255, 0.04); }
  .term-count-each {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    text-transform: none;
    letter-spacing: normal;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .term-count-each input[type="checkbox"] {
    accent-color: var(--g-primary);
    width: auto;
    margin: 0;
  }

  /* ── Topbar: registered-directories quick-pick dropdown ── */
  .term-dirs-dropdown {
    position: relative;
    display: inline-block;
  }
  .term-dirs-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 50;
    min-width: 320px;
    max-width: 480px;
    max-height: 320px;
    overflow-y: auto;
    background: rgba(255, 255, 255, 0.06);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: var(--radius-panel);
    box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    padding: 4px;
  }
  .term-dirs-menu-empty {
    padding: 16px;
    color: var(--text-tertiary);
    font-size: 11px;
    text-align: center;
  }
  .term-dirs-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 8px;
    transition: background 0.12s;
    border: 1px solid transparent;
  }
  .term-dirs-menu-item:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.10);
  }
  .term-dirs-menu-icon { font-size: 14px; flex-shrink: 0; }
  .term-dirs-menu-info { flex: 1; min-width: 0; }
  .term-dirs-menu-name { font-size: 11px; color: var(--text-primary); font-weight: 600; }
  .term-dirs-menu-path {
    font-size: 9px;
    color: var(--text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .term-dirs-menu-actions {
    display: flex;
    gap: 3px;
    flex-shrink: 0;
  }
  .term-dirs-action-btn {
    padding: 2px 7px;
    font-family: inherit;
    font-size: 9px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--g-primary);
    cursor: pointer;
    transition: all 0.12s;
  }
  .term-dirs-action-btn:hover {
    background: rgba(255, 255, 255, 0.10);
    border-color: rgba(255, 255, 255, 0.18);
  }

  /* ── Resizable Split Layout ── */
  .term-resize-handle {
    height: 6px;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.10), transparent);
    cursor: ns-resize;
    flex-shrink: 0;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s;
  }
  .term-resize-handle:hover,
  .term-resize-handle.dragging {
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.20), transparent);
  }
  .term-resize-handle::before {
    content: '';
    width: 40px;
    height: 3px;
    background: rgba(255, 255, 255, 0.20);
    border-radius: 2px;
    transition: all 0.15s;
  }
  .term-resize-handle:hover::before,
  .term-resize-handle.dragging::before {
    width: 60px;
    background: rgba(255, 255, 255, 0.35);
  }
  .term-lower-section {
    flex-shrink: 0;
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-panel) var(--radius-panel) 0 0;
    margin: 0 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .term-lower-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    flex-shrink: 0;
  }
  .term-lower-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: var(--g-primary);
    font-weight: 700;
  }
  .term-lower-toggle {
    padding: 2px 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--radius-btn);
    color: var(--text-secondary);
    font-size: 9px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .term-lower-toggle:hover {
    border-color: rgba(255, 255, 255, 0.18);
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.08);
  }
  .term-chart-container {
    flex: 1;
    padding: 12px;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .term-chart-wrapper {
    flex: 1;
    min-height: 0;
    position: relative;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-panel);
    overflow: hidden;
  }
  .term-chart-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .term-chart-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-tertiary);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .term-chart-stats {
    display: flex;
    gap: 16px;
    padding-top: 8px;
    flex-shrink: 0;
  }
  .term-chart-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .term-chart-stat-label {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-tertiary);
  }
  .term-chart-stat-value {
    font-size: 14px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
  }
  .term-chart-stat-value.positive { color: #22c55e; }
  .term-chart-stat-value.negative { color: #ef4444; }
  .term-chart-stat-value.neutral { color: var(--g-primary); }

  /* ── Activity Preview Body ── */
  .term-act-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    /* Single row pinned to the panel height so each component scrolls internally. */
    grid-template-rows: minmax(0, 1fr);
    gap: 10px;
    padding: 10px 12px 12px;
  }
  /* Scroll wrapper that lets a mounted shared activity component fill its column
     and scroll on its own — keeps the bottom bar at a fixed height. */
  .term-act-component-wrap {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 2px;
  }
  .term-act-component-wrap::-webkit-scrollbar { width: 6px; }
  .term-act-component-wrap::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.10);
    border-radius: 3px;
  }
  /* Stack the two activity components on narrow screens (mobile). */
  @media (max-width: 640px) {
    .term-act-body {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    }
  }
  .term-act-col {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .term-act-col-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .term-act-col-title {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.15em;
    color: var(--g-primary);
    text-transform: uppercase;
  }
  .term-act-col-title.muted { color: var(--text-secondary); }
  .term-act-col-count {
    font-size: 8px;
    letter-spacing: 0.1em;
    padding: 1px 6px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--text-secondary);
  }
  .term-act-col-count.live {
    color: #22c55e;
    border-color: #22c55e;
    animation: term-act-pulse 2s infinite;
  }
  .term-act-cards {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: min-content;
    gap: 6px;
    padding-right: 2px;
  }
  .term-act-cards::-webkit-scrollbar { width: 6px; }
  .term-act-cards::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.10);
    border-radius: 3px;
  }
  .term-act-card {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-left: 2px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
    min-width: 0;
  }
  .term-act-card:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.14);
  }
  .term-act-card.running { border-left-color: #22c55e; }
  .term-act-card.done    { border-left-color: #22c55e; }
  .term-act-card.error   { border-left-color: #ef4444; }
  .term-act-card-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .term-act-card-title {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .term-act-card-sub {
    font-size: 9px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .term-act-card-meta {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: 8px;
    color: var(--text-tertiary);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .term-act-card-meta strong { color: var(--g-primary); font-weight: 600; }
  .term-act-pill {
    font-size: 7px;
    letter-spacing: 0.1em;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid currentColor;
    flex-shrink: 0;
  }
  .term-act-pill.running { color: #22c55e; }
  .term-act-pill.done    { color: #22c55e; }
  .term-act-pill.error   { color: #ef4444; }
  .term-act-bar {
    height: 2px;
    border-radius: 1px;
    background: rgba(255, 255, 255, 0.06);
    overflow: hidden;
    margin-top: 2px;
  }
  .term-act-bar > span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #22c55e, rgba(34,197,94,0.6));
    transition: width 0.5s ease;
  }
  .term-act-empty {
    grid-column: 1 / -1;
    padding: 12px;
    text-align: center;
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-tertiary);
    border: 1px dashed rgba(255, 255, 255, 0.08);
    border-radius: 8px;
  }
  .term-act-stats-inline {
    display: flex;
    gap: 12px;
    margin-left: auto;
    font-size: 9px;
    color: var(--text-secondary);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .term-act-stats-inline span strong {
    color: var(--g-primary);
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
  }
  @keyframes term-act-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
</style>
`;

// ── Helpers ──────────────────────────────────────────────────

/**
 * Deterministic HSL color for a federation node id. Same node → same hue across
 * reloads; local / undefined → empty string (no highlight applied).
 */
function nodeColor(nodeId: string | undefined): string {
  if (!nodeId || nodeId === "local") return "";
  let h = 0;
  for (let i = 0; i < nodeId.length; i++) h = (Math.imul(31, h) + nodeId.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 68%, 56%)`;
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

// ── Main Render ──────────────────────────────────────────────

export function renderTerminals(state: AppViewState, client: GatewayBrowserClient) {
  ensureHomeGlassStyles();
  const ts = state.terminalsState;
  if (!ts) return html`<div class="term-page">${terminalsStyles}<div class="term-loading"><span class="term-loading-dot">◆</span> INITIALIZING</div></div>`;
  hydrateLowerPanelCollapse(ts);
  if (ts.loading && ts.sessions.length === 0) return html`<div class="term-page">${terminalsStyles}<div class="term-loading"><span class="term-loading-dot">◆</span> LOADING</div></div>`;

  return html`
    <div class="term-page" data-has-tabs="false" @keydown=${(e: KeyboardEvent) => handleTerminalsKeyboard(state, e)} @click=${() => closeTerminalLayoutsMenu(state)} tabindex="0">
      ${terminalsStyles}
      <div class="grid-container">
        ${ts.successMessage ? html`<div class="term-success">${ts.successMessage}</div>` : nothing}
        ${ts.error ? html`<div class="term-error"><span>⚠ ${ts.error}</span><button class="term-error-dismiss" @click=${() => { ts.error = null; state.requestUpdate?.(); }}>✕</button></div>` : nothing}
        ${renderTopBar(state, ts)}
        <div class="grid-layout">
          <div class="grid-workspace-with-sidebar">
            <div class="term-workspace-inner">
              <!-- Upper Section: Terminals -->
              <div style="${ts.showLowerPanel ? 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;' : 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;'}">
                <div class="term-body">
                  ${ts.showGitPanel ? renderGitPanel(state, ts) : nothing}
                  ${ts.sessions.length === 0 ? renderEmptyState(state, ts) : renderGrid(state, ts)}
                  ${ts.showSidePanel ? renderSidePanel(state, ts) : nothing}
                </div>
              </div>

              <!-- Activity bar (bottom): mirrors /activity. Collapses to a thin
                   header strip via the chevron; state persists across reloads. -->
              ${renderActivityBar(state, ts)}
            </div>
          </div>
        </div>
      </div>
      ${ts.showCreateDialog ? renderCreateDialog(state, ts) : nothing}
    </div>
  `;
}

// ── Top Bar ──────────────────────────────────────────────────

function renderTopBar(state: AppViewState, ts: TerminalsState) {
  const active = ts.sessions.filter((s) => s.status === "running" || s.status === "claude-active").length;
  const canAdd = ts.sessions.length < ts.maxSessions;
  const total = ts.sessions.length;
  const visibleCount = ts.filterNodeId
    ? ts.sessions.filter(s => (s.nodeId ?? "local") === ts.filterNodeId).length
    : total;
  const countLabel = ts.filterNodeId && visibleCount !== total
    ? `${visibleCount} / ${total}${active > 0 ? ` · ${active} live` : ""}`
    : `${total}${active > 0 ? ` · ${active} live` : ""}`;

  const fedNodes: Array<{ id: string; name: string; isLocal?: boolean; online?: boolean }> = [
    { id: "__all__", name: "All devices", isLocal: false, online: true },
    ...ts.federationNodes,
  ];

  // Quick launch CLI configs (only show CLIs that are detected)
  const quickClis = [
    { key: "claude" as const, icon: "✦", name: "CLAUDE", color: "#a78bfa", border: "rgba(167,139,250,0.3)", bg: "rgba(167,139,250,0.06)" },
    { key: "opencode" as const, icon: "⌘", name: "OPENCODE", color: "#22c55e", border: "rgba(34,197,94,0.3)", bg: "rgba(34,197,94,0.06)" },
    { key: "gemini" as const, icon: "◆", name: "GEMINI", color: "#3b82f6", border: "rgba(59,130,246,0.3)", bg: "rgba(59,130,246,0.06)" },
    { key: "grok" as const, icon: "✕", name: "GROK", color: "#f43f5e", border: "rgba(244,63,94,0.3)", bg: "rgba(244,63,94,0.06)" },
  ];

  return html`
    <div class="grid-toolbar" ${observeToolbar()}>
      <div class="term-topbar-left">
        <span class="term-title">◇ TERMINALS</span>
        <span class="term-session-count">${countLabel}</span>
        <div class="term-quicklaunch-divider"></div>
        <div class="term-quicklaunch">
          ${quickClis.map((c) => {
            const ver = ts.cliVersions[c.key];
            const installed = !!ver?.installed;
            return html`
              <button class="term-quicklaunch-btn term-ql-brand ${installed ? "" : "term-ql-missing"}"
                style="--ql-fg:${c.color};--ql-border:${c.border};--ql-color:${c.bg};"
                ?disabled=${!canAdd}
                aria-disabled=${installed ? "false" : "true"}
                aria-label=${installed ? `Launch ${c.name}` : `${c.name} is not installed on this device`}
                @click=${(e: MouseEvent) => { if (installed && canAdd) quickLaunchTerminal(state, c.key, undefined, e.shiftKey); }}
                @contextmenu=${(e: MouseEvent) => { e.preventDefault(); if (installed && canAdd) quickLaunchTerminal(state, c.key, undefined, true); }}
                title="${installed ? `${c.name} · Click=default dir · Shift+Click or Right-Click=browse` : `${c.name} isn't installed on this device (dimmed). Install it from the Coders page, then refresh ↻.`}">
                <span class="ql-icon">${c.icon}</span>
                <span>${c.name}</span>
                <span class="ql-dot" style="background:${installed ? c.color : '#3f3f46'};"></span>
              </button>
            `;
          })}
          <button class="term-quicklaunch-btn"
            style="color:var(--g-primary);border-color:color-mix(in srgb, var(--g-primary) 20%, transparent);--ql-color:color-mix(in srgb, var(--g-primary) 6%, transparent);"
            ?disabled=${!canAdd}
            @click=${(e: MouseEvent) => { if (canAdd) quickLaunchTerminal(state, "shell", undefined, e.shiftKey); }}
            @contextmenu=${(e: MouseEvent) => { e.preventDefault(); if (canAdd) quickLaunchTerminal(state, "shell", undefined, true); }}
            title="SHELL · Click=default dir · Shift+Click or Right-Click=browse">
            <span class="ql-icon">>_</span>
            <span>SHELL</span>
          </button>
        </div>
        ${renderRegisteredDirsDropdown(state, ts, canAdd)}
      </div>

      <!-- Auto-layout buttons: same as Grid page (Horizontal / Vertical / Grid) -->
      <div class="toolbar-divider"></div>
      ${renderAutoLayoutButtons({
        onTileHorizontal: () => applyTerminalQuickPreset(state, "twoCol"),
        onTileVertical: () => applyTerminalQuickPreset(state, "one"),
        onTileGrid: () => applyTerminalQuickPreset(state, "grid"),
      })}
      <div class="toolbar-divider"></div>

      <!-- Numbered workspace tabs (each holds up to 6 terminals; a 7th spills
           into the next workspace) — mirrors the /grid page tab strip. -->
      ${renderWorkspaceTabs({
        count: ts.workspaceCount,
        active: ts.activeWorkspace,
        countFor: (n) => workspaceTerminalCount(ts, n),
        onSwitch: (n) => switchTerminalWorkspace(state, n),
        onAdd: () => addTerminalWorkspace(state),
        canAdd: ts.workspaceCount < ts.maxSessions,
      })}
      <div class="toolbar-divider"></div>

      <div class="term-topbar-right">
        ${ts.federationNodes.length > 0 ? html`
          <div class="term-fed-wrapper ${ts.filterNodeId ? "term-fed-active" : ""}">
            ${renderFederationNodeSelect({
              value: ts.filterNodeId ?? "__all__",
              nodes: fedNodes,
              onChange: (id) => setTerminalFilterNode(state, id === "__all__" ? null : id),
              compact: true,
              label: "",
              className: "term-fed-select",
            })}
            ${ts.filterNodeId ? html`
              <button class="term-fed-clear" @click=${() => setTerminalFilterNode(state, null)} title="Show all devices">✕</button>
            ` : nothing}
          </div>
        ` : nothing}
        ${renderLayoutsDropdown(state, ts)}
        <button class="term-btn-icon" @click=${() => toggleLowerPanelPersisted(state)} title="Toggle activity bar"
          style="${ts.showLowerPanel ? "color:var(--g-primary);border-color:color-mix(in srgb, var(--g-primary) 30%, transparent);" : ""}">${icons.barChart}</button>
        <button class="term-btn-icon" @click=${() => toggleGitPanel(state)} title="Git panel"
          style="${ts.showGitPanel ? "color:#4ade80;border-color:rgba(74,222,128,0.3);" : ""}">⎇</button>
        <button class="term-btn-icon term-side-toggle" @click=${() => toggleSidePanel(state)} title="Toggle panel">
          ${ts.showSidePanel ? "◧" : "◨"}
        </button>
        <button class="term-btn-icon" @click=${() => togglePageFullscreen(state)}
          title="${ts.pageFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen page"}"
          style="${ts.pageFullscreen ? "color:var(--g-primary);border-color:color-mix(in srgb, var(--g-primary) 30%, transparent);" : ""}">
          ${ts.pageFullscreen ? "⤡" : "⛶"}
        </button>
        <button class="term-btn" ?disabled=${ts.loading} @click=${() => loadTerminalsPage(state)}>↻</button>
        <button class="term-btn primary" ?disabled=${!canAdd}
          @click=${() => {
            ts.createForm.nodeId = ts.defaultSpawnNodeId ?? ts.createForm.nodeId ?? "local";
            ts.showCreateDialog = true;
            state.requestUpdate?.();
          }}>+ NEW</button>
      </div>
    </div>
  `;
}

// ── Empty ────────────────────────────────────────────────────

function renderEmptyState(state: AppViewState, ts: TerminalsState) {
  return html`
    <div class="term-empty">
      <div class="term-empty-icon">>_</div>
      <div class="term-empty-text">NO TERMINALS</div>
      <div class="term-empty-hint">Create a terminal to run shell commands or CLI agents.</div>
      <button class="term-btn primary" @click=${() => {
        ts.createForm.nodeId = ts.defaultSpawnNodeId ?? ts.createForm.nodeId ?? "local";
        ts.showCreateDialog = true;
        state.requestUpdate?.();
      }}>+ CREATE</button>
    </div>
  `;
}

// ── Grid ─────────────────────────────────────────────────────

const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/**
 * The toolbar wraps onto several rows on phones; publish where it ends so the
 * canvas below starts under it instead of a hard-coded 48px.
 */
const _observedToolbars = new WeakSet<HTMLElement>();
function observeToolbar() {
  return ref((el?: Element) => {
    if (!el) return;
    const bar = el as HTMLElement;
    if (_observedToolbars.has(bar)) return;
    _observedToolbars.add(bar);
    const publish = () => {
      const page = bar.closest<HTMLElement>(".term-page");
      if (!page) return;
      const bottom = bar.offsetTop + bar.offsetHeight + 8;
      page.style.setProperty("--term-toolbar-bottom", `${Math.max(48, bottom)}px`);
    };
    new ResizeObserver(publish).observe(bar);
    publish();
  });
}

/** Stable ResizeObserver wiring for the placement canvas. */
const _observedCanvases = new WeakSet<HTMLElement>();
function observeCanvas(state: AppViewState) {
  return ref((el?: Element) => {
    if (!el) return;
    const node = el as HTMLElement;
    setTerminalGridContainer(state, node.clientWidth, node.clientHeight);
    if (_observedCanvases.has(node)) return;
    _observedCanvases.add(node);
    const ro = new ResizeObserver(() => {
      setTerminalGridContainer(state, node.clientWidth, node.clientHeight);
    });
    ro.observe(node);
  });
}

function isMobileGrid(ts: TerminalsState): boolean {
  const w = ts.gridContainer.width || window.innerWidth;
  return w <= TERM_MOBILE_BREAKPOINT;
}

/** Only start a tile drag from the card header, never from controls / xterm. */
function maybeStartTileDrag(state: AppViewState, id: string, e: PointerEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (target.closest(".term-resize-handle")) return;
  const header = target.closest(".term-card-header");
  if (!header) return;
  if (target.closest("button, input, select, a, textarea")) return;
  startTileDrag(state, id, e);
}

function renderTile(state: AppViewState, ts: TerminalsState, session: TerminalSession) {
  const tile = ts.tiles.find((t) => t.id === session.id);
  if (!tile) return nothing;
  const dragging = ts.draggingTileId === session.id;
  const resizing = ts.resizingTileId === session.id;
  return html`
    <div
      class="term-tile ${dragging ? "is-dragging" : ""} ${resizing ? "is-resizing" : ""}"
      style="left:${tile.x}px;top:${tile.y}px;width:${tile.width}px;height:${tile.height}px;z-index:${tile.zIndex};"
      @pointerdown=${(e: PointerEvent) => maybeStartTileDrag(state, session.id, e)}
      @dragstart=${(e: DragEvent) => e.preventDefault()}
    >
      ${renderTerminalCard(state, ts, session)}
      ${RESIZE_EDGES.map(
        (edge) => html`
          <div
            class="term-resize-handle term-resize-${edge}"
            @pointerdown=${(e: PointerEvent) => startTileResize(state, session.id, edge, e)}
          ></div>
        `,
      )}
    </div>
  `;
}

function renderSnapGuides(ts: TerminalsState) {
  if (ts.tileSnapGuides.length === 0) return nothing;
  return ts.tileSnapGuides.map((g) =>
    g.type === "vertical"
      ? html`<div class="term-snap-guide vertical" style="left:${g.position}px;top:${g.start}px;height:${g.end - g.start}px;"></div>`
      : html`<div class="term-snap-guide horizontal" style="top:${g.position}px;left:${g.start}px;width:${g.end - g.start}px;"></div>`,
  );
}

function renderDockPreview(ts: TerminalsState) {
  const dock = ts.tileDock;
  if (!dock) return nothing;
  const label =
    dock.edge === "center" ? "Swap" :
    dock.edge === "n" ? "Dock Top" :
    dock.edge === "s" ? "Dock Bottom" :
    dock.edge === "e" ? "Dock Right" : "Dock Left";
  return html`
    ${dock.targetRect ? html`
      <div class="term-dock-preview target"
        style="left:${dock.targetRect.x}px;top:${dock.targetRect.y}px;width:${dock.targetRect.width}px;height:${dock.targetRect.height}px;"></div>
    ` : nothing}
    <div class="term-dock-preview drop"
      style="left:${dock.rect.x}px;top:${dock.rect.y}px;width:${dock.rect.width}px;height:${dock.rect.height}px;">
      <span class="term-dock-label">${label}</span>
    </div>
  `;
}

function renderGrid(state: AppViewState, ts: TerminalsState) {
  // Only the active workspace's terminals render; the rest stay parked in
  // their own (hidden) workspaces. Composes with the federation node filter.
  let sessions = ts.sessions.filter((s) => workspaceOf(ts, s.id) === ts.activeWorkspace);
  if (ts.filterNodeId) {
    sessions = sessions.filter(s => (s.nodeId ?? "local") === ts.filterNodeId);
  }

  // Active workspace is empty but other workspaces still hold terminals.
  if (sessions.length === 0 && ts.sessions.length > 0 && !ts.filterNodeId) {
    return html`
      <div class="term-grid-canvas" ${observeCanvas(state)}>
        <div class="term-filter-empty">Workspace ${ts.activeWorkspace} is empty — spawn a terminal or switch tabs.</div>
      </div>
    `;
  }

  if (ts.filterNodeId && sessions.length === 0) {
    const nodeName = ts.federationNodes.find(n => n.id === ts.filterNodeId)?.name ?? ts.filterNodeId;
    return html`
      <div class="term-grid-canvas" ${observeCanvas(state)}>
        <div class="term-filter-empty">No terminals on ${nodeName} — spawn one above.</div>
      </div>
    `;
  }

  // Keep tile rects in sync with the live session list.
  ensureTerminalTiles(state);

  // Mobile / very narrow: degrade to a single stacked column (no absolute
  // placement) so terminals stay usable on small screens.
  if (isMobileGrid(ts)) {
    return html`
      <div class="term-grid term-grid-stack" ${observeCanvas(state)}>
        ${sessions.map((session) => renderTerminalCard(state, ts, session))}
      </div>
    `;
  }

  return html`
    <div class="term-grid-canvas" ${observeCanvas(state)}>
      ${sessions.map((session) => renderTile(state, ts, session))}
      ${renderSnapGuides(ts)}
      ${renderDockPreview(ts)}
    </div>
  `;
}

// ── Layouts dropdown ─────────────────────────────────────────

const TERM_QUICK_PRESETS: Array<{ id: TerminalQuickPresetId; icon: string; key: string }> = [
  { id: "one", icon: "▢", key: "terminals.layouts.preset.one" },
  { id: "twoCol", icon: "▥", key: "terminals.layouts.preset.twoCol" },
  { id: "threeCol", icon: "▦", key: "terminals.layouts.preset.threeCol" },
  { id: "grid", icon: "▣", key: "terminals.layouts.preset.grid" },
  { id: "focusLeft", icon: "◧", key: "terminals.layouts.preset.focusLeft" },
  { id: "focusRight", icon: "◨", key: "terminals.layouts.preset.focusRight" },
];

function renderLayoutsDropdown(state: AppViewState, ts: TerminalsState) {
  return html`
    <div class="layouts-dropdown-wrapper">
      <button
        class="term-btn-icon term-layouts-btn"
        @click=${(e: MouseEvent) => { e.stopPropagation(); toggleTerminalLayoutsMenu(state); }}
        title="${t("terminals.layouts.button", undefined, "Layouts")}"
        style="${ts.showLayoutsMenu ? "color:var(--g-primary);border-color:color-mix(in srgb, var(--g-primary) 30%, transparent);" : ""}"
      >${icons.layout}</button>
      ${ts.showLayoutsMenu
        ? renderLayoutsMenu({
            quickPresets: TERM_QUICK_PRESETS.map((q) => ({
              id: q.id,
              icon: q.icon,
              label: t(q.key, undefined, q.id),
            })),
            savedPresets: ts.layoutPresets.map((p) => ({
              name: p.name,
              count: p.entries.length,
              savedAt: p.savedAt,
            })),
            labels: {
              quickSection: t("terminals.layouts.quick", undefined, "Quick Layouts"),
              currentSection: t("terminals.layouts.current", undefined, "Current Layout"),
              save: t("terminals.layouts.save", undefined, "Save current as preset…"),
              savedSection: (n) =>
                n > 0
                  ? t("terminals.layouts.saved", { count: n }, `Saved (${n})`)
                  : t("terminals.layouts.none", undefined, "No saved layouts"),
              deleteTitle: t("terminals.layouts.delete", undefined, "Delete preset"),
              countUnit: t("terminals.layouts.unit", undefined, "terminals"),
            },
            onApplyQuick: (id) => applyTerminalQuickPreset(state, id as TerminalQuickPresetId),
            onSave: () => {
              const name = prompt(
                t("terminals.layouts.savePrompt", undefined, "Save terminal layout as:"),
                `Layout ${new Date().toLocaleString()}`,
              );
              if (name) saveTerminalLayoutPreset(state, name);
            },
            onApply: (name) => applyTerminalLayoutPreset(state, name),
            onDelete: (name, e) => {
              e.stopPropagation();
              const msg = t("terminals.layouts.deleteConfirm", { name }, `Delete preset "${name}"?`);
              if (confirm(msg)) deleteTerminalLayoutPreset(state, name);
            },
          })
        : nothing}
    </div>
  `;
}

// ── Resize Handle ────────────────────────────────────────────

let isDraggingResize = false;
let startY = 0;
let startHeight = 0;

function renderResizeHandle(state: AppViewState, ts: TerminalsState) {
  const handleMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    isDraggingResize = true;
    startY = e.clientY;
    startHeight = ts.lowerPanelHeight;
    
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add('dragging');
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingResize) return;
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(100, Math.min(startHeight + deltaY, 600));
      setLowerPanelHeight(state, newHeight);
    };
    
    const handleMouseUp = () => {
      isDraggingResize = false;
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return html`
    <div class="term-resize-handle" @mousedown=${handleMouseDown} title="Drag to resize chart panel">
    </div>
  `;
}

// ── Lower Panel with Chart ───────────────────────────────────

// ── Activity bar (bottom) collapse persistence ───────────────
//
// Reuses the existing `showLowerPanel` runtime flag but persists the user's
// choice to localStorage so the bar stays collapsed/expanded across reloads.
// Kept entirely view-side (no controller change) so it composes cleanly with
// concurrent work on the terminal controller.
const LOWER_PANEL_COLLAPSE_KEY = "infinibot-terminal-activity-collapsed";

function hydrateLowerPanelCollapse(ts: TerminalsState): void {
  if ((ts as unknown as { __lowerCollapseHydrated?: boolean }).__lowerCollapseHydrated) return;
  (ts as unknown as { __lowerCollapseHydrated?: boolean }).__lowerCollapseHydrated = true;
  try {
    const v = localStorage.getItem(LOWER_PANEL_COLLAPSE_KEY);
    if (v === "1") ts.showLowerPanel = false;
    else if (v === "0") ts.showLowerPanel = true;
  } catch { /* localStorage unavailable — fall back to in-memory default */ }
}

function toggleLowerPanelPersisted(state: AppViewState): void {
  toggleLowerPanel(state);
  try {
    const open = state.terminalsState?.showLowerPanel ?? true;
    localStorage.setItem(LOWER_PANEL_COLLAPSE_KEY, open ? "0" : "1");
  } catch { /* ignore persistence failure */ }
}

/**
 * Bottom activity bar. Expanded → resize handle + full panel with the two
 * shared /activity components. Collapsed → a thin header strip with an EXPAND
 * chevron so the bar never fully disappears.
 */
function renderActivityBar(state: AppViewState, ts: TerminalsState) {
  if (ts.showLowerPanel) {
    return html`
      ${renderResizeHandle(state, ts)}
      <div class="term-lower-section" style="height: ${ts.lowerPanelHeight}px;">
        ${renderLowerPanel(state, ts)}
      </div>
    `;
  }
  const liveTerminals = ts.sessions.filter(
    (s) => s.status === "running" || s.status === "claude-active",
  ).length;
  return html`
    <div class="term-lower-section collapsed">
      <div class="term-lower-header">
        <span class="term-lower-title">${icons.barChart} ACTIVITY MONITOR</span>
        <div class="term-act-stats-inline">
          <span><strong>${liveTerminals}</strong> LIVE</span>
        </div>
        <button class="term-lower-toggle" title="Expand activity bar"
          @click=${() => toggleLowerPanelPersisted(state)} style="margin-left:10px;">
          EXPAND ▲
        </button>
      </div>
    </div>
  `;
}

function renderLowerPanel(state: AppViewState, ts: TerminalsState) {
  const activityState = state.agentActivityState;
  const allSessions = activityState?.sessions ?? [];
  const runningSessions = allSessions
    .filter((s) => s.active && !s.completedViaEvent)
    .slice(0, 6);
  const completedEntries = getRecentlyCompletedEntries(6);

  const liveTerminals = ts.sessions.filter(
    (s) => s.status === "running" || s.status === "claude-active",
  ).length;

  // Gateway client + live-session map mirror exactly what /agent-activity feeds
  // into <subagent-activity-panel>, so the cards correlate live runs identically.
  const client = state.client;
  const liveSessions = new Map(allSessions.map((s) => [s.key, s]));

  return html`
    <div class="term-lower-header">
      <span class="term-lower-title">${icons.barChart} ACTIVITY MONITOR</span>
      <div class="term-act-stats-inline">
        <span><strong>${liveTerminals}</strong> LIVE</span>
        <span><strong>${runningSessions.length}</strong> RUNNING</span>
        <span><strong>${completedEntries.length}</strong> DONE</span>
      </div>
      <button class="term-lower-toggle" @click=${() => toggleLowerPanelPersisted(state)} style="margin-left:10px;">
        MINIMIZE ▼
      </button>
    </div>
    <div class="term-act-body">
      <!-- Subagents card — the EXACT element /activity mounts. No re-skin: the
           component owns its own header/styling/3s self-poll, so it is visually
           indistinguishable from the Activity page. -->
      <div class="term-act-component-wrap">
        ${client ? html`
          <subagent-activity-panel
            .gateway=${client}
            .pollIntervalMs=${3000}
            .limit=${10}
            .liveSessions=${liveSessions}
          ></subagent-activity-panel>
        ` : html`<div class="term-act-empty">Connecting…</div>`}
      </div>
      <!-- Recently completed list — the EXACT element /activity mounts
           (recently-finished-sessions-feed). Same component, same self-poll. -->
      <div class="term-act-component-wrap">
        ${client ? html`
          <recently-finished-sessions-feed
            .gateway=${client}
            .onOpenSession=${() => { state.activityPanelOpen = true; state.requestUpdate?.(); }}
          ></recently-finished-sessions-feed>
        ` : html`<div class="term-act-empty">Connecting…</div>`}
      </div>
    </div>
  `;
}

// ── Activity preview cards ──────────────────────────────────
// Removed: the bottom activity bar now mounts the shared <subagent-activity-panel>
// and <recently-finished-sessions-feed> components directly (see renderLowerPanel),
// so the bespoke preview-card renderers that duplicated their look were deleted to
// keep a single source of truth identical to the /activity page.

// ── Terminal Card ────────────────────────────────────────────

/**
 * Overlay shown over a terminal cell when its PTY has exited or the slot is an
 * empty placeholder (PTY died while the page was closed). Keeps the grid slot
 * intact and gives the user a one-click way to relaunch into it — instead of
 * the slot silently disappearing or going blank.
 */
function renderReattachOverlay(state: AppViewState, session: TerminalSession) {
  const placeholder = !!session.isPlaceholder;
  const cliLabel = CLI_CONFIGS[session.cli]?.displayName ?? session.cli;
  return html`
    <div class="term-reattach-overlay ${placeholder ? "placeholder" : ""}" @click=${(e: Event) => e.stopPropagation()}>
      <div class="term-reattach-icon">${placeholder ? "◌" : "⚠"}</div>
      <div class="term-reattach-title">${placeholder ? "Empty slot" : "Session ended"}</div>
      <div class="term-reattach-sub">
        ${placeholder
          ? html`The terminal that was here is no longer running. Reattach to relaunch ${cliLabel} in <code>${session.cwd}</code>.`
          : html`The process exited. The slot is kept — reattach to start a fresh ${cliLabel} session.`}
      </div>
      <div class="term-reattach-actions">
        <button class="term-reattach-btn primary"
          @click=${(e: Event) => { e.stopPropagation(); reconnectTerminalSession(state, session.id); }}
          title="Relaunch ${cliLabel} in this slot">↺ Reattach</button>
        <button class="term-reattach-btn"
          @click=${(e: Event) => { e.stopPropagation(); closeTerminalSession(state, session.id); }}
          title="Remove this grid slot">✕ Remove slot</button>
      </div>
    </div>
  `;
}

/**
 * Fixed-position popover listing every numbered workspace (1..N) plus a "New
 * workspace" option. Picking one MOVES the panel there without touching its
 * terminal session. Anchored to the header button rect stored in state so it
 * escapes the card's `overflow: hidden` clip.
 */
function renderSendToWorkspaceMenu(state: AppViewState, ts: TerminalsState, session: TerminalSession) {
  const anchor = ts.sendMenuAnchor;
  // Clamp within the viewport so the menu never spills off the right/bottom.
  const menuW = 176;
  const left = anchor ? Math.max(8, Math.min(anchor.x - menuW + 24, window.innerWidth - menuW - 8)) : 40;
  const top = anchor ? Math.min(anchor.y + 6, window.innerHeight - 40) : 40;
  const current = workspaceOf(ts, session.id);
  const nums = Array.from({ length: ts.workspaceCount }, (_, i) => i + 1);
  return html`
    <div class="term-send-backdrop" @click=${(e: Event) => { e.stopPropagation(); toggleSendMenu(state, null); }}></div>
    <div class="term-send-menu" style="left:${left}px;top:${top}px;" @click=${(e: Event) => e.stopPropagation()}>
      <div class="term-send-menu-title">Send to workspace</div>
      ${nums.map((n) => html`
        <button class="term-send-menu-item ${n === current ? "current" : ""}"
          ?disabled=${n === current}
          @click=${(e: Event) => { e.stopPropagation(); sendTerminalToWorkspace(state, session.id, n); }}>
          <span class="term-send-menu-num">${n}</span>
          <span>Workspace ${n}</span>
          ${n === current ? html`<span class="term-send-menu-here">here</span>` : nothing}
        </button>`)}
      <button class="term-send-menu-item new"
        @click=${(e: Event) => { e.stopPropagation(); sendTerminalToWorkspace(state, session.id, ts.workspaceCount + 1); }}>
        <span class="term-send-menu-num">+</span>
        <span>New workspace ${ts.workspaceCount + 1}</span>
      </button>
    </div>
  `;
}

export function renderTerminalCard(state: AppViewState, ts: TerminalsState, session: TerminalSession) {
  const isActive = ts.activeSessionId === session.id;
  const config = CLI_CONFIGS[session.cli];
  const project = session.projectId ? ts.projects.find((p) => p.id === session.projectId) : null;
  const task = session.taskId ? ts.tasks.find((t) => t.id === session.taskId) : null;
  const isDragging = ts.dragSourceId === session.id;
  const isDragOver = ts.dragOverId === session.id;

  const sessions = ts.filterNodeId
    ? ts.sessions.filter(s => (s.nodeId ?? "local") === ts.filterNodeId)
    : ts.sessions;
  const cardIndex = sessions.indexOf(session);
  const isFocused = ts.focusedCardIndex === cardIndex;

  // ── Federation node color (Task 2) ───────────────────────────
  const _nodeId = session.nodeId || "local";
  const _fed = ts.federationNodes.find((n) => n.id === _nodeId);
  const _isLocal = _nodeId === "local" || !!_fed?.isLocal;
  const _nodeName = session.nodeName || _fed?.name || (_isLocal ? "This Device" : _nodeId);
  const _color = nodeColor(_isLocal ? undefined : _nodeId);
  // CSS custom property placed inline; the `.term-node-hi` class then consumes
  // it via rules that carry `!important` (needed to beat canvas-mode resets).
  const _cardCssVar = _color ? `--tnc:${_color};` : "";

  return html`
    <div class="term-card ${_color ? "term-node-hi" : ""} ${isActive ? "active" : ""} ${session.expandedView ? "expanded" : ""} ${isDragging ? "dragging" : ""} ${isDragOver ? "drag-over" : ""} ${session.status === "exited" ? "term-exited" : ""} ${isFocused ? "focused" : ""}"
      style="${_cardCssVar}"
      data-id="${session.id}"
      draggable="true"
      @click=${() => setActiveSession(state, session.id)}
      @dragstart=${(e: DragEvent) => { e.dataTransfer?.setData("text/plain", session.id); startDrag(state, session.id); }}
      @dragover=${(e: DragEvent) => { e.preventDefault(); dragOver(state, session.id); }}
      @dragleave=${() => { if (ts.dragOverId === session.id) { ts.dragOverId = null; state.requestUpdate?.(); } }}
      @drop=${(e: DragEvent) => { e.preventDefault(); dropOn(state, session.id); }}
      @dragend=${() => endDrag(state)}
    >
      <!-- Header / drag handle. Double-click clears any drag-resized
           dimensions on this single card so it returns to the grid sizing. -->
      <div class="term-card-header"
        @dblclick=${(e: MouseEvent) => {
          const card = (e.currentTarget as HTMLElement)?.closest<HTMLElement>(".term-card");
          if (card) { card.style.width = ""; card.style.height = ""; }
          setTimeout(() => getXtermInstance(session.id)?.fit?.(), 50);
        }}
        title="Drag to reorder · Double-click to reset size">
        <div class="term-status-dot ${session.status}"></div>
        <span class="term-card-title">${session.title}</span>
        <span class="term-cli-indicator" style="color:${config.color};border-color:${config.color}40;">
          ${config.icon} ${session.cli.toUpperCase()}
        </span>
        <!-- Device badge — tinted by node color for remote nodes (Task 2) -->
        <span class="term-card-node"
          title="Federation device: ${_nodeName}${_isLocal ? " (local)" : ""}"
          style="${_color
            ? `color:${_color};border-color:${_color}50;background:${_color}18;font-weight:700;`
            : "opacity:0.7;"}">
          ${_isLocal ? "▣" : "●"} ${_nodeName}
        </span>
        <div class="term-card-actions">
          <!-- Spawn button (Task 1): always present, spawns same CLI on same node+cwd -->
          <button class="term-card-action-btn spawn-same"
            @click=${(e: Event) => {
              e.stopPropagation();
              createTerminalSession(state, {
                cli: session.cli,
                cwd: session.cwd,
                nodeId: _nodeId,
              });
            }}
            title="Spawn another ${config.displayName} on ${_nodeName} (${session.cwd})">+</button>
          <!-- Send to another numbered workspace WITHOUT killing the session. -->
          ${session.isPlaceholder ? nothing : html`
          <button class="term-card-action-btn term-send"
            @click=${(e: Event) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              toggleSendMenu(state, session.id, { x: r.left, y: r.bottom });
            }}
            title="Send this panel to another workspace">⇄</button>`}
          <button class="term-card-action-btn reconnect"
            @click=${(e: Event) => { e.stopPropagation(); reconnectTerminalSession(state, session.id); }}
            title="${session.status === "exited" ? "Session exited — click to reconnect" : "Reconnect terminal"}">↺</button>
          <button class="term-card-action-btn" @click=${(e: Event) => { e.stopPropagation(); toggleExpandTerminal(state, session.id); }}
            title="${session.expandedView ? "Restore" : "Maximize"}">${session.expandedView ? "⊡" : "⊞"}</button>
          <button class="term-card-action-btn close" @click=${(e: Event) => { e.stopPropagation(); closeTerminalSession(state, session.id); }}
            title="Close">✕</button>
        </div>
      </div>
      ${ts.sendMenuForId === session.id ? renderSendToWorkspaceMenu(state, ts, session) : nothing}

      <!-- Xterm Terminal. Placeholders (dead/empty slots) never mount an xterm —
           that would spawn a fresh PTY — so the slot just shows the reattach
           overlay until the user explicitly relaunches into it. Exited sessions
           keep their last output underneath the overlay. -->
      <div class="term-output">
        ${session.isPlaceholder
          ? nothing
          : html`<div class="term-output-host" ${xterm({ terminalId: session.id, state, isActive })}></div>`}
        ${session.isPlaceholder || session.status === "exited"
          ? renderReattachOverlay(state, session)
          : nothing}
      </div>

      <!-- Footer -->
      <div class="term-card-footer">
        ${project ? html`<span class="term-pill project">${project.name}</span>` : nothing}
        ${task ? html`<span class="term-pill task">${task.title.slice(0, 24)}</span>` : nothing}
        <span class="term-timestamp">${formatTime(session.createdAt)}</span>
      </div>
    </div>
  `;
}

// ── Side Panel ───────────────────────────────────────────────

function renderSidePanel(state: AppViewState, ts: TerminalsState) {
  const inProgress = ts.tasks.filter((t) => t.status === "in_progress");
  return html`
    <div class="term-side-panel">
      <div class="term-side-section">
        <div class="term-side-title">SESSIONS</div>
        ${ts.agentSessions.length === 0
      ? html`<div style="font-size:9px;color:#3f3f46;">None active</div>`
      : ts.agentSessions.map((s) => html`
            <div class="term-side-item">
              <div class="term-status-dot ${s.status === "active" ? "running" : "idle"}"></div>
              <span class="term-side-item-label">${s.label || s.key}</span>
              <span class="term-side-item-meta">${s.agentId}</span>
            </div>
          `)}
      </div>
      ${inProgress.length > 0 ? html`
        <div class="term-side-section">
          <div class="term-side-title">TASKS</div>
          ${inProgress.slice(0, 8).map((t) => html`
            <div class="term-side-item">
              <div class="term-status-dot running"></div>
              <span class="term-side-item-label">${t.title}</span>
            </div>
          `)}
        </div>
      ` : nothing}
      <div class="term-side-section">
        <div class="term-side-title">TERMINALS</div>
        ${ts.sessions.map((s) => {
        const c = CLI_CONFIGS[s.cli];
        return html`
            <div class="term-side-item" @click=${() => setActiveSession(state, s.id)}>
              <div class="term-status-dot ${s.status}"></div>
              <span class="term-side-item-label">${s.title}</span>
              <span class="term-side-item-meta" style="color:${c.color}">${c.icon}</span>
            </div>
          `;
      })}
      </div>
    </div>
  `;
}

// ── Git Panel ────────────────────────────────────────────────

function renderGitPanel(state: AppViewState, ts: TerminalsState) {
  const gs = ts.gitStatus;
  const branches = ts.gitBranches;
  const log = ts.gitLog;

  function fileStatusClass(status: string): string {
    const x = status[0], y = status[1];
    if (x === "?") return "untracked";
    if (x === "A" || y === "A") return "added";
    if (x === "D" || y === "D") return "deleted";
    return "modified";
  }

  function fileStatusLabel(status: string): string {
    const x = status[0];
    if (x === "?") return "?";
    if (x === "A") return "+";
    if (x === "D") return "−";
    if (x === "M") return "M";
    if (x === "R") return "R";
    return status.trim();
  }

  return html`
    <div class="term-side-panel" style="border-right:1px solid rgba(74,222,128,0.06);border-left:none;">
      <!-- Repo Selector -->
      <div class="git-section">
        <div class="term-side-title" style="color:#4ade80;">⎇ GIT</div>
        ${ts.registeredDirs.length > 0 ? html`
          <select class="term-form-select"
            style="font-size:9px;padding:3px 6px;margin-bottom:4px;"
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v) pickGitCwd(state, v);
            }}>
            <option value="">— Select registered directory —</option>
            ${ts.registeredDirs.map((d) => html`
              <option value=${d.path} ?selected=${ts.gitCwd === d.path}>${d.icon || ""} ${d.name} · ${d.path}</option>
            `)}
          </select>
        ` : nothing}
        <div style="display:flex;gap:4px;align-items:center;">
          <input class="term-form-input" type="text"
            list="git-cwd-suggestions"
            placeholder="repo path (default: cwd)"
            style="font-size:9px;padding:3px 6px;flex:1;"
            .value=${ts.gitCwd}
            @input=${(e: Event) => { ts.gitCwd = (e.target as HTMLInputElement).value; }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") loadGitStatus(state); }}
          />
          <datalist id="git-cwd-suggestions">
            ${ts.registeredDirs.map((d) => html`<option value=${d.path}>${d.name}</option>`)}
            ${ts.systemDirs.filter((d) => !d.key.startsWith("recent:")).map((d) => html`<option value=${d.path}>${d.label}</option>`)}
          </datalist>
          <button class="git-action-btn" @click=${() => loadGitStatus(state)} title="Refresh">↻</button>
        </div>
      </div>

      ${ts.gitLoading ? html`<div class="git-section" style="text-align:center;color:#52525b;font-size:10px;">Loading...</div>` : nothing}

      ${gs ? html`
        <!-- Branch & Status -->
        <div class="git-section">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span class="git-branch-badge">⎇ ${gs.branch}</span>
            ${gs.clean ? html`<span style="font-size:9px;color:#4ade80;">✓ clean</span>` : nothing}
          </div>
          <div class="git-stat">
            ${gs.staged > 0 ? html`<span class="git-stat-item"><span class="git-stat-num green">${gs.staged}</span> staged</span>` : nothing}
            ${gs.unstaged > 0 ? html`<span class="git-stat-item"><span class="git-stat-num yellow">${gs.unstaged}</span> modified</span>` : nothing}
            ${gs.untracked > 0 ? html`<span class="git-stat-item"><span class="git-stat-num red">${gs.untracked}</span> untracked</span>` : nothing}
            ${gs.ahead > 0 ? html`<span class="git-stat-item">↑<span class="git-stat-num">${gs.ahead}</span></span>` : nothing}
            ${gs.behind > 0 ? html`<span class="git-stat-item">↓<span class="git-stat-num">${gs.behind}</span></span>` : nothing}
          </div>

          <!-- Quick Actions -->
          <div class="git-actions">
            <button class="git-action-btn" @click=${() => gitStageAll(state)}>STAGE ALL</button>
            <button class="git-action-btn" @click=${() => gitPush(state)}>PUSH</button>
            <button class="git-action-btn" @click=${() => gitPull(state)}>PULL</button>
            <button class="git-action-btn" @click=${() => gitFetch(state)}>FETCH</button>
            <button class="git-action-btn" @click=${() => gitStash(state, "push")}>STASH</button>
            <button class="git-action-btn" @click=${() => gitStash(state, "pop")}>POP</button>
          </div>

          <!-- Commit Input -->
          <input class="git-commit-input" type="text" placeholder="commit message…"
            @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter") {
          const input = e.target as HTMLInputElement;
          const msg = input.value.trim();
          if (msg) { gitCommit(state, msg); input.value = ""; }
        }
      }}
          />
        </div>

        <!-- Changed Files -->
        ${gs.files.length > 0 ? html`
          <div class="git-section">
            <div class="term-side-title">CHANGES (${gs.files.length})</div>
            <div class="git-files-list">
              ${gs.files.map((f) => html`
                <div class="git-file-item">
                  <span class="git-file-status ${fileStatusClass(f.status)}">${fileStatusLabel(f.status)}</span>
                  <span class="git-file-path">${f.path}</span>
                </div>
              `)}
            </div>
          </div>
        ` : nothing}
      ` : nothing}

      <!-- Branches -->
      ${branches ? html`
        <div class="git-section">
          <div class="term-side-title">BRANCHES (${branches.local.length})</div>
          <div class="git-branch-list">
            ${branches.local.map((b) => html`
              <div class="git-branch-item ${b === branches.current ? "current" : ""}"
                @click=${() => { if (b !== branches.current) gitCheckout(state, b); }}>
                <div class="git-branch-dot"></div>
                <span>${b}</span>
              </div>
            `)}
          </div>
        </div>
      ` : nothing}

      <!-- Recent Commits -->
      ${log.length > 0 ? html`
        <div class="git-section">
          <div class="term-side-title">RECENT COMMITS</div>
          <div class="git-commit-list">
            ${log.slice(0, 8).map((c) => html`
              <div class="git-commit-item">
                <div>
                  <span class="git-commit-hash">${c.short}</span>
                  <span class="git-commit-msg">${c.message.slice(0, 50)}</span>
                </div>
                <div class="git-commit-meta">${c.author} · ${new Date(c.date).toLocaleDateString()}</div>
              </div>
            `)}
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Topbar: Registered-Directories Dropdown ──────────────────

function renderRegisteredDirsDropdown(state: AppViewState, ts: TerminalsState, canAdd: boolean) {
  const dirs = ts.registeredDirs;
  const isOpen = !!ts.showDirsDropdown;

  return html`
    <div class="term-quicklaunch-divider"></div>
    <div class="term-dirs-dropdown">
      <button class="term-quicklaunch-btn"
        style="color:#a1a1aa;border-color:color-mix(in srgb, var(--g-primary) 15%, transparent);--ql-color:color-mix(in srgb, var(--g-primary) 4%, transparent);"
        @click=${(e: MouseEvent) => { e.stopPropagation(); toggleDirsDropdown(state); }}
        title="Saved /directories — click a directory to spawn a terminal there, or use the +N action to spawn a batch.">
        <span class="ql-icon">${icons.folder}</span>
        <span>DIRS${dirs.length > 0 ? ` · ${dirs.length}` : ""}</span>
        <span class="ql-icon" style="font-size:9px;">${isOpen ? "▴" : "▾"}</span>
      </button>
      ${isOpen ? html`
        <div class="term-dirs-menu" @click=${(e: MouseEvent) => e.stopPropagation()}>
          ${dirs.length === 0
            ? html`<div class="term-dirs-menu-empty">No directories registered yet.<br/>Add some on the <strong>/directories</strong> page.</div>`
            : dirs.map((d) => {
              const remote = d.sourceNode && d.sourceNode !== "local";
              const nodeLabel = d.nodeName || d.sourceNode || "local";
              return html`
                <div class="term-dirs-menu-item"
                  @click=${() => { if (canAdd) { spawnBatchInDirectory(state, d.path); toggleDirsDropdown(state, false); } }}
                  title="${d.path}${d.agentId ? ` · agent: ${d.agentId}` : ''} · device: ${nodeLabel}">
                  <span class="term-dirs-menu-icon">${d.icon || icons.folder}</span>
                  <div class="term-dirs-menu-info">
                    <div class="term-dirs-menu-name">
                      ${d.name}
                      ${remote ? html`<span class="term-dirs-menu-badge ${d.syncStatus === "stale" ? "stale" : ""}">${d.syncStatus === "stale" ? "○" : "●"} ${nodeLabel}</span>` : nothing}
                    </div>
                    <div class="term-dirs-menu-path">${d.path}</div>
                  </div>
                  <div class="term-dirs-menu-actions" @click=${(e: MouseEvent) => e.stopPropagation()}>
                    <button class="term-dirs-action-btn" ?disabled=${!canAdd}
                      @click=${() => { spawnBatchInDirectory(state, d.path, { count: 1 }); toggleDirsDropdown(state, false); }}
                      title="Spawn 1 shell here">+1</button>
                    <button class="term-dirs-action-btn" ?disabled=${!canAdd}
                      @click=${() => { spawnBatchInDirectory(state, d.path, { count: 4 }); toggleDirsDropdown(state, false); }}
                      title="Spawn 4 shells here">+4</button>
                    <button class="term-dirs-action-btn" ?disabled=${!canAdd}
                      @click=${() => { spawnBatchInDirectory(state, d.path, { oneOfEachCli: true }); toggleDirsDropdown(state, false); }}
                      title="Spawn one of each CLI here (Shell · Claude · OpenCode · Gemini)">ALL</button>
                  </div>
                </div>
              `;
            })}
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Directory Presets ────────────────────────────────────────

function renderDirPresets(state: AppViewState, ts: TerminalsState, currentCwd: string) {
  const dirs = ts.systemDirs;
  const registered = ts.registeredDirs;
  if ((!dirs || dirs.length === 0) && (!registered || registered.length === 0)) return nothing;

  const norm = (p: string) => (p || "").replace(/\\/g, "/").toLowerCase();
  const isActive = (p: string) => norm(p) === norm(currentCwd);

  // Split into "system" presets (not from recent:*) and recents
  const presets = dirs.filter((d) => !d.key.startsWith("recent:"));
  const recents = dirs.filter((d) => d.key.startsWith("recent:"));

  return html`
    <div class="term-dir-presets">
      ${presets.map((d) => html`
        <button class="term-dir-chip ${isActive(d.path) ? "active" : ""}"
          @click=${() => pickPresetDir(state, d.path)}
          title="${d.path}">
          <span class="term-dir-chip-icon">${d.icon}</span>
          <span class="term-dir-chip-label">${d.label}</span>
        </button>
      `)}
      ${registered.length > 0 ? html`
        <div class="term-dir-presets-divider"></div>
        <div class="term-dir-recents-label">REGISTERED</div>
        ${registered.map((d) => {
          const remote = d.sourceNode && d.sourceNode !== "local";
          const nodeLabel = d.nodeName || d.sourceNode || "local";
          return html`
            <button class="term-dir-chip ${isActive(d.path) ? "active" : ""}"
              @click=${() => pickPresetDir(state, d.path)}
              title="${d.path}${d.agentId ? ` · agent: ${d.agentId}` : ''} · device: ${nodeLabel}">
              <span class="term-dir-chip-icon">${d.icon || icons.folder}</span>
              <span class="term-dir-chip-label">${d.name}</span>
              <span class="term-dir-chip-path">${d.path}</span>
              ${remote ? html`<span class="term-dir-chip-node">${d.syncStatus === "stale" ? "○" : "●"} ${nodeLabel}</span>` : nothing}
            </button>
          `;
        })}
      ` : nothing}
      ${recents.length > 0 ? html`
        <div class="term-dir-presets-divider"></div>
        <div class="term-dir-recents-label">RECENT</div>
        ${recents.map((d) => html`
          <button class="term-dir-chip ${isActive(d.path) ? "active" : ""}"
            @click=${() => pickPresetDir(state, d.path)}
            title="${d.path}">
            <span class="term-dir-chip-icon">${d.icon}</span>
            <span class="term-dir-chip-label">${d.label}</span>
            <span class="term-dir-chip-path">${d.path}</span>
          </button>
        `)}
      ` : nothing}
    </div>
  `;
}

// ── Create Dialog ────────────────────────────────────────────

function renderCreateDialog(state: AppViewState, ts: TerminalsState) {
  const form = ts.createForm;
  const filteredTasks = form.projectId ? ts.tasks.filter((t) => t.projectId === form.projectId) : ts.tasks;
  const selectedNodeId = form.nodeId || "local";
  const selectedNode = ts.federationNodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedNodeHasOllama = nodeHasOllama(selectedNode);
  ts.cliVersions.ollama = resolveCliVersionForNode(ts, "ollama", selectedNodeId);
  const ollamaModelsState = ts.ollamaModelsByNode[selectedNodeId];
  if (form.cli === "ollama" && selectedNodeHasOllama) {
    void loadOllamaModelsForNode(state, selectedNodeId);
  }
  const createDisabled =
    form.cli === "ollama" && (!selectedNodeHasOllama || !form.model);

  return html`
    <div class="term-dialog-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) { ts.showCreateDialog = false; state.requestUpdate?.(); } }}>
      <div class="term-dialog">
        <div class="term-dialog-title">◇ NEW TERMINAL</div>

        <div class="term-form-label">TYPE</div>
        <div class="term-cli-selector">
          ${(Object.keys(CLI_CONFIGS) as CliType[]).map((key) => {
    const config = CLI_CONFIGS[key];
    const ver = resolveCliVersionForNode(ts, key, selectedNodeId);
    const isSelected = form.cli === key;
    const disabled = key === "ollama" && !selectedNodeHasOllama;
    return html`
              <div class="term-cli-option ${isSelected ? "selected" : ""}"
                style="${isSelected ? `border-color:${config.color}50;` : ""}"
                title=${disabled ? "Ollama not installed on this device" : config.displayName}
                ?inert=${disabled}
                @click=${() => {
                  if (disabled) return;
                  form.cli = key;
                  if (key === "ollama") {
                    form.model = "";
                    void loadOllamaModelsForNode(state, selectedNodeId, true);
                  }
                  state.requestUpdate?.();
                }}>
                <span class="term-cli-option-icon" style="color:${config.color}">${config.icon}</span>
                <div class="term-cli-option-name">${config.displayName}</div>
                <div class="term-cli-option-status ${key !== "shell" && ver?.installed ? "ok" : ""}">
                  ${key === "shell" ? "Built-in" : ver?.installed ? `✓` : "—"}
                </div>
              </div>
            `;
  })}
        </div>

        <div class="term-form-group">
          ${renderFederationNodeSelect({
            value: form.nodeId || "local",
            nodes: ts.federationNodes.length > 0 ? ts.federationNodes : [{ id: "local", name: "This Device", isLocal: true, online: true }],
            onChange: (id) => {
              form.nodeId = id;
              form.model = "";
              ts.cliVersions.ollama = resolveCliVersionForNode(ts, "ollama", id || "local");
              if (form.cli === "ollama" && nodeHasOllama(ts.federationNodes.find((n) => n.id === id))) {
                void loadOllamaModelsForNode(state, id || "local", true);
              }
              state.requestUpdate?.();
            },
            compact: true,
            label: "DEVICE",
            className: "term-fed-select",
          })}
          <div class="term-form-hint">
            ${(form.nodeId || "local") === "local"
              ? "Spawns the PTY on this device."
              : "Spawns the PTY on the selected federation node."}
          </div>
        </div>

        ${form.cli === "ollama" ? html`
          <div class="term-form-group">
            <label class="term-form-label">MODEL</label>
            ${!selectedNodeHasOllama ? html`
              <div class="term-form-hint">Ollama not installed on this device.</div>
            ` : html`
              <select class="term-form-select"
                .value=${form.model}
                ?disabled=${!!ollamaModelsState?.loading || (ollamaModelsState?.models?.length ?? 0) === 0}
                @change=${(e: Event) => { form.model = (e.target as HTMLSelectElement).value; state.requestUpdate?.(); }}>
                <option value="">${ollamaModelsState?.loading ? "Loading models..." : "Select a model"}</option>
                ${(ollamaModelsState?.models ?? []).map((m) => html`
                  <option value=${m.name} ?selected=${form.model === m.name}>${m.name}</option>
                `)}
              </select>
              <div class="term-form-hint">
                ${ollamaModelsState?.loading
                  ? "Loading Ollama models from the selected device."
                  : (ollamaModelsState?.models?.length ?? 0) > 0
                    ? "The selected model is passed to the Ollama CLI on spawn."
                    : (ollamaModelsState?.reason ?? "No Ollama models found on this device.")}
              </div>
            `}
          </div>
        ` : nothing}

        <div class="term-form-group">
          <label class="term-form-label">DIRECTORY</label>
          ${renderDirPresets(state, ts, form.cwd)}
          <div style="display:flex;gap:6px;">
            <input class="term-form-input" type="text" placeholder="Workspace default — paste any absolute path" style="flex:1;"
              .value=${form.cwd} @input=${(e: Event) => { form.cwd = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }} />
            ${renderRepoDirButton((path) => { form.cwd = path; state.requestUpdate?.(); }, {
              title: "Terminal directory",
              label: "Project repos",
              initialPath: form.cwd || undefined,
            })}
            <button class="term-browse-btn" @click=${() => openNativeFolderBrowser(state)} title="Browse…">${icons.folder}</button>
          </div>
          <div class="term-form-hint">Pick a system folder above, a project repo, paste any absolute path, or browse.</div>
        </div>

        <div class="term-form-group">
          <label class="term-form-label">NAME</label>
          <input class="term-form-input" type="text" placeholder="Auto" .value=${form.name}
            @input=${(e: Event) => { form.name = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }} />
        </div>

        <div class="term-form-group">
          <label class="term-form-label">PROJECT</label>
          <select class="term-form-select" .value=${form.projectId}
            @change=${(e: Event) => { form.projectId = (e.target as HTMLSelectElement).value; form.taskId = ""; state.requestUpdate?.(); }}>
            <option value="">—</option>
            ${ts.projects.map((p) => html`<option value="${p.id}" ?selected=${form.projectId === p.id}>${p.name}</option>`)}
          </select>
        </div>

        <div class="term-form-group">
          <label class="term-form-label">TASK</label>
          <select class="term-form-select" .value=${form.taskId}
            @change=${(e: Event) => { form.taskId = (e.target as HTMLSelectElement).value; state.requestUpdate?.(); }}>
            <option value="">—</option>
            ${filteredTasks.map((t) => html`<option value="${t.id}" ?selected=${form.taskId === t.id}>${t.title}</option>`)}
          </select>
        </div>

        <!-- Batch spawn controls — let the user fire off multiple terminals
             into the same directory in one click, or one of every CLI. -->
        <div class="term-form-group">
          <label class="term-form-label">COUNT</label>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <div class="term-count-stepper">
              <button class="term-count-btn" ?disabled=${form.oneOfEachCli || form.count <= 1}
                @click=${() => { form.count = Math.max(1, (form.count ?? 1) - 1); state.requestUpdate?.(); }}>−</button>
              <input class="term-count-input" type="number" min="1" max="${ts.maxSessions}"
                .value=${String(form.count ?? 1)}
                ?disabled=${form.oneOfEachCli}
                @input=${(e: Event) => {
                  const v = parseInt((e.target as HTMLInputElement).value, 10);
                  form.count = Number.isFinite(v) ? Math.max(1, Math.min(ts.maxSessions, v)) : 1;
                  state.requestUpdate?.();
                }} />
              <button class="term-count-btn"
                ?disabled=${form.oneOfEachCli || (form.count ?? 1) >= ts.maxSessions}
                @click=${() => { form.count = Math.min(ts.maxSessions, (form.count ?? 1) + 1); state.requestUpdate?.(); }}>+</button>
            </div>
            <label class="term-count-each">
              <input type="checkbox" .checked=${!!form.oneOfEachCli}
                @change=${(e: Event) => { form.oneOfEachCli = (e.target as HTMLInputElement).checked; state.requestUpdate?.(); }} />
              <span>One of each CLI (Shell · Claude · OpenCode · Gemini)</span>
            </label>
          </div>
          <div class="term-form-hint">
            ${form.oneOfEachCli
              ? "Will spawn 4 terminals — one per CLI — in the directory above."
              : (form.count ?? 1) > 1
                ? `Will spawn ${form.count} ${CLI_CONFIGS[form.cli].displayName} terminals in the directory above.`
                : "Spawns a single terminal."}
          </div>
        </div>

        <div class="term-dialog-actions">
          <button class="term-btn" @click=${() => { ts.showCreateDialog = false; state.requestUpdate?.(); }}>CANCEL</button>
          <button class="term-btn primary" ?disabled=${createDisabled} @click=${() => createTerminalSession(state)}>
            ${(() => {
              const n = form.oneOfEachCli ? 4 : (form.count ?? 1);
              return n > 1 ? `+ CREATE ${n}` : "+ CREATE";
            })()}
          </button>
        </div>
      </div>
    </div>
  `;
}
