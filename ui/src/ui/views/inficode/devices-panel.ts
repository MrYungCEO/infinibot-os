/**
 * InfiCode — DEVICES panel.
 *
 * Lists every federation node (role/status/agentCount/capabilities) with the
 * device's current role + context CLEARLY VISIBLE and EDITABLE (the headline
 * ask), plus wired role (rotate/revoke), pairing (approve/reject) and invoke
 * RPCs. See rpc.ts for the exact param shapes.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { InfiCodeView } from "./index.js";
import { nodeColor, shortAge } from "./helpers.js";
import * as actions from "./actions.js";
import type { MeshNode } from "../../controllers/agent-mesh.js";

function renderDevice(host: InfiCodeView, node: MeshNode): TemplateResult {
  const sel = host.selectedNodeId === node.id;
  const caps = node.capabilities && node.capabilities.length ? node.capabilities.join(", ") : "—";
  return html`
    <div class="ic-row ${sel ? "sel" : ""}">
      <div class="ic-row-top">
        <span class="ic-dot" style="background:${nodeColor(node)}"></span>
        <span class="ic-row-name" @click=${() => host.selectNode(sel ? null : node.id)}>${node.name}</span>
        <span class="ic-row-badges">
          <span class="ic-badge on">${node.role}</span>
          <span class="ic-badge ${node.status === "online" ? "on" : ""}">${node.status}</span>
          <span class="ic-badge">${node.agentCount} agt</span>
          ${node.lastSeen ? html`<span class="ic-badge">${shortAge(node.lastSeen)}</span>` : nothing}
        </span>
      </div>
      <div class="ic-caps">caps: ${caps}</div>
      <div class="ic-caps">
        url: ${node.url
          ? html`<span class="ic-dim" style="user-select:all">${node.url}</span>`
          : html`<span class="ic-dim">not advertised</span>`}
      </div>

      <div class="ic-ctx-line">
        <span class="ic-dim">role</span>
        <input
          class="ic-inline-input"
          .value=${host.roleDraftFor(node.id)}
          placeholder="hub | satellite | operator…"
          @input=${(e: Event) => host.setRoleDraft(node.id, (e.target as HTMLInputElement).value)}
        />
        <input
          class="ic-inline-input"
          .value=${host.scopeDraftFor(node.id)}
          placeholder="scopes (space-sep)"
          @input=${(e: Event) => host.setScopeDraft(node.id, (e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="ic-ctx-line">
        <span class="ic-dim">ctx</span>
        <input
          class="ic-inline-input"
          .value=${host.contextFor(node.id)}
          placeholder="what work this device should take…"
          @input=${(e: Event) => host.setContextDraft(node.id, (e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="ic-btn-row">
        <button class="ic-btn" @click=${() => actions.applyDeviceRole(host, node)}>rotate role</button>
        <button class="ic-btn danger" @click=${() => actions.revokeDeviceRole(host, node)}>revoke</button>
        <button class="ic-btn" @click=${() => actions.saveDeviceContext(host, node)}>save ctx</button>
        <button class="ic-btn" @click=${() => actions.invokeOnDevice(host, node)}>invoke</button>
      </div>
    </div>
  `;
}

export function renderDevicesPanel(host: InfiCodeView): TemplateResult {
  const nodes = host.nodes();
  const pending = host.pairingPending();
  return html`
    <div class="ic-panel" data-learn-id="inficode-devices">
      <div class="ic-panel-head">
        <span class="ic-corner">├</span>
        <span class="ic-title">DEVICES</span>
        <span class="ic-meta"><span>${nodes.length} nodes</span>${
          pending.length ? html`<span class="ic-gold">${pending.length} pending</span>` : nothing
        }</span>
      </div>
      <div class="ic-panel-body">
        ${pending.length
          ? html`
              <div style="margin-bottom:8px;">
                <div class="ic-dim" style="margin-bottom:4px;">pairing requests</div>
                ${pending.map(
                  (p) => html`
                    <div class="ic-row">
                      <div class="ic-row-top">
                        <span class="ic-row-name">${p.displayName || p.deviceId}</span>
                        <span class="ic-row-badges">
                          <span class="ic-badge">${p.role || "?"}</span>
                          ${p.remoteIp ? html`<span class="ic-badge">${p.remoteIp}</span>` : nothing}
                        </span>
                      </div>
                      <div class="ic-btn-row">
                        <button class="ic-btn" @click=${() => actions.approvePair(host, p.requestId)}>approve</button>
                        <button class="ic-btn danger" @click=${() => actions.rejectPair(host, p.requestId)}>reject</button>
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}
        ${nodes.length === 0
          ? html`<div class="ic-dim">no devices — awaiting federation.nodes.list…</div>`
          : nodes.map((n) => renderDevice(host, n))}
      </div>
    </div>
  `;
}
