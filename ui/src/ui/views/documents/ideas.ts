/**
 * <ib-documents-ideas> — Documents › Ideas.
 *
 *   ┌──────────────────────────────┬─────────────────────────────────────┐
 *   │ quick add  (title ⏎)         │ title · status · source · age       │
 *   │ search · status chips · tags │ body (editable)                     │
 *   │ list of ideas                │ tags · linked project/task/document │
 *   │                              │ promote → task / project / document │
 *   └──────────────────────────────┴─────────────────────────────────────┘
 *
 * Data: ideas.* RPCs (src/gateway/server-methods/ideas.ts). Live refresh on
 * the `ideas.changed` gateway event (re-dispatched by app-gateway as the
 * window `ideas:changed` event) — ideas captured by voice on the phone or by
 * an agent appear here without a reload. On narrow screens the detail pane
 * replaces the list (Back returns).
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { icons } from "../../icons";
import "../../components/people-chips";
import type { RpcClient } from "./api";
import { loadProjectRepos, onProjectReposChange, projectOptionLabel } from "../../project-repos/index";
import {
  IDEA_STATUS_META,
  IDEA_STATUS_ORDER,
  SOURCE_LABEL,
  excerpt,
  filterIdeas,
  parseTagInput,
  promotedLabel,
  relTime,
  type Idea,
  type IdeaPromoteTarget,
  type IdeaStatus,
  type IdeasListPayload,
} from "./ideas-model";

type Named = { id: string; name: string };

@customElement("ib-documents-ideas")
export class DocumentsIdeas extends LitElement {
  @property({ attribute: false }) client: RpcClient | null = null;
  /** Idea to open once the list has loaded (Documents library → "open in Ideas"). */
  @property({ attribute: false }) focusId: string | null = null;

  @state() private ideas: Idea[] = [];
  @state() private counts: Record<IdeaStatus, number> = { new: 0, exploring: 0, parked: 0, promoted: 0 };
  @state() private tags: Array<{ tag: string; count: number }> = [];
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private query = "";
  @state() private status: IdeaStatus | "all" = "all";
  @state() private tag: string | null = null;
  @state() private selectedId: string | null = null;
  @state() private draftTitle = "";
  @state() private busy: string | null = null;
  @state() private toast: { text: string; error?: boolean } | null = null;
  @state() private projects: Named[] = [];
  @state() private docs: Named[] = [];
  @state() private promoteProject = "";
  @state() private editTitle = "";
  @state() private editBody = "";
  @state() private editTags = "";
  @state() private dirty = false;

  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onChanged = () => void this.load(true);

  protected willUpdate(changed: Map<string, unknown>): void {
    // A focus request while already loaded selects straight away.
    if (changed.has("focusId") && this.focusId && !this.loading) {
      const want = this.ideas.find((i) => i.id === this.focusId);
      if (want) {
        this.focusId = null;
        this.select(want);
      } else void this.load(true);
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("ideas:changed", this.onChanged);
    void this.load();
    void this.loadLinkTargets();
    this.offRepos = onProjectReposChange(() => this.requestUpdate());
    void loadProjectRepos();
  }

  private offRepos: (() => void) | null = null;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.offRepos?.();
    this.offRepos = null;
    window.removeEventListener("ideas:changed", this.onChanged);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  private async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.client) throw new Error("Not connected to the gateway");
    return this.client.request<T>(method, params ?? {});
  }

  private async load(quiet = false): Promise<void> {
    if (!quiet) this.loading = true;
    try {
      const res = await this.rpc<IdeasListPayload>("ideas.list", { limit: 500 });
      this.ideas = res.ideas ?? [];
      this.counts = res.counts ?? this.counts;
      this.tags = res.tags ?? [];
      this.error = null;
      if (this.focusId) {
        const want = this.ideas.find((i) => i.id === this.focusId);
        this.focusId = null;
        if (want) this.select(want);
      }
      const sel = this.selected;
      if (sel && !this.dirty) this.syncEditor(sel);
      if (this.selectedId && !sel) this.selectedId = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.error = /unknown method|not found|no handler/i.test(msg)
        ? "Ideas need a gateway restart to turn on (new ideas.* methods)."
        : msg;
    } finally {
      this.loading = false;
    }
  }

  private async loadLinkTargets(): Promise<void> {
    try {
      const raw = await this.rpc<unknown>("kanban.projects.list", {});
      const list = (Array.isArray(raw) ? raw : ((raw as { projects?: unknown[] })?.projects ?? [])) as Array<{ id?: string; name?: string; title?: string }>;
      this.projects = list.map((p) => ({ id: String(p.id ?? ""), name: String(p.name ?? p.title ?? p.id ?? "") })).filter((p) => p.id);
    } catch {
      this.projects = [];
    }
    try {
      const res = await this.rpc<{ notes?: Array<{ id: string; name?: string }> }>("notes.list", { limit: 300 });
      this.docs = (res.notes ?? []).map((n) => ({ id: n.id, name: n.name || n.id }));
    } catch {
      this.docs = [];
    }
  }

  private get selected(): Idea | null {
    return this.ideas.find((i) => i.id === this.selectedId) ?? null;
  }

  private flash(text: string, error = false): void {
    this.toast = { text, error };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), 3200);
  }

  private syncEditor(i: Idea): void {
    this.editTitle = i.title;
    this.editBody = i.body;
    this.editTags = i.tags.join(", ");
    this.dirty = false;
  }

  private select(i: Idea): void {
    this.selectedId = i.id;
    this.syncEditor(i);
    this.promoteProject = i.projectIds[0] ?? "";
  }

  private async run<T>(key: string, fn: () => Promise<T>, ok?: (r: T) => string): Promise<T | null> {
    this.busy = key;
    try {
      const r = await fn();
      if (ok) this.flash(ok(r));
      return r;
    } catch (err) {
      this.flash(err instanceof Error ? err.message : String(err), true);
      return null;
    } finally {
      this.busy = null;
    }
  }

  private async quickAdd(): Promise<void> {
    const title = this.draftTitle.trim();
    if (!title) return;
    const res = await this.run(
      "add",
      () => this.rpc<{ idea: Idea }>("ideas.create", { title, source: "web" }),
      () => "Idea saved",
    );
    if (res?.idea) {
      this.draftTitle = "";
      await this.load(true);
      this.select(res.idea);
    }
  }

  private async save(): Promise<void> {
    const i = this.selected;
    if (!i) return;
    const res = await this.run(
      "save",
      () => this.rpc<{ idea: Idea }>("ideas.update", { id: i.id, patch: { title: this.editTitle, body: this.editBody, tags: parseTagInput(this.editTags) } }),
      () => "Saved",
    );
    if (res) {
      this.dirty = false;
      await this.load(true);
    }
  }

  private async setStatus(status: IdeaStatus): Promise<void> {
    const i = this.selected;
    if (!i || i.status === status) return;
    await this.run("status", () => this.rpc("ideas.update", { id: i.id, patch: { status } }), () => `Moved to ${IDEA_STATUS_META[status].label}`);
    await this.load(true);
  }

  private async promote(to: IdeaPromoteTarget): Promise<void> {
    const i = this.selected;
    if (!i) return;
    if (this.dirty) await this.save();
    await this.run(
      `promote-${to}`,
      () =>
        this.rpc<{ target: { kind: string; id: string; title: string } }>("ideas.promote", {
          id: i.id,
          to,
          ...(this.promoteProject ? { projectId: this.promoteProject } : {}),
        }),
      (r) => `Promoted to a ${r.target.kind === "document" ? "document" : r.target.kind}: ${r.target.title}`,
    );
    // The promotion created a new project / document: refresh the names the
    // Linked chips show (else they'd show the raw id).
    await Promise.all([this.load(true), this.loadLinkTargets()]);
  }

  private async link(kind: "project" | "doc", targetId: string, unlink = false): Promise<void> {
    const i = this.selected;
    if (!i || !targetId) return;
    await this.run("link", () => this.rpc("ideas.link", { id: i.id, kind, targetId, unlink }), () => (unlink ? "Link removed" : "Linked"));
    await this.load(true);
  }

  private async deleteSelected(): Promise<void> {
    const i = this.selected;
    if (!i) return;
    if (!window.confirm(`Delete the idea “${i.title}”?`)) return;
    await this.run("delete", () => this.rpc("ideas.delete", { id: i.id }), () => "Idea deleted");
    this.selectedId = null;
    await this.load(true);
  }

  // ── render ─────────────────────────────────────────────────────────────────

  render() {
    const sel = this.selected;
    return html`<div class="ideas ${sel ? "has-detail" : ""}" data-testid="documents-ideas">
      <section class="list-pane" aria-label="Ideas">
        ${this.renderAdd()} ${this.renderFilters()} ${this.renderList()}
      </section>
      <section class="detail-pane" aria-label="Idea detail">${sel ? this.renderDetail(sel) : this.renderEmptyDetail()}</section>
      ${this.toast ? html`<div class="toast ${this.toast.error ? "err" : ""}" role="status">${this.toast.text}</div>` : nothing}
    </div>`;
  }

  private renderAdd() {
    return html`<form
      class="add"
      @submit=${(e: Event) => {
        e.preventDefault();
        void this.quickAdd();
      }}
    >
      <span class="bulb">${icons.lightbulb}</span>
      <input
        aria-label="New idea"
        placeholder="Capture an idea…"
        .value=${this.draftTitle}
        @input=${(e: Event) => (this.draftTitle = (e.target as HTMLInputElement).value)}
      />
      <button class="btn gold" type="submit" ?disabled=${!this.draftTitle.trim() || this.busy === "add"} data-testid="ideas-add">
        ${icons.plus}<span>Add</span>
      </button>
    </form>`;
  }

  private renderFilters() {
    const total = IDEA_STATUS_ORDER.reduce((n, s) => n + (this.counts[s] ?? 0), 0);
    return html`<div class="filters">
      <label class="search">
        ${icons.search}
        <input aria-label="Search ideas" placeholder="Search ideas" .value=${this.query} @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)} />
      </label>
      <div class="chips" role="tablist" aria-label="Status">
        <button class="chip ${this.status === "all" ? "on" : ""}" role="tab" aria-selected=${this.status === "all"} @click=${() => (this.status = "all")}>All <b>${total}</b></button>
        ${IDEA_STATUS_ORDER.map(
          (s) =>
            html`<button class="chip st-${s} ${this.status === s ? "on" : ""}" role="tab" aria-selected=${this.status === s} title=${IDEA_STATUS_META[s].hint} @click=${() => (this.status = s)}>
              ${IDEA_STATUS_META[s].label} <b>${this.counts[s] ?? 0}</b>
            </button>`,
        )}
      </div>
      ${this.tags.length
        ? html`<div class="tags" aria-label="Tags">
            ${icons.tag}
            ${this.tags.slice(0, 14).map(
              (t) => html`<button class="tagchip ${this.tag === t.tag ? "on" : ""}" @click=${() => (this.tag = this.tag === t.tag ? null : t.tag)}>#${t.tag}</button>`,
            )}
          </div>`
        : nothing}
    </div>`;
  }

  private renderList() {
    if (this.loading && !this.ideas.length) return html`<div class="state">Loading ideas…</div>`;
    if (this.error) return html`<div class="state err">${this.error}</div>`;
    const rows = filterIdeas(this.ideas, { query: this.query, status: this.status, tag: this.tag });
    if (!rows.length) {
      return html`<div class="state empty">
        <span class="big">${icons.lightbulb}</span>
        ${this.ideas.length
          ? html`<p>No ideas match these filters.</p>`
          : html`<p><b>No ideas yet.</b> Type one above, tap <i>Idea</i> on the phone's InfiniBot face and say it, or ask an agent to capture it.</p>`}
      </div>`;
    }
    return html`<ul class="rows">
      ${rows.map(
        (i) => html`<li>
          <button class="row ${i.id === this.selectedId ? "on" : ""}" @click=${() => this.select(i)} data-idea-id=${i.id}>
            <span class="dot st-${i.status}" aria-hidden="true"></span>
            <span class="row-main">
              <span class="row-title">${i.title}</span>
              ${i.body ? html`<span class="row-ex">${excerpt(i.body)}</span>` : nothing}
              <span class="row-meta">
                <span>${IDEA_STATUS_META[i.status].label}</span>
                <span>${SOURCE_LABEL[i.source] ?? i.source}</span>
                <span>${relTime(i.updatedAt)}</span>
                ${i.tags.slice(0, 3).map((t) => html`<span class="t">#${t}</span>`)}
              </span>
            </span>
          </button>
        </li>`,
      )}
    </ul>`;
  }

  private renderEmptyDetail() {
    return html`<div class="state empty detail-empty">
      <span class="big">${icons.lightbulb}</span>
      <p>Pick an idea to explore it, link it to a project or document, or promote it into real work.</p>
    </div>`;
  }

  private renderDetail(i: Idea) {
    const names = { projects: new Map(this.projects.map((p) => [p.id, p.name])), docs: new Map(this.docs.map((d) => [d.id, d.name])) };
    const promoted = promotedLabel(i, names);
    const linkedProjects = i.projectIds.map((id) => ({ id, name: names.projects.get(id) ?? id }));
    const linkedDocs = i.docIds.map((id) => ({ id, name: names.docs.get(id) ?? id }));
    return html`<article class="detail" data-testid="idea-detail">
      <header class="d-head">
        <button class="btn ghost back" @click=${() => (this.selectedId = null)} aria-label="Back to ideas">${icons.arrowLeft}<span>Ideas</span></button>
        <span class="d-meta">${SOURCE_LABEL[i.source] ?? i.source} · created ${relTime(i.createdAt)}${i.createdBy ? ` by ${i.createdBy}` : ""}</span>
        <button class="btn ghost danger" @click=${() => void this.deleteSelected()} title="Delete idea" aria-label="Delete idea">${icons.trash}</button>
      </header>
      <input
        class="d-title"
        aria-label="Idea title"
        .value=${this.editTitle}
        @input=${(e: Event) => {
          this.editTitle = (e.target as HTMLInputElement).value;
          this.dirty = true;
        }}
      />
      <div class="seg" role="radiogroup" aria-label="Status">
        ${IDEA_STATUS_ORDER.map(
          (s) =>
            html`<button role="radio" aria-checked=${i.status === s} class="st-${s} ${i.status === s ? "on" : ""}" ?disabled=${this.busy === "status" || (s === "promoted" && !i.promotedTo)} @click=${() => void this.setStatus(s)}>
              ${IDEA_STATUS_META[s].label}
            </button>`,
        )}
      </div>
      ${promoted ? html`<div class="promoted">${icons.checkCircle}<span>Promoted → ${promoted}</span></div>` : nothing}
      <ib-people-chips .client=${this.client} objectType="idea" objectId=${i.id}></ib-people-chips>
      <textarea
        class="d-body"
        aria-label="Idea notes"
        placeholder="Flesh it out: why, for whom, first step…"
        .value=${this.editBody}
        @input=${(e: Event) => {
          this.editBody = (e.target as HTMLTextAreaElement).value;
          this.dirty = true;
        }}
      ></textarea>
      <label class="field">
        <span>Tags</span>
        <input
          placeholder="comma or space separated"
          .value=${this.editTags}
          @input=${(e: Event) => {
            this.editTags = (e.target as HTMLInputElement).value;
            this.dirty = true;
          }}
        />
      </label>
      <div class="save-row">
        <button class="btn gold" ?disabled=${!this.dirty || this.busy === "save"} @click=${() => void this.save()} data-testid="idea-save">${icons.save}<span>${this.dirty ? "Save changes" : "Saved"}</span></button>
      </div>

      <section class="block">
        <h4>${icons.link} Linked</h4>
        <div class="links">
          ${linkedProjects.map((p) => html`<span class="lk">${icons.folder}${p.name}<button aria-label="Unlink project" @click=${() => void this.link("project", p.id, true)}>${icons.x}</button></span>`)}
          ${i.taskIds.map((t) => html`<span class="lk">${icons.kanban}Task ${t}</span>`)}
          ${linkedDocs.map((d) => html`<span class="lk">${icons.fileText}${d.name}<button aria-label="Unlink document" @click=${() => void this.link("doc", d.id, true)}>${icons.x}</button></span>`)}
          ${!linkedProjects.length && !i.taskIds.length && !linkedDocs.length ? html`<span class="muted">Nothing linked yet.</span>` : nothing}
        </div>
        <div class="link-pickers">
          <select aria-label="Link a project" @change=${(e: Event) => {
            const sel = e.target as HTMLSelectElement;
            void this.link("project", sel.value);
            sel.value = "";
          }}>
            <option value="">Link a project…</option>
            ${this.projects.filter((p) => !i.projectIds.includes(p.id)).map((p) => html`<option value=${p.id}>${projectOptionLabel(p.name, p.id)}</option>`)}
          </select>
          <select aria-label="Link a document" @change=${(e: Event) => {
            const sel = e.target as HTMLSelectElement;
            void this.link("doc", sel.value);
            sel.value = "";
          }}>
            <option value="">Link a document…</option>
            ${this.docs.filter((d) => !i.docIds.includes(d.id)).map((d) => html`<option value=${d.id}>${d.name}</option>`)}
          </select>
        </div>
      </section>

      <section class="block">
        <h4>${icons.rocket} Promote</h4>
        <p class="muted small">Turn it into real work. The idea stays here, marked promoted and linked to what it became.</p>
        <label class="field inline">
          <span>Project for a task</span>
          <select aria-label="Project for the promoted task" .value=${this.promoteProject} @change=${(e: Event) => (this.promoteProject = (e.target as HTMLSelectElement).value)}>
            <option value="">No project</option>
            ${this.projects.map((p) => html`<option value=${p.id} ?selected=${p.id === this.promoteProject}>${projectOptionLabel(p.name, p.id)}</option>`)}
          </select>
        </label>
        <div class="promote">
          <button class="btn" data-testid="promote-task" ?disabled=${!!this.busy} @click=${() => void this.promote("task")}>${icons.kanban}<span>Task</span></button>
          <button class="btn" data-testid="promote-project" ?disabled=${!!this.busy} @click=${() => void this.promote("project")}>${icons.folder}<span>Project</span></button>
          <button class="btn" data-testid="promote-document" ?disabled=${!!this.busy} @click=${() => void this.promote("document")}>${icons.fileText}<span>Document</span></button>
        </div>
      </section>
    </article>`;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      color: var(--glass-fg, #f4f1ea);
      font-family: var(--glass-font, var(--g-font, Inter, system-ui, sans-serif));
      --gold: var(--glass-gold, #d9b45f);
      --gold-hi: var(--glass-gold-hi, #f1d38a);
      --line: var(--glass-stroke, rgba(217, 180, 95, 0.14));
      --line-strong: var(--glass-stroke-strong, rgba(217, 180, 95, 0.24));
      --panel: var(--glass-hover, rgba(255, 255, 255, 0.04));
      --press: var(--glass-press, rgba(255, 255, 255, 0.07));
      --dim: var(--glass-fg-2, #c9c3b6);
      --muted: var(--glass-fg-3, #8f897c);
      --inset: color-mix(in srgb, var(--glass-base, #07070a) 55%, transparent);
      --r: var(--glass-radius, 14px);
      --r-sm: var(--glass-radius-sm, 10px);
      --ease: var(--glass-ease, cubic-bezier(0.22, 1, 0.36, 1));
      --st-new: #f1d38a;
      --st-exploring: #8fb8ff;
      --st-parked: #9a9488;
      --st-promoted: #3fb27f;
    }
    * {
      box-sizing: border-box;
    }
    button,
    input,
    textarea,
    select {
      font: inherit;
      color: inherit;
    }
    :is(button, input, textarea, select):focus-visible {
      outline: none;
      box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--gold));
    }
    svg {
      flex: none;
    }
    .ideas {
      position: relative;
      display: grid;
      grid-template-columns: minmax(280px, 400px) minmax(0, 1fr);
      gap: 14px;
      height: 100%;
      min-height: 0;
    }
    .list-pane,
    .detail-pane {
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: var(--glass-surface-1, rgba(18, 16, 12, 0.55));
      border: 1px solid var(--line);
      border-radius: var(--r);
      backdrop-filter: var(--glass-blur, blur(18px) saturate(1.2));
      overflow: hidden;
    }
    .add {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--line);
    }
    .bulb {
      color: var(--gold);
      display: inline-flex;
    }
    .add input,
    .search input,
    .field input,
    select {
      background: var(--inset);
      border: 1px solid var(--line);
      border-radius: var(--r-sm);
      padding: 9px 11px;
      min-height: 40px;
      min-width: 0;
    }
    .add input {
      flex: 1;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 40px;
      padding: 0 14px;
      border-radius: var(--r-sm);
      border: 1px solid var(--line-strong);
      background: var(--panel);
      cursor: pointer;
      transition: background 0.18s var(--ease), border-color 0.18s var(--ease), transform 0.18s var(--ease);
    }
    .btn:hover:not(:disabled) {
      background: var(--press);
      border-color: var(--gold);
    }
    .btn:active:not(:disabled) {
      transform: translateY(1px);
    }
    .btn:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .btn.gold {
      background: linear-gradient(180deg, var(--gold-hi), var(--gold));
      color: #1a1408;
      border-color: transparent;
      font-weight: 600;
    }
    .btn.ghost {
      background: transparent;
      border-color: transparent;
    }
    .btn.danger:hover {
      color: #e5675c;
    }
    .filters {
      padding: 10px 12px;
      display: grid;
      gap: 10px;
      border-bottom: 1px solid var(--line);
    }
    .search {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
    }
    .search input {
      flex: 1;
      color: var(--glass-fg, #f4f1ea);
    }
    .chips,
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .tags {
      color: var(--muted);
    }
    .chip,
    .tagchip {
      border: 1px solid var(--line);
      background: transparent;
      border-radius: 999px;
      padding: 5px 11px;
      min-height: 32px;
      font-size: 12.5px;
      color: var(--dim);
      cursor: pointer;
    }
    .chip b {
      font-weight: 600;
      color: var(--muted);
      margin-left: 3px;
    }
    .chip.on,
    .tagchip.on {
      border-color: var(--gold);
      color: var(--gold-hi);
      background: color-mix(in srgb, var(--gold) 12%, transparent);
    }
    .rows {
      list-style: none;
      margin: 0;
      padding: 6px;
      overflow: auto;
      flex: 1;
    }
    .row {
      display: flex;
      gap: 10px;
      width: 100%;
      text-align: left;
      padding: 11px 10px;
      border: 1px solid transparent;
      border-radius: var(--r-sm);
      background: transparent;
      cursor: pointer;
    }
    .row:hover {
      background: var(--panel);
    }
    .row.on {
      background: var(--press);
      border-color: var(--line-strong);
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      margin-top: 6px;
      flex: none;
      background: var(--st-new);
      box-shadow: 0 0 10px color-mix(in srgb, currentColor 40%, transparent);
    }
    .dot.st-exploring {
      background: var(--st-exploring);
    }
    .dot.st-parked {
      background: var(--st-parked);
    }
    .dot.st-promoted {
      background: var(--st-promoted);
    }
    .row-main {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .row-title {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-ex {
      color: var(--dim);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 11.5px;
      color: var(--muted);
    }
    .row-meta .t {
      color: var(--gold);
    }
    .state {
      padding: 28px 18px;
      color: var(--muted);
      text-align: center;
    }
    .state.err {
      color: #e5675c;
    }
    .state .big {
      display: inline-flex;
      color: var(--gold);
      transform: scale(1.8);
      margin-bottom: 14px;
    }
    .detail-empty {
      margin: auto;
      max-width: 360px;
    }
    .detail {
      display: grid;
      gap: 12px;
      padding: 14px 18px 22px;
      overflow: auto;
    }
    .d-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .d-head .back {
      display: none;
    }
    .d-meta {
      flex: 1;
      font-size: 12px;
      color: var(--muted);
    }
    .d-title {
      font-size: 22px;
      font-weight: 650;
      letter-spacing: -0.01em;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--r-sm);
      padding: 6px 8px;
      margin: 0 -8px;
    }
    .d-title:hover,
    .d-title:focus {
      border-color: var(--line);
      background: var(--inset);
    }
    .seg {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 999px;
      width: fit-content;
      max-width: 100%;
    }
    .seg button {
      border: 0;
      background: transparent;
      border-radius: 999px;
      padding: 6px 13px;
      min-height: 34px;
      cursor: pointer;
      color: var(--dim);
    }
    .seg button.on {
      background: color-mix(in srgb, var(--gold) 16%, transparent);
      color: var(--gold-hi);
    }
    .seg button.st-exploring.on {
      background: color-mix(in srgb, var(--st-exploring) 18%, transparent);
      color: var(--st-exploring);
    }
    .seg button.st-parked.on {
      background: color-mix(in srgb, var(--st-parked) 22%, transparent);
      color: #d6d0c4;
    }
    .seg button.st-promoted.on {
      background: color-mix(in srgb, var(--st-promoted) 18%, transparent);
      color: #6fd6a6;
    }
    .seg button:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .promoted {
      display: flex;
      gap: 8px;
      align-items: center;
      color: #6fd6a6;
      font-size: 13px;
    }
    .d-body {
      min-height: 160px;
      resize: vertical;
      background: var(--inset);
      border: 1px solid var(--line);
      border-radius: var(--r-sm);
      padding: 12px;
      line-height: 1.55;
    }
    .field {
      display: grid;
      gap: 6px;
      font-size: 12.5px;
      color: var(--muted);
    }
    .field.inline {
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 10px;
    }
    .field input {
      color: var(--glass-fg, #f4f1ea);
    }
    .save-row {
      display: flex;
      justify-content: flex-end;
    }
    .block {
      border-top: 1px solid var(--line);
      padding-top: 12px;
      display: grid;
      gap: 10px;
    }
    .block h4 {
      margin: 0;
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--gold);
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .lk {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      padding: 4px 6px 4px 10px;
      font-size: 12.5px;
    }
    .lk button {
      border: 0;
      background: transparent;
      cursor: pointer;
      color: var(--muted);
      display: inline-flex;
      padding: 2px;
    }
    .link-pickers,
    .promote {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .link-pickers select {
      flex: 1 1 180px;
    }
    .muted {
      color: var(--muted);
    }
    .small {
      font-size: 12.5px;
      margin: 0;
    }
    select {
      color: var(--glass-fg, #f4f1ea);
    }
    select option {
      background: #14110c;
    }
    .toast {
      position: absolute;
      left: 50%;
      bottom: 16px;
      transform: translateX(-50%);
      padding: 10px 16px;
      border-radius: 999px;
      background: rgba(20, 17, 10, 0.92);
      border: 1px solid var(--gold);
      color: var(--gold-hi);
      font-size: 13px;
      z-index: 5;
      max-width: calc(100% - 32px);
    }
    .toast.err {
      border-color: #e5675c;
      color: #f2a39b;
    }
    @media (max-width: 860px) {
      .ideas {
        grid-template-columns: minmax(0, 1fr);
      }
      .ideas.has-detail .list-pane,
      .ideas:not(.has-detail) .detail-pane {
        display: none;
      }
      .d-head .back {
        display: inline-flex;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .btn {
        transition: none;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-documents-ideas": DocumentsIdeas;
  }
}
