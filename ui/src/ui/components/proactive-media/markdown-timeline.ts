/**
 * Parse a markdown document into a TIMELINE of element cards.
 *
 * Each element is revealed sequentially in step with TTS (see
 * stylized-markdown.ts): headings slide+glow, bullets stagger in, code blocks
 * type-in, callouts pulse, images zoom-in. Splitting into discrete elements is
 * what makes per-element entrance animation + per-element highlight possible.
 */

import { toSanitizedMarkdownHtml } from "../../markdown/render.js";

export type TimelineElementKind =
  | "heading"
  | "paragraph"
  | "bullet"
  | "ordered"
  | "code"
  | "callout"
  | "image";

export interface TimelineElement {
  /** Stable id within the timeline, e.g. "el-3". Targetable by the interact channel. */
  id: string;
  kind: TimelineElementKind;
  /** Sanitized inline HTML for the element. */
  html: string;
  /** Plain text (used for word-rate timing + accessibility). */
  text: string;
  /** Heading level (1-6) when kind === "heading". */
  level?: number;
  /** Image url when kind === "image". */
  imageUrl?: string;
  /** Word count (drives the spoken-duration estimate). */
  words: number;
}

function countWords(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function stripMd(s: string): string {
  return s
    .replace(/`{1,3}[^`]*`{1,3}/g, " ")
    .replace(/[*_#>~-]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse markdown into ordered timeline elements. */
export function parseMarkdownTimeline(markdown: string): TimelineElement[] {
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const els: TimelineElement[] = [];
  let n = 0;
  const push = (
    kind: TimelineElementKind,
    src: string,
    extra: Partial<TimelineElement> = {},
  ): void => {
    const text = extra.text ?? stripMd(src);
    els.push({
      id: `el-${n++}`,
      kind,
      html: toSanitizedMarkdownHtml(src),
      text,
      words: Math.max(1, countWords(text)),
      ...extra,
    });
  };

  let i = 0;
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length) {
      push("paragraph", para.join("\n"));
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code block.
    if (/^```/.test(trimmed)) {
      flushPara();
      const fence = trimmed.slice(0, 3);
      const buf: string[] = [line];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) buf.push(lines[i]); // closing fence
      i++;
      const codeText = buf.slice(1, -1).join("\n");
      push("code", buf.join("\n"), { text: codeText });
      continue;
    }

    // Blank line → paragraph boundary.
    if (!trimmed) {
      flushPara();
      i++;
      continue;
    }

    // Heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      push("heading", trimmed, { level: h[1].length, text: stripMd(h[2]) });
      i++;
      continue;
    }

    // Standalone image.
    const img = /^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$/.exec(trimmed);
    if (img) {
      flushPara();
      push("image", trimmed, { imageUrl: img[2], text: img[1] || "image" });
      i++;
      continue;
    }

    // Callout / blockquote.
    if (/^>\s?/.test(trimmed)) {
      flushPara();
      push("callout", trimmed.replace(/^>\s?/, ""));
      i++;
      continue;
    }

    // Unordered bullet (one element per item for stagger).
    if (/^[-*+]\s+/.test(trimmed)) {
      flushPara();
      push("bullet", trimmed);
      i++;
      continue;
    }

    // Ordered list item.
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushPara();
      push("ordered", trimmed);
      i++;
      continue;
    }

    // Accumulate into the current paragraph.
    para.push(line);
    i++;
  }
  flushPara();
  return els;
}
