/**
 * Workspace controller — per-project IDE-lite that bundles file tree,
 * code editor, diff view, live preview iframe, and a Claude Coder chat
 * panel rooted at a registered directory entry.
 *
 * Workspaces are projected from the existing `directories.list` registry
 * (which already binds a local path to a kanban projectId / agentId).
 * Per-workspace UI prefs (open file, dev URL, side-panel visibility) are
 * persisted in localStorage so reopening the tab restores context.
 */

import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import type { FileTreeNode } from "./files.js";
import {
  TEMPLATE_LIBRARY,
  COMPONENT_LIBRARY,
  findTemplate,
  findSnippet,
  type WorkspaceTemplate,
  type ComponentSnippet,
  type TemplateBindingSpec,
} from "./workspace-templates.js";

// ── Types ───────────────────────────────────────────────────────────

export interface WorkspaceEntry {
  id: string;
  path: string;
  name: string;
  description?: string;
  projectId?: string;
  agentId?: string;
  icon?: string;
  gitRemote?: string;
}

export interface WorkspaceTab {
  /** Absolute path on disk. */
  path: string;
  /** Filename only (for display). */
  name: string;
  /** Live editor buffer. */
  content: string;
  /** Disk snapshot — used for diff + dirty detection. */
  original: string;
  /** True when content !== original. */
  dirty: boolean;
  /** Per-tab loading flag (initial read). */
  loading?: boolean;
  /** Per-tab error string. */
  error?: string;
  /** Saved scroll offset for the editor textarea, restored on tab switch. */
  scrollTop?: number;
}

export type WorkspaceViewMode = "files" | "code" | "diff" | "preview";

export interface CoderMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** Sub-agent run id once the call kicks off. */
  runId?: string;
  /** Wall-clock for sort + display. */
  ts: number;
  /** True while we're waiting on the tool call. */
  pending?: boolean;
}

/**
 * Coder pane mode selector.
 *  - "tui"   — embedded xterm running the Claude CLI in the workspace dir
 *              (full TUI, same plumbing as the Terminals tab).
 *  - "agent" — native InfiniBot agent chat session (grid-chat styled).
 */
export type CoderMode = "tui" | "agent";

export interface AgentChatMessage {
  role: "user" | "assistant" | "system";
  /** Raw text content; we serialise from message-block arrays at load time. */
  text: string;
  ts: number;
  pending?: boolean;
}

// ── Project mode ───────────────────────────────────────────────────

export type ProjectMode = "web" | "app" | "document" | "pdf" | "presentation";

export interface PreviewPane {
  id: string;
  /** Which renderer this pane uses. */
  renderer: "web" | "markdown" | "pdf" | "slides";
  label: string;
}

export interface WorkflowListEntry {
  id: string;
  name: string;
  description?: string;
  kind?: string;
}

export interface WorkspaceLinkedRow {
  databaseId: string;
  databaseName: string;
  rowId: string;
  title: string;
  status?: string;
}

export interface WorkspaceRuntimeDetection {
  root: string;
  appPath: string;
  relativeAppPath: string;
  kind: string;
  packageManager: string;
  installCmd: string | null;
  devCmd: string | null;
  expectedPort: number;
  envHints: string[];
  confidence: number;
  missingDependencies: boolean;
  nodeVersion: string | null;
  monorepo: boolean;
  gitBranch?: string | null;
  candidates: Array<{ path: string; relativePath: string; name: string; kind: string; confidence: number }>;
}

export interface WorkspaceRuntimeServer {
  directoryId: string;
  status: "stopped" | "installing" | "starting" | "ready" | "error";
  port: number | null;
  previewPath: string | null;
  command: string | null;
  error: string | null;
  startedAt: number | null;
  readyAt: number | null;
}

export interface WorkspaceElementSelection {
  selector: string;
  tag: string;
  text: string;
  html: string;
  source: string | null;
  screenshotPath: string | null;
}

export interface WorkspaceVersionEntry {
  id: string;
  commit: string;
  description: string;
  createdAt: number;
  stats: string;
}

export type WorkspaceDeviceMode = "desktop" | "tablet" | "mobile";
export type WorkspaceScaffoldTemplate = "none" | "react-vite" | "next" | "html" | "astro";
export type WorkspaceMobileSurface = "chat" | "preview";

export interface WorkspaceState {
  loading: boolean;
  error: string | null;
  workspaces: WorkspaceEntry[];
  selectedId: string | null;

  // File tree for the selected workspace
  tree: FileTreeNode | null;
  treeLoading: boolean;
  /** Set of expanded directory paths. */
  expanded: Set<string>;

  // Open file tabs
  tabs: WorkspaceTab[];
  activeTabPath: string | null;

  // Layout / mode
  viewMode: WorkspaceViewMode;
  showLeft: boolean;
  showRight: boolean;
  showTerminal: boolean;
  /** Pixel width of the left (Coder) pane. Persisted to localStorage. */
  leftWidth: number;
  /** True while the user is dragging the left/center resize handle. */
  resizingLeft: boolean;

  // Live preview
  devUrl: string;
  /** Forces iframe reload (cache-bust query param). */
  previewNonce: number;
  previewRoute: string;
  previewDevice: WorkspaceDeviceMode;
  inspectorEnabled: boolean;
  selectedElement: WorkspaceElementSelection | null;
  runtimeLoading: boolean;
  runtimeDetection: WorkspaceRuntimeDetection | null;
  runtimeServer: WorkspaceRuntimeServer | null;
  runtimeLogs: string;
  runtimeLogCursor: number;
  runtimeAutoStart: boolean;
  /**
   * Directory ids the operator explicitly opened in THIS UI session (picker
   * click, create, route/agent action). Auto-start only applies to these; the
   * project restored from localStorage on page load is never auto-started.
   * Session-only by design — never persisted.
   */
  runtimeExplicitIds: string[];
  runtimePollToken: number;
  versions: WorkspaceVersionEntry[];
  versionsOpen: boolean;
  versionDiff: string;
  visualVerifyRunning: boolean;
  visualVerifyScreenshots: string[];
  /** Secondary workspace actions shown from the slim header. */
  overflowOpen: boolean;
  /** Local command palette opened with Cmd/Ctrl+K. */
  commandPaletteOpen: boolean;
  /** On phones, switch the single-column surface between chat and preview. */
  mobileSurface: WorkspaceMobileSurface;
  /** Bottom workbench hosting Files / Code / Diff / Components. */
  workbenchOpen: boolean;
  /** Raw terminal is intentionally opt-in and lives in the bottom drawer. */
  terminalDrawerOpen: boolean;
  /** Optional per-session model override for the native workspace agent. */
  agentModel: string | null;
  /** Gateway default shown when the workspace session has no override. */
  agentDefaultModel: string | null;
  agentThinkingLevel: string | null;

  // Claude Coder chat
  coderMessages: CoderMessage[];
  coderInput: string;
  coderRunning: boolean;
  /** Most recent runId so the activity tail can scope to it. */
  lastCoderRunId: string | null;
  /** Right-rail tab — Tasks (detached spawn) | TUI (xterm) | Agent (chat). */
  coderMode: CoderMode;
  /** Live xterm-backed terminal id when in TUI mode. */
  tuiTerminalId: string | null;
  tuiStarting: boolean;

  // Native agent chat session (mode = "agent")
  /** Workspace-scoped agent session key (e.g. agent:main:workspace-<id>). */
  agentSessionKey: string;
  agentMessages: AgentChatMessage[];
  agentInput: string;
  agentSending: boolean;
  agentLoading: boolean;
  /** Prevents empty sessions from re-fetching history on every render. */
  agentHistoryLoaded: boolean;

  // Linked business rows (Tasks/Notes/etc. attached to this project)
  linked: WorkspaceLinkedRow[];
  linkedLoading: boolean;

  // UI sub-states
  creatingWorkspace: boolean;
  newWorkspacePath: string;
  newWorkspaceName: string;
  /** Project mode chosen in the Add-Workspace modal. */
  newWorkspaceMode: ProjectMode;
  newWorkspaceTemplate: WorkspaceScaffoldTemplate;

  // Custom workspace-picker dropdown (replaces the native <select>).
  pickerOpen: boolean;
  pickerFilter: string;

  // Templates gallery
  templatesOpen: boolean;
  /** Set when the user chose a template that needs a CRM binding. */
  pendingTemplate: WorkspaceTemplate | null;
  /** Same idea for component-library inserts that need a binding. */
  pendingSnippet: ComponentSnippet | null;
  /** True while a template is being scaffolded (file writes + binding create). */
  applyingTemplate: boolean;

  // Bind-form dialog state
  bindOpen: boolean;
  bindMode: "existing" | "new";
  bindDatabaseId: string;
  bindNewName: string;
  /** Database list pulled lazily when the dialog opens. */
  bindDatabaseChoices: Array<{ id: string; name: string; slug: string }>;

  // Components panel
  componentsOpen: boolean;

  // ── Project modes ──────────────────────────────────────────────────
  /** High-level project type used to choose renderers and quick actions. */
  projectMode: ProjectMode;

  // ── Multi-pane preview ─────────────────────────────────────────────
  /** Extra preview panes rendered beside the main canvas. */
  previewPanes: PreviewPane[];

  // ── Workflow picker ────────────────────────────────────────────────
  workflowPickerOpen: boolean;
  availableWorkflows: WorkflowListEntry[];
  workflowsLoading: boolean;
  workflowRunning: boolean;
  workflowRunId: string | null;

  // ── Presentation nav ───────────────────────────────────────────────
  /** Current slide index when projectMode = "presentation". */
  slideIndex: number;
}

const LS_KEY_PREFIX = "infinibot.workspace.";

function loadPrefs(workspaceId: string): {
  devUrl?: string;
  activeTabPath?: string;
  openTabs?: string[];
  viewMode?: WorkspaceViewMode;
  scrollTops?: Record<string, number>;
  projectMode?: string;
} {
  try {
    const raw = localStorage.getItem(`${LS_KEY_PREFIX}${workspaceId}`);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePrefs(workspaceId: string, prefs: Record<string, unknown>): void {
  try {
    const existing = loadPrefs(workspaceId);
    localStorage.setItem(
      `${LS_KEY_PREFIX}${workspaceId}`,
      JSON.stringify({ ...existing, ...prefs }),
    );
  } catch {}
}

const RECENTS_KEY = `${LS_KEY_PREFIX}recents`;
const RECENTS_MAX = 5;

/** Read the recent-workspace id list, newest first. */
export function loadRecentIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Push a workspace id to the front of the recents list, deduped + capped. */
function pushRecent(workspaceId: string): void {
  try {
    const next = [workspaceId, ...loadRecentIds().filter((id) => id !== workspaceId)].slice(0, RECENTS_MAX);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {}
}

const RECENT_FOLDERS_KEY = `${LS_KEY_PREFIX}recentFolders`;
const RECENT_FOLDERS_MAX = 6;

/** Last-used folder paths from the Add-Workspace modal (newest first). */
export function loadRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecentFolder(path: string): void {
  if (!path) return;
  try {
    const next = [path, ...loadRecentFolders().filter((p) => p !== path)].slice(0, RECENT_FOLDERS_MAX);
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(next));
  } catch {}
}

export function createInitialWorkspaceState(): WorkspaceState {
  return {
    loading: false,
    error: null,
    workspaces: [],
    selectedId: null,
    tree: null,
    treeLoading: false,
    expanded: new Set<string>(),
    tabs: [],
    activeTabPath: null,
    viewMode: "code",
    showLeft: true,
    showRight: true,
    showTerminal: false,
    leftWidth: (() => {
      try {
        const raw = localStorage.getItem(`${LS_KEY_PREFIX}leftWidth`);
        const n = raw ? Number(raw) : NaN;
        return Number.isFinite(n) && n >= 220 && n <= 800 ? n : 380;
      } catch {
        return 380;
      }
    })(),
    resizingLeft: false,
    devUrl: "",
    previewNonce: 0,
    previewRoute: "/",
    previewDevice: "desktop",
    inspectorEnabled: false,
    selectedElement: null,
    runtimeLoading: false,
    runtimeDetection: null,
    runtimeServer: null,
    runtimeLogs: "",
    runtimeLogCursor: 0,
    runtimeAutoStart: (() => {
      try { return localStorage.getItem(`${LS_KEY_PREFIX}autoStart`) !== "false"; } catch { return true; }
    })(),
    runtimeExplicitIds: [],
    runtimePollToken: 0,
    versions: [],
    versionsOpen: false,
    versionDiff: "",
    visualVerifyRunning: false,
    visualVerifyScreenshots: [],
    overflowOpen: false,
    commandPaletteOpen: false,
    mobileSurface: "preview",
    workbenchOpen: false,
    terminalDrawerOpen: false,
    agentModel: null,
    agentDefaultModel: null,
    agentThinkingLevel: null,
    coderMessages: [],
    coderInput: "",
    coderRunning: false,
    lastCoderRunId: null,
    coderMode: "agent",
    tuiTerminalId: null,
    tuiStarting: false,
    agentSessionKey: "",
    agentMessages: [],
    agentInput: "",
    agentSending: false,
    agentLoading: false,
    agentHistoryLoaded: false,
    linked: [],
    linkedLoading: false,
    creatingWorkspace: false,
    newWorkspacePath: "",
    newWorkspaceName: "",
    newWorkspaceMode: "web",
    newWorkspaceTemplate: "none",
    pickerOpen: false,
    pickerFilter: "",
    templatesOpen: false,
    pendingTemplate: null,
    pendingSnippet: null,
    applyingTemplate: false,
    bindOpen: false,
    bindMode: "existing",
    bindDatabaseId: "",
    bindNewName: "",
    bindDatabaseChoices: [],
    componentsOpen: true,
    projectMode: "web",
    previewPanes: [],
    workflowPickerOpen: false,
    availableWorkflows: [],
    workflowsLoading: false,
    workflowRunning: false,
    workflowRunId: null,
    slideIndex: 0,
  };
}

function getWs(state: AppViewState): WorkspaceState {
  // Attached lazily without modifying the AppViewState shape.
  if (!(state as unknown as { workspaceState?: WorkspaceState }).workspaceState) {
    (state as unknown as { workspaceState: WorkspaceState }).workspaceState =
      createInitialWorkspaceState();
  }
  return (state as unknown as { workspaceState: WorkspaceState }).workspaceState;
}

// ── Workspace list / select ─────────────────────────────────────────

export async function loadWorkspaces(state: AppViewState, client: GatewayBrowserClient) {
  const ws = getWs(state);
  ws.loading = true;
  ws.error = null;
  state.requestUpdate?.();

  try {
    const res = await client.request<unknown>("directories.list", { active: true });
    // Handler returns `entries` directly via `respond(true, entries)` so the
    // gateway shim will give us either the array or a wrapped object.
    const entries = (Array.isArray(res)
      ? res
      : (res as { entries?: unknown[] })?.entries ?? []) as Array<{
        id: string;
        path: string;
        name: string;
        description?: string;
        projectId?: string;
        agentId?: string;
        icon?: string;
        gitRemote?: string;
      }>;
    ws.workspaces = entries.map((e) => ({
      id: e.id,
      path: e.path,
      name: e.name,
      description: e.description,
      projectId: e.projectId,
      agentId: e.agentId,
      icon: e.icon,
      gitRemote: e.gitRemote,
    }));

    // Auto-select the previously chosen workspace, or the first one.
    const lastId = (() => {
      try {
        return localStorage.getItem(`${LS_KEY_PREFIX}lastSelected`);
      } catch {
        return null;
      }
    })();
    const target = ws.workspaces.find((w) => w.id === lastId) ?? ws.workspaces[0];
    if (target && ws.selectedId !== target.id) {
      // Restoring the last-used project is NOT an explicit open: it must not
      // auto-start a dev server the operator didn't ask for this session.
      await selectWorkspace(state, client, target.id, { explicit: false });
    }
  } catch (err) {
    ws.error = (err as Error).message ?? "Failed to load workspaces";
  } finally {
    ws.loading = false;
    state.requestUpdate?.();
  }
}

export async function selectWorkspace(
  state: AppViewState,
  client: GatewayBrowserClient,
  workspaceId: string,
  /**
   * `explicit: true` = the operator chose this project in this session
   * (picker click, create, route/agent action), which makes it eligible for
   * runtime auto-start. Defaults to false so programmatic selection (restore
   * on load, fallbacks) never spawns a surprise dev server.
   */
  opts: { explicit?: boolean } = {},
) {
  const ws = getWs(state);
  const entry = ws.workspaces.find((w) => w.id === workspaceId);
  if (!entry) return;
  if (opts.explicit) markWorkspaceExplicitlyOpened(state, workspaceId);
  ws.selectedId = workspaceId;
  ws.tree = null;
  ws.tabs = [];
  ws.activeTabPath = null;
  ws.coderMessages = [];
  ws.lastCoderRunId = null;
  ws.linked = [];
  ws.runtimeDetection = null;
  ws.runtimeServer = null;
  ws.runtimeLogs = "";
  ws.runtimeLogCursor = 0;
  ws.selectedElement = null;
  ws.previewRoute = "/";
  ws.runtimePollToken += 1;
  // Tear down the previous workspace's TUI / agent tabs — both are bound to
  // the workspace path / id so reusing them across switches is wrong.
  ws.tuiTerminalId = null;
  ws.tuiStarting = false;
  // The polished panel is a coding surface, so route it to the native coder
  // agent (tool-capable) instead of the general assistant. This preserves the
  // streaming chat protocol while giving turns access to real file/terminal
  // actions without exposing the raw CLI as the primary UI.
  ws.agentSessionKey = `agent:coder:workspace-${workspaceId}`;
  ws.agentMessages = [];
  ws.agentInput = "";
  ws.agentSending = false;
  ws.agentHistoryLoaded = false;

  try {
    localStorage.setItem(`${LS_KEY_PREFIX}lastSelected`, workspaceId);
  } catch {}
  pushRecent(workspaceId);

  // Restore prefs (devUrl, view mode, last open tab, project mode).
  const prefs = loadPrefs(workspaceId);
  ws.devUrl = prefs.devUrl ?? "";
  ws.viewMode = prefs.viewMode ?? "code";
  ws.slideIndex = 0;
  // projectMode restored from prefs; if absent, detectProjectMode() will infer it
  if (prefs.projectMode) ws.projectMode = prefs.projectMode as ProjectMode;

  state.requestUpdate?.();

  // Auto-register the path as an external root so files.read/write can reach
  // it through the existing safePath gate. Check first because roots.add
  // reports ALREADY_EXISTS as a failed RPC, which pollutes visual verification
  // and connection diagnostics even though repeat selection is expected.
  try {
    const listed = await client.request<{ roots?: Array<{ path?: string }> }>("files.roots.list", {});
    const normalized = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!(listed?.roots ?? []).some((root) => normalized(root.path ?? "") === normalized(entry.path))) {
      await client.request("files.roots.add", { path: entry.path, name: entry.name });
    }
  } catch {
    /* root management unavailable; tree load will surface a real access error */
  }

  await Promise.all([
    loadTree(state, client),
    loadLinkedBusinessRows(state, client),
    !prefs.projectMode ? detectProjectMode(state, client) : Promise.resolve(),
    loadWorkspaceRuntime(state, client),
  ]);

  // Restore last-open tabs (best-effort — silently skip if missing).
  if (Array.isArray(prefs.openTabs)) {
    for (const path of prefs.openTabs) {
      await openFile(state, client, path, { suppressActivate: true });
    }
    // Re-apply persisted scroll offsets so reopening a file lands the
    // editor where the user left off rather than at the top.
    const scrolls = prefs.scrollTops ?? {};
    for (const tab of ws.tabs) {
      const sv = scrolls[tab.path];
      if (typeof sv === "number") tab.scrollTop = sv;
    }
    if (prefs.activeTabPath) {
      ws.activeTabPath = prefs.activeTabPath;
      state.requestUpdate?.();
    }
  }
}

// ── File tree ───────────────────────────────────────────────────────

export async function loadTree(state: AppViewState, client: GatewayBrowserClient) {
  const ws = getWs(state);
  const entry = ws.workspaces.find((w) => w.id === ws.selectedId);
  if (!entry) return;
  ws.treeLoading = true;
  state.requestUpdate?.();
  try {
    const tree = await client.request<FileTreeNode>("files.tree", {
      path: entry.path,
      depth: 6,
    });
    ws.tree = tree ?? null;
  } catch (err) {
    ws.error = (err as Error).message;
  } finally {
    ws.treeLoading = false;
    state.requestUpdate?.();
  }
}

export function toggleExpand(state: AppViewState, path: string) {
  const ws = getWs(state);
  if (ws.expanded.has(path)) ws.expanded.delete(path);
  else ws.expanded.add(path);
  state.requestUpdate?.();
}

// ── File tabs ───────────────────────────────────────────────────────

const MAX_TABS = 12;

export async function openFile(
  state: AppViewState,
  client: GatewayBrowserClient,
  filePath: string,
  opts: { suppressActivate?: boolean } = {},
) {
  const ws = getWs(state);
  const existing = ws.tabs.find((t) => t.path === filePath);
  if (existing) {
    if (!opts.suppressActivate) {
      ws.activeTabPath = filePath;
      // Coming from the Files tree mode? Flip to Code so the user sees their
      // file rather than the tree they just clicked.
      if (ws.viewMode === "files") ws.viewMode = "code";
      state.requestUpdate?.();
      persistTabPrefs(ws);
    }
    return;
  }
  const name = filePath.includes("/") ? filePath.slice(filePath.lastIndexOf("/") + 1) : filePath;
  const tab: WorkspaceTab = {
    path: filePath,
    name,
    content: "",
    original: "",
    dirty: false,
    loading: true,
  };
  // FIFO trim
  if (ws.tabs.length >= MAX_TABS) ws.tabs.shift();
  ws.tabs.push(tab);
  if (!opts.suppressActivate) {
    ws.activeTabPath = filePath;
    if (ws.viewMode === "files") ws.viewMode = "code";
  }
  state.requestUpdate?.();

  try {
    const res = await client.request<{ content: string }>("files.read", { path: filePath });
    tab.content = res?.content ?? "";
    tab.original = tab.content;
  } catch (err) {
    tab.error = (err as Error).message;
  } finally {
    tab.loading = false;
    state.requestUpdate?.();
    persistTabPrefs(ws);
  }
}

export function closeTab(state: AppViewState, filePath: string) {
  const ws = getWs(state);
  const idx = ws.tabs.findIndex((t) => t.path === filePath);
  if (idx < 0) return;
  ws.tabs.splice(idx, 1);
  if (ws.activeTabPath === filePath) {
    ws.activeTabPath = ws.tabs[ws.tabs.length - 1]?.path ?? null;
  }
  state.requestUpdate?.();
  persistTabPrefs(ws);
}

export function setActiveTab(state: AppViewState, filePath: string) {
  const ws = getWs(state);
  ws.activeTabPath = filePath;
  state.requestUpdate?.();
  persistTabPrefs(ws);
}

export function updateTabContent(state: AppViewState, filePath: string, content: string) {
  const ws = getWs(state);
  const tab = ws.tabs.find((t) => t.path === filePath);
  if (!tab) return;
  tab.content = content;
  tab.dirty = content !== tab.original;
  state.requestUpdate?.();
}

export async function saveTab(
  state: AppViewState,
  client: GatewayBrowserClient,
  filePath: string,
) {
  const ws = getWs(state);
  const tab = ws.tabs.find((t) => t.path === filePath);
  if (!tab || !tab.dirty) return;
  try {
    await client.request("files.write", { path: filePath, content: tab.content });
    tab.original = tab.content;
    tab.dirty = false;
    tab.error = undefined;
    // If the preview pane is showing a file from this workspace, force a
    // refresh so the user sees their save reflected immediately — saves
    // round-tripping through "click Reload" on every edit.
    if (ws.viewMode === "preview" && previewIsLocal(ws)) {
      ws.previewNonce = Date.now();
    }
    state.requestUpdate?.();
  } catch (err) {
    tab.error = (err as Error).message;
    state.requestUpdate?.();
  }
}

/**
 * Write every dirty tab in the workspace in parallel. Called by the
 * "Save all" button + Ctrl/Cmd+Shift+S binding.
 */
export async function saveAllTabs(
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  const dirty = ws.tabs.filter((t) => t.dirty);
  if (dirty.length === 0) return;
  await Promise.all(dirty.map((t) => saveTab(state, client, t.path)));
}

export async function reloadTab(
  state: AppViewState,
  client: GatewayBrowserClient,
  filePath: string,
) {
  const ws = getWs(state);
  const tab = ws.tabs.find((t) => t.path === filePath);
  if (!tab) return;
  tab.loading = true;
  state.requestUpdate?.();
  try {
    const res = await client.request<{ content: string }>("files.read", { path: filePath });
    tab.content = res?.content ?? "";
    tab.original = tab.content;
    tab.dirty = false;
    tab.error = undefined;
  } catch (err) {
    tab.error = (err as Error).message;
  } finally {
    tab.loading = false;
    state.requestUpdate?.();
  }
}

function persistTabPrefs(ws: WorkspaceState) {
  if (!ws.selectedId) return;
  const scrolls: Record<string, number> = {};
  for (const t of ws.tabs) {
    if (typeof t.scrollTop === "number" && t.scrollTop > 0) {
      scrolls[t.path] = t.scrollTop;
    }
  }
  savePrefs(ws.selectedId, {
    openTabs: ws.tabs.map((t) => t.path),
    activeTabPath: ws.activeTabPath,
    scrollTops: scrolls,
  });
}

/**
 * Record the editor's current scroll position for the given tab. Called
 * from the textarea's scroll handler (debounced via rAF on the caller
 * side) so reopening the tab puts the cursor back where the user left it.
 */
export function setTabScroll(state: AppViewState, filePath: string, scrollTop: number) {
  const ws = getWs(state);
  const tab = ws.tabs.find((t) => t.path === filePath);
  if (!tab) return;
  tab.scrollTop = scrollTop;
  // Avoid requestUpdate — scroll fires constantly and we don't render
  // anything new. The persist call is cheap (JSON to localStorage).
  persistTabPrefs(ws);
}

// ── View mode + preview ─────────────────────────────────────────────

export function setViewMode(state: AppViewState, mode: WorkspaceViewMode) {
  const ws = getWs(state);
  ws.viewMode = mode;
  state.requestUpdate?.();
  if (ws.selectedId) savePrefs(ws.selectedId, { viewMode: mode });
}

export function setDevUrl(state: AppViewState, url: string) {
  const ws = getWs(state);
  ws.devUrl = url.trim();
  state.requestUpdate?.();
  if (ws.selectedId) savePrefs(ws.selectedId, { devUrl: ws.devUrl });
}

export function reloadPreview(state: AppViewState) {
  const ws = getWs(state);
  ws.previewNonce = Date.now();
  state.requestUpdate?.();
}

/**
 * True when the Preview pane is going to render an in-workspace HTML file
 * (i.e. the user has no external dev URL set, but the active tab is an
 * .html file living under the selected workspace's root).
 */
export function previewIsLocal(ws: WorkspaceState): boolean {
  if (ws.devUrl) return false;
  const entry = ws.workspaces.find((w) => w.id === ws.selectedId);
  if (!entry) return false;
  const tab = ws.tabs.find((t) => t.path === ws.activeTabPath);
  if (!tab) return false;
  if (!/\.(html?|xhtml)$/i.test(tab.name)) return false;
  return relativeToRoot(tab.path, entry.path) !== null;
}

/**
 * Build the iframe src for the Preview pane. Priority:
 *   1. ws.devUrl — explicit dev server set by the operator.
 *   2. workspace static route — when the active tab is an HTML file from
 *      this workspace, serve it through /api/workspace/preview/<id>/<rel>
 *      so HTML sites work with no setup.
 *   3. null — render the empty state.
 */
export function getPreviewUrl(ws: WorkspaceState): string | null {
  if (ws.devUrl) {
    const sep = ws.devUrl.includes("?") ? "&" : "?";
    return `${ws.devUrl}${ws.previewNonce ? `${sep}_n=${ws.previewNonce}` : ""}`;
  }
  if (ws.runtimeServer?.status === "ready" && ws.runtimeServer.previewPath) {
    const route = ws.previewRoute.trim().replace(/^\/+/, "");
    const base = ws.runtimeServer.previewPath.endsWith("/")
      ? ws.runtimeServer.previewPath
      : `${ws.runtimeServer.previewPath}/`;
    const url = `${base}${route}`;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${ws.previewNonce ? `${sep}_n=${ws.previewNonce}` : ""}`;
  }
  const entry = ws.workspaces.find((w) => w.id === ws.selectedId);
  if (!entry) return null;
  const tab = ws.tabs.find((t) => t.path === ws.activeTabPath);
  if (!tab || !/\.(html?|xhtml)$/i.test(tab.name)) return null;
  const rel = relativeToRoot(tab.path, entry.path);
  if (rel === null) return null;
  const safeRel = rel.split("/").map((s) => encodeURIComponent(s)).join("/");
  const id = encodeURIComponent(entry.id);
  const nonce = ws.previewNonce ? `?_n=${ws.previewNonce}` : "";
  return `/api/workspace/preview/${id}/${safeRel}${nonce}`;
}

/** True if `tab.name` looks like an HTML document the preview pane can host. */
export function isHtmlFile(name: string): boolean {
  return /\.(html?|xhtml)$/i.test(name);
}

/**
 * Compute a forward-slash relative path of `absPath` against the workspace
 * `root`, or null when the path lives outside the workspace. Handles both
 * Linux-style and Windows-style separators on either side (the directory
 * store normalises its paths to backslashes).
 */
function relativeToRoot(absPath: string, root: string): string | null {
  const a = (absPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const r = (root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!a || !r) return null;
  const aLower = a.toLowerCase();
  const rLower = r.toLowerCase();
  if (aLower === rLower) return "";
  if (!aLower.startsWith(rLower + "/")) return null;
  return a.slice(r.length + 1);
}

export function togglePane(state: AppViewState, pane: "left" | "right" | "terminal") {
  const ws = getWs(state);
  if (pane === "left") ws.showLeft = !ws.showLeft;
  else if (pane === "right") ws.showRight = !ws.showRight;
  else ws.showTerminal = !ws.showTerminal;
  state.requestUpdate?.();
}

// ── Claude Coder chat ───────────────────────────────────────────────

function genId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function setCoderInput(state: AppViewState, value: string) {
  const ws = getWs(state);
  ws.coderInput = value;
  state.requestUpdate?.();
}

function selectionContext(selection: WorkspaceElementSelection | null): string {
  if (!selection) return "";
  return [
    "",
    "[Visual selection from the live preview]",
    `Selector: ${selection.selector}`,
    selection.source ? `Component/source: ${selection.source}` : "Component/source: not exposed by the framework",
    selection.text ? `Visible text: ${selection.text}` : "",
    `Element HTML: ${selection.html}`,
    selection.screenshotPath ? `Screenshot: ${selection.screenshotPath}` : "",
    "Use this selection as the primary visual target. Preserve unrelated behavior.",
  ].filter(Boolean).join("\n");
}

/**
 * Spawn (or send to) a Claude Coder run rooted at the workspace path.
 * Each send is currently a fresh detached run — the agent reads the
 * workspace files directly via its own tools, so multi-turn context
 * lives on disk rather than in this panel's chat history.
 */
export async function sendCoder(
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  const entry = ws.workspaces.find((w) => w.id === ws.selectedId);
  if (!entry) return;
  const text = ws.coderInput.trim();
  if (!text || ws.coderRunning) return;

  const userMsg: CoderMessage = {
    id: genId(),
    role: "user",
    text,
    ts: Date.now(),
  };
  const placeholder: CoderMessage = {
    id: genId(),
    role: "assistant",
    text: "Spawning Claude Coder…",
    ts: Date.now(),
    pending: true,
  };
  ws.coderMessages.push(userMsg, placeholder);
  ws.coderInput = "";
  ws.coderRunning = true;
  state.requestUpdate?.();

  try {
    // Low-level Git snapshot: captures tracked + untracked state without
    // moving HEAD or disturbing the user's index. This becomes the one-click
    // pre-turn restore point shown in Versions.
    try {
      await client.request("workspace.version.create", {
        directoryId: entry.id,
        description: `Before agent turn: ${text.slice(0, 80)}`,
      });
      await loadWorkspaceVersions(state, client);
    } catch {
      // Non-git workspaces still get the agent turn; the Versions rail simply
      // remains empty.
    }
    const res = await client.request<{
      result?: { content?: Array<{ type?: string; text?: string }> };
      runId?: string;
    }>("agent.tools.invoke", {
      tool: "claude_coder",
      args: {
        task: `${text}${selectionContext(ws.selectedElement)}`,
        workdir: entry.path,
        projectHint: entry.name,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        mode: "detach",
      },
      source: "workspace-ui",
    });

    const out =
      res?.result?.content
        ?.filter((c) => c?.type === "text" && typeof c.text === "string")
        ?.map((c) => c.text!)
        ?.join("\n")
        ?.trim() ?? "(spawned — see Activity panel for streaming output)";

    placeholder.text = out;
    placeholder.pending = false;
    placeholder.runId = res?.runId;
    if (res?.runId) ws.lastCoderRunId = res.runId;
  } catch (err) {
    placeholder.text = `Error: ${(err as Error).message}`;
    placeholder.pending = false;
  } finally {
    ws.coderRunning = false;
    state.requestUpdate?.();
  }

  // After the agent runs we may have on-disk changes — refresh tree + open tabs.
  void loadTree(state, client);
  for (const tab of ws.tabs) {
    void reloadTab(state, client, tab.path);
  }
}

export function clearCoderHistory(state: AppViewState) {
  const ws = getWs(state);
  ws.coderMessages = [];
  ws.lastCoderRunId = null;
  state.requestUpdate?.();
}

// ── Linked business rows (Tasks / Notes / etc) ──────────────────────

/**
 * Pull rows from the projects + tasks + notes system-role databases that
 * mention this workspace's projectId, so the operator (and the agent)
 * see business context at a glance.
 */
export async function loadLinkedBusinessRows(
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  const entry = ws.workspaces.find((w) => w.id === ws.selectedId);
  if (!entry) return;
  ws.linkedLoading = true;
  state.requestUpdate?.();

  try {
    const defaults = await client.request<{
      defaults: Array<{
        role: string;
        database: { id: string; name: string; slug: string } | null;
      }>;
    }>("db.system.defaults", {});
    const linked: WorkspaceLinkedRow[] = [];
    const projectId = entry.projectId ?? "";
    const filterText = (entry.name ?? "").toLowerCase();

    for (const d of defaults?.defaults ?? []) {
      if (!d.database) continue;
      // Skip non-relevant roles for the tight strip
      if (!["projects", "tasks", "notes"].includes(d.role)) continue;
      try {
        const res = await client.request<{ rows: Array<{ id: string; title: string; values: Record<string, unknown> }> }>(
          "db.rows.list",
          { databaseId: d.database.id },
        );
        for (const row of res?.rows ?? []) {
          const titleLower = (row.title ?? "").toLowerCase();
          // Match either by explicit projectId tag in values OR by title containing workspace name.
          const valuesText = JSON.stringify(row.values ?? {}).toLowerCase();
          const matches =
            (projectId && valuesText.includes(projectId.toLowerCase())) ||
            (filterText && titleLower.includes(filterText));
          if (!matches) continue;
          // Cheap status read for badge color
          let status: string | undefined;
          for (const v of Object.values(row.values ?? {}) as Array<{ type?: string; optionId?: string }>) {
            if (v?.type === "status" || v?.type === "select") {
              if (typeof v.optionId === "string") { status = v.optionId; break; }
            }
          }
          linked.push({
            databaseId: d.database.id,
            databaseName: d.database.name,
            rowId: row.id,
            title: row.title,
            status,
          });
        }
      } catch {
        /* skip on any failure */
      }
    }
    ws.linked = linked.slice(0, 20);
  } catch (err) {
    /* silent — linked panel is best-effort */
  } finally {
    ws.linkedLoading = false;
    state.requestUpdate?.();
  }
}

// ── New workspace creation ──────────────────────────────────────────

export function openNewWorkspaceDialog(state: AppViewState) {
  const ws = getWs(state);
  ws.creatingWorkspace = true;
  ws.newWorkspacePath = "";
  ws.newWorkspaceName = "";
  ws.newWorkspaceMode = "web";
  ws.newWorkspaceTemplate = "none";
  ws.pickerOpen = false;
  state.requestUpdate?.();
}

export function setNewWorkspaceMode(state: AppViewState, mode: ProjectMode) {
  const ws = getWs(state);
  ws.newWorkspaceMode = mode;
  state.requestUpdate?.();
}

export function setNewWorkspaceTemplate(state: AppViewState, template: WorkspaceScaffoldTemplate) {
  const ws = getWs(state);
  ws.newWorkspaceTemplate = template;
  state.requestUpdate?.();
}

export function setPickerOpen(state: AppViewState, open: boolean) {
  const ws = getWs(state);
  if (ws.pickerOpen === open) return;
  ws.pickerOpen = open;
  if (!open) ws.pickerFilter = "";
  state.requestUpdate?.();
}

export function togglePicker(state: AppViewState) {
  const ws = getWs(state);
  setPickerOpen(state, !ws.pickerOpen);
}

export function setPickerFilter(state: AppViewState, value: string) {
  const ws = getWs(state);
  ws.pickerFilter = value;
  state.requestUpdate?.();
}

export function closeNewWorkspaceDialog(state: AppViewState) {
  const ws = getWs(state);
  ws.creatingWorkspace = false;
  state.requestUpdate?.();
}

export function setNewWorkspacePath(state: AppViewState, value: string) {
  const ws = getWs(state);
  const prevAutoName = ws.newWorkspacePath.split(/[\\/]/).filter(Boolean).pop() ?? "";
  ws.newWorkspacePath = value;
  // Auto-derive display name from the folder leaf, but only while the user
  // hasn't typed their own — i.e. the name field is empty OR still matches
  // the previously-auto-filled value. This makes the modal feel "smart"
  // without ever overwriting user input.
  const currentName = ws.newWorkspaceName.trim();
  if (!currentName || currentName === prevAutoName) {
    const leaf = value.split(/[\\/]/).filter(Boolean).pop();
    if (leaf) ws.newWorkspaceName = leaf;
  }
  state.requestUpdate?.();
}

export function setNewWorkspaceName(state: AppViewState, value: string) {
  const ws = getWs(state);
  ws.newWorkspaceName = value;
  state.requestUpdate?.();
}

/**
 * Opens the Electron native folder picker (when running in the desktop
 * app) and fills the new-workspace path. Falls back to no-op in the
 * plain browser build — the manual path input is still available.
 */
export async function browseForWorkspaceFolder(state: AppViewState) {
  const api = (window as unknown as {
    api?: { pickFolder?: (opts?: { title?: string }) => Promise<{ canceled: boolean; path: string | null }> };
  }).api;
  if (!api?.pickFolder) return;
  try {
    const res = await api.pickFolder({ title: "Pick a workspace folder" });
    if (res?.canceled || !res?.path) return;
    const ws = getWs(state);
    ws.newWorkspacePath = res.path;
    // Auto-derive a display name from the folder when the field is blank
    // so the user only has to confirm rather than retype it.
    if (!ws.newWorkspaceName.trim()) {
      const leaf = res.path.split(/[\\/]/).filter(Boolean).pop();
      if (leaf) ws.newWorkspaceName = leaf;
    }
    state.requestUpdate?.();
  } catch {
    /* user cancelled or dialog unavailable */
  }
}

export async function createWorkspace(
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  const path = ws.newWorkspacePath.trim();
  const name = ws.newWorkspaceName.trim() || path.split(/[\\/]/).filter(Boolean).pop() || "Workspace";
  const mode = ws.newWorkspaceMode;
  if (!path) return;
  try {
    const res = await client.request<{ id: string }>("directories.create", {
      path,
      name,
      active: true,
    });
    pushRecentFolder(path);
    ws.creatingWorkspace = false;
    ws.newWorkspacePath = "";
    ws.newWorkspaceName = "";
    ws.error = null;
    await loadWorkspaces(state, client);
    if (res?.id) {
      if (ws.newWorkspaceTemplate !== "none") {
        await client.request("workspace.templates.scaffold", {
          directoryId: res.id,
          templateId: ws.newWorkspaceTemplate,
        });
      }
      ws.newWorkspaceTemplate = "none";
      await selectWorkspace(state, client, res.id, { explicit: true });
      // Honour the chosen project mode immediately — selectWorkspace loads
      // the persisted projectMode from localStorage (default "web"), so we
      // apply the user's pick after select to override it cleanly.
      setProjectMode(state, mode);
    }
  } catch (err) {
    ws.error = (err as Error).message;
    state.requestUpdate?.();
  }
}

// ── Resize ─────────────────────────────────────────────────────────

const MIN_LEFT = 240;
const MAX_LEFT = 760;

export function setLeftWidth(state: AppViewState, width: number) {
  const ws = getWs(state);
  const clamped = Math.min(MAX_LEFT, Math.max(MIN_LEFT, Math.round(width)));
  ws.leftWidth = clamped;
  state.requestUpdate?.();
  try {
    localStorage.setItem(`${LS_KEY_PREFIX}leftWidth`, String(clamped));
  } catch {}
}

/**
 * Begin a drag to resize the left pane. Attaches window-level listeners
 * so we keep tracking even when the cursor leaves the handle's hit area;
 * cleans them up on mouseup.
 */
export function beginLeftResize(state: AppViewState, startEvent: PointerEvent) {
  const ws = getWs(state);
  ws.resizingLeft = true;
  state.requestUpdate?.();

  const startX = startEvent.clientX;
  const startWidth = ws.leftWidth;

  const onMove = (e: PointerEvent) => {
    setLeftWidth(state, startWidth + (e.clientX - startX));
  };
  const onUp = () => {
    ws.resizingLeft = false;
    state.requestUpdate?.();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

// ── Coder mode (Tasks / TUI / Agent) ────────────────────────────────

export async function setCoderMode(
  state: AppViewState,
  client: GatewayBrowserClient,
  mode: CoderMode,
) {
  const ws = getWs(state);
  if (ws.coderMode === mode) return;
  ws.coderMode = mode;
  state.requestUpdate?.();
  if (mode === "tui") {
    void ensureTuiTerminal(state, client);
  } else if (mode === "agent") {
    void loadAgentHistory(state, client);
  }
}

/**
 * Make sure a Claude TUI terminal is registered + spawned for the active
 * workspace. Mirrors the exact spawn flow that the masonry-grid Terminal
 * panel uses (the working reference): init terminalsState, snapshot
 * session ids, call the public `createTerminalSession`, then diff to find
 * the freshly-created session. After the session lands, schedule a few
 * `fit()` kicks against the xterm instance — the parent layout often
 * settles a frame or two after the session id flips, so without these
 * kicks `handleTerminalReady` never fires and the panel stays black.
 */
export async function ensureTuiTerminal(
  state: AppViewState,
  _client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  const entry = ws.workspaces.find((w) => w.id === ws.selectedId);
  if (!entry) return;
  if (ws.tuiTerminalId) return;
  ws.tuiStarting = true;
  state.requestUpdate?.();

  try {
    const { createInitialTerminalsState, createTerminalSession, getXtermInstance } =
      await import("./terminals.js");
    if (!state.terminalsState) {
      state.terminalsState = createInitialTerminalsState();
    }
    const ts = state.terminalsState!;

    // Reuse an existing claude session for the same workspace dir — flip
    // mode round-trips and page refreshes shouldn't keep stacking up new
    // CLI processes.
    const existing = ts.sessions.find(
      (s) => s.cli === "claude" && s.cwd === entry.path,
    );
    if (existing) {
      ws.tuiTerminalId = existing.id;
      ts.activeSessionId = existing.id;
      ws.tuiStarting = false;
      state.requestUpdate?.();
      kickXtermFit(getXtermInstance, existing.id);
      return;
    }

    const before = new Set(ts.sessions.map((s) => s.id));
    await createTerminalSession(state, {
      cli: "claude",
      cwd: entry.path,
      name: `Claude · ${entry.name}`,
      projectId: entry.projectId,
      count: 1,
      oneOfEachCli: false,
      nodeId: "local",
    });
    const fresh = ts.sessions.find((s) => !before.has(s.id));
    if (fresh) {
      ws.tuiTerminalId = fresh.id;
      ts.activeSessionId = fresh.id;
      kickXtermFit(getXtermInstance, fresh.id);
    } else {
      ws.error = "Could not spawn Claude TUI";
    }
  } catch (err) {
    ws.error = (err as Error).message;
  } finally {
    ws.tuiStarting = false;
    state.requestUpdate?.();
  }
}

/**
 * Re-fire xterm fit() at progressively later moments so the PTY-ready
 * handshake fires once the parent layout has actually settled. Same trick
 * the masonry-grid Terminal panel uses to dodge the 0×0 mount race.
 */
function kickXtermFit(
  getXtermInstance: (id: string) => { fit?: () => void; focus?: () => void } | undefined,
  terminalId: string,
) {
  const kick = () => {
    const xt = getXtermInstance(terminalId);
    if (!xt) return false;
    try { xt.fit?.(); } catch { /* fit on 0×0 is fine */ }
    try { xt.focus?.(); } catch { /* ignore */ }
    return true;
  };
  requestAnimationFrame(() => requestAnimationFrame(kick));
  setTimeout(kick, 100);
  setTimeout(kick, 350);
  setTimeout(kick, 800);
}

/** Re-spawn the TUI (e.g. after a `claude` exit). */
export async function restartTuiTerminal(
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  if (ws.tuiTerminalId) {
    try {
      // Served method is `terminal.destroy` — `terminal.close` never existed.
      await client.request("terminal.destroy", { id: ws.tuiTerminalId });
    } catch {
      /* swallow — terminal may already be gone */
    }
    if (state.terminalsState) {
      state.terminalsState.sessions = state.terminalsState.sessions.filter(
        (s) => s.id !== ws.tuiTerminalId,
      );
    }
    ws.tuiTerminalId = null;
  }
  await ensureTuiTerminal(state, client);
}

// ── Native agent chat (mode = "agent") ──────────────────────────────

interface ChatMessageBlock {
  type?: string;
  text?: string;
}

function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ChatMessageBlock[])
    .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
    .map((b) => b.text ?? "")
    .join("");
}

export async function loadAgentHistory(
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  if (!ws.agentSessionKey || ws.agentLoading) return;
  ws.agentLoading = true;
  state.requestUpdate?.();
  try {
    const [res, sessionList] = await Promise.all([
      client.request<{ messages?: Array<{ role: string; content: unknown; timestamp?: number }> }>(
        "chat.history",
        { sessionKey: ws.agentSessionKey, limit: 100 },
      ),
      client.request<{ defaults?: { model?: string | null; modelProvider?: string | null } }>(
        "sessions.list",
        { search: ws.agentSessionKey, limit: 1 },
      ).catch(() => null),
    ]);
    const defaults = sessionList?.defaults;
    ws.agentDefaultModel = defaults?.model
      ? defaults.modelProvider
        ? `${defaults.modelProvider}/${defaults.model}`
        : defaults.model
      : ws.agentDefaultModel;
    const msgs = (res?.messages ?? []).map((m) => ({
      role: (m.role === "assistant" || m.role === "user" ? m.role : "system") as
        | "user"
        | "assistant"
        | "system",
      text: blocksToText(m.content),
      ts: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
    }));
    ws.agentMessages = msgs.filter((m) => m.text.trim().length > 0);
  } catch (err) {
    /* silent — empty history is fine for new workspaces */
  } finally {
    ws.agentLoading = false;
    ws.agentHistoryLoaded = true;
    state.requestUpdate?.();
  }
}

export function setAgentInput(state: AppViewState, value: string) {
  const ws = getWs(state);
  ws.agentInput = value;
  state.requestUpdate?.();
}

export async function sendAgentMessage(
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  const text = ws.agentInput.trim();
  if (!text || ws.agentSending || !ws.agentSessionKey) return;
  ws.agentMessages.push({ role: "user", text, ts: Date.now() });
  ws.agentMessages.push({
    role: "assistant",
    text: "…",
    ts: Date.now(),
    pending: true,
  });
  ws.agentInput = "";
  ws.agentSending = true;
  state.requestUpdate?.();

  const idempotencyKey = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Every visual-agent turn gets a durable restore point. Keeping this in
    // the native chat path makes the polished UI as safe as detached coder
    // runs without exposing the raw CLI as the primary experience.
    if (ws.selectedId) {
      try {
        await client.request("workspace.version.create", {
          directoryId: ws.selectedId,
          description: `Before agent turn: ${text.slice(0, 80)}`,
        });
        await loadWorkspaceVersions(state, client);
      } catch {
        // Non-git directories can still use the agent chat.
      }
    }
    await client.request("chat.send", {
      sessionKey: ws.agentSessionKey,
      message: ws.selectedElement && !text.includes(ws.selectedElement.selector)
        ? `${text}${selectionContext(ws.selectedElement)}`
        : text,
      deliver: false,
      idempotencyKey,
    });
    // Replies come back via the `chat` broadcast we subscribe to elsewhere.
    // Poll history once after a short delay as a safety net for slow streams.
    setTimeout(() => {
      void loadAgentHistory(state, client);
    }, 1500);
  } catch (err) {
    const last = ws.agentMessages[ws.agentMessages.length - 1];
    if (last) {
      last.text = `Error: ${(err as Error).message}`;
      last.pending = false;
    }
  } finally {
    ws.agentSending = false;
    state.requestUpdate?.();
  }
}

/** Hook into the gateway client's chat broadcasts so streamed assistant
 *  messages refresh the agent panel without a manual reload. */
let chatUnsub: (() => void) | null = null;

function attachChatStream(state: AppViewState, client: GatewayBrowserClient) {
  if (chatUnsub) return;
  chatUnsub = client.subscribe?.((evt: { type?: string; data?: unknown }) => {
    if (evt?.type !== "chat") return;
    const ws = getWs(state);
    if (ws.coderMode !== "agent" || !ws.agentSessionKey) return;
    const data = evt.data as { sessionKey?: string } | undefined;
    if (data?.sessionKey && data.sessionKey !== ws.agentSessionKey) return;
    // Cheap refresh — chat.history is fast (<10ms) for short transcripts.
    void loadAgentHistory(state, client);
  }) ?? null;
}

// ── Templates + Components ──────────────────────────────────────────

export function getTemplateLibrary(): WorkspaceTemplate[] {
  return TEMPLATE_LIBRARY;
}

export function getComponentLibrary(): ComponentSnippet[] {
  return COMPONENT_LIBRARY;
}

export function openTemplatesGallery(state: AppViewState) {
  const ws = getWs(state);
  ws.templatesOpen = true;
  state.requestUpdate?.();
}

export function closeTemplatesGallery(state: AppViewState) {
  const ws = getWs(state);
  ws.templatesOpen = false;
  state.requestUpdate?.();
}

export function toggleComponentsPanel(state: AppViewState) {
  const ws = getWs(state);
  ws.componentsOpen = !ws.componentsOpen;
  state.requestUpdate?.();
}

/**
 * User clicked a template card. If the template has a `binding` spec we open
 * the bind dialog and stash the pending template; otherwise we apply right
 * away with no binding.
 */
export async function chooseTemplate(
  state: AppViewState,
  client: GatewayBrowserClient,
  templateId: string,
) {
  const tpl = findTemplate(templateId);
  if (!tpl) return;
  const ws = getWs(state);
  ws.templatesOpen = false;
  if (tpl.binding) {
    ws.pendingTemplate = tpl;
    ws.pendingSnippet = null;
    await openBindDialog(state, client, tpl.binding);
  } else {
    await applyTemplateInternal(state, client, tpl, null);
  }
}

/**
 * User clicked a snippet in the right rail. Same flow as chooseTemplate
 * but inserts at the active editor's cursor (or appends if no tab is open).
 */
export async function chooseSnippet(
  state: AppViewState,
  client: GatewayBrowserClient,
  snippetId: string,
) {
  const snip = findSnippet(snippetId);
  if (!snip) return;
  const ws = getWs(state);
  if (snip.binding) {
    ws.pendingSnippet = snip;
    ws.pendingTemplate = null;
    await openBindDialog(state, client, snip.binding);
  } else {
    insertSnippetIntoActive(state, snip, null);
  }
}

// ── Bind-form dialog ────────────────────────────────────────────────

async function openBindDialog(
  state: AppViewState,
  client: GatewayBrowserClient,
  spec: TemplateBindingSpec,
) {
  const ws = getWs(state);
  ws.bindOpen = true;
  ws.bindMode = "existing";
  ws.bindDatabaseId = "";
  ws.bindNewName = spec.newDatabaseName ?? "";
  ws.bindDatabaseChoices = [];
  state.requestUpdate?.();

  // Populate the dropdown with the user's databases.
  try {
    const res = await client.request<{ databases: Array<{ id: string; name: string; slug: string }> }>(
      "db.list",
      {},
    );
    ws.bindDatabaseChoices = res?.databases ?? [];
    // If the spec has a `defaultRole`, try to preselect that database.
    if (spec.defaultRole) {
      try {
        const def = await client.request<{ resolved?: { database?: { id: string } } }>(
          "db.system.resolve",
          { role: spec.defaultRole },
        );
        const dbId = def?.resolved?.database?.id;
        if (dbId) ws.bindDatabaseId = dbId;
      } catch {
        /* role unset; fine */
      }
    }
    if (!ws.bindDatabaseId && ws.bindDatabaseChoices[0]) {
      ws.bindDatabaseId = ws.bindDatabaseChoices[0].id;
    }
  } catch {
    /* no DBs to show */
  }
  state.requestUpdate?.();
}

export function closeBindDialog(state: AppViewState) {
  const ws = getWs(state);
  ws.bindOpen = false;
  ws.pendingTemplate = null;
  ws.pendingSnippet = null;
  state.requestUpdate?.();
}

export function setBindMode(state: AppViewState, mode: "existing" | "new") {
  const ws = getWs(state);
  ws.bindMode = mode;
  state.requestUpdate?.();
}

export function setBindDatabaseId(state: AppViewState, id: string) {
  const ws = getWs(state);
  ws.bindDatabaseId = id;
  state.requestUpdate?.();
}

export function setBindNewName(state: AppViewState, name: string) {
  const ws = getWs(state);
  ws.bindNewName = name;
  state.requestUpdate?.();
}

/**
 * Confirms the bind dialog. Either reuses an existing database or creates a
 * new one with the template's seed properties, then registers a form binding
 * on the gateway and applies the template (rewriting __FORM_ACTION__ in
 * every file).
 */
export async function confirmBind(
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  const spec =
    ws.pendingTemplate?.binding ?? ws.pendingSnippet?.binding ?? null;
  if (!spec) {
    ws.bindOpen = false;
    state.requestUpdate?.();
    return;
  }

  let databaseId = ws.bindDatabaseId;
  try {
    if (ws.bindMode === "new") {
      const name = ws.bindNewName.trim();
      if (!name) {
        ws.error = "Database name required";
        state.requestUpdate?.();
        return;
      }
      const created = await client.request<{ database: { id: string } }>("db.create", {
        name,
        properties: spec.newDatabaseProperties ?? [],
      });
      databaseId = created?.database?.id ?? "";
    }
    if (!databaseId) {
      ws.error = "Pick a database or create a new one";
      state.requestUpdate?.();
      return;
    }

    const fieldMap: Record<string, string> = {};
    for (const f of spec.fields) fieldMap[f.formField] = f.propertyName;

    const bindingRes = await client.request<{ binding: { id: string } }>(
      "forms.bindings.create",
      {
        name: `${ws.workspaces.find((w) => w.id === ws.selectedId)?.name ?? "Workspace"} — ${spec.label}`,
        databaseId,
        fieldMap,
        titleTemplate: spec.titleTemplate,
        meta: {
          workspaceId: ws.selectedId,
          templateId: ws.pendingTemplate?.id,
          snippetId: ws.pendingSnippet?.id,
        },
      },
    );
    const bindingId = bindingRes?.binding?.id ?? "";
    if (!bindingId) {
      ws.error = "Failed to create form binding";
      state.requestUpdate?.();
      return;
    }

    if (ws.pendingTemplate) {
      await applyTemplateInternal(state, client, ws.pendingTemplate, bindingId);
    } else if (ws.pendingSnippet) {
      insertSnippetIntoActive(state, ws.pendingSnippet, bindingId);
    }

    ws.bindOpen = false;
    ws.pendingTemplate = null;
    ws.pendingSnippet = null;
  } catch (err) {
    ws.error = (err as Error).message;
  } finally {
    state.requestUpdate?.();
  }
}

// ── Apply template ──────────────────────────────────────────────────

function buildFormActionUrl(bindingId: string): string {
  // Same-origin so it works whether the site is served by the gateway
  // (default) or proxied behind a tunnel — for fully external hosting the
  // user can manually replace the action attribute with an absolute URL.
  return `/api/forms/${bindingId}/submit`;
}

async function applyTemplateInternal(
  state: AppViewState,
  client: GatewayBrowserClient,
  tpl: WorkspaceTemplate,
  bindingId: string | null,
) {
  const ws = getWs(state);
  const entry = ws.workspaces.find((w) => w.id === ws.selectedId);
  if (!entry) return;
  ws.applyingTemplate = true;
  state.requestUpdate?.();

  try {
    const action = bindingId ? buildFormActionUrl(bindingId) : "/api/forms/REPLACE_ME/submit";
    for (const file of tpl.files) {
      const targetAbs = `${entry.path.replace(/\\/g, "/").replace(/\/$/, "")}/${file.path}`;
      const content = file.content
        .replace(/__FORM_ACTION__/g, action)
        .replace(/\{\{\s*workspace\s*\}\}/g, entry.name);
      await client.request("files.write", { path: targetAbs, content });
    }

    // Refresh the tree + open the entry file (index.html or README.md).
    await loadTree(state, client);
    const main = tpl.files.find((f) => f.path === "index.html") ?? tpl.files[0];
    if (main) {
      const targetAbs = `${entry.path.replace(/\\/g, "/").replace(/\/$/, "")}/${main.path}`;
      await openFile(state, client, targetAbs);
    }

    // Switch view to Preview so the user immediately sees their site if a
    // dev URL is set; otherwise Code mode shows the scaffolded HTML.
    if (ws.devUrl) ws.viewMode = "preview";
  } catch (err) {
    ws.error = (err as Error).message;
  } finally {
    ws.applyingTemplate = false;
    state.requestUpdate?.();
  }
}

// ── Snippet insert ──────────────────────────────────────────────────

function insertSnippetIntoActive(
  state: AppViewState,
  snip: ComponentSnippet,
  bindingId: string | null,
) {
  const ws = getWs(state);
  const tab = ws.tabs.find((t) => t.path === ws.activeTabPath);
  const action = bindingId ? buildFormActionUrl(bindingId) : "/api/forms/REPLACE_ME/submit";
  const source = snip.source.replace(/__FORM_ACTION__/g, action);
  if (!tab) {
    ws.error = "Open a file first, then insert the snippet.";
    state.requestUpdate?.();
    return;
  }
  // Append to the tab body (cursor-aware insert would need a ref into the
  // textarea; a simple append keeps state simple and the user can move the
  // text where they need with the editor).
  tab.content = tab.content.endsWith("\n")
    ? tab.content + "\n" + source + "\n"
    : tab.content + "\n\n" + source + "\n";
  tab.dirty = tab.content !== tab.original;
  state.requestUpdate?.();
}

// ── Diff helper (LCS-based line diff for the Diff view) ─────────────

export interface DiffLine {
  kind: "context" | "add" | "remove";
  oldNum?: number;
  newNum?: number;
  text: string;
}

/** Minimal LCS line diff. Good enough for ~5K-line files. */
export function diffLines(original: string, modified: string): DiffLine[] {
  const a = original.split("\n");
  const b = modified.split("\n");
  const m = a.length;
  const n = b.length;
  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNum = 1;
  let newNum = 1;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", oldNum: oldNum++, newNum: newNum++, text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "remove", oldNum: oldNum++, text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", newNum: newNum++, text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ kind: "remove", oldNum: oldNum++, text: a[i++]! });
  while (j < n) out.push({ kind: "add", newNum: newNum++, text: b[j++]! });
  return out;
}

// ── Polling lifecycle ───────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startWorkspacePolling(state: AppViewState, client: GatewayBrowserClient) {
  if (pollTimer) return;
  void loadWorkspaces(state, client);
  attachChatStream(state, client);
  pollTimer = setInterval(() => {
    const ws = getWs(state);
    if (!ws.selectedId) return;
    void loadTree(state, client);
    void loadLinkedBusinessRows(state, client);
  }, 15_000);
}

export function stopWorkspacePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (chatUnsub) {
    chatUnsub();
    chatUnsub = null;
  }
}

// ── Convenience accessor for the view layer ────────────────────────

export function getWorkspaceState(state: AppViewState): WorkspaceState {
  return getWs(state);
}

// ── Live development runtime ───────────────────────────────────────

export function setPreviewRoute(state: AppViewState, route: string): void {
  const ws = getWs(state);
  ws.previewRoute = route.startsWith("/") ? route : `/${route}`;
  state.requestUpdate?.();
}

export function setPreviewDevice(state: AppViewState, mode: WorkspaceDeviceMode): void {
  getWs(state).previewDevice = mode;
  state.requestUpdate?.();
}

export function setWorkspaceMobileSurface(
  state: AppViewState,
  surface: WorkspaceMobileSurface,
): void {
  getWs(state).mobileSurface = surface;
  state.requestUpdate?.();
}

export function toggleWorkspaceOverflow(state: AppViewState, open?: boolean): void {
  const ws = getWs(state);
  ws.overflowOpen = open ?? !ws.overflowOpen;
  state.requestUpdate?.();
}

export function toggleWorkspaceCommandPalette(state: AppViewState, open?: boolean): void {
  const ws = getWs(state);
  ws.commandPaletteOpen = open ?? !ws.commandPaletteOpen;
  state.requestUpdate?.();
}

export function toggleWorkspaceWorkbench(state: AppViewState, open?: boolean): void {
  const ws = getWs(state);
  ws.workbenchOpen = open ?? !ws.workbenchOpen;
  state.requestUpdate?.();
}

export function toggleWorkspaceTerminalDrawer(state: AppViewState, open?: boolean): void {
  const ws = getWs(state);
  ws.terminalDrawerOpen = open ?? !ws.terminalDrawerOpen;
  if (ws.terminalDrawerOpen) ws.coderMode = "tui";
  state.requestUpdate?.();
}

export async function setWorkspaceAgentModel(
  state: AppViewState,
  client: GatewayBrowserClient,
  model: string | null,
): Promise<void> {
  const ws = getWs(state);
  if (!ws.agentSessionKey) return;
  await client.request("sessions.patch", { key: ws.agentSessionKey, model });
  ws.agentModel = model;
  state.requestUpdate?.();
}

export async function setWorkspaceAgentThinking(
  state: AppViewState,
  client: GatewayBrowserClient,
  level: string | null,
): Promise<void> {
  const ws = getWs(state);
  if (!ws.agentSessionKey) return;
  await client.request("sessions.patch", { key: ws.agentSessionKey, thinkingLevel: level });
  ws.agentThinkingLevel = level;
  state.requestUpdate?.();
}

export function attachSelectedElementToAgent(state: AppViewState): void {
  const ws = getWs(state);
  if (!ws.selectedElement) return;
  const selection = selectionContext(ws.selectedElement).trim();
  ws.agentInput = ws.agentInput.trim()
    ? `${ws.agentInput.trim()}\n\n${selection}`
    : `Update this selected element.\n\n${selection}`;
  state.requestUpdate?.();
}

export function setInspectorEnabled(state: AppViewState, enabled: boolean): void {
  getWs(state).inspectorEnabled = enabled;
  state.requestUpdate?.();
}

/** Mark a project as explicitly opened this session (eligible for auto-start). */
export function markWorkspaceExplicitlyOpened(state: AppViewState, directoryId: string): void {
  const ws = getWs(state);
  if (!ws.runtimeExplicitIds.includes(directoryId)) ws.runtimeExplicitIds.push(directoryId);
}

/**
 * Auto-start gate: the setting must be on AND the project must have been
 * explicitly opened in this UI session. Exported for tests.
 */
export function shouldAutoStartRuntime(
  ws: WorkspaceState,
  directoryId: string,
  detection: WorkspaceRuntimeDetection,
  server: WorkspaceRuntimeServer | null,
): boolean {
  return (
    ws.runtimeAutoStart &&
    ws.runtimeExplicitIds.includes(directoryId) &&
    (!server || ["stopped", "error"].includes(server.status)) &&
    !detection.missingDependencies &&
    detection.kind !== "unknown"
  );
}

/**
 * The operator picked the project that is already selected (typically the
 * one restored on page load). Promote it to explicitly opened and re-run the
 * runtime load so auto-start applies if enabled.
 */
export async function openActiveWorkspaceExplicitly(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const ws = getWs(state);
  if (!ws.selectedId || ws.runtimeExplicitIds.includes(ws.selectedId)) return;
  markWorkspaceExplicitlyOpened(state, ws.selectedId);
  await loadWorkspaceRuntime(state, client);
}

export function setRuntimeAutoStart(state: AppViewState, enabled: boolean): void {
  getWs(state).runtimeAutoStart = enabled;
  try { localStorage.setItem(`${LS_KEY_PREFIX}autoStart`, String(enabled)); } catch {}
  state.requestUpdate?.();
}

export async function loadWorkspaceVersions(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ws = getWs(state);
  if (!ws.selectedId) return;
  try {
    const res = await client.request<{ versions?: WorkspaceVersionEntry[] }>("workspace.version.list", { directoryId: ws.selectedId });
    ws.versions = res?.versions ?? [];
  } catch { ws.versions = []; }
  state.requestUpdate?.();
}

export async function showWorkspaceVersionDiff(state: AppViewState, client: GatewayBrowserClient, versionId: string): Promise<void> {
  const ws = getWs(state);
  if (!ws.selectedId) return;
  try {
    const res = await client.request<{ diff?: string }>("workspace.version.diff", { directoryId: ws.selectedId, versionId });
    ws.versionDiff = res?.diff ?? "No changes in this checkpoint.";
    ws.versionsOpen = true;
  } catch (err) { ws.versionDiff = (err as Error).message; }
  state.requestUpdate?.();
}

export async function revertWorkspaceVersionAction(state: AppViewState, client: GatewayBrowserClient, versionId: string): Promise<void> {
  const ws = getWs(state);
  if (!ws.selectedId) return;
  await client.request("workspace.version.revert", { directoryId: ws.selectedId, versionId });
  await Promise.all([loadTree(state, client), ...ws.tabs.map((tab) => reloadTab(state, client, tab.path))]);
  reloadPreview(state);
}

async function pollWorkspaceRuntime(state: AppViewState, client: GatewayBrowserClient, token: number): Promise<void> {
  const ws = getWs(state);
  if (!ws.selectedId || ws.runtimePollToken !== token) return;
  try {
    ws.runtimeServer = await client.request<WorkspaceRuntimeServer | null>("workspace.dev.status", { directoryId: ws.selectedId });
    const logs = await client.request<{ text?: string; cursor?: number }>("workspace.dev.logs", { directoryId: ws.selectedId, cursor: ws.runtimeLogCursor });
    if (logs?.text) ws.runtimeLogs = `${ws.runtimeLogs}${logs.text}`.slice(-120_000);
    ws.runtimeLogCursor = logs?.cursor ?? ws.runtimeLogCursor;
    if (ws.runtimeServer?.status === "ready") ws.viewMode = "preview";
  } catch (err) { ws.error = (err as Error).message; }
  state.requestUpdate?.();
  if (ws.runtimePollToken === token && ["installing", "starting", "ready"].includes(ws.runtimeServer?.status ?? "")) {
    const delay = ws.runtimeServer?.status === "ready" ? 2_500 : 900;
    window.setTimeout(() => void pollWorkspaceRuntime(state, client, token), delay);
  }
}

export async function loadWorkspaceRuntime(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ws = getWs(state);
  const directoryId = ws.selectedId;
  if (!directoryId) return;
  const token = ws.runtimePollToken;
  ws.runtimeLoading = true;
  state.requestUpdate?.();
  try {
    const [detection, server] = await Promise.all([
      client.request<WorkspaceRuntimeDetection>("workspace.dev.detect", { directoryId }),
      client.request<WorkspaceRuntimeServer | null>("workspace.dev.status", { directoryId }),
    ]);
    if (ws.selectedId !== directoryId || ws.runtimePollToken !== token) return;
    ws.runtimeDetection = detection;
    ws.runtimeServer = server;
    void loadWorkspaceVersions(state, client);
    if (shouldAutoStartRuntime(ws, directoryId, detection, server)) {
      await startWorkspaceServer(state, client, false);
    } else if (server && ["installing", "starting", "ready"].includes(server.status)) {
      void pollWorkspaceRuntime(state, client, token);
    }
  } catch (err) { ws.error = (err as Error).message; }
  finally { ws.runtimeLoading = false; state.requestUpdate?.(); }
}

export async function startWorkspaceServer(state: AppViewState, client: GatewayBrowserClient, install: boolean): Promise<void> {
  const ws = getWs(state);
  if (!ws.selectedId) return;
  ws.runtimeLoading = true;
  ws.error = null;
  state.requestUpdate?.();
  try {
    const res = await client.request<{ record?: WorkspaceRuntimeServer; detection?: WorkspaceRuntimeDetection }>("workspace.dev.start", {
      directoryId: ws.selectedId,
      appPath: ws.runtimeDetection?.appPath,
      install,
    });
    ws.runtimeServer = res?.record ?? null;
    if (res?.detection) ws.runtimeDetection = res.detection;
    ws.runtimeLogs = "";
    ws.runtimeLogCursor = 0;
    const token = ++ws.runtimePollToken;
    void pollWorkspaceRuntime(state, client, token);
  } catch (err) { ws.error = (err as Error).message; }
  finally { ws.runtimeLoading = false; state.requestUpdate?.(); }
}

export async function stopWorkspaceServer(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ws = getWs(state);
  if (!ws.selectedId) return;
  ws.runtimePollToken += 1;
  ws.runtimeServer = await client.request<WorkspaceRuntimeServer | null>("workspace.dev.stop", { directoryId: ws.selectedId });
  state.requestUpdate?.();
}

export async function restartWorkspaceServer(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ws = getWs(state);
  if (!ws.selectedId) return;
  ws.runtimeLoading = true;
  state.requestUpdate?.();
  try {
    const res = await client.request<{ record?: WorkspaceRuntimeServer }>("workspace.dev.restart", { directoryId: ws.selectedId, appPath: ws.runtimeDetection?.appPath });
    ws.runtimeServer = res?.record ?? null;
    ws.runtimeLogs = "";
    ws.runtimeLogCursor = 0;
    const token = ++ws.runtimePollToken;
    void pollWorkspaceRuntime(state, client, token);
  } finally { ws.runtimeLoading = false; state.requestUpdate?.(); }
}

export function installWorkspaceInspectorBridge(state: AppViewState, client: GatewayBrowserClient): void {
  const marker = state as unknown as { workspaceInspectorBridge?: boolean };
  if (marker.workspaceInspectorBridge) return;
  marker.workspaceInspectorBridge = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object") return;
    const payload = event.data as Record<string, unknown>;
    if (payload.type !== "infinibot:element-selected") return;
    const ws = getWs(state);
    if (!ws.selectedId || payload.directoryId !== ws.selectedId) return;
    ws.selectedElement = {
      selector: String(payload.selector ?? ""),
      tag: String(payload.tag ?? ""),
      text: String(payload.text ?? ""),
      html: String(payload.html ?? ""),
      source: typeof payload.source === "string" ? payload.source : null,
      screenshotPath: null,
    };
    const context = selectionContext(ws.selectedElement).trim();
    if (!ws.agentInput.includes(ws.selectedElement.selector)) {
      ws.agentInput = ws.agentInput.trim()
        ? `${ws.agentInput.trim()}\n\n${context}`
        : `Update this selected element.\n\n${context}`;
    }
    state.requestUpdate?.();
    if (typeof payload.screenshot === "string" && payload.screenshot.startsWith("data:image/png")) {
      void client.request<{ path?: string }>("workspace.inspector.save", { directoryId: ws.selectedId, dataUrl: payload.screenshot }).then((res) => {
        if (ws.selectedElement && res?.path) ws.selectedElement.screenshotPath = res.path;
        state.requestUpdate?.();
      }).catch(() => undefined);
    }
  });
}

export async function runWorkspaceVisualVerify(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ws = getWs(state);
  const preview = getPreviewUrl(ws);
  if (!preview) return;
  ws.visualVerifyRunning = true;
  state.requestUpdate?.();
  try {
    const res = await client.request<{ screenshots?: string[] }>("verification.visual", {
      baseUrl: window.location.origin,
      gatewayPort: Number(window.location.port || (window.location.protocol === "https:" ? 443 : 80)),
      routes: [preview.split("?")[0]],
      expectation: "The workspace preview renders successfully without an error overlay, clipping, or broken responsive layout.",
      viewports: [{ width: 1440, height: 900 }, { width: 390, height: 844 }],
      themes: ["dark", "light"],
    });
    ws.visualVerifyScreenshots = res?.screenshots ?? [];
  } catch (err) { ws.error = (err as Error).message; }
  finally { ws.visualVerifyRunning = false; state.requestUpdate?.(); }
}

// ── Project mode ────────────────────────────────────────────────────

export function setProjectMode(state: AppViewState, mode: ProjectMode) {
  const ws = getWs(state);
  ws.projectMode = mode;
  ws.slideIndex = 0;
  state.requestUpdate?.();
  if (ws.selectedId) savePrefs(ws.selectedId, { projectMode: mode });
}

/**
 * Examine the workspace file tree to pick a sensible default mode.
 * Priority: explicit prefs → tree heuristics → "web".
 */
export async function detectProjectMode(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const ws = getWs(state);
  if (!ws.selectedId) return;

  // Saved preference wins.
  const prefs = loadPrefs(ws.selectedId);
  if (prefs.projectMode) {
    ws.projectMode = prefs.projectMode as ProjectMode;
    state.requestUpdate?.();
    return;
  }

  // Tree-based heuristics.
  const entry = ws.workspaces.find((w) => w.id === ws.selectedId);
  if (!entry) return;

  try {
    const tree = await client.request<{ children?: Array<{ name: string }> }>(
      "files.tree",
      { path: entry.path, depth: 1 },
    );
    const names = (tree?.children ?? []).map((c) => c.name.toLowerCase());
    const hasPackageJson = names.includes("package.json");
    const hasIndexHtml = names.includes("index.html");
    const hasSlidesOrPresentation = names.some(
      (n) => n.includes("slide") || n.includes("presentation") || n.includes("deck"),
    );
    const hasReadmeOrDocs = names.some((n) => /^readme|^docs?/i.test(n));

    // If there's a package.json, decide web vs app by checking its contents.
    if (hasPackageJson) {
      try {
        const res = await client.request<{ content: string }>("files.read", {
          path: `${entry.path.replace(/\\/g, "/").replace(/\/$/, "")}/package.json`,
        });
        const pkg = res?.content ? JSON.parse(res.content) : {};
        const scripts = Object.keys(pkg.scripts ?? {});
        const isElectron = !!pkg.dependencies?.electron || !!pkg.devDependencies?.electron;
        const hasStartOrDev = scripts.some((s) => ["start", "dev", "electron"].includes(s));
        ws.projectMode = isElectron || (hasStartOrDev && !hasIndexHtml) ? "app" : "web";
      } catch {
        ws.projectMode = "web";
      }
    } else if (hasSlidesOrPresentation) {
      ws.projectMode = "presentation";
    } else if (hasReadmeOrDocs && !hasIndexHtml) {
      ws.projectMode = "document";
    } else {
      ws.projectMode = "web";
    }
  } catch {
    ws.projectMode = "web";
  }
  state.requestUpdate?.();
}

// ── Multi-pane preview ──────────────────────────────────────────────

export function addPreviewPane(
  state: AppViewState,
  renderer: PreviewPane["renderer"],
  label: string,
) {
  const ws = getWs(state);
  if (ws.previewPanes.length >= 2) return; // max 2 extra panes
  ws.previewPanes = [
    ...ws.previewPanes,
    { id: `pp_${Date.now()}`, renderer, label },
  ];
  state.requestUpdate?.();
}

export function removePreviewPane(state: AppViewState, id: string) {
  const ws = getWs(state);
  ws.previewPanes = ws.previewPanes.filter((p) => p.id !== id);
  state.requestUpdate?.();
}

// ── Slide navigation ────────────────────────────────────────────────

export function setSlideIndex(state: AppViewState, idx: number) {
  const ws = getWs(state);
  ws.slideIndex = Math.max(0, idx);
  state.requestUpdate?.();
}

// ── Workflow picker ─────────────────────────────────────────────────

export async function openWorkflowPicker(
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const ws = getWs(state);
  ws.workflowPickerOpen = true;
  ws.workflowsLoading = true;
  state.requestUpdate?.();
  try {
    const res = await client.request<
      | Array<{ id: string; name: string; description?: string; kind?: string }>
      | { workflows?: Array<{ id: string; name: string; description?: string; kind?: string }> }
    >("workflows.list", {});
    const list = Array.isArray(res)
      ? res
      : (res as { workflows?: Array<{ id: string; name: string; description?: string; kind?: string }> }).workflows ?? [];
    ws.availableWorkflows = list.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      kind: w.kind,
    }));
  } catch {
    ws.availableWorkflows = [];
  } finally {
    ws.workflowsLoading = false;
    state.requestUpdate?.();
  }
}

export function closeWorkflowPicker(state: AppViewState) {
  const ws = getWs(state);
  ws.workflowPickerOpen = false;
  state.requestUpdate?.();
}

/**
 * Run a workflow against the current workspace, streaming the launch result
 * into the coder chat as a system message.
 */
export async function runWorkflowInChat(
  state: AppViewState,
  client: GatewayBrowserClient,
  workflowId: string,
) {
  const ws = getWs(state);
  const entry = ws.workspaces.find((w) => w.id === ws.selectedId);
  const workflow = ws.availableWorkflows.find((w) => w.id === workflowId);
  if (!entry || !workflow) return;

  ws.workflowPickerOpen = false;
  ws.workflowRunning = true;
  const placeholder: CoderMessage = {
    id: `wf_${Date.now()}`,
    role: "system",
    text: `Running workflow "${workflow.name}"…`,
    ts: Date.now(),
    pending: true,
  };
  ws.coderMessages.push(placeholder);
  state.requestUpdate?.();

  try {
    // Served method is `workflows.run.start` (same params).
    const res = await client.request<{ runId?: string; result?: string }>(
      "workflows.run.start",
      {
        id: workflowId,
        inputs: {
          workdir: entry.path,
          projectId: entry.projectId,
          workspaceName: entry.name,
          mode: ws.projectMode,
          activeFile: ws.activeTabPath,
        },
      },
    );
    placeholder.text = res?.result ?? `Workflow "${workflow.name}" started.`;
    placeholder.pending = false;
    if (res?.runId) ws.workflowRunId = res.runId;
  } catch (err) {
    placeholder.text = `Workflow error: ${(err as Error).message}`;
    placeholder.pending = false;
  } finally {
    ws.workflowRunning = false;
    state.requestUpdate?.();
  }
}

// ── Quick actions (mode-aware, pure) ───────────────────────────────

export interface QuickAction {
  label: string;
  prompt: string;
}

export function quickActionsForMode(mode: ProjectMode): QuickAction[] {
  switch (mode) {
    case "document":
      return [
        { label: "Polish prose", prompt: "Polish the writing in the active file — improve clarity, rhythm, and concision without changing meaning." },
        { label: "Add callout", prompt: "Add a styled callout block to highlight the key insight in the current section." },
        { label: "Generate TOC", prompt: "Generate a table of contents for the active markdown file and insert it after the title." },
        { label: "Fix headings", prompt: "Review the heading hierarchy in this document and fix any level jumps." },
      ];
    case "presentation":
      return [
        { label: "Regen slide", prompt: "Rewrite the current slide to be more impactful — punchy title, 3-bullet body max." },
        { label: "Add speaker notes", prompt: "Add speaker notes (<!-- notes: ... -->) to each slide with talking points." },
        { label: "Add slide", prompt: "Insert a new slide after the current one that elaborates on the previous point." },
        { label: "Pick theme", prompt: "Suggest a colour palette and font pairing for this presentation and apply it via CSS variables in a <style> slide." },
      ];
    case "pdf":
      return [
        { label: "Tighten layout", prompt: "Review the active file for PDF layout issues: orphaned headings, overly long paragraphs, missing page breaks. Suggest fixes." },
        { label: "Add cover page", prompt: "Generate a styled cover page section in the markdown." },
        { label: "Format tables", prompt: "Reformat all tables in the active file to look clean in print output." },
      ];
    case "app":
      return [
        { label: "Run dev server", prompt: "Check package.json and tell me the exact command to start the dev server for this app." },
        { label: "Fix build errors", prompt: "Read the last build output and fix any TypeScript or bundler errors." },
        { label: "Add feature", prompt: "Describe this app's current entry point and suggest the next highest-value feature to add." },
      ];
    case "web":
    default:
      return [
        { label: "Audit HTML", prompt: "Audit the active HTML file: accessibility issues, missing meta tags, broken image alts." },
        { label: "Optimise CSS", prompt: "Review the CSS in the active file and suggest performance and maintainability improvements." },
        { label: "Add component", prompt: "Based on the existing code style, scaffold a new reusable UI component in this project." },
      ];
  }
}
