/**
 * HTML template for the `daily_summary` report — the 24-hour summary PDF.
 *
 * Renders a standalone, print-ready HTML document (theme tokens already applied
 * via CSS vars) with two headline sections the brief calls for explicitly:
 *
 *   1. "Items Completed"      — kanban tasks marked done + subagent runs that
 *                                finished successfully inside the 24h window.
 *   2. "Verification Required" — kanban tasks sitting in the `review` column +
 *                                subagent runs that errored / timed out and need
 *                                a human to look at them.
 *
 * Pure string templating — no DOM, no deps — so it works identically in the
 * gateway and the standalone worker process. The worker prints this to PDF via
 * puppeteer (see {@link ../renderer.ts}).
 */

import type { Theme } from "../types.js";
import { statusPillCss, themeToCssVars } from "../themes/index.js";

/** A single thing that got done in the window. */
export interface CompletedItem {
  /** "task" = kanban card; "agent" = subagent run. */
  source: "task" | "agent";
  id: string;
  title: string;
  /** Backend / status / project line shown under the title. */
  detail?: string;
  /** Unix ms the item completed (completedAt / endedAt). */
  at: number | null;
}

/** A single thing that finished but still needs a human to verify it. */
export interface VerificationItem {
  source: "task" | "agent";
  id: string;
  title: string;
  /** Why it needs verification: "in review", "errored", "timed out". */
  reason: string;
  detail?: string;
  /** When it landed in this state (updatedAt / endedAt). */
  at: number | null;
  /** Short error excerpt for failed agents. */
  error?: string | null;
}

export interface DailySummaryData {
  generatedAt: number;
  /** [startMs, endMs] of the 24h window inspected. */
  window: [number, number];
  completed: CompletedItem[];
  verification: VerificationItem[];
  /** Headline counts for the metric grid. */
  stats: {
    tasksDone: number;
    agentsDone: number;
    reviewTasks: number;
    agentsNeedingAttention: number;
  };
  /** How many items were hidden by the per-section cap (0 when nothing trimmed). */
  overflow?: { completed: number; verification: number };
  /** Sources that could not be read this run (degraded, not fatal). */
  collectionGaps: string[];
}

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

function sourcePill(source: "task" | "agent"): string {
  return source === "task"
    ? `<span class="pill pill-complete">kanban</span>`
    : `<span class="pill pill-running">agent</span>`;
}

function reasonPillClass(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("error")) return "pill-error";
  if (r.includes("timed")) return "pill-timeout";
  return "pill-queued"; // "in review"
}

function completedCard(item: CompletedItem): string {
  const meta: string[] = [];
  if (item.detail) meta.push(esc(item.detail));
  meta.push(`completed ${fmtTime(item.at)}`);
  return `
  <div class="card">
    <div class="card-head">
      <span class="run-id">${esc(item.id).slice(0, 32)}</span>
      ${sourcePill(item.source)}
    </div>
    <div class="card-label">${esc(item.title || "(untitled)").slice(0, 200)}</div>
    <div class="card-meta">${meta.map((m) => `<span>${m}</span>`).join("<i>·</i>")}</div>
  </div>`;
}

function verificationCard(item: VerificationItem): string {
  const meta: string[] = [];
  if (item.detail) meta.push(esc(item.detail));
  meta.push(`since ${fmtTime(item.at)}`);
  return `
  <div class="card">
    <div class="card-head">
      <span class="run-id">${esc(item.id).slice(0, 32)}</span>
      <span class="pill ${reasonPillClass(item.reason)}">${esc(item.reason)}</span>
      ${sourcePill(item.source)}
    </div>
    <div class="card-label">${esc(item.title || "(untitled)").slice(0, 200)}</div>
    <div class="card-meta">${meta.map((m) => `<span>${m}</span>`).join("<i>·</i>")}</div>
    ${item.error ? `<div class="card-error">${esc(item.error).slice(0, 400)}</div>` : ""}
  </div>`;
}

function section(title: string, count: number, body: string, emptyMsg: string): string {
  return `
  <section>
    <h2>${esc(title)} <span class="count">${count}</span></h2>
    ${count ? body : `<p class="empty">${esc(emptyMsg)}</p>`}
  </section>`;
}

export function buildDailySummaryHtml(data: DailySummaryData, theme: Theme): string {
  const [winStart, winEnd] = data.window;
  const css = `
    ${themeToCssVars(theme.tokens)}
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-body);
      font-size: 13px;
      line-height: 1.5;
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
    .subtitle { color: var(--text-muted); font-size: 12px; }
    .meta-grid {
      display: flex; flex-wrap: wrap; gap: 18px; margin-top: 14px;
      font-family: var(--font-heading); font-size: 11px; color: var(--text-muted);
    }
    .meta-grid b { color: var(--accent-strong); font-weight: 600; }
    section { margin-bottom: 28px; }
    h2 {
      font-family: var(--font-heading); font-size: 15px; color: var(--text);
      border-bottom: 1px solid var(--border); padding-bottom: 7px; margin-bottom: 14px;
      display: flex; align-items: center; gap: 10px;
    }
    h2 .count {
      font-size: 11px; background: var(--surface-alt); color: var(--accent);
      border: 1px solid var(--border); border-radius: 10px; padding: 1px 9px;
    }
    .card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 14px 16px; margin-bottom: 12px;
      break-inside: avoid;
    }
    section.verification .card { border-left: 4px solid var(--accent-strong); }
    .card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .run-id { font-family: var(--font-heading); font-size: 12px; color: var(--accent); margin-right: auto; }
    .pill {
      font-family: var(--font-heading); font-size: 10px; letter-spacing: 1px;
      text-transform: uppercase; padding: 2px 10px; border-radius: 11px; font-weight: 600;
    }
    ${statusPillCss(theme.tokens)}
    .card-label { font-weight: 600; margin: 8px 0 4px; font-size: 13px; white-space: pre-wrap; }
    .card-meta {
      margin-top: 9px; font-family: var(--font-heading); font-size: 10px;
      color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    }
    .card-meta i { color: var(--border); font-style: normal; }
    .card-error {
      margin-top: 9px; background: rgba(122,34,34,0.18); border: 1px solid #7a2222;
      border-radius: 5px; padding: 8px 10px; font-family: var(--font-heading);
      font-size: 11px; color: #f1c9c9; white-space: pre-wrap;
    }
    .empty { color: var(--text-muted); font-style: italic; }
    .more {
      color: var(--text-muted); font-family: var(--font-heading); font-size: 11px;
      margin: 4px 0 0; text-align: center; font-style: italic;
    }
    footer.report-foot {
      margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--border);
      font-family: var(--font-heading); font-size: 10px; color: var(--text-muted);
      display: flex; justify-content: space-between; white-space: pre-wrap;
    }
  `;

  const gaps = data.collectionGaps.length
    ? `\nData gaps: ${data.collectionGaps.map(esc).join("; ")}`
    : "";
  const moreNote = (n: number | undefined): string =>
    n && n > 0 ? `<p class="more">+ ${n} more not shown (capped for size)</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>24-Hour Summary Report</title>
  <style>${css}</style>
</head>
<body>
  <div class="page">
    <header class="report-head">
      <div class="eyebrow">InfiniBot · Daily Summary</div>
      <h1>24-Hour Summary</h1>
      <div class="subtitle">Everything completed in the last 24 hours, and everything still waiting on your verification.</div>
      <div class="meta-grid">
        <span>Generated <b>${fmtTime(data.generatedAt)}</b></span>
        <span>Window <b>${fmtTime(winStart)}</b> → <b>${fmtTime(winEnd)}</b></span>
        <span>Tasks done <b>${data.stats.tasksDone}</b></span>
        <span>Agents done <b>${data.stats.agentsDone}</b></span>
        <span>In review <b>${data.stats.reviewTasks}</b></span>
        <span>Need attention <b>${data.stats.agentsNeedingAttention}</b></span>
      </div>
    </header>

    ${section(
      "Items Completed",
      data.stats.tasksDone + data.stats.agentsDone,
      data.completed.map(completedCard).join("") + moreNote(data.overflow?.completed),
      "Nothing completed in the last 24 hours.",
    )}

    <section class="verification">
      <h2>Verification Required <span class="count">${data.stats.reviewTasks + data.stats.agentsNeedingAttention}</span></h2>
      ${
        data.verification.length
          ? data.verification.map(verificationCard).join("") + moreNote(data.overflow?.verification)
          : `<p class="empty">Nothing is waiting on verification. You're clear.</p>`
      }
    </section>

    <footer class="report-foot">
      <span>InfiniBot Report System</span>
      <span>${esc(theme.label)} · daily_summary${gaps}</span>
    </footer>
  </div>
</body>
</html>`;
}
