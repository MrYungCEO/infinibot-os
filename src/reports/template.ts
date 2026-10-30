/**
 * Generic black-and-gold report template.
 *
 * This is the SINGLE source of truth for what an InfiniBot PDF looks like.
 * Given a structured {@link ReportPayload} and a {@link Theme} (black-gold by
 * default), it returns a standalone, print-ready HTML document with the theme's
 * tokens baked in as CSS vars. No DOM, no deps — pure string templating — so it
 * runs identically in the gateway and the standalone worker.
 *
 * The existing per-kind templates (templates/daily-summary.ts, etc.) predate
 * this and remain for their bespoke layouts; everything NEW should build a
 * payload and render through here so the look never drifts again.
 */

import type { ReportPayload, ReportSection, ReportTable, Theme } from "./types.js";
import { statusPillCss, themeToCssVars } from "./themes/index.js";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function fmtTime(ms?: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return "—";
  }
}

/** Render plain body text: blank-line paragraphs, "- " lines become bullets. */
function bodyHtml(body: string): string {
  const blocks = body.split(/\n\s*\n/);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd());
    const isList = lines.every((l) => l.trim().startsWith("- ") || l.trim() === "");
    if (isList) {
      const items = lines
        .filter((l) => l.trim().startsWith("- "))
        .map((l) => `<li>${esc(l.trim().slice(2))}</li>`)
        .join("");
      if (items) out.push(`<ul>${items}</ul>`);
    } else {
      out.push(`<p>${esc(block).replace(/\n/g, "<br/>")}</p>`);
    }
  }
  return out.join("");
}

function tableHtml(table: ReportTable): string {
  const pillCols = new Set(table.pillColumns ?? []);
  const head = table.columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = table.rows
    .map((row) => {
      const cells = row
        .map((cell, i) => {
          if (pillCols.has(i)) {
            const key = String(cell)
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "");
            return `<td><span class="pill pill-${esc(key)}">${esc(cell)}</span></td>`;
          }
          return `<td>${esc(cell)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table class="report-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function sectionHtml(section: ReportSection): string {
  const parts: string[] = [];
  if (section.body) parts.push(bodyHtml(section.body));
  if (section.bullets?.length) {
    parts.push(`<ul>${section.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`);
  }
  if (section.table) parts.push(tableHtml(section.table));
  if (section.code) parts.push(`<pre class="code">${esc(section.code)}</pre>`);
  const count =
    typeof section.count === "number" ? `<span class="count">${section.count}</span>` : "";
  return `
  <section>
    <h2>${esc(section.heading)} ${count}</h2>
    ${parts.join("\n") || `<p class="empty">—</p>`}
  </section>`;
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-body);
    font-size: 13px;
    line-height: 1.55;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page { padding: 40px 44px; max-width: 900px; margin: 0 auto; }
  header.report-head {
    border-bottom: 2px solid var(--accent);
    padding-bottom: 18px; margin-bottom: 26px;
  }
  .eyebrow {
    font-family: var(--font-heading);
    color: var(--accent);
    letter-spacing: 3px; text-transform: uppercase; font-size: 11px;
  }
  h1 {
    font-family: var(--font-heading);
    font-size: 28px; margin: 6px 0 4px; color: var(--text); font-weight: 700;
  }
  .subtitle { color: var(--text-muted); font-size: 12px; max-width: 70ch; }
  .meta-grid {
    display: flex; flex-wrap: wrap; gap: 18px; margin-top: 14px;
    font-family: var(--font-heading); font-size: 11px; color: var(--text-muted);
  }
  .meta-grid b { color: var(--accent-strong); font-weight: 600; }
  section { margin-bottom: 26px; }
  h2 {
    font-family: var(--font-heading); font-size: 15px; color: var(--text);
    border-bottom: 1px solid var(--border); padding-bottom: 7px; margin-bottom: 14px;
    display: flex; align-items: center; gap: 10px;
  }
  h2 .count {
    font-size: 11px; background: var(--surface-alt); color: var(--accent);
    border: 1px solid var(--border); border-radius: 10px; padding: 1px 9px;
  }
  p { margin: 0 0 10px; }
  ul { margin: 0 0 12px; padding-left: 18px; }
  li { margin: 3px 0; }
  li::marker { color: var(--accent); }
  .empty { color: var(--text-muted); font-style: italic; }
  .report-table {
    width: 100%; border-collapse: collapse; margin: 4px 0 12px;
    font-size: 12px; break-inside: avoid;
  }
  .report-table th {
    text-align: left; font-family: var(--font-heading); font-size: 10px;
    letter-spacing: 1px; text-transform: uppercase; color: var(--accent);
    border-bottom: 1px solid var(--accent-strong); padding: 7px 10px;
  }
  .report-table td {
    padding: 8px 10px; border-bottom: 1px solid var(--border);
    color: var(--text); vertical-align: top;
  }
  .report-table tbody tr:nth-child(even) { background: var(--surface); }
  .pill {
    font-family: var(--font-heading); font-size: 10px; letter-spacing: 1px;
    text-transform: uppercase; padding: 2px 10px; border-radius: 11px;
    font-weight: 600; display: inline-block;
  }
  .pill-default, .pill- { color: var(--text); background: var(--surface-alt); }
  pre.code {
    background: var(--surface); border: 1px solid var(--border);
    border-left: 3px solid var(--accent); border-radius: 6px;
    padding: 12px 14px; font-family: var(--font-heading); font-size: 11px;
    color: var(--text); overflow-x: auto; white-space: pre-wrap;
    word-break: break-word; break-inside: avoid;
  }
  footer.report-foot {
    margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--border);
    font-family: var(--font-heading); font-size: 10px; color: var(--text-muted);
    display: flex; justify-content: space-between; gap: 16px; white-space: pre-wrap;
  }
`;

/**
 * Turn a structured payload into a standalone black-gold HTML document.
 * Theme tokens are inlined as CSS vars so the document is fully self-contained.
 */
export function renderReportHtml(payload: ReportPayload, theme: Theme): string {
  const generatedAt = payload.generatedAt ?? Date.now();
  const eyebrow = payload.eyebrow ?? "InfiniBot · Report";

  const metricCells = (payload.metrics ?? [])
    .map((m) => `<span>${esc(m.label)} <b>${esc(m.value)}</b></span>`)
    .join("");

  const sections = payload.sections.map(sectionHtml).join("\n");

  const css = `${themeToCssVars(theme.tokens)}\n${BASE_CSS}\n${statusPillCss(theme.tokens)}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(payload.title)}</title>
  <style>${css}</style>
</head>
<body>
  <div class="page">
    <header class="report-head">
      <div class="eyebrow">${esc(eyebrow)}</div>
      <h1>${esc(payload.title)}</h1>
      ${payload.subtitle ? `<div class="subtitle">${esc(payload.subtitle)}</div>` : ""}
      <div class="meta-grid">
        <span>Generated <b>${fmtTime(generatedAt)}</b></span>
        ${metricCells}
      </div>
    </header>

    ${sections}

    <footer class="report-foot">
      <span>InfiniBot Report System</span>
      <span>${esc(theme.label)}${payload.footer ? ` · ${esc(payload.footer)}` : ""}</span>
    </footer>
  </div>
</body>
</html>`;
}
