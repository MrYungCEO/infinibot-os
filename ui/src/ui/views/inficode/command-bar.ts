/**
 * InfiCode — bottom command bar: spawn (agentId + task, targeted at the
 * selected device) and, when an agent glyph is selected, its control-parity
 * actions (abort / pause / resume / respawn / send message).
 */

import { html, nothing, type TemplateResult } from "lit";
import type { InfiCodeView } from "./index.js";
import * as actions from "./actions.js";

const SPAWN_AGENTS = ["coder", "opus", "tester", "architect", "backend", "reviewer", "doc"];

export function renderCommandBar(host: InfiCodeView): TemplateResult {
  const a = host.selectedAgent();
  return html`
    <div class="ic-cmd" data-learn-id="inficode-command-bar">
      <span class="ic-cmd-prompt">infinibot ❯ inficode ❯</span>
      <select
        data-learn-id="inficode-spawn-agent"
        class="ic-select"
        @change=${(e: Event) => (host.spawnAgentId = (e.target as HTMLSelectElement).value)}
      >
        ${SPAWN_AGENTS.map(
          (id) => html`<option value=${id} ?selected=${id === host.spawnAgentId}>${id}</option>`,
        )}
      </select>
      <input
        data-learn-id="inficode-spawn-task"
        class="ic-input"
        placeholder="spawn task on ${host.selectedDeviceLabel()}…"
        .value=${host.spawnTask}
        @input=${(e: Event) => (host.spawnTask = (e.target as HTMLInputElement).value)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") void actions.spawnSelected(host);
        }}
      />
      <button class="ic-btn" data-learn-id="inficode-spawn" @click=${() => actions.spawnSelected(host)}>spawn</button>
      ${a
        ? html`
            <span class="ic-dim">│ ${a.agentId} [${a.status}]</span>
            <button class="ic-btn danger" @click=${() => actions.agentAction(host, "abort")}>abort</button>
            <button class="ic-btn" @click=${() => actions.agentAction(host, "pause")}>pause</button>
            <button class="ic-btn" @click=${() => actions.agentAction(host, "resume")}>resume</button>
            <button class="ic-btn" @click=${() => actions.agentAction(host, "respawn")}>respawn</button>
            <input
              class="ic-input"
              style="max-width:180px;"
              placeholder="send message…"
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") void actions.sendToSelected(host, e.target as HTMLInputElement);
              }}
            />
          `
        : html`<span class="ic-cmd-note">select an agent glyph to control it</span>`}
    </div>
  `;
}
