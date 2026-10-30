/**
 * <trends-radar> — dashboard band surfacing FREE / open-source trends, news,
 * and trending content formats for the user's niche over the last 30 days.
 *
 * Data source: the `content.trends.last30days` gateway RPC. When the gateway
 * hasn't been restarted yet (RPC unknown), it falls back to the baked snapshot
 * at `/content-trends-snapshot.json` so the band renders immediately — the same
 * single-render-path pattern the Content Intelligence view uses.
 *
 * Each insight / news topic carries a source link and a "Turn into a script"
 * affordance that deep-links to the content studio with the topic seeded (it
 * never calls the script-generation agent directly — read-only by contract).
 *
 * Styling follows the InfiniBot OS black/gold design language: --g-primary gold
 * accents on glass, no rainbow hues, 8px+ panel-edge gap.
 */

import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gatewayCall } from "../gateway-client.js";

interface SocialInsight {
  id: string;
  title: string;
  url: string;
  summary: string;
  platform: string;
  community?: string;
  score: number;
  publishedAt?: string;
}
interface NewsTopic {
  id: string;
  title: string;
  url: string;
  summary: string;
  source: string;
  publishedAt?: string;
  cluster: number;
}
interface TrendingFormat {
  id: string;
  label: string;
  mentions: number;
  example: string;
  exampleUrl?: string;
}
interface TrendsBundle {
  niche: string;
  keywords: string[];
  socialInsights: SocialInsight[];
  newsTopics: NewsTopic[];
  trendingFormats: TrendingFormat[];
  generatedAt: number;
  sourcesConsulted: number;
  warnings: string[];
  origin?: "live" | "cache" | "snapshot";
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

@customElement("trends-radar")
export class TrendsRadar extends LitElement {
  /** Gateway client (passed for parity; calls go through the shared helper). */
  @property({ attribute: false }) client: unknown = null;
  /** Dashboard navigation callback — used by the "turn into a script" deep-link. */
  @property({ attribute: false }) navigate: ((tab: string) => void) | null = null;

  @state() private loading = true;
  @state() private error = "";
  @state() private source: "live" | "cache" | "snapshot" | "" = "";
  @state() private bundle: TrendsBundle | null = null;
  @state() private refreshing = false;
  @state() private seeded: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(force = false): Promise<void> {
    if (force) this.refreshing = true;
    else this.loading = true;
    this.error = "";
    try {
      const res = await gatewayCall<{ bundle: TrendsBundle }>(
        force ? "content.trends.refresh" : "content.trends.last30days",
        {},
      );
      this.bundle = res.bundle;
      this.source = res.bundle.origin === "cache" ? "cache" : "live";
    } catch {
      // RPC not live (gateway not restarted) — fall back to the baked snapshot.
      try {
        const snap = await fetch("/content-trends-snapshot.json", { cache: "no-store" });
        if (!snap.ok) throw new Error(`snapshot HTTP ${snap.status}`);
        this.bundle = (await snap.json()) as TrendsBundle;
        this.source = "snapshot";
      } catch (e2) {
        this.error = `Could not load trends: ${String(e2)}`;
      }
    } finally {
      this.loading = false;
      this.refreshing = false;
    }
  }

  /** Deep-link to the content studio with the topic seeded for a new script. */
  private turnIntoScript(title: string, url: string): void {
    try {
      sessionStorage.setItem(
        "infinibot.trends.scriptSeed",
        JSON.stringify({ topic: title, source: url, at: Date.now() }),
      );
    } catch {
      /* sessionStorage may be unavailable */
    }
    // Clipboard fallback so the angle is always grabbable even without wiring.
    try {
      void navigator.clipboard?.writeText(title);
    } catch {
      /* ignore */
    }
    this.seeded = title;
    setTimeout(() => {
      if (this.seeded === title) this.seeded = null;
    }, 2200);
    this.navigate?.("content-pages");
  }

  private openUrl(url: string): void {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  protected updated(_c: PropertyValues): void {
    void _c;
  }

  render() {
    return html`
      <section class="band" aria-label="Trends, research & news radar">
        ${this.renderHeader()}
        ${this.loading
          ? html`<div class="loading"><span class="spinner"></span> Scanning trends…</div>`
          : this.error
            ? html`<div class="err">${this.error}</div>`
            : this.renderGrid()}
      </section>
    `;
  }

  private renderHeader() {
    const b = this.bundle;
    const badge =
      this.source === "live"
        ? html`<span class="src src--live" title="Live from content.trends.* RPC">● LIVE</span>`
        : this.source === "cache"
          ? html`<span class="src src--live" title="Served from the SQLite TTL cache">● CACHED</span>`
          : this.source === "snapshot"
            ? html`<span class="src src--snapshot" title="Static snapshot — restart gateway for live data"
                >◌ SNAPSHOT</span
              >`
            : nothing;
    return html`
      <header class="head">
        <div class="head-l">
          <span class="orbit" aria-hidden="true"></span>
          <div>
            <h2 class="title">Trends Radar</h2>
            <div class="sub">
              ${b ? html`<span class="niche">${b.niche}</span> · ` : nothing}
              <span class="window">last 30 days</span>
              ${b ? html` · <span class="dim">updated ${timeAgo(b.generatedAt)}</span>` : nothing}
            </div>
          </div>
        </div>
        <div class="head-r">
          ${badge}
          <button
            class="refresh"
            ?disabled=${this.refreshing}
            @click=${() => this.load(true)}
            title="Force a fresh fetch (bypasses cache)"
          >
            ${this.refreshing ? html`<span class="spinner spinner--sm"></span>` : "↻"} Refresh
          </button>
        </div>
      </header>
    `;
  }

  private renderGrid() {
    const b = this.bundle;
    if (!b) return nothing;
    return html`
      <div class="grid">
        ${this.renderSocialCol(b.socialInsights)}
        ${this.renderNewsCol(b.newsTopics)}
        ${this.renderFormatsCol(b.trendingFormats)}
      </div>
    `;
  }

  private renderSocialCol(items: SocialInsight[]) {
    return html`
      <div class="col">
        <div class="col-head"><span class="dot dot--social"></span> Social Insights</div>
        ${items.length === 0
          ? html`<div class="empty">No social signal in window.</div>`
          : items.slice(0, 8).map(
              (s) => html`
                <article class="item">
                  <div class="item-title">${s.title}</div>
                  <div class="item-meta">
                    <span class="tag">${s.community ?? s.platform}</span>
                    <span class="metric" title="engagement">▲ ${compact(s.score)}</span>
                    ${s.publishedAt
                      ? html`<span class="dim">${timeAgo(new Date(s.publishedAt).getTime())}</span>`
                      : nothing}
                  </div>
                  ${this.renderActions(s.title, s.url)}
                </article>
              `,
            )}
      </div>
    `;
  }

  private renderNewsCol(items: NewsTopic[]) {
    return html`
      <div class="col">
        <div class="col-head"><span class="dot dot--news"></span> Hot News Topics</div>
        ${items.length === 0
          ? html`<div class="empty">No news in window.</div>`
          : items.slice(0, 8).map(
              (n) => html`
                <article class="item">
                  <div class="item-title">${n.title}</div>
                  <div class="item-meta">
                    <span class="tag">${n.source}</span>
                    ${n.cluster > 1
                      ? html`<span class="metric metric--hot" title="related articles"
                          >🔥 ${n.cluster} outlets</span
                        >`
                      : nothing}
                    ${n.publishedAt
                      ? html`<span class="dim">${timeAgo(new Date(n.publishedAt).getTime())}</span>`
                      : nothing}
                  </div>
                  ${this.renderActions(n.title, n.url)}
                </article>
              `,
            )}
      </div>
    `;
  }

  private renderFormatsCol(items: TrendingFormat[]) {
    const max = items.reduce((m, f) => Math.max(m, f.mentions), 1);
    return html`
      <div class="col">
        <div class="col-head"><span class="dot dot--fmt"></span> Trending Formats</div>
        ${items.length === 0
          ? html`<div class="empty">No format signal yet.</div>`
          : items.map(
              (f) => html`
                <article class="fmt" @click=${() => this.openUrl(f.exampleUrl ?? "")}>
                  <div class="fmt-row">
                    <span class="fmt-label">${f.label}</span>
                    <span class="fmt-count">${f.mentions}×</span>
                  </div>
                  <div class="fmt-meter"><span style=${`width:${(f.mentions / max) * 100}%`}></span></div>
                  ${f.example ? html`<div class="fmt-ex">“${f.example}”</div>` : nothing}
                </article>
              `,
            )}
      </div>
    `;
  }

  private renderActions(title: string, url: string) {
    const seededHere = this.seeded === title;
    return html`
      <div class="actions">
        <button class="act act--primary" @click=${() => this.turnIntoScript(title, url)}>
          ${seededHere ? "✓ Seeded" : "✎ Turn into a script"}
        </button>
        ${url
          ? html`<button class="act" @click=${() => this.openUrl(url)} title="Open source">
              ↗ Source
            </button>`
          : nothing}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      margin: 8px 0;
    }
    .band {
      border-radius: 18px;
      padding: 18px 20px 20px;
      background:
        radial-gradient(140% 120% at 0% 0%, color-mix(in srgb, var(--g-primary, #caa45a) 9%, transparent) 0%, transparent 55%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.012));
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 18%, transparent);
      box-shadow: inset 0 0 40px color-mix(in srgb, var(--g-primary, #caa45a) 5%, transparent);
    }

    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .head-l {
      display: flex;
      align-items: center;
      gap: 13px;
    }
    .orbit {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      flex-shrink: 0;
      background: radial-gradient(circle at 50% 50%, #f0d089 0%, var(--g-primary, #caa45a) 45%, transparent 72%);
      box-shadow: 0 0 18px color-mix(in srgb, var(--g-primary, #caa45a) 55%, transparent);
      position: relative;
    }
    .orbit::after {
      content: "";
      position: absolute;
      inset: -6px;
      border-radius: 50%;
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 35%, transparent);
      animation: pulse 3.6s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 0.5; }
      50% { transform: scale(1.18); opacity: 0.95; }
    }
    .title {
      margin: 0;
      font-size: 17px;
      font-weight: 800;
      letter-spacing: -0.01em;
      background: linear-gradient(90deg, #f0d089, var(--g-primary, #caa45a) 60%, #8c6f37);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .sub {
      font-size: 12px;
      color: rgba(247, 247, 247, 0.6);
      margin-top: 2px;
    }
    .niche {
      color: var(--g-primary, #caa45a);
      font-weight: 600;
    }
    .dim {
      color: rgba(247, 247, 247, 0.4);
    }
    .head-r {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .src {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 999px;
      letter-spacing: 0.08em;
      font-weight: 700;
    }
    .src--live {
      color: #7fd6a0;
      background: rgba(127, 214, 160, 0.12);
      border: 1px solid rgba(127, 214, 160, 0.3);
    }
    .src--snapshot {
      color: var(--g-primary, #caa45a);
      background: rgba(202, 164, 90, 0.1);
      border: 1px solid rgba(202, 164, 90, 0.3);
    }
    .refresh {
      font: inherit;
      font-size: 12px;
      color: var(--g-primary, #caa45a);
      background: color-mix(in srgb, var(--g-primary, #caa45a) 9%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 30%, transparent);
      border-radius: 9px;
      padding: 6px 12px;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
    }
    .refresh:hover:not([disabled]) {
      background: color-mix(in srgb, var(--g-primary, #caa45a) 18%, transparent);
      border-color: color-mix(in srgb, var(--g-primary, #caa45a) 50%, transparent);
    }
    .refresh[disabled] {
      opacity: 0.6;
      cursor: default;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    @media (max-width: 880px) {
      .grid {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }
    .col-head {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: rgba(247, 247, 247, 0.55);
      display: flex;
      align-items: center;
      gap: 7px;
      padding-bottom: 4px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .dot--social { background: #caa45a; box-shadow: 0 0 7px #caa45a; }
    .dot--news { background: #f0d089; box-shadow: 0 0 7px #f0d089; }
    .dot--fmt { background: #8c6f37; box-shadow: 0 0 7px #caa45a; }

    .item {
      padding: 11px 12px;
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.008));
      border: 1px solid rgba(255, 255, 255, 0.07);
      transition: border-color 0.2s, transform 0.15s;
    }
    .item:hover {
      border-color: color-mix(in srgb, var(--g-primary, #caa45a) 30%, transparent);
    }
    .item-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text, #f7f7f7);
      line-height: 1.32;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .item-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 7px;
      font-size: 11px;
    }
    .tag {
      color: var(--g-primary, #caa45a);
      background: color-mix(in srgb, var(--g-primary, #caa45a) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 22%, transparent);
      padding: 2px 7px;
      border-radius: 999px;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .metric {
      color: rgba(247, 247, 247, 0.62);
      font-variant-numeric: tabular-nums;
    }
    .metric--hot {
      color: #f0d089;
    }
    .actions {
      display: flex;
      gap: 7px;
      margin-top: 10px;
    }
    .act {
      font: inherit;
      font-size: 11px;
      padding: 5px 9px;
      border-radius: 8px;
      cursor: pointer;
      color: rgba(247, 247, 247, 0.75);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: background 0.18s, border-color 0.18s, color 0.18s;
    }
    .act:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text, #f7f7f7);
    }
    .act--primary {
      color: var(--g-primary, #caa45a);
      background: color-mix(in srgb, var(--g-primary, #caa45a) 10%, transparent);
      border-color: color-mix(in srgb, var(--g-primary, #caa45a) 28%, transparent);
      font-weight: 600;
    }
    .act--primary:hover {
      background: color-mix(in srgb, var(--g-primary, #caa45a) 20%, transparent);
      color: #f0d089;
    }

    .fmt {
      padding: 11px 12px;
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.008));
      border: 1px solid rgba(255, 255, 255, 0.07);
      cursor: pointer;
      transition: border-color 0.2s;
    }
    .fmt:hover {
      border-color: color-mix(in srgb, var(--g-primary, #caa45a) 30%, transparent);
    }
    .fmt-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .fmt-label {
      font-weight: 600;
      color: var(--text, #f7f7f7);
    }
    .fmt-count {
      font-size: 11px;
      color: var(--g-primary, #caa45a);
      font-variant-numeric: tabular-nums;
    }
    .fmt-meter {
      height: 5px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.07);
      overflow: hidden;
      margin: 8px 0 6px;
    }
    .fmt-meter span {
      display: block;
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary, #caa45a) 60%, #000), #f0d089);
      transition: width 0.5s ease;
    }
    .fmt-ex {
      font-size: 11px;
      color: rgba(247, 247, 247, 0.5);
      font-style: italic;
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .empty {
      font-size: 12px;
      color: rgba(247, 247, 247, 0.4);
      padding: 18px 0;
      text-align: center;
    }
    .err {
      font-size: 12px;
      color: #e7a17a;
      padding: 14px 0;
    }
    .loading {
      font-size: 13px;
      color: rgba(247, 247, 247, 0.6);
      padding: 22px 0;
      text-align: center;
    }
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(202, 164, 90, 0.3);
      border-top-color: var(--g-primary, #caa45a);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      vertical-align: middle;
    }
    .spinner--sm {
      width: 11px;
      height: 11px;
      border-width: 2px;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "trends-radar": TrendsRadar;
  }
}
