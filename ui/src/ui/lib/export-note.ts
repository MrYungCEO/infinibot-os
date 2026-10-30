/**
 * Note export — turn a note's name + body + metadata into downloadable
 * artifacts (Markdown, HTML, PDF, Plain Text).
 *
 * PDF via browser print: zero-dependency. Opens a popup with self-contained
 * HTML, triggers the native print dialog. User picks "Save as PDF".
 *
 * Style presets for HTML/PDF: clean, proposal, compact, dark.
 */
import { toSanitizedMarkdownHtml } from "../markdown.js";

export type NoteExportFormat = "markdown" | "html" | "pdf" | "txt";
export type NoteExportStyle = "clean" | "proposal" | "compact" | "dark";

export const EXPORT_STYLE_LABELS: Record<NoteExportStyle, string> = {
  clean: "Clean",
  proposal: "Proposal",
  compact: "Compact",
  dark: "Dark",
};

export const EXPORT_STYLE_DESCRIPTIONS: Record<NoteExportStyle, string> = {
  clean: "Neutral serif body, generous whitespace. Best for reading.",
  proposal: "Gold accents, professional feel. Client-facing documents.",
  compact: "Small margins, dense layout. Developer notes, specs.",
  dark: "Dark background, gold highlights. Presentation-friendly.",
};

export function safeFilename(title: string, ext: string): string {
  const base = (title || "untitled").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${base || "untitled"}.${ext}`;
}

export function noteToMarkdown(
  name: string,
  body: string,
  meta?: { description?: string; tags?: string[]; category?: string; updatedAt?: string },
): string {
  const lines: string[] = [];
  lines.push(`# ${name || "Untitled"}`);
  lines.push("");
  if (meta?.description) {
    lines.push(`> ${meta.description}`);
    lines.push("");
  }
  if (meta?.tags?.length || meta?.category) {
    const parts: string[] = [];
    if (meta.category) parts.push(`**Category:** ${meta.category}`);
    if (meta.tags?.length) parts.push(`**Tags:** ${meta.tags.join(", ")}`);
    lines.push(parts.join(" · "));
    lines.push("");
  }
  if (meta?.updatedAt) {
    lines.push(`*Last updated: ${new Date(meta.updatedAt).toLocaleString()}*`);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(body);
  lines.push("");
  return lines.join("\n");
}

export function noteToHtml(
  name: string,
  body: string,
  style: NoteExportStyle,
  meta?: { description?: string; tags?: string[]; category?: string; updatedAt?: string },
): string {
  const titleText = name || "Untitled";
  const bodyHtml = toSanitizedMarkdownHtml(body);
  const css = STYLE_CSS[style];

  let metaHtml = "";
  if (meta?.description || meta?.tags?.length || meta?.category || meta?.updatedAt) {
    const parts: string[] = [];
    if (meta.description) parts.push(`<p class="ex-desc">${escHtml(meta.description)}</p>`);
    if (meta.category || meta.tags?.length) {
      const chips: string[] = [];
      if (meta.category) chips.push(`<span class="ex-chip">${escHtml(meta.category)}</span>`);
      if (meta.tags?.length) chips.push(...meta.tags.map((t) => `<span class="ex-chip ex-tag">${escHtml(t)}</span>`));
      parts.push(`<div class="ex-chips">${chips.join(" ")}</div>`);
    }
    if (meta.updatedAt) {
      parts.push(`<p class="ex-date">${new Date(meta.updatedAt).toLocaleString()}</p>`);
    }
    metaHtml = `<header class="ex-meta-block">${parts.join("\n")}</header>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(titleText)}</title>
  <style>${BASE_CSS}\n${css}</style>
</head>
<body>
  <article class="ex-page ex-${style}">
    <h1 class="ex-title">${escHtml(titleText)}</h1>
    ${metaHtml}
    <main class="ex-body">${bodyHtml}</main>
  </article>
</body>
</html>`;
}

export function downloadBlob(filename: string, mime: string, content: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function printNoteAsPdf(
  name: string,
  body: string,
  style: NoteExportStyle,
  meta?: { description?: string; tags?: string[]; category?: string; updatedAt?: string },
): { ok: boolean; reason?: string } {
  if (typeof window === "undefined") return { ok: false, reason: "No window" };
  const html = noteToHtml(name, body, style, meta);
  const win = window.open("", "_blank", "width=900,height=1100");
  if (!win) return { ok: false, reason: "Popup blocked — allow popups for this site and retry." };
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.addEventListener("load", () => {
    setTimeout(() => {
      try { win.focus(); win.print(); } catch { }
    }, 120);
  });
  return { ok: true };
}

function escHtml(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c] ?? c;
  });
}

const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; color: #111827; }
body { -webkit-font-smoothing: antialiased; }
.ex-page {
  max-width: 760px;
  margin: 0 auto;
  padding: 48px 56px;
  line-height: 1.65;
}
.ex-title {
  font-size: 36px;
  line-height: 1.15;
  margin: 0 0 8px;
  letter-spacing: -0.01em;
  font-weight: 700;
}
.ex-meta-block {
  margin-bottom: 28px;
  padding-bottom: 16px;
  border-bottom: 1px solid #e5e7eb;
}
.ex-desc { font-size: 14px; color: #6b7280; margin: 0 0 8px; font-style: italic; }
.ex-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.ex-chip {
  font-size: 10px; padding: 2px 8px; border-radius: 999px;
  background: #f3f4f6; color: #4b5563; letter-spacing: 0.5px;
  text-transform: uppercase; font-weight: 600;
}
.ex-tag { background: #eef2ff; color: #4338ca; }
.ex-date { font-size: 11px; color: #9ca3af; margin: 0; }
.ex-body { font-size: 15px; }
.ex-body h1 { font-size: 26px; margin: 28px 0 12px; }
.ex-body h2 { font-size: 22px; margin: 24px 0 10px; }
.ex-body h3 { font-size: 18px; margin: 20px 0 8px; }
.ex-body h4 { font-size: 15px; margin: 16px 0 6px; }
.ex-body p { margin: 0 0 12px; }
.ex-body ul, .ex-body ol { padding-left: 24px; margin: 0 0 12px; }
.ex-body li { margin: 4px 0; }
.ex-body input[type="checkbox"] { margin: 0 4px 0 0; accent-color: #2563eb; }
.ex-body blockquote {
  border-left: 3px solid #d1d5db;
  margin: 16px 0; padding: 4px 16px;
  color: #4b5563; font-style: italic;
}
.ex-body code {
  background: #f3f4f6; padding: 1px 6px; border-radius: 4px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em;
}
.ex-body pre {
  background: #f3f4f6; border-radius: 8px; padding: 12px 16px;
  overflow: auto; font-size: 13px; line-height: 1.55;
}
.ex-body pre code { background: transparent; padding: 0; }
.ex-body a { color: #2563eb; }
.ex-body img { max-width: 100%; height: auto; border-radius: 6px; }
.ex-body hr { border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0; }
.ex-body table { border-collapse: collapse; margin: 12px 0; width: 100%; }
.ex-body th, .ex-body td {
  padding: 6px 10px; border: 1px solid #d1d5db;
  text-align: left; vertical-align: top;
}
.ex-body th { background: #f3f4f6; font-weight: 600; }
@page { size: A4; margin: 18mm; }
@media print {
  .ex-page { padding: 0; max-width: none; }
  .ex-body { font-size: 13px; }
  .ex-title { font-size: 28px; }
  a { color: #111827; text-decoration: none; }
}
`;

const STYLE_CSS: Record<NoteExportStyle, string> = {
  clean: `
    body { font-family: 'Iowan Old Style', 'Palatino Linotype', Georgia, serif; color: #1f2937; }
    .ex-clean .ex-title { color: #0f172a; }
    .ex-clean .ex-body { font-size: 16px; line-height: 1.75; }
    .ex-clean .ex-body h1, .ex-clean .ex-body h2, .ex-clean .ex-body h3,
    .ex-clean .ex-body h4 { font-family: 'Inter', system-ui, sans-serif; letter-spacing: -0.005em; }
  `,
  proposal: `
    body { font-family: 'Inter', system-ui, -apple-system, sans-serif; color: #1f2937; }
    .ex-proposal .ex-title { color: #92400e; border-bottom: 3px solid #fbbf24; padding-bottom: 8px; }
    .ex-proposal .ex-body h1, .ex-proposal .ex-body h2, .ex-proposal .ex-body h3 { color: #92400e; }
    .ex-proposal .ex-body blockquote { border-left-color: #fbbf24; color: #6b7280; }
    .ex-proposal .ex-body pre { border-left: 3px solid #fbbf24; }
    .ex-proposal .ex-chip { background: #fffbeb; color: #92400e; }
  `,
  compact: `
    body { font-family: 'Inter', system-ui, -apple-system, sans-serif; color: #111827; }
    .ex-compact { max-width: none; padding: 32px 40px; }
    .ex-compact .ex-title { font-size: 24px; margin-bottom: 4px; }
    .ex-compact .ex-body { font-size: 13px; line-height: 1.5; }
    .ex-compact .ex-body p { margin: 0 0 6px; }
    .ex-compact .ex-body h1 { font-size: 18px; margin: 16px 0 6px; }
    .ex-compact .ex-body h2 { font-size: 16px; margin: 14px 0 5px; }
    .ex-compact .ex-body h3 { font-size: 14px; margin: 12px 0 4px; }
    .ex-compact .ex-body pre { padding: 8px 12px; font-size: 11px; }
    .ex-compact .ex-meta-block { margin-bottom: 16px; padding-bottom: 8px; }
    @media print { .ex-compact .ex-body { font-size: 11px; } }
  `,
  dark: `
    body { background: #0f172a; color: #e2e8f0; }
    .ex-dark .ex-title { color: #fbbf24; }
    .ex-dark .ex-meta-block { border-bottom-color: rgba(251, 191, 36, 0.2); }
    .ex-dark .ex-desc { color: #94a3b8; }
    .ex-dark .ex-chip { background: rgba(251, 191, 36, 0.1); color: #fbbf24; }
    .ex-dark .ex-tag { background: rgba(99, 102, 241, 0.15); color: #a5b4fc; }
    .ex-dark .ex-date { color: #64748b; }
    .ex-dark .ex-body h1, .ex-dark .ex-body h2, .ex-dark .ex-body h3, .ex-dark .ex-body h4 { color: #fbbf24; }
    .ex-dark .ex-body a { color: #fcd34d; }
    .ex-dark .ex-body blockquote { border-left-color: #fbbf24; color: #94a3b8; }
    .ex-dark .ex-body code { background: rgba(255,255,255,0.08); color: #fbbf24; }
    .ex-dark .ex-body pre { background: rgba(255,255,255,0.04); border: 1px solid rgba(251,191,36,0.15); }
    .ex-dark .ex-body pre code { color: #e2e8f0; }
    .ex-dark .ex-body th { background: rgba(251,191,36,0.08); color: #fbbf24; border-color: rgba(251,191,36,0.2); }
    .ex-dark .ex-body td { border-color: rgba(251,191,36,0.2); }
    @media print { .ex-dark { background: #0f172a !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  `,
};
