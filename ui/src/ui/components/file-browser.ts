/**
 * <ib-file-browser> — grouped Grid / Gallery / List file browser with the
 * organise toolbar (group by, view, sort, filter chips, scope). Shared by the
 * normal Files page and the Secure Mode lane; prefs are remembered per viewer
 * and lane (files-organize.ts).
 *
 * Events (bubbling, composed):
 *   item-open     { item, items }   file clicked (items = visible order)
 *   folder-open   { item }
 *   item-context  { item, x, y }    right-click
 *   scope-change  { scope }         "This folder" ⇄ "All files" (normal lane)
 *   selection-change { keys }      multi-select (when `selectable`)
 *   item-menu     { item, x, y }    kebab button (when `itemMenu`)
 *
 * With `dragType` set, cards are draggable; the payload (that MIME type) is a
 * JSON array of keys — the whole selection when the dragged card is selected.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import { cachedThumb, clearSecureThumbs, loadThumb, type MediaClient } from "../file-media";
import {
  type BrowserItem,
  type GroupBy,
  type ItemEnrichment,
  type OrganizePrefs,
  type SortKey,
  type ViewMode,
  type FileKind,
  type AnalysisStatus,
  enrichmentFromSidecar,
  itemLabel,
  filterBrowserItems,
  groupBrowserItems,
  loadOrganizePrefs,
  saveOrganizePrefs,
  sortBrowserItems,
} from "../files-organize";
import { isSecureModeActive, onSecureChange } from "../secure-mode/store";

const enrichCache = { normal: new Map<string, ItemEnrichment>(), secure: new Map<string, ItemEnrichment>() };

function fmtSize(bytes: number): string {
  if (!bytes) return "—";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtDate(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function kindIcon(it: Pick<BrowserItem, "kind" | "name">) {
  switch (it.kind) {
    case "folder":
      return icons.folder;
    case "image":
      return icons.image;
    case "video":
      return icons.video;
    case "document":
      return /\.(json|ya?ml|toml|xml|html?|ts|js|py|sh)$/i.test(it.name) ? icons.fileCode : icons.fileText;
    default:
      return icons.layers;
  }
}

const STATUS_LABEL: Record<AnalysisStatus, string> = { done: "Analysed", pending: "Reading", failed: "Failed", none: "" };

/** Lazily loads an in-memory thumbnail when scrolled into view. */
@customElement("ib-file-thumb")
export class FileThumb extends LitElement {
  static styles = css`
    :host { position: absolute; inset: 0; display: block; }
    img { width: 100%; height: 100%; object-fit: cover; display: block; animation: in 0.25s ease; }
    @keyframes in { from { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { img { animation: none; } }
  `;
  @property({ attribute: false }) client: MediaClient | null = null;
  @property({ attribute: false }) item: BrowserItem | null = null;
  @state() private src: string | null = null;
  private io: IntersectionObserver | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        this.io?.disconnect();
        void this.fetch();
      }
    }, { rootMargin: "200px" });
    this.io.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.io?.disconnect();
  }

  protected willUpdate(c: PropertyValues<this>): void {
    if (c.has("item") && this.item) this.src = cachedThumb(this.item);
  }

  private async fetch() {
    if (!this.client || !this.item || this.src) return;
    const key = this.item.key;
    const t = await loadThumb(this.client, this.item);
    if (t && this.item?.key === key) this.src = t;
  }

  render() {
    return this.src ? html`<img src=${this.src} alt="" draggable="false" />` : nothing;
  }
}

@customElement("ib-file-browser")
export class FileBrowser extends LitElement {
  static styles = css`
    :host { display: flex; flex-direction: column; min-height: 0; min-width: 0; color: var(--wg-fg, #ece8df); --fb-gold: var(--wg-gold, #d9b45a); --fb-gold-hi: var(--wg-gold-hi, #ecd28a); --fb-stroke: var(--glass-stroke, rgba(255,255,255,0.1)); --fb-fg2: var(--wg-fg-2, #c9c5bb); --fb-fg3: var(--wg-fg-3, #9a968c); }
    svg { width: 15px; height: 15px; flex: none; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--fb-stroke); }
    .ctl { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 4px 0 10px; border-radius: 9px; border: 1px solid var(--fb-stroke); background: rgba(0,0,0,0.2); color: var(--fb-fg3); font-size: 11.5px; }
    .ctl svg { width: 13px; height: 13px; color: var(--fb-gold); }
    .ctl select { all: unset; cursor: pointer; height: 28px; padding: 0 20px 0 2px; font-size: 12.5px; color: var(--wg-fg, #eee); background: linear-gradient(45deg, transparent 50%, var(--fb-fg3) 50%) calc(100% - 9px) 13px / 5px 5px no-repeat, linear-gradient(135deg, var(--fb-fg3) 50%, transparent 50%) calc(100% - 5px) 13px / 5px 5px no-repeat; }
    .ctl select option { background: #16181d; color: #eee; }
    .ctl:focus-within { border-color: color-mix(in srgb, var(--fb-gold) 55%, transparent); }
    .seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 9px; border: 1px solid var(--fb-stroke); background: rgba(0,0,0,0.2); }
    .seg button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; border-radius: 7px; font-size: 12px; color: var(--fb-fg3); }
    .seg button[aria-pressed="true"] { color: #1a1406; background: linear-gradient(180deg, var(--fb-gold-hi), var(--fb-gold)); }
    .seg button:focus-visible, .chip:focus-visible, .gh:focus-visible, .card:focus-visible, .row:focus-visible, .ib:focus-visible { outline: 2px solid var(--fb-gold); outline-offset: 1px; }
    .ib { all: unset; cursor: pointer; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; border: 1px solid var(--fb-stroke); color: var(--fb-fg2); background: rgba(0,0,0,0.2); }
    .sp { flex: 1; }
    .count { font-size: 11.5px; color: var(--fb-fg3); font-variant-numeric: tabular-nums; }
    .chips { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--fb-stroke); overflow-x: auto; scrollbar-width: none; }
    .chips .lbl { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--fb-fg3); margin-right: 2px; flex: none; }
    .chips .div { width: 1px; height: 18px; background: var(--fb-stroke); margin: 0 4px; flex: none; }
    .chip { all: unset; cursor: pointer; flex: none; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12px; color: var(--fb-fg2); border: 1px solid var(--fb-stroke); background: rgba(255,255,255,0.03); }
    .chip svg { width: 12px; height: 12px; }
    .chip[aria-pressed="true"] { color: var(--fb-gold-hi); border-color: color-mix(in srgb, var(--fb-gold) 55%, transparent); background: color-mix(in srgb, var(--fb-gold) 12%, transparent); }
    .chip.clear { color: var(--fb-fg3); border-style: dashed; }
    .scroll { flex: 1; min-height: 0; overflow: auto; padding: 6px 12px 18px; }
    .group { margin-top: 8px; }
    .gh { all: unset; cursor: pointer; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 6px; position: sticky; top: -6px; z-index: 2; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: var(--wg-fg, #eee); background: linear-gradient(180deg, color-mix(in srgb, var(--glass-base, #121419) 96%, transparent) 70%, transparent); }
    .gh .chev { color: var(--fb-fg3); transition: transform 0.18s; }
    .gh[aria-expanded="false"] .chev { transform: rotate(-90deg); }
    .gh .gi { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 7px; color: var(--fb-gold); background: color-mix(in srgb, var(--fb-gold) 10%, transparent); }
    .gh .gi svg { width: 13px; height: 13px; }
    .gh .n { padding: 1px 8px; border-radius: 999px; font-size: 11px; color: var(--fb-fg3); border: 1px solid var(--fb-stroke); font-variant-numeric: tabular-nums; }
    .gh .line { flex: 1; height: 1px; background: linear-gradient(90deg, var(--fb-stroke), transparent); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; padding: 4px 2px 6px; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; padding: 4px 2px 6px; }
    .card { position: relative; cursor: pointer; display: flex; flex-direction: column; min-width: 0; border-radius: 14px; overflow: hidden; border: 1px solid var(--fb-stroke); background: rgba(255,255,255,0.025); transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s; }
    .card:hover { border-color: color-mix(in srgb, var(--fb-gold) 45%, transparent); transform: translateY(-2px); box-shadow: 0 12px 30px rgba(0,0,0,0.35); }
    .card[aria-selected="true"] { border-color: var(--fb-gold); box-shadow: 0 0 0 1px var(--fb-gold); }
    .media { position: relative; aspect-ratio: 1 / 1; display: grid; place-items: center; background: radial-gradient(circle at 30% 20%, rgba(255,255,255,0.05), transparent 60%), rgba(0,0,0,0.28); color: var(--fb-gold); overflow: hidden; }
    .gallery .media { aspect-ratio: 16 / 10; }
    .media .big { display: grid; justify-items: center; gap: 6px; }
    .media .big svg { width: 34px; height: 34px; opacity: 0.85; }
    .gallery .media .big svg { width: 46px; height: 46px; }
    .media .ext { font: 700 10.5px var(--font-mono, ui-monospace, monospace); letter-spacing: 0.08em; color: var(--fb-fg3); text-transform: uppercase; }
    .media.folder { color: var(--fb-gold-hi); background: color-mix(in srgb, var(--fb-gold) 7%, rgba(0,0,0,0.25)); }
    .play { position: absolute; z-index: 1; left: 8px; bottom: 8px; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 50%; color: #fff; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.25); backdrop-filter: blur(4px); }
    .play svg { width: 13px; height: 13px; }
    .badges { position: absolute; z-index: 1; left: 8px; right: 8px; top: 8px; display: flex; gap: 5px; justify-content: space-between; pointer-events: none; }
    .b { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 10.5px; font-weight: 650; color: #f3efe6; background: rgba(8,9,12,0.72); border: 1px solid rgba(255,255,255,0.14); backdrop-filter: blur(6px); }
    .b svg { width: 11px; height: 11px; }
    .b.lock { color: var(--fb-gold-hi); border-color: color-mix(in srgb, var(--fb-gold) 50%, transparent); }
    .b[data-s="done"] { color: #9ce3b5; }
    .b[data-s="failed"] { color: #ff9a8a; }
    .b[data-s="pending"] { color: var(--fb-gold-hi); }
    .b[data-s="pending"] svg { animation: spin 1.1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .meta { display: grid; gap: 3px; padding: 9px 11px 11px; min-width: 0; }
    .meta .nm { font-size: 12.5px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta .sub { font-size: 11px; color: var(--fb-fg3); font-variant-numeric: tabular-nums; }
    .gallery .meta { padding: 12px 14px 14px; gap: 5px; }
    .gallery .meta .nm { font-size: 14px; }
    .sum { font-size: 12px; line-height: 1.45; color: var(--fb-fg2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .snip { font-size: 11.5px; color: var(--fb-fg3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list { display: grid; gap: 2px; }
    .lh, .row { display: grid; grid-template-columns: minmax(0, 1fr) 92px 84px 96px 84px; align-items: center; gap: 10px; }
    .lh { padding: 6px 10px; font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--fb-fg3); }
    .lh button { all: unset; cursor: pointer; }
    .lh button[data-on="true"] { color: var(--fb-gold); }
    .row { padding: 6px 10px; border-radius: 10px; cursor: pointer; font-size: 12.5px; }
    .row:hover { background: rgba(255,255,255,0.04); }
    .row[aria-selected="true"] { background: color-mix(in srgb, var(--fb-gold) 10%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fb-gold) 30%, transparent); }
    .row .nmc { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .row .th { position: relative; width: 34px; height: 34px; flex: none; border-radius: 8px; overflow: hidden; display: grid; place-items: center; color: var(--fb-gold); background: rgba(255,255,255,0.05); }
    .row .th svg { width: 15px; height: 15px; }
    .row .txt { min-width: 0; display: grid; }
    .row .txt b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .c { color: var(--fb-fg3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .row .st { justify-self: start; }
    .row .b { position: static; background: rgba(255,255,255,0.04); }
    .row .lk { color: var(--fb-gold); display: inline-grid; }
    .row .lk svg { width: 12px; height: 12px; }
    .pick { all: unset; cursor: pointer; position: absolute; z-index: 2; right: 8px; bottom: 8px; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; color: #f3efe6; background: rgba(8,9,12,0.66); border: 1px solid rgba(255,255,255,0.2); backdrop-filter: blur(6px); opacity: 0; transition: opacity 0.12s; }
    .pick svg { width: 16px; height: 16px; }
    .card:hover .pick, .card:focus-within .pick, .pick:focus-visible, :host([data-selecting]) .pick, .pick[aria-checked="true"] { opacity: 1; }
    .pick[aria-checked="true"] { color: #1a1406; background: linear-gradient(180deg, var(--fb-gold-hi), var(--fb-gold)); border-color: transparent; }
    .card[data-picked="true"] { border-color: var(--fb-gold); box-shadow: 0 0 0 1px var(--fb-gold), 0 10px 26px rgba(0,0,0,0.3); }
    .card[data-picked="true"] .media::after { content: ""; position: absolute; inset: 0; background: color-mix(in srgb, var(--fb-gold) 14%, transparent); pointer-events: none; }
    .row .pick { position: static; opacity: 1; width: 22px; height: 22px; background: transparent; border: 0; color: var(--fb-fg3); backdrop-filter: none; }
    .row .pick[aria-checked="true"] { color: var(--fb-gold); background: transparent; }
    .row[data-picked="true"] { background: color-mix(in srgb, var(--fb-gold) 8%, transparent); }
    .nmline { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .nmline .nm { flex: 1; min-width: 0; }
    .more { all: unset; cursor: pointer; flex: none; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 7px; color: var(--fb-fg3); margin-right: -4px; }
    .more:hover, .more:focus-visible { color: var(--fb-gold-hi); background: rgba(255,255,255,0.06); }
    .more svg { width: 15px; height: 15px; }
    .tgs { display: flex; gap: 4px; overflow: hidden; min-width: 0; }
    .tg { flex: none; display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 999px; font-size: 10.5px; color: var(--fb-gold-hi); background: color-mix(in srgb, var(--fb-gold) 10%, transparent); border: 1px solid color-mix(in srgb, var(--fb-gold) 28%, transparent); max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tg.more-n { color: var(--fb-fg3); background: transparent; border-color: var(--fb-stroke); }
    .card[draggable="true"] { -webkit-user-drag: element; }
    .card.dragging { opacity: 0.45; }
    .empty { display: grid; justify-items: center; gap: 8px; padding: 50px 20px; text-align: center; color: var(--fb-fg3); font-size: 12.5px; }
    .empty .big { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 15px; color: var(--fb-gold); background: color-mix(in srgb, var(--fb-gold) 9%, transparent); border: 1px solid color-mix(in srgb, var(--fb-gold) 28%, transparent); }
    .empty .big svg { width: 22px; height: 22px; }
    .empty b { color: var(--wg-fg, #eee); font-size: 14px; }
    .empty .hint { display: inline-flex; align-items: center; gap: 7px; margin-top: 6px; padding: 7px 13px; border-radius: 999px; font-size: 12px; font-weight: 550; color: var(--fb-gold-hi); border: 1px solid color-mix(in srgb, var(--fb-gold) 38%, transparent); background: color-mix(in srgb, var(--fb-gold) 10%, transparent); }
    .empty .hint svg { width: 13px; height: 13px; }
    .skel { border-radius: 14px; aspect-ratio: 1 / 1.2; background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.09), rgba(255,255,255,0.04)); background-size: 200% 100%; animation: sh 1.4s ease infinite; }
    @keyframes sh { to { background-position: -200% 0; } }
    .enrich { font-size: 11px; color: var(--fb-gold); display: inline-flex; align-items: center; gap: 5px; }
    .enrich svg { width: 12px; height: 12px; animation: spin 1.1s linear infinite; }
    @media (max-width: 760px) {
      .bar { gap: 6px; padding: 8px; }
      .lab { display: none; }
      .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }
      .b .bl { display: none; }
      .b { padding: 0 6px; }
      .chips { mask-image: linear-gradient(90deg, #000 85%, transparent); -webkit-mask-image: linear-gradient(90deg, #000 85%, transparent); padding-right: 28px; }
      .gallery { grid-template-columns: 1fr; gap: 12px; }
      .lh { display: none; }
      .row { grid-template-columns: minmax(0, 1fr) auto; }
      .row .c.sz, .row .c.dt, .row .c.ty { display: none; }
      .scroll { padding: 4px 8px 16px; }
      .empty { padding: 22px 14px; gap: 6px; }
      .empty .big { width: 40px; height: 40px; }
    }
    @media (prefers-reduced-motion: reduce) { .card, .gh .chev { transition: none; } .skel, .b[data-s="pending"] svg, .enrich svg { animation: none; } .card:hover { transform: none; } }
  `;

  @property({ attribute: false }) client: MediaClient | null = null;
  @property({ attribute: false }) items: BrowserItem[] = [];
  @property() lane: "normal" | "secure" = "normal";
  @property({ type: Boolean }) loading = false;
  @property() selectedKey: string | null = null;
  @property({ attribute: false }) projectNames: Map<string, string> = new Map();
  /** Text shown when the (unfiltered) list is empty. */
  @property() emptyTitle = "Nothing here yet";
  @property() emptyBody = "";
  /** Optional hint under the empty state (rendered as-is). */
  @property({ attribute: false }) emptyHint: unknown = nothing;
  /** Multi-select with checkboxes (Secure Files organise). */
  @property({ type: Boolean }) selectable = false;
  @property({ attribute: false }) selectedKeys: ReadonlySet<string> = new Set();
  /** Show a kebab button per file (emits item-menu). */
  @property({ type: Boolean }) itemMenu = false;
  /** MIME type for dragging cards onto drop targets ("" = not draggable). */
  @property() dragType = "";
  /** Tag grouping source: sidecar entities, or the user's own tags. */
  @property() tagSource: "entities" | "user" = "entities";
  private lastPicked: string | null = null;
  private visibleOrder: BrowserItem[] = [];

  @state() prefs: OrganizePrefs = loadOrganizePrefs("normal");
  @state() private enrichTick = 0;
  @state() private enriching = 0;
  private enrichQueued = new Set<string>();
  private unsubSecure: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.prefs = loadOrganizePrefs(this.lane);
    this.unsubSecure = onSecureChange(() => {
      if (!isSecureModeActive()) {
        enrichCache.secure.clear();
        clearSecureThumbs();
      }
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubSecure?.();
  }

  protected willUpdate(c: PropertyValues<this>): void {
    if (c.has("lane")) this.prefs = loadOrganizePrefs(this.lane);
  }

  protected updated(): void {
    if ((this.prefs.groupBy === "tag" && this.tagSource === "entities") || this.prefs.hasFindings) this.enrichVisible();
    this.toggleAttribute("data-selecting", this.selectable && this.selectedKeys.size > 0);
  }

  private pickToggle(it: BrowserItem, e?: MouseEvent | KeyboardEvent) {
    const next = new Set(this.selectedKeys);
    if (e?.shiftKey && this.lastPicked) {
      const order = this.visibleOrder.filter((v) => !v.isDirectory);
      const a = order.findIndex((v) => v.key === this.lastPicked);
      const b = order.findIndex((v) => v.key === it.key);
      if (a >= 0 && b >= 0) {
        for (const v of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(v.key);
        this.emit("selection-change", { keys: [...next] });
        return;
      }
    }
    if (next.has(it.key)) next.delete(it.key);
    else next.add(it.key);
    this.lastPicked = it.key;
    this.emit("selection-change", { keys: [...next] });
  }

  /** Click: toggles while selecting or with Ctrl/Cmd/Shift; otherwise opens. */
  private activate(e: MouseEvent, it: BrowserItem, visible: BrowserItem[]) {
    if (this.selectable && !it.isDirectory && (this.selectedKeys.size > 0 || e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault();
      this.pickToggle(it, e);
      return;
    }
    this.open(it, visible);
  }

  private pickBox(it: BrowserItem) {
    if (!this.selectable || it.isDirectory) return nothing;
    const on = this.selectedKeys.has(it.key);
    return html`<button
      class="pick"
      role="checkbox"
      aria-checked=${String(on)}
      aria-label=${on ? `Deselect ${itemLabel(it)}` : `Select ${itemLabel(it)}`}
      data-testid="fb-pick"
      @click=${(e: MouseEvent) => (e.stopPropagation(), this.pickToggle(it, e))}
      @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
    >${on ? icons.squareCheck : icons.square}</button>`;
  }

  private menuBtn(it: BrowserItem) {
    if (!this.itemMenu || it.isDirectory) return nothing;
    return html`<button
      class="more"
      aria-label="More actions for ${itemLabel(it)}"
      aria-haspopup="menu"
      data-testid="fb-more"
      @click=${(e: MouseEvent) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        this.emit("item-menu", { item: it, x: r.right, y: r.bottom });
      }}
      @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
    >${icons.moreVertical}</button>`;
  }

  private tagChips(it: BrowserItem) {
    const tags = it.tags ?? [];
    if (!tags.length) return nothing;
    return html`<span class="tgs">${tags.slice(0, 3).map((t) => html`<span class="tg" title=${t}>${t}</span>`)}${tags.length > 3 ? html`<span class="tg more-n">+${tags.length - 3}</span>` : nothing}</span>`;
  }

  private dragStart(e: DragEvent, it: BrowserItem) {
    if (!this.dragType || !e.dataTransfer) return;
    const keys = this.selectedKeys.has(it.key) ? [...this.selectedKeys] : [it.key];
    e.dataTransfer.setData(this.dragType, JSON.stringify(keys));
    e.dataTransfer.setData("text/plain", `${keys.length} secure file${keys.length === 1 ? "" : "s"}`);
    e.dataTransfer.effectAllowed = "move";
    (e.currentTarget as HTMLElement).classList.add("dragging");
    this.emit("items-drag", { keys, active: true });
  }

  private dragEnd(e: DragEvent) {
    (e.currentTarget as HTMLElement).classList.remove("dragging");
    this.emit("items-drag", { keys: [], active: false });
  }

  private setPrefs(patch: Partial<OrganizePrefs>) {
    this.prefs = { ...this.prefs, ...patch };
    saveOrganizePrefs(this.lane, this.prefs);
    if ("scope" in patch) this.emit("scope-change", { scope: this.prefs.scope });
  }

  private emit(name: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private get cache() {
    return enrichCache[this.lane];
  }

  /** Tag grouping / has-findings need sidecar entities: fetch them lazily, 3 at a time. */
  private enrichVisible() {
    const client = this.client;
    if (!client) return;
    const todo = this.items.filter((i) => i.ocrId && i.status === "done" && !this.cache.has(i.key) && !this.enrichQueued.has(i.key)).slice(0, 300);
    if (!todo.length) return;
    for (const t of todo) this.enrichQueued.add(t.key);
    this.enriching += todo.length;
    let idx = 0;
    const worker = async () => {
      while (idx < todo.length) {
        const it = todo[idx++];
        try {
          const r = await client.request<{ found: boolean; sidecar?: { entities?: string[]; analyses?: [] } | null }>("files.context.get", {
            id: it.ocrId,
            ...(it.secure ? { secure: true } : {}),
          });
          this.cache.set(it.key, enrichmentFromSidecar(r?.sidecar));
        } catch {
          this.cache.set(it.key, { entities: [], findings: 0 });
        }
        this.enriching--;
        if (idx % 6 === 0 || idx >= todo.length) this.enrichTick++;
      }
    };
    void Promise.all([worker(), worker(), worker()]).then(() => {
      this.enriching = 0;
      this.enrichTick++;
    });
  }

  private open(it: BrowserItem, visible: BrowserItem[]) {
    if (it.isDirectory) this.emit("folder-open", { item: it });
    else this.emit("item-open", { item: it, items: visible.filter((v) => !v.isDirectory) });
  }

  private ctx(e: MouseEvent, it: BrowserItem) {
    e.preventDefault();
    e.stopPropagation();
    this.emit("item-context", { item: it, x: e.clientX, y: e.clientY });
  }

  private toggleIn<T>(arr: T[], v: T): T[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  private statusBadge(it: BrowserItem) {
    if (it.isDirectory || it.status === "none") return nothing;
    const ic = it.status === "done" ? icons.sparkles : it.status === "failed" ? icons.alertCircle : icons.loader;
    return html`<span class="b" data-s=${it.status} title=${STATUS_LABEL[it.status]}>${ic}<span class="bl">${STATUS_LABEL[it.status]}</span></span>`;
  }

  private media(it: BrowserItem) {
    if (it.isDirectory) return html`<div class="media folder"><span class="big">${icons.folder}</span></div>`;
    const thumbable = it.kind === "image" || (it.kind === "video" && it.ocrId && it.status === "done");
    return html`<div class="media">
      <span class="big">${kindIcon(it)}<span class="ext">${it.ext.replace(".", "") || it.kind}</span></span>
      ${thumbable ? html`<ib-file-thumb .client=${this.client} .item=${it}></ib-file-thumb>` : nothing}
      ${it.kind === "video" ? html`<span class="play">${icons.play}</span>` : nothing}
      <div class="badges">
        ${it.secure ? html`<span class="b lock" title="Encrypted in the secure vault">${icons.lock}<span class="bl">Secure</span></span>` : html`<span></span>`}
        ${this.statusBadge(it)}
      </div>
    </div>`;
  }

  private renderCard(it: BrowserItem, visible: BrowserItem[], gallery: boolean) {
    return html`<div
      class="card"
      role="option"
      tabindex="0"
      data-testid="fb-card"
      aria-selected=${String(this.selectedKey === it.key)}
      data-picked=${String(this.selectedKeys.has(it.key))}
      aria-label=${itemLabel(it)}
      draggable=${this.dragType && !it.isDirectory ? "true" : "false"}
      @dragstart=${(e: DragEvent) => this.dragStart(e, it)}
      @dragend=${(e: DragEvent) => this.dragEnd(e)}
      @click=${(e: MouseEvent) => this.activate(e, it, visible)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter") (e.preventDefault(), this.open(it, visible));
        else if (e.key === " ") (e.preventDefault(), this.selectable && !it.isDirectory ? this.pickToggle(it, e) : this.open(it, visible));
      }}
      @contextmenu=${(e: MouseEvent) => this.ctx(e, it)}
    >
      ${this.media(it)}
      ${this.pickBox(it)}
      <div class="meta">
        <span class="nmline"><span class="nm" title=${it.name}>${itemLabel(it)}</span>${this.menuBtn(it)}</span>
        ${this.tagChips(it)}
        ${gallery && it.summary ? html`<span class="sum">${it.summary}</span>` : nothing}
        ${it.snippet ? html`<span class="snip">${it.snippet}</span>` : nothing}
        <span class="sub">${it.isDirectory ? "Folder" : `${fmtSize(it.size)} · ${fmtDate(it.modified)}`}</span>
      </div>
    </div>`;
  }

  private renderRow(it: BrowserItem, visible: BrowserItem[]) {
    const thumbable = it.kind === "image" || (it.kind === "video" && it.ocrId && it.status === "done");
    return html`<div
      class="row"
      role="option"
      tabindex="0"
      data-testid="fb-row"
      aria-selected=${String(this.selectedKey === it.key)}
      data-picked=${String(this.selectedKeys.has(it.key))}
      draggable=${this.dragType && !it.isDirectory ? "true" : "false"}
      @dragstart=${(e: DragEvent) => this.dragStart(e, it)}
      @dragend=${(e: DragEvent) => this.dragEnd(e)}
      @click=${(e: MouseEvent) => this.activate(e, it, visible)}
      @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.open(it, visible)}
      @contextmenu=${(e: MouseEvent) => this.ctx(e, it)}
    >
      <span class="nmc">
        ${this.pickBox(it)}
        <span class="th">${kindIcon(it)}${thumbable ? html`<ib-file-thumb .client=${this.client} .item=${it}></ib-file-thumb>` : nothing}</span>
        <span class="txt"><b title=${it.name}>${itemLabel(it)}</b>${it.tags?.length ? this.tagChips(it) : it.snippet || it.summary ? html`<span class="snip">${it.snippet || it.summary}</span>` : nothing}</span>
        ${it.secure ? html`<span class="lk" title="Secure">${icons.lock}</span>` : nothing}
        ${this.menuBtn(it)}
      </span>
      <span class="st">${this.statusBadge(it)}</span>
      <span class="c sz">${it.isDirectory ? "—" : fmtSize(it.size)}</span>
      <span class="c dt">${fmtDate(it.modified)}</span>
      <span class="c ty">${it.isDirectory ? "folder" : it.ext.replace(".", "") || it.kind}</span>
    </div>`;
  }

  private sortHead(key: SortKey, label: string) {
    const on = this.prefs.sort === key;
    return html`<button data-on=${String(on)} @click=${() => this.setPrefs(on ? { asc: !this.prefs.asc } : { sort: key, asc: key === "name" })}>${label}${on ? (this.prefs.asc ? " ↑" : " ↓") : ""}</button>`;
  }

  private renderToolbar(shown: number, total: number) {
    const p = this.prefs;
    const groupOpts: Array<[GroupBy, string]> = [
      ["none", "None"],
      ["type", "Type"],
      ["date", "Date"],
      ["project", "Project"],
      ["folder", this.lane === "secure" ? "Collection" : "Folder"],
      ["tag", this.tagSource === "user" ? "Tag" : "Tag / entity"],
      ["status", "Analysis status"],
    ];
    const views: Array<[ViewMode, unknown, string]> = [
      ["grid", icons.layoutGrid, "Grid"],
      ["gallery", icons.gallery, "Gallery"],
      ["list", icons.layoutList, "List"],
    ];
    return html`<div class="bar" data-testid="fb-toolbar">
      ${this.lane === "normal"
        ? html`<div class="seg" role="group" aria-label="Scope">
            <button aria-pressed=${String(p.scope === "folder")} @click=${() => this.setPrefs({ scope: "folder" })} title="Only this folder">${icons.folder}<span class="lab">This folder</span></button>
            <button aria-pressed=${String(p.scope === "all")} data-testid="fb-scope-all" @click=${() => this.setPrefs({ scope: "all" })} title="Every file, all folders">${icons.layers}<span class="lab">All files</span></button>
          </div>`
        : nothing}
      <label class="ctl" title="Group by">${icons.layers}<span class="lab">Group</span>
        <select aria-label="Group by" data-testid="fb-group" .value=${p.groupBy} @change=${(e: Event) => this.setPrefs({ groupBy: (e.target as HTMLSelectElement).value as GroupBy, collapsed: [] })}>
          ${groupOpts.map(([v, l]) => html`<option value=${v} ?selected=${p.groupBy === v}>${l}</option>`)}
        </select>
      </label>
      <label class="ctl" title="Sort">${icons.sliders}<span class="lab">Sort</span>
        <select aria-label="Sort by" .value=${p.sort} @change=${(e: Event) => this.setPrefs({ sort: (e.target as HTMLSelectElement).value as SortKey })}>
          <option value="modified" ?selected=${p.sort === "modified"}>Date</option>
          <option value="name" ?selected=${p.sort === "name"}>Name</option>
          <option value="size" ?selected=${p.sort === "size"}>Size</option>
          <option value="type" ?selected=${p.sort === "type"}>Type</option>
        </select>
      </label>
      <button class="ib" aria-label=${p.asc ? "Ascending" : "Descending"} title=${p.asc ? "Ascending" : "Descending"} @click=${() => this.setPrefs({ asc: !p.asc })}>${p.asc ? icons.arrowUp : icons.arrowDown}</button>
      <span class="sp"></span>
      ${this.enriching > 0 ? html`<span class="enrich">${icons.loader}Reading tags…</span>` : nothing}
      <span class="count">${shown === total ? `${total} items` : `${shown} of ${total}`}</span>
      <div class="seg" role="group" aria-label="View">
        ${views.map(([v, ic, l]) => html`<button aria-pressed=${String(p.view === v)} data-testid="fb-view-${v}" title="${l} view" aria-label="${l} view" @click=${() => this.setPrefs({ view: v })}>${ic}</button>`)}
      </div>
    </div>`;
  }

  private renderChips() {
    const p = this.prefs;
    const types: Array<[FileKind, string, unknown]> = [
      ["image", "Images", icons.image],
      ["video", "Videos", icons.video],
      ["document", "Documents", icons.fileText],
      ["other", "Other", icons.layers],
    ];
    const sts: Array<[AnalysisStatus, string]> = [
      ["done", "Analysed"],
      ["pending", "In progress"],
      ["failed", "Failed"],
      ["none", "Not analysed"],
    ];
    const any = p.types.length || p.statuses.length || p.hasFindings;
    return html`<div class="chips" role="group" aria-label="Filters" data-testid="fb-filters">
      <span class="lbl">${icons.filter}</span>
      ${types.map(([k, l, ic]) => html`<button class="chip" aria-pressed=${String(p.types.includes(k))} @click=${() => this.setPrefs({ types: this.toggleIn(p.types, k) })}>${ic}${l}</button>`)}
      <span class="div"></span>
      ${sts.map(([k, l]) => html`<button class="chip" aria-pressed=${String(p.statuses.includes(k))} @click=${() => this.setPrefs({ statuses: this.toggleIn(p.statuses, k) })}>${l}</button>`)}
      <span class="div"></span>
      <button class="chip" aria-pressed=${String(p.hasFindings)} @click=${() => this.setPrefs({ hasFindings: !p.hasFindings })}>${icons.sparkles}Has findings</button>
      ${any ? html`<button class="chip clear" @click=${() => this.setPrefs({ types: [], statuses: [], hasFindings: false })}>${icons.x}Clear</button>` : nothing}
    </div>`;
  }

  private renderItems(list: BrowserItem[], visible: BrowserItem[]) {
    const v = this.prefs.view;
    if (v === "list") return html`<div class="list" role="listbox">${list.map((it) => this.renderRow(it, visible))}</div>`;
    return html`<div class=${v === "gallery" ? "gallery" : "grid"} role="listbox">${list.map((it) => this.renderCard(it, visible, v === "gallery"))}</div>`;
  }

  render() {
    void this.enrichTick;
    const p = this.prefs;
    const filtered = filterBrowserItems(this.items, p, this.cache);
    const sorted = sortBrowserItems(filtered, p.sort, p.asc);
    const groups = groupBrowserItems(sorted, p.groupBy, { enrich: this.cache, projectNames: this.projectNames, tagSource: this.tagSource });
    // Viewer order follows the grouped display order (collapsed groups excluded).
    const visible = groups.filter((g) => !p.collapsed.includes(g.id)).flatMap((g) => g.items);
    const uniqueVisible = [...new Set(visible)];
    this.visibleOrder = p.groupBy === "none" ? sorted : uniqueVisible;
    return html`
      ${this.renderToolbar(filtered.length, this.items.length)}
      ${this.renderChips()}
      <div class="scroll" data-testid="fb-scroll">
        ${p.view === "list" ? html`<div class="lh"><span>${this.sortHead("name", "Name")}</span><span>Status</span><span>${this.sortHead("size", "Size")}</span><span>${this.sortHead("modified", "Modified")}</span><span>${this.sortHead("type", "Type")}</span></div>` : nothing}
        ${this.loading && !this.items.length
          ? html`<div class="grid">${[0, 1, 2, 3, 4, 5].map(() => html`<div class="skel"></div>`)}</div>`
          : !this.items.length
            ? html`<div class="empty"><span class="big">${this.lane === "secure" ? icons.lock : icons.folder}</span><b>${this.emptyTitle}</b><span>${this.emptyBody}</span>${this.emptyHint}</div>`
            : !filtered.length
              ? html`<div class="empty"><span class="big">${icons.filter}</span><b>No files match these filters</b><button class="chip clear" @click=${() => this.setPrefs({ types: [], statuses: [], hasFindings: false })}>${icons.x}Clear filters</button></div>`
              : p.groupBy === "none"
                ? this.renderItems(sorted, uniqueVisible)
                : groups.map((g) => {
                    const open = !p.collapsed.includes(g.id);
                    const ic = (icons as Record<string, unknown>)[g.icon] ?? icons.layers;
                    return html`<section class="group" data-testid="fb-group-section">
                      <button class="gh" aria-expanded=${String(open)} data-testid="fb-group-head" @click=${() => this.setPrefs({ collapsed: open ? [...p.collapsed, g.id] : p.collapsed.filter((x) => x !== g.id) })}>
                        <span class="chev">${icons.chevronDown}</span><span class="gi">${ic}</span>${g.label}<span class="n">${g.items.length}</span><span class="line"></span>
                      </button>
                      ${open ? this.renderItems(g.items, uniqueVisible) : nothing}
                    </section>`;
                  })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-file-browser": FileBrowser;
    "ib-file-thumb": FileThumb;
  }
}
