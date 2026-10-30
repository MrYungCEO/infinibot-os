/**
 * Agent Operations Center — Main View
 * Unified command center for federated multi-agent orchestration
 * 
 * Features:
 * - Visual activity map (PixiJS)
 * - Real-time agent monitoring
 * - Node federation overview
 * - Inter-agent messaging
 * - Task assignment
 */

import { html, nothing } from 'lit';
import type { GatewayBrowserClient } from '../../gateway';
import type { AppViewState } from '../../app-view-state';
import {
  getMeshState,
  initAgentMesh,
  cleanupAgentMesh,
  loadMeshStatus,
  toggleSpawnDialog,
  setSearchQuery,
} from '../../controllers/agent-mesh';
import { renderSpawnDialog } from './spawn-dialog';
import { renderMeshSidebar } from './mesh-sidebar';
import { renderMessageStream } from './message-stream';
import { ActivityMap, type MeshNode, type MeshAgent } from './activity-map';
import { AgencyWorld } from './agency-world';
import { WorldMapPinboard } from './world-map-pinboard';
import { installGalacticThemeRootBridge } from './iso/galactic-theme';
// Import to register the custom element
import './room-customization';
// 24h credit-usage HUD overlay (top-right of the world map)
import '../../components/credit-usage-breakdown';

// Engines share a common minimum surface so they're swappable from the
// same controller wiring.
type WorldEngine = ActivityMap | AgencyWorld;
// 'hq' = Galactic HQ isometric station (ActivityMap, galactic theme)
// 'world' = 2D agency floor (AgencyWorld)
// 'rooms' = legacy cozy rooms (ActivityMap, cozy theme)
type ViewMode = 'hq' | 'world' | 'rooms';
const VIEW_MODES: ViewMode[] = ['hq', 'world', 'rooms'];

// ════════════════════════════════════════════════════════════════
// THEME (Black & Gold)
// ════════════════════════════════════════════════════════════════

const HUD = {
  bg: '#15151c',
  bgCard: '#1a1a22',
  bgSurface: '#22222c',
  bgHover: '#2a2a36',
  gold: 'var(--g-primary)',
  goldDim: 'var(--g-primary)',
  goldSubtle: 'color-mix(in srgb, var(--g-primary) 8%, transparent)',
  goldBorder: 'color-mix(in srgb, var(--g-primary) 20%, transparent)',
  goldGlow: 'color-mix(in srgb, var(--g-primary) 30%, transparent)',
  text: '#e4e4e7',
  textMuted: '#71717a',
  textDim: '#52525b',
  border: '#1a1a1a',
  borderLight: '#27272a',
  success: '#22c55e',
  successBg: 'rgba(34,197,94,0.1)',
  error: '#ef4444',
  errorBg: 'rgba(239,68,68,0.1)',
  warning: '#f59e0b',
  warningBg: 'rgba(245,158,11,0.1)',
  info: '#3b82f6',
  infoBg: 'rgba(59,130,246,0.1)',
  mono: "'JetBrains Mono','SF Mono','Consolas',monospace",
};

// ════════════════════════════════════════════════════════════════
// LOCAL STATE
// ════════════════════════════════════════════════════════════════

let activityMap: WorldEngine | null = null;
let mapInitialized = false;
// Recently-completed pin board overlay pinned to the world map's bottom-right.
let pinboard: WorldMapPinboard | null = null;
// Cached so initActivityMap (called from places without a client) can warm the feed.
let agentOpsClient: GatewayBrowserClient | null = null;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let showRoomCustomization = false;
// Default to the Galactic HQ station; user can toggle to Agency World or
// legacy Rooms. v2 key so everyone lands on HQ once after the port.
let viewMode: ViewMode = (() => {
  try {
    const stored = localStorage.getItem('agentOps.viewMode.v2') as ViewMode | null;
    if (stored && VIEW_MODES.includes(stored)) return stored;
  } catch {}
  return 'hq';
})();

// ════════════════════════════════════════════════════════════════
// ROOM CUSTOMIZATION CONTROLS
// ════════════════════════════════════════════════════════════════

export function toggleRoomCustomization(state: AppViewState): void {
  showRoomCustomization = !showRoomCustomization;
  state.requestUpdate?.();
}

export function isRoomCustomizationOpen(): boolean {
  return showRoomCustomization;
}

export function getViewMode(): ViewMode {
  return viewMode;
}

export function setViewMode(mode: ViewMode, state: AppViewState): void {
  if (mode === viewMode) return;
  viewMode = mode;
  try { localStorage.setItem('agentOps.viewMode.v2', mode); } catch {}
  // Tear down current engine; let the renderer remount on next frame.
  shownNodes.clear();
  shownAgents.clear();
  if (pinboard) {
    pinboard.destroy();
    pinboard = null;
  }
  if (activityMap) {
    activityMap.destroy();
    activityMap = null;
  }
  mapInitialized = false;
  state.requestUpdate?.();
  // Re-init on next paint
  requestAnimationFrame(() => {
    const container = document.getElementById('activity-map-container');
    if (container) {
      initActivityMap(container, state);
      setTimeout(() => syncActivityMap(), 80);
    }
  });
}

// ════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════

export async function initAgentOpsCenter(
  client: GatewayBrowserClient,
  state: AppViewState
): Promise<void> {
  console.log('[AgentOps] Initializing...');
  agentOpsClient = client;
  await initAgentMesh(client, state);
  console.log('[AgentOps] Mesh data loaded, meshState:', getMeshState());
  
  // Initialize activity map after DOM render
  requestAnimationFrame(() => {
    setTimeout(() => {
      const container = document.getElementById('activity-map-container');
      console.log('[AgentOps] Container found:', !!container, 'activityMap:', !!activityMap);
      if (container && !activityMap) {
        initActivityMap(container, state);
        // Sync again after a short delay to ensure data is there
        setTimeout(() => {
          console.log('[AgentOps] Delayed sync');
          syncActivityMap();
        }, 500);
      }
    }, 100);
  });
  
  // Start auto-refresh
  autoRefreshTimer = setInterval(async () => {
    await loadMeshStatus(client, state);
    syncActivityMap();
    // setAccent no-ops when the color is unchanged
    syncAccentFromTheme();
  }, 5000);
}

export function cleanupAgentOpsCenter(): void {
  cleanupAgentMesh();

  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  if (pinboard) {
    pinboard.destroy();
    pinboard = null;
  }

  if (activityMap) {
    activityMap.destroy();
    activityMap = null;
  }

  mapInitialized = false;
}

function initActivityMap(container: HTMLElement, state: AppViewState): void {
  // Bind the document root's --gx-* CSS vars to the live Galactic theme so the
  // DOM overlays (pinboard / active-agents / credit-usage) re-tint on accent
  // swaps. Idempotent — only the first call wires the subscription.
  installGalacticThemeRootBridge();

  if (activityMap || mapInitialized) return;
  mapInitialized = true;

  // Tear down any leaked pin board from a previous engine before we wipe the
  // container's children (otherwise its observers/listeners would orphan).
  if (pinboard) {
    pinboard.destroy();
    pinboard = null;
  }

  // Clear any leftover canvas from previous engine
  while (container.firstChild) container.removeChild(container.firstChild);

  const handlers = {
    height: viewMode === 'rooms' ? 450 : 540,
    onAgentClick: (agent: MeshAgent) => {
      const meshState = getMeshState();
      meshState.selectedAgentKey = agent.sessionKey;
      // Open the detailed Agent Focus modal (mounted by app-render via
      // mountAgentFocusModal — exposed on window.openAgentFocus). Falls back to
      // the legacy selection-toggle behaviour when the modal hasn't mounted.
      const open = (window as unknown as { openAgentFocus?: (t: unknown) => void })
        .openAgentFocus;
      if (typeof open === "function") {
        open(agent);
      }
      state.requestUpdate?.();
    },
    onNodeClick: (node: MeshNode) => {
      const meshState = getMeshState();
      if (meshState.selectedNodeId === node.id) {
        meshState.selectedNodeId = null;
      } else {
        meshState.selectedNodeId = node.id;
        meshState.filterNodeId = node.id;
      }
      state.requestUpdate?.();
    },
  };

  try {
    activityMap =
      viewMode === 'world'
        ? new AgencyWorld(container, handlers)
        : new ActivityMap(container, {
            ...handlers,
            worldTheme: viewMode === 'hq' ? 'galactic' : 'cozy',
          });

    // Galactic HQ follows the dynamic theme accent (--g-primary)
    syncAccentFromTheme();

    // Sync current state to engine
    syncActivityMap();

    // Mount the recently-completed pin board overlay. ActivityMap engine only —
    // it owns the Pixi UI controls we float ABOVE the board via setBottomReserved.
    if (activityMap instanceof ActivityMap) {
      const map = activityMap;
      pinboard = new WorldMapPinboard(container, {
        client: agentOpsClient,
        requestUpdate: () => state.requestUpdate?.(),
        onReservedChange: (px) => map.setBottomReserved(px),
        onNavigate: (taskId, projectId) => {
          // Deep-link into the kanban board with the task open (mirrors the
          // dashboard's applyKanbanDeepLink pattern; kanban tab id = "projects").
          if (projectId) {
            (state as unknown as {
              kanbanSelectedProjectId: string | null;
              kanbanGalleryView: boolean;
            }).kanbanSelectedProjectId = projectId;
            (state as unknown as { kanbanGalleryView: boolean }).kanbanGalleryView = false;
          }
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('infinibot:kanban-open-task', {
                detail: { projectId: projectId ?? undefined, taskId },
              }),
            );
          }
          state.setTab?.('projects');
          state.requestUpdate?.();
        },
      });
    }
  } catch (err) {
    console.error('Failed to initialize activity map:', err);
  }
}

/** Keep the Galactic HQ accent in lockstep with the app's dynamic theme. */
function syncAccentFromTheme(): void {
  if (!(activityMap instanceof ActivityMap)) return;
  // Pulls --g-primary / --g-accent / --g-bg through resolveGalacticTheme().
  activityMap.applyThemeFromCss();
}

function syncActivityMap(): void {
  if (!activityMap) {
    console.log('[ActivityMap] No map instance');
    return;
  }

  const meshState = getMeshState();
  console.log('[ActivityMap] Syncing - nodes:', meshState.nodes.size, 'agents:', meshState.agents.size);

  // Sync nodes - add if not exists, update if exists
  meshState.nodes.forEach((node, id) => {
    const mapNode: MeshNode = {
      id: node.id,
      name: node.name,
      role: node.role,
      status: node.status,
      agentCount: node.agentCount,
    };
    
    // Always try to add (addNode handles duplicates internally)
    if (!shownNodes.has(id)) {
      console.log('[ActivityMap] Adding node:', id, node.name);
      activityMap!.addNode(mapNode);
      shownNodes.add(id);
    } else {
      activityMap!.updateNode(id, mapNode);
    }
  });

  // Sync agents - add if not exists, update if exists
  meshState.agents.forEach((agent, key) => {
    const mapAgent: MeshAgent = {
      sessionKey: agent.sessionKey,
      agentId: agent.agentId,
      label: agent.label,
      nodeId: agent.nodeId,
      status: agent.status,
      progress: agent.progress,
      currentTask: agent.currentTask,
      parent: agent.parent,
    };

    if (!shownAgents.has(key)) {
      console.log('[ActivityMap] Adding agent:', key, agent.label);
      activityMap!.addAgent(mapAgent);
      shownAgents.add(key);
    } else {
      activityMap!.updateAgent(key, mapAgent);
    }
  });
}

// Simple tracking (in production, use proper state)
const shownNodes = new Set<string>();
const shownAgents = new Set<string>();

function activityMapHasNode(id: string): boolean {
  if (shownNodes.has(id)) return true;
  shownNodes.add(id);
  return false;
}

function activityMapHasAgent(key: string): boolean {
  if (shownAgents.has(key)) return true;
  shownAgents.add(key);
  return false;
}

// ════════════════════════════════════════════════════════════════
// MAIN RENDER
// ════════════════════════════════════════════════════════════════

export function renderAgentOpsCenter(
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const meshState = getMeshState();

  return html`
    <div style="
      min-height: 100vh;
      background: ${HUD.bg};
      color: ${HUD.text};
      font-family: ${HUD.mono};
      display: flex;
      flex-direction: column;
    ">
      <!-- Header -->
      ${renderHeader(state, client, meshState)}
      
      <!-- Stats Bar -->
      ${renderStatsBar(meshState)}
      
      <!-- Main Grid -->
      <div style="
        flex: 1;
        display: grid;
        grid-template-columns: 1fr 320px;
        grid-template-rows: 1fr 200px;
        gap: 16px;
        padding: 0 24px 24px;
        min-height: 0;
      ">
        <!-- Activity Map -->
        <section style="
          grid-column: 1;
          grid-row: 1;
          position: relative;
          background: ${HUD.bgCard};
          border: 1px solid ${HUD.goldBorder};
          border-radius: 12px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        ">
          <!-- 24h credit-usage overlay — top-right (Active Agents=top-left, pinboard=bottom-right) -->
          <credit-usage-breakdown
            .client=${client}
            .compact=${true}
            style="position: absolute; top: 56px; right: 14px; width: min(280px, 22vw); z-index: 30; pointer-events: auto;"
          ></credit-usage-breakdown>
          <div style="
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid ${HUD.border};
          ">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 16px;">${viewMode === 'hq' ? '🛰️' : viewMode === 'world' ? '🏙️' : '🗺️'}</span>
              <span style="font-size: 13px; font-weight: 500; color: ${HUD.gold};">
                ${viewMode === 'hq' ? 'Galactic HQ' : viewMode === 'world' ? 'Agency World' : 'Activity Map'}
              </span>
            </div>
            <div style="display: flex; gap: 8px;">
              <!-- View mode toggle -->
              <div style="
                display: inline-flex;
                background: ${HUD.bgSurface};
                border: 1px solid ${HUD.border};
                border-radius: 6px;
                overflow: hidden;
                margin-right: 4px;
              ">
                <button
                  style="
                    background: ${viewMode === 'hq' ? HUD.goldSubtle : 'transparent'};
                    border: 0;
                    color: ${viewMode === 'hq' ? HUD.gold : HUD.textMuted};
                    padding: 4px 10px;
                    font-size: 11px;
                    cursor: pointer;
                    font-family: ${HUD.mono};
                  "
                  title="Isometric Galactic HQ station — sectors map to InfiniBot subsystems"
                  @click=${() => setViewMode('hq', state)}
                >🛰️ HQ</button>
                <button
                  style="
                    background: ${viewMode === 'world' ? HUD.goldSubtle : 'transparent'};
                    border: 0;
                    color: ${viewMode === 'world' ? HUD.gold : HUD.textMuted};
                    padding: 4px 10px;
                    font-size: 11px;
                    cursor: pointer;
                    font-family: ${HUD.mono};
                  "
                  title="2D animated agency world (upgraded)"
                  @click=${() => setViewMode('world', state)}
                >🏙️ World</button>
                <button
                  style="
                    background: ${viewMode === 'rooms' ? HUD.goldSubtle : 'transparent'};
                    border: 0;
                    color: ${viewMode === 'rooms' ? HUD.gold : HUD.textMuted};
                    padding: 4px 10px;
                    font-size: 11px;
                    cursor: pointer;
                    font-family: ${HUD.mono};
                  "
                  title="Classic cozy-rooms layout"
                  @click=${() => setViewMode('rooms', state)}
                >🏠 Rooms</button>
              </div>
              <button
                style="
                  background: transparent;
                  border: 1px solid ${HUD.border};
                  color: ${HUD.textMuted};
                  padding: 4px 10px;
                  border-radius: 4px;
                  font-size: 11px;
                  cursor: pointer;
                  font-family: ${HUD.mono};
                "
                @click=${() => activityMap?.zoomToFit()}
              >Fit</button>
              <button
                style="
                  background: transparent;
                  border: 1px solid ${HUD.border};
                  color: ${HUD.textMuted};
                  padding: 4px 10px;
                  border-radius: 4px;
                  font-size: 11px;
                  cursor: pointer;
                  font-family: ${HUD.mono};
                "
                @click=${() => activityMap?.centerView()}
              >Center</button>
            </div>
          </div>
          <div
            id="activity-map-container"
            style="flex: 1; min-height: ${viewMode === 'rooms' ? '400px' : '540px'}; position: relative; background: ${HUD.bg};"
          >
            ${meshState.loading && !activityMap ? html`
              <div style="
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100%;
                color: ${HUD.textMuted};
              ">
                <span style="font-size: 24px; margin-right: 12px;">⏳</span>
                Loading mesh data...
              </div>
            ` : html`
              ${(() => {
                // Try to init map if not done yet
                if (!activityMap && !mapInitialized) {
                  requestAnimationFrame(() => {
                    const container = document.getElementById('activity-map-container');
                    if (container) initActivityMap(container, state);
                  });
                }
                return nothing;
              })()}
            `}
          </div>
        </section>

        <!-- Sidebar -->
        <aside style="
          grid-column: 2;
          grid-row: 1 / 3;
          background: ${HUD.bgCard};
          border: 1px solid ${HUD.goldBorder};
          border-radius: 12px;
          overflow: hidden;
        ">
          ${renderMeshSidebar(state, client)}
        </aside>

        <!-- Message Stream -->
        <section style="
          grid-column: 1;
          grid-row: 2;
          background: ${HUD.bgCard};
          border: 1px solid ${HUD.goldBorder};
          border-radius: 12px;
          overflow: hidden;
        ">
          ${renderMessageStream(state)}
        </section>
      </div>

      <!-- Spawn Dialog -->
      ${renderSpawnDialog(state, client)}

      <!-- Room Customization Panel (Full Screen Overlay) -->
      ${showRoomCustomization ? html`
        <div style="
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.9);
          z-index: 100;
          display: flex;
          flex-direction: column;
        ">
          <room-customization
            .agents=${Array.from(meshState.agents.values()).map(a => ({
              agentId: a.agentId,
              label: a.label,
              sessionKey: a.sessionKey,
            }))}
            .onConfigChange=${(config: any) => {
              console.log('[AgentOps] Room config changed:', config);
              // Could sync to activity map here
            }}
            .onClose=${() => toggleRoomCustomization(state)}
          ></room-customization>
        </div>
      ` : nothing}
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// HEADER
// ════════════════════════════════════════════════════════════════

function renderHeader(
  state: AppViewState,
  client: GatewayBrowserClient,
  meshState: ReturnType<typeof getMeshState>
) {
  return html`
    <header style="
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px;
    ">
      <!-- Title -->
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 28px;">🔮</span>
        <div>
          <h1 style="
            margin: 0;
            font-size: 22px;
            font-weight: 600;
            color: ${HUD.gold};
          ">Agent Operations Center</h1>
          <p style="
            margin: 4px 0 0;
            font-size: 12px;
            color: ${HUD.textMuted};
          ">Unified command center for multi-agent orchestration</p>
        </div>
      </div>

      <!-- Search & Actions -->
      <div style="display: flex; align-items: center; gap: 12px;">
        <!-- Search -->
        <input
          type="text"
          placeholder="🔍 Search agents, nodes..."
          style="
            background: ${HUD.bgSurface};
            border: 1px solid ${HUD.border};
            border-radius: 8px;
            padding: 10px 14px;
            color: ${HUD.text};
            font-family: ${HUD.mono};
            font-size: 12px;
            width: 220px;
            outline: none;
          "
          .value=${meshState.searchQuery}
          @input=${(e: Event) => {
            setSearchQuery((e.target as HTMLInputElement).value, state);
          }}
        />

        <!-- Refresh -->
        <button
          style="
            background: transparent;
            border: 1px solid ${HUD.border};
            color: ${HUD.textMuted};
            padding: 10px 14px;
            border-radius: 8px;
            cursor: pointer;
            font-family: ${HUD.mono};
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
          "
          @click=${async () => {
            await loadMeshStatus(client, state);
            syncActivityMap();
          }}
        >
          🔄 Refresh
        </button>

        <!-- Room Customization -->
        <button
          style="
            background: ${showRoomCustomization ? HUD.goldSubtle : 'transparent'};
            border: 1px solid ${showRoomCustomization ? HUD.goldBorder : HUD.border};
            color: ${showRoomCustomization ? HUD.gold : HUD.textMuted};
            padding: 10px 14px;
            border-radius: 8px;
            cursor: pointer;
            font-family: ${HUD.mono};
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: all 0.2s;
          "
          @click=${() => toggleRoomCustomization(state)}
        >
          🏠 Customize Room
        </button>

        <!-- Spawn Agent -->
        <button
          style="
            background: ${HUD.goldSubtle};
            border: 1px solid ${HUD.goldBorder};
            color: ${HUD.gold};
            padding: 10px 18px;
            border-radius: 8px;
            cursor: pointer;
            font-family: ${HUD.mono};
            font-size: 13px;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
          "
          @click=${() => toggleSpawnDialog(state)}
        >
          🚀 Spawn Agent
        </button>
      </div>
    </header>
  `;
}

// ════════════════════════════════════════════════════════════════
// STATS BAR
// ════════════════════════════════════════════════════════════════

function renderStatsBar(meshState: ReturnType<typeof getMeshState>) {
  const stats = meshState.stats;

  return html`
    <div style="
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
      padding: 0 24px 20px;
    ">
      ${renderStatCard('🤖', 'Active Agents', stats.activeAgents, stats.totalAgents, HUD.gold, HUD.goldSubtle)}
      ${renderStatCard('🌐', 'Online Nodes', stats.onlineNodes, stats.totalNodes, HUD.success, HUD.successBg)}
      ${renderStatCard('💬', 'Messages', stats.totalMessages, null, HUD.info, HUD.infoBg)}
      ${renderStatCard('📊', 'Msgs/min', stats.messagesPerMinute, null, HUD.warning, HUD.warningBg)}
      ${renderStatCard('⚡', 'MCPs', meshState.mcpServers.filter(s => s.status === 'running').length, meshState.mcpServers.length, HUD.goldDim, HUD.goldSubtle)}
      ${renderStatCard('📋', 'Active Tasks', meshState.tasks.length, null, HUD.text, HUD.bgSurface)}
    </div>
  `;
}

function renderStatCard(
  icon: string,
  label: string,
  value: number,
  total: number | null,
  color: string,
  bgColor: string
) {
  return html`
    <div style="
      background: ${HUD.bgCard};
      border: 1px solid ${HUD.border};
      border-radius: 10px;
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    ">
      <div style="
        width: 40px;
        height: 40px;
        background: ${bgColor};
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
      ">${icon}</div>
      <div>
        <div style="
          font-size: 20px;
          font-weight: 600;
          color: ${color};
        ">
          ${value}${total !== null ? html`<span style="color: ${HUD.textMuted}; font-size: 14px;">/${total}</span>` : nothing}
        </div>
        <div style="
          font-size: 10px;
          color: ${HUD.textMuted};
          text-transform: uppercase;
          letter-spacing: 0.5px;
        ">${label}</div>
      </div>
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// RE-EXPORTS
// ════════════════════════════════════════════════════════════════

export { ActivityMap } from './activity-map';
export { renderSpawnDialog } from './spawn-dialog';
export { renderMeshSidebar } from './mesh-sidebar';
export { renderMessageStream } from './message-stream';
export { 
  RoomCustomization,
  ROOM_THEMES,
  FURNITURE_PALETTE,
  CARPET_OPTIONS,
  type RoomConfiguration,
  type FurnitureItem,
  type AgentAssignment,
  type RoomTheme,
} from './room-customization';

export {
  RoomConfigurationManager,
  getRoomConfigManager,
  getWorkspaceFurniture,
  getRestFurniture,
  calculateAgentPosition,
  exportRoomConfiguration,
  importRoomConfiguration,
  type AgentRoomAssignment,
  type NodeRoomConfig,
} from './room-integration';
