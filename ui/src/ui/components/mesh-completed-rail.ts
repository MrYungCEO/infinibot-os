/**
 * <mesh-completed-rail> — "Recently completed" dock on the Agent Mesh map.
 *
 * Last ~24h of finished sub-agent runs (verification.list), filterable by
 * verdict group / time window / search. Each card: label, verdict badge,
 * duration, finish time, one-line summary, files changed, commits, deploy
 * state and a screenshot thumbnail for UI tasks. Clicking a card fires
 * `completed-open` {runId, sessionKey}: the mesh flies to the agent and opens
 * its run details + review thread.
 *
 * Desktop: glass dock bottom-right. Phones: a pill that opens a bottom sheet.
 * Reports its height via `rail-height` {px} so the Pixi zoom controls float above it.
 */

import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { icons } from "../icons";
import type { ReviewFeed } from "../lib/review-mesh/feed";
import { gatewayUrl } from "../lib/review-mesh/feed";
import {
  DEPLOY_TEXT,
  VERDICT_TEXT,
  VERDICT_TONE,
  buildCompletedEntries,
  filterCompleted,
  formatDuration,
  type CompletedEntry,
  type CompletedFilter,
} from "../lib/review-mesh/completed";
import { TONE_CSS, relativeTime } from "../lib/review-mesh/model";

const COLLAPSE_KEY = "infinibot.mesh.completedRail.collapsed";
const WINDOWS: Array<[string, number]> = [
  ["24h", 24 * 3_600_000],
  ["6h", 6 * 3_600_000],
  ["1h", 3_600_000],
];
const DEPLOY_TONE: Record<string, string> = {
  live: TONE_CSS.green,
  merged: TONE_CSS.cyan,
  restart_pending: TONE_CSS.amber,
  not_deployed: TONE_CSS.slate,
};

@customElement("mesh-completed-rail")
export class MeshCompletedRail extends LitElement {
  @property({ attribute: false }) feed: ReviewFeed | null = null;
  @state() private filter: CompletedFilter = "all";
  @state() private q = "";
  @state() private windowKey = "24h";
  @state() private collapsed = false;
  @state() private sheetOpen = false;
  @state() private narrow = false;
  private unsub: (() => void) | null = null;
  private ro: ResizeObserver | null = null;
  private mql: MediaQueryList | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  static styles = css`
    :host {
      position: absolute;
      right: 12px;
      bottom: 12px;
      z-index: 32;
      width: min(340px, calc(100% - 24px));
      max-height: min(46%, 440px);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      color: var(--g-fg, #e8e6e3);
      font-family: var(--g-font-family, ui-sans-serif, system-ui, sans-serif);
      font-size: 12px;
    }
    :host([collapsed]) {
      max-height: none;
      width: auto;
    }
    .frame {
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-radius: var(--g-radius-lg, 14px);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 30%, var(--g-border, rgba(255, 255, 255, 0.12)));
      background: linear-gradient(color-mix(in srgb, var(--g-bg, #0a0c14) 95%, transparent), color-mix(in srgb, var(--g-bg, #0a0c14) 95%, transparent)), rgba(8, 9, 14, 0.9);
      box-shadow: var(--g-shadow-lg, 0 16px 48px rgba(0, 0, 0, 0.5)), inset 0 1px 0 var(--g-edge-light, rgba(255, 255, 255, 0.06));
      -webkit-backdrop-filter: blur(var(--g-blur-heavy, 16px)) saturate(1.2);
      backdrop-filter: blur(var(--g-blur-heavy, 16px)) saturate(1.2);
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 10px 8px 12px;
    }
    .title {
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--g-primary, #d4af37);
      white-space: nowrap;
    }
    .count {
      font-size: 10.5px;
      color: var(--g-fg-dim, #9aa2b1);
    }
    .sp {
      flex: 1;
    }
    .icon-btn {
      all: unset;
      cursor: pointer;
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      color: var(--g-fg-dim, #9aa2b1);
    }
    .icon-btn:hover,
    .icon-btn:focus-visible {
      color: var(--g-fg, #fff);
      background: var(--g-surface-hover, rgba(255, 255, 255, 0.08));
    }
    .icon-btn svg {
      width: 14px;
      height: 14px;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      padding: 0 10px 8px;
    }
    .chip {
      all: unset;
      cursor: pointer;
      font-size: 10.5px;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      color: var(--g-fg-dim, #b9bfca);
    }
    .chip[aria-pressed="true"] {
      color: var(--g-primary, #d4af37);
      border-color: color-mix(in srgb, var(--g-primary, #d4af37) 60%, transparent);
      background: color-mix(in srgb, var(--g-primary, #d4af37) 12%, transparent);
    }
    .chip:focus-visible {
      outline: 2px solid var(--g-primary, #d4af37);
    }
    .search {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 1 1 100%;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      border-radius: 8px;
      padding: 0 8px;
      color: var(--g-fg-dim, #9aa2b1);
      background: var(--g-surface, rgba(255, 255, 255, 0.03));
    }
    .search svg {
      width: 12px;
      height: 12px;
      flex: none;
    }
    .search input {
      all: unset;
      flex: 1;
      min-width: 0;
      font-size: 11.5px;
      padding: 5px 0;
      color: var(--g-fg, #e8e6e3);
    }
    .search select {
      font: inherit;
      font-size: 10.5px;
      background: transparent;
      color: var(--g-fg-dim, #b9bfca);
      border: 0;
    }
    .search select option {
      color: #111;
    }
    .list {
      overflow: auto;
      padding: 0 8px 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1 1 auto;
      overscroll-behavior: contain;
      min-height: 0;
      /* Scroll hint: the last card fades out at the bottom edge. */
      -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent);
      mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent);
      padding-bottom: 18px;
    }
    .card {
      all: unset;
      box-sizing: border-box;
      flex: none;
      cursor: pointer;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 8px;
      padding: 8px 9px;
      border-radius: 10px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.08));
      border-left: 3px solid var(--tone);
      background: color-mix(in srgb, var(--tone) 5%, var(--g-surface, rgba(255, 255, 255, 0.03)));
      transition: border-color 120ms ease, background 120ms ease;
    }
    .card:hover,
    .card:focus-visible {
      border-color: color-mix(in srgb, var(--tone) 70%, transparent);
      background: color-mix(in srgb, var(--tone) 10%, var(--g-surface-hover, rgba(255, 255, 255, 0.05)));
      outline: none;
    }
    .c-main {
      min-width: 0;
      display: grid;
      gap: 3px;
    }
    .c-top {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .c-label {
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
    }
    .badge {
      flex: none;
      font-size: 9.5px;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid currentColor;
    }
    .c-sum {
      color: var(--g-fg-dim, #b9bfca);
      font-size: 11px;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .c-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 3px 9px;
      color: var(--g-fg-faint, #8a8f99);
      font-size: 10.5px;
      align-items: center;
    }
    .c-meta span {
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .c-meta svg {
      width: 11px;
      height: 11px;
    }
    .deploy {
      color: var(--d);
      font-weight: 700;
    }
    .thumb {
      width: 64px;
      height: 42px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      background: #0b0d14;
      align-self: start;
    }
    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .empty {
      padding: 14px 10px 16px;
      color: var(--g-fg-dim, #9aa2b1);
      text-align: center;
      font-size: 11.5px;
    }
    .pill {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 45%, transparent);
      background: color-mix(in srgb, var(--g-bg, #0a0c14) 84%, transparent);
      -webkit-backdrop-filter: blur(10px);
      backdrop-filter: blur(10px);
      color: var(--g-primary, #d4af37);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
      min-height: 22px;
    }
    .pill svg {
      width: 13px;
      height: 13px;
    }
    .pill .dot {
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 999px;
      background: var(--g-primary, #d4af37);
      color: #1a1405;
      display: inline-grid;
      place-items: center;
      font-size: 10px;
    }
    /* Phones: pill + bottom sheet */
    :host([narrow]) {
      right: 10px;
      bottom: 10px;
      width: auto;
      max-height: none;
    }
    :host([narrow][sheet]) {
      left: 0;
      right: 0;
      bottom: 0;
      width: 100%;
      max-height: 72%;
      height: 72%;
      z-index: 45;
    }
    :host([narrow][sheet]) .frame {
      height: 100%;
      border-radius: 16px 16px 0 0;
      border-bottom: 0;
    }
    :host([narrow][sheet]) .card {
      min-height: 44px;
    }
    @media (prefers-reduced-motion: reduce) {
      .card {
        transition: none;
      }
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    try {
      this.collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      /* storage blocked */
    }
    this.mql = window.matchMedia?.("(max-width: 600px)") ?? null;
    this.narrow = Boolean(this.mql?.matches);
    this.mql?.addEventListener?.("change", this.onMql);
    this.bindFeed();
    this.tick = setInterval(() => {
      if (!document.hidden) this.requestUpdate();
    }, 30_000);
    this.ro = new ResizeObserver(() => this.reportHeight());
    this.ro.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
    this.mql?.removeEventListener?.("change", this.onMql);
    if (this.tick) clearInterval(this.tick);
    this.ro?.disconnect();
    this.dispatchEvent(new CustomEvent("rail-height", { detail: { px: 0 }, bubbles: true, composed: true }));
  }

  private readonly onMql = (e: MediaQueryListEvent): void => {
    this.narrow = e.matches;
  };

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("feed")) this.bindFeed();
    this.toggleAttribute("collapsed", this.collapsed && !this.narrow);
    this.toggleAttribute("narrow", this.narrow);
    this.toggleAttribute("sheet", this.narrow && this.sheetOpen);
  }

  private bindFeed(): void {
    this.unsub?.();
    this.unsub = this.feed ? this.feed.on((ev) => {
      if (ev.type === "completed" || ev.type === "screenshots" || ev.type === "threads" || ev.type === "thread") this.requestUpdate();
    }) : null;
  }

  private reportHeight(): void {
    const px = this.narrow && !this.sheetOpen ? 0 : Math.ceil(this.getBoundingClientRect().height / (this.zoomFactor() || 1));
    this.dispatchEvent(new CustomEvent("rail-height", { detail: { px: px ? px + 10 : 0 }, bubbles: true, composed: true }));
  }

  /** getBoundingClientRect is in zoomed px under body zoom; report layout px. */
  private zoomFactor(): number {
    const h = this.offsetHeight;
    const r = this.getBoundingClientRect().height;
    return h > 0 && r > 0 ? r / h : 1;
  }

  private setCollapsed(v: boolean): void {
    this.collapsed = v;
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  }

  private entries(): CompletedEntry[] {
    const feed = this.feed;
    if (!feed) return [];
    const now = Date.now();
    const threads = new Map(feed.store.list().map((t) => [t.summary.runId, t.summary]));
    const all = buildCompletedEntries(feed.completed, { now, screenshots: feed.screenshots, threads });
    const win = WINDOWS.find(([k]) => k === this.windowKey)?.[1] ?? WINDOWS[0][1];
    return filterCompleted(all, { filter: this.filter, q: this.q, windowMs: win, now });
  }

  private open(e: CompletedEntry): void {
    if (this.narrow) this.sheetOpen = false;
    this.dispatchEvent(new CustomEvent("completed-open", { detail: { runId: e.runId, sessionKey: e.sessionKey }, bubbles: true, composed: true }));
  }

  private renderCard(e: CompletedEntry, now: number): TemplateResult {
    const tone = TONE_CSS[VERDICT_TONE[e.verdict]];
    return html`
      <button class="card" style="--tone:${tone}" @click=${() => this.open(e)} data-run-id=${e.runId}
        title=${`${e.label}: ${VERDICT_TEXT[e.verdict]}. Fly to the agent and open its review`}>
        <div class="c-main">
          <div class="c-top">
            <span class="c-label">${e.label}</span>
            <span class="badge" style="color:${tone}">${VERDICT_TEXT[e.verdict]}</span>
          </div>
          ${e.summary ? html`<div class="c-sum">${e.summary}</div>` : nothing}
          <div class="c-meta">
            <span title="Finished">${icons.clock}${relativeTime(e.finishedAt, now)}</span>
            <span title="Duration">${formatDuration(e.durationMs)}</span>
            <span title="Files changed">${icons.fileText}${e.files}</span>
            <span title="Commits">${icons.check}${e.commits}</span>
            ${e.deploy ? html`<span class="deploy" style="--d:${DEPLOY_TONE[e.deploy]}">${icons.rocket}${DEPLOY_TEXT[e.deploy]}</span>` : nothing}
            ${e.hasThread ? html`<span title="Review thread">${icons.shield}</span>` : nothing}
          </div>
        </div>
        ${e.thumbUrl ? html`<div class="thumb"><img src=${gatewayUrl(e.thumbUrl)} alt="UI screenshot" loading="lazy" decoding="async" /></div>` : nothing}
      </button>
    `;
  }

  override render() {
    const list = this.entries();
    const now = Date.now();
    if (this.narrow && !this.sheetOpen) {
      return html`<button class="pill" aria-label="Recently completed agents" @click=${() => (this.sheetOpen = true)}>
        ${icons.checkCircle} Completed <span class="dot">${list.length}</span>
      </button>`;
    }
    if (this.collapsed && !this.narrow) {
      return html`<button class="pill" aria-label="Show recently completed agents" @click=${() => this.setCollapsed(false)}>
        ${icons.checkCircle} Recently completed <span class="dot">${list.length}</span>
      </button>`;
    }
    const chip = (f: CompletedFilter, label: string) =>
      html`<button class="chip" aria-pressed=${this.filter === f} @click=${() => (this.filter = f)}>${label}</button>`;
    return html`
      <section class="frame" aria-label="Recently completed agents">
        <header>
          <span class="title">Recently completed</span>
          <span class="count">${list.length}</span>
          <span class="sp"></span>
          <button class="icon-btn" title=${this.narrow ? "Close" : "Collapse"} aria-label=${this.narrow ? "Close" : "Collapse"}
            @click=${() => (this.narrow ? (this.sheetOpen = false) : this.setCollapsed(true))}>
            ${this.narrow ? icons.x : icons.chevronDown}
          </button>
        </header>
        <div class="controls">
          ${chip("all", "All")} ${chip("verified", "Verified")} ${chip("attention", "Needs attention")} ${chip("failed", "Failed")}
          <label class="search">
            ${icons.search}
            <input type="search" placeholder="Search completed…" aria-label="Search completed agents" .value=${this.q}
              @input=${(e: Event) => (this.q = (e.target as HTMLInputElement).value)} />
            <select aria-label="Time window" @change=${(e: Event) => (this.windowKey = (e.target as HTMLSelectElement).value)}>
              ${WINDOWS.map(([k]) => html`<option value=${k} ?selected=${this.windowKey === k}>${k}</option>`)}
            </select>
          </label>
        </div>
        <div class="list">
          ${list.length
            ? list.map((e) => this.renderCard(e, now))
            : html`<div class="empty">${this.feed?.completed.length ? "Nothing matches these filters." : "No agents finished in this window yet."}</div>`}
        </div>
      </section>
    `;
  }

  override updated(): void {
    this.reportHeight();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mesh-completed-rail": MeshCompletedRail;
  }
}
