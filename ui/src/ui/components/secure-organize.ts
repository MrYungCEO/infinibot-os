/**
 * Secure Files organise controls.
 *
 *  <ib-tag-input>       chips + input with autocomplete from existing secure tags
 *  <ib-secure-organize> name / collection / tags / project / notes editor, used
 *                       in the per-file dialog and the viewer's side panel
 *
 * Both are presentational: they emit events and the Secure Files view makes
 * the files.secure.* calls, so nothing here touches the normal lane.
 *
 * Events (bubbling, composed):
 *   tags-change      { tags }                 <ib-tag-input>
 *   organize-save    { id, patch }            <ib-secure-organize>
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { icons } from "../icons";
import { type CollectionNode, cleanTag, displayName, tagSuggestions } from "../files-organize";

export interface SecureOrganizeValue {
  id: string;
  name: string;
  label?: string;
  collectionId?: string | null;
  tags?: string[];
  projectId?: string | null;
  notes?: string;
}

export interface SecureOrganizePatch {
  name?: string | null;
  collectionId?: string | null;
  tags?: string[];
  projectId?: string | null;
  notes?: string | null;
}

export type OrganizeField = "name" | "collection" | "tags" | "project" | "notes";

@customElement("ib-tag-input")
export class TagInput extends LitElement {
  static styles = css`
    :host { display: block; position: relative; --ti-gold: var(--wg-gold, #d9b45a); --ti-stroke: var(--glass-stroke, rgba(255,255,255,0.1)); }
    svg { width: 11px; height: 11px; flex: none; }
    .box { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-height: 36px; box-sizing: border-box; padding: 4px 6px; border-radius: 10px; border: 1px solid var(--ti-stroke); background: rgba(0,0,0,0.25); cursor: text; }
    .box:focus-within { border-color: color-mix(in srgb, var(--ti-gold) 55%, transparent); }
    .chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 4px 0 9px; border-radius: 999px; font-size: 12px; color: var(--wg-gold-hi, #ecd28a); background: color-mix(in srgb, var(--ti-gold) 13%, transparent); border: 1px solid color-mix(in srgb, var(--ti-gold) 40%, transparent); }
    .chip button { all: unset; cursor: pointer; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; color: inherit; opacity: 0.75; }
    .chip button:hover, .chip button:focus-visible { opacity: 1; background: rgba(255,255,255,0.1); }
    input { all: unset; flex: 1; min-width: 90px; height: 26px; font-size: 12.5px; color: var(--wg-fg, #eee); }
    .sugg { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 5; padding: 4px; border-radius: 10px; border: 1px solid var(--ti-stroke); background: color-mix(in srgb, var(--glass-base, #121419) 98%, transparent); box-shadow: 0 14px 40px rgba(0,0,0,0.5); max-height: 220px; overflow: auto; }
    .sugg button { all: unset; cursor: pointer; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 7px; padding: 7px 9px; border-radius: 7px; font-size: 12.5px; color: var(--wg-fg-2, #ccc); }
    .sugg button[aria-selected="true"], .sugg button:hover { background: color-mix(in srgb, var(--ti-gold) 12%, transparent); color: #fff; }
    .sugg svg { color: var(--ti-gold); }
    .sugg .new { color: var(--wg-fg-3, #999); }
    :host([inline]) .sugg { position: static; margin-top: 6px; box-shadow: none; }
  `;

  @property({ attribute: false }) tags: string[] = [];
  @property({ attribute: false }) suggestions: string[] = [];
  @property() placeholder = "Add a tag…";
  /** Suggestions in the flow instead of a floating list (dialogs / sheets). */
  @property({ type: Boolean, reflect: true }) inline = false;
  @state() private text = "";
  @state() private open = false;
  @state() private active = 0;
  @query("input") private input!: HTMLInputElement;

  focus() {
    this.input?.focus();
  }

  /** Commit whatever is typed (dialogs call this before saving). */
  commitPending(): string[] {
    if (this.text.trim()) this.add(this.text);
    return this.tags;
  }

  private emit() {
    this.dispatchEvent(new CustomEvent("tags-change", { detail: { tags: this.tags }, bubbles: true, composed: true }));
  }

  private add(raw: string) {
    const t = cleanTag(raw);
    this.text = "";
    if (!t || this.tags.some((x) => x.toLowerCase() === t.toLowerCase()) || this.tags.length >= 24) return;
    this.tags = [...this.tags, t];
    this.active = 0;
    this.emit();
  }

  private removeTag(t: string) {
    this.tags = this.tags.filter((x) => x !== t);
    this.emit();
  }

  private onKey(e: KeyboardEvent, list: string[]) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.open = true;
      const n = list.length || 1;
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    } else if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      const pick = this.open && list[this.active] ? list[this.active] : this.text;
      if (!pick.trim()) return;
      e.preventDefault();
      this.add(pick);
    } else if (e.key === "Backspace" && !this.text && this.tags.length) {
      this.removeTag(this.tags[this.tags.length - 1]);
    } else if (e.key === "Escape" && this.open) {
      e.stopPropagation();
      this.open = false;
    }
  }

  render() {
    const list = tagSuggestions(this.suggestions, this.text, this.tags, 8);
    const typed = cleanTag(this.text);
    const showNew = typed && !list.some((t) => t.toLowerCase() === typed.toLowerCase()) && !this.tags.some((t) => t.toLowerCase() === typed.toLowerCase());
    return html`<div class="box" @click=${() => this.input.focus()}>
        ${this.tags.map(
          (t) => html`<span class="chip" data-testid="tag-chip">${t}<button aria-label="Remove tag ${t}" @click=${(e: Event) => (e.stopPropagation(), this.removeTag(t))}>${icons.x}</button></span>`,
        )}
        <input
          aria-label="Tags"
          role="combobox"
          aria-expanded=${String(this.open && (list.length > 0 || Boolean(showNew)))}
          aria-autocomplete="list"
          placeholder=${this.tags.length ? "" : this.placeholder}
          .value=${this.text}
          @input=${(e: Event) => {
            this.text = (e.target as HTMLInputElement).value;
            this.open = true;
            this.active = 0;
          }}
          @focus=${() => (this.open = true)}
          @blur=${() => setTimeout(() => (this.open = false), 150)}
          @keydown=${(e: KeyboardEvent) => this.onKey(e, list)}
        />
      </div>
      ${this.open && (list.length || showNew)
        ? html`<div class="sugg" role="listbox" data-testid="tag-suggestions">
            ${list.map(
              (t, i) => html`<button role="option" aria-selected=${String(i === this.active)} @mousedown=${(e: Event) => e.preventDefault()} @click=${() => this.add(t)}>${icons.tag}${t}</button>`,
            )}
            ${showNew ? html`<button class="new" role="option" aria-selected="false" @mousedown=${(e: Event) => e.preventDefault()} @click=${() => this.add(typed)}>${icons.plus}Create “${typed}”</button>` : nothing}
          </div>`
        : nothing}`;
  }
}

@customElement("ib-secure-organize")
export class SecureOrganize extends LitElement {
  static styles = css`
    :host { display: block; color: var(--wg-fg, #ece8df); --so-gold: var(--wg-gold, #d9b45a); --so-stroke: var(--glass-stroke, rgba(255,255,255,0.1)); }
    svg { width: 14px; height: 14px; flex: none; }
    form { display: grid; gap: 12px; }
    label, .lbl { display: grid; gap: 6px; font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--wg-fg-3, #9a968c); }
    .lbl > span, label > span { display: inline-flex; align-items: center; gap: 6px; }
    .lbl svg, label svg { color: var(--so-gold); width: 12px; height: 12px; }
    input, select, textarea { all: unset; box-sizing: border-box; width: 100%; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--so-stroke); background: rgba(0,0,0,0.25); font-size: 13px; letter-spacing: 0; text-transform: none; color: var(--wg-fg, #eee); }
    select { cursor: pointer; background: linear-gradient(45deg, transparent 50%, #9a968c 50%) calc(100% - 14px) 15px / 5px 5px no-repeat, linear-gradient(135deg, #9a968c 50%, transparent 50%) calc(100% - 10px) 15px / 5px 5px no-repeat, rgba(0,0,0,0.25); padding-right: 26px; }
    select option { background: #16181d; color: #eee; }
    textarea { min-height: 76px; resize: vertical; line-height: 1.45; white-space: pre-wrap; }
    input:focus, select:focus, textarea:focus { border-color: color-mix(in srgb, var(--so-gold) 55%, transparent); }
    ib-tag-input { text-transform: none; letter-spacing: 0; }
    .row { display: flex; align-items: center; gap: 8px; }
    .sp { flex: 1; }
    .btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 10px; font-size: 12.5px; border: 1px solid var(--so-stroke); background: rgba(255,255,255,0.05); color: var(--wg-fg-2, #ccc); }
    .btn.primary { color: #1a1406; border-color: transparent; background: linear-gradient(180deg, var(--wg-gold-hi, #ecd28a), var(--so-gold)); font-weight: 600; }
    .btn[disabled] { opacity: 0.5; pointer-events: none; }
    .btn:focus-visible { outline: 2px solid var(--so-gold); outline-offset: 1px; }
    .ok { font-size: 12px; color: #9ce3b5; display: inline-flex; align-items: center; gap: 5px; }
    .err { font-size: 12px; color: #ff9a8a; }
    .head { display: flex; align-items: center; gap: 8px; margin: 0 0 2px; font-size: 12px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: var(--so-gold); }
    .head .lockb { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 10.5px; letter-spacing: 0.02em; text-transform: none; border: 1px solid color-mix(in srgb, var(--so-gold) 40%, transparent); }
    .head .lockb svg { width: 11px; height: 11px; }
    :host([compact]) form { gap: 10px; }
    :host([compact]) .card { padding: 14px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--so-gold) 22%, var(--so-stroke)); background: color-mix(in srgb, var(--so-gold) 4%, rgba(255,255,255,0.02)); margin-bottom: 16px; }
  `;

  @property({ attribute: false }) value: SecureOrganizeValue | null = null;
  @property({ attribute: false }) collections: CollectionNode[] = [];
  @property({ attribute: false }) allTags: string[] = [];
  @property({ attribute: false }) projects: Array<{ id: string; name: string }> = [];
  /** Which fields to show (dialog for one action) — all when empty. */
  @property({ attribute: false }) fields: OrganizeField[] = [];
  @property() focusField: OrganizeField | "" = "";
  @property({ type: Boolean, reflect: true }) compact = false;
  /** Set by the host after the save RPC resolves. */
  @property({ attribute: false }) saveState: "idle" | "saving" | "saved" | { error: string } = "idle";

  @state() private draft: Required<Omit<SecureOrganizeValue, "id" | "name" | "label">> & { label: string } = { label: "", collectionId: null, tags: [], projectId: null, notes: "" };
  @state() private dirty = false;
  @query("ib-tag-input") private tagInput?: TagInput;

  protected willUpdate(c: PropertyValues<this>): void {
    if (c.has("value") && this.value) {
      const prev = c.get("value") as SecureOrganizeValue | null | undefined;
      if (!prev || prev.id !== this.value.id || !this.dirty) {
        this.draft = {
          label: this.value.label ?? "",
          collectionId: this.value.collectionId ?? null,
          tags: [...(this.value.tags ?? [])],
          projectId: this.value.projectId ?? null,
          notes: this.value.notes ?? "",
        };
        this.dirty = false;
      }
    }
    if (c.has("saveState") && this.saveState === "saved") this.dirty = false;
  }

  protected firstUpdated(): void {
    if (!this.focusField) return;
    requestAnimationFrame(() => {
      const el =
        this.focusField === "tags"
          ? this.tagInput
          : (this.renderRoot.querySelector(`[name="${this.focusField}"]`) as HTMLElement | null);
      el?.focus();
    });
  }

  private show(f: OrganizeField) {
    return !this.fields.length || this.fields.includes(f);
  }

  private set<K extends keyof SecureOrganize["draft"]>(k: K, v: SecureOrganize["draft"][K]) {
    this.draft = { ...this.draft, [k]: v };
    this.dirty = true;
    if (this.saveState !== "saving") this.saveState = "idle";
  }

  /** Only the fields that changed, in RPC shape. */
  private patch(): SecureOrganizePatch {
    const v = this.value!;
    const p: SecureOrganizePatch = {};
    const tags = this.tagInput?.commitPending() ?? this.draft.tags;
    if (this.show("name") && this.draft.label.trim() !== (v.label ?? "").trim()) p.name = this.draft.label.trim() || null;
    if (this.show("collection") && (this.draft.collectionId ?? null) !== (v.collectionId ?? null)) p.collectionId = this.draft.collectionId;
    if (this.show("tags") && JSON.stringify(tags) !== JSON.stringify(v.tags ?? [])) p.tags = tags;
    if (this.show("project") && (this.draft.projectId ?? null) !== (v.projectId ?? null)) p.projectId = this.draft.projectId;
    if (this.show("notes") && this.draft.notes.trim() !== (v.notes ?? "").trim()) p.notes = this.draft.notes.trim() || null;
    return p;
  }

  private submit(e: Event) {
    e.preventDefault();
    if (!this.value) return;
    const patch = this.patch();
    if (!Object.keys(patch).length) {
      this.dispatchEvent(new CustomEvent("organize-cancel", { bubbles: true, composed: true }));
      return;
    }
    this.saveState = "saving";
    this.dispatchEvent(new CustomEvent("organize-save", { detail: { id: this.value.id, patch }, bubbles: true, composed: true }));
  }

  render() {
    const v = this.value;
    if (!v) return nothing;
    const d = this.draft;
    const st = this.saveState;
    const knownProject = !d.projectId || this.projects.some((p) => p.id === d.projectId);
    const body = html`<form @submit=${this.submit} data-testid="secure-organize">
      ${this.compact ? html`<div class="head">${icons.folder}Organize<span class="lockb">${icons.lock}Encrypted</span></div>` : nothing}
      ${this.show("name")
        ? html`<label><span>${icons.edit}Name</span><input name="name" data-testid="so-name" placeholder=${displayName(v.name)} .value=${d.label} maxlength="120" @input=${(e: Event) => this.set("label", (e.target as HTMLInputElement).value)} /></label>`
        : nothing}
      ${this.show("collection")
        ? html`<label><span>${icons.folder}Collection</span><select name="collection" data-testid="so-collection" @change=${(e: Event) => this.set("collectionId", (e.target as HTMLSelectElement).value || null)}>
            <option value="" ?selected=${!d.collectionId}>Unfiled (root)</option>
            ${this.collections.map((c) => html`<option value=${c.id} ?selected=${d.collectionId === c.id}>${" ".repeat(c.depth)}${c.name}</option>`)}
          </select></label>`
        : nothing}
      ${this.show("tags")
        ? html`<div class="lbl"><span>${icons.tag}Tags</span><ib-tag-input data-testid="so-tags" ?inline=${!this.compact} .tags=${d.tags} .suggestions=${this.allTags} @tags-change=${(e: CustomEvent<{ tags: string[] }>) => this.set("tags", e.detail.tags)}></ib-tag-input></div>`
        : nothing}
      ${this.show("project")
        ? html`<label><span>${icons.briefcase}Project</span><select name="project" data-testid="so-project" @change=${(e: Event) => this.set("projectId", (e.target as HTMLSelectElement).value || null)}>
            <option value="" ?selected=${!d.projectId}>No project</option>
            ${this.projects.map((p) => html`<option value=${p.id} ?selected=${d.projectId === p.id}>${p.name}</option>`)}
            ${knownProject ? nothing : html`<option value=${d.projectId!} selected>Project ${d.projectId!.slice(0, 8)}</option>`}
          </select></label>`
        : nothing}
      ${this.show("notes")
        ? html`<label><span>${icons.penLine}Notes</span><textarea name="notes" data-testid="so-notes" maxlength="4000" placeholder="Private notes, sealed with the file" .value=${d.notes} @input=${(e: Event) => this.set("notes", (e.target as HTMLTextAreaElement).value)}></textarea></label>`
        : nothing}
      <div class="row">
        ${typeof st === "object" ? html`<span class="err" role="alert">${st.error}</span>` : st === "saved" && !this.dirty ? html`<span class="ok">${icons.checkCircle}Saved</span>` : nothing}
        <span class="sp"></span>
        ${this.compact ? nothing : html`<button type="button" class="btn" @click=${() => this.dispatchEvent(new CustomEvent("organize-cancel", { bubbles: true, composed: true }))}>Cancel</button>`}
        <button type="submit" class="btn primary" data-testid="so-save" ?disabled=${st === "saving" || (this.compact && !this.dirty)}>${icons.check}${st === "saving" ? "Saving…" : "Save"}</button>
      </div>
    </form>`;
    return this.compact ? html`<div class="card">${body}</div>` : body;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-tag-input": TagInput;
    "ib-secure-organize": SecureOrganize;
  }
}
