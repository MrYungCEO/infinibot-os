/** Business hub › Overview — KPIs with deltas, revenue + lead charts, the funnel, attention list, activity and setup. */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp, SectionId } from "../app";
import { PERIODS } from "../app";
import { areaChart, barList, funnelChart } from "../charts";
import { ACTIVITY_LABEL, delta, money, num, pct, relTime } from "../format";
import { icons } from "../icons";
import type { OverviewData } from "../types";
import { skeletonKpis, emptyState, periodPicker, kpi } from "./ui";

export function renderOverview(h: BusinessHubApp): TemplateResult {
  const r = h.range();
  const { data, loading, error } = h.load<OverviewData>(`overview:${h.period}`, "hub.overview", { from: r.from, to: r.to });
  if (loading && !data) return html`${skeletonKpis(4)}<div class="grid cols-2"><div class="glass card sk" style="height:300px"></div><div class="glass card sk" style="height:300px"></div></div>`;
  if (!data) return emptyState({ icon: "overview", title: "The hub couldn't load", text: error ?? "No data.", actions: [{ label: "Retry", primary: true, run: () => h.invalidate("overview") }] });

  const rev = data.revenue;
  const revPrev = data.revenuePrev;
  const net = rev?.netCents ?? 0;
  const label = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const toPts = (s: Array<{ day: string; value: number }>) => s.map((p) => ({ label: label(p.day), value: p.value }));
  const setupLeft = data.setup.filter((s) => !s.done);
  const openRate = data.email.sent ? data.email.opened / data.email.sent : null;

  return html`
    ${setupLeft.length
      ? html`<section class="glass card" style="margin-bottom:16px">
          <div class="card-head"><h2>Get the most out of your hub</h2><span class="meta">${data.setup.length - setupLeft.length}/${data.setup.length} done</span></div>
          <div class="setup">
            ${data.setup.map(
              (s) => html`<button class="step ${s.done ? "done" : ""}" @click=${() => h.go(s.section as SectionId)}>
                <span class="tick">${s.done ? "✓" : ""}</span><span>${s.label}</span>
              </button>`,
            )}
          </div>
        </section>`
      : nothing}

    <div class="toolbar">
      ${periodPicker(h)}
      <span class="spacer"></span>
      <span class="faint small">Compared with the previous ${PERIODS.find((p) => p.id === h.period)?.label ?? ""}</span>
      <button class="btn sm ghost" title="Refresh" @click=${() => h.invalidate("overview")}>${icons.refresh()}</button>
    </div>

    <div class="kpis k3">
      ${kpi({
        label: "Net revenue",
        value: money(net, "USD", { compact: true }),
        delta: rev && revPrev ? delta(net, revPrev.netCents) : null,
        foot: rev ? `${num(rev.chargeCount)} payments · ${money(rev.refundCents, "USD", { compact: true })} refunded` : "Connect Whop or Stripe",
        spark: data.series.revenue.map((p) => p.value),
        onClick: () => h.go("revenue"),
      })}
      ${kpi({
        label: "MRR",
        value: rev ? money(rev.mrrCents, "USD", { compact: true }) : "—",
        foot: rev ? `${num(rev.activeSubscriptions)} active subs · churn ${pct(rev.churnRate, 1)}` : "Recurring revenue",
        onClick: () => h.go("revenue"),
      })}
      ${kpi({
        label: "Pipeline",
        value: money(data.pipeline.open.valueCents, "USD", { compact: true }),
        foot: `${data.pipeline.open.count} open · ${money(data.pipeline.wonInPeriod.v, "USD", { compact: true })} won · win rate ${pct(data.pipeline.winRate)}`,
        onClick: () => h.go("pipeline"),
      })}
      ${kpi({
        label: "New leads",
        value: num(data.contacts.newInPeriod),
        delta: delta(data.contacts.newInPeriod, data.contacts.newPrev),
        foot: `${num(data.contacts.leads)} open leads · ${num(data.contacts.customers)} customers`,
        spark: data.series.leads.map((p) => p.value),
        onClick: () => h.go("contacts"),
      })}
      ${kpi({
        label: "Email",
        value: num(data.email.sent),
        delta: delta(data.email.sent, data.email.sentPrev),
        foot: `opens ${pct(openRate)} · replies ${num(data.email.replied)}`,
        spark: data.series.emails.map((p) => p.value),
        onClick: () => h.go("campaigns"),
      })}
      ${kpi({
        label: "Landing pages",
        value: num(data.tracking.visitors),
        delta: delta(data.tracking.pageViews, data.tracking.pageViewsPrev),
        foot: `${num(data.tracking.pageViews)} views · ${num(data.tracking.submits)} form leads`,
        spark: data.series.pageViews.map((p) => p.value),
        onClick: () => h.go("tracking"),
      })}
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="glass card">
        <div class="card-head"><h2>Revenue</h2><span class="meta">${rev ? `${money(rev.grossCents)} gross · ${money(rev.feeCents)} fees` : "No revenue account yet"}</span></div>
        ${areaChart(toPts(data.series.revenue), { format: (v) => money(v, "USD", { compact: true }), empty: rev ? "No payments in this period" : "Connect Whop or Stripe to see revenue", ariaLabel: "Revenue per day" })}
      </section>
      <section class="glass card">
        <div class="card-head"><h2>Funnel</h2><button class="btn sm ghost" @click=${() => h.go("pipeline")}>Open pipeline ${icons.arrowRight()}</button></div>
        ${data.pipeline.stages.some((s) => s.reached)
          ? funnelChart(data.pipeline.stages.filter((s) => s.kind !== "lost").map((s) => ({ label: s.name, value: s.reached, conv: s.conversionFromPrev })))
          : html`<div class="empty-mini">Deals appear here as leads come in. <a href="#" @click=${(e: Event) => { e.preventDefault(); h.go("leads", { leadsCompose: true }); }}>Find leads</a> or <a href="#" @click=${(e: Event) => { e.preventDefault(); h.go("imports"); }}>import a list</a>.</div>`}
      </section>
    </div>

    <div class="grid cols-3" style="margin-bottom:16px">
      <section class="glass card">
        <div class="card-head"><h2>Needs attention</h2>${data.attention.rotting ? html`<span class="chip warn">${data.attention.rotting} stalled</span>` : nothing}</div>
        ${data.attention.dueActions.length
          ? html`<div class="list">${data.attention.dueActions.map(
              (d) => html`<div class="li click" @click=${() => h.openDetail({ kind: "deal", id: d.id })}>
                <span class="chip gold">${d.stage}</span>
                <div class="grow"><b>${d.nextAction || "Follow up"}</b><span>${d.title} · ${money(d.valueCents, "USD", { compact: true })}</span></div>
                <span class="small ${d.nextActionAt < Date.now() ? "bad" : "faint"}">${relTime(d.nextActionAt)}</span>
              </div>`,
            )}</div>`
          : html`<div class="empty-mini">No follow-ups due. Set a next action on a deal and it shows up here (and in kanban).</div>`}
      </section>
      <section class="glass card">
        <div class="card-head"><h2>Hottest leads</h2><button class="btn sm ghost" @click=${() => h.go("contacts", { contactsSort: "score" })}>All</button></div>
        ${data.attention.hotLeads.length
          ? html`<div class="list">${data.attention.hotLeads.map(
              (c) => html`<div class="li click" @click=${() => h.openDetail({ kind: "contact", id: c.id })}>
                ${icons.flame()}
                <div class="grow"><b>${c.name}</b><span>${c.email ?? c.lifecycle}</span></div>
                ${c.score ? html`<span class="score"><i style="--w:${c.score}%"></i>${c.score}</span>` : html`<span class="chip">${c.lifecycle}</span>`}
              </div>`,
            )}</div>`
          : html`<div class="empty-mini">No leads yet.</div>`}
      </section>
      <section class="glass card">
        <div class="card-head"><h2>Upcoming bookings</h2><button class="btn sm ghost" @click=${() => h.go("bookings")}>Calendar</button></div>
        ${data.bookings.next.length
          ? html`<div class="list">${data.bookings.next.map((b) => html`<div class="li ${b.dealId ? "click" : ""}" @click=${() => b.dealId && h.openDetail({ kind: "deal", id: b.dealId })}>
              ${icons.bookings()}<div class="grow"><b>${b.name}</b><span>${b.offerName} · ${new Date(b.startsAt).toLocaleString()}</span></div>
            </div>`)}</div>`
          : html`<div class="empty-mini">No calls booked yet. Each offer can publish its own scheduling page.</div>`}
      </section>
    </div>

    <section class="glass card" style="margin-bottom:16px">
      <div class="card-head"><h2>Where deals come from</h2></div>
      ${barList(
        data.pipeline.bySource.map((s) => ({ label: s.label, value: s.deals, sub: s.won ? `${s.won} won` : undefined })),
        { empty: "Source attribution fills in as leads arrive." },
      )}
    </section>

    <section class="glass card">
      <div class="card-head"><h2>Latest activity</h2></div>
      ${data.recent.length
        ? html`<div class="list">${data.recent.map(
            (a) => html`<div class="li ${a.subjectType === "contact" || a.subjectType === "deal" ? "click" : ""}" @click=${() => (a.subjectType === "contact" || a.subjectType === "deal" || a.subjectType === "company") && h.openDetail({ kind: a.subjectType, id: a.subjectId })}>
              <span class="chip">${ACTIVITY_LABEL[a.type] ?? a.type}</span>
              <div class="grow"><b>${a.subjectName ?? "—"}</b><span>${a.summary}</span></div>
              <span class="faint small">${relTime(a.occurredAt)}</span>
            </div>`,
          )}</div>`
        : html`<div class="empty-mini">Activity from forms, emails, payments and stage moves streams in here.</div>`}
    </section>
  `;
}
