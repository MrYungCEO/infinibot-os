/**
 * Gateway Methods — Generic databases (Notion-style tables in SQLite).
 *
 * All database / row content lives in src/databases/store.ts. These RPCs
 * are the surface the UI and agent tools call to read and mutate them.
 *
 * Federation: in satellite mode all db.* calls are proxied to the master
 * gateway via applySatelliteProxy(). Local handlers run only when the
 * satellite is offline/disconnected (graceful degradation).
 */

import { DatabasesStore, getDatabasesStore } from "../../databases/store.js";
import { importFromNotion } from "../../databases/notion-import.js";
import { backfillFromNotionManager } from "../../databases/notion-manager-backfill.js";
import {
  deleteKanbanRow,
  getKanbanRow,
  isKanbanSource,
  listKanbanRows,
  queryKanbanRows,
  upsertKanbanRow,
  kanbanNotionWritable,
} from "../../databases/kanban-adapter.js";
import {
  isNotionCircuitOpen,
  tripNotionCircuit,
  upsertKanbanRowLocally,
} from "../../databases/kanban-store-ops.js";
import {
  archiveRowInNotion,
  isSyncEnabled,
  markSyncEnabled,
  pullDatabaseFromNotion,
  pushRowToNotion,
} from "../../databases/notion-sync.js";
import type {
  LinkTargetKind,
  PropertyConfig,
  PropertyType,
  PropertyValue,
  RowFilter,
  RowSort,
  SystemRole,
} from "../../databases/types.js";
import { SYSTEM_ROLES } from "../../databases/types.js";
import type { GatewayRequestHandlers } from "./types.js";
import { applySatelliteProxy } from "../../federation/satellite-context.js";

function store(): DatabasesStore {
  // getDatabasesStore now seeds kanban stubs + default roles + legacy backfill
  // on first call per state dir, so this wrapper no longer needs its own flag.
  return getDatabasesStore();
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStrOrNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === "string" ? v : undefined;
}

const _rawDatabasesHandlers: GatewayRequestHandlers = {
  // ── Databases ────────────────────────────────────────────────────

  "db.list": async ({ respond }) => {
    try {
      const databases = store().listDatabases();
      respond(true, { databases });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.get": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      const slug = asStr(params.slug);
      if (!id && !slug) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id or slug is required" });
        return;
      }
      const s = store();
      // Caller may pass either id or slug; we accept both transparently so
      // URL-driven UI code doesn't need a separate lookup step.
      const database = id ? s.getDatabaseByIdOrSlug(id) : slug ? s.getDatabaseBySlug(slug) : null;
      if (!database) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Database ${id ?? slug} not found`,
        });
        return;
      }
      const properties = s.listProperties(database.id);
      respond(true, { database, properties });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.getBySlug": async ({ respond, params }) => {
    try {
      const slug = asStr(params.slug);
      if (!slug) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "slug is required" });
        return;
      }
      const s = store();
      const database = s.getDatabaseBySlug(slug);
      if (!database) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Database '${slug}' not found` });
        return;
      }
      respond(true, { database, properties: s.listProperties(database.id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Resolve a slug path or full URL to its target. Used by the task picker
   * and any deep-link route. Returns one of:
   *   { kind: "database", database, properties }
   *   { kind: "row", database, row, properties }
   *   { kind: "external", url }            — input didn't match any local entity
   */
  "db.resolveUrl": async ({ respond, params }) => {
    try {
      const url = asStr(params.url) ?? asStr(params.path) ?? asStr(params.slug);
      if (!url) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "url, path or slug is required",
        });
        return;
      }
      const s = store();
      const resolved = s.resolvePath(url);
      if (!resolved) {
        respond(true, { kind: "external", url });
        return;
      }
      const properties = s.listProperties(resolved.database.id);
      if (resolved.row) {
        respond(true, {
          kind: "row",
          database: resolved.database,
          row: resolved.row,
          properties,
        });
        return;
      }
      respond(true, { kind: "database", database: resolved.database, properties });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.create": async ({ respond, params }) => {
    try {
      const name = asStr(params.name);
      if (!name) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "name is required" });
        return;
      }
      const database = store().createDatabase({
        name,
        slug: asStr(params.slug),
        icon: asStrOrNull(params.icon) ?? null,
        description: asStrOrNull(params.description) ?? null,
        meta: (params.meta as Record<string, unknown>) ?? {},
        properties: Array.isArray(params.properties)
          ? (params.properties as Array<{
              id?: string;
              name: string;
              type: PropertyType;
              config?: PropertyConfig | null;
              hidden?: boolean;
            }>)
          : undefined,
      });
      const properties = store().listProperties(database.id);
      respond(true, { database, properties });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.update": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id is required" });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (params.name !== undefined) patch.name = params.name;
      if (params.slug !== undefined) patch.slug = asStr(params.slug);
      if (params.icon !== undefined) patch.icon = asStrOrNull(params.icon) ?? null;
      if (params.description !== undefined)
        patch.description = asStrOrNull(params.description) ?? null;
      if (params.meta !== undefined) patch.meta = params.meta;
      const database = store().updateDatabase(
        id,
        patch as Parameters<DatabasesStore["updateDatabase"]>[1],
      );
      if (!database) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Database ${id} not found` });
        return;
      }
      respond(true, { database });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.delete": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id is required" });
        return;
      }
      const ok = store().deleteDatabase(id);
      respond(true, { deleted: ok });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Properties ────────────────────────────────────────────────────

  "db.properties.list": async ({ respond, params }) => {
    try {
      const id = asStr(params.databaseId);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "databaseId is required" });
        return;
      }
      respond(true, { properties: store().listProperties(id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.properties.create": async ({ respond, params }) => {
    try {
      const databaseId = asStr(params.databaseId);
      const name = asStr(params.name);
      const type = asStr(params.type) as PropertyType | undefined;
      if (!databaseId || !name || !type) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "databaseId, name and type are required",
        });
        return;
      }
      const property = store().createProperty({
        databaseId,
        name,
        type,
        config: (params.config as PropertyConfig | null | undefined) ?? null,
        hidden: Boolean(params.hidden),
      });
      respond(true, { property });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.properties.update": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id is required" });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (params.name !== undefined) patch.name = params.name;
      if (params.type !== undefined) patch.type = params.type;
      if (params.config !== undefined) patch.config = params.config;
      if (params.sortOrder !== undefined) patch.sortOrder = params.sortOrder;
      if (params.hidden !== undefined) patch.hidden = Boolean(params.hidden);
      const property = store().updateProperty(
        id,
        patch as Parameters<DatabasesStore["updateProperty"]>[1],
      );
      if (!property) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Property ${id} not found` });
        return;
      }
      respond(true, { property });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.properties.delete": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id is required" });
        return;
      }
      respond(true, { deleted: store().deleteProperty(id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Rows ──────────────────────────────────────────────────────────

  "db.rows.list": async ({ respond, params }) => {
    try {
      const databaseId = asStr(params.databaseId);
      if (!databaseId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "databaseId is required" });
        return;
      }
      // businessId tri-state:
      //   - omitted → all rows
      //   - null    → only rows with no business assignment
      //   - "abc"   → only rows scoped to that business
      const rawBiz = (params as Record<string, unknown>).businessId;
      const businessId =
        rawBiz === undefined ? undefined : rawBiz === null ? null : (asStr(rawBiz) ?? null);
      const s = store();
      const db = s.getDatabase(databaseId);
      if (db && isKanbanSource(db.source)) {
        // Kanban-source rows resolve businessId through project meta:
        // projects directly via project_meta.businessId, tasks via their
        // parent project. Pass the filter through so the workspace counts
        // and per-business gallery scope correctly.
        const rows = await listKanbanRows(s, db, { businessId });
        respond(true, { rows, source: db.source });
        return;
      }
      respond(true, { rows: s.listRows(databaseId, { businessId }) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.get": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id is required" });
        return;
      }
      const s = store();
      // Kanban-sourced rows have ids of the form `kanban_<notionPageId>`; the
      // generic store won't have them. Route through the adapter when the
      // id matches that prefix. Ask for the body so the full-page view gets
      // the Notion page blocks rendered as markdown.
      if (id.startsWith("kanban_")) {
        for (const src of ["kanban-projects", "kanban-tasks"] as const) {
          const db = s.getDatabaseBySource(src);
          if (!db) continue;
          const row = await getKanbanRow(s, db, id, { withBody: true });
          if (row) {
            respond(true, { row, links: s.listLinksForRow(id) });
            return;
          }
        }
        respond(false, undefined, { code: "NOT_FOUND", message: `Row ${id} not found` });
        return;
      }
      const row = s.getRow(id);
      if (!row) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Row ${id} not found` });
        return;
      }
      respond(true, { row, links: s.listLinksForRow(id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Lookup a row by its slug within a database. The database can be
   * identified by id or slug — same input as `db.get`.
   */
  "db.rows.getBySlug": async ({ respond, params }) => {
    try {
      const databaseHandle = asStr(params.databaseId) ?? asStr(params.databaseSlug);
      const slug = asStr(params.slug);
      if (!databaseHandle || !slug) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "databaseId (or databaseSlug) and slug are required",
        });
        return;
      }
      const s = store();
      const database = s.getDatabaseByIdOrSlug(databaseHandle);
      if (!database) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Database '${databaseHandle}' not found`,
        });
        return;
      }
      const row = s.getRowBySlug(database.id, slug);
      if (!row) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Row '${slug}' not found in database '${database.slug}'`,
        });
        return;
      }
      respond(true, { row, database, links: s.listLinksForRow(row.id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.query": async ({ respond, params }) => {
    try {
      const databaseId = asStr(params.databaseId);
      if (!databaseId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "databaseId is required" });
        return;
      }
      const rawBiz = (params as Record<string, unknown>).businessId;
      const businessId =
        rawBiz === undefined ? undefined : rawBiz === null ? null : (asStr(rawBiz) ?? null);
      // total must be the count *before* the limit/offset cap — otherwise
      // a "give me the count" call (limit:0) always returns 0, which is
      // exactly what made the workspace's per-role tiles show 0 even when
      // the database had rows. Compute total from the unsliced result, then
      // apply pagination to the response payload.
      const offset = typeof params.offset === "number" ? params.offset : 0;
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      const s = store();
      const db = s.getDatabase(databaseId);
      if (db && isKanbanSource(db.source)) {
        // Forward businessId — the kanban adapter resolves it through
        // project_meta (projects directly, tasks via parent project). Without
        // this, per-business workspace counts collapse to the all-business
        // total.
        const all = await queryKanbanRows(s, db, {
          filter: params.filter as RowFilter | undefined,
          sorts: params.sorts as RowSort[] | undefined,
          businessId,
        });
        const total = all.length;
        const sliced = limit != null ? all.slice(offset, offset + limit) : all.slice(offset);
        respond(true, { rows: sliced, total, source: db.source });
        return;
      }
      const all = s.queryRows({
        databaseId,
        filter: params.filter as RowFilter | undefined,
        sorts: params.sorts as RowSort[] | undefined,
        businessId,
      });
      const total = all.length;
      const sliced = limit != null ? all.slice(offset, offset + limit) : all.slice(offset);
      respond(true, { rows: sliced, total });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.upsert": async ({ respond, params }) => {
    try {
      const databaseId = asStr(params.databaseId);
      if (!databaseId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "databaseId is required" });
        return;
      }
      const targetDb = store().getDatabase(databaseId);
      if (targetDb && isKanbanSource(targetDb.source)) {
        const patch = {
          id: asStr(params.id),
          title: asStr(params.title),
          body: asStrOrNull(params.body),
          values: (params.values as Record<string, PropertyValue> | undefined) ?? undefined,
        };
        // Notion is an optional mirror: only write through it for new rows or
        // rows that already have a Notion page (`kanban_<pageId>`), and only
        // while it is connected and answering. Otherwise — or if the Notion
        // call fails — save locally; the outbox mirrors it later.
        const viaNotion =
          kanbanNotionWritable(targetDb.source) &&
          !isNotionCircuitOpen() &&
          (!patch.id || patch.id.startsWith("kanban_"));
        if (viaNotion) {
          try {
            const row = await upsertKanbanRow(store(), targetDb, patch);
            respond(true, { row });
            return;
          } catch (e) {
            tripNotionCircuit(e);
            console.warn(
              "[databases] kanban row: Notion unavailable, saved locally (sync queued):",
              e instanceof Error ? e.message : String(e),
            );
            if (patch.id?.startsWith("kanban_")) {
              // An existing Notion-only row has no local copy to update.
              respond(false, undefined, {
                code: "UNAVAILABLE",
                message: "Notion is unreachable right now — try again in a moment",
              });
              return;
            }
          }
        }
        respond(true, { row: upsertKanbanRowLocally(targetDb, patch), syncPending: viaNotion });
        return;
      }
      const rawBiz = (params as Record<string, unknown>).businessId;
      const businessId =
        rawBiz === undefined ? undefined : rawBiz === null ? null : (asStr(rawBiz) ?? null);
      const row = store().upsertRow({
        id: asStr(params.id),
        databaseId,
        title: asStr(params.title),
        slug: asStr(params.slug),
        body: asStrOrNull(params.body),
        values: (params.values as Record<string, PropertyValue> | undefined) ?? undefined,
        sortOrder: typeof params.sortOrder === "number" ? params.sortOrder : undefined,
        businessId,
      });
      respond(true, { row });

      // Fire-and-forget Notion push when this database has 2-way sync on.
      const db = store().getDatabase(databaseId);
      if (db && isSyncEnabled(db)) {
        void pushRowToNotion(store(), row.id).catch(() => {
          /* log? for now swallow — sync errors shouldn't fail the write */
        });
      }
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.delete": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id is required" });
        return;
      }
      if (id.startsWith("kanban_")) {
        try {
          await deleteKanbanRow(id);
          respond(true, { deleted: true });
        } catch (e) {
          respond(false, undefined, {
            code: "INTERNAL_ERROR",
            message: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }
      // Snapshot before delete so we can archive the Notion page if syncing.
      const row = store().getRow(id);
      const db = row ? store().getDatabase(row.databaseId) : null;
      const shouldArchive = Boolean(row && db && isSyncEnabled(db) && row.externalRef?.externalId);

      const deleted = store().deleteRow(id);
      respond(true, { deleted });

      if (shouldArchive && row) {
        void archiveRowInNotion(row).catch(() => {
          /* swallow — archive is best-effort */
        });
      }
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Links ────────────────────────────────────────────────────────

  /**
   * Bulk-set business_id on a set of rows. Used by the Business workspace
   * to claim existing legacy rows under a business (one-shot migration) or
   * to release them by passing businessId: null. Either rowIds OR databaseId
   * must be provided; rowIds wins when both are present.
   */
  "db.rows.scope": async ({ respond, params }) => {
    try {
      const rawBiz = (params as Record<string, unknown>).businessId;
      // Distinguish missing (error) from explicit null (release scope).
      if (rawBiz === undefined) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "businessId is required (use null to release scope)",
        });
        return;
      }
      const businessId = rawBiz === null ? null : (asStr(rawBiz) ?? null);
      const rowIds = Array.isArray(params.rowIds)
        ? (params.rowIds as unknown[]).map((v) => String(v)).filter(Boolean)
        : undefined;
      const databaseId = asStr(params.databaseId);
      if (!rowIds?.length && !databaseId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "either rowIds or databaseId is required",
        });
        return;
      }
      const updated = store().scopeRowsToBusiness({ rowIds, databaseId, businessId });
      respond(true, { updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.link": async ({ respond, params }) => {
    try {
      const rowId = asStr(params.rowId);
      const targetKind = asStr(params.targetKind) as LinkTargetKind | undefined;
      const targetId = asStr(params.targetId);
      if (!rowId || !targetKind || !targetId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "rowId, targetKind and targetId are required",
        });
        return;
      }
      const link = store().linkRow({
        rowId,
        targetKind,
        targetId,
        propertyId: asStrOrNull(params.propertyId),
        label: asStrOrNull(params.label),
      });
      respond(true, { link });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.unlink": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id is required" });
        return;
      }
      respond(true, { deleted: store().unlinkRow(id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── System role registry ────────────────────────────────────────

  "db.system.list": async ({ respond }) => {
    try {
      const s = store();
      const assignments = s.listSystemRoles();
      const roles: Record<string, SystemRole> = {};
      for (const r of SYSTEM_ROLES) roles[r] = r; // echo the known-role enum
      respond(true, {
        roles: SYSTEM_ROLES,
        assignments,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Default selectables for the task-association picker.
   * Returns one entry per system role with the resolved database (id, slug,
   * name, icon) so the UI can render them as quick-pick options without
   * extra round-trips. Custom DBs/pages are still reachable via the slug or
   * URL inputs that drive `db.resolveUrl`.
   */
  "db.system.defaults": async ({ respond }) => {
    try {
      const s = store();
      const defaults = SYSTEM_ROLES.map((role) => {
        const resolved = s.resolveSystemRole(role);
        if (!resolved) return { role, database: null };
        return {
          role,
          database: {
            id: resolved.database.id,
            slug: resolved.database.slug,
            name: resolved.database.name,
            icon: resolved.database.icon,
            description: resolved.database.description,
            source: resolved.database.source,
          },
        };
      });
      respond(true, { defaults });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.system.resolve": async ({ respond, params }) => {
    try {
      const role = asStr(params.role) as SystemRole | undefined;
      if (!role || !SYSTEM_ROLES.includes(role)) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: `role must be one of: ${SYSTEM_ROLES.join(", ")}`,
        });
        return;
      }
      const resolved = store().resolveSystemRole(role);
      respond(true, { role, resolved });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.system.set": async ({ respond, params }) => {
    try {
      const role = asStr(params.role) as SystemRole | undefined;
      const databaseId = asStr(params.databaseId);
      if (!role || !SYSTEM_ROLES.includes(role) || !databaseId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: `Provide role (${SYSTEM_ROLES.join("|")}) and databaseId`,
        });
        return;
      }
      const assignment = store().setSystemRole(role, databaseId);
      respond(true, { assignment });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.system.backfillNotionManager": async ({ respond }) => {
    try {
      const report = backfillFromNotionManager(store());
      respond(true, report);
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.system.clear": async ({ respond, params }) => {
    try {
      const role = asStr(params.role) as SystemRole | undefined;
      if (!role || !SYSTEM_ROLES.includes(role)) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: `role must be one of: ${SYSTEM_ROLES.join(", ")}`,
        });
        return;
      }
      respond(true, { cleared: store().clearSystemRole(role) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Two-way sync (per-database, opt-in) ─────────────────────────

  "db.sync.enable": async ({ respond, params }) => {
    try {
      const databaseId = asStr(params.databaseId);
      if (!databaseId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "databaseId is required" });
        return;
      }
      const db = markSyncEnabled(store(), databaseId, true);
      if (!db) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Database ${databaseId} not found`,
        });
        return;
      }
      respond(true, { database: db });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.sync.disable": async ({ respond, params }) => {
    try {
      const databaseId = asStr(params.databaseId);
      if (!databaseId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "databaseId is required" });
        return;
      }
      const db = markSyncEnabled(store(), databaseId, false);
      if (!db) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Database ${databaseId} not found`,
        });
        return;
      }
      respond(true, { database: db });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.sync.status": async ({ respond, params }) => {
    try {
      const databaseId = asStr(params.databaseId);
      if (!databaseId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "databaseId is required" });
        return;
      }
      const db = store().getDatabase(databaseId);
      if (!db) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Database ${databaseId} not found`,
        });
        return;
      }
      respond(true, {
        databaseId,
        enabled: isSyncEnabled(db),
        notionDatabaseId:
          typeof db.meta?.notionDatabaseId === "string" ? db.meta.notionDatabaseId : null,
        lastPulledAt:
          typeof db.meta?.notionLastPulledAt === "number" ? db.meta.notionLastPulledAt : null,
        lastPushedAt:
          typeof db.meta?.notionLastPushedAt === "number" ? db.meta.notionLastPushedAt : null,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.sync.run": async ({ respond, params }) => {
    try {
      const databaseId = asStr(params.databaseId);
      if (!databaseId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "databaseId is required" });
        return;
      }
      // Pull first (remote wins for rows not touched locally since last sync).
      const pullReport = await pullDatabaseFromNotion(store(), databaseId);
      // Then push any local rows that changed since last push.
      let pushed = 0;
      const warnings: string[] = [...pullReport.warnings];
      const db = store().getDatabase(databaseId);
      const lastPushed =
        typeof db?.meta?.notionLastPushedAt === "number" ? db.meta.notionLastPushedAt : 0;
      const rows = store().listRows(databaseId);
      for (const row of rows) {
        if (row.updatedAt <= lastPushed) continue;
        // Only push rows whose updatedAt beats their last sync timestamp
        if (row.externalRef && row.updatedAt <= row.externalRef.lastSyncedAt) continue;
        try {
          await pushRowToNotion(store(), row.id);
          pushed++;
        } catch (e) {
          warnings.push(`push ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (db) {
        store().updateDatabase(databaseId, {
          meta: { ...db.meta, notionLastPushedAt: Date.now() },
        });
      }
      respond(true, {
        ...pullReport,
        pushed,
        warnings,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "SYNC_FAILED",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.import.notion": async ({ respond, params }) => {
    try {
      const apiKey = asStr(params.apiKey);
      const databaseIds = Array.isArray(params.databaseIds)
        ? (params.databaseIds as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined;
      const report = await importFromNotion(store(), { apiKey, databaseIds });
      respond(true, report);
    } catch (e) {
      respond(false, undefined, {
        code: "IMPORT_FAILED",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Nested / sub-page tree ──────────────────────────────────────

  "db.rows.children": async ({ respond, params }) => {
    try {
      const rowId = asStr(params.rowId);
      if (!rowId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "rowId is required" });
        return;
      }
      const s = store();
      // Kanban-sourced rows: children come from two sources, unioned —
      //  1. `[…](moltbot://page/kanban_<id>)` links in the parent's body
      //     (from Notion child_page blocks projected by the kanban adapter)
      //  2. Native rows created via db.rows.createChild whose
      //     parent_row_id points at this kanban id
      if (rowId.startsWith("kanban_")) {
        for (const src of ["kanban-projects", "kanban-tasks"] as const) {
          const db = s.getDatabaseBySource(src);
          if (!db) continue;
          const anchor = await getKanbanRow(s, db, rowId, { withBody: true });
          if (!anchor) continue;
          const body = anchor.body ?? "";
          const re = /\[([^\]]+)\]\(moltbot:\/\/page\/(kanban_[0-9a-f-]+)\)/g;
          const children: import("../../databases/types.js").DatabaseRow[] = [];
          const seen = new Set<string>();
          let m: RegExpExecArray | null;
          while ((m = re.exec(body)) !== null) {
            const childId = m[2]!;
            if (seen.has(childId)) continue;
            seen.add(childId);
            const child = await getKanbanRow(s, db, childId);
            if (child) children.push(child);
          }
          for (const native of s.listChildRows(rowId)) {
            if (seen.has(native.id)) continue;
            seen.add(native.id);
            children.push(native);
          }
          respond(true, { children, source: "kanban-body-links+native" });
          return;
        }
        // Parent kanban id not resolvable to a known kanban db, but we may
        // still have native children attached — surface them.
        respond(true, { children: s.listChildRows(rowId), source: "native-orphan" });
        return;
      }
      respond(true, { children: s.listChildRows(rowId), source: "native" });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.ancestors": async ({ respond, params }) => {
    try {
      const rowId = asStr(params.rowId);
      if (!rowId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "rowId is required" });
        return;
      }
      if (rowId.startsWith("kanban_")) {
        // Kanban pages don't carry parent pointers in the adapter — return
        // just the row itself (the view renders the db name as the root).
        const s = store();
        for (const src of ["kanban-projects", "kanban-tasks"] as const) {
          const db = s.getDatabaseBySource(src);
          if (!db) continue;
          const row = await getKanbanRow(s, db, rowId);
          if (row) {
            respond(true, { ancestors: [row] });
            return;
          }
        }
        respond(true, { ancestors: [] });
        return;
      }
      // Native rows: walk the parent chain via the store. If the chain ends
      // with a parent_row_id pointing to a kanban id (e.g. a native sub-page
      // we created beneath a kanban-sourced row), append the kanban anchor
      // so the breadcrumb shows the full path.
      const s = store();
      const ancestors = s.getAncestors(rowId);
      const top = ancestors[0];
      if (top?.parentRowId?.startsWith("kanban_")) {
        for (const src of ["kanban-projects", "kanban-tasks"] as const) {
          const db = s.getDatabaseBySource(src);
          if (!db) continue;
          const kanbanRoot = await getKanbanRow(s, db, top.parentRowId);
          if (kanbanRoot) {
            ancestors.unshift(kanbanRoot);
            break;
          }
        }
      }
      respond(true, { ancestors });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.move": async ({ respond, params }) => {
    try {
      const rowId = asStr(params.rowId);
      if (!rowId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "rowId is required" });
        return;
      }
      if (rowId.startsWith("kanban_")) {
        respond(false, undefined, {
          code: "READ_ONLY_SOURCE",
          message: "Cannot reparent kanban-sourced rows here — move them in Notion.",
        });
        return;
      }
      const rawParent = params.parentRowId;
      const parentRowId = rawParent === null ? null : (asStr(rawParent) ?? null);
      const row = store().moveRow(rowId, parentRowId);
      respond(true, { row });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.createChild": async ({ respond, params }) => {
    try {
      const parentRowId = asStr(params.parentRowId);
      if (!parentRowId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "parentRowId is required" });
        return;
      }
      const s = store();

      // Kanban-sourced parents: the parent itself is a virtual projection
      // (no database_rows entry), but we still allow creating native child
      // rows pointing at the kanban id. Children are unioned in
      // db.rows.children. The new row goes into the kanban-sourced database
      // so it inherits the same property schema as its sibling kanban rows.
      if (parentRowId.startsWith("kanban_")) {
        let parentDb: import("../../databases/types.js").DatabaseRecord | null = null;
        for (const src of ["kanban-projects", "kanban-tasks"] as const) {
          const db = s.getDatabaseBySource(src);
          if (!db) continue;
          const anchor = await getKanbanRow(s, db, parentRowId);
          if (anchor) {
            parentDb = db;
            break;
          }
        }
        if (!parentDb) {
          respond(false, undefined, {
            code: "NOT_FOUND",
            message: `Kanban parent ${parentRowId} not found`,
          });
          return;
        }
        const row = s.upsertRow({
          databaseId: parentDb.id,
          title: asStr(params.title) || "Untitled",
          body: asStrOrNull(params.body),
          values: (params.values as Record<string, PropertyValue> | undefined) ?? undefined,
          parentRowId,
        });
        respond(true, { row });
        return;
      }

      const parent = s.getRow(parentRowId);
      if (!parent) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Parent ${parentRowId} not found`,
        });
        return;
      }
      const databaseId = asStr(params.databaseId) || parent.databaseId;
      if (databaseId !== parent.databaseId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "Sub-pages must live in the parent's database.",
        });
        return;
      }
      const row = s.upsertRow({
        databaseId,
        title: asStr(params.title) || "Untitled",
        body: asStrOrNull(params.body),
        values: (params.values as Record<string, PropertyValue> | undefined) ?? undefined,
        parentRowId,
      });
      respond(true, { row });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.related": async ({ respond, params }) => {
    try {
      const rowId = asStr(params.rowId);
      if (!rowId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "rowId is required" });
        return;
      }
      const s = store();

      // Load the anchor row (may be kanban-sourced).
      let anchor: import("../../databases/types.js").DatabaseRow | null = null;
      if (rowId.startsWith("kanban_")) {
        for (const src of ["kanban-projects", "kanban-tasks"] as const) {
          const db = s.getDatabaseBySource(src);
          if (!db) continue;
          const r = await getKanbanRow(s, db, rowId);
          if (r) {
            anchor = r;
            break;
          }
        }
      } else {
        anchor = s.getRow(rowId);
      }
      if (!anchor) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Row ${rowId} not found` });
        return;
      }

      // Outgoing: this row's relation property values.
      const outgoing: Array<{
        databaseId: string;
        databaseName: string;
        propertyId: string;
        propertyName: string;
        rows: import("../../databases/types.js").DatabaseRow[];
      }> = [];

      const anchorProps = anchor.databaseId.startsWith("kanban")
        ? s.listProperties(anchor.databaseId)
        : s.listProperties(anchor.databaseId);

      for (const p of anchorProps) {
        if (p.type !== "relation") continue;
        const v = anchor.values[p.id];
        if (!v || v.type !== "relation" || v.rowIds.length === 0) continue;

        // Gather the linked rows. They could live in ANY database — scan all.
        const resolvedRows: import("../../databases/types.js").DatabaseRow[] = [];
        for (const linkedId of v.rowIds) {
          // Native lookup first
          const r = s.getRow(linkedId);
          if (r) {
            resolvedRows.push(r);
            continue;
          }
          // Kanban fallback if the id looks like a Notion page id or kanban_*
          if (linkedId.startsWith("kanban_") || /^[0-9a-f-]{32,}$/.test(linkedId)) {
            for (const src of ["kanban-projects", "kanban-tasks"] as const) {
              const db = s.getDatabaseBySource(src);
              if (!db) continue;
              const kRow = await getKanbanRow(
                s,
                db,
                linkedId.startsWith("kanban_") ? linkedId : `kanban_${linkedId}`,
              );
              if (kRow) {
                resolvedRows.push(kRow);
                break;
              }
            }
          }
        }
        if (resolvedRows.length === 0) continue;

        // Group by the target database so the UI can render per-db sections.
        const byDb = new Map<string, typeof resolvedRows>();
        for (const r of resolvedRows) {
          const arr = byDb.get(r.databaseId) ?? [];
          arr.push(r);
          byDb.set(r.databaseId, arr);
        }
        for (const [dbId, rows] of byDb) {
          const db = s.getDatabase(dbId);
          outgoing.push({
            databaseId: dbId,
            databaseName: db?.name ?? "(unknown)",
            propertyId: p.id,
            propertyName: p.name,
            rows,
          });
        }
      }

      // Incoming: scan every other database's rows for a relation prop
      // containing this anchor row id. Native rows only — kanban sources are
      // read-only and don't write incoming refs back to native.
      const incoming: Array<{
        databaseId: string;
        databaseName: string;
        propertyId: string;
        propertyName: string;
        rows: import("../../databases/types.js").DatabaseRow[];
      }> = [];
      for (const db of s.listDatabases()) {
        if (db.id === anchor.databaseId) continue;
        const props = s.listProperties(db.id).filter((p) => p.type === "relation");
        if (props.length === 0) continue;
        const rows = s.listRows(db.id);
        for (const p of props) {
          const matched = rows.filter((r) => {
            const v = r.values[p.id];
            return v?.type === "relation" && v.rowIds.includes(rowId);
          });
          if (matched.length) {
            incoming.push({
              databaseId: db.id,
              databaseName: db.name,
              propertyId: p.id,
              propertyName: p.name,
              rows: matched,
            });
          }
        }
      }

      // Cross-domain links (database_links table): both sides.
      const linksOut = s.listLinksForRow(rowId);
      const linksIn = s.listLinksToTarget("row", rowId);

      respond(true, {
        anchor,
        outgoing,
        incoming,
        linksOut,
        linksIn,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "db.rows.links": async ({ respond, params }) => {
    try {
      const rowId = asStr(params.rowId);
      if (rowId) {
        respond(true, { links: store().listLinksForRow(rowId) });
        return;
      }
      const targetKind = asStr(params.targetKind) as LinkTargetKind | undefined;
      const targetId = asStr(params.targetId);
      if (!targetKind || !targetId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "Pass rowId OR (targetKind + targetId)",
        });
        return;
      }
      respond(true, { links: store().listLinksToTarget(targetKind, targetId) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

// In satellite mode, all db.* calls proxy to the master gateway so the
// satellite behaves as a thin client with master as the single source of truth.
export const databasesHandlers: GatewayRequestHandlers = applySatelliteProxy(_rawDatabasesHandlers);
