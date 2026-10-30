/**
 * Obsidian Markdown parsing (pure, no I/O).
 *
 * Covers the Obsidian dialect the vault importer needs:
 *   - YAML frontmatter (`---` block at the top) → properties, tags, aliases
 *   - `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[folder/Note]]`
 *   - embeds `![[image.png]]`, `![[Note]]`, `![[file.pdf|300]]`
 *   - plain markdown links to vault files `[x](Note.md)`, `![](img.png)`
 *   - inline `#tags` (nested `#a/b`), ignoring code, headings and URLs
 *   - tasks `- [ ] …` / `- [x] …` with an optional `📅 YYYY-MM-DD` due date
 *   - daily notes (`YYYY-MM-DD.md`, anywhere in the vault)
 *
 * Code spans and fenced blocks are masked before scanning so links/tags in
 * code are left alone.
 */

import YAML from "yaml";
import type { DocPropertyValue } from "../types.js";

export interface ObsidianFrontmatter {
  data: Record<string, unknown>;
  body: string;
  /** True when a frontmatter block existed but failed to parse. */
  invalid?: boolean;
}

const FM_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(md: string): ObsidianFrontmatter {
  const m = FM_RE.exec(md);
  if (!m) return { data: {}, body: md.replace(/^﻿/, "") };
  const body = md.slice(m[0].length);
  try {
    const parsed: unknown = YAML.parse(m[1] ?? "", { maxAliasCount: 50 });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, body };
    }
    return { data: {}, body };
  } catch {
    return { data: {}, body, invalid: true };
  }
}

/** Replace fenced code blocks and inline code spans with same-length spaces. */
export function maskCode(md: string): string {
  const fence = md.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
  return fence.replace(/`[^`\n]+`/g, (s) => " ".repeat(s.length));
}

export interface WikiLink {
  /** Raw text inside the brackets. */
  raw: string;
  /** Note/file target without heading/block ref (may contain folders). */
  target: string;
  /** `#Heading` or `#^block` part, without the `#`. */
  fragment: string | null;
  alias: string | null;
  embed: boolean;
  /** Offsets of the whole `[[…]]` / `![[…]]` match in the source. */
  start: number;
  end: number;
}

const WIKI_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

export function parseWikiLinks(md: string): WikiLink[] {
  const masked = maskCode(md);
  const out: WikiLink[] = [];
  WIKI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_RE.exec(masked))) {
    const raw = md.slice(m.index + m[1]!.length + 2, m.index + m[0].length - 2);
    const pipe = raw.indexOf("|");
    const left = pipe >= 0 ? raw.slice(0, pipe) : raw;
    const alias = pipe >= 0 ? raw.slice(pipe + 1).trim() || null : null;
    const hash = left.indexOf("#");
    const target = (hash >= 0 ? left.slice(0, hash) : left).trim();
    const fragment = hash >= 0 ? left.slice(hash + 1).trim() || null : null;
    out.push({
      raw,
      target,
      fragment,
      alias,
      embed: m[1] === "!",
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

export interface MdLink {
  embed: boolean;
  label: string;
  href: string;
  start: number;
  end: number;
}

const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;

/** Markdown links whose target is a relative vault path (not a URL / anchor / doc:). */
export function parseLocalMdLinks(md: string): MdLink[] {
  const masked = maskCode(md);
  const out: MdLink[] = [];
  MD_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK_RE.exec(masked))) {
    let href = md.slice(m.index + m[0].length - 1 - m[3]!.length, m.index + m[0].length - 1).trim();
    if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
    // Drop an optional "title" part.
    href = href.replace(/\s+"[^"]*"$/, "");
    if (
      !href ||
      /^[a-z][a-z0-9+.-]*:/i.test(href) ||
      href.startsWith("#") ||
      href.startsWith("/")
    ) {
      continue;
    }
    out.push({
      embed: m[1] === "!",
      label: m[2] ?? "",
      href,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;

/** Inline `#tags` in the body (not in code, headings, or URLs). Lowercased, deduped. */
export function parseInlineTags(md: string): string[] {
  const masked = maskCode(md);
  const out = new Set<string>();
  for (const line of masked.split("\n")) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) continue; // heading
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(line))) {
      const tag = m[2]!.replace(/[/-]+$/, "");
      if (!tag || /^\d+$/.test(tag)) continue; // "#1" is an issue number, not a tag
      out.add(tag.toLowerCase());
    }
  }
  return [...out];
}

/** Frontmatter `tags` / `tag` (string, comma/space separated, or list) → tags. */
export function frontmatterTags(data: Record<string, unknown>): string[] {
  const raw = data.tags ?? data.tag;
  const list: string[] = [];
  if (typeof raw === "string") list.push(...raw.split(/[,\s]+/));
  else if (Array.isArray(raw)) for (const v of raw) if (v != null) list.push(String(v));
  return [...new Set(list.map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))];
}

export function frontmatterAliases(data: Record<string, unknown>): string[] {
  const raw = data.aliases ?? data.alias;
  if (typeof raw === "string")
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  return [];
}

/** Frontmatter → flat document properties (tags/aliases/cssclasses handled elsewhere). */
export function frontmatterProperties(
  data: Record<string, unknown>,
): Record<string, DocPropertyValue> {
  const out: Record<string, DocPropertyValue> = {};
  for (const [k, v] of Object.entries(data)) {
    if (["tags", "tag", "aliases", "alias", "cssclasses", "cssclass"].includes(k)) continue;
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (v instanceof Date) out[k] = v.toISOString().slice(0, 10);
    else if (Array.isArray(v))
      out[k] = v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x)));
    else out[k] = JSON.stringify(v);
  }
  return out;
}

export interface ObsidianTask {
  text: string;
  done: boolean;
  /** Due date from `📅 2026-01-31` or `due:: 2026-01-31`. */
  due: string | null;
  /** 1-based line number in the body. */
  line: number;
  tags: string[];
}

const TASK_RE = /^\s*[-*+]\s+\[([ xX/-])\]\s+(.+)$/;
const DUE_RE = /(?:📅|🗓️?|\[?due::)\s*(\d{4}-\d{2}-\d{2})\]?/u;

export function parseTasks(md: string): ObsidianTask[] {
  const masked = maskCode(md);
  const out: ObsidianTask[] = [];
  const lines = md.split("\n");
  masked.split("\n").forEach((mline, i) => {
    const m = TASK_RE.exec(mline);
    if (!m) return;
    const original = lines[i] ?? "";
    const text = (TASK_RE.exec(original)?.[2] ?? m[2]!).trim();
    const state = m[1]!;
    if (state === "-") return; // cancelled
    const due = DUE_RE.exec(text)?.[1] ?? null;
    const clean = text
      .replace(DUE_RE, "")
      .replace(/[⏫🔼🔽⏬✅➕⏳🛫]\s*(\d{4}-\d{2}-\d{2})?/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    out.push({
      text: clean || text,
      done: state === "x" || state === "X",
      due,
      line: i + 1,
      tags: parseInlineTags(text),
    });
  });
  return out;
}

const DAILY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-10-07` (the note's base name) → ISO day, else null. */
export function dailyNoteDate(baseName: string): string | null {
  const m = DAILY_RE.exec(baseName.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : `${m[1]}-${m[2]}-${m[3]}`;
}

/** Leading `# Title` when it matches the file name (Obsidian shows the file name as title). */
export function stripTitleHeading(body: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*\r?\n/.exec(body);
  if (m && m[1]!.trim().toLowerCase() === title.trim().toLowerCase()) {
    return body.slice(m[0].length).replace(/^\s*\n/, "");
  }
  return body;
}

/** Obsidian callouts `> [!note] Title` are kept as-is (the documents renderer shows blockquotes). */
export const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
]);
