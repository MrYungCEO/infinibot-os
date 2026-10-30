/**
 * <ib-secure-docs> — Secure Mode documents (secure.docs.*): list, create,
 * edit title + markdown with an explicit Save, delete. Content is fetched
 * per document on open and dropped from memory when the lane locks.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { icons } from "../icons";
import { friendlySecureError, isSecureLockedError, SecureModeController, secureActive, secureRequest } from "./store";
import { secureBaseStyles } from "./styles";

export type SecureDocMeta = { id: string; title: string; createdAt: number; updatedAt: number; size: number };
export type SecureDoc = SecureDocMeta & { content: string };

function fmtTime(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

@customElement("ib-secure-docs")
export class SecureDocs extends LitElement {
  @state() private docs: SecureDocMeta[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private openId: string | null = null;
  @state() private doc: SecureDoc | null = null;
  @state() private draftTitle = "";
  @state() private content = "";
  @state() private saving = false;
  @state() private savedAt = 0;
  @state() private filter = "";

  private seq = 0;
  private wasActive = false;

  private secure = new SecureModeController(this, {
    kinds: ["docs"],
    onLane: () => void this.loadList(),
    onChange: (s) => {
      const active = secureActive(s);
      if (active && !this.wasActive) void this.loadList();
      if (!active) this.clear();
      this.wasActive = active;
    },
  });

  connectedCallback(): void {
    super.connectedCallback();
    this.wasActive = this.secure.active;
    if (this.wasActive) void this.loadList();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clear();
  }

  private clear() {
    this.seq++;
    this.docs = [];
    this.doc = null;
    this.openId = null;
    this.draftTitle = "";
    this.content = "";
  }

  private get dirty(): boolean {
    return Boolean(this.doc && (this.draftTitle !== this.doc.title || this.content !== this.doc.content));
  }

  private async loadList() {
    if (!this.secure.active) return;
    const seq = ++this.seq;
    this.loading = true;
    try {
      const res = await secureRequest<{ docs?: SecureDocMeta[] }>("secure.docs.list");
      if (seq !== this.seq) return;
      this.docs = (Array.isArray(res?.docs) ? res.docs : []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
      this.error = null;
      if (this.openId && !this.docs.some((d) => d.id === this.openId)) {
        this.openId = null;
        this.doc = null;
      }
    } catch (err) {
      if (seq !== this.seq) return;
      if (isSecureLockedError(err)) this.clear();
      this.error = friendlySecureError(err);
    } finally {
      if (seq === this.seq) this.loading = false;
    }
  }

  private async open(id: string) {
    if (this.dirty && !window.confirm("Discard unsaved changes?")) return;
    this.openId = id;
    this.doc = null;
    try {
      const res = await secureRequest<{ doc?: SecureDoc }>("secure.docs.get", { id });
      if (this.openId !== id || !res?.doc) return;
      this.doc = { ...res.doc, content: res.doc.content ?? "" };
      this.draftTitle = this.doc.title;
      this.content = this.doc.content;
      this.savedAt = 0;
      this.error = null;
    } catch (err) {
      this.error = friendlySecureError(err);
    }
  }

  private async create() {
    if (this.dirty && !window.confirm("Discard unsaved changes?")) return;
    try {
      const res = await secureRequest<{ doc?: SecureDocMeta }>("secure.docs.create", { title: "Untitled secure doc", content: "" });
      await this.loadList();
      if (res?.doc?.id) await this.open(res.doc.id);
    } catch (err) {
      this.error = friendlySecureError(err);
    }
  }

  private async save() {
    if (!this.doc || this.saving) return;
    this.saving = true;
    const id = this.doc.id;
    const title = this.draftTitle.trim() || "Untitled secure doc";
    try {
      await secureRequest("secure.docs.update", { id, title, content: this.content });
      if (this.doc?.id === id) {
        this.doc = { ...this.doc, title, content: this.content, updatedAt: Date.now() };
        this.draftTitle = title;
      }
      this.savedAt = Date.now();
      this.error = null;
      void this.loadList();
    } catch (err) {
      this.error = friendlySecureError(err);
    } finally {
      this.saving = false;
    }
  }

  private async removeDoc() {
    if (!this.doc) return;
    if (!window.confirm(`Delete "${this.doc.title}" from Secure Mode? This cannot be undone.`)) return;
    const id = this.doc.id;
    try {
      await secureRequest("secure.docs.delete", { id });
      this.doc = null;
      this.openId = null;
      await this.loadList();
    } catch (err) {
      this.error = friendlySecureError(err);
    }
  }

  private onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void this.save();
    }
  }

  render() {
    if (!this.secure.active) {
      return html`<div class="sdc-locked">
        <span class="sdc-locked-ico">${icons.lock}</span>
        <strong>Secure documents locked</strong>
        <span class="sm-muted">Turn on Secure Mode to open your encrypted documents.</span>
        <ib-secure-toggle></ib-secure-toggle>
      </div>`;
    }
    const q = this.filter.trim().toLowerCase();
    const list = q ? this.docs.filter((d) => d.title.toLowerCase().includes(q)) : this.docs;
    return html`
      <div class="sdc">
        <aside class="sdc-side" aria-label="Secure documents">
          <div class="sdc-side-head">
            <span class="sm-chip">${icons.lock} Secure docs</span>
            <button class="sm-btn sm-btn--primary" type="button" data-secure-new-doc @click=${() => void this.create()}>${icons.plus}<span>New</span></button>
          </div>
          <input class="sm-input" type="search" placeholder="Filter" aria-label="Filter secure documents" .value=${this.filter} @input=${(e: Event) => (this.filter = (e.target as HTMLInputElement).value)} />
          <div class="sdc-list" role="listbox" aria-busy=${this.loading ? "true" : "false"}>
            ${list.map(
              (d) => html`<button
                type="button"
                role="option"
                class="sdc-row ${d.id === this.openId ? "sdc-row--on" : ""}"
                aria-selected=${d.id === this.openId ? "true" : "false"}
                @click=${() => void this.open(d.id)}
              >
                <span class="sdc-row-title">${d.title || "Untitled"}</span>
                <span class="sdc-row-sub">${fmtTime(d.updatedAt)}</span>
              </button>`,
            )}
            ${list.length === 0
              ? html`<div class="sdc-empty">${this.loading ? "Loading…" : this.docs.length ? "No matches" : "No secure documents yet"}</div>`
              : nothing}
          </div>
        </aside>
        <section class="sdc-main">
          ${this.error ? html`<div class="sm-error sdc-err" role="alert">${this.error}</div>` : nothing}
          ${this.doc
            ? html`<div class="sdc-edit" @keydown=${(e: KeyboardEvent) => this.onKey(e)}>
                <div class="sdc-edit-head">
                  <input class="sm-input sdc-title" aria-label="Document title" .value=${this.draftTitle} @input=${(e: Event) => (this.draftTitle = (e.target as HTMLInputElement).value)} />
                  <span class="sm-muted sdc-state">${this.saving ? "Saving…" : this.dirty ? "Unsaved changes" : this.savedAt ? "Saved" : ""}</span>
                  <button class="sm-btn sm-btn--primary" type="button" data-secure-save-doc ?disabled=${!this.dirty || this.saving} @click=${() => void this.save()}>${icons.save}<span>Save</span></button>
                  <button class="sm-btn sm-btn--danger sm-btn--icon" type="button" title="Delete document" aria-label="Delete document" @click=${() => void this.removeDoc()}>${icons.trash}</button>
                </div>
                <textarea
                  class="sm-input sdc-body"
                  aria-label="Document content (markdown)"
                  placeholder="Write in markdown. Saved encrypted on this machine only."
                  .value=${this.content}
                  @input=${(e: Event) => (this.content = (e.target as HTMLTextAreaElement).value)}
                ></textarea>
              </div>`
            : html`<div class="sdc-blank">
                <span class="sdc-locked-ico">${icons.fileText}</span>
                <span class="sm-muted">${this.openId ? "Opening…" : "Pick a document or create a new one."}</span>
              </div>`}
        </section>
      </div>
    `;
  }

  static styles = [
    secureBaseStyles,
    css`
      :host { display: block; height: 100%; min-height: 0; }
      .sdc {
        display: grid; grid-template-columns: minmax(220px, 280px) minmax(0, 1fr); gap: 12px; height: 100%; min-height: 420px;
        padding: 12px; border-radius: var(--sm-radius); border: 1px solid var(--sm-ring);
        background: linear-gradient(180deg, var(--sm-soft), transparent 160px), var(--sm-surface);
      }
      .sdc-side { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
      .sdc-side-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .sdc-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
      .sdc-row {
        display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; border-radius: 10px;
        border: 1px solid transparent; background: none; cursor: pointer; text-align: left;
      }
      .sdc-row:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
      .sdc-row--on { border-color: var(--sm-ring); background: var(--sm-soft); }
      .sdc-row:focus-visible { outline: 2px solid var(--sm-accent); outline-offset: 1px; }
      .sdc-row-title { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
      .sdc-row-sub { font-size: 11px; color: var(--sm-muted); }
      .sdc-empty { padding: 16px 8px; font-size: 12.5px; color: var(--sm-muted); text-align: center; }
      .sdc-main { display: flex; flex-direction: column; gap: 8px; min-height: 0; min-width: 0; }
      .sdc-err { padding: 6px 10px; border-radius: 8px; background: rgba(248, 113, 113, 0.1); }
      .sdc-edit { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; }
      .sdc-edit-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .sdc-title { flex: 1 1 240px; font-size: 15px; font-weight: 650; min-height: 36px; }
      .sdc-state { min-width: 100px; text-align: right; }
      .sdc-body { flex: 1; min-height: 280px; }
      .sdc-blank, .sdc-locked { display: grid; place-items: center; align-content: center; gap: 8px; flex: 1; min-height: 240px; text-align: center; }
      .sdc-locked { padding: 24px; border: 1px dashed var(--sm-ring); border-radius: var(--sm-radius); }
      .sdc-locked-ico { color: var(--sm-accent); }
      .sdc-locked-ico svg { width: 22px; height: 22px; }
      @media (max-width: 760px) {
        .sdc { grid-template-columns: 1fr; }
        .sdc-list { max-height: 220px; }
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-secure-docs": SecureDocs;
  }
}
