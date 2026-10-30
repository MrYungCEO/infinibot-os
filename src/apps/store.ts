/**
 * Apps & Sites Registry — unified catalog of every app, site, project,
 * and directory across InfiniBot.
 *
 * Why this exists: today the operator has projects in kanban,
 * directories in the directory registry, video projects in compositions,
 * landing pages in community, etc. Each lives in its own store with its
 * own URL space. The registry sits on top — it's the single place to
 * answer "what have we built and where does it live?"
 *
 * Each row tracks:
 *   • The thing's name, description, URL
 *   • A `type` (`web-app` | `landing-page` | `project` | `directory` |
 *     `composition` | `storyboard` | `mobile-app` | `other`)
 *   • A `sourceKind` + `sourceId` back-pointer to the underlying record
 *     (kanban project id, directory id, composition id, etc.) so we can
 *     dedupe, sync metadata, and unlink cleanly when the source is
 *     deleted.
 *   • Optional `businessId` + `directoryId` so the entry shows up in a
 *     business's dashboard or under a directory's app list.
 *   • Tags + a `featured` flag for the dashboard's "spotlight" surface.
 *
 * Backfill walks every existing source store and upserts an entry per
 * record. Idempotent — running it twice produces the same registry.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

// ── Types ─────────────────────────────────────────────────────

export type AppType =
  | "web-app"
  | "landing-page"
  | "project"
  | "directory"
  | "composition"
  | "storyboard"
  | "mobile-app"
  | "other";

export type AppStatus = "active" | "draft" | "archived";

/** Where the registry entry came from. */
export type AppSourceKind =
  | "manual"
  | "kanban-project"
  | "directory"
  | "composition"
  | "storyboard"
  | "landing-page"
  | "expo-app";

export interface App {
  id: string;
  slug: string;
  name: string;
  description: string;
  type: AppType;
  url: string | null;
  status: AppStatus;
  /** Linked business — surfaces in that business's command center. */
  businessId: string | null;
  /** Linked directory — surfaces under the directory's view. */
  directoryId: string | null;
  /** Owner user id when known. */
  ownerId: string | null;
  /** Back-pointer to the source store record. Kept stable for dedupe. */
  sourceKind: AppSourceKind;
  sourceId: string | null;
  tags: string[];
  featured: boolean;
  /** Free-form metadata bag — repo URL, deployment env, etc. */
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AppCreateInput {
  name: string;
  slug?: string;
  description?: string;
  type?: AppType;
  url?: string | null;
  status?: AppStatus;
  businessId?: string | null;
  directoryId?: string | null;
  ownerId?: string | null;
  sourceKind?: AppSourceKind;
  sourceId?: string | null;
  tags?: string[];
  featured?: boolean;
  meta?: Record<string, unknown>;
}

export type AppPatch = Partial<Omit<App, "id" | "createdAt" | "updatedAt">>;

// ── Helpers ───────────────────────────────────────────────────

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "app"
  );
}

function dbPath(stateDir: string): string {
  return resolve(stateDir, "apps.sqlite");
}

interface AppRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  type: string;
  url: string | null;
  status: string;
  businessId: string | null;
  directoryId: string | null;
  ownerId: string | null;
  sourceKind: string;
  sourceId: string | null;
  tags: string;
  featured: 0 | 1;
  meta: string;
  createdAt: number;
  updatedAt: number;
}

function rowToApp(row: AppRow): App {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    type: row.type as AppType,
    url: row.url,
    status: (row.status as AppStatus) ?? "active",
    businessId: row.businessId,
    directoryId: row.directoryId,
    ownerId: row.ownerId,
    sourceKind: row.sourceKind as AppSourceKind,
    sourceId: row.sourceId,
    tags: parseJsonArray(row.tags),
    featured: !!row.featured,
    meta: parseJsonObject(row.meta),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJsonArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v != null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Store ─────────────────────────────────────────────────────

export class AppsStore {
  private db: Database.Database;
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    mkdirSync(dirname(dbPath(stateDir)), { recursive: true });
    this.db = new Database(dbPath(stateDir));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'web-app',
        url TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        businessId TEXT,
        directoryId TEXT,
        ownerId TEXT,
        sourceKind TEXT NOT NULL DEFAULT 'manual',
        sourceId TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        featured INTEGER NOT NULL DEFAULT 0,
        meta TEXT NOT NULL DEFAULT '{}',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_apps_business ON apps(businessId);
      CREATE INDEX IF NOT EXISTS idx_apps_directory ON apps(directoryId);
      CREATE INDEX IF NOT EXISTS idx_apps_source ON apps(sourceKind, sourceId);
      CREATE INDEX IF NOT EXISTS idx_apps_type ON apps(type);
    `);
  }

  list(
    filters: { type?: AppType; businessId?: string; directoryId?: string; featured?: boolean } = {},
  ): App[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filters.type) {
      where.push("type = ?");
      args.push(filters.type);
    }
    if (filters.businessId) {
      where.push("businessId = ?");
      args.push(filters.businessId);
    }
    if (filters.directoryId) {
      where.push("directoryId = ?");
      args.push(filters.directoryId);
    }
    if (filters.featured !== undefined) {
      where.push("featured = ?");
      args.push(filters.featured ? 1 : 0);
    }
    const sql = `SELECT * FROM apps ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY featured DESC, updatedAt DESC`;
    return (this.db.prepare(sql).all(...args) as AppRow[]).map(rowToApp);
  }

  get(id: string): App | null {
    const row = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as AppRow | undefined;
    return row ? rowToApp(row) : null;
  }

  /** Find by source — used by the auto-register hooks for dedupe. */
  getBySource(sourceKind: AppSourceKind, sourceId: string): App | null {
    const row = this.db
      .prepare("SELECT * FROM apps WHERE sourceKind = ? AND sourceId = ?")
      .get(sourceKind, sourceId) as AppRow | undefined;
    return row ? rowToApp(row) : null;
  }

  /**
   * Idempotent upsert — if a row already exists for the same
   * (sourceKind, sourceId), update it. Otherwise insert. Returns the
   * resulting record. The auto-register hooks call this so duplicate
   * signals don't multiply rows.
   */
  upsertBySource(input: AppCreateInput & { sourceKind: AppSourceKind; sourceId: string }): App {
    const existing = this.getBySource(input.sourceKind, input.sourceId);
    if (existing) {
      return this.update(existing.id, {
        name: input.name,
        description: input.description ?? existing.description,
        type: input.type ?? existing.type,
        url: input.url !== undefined ? input.url : existing.url,
        businessId: input.businessId !== undefined ? input.businessId : existing.businessId,
        directoryId: input.directoryId !== undefined ? input.directoryId : existing.directoryId,
        ownerId: input.ownerId !== undefined ? input.ownerId : existing.ownerId,
        meta: { ...existing.meta, ...input.meta },
        tags: input.tags ?? existing.tags,
      })!;
    }
    return this.create(input);
  }

  create(input: AppCreateInput): App {
    const id = `app_${randomUUID()}`;
    const slug = (input.slug ?? slugify(input.name)).slice(0, 60);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO apps (id, slug, name, description, type, url, status,
          businessId, directoryId, ownerId, sourceKind, sourceId, tags, featured, meta,
          createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        slug,
        input.name,
        input.description ?? "",
        input.type ?? "web-app",
        input.url ?? null,
        input.status ?? "active",
        input.businessId ?? null,
        input.directoryId ?? null,
        input.ownerId ?? null,
        input.sourceKind ?? "manual",
        input.sourceId ?? null,
        JSON.stringify(input.tags ?? []),
        input.featured ? 1 : 0,
        JSON.stringify(input.meta ?? {}),
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, patch: AppPatch): App | null {
    const cur = this.get(id);
    if (!cur) return null;
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown) => {
      fields.push(`${col} = ?`);
      values.push(val);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.slug !== undefined) set("slug", patch.slug);
    if (patch.description !== undefined) set("description", patch.description);
    if (patch.type !== undefined) set("type", patch.type);
    if (patch.url !== undefined) set("url", patch.url);
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.businessId !== undefined) set("businessId", patch.businessId);
    if (patch.directoryId !== undefined) set("directoryId", patch.directoryId);
    if (patch.ownerId !== undefined) set("ownerId", patch.ownerId);
    if (patch.sourceKind !== undefined) set("sourceKind", patch.sourceKind);
    if (patch.sourceId !== undefined) set("sourceId", patch.sourceId);
    if (patch.tags !== undefined) set("tags", JSON.stringify(patch.tags));
    if (patch.featured !== undefined) set("featured", patch.featured ? 1 : 0);
    if (patch.meta !== undefined) set("meta", JSON.stringify(patch.meta));
    if (fields.length === 0) return cur;
    set("updatedAt", Date.now());
    values.push(id);
    this.db.prepare(`UPDATE apps SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  delete(id: string): boolean {
    const r = this.db.prepare("DELETE FROM apps WHERE id = ?").run(id);
    return r.changes > 0;
  }

  /** Cascade-delete entries when their source disappears. */
  deleteBySource(sourceKind: AppSourceKind, sourceId: string): boolean {
    const r = this.db
      .prepare("DELETE FROM apps WHERE sourceKind = ? AND sourceId = ?")
      .run(sourceKind, sourceId);
    return r.changes > 0;
  }
}

// ── Singleton ─────────────────────────────────────────────────

// Per-state-dir instances so concurrent tenants (SaaS mode) don't share/thrash
// a single slot. Single-user local mode holds one entry.
const _stores = new Map<string, AppsStore>();

export function getAppsStore(stateDir: string): AppsStore {
  let store = _stores.get(stateDir);
  if (!store) {
    store = new AppsStore(stateDir);
    _stores.set(stateDir, store);
  }
  return store;
}

// ── Backfill ──────────────────────────────────────────────────

export interface BackfillSummary {
  scanned: Record<AppSourceKind, number>;
  created: Record<AppSourceKind, number>;
  updated: Record<AppSourceKind, number>;
}

function emptySummary(): BackfillSummary {
  const z = (): Record<AppSourceKind, number> => ({
    manual: 0,
    "kanban-project": 0,
    directory: 0,
    composition: 0,
    storyboard: 0,
    "landing-page": 0,
    "expo-app": 0,
  });
  return { scanned: z(), created: z(), updated: z() };
}

/**
 * One-shot scan of every source store. Each scanner is best-effort —
 * if a source isn't reachable (e.g. the DB schema differs in dev), the
 * scanner logs and moves on without aborting the whole backfill.
 */
export function backfillApps(stateDir: string): BackfillSummary {
  const store = getAppsStore(stateDir);
  const summary = emptySummary();

  // Helper that records create vs. update.
  const upsert = (
    kind: AppSourceKind,
    sourceId: string,
    input: Omit<AppCreateInput, "sourceKind" | "sourceId">,
  ) => {
    summary.scanned[kind]++;
    const before = store.getBySource(kind, sourceId);
    store.upsertBySource({ ...input, sourceKind: kind, sourceId });
    if (before) summary.updated[kind]++;
    else summary.created[kind]++;
  };

  // ── Kanban projects ──
  try {
    // The kanban store lives in <state>/kanban.sqlite via better-sqlite3.
    const kPath = join(stateDir, "kanban.sqlite");
    if (existsSync(kPath)) {
      const db = new Database(kPath, { readonly: true });
      try {
        const rows = db.prepare("SELECT id, name, description FROM projects").all() as Array<{
          id: string;
          name: string;
          description: string | null;
        }>;
        // Pull project_meta in one go for businessId mapping (when the table exists).
        let metaByProject: Record<
          string,
          { businessId?: string | null; mediaProjectId?: string | null }
        > = {};
        try {
          const metaRows = db
            .prepare("SELECT projectId, businessId, mediaProjectId FROM project_meta")
            .all() as Array<{
            projectId: string;
            businessId: string | null;
            mediaProjectId: string | null;
          }>;
          metaByProject = Object.fromEntries(
            metaRows.map((r) => [
              r.projectId,
              {
                businessId: r.businessId ?? undefined,
                mediaProjectId: r.mediaProjectId ?? undefined,
              },
            ]),
          );
        } catch {
          /* table may not exist on older installs */
        }

        for (const row of rows) {
          const meta = metaByProject[row.id] ?? {};
          upsert("kanban-project", row.id, {
            name: row.name,
            description: row.description ?? "",
            type: "project",
            businessId: meta.businessId ?? null,
            url: null,
          });
        }
      } finally {
        db.close();
      }
    }
  } catch (err) {
    console.warn(
      "[apps.backfill] kanban scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── Directories ──
  try {
    const dPath = join(stateDir, "directories.sqlite");
    if (existsSync(dPath)) {
      const db = new Database(dPath, { readonly: true });
      try {
        // Schema varies between versions; try the canonical fields.
        const rows = db
          .prepare(
            `SELECT id, name, COALESCE(description, '') AS description,
                    COALESCE(path, '') AS path, COALESCE(url, '') AS url,
                    COALESCE(businessId, '') AS businessId
             FROM directories`,
          )
          .all() as Array<{
          id: string;
          name: string;
          description: string;
          path: string;
          url: string;
          businessId: string;
        }>;
        for (const row of rows) {
          upsert("directory", row.id, {
            name: row.name,
            description: row.description,
            type: "directory",
            url: row.url || (row.path ? `file://${row.path}` : null),
            directoryId: row.id,
            businessId: row.businessId || null,
            meta: row.path ? { path: row.path } : {},
          });
        }
      } finally {
        db.close();
      }
    }
  } catch (err) {
    console.warn(
      "[apps.backfill] directory scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── Compositions (video projects) ──
  try {
    const cPath = join(stateDir, "compositions.sqlite");
    if (existsSync(cPath)) {
      const db = new Database(cPath, { readonly: true });
      try {
        const rows = db
          .prepare("SELECT id, name, slug, COALESCE(meta, '{}') AS meta FROM compositions")
          .all() as Array<{ id: string; name: string; slug: string; meta: string }>;
        for (const row of rows) {
          let meta: Record<string, unknown> = {};
          try {
            meta = JSON.parse(row.meta);
          } catch {
            /* ignore */
          }
          upsert("composition", row.id, {
            name: row.name,
            description:
              typeof meta.description === "string" ? meta.description : "Video composition",
            type: "composition",
            slug: row.slug,
            url: null,
            meta,
          });
        }
      } finally {
        db.close();
      }
    }
  } catch (err) {
    console.warn(
      "[apps.backfill] composition scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── Storyboard projects ──
  try {
    const sPath = join(stateDir, "storyboard");
    if (existsSync(sPath)) {
      for (const entry of readdirSync(sPath)) {
        if (!entry.endsWith(".json")) continue;
        const p = join(sPath, entry);
        try {
          const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
          if (typeof raw?.id === "string" && typeof raw?.name === "string") {
            upsert("storyboard", raw.id, {
              name: raw.name,
              description:
                typeof raw.prompt === "string" ? raw.prompt.slice(0, 200) : "Storyboard project",
              type: "storyboard",
              url: null,
              meta: { platform: raw.platform, status: raw.status },
            });
          }
        } catch {
          /* skip malformed */
        }
      }
    }
  } catch (err) {
    console.warn(
      "[apps.backfill] storyboard scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── Landing pages (community/landing) ──
  try {
    const lPath = join(stateDir, "landing-pages");
    if (existsSync(lPath)) {
      for (const entry of readdirSync(lPath)) {
        const p = join(lPath, entry);
        try {
          const st = statSync(p);
          if (!st.isDirectory()) continue;
          const cfgPath = join(p, "site.json");
          if (!existsSync(cfgPath)) continue;
          const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
          const id = typeof cfg.id === "string" ? cfg.id : entry;
          const name = typeof cfg.name === "string" ? cfg.name : entry;
          const url = typeof cfg.publicUrl === "string" ? cfg.publicUrl : null;
          upsert("landing-page", id, {
            name,
            description: typeof cfg.description === "string" ? cfg.description : "Landing page",
            type: "landing-page",
            url,
            meta: { siteId: id },
          });
        } catch {
          /* skip */
        }
      }
    }
  } catch (err) {
    console.warn(
      "[apps.backfill] landing-pages scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── Expo / mobile project ──
  try {
    const home = homedir();
    const expoDir = process.env.EXPO_PROJECT_DIR ?? join(home, "infinibot");
    const appJson = join(expoDir, "app.json");
    if (existsSync(appJson)) {
      const cfg = JSON.parse(readFileSync(appJson, "utf-8")) as {
        expo?: { name?: string; slug?: string; ios?: { bundleIdentifier?: string } };
      };
      const slug = cfg.expo?.slug ?? "moltbot-mobile";
      upsert("expo-app", slug, {
        name: cfg.expo?.name ?? "InfiniBot Mobile",
        description: "Expo / React Native companion app",
        type: "mobile-app",
        slug,
        url: null,
        meta: { bundleIdentifier: cfg.expo?.ios?.bundleIdentifier, projectDir: expoDir },
      });
    }
  } catch (err) {
    console.warn(
      "[apps.backfill] expo scan failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return summary;
}

// ── Auto-register hooks ──────────────────────────────────────

/**
 * Called from gateway handlers when a new project / directory /
 * composition / storyboard / landing-page is created. Idempotent — if
 * the same source id was registered before, just touches the row.
 *
 * Intentionally accepts a loose shape; caller passes whatever it knows.
 */
export function autoRegister(
  stateDir: string,
  args: {
    sourceKind: AppSourceKind;
    sourceId: string;
    name: string;
    type?: AppType;
    description?: string;
    url?: string | null;
    businessId?: string | null;
    directoryId?: string | null;
    ownerId?: string | null;
    /** Federation peer the source lives on. null/undefined = local peer. */
    peerId?: string | null;
    meta?: Record<string, unknown>;
  },
): App {
  const store = getAppsStore(stateDir);
  // When a federation peer is set, address the source via the peer-scoped
  // scheme so it resolves on the right node; otherwise keep the caller's
  // (typically file://) URL which already means "local peer".
  const absPath = typeof args.meta?.path === "string" ? args.meta.path : null;
  const url = args.peerId && absPath ? `infinibot://peer/${args.peerId}/${absPath}` : args.url;
  return store.upsertBySource({
    sourceKind: args.sourceKind,
    sourceId: args.sourceId,
    name: args.name,
    description: args.description,
    type: args.type ?? defaultTypeFor(args.sourceKind),
    url,
    businessId: args.businessId,
    directoryId: args.directoryId,
    ownerId: args.ownerId,
    meta: { ...args.meta, peerId: args.peerId ?? null },
  });
}

function defaultTypeFor(kind: AppSourceKind): AppType {
  switch (kind) {
    case "kanban-project":
      return "project";
    case "directory":
      return "directory";
    case "composition":
      return "composition";
    case "storyboard":
      return "storyboard";
    case "landing-page":
      return "landing-page";
    case "expo-app":
      return "mobile-app";
    default:
      return "web-app";
  }
}
