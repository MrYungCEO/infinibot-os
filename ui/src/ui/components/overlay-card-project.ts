/**
 * overlay-card-project.ts — project detail overlay (the "Project Detail Modal").
 *
 * payload: { id?, name?, status?, description? }
 *
 * Hydrates from `kanban.projects.list` (full row) + `kanban.tasks.list` and
 * renders: status badge + priority indicator, a done/total progress bar, a
 * per-status phase tracker, assignee/agent badges, a task list with status
 * colours, a related sub-projects list, and the action row (Edit, Mark
 * Complete, Open in Kanban — Close lives in the shared card chrome).
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base";
import { pathForTab, inferBasePathFromPathname } from "../navigation";

type ProjectRow = {
  id: string;
  name?: string;
  status?: string;
  description?: string;
  priority?: string;
  progress?: number;
  taskCount?: number;
  assignedInstances?: string[];
  parentProjectId?: string | null;
};
type TaskRow = {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: number;
  assignee?: string;
  assignedAgent?: string | null;
};

// Task-status → colour, shared with the board's column tones.
const TASK_TONE: Record<string, string> = {
  todo: "#3b82f6",
  in_progress: "#f59e0b",
  review: "#a855f7",
  done: "#10b981",
  backlog: "#71717a",
};

// The phase tracker walks these ordered task states.
const PHASES: { id: string; label: string }[] = [
  { id: "todo", label: "To Do" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

const PRIORITY_TONE: Record<string, string> = {
  immediate: "#f87171",
  critical: "#f87171",
  high: "#fb923c",
  medium: "#fbbf24",
  normal: "#fbbf24",
  low: "#94a3b8",
};

@customElement("overlay-card-project")
export class OverlayCardProject extends OverlayCardBase {
  @state() private project: ProjectRow = { id: "" };
  @state() private tasks: TaskRow[] = [];
  @state() private subProjects: ProjectRow[] = [];
  @state() private busy = false;

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      :host {
        width: 460px;
      }
      .pdesc {
        font-size: 12px;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
        line-height: 1.5;
        margin-bottom: 12px;
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 12px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        padding: 3px 9px;
        border-radius: 999px;
        color: var(--tone, #fbbf24);
        background: color-mix(in srgb, var(--tone, #fbbf24) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--tone, #fbbf24) 40%, transparent);
      }
      .badge .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--tone, #fbbf24);
      }
      .counter {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 8px;
      }
      .counter b {
        font-size: 26px;
        color: var(--g-primary, #fbbf24);
        font-variant-numeric: tabular-nums;
      }
      .counter span {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--g-fg-faint, rgba(245, 245, 244, 0.45));
      }
      .bar {
        height: 6px;
        border-radius: 6px;
        background: var(--g-surface-strong, rgba(255, 255, 255, 0.06));
        overflow: hidden;
        margin-bottom: 14px;
      }
      .bar > i {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, var(--g-primary, #fbbf24), #fcd34d);
      }
      .phases {
        display: flex;
        gap: 4px;
        margin-bottom: 14px;
      }
      .phase {
        flex: 1 1 0;
        text-align: center;
      }
      .phase .track {
        height: 4px;
        border-radius: 4px;
        background: var(--g-surface-strong, rgba(255, 255, 255, 0.06));
        margin-bottom: 4px;
      }
      .phase .track.on {
        background: var(--tone, #fbbf24);
      }
      .phase .lbl {
        font-size: 8px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--g-fg-faint, rgba(245, 245, 244, 0.5));
      }
      .phase .n {
        font-size: 10px;
        font-weight: 700;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.75));
      }
      .section {
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--g-fg-faint, rgba(245, 245, 244, 0.45));
        margin: 4px 0 6px;
      }
      .avatars {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-bottom: 12px;
      }
      .av {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 10px;
        padding: 3px 8px 3px 3px;
        border-radius: 999px;
        background: var(--g-surface-strong, rgba(255, 255, 255, 0.05));
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.8));
      }
      .av .pfp {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        font-size: 9px;
        font-weight: 800;
        color: #09090b;
        background: var(--g-primary, #fbbf24);
      }
      .rows {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-bottom: 12px;
      }
      .row {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 12px;
        padding: 4px 0;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.8));
      }
      .row .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex: 0 0 auto;
      }
      .row .t {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sub {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        padding: 5px 8px;
        border-radius: 8px;
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.12));
        background: var(--g-surface, rgba(255, 255, 255, 0.02));
        cursor: pointer;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.85));
        font-family: inherit;
        width: 100%;
        text-align: left;
        margin-bottom: 4px;
      }
      .sub:hover {
        border-color: var(--g-border-strong, rgba(251, 191, 36, 0.3));
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 14px;
      }
      .actions button {
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 7px 12px;
        border-radius: 8px;
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.2));
        background: var(--g-surface-strong, rgba(255, 255, 255, 0.05));
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.85));
        cursor: pointer;
        font-family: inherit;
      }
      .actions button:hover {
        border-color: var(--g-border-strong, rgba(251, 191, 36, 0.35));
      }
      .actions button.primary {
        border-color: var(--g-primary, #fbbf24);
        background: var(--g-primary-soft, rgba(251, 191, 36, 0.12));
        color: var(--g-primary, #fbbf24);
      }
      .actions button:disabled {
        opacity: 0.5;
        cursor: default;
      }
    `,
  ];

  protected get cardIcon() {
    return "❖";
  }
  protected get cardTitle() {
    return this.project.name || (this.payload.name as string) || "Project";
  }

  override firstUpdated() {
    super.firstUpdated();
    const p = this.payload;
    this.project = {
      id: String(p.id ?? ""),
      name: p.name as string,
      status: p.status as string,
      description: p.description as string,
    };
    void this.hydrate();
  }

  private async hydrate() {
    if (!this.gateway || !this.project.id) return;
    try {
      const proj = (await this.gateway.request("kanban.projects.list", {})) as
        | { projects?: ProjectRow[] }
        | ProjectRow[]
        | null;
      const list = Array.isArray(proj) ? proj : proj?.projects ?? [];
      const hit = list.find((x) => x.id === this.project.id);
      if (hit) this.project = { ...this.project, ...hit };
      this.subProjects = list.filter((x) => x.parentProjectId === this.project.id);
    } catch {
      /* projects RPC unavailable */
    }
    try {
      const res = (await this.gateway.request("kanban.tasks.list", {
        projectId: this.project.id,
      })) as { tasks?: TaskRow[] } | TaskRow[] | null;
      this.tasks = Array.isArray(res) ? res : res?.tasks ?? [];
    } catch {
      /* tasks RPC unavailable */
    }
  }

  private get assignees(): string[] {
    const s = new Set<string>();
    for (const a of this.project.assignedInstances ?? []) if (a) s.add(a);
    for (const t of this.tasks) {
      if (t.assignedAgent) s.add(t.assignedAgent);
      else if (t.assignee) s.add(t.assignee);
    }
    return [...s];
  }

  private openKanban() {
    const base = inferBasePathFromPathname(window.location.pathname);
    window.history.pushState({}, "", pathForTab("projects", base));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  private async markComplete() {
    if (!this.gateway || !this.project.id || this.busy) return;
    this.busy = true;
    this.project = { ...this.project, status: "Completed" };
    try {
      await this.gateway.request("kanban.projects.update", {
        id: this.project.id,
        status: "Completed",
      });
    } catch {
      /* optimistic — leave the local status even if the RPC lags */
    } finally {
      this.busy = false;
    }
  }

  private openSub(p: ProjectRow) {
    const payload = { id: p.id, name: p.name, status: p.status };
    if (this.gateway) {
      void this.gateway.request("ui.overlay.spawn", { type: "project", payload }).catch(() => {
        window.dispatchEvent(new CustomEvent("overlay.spawn", { detail: { type: "project", payload } }));
      });
    }
  }

  protected renderBody() {
    const total = this.tasks.length;
    const done = this.tasks.filter((t) => t.status === "done").length;
    const pct = total ? Math.round((done / total) * 100) : this.progressFallback();
    const latest = [...this.tasks]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 5);
    const prio = (this.project.priority ?? "").toLowerCase();
    const isDone = (this.project.status ?? "").toLowerCase() === "completed";

    return html`
      ${this.project.description
        ? html`<div class="pdesc">${this.project.description}</div>`
        : nothing}

      <div class="badges">
        ${this.project.status
          ? html`<span class="badge" style="--tone:${statusTone(this.project.status)}"
              ><span class="dot"></span>${this.project.status}</span
            >`
          : nothing}
        ${this.project.priority
          ? html`<span class="badge" style="--tone:${PRIORITY_TONE[prio] ?? "#94a3b8"}"
              >${this.project.priority} priority</span
            >`
          : nothing}
      </div>

      <div class="counter"><b>${done}</b><span>of ${total} tasks done</span></div>
      <div class="bar"><i style=${`width:${pct}%`}></i></div>

      <div class="phases">
        ${PHASES.map((ph) => {
          const n = this.tasks.filter((t) => (t.status ?? "") === ph.id).length;
          const tone = TASK_TONE[ph.id];
          return html`<div class="phase">
            <div class="n">${n}</div>
            <div class=${`track ${n ? "on" : ""}`} style=${`--tone:${tone}`}></div>
            <div class="lbl">${ph.label}</div>
          </div>`;
        })}
      </div>

      ${this.assignees.length
        ? html`<div class="section">Team</div>
            <div class="avatars">
              ${this.assignees.slice(0, 8).map(
                (a) => html`<span class="av"
                  ><span class="pfp">${a.slice(0, 1).toUpperCase()}</span>${a}</span
                >`,
              )}
            </div>`
        : nothing}

      <div class="section">${latest.length ? "Tasks" : "No tasks yet"}</div>
      <div class="rows">
        ${latest.map(
          (t) => html`<div class="row">
            <span class="dot" style=${`background:${TASK_TONE[t.status ?? ""] ?? "#71717a"}`}></span>
            <span class="t">${t.title || t.id}</span>
          </div>`,
        )}
      </div>

      ${this.subProjects.length
        ? html`<div class="section">Sub-projects (${this.subProjects.length})</div>
            ${this.subProjects.map(
              (s) => html`<button class="sub" @click=${() => this.openSub(s)}>
                <span class="dot" style=${`background:${statusTone(s.status)}`}></span>
                <span class="t">${s.name || s.id}</span>
              </button>`,
            )}`
        : nothing}

      <div class="actions">
        <button @click=${() => this.openKanban()}>Edit</button>
        <button class="primary" ?disabled=${this.busy || isDone} @click=${() => this.markComplete()}>
          ${isDone ? "Completed" : "Mark Complete"}
        </button>
        <button @click=${() => this.openKanban()}>Open in Kanban →</button>
      </div>
    `;
  }

  private progressFallback(): number {
    const p = this.project.progress;
    if (typeof p === "number" && Number.isFinite(p)) {
      return Math.max(0, Math.min(100, p <= 1 ? p * 100 : p));
    }
    return 0;
  }
}

// Project-status → colour (distinct from task tones).
function statusTone(status?: string): string {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
      return "#34d399";
    case "in progress":
      return "#fbbf24";
    case "updating":
      return "#38bdf8";
    case "reviewing":
      return "#a855f7";
    case "awaiting client":
      return "#f59e0b";
    case "cancelled":
      return "#f87171";
    case "paused":
      return "#94a3b8";
    default:
      return "#71717a";
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "overlay-card-project": OverlayCardProject;
  }
}
