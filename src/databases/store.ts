/**
 * Generic database store — SQLite-backed Notion-style tables.
 *
 * Rows store property values as a JSON blob keyed by property id so that
 * schema evolution (adding / renaming / deleting properties) doesn't require
 * ALTER TABLE. Query filters and sorts are evaluated in JS on the filtered
 * row set because the row count per database is expected to stay small
 * (hundreds to low thousands); this avoids cramming dynamic SQL for each
 * property type. If / when a database gets very large we can add a
 * materialized columns table keyed by (rowId, propertyId).
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  DatabaseLink,
  DatabaseProperty,
  DatabaseRecord,
  DatabaseRow,
  DatabaseSource,
  LinkTargetKind,
  PropertyConfig,
  PropertyType,
  PropertyValue,
  RowFilter,
  RowQuery,
  RowSort,
  SystemRole,
  SystemRoleAssignment,
} from "./types.js";
import { resolveStateDirWithLegacyEnv } from "../config/paths.js";
import { isSlug, parseDatabaseUrl, slugify, uniqueSlug } from "./slug.js";
import { backfillFromNotionManager } from "./notion-manager-backfill.js";
import { ensureBusinessTemplates } from "./business-templates.js";

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

// Per-state-dir connections + seed tracking. Keyed by dir so concurrent tenants
// (SaaS mode) each get their own databases.db without a single slot thrashing
// between them. Single-user local mode holds one entry.
const _dbs = new Map<string, Database.Database>();
const _seededDirs = new Set<string>();

/**
 * Returns the shared DatabasesStore for this state dir. The first call per
 * state dir also idempotently seeds the kanban-backed stubs, default
 * system-role assignments, and the legacy Notion-manager backfill — so every
 * downstream caller (RPC handler, agent tool, UI) sees a fully-populated
 * store without needing its own init flag.
 */
export function getDatabasesStore(stateDir?: string): DatabasesStore {
  // Canonical resolver (with MOLTBOT_STATE_DIR back-compat). The old bare
  // `MOLTBOT_STATE_DIR || "state"` fallback read <cwd>/state/databases.db —
  // an empty stub — while the real 7+ MB DB lives at ~/.infinibot/databases.db.
  const dir = stateDir || resolveStateDirWithLegacyEnv();
  let db = _dbs.get(dir);
  if (!db) {
    db = initDatabase(dir);
    _dbs.set(dir, db);
  }
  const store = new DatabasesStore(db);
  if (!_seededDirs.has(dir)) {
    _seededDirs.add(dir);
    try {
      ensureKanbanBuiltInDatabases(store);
    } catch {
      // best-effort seed — never block the caller on init problems
    }
    try {
      // Seed the business / CRM templates (Clients, Leads, Companies,
      // Deals, Contacts, Notes) so a fresh install has a usable workspace
      // out of the box. All Notion-compatible schemas; no Notion account
      // required — local SQLite is the system of record.
      ensureBusinessTemplates(store);
    } catch {
      // best-effort seed — never block the caller on init problems
    }
  }
  return store;
}

function initDatabase(stateDir: string): Database.Database {
  const dbPath = resolve(stateDir, "databases.db");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  applyMigrations(db);
  return db;
}

/** Idempotent schema migrations for stores created before newer columns existed. */
function applyMigrations(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(database_rows)`).all() as Array<{ name: string }>;
  const hasExternalRef = cols.some((c) => c.name === "external_ref_json");
  if (!hasExternalRef) {
    db.exec(`ALTER TABLE database_rows ADD COLUMN external_ref_json TEXT`);
  }
  const hasParent = cols.some((c) => c.name === "parent_row_id");
  if (!hasParent) {
    // Self-referential FK must be declared at CREATE TABLE time in SQLite;
    // ALTER TABLE adds the column without the constraint. We enforce the
    // referential invariant + cascade manually in deleteRow().
    db.exec(`ALTER TABLE database_rows ADD COLUMN parent_row_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rows_parent ON database_rows(parent_row_id)`);
  }

  // Slug columns — added late so legacy installs need a backfill from name/title.
  // The unique indexes are partial (`WHERE slug IS NOT NULL`) so the column
  // can be added before backfill without violating uniqueness on legacy nulls.
  const dbCols = db.prepare(`PRAGMA table_info(databases)`).all() as Array<{ name: string }>;
  if (!dbCols.some((c) => c.name === "slug")) {
    db.exec(`ALTER TABLE databases ADD COLUMN slug TEXT`);
    backfillDatabaseSlugs(db);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_databases_slug ON databases(slug) WHERE slug IS NOT NULL`,
  );
  const rowColsAfter = db.prepare(`PRAGMA table_info(database_rows)`).all() as Array<{
    name: string;
  }>;
  if (!rowColsAfter.some((c) => c.name === "slug")) {
    db.exec(`ALTER TABLE database_rows ADD COLUMN slug TEXT`);
    backfillRowSlugs(db);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rows_slug ON database_rows(database_id, slug) WHERE slug IS NOT NULL`,
  );

  // business_id — per-business scoping. Nullable so legacy rows stay visible
  // in the unscoped "All Businesses" view; the workspace UI fills it in via
  // db.rows.scope or by passing businessId on create. Indexed because the
  // workspace is going to filter every query by it.
  if (!rowColsAfter.some((c) => c.name === "business_id")) {
    db.exec(`ALTER TABLE database_rows ADD COLUMN business_id TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_rows_business ON database_rows(business_id) WHERE business_id IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_rows_db_business ON database_rows(database_id, business_id) WHERE business_id IS NOT NULL`,
  );

  // completed_at — set when a kanban task row transitions to a "done" status.
  // Other database types leave this NULL; the column is part of DatabaseRow but
  // is only semantically meaningful for kanban-role databases.
  const finalRowCols = db.prepare(`PRAGMA table_info(database_rows)`).all() as Array<{
    name: string;
  }>;
  if (!finalRowCols.some((c) => c.name === "completed_at")) {
    db.exec(`ALTER TABLE database_rows ADD COLUMN completed_at INTEGER`);
  }
}

function backfillDatabaseSlugs(db: Database.Database): void {
  const rows = db.prepare(`SELECT id, name FROM databases WHERE slug IS NULL`).all() as Array<{
    id: string;
    name: string;
  }>;
  const taken = new Set<string>(
    (
      db.prepare(`SELECT slug FROM databases WHERE slug IS NOT NULL`).all() as Array<{
        slug: string;
      }>
    ).map((r) => r.slug),
  );
  const update = db.prepare(`UPDATE databases SET slug = ? WHERE id = ?`);
  for (const r of rows) {
    const base = slugify(r.name);
    const slug = uniqueSlug(base, (s) => taken.has(s));
    taken.add(slug);
    update.run(slug, r.id);
  }
}

function backfillRowSlugs(db: Database.Database): void {
  const rows = db
    .prepare(`SELECT id, database_id, title FROM database_rows WHERE slug IS NULL`)
    .all() as Array<{ id: string; database_id: string; title: string }>;
  const takenByDb = new Map<string, Set<string>>();
  const seedExisting = db
    .prepare(`SELECT database_id, slug FROM database_rows WHERE slug IS NOT NULL`)
    .all() as Array<{ database_id: string; slug: string }>;
  for (const r of seedExisting) {
    if (!takenByDb.has(r.database_id)) takenByDb.set(r.database_id, new Set());
    takenByDb.get(r.database_id)!.add(r.slug);
  }
  const update = db.prepare(`UPDATE database_rows SET slug = ? WHERE id = ?`);
  for (const r of rows) {
    const base = slugify(r.title || r.id);
    const taken = takenByDb.get(r.database_id) ?? new Set<string>();
    const slug = uniqueSlug(base, (s) => taken.has(s));
    taken.add(slug);
    takenByDb.set(r.database_id, taken);
    update.run(slug, r.id);
  }
}

// ═══════════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════════

const SCHEMA = `
CREATE TABLE IF NOT EXISTS databases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  icon TEXT,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'native',
  meta_json TEXT NOT NULL DEFAULT '{}',
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_databases_source ON databases(source);
CREATE INDEX IF NOT EXISTS idx_databases_sort ON databases(sort_order);

CREATE TABLE IF NOT EXISTS database_properties (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config_json TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_props_db ON database_properties(database_id);
CREATE INDEX IF NOT EXISTS idx_props_sort ON database_properties(database_id, sort_order);

CREATE TABLE IF NOT EXISTS database_rows (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  slug TEXT,
  body_md TEXT,
  values_json TEXT NOT NULL DEFAULT '{}',
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  business_id TEXT,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rows_db ON database_rows(database_id);
CREATE INDEX IF NOT EXISTS idx_rows_sort ON database_rows(database_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_rows_updated ON database_rows(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rows_business ON database_rows(business_id) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rows_db_business ON database_rows(database_id, business_id) WHERE business_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS database_links (
  id TEXT PRIMARY KEY,
  row_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  property_id TEXT,
  label TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_links_row ON database_links(row_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON database_links(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_links_prop ON database_links(row_id, property_id);

-- System-database role registry: well-known roles (projects/tasks/notes/
-- clients/leads) mapped to a specific database_id. Decouples tools from
-- hardcoded Notion UUIDs so users can point each role at whatever backing
-- database they prefer (native SQLite, a Notion import, or the built-in
-- kanban-backed stubs).
CREATE TABLE IF NOT EXISTS system_databases (
  role TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE SET NULL
);

-- Per-business role mapping. Lets each business own a dedicated CRM /
-- leads / projects database while still sharing global defaults via
-- system_databases above. Lookup order: (business_id, role) here, then
-- fall back to system_databases. Composite primary key prevents two
-- conflicting mappings for the same business+role pair.
CREATE TABLE IF NOT EXISTS business_role_databases (
  business_id TEXT NOT NULL,
  role TEXT NOT NULL,
  database_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (business_id, role),
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_business_role_databases_role ON business_role_databases(role);
`;

// ═══════════════════════════════════════════════════════════════════
// ROW / PROPERTY MAPPERS
// ═══════════════════════════════════════════════════════════════════

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapDatabase(row: Record<string, unknown>): DatabaseRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    slug: (row.slug as string | null) ?? slugify((row.name as string) ?? ""),
    icon: (row.icon as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    source: (row.source as DatabaseSource) ?? "native",
    meta: parseJson(row.meta_json as string | null, {} as Record<string, unknown>),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function mapProperty(row: Record<string, unknown>): DatabaseProperty {
  return {
    id: row.id as string,
    databaseId: row.database_id as string,
    name: row.name as string,
    type: row.type as PropertyType,
    config: parseJson(row.config_json as string | null, null as PropertyConfig | null),
    sortOrder: row.sort_order as number,
    hidden: (row.hidden as number) === 1,
  };
}

function mapRow(row: Record<string, unknown>): DatabaseRow {
  return {
    id: row.id as string,
    databaseId: row.database_id as string,
    title: (row.title as string) ?? "",
    slug: (row.slug as string | null) ?? slugify((row.title as string) ?? (row.id as string) ?? ""),
    body: (row.body_md as string | null) ?? null,
    values: parseJson(row.values_json as string | null, {} as Record<string, PropertyValue>),
    sortOrder: row.sort_order as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    completedAt: (row.completed_at as number | null) ?? undefined,
    externalRef: parseJson(
      (row.external_ref_json as string | null) ?? null,
      null as import("./types.js").ExternalRef | null,
    ),
    parentRowId: (row.parent_row_id as string | null) ?? null,
    businessId: (row.business_id as string | null) ?? null,
  };
}

function mapLink(row: Record<string, unknown>): DatabaseLink {
  return {
    id: row.id as string,
    rowId: row.row_id as string,
    targetKind: row.target_kind as LinkTargetKind,
    targetId: row.target_id as string,
    propertyId: (row.property_id as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    createdAt: row.created_at as number,
  };
}

// ═══════════════════════════════════════════════════════════════════
// FILTER / SORT EVALUATION
// ═══════════════════════════════════════════════════════════════════

function getComparable(value: PropertyValue | undefined): string | number | boolean | null {
  if (!value) return null;
  switch (value.type) {
    case "title":
      return value.text ?? "";
    case "richText":
      return value.markdown ?? "";
    case "select":
    case "status":
      return value.optionId ?? null;
    case "multiSelect":
      return value.optionIds.join(",");
    case "date":
      return value.iso ?? null;
    case "dateRange":
      return value.start ?? null;
    case "number":
      return value.value ?? null;
    case "checkbox":
      return value.checked;
    case "url":
      return value.url ?? null;
    case "email":
      return value.email ?? null;
    case "phone":
      return value.phone ?? null;
    case "files":
      return value.files.length;
    case "relation":
      return value.rowIds.join(",");
    case "person":
      return value.personIds.join(",");
    case "createdAt":
    case "updatedAt":
      return value.iso;
    default:
      return null;
  }
}

function matchesFilter(row: DatabaseRow, filter: RowFilter): boolean {
  switch (filter.kind) {
    case "equals": {
      const comp = getComparable(row.values[filter.propertyId]);
      return comp === filter.value;
    }
    case "contains": {
      const comp = getComparable(row.values[filter.propertyId]);
      if (typeof comp !== "string") return false;
      return comp.toLowerCase().includes(filter.value.toLowerCase());
    }
    case "isEmpty": {
      const comp = getComparable(row.values[filter.propertyId]);
      return comp === null || comp === "" || comp === 0 || comp === false;
    }
    case "isNotEmpty": {
      const comp = getComparable(row.values[filter.propertyId]);
      return !(comp === null || comp === "" || comp === 0 || comp === false);
    }
    case "in": {
      const comp = getComparable(row.values[filter.propertyId]);
      return filter.values.includes(comp);
    }
    case "and":
      return filter.filters.every((f) => matchesFilter(row, f));
    case "or":
      return filter.filters.some((f) => matchesFilter(row, f));
  }
}

function compareRows(a: DatabaseRow, b: DatabaseRow, sorts: RowSort[]): number {
  for (const sort of sorts) {
    const av =
      getComparable(a.values[sort.propertyId]) ?? (sort.propertyId === "__title" ? a.title : null);
    const bv =
      getComparable(b.values[sort.propertyId]) ?? (sort.propertyId === "__title" ? b.title : null);
    let cmp = 0;
    if (av === null && bv === null) cmp = 0;
    else if (av === null) cmp = 1;
    else if (bv === null) cmp = -1;
    else if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp !== 0) return sort.direction === "desc" ? -cmp : cmp;
  }
  return a.sortOrder - b.sortOrder;
}

// ═══════════════════════════════════════════════════════════════════
// STORE CLASS
// ═══════════════════════════════════════════════════════════════════

export class DatabasesStore {
  constructor(private db: Database.Database) {}

  // ── Databases ─────────────────────────────────────────────────────

  listDatabases(): DatabaseRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM databases ORDER BY sort_order ASC, created_at ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapDatabase);
  }

  getDatabase(id: string): DatabaseRecord | null {
    const row = this.db.prepare(`SELECT * FROM databases WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapDatabase(row) : null;
  }

  getDatabaseBySlug(slug: string): DatabaseRecord | null {
    const row = this.db.prepare(`SELECT * FROM databases WHERE slug = ?`).get(slug) as
      | Record<string, unknown>
      | undefined;
    return row ? mapDatabase(row) : null;
  }

  /** Lookup by slug or id — handy for callers that accept either form. */
  getDatabaseByIdOrSlug(handle: string): DatabaseRecord | null {
    return this.getDatabase(handle) ?? this.getDatabaseBySlug(handle);
  }

  getDatabaseBySource(source: DatabaseSource): DatabaseRecord | null {
    const row = this.db.prepare(`SELECT * FROM databases WHERE source = ? LIMIT 1`).get(source) as
      | Record<string, unknown>
      | undefined;
    return row ? mapDatabase(row) : null;
  }

  createDatabase(input: {
    id?: string;
    name: string;
    slug?: string;
    icon?: string | null;
    description?: string | null;
    source?: DatabaseSource;
    meta?: Record<string, unknown>;
    properties?: Array<{
      id?: string;
      name: string;
      type: PropertyType;
      config?: PropertyConfig | null;
      hidden?: boolean;
    }>;
  }): DatabaseRecord {
    const id = input.id || `db_${randomUUID()}`;
    const now = Date.now();
    const slug = this.allocateDatabaseSlug(input.slug ?? input.name);
    this.db
      .prepare(
        `INSERT INTO databases (id, name, slug, icon, description, source, meta_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        slug,
        input.icon ?? null,
        input.description ?? null,
        input.source ?? "native",
        JSON.stringify(input.meta ?? {}),
        now,
        now,
        now,
      );

    const props = input.properties ?? defaultPropertiesForNative();
    for (let i = 0; i < props.length; i++) {
      this.createProperty({
        databaseId: id,
        id: props[i]!.id,
        name: props[i]!.name,
        type: props[i]!.type,
        config: props[i]!.config ?? null,
        hidden: props[i]!.hidden ?? false,
        sortOrder: (i + 1) * 1000,
      });
    }

    return this.getDatabase(id)!;
  }

  updateDatabase(
    id: string,
    patch: Partial<Pick<DatabaseRecord, "name" | "slug" | "icon" | "description" | "meta">>,
  ): DatabaseRecord | null {
    const existing = this.getDatabase(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, updatedAt: Date.now() };
    // Slug renames must stay unique; allocate around the existing slug.
    if (patch.slug !== undefined && patch.slug !== existing.slug) {
      next.slug = this.allocateDatabaseSlug(patch.slug, id);
    }
    this.db
      .prepare(
        `UPDATE databases SET name = ?, slug = ?, icon = ?, description = ?, meta_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.slug,
        next.icon,
        next.description,
        JSON.stringify(next.meta ?? {}),
        next.updatedAt,
        id,
      );
    return this.getDatabase(id);
  }

  /**
   * Build a unique slug for a database. Accepts either a raw name (gets
   * slugified) or an already-slug string. `excludeId` lets renames keep
   * their own slug in scope without colliding with themselves.
   */
  private allocateDatabaseSlug(input: string, excludeId?: string): string {
    const base = isSlug(input) ? input : slugify(input);
    return uniqueSlug(base, (candidate) => {
      const row = this.db.prepare(`SELECT id FROM databases WHERE slug = ?`).get(candidate) as
        | { id: string }
        | undefined;
      return row != null && row.id !== excludeId;
    });
  }

  private allocateRowSlug(databaseId: string, input: string, excludeId?: string): string {
    const base = isSlug(input) ? input : slugify(input);
    return uniqueSlug(base, (candidate) => {
      const row = this.db
        .prepare(`SELECT id FROM database_rows WHERE database_id = ? AND slug = ?`)
        .get(databaseId, candidate) as { id: string } | undefined;
      return row != null && row.id !== excludeId;
    });
  }

  deleteDatabase(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM databases WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  // ── Properties ────────────────────────────────────────────────────

  listProperties(databaseId: string): DatabaseProperty[] {
    const rows = this.db
      .prepare(`SELECT * FROM database_properties WHERE database_id = ? ORDER BY sort_order ASC`)
      .all(databaseId) as Record<string, unknown>[];
    return rows.map(mapProperty);
  }

  createProperty(input: {
    databaseId: string;
    id?: string;
    name: string;
    type: PropertyType;
    config?: PropertyConfig | null;
    hidden?: boolean;
    sortOrder?: number;
  }): DatabaseProperty {
    const id = input.id || `prop_${randomUUID()}`;
    const existing = this.listProperties(input.databaseId);
    const sortOrder =
      input.sortOrder ?? (existing.length ? existing[existing.length - 1]!.sortOrder + 1000 : 1000);
    this.db
      .prepare(
        `INSERT INTO database_properties (id, database_id, name, type, config_json, sort_order, hidden)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.databaseId,
        input.name,
        input.type,
        input.config ? JSON.stringify(input.config) : null,
        sortOrder,
        input.hidden ? 1 : 0,
      );
    return {
      id,
      databaseId: input.databaseId,
      name: input.name,
      type: input.type,
      config: input.config ?? null,
      sortOrder,
      hidden: input.hidden ?? false,
    };
  }

  updateProperty(
    id: string,
    patch: Partial<Pick<DatabaseProperty, "name" | "type" | "config" | "sortOrder" | "hidden">>,
  ): DatabaseProperty | null {
    const existing = this.db.prepare(`SELECT * FROM database_properties WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) return null;
    const next = {
      ...mapProperty(existing),
      ...patch,
    };
    this.db
      .prepare(
        `UPDATE database_properties SET name = ?, type = ?, config_json = ?, sort_order = ?, hidden = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.type,
        next.config ? JSON.stringify(next.config) : null,
        next.sortOrder,
        next.hidden ? 1 : 0,
        id,
      );
    return next;
  }

  deleteProperty(id: string): boolean {
    return this.db.prepare(`DELETE FROM database_properties WHERE id = ?`).run(id).changes > 0;
  }

  // ── Rows ─────────────────────────────────────────────────────────

  listRows(databaseId: string, opts: { businessId?: string | null } = {}): DatabaseRow[] {
    // businessId filtering:
    //   - undefined  → no filter (all rows in the database)
    //   - null       → only rows with no business assignment
    //   - "abc"      → only rows scoped to that business
    let rows: Record<string, unknown>[];
    if (opts.businessId === undefined) {
      rows = this.db
        .prepare(
          `SELECT * FROM database_rows WHERE database_id = ? ORDER BY sort_order ASC, created_at ASC`,
        )
        .all(databaseId) as Record<string, unknown>[];
    } else if (opts.businessId === null) {
      rows = this.db
        .prepare(
          `SELECT * FROM database_rows WHERE database_id = ? AND business_id IS NULL ORDER BY sort_order ASC, created_at ASC`,
        )
        .all(databaseId) as Record<string, unknown>[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM database_rows WHERE database_id = ? AND business_id = ? ORDER BY sort_order ASC, created_at ASC`,
        )
        .all(databaseId, opts.businessId) as Record<string, unknown>[];
    }
    return rows.map(mapRow);
  }

  getRow(rowId: string): DatabaseRow | null {
    const row = this.db.prepare(`SELECT * FROM database_rows WHERE id = ?`).get(rowId) as
      | Record<string, unknown>
      | undefined;
    return row ? mapRow(row) : null;
  }

  queryRows(q: RowQuery): DatabaseRow[] {
    let rows = this.listRows(q.databaseId, { businessId: q.businessId });
    if (q.filter) rows = rows.filter((r) => matchesFilter(r, q.filter!));
    if (q.sorts?.length) rows.sort((a, b) => compareRows(a, b, q.sorts!));
    if (q.offset) rows = rows.slice(q.offset);
    if (q.limit != null) rows = rows.slice(0, q.limit);
    return rows;
  }

  upsertRow(input: {
    id?: string;
    databaseId: string;
    title?: string;
    slug?: string;
    body?: string | null;
    values?: Record<string, PropertyValue>;
    sortOrder?: number;
    externalRef?: import("./types.js").ExternalRef | null;
    parentRowId?: string | null;
    /** Per-business scope. Pass null to explicitly clear; omit to leave unchanged on update. */
    businessId?: string | null;
    /** Unix ms completion timestamp (kanban tasks only). Pass null to clear; omit to keep existing. */
    completedAt?: number | null;
  }): DatabaseRow {
    const now = Date.now();
    if (input.id) {
      const existing = this.getRow(input.id);
      if (existing) {
        const nextValues = { ...existing.values, ...input.values };
        const nextExternalRef =
          input.externalRef !== undefined ? input.externalRef : (existing.externalRef ?? null);
        const nextParent =
          input.parentRowId !== undefined ? input.parentRowId : (existing.parentRowId ?? null);
        const nextBusinessId =
          input.businessId !== undefined ? input.businessId : (existing.businessId ?? null);
        const nextCompletedAt =
          input.completedAt !== undefined ? input.completedAt : (existing.completedAt ?? null);
        // Re-allocate the slug only when the caller actually changed it,
        // otherwise keep the existing slug stable across edits.
        let nextSlug = existing.slug;
        if (input.slug !== undefined && input.slug !== existing.slug) {
          nextSlug = this.allocateRowSlug(existing.databaseId, input.slug, existing.id);
        } else if (!existing.slug) {
          nextSlug = this.allocateRowSlug(
            existing.databaseId,
            input.title ?? existing.title ?? existing.id,
            existing.id,
          );
        }
        this.db
          .prepare(
            `UPDATE database_rows SET title = ?, slug = ?, body_md = ?, values_json = ?, sort_order = ?, updated_at = ?, external_ref_json = ?, parent_row_id = ?, business_id = ?, completed_at = ? WHERE id = ?`,
          )
          .run(
            input.title ?? existing.title,
            nextSlug,
            input.body ?? existing.body,
            JSON.stringify(nextValues),
            input.sortOrder ?? existing.sortOrder,
            now,
            nextExternalRef ? JSON.stringify(nextExternalRef) : null,
            nextParent,
            nextBusinessId,
            nextCompletedAt,
            input.id,
          );
        return this.getRow(input.id)!;
      }
    }
    const id = input.id || `row_${randomUUID()}`;
    const sortOrder =
      input.sortOrder ??
      (() => {
        const last = this.db
          .prepare(
            `SELECT sort_order FROM database_rows WHERE database_id = ? ORDER BY sort_order DESC LIMIT 1`,
          )
          .get(input.databaseId) as { sort_order: number } | undefined;
        return last ? last.sort_order + 1000 : 1000;
      })();
    const slug = this.allocateRowSlug(input.databaseId, input.slug ?? input.title ?? id, id);
    this.db
      .prepare(
        `INSERT INTO database_rows (id, database_id, title, slug, body_md, values_json, sort_order, created_at, updated_at, external_ref_json, parent_row_id, business_id, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.databaseId,
        input.title ?? "",
        slug,
        input.body ?? null,
        JSON.stringify(input.values ?? {}),
        sortOrder,
        now,
        now,
        input.externalRef ? JSON.stringify(input.externalRef) : null,
        input.parentRowId ?? null,
        input.businessId ?? null,
        input.completedAt ?? null,
      );
    return this.getRow(id)!;
  }

  getRowBySlug(databaseId: string, slug: string): DatabaseRow | null {
    const row = this.db
      .prepare(`SELECT * FROM database_rows WHERE database_id = ? AND slug = ?`)
      .get(databaseId, slug) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  /** Lookup a row by its global id OR by `<databaseSlug>/<rowSlug>`. */
  getRowByIdOrPath(handle: string): DatabaseRow | null {
    if (handle.includes("/")) {
      const parsed = parseDatabaseUrl(handle);
      if (!parsed?.pageSlug) return null;
      const db = this.getDatabaseByIdOrSlug(parsed.databaseSlug);
      return db ? this.getRowBySlug(db.id, parsed.pageSlug) : null;
    }
    return this.getRow(handle);
  }

  /**
   * Resolve a slug-shaped path or full URL to a database (and optionally a
   * specific row/page). Accepts:
   *   - "/db/<dbSlug>"             → kind: "database"
   *   - "/<dbSlug>/<pageSlug>"     → kind: "row"
   *   - "https://app/db/<…>/<…>"   → same, ignoring host
   *   - bare ids (db_…, row_…)     → resolved if recognised
   * Returns null if nothing matches — callers can then fall back to treating
   * the input as an external URL.
   */
  resolvePath(input: string): {
    database: DatabaseRecord;
    row?: DatabaseRow;
  } | null {
    if (!input) return null;
    // Bare id forms — short-circuit before URL parsing.
    if (input.startsWith("row_")) {
      const row = this.getRow(input);
      if (!row) return null;
      const database = this.getDatabase(row.databaseId);
      return database ? { database, row } : null;
    }
    if (input.startsWith("db_")) {
      const database = this.getDatabase(input);
      return database ? { database } : null;
    }

    const parsed = parseDatabaseUrl(input);
    if (!parsed) return null;
    const database = this.getDatabaseByIdOrSlug(parsed.databaseSlug);
    if (!database) return null;
    if (!parsed.pageSlug) return { database };
    const row = this.getRowBySlug(database.id, parsed.pageSlug) ?? this.getRow(parsed.pageSlug);
    if (!row || row.databaseId !== database.id) return { database };
    return { database, row };
  }

  /**
   * Bulk-set business_id for a set of rows. The Business workspace uses this
   * to claim rows (assign to its business) or release them (pass null) without
   * a per-row upsert round-trip. Returns the number of rows actually changed.
   */
  scopeRowsToBusiness(input: {
    databaseId?: string;
    rowIds?: string[];
    businessId: string | null;
  }): number {
    if (input.rowIds && input.rowIds.length === 0) return 0;
    const now = Date.now();
    if (input.rowIds && input.rowIds.length > 0) {
      const placeholders = input.rowIds.map(() => "?").join(", ");
      const sql = `UPDATE database_rows SET business_id = ?, updated_at = ? WHERE id IN (${placeholders})`;
      const result = this.db.prepare(sql).run(input.businessId, now, ...input.rowIds);
      return result.changes;
    }
    if (input.databaseId) {
      const result = this.db
        .prepare(`UPDATE database_rows SET business_id = ?, updated_at = ? WHERE database_id = ?`)
        .run(input.businessId, now, input.databaseId);
      return result.changes;
    }
    return 0;
  }

  deleteRow(rowId: string): boolean {
    // Cascade delete to children first (self-referential, manual since
    // the FK was added by migration without ON DELETE CASCADE).
    const children = this.db
      .prepare(`SELECT id FROM database_rows WHERE parent_row_id = ?`)
      .all(rowId) as Array<{ id: string }>;
    for (const c of children) this.deleteRow(c.id);

    const result = this.db.prepare(`DELETE FROM database_rows WHERE id = ?`).run(rowId);
    if (result.changes > 0) {
      this.db.prepare(`DELETE FROM database_links WHERE row_id = ?`).run(rowId);
      return true;
    }
    return false;
  }

  // ── Tree / nested pages ──────────────────────────────────────────

  listChildRows(parentRowId: string): DatabaseRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM database_rows WHERE parent_row_id = ? ORDER BY sort_order ASC, created_at ASC`,
      )
      .all(parentRowId) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** Walk parent_row_id upwards; returns top-to-current order (breadcrumb). */
  getAncestors(rowId: string, limit = 32): DatabaseRow[] {
    const chain: DatabaseRow[] = [];
    const seen = new Set<string>();
    let current = this.getRow(rowId);
    while (current && chain.length < limit) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      chain.push(current);
      if (!current.parentRowId) break;
      current = this.getRow(current.parentRowId);
    }
    return chain.reverse();
  }

  /** Move a row to a new parent (same database). Rejects cycles. */
  moveRow(rowId: string, newParentRowId: string | null): DatabaseRow | null {
    const row = this.getRow(rowId);
    if (!row) return null;
    if (newParentRowId === rowId) throw new Error("A row cannot be its own parent");
    if (newParentRowId) {
      const parent = this.getRow(newParentRowId);
      if (!parent) throw new Error("Parent row not found");
      if (parent.databaseId !== row.databaseId) {
        throw new Error("Sub-pages must live in the same database as their parent");
      }
      // Cycle guard: walk the candidate parent's ancestors, reject if rowId appears.
      let cursor: DatabaseRow | null = parent;
      const seen = new Set<string>();
      while (cursor && cursor.parentRowId) {
        if (cursor.parentRowId === rowId) {
          throw new Error("Cycle detected — cannot nest a row under its own descendant");
        }
        if (seen.has(cursor.id)) break;
        seen.add(cursor.id);
        cursor = this.getRow(cursor.parentRowId);
      }
    }
    this.db
      .prepare(`UPDATE database_rows SET parent_row_id = ?, updated_at = ? WHERE id = ?`)
      .run(newParentRowId ?? null, Date.now(), rowId);
    return this.getRow(rowId);
  }

  // ── Links ────────────────────────────────────────────────────────

  linkRow(input: {
    rowId: string;
    targetKind: LinkTargetKind;
    targetId: string;
    propertyId?: string | null;
    label?: string | null;
  }): DatabaseLink {
    const id = `link_${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO database_links (id, row_id, target_kind, target_id, property_id, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.rowId,
        input.targetKind,
        input.targetId,
        input.propertyId ?? null,
        input.label ?? null,
        now,
      );
    return {
      id,
      rowId: input.rowId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      propertyId: input.propertyId ?? null,
      label: input.label ?? null,
      createdAt: now,
    };
  }

  unlinkRow(linkId: string): boolean {
    return this.db.prepare(`DELETE FROM database_links WHERE id = ?`).run(linkId).changes > 0;
  }

  listLinksForRow(rowId: string): DatabaseLink[] {
    return (
      this.db
        .prepare(`SELECT * FROM database_links WHERE row_id = ? ORDER BY created_at ASC`)
        .all(rowId) as Record<string, unknown>[]
    ).map(mapLink);
  }

  listLinksToTarget(targetKind: LinkTargetKind, targetId: string): DatabaseLink[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM database_links WHERE target_kind = ? AND target_id = ? ORDER BY created_at ASC`,
        )
        .all(targetKind, targetId) as Record<string, unknown>[]
    ).map(mapLink);
  }

  // ── System roles ─────────────────────────────────────────────────

  listSystemRoles(): SystemRoleAssignment[] {
    const rows = this.db
      .prepare(`SELECT role, database_id, updated_at FROM system_databases ORDER BY role ASC`)
      .all() as Array<{ role: string; database_id: string; updated_at: number }>;
    return rows.map((r) => ({
      role: r.role as SystemRole,
      databaseId: r.database_id,
      updatedAt: r.updated_at,
    }));
  }

  resolveSystemRole(role: SystemRole): {
    assignment: SystemRoleAssignment;
    database: DatabaseRecord;
    properties: DatabaseProperty[];
  } | null {
    const row = this.db
      .prepare(`SELECT role, database_id, updated_at FROM system_databases WHERE role = ?`)
      .get(role) as { role: string; database_id: string; updated_at: number } | undefined;
    if (!row) return null;
    const database = this.getDatabase(row.database_id);
    if (!database) {
      // Orphan — the target db was deleted. Clean up.
      this.db.prepare(`DELETE FROM system_databases WHERE role = ?`).run(role);
      return null;
    }
    return {
      assignment: {
        role: row.role as SystemRole,
        databaseId: row.database_id,
        updatedAt: row.updated_at,
      },
      database,
      properties: this.listProperties(database.id),
    };
  }

  setSystemRole(role: SystemRole, databaseId: string): SystemRoleAssignment {
    const database = this.getDatabase(databaseId);
    if (!database) throw new Error(`Database ${databaseId} not found`);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO system_databases (role, database_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(role) DO UPDATE SET database_id = excluded.database_id, updated_at = excluded.updated_at`,
      )
      .run(role, databaseId, now);
    return { role, databaseId, updatedAt: now };
  }

  clearSystemRole(role: SystemRole): boolean {
    return this.db.prepare(`DELETE FROM system_databases WHERE role = ?`).run(role).changes > 0;
  }

  /** Convenience: default-seed `role` to `databaseId` only if the role is unset. */
  defaultSystemRole(role: SystemRole, databaseId: string): void {
    const existing = this.db.prepare(`SELECT 1 FROM system_databases WHERE role = ?`).get(role);
    if (existing) return;
    this.setSystemRole(role, databaseId);
  }

  /* ─── Per-business role mappings ──────────────────────────────────
   * Lets each business own a dedicated CRM / leads / projects database.
   * Read order: per-business → global system_databases fallback.
   */

  resolveBusinessSystemRole(
    businessId: string,
    role: SystemRole,
  ): {
    assignment: SystemRoleAssignment;
    database: DatabaseRecord;
    properties: DatabaseProperty[];
  } | null {
    const row = this.db
      .prepare(
        `SELECT business_id, role, database_id, updated_at FROM business_role_databases WHERE business_id = ? AND role = ?`,
      )
      .get(businessId, role) as
      | { business_id: string; role: string; database_id: string; updated_at: number }
      | undefined;
    if (!row) return null;
    const database = this.getDatabase(row.database_id);
    if (!database) {
      this.db
        .prepare(`DELETE FROM business_role_databases WHERE business_id = ? AND role = ?`)
        .run(businessId, role);
      return null;
    }
    const properties = this.listProperties(database.id);
    return {
      assignment: {
        role: row.role as SystemRole,
        databaseId: row.database_id,
        updatedAt: row.updated_at,
      },
      database,
      properties,
    };
  }

  setBusinessSystemRole(
    businessId: string,
    role: SystemRole,
    databaseId: string,
  ): SystemRoleAssignment {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO business_role_databases (business_id, role, database_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(business_id, role)
         DO UPDATE SET database_id = excluded.database_id, updated_at = excluded.updated_at`,
      )
      .run(businessId, role, databaseId, now);
    return { role, databaseId, updatedAt: now };
  }

  clearBusinessSystemRole(businessId: string, role: SystemRole): boolean {
    return (
      this.db
        .prepare(`DELETE FROM business_role_databases WHERE business_id = ? AND role = ?`)
        .run(businessId, role).changes > 0
    );
  }

  listBusinessSystemRoles(businessId: string): SystemRoleAssignment[] {
    const rows = this.db
      .prepare(
        `SELECT role, database_id, updated_at FROM business_role_databases WHERE business_id = ? ORDER BY role ASC`,
      )
      .all(businessId) as Array<{ role: string; database_id: string; updated_at: number }>;
    return rows.map((r) => ({
      role: r.role as SystemRole,
      databaseId: r.database_id,
      updatedAt: r.updated_at,
    }));
  }
}

// ═══════════════════════════════════════════════════════════════════
// DEFAULT PROPERTIES FOR A BRAND-NEW NATIVE DATABASE
// ═══════════════════════════════════════════════════════════════════

type DefaultPropSeed = {
  id?: string;
  name: string;
  type: PropertyType;
  config?: PropertyConfig | null;
  hidden?: boolean;
};

function defaultPropertiesForNative(): DefaultPropSeed[] {
  return [
    { name: "Name", type: "title" },
    {
      name: "Status",
      type: "status",
      config: {
        options: [
          { id: "todo", name: "Todo", color: "#6b7280" },
          { id: "in_progress", name: "In Progress", color: "#3b82f6" },
          { id: "done", name: "Done", color: "#10b981" },
        ],
      },
    },
    { name: "Tags", type: "multiSelect", config: { options: [] } },
    { name: "Due", type: "date" },
    { name: "Notes", type: "richText" },
  ];
}

/**
 * Ensure the two built-in databases that shadow the existing kanban
 * Projects and Tasks exist. This is idempotent; it creates them once
 * so the UI / agent tools can reach kanban content through the same
 * db.* API.
 */
export function ensureKanbanBuiltInDatabases(store: DatabasesStore): {
  projectsDbId: string;
  tasksDbId: string;
} {
  let projectsDb = store.getDatabaseBySource("kanban-projects");
  if (!projectsDb) {
    projectsDb = store.createDatabase({
      name: "Projects",
      icon: "📁",
      description: "Kanban-backed projects (mirrored from the moltbot kanban).",
      source: "kanban-projects",
      properties: [
        { name: "Name", type: "title" },
        {
          name: "Status",
          type: "status",
          config: {
            options: [
              { id: "not_started", name: "Not started" },
              { id: "in_progress", name: "In progress" },
              { id: "completed", name: "Completed" },
              { id: "paused", name: "Paused" },
              { id: "cancelled", name: "Cancelled" },
            ],
          },
        },
        {
          name: "Priority",
          type: "select",
          config: {
            options: [
              { id: "immediate", name: "Immediate" },
              { id: "high", name: "High" },
              { id: "medium", name: "Medium" },
              { id: "low", name: "Low" },
            ],
          },
        },
        { name: "Description", type: "richText" },
      ],
    });
  }

  let tasksDb = store.getDatabaseBySource("kanban-tasks");
  if (!tasksDb) {
    tasksDb = store.createDatabase({
      name: "Tasks",
      icon: "✅",
      description: "Kanban-backed tasks (mirrored from the moltbot kanban).",
      source: "kanban-tasks",
      properties: [
        { name: "Name", type: "title" },
        {
          name: "Status",
          type: "status",
          config: {
            options: [
              { id: "todo", name: "To Do" },
              { id: "in_progress", name: "In Progress" },
              { id: "review", name: "Review / Blocked" },
              { id: "done", name: "Done" },
            ],
          },
        },
        {
          name: "Priority",
          type: "select",
          config: {
            options: [
              { id: "immediate", name: "Immediate" },
              { id: "high", name: "High" },
              { id: "medium", name: "Medium" },
              { id: "low", name: "Low" },
            ],
          },
        },
        { name: "Project", type: "relation" },
        { name: "Assignee", type: "person" },
        { name: "Due", type: "date" },
        { name: "Description", type: "richText" },
      ],
    });
  }

  // Default system roles to these stubs on first run. `defaultSystemRole`
  // is a no-op when the role already has an assignment, so user overrides
  // set via db.system.set are never clobbered.
  store.defaultSystemRole("projects", projectsDb.id);
  store.defaultSystemRole("tasks", tasksDb.id);

  // Also backfill any entries the legacy Notion Database Manager is still
  // tracking in notion-databases.json, so they surface in db.list alongside
  // everything else. Idempotent — deduped by notionDatabaseId.
  try {
    backfillFromNotionManager(store);
  } catch {
    // best-effort — never block kanban init if backfill fails
  }

  return { projectsDbId: projectsDb.id, tasksDbId: tasksDb.id };
}

// Unused but keep for future use (mirrors paths module's helper)
export function __dbPath(stateDir: string): string {
  return join(stateDir, "databases.db");
}
