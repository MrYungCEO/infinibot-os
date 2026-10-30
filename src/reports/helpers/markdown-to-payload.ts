/**
 * Markdown → {@link ReportPayload} converter.
 *
 * Agents (and humans) naturally produce reports as Markdown. Without a bridge,
 * the only way to "deliver a report" was the raw `telegram_send` text tool —
 * which ships unstyled Markdown and bypasses the canonical black-gold PDF
 * pipeline entirely. This converter turns a Markdown document into the
 * structured {@link ReportPayload} that `renderReport()` understands, so a
 * Markdown-only caller still gets the same styled PDF as a structured one.
 *
 * The parse is intentionally forgiving (GFM-ish, not a full CommonMark parser):
 *   - The first `# H1` becomes the title (unless `overrides.title` is set).
 *   - A leading `_italic_`, `> quote`, or plain paragraph right after the title
 *     becomes the subtitle.
 *   - Each `## H2` (or `### H3`) starts a section; content before the first
 *     heading folds into an "Overview" section.
 *   - Inside a section: `- `/`* ` lines → bullets, fenced ``` blocks → code,
 *     GFM `| a | b |` tables → a {@link ReportTable}, everything else → body.
 *   - Light inline cleanup strips `**bold**`, `*italic*`, `` `code` `` markers
 *     and `[text](url)` link syntax so they don't render literally (the template
 *     HTML-escapes text, it does not interpret Markdown).
 */

import type { ReportPayload, ReportSection, ReportTable } from "../types.js";

/** Strip the inline Markdown markers the black-gold template won't interpret. */
function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/__([^_]+)__/g, "$1") // bold (underscore)
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2") // italic
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2") // italic (underscore)
    .trimEnd();
}

const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
const headingLevel = (l: string): number => l.match(/^(#{1,6})\s+/)?.[1].length ?? 0;
const headingText = (l: string) => l.replace(/^#{1,6}\s+/, "").trim();
const isBullet = (l: string) => /^\s*[-*]\s+/.test(l);
const bulletText = (l: string) => l.replace(/^\s*[-*]\s+/, "");
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes("-");

function splitRow(l: string): string[] {
  return l
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => stripInline(c.trim()));
}

/** Parse a contiguous block of GFM table lines into a {@link ReportTable}. */
function parseTable(lines: string[]): ReportTable | null {
  if (lines.length < 2 || !isTableSep(lines[1])) return null;
  const columns = splitRow(lines[0]);
  const rows = lines.slice(2).filter(isTableRow).map(splitRow);
  if (!columns.length) return null;
  return { columns, rows };
}

/** Build the section blocks from the body lines that follow a heading. */
function buildSection(heading: string, lines: string[]): ReportSection | null {
  const bullets: string[] = [];
  const bodyParts: string[] = [];
  let table: ReportTable | undefined;
  const codeBlocks: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      if (buf.length) codeBlocks.push(buf.join("\n"));
      continue;
    }

    // GFM table — consume the contiguous run of table rows
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const run: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) run.push(lines[i++]);
      i--; // step back; loop will advance
      const t = parseTable(run);
      if (t) table = t;
      continue;
    }

    if (isBullet(line)) {
      bullets.push(stripInline(bulletText(line)));
      continue;
    }

    bodyParts.push(line);
  }

  const body = bodyParts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => (isBullet(l) ? l : stripInline(l)))
    .join("\n")
    .trim();
  const code = codeBlocks.join("\n\n").trim() || undefined;

  const section: ReportSection = { heading: stripInline(heading) || "Details" };
  if (body) section.body = body;
  if (bullets.length) section.bullets = bullets;
  if (table) section.table = table;
  if (code) section.code = code;

  // Drop a section that carries no content at all.
  if (!section.body && !section.bullets && !section.table && !section.code) return null;
  return section;
}

export interface MarkdownToPayloadOverrides {
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  footer?: string;
  theme?: string;
}

/**
 * Convert a Markdown document into a structured {@link ReportPayload}. Always
 * returns a payload with a non-empty `title` and at least one section (a single
 * "Report" section holding the raw text if nothing else parsed), so the result
 * is always renderable by `renderReport()`.
 */
export function markdownToPayload(
  markdown: string,
  overrides: MarkdownToPayloadOverrides = {},
): ReportPayload {
  const lines = String(markdown ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  let title = overrides.title?.trim() || "";
  let subtitle = overrides.subtitle?.trim() || "";
  const sections: ReportSection[] = [];

  // Walk to the first H1 (title) if we don't have an override.
  let i = 0;
  if (!title) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i < lines.length && isHeading(lines[i]) && headingLevel(lines[i]) === 1) {
      title = headingText(lines[i]);
      i++;
    }
  }

  // Subtitle: the first non-empty, non-heading paragraph line after the title.
  if (!subtitle) {
    let j = i;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j < lines.length && !isHeading(lines[j]) && !isBullet(lines[j]) && !isTableRow(lines[j])) {
      const t = lines[j].trim().replace(/^>\s*/, "");
      // Treat a leading italic/quote one-liner as the subtitle.
      if (/^[_*>]/.test(lines[j].trim()) || (t.length > 0 && t.length <= 200)) {
        subtitle = stripInline(t);
        i = j + 1;
      }
    }
  }

  // Group the remaining lines into sections by H2/H3 boundaries.
  let currentHeading = "Overview";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length || sections.length === 0) {
      const sec = buildSection(currentHeading, buf);
      if (sec) sections.push(sec);
    }
    buf = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isHeading(line) && headingLevel(line) >= 2) {
      flush();
      currentHeading = headingText(line);
      continue;
    }
    if (isHeading(line) && headingLevel(line) === 1) {
      // A second H1 — treat as a section heading rather than a new title.
      flush();
      currentHeading = headingText(line);
      continue;
    }
    buf.push(line);
  }
  flush();

  // Absolute fallback: ensure at least one section and a title.
  if (!sections.length) {
    const raw = stripInline(String(markdown ?? "").trim());
    sections.push({ heading: "Report", body: raw || "—" });
  }
  if (!title) title = sections[0]?.heading || "Report";

  const payload: ReportPayload = { title, sections };
  if (subtitle) payload.subtitle = subtitle;
  if (overrides.eyebrow?.trim()) payload.eyebrow = overrides.eyebrow.trim();
  if (overrides.footer?.trim()) payload.footer = overrides.footer.trim();
  if (overrides.theme?.trim()) payload.theme = overrides.theme.trim();
  return payload;
}
