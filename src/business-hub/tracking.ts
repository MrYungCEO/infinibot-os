/**
 * Business hub — landing-page tracking. Sites (public key, origin allowlist,
 * consent mode), one strict event schema, ingest (pages, visitors, UTM →
 * campaign, events — never an IP address), identity stitching (form submit /
 * identify / email-click contact token → contact; earlier anonymous events
 * are back-filled) and the stats behind the Tracking tab.
 *
 * Consent modes: "cookieless" (default; per-tab anon id, hashed server-side
 * with a daily-rotating salt so visitors cannot be followed across days),
 * "consent" (the snippet sends nothing until consent), "full" (first-party
 * localStorage anon id).
 */

import { createHmac, randomBytes } from "node:crypto";
import {
  ensureCampaignByUtm,
  ensureSource,
  logActivity,
  upsertContact,
  type SourceKind,
} from "./contacts.js";
import type { HubDb } from "./db.js";
import { fireHook, getTokenSecret, type BusinessHubHooks } from "./email/config.js";
import { verifyToken } from "./email/tokens.js";
import { hubId, normalizeEmail, parseJson, registrableDomain, str } from "./util.js";

export type ConsentMode = "cookieless" | "consent" | "full";
export const CONSENT_MODES: readonly ConsentMode[] = ["cookieless", "consent", "full"];

export type Site = {
  id: string;
  name: string;
  publicKey: string;
  origins: string[];
  consentMode: ConsentMode;
  funnelId: string | null;
  createdAt: number;
  updatedAt: number;
};

type Row = Record<string, unknown>;

function rowToSite(r: Row): Site {
  return {
    id: r.id as string,
    name: r.name as string,
    publicKey: r.public_key as string,
    origins: parseJson<string[]>(r.origins, []),
    consentMode: (r.consent_mode as ConsentMode) ?? "cookieless",
    funnelId: (r.funnel_id as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

// ── Sites ────────────────────────────────────────────────────────────────────

export function listSites(
  db: HubDb,
): Array<Site & { events7d: number; lastEventAt: number | null }> {
  const since = Date.now() - 7 * 86_400_000;
  return (db.prepare("SELECT * FROM sites ORDER BY created_at DESC").all() as Row[]).map((r) => {
    const s = rowToSite(r);
    const st = db
      .prepare(
        "SELECT SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS n, MAX(occurred_at) AS last FROM track_events WHERE site_id = ?",
      )
      .get(since, s.id) as { n: number | null; last: number | null };
    return { ...s, events7d: st.n ?? 0, lastEventAt: st.last ?? null };
  });
}

export function getSite(db: HubDb, id: string): Site | null {
  const r = db.prepare("SELECT * FROM sites WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToSite(r) : null;
}

export function getSiteByKey(db: HubDb, key: string): Site | null {
  const r = db.prepare("SELECT * FROM sites WHERE public_key = ?").get(key) as Row | undefined;
  return r ? rowToSite(r) : null;
}

/** Normalise an allowlist entry: full origin, bare host, or "*.host" wildcard. */
export function normalizeOriginPattern(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\/+$/, "");
  if (!s) return null;
  if (/^\*\.[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return s;
  if (/^https?:\/\//.test(s)) {
    try {
      const u = new URL(s);
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  }
  if (/^[a-z0-9.-]+(:\d+)?$/.test(s)) return s;
  return null;
}

export function originAllowed(patterns: string[], origin: string | null): boolean {
  if (!patterns.length) return true;
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const o = `${u.protocol}//${u.host}`.toLowerCase();
  const host = u.host.toLowerCase();
  const hostname = u.hostname.toLowerCase();
  return patterns.some((p) => {
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      return hostname === base || hostname.endsWith(`.${base}`);
    }
    if (p.includes("://")) return p === o;
    return p === host || p === hostname;
  });
}

const newKey = () => `pk_${randomBytes(15).toString("base64url")}`;

export function saveSite(
  db: HubDb,
  input: {
    id?: string;
    name?: string;
    origins?: string[];
    consentMode?: string;
    funnelId?: string | null;
    rotateKey?: boolean;
  },
): Site {
  const now = Date.now();
  const cur = input.id ? getSite(db, input.id) : null;
  if (input.id && !cur) throw new Error(`site not found: ${input.id}`);
  const name = (str(input.name) ?? cur?.name ?? "").slice(0, 120);
  if (!name) throw new Error("name required");
  let origins = cur?.origins ?? [];
  if (input.origins) {
    const bad = input.origins.filter((o) => !normalizeOriginPattern(o));
    if (bad.length) throw new Error(`invalid origin(s): ${bad.join(", ")}`);
    origins = [...new Set(input.origins.map((o) => normalizeOriginPattern(o)!))].slice(0, 50);
  }
  const consentMode = (input.consentMode ?? cur?.consentMode ?? "cookieless") as ConsentMode;
  if (!CONSENT_MODES.includes(consentMode))
    throw new Error(`consentMode must be one of ${CONSENT_MODES.join(", ")}`);
  const funnelId = input.funnelId !== undefined ? input.funnelId || null : (cur?.funnelId ?? null);
  if (cur) {
    db.prepare(
      "UPDATE sites SET name=?, origins=?, consent_mode=?, funnel_id=?, public_key=?, updated_at=? WHERE id=?",
    ).run(
      name,
      JSON.stringify(origins),
      consentMode,
      funnelId,
      input.rotateKey ? newKey() : cur.publicKey,
      now,
      cur.id,
    );
    return getSite(db, cur.id)!;
  }
  const id = hubId("site");
  db.prepare(
    "INSERT INTO sites(id,name,public_key,origins,consent_mode,funnel_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(id, name, newKey(), JSON.stringify(origins), consentMode, funnelId, now, now);
  return getSite(db, id)!;
}

/** Delete a site; its pages, visitors and events go with it unless keepData. */
export function deleteSite(db: HubDb, id: string, opts: { keepData?: boolean } = {}): void {
  db.transaction(() => {
    if (!opts.keepData) {
      db.prepare("DELETE FROM track_events WHERE site_id = ?").run(id);
      db.prepare("DELETE FROM visitors WHERE site_id = ?").run(id);
      db.prepare("DELETE FROM pages WHERE site_id = ?").run(id);
    }
    db.prepare("DELETE FROM sites WHERE id = ?").run(id);
  })();
}

// ── Event schema ─────────────────────────────────────────────────────────────

export const EVENT_TYPES = ["page_view", "form_submit", "click", "custom", "identify"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type Utm = {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
};

export type TrackEvent = {
  k: string;
  t: EventType;
  n?: string;
  u: string;
  r?: string;
  a: string;
  s: string;
  ts?: number;
  utm?: Utm;
  p?: Record<string, string | number | boolean>;
  e?: string;
  f?: Record<string, string | number | boolean>;
  /** Contact token from an email click (`ib_c`), for identity stitching. */
  ct?: string;
};

const ALLOWED_KEYS = new Set(["k", "t", "n", "u", "r", "a", "s", "ts", "utm", "p", "e", "f", "ct"]);
const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const PROP_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Field names never stored (credentials, card / identity numbers, hidden tokens). */
export const SENSITIVE_FIELD_RE =
  /pass|pwd|secret|token|csrf|xsrf|nonce|captcha|card|cc[-_]?(num|number|exp|cvc)|cvv|cvc|ssn|social[-_ ]?sec|iban|routing|account[-_ ]?(num|number)|tax[-_ ]?id|^pin$/i;

type Validated = { ok: true; ev: TrackEvent } | { ok: false; error: string };

function validScalarMap(
  v: unknown,
  maxKeys: number,
  maxLen: number,
  dropSensitive: boolean,
): Record<string, string | number | boolean> | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "must be an object";
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > maxKeys) return `at most ${maxKeys} keys`;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of entries) {
    if (!PROP_KEY_RE.test(k)) return `invalid key "${k.slice(0, 40)}"`;
    if (dropSensitive && SENSITIVE_FIELD_RE.test(k)) continue;
    if (typeof val === "string") {
      if (val.length > maxLen) return `value of "${k}" longer than ${maxLen}`;
      out[k] = val;
    } else if (typeof val === "boolean") out[k] = val;
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
    else return `value of "${k}" must be string, number or boolean`;
  }
  return out;
}

/** Strict validation of one event (unknown keys, bad types and oversize values are rejected). */
export function validateEvent(raw: unknown, now = Date.now()): Validated {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "event must be an object" };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (!ALLOWED_KEYS.has(k)) return { ok: false, error: `unknown field "${k.slice(0, 20)}"` };
  if (typeof r.k !== "string" || !/^pk_[A-Za-z0-9_-]{8,64}$/.test(r.k))
    return { ok: false, error: "invalid site key" };
  if (typeof r.t !== "string" || !(EVENT_TYPES as readonly string[]).includes(r.t))
    return { ok: false, error: "invalid type" };
  const t = r.t as EventType;
  if (typeof r.u !== "string" || r.u.length > 2048) return { ok: false, error: "invalid url" };
  try {
    const u = new URL(r.u);
    if (u.protocol !== "https:" && u.protocol !== "http:")
      return { ok: false, error: "invalid url" };
  } catch {
    return { ok: false, error: "invalid url" };
  }
  if (typeof r.a !== "string" || !ID_RE.test(r.a)) return { ok: false, error: "invalid anon id" };
  if (typeof r.s !== "string" || !ID_RE.test(r.s))
    return { ok: false, error: "invalid session id" };
  const ev: TrackEvent = { k: r.k, t, u: r.u, a: r.a, s: r.s };
  if (r.n !== undefined) {
    if (typeof r.n !== "string" || r.n.length > 200) return { ok: false, error: "invalid name" };
    ev.n = r.n;
  }
  if (r.r !== undefined && r.r !== "") {
    if (typeof r.r !== "string" || r.r.length > 2048)
      return { ok: false, error: "invalid referrer" };
    ev.r = r.r;
  }
  if (r.ts !== undefined) {
    if (typeof r.ts !== "number" || !Number.isFinite(r.ts))
      return { ok: false, error: "invalid ts" };
    // Client clocks drift; anything outside [-24h, +5min] is pinned to receipt time.
    ev.ts = r.ts < now - 86_400_000 || r.ts > now + 300_000 ? now : Math.round(r.ts);
  }
  if (r.utm !== undefined) {
    if (!r.utm || typeof r.utm !== "object" || Array.isArray(r.utm))
      return { ok: false, error: "invalid utm" };
    const utm: Utm = {};
    for (const [k, v] of Object.entries(r.utm as Record<string, unknown>)) {
      if (!(UTM_KEYS as readonly string[]).includes(k))
        return { ok: false, error: `invalid utm key "${k.slice(0, 20)}"` };
      if (typeof v !== "string" || v.length > 200) return { ok: false, error: `invalid utm.${k}` };
      if (v.trim()) utm[k as keyof Utm] = v.trim();
    }
    if (Object.keys(utm).length) ev.utm = utm;
  }
  if (r.p !== undefined) {
    const p = validScalarMap(r.p, 20, 256, false);
    if (typeof p === "string") return { ok: false, error: `props: ${p}` };
    ev.p = p;
  }
  if (r.e !== undefined) {
    if (t !== "form_submit" && t !== "identify")
      return { ok: false, error: "email only allowed on form_submit/identify" };
    if (typeof r.e !== "string" || r.e.length > 254) return { ok: false, error: "invalid email" };
    ev.e = r.e;
  }
  if (r.f !== undefined) {
    if (t !== "form_submit") return { ok: false, error: "fields only allowed on form_submit" };
    const f = validScalarMap(r.f, 30, 2000, true);
    if (typeof f === "string") return { ok: false, error: `fields: ${f}` };
    ev.f = f;
  }
  if (r.ct !== undefined) {
    if (typeof r.ct !== "string" || r.ct.length > 1024) return { ok: false, error: "invalid ct" };
    ev.ct = r.ct;
  }
  return { ok: true, ev };
}

// ── Attribution helpers ──────────────────────────────────────────────────────

const SEARCH =
  /(^|\.)(google|bing|duckduckgo|yahoo|baidu|yandex|ecosia|brave|startpage|naver|qwant)\./;
const SOCIAL =
  /(^|\.)(facebook|fb|instagram|linkedin|lnkd|twitter|t\.co|x|tiktok|youtube|youtu|reddit|pinterest|threads|snapchat|whatsapp|telegram|discord|mastodon|bsky)\./;
const SOCIAL_NAMES =
  /^(facebook|fb|instagram|ig|linkedin|twitter|x|tiktok|youtube|reddit|pinterest|threads|snapchat)$/i;

export function classifySource(
  utm: Utm | undefined,
  referrer: string | null | undefined,
  pageHost: string | null,
): { kind: SourceKind; name: string; utmSource: string | null; utmMedium: string | null } {
  const medium = utm?.medium?.toLowerCase() ?? null;
  const source = utm?.source?.toLowerCase() ?? null;
  let refHost: string | null = null;
  try {
    refHost = referrer ? new URL(referrer).hostname.toLowerCase() : null;
  } catch {
    refHost = null;
  }
  const refDomain = refHost ? registrableDomain(refHost) : null;
  const internal = !!refHost && !!pageHost && registrableDomain(pageHost) === refDomain;
  const name = source ?? (internal ? null : refDomain) ?? "direct";
  const out = (kind: SourceKind) => ({
    kind,
    name,
    utmSource: utm?.source ?? null,
    utmMedium: utm?.medium ?? null,
  });
  if (medium) {
    if (
      /^(cpc|ppc|paid|paid[-_ ]?(search|social)|display|cpm|cpv|ads?|retargeting|sem)$/.test(medium)
    )
      return out("paid");
    if (/^(e-?mail|newsletter)$/.test(medium)) return out("email");
    if (/social/.test(medium)) return out("social");
    if (/^(organic|seo)$/.test(medium)) return out("organic");
    if (medium === "referral") return out("referral");
  }
  if (source) {
    if (SOCIAL_NAMES.test(source)) return out("social");
    if (/^(google|bing|duckduckgo|yahoo)$/.test(source)) return out(medium ? "paid" : "organic");
    if (/^(e-?mail|newsletter)$/.test(source)) return out("email");
    return out("referral");
  }
  if (!refHost || internal) return out("direct");
  if (SEARCH.test(`${refHost}.`)) return out("organic");
  if (SOCIAL.test(`${refHost}.`)) return out("social");
  return out("referral");
}

function channelFor(kind: SourceKind): string {
  return kind === "paid"
    ? "paid"
    : kind === "email"
      ? "email"
      : kind === "social"
        ? "social"
        : "web";
}

function utmFromUrl(url: string): Utm | undefined {
  try {
    const sp = new URL(url).searchParams;
    const utm: Utm = {};
    for (const k of UTM_KEYS) {
      const v = sp.get(`utm_${k}`)?.trim();
      if (v) utm[k] = v.slice(0, 200);
    }
    return Object.keys(utm).length ? utm : undefined;
  } catch {
    return undefined;
  }
}

/** Daily-rotating visitor key for cookieless sites (no IP, no stable id across days). */
function cookielessAnon(db: HubDb, siteId: string, anon: string, ts: number): string {
  const day = new Date(ts).toISOString().slice(0, 10);
  return createHmac("sha256", getTokenSecret(db))
    .update(`visitor:${day}:${siteId}:${anon}`)
    .digest("base64url")
    .slice(0, 24);
}

// ── Form field mapping ───────────────────────────────────────────────────────

const FIELD_MAP: Array<[keyof FormContact, RegExp]> = [
  ["firstName", /^(first[_]?name|fname|first|given[_]?name)$/],
  ["lastName", /^(last[_]?name|lname|last|surname|family[_]?name)$/],
  ["name", /^(name|full[_]?name|your[_]?name|contact[_]?name)$/],
  ["phone", /^(phone|tel|telephone|mobile|cell|phone[_]?number|mobile[_]?number|whatsapp)$/],
  ["company", /^(company|company[_]?name|organi[sz]ation|business|business[_]?name|org)$/],
  ["title", /^(title|job[_]?title|position|role)$/],
  ["website", /^(website|site|url|company[_]?website|domain)$/],
  ["city", /^(city|town)$/],
];
const CONSENT_KEY = /(consent|opt[_]?in|subscribe|newsletter|marketing|gdpr|agree|permission)/;
const TRUTHY = /^(true|on|yes|y|1|checked|agree|accepted|granted)$/i;

type FormContact = {
  email: string | null;
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
  title?: string;
  website?: string;
  city?: string;
  optIn: boolean;
};

export function mapFormFields(
  fields: Record<string, string | number | boolean> | undefined,
  explicitEmail: string | undefined,
): FormContact {
  const out: FormContact = { email: normalizeEmail(explicitEmail), optIn: false };
  for (const [rawKey, rawVal] of Object.entries(fields ?? {})) {
    const key = rawKey
      .toLowerCase()
      .replace(/[\s.-]+/g, "_")
      .replace(/^(your|input|field)_/, "");
    const val = typeof rawVal === "string" ? rawVal.trim() : String(rawVal);
    if (!out.email && /e_?mail/.test(key)) out.email = normalizeEmail(val);
    if (CONSENT_KEY.test(key) && (rawVal === true || TRUTHY.test(val))) out.optIn = true;
    for (const [prop, re] of FIELD_MAP) {
      if (re.test(key) && val && out[prop] === undefined) {
        (out as Record<string, unknown>)[prop] = val.slice(0, 200);
        break;
      }
    }
  }
  if (!out.email)
    for (const v of Object.values(fields ?? {})) {
      const e = typeof v === "string" ? normalizeEmail(v) : null;
      if (e) {
        out.email = e;
        break;
      }
    }
  return out;
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export type IngestResult = {
  accepted: number;
  rejected: number;
  errors: string[];
  contactIds: string[];
  /** Origin to reflect in CORS (null when nothing was accepted from it). */
  allowedOrigin: string | null;
  /** True when a site with an empty allowlist accepted the event (UI warns). */
  originUnverified: boolean;
};

export type IngestOpts = {
  country?: string | null;
  now?: number;
  hooks?: BusinessHubHooks;
};

function pageFor(
  db: HubDb,
  siteId: string,
  url: string,
  title: string | null,
  now: number,
): string {
  let path = "/";
  try {
    path = new URL(url).pathname.slice(0, 512) || "/";
  } catch {
    /* validated earlier */
  }
  const found = db
    .prepare("SELECT id, title FROM pages WHERE site_id = ? AND path = ?")
    .get(siteId, path) as { id: string; title: string | null } | undefined;
  if (found) {
    if (title && title !== found.title)
      db.prepare("UPDATE pages SET title = ?, updated_at = ? WHERE id = ?").run(
        title.slice(0, 200),
        now,
        found.id,
      );
    return found.id;
  }
  const id = hubId("pg");
  db.prepare(
    "INSERT INTO pages(id,site_id,path,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  ).run(id, siteId, path, title?.slice(0, 200) ?? null, now, now);
  return id;
}

type VisitorRow = {
  id: string;
  contact_id: string | null;
  first_utm: string;
  first_referrer: string | null;
  first_page_id: string | null;
};

function visitorFor(
  db: HubDb,
  siteId: string,
  anonId: string,
  first: { utm?: Utm; referrer?: string; pageId: string },
  ts: number,
): VisitorRow {
  db.prepare(
    `INSERT INTO visitors(id,site_id,anon_id,first_seen_at,last_seen_at,first_utm,first_referrer,first_page_id)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(site_id, anon_id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
  ).run(
    hubId("vis"),
    siteId,
    anonId,
    ts,
    ts,
    JSON.stringify(first.utm ?? {}),
    first.referrer?.slice(0, 1000) ?? null,
    first.pageId,
  );
  return db
    .prepare("SELECT * FROM visitors WHERE site_id = ? AND anon_id = ?")
    .get(siteId, anonId) as VisitorRow;
}

/** Link a visitor to a contact and back-fill its anonymous events; logs the first page view once. */
export function stitchVisitor(db: HubDb, visitorId: string, contactId: string): number {
  db.prepare("UPDATE visitors SET contact_id = ? WHERE id = ?").run(contactId, visitorId);
  const n = db
    .prepare("UPDATE track_events SET contact_id = ? WHERE visitor_id = ? AND contact_id IS NULL")
    .run(contactId, visitorId).changes;
  const seen = db
    .prepare(
      "SELECT 1 FROM activities WHERE subject_type='contact' AND subject_id = ? AND type = 'page.viewed' LIMIT 1",
    )
    .get(contactId);
  if (!seen) {
    const first = db
      .prepare(
        "SELECT url, page_id, site_id, occurred_at FROM track_events WHERE visitor_id = ? AND type = 'page_view' ORDER BY occurred_at LIMIT 1",
      )
      .get(visitorId) as
      | { url: string; page_id: string; site_id: string; occurred_at: number }
      | undefined;
    if (first) {
      let path = first.url;
      try {
        path = new URL(first.url).pathname;
      } catch {
        /* keep url */
      }
      logActivity(db, {
        subjectType: "contact",
        subjectId: contactId,
        type: "page.viewed",
        summary: `First visit: ${path}`,
        data: { siteId: first.site_id, pageId: first.page_id, url: first.url, first: true },
        occurredAt: first.occurred_at,
      });
    }
  }
  return n;
}

function parseBody(body: unknown): unknown[] | null {
  let b = body;
  if (typeof b === "string" || Buffer.isBuffer(b)) {
    try {
      b = JSON.parse(String(b));
    } catch {
      return null;
    }
  }
  if (Array.isArray(b)) return b;
  if (b && typeof b === "object") {
    const events = (b as Record<string, unknown>).events;
    if (Array.isArray(events)) return events;
    return [b];
  }
  return null;
}

export const MAX_BATCH = 20;

/**
 * Validate + store a batch from the public collect endpoint. `origin` is the
 * request's Origin (or Referer origin). Never stores an IP; `country` is kept
 * only when an edge header supplied it.
 */
export function ingestEvents(
  db: HubDb,
  origin: string | null,
  body: unknown,
  opts: IngestOpts = {},
): IngestResult {
  const now = opts.now ?? Date.now();
  const res: IngestResult = {
    accepted: 0,
    rejected: 0,
    errors: [],
    contactIds: [],
    allowedOrigin: null,
    originUnverified: false,
  };
  const events = parseBody(body);
  if (!events) {
    res.rejected = 1;
    res.errors.push("body must be JSON: {events:[...]}");
    return res;
  }
  if (events.length > MAX_BATCH) {
    res.rejected = events.length;
    res.errors.push(`at most ${MAX_BATCH} events per request`);
    return res;
  }
  const country =
    opts.country && /^[A-Z]{2}$/.test(opts.country) && !["XX", "T1"].includes(opts.country)
      ? opts.country
      : null;
  const sites = new Map<string, Site | null>();
  const formHooks: Array<
    [string, { siteId: string; pageId: string | null; campaignId: string | null }]
  > = [];
  db.transaction(() => {
    for (const raw of events) {
      const v = validateEvent(raw, now);
      if (!v.ok) {
        res.rejected++;
        res.errors.push(v.error);
        continue;
      }
      const ev = v.ev;
      if (!sites.has(ev.k)) sites.set(ev.k, getSiteByKey(db, ev.k));
      const site = sites.get(ev.k);
      if (!site) {
        res.rejected++;
        res.errors.push("unknown site key");
        continue;
      }
      if (!originAllowed(site.origins, origin)) {
        res.rejected++;
        res.errors.push("origin not allowed");
        continue;
      }
      if (!site.origins.length) res.originUnverified = true;
      res.allowedOrigin = origin;
      const ts = ev.ts ?? now;
      const pageId = pageFor(db, site.id, ev.u, ev.t === "page_view" ? (ev.n ?? null) : null, now);
      const utm = ev.utm ?? utmFromUrl(ev.u);
      const anon = site.consentMode === "cookieless" ? cookielessAnon(db, site.id, ev.a, ts) : ev.a;
      const visitor = visitorFor(db, site.id, anon, { utm, referrer: ev.r, pageId }, ts);
      let pageHost: string | null = null;
      try {
        pageHost = new URL(ev.u).hostname;
      } catch {
        pageHost = null;
      }
      const src = classifySource(utm, ev.r, pageHost);
      const campaignId = utm?.campaign
        ? ensureCampaignByUtm(db, utm.campaign, channelFor(src.kind))
        : null;
      let contactId = visitor.contact_id;
      // Email click → landing page: the signed contact token identifies the visitor.
      if (ev.ct) {
        const tok = verifyToken(db, ev.ct, "c", now);
        if (tok && db.prepare("SELECT 1 FROM contacts WHERE id = ?").get(tok.c)) contactId = tok.c;
      }
      const props: Record<string, unknown> = { ...ev.p };
      if (country) props.geo_country = country;
      if (ev.t === "form_submit" && ev.f) props.form_fields = Object.keys(ev.f);
      const eventId = hubId("te");
      db.prepare(
        `INSERT INTO track_events(id,site_id,page_id,visitor_id,contact_id,session_id,type,name,url,referrer,
         utm_source,utm_medium,utm_campaign,utm_term,utm_content,campaign_id,props,occurred_at,received_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        eventId,
        site.id,
        pageId,
        visitor.id,
        contactId,
        ev.s,
        ev.t,
        ev.n ?? null,
        ev.u,
        ev.r ?? null,
        utm?.source ?? null,
        utm?.medium ?? null,
        utm?.campaign ?? null,
        utm?.term ?? null,
        utm?.content ?? null,
        campaignId,
        JSON.stringify(props),
        ts,
        now,
      );
      res.accepted++;
      // Identity stitching on form submit / identify.
      if (ev.t === "form_submit" || ev.t === "identify") {
        const fc = mapFormFields(ev.f, ev.e);
        if (fc.email) {
          const firstUtm = parseJson<Utm>(visitor.first_utm, {});
          const firstSrc = classifySource(
            Object.keys(firstUtm).length ? firstUtm : utm,
            visitor.first_referrer ?? ev.r,
            pageHost,
          );
          const sourceId = ensureSource(db, firstSrc.kind, firstSrc.name, {
            utmSource: firstSrc.utmSource,
            utmMedium: firstSrc.utmMedium,
          });
          const firstCampaignId = firstUtm.campaign
            ? ensureCampaignByUtm(db, firstUtm.campaign, channelFor(firstSrc.kind))
            : campaignId;
          const up = upsertContact(
            db,
            {
              email: fc.email,
              name: fc.name ?? null,
              firstName: fc.firstName ?? null,
              lastName: fc.lastName ?? null,
              phone: fc.phone ?? null,
              title: fc.title ?? null,
              city: fc.city ?? null,
              company:
                fc.company || fc.website
                  ? { name: fc.company ?? null, website: fc.website ?? null }
                  : null,
              lifecycle: "lead",
              emailOptIn: fc.optIn ? true : undefined,
              consentSource: `form:${site.name}`,
              firstCampaignId,
              firstPageId: visitor.first_page_id ?? pageId,
            },
            { sourceId, actor: "tracking" },
          );
          if (up) {
            contactId = up.contact.id;
            stitchVisitor(db, visitor.id, contactId);
            if (ev.t === "form_submit") {
              const fields: Record<string, string> = {};
              for (const [k, val] of Object.entries(ev.f ?? {}))
                fields[k] = String(val).slice(0, 300);
              logActivity(db, {
                subjectType: "contact",
                subjectId: contactId,
                type: "form.submitted",
                summary: `Submitted ${ev.n ? `"${ev.n.slice(0, 80)}"` : "a form"} on ${site.name}`,
                data: {
                  siteId: site.id,
                  pageId,
                  url: ev.u,
                  form: ev.n ?? null,
                  campaignId,
                  eventId,
                  fields,
                },
                occurredAt: ts,
              });
              formHooks.push([contactId, { siteId: site.id, pageId, campaignId }]);
            }
          }
        }
      } else if (contactId && contactId !== visitor.contact_id) {
        stitchVisitor(db, visitor.id, contactId);
      }
      if (contactId) res.contactIds.push(contactId);
    }
  })();
  for (const [cid, info] of formHooks) fireHook(opts.hooks, "onFormSubmitted", cid, info);
  res.contactIds = [...new Set(res.contactIds)];
  return res;
}

// ── Stats + event log ────────────────────────────────────────────────────────

export function trackingStats(
  db: HubDb,
  siteId: string | null | undefined,
  range: { from?: number; to?: number } = {},
) {
  const to = range.to ?? Date.now();
  const from = range.from ?? to - 30 * 86_400_000;
  const w = `e.occurred_at >= ? AND e.occurred_at <= ?${siteId ? " AND e.site_id = ?" : ""}`;
  const p: unknown[] = siteId ? [from, to, siteId] : [from, to];
  const totals = db
    .prepare(
      `SELECT SUM(CASE WHEN type='page_view' THEN 1 ELSE 0 END) AS views, COUNT(DISTINCT visitor_id) AS visitors,
              COUNT(DISTINCT session_id) AS sessions, SUM(CASE WHEN type='form_submit' THEN 1 ELSE 0 END) AS submits,
              COUNT(DISTINCT contact_id) AS contacts
       FROM track_events e WHERE ${w}`,
    )
    .get(...p) as Record<string, number | null>;
  const visitors = totals.visitors ?? 0;
  const submits = totals.submits ?? 0;
  const byPage = db
    .prepare(
      `SELECT pg.id AS pageId, pg.path, pg.title, s.name AS site,
              SUM(CASE WHEN e.type='page_view' THEN 1 ELSE 0 END) AS views, COUNT(DISTINCT e.visitor_id) AS visitors,
              SUM(CASE WHEN e.type='form_submit' THEN 1 ELSE 0 END) AS submits
       FROM track_events e JOIN pages pg ON pg.id = e.page_id LEFT JOIN sites s ON s.id = e.site_id
       WHERE ${w} GROUP BY pg.id ORDER BY views DESC LIMIT 50`,
    )
    .all(...p);
  const byUtm = db
    .prepare(
      `SELECT COALESCE(utm_source,'(none)') AS source, COALESCE(utm_medium,'(none)') AS medium,
              COALESCE(utm_campaign,'(none)') AS campaign, MAX(campaign_id) AS campaignId,
              COUNT(DISTINCT visitor_id) AS visitors, SUM(CASE WHEN type='page_view' THEN 1 ELSE 0 END) AS views,
              SUM(CASE WHEN type='form_submit' THEN 1 ELSE 0 END) AS submits
       FROM track_events e WHERE ${w} GROUP BY 1,2,3 ORDER BY visitors DESC LIMIT 100`,
    )
    .all(...p);
  const refRows = db
    .prepare(
      `SELECT referrer, COUNT(DISTINCT visitor_id) AS visitors, SUM(CASE WHEN type='form_submit' THEN 1 ELSE 0 END) AS submits
       FROM track_events e WHERE ${w} AND type IN ('page_view','form_submit') GROUP BY referrer LIMIT 5000`,
    )
    .all(...p) as Array<{ referrer: string | null; visitors: number; submits: number }>;
  const refMap = new Map<string, { domain: string; visitors: number; submits: number }>();
  for (const r of refRows) {
    let domain = "(direct)";
    try {
      domain = r.referrer
        ? (registrableDomain(new URL(r.referrer).hostname) ?? "(other)")
        : "(direct)";
    } catch {
      domain = "(other)";
    }
    const cur = refMap.get(domain) ?? { domain, visitors: 0, submits: 0 };
    cur.visitors += r.visitors;
    cur.submits += r.submits;
    refMap.set(domain, cur);
  }
  const daily = db
    .prepare(
      `SELECT date(e.occurred_at/1000,'unixepoch') AS day, SUM(CASE WHEN type='page_view' THEN 1 ELSE 0 END) AS views,
              COUNT(DISTINCT visitor_id) AS visitors, SUM(CASE WHEN type='form_submit' THEN 1 ELSE 0 END) AS submits
       FROM track_events e WHERE ${w} GROUP BY day ORDER BY day`,
    )
    .all(...p);
  const topContacts = db
    .prepare(
      `SELECT c.id, c.name, c.email, c.lifecycle, COUNT(*) AS events, MAX(e.occurred_at) AS lastSeenAt,
              SUM(CASE WHEN e.type='form_submit' THEN 1 ELSE 0 END) AS submits
       FROM track_events e JOIN contacts c ON c.id = e.contact_id WHERE ${w}
       GROUP BY c.id ORDER BY events DESC LIMIT 20`,
    )
    .all(...p);
  return {
    range: { from, to },
    siteId: siteId ?? null,
    pageViews: totals.views ?? 0,
    uniqueVisitors: visitors,
    sessions: totals.sessions ?? 0,
    formSubmits: submits,
    identifiedContacts: totals.contacts ?? 0,
    conversionRate: visitors ? Math.round((submits / visitors) * 10_000) / 10_000 : 0,
    byPage,
    byUtm,
    byReferrer: [...refMap.values()].sort((a, b) => b.visitors - a.visitors).slice(0, 50),
    daily,
    topContacts,
  };
}

export function listEvents(
  db: HubDb,
  q: { siteId?: string; contactId?: string; type?: string; before?: number; limit?: number } = {},
) {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.siteId) {
    where.push("e.site_id = ?");
    p.push(q.siteId);
  }
  if (q.contactId) {
    where.push("e.contact_id = ?");
    p.push(q.contactId);
  }
  if (q.type) {
    where.push("e.type = ?");
    p.push(q.type);
  }
  if (q.before) {
    where.push("e.occurred_at < ?");
    p.push(q.before);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return (
    db
      .prepare(
        `SELECT e.*, pg.path, c.name AS contact_name, c.email AS contact_email FROM track_events e
         LEFT JOIN pages pg ON pg.id = e.page_id LEFT JOIN contacts c ON c.id = e.contact_id
         ${w} ORDER BY e.occurred_at DESC LIMIT ?`,
      )
      .all(...p, Math.min(q.limit ?? 100, 500)) as Row[]
  ).map((r) => ({
    id: r.id as string,
    siteId: r.site_id as string,
    pageId: (r.page_id as string) ?? null,
    path: (r.path as string) ?? null,
    visitorId: (r.visitor_id as string) ?? null,
    contactId: (r.contact_id as string) ?? null,
    contactName: (r.contact_name as string) ?? null,
    contactEmail: (r.contact_email as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    type: r.type as string,
    name: (r.name as string) ?? null,
    url: (r.url as string) ?? null,
    referrer: (r.referrer as string) ?? null,
    utm: {
      source: (r.utm_source as string) ?? null,
      medium: (r.utm_medium as string) ?? null,
      campaign: (r.utm_campaign as string) ?? null,
      term: (r.utm_term as string) ?? null,
      content: (r.utm_content as string) ?? null,
    },
    campaignId: (r.campaign_id as string) ?? null,
    props: parseJson<Record<string, unknown>>(r.props, {}),
    occurredAt: r.occurred_at as number,
  }));
}
