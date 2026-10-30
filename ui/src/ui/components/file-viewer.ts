/**
 * <ib-file-viewer> — full-screen rich file viewer for the Files page.
 *
 * Media on the left (image with zoom/pan, video player, PDF, document
 * preview), the styled <ib-file-analysis> panel on the right (a bottom sheet
 * on phones), prev/next arrows and keyboard navigation (← → Esc + − 0).
 *
 * Media bytes are fetched over RPC into in-memory blob: URLs and revoked on
 * navigation/close; secure files are decrypted on view only and the viewer
 * closes itself the moment Secure Mode locks.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../icons";
import { toSanitizedMarkdownHtml } from "../markdown";
import { loadFileBlob, loadVideoProxy, pauseThumbs, type MediaClient } from "../file-media";
import { type BrowserItem, displayName, isPdfName, itemLabel } from "../files-organize";
import { isSecureModeActive, onSecureChange } from "../secure-mode/store";
import "./file-analysis";

type Stage =
  | { kind: "loading" }
  | { kind: "image"; url: string }
  | { kind: "video"; url: string; proxy: boolean; poster?: string }
  | { kind: "pdf"; url: string }
  | { kind: "markdown"; md: string; source: "file" | "ocr" }
  | { kind: "text"; text: string }
  | { kind: "none"; reason: string };

const TEXT_RE = /\.(txt|md|markdown|json|ya?ml|toml|xml|csv|log|ts|tsx|js|jsx|py|rs|go|sh|sql|css|scss|html?)$/i;
const MAX_INLINE = 50 * 1024 * 1024;

export interface FileViewerHooks {
  onSearch?: (query: string) => void;
  onAskAgent?: (item: BrowserItem, prompt: string) => void;
  onOpenKg?: (item: BrowserItem) => void;
  onDownload?: (item: BrowserItem) => void;
  /** Extra panel content above the analysis (Secure Files: the Organize section). */
  renderPanelTop?: (item: BrowserItem) => unknown;
}

@customElement("ib-file-viewer")
export class FileViewer extends LitElement {
  static styles = css`
    :host { position: fixed; inset: 0; z-index: 2100; display: block; color: var(--wg-fg, #ece8df); --fv-gold: var(--wg-gold, #d9b45a); --fv-gold-hi: var(--wg-gold-hi, #ecd28a); --fv-stroke: var(--glass-stroke, rgba(255,255,255,0.1)); }
    svg { width: 16px; height: 16px; flex: none; }
    .scrim { position: absolute; inset: 0; background: radial-gradient(1200px 700px at 30% 20%, rgba(217,180,90,0.07), transparent 60%), rgba(5, 6, 9, 0.9); animation: fade 0.18s ease; }
    @keyframes fade { from { opacity: 0; } }
    .shell { position: absolute; inset: 18px; display: grid; grid-template-rows: auto minmax(0, 1fr); border-radius: 20px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--fv-gold) 22%, var(--fv-stroke)); background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent 120px), color-mix(in srgb, var(--glass-base, #0f1115) 94%, transparent); box-shadow: 0 30px 90px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05); animation: rise 0.22s cubic-bezier(.2,.8,.2,1); }
    @keyframes rise { from { transform: translateY(10px) scale(0.99); opacity: 0; } }
    header { display: flex; align-items: center; gap: 10px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--fv-stroke); min-width: 0; }
    header .ic { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; color: var(--fv-gold); background: color-mix(in srgb, var(--fv-gold) 10%, transparent); border: 1px solid color-mix(in srgb, var(--fv-gold) 28%, transparent); flex: none; }
    header .nm { min-width: 0; flex: 1; display: grid; }
    header .nm b { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    header .nm small { font-size: 11.5px; color: var(--wg-fg-3, #9a968c); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lock { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 11px; font-weight: 600; color: var(--fv-gold); border: 1px solid color-mix(in srgb, var(--fv-gold) 45%, transparent); background: color-mix(in srgb, var(--fv-gold) 10%, transparent); }
    .lock svg { width: 12px; height: 12px; }
    .count { font: 600 12px var(--font-mono, ui-monospace, monospace); color: var(--wg-fg-3, #9a968c); font-variant-numeric: tabular-nums; }
    .ib { all: unset; cursor: pointer; width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; color: var(--wg-fg-2, #c9c5bb); border: 1px solid transparent; flex: none; }
    .ib:hover { background: rgba(255,255,255,0.07); color: #fff; border-color: var(--fv-stroke); }
    .ib:focus-visible { outline: 2px solid var(--fv-gold); outline-offset: 1px; }
    .ib[disabled] { opacity: 0.35; pointer-events: none; }
    .body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 440px); min-height: 0; }
    .stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: repeating-conic-gradient(rgba(255,255,255,0.018) 0 25%, transparent 0 50%) 0 0 / 22px 22px, #07080b; display: grid; place-items: center; }
    .panel { min-height: 0; overflow: auto; padding: 18px 18px 24px; border-left: 1px solid var(--fv-stroke); background: linear-gradient(180deg, color-mix(in srgb, var(--fv-gold) 4%, transparent), transparent 220px); overscroll-behavior: contain; }
    .handle { display: none; }
    .nav { all: unset; z-index: 3; cursor: pointer; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 50%; color: #fff; background: rgba(10,10,14,0.55); border: 1px solid rgba(255,255,255,0.14); backdrop-filter: blur(6px); box-shadow: 0 6px 20px rgba(0,0,0,0.4); }
    .nav { position: absolute; top: 50%; margin-top: -22px; }
    .nav:hover { background: color-mix(in srgb, var(--fv-gold) 30%, rgba(10,10,14,0.6)); }
    .nav:focus-visible { outline: 2px solid var(--fv-gold); }
    .nav.prev { left: 14px; } .nav.next { right: 14px; }
    .stage.is-pdf .nav { top: auto; bottom: 18px; margin-top: 0; }
    .nav svg { width: 20px; height: 20px; }
    .img-wrap { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: zoom-in; }
    .img-wrap.zoomed { cursor: grab; }
    .img-wrap.dragging { cursor: grabbing; }
    .img-wrap img { position: absolute; left: 50%; top: 50%; max-width: calc(100% - 48px); max-height: calc(100% - 48px); transform-origin: center center; user-select: none; -webkit-user-drag: none; box-shadow: 0 20px 60px rgba(0,0,0,0.55); border-radius: 4px; will-change: transform; }
    .zoombar { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 3; display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 12px; background: rgba(10,10,14,0.66); border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(8px); }
    .zoombar span { min-width: 48px; text-align: center; font: 600 12px var(--font-mono, ui-monospace, monospace); color: var(--wg-fg-2, #ccc); }
    .zoombar .ib { width: 30px; height: 30px; }
    video { position: absolute; left: 16px; top: 34px; width: calc(100% - 32px); height: calc(100% - 52px); object-fit: contain; border-radius: 10px; background: #000; box-shadow: 0 20px 60px rgba(0,0,0,0.55); }
    .poster { position: absolute; left: 16px; top: 34px; width: calc(100% - 32px); height: calc(100% - 100px); object-fit: contain; pointer-events: none; border-radius: 10px; }
    .vnote { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); font-size: 11px; color: var(--wg-fg-3, #999); background: rgba(0,0,0,0.5); padding: 3px 10px; border-radius: 999px; }
    iframe.pdf { width: 100%; height: 100%; border: 0; background: #2a2b30; }
    .doc { position: absolute; inset: 0; overflow: auto; padding: 28px 20px 60px; }
    .sheet { max-width: 820px; margin: 0 auto; padding: 40px 48px; border-radius: 6px; background: #f6f3ec; color: #22201c; box-shadow: 0 20px 60px rgba(0,0,0,0.5); font-size: 14px; line-height: 1.65; overflow-wrap: anywhere; }
    .sheet .src { display: flex; align-items: center; gap: 6px; margin: -18px 0 18px; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #8a7a52; }
    .sheet .src svg { width: 13px; height: 13px; }
    .sheet h1, .sheet h2, .sheet h3 { color: #14120f; line-height: 1.25; }
    .sheet table { border-collapse: collapse; width: 100%; font-size: 12.5px; display: block; overflow-x: auto; }
    .sheet th, .sheet td { border: 1px solid #d8d1c0; padding: 6px 8px; text-align: left; vertical-align: top; }
    .sheet th { background: #ece5d3; }
    .sheet pre { white-space: pre-wrap; font-size: 12.5px; }
    .sheet.mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; white-space: pre-wrap; }
    .none { display: grid; justify-items: center; gap: 12px; text-align: center; padding: 30px; color: var(--wg-fg-3, #9a968c); max-width: 380px; }
    .none .big { width: 72px; height: 72px; display: grid; place-items: center; border-radius: 20px; color: var(--fv-gold); background: color-mix(in srgb, var(--fv-gold) 9%, transparent); border: 1px solid color-mix(in srgb, var(--fv-gold) 30%, transparent); }
    .none .big svg { width: 32px; height: 32px; }
    .none b { color: var(--wg-fg, #eee); font-size: 15px; }
    .btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 10px; font-size: 12.5px; font-weight: 600; color: #1a1406; background: linear-gradient(180deg, var(--fv-gold-hi), var(--fv-gold)); }
    .spin { width: 34px; height: 34px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--fv-gold); animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 1100px) { .body { grid-template-columns: minmax(0, 1fr) 360px; } }
    @media (max-width: 760px) {
      .shell { inset: 0; border-radius: 0; border: 0; }
      header { padding: 8px 8px 8px 12px; }
      header .count { display: none; }
      .body { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr); position: relative; }
      .stage { height: 100%; }
      .panel {
        position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; box-sizing: border-box; max-height: var(--sheet-h, 52%); padding: 6px 16px 28px;
        border-left: 0; border-top: 1px solid color-mix(in srgb, var(--fv-gold) 30%, var(--fv-stroke)); border-radius: 20px 20px 0 0;
        background: linear-gradient(180deg, color-mix(in srgb, var(--fv-gold) 5%, #101216), #0d0f13 200px); box-shadow: 0 -18px 50px rgba(0,0,0,0.55);
        transition: max-height 0.25s ease;
      }
      .panel.expanded { --sheet-h: 86%; }
      .handle { all: unset; cursor: pointer; display: grid; place-items: center; width: 100%; height: 22px; position: sticky; top: -6px; z-index: 2; background: inherit; }
      .handle i { width: 42px; height: 5px; border-radius: 5px; background: rgba(255,255,255,0.25); }
      .stage-inner { position: absolute; left: 0; right: 0; top: 0; bottom: calc(52% + 14px); display: grid; place-items: center; }
      .poster { position: absolute; left: 16px; top: 34px; width: calc(100% - 32px); height: calc(100% - 100px); object-fit: contain; pointer-events: none; border-radius: 10px; }
    .vnote { display: none; }
      video { top: 8px; height: calc(100% - 16px); }
      .poster { top: 8px; height: calc(100% - 64px); }
      .nav { top: 26%; width: 38px; height: 38px; margin-top: -19px; }
      .nav.prev { left: 8px; } .nav.next { right: 8px; }
      .stage.is-pdf .nav { top: 26%; bottom: auto; margin-top: -19px; }
      .sheet { padding: 24px 18px; }
      .zoombar { bottom: 10px; }
    }
    @media (min-width: 761px) { .stage-inner { position: absolute; inset: 0; display: grid; place-items: center; } }
    @media (prefers-reduced-motion: reduce) { .scrim, .shell, .spin { animation: none; } }
  `;

  @property({ attribute: false }) client: MediaClient | null = null;
  @property({ attribute: false }) items: BrowserItem[] = [];
  @property({ type: Number }) index = 0;
  @property({ attribute: false }) hooks: FileViewerHooks = {};

  @state() private stage: Stage = { kind: "loading" };
  @state() private scale = 1;
  @state() private tx = 0;
  @state() private ty = 0;
  @state() private dragging = false;
  @state() private sheetExpanded = false;
  @state() private videoTime = 0;
  @state() private videoPainted = false;

  private urls: string[] = [];
  private loadSeq = 0;
  private drag: { x: number; y: number; tx: number; ty: number; id: number } | null = null;
  private pinch: { d: number; scale: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private unsubSecure: (() => void) | null = null;
  private resumeThumbs: (() => void) | null = null;
  private prevFocus: Element | null = null;

  private onKey = (e: KeyboardEvent) => {
    const t = e.composedPath()[0] as HTMLElement | undefined;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (typing) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      this.go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.go(-1);
    } else if (this.stage.kind === "image" && (e.key === "+" || e.key === "=")) {
      this.zoomBy(1.25);
    } else if (this.stage.kind === "image" && e.key === "-") {
      this.zoomBy(0.8);
    } else if (this.stage.kind === "image" && e.key === "0") {
      this.resetZoom();
    }
  };

  get current(): BrowserItem | null {
    return this.items[this.index] ?? null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.prevFocus = document.activeElement;
    window.addEventListener("keydown", this.onKey);
    this.resumeThumbs = pauseThumbs();
    document.documentElement.style.overflow = "hidden";
    this.unsubSecure = onSecureChange(() => {
      if (this.current?.secure && !isSecureModeActive()) this.close();
    });
    void this.loadStage();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
    document.documentElement.style.overflow = "";
    this.unsubSecure?.();
    this.resumeThumbs?.();
    this.revokeAll();
    (this.prevFocus as HTMLElement | null)?.focus?.();
  }

  protected firstUpdated(): void {
    (this.renderRoot.querySelector("button.close") as HTMLElement | null)?.focus();
  }

  close() {
    this.revokeAll();
    this.remove();
  }

  private revokeAll() {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
  }

  private track(url: string): string {
    this.urls.push(url);
    return url;
  }

  go(delta: number) {
    if (this.items.length < 2) return;
    const next = (this.index + delta + this.items.length) % this.items.length;
    this.index = next;
    this.resetZoom();
    this.videoTime = 0;
    this.videoPainted = false;
    void this.loadStage();
  }

  private async loadStage() {
    const it = this.current;
    const client = this.client;
    const seq = ++this.loadSeq;
    this.revokeAll();
    if (!it || !client) return;
    this.stage = { kind: "loading" };
    const set = (s: Stage) => {
      if (seq === this.loadSeq) this.stage = s;
      else if ("url" in s) URL.revokeObjectURL(s.url);
    };
    try {
      if (it.kind === "image") {
        if (/\.(heic|heif|tiff?)$/i.test(it.name)) return set({ kind: "none", reason: "Browsers can't display this image format — the analysis on the right was read from it locally." });
        if (it.size > MAX_INLINE) return set({ kind: "none", reason: "This image is too large to open inline." });
        const b = await loadFileBlob(client, it);
        return set(b ? { kind: "image", url: this.track(b.url) } : { kind: "none", reason: "Couldn't load this image." });
      }
      if (it.kind === "video") {
        let poster: string | undefined;
        if (it.ocrId) {
          const ref = { id: it.ocrId, ...(it.secure ? { secure: true } : {}) };
          const [proxy, frame] = await Promise.all([loadVideoProxy(client, ref).catch(() => null), loadPoster(client, ref)]);
          poster = frame ?? undefined;
          if (proxy) return set({ kind: "video", url: this.track(proxy), proxy: true, poster });
        }
        if (it.size > MAX_INLINE) return set({ kind: "none", reason: "This video is too large to stream inline until the local preview is ready." });
        const b = await loadFileBlob(client, it);
        return set(b ? { kind: "video", url: this.track(b.url), proxy: false, poster } : { kind: "none", reason: "Couldn't load this video." });
      }
      if (isPdfName(it.name)) {
        if (it.size > MAX_INLINE) return set({ kind: "none", reason: "This PDF is too large to open inline." });
        const b = await loadFileBlob(client, it);
        return set(b ? { kind: "pdf", url: this.track(b.url) } : { kind: "none", reason: "Couldn't load this PDF." });
      }
      if (TEXT_RE.test(it.name) && it.size <= 2 * 1024 * 1024) {
        let text: string | null = null;
        if (it.secure) {
          const b = await loadFileBlob(client, it);
          if (b) {
            text = await (await fetch(b.url)).text();
            URL.revokeObjectURL(b.url);
          }
        } else if (it.path) {
          const r = await client.request<{ content: string }>("files.read", { path: it.path });
          text = r?.content ?? "";
        }
        if (text !== null) return set(/\.(md|markdown)$/i.test(it.name) ? { kind: "markdown", md: text, source: "file" } : { kind: "text", text });
      }
      // Office docs & everything else readable: show the locally extracted text as a page.
      const ref = it.secure ? (it.ocrId ? { id: it.ocrId, secure: true } : null) : it.ocrId ? { id: it.ocrId } : it.path ? { path: it.path } : null;
      if (ref) {
        const ctx = await client.request<{ found: boolean; sidecar?: { markdown?: string } | null }>("files.context.get", ref);
        const mdText = ctx?.sidecar?.markdown?.trim();
        if (mdText) return set({ kind: "markdown", md: mdText, source: "ocr" });
      }
      set({ kind: "none", reason: "No inline preview for this file type." });
    } catch (err) {
      set({ kind: "none", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Zoom / pan ────────────────────────────────────────────────────────

  private zoomBy(f: number, cx = 0, cy = 0) {
    const next = Math.max(1, Math.min(8, this.scale * f));
    const k = next / this.scale;
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.scale = next;
    if (next === 1) {
      this.tx = 0;
      this.ty = 0;
    }
  }

  private resetZoom() {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
  }

  private centerOffset(e: { clientX: number; clientY: number }, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const z = parseFloat(getComputedStyle(document.body).zoom || "1") || 1;
    return { x: e.clientX / z - (r.left + r.width / 2), y: e.clientY / z - (r.top + r.height / 2) };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const c = this.centerOffset(e, e.currentTarget as HTMLElement);
    this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, c.x, c.y);
  };

  private onPointerDown = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
      this.drag = null;
      return;
    }
    if (this.scale > 1) {
      this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, id: e.pointerId };
      this.dragging = true;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.scale = Math.max(1, Math.min(8, this.pinch.scale * (d / (this.pinch.d || 1))));
      if (this.scale === 1) this.resetZoom();
      return;
    }
    if (this.drag && this.drag.id === e.pointerId) {
      this.tx = this.drag.tx + (e.clientX - this.drag.x);
      this.ty = this.drag.ty + (e.clientY - this.drag.y);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.drag?.id === e.pointerId) this.drag = null;
    this.dragging = false;
  };

  private onDblClick = (e: MouseEvent) => {
    if (this.scale > 1) this.resetZoom();
    else {
      const c = this.centerOffset(e, e.currentTarget as HTMLElement);
      this.zoomBy(2.5, c.x, c.y);
    }
  };

  // ── Panel events ──────────────────────────────────────────────────────

  private onSeek = (e: Event) => {
    const t = (e as CustomEvent<{ t: number }>).detail?.t;
    const v = this.renderRoot.querySelector("video");
    if (!v || typeof t !== "number") return;
    v.currentTime = Math.max(0, t);
    void v.play().catch(() => {});
    if (matchMedia("(max-width: 760px)").matches) this.sheetExpanded = false;
  };

  private onSearch = (e: Event) => {
    const q = (e as CustomEvent<{ query: string }>).detail?.query;
    if (!q || !this.hooks.onSearch) return;
    this.close();
    this.hooks.onSearch(q);
  };

  private onAskAgent = (e: Event) => {
    const d = (e as CustomEvent<{ item: BrowserItem; prompt: string }>).detail;
    if (!d || !this.hooks.onAskAgent) return;
    this.close();
    this.hooks.onAskAgent(d.item, d.prompt);
  };

  private onOpenKg = (e: Event) => {
    const d = (e as CustomEvent<{ item: BrowserItem }>).detail;
    if (!d || !this.hooks.onOpenKg) return;
    this.close();
    this.hooks.onOpenKg(d.item);
  };

  // ── Render ────────────────────────────────────────────────────────────

  private renderStage() {
    const s = this.stage;
    const it = this.current!;
    switch (s.kind) {
      case "loading":
        return html`<div class="none" aria-busy="true"><div class="spin"></div><span>${it.secure ? "Decrypting in memory…" : "Loading…"}</span></div>`;
      case "image":
        return html`<div
            class="img-wrap ${this.scale > 1 ? "zoomed" : ""} ${this.dragging ? "dragging" : ""}"
            data-testid="fv-image"
            @wheel=${this.onWheel}
            @pointerdown=${this.onPointerDown}
            @pointermove=${this.onPointerMove}
            @pointerup=${this.onPointerUp}
            @pointercancel=${this.onPointerUp}
            @dblclick=${this.onDblClick}
          >
            <img src=${s.url} alt=${it.name} draggable="false" style="transform: translate(calc(-50% + ${this.tx}px), calc(-50% + ${this.ty}px)) scale(${this.scale})" />
          </div>
          <div class="zoombar" role="group" aria-label="Zoom">
            <button class="ib" aria-label="Zoom out" @click=${() => this.zoomBy(0.8)} ?disabled=${this.scale <= 1}>${icons.zoomOut}</button>
            <span>${Math.round(this.scale * 100)}%</span>
            <button class="ib" aria-label="Zoom in" @click=${() => this.zoomBy(1.25)} ?disabled=${this.scale >= 8}>${icons.zoomIn}</button>
            <button class="ib" aria-label="Fit to screen" @click=${() => this.resetZoom()}>${icons.minimize}</button>
          </div>`;
      case "video":
        return html`<video
            data-testid="fv-video"
            src=${s.url}
            poster=${s.poster ?? ""}
            controls
            playsinline
            preload="auto"
            @loadedmetadata=${(e: Event) => {
              const v = e.target as HTMLVideoElement;
              if (v.currentTime === 0) v.currentTime = Math.min(0.1, v.duration || 0);
            }}
            @playing=${() => (this.videoPainted = true)}
            @timeupdate=${(e: Event) => (this.videoTime = (e.target as HTMLVideoElement).currentTime)}
          ></video>
          ${s.poster && !this.videoPainted ? html`<img class="poster" src=${s.poster} alt="" aria-hidden="true" />` : nothing}
          ${s.proxy ? html`<span class="vnote">Local 360p preview · original kept untouched</span>` : nothing}`;
      case "pdf":
        return html`<iframe class="pdf" data-testid="fv-pdf" title=${it.name} src="${s.url}#view=FitH"></iframe>`;
      case "markdown":
        return html`<div class="doc"><article class="sheet" data-testid="fv-doc">
          ${s.source === "ocr" ? html`<div class="src">${icons.scrollText}Read locally from the file</div>` : nothing}
          ${unsafeHTML(toSanitizedMarkdownHtml(s.md))}
        </article></div>`;
      case "text":
        return html`<div class="doc"><article class="sheet mono" data-testid="fv-doc">${s.text}</article></div>`;
      default:
        return html`<div class="none">
          <span class="big">${it.kind === "video" ? icons.video : it.kind === "image" ? icons.image : icons.fileText}</span>
          <b>${displayName(it.name)}</b>
          <span>${s.reason}</span>
          ${this.hooks.onDownload ? html`<button class="btn" @click=${() => this.hooks.onDownload!(it)}>${icons.download}Download</button>` : nothing}
        </div>`;
    }
  }

  render() {
    const it = this.current;
    if (!it) return nothing;
    const many = this.items.length > 1;
    return html`<div class="scrim" @click=${() => this.close()}></div>
      <section class="shell" role="dialog" aria-modal="true" aria-label="File viewer: ${it.name}" data-testid="file-viewer">
        <header>
          <span class="ic">${it.kind === "video" ? icons.video : it.kind === "image" ? icons.image : icons.fileText}</span>
          <div class="nm"><b title=${it.name}>${itemLabel(it)}</b><small>${it.secure ? "Secure vault" : it.path ?? ""}</small></div>
          ${it.secure ? html`<span class="lock" data-testid="fv-lock">${icons.lock}Secure</span>` : nothing}
          ${many ? html`<span class="count">${this.index + 1} / ${this.items.length}</span>` : nothing}
          ${this.hooks.onDownload ? html`<button class="ib" aria-label="Download" title="Download" @click=${() => this.hooks.onDownload!(it)}>${icons.download}</button>` : nothing}
          <button class="ib close" aria-label="Close viewer" title="Close (Esc)" @click=${() => this.close()}>${icons.x}</button>
        </header>
        <div class="body">
          <div class="stage ${this.stage.kind === "pdf" ? "is-pdf" : ""}" aria-label="Preview">
            <div class="stage-inner">${this.renderStage()}</div>
            ${many
              ? html`<button class="nav prev" aria-label="Previous file" title="Previous (←)" @click=${() => this.go(-1)}>${icons.arrowLeft}</button>
                  <button class="nav next" aria-label="Next file" title="Next (→)" @click=${() => this.go(1)}>${icons.arrowRight}</button>`
              : nothing}
          </div>
          <aside
            class="panel ${this.sheetExpanded ? "expanded" : ""}"
            aria-label="Analysis"
            @file-seek=${this.onSeek}
            @file-search=${this.onSearch}
            @file-ask-agent=${this.onAskAgent}
            @file-open-kg=${this.onOpenKg}
          >
            <button class="handle" aria-label=${this.sheetExpanded ? "Collapse details" : "Expand details"} @click=${() => (this.sheetExpanded = !this.sheetExpanded)}><i></i></button>
            ${this.hooks.renderPanelTop ? this.hooks.renderPanelTop(it) : nothing}
            <ib-file-analysis .client=${this.client} .item=${it} .currentTime=${this.videoTime}></ib-file-analysis>
          </aside>
        </div>
      </section>`;
  }
}

/** First scene keyframe of an analysed video (in-memory data: URL) for the poster. */
async function loadPoster(client: MediaClient, ref: Record<string, unknown>): Promise<string | null> {
  try {
    const v = await client.request<{ video?: { keyframes?: Array<{ id: string }> } | null }>("files.video.get", ref);
    const kf = v?.video?.keyframes?.[0];
    if (!kf) return null;
    const f = await client.request<{ found: boolean; mime?: string; content?: string }>("files.video.frame", { ...ref, frame: kf.id });
    return f?.found && f.content ? `data:${f.mime ?? "image/jpeg"};base64,${f.content}` : null;
  } catch {
    return null;
  }
}

export function openFileViewer(opts: { client: MediaClient; items: BrowserItem[]; index: number; hooks?: FileViewerHooks }): FileViewer {
  document.querySelectorAll("ib-file-viewer").forEach((v) => v.remove());
  const el = document.createElement("ib-file-viewer") as FileViewer;
  el.client = opts.client;
  el.items = opts.items.filter((i) => !i.isDirectory);
  const target = opts.items[opts.index];
  el.index = Math.max(0, el.items.indexOf(target));
  el.hooks = opts.hooks ?? {};
  document.body.appendChild(el);
  return el;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-file-viewer": FileViewer;
  }
}
