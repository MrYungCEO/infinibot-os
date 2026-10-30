/**
 * <moltbot-markdown-editor>
 *
 * Small Lit component: textarea + toggle-able live preview, minimal toolbar.
 * Uses `marked` for rendering (already a ui/ dep). Dispatches a `change`
 * CustomEvent with { detail: { value } } on textarea blur / toolbar action.
 *
 *   <moltbot-markdown-editor
 *     .value=${row.body ?? ''}
 *     placeholder="Write…"
 *     @change=${(e: CustomEvent<{ value: string }>) => onSave(e.detail.value)}
 *   ></moltbot-markdown-editor>
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../icons.js";
import { toSanitizedMarkdownHtml } from "../markdown/render.js";

type Mode = "edit" | "preview" | "split";

@customElement("moltbot-markdown-editor")
export class MarkdownEditor extends LitElement {
  @property({ type: String }) value = "";
  @property({ type: String }) placeholder = "Write markdown…";
  @property({ type: Number }) minRows = 8;
  @property({ type: Boolean }) showToolbar = true;
  /** Read-only: no toolbar, no textarea, preview pane renders as an article. */
  @property({ type: Boolean }) readOnly = false;

  @state() private mode: Mode = "edit";
  @state() private draft = "";
  @state() private userChoseMode = false;

  static styles = css`
    :host {
      display: block;
      --me-bg: rgba(0, 0, 0, 0.28);
      --me-border: rgba(250, 204, 21, 0.18);
      --me-accent: var(--c-accent, var(--g-primary));
      --me-text: var(--c-fg, #f5f5f4);
      --me-muted: var(--c-fg-dim, rgba(245, 245, 244, 0.65));
      font: inherit;
      color: var(--me-text);
    }

    .me-wrap {
      flex: 1;
      border: 1px solid var(--me-border);
      border-radius: 10px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(0, 0, 0, 0.25));
      backdrop-filter: blur(12px);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    :host([readOnly]) .me-wrap {
      border: none;
      background: transparent;
      backdrop-filter: none;
    }

    .me-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 8px;
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid var(--me-border);
      flex-wrap: wrap;
    }
    .me-toolbar button {
      appearance: none;
      border: 1px solid transparent;
      background: transparent;
      color: var(--me-muted);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      min-width: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .me-toolbar button svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .me-toolbar button:hover {
      color: var(--me-text);
      background: rgba(250, 204, 21, 0.08);
      border-color: var(--me-border);
    }
    .me-toolbar .me-spacer { flex: 1; }
    .me-toolbar .me-mode {
      display: inline-flex;
      gap: 0;
      border: 1px solid var(--me-border);
      border-radius: 6px;
      overflow: hidden;
    }
    .me-toolbar .me-mode button {
      border-radius: 0;
      border-right: 1px solid var(--me-border);
    }
    .me-toolbar .me-mode button:last-child { border-right: none; }
    .me-toolbar .me-mode button.active {
      background: var(--me-accent);
      color: #000;
    }

    .me-body { flex: 1; display: flex; min-height: 160px; }
    .me-body.split > textarea, .me-body.split > .me-preview {
      flex: 1 1 50%;
      min-width: 0;
    }

    textarea {
      flex: 1;
      width: 100%;
      box-sizing: border-box;
      border: none;
      background: transparent;
      color: var(--me-text);
      padding: 12px;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      resize: vertical;
      outline: none;
    }

    .me-preview {
      padding: 18px 22px;
      overflow: auto;
      font-size: 15px;
      line-height: 1.7;
      color: var(--me-text);
      border-left: 1px solid var(--me-border);
    }
    .me-body:not(.split) .me-preview { border-left: none; }
    .me-preview-editable { cursor: text; }
    .me-preview-editable:hover {
      background: linear-gradient(180deg, rgba(255,255,255,0.015), rgba(250,204,21,0.02));
    }

    /* Article typography */
    .me-preview :first-child { margin-top: 0; }
    .me-preview :last-child { margin-bottom: 0; }
    .me-preview h1, .me-preview h2, .me-preview h3, .me-preview h4 {
      color: var(--me-text);
      letter-spacing: -0.01em;
      font-weight: 700;
      line-height: 1.3;
      margin: 1.4em 0 0.45em;
    }
    .me-preview h1 { font-size: 1.7em; border-bottom: 1px solid var(--me-border); padding-bottom: 0.3em; }
    .me-preview h2 { font-size: 1.35em; }
    .me-preview h3 { font-size: 1.1em; color: var(--me-accent); }
    .me-preview h4 { font-size: 1em; color: var(--me-muted); text-transform: uppercase; letter-spacing: 0.08em; }
    .me-preview p { margin: 0 0 0.8em; }
    .me-preview a {
      color: var(--me-accent);
      text-decoration: underline;
      text-decoration-color: rgba(250, 204, 21, 0.35);
      text-underline-offset: 3px;
    }
    .me-preview a:hover { text-decoration-color: var(--me-accent); }
    /* Nested-page links (moltbot://page/) get a chip look */
    .me-preview a[href^="moltbot://page/"] {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 8px 1px 6px;
      border-radius: 6px;
      background: rgba(250, 204, 21, 0.1);
      border: 1px solid rgba(250, 204, 21, 0.22);
      color: var(--me-accent);
      text-decoration: none;
      font-size: 0.95em;
    }
    .me-preview a[href^="moltbot://page/"]::before {
      content: "↗";
      font-size: 0.85em;
      opacity: 0.75;
    }
    .me-preview a[href^="moltbot://page/"]:hover {
      background: rgba(250, 204, 21, 0.18);
      border-color: var(--me-accent);
    }
    .me-preview code {
      background: rgba(0, 0, 0, 0.4);
      padding: 2px 6px;
      border-radius: 5px;
      font-size: 0.88em;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #fde68a;
    }
    .me-preview pre {
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid var(--me-border);
      padding: 12px 14px;
      border-radius: 10px;
      overflow: auto;
      margin: 1em 0;
      font-size: 0.88em;
      line-height: 1.55;
    }
    .me-preview pre code {
      background: transparent;
      padding: 0;
      color: #e6e6e6;
    }
    .me-preview img {
      max-width: 100%;
      border-radius: 10px;
      display: block;
      margin: 14px 0;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    }
    .me-preview video {
      max-width: 100%;
      border-radius: 10px;
      display: block;
      margin: 14px 0;
      background: #000;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .me-preview blockquote {
      border-left: 3px solid var(--me-accent);
      padding: 2px 14px;
      color: var(--me-muted);
      margin: 1em 0;
      background: rgba(250,204,21,0.04);
      border-radius: 0 6px 6px 0;
    }
    .me-preview ul, .me-preview ol { padding-left: 24px; margin: 0.6em 0; }
    .me-preview li { margin: 0.2em 0; }
    .me-preview li > input[type="checkbox"] {
      margin-right: 6px;
      accent-color: var(--me-accent);
    }
    .me-preview hr {
      border: none;
      border-top: 1px solid var(--me-border);
      margin: 2em 0;
    }
    .me-preview table {
      border-collapse: collapse;
      margin: 1em 0;
      width: 100%;
      font-size: 0.95em;
    }
    .me-preview th, .me-preview td {
      border: 1px solid var(--me-border);
      padding: 8px 10px;
      text-align: left;
    }
    .me-preview th { background: rgba(250,204,21,0.06); font-weight: 600; }
    .me-preview tr:nth-child(even) td { background: rgba(255,255,255,0.02); }

    /* Read-only pages get even roomier layout */
    .me-preview-readonly {
      padding: 24px 8px;
      font-size: 16px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.draft = this.value;
    this.syncDefaultMode();
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("value") && document.activeElement !== this.textareaEl) {
      this.draft = this.value;
      this.syncDefaultMode();
    }
    if (changed.has("readOnly")) {
      this.syncDefaultMode();
    }
  }

  /**
   * Auto-picks the initial mode:
   *   • readOnly → "preview" (locked)
   *   • non-empty value on mount → "preview" so content reads like an
   *     article; user clicks Edit to switch.
   *   • empty value → "edit" so typing is immediate.
   * Respects an explicit user choice once they've clicked Edit/Split/Preview.
   */
  private syncDefaultMode(): void {
    if (this.readOnly) {
      this.mode = "preview";
      return;
    }
    if (this.userChoseMode) return;
    this.mode = this.draft.trim().length > 0 ? "preview" : "edit";
  }

  private get textareaEl(): HTMLTextAreaElement | null {
    return this.renderRoot.querySelector("textarea");
  }

  private setMode(m: Mode) {
    this.userChoseMode = true;
    this.mode = m;
  }

  private onInput(e: Event) {
    this.draft = (e.target as HTMLTextAreaElement).value;
    // Fire input event so parent can keep state hot if they wish.
    this.dispatchEvent(
      new CustomEvent("input", { detail: { value: this.draft }, bubbles: true, composed: true }),
    );
  }

  private commit() {
    if (this.draft === this.value) return;
    this.value = this.draft;
    this.dispatchEvent(
      new CustomEvent("change", { detail: { value: this.draft }, bubbles: true, composed: true }),
    );
  }

  private wrap(prefix: string, suffix = prefix, placeholder = "text") {
    const ta = this.textareaEl;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const selected = this.draft.slice(start, end) || placeholder;
    this.draft = this.draft.slice(0, start) + prefix + selected + suffix + this.draft.slice(end);
    this.requestUpdate();
    queueMicrotask(() => {
      ta.focus();
      const caret = start + prefix.length + selected.length + suffix.length;
      ta.setSelectionRange(caret, caret);
    });
    this.commit();
  }

  private linePrefix(prefix: string) {
    const ta = this.textareaEl;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const lineStart = this.draft.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    this.draft =
      this.draft.slice(0, lineStart) + prefix + this.draft.slice(lineStart);
    this.requestUpdate();
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(start + prefix.length, start + prefix.length);
    });
    this.commit();
  }

  private renderToolbar() {
    if (!this.showToolbar) return nothing;
    if (this.readOnly) return nothing;
    return html`
      <div class="me-toolbar">
        <button title="Bold (Cmd/Ctrl+B)" @click=${() => this.wrap("**")}><strong>B</strong></button>
        <button title="Italic" @click=${() => this.wrap("*")}><em>I</em></button>
        <button title="Inline code" @click=${() => this.wrap("`")}>&lt;/&gt;</button>
        <button title="Link" @click=${() => this.wrap("[", "](url)")}>${icons.link}</button>
        <button title="Image" @click=${() => this.wrap("![alt](", ")")}>${icons.image}</button>
        <button title="H1" @click=${() => this.linePrefix("# ")}>H1</button>
        <button title="H2" @click=${() => this.linePrefix("## ")}>H2</button>
        <button title="Bullet list" @click=${() => this.linePrefix("- ")}>${icons.layoutList}</button>
        <button title="Numbered list" @click=${() => this.linePrefix("1. ")}>1.</button>
        <button title="Todo" @click=${() => this.linePrefix("- [ ] ")}>${icons.check}</button>
        <button title="Quote" @click=${() => this.linePrefix("> ")}>${icons.chevronRight}</button>
        <button title="Code block" @click=${() => this.wrap("\n\n```\n", "\n```\n\n", "code")}>${icons.fileCode}</button>

        <span class="me-spacer"></span>

        <span class="me-mode">
          <button class=${this.mode === "edit" ? "active" : ""} @click=${() => this.setMode("edit")}>Edit</button>
          <button class=${this.mode === "split" ? "active" : ""} @click=${() => this.setMode("split")}>Split</button>
          <button class=${this.mode === "preview" ? "active" : ""} @click=${() => this.setMode("preview")}>Preview</button>
        </span>
      </div>
    `;
  }

  private renderPreview() {
    if (this.mode === "edit") return nothing;
    const empty = this.draft.trim().length === 0;
    const src = empty ? (this.readOnly ? "" : "*Empty — click to start writing*") : this.draft;
    const rendered = toSanitizedMarkdownHtml(src);
    return html`
      <div
        class="me-preview ${this.readOnly ? "me-preview-readonly" : "me-preview-editable"}"
        @click=${(e: MouseEvent) => this.onPreviewClick(e)}
      >${unsafeHTML(rendered)}</div>
    `;
  }

  /**
   * Preview click handling: intercept `moltbot://page/<rowId>` anchors as
   * navigation events so the host can openRowPage. Anywhere else (and
   * writable mode), a bare click switches to edit.
   */
  private onPreviewClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
    if (anchor) {
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("moltbot://page/")) {
        e.preventDefault();
        const rowId = href.slice("moltbot://page/".length);
        this.dispatchEvent(
          new CustomEvent("navigate", {
            detail: { rowId },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      // Normal links render as-is — let the browser handle them. External
      // targets should open in a new tab; add that automatically.
      if (href.match(/^https?:\/\//) && !anchor.target) anchor.target = "_blank";
      return;
    }
    if (!this.readOnly && this.mode !== "edit") {
      this.setMode("edit");
      // Focus textarea after render
      queueMicrotask(() => this.textareaEl?.focus());
    }
  }

  private renderTextarea() {
    if (this.mode === "preview" || this.readOnly) return nothing;
    return html`
      <textarea
        data-mb-editor="markdown"
        rows=${this.minRows}
        placeholder=${this.placeholder}
        .value=${this.draft}
        @input=${this.onInput}
        @blur=${() => this.commit()}
        @paste=${(e: ClipboardEvent) => {
          const items = e.clipboardData?.items;
          if (items && items.length > 0) {
            const imageItem = Array.from(items).find(
              (it) => it.kind === "file" && it.type.startsWith("image/"),
            );
            if (imageItem) {
              e.preventDefault();
              const file = imageItem.getAsFile();
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                const dataUrl = String(reader.result ?? "");
                if (!dataUrl) return;
                this.wrap("![pasted-image](", ")");
              };
              reader.readAsDataURL(file);
              return;
            }
          }
        }}
        @keydown=${(e: KeyboardEvent) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
            e.preventDefault();
            this.wrap("**");
          } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") {
            e.preventDefault();
            this.wrap("*");
          }
        }}
      ></textarea>
    `;
  }

  render() {
    return html`
      <div
        class="me-wrap"
        @dragover=${(e: DragEvent) => e.preventDefault()}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          const files = e.dataTransfer?.files;
          if (!files || files.length === 0) return;
          const imageFile = Array.from(files).find((f) => f.type.startsWith("image/"));
          if (!imageFile) return;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = String(reader.result ?? "");
            if (!dataUrl) return;
            this.draft += `\n![dropped-image](${dataUrl})\n`;
            this.requestUpdate();
            this.commit();
          };
          reader.readAsDataURL(imageFile);
        }}
      >
        ${this.renderToolbar()}
        <div class="me-body ${this.mode}" part="body">
          ${this.renderTextarea()}
          ${this.renderPreview()}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "moltbot-markdown-editor": MarkdownEditor;
  }
}
