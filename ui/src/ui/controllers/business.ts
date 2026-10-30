/**
 * Business Controller — multi-business state + Notion page content fetching.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { ClientsState } from "./clients";

// ── Types ────────────────────────────────────────────────────

export interface BusinessProfile {
  id: string;
  name: string;
  industry: string;
  plan: string;
  planNotionUrl: string | null;
  planContent: string | null;
  planContentFetchedAt: number | null;
  context: string;
  notionDatabaseId: string | null;
  notionDatabaseName: string | null;
  /**
   * Notion database the CRM (clients + leads) reads from for this business.
   * Distinct from `notionDatabaseId` (which is the business *profile* /
   * plan database). Switching the active business should swap the CRM DB
   * the clients & leads views talk to. Null when the user hasn't connected
   * a CRM database yet.
   */
  crmDatabaseId: string | null;
  crmDatabaseName: string | null;
  /**
   * Top Priorities — ordered list of kanban project ids the user pinned
   * as their focus list (max 5). Persisted on the gateway so the choice
   * survives a server restart; the lib/priorities helpers keep an in-memory
   * mirror on this profile object so renders stay synchronous.
   */
  priorities: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BusinessProfileForm {
  name: string;
  industry: string;
  plan: string;
  planNotionUrl: string;
  context: string;
}

export interface NotionDatabase {
  id: string;
  title: string;
  icon: string | null;
  url: string;
  createdTime: string;
}

export interface IncomeMonthlyPoint { label: string; value: number }
export interface IncomeTransaction {
  id: string;
  amount: number;
  source?: string;
  description?: string;
  date: string;
}
export interface IncomeStats {
  today: number;
  week: number;
  month: number;
  year: number;
  allTime: number;
  monthlyData: IncomeMonthlyPoint[];
  recentTransactions: IncomeTransaction[];
  prevMonth?: number;
}

/**
 * Per-business workspace cache: row counts, role mappings, and pack catalogue
 * shown in the Workspace section. The view loader populates this; the page
 * re-renders after each fetch.
 */
export interface WorkspaceState {
  loading: boolean;
  error: string | null;
  /** businessId we last loaded for; if it changes, reload. */
  loadedFor: string | null;
  /** Resolved system-role panels with row counts under the active business. */
  panels: Array<{
    role: string;
    databaseId: string;
    databaseSlug: string;
    name: string;
    icon: string | null;
    rowCount: number;
    /** Group bucket for visual layout — derived from role. */
    group: "crm" | "sales" | "operations" | "service" | "agency" | "core" | "other";
  }>;
  /** Custom (user-created) databases not bound to any system role. */
  customDatabases: Array<{
    databaseId: string;
    databaseSlug: string;
    name: string;
    icon: string | null;
    rowCount: number;
  }>;
  /** Pack catalogue from business.packs.list. */
  packs: Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    databaseRoles: string[];
  }>;
  /** Pack id currently being installed (null when idle). */
  installingPackId: string | null;
  /**
   * Wall-clock ms when the last successful load completed. Drives the
   * "refreshed Xm ago" stale-data badge in the workspace header so the
   * user can tell when row counts / pack catalogue might be lagging.
   */
  lastLoadedAt: number | null;
}

export interface BusinessState {
  loading: boolean;
  saving: boolean;
  error: string | null;
  success: string | null;
  // Multi-business
  businesses: BusinessProfile[];
  activeBusinessId: string | null;
  // Form for active business
  profileForm: BusinessProfileForm;
  // Notion page content
  planContentLoading: boolean;
  planContentPreview: string | null;
  // Notion integration
  notionConnected: boolean;
  notionDatabases: NotionDatabase[];
  notionDatabasesLoading: boolean;
  notionSelectedDbId: string | null;
  notionSyncStatus: { syncing: boolean; lastSync: number | null; error: string | null } | null;
  notionCreateLoading: boolean;
  // UI state
  showNotionPicker: boolean;
  showCreateDialog: boolean;
  showDeleteConfirm: string | null;
  activeSection: "profile" | "notion" | "plan" | "clients" | "brand" | "overview" | "workspace" | "settings";
  /**
   * Cached panel data for the per-business Workspace section. Populated
   * lazily by loadWorkspace() in views/business-workspace.ts; shape lives
   * there because it's purely a UI concern.
   */
  workspaceState?: WorkspaceState | null;
  /**
   * Cached recent kanban projects + tasks for the home command-center
   * activity feed. Loader is lazy and re-uses the same payload until the
   * user explicitly reloads the home.
   */
  recentKanban?: {
    projects: Array<{
      id: string;
      name: string;
      status: string | null;
      updatedAt: number | null;
      businessId?: string | null;
      // Cash-flow tracking — feeds the home KPI strip's Paid + Pending tiles
      // and the input fields in the project detail modal. Dates are optional;
      // when set they scope the amount to a calendar month.
      pendingPay?: number | null;
      paidAmount?: number | null;
      pendingPayDate?: string | null;
      paidAmountDate?: string | null;
      active?: boolean;
    }>;
    tasks: Array<{
      id: string;
      title: string;
      status: string | null;
      projectId: string | null;
      updatedAt: number | null;
      /** "low" | "normal" | "high" | "critical" — used for the home task-board's
       *  group-by-priority and the priority chip on each card. */
      priority: string | null;
      /** ISO date string (yyyy-mm-dd) — surfaces overdue / due-soon hints on
       *  the home task-board. Stored as a string so the dashboard renderer
       *  can display it without re-parsing. */
      dueDate: string | null;
    }>;
    loadedAt: number;
  } | null;
  /**
   * True while a `loadRecentKanban` request is in flight. Used by the
   * home Top Priorities + Incomplete Tasks panels to render shimmer
   * skeletons instead of an empty state on cold-start. Set on entry and
   * cleared in the loader's `finally` block.
   */
  recentKanbanLoading?: boolean;
  /**
   * How the home task-board groups its incomplete-tasks columns. Persisted
   * to localStorage by the renderer so the user's choice survives reloads.
   */
  taskBoardGroupBy: "status" | "project" | "priority";
  /**
   * Whether the home task-board includes done tasks (and a Done column).
   * Persisted to localStorage. Default off so the user's "what's left to
   * do" view stays focused.
   */
  taskBoardShowDone: boolean;
  /**
   * Detail modal for the home command-center: which kind of row (project
   * or task) is open and its id. Cleared (set to null) on close.
   */
  homeDetailModal: { kind: "project" | "task"; id: string } | null;
  /**
   * AI Context Memory — per-business markdown pages stored as notes with
   * category `ai-context:<businessId>`. Mirrors the notes editor pattern;
   * inherits Notion sync for free when the user has configured it.
   * Lazy-init: created on first `loadContextMemory` call.
   */
  context: ContextMemoryState | null;
  /** Cached aggregated summary — pages, leads, KPIs, brand, assets per business. */
  summary: BusinessSummary | null;
  summaryLoading: boolean;
  summaryLoadedAt: number | null;
  searchQuery: string;
  _clientsState: ClientsState | null;
  // ── Live data feeds ──────────────────────────────────────
  incomeStats: IncomeStats | null;
  incomeLoading: boolean;
  incomeLoadedAt: number | null;
  // Provider-key + manual-log UI state
  incomeConfig: IncomeProviderConfig | null;
  incomeConfigDraft: { whop: string; whopCompanyId: string; stripe: string; square: string; squareEnv: "production" | "sandbox" };
  incomeConfigOpen: boolean;
  incomeSyncBusy: "whop" | "stripe" | "square" | null;
  incomeLogOpen: boolean;
  incomeLogDraft: { amount: string; source: string; description: string; date: string };
  incomeLogBusy: boolean;
  /**
   * UI state for the home Top Priorities section. The actual priority list
   * (ordered project ids per business) lives in localStorage via
   * `lib/priorities` so it survives reloads without a server round-trip.
   */
  priorityPickerOpen: boolean;
  /** Index of the priority card currently being dragged, or null. */
  draggingPriorityIndex: number | null;
  /** Index the dragged card would land on if dropped, for hover styling. */
  priorityDropTarget: number | null;
  /** Whether the Active Projects section is collapsed by the user. */
  activeProjectsHidden?: boolean;
}

// ── AI Context Memory (notes-backed, per-business scoped) ───
//
// Each entry is a markdown "page" the user can attach to their business so
// the agent has durable, hand-curated context. We piggyback on the existing
// notes.* gateway methods + Notion sync — entries live under category
// `ai-context:<businessId>`, which both scopes them per-business and keeps
// them out of the general notes view.

export interface ContextMemoryItem {
  id: string;
  name: string;
  preview: string;
  category: string;
  tags?: string[];
  updatedAt: string;
  notionPageId?: string;
  notionSyncedAt?: string;
}

export interface ContextMemoryFull extends ContextMemoryItem {
  body: string;
}

export interface ContextMemoryState {
  entries: ContextMemoryItem[];
  loading: boolean;
  /** Business id the cached entries were loaded for; lets us re-fetch on switch. */
  loadedForBusinessId: string | null;
  selected: ContextMemoryFull | null;
  editorOpen: boolean;
  isNew: boolean;
  editorTitle: string;
  editorBody: string;
  /** Markdown view (false = rendered preview, true = raw textarea). */
  editing: boolean;
  dirty: boolean;
  saving: boolean;
  notionSyncing: boolean;
  error: string | null;
}

export function createInitialContextMemoryState(): ContextMemoryState {
  return {
    entries: [],
    loading: false,
    loadedForBusinessId: null,
    selected: null,
    editorOpen: false,
    isNew: false,
    editorTitle: "",
    editorBody: "",
    editing: false,
    dirty: false,
    saving: false,
    notionSyncing: false,
    error: null,
  };
}

/** Category string used to scope context-memory notes to a business. */
export function contextCategoryFor(businessId: string): string {
  return `ai-context:${businessId}`;
}

export interface BusinessSummary {
  businessId: string;
  business: { id: string; name: string; tagline?: string | null; logo?: string | null; industry?: string | null } | null;
  pages: {
    total: number;
    published: number;
    draft: number;
    archived: number;
    recent: Array<{ id: string; name: string; slug: string; status: string; updatedAt: string }>;
  };
  leads: {
    total: number;
    byPage: Record<string, number>;
    byForm: Record<string, number>;
    lastSubmittedAtMs?: number;
    recent: Array<{ id: string; pageId: string; formId: string; receivedAtMs: number; data: Record<string, unknown> }>;
  };
  kpi: {
    views: number;
    uniqueSessions: number;
    formSubmits: number;
    ctaClicks: number;
    conversion: number;
  };
  brand: {
    hasBranding: boolean;
    primaryColor?: string;
    accentColor?: string;
    fontHeading?: string;
    fontBody?: string;
    assetCount: number;
  };
  assets: {
    total: number;
    bytes: number;
    byKind: { images: number; videos: number; audio: number; docs: number; other: number };
    recent: Array<{ name: string; relPath: string; bytes: number; modifiedAtMs: number; kind: string }>;
    rootPaths: string[];
  };
  pending: {
    projects: { available: false; reason: string };
    schedule: { available: false; reason: string };
    databases: { available: false; reason: string };
  };
}

export interface IncomeProviderConfig {
  whop: { configured: boolean; hint: string | null };
  whopCompanyId: string | null;
  stripe: { configured: boolean; hint: string | null };
  square: { configured: boolean; hint: string | null };
  squareEnv: "production" | "sandbox";
  lastSync: { whop: string | null; stripe: string | null; square: string | null };
}

// ── Initialization ───────────────────────────────────────────

export function createInitialBusinessState(): BusinessState {
  return {
    loading: false,
    saving: false,
    error: null,
    success: null,
    businesses: [],
    activeBusinessId: null,
    profileForm: { name: "", industry: "", plan: "", planNotionUrl: "", context: "" },
    planContentLoading: false,
    planContentPreview: null,
    notionConnected: false,
    notionDatabases: [],
    notionDatabasesLoading: false,
    notionSelectedDbId: null,
    notionSyncStatus: null,
    notionCreateLoading: false,
    showNotionPicker: false,
    showCreateDialog: false,
    showDeleteConfirm: null,
    activeSection: "profile",
    searchQuery: "",
    _clientsState: null,
    summary: null,
    summaryLoading: false,
    summaryLoadedAt: null,
    incomeStats: null,
    incomeLoading: false,
    incomeLoadedAt: null,
    incomeConfig: null,
    incomeConfigDraft: { whop: "", whopCompanyId: "", stripe: "", square: "", squareEnv: "production" },
    incomeConfigOpen: false,
    incomeSyncBusy: null,
    incomeLogOpen: false,
    incomeLogDraft: {
      amount: "",
      source: "custom",
      description: "",
      date: new Date().toISOString().slice(0, 10),
    },
    incomeLogBusy: false,
    priorityPickerOpen: false,
    draggingPriorityIndex: null,
    priorityDropTarget: null,
    recentKanbanLoading: false,
    taskBoardGroupBy: readTaskBoardGroupBy(),
    taskBoardShowDone: readTaskBoardShowDone(),
    homeDetailModal: null,
    context: null,
  };
}

// ── AI Context Memory API ───────────────────────────────────
//
// All functions are no-ops when no business is active (we have nowhere to
// scope the entries). Each one ensures the inner `context` state exists
// before touching it so the panel can be opened on a fresh load without a
// separate init call.

function ensureContextState(bs: BusinessState): ContextMemoryState {
  if (!bs.context) bs.context = createInitialContextMemoryState();
  return bs.context;
}

export async function loadContextMemory(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts?: { force?: boolean },
): Promise<void> {
  const bs = state.businessState;
  if (!bs?.activeBusinessId) return;
  const ctx = ensureContextState(bs);
  if (!opts?.force && ctx.loadedForBusinessId === bs.activeBusinessId && !ctx.loading) {
    return;
  }
  ctx.loading = true;
  ctx.error = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("notes.list", {
      category: contextCategoryFor(bs.activeBusinessId),
    })) as { notes?: ContextMemoryItem[] };
    ctx.entries = res?.notes ?? [];
    ctx.loadedForBusinessId = bs.activeBusinessId;
  } catch (e) {
    ctx.error = e instanceof Error ? e.message : String(e);
  } finally {
    ctx.loading = false;
    state.requestUpdate?.();
  }
}

export async function selectContextEntry(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string,
): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;
  const ctx = ensureContextState(bs);
  ctx.error = null;
  ctx.editorOpen = true;
  ctx.isNew = false;
  ctx.editing = false;
  ctx.dirty = false;
  // Optimistic: show the title from the list while the full body loads.
  const stub = ctx.entries.find((e) => e.id === id);
  if (stub) {
    ctx.editorTitle = stub.name;
    ctx.editorBody = "";
    ctx.selected = { ...stub, body: "" };
  }
  state.requestUpdate?.();
  try {
    const full = (await client.request("notes.get", { id })) as ContextMemoryFull;
    ctx.selected = full;
    ctx.editorTitle = full.name;
    ctx.editorBody = full.body ?? "";
  } catch (e) {
    ctx.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

export function startNewContextEntry(state: AppViewState): void {
  const bs = state.businessState;
  if (!bs?.activeBusinessId) return;
  const ctx = ensureContextState(bs);
  ctx.selected = null;
  ctx.isNew = true;
  ctx.editorOpen = true;
  ctx.editing = true;
  ctx.editorTitle = "";
  ctx.editorBody = "";
  ctx.dirty = false;
  ctx.error = null;
  state.requestUpdate?.();
}

export function closeContextEditor(state: AppViewState): void {
  const bs = state.businessState;
  if (!bs?.context) return;
  bs.context.editorOpen = false;
  bs.context.selected = null;
  bs.context.isNew = false;
  bs.context.editing = false;
  bs.context.dirty = false;
  bs.context.editorTitle = "";
  bs.context.editorBody = "";
  state.requestUpdate?.();
}

export function updateContextEditor(
  state: AppViewState,
  patch: { title?: string; body?: string; editing?: boolean },
): void {
  const bs = state.businessState;
  if (!bs?.context) return;
  const ctx = bs.context;
  if (patch.title !== undefined) { ctx.editorTitle = patch.title; ctx.dirty = true; }
  if (patch.body !== undefined) { ctx.editorBody = patch.body; ctx.dirty = true; }
  if (patch.editing !== undefined) ctx.editing = patch.editing;
  state.requestUpdate?.();
}

export async function saveContextEntry(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const bs = state.businessState;
  if (!bs?.activeBusinessId || !bs.context) return;
  const ctx = bs.context;
  const title = ctx.editorTitle.trim();
  if (!title) {
    ctx.error = "Title is required.";
    state.requestUpdate?.();
    return;
  }
  ctx.saving = true;
  ctx.error = null;
  state.requestUpdate?.();
  try {
    const category = contextCategoryFor(bs.activeBusinessId);
    if (ctx.isNew) {
      const created = (await client.request("notes.create", {
        name: title,
        body: ctx.editorBody,
        category,
      })) as ContextMemoryFull;
      ctx.selected = created;
      ctx.isNew = false;
    } else if (ctx.selected) {
      const updated = (await client.request("notes.update", {
        id: ctx.selected.id,
        name: title,
        body: ctx.editorBody,
        category,
      })) as ContextMemoryFull;
      ctx.selected = updated;
    }
    ctx.dirty = false;
    ctx.editing = false;
    // Refresh the entry list so the sidebar reflects the new/updated entry.
    await loadContextMemory(state, client, { force: true });
  } catch (e) {
    ctx.error = e instanceof Error ? e.message : String(e);
  } finally {
    ctx.saving = false;
    state.requestUpdate?.();
  }
}

export async function deleteContextEntry(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string,
): Promise<void> {
  const bs = state.businessState;
  if (!bs?.context) return;
  const ctx = bs.context;
  // Optimistic remove; restore on failure.
  const idx = ctx.entries.findIndex((e) => e.id === id);
  const removed = idx >= 0 ? ctx.entries.splice(idx, 1)[0] : null;
  if (ctx.selected?.id === id) {
    ctx.selected = null;
    ctx.editorOpen = false;
  }
  state.requestUpdate?.();
  try {
    await client.request("notes.delete", { id });
  } catch (e) {
    ctx.error = e instanceof Error ? e.message : String(e);
    if (removed) ctx.entries.splice(idx, 0, removed);
    state.requestUpdate?.();
  }
}

export async function syncContextToNotion(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const bs = state.businessState;
  if (!bs?.context) return;
  const ctx = bs.context;
  ctx.notionSyncing = true;
  ctx.error = null;
  state.requestUpdate?.();
  try {
    // notion.sync is the global trigger — it walks every system-role-mapped
    // database (notes included) and pushes/pulls. After it settles we re-pull
    // the entry list so the user sees any new notionPageId / notionSyncedAt
    // values that came back.
    await client.request("notion.sync", {});
    await loadContextMemory(state, client, { force: true });
  } catch (e) {
    ctx.error = e instanceof Error ? e.message : String(e);
  } finally {
    ctx.notionSyncing = false;
    state.requestUpdate?.();
  }
}

// ── Task-board group-by persistence ──────────────────────────
// localStorage-backed so the user's chosen grouping (status/project/priority)
// survives reloads and tab-switches. Inline + tiny so it doesn't earn a
// separate module like biz-filter — the only consumer is the home view.
const TASK_BOARD_GROUP_BY_KEY = "infinibot:home-task-board-groupby:v1";
type TaskBoardGroupBy = "status" | "project" | "priority";
function readTaskBoardGroupBy(): TaskBoardGroupBy {
  try {
    if (typeof window === "undefined") return "status";
    const v = window.localStorage.getItem(TASK_BOARD_GROUP_BY_KEY);
    return v === "project" || v === "priority" ? v : "status";
  } catch {
    return "status";
  }
}
export function setTaskBoardGroupBy(state: AppViewState, next: TaskBoardGroupBy): void {
  const bs = state.businessState;
  if (!bs) return;
  bs.taskBoardGroupBy = next;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(TASK_BOARD_GROUP_BY_KEY, next);
  } catch { /* storage unavailable — keep in-memory */ }
  state.requestUpdate?.();
}

// ── Task-board show-done persistence ─────────────────────────
// Same shape as the group-by helper: localStorage-backed, default off.
const TASK_BOARD_SHOW_DONE_KEY = "infinibot:home-task-board-showdone:v1";
function readTaskBoardShowDone(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(TASK_BOARD_SHOW_DONE_KEY) === "1";
  } catch {
    return false;
  }
}
export function setTaskBoardShowDone(state: AppViewState, next: boolean): void {
  const bs = state.businessState;
  if (!bs) return;
  bs.taskBoardShowDone = next;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TASK_BOARD_SHOW_DONE_KEY, next ? "1" : "0");
    }
  } catch { /* storage unavailable — keep in-memory */ }
  state.requestUpdate?.();
}

/**
 * Pull the per-business overview aggregate (pages + leads + KPIs + brand +
 * assets) for the active business. Cheap to call — server walks the
 * landing-pages, lead-router, analytics, branding, and per-business asset
 * dirs in parallel.
 */
export async function loadBusinessSummary(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts?: { force?: boolean },
): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;
  if (!bs.activeBusinessId) return;
  // Cache for 30s unless forced.
  const fresh = bs.summaryLoadedAt && Date.now() - bs.summaryLoadedAt < 30_000 && bs.summary?.businessId === bs.activeBusinessId;
  if (fresh && !opts?.force) return;
  bs.summaryLoading = true;
  state.requestUpdate?.();
  try {
    const summary = (await client.request("business.summary", {
      businessId: bs.activeBusinessId,
    })) as BusinessSummary;
    bs.summary = summary;
    bs.summaryLoadedAt = Date.now();
  } catch (err) {
    console.warn("[business] summary load failed:", err);
  } finally {
    bs.summaryLoading = false;
    state.requestUpdate?.();
  }
}

/** Fetch the provider-key configuration summary so the UI shows what's set. */
export async function loadIncomeConfig(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;
  try {
    const res = (await client.request("business.income.config.get", {
      businessId: bs.activeBusinessId ?? undefined,
    })) as IncomeProviderConfig;
    bs.incomeConfig = res;
    state.requestUpdate?.();
  } catch (err) {
    console.warn("[business] income.config.get failed:", err);
  }
}

/** Persist updated provider keys + Square env. Empty string clears a key. */
export async function saveIncomeConfig(
  state: AppViewState,
  client: GatewayBrowserClient,
  patch: Partial<{ whop: string; whopCompanyId: string; stripe: string; square: string; squareEnv: "production" | "sandbox" }>,
): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;
  try {
    await client.request("business.income.config.set", {
      ...patch,
      businessId: bs.activeBusinessId ?? undefined,
    });
    await loadIncomeConfig(state, client);
    bs.success = "Income provider config saved.";
    state.requestUpdate?.();
    setTimeout(() => { if (bs.success === "Income provider config saved.") { bs.success = null; state.requestUpdate?.(); } }, 3000);
  } catch (err) {
    bs.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
  }
}

/** Trigger a provider sync; refreshes income stats + config on success. */
export async function syncIncomeProvider(
  state: AppViewState,
  client: GatewayBrowserClient,
  provider: "whop" | "stripe" | "square",
): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;
  bs.incomeSyncBusy = provider;
  bs.error = null;
  state.requestUpdate?.();
  try {
    const method = provider === "whop"
      ? "business.income.syncWhop"
      : provider === "stripe"
        ? "business.income.syncStripe"
        : "business.income.syncSquare";
    const res = (await client.request(method, {
      businessId: bs.activeBusinessId ?? undefined,
    })) as { added?: number; total?: number };
    bs.success = `Synced ${provider} — +${res.added ?? 0} new (of ${res.total ?? 0}).`;
    setTimeout(() => { if (bs.success?.startsWith(`Synced ${provider}`)) { bs.success = null; state.requestUpdate?.(); } }, 3500);
    // Income totals just changed → drop the summary cache so the overview
    // tab and home KPI strip refetch on next render.
    bs.summary = null;
    bs.summaryLoadedAt = null;
    await loadIncomeStats(state, client, { force: true });
    await loadIncomeConfig(state, client);
  } catch (err) {
    bs.error = err instanceof Error ? err.message : String(err);
    state.requestUpdate?.();
  } finally {
    bs.incomeSyncBusy = null;
    state.requestUpdate?.();
  }
}

/**
 * Load the most recent kanban projects + tasks for the Command Center
 * activity feed and the workspace's linked-projects panel. Cached for 30s
 * so flipping between home and workspace doesn't refetch on every render;
 * the cache is dropped wholesale by `invalidateBusinessCaches` when the
 * active business switches, and (separately) by the kanban controller
 * when a project's businessId changes — that way the linked-projects
 * panel reflects an assignment without waiting for the TTL to expire.
 */
export async function loadRecentKanban(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts: { force?: boolean } = {},
): Promise<void> {
  const bs = state.businessState;
  if (!bs || !client) return;
  const fresh = bs.recentKanban && Date.now() - bs.recentKanban.loadedAt < 30_000;
  if (fresh && !opts.force) return;
  // Mark loading so panels can render skeletons while the request is in
  // flight. Only request a re-render here when the cache is empty —
  // already-populated panels keep their content visible during refresh
  // (no UI flicker) and only flip to skeletons on the cold-start path.
  bs.recentKanbanLoading = true;
  if (!bs.recentKanban) state.requestUpdate?.();
  try {
    const [projectsResp, tasksResp] = (await Promise.all([
      client.request("kanban.projects.list", {}),
      client.request("kanban.tasks.list", {}),
    ])) as [unknown, unknown];
    const projectsArr = Array.isArray(projectsResp) ? projectsResp : [];
    const tasksArr = Array.isArray(tasksResp) ? tasksResp : [];
    bs.recentKanban = {
      projects: projectsArr.map((p: any) => ({
        id: String(p.id ?? ""),
        name: String(p.name ?? p.title ?? "Untitled"),
        status: p.status ?? null,
        updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : null,
        businessId: p.businessId ?? null,
        pendingPay: typeof p.pendingPay === "number" ? p.pendingPay : null,
        paidAmount: typeof p.paidAmount === "number" ? p.paidAmount : null,
        pendingPayDate: typeof p.pendingPayDate === "string" ? p.pendingPayDate : null,
        paidAmountDate: typeof p.paidAmountDate === "string" ? p.paidAmountDate : null,
        active: p.active === true,
      })),
      tasks: tasksArr.map((t: any) => ({
        id: String(t.id ?? ""),
        title: String(t.title ?? t.name ?? "Untitled"),
        status: t.status ?? null,
        projectId: t.projectId ?? null,
        updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : null,
        // priority + dueDate feed the home task-board's group/sort logic.
        // Tasks coming from Notion may carry "Priority Level" only (with
        // values like "Immediate"/"High"/...), so fall back to that when
        // the canonical lowercase priority isn't set.
        priority: typeof t.priority === "string"
          ? t.priority
          : typeof t.priorityLevel === "string"
            ? t.priorityLevel.toLowerCase()
            : null,
        dueDate: typeof t.dueDate === "string" ? t.dueDate : null,
      })),
      loadedAt: Date.now(),
    };
    // No auto-prune of priorities here. Pinned project ids stay until the
    // user explicitly removes them — a transient empty kanban list (e.g.
    // because the gateway just restarted, or Notion was momentarily
    // unreachable) shouldn't be allowed to wipe a multi-week focus list.
    // The renderer falls back to "Loading…" / "Untitled project" labels
    // when an id can't be resolved against the current kanban cache.
  } catch {
    // Silently swallow — the home + workspace gracefully empty their
    // kanban-derived sections. Empty state already covers no-data.
    bs.recentKanban = bs.recentKanban ?? { projects: [], tasks: [], loadedAt: Date.now() };
  } finally {
    bs.recentKanbanLoading = false;
    state.requestUpdate?.();
  }
}

/** Manually log an income entry — for cash, transfers, or other custom sources. */
export async function logIncomeEntry(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;
  const draft = bs.incomeLogDraft;
  const amount = Number.parseFloat(draft.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    bs.error = "Amount must be a positive number.";
    state.requestUpdate?.();
    return;
  }
  bs.incomeLogBusy = true;
  bs.error = null;
  state.requestUpdate?.();
  try {
    await client.request("business.income.log", {
      amount,
      source: draft.source.trim() || "custom",
      description: draft.description.trim(),
      date: draft.date ? new Date(draft.date).toISOString() : new Date().toISOString(),
      businessId: bs.activeBusinessId ?? undefined,
    });
    bs.incomeLogOpen = false;
    bs.incomeLogDraft = {
      amount: "",
      source: "custom",
      description: "",
      date: new Date().toISOString().slice(0, 10),
    };
    bs.success = `Logged ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount)}.`;
    setTimeout(() => { if (bs.success?.startsWith("Logged ")) { bs.success = null; state.requestUpdate?.(); } }, 3000);
    await loadIncomeStats(state, client, { force: true });
  } catch (err) {
    bs.error = err instanceof Error ? err.message : String(err);
  } finally {
    bs.incomeLogBusy = false;
    state.requestUpdate?.();
  }
}

/**
 * Load real income stats (totals + monthly chart + recent transactions) from
 * the gateway. Backs the Command Center's revenue tile, chart, and the
 * "recent income" rows in the activity feed. Cached for 60s so re-rendering
 * the page doesn't re-fetch needlessly.
 */
export async function loadIncomeStats(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts: { force?: boolean } = {},
): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;
  const stale = !bs.incomeLoadedAt || Date.now() - bs.incomeLoadedAt > 60_000;
  if (!opts.force && !stale) return;
  if (bs.incomeLoading) return;
  bs.incomeLoading = true;
  state.requestUpdate?.();
  try {
    const res = (await client.request("business.income.stats", {
      businessId: bs.activeBusinessId ?? undefined,
    })) as {
      today?: number; week?: number; month?: number; year?: number; allTime?: number;
      monthlyData?: Array<{ label?: string; month?: string; value?: number }>;
      recentTransactions?: Array<Record<string, unknown>>;
    };
    const monthly = (res.monthlyData ?? []).map((m) => ({
      label: String(m.label ?? m.month ?? ""),
      value: typeof m.value === "number" ? m.value : 0,
    }));
    // Use the previous-but-one entry as last-month baseline so the
    // "vs last month" comparison is meaningful even mid-month.
    const prevMonth = monthly.length >= 2 ? monthly[monthly.length - 2].value : 0;
    bs.incomeStats = {
      today: res.today ?? 0,
      week: res.week ?? 0,
      month: res.month ?? 0,
      year: res.year ?? 0,
      allTime: res.allTime ?? 0,
      monthlyData: monthly,
      recentTransactions: (res.recentTransactions ?? []).map((t) => ({
        id: String(t.id ?? ""),
        amount: typeof t.amount === "number" ? t.amount : 0,
        source: typeof t.source === "string" ? t.source : undefined,
        description: typeof t.description === "string" ? t.description : undefined,
        date: typeof t.date === "string" ? t.date : new Date().toISOString(),
      })),
      prevMonth,
    };
    bs.incomeLoadedAt = Date.now();
  } catch (err) {
    // Income store is missing on a fresh install — surface zeros instead of
    // an error so the panel still renders.
    bs.incomeStats = {
      today: 0, week: 0, month: 0, year: 0, allTime: 0,
      monthlyData: [], recentTransactions: [], prevMonth: 0,
    };
    bs.incomeLoadedAt = Date.now();
    console.warn("[business] income.stats failed:", err);
  } finally {
    bs.incomeLoading = false;
    state.requestUpdate?.();
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Defensive normalizer — gateway responses may pre-date the per-business
 * CRM split (`crmDatabaseId`) so we backfill defaults so the rest of the
 * UI can read those fields without `?? null` everywhere. Database ids must
 * come from the gateway profile/config; an unconnected profile stays null.
 */
export function normalizeBusinessProfile(raw: any): BusinessProfile {
  const profile: BusinessProfile = {
    id: String(raw?.id ?? ""),
    name: String(raw?.name ?? ""),
    industry: String(raw?.industry ?? ""),
    plan: String(raw?.plan ?? ""),
    planNotionUrl: raw?.planNotionUrl ?? null,
    planContent: raw?.planContent ?? null,
    planContentFetchedAt: raw?.planContentFetchedAt ?? null,
    context: String(raw?.context ?? ""),
    notionDatabaseId: raw?.notionDatabaseId ?? null,
    notionDatabaseName: raw?.notionDatabaseName ?? null,
    crmDatabaseId: raw?.crmDatabaseId ?? null,
    crmDatabaseName: raw?.crmDatabaseName ?? null,
    priorities: Array.isArray(raw?.priorities)
      ? raw.priorities.filter((x: unknown): x is string => typeof x === "string").slice(0, 5)
      : [],
    createdAt: String(raw?.createdAt ?? ""),
    updatedAt: String(raw?.updatedAt ?? ""),
  };
  return profile;
}

function normalizeBusinessList(raw: any[] | undefined): BusinessProfile[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeBusinessProfile);
}

/** Convenience accessor — returns the active business profile or null. */
export function activeBusinessProfile(bs: BusinessState | null | undefined): BusinessProfile | null {
  if (!bs?.activeBusinessId) return null;
  return bs.businesses.find((b) => b.id === bs.activeBusinessId) ?? null;
}

function clearMessages(bs: BusinessState) { bs.error = null; bs.success = null; }

function showSuccess(bs: BusinessState, msg: string, state?: AppViewState) {
  bs.success = msg;
  state?.requestUpdate?.();
  setTimeout(() => { if (bs.success === msg) { bs.success = null; state?.requestUpdate?.(); } }, 4000);
}

function populateForm(bs: BusinessState, biz: BusinessProfile) {
  bs.profileForm = {
    name: biz.name,
    industry: biz.industry,
    plan: biz.plan,
    planNotionUrl: biz.planNotionUrl ?? "",
    context: biz.context,
  };
  bs.planContentPreview = biz.planContent ?? null;
  bs.notionConnected = !!biz.notionDatabaseId;
}

// ── Load ─────────────────────────────────────────────────────

export async function loadBusiness(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;

  bs.loading = true;
  clearMessages(bs);
  state.requestUpdate?.();

  try {
    const res = (await client.request("business.get", {})) as any;
    bs.businesses = normalizeBusinessList(res?.businesses);
    bs.activeBusinessId = res?.activeId ?? null;

    // Persisted biz-filter (localStorage) wins over the server-side
    // `activeId` when it matches an existing business. Without this, the
    // user's filter selection silently resets to the server's last-active
    // on every refresh — losing the choice they made in any dropdown.
    try {
      const { getBizFilter } = await import("../lib/biz-filter.js");
      const persistedFilter = getBizFilter();
      if (persistedFilter && bs.businesses.some((b) => b.id === persistedFilter)) {
        bs.activeBusinessId = persistedFilter;
      }
    } catch { /* lib/biz-filter unavailable in some test contexts */ }

    const profile = res?.profile ? normalizeBusinessProfile(res.profile) : null;
    if (profile) {
      // Replace the entry in `businesses` with the freshly-normalized one
      // so all consumers (clients, leads, sites pickers) see the same
      // crmDatabaseId backfill.
      const idx = bs.businesses.findIndex((b) => b.id === profile.id);
      if (idx >= 0) bs.businesses[idx] = profile;
      populateForm(bs, profile);
    }

    // Load notion status
    const statusRes = (await client.request("business.notion.status", {})) as any;
    if (statusRes) {
      bs.notionConnected = !!statusRes.connected;
      bs.notionSyncStatus = { syncing: false, lastSync: statusRes.lastSync ?? null, error: statusRes.syncError ?? null };
    }

    // Auto-fetch plan content if there's a Notion URL
    if (profile?.planNotionUrl && (!profile.planContent || Date.now() - (profile.planContentFetchedAt ?? 0) > 3600000)) {
      fetchPlanContent(state, client);
    }

    // Bind the shared biz-filter so picking a business from a Projects /
    // Leads / Databases view flips the Command Center too. Lives here
    // (initial mount) so we only register one subscriber per session.
    void subscribeBizFilterToBusinessSwitch(state, client);
  } catch (e) {
    bs.error = e instanceof Error ? e.message : String(e);
  }

  bs.loading = false;
  state.requestUpdate?.();
}

// ── Switch Business ──────────────────────────────────────────

/**
 * Drop every per-business cached payload so the next render of any tab
 * refetches against the new active business. Without this the user can
 * switch business while sitting on the home/profile tab and see stale
 * summary, workspace row counts, recent kanban, and recent leads from
 * the previous business until they manually navigate to each tab and
 * the per-tab `loadedFor`/`businessId` guards fire.
 */
export function invalidateBusinessCaches(bs: BusinessState): void {
  bs.summary = null;
  bs.summaryLoadedAt = null;
  bs.recentKanban = null;
  bs.incomeStats = null;
  bs.incomeLoadedAt = null;
  if (bs.workspaceState) {
    bs.workspaceState.loadedFor = null;
    bs.workspaceState.lastLoadedAt = null;
  }
}

export async function switchBusiness(state: AppViewState, client: GatewayBrowserClient, businessId: string): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;
  // No-op when we're already on this business — avoids a needless gateway
  // round-trip + cache invalidation when biz-filter subscribers re-fire on
  // the same id.
  if (bs.activeBusinessId === businessId) return;

  try {
    await client.request("business.setActive", { id: businessId });
    bs.activeBusinessId = businessId;
    invalidateBusinessCaches(bs);
    // Mirror to the shared biz-filter so Projects/Tasks/Leads/Databases
    // (which read from biz-filter, not from Command Center state) follow
    // along. Guarded so we don't pingpong with subscribeBizFilterToBusinessSwitch.
    try {
      const { setBizFilter } = await import("../lib/biz-filter.js");
      setBizFilter(businessId);
    } catch { /* harmless in test contexts */ }
    const biz = bs.businesses.find((b) => b.id === businessId);
    if (biz) {
      populateForm(bs, biz);
    }
    // Reload to get fresh Notion status
    const statusRes = (await client.request("business.notion.status", {})) as any;
    if (statusRes) {
      bs.notionConnected = !!statusRes.connected;
      bs.notionSyncStatus = { syncing: false, lastSync: statusRes.lastSync ?? null, error: statusRes.syncError ?? null };
    }
    // Income config + stats + summary are scoped per business — refresh in
    // parallel so the next render across any tab has fresh data.
    await Promise.all([
      loadIncomeConfig(state, client),
      loadIncomeStats(state, client, { force: true }),
      loadBusinessSummary(state, client, { force: true }),
    ]);
    state.requestUpdate?.();
  } catch (e) {
    bs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

/**
 * Bind the shared biz-filter (used by Projects, Tasks, Leads, Databases) to
 * the Command Center's active business so picking a business in any of
 * those views also flips the Command Center, and vice-versa. Called once
 * from loadBusiness on initial mount; safe to call again — it tears down
 * the prior subscription before re-binding.
 */
let _bizFilterUnsubscribe: (() => void) | null = null;
export async function subscribeBizFilterToBusinessSwitch(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  try {
    const { subscribeBizFilter, getBizFilter } = await import("../lib/biz-filter.js");
    if (_bizFilterUnsubscribe) {
      try { _bizFilterUnsubscribe(); } catch { /* noop */ }
      _bizFilterUnsubscribe = null;
    }
    _bizFilterUnsubscribe = subscribeBizFilter(() => {
      const bs = state.businessState;
      if (!bs) return;
      const next = getBizFilter();
      if (!next) return;
      if (next === bs.activeBusinessId) return;
      if (!bs.businesses.some((b) => b.id === next)) return;
      void switchBusiness(state, client, next);
    });
  } catch { /* lib/biz-filter unavailable in some test contexts */ }
}

// ── Create Business ──────────────────────────────────────────

export async function createBusiness(state: AppViewState, client: GatewayBrowserClient, name: string): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;

  try {
    const res = (await client.request("business.create", { name })) as any;
    bs.businesses = res?.businesses ? normalizeBusinessList(res.businesses) : bs.businesses;
    if (res?.profile) {
      const profile = normalizeBusinessProfile(res.profile);
      const idx = bs.businesses.findIndex((b) => b.id === profile.id);
      if (idx >= 0) bs.businesses[idx] = profile;
      bs.activeBusinessId = profile.id;
      populateForm(bs, profile);
      bs.notionConnected = false;
      bs.notionSyncStatus = null;
    }
    bs.showCreateDialog = false;
    showSuccess(bs, `Business "${name}" created`, state);
  } catch (e) {
    bs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ── Delete Business ──────────────────────────────────────────

export async function deleteBusiness(state: AppViewState, client: GatewayBrowserClient, businessId: string): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;

  try {
    const res = (await client.request("business.delete", { id: businessId })) as any;
    bs.businesses = res?.businesses ?? [];
    bs.activeBusinessId = res?.activeId ?? null;
    bs.showDeleteConfirm = null;

    const activeBiz = bs.businesses.find((b) => b.id === bs.activeBusinessId);
    if (activeBiz) {
      populateForm(bs, activeBiz);
    } else {
      bs.profileForm = { name: "", industry: "", plan: "", planNotionUrl: "", context: "" };
      bs.planContentPreview = null;
      bs.notionConnected = false;
    }
    showSuccess(bs, "Business deleted", state);
  } catch (e) {
    bs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ── Save Business ────────────────────────────────────────────

export async function saveBusiness(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const bs = state.businessState;
  if (!bs) return false;

  bs.saving = true;
  clearMessages(bs);
  state.requestUpdate?.();

  try {
    const res = (await client.request("business.save", {
      id: bs.activeBusinessId,
      name: bs.profileForm.name,
      industry: bs.profileForm.industry,
      plan: bs.profileForm.plan,
      planNotionUrl: bs.profileForm.planNotionUrl || null,
      context: bs.profileForm.context,
    })) as any;

    if (res?.profile) {
      // Update in businesses list
      const idx = bs.businesses.findIndex((b) => b.id === res.profile.id);
      if (idx >= 0) bs.businesses[idx] = res.profile;
      else bs.businesses.push(res.profile);
      bs.activeBusinessId = res.profile.id;
    }
    bs.saving = false;
    showSuccess(bs, "Business profile saved", state);
    return true;
  } catch (e) {
    bs.error = e instanceof Error ? e.message : String(e);
    bs.saving = false;
    state.requestUpdate?.();
    return false;
  }
}

// ── Fetch Notion Page Content ────────────────────────────────

export async function fetchPlanContent(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;

  const url = bs.profileForm.planNotionUrl?.trim();
  if (!url) return;

  bs.planContentLoading = true;
  state.requestUpdate?.();

  try {
    const res = (await client.request("business.notion.fetchPage", {
      url,
      businessId: bs.activeBusinessId,
    })) as any;

    bs.planContentPreview = res?.content ?? null;

    // Update the business in the list
    if (bs.activeBusinessId) {
      const biz = bs.businesses.find((b) => b.id === bs.activeBusinessId);
      if (biz) {
        biz.planContent = res?.content ?? null;
        biz.planContentFetchedAt = res?.fetchedAt ?? Date.now();
        biz.planNotionUrl = url;
      }
    }
  } catch (e) {
    bs.error = `Failed to fetch Notion page: ${e instanceof Error ? e.message : String(e)}`;
  }

  bs.planContentLoading = false;
  state.requestUpdate?.();
}

// ── Notion Database Operations ───────────────────────────────

export async function loadNotionDatabases(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const bs = state.businessState;
  if (!bs) return;
  bs.notionDatabasesLoading = true;
  clearMessages(bs);
  state.requestUpdate?.();
  try {
    const res = (await client.request("business.notion.databases", {})) as any;
    bs.notionDatabases = res?.databases ?? [];
    if (res?.error) bs.error = res.error;
  } catch (e) { bs.error = e instanceof Error ? e.message : String(e); }
  bs.notionDatabasesLoading = false;
  state.requestUpdate?.();
}

export async function createNotionDatabase(state: AppViewState, client: GatewayBrowserClient, name?: string, parentPageId?: string): Promise<boolean> {
  const bs = state.businessState;
  if (!bs) return false;
  bs.notionCreateLoading = true;
  clearMessages(bs);
  state.requestUpdate?.();
  try {
    const res = (await client.request("business.notion.create", {
      name: name || bs.profileForm.name || "InfiniBot Business",
      parentPageId,
      businessId: bs.activeBusinessId,
    })) as any;
    if (res?.profile) {
      const idx = bs.businesses.findIndex((b) => b.id === res.profile.id);
      if (idx >= 0) bs.businesses[idx] = res.profile;
      bs.notionConnected = true;
    }
    bs.notionCreateLoading = false;
    showSuccess(bs, "Notion database created and connected", state);
    return true;
  } catch (e) {
    bs.error = e instanceof Error ? e.message : String(e);
    bs.notionCreateLoading = false;
    state.requestUpdate?.();
    return false;
  }
}

export async function connectNotionDatabase(state: AppViewState, client: GatewayBrowserClient, databaseId: string, databaseName: string | null): Promise<boolean> {
  const bs = state.businessState;
  if (!bs) return false;
  clearMessages(bs);
  try {
    const res = (await client.request("business.notion.connect", {
      databaseId, databaseName, businessId: bs.activeBusinessId,
    })) as any;
    if (res?.profile) {
      const profile = normalizeBusinessProfile(res.profile);
      const idx = bs.businesses.findIndex((b) => b.id === profile.id);
      if (idx >= 0) bs.businesses[idx] = profile;
      bs.notionConnected = true;
    }
    bs.showNotionPicker = false;
    showSuccess(bs, `Connected to "${databaseName || databaseId}"`, state);
    return true;
  } catch (e) {
    bs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return false;
  }
}

export async function syncNotionDatabase(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const bs = state.businessState;
  if (!bs) return false;
  if (bs.notionSyncStatus) { bs.notionSyncStatus.syncing = true; bs.notionSyncStatus.error = null; }
  clearMessages(bs);
  state.requestUpdate?.();
  try {
    const res = (await client.request("business.notion.sync", { businessId: bs.activeBusinessId })) as any;
    if (bs.notionSyncStatus) { bs.notionSyncStatus.syncing = false; bs.notionSyncStatus.lastSync = res?.lastSync || Date.now(); }
    showSuccess(bs, "Synced to Notion", state);
    return true;
  } catch (e) {
    if (bs.notionSyncStatus) { bs.notionSyncStatus.syncing = false; bs.notionSyncStatus.error = e instanceof Error ? e.message : String(e); }
    bs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return false;
  }
}
