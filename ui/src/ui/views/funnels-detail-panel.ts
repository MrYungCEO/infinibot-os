/**
 * Funnels Detail Panel View
 * Right panel: stage settings, KPI charts, SOP checklist, automations
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons";
import { STAGE_TYPE_CONFIG, type FunnelStage, type StageKPI, type SOPItem, type FunnelStageType } from "./funnels-canvas";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface FunnelDetailPanelProps {
  stage: FunnelStage | null;
  loading: boolean;
  collapsed: boolean;
  activeTab: "settings" | "kpis" | "sop" | "automations";
  onUpdateStage: (stageId: string, patch: Partial<FunnelStage>) => void;
  onAddKPI: (stageId: string, kpi: Omit<StageKPI, "id">) => void;
  onUpdateKPI: (stageId: string, kpiId: string, patch: Partial<StageKPI>) => void;
  onDeleteKPI: (stageId: string, kpiId: string) => void;
  onAddSOPItem: (stageId: string, label: string) => void;
  onToggleSOPItem: (stageId: string, itemId: string) => void;
  onDeleteSOPItem: (stageId: string, itemId: string) => void;
  onClose: () => void;
  onToggleCollapsed: () => void;
  onTabChange: (tab: "settings" | "kpis" | "sop" | "automations") => void;
  requestUpdate: () => void;
}

// ══════════════════════════════════════════════════════════════════════════════
// Module State
// ══════════════════════════════════════════════════════════════════════════════

let _editingName = false;
let _editingDescription = false;
let _tempName = "";
let _tempDescription = "";
let _newKPIForm = { label: "", value: "", unit: "$", target: "" };
let _showAddKPI = false;
let _newSOPItem = "";
let _showAddSOP = false;

// ══════════════════════════════════════════════════════════════════════════════
// Main Render
// ══════════════════════════════════════════════════════════════════════════════

export function renderFunnelDetailPanel(props: FunnelDetailPanelProps): TemplateResult {
  const { stage, loading, collapsed, onToggleCollapsed, onClose } = props;

  if (collapsed) {
    return renderCollapsedPanel(props);
  }

  if (!stage) {
    return html`
      <style>
        ${detailPanelStyles}
      </style>
      <div class="funnel-detail-panel funnel-detail-panel--empty">
        <div class="funnel-detail-panel__empty-state">
          <span class="funnel-detail-panel__empty-icon">🎯</span>
          <h3>No Stage Selected</h3>
          <p>Select a stage from the canvas to view and edit its details</p>
        </div>
      </div>
    `;
  }

  const config = STAGE_TYPE_CONFIG[stage.type];

  return html`
    <style>
      ${detailPanelStyles}
    </style>
    <div class="funnel-detail-panel">
      <!-- Header -->
      <div class="funnel-detail-panel__header" style="--stage-color: ${config.color}">
        <div class="funnel-detail-panel__header-top">
          <button class="funnel-detail-panel__collapse-btn" @click=${onToggleCollapsed}>
            ${icons.chevronRight}
          </button>
          <div class="funnel-detail-panel__stage-type">
            <span>${config.icon}</span>
            <span style="color: ${config.color}">${config.label}</span>
          </div>
          <button class="funnel-detail-panel__close-btn" @click=${onClose}>
            ${icons.x}
          </button>
        </div>
        ${renderStageHeader(stage, props)}
      </div>

      <!-- Tabs -->
      ${renderTabs(props)}

      <!-- Tab Content -->
      <div class="funnel-detail-panel__content">
        ${renderTabContent(stage, props)}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Collapsed Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderCollapsedPanel(props: FunnelDetailPanelProps): TemplateResult {
  const { stage, onToggleCollapsed } = props;

  return html`
    <style>
      ${detailPanelStyles}
    </style>
    <div class="funnel-detail-panel funnel-detail-panel--collapsed">
      <button class="funnel-detail-panel__expand-btn" @click=${onToggleCollapsed}>
        ${stage ? STAGE_TYPE_CONFIG[stage.type].icon : "📋"}
      </button>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stage Header
// ══════════════════════════════════════════════════════════════════════════════

function renderStageHeader(stage: FunnelStage, props: FunnelDetailPanelProps): TemplateResult {
  const { onUpdateStage, requestUpdate } = props;

  const handleNameSave = () => {
    if (_tempName.trim() && _tempName !== stage.name) {
      onUpdateStage(stage.id, { name: _tempName.trim() });
    }
    _editingName = false;
    requestUpdate();
  };

  const handleDescSave = () => {
    if (_tempDescription !== stage.description) {
      onUpdateStage(stage.id, { description: _tempDescription });
    }
    _editingDescription = false;
    requestUpdate();
  };

  return html`
    <div class="funnel-detail-panel__stage-info">
      ${_editingName ? html`
        <input class="funnel-detail-panel__name-input"
          type="text"
          .value=${_tempName}
          @input=${(e: Event) => { _tempName = (e.target as HTMLInputElement).value; requestUpdate(); }}
          @blur=${handleNameSave}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") handleNameSave(); if (e.key === "Escape") { _editingName = false; requestUpdate(); } }}
          autofocus
        />
      ` : html`
        <h2 class="funnel-detail-panel__name" @click=${() => { _editingName = true; _tempName = stage.name; requestUpdate(); }}>
          ${stage.name}
          <span class="funnel-detail-panel__edit-hint">${icons.edit}</span>
        </h2>
      `}

      ${_editingDescription ? html`
        <textarea class="funnel-detail-panel__desc-input"
          .value=${_tempDescription}
          @input=${(e: Event) => { _tempDescription = (e.target as HTMLTextAreaElement).value; requestUpdate(); }}
          @blur=${handleDescSave}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") { _editingDescription = false; requestUpdate(); } }}
          rows="2"
          placeholder="Add a description..."
        ></textarea>
      ` : html`
        <p class="funnel-detail-panel__description" @click=${() => { _editingDescription = true; _tempDescription = stage.description || ""; requestUpdate(); }}>
          ${stage.description || "Click to add description..."}
        </p>
      `}

      <!-- Health Status -->
      <div class="funnel-detail-panel__health">
        <span class="funnel-detail-panel__health-indicator ${stage.health}">
          ${stage.health === "healthy" ? "●" : stage.health === "warning" ? "●" : "●"}
        </span>
        <span>Health: ${stage.health.charAt(0).toUpperCase() + stage.health.slice(1)}</span>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tabs
// ══════════════════════════════════════════════════════════════════════════════

function renderTabs(props: FunnelDetailPanelProps): TemplateResult {
  const { activeTab, onTabChange } = props;

  const tabs: { id: "settings" | "kpis" | "sop" | "automations"; label: string; icon: string }[] = [
    { id: "settings", label: "Settings", icon: "⚙️" },
    { id: "kpis", label: "KPIs", icon: "📊" },
    { id: "sop", label: "SOP", icon: "✅" },
    { id: "automations", label: "Auto", icon: "⚡" },
  ];

  return html`
    <div class="funnel-detail-panel__tabs">
      ${tabs.map(tab => html`
        <button class="funnel-detail-panel__tab ${activeTab === tab.id ? 'active' : ''}"
          @click=${() => onTabChange(tab.id)}>
          <span>${tab.icon}</span>
          <span>${tab.label}</span>
        </button>
      `)}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Content
// ══════════════════════════════════════════════════════════════════════════════

function renderTabContent(stage: FunnelStage, props: FunnelDetailPanelProps): TemplateResult {
  const { activeTab } = props;

  switch (activeTab) {
    case "settings":
      return renderSettingsTab(stage, props);
    case "kpis":
      return renderKPIsTab(stage, props);
    case "sop":
      return renderSOPTab(stage, props);
    case "automations":
      return renderAutomationsTab(stage, props);
    default:
      return html``;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Settings Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderSettingsTab(stage: FunnelStage, props: FunnelDetailPanelProps): TemplateResult {
  const { onUpdateStage, requestUpdate } = props;

  return html`
    <div class="funnel-detail-panel__settings">
      <!-- Stage Type -->
      <div class="funnel-detail-panel__field">
        <label>Stage Type</label>
        <div class="funnel-detail-panel__type-selector">
          ${Object.entries(STAGE_TYPE_CONFIG).map(([type, config]) => html`
            <button class="funnel-detail-panel__type-option ${stage.type === type ? 'selected' : ''}"
              style="--stage-color: ${config.color}; --stage-bg: ${config.bgColor}"
              @click=${() => { onUpdateStage(stage.id, { type: type as FunnelStageType }); }}>
              <span>${config.icon}</span>
              <span>${config.label}</span>
            </button>
          `)}
        </div>
      </div>

      <!-- Conversion Rate -->
      <div class="funnel-detail-panel__field">
        <label>Conversion Rate (%)</label>
        <input type="number" 
          min="0" 
          max="100" 
          .value=${String(stage.conversionRate || 0)}
          @change=${(e: Event) => { 
            const val = parseInt((e.target as HTMLInputElement).value) || 0;
            onUpdateStage(stage.id, { conversionRate: Math.min(100, Math.max(0, val)) });
          }}
        />
      </div>

      <!-- Health Status -->
      <div class="funnel-detail-panel__field">
        <label>Health Status</label>
        <div class="funnel-detail-panel__health-selector">
          ${(["healthy", "warning", "critical"] as const).map(health => html`
            <button class="funnel-detail-panel__health-option ${stage.health === health ? 'selected' : ''} ${health}"
              @click=${() => onUpdateStage(stage.id, { health })}>
              <span>●</span>
              <span>${health.charAt(0).toUpperCase() + health.slice(1)}</span>
            </button>
          `)}
        </div>
      </div>

      <!-- Position -->
      <div class="funnel-detail-panel__field">
        <label>Position</label>
        <div class="funnel-detail-panel__position">
          <div>
            <label>X</label>
            <input type="number" .value=${String(Math.round(stage.position.x))} 
              @change=${(e: Event) => { 
                onUpdateStage(stage.id, { position: { ...stage.position, x: parseInt((e.target as HTMLInputElement).value) || 0 } });
              }}
            />
          </div>
          <div>
            <label>Y</label>
            <input type="number" .value=${String(Math.round(stage.position.y))}
              @change=${(e: Event) => { 
                onUpdateStage(stage.id, { position: { ...stage.position, y: parseInt((e.target as HTMLInputElement).value) || 0 } });
              }}
            />
          </div>
        </div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// KPIs Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderKPIsTab(stage: FunnelStage, props: FunnelDetailPanelProps): TemplateResult {
  const { onAddKPI, onUpdateKPI, onDeleteKPI, requestUpdate } = props;

  const handleAddKPI = () => {
    if (_newKPIForm.label.trim() && _newKPIForm.value) {
      onAddKPI(stage.id, {
        label: _newKPIForm.label.trim(),
        value: parseFloat(_newKPIForm.value) || 0,
        unit: _newKPIForm.unit,
        target: _newKPIForm.target ? parseFloat(_newKPIForm.target) : undefined,
      });
      _newKPIForm = { label: "", value: "", unit: "$", target: "" };
      _showAddKPI = false;
      requestUpdate();
    }
  };

  return html`
    <div class="funnel-detail-panel__kpis">
      <!-- KPI List -->
      ${stage.kpis.length > 0 ? html`
        <div class="funnel-detail-panel__kpi-list">
          ${stage.kpis.map(kpi => renderKPICard(stage, kpi, props))}
        </div>
      ` : html`
        <div class="funnel-detail-panel__empty-kpis">
          <span>📊</span>
          <p>No KPIs configured yet</p>
        </div>
      `}

      <!-- Add KPI Form -->
      ${_showAddKPI ? html`
        <div class="funnel-detail-panel__add-kpi">
          <div class="funnel-detail-panel__kpi-form">
            <div class="funnel-detail-panel__kpi-field">
              <label>Label</label>
              <input type="text" placeholder="e.g., Revenue" .value=${_newKPIForm.label}
                @input=${(e: Event) => { _newKPIForm.label = (e.target as HTMLInputElement).value; requestUpdate(); }}
              />
            </div>
            <div class="funnel-detail-panel__kpi-row">
              <div class="funnel-detail-panel__kpi-field">
                <label>Value</label>
                <input type="number" placeholder="0" .value=${_newKPIForm.value}
                  @input=${(e: Event) => { _newKPIForm.value = (e.target as HTMLInputElement).value; requestUpdate(); }}
                />
              </div>
              <div class="funnel-detail-panel__kpi-field">
                <label>Unit</label>
                <select .value=${_newKPIForm.unit} @change=${(e: Event) => { _newKPIForm.unit = (e.target as HTMLSelectElement).value; requestUpdate(); }}>
                  <option value="$">$</option>
                  <option value="%">%</option>
                  <option value="#">#</option>
                  <option value="">None</option>
                </select>
              </div>
            </div>
            <div class="funnel-detail-panel__kpi-field">
              <label>Target (optional)</label>
              <input type="number" placeholder="Target value" .value=${_newKPIForm.target}
                @input=${(e: Event) => { _newKPIForm.target = (e.target as HTMLInputElement).value; requestUpdate(); }}
              />
            </div>
            <div class="funnel-detail-panel__kpi-actions">
              <button class="funnel-detail-panel__kpi-cancel" @click=${() => { _showAddKPI = false; requestUpdate(); }}>Cancel</button>
              <button class="funnel-detail-panel__kpi-save" @click=${handleAddKPI}>Add KPI</button>
            </div>
          </div>
        </div>
      ` : html`
        <button class="funnel-detail-panel__add-btn" @click=${() => { _showAddKPI = true; requestUpdate(); }}>
          ${icons.plus}
          <span>Add KPI</span>
        </button>
      `}
    </div>
  `;
}

function renderKPICard(stage: FunnelStage, kpi: StageKPI, props: FunnelDetailPanelProps): TemplateResult {
  const { onDeleteKPI, onUpdateKPI, requestUpdate } = props;
  const progress = kpi.target ? Math.min(100, (kpi.value / kpi.target) * 100) : null;

  return html`
    <div class="funnel-detail-panel__kpi-card">
      <div class="funnel-detail-panel__kpi-header">
        <span class="funnel-detail-panel__kpi-label">${kpi.label}</span>
        <button class="funnel-detail-panel__kpi-delete" @click=${() => onDeleteKPI(stage.id, kpi.id)}>
          ${icons.x}
        </button>
      </div>
      <div class="funnel-detail-panel__kpi-value">
        ${kpi.unit === "$" ? "$" : ""}${kpi.value.toLocaleString()}${kpi.unit === "%" ? "%" : ""}
        ${kpi.trend ? html`
          <span class="funnel-detail-panel__kpi-trend ${kpi.trend}">
            ${kpi.trend === "up" ? "↑" : kpi.trend === "down" ? "↓" : "→"}
          </span>
        ` : nothing}
      </div>
      ${progress !== null ? html`
        <div class="funnel-detail-panel__kpi-progress">
          <div class="funnel-detail-panel__kpi-progress-bar" style="width: ${progress}%"></div>
        </div>
        <div class="funnel-detail-panel__kpi-target">
          Target: ${kpi.unit === "$" ? "$" : ""}${kpi.target?.toLocaleString()}${kpi.unit === "%" ? "%" : ""} (${Math.round(progress)}%)
        </div>
      ` : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// SOP Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderSOPTab(stage: FunnelStage, props: FunnelDetailPanelProps): TemplateResult {
  const { onAddSOPItem, onToggleSOPItem, onDeleteSOPItem, requestUpdate } = props;
  const sopItems = stage.sopItems || [];
  const completedCount = sopItems.filter(item => item.completed).length;

  const handleAddSOP = () => {
    if (_newSOPItem.trim()) {
      onAddSOPItem(stage.id, _newSOPItem.trim());
      _newSOPItem = "";
      _showAddSOP = false;
      requestUpdate();
    }
  };

  return html`
    <div class="funnel-detail-panel__sop">
      <!-- Progress Header -->
      ${sopItems.length > 0 ? html`
        <div class="funnel-detail-panel__sop-progress">
          <div class="funnel-detail-panel__sop-progress-text">
            <span>${completedCount} of ${sopItems.length} completed</span>
            <span>${Math.round((completedCount / sopItems.length) * 100)}%</span>
          </div>
          <div class="funnel-detail-panel__sop-progress-bar">
            <div class="funnel-detail-panel__sop-progress-fill" style="width: ${(completedCount / sopItems.length) * 100}%"></div>
          </div>
        </div>
      ` : nothing}

      <!-- SOP List -->
      ${sopItems.length > 0 ? html`
        <div class="funnel-detail-panel__sop-list">
          ${sopItems.map(item => html`
            <div class="funnel-detail-panel__sop-item ${item.completed ? 'completed' : ''}">
              <button class="funnel-detail-panel__sop-checkbox" @click=${() => onToggleSOPItem(stage.id, item.id)}>
                ${item.completed ? icons.check : nothing}
              </button>
              <span class="funnel-detail-panel__sop-label">${item.label}</span>
              <button class="funnel-detail-panel__sop-delete" @click=${() => onDeleteSOPItem(stage.id, item.id)}>
                ${icons.x}
              </button>
            </div>
          `)}
        </div>
      ` : html`
        <div class="funnel-detail-panel__empty-sop">
          <span>✅</span>
          <p>No SOP items yet</p>
          <p class="hint">Add checklist items for this stage</p>
        </div>
      `}

      <!-- Add SOP Form -->
      ${_showAddSOP ? html`
        <div class="funnel-detail-panel__add-sop">
          <input type="text" placeholder="New checklist item..." .value=${_newSOPItem}
            @input=${(e: Event) => { _newSOPItem = (e.target as HTMLInputElement).value; requestUpdate(); }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") handleAddSOP(); if (e.key === "Escape") { _showAddSOP = false; requestUpdate(); } }}
            autofocus
          />
          <button class="funnel-detail-panel__sop-save" @click=${handleAddSOP}>${icons.plus}</button>
        </div>
      ` : html`
        <button class="funnel-detail-panel__add-btn" @click=${() => { _showAddSOP = true; requestUpdate(); }}>
          ${icons.plus}
          <span>Add Checklist Item</span>
        </button>
      `}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Automations Tab - AI-Powered with Infinibot Session Spawning
// ══════════════════════════════════════════════════════════════════════════════

interface StageAutomation {
  id: string;
  trigger: string;
  action: string;
  config: Record<string, unknown>;
  enabled: boolean;
  lastRun?: number;
  runCount?: number;
}

function renderAutomationsTab(stage: FunnelStage, props: FunnelDetailPanelProps): TemplateResult {
  const { requestUpdate } = props;
  const automations: StageAutomation[] = (stage as any).automationConfigs || [];

  return html`
    <div class="funnel-detail-panel__automations">
      <!-- AI Agent Section -->
      <div class="funnel-detail-panel__ai-section">
        <div class="funnel-detail-panel__ai-header">
          <span class="funnel-detail-panel__ai-icon">🤖</span>
          <div>
            <h4>AI AGENT AUTOMATIONS</h4>
            <p>Spawn Infinibot sessions to handle stage tasks</p>
          </div>
        </div>

        <!-- Active Automations -->
        ${automations.length > 0 ? html`
          <div class="funnel-detail-panel__automation-list">
            ${automations.map(auto => renderAutomationCard(auto, requestUpdate))}
          </div>
        ` : html`
          <div class="funnel-detail-panel__empty-automations">
            <span>⚡</span>
            <p>No automations configured</p>
            <p class="hint">Set up AI agents to handle tasks in this stage</p>
          </div>
        `}
      </div>
    </div>
  `;
}

function renderAutomationCard(auto: StageAutomation, requestUpdate: () => void): TemplateResult {
  const triggerLabels: Record<string, string> = {
    lead_enters: "When lead enters stage",
    lead_qualified: "When lead is qualified",
    time_in_stage: "After time in stage",
    manual: "Manual trigger",
    conversion: "On conversion",
  };

  const actionLabels: Record<string, string> = {
    spawn_agent: "🤖 Spawn AI Agent",
    send_message: "💬 Send Message",
    move_stage: "➡️ Move to Stage",
    tag_lead: "🏷️ Tag Lead",
    notify: "🔔 Send Notification",
  };

  return html`
    <div class="funnel-detail-panel__automation-card ${auto.enabled ? 'enabled' : 'disabled'}">
      <div class="funnel-detail-panel__automation-header">
        <div class="funnel-detail-panel__automation-trigger">
          <span class="trigger-icon">⚡</span>
          <span>${triggerLabels[auto.trigger] || auto.trigger}</span>
        </div>
        <label class="funnel-detail-panel__automation-toggle">
          <input type="checkbox" ?checked=${auto.enabled} @change=${() => { auto.enabled = !auto.enabled; requestUpdate(); }} />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="funnel-detail-panel__automation-action">
        <span class="action-arrow">→</span>
        <span>${actionLabels[auto.action] || auto.action}</span>
      </div>
      ${auto.runCount !== undefined ? html`
        <div class="funnel-detail-panel__automation-stats">
          <span>Runs: ${auto.runCount}</span>
          ${auto.lastRun ? html`<span>Last: ${new Date(auto.lastRun).toLocaleDateString()}</span>` : nothing}
        </div>
      ` : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

const detailPanelStyles = `
  .funnel-detail-panel {
    display: flex;
    flex-direction: column;
    width: 320px;
    height: 100%;
    background: var(--g-surface);
    border-left: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
  }

  .funnel-detail-panel--collapsed {
    width: 56px;
    align-items: center;
    padding: 12px 0;
  }

  .funnel-detail-panel--empty {
    justify-content: center;
    align-items: center;
  }

  .funnel-detail-panel__empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 32px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
  }

  .funnel-detail-panel__empty-icon {
    font-size: 48px;
    margin-bottom: 16px;
  }

  .funnel-detail-panel__empty-state h3 {
    margin: 0 0 8px 0;
    font-size: 16px;
    color: white;
  }

  .funnel-detail-panel__empty-state p {
    margin: 0;
    font-size: 13px;
  }

  .funnel-detail-panel__expand-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    background: transparent;
    border: none;
    border-radius: 8px;
    font-size: 20px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__expand-btn:hover {
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
  }

  /* Header */
  .funnel-detail-panel__header {
    padding: 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
    background: linear-gradient(135deg, var(--stage-color, var(--info, var(--glass-gold))) 0%, transparent 100%);
    background-size: 200% 200%;
    opacity: 0.15;
    position: relative;
  }

  .funnel-detail-panel__header::before {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, transparent, var(--g-surface-strong));
    pointer-events: none;
  }

  .funnel-detail-panel__header > * {
    position: relative;
    z-index: 1;
  }

  .funnel-detail-panel__header-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }

  .funnel-detail-panel__collapse-btn,
  .funnel-detail-panel__close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__collapse-btn:hover,
  .funnel-detail-panel__close-btn:hover {
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    color: white;
  }

  .funnel-detail-panel__collapse-btn svg,
  .funnel-detail-panel__close-btn svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  .funnel-detail-panel__stage-type {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .funnel-detail-panel__stage-info {
    margin-top: 8px;
  }

  .funnel-detail-panel__name {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px 0;
    font-size: 18px;
    font-weight: 600;
    color: white;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__name:hover {
    color: var(--info, var(--glass-gold));
  }

  .funnel-detail-panel__edit-hint {
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .funnel-detail-panel__name:hover .funnel-detail-panel__edit-hint {
    opacity: 0.5;
  }

  .funnel-detail-panel__edit-hint svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  .funnel-detail-panel__name-input {
    width: 100%;
    padding: 8px;
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    border: 1px solid var(--info, var(--glass-gold));
    border-radius: 6px;
    color: white;
    font-size: 18px;
    font-weight: 600;
    outline: none;
    margin-bottom: 8px;
  }

  .funnel-detail-panel__description {
    margin: 0 0 12px 0;
    font-size: 13px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__description:hover {
    color: color-mix(in srgb, var(--g-fg) 70%, transparent);
  }

  .funnel-detail-panel__desc-input {
    width: 100%;
    padding: 8px;
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    border: 1px solid var(--info, var(--glass-gold));
    border-radius: 6px;
    color: white;
    font-size: 13px;
    outline: none;
    resize: vertical;
    margin-bottom: 12px;
  }

  .funnel-detail-panel__health {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: color-mix(in srgb, var(--g-fg) 60%, transparent);
  }

  .funnel-detail-panel__health-indicator {
    font-size: 10px;
  }

  .funnel-detail-panel__health-indicator.healthy { color: var(--ok, #22c55e); }
  .funnel-detail-panel__health-indicator.warning { color: var(--warn, #f59e0b); }
  .funnel-detail-panel__health-indicator.critical { color: var(--destructive, #ef4444); }

  /* Tabs */
  .funnel-detail-panel__tabs {
    display: flex;
    border-bottom: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
  }

  .funnel-detail-panel__tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 8px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__tab:hover {
    color: white;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
  }

  .funnel-detail-panel__tab.active {
    color: var(--info, var(--glass-gold));
    border-bottom-color: var(--info, var(--glass-gold));
  }

  /* Content */
  .funnel-detail-panel__content {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  /* Settings Tab */
  .funnel-detail-panel__settings {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .funnel-detail-panel__field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .funnel-detail-panel__field > label {
    font-size: 12px;
    font-weight: 500;
    color: color-mix(in srgb, var(--g-fg) 60%, transparent);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .funnel-detail-panel__field > input {
    padding: 10px 12px;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 8px;
    color: white;
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .funnel-detail-panel__field > input:focus {
    border-color: var(--info, var(--glass-gold));
  }

  .funnel-detail-panel__type-selector {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }

  .funnel-detail-panel__type-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 6px;
    background: var(--stage-bg);
    border: 2px solid transparent;
    border-radius: 8px;
    color: color-mix(in srgb, var(--g-fg) 70%, transparent);
    font-size: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__type-option:hover {
    border-color: var(--stage-color);
  }

  .funnel-detail-panel__type-option.selected {
    border-color: var(--stage-color);
    color: var(--stage-color);
  }

  .funnel-detail-panel__health-selector {
    display: flex;
    gap: 8px;
  }

  .funnel-detail-panel__health-option {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border: 2px solid transparent;
    border-radius: 8px;
    color: color-mix(in srgb, var(--g-fg) 60%, transparent);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__health-option.healthy span:first-child { color: var(--ok, #22c55e); }
  .funnel-detail-panel__health-option.warning span:first-child { color: var(--warn, #f59e0b); }
  .funnel-detail-panel__health-option.critical span:first-child { color: var(--destructive, #ef4444); }

  .funnel-detail-panel__health-option.selected {
    border-color: currentColor;
  }

  .funnel-detail-panel__health-option.selected.healthy { border-color: var(--ok, #22c55e); }
  .funnel-detail-panel__health-option.selected.warning { border-color: var(--warn, #f59e0b); }
  .funnel-detail-panel__health-option.selected.critical { border-color: var(--destructive, #ef4444); }

  .funnel-detail-panel__position {
    display: flex;
    gap: 12px;
  }

  .funnel-detail-panel__position > div {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .funnel-detail-panel__position label {
    font-size: 11px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
  }

  .funnel-detail-panel__position input {
    padding: 8px 10px;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 6px;
    color: white;
    font-size: 13px;
    outline: none;
  }

  /* KPIs Tab */
  .funnel-detail-panel__kpis {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .funnel-detail-panel__kpi-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .funnel-detail-panel__kpi-card {
    padding: 12px;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border-radius: 10px;
  }

  .funnel-detail-panel__kpi-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .funnel-detail-panel__kpi-label {
    font-size: 12px;
    color: color-mix(in srgb, var(--g-fg) 60%, transparent);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .funnel-detail-panel__kpi-delete {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--g-fg) 30%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0;
  }

  .funnel-detail-panel__kpi-card:hover .funnel-detail-panel__kpi-delete {
    opacity: 1;
  }

  .funnel-detail-panel__kpi-delete:hover {
    background: rgba(239, 68, 68, 0.2);
    color: var(--destructive, #ef4444);
  }

  .funnel-detail-panel__kpi-delete svg {
    width: 12px;
    height: 12px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  .funnel-detail-panel__kpi-value {
    font-size: 24px;
    font-weight: 700;
    color: white;
    margin-bottom: 8px;
  }

  .funnel-detail-panel__kpi-trend {
    font-size: 14px;
    margin-left: 8px;
  }

  .funnel-detail-panel__kpi-trend.up { color: var(--ok, #22c55e); }
  .funnel-detail-panel__kpi-trend.down { color: var(--destructive, #ef4444); }
  .funnel-detail-panel__kpi-trend.flat { color: var(--warn, #f59e0b); }

  .funnel-detail-panel__kpi-progress {
    height: 4px;
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 2px;
    margin-bottom: 6px;
  }

  .funnel-detail-panel__kpi-progress-bar {
    height: 100%;
    background: var(--info, var(--glass-gold));
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .funnel-detail-panel__kpi-target {
    font-size: 11px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
  }

  .funnel-detail-panel__empty-kpis,
  .funnel-detail-panel__empty-sop,
  .funnel-detail-panel__empty-automations {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px;
    text-align: center;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
  }

  .funnel-detail-panel__empty-kpis span,
  .funnel-detail-panel__empty-sop span,
  .funnel-detail-panel__empty-automations span {
    font-size: 32px;
    margin-bottom: 8px;
  }

  .funnel-detail-panel__empty-kpis p,
  .funnel-detail-panel__empty-sop p,
  .funnel-detail-panel__empty-automations p {
    margin: 0;
    font-size: 13px;
  }

  .funnel-detail-panel__empty-sop p.hint,
  .funnel-detail-panel__empty-automations p.hint {
    font-size: 11px;
    margin-top: 4px;
    opacity: 0.7;
  }

  .funnel-detail-panel__add-kpi {
    padding: 12px;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border-radius: 10px;
  }

  .funnel-detail-panel__kpi-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .funnel-detail-panel__kpi-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .funnel-detail-panel__kpi-field label {
    font-size: 11px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
  }

  .funnel-detail-panel__kpi-field input,
  .funnel-detail-panel__kpi-field select {
    padding: 8px 10px;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 6px;
    color: white;
    font-size: 13px;
    outline: none;
  }

  .funnel-detail-panel__kpi-row {
    display: flex;
    gap: 12px;
  }

  .funnel-detail-panel__kpi-row > * {
    flex: 1;
  }

  .funnel-detail-panel__kpi-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .funnel-detail-panel__kpi-cancel,
  .funnel-detail-panel__kpi-save {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__kpi-cancel {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--g-fg) 20%, transparent);
    color: color-mix(in srgb, var(--g-fg) 70%, transparent);
  }

  .funnel-detail-panel__kpi-cancel:hover {
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
  }

  .funnel-detail-panel__kpi-save {
    background: var(--info, var(--glass-gold));
    border: none;
    color: white;
  }

  .funnel-detail-panel__kpi-save:hover {
    background: color-mix(in srgb, var(--info, var(--glass-gold)) 85%, black);
  }

  .funnel-detail-panel__add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    background: color-mix(in srgb, var(--glass-gold) 10%, transparent);
    border: 1px dashed color-mix(in srgb, var(--glass-gold) 30%, transparent);
    border-radius: 8px;
    color: var(--info, var(--glass-gold));
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__add-btn:hover {
    background: color-mix(in srgb, var(--glass-gold) 20%, transparent);
    border-color: color-mix(in srgb, var(--glass-gold) 50%, transparent);
  }

  .funnel-detail-panel__add-btn svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  /* SOP Tab */
  .funnel-detail-panel__sop {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .funnel-detail-panel__sop-progress {
    padding: 12px;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border-radius: 10px;
  }

  .funnel-detail-panel__sop-progress-text {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 12px;
    color: color-mix(in srgb, var(--g-fg) 60%, transparent);
  }

  .funnel-detail-panel__sop-progress-bar {
    height: 6px;
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 3px;
  }

  .funnel-detail-panel__sop-progress-fill {
    height: 100%;
    background: var(--ok, #22c55e);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .funnel-detail-panel__sop-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .funnel-detail-panel__sop-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border-radius: 8px;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__sop-item:hover {
    background: color-mix(in srgb, var(--g-fg) 8%, transparent);
  }

  .funnel-detail-panel__sop-item.completed {
    opacity: 0.6;
  }

  .funnel-detail-panel__sop-item.completed .funnel-detail-panel__sop-label {
    text-decoration: line-through;
  }

  .funnel-detail-panel__sop-checkbox {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: 2px solid color-mix(in srgb, var(--g-fg) 30%, transparent);
    border-radius: 4px;
    color: white;
    cursor: pointer;
    transition: all 0.15s ease;
    padding: 0;
  }

  .funnel-detail-panel__sop-item.completed .funnel-detail-panel__sop-checkbox {
    background: var(--ok, #22c55e);
    border-color: var(--ok, #22c55e);
  }

  .funnel-detail-panel__sop-checkbox svg {
    width: 12px;
    height: 12px;
    stroke: currentColor;
    stroke-width: 3;
    fill: none;
  }

  .funnel-detail-panel__sop-label {
    flex: 1;
    font-size: 13px;
    color: white;
  }

  .funnel-detail-panel__sop-delete {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--g-fg) 30%, transparent);
    cursor: pointer;
    opacity: 0;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__sop-item:hover .funnel-detail-panel__sop-delete {
    opacity: 1;
  }

  .funnel-detail-panel__sop-delete:hover {
    background: rgba(239, 68, 68, 0.2);
    color: var(--destructive, #ef4444);
  }

  .funnel-detail-panel__sop-delete svg {
    width: 12px;
    height: 12px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  .funnel-detail-panel__add-sop {
    display: flex;
    gap: 8px;
  }

  .funnel-detail-panel__add-sop input {
    flex: 1;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 8px;
    color: white;
    font-size: 13px;
    outline: none;
  }

  .funnel-detail-panel__add-sop input:focus {
    border-color: var(--info, var(--glass-gold));
  }

  .funnel-detail-panel__sop-save {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    background: var(--ok, #22c55e);
    border: none;
    border-radius: 8px;
    color: white;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__sop-save:hover {
    background: color-mix(in srgb, var(--ok, #22c55e) 85%, black);
  }

  .funnel-detail-panel__sop-save svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  /* Automations Tab - AI Powered */
  .funnel-detail-panel__automations {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .funnel-detail-panel__ai-section {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 5%, transparent) 0%, color-mix(in srgb, var(--glass-gold) 2%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
    border-radius: 12px;
    padding: 14px;
  }

  .funnel-detail-panel__ai-header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 14px;
  }

  .funnel-detail-panel__ai-icon {
    font-size: 24px;
  }

  .funnel-detail-panel__ai-header h4 {
    margin: 0 0 2px 0;
    font-size: 12px;
    font-weight: 700;
    color: var(--g-primary);
    letter-spacing: 1px;
  }

  .funnel-detail-panel__ai-header p {
    margin: 0;
    font-size: 11px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
  }

  .funnel-detail-panel__automation-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .funnel-detail-panel__automation-card {
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
    border-radius: 10px;
    padding: 12px;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__automation-card.enabled {
    border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  .funnel-detail-panel__automation-card.disabled {
    opacity: 0.5;
  }

  .funnel-detail-panel__automation-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .funnel-detail-panel__automation-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: color-mix(in srgb, var(--g-fg) 80%, transparent);
  }

  .funnel-detail-panel__automation-trigger .trigger-icon {
    color: var(--g-primary);
  }

  .funnel-detail-panel__automation-toggle {
    position: relative;
    width: 36px;
    height: 20px;
    cursor: pointer;
  }

  .funnel-detail-panel__automation-toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .funnel-detail-panel__automation-toggle .toggle-slider {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 10px;
    transition: all 0.2s ease;
  }

  .funnel-detail-panel__automation-toggle .toggle-slider::before {
    content: '';
    position: absolute;
    width: 16px;
    height: 16px;
    left: 2px;
    top: 2px;
    background: white;
    border-radius: 50%;
    transition: all 0.2s ease;
  }

  .funnel-detail-panel__automation-toggle input:checked + .toggle-slider {
    background: var(--g-primary);
  }

  .funnel-detail-panel__automation-toggle input:checked + .toggle-slider::before {
    transform: translateX(16px);
  }

  .funnel-detail-panel__automation-action {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: color-mix(in srgb, var(--g-fg) 60%, transparent);
    padding-left: 20px;
  }

  .funnel-detail-panel__automation-action .action-arrow {
    color: var(--g-primary);
    font-weight: bold;
  }

  .funnel-detail-panel__automation-stats {
    display: flex;
    gap: 12px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, var(--g-fg) 5%, transparent);
    font-size: 10px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
  }

  /* Quick Actions */
  .funnel-detail-panel__quick-actions {
    background: color-mix(in srgb, var(--g-fg) 2%, transparent);
    border-radius: 10px;
    padding: 12px;
  }

  .funnel-detail-panel__quick-actions h4 {
    margin: 0 0 10px 0;
    font-size: 10px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-primary) 60%, transparent);
    letter-spacing: 1px;
  }

  .funnel-detail-panel__action-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .funnel-detail-panel__quick-action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 12px 8px;
    background: color-mix(in srgb, var(--g-primary) 3%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__quick-action:hover {
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
    transform: translateY(-2px);
  }

  .funnel-detail-panel__quick-action .quick-action-icon {
    font-size: 20px;
  }

  .funnel-detail-panel__quick-action .quick-action-label {
    font-size: 10px;
    font-weight: 600;
    color: color-mix(in srgb, var(--g-fg) 80%, transparent);
  }

  .funnel-detail-panel__quick-action .quick-action-desc {
    font-size: 9px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
  }

  /* Triggers */
  .funnel-detail-panel__triggers-section {
    background: color-mix(in srgb, var(--g-fg) 2%, transparent);
    border-radius: 10px;
    padding: 12px;
  }

  .funnel-detail-panel__triggers-section h4 {
    margin: 0 0 10px 0;
    font-size: 10px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-primary) 60%, transparent);
    letter-spacing: 1px;
  }

  .funnel-detail-panel__trigger-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .funnel-detail-panel__trigger-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--glass-base) 20%, transparent);
    border-radius: 6px;
    font-size: 11px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__trigger-item:hover {
    background: color-mix(in srgb, var(--g-primary) 5%, transparent);
    color: color-mix(in srgb, var(--g-fg) 70%, transparent);
  }

  .funnel-detail-panel__trigger-item.active {
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
    color: color-mix(in srgb, var(--g-fg) 90%, transparent);
  }

  .funnel-detail-panel__trigger-item .trigger-dot {
    width: 6px;
    height: 6px;
    background: color-mix(in srgb, var(--g-fg) 20%, transparent);
    border-radius: 50%;
  }

  .funnel-detail-panel__trigger-item.active .trigger-dot {
    background: var(--g-primary);
    box-shadow: 0 0 6px var(--g-primary);
  }

  .funnel-detail-panel__trigger-item .trigger-badge {
    margin-left: auto;
    font-size: 9px;
    padding: 2px 6px;
    background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    color: var(--g-primary);
    border-radius: 4px;
    font-weight: 600;
  }

  /* Add Automation Button */
  .funnel-detail-panel__add-automation-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 16px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 12%, transparent) 0%, color-mix(in srgb, var(--glass-gold) 8%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
    border-radius: 8px;
    color: var(--g-primary);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__add-automation-btn:hover {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 18%, transparent) 0%, color-mix(in srgb, var(--glass-gold) 12%, transparent) 100%);
    box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 15%, transparent);
  }

  .funnel-detail-panel__add-automation-btn svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  /* Add Automation Form */
  .funnel-detail-panel__add-automation-form {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 5%, transparent) 0%, color-mix(in srgb, var(--glass-base) 30%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 12px;
    padding: 16px;
  }

  .funnel-detail-panel__form-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  .funnel-detail-panel__form-header h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--g-primary);
  }

  .funnel-detail-panel__form-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__form-close:hover {
    background: color-mix(in srgb, var(--destructive, #ef4444) 10%, transparent);
    color: var(--destructive, var(--destructive, #ef4444));
  }

  .funnel-detail-panel__form-close svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  .funnel-detail-panel__form-field {
    margin-bottom: 14px;
  }

  .funnel-detail-panel__form-field label {
    display: block;
    font-size: 9px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    letter-spacing: 1px;
    margin-bottom: 6px;
  }

  .funnel-detail-panel__form-field select,
  .funnel-detail-panel__form-field textarea {
    width: 100%;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
    border-radius: 8px;
    color: color-mix(in srgb, var(--g-fg) 90%, transparent);
    font-size: 12px;
    outline: none;
    transition: all 0.15s ease;
    font-family: inherit;
    box-sizing: border-box;
  }

  .funnel-detail-panel__form-field select:focus,
  .funnel-detail-panel__form-field textarea:focus {
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    background: color-mix(in srgb, var(--glass-base) 40%, transparent);
  }

  .funnel-detail-panel__form-field textarea {
    resize: vertical;
    min-height: 60px;
  }

  .funnel-detail-panel__agent-config {
    background: color-mix(in srgb, var(--g-primary) 3%, transparent);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 14px;
  }

  .funnel-detail-panel__agent-preview {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
  }

  .funnel-detail-panel__agent-preview .preview-label {
    display: block;
    font-size: 9px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    letter-spacing: 1px;
    margin-bottom: 8px;
  }

  .funnel-detail-panel__agent-preview .preview-content {
    background: color-mix(in srgb, var(--glass-base) 40%, transparent);
    border-radius: 6px;
    padding: 10px;
    font-family: 'JetBrains Mono', monospace;
  }

  .funnel-detail-panel__agent-preview code {
    display: block;
    font-size: 10px;
    color: color-mix(in srgb, var(--g-primary) 70%, transparent);
    line-height: 1.5;
  }

  .funnel-detail-panel__form-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }

  .funnel-detail-panel__form-cancel,
  .funnel-detail-panel__form-submit {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 16px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-detail-panel__form-cancel {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
  }

  .funnel-detail-panel__form-cancel:hover {
    background: color-mix(in srgb, var(--g-fg) 5%, transparent);
    color: color-mix(in srgb, var(--g-fg) 80%, transparent);
  }

  .funnel-detail-panel__form-submit {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 20%, transparent) 0%, color-mix(in srgb, var(--glass-gold) 15%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    color: var(--g-primary);
  }

  .funnel-detail-panel__form-submit:hover {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 30%, transparent) 0%, color-mix(in srgb, var(--glass-gold) 20%, transparent) 100%);
    box-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 15%, transparent);
  }

  .funnel-detail-panel__form-submit svg {
    width: 12px;
    height: 12px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  @media (max-width: 720px) {
    .funnel-detail-panel,
    .funnel-detail-panel--collapsed {
      width: 100%;
      height: auto;
      min-height: 0;
      border-left: 0;
      border-top: 1px solid color-mix(in srgb, var(--g-fg) 8%, transparent);
    }
    .funnel-detail-panel--collapsed {
      padding: 10px 0;
    }
  }
`;
