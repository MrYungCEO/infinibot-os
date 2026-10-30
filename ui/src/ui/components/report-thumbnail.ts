/**
 * <report-thumbnail> — lazy first-page document thumbnail for the Reports gallery.
 *
 * Renders a small preview image of a report's source document, fully client-side
 * (no gateway route / restart required):
 *   • PDF  → pdfjs-dist (dynamically imported) renders page 1 to a canvas, which is
 *            rasterized to a WebP data URL. Bytes come from the existing
 *            `reports.preview({ id, base64:true })` RPC.
 *   • md / docx / pptx / html (anything the parity agent converted) → the markdown
 *            at `markdownPath` is fetched via `files.read`, rendered with the shared
 *            sanitizing markdown renderer, and shown as a scaled live-HTML preview.
 *
 * Generation is deferred until the element scrolls near the viewport
 * (IntersectionObserver) and the resulting raster is cached in IndexedDB keyed by a
 * content hash (id + file size + render time) so subsequent loads are instant.
 *
 * Emits a `thumb-state` CustomEvent ({ state: 'loading'|'ready'|'empty'|'failed' })
 * so the host card can paint a "missing thumbnail" badge.
 */

import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown/render";

type ThumbState = "idle" | "loading" | "ready" | "empty" | "failed";

// ── Minimal rpc bridge (matches the GatewayBrowserClient.request shape) ───────────
type RpcClient = { request: (method: string, params?: unknown) => Promise<unknown> };

// ── IndexedDB raster cache ────────────────────────────────────────────────────────
const DB_NAME = "infinibot-report-thumbs";
const STORE = "thumbs";
let _dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return _dbPromise;
}

async function cacheGet(key: string): Promise<string | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as string) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function cacheSet(key: string, value: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
  } catch {
    /* best-effort */
  }
}

/** Evict any cached raster whose key shares this report id but a different hash. */
async function cacheEvictStale(reportId: string, keepKey: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const k of req.result as IDBValidKey[]) {
        const key = String(k);
        if (key.startsWith(`${reportId}:`) && key !== keepKey) store.delete(k);
      }
    };
  } catch {
    /* best-effort */
  }
}

// ── pdfjs (lazy, code-split) ──────────────────────────────────────────────────────
let _pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;
async function getPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (_pdfjs) return _pdfjs;
  _pdfjs = (async () => {
    const pdfjs = await import("pdfjs-dist");
    try {
      const Worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?worker")).default;
      pdfjs.GlobalWorkerOptions.workerPort = new Worker();
    } catch {
      /* falls back to fake worker (slower but functional) */
    }
    return pdfjs;
  })();
  return _pdfjs;
}

function isPdf(filePath?: string | null, format?: string | null): boolean {
  if (format) return /pdf/i.test(format);
  return !!filePath && /\.pdf$/i.test(filePath);
}

@customElement("report-thumbnail")
export class ReportThumbnail extends LitElement {
  @property({ attribute: false }) client: RpcClient | null = null;
  @property({ type: String }) reportId = "";
  @property({ type: String }) filePath: string | null = null;
  @property({ type: String }) markdownPath: string | null = null;
  @property({ type: String }) format: string | null = null;
  @property({ type: Number }) fileSize: number | null = null;
  @property({ type: Number }) renderedAt: number | null = null;
  @property({ type: Number }) createdAt: number | null = null;

  @state() private _state: ThumbState = "idle";
  @state() private _dataUrl: string | null = null;
  @state() private _mdHtml: string | null = null;

  private _io: IntersectionObserver | null = null;
  private _started = false;

  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      aspect-ratio: 1 / 1.32;
      overflow: hidden;
      background:
        repeating-linear-gradient(135deg, rgba(255,255,255,0.018) 0 12px, transparent 12px 24px),
        linear-gradient(160deg, rgba(28,28,28,0.9), rgba(12,12,12,0.95));
    }
    .img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
    .md-scale {
      position: absolute; inset: 0; overflow: hidden; background: #faf8f1;
    }
    .md-inner {
      width: 720px; transform-origin: top left; transform: scale(0.5);
      padding: 26px 30px; color: #1a1a1a; font-size: 13px; line-height: 1.5;
      font-family: var(--g-body-family, 'Inter', system-ui, sans-serif);
    }
    .md-inner :is(h1,h2,h3) { color: #111; margin: 0 0 8px; }
    .md-inner h1 { font-size: 22px; }
    .md-inner h2 { font-size: 17px; }
    .md-inner p, .md-inner li { color: #333; }
    .md-inner code { background: #ececec; padding: 1px 4px; border-radius: 3px; }
    .md-inner pre { background: #1e1e1e; color: #eee; padding: 10px; border-radius: 6px; overflow: hidden; }
    .center {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 12px;
    }
    .spin {
      width: 22px; height: 22px; border: 2px solid rgba(212,175,55,0.22);
      border-top-color: #d4af37; border-radius: 50%; animation: tspin 0.8s linear infinite;
    }
    @keyframes tspin { to { transform: rotate(360deg); } }
    .doc-ico { color: rgba(212,175,55,0.32); }
    .lbl { font-size: 10.5px; color: rgba(245,242,232,0.42); letter-spacing: 0.02em; }
    .fade { position: absolute; left: 0; right: 0; bottom: 0; height: 38%;
      background: linear-gradient(0deg, rgba(8,8,8,0.45), transparent); pointer-events: none; }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  `;

  private get _hashKey(): string {
    return `${this.reportId}:${this.fileSize ?? 0}:${Math.round(this.renderedAt ?? this.createdAt ?? 0)}`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void this._begin();
      },
      { rootMargin: "300px 0px" },
    );
    this._io.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._io?.disconnect();
    this._io = null;
  }

  protected updated(changed: PropertyValues): void {
    // If the content hash changed (re-convert / re-render), regenerate.
    if ((changed.has("renderedAt") || changed.has("fileSize")) && this._started) {
      this._started = false;
      this._dataUrl = null;
      this._mdHtml = null;
      this._state = "idle";
      void this._begin();
    }
  }

  private _emit(state: ThumbState): void {
    this._state = state;
    this.dispatchEvent(new CustomEvent("thumb-state", { detail: { state }, bubbles: true, composed: true }));
  }

  private async _begin(): Promise<void> {
    if (this._started || !this.client || !this.reportId) return;
    this._started = true;
    this._emit("loading");

    // 1) cache hit
    const key = this._hashKey;
    const cached = await cacheGet(key);
    if (cached) {
      this._dataUrl = cached;
      this._emit("ready");
      return;
    }

    try {
      if (isPdf(this.filePath, this.format)) {
        await this._renderPdf(key);
      } else if (this.markdownPath) {
        await this._renderMarkdown();
      } else {
        this._emit("empty");
      }
    } catch (err) {
      console.warn("[report-thumbnail] generation failed", this.reportId, err);
      this._emit("failed");
    }
  }

  private async _renderPdf(key: string): Promise<void> {
    const res = (await this.client!.request("reports.preview", {
      id: this.reportId,
      base64: true,
    })) as { base64?: string } | null;
    const b64 = res?.base64;
    if (!b64) {
      this._emit("empty");
      return;
    }
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);

    const pdfjs = await getPdfjs();
    const doc = await pdfjs.getDocument({ data, disableAutoFetch: true, disableStream: true }).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const targetW = 440;
      const scale = targetW / base.width;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
      let url: string;
      try {
        url = canvas.toDataURL("image/webp", 0.82);
        if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/png");
      } catch {
        url = canvas.toDataURL("image/png");
      }
      this._dataUrl = url;
      this._emit("ready");
      void cacheSet(key, url);
      void cacheEvictStale(this.reportId, key);
    } finally {
      void doc.destroy();
    }
  }

  private async _renderMarkdown(): Promise<void> {
    const res = (await this.client!.request("files.read", {
      path: this.markdownPath,
      encoding: "utf-8",
    })) as { content?: string } | null;
    const md = res?.content;
    if (!md || !md.trim()) {
      this._emit("empty");
      return;
    }
    // Cap to the first slice — we only need the first viewport.
    this._mdHtml = toSanitizedMarkdownHtml(md.slice(0, 4000));
    this._emit("ready");
  }

  render() {
    if (this._dataUrl) {
      return html`<img class="img" src=${this._dataUrl} alt="document preview" loading="lazy" /><div class="fade"></div>`;
    }
    if (this._mdHtml) {
      return html`<div class="md-scale"><div class="md-inner">${unsafeHTML(this._mdHtml)}</div></div><div class="fade"></div>`;
    }
    if (this._state === "loading") {
      return html`<div class="center"><div class="spin"></div></div>`;
    }
    if (this._state === "failed") {
      return html`<div class="center">${docIcon()}<span class="lbl">Preview failed</span></div>`;
    }
    if (this._state === "empty") {
      return html`<div class="center">${docIcon()}<span class="lbl">No preview</span></div>`;
    }
    return html`<div class="center">${docIcon()}</div>`;
  }
}

function docIcon() {
  return html`<svg class="doc-ico" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
}

declare global {
  interface HTMLElementTagNameMap {
    "report-thumbnail": ReportThumbnail;
  }
}
