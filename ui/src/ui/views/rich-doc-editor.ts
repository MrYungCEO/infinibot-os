/**
 * Rich Document Editor — a full WYSIWYG, Google-Docs / Notion-style editor
 * for project AND task content pages.
 *
 * Unlike the legacy block editor (project-content-editor.ts), this is a single
 * contenteditable "document" surface with a persistent formatting toolbar:
 *   - Headings H1/H2/H3, paragraph
 *   - Bold / Italic / Underline / Strikethrough / inline code
 *   - Text color + highlight
 *   - Bulleted / numbered / checklist
 *   - Quote, callout, code block, divider, table, image, link
 *   - Left / center / right alignment
 *   - "/" slash command menu
 *
 * Persistence stays 100% compatible with the existing content pipeline: the
 * document is serialized to the same `Block[]` shape used by
 * kanban.projects.content.* and kanban.tasks.content.* (getBlocks/saveBlocks),
 * so what an agent writes via set_*_content_md and what a human types here are
 * the same store. Inline formatting is preserved as a sanitized inline-HTML
 * subset inside each block's `text`.
 *
 * Hosts other than kanban (e.g. Content Studio) pass `rpc` to point the editor
 * at their own getBlocks/saveBlocks methods, and `media` hooks to get upload
 * (picker, drag-and-drop, paste), video/audio blocks and AI image generation.
 */

import "./work-glass/remaining.css";

export type RichBlockType =
  | "paragraph" | "h1" | "h2" | "h3"
  | "bullet" | "numbered" | "todo"
  | "quote" | "callout" | "code" | "divider"
  | "image" | "table" | "html"
  | "video" | "audio";

export interface RichBlock {
  id: string;
  type: RichBlockType;
  text: string;
  checked?: boolean;
  language?: string;
  src?: string;
  align?: "left" | "center" | "right";
  /** Host media id for image/video/audio blocks (optional). */
  mediaId?: string;
}

/** A media file the host stored and can embed. */
export interface RichDocMedia {
  url: string;
  kind: "image" | "video" | "audio" | "file";
  caption?: string;
  id?: string;
}

export interface RichDocMediaHooks {
  /** Store files (picker, drop, paste) and return what to embed. */
  upload?: (files: File[]) => Promise<RichDocMedia[]>;
  /** Optional generator (e.g. FlyPic); resolves null when cancelled. */
  generateImage?: () => Promise<RichDocMedia | null>;
}

export interface RichDocTarget {
  /** "project" → kanban.projects.content.*  |  "task" → kanban.tasks.content.* */
  kind: "project" | "task";
  id: string;
}

export interface RichDocEditorOptions {
  client: { request: (method: string, params: any) => Promise<any> };
  target: RichDocTarget;
  placeholder?: string;
  /** Overrides the kanban methods: `{ getBlocks, saveBlocks, params }`. */
  rpc?: { getBlocks: string; saveBlocks: string; params: Record<string, unknown> };
  media?: RichDocMediaHooks;
  /** Called after every successful save. */
  onSaved?: (blocks: RichBlock[]) => void;
}

export interface RichDocEditor {
  destroy(): void;
  reload(): void;
  /** Embeds media at the caret (or the end of the page). */
  insertMedia(media: RichDocMedia): void;
}

const SAVE_DEBOUNCE_MS = 600;

function uid(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Inline sanitizer ────────────────────────────────────────────────────
// Accepts arbitrary contenteditable HTML (or plain legacy text) and returns a
// safe inline-only HTML string. Unknown tags collapse to their text; bare
// `<`/`&` become escaped entities. This is what we store in a block's `text`.
const INLINE_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "A", "SPAN", "MARK", "CODE", "BR", "SUB", "SUP"]);

function sanitizeInline(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html ?? "";
  const walk = (node: Node): string => {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += escHtml(child.textContent ?? "");
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        const tag = el.tagName;
        if (tag === "BR") {
          out += "<br>";
          return;
        }
        if (!INLINE_TAGS.has(tag)) {
          out += walk(el);
          return;
        }
        if (tag === "A") {
          const href = el.getAttribute("href") || "";
          const safe = /^(https?:|mailto:|moltbot:|\/|#)/i.test(href) ? href : "#";
          out += `<a href="${escHtml(safe)}" target="_blank" rel="noopener noreferrer">${walk(el)}</a>`;
          return;
        }
        if (tag === "SPAN") {
          const style = el.getAttribute("style") || "";
          const keep: string[] = [];
          const color = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
          const bg = /background(?:-color)?\s*:\s*([^;]+)/i.exec(style);
          const fw = /font-weight\s*:\s*([^;]+)/i.exec(style);
          const fs = /font-style\s*:\s*([^;]+)/i.exec(style);
          const td = /text-decoration[^:]*:\s*([^;]+)/i.exec(style);
          if (color) keep.push(`color:${color[1]!.trim()}`);
          if (bg) keep.push(`background-color:${bg[1]!.trim()}`);
          if (fw && /bold|[6-9]00/i.test(fw[1]!)) keep.push(`font-weight:${fw[1]!.trim()}`);
          if (fs && /italic/i.test(fs[1]!)) keep.push(`font-style:${fs[1]!.trim()}`);
          if (td && /(underline|line-through)/i.test(td[1]!)) keep.push(`text-decoration:${td[1]!.trim()}`);
          const inner = walk(el);
          out += keep.length ? `<span style="${escHtml(keep.join(";"))}">${inner}</span>` : inner;
          return;
        }
        // b/strong/i/em/u/s/strike/mark/code/sub/sup — keep tag, recurse
        const t = tag.toLowerCase();
        out += `<${t}>${walk(el)}</${t}>`;
      }
    });
    return out;
  };
  return walk(tpl.content).replace(/​/g, "").trim();
}

function isEmptyInline(html: string): boolean {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  // A lone <br> is what contentEditable puts in an empty paragraph — treat it
  // as empty. Only real text or an image counts as content.
  return (tmp.textContent ?? "").replace(/​/g, "").trim().length === 0 && !tmp.querySelector("img");
}

// ── Block[] → document HTML ─────────────────────────────────────────────
function blocksToHtml(blocks: RichBlock[]): string {
  if (!blocks || blocks.length === 0) {
    return `<p class="rd-block" data-type="paragraph"><br></p>`;
  }
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    const align = b.align ? ` style="text-align:${b.align}"` : "";
    if (b.type === "bullet" || b.type === "numbered") {
      const tag = b.type === "bullet" ? "ul" : "ol";
      const items: string[] = [];
      while (i < blocks.length && blocks[i]!.type === b.type) {
        items.push(`<li>${sanitizeInline(blocks[i]!.text) || "<br>"}</li>`);
        i++;
      }
      out.push(`<${tag} class="rd-block rd-list" data-type="${b.type}">${items.join("")}</${tag}>`);
      continue;
    }
    i++;
    switch (b.type) {
      case "h1": case "h2": case "h3": {
        const n = b.type[1];
        out.push(`<h${n} class="rd-block" data-type="${b.type}"${align}>${sanitizeInline(b.text) || "<br>"}</h${n}>`);
        break;
      }
      case "quote":
        out.push(`<blockquote class="rd-block rd-quote" data-type="quote"${align}>${sanitizeInline(b.text) || "<br>"}</blockquote>`);
        break;
      case "callout":
        out.push(`<div class="rd-block rd-callout" data-type="callout"><span class="rd-callout-icon" contenteditable="false">💡</span><span class="rd-inline rd-callout-text">${sanitizeInline(b.text) || "<br>"}</span></div>`);
        break;
      case "todo":
        out.push(`<div class="rd-block rd-todo${b.checked ? " rd-checked" : ""}" data-type="todo" data-checked="${b.checked ? "1" : "0"}"><span class="rd-check" contenteditable="false">${b.checked ? "☑" : "☐"}</span><span class="rd-inline rd-todo-text">${sanitizeInline(b.text) || "<br>"}</span></div>`);
        break;
      case "code":
        out.push(`<pre class="rd-block rd-code" data-type="code"><code>${escHtml(b.text)}</code></pre>`);
        break;
      case "divider":
        out.push(`<div class="rd-block rd-divider-wrap" data-type="divider" contenteditable="false"><hr class="rd-divider"></div>`);
        break;
      case "image":
        out.push(`<figure class="rd-block rd-figure" data-type="image" data-src="${escHtml(b.src || "")}" contenteditable="false"><img class="rd-img" src="${escHtml(b.src || "")}" alt="${escHtml(b.text || "")}" loading="lazy"><figcaption class="rd-inline rd-caption" contenteditable="true" data-placeholder="Caption…">${escHtml(b.text || "")}</figcaption></figure>`);
        break;
      case "video":
      case "audio":
        out.push(mediaFigureHtml(b.type, b.src || "", b.text || "", b.mediaId));
        break;
      case "table":
        out.push(`<div class="rd-block rd-table-wrap" data-type="table">${b.text || ""}</div>`);
        break;
      case "html":
        out.push(`<div class="rd-block" data-type="html">${sanitizeInline(b.text)}</div>`);
        break;
      default:
        out.push(`<p class="rd-block" data-type="paragraph"${align}>${sanitizeInline(b.text) || "<br>"}</p>`);
    }
  }
  return out.join("");
}

function mediaFigureHtml(kind: "image" | "video" | "audio", src: string, caption: string, mediaId?: string): string {
  const s = escHtml(src);
  const idAttr = mediaId ? ` data-media-id="${escHtml(mediaId)}"` : "";
  const body =
    kind === "video"
      ? `<video class="rd-video" src="${s}" controls preload="metadata" playsinline></video>`
      : kind === "audio"
        ? `<audio class="rd-audio" src="${s}" controls preload="metadata"></audio>`
        : `<img class="rd-img" src="${s}" alt="${escHtml(caption)}" loading="lazy">`;
  return `<figure class="rd-block rd-figure rd-media-${kind}" data-type="${kind}" data-src="${s}"${idAttr} contenteditable="false">${body}<figcaption class="rd-inline rd-caption" contenteditable="true" data-placeholder="Caption…">${escHtml(caption)}</figcaption></figure>`;
}

// ── document HTML → Block[] ─────────────────────────────────────────────
function alignOf(el: HTMLElement): RichBlock["align"] | undefined {
  const a = (el.style.textAlign || "").toLowerCase();
  if (a === "center" || a === "right" || a === "left") return a;
  return undefined;
}

function htmlToBlocks(root: HTMLElement): RichBlock[] {
  const out: RichBlock[] = [];
  const push = (b: Omit<RichBlock, "id">) => out.push({ id: uid(), ...b });

  const handleEl = (el: HTMLElement) => {
    const tag = el.tagName;
    const dtype = el.dataset.type as RichBlockType | undefined;
    if (tag === "HR" || dtype === "divider") { push({ type: "divider", text: "" }); return; }
    if (tag === "UL" || tag === "OL") {
      const isTodo = el.classList.contains("rd-todo-list");
      el.querySelectorAll(":scope > li").forEach((li) => {
        const lel = li as HTMLElement;
        const checked = lel.dataset.checked === "1" || lel.getAttribute("data-checked") === "true";
        push({ type: isTodo ? "todo" : tag === "UL" ? "bullet" : "numbered", text: sanitizeInline(lel.innerHTML), checked });
      });
      return;
    }
    if (dtype === "todo" || el.classList.contains("rd-todo")) {
      const txt = el.querySelector(".rd-todo-text");
      push({ type: "todo", text: sanitizeInline(txt ? (txt as HTMLElement).innerHTML : el.innerHTML), checked: el.dataset.checked === "1" });
      return;
    }
    if (dtype === "callout" || el.classList.contains("rd-callout")) {
      const txt = el.querySelector(".rd-callout-text");
      push({ type: "callout", text: sanitizeInline(txt ? (txt as HTMLElement).innerHTML : el.innerHTML) });
      return;
    }
    if (tag === "PRE" || dtype === "code") {
      push({ type: "code", text: el.textContent ?? "" });
      return;
    }
    if (dtype === "video" || dtype === "audio") {
      const cap = el.querySelector(".rd-caption");
      const mediaId = el.dataset.mediaId;
      push({ type: dtype, src: el.dataset.src || "", text: (cap?.textContent || "").trim(), ...(mediaId ? { mediaId } : {}) });
      return;
    }
    if (el.dataset.type === "uploading") return;
    if (tag === "FIGURE" || dtype === "image") {
      const img = el.querySelector("img");
      const cap = el.querySelector(".rd-caption");
      const mediaId = el.dataset.mediaId;
      push({ type: "image", src: (img?.getAttribute("src") || el.dataset.src || ""), text: (cap?.textContent || img?.getAttribute("alt") || "").trim(), ...(mediaId ? { mediaId } : {}) });
      return;
    }
    if (dtype === "table" || el.classList.contains("rd-table-wrap") || tag === "TABLE") {
      const table = tag === "TABLE" ? el : el.querySelector("table");
      if (table) push({ type: "table", text: (table as HTMLElement).outerHTML });
      return;
    }
    if (tag === "BLOCKQUOTE" || dtype === "quote") {
      push({ type: "quote", text: sanitizeInline(el.innerHTML), align: alignOf(el) });
      return;
    }
    if (/^H[1-3]$/.test(tag)) {
      push({ type: `h${tag[1]}` as RichBlockType, text: sanitizeInline(el.innerHTML), align: alignOf(el) });
      return;
    }
    // P, DIV, or anything else → paragraph (skip if empty & alone handled later)
    const inner = sanitizeInline(el.innerHTML);
    push({ type: "paragraph", text: inner, align: alignOf(el) });
  };

  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      handleEl(node as HTMLElement);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").replace(/​/g, "").trim();
      if (t) push({ type: "paragraph", text: escHtml(t) });
    }
  });

  // Drop a single trailing empty paragraph so we don't persist noise, but keep
  // at least one block.
  while (out.length > 1) {
    const last = out[out.length - 1]!;
    if (last.type === "paragraph" && isEmptyInline(last.text)) out.pop();
    else break;
  }
  return out.length ? out : [{ id: uid(), type: "paragraph", text: "" }];
}

// ── Toolbar spec ────────────────────────────────────────────────────────
interface ToolBtn { cmd: string; label: string; title: string; }

const SLASH_ITEMS: { type: RichBlockType; label: string; icon: string; kw: string[] }[] = [
  { type: "paragraph", label: "Text", icon: "¶", kw: ["text", "paragraph"] },
  { type: "h1", label: "Heading 1", icon: "H₁", kw: ["h1", "title", "heading"] },
  { type: "h2", label: "Heading 2", icon: "H₂", kw: ["h2", "heading"] },
  { type: "h3", label: "Heading 3", icon: "H₃", kw: ["h3", "heading"] },
  { type: "bullet", label: "Bulleted list", icon: "•", kw: ["bullet", "ul", "list"] },
  { type: "numbered", label: "Numbered list", icon: "1.", kw: ["number", "ol", "ordered"] },
  { type: "todo", label: "To-do", icon: "☑", kw: ["todo", "check", "task"] },
  { type: "quote", label: "Quote", icon: "❝", kw: ["quote"] },
  { type: "callout", label: "Callout", icon: "💡", kw: ["callout", "tip", "note"] },
  { type: "code", label: "Code", icon: "</>", kw: ["code", "snippet"] },
  { type: "divider", label: "Divider", icon: "—", kw: ["divider", "hr", "rule"] },
  { type: "table", label: "Table", icon: "▦", kw: ["table", "grid"] },
  { type: "image", label: "Image", icon: "🖼", kw: ["image", "img", "picture"] },
  { type: "video", label: "Video", icon: "🎬", kw: ["video", "clip", "movie", "reel"] },
  { type: "audio", label: "Audio", icon: "🎵", kw: ["audio", "sound", "voice", "music"] },
];

let stylesInjected = false;
function ensureStyles(host?: HTMLElement) {
  // Hosts inside a shadow root don't see document styles: add them there too.
  const root = host?.getRootNode();
  if (root instanceof ShadowRoot && !root.querySelector("style[data-rd-css]")) {
    const s = document.createElement("style");
    s.dataset.rdCss = "1";
    s.textContent = RICH_DOC_CSS;
    root.appendChild(s);
  }
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = RICH_DOC_CSS;
  document.head.appendChild(s);
}

export function mountRichDocEditor(host: HTMLElement, opts: RichDocEditorOptions): RichDocEditor {
  ensureStyles(host);
  host.innerHTML = "";
  host.classList.add("rd-host");

  const method = (suffix: "getBlocks" | "saveBlocks") =>
    opts.rpc ? opts.rpc[suffix] : `kanban.${opts.target.kind === "task" ? "tasks" : "projects"}.content.${suffix}`;
  const idParam = () =>
    opts.rpc ? opts.rpc.params : opts.target.kind === "task" ? { taskId: opts.target.id } : { projectId: opts.target.id };

  // Toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "rd-toolbar";

  const status = document.createElement("span");
  status.className = "rd-status";

  const page = document.createElement("div");
  page.className = "rd-page";
  const doc = document.createElement("div");
  doc.className = "rd-doc";
  doc.contentEditable = "true";
  doc.spellcheck = true;
  doc.setAttribute("role", "textbox");
  doc.setAttribute("aria-multiline", "true");
  if (opts.placeholder) doc.dataset.placeholder = opts.placeholder;
  page.appendChild(doc);

  host.appendChild(toolbar);
  host.appendChild(page);

  let destroyed = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  let pending = false;

  function setStatus(text: string, kind: "saving" | "saved" | "error" | "" = "") {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  const exec = (cmd: string, value?: string) => {
    doc.focus();
    try { document.execCommand(cmd, false, value); } catch { /* ignore */ }
    scheduleSave();
    refreshToolbarState();
  };

  function currentBlockEl(): HTMLElement | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let n: Node | null = sel.anchorNode;
    while (n && n !== doc) {
      if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains("rd-block")) return n as HTMLElement;
      n = n.parentNode;
    }
    // fall back to nearest direct child of doc
    n = sel.anchorNode;
    while (n && n.parentNode !== doc) n = n.parentNode;
    return (n as HTMLElement) || null;
  }

  function setBlockType(type: RichBlockType) {
    doc.focus();
    if (type === "bullet") { exec("insertUnorderedList"); return; }
    if (type === "numbered") { exec("insertOrderedList"); return; }
    if (type === "h1" || type === "h2" || type === "h3") { exec("formatBlock", type.toUpperCase()); return; }
    if (type === "quote") { exec("formatBlock", "BLOCKQUOTE"); return; }
    if (type === "paragraph") { exec("formatBlock", "P"); return; }
    if (type === "code") { insertBlockHtml(`<pre class="rd-block rd-code" data-type="code"><code>​</code></pre>`); return; }
    if (type === "divider") { insertBlockHtml(`<div class="rd-block rd-divider-wrap" data-type="divider" contenteditable="false"><hr class="rd-divider"></div><p class="rd-block" data-type="paragraph"><br></p>`); return; }
    if (type === "callout") { insertBlockHtml(`<div class="rd-block rd-callout" data-type="callout"><span class="rd-callout-icon" contenteditable="false">💡</span><span class="rd-inline rd-callout-text">​</span></div>`); return; }
    if (type === "todo") { insertBlockHtml(`<div class="rd-block rd-todo" data-type="todo" data-checked="0"><span class="rd-check" contenteditable="false">☐</span><span class="rd-inline rd-todo-text">​</span></div>`); return; }
    if (type === "image") { insertImage(); return; }
    if (type === "video" || type === "audio") { insertMediaOfKind(type); return; }
    if (type === "table") { insertTable(); return; }
  }

  function insertBlockHtml(html: string) {
    doc.focus();
    // Replace the current empty block if it's an empty paragraph, else insert.
    const cur = currentBlockEl();
    if (cur && cur.tagName === "P" && isEmptyInline(cur.innerHTML)) {
      cur.outerHTML = html;
    } else {
      try { document.execCommand("insertHTML", false, html); }
      catch { doc.insertAdjacentHTML("beforeend", html); }
    }
    scheduleSave();
  }

  function insertImage() {
    if (opts.media?.upload) { insertMediaOfKind("image"); return; }
    const url = window.prompt("Image URL");
    if (!url) return;
    insertBlockHtml(`<figure class="rd-block rd-figure" data-type="image" data-src="${escHtml(url)}" contenteditable="false"><img class="rd-img" src="${escHtml(url)}" alt="" loading="lazy"><figcaption class="rd-inline rd-caption" contenteditable="true" data-placeholder="Caption…"></figcaption></figure><p class="rd-block" data-type="paragraph"><br></p>`);
  }

  // ── Media (host-provided upload / generation) ──
  function insertMedia(m: RichDocMedia) {
    if (!m?.url || m.kind === "file") return;
    insertBlockHtml(`${mediaFigureHtml(m.kind, m.url, m.caption || "", m.id)}<p class="rd-block" data-type="paragraph"><br></p>`);
  }

  /** File picker when the host can upload; otherwise ask for a URL. */
  function insertMediaOfKind(kind: "image" | "video" | "audio") {
    if (!opts.media?.upload) {
      const url = window.prompt(`${kind[0]!.toUpperCase()}${kind.slice(1)} URL`);
      if (url) insertMedia({ url, kind });
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${kind}/*`;
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length) void uploadAndInsert(files);
    });
    input.click();
  }

  async function uploadAndInsert(files: File[]) {
    const upload = opts.media?.upload;
    if (!upload || !files.length) return;
    const marker = document.createElement("div");
    marker.className = "rd-block rd-uploading";
    marker.dataset.type = "uploading";
    marker.contentEditable = "false";
    marker.textContent = `Uploading ${files.length === 1 ? files[0]!.name : `${files.length} files`}…`;
    const cur = currentBlockEl();
    if (cur && cur.parentNode === doc) cur.after(marker);
    else doc.appendChild(marker);
    try {
      const stored = await upload(files);
      const html = stored
        .filter((m) => m.kind !== "file")
        .map((m) => mediaFigureHtml(m.kind as "image" | "video" | "audio", m.url, m.caption || "", m.id))
        .join("");
      if (html) marker.insertAdjacentHTML("afterend", `${html}<p class="rd-block" data-type="paragraph"><br></p>`);
      marker.remove();
      scheduleSave();
    } catch (err) {
      console.error("[rich-doc] upload failed", err);
      marker.textContent = `Upload failed: ${err instanceof Error ? err.message : String(err)}`;
      marker.classList.add("rd-upload-failed");
      setTimeout(() => marker.remove(), 6000);
    }
  }

  async function generateImage() {
    const gen = opts.media?.generateImage;
    if (!gen) return;
    try {
      const m = await gen();
      if (m) insertMedia(m);
    } catch (err) {
      setStatus(`Generation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  function insertTable() {
    const spec = window.prompt("Table size (cols x rows)", "3x3") || "3x3";
    const m = /(\d+)\s*[x×]\s*(\d+)/i.exec(spec);
    const cols = Math.min(12, Math.max(1, m ? parseInt(m[1]!, 10) : 3));
    const rows = Math.min(50, Math.max(1, m ? parseInt(m[2]!, 10) : 3));
    let html = `<div class="rd-block rd-table-wrap" data-type="table"><table><thead><tr>`;
    for (let c = 0; c < cols; c++) html += `<th>Col ${c + 1}</th>`;
    html += `</tr></thead><tbody>`;
    for (let r = 0; r < rows; r++) {
      html += "<tr>";
      for (let c = 0; c < cols; c++) html += "<td>​</td>";
      html += "</tr>";
    }
    html += `</tbody></table></div><p class="rd-block" data-type="paragraph"><br></p>`;
    insertBlockHtml(html);
  }

  function makeLink() {
    const sel = window.getSelection();
    const url = window.prompt("Link URL", "https://");
    if (!url) return;
    if (sel && sel.toString()) exec("createLink", url);
    else insertBlockHtml(`<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(url)}</a>`);
  }

  // ── Toolbar build ──
  function iconBtn(label: string, title: string, on: () => void, opts2?: { active?: string }) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rd-tb-btn";
    b.title = title;
    b.innerHTML = label;
    if (opts2?.active) b.dataset.active = opts2.active;
    b.addEventListener("mousedown", (e) => { e.preventDefault(); });
    b.addEventListener("click", (e) => { e.preventDefault(); on(); });
    return b;
  }
  function sep() { const d = document.createElement("span"); d.className = "rd-tb-sep"; return d; }

  // block-type select
  const blockSel = document.createElement("select");
  blockSel.className = "rd-tb-select";
  blockSel.title = "Block style";
  [["paragraph", "Text"], ["h1", "Heading 1"], ["h2", "Heading 2"], ["h3", "Heading 3"], ["quote", "Quote"], ["code", "Code"]].forEach(([v, l]) => {
    const o = document.createElement("option"); o.value = v!; o.textContent = l!; blockSel.appendChild(o);
  });
  blockSel.addEventListener("mousedown", (e) => e.stopPropagation());
  blockSel.addEventListener("change", () => { setBlockType(blockSel.value as RichBlockType); });

  toolbar.appendChild(blockSel);
  toolbar.appendChild(sep());
  const boldBtn = iconBtn("<b>B</b>", "Bold (Ctrl/Cmd+B)", () => exec("bold"), { active: "bold" });
  const italicBtn = iconBtn("<i>I</i>", "Italic (Ctrl/Cmd+I)", () => exec("italic"), { active: "italic" });
  const underBtn = iconBtn("<u>U</u>", "Underline (Ctrl/Cmd+U)", () => exec("underline"), { active: "underline" });
  const strikeBtn = iconBtn("<s>S</s>", "Strikethrough", () => exec("strikeThrough"), { active: "strikeThrough" });
  const codeBtn = iconBtn("&lt;/&gt;", "Inline code", () => {
    const sel = window.getSelection();
    if (sel && sel.toString()) exec("insertHTML", `<code>${escHtml(sel.toString())}</code>`);
  });
  toolbar.append(boldBtn, italicBtn, underBtn, strikeBtn, codeBtn);
  toolbar.appendChild(sep());

  // color + highlight
  const colorWrap = document.createElement("label");
  colorWrap.className = "rd-tb-color";
  colorWrap.title = "Text color";
  colorWrap.innerHTML = `<span>A</span>`;
  const colorIn = document.createElement("input");
  colorIn.type = "color"; colorIn.value = "#e8c874";
  colorIn.addEventListener("input", () => exec("foreColor", colorIn.value));
  colorWrap.appendChild(colorIn);

  const hlWrap = document.createElement("label");
  hlWrap.className = "rd-tb-color rd-tb-hl";
  hlWrap.title = "Highlight";
  hlWrap.innerHTML = `<span>▧</span>`;
  const hlIn = document.createElement("input");
  hlIn.type = "color"; hlIn.value = "#3a2f12";
  hlIn.addEventListener("input", () => { try { document.execCommand("hiliteColor", false, hlIn.value); } catch { document.execCommand("backColor", false, hlIn.value); } scheduleSave(); });
  hlWrap.appendChild(hlIn);
  toolbar.append(colorWrap, hlWrap);
  toolbar.appendChild(sep());

  toolbar.append(
    iconBtn("•&nbsp;", "Bulleted list", () => setBlockType("bullet")),
    iconBtn("1.", "Numbered list", () => setBlockType("numbered")),
    iconBtn("☑", "Checklist", () => setBlockType("todo")),
    iconBtn("❝", "Quote", () => setBlockType("quote")),
    iconBtn("💡", "Callout", () => setBlockType("callout")),
    iconBtn("{ }", "Code block", () => setBlockType("code")),
  );
  toolbar.appendChild(sep());
  toolbar.append(
    iconBtn("⬅", "Align left", () => exec("justifyLeft")),
    iconBtn("⬍", "Align center", () => exec("justifyCenter")),
    iconBtn("➡", "Align right", () => exec("justifyRight")),
  );
  toolbar.appendChild(sep());
  toolbar.append(
    iconBtn("🔗", "Link", () => makeLink()),
    iconBtn("🖼", opts.media?.upload ? "Upload image" : "Image", () => insertImage()),
  );
  if (opts.media) {
    toolbar.append(
      iconBtn("🎬", "Upload video", () => insertMediaOfKind("video")),
      iconBtn("🎵", "Upload audio", () => insertMediaOfKind("audio")),
    );
    if (opts.media.generateImage) toolbar.append(iconBtn("✨", "Generate image", () => void generateImage()));
  }
  toolbar.append(
    iconBtn("▦", "Table", () => insertTable()),
    iconBtn("—", "Divider", () => setBlockType("divider")),
    iconBtn("⨯", "Clear formatting", () => exec("removeFormat")),
  );
  toolbar.appendChild(status);

  function refreshToolbarState() {
    const q = (c: string) => { try { return document.queryCommandState(c); } catch { return false; } };
    for (const [btn, cmd] of [[boldBtn, "bold"], [italicBtn, "italic"], [underBtn, "underline"], [strikeBtn, "strikeThrough"]] as [HTMLButtonElement, string][]) {
      btn.classList.toggle("rd-on", q(cmd));
    }
    const cur = currentBlockEl();
    if (cur) {
      const t = cur.dataset.type || cur.tagName.toLowerCase();
      const val = ["h1", "h2", "h3", "quote", "code"].includes(t) ? t : "paragraph";
      if (blockSel.value !== val) blockSel.value = val;
    }
  }

  // ── Slash menu ──
  const slash = document.createElement("div");
  slash.className = "rd-slash";
  slash.style.display = "none";
  document.body.appendChild(slash);
  let slashOpen = false;
  let slashIndex = 0;
  let slashItems = SLASH_ITEMS;
  let slashBlock: HTMLElement | null = null;

  function openSlash() {
    const cur = currentBlockEl();
    if (!cur) return;
    slashBlock = cur;
    slashOpen = true;
    slashIndex = 0;
    slashItems = SLASH_ITEMS;
    renderSlash();
    const r = (window.getSelection()?.getRangeAt(0).getBoundingClientRect()) || cur.getBoundingClientRect();
    slash.style.left = `${Math.round(r.left)}px`;
    slash.style.top = `${Math.round(r.bottom + 6)}px`;
    slash.style.display = "block";
  }
  function closeSlash() { slashOpen = false; slash.style.display = "none"; slashBlock = null; }
  function filterSlash(q: string) {
    const s = q.toLowerCase();
    slashItems = SLASH_ITEMS.filter((it) => it.label.toLowerCase().includes(s) || it.kw.some((k) => k.includes(s)));
    slashIndex = 0;
    renderSlash();
  }
  function renderSlash() {
    if (!slashItems.length) { slash.innerHTML = `<div class="rd-slash-empty">No matches</div>`; return; }
    slash.innerHTML = slashItems.map((it, i) =>
      `<div class="rd-slash-item${i === slashIndex ? " rd-slash-sel" : ""}" data-i="${i}"><span class="rd-slash-ic">${it.icon}</span><span>${it.label}</span></div>`).join("");
    slash.querySelectorAll(".rd-slash-item").forEach((el) => {
      el.addEventListener("mousedown", (e) => { e.preventDefault(); chooseSlash(parseInt((el as HTMLElement).dataset.i!, 10)); });
    });
  }
  function chooseSlash(i: number) {
    const it = slashItems[i];
    if (!it || !slashBlock) { closeSlash(); return; }
    // strip the trailing "/query" from the block text
    const span = slashBlock;
    const txt = span.textContent || "";
    const idx = txt.lastIndexOf("/");
    if (idx >= 0 && span.firstChild && span.firstChild.nodeType === Node.TEXT_NODE) {
      // clear the block's text before transform
      span.textContent = txt.slice(0, idx);
    }
    placeCaretInto(slashBlock);
    closeSlash();
    setBlockType(it.type);
  }
  function placeCaretInto(el: HTMLElement) {
    const sel = window.getSelection(); if (!sel) return;
    const r = document.createRange();
    r.selectNodeContents(el); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
  }

  // ── Events ──
  const onInput = () => {
    if (slashOpen && slashBlock) {
      const txt = slashBlock.textContent || "";
      const idx = txt.lastIndexOf("/");
      if (idx < 0) closeSlash();
      else filterSlash(txt.slice(idx + 1));
    }
    scheduleSave();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); slashIndex = (slashIndex + 1) % slashItems.length; renderSlash(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length; renderSlash(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseSlash(slashIndex); return; }
      if (e.key === "Escape") { e.preventDefault(); closeSlash(); return; }
    }
    if (e.key === "/") {
      const cur = currentBlockEl();
      if (cur && isEmptyInline(cur.innerHTML)) setTimeout(openSlash, 0);
    }
    // keyboard shortcuts (execCommand handles bold/italic/underline natively;
    // we just need to schedule a save + refresh state)
    if ((e.ctrlKey || e.metaKey) && ["b", "i", "u"].includes(e.key.toLowerCase())) {
      setTimeout(() => { scheduleSave(); refreshToolbarState(); }, 0);
    }
  };
  const onKeyUp = () => refreshToolbarState();
  const onMouseUp = () => refreshToolbarState();
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains("rd-check")) {
      const wrap = t.closest(".rd-todo") as HTMLElement;
      if (wrap) {
        const on = wrap.dataset.checked === "1";
        wrap.dataset.checked = on ? "0" : "1";
        wrap.classList.toggle("rd-checked", !on);
        t.textContent = on ? "☐" : "☑";
        scheduleSave();
      }
    }
  };
  const onDocMouseDown = (e: MouseEvent) => {
    if (slashOpen && !slash.contains(e.target as Node)) closeSlash();
  };

  doc.addEventListener("input", onInput);
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("keyup", onKeyUp);
  doc.addEventListener("mouseup", onMouseUp);
  doc.addEventListener("click", onClick);
  doc.addEventListener("blur", () => { if (pending) commitSave(); });

  // Drop / paste files straight into the page when the host can store them.
  const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types || []).includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!opts.media?.upload || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    page.classList.add("rd-drop-on");
  };
  const onDragLeave = (e: DragEvent) => {
    if (!page.contains(e.relatedTarget as Node | null)) page.classList.remove("rd-drop-on");
  };
  const onDrop = (e: DragEvent) => {
    page.classList.remove("rd-drop-on");
    if (!opts.media?.upload || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer!.files);
    // Put the caret where the files were dropped, then insert after that block.
    const pos = (document as any).caretRangeFromPoint?.(e.clientX, e.clientY) as Range | null | undefined;
    if (pos && doc.contains(pos.startContainer)) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(pos);
    }
    void uploadAndInsert(files);
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!opts.media?.upload || !files.length) return;
    e.preventDefault();
    void uploadAndInsert(files);
  };
  page.addEventListener("dragover", onDragOver);
  page.addEventListener("dragleave", onDragLeave);
  page.addEventListener("drop", onDrop);
  doc.addEventListener("paste", onPaste);
  document.addEventListener("mousedown", onDocMouseDown);

  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* ignore */ }

  // ── Persistence ──
  function scheduleSave() {
    pending = true;
    if (saveTimer) clearTimeout(saveTimer);
    setStatus("Editing…", "saving");
    saveTimer = setTimeout(commitSave, SAVE_DEBOUNCE_MS);
  }
  async function commitSave() {
    if (destroyed || saving) return;
    pending = false;
    const blocks = htmlToBlocks(doc);
    setStatus("Saving…", "saving");
    saving = true;
    try {
      await opts.client.request(method("saveBlocks"), { ...idParam(), blocks });
      setStatus("Saved", "saved");
      opts.onSaved?.(blocks);
    } catch (err) {
      console.error("[rich-doc] save failed", err);
      setStatus("Save failed — retrying", "error");
      setTimeout(() => { if (!destroyed) scheduleSave(); }, 2500);
    } finally {
      saving = false;
      if (pending && !destroyed) scheduleSave();
    }
  }

  async function load() {
    setStatus("Loading…", "saving");
    try {
      const resp = await opts.client.request(method("getBlocks"), idParam());
      const blocks: RichBlock[] = Array.isArray(resp?.blocks) ? resp.blocks : [];
      doc.innerHTML = blocksToHtml(blocks);
      setStatus("", "");
    } catch (err) {
      console.error("[rich-doc] load failed", err);
      doc.innerHTML = blocksToHtml([]);
      setStatus("Load failed", "error");
    }
    refreshToolbarState();
  }
  load();

  return {
    destroy() {
      destroyed = true;
      if (saveTimer) clearTimeout(saveTimer);
      doc.removeEventListener("input", onInput);
      doc.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("keyup", onKeyUp);
      doc.removeEventListener("mouseup", onMouseUp);
      doc.removeEventListener("click", onClick);
      document.removeEventListener("mousedown", onDocMouseDown);
      page.removeEventListener("dragover", onDragOver);
      page.removeEventListener("dragleave", onDragLeave);
      page.removeEventListener("drop", onDrop);
      doc.removeEventListener("paste", onPaste);
      try { slash.remove(); } catch { /* ignore */ }
    },
    reload() { load(); },
    insertMedia(m: RichDocMedia) {
      // Without a caret inside the page, append at the end.
      const sel = window.getSelection();
      if (!sel || !sel.anchorNode || !doc.contains(sel.anchorNode)) {
        placeCaretInto(doc);
      }
      insertMedia(m);
    },
  };
}

const RICH_DOC_CSS = `
.rd-host { display:flex; flex-direction:column; height:100%; min-height:0; color: var(--text, #e8e6e3); }
.rd-toolbar {
  position: sticky; top: 0; z-index: 5; display:flex; flex-wrap:wrap; align-items:center; gap:2px;
  padding: 6px 10px; background: rgba(14,13,11,0.96); backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(212,175,74,0.22); box-shadow: 0 2px 18px rgba(0,0,0,0.35);
}
.rd-tb-btn {
  min-width: 30px; height: 30px; padding: 0 7px; border-radius: 7px; cursor:pointer;
  background: transparent; color:#cfc9bd; border: 1px solid transparent; font-size: 14px; line-height:1;
  display:inline-flex; align-items:center; justify-content:center; transition: all .12s;
}
.rd-tb-btn:hover { background: rgba(212,175,74,0.14); color:#f3e9cf; border-color: rgba(212,175,74,0.3); }
.rd-tb-btn.rd-on { background: rgba(212,175,74,0.22); color:#f6d97a; border-color: rgba(212,175,74,0.5); }
.rd-tb-select {
  height: 30px; border-radius: 7px; background: rgba(30,28,24,0.9); color:#e8e6e3;
  border: 1px solid rgba(212,175,74,0.28); padding: 0 8px; font-size: 13px; cursor:pointer;
}
.rd-tb-sep { width:1px; height:20px; background: rgba(212,175,74,0.22); margin: 0 5px; }
.rd-tb-color { position:relative; width:30px; height:30px; border-radius:7px; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; color:#cfc9bd; border:1px solid transparent; }
.rd-tb-color:hover { background: rgba(212,175,74,0.14); border-color: rgba(212,175,74,0.3); }
.rd-tb-color span { font-weight:700; font-size:14px; border-bottom:3px solid #e8c874; line-height:1; padding-bottom:1px; }
.rd-tb-hl span { border:none; }
.rd-tb-color input[type=color] { position:absolute; inset:0; opacity:0; cursor:pointer; }
.rd-status { margin-left:auto; font-size:11px; letter-spacing:.04em; padding: 3px 8px; color:#8a8578; }
.rd-status[data-kind=saving] { color:#d4af4a; }
.rd-status[data-kind=saved] { color:#7bbf6a; }
.rd-status[data-kind=error] { color:#e08b6a; }

.rd-page { flex:1; min-height:0; overflow:auto; padding: 34px 0 120px; background:
  radial-gradient(1200px 500px at 50% -10%, rgba(212,175,74,0.05), transparent 60%); }
.rd-doc {
  max-width: 820px; margin: 0 auto; padding: 0 56px; outline:none;
  font-size: 16px; line-height: 1.7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
  caret-color: #e8c874;
}
.rd-doc:empty::before, .rd-doc[data-placeholder]:empty::before { content: attr(data-placeholder); color:#6b665b; }
.rd-doc .rd-block { margin: 2px 0; }
.rd-doc p { margin: 4px 0; min-height: 1.2em; }
.rd-doc h1 { font-size: 2.1em; font-weight: 800; letter-spacing:-0.02em; margin: 26px 0 8px; color:#f4ecd8; }
.rd-doc h2 { font-size: 1.6em; font-weight: 700; margin: 22px 0 6px; color:#f0e7d0; }
.rd-doc h3 { font-size: 1.28em; font-weight: 700; margin: 18px 0 4px; color:#ece2c8; }
.rd-doc ul, .rd-doc ol { margin: 6px 0; padding-left: 28px; }
.rd-doc li { margin: 3px 0; }
.rd-doc a { color:#e8c874; text-decoration: underline; text-underline-offset: 2px; }
.rd-doc blockquote.rd-quote { border-left: 3px solid #d4af4a; margin: 10px 0; padding: 4px 16px; color:#d8d2c4; font-style: italic; background: rgba(212,175,74,0.05); border-radius: 0 8px 8px 0; }
.rd-doc .rd-callout { display:flex; gap:10px; align-items:flex-start; background: rgba(212,175,74,0.09); border:1px solid rgba(212,175,74,0.24); border-radius:10px; padding:12px 14px; margin:10px 0; }
.rd-doc .rd-callout-icon { font-size:18px; user-select:none; }
.rd-doc .rd-callout-text { flex:1; }
.rd-doc .rd-todo { display:flex; gap:9px; align-items:flex-start; margin:3px 0; }
.rd-doc .rd-check { cursor:pointer; user-select:none; font-size:18px; line-height:1.4; color:#d4af4a; }
.rd-doc .rd-todo-text { flex:1; }
.rd-doc .rd-todo.rd-checked .rd-todo-text { text-decoration: line-through; color:#8a8578; }
.rd-doc pre.rd-code { background:#0c0b09; border:1px solid rgba(212,175,74,0.2); border-radius:10px; padding:14px 16px; overflow:auto; margin:10px 0; }
.rd-doc pre.rd-code code { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13.5px; color:#e8d9a8; white-space:pre-wrap; }
.rd-doc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:0.9em; background: rgba(212,175,74,0.12); padding: 1px 5px; border-radius:5px; color:#f0dca0; }
.rd-doc .rd-divider { border:none; border-top:1px solid rgba(212,175,74,0.3); margin: 18px 0; }
.rd-doc .rd-figure { margin:14px 0; text-align:center; }
.rd-doc .rd-img { max-width:100%; border-radius:12px; border:1px solid rgba(212,175,74,0.2); }
.rd-doc .rd-video { width:100%; max-height:520px; border-radius:12px; border:1px solid rgba(212,175,74,0.2); background:#000; display:block; }
.rd-doc .rd-audio { width:100%; display:block; }
.rd-doc .rd-media-audio { padding:12px 14px; border-radius:12px; border:1px solid rgba(212,175,74,0.22); background: rgba(212,175,74,0.06); }
.rd-doc .rd-uploading { margin:10px 0; padding:14px; border-radius:10px; border:1px dashed rgba(212,175,74,0.45); color:#d4af4a; font-size:13px; text-align:center; animation: rd-pulse 1.4s ease-in-out infinite; }
.rd-doc .rd-uploading.rd-upload-failed { color:#e08b6a; border-color: rgba(224,139,106,0.5); animation:none; }
@keyframes rd-pulse { 50% { opacity:.55; } }
.rd-page.rd-drop-on { outline: 2px dashed rgba(212,175,74,0.6); outline-offset: -10px; background-color: rgba(212,175,74,0.04); }
.rd-doc .rd-caption { display:block; font-size:12.5px; color:#8a8578; margin-top:6px; outline:none; }
.rd-doc .rd-caption:empty::before { content: attr(data-placeholder); color:#5f5a50; }
.rd-doc .rd-table-wrap { overflow-x:auto; margin:12px 0; }
.rd-doc table { border-collapse: collapse; width:100%; }
.rd-doc th, .rd-doc td { border:1px solid rgba(212,175,74,0.24); padding:7px 11px; text-align:left; min-width:60px; }
.rd-doc th { background: rgba(212,175,74,0.12); font-weight:700; color:#f0e7d0; }
.rd-doc mark { background:#3a2f12; color:#f6d97a; padding:0 2px; border-radius:3px; }

.rd-slash { position: fixed; z-index: 10000; min-width: 220px; max-height: 320px; overflow:auto;
  background: rgba(20,18,15,0.98); border:1px solid rgba(212,175,74,0.34); border-radius:12px;
  box-shadow: 0 18px 50px rgba(0,0,0,0.55); padding:6px; }
.rd-slash-item { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:8px; cursor:pointer; color:#d8d2c4; font-size:14px; }
.rd-slash-item.rd-slash-sel, .rd-slash-item:hover { background: rgba(212,175,74,0.16); color:#f4ecd8; }
.rd-slash-ic { width:22px; text-align:center; color:#d4af4a; font-weight:700; }
.rd-slash-empty { padding:10px; color:#8a8578; font-size:13px; }

/* Glass G1 token layer. Kept inside this injected stylesheet because editors
   mounted in a shadow root cannot see the page-level compatibility CSS. */
.rd-host {
  color: var(--glass-fg, var(--text, #e8e6e3));
  background: transparent;
  font-family: var(--glass-font, -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif);
}
.rd-toolbar {
  background: var(--glass-sheen, none), var(--glass-2, rgba(14,13,11,.82));
  border-color: var(--glass-stroke-gold, rgba(212,175,74,.22));
  box-shadow: var(--glass-elev-2, 0 2px 18px rgba(0,0,0,.35));
  backdrop-filter: var(--glass-blur, blur(18px) saturate(160%));
  -webkit-backdrop-filter: var(--glass-blur, blur(18px) saturate(160%));
}
.rd-tb-btn,
.rd-tb-select,
.rd-tb-color {
  color: var(--glass-fg-2, #cfc9bd);
  border-color: var(--glass-stroke, transparent);
}
.rd-tb-select {
  background: color-mix(in srgb, var(--glass-base, #07070a) 55%, transparent);
}
.rd-tb-btn:hover,
.rd-tb-btn.rd-on,
.rd-tb-color:hover {
  color: var(--glass-gold, #d4af4a);
  background: var(--glass-gold-a10, rgba(212,175,74,.14));
  border-color: var(--glass-stroke-gold, rgba(212,175,74,.3));
}
.rd-tb-sep { background: var(--glass-stroke, rgba(212,175,74,.22)); }
.rd-status { color: var(--glass-fg-3, #8a8578); }
.rd-status[data-kind=saving] { color: var(--glass-gold, #d4af4a); }
.rd-page {
  background: var(--glass-tint, transparent), var(--glass-1, transparent);
}
.rd-doc {
  color: var(--glass-fg, #e8e6e3);
  caret-color: var(--glass-gold, #e8c874);
  font-family: var(--glass-font, -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif);
}
.rd-doc:empty::before,
.rd-doc[data-placeholder]:empty::before,
.rd-doc .rd-caption,
.rd-doc .rd-caption:empty::before,
.rd-doc .rd-todo.rd-checked .rd-todo-text { color: var(--glass-fg-3, #8a8578); }
.rd-doc :is(h1, h2, h3, th, strong) { color: var(--glass-fg, #f4ecd8); }
.rd-doc a,
.rd-doc .rd-check,
.rd-doc .rd-uploading { color: var(--glass-gold, #d4af4a); }
.rd-doc blockquote.rd-quote {
  color: var(--glass-fg-2, #d8d2c4);
  border-color: var(--glass-gold, #d4af4a);
  background: var(--glass-gold-a06, rgba(212,175,74,.05));
}
.rd-doc .rd-callout,
.rd-doc .rd-media-audio,
.rd-doc th {
  color: var(--glass-fg, #e8e6e3);
  background: var(--glass-gold-a10, rgba(212,175,74,.1));
  border-color: var(--glass-stroke-gold, rgba(212,175,74,.24));
}
.rd-doc pre.rd-code {
  color: var(--glass-fg, #e8e6e3);
  background: color-mix(in srgb, var(--glass-base, #07070a) 64%, transparent);
  border-color: var(--glass-stroke, rgba(212,175,74,.2));
}
.rd-doc pre.rd-code code,
.rd-doc code {
  color: var(--glass-fg, #e8e6e3);
  font-family: var(--glass-font-mono, "JetBrains Mono", ui-monospace, monospace);
}
.rd-doc code { background: var(--glass-gold-a10, rgba(212,175,74,.12)); }
.rd-doc :is(.rd-divider, .rd-img, .rd-video, .rd-media-audio, th, td) {
  border-color: var(--glass-stroke, rgba(212,175,74,.24));
}
.rd-doc mark {
  color: var(--glass-fg, #f6d97a);
  background: var(--glass-gold-a16, rgba(212,175,74,.16));
}
.rd-slash {
  color: var(--glass-fg, #e8e6e3);
  background: var(--glass-sheen, none), var(--glass-4, rgba(20,18,15,.98));
  border-color: var(--glass-stroke-gold, rgba(212,175,74,.34));
  box-shadow: var(--glass-elev-4, 0 18px 50px rgba(0,0,0,.55));
}
.rd-slash-item { color: var(--glass-fg-2, #d8d2c4); }
.rd-slash-item.rd-slash-sel,
.rd-slash-item:hover { color: var(--glass-fg, #f4ecd8); background: var(--glass-gold-a10, rgba(212,175,74,.16)); }
.rd-slash-ic { color: var(--glass-gold, #d4af4a); }
.rd-slash-empty { color: var(--glass-fg-3, #8a8578); }
.rd-host :is(button, select, input, [contenteditable="true"]):focus-visible {
  outline: none;
  box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--glass-gold, #d4af4a));
}
@media (max-width: 520px) {
  .rd-toolbar { overflow-x: auto; flex-wrap: nowrap; }
  .rd-doc { padding-inline: 18px; font-size: 15px; }
  .rd-page { padding-top: 24px; }
}
@media (prefers-reduced-motion: reduce) {
  .rd-host *, .rd-doc .rd-uploading { animation: none !important; transition: none !important; }
}
@media (prefers-reduced-transparency: reduce) {
  .rd-toolbar, .rd-slash {
    background: var(--glass-solid, #121110);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
`;
