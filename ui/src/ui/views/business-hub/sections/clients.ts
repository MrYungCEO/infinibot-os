/**
 * Business hub › Clients — the agency client list (agency.db is the source of
 * truth) joined by ID with hub data: lifetime value from the revenue ledger,
 * open deal value and linked contacts. Detail opens in the side sheet.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { money, num, relTime } from "../format";
import type { ClientRow } from "../types";
import { avatar, emptyState, errorCard, searchBox, skeletonRows } from "./ui";

export function renderClients(h: BusinessHubApp): TemplateResult {
  const search = (h.ui.clientsSearch as string) ?? "";
  const status = (h.ui.clientsStatus as string) ?? "";
  const limit = (h.ui.clientsLimit as number) ?? 100;
  const params = { search: search || undefined, status: status || undefined, limit };
  const res = h.load<{ total: number; clients: ClientRow[]; statuses: Array<{ status: string; label: string; count: number }> }>(`clients:${JSON.stringify(params)}`, "hub.clients.list", params);
  const list = res.data?.clients ?? [];
  const paying = list.filter((c) => c.ltvCents > 0).length;

  return html`
    <div class="toolbar">
      ${searchBox(search, (v) => { h.ui.clientsSearch = v; h.refresh(); }, "Search clients")}
      <span class="spacer"></span>
      ${h.openLegacy ? html`<button class="btn" @click=${() => h.openLegacy?.("clients")}>Invoices & client workspace</button>` : nothing}
    </div>
    ${res.data?.statuses?.length
      ? html`<div class="toolbar"><div class="chips">
          <button class="chip" aria-pressed=${!status} @click=${() => { h.ui.clientsStatus = ""; h.refresh(); }}>All <span class="faint">${num(res.data.statuses.reduce((a, s) => a + s.count, 0))}</span></button>
          ${res.data.statuses.map((s) => html`<button class="chip" aria-pressed=${status === s.status} @click=${() => { h.ui.clientsStatus = status === s.status ? "" : s.status; h.refresh(); }}>${s.label} <span class="faint">${num(s.count)}</span></button>`)}
        </div></div>`
      : nothing}
    ${res.error ? errorCard(h, res.error, "clients") : nothing}
    ${res.loading && !res.data
      ? skeletonRows(8)
      : !list.length
        ? emptyState({
            icon: "clients",
            title: search || status ? "No clients match" : "No clients yet",
            text: "A deal becomes a client the moment it's won — by dragging it to Won or when a Whop / Stripe payment arrives.",
            actions: [{ label: "Open pipeline", primary: true, run: () => h.go("pipeline") }],
          })
        : html`
          <div class="faint small" style="margin-bottom:8px">${num(res.data?.total ?? 0)} clients${paying ? ` · ${paying} with payments on this page` : ""} · sorted by lifetime value</div>
          <div class="glass table-wrap"><table class="table">
            <thead><tr><th>Client</th><th>Status</th><th class="r">Lifetime value</th><th class="r hide-sm">Open deals</th><th class="r hide-sm">Contacts</th><th class="hide-sm">Last payment</th></tr></thead>
            <tbody>${list.map(
              (c) => html`<tr class="click" @click=${() => h.openDetail({ kind: "client", id: c.id })}>
                <td><div class="who">${avatar(c.name)}<div class="t"><b>${c.name}</b><span>${c.email ?? c.phone ?? (c.notionLinked ? "Synced from Notion" : "—")}</span></div></div></td>
                <td><span class="chip ${c.status === "active" || c.status === "in progress" ? "ok" : c.status === "lead" ? "gold" : ""}">${c.statusLabel}</span></td>
                <td class="r num ${c.ltvCents ? "" : "faint"}">${c.ltvCents ? money(c.ltvCents) : "—"}</td>
                <td class="r num hide-sm">${c.deals ? html`${c.deals}${c.openDealCents ? html` <span class="faint small">${money(c.openDealCents, "USD", { compact: true })}</span>` : nothing}` : html`<span class="faint">—</span>`}</td>
                <td class="r num hide-sm">${c.contacts || html`<span class="faint">—</span>`}</td>
                <td class="hide-sm faint">${c.lastPaymentAt ? relTime(c.lastPaymentAt) : "—"}</td>
              </tr>`,
            )}</tbody>
          </table></div>
          ${(res.data?.total ?? 0) > list.length ? html`<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn sm" @click=${() => { h.ui.clientsLimit = limit + 100; h.refresh(); }}>Show more</button></div>` : nothing}`}
  `;
}
