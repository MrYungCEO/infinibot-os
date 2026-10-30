/**
 * overlay-card-client.ts — single client summary card.
 *
 * Data source: the existing `business.clients.get` RPC (the Clients page's
 * source). Clients are dynamic records, so we render the most meaningful fields
 * we can detect (name, status, money) plus a few extra data columns, and a
 * "Open in Clients" action that routes to the Clients page.
 *
 * Payload: `{ clientId: string, businessId?: string }`
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
const STATUS_KEYS = ["status", "stage", "temperature", "temp", "state"];
const MONEY_KEYS = ["mrr", "value", "revenue", "amount", "deal", "contract", "price", "arr"];

function pick(data: Record<string, any>, keys: string[]): { key: string; value: any } | null {
  for (const pref of keys) {
    for (const k of Object.keys(data ?? {})) {
      if (k.toLowerCase().replace(/[\s_-]/g, "").includes(pref) && data[k] != null && data[k] !== "") {
        return { key: k, value: data[k] };
      }
    }
  }
  return null;
}

function toNumber(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : null;
}

function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

@customElement("overlay-card-client")
export class OverlayCardClient extends OverlayCardBase {
  @state() private record: ClientRecord | null = null;
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
    const id = (this.payload?.clientId ?? this.payload?.id) as string | undefined;
    if (!id) {
      this.err = "No clientId in payload";
      this.loading = false;
      return;
    }
    try {
      const res = (await this.client.request("business.clients.get", {
        id,
        businessId: this.payload?.businessId,
      })) as { client: ClientRecord };
      this.record = res?.client ?? null;
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

  protected accent = "#38bdf8";

  protected cardTitle() {
    const d = this.record?.data ?? {};
    return pick(d, NAME_KEYS)?.value?.toString() || "Client";
  }

  protected renderBody() {
    if (this.loading) return html`<div class="muted">Loading…</div>`;
    if (this.err) return html`<div class="err">${this.err}</div>`;
    if (!this.record) return html`<div class="muted">Client not found.</div>`;

    const d = this.record.data ?? {};
    const status = pick(d, STATUS_KEYS);
    const moneyPick = pick(d, MONEY_KEYS);
    const money = moneyPick ? toNumber(moneyPick.value) : null;

    // A few extra fields worth showing (skip the ones already surfaced).
    const shown = new Set<string>();
    [pick(d, NAME_KEYS), status, moneyPick].forEach((p) => p && shown.add(p.key));
    const extra = Object.entries(d)
      .filter(([k, v]) => !shown.has(k) && v != null && v !== "" && typeof v !== "object")
      .slice(0, 4);

    return html`
      <div class="top">
        ${status ? html`<span class="chip">${status.value}</span>` : null}
        ${money != null ? html`<span class="money">${fmtMoney(money)}</span>` : null}
      </div>
      <div class="fields">
        ${extra.map(
          ([k, v]) => html`
            <div class="field">
              <span class="k">${k}</span>
              <span class="v" title=${String(v)}>${String(v)}</span>
            </div>
          `,
        )}
      </div>
      <button class="open" @click=${() => this.openClients()}>Open in Clients →</button>
    `;
  }

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .muted { font-size: 11px; color: #71717a; }
      .err { font-size: 10px; color: #ef4444; word-break: break-word; }
      .top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .chip {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #38bdf8;
        border: 1px solid color-mix(in srgb, #38bdf8 40%, transparent);
        border-radius: 999px;
        padding: 2px 8px;
      }
      .money {
        margin-left: auto;
        font-size: 15px;
        font-weight: 800;
        color: var(--g-primary, #d4af37);
      }
      .fields { display: flex; flex-direction: column; gap: 5px; min-width: 240px; }
      .field {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        font-size: 10px;
      }
      .k { color: #71717a; text-transform: capitalize; }
      .v {
        color: #d4d4d8;
        text-align: right;
        max-width: 170px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .open {
        margin-top: 10px;
        width: 100%;
        padding: 6px;
        font-size: 10px;
        font-weight: 700;
        color: #38bdf8;
        background: color-mix(in srgb, #38bdf8 8%, transparent);
        border: 1px solid color-mix(in srgb, #38bdf8 30%, transparent);
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
    "overlay-card-client": OverlayCardClient;
  }
}
