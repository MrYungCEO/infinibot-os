/**
 * Global Project Detail modal.
 *
 * Follows the branding-modal.ts pattern: module-level state (`_open`,
 * `_projectId`, `_projectData`, `_tasks`, `_loading`, `_error`), imperative
 * open/close, and a `renderProjectDetailModal(state)` export mounted once at
 * the app root (app-render.ts).
 *
 * Opened via the modal-service facade (`openProjectModal(id)`), which passes a
 * ModalContext carrying the live gateway client + app re-render. Data is
 * fetched lazily from kanban.projects.list + kanban.tasks.list. Assignee /
 * agent avatars are resolved at render time from AppViewState.agentsList.
 */

import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { AppViewState } from "../../app-view-state.js";
import type { KanbanProject, KanbanTask } from "../../types.js";
import {
  type ModalContext,
  taskStatusColor,
  projectStatusColor,
  priorityColor,
  avatarColor,
  initials,
  formatDate,
} from "./modal-service.js";

// ── Module-level state ──────────────────────────────────────────────────────
let _open = false;
let _projectId: string | null = null;
let _projectData: KanbanProject | null = null;
let _tasks: KanbanTask[] = [];
let _loading = false;
let _error: string | null = null;
let _ctx: ModalContext | null = null;

export function isProjectDetailOpen(): boolean {
  return _open;
}

/** Open the modal for `projectId` and kick off the async data load. */
export function openProjectDetailModal(projectId: string, ctx: ModalContext): void {
  _ctx = ctx;
  _projectId = projectId;
  _projectData = null;
  _tasks = [];
  _error = null;
  _loading = true;
  _open = true;
  ctx.rerender();
  void loadData(projectId);
}

export function closeProjectDetailModal(): void {
  _open = false;
  _projectId = null;
  _projectData = null;
  _tasks = [];
  _error = null;
  _ctx?.rerender();
}

async function loadData(projectId: string): Promise<void> {
  if (!_ctx) return;
  try {
    const projects =
      (await _ctx.client.request<KanbanProject[]>("kanban.projects.list")) || [];
    // Match on id or notionId — the two are used interchangeably across views.
    const project =
      projects.find((p) => p.id === projectId || p.notionId === projectId) ?? null;
    let tasks: KanbanTask[] = [];
    try {
      tasks =
        (await _ctx.client.request<KanbanTask[]>("kanban.tasks.list", { projectId })) || [];
    } catch {
      tasks = [];
    }
    // Guard against a stale close/reopen race.
    if (!_open || _projectId !== projectId) return;
    _projectData = project;
    _tasks = tasks;
    if (!project) _error = "Project not found";
    _loading = false;
    _ctx.rerender();
  } catch (err) {
    if (!_open || _projectId !== projectId) return;
    _error = err instanceof Error ? err.message : String(err);
    _loading = false;
    _ctx.rerender();
  }
}

// ── Agent avatar resolution (from AppViewState.agentsList) ───────────────────
interface AgentEntry {
  id: string;
  identity?: { avatarUrl?: string; avatar?: string; name?: string };
}
function resolveAssignees(state: AppViewState, tasks: KanbanTask[]): AgentEntry[] {
  const agents = (state.agentsList?.agents ?? []) as AgentEntry[];
  const ids = new Set<string>();
  for (const t of tasks) {
    const a = t.assignedAgent ?? t.assignee;
    if (a) ids.add(a);
  }
  const resolved: AgentEntry[] = [];
  for (const id of ids) {
    const found = agents.find(
      (a) => a.id === id || a.identity?.name?.toLowerCase() === id.toLowerCase(),
    );
    resolved.push(found ?? { id, identity: { name: id } });
  }
  return resolved;
}

function renderAvatar(entry: AgentEntry): TemplateResult {
  const name = entry.identity?.name ?? entry.id;
  const url = entry.identity?.avatarUrl ?? entry.identity?.avatar;
  return html`
    <span class="um-avatar" style="background:${avatarColor(entry.id)}" title=${name}>
      ${url ? html`<img src=${url} alt="" />` : initials(name)}
    </span>
  `;
}

// ── Render ──────────────────────────────────────────────────────────────────
export function renderProjectDetailModal(
  state: AppViewState,
): TemplateResult | typeof nothing {
  if (!_open) return nothing;

  const p = _projectData;
  const name = p?.name ?? (_loading ? "Loading…" : "Project");
  const status = p?.status ?? "Not started";
  const progress = Math.max(0, Math.min(100, Math.round(p?.progress ?? 0)));
  const assignees = p ? resolveAssignees(state, _tasks) : [];

  const doneCount = _tasks.filter(
    (t) => t.done === true || t.status?.toLowerCase() === "done",
  ).length;

  return html`
    <div
      class="um-overlay"
      role="presentation"
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) closeProjectDetailModal();
      }}
    >
      <div class="um-modal" role="dialog" aria-modal="true" aria-label="Project details">
        <span class="um-glow" aria-hidden="true"></span>

        <header class="um-header">
          <div class="um-header-main">
            <div class="um-eyebrow">
              <span class="um-eyebrow-dot"></span>
              <span>InfiniBot · Project</span>
            </div>
            <h2 class="um-title">${name}</h2>
          </div>
          <button class="um-close" aria-label="Close" @click=${() => closeProjectDetailModal()}>×</button>
        </header>

        <div class="um-body">
          ${_loading
            ? html`<div class="um-state"><div class="um-spinner"></div>Loading project…</div>`
            : _error
              ? html`<div class="um-state um-state--error">${_error}</div>`
              : renderContent(p, status, progress, assignees, doneCount)}
        </div>

        <footer class="um-footer">
          <button
            class="um-btn um-btn--primary"
            ?disabled=${!p}
            @click=${() => openInKanban(state)}
          >
            Open in Kanban
          </button>
          <span class="um-footer-spacer"></span>
          <button class="um-btn um-btn--secondary" @click=${() => closeProjectDetailModal()}>
            Close
          </button>
        </footer>
      </div>
    </div>
  `;
}

function renderContent(
  p: KanbanProject | null,
  status: string,
  progress: number,
  assignees: AgentEntry[],
  doneCount: number,
): TemplateResult {
  if (!p) return html`<div class="um-state">No project data.</div>`;
  const statusCol = projectStatusColor(status);
  const prioCol = priorityColor(p.priority);

  return html`
    <!-- Status + priority + progress -->
    <div class="um-section">
      <div class="um-chips">
        <span class="um-badge" style="color:${statusCol}">
          <span class="um-badge-dot"></span>${status}
        </span>
        ${p.priority
          ? html`<span class="um-badge" style="color:${prioCol}">
              <span class="um-badge-dot"></span>${p.priority}
            </span>`
          : nothing}
        ${(p.type ?? []).map((t) => html`<span class="um-chip">${t}</span>`)}
      </div>
      <div class="um-progress-row">
        <div class="um-progress">
          <div class="um-progress-fill" style="width:${progress}%"></div>
        </div>
        <span class="um-progress-pct">${progress}%</span>
      </div>
    </div>

    ${p.description
      ? html`<div class="um-section">
          <div class="um-section-title">Overview</div>
          <div class="um-desc">${p.description}</div>
        </div>`
      : nothing}

    <!-- Meta -->
    <div class="um-section">
      <div class="um-meta">
        <div class="um-meta-field">
          <span class="um-meta-label">Tasks</span>
          <span class="um-meta-value">${doneCount}/${_tasks.length} done</span>
        </div>
        ${p.dueDate
          ? html`<div class="um-meta-field">
              <span class="um-meta-label">Due</span>
              <span class="um-meta-value">${formatDate(p.dueDate)}</span>
            </div>`
          : nothing}
        ${p.mrr
          ? html`<div class="um-meta-field">
              <span class="um-meta-label">MRR</span>
              <span class="um-meta-value">$${p.mrr.toLocaleString()}</span>
            </div>`
          : nothing}
        <div class="um-meta-field">
          <span class="um-meta-label">Updated</span>
          <span class="um-meta-value">${formatDate(p.updatedAt)}</span>
        </div>
      </div>
      ${assignees.length
        ? html`<div class="um-progress-row" style="gap:8px">
            <span class="um-meta-label">Team</span>
            <div class="um-avatar-stack">${assignees.slice(0, 8).map(renderAvatar)}</div>
          </div>`
        : nothing}
    </div>

    <!-- Task list -->
    <div class="um-section">
      <div class="um-section-title">Tasks (${_tasks.length})</div>
      ${_tasks.length === 0
        ? html`<div class="um-state">No tasks yet.</div>`
        : html`<div class="um-list">
            ${repeat(
              _tasks,
              (t) => t.id,
              (t) => {
                const sc = taskStatusColor(t.status);
                const isDone = t.done === true || t.status?.toLowerCase() === "done";
                return html`
                  <div
                    class="um-row"
                    role="button"
                    tabindex="0"
                    @click=${() => openTaskFromRow(t.id)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openTaskFromRow(t.id);
                      }
                    }}
                  >
                    <span class="um-row-status" style="background:${sc.color}"></span>
                    <span class="um-row-title ${isDone ? "is-done" : ""}">${t.title}</span>
                    <span class="um-row-meta">${sc.label}</span>
                  </div>
                `;
              },
            )}
          </div>`}
    </div>
  `;
}

// Lazily reach the task modal to avoid a static import cycle at module eval.
function openTaskFromRow(taskId: string): void {
  if (!_ctx) return;
  void import("./task-detail-modal.js").then((m) => {
    m.openTaskDetailModal(taskId, _ctx!);
  });
}

function openInKanban(state: AppViewState): void {
  if (!_projectData) return;
  const id = _projectData.id;
  try {
    (state as unknown as { kanbanSelectedProjectId?: string | null }).kanbanSelectedProjectId = id;
    (state as unknown as { kanbanGalleryView?: boolean }).kanbanGalleryView = false;
    state.setTab?.("projects" as never);
  } catch {
    /* noop */
  }
  closeProjectDetailModal();
}
