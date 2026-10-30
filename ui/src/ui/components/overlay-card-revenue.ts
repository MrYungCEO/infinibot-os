/**
 * overlay-card-revenue.ts — business revenue / pipeline KPI card.
 *
 * Data source: the existing `business.clients.list` RPC (the same one the
 * Clients page uses). Clients are dynamic records (`{ id, data, created_at }`),
 * so there is no fixed `$` column — we auto-detect the money field across the
 * client schema (mrr / value / revenue / amount / deal / contract / price) and
 * sum it for the total, derive a 30-day "new" delta from `created_at`, and build
 * a real cumulative-value sparkline bucketed by month. Falls back to client
 * count when no numeric money field exists (never shows a fake number).
 *
 * Payload: `{ businessId?: string, field?: string }`
 */
import { html, css, svg } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base.js";

interface ClientRecord {
  id: string;
  data: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

const MONEY_KEYS = [
  "mrr",
  "value",
  "revenue",
  "amount",
  "deal",
  "dealsize",
  "deal_size",
  "contract",
  "contractvalue",
  "price",
  "arr",
  "spend",
];

const REFRESH_MS = 30000;

function toNumber(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : null;
}

/** Pick the data field most likely to hold a monetary value. */
function detectMoneyField(clients: ClientRecord[], override?: string): string | null {
  if (override) return override;
  const keys = new Set<string>();
  for (const c of clients) for (const k of Object.keys(c.data ?? {})) keys.add(k);
  for (const pref of MONEY_KEYS) {
    for (const k of keys) {
      if (k.toLowerCase().replace(/[\s_-]/g, "").includes(pref.replace(/[\s_-]/g, ""))) {
        // Confirm at least one client has a numeric value here.
        if (clients.some((c) => toNumber(c.data?.[k]) != null)) return k;
      }
    }
  }
  return null;
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

@customElement("overlay-card-revenue")
export class OverlayCardRevenue extends OverlayCardBase {
  @state() private clients: ClientRecord[] = [];
  @state() private loading = true;
  @state() private err: string | null = null;

  private timer: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), REFRESH_MS);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  private async refresh() {
    if (!this.client) return;
    try {
      const res = (await this.client.request("business.clients.list", {
        businessId: this.payload?.businessId,
      })) as { clients: ClientRecord[] };
      this.clients = res?.clients ?? [];
      this.err = null;
      this.loading = false;
    } catch (e) {
      this.err = String((e as Error)?.message ?? e);
      this.loading = false;
    }
  }

  protected accent = "var(--g-primary, #d4af37)";

  protected cardTitle() {
    return "Revenue";
  }

  protected headerMeta() {
    return this.clients.length ? `${this.clients.length} clients` : null;
  }

  private compute() {
    const field = detectMoneyField(this.clients, this.payload?.field);
    if (!field) {
      return { hasMoney: false, total: this.clients.length, delta: 0, spark: [] as number[], field: null };
    }
    let total = 0;
    let delta = 0;
    const now = Date.now();
    const monthMs = 30 * 24 * 3600 * 1000;
    // Monthly cumulative buckets for the sparkline (last 6 months).
    const buckets = new Array(6).fill(0);
    for (const c of this.clients) {
      const v = toNumber(c.data?.[field]);
      if (v == null) continue;
      total += v;
      const created = c.created_at ? Date.parse(c.created_at) : NaN;
      if (!isNaN(created)) {
        if (now - created <= monthMs) delta += v;
        const monthsAgo = Math.floor((now - created) / monthMs);
        const idx = 5 - Math.min(5, monthsAgo);
        if (idx >= 0) buckets[idx] += v;
      }
    }
    // Cumulative so the sparkline reads as growth.
    const spark: number[] = [];
    let run = 0;
    for (const b of buckets) {
      run += b;
      spark.push(run);
    }
    return { hasMoney: true, total, delta, spark, field };
  }

  private renderSpark(values: number[]) {
    if (values.length < 2) return null;
    const max = Math.max(...values, 1);
    const w = 120;
    const h = 30;
    const step = w / (values.length - 1);
    const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`);
    const line = pts.join(" ");
    const area = `0,${h} ${line} ${w},${h}`;
    return svg`
      <svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <polygon points=${area} fill="color-mix(in srgb, var(--g-primary,#d4af37) 14%, transparent)"></polygon>
        <polyline points=${line} fill="none" stroke="var(--g-primary,#d4af37)" stroke-width="1.5"></polyline>
      </svg>
    `;
  }

  protected renderBody() {
    if (this.loading) return html`<div class="muted">Loading…</div>`;
    if (this.err) return html`<div class="err">${this.err}</div>`;
    const { hasMoney, total, delta, spark, field } = this.compute();

    if (!hasMoney) {
      return html`
        <div class="big">${total}</div>
        <div class="sub">active clients · no $ field detected</div>
      `;
    }

    return html`
      <div class="big">${fmtMoney(total)}</div>
      <div class="row">
        ${delta > 0
          ? html`<span class="delta up">▲ ${fmtMoney(delta)} (30d)</span>`
          : html`<span class="delta flat">—</span>`}
        <span class="field">${field}</span>
      </div>
      ${this.renderSpark(spark)}
    `;
  }

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .muted { font-size: 11px; color: #71717a; }
      .err { font-size: 10px; color: #ef4444; word-break: break-word; }
      .big {
        font-size: 30px;
        font-weight: 800;
        letter-spacing: -0.02em;
        color: var(--g-primary, #d4af37);
        line-height: 1;
        text-shadow: 0 0 24px color-mix(in srgb, var(--g-primary, #d4af37) 35%, transparent);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 6px;
      }
      .delta { font-size: 10px; font-weight: 700; }
      .delta.up { color: #22c55e; }
      .delta.flat { color: #71717a; }
      .field {
        margin-left: auto;
        font-size: 8px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #71717a;
      }
      .sub { font-size: 10px; color: #a1a1aa; margin-top: 4px; }
      .spark {
        display: block;
        width: 100%;
        height: 30px;
        margin-top: 10px;
      }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "overlay-card-revenue": OverlayCardRevenue;
  }
}
