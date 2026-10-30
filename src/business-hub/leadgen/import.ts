/**
 * Lead generation — CRM bridge: `importLeadResults` turns chosen results into
 * Companies/Contacts (source = leadgen, lifecycle lead) without creating
 * deals — the caller's `onImported` hook does that; `enrichHubRecord`
 * re-enriches one existing company/contact from its website.
 */

import type { HubDb } from "../db.js";
import {
  ensureSource,
  findContactMatch,
  getCompany,
  getContact,
  logActivity,
  updateContact,
  upsertCompany,
  upsertContact,
  type ContactInput,
  type EmailStatus,
} from "../contacts.js";
import { isFreeMailDomain, registrableDomain } from "../util.js";
import { isEnabled, loadLeadgenConfig, providerCtx } from "./config.js";
import { getLeadJob, rowToResult } from "./jobs.js";
import { getProvider } from "./providers.js";
import type { LeadData, LeadEmail, LeadgenDeps } from "./types.js";
import { activeVerifiers, verifyLeadEmails } from "./verify.js";
import { applyCrawl, crawlSite } from "./website.js";

type Row = Record<string, unknown>;

// ── Import ──────────────────────────────────────────────────────────────────

export type ImportOpts = {
  tags?: string[];
  /** Passed through for the caller's deal hook; this module never creates deals. */
  createDeals?: boolean;
  pipelineStage?: string;
  actor?: string | null;
  onImported?: (contactId: string | null, companyId: string | null) => void;
};

function toEmailStatus(s: LeadData["emailStatus"]): EmailStatus {
  return s === "valid" || s === "risky" || s === "invalid" ? s : "unknown";
}

export function importLeadResults(
  db: HubDb,
  jobId: string,
  resultIds: string[] | "all",
  opts: ImportOpts = {},
): {
  created: number;
  updated: number;
  skipped: number;
  contactIds: string[];
  companyIds: string[];
} {
  const job = getLeadJob(db, jobId);
  if (!job) throw new Error(`lead job not found: ${jobId}`);
  const country = typeof job.options.country === "string" ? job.options.country : "US";
  const rows = (
    resultIds === "all"
      ? db.prepare("SELECT * FROM leadgen_results WHERE job_id = ? ORDER BY score DESC").all(jobId)
      : resultIds.length
        ? db
            .prepare(
              `SELECT * FROM leadgen_results WHERE job_id = ? AND id IN (${resultIds.map(() => "?").join(",")})`,
            )
            .all(jobId, ...resultIds)
        : []
  ) as Row[];
  const out = {
    created: 0,
    updated: 0,
    skipped: 0,
    contactIds: [] as string[],
    companyIds: [] as string[],
  };
  const searchTag = [job.query, job.location].filter(Boolean).join(" · ").slice(0, 60);
  const tags = [...new Set([searchTag, ...(opts.tags ?? [])].filter(Boolean))];
  const hooks: Array<[string | null, string | null]> = [];

  for (const r of rows.map(rowToResult)) {
    if (r.status === "imported") {
      out.skipped++;
      continue;
    }
    const lead = r.data;
    const labels = lead.providers.map((id) => getProvider(id)?.label ?? id);
    const sourceId = ensureSource(
      db,
      "leadgen",
      getProvider(lead.providers[0] ?? "")?.label ?? "Lead search",
      {
        businessId: job.businessId,
      },
    );
    const tx = db.transaction(() => {
      const co = upsertCompany(
        db,
        {
          name: lead.name,
          website: lead.website,
          domain: lead.domain,
          phone: lead.phone ?? lead.phoneE164,
          address: lead.address ?? lead.street,
          city: lead.city,
          region: lead.region,
          country: lead.country,
          lat: lead.lat,
          lon: lead.lon,
          industry: lead.industry ?? lead.category,
          size: lead.employees != null ? String(lead.employees) : null,
          social: lead.social,
          custom: {
            leadgen: {
              jobId,
              resultId: r.id,
              rating: lead.rating ?? null,
              reviewCount: lead.reviewCount ?? null,
              openingHours: lead.openingHours ?? null,
              refs: lead.refs,
              attribution: lead.attribution,
            },
          },
          businessId: job.businessId,
          tags,
        },
        { sourceId, actor: opts.actor ?? "leadgen", defaultCountry: country },
      );
      const primary = lead.emails.find((e) => e.email === lead.email) ?? null;
      const person = primary?.personName
        ? (lead.people.find((p) => p.name === primary.personName) ?? { name: primary.personName })
        : null;
      let ct: ReturnType<typeof upsertContact> = null;
      if (lead.email || lead.phone || lead.phoneE164) {
        const input: ContactInput = {
          name: person?.name ?? lead.name,
          title: person?.title ?? null,
          email: lead.email,
          phone: lead.phone ?? lead.phoneE164,
          companyId: co?.company.id ?? null,
          lifecycle: "lead",
          score: r.score,
          emailStatus: toEmailStatus(lead.emailStatus),
          city: lead.city,
          country: lead.country,
          businessId: job.businessId,
          custom: { leadgen: { jobId, resultId: r.id, emailReasons: primary?.reasons ?? [] } },
          tags,
        };
        ct = upsertContact(db, input, {
          sourceId,
          actor: opts.actor ?? "leadgen",
          defaultCountry: country,
        });
      }
      // Counted by the primary record: the contact when there is one, else the company.
      const created = ct ? ct.created : !!co?.created;
      const subject = ct
        ? { subjectType: "contact" as const, subjectId: ct.contact.id }
        : co
          ? { subjectType: "company" as const, subjectId: co.company.id }
          : null;
      if (!subject) return null;
      logActivity(db, {
        ...subject,
        type: "leadgen.imported",
        summary: `Imported from lead search "${searchTag}" (${labels.join(", ")})`,
        actor: opts.actor ?? "leadgen",
        data: {
          jobId,
          resultId: r.id,
          score: r.score,
          providers: lead.providers,
          attribution: lead.attribution,
          scoreReasons: lead.scoreReasons ?? [],
        },
      });
      db.prepare(
        "UPDATE leadgen_results SET status='imported', contact_id=?, company_id=? WHERE id=?",
      ).run(ct?.contact.id ?? null, co?.company.id ?? null, r.id);
      return { created, contactId: ct?.contact.id ?? null, companyId: co?.company.id ?? null };
    });
    const res = tx();
    if (!res) {
      out.skipped++;
      db.prepare("UPDATE leadgen_results SET status='skipped' WHERE id=?").run(r.id);
      continue;
    }
    if (res.created) out.created++;
    else out.updated++;
    if (res.contactId) out.contactIds.push(res.contactId);
    if (res.companyId) out.companyIds.push(res.companyId);
    hooks.push([res.contactId, res.companyId]);
  }
  db.prepare(
    "UPDATE leadgen_jobs SET imported_count = (SELECT COUNT(*) FROM leadgen_results WHERE job_id = ? AND status='imported') WHERE id = ?",
  ).run(jobId, jobId);
  // Hooks run after the writes so a failing deal hook cannot roll back imports.
  if (opts.onImported) for (const [c, co] of hooks) opts.onImported(c, co);
  return out;
}

// ── Enrich one existing record ──────────────────────────────────────────────

export async function enrichHubRecord(
  db: HubDb,
  subject: { type: "company" | "contact"; id: string },
  deps: LeadgenDeps = {},
): Promise<{
  companyId: string | null;
  contactId: string | null;
  filled: string[];
  emails: LeadEmail[];
  notes: string[];
}> {
  const cfg = loadLeadgenConfig(db);
  const contact = subject.type === "contact" ? getContact(db, subject.id) : null;
  if (subject.type === "contact" && !contact) throw new Error(`contact not found: ${subject.id}`);
  const company =
    subject.type === "company"
      ? getCompany(db, subject.id)
      : contact?.companyId
        ? getCompany(db, contact.companyId)
        : null;
  if (subject.type === "company" && !company) throw new Error(`company not found: ${subject.id}`);
  const emailDomain = contact?.email ? registrableDomain(contact.email) : null;
  const website =
    company?.website ??
    (company?.domain ? `https://${company.domain}` : null) ??
    (emailDomain && !isFreeMailDomain(emailDomain) ? `https://${emailDomain}` : null);
  const lead: LeadData = {
    name: company?.name ?? contact?.name ?? "",
    website,
    domain: registrableDomain(website),
    phone: company?.phone ?? null,
    emails: contact?.email ? [{ email: contact.email, source: "crm" }] : [],
    social: { ...company?.social },
    people: contact?.name
      ? [{ name: contact.name, title: contact.title, email: contact.email }]
      : [],
    providers: [],
    refs: {},
    attribution: [],
  };
  const notes: string[] = [];
  if (website) {
    const crawl = await crawlSite(website, deps, cfg.defaultCountry);
    applyCrawl(lead, crawl);
    notes.push(...crawl.skipped.map((s) => `skipped ${s}`), ...crawl.errors);
  } else notes.push("no website or company domain to crawl");
  const wd = getProvider("wikidata");
  if (wd && isEnabled(wd, cfg) && company) {
    try {
      await wd.enrich!(lead, providerCtx(db, cfg, wd, deps));
    } catch (err) {
      notes.push(`Wikidata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // CRM address counts as "published" for MX-based verification.
  const verifiers = activeVerifiers(db, cfg, deps);
  await verifyLeadEmails(lead, { db, cfg, deps, verifiers });

  const filled: string[] = [];
  let companyId = company?.id ?? null;
  if (company) {
    const before = getCompany(db, company.id)!;
    upsertCompany(
      db,
      {
        name: company.name,
        domain: company.domain ?? lead.domain,
        website: company.website ?? lead.website,
        phone: lead.phone,
        address: lead.street,
        city: lead.city,
        region: lead.region,
        country: lead.country,
        industry: lead.industry,
        size: lead.employees != null ? String(lead.employees) : null,
        social: lead.social,
      },
      { actor: "leadgen" },
    );
    const after = getCompany(db, company.id)!;
    for (const k of ["phone", "address", "city", "region", "country", "industry", "size"] as const)
      if (!before[k] && after[k]) filled.push(`company.${k}`);
    for (const n of Object.keys(after.social))
      if (!before.social[n]) filled.push(`company.social.${n}`);
    companyId = after.id;
  }
  let contactId: string | null = contact?.id ?? null;
  if (contact) {
    const patch: ContactInput = {};
    const own = lead.emails.find((e) => e.email === contact.email);
    if (
      own?.status &&
      own.status !== "unknown" &&
      contact.emailStatus !== "bounced" &&
      own.status !== contact.emailStatus
    )
      patch.emailStatus = toEmailStatus(own.status);
    if (!contact.email) {
      const mine = lead.emails.find((e) => e.personName === contact.name && e.status !== "invalid");
      if (mine && !findContactMatch(db, { email: mine.email })) {
        patch.email = mine.email;
        patch.emailStatus = toEmailStatus(mine.status);
      }
    }
    if (!contact.phone && lead.phone && !company) patch.phone = lead.phone;
    if (Object.keys(patch).length) {
      updateContact(db, contact.id, patch, "leadgen");
      filled.push(...Object.keys(patch).map((k) => `contact.${k}`));
    }
  }
  const subjectId = contactId ?? companyId;
  if (subjectId)
    logActivity(db, {
      subjectType: contactId ? "contact" : "company",
      subjectId,
      type: "leadgen.enriched",
      summary: filled.length ? `Enriched: ${filled.join(", ")}` : "Enrichment found nothing new",
      actor: "leadgen",
      data: { filled, providers: lead.providers, attribution: lead.attribution },
    });
  return { companyId, contactId, filled, emails: lead.emails, notes };
}
