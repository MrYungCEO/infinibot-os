/**
 * Business hub email — segments: a JSON filter over contacts that reuses the
 * contact list's `ContactQuery` fields (lifecycle, tag, minScore, hasEmail,
 * sourceId, campaignId, emailStatus…) plus `tagsAny`, `excludeTags` and
 * `optedIn`. Campaigns snapshot a segment when they start.
 */

import {
  contactWhere,
  LIFECYCLES,
  listContacts,
  type ContactQuery,
  type EmailStatus,
  type Lifecycle,
} from "../contacts.js";
import type { HubDb } from "../db.js";
import { hubId, parseJson, str } from "../util.js";

export type SegmentFilter = {
  search?: string;
  lifecycle?: Lifecycle | Lifecycle[];
  tag?: string;
  /** Contact has any of these tags. */
  tagsAny?: string[];
  excludeTags?: string[];
  companyId?: string;
  sourceId?: string;
  campaignId?: string;
  hasEmail?: boolean;
  emailStatus?: EmailStatus;
  minScore?: number;
  optedIn?: boolean;
};

export type Segment = {
  id: string;
  name: string;
  filter: SegmentFilter;
  createdAt: number;
  updatedAt: number;
};

const EMAIL_STATUSES: EmailStatus[] = ["unknown", "valid", "risky", "invalid", "bounced"];

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => str(x))
    .filter((x): x is string => !!x)
    .slice(0, 50);
  return out.length ? out : undefined;
}

/** Keep only known, well-typed filter keys (input comes straight from the UI / agent). */
export function sanitizeFilter(raw: unknown): SegmentFilter {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const f: SegmentFilter = {};
  const s = (k: string) => str(r[k])?.slice(0, 200) ?? undefined;
  if (s("search")) f.search = s("search");
  if (typeof r.lifecycle === "string" && LIFECYCLES.includes(r.lifecycle as Lifecycle))
    f.lifecycle = r.lifecycle as Lifecycle;
  else if (Array.isArray(r.lifecycle)) {
    const l = r.lifecycle.filter((x): x is Lifecycle => LIFECYCLES.includes(x as Lifecycle));
    if (l.length) f.lifecycle = l;
  }
  if (s("tag")) f.tag = s("tag");
  const any = strList(r.tagsAny);
  if (any) f.tagsAny = any;
  const ex = strList(r.excludeTags);
  if (ex) f.excludeTags = ex;
  for (const k of ["companyId", "sourceId", "campaignId"] as const) if (s(k)) f[k] = s(k);
  if (typeof r.hasEmail === "boolean") f.hasEmail = r.hasEmail;
  if (typeof r.optedIn === "boolean") f.optedIn = r.optedIn;
  if (typeof r.emailStatus === "string" && EMAIL_STATUSES.includes(r.emailStatus as EmailStatus))
    f.emailStatus = r.emailStatus as EmailStatus;
  const ms = Number(r.minScore);
  if (r.minScore !== undefined && r.minScore !== null && Number.isFinite(ms)) f.minScore = ms;
  return f;
}

const TAG_SUB =
  "SELECT g.subject_id FROM taggings g JOIN tags t ON t.id=g.tag_id WHERE g.subject_type='contact' AND lower(t.name) IN";

/** SQL WHERE over `contacts c` for a segment filter. */
export function segmentWhere(filter: SegmentFilter): { where: string; params: unknown[] } {
  const q: ContactQuery = {
    search: filter.search,
    lifecycle: filter.lifecycle,
    tag: filter.tag,
    companyId: filter.companyId,
    sourceId: filter.sourceId,
    campaignId: filter.campaignId,
    hasEmail: filter.hasEmail,
    emailStatus: filter.emailStatus,
    minScore: filter.minScore,
  };
  const base = contactWhere(q);
  const extra: string[] = [];
  const params = [...base.params];
  if (filter.tagsAny?.length) {
    extra.push(`c.id IN (${TAG_SUB} (${filter.tagsAny.map(() => "lower(?)").join(",")}))`);
    params.push(...filter.tagsAny);
  }
  if (filter.excludeTags?.length) {
    extra.push(`c.id NOT IN (${TAG_SUB} (${filter.excludeTags.map(() => "lower(?)").join(",")}))`);
    params.push(...filter.excludeTags);
  }
  if (filter.optedIn !== undefined) extra.push(`c.email_opt_in = ${filter.optedIn ? 1 : 0}`);
  if (!extra.length) return { where: base.where, params };
  const where = base.where
    ? `${base.where} AND ${extra.join(" AND ")}`
    : `WHERE ${extra.join(" AND ")}`;
  return { where, params };
}

/** Contact ids matching a filter (snapshot for a campaign start). */
export function segmentContactIds(db: HubDb, filter: SegmentFilter, limit = 100_000): string[] {
  const { where, params } = segmentWhere(filter);
  return (
    db
      .prepare(`SELECT c.id FROM contacts c ${where} ORDER BY c.created_at LIMIT ?`)
      .all(...params, limit) as Array<{ id: string }>
  ).map((r) => r.id);
}

export function previewSegment(
  db: HubDb,
  filter: SegmentFilter,
  sampleSize = 10,
): {
  count: number;
  withEmail: number;
  optedIn: number;
  sample: Array<{ id: string; name: string; email: string | null; lifecycle: string }>;
} {
  const { where, params } = segmentWhere(filter);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN c.email IS NOT NULL THEN 1 ELSE 0 END) AS e,
              SUM(c.email_opt_in) AS o FROM contacts c ${where}`,
    )
    .get(...params) as { n: number; e: number | null; o: number | null };
  const sample = (
    db
      .prepare(
        `SELECT c.id, c.name, c.email, c.lifecycle FROM contacts c ${where} ORDER BY c.created_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(Math.max(sampleSize, 1), 100)) as Array<{
      id: string;
      name: string;
      email: string | null;
      lifecycle: string;
    }>
  ).map((r) => ({ ...r }));
  return { count: row.n, withEmail: row.e ?? 0, optedIn: row.o ?? 0, sample };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function rowToSegment(r: Row): Segment {
  return {
    id: r.id as string,
    name: r.name as string,
    filter: sanitizeFilter(parseJson(r.filter, {})),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function listSegments(db: HubDb): Array<Segment & { count: number }> {
  return (db.prepare("SELECT * FROM segments ORDER BY updated_at DESC").all() as Row[]).map((r) => {
    const s = rowToSegment(r);
    return { ...s, count: previewSegment(db, s.filter, 1).count };
  });
}

export function getSegment(db: HubDb, id: string): Segment | null {
  const r = db.prepare("SELECT * FROM segments WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToSegment(r) : null;
}

export function saveSegment(
  db: HubDb,
  input: { id?: string; name?: string; filter?: unknown },
): Segment {
  const now = Date.now();
  const cur = input.id ? getSegment(db, input.id) : null;
  if (input.id && !cur) throw new Error(`segment not found: ${input.id}`);
  const name = (str(input.name) ?? cur?.name ?? "").slice(0, 200);
  if (!name) throw new Error("name required");
  const filter = input.filter !== undefined ? sanitizeFilter(input.filter) : (cur?.filter ?? {});
  if (cur) {
    db.prepare("UPDATE segments SET name=?, filter=?, updated_at=? WHERE id=?").run(
      name,
      JSON.stringify(filter),
      now,
      cur.id,
    );
    return getSegment(db, cur.id)!;
  }
  const id = hubId("seg");
  db.prepare("INSERT INTO segments(id,name,filter,created_at,updated_at) VALUES(?,?,?,?,?)").run(
    id,
    name,
    JSON.stringify(filter),
    now,
    now,
  );
  return getSegment(db, id)!;
}

export function deleteSegment(db: HubDb, id: string): void {
  const used = db
    .prepare(
      "SELECT name FROM email_campaigns WHERE segment_id = ? AND status IN ('active','paused') LIMIT 1",
    )
    .get(id) as { name: string } | undefined;
  if (used) throw new Error(`segment is used by running campaign "${used.name}"`);
  db.prepare("DELETE FROM segments WHERE id = ?").run(id);
}

/** Convenience for the UI: list contacts in a segment (paged). */
export function segmentContacts(db: HubDb, filter: SegmentFilter, limit = 50, offset = 0) {
  const ids = segmentContactIds(db, filter, offset + limit).slice(offset);
  return listContacts(db, { ids: ids.length ? ids : ["~none~"], limit });
}
