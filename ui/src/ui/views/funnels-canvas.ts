/**
 * Funnels Canvas View
 * React Flow-based visual builder for marketing funnels
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export type FunnelStageType = 
  | "content" 
  | "engagement" 
  | "capture" 
  | "nurture" 
  | "convert" 
  | "upsell";

export interface FunnelStage {
  id: string;
  type: FunnelStageType;
  name: string;
  description?: string;
  kpis: StageKPI[];
  conversionRate?: number;
  health: "healthy" | "warning" | "critical";
  automations: string[];
  position: { x: number; y: number };
  sopItems?: SOPItem[];
}

export interface StageKPI {
  id: string;
  label: string;
  value: number;
  unit: string;
  trend?: "up" | "down" | "flat";
  target?: number;
}

export interface SOPItem {
  id: string;
  label: string;
  completed: boolean;
}

export interface FunnelConnection {
  id: string;
  source: string;
  target: string;
  label?: string;
  conversionRate?: number;
}

export interface Funnel {
  id: string;
  name: string;
  description?: string;
  stages: FunnelStage[];
  connections: FunnelConnection[];
  createdAt: number;
  updatedAt: number;
  status: "active" | "draft" | "paused";
  totalRevenue?: number;
  totalLeads?: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stage Type Configuration
// ══════════════════════════════════════════════════════════════════════════════

export const STAGE_TYPE_CONFIG: Record<FunnelStageType, {
  label: string;
  color: string;
  bgColor: string;
  icon: string;
  description: string;
}> = {
  content: {
    label: "Content",
    color: "color-mix(in srgb, var(--info, #3b82f6) 70%, white)",
    bgColor: "rgba(96, 165, 250, 0.12)",
    icon: "📝",
    description: "Attract with valuable content",
  },
  engagement: {
    label: "Engagement",
    color: "#a78bfa",
    bgColor: "rgba(167, 139, 250, 0.12)",
    icon: "💬",
    description: "Build relationships",
  },
  capture: {
    label: "Capture",
    color: "var(--g-primary)",
    bgColor: "rgba(251, 191, 36, 0.12)",
    icon: "🎯",
    description: "Collect lead information",
  },
  nurture: {
    label: "Nurture",
    color: "color-mix(in srgb, var(--ok, #22c55e) 70%, white)",
    bgColor: "rgba(52, 211, 153, 0.12)",
    icon: "🌱",
    description: "Educate and build trust",
  },
  convert: {
    label: "Convert",
    color: "var(--g-primary)",
    bgColor: "color-mix(in srgb, var(--g-primary) 15%, transparent)",
    icon: "💰",
    description: "Close the sale",
  },
  upsell: {
    label: "Upsell",
    color: "#f472b6",
    bgColor: "rgba(244, 114, 182, 0.12)",
    icon: "🚀",
    description: "Increase customer value",
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// Canvas State
// ══════════════════════════════════════════════════════════════════════════════

let _canvasZoom = 1;
let _canvasPan = { x: 0, y: 0 };
let _isDragging = false;
let _dragStart = { x: 0, y: 0 };
let _selectedNodeId: string | null = null;
let _connectingFrom: string | null = null;
let _mousePos = { x: 0, y: 0 };
let _draggedStageType: FunnelStageType | null = null;
let _showMinimap = true;

// React Flow will be loaded dynamically
let _reactFlowLoaded = false;
let _reactFlowContainer: HTMLElement | null = null;
let _reactFlowInstance: any = null;

// ══════════════════════════════════════════════════════════════════════════════
// Props Interface
// ══════════════════════════════════════════════════════════════════════════════

export interface FunnelCanvasProps {
  funnel: Funnel | null;
  loading: boolean;
  selectedStageId: string | null;
  onSelectStage: (stageId: string | null) => void;
  onUpdateStage: (stageId: string, patch: Partial<FunnelStage>) => void;
  onDeleteStage: (stageId: string) => void;
  onAddStage: (type: FunnelStageType, position: { x: number; y: number }) => void;
  onConnectStages: (sourceId: string, targetId: string) => void;
  onDeleteConnection: (connectionId: string) => void;
  onMoveStage: (stageId: string, position: { x: number; y: number }) => void;
  requestUpdate: () => void;
}

// ══════════════════════════════════════════════════════════════════════════════
// Render Functions
// ══════════════════════════════════════════════════════════════════════════════

export function renderFunnelCanvas(props: FunnelCanvasProps): TemplateResult {
  const { funnel, loading, selectedStageId, onSelectStage, onUpdateStage, onAddStage, onMoveStage, onConnectStages, onDeleteStage, onDeleteConnection, requestUpdate } = props;

  if (loading) {
    return html`
      <div class="funnel-canvas-loading">
        <div class="funnel-canvas-spinner"></div>
        <span>Loading funnel...</span>
      </div>
    `;
  }

  if (!funnel) {
    return html`
      <div class="funnel-canvas-empty">
        <div class="funnel-canvas-empty__icon">🎯</div>
        <h3>No Funnel Selected</h3>
        <p>Select a funnel from the sidebar or create a new one</p>
      </div>
    `;
  }

  return html`
    <style>
      ${canvasStyles}
    </style>
    <div class="funnel-canvas" 
      @wheel=${(e: WheelEvent) => handleWheel(e, requestUpdate)}
      @mousedown=${(e: MouseEvent) => handleCanvasMouseDown(e, requestUpdate)}
      @mousemove=${(e: MouseEvent) => handleCanvasMouseMove(e, requestUpdate)}
      @mouseup=${(e: MouseEvent) => handleCanvasMouseUp(e, requestUpdate)}
      @mouseleave=${() => handleCanvasMouseUp({ button: 0 } as MouseEvent, requestUpdate)}
      @dragover=${(e: DragEvent) => e.preventDefault()}
      @drop=${(e: DragEvent) => handleDrop(e, onAddStage, requestUpdate)}
    >
      <!-- Canvas Background Grid -->
      <svg class="funnel-canvas__grid" width="100%" height="100%">
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"
            patternTransform="translate(${_canvasPan.x % 20}, ${_canvasPan.y % 20}) scale(${_canvasZoom})">
            <circle cx="1" cy="1" r="1" fill="color-mix(in srgb, var(--g-fg) 10%, transparent)"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)"/>
      </svg>

      <!-- Canvas Content -->
      <div class="funnel-canvas__content" style="
        transform: translate(${_canvasPan.x}px, ${_canvasPan.y}px) scale(${_canvasZoom});
        transform-origin: 0 0;
      ">
        <!-- Connections (SVG layer) -->
        <svg class="funnel-canvas__connections" 
          style="position: absolute; top: 0; left: 0; width: 2000px; height: 2000px; pointer-events: none; overflow: visible;">
          ${renderConnections(funnel, selectedStageId, onDeleteConnection)}
          ${_connectingFrom ? renderConnectingLine(funnel) : nothing}
        </svg>

        <!-- Stage Nodes -->
        ${funnel.stages.map(stage => renderStageNode(stage, props))}
      </div>

      <!-- Controls Overlay -->
      <div class="funnel-canvas__controls">
        <button class="funnel-canvas__control-btn" @click=${() => { _canvasZoom = Math.min(2, _canvasZoom + 0.1); requestUpdate(); }} title="Zoom In">
          ${icons.plus}
        </button>
        <span class="funnel-canvas__zoom-level">${Math.round(_canvasZoom * 100)}%</span>
        <button class="funnel-canvas__control-btn" @click=${() => { _canvasZoom = Math.max(0.25, _canvasZoom - 0.1); requestUpdate(); }} title="Zoom Out">
          ${icons.minus}
        </button>
        <button class="funnel-canvas__control-btn" @click=${() => { _canvasZoom = 1; _canvasPan = { x: 0, y: 0 }; requestUpdate(); }} title="Reset View">
          ${icons.maximize}
        </button>
        <button class="funnel-canvas__control-btn ${_showMinimap ? 'active' : ''}" 
          @click=${() => { _showMinimap = !_showMinimap; requestUpdate(); }} title="Toggle Minimap">
          ${icons.grid}
        </button>
      </div>

      <!-- Minimap -->
      ${_showMinimap ? renderMinimap(funnel, requestUpdate) : nothing}

      <!-- Connecting indicator -->
      ${_connectingFrom ? html`
        <div class="funnel-canvas__connecting-indicator">
          <span>🔗 Click another stage to connect, or press Escape to cancel</span>
        </div>
      ` : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stage Node Rendering
// ══════════════════════════════════════════════════════════════════════════════

function renderStageNode(stage: FunnelStage, props: FunnelCanvasProps): TemplateResult {
  const { selectedStageId, onSelectStage, onMoveStage, onConnectStages, onDeleteStage, requestUpdate } = props;
  const config = STAGE_TYPE_CONFIG[stage.type];
  const isSelected = stage.id === selectedStageId;
  const isConnecting = _connectingFrom !== null;
  const isConnectingSource = _connectingFrom === stage.id;

  return html`
    <div class="funnel-stage-node ${isSelected ? 'selected' : ''} ${isConnecting ? 'connecting-mode' : ''} ${isConnectingSource ? 'connecting-source' : ''}"
      style="
        left: ${stage.position.x}px;
        top: ${stage.position.y}px;
        --stage-color: ${config.color};
        --stage-bg: ${config.bgColor};
      "
      data-stage-id=${stage.id}
      draggable="true"
      @click=${(e: MouseEvent) => {
        e.stopPropagation();
        if (_connectingFrom && _connectingFrom !== stage.id) {
          onConnectStages(_connectingFrom, stage.id);
          _connectingFrom = null;
          requestUpdate();
        } else {
          onSelectStage(isSelected ? null : stage.id);
        }
      }}
      @dragstart=${(e: DragEvent) => handleNodeDragStart(e, stage)}
      @dragend=${(e: DragEvent) => handleNodeDragEnd(e, stage, onMoveStage, requestUpdate)}
    >
      <!-- Stage Header -->
      <div class="funnel-stage-node__header">
        <span class="funnel-stage-node__icon">${config.icon}</span>
        <span class="funnel-stage-node__type" style="color: ${config.color}">${config.label}</span>
        <div class="funnel-stage-node__health" title="Stage Health: ${stage.health}">
          ${renderHealthIndicator(stage.health)}
        </div>
      </div>

      <!-- Stage Name -->
      <div class="funnel-stage-node__name">${stage.name}</div>

      <!-- Stage Description.
           Templates ship a description per stage (e.g. "Reels, carousels,
           thought leadership") via the funnels.stage.add RPC; the canvas
           previously dropped it on the floor, which made template funnels
           look as sparse as bare defaults. Clamped to 2 lines so the
           node doesn't grow unbounded on long copy. -->
      ${stage.description && stage.description.trim() ? html`
        <div class="funnel-stage-node__description" title=${stage.description}>
          ${stage.description}
        </div>
      ` : nothing}

      <!-- KPI Badges -->
      ${stage.kpis.length > 0 ? html`
        <div class="funnel-stage-node__kpis">
          ${stage.kpis.slice(0, 2).map(kpi => html`
            <div class="funnel-stage-node__kpi">
              <span class="funnel-stage-node__kpi-value">${formatKPIValue(kpi)}</span>
              <span class="funnel-stage-node__kpi-label">${kpi.label}</span>
              ${kpi.trend ? html`
                <span class="funnel-stage-node__kpi-trend ${kpi.trend}">
                  ${kpi.trend === "up" ? "↑" : kpi.trend === "down" ? "↓" : "→"}
                </span>
              ` : nothing}
            </div>
          `)}
        </div>
      ` : nothing}

      <!-- Conversion Rate -->
      ${stage.conversionRate !== undefined ? html`
        <div class="funnel-stage-node__conversion">
          <div class="funnel-stage-node__conversion-bar" style="width: ${stage.conversionRate}%"></div>
          <span class="funnel-stage-node__conversion-label">${stage.conversionRate}% conversion</span>
        </div>
      ` : nothing}

      <!-- Quick Actions -->
      <div class="funnel-stage-node__actions">
        <button class="funnel-stage-node__action" 
          @click=${(e: MouseEvent) => { e.stopPropagation(); _connectingFrom = stage.id; requestUpdate(); }}
          title="Connect to another stage">
          ${icons.link}
        </button>
        <button class="funnel-stage-node__action" 
          @click=${(e: MouseEvent) => { e.stopPropagation(); onSelectStage(stage.id); }}
          title="Edit stage">
          ${icons.edit}
        </button>
        <button class="funnel-stage-node__action danger" 
          @click=${(e: MouseEvent) => { e.stopPropagation(); onDeleteStage(stage.id); }}
          title="Delete stage">
          ${icons.trash}
        </button>
      </div>

      <!-- Connection Handles -->
      <div class="funnel-stage-node__handle funnel-stage-node__handle--left"></div>
      <div class="funnel-stage-node__handle funnel-stage-node__handle--right"></div>
    </div>
  `;
}

function renderHealthIndicator(health: "healthy" | "warning" | "critical"): TemplateResult {
  const colors = {
    healthy: "var(--ok, #22c55e)",
    warning: "var(--warn, #f59e0b)",
    critical: "var(--destructive, #ef4444)",
  };
  const labels = {
    healthy: "●",
    warning: "●",
    critical: "●",
  };
  return html`<span style="color: ${colors[health]}">${labels[health]}</span>`;
}

function formatKPIValue(kpi: StageKPI): string {
  if (kpi.unit === "$") return `$${kpi.value.toLocaleString()}`;
  if (kpi.unit === "%") return `${kpi.value}%`;
  if (kpi.value >= 1000000) return `${(kpi.value / 1000000).toFixed(1)}M`;
  if (kpi.value >= 1000) return `${(kpi.value / 1000).toFixed(1)}K`;
  return kpi.value.toString();
}

// ══════════════════════════════════════════════════════════════════════════════
// Connections Rendering
// ══════════════════════════════════════════════════════════════════════════════

function renderConnections(funnel: Funnel, selectedStageId: string | null, onDeleteConnection: (id: string) => void): TemplateResult {
  return html`
    ${funnel.connections.map(conn => {
      const sourceStage = funnel.stages.find(s => s.id === conn.source);
      const targetStage = funnel.stages.find(s => s.id === conn.target);
      if (!sourceStage || !targetStage) return nothing;

      const startX = sourceStage.position.x + 280; // Right side of node
      const startY = sourceStage.position.y + 60; // Middle height
      const endX = targetStage.position.x;
      const endY = targetStage.position.y + 60;

      // Bezier curve control points
      const midX = (startX + endX) / 2;
      const path = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;

      const isHighlighted = selectedStageId === conn.source || selectedStageId === conn.target;

      return html`
        <g class="funnel-connection ${isHighlighted ? 'highlighted' : ''}" data-connection-id=${conn.id}>
          <!-- Shadow path for wider click area -->
          <path d=${path} fill="none" stroke="transparent" stroke-width="20" 
            style="cursor: pointer; pointer-events: stroke;"
            @click=${() => onDeleteConnection(conn.id)}/>
          <!-- Visible path -->
          <path d=${path} fill="none" 
            stroke=${isHighlighted ? "var(--info, #3b82f6)" : "color-mix(in srgb, var(--g-fg) 30%, transparent)"} 
            stroke-width=${isHighlighted ? 3 : 2}
            marker-end="url(#arrowhead)"
            style="pointer-events: none;"/>
          <!-- Conversion rate label -->
          ${conn.conversionRate !== undefined ? html`
            <text x=${midX} y=${(startY + endY) / 2 - 8} 
              fill="color-mix(in srgb, var(--g-fg) 70%, transparent)" 
              font-size="11" 
              text-anchor="middle"
              style="pointer-events: none;">
              ${conn.conversionRate}%
            </text>
          ` : nothing}
        </g>
      `;
    })}
    <!-- Arrow marker definition -->
    <defs>
      <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
        <polygon points="0 0, 10 3.5, 0 7" fill="color-mix(in srgb, var(--g-fg) 50%, transparent)"/>
      </marker>
    </defs>
  `;
}

function renderConnectingLine(funnel: Funnel): TemplateResult {
  const sourceStage = funnel.stages.find(s => s.id === _connectingFrom);
  if (!sourceStage) return html``;

  const startX = sourceStage.position.x + 280;
  const startY = sourceStage.position.y + 60;
  const endX = (_mousePos.x - _canvasPan.x) / _canvasZoom;
  const endY = (_mousePos.y - _canvasPan.y) / _canvasZoom;

  return html`
    <path 
      d="M ${startX} ${startY} L ${endX} ${endY}"
      fill="none" 
      stroke="var(--info, #3b82f6)" 
      stroke-width="2"
      stroke-dasharray="5,5"
      style="pointer-events: none;"/>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Minimap
// ══════════════════════════════════════════════════════════════════════════════

function renderMinimap(funnel: Funnel, requestUpdate: () => void): TemplateResult {
  const minimapScale = 0.08;
  const minimapWidth = 180;
  const minimapHeight = 120;

  // Calculate bounds of all stages
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  funnel.stages.forEach(s => {
    minX = Math.min(minX, s.position.x);
    minY = Math.min(minY, s.position.y);
    maxX = Math.max(maxX, s.position.x + 280);
    maxY = Math.max(maxY, s.position.y + 120);
  });

  const contentWidth = maxX - minX + 100;
  const contentHeight = maxY - minY + 100;
  const scale = Math.min(minimapWidth / contentWidth, minimapHeight / contentHeight, minimapScale);

  return html`
    <div class="funnel-canvas__minimap">
      <svg width="${minimapWidth}" height="${minimapHeight}">
        <!-- Stage nodes -->
        ${funnel.stages.map(stage => {
          const config = STAGE_TYPE_CONFIG[stage.type];
          return html`
            <rect 
              x=${(stage.position.x - minX + 50) * scale}
              y=${(stage.position.y - minY + 50) * scale}
              width=${280 * scale}
              height=${100 * scale}
              fill=${config.bgColor}
              stroke=${config.color}
              stroke-width="1"
              rx="2"/>
          `;
        })}
        <!-- Viewport indicator -->
        <rect 
          x=${(-_canvasPan.x / _canvasZoom - minX + 50) * scale}
          y=${(-_canvasPan.y / _canvasZoom - minY + 50) * scale}
          width=${(window.innerWidth / _canvasZoom) * scale}
          height=${(window.innerHeight / _canvasZoom) * scale}
          fill="rgba(59, 130, 246, 0.2)"
          stroke="var(--info, #3b82f6)"
          stroke-width="1"/>
      </svg>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Event Handlers
// ══════════════════════════════════════════════════════════════════════════════

function handleWheel(e: WheelEvent, requestUpdate: () => void) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  _canvasZoom = Math.max(0.25, Math.min(2, _canvasZoom + delta));
  requestUpdate();
}

function handleCanvasMouseDown(e: MouseEvent, requestUpdate: () => void) {
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    _isDragging = true;
    _dragStart = { x: e.clientX - _canvasPan.x, y: e.clientY - _canvasPan.y };
    requestUpdate();
  }
}

function handleCanvasMouseMove(e: MouseEvent, requestUpdate: () => void) {
  _mousePos = { x: e.clientX, y: e.clientY };
  
  if (_isDragging) {
    _canvasPan = { x: e.clientX - _dragStart.x, y: e.clientY - _dragStart.y };
    requestUpdate();
  } else if (_connectingFrom) {
    requestUpdate();
  }
}

function handleCanvasMouseUp(e: MouseEvent, requestUpdate: () => void) {
  if (_isDragging) {
    _isDragging = false;
    requestUpdate();
  }
}

function handleNodeDragStart(e: DragEvent, stage: FunnelStage) {
  if (e.dataTransfer) {
    e.dataTransfer.setData("text/plain", JSON.stringify({ type: "moveStage", stageId: stage.id }));
    e.dataTransfer.effectAllowed = "move";
  }
}

function handleNodeDragEnd(e: DragEvent, stage: FunnelStage, onMoveStage: (id: string, pos: { x: number; y: number }) => void, requestUpdate: () => void) {
  const rect = (e.target as HTMLElement).closest('.funnel-canvas')?.getBoundingClientRect();
  if (!rect) return;

  const x = (e.clientX - rect.left - _canvasPan.x) / _canvasZoom;
  const y = (e.clientY - rect.top - _canvasPan.y) / _canvasZoom;

  onMoveStage(stage.id, { x: Math.max(0, x - 140), y: Math.max(0, y - 60) });
  requestUpdate();
}

function handleDrop(e: DragEvent, onAddStage: (type: FunnelStageType, position: { x: number; y: number }) => void, requestUpdate: () => void) {
  e.preventDefault();
  const data = e.dataTransfer?.getData("text/plain");
  if (!data) return;

  try {
    const parsed = JSON.parse(data);
    if (parsed.type === "addStage" && parsed.stageType) {
      const rect = (e.target as HTMLElement).closest('.funnel-canvas')?.getBoundingClientRect();
      if (!rect) return;

      const x = (e.clientX - rect.left - _canvasPan.x) / _canvasZoom;
      const y = (e.clientY - rect.top - _canvasPan.y) / _canvasZoom;

      onAddStage(parsed.stageType, { x: Math.max(0, x - 140), y: Math.max(0, y - 50) });
      requestUpdate();
    }
  } catch (err) {
    console.error("Failed to parse drop data:", err);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Export canvas state controls
// ══════════════════════════════════════════════════════════════════════════════

export function resetCanvasView() {
  _canvasZoom = 1;
  _canvasPan = { x: 0, y: 0 };
  _connectingFrom = null;
  _selectedNodeId = null;
}

export function cancelConnecting() {
  _connectingFrom = null;
}

export function isConnecting(): boolean {
  return _connectingFrom !== null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

const canvasStyles = `
  .funnel-canvas {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--g-surface);
    overflow: hidden;
    cursor: grab;
  }

  .funnel-canvas:active {
    cursor: grabbing;
  }

  .funnel-canvas__grid {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .funnel-canvas__content {
    position: absolute;
    top: 0;
    left: 0;
    width: 2000px;
    height: 2000px;
  }

  .funnel-canvas__controls {
    position: absolute;
    bottom: 16px;
    left: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(30, 30, 30, 0.95);
    border: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 8px;
    padding: 6px 10px;
    backdrop-filter: blur(8px);
  }

  .funnel-canvas__control-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--g-fg) 70%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-canvas__control-btn:hover {
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    color: white;
  }

  .funnel-canvas__control-btn.active {
    background: color-mix(in srgb, var(--glass-gold) 20%, transparent);
    color: var(--info, var(--glass-gold));
  }

  .funnel-canvas__control-btn svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  .funnel-canvas__zoom-level {
    font-size: 12px;
    color: color-mix(in srgb, var(--g-fg) 60%, transparent);
    min-width: 40px;
    text-align: center;
  }

  .funnel-canvas__minimap {
    position: absolute;
    bottom: 16px;
    right: 16px;
    background: rgba(30, 30, 30, 0.95);
    border: 1px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 8px;
    padding: 8px;
    backdrop-filter: blur(8px);
  }

  .funnel-canvas__connecting-indicator {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: color-mix(in srgb, var(--glass-gold) 90%, transparent);
    color: white;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    backdrop-filter: blur(8px);
  }

  /* Stage Node Styles */
  .funnel-stage-node {
    position: absolute;
    width: 280px;
    min-height: 100px;
    background: var(--stage-bg);
    border: 2px solid var(--stage-color);
    border-radius: 12px;
    padding: 12px;
    cursor: pointer;
    transition: all 0.2s ease;
    user-select: none;
  }

  .funnel-stage-node:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  .funnel-stage-node.selected {
    border-color: var(--info, var(--glass-gold));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--glass-gold) 30%, transparent);
  }

  .funnel-stage-node.connecting-mode {
    cursor: crosshair;
  }

  .funnel-stage-node.connecting-source {
    border-color: var(--info, var(--glass-gold));
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--glass-gold) 30%, transparent); }
    50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--glass-gold) 10%, transparent); }
  }

  .funnel-stage-node__header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  .funnel-stage-node__icon {
    font-size: 18px;
  }

  .funnel-stage-node__type {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .funnel-stage-node__health {
    margin-left: auto;
    font-size: 12px;
  }

  .funnel-stage-node__name {
    font-size: 15px;
    font-weight: 600;
    color: white;
    margin-bottom: 6px;
  }

  /* Stage description — 2-line clamp keeps the node compact at scale
     while still giving the eye something to read beyond the bare name.
     Italic faint tone differentiates it from the type label above. */
  .funnel-stage-node__description {
    font-size: 11.5px;
    line-height: 1.42;
    color: var(--glass-fg-2);
    font-style: italic;
    margin-bottom: 10px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-clamp: 2;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .funnel-stage-node__kpis {
    display: flex;
    gap: 12px;
    margin-bottom: 10px;
  }

  .funnel-stage-node__kpi {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .funnel-stage-node__kpi-value {
    font-size: 16px;
    font-weight: 700;
    color: white;
  }

  .funnel-stage-node__kpi-label {
    font-size: 10px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    text-transform: uppercase;
  }

  .funnel-stage-node__kpi-trend {
    font-size: 12px;
  }

  .funnel-stage-node__kpi-trend.up { color: var(--ok, #22c55e); }
  .funnel-stage-node__kpi-trend.down { color: var(--destructive, #ef4444); }
  .funnel-stage-node__kpi-trend.flat { color: var(--warn, #f59e0b); }

  .funnel-stage-node__conversion {
    position: relative;
    height: 4px;
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-radius: 2px;
    margin-bottom: 10px;
  }

  .funnel-stage-node__conversion-bar {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    background: var(--stage-color);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .funnel-stage-node__conversion-label {
    position: absolute;
    right: 0;
    top: 8px;
    font-size: 10px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
  }

  .funnel-stage-node__actions {
    display: flex;
    gap: 6px;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .funnel-stage-node:hover .funnel-stage-node__actions {
    opacity: 1;
  }

  .funnel-stage-node__action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: color-mix(in srgb, var(--g-fg) 10%, transparent);
    border: none;
    border-radius: 4px;
    color: color-mix(in srgb, var(--g-fg) 70%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnel-stage-node__action:hover {
    background: color-mix(in srgb, var(--g-fg) 20%, transparent);
    color: white;
  }

  .funnel-stage-node__action.danger:hover {
    background: rgba(239, 68, 68, 0.2);
    color: var(--destructive, #ef4444);
  }

  .funnel-stage-node__action svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    stroke-width: 2;
    fill: none;
  }

  /* Connection Handles */
  .funnel-stage-node__handle {
    position: absolute;
    width: 10px;
    height: 10px;
    background: var(--stage-color);
    border: 2px solid white;
    border-radius: 50%;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .funnel-stage-node:hover .funnel-stage-node__handle,
  .funnel-stage-node.connecting-mode .funnel-stage-node__handle {
    opacity: 1;
  }

  .funnel-stage-node__handle--left {
    left: -6px;
    top: 50%;
    transform: translateY(-50%);
  }

  .funnel-stage-node__handle--right {
    right: -6px;
    top: 50%;
    transform: translateY(-50%);
  }

  /* Connection Lines */
  .funnel-connection path {
    transition: stroke 0.2s ease, stroke-width 0.2s ease;
  }

  .funnel-connection.highlighted path {
    stroke: var(--info, var(--glass-gold)) !important;
    stroke-width: 3 !important;
  }

  /* Empty & Loading States */
  .funnel-canvas-empty,
  .funnel-canvas-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    gap: 12px;
  }

  .funnel-canvas-empty__icon {
    font-size: 48px;
    margin-bottom: 8px;
  }

  .funnel-canvas-empty h3 {
    font-size: 18px;
    color: white;
    margin: 0;
  }

  .funnel-canvas-empty p {
    font-size: 14px;
    margin: 0;
  }

  .funnel-canvas-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid color-mix(in srgb, var(--g-fg) 10%, transparent);
    border-top-color: var(--info, var(--glass-gold));
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;
