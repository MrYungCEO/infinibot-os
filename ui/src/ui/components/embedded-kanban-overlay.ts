/**
 * <embedded-kanban-overlay> — the actionable affordance behind drift alerts.
 *
 * A compact, fully INTERACTIVE kanban board scoped to a single project, hosted
 * directly inside the proactive overlay layer (its own centered glass card +
 * dim backdrop, in the established walkthrough/canvas pattern). The operator
 * can push progress WITHOUT leaving the overlay:
 *   • drag a card between columns (To Do / In Progress / Review / Done)
 *   • add a card to the board
 *   • mark a card done in one tap
 *
 * Every mutation persists to the REAL kanban store via the existing gateway
 * RPCs (kanban.tasks.update / .create) — no separate DB. Changes broadcast on
 * `kanban:changed`, which this overlay also subscribes to so it stays in lock
 * step with the full board (and other clients) while it's open.
 *
 * It resolves the gateway client itself (awaitGatewayClient) so it can be
 * mounted by the overlay host exactly like <walkthrough-overlay> without the
 * host having to plumb a client property through the media pipeline.
 */

import { applyKanbanTaskUpdate, isKanbanTaskUpdatedPayload } from "../controllers/kanban-live";
import { applyPendingTaskWrites, beginPendingTaskWrite } from "../controllers/kanban-pending-writes";
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ProjectKanbanMedia, PopupAction } from "./proactive-popup-shared.js";
import { awaitGatewayClient, type GatewayBrowserClient } from "../gateway-client.js";
import type { GatewayEventFrame } from "../gateway.js";

type TaskStatus = "backlog" | "todo" | "in_progress" | "review" | "done";

interface BoardTask {
  id: string;
  projectId?: string;
  title: string;
  status: TaskStatus;
  priorityLevel?: string;
  priority?: string;
}

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To Do", color: "#3b82f6" },
  { id: "in_progress", label: "In Progress", color: "#f59e0b" },
  { id: "review", label: "Review", color: "#a855f7" },
  { id: "done", label: "Done", color: "#10b981" },
];

/** Fold dashed / undashed Notion ids so client-side filtering doesn't drop rows. */
function canonicalId(id: string | null | undefined): string {
  return (id ?? "").replace(/-/g, "").toLowerCase();
}

@customElement("embedded-kanban-overlay")
export class EmbeddedKanbanOverlay extends LitElement {
  @property({ attribute: false }) payload: ProjectKanbanMedia | null = null;
  /** Owning pop-up event id — dispatched back so the host can ack/dismiss. */
  @property({ type: String }) eventId = "";

  @state() private tasks: BoardTask[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private draggingId: string | null = null;
  @state() private dragOverCol: TaskStatus | null = null;
  @state() private addText = "";
  @state() private busyIds = new Set<string>();

  private client: GatewayBrowserClient | null = null;
  private unsub: (() => void) | null = null;
  private reloadTimer: number | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.init();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
  }

  protected updated(changed: Map<string, unknown>): void {
    // Re-load when the host swaps the overlay to a different project.
    if (changed.has("payload")) {
      const prev = changed.get("payload") as ProjectKanbanMedia | null;
      if (prev?.projectId !== this.payload?.projectId) void this.loadTasks();
    }
  }

  private async init(): Promise<void> {
    try {
      this.client = await awaitGatewayClient();
    } catch (e) {
      this.error = "Gateway not connected";
      this.loading = false;
      return;
    }
    // Stay in lock-step with the full board + other clients while open.
    this.unsub = this.client.subscribe((evt) => this.onGatewayEvent(evt));
    await this.loadTasks();
  }

  private onGatewayEvent(evt: GatewayEventFrame): void {
    // Versioned per-task update: patch in place, no refetch.
    if (evt.event === "kanban.task.updated") {
      if (isKanbanTaskUpdatedPayload(evt.payload)) {
        this.tasks = applyKanbanTaskUpdate(this.tasks, evt.payload);
      }
      return;
    }
    if (evt.event !== "kanban:changed") return;
    const p = (evt.payload ?? {}) as { entity?: string };
    if (p.entity && p.entity !== "task") return;
    // Debounced reconcile — coalesce bursts (drag, daemon flush) into one fetch.
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => void this.loadTasks(), 350);
  }

  private get projectId(): string {
    return this.payload?.projectId ?? "";
  }

  private async loadTasks(): Promise<void> {
    const client = this.client;
    const projectId = this.projectId;
    if (!client || !projectId) {
      this.loading = false;
      return;
    }
    try {
      const res = await client.request<BoardTask[] | { tasks?: BoardTask[] }>(
        "kanban.tasks.list",
        { projectId },
      );
      const list = Array.isArray(res) ? res : (res?.tasks ?? []);
      // Defensive: the server already scopes by project, but mixed dashed/
      // undashed sources can leak — keep only rows that match this project.
      const pid = canonicalId(projectId);
      // Writes still in flight / not yet agreed by the server stay applied.
      this.tasks = applyPendingTaskWrites(
        list.filter((t) => !t.projectId || canonicalId(t.projectId) === pid) as never[],
      ) as BoardTask[];
      this.error = null;
    } catch (e) {
      this.error = `Load failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.loading = false;
    }
  }

  // ── mutations (persist to the real store) ─────────────────────────────────
  private async moveTask(id: string, status: TaskStatus): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    const prevStatus = task.status;
    // Optimistic: reflect the move instantly.
    this.tasks = this.tasks.map((t) => (t.id === id ? { ...t, status } : t));
    this.markBusy(id, true);
    const patch: Record<string, unknown> = { status, done: status === "done" };
    const undoPending = beginPendingTaskWrite(id, patch);
    try {
      await this.client?.request("kanban.tasks.update", { id, patch });
    } catch (e) {
      // Revert on failure.
      undoPending();
      this.tasks = this.tasks.map((t) => (t.id === id ? { ...t, status: prevStatus } : t));
      this.error = `Move failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.markBusy(id, false);
    }
  }

  private async addCard(): Promise<void> {
    const title = this.addText.trim();
    const projectId = this.projectId;
    if (!title || !projectId || !this.client) return;
    this.addText = "";
    // Optimistic placeholder until the server returns the canonical row.
    const tempId = `temp-${title.length}-${this.tasks.length}-${title.slice(0, 6)}`;
    this.tasks = [{ id: tempId, projectId, title, status: "todo" }, ...this.tasks];
    try {
      const created = await this.client.request<BoardTask>("kanban.tasks.create", {
        title,
        projectId,
        status: "todo",
      });
      if (created?.id) {
        this.tasks = this.tasks.map((t) => (t.id === tempId ? { ...created } : t));
      } else {
        // No echo — let the kanban:changed reload reconcile.
        void this.loadTasks();
      }
    } catch (e) {
      this.tasks = this.tasks.filter((t) => t.id !== tempId);
      this.error = `Add failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private markBusy(id: string, on: boolean): void {
    const next = new Set(this.busyIds);
    if (on) next.add(id);
    else next.delete(id);
    this.busyIds = next;
  }

  // ── overlay-level actions (emitted to the host) ───────────────────────────
  private emitAction(action: PopupAction): void {
    this.dispatchEvent(
      new CustomEvent("popup-action", {
        detail: { eventId: this.eventId, action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private dismiss(): void {
    this.emitAction({ id: "dismiss", kind: "dismiss", label: "Dismiss", payload: { reason: "drift kanban dismissed" } });
  }

  private snooze(): void {
    this.emitAction({ id: "snooze", kind: "snooze", label: "Snooze", payload: { duration: "4h" } });
  }

  private openFullBoard(): void {
    this.emitAction({ id: "open", kind: "open", label: "Open board", payload: { target: "#/projects" } });
  }

  // ── drag / drop (native HTML5, mirrors the full board) ────────────────────
  private onDragStart(e: DragEvent, id: string): void {
    this.draggingId = id;
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }
  private onDragEnd(): void {
    this.draggingId = null;
    this.dragOverCol = null;
  }
  private onDragOver(e: DragEvent, col: TaskStatus): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (this.dragOverCol !== col) this.dragOverCol = col;
  }
  private onDrop(e: DragEvent, col: TaskStatus): void {
    e.preventDefault();
    this.dragOverCol = null;
    const id = e.dataTransfer?.getData("text/plain") || this.draggingId;
    this.draggingId = null;
    if (id) void this.moveTask(id, col);
  }

  // ── render ────────────────────────────────────────────────────────────────
  render() {
    const m = this.payload;
    if (!m) return nothing;
    const name = m.projectName || "Project";
    const headline = m.title || `${name} board`;
    const done = this.tasks.filter((t) => t.status === "done").length;
    const total = this.tasks.length;
    return html`
      <div class="ek-backdrop" @click=${(e: Event) => e.target === e.currentTarget && this.dismiss()}>
        <div class="ek-card" role="dialog" aria-label="Project board">
          <header class="ek-head">
            <div class="ek-head-text">
              <span class="ek-kicker">⚠ Drift · push progress</span>
              <h2 class="ek-title">${headline}</h2>
              ${m.subtitle ? html`<p class="ek-sub">${m.subtitle}</p>` : nothing}
            </div>
            <div class="ek-head-right">
              <span class="ek-progress">${done}/${total} done</span>
              <button class="ek-x" aria-label="Close" @click=${() => this.dismiss()}>✕</button>
            </div>
          </header>

          ${this.error ? html`<div class="ek-err">${this.error}</div>` : nothing}

          ${this.loading
            ? html`<div class="ek-loading">Loading board…</div>`
            : html`<div class="ek-board">${COLUMNS.map((c) => this.renderColumn(c))}</div>`}

          <footer class="ek-foot">
            <div class="ek-add">
              <input
                class="ek-add-input"
                placeholder="Add a card to To Do…"
                .value=${this.addText}
                @input=${(e: Event) => (this.addText = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") void this.addCard();
                }}
              />
              <button class="ek-add-btn" ?disabled=${!this.addText.trim()} @click=${() => void this.addCard()}>
                + Add
              </button>
            </div>
            <div class="ek-foot-actions">
              <button class="ek-btn" @click=${() => this.openFullBoard()}>Open full board</button>
              <button class="ek-btn ghost" @click=${() => this.snooze()}>Snooze 4h</button>
              <button class="ek-btn ghost" @click=${() => this.dismiss()}>Dismiss</button>
            </div>
          </footer>
        </div>
      </div>
    `;
  }

  private renderColumn(col: { id: TaskStatus; label: string; color: string }) {
    const items = this.tasks.filter((t) => t.status === col.id);
    const isOver = this.dragOverCol === col.id;
    return html`
      <section
        class="ek-col ${isOver ? "over" : ""}"
        style="--col:${col.color}"
        @dragover=${(e: DragEvent) => this.onDragOver(e, col.id)}
        @dragleave=${() => this.dragOverCol === col.id && (this.dragOverCol = null)}
        @drop=${(e: DragEvent) => this.onDrop(e, col.id)}
      >
        <div class="ek-col-head">
          <span class="ek-dot"></span>
          <span class="ek-col-label">${col.label}</span>
          <span class="ek-col-count">${items.length}</span>
        </div>
        <div class="ek-col-body">
          ${items.length === 0
            ? html`<div class="ek-empty">Drop here</div>`
            : items.map((t) => this.renderCard(t, col.id))}
        </div>
      </section>
    `;
  }

  private renderCard(t: BoardTask, col: TaskStatus) {
    const busy = this.busyIds.has(t.id);
    return html`
      <article
        class="ek-task ${this.draggingId === t.id ? "dragging" : ""} ${busy ? "busy" : ""}"
        draggable="true"
        @dragstart=${(e: DragEvent) => this.onDragStart(e, t.id)}
        @dragend=${() => this.onDragEnd()}
      >
        <div class="ek-task-title">${t.title}</div>
        <div class="ek-task-foot">
          ${t.priorityLevel || t.priority
            ? html`<span class="ek-prio">${t.priorityLevel || t.priority}</span>`
            : nothing}
          ${col !== "done"
            ? html`<button
                class="ek-done"
                title="Mark done"
                @click=${() => void this.moveTask(t.id, "done")}
              >
                ✓ Done
              </button>`
            : html`<span class="ek-done-tag">✓</span>`}
        </div>
      </article>
    `;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 9993;
      pointer-events: auto;
    }
    .ek-backdrop {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: radial-gradient(ellipse at center, rgba(8, 6, 2, 0.6) 0%, rgba(2, 2, 4, 0.9) 100%);
      backdrop-filter: blur(6px);
    }
    .ek-card {
      width: min(960px, 96vw);
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: linear-gradient(160deg, rgba(20, 18, 12, 0.96), rgba(10, 10, 14, 0.97));
      border: 1px solid rgba(212, 175, 55, 0.34);
      border-radius: 16px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(212, 175, 55, 0.08) inset;
      padding: 18px 18px 16px;
      color: var(--g-fg, #f5eacd);
    }
    .ek-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .ek-kicker {
      font-size: 0.62rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #fb923c;
    }
    .ek-title {
      margin: 3px 0 0;
      font-size: 1.16rem;
      font-weight: 800;
      color: var(--gold-1, #d4af37);
    }
    .ek-sub {
      margin: 3px 0 0;
      font-size: 0.78rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.66));
    }
    .ek-head-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ek-progress {
      font-size: 0.7rem;
      font-weight: 700;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.7));
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      padding: 3px 10px;
      white-space: nowrap;
    }
    .ek-x {
      background: none;
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.7));
      border-radius: 8px;
      width: 28px;
      height: 28px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .ek-x:hover {
      color: #fff;
      border-color: rgba(255, 255, 255, 0.3);
    }
    .ek-err {
      background: rgba(239, 68, 68, 0.16);
      color: #fca5a5;
      border: 1px solid rgba(239, 68, 68, 0.4);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 0.74rem;
    }
    .ek-loading {
      padding: 40px;
      text-align: center;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.6));
      font-size: 0.84rem;
    }
    .ek-board {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      overflow: auto;
      min-height: 220px;
    }
    .ek-col {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 12px;
      padding: 8px;
      transition: background 0.15s, border-color 0.15s;
    }
    .ek-col.over {
      background: color-mix(in srgb, var(--col) 14%, transparent);
      border-color: var(--col);
    }
    .ek-col-head {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 2px 4px;
    }
    .ek-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--col);
    }
    .ek-col-label {
      font-size: 0.72rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--g-fg, #f5eacd);
    }
    .ek-col-count {
      margin-left: auto;
      font-size: 0.66rem;
      font-weight: 700;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.55));
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      padding: 1px 7px;
    }
    .ek-col-body {
      display: flex;
      flex-direction: column;
      gap: 7px;
      min-height: 60px;
      flex: 1;
    }
    .ek-empty {
      border: 1px dashed rgba(255, 255, 255, 0.12);
      border-radius: 9px;
      padding: 14px 8px;
      text-align: center;
      font-size: 0.68rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.4));
    }
    .ek-task {
      background: linear-gradient(160deg, rgba(28, 26, 20, 0.9), rgba(16, 16, 22, 0.92));
      border: 1px solid rgba(212, 175, 55, 0.18);
      border-left: 3px solid var(--col);
      border-radius: 9px;
      padding: 8px 9px;
      cursor: grab;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ek-task:hover {
      border-color: rgba(212, 175, 55, 0.4);
    }
    .ek-task.dragging {
      opacity: 0.5;
    }
    .ek-task.busy {
      opacity: 0.7;
      pointer-events: none;
    }
    .ek-task-title {
      font-size: 0.78rem;
      font-weight: 600;
      line-height: 1.35;
      color: var(--g-fg, #f5eacd);
    }
    .ek-task-foot {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .ek-prio {
      font-size: 0.58rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.55));
      background: rgba(255, 255, 255, 0.06);
      border-radius: 4px;
      padding: 1px 5px;
    }
    .ek-done {
      margin-left: auto;
      background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #34d399;
      border-radius: 6px;
      padding: 2px 8px;
      font-size: 0.64rem;
      font-weight: 700;
      cursor: pointer;
    }
    .ek-done:hover {
      background: rgba(16, 185, 129, 0.26);
    }
    .ek-done-tag {
      margin-left: auto;
      color: #34d399;
      font-size: 0.8rem;
    }
    .ek-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      padding-top: 12px;
    }
    .ek-add {
      display: flex;
      gap: 7px;
      flex: 1;
      min-width: 240px;
    }
    .ek-add-input {
      flex: 1;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 8px;
      padding: 7px 10px;
      color: var(--g-fg, #f5eacd);
      font-size: 0.78rem;
    }
    .ek-add-input:focus {
      outline: none;
      border-color: var(--gold-1, #d4af37);
    }
    .ek-add-btn {
      background: linear-gradient(135deg, var(--gold-1, #d4af37), #b8902f);
      color: #1a1206;
      border: 0;
      border-radius: 8px;
      padding: 7px 14px;
      font-size: 0.76rem;
      font-weight: 800;
      cursor: pointer;
    }
    .ek-add-btn:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .ek-foot-actions {
      display: flex;
      gap: 7px;
    }
    .ek-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: var(--g-fg, #f5eacd);
      border-radius: 8px;
      padding: 7px 12px;
      font-size: 0.74rem;
      font-weight: 700;
      cursor: pointer;
    }
    .ek-btn.ghost {
      background: none;
    }
    .ek-btn:hover {
      border-color: rgba(212, 175, 55, 0.45);
    }
    @media (max-width: 640px) {
      .ek-board {
        grid-template-columns: repeat(2, 1fr);
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "embedded-kanban-overlay": EmbeddedKanbanOverlay;
  }
}
