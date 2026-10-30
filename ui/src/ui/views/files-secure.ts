/**
 * <ib-secure-files> — the Files page in Secure Mode. Files and their OCR
 * results live only in the encrypted secure lane (files.secure.* RPCs); the
 * normal file tree, its listings and the normal agent index never see them.
 *
 * Organisation (collections, tags, project, name, notes) is sealed in the
 * vault too (files.secure.update / bulkUpdate / collections.*). Gateways that
 * predate it answer files.secure.list without `organize: true`; the view then
 * hides every organise control and behaves exactly as before.
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "../components/file-browser";
import "../components/secure-organize";
import type { OrganizeField, SecureOrganize, SecureOrganizePatch, SecureOrganizeValue, TagInput } from "../components/secure-organize";
import { openFileViewer, type FileViewer } from "../components/file-viewer";
import { isOcrPending, OCR_WINDOW_EVENT, type OcrEntryInfo } from "../file-ocr";
import {
  type BrowserItem,
  type CollectionNode,
  type SecureCollectionInfo,
  analysisStatusOf,
  buildCollectionTree,
  collectionSubtree,
  extOf,
  itemLabel,
  kindOfName,
} from "../files-organize";
import { icons } from "../icons";
import { onSecureLane } from "../secure-mode/store";

interface RequestClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

interface SearchHit {
  id: string;
  name: string;
  score: number;
  snippet: string;
  status: OcrEntryInfo["status"];
}

/** files.secure.list row: the OCR entry plus the sealed organise fields. */
export interface SecureEntryInfo extends OcrEntryInfo {
  collectionId?: string | null;
  collectionPath?: string;
  tags?: string[];
  projectId?: string | null;
  displayName?: string | null;
  notes?: string;
}

interface CollectionsInfo {
  collections: Array<SecureCollectionInfo & { path: string; count: number }>;
  rootCount: number;
  total: number;
  tags: Array<{ tag: string; count: number }>;
}

type Scope = "all" | "root" | string;

interface MenuItem {
  icon: unknown;
  label: string;
  run: () => void;
  danger?: boolean;
  testid?: string;
  on?: boolean;
  depth?: number;
}

interface Menu {
  title?: string;
  x: number;
  y: number;
  items: MenuItem[];
}

type Dialog =
  | { kind: "organize"; id: string; fields: OrganizeField[]; focus: OrganizeField | ""; title: string }
  | { kind: "collection"; mode: "create" | "rename"; id?: string; parentId?: string | null; value: string; error?: string }
  | { kind: "tags"; ids: string[]; error?: string }
  | { kind: "confirm-delete-collection"; id: string };

const DRAG_TYPE = "application/x-ib-secure-files";
const MOBILE_Q = "(max-width: 760px)";

/** Vault entry → browser item. Bytes stay sealed; the viewer decrypts on view. */
export function secureBrowserItem(e: SecureEntryInfo, snippet?: string): BrowserItem {
  return {
    key: e.id,
    name: e.name,
    path: null,
    ocrId: e.id,
    isDirectory: false,
    size: e.size,
    modified: e.createdAt || e.updatedAt,
    kind: kindOfName(e.name),
    ext: (e.ext || extOf(e.name)).toLowerCase(),
    status: analysisStatusOf(e.status),
    rawStatus: e.status,
    summary: e.summary,
    projectId: (e.projectId === undefined ? e.source?.projectId : e.projectId) ?? undefined,
    folder: e.collectionPath ?? "",
    collectionId: e.collectionId ?? null,
    tags: e.tags ?? [],
    label: e.displayName ?? undefined,
    notes: e.notes,
    snippet,
    secure: true,
    progress: e.progress,
  };
}

function organizeValue(e: SecureEntryInfo): SecureOrganizeValue {
  return {
    id: e.id,
    name: e.name,
    label: e.displayName ?? "",
    collectionId: e.collectionId ?? null,
    tags: e.tags ?? [],
    projectId: (e.projectId === undefined ? e.source?.projectId : e.projectId) ?? null,
    notes: e.notes ?? "",
  };
}

const SF_STYLES = css`
    :host { display: block; flex: 1 1 0; min-height: 0; color: var(--wg-fg, #eee); --sf-gold: var(--wg-gold, #d9b45a); --sf-gold-hi: var(--wg-gold-hi, #ecd28a); --sf-stroke: var(--glass-stroke, rgba(255,255,255,0.1)); --sf-fg2: var(--wg-fg-2, #c9c5bb); --sf-fg3: var(--wg-fg-3, #9a968c); }
    svg { width: 15px; height: 15px; flex: none; }
    .wrap {
      display: flex; flex-direction: column; height: 100%; min-height: 520px;
      border-radius: var(--wg-radius, 18px); border: 1px solid color-mix(in srgb, var(--sf-gold) 28%, var(--sf-stroke));
      background: var(--glass-sheen, none), var(--glass-1, rgba(18, 20, 26, 0.7)); box-shadow: var(--glass-specular, none); overflow: hidden;
    }
    .body { flex: 1; min-height: 0; display: grid; grid-template-columns: 236px minmax(0, 1fr); }
    .body.flat { grid-template-columns: minmax(0, 1fr); }
    .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    ib-file-browser { flex: 1 1 0; min-height: 0; }
    .bar { display: flex; gap: 8px; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--sf-stroke); flex-wrap: wrap; }
    .lane { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: var(--sf-gold); letter-spacing: 0.02em; }
    .lane svg { width: 16px; height: 16px; }
    .sp { flex: 1; }
    .search { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-radius: 9px; border: 1px solid var(--sf-stroke); background: rgba(0,0,0,0.22); min-width: 220px; }
    .search input { all: unset; flex: 1; font-size: 12.5px; }
    .search svg { color: var(--sf-fg3); width: 14px; height: 14px; }
    .btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 9px; font-size: 12.5px; border: 1px solid var(--sf-stroke); background: rgba(255,255,255,0.05); color: var(--sf-fg2); white-space: nowrap; }
    .btn:hover { color: #fff; border-color: color-mix(in srgb, var(--sf-gold) 40%, var(--sf-stroke)); }
    .btn.primary { color: #1a1406; border-color: transparent; background: linear-gradient(180deg, var(--sf-gold-hi), var(--sf-gold)); font-weight: 600; }
    .btn.danger { color: #ffb4a8; border-color: rgba(255,120,100,0.35); }
    .btn:focus-visible, .nav:focus-visible, .ib:focus-visible { outline: 2px solid var(--sf-gold); outline-offset: 1px; }
    .split { display: inline-flex; }
    .split .btn.primary:first-child { border-radius: 9px 0 0 9px; }
    .split .btn.primary + .btn.primary { border-radius: 0 9px 9px 0; padding: 0 8px; border-left: 1px solid rgba(26,20,6,0.25); }
    .err { color: #ff9a8a; font-size: 12px; padding: 8px 14px 0; display: flex; gap: 8px; align-items: center; }
    .err button { all: unset; cursor: pointer; color: var(--sf-fg3); display: inline-grid; }
    .drop { outline: 2px dashed color-mix(in srgb, var(--sf-gold) 60%, transparent); outline-offset: -6px; }
    .lane .short { display: none; }

    /* Collections sidebar */
    .cols { min-height: 0; overflow: auto; border-right: 1px solid var(--sf-stroke); padding: 12px 10px 16px; display: flex; flex-direction: column; gap: 2px; background: linear-gradient(180deg, color-mix(in srgb, var(--sf-gold) 4%, transparent), transparent 240px); }
    .cols h4 { display: flex; align-items: center; gap: 7px; margin: 0 4px 8px; font-size: 10.5px; font-weight: 650; letter-spacing: 0.12em; text-transform: uppercase; color: var(--sf-fg3); }
    .cols h4 .lockb { display: inline-flex; align-items: center; gap: 4px; height: 19px; padding: 0 7px; border-radius: 999px; font-size: 10px; letter-spacing: 0.02em; text-transform: none; color: var(--sf-gold); border: 1px solid color-mix(in srgb, var(--sf-gold) 40%, transparent); background: color-mix(in srgb, var(--sf-gold) 8%, transparent); }
    .cols h4 .lockb svg { width: 10px; height: 10px; }
    .cols h4 .ib { margin-left: auto; }
    .ib { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; color: var(--sf-fg2); flex: none; }
    .ib:hover { color: var(--sf-gold-hi); background: rgba(255,255,255,0.06); }
    .ib svg { width: 14px; height: 14px; }
    .nav { all: unset; cursor: pointer; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 4px 0 8px; border-radius: 10px; font-size: 12.5px; color: var(--sf-fg2); border: 1px solid transparent; position: relative; }
    .nav:hover { background: rgba(255,255,255,0.045); color: #fff; }
    .nav .ic { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 7px; color: var(--sf-gold); background: color-mix(in srgb, var(--sf-gold) 9%, transparent); flex: none; }
    .nav .ic svg { width: 13px; height: 13px; }
    .nav .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav .n { font-size: 11px; color: var(--sf-fg3); font-variant-numeric: tabular-nums; padding: 0 4px; }
    .nav .lk { color: color-mix(in srgb, var(--sf-gold) 70%, transparent); display: inline-grid; }
    .nav .lk svg { width: 11px; height: 11px; }
    .nav .ib { width: 24px; height: 24px; opacity: 0; }
    .nav:hover .ib, .nav:focus-within .ib, .nav[aria-current="true"] .ib { opacity: 1; }
    .nav[aria-current="true"] { color: #fff; background: color-mix(in srgb, var(--sf-gold) 11%, transparent); border-color: color-mix(in srgb, var(--sf-gold) 32%, transparent); }
    .nav.target { background: color-mix(in srgb, var(--sf-gold) 20%, transparent); border-color: var(--sf-gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--sf-gold) 18%, transparent); }
    .nav .guide { position: absolute; top: 4px; bottom: 4px; width: 1px; background: var(--sf-stroke); }
    .div { height: 1px; margin: 8px 4px; background: var(--sf-stroke); }
    .ctags { display: flex; flex-wrap: wrap; gap: 5px; padding: 2px 4px; }
    .ctag { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 11px; color: var(--sf-fg2); border: 1px solid var(--sf-stroke); }
    .ctag svg { width: 10px; height: 10px; color: var(--sf-gold); }
    .ctag[aria-pressed="true"] { color: var(--sf-gold-hi); border-color: color-mix(in srgb, var(--sf-gold) 50%, transparent); background: color-mix(in srgb, var(--sf-gold) 11%, transparent); }
    .newcol { all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 8px; margin-top: 4px; border-radius: 10px; font-size: 12.5px; color: var(--sf-fg3); border: 1px dashed var(--sf-stroke); }
    .newcol:hover { color: var(--sf-gold-hi); border-color: color-mix(in srgb, var(--sf-gold) 45%, transparent); }
    .newcol svg { width: 14px; height: 14px; }

    /* Bulk bar */
    .bulk { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 10px 12px 0; padding: 8px 10px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--sf-gold) 45%, transparent); background: linear-gradient(180deg, color-mix(in srgb, var(--sf-gold) 13%, rgba(16,17,21,0.9)), color-mix(in srgb, var(--sf-gold) 6%, rgba(16,17,21,0.9))); box-shadow: 0 10px 30px rgba(0,0,0,0.35); animation: rise 0.18s ease; }
    @keyframes rise { from { opacity: 0; transform: translateY(-4px); } }
    .bulk .cnt { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 650; color: var(--sf-gold-hi); margin-right: 4px; }
    .bulk .btn { height: 28px; padding: 0 10px; background: rgba(0,0,0,0.25); }

    /* Menus: popover on desktop, bottom sheet on phones */
    .scrim { position: fixed; inset: 0; z-index: 2190; background: rgba(4,5,8,0.7); animation: fade 0.15s ease; }
    @keyframes fade { from { opacity: 0; } }
    .menu { position: fixed; z-index: 2200; min-width: 200px; max-width: 300px; max-height: 60vh; overflow: auto; padding: 6px; border-radius: 12px; border: 1px solid var(--sf-stroke); background: color-mix(in srgb, var(--glass-base, #121419) 97%, transparent); box-shadow: 0 18px 50px rgba(0,0,0,0.55); }
    .menu .mt { padding: 6px 10px 6px; font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sf-fg3); }
    .menu button { all: unset; cursor: pointer; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; color: var(--sf-fg2); }
    .menu button svg { color: var(--sf-gold); width: 14px; height: 14px; }
    .menu button:hover, .menu button:focus-visible { background: rgba(255,255,255,0.06); color: #fff; }
    .menu button.danger, .menu button.danger svg { color: #ff9a8a; }
    .menu button .on { margin-left: auto; color: var(--sf-gold); display: inline-grid; }
    .menu .sep { height: 1px; margin: 4px 6px; background: var(--sf-stroke); }
    .sheet-menu { position: fixed; z-index: 2200; left: 0; right: 0; bottom: 0; max-height: 72vh; overflow: auto; padding: 8px 10px calc(16px + env(safe-area-inset-bottom)); border-radius: 20px 20px 0 0; border-top: 1px solid color-mix(in srgb, var(--sf-gold) 30%, var(--sf-stroke)); background: linear-gradient(180deg, color-mix(in srgb, var(--sf-gold) 5%, #101216), #0d0f13 160px); box-shadow: 0 -18px 50px rgba(0,0,0,0.55); animation: up 0.2s cubic-bezier(.2,.8,.2,1); }
    @keyframes up { from { transform: translateY(30px); opacity: 0; } }
    .sheet-menu .grab { width: 42px; height: 5px; border-radius: 5px; background: rgba(255,255,255,0.25); margin: 2px auto 10px; }
    .sheet-menu .mt { padding: 4px 8px 8px; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sf-fg3); }
    .sheet-menu button { all: unset; cursor: pointer; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 0 12px; border-radius: 12px; font-size: 15px; color: var(--sf-fg2); }
    .sheet-menu button svg { color: var(--sf-gold); width: 18px; height: 18px; }
    .sheet-menu button:active { background: rgba(255,255,255,0.06); }
    .sheet-menu button.danger, .sheet-menu button.danger svg { color: #ff9a8a; }
    .sheet-menu button .on { margin-left: auto; color: var(--sf-gold); display: inline-grid; }
    .sheet-menu .sep { height: 1px; margin: 6px 8px; background: var(--sf-stroke); }

    /* Dialogs */
    .dlg { position: fixed; z-index: 2200; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px)); max-height: 86vh; overflow: auto; box-sizing: border-box; padding: 18px 18px 16px; border-radius: 18px; border: 1px solid color-mix(in srgb, var(--sf-gold) 28%, var(--sf-stroke)); background: linear-gradient(180deg, color-mix(in srgb, var(--sf-gold) 5%, #121419), #0f1115 200px); box-shadow: 0 30px 90px rgba(0,0,0,0.6); animation: fade 0.15s ease; }
    .dlg h3 { display: flex; align-items: center; gap: 9px; margin: 0 0 4px; font-size: 15px; }
    .dlg h3 .ic { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; color: var(--sf-gold); background: color-mix(in srgb, var(--sf-gold) 10%, transparent); border: 1px solid color-mix(in srgb, var(--sf-gold) 28%, transparent); }
    .dlg p { margin: 0 0 14px; font-size: 12.5px; color: var(--sf-fg3); line-height: 1.5; }
    .dlg .fld { all: unset; box-sizing: border-box; width: 100%; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--sf-stroke); background: rgba(0,0,0,0.25); font-size: 13.5px; }
    .dlg .fld:focus { border-color: color-mix(in srgb, var(--sf-gold) 55%, transparent); }
    .dlg .acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    .dlg .derr { color: #ff9a8a; font-size: 12px; margin-top: 8px; }

    /* Phone: collections become a chip strip; menus become sheets */
    .strip { display: none; }
    @media (max-width: 760px) {
      .search { min-width: 0; flex: 1 1 100%; order: 5; }
      .lane .long { display: none; } .lane .short { display: inline; }
      .body { grid-template-columns: minmax(0, 1fr); }
      .cols { display: none; }
      .strip { position: relative; display: flex; gap: 6px; overflow-x: auto; padding: 8px 10px; border-bottom: 1px solid var(--sf-stroke); scrollbar-width: none; }
      .strip .nav { width: auto; flex: none; min-height: 32px; padding: 0 10px 0 6px; border: 1px solid var(--sf-stroke); border-radius: 999px; }
      .strip .nav .ib { display: none; }
      .strip .newcol { flex: none; margin: 0; min-height: 32px; border-radius: 999px; }
      .dlg { left: 0; right: 0; top: auto; bottom: 0; transform: none; width: auto; border-radius: 20px 20px 0 0; padding-bottom: calc(18px + env(safe-area-inset-bottom)); animation: up 0.2s cubic-bezier(.2,.8,.2,1); }
      .bulk { margin: 8px 8px 0; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; gap: 5px; padding: 6px 8px; }
      .bulk .sp { display: none; }
      .bulk .btn { flex: none; padding: 0 9px; }
      .bulk .btn .lab { display: none; }
      .strip { mask-image: linear-gradient(90deg, #000 82%, transparent); -webkit-mask-image: linear-gradient(90deg, #000 82%, transparent); padding-right: 30px; }
    }
    @media (prefers-reduced-motion: reduce) { .bulk, .sheet-menu, .dlg, .scrim { animation: none; } }
  `;

/**
 * Body-level layer for menus and dialogs. The Files panel sits inside glass
 * containers (backdrop-filter + overflow:hidden) that trap position:fixed, so
 * overlays render here — like the file viewer, which also mounts on <body>.
 */
@customElement("ib-sf-layer")
export class SecureFilesLayer extends LitElement {
  static styles = [SF_STYLES, css`:host { display: contents; }`];
  @property({ attribute: false }) content: unknown = nothing;
  render() {
    return this.content;
  }
}

@customElement("ib-secure-files")
export class SecureFiles extends LitElement {
  static styles = SF_STYLES;

  @property({ attribute: false }) client: RequestClient | null = null;
  @state() private entries: SecureEntryInfo[] = [];
  @state() private selected: string | null = null;
  @state() private query = "";
  @state() private hits: SearchHit[] | null = null;
  @state() private error: string | null = null;
  @state() private loading = false;
  @state() private dragging = false;
  /** null = unknown yet; false = gateway predates organise (controls hidden). */
  @state() private organize: boolean | null = null;
  @state() private cols: CollectionsInfo = { collections: [], rootCount: 0, total: 0, tags: [] };
  @state() private projects: Array<{ id: string; name: string }> = [];
  @state() private scope: Scope = "all";
  @state() private tagFilter = "";
  @state() private picked: Set<string> = new Set();
  @state() private menu: Menu | null = null;
  @state() private dialog: Dialog | null = null;
  @state() private dropTarget: string | null = null;
  @state() private dragKeys: string[] = [];
  @state() private mobile = false;
  private mq: MediaQueryList | null = null;
  private viewer: FileViewer | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;
  private offLane: (() => void) | null = null;
  private closeMenu = () => (this.menu = null);
  private onMq = () => (this.mobile = this.mq?.matches ?? false);
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || document.querySelector("ib-file-viewer")) return;
    if (this.dialog) this.dialog = null;
    else if (this.menu) this.menu = null;
    else if (this.picked.size) this.picked = new Set();
  };
  private onOcr = (e: Event) => {
    if ((e as CustomEvent<{ lane?: string }>).detail?.lane === "secure") void this.load();
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(OCR_WINDOW_EVENT, this.onOcr);
    window.addEventListener("click", this.closeMenu);
    window.addEventListener("keydown", this.onKey);
    this.offLane = onSecureLane((ev) => {
      if (ev.kind === "files") void this.load();
      if (ev.kind === "kanban") void this.loadProjects();
    });
    this.mq = window.matchMedia(MOBILE_Q);
    this.mobile = this.mq.matches;
    this.mq.addEventListener("change", this.onMq);
    void this.load();
    void this.loadProjects();
  }

  private layer: SecureFilesLayer | null = null;

  protected updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("scope") && this.mobile) {
      // Keep the active collection chip in view (no scrollIntoView: it shifts the shell).
      const strip = this.renderRoot.querySelector<HTMLElement>(".strip");
      const on = strip?.querySelector<HTMLElement>('[aria-current="true"]');
      if (strip && on) strip.scrollLeft = Math.max(0, on.offsetLeft - 12);
    }
    const content = this.menu || this.dialog ? html`${this.renderMenu()}${this.renderDialog()}` : nothing;
    if (content === nothing && !this.layer) return;
    if (!this.layer) {
      this.layer = document.createElement("ib-sf-layer") as SecureFilesLayer;
      document.body.appendChild(this.layer);
    }
    this.layer.content = content;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.layer?.remove();
    this.layer = null;
    window.removeEventListener(OCR_WINDOW_EVENT, this.onOcr);
    window.removeEventListener("click", this.closeMenu);
    window.removeEventListener("keydown", this.onKey);
    this.mq?.removeEventListener("change", this.onMq);
    this.offLane?.();
    if (this.timer) clearTimeout(this.timer);
  }

  async load() {
    if (!this.client) return;
    if (!this.entries.length) this.loading = true;
    try {
      const res = await this.client.request<{ entries: SecureEntryInfo[]; organize?: boolean }>("files.secure.list", {});
      this.entries = res?.entries ?? [];
      this.organize = res?.organize === true;
      if (this.organize) {
        const c = await this.client.request<CollectionsInfo>("files.secure.collections.list", {});
        if (c) this.cols = c;
        if (this.scope !== "all" && this.scope !== "root" && !this.cols.collections.some((x) => x.id === this.scope)) this.scope = "all";
      }
      const ids = new Set(this.entries.map((e) => e.id));
      if ([...this.picked].some((k) => !ids.has(k))) this.picked = new Set([...this.picked].filter((k) => ids.has(k)));
      this.error = null;
      this.refreshViewer();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.entries.some((e) => isOcrPending(e.status))) this.timer = setTimeout(() => void this.load(), 3000);
  }

  private async loadProjects() {
    try {
      const res = await this.client?.request<{ projects?: Array<{ id: string; name: string }> }>("secure.kanban.list", {});
      this.projects = (res?.projects ?? []).filter((p) => p?.id).map((p) => ({ id: p.id, name: p.name || p.id }));
    } catch {
      /* project names are cosmetic */
    }
  }

  /** Keep an open viewer's names/tags in step after organise edits. */
  private refreshViewer() {
    const v = this.viewer;
    if (!v?.isConnected) return;
    const byId = new Map(this.entries.map((e) => [e.id, e]));
    v.items = v.items.map((i) => (byId.has(i.key) ? secureBrowserItem(byId.get(i.key)!, i.snippet) : i));
  }

  private async rpc<T = unknown>(method: string, params: Record<string, unknown>): Promise<T | null> {
    try {
      return await this.client!.request<T>(method, params);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  private get tree(): CollectionNode[] {
    return buildCollectionTree(this.cols.collections);
  }

  private colName(id: string | null | undefined): string {
    if (!id) return "Unfiled";
    return this.cols.collections.find((c) => c.id === id)?.path ?? "collection";
  }

  /** Where "Upload" puts files: the open collection, else the root. */
  private get uploadTarget(): string | null {
    return this.organize && this.scope !== "all" && this.scope !== "root" ? this.scope : null;
  }

  private pick(collectionId: string | null = this.uploadTarget) {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => void this.upload([...(input.files ?? [])], collectionId);
    input.click();
  }

  private async upload(files: File[], collectionId: string | null = this.uploadTarget) {
    if (!this.client) return;
    for (const f of files) {
      try {
        const b64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
          r.onerror = () => reject(r.error);
          r.readAsDataURL(f);
        });
        const res = await this.client.request<{ entry: OcrEntryInfo }>("files.secure.upload", {
          name: f.name,
          content: b64,
          ...(this.organize && collectionId ? { collectionId } : {}),
        });
        if (res?.entry) this.selected = res.entry.id;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
    }
    await this.load();
  }

  private async search(q: string) {
    this.query = q;
    const seq = ++this.searchSeq;
    if (q.trim().length < 2) {
      this.hits = null;
      return;
    }
    try {
      const res = await this.client!.request<{ results: SearchHit[] }>("files.context.search", { query: q, secure: true });
      if (seq === this.searchSeq) this.hits = res?.results ?? [];
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async download(e: OcrEntryInfo) {
    const res = await this.client!.request<{ content: string; name: string; mime: string }>("files.secure.download", { id: e.id });
    const bytes = Uint8Array.from(atob(res.content), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: res.mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = res.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  private async del(e: SecureEntryInfo) {
    if (!confirm(`Delete "${e.displayName || e.name}" from the secure lane? This cannot be undone.`)) return;
    await this.client!.request("files.secure.delete", { id: e.id });
    if (this.selected === e.id) this.selected = null;
    await this.load();
  }

  // ── organise actions ──────────────────────────────────────────────────

  private async bulk(ids: string[], patch: Record<string, unknown>) {
    if (!ids.length) return false;
    const res = ids.length === 1
      ? await this.rpc("files.secure.update", { id: ids[0], ...patch })
      : await this.rpc("files.secure.bulkUpdate", { ids, ...patch });
    await this.load();
    return res !== null;
  }

  private async moveTo(ids: string[], collectionId: string | null) {
    if (await this.bulk(ids, { collectionId })) this.picked = new Set();
  }

  private async saveOrganize(e: CustomEvent<{ id: string; patch: SecureOrganizePatch }>) {
    const form = e.composedPath()[0] as SecureOrganize;
    const res = await this.rpc("files.secure.update", { id: e.detail.id, ...e.detail.patch });
    if (res === null) {
      form.saveState = { error: this.error ?? "Could not save" };
      return;
    }
    await this.load();
    const fresh = this.entries.find((x) => x.id === e.detail.id);
    if (fresh) form.value = organizeValue(fresh);
    form.saveState = "saved";
    if (this.dialog?.kind === "organize") this.dialog = null;
  }

  private async submitCollection(d: Extract<Dialog, { kind: "collection" }>) {
    const name = d.value.trim();
    if (!name) {
      this.dialog = { ...d, error: "Give the collection a name." };
      return;
    }
    try {
      if (d.mode === "create") {
        const r = await this.client!.request<{ collection: { id: string } }>("files.secure.collections.create", { name, ...(d.parentId ? { parentId: d.parentId } : {}) });
        if (r?.collection) this.scope = r.collection.id;
      } else {
        await this.client!.request("files.secure.collections.rename", { id: d.id, name });
      }
      this.dialog = null;
      await this.load();
    } catch (err) {
      this.dialog = { ...d, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async deleteCollection(id: string) {
    const res = await this.rpc("files.secure.collections.delete", { id });
    this.dialog = null;
    if (res && (this.scope === id || !this.cols.collections.some((c) => c.id === this.scope))) this.scope = "all";
    await this.load();
  }

  private async applyTags(d: Extract<Dialog, { kind: "tags" }>) {
    const input = this.layer?.renderRoot.querySelector<TagInput>(".dlg ib-tag-input");
    const tags = input?.commitPending() ?? [];
    if (!tags.length) {
      this.dialog = { ...d, error: "Type a tag, then press Enter." };
      return;
    }
    if (await this.bulk(d.ids, { addTags: tags })) {
      this.dialog = null;
      this.picked = new Set();
    }
  }

  // ── drag and drop ─────────────────────────────────────────────────────

  private dropOn(e: DragEvent, target: string | null) {
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();
    e.stopPropagation();
    this.dropTarget = null;
    this.dragging = false;
    const raw = dt.getData(DRAG_TYPE);
    if (raw) {
      try {
        const keys = (JSON.parse(raw) as unknown[]).filter((k): k is string => typeof k === "string");
        void this.moveTo(keys, target);
      } catch {
        /* foreign payload */
      }
      return;
    }
    if (dt.files?.length) void this.upload([...dt.files], target);
  }

  private dropZone(target: string | null) {
    const key = target ?? "root";
    return {
      over: (e: DragEvent) => {
        const types = [...(e.dataTransfer?.types ?? [])];
        if (!types.includes(DRAG_TYPE) && !types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = types.includes(DRAG_TYPE) ? "move" : "copy";
        this.dropTarget = key;
      },
      leave: (e: DragEvent) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && this.dropTarget === key) this.dropTarget = null;
      },
      drop: (e: DragEvent) => this.dropOn(e, target),
    };
  }

  // ── menus ─────────────────────────────────────────────────────────────

  private openMenu(e: Event, menu: Omit<Menu, "x" | "y">, at?: { x: number; y: number }) {
    e.stopPropagation();
    const zoom = parseFloat(getComputedStyle(document.body).zoom || "1") || 1;
    let x = at?.x ?? 0;
    let y = at?.y ?? 0;
    if (!at) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      x = r.left;
      y = r.bottom + 4;
    }
    x /= zoom;
    y /= zoom;
    const w = window.innerWidth / zoom;
    const h = window.innerHeight / zoom;
    this.menu = { ...menu, x: Math.max(8, Math.min(x, w - 270)), y: Math.max(8, Math.min(y, h - Math.min(menu.items.length * 36 + 48, h * 0.6) - 8)) };
  }

  private moveItems(ids: string[]): MenuItem[] {
    const cur = ids.length === 1 ? this.entries.find((e) => e.id === ids[0])?.collectionId ?? null : undefined;
    return [
      { icon: icons.inbox, label: "Unfiled (root)", on: cur === null, run: () => void this.moveTo(ids, null), testid: "move-root" },
      ...this.tree.map((c) => ({ icon: icons.folder, label: c.name, depth: c.depth, on: cur === c.id, run: () => void this.moveTo(ids, c.id), testid: `move-${c.id}` })),
      { icon: icons.folderPlus, label: "New collection…", run: () => (this.dialog = { kind: "collection", mode: "create", value: "", parentId: null }) },
    ];
  }

  private projectItems(ids: string[]): MenuItem[] {
    const cur = ids.length === 1 ? organizeValue(this.entries.find((e) => e.id === ids[0])!).projectId : undefined;
    return [
      { icon: icons.minus, label: "No project", on: cur === null, run: () => void this.bulk(ids, { projectId: null }).then(() => (this.picked = new Set())) },
      ...this.projects.map((p) => ({ icon: icons.briefcase, label: p.name, on: cur === p.id, run: () => void this.bulk(ids, { projectId: p.id }).then(() => (this.picked = new Set())) })),
    ];
  }

  private fileMenu(item: BrowserItem, e: Event, at?: { x: number; y: number }) {
    const entry = this.entries.find((x) => x.id === item.key);
    if (!entry) return;
    const label = itemLabel(item);
    const org = (fields: OrganizeField[], focus: OrganizeField, title: string) => () => (this.dialog = { kind: "organize", id: entry.id, fields, focus, title });
    const items: MenuItem[] = [
      { icon: icons.eye, label: "Open viewer", run: () => this.openViewer(item, [item]) },
      ...(this.organize
        ? [
            { icon: icons.edit, label: "Rename", run: org(["name"], "name", "Rename"), testid: "fm-rename" },
            { icon: icons.folderInput, label: "Move to…", run: () => this.openMenu(e, { title: `Move “${label}”`, items: this.moveItems([entry.id]) }, at), testid: "fm-move" },
            { icon: icons.tag, label: "Tags", run: org(["tags"], "tags", "Tags"), testid: "fm-tags" },
            { icon: icons.briefcase, label: "Project", run: () => this.openMenu(e, { title: "Set project", items: this.projectItems([entry.id]) }, at), testid: "fm-project" },
            { icon: icons.penLine, label: "Notes", run: org(["notes"], "notes", "Notes"), testid: "fm-notes" },
          ]
        : []),
      { icon: icons.download, label: "Download", run: () => void this.download(entry) },
      { icon: icons.trash, label: "Delete", danger: true, run: () => void this.del(entry) },
    ];
    this.openMenu(e, { title: label, items }, at);
  }

  private collectionMenu(c: CollectionNode, e: Event) {
    this.openMenu(e, {
      title: c.name,
      items: [
        { icon: icons.upload, label: "Upload here…", run: () => this.pick(c.id) },
        { icon: icons.folderPlus, label: "New sub-collection", run: () => (this.dialog = { kind: "collection", mode: "create", value: "", parentId: c.id }) },
        { icon: icons.edit, label: "Rename", run: () => (this.dialog = { kind: "collection", mode: "rename", id: c.id, value: c.name }), testid: "cm-rename" },
        { icon: icons.trash, label: "Delete collection", danger: true, run: () => (this.dialog = { kind: "confirm-delete-collection", id: c.id }), testid: "cm-delete" },
      ],
    });
  }

  private renderMenu() {
    const m = this.menu;
    if (!m) return nothing;
    const run = (it: MenuItem) => (e: Event) => {
      e.stopPropagation();
      this.menu = null;
      it.run();
    };
    const body = html`${m.title ? html`<div class="mt">${m.title}</div>` : nothing}
      ${m.items.map(
        (it) => html`<button role="menuitem" class=${it.danger ? "danger" : ""} data-testid=${it.testid ?? nothing} style=${it.depth ? `padding-left:${10 + it.depth * 14}px` : ""} @click=${run(it)}>${it.icon}${it.label}${it.on ? html`<span class="on">${icons.check}</span>` : nothing}</button>`,
      )}`;
    if (this.mobile) {
      return html`<div class="scrim" @click=${() => (this.menu = null)}></div>
        <div class="sheet-menu" role="menu" data-testid="sf-sheet" @click=${(e: Event) => e.stopPropagation()}><div class="grab"></div>${body}</div>`;
    }
    return html`<div class="menu" role="menu" data-testid="sf-menu" style="left:${m.x}px;top:${m.y}px" @click=${(e: Event) => e.stopPropagation()}>${body}</div>`;
  }

  private renderDialog() {
    const d = this.dialog;
    if (!d) return nothing;
    const close = () => (this.dialog = null);
    let inner: TemplateResult;
    if (d.kind === "organize") {
      const entry = this.entries.find((x) => x.id === d.id);
      if (!entry) return nothing;
      inner = html`<h3><span class="ic">${d.fields.includes("tags") ? icons.tag : d.fields.includes("notes") ? icons.penLine : icons.edit}</span>${d.title}</h3>
        <p>${entry.displayName || entry.name} · stays sealed in the encrypted vault.</p>
        <ib-secure-organize
          .value=${organizeValue(entry)}
          .fields=${d.fields}
          .focusField=${d.focus}
          .collections=${this.tree}
          .allTags=${this.cols.tags.map((t) => t.tag)}
          .projects=${this.projects}
          @organize-save=${(e: CustomEvent<{ id: string; patch: SecureOrganizePatch }>) => void this.saveOrganize(e)}
          @organize-cancel=${close}
        ></ib-secure-organize>`;
    } else if (d.kind === "collection") {
      const parent = d.parentId ? this.colName(d.parentId) : "";
      inner = html`<h3><span class="ic">${d.mode === "create" ? icons.folderPlus : icons.edit}</span>${d.mode === "create" ? (parent ? "New sub-collection" : "New collection") : "Rename collection"}</h3>
        <p>${d.mode === "create" ? (parent ? `Inside ${parent}. ` : "") + "The name is encrypted with your files." : "Files inside stay where they are."}</p>
        <form @submit=${(e: Event) => (e.preventDefault(), void this.submitCollection(d))}>
          <input class="fld" data-testid="col-name" aria-label="Collection name" maxlength="80" placeholder="e.g. Tax returns" .value=${d.value} @input=${(e: Event) => (this.dialog = { ...d, value: (e.target as HTMLInputElement).value, error: undefined })} />
          ${d.error ? html`<div class="derr" role="alert">${d.error}</div>` : nothing}
          <div class="acts"><button type="button" class="btn" @click=${close}>Cancel</button><button type="submit" class="btn primary" data-testid="col-save">${icons.check}${d.mode === "create" ? "Create" : "Rename"}</button></div>
        </form>`;
    } else if (d.kind === "tags") {
      inner = html`<h3><span class="ic">${icons.tag}</span>Add tags</h3>
        <p>Added to ${d.ids.length} file${d.ids.length === 1 ? "" : "s"}. Existing tags stay.</p>
        <ib-tag-input inline .tags=${[]} .suggestions=${this.cols.tags.map((t) => t.tag)} placeholder="Type a tag and press Enter"></ib-tag-input>
        ${d.error ? html`<div class="derr" role="alert">${d.error}</div>` : nothing}
        <div class="acts"><button class="btn" @click=${close}>Cancel</button><button class="btn primary" data-testid="tags-apply" @click=${() => void this.applyTags(d)}>${icons.check}Add tags</button></div>`;
    } else {
      const c = this.cols.collections.find((x) => x.id === d.id);
      const n = this.tree.find((x) => x.id === d.id)?.total ?? 0;
      inner = html`<h3><span class="ic">${icons.folderMinus}</span>Delete “${c?.name ?? "collection"}”?</h3>
        <p>${n ? `Its ${n} file${n === 1 ? "" : "s"} move to Unfiled` : "It is empty"}${this.tree.some((x) => x.parentId === d.id) ? " and its sub-collections move up a level" : ""}. Files are never deleted.</p>
        <div class="acts"><button class="btn" @click=${close}>Cancel</button><button class="btn danger" data-testid="col-delete-confirm" @click=${() => void this.deleteCollection(d.id)}>${icons.trash}Delete collection</button></div>`;
    }
    return html`<div class="scrim" @click=${close}></div>
      <div class="dlg" role="dialog" aria-modal="true" data-testid="sf-dialog" @click=${(e: Event) => e.stopPropagation()}>${inner}</div>`;
  }

  // ── sidebar ───────────────────────────────────────────────────────────

  private navRow(key: Scope, icon: unknown, label: string, count: number, opts: { node?: CollectionNode; target: string | null | undefined }) {
    const z = opts.target === undefined ? null : this.dropZone(opts.target);
    const depth = opts.node?.depth ?? 0;
    return html`<div
      class="nav ${this.dropTarget === (opts.target === undefined ? "__none" : (opts.target ?? "root")) ? "target" : ""}"
      role="button"
      tabindex="0"
      aria-current=${String(this.scope === key)}
      data-testid=${opts.node ? `col-${opts.node.id}` : `col-${key}`}
      style=${depth ? `padding-left:${8 + depth * 14}px` : ""}
      @click=${() => {
        this.scope = key;
        this.picked = new Set();
      }}
      @keydown=${(e: KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), (this.scope = key))}
      @dragover=${z?.over}
      @dragenter=${z?.over}
      @dragleave=${z?.leave}
      @drop=${z?.drop}
    >
      <span class="ic">${icon}</span>
      <span class="nm" title=${opts.node?.path ?? label}>${label}</span>
      ${opts.node ? html`<span class="lk" title="Encrypted">${icons.lock}</span>` : nothing}
      <span class="n">${count}</span>
      ${opts.node ? html`<button class="ib" aria-label="Collection actions for ${label}" data-testid="col-more" @click=${(e: Event) => this.collectionMenu(opts.node!, e)}>${icons.moreVertical}</button>` : nothing}
    </div>`;
  }

  private renderSidebar(strip: boolean) {
    const tree = this.tree;
    const rows = html`
      ${this.navRow("all", icons.layers, "All files", this.cols.total, { target: undefined })}
      ${this.navRow("root", icons.inbox, "Unfiled", this.cols.rootCount, { target: null })}
      ${strip ? nothing : html`<div class="div"></div>`}
      ${tree.map((c) => this.navRow(c.id, icons.folder, c.name, c.total, { node: c, target: c.id }))}
      <button class="newcol" data-testid="col-new" @click=${() => (this.dialog = { kind: "collection", mode: "create", value: "", parentId: null })}>${icons.folderPlus}New collection</button>`;
    if (strip) return html`<nav class="strip" aria-label="Collections" data-testid="sf-strip">${rows}</nav>`;
    return html`<nav class="cols" aria-label="Collections" data-testid="sf-collections">
      <h4>Collections<span class="lockb">${icons.lock}Encrypted</span><button class="ib" aria-label="New collection" title="New collection" @click=${() => (this.dialog = { kind: "collection", mode: "create", value: "", parentId: null })}>${icons.folderPlus}</button></h4>
      ${rows}
      ${this.cols.tags.length
        ? html`<div class="div"></div><h4>Tags</h4>
            <div class="ctags">${this.cols.tags.slice(0, 18).map(
              (t) => html`<button class="ctag" aria-pressed=${String(this.tagFilter.toLowerCase() === t.tag.toLowerCase())} @click=${() => (this.tagFilter = this.tagFilter.toLowerCase() === t.tag.toLowerCase() ? "" : t.tag)}>${icons.tag}${t.tag}<span>${t.count}</span></button>`,
            )}</div>`
        : nothing}
    </nav>`;
  }

  private renderBulk() {
    if (!this.organize || !this.picked.size) return nothing;
    const ids = [...this.picked];
    const anyFiled = ids.some((id) => this.entries.find((e) => e.id === id)?.collectionId);
    return html`<div class="bulk" role="toolbar" aria-label="Selected files" data-testid="sf-bulk">
      <span class="cnt">${icons.squareCheck}${ids.length} selected</span>
      <button class="btn" data-testid="bulk-move" @click=${(e: Event) => this.openMenu(e, { title: `Move ${ids.length} file${ids.length === 1 ? "" : "s"} to`, items: this.moveItems(ids) })}>${icons.folderInput}<span class="lab">Move to collection</span></button>
      <button class="btn" data-testid="bulk-tags" @click=${(e: Event) => (e.stopPropagation(), (this.dialog = { kind: "tags", ids }))}>${icons.tag}<span class="lab">Add tags</span></button>
      <button class="btn" data-testid="bulk-project" @click=${(e: Event) => this.openMenu(e, { title: "Set project", items: this.projectItems(ids) })}>${icons.briefcase}<span class="lab">Set project</span></button>
      ${anyFiled ? html`<button class="btn" data-testid="bulk-unfile" @click=${() => void this.moveTo(ids, null)}>${icons.folderMinus}<span class="lab">Remove from collection</span></button>` : nothing}
      <span class="sp"></span>
      <button class="btn" @click=${() => (this.picked = new Set(this.visibleItems().map((i) => i.key)))}>${icons.check}<span class="lab">Select all</span></button>
      <button class="btn" aria-label="Clear selection" @click=${() => (this.picked = new Set())}>${icons.x}</button>
    </div>`;
  }

  private openViewer(item: BrowserItem, items: BrowserItem[]) {
    this.selected = item.key;
    this.viewer = openFileViewer({
      client: this.client!,
      items,
      index: Math.max(0, items.findIndex((i) => i.key === item.key)),
      hooks: {
        onSearch: (q) => void this.search(q),
        onDownload: (it) => {
          const e = this.entries.find((x) => x.id === it.ocrId);
          if (e) void this.download(e);
        },
        onAskAgent: (_it, prompt) => this.dispatchEvent(new CustomEvent("secure-ask-agent", { detail: { prompt }, bubbles: true, composed: true })),
        onOpenKg: (it) => this.dispatchEvent(new CustomEvent("secure-open-kg", { detail: { item: it }, bubbles: true, composed: true })),
        renderPanelTop: (it) => {
          const e = this.organize ? this.entries.find((x) => x.id === it.key) : null;
          if (!e) return nothing;
          return html`<ib-secure-organize
            compact
            data-testid="fv-organize"
            .value=${organizeValue(e)}
            .collections=${this.tree}
            .allTags=${this.cols.tags.map((t) => t.tag)}
            .projects=${this.projects}
            @organize-save=${(ev: CustomEvent<{ id: string; patch: SecureOrganizePatch }>) => void this.saveOrganize(ev)}
          ></ib-secure-organize>`;
        },
      },
    });
  }

  private visibleItems(): BrowserItem[] {
    const byId = new Map(this.entries.map((e) => [e.id, e]));
    let items = this.hits
      ? this.hits.filter((h) => byId.has(h.id)).map((h) => secureBrowserItem(byId.get(h.id)!, h.snippet))
      : this.entries.map((e) => secureBrowserItem(e));
    if (this.organize) {
      if (this.scope === "root") items = items.filter((i) => !i.collectionId);
      else if (this.scope !== "all") {
        const sub = collectionSubtree(this.cols.collections, this.scope);
        items = items.filter((i) => i.collectionId && sub.has(i.collectionId));
      }
      if (this.tagFilter) {
        const t = this.tagFilter.toLowerCase();
        items = items.filter((i) => (i.tags ?? []).some((x) => x.toLowerCase() === t));
      }
    }
    return items;
  }

  private emptyCopy(): { title: string; body: string } {
    if (this.hits) return { title: "No secure file mentions that", body: "Try other words." };
    if (this.organize && this.tagFilter) return { title: `Nothing tagged “${this.tagFilter}” here`, body: "Clear the tag filter in the sidebar to see more." };
    if (this.organize && this.scope !== "all" && this.entries.length) {
      return this.scope === "root"
        ? { title: "Everything is filed", body: "Every secure file is in a collection." }
        : { title: `${this.colName(this.scope)} is empty`, body: this.mobile ? "Upload straight into it, or move files here from their menu." : "Drag files onto this collection in the sidebar, or upload straight into it." };
    }
    return {
      title: "No secure files yet",
      body: "Files uploaded here are sealed in the encrypted vault and read only by local OCR and vision. They never appear in your normal files or agent memory.",
    };
  }

  render() {
    const items = this.visibleItems();
    const org = this.organize === true;
    const target = this.uploadTarget;
    const empty = this.emptyCopy();
    const projectNames = new Map(this.projects.map((p) => [p.id, p.name]));
    return html`<div
      class="wrap ${this.dragging ? "drop" : ""}"
      data-testid="secure-files"
      @dragover=${(e: DragEvent) => {
        if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
        e.preventDefault();
        this.dragging = true;
      }}
      @dragleave=${(e: DragEvent) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) this.dragging = false;
      }}
      @drop=${(e: DragEvent) => {
        e.preventDefault();
        this.dragging = false;
        if (e.dataTransfer?.files?.length) void this.upload([...e.dataTransfer.files]);
      }}
    >
      <div class="bar">
        <span class="lane">${icons.shieldCheck}<span class="long">Secure lane · encrypted · decrypted only in memory</span><span class="short">Encrypted vault</span></span>
        <span class="sp"></span>
        <label class="search">${icons.search}<input
            placeholder="Search inside secure files…"
            aria-label="Search secure files by content"
            .value=${this.query}
            @input=${(e: Event) => void this.search((e.target as HTMLInputElement).value)}
        /></label>
        ${this.hits ? html`<button class="btn" @click=${() => void this.search("")}>${icons.x}${this.hits.length} results</button>` : nothing}
        ${org
          ? html`<span class="split">
              <button class="btn primary" data-testid="sf-upload" title=${target ? `Upload into ${this.colName(target)}` : "Upload (Unfiled)"} @click=${() => this.pick()}>${icons.upload}Upload</button>
              <button class="btn primary" data-testid="sf-upload-to" aria-label="Upload to…" title="Upload to…" @click=${(e: Event) =>
                this.openMenu(e, {
                  title: "Upload to…",
                  items: [
                    { icon: icons.inbox, label: "Unfiled (root)", run: () => this.pick(null) },
                    ...this.tree.map((c) => ({ icon: icons.folder, label: c.name, depth: c.depth, on: target === c.id, run: () => this.pick(c.id) })),
                    { icon: icons.folderPlus, label: "New collection…", run: () => (this.dialog = { kind: "collection", mode: "create", value: "", parentId: null }) },
                  ],
                })}>${icons.chevronDown}<span class="short">Upload to…</span></button>
            </span>`
          : html`<button class="btn primary" @click=${() => this.pick()}>${icons.upload}Upload</button>`}
      </div>
      ${this.error ? html`<div class="err" role="alert">${this.error}<button aria-label="Dismiss" @click=${() => (this.error = null)}>${icons.x}</button></div>` : nothing}
      ${org ? this.renderSidebar(true) : nothing}
      <div class="body ${org ? "" : "flat"}">
        ${org ? this.renderSidebar(false) : nothing}
        <section class="main" aria-label="Secure files">
          ${this.renderBulk()}
          <ib-file-browser
            lane="secure"
            .client=${this.client}
            .items=${items}
            .loading=${this.loading}
            .selectedKey=${this.selected}
            .projectNames=${projectNames}
            .selectable=${org}
            .selectedKeys=${this.picked}
            .itemMenu=${org}
            .dragType=${org ? DRAG_TYPE : ""}
            .tagSource=${org ? "user" : "entities"}
            .emptyTitle=${empty.title}
            .emptyBody=${empty.body}
            .emptyHint=${org && !this.hits && !this.entries.length ? html`<span class="hint" data-testid="sf-hint">${icons.lightbulb}Create a collection, then drag files in or choose Upload to…</span>` : nothing}
            @selection-change=${(e: CustomEvent<{ keys: string[] }>) => (this.picked = new Set(e.detail.keys))}
            @item-open=${(e: CustomEvent<{ item: BrowserItem; items: BrowserItem[] }>) => this.openViewer(e.detail.item, e.detail.items)}
            @item-context=${(e: CustomEvent<{ item: BrowserItem; x: number; y: number }>) => this.fileMenu(e.detail.item, e, { x: e.detail.x, y: e.detail.y })}
            @item-menu=${(e: CustomEvent<{ item: BrowserItem; x: number; y: number }>) => this.fileMenu(e.detail.item, e, { x: e.detail.x - 200, y: e.detail.y + 4 })}
            @items-drag=${(e: CustomEvent<{ keys: string[] }>) => (this.dragKeys = e.detail.keys)}
          ></ib-file-browser>
        </section>
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-secure-files": SecureFiles;
    "ib-sf-layer": SecureFilesLayer;
  }
}
