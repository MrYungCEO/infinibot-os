/**
 * <todays-priorities> — the prominent shared daily priorities surface.
 *
 * A draggable, hierarchical, persistent checklist that paginates by day, lets
 * you search history, attach existing kanban tasks, and create brand-new tasks
 * (with a MANDATORY project). Backed by the gateway `priorities.*` RPCs and the
 * shared SQLite store, kept live via the `priorities:changed` WS broadcast so
 * the web dashboard and the mobile app stay in sync.
 *
 * Design language: InfiniBot black/gold glass (via the --g-* theme tokens).
 */

import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gatewayCall, getGatewayClient, awaitGatewayClient } from "../gateway-client.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway.js";

interface PriorityItem {
  id: string;
  date: string;
  title: string;
  parentId: string | null;
  ordinal: number;
  completed: boolean;
  taskId: string | null;
  projectId: string | null;
  projectName: string | null;
  note: string | null;
}

interface ProjectPick {
  id: string;
  name: string;
  status?: string;
  active?: boolean;
}
interface TaskPick {
  id: string;
  title: string;
  status?: string;
  projectId: string | null;
  projectName: string | null;
}

interface TreeNode extends PriorityItem {
  depth: number;
  children: TreeNode[];
}

function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate(),
  ).padStart(2, "0")}`;
}
function labelForDate(date: string): string {
  const today = isoToday();
  if (date === today) return "Today";
  if (date === shiftDate(today, -1)) return "Yesterday";
  if (date === shiftDate(today, 1)) return "Tomorrow";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

@customElement("todays-priorities")
export class TodaysPriorities extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) navigate: ((tab: string, params?: unknown) => void) | null = null;

  @state() private date = isoToday();
  @state() private items: PriorityItem[] = [];
  @state() private loading = true;
  @state() private error: string | null = null;

  @state() private newTitle = "";
  @state() private picker: "none" | "existing" | "create" = "none";
  @state() private projects: ProjectPick[] = [];
  @state() private tasks: TaskPick[] = [];
  @state() private pickerQuery = "";
  @state() private createTitle = "";
  @state() private createProjectId = "";
  @state() private createError: string | null = null;
  @state() private busy = false;

  @state() private searchQuery = "";
  @state() private searchResults: PriorityItem[] | null = null;

  @state() private dragId: string | null = null;
  @state() private dropHint: { targetId: string; mode: "before" | "after" | "child" } | null = null;

  private unsub: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    void this.subscribe();
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
  }
  updated(changed: PropertyValues): void {
    if (changed.has("client") && this.client && !this.unsub) void this.subscribe();
  }

  private async subscribe(): Promise<void> {
    if (this.unsub) return;
    let client = this.client ?? getGatewayClient();
    if (!client) {
      try {
        client = await awaitGatewayClient(8000);
      } catch {
        return;
      }
    }
    this.unsub = client.subscribe((evt: GatewayEventFrame) => {
      if (evt.event === "priorities:changed") {
        const p = evt.payload as { date?: string } | undefined;
        // Refresh if the change touched the day we're viewing (or is unknown).
        if (!p?.date || p.date === this.date) void this.load(true);
      }
    });
  }

  private async load(silent = false): Promise<void> {
    if (!silent) this.loading = true;
    this.error = null;
    try {
      const res = await gatewayCall<{ items: PriorityItem[] }>("priorities.listByDate", {
        date: this.date,
      });
      this.items = res.items ?? [];
    } catch (e) {
      this.error = String((e as Error)?.message ?? e);
    } finally {
      this.loading = false;
    }
  }

  /* ── Tree helpers ─────────────────────────────────────────────── */
  private buildTree(items: PriorityItem[]): TreeNode[] {
    const byId = new Map<string, TreeNode>();
    items.forEach((it) => byId.set(it.id, { ...it, depth: 0, children: [] }));
    const roots: TreeNode[] = [];
    for (const node of byId.values()) {
      if (node.parentId && byId.has(node.parentId)) {
        byId.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const sortRec = (nodes: TreeNode[], depth: number) => {
      nodes.sort((a, b) => a.ordinal - b.ordinal);
      for (const n of nodes) {
        n.depth = depth;
        sortRec(n.children, depth + 1);
      }
    };
    sortRec(roots, 0);
    return roots;
  }
  private flatten(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
    for (const n of nodes) {
      out.push(n);
      this.flatten(n.children, out);
    }
    return out;
  }

  /* ── Mutations ────────────────────────────────────────────────── */
  private async addItem(): Promise<void> {
    const title = this.newTitle.trim();
    if (!title) return;
    this.newTitle = "";
    await gatewayCall("priorities.add", { date: this.date, title });
    await this.load(true);
  }
  private async toggle(item: PriorityItem): Promise<void> {
    // optimistic
    this.items = this.items.map((i) =>
      i.id === item.id ? { ...i, completed: !i.completed } : i,
    );
    await gatewayCall("priorities.toggle", { id: item.id });
    await this.load(true);
  }
  private async remove(item: PriorityItem): Promise<void> {
    await gatewayCall("priorities.remove", { id: item.id });
    await this.load(true);
  }

  private async openPicker(kind: "existing" | "create"): Promise<void> {
    this.picker = kind;
    this.createError = null;
    this.pickerQuery = "";
    await this.refreshPickerData();
    if (kind === "create" && !this.createProjectId && this.projects[0]) {
      this.createProjectId = this.projects[0].id;
    }
  }
  private async refreshPickerData(): Promise<void> {
    try {
      const res = await gatewayCall<{ projects: ProjectPick[]; tasks: TaskPick[] }>(
        "priorities.pickerData",
        { query: this.pickerQuery },
      );
      this.projects = res.projects ?? [];
      this.tasks = res.tasks ?? [];
    } catch (e) {
      this.createError = String((e as Error)?.message ?? e);
    }
  }
  private async addExistingTask(t: TaskPick): Promise<void> {
    this.busy = true;
    try {
      await gatewayCall("priorities.addExistingTask", { date: this.date, taskId: t.id });
      this.picker = "none";
      await this.load(true);
    } catch (e) {
      this.createError = String((e as Error)?.message ?? e);
    } finally {
      this.busy = false;
    }
  }
  private async createTaskAndAdd(): Promise<void> {
    const title = this.createTitle.trim();
    this.createError = null;
    if (!title) {
      this.createError = "Task title is required.";
      return;
    }
    if (!this.createProjectId) {
      this.createError = "Choose a project — tasks must belong to a project.";
      return;
    }
    this.busy = true;
    try {
      await gatewayCall("priorities.createTaskAndAdd", {
        date: this.date,
        title,
        projectId: this.createProjectId,
      });
      this.createTitle = "";
      this.picker = "none";
      await this.load(true);
    } catch (e) {
      this.createError = String((e as Error)?.message ?? e);
    } finally {
      this.busy = false;
    }
  }

  /* ── Date pagination ──────────────────────────────────────────── */
  private goDate(days: number): void {
    this.date = shiftDate(this.date, days);
    this.searchResults = null;
    void this.load();
  }
  private goToday(): void {
    this.date = isoToday();
    this.searchResults = null;
    void this.load();
  }

  /* ── History search ───────────────────────────────────────────── */
  private async runSearch(): Promise<void> {
    const q = this.searchQuery.trim();
    if (!q) {
      this.searchResults = null;
      return;
    }
    try {
      const res = await gatewayCall<{ items: PriorityItem[] }>("priorities.search", { query: q });
      this.searchResults = res.items ?? [];
    } catch (e) {
      this.error = String((e as Error)?.message ?? e);
    }
  }
  private clearSearch(): void {
    this.searchQuery = "";
    this.searchResults = null;
  }
  private jumpToDate(date: string): void {
    this.date = date;
    this.searchResults = null;
    this.searchQuery = "";
    void this.load();
  }

  /* ── Drag & drop (reorder + nest) ─────────────────────────────── */
  private onDragStart(e: DragEvent, id: string): void {
    this.dragId = id;
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }
  private onDragOver(e: DragEvent, target: TreeNode): void {
    if (!this.dragId || this.dragId === target.id) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const x = e.clientX - rect.left;
    let mode: "before" | "after" | "child";
    if (y < rect.height * 0.35) mode = "before";
    else if (x > 40) mode = "child";
    else mode = "after";
    this.dropHint = { targetId: target.id, mode };
  }
  private onDragEnd(): void {
    this.dragId = null;
    this.dropHint = null;
  }
  private isDescendant(tree: TreeNode[], ancestorId: string, maybeChildId: string): boolean {
    const find = (nodes: TreeNode[]): TreeNode | null => {
      for (const n of nodes) {
        if (n.id === ancestorId) return n;
        const f = find(n.children);
        if (f) return f;
      }
      return null;
    };
    const anc = find(tree);
    if (!anc) return false;
    const walk = (n: TreeNode): boolean =>
      n.id === maybeChildId || n.children.some(walk);
    return anc.children.some(walk);
  }
  private async onDrop(e: DragEvent, target: TreeNode): Promise<void> {
    e.preventDefault();
    const dragId = this.dragId;
    const hint = this.dropHint;
    this.onDragEnd();
    if (!dragId || dragId === target.id || !hint) return;

    const tree = this.buildTree(this.items);
    // Guard: can't drop a node inside its own subtree.
    if (this.isDescendant(tree, dragId, target.id)) return;

    // Detach dragged subtree.
    let dragged: TreeNode | null = null;
    const detach = (nodes: TreeNode[]): TreeNode[] =>
      nodes.filter((n) => {
        if (n.id === dragId) {
          dragged = n;
          return false;
        }
        n.children = detach(n.children);
        return true;
      });
    const pruned = detach(tree);
    if (!dragged) return;

    // Insert relative to target.
    const insert = (nodes: TreeNode[]): boolean => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.id === target.id) {
          if (hint.mode === "before") nodes.splice(i, 0, dragged!);
          else if (hint.mode === "after") nodes.splice(i + 1, 0, dragged!);
          else n.children.unshift(dragged!); // child
          return true;
        }
        if (insert(n.children)) return true;
      }
      return false;
    };
    if (!insert(pruned)) return;

    // Recompute flat order with parentId + ordinal.
    const order: Array<{ id: string; parentId: string | null; ordinal: number }> = [];
    const walk = (nodes: TreeNode[], parentId: string | null) => {
      nodes.forEach((n, idx) => {
        order.push({ id: n.id, parentId, ordinal: idx });
        walk(n.children, n.id);
      });
    };
    walk(pruned, null);

    // Optimistic local apply, then persist.
    const byId = new Map(order.map((o) => [o.id, o]));
    this.items = this.items.map((i) => {
      const o = byId.get(i.id);
      return o ? { ...i, parentId: o.parentId, ordinal: o.ordinal } : i;
    });
    await gatewayCall("priorities.reorder", { date: this.date, order });
    await this.load(true);
  }

  /* ── Render ───────────────────────────────────────────────────── */
  private renderRow(node: TreeNode) {
    const hint = this.dropHint?.targetId === node.id ? this.dropHint.mode : null;
    return html`
      <div
        class="row ${node.completed ? "done" : ""} ${this.dragId === node.id ? "dragging" : ""} ${
          hint ? `hint-${hint}` : ""
        }"
        style="padding-left:${node.depth * 22 + 4}px"
        draggable="true"
        @dragstart=${(e: DragEvent) => this.onDragStart(e, node.id)}
        @dragover=${(e: DragEvent) => this.onDragOver(e, node)}
        @drop=${(e: DragEvent) => this.onDrop(e, node)}
        @dragend=${() => this.onDragEnd()}
      >
        <span class="grip" title="Drag to reorder / nest">⋮⋮</span>
        <button
          class="check ${node.completed ? "on" : ""}"
          @click=${() => this.toggle(node)}
          aria-label=${node.completed ? "Mark incomplete" : "Mark complete"}
        >
          ${node.completed ? "✓" : ""}
        </button>
        <span class="title">${node.title}</span>
        ${
          node.projectName
            ? html`<span class="chip" title="Linked project">${node.projectName}</span>`
            : nothing
        }
        ${node.taskId ? html`<span class="chip task" title="Linked task">task</span>` : nothing}
        <button class="del" @click=${() => this.remove(node)} aria-label="Remove">✕</button>
      </div>
    `;
  }

  private renderPicker() {
    if (this.picker === "none") return nothing;
    return html`
      <div class="picker-backdrop" @click=${() => (this.picker = "none")}>
        <div class="picker glass-panel" @click=${(e: Event) => e.stopPropagation()}>
          <div class="picker-head">
            <div class="tabs">
              <button
                class=${this.picker === "existing" ? "active" : ""}
                @click=${() => this.openPicker("existing")}
              >
                Add existing task
              </button>
              <button
                class=${this.picker === "create" ? "active" : ""}
                @click=${() => this.openPicker("create")}
              >
                Create new task
              </button>
            </div>
            <button class="x" @click=${() => (this.picker = "none")}>✕</button>
          </div>
          ${this.createError ? html`<div class="err">${this.createError}</div>` : nothing}
          ${this.picker === "existing" ? this.renderExistingPicker() : this.renderCreatePicker()}
        </div>
      </div>
    `;
  }
  private renderExistingPicker() {
    return html`
      <input
        class="inp"
        placeholder="Search tasks…"
        .value=${this.pickerQuery}
        @input=${(e: Event) => {
          this.pickerQuery = (e.target as HTMLInputElement).value;
          void this.refreshPickerData();
        }}
      />
      <div class="task-list">
        ${
          this.tasks.length === 0
            ? html`<div class="muted">No tasks found.</div>`
            : this.tasks.map(
                (t) => html`
                  <button class="task-opt" ?disabled=${this.busy} @click=${() => this.addExistingTask(t)}>
                    <span class="t">${t.title}</span>
                    <span class="p">${t.projectName ?? "—"}</span>
                  </button>
                `,
              )
        }
      </div>
    `;
  }
  private renderCreatePicker() {
    return html`
      <input
        class="inp"
        placeholder="New task title…"
        .value=${this.createTitle}
        @input=${(e: Event) => (this.createTitle = (e.target as HTMLInputElement).value)}
      />
      <label class="lbl">Project <span class="req">*required</span></label>
      <select
        class="inp"
        .value=${this.createProjectId}
        @change=${(e: Event) => (this.createProjectId = (e.target as HTMLSelectElement).value)}
      >
        <option value="" disabled>Choose a project…</option>
        ${this.projects.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
      </select>
      ${
        this.projects.length === 0
          ? html`<div class="muted">No projects yet — create one on the board first.</div>`
          : nothing
      }
      <button class="primary" ?disabled=${this.busy} @click=${() => this.createTaskAndAdd()}>
        Create task &amp; add
      </button>
    `;
  }

  render() {
    const tree = this.buildTree(this.items);
    const flat = this.flatten(tree);
    const done = this.items.filter((i) => i.completed).length;
    const searching = this.searchResults !== null;
    return html`
      <section class="band glass-panel hud-frame">
        <header class="head">
          <div class="titlebar">
            <span class="icon">★</span>
            <h2>Today's Priorities</h2>
            ${
              this.items.length
                ? html`<span class="count">${done}/${this.items.length}</span>`
                : nothing
            }
          </div>
          <div class="pager">
            <button @click=${() => this.goDate(-1)} title="Previous day">‹</button>
            <button class="daylbl" @click=${() => this.goToday()} title="Jump to today">
              ${labelForDate(this.date)}
            </button>
            <button @click=${() => this.goDate(1)} title="Next day">›</button>
          </div>
        </header>

        <div class="searchbar">
          <input
            class="inp"
            placeholder="Search priority history…"
            .value=${this.searchQuery}
            @input=${(e: Event) => (this.searchQuery = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") void this.runSearch();
            }}
          />
          <button @click=${() => this.runSearch()}>Search</button>
          ${searching ? html`<button class="ghost" @click=${() => this.clearSearch()}>Clear</button>` : nothing}
        </div>

        ${this.error ? html`<div class="err">${this.error}</div>` : nothing}

        ${
          searching
            ? html`
                <div class="results">
                  <div class="muted">${this.searchResults!.length} result(s)</div>
                  ${this.searchResults!.map(
                    (r) => html`
                      <button class="result" @click=${() => this.jumpToDate(r.date)}>
                        <span class="rt ${r.completed ? "done" : ""}">${r.title}</span>
                        <span class="rd">${labelForDate(r.date)}</span>
                      </button>
                    `,
                  )}
                </div>
              `
            : html`
                ${
                  this.loading
                    ? html`<div class="muted">Loading…</div>`
                    : flat.length === 0
                      ? html`<div class="empty">No priorities yet for ${labelForDate(
                          this.date,
                        )}. Add one below or pull in a task.</div>`
                      : html`<div class="list">${flat.map((n) => this.renderRow(n))}</div>`
                }

                <div class="addbar">
                  <input
                    class="inp"
                    placeholder="Add a priority…"
                    .value=${this.newTitle}
                    @input=${(e: Event) => (this.newTitle = (e.target as HTMLInputElement).value)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter") void this.addItem();
                    }}
                  />
                  <button class="add" @click=${() => this.addItem()}>Add</button>
                  <button class="ghost" @click=${() => this.openPicker("existing")}>+ Task</button>
                  <button class="ghost" @click=${() => this.openPicker("create")}>+ New</button>
                </div>
              `
        }
      </section>
      ${this.renderPicker()}
    `;
  }

  static styles = css`
    :host {
      display: block;
      margin: 12px 0;
    }
    .band {
      border-radius: 18px;
      padding: 16px 18px 18px;
      background:
        radial-gradient(
          140% 120% at 0% 0%,
          color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent) 0%,
          transparent 55%
        ),
        linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.012));
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent);
      box-shadow: inset 0 0 40px color-mix(in srgb, var(--g-primary, #fbbf24) 5%, transparent);
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .titlebar {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .icon {
      color: var(--g-primary, #fbbf24);
      font-size: 18px;
    }
    h2 {
      margin: 0;
      font-size: 16px;
      letter-spacing: 0.3px;
      color: var(--g-fg, #f5f5f4);
    }
    .count {
      font-size: 12px;
      color: var(--g-primary, #fbbf24);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent);
      border-radius: 999px;
      padding: 2px 9px;
    }
    .pager {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .pager button {
      background: rgba(255, 255, 255, 0.04);
      color: var(--g-fg, #f5f5f4);
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent);
      border-radius: 8px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 13px;
    }
    .pager .daylbl {
      min-width: 92px;
      color: var(--g-primary, #fbbf24);
      font-weight: 600;
    }
    .pager button:hover {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
    }
    .searchbar,
    .addbar {
      display: flex;
      gap: 8px;
      margin: 10px 0;
    }
    .inp {
      flex: 1;
      background: rgba(0, 0, 0, 0.28);
      color: var(--g-fg, #f5f5f4);
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 16%, transparent);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 13px;
      outline: none;
    }
    .inp:focus {
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 45%, transparent);
    }
    select.inp option {
      background: #0a0a0e;
      color: var(--g-fg, #f5f5f4);
    }
    button {
      font-family: inherit;
    }
    .searchbar button,
    .addbar button {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
      color: var(--g-primary, #fbbf24);
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent);
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13px;
      white-space: nowrap;
    }
    .addbar .add {
      background: var(--g-primary, #fbbf24);
      color: #0a0a0e;
      font-weight: 600;
    }
    .ghost {
      background: rgba(255, 255, 255, 0.04) !important;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65)) !important;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 6px;
      border-radius: 8px;
      border: 1px solid transparent;
      transition:
        background 0.12s,
        border-color 0.12s;
    }
    .row:hover {
      background: rgba(255, 255, 255, 0.03);
    }
    .row.dragging {
      opacity: 0.45;
    }
    .row.hint-before {
      box-shadow: inset 0 2px 0 0 var(--g-primary, #fbbf24);
    }
    .row.hint-after {
      box-shadow: inset 0 -2px 0 0 var(--g-primary, #fbbf24);
    }
    .row.hint-child {
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent);
    }
    .grip {
      cursor: grab;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
      font-size: 12px;
      user-select: none;
    }
    .check {
      width: 20px;
      height: 20px;
      border-radius: 6px;
      border: 1.5px solid color-mix(in srgb, var(--g-primary, #fbbf24) 40%, transparent);
      background: transparent;
      color: #0a0a0e;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      flex-shrink: 0;
    }
    .check.on {
      background: var(--g-primary, #fbbf24);
      border-color: var(--g-primary, #fbbf24);
    }
    .title {
      flex: 1;
      color: var(--g-fg, #f5f5f4);
      font-size: 13.5px;
    }
    .row.done .title {
      text-decoration: line-through;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
    }
    .chip {
      font-size: 10.5px;
      color: var(--g-primary, #fbbf24);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent);
      border-radius: 999px;
      padding: 1px 7px;
    }
    .chip.task {
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.12);
    }
    .del {
      background: transparent;
      border: none;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
      cursor: pointer;
      opacity: 0;
      font-size: 12px;
    }
    .row:hover .del {
      opacity: 1;
    }
    .del:hover {
      color: #ef4444;
    }
    .empty,
    .muted {
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.6));
      font-size: 13px;
      padding: 10px 4px;
    }
    .err {
      color: #ef4444;
      font-size: 12.5px;
      padding: 6px 4px;
    }
    .results {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .result {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      text-align: left;
    }
    .result:hover {
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 35%, transparent);
    }
    .result .rt {
      color: var(--g-fg, #f5f5f4);
      font-size: 13px;
    }
    .result .rt.done {
      text-decoration: line-through;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
    }
    .result .rd {
      color: var(--g-primary, #fbbf24);
      font-size: 11.5px;
    }
    /* Picker modal */
    .picker-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      backdrop-filter: blur(4px);
    }
    .picker {
      width: min(460px, 92vw);
      max-height: 78vh;
      overflow: auto;
      border-radius: 16px;
      padding: 16px;
      background: linear-gradient(180deg, #14141a, #0c0c10);
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent);
    }
    .picker-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .tabs {
      display: flex;
      gap: 6px;
    }
    .tabs button {
      background: rgba(255, 255, 255, 0.04);
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12.5px;
    }
    .tabs button.active {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 16%, transparent);
      color: var(--g-primary, #fbbf24);
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 35%, transparent);
    }
    .picker .x {
      background: transparent;
      border: none;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
      cursor: pointer;
      font-size: 15px;
    }
    .picker .inp {
      width: 100%;
      box-sizing: border-box;
      margin-bottom: 10px;
    }
    .lbl {
      display: block;
      font-size: 12px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
      margin-bottom: 4px;
    }
    .req {
      color: #ef4444;
      font-size: 11px;
    }
    .task-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 4px;
    }
    .task-opt {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 8px;
      padding: 9px 11px;
      cursor: pointer;
      text-align: left;
    }
    .task-opt:hover {
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 35%, transparent);
    }
    .task-opt .t {
      color: var(--g-fg, #f5f5f4);
      font-size: 13px;
    }
    .task-opt .p {
      color: var(--g-primary, #fbbf24);
      font-size: 11px;
    }
    .primary {
      width: 100%;
      margin-top: 12px;
      background: var(--g-primary, #fbbf24);
      color: #0a0a0e;
      border: none;
      border-radius: 8px;
      padding: 10px;
      font-weight: 600;
      font-size: 13.5px;
      cursor: pointer;
    }
    .primary:disabled {
      opacity: 0.5;
      cursor: default;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "todays-priorities": TodaysPriorities;
  }
}
