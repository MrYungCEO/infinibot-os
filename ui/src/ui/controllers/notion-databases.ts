/**
 * Universal Notion Database Manager — frontend controller.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

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

export interface NotionDatabaseEntry {
  id: string;
  databaseId: string;
  name: string;
  icon?: string;
  schema: NotionDbSchema;
  lastSync: number | null;
  addedAt: string;
  pageCount?: number;
}

export interface NotionPage {
  id: string;
  databaseId: string;
  data: Record<string, any>;
  createdTime: string;
  lastEditedTime: string;
}

export interface NotionBlock {
  id: string;
  type: string;
  hasChildren: boolean;
  children?: NotionBlock[];
  data: Record<string, any>;
}

export interface NotionDbManagerState {
  loading: boolean;
  error: string | null;
  success: string | null;
  // Database list
  databases: NotionDatabaseEntry[];
  selectedDbId: string | null;
  // Discovery
  discovering: boolean;
  discoveredDbs: { id: string; title: string; icon?: string; url?: string }[];
  showDiscoverDialog: boolean;
  addDbUrl: string;
  adding: boolean;
  // Pages for selected database
  pages: NotionPage[];
  schema: NotionDbSchema | null;
  pagesLoading: boolean;
  pulling: boolean;
  // View
  viewMode: "grid" | "table" | "kanban";
  kanbanGroupBy: string;
  searchQuery: string;
  sortBy: string;
  sortDir: "asc" | "desc";
  // Kanban DnD
  kanbanDragPageId: string | null;
  kanbanDragOverCol: string | null;
  // Detail panel
  showDetailPanel: boolean;
  detailPage: NotionPage | null;
  // Create/Edit
  showCreateDialog: boolean;
  showEditDialog: boolean;
  editingPage: NotionPage | null;
  formData: Record<string, any>;
  saving: boolean;
  // Delete
  showDeleteConfirm: string | null;
  // Blocks / Content
  blocks: NotionBlock[];
  blocksLoading: boolean;
  subPages: { id: string; title: string; type: string }[];
  blockBreadcrumb: { id: string; title: string }[];
  // Relations
  relationCache: Record<string, string>; // pageId -> title
  relationLoading: boolean;
  // Toggle state for collapsible blocks
  expandedToggles: Set<string>;
  // Internal: track which page blocks were loaded for
  _detailLoadedFor?: string;
}

// ── Initialization ───────────────────────────────────────────

export function createInitialNotionDbState(): NotionDbManagerState {
  return {
    loading: false,
    error: null,
    success: null,
    databases: [],
    selectedDbId: null,
    discovering: false,
    discoveredDbs: [],
    showDiscoverDialog: false,
    addDbUrl: "",
    adding: false,
    pages: [],
    schema: null,
    pagesLoading: false,
    pulling: false,
    viewMode: "grid",
    kanbanGroupBy: "",
    searchQuery: "",
    sortBy: "lastEditedTime",
    sortDir: "desc",
    kanbanDragPageId: null,
    kanbanDragOverCol: null,
    showDetailPanel: false,
    detailPage: null,
    showCreateDialog: false,
    showEditDialog: false,
    editingPage: null,
    formData: {},
    saving: false,
    showDeleteConfirm: null,
    blocks: [],
    blocksLoading: false,
    subPages: [],
    blockBreadcrumb: [],
    relationCache: {},
    relationLoading: false,
    expandedToggles: new Set(),
  };
}

// ── Helpers ──────────────────────────────────────────────────

function clearMessages(ns: NotionDbManagerState) {
  ns.error = null;
  ns.success = null;
}

function showSuccess(ns: NotionDbManagerState, msg: string, state?: AppViewState) {
  ns.success = msg;
  state?.requestUpdate?.();
  setTimeout(() => { if (ns.success === msg) { ns.success = null; state?.requestUpdate?.(); } }, 4000);
}

/** Get the title property name from schema */
export function getTitleProperty(schema: NotionDbSchema | null): string | null {
  if (!schema) return null;
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === "title") return name;
  }
  return null;
}

/** Get the display title of a page */
export function getPageTitle(page: NotionPage | null, schema: NotionDbSchema | null): string {
  if (!page?.data) return "Untitled";
  const titleProp = getTitleProperty(schema);
  if (titleProp && page.data[titleProp]) return String(page.data[titleProp]);
  for (const v of Object.values(page.data)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "Untitled";
}

/** Get properties that can be used as kanban grouping */
export function getGroupableProperties(schema: NotionDbSchema | null): NotionPropertySchema[] {
  if (!schema) return [];
  return Object.values(schema.properties).filter(
    (p) => p.type === "status" || p.type === "select" || p.type === "multi_select"
  );
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
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === "status") return name;
  }
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.type === "select") return name;
  }
  return "";
}

/** Filter pages by search query */
export function getFilteredPages(ns: NotionDbManagerState): NotionPage[] {
  let list = [...ns.pages];

  if (ns.searchQuery) {
    const q = ns.searchQuery.toLowerCase();
    list = list.filter((p) => {
      for (const v of Object.values(p.data ?? {})) {
        if (typeof v === "string" && v.toLowerCase().includes(q)) return true;
        if (Array.isArray(v) && v.some((item) => typeof item === "string" && item.toLowerCase().includes(q))) return true;
      }
      return false;
    });
  }

  // Sort
  list.sort((a, b) => {
    let cmp = 0;
    if (ns.sortBy === "lastEditedTime") {
      cmp = (a.lastEditedTime ?? "").localeCompare(b.lastEditedTime ?? "");
    } else if (ns.sortBy === "createdTime") {
      cmp = (a.createdTime ?? "").localeCompare(b.createdTime ?? "");
    } else {
      const va = a.data?.[ns.sortBy];
      const vb = b.data?.[ns.sortBy];
      if (typeof va === "string" && typeof vb === "string") cmp = va.localeCompare(vb);
      else if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else if (va && !vb) cmp = -1;
      else if (!va && vb) cmp = 1;
    }
    return ns.sortDir === "desc" ? -cmp : cmp;
  });

  return list;
}

/** Group pages by a property value (for kanban) */
export function getPagesByGroup(ns: NotionDbManagerState): Record<string, NotionPage[]> {
  const filtered = getFilteredPages(ns);
  const groupProp = ns.kanbanGroupBy || getDefaultGroupBy(ns.schema);
  const options = getGroupOptions(ns.schema, groupProp);
  const result: Record<string, NotionPage[]> = {};

  for (const opt of options) result[opt.name] = [];
  result["—"] = [];

  const propSchema = ns.schema?.properties[groupProp];
  const isMultiSelect = propSchema?.type === "multi_select";

  for (const p of filtered) {
    const val = p.data?.[groupProp];
    if (isMultiSelect && Array.isArray(val)) {
      if (val.length === 0) {
        result["—"].push(p);
      } else {
        for (const v of val) {
          if (!result[v]) result[v] = [];
          result[v].push(p);
        }
      }
    } else if (typeof val === "string" && val) {
      if (!result[val]) result[val] = [];
      result[val].push(p);
    } else {
      result["—"].push(p);
    }
  }

  return result;
}

// ── Load ─────────────────────────────────────────────────────

export async function loadDatabases(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ns = state.notionDbState;
  if (!ns) return;

  ns.loading = true;
  clearMessages(ns);
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.list", {})) as any;
    ns.databases = res?.databases ?? [];
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
  }

  ns.loading = false;
  state.requestUpdate?.();
}

/** Select a database and load its pages */
export async function selectDatabase(state: AppViewState, client: GatewayBrowserClient, dbId: string): Promise<void> {
  const ns = state.notionDbState;
  if (!ns) return;

  ns.selectedDbId = dbId;
  ns.pagesLoading = true;
  ns.showDetailPanel = false;
  ns.detailPage = null;
  clearMessages(ns);
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.pages.list", { databaseId: dbId })) as any;
    ns.pages = res?.pages ?? [];
    ns.schema = res?.schema ?? null;

    // Set default kanban groupBy
    if (!ns.kanbanGroupBy && ns.schema) {
      ns.kanbanGroupBy = getDefaultGroupBy(ns.schema);
    }
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
  }

  ns.pagesLoading = false;
  state.requestUpdate?.();
}

/** Connect a new database by URL */
export async function addDatabase(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const ns = state.notionDbState;
  if (!ns) return false;

  ns.adding = true;
  clearMessages(ns);
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.add", { url: ns.addDbUrl })) as any;
    if (res?.database) {
      ns.databases.push(res.database);
      ns.addDbUrl = "";
      ns.showDiscoverDialog = false;
      // Auto-select the new database
      ns.adding = false;
      state.requestUpdate?.();
      await selectDatabase(state, client, res.database.databaseId);
      showSuccess(ns, `Connected: ${res.database.name}`, state);
      return true;
    }
    ns.adding = false;
    state.requestUpdate?.();
    return false;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    ns.adding = false;
    state.requestUpdate?.();
    return false;
  }
}

/** Add a database directly by database ID (from discover) */
export async function addDatabaseById(state: AppViewState, client: GatewayBrowserClient, dbId: string): Promise<boolean> {
  const ns = state.notionDbState;
  if (!ns) return false;

  ns.adding = true;
  clearMessages(ns);
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.add", { url: dbId })) as any;
    if (res?.database) {
      ns.databases.push(res.database);
      ns.showDiscoverDialog = false;
      ns.adding = false;
      state.requestUpdate?.();
      await selectDatabase(state, client, res.database.databaseId);
      showSuccess(ns, `Connected: ${res.database.name}`, state);
      return true;
    }
    ns.adding = false;
    state.requestUpdate?.();
    return false;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    ns.adding = false;
    state.requestUpdate?.();
    return false;
  }
}

/** Remove a database */
export async function removeDatabase(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const ns = state.notionDbState;
  if (!ns) return;

  try {
    const res = (await client.request("notion.db.remove", { id })) as any;
    ns.databases = res?.databases ?? ns.databases.filter((d) => d.id !== id);
    const entry = ns.databases.find((d) => d.id === id);
    if (ns.selectedDbId && !ns.databases.find((d) => d.databaseId === ns.selectedDbId)) {
      ns.selectedDbId = ns.databases[0]?.databaseId ?? null;
      if (ns.selectedDbId) {
        await selectDatabase(state, client, ns.selectedDbId);
      } else {
        ns.pages = [];
        ns.schema = null;
      }
    }
    showSuccess(ns, "Database disconnected", state);
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

/** Refresh schema */
export async function refreshDatabase(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
  const ns = state.notionDbState;
  if (!ns) return;

  try {
    const res = (await client.request("notion.db.refresh", { id })) as any;
    if (res?.database) {
      const idx = ns.databases.findIndex((d) => d.id === id);
      if (idx >= 0) ns.databases[idx] = res.database;
      if (ns.selectedDbId === res.database.databaseId) {
        ns.schema = res.database.schema;
      }
    }
    showSuccess(ns, "Schema refreshed", state);
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

/** Pull pages from Notion */
export async function pullPages(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ns = state.notionDbState;
  if (!ns || !ns.selectedDbId) return;

  ns.pulling = true;
  clearMessages(ns);
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.pages.pull", { databaseId: ns.selectedDbId })) as any;
    ns.pages = res?.pages ?? [];
    if (res?.schema) ns.schema = res.schema;

    // Update database entry
    const entry = ns.databases.find((d) => d.databaseId === ns.selectedDbId);
    if (entry) {
      entry.lastSync = Date.now();
      entry.pageCount = ns.pages.length;
    }

    showSuccess(ns, `Pulled ${res?.count ?? 0} pages from Notion`, state);
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
  }

  ns.pulling = false;
  state.requestUpdate?.();
}

/** Create a new page */
export async function createPage(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const ns = state.notionDbState;
  if (!ns || !ns.selectedDbId) return false;

  ns.saving = true;
  clearMessages(ns);
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.pages.create", {
      databaseId: ns.selectedDbId,
      data: ns.formData,
    })) as any;

    if (res?.page) {
      ns.pages.push(res.page);
    }
    ns.showCreateDialog = false;
    ns.formData = {};
    ns.saving = false;
    showSuccess(ns, "Page created", state);
    return true;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    ns.saving = false;
    state.requestUpdate?.();
    return false;
  }
}

/** Update a page */
export async function updatePage(state: AppViewState, client: GatewayBrowserClient): Promise<boolean> {
  const ns = state.notionDbState;
  if (!ns || !ns.editingPage || !ns.selectedDbId) return false;

  ns.saving = true;
  clearMessages(ns);
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.pages.update", {
      pageId: ns.editingPage.id,
      databaseId: ns.selectedDbId,
      data: ns.formData,
    })) as any;

    if (res?.page) {
      const idx = ns.pages.findIndex((p) => p.id === res.page.id);
      if (idx >= 0) ns.pages[idx] = res.page;
      if (ns.detailPage?.id === res.page.id) ns.detailPage = res.page;
    }
    ns.showEditDialog = false;
    ns.editingPage = null;
    ns.formData = {};
    ns.saving = false;
    showSuccess(ns, "Page updated", state);
    return true;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    ns.saving = false;
    state.requestUpdate?.();
    return false;
  }
}

/** Quick property update (for DnD) */
export async function updatePageProperty(
  state: AppViewState,
  client: GatewayBrowserClient,
  pageId: string,
  prop: string,
  value: any,
): Promise<void> {
  const ns = state.notionDbState;
  if (!ns || !ns.selectedDbId) return;

  // Optimistic local update
  const page = ns.pages.find((p) => p.id === pageId);
  if (page) {
    page.data = { ...page.data, [prop]: value };
    state.requestUpdate?.();
  }

  try {
    const res = (await client.request("notion.db.pages.update", {
      pageId,
      databaseId: ns.selectedDbId,
      data: { [prop]: value },
    })) as any;
    if (res?.page) {
      const idx = ns.pages.findIndex((p) => p.id === pageId);
      if (idx >= 0) ns.pages[idx] = res.page;
      if (ns.detailPage?.id === pageId) ns.detailPage = res.page;
    }
    state.requestUpdate?.();
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    // Reload to get correct state
    if (ns.selectedDbId) await selectDatabase(state, client, ns.selectedDbId);
    state.requestUpdate?.();
  }
}

/** Delete/archive a page */
export async function deletePage(state: AppViewState, client: GatewayBrowserClient, pageId: string): Promise<void> {
  const ns = state.notionDbState;
  if (!ns || !ns.selectedDbId) return;

  try {
    await client.request("notion.db.pages.delete", {
      pageId,
      databaseId: ns.selectedDbId,
    });
    ns.pages = ns.pages.filter((p) => p.id !== pageId);
    ns.showDeleteConfirm = null;
    if (ns.detailPage?.id === pageId) {
      ns.detailPage = null;
      ns.showDetailPanel = false;
    }
    showSuccess(ns, "Page archived", state);
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

/** Load page blocks (content) */
export async function loadPageBlocks(state: AppViewState, client: GatewayBrowserClient, pageId: string): Promise<void> {
  const ns = state.notionDbState;
  if (!ns) return;

  ns.blocksLoading = true;
  ns.blocks = [];
  ns.subPages = [];
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.pages.blocks", { pageId })) as any;
    ns.blocks = res?.blocks ?? [];
    ns.subPages = res?.subPages ?? [];
  } catch (e) {
    // Silently fail — blocks are optional enhancement
    console.warn("Failed to load page blocks:", e);
    ns.blocks = [];
    ns.subPages = [];
  }

  ns.blocksLoading = false;
  state.requestUpdate?.();
}

/** Navigate into a sub-page */
export async function navigateToSubPage(state: AppViewState, client: GatewayBrowserClient, pageId: string, title: string): Promise<void> {
  const ns = state.notionDbState;
  if (!ns) return;

  // Push current page to breadcrumb
  const currentPageId = ns.blockBreadcrumb.length > 0
    ? ns.blockBreadcrumb[ns.blockBreadcrumb.length - 1].id
    : ns.detailPage?.id;
  const currentTitle = ns.blockBreadcrumb.length > 0
    ? ns.blockBreadcrumb[ns.blockBreadcrumb.length - 1].title
    : getPageTitle(ns.detailPage, ns.schema);

  if (currentPageId && ns.blockBreadcrumb.length === 0) {
    ns.blockBreadcrumb.push({ id: currentPageId, title: currentTitle });
  }
  ns.blockBreadcrumb.push({ id: pageId, title });
  ns.expandedToggles = new Set();
  state.requestUpdate?.();

  await loadPageBlocks(state, client, pageId);
}

/** Navigate back in breadcrumb */
export async function navigateBack(state: AppViewState, client: GatewayBrowserClient, index: number): Promise<void> {
  const ns = state.notionDbState;
  if (!ns) return;

  if (index === 0) {
    // Go back to root page
    ns.blockBreadcrumb = [];
    ns.expandedToggles = new Set();
    if (ns.detailPage) {
      await loadPageBlocks(state, client, ns.detailPage.id);
    }
  } else {
    const target = ns.blockBreadcrumb[index];
    ns.blockBreadcrumb = ns.blockBreadcrumb.slice(0, index + 1);
    ns.expandedToggles = new Set();
    if (target) {
      await loadPageBlocks(state, client, target.id);
    }
  }
}

/** Resolve relation page titles */
export async function resolveRelations(state: AppViewState, client: GatewayBrowserClient, pageIds: string[]): Promise<void> {
  const ns = state.notionDbState;
  if (!ns) return;

  // Filter out already cached
  const uncached = pageIds.filter((id) => !ns.relationCache[id]);
  if (uncached.length === 0) return;

  ns.relationLoading = true;
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.pages.relations", { pageIds: uncached })) as any;
    for (const p of res?.pages ?? []) {
      ns.relationCache[p.id] = p.title;
    }
  } catch (e) {
    console.warn("Failed to resolve relations:", e);
  }

  ns.relationLoading = false;
  state.requestUpdate?.();
}

/** Toggle a block's expanded state */
export function toggleBlock(state: AppViewState, blockId: string): void {
  const ns = state.notionDbState;
  if (!ns) return;
  if (ns.expandedToggles.has(blockId)) {
    ns.expandedToggles.delete(blockId);
  } else {
    ns.expandedToggles.add(blockId);
  }
  state.requestUpdate?.();
}

/** Discover databases in workspace */
export async function discoverDatabases(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const ns = state.notionDbState;
  if (!ns) return;

  ns.discovering = true;
  clearMessages(ns);
  state.requestUpdate?.();

  try {
    const res = (await client.request("notion.db.discover", {})) as any;
    ns.discoveredDbs = res?.databases ?? [];
    ns.showDiscoverDialog = true;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
  }

  ns.discovering = false;
  state.requestUpdate?.();
}
