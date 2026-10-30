/**
 * Business hub — the detail side sheet for a contact, company, deal or client.
 * Every record shows its full timeline and links to the records around it
 * (contact ↔ company ↔ deals ↔ client ↔ payments), so nothing is a dead end.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { ACTIVITY_LABEL, date, fromInputDate, LIFECYCLE_LABEL, money, relTime, toInputDate } from "../format";
import { icons } from "../icons";
import type { Activity, Company, Contact, Deal, Pipeline } from "../types";
import { moveWithPrompt } from "./pipeline";
import { avatar, emailStatusChip, formValues, lifecycleChip } from "./ui";

export type DetailRef = { kind: "contact" | "company" | "deal" | "client"; id: string };

type Payment = { id: string; provider: string; type: string; status: string; gross_cents: number; net_cents: number; refunded_cents: number; currency: string; occurred_at: number; product_name: string | null };
type Send = { id: string; subject: string; status: string; sent_at: number | null; opened_at: number | null; clicked_at: number | null; replied_at: number | null; bounced_at: number | null; campaign: string | null };

const TL_COLOR: Record<string, string> = {
  "stage.changed": "var(--bh-gold)",
  payment: "var(--bh-ok)",
  "deal.won": "var(--bh-ok)",
  "client.linked": "var(--bh-ok)",
  "email.bounced": "var(--bh-bad)",
  "email.unsubscribed": "var(--bh-bad)",
  "email.replied": "var(--bh-gold-2)",
  "form.submitted": "var(--bh-gold-2)",
  note: "var(--bh-text-3)",
};

export function timelineView(items: Activity[], empty = "Nothing has happened yet."): TemplateResult {
  if (!items.length) return html`<div class="empty-mini">${empty}</div>`;
  return html`<div class="timeline">${items.map(
    (a) => html`<div class="tl" style="--tl:${TL_COLOR[a.type] ?? "var(--bh-line-strong)"}">
      <div class="tl-head"><span class="chip">${ACTIVITY_LABEL[a.type] ?? a.type}</span><span title=${new Date(a.occurredAt).toLocaleString()}>${relTime(a.occurredAt)}</span>${a.actor && a.actor !== "user" ? html`<span>· ${a.actor}</span>` : nothing}</div>
      <div class="tl-body">${a.summary}</div>
    </div>`,
  )}</div>`;
}

function noteBox(h: BusinessHubApp, subjectType: string, id: string, cacheKey: string): TemplateResult {
  return html`<form class="row" style="margin-bottom:14px" @submit=${async (e: Event) => {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    const ok = await h.act("hub.contacts.note", { id, subjectType, text }, "Note added", cacheKey);
    if (ok) input.value = "";
  }}><input class="input" placeholder="Add a note, call summary or next step…" aria-label="Add note" /><button class="btn" type="submit">Add</button></form>`;
}

function tabs(h: BusinessHubApp, key: string, items: Array<[string, string]>): string {
  const cur = (h.ui[key] as string) ?? items[0][0];
  h.ui[`${key}__render`] = html`<div class="tabs-mini chips">${items.map(([id, label]) => html`<button class="chip" aria-pressed=${cur === id} @click=${() => { h.ui[key] = id; h.refresh(); }}>${label}</button>`)}</div>`;
  return cur;
}

function paymentsTable(rows: Payment[]): TemplateResult {
  if (!rows.length) return html`<div class="empty-mini">No payments linked. Payments from Whop / Stripe attach automatically by email.</div>`;
  return html`<div class="list">${rows.map(
    (p) => html`<div class="li"><span class="chip ${p.type === "refund" ? "bad" : p.status === "succeeded" ? "ok" : ""}">${p.type}</span>
      <div class="grow"><b>${money(p.type === "refund" ? -Math.abs(p.gross_cents) : p.gross_cents, p.currency)}</b><span>${p.product_name ?? p.provider} · ${p.status}${p.refunded_cents ? ` · ${money(p.refunded_cents, p.currency)} refunded` : ""}</span></div>
      <span class="faint small">${date(p.occurred_at)}</span></div>`,
  )}</div>`;
}

function contactView(h: BusinessHubApp, id: string): TemplateResult {
  const res = h.load<{ contact: Contact; company: Company | null; deals: Deal[]; sends: Send[]; payments: Payment[]; visits: { events: number; first: number | null; last: number | null }; source: { name: string; kind: string } | null; campaign: { name: string } | null; suppressed: { reason: string } | null; timeline: Activity[] }>(`contact:${id}`, "hub.contacts.get", { id }, { maxAgeMs: 8000 });
  const d = res.data;
  if (!d) return html`<div class="drawer-body">${res.error ? html`<div class="bad">${res.error}</div>` : html`<div class="sk" style="height:200px"></div>`}</div>`;
  const c = d.contact;
  const offerId = typeof c.custom.offerId === "string" ? c.custom.offerId : null;
  const offer = offerId ? h.load<{ offer: { name: string; valueProp: string } }>(`offer:${offerId}`, "hub.offers.get", { id: offerId }, { maxAgeMs: 30_000 }).data?.offer : null;
  const tab = tabs(h, "detailTab", [["timeline", "Timeline"], ["deals", `Deals ${d.deals.length || ""}`], ["email", `Email ${d.sends.length || ""}`], ["payments", `Payments ${d.payments.length || ""}`], ["edit", "Details"]]);
  const ltv = d.payments.filter((p) => p.type === "charge" && p.status !== "failed").reduce((a, p) => a + p.net_cents, 0);
  return html`
    <div class="drawer-head">
      ${avatar(c.name, true)}
      <div style="flex:1;min-width:0">
        <h2 style="font-size:19px">${c.name}</h2>
        <div class="muted small">${[c.title, d.company?.name].filter(Boolean).join(" · ") || "—"}</div>
        <div class="chips" style="margin-top:8px">${lifecycleChip(c.lifecycle)} ${emailStatusChip(c.emailStatus)} ${c.emailOptIn ? html`<span class="chip ok">opted in</span>` : nothing} ${d.suppressed ? html`<span class="chip bad">${d.suppressed.reason}</span>` : nothing} ${c.clientId ? html`<button class="chip ok" @click=${() => h.openDetail({ kind: "client", id: c.clientId! })}>client ↗</button>` : nothing} ${(c.tags ?? []).map((t) => html`<span class="chip">${t}</span>`)}</div>
      </div>
      <button class="btn ghost icon-btn" aria-label="Close" @click=${() => h.closeDetail()}>${icons.x()}</button>
    </div>
    <div class="drawer-body">
      <div class="row" style="flex-wrap:wrap;margin-bottom:14px">
        ${c.email ? html`<button class="btn sm" ?disabled=${Boolean(d.suppressed)} @click=${() => { h.ui.modal = { kind: "sendOne", contact: c }; h.closeDetail(); h.go("campaigns"); }}>${icons.mail()} Email</button>` : nothing}
        ${c.phoneE164 ? html`<a class="btn sm" href=${`tel:${c.phoneE164}`}>${icons.phone()} Call</a>` : nothing}
        <button class="btn sm" @click=${() => h.act("hub.deals.save", { title: d.company?.name ?? c.name, contactId: c.id, companyId: c.companyId }, "Deal opened", ["contact", "deals", "pipeline"])}>${icons.plus()} Deal</button>
        <button class="btn sm" @click=${() => h.act<{ filled: string[] }>("hub.leadgen.enrich", { type: "contact", id: c.id }, (r) => (r.filled.length ? `Enriched: ${r.filled.join(", ")}` : "Nothing new found"), "contact")}>${icons.sparkle()} Enrich</button>
        ${c.email ? html`<button class="btn sm" @click=${() => h.act<{ status: string }>("hub.leadgen.verifyEmail", { email: c.email }, (r) => `Email is ${r.status}`, "contact")}>${icons.shield()} Verify</button>` : nothing}
      </div>
      <dl class="kv" style="margin:0 0 16px">
        ${c.email ? html`<dt>Email</dt><dd class="mono">${c.email}</dd>` : nothing}
        ${c.phone ? html`<dt>Phone</dt><dd class="mono">${c.phone}</dd>` : nothing}
        ${d.company ? html`<dt>Company</dt><dd><a href="#" @click=${(e: Event) => { e.preventDefault(); h.openDetail({ kind: "company", id: d.company!.id }); }}>${d.company.name}</a>${d.company.website ? html` · <a href=${d.company.website} target="_blank" rel="noopener noreferrer">${d.company.domain ?? "site"}</a>` : nothing}</dd>` : nothing}
        <dt>Source</dt><dd>${d.source ? `${d.source.name} (${d.source.kind})` : "—"}${d.campaign ? html` · campaign <b>${d.campaign.name}</b>` : nothing}</dd>
        ${offerId ? html`<dt>Offer</dt><dd><button class="chip gold" @click=${() => h.go("offers", { offerId })}>${offer?.name ?? "Linked offer"} ↗</button></dd>` : nothing}
        ${typeof c.custom.sequenceStep === "number" ? html`<dt>Sequence</dt><dd>Step ${Number(c.custom.sequenceStep) + 1}</dd>` : nothing}
        <dt>Score</dt><dd><span class="score"><i style="--w:${c.score}%"></i>${c.score}</span></dd>
        ${ltv ? html`<dt>Lifetime value</dt><dd class="gold-text" style="font-weight:650">${money(ltv)}</dd>` : nothing}
        ${d.visits?.events ? html`<dt>Website</dt><dd>${d.visits.events} tracked events · last ${relTime(d.visits.last)}</dd>` : nothing}
        ${Object.entries(c.social ?? {}).length ? html`<dt>Social</dt><dd>${Object.entries(c.social).map(([k, v]) => html`<a href=${v} target="_blank" rel="noopener noreferrer" class="chip">${k}</a> `)}</dd>` : nothing}
        <dt>Added</dt><dd>${date(c.createdAt, true)}</dd>
      </dl>
      ${h.ui.detailTab__render}
      ${tab === "timeline" ? html`${noteBox(h, "contact", c.id, `contact:${id}`)}${timelineView(d.timeline)}` : nothing}
      ${tab === "deals"
        ? d.deals.length
          ? html`<div class="list">${d.deals.map((x) => html`<div class="li click" @click=${() => h.openDetail({ kind: "deal", id: x.id })}><span class="chip ${x.status === "won" ? "ok" : x.status === "lost" ? "bad" : "gold"}">${x.status}</span><div class="grow"><b>${x.title}</b><span>${money(x.valueCents, x.currency)} · ${relTime(x.stageEnteredAt)} in stage</span></div></div>`)}</div>`
          : html`<div class="empty-mini">No deals yet.</div>`
        : nothing}
      ${tab === "email"
        ? d.sends.length
          ? html`<div class="list">${d.sends.map((s) => html`<div class="li"><span class="chip ${s.bounced_at ? "bad" : s.replied_at ? "ok" : s.clicked_at || s.opened_at ? "gold" : ""}">${s.bounced_at ? "bounced" : s.replied_at ? "replied" : s.clicked_at ? "clicked" : s.opened_at ? "opened" : s.status}</span><div class="grow"><b>${s.subject}</b><span>${s.campaign ?? "One-off"} · ${relTime(s.sent_at)}</span></div></div>`)}</div>`
          : html`<div class="empty-mini">No emails sent to ${c.name} yet.</div>`
        : nothing}
      ${tab === "payments" ? paymentsTable(d.payments) : nothing}
      ${tab === "edit"
        ? html`<form class="stack" @submit=${async (e: Event) => {
            e.preventDefault();
            const v = formValues(e.target as HTMLFormElement);
            const fd = new FormData(e.target as HTMLFormElement);
            await h.act("hub.contacts.save", { id: c.id, contact: { name: v.name, email: v.email || null, phone: v.phone || null, title: v.title || null, lifecycle: v.lifecycle, city: v.city || null, country: v.country || null, emailOptIn: fd.get("optIn") === "on", tags: v.tags.split(",").map((t) => t.trim()).filter(Boolean) } }, "Saved", ["contact", "contacts"]);
          }}>
            <div class="field-row"><label class="field">Name<input class="input" name="name" .value=${c.name} /></label><label class="field">Title<input class="input" name="title" .value=${c.title ?? ""} /></label></div>
            <div class="field-row"><label class="field">Email<input class="input" name="email" type="email" .value=${c.email ?? ""} /></label><label class="field">Phone<input class="input" name="phone" .value=${c.phone ?? ""} /></label></div>
            <div class="field-row"><label class="field">City<input class="input" name="city" .value=${c.city ?? ""} /></label><label class="field">Country<input class="input" name="country" .value=${c.country ?? ""} /></label>
              <label class="field">Lifecycle<select class="input" name="lifecycle">${Object.entries(LIFECYCLE_LABEL).map(([k, l]) => html`<option value=${k} ?selected=${c.lifecycle === k}>${l}</option>`)}</select></label></div>
            <label class="field">Tags<input class="input" name="tags" .value=${(c.tags ?? []).join(", ")} /></label>
            <label class="check"><input type="checkbox" name="optIn" .checked=${c.emailOptIn} /> Agreed to marketing email</label>
            <div class="row" style="justify-content:space-between">
              <button type="button" class="btn danger sm" @click=${async () => { if (confirm(`Delete ${c.name}? This removes their timeline too.`)) { const ok = await h.act("hub.contacts.delete", { id: c.id }, "Contact deleted", ["contacts", "overview"]); if (ok) h.closeDetail(); } }}>Delete</button>
              <button class="btn primary" type="submit">Save</button>
            </div>
          </form>`
        : nothing}
    </div>`;
}

function dealView(h: BusinessHubApp, id: string): TemplateResult {
  const res = h.load<{ deal: Deal; contact: Contact | null; company: Company | null; timeline: Activity[] }>(`contact:deal:${id}`, "hub.deals.get", { id }, { maxAgeMs: 8000 });
  const pl = h.load<{ pipeline: Pipeline }>("pipeline:def", "hub.pipeline.get", {}, { maxAgeMs: 120_000 });
  const d = res.data;
  if (!d || !pl.data) return html`<div class="drawer-body">${res.error ? html`<div class="bad">${res.error}</div>` : html`<div class="sk" style="height:200px"></div>`}</div>`;
  const deal = d.deal;
  const offerId = typeof deal.custom.offerId === "string" ? deal.custom.offerId : null;
  const offer = offerId ? h.load<{ offer: { name: string; valueProp: string } }>(`offer:${offerId}`, "hub.offers.get", { id: offerId }, { maxAgeMs: 30_000 }).data?.offer : null;
  const stages = pl.data.pipeline.stages;
  const stage = stages.find((s) => s.id === deal.stageId);
  return html`
    <div class="drawer-head">
      <div class="avatar lg" style="--h:40">${icons.pipeline()}</div>
      <div style="flex:1;min-width:0">
        <h2 style="font-size:19px">${deal.title}</h2>
        <div class="muted small">${money(deal.valueCents, deal.currency)} · ${stage?.name ?? "?"} · opened ${relTime(deal.createdAt)}</div>
        <div class="chips" style="margin-top:8px"><span class="chip ${deal.status === "won" ? "ok" : deal.status === "lost" ? "bad" : "gold"}">${deal.status}</span>${deal.clientId ? html`<button class="chip ok" @click=${() => h.openDetail({ kind: "client", id: deal.clientId! })}>client ↗</button>` : nothing}</div>
      </div>
      <button class="btn ghost icon-btn" aria-label="Close" @click=${() => h.closeDetail()}>${icons.x()}</button>
    </div>
    <div class="drawer-body">
      <h3 style="margin-bottom:8px">Stage</h3>
      <div class="chips" style="margin-bottom:16px">${stages.map((s) => html`<button class="chip" aria-pressed=${s.id === deal.stageId} @click=${() => s.id !== deal.stageId && moveWithPrompt(h, deal, s)}><span class="dot-s" style="--stage:${s.color ?? "var(--bh-gold)"}"></span>${s.name}</button>`)}</div>
      <form class="stack" @submit=${async (e: Event) => {
        e.preventDefault();
        const v = formValues(e.target as HTMLFormElement);
        await h.act("hub.deals.save", { id: deal.id, title: v.title, valueCents: Math.round(Number(v.value || 0) * 100), nextAction: v.nextAction || null, nextActionAt: fromInputDate(v.nextActionAt), expectedCloseAt: fromInputDate(v.expectedCloseAt) }, "Deal saved", ["contact:deal", "deals", "pipeline", "overview"]);
      }}>
        <div class="field-row"><label class="field">Title<input class="input" name="title" .value=${deal.title} /></label><label class="field">Value (${deal.currency})<input class="input" name="value" type="number" min="0" step="0.01" .value=${String(deal.valueCents / 100)} /></label></div>
        <div class="field-row"><label class="field">Next action<input class="input" name="nextAction" .value=${deal.nextAction ?? ""} placeholder="Call back Tuesday" /></label><label class="field">Due<input class="input" name="nextActionAt" type="date" .value=${toInputDate(deal.nextActionAt)} /></label><label class="field">Expected close<input class="input" name="expectedCloseAt" type="date" .value=${toInputDate(deal.expectedCloseAt)} /></label></div>
        <div class="row" style="justify-content:space-between"><button type="button" class="btn sm danger" @click=${async () => { if (confirm("Delete this deal?")) { const ok = await h.act("hub.deals.delete", { id: deal.id }, "Deal deleted", ["deals", "pipeline", "overview"]); if (ok) h.closeDetail(); } }}>Delete</button><button class="btn primary" type="submit">Save</button></div>
      </form>
      <div class="divider"></div>
      <dl class="kv" style="margin-bottom:16px">
        <dt>Contact</dt><dd>${d.contact ? html`<a href="#" @click=${(e: Event) => { e.preventDefault(); h.openDetail({ kind: "contact", id: d.contact!.id }); }}>${d.contact.name}</a> <span class="faint">${d.contact.email ?? ""}</span>` : html`<span class="faint">none linked</span>`}</dd>
        <dt>Company</dt><dd>${d.company ? html`<a href="#" @click=${(e: Event) => { e.preventDefault(); h.openDetail({ kind: "company", id: d.company!.id }); }}>${d.company.name}</a>` : html`<span class="faint">—</span>`}</dd>
        ${offerId ? html`<dt>Offer</dt><dd><button class="chip gold" @click=${() => h.go("offers", { offerId })}>${offer?.name ?? "Linked offer"} ↗</button></dd>` : nothing}
        ${typeof deal.custom.sequenceStep === "number" ? html`<dt>Sequence</dt><dd>Step ${Number(deal.custom.sequenceStep) + 1}${deal.nextAction ? ` · ${deal.nextAction}` : ""}</dd>` : nothing}
        ${deal.lostReason ? html`<dt>Lost reason</dt><dd>${deal.lostReason}</dd>` : nothing}
      </dl>
      <h3 style="margin-bottom:8px">Timeline</h3>
      ${noteBox(h, "deal", deal.id, `contact:deal:${id}`)}
      ${timelineView(d.timeline)}
    </div>`;
}

function companyView(h: BusinessHubApp, id: string): TemplateResult {
  const res = h.load<{ company: Company; contacts: Contact[]; deals: Deal[]; timeline: Activity[] }>(`contact:company:${id}`, "hub.companies.get", { id }, { maxAgeMs: 8000 });
  const d = res.data;
  if (!d) return html`<div class="drawer-body">${res.error ? html`<div class="bad">${res.error}</div>` : html`<div class="sk" style="height:200px"></div>`}</div>`;
  const co = d.company;
  return html`
    <div class="drawer-head">${avatar(co.name, true)}<div style="flex:1;min-width:0"><h2 style="font-size:19px">${co.name}</h2>
      <div class="muted small">${[co.industry, co.city, co.country].filter(Boolean).join(" · ") || "—"}</div>
      <div class="chips" style="margin-top:8px">${co.clientId ? html`<button class="chip ok" @click=${() => h.openDetail({ kind: "client", id: co.clientId! })}>client ↗</button>` : nothing}${co.website ? html`<a class="chip" href=${co.website} target="_blank" rel="noopener noreferrer">${co.domain ?? "website"}</a>` : nothing}</div></div>
      <button class="btn ghost icon-btn" aria-label="Close" @click=${() => h.closeDetail()}>${icons.x()}</button></div>
    <div class="drawer-body">
      <div class="row" style="margin-bottom:14px"><button class="btn sm" @click=${() => h.act<{ filled: string[] }>("hub.leadgen.enrich", { type: "company", id: co.id }, (r) => (r.filled.length ? `Enriched: ${r.filled.join(", ")}` : "Nothing new found"), "contact:company")}>${icons.sparkle()} Enrich from website</button></div>
      <h3 style="margin-bottom:8px">People</h3>
      ${d.contacts.length ? html`<div class="list">${d.contacts.map((c) => html`<div class="li click" @click=${() => h.openDetail({ kind: "contact", id: c.id })}>${avatar(c.name)}<div class="grow"><b>${c.name}</b><span>${c.title ?? ""} ${c.email ?? ""}</span></div>${lifecycleChip(c.lifecycle)}</div>`)}</div>` : html`<div class="empty-mini">No people yet — Enrich reads their site for names and emails.</div>`}
      <div class="divider"></div>
      <h3 style="margin-bottom:8px">Deals</h3>
      ${d.deals.length ? html`<div class="list">${d.deals.map((x) => html`<div class="li click" @click=${() => h.openDetail({ kind: "deal", id: x.id })}><span class="chip">${x.status}</span><div class="grow"><b>${x.title}</b><span>${money(x.valueCents, x.currency)}</span></div></div>`)}</div>` : html`<div class="empty-mini">No deals.</div>`}
      <div class="divider"></div>
      <h3 style="margin-bottom:8px">Timeline</h3>
      ${noteBox(h, "company", co.id, `contact:company:${id}`)}
      ${timelineView(d.timeline)}
    </div>`;
}

function clientView(h: BusinessHubApp, id: string): TemplateResult {
  const res = h.load<{ client: { id: string; name: string; email: string | null; phone: string | null; status: string; statusLabel: string; notes: string | null; createdAt: number }; contacts: Contact[]; deals: Deal[]; invoices: Array<{ id: string; number: string; status: string; currency: string; totalCents: number; balanceCents: number; dueAt: number | null }>; payments: Payment[]; timeline: Activity[] }>(`contact:client:${id}`, "hub.clients.get", { id }, { maxAgeMs: 10_000 });
  const d = res.data;
  if (!d) return html`<div class="drawer-body">${res.error ? html`<div class="bad">${res.error}</div>` : html`<div class="sk" style="height:200px"></div>`}</div>`;
  const ltv = d.payments.filter((p) => p.type === "charge" && p.status !== "failed").reduce((a, p) => a + p.net_cents, 0);
  const owed = d.invoices.filter((i) => i.status !== "void" && i.status !== "paid").reduce((a, i) => a + i.balanceCents, 0);
  const tab = tabs(h, "clientTab", [["timeline", "Timeline"], ["people", `People ${d.contacts.length || ""}`], ["deals", `Deals ${d.deals.length || ""}`], ["invoices", `Invoices ${d.invoices.length || ""}`], ["payments", `Payments ${d.payments.length || ""}`]]);
  return html`
    <div class="drawer-head">${avatar(d.client.name, true)}<div style="flex:1;min-width:0"><h2 style="font-size:19px">${d.client.name}</h2>
      <div class="muted small">${d.client.email ?? d.client.phone ?? ""}</div><div class="chips" style="margin-top:8px"><span class="chip ok">${d.client.statusLabel}</span><span class="chip">client since ${date(d.client.createdAt)}</span></div></div>
      <button class="btn ghost icon-btn" aria-label="Close" @click=${() => h.closeDetail()}>${icons.x()}</button></div>
    <div class="drawer-body">
      <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="glass kpi" style="min-height:0"><div class="label">Lifetime value</div><div class="value" style="font-size:22px">${money(ltv)}</div></div>
        <div class="glass kpi" style="min-height:0"><div class="label">Open deals</div><div class="value" style="font-size:22px">${money(d.deals.filter((x) => x.status === "open").reduce((a, x) => a + x.valueCents, 0))}</div></div>
        <div class="glass kpi" style="min-height:0"><div class="label">Outstanding</div><div class="value ${owed ? "warn" : ""}" style="font-size:22px">${money(owed)}</div></div>
      </div>
      ${h.openLegacy ? html`<div class="row" style="margin-bottom:12px"><button class="btn sm" @click=${() => h.openLegacy?.("clients")}>Invoices & workspace ↗</button></div>` : nothing}
      ${h.ui.clientTab__render}
      ${tab === "timeline" ? html`${noteBox(h, "client", id, `contact:client:${id}`)}${timelineView(d.timeline, "Activity from this client's contacts, deals and payments appears here.")}` : nothing}
      ${tab === "people" ? (d.contacts.length ? html`<div class="list">${d.contacts.map((c) => html`<div class="li click" @click=${() => h.openDetail({ kind: "contact", id: c.id })}>${avatar(c.name)}<div class="grow"><b>${c.name}</b><span>${c.email ?? ""}</span></div></div>`)}</div>` : html`<div class="empty-mini">No hub contacts linked yet. Contacts with this client's email link automatically.</div>`) : nothing}
      ${tab === "deals" ? (d.deals.length ? html`<div class="list">${d.deals.map((x) => html`<div class="li click" @click=${() => h.openDetail({ kind: "deal", id: x.id })}><span class="chip">${x.status}</span><div class="grow"><b>${x.title}</b><span>${money(x.valueCents, x.currency)}</span></div></div>`)}</div>` : html`<div class="empty-mini">No deals.</div>`) : nothing}
      ${tab === "invoices" ? (d.invoices.length ? html`<div class="list">${d.invoices.map((i) => html`<div class="li"><span class="chip ${i.status === "paid" ? "ok" : i.status === "overdue" ? "bad" : ""}">${i.status}</span><div class="grow"><b>${i.number}</b><span>${money(i.totalCents, i.currency)}${i.balanceCents ? ` · ${money(i.balanceCents, i.currency)} due` : ""}${i.dueAt ? ` · due ${date(i.dueAt)}` : ""}</span></div></div>`)}</div>` : html`<div class="empty-mini">No invoices. Create them in the client workspace.</div>`) : nothing}
      ${tab === "payments" ? paymentsTable(d.payments) : nothing}
    </div>`;
}

export function renderDetail(h: BusinessHubApp, ref: DetailRef): TemplateResult {
  const body = ref.kind === "contact" ? contactView(h, ref.id) : ref.kind === "deal" ? dealView(h, ref.id) : ref.kind === "company" ? companyView(h, ref.id) : clientView(h, ref.id);
  return html`<div class="scrim" @click=${() => h.closeDetail()}></div><aside class="drawer glass" role="dialog" aria-modal="true" aria-label="Details">${body}</aside>`;
}
