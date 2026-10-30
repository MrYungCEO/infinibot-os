/**
 * Lead generation — `website` enrich provider: crawl a business homepage plus
 * up to 4 likely contact/about/team pages (robots.txt honoured, SSRF-guarded,
 * see http.ts), then merge what extract.ts finds into the lead, preferring
 * emails on the company's own registrable domain.
 */

import { normalizeWebsite, registrableDomain } from "../util.js";
import { isRoleAddress } from "./email.js";
import { extractFromHtml, type PageExtract } from "./extract.js";
import { politeGet } from "./http.js";
import type { LeadData, LeadEmail, LeadgenDeps } from "./types.js";

const PAGE_HINTS: Array<[RegExp, number]> = [
  [/contact|kontakt|get-in-touch|reach-us/i, 1],
  [/impressum|imprint/i, 2],
  [/team|staff|people|our-doctors|meet-|leadership|attorneys|providers/i, 3],
  [/about/i, 4],
];
const DEFAULT_PATHS = ["/contact", "/contact-us", "/about", "/about-us", "/impressum", "/team"];

/** Same-site links that look like contact/about/team pages, best first (max `max`). */
export function pickLikelyPages(home: string, links: string[], max = 4): string[] {
  const homeUrl = new URL(home);
  const site = registrableDomain(homeUrl.hostname);
  const scored: Array<[string, number]> = [];
  const seen = new Set<string>([homeUrl.toString().replace(/\/$/, "")]);
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l);
    } catch {
      continue;
    }
    if (registrableDomain(u.hostname) !== site) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?)$/i.test(u.pathname)) continue;
    u.hash = "";
    const key = u.toString().replace(/\/$/, "");
    if (seen.has(key)) continue;
    const hint = PAGE_HINTS.find(([re]) => re.test(u.pathname));
    if (!hint) continue;
    seen.add(key);
    scored.push([u.toString(), hint[1]]);
  }
  scored.sort((a, b) => a[1] - b[1]);
  const out = scored.map(([u]) => u);
  // Nothing linked: fall back to the two most common paths only (avoid 404 spam).
  if (out.length < 2)
    for (const p of DEFAULT_PATHS.slice(0, 3)) {
      const u = new URL(p, homeUrl).toString();
      if (!seen.has(u.replace(/\/$/, "")) && !out.includes(u)) out.push(u);
      if (out.length >= 2) break;
    }
  return out.slice(0, max);
}

export type SiteCrawl = {
  pages: PageExtract[];
  skipped: string[];
  errors: string[];
};

/** Crawl homepage + up to 4 likely pages, politely. */
export async function crawlSite(
  website: string,
  deps: LeadgenDeps,
  country = "US",
): Promise<SiteCrawl> {
  const out: SiteCrawl = { pages: [], skipped: [], errors: [] };
  const home = normalizeWebsite(website);
  if (!home) {
    out.errors.push("invalid website");
    return out;
  }
  let homeUrl = home;
  try {
    const res = await politeGet(home, deps);
    if (!res) {
      out.skipped.push(`${home} (robots.txt)`);
      return out;
    }
    if (res.status >= 400 || !res.body) {
      out.errors.push(`homepage HTTP ${res.status}`);
      return out;
    }
    if (res.contentType && !/html|xml|text\/plain/.test(res.contentType)) {
      out.errors.push(`homepage not HTML (${res.contentType})`);
      return out;
    }
    homeUrl = res.url;
    out.pages.push(extractFromHtml(res.body, res.url, country));
  } catch (err) {
    out.errors.push(`homepage: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  for (const page of pickLikelyPages(homeUrl, out.pages[0].links)) {
    try {
      const res = await politeGet(page, deps);
      if (!res) {
        out.skipped.push(`${new URL(page).pathname} (robots.txt)`);
        continue;
      }
      if (res.status >= 400 || !res.body || (res.contentType && !/html/.test(res.contentType)))
        continue;
      out.pages.push(extractFromHtml(res.body, res.url, country));
    } catch (err) {
      out.errors.push(
        `${new URL(page).pathname}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** Merge a crawl into a lead, preferring emails on the company's own domain. */
export function applyCrawl(lead: LeadData, crawl: SiteCrawl): void {
  if (!crawl.pages.length) return;
  const domain =
    lead.domain ?? registrableDomain(lead.website) ?? registrableDomain(crawl.pages[0].url);
  if (!lead.domain && domain) lead.domain = domain;
  const known = new Set(lead.emails.map((e) => e.email));
  const fresh: LeadEmail[] = [];
  for (const p of crawl.pages) {
    for (const e of p.emails) {
      if (known.has(e)) {
        const cur = lead.emails.find((x) => x.email === e);
        if (cur && cur.source !== "website") cur.source = `${cur.source}+website`;
        continue;
      }
      known.add(e);
      fresh.push({
        email: e,
        source: "website",
        role: isRoleAddress(e),
        onDomain: !!domain && registrableDomain(e) === domain,
      });
    }
    for (const ph of p.phones) {
      lead.phones = lead.phones ?? [];
      if (!lead.phones.includes(ph)) lead.phones.push(ph);
    }
    for (const [net, url] of Object.entries(p.social))
      if (!lead.social[net]) lead.social[net] = url;
    for (const person of p.people)
      if (!lead.people.some((x) => x.name.toLowerCase() === person.name.toLowerCase()))
        lead.people.push(person);
    for (const org of p.orgs) {
      if (!lead.name && org.name) lead.name = org.name;
      lead.street = lead.street ?? org.street ?? null;
      lead.city = lead.city ?? org.city ?? null;
      lead.region = lead.region ?? org.region ?? null;
      lead.postcode = lead.postcode ?? org.postcode ?? null;
      lead.country = lead.country ?? org.country ?? null;
      if (lead.rating == null && org.rating != null) lead.rating = org.rating;
      if (lead.reviewCount == null && org.reviewCount != null) lead.reviewCount = org.reviewCount;
      lead.description = lead.description ?? org.description ?? null;
    }
    lead.description = lead.description ?? p.description ?? null;
  }
  // Own-domain first, then personal before role, third-party domains last.
  fresh.sort((a, b) => Number(b.onDomain) - Number(a.onDomain) || Number(a.role) - Number(b.role));
  lead.emails.push(...fresh);
  for (const person of lead.people) {
    if (person.email) continue;
    const last = person.name.split(/\s+/).pop()?.toLowerCase() ?? "";
    const hit = lead.emails.find(
      (e) => !e.role && last.length > 2 && e.email.split("@")[0].includes(last),
    );
    if (hit) {
      person.email = hit.email;
      hit.personName = person.name;
    }
  }
  if (!lead.phone && lead.phones?.length) {
    lead.phone = lead.phones[0];
    lead.phoneE164 = lead.phones[0];
  }
  if (!lead.providers.includes("website")) lead.providers.push("website");
}
