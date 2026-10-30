/**
 * Global Task Detail modal.
 *
 * Module-level-state pattern (see project-detail-modal.ts). Fetches the task
 * from kanban.tasks.list and resolves its assigned agent badge from
 * AppViewState.agentsList at render time. Acceptance criteria / subtasks are
 * derived from any markdown checklist lines ("- [ ] …") in the description —
 * KanbanTask has no dedicated field, and the CRM/kanban convention stores them
 * inline. The status control + checklist are render-only; "Complete" is the
 * one live mutation (kanban.tasks.update).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../../app-view-state.js";
import type { KanbanTask, TaskStatus } from "../../types.js";
import {
  type ModalContext,
  taskStatusColor,
  priorityColor,
  avatarColor,
  initials,
  formatDate,
} from "./modal-service.js";

const STATUSES: TaskStatus[] = ["backlog", "todo", "in_progress", "review", "done"];

// ── Module-level state ──────────────────────────────────────────────────────
let _open = false;
let _taskId: string | null = null;
let _task: KanbanTask | null = null;
let _loading = false;
let _saving = false;
let _error: string | null = null;
let _ctx: ModalContext | null = null;

export function isTaskDetailOpen(): boolean {
  return _open;
}

export function openTaskDetailModal(taskId: string, ctx: ModalContext): void {
  _ctx = ctx;
  _taskId = taskId;
  _task = null;
  _error = null;
  _saving = false;
  _loading = true;
  _open = true;
  ctx.rerender();
  void loadData(taskId);
}

export function closeTaskDetailModal(): void {
  _open = false;
  _taskId = null;
  _task = null;
  _error = null;
  _saving = false;
  _ctx?.rerender();
}

async function loadData(taskId: string): Promise<void> {
  if (!_ctx) return;
  try {
    const tasks = (await _ctx.client.request<KanbanTask[]>("kanban.tasks.list")) || [];
    const task = tasks.find((t) => t.id === taskId || t.notionId === taskId) ?? null;
    if (!_open || _taskId !== taskId) return;
    _task = task;
    if (!task) _error = "Task not found";
    _loading = false;
    _ctx.rerender();
  } catch (err) {
    if (!_open || _taskId !== taskId) return;
    _error = err instanceof Error ? err.message : String(err);
    _loading = false;
    _ctx.rerender();
  }
}

// ── Derive checklist items from markdown "- [ ] …" lines ─────────────────────
interface ChecklistItem { text: string; done: boolean; }
function parseChecklist(desc?: string): { items: ChecklistItem[]; rest: string } {
  if (!desc) return { items: [], rest: "" };
  const items: ChecklistItem[] = [];
  const restLines: string[] = [];
  for (const line of desc.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.+)$/);
    if (m) items.push({ done: m[1].toLowerCase() === "x", text: m[2].trim() });
    else restLines.push(line);
  }
  return { items, rest: restLines.join("\n").trim() };
}

function resolveAgent(state: AppViewState, task: KanbanTask): { id: string; name: string; url?: string } | null {
  const id = task.assignedAgent ?? task.assignee;
  if (!id) return null;
  const agents = (state.agentsList?.agents ?? []) as Array<{
    id: string;
    identity?: { avatarUrl?: string; avatar?: string; name?: string };
  }>;
  const found = agents.find(
    (a) => a.id === id || a.identity?.name?.toLowerCase() === id.toLowerCase(),
  );
  return {
    id,
    name: found?.identity?.name ?? id,
    url: found?.identity?.avatarUrl ?? found?.identity?.avatar,
  };
}

// ── Render ──────────────────────────────────────────────────────────────────
export function renderTaskDetailModal(
  state: AppViewState,
): TemplateResult | typeof nothing {
  if (!_open) return nothing;

  const t = _task;
  const title = t?.title ?? (_loading ? "Loading…" : "Task");
  const { items, rest } = parseChecklist(t?.description);
  const agent = t ? resolveAgent(state, t) : null;
  const sc = taskStatusColor(t?.status);

  return html`
    <div
      class="um-overlay"
      role="presentation"
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) closeTaskDetailModal();
      }}
    >
      <div class="um-modal" role="dialog" aria-modal="true" aria-label="Task details" style="max-width:600px">
        <span class="um-glow" aria-hidden="true"></span>

        <header class="um-header">
          <div class="um-header-main">
            <div class="um-eyebrow"><span class="um-eyebrow-dot"></span><span>InfiniBot · Task</span></div>
            <h2 class="um-title">${title}</h2>
          </div>
          <button class="um-close" aria-label="Close" @click=${() => closeTaskDetailModal()}>×</button>
        </header>

        <div class="um-body">
          ${_loading
            ? html`<div class="um-state"><div class="um-spinner"></div>Loading task…</div>`
            : _error
              ? html`<div class="um-state um-state--error">${_error}</div>`
              : t
                ? html`
                    <!-- Status + priority + assignee -->
                    <div class="um-section">
                      <div class="um-chips" style="align-items:center">
                        <label class="um-meta-label" for="um-task-status" style="margin-right:2px">Status</label>
                        <select
                          id="um-task-status"
                          class="um-chip"
                          style="cursor:default; color:${sc.color}"
                          .value=${t.status}
                          @change=${(e: Event) => (e.target as HTMLSelectElement).blur()}
                        >
                          ${STATUSES.map(
                            (s) => html`<option value=${s} ?selected=${s === t.status}>${taskStatusColor(s).label}</option>`,
                          )}
                        </select>
                        ${t.priority
                          ? html`<span class="um-badge" style="color:${priorityColor(t.priority)}"><span class="um-badge-dot"></span>${t.priority}</span>`
                          : nothing}
                        ${t.dueDate ? html`<span class="um-chip">Due ${formatDate(t.dueDate)}</span>` : nothing}
                      </div>
                      ${agent
                        ? html`<div class="um-progress-row" style="gap:8px">
                            <span class="um-meta-label">Assigned</span>
                            <span class="um-avatar" style="background:${avatarColor(agent.id)}; width:28px; height:28px; font-size:11px">
                              ${agent.url ? html`<img src=${agent.url} alt="" />` : initials(agent.name)}
                            </span>
                            <span class="um-meta-value" style="font-size:13px">${agent.name}</span>
                          </div>`
                        : nothing}
                    </div>

                    ${rest
                      ? html`<div class="um-section">
                          <div class="um-section-title">Description</div>
                          <div class="um-desc">${rest}</div>
                        </div>`
                      : nothing}

                    ${items.length
                      ? html`<div class="um-section">
                          <div class="um-section-title">Acceptance Criteria (${items.filter((i) => i.done).length}/${items.length})</div>
                          <div class="um-list">
                            ${items.map(
                              (i) => html`<div class="um-row">
                                <span class="um-checkbox ${i.done ? "is-checked" : ""}">${i.done ? "✓" : ""}</span>
                                <span class="um-row-title ${i.done ? "is-done" : ""}">${i.text}</span>
                              </div>`,
                            )}
                          </div>
                        </div>`
                      : nothing}

                    ${t.tags?.length
                      ? html`<div class="um-section">
                          <div class="um-section-title">Tags</div>
                          <div class="um-chips">${t.tags.map((tag) => html`<span class="um-chip">${tag}</span>`)}</div>
                        </div>`
                      : nothing}
                  `
                : html`<div class="um-state">No task data.</div>`}
        </div>

        <footer class="um-footer">
          <button
            class="um-btn um-btn--primary"
            ?disabled=${!t || _saving || t?.status === "done"}
            @click=${() => completeTask()}
          >
            ${_saving ? "Saving…" : t?.status === "done" ? "Completed" : "Complete"}
          </button>
          <button class="um-btn um-btn--ghost" ?disabled=${!t} @click=${() => reassign(state)}>Reassign</button>
          <span class="um-footer-spacer"></span>
          <button class="um-btn um-btn--secondary" @click=${() => closeTaskDetailModal()}>Close</button>
        </footer>
      </div>
    </div>
  `;
}

async function completeTask(): Promise<void> {
  if (!_ctx || !_task) return;
  const id = _task.id;
  _saving = true;
  _ctx.rerender();
  try {
    await _ctx.client.request("kanban.tasks.update", {
      id,
      patch: { status: "done", done: true },
    });
    if (_task && _task.id === id) {
      _task = { ..._task, status: "done", done: true };
    }
  } catch (err) {
    _error = err instanceof Error ? err.message : String(err);
  } finally {
    _saving = false;
    _ctx.rerender();
  }
}

function reassign(state: AppViewState): void {
  // The full reassignment UI lives on the projects board; route there.
  const projectId = _task?.projectId;
  try {
    if (projectId) {
      (state as unknown as { kanbanSelectedProjectId?: string | null }).kanbanSelectedProjectId = projectId;
      (state as unknown as { kanbanGalleryView?: boolean }).kanbanGalleryView = false;
    }
    state.setTab?.("projects" as never);
  } catch {
    /* noop */
  }
  closeTaskDetailModal();
}
