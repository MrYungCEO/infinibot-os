/**
 * InfiCode — CODER panel ("inficode"). Two surfaces:
 *   (a) an embedded live xterm running cliType:"claude", targetable to the
 *       selected device (remote devices route through federation.node.invoke
 *       automatically via hooks/usePtyProcess.ts). Reuses the xterm Lit
 *       directive + terminals controller verbatim.
 *   (b) a "spawn coder" action → sessions.spawn { agentId:"coder", task, node }
 *       whose spawned coder then appears as a glyph on the map.
 */

import { html, type TemplateResult } from "lit";
import type { InfiCodeView } from "./index.js";
import { xterm } from "../../directives/xterm.js";
import * as actions from "./actions.js";

export function renderCoderPanel(host: InfiCodeView): TemplateResult {
  const appState = host.appState;
  const termId = host.coderTerminalId();
  const target = host.selectedDeviceLabel();

  return html`
    <div class="ic-panel" data-learn-id="inficode-coder">
      <div class="ic-panel-head">
        <span class="ic-corner">┴</span>
        <span class="ic-title">CODER</span>
        <span class="ic-meta"><span>claude → ${target}</span></span>
      </div>
      <div class="ic-panel-body" style="padding:0;">
        <div class="ic-coder-wrap">
          <div style="display:flex;gap:5px;padding:6px 8px;border-bottom:1px solid var(--ic-line);">
            <input
              data-learn-id="inficode-coder-task"
              class="ic-input"
              style="flex:1;"
              .value=${host.coderTask}
              placeholder="task for spawned coder…"
              @input=${(e: Event) => (host.coderTask = (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") void actions.spawnCoder(host);
              }}
            />
            <button class="ic-btn" data-learn-id="inficode-coder-spawn" @click=${() => actions.spawnCoder(host)}>spawn coder</button>
          </div>
          ${appState && termId
            ? html`<div class="ic-coder-term" ${xterm({ terminalId: termId, state: appState, isActive: true })}></div>`
            : html`<div class="ic-coder-empty">
                gateway not connected — embedded coder unavailable
              </div>`}
        </div>
      </div>
    </div>
  `;
}
