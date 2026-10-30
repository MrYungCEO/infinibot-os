import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { isOcrPending, type OcrBadgeInfo, type OcrEntryInfo } from "../file-ocr.js";
import {
    type BrowserItem,
    type Scope,
    analysisStatusOf,
    extOf,
    kindOfName,
    loadOrganizePrefs,
    parentOf,
    projectIdFromPath,
} from "../files-organize.js";

// ── Types ──────────────────────────────────────────

export interface FileEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    isFile?: boolean;
    size: number;
    modified: number;
    created?: number;
    type: string;
    extension: string | null;
    /** Local auto-OCR status (normal lane). */
    ocr?: OcrBadgeInfo;
    /** Content-search hit snippet. */
    snippet?: string;
}

export interface FileTreeNode {
    name: string;
    path: string;
    isDirectory: boolean;
    type: string;
    extension?: string;
    children?: FileTreeNode[];
}

export interface ExternalRoot {
    id: string;
    path: string;
    name: string;
    addedAt: number;
}

export interface FilesState {
    loading: boolean;
    error: string | null;
    currentPath: string;
    currentRootId: string; // "main" or external root ID
    items: FileEntry[];
    tree: FileTreeNode | null;
    treeLoading: boolean;
    selectedFile: FileEntry | null;
    previewContent: string | null;
    previewLoading: boolean;
    viewMode: "list" | "grid";
    sortBy: "name" | "size" | "modified" | "type";
    sortAsc: boolean;
    searchQuery: string;
    /** "name" = filename/plain-text search, "content" = local OCR text + descriptions. */
    searchMode: "name" | "content";
    searchResults: any[] | null;
    previewImage: string | null;
    searchLoading: boolean;
    breadcrumb: { name: string; path: string }[];
    diskInfo: { totalSize: number; fileCount: number; dirCount: number; humanSize: string } | null;
    contextMenu: { x: number; y: number; file: FileEntry | null } | null;
    renaming: FileEntry | null;
    renameValue: string;
    creating: "file" | "folder" | null;
    createValue: string;
    // External roots
    externalRoots: ExternalRoot[];
    allTrees: { mainRoot: FileTreeNode | null; externalRoots: (FileTreeNode & { id: string; isExternalRoot: boolean })[] } | null;
    addingFolder: boolean;
    addFolderPath: string;
    /** Browser scope: the current folder, or every file under the root. */
    scope: Scope;
    allItems: FileEntry[] | null;
    allLoading: boolean;
    /** files.context.list index by Files-root relative path (status, summary, project). */
    ctxIndex: Map<string, OcrEntryInfo>;
    projectNames: Map<string, string>;
}

export function createInitialFilesState(): FilesState {
    return {
        loading: false,
        error: null,
        currentPath: "",
        currentRootId: "main",
        items: [],
        tree: null,
        treeLoading: false,
        selectedFile: null,
        previewContent: null,
        previewLoading: false,
        viewMode: "list",
        sortBy: "name",
        sortAsc: true,
        searchQuery: "",
        searchMode: "name",
        searchResults: null,
        previewImage: null,
        searchLoading: false,
        breadcrumb: [{ name: "infinibot", path: "" }],
        diskInfo: null,
        contextMenu: null,
        renaming: null,
        renameValue: "",
        creating: null,
        createValue: "",
        externalRoots: [],
        allTrees: null,
        addingFolder: false,
        addFolderPath: "",
        scope: loadOrganizePrefs("normal").scope,
        allItems: null,
        allLoading: false,
        ctxIndex: new Map(),
        projectNames: new Map(),
    };
}

// ── Helpers ──────────────────────────────────────────

function getFilesState(state: AppViewState): FilesState {
    if (!(state as any).filesState) {
        (state as any).filesState = createInitialFilesState();
    }
    return (state as any).filesState;
}

function buildBreadcrumb(currentPath: string): { name: string; path: string }[] {
    const crumbs = [{ name: "infinibot", path: "" }];
    if (!currentPath) return crumbs;
    const parts = currentPath.split("/").filter(Boolean);
    let accum = "";
    for (const part of parts) {
        accum = accum ? `${accum}/${part}` : part;
        crumbs.push({ name: part, path: accum });
    }
    return crumbs;
}

// ── Actions ──────────────────────────────────────────

export async function loadFiles(state: AppViewState, client: GatewayBrowserClient) {
    const fs = getFilesState(state);
    fs.loading = true;
    fs.error = null;
    state.requestUpdate?.();

    try {
        const result = await client.request<{ path: string; items: FileEntry[] }>("files.list", { path: fs.currentPath });
        fs.items = result?.items || [];
        fs.breadcrumb = buildBreadcrumb(fs.currentPath);
        if (fs.selectedFile) {
            const fresh = fs.items.find((i) => i.path === fs.selectedFile!.path);
            if (fresh) fs.selectedFile = { ...fs.selectedFile, ocr: fresh.ocr };
        }
        scheduleOcrRefresh(state, client, fs.items.some((i) => isOcrPending(i.ocr?.status)));
        void loadContextIndex(state, client);
        if (fs.scope === "all") void loadAllFiles(state, client);
    } catch (err: any) {
        fs.error = err.message || "Failed to load files";
    } finally {
        fs.loading = false;
        state.requestUpdate?.();
    }
}

let ocrRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** While any visible file is being OCR'd, refresh the listing every 3 s for live badges. */
function scheduleOcrRefresh(state: AppViewState, client: GatewayBrowserClient, pending: boolean) {
    if (ocrRefreshTimer) clearTimeout(ocrRefreshTimer);
    ocrRefreshTimer = null;
    if (!pending || !filesPollTimer) return;
    ocrRefreshTimer = setTimeout(() => void loadFiles(state, client), 3000);
}

export async function loadTree(state: AppViewState, client: GatewayBrowserClient) {
    const fs = getFilesState(state);
    fs.treeLoading = true;
    state.requestUpdate?.();

    try {
        // Load all trees including external roots
        const allTrees = await client.request<{
            mainRoot: FileTreeNode;
            externalRoots: (FileTreeNode & { id: string; isExternalRoot: boolean })[];
        }>("files.tree.all", { depth: 4 });
        
        fs.allTrees = allTrees;
        fs.tree = allTrees?.mainRoot || null;
        
        // Also update external roots list
        const rootsResult = await client.request<{ roots: ExternalRoot[] }>("files.roots.list", {});
        fs.externalRoots = rootsResult?.roots || [];
    } catch (err: any) {
        console.warn("[Files] Tree load failed:", err.message);
        // Fallback to old method
        try {
            const tree = await client.request<FileTreeNode>("files.tree", { path: "", depth: 4 });
            fs.tree = tree;
        } catch {}
    } finally {
        fs.treeLoading = false;
        state.requestUpdate?.();
    }
}

export async function loadExternalRoots(state: AppViewState, client: GatewayBrowserClient) {
    const fs = getFilesState(state);
    try {
        const result = await client.request<{ roots: ExternalRoot[] }>("files.roots.list", {});
        fs.externalRoots = result?.roots || [];
        state.requestUpdate?.();
    } catch (err: any) {
        console.warn("[Files] Failed to load external roots:", err.message);
    }
}

export async function addExternalFolder(state: AppViewState, client: GatewayBrowserClient, folderPath: string, name?: string) {
    const fs = getFilesState(state);
    try {
        const result = await client.request<{ root: ExternalRoot; roots: ExternalRoot[] }>("files.roots.add", {
            path: folderPath,
            name: name || undefined,
        });
        fs.externalRoots = result?.roots || [];
        fs.addingFolder = false;
        fs.addFolderPath = "";
        // Reload tree to include new root
        await loadTree(state, client);
    } catch (err: any) {
        fs.error = err.message || "Failed to add folder";
        state.requestUpdate?.();
    }
}

export async function openFolderPicker(state: AppViewState, client: GatewayBrowserClient) {
    const fs = getFilesState(state);
    fs.addingFolder = true;
    fs.addFolderPath = "";
    state.requestUpdate?.();
    
    try {
        const result = await client.request<{ cancelled: boolean; path: string | null }>("files.selectFolder", {
            title: "Select folder to add to Explorer",
        });
        
        if (result?.cancelled || !result?.path) {
            fs.addingFolder = false;
            state.requestUpdate?.();
            return;
        }
        
        // Add the selected folder
        await addExternalFolder(state, client, result.path);
    } catch (err: any) {
        // If gateway method fails, fall back to manual input
        console.warn("[Files] Native folder picker failed, using manual input:", err.message);
        fs.error = "Enter the folder path manually:";
        state.requestUpdate?.();
    }
}

export async function removeExternalFolder(state: AppViewState, client: GatewayBrowserClient, rootId: string) {
    const fs = getFilesState(state);
    try {
        const result = await client.request<{ roots: ExternalRoot[] }>("files.roots.remove", { id: rootId });
        fs.externalRoots = result?.roots || [];
        // If we were viewing this root, switch back to main
        if (fs.currentRootId === rootId) {
            fs.currentRootId = "main";
            fs.currentPath = "";
            await loadFiles(state, client);
        }
        await loadTree(state, client);
    } catch (err: any) {
        fs.error = err.message || "Failed to remove folder";
        state.requestUpdate?.();
    }
}

export async function switchToRoot(state: AppViewState, client: GatewayBrowserClient, rootId: string, rootPath?: string) {
    const fs = getFilesState(state);
    fs.currentRootId = rootId;
    fs.currentPath = rootPath || "";
    fs.selectedFile = null;
    fs.previewContent = null;
    fs.searchResults = null;
    fs.searchQuery = "";
    await loadFiles(state, client);
}

export async function navigateTo(state: AppViewState, client: GatewayBrowserClient, dirPath: string) {
    const fs = getFilesState(state);
    fs.currentPath = dirPath;
    fs.selectedFile = null;
    fs.previewContent = null;
    fs.searchResults = null;
    fs.searchQuery = "";
    await loadFiles(state, client);
}

export async function selectFile(state: AppViewState, client: GatewayBrowserClient, file: FileEntry) {
    const fs = getFilesState(state);

    if (file.isDirectory) {
        await navigateTo(state, client, file.path);
        return;
    }

    fs.selectedFile = file;
    fs.previewContent = null;
    fs.previewImage = null;
    fs.previewLoading = true;
    state.requestUpdate?.();

    // Preview text files
    const textTypes = ["code", "document", "file"];
    const textExts = [".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".scss", ".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".c", ".cpp", ".h", ".java", ".rb", ".php", ".sh", ".bat", ".ps1", ".sql", ".csv", ".log", ".env", ".gitignore", ".dockerignore", ".editorconfig"];

    // Binary documents (pdf/office) show their local-OCR text instead of raw bytes.
    const binaryDoc = /\.(pdf|docx?|pptx?|xlsx?|odt|rtf|epub|heic|heif|zip)$/i.test(file.name);
    if (!binaryDoc && (textTypes.includes(file.type) || textExts.includes(file.extension || ""))) {
        if (file.size <= 2 * 1024 * 1024) {
            try {
                const result = await client.request<{ content: string }>("files.read", { path: file.path });
                fs.previewContent = result?.content || "";
            } catch {
                fs.previewContent = null;
            }
        }
    }

    fs.previewLoading = false;
    state.requestUpdate?.();
}

export async function createFile(state: AppViewState, client: GatewayBrowserClient, name: string) {
    const fs = getFilesState(state);
    const filePath = fs.currentPath ? `${fs.currentPath}/${name}` : name;
    try {
        await client.request("files.write", { path: filePath, content: "" });
        await loadFiles(state, client);
        await loadTree(state, client);
    } catch (err: any) {
        fs.error = err.message;
        state.requestUpdate?.();
    }
}

export async function createFolder(state: AppViewState, client: GatewayBrowserClient, name: string) {
    const fs = getFilesState(state);
    const dirPath = fs.currentPath ? `${fs.currentPath}/${name}` : name;
    try {
        await client.request("files.mkdir", { path: dirPath });
        await loadFiles(state, client);
        await loadTree(state, client);
    } catch (err: any) {
        fs.error = err.message;
        state.requestUpdate?.();
    }
}

export async function deleteFile(state: AppViewState, client: GatewayBrowserClient, filePath: string) {
    const fs = getFilesState(state);
    try {
        await client.request("files.delete", { path: filePath, trash: true });
        if (fs.selectedFile?.path === filePath) {
            fs.selectedFile = null;
            fs.previewContent = null;
        }
        await loadFiles(state, client);
        await loadTree(state, client);
    } catch (err: any) {
        fs.error = err.message;
        state.requestUpdate?.();
    }
}

export async function renameFile(state: AppViewState, client: GatewayBrowserClient, oldPath: string, newName: string) {
    const fs = getFilesState(state);
    const dir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
    const newPath = dir ? `${dir}/${newName}` : newName;
    try {
        await client.request("files.rename", { oldPath, newPath });
        await loadFiles(state, client);
        await loadTree(state, client);
    } catch (err: any) {
        fs.error = err.message;
        state.requestUpdate?.();
    }
}

export async function searchFiles(state: AppViewState, client: GatewayBrowserClient, query: string) {
    const fs = getFilesState(state);
    if (!query.trim()) {
        fs.searchResults = null;
        fs.searchQuery = "";
        state.requestUpdate?.();
        return;
    }
    fs.searchQuery = query;
    fs.searchLoading = true;
    state.requestUpdate?.();

    try {
        if (fs.searchMode === "content") {
            const result = await client.request<{ results: Array<{ id: string; name: string; relPath: string | null; status: OcrBadgeInfo["status"]; snippet: string }> }>(
                "files.context.search",
                { query, limit: 50 },
            );
            if (fs.searchQuery !== query) return;
            fs.searchResults = (result?.results || []).map((h): FileEntry => ({
                name: h.name,
                path: h.relPath || h.name,
                isDirectory: false,
                isFile: true,
                size: 0,
                modified: 0,
                type: /\.(png|jpe?g|webp|gif|bmp|heic|heif|tiff?)$/i.test(h.name) ? "image" : "document",
                extension: (/\.[^.]+$/.exec(h.name)?.[0] || "").toLowerCase() || null,
                ocr: { id: h.id, status: h.status },
                snippet: h.snippet,
            }));
            return;
        }
        const result = await client.request<{ results: any[] }>("files.search", {
            query,
            path: fs.currentPath,
            content: true,
        });
        fs.searchResults = result?.results || [];
    } catch (err: any) {
        fs.error = err.message;
    } finally {
        fs.searchLoading = false;
        state.requestUpdate?.();
    }
}

export async function uploadFile(state: AppViewState, client: GatewayBrowserClient, fileName: string, base64Content: string) {
    const fs = getFilesState(state);
    const filePath = fs.currentPath ? `${fs.currentPath}/${fileName}` : fileName;
    try {
        await client.request("files.upload", { path: filePath, content: base64Content });
        await loadFiles(state, client);
        await loadTree(state, client);
    } catch (err: any) {
        fs.error = err.message;
        state.requestUpdate?.();
    }
}

export async function loadDiskInfo(state: AppViewState, client: GatewayBrowserClient) {
    const fs = getFilesState(state);
    try {
        const info = await client.request<any>("files.disk", { path: "" });
        fs.diskInfo = info;
        state.requestUpdate?.();
    } catch {}
}

export async function downloadFile(state: AppViewState, client: GatewayBrowserClient, filePath: string) {
    try {
        const result = await client.request<{ content: string; name: string }>("files.download", { path: filePath });
        if (result?.content) {
            const blob = new Blob([Uint8Array.from(atob(result.content), c => c.charCodeAt(0))]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = result.name || "download";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    } catch (err: any) {
        const fs = getFilesState(state);
        fs.error = err.message;
        state.requestUpdate?.();
    }
}

export function toggleViewMode(state: AppViewState) {
    const fs = getFilesState(state);
    fs.viewMode = fs.viewMode === "list" ? "grid" : "list";
    state.requestUpdate?.();
}

export function setSortBy(state: AppViewState, sortBy: FilesState["sortBy"]) {
    const fs = getFilesState(state);
    if (fs.sortBy === sortBy) {
        fs.sortAsc = !fs.sortAsc;
    } else {
        fs.sortBy = sortBy;
        fs.sortAsc = true;
    }
    state.requestUpdate?.();
}

export function sortItems(items: FileEntry[], sortBy: string, asc: boolean): FileEntry[] {
    const sorted = [...items].sort((a, b) => {
        // Folders always first
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;

        let cmp = 0;
        switch (sortBy) {
            case "name": cmp = a.name.localeCompare(b.name); break;
            case "size": cmp = a.size - b.size; break;
            case "modified": cmp = a.modified - b.modified; break;
            case "type": cmp = (a.type || "").localeCompare(b.type || ""); break;
            default: cmp = a.name.localeCompare(b.name);
        }
        return asc ? cmp : -cmp;
    });
    return sorted;
}

// ── Organise / All files ─────────────────────────────

let ctxLoadedAt = 0;

/** OCR registry (status, summary, project) for every indexed file; refreshed at most every 8 s. */
export async function loadContextIndex(state: AppViewState, client: GatewayBrowserClient, force = false) {
    const fs = getFilesState(state);
    if (!force && Date.now() - ctxLoadedAt < 8000) return;
    ctxLoadedAt = Date.now();
    try {
        const res = await client.request<{ entries: OcrEntryInfo[] }>("files.context.list", { limit: 1000 });
        const idx = new Map<string, OcrEntryInfo>();
        for (const e of res?.entries ?? []) if (e.relPath) idx.set(e.relPath, e);
        fs.ctxIndex = idx;
        state.requestUpdate?.();
    } catch {
        /* OCR not available — the browser still works without it */
    }
    if (!fs.projectNames.size) void loadProjectNames(state, client);
}

async function loadProjectNames(state: AppViewState, client: GatewayBrowserClient) {
    const fs = getFilesState(state);
    try {
        const res = await client.request<unknown>("kanban.projects.list", {});
        const list = (Array.isArray(res) ? res : ((res as { projects?: unknown[] })?.projects ?? [])) as Array<{ id?: string; name?: string; title?: string }>;
        const names = new Map<string, string>();
        for (const p of list) if (p?.id && (p.name || p.title)) names.set(p.id, String(p.name || p.title));
        if (names.size) {
            fs.projectNames = names;
            state.requestUpdate?.();
        }
    } catch {
        /* names are cosmetic */
    }
}

interface TreeLike { name: string; path: string; isDirectory: boolean; type: string; extension?: string; children?: TreeLike[] }

function flattenTree(node: TreeLike | null | undefined, out: FileEntry[] = []): FileEntry[] {
    for (const c of node?.children ?? []) {
        if (c.isDirectory) flattenTree(c, out);
        else out.push({ name: c.name, path: c.path, isDirectory: false, size: 0, modified: 0, type: c.type, extension: c.extension ?? null });
    }
    return out;
}

/** Every file under the Files root (stat'd via files.search; the tree fills any overflow). */
export async function loadAllFiles(state: AppViewState, client: GatewayBrowserClient) {
    const fs = getFilesState(state);
    if (fs.allLoading) return;
    fs.allLoading = true;
    if (!fs.allItems) state.requestUpdate?.();
    try {
        const search = await client
            .request<{ results: FileEntry[] }>("files.search", { query: ".", regex: true, path: "", limit: 2000 })
            .catch(() => ({ results: [] as FileEntry[] }));
        // Exactly 100 = an older gateway that ignores `limit`: fill the rest from the tree.
        const tree = (search?.results?.length ?? 0) === 100
            ? await client.request<{ mainRoot: TreeLike }>("files.tree.all", { depth: 10 }).catch(() => null)
            : null;
        const byPath = new Map<string, FileEntry>();
        for (const r of search?.results ?? []) if (!r.isDirectory) byPath.set(r.path, r);
        // files.search caps at 100 on gateways without the `limit` param — the tree fills the rest.
        for (const t of flattenTree(tree?.mainRoot)) if (!byPath.has(t.path)) byPath.set(t.path, t);
        fs.allItems = [...byPath.values()];
    } catch (err: any) {
        fs.error = err.message || "Failed to list all files";
    } finally {
        fs.allLoading = false;
        state.requestUpdate?.();
    }
}

export function setScope(state: AppViewState, client: GatewayBrowserClient, scope: Scope) {
    const fs = getFilesState(state);
    fs.scope = scope;
    if (scope === "all") void loadAllFiles(state, client);
    state.requestUpdate?.();
}

/** FileEntry (+ OCR registry row) → the browser's normalised item. */
export function toBrowserItem(f: FileEntry, ctx?: OcrEntryInfo): BrowserItem {
    const status = f.ocr?.status ?? ctx?.status;
    const created = ctx?.createdAt ?? 0;
    return {
        key: f.path,
        name: f.name,
        path: f.path,
        ocrId: f.ocr?.id ?? ctx?.id,
        isDirectory: f.isDirectory,
        size: f.size || ctx?.size || 0,
        modified: f.modified || created,
        kind: f.isDirectory ? "folder" : f.type === "video" ? "video" : kindOfName(f.name),
        ext: (f.extension || extOf(f.name)).toLowerCase(),
        status: analysisStatusOf(status),
        rawStatus: status,
        summary: ctx?.summary,
        projectId: ctx?.source?.projectId ?? projectIdFromPath(f.path),
        folder: parentOf(f.path),
        snippet: f.snippet,
        secure: false,
        progress: f.ocr?.progress ?? ctx?.progress,
    };
}

// ── Polling ──────────────────────────────────────────

let filesPollTimer: ReturnType<typeof setInterval> | null = null;

export function startFilesPolling(state: AppViewState, client: GatewayBrowserClient) {
    if (filesPollTimer) return;
    void loadFiles(state, client);
    void loadTree(state, client);
    void loadDiskInfo(state, client);
    filesPollTimer = setInterval(() => {
        void loadFiles(state, client);
    }, 10_000);
}

export function stopFilesPolling() {
    if (filesPollTimer) {
        clearInterval(filesPollTimer);
        filesPollTimer = null;
    }
    if (ocrRefreshTimer) {
        clearTimeout(ocrRefreshTimer);
        ocrRefreshTimer = null;
    }
}
