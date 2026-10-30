/**
 * Federation Integration
 * 
 * Enhanced federation UI with full cross-node resource sharing:
 * - Federation settings & node management
 * - Cross-node gateway access
 * - Shared projects, tasks, agents, MCPs, business data
 * - Node selector for chat context
 * - Federation Control Center (comprehensive dashboard)
 */

import { html, nothing } from "lit";
import {
  createDeviceControlState,
  openDeviceControl,
  renderDeviceControl,
} from "./federation-device-control";
import type { AppViewState } from "../app-view-state";
import type { FederationState, FederationMode } from "../controllers/federation";
import {
  createFederationState,
  loadFederationState,
  loadNodes,
  setCurrentNode,
  loadPersistedNodeSelection,
  saveFederationConfig,
  connectToMaster,
  disconnectFromMaster,
  addNode,
  removeNode,
  scanNetwork,
} from "../controllers/federation";
import { renderFederationSettings, type FederationSettingsProps } from "./federation-settings";
import { renderNodeSelector, type NodeSelectorProps } from "./node-selector";
import {
  type FederationResourcesState,
  createFederationResourcesState,
  loadFederationResources,
  syncFederationResources,
  selectNode,
  setActiveTab,
  shareProjectToFederation,
  assignTaskToNode,
  shareMCPToFederation,
  connectToNodeGateway,
  invokeOnNodeGateway,
} from "../controllers/federation-resources";
import {
  renderFederationDashboard,
  type FederationDashboardProps,
} from "./federation-dashboard";
import {
  renderFederationControlCenter,
  type ControlCenterProps,
} from "./federation-control-center";
import {
  type ControlCenterState,
  createControlCenterState,
  loadControlCenterData,
  buildControlCenterProps,
} from "../controllers/federation-control-center";
import {
  renderNodeDetailsModal,
  renderNodeSettingsModal,
  renderConnectWizard,
  renderConfirmDialog,
  renderInviteModal,
  createInviteModalState,
  type NodeInfo,
  type NodeSettings,
  type InviteModalState,
} from "./federation-modals";

// ── State Extension ───────────────────────────────────────

/**
 * Extended state type that includes federation
 * Add this to AppViewState or create a separate state slice
 */
export interface FederationViewState {
  federationState: FederationState;
  federationResourcesState?: FederationResourcesState;
}

// Module-level state for resources (shared across renders)
let _federationResourcesState: FederationResourcesState | null = null;
let _controlCenterState: ControlCenterState | null = null;

// Modal state
let _modalState = {
  detailsOpen: false,
  settingsOpen: false,
  connectOpen: false,
  confirmOpen: false,
  inviteOpen: false,
  selectedNode: null as NodeInfo | null,
  nodeSettings: { name: "", shareOllama: true, shareMCPs: true, shareAgents: true, acceptTasks: true } as NodeSettings,
  connectWizard: { step: 1, url: "", name: "", testing: false, testResult: null as "success" | "error" | null, testMessage: "", inviteMode: false, inviteText: "" },
  confirmAction: null as (() => void) | null,
  confirmTitle: "",
  confirmMessage: "",
  confirmDanger: false,
  invite: createInviteModalState() as InviteModalState,
};

function getFederationResourcesState(): FederationResourcesState {
  if (!_federationResourcesState) {
    _federationResourcesState = createFederationResourcesState();
  }
  return _federationResourcesState;
}

function getControlCenterState(): ControlCenterState {
  if (!_controlCenterState) {
    _controlCenterState = createControlCenterState();
  }
  return _controlCenterState;
}

// Modal helpers
export function openNodeDetails(node: NodeInfo, requestUpdate: () => void) {
  _modalState.selectedNode = node;
  _modalState.detailsOpen = true;
  requestUpdate();
}

export function openNodeSettings(node: NodeInfo, requestUpdate: () => void) {
  _modalState.selectedNode = node;
  _modalState.nodeSettings = { 
    name: node.name, 
    shareOllama: true, 
    shareMCPs: true, 
    shareAgents: true, 
    acceptTasks: true 
  };
  _modalState.settingsOpen = true;
  requestUpdate();
}

export function openConnectWizard(requestUpdate: () => void) {
  _modalState.connectWizard = { step: 1, url: "", name: "", testing: false, testResult: null, testMessage: "" };
  _modalState.connectOpen = true;
  requestUpdate();
}

export function openConfirmDialog(title: string, message: string, onConfirm: () => void, danger: boolean, requestUpdate: () => void) {
  _modalState.confirmTitle = title;
  _modalState.confirmMessage = message;
  _modalState.confirmAction = onConfirm;
  _modalState.confirmDanger = danger;
  _modalState.confirmOpen = true;
  requestUpdate();
}

function closeAllModals(requestUpdate: () => void) {
  _modalState.detailsOpen = false;
  _modalState.settingsOpen = false;
  _modalState.connectOpen = false;
  _modalState.confirmOpen = false;
  _modalState.invite.open = false;
  requestUpdate();
}

/**
 * Create initial federation state
 * Call this in app.ts during state initialization
 */
export function initializeFederationState(): FederationState {
  const state = createFederationState();
  loadPersistedNodeSelection(state);
  return state;
}

// ── View Renderers ────────────────────────────────────────

/**
 * Render the federation settings page (legacy - basic settings only)
 */
export function renderFederationSettingsTab(appState: AppViewState & FederationViewState) {
  const { client, federationState } = appState;
  const boundRequestUpdate = () => appState.requestUpdate?.();

  const props: FederationSettingsProps = {
    state: federationState,
    
    onRefresh: () => {
      void loadFederationState(client, federationState, boundRequestUpdate);
    },
    
    onModeChange: (mode: FederationMode) => {
      federationState.mode = mode;
      federationState.configDirty = true;
      boundRequestUpdate();
    },
    
    onMasterUrlChange: (url: string) => {
      federationState.masterUrl = url;
      federationState.configDirty = true;
      boundRequestUpdate();
    },
    
    onConnect: () => {
      void connectToMaster(client, federationState, federationState.masterUrl, boundRequestUpdate);
    },
    
    onDisconnect: () => {
      void disconnectFromMaster(client, federationState, boundRequestUpdate);
    },
    
    onAddNode: (url: string, name?: string) => {
      void addNode(client, federationState, url, name, boundRequestUpdate);
    },
    
    onRemoveNode: (nodeId: string) => {
      void removeNode(client, federationState, nodeId, boundRequestUpdate);
    },

    onRenameNode: (nodeId: string, displayName: string, isLocal: boolean) => {
      if (!client) return;
      const trimmed = displayName.trim();
      if (!trimmed) return;
      // Optimistic local update so the new name appears before the round-trip.
      const node = federationState.nodes.find((n) => n.id === nodeId);
      const previous = node?.name;
      if (node) node.name = trimmed;
      boundRequestUpdate();

      const rpc = isLocal
        ? client.request("federation.config.set", { nodeName: trimmed })
        : client.request("node.rename", { nodeId, displayName: trimmed });

      void rpc
        .then((res: unknown) => {
          const result = res as { success?: boolean; error?: string };
          if (result && result.success === false) {
            // Roll back optimistic update.
            if (node && previous !== undefined) node.name = previous;
            federationState.error = result.error ?? "Rename failed";
            boundRequestUpdate();
            return;
          }
          // Re-pull authoritative state from the gateway so paired-nodes
          // displayName / federation.nodeName are reflected everywhere.
          void loadFederationState(client, federationState, boundRequestUpdate);
        })
        .catch((err: unknown) => {
          if (node && previous !== undefined) node.name = previous;
          federationState.error = err instanceof Error ? err.message : String(err);
          boundRequestUpdate();
        });
    },
    
    onScanNetwork: () => {
      void scanNetwork(client, federationState, boundRequestUpdate);
    },
    
    onSaveConfig: () => {
      void saveFederationConfig(client, federationState, {
        mode: federationState.mode,
        masterUrl: federationState.masterUrl,
      }, boundRequestUpdate);
    },

    onRefreshUrls: async () => {
      if (!client) return federationState.masterUrls;
      const res = await client.request<{ urls?: Array<{ type: string; url: string; label: string }> }>(
        "federation.urls",
        {},
      ).catch(() => null);
      if (res?.urls) {
        const urls = res.urls.map(u => ({
          type: u.type as import("../controllers/federation").MasterUrlInfo["type"],
          url: u.url,
          label: u.label,
        }));
        federationState.masterUrls = urls;
        boundRequestUpdate();
        return urls;
      }
      return federationState.masterUrls;
    },

    onScanForMasters: async () => {
      if (!client) return [];
      const res = await client.request<{ success?: boolean; discovered?: Array<{ type: string; url: string; label: string }> }>(
        "federation.discover-master",
        { timeoutMs: 10000 },
      ).catch(() => null);
      return (res?.discovered ?? []).map(d => ({
        type: d.type as import("../controllers/federation").MasterUrlInfo["type"],
        url: d.url,
        label: d.label,
      }));
    },
  };

  return renderFederationSettings(props);
}

const _deviceControl = createDeviceControlState();
// Terminals state is created lazily on first visit; remember the device so
// the New Terminal dialog opens preselected once it exists.
let _pendingTerminalNodeId: string | null = null;
export function applyPendingTerminalNode(appState: AppViewState): void {
  const ts = appState.terminalsState;
  if (!_pendingTerminalNodeId || !ts) return;
  ts.defaultSpawnNodeId = _pendingTerminalNodeId;
  ts.createForm.nodeId = _pendingTerminalNodeId;
  ts.showCreateDialog = true;
  _pendingTerminalNodeId = null;
}

/**
 * Render the enhanced federation dashboard with full resource sharing
 * Use this in app-render.ts for the "federation" tab case
 */
export function renderFederationTab(appState: AppViewState & FederationViewState) {
  const { client, federationState } = appState;
  applyPendingTerminalNode(appState);
  const boundRequestUpdate = () => appState.requestUpdate?.();
  const resourcesState = getFederationResourcesState();

  // Auto-load resources if not loaded
  if (!resourcesState.loading && resourcesState.nodeGateways.length === 0 && resourcesState.lastFullSync === null) {
    void loadFederationResources(client, resourcesState, boundRequestUpdate);
  }

  // Convert node gateway to NodeInfo for modals
  const convertToNodeInfo = (ng: (typeof resourcesState.nodeGateways)[0]): NodeInfo => ({
    id: ng.nodeId,
    name: ng.nodeName,
    status: ng.connected ? "online" : "offline",
    role: ng.nodeId === federationState.localNodeId ? "master" : "satellite",
    isLocal: ng.nodeId === federationState.localNodeId,
    latencyMs: ng.latency,
    lastSeen: ng.lastSeen,
    sessions: 0,
    mcpCount: ng.mcpServers?.length ?? 0,
    capabilities: ng.capabilities,
    version: ng.version,
    url: ng.gatewayUrl,
  });

  const props: FederationDashboardProps = {
    federationState,
    resourcesState,

    onRefresh: () => {
      void loadFederationState(client, federationState, boundRequestUpdate);
      void loadFederationResources(client, resourcesState, boundRequestUpdate);
    },

    onSyncAll: () => {
      void syncFederationResources(client, resourcesState, boundRequestUpdate);
    },

    onSelectNode: (nodeId: string | null) => {
      selectNode(resourcesState, nodeId, boundRequestUpdate);
      if (nodeId) {
        setCurrentNode(federationState, nodeId, boundRequestUpdate);
      }
    },

    onConnectToNode: (nodeId: string) => {
      void connectToNodeGateway(client, nodeId, resourcesState, boundRequestUpdate);
    },

    onShareProject: (projectId: string, targetNodes: string[]) => {
      void shareProjectToFederation(client, projectId, targetNodes, boundRequestUpdate).then(() => {
        void loadFederationResources(client, resourcesState, boundRequestUpdate);
      });
    },

    onAssignTask: (taskId: string, nodeId: string, agentId?: string) => {
      void assignTaskToNode(client, taskId, nodeId, agentId, boundRequestUpdate).then(() => {
        void loadFederationResources(client, resourcesState, boundRequestUpdate);
      });
    },

    onShareMCP: (mcpId: string, share: boolean) => {
      void shareMCPToFederation(client, mcpId, share, boundRequestUpdate);
    },

    onSetActiveTab: (tab) => {
      setActiveTab(resourcesState, tab, boundRequestUpdate);
    },

    onInvokeOnNode: async (nodeId: string, method: string, params: Record<string, unknown>) => {
      try {
        const result = await invokeOnNodeGateway(client, nodeId, method, params);
        console.log(`[Federation] Node ${nodeId} invoke result:`, result);
      } catch (err) {
        console.error(`[Federation] Node invoke failed:`, err);
      }
    },
    
    // Modal handlers
    onOpenNodeDetails: (node) => {
      const nodeInfo = convertToNodeInfo(node);
      openNodeDetails(nodeInfo, boundRequestUpdate);
    },
    
    onOpenConnectWizard: () => {
      openConnectWizard(boundRequestUpdate);
    },

    onGenerateInvite: () => {
      _modalState.invite = createInviteModalState();
      _modalState.invite.open = true;
      boundRequestUpdate();
    },

    onOpenDevice: (nodeId: string, nodeName: string) => {
      openDeviceControl(_deviceControl, client, { nodeId, nodeName }, boundRequestUpdate);
    },

    onPromoteToMaster: (nodeId: string) => {
      if (nodeId === "local") {
        // Local device promotion: switch from satellite to master via config
        openConfirmDialog(
          "Claim as Master",
          `Promote this device to master? It will restart the gateway and begin broadcasting as the federation hub.`,
          () => {
            if (!client) return;
            void client.request("federation.config.set", {
              mode: "master",
            }).then((res: unknown) => {
              const result = res as { success?: boolean; error?: string };
              if (result && !result.success) {
                federationState.error = result.error ?? "Mode change failed";
                boundRequestUpdate();
                return;
              }
              void loadFederationState(client, federationState, boundRequestUpdate);
              void loadFederationResources(client, resourcesState, boundRequestUpdate);
            }).catch((err: unknown) => {
              federationState.error = err instanceof Error ? err.message : String(err);
              boundRequestUpdate();
            });
          },
          true,
          boundRequestUpdate
        );
        return;
      }
      // Remote satellite promotion: send role.change via dedicated RPC
      openConfirmDialog(
        "Promote to Master",
        `Promote this node to master? The current master will be demoted to satellite. This will reconfigure the federation topology and restart the gateway.`,
        () => {
          if (!client) return;
          void client.request("federation.node.promote-to-master", {
            nodeId,
          }).then((res: unknown) => {
            const result = res as { success?: boolean; message?: string; error?: string };
            if (result && !result.success) {
              federationState.error = result.error ?? "Promotion failed";
              boundRequestUpdate();
              return;
            }
            void loadFederationState(client, federationState, boundRequestUpdate);
            void loadFederationResources(client, resourcesState, boundRequestUpdate);
          }).catch((err: unknown) => {
            federationState.error = err instanceof Error ? err.message : String(err);
            boundRequestUpdate();
          });
        },
        true,
        boundRequestUpdate
      );
    },
  };

  return html`
    ${renderFederationDashboard(props)}
    
    <!-- Node Details Modal -->
    ${renderNodeDetailsModal({
      open: _modalState.detailsOpen,
      node: _modalState.selectedNode,
      onClose: () => closeAllModals(boundRequestUpdate),
      onPing: (nodeId) => {
        console.log("[Federation] Pinging node:", nodeId);
        // Could implement actual ping
      },
      onRestart: (nodeId) => {
        openConfirmDialog(
          "Restart Node",
          `Are you sure you want to restart "${_modalState.selectedNode?.name}"? This will temporarily disconnect it from the federation.`,
          () => {
            console.log("[Federation] Restarting node:", nodeId);
            closeAllModals(boundRequestUpdate);
          },
          false,
          boundRequestUpdate
        );
      },
      onDisconnect: (nodeId) => {
        openConfirmDialog(
          "Disconnect Node",
          `Are you sure you want to disconnect "${_modalState.selectedNode?.name}" from the federation?`,
          () => {
            void removeNode(client, federationState, nodeId, boundRequestUpdate);
            closeAllModals(boundRequestUpdate);
          },
          true,
          boundRequestUpdate
        );
      },
      onOpenSettings: (nodeId) => {
        _modalState.detailsOpen = false;
        const node = resourcesState.nodeGateways.find(n => n.nodeId === nodeId);
        if (node) {
          openNodeSettings(convertToNodeInfo(node), boundRequestUpdate);
        }
      },
    })}
    
    <!-- Node Settings Modal -->
    ${renderNodeSettingsModal(
      {
        open: _modalState.settingsOpen,
        node: _modalState.selectedNode,
        onClose: () => closeAllModals(boundRequestUpdate),
        onSave: (nodeId, settings) => {
          console.log("[Federation] Saving node settings:", nodeId, settings);
          // Would implement actual save
          closeAllModals(boundRequestUpdate);
        },
      },
      _modalState.nodeSettings,
      (key, value) => {
        (_modalState.nodeSettings as Record<string, unknown>)[key] = value;
        boundRequestUpdate();
      }
    )}
    
    <!-- Connect Wizard Modal -->
    ${renderConnectWizard(
      {
        open: _modalState.connectOpen,
        onClose: () => closeAllModals(boundRequestUpdate),
        onConnect: async (url, name) => {
          try {
            await addNode(client, federationState, url, name, boundRequestUpdate);
            return true;
          } catch {
            return false;
          }
        },
        onConnectWithInvite: async (invite) => {
          if (!client) return false;
          try {
            const res = await client.request<{ success: boolean; error?: string }>(
              "federation.connect",
              { invite },
            );
            if (res?.success) {
              void loadFederationState(client, federationState, boundRequestUpdate);
              void loadFederationResources(client, resourcesState, boundRequestUpdate);
              return true;
            }
            return false;
          } catch {
            return false;
          }
        },
      },
      _modalState.connectWizard,
      (updates) => {
        Object.assign(_modalState.connectWizard, updates);
        boundRequestUpdate();
      }
    )}

    <!-- Satellite device control (screen, commands, terminal, remove) -->
    ${renderDeviceControl({
      state: _deviceControl,
      client,
      requestUpdate: boundRequestUpdate,
      onOpenTerminal: (nodeId: string) => {
        _deviceControl.open = false;
        const ts = appState.terminalsState;
        if (ts) {
          ts.defaultSpawnNodeId = nodeId;
          ts.createForm.nodeId = nodeId;
          ts.showCreateDialog = true;
        } else {
          _pendingTerminalNodeId = nodeId;
        }
        appState.setTab("terminals" as never);
      },
    })}

    <!-- Invite Link Modal (hub side) -->
    ${renderInviteModal(
      {
        state: _modalState.invite,
        onClose: () => closeAllModals(boundRequestUpdate),
        onGenerate: () => {
          if (!client) return;
          _modalState.invite.generating = true;
          _modalState.invite.error = null;
          boundRequestUpdate();
          const satelliteName = _modalState.invite.satelliteName.trim();
          void client.request<{
            invite: string;
            expiresAt: number;
            hubUrls: Array<{ type: string; url: string; label: string }>;
            cliInvites?: Array<{ urlLabel: string; url: string; encoded: string }>;
          }>(
            "federation.generateInvite",
            satelliteName ? { satelliteName } : {},
          ).then((res) => {
            _modalState.invite.generating = false;
            if (res?.invite) {
              _modalState.invite.invite = res.invite;
              _modalState.invite.expiresAt = res.expiresAt;
              _modalState.invite.hubUrls = res.hubUrls ?? [];
              _modalState.invite.cliInvites = res.cliInvites ?? [];
              _modalState.invite.selectedUrlIndex = 0;
            } else {
              _modalState.invite.error = "Server returned no invite";
            }
            boundRequestUpdate();
          }).catch((err: unknown) => {
            _modalState.invite.generating = false;
            _modalState.invite.error = err instanceof Error ? err.message : "Failed to generate invite";
            boundRequestUpdate();
          });
        },
        onCopy: () => {
          _modalState.invite.copied = true;
          boundRequestUpdate();
          setTimeout(() => {
            _modalState.invite.copied = false;
            boundRequestUpdate();
          }, 2000);
        },
      },
      (updates) => {
        Object.assign(_modalState.invite, updates);
        boundRequestUpdate();
      },
    )}
    
    <!-- Confirm Dialog -->
    ${renderConfirmDialog({
      open: _modalState.confirmOpen,
      title: _modalState.confirmTitle,
      message: _modalState.confirmMessage,
      danger: _modalState.confirmDanger,
      onClose: () => closeAllModals(boundRequestUpdate),
      onConfirm: () => {
        _modalState.confirmAction?.();
        closeAllModals(boundRequestUpdate);
      },
    })}
  `;
}

/**
 * Render the Federation Control Center (comprehensive dashboard)
 * This is the new enhanced dashboard with all 7 panels:
 * - Fleet Overview
 * - MCP Registry
 * - Resource Monitor
 * - Session Distribution
 * - State Sync Status
 * - Capability Matrix
 * - Node Management
 * 
 * Use this in app-render.ts for the "federation" tab case
 */
export function renderFederationControlCenterTab(appState: AppViewState & FederationViewState) {
  const { client, federationState } = appState;
  const boundRequestUpdate = () => appState.requestUpdate?.();
  const resourcesState = getFederationResourcesState();
  const controlCenterState = getControlCenterState();

  // Auto-load resources if not loaded
  if (!resourcesState.loading && resourcesState.nodeGateways.length === 0 && resourcesState.lastFullSync === null) {
    void loadFederationResources(client, resourcesState, boundRequestUpdate);
  }

  // Auto-load control center data if needed
  if (!controlCenterState.loading && controlCenterState.metricsLastUpdate === null) {
    void loadControlCenterData(client, controlCenterState, federationState, resourcesState, boundRequestUpdate);
  }

  // Build props using the controller
  const props = buildControlCenterProps(
    client,
    federationState,
    resourcesState,
    controlCenterState,
    boundRequestUpdate
  );

  return renderFederationControlCenter(props);
}

/**
 * Render the node selector for chat header
 * Use this in views/chat.ts in the header section
 * 
 * Example usage in chat.ts:
 * ```
 * import { renderChatNodeSelector } from "./federation-integration";
 * 
 * // In the chat header:
 * ${renderChatNodeSelector(state)}
 * ```
 */
export function renderChatNodeSelector(appState: AppViewState & FederationViewState) {
  const { client, federationState } = appState;
  // Create a bound requestUpdate function that preserves the Lit element context
  const boundRequestUpdate = () => appState.requestUpdate?.();

  // Don't render if federation is not configured or only one node
  if (federationState.nodes.length <= 1 && !federationState.loading) {
    return nothing;
  }

  const props: NodeSelectorProps = {
    nodes: federationState.nodes,
    currentNodeId: federationState.currentNodeId,
    localNodeId: federationState.localNodeId,
    loading: federationState.loading,
    compact: true,
    
    onNodeSelect: (nodeId: string) => {
      setCurrentNode(federationState, nodeId, boundRequestUpdate);
      // Optionally trigger a session switch or context reload here
    },
    
    onRefresh: () => {
      void loadNodes(client, federationState, { quiet: true }, boundRequestUpdate);
    },
  };

  return renderNodeSelector(props);
}

// ── Event Handlers ────────────────────────────────────────

/**
 * Load federation state on app start
 * Call this in app-lifecycle.ts handleConnected
 */
export async function loadFederation(appState: AppViewState & FederationViewState) {
  const { client, federationState } = appState;
  if (!client) return;
  
  // Create a bound requestUpdate function that preserves the Lit element context
  const boundRequestUpdate = () => appState.requestUpdate?.();
  await loadFederationState(client, federationState, boundRequestUpdate);
}

/**
 * Subscribe to federation events
 * Call this after gateway connection is established
 */
export function subscribeFederationEvents(appState: AppViewState & FederationViewState) {
  const { client, federationState } = appState;
  if (!client) return;

  // Create a bound requestUpdate function that preserves the Lit element context
  const boundRequestUpdate = () => appState.requestUpdate?.();

  // Subscribe to node status updates
  return client.subscribe((evt) => {
    if (evt.event === "federation.node.connected") {
      const payload = evt.payload as { nodeId?: string; node?: Record<string, unknown> };
      if (payload.nodeId) {
        const existing = federationState.nodes.find(n => n.id === payload.nodeId);
        if (existing) {
          existing.status = "online";
          boundRequestUpdate();
        }
      }
    }
    
    if (evt.event === "federation.node.disconnected") {
      const payload = evt.payload as { nodeId?: string };
      if (payload.nodeId) {
        const existing = federationState.nodes.find(n => n.id === payload.nodeId);
        if (existing) {
          existing.status = "offline";
          boundRequestUpdate();
        }
      }
    }

    if (evt.event === "federation.nodes.updated") {
      // Refresh nodes list
      void loadNodes(client, federationState, { quiet: true }, boundRequestUpdate);
    }
  });
}

// ── Sample Navigation Patch ───────────────────────────────

/**
 * Navigation patch for adding federation tab
 * 
 * In navigation.ts, add these changes:
 * 
 * 1. TAB_GROUPS - Add "federation" to Settings group:
 * ```
 * { label: "Settings", tabs: ["setup", "config", "apikeys", "channels", "instances", "nodes", "federation", "debug", "logs"] }
 * ```
 * 
 * 2. Tab type - Add:
 * ```
 * | "federation"
 * ```
 * 
 * 3. TAB_PATHS - Add:
 * ```
 * federation: "/federation",
 * ```
 * 
 * 4. iconForTab - Add case:
 * ```
 * case "federation":
 *   return "radio";
 * ```
 * 
 * 5. titleForTab - Add case:
 * ```
 * case "federation":
 *   return "Federation";
 * ```
 * 
 * 6. subtitleForTab - Add case:
 * ```
 * case "federation":
 *   return "Multi-node network configuration and connected satellites.";
 * ```
 */
export const FEDERATION_NAV_CONFIG = {
  tab: "federation" as const,
  path: "/federation",
  icon: "radio" as const,
  title: "Federation",
  subtitle: "Multi-node network configuration and connected satellites.",
  group: "Settings",
};

// ── Sample App Render Patch ───────────────────────────────

/**
 * App render patch for federation tab
 * 
 * In app-render.ts, add this case to the tab switch:
 * ```
 * case "federation":
 *   return renderFederationTab(state as AppViewState & FederationViewState);
 * ```
 */

// ── Sample Chat Header Integration ────────────────────────

/**
 * Chat header node selector integration
 * 
 * In views/chat.ts renderChat function, add the node selector to the header:
 * ```
 * // In the header row, after the session selector:
 * ${(state as any).federationState?.nodes?.length > 1 
 *   ? renderChatNodeSelector(state as AppViewState & FederationViewState)
 *   : nothing}
 * ```
 * 
 * Or use the Lit component version:
 * ```
 * import "../views/node-selector";
 * 
 * <node-selector
 *   .nodes=${federationState.nodes}
 *   .currentNodeId=${federationState.currentNodeId}
 *   .localNodeId=${federationState.localNodeId}
 *   compact
 *   @node-select=${(e: CustomEvent) => setCurrentNode(federationState, e.detail.nodeId)}
 *   @refresh=${() => loadNodes(client, federationState, { quiet: true })}
 * ></node-selector>
 * ```
 */

// ── Exports ───────────────────────────────────────────────

export {
  // Re-export controller functions for convenience
  createFederationState,
  loadFederationState,
  loadNodes,
  setCurrentNode,
  loadPersistedNodeSelection,
  saveFederationConfig,
  connectToMaster,
  disconnectFromMaster,
  addNode,
  removeNode,
  scanNetwork,
  // Enhanced resource functions
  createFederationResourcesState,
  loadFederationResources,
  syncFederationResources,
  selectNode,
  setActiveTab,
  shareProjectToFederation,
  assignTaskToNode,
  shareMCPToFederation,
  connectToNodeGateway,
  invokeOnNodeGateway,
  // Control Center functions
  createControlCenterState,
  loadControlCenterData,
  buildControlCenterProps,
  // Render functions
  renderFederationControlCenter,
};

export type {
  FederationState,
  FederationMode,
  FederationSettingsProps,
  NodeSelectorProps,
  FederationResourcesState,
  FederationDashboardProps,
  ControlCenterProps,
  ControlCenterState,
};
