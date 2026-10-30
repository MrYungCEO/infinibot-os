/**
 * Apps & Sites controller — drives the dashboard's `/apps` page.
 */

import type { GatewayBrowserClient } from "../gateway";

// ── Types (mirror server) ───────────────────────────────────

export type AppType =
  | "web-app"
  | "landing-page"
  | "project"
  | "directory"
  | "composition"
  | "storyboard"
  | "mobile-app"
  | "other";

export type AppStatus = "active" | "draft" | "archived";

export type AppSourceKind =
  | "manual"
  | "kanban-project"
  | "directory"
  | "composition"
  | "storyboard"
  | "landing-page"
  | "expo-app";

export interface App {
  id: string;
  slug: string;
  name: string;
  description: string;
  type: AppType;
  url: string | null;
  status: AppStatus;
  businessId: string | null;
  directoryId: string | null;
  ownerId: string | null;
  sourceKind: AppSourceKind;
  sourceId: string | null;
  tags: string[];
  featured: boolean;
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AppsState {
  loading: boolean;
  error: string | null;
  success: string | null;
  apps: App[];
  filterType: AppType | "all";
  filterBusiness: string;
  filterFeatured: boolean;
  search: string;
  showCreate: boolean;
  createForm: {
    name: string;
    description: string;
    type: AppType;
    url: string;
    businessId: string;
    directoryId: string;
    tags: string;
  };
  editApp: App | null;
  busy: boolean;
}

export function createInitialAppsState(): AppsState {
  return {
    loading: false,
    error: null,
    success: null,
    apps: [],
    filterType: "all",
    filterBusiness: "",
    filterFeatured: false,
    search: "",
    showCreate: false,
    createForm: emptyCreateForm(),
    editApp: null,
    busy: false,
  };
}

function emptyCreateForm(): AppsState["createForm"] {
  return {
    name: "",
    description: "",
    type: "web-app",
    url: "",
    businessId: "",
    directoryId: "",
    tags: "",
  };
}

function flash(state: { apps: AppsState; requestUpdate?: () => void }, key: "error" | "success", value: string | null, ms = 3000) {
  state.apps[key] = value;
  if (value) setTimeout(() => { if (state.apps[key] === value) state.apps[key] = null; state.requestUpdate?.(); }, ms);
}

// ── API actions ──────────────────────────────────────────────

export async function loadApps(state: { apps: AppsState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  state.apps.loading = true;
  state.apps.error = null;
  state.requestUpdate?.();
  try {
    const params: Record<string, unknown> = {};
    if (state.apps.filterType !== "all") params.type = state.apps.filterType;
    if (state.apps.filterBusiness) params.businessId = state.apps.filterBusiness;
    if (state.apps.filterFeatured) params.featured = true;
    const res = (await client.request("apps.list", params)) as { apps: App[] };
    state.apps.apps = res.apps ?? [];
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.apps.loading = false;
    state.requestUpdate?.();
  }
}

export async function createApp(state: { apps: AppsState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  const f = state.apps.createForm;
  if (!f.name.trim()) { flash(state, "error", "Name required"); state.requestUpdate?.(); return; }
  state.apps.busy = true;
  state.requestUpdate?.();
  try {
    await client.request("apps.create", {
      name: f.name.trim(),
      description: f.description,
      type: f.type,
      url: f.url.trim() || undefined,
      businessId: f.businessId.trim() || undefined,
      directoryId: f.directoryId.trim() || undefined,
      tags: f.tags.split(",").map((s) => s.trim()).filter(Boolean),
    });
    state.apps.showCreate = false;
    state.apps.createForm = emptyCreateForm();
    flash(state, "success", "App registered");
    await loadApps(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.apps.busy = false;
    state.requestUpdate?.();
  }
}

export async function updateApp(state: { apps: AppsState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  if (!state.apps.editApp) return;
  const a = state.apps.editApp;
  state.apps.busy = true;
  state.requestUpdate?.();
  try {
    await client.request("apps.update", {
      id: a.id,
      name: a.name,
      description: a.description,
      type: a.type,
      url: a.url ?? null,
      status: a.status,
      businessId: a.businessId ?? null,
      directoryId: a.directoryId ?? null,
      tags: a.tags,
      featured: a.featured,
      meta: a.meta,
    });
    state.apps.editApp = null;
    flash(state, "success", "Saved");
    await loadApps(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.apps.busy = false;
    state.requestUpdate?.();
  }
}

export async function deleteApp(state: { apps: AppsState; requestUpdate?: () => void }, client: GatewayBrowserClient, id: string, name: string): Promise<void> {
  if (!confirm(`Remove "${name}" from the registry? The underlying source (project/directory/etc.) is left in place.`)) return;
  try {
    await client.request("apps.delete", { id });
    flash(state, "success", "Removed");
    await loadApps(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function toggleFeatured(state: { apps: AppsState; requestUpdate?: () => void }, client: GatewayBrowserClient, id: string): Promise<void> {
  try {
    await client.request("apps.featured.toggle", { id });
    await loadApps(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  }
}

export async function backfillRegistry(state: { apps: AppsState; requestUpdate?: () => void }, client: GatewayBrowserClient): Promise<void> {
  state.apps.busy = true;
  state.requestUpdate?.();
  try {
    const res = (await client.request("apps.backfill", {})) as {
      summary: {
        created: Record<string, number>;
        updated: Record<string, number>;
        scanned: Record<string, number>;
      };
    };
    const totals = (rec: Record<string, number>) => Object.values(rec).reduce((a, b) => a + b, 0);
    flash(state, "success", `Backfill done — ${totals(res.summary.created)} new, ${totals(res.summary.updated)} updated, ${totals(res.summary.scanned)} scanned`);
    await loadApps(state, client);
  } catch (err) {
    flash(state, "error", err instanceof Error ? err.message : String(err));
  } finally {
    state.apps.busy = false;
    state.requestUpdate?.();
  }
}

// ── Local mutators ──────────────────────────────────────────

export function setFilterType(state: { apps: AppsState; requestUpdate?: () => void }, type: AppType | "all"): void {
  state.apps.filterType = type;
  state.requestUpdate?.();
}
export function setFilterBusiness(state: { apps: AppsState; requestUpdate?: () => void }, id: string): void {
  state.apps.filterBusiness = id;
  state.requestUpdate?.();
}
export function setFilterFeatured(state: { apps: AppsState; requestUpdate?: () => void }, v: boolean): void {
  state.apps.filterFeatured = v;
  state.requestUpdate?.();
}
export function setSearch(state: { apps: AppsState; requestUpdate?: () => void }, value: string): void {
  state.apps.search = value;
  state.requestUpdate?.();
}
export function openCreate(state: { apps: AppsState; requestUpdate?: () => void }): void {
  state.apps.showCreate = true;
  state.apps.createForm = emptyCreateForm();
  state.requestUpdate?.();
}
export function closeCreate(state: { apps: AppsState; requestUpdate?: () => void }): void {
  state.apps.showCreate = false;
  state.requestUpdate?.();
}
export function updateCreateField<K extends keyof AppsState["createForm"]>(
  state: { apps: AppsState; requestUpdate?: () => void }, field: K, value: AppsState["createForm"][K],
): void {
  state.apps.createForm[field] = value;
  state.requestUpdate?.();
}
export function openEdit(state: { apps: AppsState; requestUpdate?: () => void }, app: App): void {
  state.apps.editApp = { ...app };
  state.requestUpdate?.();
}
export function closeEdit(state: { apps: AppsState; requestUpdate?: () => void }): void {
  state.apps.editApp = null;
  state.requestUpdate?.();
}
export function patchEdit<K extends keyof App>(
  state: { apps: AppsState; requestUpdate?: () => void }, field: K, value: App[K],
): void {
  if (!state.apps.editApp) return;
  state.apps.editApp = { ...state.apps.editApp, [field]: value };
  state.requestUpdate?.();
}
