/**
 * HTML template for the `gateway_recovery` report.
 *
 * Renders a standalone, print-ready HTML document (theme tokens already applied
 * via CSS vars) showing: the crash/recovery trigger, per-agent stacked cards
 * with status pills, what's currently running, and recovery observations. The
 * worker prints this to PDF via puppeteer.
 *
 * Pure string templating — no DOM, no deps — so it works identically in the
 * gateway and the standalone worker process.
 */

import type { Theme } from "../types.js";
import { statusPillCss, themeToCssVars } from "../themes/index.js";

export interface AgentCard {
  runId: string;
  label: string;
  task: string;
  status: string;
  backend?: string;
  startedAt?: number | null;
  endedAt?: number | null;
  durationMs?: number | null;
  error?: string | null;
  filesTouched?: number;
}

export interface GatewayRecoveryData {
  generatedAt: number;
  /** [startMs, endMs] of the incident window inspected. */
  incidentWindow: [number, number];
  trigger: string;
  /** Agents interrupted by the crash (being resurrected). */
  interrupted: AgentCard[];
  /** Agents that completed/failed inside the window (from history). */
  resolved: AgentCard[];
  /** Agents still live/running after recovery. */
  running: AgentCard[];
  observations: string[];
  mock?: boolean;
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

function fmtDuration(ms?: number | null): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function pillClass(status: string): string {
  const known = [
    "ok",
    "ready",
    "sent",
    "complete",
    "running",
    "queued",
    "rendering",
    "error",
    "failed",
    "timeout",
    "interrupted",
  ];
  return known.includes(status) ? `pill-${status}` : "pill-queued";
}

function agentCard(a: AgentCard): string {
  const meta: string[] = [];
  if (a.backend) meta.push(`backend ${esc(a.backend)}`);
  meta.push(`started ${fmtTime(a.startedAt)}`);
  if (a.endedAt) meta.push(`ended ${fmtTime(a.endedAt)}`);
  meta.push(`duration ${fmtDuration(a.durationMs)}`);
  if (typeof a.filesTouched === "number") meta.push(`${a.filesTouched} files`);
  return `
  <div class="card">
    <div class="card-head">
      <span class="run-id">${esc(a.runId)}</span>
      <span class="pill ${pillClass(a.status)}">${esc(a.status)}</span>
    </div>
    <div class="card-label">${esc(a.label || "(unlabeled)")}</div>
    <div class="card-task">${esc(a.task).slice(0, 400)}</div>
    <div class="card-meta">${meta.map((m) => `<span>${m}</span>`).join("<i>·</i>")}</div>
    ${a.error ? `<div class="card-error">${esc(a.error).slice(0, 500)}</div>` : ""}
  </div>`;
}

function section(title: string, count: number, body: string): string {
  return `
  <section>
    <h2>${esc(title)} <span class="count">${count}</span></h2>
    ${count ? body : `<p class="empty">None.</p>`}
  </section>`;
}

export function buildGatewayRecoveryHtml(data: GatewayRecoveryData, theme: Theme): string {
  const [winStart, winEnd] = data.incidentWindow;
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
    .trigger-banner {
      background: var(--surface-alt);
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      border-radius: 6px; padding: 14px 16px; margin-bottom: 26px;
    }
    .trigger-banner .lbl {
      font-family: var(--font-heading); font-size: 10px; letter-spacing: 2px;
      text-transform: uppercase; color: var(--accent); display: block; margin-bottom: 4px;
    }
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
    .card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .run-id { font-family: var(--font-heading); font-size: 12px; color: var(--accent); }
    .pill {
      font-family: var(--font-heading); font-size: 10px; letter-spacing: 1px;
      text-transform: uppercase; padding: 2px 10px; border-radius: 11px; font-weight: 600;
    }
    ${statusPillCss(theme.tokens)}
    .card-label { font-weight: 600; margin: 8px 0 4px; font-size: 13px; }
    .card-task { color: var(--text-muted); font-size: 12px; white-space: pre-wrap; }
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
    ul.obs { list-style: none; padding: 0; margin: 0; }
    ul.obs li {
      padding: 9px 14px; background: var(--surface); border: 1px solid var(--border);
      border-left: 3px solid var(--accent-strong); border-radius: 5px; margin-bottom: 8px;
      font-size: 12px;
    }
    footer.report-foot {
      margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--border);
      font-family: var(--font-heading); font-size: 10px; color: var(--text-muted);
      display: flex; justify-content: space-between;
    }
    .mock-tag {
      background: var(--accent); color: var(--bg); font-family: var(--font-heading);
      font-size: 10px; padding: 2px 8px; border-radius: 4px; letter-spacing: 1px;
    }
  `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Gateway Recovery Report</title>
  <style>${css}</style>
</head>
<body>
  <div class="page">
    <header class="report-head">
      <div class="eyebrow">InfiniBot · Incident Report</div>
      <h1>Gateway Recovery${data.mock ? ' <span class="mock-tag">MOCK</span>' : ""}</h1>
      <div class="subtitle">Automated post-recovery analysis of subagent runs across the incident window.</div>
      <div class="meta-grid">
        <span>Generated <b>${fmtTime(data.generatedAt)}</b></span>
        <span>Window <b>${fmtTime(winStart)}</b> → <b>${fmtTime(winEnd)}</b></span>
        <span>Interrupted <b>${data.interrupted.length}</b></span>
        <span>Resolved <b>${data.resolved.length}</b></span>
        <span>Running <b>${data.running.length}</b></span>
      </div>
    </header>

    <div class="trigger-banner">
      <span class="lbl">Recovery Trigger</span>
      ${esc(data.trigger)}
    </div>

    ${section(
      "Interrupted by crash · resurrecting",
      data.interrupted.length,
      data.interrupted.map(agentCard).join(""),
    )}

    ${section("Currently running", data.running.length, data.running.map(agentCard).join(""))}

    ${section("Resolved in window", data.resolved.length, data.resolved.map(agentCard).join(""))}

    ${section(
      "Recovery observations",
      data.observations.length,
      `<ul class="obs">${data.observations.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>`,
    )}

    <footer class="report-foot">
      <span>InfiniBot Report System</span>
      <span>${theme.label} · gateway_recovery</span>
    </footer>
  </div>
</body>
</html>`;
}
