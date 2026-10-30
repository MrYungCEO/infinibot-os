/**
 * Focus View — Premium glassmorphism priority board
 *
 * Full-screen priority board with drag-and-drop vertical column (max 5 items),
 * collapsible kanban source underneath, live search, floating add modal,
 * and WAAPI entrance animations.
 */

import { html, nothing, type TemplateResult } from "lit";
import "./work-glass/remaining.css";
import type { KanbanTask, KanbanProject } from "../types";
import type { FocusState, FocusItem } from "../controllers/focus";
import { icons } from "../icons";

const STATUS_COLORS: Record<string, string> = {
  backlog: "#6b7280",
  todo: "#3b82f6",
  in_progress: "#c9a84c",
  review: "#8b5cf6",
  done: "#10b981",
  "Not started": "#6b7280",
  "In progress": "#c9a84c",
  Completed: "#10b981",
  Paused: "#ef4444",
};

function getStatusColor(status?: string): string {
  return STATUS_COLORS[status || ""] || "#6b7280";
}

function formatStatus(status?: string): string {
  if (!status) return "No Status";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface FocusViewProps {
  state: FocusState;
  tasks: KanbanTask[];
  projects: KanbanProject[];
  loading?: boolean;
  error?: string | null;
  onAddToFocus: (item: KanbanTask | KanbanProject, type: "task" | "project") => void;
  onRemoveFromFocus: (itemId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onDragStart: (item: FocusItem) => void;
  onDragEnd: () => void;
  onDragOver: (index: number) => void;
  onToggleSource: () => void;
  onSourceFilter: (filter: "all" | "tasks" | "projects") => void;
  onSourceSearch: (search: string) => void;
  onSourceViewChange: (view: "list" | "kanban") => void;
  onSourceKanbanProjectChange: (projectId: string | null) => void;
  onClearFocus: () => void;
  onRefresh?: () => void;
  onOpenTask?: (taskId: string) => void;
  onOpenProject?: (projectId: string) => void;
}

let _searchTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSearch(fn: (v: string) => void, value: string, ms = 150) {
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => fn(value), ms);
}

let _dropListenerBound = false;
function ensureFocusDropListener(
  onAdd: (item: KanbanTask | KanbanProject, type: "task" | "project") => void,
  tasks: KanbanTask[],
  projects: KanbanProject[],
): void {
  if (_dropListenerBound) return;
  _dropListenerBound = true;
  window.addEventListener("infinibot:focus-drop", (e: Event) => {
    const { id, type, title } = (e as CustomEvent).detail ?? {};
    if (!id || !type) return;
    const task = tasks.find((t) => t.id === id);
    const proj = projects.find((p) => p.id === id);
    if (task) onAdd(task, "task");
    else if (proj) onAdd(proj, "project");
    else if (type === "task") onAdd({ id, title: title ?? id, status: "backlog" } as KanbanTask, "task");
    else onAdd({ id, name: title ?? id } as KanbanProject, "project");
  });
}

export function renderFocus(props: FocusViewProps): TemplateResult {
  const { state, loading, error, onRefresh, onAddToFocus, tasks, projects } = props;
  ensureFocusDropListener(onAddToFocus, tasks, projects);

  return html`
    <style>${focusStyles}</style>
    <div class="focus-root">
      ${error ? html`<div class="focus-error-banner">
        <span class="focus-error-copy">${icons.alert}<span>${error}</span></span>
        ${onRefresh ? html`<button class="focus-retry-btn" @click=${onRefresh}>Retry</button>` : nothing}
      </div>` : nothing}
      ${renderFocusColumn(props)}
      ${loading
        ? html`<div class="src-loading-bar"><div class="src-loading-spinner"></div><span>Loading kanban items…</span></div>`
        : renderSourcePanel(props)}
      ${renderFloatingAdd(props)}
    </div>
  `;
}

function renderFocusColumn(props: FocusViewProps): TemplateResult {
  const { state, onClearFocus, onRefresh } = props;
  const emptySlots = Math.max(0, 5 - state.items.length);
  return html`
    <div class="focus-col">
      <div class="focus-col-head" data-learn-id="focus-head">
        <div class="focus-col-title">
          <span class="focus-col-icon" aria-hidden="true">${icons.target}</span>
          <h1 class="focus-col-h1">Focus</h1>
          <span class="focus-col-badge">${state.items.length}/5</span>
        </div>
        <div class="focus-col-actions">
          ${onRefresh ? html`<button class="focus-icon-btn" @click=${onRefresh} title="Refresh">${icons.refresh}</button>` : nothing}
          ${state.items.length > 0 ? html`<button class="focus-clear-btn" @click=${onClearFocus}>${icons.x}<span>Clear</span></button>` : nothing}
        </div>
      </div>
      <div class="focus-items" data-learn-id="focus-slots">
        ${state.items.map((item, index) => renderFocusItem(item, index, props))}
        ${[...Array(emptySlots)].map((_, i) => html`
          <div class="focus-slot" data-slot="${state.items.length + i}">
            <span class="focus-slot-num">${state.items.length + i + 1}</span>
            <span class="focus-slot-hint">Drag item here</span>
          </div>
        `)}
      </div>
      ${state.error ? html`<div class="focus-err-inline">${state.error}</div>` : nothing}
    </div>
  `;
}

function renderFocusItem(item: FocusItem, index: number, props: FocusViewProps): TemplateResult {
  const { state, onDragStart, onDragEnd, onDragOver, onRemoveFromFocus, onReorder, onOpenTask, onOpenProject } = props;
  const isDragging = state.draggedItem?.id === item.id;
  const isDragOver = state.dragOverIndex === index;

  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer?.setData("text/plain", item.id);
    e.dataTransfer!.effectAllowed = "move";
    onDragStart(item);
  };
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    onDragOver(index);
  };
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    const draggedIndex = state.items.findIndex((i) => i.id === state.draggedItem?.id);
    if (draggedIndex !== -1 && draggedIndex !== index) onReorder(draggedIndex, index);
    onDragEnd();
  };
  const handleClick = () => {
    if (item.type === "task" && onOpenTask) onOpenTask(item.id);
    else if (item.type === "project" && onOpenProject) onOpenProject(item.id);
  };

  return html`
    <div class="fi ${isDragging ? "fi--drag" : ""} ${isDragOver ? "fi--over" : ""}"
      draggable="true"
      @dragstart=${handleDragStart} @dragend=${onDragEnd}
      @dragover=${handleDragOver} @drop=${handleDrop}>
      <div class="fi-rank">${index + 1}</div>
      <div class="fi-body" @click=${handleClick}>
        <div class="fi-header">
          <span class="fi-type-icon" aria-hidden="true">${item.type === "task" ? icons.checkCircle : icons.briefcase}</span>
          <span class="fi-title">${item.title}</span>
        </div>
        ${item.projectName ? html`<div class="fi-project">${item.projectName}</div>` : nothing}
        ${item.description ? html`<div class="fi-desc">${_truncate(item.description, 100)}</div>` : nothing}
        <div class="fi-meta">
          <span class="fi-status-pill" style="--sc:${getStatusColor(item.status)}">${formatStatus(item.status)}</span>
        </div>
      </div>
      <div class="fi-actions">
        <button class="fi-btn" title="Drag to reorder">${icons.menu}</button>
        <button class="fi-btn fi-btn--remove"
          @click=${(e: Event) => { e.stopPropagation(); onRemoveFromFocus(item.id); }}
          title="Remove">${icons.x}</button>
      </div>
    </div>
  `;
}

function renderSourcePanel(props: FocusViewProps): TemplateResult {
  const { state, tasks, projects, onToggleSource, onSourceFilter, onSourceSearch, onSourceViewChange, onSourceKanbanProjectChange, onAddToFocus } = props;

  const focusIds = new Set(state.items.map((f) => f.id));
  const searchLower = state.sourceSearch.toLowerCase();
  let filteredTasks = tasks.filter((t) => !focusIds.has(t.id));
  let filteredProjects = projects.filter((p) => !focusIds.has(p.id));

  if (state.sourceSearch) {
    filteredTasks = filteredTasks.filter((t) => t.title.toLowerCase().includes(searchLower) || t.description?.toLowerCase().includes(searchLower));
    filteredProjects = filteredProjects.filter((p) => p.name.toLowerCase().includes(searchLower) || p.description?.toLowerCase().includes(searchLower));
  }
  if (state.sourceFilter === "tasks") filteredProjects = [];
  else if (state.sourceFilter === "projects") filteredTasks = [];

  const canAdd = state.items.length < 5;

  return html`
    <div class="src-panel ${state.sourceCollapsed ? "src-panel--collapsed" : ""}" data-learn-id="focus-source">
      <div class="src-head" @click=${onToggleSource}>
        <div class="src-head-title">
          <span class="src-caret" aria-hidden="true">${state.sourceCollapsed ? icons.chevronRight : icons.chevronDown}</span>
          <h2 class="src-h2">Available Items</h2>
          <span class="src-badge">${filteredTasks.length + filteredProjects.length}</span>
        </div>
      </div>
      ${!state.sourceCollapsed ? html`
        <div class="src-controls">
          <div class="src-search-wrap">
            <input class="src-search-input" data-learn-id="focus-source-search" type="text" placeholder="Search tasks & projects…"
              .value=${state.sourceSearch}
              @input=${(e: Event) => debouncedSearch(onSourceSearch, (e.target as HTMLInputElement).value)} />
            ${state.sourceSearch ? html`<button class="src-search-clear" @click=${() => onSourceSearch("")}>${icons.x}</button>` : nothing}
          </div>
          <div class="src-filters" data-learn-id="focus-source-filters">
            ${(["all", "tasks", "projects"] as const).map((f) => html`
              <button class="src-filter-btn ${state.sourceFilter === f ? "active" : ""}" data-learn-id=${`focus-filter-${f}`} @click=${() => onSourceFilter(f)}>
                ${f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            `)}
          </div>
          <div class="src-view-toggle" data-learn-id="focus-source-view">
            <button class="src-view-btn ${state.sourceView === "list" ? "active" : ""}" @click=${() => onSourceViewChange("list")} title="List view">${icons.menu}</button>
            <button class="src-view-btn ${state.sourceView === "kanban" ? "active" : ""}" @click=${() => onSourceViewChange("kanban")} title="Kanban view">${icons.kanban}</button>
          </div>
          ${state.sourceView === "kanban" ? html`
            <select class="src-project-select" .value=${state.sourceKanbanProject || ""}
              @change=${(e: Event) => onSourceKanbanProjectChange((e.target as HTMLSelectElement).value || null)}>
              <option value="">All Projects</option>
              ${projects.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
            </select>
          ` : nothing}
        </div>
        <div class="src-content">
          ${!canAdd ? html`<div class="src-full-notice">Focus is full — remove an item to add more.</div>` : nothing}
          ${state.sourceView === "kanban"
            ? renderKanbanView(filteredTasks, projects, state.sourceKanbanProject, canAdd, onAddToFocus)
            : renderListView(filteredTasks, filteredProjects, projects, canAdd, onAddToFocus)}
        </div>
      ` : nothing}
    </div>
  `;
}

let _addModalOpen = false;
let _addModalSearch = "";

function renderFloatingAdd(props: FocusViewProps): TemplateResult {
  const { state, tasks, projects, onAddToFocus } = props;
  const openModal = (e: Event) => { e.stopPropagation(); _addModalOpen = true; _addModalSearch = ""; props.onRefresh?.(); };
  const closeModal = () => { _addModalOpen = false; };
  const focusIds = new Set(state.items.map((f) => f.id));
  const canAdd = state.items.length < 5;
  const q = _addModalSearch.toLowerCase();
  const matchedTasks = q.length >= 2 ? tasks.filter((t) => !focusIds.has(t.id) && (t.title.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q))).slice(0, 8) : [];
  const matchedProjects = q.length >= 2 ? projects.filter((p) => !focusIds.has(p.id) && (p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q))).slice(0, 5) : [];
  const addItem = (item: KanbanTask | KanbanProject, type: "task" | "project") => { onAddToFocus(item, type); _addModalOpen = false; };

  return html`
    <button class="focus-fab" data-learn-id="focus-add" @click=${openModal} title="Add to Focus" aria-label="Add to Focus">
      <span class="focus-fab-icon" aria-hidden="true">${icons.plus}</span>
    </button>
    ${_addModalOpen ? html`
      <div class="focus-modal-backdrop" @click=${closeModal}>
        <div class="focus-modal" data-learn-id="focus-add-modal" @click=${(e: Event) => e.stopPropagation()}>
          <div class="focus-modal-head">
            <span class="focus-modal-title">Add to Focus</span>
            <button class="focus-modal-close" @click=${closeModal}>${icons.x}</button>
          </div>
          <div class="focus-modal-search-wrap">
            <input class="focus-modal-input" data-learn-id="focus-add-input" type="text" placeholder="Search tasks or projects…"
              .value=${_addModalSearch} autofocus
              @input=${(e: Event) => { _addModalSearch = (e.target as HTMLInputElement).value; props.onRefresh?.(); }} />
          </div>
          ${!canAdd ? html`<div class="focus-modal-full">Focus list is full (5/5)</div>`
            : q.length < 2 ? html`<div class="focus-modal-hint">Type at least 2 characters to search…</div>`
            : matchedTasks.length === 0 && matchedProjects.length === 0 ? html`<div class="focus-modal-hint">No matches found.</div>`
            : html`<div class="focus-modal-results">
                ${matchedProjects.length > 0 ? html`
                  <div class="focus-modal-section">Projects</div>
                  ${matchedProjects.map((p) => html`
                    <div class="focus-modal-row" @click=${() => addItem(p, "project")}>
                      <span class="focus-modal-row-icon" aria-hidden="true">${icons.briefcase}</span>
                      <span class="focus-modal-row-title">${p.name}</span>
                      <span class="focus-modal-row-status" style="--sc:${getStatusColor(p.status)}">${formatStatus(p.status)}</span>
                    </div>
                  `)}
                ` : nothing}
                ${matchedTasks.length > 0 ? html`
                  <div class="focus-modal-section">Tasks</div>
                  ${matchedTasks.map((t) => html`
                    <div class="focus-modal-row" @click=${() => addItem(t, "task")}>
                      <span class="focus-modal-row-icon" aria-hidden="true">${icons.checkCircle}</span>
                      <span class="focus-modal-row-title">${t.title}</span>
                      <span class="focus-modal-row-status" style="--sc:${getStatusColor(t.status)}">${formatStatus(t.status)}</span>
                    </div>
                  `)}
                ` : nothing}
              </div>`}
        </div>
      </div>
    ` : nothing}
  `;
}

const KANBAN_COLUMNS = [
  { id: "backlog", label: "Backlog", color: "#6b7280" },
  { id: "todo", label: "To Do", color: "#3b82f6" },
  { id: "in_progress", label: "In Progress", color: "#c9a84c" },
  { id: "review", label: "Review", color: "#8b5cf6" },
  { id: "done", label: "Done", color: "#10b981" },
];

function renderKanbanView(tasks: KanbanTask[], projects: KanbanProject[], selectedProjectId: string | null, canAdd: boolean, onAdd: (item: KanbanTask | KanbanProject, type: "task" | "project") => void): TemplateResult {
  const filteredTasks = selectedProjectId ? tasks.filter((t) => t.projectId === selectedProjectId) : tasks;
  const tasksByStatus = new Map<string, KanbanTask[]>();
  for (const col of KANBAN_COLUMNS) tasksByStatus.set(col.id, []);
  for (const task of filteredTasks) {
    const status = task.status || "backlog";
    const existing = tasksByStatus.get(status) || [];
    existing.push(task);
    tasksByStatus.set(status, existing);
  }
  return html`
    <div class="src-kanban">
      ${KANBAN_COLUMNS.map((col) => html`
        <div class="src-kb-col">
          <div class="src-kb-col-head" style="--cc:${col.color}">
            <span class="src-kb-dot"></span>
            <span class="src-kb-label">${col.label}</span>
            <span class="src-kb-count">${tasksByStatus.get(col.id)?.length || 0}</span>
          </div>
          <div class="src-kb-cards">
            ${(tasksByStatus.get(col.id) || []).map((task) => renderKanbanCard(task, projects, canAdd, onAdd))}
            ${(tasksByStatus.get(col.id) || []).length === 0 ? html`<div class="src-kb-empty">No tasks</div>` : nothing}
          </div>
        </div>
      `)}
    </div>
  `;
}

function renderKanbanCard(task: KanbanTask, projects: KanbanProject[], canAdd: boolean, onAdd: (item: KanbanTask | KanbanProject, type: "task" | "project") => void): TemplateResult {
  const project = projects.find((p) => p.id === task.projectId);
  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer?.setData("application/focus-item", JSON.stringify({ id: task.id, type: "task" }));
    e.dataTransfer!.effectAllowed = "copy";
  };
  return html`
    <div class="src-kb-card ${!canAdd ? "src-kb-card--off" : ""}" draggable="${canAdd}"
      @dragstart=${handleDragStart} @click=${() => canAdd && onAdd(task, "task")}>
      <div class="src-kb-card-title">${task.title}</div>
      ${project ? html`<div class="src-kb-card-proj"><span aria-hidden="true">${icons.briefcase}</span>${project.name}</div>` : nothing}
      <div class="src-kb-card-props">
        ${task.priority ? html`<span class="src-kb-pri src-kb-pri--${task.priority}">${task.priority}</span>` : nothing}
        ${task.tags && task.tags.length > 0 ? task.tags.slice(0, 3).map((tag) => html`<span class="src-kb-tag">${tag}</span>`) : nothing}
      </div>
      ${canAdd ? html`<div class="src-kb-add-overlay">+ Focus</div>` : nothing}
    </div>
  `;
}

function renderListView(tasks: KanbanTask[], filteredProjects: KanbanProject[], allProjects: KanbanProject[], canAdd: boolean, onAdd: (item: KanbanTask | KanbanProject, type: "task" | "project") => void): TemplateResult {
  const tasksByProject = new Map<string, KanbanTask[]>();
  const unassigned: KanbanTask[] = [];
  for (const task of tasks) {
    if (task.projectId) {
      const ex = tasksByProject.get(task.projectId) || [];
      ex.push(task);
      tasksByProject.set(task.projectId, ex);
    } else { unassigned.push(task); }
  }
  return html`
    ${filteredProjects.length > 0 ? html`
      <div class="src-section">
        <div class="src-section-head">Projects</div>
        <div class="src-grid">${filteredProjects.map((p) => renderSourceProject(p, canAdd, onAdd))}</div>
      </div>
    ` : nothing}
    ${Array.from(tasksByProject.entries()).map(([projectId, pts]) => {
      const project = allProjects.find((p) => p.id === projectId);
      return html`
        <div class="src-section">
          <div class="src-section-head"><span aria-hidden="true">${icons.briefcase}</span>${project?.name ?? "Unknown Project"}</div>
          <div class="src-grid">${pts.map((task) => renderSourceTask(task, canAdd, onAdd))}</div>
        </div>
      `;
    })}
    ${unassigned.length > 0 ? html`
      <div class="src-section">
        <div class="src-section-head">Unassigned Tasks</div>
        <div class="src-grid">${unassigned.map((task) => renderSourceTask(task, canAdd, onAdd))}</div>
      </div>
    ` : nothing}
    ${tasks.length === 0 && filteredProjects.length === 0 ? html`<div class="src-empty">No items available</div>` : nothing}
  `;
}

function renderSourceTask(task: KanbanTask, canAdd: boolean, onAdd: (item: KanbanTask | KanbanProject, type: "task" | "project") => void): TemplateResult {
  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer?.setData("application/focus-item", JSON.stringify({ id: task.id, type: "task" }));
    e.dataTransfer!.effectAllowed = "copy";
  };
  return html`
    <div class="src-item src-item--task ${!canAdd ? "src-item--off" : ""}" draggable="${canAdd}"
      @dragstart=${handleDragStart} @click=${() => canAdd && onAdd(task, "task")}>
      <div class="src-item-head">
        <span class="src-item-icon" aria-hidden="true">${icons.checkCircle}</span>
        <span class="src-item-title">${task.title}</span>
      </div>
      <div class="src-item-meta">
        <span class="src-item-status" style="--sc:${getStatusColor(task.status)}">${formatStatus(task.status)}</span>
      </div>
      ${canAdd ? html`<div class="src-item-add">+ Add to Focus</div>` : nothing}
    </div>
  `;
}

function renderSourceProject(project: KanbanProject, canAdd: boolean, onAdd: (item: KanbanTask | KanbanProject, type: "task" | "project") => void): TemplateResult {
  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer?.setData("application/focus-item", JSON.stringify({ id: project.id, type: "project" }));
    e.dataTransfer!.effectAllowed = "copy";
  };
  return html`
    <div class="src-item src-item--proj ${!canAdd ? "src-item--off" : ""}" draggable="${canAdd}"
      @dragstart=${handleDragStart} @click=${() => canAdd && onAdd(project, "project")}>
      <div class="src-item-head">
        <span class="src-item-icon" aria-hidden="true">${icons.briefcase}</span>
        <span class="src-item-title">${project.name}</span>
      </div>
      ${project.progress !== undefined ? html`<div class="src-item-progress"><div class="src-item-progress-bar" style="width:${project.progress}%"></div></div>` : nothing}
      <div class="src-item-meta">
        <span class="src-item-status" style="--sc:${getStatusColor(project.status)}">${formatStatus(project.status)}</span>
        ${project.taskCount ? html`<span class="src-item-tasks">${project.taskCount} tasks</span>` : nothing}
      </div>
      ${canAdd ? html`<div class="src-item-add">+ Add to Focus</div>` : nothing}
    </div>
  `;
}

function _truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trim() + "\u2026";
}

const focusStyles = `
  :host, .focus-root {
    display: flex; flex-direction: column; height: 100%;
    background: #0a0a0f; overflow: hidden;
  }
  .focus-error-banner {
    display: flex; align-items: center; justify-content: center; gap: 1rem;
    padding: 0.75rem 1.5rem; background: rgba(239,68,68,0.08);
    border-bottom: 1px solid rgba(239,68,68,0.25);
    color: #ef4444; font-size: 0.875rem; flex-shrink: 0;
  }
  .focus-retry-btn {
    background: #ef4444; color: #fff; border: none;
    padding: 0.3rem 0.75rem; border-radius: 6px; cursor: pointer;
    font-size: 0.75rem; font-weight: 600;
  }
  .src-loading-bar {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.75rem 1.5rem;
    border-top: 1px solid rgba(201,168,76,0.08);
    color: rgba(255,255,255,0.35); font-size: 0.8rem; flex-shrink: 0;
  }
  .src-loading-spinner {
    width: 16px; height: 16px;
    border: 2px solid rgba(201,168,76,0.15);
    border-top-color: #c9a84c; border-radius: 50%;
    animation: focusSpin 0.8s linear infinite; flex-shrink: 0;
  }
  @keyframes focusSpin { to { transform: rotate(360deg); } }
  .focus-col {
    flex: 1; display: flex; flex-direction: column;
    padding: 2rem; min-height: 0;
  }
  .focus-col-head {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 1.5rem; flex-shrink: 0;
  }
  .focus-col-title { display: flex; align-items: center; gap: 0.75rem; }
  .focus-col-icon { font-size: 1.75rem; color: #c9a84c; text-shadow: 0 0 20px rgba(201,168,76,0.5); }
  .focus-col-h1 {
    font-size: 2rem; font-weight: 700; margin: 0; letter-spacing: -0.02em;
    background: linear-gradient(135deg, #c9a84c, #f5d78e, #c9a84c);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }
  .focus-col-badge {
    background: rgba(201,168,76,0.12); border: 1px solid rgba(201,168,76,0.25);
    color: #c9a84c; padding: 0.2rem 0.7rem; border-radius: 999px;
    font-size: 0.8rem; font-weight: 600;
  }
  .focus-col-actions { display: flex; gap: 0.5rem; align-items: center; }
  .focus-icon-btn {
    display: flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; background: rgba(255,255,255,0.03);
    border: 1px solid rgba(201,168,76,0.2); color: rgba(255,255,255,0.4);
    border-radius: 8px; cursor: pointer; transition: all 0.2s;
  }
  .focus-icon-btn:hover { border-color: rgba(201,168,76,0.5); color: #c9a84c; background: rgba(201,168,76,0.06); }
  .focus-icon-btn svg { width: 14px; height: 14px; }
  .focus-clear-btn {
    display: flex; align-items: center; gap: 0.4rem;
    background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.2);
    color: rgba(239,68,68,0.7); padding: 0.4rem 0.9rem; border-radius: 8px;
    cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: all 0.2s;
  }
  .focus-clear-btn:hover { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.4); color: #ef4444; }
  .focus-clear-btn svg { width: 13px; height: 13px; }
  .focus-items {
    display: flex; flex-direction: column; gap: 0.875rem;
    flex: 1; overflow-y: auto; padding-right: 0.5rem;
  }
  .focus-items::-webkit-scrollbar { width: 4px; }
  .focus-items::-webkit-scrollbar-thumb { background: rgba(201,168,76,0.2); border-radius: 2px; }
  .fi {
    display: flex; align-items: stretch;
    background: rgba(255,255,255,0.03);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
    border: 1px solid rgba(201,168,76,0.18);
    border-top: 1px solid rgba(201,168,76,0.4);
    border-radius: 14px; overflow: hidden; cursor: grab;
    transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
    min-height: 96px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.3), 0 1px 0 rgba(255,255,255,0.04) inset;
    animation: fi-enter 0.32s cubic-bezier(0.16,1,0.3,1) both;
  }
  @keyframes fi-enter {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .fi:nth-child(1) { animation-delay: 0ms; }
  .fi:nth-child(2) { animation-delay: 50ms; }
  .fi:nth-child(3) { animation-delay: 100ms; }
  .fi:nth-child(4) { animation-delay: 150ms; }
  .fi:nth-child(5) { animation-delay: 200ms; }
  .fi:hover {
    border-color: rgba(201,168,76,0.55);
    box-shadow: 0 6px 32px rgba(201,168,76,0.12), 0 1px 0 rgba(255,255,255,0.06) inset;
    transform: translateY(-2px);
  }
  .fi--drag { opacity: 0.45; transform: scale(0.97); }
  .fi--over { border-color: rgba(201,168,76,0.7); box-shadow: 0 0 0 2px rgba(201,168,76,0.25); }
  .fi-rank {
    display: flex; align-items: center; justify-content: center;
    width: 56px; flex-shrink: 0;
    background: linear-gradient(135deg, #c9a84c, #f5d78e);
    color: #0a0a0f; font-size: 1.5rem; font-weight: 800;
  }
  .fi-body { flex: 1; padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: 0.4rem; cursor: pointer; min-width: 0; }
  .fi-header { display: flex; align-items: center; gap: 0.5rem; }
  .fi-type-icon { color: rgba(201,168,76,0.6); font-size: 1rem; flex-shrink: 0; }
  .fi-title { font-size: 1.05rem; font-weight: 600; color: #fff; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fi-project { font-size: 0.73rem; color: rgba(201,168,76,0.75); }
  .fi-desc { font-size: 0.825rem; color: rgba(255,255,255,0.45); line-height: 1.4; }
  .fi-meta { display: flex; align-items: center; gap: 0.6rem; margin-top: auto; }
  .fi-status-pill {
    display: inline-flex; align-items: center; gap: 0.35rem;
    font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--sc, #6b7280);
    background: color-mix(in srgb, var(--sc, #6b7280) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--sc, #6b7280) 30%, transparent);
    padding: 0.2rem 0.6rem; border-radius: 999px;
  }
  .fi-status-pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--sc, #6b7280); }
  .fi-actions { display: flex; flex-direction: column; padding: 0.5rem; gap: 0.25rem; flex-shrink: 0; }
  .fi-btn {
    display: flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; background: transparent; border: none;
    color: rgba(255,255,255,0.3); cursor: pointer; border-radius: 7px; transition: all 0.15s;
  }
  .fi-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.7); }
  .fi-btn--remove:hover { background: rgba(239,68,68,0.1); color: #ef4444; }
  .fi-btn svg { width: 14px; height: 14px; }
  .focus-slot {
    border: 1px dashed rgba(201,168,76,0.15); border-radius: 14px; min-height: 72px;
    display: flex; align-items: center; justify-content: center; gap: 0.75rem;
    background: rgba(201,168,76,0.02); transition: all 0.2s;
  }
  .focus-slot:hover { border-color: rgba(201,168,76,0.3); background: rgba(201,168,76,0.04); }
  .focus-slot-num { font-size: 1.5rem; font-weight: 700; color: rgba(201,168,76,0.2); }
  .focus-slot-hint { font-size: 0.75rem; color: rgba(255,255,255,0.2); }
  .focus-err-inline {
    margin-top: 0.75rem; padding: 0.6rem 1rem;
    background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);
    border-radius: 8px; color: #ef4444; font-size: 0.82rem; flex-shrink: 0;
  }
  .src-panel {
    background: rgba(255,255,255,0.02); border-top: 1px solid rgba(201,168,76,0.12);
    max-height: 50%; display: flex; flex-direction: column;
    transition: max-height 0.3s ease; flex-shrink: 0;
  }
  .src-panel--collapsed { max-height: 44px; overflow: hidden; }
  .src-head { display: flex; align-items: center; padding: 0.6rem 1.5rem; cursor: pointer; border-bottom: 1px solid rgba(201,168,76,0.08); flex-shrink: 0; }
  .src-head:hover { background: rgba(201,168,76,0.04); }
  .src-head-title { display: flex; align-items: center; gap: 0.65rem; }
  .src-caret { font-size: 0.65rem; color: rgba(201,168,76,0.5); }
  .src-h2 { font-size: 0.9rem; font-weight: 600; color: rgba(255,255,255,0.7); margin: 0; }
  .src-badge { background: rgba(201,168,76,0.1); border: 1px solid rgba(201,168,76,0.2); color: #c9a84c; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.7rem; font-weight: 600; }
  .src-controls { display: flex; align-items: center; gap: 0.75rem; padding: 0.65rem 1.5rem; border-bottom: 1px solid rgba(201,168,76,0.08); flex-shrink: 0; flex-wrap: wrap; }
  .src-search-wrap { position: relative; flex: 1; min-width: 180px; max-width: 320px; }
  .src-search-input {
    width: 100%; padding: 0.45rem 2rem 0.45rem 0.85rem;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(201,168,76,0.2);
    border-radius: 8px; color: #fff; font-size: 0.825rem; outline: none; transition: border-color 0.2s;
  }
  .src-search-input:focus { border-color: rgba(201,168,76,0.5); }
  .src-search-input::placeholder { color: rgba(255,255,255,0.25); }
  .src-search-clear { position: absolute; right: 0.5rem; top: 50%; transform: translateY(-50%); background: none; border: none; color: rgba(255,255,255,0.3); cursor: pointer; padding: 0.2rem; display: flex; }
  .src-search-clear svg { width: 12px; height: 12px; }
  .src-filters { display: flex; gap: 0.25rem; }
  .src-filter-btn { background: rgba(255,255,255,0.04); border: 1px solid rgba(201,168,76,0.15); color: rgba(255,255,255,0.5); padding: 0.32rem 0.7rem; border-radius: 7px; cursor: pointer; font-size: 0.73rem; transition: all 0.15s; }
  .src-filter-btn:hover { border-color: rgba(201,168,76,0.4); color: #c9a84c; }
  .src-filter-btn.active { background: rgba(201,168,76,0.15); border-color: rgba(201,168,76,0.5); color: #f5d78e; font-weight: 600; }
  .src-view-toggle { display: flex; gap: 0.25rem; margin-left: auto; }
  .src-view-btn { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; background: rgba(255,255,255,0.03); border: 1px solid rgba(201,168,76,0.15); color: rgba(255,255,255,0.4); border-radius: 7px; cursor: pointer; transition: all 0.15s; }
  .src-view-btn:hover { border-color: rgba(201,168,76,0.4); color: #c9a84c; }
  .src-view-btn.active { background: rgba(201,168,76,0.15); border-color: rgba(201,168,76,0.5); color: #f5d78e; }
  .src-view-btn svg { width: 13px; height: 13px; }
  .src-project-select { background: rgba(255,255,255,0.04); border: 1px solid rgba(201,168,76,0.2); color: #fff; padding: 0.35rem 0.7rem; border-radius: 7px; font-size: 0.73rem; min-width: 140px; outline: none; }
  .src-content { flex: 1; overflow-y: auto; padding: 0.875rem 1.5rem; }
  .src-content::-webkit-scrollbar { width: 4px; }
  .src-content::-webkit-scrollbar-thumb { background: rgba(201,168,76,0.15); border-radius: 2px; }
  .src-full-notice { background: rgba(201,168,76,0.06); border: 1px solid rgba(201,168,76,0.2); border-radius: 8px; padding: 0.65rem 1rem; color: #c9a84c; font-size: 0.82rem; margin-bottom: 0.875rem; text-align: center; }
  .src-section { margin-bottom: 1.25rem; }
  .src-section-head { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(201,168,76,0.5); margin-bottom: 0.6rem; padding-left: 0.1rem; }
  .src-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.6rem; }
  .src-empty { text-align: center; padding: 2rem; color: rgba(255,255,255,0.25); font-size: 0.875rem; }
  .src-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(201,168,76,0.12); border-radius: 10px; padding: 0.7rem; cursor: pointer; transition: all 0.15s; position: relative; overflow: hidden; }
  .src-item:hover:not(.src-item--off) { border-color: rgba(201,168,76,0.45); transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
  .src-item--off { opacity: 0.4; cursor: not-allowed; }
  .src-item-head { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.4rem; }
  .src-item-icon { color: rgba(201,168,76,0.5); font-size: 0.875rem; flex-shrink: 0; }
  .src-item-title { font-size: 0.825rem; font-weight: 500; color: #fff; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .src-item-progress { height: 2px; background: rgba(255,255,255,0.06); border-radius: 1px; margin-bottom: 0.4rem; overflow: hidden; }
  .src-item-progress-bar { height: 100%; background: #c9a84c; border-radius: 1px; transition: width 0.3s; }
  .src-item-meta { display: flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; }
  .src-item-status { color: var(--sc, #6b7280); display: flex; align-items: center; gap: 0.25rem; }
  .src-item-status::before { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--sc, #6b7280); flex-shrink: 0; }
  .src-item-tasks { color: rgba(255,255,255,0.3); }
  .src-item-add { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(201,168,76,0.9); color: #0a0a0f; font-weight: 700; font-size: 0.825rem; opacity: 0; transition: opacity 0.2s; border-radius: 10px; }
  .src-item:hover:not(.src-item--off) .src-item-add { opacity: 1; }
  .src-kanban { display: flex; gap: 0.75rem; height: 100%; overflow-x: auto; padding-bottom: 0.5rem; }
  .src-kb-col { flex: 0 0 200px; min-width: 200px; display: flex; flex-direction: column; background: rgba(255,255,255,0.02); border: 1px solid rgba(201,168,76,0.08); border-radius: 10px; overflow: hidden; }
  .src-kb-col-head { display: flex; align-items: center; gap: 0.4rem; padding: 0.6rem 0.7rem; border-bottom: 1px solid rgba(201,168,76,0.08); }
  .src-kb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--cc, #6b7280); flex-shrink: 0; }
  .src-kb-label { font-size: 0.7rem; font-weight: 700; color: rgba(255,255,255,0.6); flex: 1; text-transform: uppercase; letter-spacing: 0.04em; }
  .src-kb-count { font-size: 0.6rem; color: rgba(255,255,255,0.3); background: rgba(255,255,255,0.06); padding: 0.1rem 0.35rem; border-radius: 999px; }
  .src-kb-cards { flex: 1; overflow-y: auto; padding: 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
  .src-kb-empty { text-align: center; padding: 1rem; color: rgba(255,255,255,0.2); font-size: 0.7rem; }
  .src-kb-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(201,168,76,0.1); border-radius: 7px; padding: 0.55rem; cursor: pointer; position: relative; transition: all 0.15s; overflow: hidden; }
  .src-kb-card:hover:not(.src-kb-card--off) { border-color: rgba(201,168,76,0.4); transform: translateY(-1px); }
  .src-kb-card--off { opacity: 0.4; cursor: not-allowed; }
  .src-kb-card-title { font-size: 0.775rem; font-weight: 500; color: #fff; margin-bottom: 0.3rem; line-height: 1.3; }
  .src-kb-card-proj { font-size: 0.6rem; color: rgba(201,168,76,0.6); margin-bottom: 0.3rem; }
  .src-kb-card-props { display: flex; flex-wrap: wrap; gap: 0.25rem; font-size: 0.6rem; }
  .src-kb-pri { padding: 0.1rem 0.35rem; border-radius: 4px; text-transform: capitalize; background: rgba(201,168,76,0.12); color: #c9a84c; }
  .src-kb-tag { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.4); padding: 0.1rem 0.35rem; border-radius: 4px; }
  .src-kb-add-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(201,168,76,0.9); color: #0a0a0f; font-weight: 700; font-size: 0.7rem; opacity: 0; transition: opacity 0.2s; border-radius: 7px; }
  .src-kb-card:hover:not(.src-kb-card--off) .src-kb-add-overlay { opacity: 1; }
  .focus-fab {
    position: fixed; bottom: 2rem; right: 2rem; z-index: 100;
    width: 52px; height: 52px; border-radius: 50%;
    background: linear-gradient(135deg, #c9a84c, #f5d78e);
    border: none; cursor: pointer;
    box-shadow: 0 4px 24px rgba(201,168,76,0.4);
    transition: transform 0.2s, box-shadow 0.2s;
    display: flex; align-items: center; justify-content: center;
  }
  .focus-fab:hover { transform: scale(1.1); box-shadow: 0 6px 36px rgba(201,168,76,0.6), 0 0 0 6px rgba(201,168,76,0.12); }
  .focus-fab-icon { font-size: 1.75rem; font-weight: 300; color: #0a0a0f; line-height: 1; }
  .focus-modal-backdrop {
    position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.65);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    display: flex; align-items: center; justify-content: center;
    animation: modal-in 0.18s ease;
  }
  @keyframes modal-in { from { opacity: 0; } to { opacity: 1; } }
  .focus-modal {
    width: min(480px, calc(100vw - 2rem));
    background: rgba(14,14,20,0.96); border: 1px solid rgba(201,168,76,0.3);
    border-radius: 16px; overflow: hidden;
    box-shadow: 0 20px 80px rgba(0,0,0,0.7), 0 1px 0 rgba(201,168,76,0.2) inset;
    animation: modal-slide 0.22s cubic-bezier(0.16,1,0.3,1);
  }
  @keyframes modal-slide { from { transform: translateY(16px) scale(0.97); opacity: 0; } to { transform: none; opacity: 1; } }
  .focus-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; border-bottom: 1px solid rgba(201,168,76,0.1); }
  .focus-modal-title { font-size: 0.95rem; font-weight: 700; background: linear-gradient(135deg, #c9a84c, #f5d78e); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .focus-modal-close { background: none; border: none; color: rgba(255,255,255,0.35); cursor: pointer; padding: 0.25rem; border-radius: 6px; display: flex; transition: color 0.15s; }
  .focus-modal-close:hover { color: rgba(255,255,255,0.8); }
  .focus-modal-close svg { width: 16px; height: 16px; }
  .focus-modal-search-wrap { padding: 0.875rem 1.25rem; border-bottom: 1px solid rgba(201,168,76,0.08); }
  .focus-modal-input { width: 100%; padding: 0.6rem 0.9rem; background: rgba(255,255,255,0.04); border: 1px solid rgba(201,168,76,0.25); border-radius: 9px; color: #fff; font-size: 0.9rem; outline: none; transition: border-color 0.2s; box-sizing: border-box; }
  .focus-modal-input:focus { border-color: rgba(201,168,76,0.6); }
  .focus-modal-input::placeholder { color: rgba(255,255,255,0.3); }
  .focus-modal-hint { padding: 1.5rem 1.25rem; color: rgba(255,255,255,0.3); font-size: 0.82rem; text-align: center; }
  .focus-modal-full { padding: 1rem 1.25rem; background: rgba(201,168,76,0.06); color: #c9a84c; font-size: 0.82rem; text-align: center; }
  .focus-modal-results { max-height: 320px; overflow-y: auto; padding: 0.5rem 0; }
  .focus-modal-results::-webkit-scrollbar { width: 4px; }
  .focus-modal-results::-webkit-scrollbar-thumb { background: rgba(201,168,76,0.2); border-radius: 2px; }
  .focus-modal-section { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(201,168,76,0.4); padding: 0.5rem 1.25rem 0.3rem; }
  .focus-modal-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 1.25rem; cursor: pointer; transition: background 0.15s; }
  .focus-modal-row:hover { background: rgba(201,168,76,0.06); }
  .focus-modal-row-icon { color: rgba(201,168,76,0.5); font-size: 0.875rem; flex-shrink: 0; }
  .focus-modal-row-title { flex: 1; font-size: 0.875rem; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .focus-modal-row-status { font-size: 0.65rem; font-weight: 600; text-transform: uppercase; color: var(--sc, #6b7280); flex-shrink: 0; }
  @media (max-width: 768px) {
    .focus-col { padding: 1rem; }
    .focus-col-h1 { font-size: 1.4rem; }
    .fi-rank { width: 44px; font-size: 1.25rem; }
    .src-controls { flex-direction: column; align-items: stretch; }
    .src-search-wrap { max-width: none; }
    .src-grid { grid-template-columns: 1fr; }
    .focus-fab { bottom: 1.25rem; right: 1.25rem; }
  }

  /* Glass G1 final theme contract. Kept at the end so the mature Focus
     markup retains all behaviour while every visible surface follows the
     shared dark/light, transparency and motion tokens. */
  .focus-root {
    position: relative;
    isolation: isolate;
    background: transparent;
    color: var(--glass-fg);
    font-family: var(--glass-font, var(--font-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif));
  }
  .focus-root::before {
    content: "";
    position: absolute;
    inset: -18% 38% 48% -16%;
    z-index: -1;
    pointer-events: none;
    background: radial-gradient(circle, var(--glass-orb-1), transparent 68%);
    filter: blur(42px);
    opacity: 0.72;
  }
  .focus-col,
  .src-panel {
    background: var(--glass-sheen), var(--glass-tint), var(--glass-2);
    border-color: var(--glass-stroke-gold);
    color: var(--glass-fg);
    box-shadow: var(--glass-elev-2);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
  }
  .focus-col { border: 1px solid var(--glass-stroke-gold); border-radius: var(--glass-radius-xl); margin: 12px 12px 0; }
  .src-panel { margin: 12px; border: 1px solid var(--glass-stroke); border-radius: var(--glass-radius-lg); overflow: hidden; }
  .focus-col-h1,
  .focus-modal-title {
    background: none;
    color: var(--glass-fg);
    -webkit-text-fill-color: currentColor;
    font-family: var(--font-ui-display, var(--glass-font));
  }
  .focus-col-icon,
  .focus-col-badge,
  .src-badge,
  .src-section-head,
  .fi-project,
  .src-kb-card-proj,
  .focus-modal-section { color: var(--glass-gold); }
  .focus-col-icon,
  .fi-type-icon,
  .src-item-icon,
  .src-caret,
  .focus-modal-row-icon,
  .src-section-head > span,
  .src-kb-card-proj > span,
  .focus-error-copy { display: inline-flex; align-items: center; }
  .focus-error-copy { gap: 8px; }
  .focus-col-icon svg { width: 22px; height: 22px; }
  .fi-type-icon svg,
  .src-item-icon svg,
  .focus-modal-row-icon svg,
  .src-section-head svg,
  .src-kb-card-proj svg { width: 13px; height: 13px; }
  .src-caret svg { width: 12px; height: 12px; }
  .src-section-head,
  .src-kb-card-proj { display: flex; align-items: center; gap: 6px; }
  .focus-col-badge,
  .src-badge,
  .src-filter-btn.active,
  .src-view-btn.active {
    background: var(--glass-gold-a10);
    border-color: var(--glass-stroke-gold);
  }
  .fi,
  .focus-slot,
  .src-item,
  .src-kb-col,
  .src-kb-card {
    background: var(--glass-sheen), var(--glass-3);
    border-color: var(--glass-stroke);
    color: var(--glass-fg);
    box-shadow: var(--glass-elev-1);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .fi:hover,
  .src-item:hover:not(.src-item--off),
  .src-kb-card:hover:not(.src-kb-card--off) {
    border-color: var(--glass-stroke-gold);
    box-shadow: var(--glass-elev-3), var(--glass-glow-soft);
  }
  .fi-rank,
  .focus-fab,
  .src-item-add,
  .src-kb-add-overlay {
    background: var(--glass-gold-fill);
    color: var(--glass-ink);
  }
  .fi-title,
  .src-h2,
  .src-item-title,
  .src-kb-card-title,
  .focus-modal-row-title { color: var(--glass-fg); }
  .fi-desc,
  .focus-slot-hint,
  .src-empty,
  .src-kb-empty,
  .src-item-tasks,
  .focus-modal-hint { color: var(--glass-fg-3); }
  .focus-slot-num { color: var(--glass-gold-a24); }
  .focus-icon-btn,
  .src-filter-btn,
  .src-view-btn {
    background: var(--glass-hover);
    border-color: var(--glass-stroke);
    color: var(--glass-fg-2);
  }
  .src-head,
  .src-controls,
  .src-kb-col-head,
  .focus-modal-head,
  .focus-modal-search-wrap { border-color: var(--glass-stroke); }
  .src-head:hover,
  .focus-modal-row:hover { background: var(--glass-gold-a06); }
  .src-search-input,
  .src-project-select,
  .focus-modal-input {
    background: color-mix(in srgb, var(--glass-base) 58%, transparent);
    border-color: var(--glass-stroke-strong);
    color: var(--glass-fg);
  }
  .src-search-input::placeholder,
  .focus-modal-input::placeholder { color: var(--glass-fg-4); }
  .focus-modal-backdrop { background: color-mix(in srgb, var(--glass-base) 72%, transparent); }
  .focus-modal {
    background: var(--glass-sheen), var(--glass-4);
    border-color: var(--glass-stroke-gold);
    color: var(--glass-fg);
    box-shadow: var(--glass-elev-4);
    backdrop-filter: var(--glass-blur-lg);
    -webkit-backdrop-filter: var(--glass-blur-lg);
  }
  .focus-fab-icon { display: inline-flex; }
  .focus-fab-icon svg { width: 22px; height: 22px; }
  .focus-root :is(button, input, select):focus-visible {
    outline: none;
    box-shadow: var(--glass-focus-ring);
  }
  @media (max-width: 520px) {
    .focus-col { margin: 8px 8px 0; padding: 14px 12px; }
    .focus-col-head { align-items: flex-start; gap: 10px; }
    .focus-col-actions { margin-left: auto; }
    .focus-clear-btn span { display: none; }
    .focus-items { padding-right: 0; }
    .fi { min-height: 82px; }
    .fi-rank { width: 38px; font-size: 1.05rem; }
    .fi-body { padding: 0.8rem; }
    .src-panel { margin: 8px; max-height: 52%; }
    .src-controls { padding: 10px; }
    .src-filters { width: 100%; }
    .src-filter-btn { flex: 1; }
    .src-view-toggle { margin-left: 0; }
    .src-content { padding: 10px; }
    .focus-fab { bottom: 14px; right: 14px; width: 48px; height: 48px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .focus-root *, .focus-root *::before, .focus-root *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
  @media (prefers-reduced-transparency: reduce) {
    .focus-col,
    .src-panel,
    .focus-modal {
      background: var(--glass-solid);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
`;
