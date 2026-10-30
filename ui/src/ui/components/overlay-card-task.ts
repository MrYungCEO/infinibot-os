/**
 * overlay-card-task.ts — kanban task detail overlay (the "Task Detail Card").
 *
 * payload: {
 *   id?, title?, status?, description?, projectId?, assignee?, priority?,
 *   dueDate?, createdAt?, updatedAt?, requiredSpecialties?, assignedAgent?,
 *   acceptanceCriteria?, subtasks?: Array<{ title, done }>
 * }
 *
 * Renders a status dropdown (persists via `kanban.tasks.update`), priority +
 * agent badges (with specialty icons), created/updated/due dates, acceptance
 * criteria, a subtask checklist, and the action row (Complete, Reassign, Add
 * Subtask). "Open in board" still dispatches `overlay-open-task` for the host.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base";

type Subtask = { title: string; done: boolean };

type TaskRow = {
  id: string;
  title?: string;
  status?: string;
  description?: string;
  projectId?: string;
  assignee?: string;
  assignedAgent?: string | null;
  priority?: string;
  dueDate?: string;
  createdAt?: number;
  updatedAt?: number;
  requiredSpecialties?: string[];
  acceptanceCriteria?: string;
  subtasks?: Subtask[];
};

const STATUS_TONE: Record<string, string> = {
  done: "#34d399",
  in_progress: "var(--g-primary, #fbbf24)",
  review: "#a855f7",
  todo: "#3b82f6",
  backlog: "#71717a",
  blocked: "#f87171",
};

const STATUS_OPTIONS = ["backlog", "todo", "in_progress", "review", "done"];

// A tiny glyph per specialty keyword so agent badges read at a glance.
const SPECIALTY_ICON: Record<string, string> = {
  frontend: "🖥",
  backend: "⚙",
  design: "🎨",
  research: "🔎",
  writing: "✎",
  data: "📊",
  qa: "✔",
  devops: "☁",
  security: "🛡",
};

function specialtyIcon(s: string): string {
  const k = s.toLowerCase();
  for (const key of Object.keys(SPECIALTY_ICON)) if (k.includes(key)) return SPECIALTY_ICON[key];
  return "●";
}

function fmtDate(v: string | number | undefined): string | null {
  if (v == null || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(v);
  if (isNaN(d.getTime())) return typeof v === "string" ? v : null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

@customElement("overlay-card-task")
export class OverlayCardTask extends OverlayCardBase {
  @state() private task: TaskRow = { id: "" };
  @state() private subtasks: Subtask[] = [];
  @state() private busy = false;

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .ttitle {
        font-size: 15px;
        font-weight: 600;
        color: var(--g-fg, #f5f5f4);
        margin-bottom: 8px;
        line-height: 1.35;
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin-bottom: 10px;
      }
      .statusSel {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 3px 8px;
        border-radius: 999px;
        background: var(--g-surface-strong, rgba(255, 255, 255, 0.06));
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.16));
      }
      .statusSel .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
      }
      .statusSel select {
        background: transparent;
        border: none;
        color: var(--g-fg, #f4f4f5);
        font: inherit;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        cursor: pointer;
        outline: none;
      }
      .statusSel select option {
        color: #000;
      }
      .chip {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        padding: 3px 8px;
        border-radius: 999px;
        color: var(--tone, #fbbf24);
        background: color-mix(in srgb, var(--tone, #fbbf24) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--tone, #fbbf24) 40%, transparent);
      }
      .agent {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 10px;
        padding: 3px 8px;
        border-radius: 999px;
        background: var(--g-surface-strong, rgba(255, 255, 255, 0.05));
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.85));
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 14px;
        font-size: 11px;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.6));
        margin-bottom: 10px;
      }
      .desc {
        font-size: 12px;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
        line-height: 1.5;
        white-space: pre-wrap;
        margin-bottom: 10px;
      }
      .section {
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--g-fg-faint, rgba(245, 245, 244, 0.45));
        margin: 6px 0 6px;
      }
      .ac {
        font-size: 12px;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.75));
        line-height: 1.5;
        border-left: 2px solid var(--g-primary-muted, rgba(251, 191, 36, 0.4));
        padding-left: 8px;
        margin-bottom: 10px;
        white-space: pre-wrap;
      }
      .subs {
        display: flex;
        flex-direction: column;
        gap: 3px;
        margin-bottom: 10px;
      }
      .st {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.8));
        cursor: pointer;
      }
      .st input {
        accent-color: var(--g-primary, #fbbf24);
      }
      .st.done span {
        text-decoration: line-through;
        opacity: 0.6;
      }
      .addRow {
        display: flex;
        gap: 6px;
        margin-bottom: 4px;
      }
      .addRow input {
        flex: 1 1 auto;
        font: inherit;
        font-size: 11px;
        padding: 5px 8px;
        border-radius: 7px;
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.16));
        background: var(--g-surface, rgba(255, 255, 255, 0.03));
        color: var(--g-fg, #f4f4f5);
        outline: none;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 12px;
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
    return "☑";
  }
  protected get cardTitle() {
    return "Task";
  }

  override firstUpdated() {
    super.firstUpdated();
    const p = this.payload;
    this.task = {
      id: String(p.id ?? ""),
      title: p.title as string,
      status: p.status as string,
      description: p.description as string,
      projectId: p.projectId as string,
      assignee: p.assignee as string,
      assignedAgent: p.assignedAgent as string,
      priority: p.priority as string,
      dueDate: p.dueDate as string,
      createdAt: p.createdAt as number,
      updatedAt: p.updatedAt as number,
      requiredSpecialties: Array.isArray(p.requiredSpecialties)
        ? (p.requiredSpecialties as string[])
        : undefined,
      acceptanceCriteria: p.acceptanceCriteria as string,
    };
    this.subtasks = Array.isArray(p.subtasks) ? (p.subtasks as Subtask[]) : [];
    void this.hydrate();
  }

  private async hydrate() {
    if (!this.task.id || !this.gateway) return;
    try {
      const res = (await this.gateway.request("kanban.tasks.list", {
        projectId: this.task.projectId,
      })) as { tasks?: TaskRow[] } | TaskRow[] | null;
      const rows = Array.isArray(res) ? res : res?.tasks ?? [];
      const hit = rows.find((t) => t.id === this.task.id);
      if (hit) this.task = { ...this.task, ...hit };
    } catch {
      /* kanban RPC unavailable — render inline payload */
    }
  }

  private open() {
    this.dispatchEvent(
      new CustomEvent("overlay-open-task", {
        detail: { taskId: this.task.id, projectId: this.task.projectId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async setStatus(status: string) {
    if (this.busy || !status || status === this.task.status) return;
    this.task = { ...this.task, status };
    if (!this.gateway || !this.task.id) return;
    this.busy = true;
    try {
      await this.gateway.request("kanban.tasks.update", { id: this.task.id, status });
    } catch {
      /* optimistic */
    } finally {
      this.busy = false;
    }
  }

  private toggleSub(i: number) {
    this.subtasks = this.subtasks.map((s, idx) => (idx === i ? { ...s, done: !s.done } : s));
  }

  private addSub(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    const input = e.target as HTMLInputElement;
    const title = input.value.trim();
    if (!title) return;
    this.subtasks = [...this.subtasks, { title, done: false }];
    input.value = "";
  }

  private focusAddSub() {
    const input = this.renderRoot.querySelector<HTMLInputElement>(".addRow input");
    input?.focus();
  }

  protected renderBody() {
    const t = this.task;
    const tone = STATUS_TONE[t.status ?? ""] ?? "#a1a1aa";
    const created = fmtDate(t.createdAt);
    const updated = fmtDate(t.updatedAt);
    const due = fmtDate(t.dueDate);
    const agent = t.assignedAgent || t.assignee;
    const isDone = t.status === "done";

    return html`
      <div class="ttitle">${t.title || "(untitled task)"}</div>

      <div class="badges">
        <span class="statusSel"
          ><span class="dot" style=${`background:${tone}`}></span>
          <select
            .value=${t.status ?? "todo"}
            ?disabled=${this.busy}
            @change=${(e: Event) => this.setStatus((e.target as HTMLSelectElement).value)}
          >
            ${STATUS_OPTIONS.map(
              (s) => html`<option value=${s} ?selected=${s === t.status}>
                ${s.replace(/_/g, " ")}
              </option>`,
            )}
          </select>
        </span>
        ${t.priority
          ? html`<span class="chip" style="--tone:#fb923c">${t.priority}</span>`
          : nothing}
        ${agent
          ? html`<span class="agent"
              >👤 ${agent}
              ${(t.requiredSpecialties ?? []).map((s) => html`<span title=${s}>${specialtyIcon(s)}</span>`)}
            </span>`
          : nothing}
      </div>

      <div class="meta">
        ${created ? html`<span>created · ${created}</span>` : nothing}
        ${updated ? html`<span>updated · ${updated}</span>` : nothing}
        ${due ? html`<span>due · ${due}</span>` : nothing}
      </div>

      ${t.description ? html`<div class="desc">${t.description}</div>` : nothing}

      ${t.acceptanceCriteria
        ? html`<div class="section">Acceptance criteria</div>
            <div class="ac">${t.acceptanceCriteria}</div>`
        : nothing}

      <div class="section">Subtasks ${this.subtasks.length ? `(${this.subtasks.filter((s) => s.done).length}/${this.subtasks.length})` : ""}</div>
      <div class="subs">
        ${this.subtasks.map(
          (s, i) => html`<label class=${`st ${s.done ? "done" : ""}`}>
            <input type="checkbox" .checked=${s.done} @change=${() => this.toggleSub(i)} />
            <span>${s.title}</span>
          </label>`,
        )}
      </div>
      <div class="addRow">
        <input placeholder="Add a subtask, then press Enter…" @keydown=${(e: KeyboardEvent) => this.addSub(e)} />
      </div>

      <div class="actions">
        <button class="primary" ?disabled=${this.busy || isDone} @click=${() => this.setStatus("done")}>
          ${isDone ? "Completed" : "Complete"}
        </button>
        <button @click=${() => this.open()}>Reassign</button>
        <button @click=${() => this.focusAddSub()}>Add Subtask</button>
        ${t.id ? html`<button @click=${() => this.open()}>Open in board →</button>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "overlay-card-task": OverlayCardTask;
  }
}
