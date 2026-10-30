/**
 * <ib-secure-board> — the Secure Mode kanban (secure.kanban.*), shared by the
 * Kanban page, the Dashboard kanban card and the Business HQ kanban section.
 *
 * Columns todo / in_progress / review / done / blocked; project filter +
 * create / delete project; add task; move a task by its status select or by
 * dragging the card to another column; delete. Refetches on
 * `secure.lane.changed {kind:"kanban"}`. Never touches the normal kanban.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import { friendlySecureError, isSecureLockedError, SecureModeController, secureActive, secureRequest } from "./store";
import { secureBaseStyles } from "./styles";

export type SecureTaskStatus = "todo" | "in_progress" | "review" | "done" | "blocked";
export type SecurePriority = "low" | "medium" | "high" | "urgent";
export type SecureProject = { id: string; name: string; description?: string; createdAt: number; updatedAt: number };
export type SecureTask = {
  id: string;
  title: string;
  description?: string;
  status: SecureTaskStatus;
  priority?: SecurePriority;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
};

export const SECURE_COLUMNS: ReadonlyArray<{ id: SecureTaskStatus; label: string }> = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
  { id: "blocked", label: "Blocked" },
];
const PRIORITIES: SecurePriority[] = ["low", "medium", "high", "urgent"];
const ALL = "__all__";
const NONE = "__none__";

/** Tasks for one column under a project filter (pure, exported for tests). */
export function secureColumnTasks(tasks: SecureTask[], status: SecureTaskStatus, projectFilter: string): SecureTask[] {
  return tasks
    .filter((t) => t.status === status)
    .filter((t) => (projectFilter === ALL ? true : projectFilter === NONE ? !t.projectId : t.projectId === projectFilter))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

@customElement("ib-secure-board")
export class SecureBoard extends LitElement {
  /** Shorter board for embedded surfaces (Dashboard card / HQ section). */
  @property({ type: Boolean, reflect: true }) compact = false;

  @state() private projects: SecureProject[] = [];
  @state() private tasks: SecureTask[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private filter = ALL;
  @state() private newTitle = "";
  @state() private newPriority: SecurePriority | "" = "";
  @state() private projectFormOpen = false;
  @state() private newProject = "";
  @state() private dragId: string | null = null;
  @state() private overCol: SecureTaskStatus | null = null;
  @state() private openTaskId: string | null = null;

  private loadSeq = 0;
  private wasActive = false;

  private secure = new SecureModeController(this, {
    kinds: ["kanban"],
    onLane: () => void this.load(),
    onChange: (s) => {
      const active = secureActive(s);
      if (active && !this.wasActive) void this.load();
      if (!active) this.clear();
      this.wasActive = active;
    },
  });

  connectedCallback(): void {
    super.connectedCallback();
    this.wasActive = this.secure.active;
    if (this.wasActive) void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clear();
  }

  /** Drop all secure content from memory (lane locked / element removed). */
  private clear() {
    this.loadSeq++;
    this.projects = [];
    this.tasks = [];
    this.openTaskId = null;
  }

  private async load() {
    if (!this.secure.active) return;
    const seq = ++this.loadSeq;
    this.loading = true;
    try {
      const res = await secureRequest<{ projects?: SecureProject[]; tasks?: SecureTask[] }>("secure.kanban.list");
      if (seq !== this.loadSeq) return;
      this.projects = Array.isArray(res?.projects) ? res.projects : [];
      this.tasks = Array.isArray(res?.tasks) ? res.tasks : [];
      this.error = null;
      if (this.filter !== ALL && this.filter !== NONE && !this.projects.some((p) => p.id === this.filter)) this.filter = ALL;
    } catch (err) {
      if (seq !== this.loadSeq) return;
      if (isSecureLockedError(err)) this.clear();
      this.error = friendlySecureError(err);
    } finally {
      if (seq === this.loadSeq) this.loading = false;
    }
  }

  private async run(method: string, params: Record<string, unknown>) {
    try {
      await secureRequest(method, params);
      this.error = null;
    } catch (err) {
      this.error = friendlySecureError(err);
    }
    await this.load();
  }

  private async addTask(e: Event) {
    e.preventDefault();
    const title = this.newTitle.trim();
    if (!title) return;
    const projectId = this.filter !== ALL && this.filter !== NONE ? this.filter : undefined;
    this.newTitle = "";
    await this.run("secure.kanban.tasks.create", {
      title,
      status: "todo",
      ...(this.newPriority ? { priority: this.newPriority } : {}),
      ...(projectId ? { projectId } : {}),
    });
  }

  private async addProject(e: Event) {
    e.preventDefault();
    const name = this.newProject.trim();
    if (!name) return;
    this.newProject = "";
    this.projectFormOpen = false;
    try {
      const res = await secureRequest<{ project?: SecureProject }>("secure.kanban.projects.create", { name });
      if (res?.project?.id) this.filter = res.project.id;
    } catch (err) {
      this.error = friendlySecureError(err);
    }
    await this.load();
  }

  private async deleteProject() {
    const p = this.projects.find((x) => x.id === this.filter);
    if (!p) return;
    if (!window.confirm(`Delete the secure project "${p.name}"? Its tasks stay on the board without a project.`)) return;
    this.filter = ALL;
    await this.run("secure.kanban.projects.delete", { id: p.id });
  }

  private async move(id: string, status: SecureTaskStatus) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.status === status) return;
    // Optimistic: the card lands in its column immediately.
    this.tasks = this.tasks.map((x) => (x.id === id ? { ...x, status, updatedAt: Date.now() } : x));
    await this.run("secure.kanban.tasks.update", { id, patch: { status } });
  }

  private async patch(id: string, patch: Partial<SecureTask>) {
    await this.run("secure.kanban.tasks.update", { id, patch });
  }

  private async removeTask(t: SecureTask) {
    if (!window.confirm(`Delete "${t.title}" from the secure board?`)) return;
    this.tasks = this.tasks.filter((x) => x.id !== t.id);
    await this.run("secure.kanban.tasks.delete", { id: t.id });
  }

  private onDrop(e: DragEvent, col: SecureTaskStatus) {
    e.preventDefault();
    const id = e.dataTransfer?.getData("text/x-secure-task") || this.dragId;
    this.dragId = null;
    this.overCol = null;
    if (id) void this.move(id, col);
  }

  render() {
    if (!this.secure.active) {
      return html`<div class="sbd-locked">
        <span class="sbd-locked-ico">${icons.lock}</span>
        <strong>Secure board locked</strong>
        <span class="sm-muted">Turn on Secure Mode to open the encrypted board.</span>
        <ib-secure-toggle></ib-secure-toggle>
      </div>`;
    }
    const projectName = (id?: string) => (id ? (this.projects.find((p) => p.id === id)?.name ?? "") : "");
    const selectedProject = this.projects.find((p) => p.id === this.filter);
    return html`
      <div class="sbd">
        <div class="sbd-bar">
          <span class="sm-chip">${icons.lock} Secure board</span>
          <label class="sbd-filter">
            <span class="sr">Project</span>
            <select class="sm-input" aria-label="Secure project filter" .value=${this.filter} @change=${(e: Event) => (this.filter = (e.target as HTMLSelectElement).value)}>
              <option value=${ALL} ?selected=${this.filter === ALL}>All projects</option>
              <option value=${NONE} ?selected=${this.filter === NONE}>No project</option>
              ${this.projects.map((p) => html`<option value=${p.id} ?selected=${this.filter === p.id}>${p.name}</option>`)}
            </select>
          </label>
          ${this.projectFormOpen
            ? html`<form class="sbd-inline" @submit=${(e: Event) => void this.addProject(e)}>
                <input class="sm-input" placeholder="Project name" aria-label="New secure project name" .value=${this.newProject} @input=${(e: Event) => (this.newProject = (e.target as HTMLInputElement).value)} />
                <button class="sm-btn sm-btn--primary" type="submit" ?disabled=${!this.newProject.trim()}>Create</button>
                <button class="sm-btn" type="button" @click=${() => (this.projectFormOpen = false)}>Cancel</button>
              </form>`
            : html`<button class="sm-btn" type="button" data-secure-new-project @click=${() => (this.projectFormOpen = true)}>${icons.plus}<span>Project</span></button>`}
          ${selectedProject
            ? html`<button class="sm-btn sm-btn--danger sm-btn--icon" type="button" title="Delete project" aria-label="Delete project" @click=${() => void this.deleteProject()}>${icons.trash}</button>`
            : nothing}
          <button class="sm-btn sm-btn--icon" type="button" title="Refresh" aria-label="Refresh" @click=${() => void this.load()}>${icons.refresh}</button>
          <form class="sbd-add" @submit=${(e: Event) => void this.addTask(e)}>
            <input class="sm-input" placeholder=${selectedProject ? `New task in ${selectedProject.name}` : "New secure task"} aria-label="New secure task title" .value=${this.newTitle} @input=${(e: Event) => (this.newTitle = (e.target as HTMLInputElement).value)} />
            <select class="sm-input sbd-prio" aria-label="Priority" .value=${this.newPriority} @change=${(e: Event) => (this.newPriority = (e.target as HTMLSelectElement).value as SecurePriority | "")}>
              <option value="">Priority</option>
              ${PRIORITIES.map((p) => html`<option value=${p}>${p}</option>`)}
            </select>
            <button class="sm-btn sm-btn--primary" type="submit" data-secure-add-task ?disabled=${!this.newTitle.trim()}>${icons.plus}<span>Add task</span></button>
          </form>
        </div>
        ${this.error ? html`<div class="sm-error sbd-err" role="alert">${this.error}</div>` : nothing}
        <div class="sbd-cols" aria-busy=${this.loading ? "true" : "false"}>
          ${SECURE_COLUMNS.map((col) => {
            const list = secureColumnTasks(this.tasks, col.id, this.filter);
            return html`<section
              class="sbd-col ${this.overCol === col.id ? "sbd-col--over" : ""}"
              data-status=${col.id}
              aria-label=${col.label}
              @dragover=${(e: DragEvent) => {
                e.preventDefault();
                this.overCol = col.id;
              }}
              @dragleave=${() => (this.overCol = this.overCol === col.id ? null : this.overCol)}
              @drop=${(e: DragEvent) => this.onDrop(e, col.id)}
            >
              <header class="sbd-col-head"><span>${col.label}</span><b>${list.length}</b></header>
              <div class="sbd-list">
                ${list.map((t) => this.renderCard(t, projectName(t.projectId)))}
                ${list.length === 0 ? html`<div class="sbd-empty">${this.loading ? "Loading…" : "Drop tasks here"}</div>` : nothing}
              </div>
            </section>`;
          })}
        </div>
      </div>
    `;
  }

  private renderCard(t: SecureTask, project: string) {
    const open = this.openTaskId === t.id;
    return html`<article
      class="sbd-card ${this.dragId === t.id ? "sbd-card--drag" : ""}"
      draggable="true"
      data-task-id=${t.id}
      @dragstart=${(e: DragEvent) => {
        this.dragId = t.id;
        e.dataTransfer?.setData("text/x-secure-task", t.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }}
      @dragend=${() => {
        this.dragId = null;
        this.overCol = null;
      }}
    >
      <div class="sbd-card-top">
        <button class="sbd-card-title" type="button" aria-expanded=${open ? "true" : "false"} @click=${() => (this.openTaskId = open ? null : t.id)}>${t.title}</button>
        <button class="sm-btn sm-btn--icon sm-btn--danger sbd-del" type="button" title="Delete task" aria-label=${`Delete ${t.title}`} @click=${() => void this.removeTask(t)}>${icons.trash}</button>
      </div>
      <div class="sbd-card-meta">
        ${t.priority ? html`<span class="sbd-prio-tag sbd-prio-tag--${t.priority}">${t.priority}</span>` : nothing}
        ${project ? html`<span class="sbd-proj">${project}</span>` : nothing}
        <select class="sbd-status" aria-label="Move to column" .value=${t.status} @change=${(e: Event) => void this.move(t.id, (e.target as HTMLSelectElement).value as SecureTaskStatus)}>
          ${SECURE_COLUMNS.map((c) => html`<option value=${c.id} ?selected=${c.id === t.status}>${c.label}</option>`)}
        </select>
      </div>
      ${open
        ? html`<div class="sbd-detail">
            <textarea
              class="sm-input"
              rows="3"
              placeholder="Notes (encrypted)"
              aria-label="Task description"
              .value=${t.description ?? ""}
              @change=${(e: Event) => void this.patch(t.id, { description: (e.target as HTMLTextAreaElement).value })}
            ></textarea>
            <select class="sm-input" aria-label="Project" @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              void this.patch(t.id, { projectId: v === NONE ? "" : v });
            }}>
              <option value=${NONE} ?selected=${!t.projectId}>No project</option>
              ${this.projects.map((p) => html`<option value=${p.id} ?selected=${p.id === t.projectId}>${p.name}</option>`)}
            </select>
          </div>`
        : nothing}
    </article>`;
  }

  static styles = [
    secureBaseStyles,
    css`
      :host { display: block; min-height: 0; height: 100%; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      .sbd {
        display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 12px;
        border-radius: var(--sm-radius); border: 1px solid var(--sm-ring);
        background: linear-gradient(180deg, var(--sm-soft), transparent 140px), var(--sm-surface);
      }
      .sbd-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .sbd-inline, .sbd-add { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .sbd-add { margin-left: auto; flex: 1 1 320px; justify-content: flex-end; }
      .sbd-add .sm-input:first-child { flex: 1 1 200px; }
      .sbd-prio { width: 104px; }
      .sbd-err { padding: 6px 10px; border-radius: 8px; background: rgba(248, 113, 113, 0.1); }
      .sbd-cols {
        flex: 1; min-height: 280px; display: grid; gap: 10px;
        grid-template-columns: repeat(5, minmax(200px, 1fr)); overflow: auto;
      }
      :host([compact]) .sbd-cols { min-height: 240px; }
      .sbd-col {
        display: flex; flex-direction: column; min-height: 0; border-radius: var(--sm-radius-sm);
        border: 1px solid var(--sm-border); background: color-mix(in srgb, currentColor 3%, transparent);
        transition: border-color 0.15s ease, background 0.15s ease;
      }
      .sbd-col--over { border-color: var(--sm-accent); background: var(--sm-soft); }
      .sbd-col-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--sm-muted); }
      .sbd-col-head b { font-variant-numeric: tabular-nums; color: var(--sm-accent); }
      .sbd-list { display: flex; flex-direction: column; gap: 8px; padding: 0 8px 8px; overflow: auto; min-height: 60px; }
      .sbd-empty { padding: 14px 6px; text-align: center; font-size: 12px; color: var(--sm-muted); border: 1px dashed var(--sm-border); border-radius: 8px; }
      .sbd-card {
        display: flex; flex-direction: column; gap: 6px; padding: 9px 10px; border-radius: 10px;
        background: var(--sm-surface-2); border: 1px solid var(--sm-border); cursor: grab;
      }
      .sbd-card:hover { border-color: var(--sm-ring); }
      .sbd-card--drag { opacity: 0.5; }
      .sbd-card-top { display: flex; align-items: flex-start; gap: 6px; }
      .sbd-card-title { flex: 1; min-width: 0; text-align: left; background: none; border: 0; padding: 0; cursor: pointer; font-size: 13px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
      .sbd-card-title:focus-visible { outline: 2px solid var(--sm-accent); outline-offset: 2px; border-radius: 4px; }
      .sbd-del { width: 24px; min-height: 24px; opacity: 0.6; }
      .sbd-card:hover .sbd-del { opacity: 1; }
      .sbd-card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; }
      .sbd-proj { color: var(--sm-muted); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sbd-prio-tag { padding: 1px 7px; border-radius: 999px; font-weight: 650; text-transform: capitalize; background: color-mix(in srgb, currentColor 10%, transparent); }
      .sbd-prio-tag--high { color: #fbbf24; }
      .sbd-prio-tag--urgent { color: #f87171; }
      .sbd-status { margin-left: auto; font-size: 11px; padding: 2px 4px; border-radius: 6px; border: 1px solid var(--sm-border); background: var(--sm-surface); }
      .sbd-detail { display: flex; flex-direction: column; gap: 6px; }
      .sbd-detail textarea { min-height: 70px; font-family: inherit; font-size: 12.5px; }
      .sbd-locked { display: grid; place-items: center; align-content: center; gap: 8px; min-height: 220px; padding: 24px; text-align: center; border: 1px dashed var(--sm-ring); border-radius: var(--sm-radius); }
      .sbd-locked-ico { color: var(--sm-accent); }
      .sbd-locked-ico svg { width: 22px; height: 22px; }
      @media (max-width: 720px) {
        .sbd-cols { grid-template-columns: repeat(5, minmax(220px, 80vw)); }
        .sbd-add { margin-left: 0; }
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-secure-board": SecureBoard;
  }
}
