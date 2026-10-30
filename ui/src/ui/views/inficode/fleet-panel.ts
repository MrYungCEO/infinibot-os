/**
 * InfiCode — FLEET panel.
 *
 * Remote servers running infinicode: one row per node, hardware meters
 * (reusing the same .ic-meter-* classes as the local hardware panel) and
 * the most recent maintenance report. Deliberately flat-list rather than
 * the sector grid the local agent map uses — a managed server isn't an
 * agent-in-a-sector, it's a node with hardware + a report history.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { InfiCodeView } from "./index.js";
import { barMeter, meterColor, shortAge } from "./helpers.js";
import type { FleetRecord } from "./fleet-types.js";

function statusDot(rec: FleetRecord): string {
  if (rec.status?.connected === false) return "var(--ic-dim)";
  const age = Date.now() - rec.lastSeenAt;
  if (age > 5 * 60_000) return "var(--g-state-warn, #fcd34d)";
  const lastReport = rec.reports[rec.reports.length - 1];
  if (lastReport && !lastReport.ok) return "var(--g-state-danger, #f87171)";
  return "var(--g-primary)";
}

function renderMeter(label: string, pct: number | undefined): TemplateResult | typeof nothing {
  if (typeof pct !== "number" || Number.isNaN(pct)) return nothing;
  return html`
    <div class="ic-meter-row">
      <span class="ic-meter-label">${label}</span>
      <span class="ic-meter-bar" style="color:${meterColor(pct)}">${barMeter(pct)}</span>
      <span class="ic-meter-val">${Math.round(pct)}%</span>
    </div>
  `;
}

/** A node "just" reported within this window gets the pulse animation — purely
 *  derived from lastSeenAt + the view's existing 1s tick timer, no extra
 *  state to track or clean up. */
const FRESH_MS = 3000;

function renderNode(host: InfiCodeView, rec: FleetRecord): TemplateResult {
  const sel = host.selectedFleetNodeId === rec.nodeId;
  const lastReport = rec.reports[rec.reports.length - 1];
  const hw = rec.hardware;
  const fresh = Date.now() - rec.lastSeenAt < FRESH_MS;
  return html`
    <div class="ic-row ${sel ? "sel" : ""}" @click=${() => host.selectFleetNode(sel ? null : rec.nodeId)}>
      <div class="ic-row-top">
        <span class="ic-dot ${fresh ? "ic-dot-pulse" : ""}" style="background:${statusDot(rec)}"></span>
        <span class="ic-row-name">${rec.status?.displayName ?? rec.nodeId}</span>
        <span class="ic-row-badges">
          ${rec.status?.role ? html`<span class="ic-badge on">${rec.status.role}</span>` : nothing}
          <span class="ic-badge">${shortAge(rec.lastSeenAt)} ago</span>
        </span>
      </div>
      ${rec.status?.platform || hw?.system?.hostname
        ? html`<div class="ic-hw-host">${hw?.system?.hostname ?? rec.status?.platform}</div>`
        : nothing}
      ${renderMeter("cpu", hw?.cpu?.percent)}
      ${renderMeter("mem", hw?.memory?.percent)}
      ${lastReport
        ? html`
            <div class="ic-caps">
              <span style="color:${lastReport.ok ? "var(--g-state-ok, #4ade80)" : "var(--g-state-danger, #f87171)"}"
                >${lastReport.ok ? "✓" : "✗"}</span
              >
              ${lastReport.taskName} — ${shortAge(lastReport.finishedAt)} ago
            </div>
          `
        : html`<div class="ic-caps ic-dim">no maintenance reports yet</div>`}
      <div class="ic-btn-row">
        <button class="ic-btn" @click=${(e: Event) => { e.stopPropagation(); host.requestMaintenance(rec.nodeId); }}>
          run maintenance now
        </button>
      </div>
    </div>
  `;
}

/** Group by site only once it matters — a single-site fleet (today's reality)
 *  renders exactly as a flat list; a second site makes group headers appear
 *  automatically, no config flag needed. */
function groupBySite(nodes: FleetRecord[]): Map<string, FleetRecord[]> {
  const groups = new Map<string, FleetRecord[]>();
  for (const rec of nodes) {
    const site = rec.status?.site?.trim() || "Unassigned";
    const list = groups.get(site) ?? [];
    list.push(rec);
    groups.set(site, list);
  }
  return groups;
}

export function renderFleetPanel(host: InfiCodeView): TemplateResult {
  const nodes = host.fleetNodes();
  const groups = groupBySite(nodes);
  const showSiteHeaders = groups.size > 1;
  return html`
    <div class="ic-panel" data-learn-id="inficode-fleet" style="grid-row: 1 / 2;">
      <div class="ic-panel-head">
        <span class="ic-corner">┌</span>
        <span class="ic-title">INFINICODE // FLEET</span>
        <span class="ic-meta">
          <span>${nodes.length} node${nodes.length === 1 ? "" : "s"}</span>
          ${showSiteHeaders ? html`<span>${groups.size} sites</span>` : nothing}
          <span>${host.connected() ? "◉ live" : "○ poll"}</span>
        </span>
      </div>
      <div class="ic-panel-body">
        ${nodes.length === 0
          ? html`<span class="ic-dim">no fleet nodes — awaiting infinicode.push.status…</span>`
          : [...groups.entries()].map(
              ([site, recs]) => html`
                ${showSiteHeaders ? html`<div class="ic-site-head">${site}</div>` : nothing}
                ${recs.map((n) => renderNode(host, n))}
              `,
            )}
      </div>
    </div>
  `;
}
