/**
 * Editor HTML → Documents dialect markdown.
 *
 * Walks a DOM tree (live contenteditable surface, a pasted fragment, or a
 * linkedom document in tests) and emits the dialect from
 * `src/documents/DIALECT.md`. Only standard DOM APIs are used; node types are
 * compared numerically so it works without a global `Node`.
 *
 * The input tree is never mutated: we clone it and normalize the clone
 * (styled spans from Google Docs/Word → semantic marks, adjacent identical
 * marks merged) before serializing.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

type El = Element & { tagName: string };

const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "PRE", "BLOCKQUOTE", "TABLE",
  "HR", "DETAILS", "SUMMARY", "FIGURE", "IFRAME", "VIDEO", "AUDIO", "SECTION", "ARTICLE", "HEADER",
  "FOOTER", "MAIN", "ASIDE", "NAV", "DL", "DT", "DD", "ADDRESS", "CENTER", "FORM", "FIELDSET",
  "HGROUP", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "CAPTION", "FIGCAPTION", "BODY", "HTML",
]);
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "META", "LINK", "TITLE", "HEAD", "TEMPLATE", "NOSCRIPT", "BUTTON", "SELECT",
  "OPTION", "TEXTAREA", "SVG", "CANVAS", "OBJECT", "EMBED", "COLGROUP", "COL",
]);

const MARK_KIND: Record<string, string> = {
  STRONG: "strong", B: "strong",
  EM: "em", I: "em", CITE: "em", DFN: "em", VAR: "em",
  U: "u", INS: "u",
  S: "del", DEL: "del", STRIKE: "del",
  MARK: "mark",
};
const KIND_TAG: Record<string, string> = { strong: "strong", em: "em", u: "u", del: "del", mark: "mark", code: "code" };

function isEl(n: Node | null | undefined): n is El {
  return !!n && n.nodeType === ELEMENT_NODE;
}
function isText(n: Node | null | undefined): n is Text {
  return !!n && n.nodeType === TEXT_NODE;
}
function tag(n: Node): string {
  return isEl(n) ? n.tagName.toUpperCase() : "";
}
function hasAttr(el: Element, name: string): boolean {
  return typeof el.hasAttribute === "function" && el.hasAttribute(name);
}
function isUi(el: Element): boolean {
  return hasAttr(el, "data-ui");
}
function kids(n: Node): Node[] {
  return Array.from(n.childNodes ?? []);
}
function isBlockEl(n: Node): boolean {
  if (!isEl(n)) return false;
  const t = tag(n);
  if (BLOCK_TAGS.has(t)) return true;
  if (t === "SPAN" && hasAttr(n, "data-math-block")) return true;
  return false;
}
function cleanText(s: string): string {
  return s.replace(/[​﻿]/g, "").replace(/ /g, " ");
}

// ── Inline style normalization (paste from Google Docs / Word / Notion) ──

function styleKinds(el: Element): { add: string[]; plain: boolean } {
  const style = (el.getAttribute("style") ?? "").toLowerCase();
  const add: string[] = [];
  let plain = false;
  if (!style) return { add, plain };
  const fw = /font-weight\s*:\s*([^;]+)/.exec(style)?.[1]?.trim();
  if (fw) {
    if (/bold|bolder|[6-9]00/.test(fw)) add.push("strong");
    else if (/normal|lighter|[1-4]00/.test(fw)) plain = true;
  }
  const fs = /font-style\s*:\s*([^;]+)/.exec(style)?.[1]?.trim();
  if (fs && /italic|oblique/.test(fs)) add.push("em");
  const td = /text-decoration(?:-line)?\s*:\s*([^;]+)/.exec(style)?.[1] ?? "";
  if (/underline/.test(td)) add.push("u");
  if (/line-through/.test(td)) add.push("del");
  const bg = /background(?:-color)?\s*:\s*([^;]+)/.exec(style)?.[1]?.trim() ?? "";
  if (
    bg &&
    !/^(transparent|initial|inherit|none|unset|white|#fff\b|#ffffff\b|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\([^)]*,\s*0(\.0+)?\s*\)|var\()/.test(bg)
  ) {
    add.push("mark");
  }
  const ff = /font-family\s*:\s*([^;]+)/.exec(style)?.[1] ?? "";
  if (/courier|consolas|monaco|menlo|monospace|source code|fira code|jetbrains/.test(ff)) add.push("code");
  return { add, plain };
}

function normalizeTree(root: Node): void {
  const doc = (root as Node).ownerDocument ?? (root as unknown as Document);
  const all: Element[] = [];
  const collect = (n: Node) => {
    for (const c of kids(n)) {
      if (isEl(c)) {
        collect(c);
        all.push(c);
      }
    }
  };
  collect(root);
  // Post-order: children normalized before parents.
  for (const el of all) {
    const t = tag(el);
    if (SKIP_TAGS.has(t) || isUi(el)) continue;
    if (hasAttr(el, "data-math") || hasAttr(el, "data-math-block") || t === "A" || t === "CODE" || t === "PRE") continue;
    const isInlineStyled = t === "SPAN" || t === "FONT" || t in MARK_KIND;
    if (!isInlineStyled || !el.getAttribute("style")) continue;
    const { add, plain } = styleKinds(el);
    const own = MARK_KIND[t];
    const kinds = new Set<string>(add);
    if (own && !(plain && own === "strong")) kinds.add(own);
    if (own === "em" && /font-style\s*:\s*normal/i.test(el.getAttribute("style") ?? "")) kinds.delete("em");
    const parent = el.parentNode;
    if (!parent) continue;
    let outer: Node | null = null;
    let inner: Node | null = null;
    for (const k of ["strong", "em", "u", "del", "mark", "code"]) {
      if (!kinds.has(k)) continue;
      const w = doc.createElement(KIND_TAG[k]!);
      if (!outer) outer = w;
      else inner!.appendChild(w);
      inner = w;
    }
    const children = kids(el);
    if (outer && inner) {
      for (const c of children) inner.appendChild(c);
      parent.replaceChild(outer, el);
    } else {
      for (const c of children) parent.insertBefore(c, el);
      parent.removeChild(el);
    }
  }
  mergeAdjacentMarks(root);
}

function markKindOf(n: Node): string | null {
  if (!isEl(n)) return null;
  const t = tag(n);
  if (t === "CODE" && !(n.parentNode && tag(n.parentNode) === "PRE")) return null;
  return MARK_KIND[t] ?? null;
}

function mergeAdjacentMarks(n: Node): void {
  for (const c of kids(n)) if (isEl(c)) mergeAdjacentMarks(c);
  let child = n.firstChild;
  while (child) {
    const kind = markKindOf(child);
    let next = child.nextSibling;
    if (kind) {
      while (next && markKindOf(next) === kind) {
        for (const g of kids(next)) child.appendChild(g);
        const after = next.nextSibling;
        n.removeChild(next);
        next = after;
      }
    }
    child = next;
  }
}

// ── Text escaping ────────────────────────────────────────────────────────

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

interface InlineCtx {
  /** Escape `$` (block contains ≥2 dollar signs outside math). */
  dollar: boolean;
  /** Table cell: hard breaks become `<br>`. */
  table?: boolean;
  /** Headings / summaries: hard breaks become spaces. */
  singleLine?: boolean;
  /** Block root, used to detect trailing <br>. */
  root?: Node;
}

function escapeText(s: string, ctx: InlineCtx): string {
  let out = "";
  const isAlnum = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const prev = s[i - 1];
    const next = s[i + 1];
    switch (ch) {
      case "\\":
        out += next === undefined || ASCII_PUNCT.test(next) ? "\\\\" : "\\";
        break;
      case "*":
      case "`":
      case "[":
      case "]":
      case "~":
        out += "\\" + ch;
        break;
      case "_":
        out += isAlnum(prev) && isAlnum(next) ? "_" : "\\_";
        break;
      case "=":
        out += prev === "=" || next === "=" ? "\\=" : "=";
        break;
      case "$":
        out += ctx.dollar ? "\\$" : "$";
        break;
      case "<":
        out += next && /[A-Za-z/!?]/.test(next) ? "\\<" : "<";
        break;
      case "&":
        out += /^&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][A-Za-z\d]*);/.test(s.slice(i)) ? "&amp;" : "&";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** Escape constructs that only matter at the start of a line. */
function escapeLineStarts(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      if (/^#{1,6}(?=\s|$)/.test(line)) return "\\" + line;
      if (/^>/.test(line)) return "\\" + line;
      if (/^[-+](?=\s|$)/.test(line)) return "\\" + line;
      if (/^(?:-+|=+)\s*$/.test(line)) return "\\" + line;
      const num = /^(\d{1,9})([.)])(?=\s|$)/.exec(line);
      if (num) return num[1] + "\\" + line.slice(num[1]!.length);
      return line;
    })
    .join("\n");
}

function countDollars(nodes: Node[]): number {
  let n = 0;
  const walk = (node: Node) => {
    if (isText(node)) n += (node.data.match(/\$/g) ?? []).length;
    else if (isEl(node) && !hasAttr(node, "data-math") && !hasAttr(node, "data-math-block") && !isUi(node)) {
      for (const c of kids(node)) walk(c);
    }
  };
  for (const node of nodes) walk(node);
  return n;
}

// ── Inline serialization ─────────────────────────────────────────────────

function wrap(open: string, close: string, inner: string): string {
  if (!inner.replace(/\\\n/g, "").trim()) return inner;
  const m = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(inner)!;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function codeSpan(text: string): string {
  const t = cleanText(text).replace(/\n/g, " ");
  if (!t) return "";
  const runs = t.match(/`+/g) ?? [];
  const n = runs.reduce((a, r) => Math.max(a, r.length), 0) + 1;
  const fence = "`".repeat(n);
  const pad = /^`|`$/.test(t) || (/^ .*[^ ].* $/.test(t)) ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

function hasContentAfter(node: Node, root: Node | undefined): boolean {
  const meaningful = (n: Node): boolean => {
    if (isText(n)) return cleanText(n.data).trim() !== "";
    if (!isEl(n) || isUi(n)) return false;
    const t = tag(n);
    if (t === "BR") return false;
    if (t === "IMG" || hasAttr(n, "data-math")) return true;
    if (cleanText(n.textContent ?? "").trim() !== "") return true;
    return !!n.querySelector?.("img");
  };
  let cur: Node | null = node;
  while (cur && cur !== root) {
    for (let sib = cur.nextSibling; sib; sib = sib.nextSibling) if (meaningful(sib)) return true;
    cur = cur.parentNode;
  }
  return false;
}

function urlForMd(url: string): string {
  if (/[\s<>]/.test(url) || /\((?![^()]*\))/.test(url) || /(?<!\([^()]*)\)/.test(url)) {
    return `<${url.replace(/[<>]/g, (c) => encodeURIComponent(c))}>`;
  }
  return url;
}

function titlePart(el: Element): string {
  const title = el.getAttribute("title");
  return title ? ` "${title.replace(/"/g, '\\"')}"` : "";
}

function inlineMd(nodes: Node[], ctx: InlineCtx, active: Set<string> = new Set()): string {
  let out = "";
  let text = "";
  // Coalesce adjacent text nodes so escaping sees real neighbours.
  const flushText = () => {
    if (text) out += escapeText(text.replace(/[ \t\r\n\f]+/g, " "), ctx);
    text = "";
  };
  for (const node of nodes) {
    if (isText(node)) {
      text += cleanText(node.data);
      continue;
    }
    flushText();
    out += inlineNode(node, ctx, active);
  }
  flushText();
  return out;
}

function inlineNode(node: Node, ctx: InlineCtx, active: Set<string>): string {
  if (isText(node)) {
    const text = cleanText(node.data).replace(/[ \t\r\n\f]+/g, " ");
    return escapeText(text, ctx);
  }
  if (!isEl(node)) return "";
  const el = node;
  const t = tag(el);
  if (SKIP_TAGS.has(t) || isUi(el)) return "";
  if (t === "BR") {
    if (ctx.table) return "<br>";
    if (ctx.singleLine) return " ";
    return hasContentAfter(el, ctx.root) ? "\\\n" : "";
  }
  if (t === "IMG") {
    // data-asset-src = the stored gateway path behind a display-only URL.
    const src = el.getAttribute("data-asset-src") || el.getAttribute("src") || "";
    if (!src) return "";
    const alt = cleanText(el.getAttribute("alt") ?? "").replace(/([\[\]\\])/g, "\\$1");
    return `![${alt}](${urlForMd(src)}${titlePart(el)})`;
  }
  if (t === "INPUT") return "";
  if (hasAttr(el, "data-math") || hasAttr(el, "data-math-block")) {
    const tex = cleanText(el.textContent ?? "").replace(/\s*\n\s*/g, " ").trim();
    return tex ? `$${tex}$` : "";
  }
  if (t === "CODE" || t === "KBD" || t === "SAMP" || t === "TT") {
    return codeSpan(el.textContent ?? "");
  }
  if (t === "A") {
    const inner = inlineMd(kids(el), ctx, active);
    const wiki = el.getAttribute("data-wiki");
    if (wiki != null) {
      const title = wiki.trim();
      const label = cleanText(el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!title) return inner;
      return !label || label === title ? `[[${title}]]` : `[[${title}|${label.replace(/[\[\]|]/g, "")}]]`;
    }
    const href = (el.getAttribute("href") ?? "").trim();
    if (!href || href === "#") return inner;
    const text = cleanText(el.textContent ?? "").trim();
    if (/^(https?:\/\/|mailto:)/i.test(href) && (text === href || `mailto:${text}` === href) && !el.getAttribute("title")) {
      return /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]$/i.test(href) && !href.includes("`")
        ? href
        : `<${href}>`;
    }
    if (!inner.trim()) return inner.includes("![") ? inner : `[${escapeText(href, ctx)}](${urlForMd(href)})`;
    return `[${inner}](${urlForMd(href)}${titlePart(el)})`;
  }
  const kind = MARK_KIND[t];
  if (kind) {
    if (active.has(kind)) return inlineMd(kids(el), ctx, active);
    const next = new Set(active).add(kind);
    const inner = inlineMd(kids(el), ctx, next);
    switch (kind) {
      case "strong":
        return wrap("**", "**", inner);
      case "em":
        return wrap("*", "*", inner);
      case "del":
        return wrap("~~", "~~", inner);
      case "mark":
        return wrap("==", "==", inner);
      case "u":
        return wrap("<u>", "</u>", inner);
    }
  }
  if (isBlockEl(el)) {
    // Block content inside an inline context (table cells, list first lines).
    const blocks = serializeBlocks(kids(el)).map((b) => b.replace(/\n+/g, " "));
    const sep = ctx.table ? "<br>" : " ";
    const joined = blocks.filter(Boolean).join(sep);
    return joined ? joined + sep : "";
  }
  return inlineMd(kids(el), ctx, active);
}

function paragraph(nodes: Node[], root?: Node): string[] {
  const ctx: InlineCtx = { dollar: countDollars(nodes) >= 2, root };
  let md = inlineMd(nodes, ctx);
  md = md
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/^\s+/, "")
    .replace(/(?:\s|\\\n)+$/, "");
  if (!md) return [];
  // Two consecutive hard breaks (e.g. <br><br> from a plain paste) = new paragraph.
  return md
    .split(/(?:\\\n){2,}/)
    .map((p) => p.replace(/^\s+|(?:\s|\\\n)+$/g, ""))
    .filter(Boolean)
    .map(escapeLineStarts);
}

function singleLineInline(nodes: Node[], root?: Node): string {
  const ctx: InlineCtx = { dollar: countDollars(nodes) >= 2, singleLine: true, root };
  return inlineMd(nodes, ctx).replace(/\s+/g, " ").trim();
}

// ── Block serialization ──────────────────────────────────────────────────

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

function quoteLines(s: string): string {
  return s
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

/** Text of a <pre>/math block: text nodes + <br>/<div> line breaks, minus UI chrome. */
export function preText(el: Node): string {
  let out = "";
  const walk = (n: Node) => {
    for (const c of kids(n)) {
      if (isText(c)) out += c.data;
      else if (isEl(c)) {
        if (isUi(c) || SKIP_TAGS.has(tag(c))) continue;
        const t = tag(c);
        if (t === "BR") {
          out += "\n";
          continue;
        }
        const block = t === "DIV" || t === "P";
        if (block && out && !out.endsWith("\n")) out += "\n";
        walk(c);
        if (block && !out.endsWith("\n")) out += "\n";
      }
    }
  };
  walk(el);
  return out.replace(/[​﻿]/g, "").replace(/ /g, " ");
}

function fenceFor(code: string): string {
  const runs = code.match(/^ {0,3}(`{3,}|~{3,})/gm) ?? [];
  const max = runs.reduce((a, r) => Math.max(a, r.trim().length), 0);
  return "`".repeat(Math.max(3, max + 1));
}

function codeBlock(el: Element): string {
  let lang = (el.getAttribute("data-lang") ?? "").trim();
  if (!lang) {
    const code = el.querySelector?.("code");
    const cls = `${code?.getAttribute("class") ?? ""} ${el.getAttribute("class") ?? ""}`;
    lang = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(cls)?.[1] ?? "";
  }
  const code = preText(el).replace(/\n$/, "");
  const fence = fenceFor(code);
  return `${fence}${lang}\n${code}\n${fence}`;
}

function taskState(li: Element): boolean | null {
  const dc = li.getAttribute("data-checked");
  if (dc != null) return dc === "true" || dc === "1" || dc === "checked";
  const aria = li.getAttribute("aria-checked");
  if (aria != null && (li.getAttribute("role") === "checkbox" || aria === "true" || aria === "false")) {
    return aria === "true";
  }
  // Leading checkbox input (GitHub/GFM HTML, Notion exports).
  const first = firstMeaningful(li);
  if (first && isEl(first) && tag(first) === "INPUT" && (first.getAttribute("type") ?? "").toLowerCase() === "checkbox") {
    return hasAttr(first, "checked");
  }
  const box = li.querySelector?.(":scope > .checkbox, :scope > div > .checkbox");
  if (box) return /checkbox-on/.test(box.getAttribute("class") ?? "");
  return null;
}

function firstMeaningful(n: Node): Node | null {
  for (const c of kids(n)) {
    if (isText(c) && !cleanText(c.data).trim()) continue;
    if (isEl(c) && (tag(c) === "P" || tag(c) === "SPAN" || tag(c) === "LABEL") && !hasAttr(c, "data-math")) {
      const inner = firstMeaningful(c);
      if (inner) return inner;
      continue;
    }
    return c;
  }
  return null;
}

function isPlainParagraphContainer(el: Node): boolean {
  if (!isEl(el)) return false;
  const t = tag(el);
  if (t !== "P" && t !== "DIV") return false;
  if (hasAttr(el, "data-callout") || hasAttr(el, "data-math-block")) return false;
  return !kids(el).some((c) => isBlockEl(c));
}

function listItem(li: Element, marker: string): string | null {
  const checked = taskState(li);
  const nodes = kids(li).filter((c) => !(isEl(c) && tag(c) === "INPUT"));
  const first: Node[] = [];
  let i = 0;
  while (i < nodes.length && !isBlockEl(nodes[i]!)) first.push(nodes[i++]!);
  if (!first.some((n) => (isText(n) ? cleanText(n.data).trim() : true)) && i < nodes.length && isPlainParagraphContainer(nodes[i]!)) {
    first.length = 0;
    first.push(...kids(nodes[i]!));
    i++;
  }
  const text = paragraph(first, li).join("\n");
  const rest = serializeBlocks(nodes.slice(i));
  if (!text && !rest.length) return null;
  const prefix = marker + (checked == null ? "" : checked ? "[x] " : "[ ] ");
  const w = marker.length;
  let out = prefix + indent(text, w).replace(/^ +/, "");
  for (const b of rest) {
    const isList = /^(?:[-*+]|\d+[.)]) /.test(b);
    out += (isList && !out.includes("\n\n") ? "\n" : "\n\n") + indent(b, w);
  }
  return out.replace(/[ \t]+$/gm, "");
}

function list(el: Element): string {
  const ordered = tag(el) === "OL";
  let n = Number.parseInt(el.getAttribute("start") ?? "1", 10);
  if (!Number.isFinite(n) || n < 0) n = 1;
  const items: string[] = [];
  for (const c of kids(el)) {
    if (isText(c)) {
      if (cleanText(c.data).trim()) items.push(`${ordered ? `${n++}. ` : "- "}${escapeLineStarts(escapeText(cleanText(c.data).trim(), { dollar: false }))}`);
      continue;
    }
    if (!isEl(c) || isUi(c) || SKIP_TAGS.has(tag(c))) continue;
    const t = tag(c);
    if (t === "UL" || t === "OL") {
      // Invalid-but-common nesting (<ul><li/><ul/></ul>): attach to previous item.
      const nested = list(c);
      if (!nested) continue;
      if (items.length) {
        const w = ordered ? `${n - 1}. `.length : 2;
        items[items.length - 1] += "\n" + indent(nested, w);
      } else items.push(nested);
      continue;
    }
    const marker = ordered ? `${n}. ` : "- ";
    const item = t === "LI" ? listItem(c, marker) : listItem(c, marker);
    if (item != null) {
      items.push(item);
      if (ordered) n++;
    }
  }
  return items.join("\n");
}

function tableMd(el: Element): string {
  const rows: Element[] = [];
  const collectRows = (n: Node) => {
    for (const c of kids(n)) {
      if (!isEl(c)) continue;
      const t = tag(c);
      if (t === "TR") rows.push(c);
      else if (t === "THEAD" || t === "TBODY" || t === "TFOOT") collectRows(c);
    }
  };
  collectRows(el);
  if (!rows.length) return "";
  const grid = rows.map((r) =>
    kids(r)
      .filter((c) => isEl(c) && (tag(c) === "TD" || tag(c) === "TH"))
      .map((cell) => cell as Element),
  );
  const cols = Math.max(1, ...grid.map((r) => r.length));
  const cellMd = (cell: Element | undefined) => {
    if (!cell) return "";
    const nodes = kids(cell);
    const ctx: InlineCtx = { dollar: countDollars(nodes) >= 2, table: true, root: cell };
    return inlineMd(nodes, ctx)
      .replace(/(?:<br>)+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\|/g, "\\|");
  };
  const alignOf = (cell: Element | undefined) => {
    if (!cell) return "";
    const a = (
      cell.getAttribute("data-align") ??
      cell.getAttribute("align") ??
      /text-align\s*:\s*(\w+)/i.exec(cell.getAttribute("style") ?? "")?.[1] ??
      ""
    ).toLowerCase();
    return a === "left" ? ":---" : a === "center" ? ":---:" : a === "right" ? "---:" : "---";
  };
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const header = grid[0]!;
  const out = [
    line(Array.from({ length: cols }, (_, i) => cellMd(header[i]))),
    line(Array.from({ length: cols }, (_, i) => alignOf(header[i]))),
  ];
  for (const r of grid.slice(1)) out.push(line(Array.from({ length: cols }, (_, i) => cellMd(r[i]))));
  return out.join("\n");
}

function mediaSrc(el: Element): string {
  const src = el.getAttribute("src");
  if (src) return src;
  const source = el.querySelector?.("source[src]");
  return source?.getAttribute("src") ?? "";
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function serializeBlock(el: El): string[] {
  const t = tag(el);
  if (/^H[1-6]$/.test(t)) {
    const text = singleLineInline(kids(el), el).replace(/(\s)(#+)$/, "$1\\$2");
    return text ? [`${"#".repeat(Number(t[1]))} ${text}`] : [];
  }
  if (t === "P") return paragraph(kids(el), el);
  if (t === "UL" || t === "OL") {
    const l = list(el);
    return l ? [l] : [];
  }
  if (t === "LI") {
    const item = listItem(el, "- ");
    return item ? [item] : [];
  }
  if (t === "PRE") {
    if (hasAttr(el, "data-frontmatter")) {
      const fence = "```";
      return [`${fence}yaml\n${preText(el).replace(/\n$/, "")}\n${fence}`];
    }
    return [codeBlock(el)];
  }
  if (t === "BLOCKQUOTE") {
    const inner = serializeBlocks(kids(el)).join("\n\n");
    return inner ? [quoteLines(inner)] : [];
  }
  if (t === "TABLE") {
    const tm = tableMd(el);
    return tm ? [tm] : [];
  }
  if (t === "HR") return ["---"];
  if (t === "DETAILS") {
    const summaryEl = kids(el).find((c) => isEl(c) && tag(c) === "SUMMARY");
    const summary = summaryEl ? singleLineInline(kids(summaryEl), summaryEl) : "";
    const bodyNodes: Node[] = [];
    for (const c of kids(el)) {
      if (c === summaryEl) continue;
      if (isEl(c) && tag(c) === "DIV" && /(?:^|\s)toggle-body(?:\s|$)/.test(c.getAttribute("class") ?? "")) {
        bodyNodes.push(...kids(c));
      } else bodyNodes.push(c);
    }
    const body = serializeBlocks(bodyNodes).join("\n\n");
    return [`<details><summary>${summary}</summary>\n\n${body ? body + "\n\n" : ""}</details>`];
  }
  if (t === "FIGURE") {
    const embed = el.getAttribute("data-embed");
    const media = el.getAttribute("data-media");
    const dsrc = el.getAttribute("data-src") ?? "";
    if (embed != null) {
      const src = dsrc || (el.querySelector?.("iframe")?.getAttribute("src") ?? "");
      return src ? [`<iframe src="${escAttr(src)}"></iframe>`] : [];
    }
    if (media === "video" || media === "audio") {
      const inner = el.querySelector?.(media);
      const src = dsrc || (inner ? mediaSrc(inner) : "");
      return src ? [`<${media} src="${escAttr(src)}" controls></${media}>`] : [];
    }
    return serializeBlocks(kids(el));
  }
  if (t === "IFRAME") {
    const src = el.getAttribute("src") ?? "";
    return /^https?:\/\//i.test(src) ? [`<iframe src="${escAttr(src)}"></iframe>`] : [];
  }
  if (t === "VIDEO" || t === "AUDIO") {
    const src = mediaSrc(el);
    const k = t.toLowerCase();
    return src ? [`<${k} src="${escAttr(src)}" controls></${k}>`] : [];
  }
  if (hasAttr(el, "data-math-block")) {
    const tex = preText(el).trim();
    return tex ? [`$$\n${tex}\n$$`] : [];
  }
  if (hasAttr(el, "data-callout")) {
    const kind = (el.getAttribute("data-callout") || "NOTE").toUpperCase();
    const bodyEl = kids(el).find((c) => isEl(c) && /(?:^|\s)callout-body(?:\s|$)/.test(c.getAttribute("class") ?? ""));
    const body = serializeBlocks(bodyEl ? kids(bodyEl) : kids(el)).join("\n\n");
    return [`> [!${kind}]` + (body ? "\n" + quoteLines(body) : "")];
  }
  if (t === "SUMMARY" || t === "DT" || t === "DD" || t === "FIGCAPTION" || t === "CAPTION") {
    return paragraph(kids(el), el);
  }
  if (t === "TR" || t === "THEAD" || t === "TBODY" || t === "TFOOT" || t === "TD" || t === "TH") {
    return serializeBlocks(kids(el));
  }
  // DIV / SECTION / ARTICLE / …: container or paragraph.
  if (kids(el).some((c) => isBlockEl(c))) return serializeBlocks(kids(el));
  return paragraph(kids(el), el);
}

function serializeBlocks(nodes: Node[]): string[] {
  const out: string[] = [];
  let buf: Node[] = [];
  const flush = () => {
    if (buf.length) out.push(...paragraph(buf));
    buf = [];
  };
  for (const node of nodes) {
    if (isText(node)) {
      if (!buf.length && !cleanText(node.data).trim()) continue;
      buf.push(node);
      continue;
    }
    if (!isEl(node)) continue;
    const t = tag(node);
    if (SKIP_TAGS.has(t) || isUi(node)) continue;
    if (isBlockEl(node)) {
      flush();
      out.push(...serializeBlock(node).filter((b) => b.trim() !== ""));
    } else buf.push(node);
  }
  flush();
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Serialize editor DOM (or any HTML DOM) into Documents-dialect markdown.
 * Returns "" for an empty document, otherwise a string ending in "\n".
 */
export function editorHtmlToMarkdown(root: ParentNode): string {
  const clone = (root as unknown as Node).cloneNode(true);
  normalizeTree(clone);
  const nodes = kids(clone);
  let frontmatter: string | null = null;
  const firstIdx = nodes.findIndex((n) => !(isText(n) && !cleanText(n.data).trim()));
  const first = nodes[firstIdx];
  if (first && isEl(first) && tag(first) === "PRE" && hasAttr(first, "data-frontmatter")) {
    frontmatter = preText(first).replace(/\n$/, "");
    nodes.splice(firstIdx, 1);
  }
  const blocks = serializeBlocks(nodes);
  let md = blocks.join("\n\n").replace(/\n{3,}/g, (m, off: number, s: string) => {
    // Keep blank-line runs inside fenced code; collapse elsewhere.
    return insideFence(s, off) ? m : "\n\n";
  });
  if (frontmatter != null) md = `---\n${frontmatter}\n---` + (md ? "\n\n" + md : "");
  md = md.replace(/\s+$/, "");
  return md ? md + "\n" : "";
}

function insideFence(s: string, offset: number): boolean {
  const before = s.slice(0, offset);
  const fences = before.match(/^ *(`{3,}|~{3,})/gm) ?? [];
  return fences.length % 2 === 1;
}

/** Convenience for pasted HTML strings: parse inertly with the given document. */
export function htmlStringToMarkdown(html: string, doc: Document): string {
  // <template> content is inert: no image loads / handlers while parsing.
  const tpl = doc.createElement("template");
  tpl.innerHTML = html;
  return editorHtmlToMarkdown(tpl.content ?? tpl);
}
