/**
 * Federation Dashboard View ("Network Hub", tab `federation`)
 *
 * Glass G7: black-gold frosted glass built on the shared system kit
 * (./system-glass.ts). Sections:
 * - Hero with live connection status, actions and fleet stat tiles
 * - Master device panel (role, switch-master controls, status LEDs)
 * - Segmented sub-tabs: overview · gateways · projects · tasks · agents · MCP · business
 * - Topology node cards, quick actions, sync activity timeline
 */

import { html, nothing, type TemplateResult } from "lit";
import type { FederationState } from "../controllers/federation";
import type {
  FederationResourcesState,
  NodeGatewayInfo,
  SharedProject,
  SharedTask,
  FederatedAgent,
  FederatedMCP,
  FederatedBusinessSource,
  SyncStatus,
} from "../controllers/federation-resources";
import {
  ensureSystemGlass,
  sgAurora,
  sgChip,
  sgEmpty,
  sgGloss,
  sgHero,
  sgIcon,
  sgLed,
  sgMeter,
  type SgIconName,
  type SgStat,
  type SgTone,
} from "./system-glass";
import "../components/device-switcher";

// ══════════════════════════════════════════════════════════════════════════════
// Props Types
// ══════════════════════════════════════════════════════════════════════════════

export interface FederationDashboardProps {
  federationState: FederationState;
  resourcesState: FederationResourcesState;
  onRefresh: () => void;
  onSyncAll: () => void;
  onSelectNode: (nodeId: string | null) => void;
  onConnectToNode: (nodeId: string) => void;
  onShareProject: (projectId: string, targetNodes: string[]) => void;
  onAssignTask: (taskId: string, nodeId: string, agentId?: string) => void;
  onShareMCP: (mcpId: string, share: boolean) => void;
  onSetActiveTab: (tab: FederationResourcesState["activeTab"]) => void;
  onInvokeOnNode: (nodeId: string, method: string, params: Record<string, unknown>) => void;
  onOpenNodeDetails?: (node: NodeGatewayInfo) => void;
  /** Open device control (screen, commands, terminal) for a remote satellite. */
  onOpenDevice?: (nodeId: string, nodeName: string) => void;
  onOpenConnectWizard?: () => void;
  onPromoteToMaster?: (nodeId: string) => void;
  /** Opens the "Generate Connection Link" modal (hub-only) */
  onGenerateInvite?: () => void;
}

type ChipTone = Exclude<SgTone, "off" | "info">;

// ══════════════════════════════════════════════════════════════════════════════
// Main Render
// ══════════════════════════════════════════════════════════════════════════════

export function renderFederationDashboard(props: FederationDashboardProps) {
  ensureSystemGlass();
  const { resourcesState: state, federationState: fed } = props;
  const stats = calculateStats(state);
  const isHub = fed.mode === "master" || fed.mode === "standalone";
  const firstLoad = state.loading && state.nodeGateways.length === 0 && state.lastFullSync === null;

  const status: { tone: SgTone; label: string } =
    fed.connectionStatus === "connected"
      ? { tone: "ok", label: `Live · ${stats.onlineNodes}/${stats.totalNodes} online` }
      : fed.connectionStatus === "connecting"
        ? { tone: "warn", label: "Connecting" }
        : fed.mode === "standalone"
          ? { tone: "gold", label: "Standalone hub" }
          : { tone: "bad", label: "Disconnected" };

  const actions = html`
    ${props.onGenerateInvite && isHub ? html`
      <button class="sg-btn" @click=${props.onGenerateInvite} title="Generate a one-click connection link for a satellite">
        ${sgIcon("link", 15)} Share Invite
      </button>
    ` : nothing}
    ${props.onOpenConnectWizard ? html`
      <button class="sg-btn" @click=${props.onOpenConnectWizard}>
        ${sgIcon("plus", 15)} Connect Node
      </button>
    ` : nothing}
    <button class="sg-btn" ?disabled=${state.loading} @click=${props.onRefresh}>
      <span class="fed-ico ${state.loading ? "fed-spin" : ""}">${sgIcon("refresh", 15)}</span> Refresh
    </button>
    <button class="sg-btn sg-btn--primary" ?disabled=${state.syncInProgress} @click=${props.onSyncAll}>
      <span class="fed-ico ${state.syncInProgress ? "fed-spin" : ""}">${sgIcon("activity", 15)}</span>
      ${state.syncInProgress ? "Syncing..." : "Sync All"}
    </button>
  `;

  return html`
    <div class="sg-page sg-fed federation-dashboard">
      ${renderStyles()}
      ${sgAurora()}
      ${sgHero({
        eyebrow: "Fleet",
        title: "Network",
        accent: "Hub",
        sub: "Run every InfiniBot device as one cluster: share projects, route tasks and reach each node's gateway from here.",
        icon: "network",
        status,
        actions,
        stats: buildHeroStats(stats, firstLoad),
      })}

      ${state.error ? html`
        <div class="fed-alert" role="alert">
          ${sgIcon("alert", 16)}
          <span>${state.error}</span>
        </div>
      ` : nothing}

      ${renderMasterSwitchPanel(props)}
      <ib-device-switcher class="fed-device-switcher" style="margin: 0 0 18px"></ib-device-switcher>
      ${renderTabNav(state.activeTab, props.onSetActiveTab, stats)}

      <div class="fed-content" role="tabpanel">
        ${firstLoad ? renderLoading() : html`
          ${state.activeTab === "overview" ? renderOverviewTab(props, stats) : nothing}
          ${state.activeTab === "gateways" ? renderGatewaysTab(props) : nothing}
          ${state.activeTab === "projects" ? renderProjectsTab(props) : nothing}
          ${state.activeTab === "tasks" ? renderTasksTab(props) : nothing}
          ${state.activeTab === "agents" ? renderAgentsTab(props) : nothing}
          ${state.activeTab === "mcp" ? renderMCPTab(props) : nothing}
          ${state.activeTab === "business" ? renderBusinessTab(props) : nothing}
        `}
      </div>
    </div>
  `;
}

function renderLoading() {
  return html`
    <div class="sg-panel fed-loading" aria-busy="true" aria-label="Loading federation">
      <span class="sg-skel" style="width:180px;height:12px"></span>
      <div class="fed-node-grid">
        ${[0, 1, 2].map(() => html`<span class="sg-skel sg-skel--block" style="height:132px"></span>`)}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Master Switch Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderMasterSwitchPanel(props: FederationDashboardProps) {
  const { federationState, resourcesState } = props;
  const masterNode = federationState.nodes.find(n => n.role === "master" && n.isLocal);
  const isMasterMode = federationState.mode === "master" || federationState.mode === "standalone";
  const isSatelliteMode = federationState.mode === "satellite";
  const onlineNodes = resourcesState.nodeGateways.filter(n => n.connected);
  const remoteOnline = onlineNodes.filter(n => !isLocalNode(n.nodeId, federationState.localNodeId));
  const conn = federationState.connectionStatus;
  const connTone: SgTone = conn === "connected" ? "ok" : conn === "connecting" ? "warn" : "bad";
  const connLabel = conn === "connected" ? "Connected" : conn === "connecting" ? "Connecting" : "Disconnected";

  return html`
    <section class="sg-panel fed-master-panel sg-enter" aria-label="Master device">
      <div class="fed-master-header">
        <div class="fed-master-badge ${isMasterMode ? "is-master" : "is-satellite"}">
          ${sgIcon(isMasterMode ? "shield" : "wifi", 22)}
        </div>
        <div class="fed-master-copy">
          <div class="fed-master-label">
            ${sgLed(isMasterMode ? "gold" : "info")}
            ${isMasterMode ? "Master Device" : "Satellite Mode"}
          </div>
          <div class="fed-master-desc">
            ${isMasterMode
              ? html`This device controls the federation. <strong>${onlineNodes.length}</strong> node${onlineNodes.length !== 1 ? "s" : ""} connected.`
              : html`Connected to master at <code class="fed-code">${federationState.masterUrl || "unknown"}</code>`}
          </div>
        </div>
        <div class="fed-master-status-row">
          <span class="fed-status-item" title="Federation mode">${sgIcon("layers", 13)} Mode <strong>${federationState.mode}</strong></span>
          <span class="fed-status-item fed-status-text ${connTone}">${sgLed(connTone)} ${connLabel}</span>
          ${masterNode ? html`
            <span class="fed-status-item">${sgIcon("server", 13)} Local <strong>${masterNode.name}</strong></span>
          ` : nothing}
        </div>
      </div>

      ${isSatelliteMode ? html`
        <div class="fed-master-switch-bar">
          <span class="fed-switch-label">Claim as master</span>
          <button
            class="sg-btn sg-btn--sm fed-switch-node-btn"
            @click=${() => {
              if (props.onPromoteToMaster) {
                props.onPromoteToMaster("local");
              }
            }}
            title="Promote this device to master"
          >
            ${sgLed("ok")} This Device
          </button>
        </div>
      ` : nothing}

      ${isMasterMode && onlineNodes.length > 0 ? html`
        <div class="fed-master-switch-bar">
          <span class="fed-switch-label">Switch master to</span>
          <div class="fed-switch-nodes">
            ${remoteOnline.length === 0 ? html`<span class="fed-switch-more">No other online nodes yet</span>` : nothing}
            ${remoteOnline.slice(0, 5).map(node => html`
              <button
                class="sg-btn sg-btn--sm fed-switch-node-btn"
                @click=${() => {
                  if (props.onPromoteToMaster) {
                    props.onPromoteToMaster(node.nodeId);
                  }
                }}
                title="Promote ${node.nodeName} to master"
              >
                ${sgLed("ok")}
                ${node.nodeName}
                ${node.latency ? html`<span class="fed-switch-latency">${node.latency}ms</span>` : nothing}
              </button>
            `)}
            ${remoteOnline.length > 5 ? html`
              <span class="fed-switch-more">+${remoteOnline.length - 5} more</span>
            ` : nothing}
          </div>
        </div>
      ` : nothing}
    </section>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stats
// ══════════════════════════════════════════════════════════════════════════════

interface Stats {
  totalNodes: number;
  onlineNodes: number;
  totalProjects: number;
  sharedProjects: number;
  totalTasks: number;
  pendingTasks: number;
  totalAgents: number;
  activeAgents: number;
  totalMCPs: number;
  runningMCPs: number;
  conflicts: number;
}

function calculateStats(state: FederationResourcesState): Stats {
  return {
    totalNodes: state.nodeGateways.length,
    onlineNodes: state.nodeGateways.filter((n) => n.connected).length,
    totalProjects: state.projects.length,
    sharedProjects: state.projects.filter((p) => p.sharedWith.length > 0).length,
    totalTasks: state.tasks.length,
    pendingTasks: state.tasks.filter((t) => t.status === "todo" || t.status === "in_progress").length,
    totalAgents: state.agents.length,
    activeAgents: state.agents.filter((a) => a.status === "active" || a.status === "busy").length,
    totalMCPs: state.mcpServers.length,
    runningMCPs: state.mcpServers.filter((m) => m.status === "running").length,
    conflicts: state.conflicts.length,
  };
}

function buildHeroStats(stats: Stats, loading: boolean): SgStat[] {
  const dash = loading ? "—" : null;
  const nodeTone: ChipTone =
    stats.totalNodes === 0 ? "gold" : stats.onlineNodes === stats.totalNodes ? "ok" : stats.onlineNodes > 0 ? "warn" : "bad";
  const items: SgStat[] = [
    {
      label: "Nodes online",
      value: dash ?? `${stats.onlineNodes}/${stats.totalNodes}`,
      icon: "server",
      tone: nodeTone === "gold" ? undefined : nodeTone,
      meter: stats.totalNodes > 0 ? stats.onlineNodes / stats.totalNodes : 0,
      meterKind: "health",
    },
    {
      label: "Projects",
      value: dash ?? stats.totalProjects,
      icon: "layers",
      foot: `${stats.sharedProjects} shared`,
    },
    {
      label: "Active tasks",
      value: dash ?? stats.pendingTasks,
      icon: "check",
      foot: `${stats.totalTasks} total`,
    },
    {
      label: "Agents",
      value: dash ?? `${stats.activeAgents}/${stats.totalAgents}`,
      icon: "users",
      foot: stats.totalAgents ? `${stats.activeAgents} working now` : "none reported",
    },
    {
      label: "MCP servers",
      value: dash ?? `${stats.runningMCPs}/${stats.totalMCPs}`,
      icon: "chip",
      foot: stats.totalMCPs ? `${stats.runningMCPs} running` : "none reported",
    },
  ];
  if (stats.conflicts > 0) {
    items.push({ label: "Conflicts", value: stats.conflicts, icon: "alert", tone: "bad", foot: "need review" });
  }
  return items;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Navigation
// ══════════════════════════════════════════════════════════════════════════════

function renderTabNav(
  activeTab: FederationResourcesState["activeTab"],
  onSetActiveTab: (tab: FederationResourcesState["activeTab"]) => void,
  stats: Stats,
) {
  const tabs: Array<{ id: FederationResourcesState["activeTab"]; icon: SgIconName; label: string; count?: number }> = [
    { id: "overview", icon: "grid", label: "Overview" },
    { id: "gateways", icon: "server", label: "Gateways", count: stats.totalNodes },
    { id: "projects", icon: "layers", label: "Projects", count: stats.totalProjects },
    { id: "tasks", icon: "check", label: "Tasks", count: stats.totalTasks },
    { id: "agents", icon: "users", label: "Agents", count: stats.totalAgents },
    { id: "mcp", icon: "chip", label: "MCP", count: stats.totalMCPs },
    { id: "business", icon: "database", label: "Business" },
  ];

  return html`
    <div class="fed-tabs-wrap">
      <nav class="sg-seg fed-tabs" role="tablist" aria-label="Federation sections">
        ${tabs.map(tab => html`
          <button
            class="fed-tab ${activeTab === tab.id ? "active" : ""}"
            role="tab"
            aria-selected=${activeTab === tab.id ? "true" : "false"}
            @click=${() => onSetActiveTab(tab.id)}
          >
            ${sgIcon(tab.icon, 14)}
            <span class="fed-tab-label">${tab.label}</span>
            ${tab.count ? html`<span class="fed-tab-count">${tab.count}</span>` : nothing}
          </button>
        `)}
      </nav>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Overview Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderOverviewTab(props: FederationDashboardProps, stats: Stats) {
  const { resourcesState: state } = props;
  const isHub = props.federationState.mode === "master" || props.federationState.mode === "standalone";

  return html`
    <div class="fed-overview">
      <section class="sg-panel fed-section sg-enter">
        <h2 class="sg-section-head">Network Topology <span class="sg-count">${state.nodeGateways.length}</span></h2>
        ${state.nodeGateways.length === 0 ? sgEmpty({
          icon: "network",
          title: "No nodes connected yet",
          body: isHub
            ? "This device is ready to be the hub. Share an invite link with another machine running InfiniBot and it will appear here."
            : "Paste an invite token from your hub to join its federation.",
          action: isHub && props.onGenerateInvite
            ? html`<button class="sg-btn sg-btn--primary" @click=${props.onGenerateInvite}>${sgIcon("link", 15)} Share Invite</button>`
            : props.onOpenConnectWizard
              ? html`<button class="sg-btn sg-btn--primary" @click=${props.onOpenConnectWizard}>${sgIcon("plus", 15)} Connect Node</button>`
              : undefined,
        }) : html`
          <div class="fed-node-grid">
            ${state.nodeGateways.map(node => renderNodeCard(node, props, state.selectedNodeId === node.nodeId))}
          </div>
        `}
      </section>

      <div class="fed-overview-split">
        <section class="sg-panel fed-section sg-enter">
          <h2 class="sg-section-head">Quick Actions</h2>
          <div class="fed-quick-actions">
            ${isHub && props.onGenerateInvite ? renderActionCard({
              icon: "link",
              label: "Invite Node",
              meta: `${stats.onlineNodes}/${stats.totalNodes} online`,
              accent: true,
              title: "Generate a one-click invite link for a satellite to connect",
              onClick: props.onGenerateInvite,
            }) : nothing}
            ${!isHub && props.onOpenConnectWizard ? renderActionCard({
              icon: "plus",
              label: "Connect to Hub",
              meta: `${stats.onlineNodes}/${stats.totalNodes} online`,
              accent: true,
              title: "Paste an invite token from a hub to connect this device",
              onClick: props.onOpenConnectWizard,
            }) : nothing}
            ${renderActionCard({ icon: "layers", label: "Manage Projects", meta: `${stats.totalProjects}`, onClick: () => props.onSetActiveTab("projects") })}
            ${renderActionCard({ icon: "check", label: "View Tasks", meta: `${stats.pendingTasks} pending`, onClick: () => props.onSetActiveTab("tasks") })}
            ${renderActionCard({ icon: "users", label: "Agent Status", meta: `${stats.activeAgents} active`, onClick: () => props.onSetActiveTab("agents") })}
            ${renderActionCard({ icon: "chip", label: "MCP Servers", meta: `${stats.runningMCPs} running`, onClick: () => props.onSetActiveTab("mcp") })}
          </div>
        </section>

        <section class="sg-panel fed-section sg-enter">
          <h2 class="sg-section-head">Recent Sync Activity</h2>
          <ol class="fed-timeline">
            ${state.syncInProgress ? html`
              <li class="fed-tl-item">
                <span class="fed-tl-dot">${sgLed("gold")}</span>
                <div class="fed-tl-body">
                  <span class="fed-tl-text">Sync in progress</span>
                  <span class="fed-tl-time">now</span>
                </div>
              </li>
            ` : nothing}
            ${state.lastFullSync ? html`
              <li class="fed-tl-item">
                <span class="fed-tl-dot">${sgLed("ok")}</span>
                <div class="fed-tl-body">
                  <span class="fed-tl-text">Full sync completed</span>
                  <span class="fed-tl-time">${formatRelativeTime(state.lastFullSync)}</span>
                </div>
              </li>
            ` : html`
              <li class="fed-tl-item">
                <span class="fed-tl-dot">${sgLed("off")}</span>
                <div class="fed-tl-body">
                  <span class="fed-tl-text">No sync performed yet</span>
                  <span class="fed-tl-hint">Press <strong>Sync All</strong> to pull projects, tasks and agents from every node.</span>
                </div>
              </li>
            `}
            ${state.conflicts.slice(0, 3).map(c => html`
              <li class="fed-tl-item">
                <span class="fed-tl-dot">${sgLed("bad")}</span>
                <div class="fed-tl-body">
                  <span class="fed-tl-text">Conflict · ${c.resourceName}</span>
                  <span class="fed-tl-time">${formatRelativeTime(c.timestamp)}</span>
                </div>
              </li>
            `)}
            ${state.projects.slice(0, 3).map(p => html`
              <li class="fed-tl-item">
                <span class="fed-tl-dot">${sgLed(syncLedTone(p.syncStatus))}</span>
                <div class="fed-tl-body">
                  <span class="fed-tl-text">${p.name}</span>
                  ${syncChip(p.syncStatus)}
                </div>
              </li>
            `)}
          </ol>
        </section>
      </div>
    </div>
  `;
}

function renderActionCard(o: { icon: SgIconName; label: string; meta: string; accent?: boolean; title?: string; onClick: () => void }) {
  return html`
    <button
      class="sg-card sg-card--interactive fed-action-btn ${o.accent ? "fed-action-btn--accent" : ""}"
      title=${o.title ?? o.label}
      @pointermove=${sgGloss}
      @click=${o.onClick}
    >
      <span class="fed-action-icon">${sgIcon(o.icon, 18)}</span>
      <span class="fed-action-text">
        <span class="fed-action-label">${o.label}</span>
        <span class="fed-action-count">${o.meta}</span>
      </span>
      <span class="fed-action-arrow">${sgIcon("chevron", 14)}</span>
    </button>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Node Gateways Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderSectionHead(title: string, sub: string, count?: number) {
  return html`
    <div class="fed-section-header">
      <h2 class="sg-section-head">${title}${count !== undefined ? html` <span class="sg-count">${count}</span>` : nothing}</h2>
      <p class="fed-section-sub">${sub}</p>
    </div>
  `;
}

function renderGatewaysTab(props: FederationDashboardProps) {
  const { resourcesState: state } = props;

  return html`
    <section class="sg-panel fed-gateways sg-enter">
      ${renderSectionHead("Node Gateway Access", "Connect directly to each node's gateway for full control", state.nodeGateways.length)}

      ${state.nodeGateways.length === 0 ? sgEmpty({
        icon: "server",
        title: "No gateways available",
        body: "Gateways appear here once nodes join the federation. Invite a satellite or connect to a hub to get started.",
      }) : html`
        <div class="fed-gateway-grid">
          ${state.nodeGateways.map(gateway => renderGatewayCard(gateway, props))}
        </div>
      `}
    </section>
  `;
}

function renderGatewayCard(gateway: NodeGatewayInfo, props: FederationDashboardProps) {
  const isSelected = props.resourcesState.selectedNodeId === gateway.nodeId;
  const loadMetrics = (gateway as any).loadMetrics as { cpuPercent?: number; memoryPercent?: number; gpuPercent?: number; loadScore?: number; activeSessions?: number } | undefined;
  const loadScore = loadMetrics?.loadScore ?? (gateway as any).currentLoad;

  return html`
    <article class="sg-card fed-gateway-card ${gateway.connected ? "connected" : "offline"} ${isSelected ? "selected" : ""}">
      <div class="fed-gateway-top">
        <span class="fed-gateway-status">${sgLed(gateway.connected ? "ok" : "off")} ${gateway.connected ? "Online" : "Offline"}</span>
        <span class="sg-spacer"></span>
        ${gateway.latency ? sgChip(`${gateway.latency}ms`, latencyTone(gateway.latency)) : nothing}
        ${loadScore !== undefined ? sgChip(`${Math.round(loadScore)}% load`, loadTone(loadScore)) : nothing}
      </div>

      <div class="fed-gateway-body">
        <div class="fed-gateway-name">${gateway.nodeName}</div>
        <div class="fed-gateway-url sg-mono">${gateway.gatewayUrl || gateway.nodeId}</div>

        ${loadMetrics ? html`
          <div class="fed-gateway-load">
            ${renderLoadMeter("CPU", loadMetrics.cpuPercent ?? 0)}
            ${renderLoadMeter("MEM", loadMetrics.memoryPercent ?? 0)}
            ${loadMetrics.gpuPercent !== undefined ? renderLoadMeter("GPU", loadMetrics.gpuPercent) : nothing}
            ${loadMetrics.activeSessions !== undefined ? html`<span class="fed-sessions-tag">${loadMetrics.activeSessions} sessions</span>` : nothing}
          </div>
        ` : nothing}

        <dl class="fed-gateway-meta">
          <div><dt>Port</dt><dd>${gateway.gatewayPort}</dd></div>
          <div><dt>Version</dt><dd>${gateway.version || "N/A"}</dd></div>
          <div><dt>Agents</dt><dd>${gateway.agents.length}</dd></div>
          <div><dt>MCP</dt><dd>${gateway.mcpServers.length}</dd></div>
        </dl>

        ${renderCaps(gateway)}
      </div>

      <div class="fed-gateway-actions">
        <button
          class="sg-btn sg-btn--sm ${isSelected ? "fed-btn--active" : "sg-btn--primary"}"
          ?disabled=${!gateway.connected}
          @click=${() => props.onConnectToNode(gateway.nodeId)}
        >
          ${isSelected ? html`${sgIcon("check", 13)} Connected` : html`${sgIcon("link", 13)} Connect`}
        </button>
        <button
          class="sg-btn sg-btn--sm"
          ?disabled=${!gateway.connected}
          @click=${() => props.onSelectNode(gateway.nodeId)}
        >
          Details
        </button>
        ${props.onOpenDevice && !isLocalNode(gateway.nodeId, props.federationState.localNodeId)
          ? html`<button
              class="sg-btn sg-btn--sm"
              ?disabled=${!gateway.connected}
              @click=${() => props.onOpenDevice?.(gateway.nodeId, gateway.nodeName)}
            >${sgIcon("server", 13)} Control device</button>`
          : nothing}
      </div>

      ${isSelected && gateway.connected ? html`
        <div class="fed-gateway-quick">
          <button class="sg-btn sg-btn--sm sg-btn--ghost" @click=${() => props.onInvokeOnNode(gateway.nodeId, "status", {})}>${sgIcon("activity", 13)} Status</button>
          <button class="sg-btn sg-btn--sm sg-btn--ghost" @click=${() => props.onInvokeOnNode(gateway.nodeId, "sessions.list", {})}>${sgIcon("layers", 13)} Sessions</button>
          <button class="sg-btn sg-btn--sm sg-btn--ghost" @click=${() => props.onInvokeOnNode(gateway.nodeId, "mcp.list", {})}>${sgIcon("chip", 13)} MCP List</button>
        </div>
      ` : nothing}
    </article>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Projects Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderProjectsTab(props: FederationDashboardProps) {
  const { resourcesState: state } = props;

  return html`
    <section class="sg-panel fed-projects sg-enter">
      ${renderSectionHead("Shared Projects", "Projects synced across your federation", state.projects.length)}

      ${state.projects.length === 0 ? sgEmpty({
        icon: "layers",
        title: "No projects found",
        body: "Create a project on the Kanban board, then share it here so every node can see and work on it.",
      }) : html`
        <div class="fed-project-list">
          ${state.projects.map(project => renderProjectCard(project, props))}
        </div>
      `}
    </section>
  `;
}

function renderProjectCard(project: SharedProject, props: FederationDashboardProps) {
  const isShared = project.sharedWith.length > 0;
  const nodes = props.resourcesState.nodeGateways;

  return html`
    <article class="sg-card fed-project-card">
      <div class="fed-project-top">
        <div class="fed-project-name">${project.name}</div>
        <div class="fed-project-badges">
          ${syncChip(project.syncStatus)}
          ${isShared ? sgChip("Shared", "gold") : nothing}
        </div>
      </div>

      ${project.description ? html`<div class="fed-project-desc">${project.description}</div>` : nothing}

      <div class="fed-project-meta">
        <span>${sgIcon("server", 12)} ${project.sourceNode}</span>
        <span>${sgIcon("check", 12)} ${project.taskCount ?? 0} tasks</span>
        <span>${sgIcon("refresh", 12)} ${formatRelativeTime(project.lastSync)}</span>
      </div>

      ${isShared ? html`
        <div class="fed-project-shared-with">
          ${project.sharedWith.map(nodeId => {
            const node = nodes.find(n => n.nodeId === nodeId);
            return sgChip(node?.nodeName ?? nodeId);
          })}
        </div>
      ` : html`
        <div>
          <button class="sg-btn sg-btn--sm" @click=${() => openShareDialog(project.id, nodes)}>
            ${sgIcon("upload", 13)} Share to Federation
          </button>
        </div>
      `}
    </article>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tasks Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderTasksTab(props: FederationDashboardProps) {
  const { resourcesState: state } = props;
  const grouped = {
    todo: state.tasks.filter(t => t.status === "todo" || t.status === "backlog"),
    in_progress: state.tasks.filter(t => t.status === "in_progress"),
    review: state.tasks.filter(t => t.status === "review"),
    done: state.tasks.filter(t => t.status === "done"),
  };

  return html`
    <section class="sg-panel fed-tasks sg-enter">
      ${renderSectionHead("Federated Tasks", "Tasks distributed across nodes", state.tasks.length)}

      <div class="fed-task-board">
        ${renderTaskColumn("To Do", "off", grouped.todo, props)}
        ${renderTaskColumn("In Progress", "gold", grouped.in_progress, props)}
        ${renderTaskColumn("Review", "warn", grouped.review, props)}
        ${renderTaskColumn("Done", "ok", grouped.done, props)}
      </div>
    </section>
  `;
}

function renderTaskColumn(title: string, tone: SgTone, tasks: SharedTask[], props: FederationDashboardProps) {
  return html`
    <div class="fed-task-column">
      <div class="fed-task-column-header">
        ${sgLed(tone)}
        <span class="fed-task-column-title">${title}</span>
        <span class="fed-task-column-count">${tasks.length}</span>
      </div>
      <div class="fed-task-column-body">
        ${tasks.map(task => renderTaskCard(task, props))}
        ${tasks.length === 0 ? html`<div class="fed-task-empty">No tasks</div>` : nothing}
      </div>
    </div>
  `;
}

function renderTaskCard(task: SharedTask, props: FederationDashboardProps) {
  const nodes = props.resourcesState.nodeGateways;
  const agents = props.resourcesState.agents;
  const sourceNode = nodes.find(n => n.nodeId === task.sourceNode);
  const prioTone: ChipTone | undefined =
    task.priority === "urgent" || task.priority === "critical" ? "bad" : task.priority === "high" ? "warn" : task.priority === "medium" ? "gold" : undefined;

  return html`
    <div class="sg-card fed-task-card">
      <div class="fed-task-title">${task.title}</div>
      <div class="fed-task-meta">
        ${sgChip(task.priority, prioTone)}
        ${syncChip(task.syncStatus)}
      </div>
      ${task.projectName ? html`<div class="fed-task-project">${sgIcon("layers", 12)} ${task.projectName}</div>` : nothing}
      <div class="fed-task-assignment">
        <span class="fed-task-source">${sgIcon("server", 12)} ${sourceNode?.nodeName ?? task.sourceNode}</span>
        ${task.assignedAgent ? sgChip(task.assignedAgent, "gold") : html`
          <select
            class="sg-input fed-task-assign-select"
            aria-label="Assign task"
            @change=${(e: Event) => {
              const select = e.target as HTMLSelectElement;
              const [nodeId, agentId] = select.value.split(":");
              if (nodeId) props.onAssignTask(task.id, nodeId, agentId || undefined);
            }}
          >
            <option value="">Assign to...</option>
            ${agents.map(a => html`
              <option value="${a.nodeId}:${a.id}">${a.name || a.id} (${a.nodeName})</option>
            `)}
          </select>
        `}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Agents Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderAgentsTab(props: FederationDashboardProps) {
  const { resourcesState: state } = props;
  const byNode = new Map<string, FederatedAgent[]>();
  for (const agent of state.agents) {
    const existing = byNode.get(agent.nodeId) ?? [];
    existing.push(agent);
    byNode.set(agent.nodeId, existing);
  }

  return html`
    <section class="sg-panel fed-agents sg-enter">
      ${renderSectionHead("Federated Agents", "All agents across your network", state.agents.length)}

      ${state.agents.length === 0 ? sgEmpty({
        icon: "users",
        title: "No agents found",
        body: "Agents configured on any connected node show up here, grouped by the machine they run on.",
      }) : html`
        <div class="fed-agents-grid">
          ${[...byNode.entries()].map(([nodeId, agents]) => {
            const node = state.nodeGateways.find(n => n.nodeId === nodeId);
            return renderNodeAgentsGroup(node?.nodeName ?? nodeId, agents);
          })}
        </div>
      `}
    </section>
  `;
}

function renderNodeAgentsGroup(nodeName: string, agents: FederatedAgent[]) {
  return html`
    <div class="fed-agents-group">
      <div class="fed-agents-group-header">
        ${sgIcon("server", 13)}
        <span class="fed-agents-group-name">${nodeName}</span>
        <span class="fed-agents-group-count">${agents.length}</span>
      </div>
      <div class="fed-agents-list">
        ${agents.map(agent => renderAgentCard(agent))}
      </div>
    </div>
  `;
}

function renderAgentCard(agent: FederatedAgent) {
  const tone: SgTone =
    agent.status === "active" ? "ok" : agent.status === "busy" ? "warn" : agent.status === "offline" ? "bad" : "off";
  const chipTone: ChipTone | undefined = tone === "off" ? undefined : (tone as ChipTone);

  return html`
    <div class="sg-card fed-agent-card">
      <div class="fed-agent-header">
        <div class="fed-agent-avatar fed-tone-${tone}">${sgIcon("user", 16)}</div>
        <div class="fed-agent-info">
          <div class="fed-agent-name">${agent.name || agent.id}</div>
          <div class="fed-agent-id sg-mono">${agent.id}</div>
        </div>
        ${sgChip(agent.status, chipTone, true)}
      </div>
      ${agent.specialties?.length ? html`
        <div class="fed-agent-specialties">
          ${agent.specialties.map(s => sgChip(s))}
        </div>
      ` : nothing}
      <div class="fed-agent-meta">
        <span>${agent.activeSessions} sessions</span>
        ${agent.currentTask ? html`<span class="fed-agent-task">${agent.currentTask}</span>` : nothing}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// MCP Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderMCPTab(props: FederationDashboardProps) {
  const { resourcesState: state } = props;

  return html`
    <section class="sg-panel fed-mcp sg-enter">
      ${renderSectionHead("Federated MCP Servers", "Model Context Protocol servers across the network", state.mcpServers.length)}

      ${state.mcpServers.length === 0 ? sgEmpty({
        icon: "chip",
        title: "No MCP servers found",
        body: "Configure MCP servers on any node, then share them to the federation so every device can call their tools.",
      }) : html`
        <div class="fed-mcp-grid">
          ${state.mcpServers.map(mcp => renderMCPCard(mcp, props))}
        </div>
      `}
    </section>
  `;
}

function renderMCPCard(mcp: FederatedMCP, props: FederationDashboardProps) {
  const tone: SgTone = mcp.status === "running" ? "ok" : mcp.status === "error" ? "bad" : mcp.status === "configured" ? "gold" : "off";
  const chipTone: ChipTone | undefined = tone === "off" ? undefined : (tone as ChipTone);

  return html`
    <div class="sg-card fed-mcp-card">
      <div class="fed-mcp-header">
        <div class="fed-mcp-icon fed-tone-${tone}">${sgIcon("chip", 17)}</div>
        <div class="fed-mcp-info">
          <div class="fed-mcp-name">${mcp.name}</div>
          <div class="fed-mcp-node">${mcp.nodeName}</div>
        </div>
        ${sgChip(mcp.status, chipTone, true)}
      </div>

      ${mcp.description ? html`<div class="fed-mcp-desc">${mcp.description}</div>` : nothing}

      ${mcp.tools.length > 0 ? html`
        <div class="fed-mcp-tools">
          <div class="fed-mcp-tools-label">Tools · ${mcp.tools.length}</div>
          <div class="fed-mcp-tools-list">
            ${mcp.tools.slice(0, 5).map(t => html`<span class="fed-tool-chip sg-mono">${t}</span>`)}
            ${mcp.tools.length > 5 ? html`<span class="fed-tool-chip more">+${mcp.tools.length - 5}</span>` : nothing}
          </div>
        </div>
      ` : nothing}

      <label class="fed-switch">
        <input type="checkbox" ?checked=${mcp.sharedToFederation} @change=${(e: Event) => props.onShareMCP(mcp.id, (e.target as HTMLInputElement).checked)} />
        <span class="fed-switch-track" aria-hidden="true"><i></i></span>
        <span>Share to Federation</span>
      </label>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Business Tab
// ══════════════════════════════════════════════════════════════════════════════

function renderBusinessTab(props: FederationDashboardProps) {
  const { resourcesState: state } = props;

  return html`
    <section class="sg-panel fed-business sg-enter">
      ${renderSectionHead("Business Data Sources", "Shared business databases across nodes", state.businessSources.length)}

      ${state.businessSources.length === 0 ? sgEmpty({
        icon: "database",
        title: "No business sources",
        body: "Turn on business data tracking in the Business hub and its sources will be listed here for sharing.",
      }) : html`
        <div class="fed-business-grid">
          ${state.businessSources.map(source => renderBusinessSourceCard(source))}
        </div>
      `}
    </section>
  `;
}

function renderBusinessSourceCard(source: FederatedBusinessSource) {
  return html`
    <div class="sg-card fed-business-card">
      <div class="fed-business-header">
        <div class="fed-business-name">${source.name}</div>
        ${syncChip(source.status)}
      </div>
      <div class="fed-business-meta">
        <span>Type <strong>${source.type}</strong></span>
        <span>Node <strong>${source.nodeName}</strong></span>
        ${source.recordCount !== undefined ? html`<span>Records <strong>${source.recordCount}</strong></span>` : nothing}
        <span>Synced <strong>${formatRelativeTime(source.lastSync)}</strong></span>
      </div>
      <div class="fed-business-shared">
        ${source.sharedToFederation ? sgChip(html`${sgIcon("globe", 12)} Shared`, "gold") : sgChip(html`${sgIcon("lock", 12)} Private`)}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Node Card (overview)
// ══════════════════════════════════════════════════════════════════════════════

function renderNodeCard(node: NodeGatewayInfo, props: FederationDashboardProps, isSelected: boolean) {
  const isLocal = isLocalNode(node.nodeId, props.federationState.localNodeId);
  const open = () => (props.onOpenNodeDetails ? props.onOpenNodeDetails(node) : props.onSelectNode(node.nodeId));
  return html`
    <div
      class="sg-card sg-card--interactive fed-node-card ${node.connected ? "online" : "offline"} ${isSelected ? "selected" : ""}"
      role="button"
      tabindex="0"
      aria-label="${node.nodeName}, ${node.connected ? "online" : "offline"}. Open details"
      @pointermove=${sgGloss}
      @click=${open}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <div class="fed-node-card-top">
        <span class="fed-node-glyph">${sgIcon(isLocal ? "cpu" : "server", 18)}</span>
        <span class="sg-spacer"></span>
        ${isLocal ? sgChip("Master", "gold") : sgChip("Satellite")}
      </div>
      <div class="fed-node-name">${sgLed(node.connected ? "ok" : "off")} <span>${node.nodeName}</span></div>
      <div class="fed-node-id sg-mono">${node.nodeId.substring(0, 20)}${node.nodeId.length > 20 ? "..." : ""}</div>

      ${renderCaps(node, true)}

      <div class="fed-node-quick-stats">
        <span>${sgIcon("users", 12)} ${node.agents?.length ?? 0} agents</span>
        <span>${sgIcon("chip", 12)} ${node.mcpServers?.length ?? 0} MCP</span>
        ${node.latency ? html`<span class="fed-latency-inline ${latencyTone(node.latency)}">${node.latency}ms</span>` : nothing}
      </div>
      ${!isLocal && node.connected && props.onOpenDevice
        ? html`<button
            class="sg-btn sg-btn--sm sg-btn--primary fed-device-btn"
            data-device-control=${node.nodeId}
            @click=${(e: Event) => {
              e.stopPropagation();
              props.onOpenDevice?.(node.nodeId, node.nodeName);
            }}
          >${sgIcon("server", 13)} Control device</button>`
        : nothing}
    </div>
  `;
}

function renderCaps(node: NodeGatewayInfo, short = false) {
  const caps = node.capabilities;
  if (!caps?.gpu && !caps?.hasOllama && !caps?.hasVoice && !caps?.hasComfyUI) return nothing;
  return html`
    <div class="fed-node-caps">
      ${caps?.gpu ? html`<span class="fed-cap-pill" title=${caps.gpu}>${sgIcon("chip", 11)} ${short ? "GPU" : caps.gpu}</span>` : nothing}
      ${caps?.hasOllama ? html`<span class="fed-cap-pill">${sgIcon("spark", 11)} Ollama</span>` : nothing}
      ${caps?.hasVoice ? html`<span class="fed-cap-pill">${sgIcon("activity", 11)} Voice</span>` : nothing}
      ${caps?.hasComfyUI ? html`<span class="fed-cap-pill">${sgIcon("palette", 11)} ${short ? "Comfy" : "ComfyUI"}</span>` : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

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

function openShareDialog(projectId: string, nodes: NodeGatewayInfo[]) {
  console.log("Open share dialog for", projectId, "with nodes", nodes);
}

/** The resources controller labels this device "local" when it has no id yet. */
function isLocalNode(nodeId: string, localNodeId: string | null): boolean {
  return nodeId === "local" || (!!localNodeId && nodeId === localNodeId);
}

function syncLedTone(s: SyncStatus | string): SgTone {
  if (s === "synced") return "ok";
  if (s === "pending") return "warn";
  if (s === "conflict" || s === "error") return "bad";
  return "off";
}

function syncChip(s: SyncStatus | string): TemplateResult {
  const tone = syncLedTone(s);
  return sgChip(s, tone === "off" ? undefined : (tone as ChipTone), tone !== "off");
}

function latencyTone(ms: number): ChipTone {
  return ms < 100 ? "ok" : ms < 500 ? "warn" : "bad";
}

function loadTone(percent: number): ChipTone {
  return percent >= 80 ? "bad" : percent >= 60 ? "warn" : "ok";
}

function renderLoadMeter(label: string, percent: number) {
  return html`
    <div class="fed-load-meter">
      <span class="fed-load-meter-label">${label}</span>
      <div class="fed-load-meter-bar">${sgMeter(percent / 100, percent >= 80 ? "bad" : percent >= 60 ? "warn" : undefined)}</div>
      <span class="fed-load-meter-value">${Math.round(percent)}%</span>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles (page-scoped; the shared surfaces come from system-glass)
// ══════════════════════════════════════════════════════════════════════════════

function renderStyles() {
  return html`
    <style>
      .sg-fed { padding: clamp(12px, 2vw, 24px); padding-bottom: 40px; }
      .sg-fed .fed-ico { display: inline-flex; }
      .sg-fed .fed-spin { animation: fed-spin 1s linear infinite; }
      @keyframes fed-spin { to { transform: rotate(360deg); } }

      /* Alert */
      /* Node meter in the hero follows the node-health tone (full = healthy). */

      .sg-fed .fed-alert {
        display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: var(--sg-radius-md);
        color: var(--sg-bad); font-size: 13px;
        background: color-mix(in srgb, var(--sg-bad) 10%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-bad) 28%, transparent);
      }

      /* Master panel */
      .sg-fed .fed-master-header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
      .sg-fed .fed-master-badge {
        flex: none; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 14px;
        color: var(--sg-gold); background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
        box-shadow: inset 0 0 0 1px var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), var(--glass-glow-soft, none);
      }
      .sg-fed .fed-master-badge.is-satellite { color: var(--sg-info); background: color-mix(in srgb, var(--sg-info) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-info) 26%, transparent); }
      .sg-fed .fed-master-copy { flex: 1 1 260px; min-width: 0; }
      .sg-fed .fed-master-label { display: flex; align-items: center; gap: 9px; color: var(--sg-fg); font-size: 15px; font-weight: 640; letter-spacing: -0.012em; }
      .sg-fed .fed-master-desc { margin-top: 4px; color: var(--sg-fg-2); font-size: 13px; overflow-wrap: anywhere; }
      .sg-fed .fed-master-desc strong { color: var(--sg-fg); font-variant-numeric: tabular-nums; }
      .sg-fed .fed-code {
        padding: 2px 8px; border-radius: 6px; font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 12px; color: var(--sg-fg);
        background: var(--glass-hover, rgba(255, 255, 255, 0.05)); box-shadow: inset 0 0 0 1px var(--glass-stroke);
      }
      .sg-fed .fed-master-status-row { display: flex; flex-wrap: wrap; gap: 8px; }
      .sg-fed .fed-status-item {
        display: inline-flex; align-items: center; gap: 7px; padding: 6px 11px; border-radius: 999px;
        color: var(--sg-fg-3); font-size: 12px; white-space: nowrap;
        background: var(--glass-hover, rgba(255, 255, 255, 0.04)); box-shadow: inset 0 0 0 1px var(--glass-stroke);
      }
      .sg-fed .fed-status-item .sg-ico { color: var(--sg-gold); }
      .sg-fed .fed-status-item strong { color: var(--sg-fg); font-weight: 600; text-transform: capitalize; }
      .sg-fed .fed-status-text.ok { color: var(--sg-ok); font-weight: 600; }
      .sg-fed .fed-status-text.warn { color: var(--sg-warn); font-weight: 600; }
      .sg-fed .fed-status-text.bad { color: var(--sg-bad); font-weight: 600; }
      .sg-fed .fed-master-switch-bar {
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
        margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08));
      }
      .sg-fed .fed-switch-label { color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
      .sg-fed .fed-switch-nodes { display: flex; gap: 8px; flex-wrap: wrap; min-width: 0; }
      .sg-fed .fed-switch-node-btn { max-width: 100%; }
      .sg-fed .fed-switch-latency { color: var(--sg-fg-3); font-family: var(--glass-font-mono, monospace); font-size: 10.5px; }
      .sg-fed .fed-switch-more { color: var(--sg-fg-3); font-size: 12px; padding: 5px 4px; }

      /* Segmented sub-tabs */
      .sg-fed .fed-tabs-wrap { display: flex; min-width: 0; }
      .sg-fed .fed-tab-count {
        min-width: 18px; padding: 2px 6px; border-radius: 99px; font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums;
        color: var(--sg-fg-3); background: var(--glass-hover, rgba(255, 255, 255, 0.06));
      }
      .sg-fed .fed-tab.active .fed-tab-count { color: var(--sg-gold); background: var(--glass-gold-a10); }

      .sg-fed .fed-content { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
      .sg-fed .fed-overview { display: flex; flex-direction: column; gap: 18px; }
      .sg-fed .fed-overview-split { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 18px; align-items: start; }
      .sg-fed .fed-section-header { margin-bottom: 14px; }
      .sg-fed .fed-section-header .sg-section-head { margin-bottom: 4px; }
      .sg-fed .fed-section-sub { margin: 0; color: var(--sg-fg-3); font-size: 12.5px; }
      .sg-fed .fed-loading { display: grid; gap: 16px; }

      /* Topology node cards */
      .sg-fed .fed-node-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
      .sg-fed .fed-node-card { display: flex; flex-direction: column; gap: 6px; outline: none; }
      .sg-fed .fed-node-card.offline { opacity: 0.66; }
      .sg-fed .fed-node-card.selected { box-shadow: var(--glass-elev-2, none), inset 0 0 0 1px var(--glass-stroke-gold, rgba(217, 180, 95, 0.4)), var(--glass-glow-soft, none); }
      .sg-fed .fed-node-card:focus-visible { box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--sg-gold)); }
      .sg-fed .fed-node-card-top { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .sg-fed .fed-node-glyph {
        display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; color: var(--sg-gold);
        background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1)); box-shadow: inset 0 0 0 1px var(--glass-gold-a24, rgba(217, 180, 95, 0.24));
      }
      .sg-fed .fed-node-name { display: flex; align-items: center; gap: 9px; color: var(--sg-fg); font-size: 15px; font-weight: 640; letter-spacing: -0.015em; min-width: 0; }
      .sg-fed .fed-node-name > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sg-fed .fed-node-id { color: var(--sg-fg-4); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sg-fed .fed-node-caps { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
      .sg-fed .fed-cap-pill {
        display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 99px; font-size: 10.5px; font-weight: 600;
        color: var(--sg-gold); background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06)); box-shadow: inset 0 0 0 1px var(--glass-gold-a16, rgba(217, 180, 95, 0.16));
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .sg-fed .fed-device-btn { margin-top: 10px; width: 100%; justify-content: center; }
      .sg-fed .fed-node-quick-stats {
        display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; padding-top: 10px;
        border-top: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.07)); color: var(--sg-fg-3); font-size: 11.5px;
      }
      .sg-fed .fed-node-quick-stats > span { display: inline-flex; align-items: center; gap: 5px; }
      .sg-fed .fed-latency-inline { margin-left: auto; font-family: var(--glass-font-mono, monospace); font-weight: 600; }
      .sg-fed .fed-latency-inline.ok { color: var(--sg-ok); }
      .sg-fed .fed-latency-inline.warn { color: var(--sg-warn); }
      .sg-fed .fed-latency-inline.bad { color: var(--sg-bad); }

      /* Quick actions */
      .sg-fed .fed-quick-actions { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
      .sg-fed .fed-action-btn {
        display: flex; align-items: center; gap: 12px; width: 100%; padding: 13px 14px; border: 0; text-align: left;
        color: var(--sg-fg); font: inherit;
      }
      .sg-fed .fed-action-icon {
        flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; color: var(--sg-gold);
        background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1)); box-shadow: inset 0 0 0 1px var(--glass-gold-a24, rgba(217, 180, 95, 0.24));
      }
      .sg-fed .fed-action-btn--accent .fed-action-icon { color: var(--glass-ink, #0b0906); background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: 0 8px 18px -8px var(--glass-gold-a40, rgba(217, 180, 95, 0.4)); }
      .sg-fed .fed-action-btn--accent::before { background: var(--glass-edge, rgba(217, 180, 95, 0.3)); }
      .sg-fed .fed-action-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
      .sg-fed .fed-action-label { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sg-fed .fed-action-count { color: var(--sg-fg-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
      .sg-fed .fed-action-arrow { color: var(--sg-fg-4); transition: transform var(--sg-dur) var(--sg-ease), color var(--sg-dur); }
      .sg-fed .fed-action-btn:hover .fed-action-arrow { color: var(--sg-gold); transform: translateX(2px); }

      /* Sync timeline */
      .sg-fed .fed-timeline { position: relative; list-style: none; margin: 0; padding: 0 0 0 4px; display: grid; gap: 4px; }
      .sg-fed .fed-timeline::before {
        content: ""; position: absolute; left: 11px; top: 10px; bottom: 10px; width: 1px;
        background: linear-gradient(180deg, var(--glass-stroke-gold, rgba(217, 180, 95, 0.3)), var(--glass-stroke, transparent));
      }
      .sg-fed .fed-tl-item { position: relative; display: flex; align-items: flex-start; gap: 14px; padding: 8px 0; }
      .sg-fed .fed-tl-dot { position: relative; z-index: 1; display: grid; place-items: center; width: 15px; height: 20px; flex: none; }
      .sg-fed .fed-tl-body { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; flex: 1; min-width: 0; }
      .sg-fed .fed-tl-text { color: var(--sg-fg); font-size: 13px; font-weight: 560; overflow-wrap: anywhere; }
      .sg-fed .fed-tl-time { margin-left: auto; color: var(--sg-fg-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
      .sg-fed .fed-tl-body .sg-chip { margin-left: auto; }
      .sg-fed .fed-tl-hint { flex-basis: 100%; color: var(--sg-fg-3); font-size: 12px; line-height: 1.5; }
      .sg-fed .fed-tl-hint strong { color: var(--sg-gold); font-weight: 600; }

      /* Gateways */
      .sg-fed .fed-gateway-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
      .sg-fed .fed-gateway-card { display: flex; flex-direction: column; gap: 12px; }
      .sg-fed .fed-gateway-card.offline { opacity: 0.7; }
      .sg-fed .fed-gateway-card.selected { box-shadow: var(--glass-elev-2, none), inset 0 0 0 1px var(--glass-stroke-gold), var(--glass-glow-soft, none); }
      .sg-fed .fed-gateway-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .sg-fed .fed-gateway-status { display: inline-flex; align-items: center; gap: 8px; color: var(--sg-fg-2); font-size: 11px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; }
      .sg-fed .fed-gateway-name { color: var(--sg-fg); font-size: 16px; font-weight: 640; letter-spacing: -0.015em; }
      .sg-fed .fed-gateway-url { margin-top: 2px; color: var(--sg-fg-3); font-size: 11.5px; overflow-wrap: anywhere; }
      .sg-fed .fed-gateway-load { display: grid; gap: 6px; margin-top: 12px; }
      .sg-fed .fed-load-meter { display: grid; grid-template-columns: 36px 1fr 38px; align-items: center; gap: 10px; }
      .sg-fed .fed-load-meter .sg-meter { margin-top: 0; }
      .sg-fed .fed-load-meter-label { color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; }
      .sg-fed .fed-load-meter-value { color: var(--sg-fg-2); font-size: 11.5px; text-align: right; font-variant-numeric: tabular-nums; }
      .sg-fed .fed-sessions-tag { color: var(--sg-fg-3); font-size: 11.5px; }
      .sg-fed .fed-gateway-meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 12px 0 0; }
      .sg-fed .fed-gateway-meta > div { padding: 8px 10px; border-radius: 10px; background: var(--glass-hover, rgba(255, 255, 255, 0.04)); min-width: 0; }
      .sg-fed .fed-gateway-meta dt { color: var(--sg-fg-3); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
      .sg-fed .fed-gateway-meta dd { margin: 3px 0 0; color: var(--sg-fg); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sg-fed .fed-gateway-actions, .sg-fed .fed-gateway-quick { display: flex; gap: 8px; flex-wrap: wrap; }
      .sg-fed .fed-gateway-quick { padding-top: 10px; border-top: 1px solid var(--glass-stroke); }
      .sg-fed .fed-btn--active { color: var(--sg-ok); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-ok) 40%, transparent); }

      /* Projects */
      .sg-fed .fed-project-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
      .sg-fed .fed-project-card { display: flex; flex-direction: column; gap: 10px; }
      .sg-fed .fed-project-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .sg-fed .fed-project-name { color: var(--sg-fg); font-size: 14.5px; font-weight: 640; min-width: 0; overflow-wrap: anywhere; }
      .sg-fed .fed-project-badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .sg-fed .fed-project-desc { color: var(--sg-fg-2); font-size: 12.5px; line-height: 1.5; }
      .sg-fed .fed-project-meta { display: flex; flex-wrap: wrap; gap: 14px; color: var(--sg-fg-3); font-size: 11.5px; }
      .sg-fed .fed-project-meta > span { display: inline-flex; align-items: center; gap: 5px; }
      .sg-fed .fed-project-shared-with { display: flex; flex-wrap: wrap; gap: 6px; }

      /* Tasks */
      .sg-fed .fed-task-board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
      .sg-fed .fed-task-column {
        display: flex; flex-direction: column; min-width: 0; border-radius: var(--sg-radius-md);
        background: var(--glass-hover, rgba(255, 255, 255, 0.03)); box-shadow: inset 0 0 0 1px var(--glass-stroke);
      }
      .sg-fed .fed-task-column-header { display: flex; align-items: center; gap: 9px; padding: 12px 14px; border-bottom: 1px solid var(--glass-stroke); }
      .sg-fed .fed-task-column-title { flex: 1; color: var(--sg-fg-2); font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
      .sg-fed .fed-task-column-count { color: var(--sg-gold); font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; }
      .sg-fed .fed-task-column-body { display: flex; flex-direction: column; gap: 8px; padding: 10px; min-height: 90px; }
      .sg-fed .fed-task-empty { padding: 18px 8px; text-align: center; color: var(--sg-fg-4); font-size: 12px; }
      .sg-fed .fed-task-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; }
      .sg-fed .fed-task-title { color: var(--sg-fg); font-size: 13px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
      .sg-fed .fed-task-meta { display: flex; gap: 5px; flex-wrap: wrap; }
      .sg-fed .fed-task-project, .sg-fed .fed-task-source { display: inline-flex; align-items: center; gap: 5px; color: var(--sg-fg-3); font-size: 11.5px; min-width: 0; }
      .sg-fed .fed-task-assignment { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: space-between; }
      .sg-fed .fed-task-assign-select { width: auto; max-width: 100%; min-height: 30px; padding: 4px 8px; font-size: 12px; }

      /* Agents */
      .sg-fed .fed-agents-grid { display: grid; gap: 18px; }
      .sg-fed .fed-agents-group-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; color: var(--sg-gold); }
      .sg-fed .fed-agents-group-name { color: var(--sg-fg); font-size: 13.5px; font-weight: 640; }
      .sg-fed .fed-agents-group-count { color: var(--sg-fg-3); font-size: 12px; font-variant-numeric: tabular-nums; }
      .sg-fed .fed-agents-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
      .sg-fed .fed-agent-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; }
      .sg-fed .fed-agent-header { display: flex; align-items: center; gap: 10px; }
      .sg-fed .fed-agent-avatar, .sg-fed .fed-mcp-icon {
        flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px;
        color: var(--tone); background: color-mix(in srgb, var(--tone) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 28%, transparent);
      }
      .sg-fed .fed-tone-ok { --tone: var(--sg-ok); }
      .sg-fed .fed-tone-warn { --tone: var(--sg-warn); }
      .sg-fed .fed-tone-bad { --tone: var(--sg-bad); }
      .sg-fed .fed-tone-gold { --tone: var(--sg-gold); }
      .sg-fed .fed-tone-off { --tone: var(--sg-fg-3); }
      .sg-fed .fed-agent-info, .sg-fed .fed-mcp-info { flex: 1; min-width: 0; }
      .sg-fed .fed-agent-name, .sg-fed .fed-mcp-name { color: var(--sg-fg); font-size: 13.5px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sg-fed .fed-agent-id, .sg-fed .fed-mcp-node { color: var(--sg-fg-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sg-fed .fed-agent-specialties { display: flex; flex-wrap: wrap; gap: 5px; }
      .sg-fed .fed-agent-meta { display: flex; gap: 12px; color: var(--sg-fg-3); font-size: 11.5px; min-width: 0; }
      .sg-fed .fed-agent-task { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      /* MCP */
      .sg-fed .fed-mcp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
      .sg-fed .fed-mcp-card { display: flex; flex-direction: column; gap: 12px; }
      .sg-fed .fed-mcp-header { display: flex; align-items: center; gap: 10px; }
      .sg-fed .fed-mcp-desc { color: var(--sg-fg-2); font-size: 12.5px; line-height: 1.5; }
      .sg-fed .fed-mcp-tools-label { margin-bottom: 6px; color: var(--sg-fg-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
      .sg-fed .fed-mcp-tools-list { display: flex; flex-wrap: wrap; gap: 5px; }
      .sg-fed .fed-tool-chip { padding: 3px 8px; border-radius: 7px; font-size: 11px; color: var(--sg-fg-2); background: var(--glass-hover, rgba(255, 255, 255, 0.05)); box-shadow: inset 0 0 0 1px var(--glass-stroke); }
      .sg-fed .fed-tool-chip.more { color: var(--sg-gold); }

      /* Toggle switch (MCP share) */
      .sg-fed .fed-switch { position: relative; display: inline-flex; align-items: center; gap: 10px; cursor: pointer; color: var(--sg-fg-2); font-size: 12.5px; user-select: none; }
      .sg-fed .fed-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
      .sg-fed .fed-switch-track {
        position: relative; flex: none; width: 36px; height: 21px; border-radius: 99px;
        background: var(--glass-press, rgba(255, 255, 255, 0.1)); box-shadow: inset 0 0 0 1px var(--glass-stroke-strong);
        transition: background var(--sg-dur) var(--sg-ease);
      }
      .sg-fed .fed-switch-track i {
        position: absolute; top: 3px; left: 3px; width: 15px; height: 15px; border-radius: 50%; background: var(--sg-fg-2);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); transition: transform var(--sg-dur) var(--sg-spring), background var(--sg-dur);
      }
      .sg-fed .fed-switch input:checked + .fed-switch-track { background: var(--glass-gold-fill, var(--sg-gold)); box-shadow: 0 0 12px -2px var(--glass-gold-a40, transparent); }
      .sg-fed .fed-switch input:checked + .fed-switch-track i { transform: translateX(15px); background: #fff; }
      .sg-fed .fed-switch input:focus-visible + .fed-switch-track { box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--sg-gold)); }

      /* Business */
      .sg-fed .fed-business-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
      .sg-fed .fed-business-card { display: flex; flex-direction: column; gap: 10px; }
      .sg-fed .fed-business-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .sg-fed .fed-business-name { color: var(--sg-fg); font-size: 14px; font-weight: 640; min-width: 0; overflow-wrap: anywhere; }
      .sg-fed .fed-business-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; color: var(--sg-fg-3); font-size: 11.5px; }
      .sg-fed .fed-business-meta strong { color: var(--sg-fg-2); font-weight: 600; }

      @media (max-width: 1100px) {
        .sg-fed .fed-task-board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .sg-fed .fed-overview-split { grid-template-columns: minmax(0, 1fr); }
      }
      @media (max-width: 720px) {
        .sg-fed { padding: 10px 10px 32px; }
        .sg-fed .sg-hero .sg-actions > .sg-btn { flex: 1 1 calc(50% - 8px); }
        .sg-fed .fed-master-status-row { width: 100%; }
        .sg-fed .fed-tabs-wrap { margin-inline: -2px; }
        .sg-fed .fed-tab .fed-tab-count { display: none; }
        .sg-fed .fed-task-board { grid-template-columns: minmax(0, 1fr); }
        .sg-fed .fed-gateway-grid, .sg-fed .fed-project-list, .sg-fed .fed-mcp-grid, .sg-fed .fed-business-grid, .sg-fed .fed-agents-list { grid-template-columns: minmax(0, 1fr); }
        .sg-fed .fed-node-grid { grid-template-columns: minmax(0, 1fr); }
        .sg-fed .fed-quick-actions { grid-template-columns: minmax(0, 1fr); }
        .sg-fed .fed-gateway-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (prefers-reduced-motion: reduce) {
        .sg-fed .fed-spin { animation: none; }
        .sg-fed .fed-action-arrow, .sg-fed .fed-switch-track, .sg-fed .fed-switch-track i { transition: none; }
      }
    </style>
  `;
}
