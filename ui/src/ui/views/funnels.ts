/**
 * Funnels Main View
 * Futuristic Terminal HUD Theme - Visual Funnel Command Center
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons";
import type { GatewayBrowserClient } from "../gateway";
import {
  getFunnelsState,
  setFunnelsRequestUpdate,
  setFunnelsClient,
  initFunnels,
  selectFunnel,
  selectStage,
  setSearchQuery,
  setStatusFilter,
  toggleSidebarCollapsed,
  toggleDetailPanelCollapsed,
  setTimeRange,
  setKPIView,
  setDetailTab,
  setDraggedStageType,
  createFunnel,
  createFunnelWithTemplate,
  applyDefaultStages,
  getTemplates,
  deleteFunnel,
  duplicateFunnel,
  updateStage,
  addKPI,
  updateKPI,
  deleteKPI,
  addSOPItem,
  toggleSOPItem,
  deleteSOPItem,
  loadAnalytics,
  loadFunnels,
  getSelectedFunnel,
  getSelectedStage,
  addStage,
  type FunnelsState,
  type FunnelTemplate,
} from "../controllers/funnels";
import { renderFunnelSidebar, type FunnelSidebarProps } from "./funnels-sidebar";
import { renderFunnelCanvas, type FunnelCanvasProps, type FunnelStageType } from "./funnels-canvas";
import { renderFunnelDetailPanel, type FunnelDetailPanelProps } from "./funnels-detail-panel";
import { renderFunnelKPIDashboard, type FunnelKPIDashboardProps } from "./funnels-kpi-dashboard";
import {
  renderFunnelFlowMap,
  createEmptyFlowMap,
  buildJourneyFlowMap,
  JOURNEY_TEMPLATES,
  type FunnelFlowMapProps,
  type FunnelFlowMap,
} from "./funnel-flow-map";
import {
  renderFunnelsOnboarding,
  resetOnboardingState,
  type FunnelsOnboardingProps,
} from "./funnels-onboarding";
import { renderFunnelPageEditor, type FunnelPageEditorProps } from "./funnels-page-editor";
import { renderFunnelsFlowEndToEnd } from "./funnels-flow-end-to-end";
import { renderAgencyFunnelOps } from "./agency-funnel-ops";
import { renderFunnelLeads } from "./funnel-leads";
import { bizAurora, bizGlassStyles, bizIcons, bizSeg, type BizSegItem } from "./biz-glass";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export interface FunnelsViewProps {
  requestUpdate: () => void;
  client?: GatewayBrowserClient;
}

// ══════════════════════════════════════════════════════════════════════════════
// Module State
// ══════════════════════════════════════════════════════════════════════════════

type FunnelsView = "operating" | "builder" | "analytics" | "flow" | "leads";

let _initialized = false;
let _activeView: FunnelsView = "operating";
// Builder canvas defaults to the per-funnel stage canvas — picking a
// funnel in the sidebar should immediately show its stages. Users can
// flip to the cross-funnel flow map via the in-canvas toggle.
let _canvasMode: "stages" | "flowmap" = "stages";
let _showNewFunnelDialog = false;
let _newFunnelForm = {
  name: "",
  description: "",
  businessIds: [] as string[],
  template: "" as FunnelTemplate | "",
};
let _creatingFunnel = false;
let _currentFlowMap: FunnelFlowMap | null = null; // Current flow map (loaded from storage)
let _flowMapLoading = false;
let _flowMapLoadAttempted = false;
let _savedFlowMaps: FunnelFlowMap[] = []; // Other saved journeys for the sidebar list
let _savedFlowMapsLoaded = false;
let _onboardingDismissed = false; // Track if user dismissed onboarding

// ══════════════════════════════════════════════════════════════════════════════
// SVG Icons
// ══════════════════════════════════════════════════════════════════════════════

const funnelIcons = {
  users: html`
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  `,
  target: html`
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  `,
  grid: html`
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  `,
  chart: html`
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  `,
  funnel: html`
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
    </svg>
  `,
  plus: html`
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  `,
  x: html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  `,
  mobile: html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  `,
  mail: html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  `,
  video: html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  `,
  crosshair: html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="22" y1="12" x2="18" y2="12" />
      <line x1="6" y1="12" x2="2" y2="12" />
      <line x1="12" y1="6" x2="12" y2="2" />
      <line x1="12" y1="22" x2="12" y2="18" />
    </svg>
  `,
  refresh: html`
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  `,
  activity: html`
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  `,
  layers: html`
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  `,
};

// ══════════════════════════════════════════════════════════════════════════════
// Main Render
// ══════════════════════════════════════════════════════════════════════════════

export function renderFunnels(props: FunnelsViewProps): TemplateResult {
  const { requestUpdate, client } = props;

  // Initialize on first render
  if (!_initialized && client) {
    _initialized = true;
    setFunnelsRequestUpdate(requestUpdate);
    setFunnelsClient(client);
    initFunnels(client);
  }

  const state = getFunnelsState();
  const selectedFunnel = getSelectedFunnel();
  const selectedStage = getSelectedStage();

  // Show onboarding wizard for first-time users (no funnels yet)
  const showOnboarding =
    // The Lead Engine loads its own business/funnel scope and renders an
    // explicit "no funnel selected" state, so the builder onboarding wizard
    // must not hijack it the way it would any other empty view.
    _activeView !== "operating" &&
    _activeView !== "leads" &&
    !state.loading &&
    state.funnels.length === 0 &&
    !_onboardingDismissed;

  if (showOnboarding) {
    const onboardingProps: FunnelsOnboardingProps = {
      businesses: state.businesses,
      requestUpdate,
      client,
      onComplete: () => {
        resetOnboardingState();
        loadFunnels(); // Reload to show the new funnel
        requestUpdate();
      },
    };

    return html`
      ${bizGlassStyles()}
      <style>${funnelsStyles}</style>
      <div class="funnels-hud bzg">
        ${bizAurora()}
        ${renderFunnelsOnboarding(onboardingProps)}
      </div>
    `;
  }

  return html`
    ${bizGlassStyles()}
    <style>
      ${funnelsStyles}
    </style>
    <div class="funnels-hud bzg">
      ${bizAurora()}
      
      <!-- Header -->
      ${renderHeader(state, requestUpdate)}

      <!-- Main Content -->
      <div class="funnels-hud__content">
        ${
          _activeView === "operating"
            ? renderAgencyFunnelOps({ client, requestUpdate })
            : _activeView === "leads"
            ? renderFunnelLeads({ client, requestUpdate })
            : _activeView === "builder"
              ? renderBuilderView(state, selectedFunnel, selectedStage, requestUpdate, client)
              : _activeView === "flow"
                ? renderFunnelsFlowEndToEnd({
                    funnelId: state.selectedFunnelId,
                    client,
                    requestUpdate,
                  })
                : renderAnalyticsView(state, selectedFunnel, requestUpdate)
        }
      </div>

      <!-- New Funnel Dialog -->
      ${_showNewFunnelDialog ? renderNewFunnelDialog(state, requestUpdate) : nothing}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Header
// ══════════════════════════════════════════════════════════════════════════════

const FUNNEL_VIEWS: ReadonlyArray<BizSegItem<FunnelsView>> = [
  { id: "operating", label: "Operating map", icon: "overview", title: "The agency's core funnel, its sub-funnels, setup health and KPIs" },
  { id: "leads", label: "Lead engine", icon: "pipeline", title: "Pipeline (Business hub deals), offers, tasks, metrics and funnel intelligence" },
  { id: "builder", label: "Builder", icon: "file", title: "Design funnel stages and customer journeys" },
  { id: "flow", label: "Flow", icon: "tracking", title: "End-to-end flow: traffic → pages → forms → leads" },
  { id: "analytics", label: "Analytics", icon: "revenue", title: "Funnel KPIs and stage conversion" },
];

function renderHeader(state: FunnelsState, requestUpdate: () => void): TemplateResult {
  const active = state.funnels.filter((f) => f.status === "active").length;
  return html`
    <div class="funnels-hud__header">
      <div class="funnels-hud__header-left">
        <div class="funnels-hud__header-title">
          <span class="bzg-eyebrow"><i class="bzg-live" aria-hidden="true"></i>Funnels & Forms</span>
          <h1 class="bzg-title">Funnels</h1>
          <span class="funnels-hud__header-status">
            ${state.funnels.length} funnel${state.funnels.length === 1 ? "" : "s"}${active ? html` · ${active} live` : nothing}
          </span>
        </div>
      </div>
      <nav class="funnels-hud__view-toggle" aria-label="Funnel views">
        ${bizSeg(FUNNEL_VIEWS, _activeView, (id) => {
          _activeView = id;
          requestUpdate();
        }, "Funnel views")}
      </nav>
      <div class="funnels-hud__header-right">
        <button class="g-btn g-btn--ghost bzg-btn bzg-btn--ghost funnels-hud__refresh-btn" @click=${() => loadFunnels()} title="Refresh" aria-label="Refresh funnels">
          ${bizIcons.refresh()}
        </button>
        <button class="g-btn g-btn--primary bzg-btn bzg-btn--primary funnels-hud__new-btn" @click=${() => {
          _showNewFunnelDialog = true;
          requestUpdate();
        }}>
          ${bizIcons.plus()}
          <span>New funnel</span>
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Builder View
// ══════════════════════════════════════════════════════════════════════════════

function renderBuilderView(
  state: FunnelsState,
  selectedFunnel: ReturnType<typeof getSelectedFunnel>,
  selectedStage: ReturnType<typeof getSelectedStage>,
  requestUpdate: () => void,
  client?: GatewayBrowserClient,
): TemplateResult {
  // Helper used by the Journeys sidebar panel to push a flow map into
  // the canvas. Always switches to flow-map mode so the user actually
  // sees what they picked.
  const showFlowMap = (flowMap: FunnelFlowMap) => {
    _currentFlowMap = flowMap;
    _canvasMode = "flowmap";
    // Optimistically merge into the saved list so the sidebar reflects
    // the active journey without a round-trip. Avoids a flash where the
    // user picks a template, sees the canvas populate, but the Saved
    // panel still says "no saved journeys".
    if (!_savedFlowMaps.some((f) => f.id === flowMap.id)) {
      _savedFlowMaps = [flowMap, ..._savedFlowMaps];
    } else {
      _savedFlowMaps = _savedFlowMaps.map((f) => (f.id === flowMap.id ? flowMap : f));
    }
    requestUpdate();
    if (client) {
      client
        .request<{ flowMap?: { id: string } }>("funnels.flowmap.save", {
          id: flowMap.id,
          name: flowMap.name,
          businessId: flowMap.businessId || state.businesses[0]?.id || "",
          nodes: flowMap.nodes,
          connections: flowMap.connections,
        })
        .catch((e) => console.error("[funnels] persist journey failed:", e));
    }
  };

  // Sidebar props
  const sidebarProps: FunnelSidebarProps = {
    funnels: state.funnels,
    selectedFunnelId: state.selectedFunnelId,
    loading: state.loading,
    searchQuery: state.searchQuery,
    statusFilter: state.statusFilter,
    collapsed: state.sidebarCollapsed,
    onSelectFunnel: (id) => {
      // Always show the per-funnel canvas when the user picks a funnel.
      // (Builder previously defaulted to the cross-funnel flow map, so
      // clicks updated state silently with no visual change.)
      _canvasMode = "stages";
      selectFunnel(id);
    },
    onCreateFunnel: () => {
      _showNewFunnelDialog = true;
      requestUpdate();
    },
    onDeleteFunnel: deleteFunnel,
    onDuplicateFunnel: async (id, newName) => {
      await duplicateFunnel(id, newName);
    },
    onSearchChange: setSearchQuery,
    onStatusFilterChange: setStatusFilter,
    onToggleCollapsed: toggleSidebarCollapsed,
    onDragStageStart: setDraggedStageType,
    requestUpdate,
    journeys: {
      templates: JOURNEY_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        emoji: t.emoji,
        isTemplate: true,
      })),
      saved: _savedFlowMaps.map((f) => ({
        id: f.id,
        name: f.name,
        description: `${f.nodes.length} step${f.nodes.length === 1 ? "" : "s"}`,
        emoji: "💼",
        isTemplate: false,
        selected: _currentFlowMap?.id === f.id,
      })),
      onPickTemplate: (templateId) => {
        const businessId = state.businesses[0]?.id || "";
        showFlowMap(buildJourneyFlowMap(templateId, businessId));
      },
      onPickSaved: (id) => {
        const found = _savedFlowMaps.find((f) => f.id === id);
        if (found) showFlowMap(found);
      },
      onCreateCustom: () => {
        const businessId = state.businesses[0]?.id || "";
        showFlowMap(createEmptyFlowMap(businessId));
      },
      onDeleteSaved: async (id) => {
        if (!client) return;
        try {
          await client.request("funnels.flowmap.delete", { id });
        } catch (e) {
          console.error("[funnels] delete journey failed:", e);
        }
        _savedFlowMaps = _savedFlowMaps.filter((f) => f.id !== id);
        // If the deleted journey was the active canvas, clear it.
        if (_currentFlowMap?.id === id) _currentFlowMap = null;
        requestUpdate();
      },
      onClearAllSaved: async () => {
        if (!client) return;
        const targets = [..._savedFlowMaps];
        await Promise.allSettled(
          targets.map((f) =>
            client
              .request("funnels.flowmap.delete", { id: f.id })
              .catch((e) => console.error(`[funnels] delete ${f.id} failed:`, e)),
          ),
        );
        _savedFlowMaps = [];
        _currentFlowMap = null;
        requestUpdate();
      },
    },
  };

  // Canvas props
  const canvasProps: FunnelCanvasProps = {
    funnel: selectedFunnel,
    loading: state.loading && !!state.selectedFunnelId,
    selectedStageId: state.selectedStageId,
    onSelectStage: selectStage,
    onUpdateStage: updateStage,
    onDeleteStage: async (stageId) => {
      const { deleteStage } = await import("../controllers/funnels");
      deleteStage(stageId);
    },
    onAddStage: async (type, position) => {
      if (selectedFunnel) {
        await addStage(selectedFunnel.id, `New ${type} Stage`, type, position);
      }
    },
    onConnectStages: async (sourceId, targetId) => {
      if (selectedFunnel) {
        const { connectStages } = await import("../controllers/funnels");
        connectStages(selectedFunnel.id, sourceId, targetId);
      }
    },
    onDeleteConnection: async (connectionId) => {
      if (!selectedFunnel) return;
      const { disconnectStages } = await import("../controllers/funnels");
      await disconnectStages(selectedFunnel.id, connectionId);
    },
    onMoveStage: (stageId, position) => updateStage(stageId, { position }),
    requestUpdate,
  };

  // Detail panel props
  const detailProps: FunnelDetailPanelProps = {
    stage: selectedStage,
    loading: false,
    collapsed: state.detailPanelCollapsed,
    activeTab: state.detailTab,
    onUpdateStage: updateStage,
    onAddKPI: addKPI,
    onUpdateKPI: updateKPI,
    onDeleteKPI: deleteKPI,
    onAddSOPItem: addSOPItem,
    onToggleSOPItem: toggleSOPItem,
    onDeleteSOPItem: deleteSOPItem,
    onClose: () => selectStage(null),
    onToggleCollapsed: toggleDetailPanelCollapsed,
    onTabChange: setDetailTab,
    requestUpdate,
  };

  // Flow Map Props (for new vertical flow system)
  const flowMapProps: FunnelFlowMapProps = {
    flowMap: _currentFlowMap,
    loading: _flowMapLoading,
    onSave: (flowMap) => {
      // Set immediately for instant UI update
      _currentFlowMap = flowMap;
      requestUpdate();

      // Then save to gateway async (persisted + synced across federation)
      if (client) {
        client
          .request<{ flowMap?: { id: string } }>("funnels.flowmap.save", {
            id: flowMap.id,
            name: flowMap.name,
            businessId: flowMap.businessId || state.businesses[0]?.id || "",
            nodes: flowMap.nodes,
            connections: flowMap.connections,
          })
          .then((result) => {
            if (result?.flowMap?.id) {
              console.log("[funnels] Flow map saved to gateway:", result.flowMap.id);
            }
          })
          .catch((e) => {
            console.error("[funnels] Failed to save flow map to gateway:", e);
            // Fallback to localStorage
            localStorage.setItem("infinibot_flowmap", JSON.stringify(flowMap));
          });
      } else {
        // Fallback to localStorage if no client
        localStorage.setItem("infinibot_flowmap", JSON.stringify(flowMap));
      }
    },
    onSpawnAI: async (nodeId, capability) => {
      if (!client) {
        alert("AI assist needs a gateway connection.");
        return;
      }
      // `capability` is the full task prompt the flow-map's spawn dialog
      // built up — node name, directory, user instructions, the lot.
      try {
        const res = await client.request<{ status?: string; runId?: string; error?: string }>(
          "sessions.spawn",
          {
            agentId: "coder",
            task: capability,
            label: `Funnel · ${nodeId.slice(0, 8)}`,
            cleanup: "keep",
            runTimeoutSeconds: 600,
          },
        );
        if (res?.status !== "accepted") {
          alert(`AI assist failed: ${res?.error ?? "unknown error"}`);
        }
      } catch (e) {
        console.error("[funnels] sessions.spawn failed:", e);
        alert(`AI assist failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    requestUpdate,
    client,
  };

  // Load flow maps from gateway on first render — populates the
  // "Saved journeys" list AND picks the most-recent as the canvas.
  if (!_savedFlowMapsLoaded && !_flowMapLoading) {
    _flowMapLoading = true;
    _savedFlowMapsLoaded = true;
    _flowMapLoadAttempted = true;

    (async () => {
      try {
        if (client) {
          const list = await client.request<{ flowMaps?: FunnelFlowMap[] }>(
            "funnels.flowmap.list",
            {},
          );
          _savedFlowMaps = list?.flowMaps ?? [];
          // Pick the most-recent journey as the active canvas so the
          // Flow Map mode always populates instead of greeting the user
          // with an empty state.
          if (_currentFlowMap === null && _savedFlowMaps.length > 0) {
            _currentFlowMap = _savedFlowMaps[0]!;
          }
        }
        // Local fallback — in case the gateway is down.
        if (_currentFlowMap === null) {
          const saved = localStorage.getItem("infinibot_flowmap");
          if (saved) _currentFlowMap = JSON.parse(saved);
        }
      } catch (e) {
        console.error("[funnels] Failed to list flow maps:", e);
      } finally {
        _flowMapLoading = false;
        requestUpdate();
      }
    })();
  }

  return html`
    <div class="funnels-hud__builder">
      <!-- Sidebar -->
      ${renderFunnelSidebar(sidebarProps)}

      <!-- Canvas Mode Toggle -->
      <div class="funnels-hud__canvas-toggle">
        <button class="funnels-hud__toggle-btn ${_canvasMode === "stages" ? "active" : ""}"
          @click=${() => {
            _canvasMode = "stages";
            requestUpdate();
          }}>
          <span>📊</span> Stage View
        </button>
        <button class="funnels-hud__toggle-btn ${_canvasMode === "flowmap" ? "active" : ""}"
          @click=${() => {
            _canvasMode = "flowmap";
            requestUpdate();
          }}>
          <span>🗺️</span> Flow Map
        </button>
      </div>

      <!-- Canvas / Flow Map -->
      <div class="funnels-hud__canvas-container">
        ${
          _canvasMode === "flowmap"
            ? renderFunnelFlowMap(flowMapProps)
            : selectedFunnel
              ? renderFunnelCanvas(canvasProps)
              : renderEmptyCanvas(requestUpdate)
        }
      </div>

      <!-- Detail Panel (only for stage view) -->
      ${
        _canvasMode === "stages" && (!state.detailPanelCollapsed || selectedStage)
          ? renderFunnelDetailPanel(detailProps)
          : nothing
      }
    </div>
  `;
}

function renderEmptyCanvas(requestUpdate: () => void): TemplateResult {
  return html`
    <div class="funnels-hud__empty-canvas">
      <div class="funnels-hud__grid-bg"></div>
      <div class="funnels-hud__empty-content">
        <div class="funnels-hud__empty-icon">${funnelIcons.funnel}</div>
        <h2>NO FUNNEL SELECTED</h2>
        <p>Select a funnel from the sidebar or initialize a new conversion sequence</p>
        <button class="funnels-hud__empty-btn" @click=${() => {
          _showNewFunnelDialog = true;
          requestUpdate();
        }}>
          ${funnelIcons.plus}
          <span>INITIALIZE NEW FUNNEL</span>
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Analytics View
// ══════════════════════════════════════════════════════════════════════════════

function renderAnalyticsView(
  state: FunnelsState,
  selectedFunnel: ReturnType<typeof getSelectedFunnel>,
  requestUpdate: () => void,
): TemplateResult {
  const dashboardProps: FunnelKPIDashboardProps = {
    funnel: selectedFunnel,
    allFunnels: state.funnels,
    metrics: state.metrics,
    loading: state.loading,
    timeRange: state.timeRange,
    view: state.kpiView,
    onTimeRangeChange: setTimeRange,
    onViewChange: setKPIView,
    onRefresh: () => loadAnalytics(state.selectedFunnelId || undefined),
    requestUpdate,
  };

  return html`
    <div class="funnels-hud__analytics">
      <!-- Funnel Selector Sidebar -->
      <div class="funnels-hud__analytics-sidebar">
        <div class="funnels-hud__analytics-sidebar-header">
          <span class="funnels-hud__sidebar-label">${funnelIcons.layers}</span>
          <h3>FUNNEL SELECT</h3>
        </div>
        <div class="funnels-hud__analytics-funnel-list">
          <button class="funnels-hud__analytics-funnel-item ${!state.selectedFunnelId ? "selected" : ""}"
            @click=${() => selectFunnel(null)}>
            ${funnelIcons.activity}
            <span>ALL FUNNELS</span>
          </button>
          ${state.funnels.map(
            (funnel) => html`
            <button class="funnels-hud__analytics-funnel-item ${state.selectedFunnelId === funnel.id ? "selected" : ""}"
              @click=${() => selectFunnel(funnel.id)}>
              ${funnelIcons.funnel}
              <span>${funnel.name.toUpperCase()}</span>
            </button>
          `,
          )}
        </div>
      </div>

      <!-- Dashboard -->
      <div class="funnels-hud__analytics-main">
        ${renderFunnelKPIDashboard(dashboardProps)}
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// New Funnel Dialog
// ══════════════════════════════════════════════════════════════════════════════

function renderNewFunnelDialog(state: FunnelsState, requestUpdate: () => void): TemplateResult {
  const templates = getTemplates();

  const handleClose = () => {
    if (_creatingFunnel) return; // Don't close while creating
    _showNewFunnelDialog = false;
    _newFunnelForm = { name: "", description: "", businessIds: [], template: "" };
    requestUpdate();
  };

  const selectTemplate = (templateId: FunnelTemplate) => {
    const wasSelected = _newFunnelForm.template === templateId;
    _newFunnelForm.template = wasSelected ? "" : templateId;
    if (!wasSelected) {
      const tpl = templates.find((t) => t.id === templateId);
      if (tpl && !_newFunnelForm.name) {
        _newFunnelForm.name = tpl.name;
      }
    }
    requestUpdate();
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    console.log("[funnels] handleSubmit called", {
      form: _newFunnelForm,
      businesses: state.businesses,
    });
    if (_creatingFunnel) return;
    if (!_newFunnelForm.name.trim() && !_newFunnelForm.template) {
      console.log("[funnels] handleSubmit: no name or template, returning");
      return;
    }

    _creatingFunnel = true;
    requestUpdate();

    try {
      // Get selected businesses or default to first one
      let businessIds =
        _newFunnelForm.businessIds.length > 0
          ? _newFunnelForm.businessIds
          : state.businesses[0]?.id
            ? [state.businesses[0].id]
            : [];

      console.log("[funnels] businessIds:", businessIds);

      if (businessIds.length === 0) {
        console.log("[funnels] No businesses available, creating default...");
        const { createBusiness } = await import("../controllers/funnels");
        const biz = await createBusiness("Default Business");
        console.log("[funnels] Created business:", biz);
        if (biz) businessIds = [biz.id];
      }

      // Create funnel for each selected business
      for (const businessId of businessIds) {
        const businessName = state.businesses.find((b) => b.id === businessId)?.name || "";
        const funnelName =
          businessIds.length > 1
            ? `${_newFunnelForm.name || _newFunnelForm.template} (${businessName})`
            : _newFunnelForm.name || undefined;

        if (_newFunnelForm.template) {
          // Create with template (includes stages)
          console.log("[funnels] Creating funnel with template for:", businessName);
          const funnel = await createFunnelWithTemplate(
            businessId,
            _newFunnelForm.template,
            funnelName,
          );
          console.log("[funnels] Created funnel with template:", funnel);
        } else {
          // Create empty funnel, then add basic stages
          console.log("[funnels] Creating empty funnel for:", businessName);
          const funnel = await createFunnel(
            businessId,
            funnelName || _newFunnelForm.name.trim(),
            _newFunnelForm.description,
          );
          console.log("[funnels] Created empty funnel:", funnel);
          if (funnel) {
            // Add 3 basic stages for empty funnel
            // Shared helper — same Attract / Engage / Convert defaults
            // (with descriptions) used by the onboarding wizard. Previously
            // this path created bare Start / Process / End stages with no
            // descriptions, which made un-templated funnels look noticeably
            // sparser than templated ones in the canvas.
            await applyDefaultStages(funnel.id);
            console.log("[funnels] Added stages to funnel");
          }
        }
      }
    } catch (err) {
      console.error("[funnels] Error creating funnel:", err);
    } finally {
      _creatingFunnel = false;
      _showNewFunnelDialog = false;
      _newFunnelForm = { name: "", description: "", businessIds: [], template: "" };
      requestUpdate();
    }
  };

  const templateIcons: Record<FunnelTemplate, TemplateResult> = {
    highTicket: html`
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
    `,
    midTicket: html`
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    `,
    lowTicket: html`
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <line x1="2" y1="10" x2="22" y2="10" />
      </svg>
    `,
    multiOffer: html`
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    `,
    brandAwareness: html`
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon
          points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
        />
      </svg>
    `,
    leadMagnet: html`
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    `,
  };

  return html`
    <div class="funnels-hud__dialog-overlay" @click=${handleClose}>
      <div class="funnels-hud__dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div class="funnels-hud__dialog-corner tl"></div>
        <div class="funnels-hud__dialog-corner tr"></div>
        <div class="funnels-hud__dialog-corner bl"></div>
        <div class="funnels-hud__dialog-corner br"></div>
        
        <div class="funnels-hud__dialog-header">
          <div class="funnels-hud__dialog-title">
            ${funnelIcons.plus}
            <h3>INITIALIZE NEW FUNNEL</h3>
          </div>
          <button class="funnels-hud__dialog-close" @click=${handleClose} ?disabled=${_creatingFunnel}>
            ${funnelIcons.x}
          </button>
        </div>
        <form @submit=${handleSubmit}>
          <div class="funnels-hud__dialog-body">
            <!-- Templates Section -->
            <div class="funnels-hud__dialog-templates">
              <label>SELECT TEMPLATE (RECOMMENDED)</label>
              <div class="funnels-hud__template-grid-v2">
                ${templates.map(
                  (tpl) => html`
                  <button type="button" 
                    class="funnels-hud__template-card ${_newFunnelForm.template === tpl.id ? "selected" : ""}"
                    @click=${() => selectTemplate(tpl.id)}>
                    <div class="funnels-hud__template-card-icon">${templateIcons[tpl.id]}</div>
                    <div class="funnels-hud__template-card-info">
                      <span class="funnels-hud__template-card-name">${tpl.name}</span>
                      <span class="funnels-hud__template-card-meta">${tpl.stageCount} stages</span>
                    </div>
                    ${
                      _newFunnelForm.template === tpl.id
                        ? html`
                            <div class="funnels-hud__template-card-check">✓</div>
                          `
                        : nothing
                    }
                  </button>
                `,
                )}
              </div>
            </div>

            <div class="funnels-hud__dialog-divider">
              <span>OR CUSTOMIZE</span>
            </div>

            <div class="funnels-hud__dialog-field">
              <label>FUNNEL NAME ${_newFunnelForm.template ? "(OPTIONAL)" : "*"}</label>
              <input type="text" 
                placeholder="e.g., Instagram High-Ticket Funnel"
                .value=${_newFunnelForm.name}
                @input=${(e: Event) => {
                  _newFunnelForm.name = (e.target as HTMLInputElement).value;
                  requestUpdate();
                }}
                ?required=${!_newFunnelForm.template}
              />
            </div>
            <div class="funnels-hud__dialog-field">
              <label>DESCRIPTION</label>
              <textarea 
                placeholder="What does this funnel accomplish?"
                .value=${_newFunnelForm.description}
                @input=${(e: Event) => {
                  _newFunnelForm.description = (e.target as HTMLTextAreaElement).value;
                  requestUpdate();
                }}
                rows="2"
              ></textarea>
            </div>
            <!-- Business Selector (single, dropdown) -->
            <!--
              Funnels are tied to exactly one business — the dropdown enforces
              that contract instead of the older "toggle multiple cards then
              loop-create one funnel per business" flow, which silently
              produced duplicate funnels that drifted apart over time.
            -->
            <div class="funnels-hud__dialog-field">
              <label>BUSINESS ${state.businesses.length === 0 ? "" : "*"}</label>
              <select
                .value=${_newFunnelForm.businessIds[0] ?? ""}
                @change=${(e: Event) => {
                  const id = (e.target as HTMLSelectElement).value;
                  _newFunnelForm.businessIds = id ? [id] : [];
                  requestUpdate();
                }}
                ?disabled=${state.businesses.length === 0}
                ?required=${state.businesses.length > 0}
              >
                <option value="" disabled ?selected=${_newFunnelForm.businessIds.length === 0}>
                  ${state.businesses.length === 0 ? "No businesses — one will be created" : "Select a business…"}
                </option>
                ${state.businesses.map(
                  (biz) => html`
                  <option value=${biz.id} ?selected=${_newFunnelForm.businessIds[0] === biz.id}>
                    ${biz.name}${biz.industry ? ` — ${biz.industry}` : ""}
                  </option>
                `,
                )}
              </select>
            </div>
          </div>
          <div class="funnels-hud__dialog-footer">
            <button type="button" class="funnels-hud__dialog-cancel" @click=${handleClose} ?disabled=${_creatingFunnel}>
              CANCEL
            </button>
            <button type="submit" class="funnels-hud__dialog-submit" 
              ?disabled=${_creatingFunnel || (!_newFunnelForm.name.trim() && !_newFunnelForm.template)}>
              ${
                _creatingFunnel
                  ? html`
                      <span class="funnels-hud__spinner"></span>
                      DEPLOYING...
                    `
                  : html`
                ${funnelIcons.plus}
                DEPLOY FUNNEL
              `
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Infinibot Theme - Black & Gold
// ══════════════════════════════════════════════════════════════════════════════

const funnelsStyles = `
  /* ═══════════════════════════════════════════════════════════════════════════
     Base Container
     ═══════════════════════════════════════════════════════════════════════════ */
  .funnels-hud {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: transparent;
    position: relative;
    overflow: hidden;
    font-family: var(--g-font-family);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     Header — glass bar: title · segmented views · actions
     ═══════════════════════════════════════════════════════════════════════════ */
  .funnels-hud__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px clamp(14px, 2.2vw, 28px) 14px;
    position: relative;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--glass-stroke);
    background: linear-gradient(180deg, var(--glass-gold-a06), transparent 80%);
  }
  .funnels-hud__header::after {
    content: '';
    position: absolute;
    left: 0; right: 0; bottom: -1px; height: 1px;
    background: linear-gradient(90deg, transparent, var(--glass-gold-a40), transparent);
    pointer-events: none;
  }
  .funnels-hud__header-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
  .funnels-hud__header-title { display: grid; gap: 2px; min-width: 0; }
  .funnels-hud__header-title .bzg-title { font-size: clamp(22px, 2vw, 28px); margin: 0; }
  .funnels-hud__header-status { font-size: 12.5px; color: var(--glass-fg-3); font-variant-numeric: tabular-nums; }
  .funnels-hud__view-toggle { flex: 1 1 auto; display: flex; justify-content: center; min-width: 0; }
  .funnels-hud__view-toggle .bzg-seg { border-radius: 14px; }
  .funnels-hud__header-right { display: flex; align-items: center; gap: 8px; }
  .funnels-hud__refresh-btn { width: 36px; padding: 0; }

  @media (max-width: 720px) {
    .funnels-hud__header { align-items: flex-start; gap: 10px; padding: 12px; }
    .funnels-hud__header-left { order: 1; }
    .funnels-hud__header-right { order: 2; margin-left: auto; }
    .funnels-hud__view-toggle { order: 3; flex: 1 0 100%; justify-content: flex-start; }
    .funnels-hud__view-toggle .bzg-seg { width: 100%; }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     Content
     ═══════════════════════════════════════════════════════════════════════════ */
  .funnels-hud__content {
    flex: 1;
    overflow: hidden;
  }

  .funnels-hud__builder {
    display: flex;
    height: 100%;
    position: relative;
  }

  .funnels-hud__canvas-toggle {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 4px;
    padding: 4px;
    background: var(--g-surface-strong);
    border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 12px;
    z-index: 50;
    backdrop-filter: blur(10px);
  }

  .funnels-hud__toggle-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: color-mix(in srgb, var(--g-fg) 50%, transparent);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: inherit;
  }

  .funnels-hud__toggle-btn:hover {
    color: color-mix(in srgb, var(--g-fg) 80%, transparent);
    background: color-mix(in srgb, var(--g-primary) 5%, transparent);
  }

  .funnels-hud__toggle-btn.active {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 15%, transparent) 0%, color-mix(in srgb, var(--g-primary) 10%, transparent) 100%);
    color: var(--g-primary);
    box-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 10%, transparent);
  }

  .funnels-hud__toggle-btn span {
    font-size: 14px;
  }

  .funnels-hud__canvas-container {
    flex: 1;
    position: relative;
    overflow: hidden;
  }

  @media (max-width: 720px) {
    .funnels-hud {
      height: auto;
      min-height: 100%;
      overflow: visible;
    }
    .funnels-hud__content {
      overflow: visible;
    }
    .funnels-hud__builder {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto auto minmax(520px, 68vh) auto;
      height: auto;
      min-height: 0;
    }
    .funnels-hud__canvas-toggle {
      position: static;
      grid-row: 2;
      transform: none;
      justify-self: center;
      margin: 12px;
      max-width: calc(100% - 24px);
    }
    .funnels-hud__toggle-btn {
      min-width: 0;
      padding: 9px 14px;
    }
    .funnels-hud__canvas-container {
      grid-row: 3;
      min-width: 0;
      min-height: 520px;
      border-top: 1px solid var(--glass-stroke);
    }
    .funnels-hud__empty-content {
      padding: 28px 20px;
    }
    .funnels-hud__empty-content h2 {
      font-size: 16px;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     Empty Canvas
     ═══════════════════════════════════════════════════════════════════════════ */
  .funnels-hud__empty-canvas {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    position: relative;
  }

  .funnels-hud__grid-bg {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-image: 
      linear-gradient(color-mix(in srgb, var(--g-primary) 2%, transparent) 1px, transparent 1px),
      linear-gradient(90deg, color-mix(in srgb, var(--g-primary) 2%, transparent) 1px, transparent 1px);
    background-size: 40px 40px;
    mask-image: radial-gradient(ellipse at center, color-mix(in srgb, var(--glass-base) 60%, transparent) 0%, transparent 70%);
  }

  .funnels-hud__empty-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 40px;
    position: relative;
    z-index: 1;
  }

  .funnels-hud__empty-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 80px;
    height: 80px;
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    border: 2px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 16px;
    color: color-mix(in srgb, var(--g-primary) 35%, transparent);
    margin-bottom: 24px;
    box-shadow: 0 0 30px color-mix(in srgb, var(--g-primary) 8%, transparent), inset 0 0 15px color-mix(in srgb, var(--g-primary) 2%, transparent);
  }

  .funnels-hud__empty-icon svg {
    width: 36px;
    height: 36px;
  }

  .funnels-hud__empty-content h2 {
    margin: 0 0 12px 0;
    font-size: 18px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-primary) 70%, transparent);
    letter-spacing: 3px;
    text-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  .funnels-hud__empty-content p {
    margin: 0 0 28px 0;
    font-size: 13px;
    color: color-mix(in srgb, var(--g-fg) 35%, transparent);
    max-width: 400px;
    letter-spacing: 0.5px;
    line-height: 1.6;
  }

  .funnels-hud__empty-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 28px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 12%, transparent) 0%, color-mix(in srgb, var(--g-primary) 8%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
    border-radius: 8px;
    color: var(--g-primary);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 1px;
    cursor: pointer;
    transition: all 0.25s ease;
    font-family: inherit;
    box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 12%, transparent);
  }

  .funnels-hud__empty-btn:hover {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 20%, transparent) 0%, color-mix(in srgb, var(--g-primary) 15%, transparent) 100%);
    box-shadow: 0 0 30px color-mix(in srgb, var(--g-primary) 20%, transparent), 0 4px 20px rgba(0, 0, 0, 0.3);
    transform: translateY(-2px);
  }

  .funnels-hud__empty-btn svg {
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--g-primary) 40%, transparent));
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     Analytics View
     ═══════════════════════════════════════════════════════════════════════════ */
  .funnels-hud__analytics {
    display: flex;
    height: 100%;
  }

  .funnels-hud__analytics-sidebar {
    width: 220px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 2%, transparent) 0%, transparent 100%);
    border-right: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    display: flex;
    flex-direction: column;
  }

  .funnels-hud__analytics-sidebar-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
  }

  .funnels-hud__sidebar-label {
    color: color-mix(in srgb, var(--g-primary) 40%, transparent);
  }

  .funnels-hud__sidebar-label svg {
    width: 16px;
    height: 16px;
  }

  .funnels-hud__analytics-sidebar-header h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    letter-spacing: 2px;
  }

  .funnels-hud__analytics-funnel-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .funnels-hud__analytics-funnel-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.5px;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
  }

  .funnels-hud__analytics-funnel-item svg {
    width: 14px;
    height: 14px;
    opacity: 0.5;
    color: color-mix(in srgb, var(--g-primary) 50%, transparent);
  }

  .funnels-hud__analytics-funnel-item:hover {
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    color: color-mix(in srgb, var(--g-fg) 70%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 10%, transparent);
  }

  .funnels-hud__analytics-funnel-item.selected {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, color-mix(in srgb, var(--g-primary) 4%, transparent) 100%);
    border-color: color-mix(in srgb, var(--g-primary) 25%, transparent);
    color: var(--g-primary);
    box-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 8%, transparent);
  }

  .funnels-hud__analytics-funnel-item.selected svg {
    opacity: 1;
    color: var(--g-primary);
    filter: drop-shadow(0 0 3px color-mix(in srgb, var(--g-primary) 40%, transparent));
  }

  .funnels-hud__analytics-main {
    flex: 1;
    overflow: hidden;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     Dialog
     ═══════════════════════════════════════════════════════════════════════════ */
  .funnels-hud__dialog-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: color-mix(in srgb, var(--g-bg-deep) 78%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
  }

  .funnels-hud__dialog {
    width: 680px;
    max-width: 95vw;
    max-height: 85vh;
    background:
      linear-gradient(var(--g-glass-tint, transparent), var(--g-glass-tint, transparent)),
      var(--g-gradient-surface);
    border: 1px solid var(--g-glass-border, var(--g-border));
    border-radius: var(--g-radius-lg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
    backdrop-filter: var(--g-blur-heavy);
    -webkit-backdrop-filter: var(--g-blur-heavy);
    box-shadow:
      var(--g-shadow-lg),
      0 0 80px color-mix(in srgb, var(--g-primary) 14%, transparent),
      inset 0 1px 0 var(--g-edge-light, rgba(255,255,255,0.10)),
      inset 0 -1px 0 var(--g-edge-shadow, rgba(0,0,0,0.45));
    isolation: isolate;
  }

  /* Corner decorations */
  .funnels-hud__dialog-corner {
    position: absolute;
    width: 20px;
    height: 20px;
    border: 2px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
  }

  .funnels-hud__dialog-corner.tl {
    top: -1px;
    left: -1px;
    border-right: none;
    border-bottom: none;
    border-radius: 12px 0 0 0;
  }

  .funnels-hud__dialog-corner.tr {
    top: -1px;
    right: -1px;
    border-left: none;
    border-bottom: none;
    border-radius: 0 12px 0 0;
  }

  .funnels-hud__dialog-corner.bl {
    bottom: -1px;
    left: -1px;
    border-right: none;
    border-top: none;
    border-radius: 0 0 0 12px;
  }

  .funnels-hud__dialog-corner.br {
    bottom: -1px;
    right: -1px;
    border-left: none;
    border-top: none;
    border-radius: 0 0 12px 0;
  }

  .funnels-hud__dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 22px 28px;
    border-bottom: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
    background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 3%, transparent) 0%, transparent 100%);
    flex-shrink: 0;
  }

  .funnels-hud__dialog-title {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--g-primary);
  }

  .funnels-hud__dialog-title svg {
    width: 20px;
    height: 20px;
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--g-primary) 40%, transparent));
  }

  .funnels-hud__dialog-title h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 2px;
    text-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  .funnels-hud__dialog-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--destructive, #ef4444) 15%, transparent);
    border-radius: 6px;
    color: color-mix(in srgb, var(--destructive, #ef4444) 40%, transparent);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .funnels-hud__dialog-close:hover {
    background: color-mix(in srgb, var(--destructive, #ef4444) 8%, transparent);
    border-color: color-mix(in srgb, var(--destructive, #ef4444) 30%, transparent);
    color: var(--destructive, #ef4444);
  }

  .funnels-hud__dialog-body {
    padding: 24px 28px;
    overflow-y: auto;
    flex: 1;
    max-height: calc(85vh - 160px);
  }

  .funnels-hud__dialog-body::-webkit-scrollbar {
    width: 6px;
  }

  .funnels-hud__dialog-body::-webkit-scrollbar-track {
    background: color-mix(in srgb, var(--g-primary) 2%, transparent);
    border-radius: 3px;
  }

  .funnels-hud__dialog-body::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 3px;
  }

  .funnels-hud__dialog-body::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  .funnels-hud__dialog-field {
    margin-bottom: 20px;
  }

  .funnels-hud__dialog-field label {
    display: block;
    font-size: 10px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    letter-spacing: 1.5px;
    margin-bottom: 8px;
  }

  .funnels-hud__dialog-field input,
  .funnels-hud__dialog-field textarea,
  .funnels-hud__dialog-field select {
    width: 100%;
    padding: 12px 14px;
    background: color-mix(in srgb, var(--g-primary) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
    border-radius: 8px;
    color: color-mix(in srgb, var(--g-fg) 90%, transparent);
    font-size: 13px;
    outline: none;
    transition: all 0.15s ease;
    box-sizing: border-box;
    font-family: inherit;
  }

  .funnels-hud__dialog-field input:focus,
  .funnels-hud__dialog-field textarea:focus,
  .funnels-hud__dialog-field select:focus {
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    box-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 8%, transparent);
  }

  .funnels-hud__dialog-field input::placeholder,
  .funnels-hud__dialog-field textarea::placeholder {
    color: color-mix(in srgb, var(--g-fg) 20%, transparent);
    letter-spacing: 0.5px;
  }

  .funnels-hud__dialog-field textarea {
    resize: vertical;
    min-height: 80px;
  }

  .funnels-hud__dialog-templates {
    margin-bottom: 20px;
  }

  .funnels-hud__dialog-templates label {
    display: block;
    font-size: 10px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    letter-spacing: 1.5px;
    margin-bottom: 12px;
  }

  .funnels-hud__template-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }

  .funnels-hud__template-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px;
    background: color-mix(in srgb, var(--g-primary) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-radius: 8px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
    font-family: inherit;
  }

  .funnels-hud__template-btn svg {
    width: 16px;
    height: 16px;
    opacity: 0.5;
    color: color-mix(in srgb, var(--g-primary) 50%, transparent);
  }

  .funnels-hud__template-btn:hover {
    background: color-mix(in srgb, var(--g-primary) 6%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 18%, transparent);
    color: color-mix(in srgb, var(--g-fg) 80%, transparent);
  }

  .funnels-hud__template-btn:hover svg {
    opacity: 1;
    color: var(--g-primary);
    filter: drop-shadow(0 0 3px color-mix(in srgb, var(--g-primary) 40%, transparent));
  }

  .funnels-hud__dialog-footer {
    display: flex;
    gap: 12px;
    justify-content: flex-end;
    padding: 20px 28px;
    border-top: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
    background: var(--g-surface);
    flex-shrink: 0;
  }

  .funnels-hud__dialog-cancel,
  .funnels-hud__dialog-submit {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
  }

  .funnels-hud__dialog-cancel {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--g-fg) 12%, transparent);
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
  }

  .funnels-hud__dialog-cancel:hover {
    background: color-mix(in srgb, var(--g-fg) 4%, transparent);
    border-color: color-mix(in srgb, var(--g-fg) 20%, transparent);
    color: white;
  }

  .funnels-hud__dialog-submit {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 15%, transparent) 0%, color-mix(in srgb, var(--g-primary) 10%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
    color: var(--g-primary);
    box-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 10%, transparent);
  }

  .funnels-hud__dialog-submit:hover:not(:disabled) {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 22%, transparent) 0%, color-mix(in srgb, var(--g-primary) 18%, transparent) 100%);
    box-shadow: 0 0 25px color-mix(in srgb, var(--g-primary) 18%, transparent);
  }

  .funnels-hud__dialog-submit:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .funnels-hud__dialog-submit svg {
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--g-primary) 40%, transparent));
  }

  /* Template Cards V2 */
  .funnels-hud__template-grid-v2 {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .funnels-hud__template-card {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 14px 16px;
    background: color-mix(in srgb, var(--g-primary) 2%, transparent);
    border: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.2s ease;
    text-align: left;
    font-family: inherit;
  }

  .funnels-hud__template-card:hover {
    background: color-mix(in srgb, var(--g-primary) 4%, transparent);
    border-color: color-mix(in srgb, var(--g-primary) 15%, transparent);
    transform: translateX(4px);
  }

  .funnels-hud__template-card.selected {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 10%, transparent) 0%, color-mix(in srgb, var(--g-primary) 6%, transparent) 100%);
    border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
    box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 10%, transparent);
  }

  .funnels-hud__template-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    background: color-mix(in srgb, var(--g-primary) 6%, transparent);
    border-radius: 8px;
    color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    flex-shrink: 0;
  }

  .funnels-hud__template-card.selected .funnels-hud__template-card-icon {
    background: color-mix(in srgb, var(--g-primary) 12%, transparent);
    color: var(--g-primary);
  }

  .funnels-hud__template-card-icon svg {
    width: 18px;
    height: 18px;
  }

  .funnels-hud__template-card-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .funnels-hud__template-card-name {
    font-size: 13px;
    font-weight: 600;
    color: color-mix(in srgb, var(--g-fg) 85%, transparent);
  }

  .funnels-hud__template-card.selected .funnels-hud__template-card-name {
    color: var(--g-primary);
  }

  .funnels-hud__template-card-meta {
    font-size: 11px;
    color: color-mix(in srgb, var(--g-fg) 35%, transparent);
  }

  .funnels-hud__template-card-check {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 50%;
    color: var(--g-primary);
    font-size: 12px;
    font-weight: 700;
  }

  /* Business Selector */
  .funnels-hud__business-selector {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .funnels-hud__business-card {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 180px;
    padding: 16px 18px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-fg) 2%, transparent) 0%, color-mix(in srgb, var(--g-fg) 1%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-fg) 6%, transparent);
    border-radius: 14px;
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    text-align: left;
    font-family: inherit;
    position: relative;
    overflow: hidden;
  }

  .funnels-hud__business-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, transparent 60%);
    opacity: 0;
    transition: opacity 0.25s ease;
  }

  .funnels-hud__business-card:hover {
    border-color: color-mix(in srgb, var(--g-primary) 20%, transparent);
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  }

  .funnels-hud__business-card:hover::before {
    opacity: 0.5;
  }

  .funnels-hud__business-card.selected {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 12%, transparent) 0%, color-mix(in srgb, var(--g-primary) 6%, transparent) 100%);
    border-color: color-mix(in srgb, var(--g-primary) 40%, transparent);
    box-shadow: 0 0 30px color-mix(in srgb, var(--g-primary) 15%, transparent), inset 0 1px 0 color-mix(in srgb, var(--g-primary) 10%, transparent);
  }

  .funnels-hud__business-card.selected::before {
    opacity: 1;
  }

  .funnels-hud__business-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    background: color-mix(in srgb, var(--g-primary) 6%, transparent);
    border-radius: 12px;
    font-size: 24px;
    flex-shrink: 0;
    transition: all 0.25s ease;
  }

  .funnels-hud__business-card.selected .funnels-hud__business-card-icon {
    background: color-mix(in srgb, var(--g-primary) 15%, transparent);
    box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 20%, transparent);
  }

  .funnels-hud__business-card-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
    z-index: 1;
  }

  .funnels-hud__business-card-name {
    font-size: 14px;
    font-weight: 700;
    color: color-mix(in srgb, var(--g-fg) 90%, transparent);
    letter-spacing: 0.3px;
  }

  .funnels-hud__business-card.selected .funnels-hud__business-card-name {
    color: var(--g-primary);
    text-shadow: 0 0 20px color-mix(in srgb, var(--g-primary) 30%, transparent);
  }

  .funnels-hud__business-card-industry {
    font-size: 11px;
    color: color-mix(in srgb, var(--g-fg) 40%, transparent);
    text-transform: uppercase;
    letter-spacing: 1px;
    font-weight: 500;
  }

  .funnels-hud__business-card.selected .funnels-hud__business-card-industry {
    color: color-mix(in srgb, var(--g-primary) 60%, transparent);
  }

  .funnels-hud__business-card-check {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 25%, transparent) 0%, color-mix(in srgb, var(--g-primary) 15%, transparent) 100%);
    border-radius: 50%;
    color: var(--g-primary);
    font-size: 14px;
    font-weight: 700;
    position: relative;
    z-index: 1;
    box-shadow: 0 0 15px color-mix(in srgb, var(--g-primary) 30%, transparent);
  }

  .funnels-hud__business-card-checkbox {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: color-mix(in srgb, var(--g-fg) 3%, transparent);
    border: 2px solid color-mix(in srgb, var(--g-fg) 15%, transparent);
    border-radius: 6px;
    color: transparent;
    font-size: 14px;
    font-weight: 700;
    transition: all 0.2s ease;
    flex-shrink: 0;
  }

  .funnels-hud__business-card:hover .funnels-hud__business-card-checkbox {
    border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
  }

  .funnels-hud__business-card-checkbox.checked {
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 30%, transparent) 0%, color-mix(in srgb, var(--g-primary) 20%, transparent) 100%);
    border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
    color: var(--g-primary);
    box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 25%, transparent);
  }

  .funnels-hud__selected-count {
    margin-top: 12px;
    padding: 10px 14px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 8%, transparent) 0%, color-mix(in srgb, var(--g-primary) 4%, transparent) 100%);
    border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    color: color-mix(in srgb, var(--g-primary) 80%, transparent);
    text-align: center;
    letter-spacing: 0.5px;
  }

  /* Divider */
  .funnels-hud__dialog-divider {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 20px 0;
  }

  .funnels-hud__dialog-divider::before,
  .funnels-hud__dialog-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: color-mix(in srgb, var(--g-primary) 8%, transparent);
  }

  .funnels-hud__dialog-divider span {
    font-size: 10px;
    font-weight: 600;
    color: color-mix(in srgb, var(--g-primary) 30%, transparent);
    letter-spacing: 1px;
  }

  /* Spinner */
  .funnels-hud__spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
    border-top-color: var(--g-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;
