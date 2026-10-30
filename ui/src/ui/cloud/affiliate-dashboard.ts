import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getClerkToken } from "../saas-clerk";
import { cloudApiBase } from "./cloud-env";

type Dashboard = {
  account: null | { id: string; code: string; vanityCode: string | null; status: "pending" | "approved" | "suspended"; appliedAt: string };
  settings: { defaultRateBps: number; recurringRateBps: number; minPayoutCents: number; holdDays: number };
  stats: { clicks: number; signups: number; conversions: number; totalCents: number; pendingCents: number; approvedCents: number; paidCents: number; tier: null | { name: string; firstRateBps: number }; nextTier: null | { name: string; minConversions: number } };
  commissions: Array<{ id: string; kind: string; grossCents: number; rateBps: number; commissionCents: number; status: string; createdAt: string }>;
  payouts: Array<{ id: string; amountCents: number; status: string; method: string; requestedAt: string }>;
  storefrontLinks: Array<{ pluginId: string; customPurchaseUrl: string | null; headline?: string | null; note?: string | null; enabled: boolean; adminDisabled: boolean }>;
};

const money = (c: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
const fixture: Dashboard = {
  account: { id: "preview", code: "ASH20", vanityCode: "ash-builds", status: "approved", appliedAt: "2026-09-02T00:00:00Z" },
  settings: { defaultRateBps: 2000, recurringRateBps: 1000, minPayoutCents: 2500, holdDays: 7 },
  stats: { clicks: 1842, signups: 126, conversions: 34, totalCents: 128640, pendingCents: 18400, approvedCents: 41240, paidCents: 69000, tier: { name: "Partner", firstRateBps: 2500 }, nextTier: { name: "Ambassador", minConversions: 50 } },
  commissions: [
    { id: "1", kind: "recurring", grossCents: 9900, rateBps: 1250, commissionCents: 1238, status: "pending", createdAt: "2026-10-01T11:20:00Z" },
    { id: "2", kind: "first_payment", grossCents: 4900, rateBps: 2500, commissionCents: 1225, status: "approved", createdAt: "2026-09-29T09:04:00Z" },
    { id: "3", kind: "first_payment", grossCents: 14900, rateBps: 2500, commissionCents: 3725, status: "paid", createdAt: "2026-09-23T15:42:00Z" },
  ],
  payouts: [{ id: "p1", amountCents: 69000, status: "paid", method: "wise", requestedAt: "2026-09-20T08:00:00Z" }],
  storefrontLinks: [{ pluginId: "business-agency", customPurchaseUrl: "https://partner.example/agency", enabled: true, adminDisabled: false }],
};

@customElement("ib-affiliate-dashboard")
export class AffiliateDashboard extends LitElement {
  static styles = css`
    :host{display:block;min-height:100vh;color:#f7f1df;background:#050504;font-family:"Chakra Petch",Inter,system-ui,sans-serif;--g:#f4bd3b;--line:rgba(244,189,59,.18);--muted:#9d9789}
    *{box-sizing:border-box}.ground{position:fixed;inset:0;pointer-events:none;background:radial-gradient(900px 500px at 15% -10%,rgba(244,189,59,.13),transparent 65%),radial-gradient(700px 500px at 90% 25%,rgba(165,104,24,.1),transparent 68%),linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:auto,auto,48px 48px,48px 48px}
    header{height:72px;display:flex;align-items:center;gap:14px;padding:0 clamp(20px,4vw,54px);border-bottom:1px solid rgba(255,255,255,.06);background:rgba(5,5,4,.82);backdrop-filter:blur(18px);position:sticky;top:0;z-index:3}header img{width:32px;height:32px}header b{letter-spacing:.08em;text-transform:uppercase}header span{color:var(--g)}header a{margin-left:auto;color:#c8c0ac;text-decoration:none;font-size:14px;border:1px solid var(--line);padding:9px 14px;border-radius:999px;white-space:nowrap}
    main{position:relative;max-width:1240px;margin:auto;padding:48px clamp(18px,4vw,54px) 80px}.eyebrow{color:var(--g);font:600 11px/1.2 "JetBrains Mono",monospace;letter-spacing:.18em;text-transform:uppercase}h1{font-size:clamp(34px,5vw,62px);line-height:1.02;letter-spacing:-.045em;margin:14px 0 12px;max-width:14ch}h1 i{font-family:Georgia,serif;color:var(--g);font-weight:400}.lede{color:var(--muted);font-size:17px;max-width:680px;margin:0 0 34px}
    .status{display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:rgba(244,189,59,.055);margin-bottom:18px}.status .dot{width:9px;height:9px;border-radius:50%;background:#55d88a;box-shadow:0 0 14px #55d88a}.status.pending .dot{background:#f4bd3b;box-shadow:0 0 14px #f4bd3b}.status.suspended .dot{background:#f16f62;box-shadow:0 0 14px #f16f62}.status small{display:block;color:var(--muted);margin-top:2px}
    .share{display:grid;grid-template-columns:1fr auto;gap:12px;padding:18px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(120deg,rgba(244,189,59,.09),rgba(255,255,255,.025));box-shadow:0 24px 80px -50px rgba(244,189,59,.6)}.share label{display:block;color:var(--muted);font-size:12px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.12em}.link{font:500 14px/1.4 "JetBrains Mono",monospace;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.btn{border:1px solid var(--line);background:#14120d;color:#f7f1df;border-radius:11px;padding:10px 15px;font:600 13px/1 inherit;cursor:pointer}.btn.gold{background:linear-gradient(180deg,#ffd86c,var(--g));color:#1b1303;border:0;box-shadow:0 8px 30px -10px rgba(244,189,59,.8)}.btn:disabled{opacity:.45;cursor:not-allowed}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.stat,.panel{border:1px solid rgba(255,255,255,.075);border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.018));padding:20px}.stat small{color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-size:10px}.stat b{display:block;font:600 clamp(25px,3vw,38px)/1 "JetBrains Mono",monospace;margin-top:12px}.stat.gold b{color:var(--g)}
    .cols{display:grid;grid-template-columns:1.15fr .85fr;gap:14px}.panel h2{font-size:16px;margin:0 0 18px}.balance{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.balance div{padding:14px;border-radius:12px;background:rgba(0,0,0,.25)}.balance small{display:block;color:var(--muted);font-size:11px}.balance b{display:block;margin-top:8px;font:600 21px/1 monospace}.pending{color:#f4bd3b}.approved{color:#64dc9a}.paid{color:#a89fff}
    .tier{padding:18px;border:1px solid var(--line);border-radius:14px;background:rgba(244,189,59,.04)}.tier .eyebrow{display:block;margin-bottom:8px}.tier strong{display:block;color:var(--g);font-size:22px}.tier p{color:var(--muted);margin:7px 0 0}.progress{height:6px;background:#191712;border-radius:999px;margin-top:16px;overflow:hidden}.progress i{display:block;height:100%;width:68%;background:linear-gradient(90deg,#b76e16,var(--g));border-radius:inherit}
    .builder{display:grid;grid-template-columns:1fr auto;gap:10px}.field{width:100%;border:1px solid rgba(255,255,255,.11);background:#0a0907;color:#fff;border-radius:10px;padding:11px 13px;font:500 13px/1.3 "JetBrains Mono",monospace;outline:none}.field:focus{border-color:var(--g)}
    .store-builder{display:grid;grid-template-columns:.65fr 1.35fr;gap:10px}.store-builder .wide{grid-column:1/-1}.saved-links{display:grid;gap:8px;margin-top:14px}.saved-link{display:flex;gap:10px;align-items:center;border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:11px 13px}.saved-link b{font-family:"JetBrains Mono",monospace}.saved-link span{margin-left:auto;color:var(--muted);font-size:11px}
    .section{margin-top:18px}.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.section-head h2{font-size:17px;margin:0}.section-head small{color:var(--muted)}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#7f796d;font-size:10px;text-transform:uppercase;letter-spacing:.1em;padding:10px 8px;border-bottom:1px solid rgba(255,255,255,.07)}td{padding:13px 8px;border-bottom:1px solid rgba(255,255,255,.055)}td:last-child,th:last-child{text-align:right}.pill{display:inline-flex;padding:4px 8px;border:1px solid rgba(255,255,255,.09);border-radius:999px;color:#bfb7a4;font-size:10px;text-transform:uppercase}.empty{text-align:center;padding:50px;color:var(--muted)}.error{max-width:600px;margin:120px auto;text-align:center;color:#e8b0a9}
    @media(max-width:850px){.stats{grid-template-columns:repeat(2,1fr)}.cols{grid-template-columns:1fr}.balance{grid-template-columns:1fr}.share,.builder,.store-builder{grid-template-columns:1fr}.store-builder .wide{grid-column:auto}.share .btn{width:100%}main{padding-top:30px}.section-head{align-items:flex-start;gap:8px;flex-wrap:wrap}.section-head>a,.section-head>small{margin-left:0}.campaign-link{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}.table-wrap{overflow:visible}.ledger-table,.payout-table{min-width:0;font-size:11px}.ledger-table th,.ledger-table td,.payout-table th,.payout-table td{padding:10px 4px}.ledger-table th:nth-child(3),.ledger-table td:nth-child(3),.ledger-table th:nth-child(4),.ledger-table td:nth-child(4){display:none}}
  `;

  @state() private data: Dashboard | null = null;
  @state() private error = "";
  @state() private busy = false;
  @state() private copied = false;
  @state() private buildPath = "/pricing";
  @state() private payoutMethod = "wise";
  @state() private storePlugin = "business-agency";
  @state() private storeUrl = "";
  @state() private storeHeadline = "";
  @state() private storeNote = "";

  connectedCallback() { super.connectedCallback(); void this.load(); }
  private async call(path: string, init: RequestInit = {}) {
    const token = await getClerkToken();
    const res = await fetch(`${cloudApiBase()}/affiliate${path}`, { ...init, credentials: "include", headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
    return body;
  }
  private async load() {
    if ((location.hostname === "localhost" || location.hostname === "127.0.0.1") && new URLSearchParams(location.search).has("affiliate-preview")) { this.data = fixture; return; }
    try { this.data = await this.call("/me"); } catch (err) { this.error = (err as Error).message; }
  }
  private async apply() {
    this.busy = true;
    try { await this.call("/apply", { method: "POST" }); await this.load(); } catch (err) { this.error = (err as Error).message; } finally { this.busy = false; }
  }
  private link(path = this.buildPath) {
    const code = this.data?.account?.vanityCode || this.data?.account?.code;
    if (!code) return "";
    const u = new URL(path || "/", location.origin);
    u.searchParams.set("ref", code);
    return u.toString();
  }
  private async copyLink() { await navigator.clipboard.writeText(this.link("/")); this.copied = true; window.setTimeout(() => (this.copied = false), 1800); }
  private async requestPayout() {
    this.busy = true;
    try { await this.call("/payouts", { method: "POST", body: JSON.stringify({ method: this.payoutMethod, details: {} }) }); await this.load(); } catch (err) { this.error = (err as Error).message; } finally { this.busy = false; }
  }
  private async saveStorefront() {
    this.busy = true;
    try {
      await this.call("/storefront-links", { method: "PUT", body: JSON.stringify({ pluginId: this.storePlugin, customPurchaseUrl: this.storeUrl || null, headline: this.storeHeadline || null, note: this.storeNote || null, enabled: true }) });
      await this.load();
    } catch (err) { this.error = (err as Error).message; } finally { this.busy = false; }
  }
  render() {
    if (this.error) return html`<div class="ground"></div><div class="error"><h1>Affiliate dashboard unavailable</h1><p>${this.error}</p><button class="btn" @click=${() => { this.error = ""; void this.load(); }}>Retry</button></div>`;
    if (!this.data) return html`<div class="ground"></div><div class="error"><p>Loading your affiliate workspace…</p></div>`;
    const d = this.data;
    return html`<div class="ground"></div><header><img src="/infinibot-logo.png" alt=""><b>InfiniBot <span>Affiliates</span></b><a href="/app/">Back to workspace</a></header>
      <main><span class="eyebrow">Partner network · Revenue share</span><h1>Build with us. <i>Earn with us.</i></h1><p class="lede">Share InfiniBot Cloud or curate a plugin storefront. Every click, signup, conversion, commission, and payout stays visible.</p>
      ${!d.account ? html`<div class="panel empty"><h2>Apply to the InfiniBot affiliate program</h2><p>Get your unique code, tracked links, partner storefront, and recurring commission ledger.</p><button class="btn gold" ?disabled=${this.busy} @click=${() => this.apply()}>${this.busy ? "Applying…" : "Apply now"}</button></div>` : this.dashboard(d)}
      </main>`;
  }
  private dashboard(d: Dashboard) {
    const a = d.account!;
    const statusCopy = a.status === "approved" ? "Your links are live and earning commissions." : a.status === "pending" ? "Your application is being reviewed. Links activate after approval." : "Tracking and new commissions are paused. Contact support.";
    const progress = d.stats.nextTier ? Math.min(100, (d.stats.conversions / d.stats.nextTier.minConversions) * 100) : 100;
    return html`<div class="status ${a.status}"><span class="dot"></span><div><b>${a.status.toUpperCase()}</b><small>${statusCopy}</small></div></div>
      <div class="share"><div><label>Your universal affiliate link</label><div class="link">${this.link("/")}</div></div><button class="btn gold" @click=${() => this.copyLink()}>${this.copied ? "Copied" : "Copy link"}</button></div>
      <div class="stats"><div class="stat"><small>Link clicks</small><b>${d.stats.clicks.toLocaleString()}</b></div><div class="stat"><small>Signups</small><b>${d.stats.signups.toLocaleString()}</b></div><div class="stat"><small>Paid conversions</small><b>${d.stats.conversions.toLocaleString()}</b></div><div class="stat gold"><small>Total earned</small><b>${money(d.stats.totalCents)}</b></div></div>
      <div class="cols"><div class="panel"><h2>Earnings</h2><div class="balance"><div><small>Pending · ${d.settings.holdDays}-day hold</small><b class="pending">${money(d.stats.pendingCents)}</b></div><div><small>Approved</small><b class="approved">${money(d.stats.approvedCents)}</b></div><div><small>Paid</small><b class="paid">${money(d.stats.paidCents)}</b></div></div><div style="display:flex;gap:9px;margin-top:16px"><select class="field" .value=${this.payoutMethod} @change=${(e:Event)=>this.payoutMethod=(e.target as HTMLSelectElement).value}><option value="wise">Wise</option><option value="paypal">PayPal</option><option value="bank">Bank transfer</option></select><button class="btn gold" ?disabled=${this.busy || d.stats.approvedCents < d.settings.minPayoutCents} @click=${()=>this.requestPayout()}>Request payout</button></div></div>
      <div class="panel"><h2>Partner tier</h2><div class="tier"><span class="eyebrow">Current tier</span><strong>${d.stats.tier?.name ?? "Starter"}</strong><p>${((d.stats.tier?.firstRateBps ?? d.settings.defaultRateBps)/100).toFixed(0)}% on first payments · ${((d.settings.recurringRateBps)/100).toFixed(0)}% recurring</p><div class="progress"><i style=${`width:${progress}%`}></i></div><p>${d.stats.nextTier ? `${d.stats.nextTier.minConversions-d.stats.conversions} conversions to ${d.stats.nextTier.name}` : "Top tier unlocked"}</p></div></div></div>
      <div class="panel section"><div class="section-head"><div><span class="eyebrow">Campaign tools</span><h2>Link builder</h2></div><small>Works on every site and app page</small></div><div class="builder"><input class="field" aria-label="Destination path" .value=${this.buildPath} @input=${(e:Event)=>this.buildPath=(e.target as HTMLInputElement).value}><button class="btn" @click=${()=>navigator.clipboard.writeText(this.link())}>Copy campaign link</button></div><div class="link campaign-link" style="margin-top:12px;color:#9d9789">${this.link()}</div></div>
      <div class="panel section"><div class="section-head"><div><span class="eyebrow">Marketplace mode</span><h2>Curate your plugin storefront</h2></div><a class="btn" href=${`/store/${encodeURIComponent(a.vanityCode || a.code)}`}>Open storefront</a></div><div class="store-builder"><input class="field" aria-label="Plugin ID" placeholder="Plugin ID" .value=${this.storePlugin} @input=${(e:Event)=>this.storePlugin=(e.target as HTMLInputElement).value}><input class="field" type="url" aria-label="Custom purchase URL" placeholder="Custom HTTPS purchase URL (optional)" .value=${this.storeUrl} @input=${(e:Event)=>this.storeUrl=(e.target as HTMLInputElement).value}><input class="field wide" aria-label="Storefront headline" placeholder="Headline for this plugin" .value=${this.storeHeadline} @input=${(e:Event)=>this.storeHeadline=(e.target as HTMLInputElement).value}><input class="field wide" aria-label="Affiliate note" placeholder="Why you recommend it" .value=${this.storeNote} @input=${(e:Event)=>this.storeNote=(e.target as HTMLInputElement).value}><button class="btn gold wide" ?disabled=${this.busy || !this.storePlugin.trim()} @click=${()=>this.saveStorefront()}>Save storefront plugin</button></div><div class="saved-links">${d.storefrontLinks.map(l=>html`<div class="saved-link"><b>${l.pluginId}</b><span>${l.adminDisabled ? "Disabled by admin" : l.enabled ? l.customPurchaseUrl ? "Custom purchase link" : "Marketplace purchase link" : "Hidden"}</span></div>`)}</div></div>
      <div class="panel section"><div class="section-head"><div><span class="eyebrow">Latest activity</span><h2>Commission ledger</h2></div><small>${d.commissions.length} recent entries</small></div><div class="table-wrap"><table class="ledger-table"><thead><tr><th>Date</th><th>Type</th><th>Sale</th><th>Rate</th><th>Status</th><th>Commission</th></tr></thead><tbody>${d.commissions.map(c=>html`<tr><td>${new Date(c.createdAt).toLocaleDateString()}</td><td>${c.kind.replace("_"," ")}</td><td>${money(c.grossCents)}</td><td>${(c.rateBps/100).toFixed(1)}%</td><td><span class="pill">${c.status}</span></td><td>${money(c.commissionCents)}</td></tr>`)}</tbody></table></div></div>
      <div class="panel section"><div class="section-head"><div><span class="eyebrow">Disbursements</span><h2>Payout history</h2></div><small>Manual, reference-tracked payouts</small></div>${d.payouts.length?html`<div class="table-wrap"><table class="payout-table"><thead><tr><th>Date</th><th>Method</th><th>Status</th><th>Amount</th></tr></thead><tbody>${d.payouts.map(p=>html`<tr><td>${new Date(p.requestedAt).toLocaleDateString()}</td><td>${p.method}</td><td><span class="pill">${p.status}</span></td><td>${money(p.amountCents)}</td></tr>`)}</tbody></table></div>`:html`<div class="empty">No payouts yet.</div>`}</div>`;
  }
}

declare global { interface HTMLElementTagNameMap { "ib-affiliate-dashboard": AffiliateDashboard } }
