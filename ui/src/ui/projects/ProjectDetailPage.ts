// Shared, in-depth dedicated project detail page.
//
// Reachable from Agency Operations (a project card opens it full-screen) and
// intended to be rendered by the central router at the `projects/:slug` route a
// PARALLEL agent is wiring. This module owns ONLY the page body — it never
// touches the router or the slug utility. It resolves the project it should
// show in three tiers, in order of preference:
//
//   1. an explicit `project` argument (what the router passes after it resolves
//      the slug via `ui/src/lib/slugs.ts` → `resolveSlug`),
//   2. the live `detailProjectId` selection set by `openAgencyProjectDetail`,
//   3. nothing → a graceful "no project selected" surface.
//
// INTEGRATION POINT (slug routing): when `ui/src/lib/slugs.ts` lands, the
// router should resolve the slug to a project id and pass it in via the
// `projectId` option below (or set `detailProjectId`). No import of `slugs.ts`
// is done here on purpose so this file builds cleanly before that module
// exists; see `resolveDetailProject` for exactly where the id is consumed.

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import {
  addAgencyProjectNote,
  assignAgencyTask,
  closeAgencyProjectDetail,
  openAgencyOpsDialog,
  setAgencyProjectDetailTab,
  setAgencyProjectNoteDraft,
  transitionAgencyProject,
  transitionAgencyTask,
  type AgencyOperationsHost,
  type AgencyOperationsState,
  type AgencyProjectSummary,
  type AgencyTaskSummary,
  type WorkerKind,
} from "../controllers/agency-operations";

const PROJECT_STATUS_LABEL: Record<AgencyProjectSummary["status"], string> = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

const TASK_STATUS_ORDER: AgencyTaskSummary["status"][] = [
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled",
];

const TASK_STATUS_LABEL: Record<AgencyTaskSummary["status"], string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

const DETAIL_TABS: Array<[AgencyOperationsState["detailProjectTab"], string]> = [
  ["overview", "Overview"],
  ["tasks", "Tasks"],
  ["notes", "Notes"],
  ["activity", "Activity"],
];

function fmtDate(value?: number | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function fmtCents(cents: number): string {
  const dollars = (cents ?? 0) / 100;
  return dollars.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * Resolve which project the page should render. Explicit id/project wins (the
 * router path); otherwise the live selection. Returns null when nothing is
 * selected so the caller can render an empty state.
 */
function resolveDetailProject(
  state: AgencyOperationsState,
  opts: { projectId?: string; project?: AgencyProjectSummary },
): AgencyProjectSummary | null {
  if (opts.project) return opts.project;
  const id = opts.projectId ?? state.detailProjectId;
  if (!id) return null;
  return state.projects.find((p) => p.id === id) ?? null;
}

function renderTaskAssign(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  task: AgencyTaskSummary,
): TemplateResult {
  const current = task.assigneeId
    ? state.employees.find((e) => e.id === task.assigneeId)
    : undefined;
  return html`
    <select
      class="pdp-assign"
      aria-label=${`Assign ${task.title}`}
      .value=${task.assigneeId ?? ""}
      @change=${(event: Event) => {
        const id = (event.target as HTMLSelectElement).value;
        const employee = state.employees.find((e) => e.id === id);
        void assignAgencyTask(
          host,
          client,
          task.id,
          employee ? { id: employee.id, kind: employee.kind as WorkerKind } : null,
        );
      }}
    >
      <option value="">Unassigned</option>
      ${state.employees.map(
        (employee) =>
          html`<option value=${employee.id} ?selected=${employee.id === task.assigneeId}>
            ${employee.name} · ${employee.kind}
          </option>`,
      )}
    </select>
    ${current ? nothing : html`<small class="pdp-muted">No owner</small>`}
  `;
}

function renderTaskRow(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  task: AgencyTaskSummary,
): TemplateResult {
  const expanded = state.detailExpandedTaskIds?.includes(task.id) ?? false;
  const toggle = () => toggleExpandedTask(host, task.id);
  return html`
    <article class=${`pdp-task ${task.status}`}>
      <div class="pdp-task-head" @click=${toggle} role="button" tabindex="0"
        @keydown=${(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && toggle()}>
        <span class="pdp-caret">${expanded ? "▾" : "▸"}</span>
        <div class="pdp-task-title">
          <strong>${task.title}</strong>
          <small class="pdp-muted">
            ${TASK_STATUS_LABEL[task.status]} · ${task.priority}
            ${task.dueAt ? html` · due ${fmtDate(task.dueAt)}` : nothing}
          </small>
        </div>
        <span class=${`pdp-chip ${task.status}`}>${TASK_STATUS_LABEL[task.status]}</span>
      </div>
      ${
        expanded
          ? html`<div class="pdp-task-body" @click=${(e: Event) => e.stopPropagation()}>
              <label class="pdp-inline">
                <span>Status</span>
                <select
                  .value=${task.status}
                  ?disabled=${state.secondaryBusyId === task.id}
                  @change=${(event: Event) =>
                    void transitionAgencyTask(
                      host,
                      client,
                      task.id,
                      (event.target as HTMLSelectElement).value as AgencyTaskSummary["status"],
                    )}
                >
                  ${TASK_STATUS_ORDER.map(
                    (status) =>
                      html`<option value=${status} ?selected=${status === task.status}>
                        ${TASK_STATUS_LABEL[status]}
                      </option>`,
                  )}
                </select>
              </label>
              <label class="pdp-inline">
                <span>Owner</span>
                ${renderTaskAssign(host, state, client, task)}
              </label>
              <div class="pdp-task-actions">
                <button
                  class="pdp-btn ghost"
                  @click=${() => openAgencyOpsDialog(host, "task-edit", { entityId: task.id })}
                >Edit task</button>
                ${
                  task.status !== "done" && task.status !== "cancelled"
                    ? html`<button
                        class="pdp-btn"
                        ?disabled=${state.secondaryBusyId === task.id}
                        @click=${() =>
                          void transitionAgencyTask(
                            host,
                            client,
                            task.id,
                            task.status === "in_progress" ? "done" : "in_progress",
                          )}
                      >${task.status === "in_progress" ? "Mark done" : "Start"}</button>`
                    : nothing
                }
              </div>
            </div>`
          : nothing
      }
    </article>
  `;
}

function toggleExpandedTask(host: AgencyOperationsHost, taskId: string): void {
  const state = host.agencyOperationsState;
  if (!state) return;
  const list = state.detailExpandedTaskIds ?? [];
  state.detailExpandedTaskIds = list.includes(taskId)
    ? list.filter((id) => id !== taskId)
    : [...list, taskId];
  host.requestUpdate?.();
}

function renderOverview(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  project: AgencyProjectSummary,
  tasks: AgencyTaskSummary[],
): TemplateResult {
  const clientName = project.clientId
    ? state.clients.find((c) => c.id === project.clientId)?.name ?? "Linked client"
    : "No client linked";
  const done = tasks.filter((t) => t.status === "done").length;
  const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  return html`
    <div class="pdp-kpis">
      <article class="pdp-kpi"><span>Status</span><strong>${PROJECT_STATUS_LABEL[project.status]}</strong></article>
      <article class="pdp-kpi"><span>Progress</span><strong>${progress}%</strong><small>${done}/${tasks.length} tasks</small></article>
      <article class="pdp-kpi"><span>Budget</span><strong>${fmtCents(project.budgetCents)}</strong></article>
      <article class="pdp-kpi"><span>MRR</span><strong>${fmtCents(project.mrrCents)}</strong></article>
      <article class="pdp-kpi"><span>Deadline</span><strong>${fmtDate(project.targetEndAt)}</strong></article>
    </div>
    <div class="pdp-progress"><i style=${`width:${progress}%`}></i></div>
    <dl class="pdp-facts">
      <div><dt>Client</dt><dd>${clientName}</dd></div>
      <div><dt>Open tasks</dt><dd>${tasks.filter((t) => !["done", "cancelled"].includes(t.status)).length}</dd></div>
      <div><dt>Blocked</dt><dd>${tasks.filter((t) => t.status === "blocked").length}</dd></div>
    </dl>
    <div class="pdp-quickstatus">
      <span class="pdp-muted">Quick status:</span>
      ${(["planned", "active", "on_hold", "completed", "cancelled"] as AgencyProjectSummary["status"][]).map(
        (status) =>
          html`<button
            class=${`pdp-btn ${status === project.status ? "primary" : "ghost"}`}
            ?disabled=${status === project.status || state.secondaryBusyId === project.id}
            @click=${() => void transitionAgencyProject(host, client, project.id, status)}
          >${PROJECT_STATUS_LABEL[status]}</button>`,
      )}
    </div>
  `;
}

function renderTasks(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  project: AgencyProjectSummary,
  tasks: AgencyTaskSummary[],
): TemplateResult {
  return html`
    <div class="pdp-tasks-head">
      <h3>Tasks (${tasks.length})</h3>
      <button class="pdp-btn primary" @click=${() => openAgencyOpsDialog(host, "task", { entityId: project.id })}>+ Task</button>
    </div>
    ${
      tasks.length
        ? html`<div class="pdp-tasks">${tasks.map((task) => renderTaskRow(host, state, client, task))}</div>`
        : html`<p class="pdp-muted">No tasks yet. Add the first one to start delivery.</p>`
    }
  `;
}

function renderNotes(
  host: AgencyOperationsHost,
  state: AgencyOperationsState,
  client: GatewayBrowserClient,
  project: AgencyProjectSummary,
): TemplateResult {
  return html`
    <div class="pdp-notes-compose">
      <textarea
        class="pdp-textarea"
        placeholder="Add a note about this project…"
        .value=${state.detailProjectNoteDraft}
        @input=${(e: Event) => setAgencyProjectNoteDraft(host, (e.target as HTMLTextAreaElement).value)}
      ></textarea>
      <button
        class="pdp-btn primary"
        ?disabled=${state.detailProjectNoteBusy || !state.detailProjectNoteDraft.trim()}
        @click=${() => void addAgencyProjectNote(host, client, project.id)}
      >${state.detailProjectNoteBusy ? "Saving…" : "Add note"}</button>
    </div>
    ${
      state.detailProjectNotesLoading
        ? html`<p class="pdp-muted">Loading notes…</p>`
        : state.detailProjectNotes.length
          ? html`<ul class="pdp-notes">
              ${state.detailProjectNotes.map(
                (note) => html`<li class="pdp-note">
                  <div class="pdp-note-head"><strong>${note.name}</strong><small>${fmtDate(
                    new Date(note.updatedAt).getTime(),
                  )}</small></div>
                  <p>${note.body}</p>
                </li>`,
              )}
            </ul>`
          : html`<p class="pdp-muted">No notes yet.</p>`
    }
  `;
}

function renderActivity(
  state: AgencyOperationsState,
  project: AgencyProjectSummary,
  tasks: AgencyTaskSummary[],
): TemplateResult {
  const taskIds = new Set(tasks.map((t) => t.id));
  const events = (state.auditEvents ?? [])
    .filter(
      (e) =>
        (e.entityType === "agency_project" && e.entityId === project.id) ||
        (e.entityType === "agency_task" && taskIds.has(e.entityId)),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 40);
  if (!events.length) return html`<p class="pdp-muted">No recorded activity for this project yet.</p>`;
  return html`
    <ul class="pdp-activity">
      ${events.map(
        (e) => html`<li>
          <span class="pdp-chip">${e.action}</span>
          <span>${e.entityType.replace("agency_", "")}</span>
          <small class="pdp-muted">${fmtDate(e.createdAt)}</small>
        </li>`,
      )}
    </ul>
  `;
}

/**
 * The dedicated project page body. `opts.projectId` / `opts.project` are the
 * router's slug-resolved handles; when both are absent it falls back to the
 * live `detailProjectId` selection set by Agency Operations.
 */
export function renderProjectDetailPage(
  host: AgencyOperationsHost,
  client: GatewayBrowserClient,
  opts: { projectId?: string; project?: AgencyProjectSummary } = {},
): TemplateResult {
  const state = host.agencyOperationsState;
  if (!state) return html`<div class="pdp-loading">Loading…</div>`;
  const project = resolveDetailProject(state, opts);
  if (!project) {
    return html`
      <section class="pdp">
        <button class="pdp-back" @click=${() => closeAgencyProjectDetail(host)}>← Back to Agency Operations</button>
        <div class="pdp-empty">That project could not be found. It may have been deleted.</div>
      </section>
    `;
  }
  const tasks = state.tasks.filter((t) => t.projectId === project.id);
  const clientName = project.clientId
    ? state.clients.find((c) => c.id === project.clientId)?.name ?? "Linked client"
    : null;
  const tab = state.detailProjectTab;
  return html`
    ${detailStyles}
    <section class="pdp">
      <div class="pdp-topbar">
        <button class="pdp-back" @click=${() => closeAgencyProjectDetail(host)}>← Back to Agency Operations</button>
      </div>
      <header class="pdp-head">
        <div>
          <span class="pdp-eyebrow">Project${clientName ? html` · ${clientName}` : nothing}</span>
          <h1>${project.name}</h1>
          <span class=${`pdp-chip lg ${project.status}`}>${PROJECT_STATUS_LABEL[project.status]}</span>
        </div>
        <div class="pdp-head-actions">
          <button class="pdp-btn ghost" @click=${() => openAgencyOpsDialog(host, "project-edit", { entityId: project.id })}>Edit project</button>
        </div>
      </header>
      <nav class="pdp-tabs">
        ${DETAIL_TABS.map(
          ([id, label]) =>
            html`<button
              class=${tab === id ? "active" : ""}
              @click=${() => setAgencyProjectDetailTab(host, id)}
            >${label}</button>`,
        )}
      </nav>
      <div class="pdp-panel">
        ${
          tab === "overview"
            ? renderOverview(host, state, client, project, tasks)
            : tab === "tasks"
              ? renderTasks(host, state, client, project, tasks)
              : tab === "notes"
                ? renderNotes(host, state, client, project)
                : renderActivity(state, project, tasks)
        }
      </div>
    </section>
  `;
}

const detailStyles = html`
  <style>
    .pdp {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 4px 2px 40px;
      color: var(--g-text, #e8e8ef);
    }
    .pdp-back {
      background: transparent;
      border: 1px solid var(--g-border, rgba(212, 175, 55, 0.25));
      color: var(--g-text, #e8e8ef);
      border-radius: var(--g-radius-sm, 8px);
      padding: 7px 14px;
      cursor: pointer;
      font-size: 13px;
    }
    .pdp-back:hover { border-color: var(--g-primary, #d4af37); }
    .pdp-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      flex-wrap: wrap;
    }
    .pdp-head h1 { margin: 4px 0 8px; font-size: 26px; }
    .pdp-eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 11px;
      color: var(--g-muted, #9a9ab0);
    }
    .pdp-muted { color: var(--g-muted, #9a9ab0); }
    .pdp-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--g-border, rgba(212,175,55,0.2)); }
    .pdp-tabs button {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--g-muted, #9a9ab0);
      padding: 9px 14px;
      cursor: pointer;
      font-size: 14px;
    }
    .pdp-tabs button.active { color: var(--g-primary, #d4af37); border-bottom-color: var(--g-primary, #d4af37); }
    .pdp-panel { padding-top: 4px; }
    .pdp-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
    .pdp-kpi {
      background: var(--g-surface, rgba(255,255,255,0.03));
      border: 1px solid var(--g-border, rgba(212,175,55,0.18));
      border-radius: var(--g-radius, 12px);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .pdp-kpi span { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--g-muted, #9a9ab0); }
    .pdp-kpi strong { font-size: 18px; }
    .pdp-kpi small { color: var(--g-muted, #9a9ab0); }
    .pdp-progress { height: 6px; background: rgba(255,255,255,0.08); border-radius: 4px; overflow: hidden; margin: 12px 0; }
    .pdp-progress i { display: block; height: 100%; background: var(--g-primary, #d4af37); }
    .pdp-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 0; }
    .pdp-facts dt { font-size: 11px; text-transform: uppercase; color: var(--g-muted, #9a9ab0); }
    .pdp-facts dd { margin: 2px 0 0; font-weight: 600; }
    .pdp-quickstatus { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 16px; }
    .pdp-btn {
      background: var(--g-surface-2, rgba(255,255,255,0.06));
      border: 1px solid var(--g-border, rgba(212,175,55,0.2));
      color: var(--g-text, #e8e8ef);
      border-radius: var(--g-radius-sm, 8px);
      padding: 6px 12px;
      cursor: pointer;
      font-size: 13px;
    }
    .pdp-btn.primary { background: var(--g-primary, #d4af37); color: #1a1206; border-color: transparent; font-weight: 600; }
    .pdp-btn.ghost { background: transparent; }
    .pdp-btn:disabled { opacity: 0.5; cursor: default; }
    .pdp-tasks-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .pdp-tasks { display: flex; flex-direction: column; gap: 8px; }
    .pdp-task {
      background: var(--g-surface, rgba(255,255,255,0.03));
      border: 1px solid var(--g-border, rgba(212,175,55,0.16));
      border-radius: var(--g-radius, 12px);
      overflow: hidden;
    }
    .pdp-task-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; }
    .pdp-caret { color: var(--g-muted, #9a9ab0); width: 12px; }
    .pdp-task-title { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .pdp-task-body { padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--g-border, rgba(212,175,55,0.12)); }
    .pdp-inline { display: flex; align-items: center; gap: 10px; }
    .pdp-inline > span { width: 60px; font-size: 12px; color: var(--g-muted, #9a9ab0); }
    .pdp-inline select, .pdp-assign, .pdp-textarea {
      background: var(--g-surface-2, rgba(0,0,0,0.3));
      border: 1px solid var(--g-border, rgba(212,175,55,0.2));
      color: var(--g-text, #e8e8ef);
      border-radius: var(--g-radius-sm, 8px);
      padding: 6px 10px;
      font-size: 13px;
    }
    .pdp-task-actions { display: flex; gap: 8px; }
    .pdp-chip {
      font-size: 11px;
      padding: 2px 9px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      text-transform: capitalize;
    }
    .pdp-chip.lg { font-size: 13px; padding: 4px 12px; display: inline-block; margin-top: 2px; }
    .pdp-chip.in_progress, .pdp-chip.active { background: rgba(212,175,55,0.2); color: var(--g-primary, #d4af37); }
    .pdp-chip.done, .pdp-chip.completed { background: rgba(60,200,120,0.18); color: #63d38a; }
    .pdp-chip.blocked, .pdp-chip.cancelled { background: rgba(230,80,80,0.18); color: #f08a8a; }
    .pdp-notes-compose { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
    .pdp-textarea { width: 100%; min-height: 70px; resize: vertical; box-sizing: border-box; }
    .pdp-notes { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
    .pdp-note {
      background: var(--g-surface, rgba(255,255,255,0.03));
      border: 1px solid var(--g-border, rgba(212,175,55,0.14));
      border-radius: var(--g-radius, 12px);
      padding: 10px 12px;
    }
    .pdp-note-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .pdp-note p { margin: 6px 0 0; white-space: pre-wrap; }
    .pdp-activity { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
    .pdp-activity li { display: flex; align-items: center; gap: 10px; padding: 6px 2px; border-bottom: 1px solid var(--g-border, rgba(212,175,55,0.08)); }
    .pdp-empty, .pdp-loading { padding: 40px; text-align: center; color: var(--g-muted, #9a9ab0); }
    .pdp-topbar { display: flex; }
  </style>
`;
