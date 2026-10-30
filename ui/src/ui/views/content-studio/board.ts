/**
 * <cs-pipeline-board> — the drag-and-drop production board.
 *
 * Drag mechanics follow the Tasks kanban (views/kanban.ts): native HTML5
 * drag events, the drop index from the hovered card's vertical midpoint, a
 * drop-indicator line, and re-renders gated on requestAnimationFrame while a
 * drag is in flight. Moves apply optimistically and then persist through
 * content-studio.items.move; a failed write reloads the board.
 *
 * Stages: drag a column header to reorder, double-click the name to rename,
 * the ⋯ menu sets colour / WIP limit / done flag or deletes (moving items).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { directive, Directive, type ElementPart, type PartInfo, PartType } from "lit/directive.js";

import { PLATFORMS, STAGE_COLORS, dueLabel, mediaSrc, type Board, type Item, type Stage, type StudioApi } from "./api.js";
import "../../components/holo-panel.js";
import { edgeScrollStep } from "./edge-scroll.js";
import { ensureStudioStyles } from "./styles.js";

const ITEM_MIME = "application/x-cs-item";
const STAGE_MIME = "application/x-cs-stage";

type Drag =
  | { kind: "item"; id: string; overStage: string | null; overIndex: number }
  | { kind: "stage"; id: string; overIndex: number };

function daysIn(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 86_400_000);
  return d <= 0 ? "today" : `${d}d`;
}

@customElement("cs-pipeline-board")
export class CsPipelineBoard extends LitElement {
  @property({ attribute: false }) api: StudioApi | null = null;
  @property({ attribute: false }) board: Board | null = null;

  @state() private drag: Drag | null = null;
  @state() private search = "";
  @state() private platform = "";
  @state() private renaming: string | null = null;
  @state() private menuFor: string | null = null;
  @state() private quickAdd: string | null = null;
  @state() private deleting: Stage | null = null;
  @state() private error: string | null = null;

  private raf: number | null = null;

  protected createRenderRoot() {
    ensureStudioStyles();
    return this;
  }

  private emitChanged() {
    this.dispatchEvent(new CustomEvent("cs-changed", { bubbles: true }));
  }

  private fail(err: unknown) {
    this.error = String(err instanceof Error ? err.message : err);
    this.emitChanged(); // reload server truth
  }

  /** RAF-gated rerender while dragging (same as the Tasks kanban). */
  private scheduleRender() {
    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.requestUpdate();
    });
  }

  private itemsIn(stageId: string): Item[] {
    const q = this.search.trim().toLowerCase();
    return (this.board?.items ?? [])
      .filter((i) => i.stageId === stageId)
      .filter((i) => !this.platform || i.platform === this.platform)
      .filter(
        (i) =>
          !q ||
          i.title.toLowerCase().includes(q) ||
          i.summary.toLowerCase().includes(q) ||
          i.tags.some((t) => t.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.position - b.position);
  }

  /**
   * Edge auto-scroll while a drag is in flight. `dragover` keeps firing while
   * the pointer rests, so each event nudges the hovered column body (vertical)
   * and the board (horizontal) when the pointer sits near their edges.
   */
  private autoScroll(e: DragEvent) {
    const target = e.target as Element | null;
    const body = target?.closest?.(".cs-col-body") as HTMLElement | null;
    if (body) {
      // Measure the edge zones on the on-screen part: on phones the column
      // runs past the viewport, so its real bottom edge is unreachable.
      const r = body.getBoundingClientRect();
      const dy = edgeScrollStep(e.clientY, Math.max(r.top, 0), Math.min(r.bottom, window.innerHeight));
      if (dy) body.scrollTop += dy;
    }
    const boardEl = this.querySelector(".cs-board") as HTMLElement | null;
    if (boardEl) {
      const r = boardEl.getBoundingClientRect();
      const dx = edgeScrollStep(e.clientX, Math.max(r.left, 0), Math.min(r.right, window.innerWidth));
      if (dx) {
        // Mandatory snap (mobile) would pull each small nudge straight back.
        boardEl.style.scrollSnapType = "none";
        boardEl.scrollLeft += dx;
      }
    }
  }

  // ── Item drag ──────────────────────────────────────────────────────────

  private onItemDragStart(e: DragEvent, item: Item) {
    e.stopPropagation();
    e.dataTransfer?.setData(ITEM_MIME, item.id);
    e.dataTransfer?.setData("text/plain", item.title);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    e.dataTransfer?.setDragImage(el, rect.width / 2, 20);
    this.drag = { kind: "item", id: item.id, overStage: null, overIndex: -1 };
    requestAnimationFrame(() => el.classList.add("is-dragging"));
  }

  private onDragEnd = () => {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.drag = null;
    (this.querySelector(".cs-board") as HTMLElement | null)?.style.removeProperty("scroll-snap-type");
    this.querySelectorAll(".is-dragging").forEach((n) => n.classList.remove("is-dragging"));
  };

  private onCardDragOver(e: DragEvent, stageId: string, index: number) {
    const d = this.drag;
    if (d?.kind !== "item") return;
    e.preventDefault();
    e.stopPropagation();
    this.autoScroll(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = e.clientY < rect.top + rect.height / 2 ? index : index + 1;
    if (d.overStage !== stageId || d.overIndex !== at) {
      d.overStage = stageId;
      d.overIndex = at;
      this.scheduleRender();
    }
  }

  private onColumnDragOver(e: DragEvent, stageId: string) {
    const d = this.drag;
    if (d?.kind !== "item") return;
    e.preventDefault();
    this.autoScroll(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (d.overStage !== stageId) {
      d.overStage = stageId;
      d.overIndex = this.itemsIn(stageId).length;
      this.scheduleRender();
    }
  }

  private async onColumnDrop(e: DragEvent, stage: Stage) {
    const d = this.drag;
    if (d?.kind !== "item" || !this.board || !this.api) return;
    e.preventDefault();
    const id = d.id;
    const dragged = this.board.items.find((i) => i.id === id);
    // The drop index is in the *visible* (filtered) list; anchor on the first
    // visible card at/after it so hidden cards keep their places.
    const visible = this.itemsIn(stage.id);
    const overIdx = d.overStage === stage.id && d.overIndex >= 0 ? d.overIndex : visible.length;
    const anchor = visible.slice(overIdx).find((i) => i.id !== id);
    this.onDragEnd();
    if (!dragged) return;
    const byPos = (a: Item, b: Item) => a.position - b.position;
    const rest = this.board.items.filter((i) => i.id !== id).map((i) => ({ ...i }));
    const dest = rest.filter((i) => i.stageId === stage.id).sort(byPos);
    const toIndex = anchor ? dest.findIndex((i) => i.id === anchor.id) : dest.length;
    const crossing = dragged.stageId !== stage.id;
    if (!crossing) {
      const fromIndex = this.board.items.filter((i) => i.stageId === stage.id).sort(byPos).findIndex((i) => i.id === id);
      if (fromIndex === toIndex) return;
    }
    // Optimistic: splice locally and repack both stages.
    dest.splice(toIndex, 0, {
      ...dragged,
      stageId: stage.id,
      stageEnteredAt: crossing ? Date.now() : dragged.stageEnteredAt,
    });
    dest.forEach((i, n) => (i.position = n));
    if (crossing) {
      rest.filter((i) => i.stageId === dragged.stageId).sort(byPos).forEach((i, n) => (i.position = n));
    }
    const items = [...rest.filter((i) => i.stageId !== stage.id), ...dest];
    this.board = { stages: this.recount(this.board.stages, items), items };
    try {
      await this.api.moveItem(id, stage.id, toIndex);
      this.emitChanged();
    } catch (err) {
      this.fail(err);
    }
  }

  private recount(stages: Stage[], items: Item[]): Stage[] {
    return stages.map((s) => {
      const count = items.filter((i) => i.stageId === s.id).length;
      return { ...s, count, overWip: s.wipLimit !== null && count > s.wipLimit };
    });
  }

  // ── Stage drag (reorder columns) ───────────────────────────────────────

  private onStageDragStart(e: DragEvent, stage: Stage) {
    if (this.renaming) return;
    e.dataTransfer?.setData(STAGE_MIME, stage.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    const col = (e.currentTarget as HTMLElement).closest(".cs-col") as HTMLElement | null;
    if (col) e.dataTransfer?.setDragImage(col, 40, 20);
    this.drag = { kind: "stage", id: stage.id, overIndex: -1 };
  }

  private onStageDragOver(e: DragEvent, index: number) {
    const d = this.drag;
    if (d?.kind !== "stage") return;
    e.preventDefault();
    this.autoScroll(e);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = e.clientX < rect.left + rect.width / 2 ? index : index + 1;
    if (d.overIndex !== at) {
      d.overIndex = at;
      this.scheduleRender();
    }
  }

  private async onStageDrop(e: DragEvent) {
    const d = this.drag;
    if (d?.kind !== "stage" || !this.board || !this.api) return;
    e.preventDefault();
    const order = this.board.stages.map((s) => s.id);
    const from = order.indexOf(d.id);
    let to = d.overIndex < 0 ? from : d.overIndex;
    this.onDragEnd();
    if (from < to) to -= 1;
    if (from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, d.id);
    const byId = new Map(this.board.stages.map((s) => [s.id, s]));
    this.board = { ...this.board, stages: order.map((id, n) => ({ ...byId.get(id)!, position: n })) };
    try {
      await this.api.reorderStages(order);
      this.emitChanged();
    } catch (err) {
      this.fail(err);
    }
  }

  // ── Stage edits ────────────────────────────────────────────────────────

  private async updateStage(stage: Stage, p: Parameters<StudioApi["updateStage"]>[1]) {
    if (!this.api) return;
    try {
      await this.api.updateStage(stage.id, p);
      this.emitChanged();
    } catch (err) {
      this.fail(err);
    }
  }

  private async addStage() {
    if (!this.api) return;
    const name = window.prompt("New stage name", "Review");
    if (!name?.trim()) return;
    const n = this.board?.stages.length ?? 0;
    const doneIdx = this.board?.stages.findIndex((s) => s.isDone) ?? -1;
    try {
      await this.api.createStage({
        name: name.trim(),
        color: STAGE_COLORS[n % STAGE_COLORS.length],
        // New stages land before the "done" column.
        index: doneIdx >= 0 ? doneIdx : n,
      });
      this.emitChanged();
    } catch (err) {
      this.fail(err);
    }
  }

  private async confirmDelete(stage: Stage, moveTo: string | undefined) {
    if (!this.api) return;
    this.deleting = null;
    try {
      await this.api.deleteStage(stage.id, moveTo);
      this.emitChanged();
    } catch (err) {
      this.fail(err);
    }
  }

  private async addItem(stage: Stage, title: string) {
    if (!this.api || !title.trim()) return;
    try {
      const { item } = await this.api.createItem({
        title: title.trim(),
        stageId: stage.id,
        platform: this.platform || undefined,
      });
      if (this.board) this.board = { stages: this.recount(this.board.stages, [...this.board.items, item]), items: [...this.board.items, item] };
      this.emitChanged();
    } catch (err) {
      this.fail(err);
    }
  }

  private open(item: Item) {
    this.dispatchEvent(new CustomEvent("cs-open-item", { bubbles: true, detail: { itemId: item.id } }));
  }

  // ── Render ─────────────────────────────────────────────────────────────

  render() {
    const board = this.board;
    if (!board) return html`<div class="cs-board-loading">Loading pipeline…</div>`;
    const total = board.items.length;
    const done = new Set(board.stages.filter((s) => s.isDone).map((s) => s.id));
    const published = board.items.filter((i) => done.has(i.stageId)).length;
    const overdue = board.items.filter((i) => i.dueAt && i.dueAt < Date.now() && !done.has(i.stageId)).length;
    const over = board.stages.filter((s) => s.overWip);
    return html`
      <div class="cs-board-wrap" @dragend=${this.onDragEnd}>
        <div class="cs-board-bar">
          <div class="cs-kpis">
            <holo-panel tone="gold" compact
              ><span slot="title">ITEMS</span><b class="cs-kpi">${total}</b></holo-panel
            >
            <holo-panel tone="gold" compact
              ><span slot="title">IN PROGRESS</span><b class="cs-kpi">${total - published}</b></holo-panel
            >
            <holo-panel tone="gold" compact
              ><span slot="title">PUBLISHED</span><b class="cs-kpi">${published}</b></holo-panel
            >
            <holo-panel tone=${over.length || overdue ? "danger" : "teal"} compact ?active=${over.length > 0}
              ><span slot="title">WIP / LATE</span
              ><b class="cs-kpi">${over.length}<small> over</small> · ${overdue}<small> late</small></b></holo-panel
            >
          </div>
          <div class="cs-board-tools">
            <input
              class="cs-input cs-search"
              type="search"
              placeholder="Search cards, tags…"
              .value=${this.search}
              @input=${(e: Event) => (this.search = (e.target as HTMLInputElement).value)}
            />
            <select
              class="cs-select"
              aria-label="Platform filter"
              @change=${(e: Event) => (this.platform = (e.target as HTMLSelectElement).value)}
            >
              <option value="">All platforms</option>
              ${PLATFORMS.map((p) => html`<option value=${p} ?selected=${this.platform === p}>${p}</option>`)}
            </select>
            <button class="cs-btn cs-btn-ghost" @click=${() => this.addStage()}>+ Stage</button>
            <button class="cs-btn cs-btn-primary" @click=${() => (this.quickAdd = board.stages[0]?.id ?? null)}>
              + New item
            </button>
          </div>
        </div>
        ${this.error
          ? html`<div class="cs-error" role="alert">
              ${this.error} <button class="cs-link" @click=${() => (this.error = null)}>Dismiss</button>
            </div>`
          : nothing}
        <div
          class="cs-board ${this.drag?.kind === "stage" ? "is-stage-drag" : ""}"
          @drop=${(e: DragEvent) => void this.onStageDrop(e)}
        >
          ${board.stages.map((s, i) => this.renderColumn(s, i))}
          <button class="cs-col-add" @click=${() => this.addStage()} aria-label="Add stage">
            <span>+</span> Add stage
          </button>
        </div>
        ${this.deleting ? this.renderDeleteDialog(this.deleting) : nothing}
      </div>
    `;
  }

  private renderColumn(stage: Stage, index: number) {
    const items = this.itemsIn(stage.id);
    const d = this.drag;
    const itemOver = d?.kind === "item" && d.overStage === stage.id;
    const stageDropBefore = d?.kind === "stage" && d.overIndex === index && d.id !== stage.id;
    const stageDropAfter =
      d?.kind === "stage" && d.overIndex === index + 1 && index === (this.board?.stages.length ?? 0) - 1;
    const wip = stage.wipLimit;
    const fill = wip ? Math.min(1, stage.count / wip) : 0;
    return html`
      <section
        class="cs-col ${itemOver ? "is-over" : ""} ${stage.overWip ? "is-over-wip" : ""} ${d?.kind === "stage" && d.id === stage.id ? "is-dragging" : ""} ${stageDropBefore ? "drop-before" : ""} ${stageDropAfter ? "drop-after" : ""}"
        style="--stage:${stage.color}"
        aria-label=${`${stage.name} stage, ${stage.count} items`}
        @dragover=${(e: DragEvent) => {
          if (this.drag?.kind === "stage") this.onStageDragOver(e, index);
          else this.onColumnDragOver(e, stage.id);
        }}
        @drop=${(e: DragEvent) => {
          if (this.drag?.kind === "item") {
            e.stopPropagation();
            void this.onColumnDrop(e, stage);
          }
        }}
      >
        <header
          class="cs-col-head"
          draggable=${this.renaming === stage.id ? "false" : "true"}
          title="Drag to reorder stages"
          @dragstart=${(e: DragEvent) => this.onStageDragStart(e, stage)}
        >
          <span class="cs-col-dot" aria-hidden="true"></span>
          ${this.renaming === stage.id
            ? html`<input
                class="cs-col-rename"
                .value=${stage.name}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") this.renaming = null;
                }}
                @blur=${(e: Event) => {
                  const v = (e.target as HTMLInputElement).value.trim();
                  this.renaming = null;
                  if (v && v !== stage.name) void this.updateStage(stage, { name: v });
                }}
              />`
            : html`<h3 class="cs-col-name" @dblclick=${() => (this.renaming = stage.id)}>
                ${stage.name}${stage.isDone ? html`<span class="cs-done-mark" title="Done stage">✓</span>` : nothing}
              </h3>`}
          <span class="cs-col-count ${stage.overWip ? "is-over" : ""}"
            >${stage.count}${wip ? html`<span class="cs-wip-of">/${wip}</span>` : nothing}</span
          >
          <button
            class="cs-icon-btn"
            aria-label=${`${stage.name} stage options`}
            @click=${(e: Event) => {
              e.stopPropagation();
              this.menuFor = this.menuFor === stage.id ? null : stage.id;
            }}
          >
            ⋯
          </button>
          ${this.menuFor === stage.id ? this.renderStageMenu(stage, index) : nothing}
        </header>
        ${wip
          ? html`<div class="cs-wip-bar" title=${`WIP ${stage.count} of ${wip}`}>
              <span style="width:${Math.round(fill * 100)}%"></span>
            </div>`
          : nothing}
        ${stage.overWip ? html`<div class="cs-wip-warn">Over WIP limit — finish before starting more</div>` : nothing}
        <div class="cs-col-body">
          ${items.map((it, n) => this.renderCard(it, stage, n))}
          ${itemOver && d?.kind === "item" && d.overIndex >= items.length && items.length > 0
            ? html`<div class="cs-drop-line"></div>`
            : nothing}
          ${items.length === 0
            ? html`<div class="cs-col-empty ${itemOver ? "is-active" : ""}">
                ${itemOver ? "Drop here" : this.search || this.platform ? "No matches" : "No items yet"}
              </div>`
            : nothing}
        </div>
        ${this.quickAdd === stage.id
          ? html`<form
              class="cs-quick-add"
              @submit=${(e: Event) => {
                e.preventDefault();
                const input = (e.currentTarget as HTMLFormElement).querySelector("input")!;
                void this.addItem(stage, input.value);
                input.value = "";
              }}
            >
              <input
                class="cs-input"
                placeholder="Title, then Enter"
                aria-label=${`New item in ${stage.name}`}
                @keydown=${(e: KeyboardEvent) => e.key === "Escape" && (this.quickAdd = null)}
                ${autofocus()}
              />
              <button type="button" class="cs-icon-btn" aria-label="Close" @click=${() => (this.quickAdd = null)}>
                ×
              </button>
            </form>`
          : html`<button class="cs-col-foot" @click=${() => (this.quickAdd = stage.id)}>+ Add item</button>`}
      </section>
    `;
  }

  private renderStageMenu(stage: Stage, index: number) {
    const n = this.board?.stages.length ?? 0;
    const order = this.board?.stages.map((s) => s.id) ?? [];
    const move = (dir: -1 | 1) => {
      const to = index + dir;
      if (to < 0 || to >= n || !this.api) return;
      [order[index], order[to]] = [order[to]!, order[index]!];
      this.menuFor = null;
      void this.api.reorderStages(order).then(() => this.emitChanged(), (e) => this.fail(e));
    };
    return html`
      <div class="cs-menu" role="menu" @click=${(e: Event) => e.stopPropagation()}>
        <button role="menuitem" @click=${() => ((this.renaming = stage.id), (this.menuFor = null))}>Rename</button>
        <div class="cs-menu-row" aria-label="Colour">
          ${STAGE_COLORS.map(
            (c) => html`<button
              class="cs-swatch ${c === stage.color ? "is-on" : ""}"
              style="background:${c}"
              aria-label=${`Colour ${c}`}
              @click=${() => void this.updateStage(stage, { color: c })}
            ></button>`,
          )}
        </div>
        <label class="cs-menu-field"
          >WIP limit
          <input
            type="number"
            min="0"
            max="999"
            class="cs-input"
            .value=${stage.wipLimit ? String(stage.wipLimit) : ""}
            placeholder="none"
            @change=${(e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              void this.updateStage(stage, { wipLimit: v > 0 ? v : null });
            }}
        /></label>
        <label class="cs-menu-check"
          ><input
            type="checkbox"
            .checked=${stage.isDone}
            @change=${(e: Event) => void this.updateStage(stage, { isDone: (e.target as HTMLInputElement).checked })}
          />
          Counts as published</label
        >
        <div class="cs-menu-row">
          <button ?disabled=${index === 0} @click=${() => move(-1)}>← Move</button>
          <button ?disabled=${index === n - 1} @click=${() => move(1)}>Move →</button>
        </div>
        <button
          role="menuitem"
          class="cs-danger"
          ?disabled=${n <= 1}
          @click=${() => {
            this.menuFor = null;
            if (stage.count === 0) void this.confirmDelete(stage, undefined);
            else this.deleting = stage;
          }}
        >
          Delete stage
        </button>
      </div>
    `;
  }

  private renderDeleteDialog(stage: Stage) {
    const others = (this.board?.stages ?? []).filter((s) => s.id !== stage.id);
    let target = others[0]?.id;
    return html`
      <div class="cs-modal-back" @click=${() => (this.deleting = null)}>
        <div class="cs-modal" role="dialog" aria-label="Delete stage" @click=${(e: Event) => e.stopPropagation()}>
          <h3>Delete “${stage.name}”?</h3>
          <p>It holds ${stage.count} item${stage.count === 1 ? "" : "s"}. Move them to:</p>
          <select class="cs-select" @change=${(e: Event) => (target = (e.target as HTMLSelectElement).value)}>
            ${others.map((s) => html`<option value=${s.id}>${s.name}</option>`)}
          </select>
          <div class="cs-modal-actions">
            <button class="cs-btn cs-btn-ghost" @click=${() => (this.deleting = null)}>Cancel</button>
            <button class="cs-btn cs-btn-danger" @click=${() => void this.confirmDelete(stage, target)}>
              Delete &amp; move items
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderCard(item: Item, stage: Stage, index: number) {
    const d = this.drag;
    const showBefore = d?.kind === "item" && d.overStage === stage.id && d.overIndex === index && d.id !== item.id;
    const due = dueLabel(item.dueAt);
    const cover = item.cover;
    return html`
      ${showBefore ? html`<div class="cs-drop-line"></div>` : nothing}
      <article
        class="cs-card ${d?.kind === "item" && d.id === item.id ? "is-dragging" : ""}"
        draggable="true"
        tabindex="0"
        aria-label=${item.title}
        @dragstart=${(e: DragEvent) => this.onItemDragStart(e, item)}
        @dragover=${(e: DragEvent) => this.onCardDragOver(e, stage.id, index)}
        @click=${() => this.open(item)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") this.open(item);
        }}
      >
        ${cover
          ? html`<div class="cs-card-cover">
              ${cover.kind === "video"
                ? html`<video src=${`${mediaSrc(cover.url)}#t=0.5`} preload="metadata" muted playsinline></video
                    ><span class="cs-play" aria-hidden="true">▶</span>`
                : html`<img src=${mediaSrc(cover.url)} alt="" loading="lazy" draggable="false" />`}
            </div>`
          : nothing}
        <div class="cs-card-body">
          <div class="cs-card-chips">
            ${item.platform ? html`<span class="cs-chip cs-chip-plat" data-p=${item.platform}>${item.platform}</span>` : nothing}
            ${item.format ? html`<span class="cs-chip">${item.format}</span>` : nothing}
            ${due ? html`<span class="cs-chip cs-due ${due.tone}">${due.tone === "late" ? "⚠ " : ""}${due.text}</span>` : nothing}
          </div>
          <h4 class="cs-card-title">${item.title}</h4>
          ${item.summary ? html`<p class="cs-card-sum">${item.summary}</p>` : nothing}
          ${item.tags.length
            ? html`<div class="cs-card-tags">${item.tags.slice(0, 4).map((t) => html`<span>#${t}</span>`)}</div>`
            : nothing}
          <footer class="cs-card-foot">
            <span title="Words on the page">✎ ${item.docWords}</span>
            <span title="Attached media">⧉ ${item.mediaCount}</span>
            <span class="cs-age" title="Time in this stage">${daysIn(item.stageEnteredAt)}</span>
          </footer>
        </div>
      </article>
    `;
  }
}

/** Focus the element once, when it first renders (quick-add input). */
const focused = new WeakSet<Element>();
class AutofocusDirective extends Directive {
  constructor(info: PartInfo) {
    super(info);
    if (info.type !== PartType.ELEMENT) throw new Error("autofocus() is an element directive");
  }
  render() {
    return nothing;
  }
  update(part: ElementPart) {
    const el = part.element as HTMLElement;
    if (!focused.has(el)) {
      focused.add(el);
      queueMicrotask(() => el.focus());
    }
    return nothing;
  }
}
const autofocus = directive(AutofocusDirective);

declare global {
  interface HTMLElementTagNameMap {
    "cs-pipeline-board": CsPipelineBoard;
  }
}
