/**
 * Lead Autopilot — offer-aware lead acquisition, personalised outreach,
 * reply routing, booking and attribution on top of the existing Business Hub.
 *
 * This module deliberately owns no separate database. It composes leadgen,
 * contacts, pipeline, email senders/suppression and revenue through the one
 * HubDb contract so every object remains visible from the existing CRM.
 */

import { createHash } from "node:crypto";
import type { HubDb } from "./db.js";
import { getMeta, setMeta } from "./db.js";
import {
  getCompany,
  getContact,
  getContactByEmail,
  logActivity,
  upsertContact,
  updateContact,
  type Contact,
} from "./contacts.js";
import {
  createDeal,
  ensureDefaultPipeline,
  getDeal,
  moveDeal,
  updateDeal,
  type Deal,
} from "./pipeline.js";
import { importLeadResults } from "./leadgen/import.js";
import { getLeadJob, listLeadResults, startLeadSearch, type LeadJob } from "./leadgen/jobs.js";
import type { LeadgenDeps } from "./leadgen/types.js";
import { sendOne } from "./email/sender-loop.js";
import { HUB_HTTP_BASE, resolveBaseUrl } from "./email/config.js";
import { isSuppressed, stopEnrollments, suppress } from "./email/suppression.js";
import type { SenderRef } from "./email/senders.js";
import { hubId, normalizeEmail, parseJson, str } from "./util.js";
import { coerceString } from "../shared/text/coerce.js";

type Row = Record<string, unknown>;

export type OfferIcp = {
  industries: string[];
  geos: string[];
  companySizes: string[];
  signals: string[];
};

export type OfferCta = {
  type: "book" | "buy" | "reply";
  label: string;
  url?: string | null;
  provider?: "built_in" | "calcom" | "calendly" | "external";
};

export type PitchPlaybook = {
  angle: string;
  openers: string[];
  tone: string;
  do: string[];
  dont: string[];
};

export type BookingRule = {
  days: number[];
  start: string;
  end: string;
};

export type OfferBooking = {
  enabled: boolean;
  slug: string;
  timezone: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  rules: BookingRule[];
  location?: string | null;
  externalUrl?: string | null;
  syncGoogle?: boolean;
  sendConfirmation?: boolean;
  sender?: SenderRef;
};

export type Offer = {
  id: string;
  businessId: string | null;
  name: string;
  status: "active" | "archived";
  productSource: "products" | "revenue" | "manual" | null;
  productId: string | null;
  planId: string | null;
  priceCents: number;
  currency: string;
  icp: OfferIcp;
  valueProp: string;
  proof: string[];
  objections: Array<{ objection: string; answer: string }>;
  cta: OfferCta;
  playbook: PitchPlaybook;
  booking: OfferBooking;
  /**
   * Public URL of the built-in booking page, derived on read from the hub's
   * public base URL (on InfiniBot Cloud: the tenant Machine's own origin,
   * FLEET_PUBLIC_URL). Never persisted; null when no public origin is known.
   */
  bookingUrl?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type AutopilotStep = {
  delayMinutes: number;
  subject: string;
  instruction: string;
};

export type AutopilotCampaign = {
  id: string;
  businessId: string | null;
  offerId: string;
  name: string;
  status: "draft" | "active" | "paused" | "stopped" | "completed";
  sourceQuery: string;
  location: string | null;
  providers: string[];
  audience: {
    minScore?: number;
    requireVerifiedEmail?: boolean;
    allowExisting?: boolean;
    country?: string;
  };
  sequence: AutopilotStep[];
  schedule: {
    cadence: "manual" | "daily" | "weekdays";
    leadsPerRun: number;
    timezone: string;
    sendWindow: { start: string; end: string };
    sender?: SenderRef;
  };
  sendMode: "approval" | "auto";
  dailyCap: number;
  warmupDays: number;
  stopOnReply: boolean;
  stopOnBook: boolean;
  liveSendEnabled: boolean;
  emailCampaignId: string | null;
  leadgenJobId: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ReplyClass =
  | "interested"
  | "question"
  | "objection"
  | "not_now"
  | "unsubscribe"
  | "ooo";

export type Booking = {
  id: string;
  offerId: string;
  campaignId: string | null;
  contactId: string | null;
  dealId: string | null;
  name: string;
  email: string;
  startsAt: number;
  endsAt: number;
  timezone: string;
  status: string;
  notes: string | null;
  publicToken: string;
  calendarEventId: string | null;
  calendarLink: string | null;
  createdAt: number;
  updatedAt: number;
};

const DEFAULT_ICP: OfferIcp = { industries: [], geos: [], companySizes: [], signals: [] };
const DEFAULT_PLAYBOOK: PitchPlaybook = {
  angle: "Lead with the prospect's likely outcome, then connect it to concrete proof.",
  openers: ["Noticed {{company}} and had a specific idea.", "Quick idea for {{company}}."],
  tone: "concise, credible, human",
  do: ["be specific", "make the next step easy", "use proof honestly"],
  dont: ["invent facts", "overpromise", "use fake urgency"],
};
const DEFAULT_BOOKING: OfferBooking = {
  enabled: true,
  slug: "offer",
  timezone: "UTC",
  durationMinutes: 30,
  bufferBeforeMinutes: 10,
  bufferAfterMinutes: 10,
  minNoticeMinutes: 120,
  horizonDays: 30,
  rules: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
  sendConfirmation: true,
};
const DEFAULT_SEQUENCE: AutopilotStep[] = [
  { delayMinutes: 0, subject: "Idea for {{company}}", instruction: "Personalised first touch" },
  {
    delayMinutes: 2 * 24 * 60,
    subject: "Re: idea for {{company}}",
    instruction: "Short value-led follow-up",
  },
  { delayMinutes: 5 * 24 * 60, subject: "Worth exploring?", instruction: "Polite final follow-up" },
];

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "offer"
  );
}

function uniqueOfferSlug(db: HubDb, wanted: string, id?: string): string {
  const base = slugify(wanted);
  let slug = base;
  for (
    let n = 2;
    db
      .prepare(
        "SELECT 1 FROM offers WHERE json_extract(booking,'$.slug')=? AND (? IS NULL OR id<>?)",
      )
      .get(slug, id ?? null, id ?? null);
    n++
  )
    slug = `${base}-${n}`;
  return slug;
}

function rowToOffer(r: Row): Offer {
  const booking = parseJson<OfferBooking>(r.booking, DEFAULT_BOOKING);
  return {
    id: r.id as string,
    businessId: (r.business_id as string) ?? null,
    name: r.name as string,
    status: r.status as Offer["status"],
    productSource: (r.product_source as Offer["productSource"]) ?? null,
    productId: (r.product_id as string) ?? null,
    planId: (r.plan_id as string) ?? null,
    priceCents: Number(r.price_cents ?? 0),
    currency: (r.currency as string) ?? "USD",
    icp: { ...DEFAULT_ICP, ...parseJson<OfferIcp>(r.icp, DEFAULT_ICP) },
    valueProp: (r.value_prop as string) ?? "",
    proof: parseJson<string[]>(r.proof, []),
    objections: parseJson<Array<{ objection: string; answer: string }>>(r.objections, []),
    cta: parseJson<OfferCta>(r.cta, { type: "reply", label: "Reply if useful" }),
    playbook: { ...DEFAULT_PLAYBOOK, ...parseJson<PitchPlaybook>(r.playbook, DEFAULT_PLAYBOOK) },
    booking: { ...DEFAULT_BOOKING, ...booking },
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToCampaign(r: Row): AutopilotCampaign {
  return {
    id: r.id as string,
    businessId: (r.business_id as string) ?? null,
    offerId: r.offer_id as string,
    name: r.name as string,
    status: r.status as AutopilotCampaign["status"],
    sourceQuery: r.source_query as string,
    location: (r.location as string) ?? null,
    providers: parseJson<string[]>(r.providers, []),
    audience: parseJson<AutopilotCampaign["audience"]>(r.audience, {}),
    sequence: parseJson<AutopilotStep[]>(r.sequence, DEFAULT_SEQUENCE),
    schedule: parseJson<AutopilotCampaign["schedule"]>(r.schedule, {
      cadence: "manual",
      leadsPerRun: 25,
      timezone: "UTC",
      sendWindow: { start: "09:00", end: "17:00" },
    }),
    sendMode: r.send_mode as AutopilotCampaign["sendMode"],
    dailyCap: Number(r.daily_cap ?? 25),
    warmupDays: Number(r.warmup_days ?? 7),
    stopOnReply: !!r.stop_on_reply,
    stopOnBook: !!r.stop_on_book,
    liveSendEnabled: !!r.live_send_enabled,
    emailCampaignId: (r.email_campaign_id as string) ?? null,
    leadgenJobId: (r.leadgen_job_id as string) ?? null,
    lastRunAt: (r.last_run_at as number) ?? null,
    nextRunAt: (r.next_run_at as number) ?? null,
    error: (r.error as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToBooking(r: Row): Booking {
  return {
    id: r.id as string,
    offerId: r.offer_id as string,
    campaignId: (r.campaign_id as string) ?? null,
    contactId: (r.contact_id as string) ?? null,
    dealId: (r.deal_id as string) ?? null,
    name: r.name as string,
    email: r.email as string,
    startsAt: r.starts_at as number,
    endsAt: r.ends_at as number,
    timezone: r.timezone as string,
    status: r.status as string,
    notes: (r.notes as string) ?? null,
    publicToken: r.public_token as string,
    calendarEventId: (r.calendar_event_id as string) ?? null,
    calendarLink: (r.calendar_link as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function listOffers(db: HubDb, includeArchived = false): Offer[] {
  const rows = db
    .prepare(
      `SELECT * FROM offers ${includeArchived ? "" : "WHERE status='active'"} ORDER BY updated_at DESC`,
    )
    .all() as Row[];
  return rows.map((r) => withBookingUrl(db, rowToOffer(r)));
}

export function getOffer(db: HubDb, idOrSlug: string): Offer | null {
  const r = db
    .prepare("SELECT * FROM offers WHERE id=? OR json_extract(booking,'$.slug')=? LIMIT 1")
    .get(idOrSlug, idOrSlug) as Row | undefined;
  return r ? withBookingUrl(db, rowToOffer(r)) : null;
}

function withBookingUrl(db: HubDb, offer: Offer): Offer {
  const base = offer.booking.enabled ? resolveBaseUrl(db) : null;
  return { ...offer, bookingUrl: base ? bookingPageUrl(base, offer) : null };
}

/**
 * Link a message's CTA points at: the explicit CTA URL, else, for a "book a
 * call" CTA on the built-in calendar, this offer's public booking page.
 */
export function offerCtaUrl(offer: Offer): string | null {
  if (offer.cta.url) return offer.cta.url;
  const builtIn = !offer.cta.provider || offer.cta.provider === "built_in";
  return offer.cta.type === "book" && builtIn ? (offer.bookingUrl ?? null) : null;
}

/**
 * InfiniBot Cloud keeps outbound approval-first: on a hosted tenant every
 * autopilot message and reply waits for the owner's approval (no auto-send).
 */
export function autopilotApprovalOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    Boolean(env.FLEET_TENANT_ID?.trim()) || /^(1|true|yes|on)$/i.test(env.SAAS_MODE?.trim() ?? "")
  );
}

function autoSends(campaign: AutopilotCampaign): boolean {
  return campaign.sendMode === "auto" && campaign.liveSendEnabled && !autopilotApprovalOnly();
}

export type OfferInput = Partial<Omit<Offer, "id" | "createdAt" | "updatedAt">> & {
  id?: string;
  name?: string;
};

export function saveOffer(db: HubDb, input: OfferInput): Offer {
  const cur = input.id ? getOffer(db, input.id) : null;
  if (input.id && !cur) throw new Error(`offer not found: ${input.id}`);
  const name = (str(input.name) ?? cur?.name ?? "").slice(0, 180);
  if (!name) throw new Error("offer name required");
  const now = Date.now();
  const bookingInput = { ...DEFAULT_BOOKING, ...cur?.booking, ...input.booking };
  const booking = {
    ...bookingInput,
    slug: uniqueOfferSlug(db, bookingInput.slug || name, cur?.id),
    durationMinutes: Math.max(15, Math.min(240, Number(bookingInput.durationMinutes) || 30)),
    horizonDays: Math.max(1, Math.min(180, Number(bookingInput.horizonDays) || 30)),
  };
  const vals = {
    businessId: input.businessId !== undefined ? input.businessId : (cur?.businessId ?? null),
    status: input.status ?? cur?.status ?? "active",
    productSource:
      input.productSource !== undefined ? input.productSource : (cur?.productSource ?? null),
    productId: input.productId !== undefined ? str(input.productId) : (cur?.productId ?? null),
    planId: input.planId !== undefined ? str(input.planId) : (cur?.planId ?? null),
    priceCents: Math.max(0, Math.round(input.priceCents ?? cur?.priceCents ?? 0)),
    currency: (input.currency ?? cur?.currency ?? "USD").toUpperCase().slice(0, 8),
    icp: { ...DEFAULT_ICP, ...cur?.icp, ...input.icp },
    valueProp: (input.valueProp ?? cur?.valueProp ?? "").trim(),
    proof: input.proof ?? cur?.proof ?? [],
    objections: input.objections ?? cur?.objections ?? [],
    cta: input.cta ?? cur?.cta ?? { type: "reply", label: "Reply if useful" },
    playbook: { ...DEFAULT_PLAYBOOK, ...cur?.playbook, ...input.playbook },
    booking,
  };
  let id = cur?.id ?? hubId("off");
  if (cur) {
    db.prepare(
      `UPDATE offers SET business_id=?,name=?,status=?,product_source=?,product_id=?,plan_id=?,price_cents=?,currency=?,
       icp=?,value_prop=?,proof=?,objections=?,cta=?,playbook=?,booking=?,updated_at=? WHERE id=?`,
    ).run(
      vals.businessId,
      name,
      vals.status,
      vals.productSource,
      vals.productId,
      vals.planId,
      vals.priceCents,
      vals.currency,
      JSON.stringify(vals.icp),
      vals.valueProp,
      JSON.stringify(vals.proof),
      JSON.stringify(vals.objections),
      JSON.stringify(vals.cta),
      JSON.stringify(vals.playbook),
      JSON.stringify(vals.booking),
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO offers(id,business_id,name,status,product_source,product_id,plan_id,price_cents,currency,icp,value_prop,proof,objections,cta,playbook,booking,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      vals.businessId,
      name,
      vals.status,
      vals.productSource,
      vals.productId,
      vals.planId,
      vals.priceCents,
      vals.currency,
      JSON.stringify(vals.icp),
      vals.valueProp,
      JSON.stringify(vals.proof),
      JSON.stringify(vals.objections),
      JSON.stringify(vals.cta),
      JSON.stringify(vals.playbook),
      JSON.stringify(vals.booking),
      now,
      now,
    );
  }
  audit(db, {
    offerId: id,
    action: cur ? "offer.updated" : "offer.created",
    subjectType: "offer",
    subjectId: id,
  });
  return getOffer(db, id)!;
}

export function productOptions(db: HubDb): Array<{
  source: "revenue";
  id: string;
  planId: string | null;
  name: string;
}> {
  return (
    db
      .prepare(
        `SELECT DISTINCT product_id,plan_id,COALESCE(product_name,product_id) AS name
         FROM revenue_txns WHERE product_id IS NOT NULL
         UNION
         SELECT external_id,NULL,name FROM revenue_products
         ORDER BY name`,
      )
      .all() as Array<{ product_id: string; plan_id: string | null; name: string }>
  ).map((r) => ({ source: "revenue", id: r.product_id, planId: r.plan_id, name: r.name }));
}

export function pitchContext(offer: Offer): string {
  return [
    `ACTIVE OFFER: ${offer.name}`,
    `PRICE: ${offer.currency} ${(offer.priceCents / 100).toFixed(2)}`,
    `VALUE: ${offer.valueProp || "No value proposition recorded"}`,
    `ICP: industries=${offer.icp.industries.join(", ") || "any"}; geos=${offer.icp.geos.join(", ") || "any"}; sizes=${offer.icp.companySizes.join(", ") || "any"}; signals=${offer.icp.signals.join(", ") || "none"}`,
    `PROOF: ${offer.proof.join(" | ") || "No proof recorded"}`,
    `ANGLE: ${offer.playbook.angle}`,
    `TONE: ${offer.playbook.tone}`,
    `DO: ${offer.playbook.do.join("; ")}`,
    `DON'T: ${offer.playbook.dont.join("; ")}`,
    `CTA: ${offer.cta.label}${offerCtaUrl(offer) ? ` — ${offerCtaUrl(offer)}` : ""}`,
  ].join("\n");
}

function leadSnapshot(
  db: HubDb,
  contactId: string,
): { contact: Contact; company: ReturnType<typeof getCompany> } {
  const contact = getContact(db, contactId);
  if (!contact) throw new Error(`contact not found: ${contactId}`);
  return { contact, company: contact.companyId ? getCompany(db, contact.companyId) : null };
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function fill(value: string, vars: Record<string, string>): string {
  return value.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k: string) => vars[k.toLowerCase()] ?? "");
}

export function writePitch(
  db: HubDb,
  offerId: string,
  contactId: string,
  opts: { step?: number; instruction?: string } = {},
): { subject: string; body: string; context: string } {
  const offer = getOffer(db, offerId);
  if (!offer) throw new Error(`offer not found: ${offerId}`);
  const { contact, company } = leadSnapshot(db, contactId);
  const step = Math.max(0, opts.step ?? 0);
  const opener =
    offer.playbook.openers[step % Math.max(1, offer.playbook.openers.length)] ??
    "Quick idea for {{company}}.";
  const companyName = company?.name ?? contact.name ?? "your team";
  const vars = { first_name: firstName(contact.name), name: contact.name, company: companyName };
  const websiteNote = company?.website
    ? `I took a look at ${company.website} and the opportunity that stood out was making the next growth step easier to act on.`
    : `I had a specific thought about how ${companyName} could make the next growth step easier to act on.`;
  const proof = offer.proof[0]
    ? `The closest proof point: ${offer.proof[0]}`
    : "I can show you the exact approach before you decide.";
  const followUp = step > 0 ? "Following up briefly in case this got buried. " : "";
  const instruction = opts.instruction ? ` ${opts.instruction.trim()}` : "";
  const body = [
    `Hi ${vars.first_name},`,
    "",
    `${followUp}${fill(opener, vars)} ${websiteNote}`,
    "",
    `${offer.valueProp}${instruction}`.trim(),
    proof,
    "",
    offerCtaUrl(offer) ? `${offer.cta.label}: ${offerCtaUrl(offer)}` : offer.cta.label,
    "",
    "Best,",
  ].join("\n");
  return {
    subject: fill(step ? `Re: ${offer.name} for {{company}}` : `Idea for {{company}}`, vars),
    body,
    context: pitchContext(offer),
  };
}

export function handleObjection(
  db: HubDb,
  offerId: string,
  objection: string,
): { answer: string; context: string } {
  const offer = getOffer(db, offerId);
  if (!offer) throw new Error(`offer not found: ${offerId}`);
  const words = new Set(
    objection
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
  let best: { objection: string; answer: string } | null = null;
  let score = -1;
  for (const item of offer.objections) {
    const n = item.objection
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => words.has(w)).length;
    if (n > score) {
      score = n;
      best = item;
    }
  }
  const answer = best?.answer
    ? `${best.answer}\n\n${offer.cta.label}${offerCtaUrl(offer) ? `: ${offerCtaUrl(offer)}` : ""}`
    : `That makes sense. ${offer.valueProp} ${offer.proof[0] ?? "I can share a concise example."} ${offer.cta.label}${offerCtaUrl(offer) ? `: ${offerCtaUrl(offer)}` : ""}`;
  return { answer, context: pitchContext(offer) };
}

function ensureAttributionCampaign(db: HubDb, name: string, id?: string | null): string {
  if (id && db.prepare("SELECT 1 FROM campaigns WHERE id=?").get(id)) return id;
  const now = Date.now();
  const campaignId = hubId("cmp");
  let utm = slugify(name);
  for (let n = 2; db.prepare("SELECT 1 FROM campaigns WHERE utm_campaign=?").get(utm); n++)
    utm = `${slugify(name)}-${n}`;
  db.prepare(
    "INSERT INTO campaigns(id,name,utm_campaign,channel,status,created_at,updated_at) VALUES(?,?,?,'autopilot','draft',?,?)",
  ).run(campaignId, name, utm, now, now);
  return campaignId;
}

export function getAutopilotCampaign(db: HubDb, id: string): AutopilotCampaign | null {
  const r = db.prepare("SELECT * FROM autopilot_campaigns WHERE id=?").get(id) as Row | undefined;
  return r ? rowToCampaign(r) : null;
}

export function listAutopilotCampaigns(db: HubDb): AutopilotCampaign[] {
  return (
    db.prepare("SELECT * FROM autopilot_campaigns ORDER BY updated_at DESC").all() as Row[]
  ).map(rowToCampaign);
}

export type AutopilotCampaignInput = Partial<
  Omit<AutopilotCampaign, "id" | "createdAt" | "updatedAt" | "lastRunAt" | "error">
> & { id?: string; offerId?: string; name?: string; sourceQuery?: string };

export function saveAutopilotCampaign(db: HubDb, input: AutopilotCampaignInput): AutopilotCampaign {
  const cur = input.id ? getAutopilotCampaign(db, input.id) : null;
  if (input.id && !cur) throw new Error(`autopilot campaign not found: ${input.id}`);
  const offerId = input.offerId ?? cur?.offerId ?? "";
  const offer = getOffer(db, offerId);
  if (!offer) throw new Error("choose a valid offer");
  const name = (str(input.name) ?? cur?.name ?? `${offer.name} Autopilot`).slice(0, 180);
  const sourceQuery = (str(input.sourceQuery) ?? cur?.sourceQuery ?? "").slice(0, 240);
  if (!sourceQuery) throw new Error("lead source query required");
  const sequence = (input.sequence ?? cur?.sequence ?? DEFAULT_SEQUENCE).slice(0, 12).map((s) => ({
    delayMinutes: Math.max(0, Math.min(525_600, Math.round(Number(s.delayMinutes) || 0))),
    subject: String(s.subject || "Idea for {{company}}").slice(0, 300),
    instruction: String(s.instruction || "Follow up with value").slice(0, 1_000),
  }));
  if (!sequence.length) throw new Error("add at least one sequence step");
  const schedule = {
    cadence: input.schedule?.cadence ?? cur?.schedule.cadence ?? "manual",
    leadsPerRun: Math.max(
      1,
      Math.min(200, input.schedule?.leadsPerRun ?? cur?.schedule.leadsPerRun ?? 25),
    ),
    timezone: input.schedule?.timezone ?? cur?.schedule.timezone ?? offer.booking.timezone ?? "UTC",
    sendWindow: input.schedule?.sendWindow ??
      cur?.schedule.sendWindow ?? { start: "09:00", end: "17:00" },
    sender: input.schedule?.sender ?? cur?.schedule.sender,
  } as AutopilotCampaign["schedule"];
  const now = Date.now();
  const campaignId = ensureAttributionCampaign(db, name, cur?.emailCampaignId);
  const vals = {
    businessId:
      input.businessId !== undefined ? input.businessId : (cur?.businessId ?? offer.businessId),
    status: input.status ?? cur?.status ?? "draft",
    location: input.location !== undefined ? str(input.location) : (cur?.location ?? null),
    providers: input.providers ?? cur?.providers ?? [],
    audience: { ...cur?.audience, ...input.audience },
    sequence,
    schedule,
    sendMode: autopilotApprovalOnly()
      ? ("approval" as const)
      : (input.sendMode ?? cur?.sendMode ?? "approval"),
    dailyCap: Math.max(1, Math.min(10_000, input.dailyCap ?? cur?.dailyCap ?? 25)),
    warmupDays: Math.max(1, Math.min(60, input.warmupDays ?? cur?.warmupDays ?? 7)),
    stopOnReply: input.stopOnReply ?? cur?.stopOnReply ?? true,
    stopOnBook: input.stopOnBook ?? cur?.stopOnBook ?? true,
    liveSendEnabled: input.liveSendEnabled ?? cur?.liveSendEnabled ?? false,
    nextRunAt: input.nextRunAt !== undefined ? input.nextRunAt : (cur?.nextRunAt ?? null),
  };
  const id = cur?.id ?? hubId("apc");
  if (cur) {
    db.prepare(
      `UPDATE autopilot_campaigns SET business_id=?,offer_id=?,name=?,status=?,source_query=?,location=?,providers=?,audience=?,sequence=?,schedule=?,send_mode=?,daily_cap=?,warmup_days=?,stop_on_reply=?,stop_on_book=?,live_send_enabled=?,email_campaign_id=?,next_run_at=?,updated_at=? WHERE id=?`,
    ).run(
      vals.businessId,
      offerId,
      name,
      vals.status,
      sourceQuery,
      vals.location,
      JSON.stringify(vals.providers),
      JSON.stringify(vals.audience),
      JSON.stringify(vals.sequence),
      JSON.stringify(vals.schedule),
      vals.sendMode,
      vals.dailyCap,
      vals.warmupDays,
      vals.stopOnReply ? 1 : 0,
      vals.stopOnBook ? 1 : 0,
      vals.liveSendEnabled ? 1 : 0,
      campaignId,
      vals.nextRunAt,
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO autopilot_campaigns(id,business_id,offer_id,name,status,source_query,location,providers,audience,sequence,schedule,send_mode,daily_cap,warmup_days,stop_on_reply,stop_on_book,live_send_enabled,email_campaign_id,next_run_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      vals.businessId,
      offerId,
      name,
      vals.status,
      sourceQuery,
      vals.location,
      JSON.stringify(vals.providers),
      JSON.stringify(vals.audience),
      JSON.stringify(vals.sequence),
      JSON.stringify(vals.schedule),
      vals.sendMode,
      vals.dailyCap,
      vals.warmupDays,
      vals.stopOnReply ? 1 : 0,
      vals.stopOnBook ? 1 : 0,
      vals.liveSendEnabled ? 1 : 0,
      campaignId,
      vals.nextRunAt,
      now,
      now,
    );
  }
  db.prepare("UPDATE campaigns SET name=?,status=?,updated_at=? WHERE id=?").run(
    name,
    vals.status,
    now,
    campaignId,
  );
  audit(db, {
    campaignId: id,
    offerId,
    action: cur ? "campaign.updated" : "campaign.created",
    subjectType: "campaign",
    subjectId: id,
  });
  return getAutopilotCampaign(db, id)!;
}

function nextScheduleAt(c: AutopilotCampaign, now: number): number | null {
  if (c.schedule.cadence === "manual") return null;
  let next = now + 24 * 60 * 60_000;
  if (c.schedule.cadence === "weekdays") {
    while ([0, 6].includes(new Date(next).getUTCDay())) next += 24 * 60 * 60_000;
  }
  return next;
}

export function setAutopilotStatus(
  db: HubDb,
  id: string,
  status: "active" | "paused" | "stopped",
  opts: { liveSend?: boolean; now?: number } = {},
): AutopilotCampaign {
  const cur = getAutopilotCampaign(db, id);
  if (!cur) throw new Error("autopilot campaign not found");
  const now = opts.now ?? Date.now();
  const next = status === "active" ? (cur.nextRunAt ?? now) : null;
  db.prepare(
    `UPDATE autopilot_campaigns SET status=?,live_send_enabled=?,next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?`,
  ).run(
    status,
    opts.liveSend === true ? 1 : status === "active" ? (cur.liveSendEnabled ? 1 : 0) : 0,
    next,
    now,
    id,
  );
  db.prepare("UPDATE campaigns SET status=?,updated_at=? WHERE id=?").run(
    status === "stopped" ? "completed" : status,
    now,
    cur.emailCampaignId,
  );
  audit(db, {
    campaignId: id,
    offerId: cur.offerId,
    action: `campaign.${status}`,
    subjectType: "campaign",
    subjectId: id,
  });
  return getAutopilotCampaign(db, id)!;
}

function audit(
  db: HubDb,
  input: {
    campaignId?: string | null;
    offerId?: string | null;
    action: string;
    subjectType?: string | null;
    subjectId?: string | null;
    status?: string;
    detail?: Record<string, unknown>;
    idempotencyKey?: string | null;
    now?: number;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO autopilot_audit(id,idempotency_key,campaign_id,offer_id,action,subject_type,subject_id,status,detail,occurred_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    hubId("apa"),
    input.idempotencyKey ?? null,
    input.campaignId ?? null,
    input.offerId ?? null,
    input.action,
    input.subjectType ?? null,
    input.subjectId ?? null,
    input.status ?? "ok",
    JSON.stringify(input.detail ?? {}),
    input.now ?? Date.now(),
  );
}

function attribute(
  db: HubDb,
  input: {
    offerId: string;
    campaignId?: string | null;
    contactId?: string | null;
    dealId?: string | null;
    messageId?: string | null;
    bookingId?: string | null;
    revenueTxnId?: string | null;
    event: string;
    valueCents?: number;
    costCents?: number;
    metadata?: Record<string, unknown>;
    occurredAt?: number;
    dedupeKey?: string;
  },
): void {
  const key =
    input.dedupeKey ??
    [
      input.event,
      input.campaignId,
      input.contactId,
      input.dealId,
      input.messageId,
      input.bookingId,
      input.revenueTxnId,
    ].join(":");
  db.prepare(
    `INSERT OR IGNORE INTO autopilot_attribution(id,dedupe_key,offer_id,campaign_id,contact_id,deal_id,message_id,booking_id,revenue_txn_id,event,value_cents,cost_cents,metadata,occurred_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    hubId("att"),
    key,
    input.offerId,
    input.campaignId ?? null,
    input.contactId ?? null,
    input.dealId ?? null,
    input.messageId ?? null,
    input.bookingId ?? null,
    input.revenueTxnId ?? null,
    input.event,
    Math.round(input.valueCents ?? 0),
    Math.round(input.costCents ?? 0),
    JSON.stringify(input.metadata ?? {}),
    input.occurredAt ?? Date.now(),
  );
}

function ensureDealForLead(
  db: HubDb,
  campaign: AutopilotCampaign,
  contactId: string | null,
  companyId: string | null,
  jobId: string,
): Deal | null {
  if (!contactId && !companyId) return null;
  const existing = db
    .prepare(
      `SELECT id FROM deals WHERE status='open' AND (contact_id=? OR (? IS NULL AND company_id=?))
       AND json_extract(custom,'$.offerId')=? LIMIT 1`,
    )
    .get(contactId, contactId, companyId, campaign.offerId) as { id: string } | undefined;
  if (existing) return getDeal(db, existing.id);
  const offer = getOffer(db, campaign.offerId)!;
  const contact = contactId ? getContact(db, contactId) : null;
  const company = companyId ? getCompany(db, companyId) : null;
  return createDeal(
    db,
    {
      title: `${company?.name ?? contact?.name ?? "Lead"} — ${offer.name}`,
      contactId,
      companyId,
      businessId: campaign.businessId,
      campaignId: campaign.emailCampaignId,
      valueCents: offer.priceCents,
      currency: offer.currency,
      nextAction: "Review personalised first touch",
      nextActionAt: Date.now(),
      custom: {
        offerId: offer.id,
        autopilotCampaignId: campaign.id,
        leadgenJobId: jobId,
        sequenceStep: 0,
      },
    },
    { actor: "autopilot" },
  );
}

function createMessage(
  db: HubDb,
  campaign: AutopilotCampaign,
  contactId: string,
  dealId: string | null,
  stepIndex: number,
  dueAt: number,
): string {
  const step = campaign.sequence[stepIndex];
  if (!step) throw new Error("sequence step not found");
  const pitch = writePitch(db, campaign.offerId, contactId, {
    step: stepIndex,
    instruction: step.instruction,
  });
  const snapshot = leadSnapshot(db, contactId);
  const company = snapshot.company?.name ?? snapshot.contact.name;
  const subject = fill(step.subject || pitch.subject, {
    company,
    first_name: firstName(snapshot.contact.name),
  });
  const id = hubId("apm");
  const status = autoSends(campaign) ? "scheduled" : "draft";
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO autopilot_messages(id,campaign_id,offer_id,contact_id,deal_id,step_index,direction,status,subject,body,metadata,due_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?, 'outbound',?,?,?,?,?,?,?)`,
  ).run(
    id,
    campaign.id,
    campaign.offerId,
    contactId,
    dealId,
    stepIndex,
    status,
    subject,
    pitch.body,
    JSON.stringify({ pitchContext: pitch.context }),
    dueAt,
    now,
    now,
  );
  const row = db
    .prepare(
      "SELECT id FROM autopilot_messages WHERE campaign_id=? AND contact_id=? AND step_index=? AND direction='outbound'",
    )
    .get(campaign.id, contactId, stepIndex) as { id: string };
  return row.id;
}

function warmCap(c: AutopilotCampaign, now: number): number {
  const day = Math.max(1, Math.floor((now - c.createdAt) / 86_400_000) + 1);
  return Math.max(1, Math.ceil(c.dailyCap * Math.min(1, day / c.warmupDays)));
}

export type AutopilotRunDeps = { leadgen?: LeadgenDeps; now?: () => number };

export async function runAutopilotCampaign(
  db: HubDb,
  id: string,
  deps: AutopilotRunDeps = {},
): Promise<{
  job: LeadJob;
  imported: number;
  skippedExisting: number;
  skippedUnqualified: number;
  contacts: string[];
  deals: string[];
  messages: string[];
}> {
  const now = deps.now?.() ?? Date.now();
  let campaign = getAutopilotCampaign(db, id);
  if (!campaign) throw new Error("autopilot campaign not found");
  if (campaign.status !== "active") throw new Error(`campaign is ${campaign.status}`);
  if (getMeta(db, "autopilot.killSwitch") === "1")
    throw new Error("Lead Autopilot kill switch is on");
  const lease = hubId("lease");
  const locked = db
    .prepare(
      `UPDATE autopilot_campaigns SET lease_token=?,lease_until=?,updated_at=?
       WHERE id=? AND (lease_until IS NULL OR lease_until<?)`,
    )
    .run(lease, now + 30 * 60_000, now, id, now);
  if (!locked.changes) throw new Error("campaign run already in progress");
  audit(db, {
    campaignId: id,
    offerId: campaign.offerId,
    action: "run.started",
    idempotencyKey: `${id}:run:${now}`,
    now,
  });
  try {
    const cap = Math.min(campaign.schedule.leadsPerRun, warmCap(campaign, now));
    const search = startLeadSearch(
      db,
      {
        query: campaign.sourceQuery,
        location: campaign.location,
        providers: campaign.providers.length ? campaign.providers : undefined,
        limit: cap,
        enrich: true,
        verify: true,
        businessId: campaign.businessId,
        country: campaign.audience.country,
      },
      deps.leadgen,
    );
    db.prepare("UPDATE autopilot_campaigns SET leadgen_job_id=? WHERE id=?").run(search.jobId, id);
    await search.done;
    const job = getLeadJob(db, search.jobId);
    if (!job || job.status !== "done") throw new Error(job?.error ?? "lead search failed");
    const results = listLeadResults(db, search.jobId, { limit: 200 }).results;
    const selected = results.filter((r) => {
      if (!campaign!.audience.allowExisting && r.data.existing) return false;
      if (typeof campaign!.audience.minScore === "number" && r.score < campaign!.audience.minScore)
        return false;
      if (campaign!.audience.requireVerifiedEmail && r.data.emailStatus !== "valid") return false;
      if (!r.data.email || isSuppressed(db, r.data.email)) return false;
      return true;
    });
    const selectedIds = new Set(selected.map((r) => r.id));
    const skippedExisting = results.filter(
      (r) => r.data.existing && !campaign!.audience.allowExisting,
    ).length;
    const skippedUnqualified = results.length - selected.length - skippedExisting;
    const pairs: Array<{ contactId: string | null; companyId: string | null }> = [];
    const imported = importLeadResults(db, search.jobId, [...selectedIds], {
      tags: [`autopilot:${campaign.id}`, `offer:${campaign.offerId}`],
      actor: "autopilot",
      onImported: (contactId, companyId) => pairs.push({ contactId, companyId }),
    });
    campaign = getAutopilotCampaign(db, id)!;
    const deals: string[] = [];
    const messages: string[] = [];
    for (const pair of pairs) {
      if (!pair.contactId) continue;
      const deal = ensureDealForLead(db, campaign, pair.contactId, pair.companyId, search.jobId);
      if (deal) deals.push(deal.id);
      const contact = getContact(db, pair.contactId)!;
      updateContact(
        db,
        pair.contactId,
        {
          custom: {
            ...contact.custom,
            offerId: campaign.offerId,
            autopilotCampaignId: campaign.id,
            leadgenJobId: search.jobId,
          },
        },
        "autopilot",
      );
      const messageId = createMessage(db, campaign, pair.contactId, deal?.id ?? null, 0, now);
      messages.push(messageId);
      attribute(db, {
        offerId: campaign.offerId,
        campaignId: campaign.id,
        contactId: pair.contactId,
        dealId: deal?.id,
        event: "lead.verified",
        dedupeKey: `verified:${campaign.id}:${pair.contactId}`,
        metadata: { jobId: search.jobId },
        occurredAt: now,
      });
      audit(db, {
        campaignId: campaign.id,
        offerId: campaign.offerId,
        action: "lead.enrolled",
        subjectType: "contact",
        subjectId: pair.contactId,
        detail: { dealId: deal?.id ?? null, messageId },
        idempotencyKey: `enroll:${campaign.id}:${pair.contactId}`,
        now,
      });
    }
    attribute(db, {
      offerId: campaign.offerId,
      campaignId: campaign.id,
      event: "lead.scraped",
      valueCents: results.length,
      dedupeKey: `scraped:${campaign.id}:${search.jobId}`,
      metadata: { count: results.length, jobId: search.jobId },
      occurredAt: now,
    });
    db.prepare(
      `UPDATE autopilot_campaigns SET last_run_at=?,next_run_at=?,lease_token=NULL,lease_until=NULL,error=NULL,updated_at=? WHERE id=? AND lease_token=?`,
    ).run(now, nextScheduleAt(campaign, now), now, id, lease);
    audit(db, {
      campaignId: id,
      offerId: campaign.offerId,
      action: "run.completed",
      detail: {
        jobId: search.jobId,
        found: results.length,
        imported: imported.created + imported.updated,
      },
      now,
    });
    return {
      job,
      imported: imported.created + imported.updated,
      skippedExisting,
      skippedUnqualified,
      contacts: imported.contactIds,
      deals,
      messages,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE autopilot_campaigns SET lease_token=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=? AND lease_token=?",
    ).run(message, now, id, lease);
    audit(db, {
      campaignId: id,
      offerId: campaign.offerId,
      action: "run.failed",
      status: "error",
      detail: { error: message },
      now,
    });
    throw err;
  }
}

function withinSendWindow(c: AutopilotCampaign, at: number): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: c.schedule.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = h * 60 + m;
  const parse = (v: string) => {
    const [hh, mm] = v.split(":").map(Number);
    return (hh || 0) * 60 + (mm || 0);
  };
  return mins >= parse(c.schedule.sendWindow.start) && mins < parse(c.schedule.sendWindow.end);
}

async function sendDueAutopilotMessages(db: HubDb, now: number): Promise<number> {
  const rows = db
    .prepare(
      `SELECT m.* FROM autopilot_messages m JOIN autopilot_campaigns c ON c.id=m.campaign_id
       WHERE m.status IN ('scheduled','approved') AND m.due_at<=? AND c.status='active' AND c.live_send_enabled=1
       ORDER BY m.due_at LIMIT 100`,
    )
    .all(now) as Row[];
  let sent = 0;
  for (const row of rows) {
    const c = getAutopilotCampaign(db, row.campaign_id as string);
    if (!c || !c.schedule.sender || !withinSendWindow(c, now)) continue;
    const todayCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM autopilot_messages WHERE campaign_id=? AND sent_at>=?")
        .get(c.id, now - 86_400_000) as { n: number }
    ).n;
    if (todayCount >= warmCap(c, now)) continue;
    try {
      const out = await sendOne(
        db,
        {
          contactId: row.contact_id as string,
          sender: c.schedule.sender,
          subject: row.subject as string,
          text: row.body as string,
          dealId: (row.deal_id as string) ?? null,
          footer: true,
          actor: "autopilot",
        },
        now,
      );
      if (!out.ok) throw new Error(out.error ?? "send failed");
      const meta = { ...parseJson<Record<string, unknown>>(row.metadata, {}), sendId: out.sendId };
      db.prepare(
        "UPDATE autopilot_messages SET status='sent',sent_at=?,metadata=?,updated_at=? WHERE id=?",
      ).run(now, JSON.stringify(meta), now, row.id);
      attribute(db, {
        offerId: row.offer_id as string,
        campaignId: c.id,
        contactId: row.contact_id as string,
        dealId: (row.deal_id as string) ?? null,
        messageId: row.id as string,
        event: "message.sent",
        occurredAt: now,
      });
      if (row.deal_id)
        updateDeal(
          db,
          row.deal_id as string,
          { nextAction: "Wait for reply", nextActionAt: now + 2 * 86_400_000 },
          "autopilot",
        );
      const nextIndex = Number(row.step_index) + 1;
      const next = Number(row.step_index) >= 0 ? c.sequence[nextIndex] : undefined;
      if (next)
        createMessage(
          db,
          c,
          row.contact_id as string,
          (row.deal_id as string) ?? null,
          nextIndex,
          now + next.delayMinutes * 60_000,
        );
      sent++;
    } catch (err) {
      db.prepare(
        "UPDATE autopilot_messages SET status='failed',metadata=?,updated_at=? WHERE id=?",
      ).run(
        JSON.stringify({
          ...parseJson<Record<string, unknown>>(row.metadata, {}),
          error: err instanceof Error ? err.message : String(err),
        }),
        now,
        row.id,
      );
    }
  }
  return sent;
}

let schedulerBusy = false;
export async function autopilotSchedulerTick(
  db: HubDb,
  deps: AutopilotRunDeps = {},
): Promise<{ campaigns: number; messages: number }> {
  if (schedulerBusy || getMeta(db, "autopilot.killSwitch") === "1")
    return { campaigns: 0, messages: 0 };
  schedulerBusy = true;
  const now = deps.now?.() ?? Date.now();
  try {
    const ids = db
      .prepare(
        "SELECT id FROM autopilot_campaigns WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 5",
      )
      .all(now) as Array<{ id: string }>;
    let campaigns = 0;
    for (const row of ids) {
      try {
        await runAutopilotCampaign(db, row.id, deps);
        campaigns++;
      } catch {
        /* run records its own audit/error */
      }
    }
    return { campaigns, messages: await sendDueAutopilotMessages(db, now) };
  } finally {
    schedulerBusy = false;
  }
}

export function getAutopilotSettings(db: HubDb): { killSwitch: boolean; approvalOnly: boolean } {
  return {
    killSwitch: getMeta(db, "autopilot.killSwitch") === "1",
    approvalOnly: autopilotApprovalOnly(),
  };
}

/**
 * When the scheduler next has work: the earliest active campaign run, or the
 * earliest approved/scheduled message still to go out on a live campaign.
 * A wake-mode cloud Machine reports this so it is started in time (a message
 * already past due is sent while the Machine is awake, not re-reported, so an
 * off-hours send window cannot wake it every minute). Null when nothing is
 * scheduled or the kill switch is on.
 */
export function autopilotNextWakeMs(db: HubDb, now = Date.now()): number | null {
  if (getMeta(db, "autopilot.killSwitch") === "1") return null;
  const run = db
    .prepare(
      "SELECT MIN(next_run_at) AS t FROM autopilot_campaigns WHERE status='active' AND next_run_at IS NOT NULL",
    )
    .get() as { t: number | null } | undefined;
  const msg = db
    .prepare(
      `SELECT MIN(m.due_at) AS t FROM autopilot_messages m JOIN autopilot_campaigns c ON c.id=m.campaign_id
       WHERE m.status IN ('scheduled','approved') AND m.due_at>? AND c.status='active' AND c.live_send_enabled=1`,
    )
    .get(now) as { t: number | null } | undefined;
  const times = [run?.t, msg?.t].filter((t): t is number => typeof t === "number");
  return times.length ? Math.min(...times) : null;
}

/** True when a scheduler tick at `now` has a campaign run or a message to send. */
export function autopilotHasDueWork(db: HubDb, now = Date.now()): boolean {
  if (getMeta(db, "autopilot.killSwitch") === "1") return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM autopilot_campaigns WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=?
         UNION ALL
         SELECT 1 FROM autopilot_messages m JOIN autopilot_campaigns c ON c.id=m.campaign_id
         WHERE m.status IN ('scheduled','approved') AND m.due_at<=? AND c.status='active' AND c.live_send_enabled=1
         LIMIT 1`,
      )
      .get(now, now),
  );
}

export function setAutopilotKillSwitch(db: HubDb, on: boolean): { killSwitch: boolean } {
  setMeta(db, "autopilot.killSwitch", on ? "1" : "0");
  if (on)
    db.prepare(
      "UPDATE autopilot_campaigns SET lease_token=NULL,lease_until=NULL,live_send_enabled=0,updated_at=?",
    ).run(Date.now());
  audit(db, {
    action: on ? "kill_switch.on" : "kill_switch.off",
    subjectType: "autopilot",
    subjectId: "global",
  });
  return getAutopilotSettings(db);
}

export function listAutopilotMessages(
  db: HubDb,
  q: { status?: string; campaignId?: string; limit?: number } = {},
): Array<Record<string, unknown>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) {
    where.push("m.status=?");
    params.push(q.status);
  }
  if (q.campaignId) {
    where.push("m.campaign_id=?");
    params.push(q.campaignId);
  }
  return db
    .prepare(
      `SELECT m.*,c.name AS contact_name,c.email,o.name AS offer_name,a.name AS campaign_name
       FROM autopilot_messages m JOIN contacts c ON c.id=m.contact_id
       JOIN offers o ON o.id=m.offer_id JOIN autopilot_campaigns a ON a.id=m.campaign_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(m.due_at,m.created_at) DESC LIMIT ?`,
    )
    .all(...params, Math.min(q.limit ?? 100, 500)) as Array<Record<string, unknown>>;
}

export function approveAutopilotMessage(
  db: HubDb,
  id: string,
  patch: { subject?: string; body?: string; sendNow?: boolean } = {},
): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM autopilot_messages WHERE id=?").get(id) as Row | undefined;
  if (!row) throw new Error("message not found");
  if (!["draft", "approved", "failed"].includes(String(row.status)))
    throw new Error(`message is ${coerceString(row.status)}`);
  const now = Date.now();
  db.prepare(
    "UPDATE autopilot_messages SET subject=?,body=?,status='approved',approved_at=?,due_at=?,updated_at=? WHERE id=?",
  ).run(
    patch.subject?.trim() || row.subject,
    patch.body?.trim() || row.body,
    now,
    patch.sendNow ? now : row.due_at,
    now,
    id,
  );
  audit(db, {
    campaignId: row.campaign_id as string,
    offerId: row.offer_id as string,
    action: "message.approved",
    subjectType: "message",
    subjectId: id,
  });
  return db.prepare("SELECT * FROM autopilot_messages WHERE id=?").get(id) as Record<
    string,
    unknown
  >;
}

export function classifyReply(
  text: string,
  autoReply = false,
): { classification: ReplyClass; confidence: number } {
  const s = text.toLowerCase();
  if (
    autoReply ||
    /out of (the )?office|automatic reply|auto.?reply|on (annual )?leave|return(?:ing)? on/.test(s)
  )
    return { classification: "ooo", confidence: 0.98 };
  if (/unsubscribe|remove me|stop emailing|do not (email|contact)|opt.?out/.test(s))
    return { classification: "unsubscribe", confidence: 0.99 };
  if (/not (right )?now|later|next (month|quarter|year)|circle back|not a priority/.test(s))
    return { classification: "not_now", confidence: 0.9 };
  if (
    /too expensive|budget|already (use|using)|not interested|don't need|do not need|concern|but /.test(
      s,
    )
  )
    return { classification: "objection", confidence: 0.82 };
  if (/interested|sounds good|yes|let'?s|book|schedule|tell me more|keen|available/.test(s))
    return { classification: "interested", confidence: 0.9 };
  if (/\?|how |what |when |where |which |can you|could you|send (me )?(more|info)/.test(s))
    return { classification: "question", confidence: 0.78 };
  return { classification: "question", confidence: 0.55 };
}

function stopCampaignContact(
  db: HubDb,
  campaign: AutopilotCampaign,
  contactId: string,
  reason: string,
  now: number,
) {
  db.prepare(
    "UPDATE autopilot_messages SET status='stopped',updated_at=? WHERE campaign_id=? AND contact_id=? AND status IN ('draft','approved','scheduled')",
  ).run(now, campaign.id, contactId);
  if (campaign.emailCampaignId) stopEnrollments(db, contactId, reason, campaign.emailCampaignId);
}

function stageNamed(db: HubDb, deal: Deal, name: string): string | null {
  const row = db
    .prepare("SELECT id FROM stages WHERE pipeline_id=? AND lower(name)=lower(?) LIMIT 1")
    .get(deal.pipelineId, name) as { id: string } | undefined;
  return row?.id ?? null;
}

function ensureBookedStage(db: HubDb, deal: Deal): string {
  const found = stageNamed(db, deal, "Booked");
  if (found) return found;
  const pipeline = ensureDefaultPipeline(db);
  const proposal = pipeline.stages.find((s) => s.name.toLowerCase() === "proposal");
  const pos = proposal?.position ?? Math.max(1, pipeline.stages.length - 2);
  db.prepare(
    "UPDATE stages SET position=position+1,updated_at=? WHERE pipeline_id=? AND position>=?",
  ).run(Date.now(), deal.pipelineId, pos);
  const id = hubId("st");
  const now = Date.now();
  db.prepare(
    `INSERT INTO stages(id,pipeline_id,name,position,kind,probability,required_fields,rot_days,color,created_at,updated_at)
     VALUES(?,?, 'Booked',?,'open',60,'[]',7,'#d9b85f',?,?)`,
  ).run(id, deal.pipelineId, pos, now, now);
  return id;
}

function draftReply(db: HubDb, offer: Offer, cls: ReplyClass, body: string): string {
  if (cls === "unsubscribe")
    return "You have been unsubscribed and will not receive further messages.";
  if (cls === "ooo") return "Thanks for the heads-up. I’ll follow up after you return.";
  if (cls === "not_now")
    return `Understood — I’ll close the loop for now. If timing changes, ${offer.cta.label.toLowerCase()}${offerCtaUrl(offer) ? `: ${offerCtaUrl(offer)}` : "."}`;
  if (cls === "objection") return handleObjection(db, offer.id, body).answer;
  if (cls === "interested")
    return `Great — the clearest next step is ${offer.cta.label.toLowerCase()}${offerCtaUrl(offer) ? `: ${offerCtaUrl(offer)}` : ". What time works best?"}`;
  return `Happy to clarify. ${offer.valueProp} ${offer.proof[0] ?? "I can send a concrete example."} ${offer.cta.label}${offerCtaUrl(offer) ? `: ${offerCtaUrl(offer)}` : ""}`;
}

export function recordAutopilotReply(
  db: HubDb,
  input: {
    contactId: string;
    body: string;
    subject?: string | null;
    inboundId?: string | null;
    messageId?: string | null;
    receivedAt?: number;
    autoReply?: boolean;
  },
): Record<string, unknown> | null {
  const latest = db
    .prepare(
      `SELECT m.* FROM autopilot_messages m JOIN autopilot_campaigns c ON c.id=m.campaign_id
       WHERE m.contact_id=? AND m.direction='outbound' ORDER BY COALESCE(m.sent_at,m.created_at) DESC LIMIT 1`,
    )
    .get(input.contactId) as Row | undefined;
  if (!latest) return null;
  const campaign = getAutopilotCampaign(db, latest.campaign_id as string);
  const offer = getOffer(db, latest.offer_id as string);
  if (!campaign || !offer) return null;
  const now = input.receivedAt ?? Date.now();
  const cls = classifyReply(input.body, input.autoReply);
  const id = hubId("apr");
  const autoAnswer = autoSends(campaign) && cls.classification !== "ooo";
  const status = cls.classification === "unsubscribe" || autoAnswer ? "handled" : "needs_approval";
  const response = draftReply(db, offer, cls.classification, input.body);
  db.prepare(
    `INSERT OR IGNORE INTO autopilot_replies(id,campaign_id,offer_id,contact_id,deal_id,message_id,inbound_id,subject,body,classification,confidence,draft_response,status,received_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    campaign.id,
    offer.id,
    input.contactId,
    (latest.deal_id as string) ?? null,
    input.messageId ?? (latest.id as string),
    input.inboundId ?? null,
    input.subject ?? null,
    input.body.slice(0, 200_000),
    cls.classification,
    cls.confidence,
    response,
    status,
    now,
    now,
  );
  db.prepare("UPDATE autopilot_messages SET replied_at=?,updated_at=? WHERE id=?").run(
    now,
    now,
    latest.id,
  );
  if (campaign.stopOnReply && cls.classification !== "ooo")
    stopCampaignContact(db, campaign, input.contactId, "replied", now);
  if (autoAnswer && cls.classification !== "unsubscribe") {
    const replyStep =
      -1 -
      Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM autopilot_messages WHERE campaign_id=? AND contact_id=? AND step_index<0",
            )
            .get(campaign.id, input.contactId) as { n: number }
        ).n,
      );
    db.prepare(
      `INSERT INTO autopilot_messages(id,campaign_id,offer_id,contact_id,deal_id,step_index,direction,status,subject,body,metadata,due_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,'outbound','scheduled',?,?,?, ?,?,?)`,
    ).run(
      hubId("apm"),
      campaign.id,
      offer.id,
      input.contactId,
      (latest.deal_id as string) ?? null,
      replyStep,
      `Re: ${input.subject ?? offer.name}`.slice(0, 300),
      response,
      JSON.stringify({
        replyToInboundId: input.inboundId ?? null,
        classification: cls.classification,
      }),
      now,
      now,
      now,
    );
  }
  if (cls.classification === "unsubscribe") {
    const contact = getContact(db, input.contactId);
    if (contact?.email) suppress(db, contact.email, "unsubscribe", "autopilot");
  }
  const deal = latest.deal_id ? getDeal(db, latest.deal_id as string) : null;
  if (deal) {
    const stage =
      cls.classification === "interested"
        ? stageNamed(db, deal, "Qualified")
        : cls.classification === "question" || cls.classification === "objection"
          ? stageNamed(db, deal, "Engaged")
          : null;
    if (stage)
      moveDeal(db, deal.id, stage, {
        force: true,
        actor: "autopilot",
        reason: `Reply: ${cls.classification}`,
      });
    updateDeal(
      db,
      deal.id,
      {
        nextAction:
          cls.classification === "interested"
            ? "Approve reply and book call"
            : cls.classification === "ooo"
              ? "Follow up after return"
              : `Review ${cls.classification.replace("_", " ")} reply`,
        nextActionAt: cls.classification === "ooo" ? now + 7 * 86_400_000 : now,
      },
      "autopilot",
    );
  }
  attribute(db, {
    offerId: offer.id,
    campaignId: campaign.id,
    contactId: input.contactId,
    dealId: deal?.id,
    messageId: latest.id as string,
    event: cls.classification === "interested" ? "reply.positive" : `reply.${cls.classification}`,
    dedupeKey: `reply:${input.inboundId ?? id}`,
    occurredAt: now,
  });
  audit(db, {
    campaignId: campaign.id,
    offerId: offer.id,
    action: "reply.classified",
    subjectType: "contact",
    subjectId: input.contactId,
    detail: cls,
    now,
  });
  return db.prepare("SELECT * FROM autopilot_replies WHERE id=?").get(id) as Record<
    string,
    unknown
  >;
}

export function listAutopilotInbox(
  db: HubDb,
  q: { status?: string; limit?: number } = {},
): Array<Record<string, unknown>> {
  const params: unknown[] = [];
  const where = q.status ? "WHERE r.status=?" : "";
  if (q.status) params.push(q.status);
  return db
    .prepare(
      `SELECT r.*,c.name AS contact_name,c.email,o.name AS offer_name,a.name AS campaign_name
       FROM autopilot_replies r JOIN contacts c ON c.id=r.contact_id
       JOIN offers o ON o.id=r.offer_id JOIN autopilot_campaigns a ON a.id=r.campaign_id
       ${where} ORDER BY r.received_at DESC LIMIT ?`,
    )
    .all(...params, Math.min(q.limit ?? 100, 500)) as Array<Record<string, unknown>>;
}

export function updateAutopilotReply(
  db: HubDb,
  id: string,
  patch: {
    status?: "needs_approval" | "approved" | "handled" | "dismissed";
    draftResponse?: string;
  },
): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM autopilot_replies WHERE id=?").get(id) as Row | undefined;
  if (!row) throw new Error("reply not found");
  db.prepare("UPDATE autopilot_replies SET status=?,draft_response=?,updated_at=? WHERE id=?").run(
    patch.status ?? row.status,
    patch.draftResponse !== undefined ? patch.draftResponse : row.draft_response,
    Date.now(),
    id,
  );
  return db.prepare("SELECT * FROM autopilot_replies WHERE id=?").get(id) as Record<
    string,
    unknown
  >;
}

function zonedParts(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    weekday,
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function hm(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return Math.max(0, Math.min(24 * 60, (h || 0) * 60 + (m || 0)));
}

export function bookingAvailability(
  db: HubDb,
  offerIdOrSlug: string,
  opts: { from?: number; days?: number; timezone?: string; now?: number } = {},
): Array<{ startsAt: number; endsAt: number; label: string }> {
  const offer = getOffer(db, offerIdOrSlug);
  if (!offer || !offer.booking.enabled) return [];
  const tz = opts.timezone || offer.booking.timezone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz }).format();
  } catch {
    throw new Error(`invalid timezone: ${tz}`);
  }
  const now = opts.now ?? Date.now();
  const from = Math.max(opts.from ?? now, now + offer.booking.minNoticeMinutes * 60_000);
  const until =
    from + Math.min(opts.days ?? offer.booking.horizonDays, offer.booking.horizonDays) * 86_400_000;
  const duration = offer.booking.durationMinutes * 60_000;
  const busy = db
    .prepare(
      "SELECT starts_at,ends_at FROM bookings WHERE offer_id=? AND status='booked' AND ends_at>=? AND starts_at<=?",
    )
    .all(offer.id, from, until) as Array<{ starts_at: number; ends_at: number }>;
  const out: Array<{ startsAt: number; endsAt: number; label: string }> = [];
  const step = 15 * 60_000;
  const start = Math.ceil(from / step) * step;
  for (let at = start; at + duration <= until && out.length < 160; at += step) {
    const p = zonedParts(at, tz);
    const rule = offer.booking.rules.find((r) => r.days.includes(p.weekday));
    if (
      !rule ||
      p.minutes < hm(rule.start) ||
      p.minutes + offer.booking.durationMinutes > hm(rule.end)
    )
      continue;
    const blocked = busy.some(
      (b) =>
        at < b.ends_at + offer.booking.bufferAfterMinutes * 60_000 &&
        at + duration > b.starts_at - offer.booking.bufferBeforeMinutes * 60_000,
    );
    if (blocked) continue;
    out.push({
      startsAt: at,
      endsAt: at + duration,
      label: new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(at)),
    });
  }
  return out;
}

function icsEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/[,;]/g, (m) => `\\${m}`);
}

function icsDate(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function bookingIcs(offer: Offer, booking: Booking): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//InfiniBot//Lead Autopilot//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${booking.publicToken}@infinibot`,
    `DTSTAMP:${icsDate(booking.createdAt)}`,
    `DTSTART:${icsDate(booking.startsAt)}`,
    `DTEND:${icsDate(booking.endsAt)}`,
    `SUMMARY:${icsEscape(offer.name)} consultation`,
    `DESCRIPTION:${icsEscape(`${offer.valueProp}\n${booking.notes ?? ""}`)}`,
    offer.booking.location ? `LOCATION:${icsEscape(offer.booking.location)}` : "",
    `ATTENDEE;CN=${icsEscape(booking.name)}:mailto:${booking.email}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ]
    .filter(Boolean)
    .join("\r\n");
}

export async function bookAppointment(
  db: HubDb,
  input: {
    offerId: string;
    campaignId?: string | null;
    name: string;
    email: string;
    startsAt: number;
    timezone?: string;
    notes?: string | null;
  },
  deps: { syncGoogle?: boolean } = {},
): Promise<Booking> {
  const offer = getOffer(db, input.offerId);
  if (!offer) throw new Error("offer not found");
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("valid email required");
  const name = str(input.name);
  if (!name) throw new Error("name required");
  const tz = input.timezone || offer.booking.timezone;
  const slot = bookingAvailability(db, offer.id, {
    from: input.startsAt,
    days: 2,
    timezone: tz,
  }).find((s) => s.startsAt === input.startsAt);
  if (!slot) throw new Error("that time is no longer available");
  const contact =
    getContactByEmail(db, email) ??
    upsertContact(db, {
      name,
      email,
      lifecycle: "qualified",
      emailStatus: "valid",
      custom: {
        offerId: offer.id,
        autopilotCampaignId: input.campaignId ?? null,
        source: "booking",
      },
    })?.contact ??
    null;
  const campaignId = input.campaignId ?? null;
  const campaign = campaignId ? getAutopilotCampaign(db, campaignId) : null;
  let deal = contact
    ? ((db
        .prepare(
          `SELECT id FROM deals WHERE contact_id=? AND status='open' AND json_extract(custom,'$.offerId')=? ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(contact.id, offer.id) as { id: string } | undefined) ?? null)
    : null;
  if (contact && !deal) {
    const pipeline = ensureDefaultPipeline(db);
    const created = createDeal(db, {
      title: `${contact.name} — ${offer.name}`,
      contactId: contact.id,
      companyId: contact.companyId,
      pipelineId: pipeline.id,
      stageId: pipeline.stages.find((s) => s.name.toLowerCase() === "new")?.id,
      valueCents: offer.priceCents,
      currency: offer.currency,
      custom: { offerId: offer.id, autopilotCampaignId: campaignId, attribution: "booking" },
    });
    deal = { id: created.id };
  }
  const now = Date.now();
  const id = hubId("bkg");
  const token = hubId("ics");
  db.prepare(
    `INSERT INTO bookings(id,offer_id,campaign_id,contact_id,deal_id,name,email,starts_at,ends_at,timezone,status,notes,public_token,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,'booked',?,?,?,?)`,
  ).run(
    id,
    offer.id,
    campaignId,
    contact?.id ?? null,
    deal?.id ?? null,
    name,
    email,
    slot.startsAt,
    slot.endsAt,
    tz,
    str(input.notes),
    token,
    now,
    now,
  );
  let booking = rowToBooking(db.prepare("SELECT * FROM bookings WHERE id=?").get(id) as Row);
  if (contact) {
    if (campaign?.stopOnBook) stopCampaignContact(db, campaign, contact.id, "booked", now);
    if (deal) {
      const current = getDeal(db, deal.id)!;
      moveDeal(db, current.id, ensureBookedStage(db, current), {
        force: true,
        actor: "autopilot",
        reason: "Appointment booked",
      });
      updateDeal(
        db,
        current.id,
        { nextAction: `Prepare for ${offer.name} call`, nextActionAt: slot.startsAt - 60 * 60_000 },
        "autopilot",
      );
    }
    logActivity(db, {
      subjectType: "contact",
      subjectId: contact.id,
      type: "meeting.booked",
      summary: `${offer.name} booked for ${new Date(slot.startsAt).toISOString()}`,
      actor: "booking",
      data: { bookingId: id, offerId: offer.id, campaignId },
      occurredAt: now,
    });
  }
  attribute(db, {
    offerId: offer.id,
    campaignId,
    contactId: contact?.id,
    dealId: deal?.id,
    bookingId: id,
    event: "booking.created",
    occurredAt: now,
  });
  audit(db, {
    campaignId,
    offerId: offer.id,
    action: "booking.created",
    subjectType: "booking",
    subjectId: id,
    now,
  });

  if ((deps.syncGoogle || offer.booking.syncGoogle) && contact) {
    try {
      const { handleCalendarTool } = await import("../agents/tools/calendar-tool.js");
      const raw = await handleCalendarTool({
        action: "create_event",
        calendarId: "primary",
        maxResults: 50,
        summary: `${offer.name} — ${name}`,
        description: `${offer.valueProp}\nLead Autopilot booking ${id}`,
        location: offer.booking.location ?? undefined,
        start: new Date(slot.startsAt).toISOString(),
        end: new Date(slot.endsAt).toISOString(),
        timeZone: tz,
        attendees: [email],
        reminders: [60, 10],
      });
      const parsed = JSON.parse(raw) as {
        success?: boolean;
        event?: { id?: string; link?: string };
      };
      if (parsed.success && parsed.event?.id) {
        db.prepare(
          "UPDATE bookings SET calendar_event_id=?,calendar_link=?,updated_at=? WHERE id=?",
        ).run(parsed.event.id, parsed.event.link ?? null, Date.now(), id);
        booking = rowToBooking(db.prepare("SELECT * FROM bookings WHERE id=?").get(id) as Row);
      }
    } catch {
      /* Google sync is optional; the local booking remains authoritative. */
    }
  }
  const confirmationSender = offer.booking.sender ?? campaign?.schedule.sender;
  if (offer.booking.sendConfirmation !== false && contact && confirmationSender) {
    try {
      const base = resolveBaseUrl(db);
      const inviteUrl = base
        ? `${base}${HUB_HTTP_BASE}/book/ics?token=${encodeURIComponent(token)}`
        : null;
      await sendOne(
        db,
        {
          contactId: contact.id,
          sender: confirmationSender,
          subject: `Confirmed: ${offer.name} with ${name}`,
          text: [
            `Your ${offer.name} appointment is confirmed for ${new Date(slot.startsAt).toLocaleString("en", { timeZone: tz, dateStyle: "full", timeStyle: "short" })} (${tz}).`,
            offer.booking.location ? `Location: ${offer.booking.location}` : "",
            inviteUrl
              ? `Calendar invite: ${inviteUrl}`
              : "Your calendar invite is available from the booking confirmation page.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          dealId: deal?.id ?? null,
          footer: false,
          actor: "booking",
        },
        now,
      );
      audit(db, {
        campaignId,
        offerId: offer.id,
        action: "booking.invite_sent",
        subjectType: "booking",
        subjectId: id,
        now,
      });
    } catch (err) {
      audit(db, {
        campaignId,
        offerId: offer.id,
        action: "booking.invite_failed",
        subjectType: "booking",
        subjectId: id,
        status: "error",
        detail: { error: err instanceof Error ? err.message : String(err) },
        now,
      });
    }
  }
  return booking;
}

export function listBookings(
  db: HubDb,
  q: { offerId?: string; from?: number; to?: number; limit?: number } = {},
): Booking[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.offerId) {
    where.push("offer_id=?");
    params.push(q.offerId);
  }
  if (q.from) {
    where.push("starts_at>=?");
    params.push(q.from);
  }
  if (q.to) {
    where.push("starts_at<?");
    params.push(q.to);
  }
  return (
    db
      .prepare(
        `SELECT * FROM bookings ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY starts_at LIMIT ?`,
      )
      .all(...params, Math.min(q.limit ?? 300, 1000)) as Row[]
  ).map(rowToBooking);
}

export function getBookingByToken(
  db: HubDb,
  token: string,
): { booking: Booking; offer: Offer } | null {
  const row = db.prepare("SELECT * FROM bookings WHERE public_token=?").get(token) as
    | Row
    | undefined;
  if (!row) return null;
  const booking = rowToBooking(row);
  const offer = getOffer(db, booking.offerId);
  return offer ? { booking, offer } : null;
}

function refreshRevenueAttribution(db: HubDb): void {
  const rows = db
    .prepare(
      `SELECT t.id,t.net_cents,t.occurred_at,t.deal_id,d.contact_id,d.custom
       FROM revenue_txns t JOIN deals d ON d.id=t.deal_id
       WHERE t.status IN ('paid','succeeded','completed') AND t.type='charge'`,
    )
    .all() as Array<{
    id: string;
    net_cents: number;
    occurred_at: number;
    deal_id: string;
    contact_id: string | null;
    custom: string;
  }>;
  for (const row of rows) {
    const custom = parseJson<Record<string, unknown>>(row.custom, {});
    const offerId = typeof custom.offerId === "string" ? custom.offerId : null;
    if (!offerId) continue;
    attribute(db, {
      offerId,
      campaignId:
        typeof custom.autopilotCampaignId === "string" ? custom.autopilotCampaignId : null,
      contactId: row.contact_id,
      dealId: row.deal_id,
      revenueTxnId: row.id,
      event: "revenue.paid",
      valueCents: row.net_cents,
      dedupeKey: `revenue:${row.id}:${offerId}`,
      occurredAt: row.occurred_at,
    });
  }
}

export function autopilotKpis(
  db: HubDb,
  q: { offerId?: string; campaignId?: string; from?: number; to?: number } = {},
): Record<string, number> {
  refreshRevenueAttribution(db);
  const where = ["1=1"];
  const params: unknown[] = [];
  if (q.offerId) {
    where.push("offer_id=?");
    params.push(q.offerId);
  }
  if (q.campaignId) {
    where.push("campaign_id=?");
    params.push(q.campaignId);
  }
  if (q.from) {
    where.push("occurred_at>=?");
    params.push(q.from);
  }
  if (q.to) {
    where.push("occurred_at<?");
    params.push(q.to);
  }
  const rows = db
    .prepare(
      `SELECT event,COUNT(*) AS n,SUM(value_cents) AS value,SUM(cost_cents) AS cost
       FROM autopilot_attribution WHERE ${where.join(" AND ")} GROUP BY event`,
    )
    .all(...params) as Array<{ event: string; n: number; value: number; cost: number }>;
  const by = new Map(rows.map((r) => [r.event, r]));
  const scraped = [...by.entries()]
    .filter(([k]) => k === "lead.scraped")
    .reduce((a, [, r]) => a + Number(r.value), 0);
  const verified = Number(by.get("lead.verified")?.n ?? 0);
  const contacted = Number(by.get("message.sent")?.n ?? 0);
  const replies = [...by.entries()]
    .filter(([k]) => k.startsWith("reply."))
    .reduce((a, [, r]) => a + Number(r.n), 0);
  const positive = Number(by.get("reply.positive")?.n ?? 0);
  const booked = Number(by.get("booking.created")?.n ?? 0);
  const revenue = Number(by.get("revenue.paid")?.value ?? 0);
  const cost = rows.reduce((a, r) => a + Number(r.cost || 0), 0);
  const scope = q.campaignId
    ? "json_extract(custom,'$.autopilotCampaignId')=?"
    : q.offerId
      ? "json_extract(custom,'$.offerId')=?"
      : "json_extract(custom,'$.offerId') IS NOT NULL";
  const scopeParam = q.campaignId ?? q.offerId;
  const won = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM deals WHERE status='won' AND ${scope}`)
      .get(...(scopeParam ? [scopeParam] : [])) as { n: number }
  ).n;
  const opens = q.campaignId
    ? (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM email_sends s WHERE s.opened_at IS NOT NULL AND s.contact_id IN
             (SELECT DISTINCT contact_id FROM autopilot_messages WHERE campaign_id=?)`,
          )
          .get(q.campaignId) as { n: number }
      ).n
    : 0;
  return {
    scraped,
    verified,
    contacted,
    opens,
    replies,
    positive,
    booked,
    won,
    revenueCents: revenue,
    costCents: cost,
    openRateBps: contacted ? Math.round((opens / contacted) * 10_000) : 0,
    replyRateBps: contacted ? Math.round((replies / contacted) * 10_000) : 0,
    positiveRateBps: replies ? Math.round((positive / replies) * 10_000) : 0,
    bookingRateBps: contacted ? Math.round((booked / contacted) * 10_000) : 0,
  };
}

export function autopilotTimeline(
  db: HubDb,
  campaignId: string,
  limit = 100,
): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM autopilot_audit WHERE campaign_id=? ORDER BY occurred_at DESC LIMIT ?")
    .all(campaignId, Math.min(limit, 500)) as Array<Record<string, unknown>>;
}

export function bookingPageUrl(baseUrl: string, offer: Offer): string {
  return `${baseUrl.replace(/\/$/, "")}/plugins/business-agency/book?offer=${encodeURIComponent(offer.booking.slug)}`;
}

export function stableRunKey(campaignId: string, slot: number): string {
  return createHash("sha256").update(`${campaignId}:${slot}`).digest("hex").slice(0, 24);
}
