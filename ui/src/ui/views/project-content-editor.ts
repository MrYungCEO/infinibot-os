/**
 * Project Content Editor — Notion-style block editor with slash menu.
 *
 * Blocks are persisted via the gateway (kanban.projects.content.getBlocks /
 * .saveBlocks). Saves are debounced; the host element shows a small status
 * indicator when a save is in flight.
 *
 * Mount once per (projectId) by calling mountBlockEditor(el, opts). The
 * returned controller has a destroy() that detaches listeners.
 */

export type BlockType =
  | "paragraph" | "h1" | "h2" | "h3"
  | "bullet" | "numbered" | "todo"
  | "quote" | "callout" | "code" | "divider"
  | "image";

export interface Block {
  id: string;
  type: BlockType;
  text: string;
  checked?: boolean;
  language?: string;
  /** Image blocks: src is the rendered URL or data URL. text holds alt text. */
  src?: string;
}

export interface BlockEditorOptions {
  /**
   * Persisted mode — editor loads blocks from the gateway on mount and saves
   * them back on change. Mutually exclusive with `inline`.
   */
  client?: { request: (method: string, params: any) => Promise<any> };
  projectId?: string;
  /**
   * Inline mode — caller provides initial blocks and is notified of changes.
   * The editor performs no I/O of its own. Mutually exclusive with the
   * client/projectId pair.
   */
  inline?: {
    initialBlocks: Block[];
    onChange: (blocks: Block[]) => void;
  };
  /** Optional placeholder shown when the editor is empty. */
  placeholder?: string;
  /** Forwarded for moltbot://page/<id> navigation links. */
  onNavigate?: (rowId: string) => void;
}

export interface BlockEditor {
  destroy(): void;
  refresh(): void;
  setBlocks(blocks: Block[]): void;
}

interface SlashItem {
  type: BlockType;
  label: string;
  hint: string;
  icon: string;
  keywords: string[];
}

const SLASH_ITEMS: SlashItem[] = [
  { type: "paragraph", label: "Text",        hint: "Plain paragraph",          icon: "¶",  keywords: ["paragraph", "text", "plain"] },
  { type: "h1",        label: "Heading 1",   hint: "Big section heading",      icon: "H₁", keywords: ["heading", "h1", "title", "big"] },
  { type: "h2",        label: "Heading 2",   hint: "Medium heading",           icon: "H₂", keywords: ["heading", "h2", "subtitle"] },
  { type: "h3",        label: "Heading 3",   hint: "Small heading",            icon: "H₃", keywords: ["heading", "h3"] },
  { type: "bullet",    label: "Bulleted list", hint: "Bullet list item",       icon: "•",  keywords: ["bullet", "list", "ul", "unordered"] },
  { type: "numbered",  label: "Numbered list", hint: "Numbered list item",     icon: "1.", keywords: ["numbered", "ordered", "list", "ol"] },
  { type: "todo",      label: "To-do",       hint: "Checkbox",                 icon: "☐",  keywords: ["todo", "task", "check", "checkbox"] },
  { type: "quote",     label: "Quote",       hint: "Blockquote",               icon: "❝",  keywords: ["quote", "blockquote", "cite"] },
  { type: "callout",   label: "Callout",     hint: "Highlight callout",        icon: "💡", keywords: ["callout", "highlight", "tip", "note"] },
  { type: "code",      label: "Code",        hint: "Code block",               icon: "</>",keywords: ["code", "pre", "snippet"] },
  { type: "divider",   label: "Divider",     hint: "Horizontal rule",          icon: "—",  keywords: ["divider", "hr", "rule", "separator"] },
];

const SAVE_DEBOUNCE_MS = 500;
const STYLE_ID = "project-content-editor-style";

function uid(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = EDITOR_CSS;
  document.head.appendChild(style);
}

function escHtml(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Quote a URL so it's safe to embed inside an HTML attribute. Strips quotes,
 * newlines, and angle brackets — anything left can still be a `data:` URL or
 * a normal `https:` link, but cannot break out of the attribute or inject a
 * tag.
 */
function safeUrlAttr(s: string): string {
  return String(s ?? "").replace(/[\r\n"'<>]/g, "").trim();
}

interface MediaRef {
  type: "image" | "video" | "audio";
  src: string;
  alt?: string;
}

const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)(?:\?|#|$)/i;
const VIDEO_EXT_RE = /\.(mp4|webm|ogv|mov|m4v)(?:\?|#|$)/i;
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|flac|aac)(?:\?|#|$)/i;

/**
 * Scan a block's plain-text content for media references — markdown image
 * syntax, bare image/video/audio URLs, and `data:` URIs. Returns one entry
 * per media item, in source order. The block continues to render its raw
 * text in the editable span; the preview is appended below.
 */
function detectMedia(text: string): MediaRef[] {
  const out: MediaRef[] = [];
  if (!text) return out;

  // Markdown image first so we can capture alt text.
  const mdImg = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const consumed: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = mdImg.exec(text)) !== null) {
    out.push({ type: "image", src: m[2], alt: m[1] });
    consumed.push([m.index, m.index + m[0].length]);
  }

  // Then scan for bare URLs and data URIs that aren't inside the markdown spans.
  const urlRe = /(?:^|[\s(<])((?:https?:\/\/|data:)[^\s)<>"]+)/g;
  while ((m = urlRe.exec(text)) !== null) {
    const start = m.index + (m[0].length - m[1].length);
    const end = m.index + m[0].length;
    if (consumed.some(([a, b]) => start >= a && end <= b)) continue;
    const url = m[1];
    if (/^data:image\//i.test(url) || IMG_EXT_RE.test(url)) {
      out.push({ type: "image", src: url });
    } else if (/^data:video\//i.test(url) || VIDEO_EXT_RE.test(url)) {
      out.push({ type: "video", src: url });
    } else if (/^data:audio\//i.test(url) || AUDIO_EXT_RE.test(url)) {
      out.push({ type: "audio", src: url });
    }
  }
  return out;
}

function buildMediaPreviewHtml(items: MediaRef[]): string {
  if (items.length === 0) return "";
  const parts = items.map((item) => {
    const src = safeUrlAttr(item.src);
    if (!src) return "";
    if (item.type === "image") {
      const alt = escHtml(item.alt ?? "");
      return `<a class="bk-media-link" href="${src}" target="_blank" rel="noopener noreferrer"><img class="bk-media-img" src="${src}" alt="${alt}" loading="lazy" decoding="async" /></a>`;
    }
    if (item.type === "video") {
      return `<video class="bk-media-vid" src="${src}" controls preload="metadata"></video>`;
    }
    return `<audio class="bk-media-aud" src="${src}" controls preload="metadata"></audio>`;
  });
  return `<div class="bk-media" contenteditable="false" data-media="1">${parts.join("")}</div>`;
}

function blockToElement(block: Block): HTMLElement {
  const el = document.createElement("div");
  el.className = `bk-block bk-${block.type}`;
  el.dataset.id = block.id;
  el.dataset.type = block.type;

  if (block.type === "divider") {
    el.contentEditable = "false";
    el.innerHTML = `<hr class="bk-hr">`;
    return el;
  }

  const text = block.text ?? "";
  // Code blocks deliberately skip media detection — pasting an image URL
  // inside a code fence shouldn't suddenly render an image.
  const mediaHtml = block.type === "code" ? "" : buildMediaPreviewHtml(detectMedia(text));

  if (block.type === "todo") {
    el.classList.toggle("bk-checked", !!block.checked);
    el.innerHTML = `
      <span class="bk-marker bk-todo-check" contenteditable="false" data-toggle="1">${block.checked ? "☑" : "☐"}</span>
      <span class="bk-text" data-placeholder="To-do">${escHtml(text)}</span>${mediaHtml}
    `;
    return el;
  }

  if (block.type === "bullet") {
    el.innerHTML = `
      <span class="bk-marker" contenteditable="false">•</span>
      <span class="bk-text" data-placeholder="List">${escHtml(text)}</span>${mediaHtml}
    `;
    return el;
  }

  if (block.type === "numbered") {
    el.innerHTML = `
      <span class="bk-marker bk-num-marker" contenteditable="false">1.</span>
      <span class="bk-text" data-placeholder="List">${escHtml(text)}</span>${mediaHtml}
    `;
    return el;
  }

  if (block.type === "callout") {
    el.innerHTML = `
      <span class="bk-marker" contenteditable="false">💡</span>
      <span class="bk-text" data-placeholder="Callout">${escHtml(text)}</span>${mediaHtml}
    `;
    return el;
  }

  if (block.type === "code") {
    el.innerHTML = `<span class="bk-text bk-code-text" data-placeholder="Code">${escHtml(text)}</span>`;
    return el;
  }

  if (block.type === "image") {
    const src = safeUrlAttr(block.src ?? "");
    const alt = escHtml(text || "image");
    if (src) {
      el.dataset.src = src;
    }
    // The image itself is non-editable; alt text rides in the small caption
    // span below it (still part of the contenteditable surface so the user
    // can rename / caption their image inline).
    el.innerHTML = `
      <a class="bk-img-link" href="${src}" target="_blank" rel="noopener noreferrer" contenteditable="false">
        <img class="bk-img" src="${src}" alt="${alt}" loading="lazy" decoding="async" />
      </a>
      <span class="bk-text bk-img-caption" data-placeholder="Image caption (optional)">${escHtml(text)}</span>
    `;
    return el;
  }

  // paragraph, h1, h2, h3, quote
  const placeholder =
    block.type === "h1" ? "Heading 1" :
    block.type === "h2" ? "Heading 2" :
    block.type === "h3" ? "Heading 3" :
    block.type === "quote" ? "Quote" :
    "Type '/' for commands";
  el.innerHTML = `<span class="bk-text" data-placeholder="${placeholder}">${escHtml(text)}</span>${mediaHtml}`;
  return el;
}

/**
 * Refresh just the inline `<div class="bk-media">` preview for a block in
 * place. Called from the editor's input handler so media renders live as
 * the user types/pastes, without rebuilding the whole block (which would
 * blow up the cursor selection inside the contenteditable span).
 */
function refreshBlockMedia(blockEl: HTMLElement): void {
  const type = (blockEl.dataset.type as BlockType) || "paragraph";
  if (type === "divider" || type === "code") return;
  const span = blockEl.querySelector<HTMLElement>(":scope > .bk-text");
  if (!span) return;
  const text = (span.innerText ?? "").replace(/​/g, "");
  const existing = blockEl.querySelector<HTMLElement>(":scope > .bk-media");
  const html = buildMediaPreviewHtml(detectMedia(text));
  if (!html) {
    existing?.remove();
    return;
  }
  if (!existing) {
    blockEl.insertAdjacentHTML("beforeend", html);
    return;
  }
  // Cheap re-render — only swap the inner HTML so already-loaded images
  // don't blink when irrelevant fields elsewhere change.
  const fresh = document.createElement("div");
  fresh.innerHTML = html;
  const next = fresh.firstElementChild;
  if (next) existing.replaceWith(next);
}

function getTextSpan(blockEl: HTMLElement): HTMLElement | null {
  return blockEl.querySelector<HTMLElement>(".bk-text");
}

/**
 * Read a block's text for persistence.
 *
 * Normally all of it lives in the block's `.bk-text` span, but an EMPTY span has
 * no layout box, so clicking an empty block puts the caret in the `.bk-block`
 * container itself and the browser inserts the typed run as a sibling text node
 * *outside* the span. Reading the span alone therefore saved an empty string and
 * silently dropped the first line the user ever typed into a fresh document —
 * which is every first visit to the Project spec editor.
 *
 * So walk the block's children in document order and pick up both: stray text
 * nodes (whitespace-only ones come from the block templates' indentation and are
 * skipped) and the span's own text. Markers, checkboxes and media previews are
 * elements, never bare text nodes, so they can't be swept in by accident.
 *
 * Read-only by design — normalising the DOM here would move the caret mid-save.
 */
function readBlockText(blockEl: HTMLElement, span: HTMLElement | null): string {
  let hasStray = false;
  let out = "";
  for (const node of Array.from(blockEl.childNodes)) {
    if (node === span) {
      out += span.innerText;
      continue;
    }
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node.textContent ?? "";
    if (!text.trim()) continue;
    hasStray = true;
    out += text;
  }
  // No mis-homed text: keep the original single-source read exactly as it was.
  if (!hasStray) return span?.innerText ?? "";
  return out;
}

function getBlockEls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(":scope > .bk-block"));
}

function findBlockFor(node: Node | null, root: HTMLElement): HTMLElement | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n instanceof HTMLElement && n.classList.contains("bk-block")) return n;
    n = n.parentNode;
  }
  return null;
}

function caretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return range.toString().length === 0;
}

function caretAtEnd(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setStart(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return range.toString().length === 0;
}

function placeCaretAtStart(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getCaretRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  if (rect && (rect.width || rect.height || rect.left || rect.top)) return rect;
  // Fallback: rect of the focused block
  const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
  return node?.getBoundingClientRect() ?? null;
}

export function mountBlockEditor(host: HTMLElement, opts: BlockEditorOptions): BlockEditor {
  ensureStyles();

  // Clean host
  host.innerHTML = "";
  host.classList.add("bk-host");

  const status = document.createElement("div");
  status.className = "bk-status";
  status.textContent = "";
  host.appendChild(status);

  const editor = document.createElement("div");
  editor.className = "bk-editor";
  editor.contentEditable = "true";
  editor.spellcheck = true;
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-multiline", "true");
  host.appendChild(editor);

  const slash = document.createElement("div");
  slash.className = "bk-slash-menu";
  slash.style.display = "none";
  document.body.appendChild(slash);

  let blocks: Block[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savingPromise: Promise<void> | null = null;
  let pendingChange = false;
  let destroyed = false;

  // Slash menu state
  let slashActive = false;
  let slashAnchorBlockId: string | null = null;
  let slashStartOffset = 0;
  let slashQuery = "";
  let slashSelectedIndex = 0;
  let slashFiltered: SlashItem[] = SLASH_ITEMS;

  // Undo/redo history. Programmatic block mutations (slash transforms,
  // splits, merges) bypass the browser's native contentEditable undo, so we
  // run our own snapshot stack.
  interface Snapshot {
    blocks: Block[];
    caret: { blockId: string; offset: number } | null;
  }
  const HISTORY_LIMIT = 200;
  const HISTORY_DEBOUNCE_MS = 350;
  const undoStack: Snapshot[] = [];
  let redoStack: Snapshot[] = [];
  let lastSnapshot: Snapshot | null = null;
  let historyTimer: ReturnType<typeof setTimeout> | null = null;
  let isRestoring = false;

  function setStatus(text: string, kind: "saving" | "saved" | "error" | "" = "") {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function rerenderAll() {
    editor.innerHTML = "";
    if (blocks.length === 0) {
      blocks = [{ id: uid(), type: "paragraph", text: "" }];
    }
    for (const b of blocks) editor.appendChild(blockToElement(b));
  }

  function parseDom(): Block[] {
    const out: Block[] = [];
    for (const el of getBlockEls(editor)) {
      const id = el.dataset.id || uid();
      const type = (el.dataset.type as BlockType) || "paragraph";
      if (type === "divider") {
        out.push({ id, type, text: "" });
        continue;
      }
      if (type === "image") {
        // Image block: src lives on the host's data-src; caption lives in
        // the bk-img-caption span (which doubles as the alt text).
        const captionSpan = el.querySelector<HTMLElement>(":scope > .bk-img-caption");
        const text = (captionSpan?.innerText ?? "").replace(/​/g, "");
        out.push({ id, type, text, src: el.dataset.src ?? "" });
        continue;
      }
      const span = getTextSpan(el);
      const text = readBlockText(el, span).replace(/​/g, "");
      const block: Block = { id, type, text };
      if (type === "todo") block.checked = el.classList.contains("bk-checked");
      out.push(block);
    }
    return out;
  }

  function renumberBullets() {
    let counter = 0;
    let lastWasNumbered = false;
    for (const el of getBlockEls(editor)) {
      if (el.dataset.type === "numbered") {
        if (!lastWasNumbered) counter = 0;
        counter += 1;
        const marker = el.querySelector<HTMLElement>(".bk-num-marker");
        if (marker) marker.textContent = `${counter}.`;
        lastWasNumbered = true;
      } else {
        lastWasNumbered = false;
      }
    }
  }

  function scheduleSave() {
    pendingChange = true;
    if (saveTimer) clearTimeout(saveTimer);
    setStatus("Editing…", "saving");
    saveTimer = setTimeout(commitSave, SAVE_DEBOUNCE_MS);
  }

  async function commitSave() {
    if (destroyed) return;
    if (savingPromise) return;
    pendingChange = false;
    blocks = parseDom();

    // Inline mode: just notify the caller, no remote save.
    if (opts.inline) {
      try { opts.inline.onChange(blocks); } catch (err) {
        console.error("[content-editor] inline onChange failed", err);
      }
      setStatus("", "");
      if (pendingChange && !destroyed) scheduleSave();
      return;
    }

    if (!opts.client || !opts.projectId) return;

    setStatus("Saving…", "saving");
    const client = opts.client;
    const projectId = opts.projectId;
    savingPromise = (async () => {
      try {
        await client.request("kanban.projects.content.saveBlocks", {
          projectId,
          blocks,
        });
        setStatus("Saved", "saved");
      } catch (err) {
        console.error("[content-editor] save failed", err);
        setStatus("Save failed — will retry", "error");
        // Retry after a delay
        setTimeout(() => { if (!destroyed) scheduleSave(); }, 2000);
      } finally {
        savingPromise = null;
        if (pendingChange && !destroyed) scheduleSave();
      }
    })();
  }

  // ── Undo/redo history ───────────────────────────────
  function cloneBlocks(bs: Block[]): Block[] {
    return bs.map(b => ({ ...b }));
  }

  function getCaretPos(): { blockId: string; offset: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const blockEl = findBlockFor(sel.anchorNode ?? null, editor);
    if (!blockEl?.dataset.id) return null;
    const span = getTextSpan(blockEl);
    if (!span || !sel.anchorNode) return { blockId: blockEl.dataset.id, offset: 0 };
    if (span !== sel.anchorNode && !span.contains(sel.anchorNode)) {
      return { blockId: blockEl.dataset.id, offset: 0 };
    }
    const range = document.createRange();
    range.selectNodeContents(span);
    try { range.setEnd(sel.anchorNode, sel.anchorOffset); }
    catch { return { blockId: blockEl.dataset.id, offset: 0 }; }
    return { blockId: blockEl.dataset.id, offset: range.toString().length };
  }

  function placeCaretAtPos(pos: { blockId: string; offset: number }): void {
    const blockEl = editor.querySelector<HTMLElement>(
      `.bk-block[data-id="${CSS.escape(pos.blockId)}"]`,
    );
    if (!blockEl) return;
    const span = getTextSpan(blockEl);
    if (!span) return;
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    let remaining = pos.offset;
    let placed = false;
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT, null);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, remaining);
        range.collapse(true);
        placed = true;
        break;
      }
      remaining -= len;
    }
    if (!placed) {
      range.selectNodeContents(span);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function captureSnapshot(): Snapshot {
    return { blocks: cloneBlocks(parseDom()), caret: getCaretPos() };
  }

  function snapshotsEqual(a: Snapshot, b: Snapshot): boolean {
    if (a.blocks.length !== b.blocks.length) return false;
    for (let i = 0; i < a.blocks.length; i++) {
      const x = a.blocks[i];
      const y = b.blocks[i];
      if (x.id !== y.id || x.type !== y.type || x.text !== y.text) return false;
      if (!!x.checked !== !!y.checked) return false;
    }
    return true;
  }

  function commitCheckpoint(): void {
    if (isRestoring) return;
    const current = captureSnapshot();
    if (lastSnapshot && snapshotsEqual(lastSnapshot, current)) {
      lastSnapshot.caret = current.caret;
      return;
    }
    if (lastSnapshot) {
      undoStack.push(lastSnapshot);
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack = [];
    }
    lastSnapshot = current;
  }

  function scheduleCheckpoint(): void {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      historyTimer = null;
      commitCheckpoint();
    }, HISTORY_DEBOUNCE_MS);
  }

  function flushPendingCheckpoint(): void {
    if (historyTimer) {
      clearTimeout(historyTimer);
      historyTimer = null;
      commitCheckpoint();
    }
  }

  // Discrete (non-typing) mutations want their own undo step — flush any
  // pending typing checkpoint, then immediately capture the post-mutation
  // state as the new lastSnapshot.
  function recordCheckpoint(): void {
    flushPendingCheckpoint();
    commitCheckpoint();
  }

  function applySnapshot(snap: Snapshot): void {
    isRestoring = true;
    try {
      blocks = cloneBlocks(snap.blocks);
      if (blocks.length === 0) blocks = [{ id: uid(), type: "paragraph", text: "" }];
      rerenderAll();
      renumberBullets();
      if (slashActive) closeSlash();
      if (snap.caret) placeCaretAtPos(snap.caret);
    } finally {
      isRestoring = false;
    }
  }

  function undo(): void {
    flushPendingCheckpoint();
    if (undoStack.length === 0) return;
    const current = captureSnapshot();
    redoStack.push(current);
    if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
    const target = undoStack.pop()!;
    applySnapshot(target);
    lastSnapshot = captureSnapshot();
    scheduleSave();
  }

  function redo(): void {
    flushPendingCheckpoint();
    if (redoStack.length === 0) return;
    const current = captureSnapshot();
    undoStack.push(current);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    const target = redoStack.pop()!;
    applySnapshot(target);
    lastSnapshot = captureSnapshot();
    scheduleSave();
  }

  function resetHistory(): void {
    undoStack.length = 0;
    redoStack = [];
    if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
    lastSnapshot = captureSnapshot();
  }

  // ── Slash menu ──────────────────────────────────────
  function openSlash(blockEl: HTMLElement, atOffset: number) {
    slashActive = true;
    slashAnchorBlockId = blockEl.dataset.id ?? null;
    slashStartOffset = atOffset;
    slashQuery = "";
    slashSelectedIndex = 0;
    slashFiltered = SLASH_ITEMS;
    renderSlash();
    positionSlash();
    slash.style.display = "block";
  }

  function closeSlash() {
    slashActive = false;
    slashAnchorBlockId = null;
    slash.style.display = "none";
  }

  function renderSlash() {
    const q = slashQuery.toLowerCase();
    slashFiltered = q
      ? SLASH_ITEMS.filter(i =>
          i.label.toLowerCase().includes(q) ||
          i.keywords.some(k => k.includes(q)))
      : SLASH_ITEMS;
    if (slashFiltered.length === 0) {
      slash.innerHTML = `<div class="bk-slash-empty">No matches for "/${escHtml(slashQuery)}"</div>`;
      return;
    }
    if (slashSelectedIndex >= slashFiltered.length) slashSelectedIndex = 0;
    slash.innerHTML = `
      <div class="bk-slash-header">Insert block</div>
      ${slashFiltered.map((item, i) => `
        <div class="bk-slash-item ${i === slashSelectedIndex ? "bk-slash-selected" : ""}" data-idx="${i}">
          <span class="bk-slash-icon">${escHtml(item.icon)}</span>
          <div class="bk-slash-meta">
            <div class="bk-slash-label">${escHtml(item.label)}</div>
            <div class="bk-slash-hint">${escHtml(item.hint)}</div>
          </div>
        </div>
      `).join("")}
    `;
  }

  function positionSlash() {
    const rect = getCaretRect();
    if (!rect) return;
    // Viewport-relative (slash menu uses position: fixed)
    const menuW = 280;
    const menuH = 320;
    let top = rect.bottom + 4;
    let left = rect.left;
    if (top + menuH > window.innerHeight) top = Math.max(8, rect.top - menuH - 4);
    if (left + menuW > window.innerWidth) left = Math.max(8, window.innerWidth - menuW - 8);
    slash.style.top = `${top}px`;
    slash.style.left = `${left}px`;
  }

  function applySlashSelection() {
    const item = slashFiltered[slashSelectedIndex];
    if (!item || !slashAnchorBlockId) { closeSlash(); return; }
    const blockEl = editor.querySelector<HTMLElement>(`.bk-block[data-id="${CSS.escape(slashAnchorBlockId)}"]`);
    if (!blockEl) { closeSlash(); return; }

    // Strip the "/query" we typed
    const span = getTextSpan(blockEl);
    if (span) {
      const text = span.innerText;
      const cut = Math.max(0, slashStartOffset);
      const after = text.slice(0, cut) + text.slice(cut + 1 + slashQuery.length);
      span.textContent = after;
    }

    transformBlock(blockEl, item.type);
    closeSlash();
    recordCheckpoint();
    scheduleSave();
  }

  function transformBlock(blockEl: HTMLElement, newType: BlockType) {
    const id = blockEl.dataset.id || uid();
    const span = getTextSpan(blockEl);
    const text = newType === "divider" ? "" : (span?.innerText ?? "");
    const newBlock: Block = { id, type: newType, text };
    if (newType === "todo") newBlock.checked = false;
    const newEl = blockToElement(newBlock);
    blockEl.replaceWith(newEl);

    if (newType === "divider") {
      // After a divider, ensure a paragraph follows (so user can continue typing)
      let next = newEl.nextElementSibling as HTMLElement | null;
      if (!next || !next.classList.contains("bk-block")) {
        const p: Block = { id: uid(), type: "paragraph", text: "" };
        next = blockToElement(p);
        newEl.after(next);
      }
      const ts = next ? getTextSpan(next) : null;
      if (ts) placeCaretAtStart(ts);
    } else {
      const ts = getTextSpan(newEl);
      if (ts) placeCaretAtEnd(ts);
    }

    renumberBullets();
  }

  function insertBlockAfter(refEl: HTMLElement, type: BlockType, init?: Partial<Block>): HTMLElement {
    const block: Block = { id: uid(), type, text: "", ...init };
    if (type === "todo" && block.checked === undefined) block.checked = false;
    const el = blockToElement(block);
    refEl.after(el);
    return el;
  }

  // ── Markdown shortcuts ──────────────────────────────
  function tryMarkdownShortcut(blockEl: HTMLElement): boolean {
    const span = getTextSpan(blockEl);
    if (!span) return false;
    const text = span.innerText;
    const map: Array<[RegExp, BlockType]> = [
      [/^# $/, "h1"],
      [/^## $/, "h2"],
      [/^### $/, "h3"],
      [/^- $/, "bullet"],
      [/^\* $/, "bullet"],
      [/^1\. $/, "numbered"],
      [/^\[\] $/, "todo"],
      [/^\[ \] $/, "todo"],
      [/^> $/, "quote"],
      [/^``` $/, "code"],
      [/^--- $/, "divider"],
    ];
    for (const [re, type] of map) {
      if (re.test(text)) {
        span.textContent = "";
        transformBlock(blockEl, type);
        return true;
      }
    }
    return false;
  }

  // ── Event wiring ────────────────────────────────────
  function onKeyDown(e: KeyboardEvent) {
    // Undo / redo. Always intercept these so the browser's native undo
    // (which doesn't see our programmatic block transforms) never runs.
    const isMeta = e.ctrlKey || e.metaKey;
    if (isMeta && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (isMeta && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      redo();
      return;
    }

    // Slash-menu navigation
    if (slashActive) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashSelectedIndex = (slashSelectedIndex + 1) % Math.max(slashFiltered.length, 1);
        renderSlash();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashSelectedIndex = (slashSelectedIndex - 1 + slashFiltered.length) % Math.max(slashFiltered.length, 1);
        renderSlash();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applySlashSelection();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlash();
        return;
      }
      // Backspace inside slash query
      if (e.key === "Backspace" && slashQuery.length === 0) {
        closeSlash();
        // fall through so the default backspace runs
      }
    }

    const sel = window.getSelection();
    const blockEl = findBlockFor(sel?.anchorNode ?? null, editor);

    if (e.key === "/" && blockEl && !slashActive) {
      // Open slash menu after the "/" is inserted
      const span = getTextSpan(blockEl);
      if (span) {
        // Defer so the "/" is in the DOM
        setTimeout(() => {
          if (!slashActive) {
            const offset = (span.innerText.lastIndexOf("/"));
            openSlash(blockEl, offset);
          }
        }, 0);
      }
      return;
    }

    if (e.key === "Enter" && !e.shiftKey && blockEl) {
      e.preventDefault();
      const span = getTextSpan(blockEl);
      const type = (blockEl.dataset.type as BlockType) || "paragraph";

      // Empty list item / todo / quote → convert to paragraph instead of new block
      if (span && span.innerText.trim() === "" &&
          (type === "bullet" || type === "numbered" || type === "todo" || type === "quote")) {
        transformBlock(blockEl, "paragraph");
        recordCheckpoint();
        scheduleSave();
        return;
      }

      // Continue list/todo with same type
      const continueType: BlockType =
        type === "bullet" || type === "numbered" || type === "todo" ? type :
        type === "h1" || type === "h2" || type === "h3" || type === "code" ? "paragraph" :
        type === "quote" || type === "callout" ? type :
        "paragraph";

      const newEl = insertBlockAfter(blockEl, continueType);
      const ts = getTextSpan(newEl);
      if (ts) placeCaretAtStart(ts);
      renumberBullets();
      recordCheckpoint();
      scheduleSave();
      return;
    }

    if (e.key === "Backspace" && blockEl) {
      const span = getTextSpan(blockEl);
      const type = (blockEl.dataset.type as BlockType) || "paragraph";
      const isEmpty = !span || span.innerText.length === 0;
      const atStart = span ? caretAtStart(span) : true;

      if (isEmpty && type !== "paragraph" && type !== "divider") {
        e.preventDefault();
        transformBlock(blockEl, "paragraph");
        recordCheckpoint();
        scheduleSave();
        return;
      }
      if (isEmpty && type === "paragraph") {
        const prev = blockEl.previousElementSibling as HTMLElement | null;
        if (prev && prev.classList.contains("bk-block")) {
          e.preventDefault();
          const prevSpan = getTextSpan(prev);
          blockEl.remove();
          if (prevSpan) placeCaretAtEnd(prevSpan);
          else if (prev.dataset.type === "divider") {
            // Skip dividers — focus block before it
            const before = prev.previousElementSibling as HTMLElement | null;
            const beforeSpan = before ? getTextSpan(before) : null;
            if (beforeSpan) placeCaretAtEnd(beforeSpan);
          }
          renumberBullets();
          recordCheckpoint();
          scheduleSave();
          return;
        }
      }
      if (atStart && !isEmpty && type === "paragraph") {
        // Merge with previous block
        const prev = blockEl.previousElementSibling as HTMLElement | null;
        if (prev && prev.classList.contains("bk-block") && prev.dataset.type !== "divider") {
          const prevSpan = getTextSpan(prev);
          if (prevSpan && span) {
            e.preventDefault();
            const insertPoint = prevSpan.innerText.length;
            prevSpan.textContent = prevSpan.innerText + span.innerText;
            blockEl.remove();
            // Place caret at the original join point
            const range = document.createRange();
            const textNode = prevSpan.firstChild ?? prevSpan;
            try {
              range.setStart(textNode, Math.min(insertPoint, prevSpan.innerText.length));
              range.collapse(true);
              const s = window.getSelection();
              s?.removeAllRanges();
              s?.addRange(range);
            } catch {/* ignore */}
            renumberBullets();
            recordCheckpoint();
            scheduleSave();
            return;
          }
        }
      }
    }

    if (e.key === "Tab" && blockEl) {
      // Indent only meaningful for lists; we keep it simple — prevent focus loss
      e.preventDefault();
    }
  }

  function onInput(_e: Event) {
    // Slash-menu query update
    if (slashActive && slashAnchorBlockId) {
      const blockEl = editor.querySelector<HTMLElement>(`.bk-block[data-id="${CSS.escape(slashAnchorBlockId)}"]`);
      const span = blockEl ? getTextSpan(blockEl) : null;
      if (span) {
        const text = span.innerText;
        const slashIdx = text.indexOf("/", slashStartOffset);
        if (slashIdx === -1) {
          closeSlash();
        } else {
          const after = text.slice(slashIdx + 1);
          // Stop at whitespace
          const wsMatch = after.match(/\s/);
          slashQuery = wsMatch ? after.slice(0, wsMatch.index!) : after;
          slashSelectedIndex = 0;
          renderSlash();
          positionSlash();
        }
      } else {
        closeSlash();
      }
    }

    // Markdown shortcuts
    const sel = window.getSelection();
    const blockEl = findBlockFor(sel?.anchorNode ?? null, editor);
    let mdTransformed = false;
    if (blockEl && !slashActive) {
      mdTransformed = tryMarkdownShortcut(blockEl);
    }

    if (mdTransformed) {
      // Block-type change is its own discrete undo step.
      recordCheckpoint();
    } else {
      // Plain typing — coalesce into a single undo step per ~burst.
      scheduleCheckpoint();
    }
    // Live media preview: refresh image/video/audio renderings on the
    // currently-edited block. Cheap (regex over one block's text) and
    // lets a pasted URL or markdown image render immediately without
    // waiting for a save round-trip.
    if (blockEl) {
      try {
        refreshBlockMedia(blockEl);
      } catch {
        /* defensive — preview is non-critical */
      }
    }
    scheduleSave();
  }

  function onClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target?.dataset?.toggle === "1") {
      const block = findBlockFor(target, editor);
      if (block && block.dataset.type === "todo") {
        block.classList.toggle("bk-checked");
        target.textContent = block.classList.contains("bk-checked") ? "☑" : "☐";
        recordCheckpoint();
        scheduleSave();
      }
    }
  }

  function onSlashClick(e: MouseEvent) {
    const target = (e.target as HTMLElement).closest<HTMLElement>(".bk-slash-item");
    if (!target) return;
    const idx = parseInt(target.dataset.idx ?? "-1", 10);
    if (Number.isFinite(idx) && idx >= 0) {
      slashSelectedIndex = idx;
      applySlashSelection();
    }
  }

  function onDocClickAway(e: MouseEvent) {
    if (!slashActive) return;
    if (slash.contains(e.target as Node)) return;
    if (editor.contains(e.target as Node)) return;
    closeSlash();
  }

  function onPaste(e: ClipboardEvent) {
    // Image paste — clipboard contains a binary image (screenshot tools,
    // copy-image-from-page, etc.). Insert a real `image` block instead of
    // text so the renderer produces a proper `<img>` tag bypassing the
    // markdown-detection regex (which is brittle with very long data URLs).
    const items = e.clipboardData?.items;
    if (items && items.length > 0) {
      const imageItem = Array.from(items).find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (imageItem) {
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = String(reader.result ?? "");
          if (!dataUrl) return;
          insertImageBlockAtCaret(dataUrl);
          // Manual save trigger — `onInput` would also work but we already
          // know the structural edit happened.
          recordCheckpoint();
          scheduleSave();
        };
        reader.readAsDataURL(file);
        return;
      }
    }

    // Force plain-text paste so we don't import foreign formatting
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    insertTextAtCaret(text);
    onInput(new Event("input"));
    // A paste is a discrete operation — collapse the just-scheduled typing
    // checkpoint so paste shows up as one undo step, not two.
    recordCheckpoint();
  }

  /**
   * Drop a fresh `image` block immediately after whichever block currently
   * owns the caret, then position the cursor in a fresh empty paragraph
   * below it so the user can keep typing.
   *
   * Mutates the in-memory `blocks` array first then re-renders, otherwise
   * the trailing rerenderAll() would wipe DOM-only edits because it
   * rebuilds purely from `blocks`.
   */
  function insertImageBlockAtCaret(src: string): void {
    // Capture which block owns the caret BEFORE we replace the DOM.
    const sel = window.getSelection();
    const anchor = sel?.anchorNode ?? null;
    const hostEl = findBlockFor(anchor, editor);
    const fresh = parseDom();
    const idx = hostEl
      ? fresh.findIndex((b) => b.id === hostEl.dataset.id)
      : fresh.length - 1;
    const insertAt = idx >= 0 ? idx + 1 : fresh.length;
    const imageBlock: Block = { id: uid(), type: "image", text: "", src };
    const tailBlock: Block = { id: uid(), type: "paragraph", text: "" };
    fresh.splice(insertAt, 0, imageBlock, tailBlock);
    blocks = fresh;
    rerenderAll();
    renumberBullets();
    // Place the caret in the fresh paragraph that follows the image.
    const tailEl = editor.querySelector<HTMLElement>(`.bk-block[data-id="${CSS.escape(tailBlock.id)}"]`);
    const tailSpan = tailEl ? getTextSpan(tailEl) : null;
    if (tailSpan) placeCaretAtEnd(tailSpan);
  }

  /**
   * Insert plain text at the current selection / caret. Used by both the
   * regular text-paste path and the image-paste path (which inserts the
   * `![image](dataurl)` markdown blob at the caret).
   */
  function insertTextAtCaret(text: string): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function onAncestorScroll() {
    if (slashActive) positionSlash();
  }

  editor.addEventListener("keydown", onKeyDown);
  editor.addEventListener("input", onInput);
  editor.addEventListener("click", onClick);
  editor.addEventListener("paste", onPaste);
  slash.addEventListener("mousedown", (ev) => ev.preventDefault());
  slash.addEventListener("click", onSlashClick);
  document.addEventListener("mousedown", onDocClickAway);
  // The editor may live inside a scrollable container (e.g. fixed-position
  // panel with overflow-y: auto). Listen in capture mode so we catch any
  // ancestor scroll and keep the slash menu glued to the caret.
  window.addEventListener("scroll", onAncestorScroll, true);
  window.addEventListener("resize", onAncestorScroll);

  async function load() {
    if (opts.inline) {
      const seed = opts.inline.initialBlocks;
      blocks = seed.length ? seed : [{ id: uid(), type: "paragraph", text: "" }];
      rerenderAll();
      renumberBullets();
      setStatus("", "");
      resetHistory();
      return;
    }
    if (!opts.client || !opts.projectId) {
      blocks = [{ id: uid(), type: "paragraph", text: "" }];
      rerenderAll();
      renumberBullets();
      resetHistory();
      return;
    }
    setStatus("Loading…", "saving");
    try {
      const resp = await opts.client.request("kanban.projects.content.getBlocks", { projectId: opts.projectId });
      const loaded = (resp?.blocks ?? []) as Block[];
      blocks = loaded.length ? loaded : [{ id: uid(), type: "paragraph", text: "" }];
    } catch (err) {
      console.error("[content-editor] load failed", err);
      blocks = [{ id: uid(), type: "paragraph", text: "" }];
      setStatus("Couldn't load — starting fresh", "error");
    }
    rerenderAll();
    renumberBullets();
    setStatus("Ready", "saved");
    setTimeout(() => { if (status.dataset.kind === "saved" && status.textContent === "Ready") setStatus("", ""); }, 1000);
    resetHistory();
  }

  function setBlocks(next: Block[]) {
    blocks = next.length ? next : [{ id: uid(), type: "paragraph", text: "" }];
    rerenderAll();
    renumberBullets();
    resetHistory();
  }

  // Hide the status pill in inline mode — the host (Lit component / parent)
  // owns persistence feedback there.
  if (opts.inline) status.style.display = "none";
  if (opts.placeholder) {
    editor.dataset.placeholder = opts.placeholder;
  }

  void load();

  // Expose a programmatic handle on the host element so the agent's
  // ui_control "editor" view can find this block editor by DOM-querying
  // `.bk-host` and operate on it like a line-based editor (read blocks as
  // lines, replace/insert/delete blocks, paint highlight overlays). The
  // handle exposes a stable shape that doesn't depend on the
  // mountBlockEditor closure's identity.
  const handle = {
    kind: "blocks" as const,
    getBlocks: () => blocks.slice(),
    applyBlocks: (next: Block[]) => {
      setBlocks(next);
      scheduleSave();
    },
    setBlockText: (id: string, text: string) => {
      const idx = blocks.findIndex((b) => b.id === id);
      if (idx < 0) return false;
      blocks = blocks.map((b, i) => (i === idx ? { ...b, text } : b));
      rerenderAll();
      scheduleSave();
      return true;
    },
    blockElement: (id: string) =>
      editor.querySelector<HTMLElement>(`.bk-block[data-id="${CSS.escape(id)}"]`),
    editorContainer: () => editor,
    newBlock: (type: BlockType, text: string): Block => ({ id: uid(), type, text }),
  };
  (host as unknown as { __blockEditor?: typeof handle }).__blockEditor = handle;

  return {
    destroy() {
      destroyed = true;
      if (saveTimer) clearTimeout(saveTimer);
      if (historyTimer) clearTimeout(historyTimer);
      // Flush any pending change synchronously? Best-effort — fire-and-forget.
      if (pendingChange) void commitSave();
      editor.removeEventListener("keydown", onKeyDown);
      editor.removeEventListener("input", onInput);
      editor.removeEventListener("click", onClick);
      editor.removeEventListener("paste", onPaste);
      slash.removeEventListener("click", onSlashClick);
      document.removeEventListener("mousedown", onDocClickAway);
      window.removeEventListener("scroll", onAncestorScroll, true);
      window.removeEventListener("resize", onAncestorScroll);
      if (slash.parentElement) slash.parentElement.removeChild(slash);
      host.classList.remove("bk-host");
      delete (host as unknown as { __blockEditor?: unknown }).__blockEditor;
    },
    refresh: load,
    setBlocks,
  };
}

const EDITOR_CSS = `
.bk-host {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  font-family: inherit;
  color: var(--c-text, #e5e5e5);
}
.bk-status {
  align-self: flex-end;
  font-size: 0.72rem;
  color: #888;
  min-height: 14px;
  padding-right: 4px;
  user-select: none;
}
.bk-status[data-kind="saving"] { color: #eab308; }
.bk-status[data-kind="saved"] { color: #22c55e; }
.bk-status[data-kind="error"] { color: #ef4444; }

.bk-editor {
  outline: none;
  padding: 4px 0 240px;
  background: transparent;
  border: none;
  border-radius: 0;
  line-height: 1.7;
  font-size: 1rem;
  color: var(--c-text, #e8e8ea);
  caret-color: var(--c-accent, #a855f7);
}
.bk-editor:focus { border: none; }

.bk-block {
  position: relative;
  padding: 3px 2px;
  display: block;
  border-radius: 3px;
}
.bk-block:hover { background: rgba(255,255,255,0.02); }
.bk-block.bk-bullet,
.bk-block.bk-numbered,
.bk-block.bk-todo,
.bk-block.bk-callout {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.bk-marker {
  flex-shrink: 0;
  user-select: none;
  color: #888;
  width: 1.5em;
  text-align: center;
}
.bk-todo .bk-todo-check {
  cursor: pointer;
  font-size: 1.1em;
}
.bk-todo.bk-checked .bk-text {
  color: #888;
  text-decoration: line-through;
}
.bk-callout {
  background: rgba(234,179,8,0.08);
  border-left: 3px solid #eab308;
  padding: 8px 12px;
  border-radius: 4px;
  margin: 4px 0;
}
.bk-quote {
  border-left: 3px solid #6b7280;
  padding-left: 12px;
  color: #b5b5b5;
  font-style: italic;
}
.bk-h1 { font-size: 2rem; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; margin: 24px 0 6px; }
.bk-h2 { font-size: 1.55rem; font-weight: 700; line-height: 1.3; margin: 20px 0 4px; }
.bk-h3 { font-size: 1.22rem; font-weight: 600; line-height: 1.35; margin: 16px 0 2px; }
.bk-code {
  background: rgba(0,0,0,0.4);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 6px;
  padding: 8px 12px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.85rem;
  white-space: pre-wrap;
  margin: 4px 0;
}
.bk-code-text { display: block; white-space: pre-wrap; }
.bk-divider { padding: 6px 0; }

/* Image block — first-class block type with proper <img> rendering. */
.bk-block.bk-image {
  display: block;
  padding: 6px 2px 8px;
  margin: 8px 0;
}
.bk-img-link {
  display: block;
  width: fit-content;
  max-width: 100%;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  transition: border-color 160ms ease, transform 160ms ease;
}
.bk-img-link:hover {
  border-color: rgba(255,255,255,0.18);
  transform: translateY(-1px);
}
.bk-img {
  display: block;
  max-width: 100%;
  max-height: 480px;
  height: auto;
  background: rgba(0, 0, 0, 0.4);
}
.bk-img-caption {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  font-style: italic;
}
.bk-img-caption:empty::before {
  content: attr(data-placeholder);
  color: rgba(255, 255, 255, 0.3);
}
.bk-hr {
  border: 0;
  border-top: 1px solid rgba(255,255,255,0.18);
  margin: 0;
}
.bk-text { display: inline; outline: none; flex: 1; word-break: break-word; }
.bk-text:empty::before {
  content: attr(data-placeholder);
  color: #555;
  pointer-events: none;
}

.bk-slash-menu {
  position: fixed;
  z-index: 100000;
  width: 280px;
  max-height: 320px;
  overflow-y: auto;
  background: #1f1f23;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.6);
  padding: 4px;
  font-size: 0.88rem;
}
.bk-slash-header {
  font-size: 0.7rem;
  text-transform: uppercase;
  color: #888;
  padding: 6px 8px 4px;
  letter-spacing: 0.04em;
}
.bk-slash-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 5px;
  cursor: pointer;
  color: var(--c-text, #e5e5e5);
}
.bk-slash-item:hover,
.bk-slash-item.bk-slash-selected {
  background: rgba(168,85,247,0.18);
}
.bk-slash-icon {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  background: rgba(255,255,255,0.06);
  border-radius: 5px;
  font-weight: 600;
  font-size: 0.85rem;
}
.bk-slash-meta { display: flex; flex-direction: column; }
.bk-slash-label { font-weight: 500; }
.bk-slash-hint { font-size: 0.75rem; color: #888; }
.bk-slash-empty { padding: 10px; color: #888; font-size: 0.85rem; }

/* ── Inline media previews ──────────────────────────────────────
   Rendered alongside (after) a block's editable text span when the
   text contains image/video/audio URLs or markdown image syntax.
   The wrapper is contenteditable=false so the cursor never lands
   inside; the text span keeps the source so the operator can edit
   the link.
*/
.bk-media {
  margin: 6px 0 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 100%;
}
.bk-media-link {
  display: inline-block;
  max-width: 100%;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.06);
  background: rgba(0,0,0,0.25);
  cursor: zoom-in;
}
.bk-media-img {
  display: block;
  max-width: 100%;
  max-height: 480px;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 8px;
  background:
    linear-gradient(45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.03) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.03) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.bk-media-vid {
  display: block;
  max-width: 100%;
  max-height: 480px;
  width: 100%;
  border-radius: 8px;
  background: #000;
}
.bk-media-aud {
  display: block;
  width: 100%;
  max-width: 480px;
  height: 40px;
}
`;
