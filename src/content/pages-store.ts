/**
 * ContentPagesStore — per-business content surfaces with child databases.
 *
 * Each Page is one social/blog/podcast surface. On create we provision five
 * generic databases (Scripts, Videos, Content, Ideas, Series) via the shared
 * `DatabasesStore` and store their ids on the Page row. Pages themselves
 * live in a dedicated `content_pages` table inside the same `databases.db`
 * file so the page record and its child rows are co-located in one db.
 *
 * Pages created before the Series child existed get it (and the Ideas
 * `Stage` / `Script` / `Content` properties) lazily via `ensureSeries`.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { getDatabasesStore, type DatabasesStore } from "../databases/store.js";
import type {
  ContentChildKind,
  ContentPage,
  ContentPageDatabaseIds,
  ContentPageInput,
  ContentPageIntegrations,
  ContentPageListFilter,
  ContentPagePatch,
  ContentPageStats,
  ContentSurface,
} from "./types.js";
import { CONTENT_CHILD_KINDS, CONTENT_STAGES } from "./types.js";
import type {
  DatabaseProperty,
  DatabaseRow,
  PropertyConfig,
  PropertyType,
  PropertyValue,
} from "../databases/types.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

let _stateDir: string | null = null;
let _initializedFor: string | null = null;

function resolveStateDir(stateDir?: string): string {
  return stateDir || process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
}

export function getContentPagesStore(stateDir?: string): ContentPagesStore {
  const dir = resolveStateDir(stateDir);
  _stateDir = dir;
  const databases = getDatabasesStore(dir);
  const handle = (databases as unknown as { db?: Database.Database }).db;
  if (!handle) {
    throw new Error("databases store did not expose its sqlite handle");
  }
  if (_initializedFor !== dir) {
    _initializedFor = dir;
    ensureSchema(handle);
  }
  return new ContentPagesStore(handle, databases);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_pages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      surface TEXT NOT NULL,
      handle TEXT,
      url TEXT,
      business_id TEXT NOT NULL,
      owner_agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      theme_json TEXT,
      goals_json TEXT,
      links_json TEXT NOT NULL DEFAULT '{}',
      database_ids_json TEXT NOT NULL DEFAULT '{}',
      stats_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_content_pages_business ON content_pages(business_id);
    CREATE INDEX IF NOT EXISTS idx_content_pages_status ON content_pages(status);
    CREATE INDEX IF NOT EXISTS idx_content_pages_surface ON content_pages(surface);
  `);
  // Migrate: add integrations + features columns if not present (idempotent)
  try {
    db.exec(`ALTER TABLE content_pages ADD COLUMN integrations_json TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    /* column already exists */
  }
  try {
    db.exec(`ALTER TABLE content_pages ADD COLUMN features_json TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    /* column already exists */
  }
}

// ═══════════════════════════════════════════════════════════════════
// CHILD DATABASE PROVISIONING
// ═══════════════════════════════════════════════════════════════════

/** Stage pipeline properties on Ideas (added lazily to older pages). */
const IDEA_STAGE_PROPS: ChildPropSpec[] = [
  { name: "Stage", type: "status", config: { options: CONTENT_STAGES.map((s) => ({ ...s })) } },
  { name: "Script", type: "relation" },
  { name: "Content", type: "relation" },
];

type ChildPropSpec = { name: string; type: PropertyType; config?: PropertyConfig | null };

const CHILD_DB_SPECS: Record<
  ContentChildKind,
  {
    label: string;
    icon: string;
    description: string;
    /** Name of the leading status property (default "Status"). */
    statusName?: string;
    statusOptions: Array<{ id: string; name: string; color: string }>;
    extraProps: ChildPropSpec[];
  }
> = {
  scripts: {
    label: "Scripts",
    icon: "📝",
    description: "Scripts (hooks, bodies, outlines) for a content page.",
    statusOptions: [
      { id: "cold", name: "Cold", color: "#6b7280" },
      { id: "draft", name: "Draft", color: "#3b82f6" },
      { id: "ready", name: "Ready", color: "#a855f7" },
      { id: "published", name: "Published", color: "#10b981" },
    ],
    extraProps: [
      { name: "Hook", type: "richText" },
      { name: "Body", type: "richText" },
      { name: "Target Length (sec)", type: "number" },
      { name: "Associated Video", type: "relation" },
    ],
  },
  videos: {
    label: "Videos",
    icon: "🎬",
    description: "Produced video assets — file, thumbnail, performance.",
    statusOptions: [
      { id: "planning", name: "Planning", color: "#6b7280" },
      { id: "shooting", name: "Shooting", color: "#3b82f6" },
      { id: "editing", name: "Editing", color: "#a855f7" },
      { id: "scheduled", name: "Scheduled", color: "#f59e0b" },
      { id: "published", name: "Published", color: "#10b981" },
    ],
    extraProps: [
      { name: "Script", type: "relation" },
      { name: "Duration (sec)", type: "number" },
      { name: "File URL", type: "url" },
      { name: "Thumbnail URL", type: "url" },
      { name: "Published At", type: "date" },
      { name: "Platform URL", type: "url" },
      { name: "Views", type: "number" },
      { name: "Engagement", type: "number" },
    ],
  },
  content: {
    label: "Content",
    icon: "📰",
    description: "Posts, articles, captions, shorts — anything published.",
    statusOptions: [
      { id: "idea", name: "Idea", color: "#6b7280" },
      { id: "draft", name: "Draft", color: "#3b82f6" },
      { id: "scheduled", name: "Scheduled", color: "#f59e0b" },
      { id: "published", name: "Published", color: "#10b981" },
      { id: "archived", name: "Archived", color: "#94a3b8" },
    ],
    extraProps: [
      { name: "Type", type: "select" },
      { name: "Body", type: "richText" },
      { name: "Published At", type: "date" },
      { name: "Scheduled For", type: "date" },
      { name: "Platform URL", type: "url" },
      { name: "Impressions", type: "number" },
      { name: "Reach", type: "number" },
      { name: "Engagement", type: "number" },
      { name: "CTR", type: "number" },
    ],
  },
  ideas: {
    label: "Ideas",
    icon: "💡",
    description: "Raw ideation backlog — promote to script / video / content.",
    statusOptions: [
      { id: "captured", name: "Captured", color: "#6b7280" },
      { id: "prioritized", name: "Prioritized", color: "#3b82f6" },
      { id: "promoted", name: "Promoted", color: "#10b981" },
      { id: "shelved", name: "Shelved", color: "#94a3b8" },
    ],
    extraProps: [
      { name: "Notes", type: "richText" },
      { name: "Source", type: "richText" },
      { name: "Prioritized", type: "checkbox" },
      { name: "Converted To", type: "select" },
      { name: "Converted At", type: "number" },
      ...IDEA_STAGE_PROPS,
    ],
  },
  series: {
    label: "Series",
    icon: "🎞️",
    description:
      "Episodes of a content series, ordered by season and episode, tracked idea → posted.",
    statusName: "Stage",
    statusOptions: CONTENT_STAGES,
    extraProps: [
      { name: "Series", type: "richText" },
      { name: "Season", type: "number" },
      { name: "Episode", type: "number" },
      { name: "Pain Point", type: "richText" },
      { name: "Hook", type: "richText" },
      { name: "What to Show", type: "richText" },
      { name: "Payoff", type: "richText" },
      { name: "Target Publish Date", type: "date" },
      { name: "Platform URL", type: "url" },
      { name: "Script", type: "relation" },
      { name: "Content", type: "relation" },
      { name: "Repurpose Note", type: "richText" },
      { name: "Notes", type: "richText" },
    ],
  },
};

function provisionChildDatabase(
  databases: DatabasesStore,
  page: { id: string; name: string },
  kind: ContentChildKind,
): string {
  const spec = CHILD_DB_SPECS[kind];
  const optionsConfig = {
    options:
      kind === "content"
        ? [
            { id: "post", name: "Post" },
            { id: "article", name: "Article" },
            { id: "email", name: "Email" },
            { id: "caption", name: "Caption" },
            { id: "short", name: "Short" },
            { id: "video", name: "Video" },
          ]
        : kind === "ideas"
          ? [
              { id: "script", name: "Script" },
              { id: "video", name: "Video" },
              { id: "content", name: "Content" },
            ]
          : [],
  };

  const props: ChildPropSpec[] = [
    { name: "Title", type: "title" },
    {
      name: spec.statusName ?? "Status",
      type: "status",
      config: { options: spec.statusOptions.map((o) => ({ ...o })) },
    },
  ];
  for (const p of spec.extraProps) {
    const config =
      p.config ??
      ((kind === "content" && p.name === "Type") || (kind === "ideas" && p.name === "Converted To")
        ? optionsConfig
        : null);
    props.push({ name: p.name, type: p.type, config });
  }

  const db = databases.createDatabase({
    name: `${page.name} — ${spec.label}`,
    icon: spec.icon,
    description: spec.description,
    meta: { contentPageId: page.id, contentChildKind: kind },
    properties: props,
  });
  return db.id;
}

function provisionChildDatabases(
  databases: DatabasesStore,
  page: { id: string; name: string },
): ContentPageDatabaseIds {
  const out: Partial<ContentPageDatabaseIds> = {};
  for (const kind of CONTENT_CHILD_KINDS) {
    out[kind] = provisionChildDatabase(databases, page, kind);
  }
  return out as ContentPageDatabaseIds;
}

/** Add any missing properties from `wanted` to an existing child database. */
function ensureChildProperties(
  databases: DatabasesStore,
  databaseId: string,
  wanted: ChildPropSpec[],
): void {
  const have = new Set(databases.listProperties(databaseId).map((p) => p.name.toLowerCase()));
  for (const p of wanted) {
    if (have.has(p.name.toLowerCase())) continue;
    databases.createProperty({ databaseId, name: p.name, type: p.type, config: p.config ?? null });
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAPPER
// ═══════════════════════════════════════════════════════════════════

function defaultStats(): ContentPageStats {
  return {
    followers: undefined,
    totalPosts: 0,
    monthlyPosts: 0,
    engagementRate: 0,
    reach30d: 0,
    impressions30d: 0,
    clicks30d: 0,
    conversions30d: 0,
    leadsAttributed: 0,
    reachSparkline: [],
    lastPublishedAt: null,
  };
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: Record<string, unknown>): ContentPage {
  return {
    id: row.id as string,
    name: row.name as string,
    surface: row.surface as ContentSurface,
    handle: (row.handle as string | null) ?? undefined,
    url: (row.url as string | null) ?? undefined,
    businessId: row.business_id as string,
    ownerAgentId: (row.owner_agent_id as string | null) ?? undefined,
    status: row.status as ContentPage["status"],
    theme: parseJson<ContentPage["theme"]>((row.theme_json as string | null) ?? null, undefined),
    goals: parseJson<ContentPage["goals"]>((row.goals_json as string | null) ?? null, undefined),
    links: {
      campaignIds: [],
      productIds: [],
      funnelIds: [],
      pageIds: [],
      ...parseJson<Partial<ContentPage["links"]>>(row.links_json as string, {}),
    },
    databaseIds: {
      scripts: "",
      videos: "",
      content: "",
      ideas: "",
      series: "",
      ...parseJson<Partial<ContentPageDatabaseIds>>(row.database_ids_json as string, {}),
    },
    stats: {
      ...defaultStats(),
      ...parseJson<Partial<ContentPageStats>>(row.stats_json as string, {}),
    },
    integrations: parseJson<ContentPageIntegrations>(
      (row.integrations_json as string | null) ?? null,
      {},
    ),
    features: parseJson<Record<string, Record<string, unknown>>>(
      (row.features_json as string | null) ?? null,
      {},
    ),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    deletedAt: (row.deleted_at as number | null) ?? null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════════

export class ContentPagesStore {
  constructor(
    private db: Database.Database,
    private databases: DatabasesStore,
  ) {}

  list(filter: ContentPageListFilter = {}): ContentPage[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeArchived) {
      clauses.push("(deleted_at IS NULL AND status != 'archived')");
    }
    if (filter.businessId) {
      clauses.push("business_id = ?");
      params.push(filter.businessId);
    }
    if (filter.surface) {
      clauses.push("surface = ?");
      params.push(filter.surface);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM content_pages ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  get(id: string): ContentPage | null {
    const row = this.db.prepare(`SELECT * FROM content_pages WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : null;
  }

  create(input: ContentPageInput): ContentPage {
    if (!input.businessId) throw new Error("businessId is required");
    if (!input.name) throw new Error("name is required");
    if (!input.surface) throw new Error("surface is required");

    const id = input.id || `page_${randomUUID()}`;
    const now = Date.now();
    const pageIds = this.validLinkTargets(id, input.links?.pageIds ?? []);
    const databaseIds = provisionChildDatabases(this.databases, { id, name: input.name });
    const links = {
      campaignIds: input.links?.campaignIds ?? [],
      productIds: input.links?.productIds ?? [],
      funnelIds: input.links?.funnelIds ?? [],
      leadDbId: input.links?.leadDbId,
      pageIds,
    };

    this.db
      .prepare(
        `INSERT INTO content_pages (
           id, name, surface, handle, url, business_id, owner_agent_id, status,
           theme_json, goals_json, links_json, database_ids_json, stats_json,
           created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.name,
        input.surface,
        input.handle ?? null,
        input.url ?? null,
        input.businessId,
        input.ownerAgentId ?? null,
        input.status ?? "draft",
        input.theme ? JSON.stringify(input.theme) : null,
        input.goals ? JSON.stringify(input.goals) : null,
        JSON.stringify(links),
        JSON.stringify(databaseIds),
        JSON.stringify(defaultStats()),
        now,
        now,
      );

    for (const other of pageIds) this.setBackLink(other, id, true);
    return this.get(id)!;
  }

  update(id: string, patch: ContentPagePatch): ContentPage | null {
    const existing = this.get(id);
    if (!existing) return null;
    const links = { ...existing.links, ...patch.links };
    if (patch.links?.pageIds !== undefined) {
      links.pageIds = this.validLinkTargets(id, patch.links.pageIds);
    }
    const next: ContentPage = {
      ...existing,
      ...patch,
      links,
      theme: patch.theme !== undefined ? patch.theme : existing.theme,
      goals: patch.goals !== undefined ? patch.goals : existing.goals,
      updatedAt: Date.now(),
    };

    this.db
      .prepare(
        `UPDATE content_pages SET
           name = ?, surface = ?, handle = ?, url = ?, owner_agent_id = ?, status = ?,
           theme_json = ?, goals_json = ?, links_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.surface,
        next.handle ?? null,
        next.url ?? null,
        next.ownerAgentId ?? null,
        next.status,
        next.theme ? JSON.stringify(next.theme) : null,
        next.goals ? JSON.stringify(next.goals) : null,
        JSON.stringify(next.links),
        next.updatedAt,
        id,
      );
    if (patch.links?.pageIds !== undefined) {
      const before = new Set(existing.links.pageIds);
      const after = new Set(links.pageIds);
      for (const other of after) if (!before.has(other)) this.setBackLink(other, id, true);
      for (const other of before) if (!after.has(other)) this.setBackLink(other, id, false);
    }
    return this.get(id);
  }

  /** Associate two pages (both directions). Idempotent. */
  linkPages(a: string, b: string): { a: ContentPage; b: ContentPage } | null {
    const pa = this.get(a);
    const pb = this.get(b);
    if (!pa || !pb || a === b) return null;
    if (!pa.links.pageIds.includes(b))
      this.update(a, { links: { pageIds: [...pa.links.pageIds, b] } });
    else this.setBackLink(b, a, true);
    return { a: this.get(a)!, b: this.get(b)! };
  }

  /** Remove the association between two pages (both directions). Idempotent. */
  unlinkPages(a: string, b: string): { a: ContentPage; b: ContentPage } | null {
    const pa = this.get(a);
    const pb = this.get(b);
    if (!pa || !pb) return null;
    this.update(a, { links: { pageIds: pa.links.pageIds.filter((x) => x !== b) } });
    this.setBackLink(b, a, false);
    return { a: this.get(a)!, b: this.get(b)! };
  }

  /** Pages associated with `page` (missing / deleted ids are skipped). */
  linkedPages(page: ContentPage): ContentPage[] {
    return page.links.pageIds
      .map((pid) => this.get(pid))
      .filter((p): p is ContentPage => Boolean(p && !p.deletedAt));
  }

  private validLinkTargets(selfId: string, ids: string[]): string[] {
    const out: string[] = [];
    for (const pid of ids) {
      if (typeof pid !== "string" || !pid || pid === selfId || out.includes(pid)) continue;
      if (!this.get(pid)) throw new Error(`linked page not found: ${pid}`);
      out.push(pid);
    }
    return out;
  }

  /** Write only `otherId`'s side of a link (no recursion). */
  private setBackLink(otherId: string, id: string, present: boolean): void {
    const other = this.get(otherId);
    if (!other) return;
    const has = other.links.pageIds.includes(id);
    if (has === present) return;
    const pageIds = present
      ? [...other.links.pageIds, id]
      : other.links.pageIds.filter((x) => x !== id);
    this.db
      .prepare(`UPDATE content_pages SET links_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ ...other.links, pageIds }), Date.now(), otherId);
  }

  /**
   * Make sure the page has a Series child database and that its Ideas
   * database carries the stage pipeline properties. Pages created before
   * series existed get them here, on first use. Idempotent.
   */
  ensureSeries(id: string): ContentPage | null {
    const page = this.get(id);
    if (!page) return null;
    let databaseIds = page.databaseIds;
    if (!databaseIds.series || !this.databases.getDatabase(databaseIds.series)) {
      databaseIds = {
        ...databaseIds,
        series: provisionChildDatabase(this.databases, page, "series"),
      };
      this.db
        .prepare(`UPDATE content_pages SET database_ids_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(databaseIds), Date.now(), id);
    } else {
      ensureChildProperties(this.databases, databaseIds.series, [
        { name: "Title", type: "title" },
        {
          name: "Stage",
          type: "status",
          config: { options: CONTENT_STAGES.map((s) => ({ ...s })) },
        },
        ...CHILD_DB_SPECS.series.extraProps,
      ]);
    }
    if (databaseIds.ideas && this.databases.getDatabase(databaseIds.ideas)) {
      ensureChildProperties(this.databases, databaseIds.ideas, IDEA_STAGE_PROPS);
    }
    return this.get(id);
  }

  setFeatures(id: string, featureId: string, values: Record<string, unknown>): ContentPage | null {
    const existing = this.get(id);
    if (!existing) return null;
    const features = { ...existing.features, [featureId]: values };
    this.db
      .prepare(`UPDATE content_pages SET features_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(features), Date.now(), id);
    return this.get(id);
  }

  setIntegrations(id: string, integrations: ContentPageIntegrations): ContentPage | null {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = { ...existing.integrations, ...integrations };
    this.db
      .prepare(`UPDATE content_pages SET integrations_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(merged), Date.now(), id);
    return this.get(id);
  }

  /**
   * Soft-delete the page row. Child databases are kept by default — they
   * contain user content and may have been referenced elsewhere. Pass
   * `cascadeChildren: true` to also drop the child databases.
   */
  delete(id: string, opts: { cascadeChildren?: boolean } = {}): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE content_pages SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ?`,
      )
      .run(now, now, id);
    if (opts.cascadeChildren) {
      for (const kind of CONTENT_CHILD_KINDS) {
        const dbId = existing.databaseIds[kind];
        if (dbId) this.databases.deleteDatabase(dbId);
      }
    }
    return true;
  }

  /**
   * Recompute the cached `stats` blob from child databases. Falls back to
   * row counts + property aggregates — no external API calls. Stats stay
   * derivable so external syncs (Instagram Graph, YouTube Data, etc.) can
   * later be wired in by writing the same shape.
   */
  recomputeStats(id: string): ContentPage | null {
    const existing = this.get(id);
    if (!existing) return null;
    const stats = computeStatsForPage(this.databases, existing);
    this.db
      .prepare(`UPDATE content_pages SET stats_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(stats), Date.now(), id);
    return this.get(id);
  }

  /**
   * Returns the underlying generic-databases id for one of the page's
   * children. Used by handlers that proxy CRUD on those tables.
   */
  childDatabaseId(page: ContentPage, kind: ContentChildKind): string {
    return page.databaseIds[kind];
  }

  childProperties(page: ContentPage, kind: ContentChildKind): DatabaseProperty[] {
    const dbId = this.childDatabaseId(page, kind);
    if (!dbId) return [];
    return this.databases.listProperties(dbId);
  }

  childRows(page: ContentPage, kind: ContentChildKind): DatabaseRow[] {
    const dbId = this.childDatabaseId(page, kind);
    if (!dbId) return [];
    return this.databases.listRows(dbId);
  }
}

// ═══════════════════════════════════════════════════════════════════
// STATS HELPERS
// ═══════════════════════════════════════════════════════════════════

function pickNumber(value: PropertyValue | undefined): number | null {
  if (!value) return null;
  if (value.type === "number") return value.value ?? null;
  return null;
}

function pickDate(value: PropertyValue | undefined): number | null {
  if (!value) return null;
  if (value.type === "date" && value.iso) {
    const ms = Date.parse(value.iso);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function findPropId(properties: DatabaseProperty[], name: string): string | null {
  const hit = properties.find((p) => p.name.toLowerCase() === name.toLowerCase());
  return hit?.id ?? null;
}

export function computeStatsForPage(
  databases: DatabasesStore,
  page: ContentPage,
): ContentPageStats {
  const stats = defaultStats();
  const now = Date.now();
  const monthMs = 30 * 24 * 60 * 60 * 1000;

  // ── Content stats ────────────────────────────────────────────
  const contentDb = page.databaseIds.content;
  if (contentDb) {
    const props = databases.listProperties(contentDb);
    const rows = databases.listRows(contentDb);
    const publishedAtId = findPropId(props, "Published At");
    const impressionsId = findPropId(props, "Impressions");
    const reachId = findPropId(props, "Reach");
    const engagementId = findPropId(props, "Engagement");
    const ctrId = findPropId(props, "CTR");

    let totalEngagement = 0;
    let engagementSamples = 0;
    let monthlyPosts = 0;
    let lastPublished: number | null = null;
    const dailyReach = new Map<string, number>();

    for (const row of rows) {
      const published = publishedAtId ? pickDate(row.values[publishedAtId]) : null;
      if (published) {
        stats.totalPosts++;
        if (now - published < monthMs) {
          monthlyPosts++;
          if (reachId) stats.reach30d += pickNumber(row.values[reachId]) ?? 0;
          if (impressionsId) stats.impressions30d += pickNumber(row.values[impressionsId]) ?? 0;
          if (ctrId) {
            const ctr = pickNumber(row.values[ctrId]) ?? 0;
            const impressions = impressionsId ? (pickNumber(row.values[impressionsId]) ?? 0) : 0;
            stats.clicks30d += Math.round((ctr / 100) * impressions);
          }
        }
        if (engagementId) {
          const eng = pickNumber(row.values[engagementId]);
          if (eng !== null) {
            totalEngagement += eng;
            engagementSamples++;
          }
        }
        if (lastPublished === null || published > lastPublished) lastPublished = published;

        // Day-bucketed reach for sparkline.
        if (reachId && now - published < monthMs) {
          const dayKey = new Date(published).toISOString().slice(0, 10);
          dailyReach.set(
            dayKey,
            (dailyReach.get(dayKey) ?? 0) + (pickNumber(row.values[reachId]) ?? 0),
          );
        }
      }
    }
    stats.monthlyPosts = monthlyPosts;
    stats.engagementRate = engagementSamples ? totalEngagement / engagementSamples : 0;
    stats.lastPublishedAt = lastPublished;

    // Build a 30-bucket sparkline, oldest → newest.
    const sparkline: number[] = [];
    for (let i = 29; i >= 0; i--) {
      const day = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      sparkline.push(dailyReach.get(day) ?? 0);
    }
    stats.reachSparkline = sparkline;
  }

  // ── Video views feed into engagement when content row counts are thin ──
  const videosDb = page.databaseIds.videos;
  if (videosDb) {
    const props = databases.listProperties(videosDb);
    const rows = databases.listRows(videosDb);
    const viewsId = findPropId(props, "Views");
    if (viewsId) {
      for (const row of rows) {
        const v = pickNumber(row.values[viewsId]);
        if (v !== null) stats.impressions30d += v;
      }
    }
  }

  return stats;
}
