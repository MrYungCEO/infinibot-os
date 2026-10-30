/** Business hub › Contacts — filterable people list, bulk actions, duplicate finder + merge, add contact. */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { LIFECYCLE_LABEL, num, relTime } from "../format";
import { icons } from "../icons";
import type { Contact } from "../types";
import { avatar, emailStatusChip, emptyState, errorCard, formValues, lifecycleChip, modal, searchBox, skeletonRows } from "./ui";

const PAGE = 100;

function addModal(h: BusinessHubApp): TemplateResult {
  return modal(
    h,
    "Add contact",
    html`<form class="stack" @submit=${(e: Event) => e.preventDefault()}>
      <div class="field-row">
        <label class="field">Name<input class="input" name="name" placeholder="Jane Doe" /></label>
        <label class="field">Email<input class="input" name="email" type="email" placeholder="jane@acme.com" /></label>
      </div>
      <div class="field-row">
        <label class="field">Phone<input class="input" name="phone" placeholder="+1 555 010 2030" /></label>
        <label class="field">Company<input class="input" name="companyName" placeholder="Acme Inc" /></label>
      </div>
      <div class="field-row">
        <label class="field">Title<input class="input" name="title" placeholder="Founder" /></label>
        <label class="field">Lifecycle<select class="input" name="lifecycle">${Object.entries(LIFECYCLE_LABEL).map(([k, v]) => html`<option value=${k} ?selected=${k === "lead"}>${v}</option>`)}</select></label>
      </div>
      <label class="field">Tags<input class="input" name="tags" placeholder="vip, webinar (comma separated)" /></label>
      <label class="check"><input type="checkbox" name="optIn" /> They agreed to receive marketing email</label>
      <label class="check"><input type="checkbox" name="createDeal" checked /> Open a deal in the pipeline</label>
    </form>`,
    html`<button class="btn" @click=${() => { h.ui.modal = null; h.refresh(); }}>Cancel</button>
      <button class="btn primary" @click=${async (e: Event) => {
        const form = (e.target as HTMLElement).closest(".modal")!.querySelector("form") as HTMLFormElement;
        const v = formValues(form);
        const fd = new FormData(form);
        const r = await h.act<{ contact: Contact }>(
          "hub.contacts.save",
          { createDeal: fd.get("createDeal") === "on", contact: { name: v.name || undefined, email: v.email || undefined, phone: v.phone || undefined, companyName: v.companyName || undefined, title: v.title || undefined, lifecycle: v.lifecycle, emailOptIn: fd.get("optIn") === "on", tags: v.tags ? v.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined } },
          "Contact added",
          ["contacts", "overview", "deals"],
        );
        if (r) {
          h.ui.modal = null;
          h.openDetail({ kind: "contact", id: r.contact.id });
        }
      }}>Add contact</button>`,
  );
}

function duplicatesModal(h: BusinessHubApp): TemplateResult {
  const d = h.load<{ pairs: Array<{ a: Contact; b: Contact; reason: string }> }>("contacts:dupes", "hub.contacts.duplicates", {}, { maxAgeMs: 5000 });
  const pairs = d.data?.pairs ?? [];
  return modal(
    h,
    "Possible duplicates",
    pairs.length
      ? html`<div class="stack">${pairs.map(
          (p) => html`<div class="glass card" style="padding:12px">
            <div class="row" style="justify-content:space-between;flex-wrap:wrap">
              ${[p.a, p.b].map((c) => html`<div class="who">${avatar(c.name)}<div class="t"><b>${c.name}</b><span>${c.email ?? c.phoneE164 ?? ""}</span></div></div>`)}
              <span class="chip">${p.reason}</span>
            </div>
            <div class="row" style="margin-top:10px;justify-content:flex-end">
              <button class="btn sm" @click=${() => h.act("hub.contacts.merge", { winnerId: p.a.id, loserId: p.b.id }, `Merged into ${p.a.name}`, "contacts")}>${icons.merge()} Keep left</button>
              <button class="btn sm" @click=${() => h.act("hub.contacts.merge", { winnerId: p.b.id, loserId: p.a.id }, `Merged into ${p.b.name}`, "contacts")}>${icons.merge()} Keep right</button>
            </div>
          </div>`,
        )}</div>`
      : html`<div class="empty-mini">${d.loading ? "Looking…" : "No likely duplicates. Same-email contacts are merged automatically on import."}</div>`,
    html`<button class="btn" @click=${() => { h.ui.modal = null; h.refresh(); }}>Done</button>`,
    true,
  );
}

export function renderContacts(h: BusinessHubApp): TemplateResult {
  const search = (h.ui.contactsSearch as string) ?? "";
  const lifecycle = (h.ui.contactsLifecycle as string) ?? "";
  const tag = (h.ui.contactsTag as string) ?? "";
  const sort = (h.ui.contactsSort as string) ?? "recent";
  const limit = (h.ui.contactsLimit as number) ?? PAGE;
  const selected = (h.ui.contactsSel as Set<string>) ?? new Set<string>();
  h.ui.contactsSel = selected;
  const params = { search: search || undefined, lifecycle: lifecycle || undefined, tag: tag || undefined, sort, limit };
  const res = h.load<{ contacts: Contact[]; total: number }>(`contacts:${JSON.stringify(params)}`, "hub.contacts.list", params);
  const tags = h.load<{ tags: Array<{ name: string; count: number }> }>("contacts:tags", "hub.tags.list", {}, { maxAgeMs: 60_000 });
  const modalKind = (h.ui.modal as { kind?: string } | null)?.kind;
  const list = res.data?.contacts ?? [];
  const total = res.data?.total ?? 0;
  const anyFilter = Boolean(search || lifecycle || tag);

  const bulk = async (action: string, extra: Record<string, unknown> = {}) => {
    await h.act("hub.contacts.bulk", { ids: [...selected], action, ...extra }, `${selected.size} updated`, ["contacts", "deals", "overview"]);
    selected.clear();
    h.refresh();
  };

  return html`
    <div class="toolbar">
      ${searchBox(search, (v) => { h.ui.contactsSearch = v; h.refresh(); }, "Search name, email, phone or company")}
      <select class="input" style="width:auto" aria-label="Sort" @change=${(e: Event) => { h.ui.contactsSort = (e.target as HTMLSelectElement).value; h.refresh(); }}>
        ${[["recent", "Newest"], ["activity", "Recent activity"], ["score", "Highest score"], ["name", "Name"]].map(([k, v]) => html`<option value=${k} ?selected=${sort === k}>${v}</option>`)}
      </select>
      <span class="spacer"></span>
      <button class="btn" @click=${() => { h.ui.modal = { kind: "dupes" }; h.invalidate("contacts:dupes"); }}>${icons.merge()} Duplicates</button>
      <button class="btn" @click=${() => h.go("imports")}>${icons.imports()} Import</button>
      <button class="btn primary" @click=${() => { h.ui.modal = { kind: "addContact" }; h.refresh(); }}>${icons.plus()} Add contact</button>
    </div>
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Lifecycle">
        <button class="chip" aria-pressed=${!lifecycle} @click=${() => { h.ui.contactsLifecycle = ""; h.refresh(); }}>All <span class="faint">${anyFilter ? "" : num(total)}</span></button>
        ${Object.entries(LIFECYCLE_LABEL).map(([k, v]) => html`<button class="chip" aria-pressed=${lifecycle === k} @click=${() => { h.ui.contactsLifecycle = lifecycle === k ? "" : k; h.refresh(); }}>${v}</button>`)}
      </div>
      ${tags.data?.tags.length
        ? html`<select class="input" style="width:auto;max-width:200px" aria-label="Tag" @change=${(e: Event) => { h.ui.contactsTag = (e.target as HTMLSelectElement).value; h.refresh(); }}>
            <option value="">Any tag</option>${tags.data.tags.slice(0, 80).map((t) => html`<option value=${t.name} ?selected=${tag === t.name}>${t.name} (${t.count})</option>`)}
          </select>`
        : nothing}
    </div>
    ${selected.size
      ? html`<div class="glass banner">
          <b>${selected.size} selected</b>
          <button class="btn sm" @click=${() => bulk("createDeals")}>Open deals</button>
          <button class="btn sm" @click=${() => { const t = prompt("Tag to add"); if (t) void h.act("hub.contacts.tag", { ids: [...selected], add: [t] }, "Tagged", "contacts"); }}>Add tag</button>
          <select class="input" style="width:auto" @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) void bulk("lifecycle", { lifecycle: v }); }}>
            <option value="">Set lifecycle…</option>${Object.entries(LIFECYCLE_LABEL).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
          </select>
          <button class="btn sm" @click=${() => h.go("campaigns", { campaignPreselect: [...selected] })}>${icons.mail()} Email them</button>
          <span class="spacer" style="flex:1"></span>
          <button class="btn sm danger" @click=${() => { if (confirm(`Delete ${selected.size} contacts? Their timeline is deleted too.`)) void bulk("delete"); }}>Delete</button>
          <button class="btn sm ghost" @click=${() => { selected.clear(); h.refresh(); }}>Clear</button>
        </div>`
      : nothing}
    ${res.error ? errorCard(h, res.error, "contacts") : nothing}
    ${res.loading && !res.data
      ? skeletonRows(8)
      : !list.length
        ? anyFilter
          ? emptyState({ icon: "search", title: "No matches", text: "Nobody matches these filters.", actions: [{ label: "Clear filters", run: () => { h.ui.contactsSearch = ""; h.ui.contactsLifecycle = ""; h.ui.contactsTag = ""; h.refresh(); } }] })
          : emptyState({
              icon: "contacts",
              title: "Your contacts live here",
              text: "Import a CSV, Excel, vCard or Google Contacts export, find leads, or connect a landing page — every person lands here with a full timeline.",
              actions: [
                { label: "Import a list", primary: true, run: () => h.go("imports") },
                { label: "Find leads", run: () => h.go("leads", { leadsCompose: true }) },
                { label: "Add contact", run: () => { h.ui.modal = { kind: "addContact" }; h.refresh(); } },
              ],
            })
        : html`<div class="glass table-wrap"><table class="table">
            <thead><tr>
              <th style="width:36px"><input type="checkbox" aria-label="Select all" .checked=${list.length > 0 && list.every((c) => selected.has(c.id))} @change=${(e: Event) => { const on = (e.target as HTMLInputElement).checked; for (const c of list) { if (on) selected.add(c.id); else selected.delete(c.id); } h.refresh(); }} /></th>
              <th>Contact</th><th>Stage</th><th class="hide-sm">Company</th><th class="hide-sm">Score</th><th class="hide-sm">Tags</th><th class="hide-sm">Last activity</th>
            </tr></thead>
            <tbody>${list.map(
              (c) => html`<tr class="click" @click=${(e: Event) => { if ((e.target as HTMLElement).tagName !== "INPUT") h.openDetail({ kind: "contact", id: c.id }); }}>
                <td><input type="checkbox" aria-label=${`Select ${c.name}`} .checked=${selected.has(c.id)} @change=${(e: Event) => { if ((e.target as HTMLInputElement).checked) selected.add(c.id); else selected.delete(c.id); h.refresh(); }} /></td>
                <td><div class="who">${avatar(c.name)}<div class="t"><b>${c.name}</b><span>${c.email ?? c.phone ?? "—"} ${emailStatusChip(c.emailStatus)}</span></div></div></td>
                <td>${lifecycleChip(c.lifecycle)} ${c.clientId ? html`<span class="chip ok" title="Linked to a client">client</span>` : nothing}</td>
                <td class="hide-sm">${c.companyName ?? html`<span class="faint">—</span>`}</td>
                <td class="hide-sm">${c.score ? html`<span class="score"><i style="--w:${c.score}%"></i>${c.score}</span>` : html`<span class="faint">—</span>`}</td>
                <td class="hide-sm"><div class="chips">${(c.tags ?? []).slice(0, 3).map((t) => html`<span class="chip">${t}</span>`)}${(c.tags?.length ?? 0) > 3 ? html`<span class="faint small">+${c.tags!.length - 3}</span>` : nothing}</div></td>
                <td class="hide-sm faint">${relTime(c.lastActivityAt ?? c.createdAt)}</td>
              </tr>`,
            )}</tbody>
          </table></div>
          <div class="row" style="justify-content:space-between;margin-top:10px">
            <span class="faint small">Showing ${num(list.length)} of ${num(total)}</span>
            ${total > list.length ? html`<button class="btn sm" @click=${() => { h.ui.contactsLimit = limit + PAGE; h.refresh(); }}>Show more</button>` : nothing}
          </div>`}
    ${modalKind === "addContact" ? addModal(h) : nothing}
    ${modalKind === "dupes" ? duplicatesModal(h) : nothing}
  `;
}
