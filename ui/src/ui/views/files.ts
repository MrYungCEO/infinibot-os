import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { icons } from "../icons.js";
import { wgAurora, wgHero, wgEmpty } from "./work-glass";
import "./work-glass/files.css";
import "../components/file-context-panel";
import "../components/file-browser";
import "../components/people-chips";
import "../components/file-analysis";
import { openFileViewer } from "../components/file-viewer";
import type { BrowserItem } from "../files-organize";
import "../secure-mode/secure-toggle";
import "./files-secure";
import { isOcrFileName, ocrStatusLabel } from "../file-ocr";
import { isSecureModeActive, onSecureChange } from "../secure-mode/store";
import {
    type FilesState,
    type FileEntry,
    type FileTreeNode,
    type ExternalRoot,
    createInitialFilesState,
    loadFiles,
    loadTree,
    navigateTo,
    selectFile,
    createFile,
    createFolder,
    deleteFile,
    renameFile,
    searchFiles,
    uploadFile,
    downloadFile,
    sortItems,
    loadDiskInfo,
    addExternalFolder,
    removeExternalFolder,
    switchToRoot,
    openFolderPicker,
    setScope,
    toBrowserItem,
} from "../controllers/files.js";

// ── Helpers ──────────────────────────────────────────

function getFs(state: AppViewState): FilesState {
    if (!(state as any).filesState) {
        (state as any).filesState = createInitialFilesState();
    }
    return (state as any).filesState;
}

export function formatSize(bytes: number): string {
    if (bytes === 0) return "—";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function formatDate(ms: number): string {
    if (!ms) return "—";
    const d = new Date(ms);
    const now = new Date();
    const diff = now.getTime() - ms;
    if (diff < 60_000) return "Just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
    return d.toLocaleDateString();
}

export function fileIcon(file: FileEntry | FileTreeNode): unknown {
    if (file.isDirectory) return icons.folder;
    const ext = ('extension' in file ? file.extension : "") || "";
    const type = file.type || "";
    switch (type) {
        case "code": {
            if ([".ts", ".tsx"].includes(ext)) return icons.fileCode;
            if ([".js", ".jsx"].includes(ext)) return icons.fileCode;
            if (ext === ".py") return icons.fileCode;
            if (ext === ".rs") return icons.fileCode;
            if ([".html", ".xml"].includes(ext)) return icons.globe;
            if ([".css", ".scss"].includes(ext)) return icons.palette;
            if (ext === ".json") return icons.fileCode;
            if ([".md", ".txt"].includes(ext)) return icons.fileText;
            if ([".sh", ".bat", ".ps1"].includes(ext)) return icons.terminal;
            return icons.fileText;
        }
        case "image": return icons.image;
        case "document": return icons.fileText;
        case "archive": return icons.folder;
        case "video": return icons.video;
        case "audio": return icons.mic;
        default: return icons.fileText;
    }
}

// ── Tree Sidebar ──────────────────────────────────────

let expandedFolders = new Set<string>([""]);

function renderTreeNode(node: FileTreeNode, state: AppViewState, client: GatewayBrowserClient, depth: number = 0): any {
    const fs = getFs(state);
    const isExpanded = expandedFolders.has(node.path);
    const isActive = fs.currentPath === node.path;

    if (!node.isDirectory) {
        const isSelected = fs.selectedFile?.path === node.path;
        return html`
            <div
                class="files-tree-item files-tree-file ${isSelected ? "files-tree-item--selected" : ""}"
                style="padding-left: ${10 + depth * 14}px"
                @click=${() => {
                    const entry: FileEntry = {
                        name: node.name,
                        path: node.path,
                        isDirectory: false,
                        size: 0,
                        modified: 0,
                        type: node.type,
                        extension: node.extension || null,
                    };
                    // Navigate to parent then select
                    const parentPath = node.path.includes("/") ? node.path.substring(0, node.path.lastIndexOf("/")) : "";
                    fs.currentPath = parentPath;
                    void loadFiles(state, client).then(() => selectFile(state, client, entry));
                }}
            >
                <span class="files-tree-chevron files-tree-chevron--spacer"></span>
                <span class="files-tree-icon">${fileIcon(node)}</span>
                <span class="files-tree-name">${node.name}</span>
            </div>
        `;
    }

    return html`
        <div class="files-tree-folder">
            <div
                class="files-tree-item ${isActive ? "files-tree-item--active" : ""}"
                style="padding-left: ${10 + depth * 14}px"
                @click=${() => {
                    if (isExpanded) {
                        expandedFolders.delete(node.path);
                    } else {
                        expandedFolders.add(node.path);
                    }
                    navigateTo(state, client, node.path);
                }}
            >
                <span class="files-tree-chevron">${isExpanded ? icons.chevronDown : icons.chevronRight}</span>
                <span class="files-tree-icon files-tree-icon--folder">${icons.folder}</span>
                <span class="files-tree-name">${node.name}</span>
            </div>
            ${isExpanded && node.children ? html`
                <div class="files-tree-children">
                    ${node.children.map(child => renderTreeNode(child, state, client, depth + 1))}
                </div>
            ` : nothing}
        </div>
    `;
}

/** Shimmering placeholder rows while a directory listing loads. */
function renderListSkeleton(): unknown {
    return html`
        <div class="files-skeleton" aria-busy="true" aria-label="Loading files">
            ${[72, 54, 64, 46, 58, 40].map((w) => html`
                <div class="files-skeleton-row">
                    <span class="wg-skel files-skeleton-icon"></span>
                    <span class="wg-skel files-skeleton-bar" style="width:${w}%"></span>
                    <span class="wg-skel files-skeleton-meta"></span>
                </div>
            `)}
        </div>
    `;
}

/**
 * The shell applies CSS \`zoom\` to <body>; a position: fixed popover placed
 * at raw clientX/Y would be scaled by it and land away from the cursor.
 */
function bodyZoom(): number {
    const z = parseFloat(getComputedStyle(document.body).zoom || "1");
    return Number.isFinite(z) && z > 0 ? z : 1;
}

function sortArrow(fs: FilesState, key: FilesState["sortBy"]): string {
    return fs.sortBy === key ? (fs.sortAsc ? "↑" : "↓") : "";
}

let secureSubscribed = false;

/** Small inline status chip for list/grid rows. */
function ocrChip(file: FileEntry) {
    if (file.isDirectory || !file.ocr) return nothing;
    return html`<span class="files-ocr-chip" data-s=${file.ocr.status} title=${file.ocr.error || ocrStatusLabel(file.ocr)}>${
        file.ocr.status === "done" ? icons.scrollText : file.ocr.status === "failed" ? icons.alertCircle : icons.loader
    }<span>${file.ocr.status === "done" ? "Text" : file.ocr.status === "failed" ? "Failed" : file.ocr.status === "processing" ? "Reading" : "Queued"}</span></span>`;
}

// ── Viewer hooks (shared by both lanes) ──────────────

/** Hand a file to the chat composer (webchat reads it on mount / via the event). */
export function askAgentAboutFile(state: AppViewState, prompt: string) {
    try {
        sessionStorage.setItem("ib:webchat-prefill", JSON.stringify({ text: prompt, at: Date.now() }));
    } catch {
        /* storage blocked */
    }
    state.setTab("webchat" as never);
    window.dispatchEvent(new CustomEvent("ib:webchat-prefill"));
}

/** Open the Knowledge Graph searched to this file's node. */
export function openFileOnGraph(state: AppViewState, item: BrowserItem) {
    state.setTab("knowledge-graph" as never);
    let tries = 0;
    const apply = () => {
        const kg = document.querySelector("infinibot-knowledge-graph") ?? findDeep("infinibot-knowledge-graph");
        if (kg) {
            (kg as unknown as { search: string }).search = item.name;
            return;
        }
        if (++tries < 40) setTimeout(apply, 150);
    };
    setTimeout(apply, 60);
}

function findDeep(tag: string, root: Document | ShadowRoot = document): Element | null {
    const direct = root.querySelector(tag);
    if (direct) return direct;
    for (const el of root.querySelectorAll("*")) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) {
            const hit = findDeep(tag, sr);
            if (hit) return hit;
        }
    }
    return null;
}

function contentSearch(state: AppViewState, client: GatewayBrowserClient, query: string) {
    const fs = getFs(state);
    fs.searchMode = "content";
    fs.searchQuery = query;
    void searchFiles(state, client, query);
}

function openViewer(state: AppViewState, client: GatewayBrowserClient, item: BrowserItem, items: BrowserItem[]) {
    const fs = getFs(state);
    const entry = (fs.searchResults ?? fs.items).find((f) => f.path === item.path) ?? fs.allItems?.find((f) => f.path === item.path);
    if (entry) void selectFile(state, client, entry);
    openFileViewer({
        client,
        items,
        index: Math.max(0, items.findIndex((i) => i.key === item.key)),
        hooks: {
            onSearch: (q) => contentSearch(state, client, q),
            onAskAgent: (_it, prompt) => askAgentAboutFile(state, prompt),
            onOpenKg: (it) => openFileOnGraph(state, it),
            onDownload: (it) => it.path && downloadFile(state, client, it.path),
            // People from My Network linked to this file (normal lane only —
            // secure-lane files never leave the secure graph).
            renderPanelTop: (it) =>
                !it.secure && it.path && !it.isDirectory
                    ? html`<ib-people-chips style="padding:10px 14px 0" .client=${client} objectType="file" objectId=${it.path}></ib-people-chips>`
                    : nothing,
        },
    });
}

// ── Main Render ──────────────────────────────────────

export function renderFiles(state: AppViewState, client: GatewayBrowserClient) {
    const fs = getFs(state);
    if (!secureSubscribed) {
        secureSubscribed = true;
        onSecureChange(() => state.requestUpdate?.());
    }
    const secure = isSecureModeActive();
    const sortedItems = sortItems(fs.items, fs.sortBy, fs.sortAsc);
    const source = fs.searchResults ?? (fs.scope === "all" && fs.currentRootId === "main" ? fs.allItems ?? [] : fs.items);
    const browserItems = (source as FileEntry[])
        .filter((f) => !(fs.scope === "all" && !fs.searchResults && f.isDirectory))
        .map((f) => toBrowserItem(f, fs.ctxIndex.get(f.path)));
    const browserLoading = fs.loading || (fs.scope === "all" && !fs.searchResults && fs.allLoading);
    void sortedItems;

    const startCreate = (kind: "file" | "folder") => {
        const fsState = getFs(state);
        fsState.creating = kind;
        fsState.createValue = kind === "folder" ? "new-folder" : "new-file.txt";
        state.requestUpdate?.();
    };
    const pickUpload = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.onchange = () => {
            if (input.files) {
                for (let i = 0; i < input.files.length; i++) {
                    const file = input.files[i];
                    const reader = new FileReader();
                    reader.onload = () => {
                        const base64 = (reader.result as string).split(",")[1];
                        uploadFile(state, client, file.name, base64);
                    };
                    reader.readAsDataURL(file);
                }
            }
        };
        input.click();
    };

    return html`
        <div class="wg-page fg-files">
            ${wgAurora()}
            ${wgHero({
                eyebrow: secure ? "Workspace · Files · Secure lane" : "Workspace · Files",
                title: secure ? html`Secure <span class="wg-gold">files</span>` : html`Your <span class="wg-gold">files</span>`,
                sub: secure
                    ? "Encrypted at rest and read only by local OCR and local vision models. Nothing here reaches your normal files or agent memory."
                    : "Browse, preview and organise everything you and your agents create. Images and documents are read locally (OCR + vision) so agents can find them by content.",
                actions: html`
                    <div class="files-hero-actions">
                        ${!secure && fs.diskInfo ? html`
                            <div class="files-hero-stats" aria-label="Storage">
                                <span class="files-hero-stat">${icons.database}<b>${fs.diskInfo.humanSize}</b> used</span>
                                <span class="files-hero-stat"><b>${fs.diskInfo.fileCount}</b> files</span>
                                <span class="files-hero-stat"><b>${fs.diskInfo.dirCount}</b> folders</span>
                            </div>
                        ` : nothing}
                        <ib-secure-toggle data-secure-surface="files"></ib-secure-toggle>
                    </div>
                `,
            })}

            ${secure ? html`<ib-secure-files
                class="files-secure-lane"
                .client=${client}
                @secure-ask-agent=${(e: CustomEvent<{ prompt: string }>) => askAgentAboutFile(state, e.detail.prompt)}
                @secure-open-kg=${(e: CustomEvent<{ item: BrowserItem }>) => openFileOnGraph(state, e.detail.item)}
            ></ib-secure-files>` : html`
            <div class="files-container wg-surface wg-rise ${fs.selectedFile ? "" : "files-container--no-preview"}"
                @contextmenu=${(e: MouseEvent) => e.preventDefault()}
                @click=${() => {
                    const fsState = getFs(state);
                    if (fsState.contextMenu) {
                        fsState.contextMenu = null;
                        state.requestUpdate?.();
                    }
                }}
            >
                <!-- Left Sidebar: Tree -->
                <nav class="files-sidebar" aria-label="Folders">
                    <div class="files-sidebar-head">
                        <span>Explorer</span>
                        <button
                            class="files-add-folder-btn"
                            @click=${() => openFolderPicker(state, client)}
                            title="Add external folder"
                            aria-label="Add external folder"
                        >${icons.plus}</button>
                    </div>

                    ${fs.addingFolder ? html`
                        <div class="files-add-folder-panel">
                            <input
                                class="files-inline-input"
                                type="text"
                                placeholder="C:\\path\\to\\folder"
                                .value=${fs.addFolderPath}
                                @input=${(e: Event) => { getFs(state).addFolderPath = (e.target as HTMLInputElement).value; }}
                                @keydown=${(e: KeyboardEvent) => {
                                    if (e.key === "Enter") {
                                        const fsState = getFs(state);
                                        const pathVal = fsState.addFolderPath.trim();
                                        if (pathVal) {
                                            addExternalFolder(state, client, pathVal);
                                        }
                                    } else if (e.key === "Escape") {
                                        const fsState = getFs(state);
                                        fsState.addingFolder = false;
                                        fsState.addFolderPath = "";
                                        fsState.error = null;
                                        state.requestUpdate?.();
                                    }
                                }}
                                autofocus
                            />
                            <div class="files-add-folder-actions">
                                <button class="g-btn g-btn--sm g-btn--primary" @click=${() => {
                                    const fsState = getFs(state);
                                    const pathVal = fsState.addFolderPath.trim();
                                    if (pathVal) {
                                        addExternalFolder(state, client, pathVal);
                                    }
                                }}>Add</button>
                                <button class="g-btn g-btn--sm g-btn--ghost" @click=${() => {
                                    const fsState = getFs(state);
                                    fsState.addingFolder = false;
                                    fsState.addFolderPath = "";
                                    fsState.error = null;
                                    state.requestUpdate?.();
                                }}>Cancel</button>
                            </div>
                            <div class="files-add-folder-hint">Enter full path, e.g. C:\\Users\\Desktop</div>
                        </div>
                    ` : nothing}

                    ${fs.treeLoading ? html`
                        <div class="files-tree-skeleton" aria-busy="true">
                            ${[70, 52, 60].map((w) => html`<span class="wg-skel" style="width:${w}%"></span>`)}
                        </div>
                    ` : nothing}

                    <div class="files-tree-scroll">
                        <!-- Main Root (infinibot) -->
                        ${fs.allTrees?.mainRoot ? html`
                            <div class="files-root-section">
                                <div
                                    class="files-root-header ${fs.currentRootId === 'main' ? 'files-root-header--active' : ''}"
                                    @click=${() => switchToRoot(state, client, "main", "")}
                                >
                                    <span class="files-root-icon">${icons.folder}</span>
                                    <span class="files-root-name">infinibot</span>
                                </div>
                                ${fs.currentRootId === 'main' ? renderTreeNode(fs.allTrees.mainRoot, state, client) : nothing}
                            </div>
                        ` : fs.tree ? renderTreeNode(fs.tree, state, client) : nothing}

                        <!-- External Roots -->
                        ${fs.allTrees?.externalRoots?.map(extRoot => html`
                            <div class="files-root-section files-root-section--external">
                                <div
                                    class="files-root-header ${fs.currentRootId === extRoot.id ? 'files-root-header--active' : ''}"
                                    @click=${() => switchToRoot(state, client, extRoot.id, extRoot.path)}
                                    @contextmenu=${(e: MouseEvent) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (confirm(`Remove "${extRoot.name}" from explorer?`)) {
                                            removeExternalFolder(state, client, extRoot.id);
                                        }
                                    }}
                                >
                                    <span class="files-root-icon">${icons.folder}</span>
                                    <span class="files-root-name">${extRoot.name}</span>
                                    <button
                                        class="files-root-remove"
                                        @click=${(e: Event) => {
                                            e.stopPropagation();
                                            if (confirm(`Remove "${extRoot.name}" from explorer?`)) {
                                                removeExternalFolder(state, client, extRoot.id);
                                            }
                                        }}
                                        title="Remove folder"
                                        aria-label="Remove ${extRoot.name} from explorer"
                                    >${icons.x}</button>
                                </div>
                                ${fs.currentRootId === extRoot.id && extRoot.children ? html`
                                    <div class="files-tree-children">
                                        ${extRoot.children.map((child: FileTreeNode) => renderTreeNode(child, state, client, 1))}
                                    </div>
                                ` : nothing}
                            </div>
                        `)}
                    </div>

                </nav>

                <!-- Main Area -->
                <section class="files-main" aria-label="Directory contents"
                    @dragover=${(e: DragEvent) => { e.preventDefault(); e.stopPropagation(); }}
                    @drop=${(e: DragEvent) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const files = e.dataTransfer?.files;
                        if (files) {
                            for (let i = 0; i < files.length; i++) {
                                const file = files[i];
                                const reader = new FileReader();
                                reader.onload = () => {
                                    const base64 = (reader.result as string).split(",")[1];
                                    uploadFile(state, client, file.name, base64);
                                };
                                reader.readAsDataURL(file);
                            }
                        }
                    }}
                >
                    <!-- Toolbar -->
                    <div class="files-toolbar">
                        <div class="files-toolbar-group">
                            <button class="g-btn g-btn--sm files-toolbar-btn" @click=${() => startCreate("file")} title="New File">${icons.fileText}<span>New file</span></button>
                            <button class="g-btn g-btn--sm files-toolbar-btn" @click=${() => startCreate("folder")} title="New Folder">${icons.folder}<span>New folder</span></button>
                            <button class="g-btn g-btn--sm g-btn--primary files-toolbar-btn" @click=${pickUpload} title="Upload">${icons.upload}<span>Upload</span></button>
                        </div>

                        ${fs.selectedFile ? html`
                            <div class="files-toolbar-group files-toolbar-group--selection">
                                ${!fs.selectedFile.isDirectory ? html`
                                    <button class="g-btn g-btn--sm g-btn--icon files-toolbar-btn" @click=${() => downloadFile(state, client, fs.selectedFile!.path)} title="Download" aria-label="Download">${icons.download}</button>
                                ` : nothing}
                                <button class="g-btn g-btn--sm g-btn--icon files-toolbar-btn" @click=${() => {
                                    const fsState = getFs(state);
                                    fsState.renaming = fsState.selectedFile;
                                    fsState.renameValue = fsState.selectedFile?.name || "";
                                    state.requestUpdate?.();
                                }} title="Rename" aria-label="Rename">${icons.penLine}</button>
                                <button class="g-btn g-btn--sm g-btn--icon g-btn--danger files-toolbar-btn files-toolbar-btn--danger" @click=${() => {
                                    if (confirm(`Delete "${fs.selectedFile!.name}"?`)) {
                                        deleteFile(state, client, fs.selectedFile!.path);
                                    }
                                }} title="Delete" aria-label="Delete">${icons.trash}</button>
                            </div>
                        ` : nothing}

                        <label class="files-toolbar-search ${fs.searchMode === "content" ? "files-toolbar-search--content" : ""}">
                            <span class="files-toolbar-search-icon">${fs.searchMode === "content" ? icons.scrollText : icons.search}</span>
                            <input
                                type="text"
                                placeholder=${fs.searchMode === "content" ? "Search inside images & documents…" : "Search files…"}
                                aria-label=${fs.searchMode === "content" ? "Search files by content" : "Search files"}
                                data-testid="files-search"
                                .value=${fs.searchQuery}
                                @input=${(e: Event) => {
                                    const val = (e.target as HTMLInputElement).value;
                                    const fsState = getFs(state);
                                    fsState.searchQuery = val;
                                    if (val.length >= 2) {
                                        searchFiles(state, client, val);
                                    } else if (val.length === 0) {
                                        fsState.searchResults = null;
                                        state.requestUpdate?.();
                                    }
                                }}
                            />
                            <span class="files-search-mode" role="group" aria-label="Search mode">
                                <button
                                    type="button"
                                    class=${fs.searchMode === "name" ? "on" : ""}
                                    aria-pressed=${String(fs.searchMode === "name")}
                                    title="Search by file name"
                                    @click=${(e: Event) => {
                                        e.preventDefault();
                                        const fsState = getFs(state);
                                        fsState.searchMode = "name";
                                        if (fsState.searchQuery.length >= 2) searchFiles(state, client, fsState.searchQuery);
                                        else state.requestUpdate?.();
                                    }}
                                >Names</button>
                                <button
                                    type="button"
                                    class=${fs.searchMode === "content" ? "on" : ""}
                                    aria-pressed=${String(fs.searchMode === "content")}
                                    title="Search the text read from images and documents (local OCR)"
                                    data-testid="files-search-content"
                                    @click=${(e: Event) => {
                                        e.preventDefault();
                                        const fsState = getFs(state);
                                        fsState.searchMode = "content";
                                        if (fsState.searchQuery.length >= 2) searchFiles(state, client, fsState.searchQuery);
                                        else state.requestUpdate?.();
                                    }}
                                >Contents</button>
                            </span>
                        </label>

                        <button class="g-btn g-btn--sm g-btn--icon g-btn--ghost files-toolbar-btn" @click=${() => { loadFiles(state, client); loadTree(state, client); if (getFs(state).scope === "all") setScope(state, client, "all"); }} title="Refresh" aria-label="Refresh">${icons.refresh}</button>
                    </div>

                    <!-- Breadcrumb -->
                    <div class="files-breadcrumb">
                        ${fs.breadcrumb.map((crumb, i) => html`
                            ${i > 0 ? html`<span class="files-breadcrumb-sep">${icons.chevronRight}</span>` : nothing}
                            <span
                                class="files-breadcrumb-item ${i === fs.breadcrumb.length - 1 ? "files-breadcrumb-item--active" : ""}"
                                @click=${() => { if (i < fs.breadcrumb.length - 1) navigateTo(state, client, crumb.path); }}
                            >${crumb.name}</span>
                        `)}
                        ${fs.searchResults ? html`
                            <span class="files-search-badge">
                                ${fs.searchResults.length} results
                                <button aria-label="Clear search" @click=${() => { const fsState = getFs(state); fsState.searchResults = null; fsState.searchQuery = ""; state.requestUpdate?.(); }}>${icons.x}</button>
                            </span>
                        ` : nothing}
                    </div>

                    <!-- Create inline -->
                    ${fs.creating ? html`
                        <div class="files-create-row">
                            <span class="files-row-icon ${fs.creating === "folder" ? "files-row-icon--folder" : ""}">${fs.creating === "folder" ? icons.folder : icons.fileText}</span>
                            <input
                                class="files-inline-input"
                                type="text"
                                .value=${fs.createValue}
                                @input=${(e: Event) => { getFs(state).createValue = (e.target as HTMLInputElement).value; }}
                                @keydown=${(e: KeyboardEvent) => {
                                    if (e.key === "Enter") {
                                        const fsState = getFs(state);
                                        const name = fsState.createValue.trim();
                                        if (name) {
                                            if (fsState.creating === "folder") createFolder(state, client, name);
                                            else createFile(state, client, name);
                                        }
                                        fsState.creating = null;
                                        state.requestUpdate?.();
                                    } else if (e.key === "Escape") {
                                        getFs(state).creating = null;
                                        state.requestUpdate?.();
                                    }
                                }}
                                autofocus
                            />
                            <span class="files-create-hint"><kbd class="g-kbd">Enter</kbd> to create · <kbd class="g-kbd">Esc</kbd> to cancel</span>
                        </div>
                    ` : nothing}

                    <!-- Inline rename (opened from the toolbar / context menu) -->
                    ${fs.renaming ? html`
                        <div class="files-create-row">
                            <span class="files-row-icon">${icons.penLine}</span>
                            <input
                                class="files-inline-input"
                                type="text"
                                aria-label="New name"
                                .value=${fs.renameValue}
                                @input=${(e: Event) => { getFs(state).renameValue = (e.target as HTMLInputElement).value; }}
                                @keydown=${(e: KeyboardEvent) => {
                                    if (e.key === "Enter") {
                                        const fsState = getFs(state);
                                        const newName = fsState.renameValue.trim();
                                        if (newName && fsState.renaming) renameFile(state, client, fsState.renaming.path, newName);
                                        fsState.renaming = null;
                                        state.requestUpdate?.();
                                    } else if (e.key === "Escape") {
                                        getFs(state).renaming = null;
                                        state.requestUpdate?.();
                                    }
                                }}
                                autofocus
                            />
                            <span class="files-create-hint">Renaming ${fs.renaming.name} · <kbd class="g-kbd">Enter</kbd> to save · <kbd class="g-kbd">Esc</kbd> to cancel</span>
                        </div>
                    ` : nothing}

                    <!-- Grouped Grid / Gallery / List -->
                    <ib-file-browser
                        class="files-browser"
                        lane="normal"
                        .client=${client}
                        .items=${browserItems}
                        .loading=${browserLoading}
                        .selectedKey=${fs.selectedFile?.path ?? null}
                        .projectNames=${fs.projectNames}
                        .emptyTitle=${fs.searchResults ? "No matching files" : "This folder is empty"}
                        .emptyBody=${fs.searchResults ? `Nothing matches “${fs.searchQuery}”. Try a shorter search or clear it.` : "Drop files here to upload them, or create a new file or folder to get started."}
                        @item-open=${(e: CustomEvent<{ item: BrowserItem; items: BrowserItem[] }>) => openViewer(state, client, e.detail.item, e.detail.items)}
                        @folder-open=${(e: CustomEvent<{ item: BrowserItem }>) => { if (e.detail.item.path !== null) navigateTo(state, client, e.detail.item.path); }}
                        @item-context=${(e: CustomEvent<{ item: BrowserItem; x: number; y: number }>) => {
                            const fsState = getFs(state);
                            const file = (fsState.searchResults ?? fsState.items).find((f) => f.path === e.detail.item.path) ?? fsState.allItems?.find((f) => f.path === e.detail.item.path);
                            if (!file) return;
                            fsState.contextMenu = { x: e.detail.x, y: e.detail.y, file };
                            state.requestUpdate?.();
                        }}
                        @scope-change=${(e: CustomEvent<{ scope: "folder" | "all" }>) => setScope(state, client, e.detail.scope)}
                    ></ib-file-browser>
                </section>

                <!-- Right Panel: Preview -->
                ${fs.selectedFile ? html`<aside class="files-preview" aria-label="Details">
                    ${html`
                        <button class="files-preview-close" aria-label="Close details" title="Close details" @click=${() => { const f = getFs(state); f.selectedFile = null; f.previewContent = null; f.previewImage = null; state.requestUpdate?.(); }}>${icons.x}</button>
                        <div class="files-preview-head">
                            <span class="files-preview-icon ${fs.selectedFile.isDirectory ? "files-row-icon--folder" : ""}">${fileIcon(fs.selectedFile)}</span>
                            <div class="files-preview-heading">
                                <div class="wg-eyebrow files-preview-eyebrow">${fs.selectedFile.isDirectory ? "Folder" : "File"}</div>
                                <div class="files-preview-title">${fs.selectedFile.name}</div>
                            </div>
                        </div>
                        <dl class="files-preview-meta">
                            <div><dt>${icons.maximize} Size</dt><dd>${formatSize(fs.selectedFile.size)}</dd></div>
                            <div><dt>${icons.calendar} Modified</dt><dd>${formatDate(fs.selectedFile.modified)}</dd></div>
                            <div><dt>${icons.folder} Path</dt><dd class="files-preview-path">${fs.selectedFile.path}</dd></div>
                            <div><dt>${icons.tag} Type</dt><dd>${fs.selectedFile.type}${fs.selectedFile.extension ? ` (${fs.selectedFile.extension})` : ""}</dd></div>
                        </dl>
                        ${fs.previewLoading ? html`
                            <div class="files-preview-content files-preview-content--loading" aria-busy="true">
                                ${[88, 64, 76, 52].map((w) => html`<span class="wg-skel" style="width:${w}%"></span>`)}
                            </div>
                        ` : nothing}
                        ${fs.previewContent !== null ? html`
                            <div class="files-preview-content">${fs.previewContent}</div>
                        ` : nothing}
                        ${!fs.selectedFile.isDirectory && isOcrFileName(fs.selectedFile.name) ? html`
                            <div class="files-preview-ocr">
                                <ib-file-analysis
                                    .client=${client}
                                    .item=${toBrowserItem(fs.selectedFile, fs.ctxIndex.get(fs.selectedFile.path))}
                                    @file-search=${(e: CustomEvent<{ query: string }>) => contentSearch(state, client, e.detail.query)}
                                    @file-ask-agent=${(e: CustomEvent<{ prompt: string }>) => askAgentAboutFile(state, e.detail.prompt)}
                                    @file-open-kg=${(e: CustomEvent<{ item: BrowserItem }>) => openFileOnGraph(state, e.detail.item)}
                                    @file-seek=${() => { const f = getFs(state).selectedFile; if (f) { const it = toBrowserItem(f, getFs(state).ctxIndex.get(f.path)); openViewer(state, client, it, [it]); } }}
                                ></ib-file-analysis>
                            </div>
                        ` : nothing}
                        <div class="files-preview-actions">
                            ${!fs.selectedFile.isDirectory ? html`
                                <button class="g-btn g-btn--sm" @click=${() => { const f = getFs(state).selectedFile; if (f) { const it = toBrowserItem(f, getFs(state).ctxIndex.get(f.path)); openViewer(state, client, it, [it]); } }}>${icons.maximize} Open viewer</button>
                            ` : nothing}
                            ${!fs.selectedFile.isDirectory ? html`
                                <button class="g-btn g-btn--sm g-btn--primary" @click=${() => downloadFile(state, client, fs.selectedFile!.path)}>${icons.download} Download</button>
                            ` : nothing}
                            <button class="g-btn g-btn--sm" @click=${() => {
                                const fsState = getFs(state);
                                fsState.renaming = fsState.selectedFile;
                                fsState.renameValue = fsState.selectedFile?.name || "";
                                state.requestUpdate?.();
                            }}>${icons.penLine} Rename</button>
                            <button class="g-btn g-btn--sm g-btn--danger" @click=${() => {
                                if (confirm(`Delete "${fs.selectedFile!.name}"?`)) {
                                    deleteFile(state, client, fs.selectedFile!.path);
                                }
                            }}>${icons.trash} Delete</button>
                        </div>
                    `}
                </aside>` : nothing}
            </div>

            `}

            <!-- Context Menu: rendered outside the blurred surface so its
                 position: fixed is relative to the viewport (a backdrop-filter
                 ancestor would otherwise become its containing block). -->
            ${fs.contextMenu ? html`
                <div class="files-context-menu" role="menu" style="left: ${fs.contextMenu.x / bodyZoom()}px; top: ${fs.contextMenu.y / bodyZoom()}px;" @click=${(e: Event) => e.stopPropagation()}>
                    ${fs.contextMenu.file ? html`
                        ${fs.contextMenu.file.isDirectory ? html`
                            <div class="files-context-item" role="menuitem" @click=${() => { navigateTo(state, client, fs.contextMenu!.file!.path); getFs(state).contextMenu = null; state.requestUpdate?.(); }}>${icons.folder} Open</div>
                        ` : html`
                            <div class="files-context-item" role="menuitem" @click=${() => { const f = fs.contextMenu!.file!; const it = toBrowserItem(f, fs.ctxIndex.get(f.path)); getFs(state).contextMenu = null; openViewer(state, client, it, [it]); }}>${icons.eye} Open viewer</div>
                            <div class="files-context-item" role="menuitem" @click=${() => { downloadFile(state, client, fs.contextMenu!.file!.path); getFs(state).contextMenu = null; state.requestUpdate?.(); }}>${icons.download} Download</div>
                        `}
                        <div class="files-context-sep"></div>
                        <div class="files-context-item" role="menuitem" @click=${() => {
                            const fsState = getFs(state);
                            fsState.renaming = fsState.contextMenu!.file;
                            fsState.renameValue = fsState.contextMenu!.file!.name;
                            fsState.contextMenu = null;
                            state.requestUpdate?.();
                        }}>${icons.penLine} Rename</div>
                        <div class="files-context-sep"></div>
                        <div class="files-context-item files-context-item--danger" role="menuitem" @click=${() => {
                            const file = fs.contextMenu!.file!;
                            if (confirm(`Delete "${file.name}"?`)) {
                                deleteFile(state, client, file.path);
                            }
                            getFs(state).contextMenu = null;
                            state.requestUpdate?.();
                        }}>${icons.trash} Delete</div>
                    ` : nothing}
                </div>
            ` : nothing}

            ${fs.error ? html`
                <div class="files-error" role="alert">
                    ${icons.alertCircle} <span>${fs.error}</span>
                    <button class="g-btn g-btn--sm g-btn--ghost" @click=${() => { getFs(state).error = null; state.requestUpdate?.(); }}>Dismiss</button>
                </div>
            ` : nothing}
        </div>
    `;
}
