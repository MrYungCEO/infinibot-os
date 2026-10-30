/** Offers — product-linked commercial truth + pitch playbook editor. */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { icons } from "../icons";
import { emptyState, skeletonRows } from "./ui";

type Offer = {
  id: string;
  name: string;
  status: string;
  productSource: string | null;
  productId: string | null;
  planId: string | null;
  priceCents: number;
  currency: string;
  icp: { industries: string[]; geos: string[]; companySizes: string[]; signals: string[] };
  valueProp: string;
  proof: string[];
  objections: Array<{ objection: string; answer: string }>;
  cta: { type: string; label: string; url?: string | null; provider?: string };
  playbook: { angle: string; openers: string[]; tone: string; do: string[]; dont: string[] };
  booking: { enabled: boolean; slug: string; timezone: string; durationMinutes: number; externalUrl?: string | null };
};

const split = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/\n|,/)
    .map((x) => x.trim())
    .filter(Boolean);

function editor(h: BusinessHubApp, offer?: Offer): TemplateResult {
  const preview = h.ui.offerPitch as { subject: string; body: string; context: string } | undefined;
  const contacts = h.load<{ contacts: Array<{ id: string; name: string; companyName?: string }> }>(
    "offers.sample.contacts",
    "hub.contacts.list",
    { limit: 8, hasEmail: true },
  ).data?.contacts ?? [];
  return html`<form class="glass card offer-editor" @submit=${async (event: SubmitEvent) => {
    event.preventDefault();
    const fd = new FormData(event.currentTarget as HTMLFormElement);
    const objections = split(fd.get("objections")).map((line) => {
      const [objection, ...answer] = line.split("=>");
      return { objection: objection.trim(), answer: answer.join("=>").trim() };
    }).filter((x) => x.objection && x.answer);
    const saved = await h.act<{ offer: Offer }>("hub.offers.save", {
      offer: {
        id: offer?.id,
        name: fd.get("name"),
        status: fd.get("status"),
        productSource: fd.get("productSource") || null,
        productId: fd.get("productId") || null,
        planId: fd.get("planId") || null,
        priceCents: Math.round(Number(fd.get("price") || 0) * 100),
        currency: fd.get("currency"),
        valueProp: fd.get("valueProp"),
        icp: {
          industries: split(fd.get("industries")), geos: split(fd.get("geos")),
          companySizes: split(fd.get("sizes")), signals: split(fd.get("signals")),
        },
        proof: split(fd.get("proof")), objections,
        cta: { type: fd.get("ctaType"), label: fd.get("ctaLabel"), url: fd.get("ctaUrl") || null, provider: fd.get("ctaProvider") },
        playbook: {
          angle: fd.get("angle"), openers: split(fd.get("openers")), tone: fd.get("tone"),
          do: split(fd.get("do")), dont: split(fd.get("dont")),
        },
        booking: {
          enabled: fd.get("bookingEnabled") === "on", slug: fd.get("bookingSlug"),
          timezone: fd.get("timezone"), durationMinutes: Number(fd.get("duration") || 30),
          externalUrl: fd.get("externalUrl") || null,
        },
      },
    }, offer ? "Offer updated" : "Offer created", "offers");
    if (saved?.offer) h.ui.offerSelected = saved.offer.id;
  }}>
    <div class="section-head"><div><div class="eyebrow">Commercial truth</div><h2>${offer ? `Edit ${offer.name}` : "Create an offer"}</h2></div><span class="chip gold">AI context locked</span></div>
    <div class="form-grid two">
      <label>Name<input class="input" name="name" required .value=${offer?.name ?? ""}></label>
      <label>Status<select class="input" name="status"><option value="active" ?selected=${offer?.status !== "archived"}>Active</option><option value="archived" ?selected=${offer?.status === "archived"}>Archived</option></select></label>
      <label>Product source<select class="input" name="productSource"><option value="manual">Manual</option><option value="products" ?selected=${offer?.productSource === "products"}>Products catalog</option><option value="revenue" ?selected=${offer?.productSource === "revenue"}>Revenue product</option></select></label>
      <label>Product / plan IDs<div class="split"><input class="input" name="productId" placeholder="Product ID" .value=${offer?.productId ?? ""}><input class="input" name="planId" placeholder="Plan ID" .value=${offer?.planId ?? ""}></div></label>
      <label>Price<div class="split money"><input class="input" name="price" type="number" min="0" step="0.01" .value=${String((offer?.priceCents ?? 0) / 100)}><input class="input" name="currency" maxlength="8" .value=${offer?.currency ?? "USD"}></div></label>
      <label>CTA<select class="input" name="ctaType"><option value="book" ?selected=${offer?.cta.type === "book"}>Book a call</option><option value="buy" ?selected=${offer?.cta.type === "buy"}>Buy link</option><option value="reply" ?selected=${offer?.cta.type === "reply"}>Reply</option></select></label>
    </div>
    <label>Value proposition<textarea class="input area" name="valueProp" required placeholder="Specific outcome this offer creates">${offer?.valueProp ?? ""}</textarea></label>
    <div class="form-grid two">
      <label>Industries<input class="input" name="industries" placeholder="Dental, legal, home services" .value=${offer?.icp.industries.join(", ") ?? ""}></label>
      <label>Geographies<input class="input" name="geos" placeholder="Bangkok, Singapore, UK" .value=${offer?.icp.geos.join(", ") ?? ""}></label>
      <label>Company sizes<input class="input" name="sizes" placeholder="2–20, 21–100" .value=${offer?.icp.companySizes.join(", ") ?? ""}></label>
      <label>Buying signals<input class="input" name="signals" placeholder="Hiring, poor conversion, new location" .value=${offer?.icp.signals.join(", ") ?? ""}></label>
    </div>
    <div class="form-grid two">
      <label>Proof / case studies<textarea class="input area" name="proof" placeholder="One proof point per line">${offer?.proof.join("\n") ?? ""}</textarea></label>
      <label>Objections → answers<textarea class="input area" name="objections" placeholder="Too expensive => Start with the highest-leverage slice">${offer?.objections.map((x) => `${x.objection} => ${x.answer}`).join("\n") ?? ""}</textarea></label>
    </div>
    <div class="playbook-panel">
      <div class="section-head"><div><div class="eyebrow">Pitch playbook</div><h3>How the AI sells it</h3></div></div>
      <label>Angle<textarea class="input area sm" name="angle">${offer?.playbook.angle ?? ""}</textarea></label>
      <div class="form-grid two">
        <label>Opener variants<textarea class="input area sm" name="openers" placeholder="One opener per line">${offer?.playbook.openers.join("\n") ?? ""}</textarea></label>
        <label>Tone<input class="input" name="tone" .value=${offer?.playbook.tone ?? "concise, credible, human"}></label>
        <label>Do<textarea class="input area sm" name="do">${offer?.playbook.do.join("\n") ?? ""}</textarea></label>
        <label>Don't<textarea class="input area sm" name="dont">${offer?.playbook.dont.join("\n") ?? ""}</textarea></label>
      </div>
    </div>
    <div class="form-grid two">
      <label>CTA label<input class="input" name="ctaLabel" .value=${offer?.cta.label ?? "Book a short call"}></label>
      <label>CTA URL<input class="input" name="ctaUrl" type="url" placeholder="https://…" .value=${offer?.cta.url ?? ""}></label>
      <label>Booking provider<select class="input" name="ctaProvider"><option value="built_in">Built-in</option><option value="calcom" ?selected=${offer?.cta.provider === "calcom"}>Cal.com</option><option value="calendly" ?selected=${offer?.cta.provider === "calendly"}>Calendly</option><option value="external" ?selected=${offer?.cta.provider === "external"}>External</option></select></label>
      <label class="checkline"><input name="bookingEnabled" type="checkbox" ?checked=${offer?.booking.enabled !== false}> Enable public booking page</label>
      <label>Booking slug<input class="input" name="bookingSlug" .value=${offer?.booking.slug ?? offer?.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") ?? "offer"}></label>
      <label>Time zone<input class="input" name="timezone" .value=${offer?.booking.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}></label>
      <label>Duration (minutes)<input class="input" name="duration" type="number" min="15" step="15" .value=${String(offer?.booking.durationMinutes ?? 30)}></label>
      <label>Cal.com / Calendly URL<input class="input" name="externalUrl" type="url" .value=${offer?.booking.externalUrl ?? ""}></label>
    </div>
    <div class="modal-actions"><button type="button" class="btn" @click=${() => { h.ui.offerSelected = null; h.ui.offerPitch = null; h.refresh(); }}>New blank</button><button class="btn primary" type="submit">${icons.check()} Save offer</button></div>
    ${offer && contacts.length ? html`<div class="pitch-lab"><div class="section-head"><div><div class="eyebrow">Pitch lab</div><h3>Test on a real sample lead</h3></div></div><div class="row"><select class="input" id="offer-sample">${contacts.map((c) => html`<option value=${c.id}>${c.name}${c.companyName ? ` · ${c.companyName}` : ""}</option>`)}</select><button type="button" class="btn" @click=${async () => {
      const select = h.renderRoot.querySelector<HTMLSelectElement>("#offer-sample");
      if (!select?.value) return;
      const result = await h.rpc<{ subject: string; body: string; context: string }>("hub.offers.testPitch", { offerId: offer.id, contactId: select.value });
      h.ui.offerPitch = result; h.refresh();
    }}>${icons.sparkle()} Generate preview</button></div>${preview ? html`<div class="pitch-preview"><b>${preview.subject}</b><pre>${preview.body}</pre><details><summary>Injected offer context</summary><pre>${preview.context}</pre></details></div>` : nothing}</div>` : nothing}
  </form>`;
}

export function renderOffers(h: BusinessHubApp): TemplateResult {
  const state = h.load<{ offers: Offer[] }>("offers", "hub.offers.list", { includeArchived: true });
  if (state.loading) return skeletonRows(6);
  if (state.error) return emptyState({ icon: "offers", title: "Offers could not load", text: state.error });
  const offers = state.data?.offers ?? [];
  const selectedId = String(h.ui.offerSelected ?? offers[0]?.id ?? "");
  const selected = offers.find((x) => x.id === selectedId);
  return html`<div class="autopilot-shell"><aside class="glass card offer-list"><div class="section-head"><div><div class="eyebrow">Offer catalogue</div><h2>${offers.length} offer${offers.length === 1 ? "" : "s"}</h2></div><button class="btn icon" title="New offer" @click=${() => { h.ui.offerSelected = null; h.ui.offerPitch = null; h.refresh(); }}>${icons.plus()}</button></div>${offers.length ? html`<div class="stack">${offers.map((offer) => html`<button class="offer-row ${selected?.id === offer.id ? "active" : ""}" @click=${() => { h.ui.offerSelected = offer.id; h.ui.offerPitch = null; h.refresh(); }}><span><b>${offer.name}</b><small>${offer.productId || "Manual offer"}</small></span><span class="chip ${offer.status === "active" ? "ok" : ""}">${offer.status}</span></button>`)}</div>` : html`<p class="muted">Create the commercial object every lead, message, booking and payment will point back to.</p>`}</aside>${editor(h, selected)}</div>`;
}
