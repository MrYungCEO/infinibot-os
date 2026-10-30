/**
 * InfiCode — MESH MAP centerpiece.
 *
 * A simplified, live-reactive twin of the isometric Agent Ops map, drawn in
 * plain DOM + monospace (no PixiJS/three.js):
 *   • device-nodes as boxes in a top rail (click to select → filters agents)
 *   • the 10 fixed sectors as a monospace spatial grid
 *   • live agent glyphs (●/◆) placed in their sector, colored by status with a
 *     small progress indicator
 *   • mesh links + brief message pulses summarised beneath the grid
 */

import { html, nothing, type TemplateResult } from "lit";
import type { InfiCodeView } from "./index.js";
import { SECTORS, sectorForAgent } from "./sectors.js";
import { agentGlyph, statusColor, nodeColor, shortAge } from "./helpers.js";
import type { MeshAgent } from "../../controllers/agent-mesh.js";

function renderNode(host: InfiCodeView, nodeId: string) {
  const node = host.nodeById(nodeId);
  if (!node) return nothing;
  const sel = host.selectedNodeId === nodeId;
  return html`
    <div class="ic-node ${sel ? "sel" : ""}" @click=${() => host.selectNode(sel ? null : nodeId)}>
      <div class="ic-node-name">
        <span class="ic-dot" style="background:${nodeColor(node)}"></span>${node.name}
      </div>
      <div class="ic-node-role">${node.role}</div>
      <div class="ic-node-stats">
        <span>${node.agentCount} agt</span>
        <span>${node.status}</span>
        ${node.lastSeen ? html`<span>${shortAge(node.lastSeen)}</span>` : nothing}
      </div>
    </div>
  `;
}

function renderAgentGlyph(host: InfiCodeView, agent: MeshAgent): TemplateResult {
  const key = agent.sessionKey;
  const sel = host.selectedAgentKey === key;
  const prog = agent.progress > 0 && agent.progress < 100 ? `${Math.round(agent.progress)}%` : "";
  return html`
    <span
      class="ic-agent ${sel ? "sel" : ""}"
      title="${agent.label} · ${agent.status}${agent.currentTask ? " · " + agent.currentTask : ""}"
      @click=${(e: Event) => {
        e.stopPropagation();
        host.selectAgent(sel ? null : key);
      }}
    >
      <span class="ic-agent-glyph" style="color:${statusColor(agent.status)}">${agentGlyph(agent)}</span>
      <span class="ic-agent-label">${agent.agentId}</span>
      ${prog ? html`<span class="ic-agent-prog">${prog}</span>` : nothing}
    </span>
  `;
}

export function renderMeshMap(host: InfiCodeView): TemplateResult {
  const agents = host.visibleAgents();
  // Bucket agents into their sectors once.
  const bySector = new Map<string, MeshAgent[]>();
  for (const a of agents) {
    const sid = sectorForAgent(a);
    const list = bySector.get(sid) ?? [];
    list.push(a);
    bySector.set(sid, list);
  }

  const nodeIds = host.nodes().map((n) => n.id);
  const messages = host.recentMessages().slice(0, 4);

  return html`
    <div class="ic-panel" data-learn-id="inficode-mesh-map" style="grid-row: 1 / 2;">
      <div class="ic-panel-head">
        <span class="ic-corner">┌</span>
        <span class="ic-title">INFINIBOT // MESH MAP</span>
        <span class="ic-meta">
          <span>${host.nodes().length} nodes</span>
          <span>${agents.length} agents</span>
          <span>${host.connected() ? "◉ live" : "○ poll"}</span>
          <button
            type="button"
            class="ic-mesh-iso-link"
            data-learn-id="inficode-iso-link"
            title="Open the isometric Agent Mesh map"
            @click=${() => host.state?.setTab?.("mesh")}
          >iso map →</button>
        </span>
      </div>

      <div class="ic-nodes-rail" data-learn-id="inficode-nodes-rail">
        ${nodeIds.length === 0
          ? html`<span class="ic-dim">no nodes — awaiting federation.status…</span>`
          : nodeIds.map((id) => renderNode(host, id))}
      </div>

      <div class="ic-panel-body" style="padding:0;">
        <div class="ic-sector-grid" data-learn-id="inficode-sectors">
          ${SECTORS.map((s) => {
            const list = bySector.get(s.id) ?? [];
            const active = list.some((a) => a.status === "working" || a.status === "starting");
            const sel = host.selectedSectorId === s.id;
            return html`
              <div
                class="ic-sector ${active ? "active" : ""} ${sel ? "sel" : ""}"
                @click=${() => host.selectSector(sel ? null : s.id)}
              >
                <div class="ic-sector-head">
                  <span>${s.glyph}</span>
                  <span>${s.name}</span>
                </div>
                <div class="ic-sector-sys">${s.system}</div>
                <div class="ic-sector-agents">
                  ${list.length === 0
                    ? html`<span class="ic-sector-empty">·</span>`
                    : list.slice(0, 8).map((a) => renderAgentGlyph(host, a))}
                  ${list.length > 8 ? html`<span class="ic-sector-empty">+${list.length - 8}</span>` : nothing}
                </div>
              </div>
            `;
          })}
        </div>
      </div>

      <div class="ic-map-links">
        ${messages.length === 0
          ? html`<div class="ic-link-row ic-dim">mesh idle — no messages</div>`
          : messages.map(
              (m, i) => html`
                <div class="ic-link-row">
                  <span class="${i === 0 ? "ic-pulse" : "ic-dim"}">${i === 0 ? "⇢" : "·"}</span>
                  <span class="ic-gold">${m.fromLabel || m.from}</span>
                  <span> → </span>
                  <span>${m.toLabel || m.to}</span>
                  <span class="ic-dim"> [${m.type}]</span>
                </div>
              `,
            )}
      </div>
    </div>
  `;
}
