/**
 * Lead generation — job pipeline. `startLeadSearch` persists a leadgen_jobs
 * row and runs search → dedupe → enrich → verify → score in-process,
 * writing progress JSON as it goes; results land in leadgen_results for
 * preview, with "already in CRM" flagged. Import lives in import.ts.
 */

import type { HubDb } from "../db.js";
import { findCompanyMatch, findContactMatch } from "../contacts.js";
import { clamp, hubId, parseJson, str } from "../util.js";
import { isEnabled, loadLeadgenConfig, providerCtx } from "./config.js";
import { getProvider, LEAD_PROVIDERS } from "./providers.js";
import { dedupeLeads, scoreLead } from "./scoring.js";
import type { JobProgress, LeadData, LeadgenConfig, LeadgenDeps, LeadProvider } from "./types.js";
import { pickPrimaryEmail, verifyLeadEmails } from "./verify.js";

export const DEFAULT_LIMIT = 40;
export const MAX_LIMIT = 200;

export type LeadSearchInput = {
  query: string;
  location?: string | null;
  providers?: string[];
  limit?: number;
  enrich?: boolean;
  verify?: boolean;
  businessId?: string | null;
  country?: string;
};

export type LeadJob = {
  id: string;
  businessId: string | null;
  query: string;
  location: string | null;
  providers: string[];
  options: Record<string, unknown>;
  status: "queued" | "running" | "done" | "error";
  progress: JobProgress;
  error: string | null;
  resultCount: number;
  importedCount: number;
  createdAt: number;
  finishedAt: number | null;
};

export type LeadResult = {
  id: string;
  jobId: string;
  dedupeKey: string;
  score: number;
  status: "new" | "imported" | "skipped";
  contactId: string | null;
  companyId: string | null;
  data: LeadData;
  createdAt: number;
};

type Row = Record<string, unknown>;

export function rowToJob(r: Row): LeadJob {
  return {
    id: r.id as string,
    businessId: (r.business_id as string) ?? null,
    query: r.query as string,
    location: (r.location as string) ?? null,
    providers: parseJson<string[]>(r.providers, []),
    options: parseJson<Record<string, unknown>>(r.options, {}),
    status: r.status as LeadJob["status"],
    progress: parseJson<JobProgress>(r.progress, {
      stage: "queued",
      found: 0,
      enriched: 0,
      verified: 0,
    }),
    error: (r.error as string) ?? null,
    resultCount: Number(r.result_count ?? 0),
    importedCount: Number(r.imported_count ?? 0),
    createdAt: r.created_at as number,
    finishedAt: (r.finished_at as number) ?? null,
  };
}

export function rowToResult(r: Row): LeadResult {
  return {
    id: r.id as string,
    jobId: r.job_id as string,
    dedupeKey: r.dedupe_key as string,
    score: Number(r.score ?? 0),
    status: r.status as LeadResult["status"],
    contactId: (r.contact_id as string) ?? null,
    companyId: (r.company_id as string) ?? null,
    data: parseJson<LeadData>(r.data, {
      name: "",
      emails: [],
      social: {},
      people: [],
      providers: [],
      refs: {},
      attribution: [],
    }),
    createdAt: r.created_at as number,
  };
}

/** In-flight jobs of this process (a running row without an entry was interrupted). */
const active = new Map<string, Promise<void>>();

export function waitForLeadJob(jobId: string): Promise<void> {
  return active.get(jobId) ?? Promise.resolve();
}

// ── Provider selection ──────────────────────────────────────────────────────

function selectProviders(
  db: HubDb,
  cfg: LeadgenConfig,
  requested: string[] | undefined,
  deps: LeadgenDeps,
): { search: LeadProvider[]; enrich: LeadProvider[]; verify: LeadProvider[] } {
  const usable = (p: LeadProvider) => p.available(cfg, providerCtx(db, cfg, p, deps).apiKey).ok;
  let chosen: LeadProvider[];
  if (requested?.length) {
    chosen = [];
    for (const id of requested) {
      const p = getProvider(id);
      if (!p) throw new Error(`unknown provider: ${id}`);
      const av = p.available(cfg, providerCtx(db, cfg, p, deps).apiKey);
      if (!av.ok) throw new Error(`${p.label} unavailable: ${av.reason ?? "not configured"}`);
      chosen.push(p);
    }
    // Requesting only search providers keeps the default enrich/verify chain.
    if (!chosen.some((p) => p.kind !== "search"))
      chosen.push(
        ...LEAD_PROVIDERS.filter((p) => p.kind !== "search" && isEnabled(p, cfg) && usable(p)),
      );
  } else chosen = LEAD_PROVIDERS.filter((p) => isEnabled(p, cfg) && usable(p));
  return {
    search: chosen.filter((p) => p.search),
    enrich: chosen.filter((p) => p.enrich && p.kind !== "search"),
    verify: chosen.filter((p) => p.verify && p.id !== "email-patterns"),
  };
}

// ── Existing-in-CRM flag ────────────────────────────────────────────────────

export function existingMatch(db: HubDb, lead: LeadData, country = "US"): LeadData["existing"] {
  const company = findCompanyMatch(db, {
    name: lead.name,
    website: lead.website,
    domain: lead.domain,
    city: lead.city,
  });
  let contactId: string | null = null;
  for (const e of [lead.email, ...lead.emails.map((x) => x.email)]) {
    if (!e) continue;
    const m = findContactMatch(db, { email: e }, country);
    if (m) {
      contactId = m.contact.id;
      break;
    }
  }
  if (!contactId && (lead.phoneE164 || lead.phone)) {
    const m = findContactMatch(db, { phone: lead.phoneE164 ?? lead.phone }, country);
    if (m) contactId = m.contact.id;
  }
  return company || contactId ? { companyId: company?.id ?? null, contactId } : null;
}

// ── Job runner ──────────────────────────────────────────────────────────────

async function mapLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Create a lead-search job and run it in the background. */
export function startLeadSearch(
  db: HubDb,
  input: LeadSearchInput,
  deps: LeadgenDeps = {},
): { jobId: string; done: Promise<void> } {
  const query = str(input.query);
  if (!query) throw new Error("query required");
  const cfg = loadLeadgenConfig(db);
  const limit = clamp(Math.floor(input.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
  const chosen = selectProviders(db, cfg, input.providers, deps);
  if (!chosen.search.length) throw new Error("no search provider enabled");
  const id = hubId("lgj");
  const options = {
    limit,
    enrich: input.enrich !== false,
    verify: input.verify !== false,
    country: (input.country ?? cfg.defaultCountry).toUpperCase(),
  };
  const providers = [...chosen.search, ...chosen.enrich, ...chosen.verify].map((p) => p.id);
  if (options.verify) providers.push("email-patterns");
  const progress: JobProgress = {
    stage: "queued",
    found: 0,
    enriched: 0,
    verified: 0,
    errors: [],
    attribution: [],
  };
  db.prepare(
    `INSERT INTO leadgen_jobs(id,business_id,query,location,providers,options,status,progress,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.businessId ?? null,
    query,
    str(input.location),
    JSON.stringify([...new Set(providers)]),
    JSON.stringify(options),
    "queued",
    JSON.stringify(progress),
    Date.now(),
  );
  const done = runJob(
    db,
    id,
    { query, location: str(input.location), ...options },
    chosen,
    cfg,
    deps,
  ).finally(() => active.delete(id));
  active.set(id, done);
  return { jobId: id, done };
}

async function runJob(
  db: HubDb,
  jobId: string,
  opts: {
    query: string;
    location: string | null;
    limit: number;
    enrich: boolean;
    verify: boolean;
    country: string;
  },
  chosen: ReturnType<typeof selectProviders>,
  cfg: LeadgenConfig,
  deps: LeadgenDeps,
): Promise<void> {
  const progress: JobProgress = {
    stage: "search",
    found: 0,
    enriched: 0,
    verified: 0,
    errors: [],
    attribution: [],
  };
  const save = (status?: LeadJob["status"]) => {
    db.prepare(
      "UPDATE leadgen_jobs SET progress = ?, status = COALESCE(?, status) WHERE id = ?",
    ).run(JSON.stringify(progress), status ?? null, jobId);
    try {
      deps.onProgress?.(jobId, { ...progress });
    } catch {
      /* UI broadcast is best effort */
    }
  };
  // Yield so the caller gets the job id before any work starts.
  await Promise.resolve();
  try {
    save("running");
    const raw: LeadData[] = [];
    for (const p of chosen.search) {
      try {
        const res = await p.search!(
          { query: opts.query, location: opts.location, limit: opts.limit },
          providerCtx(db, cfg, p, deps, opts.country),
        );
        raw.push(...res.leads);
        if (res.attribution && !progress.attribution!.includes(res.attribution))
          progress.attribution!.push(res.attribution);
      } catch (err) {
        progress.errors!.push(`${p.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
      progress.found = raw.length;
      save();
    }
    if (!raw.length && progress.errors!.length) throw new Error(progress.errors!.join("; "));
    const merged = dedupeLeads(raw, opts.country).slice(0, opts.limit);
    progress.found = merged.length;
    progress.total = merged.length;

    const now = Date.now();
    const ins = db.prepare(
      "INSERT OR IGNORE INTO leadgen_results(id,job_id,dedupe_key,data,score,status,created_at) VALUES(?,?,?,?,?,?,?)",
    );
    const rows = merged.map(({ key, lead }) => {
      const rid = hubId("lgr");
      lead.existing = existingMatch(db, lead, opts.country);
      const s = scoreLead(lead);
      lead.scoreReasons = s.reasons;
      ins.run(rid, jobId, key, JSON.stringify(lead), s.score, "new", now);
      return { id: rid, lead };
    });
    db.prepare("UPDATE leadgen_jobs SET result_count = ? WHERE id = ?").run(rows.length, jobId);
    const upd = db.prepare("UPDATE leadgen_results SET data = ?, score = ? WHERE id = ?");
    const persist = (r: { id: string; lead: LeadData }) => {
      const s = scoreLead(r.lead);
      r.lead.scoreReasons = s.reasons;
      upd.run(JSON.stringify(r.lead), s.score, r.id);
    };

    if (opts.enrich && chosen.enrich.length) {
      progress.stage = "enrich";
      save();
      await mapLimit(rows, 3, async (r) => {
        for (const p of chosen.enrich) {
          try {
            await p.enrich!(r.lead, providerCtx(db, cfg, p, deps, opts.country));
          } catch (err) {
            r.lead.notes = [
              ...(r.lead.notes ?? []),
              `${p.label}: ${err instanceof Error ? err.message : String(err)}`,
            ];
          }
        }
        persist(r);
        progress.enriched++;
        save();
      });
    }

    if (opts.verify) {
      progress.stage = "verify";
      save();
      await mapLimit(rows, 4, async (r) => {
        try {
          await verifyLeadEmails(r.lead, { db, cfg, deps, verifiers: chosen.verify });
        } catch (err) {
          r.lead.notes = [
            ...(r.lead.notes ?? []),
            `verify: ${err instanceof Error ? err.message : String(err)}`,
          ];
        }
        progress.verified++;
        persist(r);
        save();
      });
    } else for (const r of rows) r.lead.email = pickPrimaryEmail(r.lead)?.email ?? null;

    progress.stage = "score";
    for (const r of rows) {
      r.lead.existing = existingMatch(db, r.lead, opts.country);
      for (const a of r.lead.attribution)
        if (!progress.attribution!.includes(a)) progress.attribution!.push(a);
      persist(r);
    }
    progress.stage = "done";
    save("done");
    db.prepare("UPDATE leadgen_jobs SET finished_at = ? WHERE id = ?").run(Date.now(), jobId);
  } catch (err) {
    progress.stage = "error";
    const msg = err instanceof Error ? err.message : String(err);
    save("error");
    db.prepare("UPDATE leadgen_jobs SET error = ?, finished_at = ? WHERE id = ?").run(
      msg,
      Date.now(),
      jobId,
    );
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function getLeadJob(db: HubDb, jobId: string): LeadJob | null {
  const r = db.prepare("SELECT * FROM leadgen_jobs WHERE id = ?").get(jobId) as Row | undefined;
  if (!r) return null;
  if ((r.status === "running" || r.status === "queued") && !active.has(jobId)) {
    // The process that ran it is gone (gateway restart).
    db.prepare(
      "UPDATE leadgen_jobs SET status='error', error=COALESCE(error,'interrupted (gateway restarted)'), finished_at=? WHERE id=?",
    ).run(Date.now(), jobId);
    return getLeadJob(db, jobId);
  }
  return rowToJob(r);
}

export function listLeadJobs(
  db: HubDb,
  opts: { limit?: number; businessId?: string | null } = {},
): LeadJob[] {
  const rows = (
    opts.businessId
      ? db
          .prepare(
            "SELECT * FROM leadgen_jobs WHERE business_id = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(opts.businessId, Math.min(opts.limit ?? 20, 100))
      : db
          .prepare("SELECT * FROM leadgen_jobs ORDER BY created_at DESC LIMIT ?")
          .all(Math.min(opts.limit ?? 20, 100))
  ) as Row[];
  return rows.map((r) => getLeadJob(db, r.id as string) ?? rowToJob(r));
}

export type ResultQuery = {
  minScore?: number;
  hasEmail?: boolean;
  status?: LeadResult["status"];
  limit?: number;
  offset?: number;
};

export function listLeadResults(
  db: HubDb,
  jobId: string,
  q: ResultQuery = {},
): { results: LeadResult[]; total: number } {
  const where = ["job_id = ?"];
  const p: unknown[] = [jobId];
  if (typeof q.minScore === "number") {
    where.push("score >= ?");
    p.push(q.minScore);
  }
  if (q.hasEmail) where.push("json_extract(data,'$.email') IS NOT NULL");
  if (q.status) {
    where.push("status = ?");
    p.push(q.status);
  }
  const w = where.join(" AND ");
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM leadgen_results WHERE ${w}`).get(...p) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT * FROM leadgen_results WHERE ${w} ORDER BY score DESC, created_at LIMIT ? OFFSET ?`,
    )
    .all(...p, Math.min(q.limit ?? 50, 200), q.offset ?? 0) as Row[];
  return { results: rows.map(rowToResult), total };
}
