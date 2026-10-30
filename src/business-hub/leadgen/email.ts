/**
 * Lead generation — email-patterns provider: candidate addresses from a
 * person name + domain, MX lookup (cached), disposable / free-mail / role
 * detection and a conservative verdict.
 *
 * Deliberately NO SMTP probing (RCPT TO): outbound port 25 is blocked on most
 * residential/cloud networks, probing gets the sending IP onto blocklists,
 * and many servers are catch-all or greylist anyway, so the signal is poor.
 * Users who want mailbox-level checks can plug in a self-hosted verifier
 * (AfterShip email-verifier, Reacher) or a Hunter key — see external.ts.
 */

import { resolveMx as dnsResolveMx } from "node:dns/promises";
import { isFreeMailDomain, normalizeEmail } from "../util.js";
import { DISPOSABLE_DOMAINS } from "./data/disposable-domains.js";
import type { EmailVerdict, LeadgenDeps, MxRecord } from "./types.js";

const ROLE_LOCALS = new Set([
  "info",
  "contact",
  "hello",
  "hi",
  "sales",
  "support",
  "help",
  "admin",
  "office",
  "team",
  "enquiries",
  "enquiry",
  "inquiries",
  "inquiry",
  "mail",
  "email",
  "service",
  "services",
  "billing",
  "accounts",
  "accounting",
  "booking",
  "bookings",
  "reservations",
  "appointments",
  "frontdesk",
  "reception",
  "marketing",
  "media",
  "press",
  "jobs",
  "careers",
  "hr",
  "webmaster",
  "postmaster",
  "hostmaster",
  "abuse",
  "noreply",
  "no-reply",
  "donotreply",
  "privacy",
  "legal",
  "orders",
  "shop",
  "store",
  "general",
  "customerservice",
  "care",
  "feedback",
  "kontakt",
]);

export function isRoleAddress(email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  return ROLE_LOCALS.has(local) || ROLE_LOCALS.has(local.replace(/[._-]/g, ""));
}

export function isDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (DISPOSABLE_DOMAINS.has(d)) return true;
  const parts = d.split(".");
  // Subdomains of a disposable domain (x.mailinator.com) are disposable too.
  for (let i = 1; i < parts.length - 1; i++)
    if (DISPOSABLE_DOMAINS.has(parts.slice(i).join("."))) return true;
  return false;
}

function asciiName(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
}

/**
 * Common corporate address patterns, most likely first:
 * first, first.last, firstlast, flast, f.last, first_last, last.
 */
export function emailPatternCandidates(
  person: { first?: string | null; last?: string | null; name?: string | null },
  domain: string,
): string[] {
  let first = person.first ?? null;
  let last = person.last ?? null;
  if (!first && !last && person.name) {
    const parts = person.name
      .replace(/^(dr|mr|mrs|ms|miss|prof)\.?\s+/i, "")
      .replace(/,.*$/, "")
      .trim()
      .split(/\s+/);
    first = parts[0] ?? null;
    last = parts.length > 1 ? parts[parts.length - 1] : null;
  }
  const f = asciiName(first);
  const l = asciiName(last);
  const d = domain.toLowerCase();
  const locals: string[] = [];
  if (f) locals.push(f);
  if (f && l) locals.push(`${f}.${l}`, `${f}${l}`, `${f[0]}${l}`, `${f[0]}.${l}`, `${f}_${l}`);
  if (l) locals.push(l);
  return [...new Set(locals)].map((x) => `${x}@${d}`).filter((e) => normalizeEmail(e) === e);
}

// ── MX lookup (cached per resolver) ─────────────────────────────────────────

type MxResult = { ok: true; records: MxRecord[] } | { ok: false; error: "nodata" | "dns" };
const MX_TTL_MS = 6 * 60 * 60 * 1000;
const mxCaches = new WeakMap<object, Map<string, { at: number; result: MxResult }>>();

export async function lookupMx(domain: string, deps: LeadgenDeps): Promise<MxResult> {
  const resolver = deps.resolveMx ?? dnsResolveMx;
  let cache = mxCaches.get(resolver);
  if (!cache) {
    cache = new Map();
    mxCaches.set(resolver, cache);
  }
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(domain);
  if (hit && now - hit.at < MX_TTL_MS) return hit.result;
  let result: MxResult;
  try {
    const records = (await resolver(domain)).filter((r) => r.exchange && r.exchange !== ".");
    result = records.length ? { ok: true, records } : { ok: false, error: "nodata" };
  } catch (err) {
    const code = (err as { code?: string }).code;
    result = {
      ok: false,
      error: code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN" ? "nodata" : "dns",
    };
  }
  cache.set(domain, { at: now, result });
  return result;
}

/**
 * Verdict without SMTP:
 * - invalid: bad syntax, disposable domain, or the domain has no MX.
 * - valid:   published on the business's own site/listing AND the domain has MX
 *            (role addresses like info@ stay valid when published, flagged "role").
 * - risky:   MX exists but the address is a guess (pattern) / unseen.
 * - unknown: DNS failed (timeout/servfail) — retry later.
 */
export async function verifyEmailAddress(
  raw: string,
  opts: { foundOnSite?: boolean; deps?: LeadgenDeps } = {},
): Promise<EmailVerdict> {
  const deps = opts.deps ?? {};
  const email = normalizeEmail(raw);
  if (!email)
    return {
      email: String(raw ?? "").trim(),
      status: "invalid",
      reasons: ["bad syntax"],
      mx: null,
      disposable: false,
      freeMail: false,
      role: false,
    };
  const domain = email.split("@")[1];
  const disposable = isDisposableDomain(domain);
  const freeMail = isFreeMailDomain(domain);
  const role = isRoleAddress(email);
  const reasons: string[] = [];
  if (role) reasons.push("role address (shared inbox)");
  if (freeMail) reasons.push("free-mail provider");
  if (disposable) {
    reasons.push("disposable domain");
    return { email, status: "invalid", reasons, mx: null, disposable, freeMail, role };
  }
  const mx = await lookupMx(domain, deps);
  if (!mx.ok && mx.error === "nodata") {
    reasons.push("domain has no MX records");
    return { email, status: "invalid", reasons, mx: false, disposable, freeMail, role };
  }
  if (!mx.ok) {
    reasons.push("DNS lookup failed");
    return { email, status: "unknown", reasons, mx: null, disposable, freeMail, role };
  }
  reasons.push("domain accepts mail (MX)");
  if (opts.foundOnSite) {
    reasons.push("published by the business");
    return { email, status: "valid", reasons, mx: true, disposable, freeMail, role };
  }
  reasons.push("not seen published; mailbox unconfirmed (no SMTP probing)");
  return { email, status: "risky", reasons, mx: true, disposable, freeMail, role };
}

/** Reset MX caches (tests). */
export function resetMxCache(resolver?: object): void {
  if (resolver) mxCaches.delete(resolver);
}
