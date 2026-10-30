/**
 * Oversight reports — shared markdown + persistence + telemetry helpers.
 *
 * Every oversight report is built as a canonical {@link ReportPayload} (so it
 * gets the same black-gold PDF + the report store's markitdown parity copy as
 * everything else — see src/reports/index.ts). On top of that, the brief asks
 * for two extra guarantees these helpers provide:
 *
 *   1. A clean Markdown rendering of the payload (H1/H2 sections, GFM tables,
 *      bullets, and a "Top 3 actions" footer) saved to
 *      `~/.infinibot/reports/<freq>/<slug>-<date>.md` so an agent can ingest the
 *      report without a markitdown round-trip from the PDF.
 *   2. Secret redaction before anything touches disk (reuses the audited
 *      `redactSensitiveText` helper — never hand-roll a second redactor).
 *
 * `renderOversightCollected()` is the single call a report kind makes: it
 * redacts, renders the themed HTML for the worker's PDF path, writes the freq
 * markdown copy, emits the `[oversight]` telemetry line, and returns the
 * {@link CollectedReport} the worker contract expects.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { redactSensitiveText } from "../../logging/redact.js";
import { renderReportHtml } from "../template.js";
import { getTheme } from "../themes/index.js";
import type { CollectedReport, ReportPayload, ReportSection, Theme } from "../types.js";

export type OversightFreq = "daily" | "weekly" | "monthly" | "continuous";

function resolveStateDir(stateDir?: string): string {
  return stateDir ?? process.env.INFINIBOT_STATE_DIR ?? join(homedir(), ".infinibot");
}

/** `~/.infinibot/reports` — mirrors src/reports/worker/engine.ts reportsDir(). */
function reportsRoot(stateDir?: string): string {
  return join(resolveStateDir(stateDir), "reports");
}

/** Local YYYY-MM-DD (not UTC) so a daily file lands under the operator's date. */
export function localDateSlug(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function escapeCell(v: string | number): string {
  // Pipes and newlines would break a GFM table row.
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function sectionToMarkdown(s: ReportSection): string {
  const out: string[] = [];
  const heading = s.count != null ? `## ${s.heading} (${s.count})` : `## ${s.heading}`;
  out.push(heading);
  if (s.body?.trim()) {
    // A body line beginning "- " is already a bullet; keep paragraphs intact.
    out.push(s.body.trim());
  }
  if (s.bullets?.length) {
    out.push(s.bullets.map((b) => `- ${b}`).join("\n"));
  }
  if (s.table && s.table.columns.length) {
    const { columns, rows } = s.table;
    out.push(`| ${columns.map(escapeCell).join(" | ")} |`);
    out.push(`| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
      out.push(`| ${row.map(escapeCell).join(" | ")} |`);
    }
  }
  if (s.code?.trim()) {
    out.push("```\n" + s.code.trim() + "\n```");
  }
  return out.join("\n\n");
}

/**
 * Render a {@link ReportPayload} as clean GitHub-flavoured Markdown: an H1
 * title, optional subtitle + metric line, one H2 per section (with tables /
 * bullets / code), and a "Top 3 actions" footer derived from `topActions` (or
 * the payload footer as a fallback).
 */
export function payloadToMarkdown(
  payload: ReportPayload,
  opts: { topActions?: string[]; generatedAt?: number } = {},
): string {
  const lines: string[] = [];
  lines.push(`# ${payload.title}`);
  if (payload.subtitle) lines.push(`_${payload.subtitle}_`);
  const when = opts.generatedAt ?? payload.generatedAt ?? Date.now();
  lines.push(`> Generated ${new Date(when).toLocaleString()}`);
  if (payload.metrics?.length) {
    lines.push(payload.metrics.map((m) => `**${m.label}:** ${m.value}`).join(" · "));
  }
  for (const s of payload.sections) {
    lines.push(sectionToMarkdown(s));
  }
  const actions = opts.topActions?.filter(Boolean) ?? [];
  if (actions.length) {
    lines.push("## Top 3 Actions");
    lines.push(
      actions
        .slice(0, 3)
        .map((a, i) => `${i + 1}. ${a}`)
        .join("\n"),
    );
  } else if (payload.footer) {
    lines.push(`---\n_${payload.footer}_`);
  }
  return lines.join("\n\n") + "\n";
}

export interface SaveOversightMarkdownInput {
  freq: OversightFreq;
  slug: string;
  markdown: string;
  stateDir?: string;
  now?: number;
}

/**
 * Write the (redacted) markdown to `~/.infinibot/reports/<freq>/<slug>-<date>.md`
 * and return the absolute path. Best-effort: a write failure logs and returns
 * null rather than aborting the whole report.
 */
export function saveOversightMarkdown(input: SaveOversightMarkdownInput): string | null {
  try {
    const dir = join(reportsRoot(input.stateDir), input.freq);
    fs.mkdirSync(dir, { recursive: true });
    const date = localDateSlug(input.now ?? Date.now());
    const path = join(dir, `${input.slug}-${date}.md`);
    fs.writeFileSync(path, redactSensitiveText(input.markdown), "utf-8");
    return path;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[oversight] failed to save markdown for ${input.slug}: ${String(err)}`);
    return null;
  }
}

/** Emit the standard telemetry line so a failing/slow cron is visible in logs. */
export function logOversight(
  slug: string,
  startedAtMs: number,
  producedReport: string | null,
): void {
  const ms = Math.max(0, Date.now() - startedAtMs);
  // eslint-disable-next-line no-console
  console.log(`[oversight] ${slug} ran in ${ms}ms producedReport=${producedReport ?? "none"}`);
}

export interface RenderOversightOptions {
  slug: string;
  freq: OversightFreq;
  payload: ReportPayload;
  /** Theme passed by the worker's collect() call; falls back to black-gold. */
  theme?: Theme;
  /** Pulled out so the markdown footer carries the same "Top 3 actions". */
  topActions?: string[];
  summaryText: string;
  stateDir?: string;
  now?: number;
}

/**
 * The single call an oversight report kind makes inside `collect()`:
 *   - redacts the payload (defensive: secrets should never reach a kind, but a
 *     collected error string or row value might),
 *   - renders themed HTML for the worker's PDF,
 *   - writes the freq markdown parity copy,
 *   - emits telemetry,
 *   - returns the {@link CollectedReport} contract the worker persists.
 */
export function renderOversightCollected(opts: RenderOversightOptions): CollectedReport {
  const started = Date.now();
  const theme = opts.theme ?? getTheme(opts.payload.theme);
  // Redact section bodies/code in place (tables are short cell values; the
  // redactor handles them through the markdown path too).
  const redactedPayload: ReportPayload = {
    ...opts.payload,
    sections: opts.payload.sections.map((s) => ({
      ...s,
      body: s.body ? redactSensitiveText(s.body) : s.body,
      code: s.code ? redactSensitiveText(s.code) : s.code,
    })),
  };
  const html = renderReportHtml(redactedPayload, theme);
  const markdown = payloadToMarkdown(redactedPayload, {
    topActions: opts.topActions,
    generatedAt: opts.now,
  });
  const producedReport = saveOversightMarkdown({
    freq: opts.freq,
    slug: opts.slug,
    markdown,
    stateDir: opts.stateDir,
    now: opts.now,
  });
  logOversight(opts.slug, started, producedReport);
  return {
    title: opts.payload.title,
    summaryText: opts.summaryText,
    html,
  };
}
