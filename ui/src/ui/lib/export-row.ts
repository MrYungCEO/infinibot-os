/**
 * Database row export — turn a row's title, properties, body and related
 * data into a downloadable artifact (Markdown, HTML, JSON, PDF).
 *
 * PDF strategy: zero-dependency. Open a popup window, write a fully self-
 * contained HTML document (template CSS embedded), then trigger the
 * browser's native print dialog. The user picks "Save as PDF" — vector
 * quality, paginated, works offline. No `puppeteer`, `jsPDF`, or
 * `html2pdf` install footprint.
 *
 * The four templates (`minimal`, `document`, `magazine`, `brand-card`)
 * share a print-aware base so things like page breaks and footer marks
 * behave correctly when handed to `window.print()`.
 */
import { toSanitizedMarkdownHtml } from "../markdown.js";
import type {
  DatabaseProperty,
  DatabaseRecord,
  DatabaseRow,
  PropertyValue,
} from "../controllers/databases.js";

export type ExportFormat = "markdown" | "html" | "json" | "pdf";
export type ExportTemplate = "minimal" | "document" | "magazine" | "brand-card";

export interface ExportOptions {
  /** Include the row's properties section. Default true. */
  includeProperties: boolean;
  /** Include the body markdown. Default true. */
  includeBody: boolean;
  /** Include the row metadata footer (created/updated timestamps + ids). */
  includeMeta: boolean;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  includeProperties: true,
  includeBody: true,
  includeMeta: false,
};

export const TEMPLATE_LABELS: Record<ExportTemplate, string> = {
  minimal: "Minimal",
  document: "Document",
  magazine: "Magazine",
  "brand-card": "Brand Card",
};

export const TEMPLATE_DESCRIPTIONS: Record<ExportTemplate, string> = {
  minimal: "Clean monochrome — fast read, generous whitespace.",
  document: "Serif body, classic margins. Reports, briefs, contracts.",
  magazine: "Two-column body with a hero band. Long-form features.",
  "brand-card": "Single-page card with gradient background. Pitch handouts.",
};

// ─── Property formatters ─────────────────────────────────────────────────

/** Single-line plaintext rendering of a PropertyValue. Used by markdown,
 *  json and the property table in HTML. */
export function formatPropertyValue(value: PropertyValue | undefined, prop: DatabaseProperty): string {
  if (!value) return "";
  switch (value.type) {
    case "title":
      return value.text;
    case "richText":
      return value.markdown ?? "";
    case "select":
    case "status": {
      if (!value.optionId) return "";
      const opt = prop.config?.options?.find((o) => o.id === value.optionId);
      return opt?.name ?? value.optionId;
    }
    case "multiSelect":
      return value.optionIds
        .map((id) => prop.config?.options?.find((o) => o.id === id)?.name ?? id)
        .join(", ");
    case "date":
      return value.iso ? new Date(value.iso).toLocaleDateString() : "";
    case "dateRange":
      if (!value.start) return "";
      return value.end
        ? `${new Date(value.start).toLocaleDateString()} – ${new Date(value.end).toLocaleDateString()}`
        : new Date(value.start).toLocaleDateString();
    case "number": {
      if (value.value == null) return "";
      const fmt = prop.config?.format;
      if (fmt === "currency")
        return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value.value);
      if (fmt === "percent") return `${(value.value * 100).toFixed(1)}%`;
      return String(value.value);
    }
    case "checkbox":
      return value.checked ? "✓" : "✗";
    case "url":
      return value.url ?? "";
    case "email":
      return value.email ?? "";
    case "phone":
      return value.phone ?? "";
    case "files":
      return value.files.map((f) => f.name).join(", ");
    case "relation":
      return value.rowIds.join(", ");
    case "person":
      return value.personIds.join(", ");
    case "createdAt":
    case "updatedAt":
      return new Date(value.iso).toLocaleString();
    default:
      return "";
  }
}

// ─── Markdown ──────────────────────────────────────────────────────────

export function rowToMarkdown(
  row: DatabaseRow,
  db: DatabaseRecord | null,
  props: DatabaseProperty[],
  opts: ExportOptions,
): string {
  const lines: string[] = [];
  lines.push(`# ${row.title || "Untitled"}`);
  lines.push("");
  if (db) lines.push(`*${db.name}*`);
  lines.push("");

  if (opts.includeProperties) {
    const visible = props.filter((p) => p.type !== "title" && !p.hidden);
    if (visible.length > 0) {
      lines.push("## Properties");
      lines.push("");
      lines.push("| Field | Value |");
      lines.push("|---|---|");
      for (const p of visible) {
        const text = formatPropertyValue(row.values[p.id], p);
        lines.push(`| **${p.name}** | ${text.replace(/\|/g, "\\|") || "—"} |`);
      }
      lines.push("");
    }
  }

  if (opts.includeBody && row.body) {
    lines.push("## Content");
    lines.push("");
    lines.push(row.body);
    lines.push("");
  }

  if (opts.includeMeta) {
    lines.push("---");
    lines.push("");
    lines.push(`*Created: ${new Date(row.createdAt).toLocaleString()}*`);
    lines.push(`*Updated: ${new Date(row.updatedAt).toLocaleString()}*`);
    lines.push(`*ID: \`${row.id}\`*`);
  }

  return lines.join("\n");
}

// ─── JSON ──────────────────────────────────────────────────────────────

export function rowToJson(
  row: DatabaseRow,
  db: DatabaseRecord | null,
  props: DatabaseProperty[],
  opts: ExportOptions,
): string {
  const valuesByName: Record<string, unknown> = {};
  for (const p of props) {
    const v = row.values[p.id];
    valuesByName[p.name] = {
      type: p.type,
      raw: v ?? null,
      formatted: formatPropertyValue(v, p),
    };
  }
  const payload: Record<string, unknown> = {
    title: row.title,
    database: db ? { id: db.id, name: db.name } : null,
  };
  if (opts.includeProperties) payload.properties = valuesByName;
  if (opts.includeBody) payload.body = row.body;
  if (opts.includeMeta) {
    payload.meta = {
      id: row.id,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
  return JSON.stringify(payload, null, 2);
}

// ─── HTML / PDF ────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c] ?? c;
  });
}

function renderPropsTable(row: DatabaseRow, props: DatabaseProperty[]): string {
  const visible = props.filter((p) => p.type !== "title" && !p.hidden);
  if (!visible.length) return "";
  const rows = visible
    .map((p) => {
      const text = formatPropertyValue(row.values[p.id], p);
      return `<tr><th>${escHtml(p.name)}</th><td>${escHtml(text) || "&mdash;"}</td></tr>`;
    })
    .join("");
  return `<table class="ex-props"><tbody>${rows}</tbody></table>`;
}

/**
 * Self-contained HTML document for a row. Includes template-specific CSS
 * inline so the file works offline / when downloaded. Body markdown is
 * sanitised and rendered to HTML via the existing `marked` integration.
 */
export function rowToHtml(
  row: DatabaseRow,
  db: DatabaseRecord | null,
  props: DatabaseProperty[],
  opts: ExportOptions,
  template: ExportTemplate,
): string {
  const titleText = row.title || "Untitled";
  const dbLabel = db?.name ?? "Database";
  const bodyHtml = opts.includeBody && row.body ? toSanitizedMarkdownHtml(row.body) : "";
  const propsHtml = opts.includeProperties ? renderPropsTable(row, props) : "";
  const metaHtml = opts.includeMeta
    ? `<footer class="ex-meta">
        <span>Created ${escHtml(new Date(row.createdAt).toLocaleString())}</span>
        <span>Updated ${escHtml(new Date(row.updatedAt).toLocaleString())}</span>
        <span class="ex-meta-id">${escHtml(row.id)}</span>
      </footer>`
    : "";

  const css = TEMPLATE_CSS[template];

  let body = "";
  if (template === "magazine") {
    body = `
      <article class="ex-page ex-magazine">
        <header class="ex-hero">
          <div class="ex-hero-bar"></div>
          <div class="ex-eyebrow">${escHtml(dbLabel)}</div>
          <h1 class="ex-title">${escHtml(titleText)}</h1>
        </header>
        <section class="ex-columns">
          ${propsHtml ? `<aside class="ex-aside">${propsHtml}</aside>` : ""}
          <main class="ex-body">${bodyHtml}</main>
        </section>
        ${metaHtml}
      </article>
    `;
  } else if (template === "brand-card") {
    body = `
      <article class="ex-page ex-card">
        <div class="ex-card-bg"></div>
        <div class="ex-card-content">
          <div class="ex-eyebrow">${escHtml(dbLabel)}</div>
          <h1 class="ex-title">${escHtml(titleText)}</h1>
          ${propsHtml}
          ${bodyHtml ? `<div class="ex-body">${bodyHtml}</div>` : ""}
          ${metaHtml}
        </div>
      </article>
    `;
  } else {
    // minimal + document share the same one-column anatomy; templates
    // diverge purely via CSS.
    body = `
      <article class="ex-page ex-${template}">
        <header class="ex-head">
          <div class="ex-eyebrow">${escHtml(dbLabel)}</div>
          <h1 class="ex-title">${escHtml(titleText)}</h1>
        </header>
        ${propsHtml}
        ${bodyHtml ? `<main class="ex-body">${bodyHtml}</main>` : ""}
        ${metaHtml}
      </article>
    `;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(titleText)}</title>
  <style>${BASE_CSS}\n${css}</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Open a print window with the templated HTML and trigger the browser's
 * native print dialog. The user picks "Save as PDF" from the destination
 * dropdown. We don't auto-close because some browsers cancel the print
 * if the originator window closes first; user closes the popup themselves.
 */
export function printRowAsPdf(
  row: DatabaseRow,
  db: DatabaseRecord | null,
  props: DatabaseProperty[],
  opts: ExportOptions,
  template: ExportTemplate,
): { ok: boolean; reason?: string } {
  if (typeof window === "undefined") return { ok: false, reason: "No window" };
  const html = rowToHtml(row, db, props, opts, template);
  const win = window.open("", "_blank", "width=900,height=1100");
  if (!win) return { ok: false, reason: "Popup blocked — allow popups for this site and retry." };
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Wait until images / fonts settle before invoking print, otherwise
  // the dialog can render mid-paint with placeholder boxes.
  win.addEventListener("load", () => {
    setTimeout(() => {
      try { win.focus(); win.print(); } catch { /* user cancelled */ }
    }, 120);
  });
  return { ok: true };
}

/**
 * Browser-side download of a string blob with a chosen filename + mime.
 * Used by the markdown / html / json paths.
 */
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
  // Defer revoke — Safari has cancelled downloads when revoke fires too early.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function safeFilename(title: string, ext: string): string {
  const base = (title || "untitled").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${base || "untitled"}.${ext}`;
}

// ─── CSS templates ────────────────────────────────────────────────────

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; color: #111827; }
  body { -webkit-font-smoothing: antialiased; }
  .ex-page {
    max-width: 720px;
    margin: 0 auto;
    padding: 56px 64px;
    line-height: 1.65;
  }
  .ex-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-size: 11px;
    color: #6b7280;
    margin-bottom: 12px;
  }
  .ex-title {
    font-size: 36px;
    line-height: 1.15;
    margin: 0 0 24px;
    letter-spacing: -0.01em;
  }
  .ex-props {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 28px;
    font-size: 14px;
  }
  .ex-props th, .ex-props td {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid #e5e7eb;
    vertical-align: top;
  }
  .ex-props th {
    width: 32%;
    color: #4b5563;
    font-weight: 600;
  }
  .ex-body { font-size: 15px; }
  .ex-body h1 { font-size: 26px; margin: 28px 0 12px; }
  .ex-body h2 { font-size: 22px; margin: 24px 0 10px; }
  .ex-body h3 { font-size: 18px; margin: 20px 0 8px; }
  .ex-body p { margin: 0 0 12px; }
  .ex-body ul, .ex-body ol { padding-left: 24px; margin: 0 0 12px; }
  .ex-body li { margin: 4px 0; }
  .ex-body code {
    background: #f3f4f6;
    padding: 1px 6px;
    border-radius: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.9em;
  }
  .ex-body pre {
    background: #f3f4f6;
    border-radius: 8px;
    padding: 12px 16px;
    overflow: auto;
    font-size: 13px;
    line-height: 1.55;
  }
  .ex-body pre code { background: transparent; padding: 0; }
  .ex-body blockquote {
    border-left: 3px solid #d1d5db;
    margin: 16px 0;
    padding: 4px 16px;
    color: #4b5563;
    font-style: italic;
  }
  .ex-body a { color: #2563eb; }
  .ex-body img { max-width: 100%; height: auto; border-radius: 6px; }
  .ex-body hr { border: 0; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  .ex-meta {
    display: flex; gap: 16px; flex-wrap: wrap;
    margin-top: 36px; padding-top: 16px;
    border-top: 1px solid #e5e7eb;
    font-size: 11px; color: #6b7280;
  }
  .ex-meta-id { font-family: ui-monospace, monospace; }
  @page { size: A4; margin: 18mm; }
  @media print {
    .ex-page { padding: 0; max-width: none; }
    .ex-body { font-size: 13px; }
    .ex-title { font-size: 28px; }
    a { color: #111827; text-decoration: none; }
  }
`;

const TEMPLATE_CSS: Record<ExportTemplate, string> = {
  minimal: `
    body { font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    .ex-minimal .ex-title { font-weight: 700; color: #0f172a; }
  `,
  document: `
    body { font-family: 'Iowan Old Style', 'Palatino Linotype', Georgia, serif; color: #1f2937; }
    .ex-document .ex-title { font-weight: 600; }
    .ex-document .ex-body { font-size: 16px; line-height: 1.75; }
    .ex-document .ex-body h1, .ex-document .ex-body h2, .ex-document .ex-body h3 {
      font-family: 'Inter', system-ui, sans-serif;
      letter-spacing: -0.005em;
    }
    .ex-document .ex-eyebrow { color: #92400e; }
    .ex-document::after {
      content: "";
      position: fixed; right: 18mm; bottom: 12mm;
      font-size: 10px; color: #9ca3af;
    }
  `,
  magazine: `
    body { font-family: 'Inter', system-ui, sans-serif; background: #fafafa; }
    .ex-magazine { max-width: 920px; padding: 0 0 56px; }
    .ex-hero {
      position: relative;
      padding: 80px 64px 56px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #312e81 100%);
      color: #fafafa;
      margin-bottom: 48px;
    }
    .ex-magazine .ex-hero-bar {
      position: absolute; left: 64px; top: 60px;
      width: 64px; height: 4px;
      background: linear-gradient(90deg, #fbbf24, #f59e0b);
    }
    .ex-magazine .ex-hero .ex-eyebrow { color: #fbbf24; }
    .ex-magazine .ex-hero .ex-title { color: #f9fafb; font-size: 48px; line-height: 1.05; max-width: 720px; }
    .ex-columns {
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 48px;
      padding: 0 64px;
    }
    .ex-magazine .ex-aside .ex-props {
      font-size: 12px;
    }
    .ex-magazine .ex-aside th {
      width: 100%; display: block;
      text-transform: uppercase; letter-spacing: 0.12em;
      color: #6b7280; font-size: 10px;
      border: none; padding: 12px 0 4px;
    }
    .ex-magazine .ex-aside td {
      width: 100%; display: block;
      border: none; padding: 0 0 6px;
      color: #111827; font-size: 13px;
    }
    .ex-magazine .ex-body { font-size: 15px; }
    .ex-magazine .ex-body p:first-of-type::first-letter {
      float: left;
      font-size: 64px; line-height: 0.9;
      padding: 6px 10px 0 0;
      color: #92400e;
      font-weight: 700;
    }
    @media print {
      .ex-hero { padding: 40mm 18mm 30mm; }
      .ex-columns { padding: 0 18mm; grid-template-columns: 200px 1fr; gap: 24mm; }
    }
  `,
  "brand-card": `
    body { font-family: 'Inter', system-ui, sans-serif; }
    .ex-card {
      position: relative;
      max-width: none; padding: 0;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
    }
    .ex-card-bg {
      position: absolute; inset: 0;
      background:
        radial-gradient(ellipse 60% 50% at 0% 0%, rgba(251, 191, 36, 0.4), transparent 60%),
        radial-gradient(ellipse 60% 50% at 100% 100%, rgba(99, 102, 241, 0.4), transparent 60%),
        linear-gradient(135deg, #0f172a, #1e1b4b);
    }
    .ex-card-content {
      position: relative; z-index: 1;
      max-width: 640px;
      width: 100%;
      margin: 0 auto;
      padding: 56px 56px 64px;
      color: #f9fafb;
      background: rgba(15, 23, 42, 0.55);
      backdrop-filter: blur(20px) saturate(140%);
      border: 1px solid rgba(251, 191, 36, 0.25);
      border-radius: 20px;
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.12),
        0 30px 80px rgba(0, 0, 0, 0.45);
    }
    .ex-card .ex-eyebrow { color: #fbbf24; }
    .ex-card .ex-title { color: #ffffff; font-size: 40px; }
    .ex-card .ex-props { font-size: 13px; }
    .ex-card .ex-props th { color: #cbd5e1; }
    .ex-card .ex-props td { color: #f9fafb; }
    .ex-card .ex-props th, .ex-card .ex-props td { border-bottom-color: rgba(255,255,255,0.1); }
    .ex-card .ex-body, .ex-card .ex-body * { color: #e5e7eb; }
    .ex-card .ex-body code, .ex-card .ex-body pre { background: rgba(0,0,0,0.4); color: #f9fafb; }
    .ex-card .ex-body a { color: #fcd34d; }
    .ex-card .ex-meta { color: #94a3b8; border-top-color: rgba(255,255,255,0.12); }
    @page { size: A4 landscape; margin: 0; }
    @media print {
      .ex-card { min-height: 0; }
      .ex-card-content { box-shadow: none; }
    }
  `,
};
