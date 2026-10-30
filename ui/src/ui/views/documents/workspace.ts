/**
 * <ib-documents-workspace> — the Documents page (replaces the flat Notes list).
 *
 *   ┌──────────────┬───────────────────────────────────────────────┐
 *   │ search       │ breadcrumbs · ★ · history · export · …        │
 *   │ ★ favourites │                                               │
 *   │ ⏱ recent     │ folder → list / table (database props) / grid │
 *   │ 📁 tree (dnd)│ doc    → <ib-doc-editor> rich ⇄ markdown      │
 *   │ 🗑 trash     │ file   → PDF / image / media preview + text   │
 *   └──────────────┴───────────────────────────────────────────────┘
 *
 * Data: documents.* RPCs + /api/documents HTTP (uploads, originals). Live
 * updates arrive as the `notes:changed` gateway event, re-dispatched by
 * app-gateway as a window `documents:changed` event.
 */

import { LitElement, css, html, nothing, svg as svgPart, type PropertyValues, type SVGTemplateResult, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { toSanitizedMarkdownHtml } from "../../markdown";
import { downloadBlob, noteToMarkdown, printNoteAsPdf, safeFilename } from "../../lib/export-note";
import { resolveSlug } from "../../lib/slugs";
import "../../components/doc-editor/doc-editor.js";
import { resolveDocAssetImages, setDocAssetResolver } from "../../components/doc-editor/md-to-html";
import { gatewayHttpBase } from "../../gateway-http-auth";
import "../../components/doc-agent-panel.js";
import { icons } from "../../icons";
import "../../components/people-chips";
import { withAppBase } from "../../app-base";
import {
  TYPE_COLOR_CHOICES,
  TYPE_ICON_CHOICES,
  assignableTypes,
  categoryRows,
  clientLibrary,
  creatableTypes,
  docTypeOf,
  fallbackTypes,
  matchesQuery,
  moveInOrder,
  newTitleFor,
  renderTemplate,
  sidebarTypeRows,
  typeMeta,
  type DocTypeDef,
  type LibraryItem,
  type LibraryResult,
} from "./doc-types";
import {
  DocumentsApi,
  isJobActive,
  type ImportCollection,
  type ImportJob,
  type MappingPreview,
  type MappingRole,
  type NotionSearchResult,
  type RpcClient,
} from "./api";
import {
  ancestorsOf,
  buildTreeIndex,
  formatBytes,
  docRefIds,
  formatProp,
  isInside,
  previewKind,
  sortRows,
  tableColumns,
  type DocDetail,
  type DocSummary,
  type TreeIndex,
  type TreeSort,
} from "./model";

const LS_EXPANDED = "infinibot:documents:expanded";
const LS_RECENT = "infinibot:documents:recent";
const LS_SORT = "infinibot:documents:sort";
const LS_LAST = "infinibot:documents:last";
const LS_ROOT_MODE = "infinibot:documents:rootMode";
const SAVE_DEBOUNCE_MS = 700;

type ImportTab = "notion" | "zip" | "obsidian" | "map" | "url";

type Dialog =
  | { kind: "import"; tab: ImportTab }
  | { kind: "history"; revisions: Array<{ rev: string; at: string; title: string; bodyLength: number; author?: string }>; preview?: { rev: string; body: string } }
  | { kind: "move"; id: string }
  | { kind: "types" }
  | null;

/** Hairline stroke icons (inherit currentColor). */
// Inner shapes use lit's `svg` tag so they are created in the SVG namespace
// (an `html` child template makes HTML <path> elements that never paint).
const svg = (d: SVGTemplateResult) => html`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  newDoc: svg(svgPart`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 11v6M9 14h6" />`),
  newFolder: svg(svgPart`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10v6M9 13h6" />`),
  upload: svg(svgPart`<path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />`),
  importIn: svg(svgPart`<path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 20h16" />`),
  search: svg(svgPart`<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />`),
  menu: svg(svgPart`<path d="M4 7h16M4 12h16M4 17h16" />`),
  star: svg(svgPart`<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />`),
  starOn: html`<svg class="i" viewBox="0 0 24 24" aria-hidden="true" style="fill:currentColor"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" /></svg>`,
  history: svg(svgPart`<path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" />`),
  sparkle: svg(svgPart`<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />`),
  move: svg(svgPart`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M10 13h6M13 10l3 3-3 3" />`),
  trash: svg(svgPart`<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />`),
  list: svg(svgPart`<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />`),
  table: svg(svgPart`<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" />`),
  grid: svg(svgPart`<rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />`),
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* quota / private mode */
  }
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

@customElement("ib-documents-workspace")
export class DocumentsWorkspace extends LitElement {
  @property({ attribute: false }) client: RpcClient | null = null;
  /** Deep-link slug (/notes/:slug or /documents/:slug) to open once the tree loads. */
  @property({ attribute: false }) pendingSlug: string | null = null;

  @state() private nodes: DocSummary[] = [];
  @state() private index: TreeIndex = buildTreeIndex([]);
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private selectedId: string | null = null;
  @state() private detail: DocDetail | null = null;
  @state() private detailLoading = false;
  @state() private expanded = new Set<string>(readJson<string[]>(LS_EXPANDED, []));
  @state() private recent: string[] = readJson<string[]>(LS_RECENT, []);
  @state() private sort: TreeSort = (localStorage.getItem(LS_SORT) as TreeSort) || "manual";
  @state() private query = "";
  @state() private hits: Array<{ id: string; kind: string; title: string; path: string; snippet: string }> | null = null;
  @state() private trash: DocSummary[] | null = null;
  @state() private saveState: "saved" | "dirty" | "saving" | "error" = "saved";
  @state() private remoteChanged = false;
  @state() private dialog: Dialog = null;
  @state() private toast: string | null = null;
  @state() private uploads: Array<{ name: string; status: "uploading" | "done" | "error"; error?: string }> = [];
  @state() private dragOverId: string | null | undefined = undefined;
  @state() private fileDropActive = false;
  @state() private ticket = "";
  @state() private renamingId: string | null = null;
  @state() private fileTab: "preview" | "text" = "preview";
  @state() private agentOpen = false;
  @state() private sidebarOpen = true;
  @state() private tableSort: { by?: string; dir: "asc" | "desc" } = { dir: "asc" };
  @state() private folderMode: "list" | "table" | "grid" | null = null;
  // Import dialog state
  @state() private notionConnected: boolean | null = null;
  @state() private notionToken = "";
  @state() private notionQuery = "";
  @state() private notionResults: NotionSearchResult[] = [];
  @state() private notionPicked = new Set<string>();
  @state() private notionBusy = false;
  @state() private importUrl = "";
  @state() private importResult: string | null = null;
  /** Background import job shown in the dialog / sidebar chip (reattached after reloads). */
  @state() private importJob: ImportJob | null = null;
  @state() private importErrorsOpen = false;
  @state() private notionForce = false;
  /** Hosted plans: no local folders / git — Obsidian vaults come in as a ZIP. */
  @state() private hostedImports = false;
  @state() private obsidianSource: "folder" | "zip" | "git" = "folder";
  @state() private obsidianPath = "";
  @state() private obsidianUrl = "";
  @state() private obsidianTasks = false;
  @state() private mapCollections: ImportCollection[] | null = null;
  @state() private mapFolderId = "";
  @state() private mapRole: MappingRole | null = null;
  @state() private mapPreview: MappingPreview | null = null;
  @state() private mapFieldMap: Record<string, string> = {};
  @state() private mapBusy = false;
  // ── Types / library ──
  @state() private types: DocTypeDef[] = fallbackTypes();
  /** Gateway serves documents.types.* (false = restart pending → built-ins, read-only). */
  @state() private typesLive = false;
  @state() private lib: LibraryResult | null = null;
  @state() private libType: string | null = null;
  @state() private libCategory: string | null = null;
  @state() private rootMode: "library" | "folders" = (localStorage.getItem(LS_ROOT_MODE) as "library" | "folders") || "library";
  @state() private newMenu: { x: number; y: number; parentId: string | null } | null = null;
  @state() private typeMenu = false;
  @state() private newType = { label: "", icon: "tag", color: "#d9b45f", template: "" };
  private importPoll: ReturnType<typeof setInterval> | null = null;

  private api: DocumentsApi | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBody: string | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private dragId: string | null = null;
  /** Our own saves echo back as notes:changed — ignore those for the open doc. */
  private ownWriteUntil = 0;

  private onChanged = (e: Event) => {
    const detail = (e as CustomEvent<{ id?: string; op?: string }>).detail ?? {};
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.onRemoteChange(detail), 250);
  };

  private onImportProgress = (e: Event) => {
    const job = (e as CustomEvent<{ job?: ImportJob }>).detail?.job;
    if (job?.id) this.onJobUpdate(job);
  };

  private onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && this.isConnected) {
      const input = this.renderRoot.querySelector<HTMLInputElement>(".search input");
      if (input) {
        e.preventDefault();
        input.focus();
        input.select();
      }
    }
  };

  private onIdeasChanged = () => void this.loadLibrary();

  private onDocClick = (e: MouseEvent) => {
    if (!this.newMenu && !this.typeMenu) return;
    const path = e.composedPath();
    if (path.some((el) => el instanceof HTMLElement && (el.classList?.contains("pop") || el.dataset?.popTrigger === "1"))) return;
    this.newMenu = null;
    this.typeMenu = false;
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("ideas:changed", this.onIdeasChanged);
    window.addEventListener("click", this.onDocClick, true);
    window.addEventListener("documents:changed", this.onChanged);
    window.addEventListener("documents:import-progress", this.onImportProgress);
    window.addEventListener("keydown", this.onKey);
    if (this.api) void this.reattachImportJob();
  }

  disconnectedCallback(): void {
    window.removeEventListener("ideas:changed", this.onIdeasChanged);
    window.removeEventListener("click", this.onDocClick, true);
    window.removeEventListener("documents:changed", this.onChanged);
    window.removeEventListener("documents:import-progress", this.onImportProgress);
    window.removeEventListener("keydown", this.onKey);
    this.stopImportPoll();
    void this.flushSave();
    super.disconnectedCallback();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("client") && this.client) {
      this.api = new DocumentsApi(this.client);
      void this.api.ensureSession();
      void this.api
        .getTicket()
        .then((t) => {
          this.ticket = t;
          this.installAssetResolver();
        })
        .catch(() => undefined);
      void this.loadTree(true).then(() => this.loadTypes()).then(() => this.loadLibrary());
      void this.reattachImportJob();
    }
    // The host passes a deep-link slug for one render only (it is cleared on
    // the next app render), so latch it until the tree has loaded.
    if (changed.has("pendingSlug") && this.pendingSlug) {
      this.queuedSlug = this.pendingSlug;
      if (this.treeLoaded) this.consumeSlug();
    }
  }

  /** Deep-link slug waiting for the tree (see updated()). */
  private queuedSlug: string | null = null;
  private treeLoaded = false;

  /**
   * Hosted cloud: the UI and the tenant gateway are different sites, so
   * embedded document images (/api/documents/assets/…) are shown through
   * absolute, ticketed URLs. Same-origin installs need nothing (cookie).
   */
  private installAssetResolver(): void {
    const base = gatewayHttpBase();
    if (!base) return;
    setDocAssetResolver((path) => (this.ticket ? `${base}${path}?t=${encodeURIComponent(this.ticket)}` : null));
    this.requestUpdate();
  }

  // ── Data ───────────────────────────────────────────────────

  private async loadTree(initial = false): Promise<void> {
    if (!this.api) return;
    try {
      const r = await this.api.tree();
      this.nodes = r.nodes;
      this.index = buildTreeIndex(r.nodes, this.sort);
      this.error = null;
      this.treeLoaded = true;
      if (initial) {
        if (this.queuedSlug) this.consumeSlug();
        else {
          const last = localStorage.getItem(LS_LAST);
          if (last && this.index.byId.has(last)) void this.open(last, { push: false });
        }
      }
    } catch (err) {
      this.error = String((err as Error)?.message ?? err);
    } finally {
      this.loading = false;
    }
  }

  private consumeSlug(): void {
    const slug = this.queuedSlug;
    if (!slug) return;
    this.queuedSlug = null;
    this.pendingSlug = null;
    const candidates = this.nodes.flatMap((n) => [
      { id: n.id, name: n.title },
      ...(n.source?.type === "note" && n.source.id ? [{ id: n.id, name: n.source.id }] : []),
    ]);
    const bySource = this.nodes.find((n) => n.source?.id === slug);
    let ref = bySource ? { id: bySource.id } : resolveSlug("note", slug, candidates);
    // `/notes/<name>--<noteId>` (note deep links, People chips, My Network):
    // the embedded id is the note's, so open the doc that mirrors it.
    if (ref?.id && !this.nodes.some((n) => n.id === ref!.id)) {
      const mirror = this.nodes.find((n) => n.source?.type === "note" && n.source.id === ref!.id);
      if (mirror) ref = { id: mirror.id };
    }
    if (ref?.id) void this.open(ref.id, { push: false });
  }

  private async onRemoteChange(change: { id?: string; op?: string }): Promise<void> {
    await this.loadTree();
    if (change.id?.startsWith("type:")) await this.loadTypes();
    void this.loadLibrary();
    if (this.trash) void this.loadTrash();
    if (this.query) void this.runSearch();
    const sel = this.selectedId;
    if (!sel) return;
    if (!this.index.byId.has(sel)) {
      // Deleted elsewhere.
      if (change.op === "delete") this.select(null);
      return;
    }
    if (change.id && change.id !== sel && this.detail?.node.kind !== "folder") return;
    if (change.id === sel && Date.now() < this.ownWriteUntil) return;
    if (this.saveState === "dirty" || this.saveState === "saving") {
      this.remoteChanged = true;
      return;
    }
    await this.refreshDetail();
  }

  private async refreshDetail(): Promise<void> {
    if (!this.api || !this.selectedId) return;
    try {
      const d = await this.api.get(this.selectedId);
      const editor = this.editorEl();
      if (this.detail?.node.id === d.node.id && editor && d.body !== undefined && editor.getMarkdown?.() !== d.body) {
        editor.setValue?.(d.body, { force: true });
      }
      this.detail = d;
      this.remoteChanged = false;
    } catch {
      /* transient */
    }
  }

  private select(id: string | null): void {
    this.selectedId = id;
    if (!id) {
      this.detail = null;
      localStorage.removeItem(LS_LAST);
    }
  }

  async open(id: string, opts: { push?: boolean } = {}): Promise<void> {
    if (!this.api) return;
    await this.flushSave();
    this.select(id);
    this.detailLoading = true;
    this.remoteChanged = false;
    this.fileTab = "preview";
    this.folderMode = null;
    try {
      const d = await this.api.get(id);
      if (this.selectedId !== id) return;
      this.detail = d;
      this.saveState = "saved";
      localStorage.setItem(LS_LAST, d.node.id);
      for (const a of ancestorsOf(this.index, d.node.id)) this.expanded.add(a);
      this.expanded = new Set(this.expanded);
      writeJson(LS_EXPANDED, [...this.expanded]);
      if (d.node.kind !== "folder") {
        this.recent = [d.node.id, ...this.recent.filter((x) => x !== d.node.id)].slice(0, 12);
        writeJson(LS_RECENT, this.recent);
      }
      if (opts.push !== false) {
        this.dispatchEvent(new CustomEvent("doc-opened", { detail: { id: d.node.id, title: d.node.title }, bubbles: true, composed: true }));
      }
      if (window.matchMedia?.("(max-width: 820px)").matches) this.sidebarOpen = false;
    } catch (err) {
      this.flash(`Couldn't open: ${(err as Error).message}`);
    } finally {
      this.detailLoading = false;
    }
  }

  private flash(msg: string): void {
    this.toast = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), 3600);
  }

  // ── Saving ─────────────────────────────────────────────────

  private editorEl(): (HTMLElement & { getMarkdown?: () => string; setValue?: (md: string, o?: { force?: boolean }) => void }) | null {
    return this.renderRoot.querySelector("ib-doc-editor");
  }

  private onDocChange(md: string): void {
    if (!this.detail || this.detail.node.kind !== "doc") return;
    this.pendingBody = md;
    this.saveState = "dirty";
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushSave(), SAVE_DEBOUNCE_MS);
  }

  private async flushSave(snapshot = false): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const body = this.pendingBody;
    const id = this.detail?.node.id;
    if (body == null || !id || !this.api) return;
    this.pendingBody = null;
    this.saveState = "saving";
    this.ownWriteUntil = Date.now() + 3000;
    try {
      await this.api.update({ id, body, snapshot });
      this.ownWriteUntil = Date.now() + 1500;
      if (this.detail?.node.id === id) this.detail = { ...this.detail, body };
      this.saveState = this.pendingBody == null ? "saved" : "dirty";
    } catch (err) {
      this.pendingBody = body;
      this.saveState = "error";
      this.flash(`Save failed: ${(err as Error).message}`);
    }
  }

  // ── Types / library ────────────────────────────────────────

  private async loadTypes(): Promise<void> {
    if (!this.api) return;
    try {
      const r = await this.api.types();
      if (Array.isArray(r.types) && r.types.length) this.types = r.types;
      this.typesLive = true;
    } catch {
      this.types = fallbackTypes();
      this.typesLive = false;
    }
  }

  /** documents.library, or (older gateway) documents.tree + ideas.list merged here. */
  private async loadLibrary(): Promise<void> {
    if (!this.api) return;
    try {
      const r = await this.api.library({ limit: 5000 });
      this.lib = { items: r.items, total: r.total, counts: r.counts };
      if (Array.isArray(r.types) && r.types.length) {
        this.types = r.types;
        this.typesLive = true;
      }
      return;
    } catch {
      /* fall back below */
    }
    let ideas: Awaited<ReturnType<DocumentsApi["ideas"]>>["ideas"] = [];
    try {
      ideas = (await this.api.ideas()).ideas ?? [];
    } catch {
      ideas = [];
    }
    this.lib = clientLibrary(this.nodes, ideas, this.types);
  }

  private typeIcon(t: DocTypeDef, cls = "ty-ico"): TemplateResult {
    const ic = (icons as Record<string, TemplateResult>)[t.icon] ?? icons.fileText;
    return html`<span class=${cls} style="--tc:${t.color}" aria-hidden="true">${ic}</span>`;
  }

  /** Premium SVG icon for a tree/list node (type icon for docs; no emoji). */
  private nodeIcon(n: DocSummary): TemplateResult {
    if (n.kind === "folder") return html`<span class="ty-ico" aria-hidden="true">${n.schema?.length ? icons.database : icons.folder}</span>`;
    if (n.kind === "file") {
      const k = previewKind(n.file);
      const ic = k === "image" ? icons.image : k === "video" ? icons.video : k === "audio" ? icons.volumeUp : k === "pdf" ? icons.fileText : icons.paperclip;
      return html`<span class="ty-ico" aria-hidden="true">${ic}</span>`;
    }
    return this.typeIcon(typeMeta(this.types, docTypeOf(n, this.types)));
  }

  private showLibrary(type: string | null, category: string | null = null): void {
    void this.flushSave();
    this.libType = type;
    this.libCategory = category;
    this.rootMode = "library";
    localStorage.setItem(LS_ROOT_MODE, "library");
    this.select(null);
    this.hits = null;
    this.query = "";
    if (window.matchMedia?.("(max-width: 820px)").matches) this.sidebarOpen = false;
  }

  private setRootMode(mode: "library" | "folders"): void {
    this.rootMode = mode;
    localStorage.setItem(LS_ROOT_MODE, mode);
  }

  private openNewMenu(e: Event, parentId: string | null = this.currentFolderId()): void {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const host = this.getBoundingClientRect();
    const width = 260;
    const x = Math.max(8, Math.min(r.left - host.left, host.width - width - 8));
    this.newMenu = this.newMenu ? null : { x, y: r.bottom - host.top + 6, parentId };
  }

  /** Create an item of a type: ideas go to the Ideas store, everything else is a typed doc. */
  private async createTyped(t: DocTypeDef, parentId: string | null = this.currentFolderId()): Promise<void> {
    this.newMenu = null;
    if (!this.api) return;
    try {
      if (t.backing === "ideas") {
        const { idea } = await this.api.createIdea({ title: newTitleFor(t) });
        void this.loadLibrary();
        this.flash("Idea captured — opening it in Ideas");
        this.dispatchEvent(new CustomEvent("open-idea", { detail: { id: idea.id }, bubbles: true, composed: true }));
        return;
      }
      if (!t.creatable) return;
      const { node } = await this.api.create({
        kind: "doc",
        title: newTitleFor(t),
        parentId,
        type: t.id,
        // Older gateways ignore `type`; send the template body so the doc still starts right.
        body: this.typesLive ? undefined : renderTemplate(t.template),
      });
      if (parentId) this.expanded = new Set([...this.expanded, parentId]);
      await this.loadTree();
      void this.loadLibrary();
      await this.open(node.id);
      this.renamingId = node.id;
      await this.updateComplete;
      const input = this.renderRoot.querySelector<HTMLInputElement>(".title-input");
      input?.focus();
      input?.select();
    } catch (err) {
      this.flash((err as Error).message);
    }
  }

  private async setDocType(n: DocSummary, type: string): Promise<void> {
    this.typeMenu = false;
    if (!this.api || type === n.type) return;
    if (!this.typesLive) {
      this.flash("Changing a type needs the gateway restart that turns document types on.");
      return;
    }
    try {
      this.ownWriteUntil = Date.now() + 1500;
      await this.api.update({ id: n.id, type });
      await this.loadTree();
      await this.refreshDetail();
      void this.loadLibrary();
      this.flash(`Now a ${typeMeta(this.types, type).label}`);
    } catch (err) {
      this.flash((err as Error).message);
    }
  }

  private async setDocCategory(n: DocSummary, raw: string): Promise<void> {
    const category = raw.trim();
    if (!this.api || category === (n.category ?? "")) return;
    try {
      this.ownWriteUntil = Date.now() + 1500;
      await this.api.update({ id: n.id, category });
      await this.loadTree();
      await this.refreshDetail();
      void this.loadLibrary();
    } catch (err) {
      this.flash((err as Error).message);
    }
  }

  private openLibraryItem(it: LibraryItem): void {
    if (it.source === "doc") {
      void this.open(it.id);
      return;
    }
    if (it.source === "idea") {
      this.dispatchEvent(new CustomEvent("open-idea", { detail: { id: it.id }, bubbles: true, composed: true }));
      return;
    }
    const path = it.source === "report" ? "/reports" : "/research";
    try {
      window.history.pushState({}, "", withAppBase(path));
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
      /* best effort */
    }
  }

  private async typeAction(fn: () => Promise<{ types: DocTypeDef[] }>, ok?: string): Promise<boolean> {
    if (!this.typesLive) {
      this.flash("Custom types need the gateway restart that turns document types on.");
      return false;
    }
    try {
      const r = await fn();
      this.types = r.types;
      if (ok) this.flash(ok);
      void this.loadLibrary();
      return true;
    } catch (err) {
      this.flash((err as Error).message);
      return false;
    }
  }

  // ── Mutations ──────────────────────────────────────────────

  private currentFolderId(): string | null {
    const n = this.detail?.node;
    if (!n) return null;
    return n.kind === "folder" ? n.id : n.parentId;
  }

  private async create(kind: "doc" | "folder", parentId = this.currentFolderId()): Promise<void> {
    if (!this.api) return;
    try {
      const { node } = await this.api.create({ kind, title: kind === "folder" ? "New folder" : "Untitled", parentId });
      if (parentId) this.expanded = new Set([...this.expanded, parentId]);
      await this.loadTree();
      await this.open(node.id);
      this.renamingId = node.id;
      await this.updateComplete;
      const input = this.renderRoot.querySelector<HTMLInputElement>(".title-input");
      input?.focus();
      input?.select();
    } catch (err) {
      this.flash((err as Error).message);
    }
  }

  private async rename(id: string, title: string): Promise<void> {
    this.renamingId = null;
    const t = title.trim();
    const node = this.index.byId.get(id);
    if (!this.api || !t || !node || t === node.title) return;
    await this.api.update({ id, title: t });
    await this.loadTree();
    if (this.selectedId === id) await this.refreshDetail();
  }

  private async toggleFavorite(n: DocSummary): Promise<void> {
    await this.api?.update({ id: n.id, favorite: !n.favorite });
    await this.loadTree();
    if (this.selectedId === n.id) await this.refreshDetail();
  }

  private async trashNode(n: DocSummary): Promise<void> {
    if (!this.api) return;
    const what = n.kind === "folder" ? `folder "${n.title}" and everything in it` : `"${n.title}"`;
    if (!confirm(`Move ${what} to trash? You can restore it from Trash.`)) return;
    await this.api.remove(n.id);
    if (this.selectedId && (this.selectedId === n.id || isInside(this.index, n.id, this.selectedId))) {
      this.select(n.parentId);
      if (n.parentId) await this.open(n.parentId, { push: false });
    }
    await this.loadTree();
    if (this.trash) await this.loadTrash();
    this.flash("Moved to trash");
  }

  private async move(id: string, parentId: string | null, index?: number): Promise<void> {
    if (!this.api) return;
    if (parentId && isInside(this.index, id, parentId)) {
      this.flash("Can't move a folder into itself");
      return;
    }
    try {
      await this.api.move(id, parentId, index);
      if (parentId) this.expanded = new Set([...this.expanded, parentId]);
      await this.loadTree();
      if (this.selectedId === id || this.detail?.node.id === parentId) await this.refreshDetail();
    } catch (err) {
      this.flash((err as Error).message);
    }
  }

  private async loadTrash(): Promise<void> {
    if (!this.api) return;
    this.trash = (await this.api.trash()).nodes;
  }

  private async runSearch(): Promise<void> {
    const q = this.query.trim();
    if (!this.api || !q) {
      this.hits = null;
      return;
    }
    const r = await this.api.search(q);
    if (this.query.trim() === q) this.hits = r.hits;
  }

  // ── Uploads ────────────────────────────────────────────────

  private async uploadFiles(files: File[], parentId: string | null = this.currentFolderId()): Promise<void> {
    if (!this.api || !files.length) return;
    this.uploads = [...this.uploads.filter((u) => u.status === "uploading"), ...files.map((f) => ({ name: f.name, status: "uploading" as const }))];
    let lastId: string | null = null;
    for (const f of files) {
      try {
        const r = await this.api.upload(f, { parentId, name: f.name });
        lastId = r.node?.id ?? lastId;
        this.uploads = this.uploads.map((u) => (u.name === f.name && u.status === "uploading" ? { ...u, status: "done" } : u));
      } catch (err) {
        this.uploads = this.uploads.map((u) =>
          u.name === f.name && u.status === "uploading" ? { ...u, status: "error", error: (err as Error).message } : u,
        );
      }
    }
    await this.loadTree();
    if (files.length === 1 && lastId) await this.open(lastId);
    else if (this.detail?.node.kind === "folder") await this.refreshDetail();
    setTimeout(() => (this.uploads = this.uploads.filter((u) => u.status === "error")), 4000);
  }

  private pickFiles(parentId: string | null = this.currentFolderId()): void {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => void this.uploadFiles([...(input.files ?? [])], parentId);
    input.click();
  }

  private uploadImage = async (file: File): Promise<string> => {
    if (!this.api) throw new Error("not connected");
    const r = await this.api.upload<{ ok: boolean; url: string }>(file, {
      parentId: null,
      name: file.name || "pasted.png",
      mode: "asset",
    });
    return r.url;
  };

  // ── Drag & drop (tree moves + OS file drops) ───────────────

  private onRowDragStart(e: DragEvent, n: DocSummary): void {
    this.dragId = n.id;
    e.dataTransfer?.setData("application/x-ib-doc", n.id);
    e.dataTransfer?.setData("text/plain", n.title);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  private isFileDrag(e: DragEvent): boolean {
    return Boolean(e.dataTransfer?.types?.includes("Files"));
  }

  private onRowDragOver(e: DragEvent, target: DocSummary | null): void {
    const fileDrag = this.isFileDrag(e);
    if (!fileDrag && !this.dragId) return;
    const folderId = target ? (target.kind === "folder" ? target.id : target.parentId) : null;
    if (!fileDrag && this.dragId && folderId && isInside(this.index, this.dragId, folderId)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = fileDrag ? "copy" : "move";
    this.dragOverId = target ? target.id : null;
  }

  private async onRowDrop(e: DragEvent, target: DocSummary | null): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    this.dragOverId = undefined;
    this.fileDropActive = false;
    const files = [...(e.dataTransfer?.files ?? [])];
    const folderId = target ? (target.kind === "folder" ? target.id : target.parentId) : null;
    if (files.length) {
      await this.uploadFiles(files, folderId);
      return;
    }
    const id = this.dragId ?? e.dataTransfer?.getData("application/x-ib-doc");
    this.dragId = null;
    if (!id || id === target?.id) return;
    if (target && target.kind !== "folder") {
      // Dropped on a doc/file → place just before it among its siblings.
      const siblings = (this.index.children.get(target.parentId) ?? []).filter((s) => s.id !== id);
      await this.move(id, target.parentId, siblings.findIndex((s) => s.id === target.id));
    } else {
      await this.move(id, folderId);
    }
  }

  // ── Export ─────────────────────────────────────────────────

  private exportDoc(kind: "md" | "pdf"): void {
    const d = this.detail;
    if (!d || d.node.kind !== "doc") return;
    const body = this.editorEl()?.getMarkdown?.() ?? d.body ?? "";
    if (kind === "md") downloadBlob(safeFilename(d.node.title, "md"), "text/markdown", noteToMarkdown(d.node.title, body));
    else {
      const r = printNoteAsPdf(d.node.title, body, "clean", { updatedAt: d.node.updatedAt, tags: d.node.tags });
      if (!r.ok) this.flash(r.reason ?? "Couldn't open the print dialog");
    }
  }

  // ── Import ─────────────────────────────────────────────────

  private async openImport(tab: ImportTab = "notion"): Promise<void> {
    this.dialog = { kind: "import", tab };
    if (this.api) void this.reattachImportJob();
    this.importResult = null;
    if (this.notionConnected === null && this.api) {
      try {
        const st = (await this.api.notionStatus()) as { connected: boolean; limits?: unknown };
        this.notionConnected = st.connected;
        this.hostedImports = !!st.limits;
        if (this.hostedImports) this.obsidianSource = "zip";
      } catch {
        this.notionConnected = false;
      }
    }
    if (tab === "map") void this.loadCollections();
    if (tab === "notion" && this.notionConnected && !this.notionResults.length) void this.searchNotion();
  }

  private async searchNotion(): Promise<void> {
    if (!this.api) return;
    this.notionBusy = true;
    try {
      this.notionResults = (await this.api.notionSearch(this.notionQuery, this.notionToken)).results;
      if (this.notionToken) this.notionConnected = true;
    } catch (err) {
      this.importResult = `Notion search failed: ${(err as Error).message}`;
    } finally {
      this.notionBusy = false;
    }
  }

  /** Notion ids of the picked results that were imported before (→ "Full re-sync" / "Sync changes"). */
  private pickedAlreadyImported(): boolean {
    const imported = new Set(
      this.nodes
        .filter((n) => n.source?.type === "notion" && n.source.id)
        .map((n) => String(n.source!.id).replace(/^folder:/, "").replace(/-/g, "")),
    );
    return [...this.notionPicked].some((id) => imported.has(id.replace(/-/g, "")));
  }

  private async runNotionImport(mode: "full" | "changes"): Promise<void> {
    if (!this.api || !this.notionPicked.size) return;
    this.notionBusy = true;
    this.importResult = null;
    this.importErrorsOpen = false;
    try {
      const picked = this.notionResults.filter((r) => this.notionPicked.has(r.id));
      const label =
        picked.length === 1
          ? picked[0]!.title || "Untitled"
          : `${picked[0]?.title || "Untitled"} + ${Math.max(0, this.notionPicked.size - 1)} more`;
      const r = await this.api.notionImport([...this.notionPicked], this.currentFolderId(), {
        mode,
        force: this.notionForce,
        token: this.notionToken,
        label,
      });
      this.onJobUpdate(r.job, { announce: false });
      if (r.reattached) this.flash("That import is already running — showing its progress");
    } catch (err) {
      this.importResult = `Import failed to start: ${(err as Error).message}`;
    } finally {
      this.notionBusy = false;
    }
  }

  private async importZip(file: File): Promise<void> {
    if (!this.api) return;
    this.notionBusy = true;
    this.importResult = `Uploading ${file.name}…`;
    this.importErrorsOpen = false;
    try {
      const r = await this.api.upload<{ ok: boolean; jobId?: string; job?: ImportJob; error?: string }>(file, {
        parentId: this.currentFolderId(),
        name: file.name,
        mode: "notion-zip",
      });
      if (!r.job) throw new Error(r.error || "upload failed");
      this.importResult = null;
      this.onJobUpdate(r.job, { announce: false });
    } catch (err) {
      this.importResult = `Import failed: ${(err as Error).message}`;
    } finally {
      this.notionBusy = false;
    }
  }

  // ── Obsidian ───────────────────────────────────────────────

  private async runObsidianImport(file?: File): Promise<void> {
    if (!this.api) return;
    this.notionBusy = true;
    this.importResult = null;
    this.importErrorsOpen = false;
    try {
      if (this.obsidianSource === "zip") {
        if (!file) return;
        this.importResult = `Uploading ${file.name}…`;
        const r = await this.api.upload<{ ok: boolean; job?: ImportJob; error?: string }>(file, {
          parentId: this.currentFolderId(),
          name: file.name,
          mode: "obsidian-zip",
          extra: this.obsidianTasks ? { createTasks: "1" } : {},
        });
        if (!r.job) throw new Error(r.error || "upload failed");
        this.importResult = null;
        this.onJobUpdate(r.job, { announce: false });
        return;
      }
      const r = await this.api.obsidianImport({
        source: this.obsidianSource,
        ...(this.obsidianSource === "git" ? { url: this.obsidianUrl.trim() } : { path: this.obsidianPath.trim() }),
        parentId: this.currentFolderId(),
        createTasks: this.obsidianTasks,
      });
      this.onJobUpdate(r.job, { announce: false });
      if (r.reattached) this.flash("That vault is already importing — showing its progress");
    } catch (err) {
      this.importResult = `Import failed to start: ${(err as Error).message}`;
    } finally {
      this.notionBusy = false;
    }
  }

  // ── Map a collection → projects / tasks / clients ──────────

  private async loadCollections(): Promise<void> {
    if (!this.api) return;
    try {
      this.mapCollections = (await this.api.importCollections()).collections;
      const current = this.currentFolderId();
      const pick = this.mapCollections.find((c) => c.id === current) ?? this.mapCollections[0];
      if (pick && !this.mapFolderId) await this.pickCollection(pick.id);
    } catch (err) {
      this.mapCollections = [];
      this.importResult = `Couldn't list collections: ${(err as Error).message}`;
    }
  }

  private async pickCollection(folderId: string, role: MappingRole | null = null, fieldMap?: Record<string, string>): Promise<void> {
    if (!this.api) return;
    this.mapFolderId = folderId;
    this.mapBusy = true;
    try {
      const { preview } = await this.api.mappingPreview(folderId, role, fieldMap);
      this.mapPreview = preview;
      this.mapRole = preview.role;
      this.mapFieldMap = { ...preview.fieldMap };
    } catch (err) {
      this.mapPreview = null;
      this.importResult = `Preview failed: ${(err as Error).message}`;
    } finally {
      this.mapBusy = false;
    }
  }

  private async applyMapping(): Promise<void> {
    if (!this.api || !this.mapPreview || !this.mapRole) return;
    this.mapBusy = true;
    this.importResult = null;
    try {
      const { job } = await this.api.mappingApply(this.mapFolderId, this.mapRole, this.mapFieldMap);
      this.importJob = job;
      this.announceJob(job);
      await this.pickCollection(this.mapFolderId, this.mapRole, this.mapFieldMap);
    } catch (err) {
      this.importResult = `Mapping failed: ${(err as Error).message}`;
    } finally {
      this.mapBusy = false;
    }
  }

  private async undoImport(job: ImportJob): Promise<void> {
    if (!this.api) return;
    if (!confirm(`Undo “${job.label}”? Docs it created go to Trash, docs it changed get their previous version back${job.kind === "map" || job.obsidian?.createTasks ? ", and the projects/tasks/clients it created are removed" : ""}.`)) return;
    try {
      const { job: next } = await this.api.undoImport(job.id);
      this.importJob = next;
      const u = next.undoReport;
      this.flash(`Undone — ${u?.trashed ?? 0} moved to Trash · ${u?.restored ?? 0} restored${u?.entitiesDeleted ? ` · ${u.entitiesDeleted} records removed` : ""}`);
      await this.loadTree();
      if (this.dialog?.kind === "import" && this.dialog.tab === "map") void this.loadCollections();
    } catch (err) {
      this.flash(`Couldn't undo: ${(err as Error).message}`);
    }
  }

  // ── Import jobs (background) ───────────────────────────────

  /** After a reload / navigation: pick the running job back up (or announce one that finished meanwhile). */
  private async reattachImportJob(): Promise<void> {
    if (!this.api) return;
    try {
      const { jobs } = await this.api.importJobs({ limit: 5 });
      const active = jobs.find((j) => isJobActive(j));
      if (active) {
        this.onJobUpdate(active, { announce: false });
        return;
      }
      const last = jobs[0];
      if (last && !this.importJob && !this.jobSeen(last.id)) {
        const finished = Date.parse(last.finishedAt ?? last.updatedAt);
        if (Date.now() - finished < 30 * 60_000) {
          this.importJob = last;
          this.announceJob(last);
        }
      }
    } catch {
      /* older gateway without import jobs — nothing to reattach */
    }
  }

  private jobSeen(id: string): boolean {
    try {
      return (JSON.parse(localStorage.getItem("documents.importSeen") ?? "[]") as string[]).includes(id);
    } catch {
      return false;
    }
  }

  private markJobSeen(id: string): void {
    try {
      const seen = (JSON.parse(localStorage.getItem("documents.importSeen") ?? "[]") as string[]).filter((x) => x !== id);
      localStorage.setItem("documents.importSeen", JSON.stringify([id, ...seen].slice(0, 30)));
    } catch {
      /* storage unavailable */
    }
  }

  private onJobUpdate(job: ImportJob, opts: { announce?: boolean } = {}): void {
    const prev = this.importJob;
    // Another job's events don't replace the one on screen unless it is idle.
    if (prev && prev.id !== job.id && isJobActive(prev) && !isJobActive(job)) return;
    if (prev?.id === job.id && Date.parse(job.updatedAt) < Date.parse(prev.updatedAt)) return;
    this.importJob = job;
    if (isJobActive(job)) {
      this.startImportPoll();
      return;
    }
    this.stopImportPoll();
    if (opts.announce !== false && (!prev || prev.id !== job.id || isJobActive(prev))) this.announceJob(job);
  }

  private announceJob(job: ImportJob): void {
    if (this.jobSeen(job.id)) return;
    this.markJobSeen(job.id);
    const r = job.report;
    const what = jobKindLabel(job);
    if (job.status === "done") {
      this.flash(`${what} finished — ${r.created} new · ${r.updated} updated · ${r.unchanged} unchanged${job.errorCount ? ` · ${job.errorCount} errors` : ""}`);
    } else if (job.status === "cancelled") {
      this.flash(`${what} cancelled — ${r.created + r.updated} pages were saved`);
    } else if (job.status === "failed") {
      this.flash(`${what} failed: ${job.error ?? "unknown error"}`);
    }
    void this.loadTree();
  }

  /** Fallback when progress events are dropped (slow socket, reconnect): poll every 3s. */
  private startImportPoll(): void {
    if (this.importPoll) return;
    this.importPoll = setInterval(() => {
      const job = this.importJob;
      if (!this.api || !job || !isJobActive(job)) return this.stopImportPoll();
      void this.api
        .importJob(job.id)
        .then((r) => this.onJobUpdate(r.job))
        .catch(() => undefined);
    }, 3_000);
  }

  private stopImportPoll(): void {
    if (this.importPoll) clearInterval(this.importPoll);
    this.importPoll = null;
  }

  private async cancelImport(): Promise<void> {
    const job = this.importJob;
    if (!this.api || !job) return;
    try {
      this.onJobUpdate((await this.api.cancelImportJob(job.id)).job);
    } catch (err) {
      this.flash(`Couldn't cancel: ${(err as Error).message}`);
    }
  }

  private dismissImportJob(): void {
    if (this.importJob) this.markJobSeen(this.importJob.id);
    this.importJob = null;
    this.importErrorsOpen = false;
  }

  private renderImportJob(job: ImportJob): TemplateResult {
    const active = isJobActive(job);
    const p = job.progress;
    const r = job.report;
    const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    const limited = p.rateLimitedUntil && Date.parse(p.rateLimitedUntil) > Date.now();
    const statusText =
      job.status === "queued"
        ? "Queued"
        : job.status === "running"
          ? job.cancelRequested
            ? "Cancelling…"
            : p.phase === "scan"
              ? "Scanning"
              : "Importing"
          : job.status === "done"
            ? "Done"
            : job.status === "cancelled"
              ? "Cancelled"
              : "Failed";
    const errors = r.errors ?? [];
    return html`<section class="job ${job.status}" aria-live="polite">
      <div class="job-head">
        <span class="job-status ${job.status}">${statusText}</span>
        <span class="job-label" title=${job.label}>${jobKindPrefix(job)}${job.label}</span>
        ${job.attempts > 1 ? html`<span class="pill" title="The gateway restarted while this import ran; it picked up where it left off">Resumed</span>` : nothing}
      </div>
      <div class="bar ${active && p.total === 0 ? "indeterminate" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax=${p.total} aria-valuenow=${p.done}>
        <span style="width:${active ? pct : 100}%"></span>
      </div>
      <div class="job-counts">
        ${active
          ? html`<span title="The total grows as the import discovers sub-pages and database rows"><b>${p.done.toLocaleString()}</b> done · ${p.total.toLocaleString()} found so far</span>`
          : html`<span><b>${p.done.toLocaleString()}</b> pages</span>`}
        <span>${r.created} new</span>
        <span>${r.updated} updated</span>
        <span>${r.unchanged} unchanged</span>
        ${r.skipped ? html`<span>${r.skipped} skipped (in trash)</span>` : nothing}
        ${job.errorCount ? html`<span class="err">${job.errorCount} error${job.errorCount === 1 ? "" : "s"}</span>` : nothing}
      </div>
      ${!active && job.details ? renderJobDetails(job) : nothing}
      ${job.undoneAt ? html`<div class="job-note small">Undone ${relTime(job.undoneAt)} — ${job.undoReport?.trashed ?? 0} moved to Trash, ${job.undoReport?.restored ?? 0} restored${job.undoReport?.entitiesDeleted ? `, ${job.undoReport.entitiesDeleted} records removed` : ""}.</div>` : nothing}
      ${active && p.current ? html`<div class="job-current dim small" title=${p.current}>${p.phase === "scan" ? "" : "Now: "}${p.current}</div>` : nothing}
      ${active && limited ? html`<div class="job-note small">Notion rate limit hit — pausing briefly and retrying automatically (${p.rateLimited}× so far).</div>` : nothing}
      ${active ? html`<div class="dim small">Runs on the gateway — you can close this dialog, leave the page or reload; progress picks up where it is.</div>` : nothing}
      ${job.status === "failed" && job.error ? html`<div class="job-note err small">${job.error}</div>` : nothing}
      ${errors.length
        ? html`<button class="linkish small" @click=${() => (this.importErrorsOpen = !this.importErrorsOpen)}>
              ${this.importErrorsOpen ? "Hide" : "Show"} ${job.errorCount} page error${job.errorCount === 1 ? "" : "s"} (the rest imported fine)
            </button>
            ${this.importErrorsOpen
              ? html`<ul class="job-errors">
                  ${errors.slice(0, 200).map((e) => html`<li><b>${e.title || e.id || "item"}</b> — ${e.error}</li>`)}
                </ul>`
              : nothing}`
        : nothing}
      <div class="dlg-actions">
        ${active
          ? html`<button class="btn ghost" ?disabled=${job.cancelRequested} @click=${() => this.cancelImport()}>Cancel import</button>`
          : html`${job.status === "done" && r.rootNodeIds?.[0]
                ? html`<button class="btn" @click=${() => {
                    const id = r.rootNodeIds![0]!;
                    this.dismissImportJob();
                    this.dialog = null;
                    void this.open(id);
                  }}>Open imported</button>`
                : nothing}
              ${(job.undoable ?? 0) > 0 && !job.undoneAt
                ? html`<button class="btn ghost" data-testid="import-undo" title="Reverse everything this batch wrote" @click=${() => this.undoImport(job)}>Undo import</button>`
                : nothing}
              <button class="btn ghost" @click=${() => this.dismissImportJob()}>${job.status === "done" ? "Done" : "Dismiss"}</button>`}
      </div>
    </section>`;
  }

  private renderObsidianTab(jobBusy: boolean): TemplateResult {
    const sources = (this.hostedImports ? ["zip"] : ["folder", "zip", "git"]) as Array<"folder" | "zip" | "git">;
    const pickZip = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".zip,application/zip";
      input.onchange = () => input.files?.[0] && this.runObsidianImport(input.files[0]);
      input.click();
    };
    return html`<div class="obs-import" data-testid="obsidian-import">
      <div class="seg" role="tablist" aria-label="Vault source">
        ${sources.map(
          (src) => html`<button role="tab" class="seg-btn ${this.obsidianSource === src ? "on" : ""}" aria-selected=${this.obsidianSource === src} @click=${() => (this.obsidianSource = src)}>
            ${src === "folder" ? "Vault folder" : src === "zip" ? "ZIP upload" : "Git URL"}
          </button>`,
        )}
      </div>
      ${this.obsidianSource === "folder"
        ? html`<div class="field row-field">
            <input data-testid="obsidian-path" placeholder="~/Documents/My Vault" .value=${this.obsidianPath} @input=${(e: Event) => (this.obsidianPath = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.runObsidianImport()} />
          </div>
          <div class="dim small">The folder that contains your notes (the one with the hidden <code>.obsidian</code> folder). It's read, never changed.</div>`
        : this.obsidianSource === "git"
          ? html`<div class="field row-field">
              <input data-testid="obsidian-url" placeholder="https://github.com/you/notes.git" .value=${this.obsidianUrl} @input=${(e: Event) => (this.obsidianUrl = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.runObsidianImport()} />
            </div>
            <div class="dim small">A public https repository (e.g. one synced with the Obsidian Git plugin). Private repos: clone it and use the folder option.</div>`
          : html`<div class="dropbox" @dragover=${(e: DragEvent) => e.preventDefault()} @drop=${(e: DragEvent) => {
              e.preventDefault();
              const f = e.dataTransfer?.files?.[0];
              if (f && !jobBusy) void this.runObsidianImport(f);
            }}>
              <div>Zip your vault folder and drop the <b>.zip</b> here.</div>
              <div class="dim small">Re-upload a newer ZIP of the same vault any time — changed notes update, nothing duplicates.</div>
              <button class="btn" ?disabled=${jobBusy} @click=${pickZip}>Choose ZIP…</button>
            </div>`}
      <ul class="obs-what small dim">
        <li>Notes → docs, folders → collections, YAML frontmatter → properties, <code>#tags</code> → tags</li>
        <li><code>[[wikilinks]]</code> and embeds → links between docs (they show up in the knowledge graph)</li>
        <li>Images and attachments stored locally · daily notes get a date</li>
      </ul>
      <label class="force-opt small dim">
        <input type="checkbox" data-testid="obsidian-tasks" .checked=${this.obsidianTasks} @change=${(e: Event) => (this.obsidianTasks = (e.target as HTMLInputElement).checked)} />
        Also turn <code>- [ ]</code> checklist items into kanban tasks
      </label>
      ${this.obsidianSource !== "zip"
        ? html`<div class="dlg-actions">
            <button class="btn" data-testid="obsidian-start" ?disabled=${jobBusy || !(this.obsidianSource === "git" ? this.obsidianUrl.trim() : this.obsidianPath.trim())} @click=${() => this.runObsidianImport()}>Import vault</button>
          </div>`
        : nothing}
    </div>`;
  }

  private renderMapTab(): TemplateResult {
    const cols = this.mapCollections;
    const pv = this.mapPreview;
    if (cols === null) return html`<div class="empty-mini">Loading collections…</div>`;
    if (!cols.length) {
      return html`<div class="empty-mini">No imported databases yet. Import a Notion database (or an Obsidian folder with notes) first, then map it here.</div>`;
    }
    const roles: MappingRole[] = ["projects", "tasks", "clients"];
    return html`<div class="map-tab" data-testid="import-map">
      <div class="field">
        <label>Collection</label>
        <select data-testid="map-collection" .value=${this.mapFolderId} @change=${(e: Event) => this.pickCollection((e.target as HTMLSelectElement).value)}>
          ${cols.map((c) => html`<option value=${c.id} ?selected=${c.id === this.mapFolderId}>${c.path} (${c.rows} rows)</option>`)}
        </select>
      </div>
      <div class="field">
        <label>Becomes</label>
        <div class="seg">
          ${roles.map(
            (r) => html`<button class="seg-btn ${this.mapRole === r ? "on" : ""}" data-testid=${`map-role-${r}`} @click=${() => this.pickCollection(this.mapFolderId, r)}>
              ${r === "projects" ? "Projects" : r === "tasks" ? "Tasks" : "Clients"}${pv?.suggestedRole === r ? html` <span class="pill">suggested</span>` : nothing}
            </button>`,
          )}
        </div>
      </div>
      ${pv
        ? html`<table class="map-fields">
            <thead><tr><th>Field</th><th>From column</th></tr></thead>
            <tbody>
              ${pv.fields.map(
                (f) => html`<tr>
                  <td>${f.label}${f.required ? html` <span class="dim">*</span>` : nothing}</td>
                  <td>
                    <select @change=${(e: Event) => {
                      this.mapFieldMap = { ...this.mapFieldMap, [f.key]: (e.target as HTMLSelectElement).value };
                      void this.pickCollection(this.mapFolderId, this.mapRole, this.mapFieldMap);
                    }}>
                      ${f.required ? nothing : html`<option value="" ?selected=${!this.mapFieldMap[f.key]}>— not imported —</option>`}
                      ${pv.columns.map((c) => html`<option value=${c.key} ?selected=${this.mapFieldMap[f.key] === c.key}>${c.name} · ${c.type}</option>`)}
                    </select>
                  </td>
                </tr>`,
              )}
            </tbody>
          </table>
          <div class="map-preview">
            <div class="small"><b>Preview</b> — ${pv.create} new · ${pv.update} update${pv.update === 1 ? "" : "s"} (of ${pv.total})</div>
            <ul class="map-sample">
              ${pv.sample.map(
                (r) => html`<li><span class="pill ${r.action}">${r.action}</span> <b>${String(r.values.name ?? r.values.title ?? r.title)}</b>
                  <span class="dim small">${Object.entries(r.values)
                    .filter(([k]) => k !== "name" && k !== "title" && k !== "description")
                    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
                    .join(" · ")}</span></li>`,
              )}
            </ul>
          </div>
          <div class="dlg-actions">
            <button class="btn" data-testid="map-apply" ?disabled=${this.mapBusy || !pv.total} @click=${() => this.applyMapping()}>
              ${pv.update && !pv.create ? "Update" : "Create"} ${pv.total} ${pv.role}
            </button>
          </div>`
        : html`<div class="empty-mini">${this.mapBusy ? "Building preview…" : "Pick a collection."}</div>`}
    </div>`;
  }

  private async importFromUrl(): Promise<void> {
    if (!this.api || !this.importUrl.trim()) return;
    this.notionBusy = true;
    this.importResult = "Downloading…";
    try {
      const { node } = await this.api.uploadUrl(this.importUrl.trim(), this.currentFolderId());
      this.importResult = `Saved "${node.title}"`;
      this.importUrl = "";
      await this.loadTree();
      await this.open(node.id);
    } catch (err) {
      this.importResult = `Download failed: ${(err as Error).message}`;
    } finally {
      this.notionBusy = false;
    }
  }

  // ── History ────────────────────────────────────────────────

  private async openHistory(): Promise<void> {
    if (!this.api || !this.detail) return;
    await this.flushSave();
    const { revisions } = await this.api.history(this.detail.node.id);
    this.dialog = { kind: "history", revisions };
  }

  private async previewRevision(rev: string): Promise<void> {
    if (!this.api || !this.detail || this.dialog?.kind !== "history") return;
    const r = await this.api.revision(this.detail.node.id, rev);
    this.dialog = { ...this.dialog, preview: { rev, body: r.body } };
  }

  private async restoreRevision(rev: string): Promise<void> {
    if (!this.api || !this.detail) return;
    await this.api.restoreRevision(this.detail.node.id, rev);
    this.dialog = null;
    await this.refreshDetail();
    const editor = this.editorEl();
    if (editor && this.detail?.body !== undefined) editor.setValue?.(this.detail.body, { force: true });
    this.flash("Revision restored");
  }

  // ── Render: sidebar ────────────────────────────────────────

  private renderRow(n: DocSummary, depth: number): TemplateResult {
    const kids = this.index.children.get(n.id) ?? [];
    const open = this.expanded.has(n.id);
    const active = this.selectedId === n.id;
    const over = this.dragOverId === n.id;
    return html`
      <div
        class="row ${active ? "active" : ""} ${over ? (n.kind === "folder" ? "drop-into" : "drop-before") : ""}"
        style="--depth:${depth}"
        draggable=${this.renamingId === n.id ? "false" : "true"}
        data-id=${n.id}
        role="treeitem"
        aria-expanded=${n.kind === "folder" ? String(open) : nothing}
        aria-selected=${String(active)}
        @dragstart=${(e: DragEvent) => this.onRowDragStart(e, n)}
        @dragend=${() => {
          this.dragId = null;
          this.dragOverId = undefined;
        }}
        @dragover=${(e: DragEvent) => this.onRowDragOver(e, n)}
        @dragleave=${() => this.dragOverId === n.id && (this.dragOverId = undefined)}
        @drop=${(e: DragEvent) => this.onRowDrop(e, n)}
        @click=${() => void this.open(n.id)}
        @dblclick=${() => (this.renamingId = n.id)}
      >
        <span
          class="twisty ${n.kind === "folder" ? "" : "leaf"}"
          @click=${(e: Event) => {
            e.stopPropagation();
            if (n.kind !== "folder") return;
            const next = new Set(this.expanded);
            if (open) next.delete(n.id);
            else next.add(n.id);
            this.expanded = next;
            writeJson(LS_EXPANDED, [...next]);
          }}
          >${n.kind === "folder" ? (open ? "▾" : "▸") : ""}</span
        >
        <span class="ico">${this.nodeIcon(n)}</span>
        ${this.renamingId === n.id
          ? html`<input
              class="rename"
              .value=${n.title}
              @click=${(e: Event) => e.stopPropagation()}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") void this.rename(n.id, (e.target as HTMLInputElement).value);
                if (e.key === "Escape") this.renamingId = null;
              }}
              @blur=${(e: Event) => void this.rename(n.id, (e.target as HTMLInputElement).value)}
            />`
          : html`<span class="label" title=${n.title}>${n.title}</span>`}
        ${n.kind === "folder" && kids.length ? html`<span class="count">${kids.length}</span>` : nothing}
        ${n.kind === "folder"
          ? html`<button
              class="row-add"
              title="New doc in ${n.title}"
              data-pop-trigger="1"
              @click=${(e: Event) => this.openNewMenu(e, n.id)}
            >
              +
            </button>`
          : nothing}
      </div>
      ${n.kind === "folder" && open ? kids.map((k) => this.renderRow(k, depth + 1)) : nothing}
    `;
  }

  /** Compact progress chip in the sidebar while an import runs (click → dialog). */
  private renderImportChip(job: ImportJob): TemplateResult {
    const p = job.progress;
    const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    return html`<button class="import-chip" title="Show import progress" @click=${() => this.openImport(job.kind === "notion-zip" ? "zip" : job.kind === "obsidian" ? "obsidian" : job.kind === "map" ? "map" : "notion")}>
      <span class="chip-text">⤓ ${job.status === "queued" ? "Import queued" : `Importing · ${p.done.toLocaleString()} of ${p.total.toLocaleString()} found`}</span>
      <span class="chip-bar ${p.total === 0 ? "indeterminate" : ""}"><span style="width:${pct}%"></span></span>
    </button>`;
  }

  private renderSidebar(): TemplateResult {
    const roots = this.index.children.get(null) ?? [];
    const favs = this.nodes.filter((n) => n.favorite);
    const recent = this.recent.map((id) => this.index.byId.get(id)).filter((n): n is DocSummary => Boolean(n)).slice(0, 6);
    return html`
      <aside class="sidebar ${this.sidebarOpen ? "" : "collapsed"}" aria-label="Documents" data-learn-id="documents-sidebar">
        <div class="side-head">
          <div class="brand">
            <span class="brand-eyebrow">Knowledge</span>
            <span class="brand-title">Documents</span>
          </div>
          <div class="side-actions" data-learn-id="documents-side-actions">
            <button class="icon-btn" title="New… (pick a type)" aria-label="New document" data-pop-trigger="1" data-testid="documents-new" @click=${(e: Event) => this.openNewMenu(e)}>${ICON.newDoc}</button>
            <button class="icon-btn" title="New folder" aria-label="New folder" @click=${() => this.create("folder")}>${ICON.newFolder}</button>
            <button class="icon-btn" title="Upload files" aria-label="Upload files" @click=${() => this.pickFiles()}>${ICON.upload}</button>
            <button class="icon-btn" title="Import from Notion / ZIP / URL" aria-label="Import" data-learn-id="documents-import-icon" @click=${() => this.openImport()}>${ICON.importIn}</button>
          </div>
        </div>
        ${isJobActive(this.importJob) ? this.renderImportChip(this.importJob!) : nothing}
        <label class="search">
          ${ICON.search}
          <input
            type="search"
            data-learn-id="documents-search"
            placeholder="Search titles, text, PDFs…  ⌘K"
            .value=${this.query}
            @input=${(e: Event) => {
              this.query = (e.target as HTMLInputElement).value;
              if (this.searchTimer) clearTimeout(this.searchTimer);
              this.searchTimer = setTimeout(() => void this.runSearch(), 220);
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Escape") {
                this.query = "";
                this.hits = null;
              }
            }}
          />
        </label>
        <div class="side-scroll">
          ${this.hits
            ? html`${this.renderLibraryHits()}<div class="section-title">${this.hits.length} document result${this.hits.length === 1 ? "" : "s"}</div>
                ${this.hits.map(
                  (h) => html`<div class="hit" @click=${() => void this.open(h.id)}>
                    <div class="hit-title">${this.nodeIcon(this.index.byId.get(h.id) ?? ({ kind: h.kind } as DocSummary))} ${h.title}</div>
                    <div class="hit-path">${h.path}</div>
                    ${h.snippet ? html`<div class="hit-snippet">${h.snippet}</div>` : nothing}
                  </div>`,
                )}
                ${this.hits.length === 0 ? html`<div class="empty-mini">No matches</div>` : nothing}`
            : html`
                ${this.renderTypeNav()}
                ${favs.length
                  ? html`<div class="section-title">★ Favourites</div>
                      ${favs.map((n) => html`<div class="mini ${this.selectedId === n.id ? "active" : ""}" @click=${() => void this.open(n.id)}>${this.nodeIcon(n)} ${n.title}</div>`)}`
                  : nothing}
                ${recent.length
                  ? html`<div class="section-title">Recent</div>
                      ${recent.map((n) => html`<div class="mini ${this.selectedId === n.id ? "active" : ""}" @click=${() => void this.open(n.id)}>${this.nodeIcon(n)} ${n.title}</div>`)}`
                  : nothing}
                <div class="section-title tree-head">
                  <span>Folders</span>
                  <select
                    title="Sort"
                    data-learn-id="documents-sort"
                    .value=${this.sort}
                    @change=${(e: Event) => {
                      this.sort = (e.target as HTMLSelectElement).value as TreeSort;
                      localStorage.setItem(LS_SORT, this.sort);
                      this.index = buildTreeIndex(this.nodes, this.sort);
                    }}
                  >
                    <option value="manual">Manual</option>
                    <option value="name">Name</option>
                    <option value="updated">Updated</option>
                  </select>
                </div>
                <div
                  class="tree ${this.dragOverId === null ? "drop-root" : ""}"
                  role="tree"
                  data-learn-id="documents-tree"
                  @dragover=${(e: DragEvent) => this.onRowDragOver(e, null)}
                  @drop=${(e: DragEvent) => this.onRowDrop(e, null)}
                >
                  ${this.loading ? html`<div class="empty-mini">Loading…</div>` : nothing}
                  ${!this.loading && roots.length === 0
                    ? html`<div class="empty-mini">No documents yet — create one or drop files here.</div>`
                    : nothing}
                  ${roots.map((n) => this.renderRow(n, 0))}
                  <div class="root-drop">Drop here to move to top level</div>
                </div>
              `}
        </div>
        <div class="side-foot">
          <button
            class="link-btn"
            data-learn-id="documents-trash"
            @click=${() => {
              if (this.trash) this.trash = null;
              else void this.loadTrash();
            }}
          >
            ${ICON.trash} Trash ${this.trash ? "▾" : "▸"}
          </button>
          ${this.trash
            ? html`<div class="trash">
                ${this.trash.length === 0 ? html`<div class="empty-mini">Trash is empty</div>` : nothing}
                ${this.trash.map(
                  (n) => html`<div class="trash-row">
                    <span class="label">${this.nodeIcon(n)} ${n.title}</span>
                    <button class="link-btn" @click=${async () => {
                      await this.api?.restore(n.id);
                      await this.loadTree();
                      await this.loadTrash();
                      this.flash(`Restored "${n.title}"`);
                    }}>Restore</button>
                    <button class="link-btn danger" @click=${async () => {
                      if (!confirm(`Permanently delete "${n.title}"? This can't be undone.`)) return;
                      await this.api?.purge(n.id);
                      await this.loadTrash();
                    }}>Delete</button>
                  </div>`,
                )}
              </div>`
            : nothing}
        </div>
      </aside>
    `;
  }

  // ── Render: main ───────────────────────────────────────────

  private renderBreadcrumbs(): TemplateResult {
    const crumbs = this.detail?.breadcrumbs ?? [];
    return html`<nav class="crumbs" aria-label="Breadcrumb">
      <button class="crumb" @click=${() => {
        this.select(null);
        this.dispatchEvent(new CustomEvent("doc-opened", { detail: { id: null }, bubbles: true, composed: true }));
      }}>Documents</button>
      ${crumbs.map(
        (c, i) => html`<span class="sep">/</span
          ><button
            class="crumb ${i === crumbs.length - 1 ? "current" : ""}"
            @click=${() => void this.open(c.id)}
            @dragover=${(e: DragEvent) => c.kind === "folder" && this.onRowDragOver(e, this.index.byId.get(c.id) ?? null)}
            @drop=${(e: DragEvent) => c.kind === "folder" && this.onRowDrop(e, this.index.byId.get(c.id) ?? null)}
          >
            ${c.title}
          </button>`,
      )}
    </nav>`;
  }

  private renderToolbar(): TemplateResult {
    const n = this.detail?.node;
    return html`<div class="toolbar">
      <button class="icon-btn only-mobile" title="Toggle sidebar" aria-label="Toggle sidebar" data-learn-id="documents-sidebar-toggle" @click=${() => (this.sidebarOpen = !this.sidebarOpen)}>${ICON.menu}</button>
      ${this.renderBreadcrumbs()}
      <div class="spacer"></div>
      ${n?.kind === "doc"
        ? html`<span class="save-state ${this.saveState}">${this.saveState === "saved" ? "Saved" : this.saveState === "saving" ? "Saving…" : this.saveState === "dirty" ? "Editing…" : "Save failed"}</span>`
        : nothing}
      ${n
        ? html`
            <button class="icon-btn ${n.favorite ? "on" : ""}" title=${n.favorite ? "Unfavourite" : "Favourite"} aria-label=${n.favorite ? "Unfavourite" : "Favourite"} aria-pressed=${String(!!n.favorite)} @click=${() => this.toggleFavorite(n)}>${n.favorite ? ICON.starOn : ICON.star}</button>
            ${n.kind === "doc"
              ? html`<button class="icon-btn" title="Version history" aria-label="Version history" @click=${() => this.openHistory()}>${ICON.history}</button>
                  <span class="tool-sep"></span>
                  <button class="icon-btn" title="Export Markdown" @click=${() => this.exportDoc("md")}>.MD</button>
                  <button class="icon-btn" title="Export PDF (print)" @click=${() => this.exportDoc("pdf")}>PDF</button>
                  <span class="tool-sep"></span>
                  <button class="icon-btn ${this.agentOpen ? "on" : ""}" title="Ask an agent about this doc" aria-label="Ask an agent about this doc" aria-pressed=${String(this.agentOpen)} @click=${() => (this.agentOpen = !this.agentOpen)}>${ICON.sparkle}</button>`
              : nothing}
            <button class="icon-btn" title="Move to…" aria-label="Move to…" @click=${() => (this.dialog = { kind: "move", id: n.id })}>${ICON.move}</button>
            <button class="icon-btn danger" title="Move to trash" aria-label="Move to trash" @click=${() => this.trashNode(n)}>${ICON.trash}</button>
          `
        : nothing}
    </div>`;
  }

  private renderTitle(n: DocSummary): TemplateResult {
    return html`<div class="title-row">
      <span class="big-ico">${this.nodeIcon(n)}</span>
      <input
        class="title-input"
        .value=${n.title}
        aria-label="Title"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        @blur=${(e: Event) => void this.rename(n.id, (e.target as HTMLInputElement).value)}
      />
    </div>`;
  }

  /** Title of a loaded node (relation refs render as titles, not `doc:<id>`). */
  private docTitle(id: string): string | undefined {
    return this.nodes.find((x) => x.id === id)?.title;
  }

  private renderProperties(n: DocSummary): TemplateResult | typeof nothing {
    const props = n.properties ?? {};
    const keys = Object.keys(props);
    if (!keys.length) return nothing;
    return html`<div class="props">
      ${keys.map(
        (k) => docRefIds(props[k]).length > 0
          ? html`<div class="prop-k">${k}</div>
          <div class="prop-v prop-links">
            ${docRefIds(props[k]).map(
              (id, i) => html`${i > 0 ? ", " : nothing}<a
                  href="#"
                  data-testid="doc-prop-link"
                  @click=${(e: Event) => {
                    e.preventDefault();
                    void this.open(id);
                  }}
                  >${this.docTitle(id) ?? id}</a
                >`,
            )}
          </div>`
          : html`<div class="prop-k">${k}</div>
          <div class="prop-v">
            <input
              .value=${formatProp(props[k])}
              @change=${async (e: Event) => {
                const raw = (e.target as HTMLInputElement).value;
                const prev = props[k];
                const next = typeof prev === "number" && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : Array.isArray(prev) ? raw.split(",").map((s) => s.trim()).filter(Boolean) : typeof prev === "boolean" ? /^(true|yes|1|✓)$/i.test(raw.trim()) : raw;
                await this.api?.update({ id: n.id, properties: { ...props, [k]: next } });
                await this.loadTree();
              }}
            />
          </div>`,
      )}
    </div>`;
  }

  private renderDoc(d: DocDetail): TemplateResult {
    const n = d.node;
    const linkTargets = this.nodes.filter((x) => x.kind === "doc" && x.id !== n.id).map((x) => ({ id: x.id, title: x.title }));
    return html`
      <div class="doc">
        ${this.renderTitle(n)}
        <div class="meta-line">
          ${this.renderTypeChip(n)}
          ${n.source?.type === "notion" && n.source.url ? html`<a href=${n.source.url} target="_blank" rel="noopener">Notion ↗</a> · ` : nothing}
          ${n.source?.type === "note" ? html`<span title="Kept in sync with the original note">Synced note</span> · ` : nothing}
          Updated ${relTime(n.updatedAt)}
        </div>
        ${n.source?.type === "note" && n.source.id
          ? html`<ib-people-chips class="doc-people" style="margin:4px 0 10px" .client=${this.client} objectType="note" objectId=${n.source.id}></ib-people-chips>`
          : html`<ib-people-chips class="doc-people" style="margin:4px 0 10px" .client=${this.client} objectType="document" objectId=${n.id}></ib-people-chips>`}
        ${this.renderProperties(n)}
        ${this.remoteChanged
          ? html`<div class="banner">This document was changed elsewhere (maybe by an agent).
              <button class="link-btn" @click=${() => {
                this.pendingBody = null;
                this.saveState = "saved";
                void this.refreshDetail();
              }}>Load latest</button></div>`
          : nothing}
        <ib-doc-editor
          .value=${d.body ?? ""}
          .linkTargets=${linkTargets}
          .uploadImage=${this.uploadImage}
          placeholder="Start writing — type / for blocks, [[ to link a doc"
          @doc-change=${(e: CustomEvent<{ markdown: string }>) => this.onDocChange(e.detail.markdown)}
          @doc-save=${() => void this.flushSave(true)}
          @doc-open-link=${(e: CustomEvent<{ target: string; kind: string }>) => this.openLink(e.detail.target, e.detail.kind)}
        ></ib-doc-editor>
        ${d.backlinks.length
          ? html`<div class="backlinks">
              <div class="section-title">Linked from</div>
              ${d.backlinks.map((b) => html`<button class="chip" @click=${() => void this.open(b.id)}>↩ ${b.title}</button>`)}
            </div>`
          : nothing}
      </div>
    `;
  }

  private openLink(target: string, kind: string): void {
    if (kind === "url") {
      window.open(target, "_blank", "noopener");
      return;
    }
    const id = kind === "doc" ? target.replace(/^doc:/, "") : null;
    const byId = id ? this.index.byId.get(id) : undefined;
    const byTitle = this.nodes.find((n) => n.title.toLowerCase() === target.trim().toLowerCase());
    const hit = byId ?? byTitle;
    if (hit) void this.open(hit.id);
    else if (kind === "wiki" && confirm(`"${target}" doesn't exist yet. Create it?`)) {
      void this.api?.create({ kind: "doc", title: target.trim(), parentId: this.currentFolderId(), body: "" }).then(async ({ node }) => {
        await this.loadTree();
        await this.open(node.id);
      });
    }
  }

  private renderFile(d: DocDetail): TemplateResult {
    const n = d.node;
    const f = n.file!;
    const kind = previewKind(f);
    const url = this.ticket ? this.api!.fileUrl(n.id, this.ticket) : "";
    const dl = this.ticket ? this.api!.fileUrl(n.id, this.ticket, true) : "";
    const status =
      f.extractStatus === "ok"
        ? `${(f.extractedChars ?? 0).toLocaleString()} chars of text extracted — searchable + readable by agents`
        : f.extractStatus === "none"
          ? "No text layer (media / scanned image without OCR)"
          : f.extractStatus === "pending"
            ? "Extracting text…"
            : `Text extraction failed: ${f.extractError ?? "unknown error"}`;
    return html`<div class="file">
      ${this.renderTitle(n)}
      <div class="file-meta">
        <span class="pill">${f.ext.replace(".", "").toUpperCase() || "FILE"}</span>
        <span>${formatBytes(f.size)}</span>
        <span class="dim">${f.name}</span>
        <span class="dim">· ${status}</span>
        <div class="spacer"></div>
        ${dl ? html`<a class="btn" href=${dl} download=${f.name}>Download</a>` : nothing}
        <button class="btn ghost" @click=${async () => {
          await this.api?.reextract(n.id);
          await this.refreshDetail();
          this.flash("Text re-extracted");
        }}>Re-extract</button>
      </div>
      <div class="tabs">
        <button class="tab ${this.fileTab === "preview" ? "on" : ""}" @click=${() => (this.fileTab = "preview")}>Preview</button>
        <button class="tab ${this.fileTab === "text" ? "on" : ""}" @click=${() => (this.fileTab = "text")} ?disabled=${!d.extracted}>Extracted text</button>
      </div>
      <div class="preview">
        ${this.fileTab === "text" || kind === "text"
          ? html`<div class="md-render">${renderMarkdown(d.extracted ?? "")}</div>
              ${d.extractedTruncated ? html`<div class="empty-mini">Showing the first part of the text.</div>` : nothing}`
          : !url
            ? html`<div class="empty-mini">Loading preview…</div>`
            : kind === "pdf"
              ? html`<iframe class="pdf" title=${n.title} src=${url}></iframe>`
              : kind === "image"
                ? html`<img class="img" alt=${n.title} src=${url} />`
                : kind === "video"
                  ? html`<video class="media" controls preload="metadata" src=${url}></video>`
                  : kind === "audio"
                    ? html`<audio class="audio" controls preload="metadata" src=${url}></audio>`
                    : html`<div class="empty-big">No inline preview for this type. <a href=${dl}>Download</a> to open it.</div>`}
      </div>
    </div>`;
  }

  private renderFolder(folder: DocSummary | null, kids: DocSummary[]): TemplateResult {
    const isDb = Boolean(folder?.schema?.length);
    const mode = this.folderMode ?? folder?.view?.mode ?? (isDb ? "table" : "list");
    const cols = tableColumns(folder ?? undefined, kids);
    const rows = sortRows(kids, this.tableSort.by, this.tableSort.dir);
    const head = (key: string, label: string) => html`<th
      @click=${() =>
        (this.tableSort = this.tableSort.by === key ? { by: key, dir: this.tableSort.dir === "asc" ? "desc" : "asc" } : { by: key, dir: "asc" })}
    >
      ${label}${this.tableSort.by === key ? (this.tableSort.dir === "asc" ? " ↑" : " ↓") : ""}
    </th>`;
    return html`<div class="folder">
      ${folder
        ? html`<div class="eyebrow">${isDb ? "Database" : "Folder"}</div>${this.renderTitle(folder)}`
        : this.renderRootHero()}
      <div class="folder-bar" data-learn-id="documents-folder-bar">
        <span class="dim">${kids.length} item${kids.length === 1 ? "" : "s"}${isDb ? " · Notion database" : ""}</span>
        <div class="spacer"></div>
        <div class="seg" data-learn-id="documents-view-modes">
          ${(["list", "table", "grid"] as const).map(
            (m) => html`<button class="${mode === m ? "on" : ""}" data-learn-id=${`documents-view-${m}`} @click=${() => {
              this.folderMode = m;
              if (folder) void this.api?.update({ id: folder.id, view: { ...(folder.view ?? { mode: m }), mode: m } });
            }}>${m === "list" ? html`${ICON.list} List` : m === "table" ? html`${ICON.table} Table` : html`${ICON.grid} Grid`}</button>`,
          )}
        </div>
        <button class="btn" data-learn-id="documents-new-doc" data-pop-trigger="1" @click=${(e: Event) => this.openNewMenu(e, folder?.id ?? null)}>${ICON.newDoc} New…</button>
        <button class="btn ghost" @click=${() => this.create("folder", folder?.id ?? null)}>${ICON.newFolder} New folder</button>
        <button class="btn ghost" data-learn-id="documents-upload" @click=${() => this.pickFiles(folder?.id ?? null)}>${ICON.upload} Upload</button>
      </div>
      ${kids.length === 0
        ? html`<div class="empty-big" data-learn-id="documents-empty">
            <div class="empty-ico">${ICON.newDoc}</div>
            <div class="empty-title">${folder ? "This folder is empty" : "Start your knowledge base"}</div>
            <div class="dim">Drop files here (PDF, DOCX, XLSX, PPTX, images, audio, video, ZIP…), create a doc, or import from Notion.</div>
            <div class="empty-actions">
              <button class="btn" data-pop-trigger="1" @click=${(e: Event) => this.openNewMenu(e, folder?.id ?? null)}>${ICON.newDoc} New document</button>
              <button class="btn ghost" @click=${() => this.pickFiles(folder?.id ?? null)}>${ICON.upload} Upload files</button>
              <button class="btn ghost" data-learn-id="documents-import" @click=${() => this.openImport()}>${ICON.importIn} Import from Notion</button>
            </div>
          </div>`
        : mode === "table"
          ? html`<div class="table-wrap"><table class="grid-table">
              <thead><tr>${head("__title", "Name")}${cols.map((c) => head(c.key, c.name))}${head("__updated", "Updated")}</tr></thead>
              <tbody>
                ${rows.map(
                  (r) => html`<tr @click=${() => void this.open(r.id)} draggable="true" @dragstart=${(e: DragEvent) => this.onRowDragStart(e, r)}>
                    <td class="name-cell">${this.nodeIcon(r)} ${r.title}</td>
                    ${cols.map((c) => html`<td>${formatProp(r.properties?.[c.key], (id) => this.docTitle(id))}</td>`)}
                    <td class="dim">${relTime(r.updatedAt)}</td>
                  </tr>`,
                )}
              </tbody>
            </table></div>`
          : mode === "grid"
            ? html`<div class="cards">
                ${rows.map(
                  (r) => html`<div class="card" @click=${() => void this.open(r.id)} draggable="true" @dragstart=${(e: DragEvent) => this.onRowDragStart(e, r)}>
                    <div class="card-ico">${this.nodeIcon(r)}</div>
                    <div class="card-title">${r.title}</div>
                    <div class="card-prev">${r.kind === "folder" ? `${(this.index.children.get(r.id) ?? []).length} items` : r.preview ?? ""}</div>
                  </div>`,
                )}
              </div>`
            : html`<div class="list">
                ${rows.map(
                  (r) => html`<div
                    class="list-row ${this.dragOverId === r.id ? "drop-into" : ""}"
                    @click=${() => void this.open(r.id)}
                    draggable="true"
                    @dragstart=${(e: DragEvent) => this.onRowDragStart(e, r)}
                    @dragover=${(e: DragEvent) => this.onRowDragOver(e, r)}
                    @drop=${(e: DragEvent) => this.onRowDrop(e, r)}
                  >
                    <span class="ico">${this.nodeIcon(r)}</span>
                    <span class="list-title">${r.title}</span>
                    <span class="list-prev">${r.kind === "file" ? `${r.file?.ext.replace(".", "").toUpperCase()} · ${formatBytes(r.file?.size ?? 0)}` : r.kind === "folder" ? `${(this.index.children.get(r.id) ?? []).length} items` : r.preview ?? ""}</span>
                    <span class="dim">${relTime(r.updatedAt)}</span>
                  </div>`,
                )}
              </div>`}
    </div>`;
  }

  // ── Render: types / library ──────────────────────────────────

  private renderModeSeg(): TemplateResult {
    return html`<div class="seg mode-seg" role="tablist" aria-label="View">
      <button class=${this.rootMode === "library" ? "on" : ""} role="tab" aria-selected=${this.rootMode === "library"} data-testid="documents-mode-library" @click=${() => {
        this.setRootMode("library");
        this.select(null);
      }}>${ICON.list} Library</button>
      <button class=${this.rootMode === "folders" ? "on" : ""} role="tab" aria-selected=${this.rootMode === "folders"} data-testid="documents-mode-folders" @click=${() => {
        this.setRootMode("folders");
        this.select(null);
      }}>${ICON.grid} Folders</button>
    </div>`;
  }

  private renderTypeNav(): TemplateResult {
    const counts = this.lib?.counts.byType ?? {};
    const rows = sidebarTypeRows(this.types, counts);
    const cats = categoryRows(this.lib?.counts.byCategory ?? {});
    const inLib = !this.selectedId && this.rootMode === "library";
    return html`<div class="type-nav" data-testid="documents-type-nav">
      <div class="section-title tree-head">
        <span>Library</span>
        <button class="link-btn tiny" title="Manage types" aria-label="Manage types" data-testid="documents-manage-types" @click=${() => (this.dialog = { kind: "types" })}>${icons.sliders}</button>
      </div>
      <button class="mini type-row ${inLib && !this.libType && !this.libCategory ? "active" : ""}" data-testid="documents-type-all" @click=${() => this.showLibrary(null)}>
        <span class="ty-ico" aria-hidden="true">${icons.layoutGrid}</span>
        <span class="label">All documents</span>
        <span class="count">${this.lib ? this.lib.counts.all : "…"}</span>
      </button>
      ${rows.map(
        ({ type, count }) => html`<button
          class="mini type-row ${inLib && this.libType === type.id ? "active" : ""} ${count === 0 ? "empty" : ""}"
          data-testid=${`documents-type-${type.id}`}
          title=${type.description ?? type.label}
          @click=${() => this.showLibrary(type.id)}
        >
          ${this.typeIcon(type)}
          <span class="label">${type.label}</span>
          <span class="count">${count}</span>
        </button>`,
      )}
      ${cats.length
        ? html`<div class="section-title">Categories</div>
            ${cats.map(
              (c) => html`<button class="mini type-row ${inLib && this.libCategory === c.category ? "active" : ""}" @click=${() => this.showLibrary(null, c.category)}>
                <span class="ty-ico" aria-hidden="true">${icons.tag}</span>
                <span class="label">${c.category}</span>
                <span class="count">${c.count}</span>
              </button>`,
            )}`
        : nothing}
    </div>`;
  }

  /** Cross-type search: ideas / reports / research matches next to the document hits. */
  private renderLibraryHits(): TemplateResult | typeof nothing {
    const q = this.query.trim();
    if (!q || !this.lib) return nothing;
    const extra = this.lib.items.filter((i) => i.source !== "doc" && matchesQuery(i, q)).slice(0, 20);
    if (!extra.length) return nothing;
    return html`<div class="section-title">${extra.length} idea / report / research match${extra.length === 1 ? "" : "es"}</div>
      ${extra.map((it) => {
        const t = typeMeta(this.types, it.type);
        return html`<div class="hit" @click=${() => this.openLibraryItem(it)}>
          <div class="hit-title">${this.typeIcon(t)} ${it.title}</div>
          <div class="hit-path">${t.label}${it.status ? ` · ${it.status}` : ""}</div>
        </div>`;
      })}`;
  }

  private renderLibrary(): TemplateResult {
    const t = this.libType ? typeMeta(this.types, this.libType) : null;
    const all = this.lib?.items ?? [];
    let items = t ? all.filter((i) => i.type === t.id) : all;
    if (this.libCategory) items = items.filter((i) => i.category === this.libCategory);
    const heading = t ? t.label : this.libCategory ? this.libCategory : "All documents";
    const sub = t?.description ?? (this.libCategory ? "Everything filed under this category." : "Every note, idea, document, meeting, plan, report and research item — one library, filtered by type.");
    const canCreate = !t || t.creatable;
    return html`<div class="folder library" data-testid="documents-library">
      <div class="eyebrow">${t ? "Type" : this.libCategory ? "Category" : "Library"}</div>
      <div class="title-row">
        ${t ? html`<span class="big-ico">${this.typeIcon(t, "ty-ico big")}</span>` : nothing}
        <h1 class="root-title">${t || this.libCategory ? heading : html`All <span class="gold">documents</span>`}</h1>
        ${this.renderModeSeg()}
      </div>
      <p class="sub">${sub}</p>
      ${!this.typesLive
        ? html`<div class="banner">Showing built-in types with inferred categories. Saving types and custom types turn on after the gateway restart.</div>`
        : nothing}
      <div class="folder-bar">
        <span class="dim">${items.length} item${items.length === 1 ? "" : "s"}</span>
        <div class="spacer"></div>
        ${t?.id === "idea"
          ? html`<button class="btn ghost" @click=${() => this.dispatchEvent(new CustomEvent("open-idea", { detail: { id: items[0]?.id ?? "" }, bubbles: true, composed: true }))}>${icons.lightbulb} Open Ideas board</button>`
          : nothing}
        ${canCreate
          ? t
            ? html`<button class="btn" data-testid="documents-new-of-type" @click=${() => void this.createTyped(t, null)}>${ICON.newDoc} New ${t.label.split(" /")[0]}</button>`
            : html`<button class="btn" data-pop-trigger="1" data-testid="documents-new-lib" @click=${(e: Event) => this.openNewMenu(e, null)}>${ICON.newDoc} New…</button>`
          : html`<span class="dim">Read-only — rendered in Reports</span>`}
        <button class="btn ghost" @click=${() => (this.dialog = { kind: "types" })}>${icons.sliders} Types</button>
      </div>
      ${!this.lib
        ? html`<div class="empty-mini">Loading…</div>`
        : items.length === 0
          ? html`<div class="empty-big">
              <div class="empty-ico">${t ? this.typeIcon(t) : ICON.newDoc}</div>
              <div class="empty-title">No ${t ? t.label.toLowerCase() : "documents"} yet</div>
              <div class="dim">${t?.id === "idea" ? "Capture one here, by voice on the phone, or ask an agent — ideas show up in this list and in Ideas." : t && !t.creatable ? "Rendered reports appear here automatically." : "Create one, or change an existing document's type from its type chip."}</div>
              ${t && t.creatable ? html`<div class="empty-actions"><button class="btn" @click=${() => void this.createTyped(t, null)}>${ICON.newDoc} New ${t.label.split(" /")[0]}</button></div>` : nothing}
            </div>`
          : html`<div class="list lib-list">
              ${items.slice(0, 600).map((it) => {
                const ty = typeMeta(this.types, it.type);
                return html`<div class="list-row lib-row" data-source=${it.source} @click=${() => this.openLibraryItem(it)}>
                  <span class="ico">${this.typeIcon(ty)}</span>
                  <span class="list-title">${it.title}
                    <span class="lib-meta">
                      ${!t ? html`<span class="tchip" style="--tc:${ty.color}">${ty.label}</span>` : nothing}
                      ${it.category ? html`<span class="tchip cat">${it.category}</span>` : nothing}
                      ${it.source === "idea" && it.status ? html`<span class="tchip status">${it.status}</span>` : nothing}
                      ${it.readOnly ? html`<span class="tchip ro">Read-only</span>` : nothing}
                    </span>
                  </span>
                  <span class="list-prev">${it.preview ?? ""}</span>
                  <span class="dim">${relTime(it.updatedAt)}</span>
                </div>`;
              })}
            </div>`}
    </div>`;
  }

  private renderNewMenu(): TemplateResult | typeof nothing {
    const m = this.newMenu;
    if (!m) return nothing;
    const list = creatableTypes(this.types);
    return html`<div class="pop new-menu" role="menu" aria-label="New" data-testid="documents-new-menu" style="left:${m.x}px; top:${m.y}px">
      <div class="pop-title">Create</div>
      <div class="pop-scroll">
        ${list.map(
          (t) => html`<button class="pop-item" role="menuitem" data-testid=${`documents-new-${t.id}`} @click=${() => void this.createTyped(t, m.parentId)}>
            ${this.typeIcon(t)}
            <span class="pop-label">${t.label}</span>
            ${t.backing === "ideas" ? html`<span class="pop-hint">Ideas</span>` : t.template ? html`<span class="pop-hint">template</span>` : nothing}
          </button>`,
        )}
      </div>
      <div class="pop-sep"></div>
      <button class="pop-item" role="menuitem" @click=${() => {
        this.newMenu = null;
        void this.create("folder", m.parentId);
      }}><span class="ty-ico">${icons.folder}</span><span class="pop-label">Folder</span></button>
      <button class="pop-item" role="menuitem" data-testid="documents-new-type" @click=${() => {
        this.newMenu = null;
        this.dialog = { kind: "types" };
      }}><span class="ty-ico">${icons.plus}</span><span class="pop-label">New type…</span></button>
    </div>`;
  }

  private renderTypeChip(n: DocSummary): TemplateResult {
    const id = docTypeOf(n, this.types);
    const t = typeMeta(this.types, id);
    const options = assignableTypes(this.types);
    return html`<span class="type-chip-wrap">
        <button class="type-chip" data-pop-trigger="1" data-testid="documents-type-chip" style="--tc:${t.color}" title=${n.typeInferred || !n.type ? "Type (inferred — pick one to set it)" : "Change type"} @click=${(e: Event) => {
          e.stopPropagation();
          this.typeMenu = !this.typeMenu;
        }}>${this.typeIcon(t)} <span>${t.label}</span>${n.typeInferred || !n.type ? html`<span class="inferred">auto</span>` : nothing} ${icons.chevronDown}</button>
        ${this.typeMenu
          ? html`<div class="pop type-menu" role="menu" data-testid="documents-type-menu">
              <div class="pop-title">Document type</div>
              <div class="pop-scroll">
                ${options.map(
                  (o) => html`<button class="pop-item ${o.id === id ? "on" : ""}" role="menuitemradio" aria-checked=${o.id === id} @click=${() => void this.setDocType(n, o.id)}>
                    ${this.typeIcon(o)}<span class="pop-label">${o.label}</span>${o.id === id ? html`<span class="pop-hint">${icons.check}</span>` : nothing}
                  </button>`,
                )}
              </div>
              <div class="pop-sep"></div>
              <button class="pop-item" @click=${() => {
                this.typeMenu = false;
                this.dialog = { kind: "types" };
              }}><span class="ty-ico">${icons.plus}</span><span class="pop-label">New type…</span></button>
            </div>`
          : nothing}
      </span>
      <input
        class="cat-input"
        placeholder="+ category"
        aria-label="Category"
        .value=${n.category ?? ""}
        ?disabled=${!this.typesLive}
        @keydown=${(e: KeyboardEvent) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        @blur=${(e: Event) => void this.setDocCategory(n, (e.target as HTMLInputElement).value)}
      />
      ·`;
  }

  private renderTypesDialog(): TemplateResult {
    const order = this.types.map((t) => t.id);
    const iconSelect = (value: string, onChange: (v: string) => void) => html`<select class="ty-select" aria-label="Icon" @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}>
      ${[...new Set([value, ...TYPE_ICON_CHOICES])].map((name) => html`<option value=${name} ?selected=${name === value}>${name}</option>`)}
    </select>`;
    const nt = this.newType;
    return html`<h2>Document types</h2>
      <p class="dim small">Built-in types can be hidden, recoloured and re-iconed. Your own types can also be renamed, reordered and archived — documents keep their type either way.</p>
      ${!this.typesLive ? html`<div class="banner">Read-only until the gateway restart that turns document types on.</div>` : nothing}
      <div class="ty-list" data-testid="documents-types-list">
        ${this.types.map(
          (t, i) => html`<div class="ty-row ${t.hidden || t.archived ? "off" : ""}">
            <div class="ty-move">
              <button class="icon-btn" title="Move up" aria-label="Move up" ?disabled=${i === 0} @click=${() => void this.typeAction(() => this.api!.reorderTypes(moveInOrder(order, t.id, -1)))}>${icons.chevronUp}</button>
              <button class="icon-btn" title="Move down" aria-label="Move down" ?disabled=${i === order.length - 1} @click=${() => void this.typeAction(() => this.api!.reorderTypes(moveInOrder(order, t.id, 1)))}>${icons.chevronDown}</button>
            </div>
            ${this.typeIcon(t, "ty-ico big")}
            ${t.builtin
              ? html`<span class="ty-name">${t.label}<span class="dim small"> · built-in</span></span>`
              : html`<input class="ty-name-input" aria-label="Type name" .value=${t.label} @change=${(e: Event) => void this.typeAction(() => this.api!.updateType({ id: t.id, label: (e.target as HTMLInputElement).value }), "Renamed")} />`}
            <input class="ty-color" type="color" aria-label="Colour" .value=${t.color} @change=${(e: Event) => void this.typeAction(() => this.api!.updateType({ id: t.id, color: (e.target as HTMLInputElement).value }))} />
            ${iconSelect(t.icon, (v) => void this.typeAction(() => this.api!.updateType({ id: t.id, icon: v })))}
            <span class="count">${this.lib?.counts.byType[t.id] ?? 0}</span>
            ${t.builtin
              ? html`<button class="link-btn" @click=${() => void this.typeAction(() => this.api!.updateType({ id: t.id, hidden: !t.hidden }), t.hidden ? "Shown" : "Hidden")}>${t.hidden ? "Show" : "Hide"}</button>`
              : html`<button class="link-btn" @click=${() => void this.typeAction(() => this.api!.updateType({ id: t.id, archived: !t.archived }), t.archived ? "Restored" : "Archived")}>${t.archived ? "Restore" : "Archive"}</button>`}
          </div>`,
        )}
      </div>
      <div class="ty-new" data-testid="documents-type-create">
        <div class="section-title">New type</div>
        <div class="ty-new-row">
          <input class="ty-name-input" placeholder="Name, e.g. Client brief" aria-label="New type name" .value=${nt.label} @input=${(e: Event) => (this.newType = { ...nt, label: (e.target as HTMLInputElement).value })} />
          ${iconSelect(nt.icon, (v) => (this.newType = { ...this.newType, icon: v }))}
        </div>
        <div class="ty-swatches" role="radiogroup" aria-label="Colour">
          ${TYPE_COLOR_CHOICES.map(
            (c) => html`<button class="swatch ${nt.color === c ? "on" : ""}" role="radio" aria-checked=${nt.color === c} aria-label=${c} style="--tc:${c}" @click=${() => (this.newType = { ...this.newType, color: c })}></button>`,
          )}
        </div>
        <textarea class="ty-template" rows="3" placeholder="Optional template body (markdown). {{date}} becomes today." .value=${nt.template} @input=${(e: Event) => (this.newType = { ...this.newType, template: (e.target as HTMLTextAreaElement).value })}></textarea>
        <div class="dlg-actions">
          <span class="ty-preview">${this.typeIcon({ ...typeMeta(this.types, null), icon: nt.icon, color: nt.color })} ${nt.label || "Preview"}</span>
          <button class="btn" ?disabled=${!nt.label.trim()} data-testid="documents-type-create-btn" @click=${async () => {
            const ok = await this.typeAction(
              () => this.api!.createType({ label: nt.label.trim(), icon: nt.icon, color: nt.color, template: nt.template || undefined }),
              `Type "${nt.label.trim()}" created`,
            );
            if (ok) this.newType = { label: "", icon: "tag", color: "#d9b45f", template: "" };
          }}>${icons.plus} Create type</button>
        </div>
      </div>`;
  }

  private renderRootHero(): TemplateResult {
    const count = (k: DocSummary["kind"]) => this.nodes.filter((n) => n.kind === k).length;
    const stat = (label: string, v: number) => html`<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${v.toLocaleString()}</div></div>`;
    return html`<div class="eyebrow">Workspace · Folders</div>
      <div class="title-row"><h1 class="root-title">All <span class="gold">folders</span></h1>${this.renderModeSeg()}</div>
      <p class="sub">Nested folders, rich docs and uploaded files — searchable by you and readable by your agents. Drop files anywhere to upload.</p>
      ${this.nodes.length
        ? html`<div class="stats">
            ${stat("Documents", count("doc"))} ${stat("Folders", count("folder"))} ${stat("Files", count("file"))}
            ${stat("Favourites", this.nodes.filter((n) => n.favorite).length)}
          </div>`
        : nothing}`;
  }

  private renderMain(): TemplateResult {
    const d = this.detail;
    let body: TemplateResult;
    if (this.error) body = html`<div class="empty-big">Couldn't load documents: ${this.error} <button class="btn" @click=${() => this.loadTree()}>Retry</button></div>`;
    else if ((!d || !this.selectedId) && this.rootMode === "library") body = this.renderLibrary();
    else if (!d || !this.selectedId) body = this.renderFolder(null, this.index.children.get(null) ?? []);
    else if (d.node.kind === "folder") body = this.renderFolder(d.node, this.index.children.get(d.node.id) ?? d.children ?? []);
    else if (d.node.kind === "file") body = this.renderFile(d);
    else body = this.renderDoc(d);
    return html`<main
      class="main ${this.fileDropActive ? "file-drop" : ""}"
      @dragover=${(e: DragEvent) => {
        if (!this.isFileDrag(e)) return;
        e.preventDefault();
        this.fileDropActive = true;
      }}
      @dragleave=${(e: DragEvent) => {
        if (e.target === e.currentTarget) this.fileDropActive = false;
      }}
      @drop=${(e: DragEvent) => {
        if (!this.isFileDrag(e)) return;
        e.preventDefault();
        this.fileDropActive = false;
        void this.uploadFiles([...(e.dataTransfer?.files ?? [])]);
      }}
    >
      ${this.renderToolbar()}
      <div class="main-scroll ${this.detailLoading ? "loading" : ""}">${body}</div>
      ${this.fileDropActive ? html`<div class="drop-overlay">Drop to upload into ${this.detail?.node.kind === "folder" ? this.detail.node.title : this.currentFolderId() ? (this.index.byId.get(this.currentFolderId()!)?.title ?? "this folder") : "Documents"}</div>` : nothing}
    </main>`;
  }

  // ── Render: dialogs ────────────────────────────────────────

  private renderDialog(): TemplateResult | typeof nothing {
    const dlg = this.dialog;
    if (!dlg) return nothing;
    const close = () => (this.dialog = null);
    let inner: TemplateResult;
    if (dlg.kind === "import") {
      const target = this.currentFolderId() ? this.index.byId.get(this.currentFolderId()!)?.title : "top level";
      const jobBusy = this.notionBusy || isJobActive(this.importJob);
      inner = html`<h2>Import</h2>
        <div class="tabs">
          ${(["notion", "zip", "obsidian", "map", "url"] as const).map(
            (t) => html`<button class="tab ${dlg.tab === t ? "on" : ""}" data-learn-id=${`documents-import-tab-${t}`} @click=${() => this.openImport(t)}>
              ${t === "notion" ? "Notion (API)" : t === "zip" ? "Notion export ZIP" : t === "obsidian" ? "Obsidian" : t === "map" ? "Map to projects · tasks · clients" : "From URL"}
            </button>`,
          )}
        </div>
        ${dlg.tab === "map"
          ? html`<div class="dim small">Turn an imported database or vault folder into real kanban projects, tasks or CRM clients. Re-running updates the same records; every run can be undone.</div>`
          : html`<div class="dim small">Into: <b>${target}</b>. Re-importing updates existing docs (matched by ${dlg.tab === "obsidian" ? "vault path + content hash" : "Notion id"}) — no duplicates. Every import can be undone.</div>`}
        ${this.importJob && dlg.tab !== "url" ? this.renderImportJob(this.importJob) : nothing}
        ${dlg.tab === "notion"
          ? html`
              ${this.notionConnected === false
                ? html`<div class="field">
                    <label>Notion integration token</label>
                    <input type="password" placeholder="secret_… / ntn_…" .value=${this.notionToken} @input=${(e: Event) => (this.notionToken = (e.target as HTMLInputElement).value)} />
                    <div class="dim small">No saved Notion connection. Paste an internal-integration token (used for this import only), and share the pages with the integration in Notion.</div>
                  </div>`
                : nothing}
              <div class="field row-field">
                <input data-learn-id="documents-notion-search" placeholder="Search pages & databases…" .value=${this.notionQuery} @input=${(e: Event) => (this.notionQuery = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.searchNotion()} />
                <button class="btn" ?disabled=${this.notionBusy} @click=${() => this.searchNotion()}>Search</button>
              </div>
              <div class="notion-list">
                ${this.notionResults.map(
                  (r) => html`<label class="notion-item">
                    <input
                      type="checkbox"
                      .checked=${this.notionPicked.has(r.id)}
                      @change=${(e: Event) => {
                        const next = new Set(this.notionPicked);
                        if ((e.target as HTMLInputElement).checked) next.add(r.id);
                        else next.delete(r.id);
                        this.notionPicked = next;
                      }}
                    />
                    <span>${r.icon || (r.type === "database" ? "🗃️" : "📄")}</span>
                    <span class="notion-title">${r.title || "Untitled"}</span>
                    <span class="pill">${r.type === "database" ? "Database → folder" : "Page"}</span>
                    ${r.lastEditedTime ? html`<span class="dim small">${relTime(r.lastEditedTime)}</span>` : nothing}
                  </label>`,
                )}
                ${!this.notionResults.length && !this.notionBusy ? html`<div class="empty-mini">Search to list pages and databases shared with your integration.</div>` : nothing}
              </div>
              <label class="force-opt small dim" title="Normally pages unchanged in Notion since the last import are skipped">
                <input type="checkbox" .checked=${this.notionForce} @change=${(e: Event) => (this.notionForce = (e.target as HTMLInputElement).checked)} />
                Refetch unchanged pages too (slow)
              </label>
              <div class="dlg-actions">
                ${this.pickedAlreadyImported()
                  ? html`<button class="btn ghost" ?disabled=${jobBusy || !this.notionPicked.size} title="Only pages edited in Notion since the last sync (fast)" @click=${() => this.runNotionImport("changes")}>Sync changes</button>`
                  : nothing}
                <button class="btn" ?disabled=${jobBusy || !this.notionPicked.size} title="Walk everything; pages unchanged since the last import are skipped" @click=${() => this.runNotionImport("full")}>
                  ${this.pickedAlreadyImported() ? "Full re-sync" : "Import"} ${this.notionPicked.size || ""}
                </button>
              </div>`
          : dlg.tab === "obsidian"
            ? this.renderObsidianTab(jobBusy)
          : dlg.tab === "map"
            ? this.renderMapTab()
          : dlg.tab === "zip"
            ? html`<div class="dropbox" data-learn-id="documents-zip-drop" @dragover=${(e: DragEvent) => e.preventDefault()} @drop=${(e: DragEvent) => {
                e.preventDefault();
                const f = e.dataTransfer?.files?.[0];
                if (f && !jobBusy) void this.importZip(f);
              }}>
                <div>In Notion: <b>Settings → Export → Markdown &amp; CSV</b> (include subpages), then drop the .zip here.</div>
                <div class="dim small">Pages become docs, subpages become folders, databases become folders with a property table. Images and files are stored locally.</div>
                <button class="btn" ?disabled=${jobBusy} @click=${() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = ".zip,application/zip";
                  input.onchange = () => input.files?.[0] && this.importZip(input.files[0]);
                  input.click();
                }}>Choose ZIP…</button>
              </div>`
            : html`<div class="field row-field">
                <input placeholder="https://example.com/report.pdf" .value=${this.importUrl} @input=${(e: Event) => (this.importUrl = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.importFromUrl()} />
                <button class="btn" ?disabled=${this.notionBusy} @click=${() => this.importFromUrl()}>Download</button>
              </div>`}
        ${this.importResult ? html`<div class="result">${this.importResult}</div>` : nothing}`;
    } else if (dlg.kind === "history") {
      inner = html`<h2>Version history</h2>
        <div class="hist-grid">
          <div class="rev-list">
            ${dlg.revisions.length === 0 ? html`<div class="empty-mini">No earlier versions yet. Versions are captured as you edit (every few minutes) and on ⌘S.</div>` : nothing}
            ${dlg.revisions.map(
              (r) => html`<div class="rev ${dlg.preview?.rev === r.rev ? "on" : ""}" @click=${() => this.previewRevision(r.rev)}>
                <div>${new Date(r.at).toLocaleString()}</div>
                <div class="dim small">${r.author ? `${r.author} · ` : ""}${r.bodyLength.toLocaleString()} chars</div>
              </div>`,
            )}
          </div>
          <div class="rev-preview">
            ${dlg.preview
              ? html`<div class="md-render">${renderMarkdown(dlg.preview.body)}</div>
                  <div class="dlg-actions"><button class="btn" @click=${() => this.restoreRevision(dlg.preview!.rev)}>Restore this version</button></div>`
              : html`<div class="empty-mini">Pick a version to preview it.</div>`}
          </div>
        </div>`;
    } else if (dlg.kind === "types") {
      inner = this.renderTypesDialog();
    } else {
      const moving = this.index.byId.get(dlg.id);
      const folders = this.nodes.filter((n) => n.kind === "folder" && !isInside(this.index, dlg.id, n.id));
      inner = html`<h2>Move “${moving?.title}”</h2>
        <div class="move-list">
          <button class="mini" @click=${async () => {
            close();
            await this.move(dlg.id, null);
          }}>🗂️ Top level</button>
          ${folders.map(
            (f) => html`<button class="mini" @click=${async () => {
              close();
              await this.move(dlg.id, f.id);
            }}>${this.nodeIcon(f)} ${this.index.byId.get(f.id) ? (f.path ?? f.title) : f.title}</button>`,
          )}
        </div>`;
    }
    return html`<div class="scrim" @click=${(e: Event) => e.target === e.currentTarget && close()}>
      <div class="dialog ${dlg.kind}" role="dialog" aria-modal="true" data-learn-id=${`documents-dialog-${dlg.kind}`}>
        <button class="close" title="Close" data-learn-id="documents-dialog-close" @click=${close}>✕</button>
        ${inner}
      </div>
    </div>`;
  }

  render() {
    return html`
      <div class="root">
        <div class="aurora" aria-hidden="true"></div>
        ${this.renderSidebar()}
        ${this.sidebarOpen ? html`<button class="side-scrim" aria-label="Close sidebar" tabindex="-1" @click=${() => (this.sidebarOpen = false)}></button>` : nothing}
        ${this.renderMain()}
        ${this.agentOpen && this.detail?.node.kind === "doc"
          ? html`<doc-agent-panel
              .client=${this.client}
              docType="note"
              .documentId=${this.detail.node.id}
              .title=${this.detail.node.title}
              .content=${this.detail.body ?? ""}
            ></doc-agent-panel>`
          : nothing}
      </div>
      ${this.renderNewMenu()}
      ${this.renderDialog()}
      ${this.uploads.length
        ? html`<div class="uploads">
            ${this.uploads.map(
              (u) => html`<div class="upload ${u.status}">
                ${u.status === "uploading" ? "⏳" : u.status === "done" ? "✓" : "⚠"} ${u.name}${u.error ? html` — <span class="dim">${u.error}</span>` : nothing}
              </div>`,
            )}
          </div>`
        : nothing}
      ${this.toast ? html`<div class="toast" role="status">${this.toast}</div>` : nothing}
    `;
  }

  static styles = css`
    /* Glass G1 — premium glass layer (tokens from styles/glass/tokens.css
       pierce the shadow root; light / reduced-motion / reduced-transparency /
       perf-mode follow the tokens). */
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      color: var(--glass-fg, #f4f1ea);
      font-family: var(--glass-font, var(--g-font, Inter, system-ui, sans-serif));
      -webkit-font-smoothing: antialiased;
      --gold: var(--glass-gold, #d9b45f);
      --gold-hi: var(--glass-gold-hi, #f1d38a);
      --gold-deep: var(--glass-gold-deep, #a8762c);
      --fg: var(--glass-fg, #f4f1ea);
      --line: var(--glass-stroke, rgba(217, 180, 95, 0.14));
      --line-strong: var(--glass-stroke-strong, rgba(217, 180, 95, 0.24));
      --line-gold: var(--glass-stroke-gold, rgba(217, 180, 95, 0.34));
      --panel: var(--glass-hover, rgba(255, 255, 255, 0.04));
      --press: var(--glass-press, rgba(255, 255, 255, 0.07));
      --dim: var(--glass-fg-2, #c9c3b6);
      --muted: var(--glass-fg-3, #8f897c);
      --faint: var(--glass-fg-4, #6f6a60);
      --inset: color-mix(in srgb, var(--glass-base, #07070a) 55%, transparent);
      --danger: #e5675c;
      --ok: #3fb27f;
      --ease: var(--glass-ease, cubic-bezier(0.22, 1, 0.36, 1));
      --spring: var(--glass-spring, cubic-bezier(0.34, 1.56, 0.64, 1));
      --dur: var(--glass-dur, 0.22s);
      --dur-fast: var(--glass-dur-fast, 0.14s);
      --r: var(--glass-radius, 14px);
      --r-sm: var(--glass-radius-sm, 10px);
      --r-xs: var(--glass-radius-xs, 7px);
      --hairline: linear-gradient(135deg, var(--glass-gold-a40, rgba(241, 211, 138, 0.5)), var(--glass-gold-a06, rgba(217, 180, 95, 0.06)) 38%, transparent 62%, var(--glass-gold-a24, rgba(241, 211, 138, 0.28)));
    }
    * {
      box-sizing: border-box;
    }
    button {
      font: inherit;
      color: inherit;
    }
    svg.i {
      width: 15px;
      height: 15px;
      flex: none;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    :is(button, a, input, select, textarea, [tabindex]):focus-visible {
      outline: none;
      box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--gold));
    }
    /* ── Shell ───────────────────────────────────────────────── */
    .root {
      position: relative;
      isolation: isolate;
      display: flex;
      height: 100%;
      min-height: 0;
      background: var(--glass-sheen, none), var(--glass-1, rgba(14, 13, 11, 0.6));
      backdrop-filter: var(--glass-blur, blur(22px) saturate(165%));
      -webkit-backdrop-filter: var(--glass-blur, blur(22px) saturate(165%));
      border-radius: var(--glass-radius-lg, 20px);
      box-shadow: var(--glass-elev-2, 0 18px 50px -18px rgba(0, 0, 0, 0.7)), var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.06));
      overflow: hidden;
    }
    .root::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background: var(--hairline);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
      pointer-events: none;
      z-index: 30;
    }
    .aurora {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      z-index: -1;
    }
    .aurora::before,
    .aurora::after {
      content: "";
      position: absolute;
      width: 46vmax;
      height: 46vmax;
      border-radius: 50%;
      filter: blur(90px);
      background: radial-gradient(circle, var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), transparent 62%);
      top: -30vmax;
      right: -12vmax;
      opacity: 0.55;
      animation: drift 44s var(--ease) infinite alternate;
    }
    .aurora::after {
      background: radial-gradient(circle, var(--glass-gold-a16, rgba(168, 118, 44, 0.18)), transparent 60%);
      top: auto;
      right: auto;
      bottom: -36vmax;
      left: 10vmax;
      opacity: 0.4;
      animation-duration: 56s;
    }
    :host-context([data-theme="light"]) .aurora::before,
    :host-context([data-theme="light"]) .aurora::after {
      opacity: 0.25;
    }
    @keyframes drift {
      from {
        transform: translate3d(0, 0, 0) scale(1);
      }
      to {
        transform: translate3d(-6vmax, 4vmax, 0) scale(1.08);
      }
    }
    /* ── Sidebar ─────────────────────────────────────────────── */
    .sidebar {
      width: 288px;
      flex: 0 0 288px;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--line);
      background: linear-gradient(180deg, var(--glass-gold-a06, rgba(217, 180, 95, 0.05)), transparent 140px), var(--panel);
      min-height: 0;
    }
    .side-head {
      display: flex;
      align-items: center;
      padding: 18px 12px 12px 18px;
      gap: 8px;
    }
    .brand {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .brand-eyebrow {
      font: 600 10px/1 var(--glass-font, inherit);
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--gold);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .brand-eyebrow::before {
      content: "";
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--gold);
      box-shadow: 0 0 8px var(--gold);
    }
    .brand-title {
      font: 650 18px/1.15 var(--font-ui-display, var(--glass-font, inherit));
      letter-spacing: -0.02em;
      color: var(--fg);
    }
    .side-actions {
      display: flex;
      gap: 2px;
    }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      min-width: 30px;
      height: 30px;
      padding: 0 7px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--r-xs);
      cursor: pointer;
      font: 600 11px/1 var(--glass-font, inherit);
      letter-spacing: 0.02em;
      color: var(--muted);
      white-space: nowrap;
      transition: color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--spring);
    }
    .icon-btn:hover {
      border-color: var(--line);
      color: var(--fg);
      background: var(--panel);
    }
    .icon-btn:active {
      transform: scale(0.94);
    }
    .icon-btn.on {
      color: var(--gold);
      background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
      border-color: var(--line-gold);
    }
    .icon-btn.danger:hover {
      color: var(--danger);
      border-color: color-mix(in srgb, var(--danger) 40%, transparent);
    }
    .search {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 12px 10px;
      padding: 0 12px;
      height: 36px;
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      background: var(--inset);
      color: var(--muted);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.18);
      transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur) var(--ease);
    }
    .search:hover {
      border-color: var(--line-gold);
    }
    .search:focus-within {
      border-color: color-mix(in srgb, var(--gold) 65%, transparent);
      box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--gold));
    }
    .search input {
      flex: 1;
      background: transparent;
      border: 0;
      outline: 0;
      color: var(--fg);
      font: inherit;
      font-size: 13px;
      min-width: 0;
    }
    .search input:focus-visible {
      box-shadow: none;
    }
    .search input::placeholder {
      color: var(--faint);
    }
    .side-scroll {
      flex: 1;
      overflow: auto;
      padding: 0 8px 12px;
      scrollbar-width: thin;
    }
    .section-title {
      font: 600 10px/1 var(--glass-font, inherit);
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--muted);
      padding: 14px 10px 6px;
    }
    .tree-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tree-head select {
      background: var(--inset);
      color: var(--dim);
      border: 1px solid var(--line);
      border-radius: 6px;
      font: 500 11px/1 var(--glass-font, inherit);
      letter-spacing: 0;
      text-transform: none;
      padding: 3px 4px;
      color-scheme: dark;
    }
    :host-context([data-theme="light"]) .tree-head select,
    :host-context([data-theme="light"]) .map-tab select {
      color-scheme: light;
    }
    .row,
    .mini {
      position: relative;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 8px 6px calc(8px + var(--depth, 0) * 14px);
      min-height: 32px;
      border-radius: 9px;
      cursor: pointer;
      font-size: 13px;
      color: var(--dim);
      border: 1px solid transparent;
      user-select: none;
      width: 100%;
      background: transparent;
      text-align: left;
      transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
    }
    .row:hover,
    .mini:hover {
      background: var(--panel);
      color: var(--fg);
    }
    .row.active,
    .mini.active {
      background: linear-gradient(135deg, var(--glass-gold-a16, rgba(217, 180, 95, 0.16)), var(--glass-gold-a06, rgba(217, 180, 95, 0.06)));
      border-color: var(--line-gold);
      color: var(--fg);
      box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.06));
    }
    .side-scroll .row.active::before,
    .side-scroll .mini.active::before {
      content: "";
      position: absolute;
      left: -5px;
      top: 8px;
      bottom: 8px;
      width: 3px;
      border-radius: 2px;
      background: var(--gold);
      box-shadow: 0 0 10px var(--gold);
    }
    .row.drop-into {
      outline: 1.5px dashed var(--gold);
      outline-offset: -1px;
      background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
    }
    .row.drop-before {
      box-shadow: inset 0 2px 0 var(--gold);
    }
    .twisty {
      width: 12px;
      color: var(--muted);
      font-size: 10px;
      flex: 0 0 12px;
      text-align: center;
    }
    .ico {
      flex: 0 0 auto;
      font-size: 14px;
      line-height: 1;
    }
    .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .count {
      font: 500 10.5px/1 var(--glass-font, inherit);
      font-variant-numeric: tabular-nums;
      color: var(--muted);
      padding: 3px 6px;
      border-radius: 999px;
      background: var(--panel);
    }
    .row-add {
      opacity: 0;
      width: 20px;
      height: 20px;
      border-radius: 6px;
      background: transparent;
      border: 0;
      color: var(--gold);
      cursor: pointer;
      padding: 0;
      transition: opacity var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
    }
    .row-add:hover {
      background: var(--glass-gold-a16, rgba(217, 180, 95, 0.16));
    }
    .row:hover .row-add,
    .row-add:focus-visible {
      opacity: 1;
    }
    .rename {
      flex: 1;
      min-width: 0;
      background: var(--inset);
      border: 1px solid var(--gold);
      color: var(--fg);
      border-radius: 6px;
      padding: 2px 6px;
      font: inherit;
      outline: none;
    }
    .tree .root-drop {
      display: none;
      margin: 6px 4px;
      padding: 10px;
      border: 1px dashed var(--line-gold);
      border-radius: var(--r-sm);
      font-size: 11px;
      color: var(--dim);
      text-align: center;
    }
    .tree.drop-root .root-drop {
      display: block;
      border-color: var(--gold);
      color: var(--gold);
      background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06));
    }
    .hit {
      padding: 8px 10px;
      border-radius: 9px;
      cursor: pointer;
      transition: background-color var(--dur-fast) var(--ease);
    }
    .hit:hover {
      background: var(--panel);
    }
    .hit-title {
      font-size: 13px;
      color: var(--fg);
      font-weight: 550;
    }
    .hit-path {
      font-size: 10.5px;
      color: var(--muted);
      margin-top: 1px;
    }
    .hit-snippet {
      font-size: 11.5px;
      color: var(--dim);
      margin-top: 3px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .empty-mini {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      padding: 8px 10px;
    }
    .side-foot {
      border-top: 1px solid var(--line);
      padding: 8px 10px;
      max-height: 40%;
      overflow: auto;
    }
    .link-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: 0;
      color: var(--dim);
      cursor: pointer;
      font-size: 12px;
      padding: 5px 6px;
      border-radius: 6px;
      transition: color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
    }
    .link-btn:hover {
      color: var(--gold);
      background: var(--panel);
    }
    .link-btn.danger:hover {
      color: var(--danger);
    }
    .trash-row {
      display: flex;
      gap: 4px;
      align-items: center;
      font-size: 12px;
      padding: 3px 4px;
      color: var(--dim);
    }
    /* ── Main ────────────────────────────────────────────────── */
    .main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      position: relative;
      min-height: 0;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      min-height: 52px;
      background: linear-gradient(180deg, var(--panel), transparent);
    }
    .tool-sep {
      width: 1px;
      height: 18px;
      margin: 0 6px;
      background: var(--line-strong);
    }
    .spacer {
      flex: 1;
    }
    .crumbs {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      overflow: hidden;
      font-size: 13px;
    }
    .crumb {
      background: transparent;
      border: 0;
      color: var(--muted);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 7px;
      white-space: nowrap;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
    }
    .crumb:hover {
      background: var(--panel);
      color: var(--fg);
    }
    .crumb.current {
      color: var(--fg);
      font-weight: 550;
    }
    .sep {
      color: var(--faint);
    }
    .save-state {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font: 500 11px/1 var(--glass-font, inherit);
      color: var(--muted);
      margin-right: 8px;
      padding: 5px 9px;
      border-radius: 999px;
      background: var(--panel);
      border: 1px solid var(--line);
    }
    .save-state::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 8px color-mix(in srgb, var(--ok) 70%, transparent);
    }
    .save-state.dirty,
    .save-state.saving {
      color: var(--gold);
    }
    .save-state.dirty::before,
    .save-state.saving::before {
      background: var(--gold);
      box-shadow: 0 0 8px var(--gold);
      animation: pulse 1.2s ease-in-out infinite;
    }
    .save-state.error {
      color: var(--danger);
    }
    .save-state.error::before {
      background: var(--danger);
      box-shadow: none;
    }
    @keyframes pulse {
      50% {
        opacity: 0.35;
      }
    }
    .main-scroll {
      flex: 1;
      overflow: auto;
      padding: 28px clamp(16px, 4vw, 56px) 56px;
      min-height: 0;
      transition: opacity var(--dur) var(--ease);
    }
    .main-scroll.loading {
      opacity: 0.55;
    }
    .main-scroll > * {
      animation: rise 0.45s var(--ease) both;
    }
    @keyframes rise {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font: 600 11px/1 var(--glass-font, inherit);
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 8px;
    }
    .eyebrow::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--gold);
      box-shadow: 0 0 10px var(--gold);
    }
    .title-row {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 6px;
    }
    .big-ico {
      display: grid;
      place-items: center;
      flex: none;
      width: 48px;
      height: 48px;
      border-radius: 14px;
      font-size: 24px;
      background: radial-gradient(circle at 30% 20%, var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), var(--glass-gold-a06, rgba(217, 180, 95, 0.06)));
      box-shadow: inset 0 0 0 1px var(--line-gold), var(--glass-glow-soft, 0 0 18px rgba(217, 180, 95, 0.12));
    }
    .title-input,
    .root-title {
      flex: 1;
      font: 650 clamp(24px, 2.4vw, 32px) / 1.15 var(--font-ui-display, var(--glass-font, inherit));
      letter-spacing: -0.025em;
      background: transparent;
      border: 0;
      border-radius: 8px;
      color: var(--fg);
      outline: none;
      padding: 4px 6px;
      margin: 0 0 0 -6px;
      min-width: 0;
      transition: background-color var(--dur-fast) var(--ease);
    }
    .title-input:hover {
      background: var(--panel);
    }
    .title-input:focus,
    .title-input:focus-visible {
      background: var(--panel);
      box-shadow: inset 0 -2px 0 var(--gold);
    }
    .root-title .gold {
      background: linear-gradient(120deg, var(--gold-hi), var(--gold) 45%, var(--gold-deep));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .sub {
      margin: 4px 0 0;
      color: var(--dim);
      font-size: 13.5px;
      line-height: 1.5;
      max-width: 640px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 22px 0 6px;
    }
    .stat {
      position: relative;
      padding: 14px 16px;
      border-radius: var(--r);
      background: var(--glass-sheen, none), var(--glass-3, rgba(255, 255, 255, 0.04));
      box-shadow: var(--glass-elev-1, 0 6px 18px -10px rgba(0, 0, 0, 0.5)), var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.05));
      border: 1px solid var(--line);
    }
    .stat-label {
      font: 600 10.5px/1 var(--glass-font, inherit);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .stat-value {
      margin-top: 8px;
      font: 650 24px/1 var(--font-ui-display, var(--glass-font, inherit));
      letter-spacing: -0.02em;
      font-variant-numeric: tabular-nums;
      color: var(--fg);
    }
    .meta-line {
      font-size: 12px;
      color: var(--muted);
      margin: 2px 0 18px 62px;
    }
    .meta-line a {
      color: var(--gold);
      text-decoration: none;
    }
    .props {
      display: grid;
      grid-template-columns: minmax(110px, 180px) 1fr;
      gap: 2px 12px;
      margin: 0 0 18px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: var(--r);
      background: var(--glass-sheen, none), var(--glass-3, rgba(255, 255, 255, 0.04));
      box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.05));
      font-size: 13px;
    }
    .prop-k {
      color: var(--muted);
      padding: 6px 0;
      font-size: 12px;
      font-weight: 550;
    }
    .prop-links {
      padding: 4px 6px;
      line-height: 1.5;
    }
    .prop-links a {
      color: var(--accent, #d4af37);
      text-decoration: none;
    }
    .prop-links a:hover {
      text-decoration: underline;
    }
    .prop-v input {
      width: 100%;
      background: transparent;
      border: 1px solid transparent;
      color: var(--fg);
      font: inherit;
      padding: 4px 8px;
      border-radius: 7px;
      transition: border-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
    }
    .prop-v input:hover,
    .prop-v input:focus {
      border-color: var(--line-strong);
      background: var(--inset);
      outline: none;
    }
    .banner {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 10px 14px;
      border: 1px solid var(--line-gold);
      border-radius: var(--r-sm);
      background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
      font-size: 13px;
      margin-bottom: 12px;
    }
    ib-doc-editor {
      display: block;
      min-height: 420px;
      /* The editor reads the legacy --g-* palette; point it at glass tokens so
         it follows the theme. */
      --g-primary: var(--glass-gold, #d9b45f);
      --g-fg: var(--glass-fg, #f4f1ea);
      --g-fg-dim: var(--glass-fg-2, #c9c3b6);
      --g-fg-faint: var(--glass-fg-4, #6f6a60);
      --g-border: var(--glass-stroke, rgba(217, 180, 95, 0.14));
      --g-border-strong: var(--glass-stroke-gold, rgba(217, 180, 95, 0.34));
      --g-bg: var(--glass-base, #07070a);
    }
    .backlinks {
      margin-top: 26px;
      border-top: 1px solid var(--line);
      padding-top: 8px;
    }
    .chip {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 11px;
      margin: 3px;
      cursor: pointer;
      font-size: 12px;
      color: var(--dim);
      transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
    }
    .chip:hover {
      border-color: var(--line-gold);
      color: var(--fg);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      min-height: 34px;
      padding: 0 14px;
      border: 1px solid color-mix(in srgb, var(--gold) 60%, transparent);
      background: var(--glass-gold-fill, linear-gradient(180deg, #f1d38a, #d9b45f));
      color: var(--glass-ink, #1a1408);
      border-radius: var(--r-sm);
      cursor: pointer;
      font: 600 12.5px/1 var(--glass-font, inherit);
      letter-spacing: -0.003em;
      text-decoration: none;
      white-space: nowrap;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 6px 20px -8px var(--glass-gold-a40, rgba(217, 180, 95, 0.4));
      transition: transform var(--dur-fast) var(--spring), box-shadow var(--dur) var(--ease), background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
    }
    .btn:hover {
      transform: var(--glass-lift, translateY(-1px));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 10px 28px -8px color-mix(in srgb, var(--gold) 60%, transparent);
    }
    .btn:active {
      transform: scale(0.97);
    }
    .btn.ghost {
      background: var(--glass-sheen, none), var(--panel);
      color: var(--fg);
      border-color: var(--line-strong);
      font-weight: 500;
      box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.06)), 0 1px 2px rgba(0, 0, 0, 0.15);
    }
    .btn.ghost:hover {
      background: var(--glass-sheen, none), var(--press);
      border-color: var(--line-gold);
    }
    .btn[disabled] {
      opacity: 0.45;
      cursor: default;
      transform: none;
    }
    .btn svg.i {
      width: 14px;
      height: 14px;
    }
    .dim {
      color: var(--muted);
    }
    .small {
      font-size: 11.5px;
      line-height: 1.5;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      font: 600 10.5px/1 var(--glass-font, inherit);
      padding: 4px 9px;
      border-radius: 999px;
      border: 1px solid var(--line-gold);
      background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06));
      color: var(--gold);
      white-space: nowrap;
      letter-spacing: 0.02em;
    }
    /* ── Folder views ────────────────────────────────────────── */
    .folder-bar,
    .file-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 18px 0 16px;
      flex-wrap: wrap;
      font-size: 13px;
    }
    .seg {
      display: inline-flex;
      padding: 3px;
      gap: 2px;
      border: 1px solid var(--line);
      border-radius: var(--r-sm);
      background: var(--inset);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.15);
    }
    .seg button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: transparent;
      border: 0;
      padding: 6px 11px;
      border-radius: 7px;
      cursor: pointer;
      font: 500 12px/1 var(--glass-font, inherit);
      color: var(--muted);
      transition: color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
    }
    .seg button:hover {
      color: var(--fg);
    }
    .seg button.on {
      background: var(--glass-sheen, none), var(--glass-3, rgba(255, 255, 255, 0.06));
      color: var(--fg);
      box-shadow: inset 0 0 0 1px var(--line-gold), var(--glass-elev-1, 0 2px 8px rgba(0, 0, 0, 0.3));
    }
    .seg button.on svg.i {
      color: var(--gold);
    }
    .seg svg.i {
      width: 13px;
      height: 13px;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: var(--r);
      background: var(--glass-sheen, none), var(--glass-3, rgba(255, 255, 255, 0.03));
      box-shadow: var(--glass-elev-1, 0 6px 18px -10px rgba(0, 0, 0, 0.5)), var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.05));
    }
    .list-row {
      display: grid;
      grid-template-columns: 32px minmax(140px, 1.2fr) 2fr auto;
      gap: 12px;
      align-items: center;
      padding: 9px 10px;
      border-radius: var(--r-sm);
      cursor: pointer;
      border: 1px solid transparent;
      font-size: 13.5px;
      transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--spring);
    }
    .list-row .ico {
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 9px;
      background: var(--panel);
      border: 1px solid var(--line);
      font-size: 15px;
    }
    .list-row:hover {
      background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06));
      border-color: var(--line-gold);
    }
    .list-row:active {
      transform: scale(0.995);
    }
    .list-row.drop-into {
      outline: 1.5px dashed var(--gold);
    }
    .list-title {
      font-weight: 600;
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list-prev {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12.5px;
    }
    .list-row > .dim {
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: var(--r);
      background: var(--glass-sheen, none), var(--glass-3, rgba(255, 255, 255, 0.03));
      box-shadow: var(--glass-elev-1, 0 6px 18px -10px rgba(0, 0, 0, 0.5)), var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.05));
    }
    .grid-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    .grid-table th {
      text-align: left;
      font: 600 10.5px/1 var(--glass-font, inherit);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--glass-4, var(--glass-solid, #121110));
      cursor: pointer;
      white-space: nowrap;
      position: sticky;
      top: 0;
      z-index: 1;
      transition: color var(--dur-fast) var(--ease);
    }
    .grid-table th:hover {
      color: var(--gold);
    }
    .grid-table td {
      padding: 11px 14px;
      border-bottom: 1px solid var(--line);
      max-width: 280px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--dim);
    }
    .grid-table tbody tr:last-child td {
      border-bottom: 0;
    }
    .grid-table tbody tr {
      cursor: pointer;
      transition: background-color var(--dur-fast) var(--ease);
    }
    .grid-table tbody tr:hover {
      background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06));
    }
    .name-cell {
      font-weight: 600;
      color: var(--fg) !important;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 14px;
    }
    .card {
      position: relative;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--line);
      border-radius: var(--r);
      padding: 16px;
      background: var(--glass-sheen, none), var(--glass-3, rgba(255, 255, 255, 0.04));
      box-shadow: var(--glass-elev-1, 0 6px 18px -10px rgba(0, 0, 0, 0.5)), var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.05));
      cursor: pointer;
      min-height: 140px;
      transition: transform var(--dur) var(--spring), box-shadow var(--dur) var(--ease), border-color var(--dur-fast) var(--ease);
    }
    .card:hover {
      border-color: var(--line-gold);
      transform: var(--glass-lift, translateY(-2px));
      box-shadow: var(--glass-elev-3, 0 18px 40px -16px rgba(0, 0, 0, 0.6)), var(--glass-glow-soft, 0 0 18px rgba(217, 180, 95, 0.12));
    }
    .card:active {
      transform: scale(0.99);
    }
    .card-ico {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border-radius: 12px;
      font-size: 20px;
      background: radial-gradient(circle at 30% 20%, var(--glass-gold-a16, rgba(217, 180, 95, 0.16)), var(--glass-gold-a06, rgba(217, 180, 95, 0.05)));
      box-shadow: inset 0 0 0 1px var(--line);
    }
    .card-title {
      font-weight: 620;
      color: var(--fg);
      margin: 12px 0 4px;
      letter-spacing: -0.01em;
    }
    .card-prev {
      font-size: 12px;
      line-height: 1.5;
      color: var(--muted);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .empty-big {
      text-align: center;
      padding: 56px 20px;
      color: var(--dim);
      border: 1px dashed var(--line-gold);
      border-radius: var(--glass-radius-lg, 20px);
      background: radial-gradient(600px 220px at 50% 0%, var(--glass-gold-a06, rgba(217, 180, 95, 0.06)), transparent 70%);
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
      font-size: 13.5px;
      line-height: 1.5;
    }
    .empty-big .dim {
      max-width: 460px;
    }
    .empty-title {
      font: 620 16px/1.3 var(--font-ui-display, var(--glass-font, inherit));
      letter-spacing: -0.01em;
      color: var(--fg);
    }
    .empty-ico {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      border-radius: 16px;
      margin-bottom: 4px;
      font-size: 26px;
      color: var(--gold);
      background: radial-gradient(circle at 30% 20%, var(--glass-gold-a24, rgba(217, 180, 95, 0.24)), var(--glass-gold-a06, rgba(217, 180, 95, 0.06)));
      box-shadow: inset 0 0 0 1px var(--line-gold), var(--glass-glow-soft, 0 0 18px rgba(217, 180, 95, 0.12));
    }
    .empty-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
      margin-top: 8px;
    }
    /* ── Files ───────────────────────────────────────────────── */
    .file-meta > span:not(.pill):not(.dim) {
      font-variant-numeric: tabular-nums;
      color: var(--fg);
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin: 8px 0 12px;
    }
    .tab {
      background: transparent;
      border: 1px solid var(--line);
      padding: 7px 13px;
      border-radius: 999px;
      cursor: pointer;
      font: 500 12.5px/1 var(--glass-font, inherit);
      color: var(--muted);
      transition: color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
    }
    .tab:hover {
      color: var(--fg);
      border-color: var(--line-strong);
    }
    .tab.on {
      color: var(--fg);
      border-color: var(--line-gold);
      background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
      box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.06));
    }
    .tab[disabled] {
      opacity: 0.4;
      cursor: default;
    }
    .preview {
      border: 1px solid var(--line);
      border-radius: var(--r);
      overflow: hidden;
      background: var(--inset);
      box-shadow: var(--glass-elev-1, 0 6px 18px -10px rgba(0, 0, 0, 0.5));
      min-height: 200px;
    }
    .preview .pdf {
      width: 100%;
      height: min(78vh, 1100px);
      border: 0;
      display: block;
      background: #333;
    }
    .preview .img {
      max-width: 100%;
      max-height: 78vh;
      display: block;
      margin: 0 auto;
      object-fit: contain;
    }
    .preview .media {
      width: 100%;
      max-height: 78vh;
      display: block;
      background: #000;
    }
    .preview .audio {
      width: calc(100% - 32px);
      margin: 24px 16px;
    }
    .preview .empty-big {
      border: 0;
    }
    .md-render {
      padding: 18px 22px;
      line-height: 1.65;
      font-size: 14px;
      color: var(--dim);
      overflow-wrap: anywhere;
    }
    .md-render :is(h1, h2, h3, h4, strong) {
      color: var(--fg);
    }
    .md-render a {
      color: var(--gold);
    }
    .md-render table {
      border-collapse: collapse;
    }
    .md-render th,
    .md-render td {
      border: 1px solid var(--line);
      padding: 5px 9px;
    }
    .md-render pre,
    .md-render code {
      font-family: var(--glass-font-mono, ui-monospace, monospace);
      font-size: 12.5px;
    }
    .md-render pre {
      background: var(--panel);
      border: 1px solid var(--line);
      padding: 12px;
      border-radius: var(--r-sm);
      overflow: auto;
    }
    /* ── Drop overlay ────────────────────────────────────────── */
    .main.file-drop::after {
      content: "";
      position: absolute;
      inset: 10px;
      border: 2px dashed var(--gold);
      border-radius: var(--r);
      pointer-events: none;
      background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06));
    }
    .drop-overlay {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      padding: 14px 22px;
      border-radius: var(--r);
      background: var(--glass-4, rgba(20, 18, 15, 0.92));
      backdrop-filter: var(--glass-blur-sm, blur(12px));
      -webkit-backdrop-filter: var(--glass-blur-sm, blur(12px));
      border: 1px solid var(--line-gold);
      box-shadow: var(--glass-elev-4, 0 30px 80px rgba(0, 0, 0, 0.6)), var(--glass-glow, 0 0 30px rgba(217, 180, 95, 0.2));
      color: var(--gold);
      pointer-events: none;
      font-weight: 600;
    }
    /* ── Dialogs ─────────────────────────────────────────────── */
    .scrim {
      position: fixed;
      inset: 0;
      background: color-mix(in srgb, var(--glass-base, #07070a) 55%, transparent);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: grid;
      place-items: center;
      z-index: 1000;
      animation: fade var(--dur) var(--ease) both;
    }
    @keyframes fade {
      from {
        opacity: 0;
      }
    }
    .dialog {
      position: relative;
      isolation: isolate;
      width: min(720px, calc(100vw - 32px));
      max-height: calc(100vh - 64px);
      overflow: auto;
      background: var(--glass-sheen, none), var(--glass-4, rgba(20, 18, 15, 0.94));
      backdrop-filter: var(--glass-blur-lg, blur(30px) saturate(170%));
      -webkit-backdrop-filter: var(--glass-blur-lg, blur(30px) saturate(170%));
      border: 1px solid var(--line-gold);
      border-radius: var(--glass-radius-xl, 24px);
      padding: 26px;
      box-shadow: var(--glass-elev-4, 0 30px 80px rgba(0, 0, 0, 0.6)), var(--glass-specular, inset 0 1px 0 rgba(255, 255, 255, 0.08));
      animation: pop 0.32s var(--spring) both;
      color: var(--fg);
    }
    @keyframes pop {
      from {
        opacity: 0;
        transform: translateY(10px) scale(0.98);
      }
    }
    .dialog.history {
      width: min(1000px, calc(100vw - 32px));
    }
    .dialog h2 {
      margin: 0 0 12px;
      font: 650 20px/1.2 var(--font-ui-display, var(--glass-font, inherit));
      letter-spacing: -0.02em;
      color: var(--fg);
    }
    .close {
      position: absolute;
      top: 14px;
      right: 14px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--panel);
      border: 1px solid var(--line);
      color: var(--dim);
      cursor: pointer;
      font-size: 13px;
      transition: color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--spring);
    }
    .close:hover {
      color: var(--fg);
      border-color: var(--line-gold);
      transform: rotate(90deg);
    }
    .field {
      margin: 12px 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .field label {
      font: 600 11px/1 var(--glass-font, inherit);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .row-field {
      flex-direction: row;
      gap: 8px;
    }
    .field input {
      flex: 1;
      min-width: 0;
      min-height: 36px;
      background: var(--inset);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      padding: 8px 12px;
      color: var(--fg);
      font: inherit;
      font-size: 13px;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.18);
      transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur) var(--ease);
    }
    .field input:hover {
      border-color: var(--line-gold);
    }
    .field input:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--gold) 65%, transparent);
      box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--gold));
    }
    .field input::placeholder {
      color: var(--faint);
    }
    .notion-list {
      max-height: 320px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: var(--r);
      padding: 4px;
      background: var(--panel);
    }
    .notion-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 9px;
      cursor: pointer;
      font-size: 13px;
    }
    .notion-item:hover {
      background: var(--panel);
    }
    .notion-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dlg-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
      justify-content: flex-end;
    }
    .dropbox {
      border: 1.5px dashed var(--line-gold);
      border-radius: var(--r);
      padding: 28px;
      text-align: center;
      display: flex;
      flex-direction: column;
      gap: 10px;
      align-items: center;
      margin-top: 12px;
      font-size: 13.5px;
      color: var(--dim);
      background: radial-gradient(500px 180px at 50% 0%, var(--glass-gold-a06, rgba(217, 180, 95, 0.06)), transparent 70%);
    }
    .dropbox b {
      color: var(--fg);
    }
    .force-opt {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
    }
    input[type="checkbox"] {
      accent-color: var(--gold);
    }
    .obs-import .seg,
    .map-tab .seg {
      margin: 10px 0 8px;
      flex-wrap: wrap;
    }
    .obs-what {
      margin: 12px 0 0;
      padding-left: 18px;
      line-height: 1.7;
    }
    .obs-import code,
    .obs-what code,
    .force-opt code {
      white-space: nowrap;
      font-family: var(--glass-font-mono, ui-monospace, monospace);
      font-size: 11px;
      padding: 1px 5px;
      border-radius: 5px;
      background: var(--panel);
      border: 1px solid var(--line);
      color: var(--fg);
    }
    .map-tab select {
      background: var(--inset);
      border: 1px solid var(--line-strong);
      border-radius: var(--r-sm);
      padding: 7px 9px;
      color: var(--fg);
      font: inherit;
      font-size: 12.5px;
      color-scheme: dark;
    }
    .map-tab .field select {
      width: 100%;
    }
    .map-fields {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: 12.5px;
    }
    .map-fields th {
      text-align: left;
      font: 600 10.5px/1 var(--glass-font, inherit);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      padding: 8px 6px;
      border-bottom: 1px solid var(--line);
    }
    .map-fields td {
      padding: 6px;
      border-bottom: 1px solid var(--line);
    }
    .map-fields select {
      width: 100%;
      max-width: 260px;
    }
    .map-preview {
      margin-top: 12px;
    }
    .map-sample {
      list-style: none;
      margin: 6px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12.5px;
      max-height: 180px;
      overflow: auto;
    }
    .map-sample li {
      overflow-wrap: anywhere;
    }
    .pill.update {
      color: var(--dim);
      border-color: var(--line-strong);
      background: var(--panel);
    }
    .job {
      margin: 14px 0 4px;
      padding: 14px 16px;
      border: 1px solid var(--line-gold);
      border-radius: var(--r);
      background: var(--glass-sheen, none), var(--glass-gold-a06, rgba(217, 180, 95, 0.06));
      display: flex;
      flex-direction: column;
      gap: 9px;
      min-width: 0;
    }
    .job.failed {
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    }
    .job-head {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .job-status {
      font: 650 10.5px/1 var(--glass-font, inherit);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 4px 9px;
      border-radius: 999px;
      background: var(--glass-gold-a16, rgba(217, 180, 95, 0.16));
      color: var(--gold);
      white-space: nowrap;
    }
    .job-status.done {
      background: color-mix(in srgb, var(--ok) 16%, transparent);
      color: var(--ok);
    }
    .job-status.failed {
      background: color-mix(in srgb, var(--danger) 16%, transparent);
      color: var(--danger);
    }
    .job-status.cancelled {
      background: var(--panel);
      color: var(--dim);
    }
    .job-label {
      flex: 1;
      min-width: 0;
      font-size: 13.5px;
      font-weight: 550;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar,
    .chip-bar {
      position: relative;
      height: 8px;
      border-radius: 999px;
      background: var(--panel);
      box-shadow: inset 0 0 0 1px var(--line);
      overflow: hidden;
    }
    .chip-bar {
      height: 4px;
    }
    .bar > span,
    .chip-bar > span {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--gold-deep), var(--gold), var(--gold-hi));
      box-shadow: 0 0 10px var(--glass-gold-a40, rgba(217, 180, 95, 0.4));
      transition: width 0.35s var(--ease);
    }
    .job.done .bar > span {
      background: linear-gradient(90deg, color-mix(in srgb, var(--ok) 70%, #000), var(--ok));
      box-shadow: none;
    }
    .job.failed .bar > span,
    .job.cancelled .bar > span {
      background: var(--line-strong);
      box-shadow: none;
    }
    .bar.indeterminate > span,
    .chip-bar.indeterminate > span {
      width: 35% !important;
      animation: job-slide 1.2s ease-in-out infinite;
    }
    @keyframes job-slide {
      from {
        transform: translateX(-100%);
      }
      to {
        transform: translateX(290%);
      }
    }
    .job-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      font-size: 12.5px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .job-counts b {
      color: var(--fg);
    }
    .job-current {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .job-note {
      color: var(--gold);
    }
    .err,
    .job-note.err {
      color: var(--danger);
    }
    .linkish {
      align-self: flex-start;
      background: none;
      border: 0;
      padding: 0;
      color: var(--gold);
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
      font: inherit;
    }
    .job-errors {
      margin: 0;
      padding: 8px 10px 8px 26px;
      max-height: 180px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: var(--r-sm);
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow-wrap: anywhere;
    }
    .job .dlg-actions {
      margin-top: 2px;
    }
    .import-chip {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin: 0 12px 10px;
      padding: 9px 11px;
      border: 1px solid var(--line-gold);
      border-radius: var(--r-sm);
      background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
      color: var(--gold);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .chip-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .result {
      margin-top: 12px;
      padding: 10px 13px;
      border-radius: var(--r-sm);
      background: var(--panel);
      border: 1px solid var(--line);
      font-size: 13px;
    }
    .hist-grid {
      display: grid;
      grid-template-columns: 250px 1fr;
      gap: 14px;
      min-height: 360px;
    }
    .rev-list {
      border-right: 1px solid var(--line);
      overflow: auto;
      max-height: 60vh;
      padding-right: 8px;
    }
    .rev {
      padding: 9px 11px;
      border-radius: var(--r-sm);
      cursor: pointer;
      font-size: 13px;
      border: 1px solid transparent;
      transition: background-color var(--dur-fast) var(--ease);
    }
    .rev:hover {
      background: var(--panel);
    }
    .rev.on {
      background: var(--glass-gold-a10, rgba(217, 180, 95, 0.1));
      border-color: var(--line-gold);
    }
    .rev-preview {
      overflow: auto;
      max-height: 60vh;
    }
    .move-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      max-height: 60vh;
      overflow: auto;
    }
    .uploads {
      position: fixed;
      right: 20px;
      bottom: 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      z-index: 1001;
    }
    .upload,
    .toast {
      padding: 10px 14px;
      border-radius: var(--r-sm);
      background: var(--glass-4, rgba(20, 18, 15, 0.94));
      backdrop-filter: var(--glass-blur-sm, blur(12px));
      -webkit-backdrop-filter: var(--glass-blur-sm, blur(12px));
      border: 1px solid var(--line-gold);
      box-shadow: var(--glass-elev-4, 0 20px 50px rgba(0, 0, 0, 0.5));
      font-size: 12.5px;
      color: var(--fg);
      max-width: 380px;
      animation: pop 0.3s var(--spring) both;
    }
    .upload.error {
      border-color: var(--danger);
    }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      max-width: min(560px, calc(100vw - 32px));
      font-size: 13px;
      z-index: 1002;
      animation: none;
    }
    doc-agent-panel {
      flex: 0 0 auto;
    }
    .only-mobile {
      display: none;
    }
    .side-scrim {
      display: none;
    }
    /* ── Degraded modes ──────────────────────────────────────── */
    @media (prefers-reduced-motion: reduce) {
      .aurora::before,
      .aurora::after,
      .bar.indeterminate > span,
      .chip-bar.indeterminate > span,
      .save-state::before,
      .main-scroll > *,
      .dialog,
      .scrim,
      .upload {
        animation: none !important;
      }
      .card:hover,
      .btn:hover {
        transform: none;
      }
    }
    @media (prefers-reduced-transparency: reduce) {
      .root,
      .dialog,
      .drop-overlay,
      .upload,
      .toast {
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        background: var(--glass-solid, #121110);
      }
      .aurora {
        display: none;
      }
    }
    :host-context(.perf-mode) .aurora::before,
    :host-context(.perf-mode) .aurora::after {
      animation: none;
    }
    :host-context(.perf-mode) .root,
    :host-context(.perf-mode) .dialog {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    /* ── Narrow / phone ──────────────────────────────────────── */
    @media (max-width: 820px) {
      .only-mobile {
        display: inline-flex;
      }
      .toolbar {
        flex-wrap: wrap;
        padding: 8px 10px;
        gap: 2px;
      }
      .crumbs {
        order: 10;
        flex-basis: 100%;
      }
      .tool-sep {
        display: none;
      }
      .sidebar {
        position: absolute;
        z-index: 20;
        top: 0;
        bottom: 0;
        left: 0;
        width: min(86vw, 320px);
        background: var(--glass-solid, #121110);
        box-shadow: var(--glass-elev-4, 20px 0 60px rgba(0, 0, 0, 0.5));
        transition: transform 0.28s var(--ease);
      }
      .sidebar.collapsed {
        transform: translateX(-104%);
        box-shadow: none;
      }
      .side-scrim {
        display: block;
        position: absolute;
        inset: 0;
        z-index: 19;
        background: color-mix(in srgb, var(--glass-base, #07070a) 50%, transparent);
        border: 0;
        padding: 0;
        cursor: pointer;
      }
      .main-scroll {
        padding: 20px 14px 40px;
      }
      .list-row {
        grid-template-columns: 32px minmax(0, 1fr) auto;
      }
      .list-prev {
        display: none;
      }
      .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .stat-value {
        font-size: 20px;
      }
      .meta-line {
        margin-left: 0;
      }
      .folder-bar .spacer {
        display: none;
      }
      .folder-bar > .dim {
        flex-basis: 100%;
      }
      .hist-grid {
        grid-template-columns: 1fr;
      }
      .rev-list {
        border-right: 0;
        border-bottom: 1px solid var(--line);
        max-height: 30vh;
      }
      .props {
        grid-template-columns: 1fr;
      }
      .dialog {
        padding: 22px 18px;
        border-radius: var(--glass-radius-lg, 20px);
      }
      .row-field {
        flex-wrap: wrap;
      }
    }

    /* ── Document types / library ── */
    :host {
      position: relative;
    }
    .ty-ico {
      display: inline-grid;
      place-items: center;
      flex: none;
      color: var(--tc, var(--dim));
    }
    .ty-ico svg {
      width: 15px;
      height: 15px;
    }
    .ty-ico.big svg {
      width: 20px;
      height: 20px;
    }
    .big-ico .ty-ico svg {
      width: 26px;
      height: 26px;
    }
    .list-row .ico .ty-ico svg {
      width: 16px;
      height: 16px;
    }
    .type-nav {
      padding-bottom: 4px;
    }
    .type-row .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .type-row .count {
      font: 600 11px/1 var(--glass-font, inherit);
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      padding: 3px 7px;
      border-radius: 999px;
      background: var(--panel);
    }
    .type-row.active .count {
      color: var(--gold-hi);
    }
    .type-row.empty {
      opacity: 0.55;
    }
    .link-btn.tiny {
      padding: 2px;
      display: inline-grid;
      place-items: center;
    }
    .link-btn.tiny svg {
      width: 13px;
      height: 13px;
    }
    .mode-seg {
      margin-left: auto;
      flex: none;
    }
    .library .title-row {
      align-items: center;
      gap: 12px;
    }
    .lib-row .list-title {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .lib-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .lib-meta:empty {
      display: none;
    }
    .tchip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font: 600 10.5px/1 var(--glass-font, inherit);
      letter-spacing: 0.02em;
      padding: 3px 8px;
      border-radius: 999px;
      color: var(--tc, var(--dim));
      border: 1px solid color-mix(in srgb, var(--tc, var(--dim)) 38%, transparent);
      background: color-mix(in srgb, var(--tc, var(--dim)) 10%, transparent);
    }
    .tchip.cat {
      --tc: var(--dim);
    }
    .tchip.status {
      --tc: var(--gold);
      text-transform: capitalize;
    }
    .tchip.ro {
      --tc: var(--muted);
    }
    .pop {
      position: absolute;
      z-index: 40;
      width: 260px;
      max-width: calc(100% - 16px);
      padding: 6px;
      border-radius: var(--r);
      border: 1px solid var(--line-strong);
      background: var(--glass-solid, #121110);
      box-shadow: var(--glass-elev-4, 0 24px 60px rgba(0, 0, 0, 0.55));
      backdrop-filter: var(--glass-blur-lg, blur(30px) saturate(170%));
      -webkit-backdrop-filter: var(--glass-blur-lg, blur(30px) saturate(170%));
      animation: pop-in var(--dur) var(--ease);
    }
    @keyframes pop-in {
      from {
        opacity: 0;
        transform: translateY(-4px) scale(0.98);
      }
    }
    .pop-title {
      font: 600 10px/1 var(--glass-font, inherit);
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--muted);
      padding: 8px 10px 6px;
    }
    .pop-scroll {
      max-height: min(52vh, 420px);
      overflow: auto;
    }
    .pop-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 36px;
      padding: 6px 10px;
      border: 0;
      border-radius: 9px;
      background: transparent;
      color: var(--dim);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    .pop-item:hover,
    .pop-item:focus-visible {
      background: var(--panel);
      color: var(--fg);
      outline: none;
    }
    .pop-item.on {
      color: var(--fg);
      background: var(--glass-gold-a06, rgba(217, 180, 95, 0.06));
    }
    .pop-label {
      flex: 1;
    }
    .pop-hint {
      font-size: 10.5px;
      color: var(--muted);
      display: inline-flex;
    }
    .pop-hint svg {
      width: 13px;
      height: 13px;
      color: var(--gold);
    }
    .pop-sep {
      height: 1px;
      margin: 5px 4px;
      background: var(--line);
    }
    .type-chip-wrap {
      position: relative;
      display: inline-flex;
    }
    .type-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 26px;
      padding: 0 9px 0 7px;
      border-radius: 999px;
      cursor: pointer;
      font: 600 11.5px/1 var(--glass-font, inherit);
      color: var(--fg);
      border: 1px solid color-mix(in srgb, var(--tc) 45%, transparent);
      background: color-mix(in srgb, var(--tc) 13%, transparent);
    }
    .type-chip > svg {
      width: 12px;
      height: 12px;
      opacity: 0.7;
    }
    .type-chip .inferred {
      font-weight: 500;
      font-size: 10px;
      color: var(--muted);
      letter-spacing: 0.04em;
    }
    .type-menu {
      top: calc(100% + 6px);
      left: 0;
      width: 240px;
      max-width: none;
    }
    .cat-input {
      width: 110px;
      min-height: 26px;
      padding: 0 9px;
      margin: 0 2px 0 6px;
      border-radius: 999px;
      border: 1px dashed var(--line-strong);
      background: transparent;
      color: var(--dim);
      font: 500 11.5px/1 var(--glass-font, inherit);
    }
    .cat-input:focus {
      outline: none;
      border-style: solid;
      border-color: var(--line-gold);
      color: var(--fg);
    }
    .dialog.types {
      width: min(720px, 94vw);
    }
    .ty-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 46vh;
      overflow: auto;
      margin: 10px 0 14px;
    }
    .ty-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: var(--r-sm);
      border: 1px solid var(--line);
      background: var(--panel);
    }
    .ty-row.off {
      opacity: 0.5;
    }
    .ty-move {
      display: flex;
      flex-direction: column;
    }
    .ty-move .icon-btn {
      width: 22px;
      height: 16px;
      min-height: 0;
      padding: 0;
    }
    .ty-move .icon-btn svg {
      width: 12px;
      height: 12px;
    }
    .ty-name,
    .ty-name-input {
      flex: 1;
      min-width: 0;
      font-size: 13.5px;
    }
    .ty-name-input,
    .ty-select,
    .ty-template {
      background: var(--inset);
      color: var(--fg);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 8px;
      font: inherit;
      font-size: 13px;
      color-scheme: dark;
    }
    .ty-select {
      max-width: 120px;
    }
    .ty-color {
      width: 30px;
      height: 26px;
      padding: 0;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: transparent;
      cursor: pointer;
    }
    .ty-new {
      border-top: 1px solid var(--line);
      padding-top: 4px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ty-new .section-title {
      padding-left: 0;
    }
    .ty-new-row {
      display: flex;
      gap: 8px;
    }
    .ty-template {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      font-family: var(--glass-mono, ui-monospace, monospace);
      font-size: 12px;
    }
    .ty-swatches {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .swatch {
      width: 24px;
      height: 24px;
      border-radius: 999px;
      border: 2px solid transparent;
      background: var(--tc);
      cursor: pointer;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
    }
    .swatch.on {
      border-color: var(--fg);
    }
    .ty-preview {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-right: auto;
      color: var(--dim);
      font-size: 13px;
    }
    @media (max-width: 820px) {
      .mode-seg {
        margin-left: 0;
      }
      .library .title-row {
        flex-wrap: wrap;
      }
      .ty-row {
        flex-wrap: wrap;
      }
      .ty-select {
        max-width: 96px;
      }
    }
  `;
}

function renderMarkdown(md: string): TemplateResult {
  const div = document.createElement("div");
  div.innerHTML = resolveDocAssetImages(toSanitizedMarkdownHtml(md));
  return html`${div}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-documents-workspace": DocumentsWorkspace;
  }
}

function jobKindLabel(job: ImportJob): string {
  if (job.kind === "notion-zip") return "ZIP import";
  if (job.kind === "obsidian") return "Obsidian import";
  if (job.kind === "map") return "Mapping";
  return job.mode === "changes" ? "Notion sync" : "Notion import";
}

function jobKindPrefix(job: ImportJob): string {
  if (job.kind === "notion-zip") return "ZIP · ";
  if (job.kind === "obsidian") return "Obsidian · ";
  if (job.kind === "map") return "Map · ";
  return job.mode === "changes" ? "Sync changes · " : "Notion · ";
}

function renderJobDetails(job: ImportJob): TemplateResult | typeof nothing {
  const d = job.details ?? {};
  if (job.kind === "obsidian") {
    const links = d.links as { resolved?: number; unresolved?: number } | undefined;
    const tasks = d.tasks as { created?: number; updated?: number } | undefined;
    return html`<div class="job-counts small dim" data-testid="obsidian-details">
      <span>${Number(d.notes ?? 0)} notes</span>
      ${links?.resolved || links?.unresolved ? html`<span>${links.resolved ?? 0} links${links.unresolved ? ` (${links.unresolved} unresolved)` : ""}</span>` : nothing}
      <span>${Number(d.attachments ?? 0) + Number(d.assets ?? 0)} attachments</span>
      ${d.dailyNotes ? html`<span>${Number(d.dailyNotes)} daily notes</span>` : nothing}
      ${tasks && (tasks.created || tasks.updated) ? html`<span>${tasks.created ?? 0} tasks added${tasks.updated ? ` · ${tasks.updated} updated` : ""}</span>` : tasks ? nothing : d.tasksFound ? html`<span>${Number(d.tasksFound)} checklist items (not added)</span>` : nothing}
      ${d.missing ? html`<span title="Notes imported before that are gone from the vault (kept here)">${Number(d.missing)} no longer in vault</span>` : nothing}
    </div>`;
  }
  if (job.kind === "map") {
    const m = d.mapping as { role?: string; relationsLinked?: number } | undefined;
    return m?.relationsLinked ? html`<div class="job-counts small dim"><span>${m.relationsLinked} relations linked</span></div>` : nothing;
  }
  return nothing;
}
