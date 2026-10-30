/**
 * <review-mesh-panel> — glass side panel for the visible review on /mesh.
 *
 *   mode "threads": recent review threads → one full worker ↔ Auditor thread
 *                   (Replay re-animates it on the map).
 *   mode "gallery": screenshot gallery grouped by run, with filters, search,
 *                   a lightbox (zoom, before/after compare, vision assessment),
 *                   links to the review thread / run and a download link.
 *
 * Right-side panel on desktop, full-width bottom sheet on phones.
 *
 * Events (bubbling, composed):
 *   review-panel-close
 *   review-replay      {runId}     (re-emitted from <review-thread-view>)
 *   review-open-run    {runId}
 */

import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { icons } from "../icons";
import "./review-thread-view";
import { gatewayUrl, screenshotFullUrl, screenshotThumbUrl, type ReviewFeed } from "../lib/review-mesh/feed";
import {
  TONE_CSS,
  distinctValues,
  filterScreenshots,
  groupScreenshotsByRun,
  needsOwner,
  packetTone,
  relativeTime,
  verdictLabel,
  verdictTone,
  type GalleryFilter,
  type StoredThread,
} from "../lib/review-mesh/model";
import type { ScreenshotEntry } from "../lib/review-mesh/types";
import {
  DEPLOY_TEXT,
  VERDICT_TEXT,
  VERDICT_TONE,
  buildCompletedEntries,
  formatDuration,
} from "../lib/review-mesh/completed";

export type ReviewPanelMode = "threads" | "gallery";

const RANGE_MS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 };

@customElement("review-mesh-panel")
export class ReviewMeshPanel extends LitElement {
  @property({ attribute: false }) feed: ReviewFeed | null = null;
  @property({ type: String, reflect: true }) mode: ReviewPanelMode = "threads";
  @property({ type: String }) runId = "";
  @property({ type: String }) focusId = "";
  @property({ type: String }) shotId = "";

  @state() private filter: GalleryFilter & { range: string } = { verdict: "all", range: "any" };
  @state() private zoomed = false;
  @state() private compare = false;
  @state() private compareAt = 50;
  @state() private loadingMore = false;
  @state() private cursor: string | null | undefined = undefined;
  private unsub: (() => void) | null = null;
  private boundFeed: ReviewFeed | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  static styles = css`
    :host {
      position: absolute;
      top: 12px;
      right: 12px;
      bottom: 12px;
      z-index: 70;
      width: min(440px, calc(100% - 24px));
      display: flex;
      flex-direction: column;
      color: var(--g-fg, #e8e6e3);
      font-family: var(--g-font-family, ui-sans-serif, system-ui, sans-serif);
      font-size: 12.5px;
      /* Dense text: near-opaque glass so the map never reads through. */
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #d4af37) 6%, transparent), transparent 120px),
        color-mix(in srgb, var(--g-bg, #0a0c14) 96%, transparent);
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: var(--g-radius-lg, 14px);
      box-shadow: var(--g-shadow-lg, 0 18px 60px rgba(0, 0, 0, 0.55)), inset 0 1px 0 var(--g-edge-light, rgba(255, 255, 255, 0.06));
      -webkit-backdrop-filter: blur(var(--g-blur-heavy, 18px)) saturate(1.2);
      backdrop-filter: blur(var(--g-blur-heavy, 18px)) saturate(1.2);
      overflow: hidden;
      pointer-events: auto;
      animation: rmp-in 180ms ease-out;
    }
    :host([mode="gallery"]) {
      width: min(880px, calc(100% - 24px));
    }
    @keyframes rmp-in {
      from {
        opacity: 0;
        transform: translateX(14px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      :host {
        animation: none;
      }
    }
    @media (max-width: 600px) {
      :host,
      :host([mode="gallery"]) {
        top: auto;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100%;
        max-height: 80%;
        height: 80%;
        border-radius: 16px 16px 0 0;
        border-bottom: 0;
        animation-name: rmp-up;
      }
      @keyframes rmp-up {
        from {
          transform: translateY(24px);
          opacity: 0;
        }
        to {
          transform: none;
          opacity: 1;
        }
      }
    }
    .grab {
      display: none;
    }
    @media (max-width: 600px) {
      .h-sub {
        display: none;
      }
    }
    @media (max-width: 600px) {
      .grab {
        display: block;
        width: 38px;
        height: 4px;
        border-radius: 99px;
        background: var(--g-border-strong, rgba(255, 255, 255, 0.25));
        margin: 7px auto 0;
      }
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      flex: none;
    }
    .h-icon {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 8px;
      color: var(--g-primary, #d4af37);
      background: color-mix(in srgb, var(--g-primary, #d4af37) 16%, transparent);
      flex: none;
    }
    .h-title {
      font-weight: 700;
      font-size: 13px;
      line-height: 1.15;
    }
    .h-sub {
      font-size: 10.5px;
      color: var(--g-fg-dim, #9aa2b1);
    }
    .tabs {
      margin-left: auto;
      display: inline-flex;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: 9px;
      overflow: hidden;
      flex: none;
    }
    .tabs button {
      all: unset;
      cursor: pointer;
      padding: 5px 10px;
      font-size: 11.5px;
      color: var(--g-fg-dim, #9aa2b1);
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .tabs button[aria-selected="true"] {
      color: var(--g-primary, #d4af37);
      background: color-mix(in srgb, var(--g-primary, #d4af37) 14%, transparent);
    }
    .tabs button:focus-visible {
      outline: 2px solid var(--g-primary, #d4af37);
      outline-offset: -2px;
    }
    .tabs svg,
    .icon-btn svg,
    .btn svg {
      width: 13px;
      height: 13px;
    }
    .icon-btn {
      all: unset;
      cursor: pointer;
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border-radius: 8px;
      color: var(--g-fg-dim, #9aa2b1);
      flex: none;
    }
    .icon-btn:hover,
    .icon-btn:focus-visible {
      color: var(--g-fg, #fff);
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.08));
    }
    .body {
      flex: 1 1 auto;
      overflow: auto;
      padding: 12px;
      min-height: 0;
      overscroll-behavior: contain;
    }
    .list {
      display: grid;
      gap: 6px;
    }
    .item {
      all: unset;
      cursor: pointer;
      display: grid;
      grid-template-columns: 10px 1fr auto;
      align-items: center;
      gap: 4px 10px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.08));
      background: var(--g-surface, rgba(255, 255, 255, 0.03));
    }
    .item:hover,
    .item:focus-visible {
      border-color: color-mix(in srgb, var(--g-primary, #d4af37) 55%, transparent);
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.06));
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--tone);
      box-shadow: 0 0 8px var(--tone);
      grid-row: span 2;
    }
    .item__label {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .item__last {
      grid-column: 2 / span 2;
      color: var(--g-fg-dim, #9aa2b1);
      font-size: 11.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 1px 7px;
      border-radius: 999px;
      border: 1px solid currentColor;
      white-space: nowrap;
    }
    .attn {
      color: #e879f9;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .empty {
      color: var(--g-fg-dim, #9aa2b1);
      padding: 20px 4px;
      text-align: center;
      line-height: 1.5;
    }
    .sub-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .btn {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 10px;
      border-radius: 8px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      font-size: 11.5px;
      color: var(--g-fg, #e8e6e3);
      white-space: nowrap;
      min-height: 20px;
    }
    .btn:hover,
    .btn:focus-visible {
      border-color: var(--g-primary, #d4af37);
      color: var(--g-primary, #d4af37);
    }
    a.btn {
      text-decoration: none;
    }
    .btn[aria-pressed="true"] {
      color: var(--g-primary, #d4af37);
      border-color: var(--g-primary, #d4af37);
      background: color-mix(in srgb, var(--g-primary, #d4af37) 14%, transparent);
    }
    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .section-label {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #9aa2b1);
      margin: 2px 0 8px;
    }
    .run {
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      border-left: 3px solid var(--tone);
      border-radius: 10px;
      padding: 8px 10px;
      margin-bottom: 12px;
      background: color-mix(in srgb, var(--tone) 6%, var(--g-surface, rgba(255, 255, 255, 0.03)));
      display: grid;
      gap: 5px;
    }
    .run__top {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .run__sum {
      line-height: 1.4;
    }
    .run__stats {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      color: var(--g-fg-dim, #9aa2b1);
      font-size: 11px;
      align-items: center;
    }
    .run__stats span,
    .linkish {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .run__stats svg {
      width: 12px;
      height: 12px;
    }
    .linkish {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--g-primary, #d4af37);
    }
    .linkish:hover,
    .linkish:focus-visible {
      text-decoration: underline;
    }
    /* Gallery */
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    .filters select,
    .filters input {
      font: inherit;
      font-size: 11.5px;
      color: var(--g-fg, #e8e6e3);
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      border-radius: 8px;
      padding: 5px 8px;
      min-height: 30px;
      max-width: 100%;
    }
    .filters select option {
      color: #111;
    }
    .filters .search {
      flex: 1 1 160px;
      display: flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      border-radius: 8px;
      padding: 0 8px;
      background: var(--g-surface, rgba(255, 255, 255, 0.04));
      color: var(--g-fg-dim, #9aa2b1);
    }
    .filters .search svg {
      width: 13px;
      height: 13px;
      flex: none;
    }
    .filters .search input {
      border: 0;
      background: transparent;
      flex: 1;
      min-width: 0;
      padding-left: 0;
      outline: none;
    }
    .group {
      margin-bottom: 16px;
    }
    .group__h {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .group__t {
      font-weight: 600;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1 1 auto;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 8px;
    }
    @media (max-width: 600px) {
      .grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .card {
      all: unset;
      cursor: zoom-in;
      display: block;
      border-radius: 9px;
      overflow: hidden;
      border: 2px solid var(--b);
      background: rgba(0, 0, 0, 0.35);
      min-width: 0;
    }
    .card:focus-visible {
      outline: 2px solid var(--g-primary, #d4af37);
      outline-offset: 1px;
    }
    .card img {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 10;
      object-fit: cover;
      background: #0b0d14;
    }
    .card__meta {
      padding: 4px 7px 5px;
      font-size: 10.5px;
      color: var(--g-fg-dim, #b9bfca);
      display: flex;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }
    .card__meta span:first-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }
    .vd {
      font-size: 9.5px;
      font-weight: 800;
      text-transform: uppercase;
      color: var(--b);
    }
    /* Lightbox */
    .lb {
      position: absolute;
      inset: 0;
      z-index: 5;
      display: flex;
      flex-direction: column;
      /* Solid underlay: --g-bg can be translucent under glass themes. */
      background: linear-gradient(var(--g-bg, #07080d), var(--g-bg, #07080d)), #07080d;
    }
    .lb__bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      flex-wrap: wrap;
    }
    .lb__title {
      font-weight: 600;
      flex: 1 1 140px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lb__stage {
      flex: 1 1 auto;
      position: relative;
      overflow: auto;
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 10px;
    }
    .lb__stage img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      cursor: zoom-in;
      border-radius: 6px;
    }
    .lb__stage.zoomed {
      place-items: start;
    }
    .lb__stage.zoomed img {
      width: 200%;
      height: auto;
      cursor: zoom-out;
    }
    .cmp {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 6px;
      overflow: hidden;
    }
    .cmp img {
      cursor: default;
      position: absolute;
      inset: 0;
    }
    .cmp .line {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--g-primary, #d4af37);
      box-shadow: 0 0 8px var(--g-primary, #d4af37);
      pointer-events: none;
    }
    .cmp .lbl {
      position: absolute;
      top: 6px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.7);
      color: #fff;
    }
    .lb__range {
      width: 100%;
      margin: 0;
      accent-color: var(--g-primary, #d4af37);
    }
    .lb__info {
      padding: 10px 12px 12px;
      border-top: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      display: grid;
      gap: 6px;
      max-height: 34%;
      overflow: auto;
      flex: none;
    }
    .lb__info ul {
      margin: 0;
      padding-left: 18px;
    }
    .meta {
      color: var(--g-fg-dim, #9aa2b1);
      font-size: 11px;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bindFeed();
    this.tickTimer = setInterval(() => {
      if (!document.hidden) this.requestUpdate();
    }, 30_000);
    window.addEventListener("keydown", this.onKey);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
    this.boundFeed = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    window.removeEventListener("keydown", this.onKey);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (this.shotId && this.mode === "gallery") {
      this.shotId = "";
      return;
    }
    this.close();
  };

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("feed")) this.bindFeed();
    if ((changed.has("runId") || changed.has("mode")) && this.mode === "threads" && this.runId && this.feed) {
      void this.feed.loadThread(this.runId);
      this.feed.markViewed(this.runId);
    }
    if (changed.has("shotId")) {
      this.zoomed = false;
      this.compare = false;
      this.compareAt = 50;
    }
  }

  private bindFeed(): void {
    if (this.boundFeed === this.feed) return;
    this.unsub?.();
    this.unsub = null;
    this.boundFeed = this.feed;
    if (this.feed) this.unsub = this.feed.on(() => this.requestUpdate());
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private close(): void {
    this.emit("review-panel-close");
  }

  /** Gallery filtered to one run (hover card "Screenshots"). */
  showRunScreenshots(runId: string): void {
    this.mode = "gallery";
    this.shotId = "";
    this.filter = { ...this.filter, runId };
  }

  private openThread(runId: string): void {
    this.mode = "threads";
    this.runId = runId;
    this.focusId = "";
  }

  private shotByPath = (path: string): { thumb: string; full: string } | null => {
    const hit = this.feed?.screenshots.find((s) => s.path === path);
    return hit ? { thumb: gatewayUrl(hit.thumbUrl), full: gatewayUrl(hit.url) } : null;
  };

  private onOpenShotFromThread(e: CustomEvent<{ runId: string; path: string; full: string }>): void {
    const hit = this.feed?.screenshots.find((s) => s.path === e.detail.path);
    this.mode = "gallery";
    if (hit) {
      this.shotId = hit.id;
    } else {
      // Not indexed in the gallery (yet): show it ad hoc.
      this.adhoc = {
        id: `adhoc:${e.detail.path}`,
        path: e.detail.path,
        url: screenshotFullUrl(e.detail.path),
        thumbUrl: screenshotThumbUrl(e.detail.path),
        runId: e.detail.runId,
        label: this.feed?.store.get(e.detail.runId)?.summary.label ?? e.detail.runId,
        agent: "",
        route: null,
        viewport: null,
        theme: null,
        ts: Date.now(),
        verdict: "unknown",
        runState: null,
        runVerdict: null,
        visualDir: null,
        source: "result",
      };
      this.shotId = this.adhoc.id;
    }
  }

  private adhoc: ScreenshotEntry | null = null;

  // ── Render ────────────────────────────────────────────────────────────

  override render() {
    const feed = this.feed;
    const pending = feed?.pendingAttention().length ?? 0;
    return html`
      <div class="grab" aria-hidden="true"></div>
      <header>
        <span class="h-icon">${icons.shield}</span>
        <div style="min-width:0">
          <div class="h-title">${feed?.reviewer.name ?? "Auditor"}</div>
          <div class="h-sub">${feed?.reviewer.title ?? "Verification Reviewer"} · Executive Suite</div>
        </div>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected=${this.mode === "threads"} @click=${() => (this.mode = "threads")}>
            ${icons.messageSquare} Reviews${pending ? html` <span class="attn">${pending}</span>` : nothing}
          </button>
          <button role="tab" aria-selected=${this.mode === "gallery"} @click=${() => (this.mode = "gallery")}>
            ${icons.camera} Screenshots
          </button>
        </div>
        <button class="icon-btn" title="Close" aria-label="Close review panel" @click=${() => this.close()}>${icons.x}</button>
      </header>
      <div class="body">${this.mode === "gallery" ? this.renderGallery() : this.renderThreads()}</div>
      ${this.mode === "gallery" && this.shotId ? this.renderLightbox() : nothing}
    `;
  }

  private renderThreads(): TemplateResult {
    const feed = this.feed;
    if (!feed) return html`<div class="empty">Not connected.</div>`;
    if (this.runId) {
      const t = feed.store.get(this.runId) ?? null;
      return html`
        <div class="sub-head">
          <button class="btn" @click=${() => (this.runId = "")}>${icons.arrowLeft} All reviews</button>
          <span style="flex:1"></span>
          <button class="btn" title="Open the run's detail view" @click=${() => this.emit("review-open-run", { runId: this.runId })}>
            ${icons.externalLink} Open run
          </button>
        </div>
        ${this.renderRunDetails(this.runId)}
        <review-thread-view
          replayable
          .thread=${t}
          .runId=${this.runId}
          .focusId=${this.focusId}
          .resolveShot=${this.shotByPath}
          @review-open-shot=${(e: CustomEvent) => this.onOpenShotFromThread(e)}
        ></review-thread-view>
      `;
    }
    const threads = feed.store.list();
    if (!threads.length) {
      return html`<div class="empty">
        No reviews yet.<br />When a sub-agent finishes, it submits its result to the Auditor here and the conversation plays out on the map.
      </div>`;
    }
    return html`
      <div class="section-label">Recent reviews</div>
      <div class="list">${threads.map((t) => this.renderThreadItem(t))}</div>
    `;
  }

  /** Run details (verdict, timing, files, commits, deploy, summary) above the thread. */
  private renderRunDetails(runId: string): TemplateResult | typeof nothing {
    const feed = this.feed;
    const rec = feed?.completed.find((r) => r.runId === runId);
    if (!feed || !rec) return nothing;
    const [e] = buildCompletedEntries([rec], { now: Date.now(), windowMs: Number.MAX_SAFE_INTEGER, screenshots: feed.screenshots });
    if (!e) return nothing;
    const tone = TONE_CSS[VERDICT_TONE[e.verdict]];
    return html`<div class="run" style="--tone:${tone}">
      <div class="run__top">
        <span class="badge" style="color:${tone}">${VERDICT_TEXT[e.verdict]}</span>
        <span class="meta">${new Date(e.finishedAt).toLocaleTimeString()} · ${formatDuration(e.durationMs)} · ${e.attempts} attempt${e.attempts === 1 ? "" : "s"}</span>
      </div>
      ${e.summary ? html`<div class="run__sum">${e.summary}</div>` : nothing}
      <div class="run__stats">
        <span>${icons.fileText} ${e.files} files</span>
        <span>${icons.check} ${e.commits} commits</span>
        ${e.deploy ? html`<span>${icons.rocket} ${DEPLOY_TEXT[e.deploy]}</span>` : nothing}
        ${e.screenshots ? html`<button class="linkish" @click=${() => {
          this.mode = "gallery";
          this.filter = { ...this.filter, runId };
        }}>${icons.camera} ${e.screenshots} screenshots</button>` : nothing}
        ${e.backend ? html`<span>${e.backend}</span>` : nothing}
      </div>
    </div>`;
  }

  private renderThreadItem(t: StoredThread): TemplateResult {
    const s = t.summary;
    const attention = this.feed?.isAttentionPending(s.runId) ?? false;
    const tone = TONE_CSS[s.verdict ? verdictTone(s.verdict) : needsOwner(s) ? "magenta" : s.lastKind ? packetTone({ kind: s.lastKind }) : "slate"];
    return html`
      <button class="item" style="--tone:${tone}" @click=${() => this.openThread(s.runId)} data-run-id=${s.runId}>
        <span class="dot"></span>
        <span class="item__label" title=${s.label}>${s.label || s.runId}</span>
        <span style="display:inline-flex;gap:6px;align-items:center">
          ${attention ? html`<span class="attn badge">${icons.alert} Owner</span>` : nothing}
          <span class="badge" style="color:${tone}">${s.verdict ? verdictLabel(s.verdict) : needsOwner(s) ? "Owner decision" : "In review"}</span>
        </span>
        <span class="item__last">${s.lastTitle || "…"} · ${relativeTime(s.lastTs, Date.now())} · ${s.messageCount} msgs</span>
      </button>
    `;
  }

  private galleryItems(): ScreenshotEntry[] {
    const f = this.filter;
    const since = f.range in RANGE_MS ? Date.now() - RANGE_MS[f.range] : undefined;
    return filterScreenshots(this.feed?.screenshots ?? [], { ...f, since });
  }

  private setFilter(patch: Partial<GalleryFilter & { range: string }>): void {
    this.filter = { ...this.filter, ...patch };
  }

  private async loadMore(): Promise<void> {
    const feed = this.feed;
    if (!feed || this.loadingMore) return;
    this.loadingMore = true;
    try {
      const page = await feed.queryScreenshots({ limit: 48, cursor: this.cursor ?? null });
      if (page) {
        feed.ingestScreenshots(page.items, false);
        this.cursor = page.nextCursor;
      } else {
        this.cursor = null;
      }
    } finally {
      this.loadingMore = false;
    }
  }

  private renderGallery(): TemplateResult {
    const all = this.feed?.screenshots ?? [];
    const items = this.galleryItems();
    const groups = groupScreenshotsByRun(items);
    const f = this.filter;
    const sel = (key: "route" | "viewport" | "agent", label: string) => {
      const vals = distinctValues(all, key);
      return html`<select aria-label=${label} @change=${(e: Event) => this.setFilter({ [key]: (e.target as HTMLSelectElement).value || undefined })}>
        <option value="">${label}: all</option>
        ${vals.map((v) => html`<option value=${v} ?selected=${f[key] === v}>${key === "agent" ? v.split(":").pop() : v}</option>`)}
      </select>`;
    };
    return html`
      <div class="filters">
        <div class="search">
          ${icons.search}
          <input
            type="search"
            placeholder="Search label, route, issues…"
            aria-label="Search screenshots"
            .value=${f.q ?? ""}
            @input=${(e: Event) => this.setFilter({ q: (e.target as HTMLInputElement).value })}
          />
        </div>
        <select aria-label="Verdict" @change=${(e: Event) => this.setFilter({ verdict: (e.target as HTMLSelectElement).value as GalleryFilter["verdict"] })}>
          <option value="all">Verdict: all</option>
          <option value="pass" ?selected=${f.verdict === "pass"}>Pass</option>
          <option value="fail" ?selected=${f.verdict === "fail"}>Fail</option>
        </select>
        <select aria-label="Date range" @change=${(e: Event) => this.setFilter({ range: (e.target as HTMLSelectElement).value })}>
          <option value="any">Any time</option>
          <option value="1h" ?selected=${f.range === "1h"}>Last hour</option>
          <option value="24h" ?selected=${f.range === "24h"}>Last 24h</option>
          <option value="7d" ?selected=${f.range === "7d"}>Last 7 days</option>
        </select>
        ${sel("route", "Route")} ${sel("viewport", "Viewport")} ${sel("agent", "Agent")}
        ${f.runId
          ? html`<button class="btn" title="Clear the run filter" @click=${() => this.setFilter({ runId: undefined })}>
              ${icons.x} Run: ${this.feed?.store.get(f.runId)?.summary.label ?? f.runId}
            </button>`
          : nothing}
      </div>
      ${groups.length === 0
        ? html`<div class="empty">${all.length ? "No screenshots match these filters." : "No UI screenshots yet. Visual checks from UI tasks show up here."}</div>`
        : groups.map(
            (g) => html`<section class="group">
              <div class="group__h">
                <span class="group__t" title=${g.label}>${g.label}</span>
                ${g.pass ? html`<span class="badge" style="color:${TONE_CSS.green}">${g.pass} pass</span>` : nothing}
                ${g.fail ? html`<span class="badge" style="color:${TONE_CSS.red}">${g.fail} fail</span>` : nothing}
                <span class="meta">${relativeTime(g.ts, Date.now())}</span>
                <button class="btn" @click=${() => this.openThread(g.runId)}>${icons.messageSquare} Thread</button>
              </div>
              <div class="grid">
                ${g.items.map((s) => {
                  const b = s.verdict === "pass" ? TONE_CSS.green : s.verdict === "fail" ? TONE_CSS.red : TONE_CSS.slate;
                  return html`<button class="card" style="--b:${b}" title=${`${s.label} ${s.route ?? ""} ${s.viewport ?? ""}`} @click=${() => (this.shotId = s.id)} data-shot-id=${s.id}>
                    <img src=${gatewayUrl(s.thumbUrl)} alt=${`${s.label} ${s.route ?? ""}`} loading="lazy" decoding="async" />
                    <div class="card__meta">
                      <span>${[s.route, s.viewport, s.theme].filter(Boolean).join(" · ") || s.label}</span>
                      <span class="vd">${s.verdict === "unknown" ? "" : s.verdict}</span>
                    </div>
                  </button>`;
                })}
              </div>
            </section>`,
          )}
      ${this.feed && this.cursor !== null && all.length >= 48
        ? html`<div style="text-align:center"><button class="btn" ?disabled=${this.loadingMore} @click=${() => void this.loadMore()}>${this.loadingMore ? "Loading…" : "Load more"}</button></div>`
        : nothing}
    `;
  }

  private renderLightbox(): TemplateResult {
    const s = this.feed?.screenshots.find((x) => x.id === this.shotId) ?? (this.adhoc?.id === this.shotId ? this.adhoc : null);
    if (!s) return html``;
    const full = gatewayUrl(s.url);
    const base = s.baselineUrl ? gatewayUrl(s.baselineUrl) : "";
    const bits = [s.route, s.viewport, s.theme].filter(Boolean).join(" · ");
    const b = s.verdict === "pass" ? TONE_CSS.green : s.verdict === "fail" ? TONE_CSS.red : TONE_CSS.slate;
    return html`
      <div class="lb" role="dialog" aria-label="Screenshot viewer">
        <div class="lb__bar">
          <button class="icon-btn" title="Back to gallery" aria-label="Back to gallery" @click=${() => (this.shotId = "")}>${icons.arrowLeft}</button>
          <span class="lb__title" title=${s.label}>${s.label}${bits ? html` <span class="meta">${bits}</span>` : nothing}</span>
          <span class="badge" style="color:${b}">${s.verdict}</span>
          ${base
            ? html`<button class="btn" aria-pressed=${this.compare} @click=${() => {
                this.compare = !this.compare;
                this.zoomed = false;
              }}>${icons.columns} Before / after</button>`
            : nothing}
          <button class="btn" @click=${() => (this.zoomed = !this.zoomed)} ?disabled=${this.compare}>${this.zoomed ? icons.zoomOut : icons.zoomIn} ${this.zoomed ? "Fit" : "Zoom"}</button>
          <button class="btn" @click=${() => this.openThread(s.runId)}>${icons.messageSquare} Thread</button>
          <button class="btn" @click=${() => this.emit("review-open-run", { runId: s.runId })}>${icons.externalLink} Run</button>
          <a class="btn" href=${full} download target="_blank" rel="noopener">${icons.download} Download</a>
        </div>
        <div class="lb__stage ${this.zoomed ? "zoomed" : ""}">
          ${this.compare && base
            ? html`<div class="cmp">
                  <img src=${base} alt="Before" />
                  <img class="after" src=${full} alt="After" style="clip-path: inset(0 0 0 ${this.compareAt}%)" />
                  <span class="line" style="left:${this.compareAt}%"></span>
                  <span class="lbl" style="left:6px">Before</span>
                  <span class="lbl" style="right:6px">After</span>
                </div>`
            : html`<img src=${full} alt=${s.label} @click=${() => (this.zoomed = !this.zoomed)} />`}
        </div>
        ${this.compare && base
          ? html`<div style="padding:0 12px 8px"><input class="lb__range" type="range" min="0" max="100" .value=${String(this.compareAt)} aria-label="Before / after split" @input=${(e: Event) => (this.compareAt = Number((e.target as HTMLInputElement).value))} /></div>`
          : nothing}
        <div class="lb__info">
          ${s.assessment
            ? html`<div><b>Vision check:</b> ${s.assessment.pass === true ? html`<span style="color:${TONE_CSS.green}">pass</span>` : s.assessment.pass === false ? html`<span style="color:${TONE_CSS.red}">fail</span>` : "n/a"} · ${s.assessment.summary}</div>
                ${s.assessment.issues?.length ? html`<ul>${s.assessment.issues.map((i) => html`<li>${i}</li>`)}</ul>` : nothing}`
            : html`<div class="meta">No vision assessment recorded for this screenshot.</div>`}
          <div class="meta">${s.agent ? `${s.agent} · ` : ""}${new Date(s.ts).toLocaleString()} · ${s.source}${s.runVerdict ? ` · run ${s.runVerdict}` : ""}</div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "review-mesh-panel": ReviewMeshPanel;
  }
}
