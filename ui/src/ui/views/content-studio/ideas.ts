/**
 * <cs-ideas-area> — free-form markdown idea pages: a searchable list (pinned
 * first) on the left, the selected page (rich editor + media rail) on the
 * right. An idea can be promoted onto the pipeline board.
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { relTime, type Idea, type Stage, type StudioApi } from "./api.js";
import "./page-view.js";
import { ensureStudioStyles } from "./styles.js";

@customElement("cs-ideas-area")
export class CsIdeasArea extends LitElement {
  @property({ attribute: false }) api: StudioApi | null = null;
  @property({ attribute: false }) stages: Stage[] = [];
  @property({ type: Boolean }) flypic = false;
  /** Bumped by the shell to force a refresh (e.g. after an agent edit). */
  @property({ type: Number }) refreshKey = 0;

  @state() private ideas: Idea[] | null = null;
  @state() private selected: string | null = null;
  @state() private search = "";
  @state() private error: string | null = null;

  protected createRenderRoot() {
    ensureStudioStyles();
    return this;
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if ((changed.has("api") || changed.has("refreshKey")) && this.api) void this.load();
  }

  private async load(): Promise<void> {
    if (!this.api) return;
    try {
      this.ideas = (await this.api.ideas()).ideas;
      if (this.selected && !this.ideas.some((i) => i.id === this.selected)) this.selected = null;
      if (!this.selected && this.ideas.length && window.matchMedia("(min-width: 900px)").matches) {
        this.selected = this.ideas[0]!.id;
      }
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err);
    }
  }

  private async create(): Promise<void> {
    if (!this.api) return;
    const { idea } = await this.api.createIdea({ title: "Untitled idea", icon: "💡" });
    this.ideas = [idea, ...(this.ideas ?? [])];
    this.selected = idea.id;
  }

  private async removeIdea(idea: Idea): Promise<void> {
    if (!this.api || !window.confirm(`Delete “${idea.title}”? Its page and media links go too.`)) return;
    await this.api.deleteIdea(idea.id);
    if (this.selected === idea.id) this.selected = null;
    await this.load();
  }

  render() {
    const q = this.search.trim().toLowerCase();
    const list = (this.ideas ?? []).filter(
      (i) =>
        !q ||
        i.title.toLowerCase().includes(q) ||
        i.excerpt.toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q)),
    );
    return html`
      <div class="cs-ideas ${this.selected ? "has-selection" : ""}">
        <aside class="cs-ideas-list" aria-label="Ideas">
          <div class="cs-ideas-head">
            <input
              class="cs-input"
              type="search"
              placeholder="Search ideas…"
              .value=${this.search}
              @input=${(e: Event) => (this.search = (e.target as HTMLInputElement).value)}
            />
            <button class="cs-btn cs-btn-primary" @click=${() => void this.create()}>+ Idea</button>
          </div>
          ${this.error ? html`<div class="cs-error">${this.error}</div>` : nothing}
          ${this.ideas === null
            ? html`<div class="cs-skel"></div><div class="cs-skel"></div>`
            : list.length === 0
              ? html`<div class="cs-ideas-empty">
                  ${q
                    ? "No ideas match."
                    : html`<b>Your idea backlog lives here.</b
                        ><span>Jot hooks, angles, series and references as rich pages, then promote the best ones onto the pipeline.</span>
                        <button class="cs-btn cs-btn-primary" @click=${() => void this.create()}>Write the first idea</button>`}
                </div>`
              : list.map(
                  (i) => html`
                    <button
                      class="cs-idea-row ${this.selected === i.id ? "is-on" : ""}"
                      @click=${() => (this.selected = i.id)}
                    >
                      <span class="cs-idea-ic" aria-hidden="true">${i.icon || "💡"}</span>
                      <span class="cs-idea-txt">
                        <span class="cs-idea-title"
                          >${i.pinned ? html`<span class="cs-pin" title="Pinned">★</span>` : nothing}${i.title}</span
                        >
                        <span class="cs-idea-ex">${i.excerpt || "Empty page"}</span>
                        <span class="cs-idea-meta">
                          ${relTime(i.updatedAt)} · ${i.docWords} words${i.mediaCount ? html` · ⧉ ${i.mediaCount}` : nothing}
                          ${i.promotedItemId ? html`<span class="cs-chip cs-chip-ok">on board</span>` : nothing}
                        </span>
                      </span>
                      <span
                        class="cs-idea-del"
                        role="button"
                        tabindex="0"
                        aria-label=${`Delete ${i.title}`}
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          void this.removeIdea(i);
                        }}
                        >×</span
                      >
                    </button>
                  `,
                )}
        </aside>
        <section class="cs-ideas-page">
          ${this.selected
            ? html`<cs-page-view
                .api=${this.api}
                ownerKind="idea"
                .ownerId=${this.selected}
                .stages=${this.stages}
                ?flypic=${this.flypic}
                @cs-close=${() => (this.selected = null)}
                @cs-changed=${() => void this.load()}
              ></cs-page-view>`
            : html`<div class="cs-ideas-placeholder">
                <span aria-hidden="true">✎</span>
                <p>Select an idea or start a new one.</p>
              </div>`}
        </section>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cs-ideas-area": CsIdeasArea;
  }
}
