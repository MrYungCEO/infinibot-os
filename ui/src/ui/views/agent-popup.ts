/**
 * Agent Command Popup
 * Quick agent configuration modal (Agents page gear button / /agent command).
 *
 * Black-gold glass modal; the `.agm-*` styles live in glass-agents-mgmt.css.ts
 * and are rendered by the Agents page (agents-management.ts → editors.styles).
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { AgentsManagementState, AgentListEntry } from "../controllers/agents-management";
import {
  updateAgentModel,
  updateAgentTools,
  updateAgentSkills,
  updateAgentSubagents,
  updateAgentSystemPrompt,
} from "../controllers/agents-management";
import { icons } from "../icons";
import { glassEmpty } from "./glass-agents-shared";

// ============================================================
// Local UI State
// ============================================================

/** Current agent being configured in the popup */
let popupAgentId: string | null = null;

/** Current tab in the popup */
let popupActiveTab: string = "model";

/** Temporary prompt draft for the popup */
let popupPromptDraft: string = "";

/** Whether popup is visible */
let popupVisible: boolean = false;

// ============================================================
// Public API
// ============================================================

export function showAgentPopup(agentId?: string) {
  popupAgentId = agentId || null;
  popupActiveTab = "model";
  popupPromptDraft = "";
  popupVisible = true;
}

export function hideAgentPopup() {
  popupVisible = false;
  popupAgentId = null;
  popupPromptDraft = "";
}

export function isAgentPopupVisible(): boolean {
  return popupVisible;
}

// ============================================================
// Main Render
// ============================================================

export type AgentPopupProps = {
  state: AppViewState;
  client: GatewayBrowserClient;
};

function monogram(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  const m = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return m.toUpperCase();
}

export function renderAgentPopup(props: AgentPopupProps) {
  const { state, client } = props;

  if (!popupVisible || !state.agentsManagementState) {
    return nothing;
  }

  const mgmt = state.agentsManagementState;
  const agent = popupAgentId ? mgmt.agents.find(a => a.id === popupAgentId) : null;

  if (popupAgentId && !agent) {
    // Agent not found, close popup
    hideAgentPopup();
    return nothing;
  }

  const close = () => {
    hideAgentPopup();
    state.requestUpdate?.();
  };

  return html`
    <div
      class="agm-modal-scrim agm-popup"
      @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) close(); }}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}
    >
      <div class="agm-modal gt-scope" role="dialog" aria-modal="true" aria-labelledby="agm-popup-title" data-learn-id="agents-config-popup">
        <!-- Header -->
        <div class="agm-modal-head">
          <div class="agm-modal-orb">${agent ? monogram(agent.name) : icons.sliders}</div>
          <div class="agm-modal-titles">
            <span class="gt-eyebrow">${agent ? "Quick config" : "Agent defaults"}</span>
            <h2 class="agm-modal-title" id="agm-popup-title">${agent ? agent.name : "Quick agent config"}</h2>
            <p class="agm-modal-sub">
              ${agent ? html`Configure <code>${agent.id}</code>` : "Pick an agent to tune its model, tools, skills and prompt."}
            </p>
          </div>
          <button
            type="button"
            class="agm-modal-close"
            aria-label="Close"
            data-learn-id="agents-config-close"
            @click=${close}
          >${icons.x}</button>
        </div>

        <!-- Agent Selector (if no specific agent) -->
        ${!agent ? renderAgentSelector(mgmt, state) : nothing}

        <!-- Tabs -->
        ${agent ? renderPopupTabs(agent, mgmt, state, client) : nothing}
      </div>
    </div>
  `;
}

// ============================================================
// Agent Selector
// ============================================================

function renderAgentSelector(mgmt: AgentsManagementState, state: AppViewState) {
  return html`
    <div class="agm-modal-body">
      <div class="agm-sub-h" style="margin-top:4px">Select agent · ${mgmt.agents.length}</div>
      ${mgmt.agents.length === 0
        ? glassEmpty({ icon: icons.bot, title: "No agents yet", sub: "Create an agent with New agent, then tune it here." })
        : html`
          <div class="agm-pick" data-learn-id="agents-config-list">
            ${mgmt.agents.map((agent, i) => html`
              <button
                type="button"
                class="agm-pick-item gt-rise"
                style="--gt-i:${Math.min(i, 12)}"
                data-learn-id="agents-config-agent"
                @click=${() => {
                  popupAgentId = agent.id;
                  popupActiveTab = "model";
                  state.requestUpdate?.();
                }}
              >
                <span class="agm-mono-av" aria-hidden="true">${monogram(agent.name)}</span>
                <span class="agm-check-stack">
                  <b>${agent.name}</b>
                  <span>${agent.id}${agent.type === "cli" ? " · CLI" : ""}</span>
                </span>
                ${agent.isDefault ? html`<span class="gt-chip" data-tone="gold">Default</span>` : nothing}
                <span class="agm-pick-arrow" aria-hidden="true">${icons.chevronRight}</span>
              </button>
            `)}
          </div>
        `}
    </div>
  `;
}

// ============================================================
// Popup Tabs
// ============================================================

function renderPopupTabs(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const tabs = [
    { id: "model", name: "Model", icon: icons.sliders },
    { id: "tools", name: "Tools", icon: icons.wrench },
    { id: "skills", name: "Skills", icon: icons.zap },
    { id: "subagents", name: "Sub-agents", icon: icons.bot },
    { id: "prompt", name: "Prompt", icon: icons.penLine },
  ];

  return html`
    <!-- Tab Bar -->
    <div class="agm-tabs" role="tablist" aria-label="Config sections">
      ${tabs.map(tab => {
        const isActive = popupActiveTab === tab.id;
        return html`
          <button
            type="button"
            role="tab"
            aria-selected=${isActive ? "true" : "false"}
            data-learn-id="agents-config-tab-${tab.id}"
            @click=${() => {
              popupActiveTab = tab.id;
              if (tab.id === "prompt" && !popupPromptDraft) {
                popupPromptDraft = agent.systemPrompt || "";
              }
              state.requestUpdate?.();
            }}
          >
            ${tab.icon}
            <span>${tab.name}</span>
          </button>
        `;
      })}
    </div>

    <!-- Tab Content -->
    <div class="agm-modal-body" role="tabpanel">
      ${popupActiveTab === "model" ? renderModelTab(agent, mgmt, state, client) : nothing}
      ${popupActiveTab === "tools" ? renderQuickToolsTab(agent, mgmt, state, client) : nothing}
      ${popupActiveTab === "skills" ? renderQuickSkillsTab(agent, mgmt, state, client) : nothing}
      ${popupActiveTab === "subagents" ? renderQuickSubagentsTab(agent, mgmt, state, client) : nothing}
      ${popupActiveTab === "prompt" ? renderQuickPromptTab(agent, mgmt, state, client) : nothing}
    </div>
  `;
}

// ============================================================
// Quick Tab Renderers
// ============================================================

function renderModelTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const availableModels = mgmt.availableModels;
  const providers = Object.keys(availableModels);
  const currentModel = agent.model === "default" ? "" : agent.model;

  return html`
    <div class="agm-ed">
      <label class="agm-field">
        <span class="agm-label">Model</span>
        <select
          class="agm-select agm-select--lg"
          .value=${currentModel}
          @change=${async (e: Event) => {
            const selectedValue = (e.target as HTMLSelectElement).value;
            await updateAgentModel(state, client, agent.id, selectedValue);
          }}
        >
          <option value="">Default (inherit from global config)</option>
          ${providers.map(provider => {
            const models = availableModels[provider] || [];
            if (models.length === 0) return nothing;

            return html`
              <optgroup label="${provider.charAt(0).toUpperCase() + provider.slice(1)}">
                ${models.map(model => {
                  const fullModel = `${provider}/${model}`;
                  return html`
                    <option value=${fullModel} ?selected=${fullModel === currentModel}>
                      ${model}
                    </option>
                  `;
                })}
              </optgroup>
            `;
          })}
        </select>
        <span class="agm-help">Current: <span class="agm-mono" style="color:var(--agm-gold-ink)">${agent.model}</span></span>
      </label>
    </div>
  `;
}

function toolToggle(label: string, isSelected: boolean, onClick: () => void) {
  return html`
    <button type="button" class="agm-check" aria-pressed=${isSelected ? "true" : "false"} @click=${onClick}>
      <span class="agm-check-box" aria-hidden="true">${isSelected ? icons.check : nothing}</span>
      <span class="agm-check-label" title=${label}>${label}</span>
    </button>
  `;
}

function renderQuickToolsTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const selectedTools = new Set(agent.tools);

  // Common tools for quick access
  const commonTools = ["exec", "read", "write", "browser", "web_search"];
  const otherTools = mgmt.availableTools.filter(t => !commonTools.includes(t));
  const toggle = (tool: string) => () => {
    const newTools = new Set(selectedTools);
    if (selectedTools.has(tool)) {
      newTools.delete(tool);
    } else {
      newTools.add(tool);
    }
    updateAgentTools(state, client, agent.id, Array.from(newTools));
  };

  return html`
    <div class="agm-ed">
      <div class="agm-sub-h" style="margin-top:0">Common</div>
      <div class="agm-check-grid">
        ${commonTools.map(tool => toolToggle(tool, selectedTools.has(tool), toggle(tool)))}
      </div>

      <div class="agm-sub-h">Other · ${otherTools.length}</div>
      <div class="agm-check-grid">
        ${otherTools.map(tool => toolToggle(tool, selectedTools.has(tool), toggle(tool)))}
      </div>

      <div class="agm-ed-foot">
        <span>Selected: ${selectedTools.size} tools</span>
        ${selectedTools.size === 0 ? html`<span class="is-open">All allowed</span>` : nothing}
      </div>
    </div>
  `;
}

function renderQuickSkillsTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const selectedSkills = new Set(agent.skills);
  const availableSkills = mgmt.availableSkills;

  return html`
    <div class="agm-ed">
      ${availableSkills.length === 0
        ? glassEmpty({ icon: icons.zap, title: "No skills available", sub: "Skills appear here once the gateway has loaded them." })
        : html`
          <div class="agm-check-grid agm-check-grid--wide">
            ${availableSkills.map(skill => toolToggle(skill, selectedSkills.has(skill), () => {
              const newSkills = new Set(selectedSkills);
              if (selectedSkills.has(skill)) {
                newSkills.delete(skill);
              } else {
                newSkills.add(skill);
              }
              updateAgentSkills(state, client, agent.id, Array.from(newSkills));
            }))}
          </div>
        `}

      <div class="agm-ed-foot">
        <span>Selected: ${selectedSkills.size} skills</span>
        ${selectedSkills.size === 0 ? html`<span class="is-open">All allowed</span>` : nothing}
      </div>
    </div>
  `;
}

function renderQuickSubagentsTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const selectedSubagents = new Set(agent.subagents);
  const availableAgents = mgmt.agents.filter(a => a.id !== agent.id);

  return html`
    <div class="agm-ed">
      ${availableAgents.length === 0
        ? glassEmpty({ icon: icons.bot, title: "No other agents yet", sub: "Create more agents and they show up here as delegation targets." })
        : html`
          <div class="agm-check-grid agm-check-grid--wide">
            ${availableAgents.map(otherAgent => {
              const on = selectedSubagents.has(otherAgent.id);
              return html`
                <button
                  type="button"
                  class="agm-check"
                  aria-pressed=${on ? "true" : "false"}
                  @click=${() => {
                    const newSubagents = new Set(selectedSubagents);
                    if (selectedSubagents.has(otherAgent.id)) {
                      newSubagents.delete(otherAgent.id);
                    } else {
                      newSubagents.add(otherAgent.id);
                    }
                    updateAgentSubagents(state, client, agent.id, Array.from(newSubagents));
                  }}
                >
                  <span class="agm-check-box" aria-hidden="true">${on ? icons.check : nothing}</span>
                  <span class="agm-check-stack"><b>${otherAgent.name}</b><span>${otherAgent.id}</span></span>
                </button>
              `;
            })}
          </div>
        `}

      <div class="agm-ed-foot">
        <span>Selected: ${selectedSubagents.size} agents</span>
        ${selectedSubagents.size === 0 ? html`<span class="is-open">All allowed</span>` : nothing}
      </div>
    </div>
  `;
}

function renderQuickPromptTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const hasCustomPrompt = !!agent.systemPrompt;

  if (!popupPromptDraft && hasCustomPrompt) {
    popupPromptDraft = agent.systemPrompt;
  }

  const isDirty = popupPromptDraft !== (agent.systemPrompt || "");

  return html`
    <div class="agm-ed">
      <div class="agm-ed-head">
        <h3 class="agm-ed-title">
          <span class="agm-ico">${icons.penLine}</span>System prompt
          ${hasCustomPrompt
            ? html`<span class="gt-chip" data-tone="gold">Custom</span>`
            : html`<span class="gt-chip">Default</span>`}
        </h3>
        ${isDirty ? html`<span class="agm-dirty agm-ed-meta">Unsaved</span>` : nothing}
      </div>

      <textarea
        class="agm-code agm-code--sm ${isDirty ? "is-dirty" : ""}"
        aria-label="System prompt for ${agent.name}"
        spellcheck="false"
        .value=${popupPromptDraft}
        placeholder="Enter custom system prompt or leave empty for default..."
        @input=${(e: Event) => {
          popupPromptDraft = (e.target as HTMLTextAreaElement).value;
          state.requestUpdate?.();
        }}
      ></textarea>

      <div class="agm-code-bar">
        <span>${popupPromptDraft.length} characters</span>
        <div class="agm-actions">
          ${hasCustomPrompt ? html`
            <button
              type="button"
              class="gt-btn gt-danger agm-xs"
              @click=${async () => {
                if (confirm("Clear custom prompt and use default?")) {
                  popupPromptDraft = "";
                  await updateAgentSystemPrompt(state, client, agent.id, "");
                }
              }}
            >
              Clear
            </button>
          ` : nothing}
          <button
            type="button"
            class="gt-btn gt-primary agm-xs"
            ?disabled=${!isDirty}
            @click=${async () => {
              await updateAgentSystemPrompt(state, client, agent.id, popupPromptDraft);
            }}
          >
            ${isDirty ? html`${icons.save} Save` : html`${icons.check} Saved`}
          </button>
        </div>
      </div>
    </div>
  `;
}
