/**
 * <business-hub-app> — the Business hub page (business-agency plugin).
 *
 * One element, nine sections (Overview, Leads, Pipeline, Contacts, Clients,
 * Campaigns, Landing pages, Imports, Revenue), all reading the same `hub.*`
 * RPCs the `business_hub` agent tool uses. The section lives in the URL
 * (`/hub?view=…`, through the app's host sub-view state) so links from
 * anywhere — and old /leads, /pipeline, /campaigns bookmarks — land on it.
 *
 * Detail views (contact, client, deal) open in a side sheet with the full
 * timeline; every empty state names the next action instead of a dead end.
 */

import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../gateway";
import { icons } from "./icons";
import { hubStyles } from "./styles";
import { renderOverview } from "./sections/overview";
import { renderPipeline } from "./sections/pipeline";
import { renderContacts } from "./sections/contacts";
import { renderClients } from "./sections/clients";
import { renderImports } from "./sections/imports";
import { renderLeads } from "./sections/leads";
import { renderCampaigns } from "./sections/campaigns";
import { renderTracking } from "./sections/tracking";
import { renderRevenue } from "./sections/revenue";
import { renderOffers } from "./sections/offers";
import { renderAutopilot } from "./sections/autopilot";
import { renderAutopilotInbox } from "./sections/autopilot-inbox";
import { renderBookings } from "./sections/bookings";
import { renderDetail, type DetailRef } from "./sections/detail";

export type SectionId = "overview" | "offers" | "autopilot" | "autopilot-inbox" | "bookings" | "leads" | "pipeline" | "contacts" | "clients" | "campaigns" | "tracking" | "imports" | "revenue";

export const SECTIONS: Array<{ id: SectionId; label: string; icon: keyof typeof icons; blurb: string }> = [
  { id: "overview", label: "Overview", icon: "overview", blurb: "Revenue, pipeline and campaigns at a glance." },
  { id: "offers", label: "Offers", icon: "offers", blurb: "Products, ICPs and pitch playbooks the AI can sell." },
  { id: "autopilot", label: "Autopilot", icon: "autopilot", blurb: "Source, qualify and move leads into personalised sequences." },
  { id: "autopilot-inbox", label: "Inbox", icon: "inbox", blurb: "Classified replies and approval-first response drafts." },
  { id: "bookings", label: "Bookings", icon: "bookings", blurb: "Offer-linked availability, public pages and appointments." },
  { id: "leads", label: "Leads", icon: "leads", blurb: "Find, verify and score new prospects." },
  { id: "pipeline", label: "Pipeline", icon: "pipeline", blurb: "Every deal from first touch to won." },
  { id: "contacts", label: "Contacts", icon: "contacts", blurb: "Everyone you know, with a full timeline." },
  { id: "clients", label: "Clients", icon: "clients", blurb: "Paying relationships, LTV and invoices." },
  { id: "campaigns", label: "Campaigns", icon: "campaigns", blurb: "Email sequences that stop on reply." },
  { id: "tracking", label: "Landing pages", icon: "tracking", blurb: "One snippet: visits, UTMs, form leads." },
  { id: "imports", label: "Imports", icon: "imports", blurb: "Bring your customer lists in — undoable." },
  { id: "revenue", label: "Revenue", icon: "revenue", blurb: "Whop + Stripe, every payment since day one." },
];

export type Period = "today" | "7d" | "30d" | "90d" | "ytd" | "365d" | "all" | "custom";
export const PERIODS: Array<{ id: Period; label: string; days: number | null }> = [
  { id: "today", label: "Today", days: 0 },
  { id: "7d", label: "7d", days: 7 },
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
  { id: "ytd", label: "YTD", days: null },
  { id: "365d", label: "12 months", days: 365 },
  { id: "all", label: "All time", days: null },
  { id: "custom", label: "Custom", days: null },
];

type Cache = Record<string, { at: number; data: unknown; error?: string; loading?: boolean }>;

export class BusinessHubApp extends LitElement {
  static styles = hubStyles;

  static properties = {
    client: { attribute: false },
    section: { type: String },
    onSection: { attribute: false },
    openLegacy: { attribute: false },
    tick: { state: true },
  };

  client: GatewayBrowserClient | null = null;
  section: SectionId = "overview";
  /** Persist the section in the app URL (host sub-view). */
  onSection: ((s: SectionId) => void) | null = null;
  /** Navigate to another app page (funnel builder, invoices…). */
  openLegacy: ((tab: string) => void) | null = null;
  tick = 0;

  period: Period = "all";
  cache: Cache = {};
  /** Per-section UI state (filters, selections, modals). */
  ui: Record<string, unknown> = {};
  detail: DetailRef | null = null;
  toast: { text: string; err?: boolean; action?: { label: string; run: () => void } } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Re-render. */
  refresh = () => {
    this.tick++;
  };

  connectedCallback(): void {
    super.connectedCallback();
    try {
      const saved = localStorage.getItem("infinibot.business-hub.revenue.period") as Period | null;
      if (saved && PERIODS.some((period) => period.id === saved)) this.period = saved;
      const custom = localStorage.getItem("infinibot.business-hub.revenue.custom");
      if (custom) this.ui.revCustomRange = JSON.parse(custom);
    } catch {
      /* storage can be disabled; all-time remains the safe first-open default */
    }
    // A light poll keeps running jobs (lead search, syncs, sends) live.
    this.pollTimer = setInterval(() => this.onPoll(), 4000);
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.pollTimer) clearInterval(this.pollTimer);
    window.removeEventListener("keydown", this.onKey);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (this.ui.modal) {
        this.ui.modal = null;
        this.refresh();
      } else if (this.detail) this.closeDetail();
    }
  };

  /** Hooks a section can register for polling while something runs. */
  pollers = new Map<string, () => void>();
  private onPoll() {
    if (document.hidden) return;
    for (const fn of this.pollers.values()) fn();
  }

  /** Top edge of the app's content area (<main class="content">), so sheets/modals sit below the app chrome. */
  private syncTopOffset() {
    let main: Element | null = null;
    let el: Element | null = this.parentElement ?? ((this.getRootNode() as ShadowRoot).host ?? null);
    while (el) {
      if (el.tagName === "MAIN" && el.classList.contains("content")) {
        main = el;
        break;
      }
      el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
    }
    // The app may apply CSS zoom (viewport-scale): rects are zoomed, CSS lengths are not.
    const rect = main?.getBoundingClientRect();
    const zoom = main instanceof HTMLElement && main.offsetHeight ? rect!.height / main.offsetHeight : 1;
    const top = rect ? Math.max(0, Math.round(rect.top / (zoom || 1))) : 0;
    this.style.setProperty("--bh-top", `${top}px`);
  }

  protected updated(): void {
    if (this.detail || this.ui.modal) this.syncTopOffset();
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("section") && !SECTIONS.some((s) => s.id === this.section)) this.section = "overview";
  }

  // ── data ───────────────────────────────────────────────────────────────
  async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) throw new Error("Not connected to the gateway.");
    return this.client.request<T>(method, params);
  }

  /** Cached load keyed by `key`; re-fetches when stale or forced. */
  load<T = unknown>(key: string, method: string, params: Record<string, unknown> = {}, opts: { maxAgeMs?: number; force?: boolean } = {}): { data: T | null; loading: boolean; error: string | null } {
    const c = this.cache[key];
    const stale = !c || opts.force || (!c.loading && Date.now() - c.at > (opts.maxAgeMs ?? 30_000));
    if (stale && !(c?.loading)) {
      this.cache[key] = { at: c?.at ?? 0, data: c?.data ?? null, loading: true };
      void this.rpc<T>(method, params)
        .then((data) => {
          this.cache[key] = { at: Date.now(), data };
        })
        .catch((err: unknown) => {
          this.cache[key] = { at: Date.now(), data: c?.data ?? null, error: err instanceof Error ? err.message : String(err) };
        })
        .finally(() => this.refresh());
    }
    const cur = this.cache[key];
    return { data: (cur?.data as T) ?? null, loading: Boolean(cur?.loading) && !cur?.data, error: cur?.error ?? null };
  }

  invalidate(prefix?: string) {
    for (const k of Object.keys(this.cache)) if (!prefix || k.startsWith(prefix)) this.cache[k] = { ...this.cache[k], at: 0 };
    this.refresh();
  }

  /** Run a mutation with toast feedback; invalidates the cache on success. */
  async act<T = unknown>(method: string, params: Record<string, unknown>, done?: string | null | ((r: T) => string | null), invalidate: string | string[] = ""): Promise<T | null> {
    try {
      const r = await this.rpc<T>(method, params);
      const msg = typeof done === "function" ? done(r) : done;
      if (msg) this.showToast(msg);
      for (const p of Array.isArray(invalidate) ? invalidate : [invalidate]) this.invalidate(p || undefined);
      return r;
    } catch (err) {
      this.showToast(err instanceof Error ? err.message : String(err), true);
      return null;
    }
  }

  setPeriod(period: Period): void {
    this.period = period;
    try {
      localStorage.setItem("infinibot.business-hub.revenue.period", period);
    } catch {
      /* no-op */
    }
    this.refresh();
  }

  setCustomRange(from: number, to: number): void {
    this.ui.revCustomRange = { from, to };
    try {
      localStorage.setItem(
        "infinibot.business-hub.revenue.custom",
        JSON.stringify({ from, to }),
      );
    } catch {
      /* no-op */
    }
    this.setPeriod("custom");
  }

  range(): { from?: number; to: number } {
    const p = PERIODS.find((x) => x.id === this.period)!;
    const to = Date.now();
    if (this.period === "today") {
      const d = new Date(to);
      d.setHours(0, 0, 0, 0);
      return { from: d.getTime(), to };
    }
    if (this.period === "ytd") return { from: new Date(new Date(to).getFullYear(), 0, 1).getTime(), to };
    if (this.period === "custom") {
      const custom = this.ui.revCustomRange as { from?: number; to?: number } | undefined;
      if (custom?.from !== undefined && custom?.to !== undefined && custom.from < custom.to)
        return { from: custom.from, to: custom.to };
    }
    return p.days ? { from: to - p.days * 86_400_000, to } : { from: 0, to };
  }

  // ── navigation ─────────────────────────────────────────────────────────
  go(section: SectionId, ui?: Record<string, unknown>) {
    if (ui) this.ui = { ...this.ui, ...ui };
    this.section = section;
    this.onSection?.(section);
    this.renderRoot?.querySelector(".page")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }

  openDetail(ref: DetailRef) {
    this.detail = ref;
    this.refresh();
  }

  closeDetail() {
    this.detail = null;
    this.refresh();
  }

  showToast(text: string, err = false, action?: { label: string; run: () => void }) {
    this.toast = { text, err, action };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.refresh();
    }, action ? 8000 : 4200);
    this.refresh();
  }

  // ── render ─────────────────────────────────────────────────────────────
  private renderSection(): TemplateResult {
    switch (this.section) {
      case "offers": return renderOffers(this);
      case "autopilot": return renderAutopilot(this);
      case "autopilot-inbox": return renderAutopilotInbox(this);
      case "bookings": return renderBookings(this);
      case "leads": return renderLeads(this);
      case "pipeline": return renderPipeline(this);
      case "contacts": return renderContacts(this);
      case "clients": return renderClients(this);
      case "campaigns": return renderCampaigns(this);
      case "tracking": return renderTracking(this);
      case "imports": return renderImports(this);
      case "revenue": return renderRevenue(this);
      default: return renderOverview(this);
    }
  }

  render() {
    const meta = SECTIONS.find((s) => s.id === this.section) ?? SECTIONS[0];
    return html`
      <div class="aurora" aria-hidden="true"></div>
      <div class="page">
        <header class="hero">
          <div>
            <div class="eyebrow">Business hub</div>
            <h1>${this.section === "overview" ? html`Your business, <span class="gold">connected</span>` : meta.label}</h1>
            <div class="sub">${meta.blurb}</div>
          </div>
          <div class="hero-actions">
            <button class="btn" @click=${() => this.go("imports")}>${icons.imports()} Import list</button>
            <button class="btn primary" @click=${() => this.go("leads", { leadsCompose: true })}>${icons.sparkle()} Find leads</button>
          </div>
        </header>
        <nav class="nav" aria-label="Business hub sections">
          <div class="seg glass" role="tablist">
            ${SECTIONS.map(
              (s) => html`<button role="tab" aria-current=${this.section === s.id ? "page" : "false"} aria-selected=${this.section === s.id} @click=${() => this.go(s.id)}>
                ${icons[s.icon]()}<span>${s.label}</span>
              </button>`,
            )}
          </div>
        </nav>
        <main>${this.renderSection()}</main>
      </div>
      ${this.detail ? renderDetail(this, this.detail) : nothing}
      ${this.toast
        ? html`<div class="toast glass ${this.toast.err ? "err" : ""}" role="status" aria-live="polite">
            <span>${this.toast.err ? html`<span class="bad">●</span>` : html`<span class="ok">●</span>`} ${this.toast.text}</span>
            ${this.toast.action ? html`<button class="btn sm" @click=${() => { this.toast?.action?.run(); this.toast = null; this.refresh(); }}>${this.toast.action.label}</button>` : nothing}
          </div>`
        : nothing}
    `;
  }
}

if (!customElements.get("business-hub-app")) customElements.define("business-hub-app", BusinessHubApp);

declare global {
  interface HTMLElementTagNameMap {
    "business-hub-app": BusinessHubApp;
  }
}
