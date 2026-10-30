/**
 * Business hub › Landing pages — one first-party snippet per site: page
 * views, UTMs, form submits (which become contacts + deals), and visitor →
 * contact stitching. Shows install code, live stats and the event stream,
 * and links to the funnel + form builders whose submissions land here.
 */

import { html, nothing, type TemplateResult } from "lit";
import { gatewayOrigin } from "../../../gateway-endpoint";
import type { BusinessHubApp } from "../app";
import { areaChart, barList } from "../charts";
import { num, pct, relTime } from "../format";
import { icons } from "../icons";
import { emptyState, formValues, modal, periodPicker } from "./ui";

type Site = { id: string; name: string; publicKey: string; origins: string[]; consentMode: "cookieless" | "consent" | "full"; createdAt: number };
type Stats = {
  pageViews: number;
  uniqueVisitors: number;
  sessions: number;
  formSubmits: number;
  identifiedContacts: number;
  conversionRate: number;
  byPage: Array<{ pageId: string; path: string; title: string | null; site: string | null; views: number; visitors: number; submits: number }>;
  byUtm: Array<{ source: string; medium: string; campaign: string; visitors: number; views: number; submits: number }>;
  byReferrer: Array<{ domain: string; visitors: number; submits: number }>;
  daily: Array<{ day: string; views: number; visitors: number; submits: number }>;
  topContacts: Array<{ id: string; name: string; email: string | null; lifecycle: string; events: number; lastSeenAt: number; submits: number }>;
};
type Ev = { id: string; type: string; name: string | null; path: string | null; url: string | null; contactId: string | null; contactName: string | null; occurredAt: number };

const CONSENT: Record<string, string> = {
  cookieless: "Cookieless (no consent banner needed)",
  consent: "After consent (call ibConsent(true))",
  full: "Full (first-party storage)",
};

function siteModal(h: BusinessHubApp, site: Site | null): TemplateResult {
  return modal(
    h,
    site ? `Edit ${site.name}` : "Track a landing page",
    html`<form class="stack" @submit=${(e: Event) => e.preventDefault()}>
      <label class="field">Name<input class="input" name="name" required .value=${site?.name ?? ""} placeholder="Main website" /></label>
      <label class="field">Allowed domains <span class="faint">(one per line — events from anywhere else are rejected)</span><textarea class="input" name="origins" style="min-height:80px" placeholder="https://www.acme.com&#10;https://acme.com">${(site?.origins ?? []).join("\n")}</textarea></label>
      <label class="field">Privacy mode<select class="input" name="consentMode">${Object.entries(CONSENT).map(([k, v]) => html`<option value=${k} ?selected=${(site?.consentMode ?? "cookieless") === k}>${v}</option>`)}</select></label>
      <div class="faint small">Cookieless mode keeps no cookies and never stores IP addresses. Do Not Track / Global Privacy Control are always respected.</div>
    </form>`,
    html`<button class="btn" @click=${() => { h.ui.modal = null; h.refresh(); }}>Cancel</button>
      <button class="btn primary" @click=${async (e: Event) => {
        const form = (e.target as HTMLElement).closest(".modal")!.querySelector("form") as HTMLFormElement;
        if (!form.reportValidity()) return;
        const v = formValues(form);
        const r = await h.act<{ site: Site }>("hub.tracking.sites.save", { id: site?.id, name: v.name, origins: v.origins.split(/\s+/).map((o) => o.trim()).filter(Boolean), consentMode: v.consentMode }, "Site saved", "track");
        if (r) {
          h.ui.modal = null;
          h.ui.trackSite = r.site.id;
          h.refresh();
        }
      }}>Save</button>`,
  );
}

function installCard(h: BusinessHubApp, site: Site): TemplateResult {
  // Prefer the configured public URL; fall back to this browser's address so the
  // code can be copied right away (with a hint to set the real one).
  const settings = h.load<{ settings: { publicBaseUrl: string | null } }>("camp:settings", "hub.email.settings.get", {}, { maxAgeMs: 60_000 });
  const publicUrl = settings.data?.settings.publicBaseUrl ?? null;
  type Snip = { html: string; doc: string; originsConfigured: boolean };
  const snip = settings.data
    ? h.load<Snip>(`track:snip:${site.id}:${publicUrl ?? "local"}`, "hub.tracking.snippet", { siteId: site.id, baseUrl: publicUrl ? undefined : gatewayOrigin() }, { maxAgeMs: 300_000 })
    : { data: null as Snip | null, error: null as string | null, loading: true };
  return html`<section class="glass card">
    <div class="card-head"><h2>Install</h2><span class="chip">${CONSENT[site.consentMode]?.split(" (")[0]}</span></div>
    ${snip.data
      ? html`<p class="muted small" style="margin-top:0">Paste this before <span class="mono">&lt;/head&gt;</span> on every page. Forms are captured automatically; anything with <span class="mono">data-ib-track</span> logs a click.</p>
          <pre class="code">${snip.data.html}</pre>
          <div class="row" style="margin-top:10px;flex-wrap:wrap">
            <button class="btn sm" @click=${async () => { await navigator.clipboard?.writeText(snip.data!.html); h.showToast("Snippet copied"); }}>${icons.copy()} Copy snippet</button>
            <button class="btn sm ghost" @click=${() => { h.ui.trackDoc = !h.ui.trackDoc; h.refresh(); }}>${h.ui.trackDoc ? "Hide" : "Show"} full guide</button>
            <button class="btn sm ghost" @click=${() => { h.ui.modal = { kind: "site", site }; h.refresh(); }}>Settings</button>
          </div>
          ${settings.data && !publicUrl ? html`<div class="warn small" style="margin-top:8px">● This code points at ${gatewayOrigin()}. Set your public URL (Campaigns › Senders & settings) so visitors' browsers can reach it.</div>` : nothing}
          ${!snip.data.originsConfigured ? html`<div class="warn small" style="margin-top:8px">● No allowed domains yet — add your site's domain so nobody else can send events with this key.</div>` : nothing}
          ${h.ui.trackDoc ? html`<pre class="code" style="margin-top:10px">${snip.data.doc}</pre>` : nothing}`
      : snip.error
        ? html`<div class="warn small">${snip.error}</div>`
        : html`<div class="sk" style="height:60px"></div>`}
  </section>`;
}

export function renderTracking(h: BusinessHubApp): TemplateResult {
  const sites = h.load<{ sites: Site[] }>("track:sites", "hub.tracking.sites.list", {});
  const list = sites.data?.sites ?? [];
  const siteId = (h.ui.trackSite as string) ?? list[0]?.id ?? null;
  const site = list.find((s) => s.id === siteId) ?? null;
  const r = h.range();
  const stats = h.load<Stats>(`track:stats:${siteId ?? "all"}:${h.period}`, "hub.tracking.stats", { siteId: siteId ?? undefined, from: r.from, to: r.to });
  const events = h.load<{ events: Ev[] }>(`track:events:${siteId ?? "all"}`, "hub.tracking.events", { siteId: siteId ?? undefined, limit: 25 }, { maxAgeMs: 15_000 });
  const md = h.ui.modal as { kind?: string; site?: Site | null } | null;
  const s = stats.data;

  const builders = html`<section class="glass card">
    <div class="card-head"><h2>Build pages & forms</h2></div>
    <p class="muted small" style="margin-top:0">Pages built with the funnel and form builders report into this hub automatically — every submission becomes a contact with a deal.</p>
    <div class="row" style="flex-wrap:wrap">
      <button class="btn sm" @click=${() => h.openLegacy?.("funnels")}>Funnel builder ↗</button>
      <button class="btn sm" @click=${() => h.openLegacy?.("qualifier")}>Lead-qualifier forms ↗</button>
    </div>
  </section>`;

  if (sites.data && !list.length)
    return html`${emptyState({
      icon: "tracking",
      title: "Track your landing pages",
      text: "Add one line of code to any site. You'll see visits, where they came from (UTMs, referrers), and every form submit turns into a contact and a deal — no third-party analytics.",
      actions: [{ label: "Track a site", primary: true, run: () => { h.ui.modal = { kind: "site", site: null }; h.refresh(); } }],
    })}<div style="margin-top:16px">${builders}</div>${md?.kind === "site" ? siteModal(h, md.site ?? null) : nothing}`;

  return html`
    <div class="toolbar">
      <div class="chips">${list.map((x) => html`<button class="chip" aria-pressed=${x.id === siteId} @click=${() => { h.ui.trackSite = x.id; h.refresh(); }}>${x.name}</button>`)}</div>
      <span class="spacer"></span>
      ${periodPicker(h)}
      <button class="btn primary" @click=${() => { h.ui.modal = { kind: "site", site: null }; h.refresh(); }}>${icons.plus()} Add site</button>
    </div>
    <div class="kpis k4">
      <div class="glass kpi"><div class="label">Visitors</div><div class="value">${num(s?.uniqueVisitors)}</div><div class="foot">${num(s?.sessions)} sessions</div></div>
      <div class="glass kpi"><div class="label">Page views</div><div class="value">${num(s?.pageViews)}</div><div class="foot">${s?.uniqueVisitors ? (s.pageViews / s.uniqueVisitors).toFixed(1) : "—"} per visitor</div></div>
      <div class="glass kpi"><div class="label">Form leads</div><div class="value">${num(s?.formSubmits)}</div><div class="foot">conversion ${pct(s?.conversionRate, 1)}</div></div>
      <div class="glass kpi"><div class="label">Identified</div><div class="value">${num(s?.identifiedContacts)}</div><div class="foot">visitors matched to contacts</div></div>
    </div>
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="glass card"><div class="card-head"><h2>Traffic</h2><span class="meta">views per day</span></div>
        ${areaChart((s?.daily ?? []).map((d) => ({ label: new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: d.views })), { empty: "Waiting for the first visit — install the snippet." })}</section>
      ${site ? installCard(h, site) : builders}
    </div>
    <div class="grid cols-3" style="margin-bottom:16px">
      <section class="glass card"><div class="card-head"><h2>Top pages</h2></div>${barList((s?.byPage ?? []).slice(0, 8).map((p) => ({ label: p.path, value: p.views, sub: p.submits ? `${p.submits} leads` : undefined })), { empty: "No pages yet." })}</section>
      <section class="glass card"><div class="card-head"><h2>Campaigns & sources</h2><span class="meta">UTM</span></div>${barList((s?.byUtm ?? []).filter((u) => u.source !== "(none)" || u.campaign !== "(none)").slice(0, 8).map((u) => ({ label: u.campaign !== "(none)" ? u.campaign : `${u.source} / ${u.medium}`, value: u.visitors, sub: u.submits ? `${u.submits} leads` : undefined })), { empty: "Add ?utm_source=…&utm_campaign=… to your ad and email links." })}</section>
      <section class="glass card"><div class="card-head"><h2>Referrers</h2></div>${barList((s?.byReferrer ?? []).slice(0, 8).map((x) => ({ label: x.domain, value: x.visitors, sub: x.submits ? `${x.submits} leads` : undefined })), { empty: "No referrers yet." })}</section>
    </div>
    <div class="grid cols-2">
      <section class="glass card"><div class="card-head"><h2>Known visitors</h2></div>
        ${s?.topContacts.length
          ? html`<div class="list">${s.topContacts.map((c) => html`<div class="li click" @click=${() => h.openDetail({ kind: "contact", id: c.id })}><div class="grow"><b>${c.name}</b><span>${c.email ?? ""} · ${c.events} events${c.submits ? ` · ${c.submits} forms` : ""}</span></div><span class="faint small">${relTime(c.lastSeenAt)}</span></div>`)}</div>`
          : html`<div class="empty-mini">Visitors become known when they submit a form or click a tracked email link.</div>`}
      </section>
      <section class="glass card"><div class="card-head"><h2>Live events</h2><button class="btn sm ghost" @click=${() => h.invalidate("track:events")}>${icons.refresh()}</button></div>
        ${events.data?.events.length
          ? html`<div class="list">${events.data.events.map((e) => html`<div class="li ${e.contactId ? "click" : ""}" @click=${() => e.contactId && h.openDetail({ kind: "contact", id: e.contactId })}><span class="chip ${e.type === "form_submit" ? "ok" : ""}">${e.type.replace("_", " ")}</span><div class="grow"><b>${e.path ?? e.url ?? e.name ?? "—"}</b><span>${e.contactName ?? "anonymous visitor"}</span></div><span class="faint small">${relTime(e.occurredAt)}</span></div>`)}</div>`
          : html`<div class="empty-mini">Nothing yet.</div>`}
      </section>
    </div>
    <div style="margin-top:16px">${builders}</div>
    ${md?.kind === "site" ? siteModal(h, md.site ?? null) : nothing}
  `;
}
