/**
 * Agent Selector — Dropdown for selecting agents across gateways
 * 
 * Features:
 * - Groups agents by gateway
 * - Shows agent status
 * - Quick agent switching
 * - Visual gateway indicators
 */

import { html, nothing } from "lit";
import type { AgentProfile, GatewayConnection } from "../controllers/gateway-registry";
import {
  getRegistryState,
  getAgentsByGateway,
  getAllAgents,
} from "../controllers/gateway-registry";

// ── Types ─────────────────────────────────────────────────

export interface AgentSelectorOptions {
  selectedAgentId: string;
  selectedGatewayId?: string;
  onSelect: (agent: AgentProfile) => void;
  groupByGateway?: boolean;
  showStatus?: boolean;
  compact?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

// ── State ─────────────────────────────────────────────────

let dropdownOpen = false;
let searchQuery = "";

function toggleDropdown() {
  dropdownOpen = !dropdownOpen;
  if (!dropdownOpen) searchQuery = "";
}

function closeDropdown() {
  dropdownOpen = false;
  searchQuery = "";
}

// ── Helpers ───────────────────────────────────────────────

function getAgentIcon(agent: AgentProfile): string {
  const id = agent.id.toLowerCase();
  if (id === "main") return "👤";
  if (id.includes("code") || id.includes("dev")) return "💻";
  if (id.includes("qa") || id.includes("test")) return "🔍";
  if (id.includes("web")) return "🌐";
  if (id.includes("research")) return "📊";
  if (id.includes("voice")) return "🎤";
  return "🤖";
}

function getStatusColor(status: string): string {
  switch (status) {
    case "available": return "#22c55e";
    case "busy": return "#f59e0b";
    case "offline": return "#ef4444";
    default: return "#71717a";
  }
}

function getGatewayIcon(gateway: GatewayConnection): string {
  if (gateway.isLocal) return "🏠";
  return "🌐";
}

function filterAgents(agents: AgentProfile[], query: string): AgentProfile[] {
  if (!query) return agents;
  const q = query.toLowerCase();
  return agents.filter(a => 
    a.name.toLowerCase().includes(q) ||
    a.id.toLowerCase().includes(q) ||
    a.gatewayName.toLowerCase().includes(q)
  );
}

// ── Render Functions ──────────────────────────────────────

function renderAgentOption(
  agent: AgentProfile,
  isSelected: boolean,
  onSelect: (agent: AgentProfile) => void,
  showStatus: boolean,
  compact: boolean
) {
  return html`
    <div 
      class="agent-option ${isSelected ? 'selected' : ''} ${compact ? 'compact' : ''}"
      @click=${(e: Event) => {
        e.stopPropagation();
        onSelect(agent);
        closeDropdown();
      }}
    >
      <span class="agent-icon">${getAgentIcon(agent)}</span>
      <div class="agent-info">
        <span class="agent-name">${agent.name}</span>
        ${!compact ? html`
          <span class="agent-id">${agent.id}</span>
        ` : nothing}
      </div>
      ${showStatus ? html`
        <span 
          class="agent-status"
          style="background: ${getStatusColor(agent.status)}"
          title="${agent.status}"
        ></span>
      ` : nothing}
      ${isSelected ? html`<span class="check-icon">✓</span>` : nothing}
    </div>
  `;
}

function renderGatewayGroup(
  gateway: GatewayConnection,
  agents: AgentProfile[],
  selectedAgentId: string,
  onSelect: (agent: AgentProfile) => void,
  showStatus: boolean,
  compact: boolean
) {
  return html`
    <div class="gateway-group">
      <div class="gateway-header">
        <span class="gateway-icon">${getGatewayIcon(gateway)}</span>
        <span class="gateway-name">${gateway.name}</span>
        ${gateway.isLocal ? html`
          <span class="local-badge">local</span>
        ` : html`
          <span class="remote-badge">${gateway.status}</span>
        `}
      </div>
      <div class="gateway-agents">
        ${agents.map(agent => renderAgentOption(
          agent,
          agent.id === selectedAgentId && agent.gatewayId === gateway.id,
          onSelect,
          showStatus,
          compact
        ))}
      </div>
    </div>
  `;
}

// ── Main Component ────────────────────────────────────────

export function renderAgentSelector(options: AgentSelectorOptions) {
  const {
    selectedAgentId,
    selectedGatewayId,
    onSelect,
    groupByGateway = true,
    showStatus = true,
    compact = false,
    disabled = false,
    placeholder = "Select Agent",
  } = options;
  
  const state = getRegistryState();
  const allAgents = getAllAgents();
  const agentsByGateway = getAgentsByGateway();
  
  // Find selected agent
  const selectedAgent = allAgents.find(a => 
    a.id === selectedAgentId && 
    (!selectedGatewayId || a.gatewayId === selectedGatewayId)
  );
  
  // Filter agents by search
  const filteredAgents = filterAgents(allAgents, searchQuery);
  
  return html`
    <div class="agent-selector ${compact ? 'compact' : ''} ${disabled ? 'disabled' : ''}">
      <!-- Trigger Button -->
      <button 
        class="selector-trigger"
        @click=${() => !disabled && toggleDropdown()}
        ?disabled=${disabled}
      >
        ${selectedAgent ? html`
          <span class="selected-agent">
            <span class="agent-icon">${getAgentIcon(selectedAgent)}</span>
            <span class="agent-name">${selectedAgent.name}</span>
            ${!compact ? html`
              <span class="gateway-indicator">${selectedAgent.gatewayName}</span>
            ` : nothing}
          </span>
        ` : html`
          <span class="placeholder">${placeholder}</span>
        `}
        <span class="dropdown-arrow">${dropdownOpen ? '▲' : '▼'}</span>
      </button>
      
      <!-- Dropdown Panel -->
      ${dropdownOpen ? html`
        <div class="selector-dropdown" @click=${(e: Event) => e.stopPropagation()}>
          <!-- Search -->
          <div class="search-box">
            <input 
              type="text"
              placeholder="Search agents..."
              .value=${searchQuery}
              @input=${(e: Event) => {
                searchQuery = (e.target as HTMLInputElement).value;
              }}
              @click=${(e: Event) => e.stopPropagation()}
            />
          </div>
          
          <!-- Agent List -->
          <div class="agents-list">
            ${filteredAgents.length === 0 ? html`
              <div class="no-agents">No agents found</div>
            ` : groupByGateway ? html`
              ${Array.from(agentsByGateway.entries()).map(([gatewayId, agents]) => {
                const gateway = state.gateways.find(g => g.id === gatewayId);
                if (!gateway) return nothing;
                const filtered = agents.filter(a => filteredAgents.includes(a));
                if (filtered.length === 0) return nothing;
                return renderGatewayGroup(
                  gateway,
                  filtered,
                  selectedAgentId,
                  onSelect,
                  showStatus,
                  compact
                );
              })}
            ` : html`
              ${filteredAgents.map(agent => renderAgentOption(
                agent,
                agent.id === selectedAgentId,
                onSelect,
                showStatus,
                compact
              ))}
            `}
          </div>
          
          <!-- Footer -->
          ${!compact ? html`
            <div class="dropdown-footer">
              <span class="agent-count">${allAgents.length} agents</span>
              <span class="gateway-count">${state.gateways.filter(g => g.status === "connected").length} gateways</span>
            </div>
          ` : nothing}
        </div>
        
        <!-- Backdrop to close -->
        <div class="dropdown-backdrop" @click=${closeDropdown}></div>
      ` : nothing}
    </div>
    
    <style>
      .agent-selector {
        position: relative;
        display: inline-block;
        font-family: system-ui, -apple-system, sans-serif;
      }
      
      .agent-selector.disabled {
        opacity: 0.5;
        pointer-events: none;
      }
      
      .agent-selector.compact .selector-trigger {
        padding: 6px 10px;
        font-size: 12px;
      }
      
      .selector-trigger {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        background: rgba(15, 15, 15, 0.8);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 10px;
        color: #e4e4e7;
        font-size: 14px;
        cursor: pointer;
        transition: all 0.2s ease;
        min-width: 160px;
      }
      
      .selector-trigger:hover {
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
      }
      
      .selected-agent {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
      }
      
      .selected-agent .agent-icon {
        font-size: 16px;
      }
      
      .selected-agent .agent-name {
        font-weight: 600;
        color: var(--g-primary);
      }
      
      .gateway-indicator {
        font-size: 11px;
        color: #71717a;
        padding: 2px 6px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
      }
      
      .placeholder {
        color: #71717a;
      }
      
      .dropdown-arrow {
        font-size: 10px;
        color: #71717a;
      }
      
      .selector-dropdown {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: 0;
        min-width: 280px;
        background: #0f0f0f;
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        z-index: 1000;
        overflow: hidden;
      }
      
      .search-box {
        padding: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }
      
      .search-box input {
        width: 100%;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        color: #e4e4e7;
        font-size: 13px;
        outline: none;
      }
      
      .search-box input:focus {
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      
      .search-box input::placeholder {
        color: #52525b;
      }
      
      .agents-list {
        max-height: 320px;
        overflow-y: auto;
      }
      
      .no-agents {
        padding: 20px;
        text-align: center;
        color: #71717a;
        font-size: 13px;
      }
      
      .gateway-group {
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }
      
      .gateway-group:last-child {
        border-bottom: none;
      }
      
      .gateway-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: rgba(255, 255, 255, 0.02);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #71717a;
      }
      
      .gateway-icon {
        font-size: 12px;
      }
      
      .gateway-name {
        flex: 1;
        font-weight: 600;
      }
      
      .local-badge {
        padding: 2px 6px;
        background: rgba(34, 197, 94, 0.1);
        border-radius: 4px;
        font-size: 9px;
        color: #22c55e;
      }
      
      .remote-badge {
        padding: 2px 6px;
        background: rgba(139, 92, 246, 0.1);
        border-radius: 4px;
        font-size: 9px;
        color: #a78bfa;
      }
      
      .gateway-agents {
        padding: 4px 0;
      }
      
      .agent-option {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 14px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      
      .agent-option:hover {
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
      }
      
      .agent-option.selected {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      }
      
      .agent-option.compact {
        padding: 8px 12px;
      }
      
      .agent-option .agent-icon {
        font-size: 18px;
        width: 24px;
        text-align: center;
      }
      
      .agent-option .agent-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      
      .agent-option .agent-name {
        font-size: 14px;
        font-weight: 600;
        color: #e4e4e7;
      }
      
      .agent-option .agent-id {
        font-size: 11px;
        color: #71717a;
      }
      
      .agent-option.selected .agent-name {
        color: var(--g-primary);
      }
      
      .agent-status {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      
      .check-icon {
        font-size: 14px;
        color: var(--g-primary);
      }
      
      .dropdown-footer {
        display: flex;
        justify-content: space-between;
        padding: 10px 14px;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        font-size: 11px;
        color: #52525b;
      }
      
      .dropdown-backdrop {
        position: fixed;
        inset: 0;
        z-index: 999;
      }
      
      /* Scrollbar */
      .agents-list::-webkit-scrollbar {
        width: 6px;
      }
      
      .agents-list::-webkit-scrollbar-track {
        background: transparent;
      }
      
      .agents-list::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 3px;
      }
    </style>
  `;
}

// ── Inline Agent Badge (for headers) ──────────────────────

export function renderAgentBadge(agent: AgentProfile | undefined, compact = false) {
  if (!agent) return html`<span class="agent-badge empty">No Agent</span>`;
  
  return html`
    <span class="agent-badge ${compact ? 'compact' : ''}">
      <span class="badge-icon">${getAgentIcon(agent)}</span>
      <span class="badge-name">${agent.name}</span>
      ${!compact ? html`
        <span class="badge-gateway">${agent.gatewayName}</span>
      ` : nothing}
    </span>
    
    <style>
      .agent-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 8px;
        font-size: 13px;
      }
      
      .agent-badge.compact {
        padding: 2px 8px;
        font-size: 11px;
      }
      
      .agent-badge.empty {
        background: rgba(255, 255, 255, 0.05);
        border-color: rgba(255, 255, 255, 0.1);
        color: #71717a;
      }
      
      .badge-icon {
        font-size: 14px;
      }
      
      .badge-name {
        font-weight: 600;
        color: var(--g-primary);
      }
      
      .badge-gateway {
        font-size: 10px;
        color: #71717a;
        padding: 1px 5px;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 4px;
      }
    </style>
  `;
}

export default {
  renderAgentSelector,
  renderAgentBadge,
};
