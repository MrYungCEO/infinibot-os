/**
 * Directory Registry View
 * 
 * Split-pane layout: sidebar list + detail/edit panel
 */

import { html, nothing, TemplateResult } from "lit";
import { baAurora } from "./ba-glass";
import "./ba-glass/directories.css";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { renderFederationNodeMultiSelect, renderFederationNodeChips } from "../components/federation-chip.js";
import {
    type DirectoryEntry,
    type DirectoriesState,
    getDirectoriesState,
    loadDirectories,
    loadRelatedData,
    reloadAll,
    selectDirectory,
    startCreating,
    updateEditingField,
    saveDirectory,
    deleteDirectory,
    setSearchQuery,
    getFilteredEntries,
    createDirectoryEntry,
} from "../controllers/directories.js";
// Reuse the file-row rendering helpers from the Files view rather than
// re-deriving icons/sizes. These were made exportable for this view.
import { fileIcon, formatSize as formatFileSize, formatDate as formatFileDate } from "./files.js";
import type { FileEntry, ExternalRoot } from "../controllers/files.js";
import { toastSuccess, toastInfo, toastError } from "./toast-notifications.js";

// ── Helpers ──────────────────────────────────────────

function formatDate(ms: number): string {
    if (!ms) return "—";
    return new Date(ms).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

// ── Federation File Explorer (two-pane) ──────────────
//
// Tasks 3 + 4 + 6 of the Federation-wide File Explorer fold in here. The
// explorer is a second "tab" of the directories view; the existing
// registered-directories list (sidebar + detail) is unchanged and reachable
// via the tab bar.
//
// State is module-scoped, matching the pattern already used by files.ts
// (its `expandedFolders` Set). Re-renders are triggered with
// `state.requestUpdate?.()` after mutating this state.

interface ExplorerPeer {
    id: string;
    name: string;
    /** Reachability — derived from federation.nodes.list `online`. */
    online: boolean;
    isLocal: boolean;
    /** TODO: perms — federation does not surface per-peer read-only yet. */
    readOnly: boolean;
}

interface PeerCache {
    /** mainRoot + external roots from federation.files.roots.list. */
    roots: ExternalRoot[] | null;
    /** path -> directory listing (federation.files.list items). */
    listings: Map<string, FileEntry[]>;
    cachedAt: number;
}

/**
 * Last-known tree per peer (task 3). Survives a peer dropping mid-session so
 * the UI shows stale data instead of going blank; entries served from here
 * after a failed refresh are flagged stale.
 */
const peerTreeCache = new Map<string, PeerCache>();

// Transient UI state.
let explorerTab: "explorer" | "registered" = "explorer";
const expandedPeers = new Set<string>();
const expandedFolders = new Set<string>(); // key: `${peerId}::${path}`
const inFlight = new Set<string>();         // loading keys (roots / folders)

interface RightPaneState {
    peerId: string;
    peerLabel: string;
    path: string;
    rootLabel: string;
    items: FileEntry[];
    loading: boolean;
    stale: boolean;
    error: string | null;
}
let rightPane: RightPaneState | null = null;

interface SaveDialogState {
    peerId: string;
    peerLabel: string;
    path: string;
    name: string;
    description: string;
    tags: string;
    projectId: string;
    agentId: string;
    saving: boolean;
    error: string | null;
}
let saveDialog: SaveDialogState | null = null;

interface ExplorerContextMenu {
    x: number;
    y: number;
    peerId: string;
    peerLabel: string;
    folder: FileEntry;
}
let explorerMenu: ExplorerContextMenu | null = null;

function basename(p: string): string {
    if (!p) return p;
    const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

function getPeerCache(peerId: string): PeerCache {
    let c = peerTreeCache.get(peerId);
    if (!c) {
        c = { roots: null, listings: new Map(), cachedAt: 0 };
        peerTreeCache.set(peerId, c);
    }
    return c;
}

/** Build the explorer peer list: local peer first, then federation nodes. */
function getExplorerPeers(ds: DirectoriesState): ExplorerPeer[] {
    const local: ExplorerPeer = {
        id: "local",
        name: "This Device",
        online: true,
        isLocal: true,
        readOnly: false, // TODO: perms
    };
    const remotes: ExplorerPeer[] = (ds.fedNodes || [])
        .filter((n) => !n.isLocal && n.id !== "local")
        .map((n) => ({
            id: n.id,
            name: n.name || n.id,
            online: n.online !== false,
            isLocal: false,
            readOnly: false, // TODO: perms — treat all peers as RW until surfaced
        }));
    return [local, ...remotes];
}

// ── Explorer data loaders ─────────────────────────────

async function loadPeerRoots(state: AppViewState, client: GatewayBrowserClient, peerId: string): Promise<void> {
    const key = `roots::${peerId}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    state.requestUpdate?.();
    try {
        const res = await client.request("federation.files.roots.list", { peerId }) as {
            roots?: ExternalRoot[];
            mainRoot?: { id: string; path: string; name: string };
        };
        const roots: ExternalRoot[] = [];
        if (res?.mainRoot) {
            roots.push({ id: res.mainRoot.id, path: res.mainRoot.path, name: res.mainRoot.name, addedAt: 0 });
        }
        if (Array.isArray(res?.roots)) roots.push(...res.roots);
        const cache = getPeerCache(peerId);
        cache.roots = roots;
        cache.cachedAt = Date.now();
    } catch (err: any) {
        // Keep any stale cached roots; only surface an error when we have none.
        const cache = getPeerCache(peerId);
        if (!cache.roots) {
            toastError(`Could not reach ${peerId}: ${err?.message || "load failed"}`);
        }
    } finally {
        inFlight.delete(key);
        state.requestUpdate?.();
    }
}

/** Load a directory listing for the left tree (folders) and cache it. */
async function loadFolderListing(state: AppViewState, client: GatewayBrowserClient, peerId: string, path: string): Promise<void> {
    const key = `${peerId}::${path}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    state.requestUpdate?.();
    try {
        const res = await client.request("federation.files.list", { peerId, path }) as { items?: FileEntry[] };
        const items = Array.isArray(res?.items) ? res.items : [];
        getPeerCache(peerId).listings.set(path, items);
    } catch (err: any) {
        // Leave stale cache intact; the right pane handles user-facing errors.
        if (!getPeerCache(peerId).listings.has(path)) {
            toastError(`Listing failed for ${peerId}: ${err?.message || "error"}`);
        }
    } finally {
        inFlight.delete(key);
        state.requestUpdate?.();
    }
}

/** Open a folder in the right pane (breadcrumb / left-tree click). */
async function openInRightPane(
    state: AppViewState,
    client: GatewayBrowserClient,
    peer: { id: string; name: string },
    path: string,
    rootLabel: string,
): Promise<void> {
    rightPane = {
        peerId: peer.id,
        peerLabel: peer.name,
        path,
        rootLabel,
        items: rightPane?.peerId === peer.id ? rightPane.items : [],
        loading: true,
        stale: false,
        error: null,
    };
    state.requestUpdate?.();
    try {
        const res = await client.request("federation.files.list", { peerId: peer.id, path }) as { items?: FileEntry[] };
        const items = Array.isArray(res?.items) ? res.items : [];
        getPeerCache(peer.id).listings.set(path, items);
        if (rightPane && rightPane.peerId === peer.id && rightPane.path === path) {
            rightPane.items = items;
            rightPane.loading = false;
            rightPane.stale = false;
            rightPane.error = null;
        }
    } catch (err: any) {
        // Fall back to cached listing if we have one; flag it stale.
        const cached = getPeerCache(peer.id).listings.get(path);
        if (rightPane && rightPane.peerId === peer.id && rightPane.path === path) {
            rightPane.loading = false;
            if (cached) {
                rightPane.items = cached;
                rightPane.stale = true;
                rightPane.error = null;
            } else {
                rightPane.items = [];
                rightPane.error = err?.message || "Failed to load folder";
            }
        }
    } finally {
        state.requestUpdate?.();
    }
}

function toggleFolder(state: AppViewState, client: GatewayBrowserClient, peerId: string, path: string): void {
    const key = `${peerId}::${path}`;
    if (expandedFolders.has(key)) {
        expandedFolders.delete(key);
    } else {
        expandedFolders.add(key);
        if (!getPeerCache(peerId).listings.has(path)) {
            void loadFolderListing(state, client, peerId, path);
        }
    }
    state.requestUpdate?.();
}

function emitTransferRequest(srcPeerId: string, srcPath: string, dstPeerId: string, dstPath: string): void {
    // The transfer drawer + progress subscription is a parallel task. We only
    // emit the request event here; the transport is wired elsewhere.
    document.dispatchEvent(new CustomEvent("federation-file-transfer-request", {
        detail: { srcPeerId, srcPath, dstPeerId, dstPath },
    }));
    toastInfo(`Transfer requested: ${basename(srcPath)} → ${dstPath || "/"}`);
}

function readDragPayload(e: DragEvent): { peerId: string; path: string } | null {
    const raw = e.dataTransfer?.getData("application/x-infinibot-file");
    if (!raw) return null;
    try {
        const p = JSON.parse(raw);
        if (p && typeof p.peerId === "string" && typeof p.path === "string") return p;
    } catch { /* ignore */ }
    return null;
}

// ── Main Render ──────────────────────────────────────

export function renderDirectories(
    state: AppViewState,
    client: GatewayBrowserClient | null,
): TemplateResult {
    const ds = getDirectoriesState(state);

    // Auto-load once on first mount. The previous condition keyed off
    // entries.length === 0 which kept retriggering on every re-render
    // whenever the registry was genuinely empty — flooding the gateway
    // with requests. Use a one-shot `loaded` flag instead.
    if (!ds.loaded && !ds.loading && client) {
        void loadDirectories(state, client);
        void loadRelatedData(state, client);
    }

    return html`
      <div class="directories-page ba-glass">
        ${baAurora()}
        <div class="directories-container g-panel" style="display:flex;flex-direction:column;height:100%;gap:0;overflow:hidden;">
            ${renderTabBar(state, client, ds)}
            ${explorerTab === "explorer"
                ? renderExplorer(state, ds, client)
                : html`<div class="dir-content">
                    ${renderSidebar(state, ds, client)}
                    ${renderDetailPanel(state, ds, client)}
                  </div>`}
        </div>
        ${renderSaveDialog(state, client, ds)}
        ${renderExplorerMenu(state)}
      </div>
        <style>
            .directories-container {
                font-family: var(--font-mono, 'JetBrains Mono', monospace);
                color: var(--text-primary, #e0e0e0);
            }
            .dir-sidebar {
                width: 320px;
                min-width: 280px;
                border-right: 1px solid var(--border-color, #333);
                display: flex;
                flex-direction: column;
                background: var(--bg-secondary, #1a1a1a);
            }
            .dir-sidebar-header {
                padding: 16px;
                border-bottom: 1px solid var(--border-color, #333);
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .dir-sidebar-title {
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            .dir-sidebar-title h3 {
                margin: 0;
                font-size: 14px;
                color: var(--text-secondary, #aaa);
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            .dir-search {
                width: 100%;
                padding: 8px 12px;
                background: var(--bg-primary, #111);
                border: 1px solid var(--border-color, #333);
                border-radius: 6px;
                color: var(--text-primary, #e0e0e0);
                font-size: 13px;
                font-family: inherit;
                outline: none;
            }
            .dir-search:focus { border-color: var(--g-primary); }
            .dir-list {
                flex: 1;
                overflow-y: auto;
                padding: 8px;
            }
            .dir-item {
                padding: 10px 12px;
                border-radius: 6px;
                cursor: pointer;
                margin-bottom: 2px;
                transition: background 0.15s;
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .dir-item:hover { background: var(--bg-hover, #252525); }
            .dir-item.selected { background: color-mix(in srgb, var(--g-primary) 15%, transparent); border-left: 3px solid var(--g-primary); }
            .dir-item-icon { font-size: 20px; flex-shrink: 0; }
            .dir-item-info { flex: 1; min-width: 0; }
            .dir-item-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .dir-item-path { font-size: 11px; color: var(--text-muted, #666); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .dir-item-badges { display: flex; gap: 4px; margin-top: 4px; }
            .dir-badge {
                font-size: 10px;
                padding: 1px 6px;
                border-radius: 3px;
                background: color-mix(in srgb, var(--g-primary) 15%, transparent);
                color: var(--g-primary);
            }
            .dir-badge.agent { background: rgba(100,200,255,0.15); color: #64C8FF; }
            .dir-badge.inactive { background: rgba(255,100,100,0.15); color: #FF6464; }
            .dir-detail {
                flex: 1;
                overflow-y: auto;
                padding: 24px;
                background: var(--bg-primary, #111);
            }
            .dir-detail-empty {
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100%;
                color: var(--text-muted, #666);
                font-size: 14px;
            }
            .dir-form { max-width: 600px; }
            .dir-form-group {
                margin-bottom: 16px;
            }
            .dir-form-group label {
                display: block;
                font-size: 11px;
                color: var(--text-secondary, #aaa);
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin-bottom: 4px;
            }
            .dir-form-group input,
            .dir-form-group textarea,
            .dir-form-group select {
                width: 100%;
                padding: 8px 12px;
                background: var(--bg-secondary, #1a1a1a);
                border: 1px solid var(--border-color, #333);
                border-radius: 6px;
                color: var(--text-primary, #e0e0e0);
                font-size: 13px;
                font-family: inherit;
                outline: none;
                box-sizing: border-box;
            }
            .dir-form-group input:focus,
            .dir-form-group textarea:focus,
            .dir-form-group select:focus { border-color: var(--g-primary); }
            .dir-form-group textarea { min-height: 60px; resize: vertical; }
            .dir-form-row { display: flex; gap: 12px; }
            .dir-form-row .dir-form-group { flex: 1; }
            .dir-form-actions {
                display: flex;
                gap: 8px;
                margin-top: 20px;
                padding-top: 16px;
                border-top: 1px solid var(--border-color, #333);
            }
            .dir-btn {
                padding: 8px 16px;
                border-radius: 6px;
                border: 1px solid var(--border-color, #333);
                background: var(--bg-secondary, #1a1a1a);
                color: var(--text-primary, #e0e0e0);
                font-size: 13px;
                font-family: inherit;
                cursor: pointer;
                transition: all 0.15s;
            }
            .dir-btn:hover { background: var(--bg-hover, #252525); }
            .dir-btn.primary { background: var(--g-primary); color: #000; border-color: var(--g-primary); font-weight: 600; }
            .dir-btn.primary:hover { background: #E5C04B; }
            .dir-btn.danger { color: #FF6464; border-color: #FF6464; }
            .dir-btn.danger:hover { background: rgba(255,100,100,0.15); }
            .dir-btn.small { padding: 4px 10px; font-size: 12px; }
            .dir-section-title {
                font-size: 12px;
                color: var(--text-secondary, #aaa);
                text-transform: uppercase;
                letter-spacing: 0.05em;
                margin: 24px 0 12px;
                padding-bottom: 8px;
                border-bottom: 1px solid var(--border-color, #333);
            }
            .dir-meta {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
                font-size: 12px;
            }
            .dir-meta-item { color: var(--text-muted, #666); }
            .dir-meta-value { color: var(--text-primary, #e0e0e0); }
            .dir-checkbox-row {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .dir-checkbox-row input[type="checkbox"] {
                width: auto;
                accent-color: var(--g-primary);
            }

            /* ── Tab bar ── */
            .dir-tabbar {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 8px 12px;
                border-bottom: 1px solid var(--border-color, #333);
                background: var(--bg-secondary, #1a1a1a);
                flex-shrink: 0;
            }
            .dir-tab {
                padding: 6px 14px;
                border-radius: 6px;
                border: 1px solid transparent;
                background: transparent;
                color: var(--text-secondary, #aaa);
                font-size: 12px;
                font-family: inherit;
                cursor: pointer;
                transition: all 0.15s;
            }
            .dir-tab:hover { background: var(--bg-hover, #252525); color: var(--text-primary, #e0e0e0); }
            .dir-tab.active { background: color-mix(in srgb, var(--g-primary) 18%, transparent); color: var(--g-primary); border-color: color-mix(in srgb, var(--g-primary) 35%, transparent); }
            .dir-content { flex: 1; display: flex; overflow: hidden; min-height: 0; }

            /* ── Explorer two-pane ── */
            .fx-explorer { flex: 1; display: flex; overflow: hidden; min-height: 0; }
            .fx-tree-pane {
                width: 320px;
                min-width: 260px;
                border-right: 1px solid var(--border-color, #333);
                display: flex;
                flex-direction: column;
                background: var(--bg-secondary, #1a1a1a);
                overflow-y: auto;
            }
            .fx-tree-head {
                padding: 10px 14px;
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: var(--text-muted, #666);
                border-bottom: 1px solid var(--border-color, #333);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .fx-peer-row, .fx-tree-item {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 10px;
                cursor: pointer;
                font-size: 12px;
                color: var(--text-primary, #e0e0e0);
                border-radius: 4px;
                margin: 1px 4px;
                user-select: none;
                white-space: nowrap;
            }
            .fx-peer-row:hover, .fx-tree-item:hover { background: var(--bg-hover, #252525); }
            .fx-tree-item.active { background: color-mix(in srgb, var(--g-primary) 15%, transparent); color: var(--g-primary); }
            .fx-tree-item.drop-target { background: color-mix(in srgb, var(--g-primary) 25%, transparent); outline: 1px dashed var(--g-primary); }
            .fx-peer-row.offline { opacity: 0.45; }
            .fx-chevron { width: 12px; font-size: 10px; opacity: 0.6; text-align: center; flex-shrink: 0; }
            .fx-name { overflow: hidden; text-overflow: ellipsis; }
            .fx-pill {
                font-size: 9px;
                padding: 0 5px;
                border-radius: 3px;
                line-height: 16px;
                height: 16px;
                flex-shrink: 0;
            }
            .fx-pill.ro { background: rgba(255,184,74,0.18); color: #FFB84A; }
            .fx-pill.stale { background: rgba(160,160,160,0.18); color: #aaa; }
            .fx-pill.offline { background: rgba(255,100,100,0.15); color: #FF6464; }
            .fx-spin { font-size: 10px; opacity: 0.6; }

            /* Right pane */
            .fx-list-pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--bg-primary, #111); min-width: 0; }
            .fx-breadcrumb {
                display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
                padding: 10px 16px; border-bottom: 1px solid var(--border-color, #333);
                font-size: 12px; color: var(--text-muted, #888);
            }
            .fx-crumb { cursor: pointer; color: var(--g-primary); opacity: 0.75; }
            .fx-crumb:hover { opacity: 1; text-decoration: underline; }
            .fx-crumb.active { color: var(--text-primary, #e0e0e0); opacity: 1; cursor: default; }
            .fx-crumb-sep { opacity: 0.4; }
            .fx-list { flex: 1; overflow-y: auto; }
            .fx-list-head, .fx-list-row {
                display: grid;
                grid-template-columns: 1fr 90px 120px 70px;
                gap: 8px;
                padding: 7px 16px;
                font-size: 12px;
            }
            .fx-list-head { color: var(--text-muted, #888); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border-color, #333); }
            .fx-list-row { color: var(--text-primary, #e0e0e0); border-bottom: 1px solid rgba(255,255,255,0.03); cursor: pointer; }
            .fx-list-row:hover { background: color-mix(in srgb, var(--g-primary) 8%, transparent); }
            .fx-list-row[draggable="true"]:active { opacity: 0.6; }
            .fx-list-row .fx-cell-name { display: flex; align-items: center; gap: 8px; overflow: hidden; }
            .fx-list-row .fx-cell-name span { overflow: hidden; text-overflow: ellipsis; }
            .fx-cell-muted { color: var(--text-muted, #888); font-size: 11px; }
            .fx-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 8px; color: var(--text-muted, #666); font-size: 13px; }
            .fx-empty-icon { font-size: 40px; opacity: 0.4; }
            .fx-banner { padding: 8px 16px; font-size: 12px; }
            .fx-banner.error { background: rgba(255,100,100,0.1); color: #FF6464; }
            .fx-banner.stale { background: rgba(160,160,160,0.12); color: #bbb; }

            /* Context menu + dialog (reuses inline-overlay pattern from files.ts) */
            .fx-ctx {
                position: fixed; z-index: 1000;
                background: rgba(20,20,20,0.97);
                border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
                border-radius: 6px; padding: 4px 0; min-width: 200px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            }
            .fx-ctx-item { display: flex; align-items: center; gap: 8px; padding: 7px 14px; font-size: 12px; color: var(--text-primary, #e0e0e0); cursor: pointer; }
            .fx-ctx-item:hover { background: color-mix(in srgb, var(--g-primary) 15%, transparent); }
            .fx-dialog-backdrop {
                position: fixed; inset: 0; z-index: 1001;
                background: rgba(0,0,0,0.6);
                display: flex; align-items: center; justify-content: center;
            }
            .fx-dialog {
                width: 480px; max-width: 92vw; max-height: 88vh; overflow-y: auto;
                background: var(--bg-secondary, #1a1a1a);
                border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
                border-radius: 10px; padding: 22px;
                font-family: var(--font-mono, 'JetBrains Mono', monospace);
            }
            .fx-dialog h3 { margin: 0 0 4px; font-size: 16px; color: var(--g-primary); }
            .fx-dialog .fx-dialog-sub { font-size: 11px; color: var(--text-muted, #888); margin-bottom: 16px; word-break: break-all; }
        </style>
    `;
}

// ── Tab bar ──────────────────────────────────────────

function renderTabBar(state: AppViewState, client: GatewayBrowserClient | null, ds: DirectoriesState): TemplateResult {
    const setTab = (t: "explorer" | "registered") => { explorerTab = t; state.requestUpdate?.(); };
    return html`
        <div class="dir-tabbar">
            <button class="dir-tab ${explorerTab === "explorer" ? "active" : ""}" @click=${() => setTab("explorer")}>🌐 Federation Explorer</button>
            <button class="dir-tab ${explorerTab === "registered" ? "active" : ""}" @click=${() => setTab("registered")}>
                📂 Registered Directories ${ds.entries.length ? html`<span style="opacity:0.6;">(${ds.entries.length})</span>` : nothing}
            </button>
            <div style="flex:1;"></div>
            <button class="dir-btn small" title="Reload"
                ?disabled=${ds.loading}
                @click=${() => { peerTreeCache.clear(); client && reloadAll(state, client); state.requestUpdate?.(); }}>↻</button>
        </div>
    `;
}

// ── Explorer: two-pane ────────────────────────────────

function renderExplorer(state: AppViewState, ds: DirectoriesState, client: GatewayBrowserClient | null): TemplateResult {
    if (!client) {
        return html`<div class="dir-content"><div class="fx-empty">Gateway not connected</div></div>`;
    }
    const peers = getExplorerPeers(ds);
    return html`
        <div class="fx-explorer">
            <div class="fx-tree-pane">
                <div class="fx-tree-head">
                    <span>Peers</span>
                    <span style="opacity:0.6;">${peers.length}</span>
                </div>
                ${peers.map((peer) => renderPeerNode(state, client, peer))}
            </div>
            ${renderRightPane(state, client)}
        </div>
    `;
}

function renderPeerNode(state: AppViewState, client: GatewayBrowserClient, peer: ExplorerPeer): TemplateResult {
    const expanded = expandedPeers.has(peer.id);
    const loading = inFlight.has(`roots::${peer.id}`);
    const cache = peerTreeCache.get(peer.id);
    const isStale = !peer.online && !!cache?.roots;

    const toggle = () => {
        if (expanded) {
            expandedPeers.delete(peer.id);
        } else {
            expandedPeers.add(peer.id);
            if (!cache?.roots) void loadPeerRoots(state, client, peer.id);
        }
        state.requestUpdate?.();
    };

    return html`
        <div>
            <div class="fx-peer-row ${peer.online ? "" : "offline"}" @click=${toggle} title=${peer.id}>
                <span class="fx-chevron">${expanded ? "▾" : "▸"}</span>
                <span>${peer.isLocal ? "🖥️" : "🛰️"}</span>
                <span class="fx-name" style="flex:1;">${peer.name}</span>
                ${loading ? html`<span class="fx-spin">⏳</span>` : nothing}
                <!-- TODO: perms — render real read-only state once federation surfaces it -->
                ${peer.readOnly ? html`<span class="fx-pill ro">RO</span>` : nothing}
                ${isStale ? html`<span class="fx-pill stale">stale</span>` : nothing}
                ${!peer.online ? html`<span class="fx-pill offline">offline</span>` : nothing}
            </div>
            ${expanded && cache?.roots ? html`
                <div>
                    ${cache.roots.map((root) => {
                        // The main root (id "main") is browsed with an empty path —
                        // files.list rejects its absolute FILES_ROOT path. External
                        // roots are addressed by their absolute path, which matches a
                        // registered root server-side.
                        const browsePath = root.id === "main" ? "" : root.path;
                        return renderFolderNode(state, client, peer, browsePath, root.name || basename(root.path) || "/", 1);
                    })}
                </div>
            ` : nothing}
        </div>
    `;
}

function renderFolderNode(
    state: AppViewState,
    client: GatewayBrowserClient,
    peer: ExplorerPeer,
    path: string,
    label: string,
    depth: number,
): TemplateResult {
    const key = `${peer.id}::${path}`;
    const expanded = expandedFolders.has(key);
    const loading = inFlight.has(key);
    const listing = peerTreeCache.get(peer.id)?.listings.get(path);
    const subdirs = (listing || []).filter((i) => i.isDirectory);
    const isActive = rightPane?.peerId === peer.id && rightPane?.path === path;

    let dropHover = false;
    const onDrop = (e: DragEvent, el: HTMLElement) => {
        e.preventDefault(); e.stopPropagation();
        el.classList.remove("drop-target");
        const payload = readDragPayload(e);
        if (payload) emitTransferRequest(payload.peerId, payload.path, peer.id, path);
    };

    return html`
        <div>
            <div
                class="fx-tree-item ${isActive ? "active" : ""}"
                style="padding-left:${8 + depth * 14}px"
                @click=${() => { openInRightPane(state, client, peer, path, label); toggleFolder(state, client, peer.id, path); }}
                @dragover=${(e: DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add("drop-target"); }}
                @dragleave=${(e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-target")}
                @drop=${(e: DragEvent) => onDrop(e, e.currentTarget as HTMLElement)}
            >
                <span class="fx-chevron">${expanded ? "▾" : "▸"}</span>
                <span>${expanded ? "📂" : "📁"}</span>
                <span class="fx-name">${label}</span>
                ${loading ? html`<span class="fx-spin">⏳</span>` : nothing}
            </div>
            ${expanded && subdirs.length ? html`
                <div>
                    ${subdirs.map((d) => renderFolderNode(state, client, peer, d.path, d.name, depth + 1))}
                </div>
            ` : nothing}
        </div>
    `;
}

function renderRightPane(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
    if (!rightPane) {
        return html`
            <div class="fx-list-pane">
                <div class="fx-empty">
                    <div class="fx-empty-icon">🗂️</div>
                    <div>Select a folder from a peer to browse its files</div>
                </div>
            </div>
        `;
    }
    const rp = rightPane;
    const peer = { id: rp.peerId, name: rp.peerLabel };

    // Breadcrumbs relative to the chosen root. We can't always know the root
    // boundary, so we render the peer label + each path segment.
    const segments = rp.path ? rp.path.split(/[\\/]/).filter(Boolean) : [];
    const crumbs: { label: string; path: string }[] = [{ label: rp.peerLabel, path: "" }];
    let accum = "";
    const sep = rp.path.includes("\\") ? "\\" : "/";
    for (const seg of segments) {
        accum = accum ? `${accum}${sep}${seg}` : seg;
        crumbs.push({ label: seg, path: accum });
    }

    const dirs = rp.items.filter((i) => i.isDirectory);
    const files = rp.items.filter((i) => !i.isDirectory);
    const ordered = [...dirs, ...files];

    return html`
        <div class="fx-list-pane">
            <div class="fx-breadcrumb">
                ${crumbs.map((c, i) => html`
                    ${i > 0 ? html`<span class="fx-crumb-sep">/</span>` : nothing}
                    <span class="fx-crumb ${i === crumbs.length - 1 ? "active" : ""}"
                        @click=${() => { if (i < crumbs.length - 1) openInRightPane(state, client, peer, c.path, rp.rootLabel); }}>${c.label}</span>
                `)}
            </div>

            ${rp.stale ? html`<div class="fx-banner stale">⚠ Showing cached (stale) listing — ${rp.peerLabel} is unreachable.</div>` : nothing}
            ${rp.error ? html`<div class="fx-banner error">⚠ ${rp.error}</div>` : nothing}

            ${rp.loading ? html`<div class="fx-empty" style="height:auto;padding:40px;">Loading…</div>` : nothing}

            ${!rp.loading && !rp.error && ordered.length === 0 ? html`
                <div class="fx-empty"><div class="fx-empty-icon">📂</div><div>Empty folder</div></div>
            ` : nothing}

            ${!rp.loading && ordered.length > 0 ? html`
                <div class="fx-list-head">
                    <span>Name</span><span>Size</span><span>Modified</span><span>Type</span>
                </div>
                <div class="fx-list">
                    ${ordered.map((file) => renderFileRow(state, client, peer, file))}
                </div>
            ` : nothing}
        </div>
    `;
}

function renderFileRow(
    state: AppViewState,
    client: GatewayBrowserClient,
    peer: { id: string; name: string },
    file: FileEntry,
): TemplateResult {
    const onDrop = (e: DragEvent, el: HTMLElement) => {
        if (!file.isDirectory) return;
        e.preventDefault(); e.stopPropagation();
        el.classList.remove("drop-target");
        const payload = readDragPayload(e);
        if (payload) emitTransferRequest(payload.peerId, payload.path, peer.id, file.path);
    };

    return html`
        <div
            class="fx-list-row"
            draggable="true"
            data-peer-id=${peer.id}
            data-path=${file.path}
            @dragstart=${(e: DragEvent) => {
                e.dataTransfer?.setData("application/x-infinibot-file", JSON.stringify({ peerId: peer.id, path: file.path }));
                e.dataTransfer?.setData("text/plain", file.path);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
            }}
            @dblclick=${() => { if (file.isDirectory) openInRightPane(state, client, peer, file.path, file.name); }}
            @dragover=${(e: DragEvent) => { if (file.isDirectory) { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add("drop-target"); } }}
            @dragleave=${(e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-target")}
            @drop=${(e: DragEvent) => onDrop(e, e.currentTarget as HTMLElement)}
            @contextmenu=${(e: MouseEvent) => {
                if (!file.isDirectory) return;
                e.preventDefault(); e.stopPropagation();
                explorerMenu = { x: e.clientX, y: e.clientY, peerId: peer.id, peerLabel: peer.name, folder: file };
                state.requestUpdate?.();
            }}
        >
            <div class="fx-cell-name">
                <span>${fileIcon(file)}</span>
                <span>${file.name}</span>
            </div>
            <div class="fx-cell-muted">${file.isDirectory ? "—" : formatFileSize(file.size)}</div>
            <div class="fx-cell-muted">${formatFileDate(file.modified)}</div>
            <div class="fx-cell-muted">${file.isDirectory ? "folder" : (file.type || "—")}</div>
        </div>
    `;
}

// ── Explorer context menu ─────────────────────────────

function renderExplorerMenu(state: AppViewState): TemplateResult {
    if (!explorerMenu) return html``;
    const m = explorerMenu;
    const close = () => { explorerMenu = null; state.requestUpdate?.(); };
    return html`
        <div style="position:fixed;inset:0;z-index:999;" @click=${close} @contextmenu=${(e: Event) => { e.preventDefault(); close(); }}>
            <div class="fx-ctx" style="left:${m.x}px;top:${m.y}px;" @click=${(e: Event) => e.stopPropagation()}>
                <div class="fx-ctx-item" @click=${() => {
                    saveDialog = {
                        peerId: m.peerId,
                        peerLabel: m.peerLabel,
                        path: m.folder.path,
                        name: m.folder.name || basename(m.folder.path),
                        description: "",
                        tags: "",
                        projectId: "",
                        agentId: "",
                        saving: false,
                        error: null,
                    };
                    explorerMenu = null;
                    state.requestUpdate?.();
                }}>💾 Save to InfiniBot directories</div>
            </div>
        </div>
    `;
}

// ── Save-to-directories dialog ────────────────────────

function renderSaveDialog(state: AppViewState, client: GatewayBrowserClient | null, ds: DirectoriesState): TemplateResult {
    if (!saveDialog) return html``;
    const d = saveDialog;
    const close = () => { saveDialog = null; state.requestUpdate?.(); };
    const set = (field: keyof SaveDialogState, value: string) => { (d as any)[field] = value; state.requestUpdate?.(); };

    const submit = async () => {
        if (!client) return;
        const name = d.name.trim();
        if (!name) { d.error = "Name is required."; state.requestUpdate?.(); return; }
        d.saving = true; d.error = null; state.requestUpdate?.();
        const res = await createDirectoryEntry(state, client, {
            path: d.path,
            name,
            peerId: d.peerId,
            peerLabel: d.peerLabel,
            description: d.description.trim() || undefined,
            tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean),
            projectId: d.projectId || undefined,
            agentId: d.agentId || undefined,
        });
        if (res.ok) {
            toastSuccess(`Saved "${name}" to directories`);
            saveDialog = null;
            state.requestUpdate?.();
        } else {
            d.saving = false;
            d.error = res.error || "Failed to save";
            state.requestUpdate?.();
        }
    };

    return html`
        <div class="fx-dialog-backdrop" @click=${close}>
            <div class="fx-dialog" @click=${(e: Event) => e.stopPropagation()}>
                <h3>Save to InfiniBot directories</h3>
                <div class="fx-dialog-sub">${d.peerLabel} · ${d.path}</div>

                ${d.error ? html`<div class="fx-banner error" style="border-radius:6px;margin-bottom:12px;">${d.error}</div>` : nothing}

                <div class="dir-form-group">
                    <label>Name *</label>
                    <input type="text" .value=${d.name} @input=${(e: InputEvent) => set("name", (e.target as HTMLInputElement).value)} />
                </div>
                <div class="dir-form-group">
                    <label>Description</label>
                    <textarea .value=${d.description} @input=${(e: InputEvent) => set("description", (e.target as HTMLTextAreaElement).value)}></textarea>
                </div>
                <div class="dir-form-group">
                    <label>Tags (comma-separated)</label>
                    <input type="text" placeholder="e.g. shared, media" .value=${d.tags} @input=${(e: InputEvent) => set("tags", (e.target as HTMLInputElement).value)} />
                </div>
                <div class="dir-form-row">
                    <div class="dir-form-group">
                        <label>Link to Project</label>
                        <select .value=${d.projectId} @change=${(e: Event) => set("projectId", (e.target as HTMLSelectElement).value)}>
                            <option value="">— None —</option>
                            ${ds.projects.map((p) => html`<option value=${p.id} ?selected=${d.projectId === p.id}>${p.name}</option>`)}
                        </select>
                    </div>
                    <div class="dir-form-group">
                        <label>Link to Agent</label>
                        <select .value=${d.agentId} @change=${(e: Event) => set("agentId", (e.target as HTMLSelectElement).value)}>
                            <option value="">— None —</option>
                            ${ds.agents.map((a) => html`<option value=${a.id} ?selected=${d.agentId === a.id}>${a.name}</option>`)}
                        </select>
                    </div>
                </div>

                <div class="dir-form-actions">
                    <button class="dir-btn primary" ?disabled=${d.saving || !d.name.trim()} @click=${submit}>
                        ${d.saving ? "Saving…" : "Save Directory"}
                    </button>
                    <button class="dir-btn" @click=${close}>Cancel</button>
                </div>
            </div>
        </div>
    `;
}

// ── Sidebar ──────────────────────────────────────────

function renderSidebar(
    state: AppViewState,
    ds: DirectoriesState,
    client: GatewayBrowserClient | null,
): TemplateResult {
    const filtered = getFilteredEntries(state);

    return html`
        <div class="dir-sidebar">
            <div class="dir-sidebar-header">
                <div class="dir-sidebar-title">
                    <h3>📂 Directories</h3>
                    <div style="display:flex;gap:6px;">
                        <button class="dir-btn small" title="Reload"
                            ?disabled=${ds.loading}
                            @click=${() => client && reloadAll(state, client)}>↻</button>
                        <button class="dir-btn small primary" @click=${() => startCreating(state)}>+ Add</button>
                    </div>
                </div>
                <input
                    class="dir-search"
                    type="text"
                    placeholder="Search directories..."
                    .value=${ds.searchQuery}
                    @input=${(e: InputEvent) => setSearchQuery(state, (e.target as HTMLInputElement).value)}
                />
            </div>
            <div class="dir-list">
                ${ds.loading && ds.entries.length === 0
                    ? html`<div style="padding:20px;text-align:center;color:var(--text-muted,#666);">Loading...</div>`
                    : nothing}
                ${!ds.loading && filtered.length === 0
                    ? html`<div style="padding:20px;text-align:center;color:var(--text-muted,#666);">
                        ${ds.searchQuery ? "No matches" : "No directories mapped yet"}
                    </div>`
                    : nothing}
                ${filtered.map((entry) => renderSidebarItem(state, ds, entry))}
            </div>
            <div style="padding:8px 16px;border-top:1px solid var(--border-color,#333);font-size:11px;color:var(--text-muted,#666);">
                ${ds.entries.length} director${ds.entries.length === 1 ? "y" : "ies"} mapped
            </div>
        </div>
    `;
}

function renderSidebarItem(state: AppViewState, ds: DirectoriesState, entry: DirectoryEntry): TemplateResult {
    const selected = ds.selectedId === entry.id;
    const projectName = ds.projects.find((p) => p.id === entry.projectId)?.name;
    const agentName = ds.agents.find((a) => a.id === entry.agentId)?.name;

    return html`
        <div class="dir-item ${selected ? 'selected' : ''}" @click=${() => selectDirectory(state, entry.id)}>
            <div class="dir-item-icon">${entry.icon || "📁"}</div>
            <div class="dir-item-info">
                <div class="dir-item-name">${entry.name}</div>
                <div class="dir-item-path">${entry.path}</div>
                <div class="dir-item-badges">
                    ${agentName ? html`<span class="dir-badge agent">${agentName}</span>` : nothing}
                    ${projectName ? html`<span class="dir-badge">${projectName}</span>` : nothing}
                    ${!entry.active ? html`<span class="dir-badge inactive">inactive</span>` : nothing}
                </div>
                ${entry.nodeIds?.length ? html`
                    <div style="margin-top:4px;">
                        ${renderFederationNodeChips(entry.nodeIds, ds.fedNodes.map(n => ({ ...n })), 2)}
                    </div>
                ` : nothing}
            </div>
        </div>
    `;
}

// ── Detail Panel ──────────────────────────────────────

function renderDetailPanel(
    state: AppViewState,
    ds: DirectoriesState,
    client: GatewayBrowserClient | null,
): TemplateResult {
    if (!ds.editingEntry) {
        return html`
            <div class="dir-detail">
                <div class="dir-detail-empty">
                    Select a directory or click <strong>+ Add</strong> to map a new one
                </div>
            </div>
        `;
    }

    const entry = ds.editingEntry;
    const isNew = ds.creating;

    return html`
        <div class="dir-detail">
            <div class="dir-form">
                <h2 style="margin:0 0 20px;font-size:18px;color:var(--g-primary);">
                    ${isNew ? "Map New Directory" : `Edit: ${entry.name || "Untitled"}`}
                </h2>

                ${ds.error ? html`<div style="padding:10px;background:rgba(255,100,100,0.1);border:1px solid #FF6464;border-radius:6px;color:#FF6464;margin-bottom:16px;font-size:13px;">${ds.error}</div>` : nothing}

                <!-- Core fields -->
                <div class="dir-form-group">
                    <label>Name *</label>
                    <input type="text" placeholder="e.g. InfiniBot Core"
                        .value=${entry.name || ""}
                        @input=${(e: InputEvent) => updateEditingField(state, "name", (e.target as HTMLInputElement).value)} />
                </div>

                <div class="dir-form-group">
                    <label>Path *</label>
                    <input type="text" placeholder="e.g. C:\\Projects\\infinibot"
                        .value=${entry.path || ""}
                        @input=${(e: InputEvent) => updateEditingField(state, "path", (e.target as HTMLInputElement).value)} />
                </div>

                <div class="dir-form-group">
                    <label>Description</label>
                    <textarea placeholder="What this directory is for..."
                        .value=${entry.description || ""}
                        @input=${(e: InputEvent) => updateEditingField(state, "description", (e.target as HTMLTextAreaElement).value)}></textarea>
                </div>

                <div class="dir-form-row">
                    <div class="dir-form-group">
                        <label>Icon</label>
                        <input type="text" placeholder="📁" maxlength="4"
                            .value=${entry.icon || ""}
                            @input=${(e: InputEvent) => updateEditingField(state, "icon", (e.target as HTMLInputElement).value)} />
                    </div>
                    <div class="dir-form-group">
                        <label>Git Remote</label>
                        <input type="text" placeholder="https://github.com/..."
                            .value=${entry.gitRemote || ""}
                            @input=${(e: InputEvent) => updateEditingField(state, "gitRemote", (e.target as HTMLInputElement).value)} />
                    </div>
                </div>

                <!-- Associations -->
                <div class="dir-section-title">Associations</div>

                <div class="dir-form-row">
                    <div class="dir-form-group">
                        <label>Project ${ds.projects.length === 0 ? html`<span style="color:#FFB84A;font-weight:400;text-transform:none;letter-spacing:0;"> · no projects yet — create one on the Projects page</span>` : nothing}</label>
                        <select
                            .value=${entry.projectId || ""}
                            @change=${(e: Event) => updateEditingField(state, "projectId", (e.target as HTMLSelectElement).value || undefined)}>
                            <option value="">— None —</option>
                            ${ds.projects.map((p) => html`<option value=${p.id} ?selected=${entry.projectId === p.id}>${p.name}</option>`)}
                        </select>
                    </div>
                    <div class="dir-form-group">
                        <label>Agent ${ds.agents.length === 0 ? html`<span style="color:#FFB84A;font-weight:400;text-transform:none;letter-spacing:0;"> · none loaded</span>` : nothing}</label>
                        <select
                            .value=${entry.agentId || ""}
                            @change=${(e: Event) => updateEditingField(state, "agentId", (e.target as HTMLSelectElement).value || undefined)}>
                            <option value="">— None —</option>
                            ${ds.agents.map((a) => html`<option value=${a.id} ?selected=${entry.agentId === a.id}>${a.name} (${a.id})</option>`)}
                        </select>
                    </div>
                </div>

                <div class="dir-form-row">
                    <div class="dir-form-group">
                        <label>Notion Database ${ds.notionDatabases.length === 0 ? html`<span style="color:#FFB84A;font-weight:400;text-transform:none;letter-spacing:0;"> · none connected — add via /notion</span>` : nothing}</label>
                        <select
                            .value=${entry.notionDatabaseId || ""}
                            @change=${(e: Event) => updateEditingField(state, "notionDatabaseId", (e.target as HTMLSelectElement).value || undefined)}>
                            <option value="">— None —</option>
                            ${ds.notionDatabases.map((d) => html`<option value=${d.id} ?selected=${entry.notionDatabaseId === d.id}>${d.title}</option>`)}
                        </select>
                    </div>
                    <div class="dir-form-group">
                        <label>Notion Page ID</label>
                        <input type="text" placeholder="page-id (optional)"
                            .value=${entry.notionPageId || ""}
                            @input=${(e: InputEvent) => updateEditingField(state, "notionPageId", (e.target as HTMLInputElement).value)} />
                    </div>
                </div>

                <!-- Tags -->
                <div class="dir-form-group">
                    <label>Tags (comma-separated)</label>
                    <input type="text" placeholder="e.g. typescript, infinibot, core"
                        .value=${(entry.tags || []).join(", ")}
                        @input=${(e: InputEvent) => updateEditingField(state, "tags", (e.target as HTMLInputElement).value.split(",").map((t: string) => t.trim()).filter(Boolean))} />
                </div>

                <!-- Federation devices -->
                ${ds.fedNodes.length > 0 ? html`
                <div class="dir-form-group">
                    ${renderFederationNodeMultiSelect({
                        value: entry.nodeIds ?? [],
                        nodes: ds.fedNodes.map(n => ({ ...n })),
                        label: "Devices",
                        onChange: (ids) => updateEditingField(state, "nodeIds", ids.length > 0 ? ids : undefined),
                    })}
                </div>
                ` : nothing}

                <!-- Active -->
                <div class="dir-form-group">
                    <div class="dir-checkbox-row">
                        <input type="checkbox"
                            ?checked=${entry.active !== false}
                            @change=${(e: Event) => updateEditingField(state, "active", (e.target as HTMLInputElement).checked)} />
                        <label style="margin:0;text-transform:none;font-size:13px;">Active</label>
                    </div>
                </div>

                <!-- Meta info for existing entries -->
                ${!isNew && entry.createdAt ? html`
                    <div class="dir-section-title">Metadata</div>
                    <div class="dir-meta">
                        <div class="dir-meta-item">Created</div>
                        <div class="dir-meta-value">${formatDate(entry.createdAt!)}</div>
                        <div class="dir-meta-item">Updated</div>
                        <div class="dir-meta-value">${formatDate(entry.updatedAt!)}</div>
                        <div class="dir-meta-item">ID</div>
                        <div class="dir-meta-value" style="font-size:11px;opacity:0.6;">${entry.id}</div>
                    </div>
                ` : nothing}

                <!-- Actions -->
                <div class="dir-form-actions">
                    <button class="dir-btn primary" @click=${() => client && saveDirectory(state, client)}
                        ?disabled=${!entry.name || !entry.path || ds.loading}>
                        ${ds.loading ? "Saving..." : isNew ? "Create Mapping" : "Save Changes"}
                    </button>
                    <button class="dir-btn" @click=${() => { selectDirectory(state, null); }}>Cancel</button>
                    ${!isNew && entry.id ? html`
                        <button class="dir-btn danger" style="margin-left:auto;"
                            @click=${() => client && entry.id && deleteDirectory(state, client, entry.id)}>
                            Delete
                        </button>
                    ` : nothing}
                </div>
            </div>
        </div>
    `;
}
