/**
 * Grid-panel adapters that mount EXISTING full views inside a masonry tile.
 *
 * Principle: reuse-first / thin. Each adapter imports an already-built view
 * render function (or custom element) and drops it into the panel body. No
 * business logic is duplicated here — data loading and mutations are delegated
 * to the same controllers the standalone pages use.
 *
 * Two families live here:
 *   1. `renderViewAdapterPanel` — a generic embed keyed by `panel.viewKind`
 *      (notes / clients / reports / business / agentActivity / funnels /
 *       research / autonomy).
 *   2. `renderAgencyOpsTabPanel` — the Agency Operations Center scoped to a
 *      single tab (`panel.agencyOpsSection`). Each panel gets its own
 *      independent ops host so tabs never fight over shared state, which lets
 *      an operator compose a custom ops dashboard from tiles. The off-limits
 *      `views/agency-operations.ts` is imported read-only — never edited.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GridPanel } from "../../controllers/masonry-grid";
import type { GatewayBrowserClient } from "../../gateway";
import type { AppViewState } from "../../app-view-state";
import {
  ensurePanelWiring,
  findScrollElInPanel,
  panelScrollContainer,
  panelLoading,
} from "./_shared";

// ── Existing views (render functions) — mounted, not reimplemented ──────────
import { renderNotes } from "../notes";
import { loadNotes } from "../../controllers/notes";
import { renderClients } from "../clients";
import { loadClients } from "../../controllers/clients";
import { renderReportsView } from "../reports/index";
import { renderBusiness } from "../business";
import { loadBusiness } from "../../controllers/business";
import { renderAgentActivity } from "../agent-activity";
import { loadAgentActivity } from "../../controllers/agent-activity";
import "../agency-funnel"; // registers <agency-funnel-view>
import "../research/workspace"; // registers <infinibot-research-workspace>
import {
  renderAutonomyDashboard,
  injectAutonomyStyles,
} from "../autonomy";
import {
  createAutonomyState,
  loadAutonomyStatus,
  pauseAutonomy,
  resumeAutonomy,
  approveTask,
  cancelTask,
} from "../../controllers/autonomy";

// ── Agency Operations (off-limits view — imported read-only) ────────────────
import { renderAgencyOperations } from "../agency-operations";
import {
  createAgencyOperationsState,
  loadAgencyOperations,
  type AgencyOperationsHost,
  type AgencyOperationsSection,
} from "../../controllers/agency-operations";

// ════════════════════════════════════════════════════════════════════════════
// Catalogue metadata (consumed by the panel gallery picker)
// ════════════════════════════════════════════════════════════════════════════

export type PanelCategory =
  | "Ops"
  | "Agents"
  | "Data"
  | "Media"
  | "Voice"
  | "Work";

export interface PanelCatalogEntry {
  /** Discriminator: `view:<kind>`, `agencyOps:<section>`, or a native type. */
  id: string;
  title: string;
  description: string;
  icon: string;
  category: PanelCategory;
  /** How this entry is realized when picked. */
  kind: "view" | "agencyOps" | "native";
  /** For kind "view": the viewKind. For "agencyOps": the section. For native: the native handler key. */
  ref: string;
  w?: number;
  h?: number;
}

/** View-adapter panel definitions. */
export const VIEW_PANEL_DEFS: PanelCatalogEntry[] = [
  { id: "view:notes", title: "Notes", description: "Your notebook — capture and edit notes hands-free.", icon: "📝", category: "Work", kind: "view", ref: "notes", w: 640, h: 560 },
  { id: "view:research", title: "Research Intel", description: "Watchlist topics, saved articles and market signals.", icon: "🔬", category: "Data", kind: "view", ref: "research", w: 760, h: 600 },
  { id: "view:clients", title: "Clients (CRM)", description: "Client roster, statuses and revenue at a glance.", icon: "🤝", category: "Ops", kind: "view", ref: "clients", w: 820, h: 600 },
  { id: "view:funnels", title: "Funnels", description: "Interactive funnel map — stages, deals and flow.", icon: "🌪️", category: "Ops", kind: "view", ref: "funnels", w: 820, h: 600 },
  { id: "view:autonomy", title: "Autonomy", description: "Autonomous run status, approvals and controls.", icon: "🤖", category: "Agents", kind: "view", ref: "autonomy", w: 720, h: 580 },
  { id: "view:agentActivity", title: "Agent Activity", description: "Full agent activity dashboard and session history.", icon: "📡", category: "Agents", kind: "view", ref: "agentActivity", w: 780, h: 600 },
  { id: "view:reports", title: "Reports", description: "Generated reports, schedules and delivery sinks.", icon: "📄", category: "Media", kind: "view", ref: "reports", w: 760, h: 600 },
  { id: "view:business", title: "Business HQ", description: "Business command center — systems and KPIs.", icon: "🏢", category: "Ops", kind: "view", ref: "business", w: 820, h: 600 },
];

/** Agency Operations Center — one tile per tab. */
export const AGENCY_OPS_TAB_DEFS: PanelCatalogEntry[] = [
  { id: "agencyOps:overview", title: "Command Center", description: "Agency command center — revenue, delivery, decisions.", icon: "🎛️", category: "Ops", kind: "agencyOps", ref: "overview", w: 900, h: 640 },
  { id: "agencyOps:allocation", title: "Work Allocation", description: "Live workforce allocation and capacity.", icon: "📊", category: "Ops", kind: "agencyOps", ref: "allocation", w: 820, h: 600 },
  { id: "agencyOps:approvals", title: "Approvals", description: "Approval inbox — decisions awaiting your call.", icon: "✅", category: "Ops", kind: "agencyOps", ref: "approvals", w: 780, h: 580 },
  { id: "agencyOps:activity", title: "Activity & Audit", description: "Agency activity feed and audit trail.", icon: "🧾", category: "Ops", kind: "agencyOps", ref: "activity", w: 780, h: 600 },
  { id: "agencyOps:employees", title: "Employees", description: "Human + AI employees and their profiles.", icon: "👥", category: "Ops", kind: "agencyOps", ref: "employees", w: 860, h: 620 },
];

// ════════════════════════════════════════════════════════════════════════════
// Generic view-adapter renderer
// ════════════════════════════════════════════════════════════════════════════

const _viewInit = new Map<string, boolean>();

/** One-time per-panel data load + refresh wiring for a view kind. */
function ensureViewInit(
  panel: GridPanel,
  state: AppViewState,
  client: GatewayBrowserClient,
  load: (() => void) | null,
): void {
  if (_viewInit.get(panel.id)) {
    if (panel.needsRefresh) {
      load?.();
      panel.needsRefresh = false;
    }
    return;
  }
  _viewInit.set(panel.id, true);
  queueMicrotask(() => {
    load?.();
    ensurePanelWiring(panel.id, {
      onRefresh: () => load?.(),
      scrollEl: () => findScrollElInPanel(panel.id, document),
    });
  });
}

export function renderViewAdapterPanel(
  panel: GridPanel,
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const kind = panel.viewKind ?? "";
  const ru = () => state.requestUpdate?.();

  switch (kind) {
    case "notes": {
      ensureViewInit(panel, state, client, () => void loadNotes(state, client).then(ru));
      return panelScrollContainer(panel.id, renderNotes(state, client));
    }
    case "clients": {
      ensureViewInit(panel, state, client, () => void loadClients(state, client).then(ru));
      return panelScrollContainer(panel.id, renderClients(state, client));
    }
    case "business": {
      ensureViewInit(panel, state, client, () => void loadBusiness(state, client).then(ru));
      return panelScrollContainer(panel.id, renderBusiness(state, client));
    }
    case "agentActivity": {
      ensureViewInit(panel, state, client, () => void loadAgentActivity(state, client, { silent: true }).then(ru));
      return panelScrollContainer(panel.id, renderAgentActivity(state, client));
    }
    case "reports": {
      // reports self-loads inside renderReportsView (module-scoped state).
      ensureViewInit(panel, state, client, null);
      return panelScrollContainer(panel.id, renderReportsView(state, client));
    }
    case "funnels": {
      // Self-initializing custom element — mount like the /funnels page.
      return html`
        <div style="height:100%;min-height:0;display:flex;flex-direction:column;">
          <agency-funnel-view style="flex:1;min-height:0;"></agency-funnel-view>
        </div>
      `;
    }
    case "research": {
      // Same self-contained workspace as the /research page.
      return html`
        <div style="height:100%;min-height:0;display:flex;flex-direction:column;">
          <infinibot-research-workspace
            style="flex:1;min-height:0;"
            .client=${client}
            .app=${state}
            .connected=${Boolean((state as { connected?: boolean }).connected)}
          ></infinibot-research-workspace>
        </div>
      `;
    }
    case "autonomy": {
      if (!state.autonomyState) state.autonomyState = createAutonomyState();
      injectAutonomyStyles();
      const reload = async () => {
        const update = await loadAutonomyStatus(client);
        state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
        ru();
      };
      ensureViewInit(panel, state, client, () => void reload());
      const auto = state.autonomyState ?? createAutonomyState();
      return panelScrollContainer(
        panel.id,
        renderAutonomyDashboard(auto, {
          client,
          onPause: async () => { await pauseAutonomy(client); await reload(); },
          onResume: async () => { await resumeAutonomy(client); await reload(); },
          onApprove: async (taskId: string) => { await approveTask(client, taskId); await reload(); },
          onCancel: async (taskId: string) => { await cancelTask(client, taskId); await reload(); },
        } as any),
      );
    }
    default:
      return panelScrollContainer(
        panel.id,
        html`<div style="padding:16px;color:#a1a1aa;font-size:12px;">
          Unknown view: <code>${kind}</code>
        </div>`,
      );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Agency Operations — tab-scoped panel
// ════════════════════════════════════════════════════════════════════════════

/**
 * Each ops panel owns an independent AgencyOperationsHost. That gives every
 * tile its own `activeSection` + data, so tabs never race over a shared state
 * object and in-tile tab switching keeps working. The host's `requestUpdate`
 * bridges back to the app so the tile re-renders on data/interaction changes.
 */
interface OpsPanelRuntime {
  host: AgencyOperationsHost;
  loaded: boolean;
}
const _opsRuntimes = new Map<string, OpsPanelRuntime>();

function getOpsRuntime(
  panel: GridPanel,
  state: AppViewState,
  client: GatewayBrowserClient,
): OpsPanelRuntime {
  let rt = _opsRuntimes.get(panel.id);
  if (!rt) {
    const opsState = createAgencyOperationsState();
    opsState.activeSection = (panel.agencyOpsSection as AgencyOperationsSection) ?? "overview";
    const host: AgencyOperationsHost = {
      agencyOperationsState: opsState,
      requestUpdate: () => state.requestUpdate?.(),
    };
    rt = { host, loaded: false };
    _opsRuntimes.set(panel.id, rt);
    ensurePanelWiring(panel.id, {
      onRefresh: () => void loadAgencyOperations(host, client, { background: true }),
      scrollEl: () => findScrollElInPanel(panel.id, document),
    });
  }
  return rt;
}

export function renderAgencyOpsTabPanel(
  panel: GridPanel,
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const rt = getOpsRuntime(panel, state, client);
  if (!rt.loaded) {
    rt.loaded = true;
    queueMicrotask(() => void loadAgencyOperations(rt.host, client));
  }
  if (panel.needsRefresh) {
    void loadAgencyOperations(rt.host, client, { background: true });
    panel.needsRefresh = false;
  }

  const opsState = rt.host.agencyOperationsState;
  // Body scrolls; the ops view provides its own header/nav.
  return html`
    <div
      data-grid-scroll=${panel.id}
      style="
        position:relative; height:100%; width:100%;
        overflow:auto; min-height:0;
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--g-primary) 30%, transparent) transparent;
      "
    >
      ${opsState ? renderAgencyOperations(rt.host, client) : panelLoading("Loading agency operations…")}
      ${nothing}
    </div>
  `;
}

/** Tear down cached runtimes when a panel closes (called by the grid view). */
export function disposeAdapterPanel(panelId: string): void {
  _viewInit.delete(panelId);
  _opsRuntimes.delete(panelId);
}
