/**
 * Lead generation — cross-provider dedupe (registrable domain → phone →
 * name+city) and the 0-100 lead score with human-readable reasons.
 */

import { companyNameKey, isFreeMailDomain, normalizePhone, registrableDomain } from "../util.js";
import type { LeadData } from "./types.js";

export function leadKeys(lead: LeadData, country = "US"): string[] {
  const keys: string[] = [];
  const domain = lead.domain ?? registrableDomain(lead.website);
  if (domain && !isFreeMailDomain(domain)) keys.push(`d:${domain}`);
  const phone = lead.phoneE164 ?? normalizePhone(lead.phone, country);
  if (phone) keys.push(`p:${phone}`);
  const name = companyNameKey(lead.name);
  if (name) keys.push(`n:${name}|${(lead.city ?? "").toLowerCase().trim()}`);
  return keys;
}

/** Strongest key: domain, else phone, else name+city. */
export function dedupeKey(lead: LeadData, country = "US"): string {
  return leadKeys(lead, country)[0] ?? `x:${lead.name.toLowerCase()}`;
}

function fill<K extends keyof LeadData>(into: LeadData, from: LeadData, k: K): void {
  const cur = into[k];
  if (
    (cur === undefined || cur === null || cur === "") &&
    from[k] !== undefined &&
    from[k] !== null
  )
    into[k] = from[k];
}

/** Merge `b` into `a` (a wins on conflicts; lists are unioned). */
export function mergeLeads(a: LeadData, b: LeadData): LeadData {
  for (const k of [
    "website",
    "domain",
    "phone",
    "phoneE164",
    "address",
    "street",
    "city",
    "region",
    "postcode",
    "country",
    "lat",
    "lon",
    "category",
    "openingHours",
    "rating",
    "reviewCount",
    "description",
    "industry",
    "employees",
    "founded",
  ] as const)
    fill(a, b, k);
  a.categoryMatched = !!(a.categoryMatched || b.categoryMatched);
  for (const e of b.emails) if (!a.emails.some((x) => x.email === e.email)) a.emails.push(e);
  for (const p of b.phones ?? []) {
    a.phones = a.phones ?? [];
    if (!a.phones.includes(p)) a.phones.push(p);
  }
  for (const [n, u] of Object.entries(b.social)) if (!a.social[n]) a.social[n] = u;
  for (const p of b.people)
    if (!a.people.some((x) => x.name.toLowerCase() === p.name.toLowerCase())) a.people.push(p);
  for (const p of b.providers) if (!a.providers.includes(p)) a.providers.push(p);
  for (const s of b.attribution) if (!a.attribution.includes(s)) a.attribution.push(s);
  a.refs = { ...b.refs, ...a.refs };
  return a;
}

/** Union leads that share any key (domain, phone or name+city). Order is kept. */
export function dedupeLeads(
  leads: LeadData[],
  country = "US",
): Array<{ key: string; lead: LeadData }> {
  const groups: LeadData[] = [];
  const index = new Map<string, number>();
  for (const lead of leads) {
    const keys = leadKeys(lead, country);
    const hit = keys.map((k) => index.get(k)).find((i) => i !== undefined);
    let gi: number;
    if (hit === undefined) {
      gi = groups.length;
      groups.push(lead);
    } else {
      gi = hit;
      mergeLeads(groups[gi], lead);
    }
    for (const k of leadKeys(groups[gi], country)) if (!index.has(k)) index.set(k, gi);
  }
  return groups.map((lead) => ({ key: dedupeKey(lead, country), lead }));
}

/**
 * Score 0-100:
 * website 15 · verified email 25 (risky 10, unverified 5) · phone 15 ·
 * named personal contact 15 · rating/reviews up to 10 · social up to 10 ·
 * category match 10.
 */
export function scoreLead(lead: LeadData): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const add = (n: number, why: string) => {
    if (n <= 0) return;
    score += n;
    reasons.push(`+${n} ${why}`);
  };
  if (lead.website) add(15, "has website");
  const best = lead.emails.find((e) => e.email === lead.email) ?? lead.emails[0];
  if (best) {
    if (best.status === "valid") add(25, "verified email");
    else if (best.status === "risky") add(10, "email (unconfirmed)");
    else if (best.status !== "invalid") add(5, "email (unverified)");
  }
  if (lead.phone || lead.phoneE164) add(15, "has phone");
  const named = lead.people.find((p) => p.name) ?? null;
  const personalEmail = lead.emails.find((e) => e.personName && e.status !== "invalid");
  if (named && (personalEmail || named.email)) add(15, `named contact with email (${named.name})`);
  else if (named) add(8, `named contact (${named.name})`);
  let social = 0;
  if (lead.rating != null && lead.rating >= 4) social += 5;
  else if (lead.rating != null && lead.rating >= 3) social += 2;
  if ((lead.reviewCount ?? 0) >= 50) social += 5;
  else if ((lead.reviewCount ?? 0) >= 10) social += 3;
  add(social, `rating ${lead.rating ?? "?"} / ${lead.reviewCount ?? 0} reviews`);
  const nets = Object.keys(lead.social).length;
  add(Math.min(10, nets * 3), `${nets} social profile${nets === 1 ? "" : "s"}`);
  if (lead.categoryMatched) add(10, `category match (${lead.category ?? "?"})`);
  return { score: Math.max(0, Math.min(100, score)), reasons };
}
