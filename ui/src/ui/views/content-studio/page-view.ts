/**
 * <cs-page-view> — the markdown page behind a pipeline card or an Ideas page.
 *
 * Title + properties on top, the shared rich-doc-editor (headings, lists,
 * slash menu, tables, Block[] persistence) as the body, and a media rail for
 * attachments: upload / drop / paste, add by URL, FlyPic generation when the
 * FlyPic plugin is on, insert-into-page, set as cover, detach.
 *
 * Light DOM: the editor's stylesheet lives in document.head.
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { mountRichDocEditor, type RichDocEditor, type RichDocMedia } from "../rich-doc-editor.js";
import {
  FORMATS,
  PLATFORMS,
  mediaSrc,
  relTime,
  type Idea,
  type Item,
  type MediaView,
  type OwnerKind,
  type Stage,
  type StudioApi,
} from "./api.js";
import { ensureStudioStyles } from "./styles.js";

const toMedia = (m: MediaView): RichDocMedia => ({
  url: mediaSrc(m.url),
  kind: m.kind,
  caption: m.caption || (m.kind === "image" ? "" : m.filename),
  id: m.id,
});

function dateInputValue(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

@customElement("cs-page-view")
export class CsPageView extends LitElement {
  @property({ attribute: false }) api: StudioApi | null = null;
  @property() ownerKind: OwnerKind = "item";
  @property() ownerId = "";
  @property({ attribute: false }) stages: Stage[] = [];
  @property({ type: Boolean }) flypic = false;

  @state() private item: Item | null = null;
  @state() private idea: Idea | null = null;
  @state() private media: MediaView[] = [];
  @state() private busy: string | null = null;
  @state() private error: string | null = null;
  @state() private tagDraft = "";
  @state() private railDrop = false;

  private editor: RichDocEditor | null = null;
  private mountedFor = "";

  protected createRenderRoot() {
    ensureStudioStyles();
    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.editor?.destroy();
    this.editor = null;
    this.mountedFor = "";
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if ((changed.has("ownerId") || changed.has("api")) && this.api && this.ownerId) void this.load();
  }

  protected updated(): void {
    const key = `${this.ownerKind}:${this.ownerId}`;
    const host = this.querySelector<HTMLElement>(".cs-editor-host");
    if (!host || !this.api || this.mountedFor === key) return;
    this.editor?.destroy();
    this.mountedFor = key;
    const api = this.api;
    this.editor = mountRichDocEditor(host, {
      client: api.client as never,
      target: { kind: "task", id: this.ownerId },
      rpc: {
        getBlocks: "content-studio.docs.getBlocks",
        saveBlocks: "content-studio.docs.saveBlocks",
        params: { ownerKind: this.ownerKind, ownerId: this.ownerId },
      },
      placeholder:
        this.ownerKind === "item"
          ? "Write the brief, hook, script and shot list…  Type / for blocks, drop files to embed."
          : "Capture the idea…  Type / for blocks, drop images, video or audio.",
      media: {
        upload: async (files) => {
          const out: RichDocMedia[] = [];
          for (const f of files) out.push(toMedia(await api.upload(f, this.ownerKind, this.ownerId)));
          void this.refreshMedia();
          return out;
        },
        generateImage: this.flypic ? () => this.generate() : undefined,
      },
      onSaved: () => this.dispatchEvent(new CustomEvent("cs-changed", { bubbles: true })),
    });
  }

  private async load(): Promise<void> {
    const api = this.api;
    if (!api) return;
    this.error = null;
    try {
      if (this.ownerKind === "item") {
        const res = await api.getItem(this.ownerId);
        this.item = res.item;
        this.media = res.media;
      } else {
        const { ideas } = await api.ideas();
        this.idea = ideas.find((i) => i.id === this.ownerId) ?? null;
        this.media = (await api.mediaFor("idea", this.ownerId)).media;
      }
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err);
    }
  }

  private async refreshMedia(): Promise<void> {
    if (!this.api) return;
    if (this.ownerKind === "item") {
      const res = await this.api.getItem(this.ownerId);
      this.item = res.item;
      this.media = res.media;
    } else {
      this.media = (await this.api.mediaFor("idea", this.ownerId)).media;
    }
    this.dispatchEvent(new CustomEvent("cs-changed", { bubbles: true }));
  }

  private async patchItem(p: Parameters<StudioApi["updateItem"]>[1]): Promise<void> {
    if (!this.api || !this.item) return;
    try {
      this.item = (await this.api.updateItem(this.item.id, p)).item;
      this.dispatchEvent(new CustomEvent("cs-changed", { bubbles: true }));
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err);
    }
  }

  private async patchIdea(p: Parameters<StudioApi["updateIdea"]>[1]): Promise<void> {
    if (!this.api || !this.idea) return;
    try {
      const { idea } = await this.api.updateIdea(this.idea.id, p);
      this.idea = { ...this.idea, ...idea };
      this.dispatchEvent(new CustomEvent("cs-changed", { bubbles: true }));
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err);
    }
  }

  private async uploadFiles(files: File[]): Promise<void> {
    if (!this.api || !files.length) return;
    this.busy = `Uploading ${files.length === 1 ? files[0]!.name : `${files.length} files`}…`;
    this.error = null;
    try {
      for (const f of files) await this.api.upload(f, this.ownerKind, this.ownerId);
      await this.refreshMedia();
    } catch (err) {
      this.error = `Upload failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = null;
    }
  }

  private pickFiles(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*,video/*,audio/*";
    input.addEventListener("change", () => void this.uploadFiles(Array.from(input.files ?? [])));
    input.click();
  }

  private async addUrl(): Promise<void> {
    if (!this.api) return;
    const url = window.prompt("Image, video or audio URL (https://…)");
    if (!url) return;
    const copy = window.confirm(
      "Save a copy in Content Studio?\n\nOK = download it (keeps working if the link expires)\nCancel = embed the link only",
    );
    this.busy = copy ? "Downloading…" : "Adding…";
    try {
      const { media } = copy
        ? await this.api.importUrl(this.ownerKind, this.ownerId, url)
        : await this.api.reference(this.ownerKind, this.ownerId, url);
      await this.refreshMedia();
      this.editor?.insertMedia(toMedia(media));
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err);
    } finally {
      this.busy = null;
    }
  }

  /** FlyPic image generation (billed on the user's FlyPic account). */
  private async generate(): Promise<RichDocMedia | null> {
    if (!this.api) return null;
    const prompt = window.prompt(
      "Generate an image with FlyPic (uses your FlyPic credits).\n\nDescribe the image:",
    );
    if (!prompt?.trim()) return null;
    this.busy = "FlyPic: starting…";
    try {
      const m = await this.api.generateWithFlypic(prompt.trim(), this.ownerKind, this.ownerId, (s) => {
        this.busy = s;
      });
      await this.refreshMedia();
      return toMedia(m);
    } catch (err) {
      this.error = `FlyPic: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    } finally {
      this.busy = null;
    }
  }

  private async detach(m: MediaView): Promise<void> {
    if (!this.api) return;
    this.media = (await this.api.detach(this.ownerKind, this.ownerId, m.id)).media;
    await this.refreshMedia();
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent("cs-close", { bubbles: true }));
  }

  // ── Render ───────────────────────────────────────────────────────────────

  render() {
    const item = this.item;
    const idea = this.idea;
    const stage = item ? this.stages.find((s) => s.id === item.stageId) : null;
    return html`
      <div class="cs-page">
        <div class="cs-page-top">
          <button class="cs-btn cs-btn-ghost" @click=${this.close} aria-label="Back">← Back</button>
          <div class="cs-crumbs">
            <span>${this.ownerKind === "item" ? "Pipeline" : "Ideas"}</span>
            ${stage
              ? html`<span class="cs-crumb-sep">/</span
                  ><span class="cs-stage-pill" style="--stage:${stage.color}">${stage.name}</span>`
              : nothing}
          </div>
          <span class="cs-spacer"></span>
          ${item
            ? html`<label class="cs-field-inline"
                  >Stage
                  <select
                    class="cs-select"
                    .value=${item.stageId}
                    @change=${async (e: Event) => {
                      const to = (e.target as HTMLSelectElement).value;
                      if (!this.api || to === item.stageId) return;
                      this.item = (await this.api.moveItem(item.id, to)).item;
                      this.dispatchEvent(new CustomEvent("cs-changed", { bubbles: true }));
                    }}
                  >
                    ${this.stages.map(
                      (s) => html`<option value=${s.id} ?selected=${s.id === item.stageId}>${s.name}</option>`,
                    )}
                  </select></label
                >`
            : nothing}
          ${idea ? this.renderPromote(idea) : nothing}
        </div>
        ${this.error ? html`<div class="cs-error" role="alert">${this.error}</div>` : nothing}
        <div class="cs-page-grid">
          <section class="cs-page-main">
            ${item ? this.renderItemHead(item) : idea ? this.renderIdeaHead(idea) : html`<div class="cs-skel"></div>`}
            <div class="cs-editor-host"></div>
          </section>
          ${this.renderRail()}
        </div>
      </div>
    `;
  }

  private renderItemHead(item: Item) {
    return html`
      <div class="cs-doc-head">
        <input
          class="cs-title-input"
          .value=${item.title}
          aria-label="Title"
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (v && v !== item.title) void this.patchItem({ title: v });
          }}
        />
        <input
          class="cs-summary-input"
          placeholder="One-line summary shown on the card"
          .value=${item.summary}
          @change=${(e: Event) => void this.patchItem({ summary: (e.target as HTMLInputElement).value })}
        />
        <div class="cs-props">
          <label class="cs-prop"
            ><span>Platform</span>
            <select
              class="cs-select"
              @change=${(e: Event) => void this.patchItem({ platform: (e.target as HTMLSelectElement).value || null })}
            >
              <option value="" ?selected=${!item.platform}>—</option>
              ${PLATFORMS.map((p) => html`<option value=${p} ?selected=${item.platform === p}>${p}</option>`)}
            </select></label
          >
          <label class="cs-prop"
            ><span>Format</span>
            <select
              class="cs-select"
              @change=${(e: Event) => void this.patchItem({ format: (e.target as HTMLSelectElement).value || null })}
            >
              <option value="" ?selected=${!item.format}>—</option>
              ${FORMATS.map((f) => html`<option value=${f} ?selected=${item.format === f}>${f}</option>`)}
            </select></label
          >
          <label class="cs-prop"
            ><span>Due</span>
            <input
              type="date"
              class="cs-input"
              .value=${dateInputValue(item.dueAt)}
              @change=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                void this.patchItem({ dueAt: v ? new Date(`${v}T12:00:00`).getTime() : null });
              }}
          /></label>
          <div class="cs-prop cs-prop-tags">
            <span>Tags</span>
            <div class="cs-tags">
              ${item.tags.map(
                (t) => html`<span class="cs-tag"
                  >${t}<button
                    aria-label=${`Remove ${t}`}
                    @click=${() => void this.patchItem({ tags: item.tags.filter((x) => x !== t) })}
                  >
                    ×
                  </button></span
                >`,
              )}
              <input
                class="cs-tag-input"
                placeholder="+ tag"
                .value=${this.tagDraft}
                @input=${(e: Event) => (this.tagDraft = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key !== "Enter" || !this.tagDraft.trim()) return;
                  void this.patchItem({ tags: [...item.tags, this.tagDraft.trim()] });
                  this.tagDraft = "";
                }}
              />
            </div>
          </div>
        </div>
        <div class="cs-meta-line">
          Created ${relTime(item.createdAt)} · in stage since ${relTime(item.stageEnteredAt)}
          ${item.docWords ? html` · ${item.docWords} words` : nothing}
        </div>
      </div>
    `;
  }

  private renderIdeaHead(idea: Idea) {
    return html`
      <div class="cs-doc-head">
        <div class="cs-idea-title-row">
          <input
            class="cs-icon-input"
            .value=${idea.icon || ""}
            placeholder="💡"
            maxlength="4"
            aria-label="Icon"
            @change=${(e: Event) => void this.patchIdea({ icon: (e.target as HTMLInputElement).value })}
          />
          <input
            class="cs-title-input"
            .value=${idea.title}
            aria-label="Title"
            @change=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value.trim();
              if (v && v !== idea.title) void this.patchIdea({ title: v });
            }}
          />
          <button
            class="cs-btn cs-btn-ghost ${idea.pinned ? "is-on" : ""}"
            title=${idea.pinned ? "Unpin" : "Pin to top"}
            @click=${() => void this.patchIdea({ pinned: !idea.pinned })}
          >
            ${idea.pinned ? "★ Pinned" : "☆ Pin"}
          </button>
        </div>
        <div class="cs-meta-line">
          Updated ${relTime(idea.updatedAt)}${idea.promotedItemId ? html` · <b>on the pipeline</b>` : nothing}
        </div>
      </div>
    `;
  }

  private renderPromote(idea: Idea) {
    if (idea.promotedItemId) {
      return html`<button
        class="cs-btn cs-btn-ghost"
        @click=${() =>
          this.dispatchEvent(
            new CustomEvent("cs-open-item", { bubbles: true, detail: { itemId: idea.promotedItemId } }),
          )}
      >
        Open card →
      </button>`;
    }
    return html`<button
      class="cs-btn cs-btn-primary"
      @click=${async () => {
        if (!this.api) return;
        const { item } = await this.api.promoteIdea(idea.id);
        this.dispatchEvent(new CustomEvent("cs-changed", { bubbles: true }));
        this.dispatchEvent(new CustomEvent("cs-open-item", { bubbles: true, detail: { itemId: item.id } }));
      }}
    >
      ↗ Promote to pipeline
    </button>`;
  }

  private renderRail() {
    const cover = this.item?.coverMediaId;
    return html`
      <aside
        class="cs-rail ${this.railDrop ? "is-drop" : ""}"
        @dragover=${(e: DragEvent) => {
          if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
          e.preventDefault();
          this.railDrop = true;
        }}
        @dragleave=${(e: DragEvent) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) this.railDrop = false;
        }}
        @drop=${(e: DragEvent) => {
          this.railDrop = false;
          if (!e.dataTransfer?.files.length) return;
          e.preventDefault();
          void this.uploadFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <div class="cs-rail-head">
          <span class="cs-eyebrow">Media</span>
          <span class="cs-count">${this.media.length}</span>
        </div>
        <button class="cs-dropzone" @click=${() => this.pickFiles()}>
          <span class="cs-dropzone-ic" aria-hidden="true">⇪</span>
          <span><b>Drop files</b> or click to upload</span>
          <small>Images · video · audio</small>
        </button>
        <div class="cs-rail-actions">
          <button class="cs-btn cs-btn-ghost" @click=${() => void this.addUrl()}>+ URL</button>
          ${this.flypic
            ? html`<button
                class="cs-btn cs-btn-ghost"
                title="Generate an image with FlyPic (uses your credits)"
                @click=${async () => {
                  const m = await this.generate();
                  if (m) this.editor?.insertMedia(m);
                }}
              >
                ✨ Generate
              </button>`
            : nothing}
        </div>
        ${this.busy ? html`<div class="cs-busy">${this.busy}</div>` : nothing}
        <div class="cs-media-grid">
          ${this.media.map(
            (m) => html`
              <figure class="cs-media-tile" data-kind=${m.kind}>
                ${m.kind === "image"
                  ? html`<img src=${mediaSrc(m.url)} alt=${m.caption || m.filename} loading="lazy" />`
                  : m.kind === "video"
                    ? html`<video src=${`${mediaSrc(m.url)}#t=0.5`} preload="metadata" muted playsinline></video
                        ><span class="cs-play" aria-hidden="true">▶</span>`
                    : html`<div class="cs-audio-tile"><span aria-hidden="true">♪</span><audio src=${mediaSrc(m.url)} controls preload="none"></audio></div>`}
                <figcaption title=${m.filename}>
                  ${cover === m.id ? html`<span class="cs-cover-badge">Cover</span>` : nothing}
                  ${m.caption || m.filename || m.kind}
                </figcaption>
                <div class="cs-tile-actions">
                  <button title="Insert into page" @click=${() => this.editor?.insertMedia(toMedia(m))}>⤵</button>
                  ${this.item && (m.kind === "image" || m.kind === "video") && cover !== m.id
                    ? html`<button title="Use as card cover" @click=${() => void this.patchItem({ coverMediaId: m.id })}>
                        ◩
                      </button>`
                    : nothing}
                  <button title="Remove from this page" @click=${() => void this.detach(m)}>×</button>
                </div>
              </figure>
            `,
          )}
        </div>
        ${!this.media.length && !this.busy
          ? html`<p class="cs-rail-empty">Attach reference shots, b-roll, voice-overs or thumbnails here — then insert them into the page.</p>`
          : nothing}
      </aside>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cs-page-view": CsPageView;
  }
}
