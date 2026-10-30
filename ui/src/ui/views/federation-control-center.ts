/**
 * Federation Control Center
 *
 * Comprehensive federation management dashboard with:
 * - Fleet Overview (all nodes in a grid)
 * - MCP Registry (all MCP servers with test/details)
 * - Resource Monitor (CPU/RAM/GPU per node)
 * - Session Distribution (sessions across nodes)
 * - State Sync Status (sync status for memory, kanban, etc.)
 * - Capability Matrix (visual grid of node capabilities)
 * - Node Management (add/remove/configure nodes)
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons";
import type { FederationState, FederationNode, NodeCapabilities } from "../controllers/federation";
import {
  renderNetworkPanel,
  type NetworkPanelState,
} from "./network-control-panel";
import type {
  FederationResourcesState,
  NodeGatewayInfo,
  FederatedMCP,
  FederatedAgent,
} from "../controllers/federation-resources";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface NodeLoadMetrics {
  nodeId: string;
  cpuPercent: number;
  memoryPercent: number;
  gpuPercent?: number;
  loadScore: number;
  activeSessions: number;
  lastUpdate: number;
}

export interface NodeVersionInfo {
  nodeId: string;
  nodeName: string;
  isLocal: boolean;
  isMaster: boolean;
  status: "online" | "offline";
  version: string;
  buildTime: string | null;
  gitCommit: string | null;
  lastUpdated: number | null;
  updateAvailable: boolean;
}

export interface UpdateState {
  loading: boolean;
  nodeVersions: NodeVersionInfo[];
  latestVersion: string | null;
  updateInProgress: Map<string, UpdateProgress>;
  lastCheck: number | null;
}

export interface UpdateProgress {
  nodeId: string;
  status: "pending" | "pulling" | "installing" | "building" | "restarting" | "complete" | "error";
  progress: number;
  currentStep: string;
  error?: string;
}

export interface SessionInfo {
  id: string;
  sessionKey: string;
  nodeId: string;
  nodeName: string;
  agentId: string;
  channel: string;
  tokens: number;
  lastActive: number;
  status: "active" | "idle" | "finishing";
}

export interface StateSyncItem {
  category: string;
  icon: string;
  status: "synced" | "pending" | "conflict" | "error";
  lastSync: number;
  pendingCount?: number;
}

// Service Discovery Types
export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: "running" | "exited" | "paused" | "created";
  ports: Array<{ hostPort: number; containerPort: number; protocol: string }>;
  created: string;
  networks: string[];
}

export interface FederationService {
  id: string;
  name: string;
  type: "docker" | "directory" | "api";
  nodeId: string;
  containerId?: string;
  containerName?: string;
  path?: string;
  baseUrl?: string;
  docsUrl?: string;
  ports?: number[];
  protocol?: string;
  capabilities?: string[];
  mcpServerId?: string;
  mcpStatus?: "none" | "building" | "built" | "error";
  mcpError?: string;
  exposed: boolean;
  exposedTo?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ServiceDiscoveryState {
  loading: boolean;
  dockerContainers: DockerContainer[];
  services: FederationService[];
  lastScan: number | null;
  addingDirectory: boolean;
  directoryPath: string;
  selectedNodeForScan: string | null;
}

export interface ControlCenterProps {
  federationState: FederationState;
  resourcesState: FederationResourcesState;
  loadMetrics: Map<string, NodeLoadMetrics>;
  sessions: SessionInfo[];
  syncItems: StateSyncItem[];
  vectorClock: Record<string, number>;
  conflictCount: number;
  
  // Update state
  updateState?: UpdateState;

  // Service discovery state
  serviceState?: ServiceDiscoveryState;

  /**
   * Optional Tailscale / network exposure panel state. When present, the
   * "Network & Access" section renders with serve/funnel toggles.
   */
  networkState?: NetworkPanelState;
  onRefreshNetwork?: () => void;
  onEnableNetwork?: (mode: "serve" | "funnel") => void;
  onDisableNetwork?: (mode: "serve" | "funnel" | "both") => void;

  // Actions
  onRefresh: () => void;
  onSyncAll: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onTestMCP: (mcpId: string, nodeId: string) => void;
  onMCPDetails: (mcpId: string, nodeId: string) => void;
  onMigrateSession: (sessionId: string, targetNodeId: string) => void;
  onKillSession: (sessionId: string) => void;
  onAddNode: (url: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onWakeNode: (nodeId: string) => void;
  onPingNode: (nodeId: string) => void;
  onConfigureNode: (nodeId: string) => void;
  onScanNetwork: () => void;
  onForceSyncItem: (category: string) => void;
  /**
   * Optional: link a connected federation node as an SSH device so the
   * agentic `ssh_devices` tool and the SSH Devices UI can target it.
   * Calls `federation.node.linkSshDevice` under the hood.
   */
  onLinkSshDevice?: (params: {
    nodeId: string;
    username: string;
    password?: string;
    privateKey?: string;
    host?: string;
    port?: number;
    setActive?: boolean;
  }) => void;
  
  // Update Actions
  onCheckForUpdates?: () => void;
  onUpdateNode?: (nodeId: string, actions: { gitPull?: boolean; build?: boolean; restart?: boolean }) => void;
  onUpdateAllNodes?: () => void;
  
  // Service Discovery Actions
  onScanDocker?: (nodeId?: string) => void;
  onAddDirectory?: (path: string, nodeId?: string) => void;
  onRegisterService?: (container: DockerContainer, nodeId: string) => void;
  onExposeService?: (serviceId: string, exposed: boolean, exposedTo?: string[]) => void;
  onBuildMCP?: (serviceId: string) => void;
  onDeleteService?: (serviceId: string) => void;
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Render
// ══════════════════════════════════════════════════════════════════════════════

export function renderFederationControlCenter(props: ControlCenterProps): TemplateResult {
  const { federationState, resourcesState } = props;
  const onlineCount = federationState.nodes.filter((n) => n.status === "online").length;
  const totalCount = federationState.nodes.length;
  const sessionCount = props.sessions.length;

  return html`
    <div class="federation-control-center">
      ${renderControlCenterStyles()}

      <!-- Header -->
      <header class="fcc-header">
        <div class="fcc-header-left">
          <h1>${icons.globe} Federation Control Center</h1>
          <div class="fcc-status-bar">
            <span class="fcc-status-item">
              <span class="fcc-status-dot ${federationState.connectionStatus === "connected" ? "online" : "offline"}"></span>
              Mode: <strong>${federationState.mode}</strong>
            </span>
            <span class="fcc-status-divider">│</span>
            <span class="fcc-status-item">
              Nodes: <strong>${onlineCount}/${totalCount}</strong>
            </span>
            <span class="fcc-status-divider">│</span>
            <span class="fcc-status-item">
              Sessions: <strong>${sessionCount}</strong>
            </span>
            <span class="fcc-status-divider">│</span>
            <span class="fcc-status-item">
              MCPs: <strong>${resourcesState.mcpServers.length}</strong>
            </span>
          </div>
        </div>
        <div class="fcc-header-actions">
          <button class="fcc-btn fcc-btn--outline" @click=${props.onRefresh}>
            ${icons.refresh} Refresh
          </button>
          <button class="fcc-btn fcc-btn--primary" @click=${props.onSyncAll}>
            ${icons.refresh} Sync All
          </button>
        </div>
      </header>

      <!-- Dashboard Grid -->
      <div class="fcc-grid">
        <!-- Fleet Overview - Full Width -->
        <section class="fcc-panel fcc-panel--full fleet-overview">
          ${renderFleetOverview(props)}
        </section>

        <!-- System Updates - Full Width -->
        <section class="fcc-panel fcc-panel--full system-updates">
          ${renderUpdatePanel(props)}
        </section>

        <!-- MCP Registry -->
        <section class="fcc-panel mcp-registry">
          ${renderMCPRegistry(props)}
        </section>

        <!-- Resource Monitor -->
        <section class="fcc-panel resource-monitor">
          ${renderResourceMonitor(props)}
        </section>

        <!-- Session Distribution -->
        <section class="fcc-panel session-distribution">
          ${renderSessionDistribution(props)}
        </section>

        <!-- State Sync Status -->
        <section class="fcc-panel state-sync">
          ${renderStateSyncStatus(props)}
        </section>

        <!-- Service Discovery - Full Width -->
        <section class="fcc-panel fcc-panel--full service-discovery">
          ${renderServiceDiscovery(props)}
        </section>

        ${props.networkState
          ? html`
              <section class="fcc-panel fcc-panel--full network-access">
                ${renderNetworkPanel({
                  state: props.networkState,
                  onRefresh: () => props.onRefreshNetwork?.(),
                  onEnable: (mode) => props.onEnableNetwork?.(mode),
                  onDisable: (mode) => props.onDisableNetwork?.(mode),
                })}
              </section>
            `
          : nothing}

        <!-- Capability Matrix -->
        <section class="fcc-panel capability-matrix">
          ${renderCapabilityMatrix(props)}
        </section>

        <!-- Node Management -->
        <section class="fcc-panel node-management">
          ${renderNodeManagement(props)}
        </section>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Fleet Overview Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderFleetOverview(props: ControlCenterProps): TemplateResult {
  const { federationState, resourcesState, loadMetrics } = props;

  return html`
    <div class="fcc-panel-header">
      <h2>${icons.monitor} Fleet Overview</h2>
      <span class="fcc-panel-subtitle">${federationState.nodes.length} nodes in federation</span>
    </div>
    <div class="fcc-panel-content">
      ${federationState.nodes.length === 0
        ? html`
            <div class="fcc-empty">
              <span class="fcc-empty-icon">${icons.link}</span>
              <span class="fcc-empty-text">No nodes connected</span>
              <span class="fcc-empty-hint">Add a node or scan the network to get started</span>
            </div>
          `
        : html`
            <div class="fleet-grid">
              ${federationState.nodes.map((node) => renderNodeCard(node, props, loadMetrics.get(node.id)))}
            </div>
          `}
    </div>
  `;
}

function renderNodeCard(
  node: FederationNode,
  props: ControlCenterProps,
  metrics?: NodeLoadMetrics
): TemplateResult {
  const isOnline = node.status === "online";
  const isLocal = node.isLocal;
  const isSelected = props.resourcesState.selectedNodeId === node.id;

  // Get node icon based on platform
  const nodeIcon = getNodeIcon(node.platform);

  // Get MCP count for this node
  const mcpCount = props.resourcesState.mcpServers.filter((m) => m.nodeId === node.id).length;
  const sessionCount = props.sessions.filter((s) => s.nodeId === node.id).length;

  return html`
    <div
      class="fleet-node-card ${isOnline ? "online" : "offline"} ${isSelected ? "selected" : ""} ${isLocal ? "local" : ""}"
      @click=${() => props.onSelectNode(node.id)}
    >
      <div class="fleet-node-header">
        <span class="fleet-node-icon">${nodeIcon}</span>
        <span class="fleet-node-name">${node.name}</span>
      </div>

      <div class="fleet-node-status">
        <span class="fleet-status-dot ${isOnline ? "online" : "offline"}"></span>
        <span class="fleet-status-text">${isOnline ? "Online" : "Offline"}</span>
      </div>

      <div class="fleet-node-role">
        <span class="fleet-role-badge ${node.role}">${node.role === "master" ? "Master" : "Satellite"}</span>
        ${isLocal ? html`<span class="fleet-local-badge">This Node</span>` : nothing}
      </div>

      ${isOnline && metrics
        ? html`
            <div class="fleet-node-resources">
              ${renderResourceBar("CPU", metrics.cpuPercent)}
              ${renderResourceBar("RAM", metrics.memoryPercent)}
              ${metrics.gpuPercent !== undefined ? renderResourceBar("GPU", metrics.gpuPercent) : nothing}
            </div>
          `
        : !isOnline && node.lastSeen
          ? html`
              <div class="fleet-node-lastseen">
                Last: ${formatRelativeTime(node.lastSeen)}
              </div>
            `
          : nothing}

      <div class="fleet-node-stats">
        <span class="fleet-stat">${icons.messageSquare} ${sessionCount}</span>
        <span class="fleet-stat">${icons.wrench} ${mcpCount}</span>
        ${node.latency ? html`<span class="fleet-stat">${icons.clock} ${node.latency}ms</span>` : nothing}
      </div>
    </div>
  `;
}

function renderResourceBar(label: string, percent: number): TemplateResult {
  const color = getLoadColor(percent);
  const width = Math.min(100, Math.max(0, percent));
  const barChars = Math.round(width / 20); // 5 chars max

  return html`
    <div class="fleet-resource-row">
      <span class="fleet-resource-label">${label}:</span>
      <span class="fleet-resource-value">${Math.round(percent)}%</span>
      <div class="fleet-resource-bar">
        <div class="fleet-resource-fill" style="width: ${width}%; background: ${color}"></div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. System Updates Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderUpdatePanel(props: ControlCenterProps): TemplateResult {
  const { updateState, federationState } = props;
  const nodeVersions = updateState?.nodeVersions ?? [];
  const latestVersion = updateState?.latestVersion;
  const loading = updateState?.loading ?? false;
  const updateInProgress = updateState?.updateInProgress ?? new Map();

  // If no update state, generate placeholder from federation state
  const displayNodes: NodeVersionInfo[] = nodeVersions.length > 0
    ? nodeVersions
    : [
        {
          nodeId: "local",
          nodeName: federationState.nodes.find((n) => n.isLocal)?.name ?? "This Node",
          isLocal: true,
          isMaster: federationState.mode === "master",
          status: "online",
          version: "loading...",
          buildTime: null,
          gitCommit: null,
          lastUpdated: null,
          updateAvailable: false,
        },
        ...federationState.nodes
          .filter((n) => !n.isLocal)
          .map((n) => ({
            nodeId: n.id,
            nodeName: n.name,
            isLocal: false,
            isMaster: false,
            status: n.status as "online" | "offline",
            version: "unknown",
            buildTime: null,
            gitCommit: null,
            lastUpdated: null,
            updateAvailable: false,
          })),
      ];

  return html`
    <div class="fcc-panel-header">
      <h2>${icons.refresh} System Updates</h2>
      <div class="update-header-actions">
        ${latestVersion ? html`<span class="update-latest-badge">Latest: ${latestVersion}</span>` : nothing}
        <button
          class="fcc-btn fcc-btn--sm fcc-btn--outline"
          ?disabled=${loading}
          @click=${props.onCheckForUpdates}
        >
          ${loading ? "Checking..." : html`${icons.refresh} Check Updates`}
        </button>
      </div>
    </div>
    <div class="fcc-panel-content">
      ${displayNodes.length === 0
        ? html`
            <div class="fcc-empty-sm">
              <span>No nodes to update</span>
            </div>
          `
        : html`
            <div class="update-nodes-list">
              ${displayNodes.map((node) => renderUpdateNodeRow(node, props, updateInProgress.get(node.nodeId)))}
            </div>
            
            <!-- Fleet-wide actions -->
            <div class="update-fleet-actions">
              <button
                class="fcc-btn fcc-btn--primary"
                ?disabled=${loading || displayNodes.every((n) => n.status === "offline" || !n.updateAvailable)}
                @click=${props.onUpdateAllNodes}
              >
                ${icons.refresh} Update All Online Nodes
              </button>
            </div>
          `}
    </div>
  `;
}

function renderUpdateNodeRow(
  node: NodeVersionInfo,
  props: ControlCenterProps,
  progress?: UpdateProgress
): TemplateResult {
  const isOnline = node.status === "online";
  const hasUpdate = node.updateAvailable;
  const isUpdating = progress && progress.status !== "complete" && progress.status !== "error";

  // Determine status display
  let statusIcon: TemplateResult | string = icons.checkCircle;
  let statusText = "Up to date";
  let statusClass = "current";

  if (!isOnline) {
    statusIcon = "○";
    statusText = "Offline";
    statusClass = "offline";
  } else if (isUpdating) {
    statusIcon = icons.clock;
    statusText = progress?.currentStep ?? "Updating...";
    statusClass = "updating";
  } else if (progress?.status === "error") {
    statusIcon = icons.xCircle;
    statusText = progress.error ?? "Update failed";
    statusClass = "error";
  } else if (hasUpdate) {
    statusIcon = icons.alert;
    statusText = "Update available";
    statusClass = "outdated";
  }

  return html`
    <div class="update-node-row ${isOnline ? "online" : "offline"} ${isUpdating ? "updating" : ""}">
      <div class="update-node-info">
        <div class="update-node-header">
          <span class="update-node-name">
            ${node.nodeName}
            ${node.isLocal ? html`<span class="update-node-local">(This Node)</span>` : nothing}
            ${node.isMaster ? html`<span class="update-node-master">Master</span>` : nothing}
          </span>
          <span class="update-node-status ${isOnline ? "online" : "offline"}">
            ${isOnline ? "●" : "○"} ${isOnline ? "Online" : "Offline"}
          </span>
        </div>
        
        <div class="update-node-version">
          <span class="update-version-badge ${statusClass}">
            v${node.version}
          </span>
          ${node.gitCommit ? html`<span class="update-commit">${node.gitCommit}</span>` : nothing}
          <span class="update-status ${statusClass}">
            ${statusIcon} ${statusText}
          </span>
        </div>

        ${isUpdating && progress
          ? html`
              <div class="update-progress">
                <div class="update-progress-bar">
                  <div class="update-progress-fill" style="width: ${progress.progress}%"></div>
                </div>
                <div class="update-progress-steps">
                  ${renderUpdateSteps(progress)}
                </div>
              </div>
            `
          : nothing}
      </div>

      <div class="update-node-actions">
        ${node.isLocal
          ? html`
              <!-- Local node: individual actions -->
              <button
                class="update-action-btn"
                ?disabled=${!isOnline || isUpdating}
                @click=${() => props.onUpdateNode?.(node.nodeId, { gitPull: true })}
                title="Git Pull"
              >
                Git Pull
              </button>
              <button
                class="update-action-btn"
                ?disabled=${!isOnline || isUpdating}
                @click=${() => props.onUpdateNode?.(node.nodeId, { build: true })}
                title="Build"
              >
                Build
              </button>
              <button
                class="update-action-btn warning"
                ?disabled=${!isOnline || isUpdating}
                @click=${() => props.onUpdateNode?.(node.nodeId, { restart: true })}
                title="Restart Gateway"
              >
                Restart
              </button>
            `
          : html`
              <!-- Remote node: combined update -->
              <button
                class="update-action-btn primary"
                ?disabled=${!isOnline || isUpdating}
                @click=${() => props.onUpdateNode?.(node.nodeId, { gitPull: true, build: true, restart: true })}
                title="Update this node"
              >
                Update Now
              </button>
            `}
      </div>
    </div>
  `;
}

function renderUpdateSteps(progress: UpdateProgress): TemplateResult {
  const steps = [
    { id: "pulling", label: "Git Pull" },
    { id: "installing", label: "Install" },
    { id: "building", label: "Build" },
    { id: "restarting", label: "Restart" },
  ];

  const statusOrder = ["pending", "pulling", "installing", "building", "restarting", "complete", "error"];
  const currentIndex = statusOrder.indexOf(progress.status);

  return html`
    ${steps.map((step, i) => {
      const stepIndex = statusOrder.indexOf(step.id);
      let stepClass = "pending";
      let stepIcon: TemplateResult | string = "○";

      if (progress.status === "error" && stepIndex === currentIndex - 1) {
        stepClass = "error";
        stepIcon = icons.xCircle;
      } else if (stepIndex < currentIndex) {
        stepClass = "complete";
        stepIcon = icons.checkCircle;
      } else if (stepIndex === currentIndex) {
        stepClass = "active";
        stepIcon = icons.clock;
      }

      return html`
        <span class="update-step ${stepClass}">
          ${stepIcon} ${step.label}
        </span>
        ${i < steps.length - 1 ? html`<span class="update-step-connector">→</span>` : nothing}
      `;
    })}
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. MCP Registry Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderMCPRegistry(props: ControlCenterProps): TemplateResult {
  const { resourcesState } = props;
  const mcps = resourcesState.mcpServers;

  return html`
    <div class="fcc-panel-header">
      <h2>${icons.plug} MCP Servers</h2>
      <button class="fcc-btn fcc-btn--sm fcc-btn--outline" @click=${props.onRefresh}>
        Refresh
      </button>
    </div>
    <div class="fcc-panel-content">
      ${mcps.length === 0
        ? html`
            <div class="fcc-empty-sm">
              <span>No MCP servers found</span>
            </div>
          `
        : html`
            <div class="mcp-list">
              ${mcps.map((mcp) => renderMCPRow(mcp, props))}
            </div>
          `}
    </div>
  `;
}

function renderMCPRow(mcp: FederatedMCP, props: ControlCenterProps): TemplateResult {
  const isOnline = mcp.status === "running" || mcp.status === "configured";
  const toolCount = mcp.tools.length;
  const isLocal = mcp.nodeId === "local";
  // Source badge for local MCPs (extract from extended mcp data)
  const source = (mcp as FederatedMCP & { source?: string }).source;

  return html`
    <div class="mcp-row">
      <span class="mcp-status-dot ${isOnline ? "online" : "offline"}"></span>
      <div class="mcp-name-col">
        <span class="mcp-name">${mcp.name}</span>
        ${mcp.description ? html`<span class="mcp-desc">${mcp.description}</span>` : nothing}
      </div>
      <div class="mcp-meta">
        ${isLocal 
          ? html`<span class="mcp-badge local">${icons.monitor} Local</span>`
          : html`<span class="mcp-badge remote">${icons.globe} ${mcp.nodeName}</span>`}
        ${source ? html`<span class="mcp-source-badge ${source}">${source}</span>` : nothing}
      </div>
      <span class="mcp-tools">${toolCount > 0 ? `${toolCount} tools` : "—"}</span>
      <div class="mcp-actions">
        <button
          class="mcp-action-btn"
          @click=${() => props.onTestMCP(mcp.id, mcp.nodeId)}
          title="Test MCP"
        >
          Test
        </button>
        <button
          class="mcp-action-btn"
          @click=${() => props.onMCPDetails(mcp.id, mcp.nodeId)}
          title="View Details"
        >
          Details
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. Resource Monitor Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderResourceMonitor(props: ControlCenterProps): TemplateResult {
  const { federationState, loadMetrics } = props;
  const onlineNodes = federationState.nodes.filter((n) => n.status === "online");

  return html`
    <div class="fcc-panel-header">
      <h2>${icons.barChart} Resource Monitor</h2>
    </div>
    <div class="fcc-panel-content">
      ${onlineNodes.length === 0
        ? html`
            <div class="fcc-empty-sm">
              <span>No online nodes to monitor</span>
            </div>
          `
        : html`
            <div class="resource-monitor-list">
              ${onlineNodes.map((node) => {
                const metrics = loadMetrics.get(node.id);
                return renderNodeResourceMonitor(node, metrics);
              })}
            </div>
          `}
    </div>
  `;
}

function renderNodeResourceMonitor(node: FederationNode, metrics?: NodeLoadMetrics): TemplateResult {
  const loadScore = metrics?.loadScore ?? 0;
  const loadClass = getLoadClass(loadScore);

  return html`
    <div class="resource-node">
      <div class="resource-node-header">
        <span class="resource-node-name">${node.name}</span>
        <span class="resource-load-score ${loadClass}">${loadScore}%</span>
      </div>
      ${metrics
        ? html`
            <div class="resource-meters">
              ${renderMiniMeter("CPU", metrics.cpuPercent)}
              ${renderMiniMeter("MEM", metrics.memoryPercent)}
              ${metrics.gpuPercent !== undefined ? renderMiniMeter("GPU", metrics.gpuPercent) : nothing}
            </div>
            <div class="resource-meta">
              <span>${icons.messageSquare} ${metrics.activeSessions} active</span>
            </div>
          `
        : html`
            <div class="resource-no-data">No metrics available</div>
          `}
    </div>
  `;
}

function renderMiniMeter(label: string, percent: number): TemplateResult {
  const color = getLoadColor(percent);
  return html`
    <div class="mini-meter">
      <span class="mini-meter-label">${label}</span>
      <div class="mini-meter-bar">
        <div class="mini-meter-fill" style="width: ${percent}%; background: ${color}"></div>
      </div>
      <span class="mini-meter-value">${Math.round(percent)}%</span>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. Session Distribution Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderSessionDistribution(props: ControlCenterProps): TemplateResult {
  const { federationState, sessions } = props;
  const totalSessions = sessions.length;

  // Group sessions by node
  const sessionsByNode = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const existing = sessionsByNode.get(session.nodeId) ?? [];
    existing.push(session);
    sessionsByNode.set(session.nodeId, existing);
  }

  return html`
    <div class="fcc-panel-header">
      <h2>${icons.barChart} Session Distribution</h2>
    </div>
    <div class="fcc-panel-content">
      <!-- Distribution bars -->
      <div class="session-distribution-bars">
        ${federationState.nodes.map((node) => {
          const nodeSessions = sessionsByNode.get(node.id) ?? [];
          const count = nodeSessions.length;
          const percent = totalSessions > 0 ? (count / totalSessions) * 100 : 0;
          const isOffline = node.status !== "online";

          return html`
            <div class="session-dist-row">
              <span class="session-dist-node">${node.name}</span>
              <div class="session-dist-bar-container">
                <div
                  class="session-dist-bar ${isOffline ? "offline" : ""}"
                  style="width: ${percent}%"
                ></div>
              </div>
              <span class="session-dist-count">
                ${count} ${isOffline ? "(offline)" : `(${Math.round(percent)}%)`}
              </span>
            </div>
          `;
        })}
      </div>

      <!-- Active sessions list -->
      ${sessions.length > 0
        ? html`
            <div class="session-list-header">Active Sessions:</div>
            <div class="session-list">
              ${sessions.slice(0, 5).map((session) => renderSessionRow(session, props))}
              ${sessions.length > 5
                ? html`<div class="session-list-more">+${sessions.length - 5} more sessions</div>`
                : nothing}
            </div>
          `
        : html`
            <div class="fcc-empty-sm">
              <span>No active sessions</span>
            </div>
          `}
    </div>
  `;
}

function renderSessionRow(session: SessionInfo, props: ControlCenterProps): TemplateResult {
  return html`
    <div class="session-row">
      <span class="session-key">${session.sessionKey}</span>
      <span class="session-node">${session.nodeName}</span>
      <span class="session-tokens">${formatTokens(session.tokens)}</span>
      <div class="session-actions">
        <button
          class="session-action-btn"
          @click=${() => {
            const target = prompt("Migrate to node ID:");
            if (target) props.onMigrateSession(session.id, target);
          }}
          title="Migrate to another node"
        >
          Migrate
        </button>
        <button
          class="session-action-btn danger"
          @click=${() => props.onKillSession(session.id)}
          title="Kill session"
        >
          Kill
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. State Sync Status Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderStateSyncStatus(props: ControlCenterProps): TemplateResult {
  const { syncItems, vectorClock, conflictCount } = props;

  return html`
    <div class="fcc-panel-header">
      <h2>${icons.refresh} State Sync</h2>
      <button class="fcc-btn fcc-btn--sm fcc-btn--outline" @click=${props.onSyncAll}>
        Sync Now
      </button>
    </div>
    <div class="fcc-panel-content">
      <div class="sync-items">
        ${syncItems.map((item) => renderSyncItem(item, props))}
      </div>

      <div class="sync-footer">
        <div class="sync-vector-clock">
          <span class="sync-label">Vector Clock:</span>
          <code class="sync-clock-value">${JSON.stringify(vectorClock)}</code>
        </div>
        <div class="sync-conflicts">
          <span class="sync-label">Conflicts:</span>
          <span class="sync-conflict-count ${conflictCount > 0 ? "has-conflicts" : ""}">${conflictCount}</span>
        </div>
      </div>
    </div>
  `;
}

function renderSyncItem(item: StateSyncItem, props: ControlCenterProps): TemplateResult {
  const statusIcon = getSyncStatusIcon(item.status);
  const statusClass = item.status;

  return html`
    <div class="sync-item">
      <span class="sync-item-icon">${item.icon}</span>
      <span class="sync-item-name">${item.category}</span>
      <span class="sync-item-status ${statusClass}">${statusIcon} ${item.status === "pending" && item.pendingCount ? `${item.pendingCount} pending` : item.status}</span>
      <span class="sync-item-time">Last: ${formatRelativeTime(item.lastSync)}</span>
      ${item.status === "pending" || item.status === "conflict"
        ? html`
            <button class="sync-item-action" @click=${() => props.onForceSyncItem(item.category)}>
              View
            </button>
          `
        : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. Service Discovery Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderServiceDiscovery(props: ControlCenterProps): TemplateResult {
  const { serviceState, federationState } = props;
  const containers = serviceState?.dockerContainers ?? [];
  const services = serviceState?.services ?? [];
  const loading = serviceState?.loading ?? false;
  const selectedNode = serviceState?.selectedNodeForScan ?? "local";
  
  return html`
    <div class="fcc-panel-header">
      <h2>${icons.search} Service Discovery</h2>
      <div class="svc-header-actions">
        <select 
          class="fcc-select" 
          .value=${selectedNode}
          @change=${(e: Event) => {
            const target = e.target as HTMLSelectElement;
            // Update selected node state
          }}
        >
          <option value="local">This Node</option>
          ${federationState.nodes.filter(n => !n.isLocal).map(n => html`
            <option value=${n.id}>${n.name}</option>
          `)}
        </select>
        <button 
          class="fcc-btn fcc-btn--sm fcc-btn--outline"
          ?disabled=${loading}
          @click=${() => props.onScanDocker?.(selectedNode === "local" ? undefined : selectedNode)}
        >
          ${loading ? "Scanning..." : html`${icons.container} Scan Docker`}
        </button>
        <button 
          class="fcc-btn fcc-btn--sm fcc-btn--outline"
          @click=${() => {
            const path = prompt("Enter service directory path:");
            if (path) props.onAddDirectory?.(path, selectedNode === "local" ? undefined : selectedNode);
          }}
        >
          ${icons.folder} Add Directory
        </button>
      </div>
    </div>
    <div class="fcc-panel-content">
      ${containers.length === 0 && services.length === 0
        ? html`
            <div class="fcc-empty">
              <span class="fcc-empty-icon">${icons.container}</span>
              <span class="fcc-empty-text">No services discovered</span>
              <span class="fcc-empty-hint">Scan for Docker containers or add a service directory</span>
            </div>
          `
        : html`
            <!-- Docker Containers -->
            ${containers.length > 0 ? html`
              <div class="svc-section">
                <h3 class="svc-section-title">${icons.container} Docker Containers</h3>
                <div class="svc-grid">
                  ${containers.map(c => renderDockerContainer(c, props))}
                </div>
              </div>
            ` : nothing}
            
            <!-- Registered Services -->
            ${services.length > 0 ? html`
              <div class="svc-section">
                <h3 class="svc-section-title">${icons.container} Registered Services</h3>
                <div class="svc-list">
                  ${services.map(s => renderFederationServiceRow(s, props))}
                </div>
              </div>
            ` : nothing}
          `}
    </div>
  `;
}

function renderDockerContainer(container: DockerContainer, props: ControlCenterProps): TemplateResult {
  const isRunning = container.state === "running";
  const ports = container.ports.map(p => `${p.hostPort}:${p.containerPort}`).join(", ") || "none";
  
  return html`
    <div class="svc-container-card ${isRunning ? "running" : "stopped"}">
      <div class="svc-container-header">
        <span class="svc-container-icon">${icons.container}</span>
        <span class="svc-container-name">${container.name}</span>
        <span class="svc-container-state ${container.state}">${container.state}</span>
      </div>
      <div class="svc-container-image">${container.image}</div>
      <div class="svc-container-ports">Ports: ${ports}</div>
      <div class="svc-container-actions">
        ${isRunning ? html`
          <button 
            class="fcc-btn fcc-btn--xs fcc-btn--primary"
            @click=${() => props.onRegisterService?.(container, props.serviceState?.selectedNodeForScan || "local")}
          >
            ${icons.plus} Register
          </button>
        ` : html`
          <span class="svc-container-stopped-hint">Start container to register</span>
        `}
      </div>
    </div>
  `;
}

function renderFederationServiceRow(service: FederationService, props: ControlCenterProps): TemplateResult {
  const typeIcon = service.type === "docker" ? icons.container : service.type === "api" ? icons.globe : icons.folder;
  const mcpStatusBadge = {
    none: html`<span class="svc-mcp-badge none">No MCP</span>`,
    building: html`<span class="svc-mcp-badge building">${icons.clock} Building...</span>`,
    built: html`<span class="svc-mcp-badge built">${icons.checkCircle} MCP Ready</span>`,
    error: html`<span class="svc-mcp-badge error" title=${service.mcpError || ""}>${icons.xCircle} Error</span>`,
  }[service.mcpStatus || "none"];
  
  return html`
    <div class="svc-service-row">
      <div class="svc-service-info">
        <span class="svc-service-icon">${typeIcon}</span>
        <div class="svc-service-details">
          <span class="svc-service-name">${service.name}</span>
          <span class="svc-service-meta">
            Node: ${service.nodeId} 
            ${service.ports?.length ? `• Ports: ${service.ports.join(", ")}` : ""}
            ${service.capabilities?.length ? `• ${service.capabilities.join(", ")}` : ""}
          </span>
        </div>
      </div>
      <div class="svc-service-status">
        ${mcpStatusBadge}
        <span class="svc-expose-badge ${service.exposed ? "exposed" : "private"}">
          ${service.exposed ? html`${icons.globe} Exposed` : html`${icons.lock} Private`}
        </span>
      </div>
      <div class="svc-service-actions">
        ${service.mcpStatus !== "built" && service.mcpStatus !== "building" ? html`
          <button 
            class="fcc-btn fcc-btn--xs fcc-btn--accent"
            @click=${() => props.onBuildMCP?.(service.id)}
            title="Spawn sub-agent to build MCP integration"
          >
            ${icons.wrench} Build MCP
          </button>
        ` : nothing}
        <button 
          class="fcc-btn fcc-btn--xs ${service.exposed ? "fcc-btn--warning" : "fcc-btn--outline"}"
          @click=${() => props.onExposeService?.(service.id, !service.exposed)}
        >
          ${service.exposed ? html`${icons.lock} Hide` : html`${icons.globe} Expose`}
        </button>
        <button 
          class="fcc-btn fcc-btn--xs fcc-btn--danger"
          @click=${() => {
            if (confirm(`Delete service "${service.name}"?`)) {
              props.onDeleteService?.(service.id);
            }
          }}
        >
          ${icons.trash}
        </button>
      </div>
    </div>
  `;
}

// Service Discovery Styles (added to main styles function)
function getServiceDiscoveryStyles(): string {
  return `
    .svc-header-actions {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    
    .svc-section {
      margin-bottom: 1.5rem;
    }
    
    .svc-section-title {
      font-size: 0.9rem;
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: var(--text-secondary, #ccc);
    }
    
    .svc-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 0.75rem;
    }
    
    .svc-container-card {
      background: var(--card-bg, #1a1a1a);
      border: 1px solid var(--border, #333);
      border-radius: 8px;
      padding: 0.75rem;
    }
    
    .svc-container-card.running {
      border-color: var(--success, #22c55e);
    }
    
    .svc-container-card.stopped {
      opacity: 0.6;
    }
    
    .svc-container-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    
    .svc-container-name {
      font-weight: 600;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .svc-container-state {
      font-size: 0.7rem;
      padding: 0.125rem 0.375rem;
      border-radius: 4px;
      text-transform: uppercase;
    }
    
    .svc-container-state.running { background: var(--success, #22c55e); color: #000; }
    .svc-container-state.exited { background: var(--warning, #f59e0b); color: #000; }
    .svc-container-state.paused { background: var(--info, #3b82f6); color: #fff; }
    
    .svc-container-image, .svc-container-ports {
      font-size: 0.75rem;
      color: var(--text-muted, #888);
      margin-bottom: 0.25rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .svc-container-actions {
      margin-top: 0.5rem;
      display: flex;
      justify-content: flex-end;
    }
    
    .svc-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    
    .svc-service-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem;
      background: var(--card-bg, #1a1a1a);
      border: 1px solid var(--border, #333);
      border-radius: 8px;
    }
    
    .svc-service-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex: 1;
    }
    
    .svc-service-icon {
      font-size: 1.25rem;
    }
    
    .svc-service-details {
      display: flex;
      flex-direction: column;
    }
    
    .svc-service-name {
      font-weight: 600;
    }
    
    .svc-service-meta {
      font-size: 0.75rem;
      color: var(--text-muted, #888);
    }
    
    .svc-service-status {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    
    .svc-mcp-badge {
      font-size: 0.7rem;
      padding: 0.125rem 0.5rem;
      border-radius: 4px;
    }
    
    .svc-mcp-badge.none { background: var(--surface, #222); color: var(--text-muted, #888); }
    .svc-mcp-badge.building { background: var(--warning, #f59e0b); color: #000; }
    .svc-mcp-badge.built { background: var(--success, #22c55e); color: #000; }
    .svc-mcp-badge.error { background: var(--error, #ef4444); color: #fff; }
    
    .svc-expose-badge {
      font-size: 0.7rem;
      padding: 0.125rem 0.5rem;
      border-radius: 4px;
    }
    
    .svc-expose-badge.exposed { background: var(--accent, #8b5cf6); color: #fff; }
    .svc-expose-badge.private { background: var(--surface, #222); color: var(--text-muted, #888); }
    
    .svc-service-actions {
      display: flex;
      gap: 0.375rem;
    }
    
    .fcc-btn--xs {
      padding: 0.25rem 0.5rem;
      font-size: 0.7rem;
    }
    
    .fcc-btn--accent {
      background: var(--accent, #8b5cf6);
      color: #fff;
    }
    
    .fcc-btn--accent:hover {
      background: var(--accent-hover, #7c3aed);
    }
    
    .fcc-btn--warning {
      background: var(--warning, #f59e0b);
      color: #000;
    }
    
    .fcc-btn--danger {
      background: transparent;
      color: var(--error, #ef4444);
      border: 1px solid var(--error, #ef4444);
    }
    
    .fcc-btn--danger:hover {
      background: var(--error, #ef4444);
      color: #fff;
    }
    
    .fcc-select {
      padding: 0.375rem 0.75rem;
      background: var(--surface, #222);
      border: 1px solid var(--border, #333);
      border-radius: 4px;
      color: var(--text, #fff);
      font-size: 0.85rem;
    }
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. Capability Matrix Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderCapabilityMatrix(props: ControlCenterProps): TemplateResult {
  const { federationState } = props;
  const nodes = federationState.nodes;

  // Define capabilities to track
  const capabilities = [
    { id: "gpu", label: "GPU", icon: icons.monitor },
    { id: "ollama", label: "Ollama", icon: icons.brain },
    { id: "comfyui", label: "ComfyUI", icon: icons.palette },
    { id: "voice", label: "Voice", icon: icons.mic },
    { id: "ffmpeg", label: "FFmpeg", icon: icons.clapperboard },
    { id: "rembg", label: "BG Removal", icon: icons.scissors },
    { id: "upscale", label: "Upscale", icon: icons.upload },
    { id: "camera", label: "Camera", icon: icons.image },
    { id: "location", label: "Location", icon: icons.target },
  ];

  return html`
    <div class="fcc-panel-header">
      <h2>${icons.target} Capability Matrix</h2>
    </div>
    <div class="fcc-panel-content">
      ${nodes.length === 0
        ? html`
            <div class="fcc-empty-sm">
              <span>No nodes to display</span>
            </div>
          `
        : html`
            <div class="capability-matrix">
              <div class="cap-matrix-header">
                <div class="cap-matrix-cell cap-matrix-corner"></div>
                ${nodes.map(
                  (node) => html`
                    <div class="cap-matrix-cell cap-matrix-node-header" title="${node.name}">
                      ${node.name.substring(0, 8)}
                    </div>
                  `
                )}
              </div>
              ${capabilities.map(
                (cap) => html`
                  <div class="cap-matrix-row">
                    <div class="cap-matrix-cell cap-matrix-cap-label">
                      ${cap.icon} ${cap.label}
                    </div>
                    ${nodes.map((node) => {
                      const hasCap = checkNodeCapability(node, cap.id);
                      const capValue = getCapabilityValue(node, cap.id);
                      return html`
                        <div class="cap-matrix-cell ${hasCap ? "has-cap" : "no-cap"}" title="${capValue || (hasCap ? "Available" : "Not available")}">
                          ${hasCap ? (capValue ? html`${icons.checkCircle} ${capValue}` : icons.checkCircle) : icons.xCircle}
                        </div>
                      `;
                    })}
                  </div>
                `
              )}
            </div>
          `}
    </div>
  `;
}

function checkNodeCapability(node: FederationNode, capId: string): boolean {
  const caps = node.capabilities as NodeCapabilities & {
    ffmpeg?: { available?: boolean; hasNvenc?: boolean };
    imageTools?: { rembg?: boolean; realesrgan?: boolean };
    mediaServices?: string[];
  };
  switch (capId) {
    case "gpu":
      return Boolean(caps.gpu);
    case "ollama":
      return Boolean(caps.hasOllama);
    case "comfyui":
      return Boolean(caps.hasComfyUI);
    case "voice":
      return Boolean(caps.hasVoice);
    case "ffmpeg":
      return Boolean(caps.ffmpeg?.available);
    case "rembg":
      return Boolean(caps.imageTools?.rembg) || caps.mediaServices?.includes("background-removal") || false;
    case "upscale":
      return Boolean(caps.imageTools?.realesrgan) || caps.mediaServices?.includes("upscaling") || Boolean(caps.ffmpeg?.available);
    case "camera":
      // Check if mobile or has camera cap
      return node.platform === "ios" || node.platform === "android" || Boolean((caps as any).hasCamera);
    case "location":
      return node.platform === "ios" || node.platform === "android" || Boolean((caps as any).hasLocation);
    default:
      return false;
  }
}

function getCapabilityValue(node: FederationNode, capId: string): string | null {
  const caps = node.capabilities;
  switch (capId) {
    case "gpu":
      return caps.gpu || null;
    case "ram":
      return caps.ram ? `${caps.ram}GB` : null;
    default:
      return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. Node Management Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderNodeManagement(props: ControlCenterProps): TemplateResult {
  const { federationState } = props;

  return html`
    <div class="fcc-panel-header">
      <h2>${icons.settings} Node Management</h2>
    </div>
    <div class="fcc-panel-content">
      <!-- Action buttons -->
      <div class="node-mgmt-actions">
        <button
          class="fcc-btn fcc-btn--outline"
          @click=${() => {
            const url = prompt("Enter node URL (e.g., http://192.168.1.100:18789):");
            if (url) props.onAddNode(url);
          }}
        >
          + Add Node
        </button>
        <button class="fcc-btn fcc-btn--outline" @click=${props.onScanNetwork}>
          ${icons.search} Scan Network
        </button>
        <span class="node-mgmt-pending">
          Pending: <strong>0</strong>
        </span>
      </div>

      <!-- Node list -->
      <div class="node-mgmt-list">
        ${federationState.nodes.map((node) => renderNodeManagementRow(node, props))}
      </div>
    </div>
  `;
}

function renderNodeManagementRow(node: FederationNode, props: ControlCenterProps): TemplateResult {
  const isLocal = node.isLocal;
  const isOnline = node.status === "online";

  return html`
    <div class="node-mgmt-row">
      <div class="node-mgmt-info">
        <span class="node-mgmt-name">
          ${node.name}
          ${isLocal ? html`<span class="node-mgmt-local">(this)</span>` : nothing}
        </span>
        <span class="node-mgmt-role">${node.role === "master" ? "Master" : "Satellite"}</span>
      </div>
      <div class="node-mgmt-actions-row">
        ${!isLocal
          ? html`
              <button
                class="node-mgmt-btn danger"
                @click=${() => props.onRemoveNode(node.id)}
                title="Remove node"
              >
                Remove
              </button>
            `
          : nothing}
        ${!isOnline && !isLocal
          ? html`
              <button class="node-mgmt-btn" @click=${() => props.onWakeNode(node.id)} title="Wake on LAN">
                Wake
              </button>
            `
          : nothing}
        ${isOnline
          ? html`
              <button class="node-mgmt-btn" @click=${() => props.onPingNode(node.id)} title="Ping node">
                Ping
              </button>
            `
          : nothing}
        ${!isLocal && isOnline && props.onLinkSshDevice
          ? html`
              <button
                class="node-mgmt-btn"
                title="Register this node as an SSH device so the SSH Devices tool can drive it"
                @click=${() => {
                  const username = prompt(
                    `SSH username for ${node.name}:`,
                    "ubuntu",
                  );
                  if (!username) return;
                  const useKey = confirm(
                    "Use an SSH private key path? (Cancel = enter a password instead.)",
                  );
                  let password: string | undefined;
                  let privateKey: string | undefined;
                  if (useKey) {
                    privateKey =
                      prompt("Path to private key (e.g. ~/.ssh/id_ed25519):") ?? undefined;
                    if (!privateKey) return;
                  } else {
                    password = prompt(`SSH password for ${username}@${node.name}:`) ?? undefined;
                    if (!password) return;
                  }
                  const host =
                    prompt(
                      `Host or IP (blank = use federation manifest hostname):`,
                      "",
                    ) || undefined;
                  props.onLinkSshDevice!({
                    nodeId: node.id,
                    username,
                    password,
                    privateKey,
                    host: host?.trim() || undefined,
                    setActive: true,
                  });
                }}
              >
                Link SSH
              </button>
            `
          : nothing}
        <button class="node-mgmt-btn" @click=${() => props.onConfigureNode(node.id)} title="Configure">
          Config
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ══════════════════════════════════════════════════════════════════════════════

function getNodeIcon(platform?: string): TemplateResult {
  switch (platform) {
    case "ios":
    case "android":
      return icons.smartphone;
    case "macos":
      return icons.monitor;
    case "windows":
      return icons.monitor;
    case "linux":
      return icons.terminal;
    default:
      return icons.monitor;
  }
}

function getLoadColor(percent: number): string {
  if (percent >= 80) return "#ef4444";
  if (percent >= 60) return "#f59e0b";
  if (percent >= 40) return "var(--g-primary)";
  return "#22c55e";
}

function getLoadClass(percent: number): string {
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "normal";
}

function getSyncStatusIcon(status: string): TemplateResult {
  switch (status) {
    case "synced":
      return icons.checkCircle;
    case "pending":
      return icons.alert;
    case "conflict":
      return icons.alert;
    case "error":
      return icons.xCircle;
    default:
      return icons.alertCircle;
  }
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K tokens`;
  }
  return `${tokens} tokens`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

function renderControlCenterStyles(): TemplateResult {
  return html`
    <style>
      .federation-control-center {
        padding: 24px;
        max-width: 1800px;
        margin: 0 auto;
        color: #e4e4e7;
        font-family: system-ui, -apple-system, sans-serif;
      }

      /* Header */
      .fcc-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 28px;
        padding-bottom: 20px;
        border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      }

      .fcc-header h1 {
        font-size: 28px;
        font-weight: 800;
        margin: 0 0 10px 0;
        background: linear-gradient(135deg, var(--g-primary), #FDB931);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .fcc-status-bar {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 13px;
        color: #a1a1aa;
      }

      .fcc-status-item strong {
        color: var(--g-primary);
      }

      .fcc-status-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 4px;
      }

      .fcc-status-dot.online {
        background: #22c55e;
        box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
      }

      .fcc-status-dot.offline {
        background: #ef4444;
      }

      .fcc-status-divider {
        color: rgba(255, 255, 255, 0.2);
      }

      .fcc-header-actions {
        display: flex;
        gap: 10px;
      }

      /* Buttons */
      .fcc-btn {
        padding: 10px 18px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .fcc-btn--primary {
        background: linear-gradient(135deg, var(--g-primary), #FDB931);
        border: none;
        color: #0a0a0a;
      }

      .fcc-btn--primary:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }

      .fcc-btn--outline {
        background: transparent;
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
      }

      .fcc-btn--outline:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      }

      .fcc-btn--sm {
        padding: 6px 12px;
        font-size: 12px;
      }

      .fcc-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Grid Layout */
      .fcc-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 20px;
      }

      /* Panel */
      .fcc-panel {
        background: rgba(15, 15, 15, 0.8);
        border: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
        border-radius: 16px;
        overflow: hidden;
      }

      .fcc-panel--full {
        grid-column: 1 / -1;
      }

      .fcc-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        background: rgba(0, 0, 0, 0.2);
      }

      .fcc-panel-header h2 {
        font-size: 16px;
        font-weight: 600;
        margin: 0;
        color: #e4e4e7;
      }

      .fcc-panel-subtitle {
        font-size: 12px;
        color: #71717a;
      }

      .fcc-panel-content {
        padding: 20px;
      }

      /* Empty states */
      .fcc-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 40px;
        text-align: center;
      }

      .fcc-empty-icon {
        font-size: 40px;
        margin-bottom: 12px;
        opacity: 0.5;
      }

      .fcc-empty-text {
        font-size: 16px;
        color: #a1a1aa;
        margin-bottom: 6px;
      }

      .fcc-empty-hint {
        font-size: 13px;
        color: #71717a;
      }

      .fcc-empty-sm {
        padding: 24px;
        text-align: center;
        color: #71717a;
        font-size: 13px;
      }

      /* ══════════════════════════════════════════════════════════════════════
         Fleet Overview
         ══════════════════════════════════════════════════════════════════════ */

      .fleet-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 16px;
      }

      .fleet-node-card {
        padding: 16px;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .fleet-node-card:hover {
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
        transform: translateY(-2px);
      }

      .fleet-node-card.selected {
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
      }

      .fleet-node-card.offline {
        opacity: 0.6;
      }

      .fleet-node-card.local {
        border-color: rgba(139, 92, 246, 0.3);
      }

      .fleet-node-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
      }

      .fleet-node-icon {
        font-size: 20px;
      }

      .fleet-node-name {
        font-size: 15px;
        font-weight: 600;
        color: #e4e4e7;
      }

      .fleet-node-status {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
        font-size: 12px;
        color: #a1a1aa;
      }

      .fleet-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }

      .fleet-status-dot.online {
        background: #22c55e;
        box-shadow: 0 0 6px rgba(34, 197, 94, 0.5);
      }

      .fleet-status-dot.offline {
        background: #ef4444;
      }

      .fleet-node-role {
        display: flex;
        gap: 6px;
        margin-bottom: 12px;
      }

      .fleet-role-badge {
        padding: 3px 8px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
      }

      .fleet-role-badge.master {
        background: color-mix(in srgb, var(--g-primary) 15%, transparent);
        color: var(--g-primary);
      }

      .fleet-role-badge.satellite {
        background: rgba(139, 92, 246, 0.15);
        color: #a78bfa;
      }

      .fleet-local-badge {
        padding: 3px 8px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 500;
        background: rgba(59, 130, 246, 0.15);
        color: #60a5fa;
      }

      .fleet-node-resources {
        margin-bottom: 12px;
      }

      .fleet-resource-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
        font-size: 11px;
      }

      .fleet-resource-label {
        width: 28px;
        color: #71717a;
      }

      .fleet-resource-value {
        width: 32px;
        text-align: right;
        color: #a1a1aa;
      }

      .fleet-resource-bar {
        flex: 1;
        height: 5px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
        overflow: hidden;
      }

      .fleet-resource-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s ease;
      }

      .fleet-node-lastseen {
        font-size: 11px;
        color: #71717a;
        margin-bottom: 12px;
      }

      .fleet-node-stats {
        display: flex;
        gap: 12px;
        font-size: 11px;
        color: #a1a1aa;
      }

      /* ══════════════════════════════════════════════════════════════════════
         MCP Registry
         ══════════════════════════════════════════════════════════════════════ */

      .mcp-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .mcp-row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 8px;
      }

      .mcp-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .mcp-status-dot.online {
        background: #22c55e;
      }

      .mcp-status-dot.offline {
        background: #71717a;
      }

      .mcp-name-col {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .mcp-name {
        font-size: 13px;
        font-weight: 500;
        color: #e4e4e7;
      }

      .mcp-desc {
        font-size: 11px;
        color: #71717a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .mcp-meta {
        display: flex;
        gap: 6px;
        align-items: center;
      }

      .mcp-badge {
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 4px;
        font-weight: 500;
      }

      .mcp-badge.local {
        background: rgba(34, 197, 94, 0.15);
        color: #4ade80;
        border: 1px solid rgba(34, 197, 94, 0.3);
      }

      .mcp-badge.remote {
        background: rgba(99, 102, 241, 0.15);
        color: #a5b4fc;
        border: 1px solid rgba(99, 102, 241, 0.3);
      }

      .mcp-source-badge {
        font-size: 9px;
        padding: 2px 6px;
        border-radius: 3px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .mcp-source-badge.claude {
        background: rgba(255, 176, 102, 0.15);
        color: #ffb066;
      }

      .mcp-source-badge.cline {
        background: rgba(139, 92, 246, 0.15);
        color: #a78bfa;
      }

      .mcp-source-badge.infinibot {
        background: rgba(34, 211, 238, 0.15);
        color: #22d3ee;
      }

      .mcp-node {
        font-size: 11px;
        color: #71717a;
        padding: 2px 8px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
      }

      .mcp-tools {
        font-size: 12px;
        color: #a1a1aa;
        min-width: 60px;
        text-align: right;
      }

      .mcp-actions {
        display: flex;
        gap: 6px;
      }

      .mcp-action-btn {
        padding: 4px 10px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        font-size: 11px;
        color: #a1a1aa;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .mcp-action-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
        color: #e4e4e7;
      }

      .mcp-action-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* ══════════════════════════════════════════════════════════════════════
         Resource Monitor
         ══════════════════════════════════════════════════════════════════════ */

      .resource-monitor-list {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .resource-node {
        padding: 14px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 10px;
      }

      .resource-node-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }

      .resource-node-name {
        font-size: 14px;
        font-weight: 500;
      }

      .resource-load-score {
        font-size: 14px;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 6px;
      }

      .resource-load-score.normal {
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
      }

      .resource-load-score.warning {
        background: rgba(245, 158, 11, 0.15);
        color: #f59e0b;
      }

      .resource-load-score.critical {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }

      .resource-meters {
        display: flex;
        gap: 16px;
        margin-bottom: 10px;
      }

      .mini-meter {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .mini-meter-label {
        font-size: 10px;
        color: #71717a;
        text-transform: uppercase;
      }

      .mini-meter-bar {
        height: 6px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
        overflow: hidden;
      }

      .mini-meter-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s ease;
      }

      .mini-meter-value {
        font-size: 11px;
        color: #a1a1aa;
        text-align: right;
      }

      .resource-meta {
        font-size: 11px;
        color: #71717a;
      }

      .resource-no-data {
        font-size: 12px;
        color: #71717a;
        font-style: italic;
      }

      /* ══════════════════════════════════════════════════════════════════════
         Session Distribution
         ══════════════════════════════════════════════════════════════════════ */

      .session-distribution-bars {
        margin-bottom: 20px;
      }

      .session-dist-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
      }

      .session-dist-node {
        width: 80px;
        font-size: 12px;
        font-weight: 500;
        color: #e4e4e7;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .session-dist-bar-container {
        flex: 1;
        height: 12px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 6px;
        overflow: hidden;
      }

      .session-dist-bar {
        height: 100%;
        background: linear-gradient(90deg, var(--g-primary), #FDB931);
        border-radius: 6px;
        transition: width 0.3s ease;
      }

      .session-dist-bar.offline {
        background: rgba(107, 114, 128, 0.3);
      }

      .session-dist-count {
        width: 90px;
        font-size: 11px;
        color: #71717a;
        text-align: right;
      }

      .session-list-header {
        font-size: 12px;
        color: #71717a;
        margin-bottom: 10px;
        padding-top: 16px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }

      .session-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .session-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 6px;
        font-size: 12px;
      }

      .session-key {
        flex: 1;
        font-family: monospace;
        font-size: 11px;
        color: #e4e4e7;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .session-node {
        font-size: 11px;
        color: #71717a;
        padding: 2px 6px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 3px;
      }

      .session-tokens {
        font-size: 11px;
        color: #a1a1aa;
        min-width: 60px;
        text-align: right;
      }

      .session-actions {
        display: flex;
        gap: 4px;
      }

      .session-action-btn {
        padding: 3px 8px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 3px;
        font-size: 10px;
        color: #a1a1aa;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .session-action-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #e4e4e7;
      }

      .session-action-btn.danger {
        border-color: rgba(239, 68, 68, 0.3);
        color: #fca5a5;
      }

      .session-action-btn.danger:hover {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }

      .session-list-more {
        font-size: 11px;
        color: #71717a;
        text-align: center;
        padding: 8px;
      }

      /* ══════════════════════════════════════════════════════════════════════
         State Sync Status
         ══════════════════════════════════════════════════════════════════════ */

      .sync-items {
        margin-bottom: 16px;
      }

      .sync-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 8px;
        margin-bottom: 8px;
      }

      .sync-item-icon {
        font-size: 16px;
      }

      .sync-item-name {
        flex: 1;
        font-size: 13px;
        color: #e4e4e7;
      }

      .sync-item-status {
        font-size: 12px;
        padding: 3px 8px;
        border-radius: 4px;
      }

      .sync-item-status.synced {
        background: rgba(34, 197, 94, 0.1);
        color: #22c55e;
      }

      .sync-item-status.pending {
        background: rgba(234, 179, 8, 0.1);
        color: #eab308;
      }

      .sync-item-status.conflict {
        background: rgba(245, 158, 11, 0.1);
        color: #f59e0b;
      }

      .sync-item-status.error {
        background: rgba(239, 68, 68, 0.1);
        color: #ef4444;
      }

      .sync-item-time {
        font-size: 11px;
        color: #71717a;
        min-width: 70px;
        text-align: right;
      }

      .sync-item-action {
        padding: 3px 8px;
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 4px;
        font-size: 10px;
        color: var(--g-primary);
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .sync-item-action:hover {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      }

      .sync-footer {
        padding-top: 12px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .sync-vector-clock,
      .sync-conflicts {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
      }

      .sync-label {
        color: #71717a;
      }

      .sync-clock-value {
        font-size: 10px;
        padding: 4px 8px;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 4px;
        color: #a1a1aa;
        max-width: 250px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .sync-conflict-count {
        font-weight: 600;
        color: #22c55e;
      }

      .sync-conflict-count.has-conflicts {
        color: #f59e0b;
      }

      /* ══════════════════════════════════════════════════════════════════════
         Capability Matrix
         ══════════════════════════════════════════════════════════════════════ */

      .capability-matrix {
        display: flex;
        flex-direction: column;
        overflow-x: auto;
      }

      .cap-matrix-header,
      .cap-matrix-row {
        display: flex;
      }

      .cap-matrix-cell {
        min-width: 80px;
        padding: 10px 12px;
        font-size: 12px;
        text-align: center;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      }

      .cap-matrix-corner {
        min-width: 100px;
        background: rgba(0, 0, 0, 0.2);
      }

      .cap-matrix-node-header {
        background: rgba(0, 0, 0, 0.2);
        font-weight: 600;
        color: var(--g-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .cap-matrix-cap-label {
        min-width: 100px;
        text-align: left;
        font-weight: 500;
        color: #e4e4e7;
        background: rgba(0, 0, 0, 0.1);
      }

      .cap-matrix-cell.has-cap {
        color: #22c55e;
      }

      .cap-matrix-cell.no-cap {
        color: #71717a;
      }

      /* ══════════════════════════════════════════════════════════════════════
         Node Management
         ══════════════════════════════════════════════════════════════════════ */

      .node-mgmt-actions {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 20px;
      }

      .node-mgmt-pending {
        font-size: 12px;
        color: #71717a;
        margin-left: auto;
      }

      .node-mgmt-pending strong {
        color: var(--g-primary);
      }

      .node-mgmt-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .node-mgmt-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 14px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 8px;
      }

      .node-mgmt-info {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .node-mgmt-name {
        font-size: 13px;
        font-weight: 500;
        color: #e4e4e7;
      }

      .node-mgmt-local {
        font-size: 11px;
        color: #71717a;
        font-weight: normal;
      }

      .node-mgmt-role {
        font-size: 11px;
        padding: 3px 8px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
        color: #a1a1aa;
      }

      .node-mgmt-actions-row {
        display: flex;
        gap: 6px;
      }

      .node-mgmt-btn {
        padding: 5px 12px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 5px;
        font-size: 11px;
        color: #a1a1aa;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .node-mgmt-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #e4e4e7;
      }

      .node-mgmt-btn.danger {
        border-color: rgba(239, 68, 68, 0.3);
        color: #fca5a5;
      }

      .node-mgmt-btn.danger:hover {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }

      /* ══════════════════════════════════════════════════════════════════════
         System Updates Panel
         ══════════════════════════════════════════════════════════════════════ */

      .update-header-actions {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .update-latest-badge {
        font-size: 12px;
        padding: 4px 10px;
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
        border-radius: 6px;
        font-weight: 500;
      }

      .update-nodes-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
        margin-bottom: 20px;
      }

      .update-node-row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 16px;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        transition: all 0.2s ease;
      }

      .update-node-row:hover {
        border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
      }

      .update-node-row.offline {
        opacity: 0.6;
      }

      .update-node-row.updating {
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        background: color-mix(in srgb, var(--g-primary) 3%, transparent);
      }

      .update-node-info {
        flex: 1;
        min-width: 0;
      }

      .update-node-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;
      }

      .update-node-name {
        font-size: 15px;
        font-weight: 600;
        color: #e4e4e7;
      }

      .update-node-local {
        font-size: 11px;
        color: #71717a;
        font-weight: normal;
        margin-left: 4px;
      }

      .update-node-master {
        font-size: 10px;
        padding: 2px 6px;
        background: color-mix(in srgb, var(--g-primary) 15%, transparent);
        color: var(--g-primary);
        border-radius: 4px;
        font-weight: 600;
        text-transform: uppercase;
        margin-left: 6px;
      }

      .update-node-status {
        font-size: 11px;
        color: #71717a;
      }

      .update-node-status.online {
        color: #22c55e;
      }

      .update-node-version {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .update-version-badge {
        font-size: 13px;
        font-weight: 600;
        padding: 4px 10px;
        border-radius: 6px;
        font-family: monospace;
      }

      .update-version-badge.current {
        background: rgba(34, 197, 94, 0.15);
        color: #22c55e;
      }

      .update-version-badge.outdated {
        background: rgba(234, 179, 8, 0.15);
        color: #eab308;
      }

      .update-version-badge.updating {
        background: rgba(59, 130, 246, 0.15);
        color: #60a5fa;
      }

      .update-version-badge.error {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }

      .update-version-badge.offline {
        background: rgba(113, 113, 122, 0.15);
        color: #71717a;
      }

      .update-commit {
        font-size: 11px;
        font-family: monospace;
        color: #71717a;
        padding: 2px 6px;
        background: rgba(0, 0, 0, 0.3);
        border-radius: 4px;
      }

      .update-status {
        font-size: 12px;
        color: #a1a1aa;
      }

      .update-status.current {
        color: #22c55e;
      }

      .update-status.outdated {
        color: #eab308;
      }

      .update-status.updating {
        color: #60a5fa;
      }

      .update-status.error {
        color: #ef4444;
      }

      .update-status.offline {
        color: #71717a;
      }

      .update-progress {
        margin-top: 12px;
      }

      .update-progress-bar {
        height: 6px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 8px;
      }

      .update-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--g-primary), #FDB931);
        border-radius: 3px;
        transition: width 0.3s ease;
      }

      .update-progress-steps {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        flex-wrap: wrap;
      }

      .update-step {
        display: flex;
        align-items: center;
        gap: 3px;
        color: #71717a;
      }

      .update-step.active {
        color: var(--g-primary);
        font-weight: 500;
      }

      .update-step.complete {
        color: #22c55e;
      }

      .update-step.error {
        color: #ef4444;
      }

      .update-step-connector {
        color: rgba(255, 255, 255, 0.2);
        margin: 0 2px;
      }

      .update-node-actions {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
        margin-left: 16px;
      }

      .update-action-btn {
        padding: 6px 14px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        font-size: 12px;
        color: #a1a1aa;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
      }

      .update-action-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
        color: #e4e4e7;
      }

      .update-action-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .update-action-btn.primary {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        color: var(--g-primary);
      }

      .update-action-btn.primary:hover:not(:disabled) {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
      }

      .update-action-btn.warning {
        border-color: rgba(245, 158, 11, 0.3);
        color: #f59e0b;
      }

      .update-action-btn.warning:hover:not(:disabled) {
        background: rgba(245, 158, 11, 0.15);
      }

      .update-fleet-actions {
        display: flex;
        justify-content: center;
        padding-top: 16px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }

      /* Responsive */
      @media (max-width: 1200px) {
        .fcc-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 768px) {
        .federation-control-center {
          padding: 16px;
        }

        .fcc-header {
          flex-direction: column;
          gap: 16px;
        }

        .fcc-status-bar {
          flex-wrap: wrap;
        }

        .fleet-grid {
          grid-template-columns: 1fr;
        }
      }

      /* Service Discovery Panel */
      .svc-header-actions {
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }
      
      .svc-section {
        margin-bottom: 1.5rem;
      }
      
      .svc-section-title {
        font-size: 0.9rem;
        font-weight: 600;
        margin-bottom: 0.75rem;
        color: #a1a1aa;
      }
      
      .svc-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 0.75rem;
      }
      
      .svc-container-card {
        background: rgba(20, 20, 20, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
        padding: 0.75rem;
      }
      
      .svc-container-card.running {
        border-color: rgba(34, 197, 94, 0.5);
      }
      
      .svc-container-card.stopped {
        opacity: 0.6;
      }
      
      .svc-container-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
      }
      
      .svc-container-name {
        font-weight: 600;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      
      .svc-container-state {
        font-size: 0.7rem;
        padding: 0.125rem 0.375rem;
        border-radius: 4px;
        text-transform: uppercase;
        font-weight: 600;
      }
      
      .svc-container-state.running { background: #22c55e; color: #000; }
      .svc-container-state.exited { background: #f59e0b; color: #000; }
      .svc-container-state.paused { background: #3b82f6; color: #fff; }
      
      .svc-container-image, .svc-container-ports {
        font-size: 0.75rem;
        color: #71717a;
        margin-bottom: 0.25rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      
      .svc-container-actions {
        margin-top: 0.5rem;
        display: flex;
        justify-content: flex-end;
      }
      
      .svc-container-stopped-hint {
        font-size: 0.7rem;
        color: #71717a;
        font-style: italic;
      }
      
      .svc-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      
      .svc-service-row {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.75rem 1rem;
        background: rgba(20, 20, 20, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 8px;
      }
      
      .svc-service-info {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex: 1;
        min-width: 0;
      }
      
      .svc-service-icon {
        font-size: 1.25rem;
        flex-shrink: 0;
      }
      
      .svc-service-details {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      
      .svc-service-name {
        font-weight: 600;
        color: #e4e4e7;
      }
      
      .svc-service-meta {
        font-size: 0.75rem;
        color: #71717a;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      
      .svc-service-status {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-shrink: 0;
      }
      
      .svc-mcp-badge {
        font-size: 0.7rem;
        padding: 0.125rem 0.5rem;
        border-radius: 4px;
        font-weight: 600;
      }
      
      .svc-mcp-badge.none { background: #27272a; color: #71717a; }
      .svc-mcp-badge.building { background: #f59e0b; color: #000; }
      .svc-mcp-badge.built { background: #22c55e; color: #000; }
      .svc-mcp-badge.error { background: #ef4444; color: #fff; }
      
      .svc-expose-badge {
        font-size: 0.7rem;
        padding: 0.125rem 0.5rem;
        border-radius: 4px;
        font-weight: 600;
      }
      
      .svc-expose-badge.exposed { background: #8b5cf6; color: #fff; }
      .svc-expose-badge.private { background: #27272a; color: #71717a; }
      
      .svc-service-actions {
        display: flex;
        gap: 0.375rem;
        flex-shrink: 0;
      }
      
      .fcc-btn--xs {
        padding: 0.25rem 0.5rem;
        font-size: 0.7rem;
        border-radius: 4px;
      }
      
      .fcc-btn--accent {
        background: linear-gradient(135deg, #8b5cf6, #7c3aed);
        color: #fff;
        border: none;
      }
      
      .fcc-btn--accent:hover {
        background: linear-gradient(135deg, #7c3aed, #6d28d9);
      }
      
      .fcc-btn--warning {
        background: #f59e0b;
        color: #000;
        border: none;
      }
      
      .fcc-btn--danger {
        background: transparent;
        color: #ef4444;
        border: 1px solid #ef4444;
      }
      
      .fcc-btn--danger:hover {
        background: #ef4444;
        color: #fff;
      }
      
      .fcc-select {
        padding: 0.375rem 0.75rem;
        background: #1a1a1a;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        color: #e4e4e7;
        font-size: 0.85rem;
      }
      
      .fcc-select:focus {
        outline: none;
        border-color: var(--g-primary);
      }
    </style>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Default Props Factory (for integration)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create default props for the control center with placeholder data.
 * Use this when integrating with the existing federation state.
 */
export function createControlCenterProps(
  federationState: FederationState,
  resourcesState: FederationResourcesState,
  handlers: Partial<ControlCenterProps>
): ControlCenterProps {
  // Generate placeholder load metrics from nodes
  const loadMetrics = new Map<string, NodeLoadMetrics>();
  for (const node of federationState.nodes) {
    if (node.status === "online") {
      loadMetrics.set(node.id, {
        nodeId: node.id,
        cpuPercent: Math.random() * 60 + 10, // Placeholder
        memoryPercent: Math.random() * 50 + 20, // Placeholder
        gpuPercent: node.capabilities.gpu ? Math.random() * 40 : undefined,
        loadScore: Math.random() * 50 + 10,
        activeSessions: resourcesState.agents.filter((a) => a.nodeId === node.id && a.activeSessions > 0).reduce((sum, a) => sum + a.activeSessions, 0),
        lastUpdate: Date.now(),
      });
    }
  }

  // Generate placeholder sessions
  const sessions: SessionInfo[] = resourcesState.agents
    .filter((a) => a.activeSessions > 0)
    .flatMap((agent) => {
      const sessions: SessionInfo[] = [];
      for (let i = 0; i < agent.activeSessions; i++) {
        sessions.push({
          id: `${agent.id}-session-${i}`,
          sessionKey: `agent:${agent.id}:session-${Math.random().toString(36).substring(7)}`,
          nodeId: agent.nodeId,
          nodeName: agent.nodeName,
          agentId: agent.id,
          channel: "webchat",
          tokens: Math.floor(Math.random() * 50000) + 5000,
          lastActive: Date.now() - Math.floor(Math.random() * 3600000),
          status: "active",
        });
      }
      return sessions;
    });

  // Generate placeholder sync items
  const syncItems: StateSyncItem[] = [
    {
      category: "Memory Files",
      icon: "📁",
      status: "synced",
      lastSync: Date.now() - 30000,
    },
    {
      category: "Kanban Tasks",
      icon: "✅",
      status: "synced",
      lastSync: Date.now() - 120000,
    },
    {
      category: "Transcripts",
      icon: "📝",
      status: resourcesState.conflicts.length > 0 ? "pending" : "synced",
      lastSync: Date.now() - 300000,
      pendingCount: resourcesState.conflicts.length,
    },
    {
      category: "Config",
      icon: "⚙️",
      status: "synced",
      lastSync: Date.now() - 3600000,
    },
  ];

  // Generate placeholder vector clock
  const vectorClock: Record<string, number> = {};
  for (const node of federationState.nodes) {
    vectorClock[node.name] = Math.floor(Math.random() * 200) + 1;
  }

  // Generate placeholder update state
  const updateState: UpdateState = {
    loading: false,
    nodeVersions: federationState.nodes.map((node) => ({
      nodeId: node.id,
      nodeName: node.name,
      isLocal: node.isLocal,
      isMaster: node.role === "master",
      status: node.status as "online" | "offline",
      version: "loading...",
      buildTime: null,
      gitCommit: null,
      lastUpdated: null,
      updateAvailable: false,
    })),
    latestVersion: null,
    updateInProgress: new Map(),
    lastCheck: null,
  };

  return {
    federationState,
    resourcesState,
    loadMetrics,
    sessions,
    syncItems,
    vectorClock,
    conflictCount: resourcesState.conflicts.length,
    updateState,

    onRefresh: handlers.onRefresh ?? (() => console.log("[FCC] Refresh")),
    onSyncAll: handlers.onSyncAll ?? (() => console.log("[FCC] Sync All")),
    onSelectNode: handlers.onSelectNode ?? ((id) => console.log("[FCC] Select node:", id)),
    onTestMCP: handlers.onTestMCP ?? ((id, nodeId) => console.log("[FCC] Test MCP:", id, nodeId)),
    onMCPDetails: handlers.onMCPDetails ?? ((id, nodeId) => console.log("[FCC] MCP Details:", id, nodeId)),
    onMigrateSession: handlers.onMigrateSession ?? ((id, target) => console.log("[FCC] Migrate session:", id, "to", target)),
    onKillSession: handlers.onKillSession ?? ((id) => console.log("[FCC] Kill session:", id)),
    onAddNode: handlers.onAddNode ?? ((url) => console.log("[FCC] Add node:", url)),
    onRemoveNode: handlers.onRemoveNode ?? ((id) => console.log("[FCC] Remove node:", id)),
    onWakeNode: handlers.onWakeNode ?? ((id) => console.log("[FCC] Wake node:", id)),
    onPingNode: handlers.onPingNode ?? ((id) => console.log("[FCC] Ping node:", id)),
    onConfigureNode: handlers.onConfigureNode ?? ((id) => console.log("[FCC] Configure node:", id)),
    onScanNetwork: handlers.onScanNetwork ?? (() => console.log("[FCC] Scan network")),
    onForceSyncItem: handlers.onForceSyncItem ?? ((cat) => console.log("[FCC] Force sync:", cat)),
    
    // Update handlers
    onCheckForUpdates: handlers.onCheckForUpdates ?? (() => console.log("[FCC] Check for updates")),
    onUpdateNode: handlers.onUpdateNode ?? ((id, actions) => console.log("[FCC] Update node:", id, actions)),
    onUpdateAllNodes: handlers.onUpdateAllNodes ?? (() => console.log("[FCC] Update all nodes")),
  };
}
