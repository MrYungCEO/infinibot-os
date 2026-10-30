/**
 * Masonry Grid Controller
 * Manages draggable, resizable multi-session chat panels
 */

import type { GatewayBrowserClient } from "../gateway";
import {
  type GridEnv,
  snapRectPosition,
  getActiveSnapGuides as getActiveSnapGuidesGeneric,
  findLinkedPanels as findLinkedPanelsGeneric,
  applyLinkedResize as applyLinkedResizeGeneric,
  getDockZone as getDockZoneGeneric,
  applyDockZone as applyDockZoneGeneric,
  tileHorizontal as tileHorizontalGeneric,
  tileVertical as tileVerticalGeneric,
  tileGrid as tileGridGeneric,
} from "../lib/grid-geometry";
import { createLayoutPresetStore } from "../lib/layout-presets";

// ============================================================
// Types
// ============================================================

export type PanelType =
  | "session"
  | "group_chat"
  | "workflow_builder"
  | "canvas"
  | "chart"
  | "video"
  | "gpu"
  | "kanban"
  | "database"
  | "terminal"
  | "activity"
  | "voice"
  | "projects"
  | "tasks"
  | "knowledgeGraph"
  | "credits"
  // Generic "mount an existing full view inside a tile" adapter. The concrete
  // view is chosen by `GridPanel.viewKind` (see grid-panels/view-adapter-panels).
  | "view"
  // Agency Operations Center rendered scoped to a single tab (see
  // `GridPanel.agencyOpsSection`). Composes a custom ops dashboard from tabs.
  | "agencyOps";

/**
 * Voice-panel configuration. A dedicated voice panel claims the global voice
 * channel and can swap the live-action injection prompt. The voice-chat
 * backend reads `gridContext` from sessionStorage on every POST.
 */
export interface VoicePanelConfig {
  /** Wake word for this panel (e.g. "hey infini"). */
  wakeWord?: string;
  /** Selected TTS voice provider key. */
  ttsProvider?: string;
  /** Which system-prompt mode to inject on the voice turn. */
  injectionMode?: "grid" | "default" | "custom";
  /** Custom prompt body used when `injectionMode === "custom"`. */
  customPrompt?: string;
  /**
   * Gateway/terminal session this voice panel is connected to. Mirrors the
   * /voice page's session picker (terminal.list target). Persisted so layout
   * restore keeps the chosen target.
   */
  sessionId?: string;
  sessionTitle?: string;
  sessionNodeId?: string;
}

/**
 * Per-panel agent-control state. The UI control bus (A4) sets `pendingOp`
 * while a verb is in flight so panels can render a spinner / chip, and
 * clears it when the verb resolves.
 */
export interface AgentControlState {
  enabled: boolean;
  lastDispatchAt?: number;
  pendingOp?: string;
}

export interface GridPanel {
  id: string;
  type: PanelType;
  sessionKey: string; // For session panels
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  // For canvas/chart panels
  canvasUrl?: string;
  chartType?: string;
  // For kanban panels — which project this panel is scoped to
  kanbanProjectId?: string | null;
  // For database panels — which database this panel shows
  databaseId?: string | null;
  // For terminal panels — owning terminal session id, CLI choice, cwd, and federation node
  terminalSessionId?: string | null;
  terminalCli?: "claude" | "opencode" | "gemini" | "codex" | "grok" | "ollama" | "shell";
  terminalCwd?: string;
  terminalNodeId?: string;
  /** Federation node where this chat panel should send messages. */
  chatNodeId?: string;
  /**
   * Federation node where the panel's CLI / chat session should be spawned.
   * `"local"` (or undefined) = this device. Persists per-panel so layout
   * restoration doesn't drop the device choice.
   *
   * Deprecated for terminal panels; use terminalNodeId. Kept for older saved
   * layouts and non-terminal node-scoped panels.
   */
  nodeId?: string;
  /**
   * Locked aspect ratio (width / height). When set, resizing maintains this
   * ratio. Set automatically by Shift+drag during resize.
   */
  aspectRatio?: number;
  /** Voice panel: live-action prompt + wake word config. */
  voiceConfig?: VoicePanelConfig;
  /**
   * For `type: "view"` adapter panels — which existing view to embed
   * (e.g. "notes", "clients", "reports", "business", "agentActivity",
   * "funnels", "research", "autonomy"). Resolved by the view-adapter renderer.
   */
  viewKind?: string;
  /**
   * For `type: "agencyOps"` panels — which Agency Operations Center section
   * this tile is scoped to (e.g. "overview", "allocation", "approvals",
   * "activity", "employees"). Maps to `AgencyOperationsSection`.
   */
  agencyOpsSection?: string;
  /** Agent-control telemetry (spinner / chip). */
  agentControl?: AgentControlState;
  /** Flag set by external dispatch; the renderer clears it after refresh. */
  needsRefresh?: boolean;
  /** Conversation feature: backing native database ids and selected group. */
  groupDatabaseId?: string;
  messageDatabaseId?: string;
  workflowDatabaseId?: string;
  groupId?: string;
}

/** Event name fired by `refreshPanel()` and listened to by every panel renderer. */
export const GRID_PANEL_REFRESH_EVENT = "infinibot:grid-panel-refresh";

/** Detail shape for the refresh event. */
export interface GridPanelRefreshDetail {
  panelId: string;
  type: PanelType;
}

export interface CanvasTab {
  id: string;
  name: string;
  icon: string;
  panels: GridPanel[];
  activePanel: string | null;
  maxZIndex: number;
}

export interface MasonryGridState {
  // Multi-canvas support
  canvases: CanvasTab[];
  activeCanvasId: string;
  // Legacy single-canvas fields (for backward compat, derived from active canvas)
  panels: GridPanel[];
  activePanel: string | null;
  gridMode: "free" | "snap" | "masonry";
  snapSize: number;
  maxZIndex: number;
  containerWidth: number;
  containerHeight: number;
}

export interface DragState {
  panelId: string;
  startX: number;
  startY: number;
  startPanelX: number;
  startPanelY: number;
}

export interface ResizeState {
  panelId: string;
  edge: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  startPanelX: number;
  startPanelY: number;
}

// ============================================================
// Constants
// ============================================================

const MIN_PANEL_WIDTH = 200;  // Reduced for more flexibility
const MIN_PANEL_HEIGHT = 150; // Reduced for more flexibility
const DEFAULT_PANEL_WIDTH = 480;
const DEFAULT_PANEL_HEIGHT = 500;
const SNAP_GRID_SIZE = 10;    // Smaller snap grid for precision
const SNAP_THRESHOLD = 15;    // Distance to trigger snap
const STORAGE_KEY = "infinibot-masonry-layout";
const MAX_CANVASES = 5;

// Export constants for view to use
export { MIN_PANEL_WIDTH, MIN_PANEL_HEIGHT, SNAP_GRID_SIZE, SNAP_THRESHOLD };

/** Build the shared geometry environment from masonry grid state. */
function gridEnv(state: MasonryGridState): GridEnv {
  return {
    containerWidth: state.containerWidth,
    containerHeight: state.containerHeight,
    snapSize: state.snapSize,
    snapThreshold: SNAP_THRESHOLD,
    minWidth: MIN_PANEL_WIDTH,
    minHeight: MIN_PANEL_HEIGHT,
    gridMode: state.gridMode,
  };
}

// Default canvas icons/emojis
const CANVAS_ICONS = ["🖥️", "💼", "🔬", "🎯", "⚡"];
const CANVAS_NAMES = ["Main", "Work", "Research", "Focus", "Quick"];

// ============================================================
// State Factory
// ============================================================

function createDefaultCanvas(index: number): CanvasTab {
  return {
    id: `canvas-${index}`,
    name: CANVAS_NAMES[index] || `Canvas ${index + 1}`,
    icon: CANVAS_ICONS[index] || "📋",
    panels: [],
    activePanel: null,
    maxZIndex: 1,
  };
}

// Top breathing room (px) between the grid toolbar and the highest panel.
// Saved layouts historically initialized panel.y at 50+, leaving a visible
// gap below the toolbar. On load we shift every panel up so the topmost
// sits at this offset, preserving relative panel positions.
const GRID_PANEL_TOP_PAD = 4;

function normalizeCanvasTopOffset(canvas: CanvasTab): CanvasTab {
  if (!Array.isArray(canvas.panels) || canvas.panels.length === 0) return canvas;
  const minY = canvas.panels.reduce(
    (m, p) => (typeof p.y === "number" && p.y < m ? p.y : m),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(minY) || minY <= GRID_PANEL_TOP_PAD) return canvas;
  const dy = minY - GRID_PANEL_TOP_PAD;
  return {
    ...canvas,
    panels: canvas.panels.map((p) => ({ ...p, y: p.y - dy })),
  };
}

export function createMasonryGridState(): MasonryGridState {
  const saved = loadLayoutFromStorage();
  if (saved && saved.canvases && saved.canvases.length > 0) {
    // Migrate: ensure panels/activePanel/maxZIndex sync with active canvas
    const normalized = { ...saved, canvases: saved.canvases.map(normalizeCanvasTopOffset) };
    const activeCanvas = normalized.canvases.find(c => c.id === normalized.activeCanvasId) || normalized.canvases[0];
    return {
      ...normalized,
      panels: activeCanvas.panels,
      activePanel: activeCanvas.activePanel,
      maxZIndex: activeCanvas.maxZIndex,
    };
  }

  // Check for legacy format (no canvases array)
  if (saved && Array.isArray(saved.panels) && !saved.canvases) {
    // Migrate legacy state to multi-canvas
    const defaultCanvas: CanvasTab = normalizeCanvasTopOffset({
      id: "canvas-0",
      name: "Main",
      icon: "🖥️",
      panels: saved.panels,
      activePanel: saved.activePanel,
      maxZIndex: saved.maxZIndex || 1,
    });
    return {
      ...saved,
      panels: defaultCanvas.panels,
      canvases: [defaultCanvas],
      activeCanvasId: defaultCanvas.id,
    };
  }
  
  // Fresh state with one default canvas
  const defaultCanvas = createDefaultCanvas(0);
  return {
    canvases: [defaultCanvas],
    activeCanvasId: defaultCanvas.id,
    panels: [],
    activePanel: null,
    gridMode: "free",
    snapSize: SNAP_GRID_SIZE,
    maxZIndex: 1,
    containerWidth: window.innerWidth,
    containerHeight: window.innerHeight - 60,
  };
}

// ============================================================
// Storage
// ============================================================

function loadLayoutFromStorage(): MasonryGridState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Validate structure - accept either old format (panels array) or new (canvases array)
    if (!Array.isArray(parsed.panels) && !Array.isArray(parsed.canvases)) return null;
    return parsed as MasonryGridState;
  } catch {
    return null;
  }
}

export function saveLayoutToStorage(state: MasonryGridState): void {
  try {
    // Always sync panels to active canvas before saving
    const syncedState = syncToActiveCanvas(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(syncedState));
  } catch (e) {
    console.warn("Failed to save masonry layout:", e);
  }
}

export function clearLayoutStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ============================================================
// Canvas Tab Management
// ============================================================

/**
 * Sync panels/activePanel/maxZIndex from active canvas to top-level state
 */
function syncFromActiveCanvas(state: MasonryGridState): MasonryGridState {
  const activeCanvas = state.canvases.find(c => c.id === state.activeCanvasId);
  if (!activeCanvas) return state;
  return {
    ...state,
    panels: activeCanvas.panels,
    activePanel: activeCanvas.activePanel,
    maxZIndex: activeCanvas.maxZIndex,
  };
}

/**
 * Sync top-level panels/activePanel/maxZIndex back to active canvas
 */
function syncToActiveCanvas(state: MasonryGridState): MasonryGridState {
  return {
    ...state,
    canvases: state.canvases.map(c =>
      c.id === state.activeCanvasId
        ? { ...c, panels: state.panels, activePanel: state.activePanel, maxZIndex: state.maxZIndex }
        : c
    ),
  };
}

export function addCanvas(state: MasonryGridState): MasonryGridState {
  if (state.canvases.length >= MAX_CANVASES) return state;
  
  // Save current canvas state first
  const savedState = syncToActiveCanvas(state);
  
  const newIndex = savedState.canvases.length;
  const newCanvas = createDefaultCanvas(newIndex);
  newCanvas.id = `canvas-${Date.now()}`;
  
  const newState: MasonryGridState = {
    ...savedState,
    canvases: [...savedState.canvases, newCanvas],
    activeCanvasId: newCanvas.id,
    panels: [],
    activePanel: null,
    maxZIndex: 1,
  };
  
  saveLayoutToStorage(newState);
  return newState;
}

export function switchCanvas(state: MasonryGridState, canvasId: string): MasonryGridState {
  if (state.activeCanvasId === canvasId) return state;
  
  const targetCanvas = state.canvases.find(c => c.id === canvasId);
  if (!targetCanvas) return state;
  
  // Save current canvas state first
  const savedState = syncToActiveCanvas(state);
  
  const newState: MasonryGridState = {
    ...savedState,
    activeCanvasId: canvasId,
    panels: targetCanvas.panels,
    activePanel: targetCanvas.activePanel,
    maxZIndex: targetCanvas.maxZIndex,
  };
  
  saveLayoutToStorage(newState);
  return newState;
}

export function renameCanvas(state: MasonryGridState, canvasId: string, name: string): MasonryGridState {
  const newState = {
    ...state,
    canvases: state.canvases.map(c =>
      c.id === canvasId ? { ...c, name } : c
    ),
  };
  saveLayoutToStorage(newState);
  return newState;
}

export function setCanvasIcon(state: MasonryGridState, canvasId: string, icon: string): MasonryGridState {
  const newState = {
    ...state,
    canvases: state.canvases.map(c =>
      c.id === canvasId ? { ...c, icon } : c
    ),
  };
  saveLayoutToStorage(newState);
  return newState;
}

export function deleteCanvas(state: MasonryGridState, canvasId: string): MasonryGridState {
  // Can't delete last canvas
  if (state.canvases.length <= 1) return state;
  
  const newCanvases = state.canvases.filter(c => c.id !== canvasId);
  
  // If deleting active canvas, switch to first remaining
  let newActiveId = state.activeCanvasId;
  let newPanels = state.panels;
  let newActivePanel = state.activePanel;
  let newMaxZIndex = state.maxZIndex;
  
  if (state.activeCanvasId === canvasId) {
    const nextCanvas = newCanvases[0];
    newActiveId = nextCanvas.id;
    newPanels = nextCanvas.panels;
    newActivePanel = nextCanvas.activePanel;
    newMaxZIndex = nextCanvas.maxZIndex;
  }
  
  const newState: MasonryGridState = {
    ...state,
    canvases: newCanvases,
    activeCanvasId: newActiveId,
    panels: newPanels,
    activePanel: newActivePanel,
    maxZIndex: newMaxZIndex,
  };
  
  saveLayoutToStorage(newState);
  return newState;
}

export function getActiveCanvas(state: MasonryGridState): CanvasTab | undefined {
  return state.canvases.find(c => c.id === state.activeCanvasId);
}

export function getCanvasCount(state: MasonryGridState): number {
  return state.canvases?.length || 1;
}

export function canAddCanvas(state: MasonryGridState): boolean {
  return (state.canvases?.length || 1) < MAX_CANVASES;
}

// ============================================================
// Panel Management
// ============================================================

export function addPanel(
  state: MasonryGridState,
  sessionKey: string,
  title: string,
  nodeId: string = "local",
): MasonryGridState {
  // Check if panel for this session already exists
  const existing = state.panels.find((p) => p.type === "session" && p.sessionKey === sessionKey);
  if (existing) {
    return focusPanel(state, existing.id);
  }

  // Calculate position for new panel (cascade from top-left)
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `panel-${Date.now()}`,
    type: "session",
    sessionKey,
    title,
    x: 50 + offset,
    y: 8 + offset,
    width: DEFAULT_PANEL_WIDTH,
    height: DEFAULT_PANEL_HEIGHT,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
    nodeId,
    chatNodeId: nodeId,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

// Kept for backward-compat with persisted layouts that still reference
// canvasUrl on canvas panels. The actual canvas is mounted in-app via
// mountMcpCanvas (see ui/src/ui/views/whiteboard.ts) — this URL is
// never fetched. New panels get an empty string.
const EXCALIDRAW_CANVAS_URL = "";

export function addCanvasPanel(
  state: MasonryGridState,
  title: string = "Canvas"
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `canvas-panel-${Date.now()}`,
    type: "canvas",
    sessionKey: "", // Not used for canvas
    title,
    x: 50 + offset,
    y: 8 + offset,
    width: 600,
    height: 500,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
    canvasUrl: EXCALIDRAW_CANVAS_URL,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function addChartPanel(
  state: MasonryGridState,
  title: string = "Chart",
  chartType: string = "line"
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `chart-panel-${Date.now()}`,
    type: "chart",
    sessionKey: "", // Not used for chart
    title,
    x: 50 + offset,
    y: 8 + offset,
    width: 500,
    height: 400,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
    chartType,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function addVideoPanel(
  state: MasonryGridState,
  title: string = "Video Feed"
): MasonryGridState {
  // Only allow one video panel at a time
  const existing = state.panels.find(p => p.type === "video");
  if (existing) {
    return focusPanel(state, existing.id);
  }

  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `video-panel-${Date.now()}`,
    type: "video",
    sessionKey: "", // Not used for video
    title,
    x: 50 + offset,
    y: 8 + offset,
    width: 480,
    height: 400,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function addGpuPanel(
  state: MasonryGridState,
  title: string = "GPU Animations"
): MasonryGridState {
  // Only allow one GPU panel at a time
  const existing = state.panels.find(p => p.type === "gpu");
  if (existing) {
    return focusPanel(state, existing.id);
  }

  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `gpu-panel-${Date.now()}`,
    type: "gpu",
    sessionKey: "", // Not used for GPU panel
    title,
    x: 80 + offset,
    y: 38 + offset,
    width: 420,
    height: 500,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function addKanbanPanel(
  state: MasonryGridState,
  title: string = "🗂️ Kanban",
  kanbanProjectId: string | null = null,
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `kanban-panel-${Date.now()}`,
    type: "kanban",
    sessionKey: "",
    title,
    x: 60 + offset,
    y: 18 + offset,
    width: 720,
    height: 560,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
    kanbanProjectId,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function addDatabasePanel(
  state: MasonryGridState,
  title: string = "📚 Database",
  databaseId: string | null = null,
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `database-panel-${Date.now()}`,
    type: "database",
    sessionKey: "",
    title,
    x: 70 + offset,
    y: 28 + offset,
    width: 720,
    height: 560,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
    databaseId,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function addTerminalPanel(
  state: MasonryGridState,
  title: string = "▶ Terminal",
  cli: "claude" | "opencode" | "gemini" | "codex" | "grok" | "ollama" | "shell" = "shell",
  cwd: string = "",
  nodeId: string = "local",
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `terminal-panel-${Date.now()}`,
    type: "terminal",
    sessionKey: "",
    title,
    x: 90 + offset,
    y: 48 + offset,
    width: 640,
    height: 460,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
    terminalSessionId: null,
    terminalCli: cli,
    terminalCwd: cwd,
    terminalNodeId: nodeId,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function addActivityPanel(
  state: MasonryGridState,
  title: string = "⚡ Agent Feed",
): MasonryGridState {
  const existing = state.panels.find((p) => p.type === "activity");
  if (existing) {
    return focusPanel(state, existing.id);
  }

  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `activity-panel-${Date.now()}`,
    type: "activity",
    sessionKey: "",
    title,
    x: 60 + offset,
    y: 18 + offset,
    width: 420,
    height: 560,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function addGroupChatPanel(
  state: MasonryGridState,
  opts: {
    title?: string;
    groupDatabaseId?: string;
    messageDatabaseId?: string;
    groupId?: string;
  } = {},
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const zIndex = state.maxZIndex + 1;
  const panel: GridPanel = {
    id: `group-chat-panel-${Date.now()}`,
    type: "group_chat",
    sessionKey: "",
    title: opts.title ?? "Group Chat",
    x: 60 + offset,
    y: 24 + offset,
    width: 760,
    height: 560,
    zIndex,
    minimized: false,
    maximized: false,
    groupDatabaseId: opts.groupDatabaseId,
    messageDatabaseId: opts.messageDatabaseId,
    groupId: opts.groupId,
  };
  const next = { ...state, panels: [...state.panels, panel], activePanel: panel.id, maxZIndex: zIndex };
  saveLayoutToStorage(next);
  return next;
}

export function addWorkflowBuilderPanel(
  state: MasonryGridState,
  opts: {
    title?: string;
    workflowDatabaseId?: string;
    groupDatabaseId?: string;
    messageDatabaseId?: string;
    groupId?: string;
  } = {},
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const zIndex = state.maxZIndex + 1;
  const panel: GridPanel = {
    id: `workflow-builder-panel-${Date.now()}`,
    type: "workflow_builder",
    sessionKey: "",
    title: opts.title ?? "Conversation Workflow Builder",
    x: 80 + offset,
    y: 36 + offset,
    width: 920,
    height: 620,
    zIndex,
    minimized: false,
    maximized: false,
    workflowDatabaseId: opts.workflowDatabaseId,
    groupDatabaseId: opts.groupDatabaseId,
    messageDatabaseId: opts.messageDatabaseId,
    groupId: opts.groupId,
  };
  const next = { ...state, panels: [...state.panels, panel], activePanel: panel.id, maxZIndex: zIndex };
  saveLayoutToStorage(next);
  return next;
}

/**
 * Add a dedicated Voice panel — the live-action injection prompt is swapped
 * to "grid" mode while this panel is registered. Default mode = "grid".
 * Only one voice panel at a time (focuses the existing one if present).
 */
export function addVoicePanel(
  state: MasonryGridState,
  opts: { title?: string; voiceConfig?: VoicePanelConfig } = {},
): MasonryGridState {
  const existing = state.panels.find((p) => p.type === "voice");
  if (existing) {
    return focusPanel(state, existing.id);
  }

  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `voice-panel-${Date.now()}`,
    type: "voice",
    sessionKey: "",
    title: opts.title ?? "🎙️ Voice",
    x: 80 + offset,
    y: 38 + offset,
    width: 400,
    height: 520,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
    voiceConfig: {
      injectionMode: "grid",
      ...(opts.voiceConfig ?? {}),
    },
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

/**
 * Add a Projects panel — full-fidelity project browser scoped to a single
 * grid panel. Defaults to the projects view (no specific project selected).
 */
export function addProjectsPanel(
  state: MasonryGridState,
  opts: { title?: string; projectId?: string | null } = {},
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `projects-panel-${Date.now()}`,
    type: "projects",
    sessionKey: "",
    title: opts.title ?? "📁 Projects",
    x: 70 + offset,
    y: 28 + offset,
    width: 720,
    height: 560,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
    kanbanProjectId: opts.projectId ?? null,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

/**
 * Add a Tasks panel — task-board view at parity with the dedicated tasks
 * page (Kanban-style but task-scoped rather than project-scoped).
 */
export function addTasksPanel(
  state: MasonryGridState,
  opts: { title?: string; projectId?: string | null } = {},
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `tasks-panel-${Date.now()}`,
    type: "tasks",
    sessionKey: "",
    title: opts.title ?? "✅ Tasks",
    x: 70 + offset,
    y: 28 + offset,
    width: 680,
    height: 560,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
    kanbanProjectId: opts.projectId ?? null,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

/**
 * Add a Knowledge Graph panel — full-fidelity graph view at parity with the
 * dedicated knowledge graph page.
 */
export function addKnowledgeGraphPanel(
  state: MasonryGridState,
  opts: { title?: string } = {},
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `knowledge-graph-panel-${Date.now()}`,
    type: "knowledgeGraph",
    sessionKey: "",
    title: opts.title ?? "🕸️ Knowledge Graph",
    x: 70 + offset,
    y: 28 + offset,
    width: 720,
    height: 560,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function addCreditsPanel(
  state: MasonryGridState,
  opts: { title?: string } = {},
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `credits-panel-${Date.now()}`,
    type: "credits",
    sessionKey: "",
    title: opts.title ?? "💎 Credit Usage",
    x: 70 + offset,
    y: 28 + offset,
    width: 460,
    height: 420,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

/**
 * Generic "embed an existing full view inside a tile" panel. `viewKind`
 * selects the concrete view (notes / clients / reports / business /
 * agentActivity / funnels / research / autonomy). The renderer lives in
 * grid-panels/view-adapter-panels and simply mounts the existing view — no
 * logic is duplicated. `w`/`h` let each gallery entry pick a sensible size.
 */
export function addViewPanel(
  state: MasonryGridState,
  viewKind: string,
  opts: { title?: string; w?: number; h?: number } = {},
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `view-${viewKind}-${Date.now()}`,
    type: "view",
    sessionKey: "",
    title: opts.title ?? viewKind,
    viewKind,
    x: 70 + offset,
    y: 28 + offset,
    width: opts.w ?? 720,
    height: opts.h ?? 560,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

/**
 * Agency Operations Center scoped to a single tab as a standalone tile. Each
 * panel keeps its own `agencyOpsSection` so an operator can compose a custom
 * ops dashboard (Command center + Work allocation + Approvals + …) from tiles.
 * The renderer gives every panel an independent ops host so tabs never fight
 * over shared state.
 */
export function addAgencyOpsPanel(
  state: MasonryGridState,
  section: string,
  opts: { title?: string; w?: number; h?: number } = {},
): MasonryGridState {
  const offset = (state.panels.length % 5) * 30;
  const newZIndex = state.maxZIndex + 1;

  const newPanel: GridPanel = {
    id: `agencyops-${section}-${Date.now()}`,
    type: "agencyOps",
    sessionKey: "",
    title: opts.title ?? "Agency Ops",
    agencyOpsSection: section,
    x: 70 + offset,
    y: 28 + offset,
    width: opts.w ?? 860,
    height: opts.h ?? 620,
    zIndex: newZIndex,
    minimized: false,
    maximized: false,
  };

  const newState = {
    ...state,
    panels: [...state.panels, newPanel],
    activePanel: newPanel.id,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

/**
 * Refresh a single panel — flips `needsRefresh`, persists, and dispatches
 * `infinibot:grid-panel-refresh` on the window so each panel renderer can
 * re-fetch its data without a full grid re-render. The renderer clears
 * `needsRefresh` once it finishes its fetch.
 */
export function refreshPanel(
  state: MasonryGridState,
  panelId: string,
): MasonryGridState {
  const panel = state.panels.find((p) => p.id === panelId);
  if (!panel) return state;

  const newPanels = state.panels.map((p) =>
    p.id === panelId ? { ...p, needsRefresh: true } : p,
  );
  const newState = { ...state, panels: newPanels };
  saveLayoutToStorage(newState);

  // Fire the cross-panel event after the state object is built so the
  // listener sees the same snapshot the renderer will consume.
  try {
    if (typeof window !== "undefined") {
      const detail: GridPanelRefreshDetail = { panelId, type: panel.type };
      window.dispatchEvent(
        new CustomEvent(GRID_PANEL_REFRESH_EVENT, { detail }),
      );
    }
  } catch (e) {
    console.warn("[masonry] refreshPanel dispatch failed:", e);
  }

  return newState;
}

/**
 * Mark a panel's agent-control as in-flight. Used by the UI control bus
 * (A4) so each panel can render a spinner / pending-op badge while the
 * agent-issued verb runs.
 */
export function setAgentControlPending(
  state: MasonryGridState,
  panelId: string,
  opName: string,
): MasonryGridState {
  const newPanels = state.panels.map((p) =>
    p.id === panelId
      ? {
          ...p,
          agentControl: {
            ...(p.agentControl ?? { enabled: true }),
            enabled: true,
            pendingOp: opName,
            lastDispatchAt: Date.now(),
          },
        }
      : p,
  );
  return { ...state, panels: newPanels };
}

/**
 * Clear a panel's agent-control pending flag once the verb resolves.
 */
export function clearAgentControlPending(
  state: MasonryGridState,
  panelId: string,
): MasonryGridState {
  const newPanels = state.panels.map((p) =>
    p.id === panelId && p.agentControl
      ? {
          ...p,
          agentControl: {
            ...p.agentControl,
            pendingOp: undefined,
          },
        }
      : p,
  );
  return { ...state, panels: newPanels };
}

/**
 * Clear `needsRefresh` on a panel after its renderer finishes re-fetching.
 */
export function clearNeedsRefresh(
  state: MasonryGridState,
  panelId: string,
): MasonryGridState {
  const newPanels = state.panels.map((p) =>
    p.id === panelId && p.needsRefresh ? { ...p, needsRefresh: false } : p,
  );
  return { ...state, panels: newPanels };
}

/**
 * Update arbitrary metadata on a single panel — used by kanban/database/terminal
 * panels to persist their per-panel selection (project id, database id, session id, etc.)
 * across re-renders without resetting position/size.
 */
export function updatePanelMeta(
  state: MasonryGridState,
  panelId: string,
  patch: Partial<GridPanel>,
): MasonryGridState {
  const newPanels = state.panels.map((p) =>
    p.id === panelId ? { ...p, ...patch } : p,
  );
  const newState = { ...state, panels: newPanels };
  saveLayoutToStorage(newState);
  return newState;
}

export function removePanel(
  state: MasonryGridState,
  panelId: string
): MasonryGridState {
  const newPanels = state.panels.filter((p) => p.id !== panelId);
  const newActivePanel =
    state.activePanel === panelId
      ? newPanels.length > 0
        ? newPanels[newPanels.length - 1].id
        : null
      : state.activePanel;

  const newState = {
    ...state,
    panels: newPanels,
    activePanel: newActivePanel,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export function focusPanel(
  state: MasonryGridState,
  panelId: string
): MasonryGridState {
  const panel = state.panels.find((p) => p.id === panelId);
  if (!panel) return state;

  const newZIndex = state.maxZIndex + 1;
  const newPanels = state.panels.map((p) =>
    p.id === panelId ? { ...p, zIndex: newZIndex, minimized: false } : p
  );

  const newState = {
    ...state,
    panels: newPanels,
    activePanel: panelId,
    maxZIndex: newZIndex,
  };

  saveLayoutToStorage(newState);
  return newState;
}

export interface SnapGuide {
  type: "vertical" | "horizontal";
  position: number;
  start: number;
  end: number;
}

export function updatePanelPosition(
  state: MasonryGridState,
  panelId: string,
  x: number,
  y: number,
  enableEdgeSnap: boolean = true
): MasonryGridState {
  const newPanels = snapRectPosition(state.panels, panelId, x, y, gridEnv(state), enableEdgeSnap);
  if (newPanels === state.panels) return state;
  return { ...state, panels: newPanels };
}

// Get active snap guides for visual feedback
export function getActiveSnapGuides(
  state: MasonryGridState,
  panelId: string,
  x: number,
  y: number
): SnapGuide[] {
  return getActiveSnapGuidesGeneric(state.panels, panelId, x, y, gridEnv(state));
}

export function updatePanelSize(
  state: MasonryGridState,
  panelId: string,
  width: number,
  height: number,
  x?: number,
  y?: number,
  patch?: Partial<GridPanel>,
): MasonryGridState {
  const clampedWidth = Math.max(MIN_PANEL_WIDTH, width);
  const clampedHeight = Math.max(MIN_PANEL_HEIGHT, height);

  const newPanels = state.panels.map((p) =>
    p.id === panelId
      ? {
          ...p,
          width: clampedWidth,
          height: clampedHeight,
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
          ...(patch ?? {}),
        }
      : p
  );

  return { ...state, panels: newPanels };
}

// ============================================================
// Linked-edge resize (split-pane behavior)
// ============================================================

/**
 * Snapshot of a panel's rect at the moment a resize starts, used so linked
 * neighbors can follow the dragged edge in lockstep without their starting
 * positions drifting frame-to-frame.
 */
export interface LinkedPanelSnapshot {
  panelId: string;
  /** Which of the neighbor's edges is glued to the resized panel's edge. */
  side: "n" | "s" | "e" | "w";
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

/**
 * Find every panel whose edge sits on the same line as `edge` of `panelId`,
 * with sufficient overlap on the perpendicular axis. These neighbors will
 * be resized in lockstep so the user can split-drag a shared boundary.
 */
export function findLinkedPanels(
  state: MasonryGridState,
  panelId: string,
  edge: ResizeState["edge"],
): LinkedPanelSnapshot[] {
  return findLinkedPanelsGeneric(state.panels, panelId, edge);
}

/**
 * Apply per-frame deltas to linked neighbors so a shared boundary moves as
 * one piece. The delta values are total pixel movement of the dragged edge
 * since resize-start — neighbors are positioned absolutely, never accumulating.
 */
export function applyLinkedResize(
  state: MasonryGridState,
  links: LinkedPanelSnapshot[],
  dxRight: number,    // total move of the dragged east edge (positive = expanded)
  dxLeft: number,     // total move of the dragged west edge
  dyBottom: number,
  dyTop: number,
): MasonryGridState {
  if (links.length === 0) return state;
  const newPanels = applyLinkedResizeGeneric(
    state.panels, links, dxRight, dxLeft, dyBottom, dyTop, gridEnv(state),
  );
  return { ...state, panels: newPanels };
}

// ============================================================
// Edge Dock Snapping
// ============================================================

/**
 * A "dock zone" is the region around a target panel's edge where releasing
 * a dragged panel should snap it adjacent. The five zones (n/s/e/w/center)
 * each occupy ~25% of the target's footprint; the centre is replace/swap.
 */
export interface DockZone {
  targetId: string;
  edge: "n" | "s" | "e" | "w" | "center";
  // Final rect the dragged panel will occupy after docking.
  rect: { x: number; y: number; width: number; height: number };
  // Final rect the *target* panel will be reshaped to (n/s/e/w only).
  targetRect?: { x: number; y: number; width: number; height: number };
}

/**
 * Given the dragged panel's current rect, find which target panel (if any)
 * the cursor is over and which dock zone applies. Returns null when the
 * cursor is over empty canvas (free-position drop).
 */
export function getDockZone(
  state: MasonryGridState,
  draggedId: string,
  cursorX: number,
  cursorY: number,
): DockZone | null {
  return getDockZoneGeneric(state.panels, draggedId, cursorX, cursorY, gridEnv(state));
}

/**
 * Apply a dock zone to the grid: reshape the dragged panel into the dock
 * rect, and reshape the target accordingly. Centre dock swaps rects.
 */
export function applyDockZone(
  state: MasonryGridState,
  draggedId: string,
  zone: DockZone,
): MasonryGridState {
  const newPanels = applyDockZoneGeneric(state.panels, draggedId, zone, gridEnv(state));
  if (newPanels === state.panels) return state;
  const newState = { ...state, panels: newPanels };
  saveLayoutToStorage(newState);
  return newState;
}

export function toggleMinimize(
  state: MasonryGridState,
  panelId: string
): MasonryGridState {
  const newPanels = state.panels.map((p) =>
    p.id === panelId ? { ...p, minimized: !p.minimized, maximized: false } : p
  );

  const newState = { ...state, panels: newPanels };
  saveLayoutToStorage(newState);
  return newState;
}

export function toggleMaximize(
  state: MasonryGridState,
  panelId: string
): MasonryGridState {
  const panel = state.panels.find((p) => p.id === panelId);
  if (!panel) return state;

  const isMaximizing = !panel.maximized;

  const newPanels = state.panels.map((p) =>
    p.id === panelId
      ? {
          ...p,
          maximized: isMaximizing,
          minimized: false,
        }
      : p
  );

  const newState = focusPanel({ ...state, panels: newPanels }, panelId);
  saveLayoutToStorage(newState);
  return newState;
}

export function updatePanelTitle(
  state: MasonryGridState,
  panelId: string,
  title: string
): MasonryGridState {
  const newPanels = state.panels.map((p) =>
    p.id === panelId ? { ...p, title } : p
  );

  return { ...state, panels: newPanels };
}

// ============================================================
// Layout Modes
// ============================================================

export function setGridMode(
  state: MasonryGridState,
  mode: "free" | "snap" | "masonry"
): MasonryGridState {
  const newState = { ...state, gridMode: mode };

  if (mode === "masonry") {
    return applyMasonryLayout(newState);
  }

  saveLayoutToStorage(newState);
  return newState;
}

export function applyMasonryLayout(state: MasonryGridState): MasonryGridState {
  const gap = 12;
  // Target column width adapts to container — wider screens get more columns,
  // narrow ones collapse to fewer. We aim for ~360–480px per column.
  const targetColW = 420;
  const columns = Math.max(
    1,
    Math.min(state.panels.length || 1, Math.round((state.containerWidth - gap) / (targetColW + gap)) || 1),
  );
  const columnWidth = Math.max(MIN_PANEL_WIDTH, (state.containerWidth - gap * (columns + 1)) / columns);

  const columnHeights = new Array(columns).fill(gap);

  type MasonryEntry = {
    panel: GridPanel;
    index: number;
    height: number;
    manualOrder: boolean;
  };

  const entries: MasonryEntry[] = state.panels.map((panel, index) => {
    // Each panel keeps its preferred aspect ratio when its width changes —
    // either an explicitly-locked aspectRatio or the implicit ratio from its
    // last manual size. This lets panels of different shapes pack cleanly
    // (a wide chart, a tall terminal) instead of everyone collapsing to one
    // arbitrary default.
    const ar = panel.aspectRatio && panel.aspectRatio > 0
      ? panel.aspectRatio
      : (panel.width > 0 && panel.height > 0 ? panel.width / panel.height : columnWidth / DEFAULT_PANEL_HEIGHT);
    const height = Math.max(MIN_PANEL_HEIGHT, Math.round(columnWidth / ar));
    const metadata = panel as GridPanel & {
      masonry?: { preserveOrder?: boolean; manuallyPlaced?: boolean };
      layout?: { preserveOrder?: boolean; manuallyPlaced?: boolean };
      preserveMasonryOrder?: boolean;
      manuallyPlaced?: boolean;
    };
    return {
      panel,
      index,
      height,
      manualOrder: Boolean(
        metadata.preserveMasonryOrder ||
        metadata.manuallyPlaced ||
        metadata.masonry?.preserveOrder ||
        metadata.masonry?.manuallyPlaced ||
        metadata.layout?.preserveOrder ||
        metadata.layout?.manuallyPlaced
      ),
    };
  });

  const packedEntries: MasonryEntry[] = [];
  let autoSegment: MasonryEntry[] = [];
  const flushAutoSegment = () => {
    packedEntries.push(
      ...autoSegment.sort((a, b) => b.height - a.height || a.index - b.index),
    );
    autoSegment = [];
  };
  for (const entry of entries) {
    if (entry.manualOrder) {
      flushAutoSegment();
      packedEntries.push(entry);
    } else {
      autoSegment.push(entry);
    }
  }
  flushAutoSegment();

  const packedById = new Map<string, GridPanel>();
  for (const entry of packedEntries) {
    // Find shortest column
    const shortestCol = columnHeights.indexOf(Math.min(...columnHeights));
    const x = gap + shortestCol * (columnWidth + gap);
    const y = columnHeights[shortestCol];

    columnHeights[shortestCol] += entry.height + gap;

    packedById.set(entry.panel.id, {
      ...entry.panel,
      x,
      y,
      width: columnWidth,
      height: entry.height,
      minimized: false,
      maximized: false,
    });
  }

  const newPanels = state.panels.map((panel) => packedById.get(panel.id) ?? panel);

  const newState = { ...state, panels: newPanels };
  saveLayoutToStorage(newState);
  return newState;
}

export function tileHorizontal(state: MasonryGridState): MasonryGridState {
  if (state.panels.length === 0) return state;
  const newState = { ...state, panels: tileHorizontalGeneric(state.panels, gridEnv(state)) };
  saveLayoutToStorage(newState);
  return newState;
}

export function tileVertical(state: MasonryGridState): MasonryGridState {
  if (state.panels.length === 0) return state;
  const newState = { ...state, panels: tileVerticalGeneric(state.panels, gridEnv(state)) };
  saveLayoutToStorage(newState);
  return newState;
}

export function tileGrid(state: MasonryGridState): MasonryGridState {
  if (state.panels.length === 0) return state;
  const newState = { ...state, panels: tileGridGeneric(state.panels, gridEnv(state)) };
  saveLayoutToStorage(newState);
  return newState;
}

// ============================================================
// Container Resize
// ============================================================

export function updateContainerSize(
  state: MasonryGridState,
  width: number,
  height: number
): MasonryGridState {
  const prevW = state.containerWidth || width;
  const prevH = state.containerHeight || height;
  const newState = {
    ...state,
    containerWidth: width,
    containerHeight: height,
  };

  // Re-apply masonry layout if in masonry mode
  if (state.gridMode === "masonry") {
    return applyMasonryLayout(newState);
  }

  // Responsive rescale: if the container size changed meaningfully, scale
  // every panel proportionally so the layout stays usable instead of leaving
  // panels cut off when the user resizes the window.
  if (prevW > 0 && prevH > 0 && (Math.abs(prevW - width) > 4 || Math.abs(prevH - height) > 4)) {
    const sx = width / prevW;
    const sy = height / prevH;
    const newPanels = state.panels.map((p) => {
      const newW = Math.max(MIN_PANEL_WIDTH, Math.round(p.width * sx));
      const newH = Math.max(MIN_PANEL_HEIGHT, Math.round(p.height * sy));
      const newX = Math.max(0, Math.min(width - MIN_PANEL_WIDTH, Math.round(p.x * sx)));
      const newY = Math.max(0, Math.min(height - MIN_PANEL_HEIGHT, Math.round(p.y * sy)));
      return { ...p, x: newX, y: newY, width: newW, height: newH };
    });
    return { ...newState, panels: newPanels };
  }

  return newState;
}

// ============================================================
// Layout Presets
// ============================================================

const LAYOUT_PRESETS_KEY = "infinibot-masonry-presets";

export interface LayoutPreset {
  name: string;
  canvasId: string;
  panels: Array<Pick<GridPanel,
    | "id" | "type" | "sessionKey" | "title"
    | "x" | "y" | "width" | "height" | "zIndex"
    | "kanbanProjectId" | "databaseId" | "terminalCli" | "terminalCwd" | "terminalNodeId"
    | "chatNodeId" | "nodeId"
    | "aspectRatio" | "chartType"
  >>;
  savedAt: number;
}

type MasonryPresetEntry = LayoutPreset["panels"][number];

/**
 * Shared preset store, keyed by canvas. The on-disk shape is the neutral
 * `{ name, scopeId, entries, savedAt }`; the `migrate` hook upgrades any legacy
 * `{ name, canvasId, panels, savedAt }` records saved before the refactor so
 * existing user presets keep loading.
 */
const masonryPresetStore = createLayoutPresetStore<MasonryPresetEntry>({
  storageKey: LAYOUT_PRESETS_KEY,
  migrate: (raw) => {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.name === "string" &&
      typeof r.canvasId === "string" &&
      Array.isArray(r.panels) &&
      typeof r.savedAt === "number"
    ) {
      return {
        name: r.name,
        scopeId: r.canvasId,
        entries: r.panels as MasonryPresetEntry[],
        savedAt: r.savedAt,
      };
    }
    return null;
  },
});

function toLayoutPreset(record: {
  name: string;
  scopeId: string;
  entries: MasonryPresetEntry[];
  savedAt: number;
}): LayoutPreset {
  return {
    name: record.name,
    canvasId: record.scopeId,
    panels: record.entries,
    savedAt: record.savedAt,
  };
}

export function listLayoutPresets(canvasId?: string): LayoutPreset[] {
  return masonryPresetStore.list(canvasId).map(toLayoutPreset);
}

export function saveLayoutPreset(state: MasonryGridState, name: string): LayoutPreset {
  const entries: MasonryPresetEntry[] = state.panels.map((p) => ({
    id: p.id,
    type: p.type,
    sessionKey: p.sessionKey,
    title: p.title,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    zIndex: p.zIndex,
    kanbanProjectId: p.kanbanProjectId,
    databaseId: p.databaseId,
    terminalCli: p.terminalCli,
    terminalCwd: p.terminalCwd,
    terminalNodeId: p.terminalNodeId ?? p.nodeId,
    chatNodeId: p.chatNodeId ?? p.nodeId,
    nodeId: p.nodeId,
    aspectRatio: p.aspectRatio,
    chartType: p.chartType,
  }));
  return toLayoutPreset(masonryPresetStore.save(state.activeCanvasId, name, entries));
}

export function deleteLayoutPreset(name: string, canvasId: string): void {
  masonryPresetStore.remove(name, canvasId);
}

export function loadLayoutPreset(state: MasonryGridState, preset: LayoutPreset): MasonryGridState {
  // Match panels in current state to preset entries by *type+id* first, then
  // by type alone if id has changed. Anything we can't match keeps its old
  // rect so the user doesn't lose work for panels that aren't in the preset.
  const used = new Set<string>();
  const newPanels = state.panels.map((p) => {
    let entry = preset.panels.find((e) => e.id === p.id && !used.has(e.id));
    if (!entry) entry = preset.panels.find((e) => !used.has(e.id) && e.type === p.type);
    if (!entry) return p;
    used.add(entry.id);
    return {
      ...p,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      zIndex: entry.zIndex,
      aspectRatio: entry.aspectRatio,
      minimized: false,
      maximized: false,
    };
  });
  const newState = { ...state, panels: newPanels };
  saveLayoutToStorage(newState);
  return newState;
}

// ============================================================
// Session Loading
// ============================================================

export interface AvailableSession {
  key: string;
  title: string;
  agentId: string;
  lastActivity?: string | number;
  messageCount?: number;
  isActive: boolean;
  totalTokens?: number;
  model?: string;
  channel?: string;
  nodeId?: string;
}

export async function fetchAvailableSessions(
  client: GatewayBrowserClient
): Promise<AvailableSession[]> {
  try {
    // `sessions.list` is the RPC name; `sessions_list` is the MCP *tool*
    // name and was never a gateway method. The client resolves with the
    // payload itself (it rejects on error), so there is no ok/result envelope.
    const res = await client.request<{ sessions?: any[] }>("sessions.list", {
      limit: 50,
      messageLimit: 1,
      activeMinutes: 60 * 24 * 7, // Last week
    });

    const sessions = res?.sessions ?? [];
    return sessions.map((s: any) => ({
      key: s.key,
      title: extractSessionTitle(s),
      agentId: s.agentId || extractAgentId(s.key),
      lastActivity: s.lastActivity,
      messageCount: s.messageCount || 0,
      isActive: Boolean(s.isActive || (s.lastActivity && Date.now() - new Date(s.lastActivity).getTime() < 1000 * 60 * 30)),
    }));
  } catch (e) {
    console.error("Failed to fetch sessions:", e);
    return [];
  }
}

function extractAgentId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts[1] || "main";
}

export async function loadSessionsIntoPanels(
  state: MasonryGridState,
  client: GatewayBrowserClient,
  sessionKeys?: string[]
): Promise<MasonryGridState> {
  try {
    const res = await client.request<{ sessions?: any[] }>("sessions.list", {
      limit: 20,
      messageLimit: 1,
      activeMinutes: 60 * 24, // Last 24 hours
    });

    const sessions = res?.sessions ?? [];
    let newState = state;

    // Sort by last activity (most recent first)
    const sorted = sessions.sort((a: any, b: any) => {
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });

    // Add top sessions
    const maxPanels = sessionKeys ? sessionKeys.length : 4; // Default to 4 panels
    let added = 0;

    for (const session of sorted) {
      if (added >= maxPanels) break;
      if (sessionKeys && !sessionKeys.includes(session.key)) continue;
      if (newState.panels.some(p => p.sessionKey === session.key)) continue;

      const title = extractSessionTitle(session);
      newState = addPanel(newState, session.key, title);
      added++;
    }

    // Auto-tile if we added multiple panels
    if (added > 1) {
      newState = tileGrid(newState);
    }

    return newState;
  } catch (e) {
    console.error("Failed to load sessions into panels:", e);
    return state;
  }
}

export function addSessionToGrid(
  state: MasonryGridState,
  session: AvailableSession
): MasonryGridState {
  // Check if already exists
  if (state.panels.some(p => p.sessionKey === session.key)) {
    return focusPanel(state, state.panels.find(p => p.sessionKey === session.key)!.id);
  }

  // Add and auto-position
  let newState = addPanel(state, session.key, session.title, session.nodeId ?? "local");
  
  // Smart positioning based on panel count
  const count = newState.panels.length;
  if (count <= 4) {
    newState = tileGrid(newState);
  }

  return newState;
}

function extractSessionTitle(session: any): string {
  // Try to get a friendly name
  if (session.label) return session.label;
  if (session.derivedTitle) return session.derivedTitle;
  
  // Agent name mapping
  const agentId = session.agentId || extractAgentId(session.key);
  const agentNames: Record<string, string> = {
    main: "🜂 Infini",
    coder: "💻 Code Architect",
    opus: "🧠 Deep Thinker",
    fast: "⚡ Quick Response",
  };
  
  if (agentNames[agentId]) {
    // Add timestamp or session info for disambiguation
    const timestamp = session.createdAt ? new Date(session.createdAt).toLocaleDateString() : "";
    return `${agentNames[agentId]}${timestamp ? ` (${timestamp})` : ""}`;
  }
  
  // Extract from key
  const parts = session.key.split(":");
  const lastPart = parts[parts.length - 1] || "Chat";
  
  // Clean up webchat keys
  if (lastPart.startsWith("webchat-")) {
    return `💬 Chat ${lastPart.slice(8, 12)}`;
  }
  
  return lastPart;
}
