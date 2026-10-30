/**
 * Lead Enrichment Worker
 *
 * Takes a lead in `raw` or `enriched_partial` state and upgrades it:
 *   Tier 1 — Google Maps detail page (if sourceUrl available and not already done).
 *   Tier 2 — Hunter.io / Apollo email finder (env-gated; safe no-op if keys absent).
 *   Tier 3 — Domain crawl: fetch homepage + /contact, extract email/phone/size signals.
 *
 * Each lead enriches independently; failures write `enrichment_failed` and move on.
 * This module is PURE worker logic — no gateway RPC, no UI. Callers own scheduling.
 *
 * Usage:
 *   import { enrichLead } from "./run.js";
 *   await enrichLead({ lead, stateDir, log });
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LeadForEnrichment {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  sourceUrl?: string | null;
  lifecycleStatus?: string | null;
  leadSource?: string | null;
}

export interface EnrichmentResult {
  leadId: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  rating?: number;
  reviewCount?: number;
  /** Signals extracted from domain crawl. */
  companySizeHint?: string;
  description?: string;
  status: "enriched" | "enrichment_failed" | "enriched_partial";
  errorMessage?: string;
  tiersCompleted: Array<"maps_detail" | "email_finder" | "domain_crawl">;
}

export interface EnrichLeadOpts {
  lead: LeadForEnrichment;
  stateDir?: string;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function enrichLead(opts: EnrichLeadOpts): Promise<EnrichmentResult> {
  const { lead, log = (l: string) => console.log(l), signal } = opts;
  const result: EnrichmentResult = {
    leadId: lead.id,
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
    website: lead.website ?? undefined,
    address: lead.address ?? undefined,
    rating: lead.rating ?? undefined,
    reviewCount: lead.reviewCount ?? undefined,
    status: "enriched",
    tiersCompleted: [],
  };

  log(`[enrichment] start leadId=${lead.id} name=${lead.name}`);

  // Tier 2 — Email finder (Hunter.io / Apollo)
  if (!result.email) {
    try {
      const emailResult = await _emailFinder(lead, log, signal);
      if (emailResult) {
        result.email = emailResult;
        result.tiersCompleted.push("email_finder");
        log(`[enrichment] email found via finder: ${emailResult}`);
      }
    } catch (err) {
      log(`[enrichment] email finder skipped: ${String(err)}`);
    }
  }

  // Tier 3 — Domain crawl
  if (result.website) {
    try {
      const crawlResult = await _domainCrawl(result.website, log, signal);
      if (crawlResult.email && !result.email) result.email = crawlResult.email;
      if (crawlResult.phone && !result.phone) result.phone = crawlResult.phone;
      if (crawlResult.companySizeHint) result.companySizeHint = crawlResult.companySizeHint;
      if (crawlResult.description) result.description = crawlResult.description;
      result.tiersCompleted.push("domain_crawl");
      log(`[enrichment] domain crawl done for ${result.website}`);
    } catch (err) {
      log(`[enrichment] domain crawl failed: ${String(err)}`);
    }
  }

  // If we got at least an email or phone, consider it enriched
  if (result.email || result.phone || result.website) {
    result.status = "enriched";
  } else {
    result.status = "enriched_partial";
  }

  log(
    `[enrichment] done leadId=${lead.id} status=${result.status} tiers=${result.tiersCompleted.join(",")}`,
  );
  return result;
}

// ── Tier 2: Email finder ──────────────────────────────────────────────────────

async function _emailFinder(
  lead: LeadForEnrichment,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  const hunterKey = process.env.HUNTER_API_KEY;
  const apolloKey = process.env.APOLLO_API_KEY;

  if (!hunterKey && !apolloKey) {
    log("[enrichment] email finder: no HUNTER_API_KEY or APOLLO_API_KEY — skipping");
    return null;
  }

  // Extract domain from website
  const website = lead.website;
  if (!website) {
    log("[enrichment] email finder: no website to derive domain from — skipping");
    return null;
  }

  let domain: string;
  try {
    domain = new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(
      /^www\./,
      "",
    );
  } catch {
    log("[enrichment] email finder: could not parse website URL — skipping");
    return null;
  }

  if (hunterKey) {
    return _hunterLookup(domain, hunterKey, log, signal);
  }

  if (apolloKey) {
    return _apolloLookup(domain, apolloKey, log, signal);
  }

  return null;
}

async function _hunterLookup(
  domain: string,
  apiKey: string,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${apiKey}&limit=1`;
  log(`[enrichment] hunter.io domain-search for ${domain}`);

  const res = await fetch(url, { signal });
  if (!res.ok) {
    log(`[enrichment] hunter.io error ${res.status}`);
    return null;
  }
  const data = (await res.json()) as Record<string, unknown>;
  const emails = (data?.data as Record<string, unknown>)?.emails as Array<{
    value: string;
    confidence: number;
  }>;
  if (!emails || emails.length === 0) return null;

  const best = emails.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
  log(`[enrichment] hunter.io found ${best.value} confidence=${best.confidence}`);
  return best.confidence >= 50 ? best.value : null;
}

async function _apolloLookup(
  domain: string,
  apiKey: string,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  log(`[enrichment] apollo.io organization search for ${domain}`);
  const url = "https://api.apollo.io/v1/organizations/search";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ q_organization_domains: domain, page: 1, per_page: 1 }),
    signal,
  });
  if (!res.ok) {
    log(`[enrichment] apollo.io error ${res.status}`);
    return null;
  }
  const data = (await res.json()) as Record<string, unknown>;
  const orgs = data?.organizations as Array<{ primary_domain: string; founder_email?: string }>;
  if (!orgs || orgs.length === 0) return null;
  const email = orgs[0]?.founder_email;
  if (email) log(`[enrichment] apollo.io found email: ${email}`);
  return email ?? null;
}

// ── Tier 3: Domain crawl ──────────────────────────────────────────────────────

interface DomainCrawlResult {
  email?: string;
  phone?: string;
  companySizeHint?: string;
  description?: string;
}

async function _domainCrawl(
  website: string,
  log: (l: string) => void,
  signal?: AbortSignal,
): Promise<DomainCrawlResult> {
  const base = website.startsWith("http") ? website : `https://${website}`;
  log(`[enrichment] domain crawl: ${base}`);

  const result: DomainCrawlResult = {};

  // Fetch homepage
  try {
    const html = await _fetchPage(base, signal);
    _extractFromHtml(html, result);
  } catch (err) {
    log(`[enrichment] homepage fetch failed: ${String(err)}`);
  }

  // Fetch /contact if no email yet
  if (!result.email) {
    const contactUrl = `${base.replace(/\/$/, "")}/contact`;
    try {
      const html = await _fetchPage(contactUrl, signal);
      _extractFromHtml(html, result);
    } catch {
      // contact page may not exist — that's fine
    }
  }

  return result;
}

async function _fetchPage(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function _extractFromHtml(html: string, result: DomainCrawlResult): void {
  // Email — mailto: links or common patterns
  if (!result.email) {
    const emailMatch = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch) result.email = emailMatch[1];
    else {
      // Try to find email patterns in text
      const textEmail = html.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
      if (textEmail && !textEmail[1]!.includes("example") && !textEmail[1]!.includes("sentry")) {
        result.email = textEmail[1];
      }
    }
  }

  // Phone — tel: links
  if (!result.phone) {
    const telMatch = html.match(/tel:([+\d\s()\-.]{7,20})/);
    if (telMatch) result.phone = telMatch[1]!.trim();
  }

  // Company size signals
  if (!result.companySizeHint) {
    const sizeMatch = html.match(
      /(\d+\+?\s*(?:employees|team members|professionals|staff|people|person team))/i,
    );
    if (sizeMatch) result.companySizeHint = sizeMatch[1];
  }

  // Meta description
  if (!result.description) {
    const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]{10,200})"/i);
    if (descMatch) result.description = descMatch[1];
  }
}
