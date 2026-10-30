/**
 * Business hub › Leads — "Find leads" → live progress → scored preview →
 * import. Keyless by default (OpenStreetMap + the businesses' own websites +
 * email pattern / MX checks); self-hosted and BYOK providers are opt-in in
 * Providers.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { num, relTime } from "../format";
import { icons } from "../icons";
import { emptyState, errorCard, modal } from "./ui";

type LeadEmail = { email: string; source: string; status?: string; role?: boolean; onDomain?: boolean; personName?: string };
type LeadData = {
  name: string;
  website?: string | null;
  domain?: string | null;
  phone?: string | null;
  email?: string | null;
  emailStatus?: string;
  emails: LeadEmail[];
  city?: string | null;
  address?: string | null;
  category?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  social: Record<string, string>;
  people: Array<{ name: string; title?: string | null; email?: string | null }>;
  providers: string[];
  attribution: string[];
  scoreReasons?: string[];
  existing?: { companyId?: string | null; contactId?: string | null } | null;
};
type LeadResult = { id: string; score: number; status: "new" | "imported" | "skipped"; contactId: string | null; companyId: string | null; data: LeadData };
type LeadJob = { id: string; query: string; location: string | null; providers: string[]; status: "queued" | "running" | "done" | "error"; progress: { stage: string; found: number; enriched: number; verified: number; message?: string }; error: string | null; resultCount: number; importedCount: number; createdAt: number; finishedAt: number | null };
type ProviderStatus = { id: string; label: string; kind: string; description: string; notice?: string; requires?: { key?: string; serviceUrl?: string }; enabled: boolean; availability: { ok: boolean; reason?: string }; config: { serviceUrl?: string; endpoint?: string; geocoderUrl?: string; apiKey: string | null; apiKeySource: string | null } };

const STAGE_LABEL: Record<string, string> = { queued: "Queued", search: "Searching listings", enrich: "Reading websites", verify: "Checking emails", score: "Scoring", done: "Done", error: "Failed" };

function compose(h: BusinessHubApp, providers: ProviderStatus[]): TemplateResult {
  const searchProviders = providers.filter((p) => p.kind === "search");
  const chosen = (h.ui.leadsProviders as string[]) ?? searchProviders.filter((p) => p.enabled && p.availability.ok).map((p) => p.id);
  h.ui.leadsProviders = chosen;
  return html`<section class="glass card" style="margin-bottom:16px">
    <form class="grid" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) 110px auto;align-items:end;gap:12px" @submit=${async (e: Event) => {
      e.preventDefault();
      const fd = new FormData(e.target as HTMLFormElement);
      const query = String(fd.get("query") ?? "").trim();
      if (!query) return;
      const r = await h.act<{ jobId: string }>("hub.leadgen.search", { query, location: String(fd.get("location") ?? "").trim() || undefined, limit: Number(fd.get("limit") || 40), providers: chosen }, null, "leads:jobs");
      if (r) {
        h.ui.leadsJob = r.jobId;
        h.ui.leadsSel = new Set<string>();
        h.ui.leadsCompose = false;
        h.refresh();
      }
    }}>
      <label class="field">What kind of business?<input class="input" name="query" required placeholder="dentists, roofing contractors, coffee shops…" .value=${(h.ui.leadsLastQuery as string) ?? ""} /></label>
      <label class="field">Where?<input class="input" name="location" placeholder="Austin, TX" .value=${(h.ui.leadsLastLocation as string) ?? ""} /></label>
      <label class="field">How many<select class="input" name="limit">${[20, 40, 80, 150].map((n) => html`<option ?selected=${n === 40}>${n}</option>`)}</select></label>
      <button class="btn primary" type="submit" style="min-height:38px">${icons.sparkle()} Find leads</button>
    </form>
    <div class="row" style="margin-top:12px;flex-wrap:wrap;justify-content:space-between">
      <div class="chips">
        ${searchProviders.map((p) => {
          const on = chosen.includes(p.id);
          return html`<button class="chip" aria-pressed=${on} ?disabled=${!p.availability.ok} title=${p.availability.ok ? p.description : (p.availability.reason ?? "")}
            @click=${() => { h.ui.leadsProviders = on ? chosen.filter((x) => x !== p.id) : [...chosen, p.id]; h.refresh(); }}>${p.label}${p.availability.ok ? nothing : html` <span class="faint">· set up</span>`}</button>`;
        })}
      </div>
      <button class="btn sm ghost" @click=${() => { h.ui.modal = { kind: "providers" }; h.refresh(); }}>Providers & keys</button>
    </div>
    <p class="faint small" style="margin:10px 0 0">Every website is read politely (robots.txt respected, one request per second per site). Emails are checked by syntax, mail server and whether they appear on the business's own site — no paid API needed.</p>
  </section>`;
}

function providersModal(h: BusinessHubApp, providers: ProviderStatus[]): TemplateResult {
  const edits = (h.ui.providerEdits as Record<string, Record<string, unknown>>) ?? {};
  h.ui.providerEdits = edits;
  const set = (id: string, k: string, v: unknown) => {
    edits[id] = { ...edits[id], [k]: v };
  };
  const groups: Array<[string, string]> = [["search", "Find businesses"], ["enrich", "Enrich"], ["verify", "Verify emails"]];
  return modal(
    h,
    "Lead providers",
    html`${groups.map(([kind, label]) => html`<h3 style="margin:14px 0 8px">${label}</h3>
      <div class="stack">${providers.filter((p) => p.kind === kind).map(
        (p) => html`<div class="glass card" style="padding:12px">
          <div class="row" style="justify-content:space-between;flex-wrap:wrap">
            <div style="min-width:0;flex:1"><b>${p.label}</b> ${p.availability.ok ? html`<span class="chip ok">ready</span>` : html`<span class="chip">${p.availability.reason ?? "needs setup"}</span>`}
              <div class="faint small">${p.description}</div>${p.notice ? html`<div class="warn small" style="margin-top:4px">${p.notice}</div>` : nothing}</div>
            <label class="check"><input type="checkbox" .checked=${(edits[p.id]?.enabled as boolean | undefined) ?? p.enabled} @change=${(e: Event) => set(p.id, "enabled", (e.target as HTMLInputElement).checked)} /> On</label>
          </div>
          ${p.requires?.serviceUrl || p.config.serviceUrl !== undefined
            ? html`<label class="field" style="margin-top:8px">Service URL<input class="input" placeholder="http://localhost:8080" .value=${p.config.serviceUrl ?? ""} @change=${(e: Event) => set(p.id, "serviceUrl", (e.target as HTMLInputElement).value)} /></label>`
            : nothing}
          ${p.requires?.key
            ? html`<label class="field" style="margin-top:8px">API key ${p.config.apiKey ? html`<span class="faint">(saved ${p.config.apiKey}${p.config.apiKeySource === "env" ? " from env" : ""})</span>` : nothing}<input class="input" type="password" autocomplete="off" placeholder=${p.config.apiKey ? "Leave blank to keep" : "Paste key"} @change=${(e: Event) => set(p.id, "apiKey", (e.target as HTMLInputElement).value)} /></label>`
            : nothing}
          ${p.id === "osm" ? html`<label class="field" style="margin-top:8px">Geocoder URL <span class="faint">(Photon-compatible, or "none")</span><input class="input" .value=${p.config.geocoderUrl ?? ""} placeholder="https://photon.komoot.io/api/" @change=${(e: Event) => set(p.id, "geocoderUrl", (e.target as HTMLInputElement).value)} /></label>` : nothing}
        </div>`,
      )}</div>`)}`,
    html`<button class="btn" @click=${() => { h.ui.modal = null; h.ui.providerEdits = null; h.refresh(); }}>Cancel</button>
      <button class="btn primary" @click=${async () => {
        const r = await h.act("hub.leadgen.config.set", { providers: edits }, "Providers saved", "leads");
        if (r) {
          h.ui.modal = null;
          h.ui.providerEdits = null;
          h.ui.leadsProviders = undefined;
          h.refresh();
        }
      }}>Save</button>`,
    true,
  );
}

function resultsView(h: BusinessHubApp, jobId: string): TemplateResult {
  const minScore = (h.ui.leadsMin as number) ?? 0;
  const hasEmail = Boolean(h.ui.leadsHasEmail);
  const res = h.load<{ job: LeadJob; results: LeadResult[]; total: number }>(`leads:job:${jobId}:${minScore}:${hasEmail}`, "hub.leadgen.job", { jobId, minScore: minScore || undefined, hasEmail: hasEmail || undefined, limit: 200 }, { maxAgeMs: 3000 });
  const job = res.data?.job;
  const running = job && (job.status === "running" || job.status === "queued");
  if (running) h.pollers.set("leads", () => h.invalidate(`leads:job:${jobId}`));
  else h.pollers.delete("leads");
  const sel = (h.ui.leadsSel as Set<string>) ?? new Set<string>();
  h.ui.leadsSel = sel;
  const results = res.data?.results ?? [];
  const importable = results.filter((r) => r.status === "new");
  if (!job) return res.error ? errorCard(h, res.error, "leads") : html`<div class="glass card sk" style="height:220px"></div>`;
  const pct = job.progress.found ? Math.round(((job.progress.enriched + job.progress.verified) / (job.progress.found * 2)) * 100) : 8;
  const doImport = async (ids: string[] | "all") => {
    const tags = (h.ui.leadsTags as string) ?? "";
    const r = await h.act<{ created: number; updated: number; skipped: number }>(
      "hub.leadgen.import",
      { jobId, resultIds: ids, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), createDeals: h.ui.leadsDeals !== false },
      (x) => `Imported ${x.created} new · ${x.updated} updated${h.ui.leadsDeals !== false ? " — deals opened in New" : ""}`,
      ["leads", "contacts", "deals", "overview"],
    );
    if (r) sel.clear();
  };
  return html`<section class="glass card">
    <div class="card-head" style="flex-wrap:wrap">
      <div><h2>${job.query}${job.location ? html` <span class="faint">· ${job.location}</span>` : nothing}</h2>
        <div class="faint small">${job.providers.join(" + ")} · started ${relTime(job.createdAt)}${job.importedCount ? ` · ${job.importedCount} imported` : ""}</div></div>
      <div class="row">
        ${job.status === "error" ? html`<span class="chip bad">${job.error ?? "failed"}</span>` : running ? html`<span class="chip gold">${STAGE_LABEL[job.progress.stage] ?? job.progress.stage}</span>` : html`<span class="chip ok">${num(job.resultCount)} found</span>`}
        <button class="btn sm" @click=${() => { h.ui.leadsJob = null; h.ui.leadsCompose = true; h.refresh(); }}>New search</button>
      </div>
    </div>
    ${running
      ? html`<div class="progress" style="margin-bottom:10px"><i style="width:${Math.min(96, pct)}%"></i></div>
          <div class="faint small">${job.progress.found} businesses found · ${job.progress.enriched} websites read · ${job.progress.verified} emails checked${job.progress.message ? ` · ${job.progress.message}` : ""}</div>`
      : nothing}
    ${results.length
      ? html`<div class="toolbar" style="margin-top:12px">
          <div class="chips">
            ${[0, 40, 60].map((m) => html`<button class="chip" aria-pressed=${minScore === m} @click=${() => { h.ui.leadsMin = m; h.refresh(); }}>${m ? `Score ${m}+` : "All"}</button>`)}
            <button class="chip" aria-pressed=${hasEmail} @click=${() => { h.ui.leadsHasEmail = !hasEmail; h.refresh(); }}>Has email</button>
          </div>
          <span class="spacer"></span>
          <input class="input" style="width:200px" placeholder="Tags for import" .value=${(h.ui.leadsTags as string) ?? job.query} @change=${(e: Event) => (h.ui.leadsTags = (e.target as HTMLInputElement).value)} />
          <label class="check"><input type="checkbox" .checked=${h.ui.leadsDeals !== false} @change=${(e: Event) => { h.ui.leadsDeals = (e.target as HTMLInputElement).checked; }} /> Open deals</label>
          <button class="btn" ?disabled=${!sel.size} @click=${() => doImport([...sel])}>Import ${sel.size || ""} selected</button>
          <button class="btn primary" ?disabled=${!importable.length} @click=${() => doImport(importable.map((r) => r.id))}>Import all ${importable.length}</button>
        </div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th style="width:36px"></th><th>Business</th><th>Score</th><th>Best email</th><th class="hide-sm">Phone</th><th class="hide-sm">Found</th></tr></thead>
          <tbody>${results.map((r) => {
            const d = r.data;
            const existing = d.existing?.contactId || d.existing?.companyId;
            return html`<tr>
              <td><input type="checkbox" aria-label=${`Select ${d.name}`} ?disabled=${r.status !== "new"} .checked=${sel.has(r.id)} @change=${(e: Event) => { if ((e.target as HTMLInputElement).checked) sel.add(r.id); else sel.delete(r.id); h.refresh(); }} /></td>
              <td><div class="t"><b style="display:block">${d.name}</b>
                <span class="faint small">${[d.category, d.city].filter(Boolean).join(" · ")}${d.website ? html` · <a href=${d.website} target="_blank" rel="noopener noreferrer">${d.domain ?? "site"}</a>` : nothing}${d.rating ? ` · ★ ${d.rating}${d.reviewCount ? ` (${d.reviewCount})` : ""}` : ""}</span>
                <div class="chips" style="margin-top:4px">
                  ${r.status === "imported" ? html`<span class="chip ok">imported</span>` : existing ? html`<span class="chip gold">already in CRM</span>` : nothing}
                  ${Object.keys(d.social ?? {}).slice(0, 4).map((s) => html`<span class="chip">${s}</span>`)}
                  ${d.people?.length ? html`<span class="chip">${d.people.length} people</span>` : nothing}
                </div></div></td>
              <td><span class="score" title=${(d.scoreReasons ?? []).join("\n")}><i style="--w:${r.score}%"></i>${r.score}</span></td>
              <td>${d.email ? html`<span class="mono">${d.email}</span> <span class="chip ${d.emailStatus === "valid" ? "ok" : d.emailStatus === "risky" ? "warn" : d.emailStatus === "invalid" ? "bad" : ""}">${d.emailStatus ?? "unchecked"}</span>` : html`<span class="faint">—</span>`}</td>
              <td class="hide-sm mono">${d.phone ?? "—"}</td>
              <td class="hide-sm faint small">${d.providers.join(", ")}</td>
            </tr>`;
          })}</tbody>
        </table></div>
        <div class="faint small" style="margin-top:8px">${[...new Set(results.flatMap((r) => r.data.attribution ?? []))].join(" · ")}</div>`
      : running
        ? nothing
        : html`<div class="empty-mini">No businesses matched. Try a broader category ("dentist" instead of "pediatric dentist") or a larger area.</div>`}
  </section>`;
}

export function renderLeads(h: BusinessHubApp): TemplateResult {
  const providers = h.load<{ providers: ProviderStatus[] }>("leads:providers", "hub.leadgen.providers", {}, { maxAgeMs: 60_000 });
  const jobs = h.load<{ jobs: LeadJob[] }>("leads:jobs", "hub.leadgen.jobs", { limit: 12 });
  const list = providers.data?.providers ?? [];
  const jobList = jobs.data?.jobs ?? [];
  const current = (h.ui.leadsJob as string | null) ?? (h.ui.leadsCompose ? null : (jobList.find((j) => j.status === "running")?.id ?? null));
  const modalKind = (h.ui.modal as { kind?: string } | null)?.kind;
  return html`
    ${!current || h.ui.leadsCompose ? compose(h, list) : nothing}
    ${current ? resultsView(h, current) : nothing}
    ${!current && jobs.data && !jobList.length
      ? emptyState({ icon: "leads", title: "Find your first leads", text: "Describe the businesses you sell to and where they are. The hub finds them on OpenStreetMap, reads their websites for emails, phones and socials, checks every email, scores each lead — and you choose who to import.", inline: false })
      : nothing}
    ${jobList.length
      ? html`<section class="glass card" style="margin-top:16px">
          <div class="card-head"><h2>Recent searches</h2></div>
          <div class="list">${jobList.map(
            (j) => html`<div class="li click" @click=${() => { h.ui.leadsJob = j.id; h.ui.leadsCompose = false; h.ui.leadsSel = new Set(); h.refresh(); }}>
              ${icons.leads()}
              <div class="grow"><b>${j.query}${j.location ? ` · ${j.location}` : ""}</b><span>${num(j.resultCount)} found · ${num(j.importedCount)} imported · ${relTime(j.createdAt)}</span></div>
              <span class="chip ${j.status === "done" ? "ok" : j.status === "error" ? "bad" : "gold"}">${j.status}</span>
            </div>`,
          )}</div>
        </section>`
      : nothing}
    ${modalKind === "providers" ? providersModal(h, list) : nothing}
  `;
}
