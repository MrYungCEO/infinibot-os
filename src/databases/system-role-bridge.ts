/**
 * System-role bridge — the single helper every legacy storage handler
 * consults to answer: "for this role, do I read/write the user's database
 * (db_rows) or the legacy store?"
 *
 * Goal: a user who maps a database to a system role (notes, tasks,
 * projects, clients, leads) gets ONE source of truth — the database. Every
 * surface (UI, agent tools, Notion sync) reads and writes the same rows.
 *
 * Why this needed to exist:
 *   - Notes and Clients had two stores running in parallel with no sync.
 *   - Tasks/Projects had partial role-awareness in some paths.
 *   - Leads had a richer hierarchy in funnels.db than db_rows supports.
 *
 * The bridge does NOT try to abstract every operation. It exposes the
 * minimum primitive ops (list, get, upsert, delete) plus a single
 * `getRoleMode` check that lets each handler decide the routing itself.
 */

import { getDatabasesStore } from "./store.js";
import type { DatabaseRow, PropertyValue, SystemRole } from "./types.js";

export type RoleMode = "database" | "legacy";

export interface RoleResolution {
  mode: RoleMode;
  /** The mapped database id when mode === "database". */
  databaseId: string | null;
  /** Convenience: short id of the title property for the mapped database. */
  titlePropertyId?: string;
  /** Convenience: id of the body/markdown property, if one exists. */
  bodyPropertyId?: string;
}

/**
 * Resolve a role to its current storage mode. The check is per-call so
 * the answer reflects the live `system_databases` table — no caching at
 * this level, since map/unmap is rare and we want the change to take
 * effect immediately.
 */
export function getRoleMode(role: SystemRole): RoleResolution {
  try {
    const store = getDatabasesStore();
    const resolved = store.resolveSystemRole(role);
    if (!resolved || !resolved.database) return { mode: "legacy", databaseId: null };
    return {
      mode: "database",
      databaseId: resolved.database.id,
      titlePropertyId: pickTitleProperty(resolved.properties),
      bodyPropertyId: pickBodyProperty(resolved.properties),
    };
  } catch {
    return { mode: "legacy", databaseId: null };
  }
}

export function isRoleMapped(role: SystemRole): boolean {
  return getRoleMode(role).mode === "database";
}

function pickTitleProperty(
  props: Array<{ id: string; name: string; type: string }>,
): string | undefined {
  const title = props.find((p) => p.type === "title");
  if (title) return title.id;
  // Fall back to a property literally named "Name" or "Title".
  return (
    props.find((p) => p.name.toLowerCase() === "name")?.id ??
    props.find((p) => p.name.toLowerCase() === "title")?.id
  );
}

function pickBodyProperty(
  props: Array<{ id: string; name: string; type: string }>,
): string | undefined {
  // Most databases store the body as the row's `body_md` (not a property)
  // — the bridge's upsertRowAsRole writes to that field directly. This
  // helper is for databases that have an explicit "Body" / "Notes" /
  // "Content" rich_text property; readers can render whichever is set.
  const lc = (s: string) => s.toLowerCase();
  return (
    props.find((p) => lc(p.name) === "body" && p.type === "rich_text")?.id ??
    props.find((p) => lc(p.name) === "content" && p.type === "rich_text")?.id ??
    props.find((p) => lc(p.name) === "notes" && p.type === "rich_text")?.id
  );
}

/* ─── Read/write primitives ────────────────────────────────────────── */

export interface RoleListOptions {
  businessId?: string | null;
  limit?: number;
  offset?: number;
}

export interface RoleRowView {
  id: string;
  title: string;
  body: string;
  values: Record<string, PropertyValue>;
  createdAt: number;
  updatedAt: number;
  businessId: string | null;
  externalRef: DatabaseRow["externalRef"];
}

function rowToView(r: DatabaseRow): RoleRowView {
  return {
    id: r.id,
    title: r.title,
    body: r.body ?? "",
    values: r.values,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    businessId: r.businessId ?? null,
    externalRef: r.externalRef ?? null,
  };
}

export function listRowsForRole(role: SystemRole, opts: RoleListOptions = {}): RoleRowView[] {
  const r = getRoleMode(role);
  if (r.mode !== "database" || !r.databaseId) return [];
  const store = getDatabasesStore();
  const rows = store.listRows(r.databaseId, { businessId: opts.businessId });
  const sliced =
    opts.offset || opts.limit !== undefined
      ? rows.slice(
          opts.offset ?? 0,
          opts.limit !== undefined ? (opts.offset ?? 0) + opts.limit : undefined,
        )
      : rows;
  return sliced.map(rowToView);
}

export function getRowForRole(role: SystemRole, rowId: string): RoleRowView | null {
  const r = getRoleMode(role);
  if (r.mode !== "database" || !r.databaseId) return null;
  const store = getDatabasesStore();
  const row = store.getRow(rowId);
  if (!row || row.databaseId !== r.databaseId) return null;
  return rowToView(row);
}

export function upsertRowForRole(
  role: SystemRole,
  input: {
    id?: string;
    title?: string;
    body?: string | null;
    values?: Record<string, PropertyValue>;
    businessId?: string | null;
    externalRef?: import("./types.js").ExternalRef | null;
  },
): RoleRowView | null {
  const r = getRoleMode(role);
  if (r.mode !== "database" || !r.databaseId) return null;
  const store = getDatabasesStore();
  const row = store.upsertRow({
    id: input.id,
    databaseId: r.databaseId,
    title: input.title,
    body: input.body,
    values: input.values,
    businessId: input.businessId,
    externalRef: input.externalRef,
  });
  return rowToView(row);
}

export function deleteRowForRole(role: SystemRole, rowId: string): boolean {
  const r = getRoleMode(role);
  if (r.mode !== "database" || !r.databaseId) return false;
  const store = getDatabasesStore();
  // Confirm the row belongs to the mapped database before deleting — guard
  // against caller passing a row id from an unrelated database.
  const row = store.getRow(rowId);
  if (!row || row.databaseId !== r.databaseId) return false;
  return store.deleteRow(rowId);
}

/* ─── Migration helpers ────────────────────────────────────────────── */

export interface MigrationResult {
  role: SystemRole;
  databaseId: string;
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * One-shot importer: feed a stream of legacy records into the role's
 * mapped database. Idempotent — records carrying an externalRef that
 * already exists are skipped, so re-running the migration is safe.
 */
export function importLegacyRecordsToRole(
  role: SystemRole,
  records: Array<{
    legacyId: string;
    title: string;
    body?: string | null;
    values?: Record<string, PropertyValue>;
    businessId?: string | null;
    createdAt?: number;
  }>,
): MigrationResult {
  const result: MigrationResult = {
    role,
    databaseId: "",
    imported: 0,
    skipped: 0,
    errors: [],
  };

  const r = getRoleMode(role);
  if (r.mode !== "database" || !r.databaseId) {
    result.errors.push(`no database mapped for role=${role}; assign one in /databases first`);
    return result;
  }
  result.databaseId = r.databaseId;

  const store = getDatabasesStore();
  const existing = store.listRows(r.databaseId);

  // ExternalRef is Notion-only by design. To mark a row as "imported
  // from a legacy infinibot store" we stash a marker inside the row's
  // values map under a reserved key. Idempotency: skip any row whose
  // marker matches the legacy id we're about to import.
  const LEGACY_MARKER_KEY = `_infinibot_legacy_${role}`;
  const seenLegacyIds = new Set<string>();
  for (const row of existing) {
    const marker = row.values?.[LEGACY_MARKER_KEY];
    if (marker && typeof marker === "object" && "value" in (marker as Record<string, unknown>)) {
      const v = (marker as { value: unknown }).value;
      if (typeof v === "string") seenLegacyIds.add(v);
    } else if (typeof marker === "string") {
      seenLegacyIds.add(marker);
    }
  }

  for (const rec of records) {
    if (seenLegacyIds.has(rec.legacyId)) {
      result.skipped++;
      continue;
    }
    try {
      const values = { ...rec.values } as Record<string, PropertyValue>;
      // Store as a plain text-shaped marker; the rich row-property
      // shapes wrap values, but a primitive string also round-trips.
      (values as Record<string, unknown>)[LEGACY_MARKER_KEY] = rec.legacyId;
      store.upsertRow({
        databaseId: r.databaseId,
        title: rec.title,
        body: rec.body ?? null,
        values,
        businessId: rec.businessId ?? null,
      });
      result.imported++;
    } catch (err) {
      result.errors.push(`${rec.legacyId}: ${(err as Error).message}`);
    }
  }
  return result;
}

/* ─── Per-business resolution ──────────────────────────────────────
 * Some roles (clients, leads) are scoped per business — each business
 * owns its own CRM / leads database. These helpers resolve in two steps:
 *   1. Look up business-specific mapping (business_role_databases)
 *   2. Fall back to the global mapping (system_databases) when the
 *      business doesn't have its own dedicated database
 *
 * Auto-ensure helpers create + map a dedicated database on demand so
 * the UI never has to do the wiring manually.
 */

export interface PerBusinessResolution extends RoleResolution {
  businessId: string;
  /** True if the resolution came from the per-business mapping (not the global fallback). */
  perBusiness: boolean;
}

export function getRoleModeForBusiness(
  role: SystemRole,
  businessId: string,
): PerBusinessResolution {
  try {
    const store = getDatabasesStore();
    const perBiz = store.resolveBusinessSystemRole(businessId, role);
    if (perBiz?.database) {
      return {
        mode: "database",
        databaseId: perBiz.database.id,
        titlePropertyId: pickTitleProperty(perBiz.properties),
        bodyPropertyId: pickBodyProperty(perBiz.properties),
        businessId,
        perBusiness: true,
      };
    }
    const global = store.resolveSystemRole(role);
    if (global?.database) {
      return {
        mode: "database",
        databaseId: global.database.id,
        titlePropertyId: pickTitleProperty(global.properties),
        bodyPropertyId: pickBodyProperty(global.properties),
        businessId,
        perBusiness: false,
      };
    }
    return { mode: "legacy", databaseId: null, businessId, perBusiness: false };
  } catch {
    return { mode: "legacy", databaseId: null, businessId, perBusiness: false };
  }
}

/**
 * Make sure the business has a dedicated database for `role`. Creates
 * one if missing, maps it via business_role_databases, and returns the
 * resolved (always perBusiness=true) record.
 *
 * `seedName` is used when creating a fresh database. `seedDescription`
 * is optional.
 */
export function ensureBusinessRoleDatabase(
  businessId: string,
  role: SystemRole,
  seedName: string,
  seedDescription?: string,
): PerBusinessResolution {
  const store = getDatabasesStore();
  const existing = store.resolveBusinessSystemRole(businessId, role);
  if (existing?.database) {
    return {
      mode: "database",
      databaseId: existing.database.id,
      titlePropertyId: pickTitleProperty(existing.properties),
      bodyPropertyId: pickBodyProperty(existing.properties),
      businessId,
      perBusiness: true,
    };
  }
  const created = store.createDatabase({ name: seedName, description: seedDescription });
  store.setBusinessSystemRole(businessId, role, created.id);
  const props = store.listProperties(created.id);
  return {
    mode: "database",
    databaseId: created.id,
    titlePropertyId: pickTitleProperty(props),
    bodyPropertyId: pickBodyProperty(props),
    businessId,
    perBusiness: true,
  };
}

export function listRowsForBusinessRole(
  role: SystemRole,
  businessId: string,
  opts: { limit?: number; offset?: number } = {},
): RoleRowView[] {
  const r = getRoleModeForBusiness(role, businessId);
  if (r.mode !== "database" || !r.databaseId) return [];
  const store = getDatabasesStore();
  // When the mapping is per-business, all rows in the dedicated database
  // are by definition for that business — no businessId filter needed
  // (and the user's table may not even have a businessId column). When
  // we fall back to the global mapping, scope rows by businessId.
  const rows = r.perBusiness
    ? store.listRows(r.databaseId)
    : store.listRows(r.databaseId, { businessId });
  const sliced =
    opts.offset || opts.limit !== undefined
      ? rows.slice(
          opts.offset ?? 0,
          opts.limit !== undefined ? (opts.offset ?? 0) + opts.limit : undefined,
        )
      : rows;
  return sliced.map(rowToView);
}

export function getRowForBusinessRole(
  role: SystemRole,
  businessId: string,
  rowId: string,
): RoleRowView | null {
  const r = getRoleModeForBusiness(role, businessId);
  if (r.mode !== "database" || !r.databaseId) return null;
  const store = getDatabasesStore();
  const row = store.getRow(rowId);
  if (!row || row.databaseId !== r.databaseId) return null;
  if (!r.perBusiness && row.businessId && row.businessId !== businessId) return null;
  return rowToView(row);
}

export function upsertRowForBusinessRole(
  role: SystemRole,
  businessId: string,
  input: {
    id?: string;
    title?: string;
    body?: string | null;
    values?: Record<string, PropertyValue>;
    externalRef?: import("./types.js").ExternalRef | null;
  },
): RoleRowView | null {
  const r = getRoleModeForBusiness(role, businessId);
  if (r.mode !== "database" || !r.databaseId) return null;
  const store = getDatabasesStore();
  const row = store.upsertRow({
    id: input.id,
    databaseId: r.databaseId,
    title: input.title,
    body: input.body,
    values: input.values,
    // Per-business mappings have a dedicated database, but we still
    // stamp businessId on rows so a future schema change to share
    // databases is non-breaking.
    businessId,
    externalRef: input.externalRef,
  });
  return rowToView(row);
}

/**
 * Per-business variant of importLegacyRecordsToRole. Writes into the
 * business's dedicated database (not the global role mapping).
 */
export function importLegacyRecordsToBusinessRole(
  role: SystemRole,
  businessId: string,
  records: Array<{
    legacyId: string;
    title: string;
    body?: string | null;
    values?: Record<string, PropertyValue>;
    createdAt?: number;
  }>,
): MigrationResult {
  const result: MigrationResult = {
    role,
    databaseId: "",
    imported: 0,
    skipped: 0,
    errors: [],
  };
  const r = getRoleModeForBusiness(role, businessId);
  if (r.mode !== "database" || !r.databaseId) {
    result.errors.push(`no database mapped for role=${role}, business=${businessId}`);
    return result;
  }
  result.databaseId = r.databaseId;

  const store = getDatabasesStore();
  const existing = store.listRows(r.databaseId);
  const LEGACY_MARKER_KEY = `_infinibot_legacy_${role}`;
  const seenLegacyIds = new Set<string>();
  for (const row of existing) {
    const marker = row.values?.[LEGACY_MARKER_KEY];
    if (typeof marker === "string") seenLegacyIds.add(marker);
    else if (
      marker &&
      typeof marker === "object" &&
      "value" in (marker as Record<string, unknown>)
    ) {
      const v = (marker as { value: unknown }).value;
      if (typeof v === "string") seenLegacyIds.add(v);
    }
  }

  for (const rec of records) {
    if (seenLegacyIds.has(rec.legacyId)) {
      result.skipped++;
      continue;
    }
    try {
      const values = { ...rec.values } as Record<string, PropertyValue>;
      (values as Record<string, unknown>)[LEGACY_MARKER_KEY] = rec.legacyId;
      store.upsertRow({
        databaseId: r.databaseId,
        title: rec.title,
        body: rec.body ?? null,
        values,
        businessId,
      });
      result.imported++;
    } catch (err) {
      result.errors.push(`${rec.legacyId}: ${(err as Error).message}`);
    }
  }
  return result;
}

export function deleteRowForBusinessRole(
  role: SystemRole,
  businessId: string,
  rowId: string,
): boolean {
  const r = getRoleModeForBusiness(role, businessId);
  if (r.mode !== "database" || !r.databaseId) return false;
  const store = getDatabasesStore();
  const row = store.getRow(rowId);
  if (!row || row.databaseId !== r.databaseId) return false;
  if (!r.perBusiness && row.businessId && row.businessId !== businessId) return false;
  return store.deleteRow(rowId);
}

/* ─── Status snapshot (for the /databases UI + agents) ─────────────── */

export interface BridgeStatus {
  role: SystemRole;
  mode: RoleMode;
  databaseId: string | null;
  databaseName?: string;
  rowCount?: number;
  legacyCount?: number;
  drift: "in_sync" | "legacy_only" | "database_only" | "mixed";
}

/**
 * Cheap status for one role. Used by the audit endpoint that powers
 * the /databases "System roles" panel: lets the UI show "Notes — 14
 * file notes, 0 in database; click Migrate to unify".
 *
 * `legacyCount` is supplied by the caller (each role has a different
 * legacy store, this module stays pure).
 */
/**
 * Per-business variant of describeRoleBridge. Reports the per-business
 * database when one is mapped; falls back to the global mapping
 * description otherwise.
 */
export function describeBusinessRoleBridge(
  role: SystemRole,
  businessId: string,
  legacyCount: number,
): BridgeStatus & { businessId: string; perBusiness: boolean } {
  const r = getRoleModeForBusiness(role, businessId);
  if (r.mode !== "database" || !r.databaseId) {
    return {
      role,
      mode: "legacy",
      databaseId: null,
      legacyCount,
      drift: legacyCount > 0 ? "legacy_only" : "in_sync",
      businessId,
      perBusiness: false,
    };
  }
  const store = getDatabasesStore();
  const db = store.getDatabase(r.databaseId);
  const rows = r.perBusiness
    ? store.listRows(r.databaseId)
    : store.listRows(r.databaseId, { businessId });
  const rowCount = rows.length;
  let drift: BridgeStatus["drift"] = "in_sync";
  if (legacyCount > 0 && rowCount > 0) drift = "mixed";
  else if (legacyCount > 0) drift = "legacy_only";
  else if (rowCount > 0) drift = "database_only";
  return {
    role,
    mode: "database",
    databaseId: r.databaseId,
    databaseName: db?.name,
    rowCount,
    legacyCount,
    drift,
    businessId,
    perBusiness: r.perBusiness,
  };
}

export function describeRoleBridge(role: SystemRole, legacyCount: number): BridgeStatus {
  const r = getRoleMode(role);
  if (r.mode !== "database" || !r.databaseId) {
    return {
      role,
      mode: "legacy",
      databaseId: null,
      legacyCount,
      drift: legacyCount > 0 ? "legacy_only" : "in_sync",
    };
  }
  const store = getDatabasesStore();
  const db = store.getDatabase(r.databaseId);
  const rows = store.listRows(r.databaseId);
  const rowCount = rows.length;
  let drift: BridgeStatus["drift"] = "in_sync";
  if (legacyCount > 0 && rowCount > 0) drift = "mixed";
  else if (legacyCount > 0) drift = "legacy_only";
  else if (rowCount > 0) drift = "database_only";
  return {
    role,
    mode: "database",
    databaseId: r.databaseId,
    databaseName: db?.name,
    rowCount,
    legacyCount,
    drift,
  };
}
