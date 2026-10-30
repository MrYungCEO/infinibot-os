/**
 * Notion blocks → Documents markdown dialect (see ../DIALECT.md).
 *
 * Input blocks must already carry their nested `children` (the API importer
 * fetches them recursively). Child pages / databases are NOT descended into —
 * they become `[Title](doc:<id>)` links resolved through `ctx.resolvePage`.
 *
 * The converter is synchronous: asset downloads happen beforehand and are
 * exposed through `ctx.resolveAsset` (a lookup into a prebuilt url → local map).
 */

import { fileNameFromUrl, normalizeNotionId, notionUrlFor } from "./shared.js";

// Notion JSON payloads are loosely typed on purpose: the API adds block and
// rich-text variants over time and we only read a small, defensive subset.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: any;
}

export interface NotionRichText {
  /** "text" | "mention" | "equation" (open-ended: Notion adds variants). */
  type: string;
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
  text?: { content: string; link?: { url: string } | null };
  mention?: any;
  equation?: { expression: string };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface BlocksToMdContext {
  /** Map a media/file URL to the URL to embed (local asset or the original). */
  resolveAsset: (url: string, nameHint: string) => string;
  /** Map a Notion page/database id (any format) to a doc/folder id, or null. */
  resolvePage: (notionPageId: string, title: string) => string | null;
  /** Optional title lookup for `link_to_page` blocks (which carry no title). */
  titleOf?: (notionId: string) => string | undefined;
}

// ── Rich text ────────────────────────────────────────────────

/** Escape characters that would otherwise be parsed as dialect markup. */
export function escapeMarkdownText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([*`[\]~$<])/g, "\\$1")
    .replace(/==/g, "\\=\\=")
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, "\\_");
}

/** Escape markers that would turn the start of a paragraph into another block. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(\d+)([.)]\s)/, "$1$2\\$3")
    .replace(/^(\s*)(#{1,6}\s|>|[-+]\s|---\s*$)/, "$1\\$2");
}

function wrapInlineCode(text: string): string {
  if (!text.includes("`")) return `\`${text}\``;
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(...runs.map((r) => r.length)) + 1);
  return `${fence} ${text} ${fence}`;
}

/** Wrap `inner` in `open`/`close` keeping edge whitespace outside the markers. */
function wrapKeepingSpace(inner: string, open: string, close = open): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!m || !m[2]) return inner;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function isHighlight(color: string | undefined): boolean {
  return !!color && color.endsWith("_background");
}

/** Resolve a Notion-internal link (`/<id>`, notion.so URL) to a doc link when in scope. */
function resolveHref(href: string, label: string, ctx: BlocksToMdContext): string {
  const internal = href.startsWith("/") || /^https?:\/\/(www\.)?notion\.(so|site)\//i.test(href);
  if (internal) {
    const id = normalizeNotionId(href.startsWith("/") ? href.slice(1) : href);
    if (id) {
      const docId = ctx.resolvePage(id, label);
      if (docId) return `doc:${docId}`;
      if (href.startsWith("/")) return notionUrlFor(id);
    }
  }
  return href;
}

function formatLink(label: string, href: string): string {
  const safeHref = /[\s()]/.test(href) ? `<${href.replace(/>/g, "%3E")}>` : href;
  return `[${label}](${safeHref})`;
}

function mentionToMarkdown(rt: NotionRichText, ctx: BlocksToMdContext): string {
  const m = rt.mention ?? {};
  const plain = rt.plain_text ?? "";
  switch (m.type) {
    case "page":
    case "database": {
      const target = m[m.type]?.id as string | undefined;
      const title = plain || "Untitled";
      const docId = target ? ctx.resolvePage(target, title) : null;
      if (docId) return formatLink(escapeMarkdownText(title), `doc:${docId}`);
      const href = rt.href || (target ? notionUrlFor(normalizeNotionId(target) ?? target) : "");
      return href ? formatLink(escapeMarkdownText(title), href) : escapeMarkdownText(title);
    }
    case "date": {
      const d = m.date ?? {};
      return escapeMarkdownText(d.end ? `${d.start} → ${d.end}` : String(d.start ?? plain));
    }
    case "user": {
      const name = m.user?.name ?? plain.replace(/^@/, "");
      return escapeMarkdownText(`@${name || "user"}`);
    }
    case "link_preview":
    case "link_mention": {
      const url = m[m.type]?.url ?? rt.href ?? plain;
      const label = m.link_mention?.title ?? plain ?? url;
      return formatLink(escapeMarkdownText(label || url), url);
    }
    default:
      return rt.href ? formatLink(escapeMarkdownText(plain), rt.href) : escapeMarkdownText(plain);
  }
}

interface Segment {
  md: string;
  code: boolean;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
  highlight: boolean;
  href: string | null;
  /** Mentions/links are pre-rendered and never merged with neighbours. */
  atomic: boolean;
}

function sameStyle(a: Segment, b: Segment): boolean {
  return (
    !a.atomic &&
    !b.atomic &&
    a.code === b.code &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.underline === b.underline &&
    a.highlight === b.highlight &&
    a.href === b.href
  );
}

/** Convert a Notion rich-text array to inline dialect markdown. */
export function richTextToMarkdown(
  rich: NotionRichText[] | undefined | null,
  ctx: BlocksToMdContext,
): string {
  if (!rich?.length) return "";
  const segs: Segment[] = [];
  for (const rt of rich) {
    const a = rt.annotations ?? {};
    const base = {
      code: !!a.code,
      bold: !!a.bold,
      italic: !!a.italic,
      strike: !!a.strikethrough,
      underline: !!a.underline,
      highlight: isHighlight(a.color),
    };
    if (rt.type === "mention") {
      segs.push({ ...base, code: false, md: mentionToMarkdown(rt, ctx), href: null, atomic: true });
      continue;
    }
    if (rt.type === "equation") {
      const expr = rt.equation?.expression ?? rt.plain_text ?? "";
      segs.push({ ...base, code: false, md: `$${expr}$`, href: null, atomic: true });
      continue;
    }
    const raw = rt.text?.content ?? rt.plain_text ?? "";
    const href = rt.text?.link?.url ?? rt.href ?? null;
    segs.push({ ...base, md: raw, href, atomic: false });
  }
  // Merge adjacent runs with identical styling (Notion splits runs freely),
  // otherwise `**a****b**` would be emitted.
  const merged: Segment[] = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && sameStyle(prev, s)) prev.md += s.md;
    else merged.push({ ...s });
  }
  return merged
    .map((s) => {
      if (s.atomic) return applyStyle(s.md, s);
      if (!s.md) return "";
      let out = s.code ? wrapInlineCode(s.md) : escapeMarkdownText(s.md);
      out = applyStyle(out, s);
      if (s.href) {
        const label = out.trim() ? out : escapeMarkdownText(s.href);
        out = formatLink(label, resolveHref(s.href, s.md, ctx));
      }
      return out;
    })
    .join("")
    .replace(/\n/g, "  \n"); // soft line breaks inside a block → hard breaks
}

function applyStyle(md: string, s: Segment): string {
  let out = md;
  if (s.strike) out = wrapKeepingSpace(out, "~~");
  if (s.underline) out = wrapKeepingSpace(out, "<u>", "</u>");
  if (s.italic) out = wrapKeepingSpace(out, "*");
  if (s.bold) out = wrapKeepingSpace(out, "**");
  if (s.highlight) out = wrapKeepingSpace(out, "==");
  return out;
}

function plainText(rich: NotionRichText[] | undefined | null): string {
  return (rich ?? []).map((r) => r.plain_text ?? r.text?.content ?? "").join("");
}

// ── Blocks ───────────────────────────────────────────────────

type ChunkKind = "bulleted" | "numbered" | "todo" | "block";

interface Chunk {
  kind: ChunkKind;
  text: string;
}

const LIST_INDENT = "  "; // DIALECT: 2-space indent per nesting level

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => (l.length ? prefix + l : l))
    .join("\n");
}

function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.length ? `> ${l}` : ">"))
    .join("\n");
}

/** `url` + name hint of a Notion file object (`{ type: "file"|"external", … }`). */
export function fileObjectUrl(obj: any): { url: string; hosted: boolean; name: string } | null {
  if (!obj) return null;
  const url: string | undefined = obj.type === "file" ? obj.file?.url : obj.external?.url;
  if (!url) return null;
  return {
    url,
    hosted: obj.type === "file",
    name: (obj.name as string | undefined) || fileNameFromUrl(url) || "file",
  };
}

/** Collect all media/file URLs in a block tree (for pre-downloading hosted assets). */
export function collectBlockAssets(
  blocks: NotionBlock[],
): Array<{ url: string; hosted: boolean; name: string }> {
  const out: Array<{ url: string; hosted: boolean; name: string }> = [];
  const walk = (list: NotionBlock[]) => {
    for (const b of list) {
      if (["image", "video", "audio", "file", "pdf"].includes(b.type)) {
        const f = fileObjectUrl(b[b.type]);
        if (f) out.push(f);
      }
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

const CALLOUT_KIND: Record<string, string> = {
  red: "CAUTION",
  orange: "WARNING",
  yellow: "WARNING",
  green: "TIP",
  purple: "IMPORTANT",
  pink: "IMPORTANT",
};

function calloutKind(color: string | undefined): string {
  const base = (color ?? "default").replace(/_background$/, "");
  return CALLOUT_KIND[base] ?? "NOTE";
}

const LANGUAGE_ALIASES: Record<string, string> = {
  "plain text": "",
  "c++": "cpp",
  "c#": "csharp",
  "f#": "fsharp",
  "objective-c": "objectivec",
  "vb.net": "vbnet",
  "visual basic": "vb",
  "java/c/c++/c#": "java",
  shell: "sh",
};

function codeLanguage(lang: string | undefined): string {
  const l = (lang ?? "").toLowerCase().trim();
  if (l in LANGUAGE_ALIASES) return LANGUAGE_ALIASES[l]!;
  return l.replace(/\s+/g, "-");
}

function codeFence(content: string): string {
  const runs = content.match(/`{3,}/g) ?? [];
  return "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}

function escapeTableCell(md: string): string {
  return md.replace(/\|/g, "\\|").replace(/ {2}\n|\n/g, "<br>");
}

function escapeHtmlAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** YouTube/Vimeo/Loom page URLs → embeddable iframe URLs (else null). */
function embedUrlFor(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/embed/${encodeURIComponent(v)}`;
      if (u.pathname.startsWith("/embed/")) return url;
    }
    if (host === "youtu.be") return `https://www.youtube.com/embed${u.pathname}`;
    if (host === "vimeo.com" && /^\/\d+/.test(u.pathname)) {
      return `https://player.vimeo.com/video${u.pathname}`;
    }
    if (host === "loom.com" && u.pathname.startsWith("/share/")) {
      return `https://www.loom.com/embed/${u.pathname.slice("/share/".length)}`;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

class Converter {
  constructor(private readonly ctx: BlocksToMdContext) {}

  render(blocks: NotionBlock[]): string {
    const chunks: Chunk[] = [];
    let numbered = 0;
    for (const b of blocks) {
      numbered = b.type === "numbered_list_item" ? numbered + 1 : 0;
      const c = this.block(b, numbered);
      if (c && c.text.trim().length) chunks.push(c);
    }
    let out = "";
    chunks.forEach((c, i) => {
      if (i > 0) {
        const prev = chunks[i - 1]!;
        const tight =
          prev.kind !== "block" &&
          c.kind !== "block" &&
          (prev.kind === c.kind || (prev.kind !== "numbered" && c.kind !== "numbered")); // `-` bullets + todos share a list
        out += tight ? "\n" : "\n\n";
      }
      out += c.text;
    });
    return out;
  }

  private rt(rich: NotionRichText[] | undefined): string {
    return richTextToMarkdown(rich, this.ctx);
  }

  private childrenMd(b: NotionBlock): string {
    return b.children?.length ? this.render(b.children) : "";
  }

  private listItem(marker: string, text: string, b: NotionBlock): string {
    const kids = this.childrenMd(b);
    return kids ? `${marker}${text}\n${indent(kids, LIST_INDENT)}` : `${marker}${text}`;
  }

  private media(b: NotionBlock): string {
    const data = b[b.type];
    const f = fileObjectUrl(data);
    if (!f) return "";
    const caption = plainText(data?.caption);
    const src = this.ctx.resolveAsset(f.url, f.name);
    switch (b.type) {
      case "image":
        return `![${escapeMarkdownText(caption || "").replace(/\n/g, " ")}](${src.includes(" ") ? `<${src}>` : src})`;
      case "video": {
        const embed = !f.hosted ? embedUrlFor(f.url) : null;
        const tag = embed
          ? `<iframe src="${escapeHtmlAttr(embed)}"></iframe>`
          : `<video src="${escapeHtmlAttr(src)}" controls></video>`;
        return caption ? `${tag}\n\n*${escapeMarkdownText(caption)}*` : tag;
      }
      case "audio": {
        const tag = `<audio src="${escapeHtmlAttr(src)}" controls></audio>`;
        return caption ? `${tag}\n\n*${escapeMarkdownText(caption)}*` : tag;
      }
      default: {
        // file / pdf → attachment link
        const name = caption || f.name;
        return formatLink(`📎 ${escapeMarkdownText(name)}`, src);
      }
    }
  }

  private pageLink(notionId: string | undefined, title: string): string {
    const label = title || "Untitled";
    if (!notionId) return `**${escapeMarkdownText(label)}**`;
    const docId = this.ctx.resolvePage(notionId, label);
    if (docId) return formatLink(escapeMarkdownText(label), `doc:${docId}`);
    return `**${escapeMarkdownText(label)}**`;
  }

  private block(b: NotionBlock, number: number): Chunk | null {
    const d = b[b.type] ?? {};
    switch (b.type) {
      case "paragraph": {
        const text = escapeLineStart(this.rt(d.rich_text));
        const kids = this.childrenMd(b);
        return { kind: "block", text: kids ? (text ? `${text}\n\n${kids}` : kids) : text };
      }
      case "heading_1":
      case "heading_2":
      case "heading_3": {
        const hashes = "#".repeat(Number(b.type.slice(-1)));
        const text = this.rt(d.rich_text);
        if (d.is_toggleable) {
          // Toggle headings keep their level as a `#` prefix inside <summary>
          // so the editor can restore them; the body is the toggle content.
          return { kind: "block", text: this.details(`${hashes} ${text}`, this.childrenMd(b)) };
        }
        return { kind: "block", text: text ? `${hashes} ${text}` : "" };
      }
      case "bulleted_list_item":
        return { kind: "bulleted", text: this.listItem("- ", this.rt(d.rich_text), b) };
      case "numbered_list_item":
        return { kind: "numbered", text: this.listItem(`${number}. `, this.rt(d.rich_text), b) };
      case "to_do":
        return {
          kind: "todo",
          text: this.listItem(d.checked ? "- [x] " : "- [ ] ", this.rt(d.rich_text), b),
        };
      case "toggle":
        return { kind: "block", text: this.details(this.rt(d.rich_text), this.childrenMd(b)) };
      case "quote": {
        const kids = this.childrenMd(b);
        const text = this.rt(d.rich_text);
        return { kind: "block", text: quoteLines(kids ? `${text}\n\n${kids}` : text) };
      }
      case "callout": {
        const icon = d.icon?.type === "emoji" ? `${d.icon.emoji} ` : "";
        const text = `${icon}${this.rt(d.rich_text)}`.trim();
        const kids = this.childrenMd(b);
        const body = kids ? (text ? `${text}\n\n${kids}` : kids) : text;
        return { kind: "block", text: `> [!${calloutKind(d.color)}]\n${quoteLines(body)}` };
      }
      case "code": {
        const content = plainText(d.rich_text);
        const fence = codeFence(content);
        const caption = this.rt(d.caption);
        const code = `${fence}${codeLanguage(d.language)}\n${content}\n${fence}`;
        return { kind: "block", text: caption ? `${code}\n\n*${caption}*` : code };
      }
      case "divider":
        return { kind: "block", text: "---" };
      case "image":
      case "video":
      case "audio":
      case "file":
      case "pdf":
        return { kind: "block", text: this.media(b) };
      case "bookmark":
      case "link_preview": {
        const url: string | undefined = d.url;
        if (!url) return null;
        const caption = plainText(d.caption);
        return { kind: "block", text: formatLink(escapeMarkdownText(caption || url), url) };
      }
      case "embed": {
        const url: string | undefined = d.url;
        if (!url) return null;
        const src = embedUrlFor(url) ?? url;
        return { kind: "block", text: `<iframe src="${escapeHtmlAttr(src)}"></iframe>` };
      }
      case "equation":
        return { kind: "block", text: `$$\n${d.expression ?? ""}\n$$` };
      case "table":
        return { kind: "block", text: this.table(b) };
      case "column_list":
      case "column":
      case "synced_block":
      case "template":
        return { kind: "block", text: this.childrenMd(b) };
      case "child_page":
        return { kind: "block", text: this.pageLink(b.id, d.title ?? "") };
      case "child_database":
        return { kind: "block", text: this.pageLink(b.id, d.title ?? "") };
      case "link_to_page": {
        const target: string | undefined = d.page_id ?? d.database_id;
        const title = (target && this.ctx.titleOf?.(target)) || "Linked page";
        if (!target) return null;
        const docId = this.ctx.resolvePage(target, title);
        const href = docId ? `doc:${docId}` : notionUrlFor(normalizeNotionId(target) ?? target);
        return { kind: "block", text: formatLink(escapeMarkdownText(title), href) };
      }
      case "table_of_contents":
      case "breadcrumb":
      case "unsupported":
      default:
        return null;
    }
  }

  private details(summary: string, body: string): string {
    return body
      ? `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`
      : `<details><summary>${summary}</summary>\n\n</details>`;
  }

  private table(b: NotionBlock): string {
    const d = b.table ?? {};
    const rows = (b.children ?? []).filter((r) => r.type === "table_row");
    const width: number =
      d.table_width ?? Math.max(1, ...rows.map((r) => (r.table_row?.cells ?? []).length));
    const cellsOf = (r: NotionBlock): string[] => {
      const cells: NotionRichText[][] = r.table_row?.cells ?? [];
      return Array.from({ length: width }, (_, i) => escapeTableCell(this.rt(cells[i])));
    };
    const line = (cells: string[]) => `| ${cells.map((c) => c || " ").join(" | ")} |`;
    let header: string[];
    let body: NotionBlock[];
    if (d.has_column_header && rows.length) {
      header = cellsOf(rows[0]!);
      body = rows.slice(1);
    } else {
      header = Array.from({ length: width }, () => "");
      body = rows;
    }
    return [
      line(header),
      `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
      ...body.map((r) => line(cellsOf(r))),
    ].join("\n");
  }
}

/** Convert a Notion block tree (children attached) to dialect markdown. */
export function notionBlocksToMarkdown(blocks: NotionBlock[], ctx: BlocksToMdContext): string {
  const md = new Converter(ctx).render(blocks).trim();
  return md ? `${md}\n` : "";
}
