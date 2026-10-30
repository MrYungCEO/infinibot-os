/**
 * Business hub › Revenue — one ledger for every Whop company and Stripe
 * account (read-only to the providers): net revenue, MRR/ARR, churn, LTV,
 * revenue by month / product / source / campaign, cohorts, the ledger itself,
 * and per-account sync + reconciliation status.
 */

import { html, nothing, type TemplateResult } from "lit";
import { gatewayOrigin } from "../../../gateway-endpoint";
import type { BusinessHubApp } from "../app";
import { areaChart, barList, cohortGrid, donut, stackedAreaChart } from "../charts";
import { date, money, num, pct, relTime } from "../format";
import { icons } from "../icons";
import { emptyState, formValues, kpi, modal, periodPicker, searchBox, skeletonKpis } from "./ui";

type SyncState = { object: string; cursor: boolean; backfillDone: boolean; highWater: number | null; fetched: number; pages: number; lastRunAt: number | null; lastError: string | null };
type Account = { id: string; provider: "whop" | "stripe" | "legacy"; label: string; companyRef: string | null; apiVersion: string | null; keyKind: string; keyRefName: string | null; hasWebhookSecret: boolean; status: string; lastSyncAt: number | null; lastError: string | null; sync: SyncState[]; counts: { txns: Record<string, number>; subscriptions: number; products: number } };
type Candidate = { provider: "whop" | "stripe"; fingerprint: string; label: string; sources: Array<{ source: string; detail: string }>; secretRef: string | null; companyRef: string | null; alreadyConnected: string | null; companyConnected: string | null };
type Summary = {
  grossCents: number; netCents: number; feeCents: number; refundCents: number; chargeCount: number; activeSubscriptions: number; churnRate: number | null;
  totals: { grossCents: number; refundsCents: number; feesCents: number; disputesLostCents: number; netCents: number; count: number; avgOrderCents: number; customers: number; newCustomers: number; returningCustomers: number; unconvertedCount: number };
  mrrCents: number; arrCents: number; mrrSource: string; activeSubscribers: number;
  churn: { rate: number | null; canceled: number; activeAtStart: number; windowDays: number };
  ltv: { cents: number; method: string };
  byMonth: Array<{ month: string; grossCents: number; refundsCents: number; netCents: number; count: number; customers: number }>;
  byProduct: Array<{ product: string; grossCents: number; count: number }>;
  byProductPlan: Array<{ product: string; plan: string | null; grossCents: number; count: number }>;
  byProject: Array<{ project: string; grossCents: number; count: number }>;
  byRevenueSource: Array<{ accountId: string; source: string; provider: string; grossCents: number; refundsCents: number; feesCents: number; netCents: number; count: number }>;
  byTime: { daily: Array<{ period: string; grossCents: number; netCents: number; count: number }>; weekly: Array<{ period: string; grossCents: number; netCents: number; count: number }>; monthly: Array<{ period: string; grossCents: number; netCents: number; count: number }> };
  sourceSeries: Array<{ source: string; points: Array<{ period: string; grossCents: number; netCents: number }> }>;
  revenueMix: { recurringCents: number; oneTimeCents: number; recurringCount: number; oneTimeCount: number };
  byAccount: Array<{ accountId: string; label: string; provider: string; grossCents: number; refundsCents: number; netCents: number; count: number }>;
  bySource: Array<{ sourceId: string | null; name: string; grossCents: number; count: number; customers: number }>;
  byCampaign: Array<{ campaignId: string | null; name: string; grossCents: number; count: number; customers: number }>;
  cohorts: Array<{ cohort: string; customers: number; cells: Array<{ offset: number; revenueCents: number; retained: number }> }>;
  topCustomers: Array<{ key: string; contactId: string | null; clientId: string | null; email: string | null; name: string | null; grossCents: number; count: number }>;
  refunds: Array<{ id: string; type: string; status: string; amountCents: number; currency: string; occurredAt: number; customerEmail: string | null; product: string | null }>;
  previousPeriod: { grossCents: number; netCents: number; feeCents: number; refundsCents: number; disputesLostCents: number; mrrCents: number } | null;
  arAging: ArAging;
};
type Txn = { id: string; accountId: string; provider: string; externalId: string; type: string; status: string; grossCents: number; feeCents: number; netCents: number; refundedCents: number; currency: string; occurredAt: number; productName: string | null; customerEmail: string | null; customerName: string | null; contactId: string | null };
type Reconcile = { ok: boolean; method: string; provider: { count: number | null; gross?: number | null; refunds?: number | null }; ledger: { count: number; gross: number; refunds: number }; diff: { count: number | null; gross?: number | null; refunds?: number | null }; pages: number };
type ArAging = { asOf: number; totalCents: number; overdueCents: number; buckets: Array<{ id: string; label: string; cents: number; count: number }>; invoices: Array<{ invoiceId: string; number: string; clientId: string | null; client: string; agency: string; status: string; originalStatus: string; currency: string; totalCents: number; paidCents: number; balanceCents: number; dueAt: number | null; daysOverdue: number; bucket: string; open: boolean }> };
type ProjectMapping = { key: string; accountId: string; productId: string | null; productName: string; project: string; explicit: boolean; sourceLabel: string; sourceProvider: string; catalog: boolean };

const PROJECTS = ["InfiniBot Cloud", "FlyPic", "Robovoice", "InfiniBot plugins", "Infinitrade", "Courses / digital products", "KinglyVault", "Agency clients"];

function compareText(current: number, previous: number | null | undefined): string {
  if (previous === null || previous === undefined) return "previous period loading…";
  if (previous === 0) return current === 0 ? "0% vs previous period" : "new vs $0 previous period";
  const change = (current - previous) / Math.abs(previous);
  return `${change >= 0 ? "▲" : "▼"} ${pct(Math.abs(change))} vs previous period`;
}

const PROVIDER_LABEL: Record<string, string> = { whop: "Whop", stripe: "Stripe", legacy: "Imported" };

function connectModal(h: BusinessHubApp): TemplateResult {
  const disc = h.load<{ candidates: Candidate[] }>("rev:discover", "hub.revenue.accounts.discover", {}, { maxAgeMs: 30_000 });
  const provider = (h.ui.revProvider as "whop" | "stripe") ?? "whop";
  const keyMode = (h.ui.revKeyMode as "paste" | "ref") ?? "paste";
  const cands = (disc.data?.candidates ?? []).filter((c) => !c.alreadyConnected);
  return modal(
    h,
    "Connect revenue",
    html`${cands.length
        ? html`<h3 style="margin-bottom:8px">Found on this machine</h3>
          <div class="stack" style="margin-bottom:16px">${cands.map((c) => html`<div class="glass card" style="padding:12px"><div class="row" style="justify-content:space-between;flex-wrap:wrap">
            <div><b>${PROVIDER_LABEL[c.provider]} · ${c.label}</b><div class="faint small">key ${c.fingerprint} · ${c.sources.map((s) => s.detail).join(", ")}${c.companyConnected ? " · this company is already connected with another key" : ""}</div></div>
            <button class="btn sm primary" ?disabled=${Boolean(c.companyConnected)} @click=${async () => { const r = await h.act("hub.revenue.accounts.connect", { candidate: c.fingerprint }, "Connected — importing every payment since day one", "rev"); if (r) { h.ui.modal = null; h.refresh(); } }}>Connect</button></div></div>`)}</div>
          <div class="divider"></div>`
        : nothing}
      <div class="chips" style="margin-bottom:12px">${(["whop", "stripe"] as const).map((p) => html`<button class="chip" aria-pressed=${provider === p} @click=${() => { h.ui.revProvider = p; h.refresh(); }}>${PROVIDER_LABEL[p]}</button>`)}</div>
      <form class="stack" @submit=${(e: Event) => e.preventDefault()}>
        <div class="field-row"><label class="field">Label<input class="input" name="label" required placeholder=${provider === "whop" ? "KinglyVault (Whop)" : "Main Stripe"} /></label>
          ${provider === "whop" ? html`<label class="field">Company id<input class="input" name="companyRef" placeholder="biz_…" /></label>` : nothing}</div>
        <div class="chips"><button type="button" class="chip" aria-pressed=${keyMode === "paste"} @click=${() => { h.ui.revKeyMode = "paste"; h.refresh(); }}>Paste key</button><button type="button" class="chip" aria-pressed=${keyMode === "ref"} @click=${() => { h.ui.revKeyMode = "ref"; h.refresh(); }}>Read from an env file</button></div>
        ${keyMode === "paste"
          ? html`<label class="field">${provider === "whop" ? "Whop API key" : "Stripe restricted key (read-only)"}<input class="input" name="secret" type="password" autocomplete="off" required placeholder=${provider === "whop" ? "apik_…" : "rk_live_…"} /></label>`
          : html`<label class="field">Key reference <span class="faint">(the key is read at sync time and never copied)</span><input class="input mono" name="secretRef" required placeholder="env-file:/path/to/.env#WHOP_API_KEY  or  env:STRIPE_API_KEY" /></label>`}
        <label class="field">Webhook signing secret <span class="faint">(optional — instant updates)</span><input class="input" name="webhookSecret" type="password" autocomplete="off" placeholder=${provider === "whop" ? "ws_…" : "whsec_…"} /></label>
        <div class="faint small">${provider === "stripe" ? "Create a restricted key with read access to Charges, Invoices, Subscriptions, Refunds, Disputes, Payouts and Balance." : "A company API key reads the full history; legacy app keys are detected automatically."} InfiniBot only ever reads — it never creates, changes or refunds anything.</div>
      </form>`,
    html`<button class="btn" @click=${() => { h.ui.modal = null; h.refresh(); }}>Cancel</button>
      <button class="btn primary" @click=${async (e: Event) => {
        const form = (e.target as HTMLElement).closest(".modal")!.querySelector("form") as HTMLFormElement;
        if (!form.reportValidity()) return;
        const v = formValues(form);
        const r = await h.act("hub.revenue.accounts.connect", { provider, label: v.label, companyRef: v.companyRef || undefined, secret: v.secret || undefined, secretRef: v.secretRef || undefined, webhookSecret: v.webhookSecret || undefined }, "Connected — importing every payment since day one", "rev");
        if (r) { h.ui.modal = null; h.refresh(); }
      }}>Connect & import history</button>`,
    true,
  );
}

function accountCard(h: BusinessHubApp, a: Account, running: boolean): TemplateResult {
  const rec = h.cache[`rev:rec:${a.id}`]?.data as Reconcile | undefined;
  const pays = a.counts.txns.charge ?? 0;
  const backfilling = a.sync.some((s) => !s.backfillDone);
  const errored = a.status === "error" || a.sync.some((s) => s.lastError);
  return html`<section class="glass card">
    <div class="card-head" style="flex-wrap:wrap">
      <div><h2>${a.label}</h2><div class="faint small">${PROVIDER_LABEL[a.provider] ?? a.provider}${a.companyRef ? ` · ${a.companyRef}` : ""}${a.apiVersion ? ` · API ${a.apiVersion}` : ""} · key ${a.keyKind === "env-file" || a.keyKind === "env" ? `from ${a.keyRefName ?? a.keyKind}` : a.keyKind}</div></div>
      <span class="chip ${running ? "gold" : errored ? "bad" : backfilling ? "warn" : "ok"}">${running ? "syncing…" : errored ? "error" : backfilling ? "backfill pending" : "up to date"}</span>
    </div>
    <div class="row" style="flex-wrap:wrap;gap:16px;margin-bottom:10px">
      <div><div class="faint small">Payments</div><b class="num">${num(pays)}</b></div>
      <div><div class="faint small">Refunds</div><b class="num">${num(a.counts.txns.refund ?? 0)}</b></div>
      <div><div class="faint small">Disputes</div><b class="num">${num(a.counts.txns.dispute ?? 0)}</b></div>
      <div><div class="faint small">Subscriptions</div><b class="num">${num(a.counts.subscriptions)}</b></div>
      <div><div class="faint small">Last sync</div><b>${relTime(a.lastSyncAt)}</b></div>
    </div>
    ${a.sync.length ? html`<div class="chips" style="margin-bottom:10px">${a.sync.map((s) => html`<span class="chip ${s.lastError ? "bad" : s.backfillDone ? "" : "warn"}" title=${s.lastError ?? `${s.pages} pages`}>${s.object} ${num(s.fetched)}${s.backfillDone ? "" : " · backfilling"}</span>`)}</div>` : nothing}
    ${a.lastError ? html`<div class="bad small" style="margin-bottom:10px">${a.lastError}</div>` : nothing}
    ${rec ? html`<div class="banner glass"><span class=${rec.ok ? "ok" : "warn"}>●</span><span style="flex:1">${rec.ok ? "Matches" : "Differs from"} ${PROVIDER_LABEL[a.provider]}: provider ${num(rec.provider.count)} payments${rec.provider.gross !== undefined ? ` / ${money(rec.provider.gross)}` : ""} · ledger ${num(rec.ledger.count)} / ${money(rec.ledger.gross)}</span></div>` : nothing}
    <div class="row" style="flex-wrap:wrap">
      ${a.provider !== "legacy" ? html`
        <button class="btn sm" ?disabled=${running} @click=${() => h.act("hub.revenue.sync", { accountId: a.id, mode: "incremental" }, "Sync started", "rev")}>${icons.refresh()} Sync now</button>
        <button class="btn sm" ?disabled=${running} @click=${() => { if (confirm("Re-read the full history from the provider? Nothing is duplicated.")) void h.act("hub.revenue.sync", { accountId: a.id, mode: "backfill" }, "Full re-import started", "rev"); }}>Re-import history</button>
        <button class="btn sm" @click=${async () => { const r = await h.act<Reconcile>("hub.revenue.reconcile", { accountId: a.id }, (x) => (x.ok ? "Ledger matches the provider" : "Ledger differs — see the account card")); if (r) { h.cache[`rev:rec:${a.id}`] = { at: Date.now(), data: r }; h.refresh(); } }}>${icons.shield()} Reconcile</button>` : nothing}
      <span class="spacer" style="flex:1"></span>
      <button class="btn sm ghost danger" @click=${() => { if (confirm(`Disconnect ${a.label}? Its ledger rows are kept.`)) void h.act("hub.revenue.accounts.remove", { id: a.id }, "Disconnected", "rev"); }}>Disconnect</button>
    </div>
    ${a.provider !== "legacy" ? html`<div class="faint small" style="margin-top:8px">Webhook (optional, instant updates): <span class="mono">${gatewayOrigin()}/plugins/business-agency/webhooks/revenue?provider=${a.provider}&account=${a.id}</span>${a.hasWebhookSecret ? "" : " — add its signing secret to enable"}</div>` : nothing}
  </section>`;
}

export function renderRevenue(h: BusinessHubApp): TemplateResult {
  const accounts = h.load<{ accounts: Account[] }>("rev:accounts", "hub.revenue.accounts.list", {}, { maxAgeMs: 10_000 });
  const status = h.load<{ running: string[] }>("rev:status", "hub.revenue.syncStatus", {}, { maxAgeMs: 4000 });
  const running = new Set(status.data?.running ?? []);
  if (running.size) h.pollers.set("rev", () => { h.invalidate("rev:status"); h.invalidate("rev:accounts"); h.invalidate("rev:sum"); });
  else h.pollers.delete("rev");
  const list = accounts.data?.accounts ?? [];
  const r = h.range();
  const sum = h.load<Summary>(`rev:sum:${h.period}`, "hub.revenue.summary", { from: r.from, to: r.to });
  const allTime = h.period === "all" ? sum : h.load<Summary>("rev:sum:all", "hub.revenue.summary", {}, { maxAgeMs: 60_000 });
  const tab = (h.ui.revTab as string) ?? "overview";
  const md = (h.ui.modal as { kind?: string } | null)?.kind;

  if (accounts.data && !list.length)
    return html`${emptyState({
      icon: "revenue",
      title: "Connect your revenue",
      text: "Link every Whop company and Stripe account. The hub imports every payment, refund, dispute and subscription since day one, keeps them in sync, and ties each payment to the customer, deal and campaign it came from. Read-only — nothing is ever changed on Whop or Stripe.",
      actions: [{ label: "Connect Whop or Stripe", primary: true, run: () => { h.ui.modal = { kind: "connect" }; h.refresh(); } }],
    })}${md === "connect" ? connectModal(h) : nothing}`;

  const s = sum.data;
  const all = allTime.data;
  const previous = s?.previousPeriod ?? null;
  return html`
    <div class="toolbar">
      <div class="chips">${[["overview", "Overview"], ["breakdowns", "Breakdowns"], ["invoices", "Invoices & AR"], ["ledger", "Ledger"], ["mappings", "Project mapping"], ["accounts", `Accounts ${list.length}`]].map(([id, l]) => html`<button class="chip" aria-pressed=${tab === id} @click=${() => { h.ui.revTab = id; h.refresh(); }}>${l}</button>`)}</div>
      ${running.size ? html`<span class="chip gold">${icons.refresh()} syncing ${running.size}</span>` : nothing}
      <span class="spacer"></span>
      ${tab !== "accounts" ? periodPicker(h) : nothing}
      <button class="btn" @click=${() => { h.ui.modal = { kind: "connect" }; h.refresh(); }}>${icons.plus()} Connect account</button>
    </div>
    ${tab === "accounts"
      ? html`<div class="grid cols-2e">${list.map((a) => accountCard(h, a, running.has(a.id)))}</div>`
      : tab === "ledger"
        ? ledgerView(h)
        : tab === "mappings"
          ? mappingView(h)
        : !s
          ? skeletonKpis(6)
          : tab === "breakdowns"
            ? breakdownView(h, s)
            : tab === "invoices"
              ? invoiceView(h, s.arAging)
          : html`
            <div class="revenue-range glass">
              <div><span class="eyebrow">Active period · ${h.period === "365d" ? "12 months" : h.period === "all" ? "All time" : h.period.toUpperCase()}</span><b>${h.period === "all" ? "All time" : `${new Date(r.from ?? 0).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} – ${new Date(r.to).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}</b></div>
              <span class="chip ${previous ? (s.netCents >= previous.netCents ? "ok" : "warn") : ""}">
                ${h.period === "all" ? "Complete history" : compareText(s.netCents, previous?.netCents)}
              </span>
            </div>
            <div class="kpis k6">
              ${kpi({ label: "Gross revenue", value: money(s.grossCents, "USD", { compact: true }), foot: h.period === "all" ? `${num(s.chargeCount)} collected payments` : compareText(s.grossCents, previous?.grossCents) })}
              ${kpi({ label: "Net revenue", value: money(s.netCents, "USD", { compact: true }), foot: h.period === "all" ? "after fees, refunds & disputes" : compareText(s.netCents, previous?.netCents) })}
              ${kpi({ label: "Fees", value: money(s.feeCents, "USD", { compact: true }), foot: h.period === "all" ? `${s.grossCents ? pct(s.feeCents / s.grossCents, 1) : "—"} of gross` : compareText(s.feeCents, previous?.feeCents) })}
              ${kpi({ label: "Refunds", value: money(s.totals.refundsCents, "USD", { compact: true }), foot: h.period === "all" ? `${s.grossCents ? pct(s.totals.refundsCents / s.grossCents, 1) : "—"} of gross` : compareText(s.totals.refundsCents, previous?.refundsCents) })}
              ${kpi({ label: "Disputes", value: money(s.totals.disputesLostCents, "USD", { compact: true }), foot: h.period === "all" ? "lost disputes" : compareText(s.totals.disputesLostCents, previous?.disputesLostCents) })}
              ${kpi({ label: "MRR", value: money(s.mrrCents, "USD", { compact: true }), foot: h.period === "all" ? `ARR ${money(s.arrCents, "USD", { compact: true })} · ${s.mrrSource === "subscriptions" ? "from subscriptions" : s.mrrSource === "recurring_charges" ? "from recurring charges" : "no recurring revenue"}` : compareText(s.mrrCents, previous?.mrrCents) })}
            </div>
            ${s.totals.unconvertedCount ? html`<div class="faint small" style="margin:-6px 0 12px">${num(s.totals.unconvertedCount)} non-USD payments have no USD value from the provider and are shown per currency only.</div>` : nothing}
            <div class="grid cols-2" style="margin-bottom:16px">
              <section class="glass card"><div class="card-head"><h2>Revenue by source</h2><span class="meta">${h.period === "all" ? "all time" : h.period} · stacked gross</span></div>
                ${stackedAreaChart(s.sourceSeries.slice(0, 6).map((source) => ({ label: source.source, points: source.points.slice(-18).map((point) => ({ label: point.period, value: point.grossCents })) })), { format: (v) => money(v, "USD", { compact: true }), empty: "Payments appear after the first sync." })}</section>
              <section class="glass card"><div class="card-head"><h2>Revenue by project</h2></div>
                ${donut(s.byProject.map((project) => ({ label: project.project, value: Math.max(0, project.grossCents) })), { value: money(s.grossCents, "USD", { compact: true }), label: "gross" })}</section>
            </div>
            <div class="grid cols-3" style="margin-bottom:16px">
              <section class="glass card"><div class="card-head"><h2>Recurring vs one-time</h2></div>${donut([{ label: "Recurring", value: s.revenueMix.recurringCents }, { label: "One-time", value: s.revenueMix.oneTimeCents }], { value: money(s.grossCents, "USD", { compact: true }), label: "gross" })}</section>
              <section class="glass card"><div class="card-head"><h2>Customers</h2></div>${barList(s.topCustomers.slice(0, 8).map((p) => ({ label: p.name ?? p.email ?? "Customer", value: p.grossCents, sub: `${p.count} payments` })), { format: (v) => money(v, "USD", { compact: true }) })}</section>
              <section class="glass card"><div class="card-head"><h2>Receivables</h2><button class="btn sm" @click=${() => { h.ui.revTab = "invoices"; h.refresh(); }}>Open AR</button></div>${barList(s.arAging.buckets.map((bucket) => ({ label: bucket.label, value: bucket.cents, sub: `${bucket.count} invoices` })), { format: (v) => money(v, "USD", { compact: true }), empty: "No outstanding invoices." })}</section>
            </div>
            <div class="grid cols-2">
              <section class="glass card"><div class="card-head"><h2>Cohort retention</h2><span class="meta">% of customers paying again, by first-purchase month</span></div>
                ${cohortGrid((all?.cohorts ?? []).slice(-12).map((c) => ({ cohort: c.cohort, size: c.customers, cells: c.cells.map((x) => (c.customers ? x.retained / c.customers : null)) })))}</section>
              <section class="glass card"><div class="card-head"><h2>Top customers</h2></div>
                ${s.topCustomers.length ? html`<div class="list">${s.topCustomers.slice(0, 10).map((c) => html`<div class="li ${c.contactId ? "click" : ""}" @click=${() => c.contactId && h.openDetail({ kind: "contact", id: c.contactId })}><div class="grow"><b>${c.name ?? c.email ?? "Customer"}</b><span>${c.email ?? ""} · ${c.count} ${c.count === 1 ? "payment" : "payments"}</span></div><b class="num">${money(c.grossCents)}</b></div>`)}</div>` : html`<div class="empty-mini">No customers in this period.</div>`}
              </section>
            </div>`}
    ${md === "connect" ? connectModal(h) : nothing}
  `;
}

function breakdownView(h: BusinessHubApp, s: Summary): TemplateResult {
  const granularity = (h.ui.revGranularity as "daily" | "weekly" | "monthly") ?? "monthly";
  const timeline = s.byTime[granularity];
  const outstanding = new Map<string, number>();
  for (const invoice of s.arAging.invoices) {
    if (invoice.clientId)
      outstanding.set(invoice.clientId, (outstanding.get(invoice.clientId) ?? 0) + invoice.balanceCents);
  }
  return html`
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="glass card">
        <div class="card-head"><h2>Revenue over time</h2><div class="chips">${(["daily", "weekly", "monthly"] as const).map((value) => html`<button class="chip" aria-pressed=${granularity === value} @click=${() => { h.ui.revGranularity = value; h.refresh(); }}>${value}</button>`)}</div></div>
        ${areaChart(timeline.map((point) => ({ label: point.period, value: point.netCents })), {
          format: (value) => money(value, "USD", { compact: true }),
          empty: "No collected revenue in this range.",
          ariaLabel: `Net revenue by ${granularity}`,
        })}
      </section>
      <section class="glass card"><div class="card-head"><h2>Project / brand</h2><span class="meta">editable product mapping</span></div>
        ${barList(s.byProject.map((row) => ({ label: row.project, value: row.grossCents, sub: `${row.count} transactions` })), { format: (value) => money(value, "USD", { compact: true }) })}
      </section>
    </div>
    <section class="glass card" style="margin-bottom:16px">
      <div class="card-head"><h2>Source reconciliation</h2><span class="meta">gross → refunds → fees → net</span></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Source</th><th>Status</th><th class="r">Gross</th><th class="r">Refunds</th><th class="r">Fees</th><th class="r">Net</th><th class="r">Payments</th></tr></thead>
        <tbody>${s.byRevenueSource.map((source) => {
          const rec = h.cache[`rev:rec:${source.accountId}`]?.data as Reconcile | undefined;
          const local = source.provider === "invoice" || source.provider === "legacy" || source.provider === "manual";
          return html`<tr><td><b>${source.source}</b></td><td>
            ${local
              ? html`<span class="chip ok">ledger ✓</span>`
              : rec
                ? html`<span class="chip ${rec.ok ? "ok" : "warn"}" title=${rec.provider.gross == null ? "Provider API exposes payment count, not an aggregate gross total." : rec.method}>${rec.ok
                    ? rec.provider.gross == null ? "count reconciled ✓" : "reconciled ✓"
                    : rec.diff.gross != null ? `differs by ${money(Math.abs(rec.diff.gross))}` : `${Math.abs(rec.diff.count ?? 0)} payments differ`}</span>`
                : html`<button class="chip" @click=${async () => {
                    const result = await h.act<Reconcile>("hub.revenue.reconcile", { accountId: source.accountId }, null);
                    if (result) {
                      h.cache[`rev:rec:${source.accountId}`] = { at: Date.now(), data: result };
                      h.refresh();
                    }
                  }}>check reconciliation</button>`}
          </td><td class="r num">${money(source.grossCents)}</td><td class="r num">${money(source.refundsCents)}</td><td class="r num">${money(source.feesCents)}</td><td class="r num"><b>${money(source.netCents)}</b></td><td class="r num">${num(source.count)}</td></tr>`;
        })}</tbody>
      </table></div>
    </section>
    <div class="grid cols-2">
      <section class="glass card"><div class="card-head"><h2>Product & plan</h2></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th>Plan</th><th class="r">Gross</th><th class="r">Sales</th></tr></thead>
        <tbody>${s.byProductPlan.slice(0, 50).map((row) => html`<tr><td><b>${row.product}</b></td><td class="faint mono">${row.plan ?? "—"}</td><td class="r num">${money(row.grossCents)}</td><td class="r num">${num(row.count)}</td></tr>`)}</tbody></table></div>
      </section>
      <section class="glass card"><div class="card-head"><h2>Top clients / customers</h2><span class="meta">collected + open balance</span></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Client</th><th class="r">Collected</th><th class="r">Outstanding</th><th class="r">Payments</th></tr></thead>
        <tbody>${s.topCustomers.map((row) => html`<tr class=${row.contactId || row.clientId ? "click" : ""} @click=${() => row.clientId ? h.openDetail({ kind: "client", id: row.clientId }) : row.contactId && h.openDetail({ kind: "contact", id: row.contactId })}><td><b>${row.name ?? row.email ?? "Customer"}</b><div class="faint small">${row.email ?? ""}</div></td><td class="r num">${money(row.grossCents)}</td><td class="r num">${money(row.clientId ? (outstanding.get(row.clientId) ?? 0) : 0)}</td><td class="r num">${num(row.count)}</td></tr>`)}</tbody></table></div>
      </section>
    </div>
  `;
}

function invoiceStatusLabel(invoice: ArAging["invoices"][number]): string {
  return invoice.status === "overdue" && invoice.originalStatus === "partially_paid"
    ? "partially paid · overdue"
    : invoice.status.replace("_", " ");
}

function invoiceView(h: BusinessHubApp, aging: ArAging): TemplateResult {
  return html`
    <div class="kpis">
      ${kpi({ label: "Accounts receivable", value: money(aging.totalCents, "USD", { compact: true }), foot: `${aging.invoices.filter((invoice) => invoice.open).length} open invoices` })}
      ${kpi({ label: "Overdue", value: money(aging.overdueCents, "USD", { compact: true }), foot: `${aging.invoices.filter((invoice) => invoice.open && invoice.daysOverdue > 0).length} past due` })}
      ${aging.buckets.map((bucket) => kpi({ label: bucket.label, value: money(bucket.cents, "USD", { compact: true }), foot: `${bucket.count} invoices` }))}
    </div>
    <section class="glass card" style="margin-bottom:16px"><div class="card-head"><h2>AR aging</h2><span class="meta">current / 30 / 60 / 90+</span></div>
      ${barList(aging.buckets.map((bucket) => ({ label: bucket.label, value: bucket.cents, sub: `${bucket.count} invoices` })), { format: (value) => money(value, "USD", { compact: true }), empty: "Nothing outstanding — all invoices are settled." })}
    </section>
    <section class="glass card"><div class="card-head"><h2>Client invoices</h2><span class="meta">issued, partial, overdue and paid state lives in the unified ledger</span></div>
      ${aging.invoices.length
        ? html`<div class="table-wrap invoice-table-wrap"><table class="table"><thead><tr><th>Invoice</th><th>Client</th><th>Status</th><th>Due</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Balance</th></tr></thead>
          <tbody>${aging.invoices.map((invoice) => {
            const status = invoiceStatusLabel(invoice);
            return html`<tr class=${invoice.clientId ? "click" : ""} @click=${() => invoice.clientId && h.openDetail({ kind: "client", id: invoice.clientId })}><td><b>${invoice.number}</b></td><td><span class=${invoice.clientId ? "drill-link" : ""}>${invoice.client}${invoice.clientId ? " ›" : ""}</span><div class="faint small">${invoice.agency}</div></td><td><span class="chip ${invoice.open && invoice.daysOverdue > 0 ? "bad" : invoice.originalStatus === "partially_paid" ? "warn" : "ok"}">${status}</span></td><td class="faint">${invoice.dueAt ? date(invoice.dueAt) : "No due date"}${invoice.open && invoice.daysOverdue ? html`<div class="bad small">${invoice.daysOverdue}d overdue</div>` : nothing}</td><td class="r num">${money(invoice.totalCents, invoice.currency)}</td><td class="r num">${money(invoice.paidCents, invoice.currency)}</td><td class="r num"><b>${money(invoice.balanceCents, invoice.currency)}</b></td></tr>`;
          })}</tbody>
        </table></div>
        <div class="invoice-cards">${aging.invoices.map((invoice) => html`
          <button class="invoice-card" @click=${() => invoice.clientId && h.openDetail({ kind: "client", id: invoice.clientId })}>
            <span class="invoice-card-head"><b>${invoice.number}</b><span class="chip ${invoice.open && invoice.daysOverdue > 0 ? "bad" : invoice.originalStatus === "partially_paid" ? "warn" : "ok"}">${invoiceStatusLabel(invoice)}</span></span>
            <span class="drill-link">${invoice.client}${invoice.clientId ? " ›" : ""}</span>
            <span class="faint small">${invoice.agency} · ${invoice.dueAt ? `due ${date(invoice.dueAt)}` : "no due date"}</span>
            <span class="invoice-card-money"><span><small>Total</small><b>${money(invoice.totalCents, invoice.currency)}</b></span><span><small>Paid</small><b>${money(invoice.paidCents, invoice.currency)}</b></span><span><small>Balance</small><b>${money(invoice.balanceCents, invoice.currency)}</b></span></span>
          </button>`)}
        </div>`
        : html`<div class="empty-mini">No outstanding client invoices.</div>`}
    </section>
  `;
}

function mappingView(h: BusinessHubApp): TemplateResult {
  const result = h.load<{ projects: ProjectMapping[] }>(
    "rev:mappings",
    "hub.revenue.projectMappings.list",
    {},
    { maxAgeMs: 30_000 },
  );
  const rows = result.data?.projects ?? [];
  const query = ((h.ui.revMappingQ as string) ?? "").trim().toLowerCase();
  const catalogCount = rows.filter((row) => row.catalog).length;
  const customCount = rows.filter((row) => row.explicit).length;
  const sourceName = (row: ProjectMapping) =>
    row.sourceLabel.startsWith("Kingly Systems")
      ? "Whop · Kingly Systems"
      : row.sourceProvider === "whop"
        ? `Whop · ${row.sourceLabel}`
        : row.sourceLabel;
  const visible = query
    ? rows.filter((row) => `${row.productName} ${sourceName(row)} ${row.project}`.toLowerCase().includes(query))
    : rows;
  const save = async (row: ProjectMapping, event: Event) => {
    await h.act("hub.revenue.projectMappings.set", {
      accountId: row.accountId,
      productId: row.productId ?? undefined,
      productName: row.productName,
      project: (event.target as HTMLSelectElement).value,
    }, "Project mapping saved", ["rev:mappings", "rev:sum"]);
  };
  return html`<section class="glass card">
    <div class="card-head"><div><h2>Product → project mapping</h2><div class="faint small">Every synced Whop/Stripe catalog product is listed, even before its first sale. Your edits become durable overrides.</div></div><span class="chip gold">${num(catalogCount)} catalog products</span></div>
    <div class="toolbar" style="margin-bottom:12px">
      ${searchBox(query, (value) => { h.ui.revMappingQ = value; h.refresh(); }, "Search product, source or project")}
      <span class="faint small">${num(rows.length)} total · ${num(customCount)} custom · ${num(visible.length)} shown</span>
    </div>
    ${result.loading
      ? html`<div class="sk" style="height:220px"></div>`
      : visible.length
        ? html`<div class="table-wrap mapping-table"><table class="table"><thead><tr><th>Product</th><th>Project / brand</th><th>Rule</th></tr></thead>
          <tbody>${visible.map((row) => html`<tr><td><b>${row.productName}</b><div class="faint small">${sourceName(row)}</div><div class="faint small mono">${row.productId ?? row.accountId}${row.catalog ? " · catalog" : " · transaction only"}</div></td><td><select class="input" .value=${row.project} @change=${(event: Event) => save(row, event)}>${PROJECTS.map((project) => html`<option value=${project} ?selected=${project === row.project}>${project}</option>`)}</select></td><td><span class="chip ${row.explicit ? "gold" : ""}">${row.explicit ? "custom" : "derived"}</span></td></tr>`)}</tbody>
        </table></div>
        <div class="mapping-cards">${visible.map((row) => html`<article class="mapping-card">
          <div class="mapping-card-head"><div><b>${row.productName}</b><span>${sourceName(row)}</span></div><span class="chip ${row.explicit ? "gold" : ""}">${row.explicit ? "custom" : "derived"}</span></div>
          <div class="faint small mono">${row.productId ?? row.accountId}${row.catalog ? " · catalog" : " · transaction only"}</div>
          <label class="field">Project / brand<select class="input" .value=${row.project} @change=${(event: Event) => save(row, event)}>${PROJECTS.map((project) => html`<option value=${project} ?selected=${project === row.project}>${project}</option>`)}</select></label>
        </article>`)}</div>`
        : html`<div class="empty-mini">${rows.length ? "No products match this search." : "Products appear after the first provider sync."}</div>`}
  </section>`;
}

function ledgerView(h: BusinessHubApp): TemplateResult {
  const q = (h.ui.ledgerQ as string) ?? "";
  const type = (h.ui.ledgerType as string) ?? "";
  const limit = (h.ui.ledgerLimit as number) ?? 100;
  const r = h.range();
  const params = { q: q || undefined, type: type || undefined, from: r.from, to: r.to, limit };
  const res = h.load<{ rows: Txn[]; total: number }>(`rev:ledger:${JSON.stringify(params)}`, "hub.revenue.ledger", params);
  const rows = res.data?.rows ?? [];
  return html`<div class="toolbar">
      ${searchBox(q, (v) => { h.ui.ledgerQ = v; h.refresh(); }, "Search email, name or product")}
      <div class="chips">${[["", "All"], ["charge", "Payments"], ["invoice", "Invoices"], ["refund", "Refunds"], ["dispute", "Disputes"]].map(([k, l]) => html`<button class="chip" aria-pressed=${type === k} @click=${() => { h.ui.ledgerType = k; h.refresh(); }}>${l}</button>`)}</div>
    </div>
    ${!rows.length && !res.loading
      ? html`<div class="glass card empty-mini">No transactions in this range.</div>`
      : html`<div class="glass table-wrap"><table class="table">
          <thead><tr><th>Date</th><th>Customer</th><th class="hide-sm">Product</th><th>Type</th><th class="r">Gross</th><th class="r hide-sm">Fees</th><th class="r">Net</th></tr></thead>
          <tbody>${rows.map((t) => html`<tr class=${t.contactId ? "click" : ""} @click=${() => t.contactId && h.openDetail({ kind: "contact", id: t.contactId })}>
            <td class="faint">${date(t.occurredAt)}</td>
            <td><div class="who"><div class="t"><b>${t.customerName ?? t.customerEmail ?? "—"}</b><span>${t.customerEmail ?? ""}</span></div></div></td>
            <td class="hide-sm">${t.productName ?? "—"}</td>
            <td><span class="chip ${t.type === "refund" || t.type === "dispute" ? "bad" : t.status === "succeeded" ? "ok" : ""}">${t.type}${t.status !== "succeeded" ? ` · ${t.status}` : ""}</span></td>
            <td class="r num">${money(t.type === "charge" ? t.grossCents : -Math.abs(t.grossCents), t.currency)}</td>
            <td class="r num hide-sm faint">${t.feeCents ? money(t.feeCents, t.currency) : "—"}</td>
            <td class="r num">${money(t.type === "charge" ? t.netCents : -Math.abs(t.netCents || t.grossCents), t.currency)}</td>
          </tr>`)}</tbody></table></div>
        <div class="row" style="justify-content:space-between;margin-top:10px"><span class="faint small">${num(rows.length)} of ${num(res.data?.total ?? 0)}</span>${(res.data?.total ?? 0) > rows.length ? html`<button class="btn sm" @click=${() => { h.ui.ledgerLimit = limit + 200; h.refresh(); }}>Show more</button>` : nothing}</div>`}`;
}
