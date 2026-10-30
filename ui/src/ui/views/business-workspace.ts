/**
 * Business Workspace view — per-business HUD.
 *
 * Shows the system databases scoped to a single business, grouped by purpose
 * (CRM / Sales / Operations / Service / Agency / Core / Custom). Includes a
 * "Library" pane that one-click installs database packs (CRM, eCom, Service,
 * Agency).
 *
 * Aesthetic: depth glassmorphism — frosted-glass cards with multi-layer
 * shadow, ambient gradient sweeps tied to the current theme primary, and
 * subtle hover lift. Everything binds to the existing CSS tokens
 * (`--g-primary`, `--g-bg`) so the theme switcher applies automatically.
 *
 * Data flow:
 *   - loadWorkspace(state, client) fills state.businessState.workspaceState
 *     by issuing 3 RPCs in parallel: db.list, db.list_system_roles, and a
 *     single db.rows.query per role with `businessId` set, plus a
 *     business.packs.list call.
 *   - installPack triggers business.pack.install, then re-runs the loader.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type {
  BusinessProfile,
  BusinessState,
  WorkspaceState,
} from "../controllers/business";
import { loadRecentKanban } from "../controllers/business";
import { openHubSection } from "./ba-glass";

// ───────────────────────────────────────────────────────────────
// Inline SVG icon kit — Lucide-style 24x24 strokes. Replaces the
// emoji icons that used to ride on pack/role tiles + empty states,
// so the Command Center surfaces look high-end and theme via
// `currentColor` instead of relying on the OS emoji font.
// ───────────────────────────────────────────────────────────────
function svg(path: TemplateResult): TemplateResult {
  // Wrap a path/group in a stroke-styled svg for crisp rendering at any size.
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
const I = {
  building: svg(html`<path d="M3 21h18"/><path d="M5 21V7l8-4 8 4v14"/><path d="M9 9h.01"/><path d="M9 12h.01"/><path d="M9 15h.01"/><path d="M9 18h.01"/><path d="M15 9h.01"/><path d="M15 12h.01"/><path d="M15 15h.01"/><path d="M15 18h.01"/>`),
  buildings: svg(html`<rect x="3" y="3" width="8" height="18" rx="1"/><rect x="13" y="8" width="8" height="13" rx="1"/><path d="M6 7h2"/><path d="M6 11h2"/><path d="M6 15h2"/><path d="M16 12h2"/><path d="M16 16h2"/>`),
  users: svg(html`<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`),
  contact: svg(html`<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7 18a5 5 0 0 1 10 0"/><path d="M16 8h2"/>`),
  handshake: svg(html`<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-2"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>`),
  briefcase: svg(html`<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>`),
  shoppingBag: svg(html`<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>`),
  package: svg(html`<path d="M16.5 9.4 7.5 4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.27 6.96 8.73 5.05 8.73-5.05"/><path d="M12 22.08V12"/>`),
  receipt: svg(html`<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M16 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/>`),
  userCircle: svg(html`<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.5a5 5 0 0 1 10 0"/>`),
  refund: svg(html`<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>`),
  bell: svg(html`<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`),
  calendar: svg(html`<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>`),
  invoice: svg(html`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="M9 15h6"/>`),
  landmark: svg(html`<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/>`),
  clock: svg(html`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`),
  folder: svg(html`<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>`),
  checkSquare: svg(html`<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>`),
  fileText: svg(html`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>`),
  zap: svg(html`<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`),
  trendingUp: svg(html`<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>`),
  star: svg(html`<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`),
  layers: svg(html`<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>`),
  plus: svg(html`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`),
  refresh: svg(html`<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`),
};

// SystemRole id → icon. Falls back to `layers` for anything unmapped.
const ROLE_ICON: Record<string, TemplateResult> = {
  // Core
  projects: I.folder,
  tasks: I.checkSquare,
  notes: I.fileText,
  // CRM
  clients: I.handshake,
  leads: I.zap,
  contacts: I.contact,
  companies: I.buildings,
  deals: I.trendingUp,
  // eCom
  products: I.package,
  customers: I.userCircle,
  orders: I.receipt,
  refunds: I.refund,
  // Service
  sessions: I.calendar,
  invoices: I.invoice,
  // Agency
  time_entries: I.clock,
};

// PackId → header icon for the Library tile.
const PACK_ICON: Record<string, TemplateResult> = {
  crm: I.users,
  ecom: I.shoppingBag,
  service: I.bell,
  agency: I.landmark,
};

function roleIconFor(role: string): TemplateResult {
  return ROLE_ICON[role] ?? I.layers;
}
function packIconFor(packId: string): TemplateResult {
  return PACK_ICON[packId] ?? I.layers;
}

// ───────────────────────────────────────────────────────────────
// Role grouping — purely for visual layout. Roles not listed here
// fall into the "other" bucket; the workspace surfaces them as a
// generic panel under "More".
// ───────────────────────────────────────────────────────────────
const ROLE_GROUP: Record<string, WorkspaceState["panels"][number]["group"]> = {
  // CRM
  clients: "crm",
  contacts: "crm",
  companies: "crm",
  deals: "crm",
  leads: "crm",
  // Sales / eCom
  products: "sales",
  orders: "sales",
  customers: "sales",
  refunds: "sales",
  // Operations / core
  projects: "operations",
  tasks: "operations",
  notes: "core",
  // Service
  sessions: "service",
  invoices: "service",
  // Agency
  time_entries: "agency",
};

const GROUP_META: Record<
  WorkspaceState["panels"][number]["group"],
  { label: string; subtitle: string; accent: string; gradient: string }
> = {
  crm: {
    label: "CRM",
    subtitle: "People + companies",
    accent: "var(--g-primary)",
    gradient:
      "linear-gradient(135deg, color-mix(in srgb, var(--g-primary) 14%, transparent), color-mix(in srgb, #6366f1 8%, transparent) 60%, transparent)",
  },
  sales: {
    label: "Sales",
    subtitle: "Catalogue + orders",
    accent: "#22c55e",
    gradient:
      "linear-gradient(135deg, color-mix(in srgb, #22c55e 14%, transparent), color-mix(in srgb, var(--g-primary) 8%, transparent) 60%, transparent)",
  },
  operations: {
    label: "Operations",
    subtitle: "Projects + delivery",
    accent: "#a855f7",
    gradient:
      "linear-gradient(135deg, color-mix(in srgb, #a855f7 14%, transparent), color-mix(in srgb, #ec4899 8%, transparent) 60%, transparent)",
  },
  service: {
    label: "Service",
    subtitle: "Sessions + invoices",
    accent: "#f59e0b",
    gradient:
      "linear-gradient(135deg, color-mix(in srgb, #f59e0b 14%, transparent), color-mix(in srgb, #ef4444 8%, transparent) 60%, transparent)",
  },
  agency: {
    label: "Agency",
    subtitle: "Time + billing",
    accent: "#06b6d4",
    gradient:
      "linear-gradient(135deg, color-mix(in srgb, #06b6d4 14%, transparent), color-mix(in srgb, #3b82f6 8%, transparent) 60%, transparent)",
  },
  core: {
    label: "Core",
    subtitle: "Notes + workspace",
    accent: "#94a3b8",
    gradient:
      "linear-gradient(135deg, color-mix(in srgb, #94a3b8 12%, transparent), transparent 70%)",
  },
  other: {
    label: "Other",
    subtitle: "More system panels",
    accent: "#94a3b8",
    gradient: "linear-gradient(135deg, color-mix(in srgb, #94a3b8 10%, transparent), transparent 70%)",
  },
};

// ───────────────────────────────────────────────────────────────
// State helpers
// ───────────────────────────────────────────────────────────────
function ensureWorkspaceState(bs: BusinessState): WorkspaceState {
  if (!bs.workspaceState) {
    bs.workspaceState = {
      loading: false,
      error: null,
      loadedFor: null,
      panels: [],
      customDatabases: [],
      packs: [],
      installingPackId: null,
      lastLoadedAt: null,
    };
  }
  return bs.workspaceState;
}

/**
 * Load row counts for every system role + custom databases under the active
 * business. Issues parallel RPCs and merges into workspaceState.
 *
 * Re-runs whenever activeBusinessId changes. Safe to call repeatedly; we
 * short-circuit when loadedFor matches.
 */
export async function loadWorkspace(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts: { force?: boolean } = {},
): Promise<void> {
  const bs = state.businessState;
  if (!bs?.activeBusinessId || !client) return;
  const ws = ensureWorkspaceState(bs);
  if (!opts.force && ws.loadedFor === bs.activeBusinessId && !ws.error) return;

  ws.loading = true;
  ws.error = null;
  ws.loadedFor = bs.activeBusinessId;
  state.requestUpdate?.();

  try {
    const [databasesResp, rolesResp, packsResp] = (await Promise.all([
      client.request("db.list", {}),
      client.request("db.system.list", {}),
      client.request("business.packs.list", {}),
    ])) as [
      { databases?: Array<{ id: string; name: string; slug: string; icon: string | null; source: string }> },
      { assignments?: Array<{ role: string; databaseId: string }> },
      { packs?: Array<{ id: string; name: string; description: string; icon: string; databases?: Array<{ role: string }> }> },
    ];

    const databases = databasesResp?.databases ?? [];
    const dbById = new Map(databases.map((d) => [d.id, d]));
    const assignments = rolesResp?.assignments ?? [];

    // Row counts per system-role db, scoped to this business.
    const counts: Record<string, number> = {};
    await Promise.all(
      assignments.map(async (a) => {
        try {
          const r = (await client.request("db.rows.query", {
            databaseId: a.databaseId,
            businessId: bs.activeBusinessId,
            limit: 0,
          })) as { total?: number };
          counts[a.databaseId] = r?.total ?? 0;
        } catch {
          counts[a.databaseId] = 0;
        }
      }),
    );

    // Build role panels (skipping any whose database has been deleted).
    ws.panels = assignments
      .map((a) => {
        const db = dbById.get(a.databaseId);
        if (!db) return null;
        const group = ROLE_GROUP[a.role] ?? "other";
        return {
          role: a.role,
          databaseId: db.id,
          databaseSlug: db.slug,
          name: db.name,
          icon: db.icon,
          rowCount: counts[db.id] ?? 0,
          group,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    // Custom = native databases NOT mapped to any system role.
    const mappedDbIds = new Set(assignments.map((a) => a.databaseId));
    const customDbs = databases.filter(
      (d) => d.source === "native" && !mappedDbIds.has(d.id),
    );
    const customCounts: Record<string, number> = {};
    await Promise.all(
      customDbs.map(async (d) => {
        try {
          const r = (await client.request("db.rows.query", {
            databaseId: d.id,
            businessId: bs.activeBusinessId,
            limit: 0,
          })) as { total?: number };
          customCounts[d.id] = r?.total ?? 0;
        } catch {
          customCounts[d.id] = 0;
        }
      }),
    );
    ws.customDatabases = customDbs.map((d) => ({
      databaseId: d.id,
      databaseSlug: d.slug,
      name: d.name,
      icon: d.icon,
      rowCount: customCounts[d.id] ?? 0,
    }));

    ws.packs = (packsResp?.packs ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      icon: p.icon,
      databaseRoles: (p.databases ?? []).map((d) => d.role),
    }));
    ws.lastLoadedAt = Date.now();
  } catch (e) {
    ws.error = e instanceof Error ? e.message : String(e);
  } finally {
    ws.loading = false;
    state.requestUpdate?.();
  }
}

async function installPack(
  state: AppViewState,
  client: GatewayBrowserClient,
  packId: string,
): Promise<void> {
  const bs = state.businessState;
  if (!bs?.activeBusinessId) return;
  const ws = ensureWorkspaceState(bs);
  ws.installingPackId = packId;
  state.requestUpdate?.();
  try {
    await client.request("business.pack.install", {
      businessId: bs.activeBusinessId,
      packId,
    });
    await loadWorkspace(state, client, { force: true });
  } catch (e) {
    ws.error = e instanceof Error ? e.message : String(e);
  } finally {
    ws.installingPackId = null;
    state.requestUpdate?.();
  }
}

// ───────────────────────────────────────────────────────────────
// Workspace summary helpers — feed the stats strip + linked projects panel.
// All numbers come from data already in BusinessState; no new gateway calls.
// ───────────────────────────────────────────────────────────────

function formatRelativeAge(then: number | null, now: number = Date.now()): string {
  if (!then) return "never";
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

interface WorkspaceStats {
  totalRows: number;
  databaseCount: number;
  linkedProjects: number;
  totalLeads: number;
}

function computeWorkspaceStats(bs: BusinessState, ws: WorkspaceState): WorkspaceStats {
  const totalRows =
    ws.panels.reduce((acc, p) => acc + (p.rowCount ?? 0), 0) +
    ws.customDatabases.reduce((acc, d) => acc + (d.rowCount ?? 0), 0);
  const databaseCount = ws.panels.length + ws.customDatabases.length;
  const activeBiz = bs.activeBusinessId;
  const linkedProjects = (bs.recentKanban?.projects ?? []).filter(
    (p) => activeBiz && p.businessId === activeBiz,
  ).length;
  const totalLeads = bs.summary?.leads.total ?? 0;
  return { totalRows, databaseCount, linkedProjects, totalLeads };
}

function renderStatsStrip(
  state: AppViewState,
  stats: WorkspaceStats,
  lastLoadedAt: number | null,
): TemplateResult {
  const tiles: Array<{ label: string; value: string; hint: string; go?: () => void }> = [
    {
      label: "Rows",
      value: stats.totalRows.toLocaleString(),
      hint: `Across ${stats.databaseCount} database${stats.databaseCount === 1 ? "" : "s"}`,
    },
    {
      label: "Linked projects",
      value: stats.linkedProjects.toLocaleString(),
      hint: stats.linkedProjects === 0 ? "Assign from /projects" : "Active in this business",
    },
    {
      label: "Leads",
      value: stats.totalLeads.toLocaleString(),
      hint: stats.totalLeads === 0 ? "No submissions yet" : "Captured all-time · open in hub",
      // Form leads are worked in the Business hub (contacts + open deals).
      go: () => openHubSection(state, "pipeline"),
    },
    {
      label: "Refreshed",
      value: formatRelativeAge(lastLoadedAt),
      hint: lastLoadedAt ? new Date(lastLoadedAt).toLocaleTimeString() : "Tap refresh to load",
    },
  ];
  return html`
    <div class="bw-stats">
      ${tiles.map((t) =>
        t.go
          ? html`
          <button type="button" class="bw-stat bw-stat--link" title="Open Business hub › Pipeline" @click=${t.go}>
            <div class="bw-stat-label">${t.label} <span class="bw-stat-go" aria-hidden="true">›</span></div>
            <div class="bw-stat-value">${t.value}</div>
            <div class="bw-stat-hint">${t.hint}</div>
          </button>
        `
          : html`
          <div class="bw-stat" title="${t.hint}">
            <div class="bw-stat-label">${t.label}</div>
            <div class="bw-stat-value">${t.value}</div>
            <div class="bw-stat-hint">${t.hint}</div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderLinkedProjects(
  state: AppViewState,
  bs: BusinessState,
): TemplateResult {
  const activeBiz = bs.activeBusinessId;
  if (!activeBiz) return html``;
  const linked = (bs.recentKanban?.projects ?? [])
    .filter((p) => p.businessId === activeBiz)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 6);
  return html`
    <section class="bw-linked">
      <header class="bw-linked-head">
        <div>
          <div class="bw-group-title">Linked projects</div>
          <div class="bw-group-sub">From kanban — scoped to this business</div>
        </div>
        <button
          class="bw-btn bw-btn-ghost"
          @click=${() => navigateToTab(state, "projects")}
          title="Open the projects board (filter follows this business)"
        >Open board →</button>
      </header>
      ${linked.length === 0
        ? html`
            <div class="bw-linked-empty">
              No projects assigned yet. Open
              <button class="bw-link" @click=${() => navigateToTab(state, "projects")}>Projects</button>
              and pick a business on a card to link it here.
            </div>
          `
        : html`
            <div class="bw-linked-row">
              ${linked.map(
                (p) => html`
                  <button
                    class="bw-linked-tile"
                    @click=${() => openProject(state, p.id)}
                    title="Open '${p.name}' in the projects board"
                  >
                    <span class="bw-linked-name">${p.name}</span>
                    <span class="bw-linked-meta">
                      ${p.status ? html`<span class="bw-linked-status">${p.status}</span>` : nothing}
                      ${p.updatedAt
                        ? html`<span class="bw-linked-age">${formatRelativeAge(p.updatedAt)}</span>`
                        : nothing}
                    </span>
                  </button>
                `,
              )}
            </div>
          `}
    </section>
  `;
}

function renderQuickActions(
  state: AppViewState,
  ws: WorkspaceState,
): TemplateResult {
  const findRoleDb = (role: string): string | null =>
    ws.panels.find((p) => p.role === role)?.databaseId ?? null;
  const clientsDb = findRoleDb("clients");
  const leadsDb = findRoleDb("leads");
  // Sits inside the header bar's right cluster — see renderWorkspace. Each
  // button is icon-led + label so the row reads as a single command palette
  // rather than a second toolbar.
  return html`
    <button
      class="bw-quick-btn"
      ?disabled=${!clientsDb}
      @click=${() => clientsDb && openDatabase(state, clientsDb)}
      title=${clientsDb ? "Open Clients database" : "Install the CRM pack first"}
    >
      <span class="bw-quick-icon">${I.handshake}</span>
      <span>Client</span>
    </button>
    <button
      class="bw-quick-btn"
      ?disabled=${!leadsDb}
      @click=${() => leadsDb && openDatabase(state, leadsDb)}
      title=${leadsDb ? "Open Leads database" : "Install the CRM pack first"}
    >
      <span class="bw-quick-icon">${I.zap}</span>
      <span>Lead</span>
    </button>
    <button
      class="bw-quick-btn"
      @click=${() => navigateToTab(state, "projects")}
      title="Jump to the projects board"
    >
      <span class="bw-quick-icon">${I.folder}</span>
      <span>Project</span>
    </button>
  `;
}

// ───────────────────────────────────────────────────────────────
// View
// ───────────────────────────────────────────────────────────────

export function renderWorkspace(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const bs = state.businessState;
  if (!bs) return html``;
  const activeBiz: BusinessProfile | undefined = bs.businesses.find(
    (b: BusinessProfile) => b.id === bs.activeBusinessId,
  );
  if (!bs.activeBusinessId || !activeBiz) {
    return html`
      ${workspaceStyles}
      <div class="bw-empty">
        <div class="bw-empty-card">
          <div class="bw-empty-icon bw-empty-icon-svg">${I.landmark}</div>
          <h3>Pick a business to enter the workspace</h3>
          <p>Each business has its own scoped CRM, sales, operations, and custom databases. Pick one from the business switcher above.</p>
        </div>
      </div>
    `;
  }

  // Lazy-load on first render for this business.
  const ws = ensureWorkspaceState(bs);
  if (ws.loadedFor !== bs.activeBusinessId && !ws.loading) {
    void loadWorkspace(state, client);
  }
  // Linked-projects panel + stats strip both pull from recentKanban; the
  // controller's TTL (30s) guards against re-fetching every render. Without
  // this the workspace would have to wait for the user to visit the home
  // tab once to populate the cache.
  void loadRecentKanban(state, client);

  // Group panels for layout.
  const groups: Array<WorkspaceState["panels"][number]["group"]> = [
    "crm",
    "sales",
    "operations",
    "service",
    "agency",
    "core",
    "other",
  ];
  const byGroup = new Map<string, typeof ws.panels>();
  for (const p of ws.panels) {
    if (!byGroup.has(p.group)) byGroup.set(p.group, []);
    byGroup.get(p.group)!.push(p);
  }

  const stats = computeWorkspaceStats(bs, ws);
  // Stale = data older than 90s. Used to dim the "refreshed Xm ago" chip
  // and surface a one-click force-refresh hint to the user.
  const stale = ws.lastLoadedAt != null && Date.now() - ws.lastLoadedAt > 90_000;

  return html`
    ${workspaceStyles}
    <div class="bw-shell">
      <header class="bw-bar">
        <div class="bw-bar-left">
          <div class="bw-bar-mark">
            <span class="bw-bar-dot"></span>
            <span class="bw-bar-label">Workspace</span>
          </div>
          <div class="bw-bar-biz">
            <span class="bw-bar-biz-name">${activeBiz.name}</span>
            ${activeBiz.industry
              ? html`<span class="bw-bar-biz-tag">${activeBiz.industry}</span>`
              : nothing}
          </div>
          ${ws.lastLoadedAt
            ? html`
                <span
                  class="bw-bar-stale ${stale ? "is-stale" : ""}"
                  title=${stale
                    ? "Data may be lagging — click ↻ Refresh to reload"
                    : "Last refreshed " + new Date(ws.lastLoadedAt).toLocaleTimeString()}
                >
                  <span class="bw-bar-stale-dot"></span>
                  ${formatRelativeAge(ws.lastLoadedAt)}
                </span>
              `
            : nothing}
        </div>
        <div class="bw-bar-right">
          ${renderQuickActions(state, ws)}
          <span class="bw-bar-sep" aria-hidden="true"></span>
          <button
            class="bw-btn bw-btn-ghost"
            @click=${() => void loadWorkspace(state, client, { force: true })}
            ?disabled=${ws.loading}
            title="Refresh row counts"
          >
            <span class="bw-btn-icon ${ws.loading ? "is-spinning" : ""}" aria-hidden="true">${I.refresh}</span> Refresh
          </button>
          <button
            class="bw-btn bw-btn-primary"
            @click=${() => createCustomDatabase(state, client)}
            title="Create a custom database scoped to this business"
          >
            <span class="bw-btn-icon" aria-hidden="true">${I.plus}</span> Database
          </button>
        </div>
      </header>

      ${renderStatsStrip(state, stats, ws.lastLoadedAt)}

      ${ws.error
        ? html`<div class="bw-error">${ws.error}</div>`
        : nothing}

      ${renderLinkedProjects(state, bs)}

      <div class="bw-grid">
        ${groups
          .filter((g) => byGroup.has(g))
          .map((g) => renderGroup(state, g, byGroup.get(g)!))}
        ${ws.customDatabases.length > 0
          ? renderCustomGroup(state, ws.customDatabases)
          : nothing}
        ${renderLibrary(state, client, ws)}
      </div>
    </div>
  `;
}

function renderGroup(
  state: AppViewState,
  group: WorkspaceState["panels"][number]["group"],
  panels: WorkspaceState["panels"],
): TemplateResult {
  const meta = GROUP_META[group];
  return html`
    <section class="bw-group">
      <header class="bw-group-head">
        <div>
          <div class="bw-group-title">${meta.label}</div>
          <div class="bw-group-sub">${meta.subtitle}</div>
        </div>
        <div class="bw-group-count">${panels.length}</div>
      </header>
      <div class="bw-tiles">
        ${panels.map(
          (p) => html`
            <button
              class="bw-tile"
              @click=${() => openDatabase(state, p.databaseId)}
              title="Open ${p.name} (scoped to this business)"
            >
              <span class="bw-tile-icon bw-tile-icon-svg">${roleIconFor(p.role)}</span>
              <span class="bw-tile-name">${p.name}</span>
              <span class="bw-tile-count">${p.rowCount}</span>
            </button>
          `,
        )}
      </div>
    </section>
  `;
}

function renderCustomGroup(
  state: AppViewState,
  custom: WorkspaceState["customDatabases"],
): TemplateResult {
  return html`
    <section class="bw-group bw-group--custom">
      <header class="bw-group-head">
        <div>
          <div class="bw-group-title">Custom</div>
          <div class="bw-group-sub">Your own databases</div>
        </div>
        <div class="bw-group-count">${custom.length}</div>
      </header>
      <div class="bw-tiles">
        ${custom.map(
          (d) => html`
            <button
              class="bw-tile"
              @click=${() => openDatabase(state, d.databaseId)}
              title="Open ${d.name}"
            >
              <span class="bw-tile-icon bw-tile-icon-svg">${I.layers}</span>
              <span class="bw-tile-name">${d.name}</span>
              <span class="bw-tile-count">${d.rowCount}</span>
            </button>
          `,
        )}
      </div>
    </section>
  `;
}

function renderLibrary(
  state: AppViewState,
  client: GatewayBrowserClient,
  ws: WorkspaceState,
): TemplateResult {
  return html`
    <section class="bw-group bw-group--library">
      <header class="bw-group-head">
        <div>
          <div class="bw-group-title">Library</div>
          <div class="bw-group-sub">One-click database packs</div>
        </div>
        <div class="bw-group-count">${ws.packs.length}</div>
      </header>
      <div class="bw-packs">
        ${ws.packs.map(
          (p) => html`
            <article class="bw-pack">
              <div class="bw-pack-icon bw-pack-icon-svg">${packIconFor(p.id)}</div>
              <div class="bw-pack-name">${p.name}</div>
              <div class="bw-pack-desc">${p.description}</div>
              <div class="bw-pack-roles">
                ${p.databaseRoles.map(
                  (r) => html`<span class="bw-pack-role">${r}</span>`,
                )}
              </div>
              <button
                class="bw-btn bw-btn-primary"
                @click=${() => void installPack(state, client, p.id)}
                ?disabled=${ws.installingPackId !== null}
              >
                ${ws.installingPackId === p.id ? "Installing…" : "Install"}
              </button>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

// ───────────────────────────────────────────────────────────────
// Navigation helpers
// ───────────────────────────────────────────────────────────────
function openDatabase(state: AppViewState, databaseId: string): void {
  // Hand off to the /databases tab. The DBView's own controller picks up the
  // selection from URL hash; we set both so reload preserves it.
  const tab = (state as unknown as { tab?: string }).tab;
  (state as unknown as { tab: string }).tab = "databases";
  (state as unknown as { databasesOpenDbId?: string }).databasesOpenDbId = databaseId;
  // Old hash may carry the previous database — clear it.
  if (typeof window !== "undefined") {
    window.location.hash = `#/databases/${databaseId}`;
  }
  if (tab !== "databases") state.requestUpdate?.();
  state.requestUpdate?.();
}

function navigateToTab(state: AppViewState, tabId: string): void {
  (state as unknown as { tab: string }).tab = tabId;
  if (typeof window !== "undefined") {
    window.location.hash = `#/${tabId}`;
  }
  state.requestUpdate?.();
}

function openProject(state: AppViewState, projectId: string): void {
  // Same handoff pattern as openDatabase: set tab + hash so the projects
  // view can pick up the selection on its next render.
  navigateToTab(state, "projects");
  (state as unknown as { kanbanSelectedProjectId?: string }).kanbanSelectedProjectId = projectId;
}

async function createCustomDatabase(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const bs = state.businessState;
  if (!bs?.activeBusinessId) return;
  const name = typeof window !== "undefined" ? window.prompt("Name your custom database:", "Untitled") : null;
  if (!name) return;
  try {
    const resp = (await client.request("db.create", { name })) as
      | { database?: { id?: string } }
      | undefined;
    const dbId = resp?.database?.id;
    if (!dbId) throw new Error("Server didn't return a database id");
    await loadWorkspace(state, client, { force: true });
    openDatabase(state, dbId);
  } catch (e) {
    const ws = ensureWorkspaceState(bs);
    ws.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ───────────────────────────────────────────────────────────────
// Styles — black-gold glass (matches the Business hub). Rendered inside
// the Business page's `.ba-glass` root, so the --bag-* tokens apply and
// light theme / reduced transparency / reduced motion follow automatically.
// One backdrop blur per stacked surface: group panels blur, tiles inside
// them do not.
// ───────────────────────────────────────────────────────────────
const workspaceStyles = html`
  <style>
    .ba-glass .bw-shell {
      position: relative;
      padding: 0 clamp(14px, 2.6vw, 34px) 60px;
      max-width: 1480px;
      margin: 0 auto;
      color: var(--bag-text);
      font-size: 14px;
      line-height: 1.45;
    }

    /* ── Section bar ───────────────────────────────────────── */
    .ba-glass .bw-bar {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px 14px;
      padding: 12px 14px 12px 18px;
      margin-bottom: 16px;
      border-radius: var(--bag-radius);
      background: var(--glass-sheen, none), var(--bag-panel);
      backdrop-filter: var(--bag-blur);
      -webkit-backdrop-filter: var(--bag-blur);
      box-shadow: var(--bag-shadow);
    }
    .ba-glass .bw-bar::before,
    .ba-glass .bw-group::before,
    .ba-glass .bw-linked::before,
    .ba-glass .bw-empty-card::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      pointer-events: none;
      background: var(--bag-hairline);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
    }
    .ba-glass .bw-bar-left { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-width: 0; }
    .ba-glass .bw-bar-right { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .ba-glass .bw-bar-mark { display: inline-flex; align-items: center; gap: 8px; }
    .ba-glass .bw-bar-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--bag-gold);
      box-shadow: 0 0 10px color-mix(in srgb, var(--bag-gold) 60%, transparent);
    }
    .ba-glass .bw-bar-label {
      font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--bag-gold); font-weight: 600;
    }
    .ba-glass .bw-bar-biz { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .ba-glass .bw-bar-biz-name {
      font-size: 16px; font-weight: 640; letter-spacing: -0.015em; color: var(--bag-text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ba-glass .bw-bar-biz-tag,
    .ba-glass .bw-bar-stale {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 9px; border-radius: 999px;
      font-size: 11.5px; font-weight: 560;
      color: var(--bag-text-2);
      border: 1px solid var(--bag-line);
      background: color-mix(in srgb, var(--bag-gold) 5%, transparent);
      white-space: nowrap;
    }
    .ba-glass .bw-bar-stale { color: var(--bag-ok); border-color: color-mix(in srgb, var(--bag-ok) 35%, transparent); background: color-mix(in srgb, var(--bag-ok) 8%, transparent); }
    .ba-glass .bw-bar-stale.is-stale { color: var(--bag-warn); border-color: color-mix(in srgb, var(--bag-warn) 35%, transparent); background: color-mix(in srgb, var(--bag-warn) 8%, transparent); }
    .ba-glass .bw-bar-stale-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .ba-glass .bw-bar-sep { width: 1px; align-self: stretch; margin: 4px 2px; background: var(--bag-line); }

    /* ── Buttons ───────────────────────────────────────────── */
    .ba-glass .bw-btn,
    .ba-glass .bw-quick-btn {
      appearance: none;
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      min-height: 36px; padding: 0 14px; border-radius: 11px;
      border: 1px solid var(--bag-line-strong);
      background: color-mix(in srgb, var(--bag-card) 80%, transparent);
      color: var(--bag-text);
      font-size: 13px; font-weight: 560; letter-spacing: 0; text-transform: none;
      cursor: pointer; white-space: nowrap;
      transition: transform 0.15s var(--bag-ease), background 0.2s, border-color 0.2s, box-shadow 0.2s;
    }
    .ba-glass .bw-btn:hover:not(:disabled),
    .ba-glass .bw-quick-btn:hover:not(:disabled) { border-color: var(--bag-gold); background: var(--bag-hover); }
    .ba-glass .bw-btn:active:not(:disabled),
    .ba-glass .bw-quick-btn:active:not(:disabled) { transform: translateY(1px) scale(0.99); }
    .ba-glass .bw-btn-ghost { background: transparent; }
    .ba-glass .bw-btn-primary {
      border-color: transparent; color: var(--bag-ink); background: var(--bag-gold-fill);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.45) inset, 0 10px 24px -10px color-mix(in srgb, var(--bag-gold) 80%, transparent);
    }
    .ba-glass .bw-btn-primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--bag-gold-fill); }
    .ba-glass .bw-btn:disabled,
    .ba-glass .bw-quick-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .ba-glass .bw-btn-icon,
    .ba-glass .bw-quick-icon { display: inline-flex; width: 15px; height: 15px; }
    .ba-glass .bw-btn-icon svg,
    .ba-glass .bw-quick-icon svg { width: 15px; height: 15px; }
    .ba-glass .bw-quick-icon { color: var(--bag-gold); }
    .ba-glass .bw-btn-icon.is-spinning svg { animation: bw-spin 0.9s linear infinite; }
    @keyframes bw-spin { to { transform: rotate(360deg); } }

    /* ── Error ─────────────────────────────────────────────── */
    .ba-glass .bw-error {
      margin-bottom: 14px; padding: 10px 14px; border-radius: 12px; font-size: 13px;
      color: var(--bag-bad);
      background: color-mix(in srgb, var(--bag-bad) 9%, transparent);
      border: 1px solid color-mix(in srgb, var(--bag-bad) 32%, transparent);
    }

    /* ── Stats strip (hub KPI tiles) ───────────────────────── */
    .ba-glass .bw-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 16px;
    }
    .ba-glass .bw-stat {
      position: relative;
      display: flex; flex-direction: column; gap: 6px;
      min-height: 112px;
      padding: 16px 18px 14px;
      border-radius: var(--bag-radius);
      background: var(--glass-tint, none), var(--bag-card);
      box-shadow: var(--glass-elev-1, var(--bag-shadow));
      border: 1px solid var(--bag-line);
      text-align: left;
      color: var(--bag-text);
      font: inherit;
      transition: transform 0.35s var(--bag-ease), box-shadow 0.35s var(--bag-ease), border-color 0.2s;
    }
    .ba-glass .bw-stat:hover { transform: translateY(-2px); box-shadow: var(--bag-shadow-lift); }
    .ba-glass .bw-stat--link { cursor: pointer; }
    .ba-glass .bw-stat--link:hover { border-color: var(--bag-line-strong); }
    .ba-glass .bw-stat-label { font-size: 12px; font-weight: 560; color: var(--bag-text-2); display: flex; align-items: center; gap: 6px; }
    .ba-glass .bw-stat-go { color: var(--bag-gold); margin-left: auto; font-size: 14px; }
    .ba-glass .bw-stat-value {
      font-size: clamp(22px, 2.1vw, 30px); font-weight: 660; letter-spacing: -0.03em;
      font-variant-numeric: tabular-nums; line-height: 1.1; color: var(--bag-text);
    }
    .ba-glass .bw-stat-hint { margin-top: auto; font-size: 12px; color: var(--bag-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Linked projects ───────────────────────────────────── */
    .ba-glass .bw-linked {
      position: relative;
      margin-bottom: 16px;
      padding: 16px 18px 18px;
      border-radius: var(--bag-radius);
      background: var(--glass-sheen, none), var(--bag-panel);
      backdrop-filter: var(--bag-blur);
      -webkit-backdrop-filter: var(--bag-blur);
      box-shadow: var(--bag-shadow);
    }
    .ba-glass .bw-linked-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .ba-glass .bw-linked-empty { font-size: 13px; color: var(--bag-text-2); padding: 4px 0; }
    .ba-glass .bw-link { appearance: none; background: none; border: 0; padding: 0 2px; color: var(--bag-gold); font: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
    .ba-glass .bw-linked-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .ba-glass .bw-linked-tile {
      appearance: none;
      display: inline-flex; align-items: center; gap: 8px;
      min-height: 36px; padding: 6px 12px; border-radius: 12px;
      text-align: left; max-width: 340px;
      color: var(--bag-text);
      background: var(--bag-card);
      border: 1px solid var(--bag-line);
      cursor: pointer; font: inherit;
      transition: transform 0.18s var(--bag-ease), border-color 0.2s, background 0.2s;
    }
    .ba-glass .bw-linked-tile:hover { transform: translateY(-1px); border-color: var(--bag-line-strong); background: var(--bag-hover); }
    .ba-glass .bw-linked-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
    .ba-glass .bw-linked-meta { display: inline-flex; gap: 6px; align-items: center; font-size: 11.5px; color: var(--bag-text-3); }
    .ba-glass .bw-linked-status {
      padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 560;
      color: var(--bag-gold); border: 1px solid var(--bag-line-strong);
      background: color-mix(in srgb, var(--bag-gold) 6%, transparent);
    }

    /* ── Groups ────────────────────────────────────────────── */
    .ba-glass .bw-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr));
      gap: 16px;
    }
    .ba-glass .bw-group {
      position: relative;
      border-radius: var(--bag-radius);
      padding: 18px;
      background: var(--glass-sheen, none), var(--bag-panel);
      backdrop-filter: var(--bag-blur);
      -webkit-backdrop-filter: var(--bag-blur);
      box-shadow: var(--bag-shadow);
      transition: box-shadow 0.35s var(--bag-ease);
    }
    .ba-glass .bw-group:hover { box-shadow: var(--bag-shadow-lift); }
    .ba-glass .bw-group-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
    .ba-glass .bw-group-title { font-size: 15px; font-weight: 620; letter-spacing: -0.01em; color: var(--bag-text); }
    .ba-glass .bw-group-sub { font-size: 12px; color: var(--bag-text-3); margin-top: 2px; }
    .ba-glass .bw-group-count {
      font-size: 11.5px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
      color: var(--bag-gold); border: 1px solid var(--bag-line-strong);
      background: color-mix(in srgb, var(--bag-gold) 6%, transparent);
      font-variant-numeric: tabular-nums;
    }

    .ba-glass .bw-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(160px, 100%), 1fr)); gap: 10px; }
    .ba-glass .bw-tile {
      appearance: none;
      display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 10px;
      min-height: 48px; padding: 9px 12px;
      text-align: left; font: inherit; color: var(--bag-text);
      background: var(--bag-card);
      border: 1px solid var(--bag-line);
      border-radius: 13px;
      cursor: pointer;
      transition: transform 0.18s var(--bag-ease), background 0.2s, border-color 0.2s, box-shadow 0.2s;
    }
    .ba-glass .bw-tile:hover { transform: translateY(-1px); background: var(--bag-hover); border-color: var(--bag-line-strong); box-shadow: 0 14px 30px -18px rgba(0, 0, 0, 0.6); }
    .ba-glass .bw-tile:active { transform: translateY(0) scale(0.99); }
    .ba-glass .bw-tile-icon {
      width: 30px; height: 30px; border-radius: 10px;
      display: grid; place-items: center;
      color: var(--bag-gold);
      background: color-mix(in srgb, var(--bag-gold) 12%, transparent);
      box-shadow: inset 0 0 0 1px var(--bag-line-strong);
    }
    .ba-glass .bw-tile-icon-svg svg { width: 16px; height: 16px; }
    .ba-glass .bw-tile-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ba-glass .bw-tile-count { font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 600; color: var(--bag-text-2); }

    /* ── Library ───────────────────────────────────────────── */
    .ba-glass .bw-group--library { grid-column: 1 / -1; }
    .ba-glass .bw-packs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; }
    .ba-glass .bw-pack {
      display: flex; flex-direction: column; gap: 8px;
      padding: 16px; border-radius: 14px;
      background: var(--bag-card);
      border: 1px solid var(--bag-line);
      transition: transform 0.2s var(--bag-ease), border-color 0.2s;
    }
    .ba-glass .bw-pack:hover { transform: translateY(-2px); border-color: var(--bag-line-strong); }
    .ba-glass .bw-pack-icon {
      width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
      color: var(--bag-gold);
      background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--bag-gold) 26%, transparent), transparent 70%), color-mix(in srgb, var(--bag-gold) 8%, transparent);
      box-shadow: inset 0 0 0 1px var(--bag-line-strong);
    }
    .ba-glass .bw-pack-icon-svg svg { width: 20px; height: 20px; }
    .ba-glass .bw-pack-name { font-size: 14px; font-weight: 620; letter-spacing: -0.01em; color: var(--bag-text); }
    .ba-glass .bw-pack-desc { font-size: 12.5px; line-height: 1.5; color: var(--bag-text-2); flex: 1; }
    .ba-glass .bw-pack-roles { display: flex; flex-wrap: wrap; gap: 5px; }
    .ba-glass .bw-pack-role {
      font-size: 11px; font-weight: 560; padding: 2px 8px; border-radius: 999px;
      color: var(--bag-text-2); border: 1px solid var(--bag-line);
      background: color-mix(in srgb, var(--bag-gold) 5%, transparent);
    }
    .ba-glass .bw-pack .bw-btn { align-self: flex-start; margin-top: 4px; }

    /* ── Empty state ───────────────────────────────────────── */
    .ba-glass .bw-empty { display: flex; align-items: center; justify-content: center; min-height: 50vh; padding: 24px; }
    .ba-glass .bw-empty-card {
      position: relative; max-width: 440px; text-align: center; padding: 34px 28px;
      border-radius: var(--bag-radius);
      background: var(--glass-sheen, none), var(--bag-panel);
      backdrop-filter: var(--bag-blur);
      -webkit-backdrop-filter: var(--bag-blur);
      box-shadow: var(--bag-shadow);
    }
    .ba-glass .bw-empty-icon-svg {
      display: inline-grid; place-items: center; width: 62px; height: 62px; margin: 0 auto 12px; border-radius: 20px;
      color: var(--bag-gold);
      background: radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--bag-gold) 30%, transparent), transparent 70%), color-mix(in srgb, var(--bag-gold) 8%, transparent);
      box-shadow: inset 0 0 0 1px var(--bag-line-strong);
    }
    .ba-glass .bw-empty-icon-svg svg { width: 28px; height: 28px; }
    .ba-glass .bw-empty h3 { margin: 4px 0 6px; font-size: 18px; font-weight: 640; letter-spacing: -0.015em; color: var(--bag-text); }
    .ba-glass .bw-empty p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--bag-text-2); }

    @media (max-width: 1100px) {
      .ba-glass .bw-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .ba-glass .bw-shell { padding: 0 12px 60px; }
      .ba-glass .bw-stats { gap: 10px; }
      .ba-glass .bw-stat { min-height: 100px; padding: 13px 14px 12px; }
      .ba-glass .bw-bar-right { width: 100%; }
      .ba-glass .bw-bar-right .bw-quick-btn,
      .ba-glass .bw-bar-right .bw-btn { flex: 1 1 auto; }
      .ba-glass .bw-bar-sep { display: none; }
      .ba-glass .bw-group { padding: 14px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ba-glass .bw-stat,
      .ba-glass .bw-tile,
      .ba-glass .bw-pack,
      .ba-glass .bw-linked-tile { transition: none; }
      .ba-glass .bw-btn-icon.is-spinning svg { animation: none; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .ba-glass .bw-bar,
      .ba-glass .bw-group,
      .ba-glass .bw-linked,
      .ba-glass .bw-empty-card { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--bag-float); }
    }
    :root.low-power .ba-glass .bw-bar,
    :root.low-power .ba-glass .bw-group,
    :root.low-power .ba-glass .bw-linked,
    :root.low-power .ba-glass .bw-empty-card { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--bag-float); }
  </style>
`;
