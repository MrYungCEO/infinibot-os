/**
 * Directory Registry Controller
 * 
 * Maps local directories to projects, Notion databases, and agents.
 */

import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";

// ── Types ──────────────────────────────────────────

export interface DirectoryEntry {
    id: string;
    path: string;
    name: string;
    description?: string;
    notionDatabaseId?: string;
    notionPageId?: string;
    projectId?: string;
    agentId?: string;
    tags?: string[];
    nodeIds?: string[];
    icon?: string;
    gitRemote?: string;
    active: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface DirectoriesState {
    loading: boolean;
    loaded: boolean; // true once loadDirectories has run at least once
    error: string | null;
    entries: DirectoryEntry[];
    selectedId: string | null;
    editingEntry: Partial<DirectoryEntry> | null;
    creating: boolean;
    searchQuery: string;
    projects: Array<{ id: string; name: string }>;
    agents: Array<{ id: string; name: string }>;
    notionDatabases: Array<{ id: string; title: string }>;
    fedNodes: Array<{ id: string; name: string; online?: boolean; isLocal?: boolean }>;
    deviceFilter: string | null;
}

export function createInitialDirectoriesState(): DirectoriesState {
    return {
        loading: false,
        loaded: false,
        error: null,
        entries: [],
        selectedId: null,
        editingEntry: null,
        creating: false,
        searchQuery: "",
        projects: [],
        agents: [],
        notionDatabases: [],
        fedNodes: [],
        deviceFilter: null,
    };
}

// ── State accessor ──────────────────────────────────

function getState(state: AppViewState): DirectoriesState {
    if (!(state as any).directoriesState) {
        (state as any).directoriesState = createInitialDirectoriesState();
    }
    return (state as any).directoriesState;
}

export function getDirectoriesState(state: AppViewState): DirectoriesState {
    return getState(state);
}

// ── Actions ──────────────────────────────────────────

export async function loadDirectories(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
    const ds = getState(state);
    ds.loading = true;
    ds.error = null;
    state.requestUpdate?.();

    try {
        const entries = await client.request("directories.list", {}) as DirectoryEntry[];
        ds.entries = Array.isArray(entries) ? entries : [];
        ds.error = null;
    } catch (err: any) {
        console.warn("[directories] list failed:", err);
        ds.error = err.message || "Failed to load directories";
        ds.entries = [];
    } finally {
        ds.loaded = true;
        ds.loading = false;
        state.requestUpdate?.();
    }
}

/** Force-reload: list entries + project/agent/db dropdowns. */
export async function reloadAll(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
    await Promise.all([
        loadDirectories(state, client),
        loadRelatedData(state, client),
    ]);
}

export async function loadRelatedData(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
    const ds = getState(state);

    // Load projects. kanban.projects.list serves the local store (Notion is
    // only an optional mirror). Log failures so the user can see *why* the
    // dropdown is empty rather than silently swallowing.
    try {
        const projects = await client.request("kanban.projects.list", {}) as any;
        const list: any[] = Array.isArray(projects)
            ? projects
            : Array.isArray(projects?.projects)
                ? projects.projects
                : [];
        ds.projects = list.map((p: any) => ({
            id: p.id || p.notionId,
            name: p.name || p.title || "Untitled",
        })).filter((p) => p.id);
    } catch (err) {
        console.warn("[directories] kanban.projects.list failed:", err);
        ds.projects = [];
    }

    // Load agents from config. Old code called "gateway:config.get" — that
    // method does not exist (the registered one is plain "config.get"); the
    // failed request was being swallowed silently and the agent dropdown
    // therefore stayed empty.
    try {
        const cfg = await client.request("config.get", {}) as any;
        const list = cfg?.config?.agents?.list ?? cfg?.agents?.list ?? [];
        ds.agents = list.map((a: any) => ({
            id: a.id || "main",
            name: a.name || a.id || "main",
        }));
    } catch {
        ds.agents = [];
    }

    // Load Notion databases. The handler returns `{ databases: [...] }`,
    // not a bare array — the previous code threw the result away because
    // Array.isArray({databases:[]}) is false, so the dropdown stayed empty.
    try {
        const res = await client.request("notion.db.list", {}) as any;
        const list: any[] = Array.isArray(res?.databases)
            ? res.databases
            : Array.isArray(res)
                ? res
                : [];
        ds.notionDatabases = list.map((d: any) => ({
            id: d.id || d.databaseId || "",
            title: d.title || d.name || "Untitled DB",
        })).filter((d) => d.id);
    } catch (err) {
        console.warn("[directories] notion.db.list failed:", err);
        ds.notionDatabases = [];
    }

    // Load federation nodes for device picker
    try {
        const r = await client.request("federation.nodes.list", {}) as any;
        ds.fedNodes = Array.isArray(r?.nodes)
            ? r.nodes.map((n: any) => ({
                id: n.id || n.nodeId,
                name: n.name || n.hostname || n.id,
                online: n.online ?? n.connected ?? true,
                isLocal: n.isLocal ?? false,
            })).filter((n: any) => n.id)
            : [];
    } catch {
        ds.fedNodes = [];
    }

    state.requestUpdate?.();
}

export function selectDirectory(state: AppViewState, id: string | null): void {
    const ds = getState(state);
    ds.selectedId = id;
    ds.editingEntry = id ? { ...ds.entries.find((e) => e.id === id) } : null;
    ds.creating = false;
    state.requestUpdate?.();
}

export function startCreating(state: AppViewState): void {
    const ds = getState(state);
    ds.creating = true;
    ds.selectedId = null;
    ds.editingEntry = { name: "", path: "", active: true };
    state.requestUpdate?.();
}

export function updateEditingField(state: AppViewState, field: string, value: any): void {
    const ds = getState(state);
    if (!ds.editingEntry) return;
    (ds.editingEntry as any)[field] = value;
    state.requestUpdate?.();
}

export async function saveDirectory(state: AppViewState, client: GatewayBrowserClient): Promise<void> {
    const ds = getState(state);
    if (!ds.editingEntry) return;

    // Validate up-front so the user sees a clear message instead of a
    // silent server-side rejection.
    const path = (ds.editingEntry.path || "").trim();
    const name = (ds.editingEntry.name || "").trim();
    if (!path || !name) {
        ds.error = "Both Name and Path are required.";
        state.requestUpdate?.();
        return;
    }

    ds.loading = true;
    ds.error = null;
    state.requestUpdate?.();

    const isCreating = ds.creating;
    try {
        if (isCreating) {
            const payload = {
                path,
                name,
                description: ds.editingEntry.description,
                notionDatabaseId: ds.editingEntry.notionDatabaseId,
                notionPageId: ds.editingEntry.notionPageId,
                projectId: ds.editingEntry.projectId,
                agentId: ds.editingEntry.agentId,
                tags: ds.editingEntry.tags,
                nodeIds: ds.editingEntry.nodeIds,
                icon: ds.editingEntry.icon,
                gitRemote: ds.editingEntry.gitRemote,
                active: ds.editingEntry.active !== false,
            };
            console.log("[directories] create →", payload);
            const result = await client.request("directories.create", payload);
            console.log("[directories] create ✓", result);
        } else if (ds.selectedId) {
            const payload = { id: ds.selectedId, ...ds.editingEntry, path, name };
            console.log("[directories] update →", payload);
            const result = await client.request("directories.update", payload);
            console.log("[directories] update ✓", result);
        } else {
            // No selectedId AND not creating → nothing meaningful to save.
            ds.error = "Nothing to save (open an existing entry or click + Add).";
            ds.loading = false;
            state.requestUpdate?.();
            return;
        }
        ds.creating = false;
        ds.editingEntry = null;
        ds.selectedId = null;
        ds.error = null;
        await loadDirectories(state, client);
    } catch (err: any) {
        // Keep editingEntry around so the user can fix the input and retry
        // without retyping. Surface the raw server message — UNIQUE
        // constraints, missing scopes, etc. now actually show up.
        const message = err?.message || String(err) || "Failed to save directory";
        console.error("[directories] save failed:", message, err);
        ds.error = message;
        ds.loading = false;
        state.requestUpdate?.();
    }
}

/**
 * Create a directory entry directly from a payload (used by the federation
 * file explorer's "Save to InfiniBot directories" action). Unlike
 * {@link saveDirectory} this does not touch the editing/creating UI state —
 * it just persists and refreshes the registered list. Returns a result object
 * so the caller (a dialog) can keep itself open on failure.
 */
export async function createDirectoryEntry(
    state: AppViewState,
    client: GatewayBrowserClient,
    payload: {
        path: string;
        name: string;
        peerId?: string;
        peerLabel?: string;
        description?: string;
        tags?: string[];
        projectId?: string;
        agentId?: string;
    },
): Promise<{ ok: boolean; error?: string }> {
    try {
        await client.request("directories.create", payload);
        await loadDirectories(state, client);
        return { ok: true };
    } catch (err: any) {
        const message = err?.message || String(err) || "Failed to save directory";
        console.error("[directories] createDirectoryEntry failed:", message, err);
        return { ok: false, error: message };
    }
}

export async function deleteDirectory(state: AppViewState, client: GatewayBrowserClient, id: string): Promise<void> {
    const ds = getState(state);
    ds.loading = true;
    state.requestUpdate?.();

    try {
        await client.request("directories.delete", { id });
        ds.selectedId = null;
        ds.editingEntry = null;
        await loadDirectories(state, client);
    } catch (err: any) {
        ds.error = err.message || "Failed to delete directory";
        ds.loading = false;
        state.requestUpdate?.();
    }
}

export function setSearchQuery(state: AppViewState, query: string): void {
    const ds = getState(state);
    ds.searchQuery = query;
    state.requestUpdate?.();
}

export function getFilteredEntries(state: AppViewState): DirectoryEntry[] {
    const ds = getState(state);
    if (!ds.searchQuery) return ds.entries;
    const q = ds.searchQuery.toLowerCase();
    return ds.entries.filter(
        (e) =>
            e.name.toLowerCase().includes(q) ||
            e.path.toLowerCase().includes(q) ||
            (e.description || "").toLowerCase().includes(q) ||
            (e.agentId || "").toLowerCase().includes(q) ||
            (e.tags || []).some((t) => t.toLowerCase().includes(q)),
    );
}
