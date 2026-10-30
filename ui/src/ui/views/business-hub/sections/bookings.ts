/** Bookings — offer-linked agenda, availability and public page settings. */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { icons } from "../icons";
import { emptyState, skeletonRows } from "./ui";

type Booking = { id: string; offerId: string; name: string; email: string; startsAt: number; endsAt: number; timezone: string; status: string; calendarLink: string | null };
type Offer = { id: string; name: string; bookingUrl?: string | null; cta: { label: string }; booking: { enabled: boolean; slug: string; timezone: string; durationMinutes: number; externalUrl?: string | null } };

function dayKey(ms: number): string { return new Date(ms).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }); }

export function renderBookings(h: BusinessHubApp): TemplateResult {
  const now = Date.now();
  const bookingsState = h.load<{ bookings: Booking[] }>("bookings", "hub.bookings.list", { from: now - 7 * 86_400_000, to: now + 90 * 86_400_000 });
  const offersState = h.load<{ offers: Offer[] }>("bookings.offers", "hub.offers.list");
  if (bookingsState.loading || offersState.loading) return skeletonRows(6);
  const bookings = bookingsState.data?.bookings ?? [];
  const offers = offersState.data?.offers ?? [];
  if (!offers.length) return emptyState({ icon: "bookings", title: "No booking pages yet", text: "Create an offer to publish a focused booking page linked to its pipeline and pitch.", actions: [{ label: "Create offer", primary: true, run: () => h.go("offers") }] });
  const selectedOfferId = String(h.ui.bookingOffer ?? offers[0].id);
  const offer = offers.find((o) => o.id === selectedOfferId) ?? offers[0];
  const slots = h.load<{ slots: Array<{ startsAt: number; endsAt: number; label: string }> }>(`booking.slots.${offer.id}`, "hub.bookings.availability", { offerId: offer.id, from: now, days: 7, timezone: offer.booking.timezone }, { maxAgeMs: 20_000 }).data?.slots ?? [];
  const groups = new Map<string, Booking[]>();
  for (const b of bookings) groups.set(dayKey(b.startsAt), [...(groups.get(dayKey(b.startsAt)) ?? []), b]);
  // The server derives the public link from the hub's public base URL (on
  // InfiniBot Cloud the tenant Machine's own origin). location.origin is only a
  // fallback for a local install: on Cloud it is the app's static host, which
  // does not serve the booking page.
  const path = `/plugins/business-agency/book?offer=${encodeURIComponent(offer.booking.slug)}`;
  const bookingUrl = offer.bookingUrl || `${location.origin}${path}`;
  return html`<div class="section-head"><div><div class="eyebrow">Appointments</div><h2>Bookings</h2></div><select class="input compact" @change=${(e: Event) => { h.ui.bookingOffer = (e.target as HTMLSelectElement).value; h.refresh(); }}>${offers.map((o) => html`<option value=${o.id} ?selected=${o.id === offer.id}>${o.name}</option>`)}</select></div><div class="booking-layout"><section class="glass card agenda"><div class="section-head"><h3>Agenda</h3><span class="chip ok">${bookings.length} appointment${bookings.length === 1 ? "" : "s"}</span></div>${groups.size ? [...groups.entries()].map(([day, rows]) => html`<div class="agenda-day"><h4>${day}</h4>${rows.map((b) => html`<div class="booking-row"><time>${new Date(b.startsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><span><b>${b.name}</b><small>${offers.find((o) => o.id === b.offerId)?.name ?? "Offer"} · ${b.email}</small></span><span class="chip ${b.status === "booked" ? "ok" : ""}">${b.status}</span></div>`)}</div>`) : html`<p class="muted">No appointments in the next 90 days.</p>`}</section><aside class="stack"><section class="glass card booking-settings"><div class="section-head"><div><div class="eyebrow">Public page</div><h3>${offer.name}</h3></div><span class="chip ${offer.booking.enabled ? "ok" : "bad"}">${offer.booking.enabled ? "Live" : "Off"}</span></div><div class="kv"><dt>Duration</dt><dd>${offer.booking.durationMinutes} minutes</dd><dt>Time zone</dt><dd>${offer.booking.timezone}</dd><dt>CTA</dt><dd>${offer.cta.label}</dd></div><div class="copy-url"><code>${bookingUrl}</code><button class="btn icon" title="Copy booking URL" @click=${async () => { await navigator.clipboard.writeText(bookingUrl); h.showToast("Booking URL copied"); }}>${icons.copy()}</button></div>${offer.booking.externalUrl ? html`<a class="external-link" href=${offer.booking.externalUrl} target="_blank" rel="noreferrer">External calendar ${icons.arrowRight()}</a>` : nothing}<button class="btn" @click=${() => { h.ui.offerSelected = offer.id; h.go("offers"); }}>Edit availability in Offers</button></section><section class="glass card"><div class="section-head"><div><h3>Next available</h3><small class="muted">${offer.booking.timezone}</small></div><span class="chip">7 days</span></div><div class="slot-preview">${slots.slice(0,6).map((s) => html`<span>${s.label}</span>`)}</div></section></aside></div>`;
}
