/**
 * Business hub — Contacts, Companies, Tags, Sources and the Activity
 * timeline. Everything that creates a person or organisation goes through
 * `upsertContact` / `upsertCompany`, so dedupe (email → phone → name+company;
 * domain → name+city) and the timeline are applied once, everywhere.
 */

import type { HubDb } from "./db.js";
import {
  companyNameKey,
  hubId,
  isFreeMailDomain,
  normalizeEmail,
  normalizePhone,
  normalizeWebsite,
  parseJson,
  registrableDomain,
  splitName,
  str,
} from "./util.js";
import { coerceString } from "../shared/text/coerce.js";

export type Lifecycle = "subscriber" | "lead" | "qualified" | "customer" | "churned";
export const LIFECYCLES: readonly Lifecycle[] = [
  "subscriber",
  "lead",
  "qualified",
  "customer",
  "churned",
];
export type EmailStatus = "unknown" | "valid" | "risky" | "invalid" | "bounced";
export type SubjectType = "contact" | "company" | "deal" | "client" | "campaign";

export type Contact = {
  id: string;
  businessId: string | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
  title: string | null;
  companyId: string | null;
  clientId: string | null;
  lifecycle: Lifecycle;
  score: number;
  emailStatus: EmailStatus;
  emailOptIn: boolean;
  consentAt: number | null;
  consentSource: string | null;
  owner: string | null;
  city: string | null;
  country: string | null;
  social: Record<string, string>;
  custom: Record<string, unknown>;
  firstSourceId: string | null;
  firstCampaignId: string | null;
  firstPageId: string | null;
  lastActivityAt: number | null;
  importBatchId: string | null;
  legacyRef: string | null;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
};

export type Company = {
  id: string;
  businessId: string | null;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  size: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lon: number | null;
  social: Record<string, string>;
  custom: Record<string, unknown>;
  clientId: string | null;
  sourceId: string | null;
  importBatchId: string | null;
  legacyRef: string | null;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
};

export type Activity = {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  type: string;
  summary: string;
  data: Record<string, unknown>;
  actor: string | null;
  occurredAt: number;
};

type Row = Record<string, unknown>;

function rowToContact(r: Row): Contact {
  return {
    id: r.id as string,
    businessId: (r.business_id as string) ?? null,
    name: (r.name as string) ?? "",
    firstName: (r.first_name as string) ?? null,
    lastName: (r.last_name as string) ?? null,
    email: (r.email as string) ?? null,
    phone: (r.phone as string) ?? null,
    phoneE164: (r.phone_e164 as string) ?? null,
    title: (r.title as string) ?? null,
    companyId: (r.company_id as string) ?? null,
    clientId: (r.client_id as string) ?? null,
    lifecycle: (r.lifecycle as Lifecycle) ?? "lead",
    score: Number(r.score ?? 0),
    emailStatus: (r.email_status as EmailStatus) ?? "unknown",
    emailOptIn: Boolean(r.email_opt_in),
    consentAt: (r.consent_at as number) ?? null,
    consentSource: (r.consent_source as string) ?? null,
    owner: (r.owner as string) ?? null,
    city: (r.city as string) ?? null,
    country: (r.country as string) ?? null,
    social: parseJson(r.social, {}),
    custom: parseJson(r.custom, {}),
    firstSourceId: (r.first_source_id as string) ?? null,
    firstCampaignId: (r.first_campaign_id as string) ?? null,
    firstPageId: (r.first_page_id as string) ?? null,
    lastActivityAt: (r.last_activity_at as number) ?? null,
    importBatchId: (r.import_batch_id as string) ?? null,
    legacyRef: (r.legacy_ref as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToCompany(r: Row): Company {
  return {
    id: r.id as string,
    businessId: (r.business_id as string) ?? null,
    name: r.name as string,
    domain: (r.domain as string) ?? null,
    website: (r.website as string) ?? null,
    industry: (r.industry as string) ?? null,
    size: (r.size as string) ?? null,
    phone: (r.phone as string) ?? null,
    address: (r.address as string) ?? null,
    city: (r.city as string) ?? null,
    region: (r.region as string) ?? null,
    country: (r.country as string) ?? null,
    lat: (r.lat as number) ?? null,
    lon: (r.lon as number) ?? null,
    social: parseJson(r.social, {}),
    custom: parseJson(r.custom, {}),
    clientId: (r.client_id as string) ?? null,
    sourceId: (r.source_id as string) ?? null,
    importBatchId: (r.import_batch_id as string) ?? null,
    legacyRef: (r.legacy_ref as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

// ── Activities ────────────────────────────────────────────────────────────────

export function logActivity(
  db: HubDb,
  a: {
    subjectType: SubjectType;
    subjectId: string;
    type: string;
    summary?: string;
    data?: Record<string, unknown>;
    actor?: string | null;
    occurredAt?: number;
  },
): Activity {
  const now = Date.now();
  const act: Activity = {
    id: hubId("act"),
    subjectType: a.subjectType,
    subjectId: a.subjectId,
    type: a.type,
    summary: a.summary ?? "",
    data: a.data ?? {},
    actor: a.actor ?? null,
    occurredAt: a.occurredAt ?? now,
  };
  db.prepare(
    `INSERT INTO activities(id,subject_type,subject_id,type,summary,data,actor,occurred_at,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    act.id,
    act.subjectType,
    act.subjectId,
    act.type,
    act.summary,
    JSON.stringify(act.data),
    act.actor,
    act.occurredAt,
    now,
  );
  if (a.subjectType === "contact") {
    db.prepare(
      "UPDATE contacts SET last_activity_at = MAX(COALESCE(last_activity_at,0), ?) WHERE id = ?",
    ).run(act.occurredAt, a.subjectId);
  }
  return act;
}

/**
 * Timeline for a subject. A contact's timeline also includes its deals'
 * activities; a company's includes its contacts and deals; a client's
 * includes the companies/contacts/deals linked to it.
 */
export function timeline(
  db: HubDb,
  subjectType: SubjectType,
  subjectId: string,
  opts: { limit?: number; before?: number } = {},
): Activity[] {
  const subjects: Array<[string, string]> = [[subjectType, subjectId]];
  const ids = (sql: string, ...p: unknown[]) =>
    (db.prepare(sql).all(...p) as Array<{ id: string }>).map((r) => r.id);
  if (subjectType === "contact") {
    for (const id of ids("SELECT id FROM deals WHERE contact_id = ?", subjectId))
      subjects.push(["deal", id]);
  } else if (subjectType === "company") {
    for (const id of ids("SELECT id FROM contacts WHERE company_id = ?", subjectId))
      subjects.push(["contact", id]);
    for (const id of ids("SELECT id FROM deals WHERE company_id = ?", subjectId))
      subjects.push(["deal", id]);
  } else if (subjectType === "client") {
    for (const id of ids("SELECT id FROM companies WHERE client_id = ?", subjectId))
      subjects.push(["company", id]);
    for (const id of ids(
      "SELECT id FROM contacts WHERE client_id = ? OR company_id IN (SELECT id FROM companies WHERE client_id = ?)",
      subjectId,
      subjectId,
    ))
      subjects.push(["contact", id]);
    for (const id of ids("SELECT id FROM deals WHERE client_id = ?", subjectId))
      subjects.push(["deal", id]);
  }
  const where = subjects.map(() => "(subject_type = ? AND subject_id = ?)").join(" OR ");
  const params: unknown[] = subjects.flat();
  let sql = `SELECT * FROM activities WHERE (${where})`;
  if (opts.before) {
    sql += " AND occurred_at < ?";
    params.push(opts.before);
  }
  sql += " ORDER BY occurred_at DESC LIMIT ?";
  params.push(Math.min(opts.limit ?? 100, 500));
  return (db.prepare(sql).all(...params) as Row[]).map((r) => ({
    id: r.id as string,
    subjectType: r.subject_type as SubjectType,
    subjectId: r.subject_id as string,
    type: r.type as string,
    summary: r.summary as string,
    data: parseJson(r.data, {}),
    actor: (r.actor as string) ?? null,
    occurredAt: r.occurred_at as number,
  }));
}

// ── Sources ───────────────────────────────────────────────────────────────────

export type SourceKind =
  | "organic"
  | "paid"
  | "referral"
  | "email"
  | "social"
  | "import"
  | "leadgen"
  | "form"
  | "manual"
  | "whop"
  | "stripe"
  | "legacy"
  | "direct";

export function ensureSource(
  db: HubDb,
  kind: string,
  name: string,
  extra: { utmSource?: string | null; utmMedium?: string | null; businessId?: string | null } = {},
): string {
  const n = (str(name) ?? kind).slice(0, 120);
  const found = db.prepare("SELECT id FROM sources WHERE kind = ? AND name = ?").get(kind, n) as
    | { id: string }
    | undefined;
  if (found) return found.id;
  const id = hubId("src");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sources(id,business_id,kind,name,utm_source,utm_medium,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    id,
    extra.businessId ?? null,
    kind,
    n,
    extra.utmSource ?? null,
    extra.utmMedium ?? null,
    now,
    now,
  );
  return id;
}

export function listSources(db: HubDb): Array<{ id: string; kind: string; name: string }> {
  return db.prepare("SELECT id, kind, name FROM sources ORDER BY kind, name").all() as Array<{
    id: string;
    kind: string;
    name: string;
  }>;
}

/** Attribution campaign by utm_campaign (created on first sight). */
export function ensureCampaignByUtm(db: HubDb, utmCampaign: string, channel = "web"): string {
  const key = utmCampaign.trim().toLowerCase().slice(0, 120);
  const found = db.prepare("SELECT id FROM campaigns WHERE utm_campaign = ?").get(key) as
    | { id: string }
    | undefined;
  if (found) return found.id;
  const id = hubId("cmp");
  const now = Date.now();
  db.prepare(
    "INSERT INTO campaigns(id,name,utm_campaign,channel,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  ).run(id, utmCampaign.trim().slice(0, 120), key, channel, "active", now, now);
  return id;
}

// ── Tags ──────────────────────────────────────────────────────────────────────

export function ensureTag(db: HubDb, name: string, color?: string | null): string {
  const n = name.trim().slice(0, 60);
  const found = db.prepare("SELECT id FROM tags WHERE lower(name) = lower(?)").get(n) as
    | { id: string }
    | undefined;
  if (found) return found.id;
  const id = hubId("tag");
  db.prepare("INSERT INTO tags(id,name,color,created_at) VALUES(?,?,?,?)").run(
    id,
    n,
    color ?? null,
    Date.now(),
  );
  return id;
}

export function tagSubject(
  db: HubDb,
  subjectType: SubjectType,
  subjectId: string,
  names: string[],
): void {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO taggings(tag_id,subject_type,subject_id,created_at) VALUES(?,?,?,?)",
  );
  for (const raw of names) {
    const n = str(raw);
    if (!n) continue;
    ins.run(ensureTag(db, n), subjectType, subjectId, Date.now());
  }
}

export function untagSubject(
  db: HubDb,
  subjectType: SubjectType,
  subjectId: string,
  names: string[],
): void {
  for (const n of names) {
    db.prepare(
      "DELETE FROM taggings WHERE subject_type = ? AND subject_id = ? AND tag_id IN (SELECT id FROM tags WHERE lower(name) = lower(?))",
    ).run(subjectType, subjectId, n);
  }
}

export function tagsFor(db: HubDb, subjectType: SubjectType, ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT g.subject_id AS sid, t.name AS name FROM taggings g JOIN tags t ON t.id = g.tag_id
         WHERE g.subject_type = ? AND g.subject_id IN (${chunk.map(() => "?").join(",")}) ORDER BY t.name`,
      )
      .all(subjectType, ...chunk) as Array<{ sid: string; name: string }>;
    for (const r of rows) {
      const list = out.get(r.sid) ?? [];
      list.push(r.name);
      out.set(r.sid, list);
    }
  }
  return out;
}

export function listTags(
  db: HubDb,
): Array<{ id: string; name: string; color: string | null; count: number }> {
  return db
    .prepare(
      `SELECT t.id, t.name, t.color, COUNT(g.tag_id) AS count FROM tags t
       LEFT JOIN taggings g ON g.tag_id = t.id GROUP BY t.id ORDER BY count DESC, t.name`,
    )
    .all() as Array<{ id: string; name: string; color: string | null; count: number }>;
}

// ── Companies ─────────────────────────────────────────────────────────────────

export type CompanyInput = {
  name?: string | null;
  domain?: string | null;
  website?: string | null;
  industry?: string | null;
  size?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  lat?: number | null;
  lon?: number | null;
  social?: Record<string, string>;
  custom?: Record<string, unknown>;
  clientId?: string | null;
  businessId?: string | null;
  tags?: string[];
};

export type UpsertOpts = {
  sourceId?: string | null;
  importBatchId?: string | null;
  legacyRef?: string | null;
  actor?: string | null;
  /** "fill" (default) only fills empty fields; "overwrite" replaces non-empty ones. */
  strategy?: "fill" | "overwrite";
  /** Skip creating; only match. */
  matchOnly?: boolean;
  defaultCountry?: string;
};

export function getCompany(db: HubDb, id: string): Company | null {
  const r = db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Row | undefined;
  if (!r) return null;
  const c = rowToCompany(r);
  c.tags = tagsFor(db, "company", [c.id]).get(c.id) ?? [];
  return c;
}

export function findCompanyMatch(db: HubDb, input: CompanyInput): Company | null {
  if (input.clientId) {
    const r = db.prepare("SELECT * FROM companies WHERE client_id = ?").get(input.clientId) as
      | Row
      | undefined;
    if (r) return rowToCompany(r);
  }
  const domain = registrableDomain(input.domain ?? input.website);
  if (domain && !isFreeMailDomain(domain)) {
    const r = db.prepare("SELECT * FROM companies WHERE domain = ?").get(domain) as Row | undefined;
    if (r) return rowToCompany(r);
  }
  const key = companyNameKey(input.name);
  if (key) {
    const candidates = db
      .prepare(
        "SELECT * FROM companies WHERE replace(replace(lower(name),' ',''),'''','') LIKE ? LIMIT 200",
      )
      .all(`%${key.replace(/ /g, "").slice(0, 3)}%`) as Row[];
    const city = str(input.city)?.toLowerCase() ?? null;
    for (const r of candidates) {
      if (companyNameKey(r.name) !== key) continue;
      const rc = (r.city as string | null)?.toLowerCase() ?? null;
      // Same name in a different known city is a different branch/business.
      if (city && rc && city !== rc) continue;
      if (domain && r.domain && r.domain !== domain) continue;
      return rowToCompany(r);
    }
  }
  return null;
}

const COMPANY_FIELDS: Array<[keyof CompanyInput, string]> = [
  ["name", "name"],
  ["website", "website"],
  ["industry", "industry"],
  ["size", "size"],
  ["phone", "phone"],
  ["address", "address"],
  ["city", "city"],
  ["region", "region"],
  ["country", "country"],
  ["lat", "lat"],
  ["lon", "lon"],
  ["clientId", "client_id"],
];

export function upsertCompany(
  db: HubDb,
  input: CompanyInput,
  opts: UpsertOpts = {},
): { company: Company; created: boolean } | null {
  const website = normalizeWebsite(input.website ?? input.domain);
  const domainRaw = registrableDomain(input.domain ?? input.website);
  const domain = domainRaw && !isFreeMailDomain(domainRaw) ? domainRaw : null;
  const name = str(input.name) ?? domain;
  if (!name) return null;
  const clean: CompanyInput = { ...input, name, website, domain };
  const now = Date.now();
  const existing = findCompanyMatch(db, clean);
  if (existing) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const cur = db.prepare("SELECT * FROM companies WHERE id = ?").get(existing.id) as Row;
    for (const [k, col] of COMPANY_FIELDS) {
      const v = clean[k];
      if (v === undefined || v === null || v === "") continue;
      if (k === "name" && opts.strategy !== "overwrite") continue;
      if (opts.strategy === "overwrite" || cur[col] === null || cur[col] === "") {
        if (cur[col] !== v) {
          sets.push(`${col} = ?`);
          vals.push(v);
        }
      }
    }
    if (domain && !cur.domain) {
      sets.push("domain = ?");
      vals.push(domain);
    }
    if (input.social && Object.keys(input.social).length) {
      sets.push("social = ?");
      vals.push(
        JSON.stringify({ ...input.social, ...parseJson<Record<string, string>>(cur.social, {}) }),
      );
    }
    if (input.custom && Object.keys(input.custom).length) {
      sets.push("custom = ?");
      vals.push(
        JSON.stringify({ ...parseJson<Record<string, unknown>>(cur.custom, {}), ...input.custom }),
      );
    }
    if (sets.length) {
      sets.push("updated_at = ?");
      vals.push(now, existing.id);
      db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    }
    if (input.tags?.length) tagSubject(db, "company", existing.id, input.tags);
    return { company: getCompany(db, existing.id)!, created: false };
  }
  if (opts.matchOnly) return null;
  const id = hubId("co");
  db.prepare(
    `INSERT INTO companies(id,business_id,name,domain,website,industry,size,phone,address,city,region,country,lat,lon,social,custom,client_id,source_id,import_batch_id,legacy_ref,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.businessId ?? null,
    name,
    domain,
    website,
    str(input.industry),
    str(input.size),
    str(input.phone),
    str(input.address),
    str(input.city),
    str(input.region),
    str(input.country),
    input.lat ?? null,
    input.lon ?? null,
    JSON.stringify(input.social ?? {}),
    JSON.stringify(input.custom ?? {}),
    input.clientId ?? null,
    opts.sourceId ?? null,
    opts.importBatchId ?? null,
    opts.legacyRef ?? null,
    now,
    now,
  );
  if (input.tags?.length) tagSubject(db, "company", id, input.tags);
  logActivity(db, {
    subjectType: "company",
    subjectId: id,
    type: "created",
    summary: `Company added: ${name}`,
    actor: opts.actor,
    data: { sourceId: opts.sourceId ?? null },
  });
  return { company: getCompany(db, id)!, created: true };
}

export type CompanyQuery = {
  search?: string;
  tag?: string;
  hasClient?: boolean;
  limit?: number;
  offset?: number;
};

export function listCompanies(
  db: HubDb,
  q: CompanyQuery = {},
): { companies: Company[]; total: number } {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.search) {
    where.push("(lower(name) LIKE ? OR domain LIKE ? OR lower(city) LIKE ?)");
    const s = `%${q.search.toLowerCase()}%`;
    p.push(s, s, s);
  }
  if (q.hasClient !== undefined)
    where.push(q.hasClient ? "client_id IS NOT NULL" : "client_id IS NULL");
  if (q.tag) {
    where.push(
      "id IN (SELECT g.subject_id FROM taggings g JOIN tags t ON t.id=g.tag_id WHERE g.subject_type='company' AND lower(t.name)=lower(?))",
    );
    p.push(q.tag);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM companies ${w}`).get(...p) as { n: number })
    .n;
  const rows = db
    .prepare(`SELECT * FROM companies ${w} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .all(...p, Math.min(q.limit ?? 50, 500), q.offset ?? 0) as Row[];
  const companies = rows.map(rowToCompany);
  const tags = tagsFor(
    db,
    "company",
    companies.map((c) => c.id),
  );
  for (const c of companies) c.tags = tags.get(c.id) ?? [];
  return { companies, total };
}

// ── Contacts ──────────────────────────────────────────────────────────────────

export type ContactInput = {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  companyId?: string | null;
  company?: CompanyInput | null;
  clientId?: string | null;
  lifecycle?: Lifecycle;
  score?: number;
  emailStatus?: EmailStatus;
  emailOptIn?: boolean;
  consentSource?: string | null;
  owner?: string | null;
  city?: string | null;
  country?: string | null;
  social?: Record<string, string>;
  custom?: Record<string, unknown>;
  firstCampaignId?: string | null;
  firstPageId?: string | null;
  businessId?: string | null;
  tags?: string[];
};

export function getContact(db: HubDb, id: string): Contact | null {
  const r = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
  if (!r) return null;
  const c = rowToContact(r);
  c.tags = tagsFor(db, "contact", [c.id]).get(c.id) ?? [];
  return c;
}

export function getContactByEmail(db: HubDb, email: string): Contact | null {
  const e = normalizeEmail(email);
  if (!e) return null;
  const r = db.prepare("SELECT * FROM contacts WHERE email = ?").get(e) as Row | undefined;
  return r ? rowToContact(r) : null;
}

export function findContactMatch(
  db: HubDb,
  input: {
    email?: string | null;
    phone?: string | null;
    name?: string | null;
    companyId?: string | null;
  },
  defaultCountry = "US",
): { contact: Contact; matchedBy: "email" | "phone" | "name" } | null {
  const email = normalizeEmail(input.email);
  if (email) {
    const r = db.prepare("SELECT * FROM contacts WHERE email = ?").get(email) as Row | undefined;
    if (r) return { contact: rowToContact(r), matchedBy: "email" };
  }
  const phone = normalizePhone(input.phone, defaultCountry);
  if (phone) {
    const r = db
      .prepare("SELECT * FROM contacts WHERE phone_e164 = ? ORDER BY created_at LIMIT 1")
      .get(phone) as Row | undefined;
    // Only match by phone when the emails do not contradict each other.
    if (r && (!email || !r.email)) return { contact: rowToContact(r), matchedBy: "phone" };
  }
  const name = str(input.name)?.toLowerCase();
  if (name && input.companyId && !email) {
    const r = db
      .prepare("SELECT * FROM contacts WHERE lower(name) = ? AND company_id = ? LIMIT 1")
      .get(name, input.companyId) as Row | undefined;
    if (r) return { contact: rowToContact(r), matchedBy: "name" };
  }
  return null;
}

const CONTACT_FIELDS: Array<[keyof ContactInput, string]> = [
  ["firstName", "first_name"],
  ["lastName", "last_name"],
  ["title", "title"],
  ["owner", "owner"],
  ["city", "city"],
  ["country", "country"],
  ["clientId", "client_id"],
  ["companyId", "company_id"],
];

const LIFECYCLE_RANK: Record<Lifecycle, number> = {
  subscriber: 0,
  lead: 1,
  qualified: 2,
  customer: 3,
  churned: 3,
};

export function upsertContact(
  db: HubDb,
  input: ContactInput,
  opts: UpsertOpts = {},
): { contact: Contact; created: boolean; matchedBy: "email" | "phone" | "name" | null } | null {
  const country = opts.defaultCountry ?? "US";
  const email = normalizeEmail(input.email);
  const phoneE164 = normalizePhone(input.phone, country);
  let first = str(input.firstName);
  let last = str(input.lastName);
  let name = str(input.name) ?? ([first, last].filter(Boolean).join(" ") || null);
  if (name && !first && !last) ({ first, last } = splitName(name));
  // Attach / create the company first so dedupe-by-name can use it.
  let companyId = input.companyId ?? null;
  if (!companyId && input.company) {
    const companyInput: CompanyInput = { ...input.company };
    const emailDomain = email ? registrableDomain(email) : null;
    const usableEmailDomain = emailDomain && !isFreeMailDomain(emailDomain) ? emailDomain : null;
    const named = Boolean(str(companyInput.name));
    // With no company name, the email domain IS the company. With a name, the
    // name wins: an email domain is only attached afterwards when no other
    // company already owns it (shared/agency domains must not merge companies).
    if (!named && !companyInput.domain && !companyInput.website && usableEmailDomain)
      companyInput.domain = usableEmailDomain;
    const co = upsertCompany(db, companyInput, opts);
    companyId = co?.company.id ?? null;
    if (
      co &&
      named &&
      !co.company.domain &&
      !companyInput.domain &&
      !companyInput.website &&
      usableEmailDomain
    ) {
      const owner = db
        .prepare("SELECT id FROM companies WHERE domain = ?")
        .get(usableEmailDomain) as { id: string } | undefined;
      if (!owner)
        db.prepare("UPDATE companies SET domain = ? WHERE id = ?").run(
          usableEmailDomain,
          co.company.id,
        );
    }
  }
  if (!name && !email && !phoneE164) return null;
  if (!name) name = email ? email.split("@")[0] : (phoneE164 ?? "");
  const now = Date.now();
  const match = findContactMatch(db, { email, phone: phoneE164, name, companyId }, country);
  if (match) {
    const cur = db.prepare("SELECT * FROM contacts WHERE id = ?").get(match.contact.id) as Row;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      if (cur[col] !== v) {
        sets.push(`${col} = ?`);
        vals.push(v);
      }
    };
    const overwrite = opts.strategy === "overwrite";
    const fill = (col: string, v: unknown) => {
      if (v === undefined || v === null || v === "") return;
      if (overwrite || cur[col] === null || cur[col] === "") set(col, v);
    };
    for (const [k, col] of CONTACT_FIELDS)
      fill(col, k === "companyId" ? companyId : (input[k] as unknown));
    if (overwrite || !cur.name || cur.name === (cur.email as string | null)?.split("@")[0])
      fill("name", str(input.name) ? name : null);
    if (email && !cur.email) set("email", email);
    if (phoneE164) {
      fill("phone", str(input.phone));
      fill("phone_e164", phoneE164);
    }
    if (
      input.lifecycle &&
      LIFECYCLE_RANK[input.lifecycle] > LIFECYCLE_RANK[cur.lifecycle as Lifecycle]
    )
      set("lifecycle", input.lifecycle);
    if (typeof input.score === "number" && input.score > Number(cur.score))
      set("score", Math.round(input.score));
    if (input.emailStatus && input.emailStatus !== "unknown" && cur.email_status !== "bounced")
      set("email_status", input.emailStatus);
    if (input.emailOptIn === true && !cur.email_opt_in) {
      set("email_opt_in", 1);
      set("consent_at", now);
      set("consent_source", input.consentSource ?? "form");
    }
    if (input.social && Object.keys(input.social).length)
      set(
        "social",
        JSON.stringify({ ...input.social, ...parseJson<Record<string, string>>(cur.social, {}) }),
      );
    if (input.custom && Object.keys(input.custom).length)
      set(
        "custom",
        JSON.stringify({ ...parseJson<Record<string, unknown>>(cur.custom, {}), ...input.custom }),
      );
    if (!cur.first_campaign_id && input.firstCampaignId)
      set("first_campaign_id", input.firstCampaignId);
    if (!cur.first_page_id && input.firstPageId) set("first_page_id", input.firstPageId);
    if (!cur.first_source_id && opts.sourceId) set("first_source_id", opts.sourceId);
    if (sets.length) {
      sets.push("updated_at = ?");
      vals.push(now, match.contact.id);
      db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    }
    if (input.tags?.length) tagSubject(db, "contact", match.contact.id, input.tags);
    return {
      contact: getContact(db, match.contact.id)!,
      created: false,
      matchedBy: match.matchedBy,
    };
  }
  if (opts.matchOnly) return null;
  const id = hubId("ct");
  const optIn = input.emailOptIn === true;
  db.prepare(
    `INSERT INTO contacts(id,business_id,name,first_name,last_name,email,phone,phone_e164,title,company_id,client_id,lifecycle,score,email_status,email_opt_in,consent_at,consent_source,owner,city,country,social,custom,first_source_id,first_campaign_id,first_page_id,import_batch_id,legacy_ref,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.businessId ?? null,
    name,
    first,
    last,
    email,
    str(input.phone),
    phoneE164,
    str(input.title),
    companyId,
    input.clientId ?? null,
    input.lifecycle ?? "lead",
    Math.round(input.score ?? 0),
    input.emailStatus ?? "unknown",
    optIn ? 1 : 0,
    optIn ? now : null,
    optIn ? (input.consentSource ?? "form") : null,
    str(input.owner),
    str(input.city),
    str(input.country),
    JSON.stringify(input.social ?? {}),
    JSON.stringify(input.custom ?? {}),
    opts.sourceId ?? null,
    input.firstCampaignId ?? null,
    input.firstPageId ?? null,
    opts.importBatchId ?? null,
    opts.legacyRef ?? null,
    now,
    now,
  );
  if (input.tags?.length) tagSubject(db, "contact", id, input.tags);
  logActivity(db, {
    subjectType: "contact",
    subjectId: id,
    type: "created",
    summary: `Contact added: ${name}`,
    actor: opts.actor,
    data: { sourceId: opts.sourceId ?? null },
  });
  return { contact: getContact(db, id)!, created: true, matchedBy: null };
}

export function updateContact(
  db: HubDb,
  id: string,
  patch: ContactInput,
  actor?: string | null,
): Contact {
  const cur = getContact(db, id);
  if (!cur) throw new Error(`contact not found: ${id}`);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.name !== undefined) set("name", str(patch.name) ?? cur.name);
  if (patch.firstName !== undefined) set("first_name", str(patch.firstName));
  if (patch.lastName !== undefined) set("last_name", str(patch.lastName));
  if (patch.email !== undefined) {
    const e = patch.email === null || patch.email === "" ? null : normalizeEmail(patch.email);
    if (patch.email && !e) throw new Error("invalid email");
    if (e && e !== cur.email) {
      const other = getContactByEmail(db, e);
      if (other && other.id !== id)
        throw new Error(`email already belongs to contact ${other.id} — merge them instead`);
    }
    set("email", e);
  }
  if (patch.phone !== undefined) {
    set("phone", str(patch.phone));
    set("phone_e164", normalizePhone(patch.phone));
  }
  if (patch.title !== undefined) set("title", str(patch.title));
  if (patch.companyId !== undefined) set("company_id", patch.companyId);
  if (patch.clientId !== undefined) set("client_id", patch.clientId);
  if (patch.lifecycle !== undefined) {
    if (!LIFECYCLES.includes(patch.lifecycle))
      throw new Error(`invalid lifecycle: ${patch.lifecycle}`);
    set("lifecycle", patch.lifecycle);
  }
  if (patch.score !== undefined) set("score", Math.max(0, Math.min(100, Math.round(patch.score))));
  if (patch.emailStatus !== undefined) set("email_status", patch.emailStatus);
  if (patch.emailOptIn !== undefined) {
    set("email_opt_in", patch.emailOptIn ? 1 : 0);
    set("consent_at", patch.emailOptIn ? Date.now() : null);
    set("consent_source", patch.emailOptIn ? (patch.consentSource ?? "manual") : null);
  }
  if (patch.owner !== undefined) set("owner", str(patch.owner));
  if (patch.city !== undefined) set("city", str(patch.city));
  if (patch.country !== undefined) set("country", str(patch.country));
  if (patch.social !== undefined) set("social", JSON.stringify(patch.social ?? {}));
  if (patch.custom !== undefined) set("custom", JSON.stringify({ ...cur.custom, ...patch.custom }));
  if (sets.length) {
    set("updated_at", Date.now());
    vals.push(id);
    db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    const changed = Object.keys(patch).filter((k) => k !== "tags");
    if (changed.length)
      logActivity(db, {
        subjectType: "contact",
        subjectId: id,
        type: "updated",
        summary: `Updated ${changed.join(", ")}`,
        actor,
        data: { fields: changed },
      });
  }
  if (patch.tags) {
    const current = new Set(cur.tags ?? []);
    const next = new Set(patch.tags);
    untagSubject(
      db,
      "contact",
      id,
      [...current].filter((t) => !next.has(t)),
    );
    tagSubject(
      db,
      "contact",
      id,
      [...next].filter((t) => !current.has(t)),
    );
  }
  return getContact(db, id)!;
}

export type ContactQuery = {
  search?: string;
  lifecycle?: Lifecycle | Lifecycle[];
  tag?: string;
  companyId?: string;
  clientId?: string;
  sourceId?: string;
  campaignId?: string;
  hasEmail?: boolean;
  emailStatus?: EmailStatus;
  minScore?: number;
  ids?: string[];
  sort?: "recent" | "score" | "name" | "activity";
  limit?: number;
  offset?: number;
};

export function contactWhere(q: ContactQuery): { where: string; params: unknown[] } {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.search) {
    where.push(
      "(lower(c.name) LIKE ? OR c.email LIKE ? OR c.phone_e164 LIKE ? OR c.company_id IN (SELECT id FROM companies WHERE lower(name) LIKE ?))",
    );
    const s = `%${q.search.toLowerCase()}%`;
    p.push(s, s, `%${q.search.replace(/\D/g, "") || "~"}%`, s);
  }
  if (q.lifecycle) {
    const l = Array.isArray(q.lifecycle) ? q.lifecycle : [q.lifecycle];
    where.push(`c.lifecycle IN (${l.map(() => "?").join(",")})`);
    p.push(...l);
  }
  if (q.tag) {
    where.push(
      "c.id IN (SELECT g.subject_id FROM taggings g JOIN tags t ON t.id=g.tag_id WHERE g.subject_type='contact' AND lower(t.name)=lower(?))",
    );
    p.push(q.tag);
  }
  if (q.companyId) {
    where.push("c.company_id = ?");
    p.push(q.companyId);
  }
  if (q.clientId) {
    where.push(
      "(c.client_id = ? OR c.company_id IN (SELECT id FROM companies WHERE client_id = ?))",
    );
    p.push(q.clientId, q.clientId);
  }
  if (q.sourceId) {
    where.push("c.first_source_id = ?");
    p.push(q.sourceId);
  }
  if (q.campaignId) {
    where.push("c.first_campaign_id = ?");
    p.push(q.campaignId);
  }
  if (q.hasEmail !== undefined) where.push(q.hasEmail ? "c.email IS NOT NULL" : "c.email IS NULL");
  if (q.emailStatus) {
    where.push("c.email_status = ?");
    p.push(q.emailStatus);
  }
  if (q.minScore !== undefined) {
    where.push("c.score >= ?");
    p.push(q.minScore);
  }
  if (q.ids?.length) {
    where.push(`c.id IN (${q.ids.map(() => "?").join(",")})`);
    p.push(...q.ids);
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params: p };
}

export function listContacts(
  db: HubDb,
  q: ContactQuery = {},
): { contacts: Array<Contact & { companyName: string | null }>; total: number } {
  const { where, params } = contactWhere(q);
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM contacts c ${where}`).get(...params) as { n: number }
  ).n;
  const order =
    q.sort === "score"
      ? "c.score DESC, c.updated_at DESC"
      : q.sort === "name"
        ? "lower(c.name)"
        : q.sort === "activity"
          ? "COALESCE(c.last_activity_at, c.created_at) DESC"
          : "c.created_at DESC";
  const rows = db
    .prepare(
      `SELECT c.*, co.name AS company_name FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(q.limit ?? 50, 1000), q.offset ?? 0) as Row[];
  const contacts = rows.map((r) => ({
    ...rowToContact(r),
    companyName: (r.company_name as string) ?? null,
  }));
  const tags = tagsFor(
    db,
    "contact",
    contacts.map((c) => c.id),
  );
  for (const c of contacts) c.tags = tags.get(c.id) ?? [];
  return { contacts, total };
}

export function deleteContact(db: HubDb, id: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM taggings WHERE subject_type='contact' AND subject_id = ?").run(id);
    db.prepare("DELETE FROM activities WHERE subject_type='contact' AND subject_id = ?").run(id);
    db.prepare("DELETE FROM email_enrollments WHERE contact_id = ?").run(id);
    db.prepare("UPDATE deals SET contact_id = NULL WHERE contact_id = ?").run(id);
    db.prepare("UPDATE revenue_txns SET contact_id = NULL WHERE contact_id = ?").run(id);
    db.prepare("UPDATE visitors SET contact_id = NULL WHERE contact_id = ?").run(id);
    db.prepare("UPDATE track_events SET contact_id = NULL WHERE contact_id = ?").run(id);
    db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
  })();
}

/**
 * Merge `loserId` into `winnerId`: fills the winner's empty fields from the
 * loser, re-points every reference (deals, activities, tags, sends,
 * enrollments, ledger, visitors, events), deletes the loser and logs it.
 */
export function mergeContacts(
  db: HubDb,
  winnerId: string,
  loserId: string,
  actor?: string | null,
): Contact {
  if (winnerId === loserId) throw new Error("cannot merge a contact into itself");
  const w = db.prepare("SELECT * FROM contacts WHERE id = ?").get(winnerId) as Row | undefined;
  const l = db.prepare("SELECT * FROM contacts WHERE id = ?").get(loserId) as Row | undefined;
  if (!w || !l) throw new Error("contact not found");
  db.transaction(() => {
    const fillCols = [
      "first_name",
      "last_name",
      "phone",
      "phone_e164",
      "title",
      "company_id",
      "client_id",
      "owner",
      "city",
      "country",
      "first_source_id",
      "first_campaign_id",
      "first_page_id",
      "consent_at",
      "consent_source",
    ];
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const col of fillCols) {
      if ((w[col] === null || w[col] === "") && l[col] !== null && l[col] !== "") {
        sets.push(`${col} = ?`);
        vals.push(l[col]);
      }
    }
    // email is unique: free the loser's first.
    const loserEmail = l.email as string | null;
    if (!w.email && loserEmail)
      db.prepare("UPDATE contacts SET email = NULL WHERE id = ?").run(loserId);
    if (!w.email && loserEmail) {
      sets.push("email = ?");
      vals.push(loserEmail);
    }
    if (LIFECYCLE_RANK[l.lifecycle as Lifecycle] > LIFECYCLE_RANK[w.lifecycle as Lifecycle]) {
      sets.push("lifecycle = ?");
      vals.push(l.lifecycle);
    }
    sets.push(
      "score = ?",
      "email_opt_in = ?",
      "social = ?",
      "custom = ?",
      "created_at = ?",
      "updated_at = ?",
    );
    vals.push(
      Math.max(Number(w.score), Number(l.score)),
      w.email_opt_in || l.email_opt_in ? 1 : 0,
      JSON.stringify({ ...parseJson(l.social, {}), ...parseJson(w.social, {}) }),
      JSON.stringify({ ...parseJson(l.custom, {}), ...parseJson(w.custom, {}) }),
      Math.min(Number(w.created_at), Number(l.created_at)),
      Date.now(),
    );
    db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...vals, winnerId);
    db.prepare("UPDATE deals SET contact_id = ? WHERE contact_id = ?").run(winnerId, loserId);
    db.prepare(
      "UPDATE activities SET subject_id = ? WHERE subject_type='contact' AND subject_id = ?",
    ).run(winnerId, loserId);
    db.prepare(
      "INSERT OR IGNORE INTO taggings(tag_id,subject_type,subject_id,created_at) SELECT tag_id,subject_type,?,created_at FROM taggings WHERE subject_type='contact' AND subject_id = ?",
    ).run(winnerId, loserId);
    db.prepare("DELETE FROM taggings WHERE subject_type='contact' AND subject_id = ?").run(loserId);
    db.prepare("UPDATE email_sends SET contact_id = ? WHERE contact_id = ?").run(winnerId, loserId);
    db.prepare(
      "DELETE FROM email_enrollments WHERE contact_id = ? AND email_campaign_id IN (SELECT email_campaign_id FROM email_enrollments WHERE contact_id = ?)",
    ).run(loserId, winnerId);
    db.prepare("UPDATE email_enrollments SET contact_id = ? WHERE contact_id = ?").run(
      winnerId,
      loserId,
    );
    db.prepare("UPDATE revenue_txns SET contact_id = ? WHERE contact_id = ?").run(
      winnerId,
      loserId,
    );
    db.prepare("UPDATE revenue_subscriptions SET contact_id = ? WHERE contact_id = ?").run(
      winnerId,
      loserId,
    );
    db.prepare("UPDATE visitors SET contact_id = ? WHERE contact_id = ?").run(winnerId, loserId);
    db.prepare("UPDATE track_events SET contact_id = ? WHERE contact_id = ?").run(
      winnerId,
      loserId,
    );
    db.prepare("UPDATE leadgen_results SET contact_id = ? WHERE contact_id = ?").run(
      winnerId,
      loserId,
    );
    db.prepare("DELETE FROM contacts WHERE id = ?").run(loserId);
    logActivity(db, {
      subjectType: "contact",
      subjectId: winnerId,
      type: "merge",
      summary: `Merged duplicate ${coerceString(l.name || l.email || loserId)}`,
      actor,
      data: { loserId, loserEmail, loserName: l.name },
    });
  })();
  return getContact(db, winnerId)!;
}

export function mergeCompanies(
  db: HubDb,
  winnerId: string,
  loserId: string,
  actor?: string | null,
): Company {
  if (winnerId === loserId) throw new Error("cannot merge a company into itself");
  const w = db.prepare("SELECT * FROM companies WHERE id = ?").get(winnerId) as Row | undefined;
  const l = db.prepare("SELECT * FROM companies WHERE id = ?").get(loserId) as Row | undefined;
  if (!w || !l) throw new Error("company not found");
  db.transaction(() => {
    const cols = [
      "website",
      "industry",
      "size",
      "phone",
      "address",
      "city",
      "region",
      "country",
      "lat",
      "lon",
    ];
    for (const col of cols) {
      if ((w[col] === null || w[col] === "") && l[col] !== null && l[col] !== "")
        db.prepare(`UPDATE companies SET ${col} = ? WHERE id = ?`).run(l[col], winnerId);
    }
    if (!w.domain && l.domain) {
      db.prepare("UPDATE companies SET domain = NULL WHERE id = ?").run(loserId);
      db.prepare("UPDATE companies SET domain = ? WHERE id = ?").run(l.domain, winnerId);
    }
    if (!w.client_id && l.client_id) {
      db.prepare("UPDATE companies SET client_id = NULL WHERE id = ?").run(loserId);
      db.prepare("UPDATE companies SET client_id = ? WHERE id = ?").run(l.client_id, winnerId);
    }
    db.prepare("UPDATE contacts SET company_id = ? WHERE company_id = ?").run(winnerId, loserId);
    db.prepare("UPDATE deals SET company_id = ? WHERE company_id = ?").run(winnerId, loserId);
    db.prepare(
      "UPDATE activities SET subject_id = ? WHERE subject_type='company' AND subject_id = ?",
    ).run(winnerId, loserId);
    db.prepare(
      "INSERT OR IGNORE INTO taggings(tag_id,subject_type,subject_id,created_at) SELECT tag_id,subject_type,?,created_at FROM taggings WHERE subject_type='company' AND subject_id = ?",
    ).run(winnerId, loserId);
    db.prepare("DELETE FROM taggings WHERE subject_type='company' AND subject_id = ?").run(loserId);
    db.prepare("UPDATE leadgen_results SET company_id = ? WHERE company_id = ?").run(
      winnerId,
      loserId,
    );
    db.prepare("DELETE FROM companies WHERE id = ?").run(loserId);
    db.prepare("UPDATE companies SET updated_at = ? WHERE id = ?").run(Date.now(), winnerId);
    logActivity(db, {
      subjectType: "company",
      subjectId: winnerId,
      type: "merge",
      summary: `Merged duplicate ${String(l.name)}`,
      actor,
      data: { loserId },
    });
  })();
  return getCompany(db, winnerId)!;
}

/** Likely duplicate contact pairs (same phone or same name at the same company). */
export function findDuplicateContacts(
  db: HubDb,
  limit = 50,
): Array<{ a: Contact; b: Contact; reason: string }> {
  const out: Array<{ a: Contact; b: Contact; reason: string }> = [];
  const byPhone = db
    .prepare(
      `SELECT a.id AS a, b.id AS b FROM contacts a JOIN contacts b ON a.phone_e164 = b.phone_e164 AND a.id < b.id
       WHERE a.phone_e164 IS NOT NULL LIMIT ?`,
    )
    .all(limit) as Array<{ a: string; b: string }>;
  for (const r of byPhone)
    out.push({ a: getContact(db, r.a)!, b: getContact(db, r.b)!, reason: "same phone" });
  const byName = db
    .prepare(
      `SELECT a.id AS a, b.id AS b FROM contacts a JOIN contacts b ON lower(a.name) = lower(b.name)
       AND COALESCE(a.company_id,'') = COALESCE(b.company_id,'') AND a.id < b.id
       WHERE a.name <> '' AND (a.email IS NULL OR b.email IS NULL) LIMIT ?`,
    )
    .all(limit) as Array<{ a: string; b: string }>;
  for (const r of byName)
    out.push({ a: getContact(db, r.a)!, b: getContact(db, r.b)!, reason: "same name" });
  return out.slice(0, limit);
}
