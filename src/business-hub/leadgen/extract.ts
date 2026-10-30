/**
 * Lead generation — pure HTML extraction for the website provider: emails
 * (mailto, text, "[at]/[dot]" and Cloudflare obfuscation, asset names like
 * logo@2x.png rejected), phones, social profiles, JSON-LD
 * Organization/LocalBusiness/Person, OpenGraph and best-effort team members.
 */

import { parseHTML } from "linkedom";
import { normalizeEmail, normalizePhone, str } from "../util.js";
import type { LeadPerson } from "./types.js";

export type JsonLdOrg = {
  type: string;
  name?: string;
  telephone?: string;
  email?: string;
  street?: string;
  city?: string;
  region?: string;
  postcode?: string;
  country?: string;
  sameAs: string[];
  rating?: number;
  reviewCount?: number;
  description?: string;
};

export type PageExtract = {
  url: string;
  emails: string[];
  phones: string[];
  social: Record<string, string>;
  orgs: JsonLdOrg[];
  people: LeadPerson[];
  siteName?: string;
  description?: string;
  title?: string;
  links: string[];
};

const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "domain.com",
  "yourdomain.com",
  "email.com",
  "sentry.io",
  "wixpress.com",
  "sentry-next.wixpress.com",
  "sentry.wixpress.com",
  "godaddy.com",
  "squarespace.com",
]);
const PLACEHOLDER_LOCALS = new Set([
  "you",
  "your",
  "name",
  "yourname",
  "user",
  "username",
  "email",
  "test",
]);

function cleanEmail(raw: string): string | null {
  const e = normalizeEmail(raw.replace(/\?.*$/, ""));
  if (!e) return null;
  const [local, domain] = e.split("@");
  if (PLACEHOLDER_EMAIL_DOMAINS.has(domain) || PLACEHOLDER_LOCALS.has(local)) return null;
  // Hashes / tracking ids ("a3f9…@sentry…") are never contact addresses.
  if (/^[a-f0-9]{16,}$/.test(local)) return null;
  return e;
}

/** Cloudflare "email protection" (data-cfemail) decoder. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
  const key = Number.parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2)
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

const EMAIL_TEXT_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const OBFUSCATED_RE =
  /([a-z0-9][a-z0-9._%+-]{0,63})\s*[[({<]\s*at\s*[\])}>]\s*([a-z0-9-]+(?:\s*(?:[[({<]\s*dot\s*[\])}>]|\.)\s*[a-z0-9-]+)+)/gi;
const DOT_RE = /\s*(?:[[({<]\s*dot\s*[\])}>]|\.)\s*/gi;

/** Emails from visible text, including "name [at] domain [dot] com". */
export function emailsFromText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(EMAIL_TEXT_RE)) {
    const e = cleanEmail(m[0]);
    if (e) out.add(e);
  }
  for (const m of text.matchAll(OBFUSCATED_RE)) {
    const e = cleanEmail(`${m[1]}@${m[2].replace(DOT_RE, ".")}`);
    if (e) out.add(e);
  }
  return [...out];
}

const PHONE_TEXT_RE =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)[\s.-]?|\d{2,5}[\s.-])\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?/g;

/** Phone numbers from text: only well-separated groups with 10-15 digits. */
export function phonesFromText(text: string, country = "US"): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PHONE_TEXT_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    const p = normalizePhone(m[0], country);
    if (p) out.add(p);
  }
  return [...out];
}

const SOCIAL_HOSTS: Array<[string, RegExp]> = [
  ["linkedin", /(^|\.)linkedin\.com$/],
  ["facebook", /(^|\.)(facebook|fb)\.com$/],
  ["instagram", /(^|\.)instagram\.com$/],
  ["x", /(^|\.)(twitter|x)\.com$/],
  ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/],
  ["tiktok", /(^|\.)tiktok\.com$/],
];

/** Classify a profile URL ("https://www.facebook.com/acme" → "facebook"); share links are ignored. */
export function socialNetwork(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const path = u.pathname.toLowerCase();
  if (path === "/" || path === "") return null;
  if (
    /\/(sharer|share|intent|dialog|plugins|hashtag|home\.php|login|signup)(\/|\.php|$)/.test(path)
  )
    return null;
  if (/^\/(watch|embed|results)/.test(path) && /youtube/.test(u.hostname)) return null;
  for (const [net, re] of SOCIAL_HOSTS) if (re.test(u.hostname.toLowerCase())) return net;
  return null;
}

function asArray<T>(v: T | T[] | null | undefined): T[] {
  return v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];
}

type Json = Record<string, unknown>;

function jsonStr(v: unknown): string | undefined {
  if (typeof v === "string") return str(v) ?? undefined;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "name" in v) return jsonStr((v as Json).name);
  return undefined;
}

const NON_ORG_TYPES = new Set([
  "website",
  "webpage",
  "breadcrumblist",
  "imageobject",
  "searchaction",
  "sitenavigationelement",
  "listitem",
  "article",
  "blogposting",
  "faqpage",
  "question",
  "answer",
  "offer",
  "product",
  "review",
  "event",
  "videoobject",
  "person",
  "postaladdress",
  "geocoordinates",
  "openinghoursspecification",
  "aggregaterating",
]);

function flattenLd(v: unknown, out: Json[], depth = 0): void {
  if (depth > 6 || !v || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) flattenLd(x, out, depth + 1);
    return;
  }
  const o = v as Json;
  out.push(o);
  if (o["@graph"]) flattenLd(o["@graph"], out, depth + 1);
  for (const k of ["employee", "founder", "member", "employees", "author"])
    if (o[k]) flattenLd(o[k], out, depth + 1);
}

function parseLdOrg(o: Json): JsonLdOrg | null {
  const types = asArray(o["@type"] as string | string[]).map((t) => String(t).toLowerCase());
  if (!types.length || types.every((t) => NON_ORG_TYPES.has(t))) return null;
  const addr = asArray(o.address as Json | Json[])[0];
  const a = addr && typeof addr === "object" ? addr : null;
  const rating = o.aggregateRating as Json | undefined;
  const org: JsonLdOrg = {
    type: types[0],
    name: jsonStr(o.name) ?? jsonStr(o.legalName),
    telephone: jsonStr(asArray(o.telephone as string | string[])[0]),
    email: jsonStr(asArray(o.email as string | string[])[0]),
    street: a ? jsonStr(a.streetAddress) : typeof o.address === "string" ? o.address : undefined,
    city: a ? jsonStr(a.addressLocality) : undefined,
    region: a ? jsonStr(a.addressRegion) : undefined,
    postcode: a ? jsonStr(a.postalCode) : undefined,
    country: a ? jsonStr(a.addressCountry) : undefined,
    sameAs: asArray(o.sameAs as string | string[]).filter(
      (s): s is string => typeof s === "string",
    ),
    description: jsonStr(o.description),
  };
  if (rating && typeof rating === "object") {
    const rv = Number(rating.ratingValue);
    const rc = Number(rating.reviewCount ?? rating.ratingCount);
    if (Number.isFinite(rv)) org.rating = rv;
    if (Number.isFinite(rc)) org.reviewCount = rc;
  }
  if (!org.name && !org.telephone && !org.email && !org.street) return null;
  return org;
}

const TITLE_WORDS =
  /\b(owner|co-?owner|founder|co-?founder|ceo|cfo|coo|cto|president|vice president|vp|director|manager|partner|principal|dentist|dds|dmd|doctor|physician|attorney|lawyer|counsel|broker|realtor|agent|accountant|cpa|head of|lead|chef|proprietor|managing|associate|hygienist|therapist|stylist|consultant|engineer|architect|officer)\b/i;
const NAME_RE =
  /^(?:(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+)?[A-Z][a-zA-Z'’-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-zA-Z'’-]+){1,2}(?:,\s*[A-Z]{2,5}(?:,\s*[A-Z]{2,5})?)?$/;

function looksLikeName(s: string): boolean {
  if (s.length < 5 || s.length > 48 || !NAME_RE.test(s)) return false;
  // Headings like "Our Team", "Contact Us", "Family Dentistry" are not people.
  return !/\b(our|the|us|team|contact|about|services?|welcome|dentistry|office|hours|location|family|meet|care|clinic|center|group|company|inc|llc|read|more|learn|book|call)\b/i.test(
    s,
  );
}

function cleanText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

type El = {
  tagName: string;
  textContent: string | null;
  nextElementSibling: El | null;
  parentElement: El | null;
  getAttribute(name: string): string | null;
  querySelectorAll(sel: string): ArrayLike<El>;
};

/** Best-effort team members: a name-like heading followed by a title-like line. */
function extractPeople(doc: { querySelectorAll(sel: string): ArrayLike<El> }): LeadPerson[] {
  const people: LeadPerson[] = [];
  const seen = new Set<string>();
  for (const h of Array.from(doc.querySelectorAll("h2,h3,h4,h5,strong,b"))) {
    const name = cleanText(h.textContent);
    if (!looksLikeName(name)) continue;
    let title: string | null = null;
    const candidates = [h.nextElementSibling, h.parentElement?.nextElementSibling ?? null];
    for (const c of candidates) {
      const t = cleanText(c?.textContent);
      if (t && t.length <= 80 && TITLE_WORDS.test(t)) {
        title = t;
        break;
      }
    }
    // "Jane Doe, DDS" carries the title in the heading itself.
    if (!title && /,\s*[A-Z]{2,5}$/.test(name) && TITLE_WORDS.test(name))
      title = name.split(",").slice(1).join(",").trim();
    if (!title) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ name: name.replace(/,.*$/, "").trim(), title });
    if (people.length >= 20) break;
  }
  return people;
}

/** Pure extraction from one HTML page. */
export function extractFromHtml(html: string, pageUrl: string, country = "US"): PageExtract {
  const { document } = parseHTML(html);
  const doc = document as unknown as {
    querySelectorAll(sel: string): ArrayLike<El>;
    querySelector(sel: string): El | null;
    body: El | null;
    title?: string;
  };
  const emails = new Set<string>();
  const phones = new Set<string>();
  const social: Record<string, string> = {};
  const links: string[] = [];
  const orgs: JsonLdOrg[] = [];
  const people: LeadPerson[] = [];

  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = (a.getAttribute("href") ?? "").trim();
    if (/^mailto:/i.test(href)) {
      let addr = href.slice(7);
      try {
        addr = decodeURIComponent(addr);
      } catch {
        /* keep raw */
      }
      for (const part of addr.split(",")) {
        const e = cleanEmail(part);
        if (e) emails.add(e);
      }
      continue;
    }
    if (/^tel:/i.test(href)) {
      const p = normalizePhone(decodeURIComponent(href.slice(4)), country);
      if (p) phones.add(p);
      continue;
    }
    let abs: string;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    const net = socialNetwork(abs);
    if (net) {
      if (!social[net]) social[net] = abs.replace(/[?#].*$/, "");
      continue;
    }
    if (/^https?:/i.test(abs)) links.push(abs);
  }

  for (const el of Array.from(doc.querySelectorAll("[data-cfemail]"))) {
    const e = cleanEmail(decodeCfEmail(el.getAttribute("data-cfemail") ?? "") ?? "");
    if (e) emails.add(e);
  }

  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.textContent ?? "");
    } catch {
      continue;
    }
    const flat: Json[] = [];
    flattenLd(parsed, flat);
    for (const o of flat) {
      const types = asArray(o["@type"] as string | string[]).map((t) => String(t).toLowerCase());
      if (types.includes("person")) {
        const name = jsonStr(o.name);
        if (name)
          people.push({
            name,
            title: jsonStr(o.jobTitle) ?? null,
            email: cleanEmail(jsonStr(o.email) ?? ""),
          });
        continue;
      }
      const org = parseLdOrg(o);
      if (!org) continue;
      orgs.push(org);
      const e = org.email ? cleanEmail(org.email) : null;
      if (e) emails.add(e);
      const p = org.telephone ? normalizePhone(org.telephone, country) : null;
      if (p) phones.add(p);
      for (const same of org.sameAs) {
        const net = socialNetwork(same);
        if (net && !social[net]) social[net] = same;
      }
    }
  }

  // Visible text only (scripts/styles removed) for regex scans.
  for (const el of Array.from(doc.querySelectorAll("script,style,noscript,template,svg")))
    (el as unknown as { remove(): void }).remove();
  const text = cleanText(doc.body?.textContent ?? "");
  for (const e of emailsFromText(text)) emails.add(e);
  for (const p of phonesFromText(text, country)) phones.add(p);

  for (const p of extractPeople(doc)) if (!people.some((x) => x.name === p.name)) people.push(p);

  const meta = (sel: string) => str(doc.querySelector(sel)?.getAttribute("content")) ?? undefined;
  return {
    url: pageUrl,
    emails: [...emails],
    phones: [...phones],
    social,
    orgs,
    people,
    siteName: meta('meta[property="og:site_name"]'),
    description: meta('meta[property="og:description"]') ?? meta('meta[name="description"]'),
    title: cleanText(doc.querySelector("title")?.textContent) || undefined,
    links,
  };
}
