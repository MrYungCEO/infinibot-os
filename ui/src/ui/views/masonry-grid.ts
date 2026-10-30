/**
 * Masonry Grid View
 * Draggable, resizable multi-session chat panels
 */

import {
  formatAssistantTurnError,
  formatChatErrorText,
  formatModelFallbackNotice,
  parseModelFallbackNotice,
} from "../chat-error-format";
import { html, css, LitElement, nothing, unsafeCSS, type PropertyValues } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../icons";
import "../secure-mode/secure-toggle";
import { isSecureSessionKey } from "../secure-mode/session-key";
import { SecureSurfaceLane, renderSecureSurfaceBadge, secureSurfaceStyles } from "../secure-mode/chat-surface";
import type {
  MasonryGridState,
  GridPanel,
  DragState,
  ResizeState,
  AvailableSession,
} from "../controllers/masonry-grid";
import type {
  GridTasksState,
  GridTask,
  TaskAlert,
} from "../controllers/grid-tasks";
import {
  createGridTasksState,
  startTaskPolling,
  stopTaskPolling,
  getTasksForSessions,
  getActiveAlerts,
  getTotalProgress,
  getActiveTaskCount,
  dismissAlert,
} from "../controllers/grid-tasks";
import "../components/slash-command-preview";
import "../components/ai-ide-panel";
import "../components/video-feed";
import "../components/gpu-animation-panel";
// Agent group chat (same component as the Chat page) — group_chat and
// workflow_builder panels both host it; the latter opens on its Workflows tab.
import "../features/group_chat/group-chat-panel";
// Import chat.ts to register the chat-mic-button custom element for STT
import "./chat";
import { extractToolExecutions, extractFileOperations } from "../controllers/ai-ide";
import { renderFederationNodeSelect, type FedNodeOption } from "../components/federation-node-select";
import { modelHasCapability, modelTier, type ModelCapability, type ModelOption } from "../model-filter";
import { renderLayoutsMenu as renderSharedLayoutsMenu } from "../components/layouts-menu";
import { renderAutoLayoutButtons } from "../components/grid-toolbar";
import { isCanvasToolResult, renderCanvasPreview } from "../chat/canvas-preview";
import { isTabAvailable } from "../plugin-host";
import type { ToolExecution, FileOperation } from "../components/ai-ide-panel";
import {
  createMasonryGridState,
  addPanel,
  removePanel,
  focusPanel,
  updatePanelPosition,
  updatePanelSize,
  toggleMinimize,
  toggleMaximize,
  setGridMode,
  tileHorizontal,
  tileVertical,
  tileGrid,
  saveLayoutToStorage,
  clearLayoutStorage,
  updateContainerSize,
  addSessionToGrid,
  // Canvas tab functions
  addCanvas,
  switchCanvas,
  renameCanvas,
  setCanvasIcon,
  deleteCanvas,
  getActiveCanvas,
  canAddCanvas,
  // Panel type functions
  addCanvasPanel,
  addChartPanel,
  addVideoPanel,
  addGpuPanel,
  addKanbanPanel,
  addDatabasePanel,
  addTerminalPanel,
  addActivityPanel,
  addVoicePanel,
  addProjectsPanel,
  addTasksPanel,
  addKnowledgeGraphPanel,
  addCreditsPanel,
  addViewPanel,
  addAgencyOpsPanel,
  updatePanelMeta,
  refreshPanel as refreshGridPanel,
  setAgentControlPending,
  clearAgentControlPending,
  clearNeedsRefresh,
  GRID_PANEL_REFRESH_EVENT,
  type GridPanelRefreshDetail,
  // Snap guides
  getActiveSnapGuides,
  // Edge dock + presets
  getDockZone,
  applyDockZone,
  type DockZone,
  saveLayoutPreset,
  loadLayoutPreset,
  listLayoutPresets,
  deleteLayoutPreset,
  type LayoutPreset,
  // Linked-edge resize
  findLinkedPanels,
  applyLinkedResize,
  type LinkedPanelSnapshot,
  MIN_PANEL_WIDTH,
  MIN_PANEL_HEIGHT,
  SNAP_GRID_SIZE,
  type CanvasTab,
  type PanelType,
  type SnapGuide,
} from "../controllers/masonry-grid";
import type { SessionsListResult } from "../types";
import { toSanitizedMarkdownHtml } from "../markdown";
import { extractText } from "../chat/message-extract";
import { renderNodeSelector } from "./node-selector";
import { loadNodes, type FederationNode } from "../controllers/federation";
import type { SidebarState, SidebarCategory } from "../controllers/sidebar-categories";
import {
  speakText,
  stopTTS,
  pauseTTS,
  resumeTTS,
  isMessagePlaying,
  isMessagePaused,
  isTTSPlaying,
  onPlaybackChange,
  loadTTSSettings,
} from "../controllers/tts";
import { getPanelWakeSettings, updatePanelWakeWord } from "../controllers/wake-word";
import { startRobovoiceVoiceCall } from "./voice-robovoice/console-state.js";
import {
  loadSidebarState,
  saveSidebarState,
  createCategory,
  deleteCategory,
  toggleCategoryCollapsed,
  addItemToCategory,
  removeItemFromCategory,
  renameItem,
  reorderCategories,
} from "../controllers/sidebar-categories";
// Imports for kanban / database / terminal panels (lazy-resolved at runtime so
// they don't bloat the masonry-grid component itself).
import { renderKanban, type KanbanViewProps } from "./kanban";
import {
  loadKanban as loadKanbanData,
  createProject as kanbanCreateProject,
  updateProject as kanbanUpdateProject,
  deleteProject as kanbanDeleteProject,
  createTask as kanbanCreateTask,
  updateTask as kanbanUpdateTask,
  deleteTask as kanbanDeleteTask,
} from "../controllers/kanban";
import { renderDatabases } from "./databases";
import {
  getDatabasesState,
  loadDatabases,
  loadDatabase,
} from "../controllers/databases";
import { renderTerminalCard, terminalsStyles } from "./terminals";
import {
  createInitialTerminalsState,
  createTerminalSession,
  closeTerminalSession,
  loadTerminalsPage,
  CLI_CONFIGS,
  nodeHasOllama,
  type CliType,
} from "../controllers/terminals";
import {
  renderActivityFeedBody,
  ensureActivityPanelData,
} from "./activity-panel";
// ============================================================
// A3 grid-panel renderers (NEW files under ./grid-panels/).
// Each accepts (panel, state, client) and returns a TemplateResult; each
// listens internally for GRID_PANEL_REFRESH_EVENT to re-fetch its data.
// These imports may be unresolved until A3 lands — that is the agreed
// coordination contract; runtime resolves once A3 commits.
// ============================================================
import { renderGridActivityPanel } from "./grid-panels/activity-panel.js";
import "../components/credit-usage-breakdown";
import { renderGridKanbanPanel } from "./grid-panels/kanban-panel.js";
import { renderGridDatabasePanel } from "./grid-panels/database-panel.js";
import { renderGridProjectsPanel } from "./grid-panels/projects-panel.js";
import { renderGridTasksPanel } from "./grid-panels/tasks-panel.js";
import { renderKnowledgeGraphPanel } from "./grid-panels/knowledge-graph-panel.js";
import {
  renderViewAdapterPanel,
  renderAgencyOpsTabPanel,
  disposeAdapterPanel,
  VIEW_PANEL_DEFS,
  AGENCY_OPS_TAB_DEFS,
  type PanelCatalogEntry,
  type PanelCategory,
} from "./grid-panels/view-adapter-panels.js";
import "../components/agent-cli-selector";
// Pull xterm.css text into the panel's shadow DOM — the side-effect import
// in terminals.ts only injects it into the document head, which doesn't
// reach our shadow DOM.
import xtermCssText from "@xterm/xterm/css/xterm.css?raw";
import { renderBrandAvatar } from "../chat/brand-avatar";
import { extractPanelRefsFromMessage, renderChatPanelRef, type ChatPanelRef } from "../chat-panels";

// ============================================================
// Helper: Extract text AND images from message content blocks
// ============================================================

type ImageData = {
  type: "base64" | "url";
  mimeType: string;
  data: string; // base64 string or URL
};

function extractContentWithImages(message: unknown): { text: string | null; images: ImageData[] } {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const textParts: string[] = [];
  const images: ImageData[] = [];

  if (typeof content === "string") {
    return { text: content, images: [] };
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      
      // Extract text
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      }
      
      // Extract images (various formats from different providers)
      if (b.type === "image") {
        const source = b.source as Record<string, unknown> | undefined;
        if (source) {
          if (source.type === "base64" && typeof source.data === "string") {
            const mimeType = (source.media_type || source.mimeType || "image/png") as string;
            // Handle both raw base64 and data URLs
            const data = (source.data as string).startsWith("data:")
              ? source.data as string
              : `data:${mimeType};base64,${source.data}`;
            images.push({ type: "base64", mimeType, data });
          } else if (source.type === "url" && typeof source.url === "string") {
            images.push({ type: "url", mimeType: "image/png", data: source.url as string });
          }
        }
        // Direct data field (some formats)
        if (typeof b.data === "string") {
          const mimeType = (b.mimeType || b.media_type || "image/png") as string;
          const data = (b.data as string).startsWith("data:")
            ? b.data as string
            : `data:${mimeType};base64,${b.data}`;
          images.push({ type: "base64", mimeType, data });
        }
        // URL field
        if (typeof b.url === "string") {
          images.push({ type: "url", mimeType: "image/png", data: b.url as string });
        }
      }
      
      // Handle image_url format (OpenAI style)
      if (b.type === "image_url") {
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (imageUrl && typeof imageUrl.url === "string") {
          images.push({ type: "url", mimeType: "image/png", data: imageUrl.url as string });
        }
      }
    }
  }

  // Fallback to text field
  if (textParts.length === 0 && typeof m.text === "string") {
    textParts.push(m.text);
  }

  // A turn that died on a provider error (rejected key, 401/403, outage) is
  // stored with empty content + errorMessage. Show the error instead of
  // silently dropping the turn.
  if (textParts.length === 0 && images.length === 0 && m.role === "assistant") {
    const errorLine = formatAssistantTurnError(m);
    if (errorLine) textParts.push(errorLine);
  }

  return {
    text: textParts.length > 0 ? textParts.join("\n") : null,
    images,
  };
}

// ============================================================
// Per-session attachment storage (persist across panel switches)
// ============================================================

type SessionAttachment = {
  id: string;
  dataUrl: string;
  mimeType: string;
};

const sessionAttachmentsMap = new Map<string, SessionAttachment[]>();

function getSessionAttachments(sessionKey: string): SessionAttachment[] {
  return sessionAttachmentsMap.get(sessionKey) || [];
}

function setSessionAttachments(sessionKey: string, attachments: SessionAttachment[]) {
  sessionAttachmentsMap.set(sessionKey, attachments);
}

function clearSessionAttachments(sessionKey: string) {
  sessionAttachmentsMap.delete(sessionKey);
}

// ============================================================
// Masonry Grid Container Component
// ============================================================

@customElement("masonry-grid")
export class MasonryGrid extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent; /* Let terminal background show through */
    }

    /* Override browser's fullscreen backdrop to be transparent */
    :host::backdrop {
      background: transparent !important;
    }

    ::backdrop {
      background: transparent !important;
    }

    *::backdrop {
      background: transparent !important;
    }

    * {
      box-sizing: border-box;
    }

    svg {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .grid-container {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent;
      overscroll-behavior: contain;
    }

    /* Snap guides */
    .snap-guides {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 9999;
    }

    .snap-guide {
      position: absolute;
      background: color-mix(in srgb, var(--g-primary) 60%, transparent);
      box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 40%, transparent);
    }

    .snap-guide--vertical {
      width: 1px;
      top: 0;
      bottom: 0;
    }

    .snap-guide--horizontal {
      height: 1px;
      left: 0;
      right: 0;
    }

    /* Edge-dock drop preview */
    .dock-preview {
      position: absolute;
      pointer-events: none;
      z-index: 9998;
      border-radius: 8px;
      transition: left 0.06s ease-out, top 0.06s ease-out, width 0.06s ease-out, height 0.06s ease-out;
    }
    .dock-preview--drop {
      background: color-mix(in srgb, var(--g-primary) 22%, transparent);
      border: 2px dashed var(--g-primary);
      box-shadow: 0 0 28px color-mix(in srgb, var(--g-primary) 35%, transparent), inset 0 0 30px color-mix(in srgb, var(--g-primary) 10%, transparent);
      animation: dockPulse 1.1s ease-in-out infinite;
    }
    .dock-preview--target {
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      border: 1px dashed color-mix(in srgb, var(--g-primary) 35%, transparent);
    }
    .dock-preview--center {
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
      border-style: solid;
    }
    .dock-preview-label {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      padding: 6px 14px;
      background: rgba(0, 0, 0, 0.78);
      color: var(--g-primary);
      border: 1px solid var(--g-primary);
      border-radius: 6px;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    @keyframes dockPulse {
      0%, 100% { box-shadow: 0 0 28px color-mix(in srgb, var(--g-primary) 35%, transparent), inset 0 0 30px color-mix(in srgb, var(--g-primary) 10%, transparent); }
      50% { box-shadow: 0 0 44px color-mix(in srgb, var(--g-primary) 55%, transparent), inset 0 0 40px color-mix(in srgb, var(--g-primary) 18%, transparent); }
    }

    /* Grid overlay for snap mode */
    .grid-overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      opacity: 0.08;
      background-image: 
        linear-gradient(color-mix(in srgb, var(--g-primary) 30%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--g-primary) 30%, transparent) 1px, transparent 1px);
      background-size: 10px 10px;
    }

    .grid-overlay.hidden {
      display: none;
    }

    .grid-toolbar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 48px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px;
      background:
        linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0.4)),
        var(--g-glass-tint, transparent);
      backdrop-filter: blur(18px) saturate(160%);
      -webkit-backdrop-filter: blur(18px) saturate(160%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, rgba(255,255,255,0.04));
      box-shadow: 0 6px 20px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04);
      z-index: 10000;
    }

    /* Every interactive control inside the toolbar shares these defaults so
       buttons, pill toggles and dropdowns end up the same height and
       baseline-aligned. Specific classes layer their own colour/border on
       top of this. */
    .grid-toolbar > *,
    .grid-toolbar .toolbar-group > *,
    .grid-toolbar button,
    .grid-toolbar select,
    .grid-toolbar input,
    .grid-toolbar .add-panel-dropdown-wrapper,
    .grid-toolbar .session-picker-wrapper,
    .grid-toolbar .federation-selector {
      height: 36px;
      box-sizing: border-box;
      vertical-align: middle;
    }
    .grid-toolbar .toolbar-group {
      align-self: center;
    }

    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 36px;
    }

    .toolbar-divider {
      width: 1px;
      height: 24px;
      background: linear-gradient(180deg, transparent, rgba(255,255,255,0.18), transparent);
      margin: 0 6px;
      align-self: center;
    }

    .toolbar-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015)),
        var(--g-glass-tint, transparent);
      color: var(--c-text-2, #aab);
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s, transform 0.1s;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.25);
    }

    .toolbar-btn:hover {
      background:
        linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0.04)),
        var(--g-glass-tint, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 25%, rgba(255,255,255,0.1));
      color: #fff;
      transform: translateY(-1px);
      box-shadow: 0 1px 0 rgba(255,255,255,0.08) inset, 0 6px 18px rgba(0,0,0,0.4);
    }

    .toolbar-btn:active {
      transform: translateY(0);
    }

    .toolbar-btn.active {
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 28%, transparent), color-mix(in srgb, var(--g-primary) 14%, transparent));
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      color: var(--g-primary);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary) 35%, transparent),
        0 4px 14px color-mix(in srgb, var(--g-primary) 25%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.08);
    }

    .toolbar-btn svg {
      width: 20px;
      height: 20px;
      pointer-events: none; /* Don't block clicks on parent button */
    }

    /* Workspace 1-5 Buttons */
    .workspace-tabs {
      gap: 4px;
    }

    .workspace-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 36px;
      height: 36px;
      padding: 0 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, rgba(255,255,255,0.05));
      border-radius: 8px;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 8%, transparent), color-mix(in srgb, var(--g-primary) 3%, transparent)),
        var(--g-glass-tint, transparent);
      color: color-mix(in srgb, var(--g-primary) 65%, transparent);
      cursor: pointer;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 14px;
      font-weight: 700;
      transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s, transform 0.1s;
      position: relative;
      gap: 4px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.25);
    }

    .workspace-btn:hover {
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 18%, transparent), color-mix(in srgb, var(--g-primary) 8%, transparent)),
        var(--g-glass-tint, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
      color: var(--g-primary);
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08);
    }

    .workspace-btn.active {
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 30%, transparent), color-mix(in srgb, var(--g-primary) 16%, transparent));
      border-color: var(--g-primary);
      color: var(--g-primary);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary) 45%, transparent),
        0 4px 14px color-mix(in srgb, var(--g-primary) 30%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.1);
    }

    .workspace-btn.empty {
      border-style: dashed;
      opacity: 0.5;
    }

    .workspace-btn.empty:hover {
      opacity: 1;
    }

    .workspace-num {
      font-size: 14px;
    }

    .workspace-count {
      font-size: 10px;
      padding: 1px 5px;
      background: color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-radius: 4px;
      color: var(--g-primary);
    }

    .workspace-btn.active .workspace-count {
      background: rgba(0, 0, 0, 0.3);
    }

    .toolbar-spacer {
      flex: 1;
    }

    .fullscreen-btn {
      margin-left: auto;
    }

    /* ============================================================
       Federation Device Selector
       ============================================================ */
    .federation-selector {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 4px;
    }

    .federation-dropdown {
      appearance: none;
      height: 36px;
      box-sizing: border-box;
      background-color: rgba(0, 0, 0, 0.45);
      background-image:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 8%, transparent), color-mix(in srgb, var(--g-primary) 2%, transparent)),
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23FFD700' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat, no-repeat;
      background-position: 0 0, right 10px center;
      background-size: cover, 12px 12px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, rgba(255,255,255,0.06));
      border-radius: 8px;
      padding: 0 30px 0 12px;
      color: var(--g-primary);
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      min-width: 130px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.25);
      transition: background-color 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.1s;
    }

    .federation-dropdown:hover {
      background-color: color-mix(in srgb, var(--g-primary) 10%, rgba(0,0,0,0.4));
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    }

    .federation-dropdown:focus {
      outline: none;
      border-color: var(--g-primary);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 20%, transparent);
    }

    .federation-dropdown option {
      background: #1a1a1a;
      color: var(--g-primary);
      padding: 8px;
    }

    .federation-label {
      font-size: 10px;
      color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    /* ============================================================
       Canvas Tab Bar — Multi-Canvas Switching
       ============================================================ */
    .canvas-tab-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 16px;
      height: 40px;
      background: rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      overflow-x: auto;
      scrollbar-width: none;
    }

    .canvas-tab-bar::-webkit-scrollbar {
      display: none;
    }

    .canvas-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.02);
      color: var(--c-text-2, #888);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
      position: relative;
    }

    .canvas-tab:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: color-mix(in srgb, var(--g-primary) 15%, transparent);
      color: var(--c-text-1, #ccc);
    }

    .canvas-tab.active {
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
      color: var(--g-primary);
      font-weight: 600;
    }

    .canvas-tab__icon {
      font-size: 14px;
      line-height: 1;
      pointer-events: none; /* Don't block clicks on parent tab */
    }

    .canvas-tab__name {
      max-width: 100px;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none; /* Don't block clicks on parent tab */
    }

    .canvas-tab__count {
      font-size: 10px;
      padding: 1px 5px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      color: var(--c-text-3, #666);
      pointer-events: none; /* Don't block clicks on parent tab */
    }

    .canvas-tab.active .canvas-tab__count {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      color: var(--g-primary);
    }

    .canvas-tab__close {
      display: none;
      width: 16px;
      height: 16px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--c-text-3, #666);
      cursor: pointer;
      padding: 0;
      margin-left: 4px;
      align-items: center;
      justify-content: center;
    }

    .canvas-tab:hover .canvas-tab__close {
      display: flex;
    }

    .canvas-tab__close:hover {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }

    .canvas-tab__close svg {
      width: 12px;
      height: 12px;
    }

    .canvas-tab-add {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: 1px dashed color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 8px;
      background: transparent;
      color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      cursor: pointer;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }

    .canvas-tab-add:hover {
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      color: var(--g-primary);
    }

    .canvas-tab-add:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .canvas-tab-add svg {
      width: 16px;
      height: 16px;
      pointer-events: none; /* Don't block clicks on parent button */
    }

    /* Ensure child elements don't block clicks on toolbar buttons */
    .toolbar-btn span,
    .sidebar-toggle-btn span,
    .new-session-toolbar-btn span,
    .add-session-btn span,
    .add-panel-btn span {
      pointer-events: none;
    }

    .canvas-tab-divider {
      width: 1px;
      height: 20px;
      background: rgba(255, 255, 255, 0.08);
      margin: 0 8px;
    }

    /* Canvas rename input */
    .canvas-tab__rename-input {
      width: 80px;
      padding: 2px 6px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 50%, transparent);
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.5);
      color: var(--g-primary);
      font-size: 12px;
      font-weight: 600;
      outline: none;
    }

    .canvas-tab__rename-input:focus {
      border-color: var(--g-primary);
    }

    /* Mobile responsive */
    @media (max-width: 768px) {
      .canvas-tab-bar {
        padding: 0 12px;
        height: 36px;
      }

      .canvas-tab {
        padding: 4px 10px;
        font-size: 11px;
      }

      .canvas-tab__name {
        max-width: 60px;
      }

      .canvas-tab-add {
        width: 28px;
        height: 28px;
      }
    }

    @media (max-width: 480px) {
      .canvas-tab-bar {
        padding: 0 8px;
        gap: 3px;
      }

      .canvas-tab {
        padding: 4px 8px;
      }

      .canvas-tab__icon {
        font-size: 12px;
      }

      .canvas-tab__name {
        display: none;
      }

      .canvas-tab__count {
        display: none;
      }
    }

    .fullscreen-btn.active {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      color: var(--g-primary);
    }

    /* Fullscreen mode - immersive experience */
    :host([fullscreen]) {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      z-index: 99999 !important;
      background: transparent; /* Let terminal background show through */
    }

    :host([fullscreen]) .grid-toolbar {
      height: 40px;
      padding: 0 16px;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    }

    :host([fullscreen]) .toolbar-btn {
      width: 32px;
      height: 32px;
    }

    :host([fullscreen]) .toolbar-btn svg {
      width: 18px;
      height: 18px;
    }

    :host([fullscreen]) .grid-layout {
      top: 76px; /* 40px toolbar + 36px tab bar in fullscreen */
    }

    :host([fullscreen]) .grid-workspace {
      top: 76px;
    }

    :host([fullscreen]) .canvas-tab-bar {
      height: 36px;
      padding: 0 12px;
    }

    :host([fullscreen]) .canvas-tab {
      padding: 4px 10px;
      font-size: 11px;
    }

    :host([fullscreen]) .sidebar-toggle-btn,
    :host([fullscreen]) .add-session-btn,
    :host([fullscreen]) .new-session-toolbar-btn {
      padding: 6px 12px;
      font-size: 12px;
    }

    :host([fullscreen]) .panel-count {
      font-size: 12px;
    }

    :host([fullscreen]) .fullscreen-btn {
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      color: var(--g-primary);
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-radius: 6px;
    }

    :host([fullscreen]) .fullscreen-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 25%, transparent);
    }

    /* Fullscreen hint tooltip */
    :host([fullscreen]) .fullscreen-btn::after {
      content: 'ESC to exit';
      position: absolute;
      bottom: -24px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 9px;
      color: rgba(255, 255, 255, 0.4);
      white-space: nowrap;
      opacity: 0;
      transition: opacity 0.2s;
    }

    :host([fullscreen]) .fullscreen-btn:hover::after {
      opacity: 1;
    }

    /* Fullscreen mode grid workspace */
    :host([fullscreen]) .grid-workspace-with-sidebar {
      background: transparent;
    }

    /* ============================================================
       MOBILE FULLSCREEN — Maximum Immersion
       ============================================================ */
    
    /* Tablet fullscreen */
    @media (max-width: 768px) {
      :host([fullscreen]) {
        /* Ensure we cover everything */
        position: fixed !important;
        inset: 0 !important;
        z-index: 100000 !important;
      }

      :host([fullscreen]) .grid-toolbar {
        height: 44px;
        padding: 0 8px;
        gap: 4px;
      }

      :host([fullscreen]) .toolbar-btn {
        width: 40px;
        height: 40px;
        min-width: 40px;
      }

      :host([fullscreen]) .toolbar-divider {
        margin: 0 4px;
        height: 20px;
      }

      /* Hide session sidebar in mobile fullscreen */
      :host([fullscreen]) .session-sidebar {
        display: none !important;
      }

      /* Hide task sidebar in mobile fullscreen */
      :host([fullscreen]) .task-sidebar {
        display: none !important;
      }

      /* Hide minimized dock in mobile fullscreen — panels auto-maximize */
      :host([fullscreen]) .minimized-dock {
        display: none !important;
      }

      /* Grid layout takes full space */
      :host([fullscreen]) .grid-layout {
        top: 80px; /* 44px + 36px tab bar */
      }

      :host([fullscreen]) .canvas-tab-bar {
        height: 36px;
        padding: 0 8px;
      }

      /* Hide non-essential toolbar items on mobile fullscreen */
      :host([fullscreen]) .toolbar-group:not(:first-child) {
        display: none;
      }

      :host([fullscreen]) .panel-count {
        display: none;
      }

      /* Keep only essential buttons: Sessions toggle, New, Exit fullscreen */
      :host([fullscreen]) .sidebar-toggle-btn {
        padding: 8px 10px;
        font-size: 11px;
      }

      :host([fullscreen]) .new-session-toolbar-btn {
        padding: 8px 10px;
        font-size: 11px;
      }

      :host([fullscreen]) .add-session-btn {
        padding: 8px 10px;
        font-size: 11px;
      }

      /* Voice controls compact */
      :host([fullscreen]) .voice-controls-wrapper {
        display: none;
      }

      /* Fullscreen exit button — prominent on mobile */
      :host([fullscreen]) .fullscreen-btn {
        width: 44px;
        height: 44px;
        background: color-mix(in srgb, var(--g-primary) 20%, transparent) !important;
        border: 2px solid color-mix(in srgb, var(--g-primary) 50%, transparent) !important;
        color: var(--g-primary) !important;
      }

      /* Remove hint tooltip on mobile (no hover) */
      :host([fullscreen]) .fullscreen-btn::after {
        display: none;
      }
    }

    /* Small mobile fullscreen */
    @media (max-width: 480px) {
      :host([fullscreen]) .grid-toolbar {
        height: 40px;
        padding: 0 6px;
        gap: 3px;
      }

      :host([fullscreen]) .toolbar-btn {
        width: 36px;
        height: 36px;
        min-width: 36px;
      }

      /* Hide all text labels in mobile fullscreen toolbar */
      :host([fullscreen]) .sidebar-toggle-btn span,
      :host([fullscreen]) .new-session-toolbar-btn span,
      :host([fullscreen]) .add-session-btn span {
        display: none;
      }

      :host([fullscreen]) .sidebar-toggle-btn,
      :host([fullscreen]) .new-session-toolbar-btn,
      :host([fullscreen]) .add-session-btn {
        padding: 6px 8px;
        width: 36px;
        min-width: 36px;
      }

      /* Single panel takes full screen on very small devices */
      :host([fullscreen]) .grid-layout {
        top: 72px; /* 40px + 32px tab bar on small mobile */
      }

      :host([fullscreen]) .canvas-tab-bar {
        height: 32px;
      }

      /* Fullscreen button extra prominent */
      :host([fullscreen]) .fullscreen-btn {
        width: 40px;
        height: 40px;
        position: relative;
      }
    }

    /* Landscape mobile fullscreen */
    @media (max-height: 500px) and (orientation: landscape) {
      :host([fullscreen]) .grid-toolbar {
        height: 36px;
        padding: 0 8px;
      }

      :host([fullscreen]) .toolbar-btn {
        width: 32px;
        height: 32px;
      }

      :host([fullscreen]) .grid-layout {
        top: 66px; /* 36px + 30px compact tab bar */
      }

      :host([fullscreen]) .canvas-tab-bar {
        height: 30px;
        padding: 0 6px;
      }

      :host([fullscreen]) .canvas-tab {
        padding: 3px 8px;
        font-size: 10px;
      }

      /* Hide everything except essential */
      :host([fullscreen]) .session-sidebar,
      :host([fullscreen]) .task-sidebar,
      :host([fullscreen]) .minimized-dock,
      :host([fullscreen]) .voice-controls-wrapper,
      :host([fullscreen]) .toolbar-group,
      :host([fullscreen]) .toolbar-divider:not(:last-of-type),
      :host([fullscreen]) .panel-count {
        display: none !important;
      }
    }

    /* Safe area handling for notched phones */
    @supports (padding: env(safe-area-inset-top)) {
      :host([fullscreen]) {
        padding-top: env(safe-area-inset-top);
        padding-bottom: env(safe-area-inset-bottom);
        padding-left: env(safe-area-inset-left);
        padding-right: env(safe-area-inset-right);
      }

      :host([fullscreen]) .grid-toolbar {
        padding-left: calc(8px + env(safe-area-inset-left));
        padding-right: calc(8px + env(safe-area-inset-right));
      }
    }

    /* ============================================================
       MOBILE HEADER - Title + Fullscreen button
       ============================================================ */
    .mobile-header {
      display: none; /* Hidden on desktop */
    }
    
    .mobile-header-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--c-accent, var(--g-primary));
      letter-spacing: 0.02em;
    }
    
    .mobile-fullscreen-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      border: 2px solid var(--c-accent, var(--g-primary));
      border-radius: 10px;
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      color: var(--c-accent, var(--g-primary));
      cursor: pointer;
      transition: all 0.2s;
    }
    
    .mobile-fullscreen-btn:hover,
    .mobile-fullscreen-btn:active {
      background: color-mix(in srgb, var(--g-primary) 30%, transparent);
      transform: scale(1.05);
    }
    
    .mobile-fullscreen-btn.active {
      background: var(--c-accent, var(--g-primary));
      color: #000;
    }
    
    .mobile-fullscreen-btn svg {
      width: 22px;
      height: 22px;
    }

    /* ============================================================
       NON-FULLSCREEN MOBILE TOOLBAR
       ============================================================ */
    @media (max-width: 768px) {
      /* Show mobile header */
      .mobile-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex: 1;
        min-width: 0;
      }
      
      .grid-toolbar {
        padding: 0 12px;
        gap: 8px;
      }
      
      /* Hide desktop toolbar items on mobile */
      .toolbar-group,
      .toolbar-divider,
      .panel-count,
      .toolbar-spacer,
      .voice-controls-wrapper,
      .fullscreen-btn,
      .sidebar-toggle-btn,
      .new-session-toolbar-btn,
      .add-session-btn,
      .session-picker-wrapper {
        display: none !important;
      }
    }
    
    /* Tablet - show some controls */
    @media (min-width: 600px) and (max-width: 768px) {
      .sidebar-toggle-btn,
      .new-session-toolbar-btn {
        display: flex !important;
      }
      
      .sidebar-toggle-btn span,
      .new-session-toolbar-btn span {
        display: none;
      }
    }

    @media (max-width: 480px) {
      .grid-toolbar {
        height: 52px;
        padding: 0 10px;
      }
      
      .mobile-header-title {
        font-size: 15px;
      }
      
      .mobile-fullscreen-btn {
        width: 40px;
        height: 40px;
      }
      
      .mobile-fullscreen-btn svg {
        width: 20px;
        height: 20px;
      }
    }

    .grid-workspace {
      position: absolute;
      top: 48px;
      left: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      background: transparent; /* Let terminal show through */
    }

    /* Snap grid overlay - visible when dragging in snap mode */
    .snap-grid-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
      z-index: 1;
      background-image: 
        linear-gradient(to right, color-mix(in srgb, var(--g-primary) 4%, transparent) 1px, transparent 1px),
        linear-gradient(to bottom, color-mix(in srgb, var(--g-primary) 4%, transparent) 1px, transparent 1px);
      background-size: 10px 10px;
    }

    .snap-grid-overlay.visible {
      opacity: 1;
    }

    /* Snap grid dots at intersections - larger dots every 50px */
    .snap-grid-overlay::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-image: radial-gradient(circle, color-mix(in srgb, var(--g-primary) 20%, transparent) 1.5px, transparent 1.5px);
      background-size: 50px 50px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      gap: 16px;
      text-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }

    .empty-state svg {
      width: 64px;
      height: 64px;
      opacity: 0.3;
    }

    .empty-state h3 {
      margin: 0;
      font-size: 18px;
      color: var(--c-text-2, #888);
    }

    .empty-state p {
      margin: 0;
      font-size: 14px;
    }

    .panel-count {
      font-size: 12px;
      color: var(--c-text-2);
      margin-left: auto;
    }

    .session-picker-wrapper {
      position: relative;
    }

    .add-session-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      box-sizing: border-box;
      padding: 0 14px;
      border: 1px dashed color-mix(in srgb, var(--g-primary) 25%, rgba(255,255,255,0.18));
      border-radius: 8px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)),
        var(--g-glass-tint, transparent);
      color: var(--c-text-2);
      cursor: pointer;
      font-size: 13px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.2);
      transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s, transform 0.1s;
    }

    .add-session-btn:hover {
      border-color: var(--c-accent, var(--g-primary));
      color: var(--c-accent, var(--g-primary));
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 12%, transparent), color-mix(in srgb, var(--g-primary) 4%, transparent));
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08);
    }

    .add-session-btn svg {
      width: 16px;
      height: 16px;
      pointer-events: none; /* Don't block clicks on parent button */
    }

    /* Add Panel buttons (Canvas, Chart) */
    .add-panel-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      box-sizing: border-box;
      padding: 0 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 32%, rgba(255,255,255,0.06));
      border-radius: 8px;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 12%, transparent), color-mix(in srgb, var(--g-primary) 4%, transparent)),
        var(--g-glass-tint, transparent);
      color: color-mix(in srgb, var(--g-primary) 85%, white);
      cursor: pointer;
      font-size: 13px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 2px 10px rgba(0,0,0,0.3);
      transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s, transform 0.1s;
    }

    .add-panel-btn:hover {
      border-color: var(--c-accent, var(--g-primary));
      color: var(--c-accent, var(--g-primary));
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 22%, transparent), color-mix(in srgb, var(--g-primary) 10%, transparent));
      transform: translateY(-1px);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary) 30%, transparent),
        0 6px 18px color-mix(in srgb, var(--g-primary) 25%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.1);
    }

    .add-panel-btn svg {
      width: 16px;
      height: 16px;
      pointer-events: none; /* Don't block clicks on parent button */
    }

    /* Add Panel dropdown */
    .add-panel-dropdown-wrapper {
      position: relative;
    }
    .add-panel-trigger.open {
      border-color: var(--c-accent, var(--g-primary)) !important;
      color: var(--c-accent, var(--g-primary)) !important;
      box-shadow: 0 0 14px color-mix(in srgb, var(--g-primary) 25%, transparent);
    }
    /* ── Panel gallery (searchable, categorized picker) ── */
    .panel-gallery {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      width: 560px;
      max-width: 92vw;
      max-height: 72vh;
      background: rgba(9, 9, 12, 0.98);
      backdrop-filter: blur(22px);
      -webkit-backdrop-filter: blur(22px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
      border-radius: 12px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(0,0,0,0.5);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
    }
    .panel-gallery__head {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px 10px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      flex-shrink: 0;
    }
    .panel-gallery__title {
      font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--g-primary); white-space: nowrap;
    }
    .panel-gallery__search {
      flex: 1; min-width: 0;
      padding: 7px 10px;
      background: #060608;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      border-radius: 7px;
      color: #e4e4e7; font-size: 12px; font-family: inherit;
      outline: none;
    }
    .panel-gallery__search:focus { border-color: color-mix(in srgb, var(--g-primary) 55%, transparent); }
    .panel-gallery__close {
      width: 26px; height: 26px; flex-shrink: 0;
      background: transparent;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px; color: rgba(255,255,255,0.5);
      cursor: pointer; font-size: 12px;
    }
    .panel-gallery__close:hover { color: #ef4444; border-color: rgba(239,68,68,0.4); }
    .panel-gallery__chips {
      display: flex; gap: 6px; flex-wrap: wrap;
      padding: 10px 14px; flex-shrink: 0;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    }
    .pg-chip {
      padding: 4px 12px;
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 999px;
      color: rgba(255,255,255,0.55);
      font-size: 11px; font-family: inherit; cursor: pointer;
      transition: all 0.15s;
    }
    .pg-chip:hover { color: #e4e4e7; border-color: color-mix(in srgb, var(--g-primary) 45%, transparent); }
    .pg-chip.active {
      background: color-mix(in srgb, var(--g-primary) 18%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
      color: var(--g-primary); font-weight: 700;
    }
    .panel-gallery__body {
      flex: 1; min-height: 0; overflow-y: auto;
      padding: 8px 14px 14px;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--g-primary) 30%, transparent) transparent;
    }
    .panel-gallery__empty { padding: 30px 10px; text-align: center; color: #71717a; font-size: 12px; }
    .panel-gallery__group-label {
      font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary) 65%, #888);
      margin: 12px 2px 8px; font-weight: 700;
    }
    .panel-gallery__grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
      gap: 10px;
    }
    .pg-card {
      position: relative; isolation: isolate;
      display: flex; flex-direction: column; align-items: flex-start; gap: 7px;
      padding: 14px 14px 13px;
      background:
        radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--g-primary) 8%, transparent), transparent 60%),
        linear-gradient(158deg, rgba(255,255,255,0.045), rgba(255,255,255,0.012));
      border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
      border-radius: 13px;
      cursor: pointer; text-align: left;
      transition: transform 0.18s cubic-bezier(0.22,1,0.36,1), border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
      font-family: inherit;
      min-height: 96px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.03) inset, 0 6px 18px -14px rgba(0,0,0,0.9);
    }
    /* Gradient hairline that lights up on hover. */
    .pg-card::before {
      content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px;
      background: linear-gradient(150deg, color-mix(in srgb, var(--g-primary) 60%, transparent), transparent 45%);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor; mask-composite: exclude;
      opacity: 0; transition: opacity 0.18s ease; pointer-events: none;
    }
    .pg-card:hover:not([disabled]) {
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      background:
        radial-gradient(120% 90% at 0% 0%, color-mix(in srgb, var(--g-primary) 16%, transparent), transparent 60%),
        linear-gradient(158deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
      transform: translateY(-2px);
      box-shadow: 0 1px 0 rgba(255,255,255,0.05) inset, 0 14px 30px -16px color-mix(in srgb, var(--g-primary) 55%, #000);
    }
    .pg-card:hover:not([disabled])::before { opacity: 1; }
    .pg-card:active:not([disabled]) { transform: translateY(0); }
    .pg-card:focus-visible {
      outline: none;
      border-color: color-mix(in srgb, var(--g-primary) 70%, transparent);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 45%, transparent);
    }
    .pg-card[disabled] { opacity: 0.4; cursor: not-allowed; }
    .pg-card__icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 34px; border-radius: 10px;
      color: var(--g-primary);
      background: linear-gradient(150deg, color-mix(in srgb, var(--g-primary) 22%, transparent), color-mix(in srgb, var(--g-primary) 6%, transparent));
      border: 1px solid color-mix(in srgb, var(--g-primary) 26%, transparent);
      box-shadow: 0 4px 12px -8px color-mix(in srgb, var(--g-primary) 80%, #000);
      transition: transform 0.18s cubic-bezier(0.22,1,0.36,1), background 0.18s ease;
    }
    .pg-card__icon svg { width: 19px; height: 19px; }
    .pg-card:hover:not([disabled]) .pg-card__icon {
      transform: scale(1.06) rotate(-2deg);
      background: linear-gradient(150deg, color-mix(in srgb, var(--g-primary) 34%, transparent), color-mix(in srgb, var(--g-primary) 10%, transparent));
    }
    .pg-card__title { font-size: 12.5px; font-weight: 700; color: #f4f4f5; letter-spacing: 0.01em; }
    .pg-card__desc { font-size: 10px; color: #a1a1aa; line-height: 1.4; }
    .panel-gallery__foot {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 10px 14px; flex-shrink: 0;
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      background: color-mix(in srgb, var(--g-primary) 3%, transparent);
    }
    .panel-gallery__foot-label {
      font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary) 70%, #888); font-weight: 700;
    }
    .panel-gallery__cli { display: flex; gap: 5px; flex-wrap: wrap; }
    .pg-cli-btn {
      padding: 4px 9px;
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 6px; color: rgba(255,255,255,0.6);
      font-size: 10px; font-family: inherit; cursor: pointer; text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .pg-cli-btn:hover:not([disabled]) { color: var(--g-primary); border-color: color-mix(in srgb, var(--g-primary) 50%, transparent); }
    .pg-cli-btn[disabled] { opacity: 0.35; cursor: not-allowed; }

    .add-panel-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      min-width: 240px;
      max-height: 480px;
      overflow-y: auto;
      background: rgba(10, 10, 12, 0.97);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
      border-radius: 10px;
      padding: 6px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(0,0,0,0.5);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .add-panel-menu__section-label {
      font-size: 9.5px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.4);
      padding: 6px 10px 4px;
      font-weight: 700;
    }
    .add-panel-menu__submenu-label {
      font-size: 9px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.3);
      padding: 4px 10px 2px 22px;
      font-weight: 600;
    }
    .add-panel-menu__sep {
      height: 1px;
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      margin: 4px 6px;
    }
    .add-panel-menu__item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 10px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: rgba(255, 255, 255, 0.85);
      font-size: 12px;
      font-family: inherit;
      text-align: left;
      cursor: pointer;
      transition: all 0.12s;
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .add-panel-menu__item:hover {
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
      color: var(--c-accent, var(--g-primary));
    }
    .add-panel-menu__item--sub {
      padding-left: 22px;
      font-size: 11.5px;
      color: rgba(255, 255, 255, 0.7);
    }
    .add-panel-menu__icon {
      flex-shrink: 0;
      font-size: 13px;
      width: 16px;
      text-align: center;
    }

    /* ============================================================
     * Generic grid-panel shell — used by voice / projects / tasks /
     * activity / kanban / database. Provides chrome, drag handle,
     * refresh button, agent-control chip, and 8-way resize handles.
     * ============================================================ */
    .grid-panel-shell {
      display: flex;
      flex-direction: column;
      background: rgba(8, 8, 8, 0.85);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      /* ── Flush tiling: zero gap between adjacent panels. Border-radius and
         outer drop shadows are intentionally off so neighbours share crisp
         edges; a single inset hairline draws the shared divider. Matches
         .term-grid-canvas .term-tile over in terminals.ts. ── */
      border: none;
      border-radius: 0;
      overflow: hidden;
      box-shadow: inset -1px -1px 0 rgba(255, 255, 255, 0.08);
    }
    .grid-panel-shell.active {
      box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--g-primary) 45%, transparent);
    }
    .grid-panel-shell__header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: rgba(0, 0, 0, 0.45);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 11px;
      color: rgba(255, 255, 255, 0.85);
      cursor: grab;
      user-select: none;
      flex-shrink: 0;
    }
    .grid-panel-shell__header:active { cursor: grabbing; }
    .grid-panel-shell__title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .grid-panel-shell__chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      background: rgba(139, 92, 246, 0.12);
      border: 1px solid rgba(139, 92, 246, 0.3);
      border-radius: 10px;
      font-size: 9px;
      color: #c4b5fd;
    }
    .grid-panel-shell__chip.pending {
      background: rgba(251, 191, 36, 0.18);
      border-color: rgba(251, 191, 36, 0.45);
      color: #fde68a;
      animation: pulse 1s ease-in-out infinite;
    }
    .grid-panel-shell__controls { display: flex; gap: 4px; }
    .grid-panel-shell__btn {
      width: 22px;
      height: 22px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: transparent;
      color: rgba(255, 255, 255, 0.55);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .grid-panel-shell__btn:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--g-primary);
    }
    .grid-panel-shell__btn.close:hover {
      background: rgba(239, 68, 68, 0.18);
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.4);
    }
    .grid-panel-shell .grid-panel-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      background: rgba(0, 0, 0, 0.18);
    }
    /* 8 resize handles around the shell */
    .grid-panel-shell__resize { position: absolute; }
    .grid-panel-shell__resize.n { top: 0; left: 8px; right: 8px; height: 4px; cursor: ns-resize; }
    .grid-panel-shell__resize.s { bottom: 0; left: 8px; right: 8px; height: 4px; cursor: ns-resize; }
    .grid-panel-shell__resize.e { right: 0; top: 8px; bottom: 8px; width: 4px; cursor: ew-resize; }
    .grid-panel-shell__resize.w { left: 0; top: 8px; bottom: 8px; width: 4px; cursor: ew-resize; }
    .grid-panel-shell__resize.ne { top: 0; right: 0; width: 10px; height: 10px; cursor: nesw-resize; }
    .grid-panel-shell__resize.nw { top: 0; left: 0; width: 10px; height: 10px; cursor: nwse-resize; }
    .grid-panel-shell__resize.se { bottom: 0; right: 0; width: 10px; height: 10px; cursor: nwse-resize; }
    .grid-panel-shell__resize.sw { bottom: 0; left: 0; width: 10px; height: 10px; cursor: nesw-resize; }
    .grid-panel-shell__resize,
    .resize-handle {
      touch-action: none;
    }
    .panel-recycle-placeholder {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      border-radius: 12px;
      background: rgba(8, 8, 8, 0.68);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
      contain: layout paint style;
      content-visibility: auto;
    }
    .panel-recycle-placeholder__header {
      min-height: 36px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 0 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      color: rgba(255,255,255,0.78);
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 11px;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .panel-recycle-placeholder__header span:first-child {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .panel-recycle-placeholder__header span:last-child {
      color: color-mix(in srgb, var(--g-primary) 62%, transparent);
      text-transform: uppercase;
      font-size: 9px;
      letter-spacing: 0.08em;
    }
    .panel-recycle-placeholder__body {
      flex: 1;
      display: grid;
      gap: 10px;
      align-content: start;
      padding: 14px;
      background: rgba(0,0,0,0.16);
    }
    .panel-recycle-placeholder__body div {
      height: 12px;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(255,255,255,0.06), color-mix(in srgb, var(--g-primary) 10%, transparent), rgba(255,255,255,0.04));
    }
    .panel-recycle-placeholder__body div:nth-child(2) { width: 72%; }
    .panel-recycle-placeholder__body div:nth-child(3) { width: 46%; }
    @media (max-width: 768px) {
      .grid-panel-shell__resize {
        touch-action: none;
        opacity: 0;
        transition: opacity 0.15s ease 300ms;
      }
      .grid-panel-shell:hover .grid-panel-shell__resize {
        opacity: 1;
      }
      .grid-panel-shell__resize.n { top: -4px; left: 16px; right: 16px; height: 16px; }
      .grid-panel-shell__resize.s { bottom: -4px; left: 16px; right: 16px; height: 16px; }
      .grid-panel-shell__resize.e { right: -4px; top: 16px; bottom: 16px; width: 16px; }
      .grid-panel-shell__resize.w { left: -4px; top: 16px; bottom: 16px; width: 16px; }
      .grid-panel-shell__resize.ne,
      .grid-panel-shell__resize.nw,
      .grid-panel-shell__resize.se,
      .grid-panel-shell__resize.sw {
        width: 24px;
        height: 24px;
      }
    }

    /* Layout presets dropdown */
    .layouts-dropdown-wrapper { position: relative; }
    .layouts-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      min-width: 260px;
      max-height: 420px;
      overflow-y: auto;
      background: rgba(10, 10, 12, 0.97);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
      border-radius: 10px;
      padding: 6px;
      box-shadow: 0 18px 50px rgba(0,0,0,0.65), 0 0 0 1px rgba(0,0,0,0.5);
      z-index: 1000;
    }
    .layouts-menu__section-label {
      font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase;
      color: rgba(255,255,255,0.4);
      padding: 6px 10px 4px; font-weight: 700;
    }
    .layouts-menu__sep {
      height: 1px;
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      margin: 4px 6px;
    }
    .layouts-menu__row { display: flex; align-items: stretch; gap: 2px; }
    .layouts-menu__item {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 10px;
      border: 1px solid transparent; border-radius: 6px;
      background: transparent; color: rgba(255,255,255,0.85);
      font-size: 12px; font-family: inherit; text-align: left;
      cursor: pointer; transition: all 0.12s; flex: 1; min-width: 0;
    }
    .layouts-menu__item:hover {
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
      color: var(--c-accent, var(--g-primary));
    }
    .layouts-menu__icon { flex-shrink: 0; font-size: 13px; width: 16px; text-align: center; }
    .layouts-menu__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .layouts-menu__meta {
      flex-shrink: 0;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      color: color-mix(in srgb, var(--g-primary) 80%, transparent);
    }
    .layouts-menu__del {
      width: 26px; flex-shrink: 0;
      border: 1px solid transparent; border-radius: 6px;
      background: transparent; color: rgba(255,255,255,0.35);
      cursor: pointer; font-size: 11px;
    }
    .layouts-menu__del:hover {
      background: rgba(239,68,68,0.18); border-color: rgba(239,68,68,0.4);
      color: #ef4444;
    }

    /* New Session button in toolbar — primary CTA */
    .new-session-toolbar-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      box-sizing: border-box;
      padding: 0 14px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 70%, rgba(255,255,255,0.1));
      border-radius: 8px;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 100%, transparent), color-mix(in srgb, var(--g-primary) 80%, transparent));
      color: #0a0a0e;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      box-shadow:
        0 1px 0 rgba(255,255,255,0.25) inset,
        0 6px 18px color-mix(in srgb, var(--g-primary) 30%, transparent);
      transition: background 0.15s, box-shadow 0.15s, transform 0.1s;
    }

    .new-session-toolbar-btn:hover {
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 100%, white 8%), color-mix(in srgb, var(--g-primary) 90%, transparent));
      transform: translateY(-1px);
      box-shadow:
        0 1px 0 rgba(255,255,255,0.35) inset,
        0 8px 24px color-mix(in srgb, var(--g-primary) 45%, transparent);
    }

    .new-session-toolbar-btn svg {
      width: 14px;
      height: 14px;
      pointer-events: none; /* Don't block clicks on parent button */
    }

    /* ============================================================
       Voice Controls - Centralized voice input
       ============================================================ */
    
    .voice-controls-wrapper {
      display: flex;
      align-items: center;
      gap: 8px;
      position: relative;
    }
    
    .voice-toggle-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      background: transparent;
      color: var(--c-text-2, #888);
      cursor: pointer;
      font-size: 13px;
      transition: all 0.2s;
    }
    
    .voice-toggle-btn:hover {
      border-color: var(--c-accent, var(--g-primary));
      color: var(--c-accent, var(--g-primary));
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    }
    
    .voice-toggle-btn.active {
      border-color: #22c55e;
      background: rgba(34, 197, 94, 0.15);
      color: #22c55e;
    }
    
    .voice-toggle-btn.listening {
      animation: voice-pulse 1.5s ease-in-out infinite;
    }
    
    .voice-toggle-btn.failed {
      border-color: #ef4444;
      color: #ef4444;
    }
    
    .voice-toggle-btn svg {
      width: 18px;
      height: 18px;
    }
    
    .voice-active-indicator {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    
    @keyframes voice-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); }
      50% { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
    }
    
    .voice-active-panel {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 6px;
      font-size: 11px;
      color: #22c55e;
    }
    
    .voice-arrow {
      font-weight: bold;
    }
    
    .voice-panel-name {
      font-weight: 600;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .voice-interim {
      padding: 4px 10px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      font-size: 11px;
      color: var(--c-text-2, #888);
      font-style: italic;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .voice-error {
      color: #ef4444;
      font-size: 14px;
    }
    
    .voice-settings-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      background: transparent;
      color: var(--c-text-2, #888);
      cursor: pointer;
      transition: all 0.2s;
    }
    
    .voice-settings-btn:hover {
      border-color: var(--c-accent, var(--g-primary));
      color: var(--c-accent, var(--g-primary));
    }
    
    .voice-settings-btn.active {
      background: var(--c-accent, var(--g-primary));
      color: #000;
      border-color: var(--c-accent, var(--g-primary));
    }
    
    .voice-settings-btn svg {
      width: 16px;
      height: 16px;
    }
    
    .voice-settings-popover {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: #1a1a1a;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 12px;
      padding: 16px;
      min-width: 320px;
      max-height: 400px;
      overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      z-index: 10001;
    }
    
    .voice-settings-popover h4 {
      margin: 0 0 12px 0;
      font-size: 13px;
      font-weight: 700;
      color: var(--c-accent, var(--g-primary));
    }
    
    .voice-settings-popover h5 {
      margin: 0 0 8px 0;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--c-text-2, #888);
    }
    
    .voice-setting-row {
      margin-bottom: 12px;
    }
    
    .voice-setting-row label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--c-text, #ccc);
      cursor: pointer;
    }
    
    .voice-setting-row input[type="checkbox"] {
      accent-color: var(--c-accent, var(--g-primary));
      width: 16px;
      height: 16px;
    }
    
    .voice-setting-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    
    .voice-setting-field .field-label {
      font-size: 11px;
      color: var(--c-text-2, #888);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .voice-setting-field input[type="number"] {
      background: #111;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
      color: var(--c-text, #ccc);
      width: 100%;
    }
    
    .voice-setting-field input[type="number"]:focus {
      outline: none;
      border-color: var(--c-accent, var(--g-primary));
    }
    
    .voice-setting-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.1);
      margin: 12px 0;
    }
    
    .voice-setting-hint {
      font-size: 11px;
      color: var(--c-text-3, #666);
      margin: 0 0 8px 0;
      line-height: 1.4;
    }
    
    .voice-panel-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    .voice-panel-config {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
    }
    
    .voice-panel-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--c-text, #ccc);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 80px;
    }
    
    .voice-panel-config input[type="text"] {
      background: #111;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      color: var(--c-text, #ccc);
      width: 140px;
    }
    
    .voice-panel-config input[type="text"]:focus {
      outline: none;
      border-color: var(--c-accent, var(--g-primary));
    }

    .session-picker {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 8px;
      width: 320px;
      max-height: 400px;
      background: var(--c-bg-1, #111);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      overflow: hidden;
      z-index: 10001;
    }

    .session-picker-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .session-picker-header h4 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--c-text-1);
    }

    .session-picker-close {
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--c-text-2);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .session-picker-close:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }

    .session-picker-close svg {
      width: 16px;
      height: 16px;
    }

    .session-picker-content {
      max-height: 300px;
      overflow-y: auto;
      padding: 8px;
    }

    .session-picker-section {
      margin-bottom: 8px;
    }

    .session-picker-section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--c-text-3);
      padding: 4px 8px;
    }

    .session-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .session-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .session-item.active {
      background: rgba(251, 191, 36, 0.15);
      border: 1px solid rgba(251, 191, 36, 0.3);
    }

    .session-item-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }

    .session-item-info {
      flex: 1;
      min-width: 0;
    }

    .session-item-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--c-text-1);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-item-meta {
      font-size: 11px;
      color: var(--c-text-3);
    }

    .session-item-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(16, 185, 129, 0.2);
      color: #10b981;
    }

    .new-session-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 10px 12px;
      border: 1px dashed rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      background: transparent;
      color: var(--c-text-2);
      cursor: pointer;
      font-size: 13px;
      transition: all 0.15s;
      margin-top: 4px;
    }

    .new-session-btn:hover {
      border-color: var(--c-accent);
      color: var(--c-accent);
      background: rgba(251, 191, 36, 0.1);
    }

    .new-session-btn svg {
      width: 16px;
      height: 16px;
    }

    .minimized-dock {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      gap: 8px;
      padding: 8px 16px;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      z-index: 9999;
      flex-wrap: wrap;
    }

    .minimized-tab {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--c-text-1, #eee);
      cursor: pointer;
      font-size: 13px;
      transition: all 0.2s;
      max-width: 200px;
    }

    .minimized-tab:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: var(--c-accent, var(--g-primary));
    }

    .minimized-tab span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .loading-sessions {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 20px 16px;
      color: rgba(255,255,255,0.5);
      font-size: 12px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
    }

    .loading-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.1);
      border-top-color: var(--c-accent, var(--g-primary));
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* ============================================================
       Enhanced Loading Animations
       ============================================================ */
    
    /* Shimmer effect for skeleton loaders */
    @keyframes shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }

    @keyframes pulse-glow {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes scale-in {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes slide-in-left {
      from { opacity: 0; transform: translateX(-20px); }
      to { opacity: 1; transform: translateX(0); }
    }

    /* Fancy loading spinner */
    .loading-fancy {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 40px;
      animation: fade-in 0.3s ease;
    }

    .loading-fancy__spinner {
      position: relative;
      width: 48px;
      height: 48px;
    }

    .loading-fancy__ring {
      position: absolute;
      inset: 0;
      border: 2px solid transparent;
      border-radius: 50%;
    }

    .loading-fancy__ring:nth-child(1) {
      border-top-color: var(--g-primary);
      animation: spin 1s linear infinite;
    }

    .loading-fancy__ring:nth-child(2) {
      border-right-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      animation: spin 1.5s linear infinite reverse;
      inset: 4px;
    }

    .loading-fancy__ring:nth-child(3) {
      border-bottom-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
      animation: spin 2s linear infinite;
      inset: 8px;
    }

    .loading-fancy__text {
      font-size: 11px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      color: rgba(255,255,255,0.4);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .loading-fancy__dots {
      display: inline-flex;
      gap: 4px;
      margin-left: 4px;
    }

    .loading-fancy__dot {
      width: 4px;
      height: 4px;
      background: var(--g-primary);
      border-radius: 50%;
      animation: pulse-glow 1.4s ease-in-out infinite;
    }

    .loading-fancy__dot:nth-child(2) { animation-delay: 0.2s; }
    .loading-fancy__dot:nth-child(3) { animation-delay: 0.4s; }

    /* Skeleton loaders */
    .skeleton {
      background: linear-gradient(
        90deg,
        rgba(255,255,255,0.03) 0%,
        rgba(255,255,255,0.08) 50%,
        rgba(255,255,255,0.03) 100%
      );
      background-size: 200% 100%;
      animation: shimmer 1.5s ease-in-out infinite;
      border-radius: 4px;
    }

    .skeleton-session {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      margin-bottom: 4px;
    }

    .skeleton-session__avatar {
      width: 32px;
      height: 32px;
      border-radius: 8px;
    }

    .skeleton-session__content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .skeleton-session__title {
      height: 12px;
      width: 70%;
    }

    .skeleton-session__meta {
      height: 8px;
      width: 50%;
    }

    .skeleton-panel {
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 12px;
      overflow: hidden;
      animation: scale-in 0.3s ease;
    }

    .skeleton-panel__header {
      height: 40px;
      background: rgba(0,0,0,0.4);
      border-bottom: 1px solid rgba(255,255,255,0.05);
      display: flex;
      align-items: center;
      padding: 0 12px;
      gap: 8px;
    }

    .skeleton-panel__led {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .skeleton-panel__title {
      height: 14px;
      flex: 1;
      max-width: 150px;
    }

    .skeleton-panel__body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .skeleton-message {
      display: flex;
      gap: 12px;
    }

    .skeleton-message.right {
      flex-direction: row-reverse;
    }

    .skeleton-message__avatar {
      width: 32px;
      height: 32px;
      border-radius: 8px;
    }

    .skeleton-message__bubble {
      flex: 1;
      max-width: 70%;
    }

    .skeleton-message__line {
      height: 10px;
      margin-bottom: 6px;
    }

    .skeleton-message__line:last-child {
      width: 60%;
      margin-bottom: 0;
    }

    /* Progress bar */
    .loading-progress {
      height: 2px;
      background: rgba(255,255,255,0.05);
      overflow: hidden;
      border-radius: 1px;
    }

    .loading-progress__bar {
      height: 100%;
      background: linear-gradient(90deg, var(--g-primary), #FFA500, var(--g-primary));
      background-size: 200% 100%;
      animation: shimmer 1s ease-in-out infinite, progress-grow 2s ease-out forwards;
    }

    @keyframes progress-grow {
      from { width: 0%; }
      to { width: 100%; }
    }

    /* Content fade in when loaded */
    .content-loaded {
      animation: fade-in 0.3s ease;
    }

    /* Sidebar skeleton */
    .sidebar-skeleton {
      padding: 8px;
    }

    .sidebar-skeleton__category {
      margin-bottom: 12px;
    }

    .sidebar-skeleton__header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
    }

    .sidebar-skeleton__chevron {
      width: 12px;
      height: 12px;
      border-radius: 2px;
    }

    .sidebar-skeleton__name {
      height: 10px;
      width: 80px;
    }

    /* Typing indicator */
    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 12px;
    }

    .typing-indicator__dot {
      width: 6px;
      height: 6px;
      background: color-mix(in srgb, var(--g-primary) 60%, transparent);
      border-radius: 50%;
      animation: typing-bounce 1.4s ease-in-out infinite;
    }

    .typing-indicator__dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator__dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes typing-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-4px); }
    }

    /* ============================================================
       Session Sidebar - Terminal Grid Style
       ============================================================ */
    .grid-layout {
      display: flex;
      position: absolute;
      /* Toolbar (48) + optional canvas tab bar (40). The tab bar is rendered
         conditionally; the host element sets data-has-tabs="false" when there
         is no tab bar so the workspace reclaims those 40px. */
      top: 88px;
      left: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      background: transparent; /* Let terminal background show through */
      contain: layout size;
    }
    :host([data-has-tabs="false"]) .grid-layout {
      top: 48px;
    }

    .session-sidebar {
      width: 280px;
      min-width: 280px;
      background: rgba(10, 10, 10, 0.7);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-right: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      overflow: hidden;
      transition: width 0.2s ease, min-width 0.2s ease, border-right 0.2s ease;
    }

    .session-sidebar.collapsed {
      width: 0;
      min-width: 0;
      border-right: none;
      overflow: hidden;
    }

    .sidebar-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
      background: color-mix(in srgb, var(--g-primary) 2%, transparent);
    }

    .sidebar-header__title {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      flex: 1;
    }

    .sidebar-header__count {
      font-size: 10px;
      color: rgba(255,255,255,0.4);
      background: rgba(255,255,255,0.05);
      padding: 2px 6px;
      border-radius: 3px;
    }

    .sidebar-content {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .sidebar-section {
      margin-bottom: 12px;
    }

    .sidebar-section__title {
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: rgba(255,255,255,0.25);
      padding: 4px 8px;
      margin-bottom: 4px;
    }

    .sidebar-session {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.1s;
      border: 1px solid transparent;
    }

    .sidebar-session:hover {
      background: color-mix(in srgb, var(--g-primary) 6%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }

    .sidebar-session.in-grid {
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 15%, transparent);
    }

    .sidebar-session__led {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: rgba(255,255,255,0.15);
      flex-shrink: 0;
    }

    .sidebar-session__led.active {
      background: #22c55e;
      box-shadow: 0 0 6px rgba(34,197,94,0.5);
    }

    .sidebar-session__icon {
      font-size: 12px;
      line-height: 1;
    }

    .sidebar-session__info {
      flex: 1;
      min-width: 0;
    }

    .sidebar-session__name {
      font-size: 11px;
      font-weight: 600;
      color: #e4e4e7;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sidebar-session__meta {
      font-size: 9px;
      color: rgba(255,255,255,0.35);
      margin-top: 1px;
    }

    .sidebar-session__badge {
      font-size: 8px;
      padding: 2px 5px;
      border-radius: 2px;
      background: rgba(34,197,94,0.15);
      color: #22c55e;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .sidebar-session__add-btn {
      opacity: 0;
      font-size: 12px;
      color: var(--g-primary);
      transition: opacity 0.1s;
    }

    .sidebar-session:hover .sidebar-session__add-btn {
      opacity: 1;
    }

    .sidebar-new-session {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 10px;
      margin-top: 8px;
      border: 1px dashed color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 4px;
      background: transparent;
      color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s;
    }

    .sidebar-new-session:hover {
      border-color: var(--g-primary);
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 5%, transparent);
    }

    .sidebar-new-session svg {
      width: 12px;
      height: 12px;
    }

    /* Category styles */
    .sidebar-category {
      margin-bottom: 4px;
    }

    .sidebar-category__header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      cursor: pointer;
      user-select: none;
      border-radius: 4px;
      transition: background 0.1s;
    }

    .sidebar-category__header:hover {
      background: rgba(255,255,255,0.03);
    }

    .sidebar-category__chevron {
      width: 12px;
      height: 12px;
      color: rgba(255,255,255,0.3);
      transition: transform 0.15s ease;
      flex-shrink: 0;
    }

    .sidebar-category__chevron.collapsed {
      transform: rotate(-90deg);
    }

    .sidebar-category__icon {
      font-size: 12px;
      line-height: 1;
    }

    .sidebar-category__name {
      flex: 1;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: rgba(255,255,255,0.4);
    }

    .sidebar-category__count {
      font-size: 9px;
      color: rgba(255,255,255,0.25);
      background: rgba(255,255,255,0.05);
      padding: 1px 5px;
      border-radius: 3px;
    }

    .sidebar-category__actions {
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.1s;
    }

    .sidebar-category__header:hover .sidebar-category__actions {
      opacity: 1;
    }

    .sidebar-category__action {
      width: 18px;
      height: 18px;
      border: none;
      background: transparent;
      color: rgba(255,255,255,0.4);
      cursor: pointer;
      border-radius: 3px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .sidebar-category__action:hover {
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      color: var(--g-primary);
    }

    .sidebar-category__action svg {
      width: 10px;
      height: 10px;
    }

    .sidebar-category__items {
      padding-left: 8px;
      overflow: hidden;
      transition: max-height 0.2s ease;
    }

    .sidebar-category__items.collapsed {
      max-height: 0 !important;
    }

    /* Draggable session */
    .sidebar-session.dragging {
      opacity: 0.5;
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }

    .sidebar-session.drag-over {
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    }

    .sidebar-drop-indicator {
      height: 2px;
      background: var(--g-primary);
      margin: 2px 0;
      border-radius: 1px;
      box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary) 50%, transparent);
    }

    /* New category input */
    .sidebar-new-category {
      display: flex;
      gap: 6px;
      padding: 6px 10px;
      margin-bottom: 8px;
    }

    .sidebar-new-category__input {
      flex: 1;
      padding: 6px 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-radius: 4px;
      background: rgba(0,0,0,0.3);
      color: #fff;
      font-size: 11px;
      font-family: inherit;
      outline: none;
    }

    .sidebar-new-category__input:focus {
      border-color: var(--g-primary);
    }

    .sidebar-new-category__btn {
      padding: 4px 8px;
      border: none;
      border-radius: 4px;
      background: var(--g-primary);
      color: #000;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
    }

    .sidebar-new-category__btn:hover {
      background: #FFC800;
    }

    .sidebar-new-category__btn.cancel {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.6);
    }

    .sidebar-add-category {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 6px;
      margin: 8px 10px 0;
      border: 1px dashed rgba(255,255,255,0.15);
      border-radius: 4px;
      background: transparent;
      color: rgba(255,255,255,0.35);
      font-size: 10px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .sidebar-add-category:hover {
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      color: color-mix(in srgb, var(--g-primary) 70%, transparent);
      background: color-mix(in srgb, var(--g-primary) 5%, transparent);
    }

    .sidebar-add-category svg {
      width: 10px;
      height: 10px;
    }

    .sidebar-toggle-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0 12px;
      height: 36px;
      box-sizing: border-box;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, rgba(255,255,255,0.06));
      border-radius: 8px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015)),
        var(--g-glass-tint, transparent);
      color: var(--c-text-2);
      cursor: pointer;
      font-size: 12px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.25);
      transition: background 0.15s, border-color 0.15s, color 0.15s, box-shadow 0.15s, transform 0.1s;
    }

    .sidebar-toggle-btn:hover {
      border-color: var(--c-accent, var(--g-primary));
      color: var(--c-accent, var(--g-primary));
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 14%, transparent), color-mix(in srgb, var(--g-primary) 4%, transparent));
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08);
    }

    .sidebar-toggle-btn.active {
      border-color: var(--g-primary);
      color: var(--g-primary);
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 22%, transparent), color-mix(in srgb, var(--g-primary) 10%, transparent));
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary) 35%, transparent),
        0 4px 14px color-mix(in srgb, var(--g-primary) 25%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.08);
    }

    .sidebar-toggle-btn svg {
      width: 16px;
      height: 16px;
      pointer-events: none; /* Don't block clicks on parent button */
    }

    .grid-workspace-with-sidebar {
      flex: 1;
      position: relative;
      overflow: hidden;
      background: transparent; /* Let terminal background show through */
      overscroll-behavior: contain;
    }

    @media (max-width: 768px) {
      :host,
      .grid-container,
      .grid-layout,
      .grid-workspace-with-sidebar,
      .grid-panel-shell .grid-panel-body {
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        scroll-behavior: smooth;
      }
      .grid-panel-shell,
      .panel-recycle-placeholder {
        border-radius: 8px;
        box-shadow: none;
        content-visibility: auto;
      }
      .session-sidebar {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        z-index: 9998;
        box-shadow: 4px 0 20px rgba(0,0,0,0.5);
      }
      .session-sidebar.collapsed {
        transform: translateX(-100%);
      }
    }

    /* ============================================================
       Task Sidebar — Real-time Task Progress
       ============================================================ */
    .task-sidebar {
      width: 320px;
      min-width: 320px;
      background: rgba(5, 5, 5, 0.7);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-left: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      overflow: hidden;
      transition: width 0.2s ease, min-width 0.2s ease, border-left 0.2s ease;
    }

    .task-sidebar.collapsed {
      width: 0;
      min-width: 0;
      border-left: none;
      overflow: hidden;
    }

    .task-sidebar-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
      background: color-mix(in srgb, var(--g-primary) 2%, transparent);
    }

    .task-sidebar-header__title {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      flex: 1;
    }

    .task-sidebar-header__live {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      padding: 3px 8px;
      letter-spacing: 0.1em;
      font-weight: 700;
      border: 1px solid #22c55e;
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
      border-radius: 4px;
      animation: task-live-pulse 2s infinite;
    }

    .live-dot {
      width: 6px;
      height: 6px;
      background: #22c55e;
      border-radius: 50%;
      animation: task-live-dot 1s infinite;
    }

    @keyframes task-live-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    @keyframes task-live-dot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.3); opacity: 0.7; }
    }

    .task-sidebar-header__count {
      font-size: 10px;
      color: rgba(255,255,255,0.4);
      background: rgba(255,255,255,0.05);
      padding: 2px 6px;
      border-radius: 3px;
    }

    .task-sidebar-content {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    /* Overall progress bar */
    .task-overall-progress {
      padding: 10px 12px;
      margin-bottom: 8px;
      background: rgba(0,0,0,0.3);
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    }

    .task-overall-progress__label {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      color: rgba(255,255,255,0.4);
      margin-bottom: 6px;
    }

    .task-overall-progress__bar {
      height: 4px;
      background: rgba(255,255,255,0.08);
      border-radius: 2px;
      overflow: hidden;
    }

    .task-overall-progress__fill {
      height: 100%;
      background: linear-gradient(90deg, var(--g-primary), #FFA500);
      border-radius: 2px;
      transition: width 0.5s ease;
    }

    /* Task Sections */
    .task-section {
      margin-top: 12px;
    }

    .task-section__header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      margin-bottom: 8px;
    }

    .task-section__header--clickable {
      cursor: pointer;
      border-radius: 4px;
      padding: 8px 6px;
      margin: 0 -6px 8px;
      transition: background 0.15s ease;
    }

    .task-section__header--clickable:hover {
      background: rgba(255,255,255,0.03);
    }

    .task-section__chevron {
      font-size: 9px;
      color: #71717a;
      transition: transform 0.2s ease;
      width: 12px;
      text-align: center;
    }

    .task-section.collapsed .task-section__header {
      margin-bottom: 0;
      border-bottom: none;
    }

    .task-section__icon {
      font-size: 12px;
    }

    .task-section__title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #a1a1aa;
    }

    .task-section__count {
      margin-left: auto;
      font-size: 9px;
      color: #71717a;
      background: rgba(255,255,255,0.05);
      padding: 2px 6px;
      border-radius: 8px;
    }

    .task-section__list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .task-section__list--compact {
      gap: 4px;
    }

    .task-section--completed {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }

    .task-section--completed .task-section__title {
      color: #22c55e;
    }

    /* Completed task card - compact */
    .task-card--completed {
      padding: 8px 10px;
      background: rgba(34, 197, 94, 0.05);
      border: 1px solid rgba(34, 197, 94, 0.1);
    }

    .task-card--completed .task-card__header {
      padding: 0;
    }

    .task-card--completed .task-card__title {
      font-size: 11px;
      color: #a1a1aa;
      -webkit-line-clamp: 2;
    }

    .task-card__completed-time {
      font-size: 9px;
      color: #52525b;
      margin-top: 2px;
    }

    /* Alerts section */
    .task-alerts {
      margin-bottom: 8px;
    }

    .task-alert {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 10px;
      margin-bottom: 4px;
      border-radius: 4px;
      font-size: 10px;
      animation: fade-in 0.3s ease;
    }

    .task-alert.error {
      background: rgba(239,68,68,0.15);
      border: 1px solid rgba(239,68,68,0.3);
      color: #ef4444;
    }

    .task-alert.success {
      background: rgba(34,197,94,0.15);
      border: 1px solid rgba(34,197,94,0.3);
      color: #22c55e;
    }

    .task-alert.warning {
      background: rgba(251,191,36,0.15);
      border: 1px solid rgba(251,191,36,0.3);
      color: var(--g-primary);
    }

    .task-alert__icon {
      flex-shrink: 0;
    }

    .task-alert__message {
      flex: 1;
      line-height: 1.3;
    }

    .task-alert__dismiss {
      width: 16px;
      height: 16px;
      border: none;
      background: transparent;
      color: inherit;
      opacity: 0.5;
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .task-alert__dismiss:hover {
      opacity: 1;
    }

    /* Individual task card */
    .task-card {
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
      transition: all 0.15s;
    }

    .task-card:hover {
      border-color: color-mix(in srgb, var(--g-primary) 15%, transparent);
    }

    .task-card.active {
      border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
      box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 10%, transparent);
    }

    .task-card__header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      cursor: pointer;
    }

    .task-card__status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .task-card__status.pending {
      background: rgba(255,255,255,0.3);
    }

    .task-card__status.in_progress {
      background: var(--g-primary);
      box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary) 50%, transparent);
      animation: ap-pulse 1.5s infinite;
    }

    .task-card__status.complete {
      background: #22c55e;
      box-shadow: 0 0 6px rgba(34,197,94,0.5);
    }

    .task-card__status.error {
      background: #ef4444;
      box-shadow: 0 0 6px rgba(239,68,68,0.5);
    }

    .task-card__status.blocked {
      background: #f97316;
    }

    .task-card__info {
      flex: 1;
      min-width: 0;
    }

    .task-card__title {
      font-size: 12px;
      font-weight: 600;
      color: #e4e4e7;
      line-height: 1.4;
      word-wrap: break-word;
      overflow-wrap: break-word;
      /* Show up to 3 lines, then ellipsis */
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .task-card__phase {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: var(--g-primary);
      margin-top: 2px;
    }

    .task-card__progress-text {
      font-size: 10px;
      color: rgba(255,255,255,0.5);
      flex-shrink: 0;
    }

    .task-card__progress-bar {
      height: 2px;
      background: rgba(255,255,255,0.08);
      margin: 0 12px;
    }

    .task-card__progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--g-primary), #FFA500);
      transition: width 0.5s ease;
    }

    /* Task Action Buttons */
    .task-card__actions {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      border-top: 1px solid rgba(255,255,255,0.04);
    }

    .task-card__btn {
      flex: 1;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border: 1px solid;
    }

    .task-card__btn--edit {
      background: rgba(59, 130, 246, 0.1);
      border-color: rgba(59, 130, 246, 0.25);
      color: #60a5fa;
    }

    .task-card__btn--edit:hover {
      background: rgba(59, 130, 246, 0.2);
      border-color: rgba(59, 130, 246, 0.4);
      transform: translateY(-1px);
    }

    .task-card__btn--approve {
      background: rgba(34, 197, 94, 0.1);
      border-color: rgba(34, 197, 94, 0.25);
      color: #4ade80;
    }

    .task-card__btn--approve:hover {
      background: rgba(34, 197, 94, 0.2);
      border-color: rgba(34, 197, 94, 0.4);
      transform: translateY(-1px);
    }

    /* Expanded task details */
    .task-card__details {
      padding: 0 12px 10px;
      border-top: 1px solid rgba(255,255,255,0.04);
      margin-top: 6px;
    }

    .task-card__steps {
      margin-top: 8px;
    }

    .task-step {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 9px;
      padding: 3px 0;
      color: rgba(255,255,255,0.5);
    }

    .task-step__icon {
      width: 12px;
      text-align: center;
      flex-shrink: 0;
    }

    .task-step__icon.tool_call { color: var(--g-primary); }
    .task-step__icon.tool_result { color: #22c55e; }
    .task-step__icon.thinking { color: #a78bfa; }
    .task-step__icon.error { color: #ef4444; }

    .task-step__content {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .task-step__time {
      color: rgba(255,255,255,0.25);
      flex-shrink: 0;
    }

    .task-card__meta {
      display: flex;
      gap: 10px;
      font-size: 8px;
      color: rgba(255,255,255,0.35);
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255,255,255,0.04);
    }

    /* Empty state */
    .task-sidebar-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      text-align: center;
    }

    .task-sidebar-empty__icon {
      font-size: 32px;
      opacity: 0.3;
      margin-bottom: 12px;
    }

    .task-sidebar-empty__text {
      font-size: 10px;
      color: rgba(255,255,255,0.3);
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .task-sidebar-empty__hint {
      font-size: 9px;
      color: rgba(255,255,255,0.2);
      margin-top: 6px;
    }

    @keyframes ap-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @media (max-width: 768px) {
      .task-sidebar {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        z-index: 9998;
        box-shadow: -4px 0 20px rgba(0,0,0,0.5);
      }
      .task-sidebar.collapsed {
        transform: translateX(100%);
      }
    }

    /* ── Premium glass layer (styles/glass, docs/ui/GLASS.md) ───────────
       Toolbar becomes the same frosted pane as the app top bar; light mode
       gets porcelain controls (the rules above hard-code dark rgba). */
    .grid-toolbar {
      background: var(--glass-sheen), var(--glass-2, rgba(0, 0, 0, 0.5));
      backdrop-filter: var(--glass-blur, blur(18px) saturate(160%));
      -webkit-backdrop-filter: var(--glass-blur, blur(18px) saturate(160%));
      border-bottom: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.06));
      box-shadow: var(--glass-specular), 0 10px 26px -18px rgba(0, 0, 0, 0.6);
      font-family: var(--glass-font, inherit);
    }
    .toolbar-btn { border-radius: 10px; backdrop-filter: none; -webkit-backdrop-filter: none; }
    .toolbar-btn:focus-visible { outline: none; box-shadow: var(--glass-focus-ring); }
    :host-context([data-theme="light"]) .grid-toolbar :is(button, select, .node-selector-trigger):not(.active):not(.new-session-toolbar-btn) {
      background: var(--glass-sheen), rgba(255, 255, 255, 0.7);
      border-color: var(--glass-stroke-strong);
      color: var(--glass-fg-2);
      box-shadow: var(--glass-specular), 0 1px 2px rgba(60, 45, 20, 0.08);
    }
    :host-context([data-theme="light"]) .grid-toolbar :is(button, select, .node-selector-trigger):not(.active):not(.new-session-toolbar-btn):hover {
      color: var(--glass-fg);
      border-color: var(--glass-stroke-gold);
    }
    :host-context([data-theme="light"]) .grid-toolbar .node-label,
    :host-context([data-theme="light"]) .grid-toolbar .session-count { color: var(--glass-fg-2); }
    :host-context([data-theme="light"]) .toolbar-divider { background: linear-gradient(180deg, transparent, var(--glass-stroke-strong), transparent); }
  `;

  @property({ type: Object }) gridState: MasonryGridState = createMasonryGridState();
  @property({ type: Object }) client: any = null;
  @property({ type: Object }) sessions: SessionsListResult | null = null;
  @property({ type: Array }) availableModels: ModelOption[] = [];
  /**
   * Full AppViewState — needed by kanban/database/terminal panels so they can
   * call into the existing renderKanban / renderDatabases / terminal session
   * helpers without each panel re-implementing data loading.
   */
  @property({ type: Object }) appState: any = null;
  @state() private showAddPanelMenu = false;
  /** Panel-gallery search query. */
  @state() private addPanelSearch = "";
  /** Panel-gallery active category filter ("" = all). */
  @state() private addPanelCategory: PanelCategory | "" = "";

  @state() private dragState: DragState | null = null;
  @state() private resizeState: ResizeState | null = null;
  @state() private snapGuides: SnapGuide[] = [];
  @state() private dockZone: DockZone | null = null;
  @state() private showLayoutsMenu = false;
  @state() private layoutPresets: LayoutPreset[] = [];
  @state() private showSessionPicker = false;
  @state() private showSidebar = false;
  @state() private sidebarState: SidebarState = loadSidebarState();
  
  // Canvas tab state
  @state() private renamingCanvasId: string | null = null;
  @state() private renameCanvasValue: string = "";
  @state() private sidebarDragItem: { sessionKey: string; startY: number } | null = null;
  @state() private sidebarDropTarget: { categoryId: string; position: number } | null = null;
  @state() private showNewCategoryInput = false;
  @state() private newCategoryName = "";
  
  // Task sidebar state
  @state() private showTaskSidebar = false;
  @state() private taskState: GridTasksState = createGridTasksState();
  @state() private expandedTaskId: string | null = null;
  @state() private completedSectionCollapsed = false;
  @state() private approvedTaskIds: Set<string> = new Set();
  /** Federation node id selected in the add-panel menu, applied to the
   *  next chat / terminal panel created from that menu. Persists in
   *  localStorage so the user's last device choice survives reloads. */
  @state() private addPanelNodeId: string = (typeof localStorage !== "undefined"
    ? localStorage.getItem("infinibot:grid:addPanelNodeId") || "local"
    : "local");
  @state() private _isFullscreen = false;
  
  get isFullscreen() { return this._isFullscreen; }
  set isFullscreen(val: boolean) {
    this._isFullscreen = val;
    if (val) {
      this.setAttribute('fullscreen', '');
    } else {
      this.removeAttribute('fullscreen');
    }
  }
  
  
  // AI IDE mode - shows tool executions in panels
  @state() private showAiIde: boolean = this.loadAiIdePreference();
  
  // Federation/Node selector state
  @state() private federationNodes: FederationNode[] = [];
  @state() private selectedFederationNode: string = this.loadFederationDevice();
  @state() private federationLoading = false;
  
  // Per-device workspace state - maps device ID to its canvas state
  private deviceWorkspaces: Map<string, { canvases: CanvasTab[]; activeCanvasId: string }> = new Map();
  
  // Load federation device from localStorage
  private loadFederationDevice(): string {
    try {
      return localStorage.getItem('infinibot.federation.device') || 'master';
    } catch { return 'master'; }
  }
  
  // Save federation device to localStorage
  private saveFederationDevice(device: string): void {
    try {
      localStorage.setItem('infinibot.federation.device', device);
    } catch {}
  }
  
  // Load device workspaces from localStorage
  private loadDeviceWorkspaces(): void {
    try {
      const data = localStorage.getItem('infinibot.federation.workspaces');
      if (data) {
        const parsed = JSON.parse(data);
        this.deviceWorkspaces = new Map(Object.entries(parsed));
      }
    } catch { /* ignore */ }
  }
  
  // Save device workspaces to localStorage
  private saveDeviceWorkspaces(): void {
    try {
      const obj: Record<string, { canvases: CanvasTab[]; activeCanvasId: string }> = {};
      this.deviceWorkspaces.forEach((v, k) => { obj[k] = v; });
      localStorage.setItem('infinibot.federation.workspaces', JSON.stringify(obj));
    } catch { /* ignore */ }
  }
  
  // Create default 5 workspaces for a device
  private createDefaultWorkspaces(deviceId: string): CanvasTab[] {
    return [
      { id: `${deviceId}-ws-1`, name: "Main", panels: [] },
      { id: `${deviceId}-ws-2`, name: "Work", panels: [] },
      { id: `${deviceId}-ws-3`, name: "Research", panels: [] },
      { id: `${deviceId}-ws-4`, name: "Focus", panels: [] },
      { id: `${deviceId}-ws-5`, name: "Quick", panels: [] },
    ];
  }

  private resizeObserver: ResizeObserver | null = null;
  private panelRecycleObserver: IntersectionObserver | null = null;
  private observedPanelHosts = new Map<string, Element>();
  @state() private offscreenPanelIds = new Set<string>();
  private resizeFrame: number | null = null;
  private pendingResizePointer: { clientX: number; clientY: number; shiftKey: boolean } | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.resizeObserver = new ResizeObserver((entries) => {
      // Don't reflow while the user is mid-drag or mid-resize — otherwise
      // the proportional-rescale path inside updateContainerSize would fight
      // the user's mouse and snap the panel back to its previous rect on
      // every minor scrollbar/layout shift.
      if (this.dragState || this.resizeState) return;
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        this.gridState = updateContainerSize(this.gridState, width, height - 48);
        this.dispatchStateChange();
      }
    });
    this.resizeObserver.observe(this);

    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("mouseup", this.handleMouseUp);
    window.addEventListener("touchmove", this.handleMouseMove, { passive: false });
    window.addEventListener("touchend", this.handleMouseUp, { passive: false });
    window.addEventListener("touchcancel", this.handleMouseUp, { passive: false });
    window.addEventListener("click", this.handleOutsideClick);
    window.addEventListener("keydown", this.handleKeydown);
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
    // Per-panel refresh contract: A4's control bus + the in-chrome refresh
    // button both dispatch this event. The listener clears `needsRefresh`
    // on the next microtask so the flag doesn't stick across reloads.
    window.addEventListener(GRID_PANEL_REFRESH_EVENT, this.handleGridPanelRefresh as EventListener);
    // grid-panels/{projects,kanban,tasks}-panel.ts emit `panel-meta-update`
    // on `window` (they're plain functions, not LitElements with a render
    // root in the masonry-panel subtree, so the element-level
    // @panel-meta-update wiring on <terminal-grid-panel>/<masonry-panel>
    // never sees them). Without this listener, clicking a project tile in
    // the grid Projects panel dispatched into the void — `kanbanProjectId`
    // never updated and the gallery wouldn't switch into the single-project
    // view. Detail shape from those panels is `{ panelId, patch }`.
    window.addEventListener(
      "panel-meta-update",
      this.handleWindowPanelMetaUpdate as EventListener,
    );

    // Load federation workspaces from localStorage
    this.loadDeviceWorkspaces();
    
    // Initialize master device workspace if not exists
    if (!this.deviceWorkspaces.has('master')) {
      // Save current canvases as master workspace
      this.deviceWorkspaces.set('master', {
        canvases: [...this.gridState.canvases],
        activeCanvasId: this.gridState.activeCanvasId
      });
      this.saveDeviceWorkspaces();
    }
    
    // If selected device is not master, switch to its workspace
    if (this.selectedFederationNode !== 'master') {
      this.switchToDeviceWorkspace(this.selectedFederationNode);
    }
    
    // Federation nodes will be loaded when client becomes available (in updated())
  }
  
  // Switch grid to a device's workspace
  private switchToDeviceWorkspace(deviceId: string): void {
    // Save current workspace first
    this.deviceWorkspaces.set(this.selectedFederationNode, {
      canvases: [...this.gridState.canvases],
      activeCanvasId: this.gridState.activeCanvasId
    });
    
    // Load or create workspace for target device
    let workspace = this.deviceWorkspaces.get(deviceId);
    if (!workspace) {
      const newCanvases = this.createDefaultWorkspaces(deviceId);
      workspace = {
        canvases: newCanvases,
        activeCanvasId: newCanvases[0].id
      };
      this.deviceWorkspaces.set(deviceId, workspace);
    }
    
    // Update gridState with new workspace
    this.gridState = {
      ...this.gridState,
      canvases: [...workspace.canvases],
      activeCanvasId: workspace.activeCanvasId,
      panels: workspace.canvases.find(c => c.id === workspace!.activeCanvasId)?.panels || []
    };
    
    this.saveDeviceWorkspaces();
    this.dispatchStateChange();
  }

  updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has("showAddPanelMenu") && this.showAddPanelMenu) {
      this.keepPanelGalleryOnScreen();
    }
    // Load federation nodes when client becomes available
    if (changedProperties.has("client") && this.client && this.federationNodes.length === 0) {
      console.log("[MasonryGrid] Client available, loading federation nodes...");
      this.loadFederationNodesForGrid();
    }
    this.syncPanelRecycleObserver();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    if (this.resizeFrame !== null) {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mouseup", this.handleMouseUp);
    window.removeEventListener("touchmove", this.handleMouseMove);
    window.removeEventListener("touchend", this.handleMouseUp);
    window.removeEventListener("touchcancel", this.handleMouseUp);
    window.removeEventListener("click", this.handleOutsideClick);
    window.removeEventListener("keydown", this.handleKeydown);
    window.removeEventListener(GRID_PANEL_REFRESH_EVENT, this.handleGridPanelRefresh as EventListener);
    window.removeEventListener(
      "panel-meta-update",
      this.handleWindowPanelMetaUpdate as EventListener,
    );
    document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
    this.panelRecycleObserver?.disconnect();
    this.panelRecycleObserver = null;
    this.observedPanelHosts.clear();
    // Stop task polling
    stopTaskPolling(this.taskState);
  }

  private handleOutsideClick = (e: MouseEvent) => {
    if (this.showSessionPicker) {
      const picker = this.shadowRoot?.querySelector('.session-picker');
      const btn = this.shadowRoot?.querySelector('.add-session-btn');
      if (picker && !picker.contains(e.target as Node) &&
          btn && !btn.contains(e.target as Node)) {
        this.showSessionPicker = false;
      }
    }
    if (this.showAddPanelMenu) {
      const wrapper = this.shadowRoot?.querySelector('.add-panel-dropdown-wrapper');
      if (wrapper && !wrapper.contains(e.target as Node)) {
        this.showAddPanelMenu = false;
      }
    }
    if (this.showLayoutsMenu) {
      const wrapper = this.shadowRoot?.querySelector('.layouts-dropdown-wrapper');
      if (wrapper && !wrapper.contains(e.target as Node)) {
        this.showLayoutsMenu = false;
      }
    }
  };

  private getEventPos(e: MouseEvent | TouchEvent): { x: number; y: number } {
    if ("touches" in e) {
      const touch = e.touches[0] ?? e.changedTouches[0];
      return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 };
    }
    return { x: e.clientX, y: e.clientY };
  }

  private getEventShiftKey(e: MouseEvent | TouchEvent): boolean {
    return "shiftKey" in e ? e.shiftKey : false;
  }

  private handleMouseMove = (e: MouseEvent | TouchEvent) => {
    const pos = this.getEventPos(e);
    if ("touches" in e && (this.dragState || this.resizeState)) {
      e.preventDefault();
    }
    if (this.dragState) {
      const dx = pos.x - this.dragState.startX;
      const dy = pos.y - this.dragState.startY;
      const newX = this.dragState.startPanelX + dx;
      const newY = this.dragState.startPanelY + dy;

      // Calculate snap guides for visual feedback
      this.snapGuides = getActiveSnapGuides(this.gridState, this.dragState.panelId, newX, newY);

      // Edge-dock detection: figure out the cursor's position in container
      // coordinates and check whether the dragged panel is hovering over a
      // dock zone of another panel. Show a translucent preview overlay so
      // the user knows where it will land on release.
      const containerRect = (this.shadowRoot?.querySelector('.grid-container') as HTMLElement | null)?.getBoundingClientRect()
        ?? this.getBoundingClientRect();
      const cursorX = pos.x - containerRect.left;
      const cursorY = pos.y - containerRect.top - 48; // toolbar height
      this.dockZone = getDockZone(this.gridState, this.dragState.panelId, cursorX, cursorY);

      this.gridState = updatePanelPosition(this.gridState, this.dragState.panelId, newX, newY);
      this.requestUpdate();
    }

    if (this.resizeState) {
      this.pendingResizePointer = { clientX: pos.x, clientY: pos.y, shiftKey: this.getEventShiftKey(e) };
      this.scheduleResizeFrame();
    }
  };

  private handleMouseUp = () => {
    this.flushPendingResize();
    if (this.dragState && this.dockZone) {
      // Edge-dock drop: reshape dragged panel + target into the chosen split
      this.gridState = applyDockZone(this.gridState, this.dragState.panelId, this.dockZone);
    }
    if (this.dragState || this.resizeState) {
      saveLayoutToStorage(this.gridState);
      this.dispatchStateChange();
    }
    this.dragState = null;
    this.resizeState = null;
    this.linkedResizeSnapshot = [];
    this.pendingResizePointer = null;
    this.snapGuides = [];
    this.dockZone = null;
  };

  private scheduleResizeFrame() {
    if (this.resizeFrame !== null) return;
    this.resizeFrame = requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.flushPendingResize();
    });
  }

  private flushPendingResize() {
    if (this.resizeFrame !== null) {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    const pointer = this.pendingResizePointer;
    this.pendingResizePointer = null;
    if (!pointer || !this.resizeState) return;
    this.applyResizePointer(pointer.clientX, pointer.clientY, pointer.shiftKey);
  }

  private applyResizePointer(clientX: number, clientY: number, shiftKey: boolean) {
    if (!this.resizeState) return;
    const panel = this.gridState.panels.find((p) => p.id === this.resizeState!.panelId);
    if (!panel) return;

    const dx = clientX - this.resizeState.startX;
    const dy = clientY - this.resizeState.startY;

    let newWidth = this.resizeState.startWidth;
    let newHeight = this.resizeState.startHeight;
    let newX = this.resizeState.startPanelX;
    let newY = this.resizeState.startPanelY;

    const edge = this.resizeState.edge;

    if (edge.includes("e")) newWidth = this.resizeState.startWidth + dx;
    if (edge.includes("w")) {
      newWidth = this.resizeState.startWidth - dx;
      newX = this.resizeState.startPanelX + dx;
    }
    if (edge.includes("s")) newHeight = this.resizeState.startHeight + dy;
    if (edge.includes("n")) {
      newHeight = this.resizeState.startHeight - dy;
      newY = this.resizeState.startPanelY + dy;
    }

    // Aspect-ratio lock: shift held during a corner drag, OR panel has a
    // sticky aspectRatio set previously. We project the larger axis change
    // onto the locked ratio so the visible AR stays exact.
    const lockedRatio = shiftKey
      ? (this.resizeState.startWidth / this.resizeState.startHeight)
      : panel.aspectRatio;
    let nextAspectRatio: number | undefined = panel.aspectRatio;
    if (lockedRatio && lockedRatio > 0) {
      const isCorner = edge.length === 2;
      if (isCorner) {
        // Pick the dominant axis change and back-derive the other side.
        if (Math.abs(dx) > Math.abs(dy)) {
          newHeight = newWidth / lockedRatio;
          if (edge.includes("n")) newY = this.resizeState.startPanelY + (this.resizeState.startHeight - newHeight);
        } else {
          newWidth = newHeight * lockedRatio;
          if (edge.includes("w")) newX = this.resizeState.startPanelX + (this.resizeState.startWidth - newWidth);
        }
      } else {
        // Single-edge drag: keep AR by deriving the other dimension off the
        // active one (no position change on the dormant axis).
        if (edge === "e" || edge === "w") newHeight = newWidth / lockedRatio;
        if (edge === "n" || edge === "s") newWidth = newHeight * lockedRatio;
      }
      if (shiftKey) nextAspectRatio = lockedRatio;
    }

    this.gridState = updatePanelSize(
      this.gridState,
      this.resizeState.panelId,
      newWidth,
      newHeight,
      edge.includes("w") ? newX : undefined,
      edge.includes("n") ? newY : undefined,
      nextAspectRatio !== undefined ? { aspectRatio: nextAspectRatio } : undefined,
    );

    // Linked neighbours are updated in the same animation-frame commit so
    // split-pane resizing does not re-render on every raw mousemove event.
    if (this.linkedResizeSnapshot.length > 0) {
      const draggedRight = edge.includes("e") ? dx : 0;
      const draggedLeft = edge.includes("w") ? dx : 0;
      const draggedBottom = edge.includes("s") ? dy : 0;
      const draggedTop = edge.includes("n") ? dy : 0;
      this.gridState = applyLinkedResize(
        this.gridState,
        this.linkedResizeSnapshot,
        draggedRight,
        draggedLeft,
        draggedBottom,
        draggedTop,
      );
    }
    this.requestUpdate();
  }

  private dispatchStateChange() {
    this.dispatchEvent(
      new CustomEvent("grid-state-change", {
        detail: this.gridState,
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleToggleSessionPicker(e: Event) {
    e.stopPropagation();
    this.showSessionPicker = !this.showSessionPicker;
    
    if (this.showSessionPicker) {
      this.dispatchEvent(new CustomEvent("refresh-sessions", { bubbles: true, composed: true }));
    }
  }
  
  private async loadFederationNodesForGrid() {
    if (!this.client) {
      console.log("[MasonryGrid] loadFederationNodes: No client available");
      return;
    }
    
    console.log("[MasonryGrid] loadFederationNodes: Starting...");
    this.federationLoading = true;
    try {
      // Query both: federation satellites + mobile-paired nodes. Without
      // `federation.nodes.list` we'd miss every satellite registered with
      // the master hub, which is exactly the case the user hit when the
      // grid dropdown showed only "Local" while satellites were online.
      const [fedRes, mobileRes] = await Promise.all([
        this.client
          .request("federation.nodes.list", {})
          .catch(() => null) as Promise<
            { nodes?: Array<Record<string, unknown>>; localNodeId?: string } | null
          >,
        this.client
          .request("node.list", {})
          .catch(() => null) as Promise<
            { nodes?: Array<Record<string, unknown>>; localNodeId?: string } | null
          >,
      ]);
      const localNodeIdFromApi =
        fedRes?.localNodeId ?? mobileRes?.localNodeId;
      const merged: Array<Record<string, unknown>> = [
        ...(fedRes?.nodes ?? []),
        ...(mobileRes?.nodes ?? []),
      ];
      // Dedup by id — federation + mobile lists can occasionally overlap.
      const seen = new Set<string>();
      const res = {
        nodes: merged.filter((n) => {
          const id = String((n as { id?: unknown; nodeId?: unknown }).id ?? (n as { nodeId?: unknown }).nodeId ?? "");
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        }),
        localNodeId: localNodeIdFromApi,
      } as { nodes: Array<Record<string, unknown>>; localNodeId?: string };

      console.log("[MasonryGrid] loadFederationNodes: Merged response:", res);

      if (res?.nodes && Array.isArray(res.nodes)) {
        // Parse nodes from API response with platform detection
        this.federationNodes = res.nodes.map((n: any) => {
          // Detect platform from capabilities or name
          let platform: FederationNode["platform"] = "unknown";
          const capsPlat = n.capabilities?.platform?.toLowerCase?.() || "";
          const name = (n.name || n.hostname || "").toLowerCase();
          if (capsPlat.includes("ios") || name.includes("iphone") || name.includes("ipad")) platform = "ios";
          else if (capsPlat.includes("android") || name.includes("android")) platform = "android";
          else if (capsPlat.includes("macos") || capsPlat.includes("darwin") || name.includes("mac")) platform = "macos";
          else if (capsPlat.includes("windows") || capsPlat.includes("win32")) platform = "windows";
          else if (capsPlat.includes("linux")) platform = "linux";
          
          return {
            id: n.id || n.nodeId || "",
            name: n.name || n.hostname || n.id || "Unknown",
            hostname: n.hostname,
            remoteIp: n.remoteIp || n.ip,
            status: n.status || (n.connected ? "online" : "offline"),
            role: n.role || "satellite",
            platform,
            latency: n.latency,
            lastSeen: n.lastSeen || Date.now(),
            capabilities: n.capabilities || {},
            version: n.version,
            isLocal: n.isLocal || n.id === res.localNodeId,
          };
        }) as FederationNode[];
        
        // Initialize master workspace if not done (already done in connectedCallback but safe to check)
        if (!this.deviceWorkspaces.has('master')) {
          this.deviceWorkspaces.set('master', {
            canvases: [...this.gridState.canvases],
            activeCanvasId: this.gridState.activeCanvasId
          });
          this.saveDeviceWorkspaces();
        }
      }
      
      console.log("[Federation] Nodes loaded:", this.federationNodes.length, this.federationNodes);
    } catch (e) {
      console.log("Federation nodes not available:", e);
    } finally {
      this.federationLoading = false;
    }
  }
  
  private handleNodeChangeForGrid(nodeId: string) {
    if (nodeId === this.currentNodeId) return;
    
    this.currentNodeId = nodeId;
    
    // Dispatch event for any panels that need to know
    this.dispatchEvent(new CustomEvent("node-change", {
      detail: { nodeId },
      bubbles: true,
      composed: true,
    }));
  }
  
  private renderNodeSelectorForToolbar() {
    // Show if we have any nodes OR if loading (for debugging, show even with 1 node)
    if (this.federationNodes.length === 0 && !this.federationLoading) {
      return nothing;
    }

    return renderNodeSelector({
      nodes: this.federationNodes,
      currentNodeId: this.currentNodeId,
      localNodeId: this.localNodeId,
      loading: this.federationLoading,
      compact: true,
      onNodeSelect: (nodeId) => this.handleNodeChangeForGrid(nodeId),
      onRefresh: () => this.loadFederationNodesForGrid(),
    });
  }

  private getAvailableSessions(): AvailableSession[] {
    if (!this.sessions?.sessions) return [];
    
    return this.sessions.sessions.map((s: any) => ({
      key: s.key,
      title: this.extractSessionTitle(s),
      agentId: s.agentId || this.extractAgentId(s.key),
      lastActivity: s.lastActivity || s.updatedAt,
      messageCount: s.messageCount || 0,
      isActive: Boolean(s.isActive || (s.lastActivity && Date.now() - new Date(s.lastActivity).getTime() < 1000 * 60 * 30) || (s.updatedAt && Date.now() - s.updatedAt < 1000 * 60 * 30)),
      totalTokens: s.totalTokens || 0,
      model: s.model,
      channel: s.channel,
    }));
  }

  private extractAgentId(sessionKey: string): string {
    const parts = sessionKey.split(":");
    return parts[1] || "main";
  }

  private extractSessionTitle(session: any): string {
    if (session.label) return session.label;
    if (session.derivedTitle) return session.derivedTitle;
    
    const agentId = session.agentId || this.extractAgentId(session.key);
    const agentNames: Record<string, string> = {
      main: "🜂 Infini",
      coder: "💻 Code Architect",
      opus: "🧠 Deep Thinker",
      fast: "⚡ Quick Response",
    };
    
    if (agentNames[agentId]) {
      const timestamp = session.createdAt ? new Date(session.createdAt).toLocaleDateString() : "";
      return `${agentNames[agentId]}${timestamp ? ` (${timestamp})` : ""}`;
    }
    
    const parts = session.key.split(":");
    const lastPart = parts[parts.length - 1] || "Chat";
    
    if (lastPart.startsWith("webchat-")) {
      return `💬 Chat ${lastPart.slice(8, 12)}`;
    }
    
    return lastPart;
  }

  private handleSelectSession(session: AvailableSession) {
    const nodeId = session.nodeId ?? this.addPanelNodeId ?? "local";
    this.gridState = addSessionToGrid(this.gridState, { ...session, nodeId });
    this.showSessionPicker = false;
    this.dispatchStateChange();
  }

  private async handleNewSession() {
    // Generate a unique session key
    const newKey = `agent:main:webchat-${Date.now().toString(36)}`;
    
    // Add to grid immediately for responsiveness
    this.gridState = addSessionToGrid(this.gridState, {
      key: newKey,
      title: "💬 New Chat",
      agentId: "main",
      isActive: true,
      nodeId: this.addPanelNodeId || "local",
    });
    this.showSessionPicker = false;
    this.dispatchStateChange();

    // Dispatch event for parent to handle actual session creation
    this.dispatchEvent(
      new CustomEvent("new-session-created", {
        detail: { sessionKey: newKey },
        bubbles: true,
        composed: true,
      })
    );

    // Request a sessions refresh after a short delay
    setTimeout(() => {
      this.dispatchEvent(new CustomEvent("refresh-sessions", { bubbles: true, composed: true }));
    }, 500);
  }

  private handlePanelFocus(panelId: string) {
    this.gridState = focusPanel(this.gridState, panelId);
    this.dispatchStateChange();
  }

  private handlePanelClose(panelId: string) {
    // Release any cached view-adapter / agency-ops runtime for this panel.
    disposeAdapterPanel(panelId);
    this.gridState = removePanel(this.gridState, panelId);
    this.dispatchStateChange();
  }

  private handlePanelMinimize(panelId: string) {
    this.gridState = toggleMinimize(this.gridState, panelId);
    this.dispatchStateChange();
  }

  private handlePanelMaximize(panelId: string) {
    this.gridState = toggleMaximize(this.gridState, panelId);
    this.dispatchStateChange();
  }
  
  private handlePanelRename(panelId: string, detail: { sessionKey: string; newTitle: string }) {
    // Update the panel title locally
    const panelIndex = this.gridState.panels.findIndex(p => p.id === panelId);
    if (panelIndex >= 0) {
      this.gridState = {
        ...this.gridState,
        panels: this.gridState.panels.map((p, i) => 
          i === panelIndex ? { ...p, title: detail.newTitle } : p
        )
      };
      this.dispatchStateChange();
      saveLayoutToStorage(this.gridState);
    }
  }

  private handleDragStart(panelId: string, e: MouseEvent | TouchEvent) {
    e.preventDefault();
    const panel = this.gridState.panels.find((p) => p.id === panelId);
    if (!panel || panel.maximized) return;
    const pos = this.getEventPos(e);

    this.gridState = focusPanel(this.gridState, panelId);

    this.dragState = {
      panelId,
      startX: pos.x,
      startY: pos.y,
      startPanelX: panel.x,
      startPanelY: panel.y,
    };
  }

  private linkedResizeSnapshot: LinkedPanelSnapshot[] = [];

  private handleResizeStart(
    panelId: string,
    edge: ResizeState["edge"],
    e: MouseEvent | TouchEvent
  ) {
    e.preventDefault();
    e.stopPropagation();
    const panel = this.gridState.panels.find((p) => p.id === panelId);
    if (!panel || panel.maximized) return;
    const pos = this.getEventPos(e);

    // Snapshot any panel whose edge is glued to the edge we're dragging so
    // we can move them in lockstep — split-pane behavior.
    this.linkedResizeSnapshot = findLinkedPanels(this.gridState, panelId, edge);

    this.resizeState = {
      panelId,
      edge,
      startX: pos.x,
      startY: pos.y,
      startWidth: panel.width,
      startHeight: panel.height,
      startPanelX: panel.x,
      startPanelY: panel.y,
    };
  }

  private isPanelRecycleEligible(panel: GridPanel): boolean {
    if (this.gridState.activePanel === panel.id) return false;
    if (this.dragState?.panelId === panel.id || this.resizeState?.panelId === panel.id) return false;
    // xterm instances keep PTY/session state in the mounted component. Only
    // recycle terminal panels before a live terminal has been attached.
    if (panel.type === "terminal" && panel.terminalSessionId) return false;
    return true;
  }

  private ensurePanelRecycleObserver() {
    if (this.panelRecycleObserver || typeof IntersectionObserver === "undefined") return;
    this.panelRecycleObserver = new IntersectionObserver(
      (entries) => {
        let changed = false;
        const next = new Set(this.offscreenPanelIds);
        for (const entry of entries) {
          const panelId = (entry.target as HTMLElement).dataset.panelId;
          if (!panelId) continue;
          const panel = this.gridState.panels.find((p) => p.id === panelId);
          if (!panel || !this.isPanelRecycleEligible(panel) || entry.isIntersecting) {
            if (next.delete(panelId)) changed = true;
          } else if (!next.has(panelId)) {
            next.add(panelId);
            changed = true;
          }
        }
        if (changed) {
          this.offscreenPanelIds = next;
        }
      },
      { root: this.shadowRoot?.querySelector(".grid-workspace-with-sidebar") ?? null, rootMargin: "500px" },
    );
  }

  private syncPanelRecycleObserver() {
    this.ensurePanelRecycleObserver();
    if (!this.panelRecycleObserver) return;

    const nodes = Array.from(
      this.shadowRoot?.querySelectorAll<HTMLElement>(
        "masonry-panel, terminal-grid-panel, canvas-grid-panel, chart-grid-panel, video-grid-panel, gpu-grid-panel, .grid-panel-shell, .panel-recycle-placeholder",
      ) ?? [],
    );
    const next = new Map<string, Element>();
    for (const node of nodes) {
      const panelId = node.dataset.panelId || (node as unknown as { panel?: GridPanel }).panel?.id;
      if (!panelId) continue;
      node.dataset.panelId = panelId;
      next.set(panelId, node);
      if (this.observedPanelHosts.get(panelId) !== node) {
        const old = this.observedPanelHosts.get(panelId);
        if (old) this.panelRecycleObserver.unobserve(old);
        this.panelRecycleObserver.observe(node);
      }
    }

    for (const [panelId, node] of this.observedPanelHosts.entries()) {
      if (!next.has(panelId)) this.panelRecycleObserver.unobserve(node);
    }
    this.observedPanelHosts = next;

    const eligibleIds = new Set(this.gridState.panels.filter((p) => this.isPanelRecycleEligible(p)).map((p) => p.id));
    const cleaned = new Set(Array.from(this.offscreenPanelIds).filter((id) => eligibleIds.has(id)));
    if (cleaned.size !== this.offscreenPanelIds.size) {
      this.offscreenPanelIds = cleaned;
    }
  }

  private renderPanelRecyclePlaceholder(panel: GridPanel, styles: Record<string, string>) {
    return html`
      <div
        class="panel-recycle-placeholder"
        data-panel-id=${panel.id}
        style=${styleMap(styles)}
        @mousedown=${() => this.handlePanelFocus(panel.id)}
      >
        <div
          class="panel-recycle-placeholder__header"
          @mousedown=${(e: MouseEvent) => this.handleDragStart(panel.id, e)}
          @touchstart=${(e: TouchEvent) => this.handleDragStart(panel.id, e)}
        >
          <span>${panel.title || panel.type || "Panel"}</span>
          <span>${panel.type || "session"}</span>
        </div>
        <div class="panel-recycle-placeholder__body">
          <div></div>
          <div></div>
          <div></div>
        </div>
      </div>
    `;
  }

  private handleTileHorizontal() {
    this.gridState = tileHorizontal(this.gridState);
    this.dispatchStateChange();
  }

  private handleTileVertical() {
    this.gridState = tileVertical(this.gridState);
    this.dispatchStateChange();
  }

  private handleTileGrid() {
    this.gridState = tileGrid(this.gridState);
    this.dispatchStateChange();
  }

  private handleSetGridMode(mode: "free" | "snap" | "masonry") {
    this.gridState = setGridMode(this.gridState, mode);
    this.dispatchStateChange();
  }

  private handleResetLayout() {
    clearLayoutStorage();
    this.gridState = createMasonryGridState();
    this.dispatchStateChange();
  }

  // ============================================================
  // Canvas Tab Handlers
  // ============================================================

  private handleAddCanvas() {
    if (!canAddCanvas(this.gridState)) return;
    this.gridState = addCanvas(this.gridState);
    this.dispatchStateChange();
  }

  private handleSwitchCanvas(canvasId: string) {
    if (this.gridState.activeCanvasId === canvasId) return;
    this.gridState = switchCanvas(this.gridState, canvasId);
    this.dispatchStateChange();
  }

  private handleStartRenameCanvas(canvasId: string, e: Event) {
    e.stopPropagation();
    const canvas = this.gridState.canvases.find(c => c.id === canvasId);
    if (!canvas) return;
    this.renamingCanvasId = canvasId;
    this.renameCanvasValue = canvas.name;
  }

  private handleRenameCanvasInput(e: InputEvent) {
    this.renameCanvasValue = (e.target as HTMLInputElement).value;
  }

  private handleRenameCanvasKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      this.handleFinishRenameCanvas();
    } else if (e.key === "Escape") {
      this.renamingCanvasId = null;
    }
  }

  private handleFinishRenameCanvas() {
    if (this.renamingCanvasId && this.renameCanvasValue.trim()) {
      this.gridState = renameCanvas(this.gridState, this.renamingCanvasId, this.renameCanvasValue.trim());
      this.dispatchStateChange();
    }
    this.renamingCanvasId = null;
  }

  private handleDeleteCanvas(canvasId: string, e: Event) {
    e.stopPropagation();
    if (this.gridState.canvases.length <= 1) return;
    this.gridState = deleteCanvas(this.gridState, canvasId);
    this.dispatchStateChange();
  }

  private renderCanvasTabBar() {
    const canvases = this.gridState.canvases || [];
    const activeId = this.gridState.activeCanvasId;
    const canAdd = canAddCanvas(this.gridState);

    return html`
      <div class="canvas-tab-bar">
        ${repeat(canvases, c => c.id, (canvas) => {
          const isActive = canvas.id === activeId;
          const isRenaming = this.renamingCanvasId === canvas.id;
          const panelCount = canvas.panels.length;

          return html`
            <div 
              class="canvas-tab ${isActive ? 'active' : ''}"
              @click=${() => this.handleSwitchCanvas(canvas.id)}
              @dblclick=${(e: Event) => this.handleStartRenameCanvas(canvas.id, e)}
            >
              <span class="canvas-tab__icon">${canvas.icon}</span>
              ${isRenaming ? html`
                <input
                  type="text"
                  class="canvas-tab__rename-input"
                  .value=${this.renameCanvasValue}
                  @input=${this.handleRenameCanvasInput}
                  @keydown=${this.handleRenameCanvasKeydown}
                  @blur=${this.handleFinishRenameCanvas}
                  @click=${(e: Event) => e.stopPropagation()}
                  autofocus
                />
              ` : html`
                <span class="canvas-tab__name">${canvas.name}</span>
              `}
              ${panelCount > 0 ? html`
                <span class="canvas-tab__count">${panelCount}</span>
              ` : nothing}
              ${canvases.length > 1 ? html`
                <button 
                  class="canvas-tab__close"
                  @click=${(e: Event) => this.handleDeleteCanvas(canvas.id, e)}
                  title="Close canvas"
                >
                  <svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              ` : nothing}
            </div>
          `;
        })}
        <div class="canvas-tab-divider"></div>
        <button 
          class="canvas-tab-add"
          @click=${this.handleAddCanvas}
          ?disabled=${!canAdd}
          title=${canAdd ? "Add new canvas (max 5)" : "Maximum 5 canvases"}
        >
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    `;
  }

  render() {
    const visiblePanels = this.gridState.panels.filter((p) => !p.minimized);
    const minimizedPanels = this.gridState.panels.filter((p) => p.minimized);
    // The toolbar's workspace pills (1-5) are the active canvas switcher. Keep
    // the legacy tab strip disabled so the grid does not reserve a blank 40px
    // row between the toolbar and the panels.
    const showTabBar = false;
    // Reflect the state on the host so the `:host([data-has-tabs="false"])
    // .grid-layout { top: 48px }` rule reclaims those 40px.
    if (typeof this.setAttribute === "function") {
      this.setAttribute("data-has-tabs", showTabBar ? "true" : "false");
    }

    return html`
      <div class="grid-container">
        ${this.renderToolbar()}
        ${showTabBar ? this.renderCanvasTabBar() : nothing}
        <div class="grid-layout">
          ${this.renderSessionSidebar()}
          <div class="grid-workspace-with-sidebar">
            <!-- Grid overlay for snap mode -->
            ${this.gridState.gridMode === "snap" ? html`
              <div class="grid-overlay ${this.dragState || this.resizeState ? '' : 'hidden'}"></div>
            ` : nothing}
            
            <!-- Snap guides during drag -->
            ${this.snapGuides.length > 0 ? html`
              <div class="snap-guides">
                ${this.snapGuides.map(guide => html`
                  <div
                    class="snap-guide snap-guide--${guide.type}"
                    style="${guide.type === 'vertical'
                      ? `left: ${guide.position}px;`
                      : `top: ${guide.position}px;`}"
                  ></div>
                `)}
              </div>
            ` : nothing}

            <!-- Edge dock preview while dragging -->
            ${this.dockZone ? html`
              ${this.dockZone.targetRect ? html`
                <div class="dock-preview dock-preview--target"
                  style="left:${this.dockZone.targetRect.x}px;top:${this.dockZone.targetRect.y}px;width:${this.dockZone.targetRect.width}px;height:${this.dockZone.targetRect.height}px"></div>
              ` : nothing}
              <div class="dock-preview dock-preview--drop dock-preview--${this.dockZone.edge}"
                style="left:${this.dockZone.rect.x}px;top:${this.dockZone.rect.y}px;width:${this.dockZone.rect.width}px;height:${this.dockZone.rect.height}px">
                <span class="dock-preview-label">
                  ${this.dockZone.edge === 'center' ? 'Swap' :
                    this.dockZone.edge === 'n' ? 'Dock Top' :
                    this.dockZone.edge === 's' ? 'Dock Bottom' :
                    this.dockZone.edge === 'e' ? 'Dock Right' : 'Dock Left'}
                </span>
              </div>
            ` : nothing}
            
            ${visiblePanels.length === 0
              ? this.renderEmptyState()
              : repeat(
                  visiblePanels,
                  (p) => p.id,
                  (panel) => this.renderPanel(panel)
                )}
          </div>
          ${this.renderTaskSidebar()}
        </div>
        ${minimizedPanels.length > 0
          ? html`
              <div class="minimized-dock">
                ${repeat(
                  minimizedPanels,
                  (p) => p.id,
                  (panel) => {
                    // For terminal panels, always recompute the title from cli + terminalNodeId
                    // so stale stored titles ("▶ Claude") are ignored.
                    const tabLabel = panel.type === "terminal" && panel.terminalCli
                      ? formatTerminalTabTitle(
                          panel.terminalCli,
                          panel.terminalNodeId ?? panel.nodeId ?? "local",
                          this.getFederationNodeOptions(),
                        )
                      : (panel.title || panel.type);
                    return html`
                      <div
                        class="minimized-tab"
                        @click=${() => this.handlePanelMinimize(panel.id)}
                      >
                        <span>${tabLabel}</span>
                      </div>
                    `;
                  }
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderEmptyState() {
    return html`
      <div class="empty-state content-loaded">
        <div class="loading-fancy__spinner" style="margin-bottom: 8px; opacity: 0.3;">
          <div class="loading-fancy__ring"></div>
          <div class="loading-fancy__ring"></div>
          <div class="loading-fancy__ring"></div>
        </div>
        <svg viewBox="0 0 24 24" style="animation: pulse-glow 2s ease-in-out infinite;">
          <rect width="18" height="18" x="3" y="3" rx="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/>
          <line x1="3" y1="15" x2="21" y2="15"/>
          <line x1="9" y1="3" x2="9" y2="21"/>
          <line x1="15" y1="3" x2="15" y2="21"/>
        </svg>
        <h3>Multi-Session Grid</h3>
        <p>Click <span style="color: var(--g-primary);">"Sessions"</span> or <span style="color: var(--g-primary);">"+ Add Session"</span> to start</p>
      </div>
    `;
  }

  private handleToggleSidebar = () => {
    this.showSidebar = !this.showSidebar;
    if (this.showSidebar) {
      this.dispatchEvent(new CustomEvent("refresh-sessions", { bubbles: true, composed: true }));
    }
  };

  // AI IDE mode handlers
  private loadAiIdePreference(): boolean {
    try {
      const stored = localStorage.getItem("infinibot.grid.aiIdeEnabled");
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  }

  private saveAiIdePreference(enabled: boolean) {
    try {
      localStorage.setItem("infinibot.grid.aiIdeEnabled", String(enabled));
    } catch {
      // Ignore
    }
  }

  private handleToggleAiIde = () => {
    this.showAiIde = !this.showAiIde;
    this.saveAiIdePreference(this.showAiIde);
  };

  private handleFederationChange = (e: Event) => {
    const select = e.target as HTMLSelectElement;
    const newNode = select.value;
    
    if (newNode === this.selectedFederationNode) return;
    
    console.log(`[Federation] Switching from ${this.selectedFederationNode} to ${newNode}`);
    
    // Switch to the new device's workspace
    this.switchToDeviceWorkspace(newNode);
    
    // Update selected device
    this.selectedFederationNode = newNode;
    this.saveFederationDevice(newNode);
    
    // Dispatch event for session routing
    this.dispatchEvent(new CustomEvent("federation-change", {
      bubbles: true,
      composed: true,
      detail: { 
        node: newNode,
        isMaster: newNode === 'master',
        canvases: this.gridState.canvases,
        activeCanvasId: this.gridState.activeCanvasId
      }
    }));
  };

  private getPlatformIcon(platform?: string): string {
    switch (platform) {
      case 'ios': return '📱';
      case 'android': return '🤖';
      case 'macos': return '🍎';
      case 'windows': return '🪟';
      case 'linux': return '🐧';
      default: return '💻';
    }
  }

  private handleAddCanvasPanel = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("[Grid] Adding canvas panel, current panels:", this.gridState.panels.length);
    this.gridState = addCanvasPanel(this.gridState, "🎨 Canvas");
    console.log("[Grid] After adding, panels:", this.gridState.panels.length, this.gridState.panels);
    this.dispatchStateChange();
  };

  private handleAddChartPanel = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("[Grid] Adding chart panel, current panels:", this.gridState.panels.length);
    this.gridState = addChartPanel(this.gridState, "📊 Chart", "line");
    console.log("[Grid] After adding, panels:", this.gridState.panels.length, this.gridState.panels);
    this.dispatchStateChange();
  };

  private handleAddVideoPanel = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("[Grid] Adding video panel, current panels:", this.gridState.panels.length);
    this.gridState = addVideoPanel(this.gridState, "📹 Video Feed");
    console.log("[Grid] After adding, panels:", this.gridState.panels.length, this.gridState.panels);
    this.dispatchStateChange();
  };

  private handleAddGpuPanel = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("[Grid] Adding GPU animation panel, current panels:", this.gridState.panels.length);
    this.gridState = addGpuPanel(this.gridState, "✨ GPU Animations");
    console.log("[Grid] After adding, panels:", this.gridState.panels.length, this.gridState.panels);
    this.dispatchStateChange();
  };

  private handleToggleLayoutsMenu = (e: Event) => {
    e.stopPropagation();
    this.showLayoutsMenu = !this.showLayoutsMenu;
    if (this.showLayoutsMenu) {
      this.layoutPresets = listLayoutPresets(this.gridState.activeCanvasId);
    }
  };

  private handleSaveLayoutPreset = () => {
    const name = prompt("Save layout as:", `Layout ${new Date().toLocaleString()}`);
    if (!name) return;
    saveLayoutPreset(this.gridState, name);
    this.layoutPresets = listLayoutPresets(this.gridState.activeCanvasId);
  };

  private handleLoadLayoutPreset = (preset: LayoutPreset) => {
    this.gridState = loadLayoutPreset(this.gridState, preset);
    this.showLayoutsMenu = false;
    this.dispatchStateChange();
  };

  private handleDeleteLayoutPreset = (preset: LayoutPreset, e: Event) => {
    e.stopPropagation();
    if (!confirm(`Delete preset "${preset.name}"?`)) return;
    deleteLayoutPreset(preset.name, preset.canvasId);
    this.layoutPresets = listLayoutPresets(this.gridState.activeCanvasId);
  };

  private renderLayoutsMenu() {
    if (!this.showLayoutsMenu) return nothing;
    const presets = this.layoutPresets;
    return renderSharedLayoutsMenu({
      savedPresets: presets.map((p) => ({
        name: p.name,
        count: p.panels.length,
        savedAt: p.savedAt,
      })),
      labels: {
        quickSection: "Quick Layouts",
        currentSection: "Current Layout",
        save: "Save as preset…",
        savedSection: (n) => (n > 0 ? `Saved (${n})` : "No saved layouts"),
        deleteTitle: "Delete preset",
        countUnit: "panels",
      },
      onSave: () => this.handleSaveLayoutPreset(),
      onApply: (name) => {
        const preset = this.layoutPresets.find((p) => p.name === name);
        if (preset) this.handleLoadLayoutPreset(preset);
      },
      onDelete: (name, e) => {
        const preset = this.layoutPresets.find((p) => p.name === name);
        if (preset) this.handleDeleteLayoutPreset(preset, e);
      },
    });
  }

  private handleAddKanbanPanel = (projectId: string | null = null, projectName?: string) => {
    const title = projectName ? `🗂️ ${projectName}` : "🗂️ Kanban";
    this.gridState = addKanbanPanel(this.gridState, title, projectId);
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  private handleAddDatabasePanel = (databaseId: string | null = null, dbName?: string) => {
    const title = dbName ? `📚 ${dbName}` : "📚 Database";
    this.gridState = addDatabasePanel(this.gridState, title, databaseId);
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  private handleAddActivityPanel = () => {
    this.gridState = addActivityPanel(this.gridState, "⚡ Agent Feed");
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  private handleAddVoicePanel = () => {
    this.gridState = addVoicePanel(this.gridState, { title: "🎙️ Voice" });
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  private handleAddProjectsPanel = () => {
    this.gridState = addProjectsPanel(this.gridState, { title: "📁 Projects" });
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  private handleAddTasksPanel = () => {
    this.gridState = addTasksPanel(this.gridState, { title: "✅ Tasks" });
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  private handleAddKnowledgeGraphPanel = () => {
    this.gridState = addKnowledgeGraphPanel(this.gridState, { title: "🕸️ Knowledge Graph" });
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  private handleAddCreditsPanel = () => {
    this.gridState = addCreditsPanel(this.gridState, { title: "💎 Credit Usage" });
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  /** Add a generic view-adapter panel (notes / clients / reports / …). */
  private handleAddViewPanel = (entry: PanelCatalogEntry) => {
    this.gridState = addViewPanel(this.gridState, entry.ref, {
      title: `${entry.icon} ${entry.title}`,
      w: entry.w,
      h: entry.h,
    });
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  /** Add an Agency Operations Center tab scoped as a standalone tile. */
  private handleAddAgencyOpsPanel = (entry: PanelCatalogEntry) => {
    this.gridState = addAgencyOpsPanel(this.gridState, entry.ref, {
      title: `${entry.icon} ${entry.title}`,
      w: entry.w,
      h: entry.h,
    });
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  /**
   * Unified catalogue for the panel gallery. Combines native panel types with
   * the view-adapter and agency-ops definitions. `add` runs the right handler.
   */
  /**
   * Premium icon per panel, keyed by catalog entry id. Replaces the emoji in
   * the catalog `icon` field for the gallery cards — every panel gets a crisp
   * Lucide-style SVG from the shared `icons` set. Unmapped ids fall back to a
   * neutral layout glyph so a new panel never renders a broken tile.
   */
  private panelCardIcon(id: string): TemplateResult {
    const map: Record<string, keyof typeof icons> = {
      "native:voice": "mic",
      "native:session": "messageSquare",
      "native:terminal": "terminal",
      "native:kanban": "kanban",
      "native:projects": "folder",
      "native:tasks": "checkCircle",
      "native:knowledgeGraph": "network",
      "native:database": "database",
      "native:activity": "activity",
      "native:credits": "dollarSign",
      "native:chart": "barChart",
      "native:canvas": "palette",
      "native:video": "video",
      "native:gpu": "sparkles",
      "view:notes": "penLine",
      "view:research": "search",
      "view:clients": "users",
      "view:funnels": "filter",
      "view:autonomy": "bot",
      "view:agentActivity": "radio",
      "view:reports": "fileText",
      "view:business": "briefcase",
      "agencyOps:overview": "sliders",
      "agencyOps:allocation": "barChart",
      "agencyOps:approvals": "checkCircle",
      "agencyOps:activity": "scrollText",
      "agencyOps:employees": "users",
    };
    return icons[map[id] ?? "layout"];
  }

  private getPanelCatalog(): Array<
    PanelCatalogEntry & { add: () => void; disabled?: boolean; keywords?: string }
  > {
    const native = (
      id: string,
      title: string,
      description: string,
      icon: string,
      category: PanelCategory,
      add: () => void,
      keywords = "",
    ): PanelCatalogEntry & { add: () => void; keywords?: string } => ({
      id,
      title,
      description,
      icon,
      category,
      kind: "native",
      ref: id,
      add,
      keywords,
    });

    const nativeEntries = [
      native("native:voice", "Voice Cockpit", "Live transcript, route toggle, mic + playback controls.", "🎙️", "Voice", () => this.handleAddVoicePanel(), "microphone speech stt tts"),
      native("native:session", "Chat Session", "A conversational agent chat panel.", "💬", "Agents", () => this.handleAddChatSessionPanel(), "message conversation"),
      native("native:terminal", "Terminal", "Shell or coding-CLI terminal (Claude / Codex / …).", "▶", "Agents", () => this.handleAddTerminalPanel("shell"), "cli claude codex opencode gemini ollama shell"),
      native("native:kanban", "Kanban", "Project + task board (gallery or single project).", "🗂️", "Work", () => this.handleAddKanbanPanel(null), "board tasks projects"),
      native("native:projects", "Projects", "Projects gallery with content editor parity.", "📁", "Work", () => this.handleAddProjectsPanel(), "kanban"),
      native("native:tasks", "Tasks", "Task list scoped to a project.", "✅", "Work", () => this.handleAddTasksPanel(), "todo"),
      native("native:knowledgeGraph", "Knowledge Graph", "Live knowledge graph visualization.", "🕸️", "Data", () => this.handleAddKnowledgeGraphPanel(), "graph nodes"),
      native("native:database", "Database", "Browse a database / table.", "📚", "Data", () => this.handleAddDatabasePanel(null), "table records"),
      native("native:activity", "Activity Feed", "Compact live agent activity feed.", "⚡", "Agents", () => this.handleAddActivityPanel(), "events log"),
      native("native:credits", "Credit Usage", "Credit + token usage breakdown.", "💎", "Data", () => this.handleAddCreditsPanel(), "cost tokens billing"),
      native("native:chart", "Chart", "Time-series / metric chart.", "📊", "Data", () => this.handleAddChartPanel(new Event("x")), "metric graph line"),
      ...(isTabAvailable("whiteboard") ? [native("native:canvas", "Canvas", "Freeform drawing / whiteboard canvas.", "🎨", "Media", () => this.handleAddCanvasPanel(new Event("x")), "whiteboard draw excalidraw")] : []),
      native("native:video", "Video Feed", "Live video feed panel.", "📹", "Media", () => this.handleAddVideoPanel(new Event("x")), "camera stream"),
      native("native:gpu", "GPU Animations", "GPU particle / animation showcase.", "✨", "Media", () => this.handleAddGpuPanel(new Event("x")), "particles fx"),
    ];

    const viewEntries = VIEW_PANEL_DEFS.map((e) => ({
      ...e,
      add: () => this.handleAddViewPanel(e),
    }));
    const opsEntries = AGENCY_OPS_TAB_DEFS.map((e) => ({
      ...e,
      add: () => this.handleAddAgencyOpsPanel(e),
    }));

    return [...nativeEntries, ...viewEntries, ...opsEntries];
  }

  /** Add a fresh chat-session panel (spawns a new session key). */
  private handleAddChatSessionPanel = () => {
    const key = `grid-session-${Date.now()}`;
    this.gridState = addPanel(this.gridState, key, "💬 Chat");
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  /**
   * Per-panel refresh — invoked from the panel chrome refresh button and from
   * the A4 control-bus when the agent issues a `grid.refresh` verb. Flips the
   * panel's `needsRefresh` flag and dispatches the global refresh event so
   * the A3 panel renderers re-fetch their data.
   */
  private handlePanelRefresh = (panelId: string) => {
    this.gridState = refreshGridPanel(this.gridState, panelId);
    this.dispatchStateChange();
  };

  /**
   * Window-level handler for `GRID_PANEL_REFRESH_EVENT`. The refresh dispatch
   * already triggers the A3 panel renderers via their internal listener; this
   * handler just clears `needsRefresh` after one paint so the flag doesn't
   * stick across reloads.
   */
  private handleGridPanelRefresh = (e: Event) => {
    const detail = (e as CustomEvent<GridPanelRefreshDetail>).detail;
    if (!detail?.panelId) return;
    // Clear on the next microtask so the renderer sees `needsRefresh=true`
    // for at least one frame, then flips back.
    queueMicrotask(() => {
      this.gridState = clearNeedsRefresh(this.gridState, detail.panelId);
      this.requestUpdate();
    });
  };

  private handleAddTerminalPanel = (
    cli: "claude" | "opencode" | "gemini" | "codex" | "grok" | "ollama" | "shell" = "shell",
  ) => {
    // Forward the user's add-panel device choice so the new terminal
    // spawns on the right federation node on first attach.
    const nodeId = this.addPanelNodeId || "local";
    const title = formatTerminalTabTitle(cli, nodeId, this.getFederationNodeOptions());
    this.gridState = addTerminalPanel(
      this.gridState,
      title,
      cli,
      "",
      nodeId,
    );
    this.showAddPanelMenu = false;
    this.dispatchStateChange();
  };

  private setAddPanelNodeId(nodeId: string) {
    this.addPanelNodeId = nodeId || "local";
    try {
      localStorage.setItem("infinibot:grid:addPanelNodeId", this.addPanelNodeId);
    } catch { /* ignore */ }
  }

  private getFederationNodeOptions(): FedNodeOption[] {
    // Prefer the grid's own federationNodes (loaded eagerly on mount).
    // Fall back to whatever /terminals or /federation cached if the grid
    // is rendered before the grid's own load completes. Always return at
    // least the synthetic "local" entry so the picker is never empty.
    if (this.federationNodes && this.federationNodes.length > 0) {
      return this.federationNodes.map((n) => ({
        id: n.id,
        name: n.name,
        isLocal: n.isLocal,
        online: n.status !== "offline",
        hostname: n.hostname,
      }));
    }
    const ts = (this.appState?.terminalsState ?? null) as
      | { federationNodes?: FedNodeOption[] }
      | null;
    if (ts?.federationNodes && ts.federationNodes.length > 0) {
      return ts.federationNodes;
    }
    const fed = (this.appState?.federationState ?? null) as
      | { nodes?: Array<{ id: string; name: string; isLocal?: boolean; status?: string; hostname?: string }> }
      | null;
    if (fed?.nodes && fed.nodes.length > 0) {
      return fed.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        isLocal: n.isLocal,
        online: n.status !== "offline",
        hostname: n.hostname,
      }));
    }
    return [{ id: "local", name: "This Device", isLocal: true, online: true }];
  }

  private handleUpdatePanelMeta = (panelId: string, patch: Partial<GridPanel>) => {
    this.gridState = updatePanelMeta(this.gridState, panelId, patch);
    this.dispatchStateChange();
  };

  // Bridge for the window-dispatched variant used by the function-based
  // grid panels (projects/kanban/tasks). They send `{ panelId, patch }` as
  // detail because they don't have access to a panel-scoped Lit host.
  private handleWindowPanelMetaUpdate = (evt: CustomEvent<{ panelId: string; patch: Partial<GridPanel> }>) => {
    const detail = evt.detail;
    if (!detail?.panelId || !detail.patch) return;
    // Ignore events for panels this grid doesn't own — multiple masonry
    // grids could theoretically coexist on the page.
    if (!this.gridState.panels.some((p) => p.id === detail.panelId)) return;
    this.handleUpdatePanelMeta(detail.panelId, detail.patch);
    this.requestUpdate();
  };

  /**
   * The gallery is right-aligned to its trigger (right: 0, up to 92vw wide). On
   * a phone the trigger sits mid-toolbar, so the gallery ran off the left edge
   * and cut off the first CLI buttons. Shift it back inside the viewport.
   */
  private keepPanelGalleryOnScreen() {
    const g = this.shadowRoot?.querySelector<HTMLElement>(".panel-gallery");
    if (!g) return;
    g.style.right = "";
    const margin = 8;
    const r = g.getBoundingClientRect();
    if (r.left < margin) g.style.right = `${r.left - margin}px`;
    else if (r.right > window.innerWidth - margin) {
      g.style.right = `${r.right - (window.innerWidth - margin)}px`;
    }
  }

  private handleToggleAddPanelMenu = (e: Event) => {
    e.stopPropagation();
    this.showAddPanelMenu = !this.showAddPanelMenu;
  };

  private renderAddPanelMenu() {
    if (!this.showAddPanelMenu) return nothing;

    const catalog = this.getPanelCatalog();
    const q = this.addPanelSearch.trim().toLowerCase();
    const cats: PanelCategory[] = ["Ops", "Agents", "Data", "Media", "Voice", "Work"];
    const activeCat = this.addPanelCategory;

    const matches = catalog.filter((e) => {
      if (activeCat && e.category !== activeCat) return false;
      if (!q) return true;
      const hay = `${e.title} ${e.description} ${e.category} ${(e as any).keywords ?? ""}`.toLowerCase();
      return hay.includes(q);
    });

    // Group filtered results by category, preserving the chip order.
    const grouped = cats
      .map((c) => ({ cat: c, items: matches.filter((e) => e.category === c) }))
      .filter((g) => g.items.length > 0);

    return html`
      <div class="panel-gallery" @click=${(e: Event) => e.stopPropagation()}>
        <div class="panel-gallery__head">
          <div class="panel-gallery__title">Add a panel</div>
          <input
            class="panel-gallery__search"
            type="text"
            placeholder="Search panels…"
            .value=${this.addPanelSearch}
            @input=${(e: Event) => { this.addPanelSearch = (e.target as HTMLInputElement).value; }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && matches.length) { matches[0].add(); }
              if (e.key === "Escape") { this.showAddPanelMenu = false; }
            }}
          />
          <button
            class="panel-gallery__close"
            title="Close"
            @click=${() => { this.showAddPanelMenu = false; }}
          >✕</button>
        </div>

        <div class="panel-gallery__chips">
          <button
            class=${"pg-chip " + (activeCat === "" ? "active" : "")}
            @click=${() => { this.addPanelCategory = ""; }}
          >All</button>
          ${cats.map((c) => html`
            <button
              class=${"pg-chip " + (activeCat === c ? "active" : "")}
              @click=${() => { this.addPanelCategory = c; }}
            >${c}</button>
          `)}
        </div>

        <div class="panel-gallery__body">
          ${grouped.length === 0
            ? html`<div class="panel-gallery__empty">No panels match “${this.addPanelSearch}”.</div>`
            : grouped.map((g) => html`
              <div class="panel-gallery__group-label">${g.cat}</div>
              <div class="panel-gallery__grid">
                ${g.items.map((e) => html`
                  <button
                    class="pg-card"
                    ?disabled=${(e as any).disabled}
                    title=${e.description}
                    @click=${() => e.add()}
                  >
                    <span class="pg-card__icon">${this.panelCardIcon(e.id)}</span>
                    <span class="pg-card__title">${e.title}</span>
                    <span class="pg-card__desc">${e.description}</span>
                  </button>
                `)}
              </div>
            `)}
        </div>

        ${activeCat === "" || activeCat === "Agents"
          ? html`
            <div class="panel-gallery__foot">
              <span class="panel-gallery__foot-label">Terminal spawn target</span>
              ${renderFederationNodeSelect({
                value: this.addPanelNodeId,
                nodes: this.getFederationNodeOptions(),
                onChange: (id) => this.setAddPanelNodeId(id),
                label: "",
                compact: true,
              })}
              <div class="panel-gallery__cli">
                ${(["shell", "claude", "opencode", "gemini", "codex", "grok"] as const).map((cli) => html`
                  <button class="pg-cli-btn" @click=${() => this.handleAddTerminalPanel(cli)}>${cli}</button>
                `)}
                ${(() => {
                  const node = this.getFederationNodeOptions().find((n) => n.id === this.addPanelNodeId);
                  const hasOllama = nodeHasOllama(node);
                  return html`<button
                    class="pg-cli-btn"
                    ?disabled=${!hasOllama}
                    title=${hasOllama ? "Ollama" : "Ollama not installed on this device"}
                    @click=${() => { if (hasOllama) this.handleAddTerminalPanel("ollama"); }}
                  >ollama</button>`;
                })()}
              </div>
            </div>
          `
          : nothing}
      </div>
    `;
  }

  private handleWorkspaceClick = (num: number) => {
    const canvasIndex = num - 1;
    const existingCanvas = this.gridState.canvases?.[canvasIndex];
    
    if (existingCanvas) {
      // Switch to existing workspace
      this.gridState = switchCanvas(this.gridState, existingCanvas.id);
    } else {
      // Create new workspaces up to this index, then switch to the last created
      let lastCreatedId = this.gridState.activeCanvasId;
      while (this.gridState.canvases.length < num && canAddCanvas(this.gridState)) {
        this.gridState = addCanvas(this.gridState);
        lastCreatedId = this.gridState.activeCanvasId; // addCanvas already switches
      }
    }
    this.dispatchStateChange();
  };

  private handleToggleFullscreen = async () => {
    // Use CSS-only fullscreen (no browser API) to avoid ::backdrop black background
    // This allows the terminal animation to show through
    this.isFullscreen = !this.isFullscreen;
    if (this.isFullscreen) {
      this.showSidebar = false;
      this.showTaskSidebar = false;
    }
    
    // Dispatch event so parent can hide nav/header
    this.dispatchEvent(new CustomEvent("fullscreen-change", { 
      bubbles: true, 
      composed: true,
      detail: { fullscreen: this.isFullscreen }
    }));
    
    // Auto-tile panels to fit screen when entering fullscreen
    if (this.isFullscreen) {
      requestAnimationFrame(() => {
        setTimeout(() => {
          const rect = this.getBoundingClientRect();
          const toolbarHeight = 36;
          const newHeight = rect.height - toolbarHeight;
          const newWidth = rect.width;
          this.gridState = updateContainerSize(this.gridState, newWidth, newHeight);
          this.gridState = tileGrid(this.gridState);
          this.dispatchStateChange();
        }, 100);
      });
    }
  };

  private handleFullscreenChange = () => {
    const isBrowserFullscreen = !!document.fullscreenElement;
    if (this.isFullscreen !== isBrowserFullscreen) {
      this.isFullscreen = isBrowserFullscreen;
      this.dispatchEvent(new CustomEvent("fullscreen-change", { 
        bubbles: true, 
        composed: true,
        detail: { fullscreen: this.isFullscreen }
      }));
    }
  };

  private handleKeydown = (e: KeyboardEvent) => {
    // F11 or Ctrl/Cmd+Shift+F for fullscreen toggle
    if (e.key === "F11" || (e.key === "f" && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
      e.preventDefault();
      this.handleToggleFullscreen();
      return;
    }
    
    // ESC to exit fullscreen (browser handles this, but we track state)
    if (e.key === "Escape" && this.isFullscreen) {
      // Browser will exit fullscreen, our change handler will update state
      return;
    }
  };

  private renderToolbar() {
    return html`
      <div class="grid-toolbar">
        <!-- Mobile Header: Title + Fullscreen -->
        <div class="mobile-header">
          <span class="mobile-header-title">Multi Panel</span>
          <button
            class="mobile-fullscreen-btn ${this.isFullscreen ? 'active' : ''}"
            title="${this.isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}"
            @click=${this.handleToggleFullscreen}
          >
            ${this.isFullscreen 
              ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
                </svg>`
              : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                </svg>`
            }
          </button>
        </div>

        <!-- LEFT SIDE: Sessions, Layout, Tile controls -->
        <button
          class="sidebar-toggle-btn ${this.showSidebar ? 'active' : ''}"
          title="${this.showSidebar ? 'Hide Sessions' : 'Show Sessions'}"
          @click=${this.handleToggleSidebar}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="7" height="18" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          <span>Sessions</span>
        </button>

        <div class="toolbar-divider"></div>

        <div class="toolbar-group">
          <button
            class="toolbar-btn ${this.gridState.gridMode === "free" ? "active" : ""}"
            title="Free Position"
            @click=${() => this.handleSetGridMode("free")}
          >
            ${icons.move}
          </button>
          <button
            class="toolbar-btn ${this.gridState.gridMode === "snap" ? "active" : ""}"
            title="Snap to Grid"
            @click=${() => this.handleSetGridMode("snap")}
          >
            ${icons.grid}
          </button>
          <button
            class="toolbar-btn ${this.gridState.gridMode === "masonry" ? "active" : ""}"
            title="Masonry Layout"
            @click=${() => this.handleSetGridMode("masonry")}
          >
            ${icons.layout}
          </button>
        </div>

        <div class="toolbar-divider"></div>

        ${renderAutoLayoutButtons({
          onTileHorizontal: this.handleTileHorizontal,
          onTileVertical: this.handleTileVertical,
          onTileGrid: this.handleTileGrid,
        })}

        <div class="toolbar-divider"></div>

        <button class="toolbar-btn" title="Reset Layout" @click=${this.handleResetLayout}>
          ${icons.refresh}
        </button>

        <div class="layouts-dropdown-wrapper">
          <button
            class="toolbar-btn ${this.showLayoutsMenu ? 'active' : ''}"
            title="Saved layout presets"
            @click=${this.handleToggleLayoutsMenu}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="7" height="7" rx="1"/>
              <rect x="14" y="3" width="7" height="7" rx="1"/>
              <rect x="3" y="14" width="7" height="7" rx="1"/>
              <rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
          </button>
          ${this.renderLayoutsMenu()}
        </div>

        <!-- Federation Node Selector -->
        ${this.renderNodeSelectorForToolbar()}

        <!-- SPACER - pushes remaining items to right -->
        <div class="toolbar-spacer"></div>

        <!-- RIGHT SIDE: Panel count, New, Browse, Tasks, IDE, Canvas, Chart, Workspaces, Voice, Fullscreen -->
        <div class="panel-count">
          ${this.gridState.panels.length} session${this.gridState.panels.length !== 1 ? "s" : ""}
        </div>

        <button class="new-session-toolbar-btn" @click=${this.handleNewSession} title="Create new chat session">
          ${icons.plus}
          <span>New</span>
        </button>

        <div class="session-picker-wrapper">
          <button class="add-session-btn" @click=${this.handleToggleSessionPicker}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
              <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
            <span>Browse</span>
          </button>
          ${this.showSessionPicker ? this.renderSessionPicker() : nothing}
        </div>

        <div class="toolbar-divider"></div>

        <!-- Task Sidebar Toggle -->
        <button
          class="sidebar-toggle-btn ${this.showTaskSidebar ? 'active' : ''}"
          title="${this.showTaskSidebar ? 'Hide Tasks' : 'Show Tasks'}"
          @click=${this.handleToggleTaskSidebar}
          style="position: relative;"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span>Tasks</span>
          ${this.getActiveTaskCountDisplay()}
        </button>

        <!-- AI IDE Toggle -->
        <button
          class="sidebar-toggle-btn ${this.showAiIde ? 'active' : ''}"
          title="${this.showAiIde ? 'Hide AI IDE Panel' : 'Show AI IDE Panel'}"
          @click=${this.handleToggleAiIde}
          style="position: relative;"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="16 18 22 12 16 6"/>
            <polyline points="8 6 2 12 8 18"/>
            <line x1="12" y1="2" x2="12" y2="22" stroke-dasharray="2 2"/>
          </svg>
          <span>IDE</span>
        </button>

        <div class="toolbar-divider"></div>

        <!-- Add Panel Dropdown — replaces individual Canvas/Chart/Video/GPU buttons -->
        <div class="add-panel-dropdown-wrapper">
          <button
            class="add-panel-btn add-panel-trigger ${this.showAddPanelMenu ? 'open' : ''}"
            title="Add panel (canvas, chart, video, GPU, kanban, database, terminal)"
            @click=${this.handleToggleAddPanelMenu}
            style="border-color: color-mix(in srgb, var(--g-primary) 50%, transparent); background: color-mix(in srgb, var(--g-primary) 12%, transparent);"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span>Add Panel</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
                 style="width:10px;height:10px;margin-left:2px;${this.showAddPanelMenu ? 'transform:rotate(180deg);' : ''}transition:transform 0.15s;">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          ${this.renderAddPanelMenu()}
        </div>

        <div class="toolbar-divider"></div>

        <!-- Federation Device Selector -->
        <div class="federation-selector">
          <select 
            class="federation-dropdown"
            @change=${this.handleFederationChange}
            title="Select federation device for workspace"
          >
            <option value="master" ?selected=${this.selectedFederationNode === 'master'}>
              Master (Local)
            </option>
            ${this.federationNodes.map(node => html`
              <option value="${node.id}" ?selected=${this.selectedFederationNode === node.id}>
                ${this.getPlatformIcon(node.platform)} ${node.name}
              </option>
            `)}
          </select>
          <span class="federation-label">Federation</span>
        </div>

        <div class="toolbar-divider"></div>

        <!-- Workspace Tabs 1-5 (per federation device) -->
        <div class="toolbar-group workspace-tabs">
          ${[1, 2, 3, 4, 5].map(num => {
            const canvasIndex = num - 1;
            const canvas = this.gridState.canvases?.[canvasIndex];
            const isActive = canvas?.id === this.gridState.activeCanvasId;
            const exists = !!canvas;
            const panelCount = canvas?.panels?.length || 0;
            
            return html`
              <button
                class="workspace-btn ${isActive ? 'active' : ''} ${!exists ? 'empty' : ''}"
                title="${exists ? `${canvas.name} (${panelCount} panels)` : `Create Workspace ${num}`}"
                @click=${() => this.handleWorkspaceClick(num)}
              >
                <span class="workspace-num">${num}</span>
                ${exists && panelCount > 0 ? html`<span class="workspace-count">${panelCount}</span>` : nothing}
              </button>
            `;
          })}
        </div>

        <div class="toolbar-divider"></div>

        <!-- Centralized Voice Controls -->
        ${this.renderVoiceControls()}

        <div class="toolbar-divider"></div>

        <!-- Fullscreen Toggle -->
        <button
          class="toolbar-btn fullscreen-btn ${this.isFullscreen ? 'active' : ''}"
          title="${this.isFullscreen ? 'Exit Fullscreen (ESC or F11)' : 'Fullscreen Mode (F11)'}"
          @click=${this.handleToggleFullscreen}
          style="position: relative;"
        >
          ${this.isFullscreen 
            ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
              </svg>`
            : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
              </svg>`
          }
        </button>
      </div>
    `;
  }

  // ============================================================
  // Voice Controls - Centralized voice input for all panels
  // ============================================================
  
  /** The Grid's mic button starts a voice call (local voice by default; Cloud voice (Robovoice) only if the user picked it). */
  private renderVoiceControls() {
    return html`
      <div class="voice-controls-wrapper">
        <button
          class="voice-toggle-btn"
          title="Voice — start a call"
          aria-label="Voice"
          @click=${() => startRobovoiceVoiceCall({ source: "grid" })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" x2="12" y1="19" y2="23"/>
            <line x1="8" x2="16" y1="23" y2="23"/>
          </svg>
        </button>
      </div>
    `;
  }

  private getActiveTaskCountDisplay() {
    const activeCount = getActiveTaskCount(this.taskState);
    if (activeCount === 0) return nothing;
    return html`
      <span style="
        position: absolute;
        top: 2px;
        right: 2px;
        min-width: 14px;
        height: 14px;
        padding: 0 3px;
        background: #22c55e;
        color: #000;
        font-size: 8px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 0 4px rgba(34, 197, 94, 0.5);
        animation: ap-pulse 2s infinite;
      ">${activeCount}</span>
    `;
  }

  private handleToggleTaskSidebar = () => {
    this.showTaskSidebar = !this.showTaskSidebar;
    if (this.showTaskSidebar && this.client) {
      // Start polling when sidebar opens
      startTaskPolling(
        this.taskState,
        this.client,
        () => this.gridState.panels.map(p => p.sessionKey),
        () => this.requestUpdate()
      );
    } else {
      // Stop polling when sidebar closes
      stopTaskPolling(this.taskState);
    }
  };

  private renderSessionPicker() {
    const existingKeys = new Set(this.gridState.panels.map(p => p.sessionKey));
    const allSessions = this.getAvailableSessions();
    const activeSessions = allSessions.filter(s => s.isActive && !existingKeys.has(s.key));
    const recentSessions = allSessions.filter(s => !s.isActive && !existingKeys.has(s.key));
    const isLoading = !this.sessions;

    return html`
      <div class="session-picker" @click=${(e: Event) => e.stopPropagation()}>
        <div class="session-picker-header">
          <h4>Add Session</h4>
          <button class="session-picker-close" @click=${() => this.showSessionPicker = false}>
            ${icons.x}
          </button>
        </div>
        <div class="session-picker-content">
          ${isLoading
            ? html`
                <div class="sidebar-skeleton">
                  ${[1, 2, 3].map(() => html`
                    <div class="skeleton-session">
                      <div class="skeleton skeleton-session__avatar"></div>
                      <div class="skeleton-session__content">
                        <div class="skeleton skeleton-session__title"></div>
                        <div class="skeleton skeleton-session__meta"></div>
                      </div>
                    </div>
                  `)}
                </div>
              `
            : html`
                ${activeSessions.length > 0 ? html`
                  <div class="session-picker-section content-loaded">
                    <div class="session-picker-section-title">Active Sessions</div>
                    ${activeSessions.map(s => this.renderSessionItem(s, true))}
                  </div>
                ` : nothing}

                ${recentSessions.length > 0 ? html`
                  <div class="session-picker-section">
                    <div class="session-picker-section-title">Recent Sessions</div>
                    ${recentSessions.slice(0, 10).map(s => this.renderSessionItem(s, false))}
                  </div>
                ` : nothing}

                ${activeSessions.length === 0 && recentSessions.length === 0 ? html`
                  <div class="loading-sessions" style="color: var(--c-text-3);">
                    No other sessions available
                  </div>
                ` : nothing}

                <button class="new-session-btn" @click=${this.handleNewSession}>
                  ${icons.plus}
                  <span>New Chat Session</span>
                </button>
              `
          }
        </div>
      </div>
    `;
  }

  private renderSessionItem(session: AvailableSession, isActive: boolean) {
    const icon = this.getAgentIcon(session.agentId);
    return html`
      <div class="session-item ${isActive ? 'active' : ''}" @click=${() => this.handleSelectSession(session)}>
        <div class="session-item-icon">${icon}</div>
        <div class="session-item-info">
          <div class="session-item-title">${session.title}</div>
          <div class="session-item-meta">
            ${session.messageCount ? `${session.messageCount} messages` : "No messages"}
          </div>
        </div>
        ${isActive ? html`<span class="session-item-badge">Active</span>` : nothing}
      </div>
    `;
  }

  private getAgentIcon(agentId: string): string {
    const iconMap: Record<string, string> = { main: "🜂", coder: "💻", opus: "🧠", fast: "⚡" };
    return iconMap[agentId] || "💬";
  }

  private getChannelIcon(channel?: string): string {
    switch (channel) {
      case "whatsapp": return "📱";
      case "telegram": return "✈️";
      case "discord": return "🎮";
      case "signal": return "🔒";
      case "slack": return "💼";
      case "webchat": return "🌐";
      case "imessage": return "💬";
      default: return "⚡";
    }
  }

  private formatRelativeTime(ts: number | string | null | undefined): string {
    if (!ts) return "—";
    const time = typeof ts === "string" ? new Date(ts).getTime() : ts;
    const ms = Date.now() - time;
    if (ms < 0) return "just now";
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) {
      const m = Math.floor(ms / 60_000);
      return `${m}m ago`;
    }
    if (ms < 86_400_000) {
      const h = Math.floor(ms / 3_600_000);
      return `${h}h ago`;
    }
    const d = Math.floor(ms / 86_400_000);
    return `${d}d ago`;
  }

  private renderSessionSidebar() {
    if (!this.showSidebar) {
      return html`<div class="session-sidebar collapsed"></div>`;
    }

    const existingKeys = new Set(this.gridState.panels.map(p => p.sessionKey));
    const allSessions = this.getAvailableSessions();
    const sessionMap = new Map(allSessions.map(s => [s.key, s]));
    const isLoading = !this.sessions;
    const totalSessions = allSessions.length;

    // Get categorized sessions
    const categorizedKeys = new Set<string>();
    for (const cat of this.sidebarState.categories) {
      for (const itemId of cat.itemIds) {
        categorizedKeys.add(itemId);
      }
    }

    // Uncategorized = sessions not in any category
    const uncategorizedSessions = allSessions.filter(s => !categorizedKeys.has(s.key));

    return html`
      <div class="session-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-header__title">Sessions</span>
          <span class="sidebar-header__count">${totalSessions}</span>
        </div>
        <div class="sidebar-content">
          ${isLoading
            ? html`
                <div class="sidebar-skeleton">
                  ${[1, 2, 3].map(() => html`
                    <div class="sidebar-skeleton__category">
                      <div class="sidebar-skeleton__header">
                        <div class="skeleton sidebar-skeleton__chevron"></div>
                        <div class="skeleton sidebar-skeleton__name"></div>
                      </div>
                      ${[1, 2].map(() => html`
                        <div class="skeleton-session" style="margin-left: 8px;">
                          <div class="skeleton skeleton-session__avatar" style="width: 24px; height: 24px;"></div>
                          <div class="skeleton-session__content">
                            <div class="skeleton skeleton-session__title"></div>
                            <div class="skeleton skeleton-session__meta"></div>
                          </div>
                        </div>
                      `)}
                    </div>
                  `)}
                </div>
              `
            : html`
                <!-- New category input -->
                ${this.showNewCategoryInput ? html`
                  <div class="sidebar-new-category">
                    <input
                      class="sidebar-new-category__input"
                      type="text"
                      placeholder="Category name..."
                      .value=${this.newCategoryName}
                      @input=${(e: Event) => this.newCategoryName = (e.target as HTMLInputElement).value}
                      @keydown=${(e: KeyboardEvent) => {
                        if (e.key === 'Enter') this.handleCreateCategory();
                        if (e.key === 'Escape') this.showNewCategoryInput = false;
                      }}
                    />
                    <button class="sidebar-new-category__btn" @click=${this.handleCreateCategory}>Add</button>
                    <button class="sidebar-new-category__btn cancel" @click=${() => this.showNewCategoryInput = false}>✕</button>
                  </div>
                ` : nothing}

                <!-- Categories -->
                ${this.sidebarState.categories.map(cat => 
                  this.renderCategory(cat, sessionMap, existingKeys)
                )}

                <!-- Uncategorized sessions -->
                ${uncategorizedSessions.length > 0 ? html`
                  <div class="sidebar-section" 
                    @dragover=${(e: DragEvent) => this.handleDragOver(e, 'uncategorized', uncategorizedSessions.length)}
                    @drop=${(e: DragEvent) => this.handleDrop(e, 'uncategorized')}>
                    <div class="sidebar-section__title">Uncategorized</div>
                    ${uncategorizedSessions.map((s, idx) => this.renderDraggableSession(s, existingKeys.has(s.key), null, idx))}
                  </div>
                ` : nothing}

                <!-- Add category button -->
                <button class="sidebar-add-category" @click=${() => this.showNewCategoryInput = true}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  <span>Add Category</span>
                </button>

                <!-- New session button -->
                <button class="sidebar-new-session" @click=${this.handleNewSession}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  <span>New Session</span>
                </button>
              `
          }
        </div>
      </div>
    `;
  }

  private renderCategory(cat: SidebarCategory, sessionMap: Map<string, AvailableSession>, existingKeys: Set<string>) {
    const sessions = cat.itemIds
      .map(id => sessionMap.get(id))
      .filter((s): s is AvailableSession => !!s);
    const itemCount = sessions.length;

    return html`
      <div class="sidebar-category"
        @dragover=${(e: DragEvent) => this.handleDragOver(e, cat.id, itemCount)}
        @drop=${(e: DragEvent) => this.handleDrop(e, cat.id)}>
        <div class="sidebar-category__header" @click=${() => this.handleToggleCategory(cat.id)}>
          <svg class="sidebar-category__chevron ${cat.collapsed ? 'collapsed' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          ${cat.icon ? html`<span class="sidebar-category__icon">${cat.icon}</span>` : nothing}
          <span class="sidebar-category__name">${cat.name}</span>
          <span class="sidebar-category__count">${itemCount}</span>
          <div class="sidebar-category__actions" @click=${(e: Event) => e.stopPropagation()}>
            <button class="sidebar-category__action" title="Delete" @click=${() => this.handleDeleteCategory(cat.id)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="sidebar-category__items ${cat.collapsed ? 'collapsed' : ''}" 
          style="max-height: ${cat.collapsed ? '0' : `${itemCount * 50 + 10}px`}">
          ${sessions.map((s, idx) => this.renderDraggableSession(s, existingKeys.has(s.key), cat.id, idx))}
          ${!cat.collapsed && itemCount === 0 ? html`
            <div style="padding: 8px 10px; font-size: 10px; color: rgba(255,255,255,0.25); text-align: center;">
              Drop sessions here
            </div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  private renderDraggableSession(session: AvailableSession, inGrid: boolean, categoryId: string | null, index: number) {
    const icon = session.channel ? this.getChannelIcon(session.channel) : this.getAgentIcon(session.agentId);
    const timeAgo = this.formatRelativeTime(session.lastActivity);
    const tokens = session.totalTokens || 0;
    const isDragging = this.sidebarDragItem?.sessionKey === session.key;
    const isDropTarget = this.sidebarDropTarget?.categoryId === categoryId && 
                         this.sidebarDropTarget?.position === index;

    return html`
      ${isDropTarget ? html`<div class="sidebar-drop-indicator"></div>` : nothing}
      <div 
        class="sidebar-session ${inGrid ? 'in-grid' : ''} ${isDragging ? 'dragging' : ''}"
        draggable="true"
        @dragstart=${(e: DragEvent) => this.handleSessionDragStart(e, session.key, categoryId)}
        @dragend=${this.handleSessionDragEnd}
        @click=${() => {
          if (!inGrid) {
            this.handleSelectSession(session);
          } else {
            const panel = this.gridState.panels.find(p => p.sessionKey === session.key);
            if (panel) this.handlePanelFocus(panel.id);
          }
        }}
        title="${session.key}"
      >
        <span class="sidebar-session__led ${session.isActive ? 'active' : ''}"></span>
        <span class="sidebar-session__icon">${icon}</span>
        <div class="sidebar-session__info">
          <div class="sidebar-session__name">${session.title}</div>
          <div class="sidebar-session__meta">
            ${tokens > 0 ? html`<span style="color: var(--g-primary);">${this.formatTokensShort(tokens)} tok</span> · ` : ''}${timeAgo}
          </div>
        </div>
        ${inGrid 
          ? html`<span class="sidebar-session__badge">Open</span>`
          : html`<span class="sidebar-session__add-btn">+</span>`
        }
      </div>
    `;
  }

  // Drag & Drop handlers
  private handleSessionDragStart = (e: DragEvent, sessionKey: string, categoryId: string | null) => {
    e.dataTransfer?.setData('text/plain', sessionKey);
    e.dataTransfer?.setData('application/x-category', categoryId || '');
    this.sidebarDragItem = { sessionKey, startY: e.clientY };
  };

  private handleSessionDragEnd = () => {
    this.sidebarDragItem = null;
    this.sidebarDropTarget = null;
  };

  private handleDragOver = (e: DragEvent, categoryId: string, itemCount: number) => {
    e.preventDefault();
    if (!this.sidebarDragItem) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const position = Math.min(Math.floor(relY / 40), itemCount);
    
    this.sidebarDropTarget = { categoryId, position };
  };

  private handleDrop = (e: DragEvent, targetCategoryId: string) => {
    e.preventDefault();
    const sessionKey = e.dataTransfer?.getData('text/plain');
    const sourceCategory = e.dataTransfer?.getData('application/x-category') || null;
    
    if (!sessionKey) return;

    let newState = this.sidebarState;

    // Remove from source if it was in a category
    if (sourceCategory) {
      newState = removeItemFromCategory(newState, sessionKey);
    }

    // Add to target category (unless dropping to uncategorized)
    if (targetCategoryId !== 'uncategorized') {
      const position = this.sidebarDropTarget?.position;
      newState = addItemToCategory(newState, sessionKey, targetCategoryId, position);
    }

    this.sidebarState = newState;
    saveSidebarState(newState);
    
    this.sidebarDragItem = null;
    this.sidebarDropTarget = null;
  };

  private handleToggleCategory = (categoryId: string) => {
    this.sidebarState = toggleCategoryCollapsed(this.sidebarState, categoryId);
    saveSidebarState(this.sidebarState);
  };

  private handleCreateCategory = () => {
    if (!this.newCategoryName.trim()) return;
    this.sidebarState = createCategory(this.sidebarState, this.newCategoryName.trim());
    saveSidebarState(this.sidebarState);
    this.newCategoryName = "";
    this.showNewCategoryInput = false;
  };

  private handleDeleteCategory = (categoryId: string) => {
    if (confirm('Delete this category? Sessions will be moved to uncategorized.')) {
      this.sidebarState = deleteCategory(this.sidebarState, categoryId);
      saveSidebarState(this.sidebarState);
    }
  };

  private formatTokensShort(n: number | undefined): string {
    if (!n) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return String(n);
  }

  // ============================================================
  // Task Sidebar - Real-time Task Progress
  // ============================================================

  private renderTaskSidebar() {
    if (!this.showTaskSidebar) {
      return html`<div class="task-sidebar collapsed"></div>`;
    }

    const sessionKeys = this.gridState.panels.map(p => p.sessionKey);
    const tasks = getTasksForSessions(this.taskState, sessionKeys);
    const alerts = getActiveAlerts(this.taskState);
    const totalProgress = getTotalProgress(this.taskState);
    const activeCount = getActiveTaskCount(this.taskState);

    // Split into active and completed tasks
    // Also include manually approved tasks from approvedTaskIds
    const activeTasks = tasks.filter(t => 
      (t.status === 'in_progress' || t.status === 'pending') && 
      !this.approvedTaskIds.has(t.id)
    );
    const completedTasks = tasks.filter(t => 
      t.status === 'complete' || t.status === 'error' || this.approvedTaskIds.has(t.id)
    )
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
      .slice(0, 10); // Show last 10 completed

    return html`
      <div class="task-sidebar">
        <div class="task-sidebar-header">
          <span class="task-sidebar-header__title">Task Progress</span>
          ${activeCount > 0 ? html`
            <span class="task-sidebar-header__live">
              <span class="live-dot"></span>
              ${activeCount} LIVE
            </span>
          ` : nothing}
          <span class="task-sidebar-header__count">${tasks.length}</span>
        </div>
        <div class="task-sidebar-content">
          <!-- Overall progress -->
          ${tasks.length > 0 ? html`
            <div class="task-overall-progress">
              <div class="task-overall-progress__label">
                <span>Overall Progress</span>
                <span>${totalProgress}%</span>
              </div>
              <div class="task-overall-progress__bar">
                <div class="task-overall-progress__fill" style="width: ${totalProgress}%"></div>
              </div>
            </div>
          ` : nothing}

          <!-- Alerts -->
          ${alerts.length > 0 ? html`
            <div class="task-alerts">
              ${alerts.map(alert => this.renderTaskAlert(alert))}
            </div>
          ` : nothing}

          <!-- Active Tasks Section -->
          ${activeTasks.length > 0 ? html`
            <div class="task-section">
              <div class="task-section__header">
                <span class="task-section__icon">🔄</span>
                <span class="task-section__title">In Progress</span>
                <span class="task-section__count">${activeTasks.length}</span>
              </div>
              <div class="task-section__list">
                ${activeTasks.map(task => this.renderTaskCard(task))}
              </div>
            </div>
          ` : nothing}

          <!-- Empty state -->
          ${activeTasks.length === 0 && completedTasks.length === 0 ? html`
            <div class="task-sidebar-empty">
              <div class="task-sidebar-empty__icon">📋</div>
              <div class="task-sidebar-empty__text">No Active Tasks</div>
              <div class="task-sidebar-empty__hint">Open sessions to see their tasks</div>
            </div>
          ` : nothing}

          <!-- Completed History Section (Collapsible) -->
          ${completedTasks.length > 0 ? html`
            <div class="task-section task-section--completed ${this.completedSectionCollapsed ? 'collapsed' : ''}">
              <div 
                class="task-section__header task-section__header--clickable"
                @click=${() => { this.completedSectionCollapsed = !this.completedSectionCollapsed; }}
              >
                <span class="task-section__chevron">${this.completedSectionCollapsed ? '▶' : '▼'}</span>
                <span class="task-section__icon">✅</span>
                <span class="task-section__title">Recently Completed</span>
                <span class="task-section__count">${completedTasks.length}</span>
              </div>
              ${!this.completedSectionCollapsed ? html`
                <div class="task-section__list task-section__list--compact">
                  ${completedTasks.map(task => this.renderCompletedTaskCard(task))}
                </div>
              ` : nothing}
            </div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  private renderCompletedTaskCard(task: GridTask) {
    return html`
      <div class="task-card task-card--completed">
        <div class="task-card__header">
          <span class="task-card__status completed"></span>
          <div class="task-card__info">
            <div class="task-card__title" title="${task.title}">${task.title}</div>
            ${task.completedAt ? html`
              <div class="task-card__completed-time">${this.formatRelativeTime(task.completedAt)}</div>
            ` : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private renderTaskAlert(alert: TaskAlert) {
    const icons: Record<string, string> = {
      error: "⚠️",
      success: "✅",
      warning: "⚡",
      info: "ℹ️",
    };

    return html`
      <div class="task-alert ${alert.type}">
        <span class="task-alert__icon">${icons[alert.type] || "ℹ️"}</span>
        <span class="task-alert__message">${alert.message}</span>
        <button 
          class="task-alert__dismiss" 
          @click=${() => this.handleDismissAlert(alert.id)}
          title="Dismiss"
        >×</button>
      </div>
    `;
  }

  private handleDismissAlert(alertId: string) {
    // Find which task has this alert
    for (const [taskId, task] of this.taskState.tasks.entries()) {
      const alert = task.alerts.find(a => a.id === alertId);
      if (alert) {
        dismissAlert(this.taskState, taskId, alertId);
        this.requestUpdate();
        break;
      }
    }
  }

  private async handleEditTask(task: GridTask) {
    if (!this.client) {
      console.error("[MasonryGrid] No client available for edit");
      return;
    }

    // Prompt user for feedback/context
    const feedback = prompt("Enter feedback or additional instructions for this session:");
    if (!feedback) return;

    try {
      // Send message directly to the session
      console.log("[MasonryGrid] Sending feedback to session:", task.sessionKey);
      // RPC name is `sessions.send` (`sessions_send` is the MCP tool name).
      const res = (await this.client.request("sessions.send", {
        sessionKey: task.sessionKey,
        message: feedback,
      })) as { ok?: boolean; error?: string } | undefined;

      if (res?.ok) {
        console.log("[MasonryGrid] Feedback sent to session:", task.sessionKey);
        // Show success feedback
        task.alerts.push({
          id: `alert-${Date.now()}`,
          type: "info",
          message: "Feedback sent to session",
          timestamp: Date.now(),
          dismissed: false,
        });
        this.requestUpdate();
      } else {
        console.error("[MasonryGrid] Failed to send feedback:", res?.error);
        alert("Failed to send feedback: " + (res?.error || "Unknown error"));
      }
    } catch (err) {
      console.error("[MasonryGrid] Error sending feedback:", err);
      alert("Error sending feedback: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  private async handleApproveTask(task: GridTask) {
    if (!this.client) {
      console.error("[MasonryGrid] No client available for approve");
      return;
    }

    try {
      // Send completion acknowledgment to the session
      console.log("[MasonryGrid] Approving task for session:", task.sessionKey);
      await this.client.request("sessions.send", {
        sessionKey: task.sessionKey,
        message: "✅ Task approved and marked complete. Good work!",
      }).catch(() => {}); // Ignore send errors

      // Track this task as approved (survives poll updates)
      this.approvedTaskIds = new Set([...this.approvedTaskIds, task.id]);
      
      // Update local state
      task.status = "complete";
      task.progress = 100;
      task.completedAt = Date.now();
      
      // Add success alert
      task.alerts.push({
        id: `alert-${Date.now()}`,
        type: "success",
        message: "Task marked as complete",
        timestamp: Date.now(),
        dismissed: false,
      });

      console.log("[MasonryGrid] Task approved:", task.id);
      this.requestUpdate();
    } catch (err) {
      console.error("[MasonryGrid] Error approving task:", err);
      // Still mark locally as complete
      this.approvedTaskIds = new Set([...this.approvedTaskIds, task.id]);
      task.status = "complete";
      task.progress = 100;
      task.completedAt = Date.now();
      this.requestUpdate();
    }
  }

  private renderTaskCard(task: GridTask) {
    const isExpanded = this.expandedTaskId === task.id;
    const lastSteps = task.steps.slice(-5).reverse();

    return html`
      <div class="task-card ${task.status === 'in_progress' ? 'active' : ''}">
        <div class="task-card__header" @click=${() => this.toggleTaskExpanded(task.id)}>
          <span class="task-card__status ${task.status}"></span>
          <div class="task-card__info">
            <div class="task-card__title" title="${task.title}">${task.title}</div>
            ${task.phase && task.status === 'in_progress' ? html`
              <div class="task-card__phase">${task.phase}</div>
            ` : nothing}
          </div>
          <span class="task-card__progress-text">${task.progress}%</span>
        </div>
        <div class="task-card__progress-bar">
          <div class="task-card__progress-fill" style="width: ${task.progress}%"></div>
        </div>

        <!-- Action Buttons -->
        <div class="task-card__actions">
          <button 
            class="task-card__btn task-card__btn--edit"
            @click=${(e: Event) => { e.stopPropagation(); this.handleEditTask(task); }}
            title="Edit task - restart with new context"
          >
            ✏️ Edit
          </button>
          <button 
            class="task-card__btn task-card__btn--approve"
            @click=${(e: Event) => { e.stopPropagation(); this.handleApproveTask(task); }}
            title="Mark as done"
          >
            ✅ Approve
          </button>
        </div>

        ${isExpanded ? html`
          <div class="task-card__details">
            ${lastSteps.length > 0 ? html`
              <div class="task-card__steps">
                ${lastSteps.map(step => this.renderTaskStep(step))}
              </div>
            ` : nothing}
            <div class="task-card__meta">
              <span>${task.toolCalls} tools</span>
              <span>${task.steps.length} steps</span>
              ${task.startedAt ? html`
                <span>${this.formatRelativeTime(task.startedAt)}</span>
              ` : nothing}
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderTaskStep(step: { type: string; content: string; timestamp: number }) {
    const icons: Record<string, string> = {
      tool_call: "⚡",
      tool_result: "↩",
      thinking: "◈",
      text: "◆",
      error: "✕",
      spawn: "⊕",
    };

    return html`
      <div class="task-step">
        <span class="task-step__icon ${step.type}">${icons[step.type] || "·"}</span>
        <span class="task-step__content">${this.truncateText(step.content, 35)}</span>
        <span class="task-step__time">${new Date(step.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
    `;
  }

  private toggleTaskExpanded(taskId: string) {
    this.expandedTaskId = this.expandedTaskId === taskId ? null : taskId;
  }

  private truncateText(text: string, max: number): string {
    if (!text) return "";
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  /**
   * Per-panel chrome used by the new panel types (voice, projects, tasks) and
   * by the upgraded activity/kanban/database branches. Provides drag header +
   * refresh button + agent-control chip + minimize/maximize/close while
   * delegating the body to a TemplateResult.
   *
   * NOTE: This is intentionally a small inline chrome (not a custom element)
   * so the surgical edits remain in one place. The styles ride along on the
   * grid-panel-shell class defined in the view's styles block.
   */
  private renderGridPanelShell(
    panel: GridPanel,
    styles: Record<string, string>,
    bodyTpl: unknown,
    bodyKey?: string,
  ) {
    void bodyKey; // reserved for future per-body keyed renders
    const pending = panel.agentControl?.pendingOp;
    const lastDispatch = panel.agentControl?.lastDispatchAt;
    const agentChipTitle = pending
      ? `Agent control: ${pending}`
      : lastDispatch
        ? `Last agent action: ${new Date(lastDispatch).toLocaleTimeString()}`
        : "No recent agent actions";
    return html`
      <div
        class="grid-panel-shell ${this.gridState.activePanel === panel.id ? "active" : ""}"
        data-panel-id=${panel.id}
        style=${styleMap(styles)}
        @mousedown=${() => this.handlePanelFocus(panel.id)}
      >
        <div
          class="grid-panel-shell__header"
          @mousedown=${(e: MouseEvent) => {
            // Header is the drag handle; ignore clicks on chrome buttons.
            const target = e.target as HTMLElement;
            if (target.closest(".grid-panel-shell__btn")) return;
            this.handleDragStart(panel.id, e);
          }}
          @touchstart=${(e: TouchEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest(".grid-panel-shell__btn")) return;
            this.handleDragStart(panel.id, e);
          }}
        >
          <span class="grid-panel-shell__title">${panel.title}</span>
          <span
            class="grid-panel-shell__chip ${pending ? "pending" : ""}"
            title=${agentChipTitle}
          >
            🎙️ ${pending ?? (lastDispatch ? "idle" : "—")}
          </span>
          <div class="grid-panel-shell__controls">
            <button
              class="grid-panel-shell__btn"
              title="Refresh panel data"
              @click=${(e: Event) => { e.stopPropagation(); this.handlePanelRefresh(panel.id); }}
            >🔄</button>
            <button
              class="grid-panel-shell__btn"
              title="Minimize"
              @click=${(e: Event) => { e.stopPropagation(); this.handlePanelMinimize(panel.id); }}
            >–</button>
            <button
              class="grid-panel-shell__btn"
              title="Maximize"
              @click=${(e: Event) => { e.stopPropagation(); this.handlePanelMaximize(panel.id); }}
            >▢</button>
            <button
              class="grid-panel-shell__btn close"
              title="Close"
              @click=${(e: Event) => { e.stopPropagation(); this.handlePanelClose(panel.id); }}
            >×</button>
          </div>
        </div>
        <div class="grid-panel-body">${bodyTpl}</div>
        <!-- Resize edges: 4 sides + 4 corners — mirrors the masonry-panel custom element. -->
        <div class="grid-panel-shell__resize n" @mousedown=${(e: MouseEvent) => this.handleResizeStart(panel.id, "n", e)} @touchstart=${(e: TouchEvent) => this.handleResizeStart(panel.id, "n", e)}></div>
        <div class="grid-panel-shell__resize s" @mousedown=${(e: MouseEvent) => this.handleResizeStart(panel.id, "s", e)} @touchstart=${(e: TouchEvent) => this.handleResizeStart(panel.id, "s", e)}></div>
        <div class="grid-panel-shell__resize e" @mousedown=${(e: MouseEvent) => this.handleResizeStart(panel.id, "e", e)} @touchstart=${(e: TouchEvent) => this.handleResizeStart(panel.id, "e", e)}></div>
        <div class="grid-panel-shell__resize w" @mousedown=${(e: MouseEvent) => this.handleResizeStart(panel.id, "w", e)} @touchstart=${(e: TouchEvent) => this.handleResizeStart(panel.id, "w", e)}></div>
        <div class="grid-panel-shell__resize ne" @mousedown=${(e: MouseEvent) => this.handleResizeStart(panel.id, "ne", e)} @touchstart=${(e: TouchEvent) => this.handleResizeStart(panel.id, "ne", e)}></div>
        <div class="grid-panel-shell__resize nw" @mousedown=${(e: MouseEvent) => this.handleResizeStart(panel.id, "nw", e)} @touchstart=${(e: TouchEvent) => this.handleResizeStart(panel.id, "nw", e)}></div>
        <div class="grid-panel-shell__resize se" @mousedown=${(e: MouseEvent) => this.handleResizeStart(panel.id, "se", e)} @touchstart=${(e: TouchEvent) => this.handleResizeStart(panel.id, "se", e)}></div>
        <div class="grid-panel-shell__resize sw" @mousedown=${(e: MouseEvent) => this.handleResizeStart(panel.id, "sw", e)} @touchstart=${(e: TouchEvent) => this.handleResizeStart(panel.id, "sw", e)}></div>
      </div>
    `;
  }


  private renderPanel(panel: GridPanel) {
    const isActive = this.gridState.activePanel === panel.id;
    const isDragging = this.dragState?.panelId === panel.id;
    const isResizing = this.resizeState?.panelId === panel.id;

    const transition =
      this.dragState || this.resizeState
        ? "none"
        : "box-shadow 0.2s, transform 0.1s, border-color 0.2s, width 150ms ease, height 150ms ease, left 150ms ease, top 150ms ease";
    const styles = panel.maximized
      ? {
          position: "absolute",
          top: "0",
          left: "0",
          width: "100%",
          height: "100%",
          zIndex: String(panel.zIndex),
          transition,
        }
      : {
          position: "absolute",
          left: `${panel.x}px`,
          top: `${panel.y}px`,
          width: `${panel.width}px`,
          height: `${panel.height}px`,
          zIndex: String(panel.zIndex),
          transition,
          ...(isResizing ? { willChange: "width, height" } : {}),
        };

    // Handle different panel types
    const panelType = panel.type || "session";
    if (this.isPanelRecycleEligible(panel) && this.offscreenPanelIds.has(panel.id)) {
      return this.renderPanelRecyclePlaceholder(panel, styles);
    }

    // ============================================================
    // NEW panel types — voice / projects / tasks (A1 + A3 contract)
    // ============================================================
    if (panelType === "group_chat" || panelType === "workflow_builder") {
      return this.renderGridPanelShell(
        panel,
        styles,
        html`<ib-group-chat-panel
          style="display:block;height:100%"
          .client=${this.client}
          .groupKey=${panel.groupId ?? null}
          .initialTab=${panelType === "workflow_builder" ? "workflows" : "chat"}
          @group-select=${(e: CustomEvent<{ key: string }>) => this.handleUpdatePanelMeta(panel.id, { groupId: e.detail.key })}
        ></ib-group-chat-panel>`,
        panelType,
      );
    }
    if (panelType === "voice") {
      return html`
        <voice-grid-panel
          .panel=${panel}
          .client=${this.client}
          .appState=${this.appState}
          .isActive=${isActive}
          .isDragging=${isDragging}
          .isResizing=${isResizing}
          style=${styleMap(styles)}
          @panel-focus=${() => this.handlePanelFocus(panel.id)}
          @panel-close=${() => this.handlePanelClose(panel.id)}
          @panel-minimize=${() => this.handlePanelMinimize(panel.id)}
          @panel-maximize=${() => this.handlePanelMaximize(panel.id)}
          @panel-meta-update=${(e: CustomEvent) => this.handleUpdatePanelMeta(panel.id, e.detail)}
          @drag-start=${(e: CustomEvent) => this.handleDragStart(panel.id, e.detail)}
          @resize-start=${(e: CustomEvent) => this.handleResizeStart(panel.id, e.detail.edge, e.detail.event)}
        ></voice-grid-panel>
      `;
    }
    if (panelType === "projects") {
      return this.renderGridPanelShell(
        panel,
        styles,
        renderGridProjectsPanel(panel, this.appState ?? this.gridState, this.client as any),
        "projects",
      );
    }
    if (panelType === "tasks") {
      return this.renderGridPanelShell(
        panel,
        styles,
        renderGridTasksPanel(panel, this.appState ?? this.gridState, this.client as any),
        "tasks",
      );
    }
    if (panelType === "knowledgeGraph") {
      return this.renderGridPanelShell(
        panel,
        styles,
        renderKnowledgeGraphPanel({ client: this.client }),
        "knowledgeGraph",
      );
    }

    if (panelType === "canvas") {
      return html`
        <canvas-grid-panel
          .panel=${panel}
          .isActive=${isActive}
          .isDragging=${isDragging}
          .isResizing=${isResizing}
          style=${styleMap(styles)}
          @panel-focus=${() => this.handlePanelFocus(panel.id)}
          @panel-close=${() => this.handlePanelClose(panel.id)}
          @panel-minimize=${() => this.handlePanelMinimize(panel.id)}
          @panel-maximize=${() => this.handlePanelMaximize(panel.id)}
          @drag-start=${(e: CustomEvent) => this.handleDragStart(panel.id, e.detail)}
          @resize-start=${(e: CustomEvent) => this.handleResizeStart(panel.id, e.detail.edge, e.detail.event)}
        ></canvas-grid-panel>
      `;
    }

    if (panelType === "chart") {
      return html`
        <chart-grid-panel
          .panel=${panel}
          .isActive=${isActive}
          .isDragging=${isDragging}
          .isResizing=${isResizing}
          style=${styleMap(styles)}
          @panel-focus=${() => this.handlePanelFocus(panel.id)}
          @panel-close=${() => this.handlePanelClose(panel.id)}
          @panel-minimize=${() => this.handlePanelMinimize(panel.id)}
          @panel-maximize=${() => this.handlePanelMaximize(panel.id)}
          @drag-start=${(e: CustomEvent) => this.handleDragStart(panel.id, e.detail)}
          @resize-start=${(e: CustomEvent) => this.handleResizeStart(panel.id, e.detail.edge, e.detail.event)}
        ></chart-grid-panel>
      `;
    }

    if (panelType === "video") {
      return html`
        <video-grid-panel
          .panel=${panel}
          .isActive=${isActive}
          .isDragging=${isDragging}
          .isResizing=${isResizing}
          style=${styleMap(styles)}
          @panel-focus=${() => this.handlePanelFocus(panel.id)}
          @panel-close=${() => this.handlePanelClose(panel.id)}
          @panel-minimize=${() => this.handlePanelMinimize(panel.id)}
          @panel-maximize=${() => this.handlePanelMaximize(panel.id)}
          @drag-start=${(e: CustomEvent) => this.handleDragStart(panel.id, e.detail)}
          @resize-start=${(e: CustomEvent) => this.handleResizeStart(panel.id, e.detail.edge, e.detail.event)}
        ></video-grid-panel>
      `;
    }

    if (panelType === "gpu") {
      return html`
        <gpu-grid-panel
          .panel=${panel}
          .client=${this.client}
          .isActive=${isActive}
          .isDragging=${isDragging}
          .isResizing=${isResizing}
          style=${styleMap(styles)}
          @panel-focus=${() => this.handlePanelFocus(panel.id)}
          @panel-close=${() => this.handlePanelClose(panel.id)}
          @panel-minimize=${() => this.handlePanelMinimize(panel.id)}
          @panel-maximize=${() => this.handlePanelMaximize(panel.id)}
          @drag-start=${(e: CustomEvent) => this.handleDragStart(panel.id, e.detail)}
          @resize-start=${(e: CustomEvent) => this.handleResizeStart(panel.id, e.detail.edge, e.detail.event)}
        ></gpu-grid-panel>
      `;
    }

    if (panelType === "kanban") {
      // Upgraded: A3's `renderGridKanbanPanel` is the new body. The shell
      // provides drag/resize + refresh button + agent-control chip.
      return this.renderGridPanelShell(
        panel,
        styles,
        renderGridKanbanPanel(panel, this.appState ?? this.gridState, this.client as any),
        "kanban",
      );
    }

    if (panelType === "database") {
      // Upgraded: A3's `renderGridDatabasePanel` is the new body.
      return this.renderGridPanelShell(
        panel,
        styles,
        renderGridDatabasePanel(panel, this.appState ?? this.gridState, this.client as any),
        "database",
      );
    }

    if (panelType === "terminal") {
      return html`
        <terminal-grid-panel
          .panel=${panel}
          .client=${this.client}
          .appState=${this.appState}
          .isActive=${isActive}
          .isDragging=${isDragging}
          .isResizing=${isResizing}
          style=${styleMap(styles)}
          @panel-focus=${() => this.handlePanelFocus(panel.id)}
          @panel-close=${() => this.handlePanelClose(panel.id)}
          @panel-minimize=${() => this.handlePanelMinimize(panel.id)}
          @panel-maximize=${() => this.handlePanelMaximize(panel.id)}
          @panel-meta-update=${(e: CustomEvent) => this.handleUpdatePanelMeta(panel.id, e.detail)}
          @drag-start=${(e: CustomEvent) => this.handleDragStart(panel.id, e.detail)}
          @resize-start=${(e: CustomEvent) => this.handleResizeStart(panel.id, e.detail.edge, e.detail.event)}
        ></terminal-grid-panel>
      `;
    }

    if (panelType === "activity") {
      // Upgraded: A3's `renderGridActivityPanel` is the new body.
      return this.renderGridPanelShell(
        panel,
        styles,
        renderGridActivityPanel(panel, this.appState ?? this.gridState, this.client as any),
        "activity",
      );
    }

    if (panelType === "credits") {
      return this.renderGridPanelShell(
        panel,
        styles,
        html`<div style="padding:10px;height:100%;box-sizing:border-box;overflow:auto;">
          <credit-usage-breakdown .client=${this.client as any}></credit-usage-breakdown>
        </div>`,
        "credits",
      );
    }

    if (panelType === "view") {
      return this.renderGridPanelShell(
        panel,
        styles,
        renderViewAdapterPanel(panel, this.appState ?? this.gridState, this.client as any),
        "view",
      );
    }

    if (panelType === "agencyOps") {
      return this.renderGridPanelShell(
        panel,
        styles,
        renderAgencyOpsTabPanel(panel, this.appState ?? this.gridState, this.client as any),
        "agencyOps",
      );
    }

    // Default: session panel
    return html`
      <masonry-panel
        .panel=${panel}
        .client=${this.client}
        .isActive=${isActive}
        .isDragging=${isDragging}
        .isResizing=${isResizing}
        .showSizeIndicator=${isResizing}
        .showAiIde=${this.showAiIde}
        .availableModels=${this.availableModels}
        style=${styleMap(styles)}
        @panel-focus=${() => this.handlePanelFocus(panel.id)}
        @panel-close=${() => this.handlePanelClose(panel.id)}
        @panel-minimize=${() => this.handlePanelMinimize(panel.id)}
        @panel-maximize=${() => this.handlePanelMaximize(panel.id)}
        @panel-rename=${(e: CustomEvent) => this.handlePanelRename(panel.id, e.detail)}
        @panel-meta-update=${(e: CustomEvent) => this.handleUpdatePanelMeta(panel.id, e.detail)}
        @drag-start=${(e: CustomEvent) => this.handleDragStart(panel.id, e.detail)}
        @resize-start=${(e: CustomEvent) => this.handleResizeStart(panel.id, e.detail.edge, e.detail.event)}
        @session-message=${(e: CustomEvent) => {
          this.dispatchEvent(
            new CustomEvent("session-message", {
              detail: { sessionKey: panel.sessionKey, message: e.detail.message },
              bubbles: true,
              composed: true,
            })
          );
        }}
      ></masonry-panel>
    `;
  }
}

// ============================================================
// Individual Panel Component - Matches main chat UI
// ============================================================

@customElement("masonry-panel")
export class MasonryPanel extends LitElement {
  static styles = [css`
    :host {
      display: block;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      transition: box-shadow 0.2s, transform 0.1s;
    }

    :host(.active) {
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 2px var(--c-accent, var(--g-primary));
    }

    /* Secure session: the frame stays emerald, also when the panel is focused. */
    :host(.secure) {
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--ib-secure-ring, rgba(52, 211, 153, 0.5));
    }
    :host(.secure.active) {
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 2px var(--ib-secure, #34d399),
        0 0 18px var(--ib-secure-soft, rgba(52, 211, 153, 0.22));
    }

    :host(.dragging) {
      cursor: grabbing;
      transform: scale(1.01);
    }

    * { box-sizing: border-box; }

    svg {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .panel {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: rgba(8, 8, 8, 0.75);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 
        0 8px 32px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }

    /* Terminal-style header bar */
    .panel-header {
      display: flex;
      align-items: center;
      min-height: 36px;
      background: rgba(0, 0, 0, 0.4);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      cursor: grab;
      user-select: none;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      font-size: 11px;
    }

    .panel-header:active { cursor: grabbing; }

    .panel-header__main {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 12px;
      flex: 1;
      min-width: 0;
      border-right: 1px solid rgba(255,255,255,0.06);
    }

    .panel-led {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 6px rgba(34,197,94,0.5);
      flex-shrink: 0;
    }

    .panel-led.sending {
      background: var(--g-primary);
      box-shadow: 0 0 6px rgba(251,191,36,0.5);
      animation: pulse 1s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .panel-title {
      font-weight: 600;
      color: #fff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    
    .panel-title:hover {
      color: var(--accent, var(--g-primary));
    }
    
    .panel-title-input {
      font-family: inherit;
      font-size: inherit;
      font-weight: 600;
      background: rgba(0,0,0,0.5);
      border: 1px solid var(--accent, var(--g-primary));
      border-radius: 3px;
      color: var(--accent, var(--g-primary));
      padding: 2px 8px;
      width: 140px;
      outline: none;
    }
    
    .panel-title-input:focus {
      box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }
    
    .wake-word-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      margin-left: 8px;
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.15) 0%, rgba(59, 130, 246, 0.15) 100%);
      border: 1px solid rgba(139, 92, 246, 0.3);
      border-radius: 12px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 9px;
      font-weight: 600;
      color: #a78bfa;
      text-transform: none;
      letter-spacing: 0.02em;
      animation: wake-pulse 2s ease-in-out infinite;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    
    .wake-word-badge:hover {
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.25) 0%, rgba(59, 130, 246, 0.25) 100%);
      border-color: rgba(139, 92, 246, 0.5);
    }
    
    .wake-word-badge--editing {
      animation: none;
      background: rgba(139, 92, 246, 0.2);
      border-color: rgba(139, 92, 246, 0.6);
      padding: 2px 4px 2px 8px;
    }
    
    .wake-word-input {
      width: 70px;
      padding: 2px 6px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(139, 92, 246, 0.5);
      border-radius: 6px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 9px;
      font-weight: 600;
      color: #a78bfa;
      outline: none;
      transition: all 0.15s ease;
    }
    
    .wake-word-input:focus {
      border-color: #a78bfa;
      box-shadow: 0 0 8px rgba(139, 92, 246, 0.4);
    }
    
    .wake-word-input::placeholder {
      color: rgba(167, 139, 250, 0.5);
    }
    
    .wake-word-badge svg {
      color: #a78bfa;
      animation: wake-mic-pulse 1.5s ease-in-out infinite;
    }
    
    .wake-word-badge--editing svg {
      animation: none;
    }
    
    .wake-word-text {
      opacity: 0.9;
    }
    
    @keyframes wake-pulse {
      0%, 100% { 
        box-shadow: 0 0 4px rgba(139, 92, 246, 0.2);
        border-color: rgba(139, 92, 246, 0.3);
      }
      50% { 
        box-shadow: 0 0 12px rgba(139, 92, 246, 0.4);
        border-color: rgba(139, 92, 246, 0.5);
      }
    }
    
    @keyframes wake-mic-pulse {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 1; }
    }
    
    /* Compact mode - hide wake word badge */
    :host([data-compact]) .wake-word-badge {
      display: none;
    }

    /* Agent selector dropdown */
    .agent-selector {
      position: relative;
      margin-left: 8px;
    }

    .agent-selector__trigger {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 10%, transparent) 0%, rgba(184, 150, 46, 0.1) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
      border-radius: 6px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 9px;
      font-weight: 600;
      color: var(--g-primary);
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }

    .agent-selector__trigger:hover {
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 20%, transparent) 0%, rgba(184, 150, 46, 0.15) 100%);
      border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    }

    .agent-selector__trigger svg {
      width: 10px;
      height: 10px;
      transition: transform 0.15s;
    }

    .agent-selector__trigger.open svg {
      transform: rotate(180deg);
    }

    .agent-selector__dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      min-width: 160px;
      background: rgba(10, 10, 15, 0.98);
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-radius: 8px;
      padding: 4px;
      z-index: 1000;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(12px);
      animation: agent-dropdown-in 0.15s ease-out;
    }

    @keyframes agent-dropdown-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .agent-selector__option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      color: rgba(255, 255, 255, 0.7);
      cursor: pointer;
      border-radius: 5px;
      transition: all 0.1s;
    }

    .agent-selector__option:hover {
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      color: #fff;
    }

    .agent-selector__option.selected {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      color: var(--g-primary);
    }

    .agent-selector__option-check {
      width: 14px;
      color: var(--g-primary);
      opacity: 0;
    }

    .agent-selector__option.selected .agent-selector__option-check {
      opacity: 1;
    }

    /* Compact mode - show shorter agent name */
    :host([data-compact]) .agent-selector__trigger {
      padding: 2px 6px;
      font-size: 8px;
    }

    /* Model selector styles */
    .model-selector-stat {
      position: relative;
      padding: 0 !important;
    }

    .model-selector__trigger {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 10px;
      height: 36px;
      background: transparent;
      border: none;
      border-left: 1px solid rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.5);
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 10px;
      cursor: pointer;
      transition: all 0.12s ease;
      white-space: nowrap;
    }

    .model-selector__trigger:hover {
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      color: var(--g-primary);
    }

    .model-selector__trigger.open {
      background: color-mix(in srgb, var(--g-primary) 12%, transparent);
      color: var(--g-primary);
    }

    .model-selector__provider {
      color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      font-weight: 500;
    }

    .model-selector__name {
      font-weight: 600;
    }

    .model-selector__dropdown {
      position: fixed;
      min-width: 280px;
      max-width: 360px;
      max-height: 400px;
      background: rgba(10, 10, 15, 0.98);
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 8px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      z-index: 10000;
      overflow: hidden;
      animation: model-dropdown-in 0.12s ease-out;
    }

    @keyframes model-dropdown-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .model-selector__search {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }

    .model-selector__search input {
      flex: 1;
      padding: 0;
      background: transparent;
      border: none;
      color: #e4e4e7;
      font-family: inherit;
      font-size: 12px;
      outline: none;
    }

    .model-selector__search input::placeholder {
      color: rgba(255,255,255,0.3);
    }

    .model-selector__filters {
      display: flex;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      flex-wrap: wrap;
    }

    .model-selector__filter-chip {
      padding: 4px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      color: rgba(255,255,255,0.5);
      font-family: inherit;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.12s ease;
    }

    .model-selector__filter-chip:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
      color: color-mix(in srgb, var(--g-primary) 80%, transparent);
    }

    .model-selector__filter-chip.active {
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      color: var(--g-primary);
    }

    .model-selector__list {
      max-height: 260px;
      overflow-y: auto;
    }

    .model-selector__list::-webkit-scrollbar {
      width: 5px;
    }

    .model-selector__list::-webkit-scrollbar-track {
      background: transparent;
    }

    .model-selector__list::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 3px;
    }

    .model-selector__empty {
      padding: 16px;
      text-align: center;
      color: rgba(255,255,255,0.35);
      font-size: 11px;
    }

    /* Loading state — reserve generous space so the dropdown doesn't render as a
       cramped sliver while models are being fetched. */
    .model-selector__loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      min-height: 200px;
      padding: 24px 16px;
      color: rgba(255,255,255,0.5);
      font-size: 12px;
    }

    .model-selector__loading-spinner {
      width: 22px;
      height: 22px;
      border: 2px solid rgba(255,255,255,0.15);
      border-top-color: var(--g-primary);
      border-radius: 50%;
      animation: model-selector-spin 0.7s linear infinite;
    }

    @keyframes model-selector-spin {
      to { transform: rotate(360deg); }
    }

    .model-selector__group {
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }

    .model-selector__group:last-child {
      border-bottom: none;
    }

    .model-selector__group-label {
      padding: 6px 10px;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }

    .model-selector__option {
      display: flex;
      align-items: center;
      width: 100%;
      padding: 10px 12px;
      background: transparent;
      border: none;
      color: #a1a1aa;
      font-family: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: all 0.1s;
    }

    .model-selector__option:hover {
      background: color-mix(in srgb, var(--g-primary) 6%, transparent);
      color: #e4e4e7;
    }

    .model-selector__option.selected {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      color: var(--g-primary);
    }

    .model-selector__option-name {
      flex: 1;
      font-weight: 500;
    }

    .model-selector__option-check {
      color: var(--g-primary);
      font-size: 14px;
      margin-left: 8px;
    }

    /* "Not connected" placeholder row for an unconfigured provider. */
    .model-selector__option--setup .model-selector__option-name {
      font-weight: 400;
      color: rgba(255, 255, 255, 0.45);
    }
    .model-selector__option-setup {
      margin-left: 8px;
      font-size: 11px;
      font-weight: 600;
      color: var(--g-primary);
      white-space: nowrap;
    }

    /* Collapsible stats cells */
    .panel-stats {
      display: flex;
      align-items: center;
    }

    .panel-stat {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 10px;
      border-right: 1px solid rgba(255,255,255,0.06);
      height: 36px;
    }

    .panel-stat__label {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: rgba(255,255,255,0.3);
      text-transform: uppercase;
    }

    .panel-stat__value {
      color: rgba(255,255,255,0.7);
      font-size: 10px;
    }

    .panel-stat__value--gold {
      color: var(--g-primary);
    }

    .panel-stat__value--dim {
      color: rgba(255,255,255,0.4);
    }

    /* Hide stats on narrow panels */
    :host([data-compact]) .panel-stats {
      display: none;
    }

    .panel-controls {
      display: flex;
      align-items: stretch;
    }

    .panel-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 36px;
      border: none;
      border-left: 1px solid rgba(255,255,255,0.06);
      background: transparent;
      color: rgba(255,255,255,0.5);
      cursor: pointer;
      transition: all 0.1s;
    }

    .panel-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      color: var(--g-primary);
    }

    .panel-btn.close:hover {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }

    .panel-btn svg { width: 14px; height: 14px; }

    .panel-content {
      flex: 1;
      overflow: hidden;
      position: relative;
      display: flex;
      flex-direction: column;
    }

    /* Resize handles - visible on hover with gold accent */
    .resize-handle { 
      position: absolute; 
      background: transparent; 
      z-index: 10;
      transition: background 0.15s ease, box-shadow 0.15s ease;
      touch-action: none;
    }
    
    /* Edge handles */
    .resize-n { 
      top: 0; left: 12px; right: 12px; height: 6px; cursor: n-resize;
    }
    .resize-s { 
      bottom: 0; left: 12px; right: 12px; height: 6px; cursor: s-resize;
    }
    .resize-e { 
      right: 0; top: 12px; bottom: 12px; width: 6px; cursor: e-resize;
    }
    .resize-w { 
      left: 0; top: 12px; bottom: 12px; width: 6px; cursor: w-resize;
    }
    
    /* Corner handles - larger hit area */
    .resize-ne { 
      top: 0; right: 0; width: 16px; height: 16px; cursor: ne-resize;
      border-radius: 0 12px 0 0;
    }
    .resize-nw { 
      top: 0; left: 0; width: 16px; height: 16px; cursor: nw-resize;
      border-radius: 12px 0 0 0;
    }
    .resize-se { 
      bottom: 0; right: 0; width: 16px; height: 16px; cursor: se-resize;
      border-radius: 0 0 12px 0;
    }
    .resize-sw { 
      bottom: 0; left: 0; width: 16px; height: 16px; cursor: sw-resize;
      border-radius: 0 0 0 12px;
    }
    
    /* Hover effects for edge handles */
    .resize-n:hover, .resize-s:hover {
      background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--g-primary) 40%, transparent) 50%, transparent 100%);
    }
    .resize-e:hover, .resize-w:hover {
      background: linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--g-primary) 40%, transparent) 50%, transparent 100%);
    }
    
    /* Hover effects for corner handles */
    .resize-ne:hover, .resize-nw:hover, .resize-se:hover, .resize-sw:hover {
      background: radial-gradient(circle at center, color-mix(in srgb, var(--g-primary) 50%, transparent) 0%, transparent 70%);
    }
    
    /* Corner grip dots (visible on hover) */
    .resize-se::after {
      content: '';
      position: absolute;
      bottom: 4px;
      right: 4px;
      width: 8px;
      height: 8px;
      background: 
        linear-gradient(135deg, transparent 40%, color-mix(in srgb, var(--g-primary) 60%, transparent) 40%, color-mix(in srgb, var(--g-primary) 60%, transparent) 60%, transparent 60%),
        linear-gradient(135deg, transparent 40%, color-mix(in srgb, var(--g-primary) 40%, transparent) 40%, color-mix(in srgb, var(--g-primary) 40%, transparent) 60%, transparent 60%);
      background-size: 4px 4px;
      background-position: 0 0, 2px 2px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .resize-se:hover::after {
      opacity: 1;
    }
    
    /* Active/resizing state */
    :host(.resizing) .resize-handle {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
    }

    /* Chat messages - matching main chat UI */
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
    }

    .chat-window-spacer {
      flex: 0 0 auto;
      pointer-events: none;
    }

    .chat-group {
      display: flex;
      gap: 12px;
      max-width: 100%;
    }

    .chat-group.user {
      flex-direction: row-reverse;
    }

    .chat-avatar {
      width: 32px;
      height: 32px;
      min-width: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 600;
      flex-shrink: 0;
    }

    .chat-avatar.user {
      background: linear-gradient(135deg, var(--c-accent, var(--g-primary)) 0%, #f59e0b 100%);
      color: #000;
    }

    .chat-avatar.assistant {
      background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
      color: #fff;
    }

    /* Brand-logo assistant avatar (img): same box, never distorted. */
    .chat-avatar.chat-logo-avatar {
      display: block;
      box-sizing: border-box;
      object-fit: contain;
      object-position: center;
      background: color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 30%, transparent);
      user-select: none;
    }

    .chat-logo-avatar--mark { object-view-box: inset(18% 21% 23% 20.5%); }

    .chat-group-messages {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: calc(100% - 44px);
      min-width: 0;
    }

    .chat-bubble {
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.5;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .chat-group.user .chat-bubble {
      background: rgba(251, 191, 36, 0.15);
      border: 1px solid rgba(251, 191, 36, 0.2);
      border-radius: 12px 12px 4px 12px;
    }

    .chat-group.assistant .chat-bubble {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px 12px 12px 4px;
    }

    .chat-bubble :first-child { margin-top: 0; }
    .chat-bubble :last-child { margin-bottom: 0; }

    /* Markdown styling */
    .chat-bubble p { margin: 0.5em 0; }
    .chat-bubble code {
      background: rgba(0, 0, 0, 0.3);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 0.9em;
    }
    .chat-bubble pre {
      background: rgba(0, 0, 0, 0.4);
      padding: 12px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .chat-bubble pre code {
      background: none;
      padding: 0;
    }
    .chat-bubble ul, .chat-bubble ol {
      margin: 0.5em 0;
      padding-left: 1.5em;
    }
    .chat-bubble a {
      color: var(--c-accent, var(--g-primary));
      text-decoration: none;
    }
    .chat-bubble a:hover { text-decoration: underline; }

    /* Message images */
    .message-images {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    .message-image {
      max-width: 200px;
      max-height: 150px;
      border-radius: 8px;
      object-fit: cover;
      cursor: pointer;
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .message-image:hover {
      transform: scale(1.02);
      border-color: rgba(251, 191, 36, 0.4);
    }
    .chat-group.user .message-images {
      justify-content: flex-end;
    }

    /* Action buttons overlay for assistant messages */
    .chat-bubble.has-actions {
      position: relative;
      padding-right: 100px;
    }

    .grid-bubble-actions {
      position: absolute;
      top: 6px;
      right: 6px;
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .chat-bubble:hover .grid-bubble-actions,
    .grid-bubble-actions:focus-within {
      opacity: 1;
    }

    .grid-action-btn {
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(20, 20, 20, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      color: #888;
      cursor: pointer;
      transition: all 0.15s ease;
      padding: 0;
    }

    .grid-action-btn:hover {
      background: rgba(30, 30, 30, 0.95);
      transform: scale(1.1);
    }

    .grid-action-btn svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* TTS button states */
    .grid-tts-btn:hover {
      color: #6366f1;
      border-color: #6366f1;
      box-shadow: 0 0 8px rgba(99, 102, 241, 0.3);
    }

    .grid-tts-btn[data-playing="1"] {
      background: rgba(99, 102, 241, 0.2);
      border-color: #6366f1;
      color: #6366f1;
      animation: grid-tts-pulse 1.5s ease-in-out infinite;
    }

    @keyframes grid-tts-pulse {
      0%, 100% { box-shadow: 0 0 6px rgba(99, 102, 241, 0.3); }
      50% { box-shadow: 0 0 12px rgba(99, 102, 241, 0.6); }
    }

    /* Copy button states */
    .grid-copy-btn:hover {
      color: var(--c-accent, var(--g-primary));
      border-color: var(--c-accent, var(--g-primary));
      box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }

    .grid-copy-btn[data-copied="1"] {
      background: rgba(34, 197, 94, 0.2);
      border-color: #22c55e;
      color: #22c55e;
    }

    /* Save button states */
    .grid-save-btn:hover {
      color: #3b82f6;
      border-color: #3b82f6;
      box-shadow: 0 0 8px rgba(59, 130, 246, 0.3);
    }

    .grid-save-btn[data-saving="1"] {
      opacity: 0.6;
      cursor: wait;
    }

    .grid-save-btn[data-saved="1"] {
      background: rgba(34, 197, 94, 0.2);
      border-color: #22c55e;
      color: #22c55e;
    }

    .chat-group-footer {
      display: flex;
      gap: 8px;
      font-size: 11px;
      color: var(--c-text-3, #666);
      padding-top: 4px;
    }

    .chat-sender-name { font-weight: 500; }

    /* Input area */
    .chat-input-area {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      background: rgba(0, 0, 0, 0.3);
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .chat-input-row {
      display: flex;
      gap: 8px;
    }

    .chat-input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.4);
      color: var(--c-text-1, #eee);
      font-size: 14px;
      font-family: inherit;
      outline: none;
      resize: none;
    }

    .chat-input:focus { border-color: var(--c-accent, var(--g-primary)); }

    /* Image attachments */
    .grid-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    }

    .grid-attachment {
      position: relative;
      width: 60px;
      height: 60px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .grid-attachment__img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .grid-attachment__remove {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 50%;
      background: rgba(239, 68, 68, 0.9);
      color: #fff;
      font-size: 12px;
      font-weight: bold;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.15s;
    }

    .grid-attachment:hover .grid-attachment__remove {
      opacity: 1;
    }

    .send-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border: none;
      border-radius: 8px;
      background: var(--c-accent, var(--g-primary));
      color: #000;
      cursor: pointer;
      transition: all 0.15s;
    }

    .send-btn:hover { transform: scale(1.05); }
    .send-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .send-btn svg { width: 18px; height: 18px; pointer-events: none; }

    .stop-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border: none;
      border-radius: 8px;
      background: #dc2626;
      color: #fff;
      cursor: pointer;
      transition: all 0.15s;
      animation: stop-pulse 1.5s ease-in-out infinite;
    }

    .stop-btn:hover {
      background: #ef4444;
      transform: scale(1.05);
    }

    .stop-btn svg {
      width: 16px;
      height: 16px;
      pointer-events: none; /* Don't block clicks on parent button */
    }

    /* Image Upload Button */
    .image-upload-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      background: transparent;
      color: var(--c-text-2, #888);
      cursor: pointer;
      transition: all 0.15s;
      flex-shrink: 0;
    }
    
    .image-upload-btn:hover {
      border-color: var(--c-accent, var(--g-primary));
      color: var(--c-accent, var(--g-primary));
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
    }
    
    .image-upload-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .image-upload-btn svg {
      width: 18px;
      height: 18px;
    }

    @keyframes stop-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.4); }
      50% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0); }
    }

    .send-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(0,0,0,0.2);
      border-top-color: #000;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 12px;
      color: var(--c-text-3);
    }

    .loading-spinner {
      width: 24px;
      height: 24px;
      border: 2px solid rgba(255, 255, 255, 0.1);
      border-top-color: var(--c-accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--c-text-3);
      font-size: 14px;
    }

    /* Fancy loading spinner - with panel-specific keyframes */
    .loading-fancy {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 40px;
      height: 100%;
      min-height: 120px;
    }

    .loading-fancy__spinner {
      position: relative;
      width: 48px;
      height: 48px;
    }

    .loading-fancy__ring {
      position: absolute;
      inset: 0;
      border: 2px solid transparent;
      border-radius: 50%;
    }

    .loading-fancy__ring:nth-child(1) {
      border-top-color: var(--g-primary);
      animation: panel-spin 1s linear infinite;
    }

    .loading-fancy__ring:nth-child(2) {
      border-right-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      animation: panel-spin 1.5s linear infinite reverse;
      inset: 4px;
    }

    .loading-fancy__ring:nth-child(3) {
      border-bottom-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
      animation: panel-spin 2s linear infinite;
      inset: 8px;
    }

    @keyframes panel-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .loading-fancy__text {
      font-size: 11px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      color: rgba(255,255,255,0.4);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      display: flex;
      align-items: center;
    }

    .loading-fancy__dots {
      display: inline-flex;
      gap: 4px;
      margin-left: 6px;
    }

    .loading-fancy__dot {
      width: 4px;
      height: 4px;
      background: var(--g-primary);
      border-radius: 50%;
      animation: panel-pulse 1.4s ease-in-out infinite;
    }

    .loading-fancy__dot:nth-child(2) { animation-delay: 0.2s; }
    .loading-fancy__dot:nth-child(3) { animation-delay: 0.4s; }
    
    @keyframes panel-pulse {
      0%, 100% { opacity: 0.4; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.2); }
    }

    @keyframes pulse-glow {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }

    /* Typing indicator - ENHANCED for visibility */
    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 4px;
    }

    .typing-indicator__dot {
      width: 10px;
      height: 10px;
      background: var(--g-primary);
      border-radius: 50%;
      animation: panel-typing-bounce 1.2s ease-in-out infinite;
      box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 60%, transparent);
    }

    .typing-indicator__dot:nth-child(2) { animation-delay: 0.15s; }
    .typing-indicator__dot:nth-child(3) { animation-delay: 0.3s; }

    @keyframes panel-typing-bounce {
      0%, 70%, 100% { transform: translateY(0); opacity: 0.6; }
      35% { transform: translateY(-8px); opacity: 1; }
    }

    .typing-indicator__text {
      margin-left: 8px;
      font-size: 12px;
      color: color-mix(in srgb, var(--g-primary) 80%, transparent);
      font-style: italic;
    }

    /* Streaming content styles */
    .streaming-bubble {
      position: relative;
    }

    .streaming-cursor {
      display: inline-block;
      color: var(--g-primary);
      animation: cursor-blink 1s step-end infinite;
      margin-left: 2px;
      font-weight: bold;
    }

    @keyframes cursor-blink {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }

    /* Content loaded animation */
    .content-loaded {
      animation: fade-in 0.3s ease;
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Sending state indicator in header - ENHANCED */
    .sending-status {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      font-size: 11px;
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-radius: 4px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      animation: panel-status-pulse 1s ease-in-out infinite;
    }
    
    @keyframes panel-status-pulse {
      0%, 100% { opacity: 0.7; box-shadow: 0 0 0 color-mix(in srgb, var(--g-primary) 0%, transparent); }
      50% { opacity: 1; box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 30%, transparent); }
    }

    .sending-status.streaming {
      color: #3b82f6;
      background: rgba(59, 130, 246, 0.15);
      border-color: rgba(59, 130, 246, 0.3);
    }

    .sending-status.streaming .loading-fancy__dot {
      background: #3b82f6;
    }

    .sending-status__text {
      font-family: var(--mono, 'JetBrains Mono', monospace);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 600;
    }

    /* Voice target indicator */
    .voice-target-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #22c55e;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 4px;
      animation: voice-badge-pulse 1.5s ease-in-out infinite;
    }

    .voice-target-badge svg {
      stroke: #22c55e;
    }

    @keyframes voice-badge-pulse {
      0%, 100% { opacity: 0.8; box-shadow: 0 0 0 rgba(34, 197, 94, 0); }
      50% { opacity: 1; box-shadow: 0 0 8px rgba(34, 197, 94, 0.4); }
    }

    /* Live call badge — appears next to title while a panel call is active */
    .call-live-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #22c55e;
      background: rgba(34, 197, 94, 0.16);
      border: 1px solid rgba(34, 197, 94, 0.5);
      border-radius: 4px;
      box-shadow: 0 0 12px rgba(34, 197, 94, 0.35);
      animation: call-live-pulse 1.4s ease-in-out infinite;
    }
    .call-live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 6px #22c55e;
      animation: call-live-dot 1s ease-in-out infinite;
    }
    @keyframes call-live-pulse {
      0%, 100% { box-shadow: 0 0 12px rgba(34, 197, 94, 0.35); }
      50%      { box-shadow: 0 0 22px rgba(34, 197, 94, 0.7); }
    }
    @keyframes call-live-dot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50%      { transform: scale(1.35); opacity: 0.65; }
    }

    /* Size indicator overlay - shows during resize */
    .resize-size-indicator {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      padding: 8px 16px;
      background: rgba(0, 0, 0, 0.85);
      border: 1px solid color-mix(in srgb, var(--g-primary) 40%, transparent);
      border-radius: 8px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      font-size: 12px;
      font-weight: 600;
      color: var(--g-primary);
      pointer-events: none;
      z-index: 100;
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      animation: size-indicator-in 0.1s ease-out;
    }

    @keyframes size-indicator-in {
      from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
      to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }

    .resize-size-indicator__dim {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .resize-size-indicator__value {
      color: #fff;
    }

    .resize-size-indicator__unit {
      color: rgba(255, 255, 255, 0.5);
      font-size: 10px;
    }

    .resize-size-indicator__x {
      color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    }

    /* Enhanced wake word badge - active listening state */
    .wake-word-badge--active {
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.2) 0%, rgba(59, 130, 246, 0.2) 100%);
      border-color: #22c55e;
      color: #22c55e;
      animation: wake-active-pulse 0.8s ease-in-out infinite;
    }

    .wake-word-badge--active svg {
      color: #22c55e;
      animation: wake-mic-active 0.5s ease-in-out infinite;
    }

    @keyframes wake-active-pulse {
      0%, 100% { 
        box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4);
        border-color: #22c55e;
      }
      50% { 
        box-shadow: 0 0 12px 4px rgba(34, 197, 94, 0.3);
        border-color: rgba(34, 197, 94, 0.8);
      }
    }

    @keyframes wake-mic-active {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.2); }
    }

    /* Panel outline when voice is targeting it */
    :host(.voice-target) {
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 
                  0 0 0 2px #22c55e,
                  0 0 20px rgba(34, 197, 94, 0.3) !important;
    }

    :host(.voice-target) .panel {
      border-color: rgba(34, 197, 94, 0.5);
    }

    /* Resizing state on host */
    :host(.resizing) {
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 
                  0 0 0 2px var(--g-primary),
                  0 0 20px color-mix(in srgb, var(--g-primary) 30%, transparent) !important;
    }

    :host(.resizing) .panel {
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    }

    /* ============================================================
       MOBILE PANEL STYLES
       ============================================================ */
    
    @media (max-width: 768px) {
      :host {
        box-shadow: none;
      }

      .panel {
        border-radius: 8px;
        box-shadow: none;
        content-visibility: auto;
      }

      .panel-content,
      .chat-messages {
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        scroll-behavior: smooth;
      }

      .term-card,
      .xterm {
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
      }

      .panel-header {
        min-height: 40px;
      }

      .panel-header__main {
        padding: 0 8px;
        gap: 6px;
      }

      .panel-title {
        font-size: 12px;
      }

      .panel-controls {
        gap: 2px;
        padding-right: 4px;
      }

      .panel-ctrl-btn {
        width: 32px;
        height: 32px;
      }

      /* Hide stats on mobile panels */
      .panel-stats {
        display: none;
      }

      /* Hide wake word badge on mobile */
      .wake-word-badge {
        display: none;
      }

      /* Compact chat input */
      .chat-input-area {
        padding: 8px;
        gap: 6px;
      }

      .chat-input {
        padding: 8px 10px;
        font-size: 16px; /* Prevent iOS zoom */
        min-height: 40px;
      }

      .send-btn, .stop-btn {
        width: 40px;
        height: 40px;
        min-width: 40px;
      }

      /* Chat messages compact */
      .chat-messages {
        padding: 10px;
        gap: 12px;
      }

      .chat-avatar {
        width: 28px;
        height: 28px;
        min-width: 28px;
        font-size: 12px;
      }

      .chat-bubble {
        padding: 8px 10px;
        font-size: 14px;
      }

      /* Keep resize available on touch, but reveal the affordance only after
         a short press so casual scrolling near an edge does not flash grips. */
      .resize-handle {
        touch-action: none;
        opacity: 0;
        transition-delay: 300ms;
      }
      .panel:hover .resize-handle,
      :host(.resizing) .resize-handle {
        opacity: 1;
        transition-delay: 300ms;
      }
      .resize-n { top: -4px; left: 16px; right: 16px; height: 16px; }
      .resize-s { bottom: -4px; left: 16px; right: 16px; height: 16px; }
      .resize-e { right: -4px; top: 16px; bottom: 16px; width: 16px; }
      .resize-w { left: -4px; top: 16px; bottom: 16px; width: 16px; }
      .resize-ne,
      .resize-nw,
      .resize-se,
      .resize-sw {
        width: 24px;
        height: 24px;
      }
    }

    /* Small mobile */
    @media (max-width: 480px) {
      .panel-header {
        min-height: 36px;
      }

      .panel-led {
        width: 5px;
        height: 5px;
      }

      .panel-title {
        font-size: 11px;
      }

      .panel-ctrl-btn {
        width: 28px;
        height: 28px;
      }

      .panel-ctrl-btn svg {
        width: 12px;
        height: 12px;
      }

      .chat-messages {
        padding: 8px;
        gap: 10px;
      }

      .chat-group-messages {
        max-width: calc(100% - 36px);
      }

      .chat-avatar {
        width: 24px;
        height: 24px;
        min-width: 24px;
        font-size: 10px;
      }

      .chat-bubble {
        padding: 6px 8px;
        font-size: 13px;
      }

      .chat-input-area {
        padding: 6px;
      }

      .chat-input {
        padding: 6px 8px;
        min-height: 36px;
      }

      .send-btn, .stop-btn {
        width: 36px;
        height: 36px;
        min-width: 36px;
      }
    }

    /* Landscape mobile - minimal chrome */
    @media (max-height: 500px) and (orientation: landscape) {
      .panel-header {
        min-height: 32px;
      }

      .panel-header__main {
        padding: 0 6px;
      }

      .panel-stats {
        display: none;
      }

      .panel-controls {
        padding-right: 2px;
      }

      .panel-ctrl-btn {
        width: 28px;
        height: 28px;
      }

      .chat-messages {
        padding: 6px 8px;
        gap: 8px;
      }

      .chat-input-area {
        padding: 4px 6px;
      }

      .chat-input {
        min-height: 32px;
        padding: 4px 8px;
      }

      .send-btn, .stop-btn {
        width: 32px;
        height: 32px;
        min-width: 32px;
      }
    }

    /* ============================================================
       Inline Tool Activity - Integrated with streaming response
       ============================================================ */
    .inline-tool-activity {
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 3%, transparent) 0%, rgba(139, 92, 246, 0.03) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-radius: 10px;
      margin: 8px 0;
      overflow: hidden;
      transition: all 0.25s ease;
    }

    .inline-tool-activity.collapsed {
      background: color-mix(in srgb, var(--g-primary) 2%, transparent);
    }

    .tool-activity-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      transition: background 0.15s;
    }

    .tool-activity-header:hover {
      background: rgba(255, 255, 255, 0.03);
    }

    .tool-activity-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--c-text-2, #888);
    }

    .tool-activity-status.active {
      color: var(--g-primary);
    }

    .status-pulse {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    .tool-activity-status.active .status-pulse {
      animation: status-pulse 1.5s ease-in-out infinite;
      box-shadow: 0 0 8px currentColor;
    }

    @keyframes status-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }

    .tool-activity-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      font-size: 10px;
      font-weight: 600;
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      color: var(--g-primary);
      border-radius: 9px;
    }

    .tool-activity-toggle {
      margin-left: auto;
      font-size: 10px;
      color: var(--c-text-3, #666);
      transition: transform 0.2s;
    }

    .tool-activity-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 0 8px 8px 8px;
      max-height: 150px;
      overflow-y: auto;
    }

    .tool-activity-list::-webkit-scrollbar {
      width: 4px;
    }

    .tool-activity-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
    }

    .inline-tool-card {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      font-size: 11px;
      transition: all 0.15s;
    }

    .inline-tool-card:hover {
      background: rgba(0, 0, 0, 0.4);
      border-color: rgba(255, 255, 255, 0.1);
    }

    .inline-tool-card.running {
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      background: color-mix(in srgb, var(--g-primary) 5%, transparent);
    }

    .inline-tool-card.error {
      border-color: rgba(239, 68, 68, 0.3);
      background: rgba(239, 68, 68, 0.05);
    }

    .inline-tool-card.complete {
      border-color: rgba(34, 197, 94, 0.2);
    }

    .tool-icon {
      font-size: 12px;
      flex-shrink: 0;
    }

    .tool-name {
      font-weight: 500;
      color: var(--c-text-1, #ccc);
      white-space: nowrap;
    }

    .tool-path {
      font-family: var(--mono, monospace);
      font-size: 10px;
      color: var(--c-text-3, #666);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 150px;
    }

    .tool-status {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--c-text-2, #888);
      font-size: 10px;
    }

    .inline-tool-card.running .tool-status {
      color: var(--g-primary);
    }

    .inline-tool-card.complete .tool-status {
      color: #22c55e;
    }

    .inline-tool-card.error .tool-status {
      color: #ef4444;
    }

    .tool-spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-top-color: var(--g-primary);
      border-radius: 50%;
      animation: tool-spin 0.7s linear infinite;
    }

    @keyframes tool-spin {
      to { transform: rotate(360deg); }
    }

    .tool-time {
      font-family: var(--mono, monospace);
      font-size: 9px;
      opacity: 0.7;
    }

    /* Mobile optimization for tool activity */
    @media (max-width: 480px) {
      .inline-tool-activity {
        margin: 4px 0;
      }

      .tool-activity-header {
        padding: 6px 10px;
      }

      .tool-activity-list {
        max-height: 100px;
      }

      .inline-tool-card {
        padding: 4px 8px;
      }

      .tool-path {
        display: none;
      }
    }

    /* ============================================================
       Live Canvas Preview Pane - Gold Gradient Sleek Design
       ============================================================ */
    .canvas-preview-inline {
      margin: 12px 0;
      border-radius: 16px;
      overflow: hidden;
      background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%);
      border: 2px solid transparent;
      background-clip: padding-box;
      position: relative;
      animation: canvas-slide-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .canvas-preview-inline::before {
      content: '';
      position: absolute;
      inset: -2px;
      border-radius: 18px;
      background: linear-gradient(135deg, var(--g-primary) 0%, #FFA500 25%, var(--g-primary) 50%, #B8860B 75%, var(--g-primary) 100%);
      z-index: -1;
      animation: gold-shimmer 3s ease-in-out infinite;
    }

    @keyframes canvas-slide-in {
      0% { opacity: 0; transform: translateY(20px) scale(0.95); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes gold-shimmer {
      0%, 100% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
    }

    .canvas-preview-inline.building::before {
      animation: gold-pulse 1.5s ease-in-out infinite, gold-shimmer 3s ease-in-out infinite;
    }

    @keyframes gold-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }

    .canvas-preview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, rgba(255, 165, 0, 0.05) 100%);
      cursor: pointer;
      transition: background 0.2s;
    }

    .canvas-preview-header:hover {
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 12%, transparent) 0%, rgba(255, 165, 0, 0.08) 100%);
    }

    .canvas-preview-header__left {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .canvas-preview-header__icon {
      font-size: 18px;
      filter: drop-shadow(0 0 4px color-mix(in srgb, var(--g-primary) 50%, transparent));
    }

    .canvas-preview-header__title {
      font-size: 12px;
      font-weight: 700;
      background: linear-gradient(90deg, var(--g-primary), #FFA500, var(--g-primary));
      background-size: 200% auto;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      text-transform: uppercase;
      letter-spacing: 1px;
      animation: gold-text-shimmer 2s linear infinite;
    }

    @keyframes gold-text-shimmer {
      0% { background-position: 0% center; }
      100% { background-position: 200% center; }
    }

    .canvas-preview-header__badge {
      font-size: 9px;
      padding: 3px 8px;
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.3) 0%, rgba(16, 185, 129, 0.2) 100%);
      color: #4ade80;
      border-radius: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      box-shadow: 0 0 8px rgba(34, 197, 94, 0.3);
    }

    .canvas-preview-header__badge.building {
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 30%, transparent) 0%, rgba(255, 165, 0, 0.2) 100%);
      color: var(--g-primary);
      box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 40%, transparent);
      animation: badge-pulse 1s ease-in-out infinite;
    }

    @keyframes badge-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    .canvas-preview-header__controls {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .canvas-preview-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 8px;
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      color: var(--g-primary);
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .canvas-preview-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      color: #fff;
      transform: scale(1.1);
      box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }

    .canvas-preview-btn svg {
      width: 14px;
      height: 14px;
    }

    .canvas-preview-body {
      height: 180px;
      background: #fff;
      border-radius: 0 0 14px 14px;
      overflow: hidden;
      transition: height 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .canvas-preview-body.expanded {
      height: 300px;
    }

    .canvas-preview-body iframe {
      width: 100%;
      height: 100%;
      border: none;
    }

    /* Old pane styles for toggle button version */
    .canvas-preview-pane {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border-top: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      overflow: hidden;
      transition: height 0.3s ease;
    }

    .canvas-preview-pane.collapsed {
      height: 40px !important;
    }

    .canvas-preview-pane.expanded {
      height: 250px;
    }

    .canvas-preview-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      font-size: 10px;
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
    }

    .canvas-preview-toggle:hover {
      background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    }

    .canvas-preview-toggle svg {
      width: 12px;
      height: 12px;
    }

    /* Per-panel voice settings modal */
    .pcv-modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      animation: pcvFade 120ms ease-out;
    }
    @keyframes pcvFade { from { opacity: 0; } to { opacity: 1; } }

    .pcv-modal {
      width: min(440px, 92vw);
      max-height: 84vh;
      overflow: auto;
      background: linear-gradient(155deg, rgba(10,10,14,0.98), rgba(16,16,22,0.98));
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      border-radius: 14px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.02);
      color: rgba(255,255,255,0.92);
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
    }
    .pcv-modal__head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .pcv-modal__title {
      flex: 1;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--g-primary);
    }
    .pcv-modal__close {
      width: 22px;
      height: 22px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      background: transparent;
      color: rgba(255,255,255,0.5);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pcv-modal__close:hover {
      color: #ef4444;
      border-color: rgba(239,68,68,0.5);
      background: rgba(239,68,68,0.08);
    }
    .pcv-modal__body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .pcv-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .pcv-label {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.5);
    }
    .pcv-hint {
      font-size: 10px;
      color: rgba(255,255,255,0.35);
      line-height: 1.4;
    }
    .pcv-input {
      width: 100%;
      padding: 8px 10px;
      font-family: inherit;
      font-size: 12px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 7px;
      color: rgba(255,255,255,0.9);
      outline: none;
    }
    .pcv-input:focus {
      border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      background: rgba(255,255,255,0.06);
    }
    .pcv-range {
      width: 100%;
      accent-color: var(--g-primary);
    }
    .pcv-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: rgba(255,255,255,0.7);
      cursor: pointer;
    }
    .pcv-toggle input { accent-color: var(--g-primary); }
    .pcv-actions {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }
    .pcv-btn {
      flex: 1;
      padding: 9px 12px;
      font-family: inherit;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      border-radius: 7px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.85);
      cursor: pointer;
      transition: all 0.15s;
    }
    .pcv-btn:hover {
      background: rgba(255,255,255,0.08);
    }
    .pcv-btn--primary {
      background: color-mix(in srgb, var(--g-primary) 18%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
      color: var(--g-primary);
    }
    .pcv-btn--primary:hover {
      background: color-mix(in srgb, var(--g-primary) 28%, transparent);
    }
    .pcv-btn--danger {
      background: rgba(239,68,68,0.14);
      border-color: rgba(239,68,68,0.45);
      color: #ef4444;
    }
    .pcv-btn--danger:hover {
      background: rgba(239,68,68,0.22);
    }

    /* ── Premium glass layer (styles/glass, docs/ui/GLASS.md) ───────────
       Surfaces/colours only — sizes and the mobile overrides above are left
       alone. Reads the global --glass-* tokens (they pierce the shadow root).
       One backdrop blur per panel; nothing inside adds its own. */
    .panel {
      background: var(--glass-sheen), var(--glass-tint), var(--glass-2, rgba(8, 8, 8, 0.75));
      backdrop-filter: var(--glass-blur, blur(24px));
      -webkit-backdrop-filter: var(--glass-blur, blur(24px));
      border: 1px solid var(--glass-stroke-strong, rgba(255, 255, 255, 0.1));
      border-top-color: color-mix(in srgb, var(--glass-gold, #fbbf24) 30%, transparent);
      border-radius: var(--glass-radius, 14px);
      box-shadow: var(--glass-elev-2);
      font-family: var(--glass-font, inherit);
    }
    .panel-header {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent), color-mix(in srgb, var(--glass-base, #000) 30%, transparent);
      border-bottom: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08));
    }
    .chat-avatar { border-radius: 10px; }
    .chat-avatar.chat-logo-avatar {
      background: var(--glass-gold-a10);
      border-color: var(--glass-stroke-gold);
      box-shadow: 0 4px 12px -4px var(--glass-gold-a40);
    }
    .chat-bubble { letter-spacing: -0.003em; }
    .chat-group.user .chat-bubble {
      background: var(--glass-gold-tint);
      border: 1px solid color-mix(in srgb, var(--glass-gold, #fbbf24) 34%, transparent);
      border-radius: 16px 16px 5px 16px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 10px 24px -16px var(--glass-gold-a40);
      color: var(--glass-fg);
    }
    .chat-group.assistant .chat-bubble {
      background: var(--glass-sheen), var(--glass-3, rgba(255, 255, 255, 0.05));
      border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08));
      border-top-color: var(--glass-stroke-strong);
      border-radius: 16px 16px 16px 5px;
      box-shadow: var(--glass-elev-1);
      color: var(--glass-fg);
    }
    .chat-bubble code {
      font-family: var(--glass-font-mono, monospace);
      background: var(--glass-gold-a10);
      border: 1px solid var(--glass-stroke-gold);
      color: var(--glass-gold-hi);
    }
    .chat-bubble pre { border-radius: 10px; border: 1px solid var(--glass-stroke); background: color-mix(in srgb, var(--glass-base, #000) 70%, transparent); }
    .chat-bubble pre code { border: 0; background: none; color: inherit; }
    .inline-tool-card {
      background: var(--glass-sheen), var(--glass-hover, rgba(0, 0, 0, 0.3));
      border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.06));
      border-radius: 10px;
      box-shadow: var(--glass-specular);
      transition: border-color var(--glass-dur-fast, 0.15s), transform var(--glass-dur-fast, 0.15s) var(--glass-spring, ease);
    }
    .inline-tool-card:hover { border-color: var(--glass-stroke-gold); transform: var(--glass-lift, none); }
    .inline-tool-card.running { border-color: var(--glass-stroke-gold); box-shadow: var(--glass-specular), 0 0 16px -6px var(--glass-gold-a40); }
    .chat-input-area {
      background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--glass-base, #000) 28%, transparent));
      border-top: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08));
    }
    .chat-input {
      border: 1px solid var(--glass-stroke-strong, rgba(255, 255, 255, 0.15));
      border-radius: 12px;
      background: var(--glass-sheen), color-mix(in srgb, var(--glass-base, #000) 40%, transparent);
      color: var(--glass-fg, #eee);
      font-family: var(--glass-font, inherit);
      transition: border-color var(--glass-dur, 0.2s), box-shadow var(--glass-dur, 0.2s);
    }
    .chat-input::placeholder { color: var(--glass-fg-4); }
    .chat-input:focus {
      border-color: color-mix(in srgb, var(--glass-gold, #fbbf24) 60%, transparent);
      box-shadow: var(--glass-focus-ring), 0 0 30px -12px var(--glass-gold-a40);
    }
    .send-btn {
      border-radius: 12px;
      background: var(--glass-gold-fill, var(--g-primary));
      color: var(--glass-ink, #000);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 6px 18px -8px var(--glass-gold-a40);
    }
    .send-btn:active { transform: scale(0.95); }
    .chat-bubble table { border-collapse: separate; border-spacing: 0; margin: 0.6em 0; border: 1px solid var(--glass-stroke); border-radius: 10px; overflow: hidden; font-variant-numeric: tabular-nums; }
    .chat-bubble th, .chat-bubble td { padding: 6px 12px; text-align: left; border-bottom: 1px solid var(--glass-stroke); }
    .chat-bubble tr:last-child td { border-bottom: 0; }
    .chat-bubble th { background: var(--glass-hover); color: var(--glass-fg-3); font-size: 10.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
    :host-context([data-theme="light"]) .panel-header { background: linear-gradient(180deg, rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.4)); }
    :host-context([data-theme="light"]) .panel-title,
    :host-context([data-theme="light"]) .agent-selector__trigger,
    :host-context([data-theme="light"]) .model-selector__trigger,
    :host-context([data-theme="light"]) .model-selector-stat { color: var(--glass-fg-2); }
    :host-context([data-theme="light"]) .panel-header__main { border-right-color: var(--glass-stroke); }

    /* Secure Mode: lane strip above the input + emerald frame on secure panels. */
    .mp-sec-row { padding: 0 0 6px; }
    .mp-sec-note { font-size: 11px; color: var(--ib-secure, #34d399); opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .panel.panel--secure {
      border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.5));
      box-shadow: var(--ib-secure-glow, 0 0 0 1px rgba(52, 211, 153, 0.35)), 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .panel.panel--secure .chat-input { border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); }
    .panel-header .ibss-badge { margin-left: 2px; padding: 1px 7px; font-size: 10px; }
    .panel-header .ibss-badge svg { width: 10px; height: 10px; }
  `, secureSurfaceStyles];

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Object }) client: any = null;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;
  @property({ type: Boolean }) showSizeIndicator = false;
  @property({ type: Boolean }) showAiIde = true;

  @state() private inputValue = "";
  @state() private messages: Array<{ role: string; content: string; images?: ImageData[]; timestamp?: number; panelRefs?: ChatPanelRef[] }> = [];
  @state() private rawMessages: unknown[] = []; // Keep raw messages for tool extraction
  @state() private loading = false;
  @state() private loadedSessionKey: string | null = null;
  /** Composer Secure Mode toggle (shared store; per-panel session memory). */
  private readonly secureLane = new SecureSurfaceLane(this);
  @state() private sending = false;
  @state() private sessionInfo: { model?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number; updatedAt?: number } = {};
  @state() private isCompact = false;
  @state() private attachments: Array<{ id: string; dataUrl: string; mimeType: string }> = [];
  @state() private showSlashPreview = false;
  @state() private chatRenderStartIdx = 0;
  @state() private chatRenderEndIdx = 80;
  private chatScrollEl: HTMLElement | null = null;
  private chatScrollFrame: number | null = null;
  private readonly estimatedChatGroupHeight = 180;
  private readonly chatWindowBuffer = 20;
  
  // Streaming state
  @state() private streamingContent: string | null = null;
  @state() private runId: string | null = null;
  @state() private streamStartedAt: number | null = null;
  
  // Rename state
  @state() private isRenaming = false;
  @state() private renameValue = "";
  
  // Wake word edit state
  @state() private isEditingWakeWord = false;
  @state() private wakeWordEditValue = "";
  
  // Centralized voice state
  @state() private isVoiceTarget = false;
  @state() private voiceInterim = "";


  // AI IDE state - extracted tool executions from messages
  @state() private aiIdeCollapsed = false;
  
  // Live Canvas Preview state
  @state() private showCanvasPreview = false;
  @state() private canvasPreviewExpanded = false;
  @state() private canvasWasUsedInSession = false; // Persistent flag - stays true once canvas is used
  
  // Agent selector state
  @state() private selectedAgent: string = "";
  @state() private availableAgents: Array<{ id: string; name: string }> = [];
  @state() private showAgentDropdown = false;
  
  // Model selector state
  @property({ type: Array }) availableModels: ModelOption[] = [];
  @state() private showModelDropdown = false;
  // Inline provider-setup modal (replaces the old full /quickstart popup): paste
  // the chosen provider's API key and pick one of its models, all without leaving
  // the chat panel. `connected` flips to the model-pick step after the key saves.
  @state() private providerSetup: {
    provider: string;
    key: string;
    modelId: string;
    saving: boolean;
    connected: boolean;
    error: string;
  } | null = null;
  @state() private modelSearchQuery = "";
  @state() private modelProviderFilter: string | null = null;
  @state() private modelCapabilityFilter = new Set<ModelCapability>();
  @state() private modelTierFilter: "s" | "m" | "l" | null = null;
  @state() private modelDropdownPos: { top: number; left: number } = { top: 0, left: 0 };
  
  // Federation/Node selector state
  @state() private federationNodes: FederationNode[] = [];
  @state() private currentNodeId: string | null = null;
  @state() private localNodeId: string | null = null;
  @state() private federationLoading = false;

  private resizeObserver: ResizeObserver | null = null;
  private eventUnsubscribe: (() => void) | null = null;

  // Dropped-terminal-event watchdog: if the socket loses a final/error/aborted
  // event the panel would spin forever. Deltas reset this timer; on prolonged
  // silence we reconcile against the store and clear the stuck spinner.
  private streamWatchdog: ReturnType<typeof setTimeout> | null = null;
  private static readonly STREAM_WATCHDOG_MS = 45000;

  private clearStreamWatchdog() {
    if (this.streamWatchdog) {
      clearTimeout(this.streamWatchdog);
      this.streamWatchdog = null;
    }
  }

  private armStreamWatchdog() {
    this.clearStreamWatchdog();
    const runId = this.runId;
    const sessionKey = this.panel?.sessionKey;
    if (!runId) return;
    this.streamWatchdog = setTimeout(async () => {
      if (this.runId !== runId || this.panel?.sessionKey !== sessionKey) return;
      try {
        await this.loadHistory();
      } catch {
        /* best-effort reconciliation */
      }
      if (this.runId !== runId || this.panel?.sessionKey !== sessionKey) return;
      const last = this.messages[this.messages.length - 1] as
        | { role?: string }
        | undefined;
      if (last && String(last.role).toLowerCase() === "assistant") {
        // Store already ends with the reply → terminal event was lost. Clear
        // the stuck spinner; the reply is on screen.
        this.streamingContent = null;
        this.runId = null;
        this.streamStartedAt = null;
        this.sending = false;
      } else {
        // Still genuinely running — keep watching.
        this.armStreamWatchdog();
      }
    }, MasonryPanel.STREAM_WATCHDOG_MS);
  }

  connectedCallback() {
    super.connectedCallback();
    const persistedNodeId = this.panel?.chatNodeId ?? this.panel?.nodeId;
    if (persistedNodeId) this.currentNodeId = persistedNodeId;
    this.loadHistory();
    this.loadSessionInfo();
    this.subscribeToEvents();
    this.loadAvailableAgents();
    this.loadFederationNodes();

    // Watch for size changes to toggle compact mode
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        const wasCompact = this.isCompact;
        this.isCompact = width < 400;
        if (wasCompact !== this.isCompact) {
          this.setAttribute('data-compact', this.isCompact ? '' : null as any);
          if (!this.isCompact) this.removeAttribute('data-compact');
        }
      }
    });
    this.resizeObserver.observe(this);
    
    // Register with centralized voice system

    // Hydrate the shared TTS controller settings (speed, voice, format) from
    // localStorage so the tts-button context-menu slider persists across reloads.
    loadTTSSettings();

  }

  private getChatNodeId(): string {
    return (
      this.panel?.chatNodeId ??
      this.panel?.nodeId ??
      this.currentNodeId ??
      "local"
    ).trim() || "local";
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.clearStreamWatchdog();
    this.eventUnsubscribe?.();
    this.eventUnsubscribe = null;
    this.chatScrollEl?.removeEventListener("scroll", this.handleChatScroll);
    this.chatScrollEl = null;
    if (this.chatScrollFrame !== null) {
      cancelAnimationFrame(this.chatScrollFrame);
      this.chatScrollFrame = null;
    }
  }
  
  /**
   * The panel's phone button starts a voice call with its agent, bound to
   * THIS panel's chat session (turns + transcript land here).
   */
  private startCall() {
    const key = this.panel?.sessionKey ?? "";
    const agentId = key.split(":")[0] === "agent" ? key.split(":")[1] || undefined : undefined;
    startRobovoiceVoiceCall({ agentId, sessionKey: key || undefined, source: "grid-panel" });
  }

  private subscribeToEvents() {
    if (!this.client || this.eventUnsubscribe) return;
    
    // Subscribe to chat events from the gateway client
    const handler = (evt: { event: string; payload?: any }) => {
      // Debug: log all events for this panel's session
      if (evt.payload?.sessionKey === this.panel?.sessionKey) {
        console.log(`[MasonryPanel:${this.panel?.id}] Event:`, evt.event, evt.payload?.state, evt.payload?.runId);
      }
      if (evt.event === "chat") {
        this.handleChatEvent(evt.payload);
      } else if (evt.event === "agent") {
        const notice = parseModelFallbackNotice(evt.payload);
        if (notice && notice.sessionKey === this.panel?.sessionKey) {
          this.messages = [
            ...this.messages,
            { role: "assistant", content: formatModelFallbackNotice(notice), timestamp: Date.now() },
          ];
        }
      }
    };
    
    // Use the gateway client's subscribe method
    if (typeof this.client.subscribe === "function") {
      this.eventUnsubscribe = this.client.subscribe(handler);
      console.log(`[MasonryPanel:${this.panel?.id}] Subscribed to events for session:`, this.panel?.sessionKey);
    }
  }

  private handleChatEvent(payload?: { sessionKey?: string; runId?: string; state?: string; message?: unknown; errorMessage?: string; errorCode?: string; errorHint?: string }) {
    if (!payload) return;
    
    // Only handle events for THIS panel's session
    if (payload.sessionKey !== this.panel?.sessionKey) return;
    
    // Ignore events from different runs (e.g., other tabs)
    if (payload.runId && this.runId && payload.runId !== this.runId) {
      // But if it's a final from another run, we might want to refresh
      if (payload.state === "final") {
        void this.loadHistory();
      }
      return;
    }

    if (payload.state === "delta") {
      // Extract text from the message
      const content = extractText(payload.message);
      if (typeof content === "string") {
        // Only update if new content is longer (progressive streaming)
        if (!this.streamingContent || content.length >= this.streamingContent.length) {
          this.streamingContent = content;
          this.scrollToBottom();
        }
      }
      // Every token resets the dropped-terminal watchdog.
      this.armStreamWatchdog();
    } else if (payload.state === "final") {
      this.clearStreamWatchdog();
      // Capture the just-finished assistant text before clearing so we can
      // auto-speak it when this panel is in a voice call.
      const finalText = this.streamingContent;
      // Streaming complete - refresh history to get final message
      this.streamingContent = null;
      this.runId = null;
      this.streamStartedAt = null;
      this.sending = false;

      // Optimistically commit the finished reply to the visible transcript
      // BEFORE reloading history. The `final` event can arrive before the
      // assistant message is flushed to the session store (the backend writes
      // it in an async .then), and for satellite panels the history re-read is
      // tunnelled to master and can transiently return nothing. Without this,
      // loadHistory() would replace messages with an empty list and the panel
      // would blank back to the "Start a conversation..." placeholder, losing
      // the reply that just streamed. loadHistory() reconciles right after and
      // replaces this with the authoritative persisted list (no duplication).
      const committedReply = extractText(payload.message) || finalText || "";
      if (committedReply && committedReply.trim()) {
        this.messages = [
          ...this.messages,
          { role: "assistant", content: committedReply, timestamp: Date.now() },
        ];
      }

      void this.loadHistory();
      void this.loadSessionInfo();

        } else if (payload.state === "aborted") {
      this.clearStreamWatchdog();
      // Keep whatever streamed before the stop so the partial reply doesn't vanish.
      const partial = this.streamingContent;
      this.streamingContent = null;
      this.runId = null;
      this.streamStartedAt = null;
      this.sending = false;
      if (partial && partial.trim()) {
        this.messages = [
          ...this.messages,
          { role: "assistant", content: partial, timestamp: Date.now() },
        ];
      }
      void this.loadHistory();
    } else if (payload.state === "error") {
      this.clearStreamWatchdog();
      // Preserve any text streamed before the error, then surface the error —
      // without this a mid-stream error dropped the partial reply entirely.
      const partial = this.streamingContent;
      this.streamingContent = null;
      this.runId = null;
      this.streamStartedAt = null;
      this.sending = false;
      if (partial && partial.trim()) {
        this.messages = [
          ...this.messages,
          { role: "assistant", content: partial, timestamp: Date.now() },
        ];
      }
      // Add error message
      this.messages = [
        ...this.messages,
        { role: "assistant", content: formatChatErrorText(payload), timestamp: Date.now() },
      ];
      void this.loadHistory();
    }
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("isActive") || changed.has("isDragging") || changed.has("isResizing")) {
      this.classList.toggle("active", this.isActive);
      this.classList.toggle("dragging", this.isDragging);
      this.classList.toggle("resizing", this.isResizing);
    }
    this.classList.toggle("secure", isSecureSessionKey(this.panel?.sessionKey));
    
    // Voice target class
    if (changed.has("isVoiceTarget")) {
      this.classList.toggle("voice-target", this.isVoiceTarget);
    }

    if (changed.has("panel")) {
      const persistedNodeId = this.panel?.chatNodeId ?? this.panel?.nodeId;
      if (persistedNodeId && persistedNodeId !== this.currentNodeId) {
        this.currentNodeId = persistedNodeId;
      }
    }

    if (changed.has("panel") && this.panel?.sessionKey !== this.loadedSessionKey) {
      // Save current attachments to old session before switching
      const oldKey = this.loadedSessionKey;
      if (oldKey && this.attachments.length > 0) {
        setSessionAttachments(oldKey, this.attachments);
      }
      
      // Restore attachments from new session
      if (this.panel?.sessionKey) {
        this.attachments = getSessionAttachments(this.panel.sessionKey);
      }
      
      this.loadHistory();
      this.loadSessionInfo();
    }

    // Subscribe when client becomes available
    if (changed.has("client") && this.client && !this.eventUnsubscribe) {
      this.subscribeToEvents();
    }

    if (changed.has("messages") || changed.has("streamingContent")) {
      this.updateChatRenderWindow();
      this.scrollToBottom();
    }
    this.syncChatScrollListener();
    
    // Debug: log when availableModels changes
    if (changed.has("availableModels")) {
      console.log("[MasonryPanel] availableModels updated:", this.availableModels?.length, this.availableModels);
    }
  }

  private scrollToBottom() {
    requestAnimationFrame(() => {
      const container = this.shadowRoot?.querySelector('.chat-messages');
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  private syncChatScrollListener() {
    const next = this.shadowRoot?.querySelector<HTMLElement>(".chat-messages") ?? null;
    if (next === this.chatScrollEl) return;
    this.chatScrollEl?.removeEventListener("scroll", this.handleChatScroll);
    this.chatScrollEl = next;
    this.chatScrollEl?.addEventListener("scroll", this.handleChatScroll, { passive: true });
    this.updateChatRenderWindow();
  }

  private handleChatScroll = () => {
    if (this.chatScrollFrame !== null) return;
    this.chatScrollFrame = requestAnimationFrame(() => {
      this.chatScrollFrame = null;
      this.updateChatRenderWindow();
    });
  };

  private updateChatRenderWindow() {
    const groupCount = this.groupMessages().length;
    const container = this.chatScrollEl;
    if (!container || groupCount <= 80) {
      this.chatRenderStartIdx = 0;
      this.chatRenderEndIdx = groupCount;
      return;
    }
    const visibleStart = Math.floor(container.scrollTop / this.estimatedChatGroupHeight);
    const visibleCount = Math.ceil(container.clientHeight / this.estimatedChatGroupHeight);
    const start = Math.max(0, visibleStart - this.chatWindowBuffer);
    const end = Math.min(groupCount, visibleStart + visibleCount + this.chatWindowBuffer);
    if (start !== this.chatRenderStartIdx || end !== this.chatRenderEndIdx) {
      this.chatRenderStartIdx = start;
      this.chatRenderEndIdx = end;
    }
  }

  private async loadHistory() {
    if (!this.client || !this.panel?.sessionKey) return;

    // When the bound session changes, an empty result is legitimate (the new
    // session may have no history) and must clear the panel. While streaming
    // on the SAME session, an empty read is a race and must NOT wipe the
    // visible transcript — see the guard on the assignment below.
    const switchingSession = this.loadedSessionKey !== this.panel.sessionKey;

    this.loading = true;
    this.loadedSessionKey = this.panel.sessionKey;

    try {
      // When this panel is bound to a remote federation node (master or
      // peer satellite), the run actually executes on that device — the
      // assistant's reply lives in *master's* chat history, not the
      // local satellite gateway's. Calling local `chat.history` after a
      // cross-device run would return stale local rows and the just-
      // streamed reply would disappear from the UI. Tunnel through
      // federation.node.invoke so we read the authoritative store.
      const targetNodeId = this.getChatNodeId();
      const isRemote =
        !!targetNodeId &&
        targetNodeId !== "local" &&
        targetNodeId !== this.localNodeId;

      let res: { messages?: unknown[] };
      if (isRemote) {
        const fedRes = (await this.client.request("federation.node.invoke", {
          nodeId: targetNodeId,
          method: "chat.history",
          params: {
            sessionKey: this.panel.sessionKey,
            // The server's byte cap bounds this; a count of 100 was cutting
            // grid panels off mid-conversation.
            limit: 10_000,
          },
        })) as { status?: string; payload?: { messages?: unknown[] }; error?: string };
        if (fedRes?.status === "error" || fedRes?.error) {
          throw new Error(fedRes.error ?? "remote chat.history failed");
        }
        res = (fedRes?.payload ?? { messages: [] }) as { messages?: unknown[] };
      } else {
        res = (await this.client.request("chat.history", {
          sessionKey: this.panel.sessionKey,
          limit: 10_000,
        })) as { messages?: unknown[] };
      }

      if (Array.isArray(res.messages)) {
        const mapped = res.messages
          .filter((m: any) => m.role && m.content)
          .map((m: any) => {
            // Agent-invokable chat panels (show_panel tool results) render as
            // live inline cards in the assistant's turn.
            const panelRefs = extractPanelRefsFromMessage(m);
            if (panelRefs.length) {
              return { role: "assistant", content: "", images: [], timestamp: m.timestamp, panelRefs };
            }
            const role = (m.role || "unknown").toLowerCase();
            const { text, images } = extractContentWithImages(m);
            return {
              role,
              content: text || "",
              images: images || [],
              timestamp: m.timestamp,
            };
          })
          .filter((m: any) => (m.content || m.images?.length > 0 || m.panelRefs?.length) && !["toolresult", "tool_result", "tool"].includes(m.role));

        // Only overwrite the visible transcript when we actually got rows, when
        // the panel was already empty, or when we just switched sessions. This
        // prevents a stale/raced empty read (final-before-flush, or a federation
        // history tunnel that transiently returned nothing) from blanking the
        // panel back to the "Start a conversation..." placeholder.
        if (mapped.length > 0 || this.messages.length === 0 || switchingSession) {
          // Keep raw messages for tool extraction
          this.rawMessages = res.messages;
          this.messages = mapped;
        }
      }
    } catch (e) {
      console.error("Failed to load chat history:", e);
    } finally {
      this.loading = false;
    }
  }

  private async loadSessionInfo() {
    if (!this.client || !this.panel?.sessionKey) return;

    try {
      // Same cross-device routing as loadHistory: for panels bound to a
      // remote node, the session's token counts + model + updatedAt live
      // on that node, not locally. Tunnel through federation.node.invoke
      // so the panel header shows the authoritative numbers.
      const targetNodeId = this.getChatNodeId();
      const isRemote =
        !!targetNodeId &&
        targetNodeId !== "local" &&
        targetNodeId !== this.localNodeId;

      let res: { sessions?: any[] };
      if (isRemote) {
        const fedRes = (await this.client.request("federation.node.invoke", {
          nodeId: targetNodeId,
          method: "sessions.list",
          params: { limit: 50 },
        })) as { status?: string; payload?: { sessions?: any[] }; error?: string };
        if (fedRes?.status === "error" || fedRes?.error) {
          throw new Error(fedRes.error ?? "remote sessions.list failed");
        }
        res = (fedRes?.payload ?? { sessions: [] }) as { sessions?: any[] };
      } else {
        res = (await this.client.request("sessions.list", {
          limit: 50,
        })) as { sessions?: any[] };
      }

      if (Array.isArray(res.sessions)) {
        const session = res.sessions.find((s: any) => s.key === this.panel.sessionKey);
        if (session) {
          this.sessionInfo = {
            model: session.model,
            inputTokens: session.inputTokens || 0,
            outputTokens: session.outputTokens || 0,
            totalTokens: session.totalTokens || 0,
            updatedAt: session.updatedAt,
          };
        }
      }
    } catch (e) {
      console.error("Failed to load session info:", e);
    }
  }

  private async loadAvailableAgents() {
    // Extract current agent from session key immediately (agent:agentId:label)
    const sessionKey = this.panel?.sessionKey || "";
    const parts = sessionKey.split(":");
    if (parts.length >= 2 && parts[0] === "agent") {
      this.selectedAgent = parts[1];
    } else {
      this.selectedAgent = "main";
    }

    // Friendly agent icons
    const agentIcons: Record<string, string> = {
      main: "🜂",
      coder: "💻",
      opus: "🧠",
      fast: "⚡",
      researcher: "🔬",
    };

    // Set default based on current agent
    this.availableAgents = [
      { id: this.selectedAgent, name: `${agentIcons[this.selectedAgent] || "🤖"} ${this.selectedAgent}` },
    ];

    if (!this.client) return;

    try {
      // Use agents.list method to get all available agents
      const result = await this.client.request("agents.list", {}) as any;
      
      if (result?.agents && Array.isArray(result.agents)) {
        this.availableAgents = result.agents.map((agent: any) => {
          const id = agent.id || "main";
          const displayName = agent.name || agent.identity?.name || id;
          const icon = agentIcons[id] || "🤖";
          return {
            id,
            name: `${icon} ${displayName}`,
          };
        });
        
        // Update selected agent to use default if not in list
        if (result.defaultId && !this.selectedAgent) {
          this.selectedAgent = result.defaultId;
        }
      }
    } catch (e) {
      console.log("agents.list not available, using session agent:", this.selectedAgent);
    }
  }

  private async loadFederationNodes() {
    if (!this.client) return;

    // `loadNodes(client, state)` mutates `state.nodes` in place and returns
    // `Promise<void>` — the original code here treated the return as the
    // nodes array, which made `federationNodes` undefined and silently
    // hid the chat panel's device dropdown forever. Build a tiny ephemeral
    // FederationState, hydrate it, then copy out the nodes list.
    this.federationLoading = true;
    try {
      // Mirror the call shape used by /terminals (federation.nodes.list +
      // node.list). Direct gateway calls are simpler than minting a fake
      // FederationState — and avoid pulling the whole federation
      // controller into the chat panel.
      const [fedRes, mobileRes] = await Promise.all([
        this.client
          .request("federation.nodes.list", {})
          .catch(() => null) as Promise<{ nodes?: Array<Record<string, unknown>> } | null>,
        this.client
          .request("node.list", {})
          .catch(() => null) as Promise<{ nodes?: Array<Record<string, unknown>> } | null>,
      ]);
      const raw: Array<Record<string, unknown>> = [
        ...(fedRes?.nodes ?? []),
        ...(mobileRes?.nodes ?? []),
      ];
      const nodes: FederationNode[] = raw.map((n) => ({
        id: String(n.id ?? n.nodeId ?? ""),
        name: String(n.name ?? n.nodeName ?? "Unknown"),
        hostname: typeof n.hostname === "string" ? n.hostname : undefined,
        status: (n.status as FederationNode["status"]) ?? "online",
        role: (n.role as FederationNode["role"]) ?? "satellite",
        platform: (n.platform as FederationNode["platform"]) ?? "unknown",
        lastSeen: typeof n.lastSeen === "number" ? (n.lastSeen as number) : Date.now(),
        capabilities: (n.capabilities as FederationNode["capabilities"]) ?? {},
        isLocal: n.isLocal === true,
      }));

      // Always synthesize a "local" entry so the dropdown shows at least
      // one option even when no satellites are paired yet.
      if (!nodes.some((n) => n.isLocal)) {
        nodes.unshift({
          id: "local",
          name: "This Device",
          status: "online",
          role: "master",
          platform: "windows",
          lastSeen: Date.now(),
          capabilities: {},
          isLocal: true,
        });
      }

      this.federationNodes = nodes;
      const localNode = nodes.find((n) => n.isLocal);
      this.localNodeId = localNode?.id || null;
      // Pick a default for new panels:
      //   - If the local device is the master (or standalone), default to local.
      //   - If the local device is a satellite, default to master so chats
      //     hit the federation's authoritative agent + API keys instead of
      //     failing locally with "No API key" when the operator forgot to
      //     pick master in the device dropdown.
      // Sticky state still wins: only fires when currentNodeId is unset.
      if (!this.currentNodeId) {
        const isLocalSatellite = !!localNode && (localNode as { role?: string }).role === "satellite";
        const masterNode = nodes.find((n) => (n as { role?: string }).role === "master");
        if (isLocalSatellite && masterNode) {
          this.currentNodeId = masterNode.id;
        } else if (localNode) {
          this.currentNodeId = localNode.id;
        }
      }
    } catch (e) {
      console.log("Federation nodes not available:", e);
      // Fallback: at least show the "this device" entry so the user has
      // something to select.
      this.federationNodes = [{
        id: "local",
        name: "This Device",
        status: "online",
        role: "master",
        platform: "windows",
        lastSeen: Date.now(),
        capabilities: {},
        isLocal: true,
      }];
      this.localNodeId = "local";
      if (!this.currentNodeId) this.currentNodeId = "local";
    } finally {
      this.federationLoading = false;
    }
  }

  private handleNodeChange(nodeId: string) {
    const nextNodeId = nodeId || "local";
    if (nextNodeId === this.currentNodeId) return;
    
    this.currentNodeId = nextNodeId;
    this.dispatchEvent(new CustomEvent("panel-meta-update", {
      detail: { chatNodeId: nextNodeId, nodeId: nextNodeId },
      bubbles: true,
      composed: true,
    }));
    void this.loadHistory();
    void this.loadSessionInfo();
    
    // Dispatch event to switch node context
    this.dispatchEvent(new CustomEvent("node-change", {
      detail: { nodeId: nextNodeId, panelId: this.panel.id },
      bubbles: true,
      composed: true,
    }));
  }

  private renderNodeSelector() {
    // Always show the device selector so the affordance is discoverable —
    // even when only the local node is known, the user gets a clear "this
    // is where the chat is running" badge and a one-click way to switch
    // once federation comes online. Original code hid the selector when
    // `federationNodes.length <= 1`, which surprised users who weren't
    // aware federation was available at all.
    return renderNodeSelector({
      nodes: this.federationNodes,
      currentNodeId: this.currentNodeId,
      localNodeId: this.localNodeId,
      loading: this.federationLoading,
      compact: this.isCompact,
      onNodeSelect: (nodeId) => this.handleNodeChange(nodeId),
      onRefresh: () => this.loadFederationNodes(),
    });
  }

  /** True when this panel's chat runs on another federation device. */
  private isRemoteChat(): boolean {
    const nodeId = this.getChatNodeId();
    return !!nodeId && nodeId !== "local" && nodeId !== this.localNodeId;
  }

  /**
   * Secure Mode toggle. On: Secure Mode on (if needed), then this panel's last
   * secure session for its agent or a new one (`secure.session.new`). Off:
   * back to the session the panel was showing. The panel's session key is
   * grid state, so the switch goes through `panel-meta-update`.
   */
  private async onSecureToggle(on: boolean) {
    const from = this.panel?.sessionKey ?? null;
    if (!this.panel || this.sending) return;
    const agentId = /^agent:([^:]+):/.exec(from ?? "")?.[1] ?? (this.selectedAgent || "main");
    const next = await this.secureLane.switch({
      on,
      surface: `grid:${this.panel.id}`,
      agentId,
      currentKey: from,
    });
    if (next === undefined || this.panel?.sessionKey !== from) return;
    const key = next ?? `agent:${agentId}:webchat-${Date.now().toString(36)}`;
    if (key === from) return;
    this.inputValue = "";
    this.dispatchEvent(new CustomEvent("panel-meta-update", {
      detail: { sessionKey: key },
      bubbles: true,
      composed: true,
    }));
  }

  /** Lock badge + compact Secure Mode toggle above the panel input. */
  private renderSecureRow() {
    if (!this.secureLane.supported) return nothing;
    const key = this.panel?.sessionKey ?? null;
    const on = isSecureSessionKey(key);
    const remote = this.isRemoteChat();
    return html`<div class="ibss-row mp-sec-row" data-secure-row="grid" data-panel-id=${this.panel.id}>
      <span class="mp-sec-note">${on ? "Local models only · encrypted" : nothing}</span>
      <span class="ibss-row__spacer"></span>
      <ib-secure-toggle
        compact
        mode="custom"
        data-secure-surface="grid"
        data-panel-id=${this.panel.id}
        .on=${on}
        .busy=${this.secureLane.busy}
        .error=${this.secureLane.error}
        .note=${remote && !on ? "Secure Mode runs on this device only — switch the panel to This Device first." : null}
        ?disabled=${!this.client || this.sending || (remote && !on)}
        @secure-toggle=${(e: CustomEvent<{ on: boolean }>) => void this.onSecureToggle(e.detail.on)}
      ></ib-secure-toggle>
    </div>`;
  }

  private handleAgentChange(agentId: string) {
    if (agentId === this.selectedAgent) return;
    
    this.selectedAgent = agentId;
    this.showAgentDropdown = false;
    
    // Dispatch event to switch session to different agent
    this.dispatchEvent(new CustomEvent("agent-change", {
      detail: { agentId, panelId: this.panel.id },
      bubbles: true,
      composed: true,
    }));
  }

  private handleHeaderMouseDown(e: MouseEvent | TouchEvent) {
    if ((e.target as HTMLElement).closest(".panel-controls")) return;
    if ("touches" in e) e.preventDefault();
    this.dispatchEvent(new CustomEvent("panel-focus"));
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e }));
  }

  private handleResizeMouseDown(edge: string, e: MouseEvent | TouchEvent) {
    if ("touches" in e) e.preventDefault();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e } }));
  }

  private handleClose() { this.dispatchEvent(new CustomEvent("panel-close")); }
  private handleMinimize() { this.dispatchEvent(new CustomEvent("panel-minimize")); }
  private handleMaximize() { this.dispatchEvent(new CustomEvent("panel-maximize")); }
  
  private handleTitleDoubleClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.renameValue = this.panel.title || "";
    this.isRenaming = true;
    // Focus the input after render
    requestAnimationFrame(() => {
      const input = this.shadowRoot?.querySelector('.panel-title-input') as HTMLInputElement;
      if (input) { input.focus(); input.select(); }
    });
  }
  
  private async handleRenameCommit() {
    const trimmed = this.renameValue.trim();
    if (trimmed && trimmed !== this.panel.title && this.client) {
      try {
        // Update via sessions.patch API
        await this.client.request("sessions.patch", { 
          key: this.panel.sessionKey, 
          label: trimmed 
        });
        // Dispatch event to update parent state
        this.dispatchEvent(new CustomEvent("panel-rename", { 
          detail: { sessionKey: this.panel.sessionKey, newTitle: trimmed }
        }));
      } catch (err) {
        console.error("Failed to rename session:", err);
      }
    }
    this.isRenaming = false;
    this.renameValue = "";
  }
  
  private handleRenameCancel() {
    this.isRenaming = false;
    this.renameValue = "";
  }
  
  private handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.handleRenameCommit();
    } else if (e.key === "Escape") {
      this.handleRenameCancel();
    }
  }
  
  // Wake word editing handlers
  private handleWakeWordDoubleClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const wakeSettings = getPanelWakeSettings(this.panel.id);
    this.wakeWordEditValue = wakeSettings.word || "";
    this.isEditingWakeWord = true;
    // Focus the input after render
    requestAnimationFrame(() => {
      const input = this.shadowRoot?.querySelector('.wake-word-input') as HTMLInputElement;
      if (input) { input.focus(); input.select(); }
    });
  }
  
  private handleWakeWordCommit() {
    const trimmed = this.wakeWordEditValue.trim().toLowerCase();
    if (trimmed) {
      // Update wake word in the wake-word controller (persists to localStorage)
      updatePanelWakeWord(this.panel.id, { wakeWord: trimmed });
    }
    this.isEditingWakeWord = false;
    this.wakeWordEditValue = "";
    // Force re-render to show updated wake word
    this.requestUpdate();
  }
  
  private handleWakeWordCancel() {
    this.isEditingWakeWord = false;
    this.wakeWordEditValue = "";
  }
  
  private handleWakeWordKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      this.handleWakeWordCommit();
    } else if (e.key === "Escape") {
      this.handleWakeWordCancel();
    }
  }
  
  private handleFocus() { this.dispatchEvent(new CustomEvent("panel-focus")); }

  private handleInputChange(e: Event) {
    const value = (e.target as HTMLTextAreaElement).value;
    this.inputValue = value;
    // Show slash preview when typing "/"
    this.showSlashPreview = value.startsWith("/") && !value.includes(" ");
  }

  private handleInputKeydown(e: KeyboardEvent) {
    // Let slash preview handle navigation keys
    if (this.showSlashPreview) {
      const preview = this.shadowRoot?.querySelector("slash-command-preview") as any;
      if (preview?.handleKeyDown?.(e)) {
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  private handleSlashSelect(e: CustomEvent) {
    const cmd = e.detail.command as { key?: string; name: string };
    if (!cmd?.name) return;

    // Special-case `/skill`: open the full Browse Skills modal instead of
    // injecting bare text into the prompt. The picker handles search,
    // filter pills, and one-click install — and on pick it routes the
    // chosen skill back into THIS panel's compose input as `@<skillKey>`
    // so the agent gets a real reference rather than a placeholder.
    if (cmd.key === "skill") {
      this.showSlashPreview = false;
      this.inputValue = "";
      void import("./skills").then((mod) =>
        mod.openSkillsBrowseModal({
          onPick: (skillKey) => {
            // Append the skill reference to whatever the user already had
            // in the prompt, separating with a space if needed. We use
            // `@<key>` so the slash router treats it as a directive
            // rather than literal text.
            const ref = `@${skillKey}`;
            const next = this.inputValue
              ? `${this.inputValue.trimEnd()} ${ref} `
              : `${ref} `;
            this.inputValue = next;
            // Re-focus the textarea so the user can keep typing without
            // a manual click.
            requestAnimationFrame(() => {
              const ta = this.shadowRoot?.querySelector(".chat-input") as HTMLTextAreaElement | null;
              ta?.focus();
              if (ta) {
                ta.selectionStart = ta.selectionEnd = ta.value.length;
              }
            });
            this.requestUpdate();
          },
        }),
      );
      // Nudge the host to repaint in case nothing else triggered it.
      this.dispatchEvent(
        new CustomEvent("request-app-update", { bubbles: true, composed: true }),
      );
      return;
    }

    this.inputValue = cmd.name + " ";
    this.showSlashPreview = false;
    // Focus the textarea
    const textarea = this.shadowRoot?.querySelector(".chat-input") as HTMLTextAreaElement;
    textarea?.focus();
  }

  private handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const newAttachment = {
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            dataUrl,
            mimeType: file.type,
          };
          this.attachments = [...this.attachments, newAttachment];
          // Sync to session storage
          if (this.panel?.sessionKey) {
            setSessionAttachments(this.panel.sessionKey, this.attachments);
          }
        };
        reader.readAsDataURL(file);
      }
    }
  }

  private removeAttachment(id: string) {
    this.attachments = this.attachments.filter((a) => a.id !== id);
    // Sync to session storage
    if (this.panel?.sessionKey) {
      setSessionAttachments(this.panel.sessionKey, this.attachments);
    }
  }

  private handleImageUploadClick() {
    const input = this.renderRoot.querySelector('.image-upload-input') as HTMLInputElement;
    if (input) input.click();
  }

  private handleImageUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.type.startsWith("image/")) continue;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const newAttachment = {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          dataUrl,
          mimeType: file.type,
        };
        this.attachments = [...this.attachments, newAttachment];
        // Sync to session storage
        if (this.panel?.sessionKey) {
          setSessionAttachments(this.panel.sessionKey, this.attachments);
        }
      };
      reader.readAsDataURL(file);
    }
    
    // Reset input so same file can be selected again
    input.value = '';
  }

  private async handleSend() {
    const hasMessage = this.inputValue.trim();
    const hasAttachments = this.attachments.length > 0;
    if ((!hasMessage && !hasAttachments) || this.sending || !this.client) return;

    const message = this.inputValue.trim();
    const attachmentsToSend = [...this.attachments];
    this.inputValue = "";
    this.attachments = [];
    // Clear session attachments storage too
    if (this.panel?.sessionKey) {
      clearSessionAttachments(this.panel.sessionKey);
    }
    
    // Build display content - use message or empty if only images
    const displayContent = message;

    // Convert attachments to ImageData format for display
    const displayImages: ImageData[] = attachmentsToSend.map(att => ({
      type: "base64" as const,
      mimeType: att.mimeType,
      data: att.dataUrl,
    }));

    // Generate run ID for tracking this request
    const runId = `grid-${this.panel.sessionKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    // Add user message with images + set streaming state
    this.messages = [
      ...this.messages,
      { role: "user", content: displayContent, images: displayImages, timestamp: Date.now() },
    ];
    this.sending = true;
    this.runId = runId;
    this.streamingContent = "";
    this.streamStartedAt = Date.now();
    // Arm the watchdog immediately so a run that errors before its first token
    // (with a lost terminal event) still resolves the spinner.
    this.armStreamWatchdog();

    // Wait for DOM update and paint
    await this.updateComplete;
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
    this.scrollToBottom();

    // Convert attachments to API format
    const apiAttachments = attachmentsToSend.length > 0
      ? attachmentsToSend
          .map((att) => {
            const match = /^data:([^;]+);base64,(.+)$/.exec(att.dataUrl);
            if (!match) return null;
            return { type: "image", mimeType: match[1], content: match[2] };
          })
          .filter((a): a is NonNullable<typeof a> => a !== null)
      : undefined;

    // Fire the request - streaming events will update the UI. The selected
    // federation node is read from panel meta at send time so rerenders or
    // restored layouts cannot freeze an old device choice.
    const targetNodeId = this.getChatNodeId();
    const isRemote =
      targetNodeId &&
      targetNodeId !== "local" &&
      targetNodeId !== this.localNodeId;
    const requestNodeId = isRemote ? targetNodeId : "local";
    try {
      await this.client.request("chat.send", {
        sessionKey: this.panel.sessionKey,
        message: message || "What's in this image?",
        deliver: false, // Use streaming mode
        idempotencyKey: runId,
        attachments: apiAttachments,
        nodeId: requestNodeId,
      });
      // Request sent successfully - events will handle the rest
    } catch (e: any) {
      console.error("Failed to send message:", e);
      // Request failed immediately - show error
      this.clearStreamWatchdog();
      this.streamingContent = null;
      this.runId = null;
      this.streamStartedAt = null;
      this.sending = false;
      this.messages = [
        ...this.messages,
        { role: "assistant", content: `⚠️ Error: ${e.message || "Failed to send message"}`, timestamp: Date.now() },
      ];
    }
  }

  private async handleStop() {
    this.clearStreamWatchdog();
    if (!this.client || !this.runId) {
      // Just reset state if no active run
      this.sending = false;
      this.streamingContent = null;
      this.runId = null;
      this.streamStartedAt = null;
      return;
    }

    console.log(`[Panel:${this.panel.id}] Stopping generation, runId: ${this.runId}`);
    
    try {
      const targetNodeId = this.getChatNodeId();
      const isRemote =
        targetNodeId &&
        targetNodeId !== "local" &&
        targetNodeId !== this.localNodeId;
      // Call the abort endpoint
      await this.client.request("chat.abort", {
        sessionKey: this.panel.sessionKey,
        runId: this.runId,
        nodeId: isRemote ? targetNodeId : "local",
      });
      console.log(`[Panel:${this.panel.id}] Abort request sent`);
    } catch (e) {
      console.warn(`[Panel:${this.panel.id}] Abort request failed:`, e);
    }

    // Reset state immediately - don't wait for server confirmation
    const partialContent = this.streamingContent;
    this.sending = false;
    this.streamingContent = null;
    this.runId = null;
    this.streamStartedAt = null;

    // If we had partial content, add it as a message with a "stopped" indicator
    if (partialContent && partialContent.trim()) {
      this.messages = [
        ...this.messages,
        { 
          role: "assistant", 
          content: partialContent + "\n\n⏹️ *Generation stopped*", 
          timestamp: Date.now() 
        },
      ];
    }
  }

  private groupMessages() {
    const groups: Array<{ role: string; messages: typeof this.messages; timestamp: number }> = [];
    let currentGroup: typeof groups[0] | null = null;

    for (const msg of this.messages) {
      const role = msg.role === "human" ? "user" : msg.role;
      if (!currentGroup || currentGroup.role !== role) {
        if (currentGroup) groups.push(currentGroup);
        currentGroup = { role, messages: [msg], timestamp: msg.timestamp || Date.now() };
      } else {
        currentGroup.messages.push(msg);
      }
    }
    if (currentGroup) groups.push(currentGroup);
    return groups;
  }

  private formatTokens(n: number | undefined): string {
    if (!n) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return String(n);
  }

  private shortModel(model?: string): string {
    if (!model) return "default";
    const slash = model.lastIndexOf("/");
    return slash >= 0 ? model.slice(slash + 1) : model;
  }

  /**
   * Get recent tool executions from raw messages
   */
  private getRecentToolExecutions(): ToolExecution[] {
    if (!this.showAiIde) return [];
    return extractToolExecutions(this.rawMessages);
  }

  /**
   * Render inline tool activity cards (shown within streaming response)
   */
  private renderInlineToolActivity() {
    const executions = this.getRecentToolExecutions();
    const isStreaming = this.sending || Boolean(this.streamingContent);
    
    // Only show recent executions (last 5)
    const recentExecs = executions.slice(-5);
    
    if (recentExecs.length === 0 && !isStreaming) return nothing;

    return html`
      <div class="inline-tool-activity ${this.aiIdeCollapsed ? 'collapsed' : ''}">
        <div class="tool-activity-header" @click=${() => { this.aiIdeCollapsed = !this.aiIdeCollapsed; }}>
          <span class="tool-activity-status ${isStreaming ? 'active' : ''}">
            <span class="status-pulse"></span>
            ${isStreaming ? 'Working' : 'Tools'}
          </span>
          <span class="tool-activity-count">${recentExecs.length}</span>
          <span class="tool-activity-toggle">${this.aiIdeCollapsed ? '▼' : '▲'}</span>
        </div>
        ${!this.aiIdeCollapsed ? html`
          <div class="tool-activity-list">
            ${recentExecs.map(exec => this.renderInlineToolCard(exec))}
          </div>
        ` : nothing}
      </div>
    `;
  }

  /**
   * Render a single inline tool card
   */
  private renderInlineToolCard(exec: ToolExecution) {
    // Check if this is a canvas/excalidraw tool - render special preview
    if (isCanvasToolResult(exec.name)) {
      return renderCanvasPreview(exec.name, exec.result, () => this.requestUpdate());
    }

    const statusClass = exec.status === 'running' ? 'running' : 
                        exec.status === 'error' ? 'error' : 'complete';
    const elapsed = exec.completedAt 
      ? this.formatToolDuration(exec.completedAt - exec.startedAt)
      : this.formatToolDuration(Date.now() - exec.startedAt);
    
    return html`
      <div class="inline-tool-card ${statusClass}">
        <span class="tool-icon">${exec.icon || '🔧'}</span>
        <span class="tool-name">${exec.displayName || exec.name}</span>
        ${exec.filePath ? html`<span class="tool-path">${this.shortenPath(exec.filePath)}</span>` : nothing}
        <span class="tool-status">
          ${exec.status === 'running' ? html`<span class="tool-spinner"></span>` : nothing}
          ${exec.status === 'complete' ? '✓' : ''}
          ${exec.status === 'error' ? '✗' : ''}
          <span class="tool-time">${elapsed}</span>
        </span>
      </div>
    `;
  }

  private formatToolDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m`;
  }

  /**
   * Check if there's canvas tool activity in current tool executions
   */
  private hasCanvasActivity(): boolean {
    const toolExecs = extractToolExecutions(this.rawMessages);
    const hasCanvas = toolExecs.some(exec => isCanvasToolResult(exec.name));
    // Set persistent flag if canvas is used
    if (hasCanvas && !this.canvasWasUsedInSession) {
      this.canvasWasUsedInSession = true;
    }
    return hasCanvas;
  }

  /**
   * Check if the last assistant message had canvas tools
   */
  private lastMessageHadCanvas(): boolean {
    // Check raw messages for canvas tool results
    for (let i = this.rawMessages.length - 1; i >= 0; i--) {
      const msg = this.rawMessages[i] as any;
      if (msg?.role === 'assistant') {
        const content = Array.isArray(msg.content) ? msg.content : [];
        const hasCanvas = content.some((block: any) => 
          block?.type === 'tool_use' && isCanvasToolResult(block?.name || '')
        );
        if (hasCanvas) {
          // Set persistent flag
          if (!this.canvasWasUsedInSession) {
            this.canvasWasUsedInSession = true;
          }
          return true;
        }
        break; // Only check last assistant message
      }
    }
    return false;
  }

  /**
   * Render inline canvas preview with gold styling
   */
  private renderInlineCanvasPreview(isBuilding: boolean = false) {
    return html`
      <div class="canvas-preview-inline ${isBuilding ? 'building' : ''}">
        <div class="canvas-preview-header" @click=${() => { this.canvasPreviewExpanded = !this.canvasPreviewExpanded; }}>
          <div class="canvas-preview-header__left">
            <span class="canvas-preview-header__icon">🎨</span>
            <span class="canvas-preview-header__title">Live Canvas</span>
            <span class="canvas-preview-header__badge ${isBuilding ? 'building' : ''}">
              ${isBuilding ? '● BUILDING' : '● LIVE'}
            </span>
          </div>
          <div class="canvas-preview-header__controls">
            <button 
              class="canvas-preview-btn" 
              title="Open in new window"
              @click=${(e: Event) => { e.stopPropagation(); window.open(`${window.location.pathname}#/whiteboard`, '_blank'); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </button>
            <button 
              class="canvas-preview-btn" 
              title="${this.canvasPreviewExpanded ? 'Collapse' : 'Expand'}"
              @click=${(e: Event) => { e.stopPropagation(); this.canvasPreviewExpanded = !this.canvasPreviewExpanded; }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${this.canvasPreviewExpanded 
                  ? html`<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>`
                  : html`<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`
                }
              </svg>
            </button>
            <button 
              class="canvas-preview-btn" 
              title="Close preview"
              @click=${(e: Event) => { e.stopPropagation(); this.canvasWasUsedInSession = false; this.showCanvasPreview = false; }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="canvas-preview-body ${this.canvasPreviewExpanded ? 'expanded' : ''}">
          <!-- Preview iframe replaced with a glanceable card; clicking
               the parent opens the in-app /whiteboard route. The dead
               localhost:3000 server is gone. -->
          <div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:linear-gradient(135deg,#1f2937,#0f172a);color:#a3a3ad;cursor:pointer">
            <div style="text-align:center">
              <div style="font-size:32px;margin-bottom:6px">🎨</div>
              <div style="font-size:12px;opacity:0.85">Open whiteboard</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private shortenPath(path: string): string {
    if (path.length <= 30) return path;
    const parts = path.replace(/\\/g, '/').split('/');
    const filename = parts.pop() || '';
    return `.../${filename}`;
  }

  /**
   * Render the AI IDE panel showing tool executions
   * Only shows when enabled and there are executions or streaming
   */
  private renderAiIdePanel() {
    // Use the inline version instead
    return nothing;
  }
  
  private renderWakeWordBadge() {
    const wakeSettings = getPanelWakeSettings(this.panel.id);
    if (!wakeSettings.enabled || !wakeSettings.word) return nothing;
    
    const isVoiceActive = this.isVoiceTarget;
    
    // Show input when editing
    if (this.isEditingWakeWord) {
      return html`
        <div class="wake-word-badge wake-word-badge--editing">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 10px; height: 10px;">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          </svg>
          <input 
            type="text" 
            class="wake-word-input"
            .value=${this.wakeWordEditValue}
            @input=${(e: Event) => { this.wakeWordEditValue = (e.target as HTMLInputElement).value; }}
            @keydown=${this.handleWakeWordKeydown}
            @blur=${this.handleWakeWordCommit}
            @click=${(e: Event) => e.stopPropagation()}
            @mousedown=${(e: Event) => e.stopPropagation()}
            placeholder="wake word"
          />
        </div>
      `;
    }
    
    return html`
      <div 
        class="wake-word-badge ${isVoiceActive ? 'wake-word-badge--active' : ''}" 
        title="${isVoiceActive ? 'Voice active - listening for commands' : `Double-click to edit wake word: ${wakeSettings.word}`}"
        @dblclick=${this.handleWakeWordDoubleClick}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 10px; height: 10px;">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        </svg>
        <span class="wake-word-text">${isVoiceActive ? '● LIVE' : `"${wakeSettings.word}"`}</span>
      </div>
    `;
  }

  private renderAgentSelector() {
    // Always show the agent selector so user knows which agent they're talking to
    if (this.availableAgents.length === 0) {
      // Fallback - show current agent from session key
      const sessionKey = this.panel?.sessionKey || "";
      const parts = sessionKey.split(":");
      const agentId = parts.length >= 2 && parts[0] === "agent" ? parts[1] : "main";
      const agentNames: Record<string, string> = {
        main: "🜂 Infini",
        coder: "💻 Coder",
        opus: "🧠 Opus",
        fast: "⚡ Fast",
      };
      return html`
        <div class="agent-selector">
          <span class="agent-selector__trigger" style="cursor: default;">
            <span>${agentNames[agentId] || `🤖 ${agentId}`}</span>
          </span>
        </div>
      `;
    }
    
    const currentAgent = this.availableAgents.find(a => a.id === this.selectedAgent);
    const displayName = currentAgent?.name || this.selectedAgent || "🜂 Infini";
    
    return html`
      <div class="agent-selector" @click=${(e: Event) => e.stopPropagation()} @mousedown=${(e: Event) => e.stopPropagation()}>
        <button 
          class="agent-selector__trigger ${this.showAgentDropdown ? 'open' : ''}"
          @click=${() => { this.showAgentDropdown = !this.showAgentDropdown; }}
          title="Switch agent"
        >
          <span>${displayName}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </button>
        ${this.showAgentDropdown ? html`
          <div class="agent-selector__dropdown">
            ${this.availableAgents.map(agent => html`
              <div 
                class="agent-selector__option ${agent.id === this.selectedAgent ? 'selected' : ''}"
                @click=${() => this.handleAgentChange(agent.id)}
              >
                <span class="agent-selector__option-check">✓</span>
                <span>${agent.name}</span>
              </div>
            `)}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderModelSelector(currentModel?: string) {
    const hasModels = this.availableModels.length > 0;
    const displayModel = this.shortModel(currentModel);
    
    // If no models available, show static text
    if (!hasModels) {
      return html`
        <div class="panel-stat model-selector-stat" title="Model" style="border-right: none;">
          <span class="panel-stat__value panel-stat__value--dim">${displayModel}</span>
        </div>
      `;
    }
    
    // Find current model info
    const currentModelInfo = this.availableModels.find(m => m.id === currentModel);
    const displayName = currentModelInfo?.name || displayModel;
    const displayProvider = currentModelInfo?.provider || "";
    
    // Get unique providers
    const providers = Array.from(new Set(this.availableModels.map(m => m.provider).filter(Boolean))).sort() as string[];
    
    // Filter models based on search and provider filter
    const query = this.modelSearchQuery.toLowerCase().trim();
    const filtered = this.availableModels.filter(m => {
      // Provider filter
      if (this.modelProviderFilter && m.provider !== this.modelProviderFilter) return false;
      // Tier filter (size / cost bucket)
      if (this.modelTierFilter && modelTier(m) !== this.modelTierFilter) return false;
      // Capability filters (all selected must match)
      for (const cap of this.modelCapabilityFilter) {
        if (!modelHasCapability(m, cap)) return false;
      }
      // Search filter
      if (!query) return true;
      return (
        m.name.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query) ||
        (m.provider?.toLowerCase().includes(query) ?? false)
      );
    });
    
    // Group by provider
    const grouped = new Map<string, typeof this.availableModels>();
    for (const m of filtered) {
      const key = m.provider || "other";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(m);
    }
    
    return html`
      <div class="panel-stat model-selector-stat" style="border-right: none; position: relative;">
        <button 
          class="model-selector__trigger ${this.showModelDropdown ? 'open' : ''}"
          @click=${(e: MouseEvent) => { 
            e.stopPropagation(); 
            if (!this.showModelDropdown) {
              // Calculate position from button bounds
              const btn = e.currentTarget as HTMLElement;
              const rect = btn.getBoundingClientRect();
              // Anchor the dropdown's left edge to the trigger's left edge so it
              // sits directly below the button, then clamp to keep it on-screen.
              const menuW = 300;
              const vpLeft = Math.max(8, Math.min(rect.left, window.innerWidth - menuW - 8));
              // The dropdown is position:fixed, but the draggable grid panels use
              // CSS transforms — a transformed ancestor becomes the containing block
              // for fixed descendants, so viewport coords get re-based. Find that
              // ancestor (crossing shadow boundaries) and convert into its space.
              let cb: Element | null = btn.parentElement ?? ((btn.getRootNode() as ShadowRoot).host ?? null);
              let off = { left: 0, top: 0 };
              while (cb) {
                const cs = getComputedStyle(cb);
                const contain = cs.contain || "";
                if (
                  cs.transform !== "none" ||
                  cs.perspective !== "none" ||
                  cs.filter !== "none" ||
                  (cs.backdropFilter && cs.backdropFilter !== "none") ||
                  cs.willChange.includes("transform") ||
                  cs.willChange.includes("filter") ||
                  /\b(layout|paint|strict|content)\b/.test(contain)
                ) {
                  const r = cb.getBoundingClientRect();
                  off = { left: r.left, top: r.top };
                  break;
                }
                cb = cb.parentElement ?? ((cb.getRootNode() as ShadowRoot)?.host ?? null);
              }
              this.modelDropdownPos = {
                top: rect.bottom - off.top + 4,
                left: vpLeft - off.left,
              };
              this.modelSearchQuery = "";
              this.modelProviderFilter = null;
              this.modelCapabilityFilter = new Set();
              this.modelTierFilter = null;
            }
            this.showModelDropdown = !this.showModelDropdown;
          }}
          @mousedown=${(e: Event) => e.stopPropagation()}
          title="Select AI Model"
        >
          ${displayProvider ? html`<span class="model-selector__provider">${displayProvider}/</span>` : nothing}
          <span class="model-selector__name">${displayName.replace(`${displayProvider}/`, "").slice(0, 16)}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width: 10px; height: 10px;">
            <path d="m6 9 6 6 6-6"/>
          </svg>
        </button>
        ${this.showModelDropdown ? html`
          <div class="model-selector__dropdown" 
               style="top: ${this.modelDropdownPos.top}px; left: ${this.modelDropdownPos.left}px;"
               @click=${(e: Event) => e.stopPropagation()} 
               @mousedown=${(e: Event) => e.stopPropagation()}>
            <div class="model-selector__search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px; flex-shrink: 0; color: rgba(255,255,255,0.3);">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
              </svg>
              <input 
                type="text" 
                placeholder="Search models..."
                .value=${this.modelSearchQuery}
                @input=${(e: Event) => { this.modelSearchQuery = (e.target as HTMLInputElement).value; }}
                @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") this.showModelDropdown = false; }}
              />
            </div>
            ${providers.length > 1 ? html`
              <div class="model-selector__filters">
                <button 
                  class="model-selector__filter-chip ${this.modelProviderFilter === null ? 'active' : ''}"
                  @click=${() => { this.modelProviderFilter = null; }}
                >All</button>
                ${providers.map(p => html`
                  <button
                    class="model-selector__filter-chip ${this.modelProviderFilter === p ? 'active' : ''}"
                    @click=${() => { this.modelProviderFilter = this.modelProviderFilter === p ? null : p; }}
                  >${p}</button>
                `)}
              </div>
            ` : nothing}
            <div class="model-selector__filters">
              ${([
                { cap: "vision", label: "👁 Vision" },
                { cap: "tool-use", label: "🔧 Tools" },
                { cap: "long-context", label: "📏 Long ctx" },
                { cap: "reasoning", label: "🧠 Reasoning" },
              ] as Array<{ cap: ModelCapability; label: string }>).map(({ cap, label }) => html`
                <button
                  class="model-selector__filter-chip ${this.modelCapabilityFilter.has(cap) ? 'active' : ''}"
                  @click=${() => {
                    const next = new Set(this.modelCapabilityFilter);
                    if (next.has(cap)) next.delete(cap); else next.add(cap);
                    this.modelCapabilityFilter = next;
                  }}
                >${label}</button>
              `)}
              ${(["s", "m", "l"] as const).map((tier) => html`
                <button
                  class="model-selector__filter-chip ${this.modelTierFilter === tier ? 'active' : ''}"
                  title="Filter by size / cost tier"
                  @click=${() => { this.modelTierFilter = this.modelTierFilter === tier ? null : tier; }}
                >${tier === "s" ? "Small" : tier === "m" ? "Mid" : "Large"}</button>
              `)}
            </div>
            <div class="model-selector__list">
              ${this.availableModels.length === 0 ? html`
                <div class="model-selector__loading">
                  <span class="model-selector__loading-spinner"></span>
                  <span>Loading models…</span>
                </div>
              ` : filtered.length === 0 ? html`
                <div class="model-selector__empty">No models match your search</div>
              ` : html`
                ${Array.from(grouped.entries()).map(([provider, models]) => html`
                  <div class="model-selector__group">
                    <div class="model-selector__group-label">${provider}</div>
                    ${models.map(m => m.unconfigured ? html`
                      <button
                        class="model-selector__option model-selector__option--setup"
                        title="Not connected — open Quick Start to configure ${provider}"
                        @click=${() => this.openProviderSetup(provider)}
                      >
                        <span class="model-selector__option-name">${m.name}</span>
                        <span class="model-selector__option-setup">Set up →</span>
                      </button>
                    ` : html`
                      <button
                        class="model-selector__option ${m.id === currentModel ? 'selected' : ''}"
                        @click=${() => this.handleModelChange(m.id)}
                      >
                        <span class="model-selector__option-name">${m.name}</span>
                        ${m.id === currentModel ? html`<span class="model-selector__option-check">✓</span>` : nothing}
                      </button>
                    `)}
                  </div>
                `)}
              `}
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  /**
   * Open the focused provider-setup modal for an unconfigured provider, instead
   * of launching the whole /quickstart wizard. The modal collects just that
   * provider's API key, then lets the user pick one of its models inline.
   */
  private openProviderSetup(provider: string) {
    this.showModelDropdown = false;
    const first = this.availableModels.find((m) => m.provider === provider && !m.unconfigured);
    this.providerSetup = {
      provider,
      key: "",
      modelId: first?.id ?? "",
      saving: false,
      connected: false,
      error: "",
    };
  }

  /** Persist the API key for the modal's provider, then move to model-pick. */
  private async saveProviderSetup() {
    const setup = this.providerSetup;
    if (!setup || !this.client) return;
    const key = setup.key.trim();
    if (!key) {
      this.providerSetup = { ...setup, error: "Enter an API key." };
      return;
    }
    this.providerSetup = { ...setup, saving: true, error: "" };
    try {
      // Same RPC the API-keys page uses to persist a provider credential.
      await this.client.request("auth.profiles.upsert", {
        profileId: `${setup.provider}:default`,
        provider: setup.provider,
        type: "api_key",
        key,
      });
      // Ask the app to reload the model catalog so the now-configured provider's
      // real models flow back down via the `availableModels` property.
      window.dispatchEvent(new CustomEvent("models:refresh"));
      this.providerSetup = { ...this.providerSetup!, saving: false, connected: true, key: "" };
    } catch (err) {
      this.providerSetup = {
        ...this.providerSetup!,
        saving: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private renderProviderSetupModal() {
    const setup = this.providerSetup;
    if (!setup) return nothing;
    const models = this.availableModels.filter(
      (m) => m.provider === setup.provider && !m.unconfigured,
    );
    const chosen = setup.modelId || models[0]?.id || "";
    return html`
      <div
        class="pcv-modal-backdrop"
        @click=${(e: Event) => { if (e.target === e.currentTarget) this.providerSetup = null; }}
      >
        <div class="pcv-modal" @click=${(e: Event) => e.stopPropagation()}>
          <div class="pcv-modal__head">
            <div class="pcv-modal__title">Connect ${setup.provider}</div>
            <button
              class="pcv-modal__close"
              title="Close"
              @click=${() => { this.providerSetup = null; }}
            >${icons.x}</button>
          </div>
          <div class="pcv-modal__body">
            ${!setup.connected ? html`
              <label class="pcv-field">
                <span class="pcv-label">${setup.provider} API key</span>
                <input
                  class="pcv-input"
                  type="password"
                  autocomplete="off"
                  placeholder="Paste your ${setup.provider} API key"
                  .value=${setup.key}
                  @input=${(e: InputEvent) => {
                    this.providerSetup = { ...this.providerSetup!, key: (e.target as HTMLInputElement).value };
                  }}
                  @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this.saveProviderSetup(); }}
                />
              </label>
              ${setup.error ? html`<div class="pcv-label" style="color:#ff6b6b">${setup.error}</div>` : nothing}
              <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                <button class="pcv-btn" @click=${() => { this.providerSetup = null; }}>Cancel</button>
                <button
                  class="pcv-btn pcv-btn--primary"
                  ?disabled=${setup.saving}
                  @click=${() => void this.saveProviderSetup()}
                >${setup.saving ? "Connecting…" : "Connect"}</button>
              </div>
            ` : html`
              <label class="pcv-field">
                <span class="pcv-label">Pick a model</span>
                ${models.length === 0 ? html`
                  <div class="pcv-label">Loading ${setup.provider} models…</div>
                ` : html`
                  <select
                    class="pcv-input"
                    .value=${chosen}
                    @change=${(e: Event) => {
                      this.providerSetup = { ...this.providerSetup!, modelId: (e.target as HTMLSelectElement).value };
                    }}
                  >
                    ${models.map((m) => html`<option value=${m.id} ?selected=${m.id === chosen}>${m.name}</option>`)}
                  </select>
                `}
              </label>
              <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
                <button class="pcv-btn" @click=${() => { this.providerSetup = null; }}>Close</button>
                <button
                  class="pcv-btn pcv-btn--primary"
                  ?disabled=${models.length === 0 || !chosen}
                  @click=${() => { this.providerSetup = null; if (chosen) void this.handleModelChange(chosen); }}
                >Use model</button>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  }

  private async handleModelChange(modelId: string) {
    this.showModelDropdown = false;
    if (!this.client || !this.panel?.sessionKey) return;

    const previousModel = this.sessionInfo.model;
    this.sessionInfo = { ...this.sessionInfo, model: modelId };

    try {
      const res = (await this.client.request("sessions.patch", {
        key: this.panel.sessionKey,
        model: modelId,
      })) as { ok?: boolean; entry?: { providerOverride?: string; modelOverride?: string } } | undefined;

      const entry = res?.entry;
      if (entry?.providerOverride && entry?.modelOverride) {
        this.sessionInfo = {
          ...this.sessionInfo,
          model: `${entry.providerOverride}/${entry.modelOverride}`,
        };
      }
      await this.loadSessionInfo();
    } catch (err) {
      console.error("Failed to change model:", err);
      this.sessionInfo = { ...this.sessionInfo, model: previousModel };
      const msg = err instanceof Error ? err.message : String(err);
      this.dispatchEvent(new CustomEvent("panel-toast", {
        detail: { message: `Model change failed: ${msg}`, kind: "error" },
        bubbles: true,
        composed: true,
      }));
    }
  }

  render() {
    const { inputTokens, outputTokens, totalTokens, model } = this.sessionInfo;
    const messageGroups = this.groupMessages();
    const renderStart = Math.max(0, Math.min(this.chatRenderStartIdx, messageGroups.length));
    const renderEnd = Math.max(renderStart, Math.min(this.chatRenderEndIdx, messageGroups.length));
    const visibleMessageGroups = messageGroups.slice(renderStart, renderEnd);
    const topSpacerHeight = renderStart * this.estimatedChatGroupHeight;
    const bottomSpacerHeight = Math.max(0, messageGroups.length - renderEnd) * this.estimatedChatGroupHeight;

    const secureSession = isSecureSessionKey(this.panel?.sessionKey);
    return html`
      <div class="panel ${secureSession ? "panel--secure" : ""}" @click=${this.handleFocus}>
        <div class="panel-header" @mousedown=${this.handleHeaderMouseDown} @touchstart=${this.handleHeaderMouseDown}>
          <div class="panel-header__main">
            <span class="panel-led ${this.sending || this.streamingContent ? 'sending' : ''}"></span>
            ${this.isRenaming ? html`
              <input 
                type="text" 
                class="panel-title-input"
                .value=${this.renameValue}
                @input=${(e: Event) => { this.renameValue = (e.target as HTMLInputElement).value; }}
                @keydown=${this.handleRenameKeydown}
                @blur=${this.handleRenameCommit}
                @click=${(e: Event) => e.stopPropagation()}
                @mousedown=${(e: Event) => e.stopPropagation()}
              />
            ` : html`
              <span 
                class="panel-title" 
                title="Double-click to rename"
                @dblclick=${this.handleTitleDoubleClick}
              >${this.panel.title}</span>
            `}
            ${renderSecureSurfaceBadge(this.panel?.sessionKey, { surface: "grid-header", short: true })}
            ${this.renderWakeWordBadge()}
            ${this.renderAgentSelector()}
            ${this.renderNodeSelector()}
            ${this.sending || this.streamingContent ? html`
              <div class="sending-status ${this.streamingContent ? 'streaming' : ''}">
                <span class="sending-status__text">${this.streamingContent ? 'Streaming' : 'Thinking'}</span>
                <span class="loading-fancy__dots" style="margin-left: 2px;">
                  <span class="loading-fancy__dot"></span>
                  <span class="loading-fancy__dot"></span>
                  <span class="loading-fancy__dot"></span>
                </span>
              </div>
            ` : nothing}
            ${this.isVoiceTarget && !this.sending ? html`
              <div class="voice-target-badge" title="Voice input active for this panel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px;">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                </svg>
                <span>VOICE</span>
              </div>
            ` : nothing}
          </div>
          
          ${!this.isCompact && !this.sending ? html`
            <div class="panel-stats">
              <div class="panel-stat" title="Input / Output tokens">
                <span class="panel-stat__label">I/O</span>
                <span class="panel-stat__value">${this.formatTokens(inputTokens)}↑${this.formatTokens(outputTokens)}↓</span>
              </div>
              <div class="panel-stat" title="Total tokens">
                <span class="panel-stat__label">TOK</span>
                <span class="panel-stat__value panel-stat__value--gold">${this.formatTokens(totalTokens)}</span>
              </div>
              ${this.renderModelSelector(model)}
            </div>
          ` : nothing}
          
          <div class="panel-controls">
            <button
              class="panel-btn"
              title="Call this agent"
              aria-label="Call this agent"
              @click=${(e: Event) => { e.stopPropagation(); this.startCall(); }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
                <path d="m22 16.92-3.06-.85a2 2 0 0 0-1.9.5L15 18.6a16 16 0 0 1-9.6-9.6l2.43-2.04a2 2 0 0 0 .5-1.9L7.5 2A2 2 0 0 0 5.4.84a2 2 0 0 0-1.4.59L2.6 2.83A4 4 0 0 0 2 5.34c.6 7.5 6.16 13.06 13.66 13.66a4 4 0 0 0 2.5-.59l1.4-1.4a2 2 0 0 0 .43-2.09Z"/>
              </svg>
            </button>
            <button
              class="panel-btn ${this.showCanvasPreview ? 'active' : ''}"
              title="${this.showCanvasPreview ? 'Hide Canvas' : 'Show Live Canvas'}"
              @click=${() => { this.showCanvasPreview = !this.showCanvasPreview; }}
              style="${this.showCanvasPreview ? 'color: #6366f1; background: rgba(99, 102, 241, 0.15);' : ''}"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width: 14px; height: 14px;">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <path d="M3 9h18M9 21V9"/>
              </svg>
            </button>
            <button class="panel-btn" title="Minimize" @click=${this.handleMinimize}>${icons.minus}</button>
            <button class="panel-btn" title="Maximize" @click=${this.handleMaximize}>
              ${this.panel.maximized ? icons.minimize : icons.maximize}
            </button>
            <button class="panel-btn close" title="Close" @click=${this.handleClose}>${icons.x}</button>
          </div>
        </div>
        ${this.providerSetup ? this.renderProviderSetupModal() : nothing}

        <div class="panel-content">
          ${this.loading
            ? html`
                <div class="loading-fancy">
                  <div class="loading-fancy__spinner">
                    <div class="loading-fancy__ring"></div>
                    <div class="loading-fancy__ring"></div>
                    <div class="loading-fancy__ring"></div>
                  </div>
                  <div class="loading-fancy__text">
                    Loading
                    <span class="loading-fancy__dots">
                      <span class="loading-fancy__dot"></span>
                      <span class="loading-fancy__dot"></span>
                      <span class="loading-fancy__dot"></span>
                    </span>
                  </div>
                </div>
              `
            : this.messages.length === 0
              ? html`<div class="empty-state content-loaded">Start a conversation...</div>`
              : html`
                  <div class="chat-messages">
                    ${topSpacerHeight > 0 ? html`<div class="chat-window-spacer" style=${styleMap({ height: `${topSpacerHeight}px` })}></div>` : nothing}
                    ${visibleMessageGroups.map(group => this.renderMessageGroup(group))}
                    ${bottomSpacerHeight > 0 ? html`<div class="chat-window-spacer" style=${styleMap({ height: `${bottomSpacerHeight}px` })}></div>` : nothing}
                    ${this.sending || this.streamingContent ? html`
                      <div class="chat-group assistant content-loaded" style="animation: fade-in 0.2s ease;">
                        ${renderBrandAvatar("chat-avatar assistant", "Infini")}
                        <div class="chat-group-messages">
                          <!-- Inline tool activity - integrated with response -->
                          ${this.showAiIde ? this.renderInlineToolActivity() : nothing}
                          
                          ${this.streamingContent ? html`
                            <!-- Show streaming content -->
                            <div class="chat-bubble streaming-bubble" style="padding: 12px 16px; border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);">
                              ${unsafeHTML(toSanitizedMarkdownHtml(this.streamingContent))}
                              <span class="streaming-cursor">▊</span>
                            </div>
                          ` : html`
                            <!-- Show typing indicator while waiting for first chunk -->
                            <div class="chat-bubble" style="padding: 12px 16px; background: color-mix(in srgb, var(--g-primary) 8%, transparent); border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);">
                              <div class="typing-indicator">
                                <span class="typing-indicator__dot"></span>
                                <span class="typing-indicator__dot"></span>
                                <span class="typing-indicator__dot"></span>
                                <span class="typing-indicator__text">thinking...</span>
                              </div>
                            </div>
                          `}
                          
                          <!-- Auto-show canvas preview when canvas tools detected -->
                          ${this.hasCanvasActivity() ? this.renderInlineCanvasPreview(true) : nothing}
                        </div>
                      </div>
                    ` : nothing}
                    
                    <!-- Show canvas preview persistently once canvas tools were used in this session -->
                    ${!this.sending && !this.streamingContent && this.canvasWasUsedInSession ? this.renderInlineCanvasPreview(false) : nothing}
                  </div>
                `
          }
          <div class="chat-input-area" style="position: relative;">
            <slash-command-preview
              .query=${this.inputValue}
              .visible=${this.showSlashPreview}
              @select=${this.handleSlashSelect}
              @close=${() => { this.showSlashPreview = false; }}
            ></slash-command-preview>
            ${this.attachments.length > 0 ? html`
              <div class="grid-attachments">
                ${this.attachments.map((att) => html`
                  <div class="grid-attachment">
                    <img src=${att.dataUrl} alt="Attachment" class="grid-attachment__img" />
                    <button class="grid-attachment__remove" @click=${() => this.removeAttachment(att.id)}>×</button>
                  </div>
                `)}
              </div>
            ` : nothing}
            ${this.renderSecureRow()}
            <div class="chat-input-row">
              <textarea
                class="chat-input"
                rows="1"
                placeholder=${this.attachments.length > 0 ? "Add a message or paste more..." : "Type a message or paste an image..."}
                .value=${this.inputValue}
                @input=${this.handleInputChange}
                @keydown=${this.handleInputKeydown}
                @paste=${this.handlePaste}
                ?disabled=${this.sending}
              ></textarea>
              <!-- Image Upload Button -->
              <input 
                type="file" 
                accept="image/*" 
                multiple
                class="image-upload-input"
                style="display: none;"
                @change=${this.handleImageUpload}
              />
              <button 
                class="image-upload-btn" 
                title="Upload image"
                @click=${this.handleImageUploadClick}
                ?disabled=${this.sending}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
              </button>
              <chat-mic-button
                panelId=${this.panel.id}
                ?disabled=${this.sending}
                @stt-transcript=${(e: CustomEvent) => {
                  this.inputValue = e.detail.text;
                  this.requestUpdate();
                }}
                @stt-autosend=${(e: CustomEvent) => {
                  this.inputValue = e.detail.text;
                  this.handleSend();
                }}
                @stt-send=${() => {
                  // Local STT path: transcript already set via stt-transcript, just send
                  if (this.inputValue.trim()) {
                    this.handleSend();
                  }
                }}
              ></chat-mic-button>
              ${this.sending || this.streamingContent ? html`
                <button class="stop-btn" @click=${this.handleStop} title="Stop generation">
                  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <rect x="6" y="6" width="12" height="12" rx="2"/>
                  </svg>
                </button>
              ` : html`
                <button class="send-btn" ?disabled=${(!this.inputValue.trim() && this.attachments.length === 0) || this.loading} @click=${this.handleSend}>
                  ${icons.send}
                </button>
              `}
            </div>
          </div>
        </div>

        <!-- Live Canvas Preview Pane -->
        ${this.showCanvasPreview ? html`
          <div class="canvas-preview-pane ${this.canvasPreviewExpanded ? 'expanded' : ''}" style="height: ${this.canvasPreviewExpanded ? '250px' : '200px'};">
            <div class="canvas-preview-header" @click=${() => { this.canvasPreviewExpanded = !this.canvasPreviewExpanded; }}>
              <div class="canvas-preview-header__left">
                <span class="canvas-preview-header__icon">🎨</span>
                <span class="canvas-preview-header__title">Live Canvas</span>
                <span class="canvas-preview-header__badge">● LIVE</span>
              </div>
              <div class="canvas-preview-header__controls">
                <button 
                  class="canvas-preview-btn" 
                  title="Open in new window"
                  @click=${(e: Event) => { e.stopPropagation(); window.open(`${window.location.pathname}#/whiteboard`, '_blank'); }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                    <polyline points="15 3 21 3 21 9"/>
                    <line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                </button>
                <button 
                  class="canvas-preview-btn" 
                  title="${this.canvasPreviewExpanded ? 'Collapse' : 'Expand'}"
                  @click=${(e: Event) => { e.stopPropagation(); this.canvasPreviewExpanded = !this.canvasPreviewExpanded; }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    ${this.canvasPreviewExpanded 
                      ? html`<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>`
                      : html`<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`
                    }
                  </svg>
                </button>
                <button 
                  class="canvas-preview-btn" 
                  title="Close preview"
                  @click=${(e: Event) => { e.stopPropagation(); this.showCanvasPreview = false; }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>
            <div class="canvas-preview-body">
              <!-- Preview iframe replaced with a glanceable card; clicking
               the parent opens the in-app /whiteboard route. The dead
               localhost:3000 server is gone. -->
          <div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:linear-gradient(135deg,#1f2937,#0f172a);color:#a3a3ad;cursor:pointer">
            <div style="text-align:center">
              <div style="font-size:32px;margin-bottom:6px">🎨</div>
              <div style="font-size:12px;opacity:0.85">Open whiteboard</div>
            </div>
          </div>
            </div>
          </div>
        ` : nothing}

        ${this.panel.maximized ? nothing : html`
          <div class="resize-handle resize-n" @mousedown=${(e: MouseEvent) => this.handleResizeMouseDown("n", e)} @touchstart=${(e: TouchEvent) => this.handleResizeMouseDown("n", e)}></div>
          <div class="resize-handle resize-s" @mousedown=${(e: MouseEvent) => this.handleResizeMouseDown("s", e)} @touchstart=${(e: TouchEvent) => this.handleResizeMouseDown("s", e)}></div>
          <div class="resize-handle resize-e" @mousedown=${(e: MouseEvent) => this.handleResizeMouseDown("e", e)} @touchstart=${(e: TouchEvent) => this.handleResizeMouseDown("e", e)}></div>
          <div class="resize-handle resize-w" @mousedown=${(e: MouseEvent) => this.handleResizeMouseDown("w", e)} @touchstart=${(e: TouchEvent) => this.handleResizeMouseDown("w", e)}></div>
          <div class="resize-handle resize-ne" @mousedown=${(e: MouseEvent) => this.handleResizeMouseDown("ne", e)} @touchstart=${(e: TouchEvent) => this.handleResizeMouseDown("ne", e)}></div>
          <div class="resize-handle resize-nw" @mousedown=${(e: MouseEvent) => this.handleResizeMouseDown("nw", e)} @touchstart=${(e: TouchEvent) => this.handleResizeMouseDown("nw", e)}></div>
          <div class="resize-handle resize-se" @mousedown=${(e: MouseEvent) => this.handleResizeMouseDown("se", e)} @touchstart=${(e: TouchEvent) => this.handleResizeMouseDown("se", e)}></div>
          <div class="resize-handle resize-sw" @mousedown=${(e: MouseEvent) => this.handleResizeMouseDown("sw", e)} @touchstart=${(e: TouchEvent) => this.handleResizeMouseDown("sw", e)}></div>
        `}
        
        ${this.isResizing ? html`
          <div class="resize-size-indicator">
            <div class="resize-size-indicator__dim">
              <span class="resize-size-indicator__value">${Math.round(this.panel.width)}</span>
              <span class="resize-size-indicator__x">×</span>
              <span class="resize-size-indicator__value">${Math.round(this.panel.height)}</span>
              <span class="resize-size-indicator__unit">px</span>
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderMessageGroup(group: { role: string; messages: typeof this.messages; timestamp: number }) {
    const roleClass = group.role === "user" ? "user" : "assistant";
    const who = group.role === "user" ? "You" : "Infini";

    const timestamp = new Date(group.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const isAssistant = group.role === "assistant";

    return html`
      <div class="chat-group ${roleClass}">
        ${isAssistant
          ? renderBrandAvatar("chat-avatar assistant", who)
          : html`<div class="chat-avatar ${roleClass}">U</div>`}
        <div class="chat-group-messages">
          ${group.messages.map((msg, idx) => {
            if (msg.panelRefs?.length) return html`${msg.panelRefs.map((ref: ChatPanelRef) => renderChatPanelRef(ref))}`;
            const messageId = `grid-${this.panel.id}-${group.timestamp}-${idx}`;
            const content = msg.content || '';
            const images = msg.images || [];
            
            return html`
              <div class="chat-bubble ${isAssistant ? 'has-actions' : ''}">
                ${isAssistant && content ? html`
                  <div class="grid-bubble-actions">
                    <button
                      class="grid-action-btn grid-tts-btn"
                      title="Speak"
                      data-playing=${isMessagePlaying(messageId) ? '1' : ''}
                      data-paused=${isMessagePaused(messageId) ? '1' : ''}
                      @click=${async (e: Event) => {
                        const btn = e.currentTarget as HTMLButtonElement;
                        if (btn.dataset.loading === '1') return;

                        if (isMessagePlaying(messageId)) {
                          pauseTTS(messageId);
                          btn.dataset.playing = '';
                          btn.dataset.paused = '1';
                          btn.title = 'Resume';
                          return;
                        }
                        if (isMessagePaused(messageId)) {
                          await resumeTTS(messageId);
                          btn.dataset.playing = '1';
                          btn.dataset.paused = '';
                          btn.title = 'Pause';
                          return;
                        }

                        btn.dataset.loading = '1';
                        try {
                          await speakText(content, messageId);
                          btn.dataset.playing = '1';
                          btn.dataset.paused = '';
                          btn.title = 'Pause';
                        } catch (err) {
                          console.error('[TTS] Error:', err);
                        } finally {
                          btn.dataset.loading = '';
                        }
                      }}
                      @contextmenu=${(e: MouseEvent) => {
                        e.preventDefault();
                        stopTTS(messageId);
                      }}
                    >
                      ${isMessagePlaying(messageId) ? (icons.pause || '⏸') : icons.volumeUp}
                    </button>
                    <button
                      class="grid-action-btn grid-copy-btn"
                      title="Copy"
                      @click=${async (e: Event) => {
                        const btn = e.currentTarget as HTMLButtonElement;
                        try {
                          await navigator.clipboard.writeText(content);
                          btn.dataset.copied = '1';
                          setTimeout(() => { btn.dataset.copied = ''; }, 1500);
                        } catch (err) {
                          console.error('Copy failed:', err);
                        }
                      }}
                    >
                      ${icons.copy}
                    </button>
                    <button
                      class="grid-action-btn grid-save-btn"
                      title="Save to Notes"
                      @click=${async (e: Event) => {
                        const btn = e.currentTarget as HTMLButtonElement;
                        if (btn.dataset.saving === '1') return;
                        btn.dataset.saving = '1';
                        
                        try {
                          const title = content.slice(0, 50) + (content.length > 50 ? '...' : '');
                          this.dispatchEvent(new CustomEvent('save-to-notes', {
                            bubbles: true,
                            composed: true,
                            detail: { title, content, panelId: this.panel.id }
                          }));
                          btn.dataset.saved = '1';
                          setTimeout(() => { btn.dataset.saved = ''; }, 2000);
                        } catch (err) {
                          console.error('Save failed:', err);
                        } finally {
                          btn.dataset.saving = '';
                        }
                      }}
                    >
                      ${icons.book}
                    </button>
                  </div>
                ` : nothing}
                ${images.length > 0 ? html`
                  <div class="message-images">
                    ${images.map(img => html`
                      <img 
                        class="message-image" 
                        src="${img.data}" 
                        alt="Uploaded image"
                        @click=${(e: Event) => {
                          // Open image in lightbox/fullscreen on click
                          const imgEl = e.target as HTMLImageElement;
                          window.open(imgEl.src, '_blank');
                        }}
                      />
                    `)}
                  </div>
                ` : nothing}
                ${content ? unsafeHTML(toSanitizedMarkdownHtml(content)) : nothing}
              </div>
            `;
          })}
          <div class="chat-group-footer">
            <span class="chat-sender-name">${who}</span>
            <span class="chat-group-timestamp">${timestamp}</span>
          </div>
        </div>
      </div>
    `;
  }
}

// ============================================================
// Canvas Panel Component - Excalidraw Whiteboard
// ============================================================

@customElement("canvas-grid-panel")
export class CanvasGridPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 
        0 25px 80px rgba(0,0,0,0.7),
        0 0 1px color-mix(in srgb, var(--g-primary) 50%, transparent);
      transition: box-shadow 0.2s, transform 0.1s, border-color 0.2s;
    }

    :host(.active) {
      box-shadow: 
        0 30px 100px rgba(0,0,0,0.8),
        0 0 0 2px color-mix(in srgb, var(--g-primary) 60%, transparent),
        0 0 40px color-mix(in srgb, var(--g-primary) 15%, transparent);
    }

    :host(.dragging) {
      cursor: grabbing;
      transform: scale(1.01);
      box-shadow: 0 30px 100px rgba(0,0,0,0.8), 0 0 60px color-mix(in srgb, var(--g-primary) 20%, transparent);
    }

    * { box-sizing: border-box; }

    svg {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .panel {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: linear-gradient(145deg, rgba(6,6,10,0.98) 0%, rgba(12,12,18,0.98) 100%);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, transparent 100%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      cursor: grab;
      user-select: none;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      flex-shrink: 0;
    }

    .panel-header:active { cursor: grabbing; }

    .panel-header__icon {
      width: 26px;
      height: 26px;
      border-radius: 6px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 25%, transparent) 0%, color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--g-primary);
      flex-shrink: 0;
      font-size: 13px;
    }

    .panel-header__info {
      flex: 1;
      min-width: 0;
    }

    .panel-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--g-primary);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-header__status {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 9px;
      color: rgba(255,255,255,0.35);
    }

    .panel-header__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ef4444;
    }

    .panel-header__dot.connected {
      background: #22c55e;
      box-shadow: 0 0 6px rgba(34,197,94,0.5);
    }

    .panel-controls {
      display: flex;
      gap: 4px;
    }

    .panel-ctrl-btn {
      width: 24px;
      height: 24px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: transparent;
      color: rgba(255, 255, 255, 0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }

    .panel-ctrl-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      color: var(--g-primary);
    }

    .panel-ctrl-btn.close:hover {
      background: rgba(239,68,68,0.2);
      border-color: rgba(239,68,68,0.4);
      color: #ef4444;
    }

    .panel-ctrl-btn svg {
      width: 11px;
      height: 11px;
    }

    .panel-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #fff;
    }

    .canvas-iframe {
      flex: 1;
      width: 100%;
      border: none;
    }

    /* Excalidraw React canvas mount target. Matches the iframe's
       flex sizing so the canvas fills the panel body. Without flex: 1
       the div collapses to 0px and the canvas renders blank. */
    .canvas-mount {
      flex: 1;
      width: 100%;
      min-height: 0;
      background: #fff;
      position: relative;
      overflow: hidden;
    }

    .canvas-loading {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: rgba(6,6,10,0.98);
      padding: 30px;
    }

    .canvas-loading__spinner {
      width: 28px;
      height: 28px;
      border: 2px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-top-color: var(--g-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .canvas-loading__text {
      font-size: 10px;
      color: rgba(255,255,255,0.35);
      font-family: var(--mono, 'JetBrains Mono', monospace);
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Resize handles */
    .resize-handle {
      position: absolute;
      z-index: 10;
    }
    .resize-handle--n { top: -4px; left: 8px; right: 8px; height: 8px; cursor: n-resize; }
    .resize-handle--s { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: s-resize; }
    .resize-handle--e { right: -4px; top: 8px; bottom: 8px; width: 8px; cursor: e-resize; }
    .resize-handle--w { left: -4px; top: 8px; bottom: 8px; width: 8px; cursor: w-resize; }
    .resize-handle--ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
    .resize-handle--nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
    .resize-handle--se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
    .resize-handle--sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }
  `;

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;

  @state() private isLoading = true;

  private handleFocus = () => {
    this.dispatchEvent(new CustomEvent("panel-focus", { bubbles: true, composed: true }));
  };

  private handleHeaderMouseDown = (e: MouseEvent | TouchEvent) => {
    if ((e.target as HTMLElement).closest('.panel-ctrl-btn')) return;
    if ("touches" in e) e.preventDefault();
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e, bubbles: true, composed: true }));
  };

  private handleResizeStart = (edge: string, e: MouseEvent | TouchEvent) => {
    if ("touches" in e) e.preventDefault();
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e }, bubbles: true, composed: true }));
  };

  // The MCP-driven canvas is mounted into `.canvas-mount` after the lit
  // template lands in the DOM. Disposer is held per-panel so closing or
  // unmounting this tile frees the singleton React root for the next
  // surface (overlay or whiteboard route) to claim.
  private canvasDisposer: (() => void) | null = null;
  private canvasMountInFlight = false;

  protected firstUpdated(_changed: PropertyValues): void {
    void this.ensureMounted();
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("isActive") || changed.has("isDragging") || changed.has("isResizing")) {
      this.classList.toggle("active", this.isActive);
      this.classList.toggle("dragging", this.isDragging);
      this.classList.toggle("resizing", this.isResizing);
    }
    // Re-mount if a competing surface (whiteboard route / canvas
    // overlay) stole the singleton React root and emptied our
    // container. Cheap check — only triggers a real mount when
    // children.length === 0 AND no mount is in flight.
    void this.ensureMounted();
  }

  /**
   * Mount the MCP canvas in the shadow DOM container if it isn't
   * already there. Idempotent: safe to call on every render.
   */
  private async ensureMounted(): Promise<void> {
    if (this.canvasMountInFlight) return;
    const container = this.shadowRoot?.querySelector<HTMLElement>(".canvas-mount");
    if (!container) return;
    if (container.children.length > 0 && this.canvasDisposer) return;
    // Drop the stale disposer reference if the container was emptied
    // by a competing surface — the React root is already unmounted.
    if (container.children.length === 0) this.canvasDisposer = null;
    this.canvasMountInFlight = true;
    try {
      const { mountMcpCanvas } = await import("../../../../extensions/mcp-excalidraw/ui/whiteboard");
      const dispose = await mountMcpCanvas(container);
      this.canvasDisposer = dispose;
    } catch (err) {
      console.error("[CanvasGridPanel] mount failed:", err);
    } finally {
      this.canvasMountInFlight = false;
      this.isLoading = false;
      this.requestUpdate();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.canvasDisposer) {
      try { this.canvasDisposer(); } catch { /* already disposed */ }
      this.canvasDisposer = null;
    }
  }

  render() {
    return html`
      <div class="panel" @click=${this.handleFocus}>
        <!-- Resize handles -->
        <div class="resize-handle resize-handle--n" @mousedown=${(e: MouseEvent) => this.handleResizeStart('n', e)}></div>
        <div class="resize-handle resize-handle--s" @mousedown=${(e: MouseEvent) => this.handleResizeStart('s', e)}></div>
        <div class="resize-handle resize-handle--e" @mousedown=${(e: MouseEvent) => this.handleResizeStart('e', e)}></div>
        <div class="resize-handle resize-handle--w" @mousedown=${(e: MouseEvent) => this.handleResizeStart('w', e)}></div>
        <div class="resize-handle resize-handle--ne" @mousedown=${(e: MouseEvent) => this.handleResizeStart('ne', e)}></div>
        <div class="resize-handle resize-handle--nw" @mousedown=${(e: MouseEvent) => this.handleResizeStart('nw', e)}></div>
        <div class="resize-handle resize-handle--se" @mousedown=${(e: MouseEvent) => this.handleResizeStart('se', e)}></div>
        <div class="resize-handle resize-handle--sw" @mousedown=${(e: MouseEvent) => this.handleResizeStart('sw', e)}></div>

        <div class="panel-header" @mousedown=${this.handleHeaderMouseDown} @touchstart=${this.handleHeaderMouseDown}>
          <div class="panel-header__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="m12 19 7-7 3 3-7 7-3-3z"/>
              <path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
            </svg>
          </div>
          <div class="panel-header__info">
            <div class="panel-title">Canvas</div>
            <div class="panel-header__status">
              <span class="panel-header__dot ${this.isLoading ? '' : 'connected'}"></span>
              ${this.isLoading ? 'Loading…' : 'Live'}
            </div>
          </div>
          <div class="panel-controls">
            <button class="panel-ctrl-btn" title="Minimize" @click=${() => this.dispatchEvent(new CustomEvent("panel-minimize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="panel-ctrl-btn" title="Maximize" @click=${() => this.dispatchEvent(new CustomEvent("panel-maximize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="panel-ctrl-btn close" title="Close" @click=${() => this.dispatchEvent(new CustomEvent("panel-close", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <div class="panel-body">
          ${this.isLoading ? html`
            <div class="canvas-loading">
              <div class="canvas-loading__spinner"></div>
              <div class="canvas-loading__text">Loading Excalidraw…</div>
            </div>
          ` : nothing}
          <!-- In-process Excalidraw mount target. Driven by the MCP server
               via canvas.update events fan-out. -->
          <div class="canvas-mount" style="width:100%;height:100%;display:${this.isLoading ? 'none' : 'block'}"></div>
        </div>
      </div>
    `;
  }
}

// ============================================================
// Chart Panel Component - Data Visualization (Gold Terminal Style)
// Supports TradingView pairs AND Solana tokens (DexScreener)
// ============================================================

// Storage keys
const CHART_STORAGE_KEY = "infinibot-saved-coins";
const TV_STORAGE_KEY = "infinibot-tradingview-pairs";
const CHART_MODE_KEY = "infinibot-chart-mode";

type ChartMode = "tradingview" | "solana";

interface SavedCoin {
  address: string;
  name: string;
  symbol?: string;
  addedAt: number;
}

interface TradingViewPair {
  symbol: string;      // e.g., "BINANCE:BTCUSDT"
  name: string;        // e.g., "Bitcoin / USDT"
  category: string;    // e.g., "crypto", "forex", "stocks"
  addedAt: number;
}

// Default TradingView pairs by category
const DEFAULT_TV_PAIRS: TradingViewPair[] = [
  // Crypto
  { symbol: "BINANCE:BTCUSDT", name: "BTC/USDT", category: "crypto", addedAt: 0 },
  { symbol: "BINANCE:ETHUSDT", name: "ETH/USDT", category: "crypto", addedAt: 0 },
  { symbol: "BINANCE:SOLUSDT", name: "SOL/USDT", category: "crypto", addedAt: 0 },
  { symbol: "BINANCE:BNBUSDT", name: "BNB/USDT", category: "crypto", addedAt: 0 },
  { symbol: "BINANCE:XRPUSDT", name: "XRP/USDT", category: "crypto", addedAt: 0 },
  { symbol: "BINANCE:DOGEUSDT", name: "DOGE/USDT", category: "crypto", addedAt: 0 },
  { symbol: "BINANCE:ADAUSDT", name: "ADA/USDT", category: "crypto", addedAt: 0 },
  { symbol: "BINANCE:AVAXUSDT", name: "AVAX/USDT", category: "crypto", addedAt: 0 },
  { symbol: "COINBASE:BTCUSD", name: "BTC/USD", category: "crypto", addedAt: 0 },
  { symbol: "COINBASE:ETHUSD", name: "ETH/USD", category: "crypto", addedAt: 0 },
  // Forex
  { symbol: "FX:EURUSD", name: "EUR/USD", category: "forex", addedAt: 0 },
  { symbol: "FX:GBPUSD", name: "GBP/USD", category: "forex", addedAt: 0 },
  { symbol: "FX:USDJPY", name: "USD/JPY", category: "forex", addedAt: 0 },
  { symbol: "FX:AUDUSD", name: "AUD/USD", category: "forex", addedAt: 0 },
  { symbol: "FX:USDCAD", name: "USD/CAD", category: "forex", addedAt: 0 },
  { symbol: "FX:USDCHF", name: "USD/CHF", category: "forex", addedAt: 0 },
  // Stocks
  { symbol: "NASDAQ:AAPL", name: "Apple", category: "stocks", addedAt: 0 },
  { symbol: "NASDAQ:GOOGL", name: "Google", category: "stocks", addedAt: 0 },
  { symbol: "NASDAQ:MSFT", name: "Microsoft", category: "stocks", addedAt: 0 },
  { symbol: "NASDAQ:AMZN", name: "Amazon", category: "stocks", addedAt: 0 },
  { symbol: "NASDAQ:TSLA", name: "Tesla", category: "stocks", addedAt: 0 },
  { symbol: "NASDAQ:NVDA", name: "NVIDIA", category: "stocks", addedAt: 0 },
  { symbol: "NASDAQ:META", name: "Meta", category: "stocks", addedAt: 0 },
  { symbol: "NYSE:DIS", name: "Disney", category: "stocks", addedAt: 0 },
  // Indices (CFD symbols for traders)
  { symbol: "FOREXCOM:NAS100", name: "NAS100", category: "indices", addedAt: 0 },
  { symbol: "FOREXCOM:US30", name: "US30", category: "indices", addedAt: 0 },
  { symbol: "PEPPERSTONE:GER40", name: "GER30/DAX", category: "indices", addedAt: 0 },
  { symbol: "SP:SPX", name: "S&P 500", category: "indices", addedAt: 0 },
  { symbol: "NASDAQ:NDX", name: "NASDAQ 100", category: "indices", addedAt: 0 },
  { symbol: "DJ:DJI", name: "Dow Jones", category: "indices", addedAt: 0 },
  { symbol: "TVC:DXY", name: "US Dollar Index", category: "indices", addedAt: 0 },
  { symbol: "TVC:VIX", name: "VIX", category: "indices", addedAt: 0 },
  // Commodities
  { symbol: "TVC:GOLD", name: "GOLD", category: "commodities", addedAt: 0 },
  { symbol: "OANDA:XAUUSD", name: "XAU/USD", category: "commodities", addedAt: 0 },
  { symbol: "TVC:SILVER", name: "SILVER", category: "commodities", addedAt: 0 },
  { symbol: "NYMEX:CL1!", name: "Crude Oil", category: "commodities", addedAt: 0 },
];

function loadSavedCoins(): SavedCoin[] {
  try {
    const data = localStorage.getItem(CHART_STORAGE_KEY);
    if (data) return JSON.parse(data);
  } catch (e) {}
  return [
    { address: "So11111111111111111111111111111111111111112", name: "SOL", symbol: "SOL", addedAt: Date.now() },
  ];
}

function saveSavedCoins(coins: SavedCoin[]): void {
  try {
    localStorage.setItem(CHART_STORAGE_KEY, JSON.stringify(coins));
  } catch (e) {}
}

function loadTVPairs(): TradingViewPair[] {
  try {
    const data = localStorage.getItem(TV_STORAGE_KEY);
    if (data) {
      const parsed = JSON.parse(data);
      if (parsed.length > 0) return parsed;
    }
  } catch (e) {}
  return [...DEFAULT_TV_PAIRS];
}

function saveTVPairs(pairs: TradingViewPair[]): void {
  try {
    localStorage.setItem(TV_STORAGE_KEY, JSON.stringify(pairs));
  } catch (e) {}
}

function loadChartMode(): ChartMode {
  try {
    const mode = localStorage.getItem(CHART_MODE_KEY);
    if (mode === "solana" || mode === "tradingview") return mode;
  } catch (e) {}
  return "tradingview";
}

function saveChartMode(mode: ChartMode): void {
  try {
    localStorage.setItem(CHART_MODE_KEY, mode);
  } catch (e) {}
}

@customElement("chart-grid-panel")
export class ChartGridPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 
        0 25px 80px rgba(0,0,0,0.7),
        0 0 1px color-mix(in srgb, var(--g-primary) 50%, transparent);
      transition: box-shadow 0.2s, transform 0.1s, border-color 0.2s;
    }

    :host(.active) {
      box-shadow: 
        0 30px 100px rgba(0,0,0,0.8),
        0 0 0 2px color-mix(in srgb, var(--g-primary) 60%, transparent),
        0 0 40px color-mix(in srgb, var(--g-primary) 15%, transparent);
    }

    :host(.dragging) {
      cursor: grabbing;
      transform: scale(1.01);
      box-shadow: 0 30px 100px rgba(0,0,0,0.8), 0 0 60px color-mix(in srgb, var(--g-primary) 20%, transparent);
    }

    * { box-sizing: border-box; }

    svg {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .panel {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: linear-gradient(145deg, rgba(6,6,10,0.98) 0%, rgba(12,12,18,0.98) 100%);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, transparent 100%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      cursor: grab;
      user-select: none;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      flex-shrink: 0;
    }

    .panel-header:active { cursor: grabbing; }

    .panel-header__icon {
      width: 26px;
      height: 26px;
      border-radius: 6px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 25%, transparent) 0%, color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--g-primary);
      flex-shrink: 0;
    }

    .panel-header__icon svg {
      width: 13px;
      height: 13px;
    }

    .panel-header__info {
      flex: 1;
      min-width: 0;
    }

    .panel-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--g-primary);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-header__status {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 9px;
      color: rgba(255,255,255,0.35);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-controls {
      display: flex;
      gap: 4px;
    }

    .panel-ctrl-btn {
      width: 24px;
      height: 24px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: transparent;
      color: rgba(255, 255, 255, 0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }

    .panel-ctrl-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      color: var(--g-primary);
    }

    .panel-ctrl-btn.close:hover {
      background: rgba(239,68,68,0.2);
      border-color: rgba(239,68,68,0.4);
      color: #ef4444;
    }

    .panel-ctrl-btn svg {
      width: 11px;
      height: 11px;
    }

    /* Mode toggle tabs */
    .chart-mode-tabs {
      display: flex;
      padding: 6px 12px;
      gap: 4px;
      background: rgba(0,0,0,0.3);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    }

    .chart-mode-tab {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      border-radius: 4px;
      background: transparent;
      color: rgba(255,255,255,0.4);
      font-size: 9px;
      font-weight: 600;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      cursor: pointer;
      transition: all 0.15s;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .chart-mode-tab:hover {
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      color: rgba(255,255,255,0.6);
    }

    .chart-mode-tab.active {
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      color: var(--g-primary);
    }

    /* Chart controls bar */
    .chart-controls {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      background: rgba(0,0,0,0.25);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
      align-items: center;
      flex-shrink: 0;
    }

    .chart-select {
      flex: 1;
      padding: 7px 28px 7px 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-radius: 5px;
      background: rgba(0,0,0,0.4);
      color: #fff;
      font-size: 10px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      cursor: pointer;
      outline: none;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23D4AF37' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      transition: all 0.15s;
    }

    .chart-select:hover { border-color: color-mix(in srgb, var(--g-primary) 35%, transparent); }
    .chart-select:focus { border-color: var(--g-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--g-primary) 12%, transparent); }
    .chart-select option { background: #0a0a0f; color: #fff; }
    .chart-select optgroup { background: #0a0a0f; color: var(--g-primary); font-weight: 700; }

    .chart-ctrl-btn {
      width: 28px;
      height: 28px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 5px;
      background: color-mix(in srgb, var(--g-primary) 6%, transparent);
      color: var(--g-primary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;
    }

    .chart-ctrl-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-color: var(--g-primary);
      transform: scale(1.05);
    }

    .chart-ctrl-btn svg { width: 12px; height: 12px; }

    /* Add form */
    .chart-form {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 12px;
      background: rgba(0,0,0,0.35);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
      animation: chart-expand 0.2s ease;
      flex-shrink: 0;
    }

    @keyframes chart-expand {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .chart-form__row { display: flex; gap: 6px; }

    .chart-form__hint {
      font-size: 9px;
      color: rgba(255,255,255,0.3);
      padding: 0 2px;
    }

    .chart-input {
      flex: 1;
      padding: 7px 10px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
      border-radius: 5px;
      background: rgba(0,0,0,0.35);
      color: #fff;
      font-size: 10px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      outline: none;
      transition: all 0.15s;
    }

    .chart-input::placeholder { color: rgba(255,255,255,0.2); }
    .chart-input:focus { border-color: color-mix(in srgb, var(--g-primary) 40%, transparent); background: rgba(0,0,0,0.5); }

    .chart-btn-add {
      padding: 7px 12px;
      border: none;
      border-radius: 5px;
      background: linear-gradient(135deg, var(--g-primary) 0%, #B8962E 100%);
      color: #000;
      font-size: 9px;
      font-weight: 700;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      cursor: pointer;
      transition: all 0.15s;
      letter-spacing: 0.02em;
    }

    .chart-btn-add:hover { transform: scale(1.02); box-shadow: 0 4px 12px color-mix(in srgb, var(--g-primary) 25%, transparent); }
    .chart-btn-add:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

    .chart-btn-cancel {
      padding: 7px 10px;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 5px;
      background: transparent;
      color: rgba(255,255,255,0.4);
      font-size: 10px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
      cursor: pointer;
      transition: all 0.15s;
    }

    .chart-btn-cancel:hover { background: rgba(255,255,255,0.05); color: #fff; }

    /* Chart body */
    .panel-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: #070709;
      position: relative;
    }

    .chart-iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
    }

    .chart-loading {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: rgba(6,6,10,0.95);
      z-index: 5;
    }

    .chart-spinner {
      width: 28px;
      height: 28px;
      border: 2px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-top-color: var(--g-primary);
      border-radius: 50%;
      animation: chart-spin 0.8s linear infinite;
    }

    @keyframes chart-spin { to { transform: rotate(360deg); } }

    .chart-loading__text { font-size: 10px; color: rgba(255,255,255,0.3); }

    .chart-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: rgba(255,255,255,0.3);
      padding: 24px;
      text-align: center;
    }

    .chart-empty__icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--g-primary);
    }

    .chart-empty__icon svg { width: 20px; height: 20px; }
    .chart-empty__text { font-size: 11px; }

    /* Resize handles */
    .resize-handle {
      position: absolute;
      z-index: 10;
    }
    .resize-handle--n { top: -4px; left: 8px; right: 8px; height: 8px; cursor: n-resize; }
    .resize-handle--s { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: s-resize; }
    .resize-handle--e { right: -4px; top: 8px; bottom: 8px; width: 8px; cursor: e-resize; }
    .resize-handle--w { left: -4px; top: 8px; bottom: 8px; width: 8px; cursor: w-resize; }
    .resize-handle--ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
    .resize-handle--nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
    .resize-handle--se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
    .resize-handle--sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }
  `;

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;

  // Chart mode state
  @state() private chartMode: ChartMode = "tradingview";
  
  // TradingView state
  @state() private tvPairs: TradingViewPair[] = [];
  @state() private currentTVSymbol = "";
  @state() private inputSymbol = "";
  @state() private inputTVName = "";
  
  // Solana state
  @state() private savedCoins: SavedCoin[] = [];
  @state() private currentAddress = "";
  @state() private inputAddress = "";
  @state() private inputName = "";
  
  // Shared state
  @state() private showAddForm = false;
  @state() private isLoading = false;

  connectedCallback() {
    super.connectedCallback();
    this.chartMode = loadChartMode();
    this.tvPairs = loadTVPairs();
    this.savedCoins = loadSavedCoins();
    this.currentTVSymbol = this.tvPairs[0]?.symbol || "";
    this.currentAddress = this.savedCoins[0]?.address || "";
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("isActive") || changed.has("isDragging") || changed.has("isResizing")) {
      this.classList.toggle("active", this.isActive);
      this.classList.toggle("dragging", this.isDragging);
      this.classList.toggle("resizing", this.isResizing);
    }
  }

  private handleFocus = () => {
    this.dispatchEvent(new CustomEvent("panel-focus", { bubbles: true, composed: true }));
  };

  private handleHeaderMouseDown = (e: MouseEvent | TouchEvent) => {
    if ((e.target as HTMLElement).closest('.panel-ctrl-btn')) return;
    if ("touches" in e) e.preventDefault();
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e, bubbles: true, composed: true }));
  };

  private handleResizeStart = (edge: string, e: MouseEvent | TouchEvent) => {
    if ("touches" in e) e.preventDefault();
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e }, bubbles: true, composed: true }));
  };

  private handleModeChange = (mode: ChartMode) => {
    this.chartMode = mode;
    this.showAddForm = false;
    saveChartMode(mode);
  };

  // TradingView handlers
  private handleSelectTVPair = (symbol: string) => {
    this.currentTVSymbol = symbol;
    this.isLoading = true;
    setTimeout(() => { this.isLoading = false; }, 1500);
  };

  private handleAddTVPair = () => {
    if (!this.inputSymbol.trim()) return;
    const newPair: TradingViewPair = {
      symbol: this.inputSymbol.trim().toUpperCase(),
      name: this.inputTVName.trim() || this.inputSymbol.trim(),
      category: "custom",
      addedAt: Date.now(),
    };
    this.tvPairs = [...this.tvPairs, newPair];
    saveTVPairs(this.tvPairs);
    this.currentTVSymbol = newPair.symbol;
    this.inputSymbol = "";
    this.inputTVName = "";
    this.showAddForm = false;
  };

  // Solana handlers
  private handleSelectCoin = (address: string) => {
    this.currentAddress = address;
    this.isLoading = true;
    setTimeout(() => { this.isLoading = false; }, 2000);
  };

  private handleAddCoin = () => {
    if (!this.inputAddress.trim()) return;
    const newCoin: SavedCoin = {
      address: this.inputAddress.trim(),
      name: this.inputName.trim() || this.inputAddress.slice(0, 6) + "...",
      addedAt: Date.now(),
    };
    this.savedCoins = [...this.savedCoins, newCoin];
    saveSavedCoins(this.savedCoins);
    this.currentAddress = newCoin.address;
    this.inputAddress = "";
    this.inputName = "";
    this.showAddForm = false;
  };

  private handleRefresh = () => {
    this.isLoading = true;
    setTimeout(() => { this.isLoading = false; }, 1500);
  };

  private getTVChartUrl(): string {
    if (!this.currentTVSymbol) return "";
    const symbol = encodeURIComponent(this.currentTVSymbol);
    return `https://s.tradingview.com/widgetembed/?frameElementId=tv_chart&symbol=${symbol}&interval=D&hidesidetoolbar=0&symboledit=1&saveimage=1&toolbarbg=0a0a0f&studies=[]&theme=dark&style=1&timezone=Etc%2FUTC&studies_overrides={}&overrides={}&enabled_features=[]&disabled_features=[]&locale=en&utm_source=localhost&utm_medium=widget&utm_campaign=chart`;
  }

  private getSolanaChartUrl(): string {
    if (!this.currentAddress) return "";
    return `https://dexscreener.com/solana/${this.currentAddress}?embed=1&theme=dark&trades=0&info=0`;
  }

  // Group TradingView pairs by category
  private getTVPairsByCategory(): Map<string, TradingViewPair[]> {
    const groups = new Map<string, TradingViewPair[]>();
    const order = ["crypto", "forex", "stocks", "indices", "commodities", "custom"];
    order.forEach(cat => groups.set(cat, []));
    
    for (const pair of this.tvPairs) {
      const cat = pair.category || "custom";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(pair);
    }
    
    return groups;
  }

  render() {
    const currentTVPair = this.tvPairs.find(p => p.symbol === this.currentTVSymbol);
    const currentCoin = this.savedCoins.find(c => c.address === this.currentAddress);
    
    const displayName = this.chartMode === "tradingview" 
      ? (currentTVPair?.name || this.currentTVSymbol || "CHART")
      : (currentCoin?.symbol || currentCoin?.name || "CHART");
      
    const subText = this.chartMode === "tradingview"
      ? (currentTVPair?.symbol || "Select pair")
      : (currentCoin?.address?.slice(0, 12) + "..." || "Select token");

    const chartUrl = this.chartMode === "tradingview" 
      ? this.getTVChartUrl()
      : this.getSolanaChartUrl();

    const pairsByCategory = this.getTVPairsByCategory();
    const categoryLabels: Record<string, string> = {
      crypto: "🪙 Crypto",
      forex: "💱 Forex",
      stocks: "📈 Stocks",
      indices: "📊 Indices",
      commodities: "🛢️ Commodities",
      custom: "⭐ Custom",
    };

    return html`
      <div class="panel" @click=${this.handleFocus}>
        <!-- Resize handles -->
        <div class="resize-handle resize-handle--n" @mousedown=${(e: MouseEvent) => this.handleResizeStart('n', e)}></div>
        <div class="resize-handle resize-handle--s" @mousedown=${(e: MouseEvent) => this.handleResizeStart('s', e)}></div>
        <div class="resize-handle resize-handle--e" @mousedown=${(e: MouseEvent) => this.handleResizeStart('e', e)}></div>
        <div class="resize-handle resize-handle--w" @mousedown=${(e: MouseEvent) => this.handleResizeStart('w', e)}></div>
        <div class="resize-handle resize-handle--ne" @mousedown=${(e: MouseEvent) => this.handleResizeStart('ne', e)}></div>
        <div class="resize-handle resize-handle--nw" @mousedown=${(e: MouseEvent) => this.handleResizeStart('nw', e)}></div>
        <div class="resize-handle resize-handle--se" @mousedown=${(e: MouseEvent) => this.handleResizeStart('se', e)}></div>
        <div class="resize-handle resize-handle--sw" @mousedown=${(e: MouseEvent) => this.handleResizeStart('sw', e)}></div>

        <div class="panel-header" @mousedown=${this.handleHeaderMouseDown} @touchstart=${this.handleHeaderMouseDown}>
          <div class="panel-header__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="12" y1="20" x2="12" y2="10"/>
              <line x1="18" y1="20" x2="18" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="16"/>
            </svg>
          </div>
          <div class="panel-header__info">
            <div class="panel-title">${displayName}</div>
            <div class="panel-header__status">${subText}</div>
          </div>
          <div class="panel-controls">
            <button class="panel-ctrl-btn" title="Minimize" @click=${() => this.dispatchEvent(new CustomEvent("panel-minimize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="panel-ctrl-btn" title="Maximize" @click=${() => this.dispatchEvent(new CustomEvent("panel-maximize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="panel-ctrl-btn close" title="Close" @click=${() => this.dispatchEvent(new CustomEvent("panel-close", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <!-- Mode toggle tabs -->
        <div class="chart-mode-tabs">
          <button 
            class="chart-mode-tab ${this.chartMode === 'tradingview' ? 'active' : ''}"
            @click=${() => this.handleModeChange('tradingview')}
          >
            📊 TradingView
          </button>
          <button 
            class="chart-mode-tab ${this.chartMode === 'solana' ? 'active' : ''}"
            @click=${() => this.handleModeChange('solana')}
          >
            ◎ Solana
          </button>
        </div>

        <!-- Chart controls -->
        <div class="chart-controls">
          ${this.chartMode === "tradingview" ? html`
            <select 
              class="chart-select" 
              .value=${this.currentTVSymbol}
              @change=${(e: Event) => this.handleSelectTVPair((e.target as HTMLSelectElement).value)}
            >
              ${Array.from(pairsByCategory.entries())
                .filter(([_, pairs]) => pairs.length > 0)
                .map(([category, pairs]) => html`
                  <optgroup label="${categoryLabels[category] || category}">
                    ${pairs.map(pair => html`
                      <option value=${pair.symbol}>${pair.name}</option>
                    `)}
                  </optgroup>
                `)
              }
            </select>
          ` : html`
            <select 
              class="chart-select" 
              .value=${this.currentAddress}
              @change=${(e: Event) => this.handleSelectCoin((e.target as HTMLSelectElement).value)}
            >
              ${this.savedCoins.length === 0 
                ? html`<option value="">No coins saved</option>`
                : this.savedCoins.map(coin => html`
                    <option value=${coin.address}>${coin.symbol || coin.name}</option>
                  `)
              }
            </select>
          `}
          <button 
            class="chart-ctrl-btn" 
            @click=${() => { this.showAddForm = !this.showAddForm; }}
            title="${this.showAddForm ? 'Cancel' : 'Add'}"
          >
            ${this.showAddForm 
              ? html`<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
              : html`<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
            }
          </button>
          <button 
            class="chart-ctrl-btn" 
            @click=${this.handleRefresh}
            title="Refresh"
          >
            <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          </button>
        </div>

        <!-- Add form -->
        ${this.showAddForm ? html`
          <div class="chart-form">
            ${this.chartMode === "tradingview" ? html`
              <div class="chart-form__hint">Format: EXCHANGE:SYMBOL (e.g., BINANCE:BTCUSDT, NASDAQ:AAPL)</div>
              <input 
                type="text" 
                class="chart-input" 
                placeholder="BINANCE:BTCUSDT"
                .value=${this.inputSymbol}
                @input=${(e: Event) => { this.inputSymbol = (e.target as HTMLInputElement).value; }}
                @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.handleAddTVPair()}
              />
              <div class="chart-form__row">
                <input 
                  type="text" 
                  class="chart-input" 
                  placeholder="Display name (optional)"
                  .value=${this.inputTVName}
                  @input=${(e: Event) => { this.inputTVName = (e.target as HTMLInputElement).value; }}
                  @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.handleAddTVPair()}
                />
                <button class="chart-btn-add" @click=${this.handleAddTVPair} ?disabled=${!this.inputSymbol.trim()}>ADD</button>
                <button class="chart-btn-cancel" @click=${() => { this.showAddForm = false; this.inputSymbol = ""; this.inputTVName = ""; }}>×</button>
              </div>
            ` : html`
              <input 
                type="text" 
                class="chart-input" 
                placeholder="Solana token address..."
                .value=${this.inputAddress}
                @input=${(e: Event) => { this.inputAddress = (e.target as HTMLInputElement).value; }}
                @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.handleAddCoin()}
              />
              <div class="chart-form__row">
                <input 
                  type="text" 
                  class="chart-input" 
                  placeholder="Name (optional)"
                  .value=${this.inputName}
                  @input=${(e: Event) => { this.inputName = (e.target as HTMLInputElement).value; }}
                  @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this.handleAddCoin()}
                />
                <button class="chart-btn-add" @click=${this.handleAddCoin} ?disabled=${!this.inputAddress.trim()}>ADD</button>
                <button class="chart-btn-cancel" @click=${() => { this.showAddForm = false; this.inputAddress = ""; this.inputName = ""; }}>×</button>
              </div>
            `}
          </div>
        ` : nothing}

        <div class="panel-body">
          ${this.isLoading ? html`
            <div class="chart-loading">
              <div class="chart-spinner"></div>
              <div class="chart-loading__text">Loading chart...</div>
            </div>
          ` : nothing}
          
          ${chartUrl ? html`
            <iframe 
              class="chart-iframe" 
              src=${chartUrl}
              @load=${() => { this.isLoading = false; }}
            ></iframe>
          ` : html`
            <div class="chart-empty">
              <div class="chart-empty__icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 3v18h18"/>
                  <path d="m19 9-5 5-4-4-3 3"/>
                </svg>
              </div>
              <div class="chart-empty__text">
                ${this.chartMode === "tradingview" ? "Select a trading pair" : "Add a token to view chart"}
              </div>
            </div>
          `}
        </div>
      </div>
    `;
  }
}

// ============================================================
// Video Grid Panel Component
// ============================================================

@customElement("video-grid-panel")
export class VideoGridPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 
        0 25px 80px rgba(0,0,0,0.7),
        0 0 1px color-mix(in srgb, var(--g-primary) 50%, transparent);
      transition: box-shadow 0.2s, transform 0.1s, border-color 0.2s;
    }

    :host(.active) {
      box-shadow: 
        0 30px 100px rgba(0,0,0,0.8),
        0 0 0 2px color-mix(in srgb, var(--g-primary) 60%, transparent),
        0 0 40px color-mix(in srgb, var(--g-primary) 15%, transparent);
    }

    :host(.dragging) {
      cursor: grabbing;
      transform: scale(1.01);
      box-shadow: 0 30px 100px rgba(0,0,0,0.8), 0 0 60px color-mix(in srgb, var(--g-primary) 20%, transparent);
    }

    * { box-sizing: border-box; }

    svg {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .panel {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: linear-gradient(145deg, rgba(6,6,10,0.98) 0%, rgba(12,12,18,0.98) 100%);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, transparent 100%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      cursor: grab;
      user-select: none;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      flex-shrink: 0;
    }

    .panel-header:active { cursor: grabbing; }

    .panel-header__icon {
      width: 26px;
      height: 26px;
      border-radius: 6px;
      background: linear-gradient(135deg, rgba(34,197,94,0.25) 0%, rgba(34,197,94,0.08) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #22c55e;
      flex-shrink: 0;
      font-size: 13px;
    }

    .panel-header__info {
      flex: 1;
      min-width: 0;
    }

    .panel-title {
      font-size: 11px;
      font-weight: 700;
      color: #22c55e;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-header__status {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 9px;
      color: rgba(255,255,255,0.35);
    }

    .panel-header__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ef4444;
    }

    .panel-header__dot.live {
      background: #22c55e;
      box-shadow: 0 0 6px rgba(34,197,94,0.5);
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .panel-controls {
      display: flex;
      gap: 4px;
    }

    .panel-ctrl-btn {
      width: 24px;
      height: 24px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: transparent;
      color: rgba(255, 255, 255, 0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }

    .panel-ctrl-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      color: var(--g-primary);
    }

    .panel-ctrl-btn.close:hover {
      background: rgba(239,68,68,0.2);
      border-color: rgba(239,68,68,0.4);
      color: #ef4444;
    }

    .panel-ctrl-btn svg {
      width: 11px;
      height: 11px;
    }

    .panel-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Resize handles */
    .resize-handle {
      position: absolute;
      z-index: 10;
    }
    .resize-handle--n { top: -4px; left: 8px; right: 8px; height: 8px; cursor: n-resize; }
    .resize-handle--s { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: s-resize; }
    .resize-handle--e { right: -4px; top: 8px; bottom: 8px; width: 8px; cursor: e-resize; }
    .resize-handle--w { left: -4px; top: 8px; bottom: 8px; width: 8px; cursor: w-resize; }
    .resize-handle--ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
    .resize-handle--nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
    .resize-handle--se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
    .resize-handle--sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }
  `;

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;

  @state() private isStreaming = false;

  updated(changed: Map<string, unknown>) {
    if (changed.has("isActive") || changed.has("isDragging") || changed.has("isResizing")) {
      this.classList.toggle("active", this.isActive);
      this.classList.toggle("dragging", this.isDragging);
      this.classList.toggle("resizing", this.isResizing);
    }
  }

  connectedCallback() {
    super.connectedCallback();
    // Listen for video feed state changes
    this.checkVideoState();
  }

  private checkVideoState() {
    // Import the video feed module and check state
    import("../components/video-feed").then(({ isVideoFeedActive }) => {
      this.isStreaming = isVideoFeedActive();
    });
  }

  private handleFocus = () => {
    this.dispatchEvent(new CustomEvent("panel-focus", { bubbles: true, composed: true }));
  };

  private handleHeaderMouseDown = (e: MouseEvent | TouchEvent) => {
    if ((e.target as HTMLElement).closest('.panel-ctrl-btn')) return;
    if ("touches" in e) e.preventDefault();
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e, bubbles: true, composed: true }));
  };

  private handleResizeStart = (edge: string, e: MouseEvent | TouchEvent) => {
    if ("touches" in e) e.preventDefault();
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e }, bubbles: true, composed: true }));
  };

  render() {
    return html`
      <div class="panel" @click=${this.handleFocus}>
        <!-- Resize handles -->
        <div class="resize-handle resize-handle--n" @mousedown=${(e: MouseEvent) => this.handleResizeStart('n', e)}></div>
        <div class="resize-handle resize-handle--s" @mousedown=${(e: MouseEvent) => this.handleResizeStart('s', e)}></div>
        <div class="resize-handle resize-handle--e" @mousedown=${(e: MouseEvent) => this.handleResizeStart('e', e)}></div>
        <div class="resize-handle resize-handle--w" @mousedown=${(e: MouseEvent) => this.handleResizeStart('w', e)}></div>
        <div class="resize-handle resize-handle--ne" @mousedown=${(e: MouseEvent) => this.handleResizeStart('ne', e)}></div>
        <div class="resize-handle resize-handle--nw" @mousedown=${(e: MouseEvent) => this.handleResizeStart('nw', e)}></div>
        <div class="resize-handle resize-handle--se" @mousedown=${(e: MouseEvent) => this.handleResizeStart('se', e)}></div>
        <div class="resize-handle resize-handle--sw" @mousedown=${(e: MouseEvent) => this.handleResizeStart('sw', e)}></div>

        <div class="panel-header" @mousedown=${this.handleHeaderMouseDown} @touchstart=${this.handleHeaderMouseDown}>
          <div class="panel-header__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M15.6 11.6L22 7v10l-6.4-4.6a1 1 0 0 1 0-1.8z"/>
              <rect x="2" y="6" width="14" height="12" rx="2"/>
            </svg>
          </div>
          <div class="panel-header__info">
            <div class="panel-title">Video Feed</div>
            <div class="panel-header__status">
              <span class="panel-header__dot ${this.isStreaming ? 'live' : ''}"></span>
              ${this.isStreaming ? 'LIVE' : 'Ready'}
            </div>
          </div>
          <div class="panel-controls">
            <button class="panel-ctrl-btn" title="Minimize" @click=${() => this.dispatchEvent(new CustomEvent("panel-minimize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="panel-ctrl-btn" title="Maximize" @click=${() => this.dispatchEvent(new CustomEvent("panel-maximize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="panel-ctrl-btn close" title="Close" @click=${() => this.dispatchEvent(new CustomEvent("panel-close", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <div class="panel-body">
          <video-feed-panel></video-feed-panel>
        </div>
      </div>
    `;
  }
}

// ============================================================
// Voice Grid Panel — voice call launcher
//
// Starts a voice call (it keeps running while you stay on the Grid). Local
// voice is the default; Cloud voice (Robovoice) is an optional, free choice
// the user makes on the Voice page.
// ============================================================

@customElement("voice-grid-panel")
export class VoiceGridPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
      border-radius: 12px;
      overflow: hidden;
      box-shadow:
        0 25px 80px rgba(0,0,0,0.7),
        0 0 1px color-mix(in srgb, var(--g-primary) 50%, transparent);
      transition: box-shadow 0.2s, transform 0.1s, border-color 0.2s;
    }
    :host(.active) {
      box-shadow:
        0 30px 100px rgba(0,0,0,0.8),
        0 0 0 2px color-mix(in srgb, var(--g-primary) 60%, transparent),
        0 0 40px color-mix(in srgb, var(--g-primary) 15%, transparent);
    }
    :host(.dragging) {
      cursor: grabbing;
      transform: scale(1.01);
      box-shadow: 0 30px 100px rgba(0,0,0,0.8), 0 0 60px color-mix(in srgb, var(--g-primary) 20%, transparent);
    }
    * { box-sizing: border-box; }
    svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

    .panel {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: linear-gradient(145deg, rgba(6,6,10,0.98) 0%, rgba(12,12,18,0.98) 100%);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
      position: relative;
    }

    /* Header (mirrors VideoGridPanel chrome) */
    .panel-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, transparent 100%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      cursor: grab;
      user-select: none;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      flex-shrink: 0;
    }
    .panel-header:active { cursor: grabbing; }
    .panel-header__icon {
      width: 26px; height: 26px;
      border-radius: 6px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 28%, transparent) 0%, color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
      display: flex; align-items: center; justify-content: center;
      color: var(--g-primary);
      flex-shrink: 0;
    }
    .panel-header__icon svg { width: 14px; height: 14px; }
    .panel-header__info { flex: 1; min-width: 0; }
    .panel-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--g-primary);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .panel-header__status {
      display: flex; align-items: center; gap: 5px;
      font-size: 9px;
      color: rgba(255,255,255,0.35);
    }
    .panel-header__dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #555;
      transition: background 0.2s, box-shadow 0.2s;
    }
    .panel-header__dot.connecting { background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,0.5); animation: vgp-pulse 1.2s ease-in-out infinite; }
    .panel-header__dot.live { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.6); animation: vgp-pulse 1.5s ease-in-out infinite; }
    .panel-header__dot.error { background: #ef4444; box-shadow: 0 0 6px rgba(239,68,68,0.6); }
    @keyframes vgp-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }

    .panel-controls { display: flex; gap: 4px; }
    .panel-ctrl-btn {
      width: 24px; height: 24px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: transparent;
      color: rgba(255,255,255,0.4);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .panel-ctrl-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      color: var(--g-primary);
    }
    .panel-ctrl-btn.close:hover { background: rgba(239,68,68,0.2); border-color: rgba(239,68,68,0.4); color: #ef4444; }
    .panel-ctrl-btn svg { width: 11px; height: 11px; }

    .panel-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
      container-type: inline-size;
    }

    /* ── Blob host: top ~55% of body, centered, soft radial backdrop ── */
    .vgp-blob-wrap {
      position: relative;
      flex: 0 0 55%;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at center, rgba(20,20,24,0.85) 0%, rgba(5,5,7,1) 72%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    }
    .vgp-blob-host {
      aspect-ratio: 1;
      height: 100%;
      max-height: 100%;
      max-width: 100%;
    }
    .vgp-viz-label {
      position: absolute;
      bottom: 6px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 9px;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: rgba(255,255,255,0.3);
      font-family: var(--mono, 'JetBrains Mono', monospace);
      pointer-events: none;
    }

    /* ── Controls / config below the blob ── */
    .vgp-controls {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 12px;
      font-family: var(--mono, 'JetBrains Mono', monospace);
    }
    .vgp-row { display: flex; flex-direction: column; gap: 3px; }
    .vgp-row label, .vgp-field-label {
      font-size: 9px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: rgba(255,255,255,0.4);
    }
    .vgp-picker { display: flex; gap: 5px; align-items: center; }
    .vgp-row input[type="text"],
    .vgp-row textarea,
    .vgp-picker select {
      width: 100%;
      background: rgba(10,10,12,0.9);
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      border-radius: 6px;
      padding: 6px 8px;
      font-size: 11px;
      color: #e4e4e7;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s;
    }
    .vgp-row input[type="text"]:focus,
    .vgp-row textarea:focus,
    .vgp-picker select:focus { border-color: var(--g-primary); }
    .vgp-icon-btn {
      flex-shrink: 0;
      width: 28px; height: 28px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
      background: transparent;
      color: var(--g-primary);
      border-radius: 6px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .vgp-icon-btn:hover { background: color-mix(in srgb, var(--g-primary) 12%, transparent); }

    .vgp-modes { display: flex; gap: 5px; }
    .vgp-mode {
      flex: 1;
      padding: 5px 4px;
      border: 1px solid rgba(255,255,255,0.1);
      background: transparent;
      color: rgba(255,255,255,0.55);
      border-radius: 6px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s;
    }
    .vgp-mode:hover { border-color: color-mix(in srgb, var(--g-primary) 35%, transparent); }
    .vgp-mode.active {
      border-color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 14%, transparent);
      color: var(--g-primary);
    }

    .vgp-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 10px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.5);
    }
    .vgp-status-pill .pip { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .vgp-status-pill.idle { color: rgba(255,255,255,0.5); }
    .vgp-status-pill.connecting { color: #f59e0b; border-color: rgba(245,158,11,0.4); }
    .vgp-status-pill.live { color: #22c55e; border-color: rgba(34,197,94,0.4); }
    .vgp-status-pill.error { color: #ef4444; border-color: rgba(239,68,68,0.4); }

    .vgp-actions { display: flex; gap: 6px; }
    .vgp-btn {
      flex: 1;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      padding: 9px 12px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      background: transparent;
      color: var(--g-primary);
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.2s;
    }
    .vgp-btn:hover { background: color-mix(in srgb, var(--g-primary) 10%, transparent); }
    .vgp-btn.primary {
      background: linear-gradient(135deg, var(--g-primary) 0%, #FDB931 100%);
      color: #000; border: none; font-weight: 700;
    }
    .vgp-btn.primary:hover { box-shadow: 0 0 18px color-mix(in srgb, var(--g-primary) 30%, transparent); }
    .vgp-btn.danger { border-color: rgba(239,68,68,0.35); color: #ef4444; }
    .vgp-btn.danger:hover { background: rgba(239,68,68,0.1); }

    .vgp-transcript {
      margin-top: 2px;
      padding: 7px 9px;
      border-radius: 6px;
      background: rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.06);
      font-size: 11px;
      min-height: 30px;
      max-height: 120px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .vgp-transcript-log { display: flex; flex-direction: column; gap: 4px; }
    .vgp-transcript-line {
      color: rgba(255,255,255,0.72);
      line-height: 1.35;
      padding-left: 8px;
      border-left: 2px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
    }
    .vgp-transcript-clear {
      align-self: flex-start;
      margin-top: 2px;
      padding: 2px 8px;
      background: transparent;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 5px;
      color: rgba(255,255,255,0.45);
      font-size: 9px; cursor: pointer;
      font-family: inherit; letter-spacing: 0.05em;
    }
    .vgp-transcript-clear:hover { color: var(--g-primary); border-color: color-mix(in srgb, var(--g-primary) 40%, transparent); }
    .vgp-interim { color: var(--g-primary); }
    .vgp-hint { color: rgba(255,255,255,0.3); font-style: italic; }

    /* ── Session status line + no-session empty state (mirrors /voice) ── */
    .vgp-session-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      letter-spacing: 0.3px;
      color: rgba(255,255,255,0.55);
    }
    .vgp-status-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: #555; flex-shrink: 0;
      transition: background 0.2s, box-shadow 0.2s;
    }
    .vgp-status-dot.connecting { background: #f59e0b; box-shadow: 0 0 6px rgba(245,158,11,0.5); }
    .vgp-status-dot.live { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.6); }
    .vgp-status-dot.error { background: #ef4444; box-shadow: 0 0 6px rgba(239,68,68,0.6); }
    .vgp-session-status__label { color: rgba(255,255,255,0.7); }
    .vgp-session-status__target {
      margin-left: auto;
      max-width: 45%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--g-primary);
    }
    .vgp-empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 18px 12px;
      text-align: center;
      color: rgba(255,255,255,0.4);
    }
    .vgp-empty-state svg { stroke: currentColor; opacity: 0.6; }
    .vgp-empty-state__title { font-size: 12px; color: rgba(255,255,255,0.6); }
    .vgp-empty-state__sub { font-size: 10px; color: rgba(255,255,255,0.35); }

    /* ── Coordinator handoff overlay ── */
    .vgp-handoff {
      position: absolute;
      inset: 0;
      z-index: 20;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 20px;
      text-align: center;
      background: rgba(6,6,10,0.86);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      font-family: var(--mono, 'JetBrains Mono', monospace);
    }
    .vgp-handoff__title { font-size: 12px; font-weight: 700; color: var(--g-primary); letter-spacing: 0.5px; }
    .vgp-handoff__sub { font-size: 10px; color: rgba(255,255,255,0.45); max-width: 220px; line-height: 1.5; }

    /* Resize handles */
    .resize-handle { position: absolute; z-index: 10; }
    .resize-handle--n { top: -4px; left: 8px; right: 8px; height: 8px; cursor: n-resize; }
    .resize-handle--s { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: s-resize; }
    .resize-handle--e { right: -4px; top: 8px; bottom: 8px; width: 8px; cursor: e-resize; }
    .resize-handle--w { left: -4px; top: 8px; bottom: 8px; width: 8px; cursor: w-resize; }
    .resize-handle--ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
    .resize-handle--nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
    .resize-handle--se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
    .resize-handle--sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }
  `;

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Object }) client: any = null;
  @property({ type: Object }) appState: any = null;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;

  /** Robovoice call phase, mirrored from the app-wide call store event. */
  @state() private phase = "idle";
  private readonly onCall = (e: Event) => {
    this.phase = (e as CustomEvent<{ phase?: string }>).detail?.phase ?? "idle";
  };

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("infinibot:robovoice-call", this.onCall);
  }

  disconnectedCallback() {
    window.removeEventListener("infinibot:robovoice-call", this.onCall);
    super.disconnectedCallback();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("isActive")) this.classList.toggle("active", this.isActive);
    if (changed.has("isDragging")) this.classList.toggle("dragging", this.isDragging);
    if (changed.has("isResizing")) this.classList.toggle("resizing", this.isResizing);
  }

  private handleFocus = () => {
    this.dispatchEvent(new CustomEvent("panel-focus", { bubbles: true, composed: true }));
  };
  private handleHeaderMouseDown = (e: MouseEvent | TouchEvent) => {
    if ((e.target as HTMLElement).closest(".panel-ctrl-btn")) return;
    if ("touches" in e) e.preventDefault();
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e, bubbles: true, composed: true }));
  };
  private handleResizeStart = (edge: string, e: MouseEvent | TouchEvent) => {
    if ("touches" in e) e.preventDefault();
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e }, bubbles: true, composed: true }));
  };

  render() {
    const live = this.phase === "starting" || this.phase === "connecting" || this.phase === "active" || this.phase === "ending";
    const status = live ? "live" : "idle";
    return html`
      <div class="panel" @click=${this.handleFocus}>
        ${(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map(
          (edge) => html`<div class="resize-handle resize-handle--${edge}" @mousedown=${(e: MouseEvent) => this.handleResizeStart(edge, e)}></div>`,
        )}
        <div class="panel-header" @mousedown=${this.handleHeaderMouseDown} @touchstart=${this.handleHeaderMouseDown}>
          <div class="panel-header__icon">
            <svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="23"/><line x1="8" x2="16" y1="23" y2="23"/></svg>
          </div>
          <div class="panel-header__info">
            <div class="panel-title">${this.panel.title || "Voice"}</div>
            <div class="panel-header__status">
              <span class="panel-header__dot ${status}"></span>
              ${live ? "On call" : "Voice"}
            </div>
          </div>
          <div class="panel-controls">
            <button class="panel-ctrl-btn" title="Minimize" @click=${() => this.dispatchEvent(new CustomEvent("panel-minimize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="panel-ctrl-btn" title="Maximize" @click=${() => this.dispatchEvent(new CustomEvent("panel-maximize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="panel-ctrl-btn close" title="Close" @click=${() => this.dispatchEvent(new CustomEvent("panel-close", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="panel-body">
          <div class="vgp-controls" data-testid="vgp-robovoice">
            <span class="vgp-status-pill ${status}"><span class="pip"></span>${live ? "Call live" : "Ready to talk"}</span>
            <span class="vgp-hint">Local voice is the default. Pick a voice, or switch to Cloud voice (Robovoice), on the Voice page.</span>
            <div class="vgp-actions">
              ${live
                ? html`<button class="vgp-btn primary" @click=${() => this.appState?.setTab?.("voice")}>Open call</button>`
                : html`<button class="vgp-btn primary" @click=${() => startRobovoiceVoiceCall({ source: "grid-voice-panel" })}>Start voice call</button>`}
              <button class="vgp-btn" @click=${() => this.appState?.setTab?.("voice")}>Voice page</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

// ============================================================
// GPU Animation Grid Panel
// ============================================================

@customElement("gpu-grid-panel")
export class GpuGridPanel extends LitElement {
  static styles = css`
    :host {
      display: block;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 
        0 25px 80px rgba(0,0,0,0.7),
        0 0 1px color-mix(in srgb, var(--g-primary) 50%, transparent);
      transition: box-shadow 0.2s, transform 0.1s, border-color 0.2s;
    }

    :host(.active) {
      box-shadow: 
        0 30px 100px rgba(0,0,0,0.8),
        0 0 0 2px color-mix(in srgb, var(--g-primary) 60%, transparent),
        0 0 40px color-mix(in srgb, var(--g-primary) 20%, transparent);
    }

    :host(.dragging) {
      cursor: grabbing;
      transform: scale(1.01);
      box-shadow: 0 30px 100px rgba(0,0,0,0.8), 0 0 60px color-mix(in srgb, var(--g-primary) 30%, transparent);
    }

    * { box-sizing: border-box; }

    svg {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .panel {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: linear-gradient(145deg, rgba(6,6,10,0.98) 0%, rgba(12,12,18,0.98) 100%);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 10%, transparent) 0%, transparent 100%);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      cursor: grab;
      user-select: none;
      font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
      flex-shrink: 0;
    }

    .panel-header:active { cursor: grabbing; }

    .panel-header__icon {
      width: 26px;
      height: 26px;
      border-radius: 6px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 25%, transparent) 0%, color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--g-primary);
      flex-shrink: 0;
      font-size: 13px;
    }

    .panel-header__icon svg {
      width: 14px;
      height: 14px;
      fill: var(--g-primary);
      stroke: none;
    }

    .panel-header__info {
      flex: 1;
      min-width: 0;
    }

    .panel-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--g-primary);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-header__status {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 9px;
      color: rgba(255,255,255,0.35);
    }

    .panel-header__dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--g-primary);
      box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary) 50%, transparent);
      animation: gpuPulse 1.5s ease-in-out infinite;
    }

    @keyframes gpuPulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary) 50%, transparent); }
      50% { opacity: 0.6; box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 80%, transparent); }
    }

    .panel-controls {
      display: flex;
      gap: 4px;
    }

    .panel-ctrl-btn {
      width: 24px;
      height: 24px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: transparent;
      color: rgba(255, 255, 255, 0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }

    .panel-ctrl-btn:hover {
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      color: var(--g-primary);
    }

    .panel-ctrl-btn.close:hover {
      background: rgba(239,68,68,0.2);
      border-color: rgba(239,68,68,0.4);
      color: #ef4444;
    }

    .panel-ctrl-btn svg {
      width: 11px;
      height: 11px;
    }

    .panel-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    gpu-animation-panel {
      flex: 1;
    }

    /* Resize handles */
    .resize-handle {
      position: absolute;
      z-index: 10;
    }
    .resize-handle--n { top: -4px; left: 8px; right: 8px; height: 8px; cursor: n-resize; }
    .resize-handle--s { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: s-resize; }
    .resize-handle--e { right: -4px; top: 8px; bottom: 8px; width: 8px; cursor: e-resize; }
    .resize-handle--w { left: -4px; top: 8px; bottom: 8px; width: 8px; cursor: w-resize; }
    .resize-handle--ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
    .resize-handle--nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
    .resize-handle--se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
    .resize-handle--sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }
  `;

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Object }) client: any = null;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;

  updated(changed: Map<string, unknown>) {
    if (changed.has("isActive") || changed.has("isDragging") || changed.has("isResizing")) {
      this.classList.toggle("active", this.isActive);
      this.classList.toggle("dragging", this.isDragging);
      this.classList.toggle("resizing", this.isResizing);
    }
  }

  private handleFocus = () => {
    this.dispatchEvent(new CustomEvent("panel-focus", { bubbles: true, composed: true }));
  };

  private handleHeaderMouseDown = (e: MouseEvent | TouchEvent) => {
    if ((e.target as HTMLElement).closest('.panel-ctrl-btn')) return;
    if ("touches" in e) e.preventDefault();
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e, bubbles: true, composed: true }));
  };

  private handleResizeStart = (edge: string, e: MouseEvent | TouchEvent) => {
    if ("touches" in e) e.preventDefault();
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e }, bubbles: true, composed: true }));
  };

  render() {
    return html`
      <div class="panel" @click=${this.handleFocus}>
        <!-- Resize handles -->
        <div class="resize-handle resize-handle--n" @mousedown=${(e: MouseEvent) => this.handleResizeStart('n', e)}></div>
        <div class="resize-handle resize-handle--s" @mousedown=${(e: MouseEvent) => this.handleResizeStart('s', e)}></div>
        <div class="resize-handle resize-handle--e" @mousedown=${(e: MouseEvent) => this.handleResizeStart('e', e)}></div>
        <div class="resize-handle resize-handle--w" @mousedown=${(e: MouseEvent) => this.handleResizeStart('w', e)}></div>
        <div class="resize-handle resize-handle--ne" @mousedown=${(e: MouseEvent) => this.handleResizeStart('ne', e)}></div>
        <div class="resize-handle resize-handle--nw" @mousedown=${(e: MouseEvent) => this.handleResizeStart('nw', e)}></div>
        <div class="resize-handle resize-handle--se" @mousedown=${(e: MouseEvent) => this.handleResizeStart('se', e)}></div>
        <div class="resize-handle resize-handle--sw" @mousedown=${(e: MouseEvent) => this.handleResizeStart('sw', e)}></div>

        <div class="panel-header" @mousedown=${this.handleHeaderMouseDown} @touchstart=${this.handleHeaderMouseDown}>
          <div class="panel-header__icon">
            <svg viewBox="0 0 24 24">
              <path d="M12 2L13.09 8.26L18 6L15.74 10.91L22 12L15.74 13.09L18 18L13.09 15.74L12 22L10.91 15.74L6 18L8.26 13.09L2 12L8.26 10.91L6 6L10.91 8.26L12 2Z"/>
            </svg>
          </div>
          <div class="panel-header__info">
            <div class="panel-title">Agent Neural Mesh</div>
            <div class="panel-header__status">
              <span class="panel-header__dot"></span>
              LIVE
            </div>
          </div>
          <div class="panel-controls">
            <button class="panel-ctrl-btn" title="Minimize" @click=${() => this.dispatchEvent(new CustomEvent("panel-minimize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="panel-ctrl-btn" title="Maximize" @click=${() => this.dispatchEvent(new CustomEvent("panel-maximize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="panel-ctrl-btn close" title="Close" @click=${() => this.dispatchEvent(new CustomEvent("panel-close", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <div class="panel-body">
          <gpu-animation-panel .client=${this.client}></gpu-animation-panel>
        </div>
      </div>
    `;
  }
}

// ============================================================
// Terminal tab title helpers
// ============================================================

/** Hash a string to a 0-359 hue so each nodeId gets a stable colour. */
function nodeIdToHue(nodeId: string): number {
  let hash = 0;
  for (let i = 0; i < nodeId.length; i++) {
    hash = (Math.imul(31, hash) + nodeId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

const TERMINAL_CLI_LABELS: Record<string, string> = {
  claude: "Claude",
  opencode: "OpenCode",
  gemini: "Gemini",
  codex: "Codex",
  ollama: "Ollama",
  shell: "Shell",
};

/**
 * Return a plain-string title for a terminal panel, used when storing the
 * title into panel.title (e.g. for the minimized-dock span text).
 * - Local node  →  "▶ Claude"
 * - Remote node →  "Oscar · Claude"
 */
function formatTerminalTabTitle(
  cli: string,
  nodeId: string,
  nodes: Array<{ id: string; name: string; isLocal?: boolean }>,
): string {
  const backendLabel = TERMINAL_CLI_LABELS[cli] ?? cli;
  const effectiveNodeId = nodeId || "local";
  if (effectiveNodeId === "local") return `▶ ${backendLabel}`;
  const node = nodes.find((n) => n.id === effectiveNodeId);
  if (!node || node.isLocal) return `▶ ${backendLabel}`;
  return `${node.name} · ${backendLabel}`;
}

/**
 * Render a rich terminal tab title as a Lit TemplateResult.
 * - Local node: just the backend label chip.
 * - Remote node: coloured dot + bold node name + small backend chip.
 * - Offline node: whole thing is dimmed + "·offline" appended.
 */
function renderTerminalTabTitle(
  cli: string,
  nodeId: string,
  nodes: Array<{ id: string; name: string; isLocal?: boolean; online?: boolean }>,
) {
  const backendLabel = TERMINAL_CLI_LABELS[cli] ?? cli;
  const effectiveNodeId = nodeId || "local";

  // Local node → simple label only
  if (effectiveNodeId === "local") {
    return html`<span class="tt-backend-chip">${backendLabel}</span>`;
  }

  const node = nodes.find((n) => n.id === effectiveNodeId);
  if (!node || node.isLocal) {
    return html`<span class="tt-backend-chip">${backendLabel}</span>`;
  }

  const hue = nodeIdToHue(effectiveNodeId);
  const dotColor = `hsl(${hue},70%,60%)`;
  const isOffline = node.online === false;

  return html`
    <span class="tt-node-title ${isOffline ? 'tt-offline' : ''}">
      <span class="tt-node-dot" style="background:${dotColor};box-shadow:0 0 4px ${dotColor}88;"></span>
      <span class="tt-node-name">${node.name}</span>
      <span class="tt-backend-chip">${backendLabel}</span>
      ${isOffline ? html`<span class="tt-offline-badge">offline</span>` : nothing}
    </span>
  `;
}

// ============================================================
// Shared styles for kanban/database/terminal embed panels
// ============================================================
const embedPanelStyles = css`
  :host {
    display: block;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 22px 70px rgba(0,0,0,0.6), 0 0 1px color-mix(in srgb, var(--g-primary) 40%, transparent);
    transition: box-shadow 0.2s, transform 0.1s;
  }
  :host(.active) {
    box-shadow: 0 28px 90px rgba(0,0,0,0.75), 0 0 0 2px color-mix(in srgb, var(--g-primary) 60%, transparent), 0 0 30px color-mix(in srgb, var(--g-primary) 12%, transparent);
  }
  :host(.dragging) { cursor: grabbing; transform: scale(1.01); }
  * { box-sizing: border-box; }
  svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  .ep-panel {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: linear-gradient(145deg, rgba(6,6,10,0.98) 0%, rgba(12,12,18,0.98) 100%);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    /* Flush tiling — match the dashboard masonry shell + the terminal grid
       canvas. No outer border or rounded corners: adjacent panels share a
       single inset hairline. */
    border: none;
    border-radius: 0;
    overflow: hidden;
    box-shadow: inset -1px -1px 0 rgba(255, 255, 255, 0.08);
  }
  .ep-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 9%, transparent) 0%, transparent 100%);
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    cursor: grab;
    user-select: none;
    font-family: var(--mono, 'JetBrains Mono', 'SF Mono', monospace);
    flex-shrink: 0;
  }
  .ep-header:active { cursor: grabbing; }
  .ep-icon {
    width: 24px; height: 24px; border-radius: 6px;
    background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    display: flex; align-items: center; justify-content: center;
    color: var(--g-primary); font-size: 12px; flex-shrink: 0;
  }
  .ep-title {
    font-size: 11px; font-weight: 700; color: var(--g-primary);
    letter-spacing: 0.05em; text-transform: uppercase;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  .ep-spacer { flex: 1; min-width: 0; }
  .ep-select {
    background: rgba(0,0,0,0.45);
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
    color: #fff;
    padding: 4px 22px 4px 8px;
    border-radius: 5px;
    font-size: 10.5px;
    font-family: inherit;
    cursor: pointer;
    max-width: 180px;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23fbbf24' stroke-width='2'><polyline points='6 9 12 15 18 9'/></svg>");
    background-repeat: no-repeat;
    background-position: right 6px center;
  }
  .ep-select:hover { border-color: var(--g-primary); }
  .ep-select option { background: #0a0a0a; color: #fff; }
  .ep-input {
    background: rgba(0,0,0,0.45);
    border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
    color: #fff;
    padding: 4px 8px;
    border-radius: 5px;
    font-size: 10.5px;
    font-family: inherit;
    min-width: 0;
    flex: 1;
  }
  .ep-input:focus { outline: none; border-color: var(--g-primary); }
  .ep-controls { display: flex; gap: 4px; flex-shrink: 0; }
  .ep-ctrl-btn {
    width: 22px; height: 22px;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 5px; background: transparent;
    color: rgba(255,255,255,0.55);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; font-size: 11px;
    padding: 0;
  }
  .ep-ctrl-btn:hover { background: color-mix(in srgb, var(--g-primary) 12%, transparent); border-color: color-mix(in srgb, var(--g-primary) 30%, transparent); color: var(--g-primary); }
  .ep-ctrl-btn.close:hover { background: rgba(239,68,68,0.18); border-color: rgba(239,68,68,0.4); color: #ef4444; }
  .ep-ctrl-btn svg { width: 11px; height: 11px; }
  .ep-body {
    flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
    position: relative;
    background: #0a0a0a;
  }
  .ep-body--scroll { overflow: auto; }
  .ep-empty {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; color: rgba(255,255,255,0.55); padding: 24px; text-align: center;
  }
  .ep-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .ep-empty-btn {
    padding: 6px 14px;
    border: 1px solid color-mix(in srgb, var(--g-primary) 35%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    color: var(--g-primary);
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
  }
  .ep-empty-btn:hover { background: color-mix(in srgb, var(--g-primary) 25%, transparent); }

  /* Resize handles */
  .resize-handle { position: absolute; z-index: 10; }
  .resize-handle--n { top: -4px; left: 8px; right: 8px; height: 8px; cursor: n-resize; }
  .resize-handle--s { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: s-resize; }
  .resize-handle--e { right: -4px; top: 8px; bottom: 8px; width: 8px; cursor: e-resize; }
  .resize-handle--w { left: -4px; top: 8px; bottom: 8px; width: 8px; cursor: w-resize; }
  .resize-handle--ne { top: -4px; right: -4px; width: 16px; height: 16px; cursor: ne-resize; }
  .resize-handle--nw { top: -4px; left: -4px; width: 16px; height: 16px; cursor: nw-resize; }
  .resize-handle--se { bottom: -4px; right: -4px; width: 16px; height: 16px; cursor: se-resize; }
  .resize-handle--sw { bottom: -4px; left: -4px; width: 16px; height: 16px; cursor: sw-resize; }
  @media (max-width: 768px) {
    .resize-handle {
      touch-action: none;
      opacity: 0;
      transition: opacity 0.15s ease 300ms;
    }
    .ep-panel:hover .resize-handle,
    :host(.resizing) .resize-handle {
      opacity: 1;
    }
    .resize-handle--n { top: -4px; left: 16px; right: 16px; height: 16px; }
    .resize-handle--s { bottom: -4px; left: 16px; right: 16px; height: 16px; }
    .resize-handle--e { right: -4px; top: 16px; bottom: 16px; width: 16px; }
    .resize-handle--w { left: -4px; top: 16px; bottom: 16px; width: 16px; }
    .resize-handle--ne,
    .resize-handle--nw,
    .resize-handle--se,
    .resize-handle--sw {
      width: 24px;
      height: 24px;
    }
  }
`;

function embedResizeHandles(self: { dispatchResize: (edge: string, e: MouseEvent | TouchEvent) => void }) {
  return html`
    <div class="resize-handle resize-handle--n" @mousedown=${(e: MouseEvent) => self.dispatchResize('n', e)} @touchstart=${(e: TouchEvent) => self.dispatchResize('n', e)}></div>
    <div class="resize-handle resize-handle--s" @mousedown=${(e: MouseEvent) => self.dispatchResize('s', e)} @touchstart=${(e: TouchEvent) => self.dispatchResize('s', e)}></div>
    <div class="resize-handle resize-handle--e" @mousedown=${(e: MouseEvent) => self.dispatchResize('e', e)} @touchstart=${(e: TouchEvent) => self.dispatchResize('e', e)}></div>
    <div class="resize-handle resize-handle--w" @mousedown=${(e: MouseEvent) => self.dispatchResize('w', e)} @touchstart=${(e: TouchEvent) => self.dispatchResize('w', e)}></div>
    <div class="resize-handle resize-handle--ne" @mousedown=${(e: MouseEvent) => self.dispatchResize('ne', e)} @touchstart=${(e: TouchEvent) => self.dispatchResize('ne', e)}></div>
    <div class="resize-handle resize-handle--nw" @mousedown=${(e: MouseEvent) => self.dispatchResize('nw', e)} @touchstart=${(e: TouchEvent) => self.dispatchResize('nw', e)}></div>
    <div class="resize-handle resize-handle--se" @mousedown=${(e: MouseEvent) => self.dispatchResize('se', e)} @touchstart=${(e: TouchEvent) => self.dispatchResize('se', e)}></div>
    <div class="resize-handle resize-handle--sw" @mousedown=${(e: MouseEvent) => self.dispatchResize('sw', e)} @touchstart=${(e: TouchEvent) => self.dispatchResize('sw', e)}></div>
  `;
}

// ============================================================
// kanban-grid-panel — embeds /projects kanban view, scoped per-panel
// ============================================================
@customElement("kanban-grid-panel")
export class KanbanGridPanel extends LitElement {
  static styles = embedPanelStyles;

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Object }) client: any = null;
  @property({ type: Object }) appState: any = null;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;

  private kanbanLoaded = false;

  updated(changed: Map<string, unknown>) {
    if (changed.has("isActive") || changed.has("isDragging") || changed.has("isResizing")) {
      this.classList.toggle("active", this.isActive);
      this.classList.toggle("dragging", this.isDragging);
      this.classList.toggle("resizing", this.isResizing);
    }
    if (!this.kanbanLoaded && this.appState && this.client) {
      this.kanbanLoaded = true;
      void loadKanbanData(this.appState).then(() => this.appState.requestUpdate?.());
    }
  }

  private dispatchFocus = () => {
    this.dispatchEvent(new CustomEvent("panel-focus", { bubbles: true, composed: true }));
  };
  private dispatchHeader = (e: MouseEvent | TouchEvent) => {
    // Drag handle must yield to any interactive control in the header — opt out
    // is by element type (covers every <button>/<input>/<select>/<a> regardless
    // of class) plus an explicit `data-no-drag` escape hatch and the CLI popover.
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a, summary, details, [role="button"], [data-no-drag], .tg-cli-popover, .fns-root, .fns-pop, .fns-summary')) return;
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e, bubbles: true, composed: true }));
  };
  dispatchResize = (edge: string, e: MouseEvent | TouchEvent) => {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e }, bubbles: true, composed: true }));
  };
  private updateMeta = (patch: Partial<GridPanel>) => {
    this.dispatchEvent(new CustomEvent("panel-meta-update", { detail: patch, bubbles: true, composed: true }));
  };

  private onProjectChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    const projectId = value === "__gallery__" ? null : value;
    const projects = this.appState?.kanbanProjects || [];
    const proj = projects.find((p: any) => p.id === projectId);
    const title = proj ? `🗂️ ${proj.name}` : "🗂️ Kanban";
    this.updateMeta({ kanbanProjectId: projectId, title });
  };

  render() {
    const projects: any[] = this.appState?.kanbanProjects ?? [];
    const tasks: any[] = this.appState?.kanbanTasks ?? [];
    const selectedProjectId = this.panel.kanbanProjectId ?? null;
    const galleryView = !selectedProjectId;

    const props: KanbanViewProps = {
      loading: !!this.appState?.kanbanLoading,
      projects,
      tasks,
      error: this.appState?.kanbanError ?? null,
      selectedProjectId,
      galleryView,
      galleryFilter: "all",
      gallerySearch: "",
      gallerySort: "recent",
      selectedTaskId: null,
      onCreateTask: (task) => {
        if (this.appState) void kanbanCreateTask(this.appState, task).then(() => this.appState.requestUpdate?.());
      },
      onCreateProject: (project) => {
        if (this.appState) void kanbanCreateProject(this.appState, project).then(() => this.appState.requestUpdate?.());
      },
      onUpdateTask: (id, patch) => {
        if (this.appState) void kanbanUpdateTask(this.appState, id, patch).then(() => this.appState.requestUpdate?.());
      },
      onDeleteTask: (id) => {
        if (this.appState) void kanbanDeleteTask(this.appState, id).then(() => this.appState.requestUpdate?.());
      },
      onDeleteProject: (id) => {
        if (this.appState) void kanbanDeleteProject(this.appState, id).then(() => this.appState.requestUpdate?.());
      },
      onRefresh: () => {
        if (this.appState) void loadKanbanData(this.appState).then(() => this.appState.requestUpdate?.());
      },
      onSelectProject: (id) => {
        const proj = projects.find((p) => p.id === id);
        this.updateMeta({ kanbanProjectId: id, title: proj ? `🗂️ ${proj.name}` : "🗂️ Kanban" });
      },
      onUpdateProject: (id, patch) => {
        if (this.appState) void kanbanUpdateProject(this.appState, id, patch).then(() => this.appState.requestUpdate?.());
      },
      onSelectTask: () => {
        this.appState?.requestUpdate?.();
      },
      onEnterProject: (id) => {
        const proj = projects.find((p) => p.id === id);
        this.updateMeta({ kanbanProjectId: id, title: proj ? `🗂️ ${proj.name}` : "🗂️ Kanban" });
      },
      onBackToGallery: () => {
        this.updateMeta({ kanbanProjectId: null, title: "🗂️ Kanban" });
      },
      onGalleryFilterChange: () => this.appState?.requestUpdate?.(),
      onGallerySearchChange: () => this.appState?.requestUpdate?.(),
      onGallerySortChange: () => this.appState?.requestUpdate?.(),
      onRequestUpdate: () => { this.requestUpdate(); this.appState?.requestUpdate?.(); },
      client: this.client,
    };

    return html`
      <div class="ep-panel" @click=${this.dispatchFocus}>
        ${embedResizeHandles(this)}
        <div class="ep-header" @mousedown=${this.dispatchHeader}>
          <div class="ep-icon">🗂️</div>
          <div class="ep-title">${this.panel.title || "Kanban"}</div>
          <div class="ep-spacer"></div>
          <select class="ep-select" .value=${selectedProjectId ?? "__gallery__"} @change=${this.onProjectChange} title="Switch project / page">
            <option value="__gallery__">— All Projects (Gallery) —</option>
            ${projects.map((p: any) => html`
              <option value=${p.id} ?selected=${p.id === selectedProjectId}>${p.name || "Untitled"}</option>
            `)}
          </select>
          <div class="ep-controls">
            <button class="ep-ctrl-btn" title="Minimize" @click=${() => this.dispatchEvent(new CustomEvent("panel-minimize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="ep-ctrl-btn" title="Maximize" @click=${() => this.dispatchEvent(new CustomEvent("panel-maximize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="ep-ctrl-btn close" title="Close" @click=${() => this.dispatchEvent(new CustomEvent("panel-close", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="ep-body ep-body--scroll">
          ${this.appState && this.client
            ? renderKanban(props)
            : html`<div class="ep-empty"><div>Loading kanban…</div></div>`}
        </div>
      </div>
    `;
  }
}

// ============================================================
// database-grid-panel — embeds /databases view, scoped per-panel
// ============================================================
@customElement("database-grid-panel")
export class DatabaseGridPanel extends LitElement {
  static styles = embedPanelStyles;

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Object }) client: any = null;
  @property({ type: Object }) appState: any = null;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;

  private dbLoaded = false;

  updated(changed: Map<string, unknown>) {
    if (changed.has("isActive") || changed.has("isDragging") || changed.has("isResizing")) {
      this.classList.toggle("active", this.isActive);
      this.classList.toggle("dragging", this.isDragging);
      this.classList.toggle("resizing", this.isResizing);
    }
    if (!this.dbLoaded && this.appState && this.client) {
      this.dbLoaded = true;
      const s = getDatabasesState(this.appState);
      if (!s.databases.length && !s.loading) {
        void loadDatabases(this.appState, this.client).then(() => this.appState.requestUpdate?.());
      }
    }
  }

  private dispatchFocus = () => {
    this.dispatchEvent(new CustomEvent("panel-focus", { bubbles: true, composed: true }));
  };
  private dispatchHeader = (e: MouseEvent | TouchEvent) => {
    // Drag handle must yield to any interactive control in the header — opt out
    // is by element type (covers every <button>/<input>/<select>/<a> regardless
    // of class) plus an explicit `data-no-drag` escape hatch and the CLI popover.
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a, summary, details, [role="button"], [data-no-drag], .tg-cli-popover, .fns-root, .fns-pop, .fns-summary')) return;
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e, bubbles: true, composed: true }));
  };
  dispatchResize = (edge: string, e: MouseEvent | TouchEvent) => {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e }, bubbles: true, composed: true }));
  };
  private updateMeta = (patch: Partial<GridPanel>) => {
    this.dispatchEvent(new CustomEvent("panel-meta-update", { detail: patch, bubbles: true, composed: true }));
  };

  private onDatabaseChange = (e: Event) => {
    const id = (e.target as HTMLSelectElement).value || null;
    const dbs: any[] = this.appState ? getDatabasesState(this.appState).databases : [];
    const db = dbs.find((d) => d.id === id);
    this.updateMeta({ databaseId: id, title: db ? `📚 ${db.name || db.title || "Untitled"}` : "📚 Database" });
    if (id && this.appState && this.client) {
      void loadDatabase(this.appState, this.client, id).then(() => this.appState.requestUpdate?.());
    }
  };

  render() {
    const s = this.appState ? getDatabasesState(this.appState) : null;
    const databases: any[] = s?.databases ?? [];
    // Apply this panel's per-panel selection right before rendering the
    // databases view. Because all panels share the same DatabasesState
    // singleton, each panel sets the selection it cares about during its
    // render pass — interactions inside the view propagate through the
    // global state, then the next render re-asserts the panel's choice.
    if (s && this.panel.databaseId !== undefined) {
      s.selectedDatabaseId = this.panel.databaseId ?? null;
    }

    return html`
      <div class="ep-panel" @click=${this.dispatchFocus}>
        ${embedResizeHandles(this)}
        <div class="ep-header" @mousedown=${this.dispatchHeader}>
          <div class="ep-icon">📚</div>
          <div class="ep-title">${this.panel.title || "Database"}</div>
          <div class="ep-spacer"></div>
          <select class="ep-select" .value=${this.panel.databaseId ?? ""} @change=${this.onDatabaseChange} title="Switch database / page">
            <option value="">— Pick a database —</option>
            ${databases.map((d: any) => html`
              <option value=${d.id} ?selected=${d.id === this.panel.databaseId}>${d.name || d.title || "Untitled"}</option>
            `)}
          </select>
          <div class="ep-controls">
            <button class="ep-ctrl-btn" title="Minimize" @click=${() => this.dispatchEvent(new CustomEvent("panel-minimize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="ep-ctrl-btn" title="Maximize" @click=${() => this.dispatchEvent(new CustomEvent("panel-maximize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="ep-ctrl-btn close" title="Close" @click=${() => this.dispatchEvent(new CustomEvent("panel-close", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="ep-body ep-body--scroll">
          ${this.appState && this.client
            ? renderDatabases(this.appState, this.client)
            : html`<div class="ep-empty"><div>Loading databases…</div></div>`}
        </div>
      </div>
    `;
  }
}

// ============================================================
// terminal-grid-panel — embeds a full /terminals card, with CLI + cwd controls
// ============================================================
@customElement("terminal-grid-panel")
export class TerminalGridPanel extends LitElement {
  // Combine the panel chrome styles, the full /terminals page CSS, and xterm.css
  // so the embedded `term-card` (and its xterm canvas) render with the same
  // styling as the /terminals page.
  static styles = [embedPanelStyles, unsafeCSS(xtermCssText), css`
    :host { container-type: inline-size; }

    /* Make the embedded /terminals card fill the panel body without the
       grid container that the standalone page provides. */
    .ep-body { background: #030303; padding: 0; }
    .ep-body .term-card {
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      margin: 0;
      border-radius: 0;
      resize: none !important;       /* panel has its own resize handles */
      animation: none;
    }
    .ep-body .term-card::after { display: none; }   /* hide native resize chevron */
    .ep-body .term-card.expanded {
      /* Don't let term-card's own "expand" pop out of the panel. */
      position: relative !important;
      inset: auto !important;
      z-index: auto !important;
    }
    .ep-body .term-output {
      flex: 1;
      min-height: 0;
    }
    /* The panel's own ep-header already owns the title, drag handle, CLI/
       federation/cwd controls and minimize/maximize/close — the inner
       term-card-header is a redundant second row that overlaps with the
       drag area and confuses the user. Hide it inside grid panels. */
    .ep-body .term-card-header { display: none !important; }
    .ep-body .term-card-footer { display: none !important; }

    /* Let the federation node popover (and other header dropdowns) escape
       the panel's clipping context. Without this, the dropdown is cut off
       by .ep-panel's overflow:hidden and only ~30 px is visible — which
       reads as "dropdown is blocked by the drag bar". The body keeps its
       own overflow:hidden so the xterm scrollback stays clipped. */
    .ep-panel { overflow: visible !important; }
    .ep-header { overflow: visible; position: relative; z-index: 30; }
    .tg-header-tools { position: relative; z-index: 30; }
    .ep-header details.fns-root .fns-pop { z-index: 9999; }

    /* Session swap dropdown in the panel header. */
    .tg-session-swap {
      background: rgba(0,0,0,0.5);
      border: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 25%, transparent);
      color: #fff;
      padding: 3px 22px 3px 8px;
      border-radius: 5px;
      font-size: 10.5px;
      font-family: inherit;
      cursor: pointer;
      max-width: 180px;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23fbbf24' stroke-width='2'><polyline points='6 9 12 15 18 9'/></svg>");
      background-repeat: no-repeat;
      background-position: right 6px center;
      flex-shrink: 0;
    }
    .tg-session-swap:hover { border-color: var(--g-primary, #f5a623); }
    .tg-session-swap option { background: #0a0a0a; color: #fff; }

    .tg-title-wrap {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      overflow: hidden;
    }
    .tg-header-tools {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1 1 auto;
      justify-content: flex-end;
    }
    .tg-cli-shell {
      position: relative;
      flex-shrink: 0;
    }
    .tg-cli-strip {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 32px;
    }
    .tg-cli-button {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.82);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      padding: 0;
      cursor: pointer;
      font-family: inherit;
      transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease, opacity 140ms ease;
    }
    .tg-cli-button:hover:not(:disabled) {
      background: rgba(255,255,255,0.09);
    }
    .tg-cli-button:focus-visible,
    .tg-peer-default-btn:focus-visible,
    .tg-reattach-btn:focus-visible,
    .tg-confirm-btn:focus-visible,
    .tg-provider-link:focus-visible {
      outline: 1px solid var(--g-primary, #f5a623);
      outline-offset: 2px;
    }
    .tg-cli-button:disabled {
      cursor: not-allowed;
      opacity: 0.48;
    }
    .tg-cli-button.selected {
      border-width: 1.5px;
      background: rgba(255,255,255,0.08);
    }
    .tg-cli-icon {
      font-size: 13px;
      line-height: 1;
    }
    .tg-cli-status {
      position: absolute;
      right: 3px;
      bottom: 3px;
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: rgba(148,163,184,0.85);
      box-shadow: 0 0 0 1px rgba(0,0,0,0.85);
    }
    .tg-cli-status.installed { background: #22c55e; }
    .tg-cli-status.builtin {
      width: 10px;
      height: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #f59e0b;
      color: #120800;
      font-size: 7px;
      font-weight: 800;
      line-height: 1;
    }
    .tg-cli-collapsed {
      display: none;
      min-width: 94px;
      width: 100%;
      gap: 5px;
      padding: 0 7px;
    }
    .tg-cli-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.03em;
    }
    .tg-cli-popover {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 50;
      display: grid;
      grid-template-columns: repeat(4, 28px);
      gap: 5px;
      padding: 6px;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 7px;
      background: rgba(8,8,8,0.96);
      box-shadow: 0 12px 30px rgba(0,0,0,0.4);
    }
    /* The federation-node-select renders <details><summary> (not a native
       <select>), so size the summary to match the panel header's other
       28 px controls (.ep-input / .tg-session-swap / .tg-cli-button). */
    .tg-fed-select {
      flex-shrink: 0;
      min-width: 118px;
    }
    .tg-fed-select .fns-summary {
      min-width: 118px;
      max-width: 168px;
      height: 28px;
      padding: 0 8px;
      font-size: 10.5px;
      border-radius: 6px;
    }
    .tg-fed-select[data-disabled="true"] .fns-summary {
      cursor: not-allowed;
      opacity: 0.52;
    }
    .tg-cwd-wrap {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 92px;
      max-width: 190px;
      flex: 0 1 190px;
    }
    .tg-cwd-wrap .ep-input {
      min-width: 0;
      width: 100%;
      height: 28px;
    }
    .tg-peer-default-btn,
    .tg-reattach-btn,
    .tg-confirm-btn,
    .tg-provider-link {
      height: 28px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.82);
      font: inherit;
      font-size: 10px;
      font-weight: 700;
      padding: 0 8px;
      white-space: nowrap;
      cursor: pointer;
    }
    .tg-peer-default-btn:hover,
    .tg-reattach-btn:hover,
    .tg-confirm-btn:hover,
    .tg-provider-link:hover {
      background: rgba(255,255,255,0.1);
    }
    .tg-peer-default-btn:disabled {
      cursor: not-allowed;
      opacity: 0.48;
    }
    .tg-confirm {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      color: rgba(255,255,255,0.64);
      font-size: 10px;
      white-space: nowrap;
    }
    .tg-confirm-text {
      max-width: 210px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tg-confirm-btn.primary {
      border-color: rgba(245,158,11,0.55);
      color: #fbbf24;
    }
    .tg-hint-row {
      margin-top: 8px;
      color: rgba(255,255,255,0.48);
      font-size: 11px;
      line-height: 1.35;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tg-inline-hint {
      color: #fbbf24;
    }
    .tg-device-hint {
      color: rgba(255,255,255,0.58);
    }
    .tg-empty-controls {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }

    /* ---- terminal tab title rich rendering ---- */
    .tt-node-title {
      display: flex; align-items: center; gap: 5px;
      min-width: 0; overflow: hidden;
    }
    .tt-offline { opacity: 0.45; }
    .tt-node-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .tt-node-name {
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.04em; text-transform: uppercase;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: #fff;
    }
    .tt-backend-chip {
      display: inline-flex; align-items: center;
      padding: 1px 5px;
      background: color-mix(in srgb, var(--g-primary) 18%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-radius: 4px;
      font-size: 9px; font-weight: 600; letter-spacing: 0.06em;
      color: var(--g-primary);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .tt-offline-badge {
      font-size: 9px; font-weight: 500;
      color: rgba(255,255,255,0.4);
      white-space: nowrap; flex-shrink: 0;
    }

    @container (max-width: 280px) {
      .ep-header {
        flex-wrap: wrap;
        min-height: 74px;
        align-content: flex-start;
      }
      .tg-title-wrap {
        flex: 1 1 calc(100% - 88px);
      }
      .tg-header-tools {
        order: 3;
        flex: 1 1 100%;
        justify-content: flex-start;
        gap: 5px;
        flex-wrap: wrap;
      }
      .tg-cli-strip {
        display: none;
      }
      .tg-cli-collapsed {
        display: inline-flex;
      }
      .tg-cli-shell {
        width: 104px;
      }
      .tg-fed-select {
        min-width: 110px;
      }
      .tg-fed-select .fns-summary {
        min-width: 110px;
        max-width: 124px;
      }
      .tg-cwd-wrap {
        display: none;
      }
      .tg-reattach-btn {
        width: 104px;
        padding: 0 6px;
      }
      .tg-confirm {
        flex-basis: 100%;
      }
      .tg-confirm-text {
        max-width: 148px;
      }
    }
  `];

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Object }) client: any = null;
  @property({ type: Object }) appState: any = null;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;

  private termsLoaded = false;
  private autoSpawnAttempted = false;
  @state() private cwdInput = "";
  @state() private cliHint: string | null = null;
  @state() private cliPickerOpen = false;
  @state() private reattachConfirm = false;

  updated(changed: Map<string, unknown>) {
    if (changed.has("isActive") || changed.has("isDragging") || changed.has("isResizing")) {
      this.classList.toggle("active", this.isActive);
      this.classList.toggle("dragging", this.isDragging);
      this.classList.toggle("resizing", this.isResizing);
    }
    if (changed.has("panel") && this.panel?.terminalCwd && !this.cwdInput) {
      this.cwdInput = this.panel.terminalCwd;
    }
    if (!this.termsLoaded && this.appState && this.client) {
      this.termsLoaded = true;
      // Ensure terminals state exists & CLIs are detected
      if (!this.appState.terminalsState) {
        this.appState.terminalsState = createInitialTerminalsState();
      }
      void loadTerminalsPage(this.appState).then(() => {
        this.appState.requestUpdate?.();
        // Auto-spawn on first mount when the user added the panel with an
        // explicit CLI choice (the dropdown always sets one). Going through
        // the empty-state -> term-card transition often leaves xterm sized
        // 0x0 in the first frame, so the directive misses its initial fit
        // and the panel sits black until the user manually re-attaches.
        if (
          !this.autoSpawnAttempted &&
          !this.panel.terminalSessionId &&
          this.panel.terminalCli
        ) {
          this.autoSpawnAttempted = true;
          void this.onSpawn();
        }
      });
    }
  }

  private dispatchFocus = () => {
    this.dispatchEvent(new CustomEvent("panel-focus", { bubbles: true, composed: true }));
  };
  private dispatchHeader = (e: MouseEvent | TouchEvent) => {
    // Drag handle must yield to any interactive control in the header — opt out
    // is by element type (covers every <button>/<input>/<select>/<a> regardless
    // of class) plus an explicit `data-no-drag` escape hatch and the CLI popover.
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a, summary, details, [role="button"], [data-no-drag], .tg-cli-popover, .fns-root, .fns-pop, .fns-summary')) return;
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e, bubbles: true, composed: true }));
  };
  dispatchResize = (edge: string, e: MouseEvent | TouchEvent) => {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e }, bubbles: true, composed: true }));
  };
  private updateMeta = (patch: Partial<GridPanel>) => {
    this.dispatchEvent(new CustomEvent("panel-meta-update", { detail: patch, bubbles: true, composed: true }));
  };

  private getTerminalNodeId(): string {
    return this.panel.terminalNodeId ?? this.panel.nodeId ?? "local";
  }

  private getFederationNodes(ts?: any): FedNodeOption[] {
    const nodes = (ts?.federationNodes as FedNodeOption[] | undefined)?.length
      ? ts.federationNodes as FedNodeOption[]
      : [];
    if (nodes.length > 0) return nodes;
    // First-render: kick off the federation node load so the dropdown
    // populates a moment later. Without this the user sees "This Device"
    // forever on satellite UIs that haven't initialized terminals state
    // yet (terminals controller normally loads nodes, but this panel can
    // be the user's first interaction with that subsystem).
    if (this.appState && this.client && !this._federationLoadKicked) {
      this._federationLoadKicked = true;
      void (async () => {
        try {
          const mod = await import("../controllers/terminals");
          if (typeof mod.loadFederationNodes === "function") {
            await mod.loadFederationNodes(this.appState);
          }
        } catch { /* best-effort */ }
      })();
    }
    return [{ id: "local", name: "This Device", isLocal: true, online: true }];
  }

  private _federationLoadKicked = false;

  private getSelectedNode(nodes: FedNodeOption[]): FedNodeOption {
    const nodeId = this.getTerminalNodeId();
    return nodes.find((n) => n.id === nodeId) ?? {
      id: nodeId,
      name: nodeId === "local" ? "This Device" : nodeId,
      isLocal: nodeId === "local",
      online: true,
    };
  }

  private onCliPick = (cli: CliType) => {
    const selectedNode = this.getSelectedNode(this.getFederationNodes(this.appState?.terminalsState));
    if (cli === "ollama" && !nodeHasOllama(selectedNode)) {
      this.cliHint = "Ollama not installed on this device.";
      this.cliPickerOpen = false;
      this.requestUpdate();
      return;
    }
    this.cliPickerOpen = false;
    this.updateMeta({ terminalCli: cli });
    const ts = this.appState?.terminalsState;
    // `cliVersions` is detected on the *local* gateway only — it asks
    // exec.run whether `claude --version` resolves here. If the user is
    // about to spawn on a remote federation node, we can't gate on that
    // local check (the satellite or master might have the CLI even if
    // this device doesn't). Trust the operator + the remote node, and
    // let the actual spawn surface a real error if it's really missing.
    const isRemote = this.getTerminalNodeId() !== "local";
    const installedLocally = cli === "shell" || !!ts?.cliVersions?.[cli]?.installed;
    if (!installedLocally && !isRemote) {
      this.cliHint = "Not installed — install via /providers";
      return;
    }
    if (!installedLocally && isRemote) {
      // Soft hint only — still let the spawn fire.
      this.cliHint = `${cli} not detected here; assuming the remote node has it.`;
    } else {
      this.cliHint = null;
    }
    // If the panel has no attached session yet, picking a CLI is the user's
    // "spawn this now" signal — fire the spawn immediately instead of making
    // them click the separate "+ Spawn" button.
    if (!this.panel.terminalSessionId) {
      void this.onSpawn();
    }
  };

  private goToProviders = (e: Event) => {
    e.stopPropagation();
    this.appState?.setTab?.("providers");
  };

  private onCwdInput = (e: Event) => {
    this.cwdInput = (e.target as HTMLInputElement).value;
  };

  private onCwdCommit = () => {
    if (this.cwdInput !== this.panel.terminalCwd) {
      this.updateMeta({ terminalCwd: this.cwdInput });
    }
  };

  private usePeerDefault = (e: Event) => {
    e.stopPropagation();
    this.cwdInput = "";
    this.updateMeta({ terminalCwd: "" });
  };

  private onSpawn = async () => {
    if (!this.appState || !this.client) {
      this.dispatchEvent(new CustomEvent("panel-toast", {
        detail: { message: "Gateway not connected — try again in a moment.", kind: "error" },
        bubbles: true,
        composed: true,
      }));
      return;
    }
    if (!this.appState.terminalsState) {
      this.appState.terminalsState = createInitialTerminalsState();
    }
    const ts = this.appState.terminalsState;
    const cli = (this.panel.terminalCli ?? "shell") as CliType;
    const cwd = this.cwdInput || this.panel.terminalCwd || "";
    const before = new Set(ts.sessions.map((s: any) => s.id));
    // Spawn on whichever federation node the panel header has selected.
    // Defaults to "local" so panels created before this feature still spawn here.
    const nodeId = this.getTerminalNodeId();
    ts.error = null;
    await createTerminalSession(this.appState, { cli, cwd, count: 1, oneOfEachCli: false, nodeId });
    const fresh = ts.sessions.find((s: any) => !before.has(s.id));
    if (!fresh) {
      this.appState.requestUpdate?.();
      this.dispatchEvent(new CustomEvent("panel-toast", {
        detail: {
          message: ts.error ?? `Couldn't spawn ${cli} terminal — check provider install and federation node status.`,
          kind: "error",
        },
        bubbles: true,
        composed: true,
      }));
      return;
    }
    const fedNodesForTitle: Array<{ id: string; name: string; isLocal?: boolean }> =
      (ts?.federationNodes as any[]) ??
      (this.appState?.federationState?.nodes as any[] | undefined)?.map((n: any) => ({
        id: n.id, name: n.name, isLocal: n.isLocal,
      })) ??
      [{ id: "local", name: "This Device", isLocal: true }];
    this.updateMeta({
      terminalSessionId: fresh.id,
      terminalCwd: cwd,
      terminalNodeId: nodeId,
      title: formatTerminalTabTitle(cli, nodeId, fedNodesForTitle),
    });
    this.appState.requestUpdate?.();
  };

  private onUnattach = () => {
    this.reattachConfirm = false;
    this.updateMeta({ terminalSessionId: null });
  };

  private onReattachClick = (e: Event) => {
    e.stopPropagation();
    this.reattachConfirm = true;
  };

  private onCancelReattach = (e: Event) => {
    e.stopPropagation();
    this.reattachConfirm = false;
  };

  private onConfirmReattach = async (e: Event) => {
    e.stopPropagation();
    const sessionId = this.panel.terminalSessionId;
    if (!sessionId || !this.appState) return;
    this.reattachConfirm = false;
    await closeTerminalSession(this.appState, sessionId);
    this.updateMeta({ terminalSessionId: null });
    await this.onSpawn();
  };

  private renderCliButton(
    key: CliType,
    selected: boolean,
    disabled: boolean,
    compact = false,
    selectedNode?: FedNodeOption,
  ) {
    const config = CLI_CONFIGS[key];
    const ollamaUnavailable = key === "ollama" && !nodeHasOllama(selectedNode);
    const installed =
      key === "shell" ||
      (key === "ollama"
        ? !ollamaUnavailable
        : !!this.appState?.terminalsState?.cliVersions?.[key]?.installed);
    const statusClass = key === "shell" ? "builtin" : installed ? "installed" : "";
    const effectiveDisabled = disabled || ollamaUnavailable;
    const title = disabled
      ? "Detach to change"
      : ollamaUnavailable
        ? "Ollama not installed on this device"
        : config.displayName;
    const selectedStyle = selected
      ? `border-color:${config.color};box-shadow:0 0 0 1px ${config.color}25,0 0 10px ${config.color}22;`
      : "";
    return html`
      <button
        class="tg-cli-button ${selected ? "selected" : ""} ${compact ? "tg-cli-collapsed" : ""}"
        style=${selectedStyle}
        title=${title}
        ?disabled=${effectiveDisabled}
        @click=${() => this.onCliPick(key)}
      >
        <span class="tg-cli-icon" style="color:${config.color}">${config.icon}</span>
        ${compact ? html`<span class="tg-cli-label">${config.displayName}</span>` : nothing}
        <span class="tg-cli-status ${statusClass}">${key === "shell" ? "B" : ""}</span>
      </button>
    `;
  }

  private renderCliPicker(cli: CliType, disabled: boolean) {
    const keys = Object.keys(CLI_CONFIGS) as CliType[];
    const selectedNode = this.getSelectedNode(this.getFederationNodes(this.appState?.terminalsState));
    return html`
      <div class="tg-cli-shell">
        <div class="tg-cli-strip">
          ${keys.map((key) => this.renderCliButton(key, key === cli, disabled, false, selectedNode))}
        </div>
        <button
          class="tg-cli-button tg-cli-collapsed ${disabled ? "" : ""}"
          title=${disabled ? "Detach to change" : "CLI provider"}
          ?disabled=${disabled}
          @click=${(e: Event) => {
            e.stopPropagation();
            this.cliPickerOpen = !this.cliPickerOpen;
          }}
        >
          <span class="tg-cli-icon" style="color:${CLI_CONFIGS[cli].color}">${CLI_CONFIGS[cli].icon}</span>
          <span class="tg-cli-label">${CLI_CONFIGS[cli].displayName}</span>
        </button>
        ${this.cliPickerOpen && !disabled ? html`
          <div class="tg-cli-popover">
            ${keys.map((key) => this.renderCliButton(key, key === cli, false, false, selectedNode))}
          </div>
        ` : nothing}
      </div>
    `;
  }

  render() {
    const ts = this.appState?.terminalsState;
    const session = ts?.sessions.find((s: any) => s.id === this.panel.terminalSessionId) || null;
    const sessionsList: any[] = ts?.sessions ?? [];
    const cli = (this.panel.terminalCli ?? "shell") as CliType;
    const locked = !!session;
    const terminalNodeId = this.getTerminalNodeId();
    // Resolve federation nodes for tab title rendering. Prefer terminalsState,
    // fall back to federationState nodes, then a synthetic local entry.
    const fedNodes: FedNodeOption[] = this.getFederationNodes(ts);
    const selectedNode = this.getSelectedNode(fedNodes);
    const isRemote = terminalNodeId !== "local" && !selectedNode.isLocal;
    const deviceHint = isRemote
      ? `Spawning on ${selectedNode.name}`
      : "Spawning here";
    const cwdHint = this.cwdInput || this.panel.terminalCwd || "workspace default";

    return html`
      ${terminalsStyles}
      <div class="ep-panel" @click=${this.dispatchFocus}>
        ${embedResizeHandles(this)}
        <div class="ep-header" @mousedown=${this.dispatchHeader}>
          <div class="ep-icon">&#9658;</div>
          <div class="ep-title tg-title-wrap">
            ${renderTerminalTabTitle(cli, terminalNodeId, fedNodes)}
          </div>
          <div class="tg-header-tools">
            ${sessionsList.length > 0 ? html`
              <select
                class="tg-session-swap"
                title="Swap to a different terminal session in this panel"
                .value=${this.panel.terminalSessionId ?? ""}
                @mousedown=${(e: Event) => e.stopPropagation()}
                @change=${(e: Event) => {
                  const next = (e.target as HTMLSelectElement).value;
                  this.updateMeta({ terminalSessionId: next || null });
                }}
              >
                <option value="">— None / Spawn new —</option>
                ${sessionsList.map((s: any) => html`
                  <option value=${s.id} ?selected=${s.id === this.panel.terminalSessionId}>
                    ${s.title || s.id.slice(-6)} · ${s.cli ?? "shell"}
                  </option>
                `)}
              </select>
            ` : nothing}
            ${this.renderCliPicker(cli, false)}
            <span title=${locked ? "Federation device (applies on next spawn / reattach)" : "Federation device"}>
              ${renderFederationNodeSelect({
                value: terminalNodeId,
                nodes: fedNodes,
                onChange: (id) => this.updateMeta({ terminalNodeId: id || "local" }),
                compact: true,
                label: "",
                className: "tg-fed-select",
                disabled: false,
              })}
            </span>
            <div class="tg-cwd-wrap">
              <input class="ep-input" type="text" placeholder="cwd"
                title=${locked ? "Working directory (applies on next spawn / reattach)" : deviceHint}
                .value=${this.cwdInput}
                @input=${this.onCwdInput}
                @blur=${this.onCwdCommit}
                @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { this.onCwdCommit(); this.onSpawn(); } }}
              />
              ${isRemote ? html`
                <button
                  class="tg-peer-default-btn"
                  aria-label="Use peer default directory"
                  title="Use peer default directory"
                  @click=${this.usePeerDefault}
                >Default</button>
              ` : nothing}
            </div>
            ${session ? html`
              ${this.reattachConfirm ? html`
                <div class="tg-confirm">
                  <span class="tg-confirm-text">Detach current session and spawn with new CLI/device?</span>
                  <button class="tg-confirm-btn primary" aria-label="Confirm reattach" @click=${this.onConfirmReattach}>Confirm</button>
                  <button class="tg-confirm-btn" aria-label="Cancel reattach" @click=${this.onCancelReattach}>Cancel</button>
                </div>
              ` : html`
                <button class="tg-reattach-btn" aria-label="Reattach terminal session" title="Detach current session and spawn again" @click=${this.onReattachClick}>↻ Reattach</button>
              `}
              <button class="ep-ctrl-btn" title="Detach (keep session running)" @click=${this.onUnattach}>↩</button>
            ` : nothing}
          </div>
          <div class="ep-controls">
            <button class="ep-ctrl-btn" title="Minimize" @click=${() => this.dispatchEvent(new CustomEvent("panel-minimize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="ep-ctrl-btn" title="Maximize" @click=${() => this.dispatchEvent(new CustomEvent("panel-maximize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="ep-ctrl-btn close" title="Close" @click=${() => this.dispatchEvent(new CustomEvent("panel-close", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="ep-body">
          ${session && ts && this.appState
            ? renderTerminalCard(this.appState, ts, session)
            : html`
              <div class="ep-empty">
                <div>No terminal attached</div>
                <div class="tg-empty-controls">
                  <span class="tg-device-hint">${deviceHint} · ${cwdHint}</span>
                  ${this.cliHint ? html`
                    <span class="tg-inline-hint">${this.cliHint}</span>
                    <button class="tg-provider-link" @click=${this.goToProviders}>Providers</button>
                  ` : nothing}
                </div>
                <div class="ep-empty-actions">
                  <button class="ep-empty-btn" @click=${this.onSpawn}>+ Spawn ${cli}</button>
                  ${sessionsList.length > 0 ? html`
                    <select class="ep-select" @change=${(e: Event) => this.updateMeta({ terminalSessionId: (e.target as HTMLSelectElement).value })}>
                      <option value="">— Attach existing —</option>
                      ${sessionsList.map((s: any) => html`
                        <option value=${s.id}>${s.title}</option>
                      `)}
                    </select>
                  ` : nothing}
                </div>
              </div>
            `}
        </div>
      </div>
    `;
  }
}

// ============================================================
// activity-grid-panel — embeds the live agent activity feed
// ============================================================
@customElement("activity-grid-panel")
export class ActivityGridPanel extends LitElement {
  static styles = embedPanelStyles;

  @property({ type: Object }) panel!: GridPanel;
  @property({ type: Object }) client: any = null;
  @property({ type: Object }) appState: any = null;
  @property({ type: Boolean }) isActive = false;
  @property({ type: Boolean }) isDragging = false;
  @property({ type: Boolean }) isResizing = false;

  private activityLoaded = false;

  updated(changed: Map<string, unknown>) {
    if (changed.has("isActive") || changed.has("isDragging") || changed.has("isResizing")) {
      this.classList.toggle("active", this.isActive);
      this.classList.toggle("dragging", this.isDragging);
      this.classList.toggle("resizing", this.isResizing);
    }
    if (!this.activityLoaded && this.appState && this.client) {
      this.activityLoaded = true;
      void ensureActivityPanelData(this.appState).then(() => this.appState.requestUpdate?.());
    }
  }

  private dispatchFocus = () => {
    this.dispatchEvent(new CustomEvent("panel-focus", { bubbles: true, composed: true }));
  };
  private dispatchHeader = (e: MouseEvent | TouchEvent) => {
    if ((e.target as HTMLElement).closest(".ep-ctrl-btn")) return;
    this.dispatchEvent(new CustomEvent("drag-start", { detail: e, bubbles: true, composed: true }));
  };
  dispatchResize = (edge: string, e: MouseEvent | TouchEvent) => {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent("resize-start", { detail: { edge, event: e }, bubbles: true, composed: true }));
  };

  private onRefresh = async () => {
    if (!this.appState || !this.client) return;
    const { loadAgentActivity } = await import("../controllers/agent-activity");
    await loadAgentActivity(this.appState, this.client);
    this.appState.requestUpdate?.();
    this.requestUpdate();
  };

  render() {
    const as = this.appState?.agentActivityState;
    const activeSessions = (as?.sessions ?? []).filter((s: any) => s.active);

    return html`
      <div class="ep-panel" @click=${this.dispatchFocus}>
        ${embedResizeHandles(this)}
        <div class="ep-header" @mousedown=${this.dispatchHeader}>
          <div class="ep-icon">⚡</div>
          <div class="ep-title">${this.panel.title || "Agent Feed"}</div>
          ${activeSessions.length > 0 ? html`
            <span style="
              font-size:8px; padding:1px 5px; margin-left:4px; letter-spacing:0.08em; font-weight:700;
              border:1px solid #22c55e; color:#22c55e; border-radius:2px; flex-shrink:0;
            ">${activeSessions.length} LIVE</span>
          ` : nothing}
          <div class="ep-spacer"></div>
          <button class="ep-ctrl-btn" title="Refresh" @click=${this.onRefresh}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
          </button>
          <div class="ep-controls">
            <button class="ep-ctrl-btn" title="Minimize" @click=${() => this.dispatchEvent(new CustomEvent("panel-minimize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button class="ep-ctrl-btn" title="Maximize" @click=${() => this.dispatchEvent(new CustomEvent("panel-maximize", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>
            <button class="ep-ctrl-btn close" title="Close" @click=${() => this.dispatchEvent(new CustomEvent("panel-close", { bubbles: true, composed: true }))}>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div class="ep-body">
          ${this.appState
            ? renderActivityFeedBody(this.appState, this.client)
            : html`<div class="ep-empty"><div>Loading activity…</div></div>`}
        </div>
      </div>
    `;
  }
}
