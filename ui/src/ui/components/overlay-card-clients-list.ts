/**
 * overlay-card-clients-list.ts — top-N clients by a sort field.
 *
 * Data source: the existing `business.clients.list` RPC (the Clients page's
 * source). Sorts by the `sort` prop (default `mrr`, auto-detected against the
 * dynamic schema) and shows the top-N with name + value, each row routing into
 * the Clients page.
 *
 * Payload: `{ sort?: string (default "mrr"), limit?: number (default 5), businessId?: string }`
 */
import { html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base.js";
import { pathForTab, inferBasePathFromPathname } from "../navigation";

interface ClientRecord {
  id: string;
  data: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

const REFRESH_MS = 30000;
const NAME_KEYS = ["name", "company", "client", "title", "fullname", "full_name", "contact"];

function toNumber(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : null;
}

function pickName(d: Record<string, any>): string {
  for (const pref of NAME_KEYS) {
    for (const k of Object.keys(d ?? {})) {
      if (k.toLowerCase().replace(/[\s_-]/g, "").includes(pref) && d[k]) return String(d[k]);
    }
  }
  // First non-empty string field as a fallback.
  for (const [, v] of Object.entries(d ?? {})) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return "(unnamed)";
}

/** Find the data key matching the requested sort field (fuzzy). */
function resolveSortKey(clients: ClientRecord[], sort: string): string | null {
  const want = sort.toLowerCase().replace(/[\s_-]/g, "");
  const keys = new Set<string>();
  for (const c of clients) for (const k of Object.keys(c.data ?? {})) keys.add(k);
  // Exact-ish match first.
  for (const k of keys) {
    if (k.toLowerCase().replace(/[\s_-]/g, "").includes(want)) {
      if (clients.some((c) => toNumber(c.data?.[k]) != null)) return k;
    }
  }
  // Any numeric field as a fallback so we can still rank.
  for (const k of keys) {
    if (clients.some((c) => toNumber(c.data?.[k]) != null)) return k;
  }
  return null;
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

@customElement("overlay-card-clients-list")
export class OverlayCardClientsList extends OverlayCardBase {
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

  private openClients() {
    const base = inferBasePathFromPathname(window.location.pathname);
    window.history.pushState({}, "", pathForTab("clients", base));
    window.dispatchEvent(new PopStateEvent("popstate"));
    this.close();
  }

  private get limit(): number {
    const n = Number(this.payload?.limit);
    return Number.isFinite(n) && n > 0 ? n : 5;
  }

  private get sort(): string {
    return (this.payload?.sort as string) || "mrr";
  }

  protected accent = "#38bdf8";

  protected cardTitle() {
    return `Top Clients`;
  }

  protected headerMeta() {
    return `by ${this.sort}`;
  }

  protected renderBody() {
    if (this.loading) return html`<div class="muted">Loading…</div>`;
    if (this.err) return html`<div class="err">${this.err}</div>`;
    if (!this.clients.length) return html`<div class="muted">No clients yet.</div>`;

    const sortKey = resolveSortKey(this.clients, this.sort);
    const ranked = [...this.clients]
      .map((c) => ({ c, v: sortKey ? toNumber(c.data?.[sortKey]) ?? 0 : 0 }))
      .sort((a, b) => b.v - a.v)
      .slice(0, this.limit);

    return html`
      <div class="list">
        ${ranked.map(
          ({ c, v }, i) => html`
            <button class="row" @click=${() => this.openClients()}>
              <span class="rank">${i + 1}</span>
              <span class="name" title=${pickName(c.data)}>${pickName(c.data)}</span>
              ${sortKey ? html`<span class="val">${fmtMoney(v)}</span>` : null}
            </button>
          `,
        )}
      </div>
      <button class="open" @click=${() => this.openClients()}>View all clients →</button>
    `;
  }

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .muted { font-size: 11px; color: #71717a; }
      .err { font-size: 10px; color: #ef4444; word-break: break-word; }
      .list { display: flex; flex-direction: column; gap: 4px; min-width: 250px; }
      .row {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 6px 8px;
        border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.02);
        cursor: pointer;
        font-family: inherit;
        text-align: left;
        width: 100%;
      }
      .row:hover { background: color-mix(in srgb, var(--g-primary, #d4af37) 8%, transparent); }
      .rank {
        font-size: 9px;
        font-weight: 800;
        color: #71717a;
        width: 14px;
        flex: 0 0 auto;
      }
      .name {
        flex: 1 1 auto;
        font-size: 11px;
        color: #e4e4e7;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .val {
        flex: 0 0 auto;
        font-size: 11px;
        font-weight: 700;
        color: var(--g-primary, #d4af37);
      }
      .open {
        margin-top: 8px;
        width: 100%;
        padding: 6px;
        font-size: 10px;
        font-weight: 700;
        color: #38bdf8;
        background: color-mix(in srgb, #38bdf8 8%, transparent);
        border: 1px solid color-mix(in srgb, #38bdf8 28%, transparent);
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
      }
      .open:hover { background: color-mix(in srgb, #38bdf8 16%, transparent); }
    `,
  ];
}

declare global {
  interface HTMLElementTagNameMap {
    "overlay-card-clients-list": OverlayCardClientsList;
  }
}
