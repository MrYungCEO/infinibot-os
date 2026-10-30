/**
 * Lead generation — BYOK paid API slots, OFF unless a key is stored in config
 * (encrypted) or present in the env vars the old services/lead-generation
 * scrapers used: Hunter (domain search + verifier), SerpAPI Google Maps,
 * Google Places API (New) text search and Apollo company search.
 */

import { normalizePhone, normalizeWebsite, registrableDomain, str } from "../util.js";
import { isRoleAddress } from "./email.js";
import { num, txt, verdict, type Json } from "./external.js";
import { jsonRequest } from "./http.js";
import {
  emptyLead,
  type EmailVerdict,
  type EmailVerdictStatus,
  type LeadData,
  type ProviderCtx,
  type SearchInput,
} from "./types.js";

// ── Hunter (BYOK) ───────────────────────────────────────────────────────────

export async function hunterEnrich(lead: LeadData, ctx: ProviderCtx): Promise<void> {
  const domain = lead.domain ?? registrableDomain(lead.website);
  if (!domain || !ctx.apiKey) return;
  const u = new URL("https://api.hunter.io/v2/domain-search");
  u.searchParams.set("domain", domain);
  u.searchParams.set("limit", "10");
  u.searchParams.set("api_key", ctx.apiKey);
  const res = await jsonRequest<{ data?: Json }>(ctx.fetch, u.toString(), { timeoutMs: 20_000 });
  if (res.status !== 200 || !res.data?.data) throw new Error(`hunter HTTP ${res.status}`);
  const d = res.data.data;
  for (const e of (d.emails as Json[] | undefined) ?? []) {
    const email = str(e.value)?.toLowerCase();
    if (!email || lead.emails.some((x) => x.email === email)) continue;
    const name = [str(e.first_name), str(e.last_name)].filter(Boolean).join(" ") || undefined;
    const ver = str((e.verification as Json | undefined)?.status);
    lead.emails.push({
      email,
      source: "hunter",
      role: e.type === "generic" || isRoleAddress(email),
      onDomain: registrableDomain(email) === domain,
      personName: name,
      status: ver === "valid" ? "valid" : ver === "invalid" ? "invalid" : undefined,
      reasons: ver ? [`hunter: ${ver}`] : undefined,
    });
    if (name && !lead.people.some((p) => p.name === name))
      lead.people.push({ name, title: str(e.position), email });
  }
  lead.industry = lead.industry ?? str(d.industry);
  for (const net of ["linkedin", "facebook", "instagram", "twitter", "youtube"] as const) {
    const v = str(d[net]);
    const key = net === "twitter" ? "x" : net;
    if (v && !lead.social[key]) lead.social[key] = v;
  }
  if (!lead.providers.includes("hunter")) lead.providers.push("hunter");
}

export async function hunterVerify(email: string, ctx: ProviderCtx): Promise<EmailVerdict | null> {
  if (!ctx.apiKey) return null;
  const u = new URL("https://api.hunter.io/v2/email-verifier");
  u.searchParams.set("email", email);
  u.searchParams.set("api_key", ctx.apiKey);
  const res = await jsonRequest<{ data?: Json }>(ctx.fetch, u.toString(), { timeoutMs: 30_000 });
  if (res.status !== 200 || !res.data?.data) throw new Error(`hunter HTTP ${res.status}`);
  const d = res.data.data;
  const s = txt(d.status, "unknown");
  const status: EmailVerdictStatus =
    s === "valid"
      ? "valid"
      : s === "invalid" || s === "disposable"
        ? "invalid"
        : s === "unknown"
          ? "unknown"
          : "risky";
  return verdict(
    email,
    status,
    [`hunter: ${s}`],
    {
      disposable: d.disposable === true,
      freeMail: d.webmail === true,
      mx: typeof d.mx_records === "boolean" ? d.mx_records : null,
    },
    "hunter",
  );
}

// ── SerpAPI Google Maps (BYOK; logic carried over from services/lead-generation) ──

export async function serpapiSearch(
  input: SearchInput,
  ctx: ProviderCtx,
): Promise<{ leads: LeadData[]; attribution: string }> {
  if (!ctx.apiKey) throw new Error("SerpAPI key missing");
  const u = new URL("https://serpapi.com/search");
  u.searchParams.set("engine", "google_maps");
  u.searchParams.set("q", [input.query, input.location].filter(Boolean).join(" in "));
  u.searchParams.set("type", "search");
  u.searchParams.set("api_key", ctx.apiKey);
  const res = await jsonRequest<{ local_results?: Json[]; error?: string }>(
    ctx.fetch,
    u.toString(),
    { timeoutMs: 30_000 },
  );
  if (res.status !== 200 || !res.data) throw new Error(`SerpAPI HTTP ${res.status}`);
  if (res.data.error) throw new Error(`SerpAPI: ${res.data.error}`);
  const leads = (res.data.local_results ?? []).slice(0, input.limit).map((r) => {
    const lead = emptyLead(txt(r.title, "Unknown"), "serpapi");
    const website = normalizeWebsite(r.website);
    if (website) {
      lead.website = website;
      lead.domain = registrableDomain(website);
    }
    lead.phone = str(r.phone);
    lead.phoneE164 = normalizePhone(r.phone, ctx.country);
    lead.address = str(r.address);
    lead.rating = num(r.rating);
    lead.reviewCount = num(r.reviews);
    lead.category = str(r.type);
    lead.categoryMatched = !!lead.category;
    const gps = r.gps_coordinates as Json | undefined;
    lead.lat = num(gps?.latitude);
    lead.lon = num(gps?.longitude);
    if (r.place_id) lead.refs.serpapi = txt(r.place_id);
    return lead;
  });
  return { leads, attribution: "Google Maps via SerpAPI" };
}

// ── Google Places API (New) Text Search (BYOK) ──────────────────────────────

export async function googlePlacesSearch(
  input: SearchInput,
  ctx: ProviderCtx,
): Promise<{ leads: LeadData[]; attribution: string }> {
  if (!ctx.apiKey) throw new Error("Google Places key missing");
  const res = await jsonRequest<{ places?: Json[]; error?: { message?: string } }>(
    ctx.fetch,
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": ctx.apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.location,places.primaryType",
      },
      body: JSON.stringify({
        textQuery: [input.query, input.location].filter(Boolean).join(" in "),
        pageSize: Math.min(20, input.limit),
      }),
      timeoutMs: 30_000,
    },
  );
  if (res.status !== 200 || !res.data)
    throw new Error(`Google Places HTTP ${res.status}: ${res.data?.error?.message ?? ""}`);
  const leads = (res.data.places ?? []).map((p) => {
    const lead = emptyLead(
      txt((p.displayName as Json | undefined)?.text, "Unknown"),
      "google-places",
    );
    const website = normalizeWebsite(p.websiteUri);
    if (website) {
      lead.website = website;
      lead.domain = registrableDomain(website);
    }
    lead.phone = str(p.nationalPhoneNumber ?? p.internationalPhoneNumber);
    lead.phoneE164 = normalizePhone(
      p.internationalPhoneNumber ?? p.nationalPhoneNumber,
      ctx.country,
    );
    lead.address = str(p.formattedAddress);
    lead.rating = num(p.rating);
    lead.reviewCount = num(p.userRatingCount);
    lead.category = str(p.primaryType);
    lead.categoryMatched = !!lead.category;
    const loc = p.location as Json | undefined;
    lead.lat = num(loc?.latitude);
    lead.lon = num(loc?.longitude);
    if (p.id) lead.refs["google-places"] = txt(p.id);
    return lead;
  });
  return { leads, attribution: "Google Places API" };
}

// ── Apollo (BYOK) ───────────────────────────────────────────────────────────

export async function apolloSearch(
  input: SearchInput,
  ctx: ProviderCtx,
): Promise<{ leads: LeadData[]; attribution: string }> {
  if (!ctx.apiKey) throw new Error("Apollo key missing");
  const body: Json = {
    q_organization_name: input.query,
    per_page: Math.min(input.limit, 100),
    page: 1,
  };
  if (input.location) body.organization_locations = [input.location];
  const res = await jsonRequest<{ organizations?: Json[]; accounts?: Json[] }>(
    ctx.fetch,
    "https://api.apollo.io/api/v1/mixed_companies/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": ctx.apiKey,
      },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    },
  );
  if (res.status !== 200 || !res.data) throw new Error(`Apollo HTTP ${res.status}`);
  const orgs = [...(res.data.organizations ?? []), ...(res.data.accounts ?? [])];
  const leads = orgs.slice(0, input.limit).map((o) => {
    const lead = emptyLead(txt(o.name, "Unknown"), "apollo");
    const website = normalizeWebsite(o.website_url ?? o.primary_domain);
    if (website) {
      lead.website = website;
      lead.domain = registrableDomain(website);
    }
    const phone = str((o.primary_phone as Json | undefined)?.number ?? o.phone);
    lead.phone = phone;
    lead.phoneE164 = normalizePhone(phone, ctx.country);
    lead.city = str(o.city);
    lead.region = str(o.state);
    lead.country = str(o.country);
    lead.industry = str(o.industry);
    lead.employees = num(o.estimated_num_employees);
    lead.founded = o.founded_year ? txt(o.founded_year) : null;
    if (o.linkedin_url) lead.social.linkedin = txt(o.linkedin_url);
    if (o.facebook_url) lead.social.facebook = txt(o.facebook_url);
    if (o.twitter_url) lead.social.x = txt(o.twitter_url);
    if (o.id) lead.refs.apollo = txt(o.id);
    return lead;
  });
  return { leads, attribution: "Apollo.io" };
}
