/**
 * Lead generation — self-hosted provider slots, OFF unless a service URL is
 * configured: gosom/google-maps-scraper REST, AfterShip/email-verifier
 * apiserver and Reacher (check-if-email-exists). Paid BYOK APIs are in
 * byok.ts.
 */

import { normalizePhone, normalizeWebsite, registrableDomain, str } from "../util.js";
import { isRoleAddress } from "./email.js";
import { jsonRequest } from "./http.js";
import {
  emptyLead,
  type EmailVerdict,
  type EmailVerdictStatus,
  type LeadData,
  type ProviderCtx,
  type SearchInput,
} from "./types.js";

export type Json = Record<string, unknown>;

/** Scalar → string (objects/arrays → fallback). */
export function txt(v: unknown, fallback = ""): string {
  return typeof v === "string"
    ? v
    : typeof v === "number" || typeof v === "boolean"
      ? String(v)
      : fallback;
}

export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function baseUrl(u: string | undefined): string {
  if (!u) throw new Error("service URL not configured");
  return u.replace(/\/+$/, "");
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180-ish CSV parser (quoted fields, embedded commas/newlines, "" escapes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

// ── gosom/google-maps-scraper ───────────────────────────────────────────────

export const GOSOM_NOTICE =
  "Runs your own gosom/google-maps-scraper (MIT) instance. Scraping Google Maps may breach Google's Terms of Service — you operate it and are responsible for its use.";

/** gosom results CSV → leads. */
export function parseGosomCsv(csv: string, country = "US"): LeadData[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (r: string[], ...names: string[]) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0 && str(r[i])) return str(r[i]);
    }
    return null;
  };
  const out: LeadData[] = [];
  for (const r of rows.slice(1)) {
    const title = col(r, "title", "name");
    if (!title) continue;
    const lead = emptyLead(title, "gosom");
    const website = normalizeWebsite(col(r, "website", "web_site"));
    if (website && !/google\.[a-z.]+\//.test(website)) {
      lead.website = website;
      lead.domain = registrableDomain(website);
    }
    const phone = col(r, "phone");
    const e164 = normalizePhone(phone, country);
    if (e164) {
      lead.phone = phone;
      lead.phoneE164 = e164;
      lead.phones = [e164];
    }
    for (const raw of (col(r, "emails", "email") ?? "").split(/[,;\s]+/)) {
      const e = str(raw.replace(/^[[\]"']+|[[\]"']+$/g, ""))?.toLowerCase();
      if (e?.includes("@"))
        lead.emails.push({
          email: e,
          source: "gosom",
          role: isRoleAddress(e),
          onDomain: !!lead.domain && registrableDomain(e) === lead.domain,
        });
    }
    lead.address = col(r, "address");
    try {
      const ca = JSON.parse(col(r, "complete_address") ?? "null") as Json | null;
      if (ca) {
        lead.street = str(ca.street);
        lead.city = str(ca.city);
        lead.region = str(ca.state);
        lead.postcode = str(ca.postal_code);
        lead.country = str(ca.country);
      }
    } catch {
      /* optional column */
    }
    lead.lat = num(col(r, "latitude", "lat"));
    lead.lon = num(col(r, "longtitude", "longitude", "lon", "lng"));
    lead.rating = num(col(r, "review_rating", "rating"));
    lead.reviewCount = num(col(r, "review_count", "reviews"));
    lead.category = col(r, "category", "categories");
    lead.categoryMatched = !!lead.category;
    lead.openingHours = col(r, "open_hours");
    const link = col(r, "link");
    if (link) lead.refs.gosom = link;
    out.push(lead);
  }
  return out;
}

export async function gosomSearch(
  input: SearchInput,
  ctx: ProviderCtx,
): Promise<{ leads: LeadData[]; attribution: string }> {
  const base = baseUrl(ctx.settings.serviceUrl);
  const keyword = [input.query, input.location].filter(Boolean).join(" in ");
  const maxTimeSec = 180;
  const created = await ctx.fetch(`${base}/api/v1/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `infinibot-${keyword}`.slice(0, 80),
      keywords: [keyword],
      lang: "en",
      zoom: 15,
      depth: Math.max(1, Math.ceil(input.limit / 20)),
      email: true,
      max_time: maxTimeSec,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!created.ok) throw new Error(`gosom create job HTTP ${created.status}`);
  const job = (await created.json()) as Json;
  const id = str(job.id ?? job.ID);
  if (!id) throw new Error("gosom: no job id returned");
  const interval = ctx.deps.pollIntervalMs ?? 5_000;
  const deadline = ctx.now() + (maxTimeSec + 120) * 1000;
  for (;;) {
    const res = await jsonRequest<Json>(
      ctx.fetch,
      `${base}/api/v1/jobs/${encodeURIComponent(id)}`,
      {
        timeoutMs: 15_000,
      },
    );
    const status = txt(res.data?.status ?? res.data?.Status).toLowerCase();
    if (status === "ok" || status === "done" || status === "completed") break;
    if (status === "failed" || status === "error") throw new Error("gosom job failed");
    if (ctx.now() > deadline) throw new Error("gosom job timed out");
    await ctx.sleep(interval);
  }
  const dl = await ctx.fetch(`${base}/api/v1/jobs/${encodeURIComponent(id)}/download`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!dl.ok) throw new Error(`gosom download HTTP ${dl.status}`);
  const leads = parseGosomCsv(await dl.text(), ctx.country).slice(0, input.limit);
  return { leads, attribution: "gosom/google-maps-scraper (self-hosted)" };
}

// ── AfterShip email-verifier / Reacher ──────────────────────────────────────

export function verdict(
  email: string,
  status: EmailVerdictStatus,
  reasons: string[],
  extra: Partial<EmailVerdict>,
  provider: string,
): EmailVerdict {
  return {
    email,
    status,
    reasons,
    mx: extra.mx ?? null,
    disposable: extra.disposable ?? false,
    freeMail: extra.freeMail ?? false,
    role: extra.role ?? isRoleAddress(email),
    provider,
  };
}

/** Map an AfterShip email-verifier `/v1/{email}/verification` response. */
export function mapAfterShip(email: string, d: Json): EmailVerdict {
  const syntax = (d.syntax as Json | undefined) ?? {};
  const smtp = (d.smtp as Json | null | undefined) ?? null;
  const extra = {
    mx: typeof d.has_mx_records === "boolean" ? d.has_mx_records : null,
    disposable: d.disposable === true,
    freeMail: d.free === true,
    role: d.role_account === true,
  };
  const reasons: string[] = [];
  if (syntax.valid === false)
    return verdict(email, "invalid", ["bad syntax"], extra, "email-verifier");
  if (extra.disposable)
    return verdict(email, "invalid", ["disposable domain"], extra, "email-verifier");
  if (extra.mx === false)
    return verdict(email, "invalid", ["no MX records"], extra, "email-verifier");
  const reachable = txt(d.reachable, "unknown");
  if (reachable === "no")
    return verdict(email, "invalid", ["mailbox unreachable (SMTP)"], extra, "email-verifier");
  if (smtp?.catch_all) reasons.push("catch-all domain");
  if (smtp?.full_inbox) reasons.push("inbox full");
  if (smtp?.disabled)
    return verdict(email, "invalid", ["mailbox disabled"], extra, "email-verifier");
  if (reachable === "yes" && smtp?.deliverable === true && !smtp?.catch_all)
    return verdict(email, "valid", ["deliverable (SMTP)", ...reasons], extra, "email-verifier");
  reasons.push(`reachable: ${reachable}`);
  return verdict(email, "risky", reasons, extra, "email-verifier");
}

export async function afterShipVerify(
  email: string,
  ctx: ProviderCtx,
): Promise<EmailVerdict | null> {
  const base = baseUrl(ctx.settings.serviceUrl);
  const res = await jsonRequest<Json>(
    ctx.fetch,
    `${base}/v1/${encodeURIComponent(email)}/verification`,
    {
      timeoutMs: 30_000,
    },
  );
  if (res.status !== 200 || !res.data) throw new Error(`email-verifier HTTP ${res.status}`);
  return mapAfterShip(email, res.data);
}

/** Map a Reacher `/v0/check_email` response. */
export function mapReacher(email: string, d: Json): EmailVerdict {
  const misc = (d.misc as Json | undefined) ?? {};
  const mx = (d.mx as Json | undefined) ?? {};
  const smtp = (d.smtp as Json | undefined) ?? {};
  const extra = {
    mx: typeof mx.accepts_mail === "boolean" ? mx.accepts_mail : null,
    disposable: misc.is_disposable === true,
    role: misc.is_role_account === true,
  };
  const r = txt(d.is_reachable, "unknown");
  const reasons = [`reacher: ${r}`];
  if (smtp.is_catch_all === true) reasons.push("catch-all domain");
  const status: EmailVerdictStatus =
    r === "safe" ? "valid" : r === "invalid" ? "invalid" : r === "risky" ? "risky" : "unknown";
  return verdict(email, status, reasons, extra, "reacher");
}

export async function reacherVerify(email: string, ctx: ProviderCtx): Promise<EmailVerdict | null> {
  const base = baseUrl(ctx.settings.serviceUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ctx.apiKey) headers["x-reacher-secret"] = ctx.apiKey;
  const res = await jsonRequest<Json>(ctx.fetch, `${base}/v0/check_email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ to_email: email }),
    timeoutMs: 60_000,
  });
  if (res.status !== 200 || !res.data) throw new Error(`reacher HTTP ${res.status}`);
  return mapReacher(email, res.data);
}
