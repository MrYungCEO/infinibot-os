/**
 * Focus Controller
 * 
 * Manages the Focus board state - a priority-sorted list of up to 5 items
 * that can be dragged from the kanban source below.
 */

import type { KanbanTask, KanbanProject } from "../types";

// Focus item can be either a task or a project
export interface FocusItem {
  id: string;
  type: "task" | "project";
  title: string;
  description?: string;
  status?: string;
  priority?: number; // 1-5, position in focus list
  projectName?: string;
  projectId?: string;
  addedAt: number;
  // Original data reference
  sourceTask?: KanbanTask;
  sourceProject?: KanbanProject;
}

export interface FocusState {
  items: FocusItem[];
  draggedItem: FocusItem | null;
  dragOverIndex: number | null;
  sourceCollapsed: boolean;
  sourceFilter: "all" | "tasks" | "projects";
  sourceSearch: string;
  sourceView: "list" | "kanban";
  sourceKanbanProject: string | null; // Selected project for kanban view
  loading: boolean;
  error: string | null;
}

const STORAGE_KEY = "infinibot-focus-items";
const MAX_FOCUS_ITEMS = 5;

/** Window event fired whenever the focus list mutates, so other views (e.g.
 *  /discipline) can re-render without a full reload. */
export const FOCUS_CHANGED_EVENT = "infinibot:focus-changed";

function emitFocusChanged(items: FocusItem[]): void {
  try {
    window.dispatchEvent(
      new CustomEvent(FOCUS_CHANGED_EVENT, { detail: { items } }),
    );
  } catch {
    /* non-browser / SSR — ignore */
  }
}

export function createFocusState(): FocusState {
  return {
    items: loadFocusItems(),
    draggedItem: null,
    dragOverIndex: null,
    sourceCollapsed: false,
    sourceFilter: "all",
    sourceSearch: "",
    sourceView: "list",
    sourceKanbanProject: null,
    loading: false,
    error: null,
  };
}

// Persist focus items to localStorage
function saveFocusItems(items: FocusItem[]): void {
  try {
    // Store minimal data for persistence
    const minimal = items.map(item => ({
      id: item.id,
      type: item.type,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      projectName: item.projectName,
      projectId: item.projectId,
      addedAt: item.addedAt,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(minimal));
  } catch (e) {
    console.error("[Focus] Failed to save items:", e);
  }
  // Persistence is the single mutation choke-point, so broadcasting here covers
  // every add / remove / reorder / clear path without per-caller wiring.
  emitFocusChanged(items);
  pushFocusToServer(items);
}

// ── Server mirror (Discipline plugin: discipline.focus.*) ────────────────
// The board used to live only in this browser's localStorage. The plugin
// keeps a server copy (plugin-data/discipline/focus.json) that agents' `focus`
// tool also reads; localStorage stays as the instant local cache.

type FocusRpcClient = { request: <T = unknown>(method: string, params?: unknown) => Promise<T> };
let focusServerClient: FocusRpcClient | null = null;
let focusPushTimer: ReturnType<typeof setTimeout> | null = null;

function minimalForServer(items: FocusItem[]) {
  return items.map((item) => ({
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.description,
    status: item.status,
    projectName: item.projectName,
    projectId: item.projectId,
    addedAt: item.addedAt,
  }));
}

function pushFocusToServer(items: FocusItem[], delayMs = 400): void {
  const client = focusServerClient;
  if (!client) return;
  if (focusPushTimer) clearTimeout(focusPushTimer);
  focusPushTimer = setTimeout(() => {
    focusPushTimer = null;
    void client
      .request("discipline.focus.set", { items: minimalForServer(items) })
      .catch(() => {
        /* plugin off / offline: localStorage still has it */
      });
  }, delayMs);
}

/**
 * Load the server copy and reconcile: server items win (agents may have
 * edited them); an empty server board is seeded once from this browser's
 * board. Returns the items now in effect, or null when the plugin isn't
 * reachable (caller keeps the local items).
 */
export async function hydrateFocusFromServer(client: FocusRpcClient): Promise<FocusItem[] | null> {
  focusServerClient = client;
  try {
    const res = await client.request<{ items?: FocusItem[] }>("discipline.focus.list", {});
    const server = Array.isArray(res?.items) ? res.items : [];
    const local = loadFocusItems();
    if (server.length === 0) {
      if (local.length) pushFocusToServer(local, 0);
      return local;
    }
    if (JSON.stringify(minimalForServer(server)) !== JSON.stringify(minimalForServer(local))) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(server));
      } catch {
        /* storage full / disabled */
      }
      emitFocusChanged(server);
    }
    return server;
  } catch {
    focusServerClient = null;
    return null;
  }
}

function loadFocusItems(): FocusItem[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored);
  } catch (e) {
    console.error("[Focus] Failed to load items:", e);
    return [];
  }
}

/** Read the persisted focus items straight from storage. Lets callers that
 *  don't hold a live FocusState (e.g. the Discipline view) treat Focus as the
 *  single source of truth. */
export function getFocusItems(): FocusItem[] {
  return loadFocusItems();
}

/** Project ids currently pinned to Focus, in priority order. */
export function getFocusProjectIds(): string[] {
  return loadFocusItems()
    .filter((i) => i.type === "project" && !!i.projectId)
    .map((i) => i.projectId as string);
}

// Add item to focus (from kanban source)
export function addToFocus(
  state: FocusState,
  item: KanbanTask | KanbanProject,
  type: "task" | "project",
  projects?: KanbanProject[]
): FocusState {
  // Check if already in focus
  if (state.items.some(f => f.id === item.id)) {
    return { ...state, error: "Already in focus" };
  }

  // Check max limit
  if (state.items.length >= MAX_FOCUS_ITEMS) {
    return { ...state, error: "Focus list is full (max 5 items)" };
  }

  const projectName = type === "task" 
    ? projects?.find(p => p.id === (item as KanbanTask).projectId)?.name 
    : undefined;

  const focusItem: FocusItem = {
    id: item.id,
    type,
    title: type === "task" ? (item as KanbanTask).title : (item as KanbanProject).name,
    description: item.description,
    status: type === "task" ? (item as KanbanTask).status : (item as KanbanProject).status,
    priority: state.items.length + 1,
    projectName,
    projectId: type === "task" ? (item as KanbanTask).projectId : undefined,
    addedAt: Date.now(),
    sourceTask: type === "task" ? item as KanbanTask : undefined,
    sourceProject: type === "project" ? item as KanbanProject : undefined,
  };

  const newItems = [...state.items, focusItem];
  saveFocusItems(newItems);

  return { ...state, items: newItems, error: null };
}

// ── Project-level sync (Focus ↔ Discipline) ──────────────────────────────
// Storage-based so callers that don't hold a live FocusState (the Discipline
// view) can still treat Focus as the single source of truth. Both mutate the
// persisted list and broadcast FOCUS_CHANGED_EVENT via saveFocusItems().

/** Pin a project to Focus by id. No-op if already pinned or the list is full.
 *  Returns the new persisted items. */
export function addProjectToFocus(
  projectId: string,
  projectName?: string,
): FocusItem[] {
  const items = loadFocusItems();
  if (!projectId) return items;
  if (items.some((f) => f.id === projectId || f.projectId === projectId)) return items;
  if (items.length >= MAX_FOCUS_ITEMS) return items;
  const focusItem: FocusItem = {
    id: projectId,
    type: "project",
    title: projectName ?? "Project",
    priority: items.length + 1,
    projectId,
    projectName,
    addedAt: Date.now(),
  };
  const newItems = [...items, focusItem].map((item, idx) => ({ ...item, priority: idx + 1 }));
  saveFocusItems(newItems);
  return newItems;
}

/** Unpin a project from Focus by id. Returns the new persisted items. */
export function removeProjectFromFocus(projectId: string): FocusItem[] {
  const items = loadFocusItems();
  const newItems = items
    .filter((f) => !(f.projectId === projectId || (f.type === "project" && f.id === projectId)))
    .map((item, idx) => ({ ...item, priority: idx + 1 }));
  if (newItems.length !== items.length) saveFocusItems(newItems);
  return newItems;
}

/** Toggle a project's Focus membership. Returns true if now pinned. */
export function toggleProjectInFocus(projectId: string, projectName?: string): boolean {
  const pinned = getFocusProjectIds().includes(projectId);
  if (pinned) {
    removeProjectFromFocus(projectId);
    return false;
  }
  addProjectToFocus(projectId, projectName);
  return getFocusProjectIds().includes(projectId);
}

// Remove item from focus
export function removeFromFocus(state: FocusState, itemId: string): FocusState {
  const newItems = state.items
    .filter(f => f.id !== itemId)
    .map((item, idx) => ({ ...item, priority: idx + 1 }));
  
  saveFocusItems(newItems);
  return { ...state, items: newItems, error: null };
}

// Reorder items via drag and drop
export function reorderFocus(
  state: FocusState,
  fromIndex: number,
  toIndex: number
): FocusState {
  if (fromIndex === toIndex) return state;
  if (fromIndex < 0 || fromIndex >= state.items.length) return state;
  if (toIndex < 0 || toIndex >= state.items.length) return state;

  const newItems = [...state.items];
  const [removed] = newItems.splice(fromIndex, 1);
  newItems.splice(toIndex, 0, removed);

  // Update priorities
  const reindexed = newItems.map((item, idx) => ({ ...item, priority: idx + 1 }));
  saveFocusItems(reindexed);

  return { ...state, items: reindexed, draggedItem: null, dragOverIndex: null };
}

// Move item to specific position
export function moveFocusItem(
  state: FocusState,
  itemId: string,
  newPriority: number
): FocusState {
  const currentIndex = state.items.findIndex(f => f.id === itemId);
  if (currentIndex === -1) return state;

  const newIndex = Math.max(0, Math.min(newPriority - 1, state.items.length - 1));
  return reorderFocus(state, currentIndex, newIndex);
}

// Clear all focus items
export function clearFocus(state: FocusState): FocusState {
  saveFocusItems([]);
  return { ...state, items: [], error: null };
}

// Update focus item with latest task/project data
export function syncFocusWithKanban(
  state: FocusState,
  tasks: KanbanTask[],
  projects: KanbanProject[]
): FocusState {
  const updatedItems = state.items.map(item => {
    if (item.type === "task") {
      const task = tasks.find(t => t.id === item.id);
      if (task) {
        const project = projects.find(p => p.id === task.projectId);
        return {
          ...item,
          title: task.title,
          description: task.description,
          status: task.status,
          projectName: project?.name,
          sourceTask: task,
        };
      }
    } else {
      const project = projects.find(p => p.id === item.id);
      if (project) {
        return {
          ...item,
          title: project.name,
          description: project.description,
          status: project.status,
          sourceProject: project,
        };
      }
    }
    return item;
  });

  // Remove items that no longer exist
  const validItems = updatedItems.filter(item => {
    if (item.type === "task") {
      return tasks.some(t => t.id === item.id);
    } else {
      return projects.some(p => p.id === item.id);
    }
  });

  if (validItems.length !== state.items.length) {
    saveFocusItems(validItems);
  }

  return { ...state, items: validItems };
}

// Drag state management
export function setDraggedItem(state: FocusState, item: FocusItem | null): FocusState {
  return { ...state, draggedItem: item };
}

export function setDragOverIndex(state: FocusState, index: number | null): FocusState {
  return { ...state, dragOverIndex: index };
}

// Source panel controls
export function toggleSourceCollapsed(state: FocusState): FocusState {
  return { ...state, sourceCollapsed: !state.sourceCollapsed };
}

export function setSourceFilter(state: FocusState, filter: "all" | "tasks" | "projects"): FocusState {
  return { ...state, sourceFilter: filter };
}

export function setSourceSearch(state: FocusState, search: string): FocusState {
  return { ...state, sourceSearch: search };
}

export function setSourceView(state: FocusState, view: "list" | "kanban"): FocusState {
  return { ...state, sourceView: view };
}

export function setSourceKanbanProject(state: FocusState, projectId: string | null): FocusState {
  return { ...state, sourceKanbanProject: projectId };
}

// Filter tasks/projects for source panel
export function filterSourceItems(
  tasks: KanbanTask[],
  projects: KanbanProject[],
  focusItems: FocusItem[],
  filter: "all" | "tasks" | "projects",
  search: string
): { tasks: KanbanTask[]; projects: KanbanProject[] } {
  const focusIds = new Set(focusItems.map(f => f.id));
  const searchLower = search.toLowerCase();

  let filteredTasks = tasks.filter(t => !focusIds.has(t.id));
  let filteredProjects = projects.filter(p => !focusIds.has(p.id));

  if (search) {
    filteredTasks = filteredTasks.filter(t => 
      t.title.toLowerCase().includes(searchLower) ||
      t.description?.toLowerCase().includes(searchLower)
    );
    filteredProjects = filteredProjects.filter(p => 
      p.name.toLowerCase().includes(searchLower) ||
      p.description?.toLowerCase().includes(searchLower)
    );
  }

  if (filter === "tasks") {
    return { tasks: filteredTasks, projects: [] };
  } else if (filter === "projects") {
    return { tasks: [], projects: filteredProjects };
  }

  return { tasks: filteredTasks, projects: filteredProjects };
}
