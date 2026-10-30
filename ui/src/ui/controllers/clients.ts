/**
 * Client CRM Controller — Dynamic Notion-driven schema, CRUD, and sync.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
// Type-only: the agency bridge imports this module's types back, so a runtime
// edge here would be an import cycle.
import type { ClientAgencyLink } from "./clients-agency";
import { threadClear, threadRoot } from "../components/object-thread-nav";
import { pushEntityUrl } from "../app-settings";
import { pathForTab } from "../navigation";
import { slugify } from "../lib/slugs";

// ── Types ────────────────────────────────────────────────────

export interface NotionPropertySchema {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string; color: string }[];
  groups?: { id: string; name: string; color: string; option_ids: string[] }[];
}

export interface NotionDbSchema {
  databaseId: string;
  databaseName: string;
  properties: Record<string, NotionPropertySchema>;
  fetchedAt: number;
}

export interface DynamicClientRecord {
  id: string;
  notion_page_id?: string;
  data: Record<string, any>;
  created_at: string;
  updated_at: string;
  last_synced?: string;
}

export type CampaignStatusLite = "draft" | "active" | "paused" | "completed";

export interface CampaignPickerOption {
  id: string;
  name: string;
  status: CampaignStatusLite;
  funnelId: string | null;
  funnelName?: string;
}

export interface ClientRevenueEntry {
  id: string;
  clientId: string;
  amountCents: number;
  currency: string;
  note: string | null;
  loggedAt: number;
  createdAt: number;
}

export interface ClientActivityEntry {
  id: string;
  clientId: string;
  type: string;
  note: string;
  createdAt: number;
}

export interface ClientsStats {
  total: number;
  active: number;
  totalMrrCents: number;
  avgDealCents: number;
  churnCount: number;
}

export interface ClientsState {
  loading: boolean;
  error: string | null;
  success: string | null;
  clients: DynamicClientRecord[];
  schema: NotionDbSchema | null;
  selectedClientId: string | null;
  searchQuery: string;
  filterStatus: string;
  filterTags: string[];
  sortBy: string;
  sortDir: "asc" | "desc";
  // Dashboard stats
  stats: ClientsStats | null;
  // Pagination
  page: number;
  pageSize: number;
  totalPages: number;
  totalClients: number;
  // Grid windowing (incremental infinite-scroll render). We never paint the
  // full result set at once — 1000+ heavy glass cards with backdrop-filter
  // collapse the compositor. Instead we render `gridWindow` cards and grow the
  // window as a sentinel scrolls into view. `_gridWindowSig` tracks the active
  // filter/sort signature so the window resets to the base when it changes.
  gridWindow: number;
  _gridWindowSig?: string;
  /** Same mechanism for the table view, tracked separately: a window grown by
   *  scrolling the (cheap) grid must not be inherited by the (much heavier,
   *  ~12-cells-per-row) table when the user switches view. */
  tableWindow: number;
  _tableWindowSig?: string;
  /**
   * Progress of the multi-page initial fetch. `null` once every page has
   * landed; the loading screen reads it to show "412 / 1,297".
   */
  loadProgress: { loaded: number; total: number } | null;
  // Page-level tab
  pageTab: "clients" | "revenue" | "pipeline" | "activity";
  // Revenue page state
  revenueEntries: ClientRevenueEntry[];
  revenueLoading: boolean;
  revenueTotalCents: number;
  revenueShowLog: boolean;
  revenueLogClientId: string;
  revenueLogAmount: string;
  revenueLogNote: string;
  revenueLogSaving: boolean;
  revenueSortCol: "client" | "amount" | "date";
  revenueSortDir: "asc" | "desc";
  // Revenue + Activity in detail panel
  detailRevenue: {
    entries: ClientRevenueEntry[];
    loading: boolean;
    totalCents: number;
    showForm: boolean;
    formAmount: string;
    formNote: string;
    saving: boolean;
  };
  detailActivity: {
    entries: ClientActivityEntry[];
    loading: boolean;
    showForm: boolean;
    formType: string;
    formNote: string;
    saving: boolean;
  };
  // Kanban
  kanbanGroupBy: string;
  /** Whether the toolbar's "Group by" popover is open. */
  groupByMenuOpen: boolean;
  kanbanDragClientId: string | null;
  kanbanDragOverCol: string | null;
  /** Active temperature filter pill ("", "cold", "warm", "hot"). Empty = all. */
  kanbanTempFilter: "" | "cold" | "warm" | "hot";
  /**
   * Per-column render cap for the kanban board. A single pipeline stage can
   * hold hundreds of clients; mounting them all makes the board unscrollable.
   */
  kanbanColWindow: Record<string, number>;
  // Form state
  showCreateDialog: boolean;
  showEditDialog: boolean;
  editingClient: DynamicClientRecord | null;
  formData: Record<string, any>;
  saving: boolean;
  // Notion sync
  notionSyncing: boolean;
  notionSyncError: string | null;
  notionDbId: string | null;
  notionLastSync: number | null;
  /**
   * The database this business's `clients` role is actually bound to, as
   * reported by `clients.list`. Distinct from `notionDbId` — that is the
   * optional Notion *sync* target, this is where the list comes from.
   */
  clientsDbId: string | null;
  clientsDbName: string | null;
  clientsDbRowCount: number | null;
  notionImporting: boolean;
  notionCreatingDb: boolean;
  notionDbUrl: string;
  showNotionConnect: boolean;
  // Generic import (CSV / JSON / vCard)
  showImportDialog: boolean;
  importFormat: "csv" | "json" | "vcard";
  importDataText: string;
  importBusy: boolean;
  importLastResult: { imported: number; skipped: number; total: number } | null;
  // Detail panel
  showDetailPanel: boolean;
  detailClient: DynamicClientRecord | null;
  detailLoading: boolean;
  detailTab:
    | "overview"
    | "connections"
    | "properties"
    | "docs"
    | "relations"
    | "campaign"
    | "agency"
    | "activity"
    | "revenue"
    | "kanban";
  /**
   * Resolution of this CRM record against the agency operating system, and the
   * gate for the Invoicing & agency tab. Lazily created by
   * `controllers/clients-agency.ts`; `null` simply means "not looked up yet".
   */
  agencyLink: ClientAgencyLink | null;
  detailDocsDraft: string;
  detailDocsSaving: boolean;
  detailDocsDirty: boolean;
  detailRelations: {
    project: RelationPeerLite[];
    note: RelationPeerLite[];
    workflow: RelationPeerLite[];
    campaign: RelationPeerLite[];
    loading: boolean;
    error: string | null;
  };
  detailKanban: {
    loading: boolean;
    projects: Array<{ id: string; name: string; status?: string }>;
    tasks: Array<{
      id: string; title: string; status: string; projectId: string | null;
      priority?: string; assignee?: string; dueDate?: string;
    }>;
  };
  relationPickerOpenFor: "project" | "note" | "workflow" | "campaign" | null;
  relationPickerQuery: string;
  // Catalogs used by the relation picker — fetched lazily on first open.
  catalogs: {
    projects: { id: string; name: string }[];
    notes: { id: string; name: string }[];
    workflows: { id: string; name: string }[];
    loadedAt: number | null;
  };
  // View mode
  viewMode: "grid" | "table" | "kanban";
  // Delete confirm
  showDeleteConfirm: string | null;
  // Campaign tab
  campaignPickerOptions: CampaignPickerOption[];
  campaignPickerLoading: boolean;
  campaignPickerOpen: boolean;
  campaignContextLoading: boolean;
  campaignContextPreview: unknown | null;
  /** Draft placeholder map while the table editor is open. null = display mode. */
  campaignPlaceholderDraft: Record<string, string> | null;
}

export interface RelationPeerLite {
  id: string;
  name: string;
  createdAt?: string;
}

// ── Group-by persistence ─────────────────────────────────────
// The kanban "Group by" property the user picks on /clients is persisted so it
// survives reloads AND so the /dashboard Client Pipeline donut can mirror the
// exact same grouping. localStorage is the existing channel used by other
// dashboard widgets (focus, kanban default project), so we follow that rather
// than introducing a new store.
/**
 * Record which database the server says this business's client list is bound
 * to. Server installs older than this field simply leave it null and the CRM
 * bar shows nothing rather than a wrong name.
 */
function applyClientsDatabase(cs: ClientsState, res: any): void {
  const bound = res?.clientsDatabase;
  cs.clientsDbId = typeof bound?.id === "string" ? bound.id : null;
  cs.clientsDbName = typeof bound?.name === "string" ? bound.name : null;
  cs.clientsDbRowCount = typeof bound?.rowCount === "number" ? bound.rowCount : null;
}

export const CLIENTS_GROUP_BY_KEY = "infinibot.clients.groupBy";

export function loadClientsGroupByPref(): string {
  try {
    return localStorage.getItem(CLIENTS_GROUP_BY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveClientsGroupByPref(groupBy: string): void {
  try {
    if (groupBy) localStorage.setItem(CLIENTS_GROUP_BY_KEY, groupBy);
    else localStorage.removeItem(CLIENTS_GROUP_BY_KEY);
  } catch {
    /* non-fatal */
  }
}

/** Set the active kanban group-by on state AND persist it. */
export function setClientsGroupBy(cs: ClientsState, groupBy: string): void {
  cs.kanbanGroupBy = groupBy;
  saveClientsGroupByPref(groupBy);
}

// ── Initialization ───────────────────────────────────────────

export function createInitialClientsState(): ClientsState {
  return {
    loading: false,
    error: null,
    success: null,
    clients: [],
    schema: null,
    selectedClientId: null,
    searchQuery: "",
    filterStatus: "",
    filterTags: [],
    sortBy: "updated_at",
    sortDir: "desc",
    stats: null,
    page: 1,
    pageSize: 10,
    totalPages: 1,
    totalClients: 0,
    gridWindow: 60,
    _gridWindowSig: undefined,
    tableWindow: 60,
    _tableWindowSig: undefined,
    loadProgress: null,
    pageTab: "clients",
    revenueEntries: [],
    revenueLoading: false,
    revenueTotalCents: 0,
    revenueShowLog: false,
    revenueLogClientId: "",
    revenueLogAmount: "",
    revenueLogNote: "",
    revenueLogSaving: false,
    revenueSortCol: "date",
    revenueSortDir: "desc",
    detailRevenue: { entries: [], loading: false, totalCents: 0, showForm: false, formAmount: "", formNote: "", saving: false },
    detailActivity: { entries: [], loading: false, showForm: false, formType: "note", formNote: "", saving: false },
    kanbanGroupBy: "",
    groupByMenuOpen: false,
    kanbanDragClientId: null,
    kanbanDragOverCol: null,
    kanbanTempFilter: "",
    kanbanColWindow: {},
    showCreateDialog: false,
    showEditDialog: false,
    editingClient: null,
    formData: {},
    saving: false,
    notionSyncing: false,
    notionSyncError: null,
    notionDbId: null,
    notionLastSync: null,
    clientsDbId: null,
    clientsDbName: null,
    clientsDbRowCount: null,
    notionImporting: false,
    notionCreatingDb: false,
    notionDbUrl: "",
    showNotionConnect: false,
    showImportDialog: false,
    importFormat: "csv",
    importDataText: "",
    importBusy: false,
    importLastResult: null,
    showDetailPanel: false,
    detailClient: null,
    detailLoading: false,
    detailTab: "overview",
    agencyLink: null,
    detailDocsDraft: "",
    detailDocsSaving: false,
    detailDocsDirty: false,
    detailRelations: { project: [], note: [], workflow: [], campaign: [], loading: false, error: null },
    detailKanban: { loading: false, projects: [], tasks: [] },
    relationPickerOpenFor: null,
    relationPickerQuery: "",
    catalogs: { projects: [], notes: [], workflows: [], loadedAt: null },
    viewMode: "grid",
    showDeleteConfirm: null,
    campaignPickerOptions: [],
    campaignPickerLoading: false,
    campaignPickerOpen: false,
    campaignContextLoading: false,
    campaignContextPreview: null,
    campaignPlaceholderDraft: null,
  };
}

// ── Notion URL Parser ────────────────────────────────────────

export function parseNotionDatabaseUrl(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return trimmed;
  if (/^[0-9a-f]{32}$/i.test(trimmed)) return formatNotionId(trimmed);
  const urlMatch = trimmed.match(/([0-9a-f]{32})/i);
  if (urlMatch) return formatNotionId(urlMatch[1]);
  const uuidMatch = trimmed.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (uuidMatch) return uuidMatch[1];
  return null;
}

function formatNotionId(hex: string): string {
  const h = hex.replace(/-/g, "");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── Schema Helpers ───────────────────────────────────────────

/** Get the title property name from schema */
export function getTitleProperty(schema: NotionDbSchema | null): string | null {
  if (!schema) return null;
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === "title") return name;
  }
  return null;
}

/** Get the name/title value from a client's data */
export function getClientName(client: DynamicClientRecord, schema: NotionDbSchema | null): string {
  if (!client?.data) return (client as any)?.name || "Untitled";
  const titleProp = getTitleProperty(schema);
  if (titleProp && client.data[titleProp]) return String(client.data[titleProp]);
  // Fallback: look for any string value
  for (const v of Object.values(client.data)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "Untitled";
}

/**
 * Group-by sentinel for "don't group at all" — distinct from `""`, which
 * means "nothing chosen yet, fall back to the schema default".
 */
export const CLIENTS_GROUP_BY_NONE = "__none__";

/**
 * Property types a board can group on. `multi_select` is included because a
 * tag-style property is one of the most useful axes to slice a CRM by (a card
 * simply appears in a column per tag) — the Kanban already handles fan-out.
 *
 * Both the Notion (`multi_select`) and native-store (`multiSelect`) spellings
 * are accepted: the two schema sources disagree and the board must group the
 * same either way.
 */
const GROUPABLE_TYPES = new Set(["status", "select", "multi_select", "multiSelect"]);

/** True when this property type can back a kanban grouping. */
export function isGroupableType(type: string | undefined): boolean {
  return !!type && GROUPABLE_TYPES.has(type);
}

/** True when the property fans one client out across several columns. */
export function isMultiValueType(type: string | undefined): boolean {
  return type === "multi_select" || type === "multiSelect";
}

/**
 * Rank used to order the group-by menu: the property a user most likely wants
 * first. Status is the canonical pipeline axis, then single-selects, then the
 * multi-value ones (which produce the busiest boards).
 */
function groupableRank(type: string): number {
  if (type === "status") return 0;
  if (type === "select") return 1;
  return 2;
}

/** Get properties that can be used as kanban grouping */
export function getGroupableProperties(schema: NotionDbSchema | null): NotionPropertySchema[] {
  if (!schema) return [];
  return Object.values(schema.properties)
    .filter((p) => isGroupableType(p.type))
    .sort((a, b) => groupableRank(a.type) - groupableRank(b.type));
}

/** Get options for a property */
export function getGroupOptions(schema: NotionDbSchema | null, propertyName: string): { id: string; name: string; color: string }[] {
  if (!schema) return [];
  const prop = schema.properties[propertyName];
  return prop?.options ?? [];
}

/** Determine the default kanban group-by property */
export function getDefaultGroupBy(schema: NotionDbSchema | null): string {
  if (!schema) return "";
  // Prefer status, then a single-select, then a tag-style property — the same
  // order the group-by menu lists them in.
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === "status") return name;
  }
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === "select") return name;
  }
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (isMultiValueType(prop.type)) return name;
  }
  return "";
}

// ── Helpers ──────────────────────────────────────────────────

function clearMessages(cs: ClientsState) { cs.error = null; cs.success = null; }

function showSuccess(cs: ClientsState, msg: string, state?: AppViewState) {
  cs.success = msg;
  state?.requestUpdate?.();
  setTimeout(() => { if (cs.success === msg) { cs.success = null; state?.requestUpdate?.(); } }, 4000);
}

/** Cards rendered on first paint of the grid, and how many more each time the
 *  infinite-scroll sentinel comes into view. Kept modest because each card is a
 *  heavy backdrop-filter glass surface. */
export const GRID_WINDOW_BASE = 60;
export const GRID_WINDOW_STEP = 60;
/** Table rows mounted before the sentinel grows the window. */
export const TABLE_WINDOW_BASE = 60;
export const TABLE_WINDOW_STEP = 60;
/** Cards mounted per kanban column before the "show more" affordance. */
export const KANBAN_COL_WINDOW_BASE = 50;
export const KANBAN_COL_WINDOW_STEP = 50;

/** Page size used when pulling the full client set. Matches the server cap. */
export const CLIENTS_FETCH_PAGE_SIZE = 500;
/** How many follow-up pages to request concurrently. */
const CLIENTS_FETCH_CONCURRENCY = 8;
/** Hard stop so a bad `total` can never spin the loop forever. */
const CLIENTS_MAX_PAGES = 400;

export function getFilteredClients(cs: ClientsState): DynamicClientRecord[] {
  let list = [...cs.clients];

  // Search across all text/title/email fields in data
  if (cs.searchQuery) {
    const q = cs.searchQuery.toLowerCase();
    list = list.filter((c) => {
      for (const v of Object.values(c.data ?? {})) {
        if (typeof v === "string" && v.toLowerCase().includes(q)) return true;
        if (Array.isArray(v) && v.some((item) => typeof item === "string" && item.toLowerCase().includes(q))) return true;
      }
      return false;
    });
  }

  // Filter by status (using kanbanGroupBy property or filterStatus)
  if (cs.filterStatus && cs.schema) {
    const groupProp = cs.kanbanGroupBy || getDefaultGroupBy(cs.schema);
    if (groupProp) {
      list = list.filter((c) => {
        const val = c.data[groupProp];
        if (Array.isArray(val)) return val.includes(cs.filterStatus);
        return val === cs.filterStatus;
      });
    }
  }

  // Sort
  list.sort((a, b) => {
    let cmp = 0;
    if (cs.sortBy === "updated_at") {
      cmp = a.updated_at.localeCompare(b.updated_at);
    } else if (cs.sortBy === "created_at") {
      cmp = a.created_at.localeCompare(b.created_at);
    } else {
      // Sort by data property
      const va = a.data[cs.sortBy];
      const vb = b.data[cs.sortBy];
      if (typeof va === "string" && typeof vb === "string") cmp = va.localeCompare(vb);
      else if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else if (va && !vb) cmp = -1;
      else if (!va && vb) cmp = 1;
    }
    return cs.sortDir === "desc" ? -cmp : cmp;
  });

  return list;
}

export function getAllTags(cs: ClientsState): string[] {
  const tags = new Set<string>();
  if (!cs.schema) return [];
  // Collect all unique values from multi_select properties
  const multiSelectProps = Object.entries(cs.schema.properties).filter(([, p]) => p.type === "multi_select").map(([n]) => n);
  for (const c of cs.clients) {
    for (const prop of multiSelectProps) {
      const val = c.data[prop];
      if (Array.isArray(val)) for (const t of val) tags.add(t);
    }
  }
  return Array.from(tags).sort();
}

/** Column label for the flat, ungrouped board. */
export const CLIENTS_UNGROUPED_COLUMN = "All clients";

/**
 * Resolve the property the board should group on right now: an explicit
 * selection (including the "None" sentinel) wins, otherwise the schema
 * default. Returns "" when there is nothing groupable at all.
 */
export function resolveGroupBy(cs: ClientsState): string {
  if (cs.kanbanGroupBy) return cs.kanbanGroupBy;
  return getDefaultGroupBy(cs.schema);
}

/** Group clients by a property value (for kanban) */
export function getClientsByGroup(cs: ClientsState): Record<string, DynamicClientRecord[]> {
  const filtered = getFilteredClients(cs);
  const groupProp = resolveGroupBy(cs);

  // "None" is a real choice, not a missing one — one column holding everything.
  if (groupProp === CLIENTS_GROUP_BY_NONE || !groupProp) {
    return { [CLIENTS_UNGROUPED_COLUMN]: filtered };
  }

  const options = getGroupOptions(cs.schema, groupProp);
  const result: Record<string, DynamicClientRecord[]> = {};

  // Initialize all option columns
  for (const opt of options) result[opt.name] = [];
  result["—"] = []; // Uncategorized

  const propSchema = cs.schema?.properties[groupProp];
  const isMultiSelect = isMultiValueType(propSchema?.type);

  for (const c of filtered) {
    const val = c.data?.[groupProp];
    if (isMultiSelect && Array.isArray(val)) {
      if (val.length === 0) {
        result["—"].push(c);
      } else {
        for (const v of val) {
          const label = String(v);
          if (!result[label]) result[label] = [];
          result[label].push(c);
        }
      }
    } else if (Array.isArray(val)) {
      // A single-value property whose data happens to hold an array (mixed
      // imports do this) still has to land somewhere sensible.
      if (val.length === 0) result["—"].push(c);
      else {
        const label = String(val[0]);
        if (!result[label]) result[label] = [];
        result[label].push(c);
      }
    } else if (typeof val === "string" && val) {
      if (!result[val]) result[val] = [];
      result[val].push(c);
    } else {
      result["—"].push(c);
    }
  }

  return result;
}

// ── Load ─────────────────────────────────────────────────────

export async function loadClients(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs) return;

  cs.loading = true;
  clearMessages(cs);
  state.requestUpdate?.();

  try {
    const bs = state.businessState;
    const activeBiz = bs?.activeBusinessId
      ? bs.businesses.find((b) => b.id === bs.activeBusinessId) ?? null
      : null;

    // The CRM is now per-business on the server. We always call list +
    // status; the server returns `{ clients: [], schema: null,
    // databaseId: null }` when this business hasn't connected anything
    // yet, which is exactly the blank state the UI wants.
    const agencyId = bs?.activeBusinessId ?? null;

    // The CRM renders, filters, sorts and groups entirely client-side, so the
    // view needs the FULL set — not the server's first page. Pull page 1, read
    // `pagination.total`, then fetch the remaining pages concurrently.
    const res = (await client.request("clients.list", {
      agencyId,
      page: 1,
      pageSize: CLIENTS_FETCH_PAGE_SIZE,
    })) as any;

    const items: DynamicClientRecord[] = Array.isArray(res?.clients) ? [...res.clients] : [];
    const pg = res?.pagination ?? {};
    const total = typeof pg.total === "number" && pg.total >= 0 ? pg.total : items.length;
    // Trust the size the server ACTUALLY served, not the one we asked for: a
    // gateway running the pre-fix handler caps pages well below our request,
    // and paging by the requested size would then skip rows.
    const servedPageSize =
      typeof pg.pageSize === "number" && pg.pageSize >= 1
        ? pg.pageSize
        : items.length || CLIENTS_FETCH_PAGE_SIZE;

    cs.stats = res?.stats ?? null;
    cs.totalClients = total;

    if (items.length > 0 && items.length < total) {
      const pageCount = Math.min(Math.ceil(total / servedPageSize), CLIENTS_MAX_PAGES);
      cs.loadProgress = { loaded: items.length, total };
      state.requestUpdate?.();

      for (let p = 2; p <= pageCount; p += CLIENTS_FETCH_CONCURRENCY) {
        const batch: Promise<unknown>[] = [];
        for (let k = p; k < Math.min(p + CLIENTS_FETCH_CONCURRENCY, pageCount + 1); k++) {
          batch.push(
            client
              .request("clients.list", { agencyId, page: k, pageSize: servedPageSize })
              .catch(() => null),
          );
        }
        for (const r of await Promise.all(batch)) {
          const rows = (r as any)?.clients;
          if (Array.isArray(rows)) items.push(...rows);
        }
        cs.loadProgress = { loaded: items.length, total };
        state.requestUpdate?.();
      }
    }

    // De-dupe defensively: concurrent pages over a store that mutated
    // mid-fetch can repeat a row, and duplicate ids break Lit keying + drag.
    const seen = new Set<string>();
    cs.clients = items.filter((c) => {
      if (!c?.id || seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
    cs.loadProgress = null;
    cs.schema = res?.schema ?? null;
    // Everything is in memory, so the legacy server-page control has nothing
    // left to page through. Kept in state for API compatibility.
    cs.page = 1;
    cs.totalPages = 1;
    // Fresh data → reset the incremental render window to the base.
    cs.gridWindow = GRID_WINDOW_BASE;
    cs._gridWindowSig = undefined;
    cs.tableWindow = TABLE_WINDOW_BASE;
    cs._tableWindowSig = undefined;

    applyClientsDatabase(cs, res);

    const syncRes = (await client.request("clients.notion.status", { agencyId: bs?.activeBusinessId ?? null })) as any;
    // Trust an explicit answer from the server. Falling back to the business
    // profile's `crmDatabaseId` when the server said "not connected" is what
    // made the CRM bar claim it was bound to a stale Notion database.
    cs.notionDbId = syncRes ? (syncRes.databaseId ?? null) : (activeBiz?.crmDatabaseId ?? null);
    cs.notionLastSync = syncRes?.lastSync ?? null;

    // Mirror the freshly-loaded crmDatabaseId/Name onto the active business
    // profile in memory so the rest of the UI (badges, leads view) reads
    // the same source of truth without an extra round-trip.
    if (activeBiz && syncRes) {
      activeBiz.crmDatabaseId = syncRes.databaseId ?? null;
      activeBiz.crmDatabaseName = syncRes.databaseName ?? activeBiz.crmDatabaseName ?? null;
    }

    // Schema fallback: business.clients.list already embeds it; this is
    // here for older server installs that didn't yet return it together.
    if (!cs.schema) {
      try {
        const schemaRes = (await client.request("clients.notion.schema", { agencyId: state.businessState?.activeBusinessId ?? null })) as any;
        if (schemaRes?.schema) cs.schema = schemaRes.schema;
      } catch { /* non-fatal */ }
    }

    // Resolve kanban groupBy: in-memory selection wins, then the persisted
    // preference (shared with the dashboard pipeline donut), then the schema
    // default. Only honour a persisted prop that still exists on the schema.
    if (!cs.kanbanGroupBy) {
      const pref = loadClientsGroupByPref();
      // "None" is an explicit choice and has no schema property to validate
      // against, so it is honoured before the existence check.
      if (pref === CLIENTS_GROUP_BY_NONE) {
        cs.kanbanGroupBy = CLIENTS_GROUP_BY_NONE;
      } else if (pref && cs.schema?.properties?.[pref]) {
        cs.kanbanGroupBy = pref;
      } else if (cs.schema) {
        cs.kanbanGroupBy = getDefaultGroupBy(cs.schema);
      }
    }
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
  }

  cs.loading = false;
  state.requestUpdate?.();
}

// ── Create ───────────────────────────────────────────────────

export async function createClient(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  if (!cs) return false;

  cs.saving = true;
  clearMessages(cs);
  state.requestUpdate?.();

  try {
    const res = (await client.request("clients.create", { agencyId: state.businessState?.activeBusinessId ?? null, data: cs.formData })) as any;

    if (res?.client) {
      cs.clients.push(res.client);
    }
    cs.showCreateDialog = false;
    cs.formData = {};
    cs.saving = false;
    const titleProp = getTitleProperty(cs.schema);
    const name = titleProp ? cs.formData[titleProp] || "Client" : "Client";
    showSuccess(cs, `Client created`, state);
    return true;
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    cs.saving = false;
    state.requestUpdate?.();
    return false;
  }
}

// ── Update ───────────────────────────────────────────────────

export async function updateClient(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  if (!cs || !cs.editingClient) return false;

  cs.saving = true;
  clearMessages(cs);
  state.requestUpdate?.();

  try {
    const res = (await client.request("clients.update", {
      agencyId: state.businessState?.activeBusinessId ?? null,
      id: cs.editingClient.id,
      data: cs.formData,
    })) as any;

    if (res?.client) {
      const idx = cs.clients.findIndex((c) => c.id === res.client.id);
      if (idx >= 0) cs.clients[idx] = res.client;
      if (cs.detailClient?.id === res.client.id) cs.detailClient = res.client;
    }
    cs.showEditDialog = false;
    cs.editingClient = null;
    cs.formData = {};
    cs.saving = false;
    showSuccess(cs, "Client updated", state);
    return true;
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    cs.saving = false;
    state.requestUpdate?.();
    return false;
  }
}

// ── Update Property (quick) ──────────────────────────────────

export async function updateClientProperty(
  state: AppViewState,
  client: GatewayBrowserClient,
  clientId: string,
  propertyName: string,
  value: any,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs) return;

  try {
    const res = (await client.request("clients.update", {
      agencyId: state.businessState?.activeBusinessId ?? null,
      id: clientId,
      data: { [propertyName]: value },
    })) as any;
    if (res?.client) {
      const idx = cs.clients.findIndex((c) => c.id === res.client.id);
      if (idx >= 0) cs.clients[idx] = res.client;
      if (cs.detailClient?.id === res.client.id) cs.detailClient = res.client;
    }
    state.requestUpdate?.();
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ── Delete ───────────────────────────────────────────────────

export async function deleteClient(state: AppViewState, client: GatewayBrowserClient, clientId: string): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs) return;

  try {
    await client.request("clients.delete", {
      agencyId: state.businessState?.activeBusinessId ?? null,
      id: clientId,
    });
    cs.clients = cs.clients.filter((c) => c.id !== clientId);
    cs.showDeleteConfirm = null;
    if (cs.detailClient?.id === clientId) {
      cs.detailClient = null;
      cs.showDetailPanel = false;
    }
    showSuccess(cs, "Client deleted", state);
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ── Notion CRM Sync ─────────────────────────────────────────

export async function createNotionCrmDatabase(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  if (!cs) return false;

  cs.notionCreatingDb = true;
  clearMessages(cs);
  state.requestUpdate?.();

  try {
    const res = (await client.request("clients.notion.create", { agencyId: state.businessState?.activeBusinessId ?? null })) as any;
    cs.notionDbId = res?.databaseId ?? null;
    cs.notionCreatingDb = false;
    // Reload to get schema
    await loadClients(state, client);
    showSuccess(cs, "Notion CRM database created", state);
    return true;
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    cs.notionCreatingDb = false;
    state.requestUpdate?.();
    return false;
  }
}

export async function syncClientsToNotion(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  if (!cs) return false;

  cs.notionSyncing = true;
  cs.notionSyncError = null;
  clearMessages(cs);
  state.requestUpdate?.();

  try {
    const res = (await client.request("clients.notion.sync", { agencyId: state.businessState?.activeBusinessId ?? null })) as any;
    cs.notionSyncing = false;
    cs.notionLastSync = res?.lastSync ?? Date.now();
    await loadClients(state, client);
    showSuccess(cs, `Synced ${res?.total ?? 0} clients to Notion (${res?.created ?? 0} new, ${res?.updated ?? 0} updated)`, state);
    return true;
  } catch (e) {
    cs.notionSyncing = false;
    cs.notionSyncError = e instanceof Error ? e.message : String(e);
    cs.error = cs.notionSyncError;
    state.requestUpdate?.();
    return false;
  }
}

export async function importClientsFromNotion(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  if (!cs) return false;

  cs.notionImporting = true;
  clearMessages(cs);
  state.requestUpdate?.();

  try {
    const res = (await client.request("clients.notion.import", { agencyId: state.businessState?.activeBusinessId ?? null })) as any;
    cs.notionImporting = false;
    await loadClients(state, client);
    showSuccess(cs, `Imported ${res?.imported ?? 0} new, updated ${res?.updated ?? 0} from Notion`, state);
    return true;
  } catch (e) {
    cs.notionImporting = false;
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return false;
  }
}

export async function connectNotionFromUrl(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  if (!cs) return false;

  const dbId = parseNotionDatabaseUrl(cs.notionDbUrl);
  if (!dbId) {
    cs.error = "Invalid Notion URL or database ID.";
    state.requestUpdate?.();
    return false;
  }

  const result = await connectNotionCrmDatabase(state, client, dbId);
  if (result) {
    cs.notionDbUrl = "";
    cs.showNotionConnect = false;
  }
  return result;
}

export async function connectNotionCrmDatabase(state: AppViewState, client: GatewayBrowserClient, databaseId: string): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  const bs = state.businessState;
  if (!cs) return false;

  try {
    const res = (await client.request("clients.notion.connect", {
      agencyId: bs?.activeBusinessId ?? null,
      databaseId,
    })) as any;
    cs.notionDbId = databaseId;
    // Mirror the connect response onto the active business profile in
    // memory. The gateway has already persisted these to disk, but the
    // UI-side profile object needs the same values so the leads/clients
    // bars can read them without re-fetching.
    if (bs?.activeBusinessId) {
      const idx = bs.businesses.findIndex((b) => b.id === bs.activeBusinessId);
      if (idx >= 0) {
        bs.businesses[idx] = {
          ...bs.businesses[idx],
          crmDatabaseId: databaseId,
          crmDatabaseName: res?.databaseName ?? bs.businesses[idx].crmDatabaseName ?? null,
          updatedAt: new Date().toISOString(),
        };
      }
    }
    if (res?.schema) cs.schema = res.schema;
    // Re-pull the clients list — switching DBs server-side drops Notion
    // rows from the previous DB, so the local cache is stale.
    await loadClients(state, client);
    if (cs.schema && !cs.kanbanGroupBy) {
      cs.kanbanGroupBy = getDefaultGroupBy(cs.schema);
    }
    // Auto-import on first connect: if the local CRM has no clients yet,
    // pull from Notion immediately so the user sees their existing rows
    // without an extra click. Skipped when clients already exist (manual
    // entries, prior import) so we don't duplicate or surprise the user.
    if (cs.clients.length === 0) {
      // Tell the user what's happening; importClientsFromNotion clears
      // this success on its own showSuccess when it finishes.
      showSuccess(cs, "Connected — pulling clients from Notion…", state);
      await importClientsFromNotion(state, client);
    } else {
      showSuccess(cs, "Connected to Notion database", state);
    }
    return true;
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return false;
  }
}

/**
 * Disconnect the CRM Notion database from the active business. Pass
 * `dropClients: true` to also wipe local clients (useful when starting
 * over from a vCard / CSV import). By default, manual entries are kept
 * and Notion-sourced rows are stripped of their `notion_page_id` so they
 * stop trying to round-trip back to a database the user no longer owns.
 */
export async function disconnectNotionCrmDatabase(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts: { dropClients?: boolean } = {},
): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  const bs = state.businessState;
  if (!cs) return false;
  try {
    await client.request("clients.notion.disconnect", {
      agencyId: bs?.activeBusinessId ?? null,
      dropClients: !!opts.dropClients,
    });
    cs.notionDbId = null;
    cs.notionLastSync = null;
    cs.schema = null;
    if (bs?.activeBusinessId) {
      const idx = bs.businesses.findIndex((b) => b.id === bs.activeBusinessId);
      if (idx >= 0) {
        bs.businesses[idx] = {
          ...bs.businesses[idx],
          crmDatabaseId: null,
          crmDatabaseName: null,
          updatedAt: new Date().toISOString(),
        };
      }
    }
    await loadClients(state, client);
    showSuccess(cs, "Disconnected from Notion", state);
    return true;
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return false;
  }
}

/**
 * Generic import — converts CSV / JSON / vCard text into client records
 * on the active business. Independent of Notion: the user can run a
 * Notion sync afterwards if they want the rows mirrored upstream.
 */
export async function importClientsFromText(
  state: AppViewState,
  client: GatewayBrowserClient,
  format: "csv" | "json" | "vcard",
  text: string,
  mapping?: Record<string, string>,
): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  if (!cs) return false;
  if (!text || !text.trim()) {
    cs.error = "Paste or upload data before importing.";
    state.requestUpdate?.();
    return false;
  }
  cs.importBusy = true;
  cs.importLastResult = null;
  clearMessages(cs);
  state.requestUpdate?.();
  try {
    const res = (await client.request("clients.import", {
      agencyId: state.businessState?.activeBusinessId ?? null,
      format,
      data: text,
      mapping: mapping ?? {},
    })) as any;
    cs.importLastResult = {
      imported: Number(res?.imported ?? 0),
      skipped: Number(res?.skipped ?? 0),
      total: Number(res?.total ?? 0),
    };
    cs.importBusy = false;
    cs.showImportDialog = false;
    cs.importDataText = "";
    await loadClients(state, client);
    showSuccess(
      cs,
      `Imported ${cs.importLastResult.imported} ${format.toUpperCase()} record${cs.importLastResult.imported === 1 ? "" : "s"}` +
        (cs.importLastResult.skipped > 0 ? ` (${cs.importLastResult.skipped} skipped)` : ""),
      state,
    );
    return true;
  } catch (e) {
    cs.importBusy = false;
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return false;
  }
}

// ── Relations & detail-tab actions ────────────────────────────

const DETAIL_DOCS_KEY = "_docs";

/**
 * Switches which tab is visible on the detail panel. Lazy-loads relations
 * + catalogs on first switch to the Relations tab so the picker can populate.
 */
export function setDetailTab(
  state: AppViewState,
  client: GatewayBrowserClient,
  tab: ClientsState["detailTab"],
): void {
  const bs = state.businessState;
  const cs = bs?._clientsState;
  if (!cs) return;
  cs.detailTab = tab;
  // Reset docs draft when switching INTO docs and the draft hasn't been touched.
  if (tab === "docs" && !cs.detailDocsDirty) {
    const body = cs.detailClient?.data?.[DETAIL_DOCS_KEY];
    cs.detailDocsDraft = typeof body === "string" ? body : "";
  }
  if (tab === "relations" || tab === "connections") {
    void loadRelationsForDetail(state, client);
    void loadRelationCatalogs(state, client);
  }
  if (tab === "campaign") {
    cs.campaignContextPreview = null;
    cs.campaignPlaceholderDraft = null;
    void loadCampaignPickerOptions(state, client);
  }
  if (tab === "revenue") {
    void loadDetailRevenue(state, client);
  }
  if (tab === "activity") {
    void loadDetailActivity(state, client);
  }
  state.requestUpdate?.();
}

/**
 * The agency (business) every clients.* call must be scoped to.
 *
 * `clients.revenue.*` and `clients.activity.*` all resolve an agencyId
 * server-side and default to DEFAULT_AGENCY_ID when the caller omits it. These
 * calls omitted it — so on any non-default business the CRM read and wrote its
 * revenue and activity under the DEFAULT agency: self-consistent enough to look
 * fine in this view, but filed against the wrong business, invisible to the
 * agency-scoped rollups, and empty for any row created with a correct scope.
 */
function agencyIdOf(state: AppViewState): string | null {
  return state.businessState?.activeBusinessId ?? null;
}

export async function loadDetailRevenue(
  state: AppViewState,
  gatewayClient: GatewayBrowserClient,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs || !cs.detailClient) return;
  cs.detailRevenue.loading = true;
  state.requestUpdate?.();
  try {
    const res = (await gatewayClient.request("clients.revenue.list", {
      clientId: cs.detailClient.id,
      agencyId: agencyIdOf(state),
    })) as any;
    cs.detailRevenue.entries = (res?.entries ?? []) as ClientRevenueEntry[];
    cs.detailRevenue.totalCents = res?.totalCents ?? 0;
  } catch { /* silent */ }
  cs.detailRevenue.loading = false;
  state.requestUpdate?.();
}

export async function logDetailRevenue(
  state: AppViewState,
  gatewayClient: GatewayBrowserClient,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs || !cs.detailClient) return;
  const amount = parseFloat(cs.detailRevenue.formAmount);
  if (!Number.isFinite(amount) || amount <= 0) return;
  cs.detailRevenue.saving = true;
  state.requestUpdate?.();
  try {
    await gatewayClient.request("clients.revenue.log", {
      clientId: cs.detailClient.id,
      amount,
      note: cs.detailRevenue.formNote || undefined,
      agencyId: agencyIdOf(state),
    });
    cs.detailRevenue.formAmount = "";
    cs.detailRevenue.formNote = "";
    cs.detailRevenue.showForm = false;
    await loadDetailRevenue(state, gatewayClient);
  } catch (e: any) {
    cs.error = e?.message ?? "Failed to log revenue";
  }
  cs.detailRevenue.saving = false;
  state.requestUpdate?.();
}

export async function loadDetailActivity(
  state: AppViewState,
  gatewayClient: GatewayBrowserClient,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs || !cs.detailClient) return;
  cs.detailActivity.loading = true;
  state.requestUpdate?.();
  try {
    const res = (await gatewayClient.request("clients.activity.list", {
      clientId: cs.detailClient.id,
      agencyId: agencyIdOf(state),
    })) as any;
    cs.detailActivity.entries = (res?.entries ?? []) as ClientActivityEntry[];
  } catch { /* silent */ }
  cs.detailActivity.loading = false;
  state.requestUpdate?.();
}

export async function logDetailActivity(
  state: AppViewState,
  gatewayClient: GatewayBrowserClient,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs || !cs.detailClient) return;
  if (!cs.detailActivity.formNote.trim()) return;
  cs.detailActivity.saving = true;
  state.requestUpdate?.();
  try {
    await gatewayClient.request("clients.activity.log", {
      clientId: cs.detailClient.id,
      type: cs.detailActivity.formType || "note",
      note: cs.detailActivity.formNote.trim(),
      agencyId: agencyIdOf(state),
    });
    cs.detailActivity.formNote = "";
    cs.detailActivity.showForm = false;
    await loadDetailActivity(state, gatewayClient);
  } catch (e: any) {
    cs.error = e?.message ?? "Failed to log activity";
  }
  cs.detailActivity.saving = false;
  state.requestUpdate?.();
}

export async function loadPageRevenue(
  state: AppViewState,
  gatewayClient: GatewayBrowserClient,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  cs.revenueLoading = true;
  state.requestUpdate?.();
  try {
    const res = (await gatewayClient.request("clients.revenue.list", { agencyId: agencyIdOf(state) })) as any;
    cs.revenueEntries = (res?.entries ?? []) as ClientRevenueEntry[];
    cs.revenueTotalCents = res?.totalCents ?? 0;
  } catch { /* silent */ }
  cs.revenueLoading = false;
  state.requestUpdate?.();
}

export async function logPageRevenue(
  state: AppViewState,
  gatewayClient: GatewayBrowserClient,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  const amount = parseFloat(cs.revenueLogAmount);
  if (!Number.isFinite(amount) || amount <= 0 || !cs.revenueLogClientId) return;
  cs.revenueLogSaving = true;
  state.requestUpdate?.();
  try {
    await gatewayClient.request("clients.revenue.log", {
      clientId: cs.revenueLogClientId,
      amount,
      note: cs.revenueLogNote || undefined,
      agencyId: agencyIdOf(state),
    });
    cs.revenueShowLog = false;
    cs.revenueLogAmount = "";
    cs.revenueLogNote = "";
    cs.revenueLogClientId = "";
    await loadPageRevenue(state, gatewayClient);
  } catch (e: any) {
    cs.error = e?.message ?? "Failed to log revenue";
  }
  cs.revenueLogSaving = false;
  state.requestUpdate?.();
}

export function openClientDetail(
  state: AppViewState,
  clientSvc: GatewayBrowserClient,
  record: DynamicClientRecord,
): void {
  const bs = state.businessState;
  const cs = bs?._clientsState;
  if (!cs) return;
  cs.showDetailPanel = true;
  cs.detailClient = record;
  cs.detailTab = "overview";
  cs.detailDocsDraft = typeof record.data?.[DETAIL_DOCS_KEY] === "string"
    ? record.data[DETAIL_DOCS_KEY]
    : "";
  cs.detailDocsDirty = false;
  cs.detailRelations = { project: [], note: [], workflow: [], campaign: [], loading: false, error: null };
  // A stale link would show the previous client's invoices for a frame.
  cs.agencyLink = null;
  cs.campaignContextPreview = null;
  cs.campaignPlaceholderDraft = null;
  // Deep-link: reflect the opened client in the URL so refresh/paste restores it.
  pushEntityUrl(
    state as unknown as Parameters<typeof pushEntityUrl>[0],
    "client",
    slugify(getClientName(record, cs.schema), record.id),
    "clients",
  );
  // Open (or restart) the navigation thread at this client. Every drill-in
  // from the Connections panel pushes onto this stack, so the breadcrumb can
  // always thread back here — see components/object-thread-nav.ts.
  threadRoot(state, {
    type: "client",
    id: record.id,
    label: getClientName(record, cs.schema) || "Client",
  });
  state.requestUpdate?.();
  // Warm-load relations so the badge counts populate even before user opens the tab.
  void loadRelationsForDetail(state, clientSvc);
}

export function closeClientDetail(state: AppViewState): void {
  const bs = state.businessState;
  const cs = bs?._clientsState;
  if (!cs) return;
  cs.showDetailPanel = false;
  cs.detailClient = null;
  cs.detailTab = "overview";
  cs.detailDocsDraft = "";
  cs.detailDocsDirty = false;
  cs.detailKanban = { loading: false, projects: [], tasks: [] };
  cs.agencyLink = null;
  cs.relationPickerOpenFor = null;
  cs.campaignContextPreview = null;
  cs.campaignPlaceholderDraft = null;
  cs.campaignPickerOpen = false;
  // The thread only exists while a record is open; leaving it in place would
  // strand a ?thread= param on the plain list URL.
  threadClear();
  // Return the URL to the plain /clients list so Back/Forward stays consistent.
  if (typeof window !== "undefined") {
    const url = new URL(window.location.href);
    const listPath = pathForTab("clients", state.basePath ?? "");
    if (url.pathname !== listPath) {
      url.pathname = listPath;
      window.history.pushState({}, "", url.toString());
    }
  }
  state.requestUpdate?.();
}

export function setDocsDraft(state: AppViewState, body: string): void {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  cs.detailDocsDraft = body;
  cs.detailDocsDirty = true;
  state.requestUpdate?.();
}

export async function saveDocs(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  if (!cs?.detailClient) return false;
  if (!cs.detailDocsDirty) return true;
  const id = cs.detailClient.id;
  cs.detailDocsSaving = true;
  state.requestUpdate?.();
  try {
    const nextData = { ...(cs.detailClient.data ?? {}), [DETAIL_DOCS_KEY]: cs.detailDocsDraft };
    const res = (await client.request("clients.update", { id, data: nextData })) as any;
    const updated = res?.client ?? null;
    if (updated) {
      cs.detailClient = updated;
      const idx = cs.clients.findIndex((c) => c.id === id);
      if (idx >= 0) cs.clients[idx] = updated;
    } else {
      cs.detailClient = { ...cs.detailClient, data: nextData };
    }
    cs.detailDocsDirty = false;
    cs.detailDocsSaving = false;
    state.requestUpdate?.();
    return true;
  } catch (err) {
    cs.detailDocsSaving = false;
    cs.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

/**
 * Per-property inline edit. Patches `client.data[propName]` and persists
 * via business.clients.update. Optimistic; reverts on failure.
 */
export async function setClientProperty(
  state: AppViewState,
  client: GatewayBrowserClient,
  clientId: string,
  propName: string,
  value: unknown,
): Promise<boolean> {
  const cs = state.businessState?._clientsState;
  if (!cs) return false;
  const target = cs.clients.find((c) => c.id === clientId)
              ?? (cs.detailClient?.id === clientId ? cs.detailClient : null);
  if (!target) return false;
  const prevData = target.data ?? {};
  const nextData = { ...prevData, [propName]: value };
  // Optimistic
  target.data = nextData;
  if (cs.detailClient?.id === clientId) cs.detailClient = { ...cs.detailClient, data: nextData };
  state.requestUpdate?.();
  try {
    const res = (await client.request("clients.update", { id: clientId, data: nextData })) as any;
    const updated = res?.client ?? null;
    if (updated) {
      const idx = cs.clients.findIndex((c) => c.id === clientId);
      if (idx >= 0) cs.clients[idx] = updated;
      if (cs.detailClient?.id === clientId) cs.detailClient = updated;
    }
    state.requestUpdate?.();
    return true;
  } catch (err) {
    target.data = prevData;
    if (cs.detailClient?.id === clientId) cs.detailClient = { ...cs.detailClient, data: prevData };
    cs.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
    return false;
  }
}

// ── Relations ────────────────────────────────────────────────

async function fetchPeers(
  client: GatewayBrowserClient,
  type: "client" | "project" | "note" | "workflow",
  id: string,
  peerType: "project" | "note" | "workflow",
): Promise<Array<{ id: string; createdAt: string }>> {
  const res = (await client.request("relations.list", { type, id, peerType })) as any;
  const rels = Array.isArray(res?.relations) ? res.relations : [];
  return rels.map((r: any) => ({ id: String(r.id), createdAt: String(r.createdAt ?? "") }));
}

async function nameFor(
  client: GatewayBrowserClient,
  type: "project" | "note" | "workflow",
  id: string,
): Promise<string> {
  try {
    if (type === "project") {
      const r = (await client.request("projects.get", { id })) as any;
      return r?.project?.name ?? r?.project?.title ?? id;
    }
    if (type === "note") {
      const r = (await client.request("notes.get", { id })) as any;
      return r?.note?.name ?? r?.name ?? id;
    }
    if (type === "workflow") {
      const r = (await client.request("workflows.get", { id })) as any;
      return r?.workflow?.name ?? r?.name ?? id;
    }
  } catch {}
  return id;
}

export async function loadRelationsForDetail(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs?.detailClient) return;
  const ref = { type: "client" as const, id: cs.detailClient.id };
  cs.detailRelations.loading = true;
  cs.detailRelations.error = null;
  state.requestUpdate?.();
  try {
    const [proj, note, wf] = await Promise.all([
      fetchPeers(client, ref.type, ref.id, "project"),
      fetchPeers(client, ref.type, ref.id, "note"),
      fetchPeers(client, ref.type, ref.id, "workflow"),
    ]);
    // Resolve project names from the kanban project store in one round-trip
    // (same source the Overview mini-board uses), falling back to a per-id
    // projects.get only for ids the list didn't return.
    const projectNames = new Map<string, string>();
    if (proj.length > 0) {
      try {
        const projRes = (await client.request("kanban.projects.list", {})) as any;
        const allProjects: any[] = Array.isArray(projRes) ? projRes : (projRes?.projects ?? []);
        for (const p of allProjects) {
          projectNames.set(String(p.id), String(p.title ?? p.name ?? p.id));
        }
      } catch { /* fall back to per-id lookup below */ }
    }
    const projPeers = await Promise.all(proj.map(async (p) => ({
      id: p.id, createdAt: p.createdAt,
      name: projectNames.get(p.id) ?? await nameFor(client, "project", p.id),
    })));
    const notePeers = await Promise.all(note.map(async (p) => ({
      id: p.id, createdAt: p.createdAt, name: await nameFor(client, "note", p.id),
    })));
    const wfPeers = await Promise.all(wf.map(async (p) => ({
      id: p.id, createdAt: p.createdAt, name: await nameFor(client, "workflow", p.id),
    })));
    // Load campaign relations stored directly in client data as _campaignRelations
    const campaignIds = getClientCampaignRelations(cs.detailClient);
    const campaignPeers = await Promise.all(campaignIds.map(async (id) => ({
      id,
      createdAt: "",
      name: await nameForCampaign(client, id),
    })));
    cs.detailRelations = {
      project: projPeers,
      note: notePeers,
      workflow: wfPeers,
      campaign: campaignPeers,
      loading: false,
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cs.detailRelations.loading = false;
    cs.detailRelations.error = msg;
    cs.error = msg;
  }
  state.requestUpdate?.();
  // Now that we know which projects this client is on, pull the kanban
  // tasks so the detail page can render them as a live mini-board.
  void loadClientProjectsKanban(state, client);
}

/**
 * Loads kanban tasks for every project linked to the active client and the
 * project records themselves (for names + status colors). Idempotent — call
 * after relations resolve. Local-first via the kanban store, falls back to
 * an empty board on failure.
 */
export async function loadClientProjectsKanban(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs?.detailClient) return;
  const linkedIds = cs.detailRelations.project.map((p) => p.id);
  if (linkedIds.length === 0) {
    cs.detailKanban = { loading: false, projects: [], tasks: [] };
    state.requestUpdate?.();
    return;
  }
  cs.detailKanban.loading = true;
  state.requestUpdate?.();

  try {
    // Pull all kanban projects once, then filter by linked id. Cheaper than
    // N round-trips because kanban.projects.list returns a flat array.
    const projRes = (await client.request("kanban.projects.list", {})) as any;
    const allProjects: any[] = Array.isArray(projRes) ? projRes : (projRes?.projects ?? []);
    const linkedSet = new Set(linkedIds);
    const projects = allProjects
      .filter((p: any) => linkedSet.has(String(p.id)))
      .map((p: any) => ({ id: String(p.id), name: String(p.title ?? p.name ?? p.id), status: p.status }));

    // Fetch tasks per project. kanban.tasks.list accepts a projectId filter.
    const taskBatches = await Promise.all(
      linkedIds.map((pid) =>
        client.request("kanban.tasks.list", { projectId: pid }).catch(() => [] as any),
      ),
    );
    const tasks: ClientsState["detailKanban"]["tasks"] = [];
    for (const batch of taskBatches as any[]) {
      const arr: any[] = Array.isArray(batch) ? batch : (batch?.tasks ?? []);
      for (const t of arr) {
        tasks.push({
          id: String(t.id),
          title: String(t.title ?? t.name ?? t.id),
          status: normalizeTaskStatus(t.status),
          projectId: t.projectId ? String(t.projectId) : null,
          priority: typeof t.priority === "string" ? t.priority : undefined,
          assignee: typeof t.assignee === "string" ? t.assignee : undefined,
          dueDate: typeof t.dueDate === "string" ? t.dueDate : undefined,
        });
      }
    }
    cs.detailKanban = { loading: false, projects, tasks };
  } catch (err) {
    cs.detailKanban = { loading: false, projects: [], tasks: [] };
    cs.error = err instanceof Error ? err.message : String(err);
  }
  state.requestUpdate?.();
}

// Folds any of the many seen status spellings into our 4-column model.
function normalizeTaskStatus(raw: unknown): "todo" | "in_progress" | "done" | "blocked" {
  const s = String(raw ?? "").toLowerCase();
  if (!s) return "todo";
  if (s.includes("done") || s.includes("complete") || s === "closed") return "done";
  if (s.includes("block") || s.includes("hold") || s.includes("waiting")) return "blocked";
  if (s.includes("progress") || s === "doing" || s === "active" || s === "wip") return "in_progress";
  return "todo";
}

export async function loadRelationCatalogs(
  state: AppViewState,
  client: GatewayBrowserClient,
  force = false,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  // 30-second cache to avoid hammering during dropdown filter typing.
  if (!force && cs.catalogs.loadedAt && Date.now() - cs.catalogs.loadedAt < 30_000) return;
  try {
    const [projRes, notesRes, wfRes] = (await Promise.all([
      client.request("projects.list", {}).catch(() => ({})),
      client.request("notes.list", {}).catch(() => ({})),
      client.request("workflows.list", {}).catch(() => ({})),
    ])) as any[];
    const projects = ((projRes?.projects ?? []) as any[]).map((p: any) => ({
      id: String(p.id),
      name: String(p.name ?? p.title ?? p.id),
    }));
    const notes = ((notesRes?.notes ?? []) as any[]).map((n: any) => ({
      id: String(n.id),
      name: String(n.name ?? n.title ?? n.id),
    }));
    const workflows = ((wfRes?.workflows ?? wfRes?.items ?? []) as any[]).map((w: any) => ({
      id: String(w.id),
      name: String(w.name ?? w.title ?? w.id),
    }));
    cs.catalogs = { projects, notes, workflows, loadedAt: Date.now() };
    state.requestUpdate?.();
  } catch (err) {
    cs.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
  }
}

export async function linkClientPeer(
  state: AppViewState,
  client: GatewayBrowserClient,
  peerType: "project" | "note" | "workflow",
  peerId: string,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs?.detailClient) return;
  try {
    await client.request("relations.link", {
      left: { type: "client", id: cs.detailClient.id },
      right: { type: peerType, id: peerId },
    });
    await loadRelationsForDetail(state, client);
  } catch (err) {
    cs.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
  }
}

export async function unlinkClientPeer(
  state: AppViewState,
  client: GatewayBrowserClient,
  peerType: "project" | "note" | "workflow" | "campaign",
  peerId: string,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs?.detailClient) return;
  if (peerType === "campaign") {
    // Campaign relations are stored in client data; no relations.unlink needed.
    const next = getClientCampaignRelations(cs.detailClient).filter((id) => id !== peerId);
    cs.detailRelations.campaign = cs.detailRelations.campaign.filter((p) => p.id !== peerId);
    state.requestUpdate?.();
    await setClientProperty(state, client, cs.detailClient.id, CLIENT_CAMPAIGN_RELATIONS_KEY, next);
    return;
  }
  // Optimistic for project/note/workflow
  cs.detailRelations[peerType] = cs.detailRelations[peerType].filter((p) => p.id !== peerId);
  state.requestUpdate?.();
  try {
    await client.request("relations.unlink", {
      left: { type: "client", id: cs.detailClient.id },
      right: { type: peerType, id: peerId },
    });
  } catch (err) {
    cs.error = err instanceof Error ? err.message : String(err);
    await loadRelationsForDetail(state, client);
  }
}

export function setRelationPickerOpen(
  state: AppViewState,
  forType: "project" | "note" | "workflow" | "campaign" | null,
): void {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  cs.relationPickerOpenFor = forType;
  cs.relationPickerQuery = "";
  state.requestUpdate?.();
}

export function setRelationPickerQuery(state: AppViewState, q: string): void {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  cs.relationPickerQuery = q;
  state.requestUpdate?.();
}

// ── Campaign Integration ──────────────────────────────────────

/** Keys used in client.data for campaign fields. _* convention matches _docs. */
export const CLIENT_CAMPAIGN_ID_KEY = "_campaignId";
export const CLIENT_CAMPAIGN_PLACEHOLDERS_KEY = "_campaignPlaceholders";
export const CLIENT_CAMPAIGN_RELATIONS_KEY = "_campaignRelations";

/** Return the primary campaign id linked to this client, or null. */
export function getClientCampaignId(c: DynamicClientRecord | null): string | null {
  if (!c) return null;
  const v = c.data?.[CLIENT_CAMPAIGN_ID_KEY];
  return typeof v === "string" && v ? v : null;
}

/** Return the placeholder map stored on this client. */
export function getClientPlaceholders(c: DynamicClientRecord | null): Record<string, string> {
  if (!c) return {};
  const v = c.data?.[CLIENT_CAMPAIGN_PLACEHOLDERS_KEY];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
}

/** Return the list of additional related campaign IDs (Relations tab). */
export function getClientCampaignRelations(c: DynamicClientRecord | null): string[] {
  if (!c) return [];
  const v = c.data?.[CLIENT_CAMPAIGN_RELATIONS_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Load available campaigns into the picker. Scoped to active business. */
export async function loadCampaignPickerOptions(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs || cs.campaignPickerLoading) return;
  // Re-use cached options if loaded within the last 30 s
  if (cs.campaignPickerOptions.length > 0) return;
  cs.campaignPickerLoading = true;
  state.requestUpdate?.();
  try {
    const businessId = state.businessState?.activeBusinessId ?? null;
    const res = (await client.request("campaigns.list", { businessId })) as any;
    const list: any[] = Array.isArray(res?.campaigns) ? res.campaigns : [];
    cs.campaignPickerOptions = list.map((c: any) => ({
      id: String(c.id),
      name: String(c.name),
      status: (c.status ?? "draft") as CampaignStatusLite,
      funnelId: typeof c.funnelId === "string" ? c.funnelId : null,
    }));
  } catch {
    // Non-fatal
  }
  cs.campaignPickerLoading = false;
  state.requestUpdate?.();
}

/** Assign (or clear) the primary campaign on a client. */
export async function assignClientCampaign(
  state: AppViewState,
  client: GatewayBrowserClient,
  clientId: string,
  campaignId: string | null,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  cs.campaignPickerOpen = false;
  state.requestUpdate?.();
  await setClientProperty(state, client, clientId, CLIENT_CAMPAIGN_ID_KEY, campaignId ?? "");
}

/** Persist the placeholder key-value map on a client. */
export async function saveCampaignPlaceholders(
  state: AppViewState,
  client: GatewayBrowserClient,
  clientId: string,
  placeholders: Record<string, string>,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  cs.campaignPlaceholderDraft = null;
  state.requestUpdate?.();
  await setClientProperty(state, client, clientId, CLIENT_CAMPAIGN_PLACEHOLDERS_KEY, placeholders);
}

/** Link an additional campaign in the Relations tab. */
export async function linkClientCampaign(
  state: AppViewState,
  client: GatewayBrowserClient,
  clientId: string,
  campaignId: string,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs?.detailClient) return;
  const existing = getClientCampaignRelations(cs.detailClient);
  if (existing.includes(campaignId)) return;
  const next = [...existing, campaignId];
  // Resolve name for optimistic UI
  const opt = cs.campaignPickerOptions.find((o) => o.id === campaignId);
  cs.detailRelations.campaign = [
    ...cs.detailRelations.campaign,
    { id: campaignId, name: opt?.name ?? campaignId },
  ];
  cs.relationPickerOpenFor = null;
  cs.relationPickerQuery = "";
  state.requestUpdate?.();
  await setClientProperty(state, client, clientId, CLIENT_CAMPAIGN_RELATIONS_KEY, next);
}

/** Call campaigns.contextForClient and cache the response for preview. */
export async function generateClientContext(
  state: AppViewState,
  client: GatewayBrowserClient,
  clientId: string,
): Promise<void> {
  const cs = state.businessState?._clientsState;
  if (!cs) return;
  cs.campaignContextLoading = true;
  cs.campaignContextPreview = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("campaigns.contextForClient", { clientId })) as any;
    cs.campaignContextPreview = res?.context ?? null;
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
  }
  cs.campaignContextLoading = false;
  state.requestUpdate?.();
}

async function nameForCampaign(
  client: GatewayBrowserClient,
  id: string,
): Promise<string> {
  try {
    const r = (await client.request("campaigns.get", { id })) as any;
    return r?.campaign?.name ?? id;
  } catch {
    return id;
  }
}
