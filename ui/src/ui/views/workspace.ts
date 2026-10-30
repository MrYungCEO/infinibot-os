/**
 * Workspace view — Bolt.diy-style per-project IDE wrapped in the InfiniBot
 * HUD glassmorphism theme. Four resizable panes:
 *   - Top bar: workspace picker, view-mode tabs (Code/Diff/Preview), dev-URL,
 *     pane-toggles, "Spawn Coder" button.
 *   - Left: file tree rooted at the workspace path.
 *   - Center: file tabs above an editor / diff / preview iframe (mode-driven).
 *   - Right: Claude Coder chat panel (each send spawns a detached agent run
 *     scoped to the workspace's workdir + projectId).
 *
 * State and actions live in controllers/workspace.ts; this file is purely a
 * Lit render function plus inline styles tuned to the HUD tokens
 * (--g-primary, --g-accent, --g-bg, etc.).
 */

import { renderRepoDirButton } from "../project-repos/index";
import { html, nothing, type TemplateResult } from "lit";
import "./work-glass/remaining.css";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import "@xterm/xterm/css/xterm.css";
import { marked } from "marked";
import { icons } from "../icons.js";
import "../components/webchat-model-picker.js";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import type { FileTreeNode } from "../controllers/files.js";
import { renderTerminalCard, terminalsStyles } from "./terminals.js";
import {
  type WorkspaceState,
  type WorkspaceTab,
  type WorkspaceViewMode,
  type ProjectMode,
  type CoderMessage,
  type CoderMode,
  type AgentChatMessage,
  type WorkspaceScaffoldTemplate,
  diffLines,
  getWorkspaceState,
  selectWorkspace,
  openActiveWorkspaceExplicitly,
  toggleExpand,
  openFile,
  closeTab,
  setActiveTab,
  updateTabContent,
  saveTab,
  reloadTab,
  setViewMode,
  setDevUrl,
  reloadPreview,
  togglePane,
  setCoderInput,
  sendCoder,
  clearCoderHistory,
  openNewWorkspaceDialog,
  closeNewWorkspaceDialog,
  setNewWorkspacePath,
  setNewWorkspaceName,
  createWorkspace,
  saveAllTabs,
  getPreviewUrl,
  isHtmlFile,
  loadRecentIds,
  browseForWorkspaceFolder,
  setTabScroll,
  setProjectMode,
  setNewWorkspaceMode,
  setPickerOpen,
  togglePicker,
  setPickerFilter,
  loadRecentFolders,
  addPreviewPane,
  removePreviewPane,
  setSlideIndex,
  openWorkflowPicker,
  closeWorkflowPicker,
  runWorkflowInChat,
  quickActionsForMode,
  setNewWorkspaceTemplate,
  setPreviewRoute,
  setPreviewDevice,
  setInspectorEnabled,
  setRuntimeAutoStart,
  startWorkspaceServer,
  stopWorkspaceServer,
  restartWorkspaceServer,
  installWorkspaceInspectorBridge,
  showWorkspaceVersionDiff,
  revertWorkspaceVersionAction,
  runWorkspaceVisualVerify,
  attachSelectedElementToAgent,
  setWorkspaceAgentModel,
  setWorkspaceAgentThinking,
  setWorkspaceMobileSurface,
  toggleWorkspaceCommandPalette,
  toggleWorkspaceOverflow,
  toggleWorkspaceTerminalDrawer,
  toggleWorkspaceWorkbench,
} from "../controllers/workspace.js";
import {
  getTemplateLibrary,
  getComponentLibrary,
  openTemplatesGallery,
  closeTemplatesGallery,
  toggleComponentsPanel,
  chooseTemplate,
  chooseSnippet,
  closeBindDialog,
  setBindMode,
  setBindDatabaseId,
  setBindNewName,
  confirmBind,
  setCoderMode,
  ensureTuiTerminal,
  restartTuiTerminal,
  loadAgentHistory,
  setAgentInput,
  sendAgentMessage,
  beginLeftResize,
  loadTree,
} from "../controllers/workspace.js";
import {
  renderRelationPill,
  relationPillStyles,
} from "../components/relation-pill.js";
import type {
  WorkspaceTemplate,
  ComponentSnippet,
  TemplateBindingSpec,
} from "../controllers/workspace-templates.js";

// ── Styles (HUD glassmorphism) ──────────────────────────────────────

const STYLES = html`
  <style>
    .ws-shell {
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex: 1 1 auto;
      min-height: 0;
      height: 100%;
      position: relative;
      color: var(--g-fg, #e4e4e7);
      font-family: var(--mono, "JetBrains Mono", monospace);
    }
    .ws-shell .ws-topbar { flex: 0 0 auto; }
    .ws-shell .ws-body,
    .ws-shell > .ws-pane { flex: 1 1 0; min-height: 0; }

    /* ── Top bar ── */
    .ws-topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 14px;
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 6%, rgba(8, 8, 12, 0.85)) 0%,
        rgba(5, 5, 8, 0.9) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      box-shadow:
        0 8px 32px rgba(0, 0, 0, 0.45),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      flex-wrap: wrap;
    }
    .ws-pickwrap {
      position: relative;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ws-pickbtn {
      appearance: none;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px 8px 12px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      background: rgba(0, 0, 0, 0.55);
      color: var(--g-fg, #e4e4e7);
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      cursor: pointer;
      min-width: 240px;
      max-width: 320px;
      text-align: left;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .ws-pickbtn:hover {
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    }
    .ws-pickbtn--open {
      border-color: var(--g-primary);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 22%, transparent);
    }
    .ws-pickbtn .ws-pickbtn-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ws-pickbtn .ws-pickbtn-sub {
      font-weight: 500;
      font-size: 10px;
      opacity: 0.55;
      letter-spacing: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 220px;
    }
    .ws-pickbtn .ws-pickbtn-caret {
      color: var(--g-primary);
      font-size: 10px;
      transition: transform 0.15s;
    }
    .ws-pickbtn--open .ws-pickbtn-caret {
      transform: rotate(180deg);
    }
    .ws-pickpop {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 50;
      width: 360px;
      max-height: 420px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
      background: linear-gradient(160deg,
        rgba(12, 12, 18, 0.95) 0%,
        rgba(6, 6, 10, 0.97) 100%);
      backdrop-filter: blur(28px) saturate(180%);
      -webkit-backdrop-filter: blur(28px) saturate(180%);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6),
        inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    .ws-pickpop-search {
      flex: 0 0 auto;
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      background: rgba(0, 0, 0, 0.55);
      color: var(--g-fg, #e4e4e7);
      font-family: inherit;
      font-size: 12px;
    }
    .ws-pickpop-search:focus {
      outline: none;
      border-color: var(--g-primary);
    }
    .ws-pickpop-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-right: 2px;
    }
    .ws-pickpop-group {
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--g-primary);
      opacity: 0.75;
      padding: 6px 10px 2px;
    }
    .ws-pickrow {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.12s, border-color 0.12s;
    }
    .ws-pickrow:hover {
      background: rgba(255, 255, 255, 0.04);
      border-color: color-mix(in srgb, var(--g-primary) 22%, transparent);
    }
    .ws-pickrow--active {
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 22%, transparent) 0%,
        color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
    }
    .ws-pickrow-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--g-fg, #e4e4e7);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ws-pickrow-path {
      font-size: 10px;
      opacity: 0.55;
      font-family: var(--mono, "JetBrains Mono", monospace);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ws-pickpop-empty {
      padding: 18px 12px;
      text-align: center;
      font-size: 11px;
      opacity: 0.6;
    }
    .ws-pickpop-footer {
      flex: 0 0 auto;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .ws-pickpop-addbtn {
      width: 100%;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px dashed color-mix(in srgb, var(--g-primary) 45%, transparent);
      background: transparent;
      color: var(--g-primary);
      font-family: inherit;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 0.12s;
    }
    .ws-pickpop-addbtn:hover {
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    }

    /* ── New-workspace modal extras ── */
    .ws-newmode-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 6px;
      margin: 4px 0 10px;
    }
    .ws-newmode-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 10px 6px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(0, 0, 0, 0.45);
      color: var(--g-fg, #e4e4e7);
      cursor: pointer;
      transition: border-color 0.12s, background 0.12s;
    }
    .ws-newmode-card:hover {
      border-color: color-mix(in srgb, var(--g-primary) 38%, transparent);
    }
    .ws-newmode-card--active {
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
      box-shadow: 0 0 16px color-mix(in srgb, var(--g-primary) 24%, transparent);
    }
    .ws-newmode-glyph {
      font-size: 18px;
    }
    .ws-newmode-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .ws-recents-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 4px 0 10px;
    }
    .ws-recents-chip {
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      background: rgba(0, 0, 0, 0.45);
      color: rgba(228, 228, 231, 0.85);
      font-family: var(--mono, "JetBrains Mono", monospace);
      font-size: 10px;
      cursor: pointer;
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ws-recents-chip:hover {
      border-color: var(--g-primary);
      color: var(--g-fg, #e4e4e7);
    }
    .ws-modal-err {
      margin: 0 0 8px;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(220, 38, 38, 0.12);
      border: 1px solid rgba(220, 38, 38, 0.4);
      color: #fca5a5;
      font-size: 11px;
    }

    .ws-modetabs {
      display: inline-flex;
      gap: 0;
      padding: 3px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
    }
    .ws-modetab {
      padding: 6px 14px;
      border-radius: 8px;
      border: none;
      background: transparent;
      color: rgba(228, 228, 231, 0.65);
      font-family: inherit;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .ws-modetab:hover { color: var(--g-fg, #e4e4e7); }
    .ws-modetab--active {
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 24%, transparent) 0%,
        color-mix(in srgb, var(--g-primary) 12%, transparent) 100%);
      color: var(--g-primary);
      box-shadow: 0 0 16px color-mix(in srgb, var(--g-primary) 28%, transparent);
    }

    .ws-devurl {
      flex: 1;
      min-width: 220px;
      padding: 8px 12px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      background: rgba(0, 0, 0, 0.55);
      color: var(--g-fg, #e4e4e7);
      font-family: inherit;
      font-size: 12px;
    }
    .ws-devurl:focus {
      outline: none;
      border-color: var(--g-primary);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 25%, transparent);
    }

    .ws-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
      background: linear-gradient(135deg, rgba(15, 15, 20, 0.85) 0%, rgba(8, 8, 12, 0.95) 100%);
      color: rgba(228, 228, 231, 0.85);
      font-family: inherit;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.18s ease;
    }
    .ws-btn:hover:not(:disabled) {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45),
        0 0 24px color-mix(in srgb, var(--g-primary) 18%, transparent);
    }
    .ws-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .ws-btn--primary {
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 32%, transparent) 0%,
        color-mix(in srgb, var(--g-primary) 16%, transparent) 100%);
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
    }
    .ws-iconbtn {
      width: 32px;
      height: 32px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      background: rgba(0, 0, 0, 0.4);
      color: rgba(228, 228, 231, 0.7);
      cursor: pointer;
    }
    .ws-iconbtn:hover { color: var(--g-primary); border-color: color-mix(in srgb, var(--g-primary) 55%, transparent); }
    .ws-iconbtn--on {
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
    }

    /* ── Body grid ── */
    .ws-body {
      display: grid;
      gap: 10px;
      min-height: 0;
      /* Single row, full height — without this, the auto row collapses to
         its content and the xterm host inside the Coder pane ends up 0×0. */
      grid-template-rows: minmax(0, 1fr);
      grid-template-columns:
        var(--ws-left, 380px)
        6px
        minmax(0, 1fr)
        var(--ws-right, 340px);
    }
    .ws-body > * { min-height: 0; min-width: 0; }
    .ws-body--no-left  { grid-template-columns: 0 0 minmax(0, 1fr) var(--ws-right, 340px); }
    .ws-body--no-right { grid-template-columns: var(--ws-left, 380px) 6px minmax(0, 1fr) 0; }
    .ws-body--no-left.ws-body--no-right { grid-template-columns: 0 0 minmax(0, 1fr) 0; }

    /* ── Resize handle ── */
    .ws-resize {
      grid-column: 2;
      cursor: col-resize;
      position: relative;
      background: transparent;
      transition: background 0.15s ease;
    }
    .ws-resize::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 2px;
      height: 36px;
      border-radius: 1px;
      background: color-mix(in srgb, var(--g-primary) 28%, transparent);
      opacity: 0.4;
      transition: all 0.18s ease;
    }
    .ws-resize:hover::before,
    .ws-resize--active::before {
      opacity: 1;
      background: var(--g-primary);
      box-shadow: 0 0 12px var(--g-primary);
      height: 64px;
    }
    .ws-resize--active { background: color-mix(in srgb, var(--g-primary) 8%, transparent); }

    /* ── Right-collapse: button on the rail header + edge tab when hidden ── */
    .ws-rail-collapse {
      width: 22px;
      height: 22px;
      padding: 0;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      background: rgba(0, 0, 0, 0.5);
      color: rgba(228, 228, 231, 0.6);
      font-family: inherit;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      margin-left: auto;
    }
    .ws-rail-collapse:hover {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    }
    .ws-rail-show {
      position: absolute;
      top: 50%;
      right: 0;
      transform: translateY(-50%);
      width: 22px;
      height: 90px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px 0 0 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 24%, transparent);
      border-right: none;
      background: linear-gradient(135deg, rgba(15, 15, 20, 0.85) 0%, rgba(8, 8, 12, 0.95) 100%);
      color: var(--g-primary);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      cursor: pointer;
      z-index: 5;
      box-shadow: -4px 0 20px rgba(0, 0, 0, 0.5),
        0 0 18px color-mix(in srgb, var(--g-primary) 18%, transparent);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
    }
    .ws-rail-show:hover {
      color: var(--g-fg, #e4e4e7);
      box-shadow: -4px 0 20px rgba(0, 0, 0, 0.6),
        0 0 28px color-mix(in srgb, var(--g-primary) 35%, transparent);
    }

    /* ── Pane shell (glass plate) ── */
    .ws-pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      background: linear-gradient(135deg,
        rgba(8, 8, 12, 0.78) 0%,
        rgba(5, 5, 8, 0.92) 100%);
      backdrop-filter: blur(22px) saturate(180%);
      -webkit-backdrop-filter: blur(22px) saturate(180%);
      box-shadow:
        0 8px 28px rgba(0, 0, 0, 0.45),
        inset 0 1px 0 rgba(255, 255, 255, 0.05);
      overflow: hidden;
    }
    .ws-pane--collapsed { display: none; }
    .ws-pane-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--g-primary);
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--g-primary) 6%, transparent) 0%,
        transparent 100%);
    }

    /* ── File tree ── */
    .ws-tree { flex: 1; overflow-y: auto; padding: 8px 6px; }
    .ws-tree::-webkit-scrollbar { width: 6px; }
    .ws-tree::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--g-primary) 30%, transparent); border-radius: 3px; }
    .ws-tree-row {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 12px;
      color: rgba(228, 228, 231, 0.85);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ws-tree-row:hover { background: color-mix(in srgb, var(--g-primary) 10%, transparent); }
    .ws-tree-row--active {
      background: color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: var(--g-primary);
    }
    .ws-tree-chev { width: 10px; opacity: 0.6; font-size: 10px; }
    .ws-tree-icon { font-size: 12px; opacity: 0.85; }

    /* ── Center: tabs + editor ── */
    .ws-center { display: flex; flex-direction: column; min-height: 0; }
    .ws-tabs {
      display: flex;
      gap: 1px;
      padding: 4px 6px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      overflow-x: auto;
      flex-shrink: 0;
    }
    .ws-tab {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 8px 8px 0 0;
      border: 1px solid transparent;
      border-bottom: none;
      background: transparent;
      color: rgba(228, 228, 231, 0.6);
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      max-width: 220px;
      white-space: nowrap;
    }
    .ws-tab:hover { color: var(--g-fg, #e4e4e7); background: rgba(255, 255, 255, 0.03); }
    .ws-tab--active {
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 28%, transparent);
      border-bottom: 1px solid transparent;
    }
    .ws-tab-name { overflow: hidden; text-overflow: ellipsis; }
    .ws-tab-dirty { color: var(--g-accent, #f59e0b); }
    .ws-tab-close {
      width: 16px;
      height: 16px;
      border: none;
      background: transparent;
      color: inherit;
      opacity: 0.5;
      cursor: pointer;
      border-radius: 4px;
      font-size: 14px;
      line-height: 1;
    }
    .ws-tab-close:hover { opacity: 1; background: rgba(239, 68, 68, 0.2); color: #ef4444; }

    .ws-canvas { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .ws-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: rgba(228, 228, 231, 0.5);
      font-size: 13px;
      padding: 40px;
      text-align: center;
    }
    .ws-empty strong { display: block; color: var(--g-primary); font-size: 14px; }
    .ws-empty--primary {
      align-self: center;
      flex: 0 1 auto;
      width: min(520px, calc(100% - 32px));
      margin: auto;
      padding: clamp(28px, 5vw, 48px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 24%, transparent);
      border-radius: 20px;
      background:
        linear-gradient(145deg, color-mix(in srgb, var(--g-primary) 8%, transparent), transparent 58%),
        color-mix(in srgb, var(--g-bg, #08080c) 76%, transparent);
      box-shadow:
        0 24px 72px rgba(0, 0, 0, 0.36),
        inset 0 1px 0 rgba(255, 255, 255, 0.08),
        0 0 42px color-mix(in srgb, var(--g-primary) 10%, transparent);
      backdrop-filter: blur(22px) saturate(150%);
      -webkit-backdrop-filter: blur(22px) saturate(150%);
    }
    .ws-empty--primary .ws-empty-icon {
      display: grid;
      place-items: center;
      width: 52px;
      height: 52px;
      color: var(--g-primary);
      border: 1px solid color-mix(in srgb, var(--g-primary) 36%, transparent);
      border-radius: 16px;
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 10px 26px rgba(0, 0, 0, 0.26);
    }
    .ws-empty--primary .ws-empty-icon svg { width: 25px; height: 25px; }
    .ws-empty--primary strong { font-size: 20px; letter-spacing: -0.025em; }
    .ws-empty--primary > span:not(.ws-empty-icon) {
      max-width: 440px;
      color: color-mix(in srgb, var(--g-fg, #e4e4e7) 58%, transparent);
      line-height: 1.65;
    }
    .ws-empty-cta {
      margin-top: 4px;
      min-height: 38px;
      padding: 0 16px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 62%, transparent);
      border-radius: 11px;
      color: #110d03;
      background: linear-gradient(135deg, #ffe08a, var(--g-primary));
      box-shadow: 0 10px 28px color-mix(in srgb, var(--g-primary) 22%, transparent), inset 0 1px 0 rgba(255,255,255,.5);
      font: 750 12px/1 inherit;
      cursor: pointer;
      transition: transform 160ms ease, box-shadow 160ms ease;
    }
    .ws-empty-cta:hover { transform: translateY(-1px); box-shadow: 0 14px 34px color-mix(in srgb, var(--g-primary) 30%, transparent), inset 0 1px 0 rgba(255,255,255,.55); }
    .ws-empty-cta:focus-visible { outline: 2px solid var(--g-primary); outline-offset: 3px; }
    :root[data-theme="light"] .ws-empty--primary {
      background: linear-gradient(145deg, rgba(255,255,255,.96), rgba(248,243,232,.86));
      box-shadow: 0 22px 62px rgba(91, 70, 25, 0.14), inset 0 1px 0 #fff;
    }

    .ws-editor {
      flex: 1;
      width: 100%;
      padding: 14px 16px;
      border: none;
      outline: none;
      resize: none;
      background: transparent;
      color: var(--g-fg, #e4e4e7);
      font-family: var(--mono, "JetBrains Mono", monospace);
      font-size: 12.5px;
      line-height: 1.55;
      tab-size: 2;
    }
    .ws-editor::-webkit-scrollbar { width: 8px; height: 8px; }
    .ws-editor::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--g-primary) 30%, transparent); border-radius: 4px; }

    .ws-editor-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      background: rgba(0, 0, 0, 0.25);
      font-size: 11px;
      color: rgba(228, 228, 231, 0.6);
      flex-shrink: 0;
    }
    .ws-editor-toolbar .ws-pathmono {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: rgba(228, 228, 231, 0.85);
    }

    /* ── Diff view ── */
    .ws-diff {
      flex: 1;
      min-height: 0;
      overflow: auto;
      font-family: inherit;
      font-size: 12px;
    }
    .ws-diff-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .ws-diff-row td {
      padding: 1px 8px;
      vertical-align: top;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
    }
    .ws-diff-row td.ws-diff-num {
      width: 50px;
      text-align: right;
      color: rgba(228, 228, 231, 0.4);
      user-select: none;
      background: rgba(0, 0, 0, 0.3);
    }
    .ws-diff-row--add {
      background: rgba(16, 185, 129, 0.08);
      color: #6ee7b7;
    }
    .ws-diff-row--add td.ws-diff-num { background: rgba(16, 185, 129, 0.18); color: #34d399; }
    .ws-diff-row--remove {
      background: rgba(239, 68, 68, 0.08);
      color: #fca5a5;
    }
    .ws-diff-row--remove td.ws-diff-num { background: rgba(239, 68, 68, 0.18); color: #f87171; }

    /* ── Preview iframe ── */
    .ws-preview { flex: 1; min-height: 0; position: relative; background: #fff; }
    .ws-preview iframe { width: 100%; height: 100%; border: none; background: #fff; }
    .ws-preview-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: rgba(228, 228, 231, 0.6);
      padding: 40px;
      text-align: center;
      background: rgba(0, 0, 0, 0.45);
    }

    /* ── Right rail (Coder + business strip) ── */
    .ws-right { display: flex; flex-direction: column; min-height: 0; gap: 10px; }
    .ws-right > .ws-pane { flex: 1 1 auto; min-height: 0; }
    .ws-right > .ws-pane:last-child { flex: 0 0 auto; }
    .ws-coder { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .ws-coder-history {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ws-msg {
      padding: 10px 12px;
      border-radius: 12px;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .ws-msg--user {
      align-self: flex-end;
      max-width: 95%;
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 26%, transparent) 0%,
        color-mix(in srgb, var(--g-primary) 14%, transparent) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
      color: var(--g-fg, #e4e4e7);
    }
    .ws-msg--assistant {
      align-self: flex-start;
      max-width: 95%;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: rgba(228, 228, 231, 0.9);
    }
    .ws-msg--pending { opacity: 0.6; font-style: italic; }
    .ws-msg-meta {
      display: block;
      font-size: 9px;
      opacity: 0.55;
      margin-bottom: 4px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .ws-coder-input {
      display: flex;
      gap: 6px;
      padding: 10px;
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      background: rgba(0, 0, 0, 0.35);
    }
    .ws-coder-textarea {
      flex: 1;
      min-height: 64px;
      max-height: 180px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      background: rgba(0, 0, 0, 0.5);
      color: var(--g-fg, #e4e4e7);
      font-family: inherit;
      font-size: 12px;
      resize: vertical;
    }
    .ws-coder-textarea:focus {
      outline: none;
      border-color: var(--g-primary);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 25%, transparent);
    }

    /* ── Business strip (linked rows) ── */
    .ws-linked {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px 12px;
      max-height: 120px;
      overflow-y: auto;
    }
    .ws-linked-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      font-size: 10px;
      font-weight: 600;
      color: rgba(228, 228, 231, 0.85);
    }
    .ws-linked-pill::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--g-primary);
      box-shadow: 0 0 6px var(--g-primary);
    }
    .ws-linked-empty { padding: 12px; color: rgba(228, 228, 231, 0.45); font-size: 11px; }

    /* ── New workspace dialog ── */
    .ws-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(8px);
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ws-modal {
      width: min(560px, 92vw);
      padding: 24px;
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(15, 15, 20, 0.96) 0%, rgba(8, 8, 12, 0.98) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6),
        0 0 60px color-mix(in srgb, var(--g-primary) 20%, transparent);
    }
    .ws-modal h3 { margin: 0 0 14px; color: var(--g-primary); font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; }
    .ws-modal label { display: block; margin: 14px 0 6px; font-size: 11px; color: rgba(228, 228, 231, 0.7); letter-spacing: 0.06em; text-transform: uppercase; }
    .ws-modal input {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      background: rgba(0, 0, 0, 0.55);
      color: var(--g-fg, #e4e4e7);
      font-family: inherit;
      font-size: 13px;
    }
    .ws-modal input:focus { outline: none; border-color: var(--g-primary); }
    .ws-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

    /* ── Coder mode tabs ── */
    .ws-coder-modes {
      display: inline-flex;
      gap: 0;
      padding: 2px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      margin-left: auto;
      font-weight: 500;
      letter-spacing: 0;
      text-transform: none;
    }
    .ws-coder-modes button {
      padding: 4px 10px;
      border-radius: 6px;
      border: none;
      background: transparent;
      color: rgba(228, 228, 231, 0.55);
      font-family: var(--mono, "JetBrains Mono", monospace);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .ws-coder-modes button.on {
      background: color-mix(in srgb, var(--g-primary) 22%, transparent);
      color: var(--g-primary);
      box-shadow: 0 0 14px color-mix(in srgb, var(--g-primary) 25%, transparent);
    }

    /* ── TUI host (uses .term-output styles from terminalsStyles) ── */
    .ws-tui {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: #040404;
      position: relative;
    }
    .ws-tui-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      background: rgba(0, 0, 0, 0.6);
      font-size: 10px;
      color: rgba(228, 228, 231, 0.6);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .ws-tui-toolbar .ws-pathmono {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: rgba(228, 228, 231, 0.85);
      letter-spacing: 0;
      text-transform: none;
    }
    /* The reused Terminal card brings its own column layout (header +
       body); we only need the body filler to flex inside our pane. */
    .ws-tui .term-card {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      border: none;
      border-radius: 0;
      background: transparent;
    }
    .ws-tui .term-card-header,
    .ws-tui .term-card-footer {
      display: none;
    }
    .ws-tui .term-output {
      flex: 1;
      min-height: 0;
    }

    /* ── Native agent chat (matches grid-chat panel styling) ── */
    .ws-agent {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .ws-agent-history {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background:
        radial-gradient(ellipse 90% 70% at 50% 0%,
          color-mix(in srgb, var(--g-primary) 6%, transparent),
          transparent 60%);
    }
    .ws-agent-bubble {
      max-width: 92%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      backdrop-filter: blur(12px) saturate(160%);
      -webkit-backdrop-filter: blur(12px) saturate(160%);
    }
    .ws-agent-bubble--user {
      align-self: flex-end;
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 32%, transparent) 0%,
        color-mix(in srgb, var(--g-primary) 18%, transparent) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 45%, transparent);
      color: var(--g-fg, #e4e4e7);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }
    .ws-agent-bubble--assistant {
      align-self: flex-start;
      background: linear-gradient(135deg, rgba(15, 15, 20, 0.85) 0%, rgba(8, 8, 12, 0.92) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: rgba(228, 228, 231, 0.92);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    .ws-agent-bubble--system {
      align-self: center;
      background: rgba(0, 0, 0, 0.5);
      border: 1px dashed color-mix(in srgb, var(--g-primary) 22%, transparent);
      color: rgba(228, 228, 231, 0.6);
      font-size: 11px;
      font-style: italic;
    }
    .ws-agent-bubble--pending { opacity: 0.65; font-style: italic; }
    .ws-agent-meta {
      display: block;
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 4px;
      opacity: 0.5;
    }
    .ws-agent-input {
      display: flex;
      gap: 6px;
      padding: 10px;
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      background: rgba(0, 0, 0, 0.5);
    }
    .ws-agent-textarea {
      flex: 1;
      min-height: 60px;
      max-height: 180px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      background: rgba(0, 0, 0, 0.55);
      color: var(--g-fg, #e4e4e7);
      font-family: var(--mono, "JetBrains Mono", monospace);
      font-size: 12.5px;
      resize: vertical;
    }
    .ws-agent-textarea:focus {
      outline: none;
      border-color: var(--g-primary);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 22%, transparent);
    }

    /* ── Templates gallery ── */
    .ws-gallery {
      width: min(960px, 94vw);
      max-height: 88vh;
      padding: 24px;
      border-radius: 18px;
      background: linear-gradient(135deg, rgba(15, 15, 20, 0.96) 0%, rgba(8, 8, 12, 0.98) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6),
        0 0 60px color-mix(in srgb, var(--g-primary) 20%, transparent);
      overflow-y: auto;
    }
    .ws-gallery h3 {
      margin: 0 0 6px;
      color: var(--g-primary);
      font-size: 14px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .ws-gallery p { margin: 0 0 18px; color: rgba(228, 228, 231, 0.6); font-size: 12px; }
    .ws-gallery-cats {
      display: flex;
      gap: 6px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }
    .ws-gallery-cat {
      padding: 5px 12px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      color: rgba(228, 228, 231, 0.7);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .ws-gallery-cat--active {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
      background: color-mix(in srgb, var(--g-primary) 16%, transparent);
    }
    .ws-gallery-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }
    .ws-gallery-card {
      padding: 16px;
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(15, 15, 20, 0.7) 0%, rgba(8, 8, 12, 0.85) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 8px;
      transition: all 0.18s ease;
      text-align: left;
    }
    .ws-gallery-card:hover {
      transform: translateY(-2px);
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5),
        0 0 32px color-mix(in srgb, var(--g-primary) 18%, transparent);
    }
    .ws-gallery-glyph { font-size: 22px; opacity: 0.9; }
    .ws-gallery-name {
      font-size: 13px;
      font-weight: 700;
      color: var(--g-fg, #e4e4e7);
    }
    .ws-gallery-tag {
      font-size: 11px;
      color: rgba(228, 228, 231, 0.55);
      line-height: 1.45;
    }
    .ws-gallery-bind {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-top: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      color: var(--g-primary);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      width: fit-content;
    }

    /* ── Components panel (right rail) ── */
    .ws-comps {
      flex: 0 0 auto;
      min-height: 0;
    }
    .ws-comps .ws-comps-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
      max-height: 280px;
      overflow-y: auto;
    }
    .ws-comp {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: left;
    }
    .ws-comp:hover {
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
      background: rgba(0, 0, 0, 0.55);
    }
    .ws-comp-name {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--g-fg, #e4e4e7);
    }
    .ws-comp-desc {
      font-size: 10px;
      color: rgba(228, 228, 231, 0.55);
      margin-top: 2px;
      line-height: 1.4;
    }
    .ws-comp-tag {
      font-size: 8px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      color: var(--g-primary);
      flex-shrink: 0;
    }
    .ws-comp-bind { background: rgba(139, 92, 246, 0.18); color: #c4b5fd; }

    /* ── Bind-form dialog ── */
    .ws-bind {
      width: min(520px, 94vw);
      padding: 24px;
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(15, 15, 20, 0.96) 0%, rgba(8, 8, 12, 0.98) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    }
    .ws-bind-mode {
      display: inline-flex;
      gap: 0;
      padding: 3px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      margin-bottom: 14px;
    }
    .ws-bind-mode button {
      padding: 6px 14px;
      border: none;
      background: transparent;
      color: rgba(228, 228, 231, 0.6);
      font-family: inherit;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      border-radius: 8px;
    }
    .ws-bind-mode button.on {
      background: color-mix(in srgb, var(--g-primary) 22%, transparent);
      color: var(--g-primary);
    }
    .ws-bind-fieldmap {
      max-height: 180px;
      overflow-y: auto;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      font-size: 11px;
      color: rgba(228, 228, 231, 0.85);
      margin-top: 12px;
    }
    .ws-bind-fieldmap-row {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 8px;
      align-items: center;
      padding: 4px 0;
    }
    .ws-bind-fieldmap-arrow { color: var(--g-primary); }

    /* ── Loading + error ── */
    .ws-loading, .ws-err {
      padding: 20px;
      font-size: 12px;
      color: rgba(228, 228, 231, 0.6);
      text-align: center;
    }
    .ws-err { color: #fca5a5; }

    /* ── Project mode picker ── */
    .ws-modepicker {
      display: inline-flex;
      gap: 0;
      padding: 3px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
    }
    .ws-modepick {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 5px 11px;
      border-radius: 7px;
      border: none;
      background: transparent;
      color: rgba(228, 228, 231, 0.55);
      font-family: inherit;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .ws-modepick:hover { color: var(--g-fg, #e4e4e7); }
    .ws-modepick--active {
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 24%, transparent) 0%,
        color-mix(in srgb, var(--g-primary) 12%, transparent) 100%);
      color: var(--g-primary);
      box-shadow: 0 0 14px color-mix(in srgb, var(--g-primary) 22%, transparent);
    }

    /* ── Workflow picker ── */
    .ws-wf-btn {
      position: relative;
    }
    .ws-wf-dropdown {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 50;
      width: 320px;
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(15, 15, 20, 0.97) 0%, rgba(8, 8, 12, 0.99) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6),
        0 0 40px color-mix(in srgb, var(--g-primary) 16%, transparent);
      overflow: hidden;
    }
    .ws-wf-dropdown-header {
      padding: 10px 14px 8px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--g-primary);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    }
    .ws-wf-list {
      max-height: 260px;
      overflow-y: auto;
      padding: 6px;
    }
    .ws-wf-item {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 8px 10px;
      border-radius: 8px;
      border: none;
      background: transparent;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .ws-wf-item:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }
    .ws-wf-item-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--g-fg, #e4e4e7);
      font-family: inherit;
    }
    .ws-wf-item-desc {
      font-size: 10px;
      color: rgba(228, 228, 231, 0.5);
      font-family: inherit;
      text-align: left;
    }
    .ws-wf-empty {
      padding: 14px;
      font-size: 11px;
      color: rgba(228, 228, 231, 0.45);
      text-align: center;
    }

    /* ── Quick actions ── */
    .ws-quick-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      padding: 8px 10px 0;
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
    }
    .ws-quick-action {
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      background: rgba(0, 0, 0, 0.4);
      color: rgba(228, 228, 231, 0.75);
      font-family: inherit;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .ws-quick-action:hover {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    }

    /* ── Document / markdown preview ── */
    .ws-doc-split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .ws-doc-split > * { min-height: 0; overflow: hidden; }
    .ws-doc-split > :first-child {
      border-right: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    }
    .ws-doc-preview {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 24px 28px;
      background:
        radial-gradient(ellipse 80% 50% at 50% 0%,
          color-mix(in srgb, var(--g-primary) 5%, transparent),
          transparent 60%);
    }
    /* Document typography */
    .ws-doc-preview h1, .ws-doc-preview h2, .ws-doc-preview h3,
    .ws-doc-preview h4, .ws-doc-preview h5, .ws-doc-preview h6 {
      color: var(--g-fg, #e4e4e7);
      margin: 1.4em 0 0.6em;
      line-height: 1.25;
      letter-spacing: -0.01em;
    }
    .ws-doc-preview h1 { font-size: 1.8em; border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent); padding-bottom: 0.3em; color: var(--g-primary); }
    .ws-doc-preview h2 { font-size: 1.4em; }
    .ws-doc-preview h3 { font-size: 1.15em; }
    .ws-doc-preview p { color: rgba(228, 228, 231, 0.88); line-height: 1.7; margin: 0 0 1em; font-size: 0.92em; }
    .ws-doc-preview a { color: var(--g-primary); text-decoration: underline; text-underline-offset: 3px; }
    .ws-doc-preview code {
      font-family: var(--mono, "JetBrains Mono", monospace);
      font-size: 0.84em;
      padding: 0.15em 0.4em;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: color-mix(in srgb, var(--g-primary) 85%, var(--g-fg));
    }
    .ws-doc-preview pre {
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      border-radius: 10px;
      padding: 16px 18px;
      overflow-x: auto;
      margin: 1em 0;
    }
    .ws-doc-preview pre code {
      background: none;
      border: none;
      padding: 0;
      font-size: 0.85em;
      color: rgba(228, 228, 231, 0.9);
    }
    .ws-doc-preview blockquote {
      border-left: 3px solid var(--g-primary);
      margin: 1em 0;
      padding: 10px 16px;
      background: color-mix(in srgb, var(--g-primary) 6%, transparent);
      border-radius: 0 8px 8px 0;
      color: rgba(228, 228, 231, 0.75);
      font-style: italic;
    }
    .ws-doc-preview table {
      width: 100%;
      border-collapse: collapse;
      margin: 1em 0;
      font-size: 0.88em;
    }
    .ws-doc-preview th {
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
      color: var(--g-primary);
      padding: 8px 12px;
      text-align: left;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-size: 0.82em;
    }
    .ws-doc-preview td {
      padding: 7px 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      color: rgba(228, 228, 231, 0.85);
    }
    .ws-doc-preview ul, .ws-doc-preview ol {
      padding-left: 1.4em;
      margin: 0 0 1em;
      color: rgba(228, 228, 231, 0.88);
    }
    .ws-doc-preview li { margin: 0.3em 0; line-height: 1.6; font-size: 0.92em; }
    .ws-doc-preview hr {
      border: none;
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      margin: 1.5em 0;
    }
    .ws-doc-preview img { max-width: 100%; border-radius: 8px; }

    /* ── Slide deck ── */
    .ws-slides {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .ws-slides-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      background: rgba(0, 0, 0, 0.5);
      flex-shrink: 0;
    }
    .ws-slides-counter {
      font-size: 11px;
      color: rgba(228, 228, 231, 0.6);
      min-width: 64px;
      text-align: center;
    }
    .ws-slides-canvas {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      align-items: stretch;
    }
    .ws-slide {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 48px 56px;
      overflow-y: auto;
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--g-primary) 4%, rgba(8, 8, 12, 0.95)) 0%,
        rgba(5, 5, 8, 0.98) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      border-radius: 12px;
      margin: 10px;
      box-shadow:
        inset 0 0 80px color-mix(in srgb, var(--g-primary) 4%, transparent),
        0 4px 24px rgba(0, 0, 0, 0.5);
    }
    /* slide inherits doc-preview typography */
    .ws-slide h1 { font-size: 2.2em; color: var(--g-primary); margin: 0 0 0.5em; letter-spacing: -0.02em; }
    .ws-slide h2 { font-size: 1.5em; margin: 0 0 0.5em; color: var(--g-fg, #e4e4e7); }
    .ws-slide p { font-size: 1em; line-height: 1.65; color: rgba(228, 228, 231, 0.85); }
    .ws-slide ul, .ws-slide ol { padding-left: 1.3em; }
    .ws-slide li { font-size: 0.95em; line-height: 1.6; color: rgba(228, 228, 231, 0.82); margin: 0.4em 0; }
    .ws-slide code {
      font-family: var(--mono, "JetBrains Mono", monospace);
      font-size: 0.85em;
      padding: 0.15em 0.4em;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      color: color-mix(in srgb, var(--g-primary) 85%, var(--g-fg));
    }
    .ws-slide pre {
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
      border-radius: 10px;
      padding: 14px 16px;
      overflow-x: auto;
      margin: 0.8em 0;
    }
    .ws-slide pre code { background: none; border: none; padding: 0; }
    .ws-slide blockquote {
      border-left: 3px solid var(--g-primary);
      margin: 1em 0;
      padding: 8px 14px;
      background: color-mix(in srgb, var(--g-primary) 7%, transparent);
      border-radius: 0 8px 8px 0;
      font-style: italic;
      color: rgba(228, 228, 231, 0.75);
    }
    .ws-slides-dots {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px;
      flex-shrink: 0;
    }
    .ws-slides-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--g-primary) 25%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .ws-slides-dot--active {
      background: var(--g-primary);
      box-shadow: 0 0 8px var(--g-primary);
      width: 18px;
      border-radius: 3px;
    }
    .ws-export-btn {
      margin-left: auto;
      padding: 4px 12px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
      background: rgba(0, 0, 0, 0.45);
      color: rgba(228, 228, 231, 0.8);
      font-family: inherit;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .ws-export-btn:hover {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    }

    /* ── Multi-pane preview ── */
    .ws-multi-pane {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .ws-pane-cell {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
    }
    .ws-pane-cell-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: rgba(0, 0, 0, 0.55);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(228, 228, 231, 0.6);
      flex-shrink: 0;
    }
    .ws-pane-cell-close {
      margin-left: auto;
      width: 18px; height: 18px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 4px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
      background: none;
      color: rgba(228, 228, 231, 0.5);
      cursor: pointer;
      font-size: 11px;
    }
    .ws-pane-cell-close:hover { color: var(--g-primary); }
    .ws-pane-cell-body {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    /* ── Add-pane strip ── */
    .ws-add-pane {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 0;
    }
    .ws-add-pane-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px dashed color-mix(in srgb, var(--g-primary) 28%, transparent);
      background: none;
      color: rgba(228, 228, 231, 0.5);
      font-family: inherit;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.05em;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .ws-add-pane-btn:hover {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    }
    /* ── Live runtime / visual canvas ── */
    .ws-runtime {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 34px;
      padding: 4px 6px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--g-bg, #070707) 84%, transparent);
    }
    .ws-runtime-dot { width: 7px; height: 7px; border-radius: 50%; background:#71717a; box-shadow:0 0 0 3px rgba(113,113,122,.12); }
    .ws-runtime--ready .ws-runtime-dot { background:#34d399; box-shadow:0 0 12px rgba(52,211,153,.75); }
    .ws-runtime--starting .ws-runtime-dot,
    .ws-runtime--installing .ws-runtime-dot { background:#f6c85f; box-shadow:0 0 12px rgba(246,200,95,.75); animation:ws-pulse 1s ease-in-out infinite; }
    .ws-runtime--error .ws-runtime-dot { background:#fb7185; box-shadow:0 0 12px rgba(251,113,133,.7); }
    @keyframes ws-pulse { 50% { opacity:.35; transform:scale(.72); } }
    .ws-runtime-meta { display:flex; flex-direction:column; min-width:90px; line-height:1.15; }
    .ws-runtime-meta strong { font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--g-fg,#eee); }
    .ws-runtime-meta span { font-size:9px; color:color-mix(in srgb,var(--g-fg,#eee) 52%,transparent); }
    .ws-mini-btn { border:0; border-radius:7px; padding:5px 7px; background:color-mix(in srgb,var(--g-primary) 12%,transparent); color:var(--g-primary); font:700 9px/1 var(--mono,monospace); cursor:pointer; }
    .ws-mini-btn:hover { background:color-mix(in srgb,var(--g-primary) 23%,transparent); }
    .ws-preview-stage { flex:1; min-height:0; display:flex; flex-direction:column; background:color-mix(in srgb,var(--g-bg,#080808) 92%,#000); }
    .ws-preview-tools { display:flex; align-items:center; gap:7px; padding:7px 9px; border-bottom:1px solid color-mix(in srgb,var(--g-primary) 14%,transparent); background:color-mix(in srgb,var(--g-bg,#080808) 88%,transparent); }
    .ws-device-toggle { display:inline-flex; gap:2px; padding:2px; border-radius:8px; background:rgba(0,0,0,.32); }
    .ws-device-toggle button { width:28px; height:24px; border:0; border-radius:6px; color:color-mix(in srgb,var(--g-fg,#eee) 55%,transparent); background:transparent; cursor:pointer; }
    .ws-device-toggle button.on { color:var(--g-primary); background:color-mix(in srgb,var(--g-primary) 15%,transparent); }
    .ws-route { flex:1; min-width:80px; height:28px; border:1px solid color-mix(in srgb,var(--g-primary) 16%,transparent); border-radius:8px; padding:0 10px; background:rgba(0,0,0,.26); color:var(--g-fg,#eee); font:10px var(--mono,monospace); }
    .ws-preview-viewport { flex:1; min-height:0; display:flex; justify-content:center; overflow:auto; padding:10px; background:repeating-conic-gradient(color-mix(in srgb,var(--g-fg,#fff) 4%,transparent) 0 25%,transparent 0 50%) 0/16px 16px; }
    .ws-preview-device { height:100%; min-height:360px; max-width:100%; background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 22px 60px rgba(0,0,0,.52),0 0 0 1px color-mix(in srgb,var(--g-primary) 18%,transparent); transition:width .22s ease; }
    .ws-preview-device--desktop { width:100%; }
    .ws-preview-device--tablet { width:min(820px,100%); }
    .ws-preview-device--mobile { width:min(390px,100%); }
    .ws-preview-device iframe { display:block; width:100%; height:100%; min-height:360px; border:0; background:#fff; }
    .ws-selection { display:flex; gap:8px; align-items:center; padding:7px 10px; border-top:1px solid color-mix(in srgb,var(--g-primary) 20%,transparent); background:color-mix(in srgb,var(--g-primary) 7%,var(--g-bg,#090909)); font-size:10px; }
    .ws-selection code { color:var(--g-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ws-log-drawer { flex:0 0 min(230px,32vh); min-height:120px; display:flex; flex-direction:column; border-radius:12px; border:1px solid color-mix(in srgb,var(--g-primary) 18%,transparent); overflow:hidden; background:#070707; }
    .ws-log-head { display:flex; align-items:center; gap:8px; padding:7px 11px; border-bottom:1px solid rgba(255,255,255,.08); color:#e7c76a; font-size:9px; font-weight:800; letter-spacing:.11em; text-transform:uppercase; }
    .ws-log { flex:1; margin:0; padding:10px 12px; overflow:auto; white-space:pre-wrap; color:#b9c0c8; font:10.5px/1.55 var(--mono,monospace); }
    .ws-runtime-error { flex:0 0 100%; padding:8px 10px; border-radius:9px; border:1px solid rgba(251,113,133,.35); background:rgba(251,113,133,.08); color:#fda4af; font-size:10px; white-space:pre-wrap; max-height:92px; overflow:auto; }
    .ws-version-drawer { position:absolute; top:58px; right:10px; z-index:45; width:min(520px,calc(100% - 20px)); max-height:72vh; overflow:auto; padding:12px; border:1px solid color-mix(in srgb,var(--g-primary) 30%,transparent); border-radius:14px; background:color-mix(in srgb,var(--g-bg,#080808) 96%,transparent); box-shadow:0 24px 70px rgba(0,0,0,.62); backdrop-filter:blur(24px); }
    .ws-version-row { display:grid; grid-template-columns:1fr auto auto; gap:8px; align-items:center; padding:9px 5px; border-bottom:1px solid color-mix(in srgb,var(--g-fg,#eee) 7%,transparent); }
    .ws-version-row strong { font-size:10px; color:var(--g-fg,#eee); }
    .ws-version-row small { display:block; margin-top:3px; color:color-mix(in srgb,var(--g-fg,#eee) 46%,transparent); }
    .ws-version-diff { max-height:300px; overflow:auto; margin:10px 0 0; padding:10px; border-radius:9px; background:#050505; color:#c7ccd3; white-space:pre-wrap; font:10px/1.5 var(--mono,monospace); }
    .ws-template-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:6px; }
    .ws-template-choice { min-width:0; padding:9px 5px; border-radius:9px; border:1px solid color-mix(in srgb,var(--g-fg,#eee) 9%,transparent); background:rgba(0,0,0,.25); color:color-mix(in srgb,var(--g-fg,#eee) 68%,transparent); font:700 9px/1.2 var(--mono,monospace); cursor:pointer; }
    .ws-template-choice.on { border-color:var(--g-primary); color:var(--g-primary); background:color-mix(in srgb,var(--g-primary) 12%,transparent); }
    :root[data-theme="light"] .ws-runtime,
    :root[data-theme="light"] .ws-preview-tools,
    :root[data-theme="light"] .ws-version-drawer { background:rgba(255,255,255,.96); }
    :root[data-theme="light"] .ws-route { background:rgba(255,255,255,.9); }
    @media (max-width: 760px) {
      .ws-shell { gap:6px; }
      .ws-topbar { flex-wrap:nowrap; overflow-x:auto; padding:7px; border-radius:10px; }
      .ws-pickbtn { min-width:170px; max-width:210px; }
      .ws-modepicker,.ws-wf-btn,.ws-add-pane-btn,.ws-devurl { display:none!important; }
      .ws-body,.ws-body--no-right { display:flex; flex-direction:column; gap:6px; }
      .ws-body > .ws-pane:first-child { flex:0 0 42%; }
      .ws-resize,.ws-right,.ws-rail-show { display:none!important; }
      .ws-center { flex:1 1 58%; }
      .ws-tabs { max-height:34px; }
      .ws-preview-tools { padding:5px; }
      .ws-preview-viewport { padding:4px; }
      .ws-preview-device { border-radius:7px; min-height:280px; }
      .ws-preview-device iframe { min-height:280px; }
      .ws-runtime-meta { min-width:70px; }
      .ws-runtime-meta span { display:none; }
      .ws-newmode-grid,.ws-template-grid { grid-template-columns:repeat(2,1fr); }
    }
  </style>
`;

const STUDIO_STYLES = html`
  <style>
    .ws-shell--studio {
      --ws-glass-1: color-mix(in srgb, var(--g-bg, #070707) 78%, transparent);
      --ws-glass-2: color-mix(in srgb, var(--g-bg, #070707) 88%, transparent);
      --ws-glass-3: color-mix(in srgb, var(--g-bg, #070707) 94%, transparent);
      --ws-stroke: color-mix(in srgb, var(--g-primary, #f6c85f) 18%, rgba(255,255,255,.08));
      --ws-stroke-strong: color-mix(in srgb, var(--g-primary, #f6c85f) 42%, transparent);
      --ws-blur: blur(22px) saturate(145%);
      --ws-elev-1: 0 8px 24px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.045);
      --ws-elev-2: 0 16px 44px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.06), inset 0 -1px 0 rgba(0,0,0,.2);
      --ws-elev-3: 0 26px 72px rgba(0,0,0,.48), 0 0 0 1px rgba(255,255,255,.025), inset 0 1px 0 rgba(255,255,255,.08);
      --ws-glow: 0 0 30px color-mix(in srgb, var(--g-primary, #f6c85f) 18%, transparent);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      isolation: isolate;
    }
    :root:has(.ws-shell--studio) .shell {
      animation: none;
      opacity: 1;
    }
    .ws-shell--studio::before {
      content: "";
      position: absolute;
      inset: -12px;
      pointer-events: none;
      z-index: -1;
      background:
        radial-gradient(circle at 8% 8%, color-mix(in srgb, var(--g-primary) 9%, transparent), transparent 34%),
        radial-gradient(circle at 92% 18%, rgba(120,90,255,.08), transparent 36%);
    }
    .ws-studio-header {
      min-height: 52px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 9px;
      border: 1px solid var(--ws-stroke);
      border-radius: 15px;
      background: var(--ws-glass-2);
      backdrop-filter: var(--ws-blur);
      -webkit-backdrop-filter: var(--ws-blur);
      box-shadow: var(--ws-elev-2);
      position: relative;
      z-index: 20;
    }
    .ws-studio-header .ws-pickbtn {
      min-width: 280px;
      max-width: 340px;
      height: 38px;
      padding: 6px 10px;
      border-color: var(--ws-stroke);
      background: rgba(255,255,255,.025);
      border-radius: 10px;
    }
    .ws-project-meta { display:flex; align-items:center; gap:6px; min-width:0; }
    .ws-framework-badge,
    .ws-branch-badge {
      display:inline-flex;
      align-items:center;
      height:22px;
      padding:0 8px;
      border-radius:999px;
      border:1px solid var(--ws-stroke);
      color:color-mix(in srgb,var(--g-fg,#eee) 66%,transparent);
      background:rgba(255,255,255,.025);
      font:700 9px/1 var(--mono,monospace);
      letter-spacing:.04em;
      white-space:nowrap;
    }
    .ws-framework-badge { color:var(--g-primary); border-color:var(--ws-stroke-strong); }
    .ws-status-pill {
      display:inline-flex;
      align-items:center;
      gap:7px;
      height:34px;
      padding:0 11px;
      border-radius:999px;
      border:1px solid var(--ws-stroke);
      background:rgba(255,255,255,.025);
      color:var(--g-fg,#eee);
      font-size:11px;
      font-weight:700;
      cursor:pointer;
      white-space:nowrap;
    }
    .ws-status-pill::before { content:""; width:7px; height:7px; border-radius:50%; background:#71717a; box-shadow:0 0 0 4px rgba(113,113,122,.12); }
    .ws-status-pill--ready::before { background:#34d399; box-shadow:0 0 14px rgba(52,211,153,.72); }
    .ws-status-pill--starting::before,
    .ws-status-pill--installing::before,
    .ws-status-pill--detecting::before { background:#f6c85f; box-shadow:0 0 14px rgba(246,200,95,.7); animation:ws-pulse 1s ease-in-out infinite; }
    .ws-status-pill--error::before { background:#fb7185; box-shadow:0 0 14px rgba(251,113,133,.72); }
    .ws-header-spacer { flex:1; min-width:4px; }
    .ws-header-route {
      width:min(280px,24vw);
      height:34px;
      border:1px solid var(--ws-stroke);
      border-radius:9px;
      background:rgba(0,0,0,.18);
      color:var(--g-fg,#eee);
      padding:0 11px;
      font:500 11px/1 var(--mono,monospace);
    }
    .ws-header-route:focus { outline:none; border-color:var(--g-primary); box-shadow:0 0 0 3px color-mix(in srgb,var(--g-primary) 14%,transparent); }
    .ws-header-icon {
      width:34px;
      height:34px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
      border:1px solid var(--ws-stroke);
      border-radius:9px;
      color:color-mix(in srgb,var(--g-fg,#eee) 70%,transparent);
      background:rgba(255,255,255,.025);
      cursor:pointer;
      transition:transform .16s ease,border-color .16s ease,color .16s ease,background .16s ease;
    }
    .ws-header-icon svg { width:16px; height:16px; }
    .ws-header-icon:hover,
    .ws-header-icon.on { color:var(--g-primary); border-color:var(--ws-stroke-strong); background:color-mix(in srgb,var(--g-primary) 9%,transparent); transform:translateY(-1px); }
    .ws-device-toggle--header { border:1px solid var(--ws-stroke); background:rgba(0,0,0,.16); }
    .ws-device-toggle--header button { width:32px; height:30px; display:inline-flex;align-items:center;justify-content:center; }
    .ws-device-toggle--header svg { width:14px;height:14px; }
    .ws-overflow-wrap { position:relative; }
    .ws-overflow-menu {
      position:absolute;
      top:calc(100% + 8px);
      right:0;
      z-index:80;
      width:260px;
      padding:7px;
      border-radius:13px;
      border:1px solid var(--ws-stroke-strong);
      background:var(--ws-glass-3);
      backdrop-filter:var(--ws-blur);
      -webkit-backdrop-filter:var(--ws-blur);
      box-shadow:var(--ws-elev-3);
    }
    .ws-overflow-menu button {
      width:100%;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      border:0;
      border-radius:8px;
      padding:9px 10px;
      background:transparent;
      color:color-mix(in srgb,var(--g-fg,#eee) 82%,transparent);
      font:600 11px/1.2 inherit;
      cursor:pointer;
      text-align:left;
    }
    .ws-overflow-menu button:hover { background:color-mix(in srgb,var(--g-primary) 10%,transparent); color:var(--g-primary); }
    .ws-overflow-menu small { opacity:.5; font:500 9px/1 var(--mono,monospace); }
    .ws-studio-body {
      flex:1 1 0;
      min-height:0;
      display:grid;
      grid-template-columns:minmax(390px,430px) minmax(0,1fr);
      gap:9px;
    }
    .ws-chat-panel,
    .ws-preview-hero,
    .ws-workbench,
    .ws-terminal-drawer {
      border:1px solid var(--ws-stroke);
      background:var(--ws-glass-1);
      backdrop-filter:var(--ws-blur);
      -webkit-backdrop-filter:var(--ws-blur);
      box-shadow:var(--ws-elev-1);
    }
    .ws-chat-panel { min-height:0; display:flex; flex-direction:column; border-radius:15px; overflow:hidden; }
    .ws-chat-head { display:flex;align-items:center;gap:9px;padding:12px 13px 10px;border-bottom:1px solid var(--ws-stroke); }
    .ws-agent-avatar { width:30px;height:30px;display:grid;place-items:center;border-radius:10px;background:linear-gradient(145deg,color-mix(in srgb,var(--g-primary) 30%,transparent),color-mix(in srgb,var(--g-primary) 8%,transparent));border:1px solid var(--ws-stroke-strong);color:var(--g-primary);box-shadow:var(--ws-glow); }
    .ws-agent-avatar svg { width:16px;height:16px; }
    .ws-chat-title { min-width:0; }
    .ws-chat-title strong { display:block;font-size:12px;color:var(--g-fg,#eee); }
    .ws-chat-title span { display:block;margin-top:2px;font-size:9px;color:color-mix(in srgb,var(--g-fg,#eee) 45%,transparent); }
    .ws-chat-head webchat-model-picker { margin-left:auto; min-width:0; max-width:180px; }
    .ws-agent-history { padding:14px 12px 18px; gap:13px; }
    .ws-agent-bubble { font-family:Inter,ui-sans-serif,system-ui,sans-serif; font-size:12.5px; line-height:1.58; }
    .ws-agent-bubble--assistant { border-radius:6px 14px 14px 14px; background:rgba(255,255,255,.025); }
    .ws-agent-bubble--user { border-radius:14px 6px 14px 14px; }
    .ws-chat-empty { margin:auto; max-width:260px; padding:24px 15px; text-align:center; }
    .ws-chat-empty-visual { width:54px;height:54px;margin:0 auto 13px;display:grid;place-items:center;border-radius:18px;border:1px solid var(--ws-stroke-strong);background:color-mix(in srgb,var(--g-primary) 9%,transparent);color:var(--g-primary);box-shadow:var(--ws-glow); }
    .ws-chat-empty-visual svg { width:25px;height:25px; }
    .ws-chat-empty h3 { margin:0 0 7px;color:var(--g-fg,#eee);font-size:14px; }
    .ws-chat-empty p { margin:0;color:color-mix(in srgb,var(--g-fg,#eee) 53%,transparent);font-size:11px;line-height:1.55; }
    .ws-working-card { align-self:stretch;padding:11px 12px;border-radius:12px;border:1px solid var(--ws-stroke);background:rgba(255,255,255,.02); }
    .ws-working-card summary { cursor:pointer;color:var(--g-primary);font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase; }
    .ws-working-step { display:flex;align-items:center;gap:8px;margin-top:9px;color:color-mix(in srgb,var(--g-fg,#eee) 62%,transparent);font-size:10.5px; }
    .ws-working-step::before { content:"";width:5px;height:5px;border-radius:50%;background:var(--g-primary);box-shadow:0 0 8px var(--g-primary); }
    .ws-checkpoint { display:flex;align-items:center;gap:7px;padding:8px 9px;border-radius:10px;border:1px solid var(--ws-stroke);background:color-mix(in srgb,var(--g-primary) 5%,transparent); }
    .ws-checkpoint-main { min-width:0;flex:1; }
    .ws-checkpoint-main strong { display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:color-mix(in srgb,var(--g-fg,#eee) 82%,transparent);font-size:10px; }
    .ws-checkpoint-main small { display:block;margin-top:2px;color:color-mix(in srgb,var(--g-fg,#eee) 42%,transparent);font-size:9px; }
    .ws-checkpoint button { border:0;background:transparent;color:var(--g-primary);font:700 9px/1 inherit;cursor:pointer;padding:5px; }
    .ws-suggestions { display:flex;gap:6px;padding:0 10px 9px; }
    .ws-suggestion { flex:1 1 0;min-width:0;max-width:none;padding:7px 9px;border-radius:999px;border:1px solid var(--ws-stroke);background:transparent;color:color-mix(in srgb,var(--g-fg,#eee) 62%,transparent);font:600 9.5px/1.2 inherit;cursor:pointer; }
    .ws-suggestion:hover { color:var(--g-primary);border-color:var(--ws-stroke-strong); }
    .ws-selection-context { margin:0 10px 7px;padding:8px 9px;border-radius:10px;border:1px solid var(--ws-stroke-strong);background:color-mix(in srgb,var(--g-primary) 8%,transparent); }
    .ws-selection-context-top { display:flex;align-items:center;gap:7px; }
    .ws-selection-context strong { color:var(--g-primary);font-size:9px;text-transform:uppercase;letter-spacing:.08em; }
    .ws-selection-context code { min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:color-mix(in srgb,var(--g-fg,#eee) 74%,transparent);font-size:9px; }
    .ws-selection-context button { margin-left:auto;border:0;background:none;color:color-mix(in srgb,var(--g-fg,#eee) 48%,transparent);cursor:pointer; }
    .ws-agent-input { display:block;padding:9px 10px 10px;background:rgba(0,0,0,.12); }
    .ws-composer { border:1px solid var(--ws-stroke);border-radius:13px;background:rgba(0,0,0,.2);box-shadow:inset 0 1px 0 rgba(255,255,255,.035);overflow:hidden; }
    .ws-agent-textarea { width:100%;min-height:74px;max-height:170px;padding:11px 12px;border:0;border-radius:0;background:transparent;font-family:Inter,ui-sans-serif,system-ui,sans-serif;resize:none; }
    .ws-composer-foot { display:flex;align-items:center;gap:6px;padding:6px 7px;border-top:1px solid color-mix(in srgb,var(--g-fg,#eee) 7%,transparent); }
    .ws-composer-foot .ws-header-icon { width:28px;height:28px;border:0;background:transparent; }
    .ws-send { margin-left:auto;height:29px;padding:0 11px;border:1px solid var(--ws-stroke-strong);border-radius:8px;background:var(--g-primary);color:#191409;font-size:10px;font-weight:800;cursor:pointer; }
    .ws-send:disabled { opacity:.38;cursor:not-allowed; }
    .ws-preview-hero { min-width:0;min-height:0;display:flex;flex-direction:column;border-radius:15px;overflow:hidden;box-shadow:var(--ws-elev-2); }
    .ws-preview-hero-head { height:39px;display:flex;align-items:center;gap:7px;padding:0 10px;border-bottom:1px solid var(--ws-stroke);background:rgba(255,255,255,.018); }
    .ws-browser-dots { display:flex;gap:5px;margin-right:3px; }
    .ws-browser-dots i { width:6px;height:6px;border-radius:50%;background:color-mix(in srgb,var(--g-fg,#eee) 18%,transparent); }
    .ws-preview-hero-head span { font-size:9px;color:color-mix(in srgb,var(--g-fg,#eee) 43%,transparent); }
    .ws-preview-hero-head .ws-select-toggle { margin-left:auto; }
    .ws-select-toggle { height:27px;display:inline-flex;align-items:center;gap:6px;padding:0 9px;border:1px solid var(--ws-stroke);border-radius:8px;background:transparent;color:color-mix(in srgb,var(--g-fg,#eee) 65%,transparent);font-size:9.5px;font-weight:700;cursor:pointer; }
    .ws-select-toggle svg { width:13px;height:13px; }
    .ws-select-toggle.on { color:#181207;background:var(--g-primary);border-color:var(--g-primary);box-shadow:var(--ws-glow); }
    .ws-preview-viewport--studio { flex:1;min-height:0;padding:14px;background:radial-gradient(circle at 50% 0%,color-mix(in srgb,var(--g-primary) 5%,transparent),transparent 40%),color-mix(in srgb,var(--g-bg,#070707) 95%,#000); }
    .ws-preview-device--studio { position:relative;height:100%;min-height:360px;border-radius:12px;border:1px solid rgba(255,255,255,.1);box-shadow:0 28px 80px rgba(0,0,0,.58),0 0 0 5px rgba(255,255,255,.015); }
    .ws-preview-loading { position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:var(--ws-glass-3);color:color-mix(in srgb,var(--g-fg,#eee) 62%,transparent);font-size:11px; }
    .ws-preview-shimmer { width:min(480px,70%);height:180px;border-radius:15px;background:linear-gradient(100deg,rgba(255,255,255,.025) 20%,color-mix(in srgb,var(--g-primary) 10%,transparent) 40%,rgba(255,255,255,.025) 60%);background-size:240% 100%;animation:ws-shimmer 1.6s linear infinite; }
    @keyframes ws-shimmer { to { background-position:-240% 0; } }
    .ws-preview-error-card { margin:auto;width:min(520px,calc(100% - 36px));padding:22px;border:1px solid rgba(251,113,133,.28);border-radius:16px;background:rgba(251,113,133,.055);box-shadow:var(--ws-elev-2); }
    .ws-preview-error-card strong { display:block;margin-bottom:7px;color:#fda4af;font-size:14px; }
    .ws-preview-error-card p { margin:0 0 12px;color:color-mix(in srgb,var(--g-fg,#eee) 58%,transparent);font-size:11px;line-height:1.5; }
    .ws-preview-error-card pre { max-height:110px;margin:0 0 12px;padding:10px;border-radius:9px;background:rgba(0,0,0,.28);overflow:auto;color:#fda4af;font:9.5px/1.5 var(--mono,monospace);white-space:pre-wrap; }
    .ws-selection-actions { position:absolute;z-index:5;left:50%;bottom:15px;transform:translateX(-50%);display:flex;align-items:center;gap:5px;padding:5px;border:1px solid color-mix(in srgb,var(--g-primary) 58%,transparent);border-radius:11px;background:rgba(10,9,7,.92);box-shadow:0 16px 50px rgba(0,0,0,.55),var(--ws-glow);backdrop-filter:blur(16px); }
    .ws-selection-actions .ws-selection-label { padding:0 8px;color:#f9dc7c;font:700 9px/1 var(--mono,monospace);white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis; }
    .ws-selection-actions button { height:27px;padding:0 8px;border:0;border-radius:7px;background:rgba(255,255,255,.06);color:#f4e7bc;font:700 9px/1 inherit;cursor:pointer; }
    .ws-selection-actions button:first-of-type { background:var(--g-primary);color:#171208; }
    .ws-preview-device--mobile .ws-selection-actions { left:6px;right:6px;bottom:7px;transform:none;gap:3px;padding:4px; }
    .ws-preview-device--mobile .ws-selection-actions .ws-selection-label { display:none; }
    .ws-preview-device--mobile .ws-selection-actions button { flex:1 1 auto;min-width:0;padding:0 5px;font-size:9px;white-space:nowrap; }
    .ws-workbench,
    .ws-terminal-drawer { flex:0 0 min(290px,34vh);min-height:160px;border-radius:14px;overflow:hidden;display:flex;flex-direction:column; }
    .ws-drawer-head { height:38px;display:flex;align-items:center;gap:7px;padding:0 10px;border-bottom:1px solid var(--ws-stroke); }
    .ws-drawer-tabs { display:flex;gap:3px; }
    .ws-drawer-tabs button { height:27px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:color-mix(in srgb,var(--g-fg,#eee) 49%,transparent);font:700 9px/1 inherit;text-transform:uppercase;letter-spacing:.06em;cursor:pointer; }
    .ws-drawer-tabs button.on { color:var(--g-primary);background:color-mix(in srgb,var(--g-primary) 10%,transparent); }
    .ws-drawer-body { flex:1;min-height:0;display:flex;overflow:hidden; }
    .ws-workbench .ws-canvas { flex:1;min-height:0; }
    .ws-workbench-components { flex:1;overflow:auto; }
    .ws-workbench-components .ws-comps-list { display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); }
    .ws-mobile-segment { display:none; }
    .ws-command-backdrop { position:fixed;inset:0;z-index:110;display:flex;align-items:flex-start;justify-content:center;padding-top:min(18vh,160px);background:rgba(0,0,0,.52);backdrop-filter:blur(8px); }
    .ws-command { width:min(560px,calc(100vw - 28px));padding:8px;border:1px solid var(--ws-stroke-strong);border-radius:15px;background:var(--ws-glass-3);box-shadow:var(--ws-elev-3); }
    .ws-command input { width:100%;height:42px;padding:0 12px;border:0;border-radius:10px;background:rgba(255,255,255,.035);color:var(--g-fg,#eee);font:500 13px/1 inherit;outline:none; }
    .ws-command-list { padding-top:6px; }
    .ws-command-list button { width:100%;display:flex;justify-content:space-between;padding:10px;border:0;border-radius:8px;background:transparent;color:color-mix(in srgb,var(--g-fg,#eee) 78%,transparent);font:600 11px/1 inherit;cursor:pointer; }
    .ws-command-list button:hover { background:color-mix(in srgb,var(--g-primary) 10%,transparent);color:var(--g-primary); }
    .ws-command-list kbd { opacity:.45;font:600 9px/1 var(--mono,monospace); }
    :root[data-theme="light"] .ws-shell--studio {
      --g-fg:#2b2519;
      --g-bg:#f4eee3;
      --ws-glass-1:#fffdf8;
      --ws-glass-2:#ffffff;
      --ws-glass-3:#ffffff;
      --ws-stroke:rgba(86,67,24,.18);
      --ws-stroke-strong:rgba(158,109,0,.42);
      --ws-elev-1:0 10px 30px rgba(72,54,14,.10),inset 0 1px 0 rgba(255,255,255,.9);
      --ws-elev-2:0 18px 54px rgba(72,54,14,.14),inset 0 1px 0 rgba(255,255,255,.95);
      --text:#3f3523;
      --text-strong:#17130b;
      --muted:#756b59;
      --bg-elevated:#ffffff;
      --bg-hover:#f6f0e4;
      --border:#ddd3c1;
      --border-strong:#c8b999;
      --popover:#ffffff;
      color:#191812;
    }
    :root[data-theme="light"]:has(.ws-shell--studio) .infinibot-bg-layer {
      display:none !important;
    }
    :root[data-theme="light"]:has(.ws-shell--studio) .topbar {
      background:linear-gradient(180deg,rgba(255,253,248,.98),rgba(247,240,226,.96)) !important;
      color:#2b2519 !important;
      border-bottom-color:rgba(158,109,0,.22) !important;
      box-shadow:inset 0 1px 0 #fff,0 8px 24px rgba(72,54,14,.1) !important;
    }
    :root[data-theme="light"]:has(.ws-shell--studio) .global-agency-switcher {
      background:rgba(255,255,255,.78) !important;
      color:#2b2519 !important;
      border-color:rgba(158,109,0,.28) !important;
    }
    :root[data-theme="light"]:has(.ws-shell--studio) .global-agency-switcher small,
    :root[data-theme="light"]:has(.ws-shell--studio) .global-agency-switcher select {
      color:#2b2519 !important;
    }
    :root[data-theme="light"] .ws-shell--studio::before {
      background:
        radial-gradient(circle at 8% 8%, color-mix(in srgb, var(--g-primary) 10%, transparent), transparent 34%),
        radial-gradient(circle at 92% 18%, rgba(120,90,255,.05), transparent 36%);
    }
    :root[data-theme="light"] .ws-studio-header .ws-pickbtn,
    :root[data-theme="light"] .ws-status-pill,
    :root[data-theme="light"] .ws-header-icon,
    :root[data-theme="light"] .ws-device-toggle--header,
    :root[data-theme="light"] .ws-preview-hero-head,
    :root[data-theme="light"] .ws-working-card,
    :root[data-theme="light"] .ws-checkpoint,
    :root[data-theme="light"] .ws-mobile-segment { background:#faf6ed; }
    :root[data-theme="light"] .ws-header-route,
    :root[data-theme="light"] .ws-composer { background:#ffffff; }
    :root[data-theme="light"] .ws-agent-input { background:#f8f3e9; }
    :root[data-theme="light"] .ws-preview-viewport--studio { background:#eee9df; }
    :root[data-theme="light"] .ws-preview-device--studio { border-color:rgba(68,52,18,.18);box-shadow:0 24px 64px rgba(60,44,12,.16),0 0 0 5px rgba(255,255,255,.7); }
    :root[data-theme="light"] .ws-agent-bubble--assistant { background:#f6f1e7;color:#2e291f; }
    :root[data-theme="light"] .ws-agent-bubble--user { color:#201a0c; }
    :root[data-theme="light"] .ws-chat-head webchat-model-picker {
      --g-surface-strong:#ffffff;
      --g-surface-hover:#f4ecdd;
      --g-border:#d8ccb4;
      --g-border-strong:#bfae8a;
      --g-shadow:0 18px 46px rgba(60,44,12,.18);
      --g-primary-muted:rgba(158,109,0,.12);
    }
    @media (max-width: 900px) {
      .ws-project-meta,.ws-header-route { display:none; }
      .ws-studio-header .ws-pickbtn { min-width:180px;max-width:220px; }
      .ws-studio-body { grid-template-columns:minmax(270px,320px) minmax(0,1fr); }
    }
    @media (max-width: 600px) {
      :root:has(.ws-shell--studio) .topbar {
        display:flex !important;
        align-items:center;
        min-width:0;
      }
      :root:has(.ws-shell--studio) .topbar-left {
        width:auto;
        min-width:0;
        flex:1;
      }
      :root:has(.ws-shell--studio) .topbar-center,
      :root:has(.ws-shell--studio) .topbar-status,
      :root:has(.ws-shell--studio) .topbar-health-pill,
      :root:has(.ws-shell--studio) .global-agency-switcher,
      :root:has(.ws-shell--studio) .topbar-coder-cluster,
      :root:has(.ws-shell--studio) .federation-tab-pill {
        display:none !important;
      }
      .ws-chat-head webchat-model-picker { max-width:170px; }
      .ws-shell--studio { gap:6px; }
      .ws-studio-header { min-height:49px;padding:6px;gap:5px;border-radius:12px; }
      .ws-studio-header .ws-pickbtn { min-width:0;max-width:none;flex:1;height:35px; }
      .ws-studio-header .ws-pickbtn-sub,.ws-studio-header .ws-device-toggle--header,.ws-studio-header .ws-status-pill span { display:none; }
      .ws-status-pill { width:34px;height:34px;padding:0;justify-content:center; }
      .ws-header-spacer { display:none; }
      .ws-mobile-segment { display:flex;flex:0 0 100%;order:10;padding:3px;border:1px solid var(--ws-stroke);border-radius:10px;background:rgba(0,0,0,.1); }
      .ws-mobile-segment button { flex:1;height:29px;border:0;border-radius:7px;background:transparent;color:color-mix(in srgb,var(--g-fg,#eee) 52%,transparent);font:700 10px/1 inherit;cursor:pointer; }
      .ws-mobile-segment button.on { color:var(--g-primary);background:color-mix(in srgb,var(--g-primary) 12%,transparent); }
      .ws-studio-header { flex-wrap:wrap; }
      .ws-studio-body { display:block; }
      .ws-chat-panel,.ws-preview-hero { height:100%; }
      .ws-mobile--preview .ws-chat-panel,.ws-mobile--chat .ws-preview-hero { display:none; }
      .ws-preview-viewport--studio { padding:6px; }
      .ws-preview-device--studio { border-radius:8px; }
      .ws-selection-actions { left:8px;right:8px;bottom:8px;transform:none;overflow-x:auto; }
      .ws-selection-actions .ws-selection-label { max-width:130px; }
      .ws-workbench,.ws-terminal-drawer { position:absolute;inset:104px 0 0;z-index:45;max-height:none; }
      .ws-overflow-menu { position:fixed;right:8px;top:104px;width:calc(100vw - 16px); }
    }
    @media (prefers-reduced-motion: reduce) {
      .ws-shell--studio *, .ws-shell--studio *::before, .ws-shell--studio *::after { animation-duration:.001ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.001ms!important; }
    }
  </style>
`;

// ── Helpers ────────────────────────────────────────────────────────

function langForExt(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : "";
}

function isPreviewableImage(name: string): boolean {
  const ext = langForExt(name);
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext);
}

function relativizePath(absPath: string, rootPath: string): string {
  if (!absPath || !rootPath) return absPath;
  const a = absPath.replace(/\\/g, "/");
  const r = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (a === r) return ".";
  if (a.startsWith(r + "/")) return a.slice(r.length + 1);
  return a;
}

// ── Tree rendering ─────────────────────────────────────────────────

function renderTree(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
  node: FileTreeNode | null,
  depth: number,
): TemplateResult | typeof nothing {
  if (!node) return nothing;
  const indent = depth * 12;
  if (node.isDirectory) {
    const expanded = depth === 0 || ws.expanded.has(node.path);
    const children = expanded ? (node.children ?? []) : [];
    return html`
      <div
        class="ws-tree-row"
        style="padding-left: ${indent + 8}px"
        @click=${() => toggleExpand(state, node.path)}
        title=${node.path}
      >
        <span class="ws-tree-chev">${expanded ? "▾" : "▸"}</span>
        <span class="ws-tree-icon">${icons.folder}</span>
        <span>${node.name}</span>
      </div>
      ${children.map((c) => renderTree(state, client, ws, c, depth + 1))}
    `;
  }
  const isActive = ws.activeTabPath === node.path;
  return html`
    <div
      class="ws-tree-row ${isActive ? "ws-tree-row--active" : ""}"
      style="padding-left: ${indent + 22}px"
      @click=${() => openFile(state, client, node.path)}
      title=${node.path}
    >
      <span class="ws-tree-icon">${icons.fileText}</span>
      <span class="ws-tree-name">${node.name}</span>
    </div>
  `;
}

// ── Files mode (full-pane tree) ────────────────────────────────────

function renderFilesMode(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
  selected: { path: string } | null,
): TemplateResult {
  return html`
    <div class="ws-editor-toolbar">
      <span class="ws-pathmono">${selected?.path ?? "Pick a workspace"}</span>
      <button class="ws-btn" @click=${() => loadTree(state, client)}>Refresh</button>
    </div>
    <div class="ws-tree" style="flex:1;padding:14px 10px;overflow-y:auto">
      ${ws.treeLoading
        ? html`<div class="ws-loading">Loading tree…</div>`
        : ws.tree
          ? renderTree(state, client, ws, ws.tree, 0)
          : html`<div class="ws-loading">${selected ? "(empty)" : "Pick a workspace"}</div>`}
    </div>
  `;
}

// ── Editor / Diff / Preview ────────────────────────────────────────

function renderEditor(
  state: AppViewState,
  client: GatewayBrowserClient,
  tab: WorkspaceTab,
): TemplateResult {
  if (tab.loading) return html`<div class="ws-loading">Loading ${tab.name}…</div>`;
  if (tab.error) return html`<div class="ws-err">${tab.error}</div>`;
  if (isPreviewableImage(tab.name)) {
    return html`
      <div class="ws-empty">
        <strong>Image preview not yet supported</strong>
        <span>Open this file in your OS image viewer; binary preview is on the Files tab.</span>
      </div>
    `;
  }
  return html`
    <div class="ws-editor-toolbar">
      <span class="ws-pathmono">${tab.path}</span>
      ${isHtmlFile(tab.name)
        ? html`
            <button
              class="ws-btn"
              title="Render this file in the Preview pane"
              @click=${() => setViewMode(state, "preview")}
            >
              ▶ Preview
            </button>
          `
        : nothing}
      ${tab.dirty
        ? html`<button class="ws-btn ws-btn--primary" @click=${() => saveTab(state, client, tab.path)}>Save</button>`
        : nothing}
      <button
        class="ws-btn"
        title="Save every dirty tab (Ctrl/Cmd+Shift+S)"
        @click=${() => saveAllTabs(state, client)}
      >
        Save all
      </button>
      <button class="ws-btn" @click=${() => reloadTab(state, client, tab.path)}>Reload</button>
    </div>
    <textarea
      class="ws-editor"
      spellcheck="false"
      .value=${tab.content}
      ${ref((el: Element | undefined) => {
        if (!el) return;
        const ta = el as HTMLTextAreaElement;
        // Only restore scroll once per attach — wait a tick so the textarea
        // has its measured size before scrollTop takes effect, otherwise the
        // browser snaps it back to 0.
        const target = tab.scrollTop ?? 0;
        if (target > 0 && ta.scrollTop !== target) {
          requestAnimationFrame(() => {
            try { ta.scrollTop = target; } catch {}
          });
        }
      })}
      @scroll=${(e: Event) =>
        setTabScroll(state, tab.path, (e.target as HTMLTextAreaElement).scrollTop)}
      @input=${(e: Event) =>
        updateTabContent(state, tab.path, (e.target as HTMLTextAreaElement).value)}
      @keydown=${(e: KeyboardEvent) => {
        // Ctrl/Cmd+Shift+S → save all (check before plain Ctrl+S).
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveAllTabs(state, client);
          return;
        }
        // Ctrl/Cmd+S → save the active tab.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveTab(state, client, tab.path);
        }
      }}
    ></textarea>
  `;
}

function renderDiff(tab: WorkspaceTab): TemplateResult {
  const lines = diffLines(tab.original, tab.content);
  const totals = lines.reduce(
    (acc, l) => {
      if (l.kind === "add") acc.add++;
      else if (l.kind === "remove") acc.remove++;
      return acc;
    },
    { add: 0, remove: 0 },
  );
  return html`
    <div class="ws-editor-toolbar">
      <span class="ws-pathmono">${tab.path}</span>
      <span style="color:#34d399">+${totals.add}</span>
      <span style="color:#f87171">−${totals.remove}</span>
    </div>
    <div class="ws-diff">
      <table class="ws-diff-table">
        <tbody>
          ${lines.map(
            (l) => html`
              <tr class="ws-diff-row ws-diff-row--${l.kind}">
                <td class="ws-diff-num">${l.oldNum ?? ""}</td>
                <td class="ws-diff-num">${l.newNum ?? ""}</td>
                <td>
                  ${l.kind === "add" ? "+ " : l.kind === "remove" ? "− " : "  "}${l.text}
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function renderPreview(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  const src = getPreviewUrl(ws);
  if (!src) {
    const errored = ws.runtimeServer?.status === "error";
    return html`
      <div class="ws-preview-stage">
        ${errored
          ? html`
              <div class="ws-preview-error-card">
                <strong>The preview server needs a hand</strong>
                <p>InfiniBot could not start this project. The latest output is included so the agent can repair it with context.</p>
                <pre>${ws.runtimeServer?.error ?? ws.runtimeLogs.slice(-1200)}</pre>
                <button class="ws-send" @click=${() => {
                  setAgentInput(state, `Fix the development server error and restore the live preview:\n\n${ws.runtimeServer?.error ?? ws.runtimeLogs.slice(-1200)}`);
                  setWorkspaceMobileSurface(state, "chat");
                }}>Fix with agent</button>
              </div>
            `
          : html`
              <div class="ws-preview-loading">
                <div class="ws-preview-shimmer"></div>
                <span>${ws.runtimeLoading ? "Detecting the project…" : ws.runtimeDetection?.missingDependencies ? "Dependencies need to be installed" : "Preparing your live preview…"}</span>
                ${ws.runtimeDetection?.missingDependencies
                  ? html`<button class="ws-send" @click=${() => void startWorkspaceServer(state, client, true)}>Install and start</button>`
                  : nothing}
              </div>
            `}
      </div>
    `;
  }
  return html`
    <div class="ws-preview-stage">
      <div class="ws-preview-viewport ws-preview-viewport--studio">
        <div class="ws-preview-device ws-preview-device--studio ws-preview-device--${ws.previewDevice}">
          <iframe
            src=${src}
            title="Workspace live preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            loading="eager"
            @load=${(e: Event) => (e.currentTarget as HTMLIFrameElement).contentWindow?.postMessage({ type: "infinibot:inspector", enabled: ws.inspectorEnabled }, window.location.origin)}
          ></iframe>
          ${ws.selectedElement
            ? html`
                <div class="ws-selection-actions" data-testid="workspace-selection-actions">
                  <span class="ws-selection-label">${ws.selectedElement.tag} · ${ws.selectedElement.selector}</span>
                  <button @click=${() => { attachSelectedElementToAgent(state); setWorkspaceMobileSurface(state, "chat"); }}>Edit with AI</button>
                  <button @click=${() => void navigator.clipboard?.writeText(ws.selectedElement?.selector ?? "")}>Copy selector</button>
                  <button @click=${() => { setViewMode(state, "code"); toggleWorkspaceWorkbench(state, true); }}>Open in code</button>
                </div>
              `
            : nothing}
        </div>
      </div>
    </div>
  `;
}

// ── Coder chat ─────────────────────────────────────────────────────

function renderMessage(msg: CoderMessage): TemplateResult {
  return html`
    <div class="ws-msg ws-msg--${msg.role} ${msg.pending ? "ws-msg--pending" : ""}">
      <span class="ws-msg-meta">${msg.role === "user" ? "you" : "claude coder"}</span>
      ${msg.text}
    </div>
  `;
}

function renderCoder(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  return html`
    <div class="ws-coder">
      <div class="ws-coder-history">
        ${ws.coderMessages.length === 0
          ? html`
              <div class="ws-empty" style="padding:24px;font-size:11px">
                <strong>Claude Coder ready</strong>
                <span>
                  Each send spawns a fresh detached run scoped to this workspace's
                  directory${ws.workspaces.find((w) => w.id === ws.selectedId)?.projectId
                    ? " and project"
                    : ""}.
                </span>
              </div>
            `
          : ws.coderMessages.map(renderMessage)}
      </div>
      ${renderQuickActions(state, ws)}
      <div class="ws-coder-input">
        <textarea
          class="ws-coder-textarea"
          placeholder="What should Claude Coder do? e.g. ‘refactor src/foo.ts to use the new schema’"
          .value=${ws.coderInput}
          ?disabled=${!ws.selectedId || ws.coderRunning}
          @input=${(e: Event) =>
            setCoderInput(state, (e.target as HTMLTextAreaElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void sendCoder(state, client);
            }
          }}
        ></textarea>
        <div style="display:flex;flex-direction:column;gap:6px;align-self:stretch">
          <button
            class="ws-btn ws-btn--primary"
            ?disabled=${!ws.selectedId || ws.coderRunning || !ws.coderInput.trim()}
            @click=${() => sendCoder(state, client)}
            title="Send (Ctrl/Cmd+Enter)"
          >
            ${ws.coderRunning ? "Running…" : "Send"}
          </button>
          <button
            class="ws-iconbtn"
            title="Clear history"
            ?disabled=${ws.coderMessages.length === 0}
            @click=${() => clearCoderHistory(state)}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Linked business rows ───────────────────────────────────────────

function renderLinked(ws: WorkspaceState): TemplateResult {
  if (ws.linkedLoading) return html`<div class="ws-linked-empty">Loading linked rows…</div>`;
  if (ws.linked.length === 0) {
    return html`<div class="ws-linked-empty">No linked tasks/notes for this workspace.</div>`;
  }
  return html`
    ${relationPillStyles}
    <div class="ws-linked">
      ${ws.linked.map((l) =>
        renderRelationPill({
          // Map the database role to the right relation kind so each pill
          // reads as the actual entity type (Tasks DB → "task" pills,
          // Notes DB → "note" pills, etc.).
          kind: relationKindForDb(l.databaseName),
          id: l.rowId,
          label: l.title,
          context: l.databaseName,
          status: statusForLinked(l.status),
          compact: true,
        }),
      )}
    </div>
  `;
}

function relationKindForDb(name: string): "task" | "note" | "project" | "client" | "lead" | "row" {
  const lower = (name ?? "").toLowerCase();
  if (lower.includes("task")) return "task";
  if (lower.includes("note")) return "note";
  if (lower.includes("project")) return "project";
  if (lower.includes("client")) return "client";
  if (lower.includes("lead")) return "lead";
  return "row";
}
function statusForLinked(s: string | undefined): "active" | "done" | "blocked" | "draft" | "paused" | undefined {
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (["done", "completed", "won"].includes(lower)) return "done";
  if (["in_progress", "active", "running"].includes(lower)) return "active";
  if (["blocked", "lost", "failed"].includes(lower)) return "blocked";
  if (["paused", "stale"].includes(lower)) return "paused";
  if (["todo", "draft", "not_started", "pending"].includes(lower)) return "draft";
  return undefined;
}

// ── Markdown rendering helper ──────────────────────────────────────

function renderMarkdownHtml(content: string): string {
  try {
    const result = marked.parse(content, { gfm: true, breaks: true });
    return typeof result === "string" ? result : "";
  } catch {
    return `<pre>${content.replace(/</g, "&lt;")}</pre>`;
  }
}

// ── Document mode ──────────────────────────────────────────────────

function renderDocumentPreview(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
  tab: WorkspaceTab | null,
): TemplateResult {
  const html_ = tab ? renderMarkdownHtml(tab.content) : "";
  const isMarkdown = tab ? /\.(md|mdx|markdown|txt)$/i.test(tab.name) : false;

  if (!tab) {
    return html`<div class="ws-empty"><strong>Open a markdown file</strong><span>Select a .md file from the tree to see the live preview.</span></div>`;
  }

  // Split: editor left, preview right
  return html`
    <div class="ws-doc-split">
      <div style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
        ${renderEditor(state, client, tab)}
      </div>
      <div class="ws-doc-preview">
        ${isMarkdown
          ? html`${unsafeHTML(html_)}`
          : html`<pre style="white-space:pre-wrap;font-size:12px;color:rgba(228,228,231,0.8)">${tab.content}</pre>`}
      </div>
    </div>
  `;
}

function renderDocumentFullPreview(tab: WorkspaceTab | null): TemplateResult {
  if (!tab) {
    return html`<div class="ws-empty"><strong>Open a file</strong><span>Select a markdown file from the tree.</span></div>`;
  }
  const html_ = renderMarkdownHtml(tab.content);
  return html`
    <div class="ws-doc-preview" style="flex:1">
      ${unsafeHTML(html_)}
    </div>
  `;
}

// ── Presentation mode ──────────────────────────────────────────────

function parseSlides(content: string): string[] {
  // Split on `---` separator lines (common in Marp / reveal.js)
  const raw = content.split(/^---\s*$/m);
  // Also support splitting on `# ` level-1 headings when no `---` found
  if (raw.length <= 1) {
    const byH1 = content.split(/^(?=# )/m).filter((s) => s.trim().length > 0);
    if (byH1.length > 1) return byH1;
  }
  return raw.filter((s) => s.trim().length > 0);
}

function renderSlideDeck(
  state: AppViewState,
  _client: GatewayBrowserClient,
  ws: WorkspaceState,
  tab: WorkspaceTab | null,
): TemplateResult {
  if (!tab) {
    return html`<div class="ws-empty"><strong>Open a markdown file</strong><span>Slides are parsed from a markdown file. Open one from the tree.</span></div>`;
  }
  const slides = parseSlides(tab.content);
  const totalSlides = Math.max(1, slides.length);
  const idx = Math.min(ws.slideIndex, totalSlides - 1);
  const currentSlide = slides[idx] ?? "";
  const slideHtml = renderMarkdownHtml(currentSlide);

  return html`
    <div class="ws-slides">
      <div class="ws-slides-toolbar">
        <button
          class="ws-btn"
          ?disabled=${idx === 0}
          @click=${() => setSlideIndex(state, idx - 1)}
        >← Prev</button>
        <span class="ws-slides-counter">${idx + 1} / ${totalSlides}</span>
        <button
          class="ws-btn"
          ?disabled=${idx >= totalSlides - 1}
          @click=${() => setSlideIndex(state, idx + 1)}
        >Next →</button>
        <button
          class="ws-export-btn"
          title="Export as PDF via browser print dialog"
          @click=${() => exportPresentation(slides)}
        >Export PDF</button>
      </div>
      <div class="ws-slides-canvas">
        <div class="ws-slide ws-doc-preview">
          ${unsafeHTML(slideHtml)}
        </div>
      </div>
      <div class="ws-slides-dots">
        ${slides.map((_, i) => html`
          <div
            class="ws-slides-dot ${i === idx ? "ws-slides-dot--active" : ""}"
            @click=${() => setSlideIndex(state, i)}
          ></div>
        `)}
      </div>
    </div>
  `;
}

/** Open a print window with all slides rendered for PDF export. */
function exportPresentation(slides: string[]): void {
  const body = slides
    .map((s, i) => {
      const html_ = (() => {
        try {
          const r = marked.parse(s, { gfm: true, breaks: true });
          return typeof r === "string" ? r : "";
        } catch { return `<pre>${s}</pre>`; }
      })();
      return `<section class="slide"${i > 0 ? ' style="page-break-before:always"' : ""}>${html_}</section>`;
    })
    .join("\n");

  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Presentation Export</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #fff; color: #1a1a1a; }
  .slide { width: 100%; min-height: 100vh; padding: 60px 80px; display: flex; flex-direction: column; justify-content: center; }
  h1 { font-size: 2.4em; margin-bottom: 0.4em; color: #1a1a2e; }
  h2 { font-size: 1.6em; margin-bottom: 0.4em; }
  h3 { font-size: 1.2em; margin-bottom: 0.3em; }
  p { font-size: 1.05em; line-height: 1.65; margin-bottom: 0.8em; }
  ul, ol { padding-left: 1.4em; margin-bottom: 0.8em; }
  li { font-size: 1em; line-height: 1.55; margin: 0.3em 0; }
  code { font-family: monospace; background: #f0f0f0; padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.88em; }
  pre { background: #f5f5f5; padding: 16px; border-radius: 6px; overflow-x: auto; margin: 0.8em 0; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #7c3aed; padding-left: 16px; color: #555; font-style: italic; margin: 0.8em 0; }
  @media print { .slide { page-break-after: always; min-height: 100vh; } }
</style></head><body>${body}</body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 400);
}

// ── PDF mode ───────────────────────────────────────────────────────

function renderPdfPreview(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
  tab: WorkspaceTab | null,
): TemplateResult {
  if (!tab) {
    return html`<div class="ws-empty"><strong>Open a file</strong><span>Select a markdown or HTML file to preview and export as PDF.</span></div>`;
  }

  const isMarkdown = /\.(md|mdx|markdown)$/i.test(tab.name);
  const isHtml = /\.(html?|xhtml)$/i.test(tab.name);
  const rawHtml = isMarkdown
    ? wrapPdfHtml(renderMarkdownHtml(tab.content), tab.name)
    : isHtml
      ? tab.content
      : `<pre style="white-space:pre-wrap;font-family:monospace;font-size:13px">${tab.content.replace(/</g, "&lt;")}</pre>`;

  return html`
    <div style="display:flex;flex-direction:column;flex:1;min-height:0">
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(0,0,0,0.5);border-bottom:1px solid color-mix(in srgb,var(--g-primary) 14%,transparent);flex-shrink:0">
        <span style="font-size:11px;color:rgba(228,228,231,0.6);font-weight:700;letter-spacing:0.08em;text-transform:uppercase">PDF Preview — ${tab.name}</span>
        <button class="ws-export-btn" @click=${() => exportPdf(rawHtml, tab.name)}>Export PDF</button>
        <button class="ws-btn" @click=${() => setViewMode(state, "code")}>Edit Source</button>
      </div>
      <div class="ws-doc-preview" style="flex:1">
        ${unsafeHTML(isMarkdown ? renderMarkdownHtml(tab.content) : tab.content)}
      </div>
    </div>
  `;
}

function wrapPdfHtml(body: string, title: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: Georgia, serif; max-width: 780px; margin: 0 auto; padding: 48px 56px; font-size: 12pt; color: #1a1a1a; line-height: 1.7; }
  h1 { font-size: 2em; border-bottom: 2px solid #333; padding-bottom: 0.2em; }
  h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
  code { background: #f5f5f5; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.88em; }
  pre { background: #f5f5f5; padding: 14px 16px; border-radius: 4px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #666; padding-left: 14px; color: #555; font-style: italic; }
  table { width: 100%; border-collapse: collapse; } th, td { padding: 6px 10px; border: 1px solid #ddd; }
  th { background: #f0f0f0; font-weight: 700; }
  @media print { body { margin: 0; padding: 0; } }
</style></head><body>${body}</body></html>`;
}

function exportPdf(htmlContent: string, name: string): void {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(htmlContent);
  win.document.close();
  win.document.title = name;
  setTimeout(() => win.print(), 400);
}

// ── Multi-pane secondary panels ────────────────────────────────────

function renderSecondaryPane(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
  tab: WorkspaceTab | null,
): TemplateResult {
  if (ws.previewPanes.length === 0) return html``;
  const pane = ws.previewPanes[0]!;

  const body: TemplateResult = (() => {
    switch (pane.renderer) {
      case "markdown":
        return html`<div class="ws-doc-preview" style="flex:1;overflow-y:auto">${unsafeHTML(tab ? renderMarkdownHtml(tab.content) : "")}</div>`;
      case "slides": {
        const slides = tab ? parseSlides(tab.content) : [];
        const idx = Math.min(ws.slideIndex, Math.max(0, slides.length - 1));
        return html`
          <div style="flex:1;overflow-y:auto;padding:16px">
            <div class="ws-slide ws-doc-preview">${unsafeHTML(renderMarkdownHtml(slides[idx] ?? ""))}</div>
          </div>
        `;
      }
      case "pdf":
        return html`<div class="ws-doc-preview" style="flex:1;overflow-y:auto">${unsafeHTML(tab ? renderMarkdownHtml(tab.content) : "")}</div>`;
      case "web":
      default: {
        const src = getPreviewUrl(ws);
        return src
          ? html`<iframe src=${src} style="flex:1;width:100%;border:none" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" loading="lazy"></iframe>`
          : html`<div class="ws-empty" style="font-size:11px">Set a dev URL to see the web preview.</div>`;
      }
    }
  })();

  return html`
    <div class="ws-pane-cell">
      <div class="ws-pane-cell-header">
        ${pane.label}
        <button class="ws-pane-cell-close" @click=${() => removePreviewPane(state, pane.id)} title="Close pane">×</button>
      </div>
      <div class="ws-pane-cell-body">
        ${body}
      </div>
    </div>
  `;
}

// ── Workflow picker dropdown ────────────────────────────────────────

function renderWorkflowPicker(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  if (!ws.workflowPickerOpen) return html``;
  return html`
    <div
      class="ws-wf-dropdown"
      @click=${(e: Event) => e.stopPropagation()}
    >
      <div class="ws-wf-dropdown-header">Run Workflow</div>
      <div class="ws-wf-list">
        ${ws.workflowsLoading
          ? html`<div class="ws-wf-empty">Loading…</div>`
          : ws.availableWorkflows.length === 0
            ? html`<div class="ws-wf-empty">No workflows found. Create one in the Workflows tab.</div>`
            : ws.availableWorkflows.map(
                (wf) => html`
                  <button
                    class="ws-wf-item"
                    @click=${() => runWorkflowInChat(state, client, wf.id)}
                  >
                    <span class="ws-wf-item-name">${wf.name}</span>
                    ${wf.description
                      ? html`<span class="ws-wf-item-desc">${wf.description}</span>`
                      : nothing}
                  </button>
                `,
              )}
      </div>
    </div>
  `;
}

// ── Quick actions bar (for coder rail) ─────────────────────────────

function renderQuickActions(
  state: AppViewState,
  ws: WorkspaceState,
): TemplateResult {
  const actions = quickActionsForMode(ws.projectMode);
  if (!ws.selectedId || actions.length === 0) return html``;
  return html`
    <div class="ws-quick-actions">
      ${actions.map(
        (a) => html`
          <button
            class="ws-quick-action"
            title=${a.prompt}
            @click=${() => {
              setCoderInput(state, a.prompt);
            }}
          >
            ${a.label}
          </button>
        `,
      )}
    </div>
  `;
}

// ── Center canvas dispatcher ────────────────────────────────────────

function renderCenterCanvas(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
  selected: { path: string } | null,
  activeTab: WorkspaceTab | null,
): TemplateResult {
  // Files mode is mode-agnostic — always shows the tree
  if (ws.viewMode === "files") return renderFilesMode(state, client, ws, selected);

  // Mode-specific routing
  switch (ws.projectMode) {
    case "document":
      if (ws.viewMode === "preview") return renderDocumentFullPreview(activeTab);
      if (ws.viewMode === "diff" && activeTab) return renderDiff(activeTab);
      // "code" or default in document mode: split editor + preview
      return renderDocumentPreview(state, client, ws, activeTab);

    case "presentation":
      if (ws.viewMode === "code" && activeTab) return renderEditor(state, client, activeTab);
      if (ws.viewMode === "diff" && activeTab) return renderDiff(activeTab);
      return renderSlideDeck(state, client, ws, activeTab);

    case "pdf":
      if (ws.viewMode === "code" && activeTab) return renderEditor(state, client, activeTab);
      if (ws.viewMode === "diff" && activeTab) return renderDiff(activeTab);
      return renderPdfPreview(state, client, ws, activeTab);

    case "web":
    case "app":
    default:
      if (ws.viewMode === "preview") return renderPreview(state, client, ws);
      if (!activeTab) {
        return html`
          <div class="ws-empty">
            <strong>Select a file</strong>
            <span>Switch to <em>Files</em> mode to browse, then click a file. <code>Ctrl+S</code> saves.</span>
          </div>
        `;
      }
      if (ws.viewMode === "diff") return renderDiff(activeTab);
      return renderEditor(state, client, activeTab);
  }
}

function renderRuntimeControls(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  const status = ws.runtimeServer?.status ?? "stopped";
  const detection = ws.runtimeDetection;
  const label = ws.runtimeLoading ? "detecting" : status;
  return html`
    <div class="ws-runtime ws-runtime--${label}" title=${detection?.envHints?.join("\n") ?? "Workspace runtime"}>
      <span class="ws-runtime-dot"></span>
      <span class="ws-runtime-meta">
        <strong>${detection?.kind ?? "Detecting"} · ${label}</strong>
        <span>${ws.runtimeServer?.port ? `localhost:${ws.runtimeServer.port}` : detection?.packageManager ?? ""}</span>
      </span>
      ${detection?.missingDependencies && status !== "ready"
        ? html`<button class="ws-mini-btn" @click=${() => void startWorkspaceServer(state, client, true)}>Install &amp; start</button>`
        : status === "ready"
          ? html`
              <button class="ws-mini-btn" @click=${() => void restartWorkspaceServer(state, client)}>Restart</button>
              <button class="ws-mini-btn" @click=${() => void stopWorkspaceServer(state, client)}>Stop</button>
            `
          : html`<button class="ws-mini-btn" ?disabled=${ws.runtimeLoading || !detection || detection.kind === "unknown"} @click=${() => void startWorkspaceServer(state, client, false)}>Start</button>`}
      <button class="ws-mini-btn" title="Terminal / dev-server logs" @click=${() => togglePane(state, "terminal")}>Logs</button>
      <button class="ws-mini-btn" title="Per-agent-turn checkpoints" @click=${() => { ws.versionsOpen = !ws.versionsOpen; state.requestUpdate?.(); }}>Versions</button>
      <button class="ws-mini-btn" title=${`Auto-start is ${ws.runtimeAutoStart ? "on" : "off"}`} @click=${() => setRuntimeAutoStart(state, !ws.runtimeAutoStart)}>Auto ${ws.runtimeAutoStart ? "on" : "off"}</button>
    </div>
  `;
}

function renderVersionsDrawer(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  if (!ws.versionsOpen) return html``;
  return html`
    <div class="ws-version-drawer" @click=${(e: Event) => e.stopPropagation()}>
      <div class="ws-pane-header" style="padding:4px 2px 10px">Versions <button class="ws-mini-btn" style="margin-left:auto" @click=${() => { ws.versionsOpen = false; state.requestUpdate?.(); }}>Close</button></div>
      ${ws.versions.length === 0
        ? html`<div class="ws-linked-empty">No Git checkpoints yet. One is created before every visual-agent turn.</div>`
        : ws.versions.map((version) => html`
            <div class="ws-version-row">
              <div><strong>${version.description}</strong><small>${new Date(version.createdAt).toLocaleString()} · ${version.commit.slice(0, 8)}</small></div>
              <button class="ws-mini-btn" @click=${() => void showWorkspaceVersionDiff(state, client, version.id)}>Diff</button>
              <button class="ws-mini-btn" @click=${() => void revertWorkspaceVersionAction(state, client, version.id)}>Revert</button>
            </div>
          `)}
      ${ws.versionDiff ? html`<pre class="ws-version-diff">${ws.versionDiff}</pre>` : nothing}
    </div>
  `;
}

function renderRuntimeLogDrawer(ws: WorkspaceState): TemplateResult {
  if (!ws.showTerminal) return html``;
  return html`
    <section class="ws-log-drawer">
      <div class="ws-log-head"><span class="ws-runtime-dot"></span> Development server <span style="margin-left:auto;opacity:.55">${ws.runtimeServer?.command ?? "not started"}</span></div>
      <pre class="ws-log">${ws.runtimeLogs || ws.runtimeServer?.error || "Waiting for server output…"}</pre>
    </section>
  `;
}

// ── Main render ────────────────────────────────────────────────────

export function renderWorkspace(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const ws = getWorkspaceState(state);
  installWorkspaceInspectorBridge(state, client);
  const selected = ws.workspaces.find((w) => w.id === ws.selectedId) ?? null;
  const activeTab = ws.tabs.find((t) => t.path === ws.activeTabPath) ?? null;
  const previewUrl = getPreviewUrl(ws);
  const runtimeStatus = ws.runtimeLoading ? "detecting" : ws.runtimeServer?.status ?? "stopped";
  const runtimeLabel = runtimeStatus === "ready"
    ? "Ready"
    : runtimeStatus === "error"
      ? "Error"
      : runtimeStatus === "stopped"
        ? "Start"
        : runtimeStatus.charAt(0).toUpperCase() + runtimeStatus.slice(1);
  const agentDefaultModel = ws.agentDefaultModel
    ?? state.agentsList?.agents.find((agent) => agent.id === "coder")?.model
    ?? state.agentsList?.agents.find((agent) => agent.id === "main")?.model
    ?? null;
  const framework = ws.runtimeDetection?.kind && ws.runtimeDetection.kind !== "unknown"
    ? ws.runtimeDetection.kind
    : ws.projectMode;

  const postInspectorMode = (enabled: boolean, source?: Event) => {
    setInspectorEnabled(state, enabled);
    const frame = (source?.currentTarget as HTMLElement | null)
      ?.closest(".ws-shell--studio")
      ?.querySelector<HTMLIFrameElement>('iframe[title="Workspace live preview"]')
      ?? document.querySelector("infinibot-app")?.shadowRoot?.querySelector<HTMLIFrameElement>('iframe[title="Workspace live preview"]')
      ?? null;
    frame?.contentWindow?.postMessage({ type: "infinibot:inspector", enabled }, window.location.origin);
  };

  const openWorkbench = (mode: WorkspaceViewMode) => {
    setViewMode(state, mode);
    toggleWorkspaceWorkbench(state, true);
  };

  return html`
    ${STYLES}
    ${STUDIO_STYLES}
    <div
      class="ws-shell ws-shell--studio ws-mobile--${ws.mobileSurface}"
      tabindex="-1"
      @keydown=${(e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
          e.preventDefault();
          toggleWorkspaceCommandPalette(state, true);
        }
        if (e.key === "Escape") {
          if (ws.inspectorEnabled) postInspectorMode(false);
          toggleWorkspaceCommandPalette(state, false);
          toggleWorkspaceOverflow(state, false);
        }
      }}
      @click=${() => {
      if (ws.workflowPickerOpen) closeWorkflowPicker(state);
      if (ws.pickerOpen) setPickerOpen(state, false);
      if (ws.overflowOpen) toggleWorkspaceOverflow(state, false);
    }}>
      <header class="ws-studio-header" data-testid="workspace-header" data-learn-id="workspace-header">
        ${renderWorkspacePicker(state, client, ws)}
        <div class="ws-project-meta">
          <span class="ws-framework-badge">${framework}</span>
          ${ws.runtimeDetection?.gitBranch
            ? html`<span class="ws-branch-badge">${ws.runtimeDetection.gitBranch}</span>`
            : nothing}
        </div>
        <button
          class="ws-status-pill ws-status-pill--${runtimeStatus}"
          data-learn-id="workspace-server"
          title=${ws.runtimeServer?.error ?? `Development server is ${runtimeStatus}`}
          @click=${(e: Event) => {
            e.stopPropagation();
            if (runtimeStatus === "ready") return;
            void startWorkspaceServer(state, client, Boolean(ws.runtimeDetection?.missingDependencies));
          }}
        ><span>${runtimeLabel}</span></button>
        <div class="ws-header-spacer"></div>
        <div class="ws-device-toggle ws-device-toggle--header" aria-label="Preview device width" data-learn-id="workspace-devices">
          <button class=${ws.previewDevice === "desktop" ? "on" : ""} title="Desktop" data-learn-id="workspace-device-desktop" @click=${() => setPreviewDevice(state, "desktop")}>${icons.monitor}</button>
          <button class=${ws.previewDevice === "tablet" ? "on" : ""} title="Tablet" @click=${() => setPreviewDevice(state, "tablet")}>${icons.layout}</button>
          <button class=${ws.previewDevice === "mobile" ? "on" : ""} title="Mobile" data-learn-id="workspace-device-mobile" @click=${() => setPreviewDevice(state, "mobile")}>${icons.smartphone}</button>
        </div>
        <input
          class="ws-header-route"
          data-learn-id="workspace-route"
          aria-label="Preview URL or route"
          placeholder="/"
          .value=${ws.previewRoute}
          @change=${(e: Event) => setPreviewRoute(state, (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              setPreviewRoute(state, (e.target as HTMLInputElement).value);
              reloadPreview(state);
            }
          }}
        />
        <button
          class="ws-header-icon"
          data-learn-id="workspace-reload"
          title="Reload preview"
          @click=${() => reloadPreview(state)}
        >${icons.clockRotate}</button>
        ${previewUrl
          ? html`<a class="ws-header-icon" title="Open preview in a new tab" href=${previewUrl} target="_blank" rel="noopener">${icons.externalLink}</a>`
          : nothing}
        <div class="ws-overflow-wrap">
          <button
            class="ws-header-icon ${ws.overflowOpen ? "on" : ""}"
            data-learn-id="workspace-more"
            aria-label="More workspace actions"
            aria-expanded=${String(ws.overflowOpen)}
            @click=${(e: Event) => { e.stopPropagation(); toggleWorkspaceOverflow(state); }}
          ><span style="font-size:18px;line-height:1;transform:translateY(-3px)">…</span></button>
          ${ws.overflowOpen
            ? html`
                <div class="ws-overflow-menu" data-testid="workspace-overflow" data-learn-id="workspace-more-menu" @click=${(e: Event) => e.stopPropagation()}>
                  <button @click=${() => openNewWorkspaceDialog(state)}>Add workspace <small>NEW</small></button>
                  <button ?disabled=${!ws.selectedId} @click=${() => openTemplatesGallery(state)}>Templates <small>LIBRARY</small></button>
                  <button ?disabled=${!ws.selectedId} @click=${() => { ws.versionsOpen = true; state.requestUpdate?.(); }}>Versions <small>CHECKPOINTS</small></button>
                  <button ?disabled=${!ws.selectedId} @click=${() => toggleWorkspaceWorkbench(state)}>Files, code, diff &amp; components <small>PANEL</small></button>
                  <button ?disabled=${!ws.selectedId} @click=${() => toggleWorkspaceTerminalDrawer(state)}>Terminal &amp; logs <small>DRAWER</small></button>
                  <button ?disabled=${!ws.selectedId} @click=${() => void restartWorkspaceServer(state, client)}>Restart preview <small>SERVER</small></button>
                  <button ?disabled=${runtimeStatus !== "ready"} @click=${() => void stopWorkspaceServer(state, client)}>Stop preview <small>SERVER</small></button>
                  <button @click=${() => setRuntimeAutoStart(state, !ws.runtimeAutoStart)}>Auto-start <small>${ws.runtimeAutoStart ? "ON" : "OFF"}</small></button>
                  <button ?disabled=${ws.visualVerifyRunning || !previewUrl} @click=${() => void runWorkspaceVisualVerify(state, client)}>Visual verify <small>${ws.visualVerifyRunning ? "RUNNING" : "CHECK"}</small></button>
                  <button @click=${(e: Event) => { e.stopPropagation(); void openWorkflowPicker(state, client); }}>Run workflow <small>AGENT</small></button>
                  ${renderWorkflowPicker(state, client, ws)}
                  <button @click=${() => addPreviewPane(state, ws.projectMode === "presentation" ? "slides" : ws.projectMode === "pdf" ? "pdf" : ws.projectMode === "document" ? "markdown" : "web", "Split preview")}>Split preview <small>PANE</small></button>
                  ${(["web", "app", "document", "pdf", "presentation"] as ProjectMode[]).map((mode) => html`
                    <button @click=${() => setProjectMode(state, mode)}>${mode.charAt(0).toUpperCase() + mode.slice(1)} mode <small>${ws.projectMode === mode ? "ACTIVE" : "MODE"}</small></button>
                  `)}
                  <label style="display:block;padding:8px 10px 4px;font-size:9px;opacity:.48">Manual preview URL override</label>
                  <input class="ws-header-route" style="width:100%" .value=${ws.devUrl} placeholder="http://127.0.0.1:5173" @change=${(e: Event) => setDevUrl(state, (e.target as HTMLInputElement).value)} />
                </div>
              `
            : nothing}
        </div>
        <div class="ws-mobile-segment" aria-label="Workspace mobile surface" data-learn-id="workspace-mobile-segment">
          <button class=${ws.mobileSurface === "chat" ? "on" : ""} @click=${() => setWorkspaceMobileSurface(state, "chat")}>Chat</button>
          <button class=${ws.mobileSurface === "preview" ? "on" : ""} @click=${() => setWorkspaceMobileSurface(state, "preview")}>Preview</button>
        </div>
      </header>

      ${ws.workspaces.length === 0 && !ws.loading
        ? html`
            <div class="ws-pane">
              <div class="ws-empty ws-empty--primary" data-learn-id="workspace-empty">
                <span class="ws-empty-icon" aria-hidden="true">${icons.folder}</span>
                <strong>No workspaces yet</strong>
                <span>
                  A workspace is a local directory bound to a project. Click
                  <em>+ Workspace</em> above to register one — its files become editable
                  here, Claude Coder runs scoped to its path, and any kanban tasks
                  matching its project appear in the right rail.
                </span>
                <button class="ws-empty-cta" @click=${() => openNewWorkspaceDialog(state)}>Add your first workspace</button>
              </div>
            </div>
          `
        : html`
            <main class="ws-studio-body">
              <section class="ws-chat-panel" aria-label="Workspace agent chat" data-learn-id="workspace-chat">
                <div class="ws-chat-head">
                  <div class="ws-agent-avatar">${icons.sparkles}</div>
                  <div class="ws-chat-title">
                    <strong>Workspace agent</strong>
                    <span>${ws.agentSending ? "Working in this project" : "Ready to build with you"}</span>
                  </div>
                  <webchat-model-picker
                    .client=${client}
                    .connected=${state.connected}
                    .value=${ws.agentModel ?? agentDefaultModel}
                    .defaultModel=${agentDefaultModel}
                    .overridden=${Boolean(ws.agentModel)}
                    .thinkingLevel=${ws.agentThinkingLevel}
                    @model-select=${(e: CustomEvent<{ model: string | null }>) => void setWorkspaceAgentModel(state, client, e.detail.model)}
                    @thinking-select=${(e: CustomEvent<{ level: string | null }>) => void setWorkspaceAgentThinking(state, client, e.detail.level)}
                  ></webchat-model-picker>
                </div>
                ${renderAgent(state, client, ws)}
              </section>
              <section class="ws-preview-hero" aria-label="Live preview" data-learn-id="workspace-preview">
                <div class="ws-preview-hero-head">
                  <span class="ws-browser-dots"><i></i><i></i><i></i></span>
                  <span>${previewUrl ?? "Live preview"}</span>
                  <button
                    class="ws-select-toggle ${ws.inspectorEnabled ? "on" : ""}"
                    aria-pressed=${String(ws.inspectorEnabled)}
                    data-testid="workspace-select-mode"
                    data-learn-id="workspace-select"
                    title="Select an element in the preview (Esc to exit)"
                    @click=${(e: Event) => postInspectorMode(!ws.inspectorEnabled, e)}
                  >${icons.target}${ws.inspectorEnabled ? "Selecting" : "Select"}</button>
                </div>
                <div class="ws-canvas">
                  ${ws.projectMode === "web" || ws.projectMode === "app"
                    ? renderPreview(state, client, ws)
                    : renderCenterCanvas(state, client, ws, selected, activeTab)}
                </div>
              </section>
            </main>
          `}

      ${ws.workbenchOpen
        ? html`
            <section class="ws-workbench" aria-label="Workspace files and code">
              <div class="ws-drawer-head">
                <div class="ws-drawer-tabs">
                  ${(["files", "code", "diff"] as WorkspaceViewMode[]).map((mode) => html`
                    <button class=${ws.viewMode === mode ? "on" : ""} @click=${() => setViewMode(state, mode)}>${mode}</button>
                  `)}
                  <button class=${ws.viewMode === "preview" ? "on" : ""} @click=${() => setViewMode(state, "preview")}>Components</button>
                </div>
                <button class="ws-header-icon" style="margin-left:auto;width:28px;height:28px" title="Close panel" @click=${() => toggleWorkspaceWorkbench(state, false)}>${icons.x}</button>
              </div>
              <div class="ws-drawer-body">
                ${ws.viewMode === "preview"
                  ? html`<div class="ws-workbench-components">${renderComponents(state, client, ws)}</div>`
                  : html`<div class="ws-canvas">${renderCenterCanvas(state, client, ws, selected, activeTab)}</div>`}
              </div>
            </section>
          `
        : nothing}
      ${ws.terminalDrawerOpen
        ? html`
            <section class="ws-terminal-drawer" aria-label="Raw terminal and logs">
              <div class="ws-drawer-head">
                <strong style="font-size:10px;color:var(--g-primary);letter-spacing:.08em;text-transform:uppercase">Terminal &amp; logs</strong>
                <span style="font-size:9px;opacity:.42">Raw CLI stays here when you need it</span>
                <button class="ws-header-icon" style="margin-left:auto;width:28px;height:28px" title="Close terminal" @click=${() => toggleWorkspaceTerminalDrawer(state, false)}>${icons.x}</button>
              </div>
              <div class="ws-drawer-body">${renderTui(state, client, ws)}</div>
            </section>
          `
        : nothing}
      ${renderVersionsDrawer(state, client, ws)}
      ${ws.error ? html`<div class="ws-err">${ws.error}</div>` : nothing}
    </div>

    ${ws.commandPaletteOpen
      ? html`
          <div class="ws-command-backdrop" @click=${() => toggleWorkspaceCommandPalette(state, false)}>
            <div class="ws-command" role="dialog" aria-label="Workspace commands" @click=${(e: Event) => e.stopPropagation()}>
              <input placeholder="Search workspace actions…" autofocus />
              <div class="ws-command-list">
                <button @click=${() => { postInspectorMode(true); toggleWorkspaceCommandPalette(state, false); }}>Select an element <kbd>ESC TO EXIT</kbd></button>
                <button @click=${() => { openWorkbench("files"); toggleWorkspaceCommandPalette(state, false); }}>Open files <kbd>FILES</kbd></button>
                <button @click=${() => { toggleWorkspaceTerminalDrawer(state, true); toggleWorkspaceCommandPalette(state, false); }}>Open terminal <kbd>DRAWER</kbd></button>
                <button @click=${() => { reloadPreview(state); toggleWorkspaceCommandPalette(state, false); }}>Reload preview <kbd>⌘ R</kbd></button>
                <button @click=${() => { ws.versionsOpen = true; toggleWorkspaceCommandPalette(state, false); state.requestUpdate?.(); }}>Show versions <kbd>HISTORY</kbd></button>
              </div>
            </div>
          </div>
        `
      : nothing}

    ${ws.creatingWorkspace ? renderNewWorkspaceModal(state, client, ws) : nothing}
    ${ws.templatesOpen ? renderTemplatesGallery(state, client, ws) : nothing}
    ${ws.bindOpen ? renderBindDialog(state, client, ws) : nothing}
  `;
}

// ── TUI (xterm) ────────────────────────────────────────────────────

function renderTui(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  // Lazy spawn — first render with mode=tui and no TUI yet kicks off
  // ensureTuiTerminal which calls the same createTerminalSession path the
  // grid Terminal panel uses.
  if (!ws.tuiTerminalId && !ws.tuiStarting && ws.selectedId) {
    queueMicrotask(() => void ensureTuiTerminal(state, client));
  }
  const ts = state.terminalsState;
  const session = ts && ws.tuiTerminalId
    ? ts.sessions.find((s) => s.id === ws.tuiTerminalId)
    : null;
  return html`
    ${terminalsStyles}
    <div class="ws-tui">
      <div class="ws-tui-toolbar">
        <span style="color:var(--g-primary);letter-spacing:0.06em">CLAUDE</span>
        <span class="ws-pathmono">${ws.workspaces.find((w) => w.id === ws.selectedId)?.path ?? ""}</span>
        ${ws.tuiTerminalId
          ? html`<button class="ws-iconbtn" title="Restart Claude" @click=${() => restartTuiTerminal(state, client)}>↻</button>`
          : nothing}
      </div>
      ${ws.tuiStarting
        ? html`<div class="ws-loading" style="color:#a1a1aa;flex:1">Spawning Claude…</div>`
        : session && ts
          ? renderTerminalCard(state, ts, session)
          : html`<div class="ws-loading" style="color:#a1a1aa;flex:1">${ws.selectedId ? "Starting…" : "Pick a workspace to spawn."}</div>`}
    </div>
  `;
}

// ── Agent chat (grid-chat-styled) ──────────────────────────────────

function renderAgent(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  // Lazy load history when entering agent mode.
  if (
    ws.agentMessages.length === 0 &&
    !ws.agentLoading &&
    !ws.agentHistoryLoaded &&
    ws.agentSessionKey
  ) {
    queueMicrotask(() => void loadAgentHistory(state, client));
  }
  return html`
    <div class="ws-agent">
      <div class="ws-agent-history">
        ${ws.agentLoading
          ? html`<div class="ws-loading">Loading session…</div>`
          : ws.agentMessages.length === 0
            ? html`
                <div class="ws-chat-empty">
                  <div class="ws-chat-empty-visual">${icons.sparkles}</div>
                  <h3>Build by describing it</h3>
                  <p>Your workspace agent can edit files, run commands, and use the selected preview element as context.</p>
                </div>
              `
            : renderAgentTimeline(ws.agentMessages)}
        ${ws.agentSending
          ? html`
              <details class="ws-working-card" open>
                <summary>Working on your request</summary>
                <div class="ws-working-step">Reading the relevant files</div>
                <div class="ws-working-step">Planning the smallest safe edit</div>
                <div class="ws-working-step">Streaming changes into the workspace</div>
              </details>
            `
          : nothing}
        ${ws.versions.slice(0, 3).map((version) => html`
          <div class="ws-checkpoint" data-testid="workspace-checkpoint">
            <div class="ws-checkpoint-main">
              <strong>${version.description}</strong>
              <small>Checkpoint · ${version.commit.slice(0, 8)}</small>
            </div>
            <button @click=${() => void showWorkspaceVersionDiff(state, client, version.id)}>View diff</button>
            <button @click=${() => void revertWorkspaceVersionAction(state, client, version.id)}>Revert</button>
          </div>
        `)}
      </div>
      <div class="ws-suggestions" aria-label="Prompt suggestions">
        ${[
          "Make the hero section more premium",
          "Add a pricing section",
        ].map((suggestion) => html`
          <button class="ws-suggestion" @click=${() => setAgentInput(state, suggestion)}>${suggestion}</button>
        `)}
      </div>
      ${ws.selectedElement
        ? html`
            <div class="ws-selection-context" data-testid="workspace-composer-context">
              <div class="ws-selection-context-top">
                ${icons.target}
                <strong>Selected element</strong>
                <code>${ws.selectedElement.selector}</code>
                <button title="Remove element context" @click=${() => { ws.selectedElement = null; state.requestUpdate?.(); }}>${icons.x}</button>
              </div>
            </div>
          `
        : nothing}
      <div class="ws-agent-input">
        <div class="ws-composer">
          <textarea
            class="ws-agent-textarea"
            placeholder="Describe what you want to change…"
            .value=${ws.agentInput}
            ?disabled=${!ws.selectedId || ws.agentSending}
            @input=${(e: Event) =>
              setAgentInput(state, (e.target as HTMLTextAreaElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void sendAgentMessage(state, client);
              }
            }}
          ></textarea>
          <div class="ws-composer-foot">
            <button class="ws-header-icon" title="Attach the selected element">${icons.target}</button>
            <button class="ws-header-icon" title="Attach a screenshot">${icons.camera}</button>
            <span style="font-size:9px;opacity:.38">⌘ Enter to send</span>
            <button
              class="ws-send"
              ?disabled=${!ws.selectedId || ws.agentSending || !ws.agentInput.trim()}
              @click=${() => sendAgentMessage(state, client)}
            >
              ${ws.agentSending ? "Sending" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderAgentBubble(m: AgentChatMessage): TemplateResult {
  return html`
    <div class="ws-agent-bubble ws-agent-bubble--${m.role} ${m.pending ? "ws-agent-bubble--pending" : ""}">
      <span class="ws-agent-meta">${m.role === "user" ? "you" : m.role}</span>
      ${m.text}
    </div>
  `;
}

function summarizeAgentStep(text: string): string {
  if (/grep -n ["']?inevitable/i.test(text)) return "Verified the edited file in the terminal";
  if (/sed -i .*built to feel inevitable/i.test(text)) return "Applied the requested source edit";
  if (/"error"\s*:/i.test(text)) return "Terminal action reported an issue and the agent recovered";
  if (/"terminalId"\s*:/i.test(text)) return "Ran a scoped terminal action";
  if (/"ok"\s*:\s*true/i.test(text)) return "Completed a workspace tool action";
  return "Received workspace tool output";
}

function renderAgentTimeline(messages: AgentChatMessage[]): TemplateResult[] {
  const rendered: TemplateResult[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role !== "system") {
      rendered.push(renderAgentBubble(message));
      index += 1;
      continue;
    }
    const steps: AgentChatMessage[] = [];
    while (index < messages.length && messages[index].role === "system") {
      steps.push(messages[index]!);
      index += 1;
    }
    rendered.push(html`
      <details class="ws-working-card" data-testid="workspace-tool-activity">
        <summary>Working steps · ${steps.length} tool ${steps.length === 1 ? "event" : "events"}</summary>
        ${steps.map((step) => html`<div class="ws-working-step">${summarizeAgentStep(step.text)}</div>`)}
      </details>
    `);
  }
  return rendered;
}

// ── Components panel ────────────────────────────────────────────────

function renderComponents(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  const list = getComponentLibrary();
  const activeTab = ws.tabs.find((t) => t.path === ws.activeTabPath);
  return html`
    <div class="ws-comps-list">
      ${list.map(
        (c) => html`
          <button
            class="ws-comp"
            ?disabled=${!ws.selectedId}
            title=${activeTab
              ? `Insert into ${activeTab.name}`
              : "Open a file first to insert this snippet"}
            @click=${() => chooseSnippet(state, client, c.id)}
          >
            <div style="flex:1">
              <div class="ws-comp-name">${c.name}</div>
              <div class="ws-comp-desc">${c.description}</div>
            </div>
            <span class="ws-comp-tag ${c.binding ? "ws-comp-bind" : ""}">
              ${c.binding ? "CRM" : c.surface}
            </span>
          </button>
        `,
      )}
    </div>
  `;
}

// ── Templates gallery ──────────────────────────────────────────────

function renderTemplatesGallery(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  const all = getTemplateLibrary();
  return html`
    <div class="ws-modal-backdrop" @click=${() => closeTemplatesGallery(state)}>
      <div class="ws-gallery" @click=${(e: Event) => e.stopPropagation()}>
        <h3>Workspace templates</h3>
        <p>
          Pick a template to scaffold ready-to-edit files into this workspace.
          Templates with a CRM tag will let you bind their forms straight into
          an existing database (or create a new one for them).
        </p>
        ${ws.applyingTemplate
          ? html`<div class="ws-loading">Scaffolding files…</div>`
          : html`
              <div class="ws-gallery-grid">
                ${all.map((tpl) => renderTemplateCard(state, client, tpl))}
              </div>
            `}
      </div>
    </div>
  `;
}

function renderTemplateCard(
  state: AppViewState,
  client: GatewayBrowserClient,
  tpl: WorkspaceTemplate,
): TemplateResult {
  return html`
    <button class="ws-gallery-card" @click=${() => chooseTemplate(state, client, tpl.id)}>
      <span class="ws-gallery-glyph">${tpl.glyph}</span>
      <span class="ws-gallery-name">${tpl.name}</span>
      <span class="ws-gallery-tag">${tpl.tagline}</span>
      ${tpl.binding
        ? html`<span class="ws-gallery-bind">CRM bind</span>`
        : nothing}
    </button>
  `;
}

// ── Bind dialog ────────────────────────────────────────────────────

function renderBindDialog(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  const spec: TemplateBindingSpec | null =
    ws.pendingTemplate?.binding ?? ws.pendingSnippet?.binding ?? null;
  if (!spec) return html``;
  return html`
    <div class="ws-modal-backdrop" @click=${() => closeBindDialog(state)}>
      <div class="ws-bind" @click=${(e: Event) => e.stopPropagation()}>
        <h3>Hook this form into a database</h3>
        <p style="margin:0 0 14px;font-size:11px;color:rgba(228,228,231,0.65)">
          Submissions land as rows in the chosen database. Each form field is
          mapped to a property by name; unmapped fields are dropped.
        </p>

        <div class="ws-bind-mode">
          <button
            class=${ws.bindMode === "existing" ? "on" : ""}
            @click=${() => setBindMode(state, "existing")}
          >
            Existing
          </button>
          <button
            class=${ws.bindMode === "new" ? "on" : ""}
            @click=${() => setBindMode(state, "new")}
          >
            New database
          </button>
        </div>

        ${ws.bindMode === "existing"
          ? html`
              <label>Target database</label>
              <select
                style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);background:rgba(0,0,0,0.55);color:var(--g-fg);font-family:inherit;font-size:13px"
                @change=${(e: Event) =>
                  setBindDatabaseId(state, (e.target as HTMLSelectElement).value)}
              >
                ${ws.bindDatabaseChoices.length === 0
                  ? html`<option value="">Loading…</option>`
                  : ws.bindDatabaseChoices.map(
                      (d) => html`
                        <option value=${d.id} ?selected=${d.id === ws.bindDatabaseId}>
                          ${d.name}
                        </option>
                      `,
                    )}
              </select>
            `
          : html`
              <label>New database name</label>
              <input
                type="text"
                .value=${ws.bindNewName}
                @input=${(e: Event) =>
                  setBindNewName(state, (e.target as HTMLInputElement).value)}
              />
              ${spec.newDatabaseProperties && spec.newDatabaseProperties.length > 0
                ? html`
                    <p style="margin-top:10px;font-size:10px;color:rgba(228,228,231,0.55)">
                      Will create with ${spec.newDatabaseProperties.length} properties:
                      ${spec.newDatabaseProperties.map((p) => p.name).join(", ")}.
                    </p>
                  `
                : nothing}
            `}

        <div class="ws-bind-fieldmap">
          <div style="font-weight:700;margin-bottom:6px;color:var(--g-primary);font-size:10px;letter-spacing:0.08em;text-transform:uppercase">Field mapping</div>
          ${spec.fields.map(
            (f) => html`
              <div class="ws-bind-fieldmap-row">
                <span style="opacity:0.7">${f.formField}</span>
                <span class="ws-bind-fieldmap-arrow">→</span>
                <span>${f.propertyName}</span>
              </div>
            `,
          )}
        </div>

        <div class="ws-modal-actions">
          <button class="ws-btn" @click=${() => closeBindDialog(state)}>Cancel</button>
          <button
            class="ws-btn ws-btn--primary"
            @click=${() => confirmBind(state, client)}
          >
            Bind &amp; apply
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderWorkspacePicker(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  const selected = ws.selectedId
    ? ws.workspaces.find((w) => w.id === ws.selectedId) ?? null
    : null;
  const filter = ws.pickerFilter.trim().toLowerCase();
  const matches = (w: typeof ws.workspaces[number]) =>
    !filter ||
    w.name.toLowerCase().includes(filter) ||
    w.path.toLowerCase().includes(filter);

  const recentIds = loadRecentIds();
  const recents = recentIds
    .map((id) => ws.workspaces.find((w) => w.id === id))
    .filter((w): w is typeof ws.workspaces[number] => Boolean(w) && matches(w as typeof ws.workspaces[number]));
  const recentIdSet = new Set(recents.map((w) => w.id));
  const rest = ws.workspaces.filter((w) => !recentIdSet.has(w.id) && matches(w));

  const labelText = selected
    ? `${selected.icon ? `${selected.icon} ` : ""}${selected.name}`
    : ws.workspaces.length === 0
      ? "No workspaces — add one"
      : "Pick a workspace";

  return html`
    <div class="ws-pickwrap">
      <button
        class="ws-pickbtn ${ws.pickerOpen ? "ws-pickbtn--open" : ""}"
        data-learn-id="workspace-picker"
        @click=${(e: Event) => { e.stopPropagation(); togglePicker(state); }}
        title=${selected?.path ?? ""}
      >
        <span class="ws-pickbtn-label">${labelText}</span>
        ${selected ? html`<span class="ws-pickbtn-sub">${selected.path}</span>` : nothing}
        <span class="ws-pickbtn-caret">▾</span>
      </button>
      ${ws.pickerOpen
        ? html`
            <div class="ws-pickpop" @click=${(e: Event) => e.stopPropagation()}>
              <input
                class="ws-pickpop-search"
                data-learn-id="workspace-picker-search"
                type="text"
                placeholder="Search workspaces…"
                .value=${ws.pickerFilter}
                @input=${(e: Event) => setPickerFilter(state, (e.target as HTMLInputElement).value)}
                ${ref((el?: Element) => {
                  if (el && ws.pickerOpen) (el as HTMLInputElement).focus();
                })}
              />
              <div class="ws-pickpop-list">
                ${recents.length === 0 && rest.length === 0
                  ? html`<div class="ws-pickpop-empty">
                      ${ws.workspaces.length === 0 ? "No workspaces yet." : "No matches."}
                    </div>`
                  : nothing}
                ${recents.length > 0
                  ? html`
                      <div class="ws-pickpop-group">Recent</div>
                      ${recents.map((w) => renderPickRow(state, client, w, ws.selectedId))}
                    `
                  : nothing}
                ${rest.length > 0
                  ? html`
                      ${recents.length > 0
                        ? html`<div class="ws-pickpop-group">All</div>`
                        : nothing}
                      ${rest.map((w) => renderPickRow(state, client, w, ws.selectedId))}
                    `
                  : nothing}
              </div>
              <div class="ws-pickpop-footer">
                <button
                  class="ws-pickpop-addbtn"
                  data-learn-id="workspace-picker-add"
                  @click=${() => { setPickerOpen(state, false); openNewWorkspaceDialog(state); }}
                >
                  + Add workspace
                </button>
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderPickRow(
  state: AppViewState,
  client: GatewayBrowserClient,
  w: { id: string; name: string; path: string; icon?: string },
  selectedId: string | null,
): TemplateResult {
  const isActive = w.id === selectedId;
  return html`
    <div
      class="ws-pickrow ${isActive ? "ws-pickrow--active" : ""}"
      @click=${() => {
        setPickerOpen(state, false);
        if (!isActive) void selectWorkspace(state, client, w.id, { explicit: true });
        // Clicking the restored (already active) project is an explicit open
        // too: it becomes eligible for auto-start.
        else void openActiveWorkspaceExplicitly(state, client);
      }}
    >
      <div class="ws-pickrow-title">
        ${w.icon ? html`<span>${w.icon}</span>` : nothing}
        <span>${w.name}</span>
        ${isActive ? html`<span style="font-size:9px;opacity:0.7">● ACTIVE</span>` : nothing}
      </div>
      <div class="ws-pickrow-path">${w.path}</div>
    </div>
  `;
}

function renderNewWorkspaceModal(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  const modes: Array<{ id: ProjectMode; glyph: TemplateResult; label: string }> = [
    { id: "web", glyph: icons.globe, label: "Web" },
    { id: "app", glyph: icons.zap, label: "App" },
    { id: "document", glyph: icons.fileText, label: "Doc" },
    { id: "pdf", glyph: icons.fileText, label: "PDF" },
    { id: "presentation", glyph: icons.image, label: "Slides" },
  ];
  const recentFolders = loadRecentFolders();
  const hasPicker = Boolean(
    (window as unknown as { api?: { pickFolder?: unknown } }).api?.pickFolder,
  );

  return html`
    <div class="ws-modal-backdrop" @click=${() => closeNewWorkspaceDialog(state)}>
      <div
        class="ws-modal"
        style="max-width:560px"
        @click=${(e: Event) => e.stopPropagation()}
      >
        <h3>Add Workspace</h3>
        <p style="margin:0 0 10px;font-size:11px;color:rgba(228,228,231,0.6)">
          Bind a local directory so files, Claude Coder, and linked business rows
          live in one place.
        </p>

        ${ws.error
          ? html`<div class="ws-modal-err">${ws.error}</div>`
          : nothing}

        <label>Project type</label>
        <div class="ws-newmode-grid">
          ${modes.map(
            (m) => html`
              <button
                class="ws-newmode-card ${ws.newWorkspaceMode === m.id ? "ws-newmode-card--active" : ""}"
                @click=${() => setNewWorkspaceMode(state, m.id)}
                type="button"
              >
                <span class="ws-newmode-glyph">${m.glyph}</span>
                <span class="ws-newmode-label">${m.label}</span>
              </button>
            `,
          )}
        </div>

        <label>Local folder</label>
        <div style="display:flex;gap:6px;align-items:stretch">
          <input
            style="flex:1"
            type="text"
            placeholder="/absolute/path/to/your/project"
            .value=${ws.newWorkspacePath}
            @input=${(e: Event) => setNewWorkspacePath(state, (e.target as HTMLInputElement).value)}
          />
          ${renderRepoDirButton((path) => setNewWorkspacePath(state, path), {
            title: "Workspace folder",
            initialPath: ws.newWorkspacePath || undefined,
          })}
          ${hasPicker
            ? html`
                <button
                  class="ws-btn ws-btn--primary"
                  title="Pick a folder with the native file dialog"
                  @click=${() => void browseForWorkspaceFolder(state)}
                  type="button"
                >
                  ${icons.folder} Browse…
                </button>
              `
            : nothing}
        </div>

        ${recentFolders.length > 0
          ? html`
              <label style="margin-top:8px">Recent folders</label>
              <div class="ws-recents-chips">
                ${recentFolders.map(
                  (p) => html`
                    <button
                      class="ws-recents-chip"
                      type="button"
                      title=${p}
                      @click=${() => setNewWorkspacePath(state, p)}
                    >
                      ${p}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}

        <label>Start from a template</label>
        <div class="ws-template-grid">
          ${([
            ["none", "Existing repo"],
            ["react-vite", "React + Vite"],
            ["next", "Next.js"],
            ["html", "Plain HTML"],
            ["astro", "Astro"],
          ] as Array<[WorkspaceScaffoldTemplate, string]>).map(([id, label]) => html`
            <button
              type="button"
              class="ws-template-choice ${ws.newWorkspaceTemplate === id ? "on" : ""}"
              @click=${() => setNewWorkspaceTemplate(state, id)}
            >${label}</button>
          `)}
        </div>

        <label>Display name</label>
        <input
          type="text"
          placeholder="Auto-derived from folder name"
          .value=${ws.newWorkspaceName}
          @input=${(e: Event) => setNewWorkspaceName(state, (e.target as HTMLInputElement).value)}
        />

        <div class="ws-modal-actions">
          <button class="ws-btn" type="button" @click=${() => closeNewWorkspaceDialog(state)}>Cancel</button>
          <button
            class="ws-btn ws-btn--primary"
            type="button"
            ?disabled=${!ws.newWorkspacePath.trim()}
            @click=${() => createWorkspace(state, client)}
          >
            Add workspace
          </button>
        </div>
      </div>
    </div>
  `;
}
