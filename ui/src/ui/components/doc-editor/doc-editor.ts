/**
 * <ib-doc-editor> — markdown-native rich document editor for the Documents
 * workspace.
 *
 *   <ib-doc-editor
 *     .value=${markdown}
 *     .linkTargets=${[{ id, title }]}
 *     .uploadImage=${(file) => api.upload(file)}
 *     @doc-change=${(e) => save(e.detail.markdown)}
 *     @doc-save=${...}
 *     @doc-open-link=${(e) => open(e.detail)}
 *   ></ib-doc-editor>
 *
 * Content is always markdown (the dialect in src/documents/DIALECT.md). Rich
 * mode renders it into a contenteditable surface via markdownToEditorHtml and
 * serializes back with editorHtmlToMarkdown; Markdown mode is a plain
 * textarea. Switching modes is lossless.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import type { PropertyValues, TemplateResult } from "lit";
import { editorHtmlToMarkdown, htmlStringToMarkdown } from "./html-to-md.js";
import {
  CALLOUT_KINDS,
  calloutHtml,
  calloutLabel,
  codeBlockHtml,
  embedHtml,
  escapeHtml,
  highlightCode,
  inlineMathHtml,
  markdownToEditorHtml,
  mathBlockHtml,
  mediaHtml,
  sanitizeEditorHtml,
  toggleHtml,
} from "./md-to-html.js";

export type DocEditorMode = "rich" | "source";
export interface DocLinkTarget {
  id: string;
  title: string;
}
export interface DocOpenLinkDetail {
  target: string;
  kind: "wiki" | "doc" | "url";
}

const CHANGE_DEBOUNCE_MS = 500;
const HISTORY_LIMIT = 200;
const MAX_INLINE_IMAGE_BYTES = 200 * 1024;

// ── Icons (24px stroke glyphs) ───────────────────────────────────────────

const I = (body: TemplateResult, fill = false) =>
  html`<svg viewBox="0 0 24 24" width="16" height="16" fill=${fill ? "currentColor" : "none"} stroke=${fill ? "none" : "currentColor"} stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  code: I(svg`<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>`),
  highlight: I(svg`<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>`),
  link: I(svg`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`),
  bullet: I(svg`<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1.2" fill="currentColor"/><circle cx="4" cy="12" r="1.2" fill="currentColor"/><circle cx="4" cy="18" r="1.2" fill="currentColor"/>`),
  numbered: I(svg`<path d="M10 6h11M10 12h11M10 18h11M4 4.5h1.2V9M3.6 9h2.8M3.6 14.2c.4-.6 1-.9 1.6-.9.8 0 1.4.5 1.4 1.2 0 1.3-3 2.1-3 3.8h3"/>`),
  todo: I(svg`<rect x="3" y="4" width="7" height="7" rx="1.5"/><path d="m3.8 17.2 1.8 1.8 3.4-3.6"/><path d="M14 7.5h7M14 17.5h7"/>`),
  quote: I(svg`<path d="M5 18c2.5-1 4-3 4-6.5V7H4v5h4M15 18c2.5-1 4-3 4-6.5V7h-5v5h4"/>`),
  callout: I(svg`<circle cx="12" cy="12" r="9"/><path d="M12 16.5v-5M12 7.8h.01"/>`),
  toggle: I(svg`<path d="m7 8 4 4-4 4"/><path d="M14 8h7M14 16h7"/>`),
  codeBlock: I(svg`<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m10 9.5-2.5 2.5 2.5 2.5M14 9.5l2.5 2.5-2.5 2.5"/>`),
  table: I(svg`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 15h18M10 4v16"/>`),
  divider: I(svg`<path d="M3 12h18"/><path d="M8 7h8M8 17h8" opacity=".35"/>`),
  image: I(svg`<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L6 20"/>`),
  math: I(svg`<path d="M18 6.5V4H6l6.5 8L6 20h12v-2.5"/>`),
  embed: I(svg`<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m10 9.2 5 2.8-5 2.8z"/>`),
  undo: I(svg`<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>`),
  redo: I(svg`<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>`),
  text: I(svg`<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>`),
  wiki: I(svg`<path d="M8 4H5v16h3M16 4h3v16h-3"/><path d="M10 12h4"/>`),
  video: I(svg`<rect x="2.5" y="5.5" width="14" height="13" rx="2"/><path d="m16.5 10 5-3v10l-5-3"/>`),
};

// ── Slash commands ───────────────────────────────────────────────────────

interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  icon: TemplateResult | string;
  group: "Basic" | "Blocks" | "Media" | "Table";
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: "p", label: "Text", hint: "Plain paragraph", keywords: "paragraph text plain", icon: ICONS.text, group: "Basic" },
  { id: "h1", label: "Heading 1", hint: "Big section title", keywords: "h1 title heading", icon: "H1", group: "Basic" },
  { id: "h2", label: "Heading 2", hint: "Medium section title", keywords: "h2 heading subtitle", icon: "H2", group: "Basic" },
  { id: "h3", label: "Heading 3", hint: "Small section title", keywords: "h3 heading", icon: "H3", group: "Basic" },
  { id: "bullet", label: "Bulleted list", hint: "Simple bullet list", keywords: "ul unordered bullet list", icon: ICONS.bullet, group: "Basic" },
  { id: "numbered", label: "Numbered list", hint: "List with numbers", keywords: "ol ordered numbered list", icon: ICONS.numbered, group: "Basic" },
  { id: "todo", label: "Checklist", hint: "Track tasks", keywords: "todo task checkbox check", icon: ICONS.todo, group: "Basic" },
  { id: "quote", label: "Quote", hint: "Capture a quote", keywords: "blockquote quote", icon: ICONS.quote, group: "Basic" },
  { id: "callout-NOTE", label: "Callout: Note", hint: "Highlighted info box", keywords: "callout note info admonition", icon: ICONS.callout, group: "Blocks" },
  { id: "callout-TIP", label: "Callout: Tip", hint: "Helpful advice", keywords: "callout tip hint", icon: ICONS.callout, group: "Blocks" },
  { id: "callout-IMPORTANT", label: "Callout: Important", hint: "Key information", keywords: "callout important", icon: ICONS.callout, group: "Blocks" },
  { id: "callout-WARNING", label: "Callout: Warning", hint: "Needs attention", keywords: "callout warning warn", icon: ICONS.callout, group: "Blocks" },
  { id: "callout-CAUTION", label: "Callout: Caution", hint: "Risk / danger", keywords: "callout caution danger", icon: ICONS.callout, group: "Blocks" },
  { id: "toggle", label: "Toggle", hint: "Collapsible section", keywords: "toggle details collapse fold", icon: ICONS.toggle, group: "Blocks" },
  { id: "code", label: "Code block", hint: "Fenced code with highlighting", keywords: "code pre snippet fence", icon: ICONS.codeBlock, group: "Blocks" },
  { id: "math", label: "Math block", hint: "TeX equation", keywords: "math tex latex equation formula", icon: ICONS.math, group: "Blocks" },
  { id: "inline-math", label: "Inline math", hint: "TeX inside a line", keywords: "math inline tex", icon: ICONS.math, group: "Blocks" },
  { id: "divider", label: "Divider", hint: "Horizontal rule", keywords: "divider hr rule line separator", icon: ICONS.divider, group: "Blocks" },
  { id: "wiki", label: "Link to document", hint: "[[Wiki link]]", keywords: "wiki link page doc mention", icon: ICONS.wiki, group: "Blocks" },
  { id: "table", label: "Table", hint: "3 × 3 table", keywords: "table grid", icon: ICONS.table, group: "Blocks" },
  { id: "image", label: "Image", hint: "Upload or link an image", keywords: "image picture photo img", icon: ICONS.image, group: "Media" },
  { id: "embed", label: "Embed", hint: "YouTube, Loom, Figma, any https page", keywords: "embed iframe youtube video loom figma", icon: ICONS.embed, group: "Media" },
  { id: "video", label: "Video / audio file", hint: "Link a media file", keywords: "video audio mp4 mp3 media", icon: ICONS.video, group: "Media" },
  { id: "row-below", label: "Add row below", hint: "Table", keywords: "table row add insert", icon: ICONS.table, group: "Table" },
  { id: "col-right", label: "Add column right", hint: "Table", keywords: "table column add insert", icon: ICONS.table, group: "Table" },
  { id: "row-delete", label: "Delete row", hint: "Table", keywords: "table row delete remove", icon: ICONS.table, group: "Table" },
  { id: "col-delete", label: "Delete column", hint: "Table", keywords: "table column delete remove", icon: ICONS.table, group: "Table" },
];

interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  icon?: TemplateResult | string;
  group?: string;
}

interface MenuState {
  kind: "slash" | "wiki";
  query: string;
  items: MenuItem[];
  index: number;
  x: number;
  y: number;
}

interface PromptState {
  kind: "link" | "embed" | "image" | "lang" | "video";
  label: string;
  value: string;
  placeholder: string;
  x: number;
  y: number;
}

interface Snapshot {
  html: string;
  caret: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const FLOW_CONTAINER_SELECTOR = ".surface, .callout-body, .toggle-body, blockquote";
const BLOCK_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "PRE", "SUMMARY", "TD", "TH", "DIV", "BLOCKQUOTE", "FIGURE"]);

function isElement(n: Node | null | undefined): n is HTMLElement {
  return !!n && n.nodeType === 1;
}

/** Drop empty text nodes; give an empty block a <br> so the caret can live in it. */
function fillable(el: HTMLElement): HTMLElement {
  Array.from(el.childNodes).forEach((c) => {
    if (c.nodeType === 3 && !(c as Text).data.replace(/[\u200b\ufeff]/g, "")) c.remove();
  });
  if (!el.firstChild) el.innerHTML = "<br>";
  return el;
}

function textOf(el: Node): string {
  return (el.textContent ?? "").replace(/[​﻿]/g, "").replace(/ /g, " ");
}

function looksLikeMarkdown(text: string): boolean {
  return (
    /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.+\||\$\$|<details|---\s*$)/m.test(text) ||
    /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|\[\[[^\]\n]+\]\]|==[^=\n]+==|`[^`\n]+`/.test(text)
  );
}

function normalizeEmbedUrl(url: string): string {
  const u = url.trim();
  let m = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([\w-]{6,})/i.exec(u) ?? /^https?:\/\/youtu\.be\/([\w-]{6,})/i.exec(u);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = /^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/i.exec(u);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  m = /^https?:\/\/(?:www\.)?loom\.com\/share\/([\w-]+)/i.exec(u);
  if (m) return `https://www.loom.com/embed/${m[1]}`;
  if (/^https?:\/\/(?:www\.)?figma\.com\//i.test(u) && !/embed/.test(u)) {
    return `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(u)}`;
  }
  return u.replace(/^http:\/\//i, "https://");
}

function mediaKindForUrl(url: string): "video" | "audio" | null {
  if (/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(url)) return "video";
  if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)(\?|#|$)/i.test(url)) return "audio";
  return null;
}

// ── Component ────────────────────────────────────────────────────────────

export class IbDocEditor extends LitElement {
  static properties = {
    value: { type: String },
    mode: { type: String, reflect: true },
    readonly: { type: Boolean, reflect: true },
    placeholder: { type: String },
    linkTargets: { attribute: false },
    uploadImage: { attribute: false },
    _menu: { state: true },
    _prompt: { state: true },
    _notice: { state: true },
    _active: { state: true },
    _empty: { state: true },
  };

  value = "";
  mode: DocEditorMode = "rich";
  readonly = false;
  placeholder = "Start writing, or press '/' for commands…";
  linkTargets: DocLinkTarget[] = [];
  uploadImage?: (file: File) => Promise<string>;

  private _menu: MenuState | null = null;
  private _prompt: PromptState | null = null;
  private _notice = "";
  private _active: Set<string> = new Set();
  private _empty = true;

  /** Markdown last synced to/from `value` (or emitted). */
  private _md = "";
  private _dirty = false;
  private _changeTimer: ReturnType<typeof setTimeout> | null = null;
  private _noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private _undo: Snapshot[] = [];
  private _redo: Snapshot[] = [];
  private _burstTimer: ReturnType<typeof setTimeout> | null = null;
  private _savedRange: Range | null = null;
  private _renderedOnce = false;
  private _onSelectionChange = () => this._selectionChanged();

  // ── Lifecycle ──────────────────────────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("selectionchange", this._onSelectionChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("selectionchange", this._onSelectionChange);
    if (this._dirty) this._flushChange();
    if (this._changeTimer) clearTimeout(this._changeTimer);
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
  }

  protected firstUpdated(): void {
    this._md = this.value ?? "";
    this._renderContent();
    this._renderedOnce = true;
  }

  protected updated(changed: PropertyValues): void {
    if (!this._renderedOnce) return;
    if (changed.has("mode")) {
      const prev = changed.get("mode") as DocEditorMode | undefined;
      if (prev && prev !== this.mode) this._switchMode(prev, this.mode);
    }
    if (changed.has("value") && (this.value ?? "") !== this._md) {
      this.setValue(this.value ?? "");
    }
  }

  private get surface(): HTMLDivElement | null {
    return this.renderRoot?.querySelector(".surface") ?? null;
  }
  private get textarea(): HTMLTextAreaElement | null {
    return this.renderRoot?.querySelector("textarea.source") ?? null;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Current markdown (serialized from the active mode). */
  getMarkdown(): string {
    if (!this._renderedOnce) return this._md;
    if (this.mode === "source") return this.textarea?.value ?? this._md;
    const s = this.surface;
    return s ? editorHtmlToMarkdown(s) : this._md;
  }

  /**
   * Replace the content. Without `force`, a focused editor with pending
   * (un-emitted) edits keeps its content and this returns false.
   */
  setValue(md: string, opts: { force?: boolean } = {}): boolean {
    const next = md ?? "";
    if (!opts.force && this._dirty && this._hasFocus()) return false;
    if (this._changeTimer) clearTimeout(this._changeTimer);
    this._changeTimer = null;
    this._dirty = false;
    this._md = next;
    this.value = next;
    if (this._renderedOnce) {
      this._renderContent();
      this._undo = [];
      this._redo = [];
    }
    return true;
  }

  override focus(options?: FocusOptions): void {
    if (this.mode === "source") this.textarea?.focus(options);
    else this.surface?.focus(options);
  }

  /** Insert markdown at the caret (or at the end when there is no caret). */
  insertMarkdown(md: string): void {
    if (this.readonly) return;
    if (this.mode === "source") {
      const ta = this.textarea;
      if (!ta) return;
      ta.setRangeText(md, ta.selectionStart, ta.selectionEnd, "end");
      this._onSourceInput();
      return;
    }
    const s = this.surface;
    if (!s) return;
    if (!this._getRange()) this._placeCaretAtEnd(s);
    this._checkpoint();
    this._insertHtml(markdownToEditorHtml(md));
    this._markDirty();
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  private _renderContent(): void {
    if (this.mode === "source") {
      const ta = this.textarea;
      if (ta) {
        ta.value = this._md;
        this._autosize();
      }
    } else {
      const s = this.surface;
      if (s) {
        s.innerHTML = markdownToEditorHtml(this._md) || "<p><br></p>";
        this._ensureTrailingParagraph();
        this._updateEmpty();
      }
    }
  }

  private _switchMode(from: DocEditorMode, to: DocEditorMode): void {
    if (from === "rich") {
      const s = this.surface;
      if (s) this._md = editorHtmlToMarkdown(s);
    } else {
      this._md = this.textarea?.value ?? this._md;
    }
    this._closeMenus();
    this._renderContent();
    if (this._dirty) this._scheduleChange();
  }

  private _setMode(m: DocEditorMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.dispatchEvent(new CustomEvent("doc-mode-change", { detail: { mode: m }, bubbles: true, composed: true }));
  }

  // ── Change tracking ────────────────────────────────────────────────────

  private _markDirty(): void {
    this._dirty = true;
    this._updateEmpty();
    this._scheduleChange();
  }

  private _scheduleChange(): void {
    if (this._changeTimer) clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => this._flushChange(), CHANGE_DEBOUNCE_MS);
  }

  private _flushChange(): void {
    if (this._changeTimer) clearTimeout(this._changeTimer);
    this._changeTimer = null;
    const md = this.getMarkdown();
    this._dirty = false;
    if (md === this._md) return;
    this._md = md;
    this.value = md;
    this.dispatchEvent(new CustomEvent("doc-change", { detail: { markdown: md }, bubbles: true, composed: true }));
  }

  private _save(): void {
    this._flushChange();
    this.dispatchEvent(new CustomEvent("doc-save", { detail: { markdown: this._md }, bubbles: true, composed: true }));
  }

  private _hasFocus(): boolean {
    const active = this.shadowRoot?.activeElement;
    return !!active && (active === this.surface || active === this.textarea || this.surface?.contains(active) === true);
  }

  private _updateEmpty(): void {
    const s = this.surface;
    if (!s) return;
    const empty =
      textOf(s).trim() === "" &&
      !s.querySelector("img,hr,figure,table,pre,[data-math-block],li,details,[data-callout],h1,h2,h3,blockquote");
    if (empty !== this._empty) this._empty = empty;
  }

  private _notify(msg: string): void {
    this._notice = msg;
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => (this._notice = ""), 3800);
  }

  // ── Selection helpers ──────────────────────────────────────────────────

  private _getSelection(): Selection | null {
    const root = this.shadowRoot as unknown as { getSelection?: () => Selection | null } | null;
    if (root && typeof root.getSelection === "function") return root.getSelection();
    return document.getSelection();
  }

  private _getRange(): Range | null {
    const sel = this._getSelection();
    const s = this.surface;
    if (!sel || !sel.rangeCount || !s) return null;
    const r = sel.getRangeAt(0);
    return s.contains(r.startContainer) ? r : null;
  }

  private _setCaret(node: Node, offset: number): void {
    const sel = this._getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.setStart(node, Math.min(offset, node.nodeType === 3 ? (node as Text).length : node.childNodes.length));
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  private _placeCaretAtStart(el: Node): void {
    let n: Node = el;
    while (n.firstChild && !(isElement(n.firstChild) && n.firstChild.tagName === "BR")) n = n.firstChild;
    this._setCaret(n, 0);
  }

  private _placeCaretAtEnd(el: Node): void {
    const sel = this._getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  private _caretOffsetIn(container: Node): number {
    const r = this._getRange();
    if (!r) return 0;
    const pre = document.createRange();
    pre.selectNodeContents(container);
    try {
      pre.setEnd(r.startContainer, r.startOffset);
    } catch {
      return 0;
    }
    return pre.toString().length;
  }

  private _restoreCaretOffset(container: Node, offset: number): void {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode() as Text | null;
    let last: Text | null = null;
    while (node) {
      if (remaining <= node.length) {
        this._setCaret(node, remaining);
        return;
      }
      remaining -= node.length;
      last = node;
      node = walker.nextNode() as Text | null;
    }
    if (last) this._setCaret(last, last.length);
    else this._placeCaretAtStart(container);
  }

  /** Nearest block-ish element around the caret (inside the surface). */
  private _currentBlock(): HTMLElement | null {
    const r = this._getRange();
    const s = this.surface;
    if (!r || !s) return null;
    let n: Node | null = r.startContainer;
    if (n === s) {
      const child = s.childNodes[r.startOffset] ?? s.childNodes[r.startOffset - 1];
      return isElement(child) ? child : null;
    }
    while (n && n !== s) {
      if (isElement(n) && BLOCK_TAGS.has(n.tagName)) {
        if (n.tagName === "DIV" && (n.classList.contains("callout-body") || n.classList.contains("toggle-body") || n.hasAttribute("data-callout"))) {
          // containers are not blocks
        } else if (n.tagName === "BLOCKQUOTE" && Array.from(n.children).some((c) => BLOCK_TAGS.has(c.tagName))) {
          // quote with block children: keep walking only if we came from a block
        } else return n;
      }
      n = n.parentNode;
    }
    return null;
  }

  /** Top-level unit inside the nearest flow container (for inserting blocks after). */
  private _flowChild(block: HTMLElement): HTMLElement {
    let n: HTMLElement = block;
    while (n.parentElement && !n.parentElement.matches(FLOW_CONTAINER_SELECTOR)) n = n.parentElement;
    return n;
  }

  private _textBeforeCaret(block: HTMLElement): string {
    const r = this._getRange();
    if (!r) return "";
    const pre = document.createRange();
    pre.selectNodeContents(block);
    try {
      pre.setEnd(r.startContainer, r.startOffset);
    } catch {
      return "";
    }
    return pre.toString().replace(/ /g, " ").replace(/[​﻿]/g, "");
  }

  /** Delete `count` characters immediately before the caret inside `block`. */
  private _deleteBeforeCaret(block: HTMLElement, count: number): Range | null {
    const r = this._getRange();
    if (!r || count <= 0) return null;
    const end = this._caretOffsetIn(block);
    const start = Math.max(0, end - count);
    const range = document.createRange();
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let startSet = false;
    let node = walker.nextNode() as Text | null;
    while (node) {
      const len = node.length;
      if (!startSet && start <= pos + len) {
        range.setStart(node, start - pos);
        startSet = true;
      }
      if (startSet && end <= pos + len) {
        range.setEnd(node, end - pos);
        break;
      }
      pos += len;
      node = walker.nextNode() as Text | null;
    }
    if (!startSet) return null;
    range.deleteContents();
    range.collapse(true);
    const sel = this._getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range.cloneRange());
    // Return our own range: Chrome canonicalizes the live selection (e.g. moves
    // it before a now-trailing space), which would misplace inserted nodes.
    return range;
  }

  private _selectionChanged(): void {
    if (this.mode !== "rich" || this.readonly) return;
    const r = this._getRange();
    if (!r) return;
    const active = new Set<string>();
    try {
      for (const cmd of ["bold", "italic", "underline", "strikeThrough"]) {
        if (document.queryCommandState(cmd)) active.add(cmd);
      }
    } catch {
      /* queryCommandState unsupported */
    }
    let n: Node | null = r.startContainer;
    const s = this.surface;
    while (n && n !== s) {
      if (isElement(n)) {
        const t = n.tagName;
        if (t === "CODE" && n.parentElement?.tagName !== "PRE") active.add("code");
        if (t === "MARK") active.add("highlight");
        if (t === "A") active.add("link");
        if (/^H[1-3]$/.test(t)) active.add(t.toLowerCase());
        if (t === "LI") active.add(n.hasAttribute("data-checked") ? "todo" : n.parentElement?.tagName === "OL" ? "numbered" : "bullet");
        if (t === "BLOCKQUOTE") active.add("quote");
        if (n.hasAttribute("data-callout")) active.add("callout");
        if (t === "PRE") active.add("code-block");
        if (t === "DETAILS") active.add("toggle");
      }
      n = n.parentNode;
    }
    // Re-highlight a code block once the caret leaves it (never while typing in it).
    const curPre = (isElement(r.startContainer) ? r.startContainer : r.startContainer.parentElement)?.closest("pre[data-lang]") ?? null;
    if (this._editingPre && this._editingPre !== curPre && this._editingPre.isConnected) this._rehighlight(this._editingPre);
    this._editingPre = curPre as HTMLElement | null;
    const same = active.size === this._active.size && [...active].every((a) => this._active.has(a));
    if (!same) this._active = active;
    this._updateHint();
  }

  private _editingPre: HTMLElement | null = null;

  private _rehighlight(pre: HTMLElement): void {
    const code = pre.querySelector("code") ?? pre;
    const text = textOf(code).replace(/\n$/, "");
    const next = highlightCode(text, pre.getAttribute("data-lang") ?? "") + "\n";
    if (code.innerHTML !== next) code.innerHTML = next;
  }

  private _updateHint(): void {
    const s = this.surface;
    if (!s) return;
    s.querySelectorAll(".hint").forEach((h) => {
      h.classList.remove("hint");
      if (!h.classList.length) h.removeAttribute("class");
    });
    if (this._empty) return;
    const block = this._currentBlock();
    if (block && block.tagName === "P" && textOf(block).trim() === "" && !block.querySelector("img")) {
      block.classList.add("hint");
    }
  }

  // ── History (own stack: DOM surgery bypasses the native undo stack) ─────

  private _snapshot(): Snapshot {
    const s = this.surface!;
    return { html: s.innerHTML, caret: this._caretOffsetIn(s) };
  }

  private _checkpoint(): void {
    const s = this.surface;
    if (!s) return;
    const snap = this._snapshot();
    const top = this._undo[this._undo.length - 1];
    if (top && top.html === snap.html) return;
    this._undo.push(snap);
    if (this._undo.length > HISTORY_LIMIT) this._undo.shift();
    this._redo = [];
  }

  private _typingCheckpoint(): void {
    if (!this._burstTimer) this._checkpoint();
    if (this._burstTimer) clearTimeout(this._burstTimer);
    this._burstTimer = setTimeout(() => (this._burstTimer = null), 700);
  }

  private _restore(snap: Snapshot): void {
    const s = this.surface;
    if (!s) return;
    s.innerHTML = snap.html;
    s.focus();
    this._restoreCaretOffset(s, snap.caret);
    this._markDirty();
  }

  private _undoAction(): void {
    if (this.mode === "source") {
      document.execCommand("undo");
      return;
    }
    const prev = this._undo.pop();
    if (!prev) return;
    this._redo.push(this._snapshot());
    this._restore(prev);
  }

  private _redoAction(): void {
    if (this.mode === "source") {
      document.execCommand("redo");
      return;
    }
    const next = this._redo.pop();
    if (!next) return;
    this._undo.push(this._snapshot());
    this._restore(next);
  }

  // ── Surface events ─────────────────────────────────────────────────────

  private _onBeforeInput(e: InputEvent): void {
    if (this.readonly) {
      e.preventDefault();
      return;
    }
    if (e.inputType === "historyUndo") {
      e.preventDefault();
      this._undoAction();
      return;
    }
    if (e.inputType === "historyRedo") {
      e.preventDefault();
      this._redoAction();
      return;
    }
    this._typingCheckpoint();
  }

  private _onInput(e: InputEvent): void {
    if (this.readonly) return;
    const s = this.surface;
    if (!s) return;
    if (!s.firstChild) s.innerHTML = "<p><br></p>";
    if (e.inputType === "insertText" && e.data) this._handleShortcuts(e.data);
    if (e.inputType === "insertParagraph") {
      const block = this._currentBlock();
      if (block?.tagName === "LI" && block.hasAttribute("data-checked") && textOf(block).trim() === "") {
        block.setAttribute("data-checked", "false");
      }
    }
    this._updateMenusFromCaret();
    this._markDirty();
    this._updateHint();
  }

  private _handleShortcuts(data: string): void {
    const block = this._currentBlock();
    if (!block) return;
    const inPre = !!block.closest("pre, [data-math-block]");
    if (inPre) return;
    const before = this._textBeforeCaret(block);
    const plain = block.tagName === "P" || (block.tagName === "DIV" && !block.hasAttribute("data-math-block"));

    if (data === " " && block.tagName === "LI") {
      const task = /^\[( |x|X)?\] $/.exec(before);
      if (task) {
        this._checkpoint();
        this._deleteBeforeCaret(block, before.length);
        block.setAttribute("data-checked", task[1]?.toLowerCase() === "x" ? "true" : "false");
        return;
      }
    }
    if ("*`=~".includes(data) && this._inlineAutoformat()) return;
    if (!plain || block.closest("li, td, th, summary")) return;

    if (data === " ") {
      let m: RegExpExecArray | null;
      if ((m = /^(#{1,3}) $/.exec(before))) {
        this._checkpoint();
        this._deleteBeforeCaret(block, before.length);
        this._retag(block, `h${m[1]!.length}`);
      } else if (/^[-*+] $/.exec(before)) {
        this._checkpoint();
        this._deleteBeforeCaret(block, before.length);
        this._blockToList(block, "UL", null);
      } else if (/^1[.)] $/.exec(before)) {
        this._checkpoint();
        this._deleteBeforeCaret(block, before.length);
        this._blockToList(block, "OL", null);
      } else if ((m = /^(?:[-*+] )?\[( |x|X)?\] $/.exec(before))) {
        this._checkpoint();
        this._deleteBeforeCaret(block, before.length);
        this._blockToList(block, "UL", m[1]?.toLowerCase() === "x");
      } else if (/^> $/.exec(before)) {
        this._checkpoint();
        this._deleteBeforeCaret(block, before.length);
        this._wrapQuote(block);
      } else if ((m = /^```([\w+#.-]*) $/.exec(before))) {
        this._checkpoint();
        this._deleteBeforeCaret(block, before.length);
        this._blockToCode(block, m[1] ?? "");
      } else if (/^\$\$ $/.exec(before)) {
        this._checkpoint();
        this._deleteBeforeCaret(block, before.length);
        this._replaceBlockWith(block, mathBlockHtml(""), "[data-math-block]");
      }
    } else if (data === "-" && textOf(block) === "---" && before === "---") {
      this._checkpoint();
      this._replaceBlockWith(block, "<hr><p><br></p>", "p");
    }
  }

  /** `**b**`, `*i*`, `` `c` ``, `~~s~~`, `==m==` typed inline → formatted. */
  private _inlineAutoformat(): boolean {
    const r = this._getRange();
    if (!r || !r.collapsed || r.startContainer.nodeType !== 3) return false;
    const node = r.startContainer as Text;
    if (node.parentElement?.closest("code, pre, a, [data-math], [data-math-block]")) return false;
    const before = node.data.slice(0, r.startOffset);
    const rules: Array<[RegExp, string]> = [
      [/(?<![*\\])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, "strong"],
      [/(?<![*\\\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, "em"],
      [/(?<![`\\])`([^`]+)`$/, "code"],
      [/(?<![~\\])~~([^~\s](?:[^~]*[^~\s])?)~~$/, "del"],
      [/(?<![=\\])==([^=\s](?:[^=]*[^=\s])?)==$/, "mark"],
    ];
    for (const [re, tagName] of rules) {
      const m = re.exec(before);
      if (!m) continue;
      const start = r.startOffset - m[0].length;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, r.startOffset);
      range.deleteContents();
      const el = document.createElement(tagName);
      el.textContent = m[1]!;
      range.insertNode(el);
      // A zero-width spacer keeps further typing outside the new mark.
      const spacer = document.createTextNode("\u200b");
      el.after(spacer);
      this._setCaret(spacer, 1);
      return true;
    }
    return false;
  }

  private _onKeyDown(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === "s") {
      e.preventDefault();
      this._save();
      return;
    }
    if (this.readonly) return;

    if (this._menu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = this._menu.items.length;
        if (!n) return;
        const d = e.key === "ArrowDown" ? 1 : -1;
        this._menu = { ...this._menu, index: (this._menu.index + d + n) % n };
        this._scrollMenuItem();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const item = this._menu.items[this._menu.index];
        if (item) {
          e.preventDefault();
          this._chooseMenuItem(item);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this._menu = null;
        return;
      }
    }

    if (mod && !e.altKey) {
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        this._undoAction();
        return;
      }
      if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        this._redoAction();
        return;
      }
      if (key === "k") {
        e.preventDefault();
        this._command("link");
        return;
      }
      if (key === "e") {
        e.preventDefault();
        this._command("inline-code");
        return;
      }
      if (e.shiftKey && key === "h") {
        e.preventDefault();
        this._command("highlight");
        return;
      }
      if (e.shiftKey && (key === "x" || key === "s")) {
        e.preventDefault();
        this._command("strike");
        return;
      }
      if (key === "b" || key === "i" || key === "u") {
        e.preventDefault();
        this._command(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
        return;
      }
      if (e.shiftKey && (e.key === "7" || e.key === "&")) {
        e.preventDefault();
        this._command("numbered");
        return;
      }
      if (e.shiftKey && (e.key === "8" || e.key === "*")) {
        e.preventDefault();
        this._command("bullet");
        return;
      }
      if (e.shiftKey && (e.key === "9" || e.key === "(")) {
        e.preventDefault();
        this._command("todo");
        return;
      }
    }
    if (mod && e.altKey && /^[0-3]$/.test(e.key)) {
      e.preventDefault();
      this._command(e.key === "0" ? "p" : `h${e.key}`);
      return;
    }

    const block = this._currentBlock();
    if (e.key === "Tab") {
      const pre = block?.closest("pre, [data-math-block]");
      if (pre) {
        e.preventDefault();
        this._checkpoint();
        this._insertText("  ");
        this._markDirty();
        return;
      }
      const li = block?.closest("li");
      if (li) {
        e.preventDefault();
        this._checkpoint();
        if (e.shiftKey) this._outdent(li as HTMLLIElement);
        else this._indent(li as HTMLLIElement);
        this._markDirty();
        return;
      }
      const cell = block?.closest("td, th");
      if (cell) {
        e.preventDefault();
        this._moveCell(cell as HTMLTableCellElement, e.shiftKey ? -1 : 1);
        return;
      }
      return;
    }

    if (e.key === "Enter" && !e.isComposing) {
      if (!block) return;
      const pre = block.closest("pre, [data-math-block]") as HTMLElement | null;
      if (pre) {
        e.preventDefault();
        this._checkpoint();
        this._enterInPre(pre, e.shiftKey || mod);
        this._markDirty();
        return;
      }
      if (block.tagName === "SUMMARY") {
        e.preventDefault();
        const details = block.parentElement as HTMLDetailsElement;
        details.open = true;
        let body = details.querySelector(":scope > .toggle-body") as HTMLElement | null;
        if (!body) {
          body = document.createElement("div");
          body.className = "toggle-body";
          details.appendChild(body);
        }
        if (!body.firstElementChild) body.innerHTML = "<p><br></p>";
        this._placeCaretAtStart(body.firstElementChild!);
        return;
      }
      if (e.shiftKey) return; // soft line break (<br>) — default
      const before = this._textBeforeCaret(block);
      const fence = /^```([\w+#.-]*)$/.exec(before.trim());
      if (fence && (block.tagName === "P" || block.tagName === "DIV") && textOf(block).trim() === before.trim()) {
        e.preventDefault();
        this._checkpoint();
        this._deleteBeforeCaret(block, before.length);
        this._blockToCode(block, fence[1] ?? "");
        this._markDirty();
        return;
      }
      if (/^\$\$$/.test(before.trim()) && block.tagName === "P" && textOf(block).trim() === "$$") {
        e.preventDefault();
        this._checkpoint();
        this._replaceBlockWith(block, mathBlockHtml(""), "[data-math-block]");
        this._markDirty();
        return;
      }
      if (block.tagName === "LI" && textOf(block).trim() === "" && !block.querySelector("img, ul, ol")) {
        e.preventDefault();
        this._checkpoint();
        this._outdent(block as HTMLLIElement);
        this._markDirty();
        return;
      }
      // Exit a callout / toggle / quote on Enter in its last, empty paragraph.
      if (block.tagName === "P" && textOf(block).trim() === "" && !block.querySelector("img") && !block.nextElementSibling) {
        const container = block.parentElement;
        const wrapper = container?.matches(".callout-body")
          ? container.closest("[data-callout]")
          : container?.matches(".toggle-body")
            ? container.closest("details")
            : container?.tagName === "BLOCKQUOTE"
              ? container
              : null;
        if (wrapper && container && container.children.length > 1) {
          e.preventDefault();
          this._checkpoint();
          block.remove();
          const p = document.createElement("p");
          p.innerHTML = "<br>";
          wrapper.after(p);
          this._placeCaretAtStart(p);
          this._markDirty();
          return;
        }
      }
      return;
    }

    if (e.key === "Backspace" && block) {
      // Backspace at the start of an empty heading/quote paragraph → plain paragraph.
      const before = this._textBeforeCaret(block);
      if (before === "" && this._getRange()?.collapsed) {
        if (/^H[1-6]$/.test(block.tagName)) {
          e.preventDefault();
          this._checkpoint();
          this._retag(block, "p");
          this._markDirty();
          return;
        }
        if (block.tagName === "LI" && !block.previousElementSibling && !block.parentElement?.closest("li")) {
          e.preventDefault();
          this._checkpoint();
          this._outdent(block as HTMLLIElement);
          this._markDirty();
          return;
        }
      }
    }
  }

  private _onSurfaceMouseDown(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (this.readonly) return;
    // Checklist box: left gutter of a task item.
    const li = target.closest?.("li[data-checked]") as HTMLElement | null;
    if (li && target === li) {
      const rect = li.getBoundingClientRect();
      if (e.clientX - rect.left < 24) {
        e.preventDefault();
        this._checkpoint();
        li.setAttribute("data-checked", li.getAttribute("data-checked") === "true" ? "false" : "true");
        this._markDirty();
        return;
      }
    }
    const summary = target.closest?.("summary");
    if (summary && target === summary) {
      const rect = summary.getBoundingClientRect();
      if (e.clientX - rect.left < 24) {
        e.preventDefault();
        const d = summary.parentElement as HTMLDetailsElement;
        d.open = !d.open; // view state only — not a content change
      }
    }
  }

  private _onSurfaceClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const summary = target.closest?.("summary");
    if (summary && !this.readonly) {
      // Keep the native toggle from firing while the user edits the title.
      e.preventDefault();
    }
    const remove = target.closest?.("[data-action='remove']");
    if (remove && !this.readonly) {
      e.preventDefault();
      const fig = remove.closest("figure");
      if (fig) {
        this._checkpoint();
        fig.remove();
        this._ensureTrailingParagraph();
        this._markDirty();
      }
      return;
    }
    const label = target.closest?.(".callout-label");
    if (label && !this.readonly) {
      const callout = label.closest("[data-callout]") as HTMLElement | null;
      if (callout) {
        this._checkpoint();
        const kinds = CALLOUT_KINDS as readonly string[];
        const cur = kinds.indexOf((callout.getAttribute("data-callout") ?? "NOTE").toUpperCase());
        const next = kinds[(cur + 1) % kinds.length]!;
        callout.setAttribute("data-callout", next);
        label.textContent = calloutLabel(next);
        this._markDirty();
      }
      return;
    }
    const pre = target.closest?.("pre[data-lang]") as HTMLElement | null;
    if (pre && !this.readonly && target === pre) {
      const rect = pre.getBoundingClientRect();
      if (e.clientY - rect.top < 26 && rect.right - e.clientX < 130) {
        this._openPrompt("lang", pre);
        return;
      }
    }
    const a = target.closest?.("a") as HTMLAnchorElement | null;
    if (a) {
      const mod = e.metaKey || e.ctrlKey;
      e.preventDefault();
      if (!mod && !this.readonly) return;
      const wiki = a.getAttribute("data-wiki");
      const href = a.getAttribute("href") ?? "";
      let detail: DocOpenLinkDetail | null = null;
      if (wiki != null) detail = { target: wiki, kind: "wiki" };
      else if (/^doc:/i.test(href)) detail = { target: href.slice(4), kind: "doc" };
      else if (href) detail = { target: href, kind: "url" };
      if (!detail) return;
      const ev = new CustomEvent<DocOpenLinkDetail>("doc-open-link", { detail, bubbles: true, composed: true, cancelable: true });
      const notCancelled = this.dispatchEvent(ev);
      if (notCancelled && detail.kind === "url" && /^(https?:|mailto:)/i.test(detail.target)) {
        window.open(detail.target, "_blank", "noopener,noreferrer");
      }
    }
  }

  private _onPaste(e: ClipboardEvent): void {
    if (this.readonly) {
      e.preventDefault();
      return;
    }
    const dt = e.clipboardData;
    if (!dt) return;
    const files = Array.from(dt.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void this._handleImageFiles(files);
      return;
    }
    const block = this._currentBlock();
    const text = dt.getData("text/plain");
    if (block?.closest("pre, [data-math-block], code, [data-math]")) {
      e.preventDefault();
      this._checkpoint();
      this._insertText(text);
      this._markDirty();
      return;
    }
    const htmlData = dt.getData("text/html");
    let md: string | null = null;
    if (htmlData && htmlData.trim()) {
      const clean = sanitizeEditorHtml(htmlData, { allowStyle: true });
      md = htmlStringToMarkdown(clean, document);
      // Plain-text markdown copied from an editor often arrives wrapped in HTML.
      if (text && looksLikeMarkdown(text) && !/<(h[1-6]|ul|ol|table|strong|b|em|i|pre|blockquote)\b/i.test(clean)) md = text;
    } else if (text) {
      md = looksLikeMarkdown(text) ? text : null;
    }
    e.preventDefault();
    this._checkpoint();
    if (md == null) {
      if (text.includes("\n")) {
        const paras = text
          .split(/\n{2,}/)
          .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
          .join("");
        this._insertHtml(paras);
      } else this._insertText(text);
    } else {
      this._insertHtml(markdownToEditorHtml(md));
    }
    this._markDirty();
  }

  private _onDrop(e: DragEvent): void {
    if (this.readonly) return;
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const r = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (r && this.surface?.contains(r.startContainer)) {
      const sel = this._getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
    void this._handleImageFiles(files);
  }

  private async _handleImageFiles(files: File[]): Promise<void> {
    for (const file of files) {
      let url: string | null = null;
      if (this.uploadImage) {
        try {
          url = await this.uploadImage(file);
        } catch (err) {
          this._notify(`Image upload failed: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      } else if (file.size < MAX_INLINE_IMAGE_BYTES) {
        url = await new Promise<string | null>((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(file);
        });
      } else {
        this._notify(`“${file.name}” is larger than 200 KB — no uploader is connected, so it can't be embedded.`);
        continue;
      }
      if (!url) continue;
      this._insertImage(url, file.name.replace(/\.[a-z0-9]+$/i, ""));
    }
  }

  private _insertImage(url: string, alt: string): void {
    if (!this._getRange() && this.surface) this._placeCaretAtEnd(this.surface);
    this._checkpoint();
    const safeAlt = alt.replace(/[\[\]\\]/g, "");
    const md = `![${safeAlt}](${/[\s()]/.test(url) ? `<${url}>` : url})`;
    this._insertHtml(markdownToEditorHtml(md));
    this._markDirty();
  }

  // ── Insertion primitives ───────────────────────────────────────────────

  private _insertText(text: string): void {
    const r = this._getRange();
    if (!r) return;
    r.deleteContents();
    const t = document.createTextNode(text);
    r.insertNode(t);
    this._setCaret(t, t.length);
  }

  /** Insert editor HTML at the caret: inline when it is a single paragraph, else as blocks. */
  private _insertHtml(htmlStr: string): void {
    const s = this.surface;
    if (!s || !htmlStr) return;
    let r = this._getRange();
    if (!r) {
      this._placeCaretAtEnd(s);
      r = this._getRange();
      if (!r) return;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = htmlStr;
    const nodes = Array.from(tpl.content.childNodes).filter((n) => !(n.nodeType === 3 && !n.textContent?.trim()));
    if (!nodes.length) return;
    r.deleteContents();
    const block = this._currentBlock();
    const inlineOk = nodes.length === 1 && isElement(nodes[0]) && nodes[0].tagName === "P" && block && !block.closest("pre");
    if (inlineOk) {
      const frag = document.createDocumentFragment();
      const children = Array.from((nodes[0] as HTMLElement).childNodes);
      children.forEach((c) => frag.appendChild(c));
      const last = children[children.length - 1];
      r.insertNode(frag);
      if (last) {
        const after = document.createRange();
        after.setStartAfter(last);
        after.collapse(true);
        const sel = this._getSelection();
        sel?.removeAllRanges();
        sel?.addRange(after);
      }
      return;
    }
    const anchor = block ? this._flowChild(block) : null;
    const frag = document.createDocumentFragment();
    nodes.forEach((n) => frag.appendChild(n));
    const lastNode = nodes[nodes.length - 1]!;
    if (!anchor || anchor === s) {
      s.appendChild(frag);
    } else if (textOf(anchor).trim() === "" && !anchor.querySelector("img,hr,figure,table,iframe")) {
      anchor.replaceWith(frag);
    } else {
      anchor.after(frag);
    }
    this._ensureTrailingParagraph();
    if (isElement(lastNode) && lastNode.matches("figure, hr, table")) {
      const next = lastNode.nextElementSibling;
      if (next) this._placeCaretAtStart(next);
    } else this._placeCaretAtEnd(lastNode);
  }

  private _replaceBlockWith(block: HTMLElement, htmlStr: string, focusSelector: string): void {
    const tpl = document.createElement("template");
    tpl.innerHTML = htmlStr;
    const nodes = Array.from(tpl.content.childNodes);
    const first = nodes[0];
    block.replaceWith(...nodes);
    this._ensureTrailingParagraph();
    const focusEl = nodes
      .map((n) => (isElement(n) ? (n.matches(focusSelector) ? n : n.querySelector(focusSelector)) : null))
      .find(Boolean) as HTMLElement | undefined;
    if (focusEl) this._placeCaretAtStart(focusEl);
    else if (first) this._placeCaretAtEnd(first);
  }

  /** Insert block HTML after the current block (or replace it when empty). */
  private _insertBlock(htmlStr: string, focusSelector: string): void {
    const s = this.surface;
    if (!s) return;
    let block = this._currentBlock();
    if (!block) {
      this._placeCaretAtEnd(s);
      block = this._currentBlock();
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = htmlStr;
    const nodes = Array.from(tpl.content.childNodes);
    if (!block) {
      nodes.forEach((n) => s.appendChild(n));
    } else {
      const anchor = this._flowChild(block);
      const emptyP = anchor.tagName === "P" && textOf(anchor).trim() === "" && !anchor.querySelector("img");
      if (emptyP) anchor.replaceWith(...nodes);
      else anchor.after(...nodes);
    }
    this._ensureTrailingParagraph();
    const focusEl = nodes
      .map((n) => (isElement(n) ? (n.matches(focusSelector) ? n : n.querySelector(focusSelector)) : null))
      .find(Boolean) as HTMLElement | undefined;
    if (focusEl) this._placeCaretAtStart(focusEl);
    else {
      const last = nodes[nodes.length - 1];
      const next = isElement(last) ? last.nextElementSibling : null;
      if (next) this._placeCaretAtStart(next);
    }
  }

  private _ensureTrailingParagraph(): void {
    const s = this.surface;
    if (!s || this.readonly) return;
    const last = s.lastElementChild;
    if (!last || last.matches("figure, hr, table, pre, details, [data-callout], [data-math-block], ul, ol, blockquote")) {
      const p = document.createElement("p");
      p.innerHTML = "<br>";
      s.appendChild(p);
    }
  }

  // ── Block transforms ───────────────────────────────────────────────────

  private _retag(block: HTMLElement, tagName: string): HTMLElement {
    const el = document.createElement(tagName);
    while (block.firstChild) el.appendChild(block.firstChild);
    fillable(el);
    block.replaceWith(el);
    this._placeCaretAtStart(el);
    return el;
  }

  private _blockToList(block: HTMLElement, listTag: "UL" | "OL", checked: boolean | null): void {
    const li = document.createElement("li");
    if (checked != null) li.setAttribute("data-checked", checked ? "true" : "false");
    while (block.firstChild) li.appendChild(block.firstChild);
    fillable(li);
    const prev = block.previousElementSibling;
    if (prev && prev.tagName === listTag) {
      prev.appendChild(li);
      block.remove();
    } else {
      const list = document.createElement(listTag);
      list.appendChild(li);
      block.replaceWith(list);
    }
    this._placeCaretAtStart(li);
  }

  private _blockToCode(block: HTMLElement, lang: string): void {
    const text = textOf(block).replace(/^```[\w+#.-]*/, "");
    this._replaceBlockWith(block, codeBlockHtml(text, lang), "code");
  }

  private _wrapQuote(block: HTMLElement): void {
    const q = document.createElement("blockquote");
    const p = document.createElement("p");
    while (block.firstChild) p.appendChild(block.firstChild);
    fillable(p);
    q.appendChild(p);
    block.replaceWith(q);
    this._placeCaretAtStart(p);
  }

  private _listToParagraph(li: HTMLElement): HTMLElement {
    const list = li.parentElement!;
    const p = document.createElement("p");
    const nested: Element[] = [];
    Array.from(li.childNodes).forEach((c) => {
      if (isElement(c) && (c.tagName === "UL" || c.tagName === "OL")) nested.push(c);
      else p.appendChild(c);
    });
    fillable(p);
    // Split the list around the item.
    const after = Array.from(list.children).slice(Array.from(list.children).indexOf(li) + 1);
    let tail: HTMLElement | null = null;
    if (after.length) {
      tail = document.createElement(list.tagName);
      after.forEach((a) => tail!.appendChild(a));
    }
    li.remove();
    list.after(p);
    let cursor: Element = p;
    nested.forEach((n) => {
      cursor.after(n);
      cursor = n;
    });
    if (tail) cursor.after(tail);
    if (!list.children.length) list.remove();
    return p;
  }

  private _indent(li: HTMLLIElement): void {
    const prev = li.previousElementSibling as HTMLElement | null;
    if (!prev || prev.tagName !== "LI") return;
    const offset = this._caretOffsetIn(li);
    const parentTag = li.parentElement!.tagName;
    let sub = Array.from(prev.children).reverse().find((c) => c.tagName === "UL" || c.tagName === "OL") as HTMLElement | undefined;
    if (!sub) {
      sub = document.createElement(parentTag);
      prev.appendChild(sub);
    }
    sub.appendChild(li);
    this._restoreCaretOffset(li, offset);
  }

  private _outdent(li: HTMLLIElement): void {
    const list = li.parentElement;
    if (!list) return;
    const parentLi = list.parentElement?.closest("li");
    const offset = this._caretOffsetIn(li);
    if (!parentLi || !list.parentElement || list.parentElement !== parentLi) {
      const p = this._listToParagraph(li);
      this._restoreCaretOffset(p, offset);
      return;
    }
    const followers = Array.from(list.children).slice(Array.from(list.children).indexOf(li) + 1);
    if (followers.length) {
      let sub = Array.from(li.children).find((c) => c.tagName === "UL" || c.tagName === "OL") as HTMLElement | undefined;
      if (!sub) {
        sub = document.createElement(list.tagName);
        li.appendChild(sub);
      }
      followers.forEach((f) => sub!.appendChild(f));
    }
    parentLi.after(li);
    if (!list.children.length) list.remove();
    this._restoreCaretOffset(li, offset);
  }

  private _enterInPre(pre: HTMLElement, forceExit: boolean): void {
    const before = this._textBeforeCaret(pre);
    const full = textOf(pre);
    const atEnd = before.length >= full.replace(/\n$/, "").length;
    if (forceExit || (atEnd && before.endsWith("\n") && before.length > 0)) {
      // Leave the block: drop the trailing empty line and continue below.
      if (!forceExit) this._deleteBeforeCaret(pre, 1);
      const next = pre.nextElementSibling;
      if (next && next.tagName === "P") this._placeCaretAtStart(next);
      else {
        const p = document.createElement("p");
        p.innerHTML = "<br>";
        pre.after(p);
        this._placeCaretAtStart(p);
      }
      return;
    }
    const r = this._getRange();
    if (!r) return;
    r.deleteContents();
    // Chrome won't render a trailing newline in <pre> without a sentinel "\n".
    const needsSentinel = pre.tagName === "PRE" && before.length >= full.replace(/\n$/, "").length;
    const t = document.createTextNode(needsSentinel && !full.endsWith("\n") ? "\n\n" : "\n");
    r.insertNode(t);
    this._setCaret(t, 1);
  }

  private _moveCell(cell: HTMLTableCellElement, dir: 1 | -1): void {
    const table = cell.closest("table");
    if (!table) return;
    const cells = Array.from(table.querySelectorAll("th, td")) as HTMLElement[];
    const i = cells.indexOf(cell);
    let next = cells[i + dir];
    if (!next && dir === 1) {
      this._checkpoint();
      this._tableOp("row-below", cell);
      const again = Array.from(table.querySelectorAll("th, td")) as HTMLElement[];
      next = again[i + 1];
      this._markDirty();
    }
    if (next) {
      const r = document.createRange();
      r.selectNodeContents(next);
      const sel = this._getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  }

  private _tableOp(op: string, cell: HTMLTableCellElement | null): void {
    if (!cell) {
      this._notify("Place the caret inside a table cell first.");
      return;
    }
    const row = cell.parentElement as HTMLTableRowElement;
    const table = cell.closest("table")!;
    const col = Array.from(row.children).indexOf(cell);
    const rows = Array.from(table.querySelectorAll("tr")) as HTMLTableRowElement[];
    if (op === "row-below") {
      const tr = document.createElement("tr");
      for (let i = 0; i < row.children.length; i++) {
        const td = document.createElement("td");
        td.innerHTML = "<br>";
        tr.appendChild(td);
      }
      if (row.parentElement?.tagName === "THEAD") {
        let tbody = table.querySelector("tbody");
        if (!tbody) {
          tbody = document.createElement("tbody");
          table.appendChild(tbody);
        }
        tbody.prepend(tr);
      } else row.after(tr);
      this._placeCaretAtStart(tr.firstElementChild!);
    } else if (op === "col-right") {
      for (const r of rows) {
        const ref = r.children[col];
        const c = document.createElement(r.parentElement?.tagName === "THEAD" ? "th" : "td");
        c.innerHTML = "<br>";
        if (ref) ref.after(c);
        else r.appendChild(c);
      }
    } else if (op === "row-delete") {
      if (row.parentElement?.tagName === "THEAD" || rows.length <= 1) {
        this._notify("The header row can't be deleted.");
        return;
      }
      row.remove();
    } else if (op === "col-delete") {
      if (row.children.length <= 1) {
        table.remove();
        this._ensureTrailingParagraph();
        return;
      }
      for (const r of rows) r.children[col]?.remove();
    }
  }

  // ── Inline formatting ──────────────────────────────────────────────────

  private _toggleInline(tagName: "code" | "mark" | "span-math"): void {
    const r = this._getRange();
    if (!r) return;
    const match = (n: Node | null): HTMLElement | null => {
      let cur: Node | null = n;
      while (cur && cur !== this.surface) {
        if (isElement(cur)) {
          if (tagName === "span-math" && cur.hasAttribute("data-math")) return cur;
          if (tagName !== "span-math" && cur.tagName === tagName.toUpperCase() && cur.parentElement?.tagName !== "PRE") return cur;
        }
        cur = cur.parentNode;
      }
      return null;
    };
    const existing = match(r.startContainer);
    if (existing && (r.collapsed || existing.contains(r.endContainer))) {
      const parent = existing.parentNode!;
      const first = existing.firstChild;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      existing.remove();
      if (first) this._setCaret(first, 0);
      return;
    }
    let el: HTMLElement;
    if (tagName === "span-math") {
      const tpl = document.createElement("template");
      tpl.innerHTML = inlineMathHtml(r.toString() || "x");
      el = tpl.content.firstElementChild as HTMLElement;
      r.deleteContents();
    } else {
      el = document.createElement(tagName);
      if (r.collapsed) el.textContent = "​";
      else el.appendChild(tagName === "code" ? document.createTextNode(r.toString()) : r.extractContents());
      if (tagName === "code") r.deleteContents();
    }
    r.insertNode(el);
    const sel = this._getSelection();
    const nr = document.createRange();
    nr.selectNodeContents(el);
    if (el.textContent === "​") nr.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(nr);
  }

  // ── Commands ───────────────────────────────────────────────────────────

  private _command(id: string): void {
    if (this.readonly) return;
    if (this.mode === "source") {
      this._sourceCommand(id);
      return;
    }
    const s = this.surface;
    if (!s) return;
    if (!this._getRange()) {
      s.focus();
      if (!this._getRange()) this._placeCaretAtEnd(s);
    }
    if (id === "undo") return this._undoAction();
    if (id === "redo") return this._redoAction();
    if (id === "link" || id === "embed" || id === "image" || id === "video") {
      this._openPrompt(id);
      return;
    }
    this._checkpoint();
    const block = this._currentBlock();
    const cell = (block?.closest("td, th") as HTMLTableCellElement | null) ?? null;
    switch (id) {
      case "bold":
      case "italic":
      case "underline":
        document.execCommand("styleWithCSS", false, "false");
        document.execCommand(id);
        break;
      case "strike":
        document.execCommand("styleWithCSS", false, "false");
        document.execCommand("strikeThrough");
        break;
      case "inline-code":
        this._toggleInline("code");
        break;
      case "highlight":
        this._toggleInline("mark");
        break;
      case "inline-math":
        this._toggleInline("span-math");
        break;
      case "p":
      case "h1":
      case "h2":
      case "h3": {
        if (!block) break;
        const target = id === "p" ? "p" : id;
        if (block.tagName === "LI") {
          const p = this._listToParagraph(block);
          if (target !== "p") this._retag(p, target);
          else this._placeCaretAtStart(p);
        } else if (block.tagName.toLowerCase() === target && target !== "p") this._retag(block, "p");
        else if (/^(P|H[1-6]|DIV)$/.test(block.tagName) && !block.matches(".callout-body, .toggle-body, [data-math-block]")) {
          this._retag(block, target);
        }
        break;
      }
      case "bullet":
      case "numbered":
      case "todo": {
        if (!block) break;
        const listTag = id === "numbered" ? "OL" : "UL";
        if (block.tagName === "LI") {
          const list = block.parentElement!;
          const isTask = block.hasAttribute("data-checked");
          const same = list.tagName === listTag && (id === "todo" ? isTask : !isTask);
          if (same) {
            this._listToParagraph(block);
          } else if (id === "todo" || isTask) {
            if (id === "todo") block.setAttribute("data-checked", "false");
            else block.removeAttribute("data-checked");
            if (list.tagName !== listTag) this._swapListTag(list, listTag);
          } else {
            this._swapListTag(list, listTag);
          }
        } else if (/^(P|H[1-6]|DIV)$/.test(block.tagName)) {
          this._blockToList(block, listTag, id === "todo" ? false : null);
        }
        break;
      }
      case "quote": {
        if (!block) break;
        const q = block.closest("blockquote");
        if (q) {
          const offset = this._caretOffsetIn(q);
          const kids = Array.from(q.childNodes);
          const first = kids[0];
          q.replaceWith(...kids);
          if (first) this._restoreCaretOffset(first.parentNode ?? s, offset);
        } else if (block.tagName !== "LI") this._wrapQuote(block);
        break;
      }
      case "code": {
        if (block && block.tagName === "P" && textOf(block).trim()) this._blockToCode(block, "");
        else this._insertBlock(codeBlockHtml("", ""), "code");
        break;
      }
      case "math":
        this._insertBlock(mathBlockHtml(""), "[data-math-block]");
        break;
      case "divider":
        this._insertBlock("<hr>", "__none__");
        break;
      case "toggle":
        this._insertBlock(toggleHtml("", "<p><br></p>", true), "summary");
        break;
      case "table":
        this._insertBlock(
          "<table><thead><tr><th><br></th><th><br></th><th><br></th></tr></thead><tbody><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table>",
          "th",
        );
        break;
      case "wiki":
        this._insertText("[[");
        this._updateMenusFromCaret();
        break;
      case "row-below":
      case "col-right":
      case "row-delete":
      case "col-delete":
        this._tableOp(id, cell);
        break;
      default:
        if (id.startsWith("callout-")) {
          const kind = id.slice(8);
          if (block && block.tagName === "P" && textOf(block).trim()) {
            const body = block.outerHTML;
            this._replaceBlockWith(block, calloutHtml(kind, body), ".callout-body > p");
          } else this._insertBlock(calloutHtml(kind, "<p><br></p>"), ".callout-body > p");
        }
    }
    this._markDirty();
    this._selectionChanged();
  }

  private _swapListTag(list: HTMLElement, listTag: string): void {
    const n = document.createElement(listTag);
    const offset = this._caretOffsetIn(list);
    while (list.firstChild) n.appendChild(list.firstChild);
    list.replaceWith(n);
    this._restoreCaretOffset(n, offset);
  }

  /** Toolbar in Markdown mode: wrap/prefix the textarea selection. */
  private _sourceCommand(id: string): void {
    const ta = this.textarea;
    if (!ta) return;
    if (id === "undo" || id === "redo") {
      ta.focus();
      document.execCommand(id);
      return;
    }
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const sel = value.slice(a, b);
    const wrapIt = (l: string, r = l) => ta.setRangeText(`${l}${sel || "text"}${r}`, a, b, "select");
    const lineStart = value.lastIndexOf("\n", a - 1) + 1;
    const prefix = (p: string) => ta.setRangeText(p, lineStart, lineStart, "end");
    const block = (s: string) => ta.setRangeText(`${a > 0 && value[a - 1] !== "\n" ? "\n\n" : ""}${s}\n`, a, b, "end");
    switch (id) {
      case "bold": wrapIt("**"); break;
      case "italic": wrapIt("*"); break;
      case "underline": wrapIt("<u>", "</u>"); break;
      case "strike": wrapIt("~~"); break;
      case "inline-code": wrapIt("`"); break;
      case "highlight": wrapIt("=="); break;
      case "inline-math": wrapIt("$"); break;
      case "link": wrapIt("[", "](https://)"); break;
      case "h1": prefix("# "); break;
      case "h2": prefix("## "); break;
      case "h3": prefix("### "); break;
      case "bullet": prefix("- "); break;
      case "numbered": prefix("1. "); break;
      case "todo": prefix("- [ ] "); break;
      case "quote": prefix("> "); break;
      case "code": block("```\n" + (sel || "") + "\n```"); break;
      case "math": block("$$\n" + (sel || "") + "\n$$"); break;
      case "divider": block("---"); break;
      case "toggle": block("<details><summary>Toggle</summary>\n\n" + (sel || "Content") + "\n\n</details>"); break;
      case "table": block("| Column | Column |\n| --- | --- |\n| | |"); break;
      case "image": wrapIt("![", "](https://)"); break;
      case "embed": block('<iframe src="https://"></iframe>'); break;
      case "video": block('<video src="https://" controls></video>'); break;
      default:
        if (id.startsWith("callout-")) block(`> [!${id.slice(8)}]\n> ${sel || ""}`);
    }
    ta.focus();
    this._onSourceInput();
  }

  // ── Prompt popover (link / embed / image / code language) ──────────────

  private _langTarget: HTMLElement | null = null;

  private _openPrompt(kind: PromptState["kind"], langTarget?: HTMLElement): void {
    const r = this._getRange();
    this._savedRange = r ? r.cloneRange() : null;
    const pos = this._anchorPoint(r, langTarget);
    let value = "";
    if (kind === "link" && r) {
      const a = (r.startContainer.parentElement ?? null)?.closest("a");
      value = a?.getAttribute("data-wiki") != null ? `[[${a.getAttribute("data-wiki")}]]` : (a?.getAttribute("href") ?? "");
    }
    if (kind === "lang" && langTarget) {
      value = langTarget.getAttribute("data-lang") ?? "";
      this._langTarget = langTarget;
    }
    const meta: Record<PromptState["kind"], [string, string]> = {
      link: ["Link", "https://…, doc:<id> or [[Doc title]] — empty removes"],
      embed: ["Embed URL", "https://www.youtube.com/watch?v=…"],
      image: ["Image URL", "https://…/image.png"],
      video: ["Video / audio URL", "https://…/clip.mp4"],
      lang: ["Code language", "ts, py, bash, sql…"],
    };
    this._prompt = { kind, label: meta[kind][0], placeholder: meta[kind][1], value, x: pos.x, y: pos.y };
    void this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector<HTMLInputElement>(".prompt input[type=text]");
      input?.focus();
      input?.select();
    });
  }

  private _anchorPoint(r: Range | null, el?: HTMLElement): { x: number; y: number } {
    const host = this.getBoundingClientRect();
    let rect: DOMRect | null = null;
    if (el) rect = el.getBoundingClientRect();
    else if (r) {
      rect = r.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        const node = isElement(r.startContainer) ? r.startContainer : r.startContainer.parentElement;
        rect = node?.getBoundingClientRect() ?? null;
      }
    }
    if (!rect) return { x: 24, y: 64 };
    const x = Math.max(8, Math.min(rect.left - host.left, host.width - 300));
    return { x, y: rect.bottom - host.top + 6 };
  }

  private _restoreSavedRange(): void {
    const s = this.surface;
    if (!s) return;
    s.focus();
    if (this._savedRange) {
      const sel = this._getSelection();
      sel?.removeAllRanges();
      sel?.addRange(this._savedRange);
    }
  }

  private _applyPrompt(value: string): void {
    const p = this._prompt;
    this._prompt = null;
    if (!p) return;
    const v = value.trim();
    if (p.kind === "lang") {
      const pre = this._langTarget;
      this._langTarget = null;
      if (pre) {
        this._checkpoint();
        const code = pre.querySelector("code") ?? pre;
        const text = textOf(code).replace(/\n$/, "");
        pre.setAttribute("data-lang", v);
        code.innerHTML = highlightCode(text, v) + "\n";
        this._markDirty();
      }
      return;
    }
    this._restoreSavedRange();
    if (!v && p.kind !== "link") return;
    this._checkpoint();
    if (p.kind === "link") this._applyLink(v);
    else if (p.kind === "image") this._insertImage(v, "");
    else if (p.kind === "embed" || p.kind === "video") {
      const media = mediaKindForUrl(v);
      if (media || p.kind === "video") {
        this._insertBlock(mediaHtml(media ?? "video", v), "__none__");
      } else {
        const url = normalizeEmbedUrl(/^[a-z]+:/i.test(v) ? v : `https://${v}`);
        if (!/^https:\/\//i.test(url)) {
          this._notify("Embeds must use an https:// URL.");
          return;
        }
        this._insertBlock(embedHtml(url), "__none__");
      }
    }
    this._markDirty();
  }

  private _applyLink(v: string): void {
    const r = this._getRange();
    if (!r) return;
    const existing = (isElement(r.startContainer) ? r.startContainer : r.startContainer.parentElement)?.closest("a");
    if (existing && this.surface?.contains(existing)) {
      if (!v) {
        existing.replaceWith(...Array.from(existing.childNodes));
        return;
      }
      this._setLinkTarget(existing, v);
      return;
    }
    if (!v) return;
    const a = document.createElement("a");
    this._setLinkTarget(a, v);
    if (r.collapsed) a.textContent = a.getAttribute("data-wiki") ?? v.replace(/^doc:/, "");
    else a.appendChild(r.extractContents());
    r.insertNode(a);
    const after = document.createRange();
    after.setStartAfter(a);
    after.collapse(true);
    const sel = this._getSelection();
    sel?.removeAllRanges();
    sel?.addRange(after);
  }

  private _setLinkTarget(a: HTMLElement, v: string): void {
    const wiki = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(v);
    a.removeAttribute("href");
    a.removeAttribute("data-wiki");
    a.removeAttribute("data-doc");
    a.classList.remove("wiki");
    if (wiki) {
      a.setAttribute("data-wiki", wiki[1]!.trim());
      a.classList.add("wiki");
    } else if (/^doc:/i.test(v)) {
      a.setAttribute("href", v);
      a.setAttribute("data-doc", v.slice(4));
    } else {
      const url = /^(https?:|mailto:|tel:|\/|#)/i.test(v) ? v : /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) ? `mailto:${v}` : `https://${v}`;
      a.setAttribute("href", url);
    }
  }

  // ── Slash + wiki menus ─────────────────────────────────────────────────

  private _updateMenusFromCaret(): void {
    const block = this._currentBlock();
    if (!block || block.closest("pre, [data-math-block], code")) {
      this._menu = null;
      return;
    }
    const before = this._textBeforeCaret(block);
    const r = this._getRange();
    const slash = /^\/([\w -]{0,24})$/.exec(before);
    if (slash) {
      const q = slash[1]!.toLowerCase().trim();
      const inTable = !!block.closest("td, th");
      const items = SLASH_COMMANDS.filter((c) => (c.group === "Table" ? inTable : true))
        .filter((c) => !q || c.label.toLowerCase().includes(q) || c.keywords.includes(q) || c.id.includes(q))
        .map((c) => ({ id: c.id, label: c.label, hint: c.hint, icon: c.icon, group: c.group }));
      const pos = this._anchorPoint(r);
      const prevIndex = this._menu?.kind === "slash" && this._menu.query === q ? this._menu.index : 0;
      this._menu = items.length || q.length < 3
        ? { kind: "slash", query: q, items, index: Math.min(prevIndex, Math.max(0, items.length - 1)), x: pos.x, y: pos.y }
        : null;
      return;
    }
    const wiki = /\[\[([^\[\]\n|]{0,60})$/.exec(before);
    if (wiki) {
      const q = wiki[1]!;
      const ql = q.toLowerCase().trim();
      const targets = (this.linkTargets ?? [])
        .filter((t) => !ql || t.title.toLowerCase().includes(ql))
        .sort((a, b) => Number(b.title.toLowerCase().startsWith(ql)) - Number(a.title.toLowerCase().startsWith(ql)))
        .slice(0, 8);
      const items: MenuItem[] = targets.map((t) => ({ id: `wiki:${t.title}`, label: t.title, hint: "Document", icon: ICONS.wiki }));
      if (q.trim() && !targets.some((t) => t.title.toLowerCase() === ql)) {
        items.push({ id: `wiki:${q.trim()}`, label: `Link to “${q.trim()}”`, hint: "New wiki link", icon: ICONS.link });
      }
      const pos = this._anchorPoint(r);
      this._menu = { kind: "wiki", query: q, items, index: 0, x: pos.x, y: pos.y };
      return;
    }
    if (this._menu) this._menu = null;
  }

  private _chooseMenuItem(item: MenuItem): void {
    const menu = this._menu;
    this._menu = null;
    if (!menu) return;
    const block = this._currentBlock();
    if (!block) return;
    if (menu.kind === "slash") {
      this._checkpoint();
      // The slash menu only opens when "/query" is everything before the caret.
      this._deleteBeforeCaret(block, this._textBeforeCaret(block).length);
      if (!textOf(block).trim() && !block.querySelector("br") && block.tagName !== "TD" && block.tagName !== "TH") {
        block.innerHTML = "<br>";
        this._placeCaretAtStart(block);
      }
      this._command(item.id);
      return;
    }
    // Wiki link
    const title = item.id.slice(5);
    this._checkpoint();
    const r = this._deleteBeforeCaret(block, menu.query.length + 2) ?? this._getRange();
    if (!r) return;
    const a = document.createElement("a");
    a.setAttribute("data-wiki", title);
    a.className = "wiki";
    a.textContent = title;
    r.insertNode(a);
    const space = document.createTextNode(" ");
    a.after(space);
    this._setCaret(space, 1);
    this._markDirty();
  }

  private _scrollMenuItem(): void {
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector(".menu .item.active")?.scrollIntoView({ block: "nearest" });
    });
  }

  private _closeMenus(): void {
    this._menu = null;
    this._prompt = null;
  }

  // ── Source mode ────────────────────────────────────────────────────────

  private _onSourceInput(): void {
    this._autosize();
    this._markDirty();
  }

  private _autosize(): void {
    const ta = this.textarea;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(ta.scrollHeight, 320)}px`;
  }

  private _onSourceKeyDown(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      this._save();
      return;
    }
    if (this.readonly) return;
    const ta = e.target as HTMLTextAreaElement;
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = ta;
      if (a !== b && value.slice(a, b).includes("\n")) {
        const start = value.lastIndexOf("\n", a - 1) + 1;
        const block = value.slice(start, b);
        const next = e.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, "  ");
        ta.setRangeText(next, start, b, "select");
      } else if (e.shiftKey) {
        const start = value.lastIndexOf("\n", a - 1) + 1;
        const strip = /^ {1,2}/.exec(value.slice(start))?.[0].length ?? 0;
        if (strip) ta.setRangeText("", start, start + strip, "end");
      } else {
        ta.setRangeText("  ", a, b, "end");
      }
      this._onSourceInput();
    }
  }

  // ── Template ───────────────────────────────────────────────────────────

  private _tb(id: string, title: string, content: TemplateResult | string, activeKey?: string) {
    const active = activeKey ? this._active.has(activeKey) : false;
    return html`<button
      type="button"
      class="tb ${active ? "on" : ""} ${typeof content === "string" ? "txt" : ""}"
      title=${title}
      aria-label=${title}
      aria-pressed=${activeKey ? String(active) : nothing}
      @mousedown=${(e: Event) => e.preventDefault()}
      @click=${() => this._command(id)}
    >${content}</button>`;
  }

  private _renderToolbar() {
    return html`<div class="toolbar" role="toolbar" aria-label="Formatting">
      <div class="grp">
        ${this._tb("h1", "Heading 1 (Ctrl+Alt+1)", "H1", "h1")}
        ${this._tb("h2", "Heading 2 (Ctrl+Alt+2)", "H2", "h2")}
        ${this._tb("h3", "Heading 3 (Ctrl+Alt+3)", "H3", "h3")}
      </div>
      <div class="grp">
        ${this._tb("bold", "Bold (Ctrl+B)", html`<b>B</b>`, "bold")}
        ${this._tb("italic", "Italic (Ctrl+I)", html`<i>I</i>`, "italic")}
        ${this._tb("underline", "Underline (Ctrl+U)", html`<u>U</u>`, "underline")}
        ${this._tb("strike", "Strikethrough (Ctrl+Shift+X)", html`<s>S</s>`, "strikeThrough")}
        ${this._tb("inline-code", "Inline code (Ctrl+E)", ICONS.code, "code")}
        ${this._tb("highlight", "Highlight (Ctrl+Shift+H)", ICONS.highlight, "highlight")}
        ${this._tb("link", "Link (Ctrl+K)", ICONS.link, "link")}
      </div>
      <div class="grp">
        ${this._tb("bullet", "Bulleted list", ICONS.bullet, "bullet")}
        ${this._tb("numbered", "Numbered list", ICONS.numbered, "numbered")}
        ${this._tb("todo", "Checklist", ICONS.todo, "todo")}
        ${this._tb("quote", "Quote", ICONS.quote, "quote")}
        ${this._tb("callout-NOTE", "Callout", ICONS.callout, "callout")}
        ${this._tb("toggle", "Toggle", ICONS.toggle, "toggle")}
      </div>
      <div class="grp">
        ${this._tb("code", "Code block", ICONS.codeBlock, "code-block")}
        ${this._tb("table", "Table", ICONS.table)}
        ${this._tb("divider", "Divider", ICONS.divider)}
        ${this._tb("image", "Image", ICONS.image)}
        ${this._tb("math", "Math block", ICONS.math)}
        ${this._tb("embed", "Embed", ICONS.embed)}
      </div>
      <div class="grp">
        ${this._tb("undo", "Undo (Ctrl+Z)", ICONS.undo)}
        ${this._tb("redo", "Redo (Ctrl+Shift+Z)", ICONS.redo)}
      </div>
      <div class="spacer"></div>
      <div class="modes" role="tablist" aria-label="Editor mode">
        <button type="button" role="tab" aria-selected=${String(this.mode === "rich")} class=${this.mode === "rich" ? "on" : ""} @click=${() => this._setMode("rich")}>Rich</button>
        <button type="button" role="tab" aria-selected=${String(this.mode === "source")} class=${this.mode === "source" ? "on" : ""} @click=${() => this._setMode("source")}>Markdown</button>
      </div>
    </div>`;
  }

  private _renderMenu() {
    const m = this._menu;
    if (!m) return nothing;
    let lastGroup = "";
    return html`<div class="menu" style="left:${m.x}px;top:${m.y}px" role="listbox" @mousedown=${(e: Event) => e.preventDefault()}>
      ${m.items.length === 0
        ? html`<div class="empty">${m.kind === "wiki" ? "Type a document title…" : "No matching blocks"}</div>`
        : m.items.map((item, i) => {
            const header = item.group && item.group !== lastGroup ? html`<div class="group">${item.group}</div>` : nothing;
            lastGroup = item.group ?? lastGroup;
            return html`${header}<div
                class="item ${i === m.index ? "active" : ""}"
                role="option"
                aria-selected=${String(i === m.index)}
                @mouseenter=${() => (this._menu = { ...m, index: i })}
                @click=${() => this._chooseMenuItem(item)}
              >
                <span class="ic">${item.icon ?? ""}</span>
                <span class="lbl"><span class="t">${item.label}</span>${item.hint ? html`<span class="h">${item.hint}</span>` : nothing}</span>
              </div>`;
          })}
    </div>`;
  }

  private _renderPrompt() {
    const p = this._prompt;
    if (!p) return nothing;
    const submit = (e: Event) => {
      e.preventDefault();
      const input = this.renderRoot.querySelector<HTMLInputElement>(".prompt input[type=text]");
      this._applyPrompt(input?.value ?? "");
    };
    return html`<form class="prompt" style="left:${p.x}px;top:${p.y}px" @submit=${submit}>
      <label>${p.label}</label>
      <div class="row">
        <input
          type="text"
          .value=${p.value}
          placeholder=${p.placeholder}
          spellcheck="false"
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.preventDefault();
              this._prompt = null;
              this._restoreSavedRange();
            }
          }}
        />
        <button type="submit" class="ok">Apply</button>
        ${p.kind === "image"
          ? html`<label class="upload">Upload<input
                type="file"
                accept="image/*"
                @change=${(e: Event) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  this._prompt = null;
                  this._restoreSavedRange();
                  if (f) void this._handleImageFiles([f]);
                }}
              /></label>`
          : nothing}
        <button type="button" class="cancel" @click=${() => { this._prompt = null; this._restoreSavedRange(); }}>Esc</button>
      </div>
    </form>`;
  }

  render() {
    const rich = this.mode !== "source";
    return html`
      <div class="wrap ${rich ? "is-rich" : "is-source"}">
        ${this.readonly ? nothing : this._renderToolbar()}
        <div class="body" ?hidden=${!rich}>
          <div
            class="surface"
            contenteditable=${this.readonly ? "false" : "true"}
            spellcheck="true"
            role="textbox"
            aria-multiline="true"
            aria-label="Document"
            @beforeinput=${this._onBeforeInput}
            @input=${this._onInput}
            @keydown=${this._onKeyDown}
            @keyup=${() => this._updateMenusFromCaretIfOpen()}
            @mousedown=${this._onSurfaceMouseDown}
            @click=${this._onSurfaceClick}
            @paste=${this._onPaste}
            @drop=${this._onDrop}
            @focus=${() => {
              try {
                document.execCommand("defaultParagraphSeparator", false, "p");
              } catch {
                /* ignore */
              }
            }}
            @blur=${() => {
              if (!this._prompt) this._menu = null;
            }}
          ></div>
          ${this._empty ? html`<div class="placeholder" aria-hidden="true">${this.placeholder}</div>` : nothing}
        </div>
        <textarea
          class="source"
          ?hidden=${rich}
          ?readonly=${this.readonly}
          spellcheck="false"
          aria-label="Markdown source"
          placeholder=${this.placeholder}
          @input=${this._onSourceInput}
          @keydown=${this._onSourceKeyDown}
        ></textarea>
      </div>
      ${this._renderMenu()} ${this._renderPrompt()}
      ${this._notice ? html`<div class="notice" role="status">${this._notice}</div>` : nothing}
    `;
  }

  private _updateMenusFromCaretIfOpen(): void {
    if (this._menu) this._updateMenusFromCaret();
  }

  static styles = css`
    :host {
      --de-accent: var(--g-primary, #d4af37);
      --de-bg: var(--g-bg, #0a0a0e);
      --de-fg: var(--g-fg, #f5f5f4);
      --de-dim: var(--g-fg-dim, rgba(245, 245, 244, 0.66));
      --de-faint: var(--g-fg-faint, rgba(245, 245, 244, 0.38));
      --de-border: var(--g-border, rgba(212, 175, 55, 0.16));
      --de-border-strong: var(--g-border-strong, rgba(212, 175, 55, 0.34));
      --de-mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
      --de-max-width: 860px;
      display: block;
      position: relative;
      color: var(--de-fg);
      font-family: var(--g-font-family, "Inter", system-ui, -apple-system, "Segoe UI", sans-serif);
    }
    [hidden] {
      display: none !important;
    }
    .wrap {
      border: 1px solid var(--de-border);
      border-radius: 14px;
      background:
        radial-gradient(1200px 300px at 50% -120px, color-mix(in srgb, var(--de-accent) 7%, transparent), transparent 70%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(0, 0, 0, 0.22)),
        color-mix(in srgb, var(--de-bg) 92%, transparent);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 20px 50px rgba(0, 0, 0, 0.35);
      overflow: clip;
    }
    :host([readonly]) .wrap {
      border-color: transparent;
      background: transparent;
      box-shadow: none;
    }

    /* ── Toolbar ── */
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      padding: 7px 10px;
      background: color-mix(in srgb, var(--de-bg) 82%, rgba(0, 0, 0, 0.6));
      backdrop-filter: blur(14px) saturate(160%);
      -webkit-backdrop-filter: blur(14px) saturate(160%);
      border-bottom: 1px solid var(--de-border);
    }
    .grp {
      display: flex;
      align-items: center;
      gap: 1px;
      padding-right: 6px;
      margin-right: 2px;
      border-right: 1px solid rgba(255, 255, 255, 0.07);
    }
    .grp:last-of-type {
      border-right: none;
    }
    .tb {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 30px;
      height: 30px;
      padding: 0 6px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--de-dim);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .tb.txt {
      font-size: 12px;
      font-weight: 650;
      letter-spacing: 0.02em;
    }
    .tb b,
    .tb i,
    .tb u,
    .tb s {
      font-size: 14px;
      font-family: Georgia, "Times New Roman", serif;
    }
    .tb:hover {
      color: var(--de-fg);
      background: rgba(255, 255, 255, 0.06);
    }
    .tb.on {
      color: var(--de-accent);
      background: color-mix(in srgb, var(--de-accent) 14%, transparent);
      border-color: color-mix(in srgb, var(--de-accent) 30%, transparent);
    }
    .tb:focus-visible,
    .modes button:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--de-accent) 60%, transparent);
      outline-offset: 1px;
    }
    .spacer {
      flex: 1;
    }
    .modes {
      display: inline-flex;
      padding: 2px;
      border-radius: 9px;
      border: 1px solid var(--de-border);
      background: rgba(0, 0, 0, 0.35);
    }
    .modes button {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--de-dim);
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: 7px;
      cursor: pointer;
    }
    .modes button.on {
      color: #111;
      background: linear-gradient(180deg, color-mix(in srgb, var(--de-accent) 100%, white 12%), var(--de-accent));
      box-shadow: 0 0 14px color-mix(in srgb, var(--de-accent) 35%, transparent);
    }

    /* ── Rich surface ── */
    .body {
      position: relative;
    }
    .surface {
      max-width: var(--de-max-width);
      margin: 0 auto;
      min-height: 320px;
      padding: 30px 44px 64px;
      outline: none;
      font-size: 15.5px;
      line-height: 1.72;
      color: var(--de-fg);
      caret-color: var(--de-accent);
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    .placeholder {
      position: absolute;
      top: 30px;
      left: 0;
      right: 0;
      max-width: var(--de-max-width);
      margin: 0 auto;
      padding: 0 44px;
      box-sizing: border-box;
      color: var(--de-faint);
      pointer-events: none;
      font-size: 15.5px;
      line-height: 1.72;
    }
    .surface ::selection {
      background: color-mix(in srgb, var(--de-accent) 32%, transparent);
    }
    .surface > :first-child {
      margin-top: 0;
    }
    .surface p {
      margin: 0.35em 0;
      position: relative;
    }
    .surface p.hint::before {
      content: "Type '/' for commands";
      position: absolute;
      left: 0;
      color: var(--de-faint);
      pointer-events: none;
    }
    .surface h1,
    .surface h2,
    .surface h3,
    .surface h4 {
      line-height: 1.25;
      letter-spacing: -0.015em;
      color: #fff;
      margin: 1.3em 0 0.4em;
    }
    .surface h1 {
      font-size: 2em;
      font-weight: 750;
      letter-spacing: -0.025em;
    }
    .surface h2 {
      font-size: 1.5em;
      font-weight: 700;
      padding-bottom: 0.2em;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }
    .surface h3 {
      font-size: 1.22em;
      font-weight: 650;
    }
    .surface h4 {
      font-size: 1.05em;
      font-weight: 650;
    }
    .surface strong,
    .surface b {
      color: #fff;
      font-weight: 700;
    }
    .surface a {
      color: var(--de-accent);
      text-decoration: underline;
      text-decoration-color: color-mix(in srgb, var(--de-accent) 45%, transparent);
      text-underline-offset: 3px;
      cursor: text;
    }
    :host([readonly]) .surface a {
      cursor: pointer;
    }
    .surface a.wiki,
    .surface a[data-wiki],
    .surface a[data-doc] {
      text-decoration: none;
      padding: 0 0.3em;
      border-radius: 5px;
      background: color-mix(in srgb, var(--de-accent) 11%, transparent);
      border-bottom: 1px dashed color-mix(in srgb, var(--de-accent) 55%, transparent);
    }
    .surface a[data-wiki]::before {
      content: "↳ ";
      opacity: 0.6;
      font-size: 0.85em;
    }
    .surface mark {
      color: inherit;
      background: color-mix(in srgb, var(--de-accent) 34%, transparent);
      border-radius: 3px;
      padding: 0 0.15em;
    }
    .surface code {
      font-family: var(--de-mono);
      font-variant-ligatures: none;
      font-size: 0.86em;
      padding: 0.12em 0.38em;
      border-radius: 5px;
      color: #f3d98b;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .surface ul,
    .surface ol {
      margin: 0.35em 0;
      padding-left: 1.6em;
    }
    .surface li {
      margin: 0.18em 0;
      padding-left: 0.15em;
    }
    .surface li > p {
      margin: 0.1em 0;
    }
    .surface li::marker {
      color: var(--de-accent);
    }
    .surface ol > li::marker {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .surface li[data-checked] {
      list-style: none;
      position: relative;
      padding-left: 1.75em;
      margin-left: -1.6em;
    }
    .surface li[data-checked]::before {
      content: "";
      position: absolute;
      left: 0.1em;
      top: 0.36em;
      width: 1em;
      height: 1em;
      box-sizing: border-box;
      border-radius: 4px;
      border: 1.5px solid color-mix(in srgb, var(--de-accent) 65%, transparent);
      background: rgba(0, 0, 0, 0.3);
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .surface li[data-checked="true"]::before {
      background: var(--de-accent);
      border-color: var(--de-accent);
      box-shadow: 0 0 10px color-mix(in srgb, var(--de-accent) 40%, transparent);
    }
    .surface li[data-checked="true"]::after {
      content: "";
      position: absolute;
      left: 0.43em;
      top: 0.48em;
      width: 0.28em;
      height: 0.55em;
      border: solid #111;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
      pointer-events: none;
    }
    .surface li[data-checked="true"] {
      color: var(--de-faint);
    }
    .surface li[data-checked="true"] li {
      color: var(--de-fg);
    }
    .surface blockquote {
      margin: 0.8em 0;
      padding: 0.15em 0 0.15em 1em;
      border-left: 3px solid color-mix(in srgb, var(--de-accent) 60%, transparent);
      color: var(--de-dim);
    }
    .surface hr {
      border: 0;
      height: 1px;
      margin: 1.8em 0;
      background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--de-accent) 55%, transparent), transparent);
    }
    .surface img {
      max-width: 100%;
      height: auto;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      vertical-align: middle;
    }

    /* callouts */
    .surface .callout {
      --k: #60a5fa;
      margin: 0.9em 0;
      padding: 10px 16px 10px 16px;
      border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--k) 32%, transparent);
      border-left: 3px solid var(--k);
      background: linear-gradient(90deg, color-mix(in srgb, var(--k) 12%, transparent), color-mix(in srgb, var(--k) 4%, transparent));
    }
    .surface .callout[data-callout="TIP"] {
      --k: #34d399;
    }
    .surface .callout[data-callout="IMPORTANT"] {
      --k: #a78bfa;
    }
    .surface .callout[data-callout="WARNING"] {
      --k: #fbbf24;
    }
    .surface .callout[data-callout="CAUTION"] {
      --k: #f87171;
    }
    .surface .callout-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 750;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--k);
      cursor: pointer;
      user-select: none;
    }
    .surface .callout-label::before {
      content: "i";
      display: inline-grid;
      place-items: center;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      font-size: 10px;
      font-family: Georgia, serif;
      font-style: italic;
      letter-spacing: 0;
      color: #111;
      background: var(--k);
    }
    .surface .callout[data-callout="TIP"] .callout-label::before {
      content: "✓";
      font-style: normal;
    }
    .surface .callout[data-callout="WARNING"] .callout-label::before,
    .surface .callout[data-callout="CAUTION"] .callout-label::before,
    .surface .callout[data-callout="IMPORTANT"] .callout-label::before {
      content: "!";
      font-style: normal;
      font-family: inherit;
    }
    .surface .callout-body > :first-child {
      margin-top: 0.15em;
    }
    .surface .callout-body > :last-child {
      margin-bottom: 0.1em;
    }

    /* toggles */
    .surface details {
      margin: 0.7em 0;
      padding: 4px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.02);
    }
    .surface details[open] {
      padding-bottom: 8px;
    }
    .surface summary {
      list-style: none;
      position: relative;
      padding-left: 24px;
      font-weight: 600;
      cursor: text;
      outline: none;
    }
    .surface summary::-webkit-details-marker {
      display: none;
    }
    .surface summary::before {
      content: "";
      position: absolute;
      left: 5px;
      top: 0.62em;
      width: 6px;
      height: 6px;
      border: solid var(--de-accent);
      border-width: 0 2px 2px 0;
      transform: rotate(-45deg);
      transition: transform 0.15s;
      cursor: pointer;
    }
    .surface details[open] > summary::before {
      transform: rotate(45deg);
      top: 0.5em;
    }
    .surface .toggle-body {
      padding-left: 24px;
    }

    /* code */
    .surface pre {
      position: relative;
      margin: 0.9em 0;
      padding: 34px 18px 14px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(0, 0, 0, 0.25)), #07070a;
      font-family: var(--de-mono);
      font-size: 13px;
      line-height: 1.6;
      font-variant-ligatures: none;
      white-space: pre;
      overflow-x: auto;
      tab-size: 2;
      color: #e7e5e4;
    }
    .surface pre::before {
      content: attr(data-lang);
      position: absolute;
      top: 8px;
      right: 12px;
      font-family: var(--g-font-family, system-ui, sans-serif);
      font-size: 10.5px;
      font-weight: 650;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--de-faint);
      cursor: pointer;
    }
    .surface pre[data-lang=""]::before {
      content: "plain text";
    }
    .surface pre::after {
      content: "";
      position: absolute;
      top: 12px;
      left: 14px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f87171;
      box-shadow: 14px 0 0 #fbbf24, 28px 0 0 #34d399;
      opacity: 0.55;
    }
    .surface pre code {
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      font-size: inherit;
    }
    .surface .tok-kw {
      color: #e6c35c;
    }
    .surface .tok-str {
      color: #a5d6a7;
    }
    .surface .tok-com {
      color: #6b7280;
      font-style: italic;
    }
    .surface .tok-num {
      color: #f5a97f;
    }
    .surface .tok-fn {
      color: #8ab4f8;
    }
    .surface .tok-prop {
      color: #f0c987;
    }
    .surface .tok-tag {
      color: #f28b82;
    }
    .surface .tok-attr {
      color: #c3e88d;
    }
    .surface .tok-var {
      color: #89ddff;
    }
    .surface pre.frontmatter {
      padding: 26px 16px 10px;
      font-size: 12.5px;
      color: var(--de-dim);
      background: rgba(255, 255, 255, 0.025);
      border-style: dashed;
    }
    .surface pre.frontmatter::before {
      content: "Properties";
      left: 16px;
      right: auto;
    }
    .surface pre.frontmatter::after {
      display: none;
    }

    /* tables */
    .surface table {
      border-collapse: separate;
      border-spacing: 0;
      margin: 1em 0;
      min-width: 50%;
      max-width: 100%;
      font-size: 0.94em;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      overflow: hidden;
    }
    .surface th,
    .surface td {
      padding: 8px 14px;
      border-right: 1px solid rgba(255, 255, 255, 0.08);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      vertical-align: top;
      min-width: 60px;
    }
    .surface tr > :last-child {
      border-right: 0;
    }
    .surface tbody tr:last-child > * {
      border-bottom: 0;
    }
    .surface th {
      text-align: left;
      font-weight: 650;
      color: #fff;
      background: color-mix(in srgb, var(--de-accent) 10%, rgba(0, 0, 0, 0.2));
    }
    .surface th[align="center"],
    .surface td[align="center"] {
      text-align: center;
    }
    .surface th[align="right"],
    .surface td[align="right"] {
      text-align: right;
    }
    .surface tbody tr:nth-child(even) {
      background: rgba(255, 255, 255, 0.018);
    }

    /* math */
    .surface .math {
      font-family: "Cambria Math", "STIX Two Math", "Latin Modern Math", "Times New Roman", serif;
      font-style: italic;
      color: #f3d98b;
      background: color-mix(in srgb, var(--de-accent) 9%, transparent);
      border-radius: 4px;
      padding: 0 0.3em;
    }
    .surface .math-block {
      position: relative;
      margin: 0.9em 0;
      padding: 22px 16px 14px;
      text-align: center;
      white-space: pre-wrap;
      font-family: "Cambria Math", "STIX Two Math", "Latin Modern Math", "Times New Roman", serif;
      font-size: 1.12em;
      font-style: italic;
      color: #f3d98b;
      border-radius: 12px;
      border: 1px dashed color-mix(in srgb, var(--de-accent) 35%, transparent);
      background: color-mix(in srgb, var(--de-accent) 5%, transparent);
    }
    .surface .math-block::before {
      content: "TeX";
      position: absolute;
      top: 6px;
      left: 12px;
      font: 650 10px/1 var(--g-font-family, system-ui, sans-serif);
      letter-spacing: 0.1em;
      color: var(--de-faint);
      font-style: normal;
    }
    .surface .math-block:empty::after {
      content: "E = mc^2";
      color: var(--de-faint);
    }

    /* embeds + media */
    .surface figure {
      position: relative;
      margin: 1em 0;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--de-border);
      background: #000;
    }
    .surface figure iframe {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      border: 0;
      background: #050505;
    }
    .surface figure video {
      display: block;
      width: 100%;
      max-height: 520px;
      background: #000;
    }
    .surface figure.media-audio {
      background: rgba(255, 255, 255, 0.03);
      padding: 10px;
    }
    .surface figure audio {
      display: block;
      width: 100%;
    }
    .surface figcaption {
      padding: 7px 12px;
      font: 12px/1.4 var(--de-mono);
      color: var(--de-faint);
      background: rgba(0, 0, 0, 0.55);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .surface .embed-blocked {
      padding: 28px;
      text-align: center;
      color: var(--de-dim);
      font-size: 13px;
    }
    .surface .fig-remove {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(0, 0, 0, 0.7);
      color: #fff;
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .surface figure:hover .fig-remove {
      opacity: 1;
    }
    :host([readonly]) .fig-remove {
      display: none;
    }

    /* ── Source mode ── */
    textarea.source {
      display: block;
      box-sizing: border-box;
      width: 100%;
      min-height: 320px;
      padding: 26px 40px 48px;
      border: 0;
      outline: none;
      resize: vertical;
      background: transparent;
      color: var(--de-fg);
      caret-color: var(--de-accent);
      font-family: var(--de-mono);
      font-size: 13.5px;
      line-height: 1.7;
      font-variant-ligatures: none;
      tab-size: 2;
    }
    textarea.source::placeholder {
      color: var(--de-faint);
    }

    /* ── Popovers ── */
    .menu,
    .prompt {
      position: absolute;
      z-index: 30;
      background: rgba(12, 12, 16, 0.97);
      border: 1px solid var(--de-border-strong);
      border-radius: 12px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(212, 175, 55, 0.06), 0 0 30px color-mix(in srgb, var(--de-accent) 8%, transparent);
    }
    .menu {
      width: 290px;
      max-height: 340px;
      overflow-y: auto;
      padding: 6px;
    }
    .menu .group {
      padding: 8px 8px 4px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--de-faint);
    }
    .menu .item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .menu .item.active {
      background: color-mix(in srgb, var(--de-accent) 13%, transparent);
      border-color: color-mix(in srgb, var(--de-accent) 26%, transparent);
    }
    .menu .ic {
      flex: none;
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.04);
      color: var(--de-accent);
      font-size: 12px;
      font-weight: 700;
    }
    .menu .lbl {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .menu .t {
      font-size: 13.5px;
      color: var(--de-fg);
    }
    .menu .h {
      font-size: 11.5px;
      color: var(--de-faint);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .menu .empty {
      padding: 12px;
      color: var(--de-faint);
      font-size: 13px;
    }
    .prompt {
      width: min(420px, calc(100% - 16px));
      padding: 10px;
      box-sizing: border-box;
    }
    .prompt > label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--de-accent);
      margin: 0 2px 6px;
    }
    .prompt .row {
      display: flex;
      gap: 6px;
    }
    .prompt input[type="text"] {
      flex: 1;
      min-width: 0;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(0, 0, 0, 0.45);
      color: var(--de-fg);
      font: 13px var(--de-mono);
      outline: none;
    }
    .prompt input[type="text"]:focus {
      border-color: var(--de-border-strong);
    }
    .prompt button,
    .prompt .upload {
      appearance: none;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.05);
      color: var(--de-dim);
      font: 600 12px inherit;
      font-family: inherit;
      cursor: pointer;
    }
    .prompt .ok {
      color: #111;
      background: var(--de-accent);
      border-color: var(--de-accent);
    }
    .prompt .upload input {
      display: none;
    }
    .notice {
      position: absolute;
      right: 14px;
      bottom: 14px;
      z-index: 40;
      max-width: min(420px, 80%);
      padding: 9px 14px;
      border-radius: 10px;
      font-size: 13px;
      color: var(--de-fg);
      background: rgba(20, 16, 6, 0.96);
      border: 1px solid var(--de-border-strong);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    @media (max-width: 640px) {
      .surface {
        padding: 22px 18px 48px;
      }
      .placeholder {
        padding: 0 18px;
        top: 22px;
      }
      textarea.source {
        padding: 20px 16px 40px;
      }
      .grp {
        border-right: 0;
        padding-right: 0;
      }
    }
  `;
}

if (!customElements.get("ib-doc-editor")) {
  customElements.define("ib-doc-editor", IbDocEditor);
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-doc-editor": IbDocEditor;
  }
}
