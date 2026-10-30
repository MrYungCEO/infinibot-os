/**
 * Terminals Controller — V2 with Xterm.js Integration
 * State management for multi-terminal page with real terminal emulation
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { UseXtermReturn } from "../hooks/useXterm";
import { createPtyProcess, destroyPtyProcess, resizePtyProcess, sendPtyInput } from "../hooks/usePtyProcess";
import {
  type GridEnv,
  type GridRect,
  type SnapGuide,
  type DockZone,
  type ResizeEdge,
  type RectBox,
  type LinkedPanelSnapshot,
  snapRectPosition,
  getActiveSnapGuides,
  getDockZone,
  applyDockZone,
  findLinkedPanels,
  applyLinkedResize,
  resizeBox,
  tileColumns,
  tileGrid as tileGridGeneric,
  tileFocus,
} from "../lib/grid-geometry";
import {
  createLayoutPresetStore,
  type LayoutPresetRecord,
} from "../lib/layout-presets";

// ── Types ────────────────────────────────────────────────────

export interface TerminalSession {
  id: string;
  title: string;
  cli: "claude" | "opencode" | "gemini" | "codex" | "grok" | "ollama" | "shell";
  status: "idle" | "running" | "claude-active" | "exited";
  projectId?: string;
  taskId?: string;
  model?: string;
  sessionKey?: string;
  /**
   * Backing PTY (terminal) id. Absent for a normal panel, in which case the
   * PTY id IS the panel `id` (the historical 1:1 model). A *duplicated* panel
   * (see {@link duplicateTerminalSession}) keeps its own unique `id` but sets
   * `ptyId` to the source panel's PTY, so multiple panels — even across
   * different workspaces — can mirror one live terminal session. All PTY-facing
   * RPCs (create/destroy/write/resize/isAlive/getBuffer) key on {@link ptyIdOf},
   * while xterm instances + tiles stay keyed by the panel `id`. Closing a panel
   * only destroys the PTY when it was the LAST panel referencing that `ptyId`
   * (reference counting), otherwise it merely detaches this panel's view.
   */
  ptyId?: string;
  cwd: string;
  createdAt: string;
  expandedView: boolean;
  // Sub-agent spawn terminal flags
  isSubagent?: boolean;
  runId?: string;
  agentId?: string;
  /**
   * Reattach directive from `terminal.listReattachable`. Present for sessions
   * surfaced by the unified reattachable list — chiefly the `spawn-*` cloud/
   * codex agent panes that `terminal.list` (in-memory only) omits after a
   * restart. `handleTerminalReady` replays it to rebind the live tmux pane
   * before streaming. Idempotent (guarded against double-attach).
   */
  reattach?: { method: string; params: Record<string, unknown> };
  /** Federation node that owns the PTY. "local" or undefined = this device. */
  nodeId?: string;
  nodeName?: string;
  /**
   * True when this is an empty grid slot whose backing PTY is gone (it died
   * while the page was closed, or the user removed it but kept the slot).
   * Placeholders keep their tile/geometry and metadata so the user can drop a
   * fresh terminal in via "Reattach" — they never mount an xterm or spawn a
   * PTY on their own. See [[reconcilePlaceholderSessions]].
   */
  isPlaceholder?: boolean;
  // Xterm instance is tracked separately in xtermInstances Map
}

/**
 * Lightweight per-cell descriptor persisted alongside tile geometry so a grid
 * slot can be reconstructed (as a placeholder) even after its PTY has died
 * while the page was closed. Geometry lives in {@link TerminalTile}; this
 * carries just enough to relaunch the same kind of terminal in the same place.
 */
export interface TerminalCellDescriptor {
  id: string;
  /** Backing PTY id. Older mirrored panels used a different UI id. */
  ptyId?: string;
  title: string;
  cli: CliType;
  cwd: string;
  model?: string;
  nodeId?: string;
  nodeName?: string;
}

export type GridLayout = "auto" | "1x1" | "2x1" | "2x2" | "3x2" | "3x3" | "4x3";

/**
 * One terminal tile's placement on the snap-grid canvas. Satisfies the shared
 * `GridRect` contract so the grid-geometry helpers can drag / resize / snap /
 * dock it identically to masonry-grid panels. `id` is the owning session id.
 */
export interface TerminalTile extends GridRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  aspectRatio?: number;
}

/** A saved terminals layout preset entry (one per tile). */
export interface TerminalPresetEntry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  aspectRatio?: number;
}

export type TerminalLayoutPreset = LayoutPresetRecord<TerminalPresetEntry>;

/** Built-in quick layouts shown at the top of the Layouts dropdown. */
export type TerminalQuickPresetId =
  | "one"
  | "twoCol"
  | "threeCol"
  | "grid"
  | "focusLeft"
  | "focusRight";

export interface GitRepoStatus {
  branch: string;
  clean: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  remote: string | null;
  files: Array<{ status: string; path: string }>;
}

export interface GitBranches {
  current: string;
  local: string[];
  remote: string[];
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface SystemDirEntry {
  key: string;
  label: string;
  icon: string;
  path: string;
}

export interface RegisteredDirEntry {
  id: string;
  name: string;
  path: string;
  icon?: string;
  agentId?: string;
  projectId?: string;
  /** Federation node that owns this entry. "local" for this device. */
  sourceNode?: string;
  nodeName?: string;
  syncStatus?: "synced" | "stale";
}

export interface FederationNodeEntry {
  id: string;
  name: string;
  isLocal: boolean;
  online: boolean;
  role: string;
  hostname?: string;
  capabilities?: unknown;
}

export interface OllamaModelEntry {
  name: string;
  model?: string;
  size?: number;
  modified_at?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface TerminalsState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;
  successMessage: string | null;
  maxSessions: number;
  gridLayout: GridLayout;
  showCreateDialog: boolean;
  showSidePanel: boolean;
  dragSourceId: string | null;
  dragOverId: string | null;
  cliVersions: Record<string, { installed: string | boolean | null; path?: string }>;
  projects: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; title: string; projectId: string; status: string }>;
  agentSessions: Array<{ key: string; label?: string; agentId: string; status: string }>;
  // Keyboard navigation
  focusedCardIndex: number;
  // Git state
  gitStatus: GitRepoStatus | null;
  gitBranches: GitBranches | null;
  gitLog: GitCommit[];
  gitCwd: string;
  gitLoading: boolean;
  showGitPanel: boolean;
  // Create dialog form state
  createForm: {
    cli: "claude" | "opencode" | "gemini" | "codex" | "grok" | "ollama" | "shell";
    cwd: string;
    name: string;
    projectId: string;
    taskId: string;
    model: string;
    /** How many terminals to spawn in one click. Clamped to maxSessions. */
    count: number;
    /** When true, spawn one terminal per CLI type (claude/opencode/gemini/shell)
     *  in the same directory; `count` and `cli` are ignored. */
    oneOfEachCli: boolean;
    /** Federation node to spawn on. "local" or "" = this device. */
    nodeId: string;
  };
  ollamaModelsByNode: Record<
    string,
    { loading: boolean; models: OllamaModelEntry[]; reason?: string; loadedAt?: number }
  >;
  // Lower panel resize state
  lowerPanelHeight: number; // pixels
  showLowerPanel: boolean;
  // System directory presets for quick-spawn
  systemDirs: SystemDirEntry[];
  recentDirs: string[]; // user-picked cwds, deduped, persisted in localStorage
  // Saved entries from /directories — used as a dropdown for the git repo
  // path input and as quick-launch targets in the create dialog.
  // Federated: entries from any node in the federation, each tagged with
  // sourceNode so the user can see (and pick) directories owned by any
  // device.
  registeredDirs: RegisteredDirEntry[];
  // Federation nodes (local + connected satellites). Drives the DEVICE
  // selector in the create dialog and the per-card node badge.
  federationNodes: FederationNodeEntry[];
  // Page-level fullscreen toggle (Fullscreen API)
  pageFullscreen: boolean;
  // Topbar registered-directories dropdown open/closed
  showDirsDropdown: boolean;
  // Global device filter (top-nav dropdown). null = show all.
  filterNodeId: string | null;
  // Default node pre-filled in the spawn form when the global filter is active.
  defaultSpawnNodeId: string | null;
  // ── Grid placement layer (draggable / resizable snap-grid tiles) ──
  /** Per-session tile rects on the placement canvas. */
  tiles: TerminalTile[];
  /** Last measured canvas size; geometry math is relative to it. */
  gridContainer: { width: number; height: number };
  /** Canvas size the persisted layout was authored at, so the first live
   *  measurement can scale a customized layout to fit (instead of discarding
   *  it). 0 when there is no persisted customized layout. */
  savedContainer: { width: number; height: number };
  /** Monotonic z so a focused tile rises above the rest. */
  gridMaxZ: number;
  /** True once the user has manually dragged / resized / applied a preset —
   *  suppresses auto-arrange of the whole canvas on each new spawn. */
  layoutCustomized: boolean;
  /** Layouts dropdown open state. */
  showLayoutsMenu: boolean;
  /** Saved presets for the terminals scope (refreshed when the menu opens). */
  layoutPresets: TerminalLayoutPreset[];
  /** Snap guides drawn during an active drag. */
  tileSnapGuides: SnapGuide[];
  /** Active edge-dock preview, if any. */
  tileDock: DockZone | null;
  /** Id of the tile currently being dragged (for styling). */
  draggingTileId: string | null;
  /** Id of the tile currently being resized (for styling). */
  resizingTileId: string | null;
  // ── Numbered workspaces (mirrors the /grid page tab strip) ──
  /** How many numbered workspaces exist (>= 1). Created lazily on overflow. */
  workspaceCount: number;
  /** Currently active workspace (1-based). Only its terminals render. */
  activeWorkspace: number;
  /** sessionId → workspace number. Sessions default to workspace 1. */
  sessionWorkspace: Record<string, number>;
  /** Tiles belonging to *inactive* workspaces. The active workspace's tiles
   *  always live in `ts.tiles` so the layout engine operates on them alone;
   *  switching workspaces swaps the two. Persisted merged with `ts.tiles`. */
  workspaceTilePool: TerminalTile[];
  /** Panel id whose "send to workspace" popover is currently open (or null). */
  sendMenuForId: string | null;
  /** Viewport anchor (button rect) for the open send-to-workspace popover. */
  sendMenuAnchor: { x: number; y: number } | null;
}

// ── CLI Configurations ───────────────────────────────────────

export const CLI_CONFIGS = {
  claude: {
    id: "claude" as const,
    displayName: "Claude Code",
    command: "claude",
    icon: "✦",
    color: "#a78bfa",
    versionFlag: "--version",
  },
  opencode: {
    id: "opencode" as const,
    displayName: "OpenCode",
    command: "opencode",
    icon: "⌘",
    color: "#22c55e",
    versionFlag: "--version",
  },
  gemini: {
    id: "gemini" as const,
    displayName: "Gemini CLI",
    command: "gemini",
    icon: "◆",
    color: "#3b82f6",
    versionFlag: "--version",
  },
  codex: {
    id: "codex" as const,
    displayName: "Codex CLI",
    command: "codex",
    icon: "▶",
    color: "#f59e0b",
    versionFlag: "--version",
  },
  grok: {
    id: "grok" as const,
    displayName: "Grok Build",
    command: "grok",
    icon: "✕",
    color: "#f43f5e",
    versionFlag: "--version",
  },
  ollama: {
    id: "ollama" as const,
    displayName: "Ollama",
    command: "ollama",
    icon: "🦙",
    color: "#6b46c1",
    versionFlag: "--version",
  },
  shell: {
    id: "shell" as const,
    displayName: "Shell",
    command: "cmd",
    icon: ">_",
    color: "var(--g-primary)",
    versionFlag: "",
  },
} as const;

export type CliType = keyof typeof CLI_CONFIGS;

// ── Xterm Instance Tracking ──────────────────────────────────

/**
 * Global map of terminal ID -> xterm manager instance
 * This is stored outside state because xterm instances contain functions
 */
const xtermInstances = new Map<string, UseXtermReturn>();

/**
 * Queue for terminal output that arrives before xterm is registered
 * This prevents losing early shell output due to race conditions
 */
const pendingOutputQueues = new Map<string, string[]>();

export function registerXtermInstance(terminalId: string, xterm: UseXtermReturn): void {
  xtermInstances.set(terminalId, xterm);
  
  // Flush any pending output that arrived before registration
  const pendingOutput = pendingOutputQueues.get(terminalId);
  if (pendingOutput && pendingOutput.length > 0) {
    console.log(`[terminals] Flushing ${pendingOutput.length} pending output chunks for ${terminalId}`);
    for (const data of pendingOutput) {
      xterm.write(data);
    }
    pendingOutputQueues.delete(terminalId);
  }
}

const _disposing = new Set<string>();

export function unregisterXtermInstance(terminalId: string): void {
  if (_disposing.has(terminalId)) return; // prevent re-entrant loop
  const xterm = xtermInstances.get(terminalId);
  if (xterm) {
    _disposing.add(terminalId);
    xtermInstances.delete(terminalId);
    pendingOutputQueues.delete(terminalId); // Clear any pending output too
    try { xterm.dispose(); } catch { /* already disposed */ }
    _disposing.delete(terminalId);
  }
}

export function getXtermInstance(terminalId: string): UseXtermReturn | undefined {
  return xtermInstances.get(terminalId);
}

/**
 * The backing PTY (terminal) id for a session/panel. Normal panels use their
 * own `id`; a duplicated ("mirror") panel points at the source panel's PTY via
 * `ptyId`. All PTY-facing RPCs and the output fan-out key on this.
 */
export function ptyIdOf(s: Pick<TerminalSession, "id" | "ptyId">): string {
  return s.ptyId || s.id;
}

/** Identity used by tmux, which sanitizes punctuation in terminal ids. */
export function canonicalPtyId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * ptyId → set of panel (session) ids currently mirroring that PTY. Kept in sync
 * with `ts.sessions` by {@link reindexPtyPanels} (called every render via
 * `ensureTerminalTiles`, and eagerly by the mutators). Drives output fan-out in
 * {@link writeToXterm} so one PTY's stream reaches every panel showing it.
 */
const ptyPanels = new Map<string, Set<string>>();

/** Rebuild the ptyId → panelIds index from the live (non-placeholder) sessions. */
export function reindexPtyPanels(ts: TerminalsState): void {
  ptyPanels.clear();
  for (const s of ts.sessions) {
    if (s.isPlaceholder) continue;
    const pid = ptyIdOf(s);
    let set = ptyPanels.get(pid);
    if (!set) {
      set = new Set<string>();
      ptyPanels.set(pid, set);
    }
    set.add(s.id);
  }
}

/** Number of live panels currently referencing a given PTY (reference count). */
export function ptyRefCount(ts: TerminalsState, ptyId: string): number {
  return ts.sessions.filter((s) => !s.isPlaceholder && ptyIdOf(s) === ptyId).length;
}

function queuePendingOutput(panelId: string, data: string): void {
  let queue = pendingOutputQueues.get(panelId);
  if (!queue) {
    queue = [];
    pendingOutputQueues.set(panelId, queue);
  }
  queue.push(data);
  // Limit queue size to prevent memory issues (keep last 100KB worth of data)
  let totalSize = queue.reduce((sum, chunk) => sum + chunk.length, 0);
  while (totalSize > 100_000 && queue.length > 1) {
    totalSize -= queue.shift()!.length;
  }
}

/**
 * Route a chunk of PTY output (tagged with the PTY id by the gateway) to every
 * panel mirroring that PTY. For the common 1:1 case this resolves to the single
 * panel whose id equals the PTY id (identical to the historical behaviour); for
 * duplicated panels it fans out to each mirror's xterm so both stay live.
 */
export function writeToXterm(ptyId: string, data: string): void {
  const panelIds = ptyPanels.get(ptyId);
  // Fallback to the PTY id itself when the index hasn't been built yet (e.g.
  // output arriving before the first render) — preserves legacy 1:1 behaviour.
  const targets = panelIds && panelIds.size > 0 ? Array.from(panelIds) : [ptyId];
  for (const panelId of targets) {
    const xterm = xtermInstances.get(panelId);
    if (xterm) {
      xterm.write(data);
    } else {
      // xterm might not be mounted yet — queue per-panel so a late-mounting
      // mirror still catches up.
      queuePendingOutput(panelId, data);
    }
  }
}

// ── State Factory ────────────────────────────────────────────

export function createInitialTerminalsState(): TerminalsState {
  const savedFilterNodeId = loadFilterNodeIdFromStorage();
  // Numbered workspaces + the persisted per-session layout. Tiles are keyed by
  // session id, so we partition the saved layout into the active workspace's
  // working set (`tiles`) and the rest (`workspaceTilePool`) using the map.
  const ws = loadWorkspaceStateFromStorage();
  const layout = loadTerminalLayoutFromStorage();
  const activeTileIds = new Set(
    Object.entries(ws.sessionWorkspace)
      .filter(([, n]) => n === ws.activeWorkspace)
      .map(([id]) => id),
  );
  const activeTiles = layout.tiles.filter((t) => activeTileIds.has(t.id));
  const poolTiles = layout.tiles.filter((t) => !activeTileIds.has(t.id));
  return {
    sessions: [],
    activeSessionId: null,
    loading: false,
    error: null,
    successMessage: null,
    maxSessions: 64,
    gridLayout: "auto",
    showCreateDialog: false,
    showSidePanel: false,
    dragSourceId: null,
    dragOverId: null,
    focusedCardIndex: -1,
    gitStatus: null,
    gitBranches: null,
    gitLog: [],
    gitCwd: "",
    gitLoading: false,
    showGitPanel: false,
    cliVersions: {
      claude: { installed: null },
      opencode: { installed: null },
      gemini: { installed: null },
      codex: { installed: null },
      ollama: { installed: null },
    },
    projects: [],
    tasks: [],
    agentSessions: [],
    lowerPanelHeight: 200,
    showLowerPanel: true,
    createForm: {
      cli: "shell",
      cwd: "",
      name: "",
      projectId: "",
      taskId: "",
      model: "",
      count: 1,
      oneOfEachCli: false,
      nodeId: "local",
    },
    ollamaModelsByNode: {},
    systemDirs: [],
    recentDirs: loadRecentDirsFromStorage(),
    registeredDirs: [],
    federationNodes: [],
    pageFullscreen: false,
    showDirsDropdown: false,
    filterNodeId: savedFilterNodeId,
    defaultSpawnNodeId: savedFilterNodeId,
    tiles: activeTiles,
    layoutCustomized: layout.layoutCustomized,
    gridMaxZ: activeTiles.reduce((m, t) => Math.max(m, t.zIndex), 1),
    savedContainer: layout.savedContainer,
    workspaceTilePool: poolTiles,
    workspaceCount: ws.workspaceCount,
    activeWorkspace: ws.activeWorkspace,
    sessionWorkspace: ws.sessionWorkspace,
    gridContainer: { width: 0, height: 0 },
    // savedContainer comes from the spread above; the explicit gridContainer
    // below stays {0,0} so the first ResizeObserver tick is treated as the
    // first measurement.
    showLayoutsMenu: false,
    layoutPresets: [],
    tileSnapGuides: [],
    tileDock: null,
    draggingTileId: null,
    resizingTileId: null,
    sendMenuForId: null,
    sendMenuAnchor: null,
  };
}

/** Toggle the topbar registered-directories dropdown. */
export function toggleDirsDropdown(state: AppViewState, force?: boolean): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.showDirsDropdown = typeof force === "boolean" ? force : !ts.showDirsDropdown;
  state.requestUpdate?.();
}

const RECENT_DIRS_STORAGE_KEY = "infinibot:terminals:recentDirs";
const MAX_RECENT_DIRS = 6;

const FILTER_NODE_ID_STORAGE_KEY = "infinibot.terminals.filterNodeId";

function loadFilterNodeIdFromStorage(): string | null {
  try { return window.localStorage.getItem(FILTER_NODE_ID_STORAGE_KEY) || null; }
  catch { return null; }
}

function saveFilterNodeIdToStorage(nodeId: string | null): void {
  try {
    if (nodeId) window.localStorage.setItem(FILTER_NODE_ID_STORAGE_KEY, nodeId);
    else window.localStorage.removeItem(FILTER_NODE_ID_STORAGE_KEY);
  } catch { /* ignore */ }
}

function validateAndApplyFilterNode(ts: TerminalsState, nodes: FederationNodeEntry[]): void {
  if (ts.filterNodeId && !nodes.some((n) => n.id === ts.filterNodeId)) {
    ts.filterNodeId = null;
    ts.defaultSpawnNodeId = null;
    saveFilterNodeIdToStorage(null);
  } else if (ts.filterNodeId) {
    ts.defaultSpawnNodeId = ts.filterNodeId;
    ts.createForm.nodeId = ts.filterNodeId;
  }
}

export function nodeHasOllama(
  node?: { capabilities?: unknown; id?: string; isLocal?: boolean } | null,
): boolean {
  const caps = node?.capabilities;
  if (Array.isArray(caps)) {
    return caps.some((c) => String(c).toLowerCase() === "ollama");
  }
  if (caps && typeof caps === "object") {
    const record = caps as Record<string, unknown>;
    return record.hasOllama === true || record.ollama === true;
  }
  return false;
}

export function resolveCliVersionForNode(
  ts: TerminalsState,
  cli: CliType,
  nodeId: string,
): { installed: string | boolean | null; path?: string } {
  if (cli !== "ollama") return ts.cliVersions[cli] ?? { installed: null };
  const node = ts.federationNodes.find((n) => n.id === nodeId);
  return { installed: nodeHasOllama(node) ? true : null };
}

function syncOllamaCliVersionForSelectedNode(ts: TerminalsState, nodeId: string): void {
  ts.cliVersions.ollama = resolveCliVersionForNode(ts, "ollama", nodeId);
}

export function setTerminalFilterNode(state: AppViewState, nodeId: string | null): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.filterNodeId = nodeId;
  ts.defaultSpawnNodeId = nodeId;
  ts.createForm.nodeId = nodeId ?? "local";
  syncOllamaCliVersionForSelectedNode(ts, ts.createForm.nodeId);
  saveFilterNodeIdToStorage(nodeId);
  state.requestUpdate?.();
}

function loadRecentDirsFromStorage(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_DIRS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === "string").slice(0, MAX_RECENT_DIRS);
  } catch { /* ignore */ }
  return [];
}

function saveRecentDirsToStorage(dirs: string[]): void {
  try {
    window.localStorage.setItem(RECENT_DIRS_STORAGE_KEY, JSON.stringify(dirs.slice(0, MAX_RECENT_DIRS)));
  } catch { /* ignore */ }
}

function rememberRecentDir(state: AppViewState, dir: string): void {
  const ts = state.terminalsState;
  if (!ts || !dir) return;
  const trimmed = dir.trim();
  if (!trimmed) return;
  const filtered = ts.recentDirs.filter((d) => d.toLowerCase() !== trimmed.toLowerCase());
  ts.recentDirs = [trimmed, ...filtered].slice(0, MAX_RECENT_DIRS);
  saveRecentDirsToStorage(ts.recentDirs);
}

// ============================================================
// Grid placement layer (draggable / resizable snap-grid tiles)
// ============================================================
//
// Brings the masonry-grid placement model to the terminals page: each terminal
// is an absolutely-positioned tile on a snap canvas. All geometry is delegated
// to the shared `lib/grid-geometry` helpers so behaviour matches the grid view.
// The PTY lifecycle is untouched — tiles only change pixel size/position and the
// xterm FitAddon recomputes cols/rows from the tile's final box.

const TERM_MIN_WIDTH = 240;
const TERM_MIN_HEIGHT = 160;
const TERM_DEFAULT_WIDTH = 480;
const TERM_DEFAULT_HEIGHT = 360;
const TERM_SNAP_SIZE = 10;
const TERM_SNAP_THRESHOLD = 15;
/** Inter-panel gutter (and outer margin) in px. The standalone terminals page
 *  is intentionally flush/edge-to-edge, matching /grid's shared tile helpers. */
const TERM_GRID_GAP = 0;
/** Stable preset scope id (analogous to masonry's active canvas id). */
const TERM_GRID_SCOPE = "terminals";
const TERMINAL_LAYOUT_STORAGE_KEY = "infinibot-terminals-layout";
const TERMINAL_PRESETS_STORAGE_KEY = "infinibot-terminals-presets";
/** Below this canvas width, tiles degrade to a single stacked column. */
export const TERM_MOBILE_BREAKPOINT = 600;

/** Preset store for the terminals scope — same format/helpers as masonry. */
const terminalPresetStore = createLayoutPresetStore<TerminalPresetEntry>({
  storageKey: TERMINAL_PRESETS_STORAGE_KEY,
});

interface TerminalLayoutFile {
  tiles: TerminalTile[];
  layoutCustomized: boolean;
  /** Canvas size the layout was authored at (for fit-scaling on restore). */
  container?: { width: number; height: number };
  /** Per-cell metadata so dead slots can be rebuilt as placeholders. */
  cells?: TerminalCellDescriptor[];
}

function isCellLike(v: unknown): v is TerminalCellDescriptor {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === "string" && typeof c.cli === "string";
}

function isTileLike(v: unknown): v is TerminalTile {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.x === "number" &&
    typeof t.y === "number" &&
    typeof t.width === "number" &&
    typeof t.height === "number" &&
    typeof t.zIndex === "number"
  );
}

function loadTerminalLayoutFromStorage(): {
  tiles: TerminalTile[];
  layoutCustomized: boolean;
  gridMaxZ: number;
  savedContainer: { width: number; height: number };
} {
  try {
    const raw = window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TerminalLayoutFile;
      if (Array.isArray(parsed?.tiles)) {
        const tiles = parsed.tiles.filter(isTileLike);
        const gridMaxZ = tiles.reduce((m, t) => Math.max(m, t.zIndex), 1);
        // Preserve the persisted geometry so manual drags/resizes survive a
        // reload (the whole point of a tiling workspace). We sanitise each rect
        // (finite, min-sized, non-negative origin) and carry the
        // `layoutCustomized` flag forward. Gap-safety is NOT this function's
        // job: on the next paint `setTerminalGridContainer` scales the layout
        // to the live canvas and `ensureTerminalTiles` runs
        // `autoFlattenIfUniformGrid` + `compactToFlush`, which rebuild any
        // legacy uniform-gutter layout and pin every edge flush. That pipeline
        // is what historically removed gaps — keeping coordinates here does not
        // reintroduce them because those passes always run afterwards.
        const sane = (n: number, fallback: number) =>
          Number.isFinite(n) ? n : fallback;
        const restored = tiles.map((t) => ({
          id: t.id,
          x: Math.max(0, sane(t.x, 0)),
          y: Math.max(0, sane(t.y, 0)),
          width: Math.max(TERM_MIN_WIDTH, sane(t.width, TERM_DEFAULT_WIDTH)),
          height: Math.max(TERM_MIN_HEIGHT, sane(t.height, TERM_DEFAULT_HEIGHT)),
          zIndex: sane(t.zIndex, 1),
        }));
        const layoutCustomized = parsed?.layoutCustomized === true;
        const c = parsed?.container;
        const savedContainer =
          c && Number.isFinite(c.width) && Number.isFinite(c.height) && c.width > 0 && c.height > 0
            ? { width: c.width, height: c.height }
            : { width: 0, height: 0 };
        return { tiles: restored, layoutCustomized, gridMaxZ, savedContainer };
      }
    }
  } catch {
    /* ignore */
  }
  return { tiles: [], layoutCustomized: false, gridMaxZ: 1, savedContainer: { width: 0, height: 0 } };
}

/** Read just the per-cell descriptors saved with the last layout. */
function loadTerminalCellsFromStorage(): TerminalCellDescriptor[] {
  try {
    const raw = window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as TerminalLayoutFile;
      if (Array.isArray(parsed?.cells)) return parsed.cells.filter(isCellLike);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function saveTerminalLayout(ts: TerminalsState): void {
  try {
    // The active workspace's tiles live in `ts.tiles`; inactive workspaces'
    // tiles sit in `ts.workspaceTilePool`. Persist the union (active wins on
    // id collision) so every workspace's layout survives a reload.
    const activeIds = new Set(ts.tiles.map((t) => t.id));
    const allTiles: TerminalTile[] = [
      ...ts.workspaceTilePool.filter((t) => !activeIds.has(t.id)),
      ...ts.tiles,
    ];
    // Persist a cell descriptor for every session that owns a tile (live or
    // placeholder) so the slot — and enough metadata to relaunch it — survives
    // a refresh even if its PTY has since died.
    const tileIds = new Set(allTiles.map((t) => t.id));
    const cells: TerminalCellDescriptor[] = ts.sessions
      .filter((s) => tileIds.has(s.id))
      .map((s) => ({
        id: s.id,
        ptyId: s.ptyId,
        title: s.title,
        cli: s.cli,
        cwd: s.cwd,
        model: s.model,
        nodeId: s.nodeId,
        nodeName: s.nodeName,
      }));
    window.localStorage.setItem(
      TERMINAL_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        tiles: allTiles,
        layoutCustomized: ts.layoutCustomized,
        container: ts.gridContainer,
        cells,
      }),
    );
  } catch {
    /* ignore */
  }
}

// ── Numbered workspaces ──────────────────────────────────────
//
// Each workspace holds up to MAX_TERMINALS_PER_WORKSPACE terminals; spawning a
// 7th spills into the next numbered workspace (created on demand). Mirrors the
// /grid page tab pattern. Assignment is a sessionId → workspace map persisted
// alongside the layout, so workspaces survive a reload — terminal ids are
// stable across a refresh (they are restored from the gateway by id).

export const MAX_TERMINALS_PER_WORKSPACE = 6;
const TERMINAL_WORKSPACES_STORAGE_KEY = "infinibot-terminal-workspaces";

/** Workspace a session belongs to (defaults to 1 for unmapped sessions). */
export function workspaceOf(ts: TerminalsState, id: string): number {
  return ts.sessionWorkspace[id] || 1;
}

/** Live sessions assigned to workspace `n`. */
function sessionsInWorkspace(ts: TerminalsState, n: number): TerminalSession[] {
  return ts.sessions.filter((s) => workspaceOf(ts, s.id) === n);
}

/** Terminal count in workspace `n` (used for the tab badge). */
export function workspaceTerminalCount(ts: TerminalsState, n: number): number {
  return sessionsInWorkspace(ts, n).length;
}

function loadWorkspaceStateFromStorage(): {
  workspaceCount: number;
  activeWorkspace: number;
  sessionWorkspace: Record<string, number>;
} {
  const fallback = { workspaceCount: 1, activeWorkspace: 1, sessionWorkspace: {} };
  try {
    const raw = window.localStorage.getItem(TERMINAL_WORKSPACES_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<typeof fallback>;
    const map: Record<string, number> = {};
    if (parsed.sessionWorkspace && typeof parsed.sessionWorkspace === "object") {
      for (const [id, n] of Object.entries(parsed.sessionWorkspace)) {
        if (typeof n === "number" && Number.isFinite(n) && n >= 1) map[id] = Math.floor(n);
      }
    }
    const maxAssigned = Object.values(map).reduce((m, n) => Math.max(m, n), 1);
    const workspaceCount = Math.max(1, maxAssigned, Math.floor(parsed.workspaceCount || 1));
    let activeWorkspace = Math.floor(parsed.activeWorkspace || 1);
    if (!Number.isFinite(activeWorkspace) || activeWorkspace < 1) activeWorkspace = 1;
    if (activeWorkspace > workspaceCount) activeWorkspace = workspaceCount;
    return { workspaceCount, activeWorkspace, sessionWorkspace: map };
  } catch {
    return fallback;
  }
}

function saveWorkspaceState(ts: TerminalsState): void {
  try {
    window.localStorage.setItem(
      TERMINAL_WORKSPACES_STORAGE_KEY,
      JSON.stringify({
        workspaceCount: ts.workspaceCount,
        activeWorkspace: ts.activeWorkspace,
        sessionWorkspace: ts.sessionWorkspace,
      }),
    );
  } catch {
    /* ignore */
  }
}

/**
 * Assign a freshly-spawned session to a workspace. Prefers the active
 * workspace; if it is full (>= MAX), spills into the lowest-numbered workspace
 * with room, creating the next numbered workspace when all existing ones are
 * full. Returns the workspace the session landed in. Does NOT switch focus.
 */
function assignSessionWorkspace(ts: TerminalsState, id: string): number {
  let target = ts.activeWorkspace;
  if (workspaceTerminalCount(ts, target) >= MAX_TERMINALS_PER_WORKSPACE) {
    target = 0;
    for (let n = 1; n <= ts.workspaceCount; n++) {
      if (workspaceTerminalCount(ts, n) < MAX_TERMINALS_PER_WORKSPACE) { target = n; break; }
    }
    if (target === 0) {
      ts.workspaceCount += 1;
      target = ts.workspaceCount;
    }
  }
  ts.sessionWorkspace[id] = target;
  if (target > ts.workspaceCount) ts.workspaceCount = target;
  return target;
}

/** Move the active workspace's tiles into the pool (keyed by session id). */
function commitActiveTiles(ts: TerminalsState): void {
  const activeIds = new Set(sessionsInWorkspace(ts, ts.activeWorkspace).map((s) => s.id));
  ts.workspaceTilePool = ts.workspaceTilePool.filter((t) => !activeIds.has(t.id));
  ts.workspaceTilePool.push(...ts.tiles.filter((t) => activeIds.has(t.id)));
}

/** Switch the visible workspace, swapping tile sets through the pool. */
export function switchTerminalWorkspace(state: AppViewState, n: number): void {
  const ts = state.terminalsState;
  if (!ts) return;
  const target = Math.max(1, Math.min(Math.floor(n), ts.workspaceCount));
  if (target === ts.activeWorkspace) return;
  commitActiveTiles(ts);
  ts.activeWorkspace = target;
  // Pull the target workspace's tiles out of the pool into the working set.
  const targetIds = new Set(sessionsInWorkspace(ts, target).map((s) => s.id));
  ts.tiles = ts.workspaceTilePool.filter((t) => targetIds.has(t.id));
  ts.workspaceTilePool = ts.workspaceTilePool.filter((t) => !targetIds.has(t.id));
  ts.gridMaxZ = ts.tiles.reduce((m, t) => Math.max(m, t.zIndex), 1);
  saveWorkspaceState(ts);
  saveTerminalLayout(ts);
  state.requestUpdate?.();
}

/** Manually add an empty workspace and switch to it (the "+" button). */
export function addTerminalWorkspace(state: AppViewState): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.workspaceCount += 1;
  switchTerminalWorkspace(state, ts.workspaceCount);
}

/**
 * Reconcile the workspace map with the live session list: assign any unmapped
 * session (e.g. restored from the gateway after a reload) to a workspace, drop
 * map entries for sessions that no longer exist, and clamp counts / active.
 */
function reconcileWorkspaces(ts: TerminalsState): void {
  const liveIds = new Set(ts.sessions.map((s) => s.id));
  for (const id of Object.keys(ts.sessionWorkspace)) {
    if (!liveIds.has(id)) delete ts.sessionWorkspace[id];
  }
  for (const s of ts.sessions) {
    if (!ts.sessionWorkspace[s.id]) assignSessionWorkspace(ts, s.id);
  }
  const maxAssigned = Object.values(ts.sessionWorkspace).reduce((m, n) => Math.max(m, n), 1);
  ts.workspaceCount = Math.max(1, ts.workspaceCount, maxAssigned);
  if (ts.activeWorkspace > ts.workspaceCount) ts.activeWorkspace = ts.workspaceCount;
  if (ts.activeWorkspace < 1) ts.activeWorkspace = 1;
  saveWorkspaceState(ts);
}

/**
 * Given the live (re-attached) sessions and the per-cell descriptors saved in
 * the previous layout, produce placeholder sessions for any saved cell whose
 * PTY is no longer live. This is what keeps a grid slot from vanishing when its
 * terminal died while the page was closed — the user gets an empty slot with a
 * "Reattach" affordance instead of silent loss. Pure (no DOM / storage) so it
 * can be unit-tested directly.
 */
export function reconcilePlaceholderSessions(
  liveSessions: Pick<TerminalSession, "id">[],
  savedCells: TerminalCellDescriptor[],
  now: string = new Date().toISOString(),
): TerminalSession[] {
  const liveIds = new Set(liveSessions.map((s) => s.id));
  const seen = new Set<string>();
  const placeholders: TerminalSession[] = [];
  for (const cell of savedCells) {
    if (!cell?.id || liveIds.has(cell.id) || seen.has(cell.id)) continue;
    seen.add(cell.id);
    placeholders.push({
      id: cell.id,
      title:
        cell.title ||
        generateTitle(cell.cli, placeholders.length, {
          nodeId: cell.nodeId,
          sessionId: cell.id,
        }),
      cli: cell.cli,
      status: "exited",
      model: cell.model,
      cwd: cell.cwd || ".",
      createdAt: now,
      expandedView: false,
      nodeId: cell.nodeId,
      nodeName: cell.nodeName,
      isPlaceholder: true,
    });
  }
  return placeholders;
}

/** Collapse every panel that points at the same backing PTY on the same node. */
export function dedupeTerminalSessions(sessions: TerminalSession[]): TerminalSession[] {
  const byKey = new Map<string, TerminalSession>();
  const order: string[] = [];
  for (const session of sessions) {
    if (!session?.id) continue;
    const key = `${session.nodeId || "local"}::${canonicalPtyId(ptyIdOf(session))}`;
    const previous = byKey.get(key);
    if (!previous) order.push(key);
    // Keep the first row's id/ptyId because it is normally the active manager
    // id used by RPC calls; later rows supply richer reattach metadata.
    byKey.set(
      key,
      previous
        ? { ...previous, ...session, id: previous.id, ptyId: previous.ptyId }
        : session,
    );
  }
  return order.map((key) => byKey.get(key)!);
}

function terminalGridEnv(ts: TerminalsState): GridEnv {
  return {
    containerWidth: ts.gridContainer.width || 1200,
    containerHeight: ts.gridContainer.height || 800,
    snapSize: TERM_SNAP_SIZE,
    snapThreshold: TERM_SNAP_THRESHOLD,
    minWidth: TERM_MIN_WIDTH,
    minHeight: TERM_MIN_HEIGHT,
    gridMode: "free",
    gap: TERM_GRID_GAP,
  };
}

/** Sessions visible under the current device filter, in render order. */
function visibleSessions(ts: TerminalsState): TerminalSession[] {
  const filtered = ts.filterNodeId
    ? ts.sessions.filter((s) => (s.nodeId ?? "local") === ts.filterNodeId)
    : ts.sessions;
  // Final invariant at the render boundary: never expose two cards backed by
  // the same tmux session, even if an asynchronous event briefly adds an alias.
  return dedupeTerminalSessions(filtered);
}

/** Tiles for the visible sessions, ordered to match the session list. */
function visibleTiles(ts: TerminalsState): TerminalTile[] {
  const byId = new Map(ts.tiles.map((t) => [t.id, t] as const));
  return visibleSessions(ts)
    .map((s) => byId.get(s.id))
    .filter((t): t is TerminalTile => !!t);
}

/**
 * Snap every pair of adjacent tile edges onto a single shared coordinate so
 * the layout has truly zero space between panels regardless of how it got
 * there (auto-tile, manual drag, persisted state from an older scale path).
 *
 * Strategy: collect every unique x / right / y / bottom coordinate, cluster
 * coordinates within FLUSH_SNAP px of each other, replace each tile edge
 * with the cluster's representative value. This is shape-preserving — it
 * does NOT change which tiles are neighbours, it just removes the hairline
 * gap between them.
 *
 * Final pass also clamps the outermost edges to (0, containerW) / (0, containerH)
 * so the grid is flush with the canvas edges too.
 */
const FLUSH_SNAP = 40;
/**
 * Look at the persisted tile rectangles and decide whether they're effectively
 * a regular MxN grid with a uniform gutter (typical of older auto-arrange
 * layouts saved with non-zero gap). If so, call tileColumns to rebuild the
 * layout flush, ignoring the persisted gutter. Returns true if the layout
 * was rebuilt.
 */
function autoFlattenIfUniformGrid(ts: TerminalsState): boolean {
  if (ts.tiles.length < 2) return false;
  const env = terminalGridEnv(ts);
  if (env.containerWidth <= 0 || env.containerHeight <= 0) return false;
  // When an intentional gutter is configured the layout is *supposed* to keep a
  // uniform gap, so flush-flattening is disabled.
  if ((env.gap ?? 0) > 0) return false;
  const xs = [...new Set(ts.tiles.map((t) => t.x))].sort((a, b) => a - b);
  const ys = [...new Set(ts.tiles.map((t) => t.y))].sort((a, b) => a - b);
  // Need ≥ 2 distinct x's or y's for a gap to be visible.
  if (xs.length < 2 && ys.length < 2) return false;
  const colGap = xs.length >= 2
    ? xs[1] - (xs[0] + (ts.tiles.find((t) => t.x === xs[0])?.width ?? 0))
    : 0;
  const rowGap = ys.length >= 2
    ? ys[1] - (ys[0] + (ts.tiles.find((t) => t.y === ys[0])?.height ?? 0))
    : 0;
  if (colGap <= 1 && rowGap <= 1) return false;
  // Anything more than a hairline gutter is "broken flush" — rebuild.
  const cols = autoColumns(env.containerWidth, ts.tiles.length);
  ts.tiles = tileColumns(ts.tiles, cols, env);
  ts.layoutCustomized = false;
  return true;
}

function compactToFlush(ts: TerminalsState): boolean {
  if (ts.tiles.length === 0) return false;
  // Don't flush against the fallback container size: before the first real
  // ResizeObserver measurement `gridContainer` is {0,0} and terminalGridEnv
  // substitutes 1200x800. Snapping/pinning a restored custom layout to that
  // wrong canvas distorts it (and reintroduces a perimeter gap once the real,
  // larger canvas is measured). Wait for a real measurement.
  if (ts.gridContainer.width <= 0 || ts.gridContainer.height <= 0) return false;
  const env = terminalGridEnv(ts);
  // A configured gutter is incompatible with flush snapping — it would collapse
  // the gap and pin tiles to the canvas edge — so skip the whole pass when a gap
  // is set.
  if ((env.gap ?? 0) > 0) return false;
  const W = env.containerWidth;
  const H = env.containerHeight;
  // We snap distinct rect edges (left, right, top, bottom) independently.
  const cluster = (values: number[]): Map<number, number> => {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    const map = new Map<number, number>();
    let leader = sorted[0];
    map.set(leader, leader);
    for (let i = 1; i < sorted.length; i++) {
      const v = sorted[i];
      if (v - leader <= FLUSH_SNAP) {
        map.set(v, leader);
      } else {
        leader = v;
        map.set(leader, leader);
      }
    }
    return map;
  };
  const xs = ts.tiles.flatMap((t) => [t.x, t.x + t.width]);
  const ys = ts.tiles.flatMap((t) => [t.y, t.y + t.height]);
  const xMap = cluster(xs);
  const yMap = cluster(ys);
  let changed = false;
  ts.tiles = ts.tiles.map((t) => {
    let left = xMap.get(t.x) ?? t.x;
    let right = xMap.get(t.x + t.width) ?? t.x + t.width;
    let top = yMap.get(t.y) ?? t.y;
    let bottom = yMap.get(t.y + t.height) ?? t.y + t.height;
    // Pin outermost edges to the canvas so no perimeter gap survives.
    if (left <= FLUSH_SNAP) left = 0;
    if (top <= FLUSH_SNAP) top = 0;
    if (W > 0 && W - right <= FLUSH_SNAP) right = W;
    if (H > 0 && H - bottom <= FLUSH_SNAP) bottom = H;
    const width = Math.max(TERM_MIN_WIDTH, right - left);
    const height = Math.max(TERM_MIN_HEIGHT, bottom - top);
    if (left !== t.x || top !== t.y || width !== t.width || height !== t.height) {
      changed = true;
    }
    return { ...t, x: left, y: top, width, height };
  });
  return changed;
}

function cascadeTile(ts: TerminalsState, env: GridEnv, id: string): TerminalTile {
  const n = ts.tiles.length;
  const offset = (n % 6) * 28;
  const x = Math.min(offset, Math.max(0, env.containerWidth - TERM_DEFAULT_WIDTH));
  const y = Math.min(offset, Math.max(0, env.containerHeight - TERM_DEFAULT_HEIGHT));
  ts.gridMaxZ += 1;
  return { id, x, y, width: TERM_DEFAULT_WIDTH, height: TERM_DEFAULT_HEIGHT, zIndex: ts.gridMaxZ };
}

/**
 * Reconcile `ts.tiles` with the live session list: drop tiles for gone
 * sessions, add tiles for new ones. While the user hasn't customised the
 * layout, new spawns trigger an auto-arrange of the whole canvas; afterwards
 * new tiles cascade in so existing work isn't disturbed. Returns true if the
 * tile set changed (and persists in that case).
 */
export function ensureTerminalTiles(state: AppViewState): boolean {
  const ts = state.terminalsState;
  if (!ts) return false;
  // Keep the PTY↔panel fan-out index in lockstep with the live session list on
  // every render so mirror panels always receive their shared PTY's output.
  reindexPtyPanels(ts);
  // `ts.tiles` only ever holds the *active* workspace's tiles; other
  // workspaces' tiles wait in `ts.workspaceTilePool`. Reconcile against the
  // active workspace's sessions so the layout engine arranges that set alone.
  const activeSessions = sessionsInWorkspace(ts, ts.activeWorkspace);
  const ids = new Set(activeSessions.map((s) => s.id));
  let changed = false;

  const kept = ts.tiles.filter((t) => ids.has(t.id));
  if (kept.length !== ts.tiles.length) {
    ts.tiles = kept;
    changed = true;
  }

  const existing = new Set(ts.tiles.map((t) => t.id));
  const missing = activeSessions.filter((s) => !existing.has(s.id));
  if (missing.length > 0) {
    const env = terminalGridEnv(ts);
    if (!ts.layoutCustomized) {
      for (const s of missing) ts.tiles.push(cascadeTile(ts, env, s.id));
      const cols = autoColumns(env.containerWidth, ts.tiles.length);
      ts.tiles = tileColumns(ts.tiles, cols, env);
      ts.gridMaxZ = ts.tiles.reduce((m, t) => Math.max(m, t.zIndex), ts.gridMaxZ);
    } else {
      for (const s of missing) {
        const tile = cascadeTile(ts, env, s.id);
        // Clamp so a new cascade tile never overflows the current canvas.
        tile.x = Math.min(tile.x, Math.max(0, env.containerWidth - tile.width));
        tile.y = Math.min(tile.y, Math.max(0, env.containerHeight - tile.height));
        ts.tiles.push(tile);
      }
    }
    changed = true;
  }

  // Step 1 — if the persisted layout is a regular grid with a uniform gutter
  // (most common cause of the "every column has a 25 px gap" complaint),
  // rebuild it flush via tileColumns. Step 2 — close any remaining
  // sub-pixel / drag-introduced gaps with the edge-snap pass.
  const rebuilt = autoFlattenIfUniformGrid(ts);
  const flushed = compactToFlush(ts);
  if (changed || rebuilt || flushed) saveTerminalLayout(ts);
  return changed || rebuilt || flushed;
}

/** Raise a tile above the others (called on drag / focus). */
function focusTile(ts: TerminalsState, id: string): void {
  ts.gridMaxZ += 1;
  const z = ts.gridMaxZ;
  ts.tiles = ts.tiles.map((t) => (t.id === id ? { ...t, zIndex: z } : t));
}

/** Update the measured canvas size; reflow tiles so nothing overflows. */
export function setTerminalGridContainer(state: AppViewState, width: number, height: number): void {
  const ts = state.terminalsState;
  if (!ts) return;
  const prev = ts.gridContainer;
  if (Math.abs(prev.width - width) < 2 && Math.abs(prev.height - height) < 2) return;

  // First measurement (prev is 0 from createInitialTerminalsState): always
  // re-tile because saved tiles might be sized for a different viewport.
  const firstMeasurement = prev.width === 0 || prev.height === 0;

  ts.gridContainer = { width, height };

  if (ts.tiles.length > 0) {
    if (!ts.layoutCustomized) {
      // Auto layout: arrange to fill the actual canvas exactly. (Runs on the
      // first paint too, when the user has never customised the layout.)
      const cols = autoColumns(width, ts.tiles.length);
      ts.tiles = tileColumns(ts.tiles, cols, terminalGridEnv(ts));
    } else {
      // User has dragged/resized: scale proportionally so the manual layout
      // fits the live canvas without overflow. scaleX/Y can be >1 (viewport
      // grew) or <1 (viewport shrank). On the FIRST measurement we scale from
      // the canvas size the layout was authored at (savedContainer) so a
      // persisted custom layout restores at the correct scale instead of being
      // discarded — this is what makes drags/resizes survive a reload.
      const base = firstMeasurement && ts.savedContainer.width > 0 && ts.savedContainer.height > 0
        ? ts.savedContainer
        : prev;
      const scaleX = base.width > 0 ? width / base.width : 1;
      const scaleY = base.height > 0 ? height / base.height : 1;
      ts.tiles = ts.tiles.map(t => ({
        ...t,
        x: Math.max(0, Math.round(t.x * scaleX)),
        y: Math.max(0, Math.round(t.y * scaleY)),
        width: Math.max(TERM_MIN_WIDTH, Math.round(t.width * scaleX)),
        height: Math.max(TERM_MIN_HEIGHT, Math.round(t.height * scaleY)),
      }));
    }
    // Snap closed any hairline / sub-pixel gaps introduced by the scale path
    // or by older persisted tile rectangles, so the canvas is truly flush.
    compactToFlush(ts);
    saveTerminalLayout(ts);
  }

  scheduleTerminalRefit(ts);
  state.requestUpdate?.();
}

/**
 * Auto-pick the largest full-height column count that preserves the terminal
 * minimum width. Rows appear only once side-by-side columns no longer fit.
 */
function autoColumns(canvasWidth: number, count: number): number {
  if (count <= 0) return 1;
  const gap = TERM_GRID_GAP;
  const maxFullHeightColumns = Math.max(
    1,
    Math.floor((canvasWidth - gap) / (TERM_MIN_WIDTH + gap)) || 1,
  );
  return Math.min(count, maxFullHeightColumns);
}

let _refitTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTerminalRefit(ts: TerminalsState): void {
  if (_refitTimer) clearTimeout(_refitTimer);
  _refitTimer = setTimeout(() => {
    for (const s of ts.sessions) {
      const xterm = getXtermInstance(s.id);
      if (xterm) {
        try { xterm.fit(); } catch { /* not ready */ }
      }
    }
  }, 60);
}

// ── Pointer-driven drag / resize ─────────────────────────────

interface TileDragInteraction {
  kind: "drag";
  state: AppViewState;
  id: string;
  startX: number;
  startY: number;
  startTileX: number;
  startTileY: number;
}

interface TileResizeInteraction {
  kind: "resize";
  state: AppViewState;
  id: string;
  edge: ResizeEdge;
  startX: number;
  startY: number;
  startBox: RectBox;
  links: LinkedPanelSnapshot[];
}

let activeInteraction: TileDragInteraction | TileResizeInteraction | null = null;

function pointerXY(e: PointerEvent | MouseEvent): { x: number; y: number } {
  return { x: e.clientX, y: e.clientY };
}

function canvasRect(): DOMRect | null {
  const el = document.querySelector(".term-grid-canvas") as HTMLElement | null;
  return el ? el.getBoundingClientRect() : null;
}

export function startTileDrag(state: AppViewState, id: string, e: PointerEvent): void {
  const ts = state.terminalsState;
  if (!ts) return;
  const tile = ts.tiles.find((t) => t.id === id);
  if (!tile) return;
  e.preventDefault();
  focusTile(ts, id);
  ts.activeSessionId = id;
  const p = pointerXY(e);
  const moved = ts.tiles.find((t) => t.id === id)!;
  activeInteraction = {
    kind: "drag",
    state,
    id,
    startX: p.x,
    startY: p.y,
    startTileX: moved.x,
    startTileY: moved.y,
  };
  ts.draggingTileId = id;
  attachInteractionListeners();
  state.requestUpdate?.();
}

export function startTileResize(state: AppViewState, id: string, edge: ResizeEdge, e: PointerEvent): void {
  const ts = state.terminalsState;
  if (!ts) return;
  const tile = ts.tiles.find((t) => t.id === id);
  if (!tile) return;
  e.preventDefault();
  e.stopPropagation();
  focusTile(ts, id);
  const moved = ts.tiles.find((t) => t.id === id)!;
  const p = pointerXY(e);
  activeInteraction = {
    kind: "resize",
    state,
    id,
    edge,
    startX: p.x,
    startY: p.y,
    startBox: { x: moved.x, y: moved.y, width: moved.width, height: moved.height },
    links: findLinkedPanels(ts.tiles, id, edge),
  };
  ts.resizingTileId = id;
  attachInteractionListeners();
  state.requestUpdate?.();
}

function onInteractionMove(e: PointerEvent): void {
  if (!activeInteraction) return;
  const ai = activeInteraction;
  const ts = ai.state.terminalsState;
  if (!ts) return;
  const env = terminalGridEnv(ts);
  const p = pointerXY(e);

  if (ai.kind === "drag") {
    const nx = ai.startTileX + (p.x - ai.startX);
    const ny = ai.startTileY + (p.y - ai.startY);
    ts.tileSnapGuides = getActiveSnapGuides(ts.tiles, ai.id, nx, ny, env);
    const r = canvasRect();
    ts.tileDock = r
      ? getDockZone(ts.tiles, ai.id, p.x - r.left, p.y - r.top, env, {
          preferFullHeightSides: true,
        })
      : null;
    ts.tiles = snapRectPosition(ts.tiles, ai.id, nx, ny, env);
    ai.state.requestUpdate?.();
    return;
  }

  // resize
  const dx = p.x - ai.startX;
  const dy = p.y - ai.startY;
  const aspect = e.shiftKey ? ai.startBox.width / ai.startBox.height : undefined;
  const box = resizeBox(ai.startBox, ai.edge, dx, dy, env, aspect);
  ts.tiles = ts.tiles.map((t) =>
    t.id === ai.id ? { ...t, x: box.x, y: box.y, width: box.width, height: box.height } : t,
  );
  if (ai.links.length > 0) {
    const dxRight = box.x + box.width - (ai.startBox.x + ai.startBox.width);
    const dxLeft = box.x - ai.startBox.x;
    const dyBottom = box.y + box.height - (ai.startBox.y + ai.startBox.height);
    const dyTop = box.y - ai.startBox.y;
    ts.tiles = applyLinkedResize(ts.tiles, ai.links, dxRight, dxLeft, dyBottom, dyTop, env);
  }
  ai.state.requestUpdate?.();
}

function onInteractionUp(): void {
  const ai = activeInteraction;
  activeInteraction = null;
  detachInteractionListeners();
  if (!ai) return;
  const ts = ai.state.terminalsState;
  if (!ts) return;

  if (ai.kind === "drag" && ts.tileDock) {
    ts.tiles = applyDockZone(ts.tiles, ai.id, ts.tileDock, terminalGridEnv(ts));
  }
  ts.tileDock = null;
  ts.tileSnapGuides = [];
  ts.draggingTileId = null;
  ts.resizingTileId = null;
  ts.layoutCustomized = true;
  // After any drag/resize settles, snap stray sub-pixel gaps between the moved
  // tile and its neighbours closed so the layout stays flush.
  compactToFlush(ts);
  saveTerminalLayout(ts);
  scheduleTerminalRefit(ts);
  ai.state.requestUpdate?.();
}

function attachInteractionListeners(): void {
  window.addEventListener("pointermove", onInteractionMove);
  window.addEventListener("pointerup", onInteractionUp);
  window.addEventListener("pointercancel", onInteractionUp);
}

function detachInteractionListeners(): void {
  window.removeEventListener("pointermove", onInteractionMove);
  window.removeEventListener("pointerup", onInteractionUp);
  window.removeEventListener("pointercancel", onInteractionUp);
}

// ── Quick layouts + saved presets ────────────────────────────

function mergeArranged(ts: TerminalsState, arranged: TerminalTile[]): void {
  const byId = new Map(arranged.map((t) => [t.id, t] as const));
  ts.tiles = ts.tiles.map((t) => byId.get(t.id) ?? t);
  ts.gridMaxZ = ts.tiles.reduce((m, t) => Math.max(m, t.zIndex), ts.gridMaxZ);
}

export function applyTerminalQuickPreset(state: AppViewState, preset: TerminalQuickPresetId): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ensureTerminalTiles(state);
  const env = terminalGridEnv(ts);
  const visible = visibleTiles(ts);
  if (visible.length === 0) return;

  let arranged: TerminalTile[];
  switch (preset) {
    case "one": arranged = tileColumns(visible, 1, env); break;
    case "twoCol": arranged = tileColumns(visible, 2, env); break;
    case "threeCol": arranged = tileColumns(visible, 3, env); break;
    case "grid": arranged = tileGridGeneric(visible, env); break;
    case "focusLeft": arranged = tileFocus(visible, "left", env); break;
    case "focusRight": arranged = tileFocus(visible, "right", env); break;
    default: return;
  }

  mergeArranged(ts, arranged);
  ts.layoutCustomized = true;
  ts.showLayoutsMenu = false;
  saveTerminalLayout(ts);
  scheduleTerminalRefit(ts);
  state.requestUpdate?.();
}

export function toggleTerminalLayoutsMenu(state: AppViewState): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.showLayoutsMenu = !ts.showLayoutsMenu;
  if (ts.showLayoutsMenu) {
    ts.layoutPresets = terminalPresetStore.list(TERM_GRID_SCOPE);
  }
  state.requestUpdate?.();
}

export function closeTerminalLayoutsMenu(state: AppViewState): void {
  const ts = state.terminalsState;
  if (!ts || !ts.showLayoutsMenu) return;
  ts.showLayoutsMenu = false;
  state.requestUpdate?.();
}

function tileToEntry(t: TerminalTile): TerminalPresetEntry {
  return { id: t.id, x: t.x, y: t.y, width: t.width, height: t.height, zIndex: t.zIndex, aspectRatio: t.aspectRatio };
}

export function saveTerminalLayoutPreset(state: AppViewState, name: string): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ensureTerminalTiles(state);
  const entries = ts.tiles.map(tileToEntry);
  terminalPresetStore.save(TERM_GRID_SCOPE, name, entries);
  ts.layoutPresets = terminalPresetStore.list(TERM_GRID_SCOPE);
  state.requestUpdate?.();
}

/**
 * Apply a saved preset positionally: terminal session ids are per-run, so the
 * preset's rects are zipped onto the current visible tiles by index. Extra
 * tiles beyond the preset keep their current placement.
 */
export function applyTerminalLayoutPreset(state: AppViewState, name: string): void {
  const ts = state.terminalsState;
  if (!ts) return;
  const preset = ts.layoutPresets.find((p) => p.name === name);
  if (!preset) return;
  ensureTerminalTiles(state);
  const visible = visibleTiles(ts);
  const assigned = new Map<string, TerminalPresetEntry>();
  visible.forEach((t, i) => {
    const entry = preset.entries[i];
    if (entry) assigned.set(t.id, entry);
  });
  ts.tiles = ts.tiles.map((t) => {
    const e = assigned.get(t.id);
    return e
      ? { ...t, x: e.x, y: e.y, width: e.width, height: e.height, zIndex: e.zIndex, aspectRatio: e.aspectRatio }
      : t;
  });
  ts.gridMaxZ = ts.tiles.reduce((m, t) => Math.max(m, t.zIndex), ts.gridMaxZ);
  ts.layoutCustomized = true;
  ts.showLayoutsMenu = false;
  saveTerminalLayout(ts);
  scheduleTerminalRefit(ts);
  state.requestUpdate?.();
}

export function deleteTerminalLayoutPreset(state: AppViewState, name: string): void {
  const ts = state.terminalsState;
  if (!ts) return;
  terminalPresetStore.remove(name, TERM_GRID_SCOPE);
  ts.layoutPresets = terminalPresetStore.list(TERM_GRID_SCOPE);
  state.requestUpdate?.();
}

// ── Helpers ──────────────────────────────────────────────────

function generateSessionId(): string {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateTitle(
  cli: CliType,
  index: number,
  opts?: { nodeId?: string; nodeName?: string; sessionId?: string },
): string {
  const config = CLI_CONFIGS[cli];
  const base = `${config.displayName} #${index + 1}`;
  const nodeId = opts?.nodeId;
  const remote = nodeId && nodeId !== "local";
  // Always append a 4-char tail of the session id so two spawns with the same
  // (cli, nodeId) at the same instant don't collide on title even if the index
  // race happens.
  const tail = opts?.sessionId ? `·${opts.sessionId.slice(-4)}` : "";
  if (remote) {
    const node = opts?.nodeName ?? nodeId;
    return `${base} @ ${node} ${tail}`.trim();
  }
  return tail ? `${base} ${tail}` : base;
}

function dismissSuccess(state: AppViewState): void {
  const ts = state.terminalsState;
  if (!ts) return;
  setTimeout(() => {
    if (ts) ts.successMessage = null;
    state.requestUpdate?.();
  }, 3000);
}

// ── Data Loading ─────────────────────────────────────────────

export async function loadTerminalsPage(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  ts.loading = true;
  ts.error = null;
  state.requestUpdate?.();

  try {
    const [projectsRes, tasksRes, sessionsRes] = await Promise.all([
      state.client.request<Array<{ id: string; name: string }>>("kanban.projects.list").catch(() => null),
      state.client.request<Array<{ id: string; title: string; projectId: string; status: string }>>("kanban.tasks.list").catch(() => null),
      state.client.request<{ sessions: Array<{ key: string; label?: string; agentId: string; status: string }> }>("sessions.list", { activeMinutes: 60, includeGlobal: false }).catch(() => null),
    ]);

    if (Array.isArray(projectsRes) && projectsRes.length > 0) {
      ts.projects = projectsRes;
    }
    if (Array.isArray(tasksRes) && tasksRes.length > 0) {
      ts.tasks = tasksRes;
    }
    if (sessionsRes?.sessions) {
      ts.agentSessions = sessionsRes.sessions.map((s: any) => ({
        key: s.key,
        label: s.label || s.derivedTitle || s.key,
        agentId: s.agentId || "unknown",
        status: s.status || "unknown",
      }));
    }

    await detectCLIVersions(state);

    // Federation node list must be loaded BEFORE restoreLiveTerminals so the
    // restorer can fan out to each satellite to fetch its terminal.list and
    // tag the rows with the right nodeId/nodeName.
    await loadFederationNodes(state);

    // Restore live terminals from the gateway (survives page refresh).
    // Now federation-aware — fetches terminals from each connected satellite
    // and merges them into ts.sessions so they reattach correctly.
    await restoreLiveTerminals(state);

    // Load system directory presets (Home, Desktop, Documents, …) — used by
    // the create dialog so the user can quickly spawn into a known location
    // without having to click through the folder browser every time.
    void loadSystemDirs(state);

    // Load the saved entries from the /directories registry so the git
    // panel and create dialog can show them in dropdowns. This now goes
    // through the federation aggregator so directories from any connected
    // device surface alongside local ones.
    void loadRegisteredDirs(state);

    // Federation node list already loaded above (synchronously, before
    // restoreLiveTerminals so it can use it). Nothing more to do here.

    // Install the page-level keyboard / fullscreen listeners once.
    installTerminalsPageListeners(state);

    // Note: Terminal events (terminal.output, terminal.exit) are handled
    // in app-gateway.ts handleGatewayEventUnsafe function
  } catch (err: any) {
    ts.error = err?.message || "Failed to load terminals data";
  } finally {
    ts.loading = false;
    state.requestUpdate?.();
  }
}

/**
 * Fetch the /directories registry across the federation. Tries the federated
 * aggregator first (so entries from connected satellites surface alongside
 * local ones); falls back to plain local directories.list if the federated
 * method isn't available on the gateway being talked to.
 */
export async function loadRegisteredDirs(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  // First try the federated method.
  try {
    const fed = await state.client.request<{ directories: any[] }>(
      "federation.resources.directories",
      {},
    );
    if (Array.isArray(fed?.directories)) {
      ts.registeredDirs = fed.directories.map((d: any) => ({
        id: String(d.id ?? `${d.sourceNode || "local"}:${d.path}`),
        name: String(d.name ?? d.path ?? ""),
        path: String(d.path ?? ""),
        icon: d.icon,
        agentId: d.agentId,
        projectId: d.projectId,
        sourceNode: d.sourceNode || "local",
        nodeName: d.nodeName,
        syncStatus: d.syncStatus,
      })).filter((d) => d.path);
      state.requestUpdate?.();
      return;
    }
  } catch (err) {
    console.warn("[terminals] federation.resources.directories failed, falling back:", err);
  }

  // Fallback: local-only registry.
  try {
    const result = await state.client.request<RegisteredDirEntry[]>(
      "directories.list",
      { active: true },
    );
    if (Array.isArray(result)) {
      ts.registeredDirs = result.map((d) => ({
        id: d.id,
        name: d.name,
        path: d.path,
        icon: d.icon,
        agentId: d.agentId,
        projectId: d.projectId,
        sourceNode: "local",
        nodeName: undefined,
        syncStatus: "synced" as const,
      }));
      state.requestUpdate?.();
    }
  } catch (err) {
    console.warn("[terminals] Failed to load registered directories:", err);
  }
}

/**
 * Load the list of federation nodes (local + connected satellites + mobile
 * devices). Powers the DEVICE selector in the create dialog, the per-card
 * node badges, and the per-panel terminal dropdowns in the grid.
 *
 * Queries both `federation.nodes.list` (the master-mode hub registry) and
 * `node.list` (mobile-paired devices). On satellite gateways the first call
 * is empty — but `node.list` still works, and vice versa for local-only
 * setups. Results are deduped by id.
 */
export async function loadFederationNodes(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;
  try {
    const [fedRes, mobileRes] = await Promise.all([
      state.client
        .request<{ nodes?: any[] }>("federation.nodes.list", {})
        .catch(() => null),
      state.client
        .request<{ nodes?: any[] }>("node.list", {})
        .catch(() => null),
    ]);
    const raw: any[] = [
      ...(Array.isArray(fedRes?.nodes) ? fedRes!.nodes : []),
      ...(Array.isArray(mobileRes?.nodes) ? mobileRes!.nodes : []),
    ];
    const seen = new Set<string>();
    const nodes: FederationNodeEntry[] = [];
    for (const n of raw) {
      const id = String(n?.id ?? n?.nodeId ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id,
        name: String(n.name ?? n.hostname ?? n.id ?? "Node"),
        isLocal: !!n.isLocal,
        online: n.status !== "offline",
        role: String(n.role ?? "satellite"),
        hostname: n.hostname,
        capabilities: n.capabilities,
      });
    }
    // Always include a "local" entry even if the gateway isn't part of a
    // federation — the user still wants to spawn locally without thinking
    // about it.
    if (!nodes.some((n) => n.isLocal)) {
      nodes.unshift({
        id: "local",
        name: "This Device",
        isLocal: true,
        online: true,
        role: "standalone",
        capabilities: {},
      });
    }
    ts.federationNodes = nodes;
    validateAndApplyFilterNode(ts, nodes);
    syncOllamaCliVersionForSelectedNode(ts, ts.createForm.nodeId || "local");
    state.requestUpdate?.();
  } catch (err) {
    // No federation hub or method not registered — that's fine, just
    // surface a single "local" entry so the selector still works.
    const fallbackNodes = [{
      id: "local",
      name: "This Device",
      isLocal: true,
      online: true,
      role: "standalone",
      capabilities: {},
    }];
    ts.federationNodes = fallbackNodes;
    validateAndApplyFilterNode(ts, fallbackNodes);
    syncOllamaCliVersionForSelectedNode(ts, ts.createForm.nodeId || "local");
    state.requestUpdate?.();
  }
}

export async function loadOllamaModelsForNode(
  state: AppViewState,
  nodeId: string,
  force = false,
): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;
  const key = nodeId || "local";
  const current = ts.ollamaModelsByNode[key];
  if (!force && current?.loading) return;
  if (!force && current?.loadedAt && Date.now() - current.loadedAt < 30_000) return;

  ts.ollamaModelsByNode[key] = {
    loading: true,
    models: current?.models ?? [],
    reason: current?.reason,
    loadedAt: current?.loadedAt,
  };
  state.requestUpdate?.();

  try {
    const res = await state.client.request<{ models?: OllamaModelEntry[]; reason?: string }>(
      "ollama.models.byNode",
      { nodeId: key },
    );
    const models = Array.isArray(res?.models)
      ? res.models
          .map((m) => ({
            ...m,
            name: String(m.name ?? m.model ?? ""),
            model: m.model ? String(m.model) : undefined,
          }))
          .filter((m) => m.name)
      : [];
    ts.ollamaModelsByNode[key] = {
      loading: false,
      models,
      reason: res?.reason,
      loadedAt: Date.now(),
    };
    if (!ts.createForm.model && (ts.createForm.nodeId || "local") === key && models[0]) {
      ts.createForm.model = models[0].name;
    }
  } catch {
    ts.ollamaModelsByNode[key] = {
      loading: false,
      models: [],
      reason: "ollama unreachable",
      loadedAt: Date.now(),
    };
  }
  state.requestUpdate?.();
}

/**
 * Set gitCwd and immediately reload git status. Used by the dropdown.
 */
export async function pickGitCwd(state: AppViewState, dirPath: string): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !dirPath) return;
  ts.gitCwd = dirPath;
  state.requestUpdate?.();
  await loadGitStatus(state);
}

/**
 * Fetch the gateway's list of common system directories. Best-effort — if it
 * fails we just leave the preset row empty.
 */
export async function loadSystemDirs(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;
  try {
    const result = await state.client.request<{
      dirs: SystemDirEntry[];
      recents?: SystemDirEntry[];
    }>("fs.systemDirs", { recents: ts.recentDirs });
    if (Array.isArray(result?.dirs)) {
      ts.systemDirs = [...result.dirs, ...(Array.isArray(result.recents) ? result.recents : [])];
      state.requestUpdate?.();
    }
  } catch (err) {
    console.warn("[terminals] Failed to load system dirs:", err);
  }
}

let _terminalsPageListenersInstalled = false;
function installTerminalsPageListeners(state: AppViewState): void {
  if (_terminalsPageListenersInstalled) return;
  _terminalsPageListenersInstalled = true;

  // ESC: collapse any expanded card, then exit page fullscreen.
  // We only act when ESC was NOT directed at an xterm — otherwise vim,
  // less, ctrl-c menus etc. inside the shell would lose their escapes.
  // Shift+Esc always escapes the chrome (pulls focus out of xterm).
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const ts = state.terminalsState;
    if (!ts) return;
    const target = e.target as Element | null;
    const insideXterm = !!target?.closest?.(".xterm, .xterm-screen, .xterm-helper-textarea");
    if (insideXterm && !e.shiftKey) return;

    const expanded = ts.sessions.find((s) => s.expandedView);
    if (expanded) {
      expanded.expandedView = false;
      state.requestUpdate?.();
      setTimeout(() => getXtermInstance(expanded.id)?.fit(), 80);
      return;
    }
    if (ts.pageFullscreen && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => { /* ignore */ });
    }
  });

  // Track real fullscreen state — the user can also exit via F11/native UI.
  document.addEventListener("fullscreenchange", () => {
    const ts = state.terminalsState;
    if (!ts) return;
    ts.pageFullscreen = !!document.fullscreenElement;
    state.requestUpdate?.();
    // Refit every terminal after the viewport changes shape.
    setTimeout(() => {
      ts.sessions.forEach((s) => getXtermInstance(s.id)?.fit());
    }, 120);
  });

  // Close the topbar registered-directories dropdown when the user clicks
  // anywhere outside it. The dropdown stops propagation on its own clicks.
  document.addEventListener("click", () => {
    const ts = state.terminalsState;
    if (ts?.showDirsDropdown) {
      ts.showDirsDropdown = false;
      state.requestUpdate?.();
    }
  });
}

/**
 * Toggle browser fullscreen on the terminals page. We target the .term-page
 * element so the chrome (sidebar / topbar) is hidden but the in-page topbar
 * stays — that's where the fullscreen-exit button lives.
 */
export async function togglePageFullscreen(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts) return;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    const target =
      (document.querySelector(".term-page") as HTMLElement | null) ?? document.documentElement;
    await target.requestFullscreen();
  } catch (err: any) {
    ts.error = err?.message || "Fullscreen not available in this browser";
    state.requestUpdate?.();
  }
}

/**
 * Restore live terminals from the gateway.
 * On page refresh, the PTY processes are still running on the server.
 * We re-create the UI sessions for any that are still alive.
 */
async function restoreLiveTerminals(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  // Each entry: { lt, nodeId, nodeName }. nodeId === "local" for the master.
  type RemoteLT = { lt: any; nodeId: string; nodeName?: string };
  const collected: RemoteLT[] = [];

  // Local terminals (master gateway).
  try {
    const result = await state.client.request<{ terminals: any[] }>("terminal.list", {});
    for (const lt of result?.terminals || []) {
      collected.push({ lt, nodeId: "local" });
    }
  } catch (err) {
    console.warn("[terminals] Failed to fetch local terminals:", err);
  }

  // Federation satellites — fan out terminal.list to each online remote node
  // via federation.node.invoke. Without this, a federation-spawned terminal
  // disappears from the UI on every page reload (the PTY is still alive on
  // the satellite, but the UI has no row pointing at it).
  const remoteNodes = ts.federationNodes.filter((n) => !n.isLocal && n.online !== false);
  await Promise.all(
    remoteNodes.map(async (node) => {
      try {
        const res = (await state.client!.request("federation.node.invoke", {
          nodeId: node.id,
          method: "terminal.list",
          params: {},
        })) as { status?: string; payload?: { terminals?: any[] } } | undefined;
        if (res?.status !== "ok") return;
        for (const lt of res.payload?.terminals ?? []) {
          collected.push({ lt, nodeId: node.id, nodeName: node.name });
        }
      } catch (err) {
        console.warn(`[terminals] Failed to fetch terminals from ${node.id}:`, err);
      }
    }),
  );

  // ── Unified reattachable list ────────────────────────────────────────────
  // terminal.list is in-memory only, so after a gateway restart it omits the
  // `spawn-*` cloud/codex agent panes (owned by the subagent registry) and can
  // race CLI reconciliation. terminal.listReattachable queries tmux directly
  // and classifies every live pane, each with a reattach directive. Fetch it
  // per node (local + online satellites) the same way we fan out terminal.list.
  type ReattachEntry = {
    id: string;
    kind: "cloud" | "codex" | "cli" | "shell";
    backend?: string;
    label: string;
    runId?: string;
    agentId?: string;
    sessionKey?: string;
    cwd: string;
    reattach: { method: string; params: Record<string, unknown> };
  };
  const reattachable: Array<{ e: ReattachEntry; nodeId: string; nodeName?: string }> = [];
  try {
    const localRes = await state.client.request<{ entries?: ReattachEntry[] }>(
      "terminal.listReattachable",
      {},
    );
    for (const e of localRes?.entries ?? []) reattachable.push({ e, nodeId: "local" });
  } catch (err) {
    console.warn("[terminals] terminal.listReattachable (local) failed:", err);
  }
  await Promise.all(
    remoteNodes.map(async (node) => {
      try {
        const res = (await state.client!.request("federation.node.invoke", {
          nodeId: node.id,
          method: "terminal.listReattachable",
          params: { nodeId: node.id },
        })) as { status?: string; payload?: { entries?: ReattachEntry[] } } | undefined;
        if (res?.status !== "ok") return;
        for (const e of res.payload?.entries ?? [])
          reattachable.push({ e, nodeId: node.id, nodeName: node.name });
      } catch (err) {
        console.warn(`[terminals] listReattachable from ${node.id} failed:`, err);
      }
    }),
  );

  const terminalKey = (id: unknown, nodeId: unknown): string =>
    `${String(nodeId || "local")}::${String(id || "")}`;
  const existingIds = new Set(ts.sessions.map((s) => terminalKey(s.id, s.nodeId)));
  for (const { lt, nodeId, nodeName } of collected) {
    const key = terminalKey(lt.id, nodeId);
    if (!lt.id || existingIds.has(key)) continue;

    let cli: CliType = "shell";
    if (lt.isClaudeMode || lt.cliType === "claude") cli = "claude";
    else if (lt.cliType === "opencode") cli = "opencode";
    else if (lt.cliType === "gemini") cli = "gemini";
    else if (lt.cliType === "codex") cli = "codex";
    else if (lt.cliType === "grok") cli = "grok";
    else if (lt.cliType === "ollama") cli = "ollama";
    else if (lt.activeCLI) cli = lt.activeCLI as CliType;

    const session: TerminalSession = {
      id: lt.id,
      title:
        lt.title ||
        generateTitle(
          cli,
          ts.sessions.filter((s) => s.cli === cli && (s.nodeId ?? "local") === nodeId).length,
          { nodeId, nodeName, sessionId: lt.id },
        ),
      cli,
      status: "running",
      projectId: lt.projectPath || undefined,
      model: typeof lt.model === "string" ? lt.model : undefined,
      cwd: lt.cwd || ".",
      createdAt: lt.createdAt || new Date().toISOString(),
      expandedView: false,
      // Restoring nodeId/nodeName is what makes subsequent terminal.write /
      // terminal.resize / terminal.destroy go to the right device. Without
      // these the UI silently routes everything to the local gateway and
      // remote PTYs can't be driven.
      nodeId,
      nodeName,
    };

    ts.sessions.push(session);
    existingIds.add(key);
  }

  // Merge reattachable entries the in-memory terminal.list didn't surface —
  // chiefly the cloud/codex `spawn-*` agent panes. Enrich a matching existing
  // row with its reattach directive, else add a new running session carrying
  // the directive so handleTerminalReady rebinds the live tmux pane on mount.
  const kindToCli: Record<ReattachEntry["kind"], CliType> = {
    cloud: "claude",
    codex: "codex",
    cli: "claude",
    shell: "shell",
  };
  for (const { e, nodeId, nodeName } of reattachable) {
    const canonicalEntryId = canonicalPtyId(e.id);
    const existing = ts.sessions.find(
      (s) =>
        canonicalPtyId(ptyIdOf(s)) === canonicalEntryId &&
        (s.nodeId ?? "local") === nodeId,
    );
    if (existing) {
      existing.reattach = e.reattach;
      if (e.runId) existing.runId = e.runId;
      if (e.agentId) existing.agentId = e.agentId;
      if (e.kind === "cloud" || e.kind === "codex") existing.isSubagent = true;
      continue;
    }
    const key = terminalKey(e.id, nodeId);
    if (!e.id || existingIds.has(key)) continue;
    // Map backend → the view's CLI badge when it's a known agent CLI.
    let cli: CliType = kindToCli[e.kind];
    if (e.backend === "opencode") cli = "opencode";
    else if (e.backend === "gemini") cli = "gemini";
    else if (e.backend === "codex") cli = "codex";
    else if (e.backend === "grok") cli = "grok";
    ts.sessions.push({
      id: e.id,
      title: e.label,
      cli,
      status: "running",
      sessionKey: e.sessionKey,
      cwd: e.cwd || ".",
      createdAt: new Date().toISOString(),
      expandedView: false,
      isSubagent: e.kind === "cloud" || e.kind === "codex",
      runId: e.runId,
      agentId: e.agentId,
      nodeId: nodeId === "local" ? "local" : nodeId,
      nodeName,
      reattach: e.reattach,
    });
    existingIds.add(key);
  }

  // Clean up duplicate rows left by older restores, including old mirror
  // panels whose UI id differs but whose backing PTY is the same.
  ts.sessions = dedupeTerminalSessions(ts.sessions);

  // A fresh page reflects real gateway PTYs only. Previously, every dead cell
  // from localStorage was resurrected as a placeholder card, which made closed
  // terminals reappear beside their live replacement and look duplicated.

  if (!ts.activeSessionId && ts.sessions.length > 0) {
    ts.activeSessionId = ts.sessions[0].id;
  }

  // Map any restored / placeholder sessions that have no workspace assignment
  // yet (e.g. spawned before this feature, or on another device) and prune
  // stale entries.
  reconcileWorkspaces(ts);

  state.requestUpdate?.();
}

export async function detectCLIVersions(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  const cliKeys = ["claude", "opencode", "gemini", "codex", "grok"] as const;

  for (const key of cliKeys) {
    const config = CLI_CONFIGS[key];
    try {
      const result = await state.client.request<{ stdout?: string; exitCode?: number }>("exec.run", {
        command: `${config.command} ${config.versionFlag}`,
        timeout: 5,
      });
      if (result?.stdout) {
        const version = result.stdout.trim().split("\n")[0];
        ts.cliVersions[key] = { installed: version };
      } else {
        ts.cliVersions[key] = { installed: null };
      }
    } catch {
      ts.cliVersions[key] = { installed: null };
    }
  }

  state.requestUpdate?.();
}

// ── Session Management ───────────────────────────────────────

/** Spawn a single terminal session locally — does not reset the dialog form. */
function spawnSingleSession(
  state: AppViewState,
  ts: TerminalsState,
  args: {
    cli: CliType;
    cwd: string;
    name?: string;
    projectId?: string;
    taskId?: string;
    model?: string;
    nodeId?: string;
  },
): TerminalSession {
  const sessionId = generateSessionId();
  const nodeId = args.nodeId && args.nodeId !== "" ? args.nodeId : "local";
  const nodeName = ts.federationNodes.find((n) => n.id === nodeId)?.name;
  // Count siblings on the same (cli, nodeId) so the #N counter stays scoped to
  // the node, instead of sliding when sessions from other devices appear.
  const existingCount = ts.sessions.filter(
    (s) => s.cli === args.cli && (s.nodeId ?? "local") === nodeId,
  ).length;
  const title =
    args.name || generateTitle(args.cli, existingCount, { nodeId, nodeName, sessionId });
  const session: TerminalSession = {
    id: sessionId,
    title,
    cli: args.cli,
    status: "idle",
    projectId: args.projectId,
    taskId: args.taskId,
    model: args.model,
    cwd: args.cwd,
    createdAt: new Date().toISOString(),
    expandedView: false,
    nodeId,
    nodeName,
  };
  ts.sessions = [...ts.sessions, session];
  ts.activeSessionId = sessionId;
  return session;
}

/**
 * Create one or more terminal sessions. When `count > 1` (or `oneOfEachCli`
 * is set in the create form), this spawns multiple terminals in the same
 * directory as a batch. The first newly-created session becomes active.
 */
export async function createTerminalSession(
  state: AppViewState,
  opts?: {
    cli?: CliType;
    cwd?: string;
    name?: string;
    projectId?: string;
    taskId?: string;
    model?: string;
    /** Override count; defaults to ts.createForm.count (or 1). */
    count?: number;
    /** Override oneOfEachCli mode; defaults to ts.createForm.oneOfEachCli. */
    oneOfEachCli?: boolean;
    /** Federation node to spawn on. "local" or undefined = this device. */
    nodeId?: string;
  },
): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  const cli = opts?.cli ?? ts.createForm.cli;
  const cwd = opts && Object.prototype.hasOwnProperty.call(opts, "cwd")
    ? (opts.cwd ?? "")
    : (ts.createForm.cwd || ".");
  const name = opts?.name || ts.createForm.name || "";
  const projectId = opts?.projectId || ts.createForm.projectId || undefined;
  const taskId = opts?.taskId || ts.createForm.taskId || undefined;
  const model = opts?.model || ts.createForm.model || undefined;
  const oneOfEachCli = opts?.oneOfEachCli ?? ts.createForm.oneOfEachCli;
  const requestedCount = Math.max(1, Math.floor(opts?.count ?? ts.createForm.count ?? 1));
  const nodeId = (opts?.nodeId ?? ts.createForm.nodeId ?? "local") || "local";

  // Cross-device spawn: with the federation gateway proxy in place,
  // `terminal.create` / `terminal.write` / `terminal.resize` are routed to
  // the satellite's local gateway and `terminal.output` is streamed back
  // through `event.broadcast`. So the regular spawn flow below handles
  // remote PTYs uniformly — we just need to pre-flight that the chosen
  // node is actually online before we let the user wait on a dead pipe.
  if (nodeId !== "local") {
    const node = ts.federationNodes.find((n) => n.id === nodeId);
    if (!node || node.online === false) {
      ts.error = `Federation node "${node?.name ?? nodeId}" is offline — can't spawn there right now.`;
      state.requestUpdate?.();
      return;
    }
    ts.error = null;
  }

  // Decide which CLIs to spawn.
  const cliBatch: CliType[] = oneOfEachCli
    ? (["shell", "claude", "opencode", "gemini", "codex", "grok"] as CliType[])
    : Array.from({ length: requestedCount }, () => cli);

  // Cap at maxSessions; partial spawns are allowed so the user always gets
  // *something* even if their batch overflows the cap.
  const headroom = Math.max(0, ts.maxSessions - ts.sessions.length);
  if (headroom === 0) {
    ts.error = `Maximum ${ts.maxSessions} sessions reached — close one to spawn more.`;
    state.requestUpdate?.();
    return;
  }
  const trimmed = cliBatch.slice(0, headroom);
  const dropped = cliBatch.length - trimmed.length;

  const created: TerminalSession[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    // Only the first session in the batch gets the user-typed name —
    // subsequent ones fall back to the auto-generated "<CLI> #N" title.
    const useName = i === 0 ? name : undefined;
    const session = spawnSingleSession(state, ts, {
      cli: trimmed[i],
      cwd,
      name: useName,
      projectId,
      taskId,
      model: trimmed[i] === "ollama" ? model : undefined,
      nodeId,
    });
    created.push(session);
  }

  // Bucket each new terminal into a workspace (active first, spilling into the
  // next numbered workspace once a workspace hits 6), then switch focus to
  // wherever the batch ended up — matching the /grid page's addCanvas, which
  // auto-switches to a newly created workspace.
  let landed = ts.activeWorkspace;
  for (const s of created) landed = assignSessionWorkspace(ts, s.id);
  if (landed !== ts.activeWorkspace) switchTerminalWorkspace(state, landed);
  else saveWorkspaceState(ts);

  ts.showCreateDialog = false;

  // Remember the cwd so the preset row shows it in future spawns.
  if (cwd && cwd !== ".") rememberRecentDir(state, cwd);

  // Reset the create form back to its defaults — the count/oneOfEach toggles
  // included so the dialog doesn't surprise the user next time.
  ts.createForm = {
    cli: "shell",
    cwd: "",
    name: "",
    projectId: "",
    taskId: "",
    model: "",
    count: 1,
    oneOfEachCli: false,
    nodeId: ts.createForm.nodeId || "local",
  };

  if (created.length === 0) {
    ts.error = "No terminals were spawned.";
  } else if (created.length === 1) {
    ts.successMessage = `Terminal "${created[0].title}" created`;
  } else {
    ts.successMessage = `${created.length} terminals spawned in ${cwd}` +
      (dropped > 0 ? ` (capped — ${dropped} skipped, max ${ts.maxSessions})` : "");
  }
  dismissSuccess(state);
  state.requestUpdate?.();

  // Note: PTY creation happens when xterm is mounted and reports dimensions
}

/**
 * Quick-batch spawn from anywhere — used by the topbar registered-dirs
 * dropdown to fire off N terminals into a known directory in one click.
 * Auto-detects whether the picked directory belongs to a remote federation
 * node and forwards the nodeId so the right device handles the spawn.
 */
export async function spawnBatchInDirectory(
  state: AppViewState,
  dirPath: string,
  opts?: { count?: number; cli?: CliType; oneOfEachCli?: boolean; nodeId?: string },
): Promise<void> {
  const ts = state.terminalsState;
  // Look up which node this path belongs to in the federated registry.
  // If we can't find an exact match, default to local — the user is then
  // typing a custom path which we assume is local-mounted.
  let nodeId = opts?.nodeId;
  if (!nodeId && ts) {
    const match = ts.registeredDirs.find((d) => d.path === dirPath);
    nodeId = match?.sourceNode || "local";
  }
  await createTerminalSession(state, {
    cwd: dirPath,
    cli: opts?.cli ?? "shell",
    count: opts?.count ?? 1,
    oneOfEachCli: opts?.oneOfEachCli ?? false,
    nodeId,
  });
}

export async function closeTerminalSession(state: AppViewState, id: string): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  const session = ts.sessions.find((s) => s.id === id);
  if (!session) return;

  // Reference-counted teardown. A PTY may be shown in several panels (mirrors)
  // — possibly across different workspaces. Closing ONE panel must only detach
  // that panel's view; the backing PTY is destroyed only when the LAST panel
  // referencing it is closed. Count OTHER live panels sharing this PTY id.
  const ptyId = ptyIdOf(session);
  const otherRefs = ts.sessions.filter(
    (s) => s.id !== id && !s.isPlaceholder && ptyIdOf(s) === ptyId,
  ).length;
  const isLastRef = otherRefs === 0;

  // Destroy PTY process only when this was the last reference (placeholders have
  // no live PTY, so skip the round-trip entirely).
  if (!session.isPlaceholder && isLastRef) {
    await destroyPtyProcess(state.client, ptyId, session.nodeId);
  }

  // Dispose only THIS panel's xterm instance (keyed by panel id, not ptyId), so
  // surviving mirrors keep their live view.
  unregisterXtermInstance(id);

  ts.sessions = ts.sessions.filter((s) => s.id !== id);
  reindexPtyPanels(ts);
  if (ts.activeSessionId === id) {
    ts.activeSessionId = ts.sessions.length > 0 ? ts.sessions[ts.sessions.length - 1].id : null;
  }

  // Free the workspace slot. We leave an emptied workspace in place (no
  // auto-collapse) — same as the /grid page keeps its tabs around.
  delete ts.sessionWorkspace[id];
  ts.workspaceTilePool = ts.workspaceTilePool.filter((t) => t.id !== id);
  if (ts.sendMenuForId === id) ts.sendMenuForId = null;
  saveWorkspaceState(ts);

  ts.successMessage = isLastRef
    ? `Terminal "${session.title}" closed`
    : `Detached "${session.title}" — session still running in another panel`;
  dismissSuccess(state);
  state.requestUpdate?.();
}

/**
 * Duplicate a panel so the SAME underlying terminal session is mirrored in a
 * second panel. The new panel gets its own id/tile but shares the source's PTY
 * via `ptyId`, so both stream the same output and either can drive input.
 * Closing one only detaches it (reference counting) — the PTY dies only when
 * the last mirror is closed. The mirror lands in the source's workspace.
 */
export function duplicateTerminalSession(state: AppViewState, id: string): void {
  const ts = state.terminalsState;
  if (!ts) return;
  const src = ts.sessions.find((s) => s.id === id);
  if (!src || src.isPlaceholder) return;

  if (ts.sessions.length >= ts.maxSessions) {
    ts.error = `Maximum ${ts.maxSessions} sessions reached — close one to mirror more.`;
    state.requestUpdate?.();
    return;
  }

  const newId = generateSessionId();
  const dup: TerminalSession = {
    ...src,
    id: newId,
    ptyId: ptyIdOf(src), // share the source's backing PTY
    title: `${src.title} (mirror)`,
    expandedView: false,
    isPlaceholder: false,
    // A mirror never re-binds the source's spawn-agent pane on mount.
    reattach: undefined,
  };
  ts.sessions = [...ts.sessions, dup];
  // Mirror lives beside its source, in the same workspace.
  ts.sessionWorkspace[newId] = workspaceOf(ts, id);
  ts.activeSessionId = newId;
  reindexPtyPanels(ts);
  ts.sendMenuForId = null;

  // Lay out a tile for the new panel in the active workspace (ensureTerminalTiles
  // only arranges the active workspace's sessions, which is where the source is).
  ensureTerminalTiles(state);
  saveWorkspaceState(ts);

  ts.successMessage = `Mirrored "${src.title}" — closing one panel keeps the session alive`;
  dismissSuccess(state);
  state.requestUpdate?.();
}

/**
 * Move a panel to another numbered workspace WITHOUT touching its terminal
 * session. The PTY stays alive; only the panel's workspace assignment + tile
 * placement move. `target` may be `workspaceCount + 1` (or any higher number)
 * to create and send to a brand-new numbered workspace. The panel disappears
 * from the source workspace and appears in the destination on switch.
 */
export function sendTerminalToWorkspace(state: AppViewState, id: string, target: number): void {
  const ts = state.terminalsState;
  if (!ts) return;
  const session = ts.sessions.find((s) => s.id === id);
  if (!session) return;

  let tgt = Math.floor(target);
  if (!Number.isFinite(tgt) || tgt < 1) tgt = 1;
  // Sending beyond the current count grows the workspace set (the "New" option).
  if (tgt > ts.workspaceCount) ts.workspaceCount = tgt;

  const current = workspaceOf(ts, id);
  if (tgt === current) {
    ts.sendMenuForId = null;
    state.requestUpdate?.();
    return;
  }

  // Re-parent the panel to the target workspace.
  ts.sessionWorkspace[id] = tgt;

  // Move its tile (preserving geometry) between the active working set and the
  // inactive pool so the layout engine only ever operates on the active set.
  const tile =
    ts.tiles.find((t) => t.id === id) || ts.workspaceTilePool.find((t) => t.id === id);
  ts.tiles = ts.tiles.filter((t) => t.id !== id);
  ts.workspaceTilePool = ts.workspaceTilePool.filter((t) => t.id !== id);
  if (tile) {
    if (tgt === ts.activeWorkspace) ts.tiles.push(tile);
    else ts.workspaceTilePool.push(tile);
  }

  // If the moved panel was the focused one and it left the visible workspace,
  // hand focus to another panel still in view.
  if (ts.activeSessionId === id && tgt !== ts.activeWorkspace) {
    const remaining = sessionsInWorkspace(ts, ts.activeWorkspace);
    ts.activeSessionId = remaining.length ? remaining[remaining.length - 1].id : null;
  }

  ts.sendMenuForId = null;
  ts.successMessage = `Sent "${session.title}" to workspace ${tgt}`;
  dismissSuccess(state);
  saveWorkspaceState(ts);
  saveTerminalLayout(ts);
  state.requestUpdate?.();
}

/** Open/close the "send to workspace" popover for a given panel. */
export function toggleSendMenu(
  state: AppViewState,
  id: string | null,
  anchor?: { x: number; y: number } | null,
): void {
  const ts = state.terminalsState;
  if (!ts) return;
  const opening = ts.sendMenuForId !== id;
  ts.sendMenuForId = opening ? id : null;
  ts.sendMenuAnchor = opening ? (anchor ?? null) : null;
  state.requestUpdate?.();
}

/**
 * Reconnect a terminal that has disconnected or gone blank.
 * Disposes the current xterm instance (if any) so the Lit directive
 * reinitialises it on the next render, which triggers handleTerminalReady
 * to re-attach to the running PTY (or spawn a new one if it exited).
 */
export function reconnectTerminalSession(state: AppViewState, id: string): void {
  const ts = state.terminalsState;
  const session = ts?.sessions.find((s) => s.id === id);
  if (!session) return;
  // Clearing the placeholder flag lets the xterm directive mount; resetting the
  // status makes handleTerminalReady attempt a fresh PTY creation / re-attach.
  session.isPlaceholder = false;
  if (session.status === "exited") session.status = "idle";
  // Dispose current xterm — unregisterXtermInstance also clears pendingOutputQueues.
  // The directive detects this (this.terminal becomes null) and re-inits on the
  // next render cycle triggered by requestUpdate below.
  unregisterXtermInstance(id);
  state.requestUpdate?.();
}

export async function handleTerminalReady(
  state: AppViewState,
  terminalId: string,
  cols: number,
  rows: number
): Promise<void> {
  const ts = state.terminalsState;
  const session = ts?.sessions.find(s => s.id === terminalId);
  if (!ts || !state.client || !session) return;

  // A panel may be a *mirror* of another panel's PTY (see duplicateTerminalSession).
  // The xterm instance stays keyed by the panel `terminalId`, but every PTY-facing
  // call must target the shared backing PTY id.
  const ptyId = ptyIdOf(session);
  const isMirror = ptyId !== terminalId;

  // Resolve the federation node — for remote PTYs, all the gateway calls
  // below are routed through `federation.node.invoke` automatically.
  const nodeId = session.nodeId && session.nodeId !== "" ? session.nodeId : "local";
  const isRemote = nodeId !== "local";
  const callTerminal = async <T>(method: string, params: Record<string, unknown>): Promise<T | null> => {
    if (isRemote) {
      try {
        const res = (await state.client!.request("federation.node.invoke", {
          nodeId,
          method,
          params,
        })) as { status?: string; payload?: T; error?: string };
        if (res?.status !== "ok") return null;
        return (res.payload ?? null) as T | null;
      } catch {
        return null;
      }
    }
    return (await state.client!.request<T>(method, params)) ?? null;
  };

  // Reattach cloud/codex agent panes first. These `spawn-*` sessions are owned
  // by the subagent registry and are NOT in the gateway's in-memory terminal
  // map after a restart, so terminal.isAlive would report false and we'd spawn
  // a fresh PTY (losing the running agent). terminal.reattachSpawnAgent rebinds
  // the existing tmux pane without re-invoking the CLI; it's idempotent, so a
  // pane already recovered by boot is a cheap no-op.
  if (!isMirror && session.reattach?.method === "terminal.reattachSpawnAgent") {
    try {
      await callTerminal("terminal.reattachSpawnAgent", session.reattach.params);
    } catch {
      /* best-effort — fall through to the isAlive/create path below */
    }
  }

  // Check if PTY is already running (restored from gateway after page refresh,
  // or — for a mirror — created by the source panel). Keyed on the backing PTY.
  try {
    const aliveResult = await callTerminal<{ alive: boolean }>("terminal.isAlive", { id: ptyId });
    if (aliveResult?.alive) {
      // PTY exists — resize, replay the gateway-side output buffer so the
      // user sees what they were looking at before the refresh, then attach.
      session.status = "running";
      await resizePtyProcess(state.client, ptyId, cols, rows, nodeId);
      const xterm = getXtermInstance(terminalId);
      if (xterm) {
        try {
          const bufRes = await callTerminal<{ buffer?: string }>(
            "terminal.getBuffer",
            { id: ptyId },
          );
          const buffer = bufRes?.buffer ?? "";
          if (buffer) xterm.write(buffer);
        } catch {
          /* buffer fetch is best-effort; proceed even if it fails */
        }
        xterm.writeln(
          `\r\n\x1b[32m✓\x1b[0m ${isMirror ? "Mirrored" : "Reconnected to"} terminal - ${CLI_CONFIGS[session.cli].displayName}`,
        );
        xterm.writeln(`\x1b[90mWorking directory: ${session.cwd}\x1b[0m`);
      }
      state.requestUpdate?.();
      return;
    }
  } catch {
    // isAlive check failed — proceed with creating new PTY
  }

  // A mirror never spawns its own PTY — it only ever attaches to the source's.
  // If the shared PTY is gone (the source exited), surface it as exited so the
  // user can Reattach/close, rather than resurrecting a duplicate process.
  if (isMirror) {
    session.status = "exited";
    const xterm = getXtermInstance(terminalId);
    if (xterm) {
      xterm.writeln(`\r\n\x1b[90mMirrored session is no longer running.\x1b[0m`);
    }
    state.requestUpdate?.();
    return;
  }

  // Create PTY process now that we have dimensions. We forward cliType so
  // the gateway can register a SessionEntry for agent CLIs (claude/opencode/
  // gemini) and a sessionKey so the InfiniBot MCP server inside the PTY can
  // attribute its tool calls. The session key shape mirrors how the gateway
  // auto-derives it: `agent:main:terminal-<terminalId>`.
  const sessionKeyForTerminal =
    session.cli !== "shell" ? `agent:main:terminal-${ptyId}` : undefined;
  await createPtyProcess(state.client, {
    terminalId: ptyId,
    cwd: session.cwd,
    projectPath: session.projectId,
    cols,
    rows,
    cliType: session.cli,
    sessionKey: sessionKeyForTerminal,
    nodeId,
    onCreated: () => {
      session.status = "running";
      const xterm = getXtermInstance(terminalId);
      if (xterm) {
        xterm.writeln(`\x1b[32m✓\x1b[0m Terminal ready - ${CLI_CONFIGS[session.cli].displayName}`);
        xterm.writeln(`\x1b[90mWorking directory: ${session.cwd}\x1b[0m`);
      }
      state.requestUpdate?.();

      // Auto-invoke CLI if not a plain shell
      if (session.cli !== "shell" && state.client) {
        autoInvokeCLI(state, terminalId, session.cli);
      }
    },
    onError: (error) => {
      session.status = "exited";
      const xterm = getXtermInstance(terminalId);
      if (xterm) {
        xterm.writeln(`\r\n\x1b[31mError: ${error}\x1b[0m`);
      }
      state.requestUpdate?.();
    },
  });
}

export async function handleTerminalInput(
  state: AppViewState,
  terminalId: string,
  data: string
): Promise<void> {
  if (!state.client) return;
  const session = state.terminalsState?.sessions.find((s) => s.id === terminalId);
  const ptyId = session ? ptyIdOf(session) : terminalId;
  await sendPtyInput(state.client, ptyId, data, session?.nodeId);
}

export async function handleTerminalResize(
  state: AppViewState,
  terminalId: string,
  cols: number,
  rows: number
): Promise<void> {
  if (!state.client) return;
  const session = state.terminalsState?.sessions.find((s) => s.id === terminalId);
  const ptyId = session ? ptyIdOf(session) : terminalId;
  await resizePtyProcess(state.client, ptyId, cols, rows, session?.nodeId);
}

// ── Auto CLI Invocation ──────────────────────────────────────

/**
 * Auto-invoke a CLI tool in a terminal after PTY creation.
 * Waits briefly for the shell prompt, then sends the CLI command.
 */
async function autoInvokeCLI(state: AppViewState, terminalId: string, cli: CliType): Promise<void> {
  if (!state.client || cli === "shell") return;

  const ts = state.terminalsState;
  const session = ts?.sessions.find(s => s.id === terminalId);
  const nodeId = session?.nodeId && session.nodeId !== "" ? session.nodeId : "local";
  const isRemote = nodeId !== "local";

  // Print an immediate "starting" line so the user sees the terminal is
  // alive while the CLI's first frame renders. Without this, claude/gemini
  // can leave xterm visually blank for 1-2 seconds during their boot phase
  // and users assume something's broken.
  const xterm = getXtermInstance(terminalId);
  const cfg = CLI_CONFIGS[cli];
  if (xterm && cfg) {
    xterm.writeln(`\x1b[90mStarting ${cfg.displayName}…\x1b[0m`);
  }

  // Give the shell a moment to initialize and show prompt before piping the
  // CLI command in. Remote PTYs go through the federation pipe so allow a
  // tiny extra slack; local PTYs need just enough for a prompt.
  await new Promise(resolve => setTimeout(resolve, isRemote ? 1100 : 600));

  // UI-spawned Claude terminals run as the operator's orchestrator: they drive
  // the conversation and hand heavy work to InfiniBot sub-agents over MCP. The
  // gateway appends the MCP orchestrator preamble via --append-system-prompt.
  // Other CLIs (codex/opencode/gemini) don't accept that flag and stay vanilla.
  // Sub-agent spawns coming through claude_coder / codex_coder / opencode_coder
  // hit terminal.spawnAgent directly and DO NOT set this flag — they stay raw.
  const cliOptions =
    cli === "claude"
      ? { orchestrator: true }
      : cli === "ollama" && session?.model
        ? { model: session.model }
        : {};

  const invokeViaFederation = async () => {
    const res = (await state.client!.request("federation.node.invoke", {
      nodeId,
      method: "terminal.agent.invoke",
      params: { id: terminalId, cli, options: cliOptions },
    })) as { status?: string; error?: string };
    if (res?.status !== "ok") {
      throw new Error(res?.error || "remote terminal.agent.invoke failed");
    }
  };

  try {
    if (isRemote) {
      await invokeViaFederation();
    } else {
      await state.client.request("terminal.agent.invoke", {
        id: terminalId,
        cli,
        options: cliOptions,
      });
    }
    if (session) {
      session.status = "claude-active";
      state.requestUpdate?.();
    }
  } catch (err: any) {
    // Fallback: type the command directly into the PTY. sendPtyInput honours
    // the session's nodeId, so remote PTYs receive the keystrokes through
    // federation just like local ones.
    const command = cfg?.command;
    if (command) {
      try {
        await sendPtyInput(state.client, terminalId, `${command}\r`, nodeId);
        if (session) {
          session.status = "claude-active";
          state.requestUpdate?.();
        }
      } catch {
        console.warn(`[terminals] Failed to auto-invoke ${cli}:`, err?.message);
      }
    }
  }
}

/**
 * Quick-launch a terminal with a specific CLI — one click, no dialog.
 * If browseCwd is true, opens Windows folder browser first.
 */
export async function quickLaunchTerminal(
  state: AppViewState,
  cli: CliType,
  cwd?: string,
  browseCwd = false,
): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  let targetCwd = cwd;
  const homeDir = ts.systemDirs.find((d) => d.key === "home")?.path;
  const projectDir = ts.systemDirs.find((d) => d.key === "project")?.path;

  // If browse requested, open native folder dialog
  if (browseCwd) {
    try {
      const result = await state.client.request<{ cancelled: boolean; path: string | null }>(
        "fs.browseFolder",
        { initialDir: targetCwd || homeDir || "" },
      );
      if (result?.cancelled || !result?.path) return; // User cancelled
      targetCwd = result.path;
      rememberRecentDir(state, targetCwd);
    } catch (err: any) {
      ts.error = err?.message || "Failed to open folder dialog";
      state.requestUpdate?.();
      return;
    }
  }

  // Default cwd: use the explicit pick, or the active terminal's cwd, or
  // fall back to the gateway-reported project root (then home).
  const finalCwd = targetCwd ||
    (ts.activeSessionId ? ts.sessions.find(s => s.id === ts.activeSessionId)?.cwd : undefined) ||
    projectDir || homeDir || ".";

  // Honor the topbar federation filter as the spawn target — if the user
  // narrows the view to "Beta", clicking a quick-launch CLI button should
  // spawn on Beta, not silently back to local. Falls through to the
  // createForm default, then to "local".
  const nodeId =
    (ts.filterNodeId && ts.filterNodeId !== "__all__" ? ts.filterNodeId : null) ||
    ts.defaultSpawnNodeId ||
    ts.createForm.nodeId ||
    "local";

  await createTerminalSession(state, {
    cli,
    cwd: finalCwd,
    nodeId,
  });
}

// ── Git Operations (unchanged) ───────────────────────────────

export function toggleGitPanel(state: AppViewState): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.showGitPanel = !ts.showGitPanel;
  if (ts.showGitPanel && !ts.gitStatus) {
    loadGitStatus(state);
  }
  state.requestUpdate?.();
}

export async function loadGitStatus(state: AppViewState, cwd?: string): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  ts.gitLoading = true;
  if (cwd) ts.gitCwd = cwd;
  state.requestUpdate?.();

  const params = ts.gitCwd ? { cwd: ts.gitCwd } : {};

  try {
    const [status, branches, log] = await Promise.all([
      state.client.request<GitRepoStatus>("git.status", params).catch(() => null),
      state.client.request<GitBranches>("git.branches", params).catch(() => null),
      state.client.request<{ commits: GitCommit[] }>("git.log", { ...params, limit: 10 }).catch(() => null),
    ]);

    ts.gitStatus = status;
    ts.gitBranches = branches;
    ts.gitLog = log?.commits ?? [];
  } catch {
    ts.gitStatus = null;
  }

  ts.gitLoading = false;
  state.requestUpdate?.();
}

export async function gitCheckout(state: AppViewState, branch: string, create = false): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  try {
    await state.client.request("git.checkout", { cwd: ts.gitCwd || undefined, branch, create });
    ts.successMessage = create ? `Created & switched to ${branch}` : `Switched to ${branch}`;
    await loadGitStatus(state);
  } catch (e: any) {
    ts.error = e?.message || "Checkout failed";
    state.requestUpdate?.();
  }
}

export async function gitStageAll(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  try {
    await state.client.request("git.add", { cwd: ts.gitCwd || undefined, files: ["."] });
    ts.successMessage = "All files staged";
    await loadGitStatus(state);
  } catch (e: any) {
    ts.error = e?.message || "Stage failed";
    state.requestUpdate?.();
  }
}

export async function gitCommit(state: AppViewState, message: string): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  try {
    await state.client.request("git.commit", { cwd: ts.gitCwd || undefined, message });
    ts.successMessage = `Committed: ${message.slice(0, 40)}`;
    await loadGitStatus(state);
  } catch (e: any) {
    ts.error = e?.message || "Commit failed";
    state.requestUpdate?.();
  }
}

export async function gitPush(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  try {
    await state.client.request("git.push", { cwd: ts.gitCwd || undefined });
    ts.successMessage = "Pushed to remote";
    await loadGitStatus(state);
  } catch (e: any) {
    ts.error = e?.message || "Push failed";
    state.requestUpdate?.();
  }
}

export async function gitPull(state: AppViewState, rebase = false): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  try {
    await state.client.request("git.pull", { cwd: ts.gitCwd || undefined, rebase });
    ts.successMessage = rebase ? "Pulled (rebase)" : "Pulled from remote";
    await loadGitStatus(state);
  } catch (e: any) {
    ts.error = e?.message || "Pull failed";
    state.requestUpdate?.();
  }
}

export async function gitFetch(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  try {
    await state.client.request("git.fetch", { cwd: ts.gitCwd || undefined, prune: true });
    ts.successMessage = "Fetched from remote";
    await loadGitStatus(state);
  } catch (e: any) {
    ts.error = e?.message || "Fetch failed";
    state.requestUpdate?.();
  }
}

export async function gitStash(state: AppViewState, op: "push" | "pop" | "list" = "push", message?: string): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  try {
    await state.client.request("git.stash", { cwd: ts.gitCwd || undefined, op, message });
    ts.successMessage = `Stash ${op}`;
    await loadGitStatus(state);
  } catch (e: any) {
    ts.error = e?.message || "Stash failed";
    state.requestUpdate?.();
  }
}

// ── Drag and Drop Reorder (unchanged) ────────────────────────

export function startDrag(state: AppViewState, sessionId: string): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.dragSourceId = sessionId;
  state.requestUpdate?.();
}

export function dragOver(state: AppViewState, sessionId: string): void {
  const ts = state.terminalsState;
  if (!ts || !ts.dragSourceId || ts.dragSourceId === sessionId) return;
  ts.dragOverId = sessionId;
  state.requestUpdate?.();
}

export function dropOn(state: AppViewState, targetId: string): void {
  const ts = state.terminalsState;
  if (!ts || !ts.dragSourceId || ts.dragSourceId === targetId) {
    if (ts) { ts.dragSourceId = null; ts.dragOverId = null; }
    state.requestUpdate?.();
    return;
  }

  const sourceIdx = ts.sessions.findIndex((s) => s.id === ts.dragSourceId);
  const targetIdx = ts.sessions.findIndex((s) => s.id === targetId);
  if (sourceIdx < 0 || targetIdx < 0) {
    ts.dragSourceId = null;
    ts.dragOverId = null;
    state.requestUpdate?.();
    return;
  }

  const [moved] = ts.sessions.splice(sourceIdx, 1);
  ts.sessions.splice(targetIdx, 0, moved);
  ts.dragSourceId = null;
  ts.dragOverId = null;
  state.requestUpdate?.();
}

export function endDrag(state: AppViewState): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.dragSourceId = null;
  ts.dragOverId = null;
  state.requestUpdate?.();
}

// ── Native Folder Browser ────────────────────────────────────

export async function openNativeFolderBrowser(state: AppViewState): Promise<void> {
  const ts = state.terminalsState;
  if (!ts || !state.client) return;

  try {
    const result = await state.client.request<{ cancelled: boolean; path: string | null }>(
      "fs.browseFolder",
      { initialDir: ts.createForm.cwd || "" },
    );

    if (result && !result.cancelled && result.path) {
      ts.createForm.cwd = result.path;
      rememberRecentDir(state, result.path);
    }
  } catch (err: any) {
    ts.error = err?.message || "Failed to open folder dialog";
  }

  state.requestUpdate?.();
}

/**
 * Apply a system-dir preset (or recent dir) into the create-dialog cwd field.
 */
export function pickPresetDir(state: AppViewState, dirPath: string): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.createForm.cwd = dirPath;
  rememberRecentDir(state, dirPath);
  state.requestUpdate?.();
}

// ── UI State Actions (unchanged) ─────────────────────────────

export function setGridLayout(state: AppViewState, layout: GridLayout): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.gridLayout = layout;
  state.requestUpdate?.();

  // Clear any inline width/height the user dragged onto cards — otherwise
  // those sizes keep overriding the new grid layout and the picker looks
  // broken. Then trigger a refit.
  setTimeout(() => {
    document.querySelectorAll<HTMLElement>(".term-grid > .term-card").forEach((el) => {
      el.style.width = "";
      el.style.height = "";
    });
    ts.sessions.forEach(session => {
      const xterm = getXtermInstance(session.id);
      if (xterm) xterm.fit();
    });
  }, 50);
}

export function toggleExpandTerminal(state: AppViewState, sessionId: string): void {
  const ts = state.terminalsState;
  if (!ts) return;

  const session = ts.sessions.find((s) => s.id === sessionId);
  if (session) {
    session.expandedView = !session.expandedView;
    state.requestUpdate?.();

    // Refit terminal after expansion
    setTimeout(() => {
      const xterm = getXtermInstance(sessionId);
      if (xterm) {
        xterm.fit();
      }
    }, 100);
  }
}

export function setActiveSession(state: AppViewState, sessionId: string | null): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.activeSessionId = sessionId;

  // Focus the xterm instance
  if (sessionId) {
    const xterm = getXtermInstance(sessionId);
    if (xterm) {
      xterm.focus();
    }
  }

  state.requestUpdate?.();
}

export function toggleSidePanel(state: AppViewState): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.showSidePanel = !ts.showSidePanel;
  state.requestUpdate?.();
}

export function toggleLowerPanel(state: AppViewState): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.showLowerPanel = !ts.showLowerPanel;
  state.requestUpdate?.();
  
  // Refit terminals after panel toggle
  setTimeout(() => {
    ts.sessions.forEach(session => {
      const xterm = getXtermInstance(session.id);
      if (xterm) xterm.fit();
    });
  }, 100);
}

export function setLowerPanelHeight(state: AppViewState, height: number): void {
  const ts = state.terminalsState;
  if (!ts) return;
  ts.lowerPanelHeight = Math.max(100, Math.min(height, 600)); // Clamp between 100-600px
  state.requestUpdate?.();
  
  // Refit terminals after resize
  setTimeout(() => {
    ts.sessions.forEach(session => {
      const xterm = getXtermInstance(session.id);
      if (xterm) xterm.fit();
    });
  }, 50);
}

// ── Polling (Stub Functions) ────────────────────────────────
// Note: Xterm uses WebSocket events for real-time updates.
// These are stub functions for compatibility with app-settings.

export function startTerminalPolling(_state: AppViewState): void {
  // No-op: xterm uses WebSocket events (terminal.output, terminal.exit)
  // Event listeners are registered in loadTerminalsPage
}

export function stopTerminalPolling(_state: AppViewState): void {
  // No-op: event listeners are cleaned up in cleanupTerminals
}

// ── Cleanup ──────────────────────────────────────────────────

export function cleanupTerminals(): void {
  // Dispose all xterm instances
  xtermInstances.forEach((xterm) => {
    xterm.dispose();
  });
  xtermInstances.clear();
}

// ── Keyboard Navigation ──────────────────────────────────────

export function handleTerminalsKeyboard(
  state: AppViewState,
  e: KeyboardEvent,
): void {
  const ts = state.terminalsState;
  if (!ts || ts.sessions.length === 0) return;

  const target = e.target as Element | null;
  const insideXterm = !!target?.closest?.(".xterm, .xterm-screen, .xterm-helper-textarea");
  const insideDialog = !!target?.closest?.(".term-dialog-overlay");
  const insideInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
  if (insideDialog) return;
  if ((insideXterm || insideInput) && e.key !== "Escape" && e.key !== "Tab") return;

  const sessions = ts.filterNodeId
    ? ts.sessions.filter(s => (s.nodeId ?? "local") === ts.filterNodeId)
    : ts.sessions;
  const maxIdx = sessions.length - 1;
  const cols = Math.max(1, Math.floor(Math.sqrt(sessions.length)));

  let handled = true;

  switch (e.key) {
    case "ArrowLeft": {
      if (ts.focusedCardIndex < 0) { ts.focusedCardIndex = 0; break; }
      if (e.ctrlKey) {
        // resize narrower
        const card = document.querySelector<HTMLElement>(`.term-card[data-id="${sessions[ts.focusedCardIndex]?.id}"]`);
        if (card) {
          const step = e.shiftKey ? 10 : 40;
          card.style.width = `${Math.max(200, (card.offsetWidth || 400) - step)}px`;
        }
      } else {
        if (e.shiftKey) {
          ts.focusedCardIndex = Math.max(0, ts.focusedCardIndex - cols);
        } else {
          ts.focusedCardIndex = Math.max(0, ts.focusedCardIndex - 1);
        }
      }
      break;
    }
    case "ArrowRight": {
      if (ts.focusedCardIndex < 0) { ts.focusedCardIndex = 0; break; }
      if (e.ctrlKey) {
        const card = document.querySelector<HTMLElement>(`.term-card[data-id="${sessions[ts.focusedCardIndex]?.id}"]`);
        if (card) {
          const step = e.shiftKey ? 10 : 40;
          card.style.width = `${Math.min(1200, (card.offsetWidth || 400) + step)}px`;
        }
      } else {
        if (e.shiftKey) {
          ts.focusedCardIndex = Math.min(maxIdx, ts.focusedCardIndex + cols);
        } else {
          ts.focusedCardIndex = Math.min(maxIdx, ts.focusedCardIndex + 1);
        }
      }
      break;
    }
    case "ArrowUp": {
      if (ts.focusedCardIndex < 0) { ts.focusedCardIndex = 0; break; }
      if (e.ctrlKey) {
        const card = document.querySelector<HTMLElement>(`.term-card[data-id="${sessions[ts.focusedCardIndex]?.id}"]`);
        if (card) {
          const step = e.shiftKey ? 10 : 40;
          card.style.height = `${Math.max(120, (card.offsetHeight || 300) - step)}px`;
        }
      } else {
        ts.focusedCardIndex = Math.max(0, ts.focusedCardIndex - cols);
      }
      break;
    }
    case "ArrowDown": {
      if (ts.focusedCardIndex < 0) { ts.focusedCardIndex = 0; break; }
      if (e.ctrlKey) {
        const card = document.querySelector<HTMLElement>(`.term-card[data-id="${sessions[ts.focusedCardIndex]?.id}"]`);
        if (card) {
          const step = e.shiftKey ? 10 : 40;
          card.style.height = `${Math.min(800, (card.offsetHeight || 300) + step)}px`;
        }
      } else {
        ts.focusedCardIndex = Math.min(maxIdx, ts.focusedCardIndex + cols);
      }
      break;
    }
    case "Tab": {
      e.preventDefault();
      if (e.shiftKey) {
        ts.focusedCardIndex = ts.focusedCardIndex <= 0 ? maxIdx : ts.focusedCardIndex - 1;
      } else {
        ts.focusedCardIndex = ts.focusedCardIndex >= maxIdx ? 0 : ts.focusedCardIndex + 1;
      }
      break;
    }
    case "Enter": {
      if (ts.focusedCardIndex >= 0 && ts.focusedCardIndex <= maxIdx) {
        const session = sessions[ts.focusedCardIndex];
        ts.activeSessionId = session.id;
        const xterm = getXtermInstance(session.id);
        if (xterm) xterm.focus();
      }
      break;
    }
    case "Escape": {
      ts.focusedCardIndex = -1;
      const expanded = ts.sessions.find((s) => s.expandedView);
      if (expanded) {
        expanded.expandedView = false;
        setTimeout(() => getXtermInstance(expanded.id)?.fit(), 80);
      } else if (ts.pageFullscreen && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
      break;
    }
    case "Delete":
    case "Backspace": {
      if (ts.focusedCardIndex >= 0 && ts.focusedCardIndex <= maxIdx) {
        e.preventDefault();
        const session = sessions[ts.focusedCardIndex];
        if (session && confirm(`Close terminal "${session.title}"?`)) {
          closeTerminalSession(state, session.id);
        }
      }
      break;
    }
    default:
      handled = false;
  }

  if (handled) {
    e.preventDefault();
    state.requestUpdate?.();
  }
}
