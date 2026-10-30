/**
 * Node Selector Component
 * 
 * Dropdown component for selecting the active node in chat.
 * Shows connection status, current node, and allows switching context.
 */

import { html, nothing, css, LitElement } from "lit";
import type { FederationNode } from "../controllers/federation";

// ── Types ─────────────────────────────────────────────────

export interface NodeSelectorProps {
  nodes: FederationNode[];
  currentNodeId: string | null;
  localNodeId: string | null;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onNodeSelect: (nodeId: string) => void;
  onRefresh?: () => void;
}

// ── Functional Render (for integration) ───────────────────

export function renderNodeSelector(props: NodeSelectorProps) {
  const { nodes, currentNodeId, localNodeId, loading, disabled, compact, onNodeSelect, onRefresh } = props;
  
  if (nodes.length === 0 && !loading) {
    // No nodes - don't show selector
    return nothing;
  }

  const currentNode = nodes.find(n => n.id === currentNodeId);
  const sortedNodes = [...nodes].sort((a, b) => {
    // Local node first, then master, then alphabetically
    if (a.isLocal || a.id === localNodeId) return -1;
    if (b.isLocal || b.id === localNodeId) return 1;
    if (a.role === "master" && b.role !== "master") return -1;
    if (b.role === "master" && a.role !== "master") return 1;
    return a.name.localeCompare(b.name);
  });

  return html`
    <div class="node-selector ${compact ? 'compact' : ''}">
      <div class="node-selector-trigger" tabindex="0">
        <div class="node-status ${currentNode?.status || 'offline'}"></div>
        <span class="node-label">
          ${loading ? 'Loading...' : currentNode?.name || 'Select Node'}
        </span>
        <span class="dropdown-arrow">▾</span>
      </div>
      
      <div class="node-dropdown">
        <div class="dropdown-header">
          <span>Select Node</span>
          ${onRefresh ? html`
            <button class="refresh-btn" @click=${(e: Event) => { e.stopPropagation(); onRefresh(); }}>
              ↻
            </button>
          ` : nothing}
        </div>
        
        <div class="dropdown-list">
          ${sortedNodes.map(node => html`
            <div 
              class="node-option ${node.id === currentNodeId ? 'active' : ''} ${node.status}"
              @click=${() => !disabled && onNodeSelect(node.id)}
              title="${formatNodeTooltip(node, localNodeId)}"
            >
              <div class="node-status ${node.status}"></div>
              <div class="node-option-info">
                <div class="node-option-name">
                  ${node.name}
                  ${node.isLocal || node.id === localNodeId ? html`<span class="local-badge">LOCAL</span>` : nothing}
                  ${node.role === 'master' ? html`<span class="master-badge">👑</span>` : nothing}
                </div>
                <div class="node-option-meta">
                  ${formatNodeMeta(node)}
                </div>
              </div>
              ${node.id === currentNodeId ? html`<span class="check">✓</span>` : nothing}
            </div>
          `)}
        </div>
      </div>
    </div>

    <style>
      .node-selector {
        position: relative;
        display: inline-block;
      }

      .node-selector-trigger {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s ease;
        user-select: none;
      }

      .node-selector-trigger:hover {
        background: rgba(255, 255, 255, 0.08);
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
      }

      .node-selector-trigger:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
      }

      .node-selector.compact .node-selector-trigger {
        padding: 6px 10px;
        font-size: 12px;
      }

      .node-status {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .node-status.online {
        background: #22c55e;
        box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
      }

      .node-status.offline {
        background: #71717a;
      }

      .node-status.connecting {
        background: var(--g-primary);
        animation: pulse 1.5s infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .node-label {
        font-size: 13px;
        font-weight: 500;
        color: #e4e4e7;
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .node-selector.compact .node-label {
        max-width: 100px;
        font-size: 12px;
      }

      .dropdown-arrow {
        font-size: 10px;
        color: #71717a;
        transition: transform 0.2s ease;
      }

      .node-dropdown {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        min-width: 260px;
        background: #1a1a1d;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        opacity: 0;
        visibility: hidden;
        transform: translateY(-8px);
        transition: all 0.2s ease;
        z-index: 1000;
        overflow: hidden;
      }

      .node-selector:focus-within .node-dropdown,
      .node-selector:hover .node-dropdown {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }

      .node-selector:focus-within .dropdown-arrow {
        transform: rotate(180deg);
      }

      .dropdown-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        font-size: 11px;
        font-weight: 600;
        color: #71717a;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .refresh-btn {
        background: none;
        border: none;
        color: #71717a;
        cursor: pointer;
        padding: 4px 8px;
        font-size: 14px;
        border-radius: 4px;
        transition: all 0.2s ease;
      }

      .refresh-btn:hover {
        color: var(--g-primary);
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      }

      .dropdown-list {
        max-height: 300px;
        overflow-y: auto;
        padding: 6px;
      }

      .node-option {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .node-option:hover {
        background: rgba(255, 255, 255, 0.05);
      }

      .node-option.active {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      }

      .node-option.offline {
        opacity: 0.5;
      }

      .node-option-info {
        flex: 1;
        min-width: 0;
      }

      .node-option-name {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        font-weight: 500;
        color: #e4e4e7;
      }

      .local-badge {
        padding: 2px 6px;
        background: rgba(59, 130, 246, 0.15);
        border-radius: 4px;
        font-size: 9px;
        font-weight: 600;
        color: #60a5fa;
      }

      .master-badge {
        font-size: 12px;
      }

      .node-option-meta {
        font-size: 11px;
        color: #71717a;
        margin-top: 2px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .check {
        color: var(--g-primary);
        font-size: 14px;
        font-weight: 600;
      }

      /* Scrollbar */
      .dropdown-list::-webkit-scrollbar {
        width: 6px;
      }

      .dropdown-list::-webkit-scrollbar-track {
        background: transparent;
      }

      .dropdown-list::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
      }

      .dropdown-list::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.25);
      }
    </style>
  `;
}

// ── Lit Component (alternative) ───────────────────────────
// Note: This is an optional web component version. The functional
// renderNodeSelector above works without requiring custom element registration.

export class NodeSelectorElement extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
    }

    .trigger {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
    }

    .trigger:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
    }

    :host([compact]) .trigger {
      padding: 6px 10px;
      font-size: 12px;
    }

    .status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .status.online {
      background: #22c55e;
      box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
    }

    .status.offline {
      background: #71717a;
    }

    .status.connecting {
      background: var(--g-primary);
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .label {
      font-size: 13px;
      font-weight: 500;
      color: #e4e4e7;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .arrow {
      font-size: 10px;
      color: #71717a;
      transition: transform 0.2s ease;
    }

    .arrow.open {
      transform: rotate(180deg);
    }

    .dropdown {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      min-width: 260px;
      background: #1a1a1d;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      z-index: 1000;
      overflow: hidden;
    }

    .dropdown-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 11px;
      font-weight: 600;
      color: #71717a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .dropdown-list {
      max-height: 300px;
      overflow-y: auto;
      padding: 6px;
    }

    .option {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .option:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .option.active {
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    }

    .option.offline {
      opacity: 0.5;
    }

    .option-info {
      flex: 1;
      min-width: 0;
    }

    .option-name {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      color: #e4e4e7;
    }

    .badge {
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 9px;
      font-weight: 600;
    }

    .badge.local {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }

    .option-meta {
      font-size: 11px;
      color: #71717a;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .check {
      color: var(--g-primary);
      font-size: 14px;
      font-weight: 600;
    }
  `;

  // Properties - using standard class fields
  nodes: FederationNode[] = [];
  currentNodeId: string | null = null;
  localNodeId: string | null = null;
  loading = false;
  disabled = false;
  compact = false;

  private _open = false;

  private get currentNode(): FederationNode | undefined {
    return this.nodes.find(n => n.id === this.currentNodeId);
  }

  private get sortedNodes(): FederationNode[] {
    return [...this.nodes].sort((a, b) => {
      if (a.isLocal || a.id === this.localNodeId) return -1;
      if (b.isLocal || b.id === this.localNodeId) return 1;
      if (a.role === "master" && b.role !== "master") return -1;
      if (b.role === "master" && a.role !== "master") return 1;
      return a.name.localeCompare(b.name);
    });
  }

  private _handleSelect(nodeId: string) {
    if (this.disabled) return;
    this._open = false;
    this.dispatchEvent(new CustomEvent("node-select", { 
      detail: { nodeId },
      bubbles: true,
      composed: true,
    }));
    this.requestUpdate();
  }

  private _handleRefresh() {
    this.dispatchEvent(new CustomEvent("refresh", {
      bubbles: true,
      composed: true,
    }));
  }

  override render() {
    if (this.nodes.length <= 1 && !this.loading) {
      return nothing;
    }

    return html`
      <div style="position: relative;">
        <div 
          class="trigger" 
          @click=${() => { this._open = !this._open; this.requestUpdate(); }}
        >
          <div class="status ${this.currentNode?.status || 'offline'}"></div>
          <span class="label">
            ${this.loading ? 'Loading...' : this.currentNode?.name || 'Select Node'}
          </span>
          <span class="arrow ${this._open ? 'open' : ''}">▾</span>
        </div>

        ${this._open ? html`
          <div class="dropdown">
            <div class="dropdown-header">
              <span>Select Node</span>
              <button 
                style="background: none; border: none; color: #71717a; cursor: pointer; padding: 4px 8px; font-size: 14px;"
                @click=${(e: Event) => { e.stopPropagation(); this._handleRefresh(); }}
              >
                ↻
              </button>
            </div>
            <div class="dropdown-list">
              ${this.sortedNodes.map(node => html`
                <div 
                  class="option ${node.id === this.currentNodeId ? 'active' : ''} ${node.status}"
                  @click=${() => this._handleSelect(node.id)}
                >
                  <div class="status ${node.status}"></div>
                  <div class="option-info">
                    <div class="option-name">
                      ${node.name}
                      ${node.isLocal || node.id === this.localNodeId 
                        ? html`<span class="badge local">LOCAL</span>` 
                        : nothing}
                      ${node.role === 'master' ? html`<span>👑</span>` : nothing}
                    </div>
                    <div class="option-meta">${formatNodeMeta(node)}</div>
                  </div>
                  ${node.id === this.currentNodeId ? html`<span class="check">✓</span>` : nothing}
                </div>
              `)}
            </div>
          </div>
        ` : nothing}
      </div>
    `;
  }

  override connectedCallback() {
    super.connectedCallback();
    // Close dropdown when clicking outside
    document.addEventListener("click", this._handleOutsideClick);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("click", this._handleOutsideClick);
  }

  private _handleOutsideClick = (e: Event) => {
    if (this._open && !this.contains(e.target as Node)) {
      this._open = false;
      this.requestUpdate();
    }
  };
}

// Register custom element if not already registered
if (typeof customElements !== 'undefined' && !customElements.get('node-selector')) {
  customElements.define('node-selector', NodeSelectorElement);
}

// ── Helpers ───────────────────────────────────────────────

function formatNodeMeta(node: FederationNode): string {
  const parts: string[] = [];
  
  if (node.remoteIp) parts.push(node.remoteIp);
  if (node.capabilities.gpu) parts.push(node.capabilities.gpu);
  else if (node.capabilities.ram) parts.push(`${node.capabilities.ram}GB RAM`);
  if (node.latency) parts.push(`${node.latency}ms`);
  
  return parts.join(" · ") || node.id;
}

function formatNodeTooltip(node: FederationNode, localNodeId: string | null): string {
  const lines: string[] = [node.name];
  
  if (node.isLocal || node.id === localNodeId) lines.push("(This node)");
  lines.push(`Status: ${node.status}`);
  lines.push(`Role: ${node.role}`);
  if (node.remoteIp) lines.push(`IP: ${node.remoteIp}`);
  if (node.capabilities.gpu) lines.push(`GPU: ${node.capabilities.gpu}`);
  if (node.capabilities.ram) lines.push(`RAM: ${node.capabilities.ram}GB`);
  if (node.capabilities.hasOllama) lines.push("✓ Ollama");
  if (node.capabilities.hasVoice) lines.push("✓ Voice");
  if (node.capabilities.hasComfyUI) lines.push("✓ ComfyUI");
  
  return lines.join("\n");
}

declare global {
  interface HTMLElementTagNameMap {
    "node-selector": NodeSelectorElement;
  }
}
