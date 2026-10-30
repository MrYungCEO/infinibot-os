/**
 * Markdown ↔ Block[] for Content Studio pages.
 *
 * Reuses core's converter (src/content/blocks-markdown.ts — the one kanban
 * project/task content uses) and adds the media blocks the studio's editor
 * renders: `video` and `audio`. In markdown both are written as standalone
 * image lines whose alt starts with `video:` / `audio:` (or whose URL has a
 * video/audio extension), so plain-markdown readers still see a link:
 *
 *   ![video: Hook take 3](/plugins/content-studio/media?id=med_…)
 *   ![audio: VO draft](https://example.com/vo.mp3)
 */

import { blocksToMarkdown, markdownToBlocks, type Block } from "../content/blocks-markdown.js";

export type StudioBlock = Omit<Block, "type"> & {
  type: Block["type"] | "video" | "audio" | "table" | "html";
  align?: "left" | "center" | "right";
  mediaId?: string;
};

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)(?:[?#].*)?$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)(?:[?#].*)?$/i;
const MEDIA_ID = /[?&]id=(med_[a-z0-9]+)/i;

function mediaKindOf(
  alt: string,
  src: string,
): { kind: "video" | "audio" | null; caption: string } {
  const m = /^(video|audio)\s*:\s*(.*)$/i.exec(alt);
  if (m) return { kind: m[1]!.toLowerCase() as "video" | "audio", caption: m[2]!.trim() };
  if (VIDEO_EXT.test(src)) return { kind: "video", caption: alt };
  if (AUDIO_EXT.test(src)) return { kind: "audio", caption: alt };
  return { kind: null, caption: alt };
}

/**
 * Inline markdown → the sanitized inline-HTML subset the rich editor stores
 * in a block's `text` (bold, italic, code, links). Everything else is escaped.
 */
export function inlineMarkdownToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,!?])/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])\*([^*]+)\*(?=$|[\s).,!?])/g, "$1<i>$2</i>")
    .replace(
      /\[([^\]]+)\]\(((?:https?:|mailto:|\/)[^)\s]*)\)/g,
      (_m, label: string, href: string) =>
        `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    );
}

export function studioMarkdownToBlocks(md: string): StudioBlock[] {
  return markdownToBlocks(md).map((b): StudioBlock => {
    if (b.type === "callout") {
      // The editor draws the callout icon itself; drop the emoji marker.
      const text = b.text.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "");
      return { ...b, text: inlineMarkdownToHtml(text) };
    }
    if (b.type !== "image" || !b.src) {
      return b.type === "code" || b.type === "divider"
        ? b
        : { ...b, text: inlineMarkdownToHtml(b.text) };
    }
    const { kind, caption } = mediaKindOf(b.text ?? "", b.src);
    const mediaId = MEDIA_ID.exec(b.src)?.[1];
    const out: StudioBlock = kind ? { ...b, type: kind, text: caption } : { ...b };
    if (mediaId) out.mediaId = mediaId;
    return out;
  });
}

function stripInlineHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(b|strong)>/gi, "**")
    .replace(/<\/?(i|em)>/gi, "_")
    .replace(/<\/?code>/gi, "`")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Table HTML (the editor stores it as one block) → GFM table. */
function tableToMarkdown(htmlText: string): string {
  const rows = [...htmlText.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
    [...r[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) =>
      stripInlineHtml(c[1]!).replace(/​/g, "").replace(/\|/g, "\\|").trim(),
    ),
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [
    line(rows[0]!),
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...rows.slice(1).map(line),
  ].join("\n");
}

export function studioBlocksToMarkdown(blocks: unknown[]): string {
  const mapped: Block[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as StudioBlock;
    const text = typeof b.text === "string" ? b.text : "";
    if (b.type === "video" || b.type === "audio") {
      mapped.push({
        id: b.id,
        type: "image",
        text: `${b.type}: ${stripInlineHtml(text)}`.trim(),
        src: b.src ?? "",
      });
    } else if (b.type === "table") {
      mapped.push({ id: b.id, type: "paragraph", text: tableToMarkdown(text) });
    } else if (b.type === "html") {
      mapped.push({ id: b.id, type: "paragraph", text: stripInlineHtml(text) });
    } else if (b.type === "callout") {
      // Core writes callouts as plain quotes; keep the emoji so it parses back.
      mapped.push({ id: b.id, type: "quote", text: `💡 ${stripInlineHtml(text)}` });
    } else if (b.type === "code" || b.type === "image") {
      mapped.push(b as Block);
    } else {
      mapped.push({ ...(b as Block), text: stripInlineHtml(text) });
    }
  }
  return blocksToMarkdown(mapped);
}

/** Plain text of a page, for agent summaries and search. */
export function studioBlocksToText(blocks: unknown[], max = 4000): string {
  return studioBlocksToMarkdown(blocks).slice(0, max);
}
