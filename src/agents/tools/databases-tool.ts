/**
 * Agent tool — generic databases (Notion-style, SQLite-backed).
 *
 * Full read/write surface over every database, property, row, link, and
 * system-role assignment in the local store, so an LLM running through MCP
 * can list, design, query, edit, and reshape Notion-compatible business
 * databases (CRM, projects, notes, etc.) end-to-end.
 *
 * Single tool with an `action` switch. Property values may be passed in
 * either the canonical PropertyValue discriminated-union shape or a
 * friendly shorthand keyed by property NAME or id, e.g.
 *   { "Status": "todo", "Tags": ["urgent","priority"], "Active": true }
 * The shorthand is resolved against the database's property schema before
 * hitting the store, so callers don't have to memorise the union shapes.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { getDatabasesStore, type DatabasesStore } from "../../databases/store.js";
import { importFromNotion } from "../../databases/notion-import.js";
import type {
  DatabaseProperty,
  DatabaseRecord,
  DatabaseRow,
  LinkTargetKind,
  PropertyConfig,
  PropertyType,
  PropertyValue,
  RowFilter,
  RowSort,
  SystemRole,
} from "../../databases/types.js";
import { SYSTEM_ROLES } from "../../databases/types.js";

function store() {
  // getDatabasesStore handles idempotent seeding internally.
  return getDatabasesStore();
}

// ─── Value coercion ───────────────────────────────────────────────
// LLMs find the discriminated PropertyValue union awkward. Accept friendly
// shorthand keyed by property name OR id and coerce to canonical shape.

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Look up a property by id first, then by case-insensitive name. */
function findProperty(props: DatabaseProperty[], key: string): DatabaseProperty | null {
  if (!key) return null;
  const byId = props.find((p) => p.id === key);
  if (byId) return byId;
  const lower = key.toLowerCase();
  return props.find((p) => p.name.toLowerCase() === lower) ?? null;
}

/** Resolve a select-option name OR id to its canonical option id. */
function resolveOptionId(prop: DatabaseProperty, raw: unknown): string | null {
  const val = asString(raw);
  if (!val) return null;
  const opts = prop.config?.options ?? [];
  const byId = opts.find((o) => o.id === val);
  if (byId) return byId.id;
  const lower = val.toLowerCase();
  const byName = opts.find((o) => o.name.toLowerCase() === lower);
  return byName ? byName.id : val; // permit setting an id not yet in config
}

function coerceSingleValue(prop: DatabaseProperty, raw: unknown): PropertyValue | undefined {
  // Already canonical? Trust it.
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof (raw as { type?: unknown }).type === "string"
  ) {
    return raw as PropertyValue;
  }

  switch (prop.type) {
    case "title":
      return { type: "title", text: asString(raw) ?? "" };
    case "richText":
      return { type: "richText", markdown: asString(raw) ?? "" };
    case "select":
      return { type: "select", optionId: resolveOptionId(prop, raw) };
    case "status":
      return { type: "status", optionId: resolveOptionId(prop, raw) };
    case "multiSelect": {
      const arr = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      const ids = arr
        .map((entry) => resolveOptionId(prop, entry))
        .filter((id): id is string => Boolean(id));
      return { type: "multiSelect", optionIds: ids };
    }
    case "date":
      return { type: "date", iso: asString(raw) };
    case "dateRange": {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        return {
          type: "dateRange",
          start: asString(obj.start),
          end: asString(obj.end),
        };
      }
      return { type: "dateRange", start: asString(raw), end: null };
    }
    case "number": {
      if (raw === null || raw === undefined || raw === "") {
        return { type: "number", value: null };
      }
      const n = typeof raw === "number" ? raw : Number(raw);
      return { type: "number", value: Number.isFinite(n) ? n : null };
    }
    case "checkbox":
      return {
        type: "checkbox",
        checked: raw === true || raw === "true" || raw === 1 || raw === "1",
      };
    case "url":
      return { type: "url", url: asString(raw) };
    case "email":
      return { type: "email", email: asString(raw) };
    case "phone":
      return { type: "phone", phone: asString(raw) };
    case "files": {
      if (Array.isArray(raw)) {
        const files = raw
          .map((entry) => {
            if (entry && typeof entry === "object") {
              const obj = entry as Record<string, unknown>;
              const name = asString(obj.name);
              const url = asString(obj.url);
              if (!url) return null;
              return {
                name: name ?? url,
                url,
                mime: asString(obj.mime) ?? undefined,
                size: typeof obj.size === "number" ? obj.size : undefined,
              };
            }
            const url = asString(entry);
            return url ? { name: url, url } : null;
          })
          .filter((f): f is NonNullable<typeof f> => Boolean(f));
        return { type: "files", files };
      }
      return { type: "files", files: [] };
    }
    case "relation": {
      const arr = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      const ids = arr.map((id) => asString(id)).filter((id): id is string => Boolean(id));
      return { type: "relation", rowIds: ids };
    }
    case "person": {
      const arr = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      const ids = arr.map((id) => asString(id)).filter((id): id is string => Boolean(id));
      return { type: "person", personIds: ids };
    }
    case "createdAt":
    case "updatedAt":
      // These are derived by the store; ignore writes.
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Coerce a friendly `values` map (keyed by property NAME or id) into the
 * canonical `Record<propId, PropertyValue>` the store expects.
 */
function coerceValues(
  props: DatabaseProperty[],
  raw: unknown,
): { values: Record<string, PropertyValue>; unknownKeys: string[] } {
  const values: Record<string, PropertyValue> = {};
  const unknownKeys: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { values, unknownKeys };
  }
  for (const [key, entry] of Object.entries(raw)) {
    const prop = findProperty(props, key);
    if (!prop) {
      unknownKeys.push(key);
      continue;
    }
    const coerced = coerceSingleValue(prop, entry);
    if (coerced !== undefined) values[prop.id] = coerced;
  }
  return { values, unknownKeys };
}

/** Resolve a database handle (id or slug) to a record. */
function resolveDatabase(s: DatabasesStore, handle: string): DatabaseRecord | null {
  return s.getDatabaseByIdOrSlug(handle);
}

/** Build a compact schema summary an LLM can read in one glance. */
function describeSchema(db: DatabaseRecord, props: DatabaseProperty[]) {
  return {
    id: db.id,
    slug: db.slug,
    name: db.name,
    icon: db.icon,
    description: db.description,
    source: db.source,
    properties: props.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      hidden: p.hidden,
      options:
        p.type === "select" || p.type === "multiSelect" || p.type === "status"
          ? (p.config?.options ?? []).map((o) => ({ id: o.id, name: o.name }))
          : undefined,
      relationTarget: p.type === "relation" ? (p.config?.targetDatabaseId ?? null) : undefined,
      numberFormat: p.type === "number" ? (p.config?.format ?? null) : undefined,
    })),
  };
}

// ─── Tool schema ──────────────────────────────────────────────────

const DatabasesToolSchema = Type.Object({
  action: stringEnum([
    // Database lifecycle
    "list",
    "describe",
    "get_database",
    "create_database",
    "update_database",
    "delete_database",
    "resolve_path",
    // Property lifecycle
    "list_properties",
    "create_property",
    "update_property",
    "delete_property",
    // Row read
    "query",
    "get_row",
    "get_row_by_path",
    "count_rows",
    "search",
    // Row write
    "upsert_row",
    "set_values",
    "append_body",
    "delete_row",
    "bulk_upsert_rows",
    "bulk_delete_rows",
    // Tree
    "get_children",
    "get_ancestors",
    "move_row",
    "create_child",
    // Links
    "link_row",
    "unlink_row",
    "row_links",
    "related",
    // System roles
    "list_system_roles",
    "get_system_role",
    "set_system_role",
    "clear_system_role",
    // Import
    "import_notion",
  ]),
  // Common identifiers
  database_id: Type.Optional(Type.String()),
  database_slug: Type.Optional(Type.String()),
  row_id: Type.Optional(Type.String()),
  row_slug: Type.Optional(Type.String()),
  /** Slug path or moltbot URL ("/db/clients/acme-co" or "row_..."). */
  path: Type.Optional(Type.String()),
  // Row content
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  /** Property values keyed by property NAME or id. Friendly shorthand allowed. */
  values: Type.Optional(Type.Unknown()),
  // Row write helpers
  property: Type.Optional(Type.String()),
  value: Type.Optional(Type.Unknown()),
  separator: Type.Optional(Type.String()),
  rows: Type.Optional(Type.Array(Type.Unknown())),
  row_ids: Type.Optional(Type.Array(Type.String())),
  // Query
  filter: Type.Optional(Type.Unknown()),
  sorts: Type.Optional(Type.Unknown()),
  limit: Type.Optional(Type.Number()),
  offset: Type.Optional(Type.Number()),
  query_text: Type.Optional(Type.String()),
  // Database lifecycle
  name: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  meta: Type.Optional(Type.Unknown()),
  properties: Type.Optional(Type.Array(Type.Unknown())),
  // Property lifecycle
  property_id: Type.Optional(Type.String()),
  property_name: Type.Optional(Type.String()),
  property_type: Type.Optional(Type.String()),
  config: Type.Optional(Type.Unknown()),
  hidden: Type.Optional(Type.Boolean()),
  sort_order: Type.Optional(Type.Number()),
  // Tree
  parent_row_id: Type.Optional(Type.String()),
  // Links
  target_kind: Type.Optional(
    stringEnum(["project", "task", "note", "session", "row", "file", "url"]),
  ),
  target_id: Type.Optional(Type.String()),
  link_id: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  // System roles
  role: Type.Optional(stringEnum(SYSTEM_ROLES as readonly string[])),
  // Import
  notion_api_key: Type.Optional(Type.String()),
  notion_database_ids: Type.Optional(Type.Array(Type.String())),
});

// ─── Tool implementation ─────────────────────────────────────────

export function createDatabasesTool(_options?: { agentId?: string }): AnyAgentTool {
  return {
    label: "Databases",
    name: "databases",
    description:
      `Full read/write access to Notion-style databases (CRM, projects, leads, ` +
      `notes, deals, contacts, custom tables) stored in local SQLite. ` +
      `\n\nLifecycle: "list", "describe" (always call first for unfamiliar DBs — ` +
      `returns schema + sample rows), "get_database", "create_database", ` +
      `"update_database", "delete_database", "resolve_path". ` +
      `\nProperties: "list_properties", "create_property" (name + type + optional ` +
      `config), "update_property" (rename, change options, mark hidden), ` +
      `"delete_property". ` +
      `\nRow read: "query" (filter + sorts), "get_row", "get_row_by_path", ` +
      `"count_rows", "search" (cross-database title/body search). ` +
      `\nRow write: "upsert_row" (create or update — include row_id to update), ` +
      `"set_values" (patch a single property by name), "append_body" (append ` +
      `markdown to a row's body), "delete_row", "bulk_upsert_rows", ` +
      `"bulk_delete_rows". ` +
      `\nTree: "get_children", "get_ancestors", "move_row", "create_child". ` +
      `\nLinks: "link_row" (project/task/note/session/row/file/url), "unlink_row", ` +
      `"row_links", "related" (incoming + outgoing relations). ` +
      `\nSystem-role registry (clients/leads/projects/tasks/notes role → DB): ` +
      `"list_system_roles", "get_system_role", "set_system_role", ` +
      `"clear_system_role". ` +
      `\nImport: "import_notion" (one-shot Notion workspace pull). ` +
      `\n\nProperty values may be passed in friendly shorthand keyed by property ` +
      `NAME — e.g. { "Status": "active", "Tags": ["urgent","vip"], "MRR": 1200, ` +
      `"Last Contact": "2026-04-15", "Active": true } — or in the canonical ` +
      `PropertyValue union. Both forms work.`,
    parameters: DatabasesToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const s = store();

      const dbHandle =
        readStringParam(params, "database_id") ?? readStringParam(params, "database_slug");

      // businessId tri-state matching the store/RPC contract:
      //   - undefined → no scope filter (sees all rows)
      //   - null      → only unscoped rows
      //   - "abc"     → only rows owned by that business
      const rawBiz = (params as Record<string, unknown>).business_id;
      const businessId: string | null | undefined =
        rawBiz === undefined
          ? undefined
          : rawBiz === null
            ? null
            : typeof rawBiz === "string" && rawBiz.length > 0
              ? rawBiz
              : null;

      try {
        switch (action) {
          // ── Database lifecycle ────────────────────────────────────

          case "list": {
            return jsonResult({ databases: s.listDatabases() });
          }

          case "describe": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            const props = s.listProperties(db.id);
            const rows = s.listRows(db.id);
            return jsonResult({
              database: describeSchema(db, props),
              rowCount: rows.length,
              sampleRows: rows.slice(0, 5),
            });
          }

          case "get_database": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            return jsonResult({
              database: db,
              properties: s.listProperties(db.id),
            });
          }

          case "create_database": {
            const name = readStringParam(params, "name", { required: true });
            const created = s.createDatabase({
              name,
              slug: readStringParam(params, "slug"),
              icon: readStringParam(params, "icon") ?? null,
              description: readStringParam(params, "description") ?? null,
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
            return jsonResult({
              database: created,
              properties: s.listProperties(created.id),
            });
          }

          case "update_database": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            const patch: Record<string, unknown> = {};
            if (params.name !== undefined) patch.name = readStringParam(params, "name");
            if (params.slug !== undefined) patch.slug = readStringParam(params, "slug");
            if (params.icon !== undefined) patch.icon = readStringParam(params, "icon") ?? null;
            if (params.description !== undefined) {
              patch.description = readStringParam(params, "description") ?? null;
            }
            if (params.meta !== undefined) patch.meta = params.meta;
            const updated = s.updateDatabase(
              db.id,
              patch as Parameters<DatabasesStore["updateDatabase"]>[1],
            );
            return jsonResult({ database: updated });
          }

          case "delete_database": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            return jsonResult({ deleted: s.deleteDatabase(db.id) });
          }

          case "resolve_path": {
            const path = readStringParam(params, "path", { required: true });
            const resolved = s.resolvePath(path);
            if (!resolved) return jsonResult({ kind: "external", path });
            const properties = s.listProperties(resolved.database.id);
            if (resolved.row) {
              return jsonResult({
                kind: "row",
                database: resolved.database,
                row: resolved.row,
                properties,
              });
            }
            return jsonResult({
              kind: "database",
              database: resolved.database,
              properties,
            });
          }

          // ── Property lifecycle ────────────────────────────────────

          case "list_properties": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            return jsonResult({ properties: s.listProperties(db.id) });
          }

          case "create_property": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            const name = readStringParam(params, "property_name", { required: true });
            const type = readStringParam(params, "property_type", {
              required: true,
            }) as PropertyType;
            const property = s.createProperty({
              databaseId: db.id,
              name,
              type,
              config: (params.config as PropertyConfig | null | undefined) ?? null,
              hidden: Boolean(params.hidden),
              sortOrder: typeof params.sort_order === "number" ? params.sort_order : undefined,
            });
            return jsonResult({ property });
          }

          case "update_property": {
            const propertyId = readStringParam(params, "property_id");
            const propertyName = readStringParam(params, "property_name");
            let target: DatabaseProperty | null = null;
            if (propertyId) {
              const db = dbHandle ? resolveDatabase(s, dbHandle) : null;
              const props = db ? s.listProperties(db.id) : [];
              target = findProperty(props, propertyId) ?? null;
              if (!target && !db) {
                // No db handle — best-effort, scan all
                for (const d of s.listDatabases()) {
                  const found = findProperty(s.listProperties(d.id), propertyId);
                  if (found) {
                    target = found;
                    break;
                  }
                }
              }
            } else if (propertyName && dbHandle) {
              const db = resolveDatabase(s, dbHandle);
              if (db) target = findProperty(s.listProperties(db.id), propertyName);
            }
            if (!target)
              return jsonResult({
                error: "property not found — pass property_id or (database_id + property_name)",
              });
            const patch: Record<string, unknown> = {};
            if (params.property_name !== undefined && readStringParam(params, "property_name")) {
              patch.name = readStringParam(params, "property_name");
            }
            if (params.property_type !== undefined) patch.type = params.property_type;
            if (params.config !== undefined) patch.config = params.config;
            if (params.sort_order !== undefined) patch.sortOrder = params.sort_order;
            if (params.hidden !== undefined) patch.hidden = Boolean(params.hidden);
            const updated = s.updateProperty(
              target.id,
              patch as Parameters<DatabasesStore["updateProperty"]>[1],
            );
            return jsonResult({ property: updated });
          }

          case "delete_property": {
            const propertyId = readStringParam(params, "property_id", { required: true });
            return jsonResult({ deleted: s.deleteProperty(propertyId) });
          }

          // ── Row read ──────────────────────────────────────────────

          case "query": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            const rows = s.queryRows({
              databaseId: db.id,
              filter: params.filter as RowFilter | undefined,
              sorts: params.sorts as RowSort[] | undefined,
              limit: typeof params.limit === "number" ? params.limit : undefined,
              offset: typeof params.offset === "number" ? params.offset : undefined,
              businessId,
            });
            return jsonResult({ rows, total: rows.length });
          }

          case "get_row": {
            const id = readStringParam(params, "row_id", { required: true });
            const row = s.getRow(id);
            if (!row) return jsonResult({ error: `Row ${id} not found` });
            return jsonResult({ row, links: s.listLinksForRow(id) });
          }

          case "get_row_by_path": {
            const path = readStringParam(params, "path");
            const slug = readStringParam(params, "row_slug");
            if (path) {
              const row = s.getRowByIdOrPath(path);
              if (!row) return jsonResult({ error: `Row at '${path}' not found` });
              return jsonResult({ row, links: s.listLinksForRow(row.id) });
            }
            if (slug && dbHandle) {
              const db = resolveDatabase(s, dbHandle);
              if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
              const row = s.getRowBySlug(db.id, slug);
              if (!row) return jsonResult({ error: `Row '${slug}' not found in '${db.slug}'` });
              return jsonResult({ row, database: db, links: s.listLinksForRow(row.id) });
            }
            return jsonResult({ error: "Pass path OR (database_id/database_slug + row_slug)" });
          }

          case "count_rows": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            const rows = params.filter
              ? s.queryRows({ databaseId: db.id, filter: params.filter as RowFilter, businessId })
              : s.listRows(db.id, { businessId });
            return jsonResult({ count: rows.length });
          }

          case "search": {
            const text = readStringParam(params, "query_text", { required: true });
            const lower = text.toLowerCase();
            const limit = typeof params.limit === "number" ? params.limit : 50;
            const dbs = dbHandle
              ? ([resolveDatabase(s, dbHandle)].filter(Boolean) as DatabaseRecord[])
              : s.listDatabases();
            const hits: Array<{
              databaseId: string;
              databaseName: string;
              row: DatabaseRow;
              matchedField: "title" | "body" | "value";
            }> = [];
            for (const db of dbs) {
              for (const row of s.listRows(db.id, { businessId })) {
                if ((row.title ?? "").toLowerCase().includes(lower)) {
                  hits.push({
                    databaseId: db.id,
                    databaseName: db.name,
                    row,
                    matchedField: "title",
                  });
                  if (hits.length >= limit) break;
                  continue;
                }
                if ((row.body ?? "").toLowerCase().includes(lower)) {
                  hits.push({
                    databaseId: db.id,
                    databaseName: db.name,
                    row,
                    matchedField: "body",
                  });
                  if (hits.length >= limit) break;
                  continue;
                }
                // Cheap value scan — stringify each property value.
                const valuesText = JSON.stringify(row.values).toLowerCase();
                if (valuesText.includes(lower)) {
                  hits.push({
                    databaseId: db.id,
                    databaseName: db.name,
                    row,
                    matchedField: "value",
                  });
                  if (hits.length >= limit) break;
                }
              }
              if (hits.length >= limit) break;
            }
            return jsonResult({ hits, total: hits.length });
          }

          // ── Row write ─────────────────────────────────────────────

          case "upsert_row": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            const props = s.listProperties(db.id);
            const { values, unknownKeys } = coerceValues(props, params.values);
            const row = s.upsertRow({
              id: readStringParam(params, "row_id"),
              databaseId: db.id,
              title: readStringParam(params, "title"),
              slug: readStringParam(params, "row_slug"),
              body:
                params.body === null ? null : readStringParam(params, "body", { allowEmpty: true }),
              values: Object.keys(values).length > 0 ? values : undefined,
              sortOrder: typeof params.sort_order === "number" ? params.sort_order : undefined,
              businessId,
            });
            return jsonResult({
              row,
              ...(unknownKeys.length > 0 ? { unknownProperties: unknownKeys } : {}),
            });
          }

          case "set_values": {
            const id = readStringParam(params, "row_id", { required: true });
            const row = s.getRow(id);
            if (!row) return jsonResult({ error: `Row ${id} not found` });
            const props = s.listProperties(row.databaseId);

            // Either { values: {...} } map or a single { property, value } pair
            let valuesInput: unknown = params.values;
            if (!valuesInput) {
              const propName = readStringParam(params, "property", { required: true });
              valuesInput = { [propName]: params.value };
            }
            const { values, unknownKeys } = coerceValues(props, valuesInput);
            if (Object.keys(values).length === 0) {
              return jsonResult({
                error: "no recognised properties to set",
                unknownProperties: unknownKeys,
              });
            }
            const updated = s.upsertRow({
              id,
              databaseId: row.databaseId,
              values,
            });
            return jsonResult({
              row: updated,
              ...(unknownKeys.length > 0 ? { unknownProperties: unknownKeys } : {}),
            });
          }

          case "append_body": {
            const id = readStringParam(params, "row_id", { required: true });
            const text = readStringParam(params, "body", { required: true, allowEmpty: true });
            const row = s.getRow(id);
            if (!row) return jsonResult({ error: `Row ${id} not found` });
            const sep = readStringParam(params, "separator") ?? "\n\n";
            const nextBody = row.body ? `${row.body}${sep}${text}` : text;
            const updated = s.upsertRow({
              id,
              databaseId: row.databaseId,
              body: nextBody,
            });
            return jsonResult({ row: updated });
          }

          case "delete_row": {
            const id = readStringParam(params, "row_id", { required: true });
            return jsonResult({ deleted: s.deleteRow(id) });
          }

          case "bulk_upsert_rows": {
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            const props = s.listProperties(db.id);
            const list = Array.isArray(params.rows) ? params.rows : [];
            if (list.length === 0) return jsonResult({ error: "rows array is required" });
            const written: DatabaseRow[] = [];
            const unknownByRow: Record<number, string[]> = {};
            list.forEach((entry, idx) => {
              if (!entry || typeof entry !== "object") return;
              const obj = entry as Record<string, unknown>;
              const { values, unknownKeys } = coerceValues(props, obj.values);
              if (unknownKeys.length) unknownByRow[idx] = unknownKeys;
              // Per-row businessId override wins; otherwise inherit the
              // tool-level scope (passed once for the whole bulk call).
              const rowBusinessId =
                obj.business_id === undefined
                  ? businessId
                  : obj.business_id === null
                    ? null
                    : typeof obj.business_id === "string" && obj.business_id.length > 0
                      ? obj.business_id
                      : null;
              const row = s.upsertRow({
                id: typeof obj.id === "string" ? obj.id : undefined,
                databaseId: db.id,
                title: typeof obj.title === "string" ? obj.title : undefined,
                slug: typeof obj.slug === "string" ? obj.slug : undefined,
                body:
                  obj.body === null ? null : typeof obj.body === "string" ? obj.body : undefined,
                values: Object.keys(values).length > 0 ? values : undefined,
                parentRowId: typeof obj.parentRowId === "string" ? obj.parentRowId : undefined,
                businessId: rowBusinessId,
              });
              written.push(row);
            });
            return jsonResult({
              rows: written,
              count: written.length,
              ...(Object.keys(unknownByRow).length > 0
                ? { unknownPropertiesByIndex: unknownByRow }
                : {}),
            });
          }

          case "bulk_delete_rows": {
            const ids = Array.isArray(params.row_ids)
              ? (params.row_ids as unknown[]).filter((x): x is string => typeof x === "string")
              : [];
            if (ids.length === 0) return jsonResult({ error: "row_ids array is required" });
            let deleted = 0;
            const failed: string[] = [];
            for (const id of ids) {
              if (s.deleteRow(id)) deleted++;
              else failed.push(id);
            }
            return jsonResult({
              deleted,
              ...(failed.length > 0 ? { failed } : {}),
            });
          }

          // ── Tree ──────────────────────────────────────────────────

          case "get_children": {
            const rowId = readStringParam(params, "row_id", { required: true });
            return jsonResult({ children: s.listChildRows(rowId) });
          }

          case "get_ancestors": {
            const rowId = readStringParam(params, "row_id", { required: true });
            return jsonResult({ ancestors: s.getAncestors(rowId) });
          }

          case "move_row": {
            const rowId = readStringParam(params, "row_id", { required: true });
            const rawParent = params.parent_row_id;
            const parentRowId =
              rawParent === null || rawParent === undefined
                ? null
                : typeof rawParent === "string"
                  ? rawParent
                  : null;
            const row = s.moveRow(rowId, parentRowId);
            return jsonResult({ row });
          }

          case "create_child": {
            const parentRowId = readStringParam(params, "parent_row_id", { required: true });
            const parent = s.getRow(parentRowId);
            if (!parent) return jsonResult({ error: `Parent ${parentRowId} not found` });
            const props = s.listProperties(parent.databaseId);
            const { values, unknownKeys } = coerceValues(props, params.values);
            const row = s.upsertRow({
              databaseId: parent.databaseId,
              title: readStringParam(params, "title") || "Untitled",
              body:
                params.body === null ? null : readStringParam(params, "body", { allowEmpty: true }),
              values: Object.keys(values).length > 0 ? values : undefined,
              parentRowId,
            });
            return jsonResult({
              row,
              ...(unknownKeys.length > 0 ? { unknownProperties: unknownKeys } : {}),
            });
          }

          // ── Links ─────────────────────────────────────────────────

          case "link_row": {
            const rowId = readStringParam(params, "row_id", { required: true });
            const targetKind = readStringParam(params, "target_kind", {
              required: true,
            }) as LinkTargetKind;
            const targetId = readStringParam(params, "target_id", { required: true });
            const link = s.linkRow({
              rowId,
              targetKind,
              targetId,
              propertyId: readStringParam(params, "property_id") || null,
              label: readStringParam(params, "label") || null,
            });
            return jsonResult({ link });
          }

          case "unlink_row": {
            const linkId = readStringParam(params, "link_id", { required: true });
            return jsonResult({ deleted: s.unlinkRow(linkId) });
          }

          case "row_links": {
            const rowId = readStringParam(params, "row_id");
            if (rowId) return jsonResult({ links: s.listLinksForRow(rowId) });
            const targetKind = readStringParam(params, "target_kind") as LinkTargetKind | undefined;
            const targetId = readStringParam(params, "target_id");
            if (!targetKind || !targetId) {
              return jsonResult({ error: "Pass row_id OR (target_kind + target_id)" });
            }
            return jsonResult({ links: s.listLinksToTarget(targetKind, targetId) });
          }

          case "related": {
            const rowId = readStringParam(params, "row_id", { required: true });
            const anchor = s.getRow(rowId);
            if (!anchor) return jsonResult({ error: `Row ${rowId} not found` });
            const anchorProps = s.listProperties(anchor.databaseId);
            const outgoing: unknown[] = [];
            for (const p of anchorProps) {
              if (p.type !== "relation") continue;
              const v = anchor.values[p.id];
              if (!v || v.type !== "relation") continue;
              const rows = v.rowIds.map((id) => s.getRow(id)).filter(Boolean);
              if (rows.length) {
                outgoing.push({ propertyId: p.id, propertyName: p.name, rows });
              }
            }
            const incoming: unknown[] = [];
            for (const db of s.listDatabases()) {
              if (db.id === anchor.databaseId) continue;
              const relProps = s.listProperties(db.id).filter((p) => p.type === "relation");
              if (!relProps.length) continue;
              for (const p of relProps) {
                const matched = s.listRows(db.id).filter((r) => {
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
            return jsonResult({
              anchor,
              outgoing,
              incoming,
              linksOut: s.listLinksForRow(rowId),
              linksIn: s.listLinksToTarget("row", rowId),
            });
          }

          // ── System role registry ─────────────────────────────────

          case "list_system_roles": {
            return jsonResult({
              roles: SYSTEM_ROLES,
              assignments: s.listSystemRoles(),
            });
          }

          case "get_system_role": {
            const role = readStringParam(params, "role", { required: true }) as SystemRole;
            if (!SYSTEM_ROLES.includes(role)) {
              return jsonResult({
                error: `role must be one of: ${SYSTEM_ROLES.join(", ")}`,
              });
            }
            const resolved = s.resolveSystemRole(role);
            return jsonResult({ role, resolved });
          }

          case "set_system_role": {
            const role = readStringParam(params, "role", { required: true }) as SystemRole;
            if (!SYSTEM_ROLES.includes(role)) {
              return jsonResult({
                error: `role must be one of: ${SYSTEM_ROLES.join(", ")}`,
              });
            }
            if (!dbHandle) return jsonResult({ error: "database_id or database_slug required" });
            const db = resolveDatabase(s, dbHandle);
            if (!db) return jsonResult({ error: `Database ${dbHandle} not found` });
            const assignment = s.setSystemRole(role, db.id);
            return jsonResult({ assignment });
          }

          case "clear_system_role": {
            const role = readStringParam(params, "role", { required: true }) as SystemRole;
            if (!SYSTEM_ROLES.includes(role)) {
              return jsonResult({
                error: `role must be one of: ${SYSTEM_ROLES.join(", ")}`,
              });
            }
            return jsonResult({ cleared: s.clearSystemRole(role) });
          }

          // ── Import ───────────────────────────────────────────────

          case "import_notion": {
            const apiKey = readStringParam(params, "notion_api_key");
            const ids = Array.isArray(params.notion_database_ids)
              ? (params.notion_database_ids as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : undefined;
            const report = await importFromNotion(s, { apiKey, databaseIds: ids });
            return jsonResult(report);
          }

          default:
            return jsonResult({ error: `Unknown action "${action}"` });
        }
      } catch (e) {
        return jsonResult({
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}
