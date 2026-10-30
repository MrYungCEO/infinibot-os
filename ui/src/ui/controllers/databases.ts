/**
 * Controller — generic databases UI.
 *
 * Talks to the gateway db.* RPC surface. Keeps lightweight state on
 * AppViewState under `dbState` so Lit can react without touching the
 * giant global state bag too invasively.
 */

import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";

// Minimal mirrors of src/databases/types.ts kept local to the UI so we
// don't introduce a cross-package import. If the shapes drift we'll
// publish a shared types package.
export type PropertyType =
  | "title"
  | "richText"
  | "select"
  | "multiSelect"
  | "date"
  | "dateRange"
  | "number"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "files"
  | "relation"
  | "person"
  | "status"
  | "createdAt"
  | "updatedAt";

export interface SelectOption { id: string; name: string; color?: string }

export interface PropertyConfig {
  options?: SelectOption[];
  format?: string;
  targetDatabaseId?: string;
  allowedMimePrefixes?: string[];
  extra?: Record<string, unknown>;
}

export interface DatabaseProperty {
  id: string;
  databaseId: string;
  name: string;
  type: PropertyType;
  config: PropertyConfig | null;
  sortOrder: number;
  hidden: boolean;
}

export interface DatabaseRecord {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  source: string;
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type PropertyValue =
  | { type: "title"; text: string }
  | { type: "richText"; markdown: string }
  | { type: "select"; optionId: string | null }
  | { type: "multiSelect"; optionIds: string[] }
  | { type: "date"; iso: string | null }
  | { type: "dateRange"; start: string | null; end: string | null }
  | { type: "number"; value: number | null }
  | { type: "checkbox"; checked: boolean }
  | { type: "url"; url: string | null }
  | { type: "email"; email: string | null }
  | { type: "phone"; phone: string | null }
  | { type: "files"; files: Array<{ name: string; url: string; mime?: string; size?: number }> }
  | { type: "relation"; rowIds: string[] }
  | { type: "person"; personIds: string[] }
  | { type: "status"; optionId: string | null }
  | { type: "createdAt"; iso: string }
  | { type: "updatedAt"; iso: string };

export interface DatabaseRow {
  id: string;
  databaseId: string;
  title: string;
  body: string | null;
  values: Record<string, PropertyValue>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** Per-business scope. Mirrors src/databases/types.ts:DatabaseRow.businessId. */
  businessId?: string | null;
}

export type DbView = "table" | "board" | "gallery" | "calendar";

export type SystemRole = "projects" | "tasks" | "notes" | "clients" | "leads";
export const SYSTEM_ROLES: SystemRole[] = ["projects", "tasks", "notes", "clients", "leads"];

export const SYSTEM_ROLE_LABELS: Record<SystemRole, string> = {
  projects: "Projects",
  tasks: "Tasks",
  notes: "Notes",
  clients: "Clients",
  leads: "Leads",
};

export const SYSTEM_ROLE_ICONS: Record<SystemRole, string> = {
  projects: "📁",
  tasks: "✅",
  notes: "📝",
  clients: "👥",
  leads: "🎯",
};

export interface SystemRoleAssignment {
  role: SystemRole;
  databaseId: string;
  updatedAt: number;
}

export interface DatabasesState {
  loading: boolean;
  error: string | null;
  databases: DatabaseRecord[];
  selectedDatabaseId: string | null;
  properties: DatabaseProperty[];
  rows: DatabaseRow[];
  selectedRowId: string | null;
  view: DbView;
  /** Board/gallery/calendar group key (property id). */
  groupByPropertyId: string | null;
  searchQuery: string;
  showNewDatabaseDialog: boolean;
  showImportDialog: boolean;
  importRunning: boolean;
  importLog: string[];
  /**
   * Discover step in the import dialog — populated by
   * `discoverNotionDatabases` so the operator can multi-select which DBs to
   * import instead of pulling every Notion database the integration sees.
   */
  importDiscovering: boolean;
  /** True once a discover attempt has completed (success or failure).
   *  Halts the render-time lazy-fire when the gateway legitimately
   *  returns an empty list — without this, `[]` keeps re-triggering the
   *  same fetch every render and the dialog reads as "stuck scanning". */
  importDiscovered_loaded: boolean;
  importDiscoveryError: string | null;
  importDiscovered: Array<{ id: string; title: string; propertyCount: number; isSystemManaged: boolean }>;
  importSelectedIds: Set<string>;
  /** Maps role → databaseId. Loaded from gateway on first open. */
  systemRoles: Partial<Record<SystemRole, string>>;
  systemRolesLoading: boolean;
  /** Full-page row view state. */
  openRowId: string | null;
  openRow: DatabaseRow | null;
  openRowLoading: boolean;
  /** Number of in-flight `updateOpenRow` saves. Drives the "Saving…" badge. */
  openRowSavingCount: number;
  /** Timestamp of the last successful save (used to show a transient "Saved"). */
  openRowSavedAt: number | null;
  relatedBundle: RelatedBundle | null;
  relatedLoading: boolean;
  /** Nested-pages tree for the currently-open row. */
  openRowAncestors: DatabaseRow[];
  openRowChildren: DatabaseRow[];
  treeLoading: boolean;
  /**
   * Kanban-view "project content" strip: loaded when the user enters a
   * specific project on the kanban tab, so they can read the project's
   * body + sub-pages alongside the task board.
   */
  kanbanProjectPage: DatabaseRow | null;
  kanbanProjectPageChildren: DatabaseRow[];
  kanbanProjectPageLoading: boolean;
  /** Notion project id this panel was loaded for — dedupe trigger. */
  kanbanProjectPageFor: string | null;
  /** Title index for any row we've seen — used to render relation chips by name. */
  rowTitleIndex: Record<string, { title: string; databaseId: string }>;
  /** id of the property whose inline picker is currently open (null = none). */
  openRelationPicker: string | null;
  /** Candidate rows fetched for the currently-open relation picker. */
  relationCandidates: DatabaseRow[];
  relationCandidatesLoading: boolean;
}

export interface RelatedGroup {
  databaseId: string;
  databaseName: string;
  propertyId: string;
  propertyName: string;
  rows: DatabaseRow[];
}

export interface DatabaseLinkRef {
  id: string;
  rowId: string;
  targetKind: string;
  targetId: string;
  propertyId: string | null;
  label: string | null;
  createdAt: number;
}

export interface RelatedBundle {
  anchor: DatabaseRow;
  outgoing: RelatedGroup[];
  incoming: RelatedGroup[];
  linksOut: DatabaseLinkRef[];
  linksIn: DatabaseLinkRef[];
}

export function getDatabasesState(state: AppViewState): DatabasesState {
  const holder = state as AppViewState & { dbState?: DatabasesState };
  if (!holder.dbState) {
    holder.dbState = {
      loading: false,
      error: null,
      databases: [],
      selectedDatabaseId: null,
      properties: [],
      rows: [],
      selectedRowId: null,
      view: "table",
      groupByPropertyId: null,
      searchQuery: "",
      showNewDatabaseDialog: false,
      showImportDialog: false,
      importRunning: false,
      importLog: [],
      importDiscovering: false,
      importDiscovered_loaded: false,
      importDiscoveryError: null,
      importDiscovered: [],
      importSelectedIds: new Set(),
      systemRoles: {},
      systemRolesLoading: false,
      openRowId: null,
      openRow: null,
      openRowLoading: false,
      openRowSavingCount: 0,
      openRowSavedAt: null,
      relatedBundle: null,
      relatedLoading: false,
      openRowAncestors: [],
      openRowChildren: [],
      treeLoading: false,
      kanbanProjectPage: null,
      kanbanProjectPageChildren: [],
      kanbanProjectPageLoading: false,
      kanbanProjectPageFor: null,
      rowTitleIndex: {},
      openRelationPicker: null,
      relationCandidates: [],
      relationCandidatesLoading: false,
    };
  }
  return holder.dbState;
}

async function call<T>(client: GatewayBrowserClient, method: string, params: unknown = {}): Promise<T> {
  return (await client.request(method, params as Record<string, unknown>)) as T;
}

// ─── Databases ───────────────────────────────────────────────────

export async function loadDatabases(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const s = getDatabasesState(state);
  s.loading = true;
  s.error = null;
  state.requestUpdate?.();
  try {
    // Step 1: databases list FIRST so options exist before we set roles.
    // Parallelising the two calls races the select-render and often shows
    // currentId with no matching <option>, which falls back to "unassigned".
    const listRes = await call<{ databases: DatabaseRecord[] }>(client, "db.list");
    s.databases = listRes.databases;

    // Step 2: roles. Any previously-set assignment now resolves against
    // the hydrated databases array.
    await loadSystemRoles(state, client);

    // Step 3: pick a default selected database.
    if (!s.selectedDatabaseId && s.databases.length > 0) {
      s.selectedDatabaseId = s.databases[0]!.id;
      await loadDatabase(state, client, s.databases[0]!.id);
    }
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.loading = false;
    state.requestUpdate?.();
  }
}

export async function loadDatabase(
  state: AppViewState,
  client: GatewayBrowserClient,
  databaseId: string,
): Promise<void> {
  const s = getDatabasesState(state);
  s.loading = true;
  s.selectedDatabaseId = databaseId;
  s.selectedRowId = null;
  state.requestUpdate?.();
  try {
    const dbRes = await call<{ database: DatabaseRecord; properties: DatabaseProperty[] }>(
      client,
      "db.get",
      { id: databaseId },
    );
    s.properties = dbRes.properties;
    // Pick default group-by: first status or select property.
    s.groupByPropertyId =
      dbRes.properties.find((p) => p.type === "status" || p.type === "select")?.id ?? null;

    // Scope rows to the active business filter when set. The gateway accepts
    // a tri-state businessId param: omitted = all, null = unscoped only,
    // string = that business. Here we only ever opt into the string form so
    // legacy unscoped rows stay visible until the user explicitly tags them.
    const { getBizFilter } = await import("../lib/biz-filter.js");
    const bizFilter = getBizFilter();
    const rowsRes = await call<{ rows: DatabaseRow[] }>(client, "db.rows.list", {
      databaseId,
      ...(bizFilter ? { businessId: bizFilter } : {}),
    });
    s.rows = rowsRes.rows;
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.loading = false;
    state.requestUpdate?.();
  }
}

export async function createDatabase(
  state: AppViewState,
  client: GatewayBrowserClient,
  input: { name: string; icon?: string; description?: string },
): Promise<DatabaseRecord | null> {
  try {
    const res = await call<{ database: DatabaseRecord }>(client, "db.create", input);
    await loadDatabases(state, client);
    if (res.database) {
      await loadDatabase(state, client, res.database.id);
    }
    return res.database;
  } catch (e) {
    const s = getDatabasesState(state);
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return null;
  }
}

/**
 * Set the linked business id on a database. Persisted via `db.meta.businessId`
 * so /business analytics + AI context can scope this database to a brand.
 * Pass an empty string to clear the link.
 */
export async function setDatabaseBusiness(
  state: AppViewState,
  client: GatewayBrowserClient,
  databaseId: string,
  businessId: string,
): Promise<void> {
  const s = getDatabasesState(state);
  const db = s.databases.find((d) => d.id === databaseId);
  if (!db) return;
  const nextMeta: Record<string, unknown> = { ...(db.meta ?? {}) };
  if (businessId.trim()) {
    nextMeta.businessId = businessId.trim();
  } else {
    delete nextMeta.businessId;
  }
  // Optimistic local update so the dropdown reflects the new value before
  // the server round-trip lands.
  db.meta = nextMeta;
  state.requestUpdate?.();
  try {
    await call(client, "db.update", { id: databaseId, meta: nextMeta });
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function deleteDatabase(
  state: AppViewState,
  client: GatewayBrowserClient,
  databaseId: string,
): Promise<void> {
  try {
    await call(client, "db.delete", { id: databaseId });
    const s = getDatabasesState(state);
    if (s.selectedDatabaseId === databaseId) {
      s.selectedDatabaseId = null;
      s.rows = [];
      s.properties = [];
    }
    await loadDatabases(state, client);
  } catch (e) {
    const s = getDatabasesState(state);
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ─── Rows ────────────────────────────────────────────────────────

export async function createRow(
  state: AppViewState,
  client: GatewayBrowserClient,
  databaseId: string,
  title = "",
): Promise<DatabaseRow | null> {
  try {
    // Scope the new row to the active business filter (when one is set)
    // so it persists on refresh — the list call filters rows by the same
    // businessId, and rows without a businessId are invisible under any
    // business scope. Falling through to no-filter means "global" rows
    // (kept null) the user can still see when they clear the filter.
    const { getBizFilter } = await import("../lib/biz-filter.js");
    const bizFilter = getBizFilter();
    const res = await call<{ row: DatabaseRow }>(client, "db.rows.upsert", {
      databaseId,
      title,
      values: {},
      ...(bizFilter ? { businessId: bizFilter } : {}),
    });
    const s = getDatabasesState(state);
    s.rows = [...s.rows, res.row];
    s.selectedRowId = res.row.id;
    state.requestUpdate?.();
    return res.row;
  } catch (e) {
    const s = getDatabasesState(state);
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return null;
  }
}

export async function updateRow(
  state: AppViewState,
  client: GatewayBrowserClient,
  rowId: string,
  patch: { title?: string; body?: string | null; values?: Record<string, PropertyValue> },
): Promise<void> {
  const s = getDatabasesState(state);
  const existing = s.rows.find((r) => r.id === rowId);
  if (!existing) return;
  try {
    const res = await call<{ row: DatabaseRow }>(client, "db.rows.upsert", {
      id: rowId,
      databaseId: existing.databaseId,
      ...patch,
    });
    s.rows = s.rows.map((r) => (r.id === rowId ? res.row : r));
    state.requestUpdate?.();
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function deleteRow(
  state: AppViewState,
  client: GatewayBrowserClient,
  rowId: string,
): Promise<void> {
  const s = getDatabasesState(state);
  try {
    await call(client, "db.rows.delete", { id: rowId });
    s.rows = s.rows.filter((r) => r.id !== rowId);
    if (s.selectedRowId === rowId) s.selectedRowId = null;
    state.requestUpdate?.();
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ─── Properties ──────────────────────────────────────────────────

export async function createProperty(
  state: AppViewState,
  client: GatewayBrowserClient,
  input: { databaseId: string; name: string; type: PropertyType; config?: PropertyConfig | null },
): Promise<void> {
  const s = getDatabasesState(state);
  try {
    await call(client, "db.properties.create", input);
    // reload to fetch with correct sort order
    if (s.selectedDatabaseId) await loadDatabase(state, client, s.selectedDatabaseId);
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function updatePropertyName(
  state: AppViewState,
  client: GatewayBrowserClient,
  propertyId: string,
  name: string,
): Promise<void> {
  const s = getDatabasesState(state);
  try {
    await call(client, "db.properties.update", { id: propertyId, name });
    s.properties = s.properties.map((p) => (p.id === propertyId ? { ...p, name } : p));
    state.requestUpdate?.();
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ─── Helpers for the view ────────────────────────────────────────

export function getTitleProperty(s: DatabasesState): DatabaseProperty | null {
  return s.properties.find((p) => p.type === "title") ?? null;
}

export function valueAsString(v: PropertyValue | undefined): string {
  if (!v) return "";
  switch (v.type) {
    case "title": return v.text;
    case "richText": return v.markdown;
    case "select":
    case "status": return v.optionId ?? "";
    case "multiSelect": return v.optionIds.join(", ");
    case "date": return v.iso ?? "";
    case "dateRange": return `${v.start ?? ""} – ${v.end ?? ""}`;
    case "number": return v.value == null ? "" : String(v.value);
    case "checkbox": return v.checked ? "✓" : "";
    case "url": return v.url ?? "";
    case "email": return v.email ?? "";
    case "phone": return v.phone ?? "";
    case "files": return v.files.map((f) => f.name).join(", ");
    case "relation": return v.rowIds.join(", ");
    case "person": return v.personIds.join(", ");
    case "createdAt":
    case "updatedAt": return v.iso;
  }
}

/**
 * Convert a "friendly" values map (keys = property name OR id; values may be
 * bare strings/numbers/arrays OR already-shaped PropertyValue objects) into
 * the canonical Record<propertyId, PropertyValue> that the store expects.
 *
 * Why this exists: the gateway stores values keyed by property id and typed
 * by PropertyValue shape (e.g. {type:"phone", phone:"..."}). Agents writing
 * a CSV import naturally produce {Phone: "02 153 3555"} — without coercion,
 * those bare values get silently dropped at upsert. This helper closes that
 * gap so create_row/update_row "just work" with whichever shape the caller
 * has.
 *
 * Unknown keys are ignored (no throw) so partial updates don't fail when a
 * property has since been renamed. Unknown select option labels pass through
 * as the optionId string — round-trips cleanly if the option later exists
 * or the UI is permissive.
 */
export function coerceValuesForProperties(
  properties: DatabaseProperty[],
  input: Record<string, unknown> | undefined | null,
): Record<string, PropertyValue> {
  if (!input) return {};
  const lookup = new Map<string, DatabaseProperty>();
  for (const p of properties) {
    lookup.set(p.id, p);
    lookup.set(p.name.toLowerCase(), p);
  }
  const out: Record<string, PropertyValue> = {};
  for (const [k, raw] of Object.entries(input)) {
    if (raw === undefined) continue;
    const prop = lookup.get(k) ?? lookup.get(k.toLowerCase());
    if (!prop) continue;
    const coerced = coerceValueForProperty(prop, raw);
    if (coerced) out[prop.id] = coerced;
  }
  return out;
}

function coerceValueForProperty(
  prop: DatabaseProperty,
  raw: unknown,
): PropertyValue | null {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "type" in raw &&
    (raw as { type?: string }).type === prop.type
  ) {
    return raw as PropertyValue;
  }
  const opts = prop.config?.options ?? [];
  const findOption = (val: string) => {
    const v = val.toLowerCase();
    return (
      opts.find((o) => o.id === val) ??
      opts.find((o) => o.name.toLowerCase() === v) ??
      null
    );
  };
  const isBlank = (v: unknown) => v == null || v === "";
  switch (prop.type) {
    case "title":
      return { type: "title", text: String(raw ?? "") };
    case "richText":
      return { type: "richText", markdown: String(raw ?? "") };
    case "url":
      return { type: "url", url: isBlank(raw) ? null : String(raw) };
    case "email":
      return { type: "email", email: isBlank(raw) ? null : String(raw) };
    case "phone":
      return { type: "phone", phone: isBlank(raw) ? null : String(raw) };
    case "number": {
      if (isBlank(raw)) return { type: "number", value: null };
      const n = typeof raw === "number" ? raw : Number(raw);
      return { type: "number", value: Number.isFinite(n) ? n : null };
    }
    case "checkbox":
      return { type: "checkbox", checked: Boolean(raw) };
    case "date":
      return { type: "date", iso: isBlank(raw) ? null : String(raw) };
    case "dateRange": {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const o = raw as { start?: string | null; end?: string | null };
        return { type: "dateRange", start: o.start ?? null, end: o.end ?? null };
      }
      return { type: "dateRange", start: null, end: null };
    }
    case "select":
    case "status": {
      if (isBlank(raw)) return { type: prop.type, optionId: null };
      const found = findOption(String(raw));
      return { type: prop.type, optionId: found?.id ?? String(raw) };
    }
    case "multiSelect": {
      const arr = Array.isArray(raw) ? raw : isBlank(raw) ? [] : [raw];
      const ids = arr.map((v) => {
        const found = findOption(String(v));
        return found?.id ?? String(v);
      });
      return { type: "multiSelect", optionIds: ids };
    }
    case "relation": {
      const arr = Array.isArray(raw) ? raw : isBlank(raw) ? [] : [raw];
      return { type: "relation", rowIds: arr.map(String) };
    }
    case "person": {
      const arr = Array.isArray(raw) ? raw : isBlank(raw) ? [] : [raw];
      return { type: "person", personIds: arr.map(String) };
    }
    case "files": {
      const arr = Array.isArray(raw) ? raw : [];
      return { type: "files", files: arr as never };
    }
    case "createdAt":
    case "updatedAt":
      return {
        type: prop.type,
        iso: typeof raw === "string" ? raw : new Date().toISOString(),
      };
  }
}

export function defaultValueFor(type: PropertyType): PropertyValue {
  switch (type) {
    case "title": return { type: "title", text: "" };
    case "richText": return { type: "richText", markdown: "" };
    case "select": return { type: "select", optionId: null };
    case "status": return { type: "status", optionId: null };
    case "multiSelect": return { type: "multiSelect", optionIds: [] };
    case "date": return { type: "date", iso: null };
    case "dateRange": return { type: "dateRange", start: null, end: null };
    case "number": return { type: "number", value: null };
    case "checkbox": return { type: "checkbox", checked: false };
    case "url": return { type: "url", url: null };
    case "email": return { type: "email", email: null };
    case "phone": return { type: "phone", phone: null };
    case "files": return { type: "files", files: [] };
    case "relation": return { type: "relation", rowIds: [] };
    case "person": return { type: "person", personIds: [] };
    case "createdAt": return { type: "createdAt", iso: new Date().toISOString() };
    case "updatedAt": return { type: "updatedAt", iso: new Date().toISOString() };
  }
}

export function setView(state: AppViewState, view: DbView): void {
  const s = getDatabasesState(state);
  s.view = view;
  state.requestUpdate?.();
}

export function setSelectedRow(state: AppViewState, rowId: string | null): void {
  const s = getDatabasesState(state);
  s.selectedRowId = rowId;
  state.requestUpdate?.();
}

export function setGroupBy(state: AppViewState, propertyId: string | null): void {
  const s = getDatabasesState(state);
  s.groupByPropertyId = propertyId;
  state.requestUpdate?.();
}

// ─── Import (Notion) ─────────────────────────────────────────────

/**
 * Populate the import dialog's discover list. Reuses `notion.import.listDatabases`
 * (which also powers the unified wizard) — single source of truth for "what
 * can the integration see" + the same probe of known DB IDs to surface
 * databases Notion's /search misses.
 */
export async function discoverNotionDatabases(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getDatabasesState(state);
  s.importDiscovering = true;
  s.importDiscoveryError = null;
  s.importDiscovered = [];
  s.importSelectedIds = new Set();
  state.requestUpdate?.();
  let didLoad = false;
  try {
    const res = await call<{
      databases: Array<{ id: string; title: string; propertyCount: number; isSystemManaged: boolean }>;
    }>(client, "notion.import.listDatabases", {});
    s.importDiscovered = (res.databases ?? []).map((d) => ({
      id: d.id,
      title: d.title,
      propertyCount: d.propertyCount,
      isSystemManaged: d.isSystemManaged,
    }));
    didLoad = true;
  } catch (e) {
    s.importDiscoveryError = e instanceof Error ? e.message : String(e);
    didLoad = true;
  } finally {
    s.importDiscovering = false;
    s.importDiscovered_loaded = didLoad;
    state.requestUpdate?.();
  }
}

export function toggleImportSelection(state: AppViewState, dbId: string): void {
  const s = getDatabasesState(state);
  if (s.importSelectedIds.has(dbId)) s.importSelectedIds.delete(dbId);
  else s.importSelectedIds.add(dbId);
  state.requestUpdate?.();
}

export function selectAllImportable(state: AppViewState, all: boolean): void {
  const s = getDatabasesState(state);
  if (all) {
    s.importSelectedIds = new Set(s.importDiscovered.map((d) => d.id));
  } else {
    s.importSelectedIds = new Set();
  }
  state.requestUpdate?.();
}

export async function importFromNotion(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts: { apiKey?: string; databaseIds?: string[] } = {},
): Promise<void> {
  const s = getDatabasesState(state);
  s.importRunning = true;
  s.importLog = ["Starting Notion import…"];
  state.requestUpdate?.();
  try {
    const res = await call<{ imported: Array<{ databaseId: string; rowCount: number; name: string }>; warnings: string[] }>(
      client,
      "db.import.notion",
      opts,
    );
    for (const item of res.imported) {
      s.importLog.push(`✓ ${item.name} — ${item.rowCount} rows`);
    }
    for (const w of res.warnings) s.importLog.push(`⚠ ${w}`);
    await loadDatabases(state, client);
  } catch (e) {
    s.importLog.push(`✗ ${e instanceof Error ? e.message : String(e)}`);
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.importRunning = false;
    state.requestUpdate?.();
  }
}

// ─── System roles ─────────────────────────────────────────────

export async function loadSystemRoles(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
  const s = getDatabasesState(state);
  s.systemRolesLoading = true;
  state.requestUpdate?.();
  try {
    const res = await call<{ assignments: SystemRoleAssignment[] }>(client, "db.system.list");
    const map: Partial<Record<SystemRole, string>> = {};
    for (const a of res.assignments) map[a.role] = a.databaseId;
    s.systemRoles = map;
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.systemRolesLoading = false;
    state.requestUpdate?.();
  }
}

export async function setSystemRole(
  state: AppViewState,
  client: GatewayBrowserClient,
  role: SystemRole,
  databaseId: string,
): Promise<void> {
  const s = getDatabasesState(state);
  try {
    await call(client, "db.system.set", { role, databaseId });
    s.systemRoles = { ...s.systemRoles, [role]: databaseId };
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

export async function clearSystemRole(
  state: AppViewState,
  client: GatewayBrowserClient,
  role: SystemRole,
): Promise<void> {
  const s = getDatabasesState(state);
  try {
    await call(client, "db.system.clear", { role });
    const next = { ...s.systemRoles };
    delete next[role];
    s.systemRoles = next;
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

/** Resolve a database by id in whatever context (sidebar list OR open row). */
export function findDatabase(s: DatabasesState, databaseId: string): DatabaseRecord | null {
  return s.databases.find((d) => d.id === databaseId) ?? null;
}

/**
 * Fetch candidate rows for a relation picker (target database). Uses
 * db.rows.list which is kanban-aware so kanban-sourced targets work too.
 */
export async function fetchCandidateRows(
  client: GatewayBrowserClient,
  databaseId: string,
): Promise<DatabaseRow[]> {
  try {
    const res = await call<{ rows: DatabaseRow[] }>(client, "db.rows.list", { databaseId });
    return res.rows ?? [];
  } catch {
    return [];
  }
}

/** Returns { role → databaseId } reverse map for lookup by db id. */
export function rolesForDatabase(s: DatabasesState, databaseId: string): SystemRole[] {
  const out: SystemRole[] = [];
  for (const role of SYSTEM_ROLES) {
    if (s.systemRoles[role] === databaseId) out.push(role);
  }
  return out;
}

// ─── Two-way Notion sync ─────────────────────────────────────────

export function databaseSupportsSync(db: DatabaseRecord | null): boolean {
  if (!db) return false;
  return typeof db.meta?.notionDatabaseId === "string" && db.meta.notionDatabaseId.length > 0;
}

export function isSyncEnabled(db: DatabaseRecord | null): boolean {
  return Boolean(db?.meta?.syncWithNotion);
}

export function lastSyncedAt(db: DatabaseRecord | null): number | null {
  if (!db) return null;
  const pulled = typeof db.meta?.notionLastPulledAt === "number" ? db.meta.notionLastPulledAt : 0;
  const pushed = typeof db.meta?.notionLastPushedAt === "number" ? db.meta.notionLastPushedAt : 0;
  const latest = Math.max(pulled, pushed);
  return latest > 0 ? latest : null;
}

export async function setSyncEnabled(
  state: AppViewState,
  client: GatewayBrowserClient,
  databaseId: string,
  enabled: boolean,
): Promise<void> {
  const s = getDatabasesState(state);
  try {
    const method = enabled ? "db.sync.enable" : "db.sync.disable";
    const res = await call<{ database: DatabaseRecord }>(client, method, { databaseId });
    s.databases = s.databases.map((d) => (d.id === databaseId ? res.database : d));
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

// ─── Row page (full-screen) ──────────────────────────────────────

function indexRows(s: DatabasesState, rows: DatabaseRow[]): void {
  for (const r of rows) {
    s.rowTitleIndex[r.id] = { title: r.title || "Untitled", databaseId: r.databaseId };
  }
}

export async function openRowPage(
  state: AppViewState,
  client: GatewayBrowserClient,
  rowId: string,
): Promise<void> {
  const s = getDatabasesState(state);
  s.openRowId = rowId;
  s.openRow = null;
  s.openRowLoading = true;
  s.relatedBundle = null;
  s.relatedLoading = true;
  s.selectedRowId = null; // close the drawer if it was open
  s.openRelationPicker = null;
  s.openRowAncestors = [];
  s.openRowChildren = [];
  s.treeLoading = true;
  state.requestUpdate?.();

  try {
    const rowRes = await call<{ row: DatabaseRow }>(client, "db.rows.get", { id: rowId });
    s.openRow = rowRes.row ?? null;
    if (s.openRow) indexRows(s, [s.openRow]);
    s.openRowLoading = false;
    state.requestUpdate?.();

    // Fire the three follow-up loads in parallel.
    const [related, childRes, ancestorRes] = await Promise.all([
      call<RelatedBundle>(client, "db.rows.related", { rowId }),
      call<{ children: DatabaseRow[] }>(client, "db.rows.children", { rowId }).catch(() => ({ children: [] })),
      call<{ ancestors: DatabaseRow[] }>(client, "db.rows.ancestors", { rowId }).catch(() => ({ ancestors: [] })),
    ]);

    s.relatedBundle = related;
    for (const g of related.outgoing) indexRows(s, g.rows);
    for (const g of related.incoming) indexRows(s, g.rows);

    s.openRowChildren = childRes.children ?? [];
    indexRows(s, s.openRowChildren);

    s.openRowAncestors = ancestorRes.ancestors ?? [];
    indexRows(s, s.openRowAncestors);
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.openRowLoading = false;
    s.relatedLoading = false;
    s.treeLoading = false;
    state.requestUpdate?.();
  }
}

export async function createSubpage(
  state: AppViewState,
  client: GatewayBrowserClient,
  parentRowId: string,
  title = "Untitled",
): Promise<DatabaseRow | null> {
  const s = getDatabasesState(state);
  try {
    const res = await call<{ row: DatabaseRow }>(client, "db.rows.createChild", {
      parentRowId,
      title,
    });
    const child = res.row;
    s.openRowChildren = [...s.openRowChildren, child];
    indexRows(s, [child]);
    state.requestUpdate?.();
    // Navigate into the new child so editing is immediate.
    await openRowPage(state, client, child.id);
    return child;
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return null;
  }
}

export async function moveRowToParent(
  state: AppViewState,
  client: GatewayBrowserClient,
  rowId: string,
  newParentRowId: string | null,
): Promise<void> {
  const s = getDatabasesState(state);
  try {
    await call(client, "db.rows.move", { rowId, parentRowId: newParentRowId });
    if (s.openRowId) await openRowPage(state, client, s.openRowId);
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function openRelationPicker(
  state: AppViewState,
  client: GatewayBrowserClient,
  propertyId: string,
  targetDatabaseId: string,
): Promise<void> {
  const s = getDatabasesState(state);
  s.openRelationPicker = propertyId;
  s.relationCandidates = [];
  s.relationCandidatesLoading = true;
  state.requestUpdate?.();
  try {
    const rows = await fetchCandidateRows(client, targetDatabaseId);
    s.relationCandidates = rows;
    indexRows(s, rows);
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.relationCandidatesLoading = false;
    state.requestUpdate?.();
  }
}

export function closeRelationPicker(state: AppViewState): void {
  const s = getDatabasesState(state);
  s.openRelationPicker = null;
  s.relationCandidates = [];
  state.requestUpdate?.();
}

export function closeRowPage(state: AppViewState): void {
  const s = getDatabasesState(state);
  s.openRowId = null;
  s.openRow = null;
  s.relatedBundle = null;
  state.requestUpdate?.();
}

// Per-controller save sequence. Each `updateOpenRow` call increments this and
// remembers its number; when its server response returns we only apply
// `s.openRow = res.row` if no newer save has been issued since. This drops
// stale out-of-order responses that would otherwise clobber the body the user
// is actively typing — the original symptom was "body resets when I type".
let openRowSaveSeq = 0;

export async function updateOpenRow(
  state: AppViewState,
  client: GatewayBrowserClient,
  patch: {
    title?: string;
    body?: string | null;
    values?: Record<string, PropertyValue>;
    /** Pass null to clear the row's business scope; omit to leave unchanged. */
    businessId?: string | null;
  },
): Promise<void> {
  const s = getDatabasesState(state);
  if (!s.openRow) return;
  const existing = s.openRow;
  const mySeq = ++openRowSaveSeq;
  // Optimistic update
  s.openRow = {
    ...existing,
    title: patch.title ?? existing.title,
    body: patch.body !== undefined ? patch.body : existing.body,
    values: { ...existing.values, ...(patch.values ?? {}) },
    businessId: patch.businessId !== undefined ? patch.businessId : existing.businessId,
    updatedAt: Date.now(),
  };
  s.openRowSavingCount += 1;
  state.requestUpdate?.();
  try {
    const res = await call<{ row: DatabaseRow }>(client, "db.rows.upsert", {
      id: existing.id,
      databaseId: existing.databaseId,
      title: patch.title,
      body: patch.body,
      values: patch.values,
      ...(patch.businessId !== undefined ? { businessId: patch.businessId } : {}),
    });
    // Only apply if this is still the latest save AND the user hasn't
    // navigated to a different row in the meantime.
    if (mySeq === openRowSaveSeq && s.openRow?.id === existing.id) {
      s.openRow = res.row;
    }
    // Always refresh the list copy — that one isn't subject to live editing.
    s.rows = s.rows.map((r) => (r.id === existing.id ? res.row : r));
    s.openRowSavedAt = Date.now();
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.openRowSavingCount = Math.max(0, s.openRowSavingCount - 1);
    state.requestUpdate?.();
  }
}

/**
 * Create a new row in `targetDatabaseId`, link it to the currently open row
 * via the given relation property, and navigate into the new row's page.
 *
 * Implements the "+ New sub-page" / "+ New linked row" UX: keeps the user's
 * flow without the 3-step (open target db → create row → come back and
 * link) dance.
 */
export async function createLinkedSubPage(
  state: AppViewState,
  client: GatewayBrowserClient,
  opts: { propertyId: string; targetDatabaseId: string; title?: string },
): Promise<DatabaseRow | null> {
  const s = getDatabasesState(state);
  const anchor = s.openRow;
  if (!anchor) return null;
  try {
    // Scope the new linked row to the same business as the anchor (so it
    // shows up under the same filter on refresh). Falls back to the active
    // business filter, falls back to nothing.
    const { getBizFilter } = await import("../lib/biz-filter.js");
    const scope = anchor.businessId ?? getBizFilter() ?? null;
    const res = await call<{ row: DatabaseRow }>(client, "db.rows.upsert", {
      databaseId: opts.targetDatabaseId,
      title: opts.title ?? "Untitled",
      values: {},
      ...(scope ? { businessId: scope } : {}),
    });
    const newRow = res.row;

    // Link back: append new row id to the anchor's relation property.
    const current = anchor.values[opts.propertyId];
    const existingIds = current?.type === "relation" ? current.rowIds : [];
    const nextIds = [...existingIds, newRow.id];
    await call(client, "db.rows.upsert", {
      id: anchor.id,
      databaseId: anchor.databaseId,
      values: {
        [opts.propertyId]: { type: "relation", rowIds: nextIds },
      },
    });

    // Navigate into the new row so the user can keep editing.
    await openRowPage(state, client, newRow.id);
    return newRow;
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
    return null;
  }
}

/**
 * Persist a body edit made in the kanban project content strip. Mirrors
 * `updateOpenRow` but writes through `s.kanbanProjectPage` since the strip
 * keeps its own row state separate from the databases drawer.
 */
export async function updateKanbanProjectPageBody(
  state: AppViewState,
  client: GatewayBrowserClient,
  body: string,
): Promise<void> {
  const s = getDatabasesState(state);
  const existing = s.kanbanProjectPage;
  if (!existing) return;
  s.kanbanProjectPage = { ...existing, body, updatedAt: Date.now() };
  state.requestUpdate?.();
  try {
    const res = await call<{ row: DatabaseRow }>(client, "db.rows.upsert", {
      id: existing.id,
      databaseId: existing.databaseId,
      body,
    });
    s.kanbanProjectPage = res.row;
    s.rows = s.rows.map((r) => (r.id === existing.id ? res.row : r));
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}

/**
 * Load the body + sub-pages for a kanban-sourced project, for display in
 * the kanban tab's inline content strip. Dedupes by notion project id so
 * re-renders of renderProjectsTab don't keep re-fetching.
 */
export async function loadKanbanProjectPage(
  state: AppViewState,
  client: GatewayBrowserClient,
  notionProjectId: string | null,
): Promise<void> {
  const s = getDatabasesState(state);
  if (!notionProjectId) {
    s.kanbanProjectPage = null;
    s.kanbanProjectPageChildren = [];
    s.kanbanProjectPageFor = null;
    state.requestUpdate?.();
    return;
  }
  if (s.kanbanProjectPageFor === notionProjectId && s.kanbanProjectPage) return;
  s.kanbanProjectPageFor = notionProjectId;
  s.kanbanProjectPageLoading = true;
  s.kanbanProjectPage = null;
  s.kanbanProjectPageChildren = [];
  state.requestUpdate?.();

  const rowId = notionProjectId.startsWith("kanban_")
    ? notionProjectId
    : `kanban_${notionProjectId}`;

  try {
    const [rowRes, childRes] = await Promise.all([
      call<{ row: DatabaseRow }>(client, "db.rows.get", { id: rowId }).catch(() => null),
      call<{ children: DatabaseRow[] }>(client, "db.rows.children", { rowId }).catch(
        () => ({ children: [] as DatabaseRow[] }),
      ),
    ]);
    if (rowRes?.row) {
      s.kanbanProjectPage = rowRes.row;
      indexRows(s, [rowRes.row]);
    }
    s.kanbanProjectPageChildren = childRes.children ?? [];
    indexRows(s, s.kanbanProjectPageChildren);
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.kanbanProjectPageLoading = false;
    state.requestUpdate?.();
  }
}

export async function reloadRelated(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getDatabasesState(state);
  if (!s.openRowId) return;
  s.relatedLoading = true;
  state.requestUpdate?.();
  try {
    const related = await call<RelatedBundle>(client, "db.rows.related", { rowId: s.openRowId });
    s.relatedBundle = related;
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.relatedLoading = false;
    state.requestUpdate?.();
  }
}

// ─── Files property ──────────────────────────────────────────────

/**
 * Upload one or more browser File objects to the gateway under
 * `db-attachments/<rowId>/<filename>` and append the resulting FileRef[]
 * to the row's `files`-typed property `propertyId`.
 *
 * Stored `url` uses the `infinibot://files/<relativePath>` scheme so the
 * renderer can resolve it via `files.download` regardless of where the
 * gateway is running. Filenames are kept literal; existing duplicates are
 * suffixed with `-1`, `-2`, … so two uploads of `notes.pdf` don't clobber.
 */
export async function uploadFilesToRowProperty(
  state: AppViewState,
  client: GatewayBrowserClient,
  rowId: string,
  propertyId: string,
  files: FileList | File[],
): Promise<void> {
  const list = Array.from(files);
  if (list.length === 0) return;
  const s = getDatabasesState(state);
  const row = findRow(s, rowId);
  if (!row) return;

  const existing = row.values[propertyId];
  const existingRefs: Array<{ name: string; url: string; mime?: string; size?: number }> =
    existing?.type === "files" ? [...existing.files] : [];

  const usedNames = new Set(existingRefs.map((f) => f.name));
  const newRefs: Array<{ name: string; url: string; mime?: string; size?: number }> = [];

  for (const file of list) {
    let name = file.name;
    if (usedNames.has(name)) {
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 1;
      while (usedNames.has(`${base}-${n}${ext}`)) n += 1;
      name = `${base}-${n}${ext}`;
    }
    usedNames.add(name);

    const base64 = await readFileAsBase64(file);
    const relPath = `db-attachments/${rowId}/${name}`;
    try {
      await client.request("files.upload", { path: relPath, content: base64 });
      newRefs.push({
        name,
        url: `infinibot://files/${relPath}`,
        mime: file.type || undefined,
        size: file.size,
      });
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e);
      state.requestUpdate?.();
    }
  }

  if (newRefs.length === 0) return;
  const next: PropertyValue = { type: "files", files: [...existingRefs, ...newRefs] };
  await saveFilesProperty(state, client, rowId, propertyId, next);
}

export async function removeFileFromRowProperty(
  state: AppViewState,
  client: GatewayBrowserClient,
  rowId: string,
  propertyId: string,
  fileUrl: string,
): Promise<void> {
  const s = getDatabasesState(state);
  const row = findRow(s, rowId);
  if (!row) return;
  const existing = row.values[propertyId];
  if (existing?.type !== "files") return;
  const next: PropertyValue = {
    type: "files",
    files: existing.files.filter((f) => f.url !== fileUrl),
  };
  await saveFilesProperty(state, client, rowId, propertyId, next);
}

function findRow(s: DatabasesState, rowId: string): DatabaseRow | null {
  return (
    s.rows.find((r) => r.id === rowId) ??
    (s.openRow?.id === rowId ? s.openRow : null) ??
    (s.kanbanProjectPage?.id === rowId ? s.kanbanProjectPage : null)
  );
}

/**
 * Save a files property value through the right path so both the list copy
 * and the full-page openRow stay in sync — `updateRow` only touches `s.rows`,
 * which would leave a stale value in `s.openRow` for the row that's open.
 */
async function saveFilesProperty(
  state: AppViewState,
  client: GatewayBrowserClient,
  rowId: string,
  propertyId: string,
  next: PropertyValue,
): Promise<void> {
  const s = getDatabasesState(state);
  if (s.openRow?.id === rowId) {
    await updateOpenRow(state, client, { values: { [propertyId]: next } });
  } else {
    await updateRow(state, client, rowId, { values: { [propertyId]: next } });
  }
}

/**
 * Resolve a stored FileRef.url to a download-able URL the UI can open.
 * `infinibot://files/<path>` URLs go through the `files.download` RPC and
 * become a transient blob URL; http(s) URLs pass through unchanged.
 */
export async function resolveFileUrl(
  client: GatewayBrowserClient,
  fileUrl: string,
): Promise<string> {
  if (!fileUrl.startsWith("infinibot://files/")) return fileUrl;
  const relPath = fileUrl.slice("infinibot://files/".length);
  const res = await client.request<{ content: string; type?: string; name?: string }>(
    "files.download",
    { path: relPath },
  );
  const bytes = Uint8Array.from(atob(res.content), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], res.type ? { type: res.type } : undefined));
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("expected data URL"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export async function runSync(
  state: AppViewState,
  client: GatewayBrowserClient,
  databaseId: string,
): Promise<void> {
  const s = getDatabasesState(state);
  try {
    await call(client, "db.sync.run", { databaseId });
    // Reload the database so updatedAt timestamps + external refs refresh.
    await loadDatabase(state, client, databaseId);
    const listRes = await call<{ databases: DatabaseRecord[] }>(client, "db.list");
    s.databases = listRes.databases;
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
  } finally {
    state.requestUpdate?.();
  }
}
