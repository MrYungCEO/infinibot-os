/**
 * Generic database types — Notion-like databases stored in SQLite.
 *
 * A "database" is a typed collection of rows with a schema (properties).
 * Property types mirror Notion: title, richText, select, multiSelect,
 * date, number, checkbox, url, email, phone, files, relation, person.
 * Relations are stored loosely as row-id strings (no referential integrity),
 * matching Notion's behaviour.
 */

export type PropertyType =
  | "title"
  | "richText"
  | "select"
  | "multiSelect"
  | "date"
  | "dateRange"
  | "number"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "files"
  | "relation"
  | "person"
  | "status"
  | "createdAt"
  | "updatedAt";

export interface SelectOption {
  id: string;
  name: string;
  color?: string;
}

export interface PropertyConfig {
  /** For select / multiSelect / status. */
  options?: SelectOption[];
  /** For number: "number" | "percent" | "currency". Display only. */
  format?: string;
  /** For relation: the target databaseId. */
  targetDatabaseId?: string;
  /** For files: allowed mime prefixes (e.g. ["image/", "video/"]). */
  allowedMimePrefixes?: string[];
  /** Freeform extra config (formula source, rollup rule, etc. — reserved). */
  extra?: Record<string, unknown>;
}

export interface DatabaseProperty {
  id: string;
  databaseId: string;
  name: string;
  type: PropertyType;
  /** JSON-serialized PropertyConfig; null if none. */
  config: PropertyConfig | null;
  /** Lower sortOrder sorts first. Fractional to make inserts cheap. */
  sortOrder: number;
  /** Hide from default table view (still queryable). */
  hidden: boolean;
}

export type DatabaseSource =
  /** Plain rows stored in this SQLite store. */
  | "native"
  /** Backed by the legacy kanban tables (src/tasks/store.ts + Notion). */
  | "kanban-projects"
  | "kanban-tasks"
  /** Mirrored from a Notion import (one-shot, not live). */
  | "notion-import";

export interface DatabaseRecord {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  source: DatabaseSource;
  /**
   * URL-safe identifier — unique per store. Auto-generated from `name` on
   * create when not supplied. Used for `/db/<slug>` style links and as a
   * stable handle the user can paste into the task-association picker.
   */
  slug: string;
  /** Free metadata (e.g. notionDatabaseId for imports). */
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** A property value inside a row, keyed by propertyId. Shape depends on type. */
export type PropertyValue =
  | { type: "title"; text: string }
  | { type: "richText"; markdown: string }
  | { type: "select"; optionId: string | null }
  | { type: "multiSelect"; optionIds: string[] }
  | { type: "date"; iso: string | null }
  | { type: "dateRange"; start: string | null; end: string | null }
  | { type: "number"; value: number | null }
  | { type: "checkbox"; checked: boolean }
  | { type: "url"; url: string | null }
  | { type: "email"; email: string | null }
  | { type: "phone"; phone: string | null }
  | { type: "files"; files: FileRef[] }
  | { type: "relation"; rowIds: string[] }
  | { type: "person"; personIds: string[] }
  | { type: "status"; optionId: string | null }
  | { type: "createdAt"; iso: string }
  | { type: "updatedAt"; iso: string };

export interface FileRef {
  name: string;
  url: string;
  mime?: string;
  size?: number;
}

/** External system reference (e.g. the Notion page id for a synced row). */
export interface ExternalRef {
  system: "notion";
  externalId: string;
  lastSyncedAt: number;
  /** Last hash of the row content we synced — used to detect remote changes. */
  contentHash?: string;
}

export interface DatabaseRow {
  id: string;
  databaseId: string;
  /** Primary visible text — always derived from the title property for convenience. */
  title: string;
  /**
   * URL-safe identifier — unique within the parent database. Auto-generated
   * from `title` on create. Combined with the database slug to form
   * `/db/<database-slug>/<row-slug>` page URLs.
   */
  slug: string;
  /** Body / page content (markdown). Null for rows that don't need a body. */
  body: string | null;
  /** Property values keyed by property id. */
  values: Record<string, PropertyValue>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** Unix ms set on first transition to a "done" status. Kanban-specific; null for other databases. */
  completedAt?: number;
  /** Set when the row is mirrored from / to an external system. */
  externalRef?: ExternalRef | null;
  /**
   * Nested-page hierarchy: null/undefined = top-level row in its database;
   * otherwise the parent row's id. Must belong to the same database.
   */
  parentRowId?: string | null;
  /**
   * Per-business scope — when set, the row is owned by this business and is
   * filtered out of other businesses' workspace views. Optional/nullable so
   * legacy unscoped rows remain visible in the unfiltered "All Businesses"
   * mode and the field can be backfilled later via db.rows.scope.
   */
  businessId?: string | null;
}

/** Simple, composable row filter. */
export type RowFilter =
  | { kind: "equals"; propertyId: string; value: unknown }
  | { kind: "contains"; propertyId: string; value: string }
  | { kind: "isEmpty"; propertyId: string }
  | { kind: "isNotEmpty"; propertyId: string }
  | { kind: "in"; propertyId: string; values: unknown[] }
  | { kind: "and"; filters: RowFilter[] }
  | { kind: "or"; filters: RowFilter[] };

export type RowSort = {
  propertyId: string;
  direction: "asc" | "desc";
};

export interface RowQuery {
  databaseId: string;
  filter?: RowFilter;
  sorts?: RowSort[];
  limit?: number;
  offset?: number;
  /**
   * Per-business scope filter. Same semantics as `Store.listRows`:
   *   - omitted   → all rows
   *   - null      → only rows with no business assignment
   *   - "abc"     → only rows scoped to that business
   */
  businessId?: string | null;
}

/**
 * Well-known system-database roles. Tools look up their backing database
 * through `store.resolveSystemRole(role)` so users can reassign roles
 * without any code changes — the CRM pattern, generalized.
 */
export type SystemRole =
  // Core
  | "projects"
  | "tasks"
  | "notes"
  // CRM
  | "clients"
  | "leads"
  | "contacts"
  | "companies"
  | "deals"
  // eCom
  | "products"
  | "orders"
  | "customers"
  | "refunds"
  // Service
  | "sessions"
  | "invoices"
  // Agency
  | "time_entries";

export const SYSTEM_ROLES: SystemRole[] = [
  "projects",
  "tasks",
  "notes",
  "clients",
  "leads",
  "contacts",
  "companies",
  "deals",
  "products",
  "orders",
  "customers",
  "refunds",
  "sessions",
  "invoices",
  "time_entries",
];

export interface SystemRoleAssignment {
  role: SystemRole;
  databaseId: string;
  updatedAt: number;
}

/**
 * Loose link between a row and another entity (project, task, note, agent
 * session, row in another database). Stored as loose string ids — no FK.
 */
export type LinkTargetKind = "project" | "task" | "note" | "session" | "row" | "file" | "url";

export interface DatabaseLink {
  id: string;
  rowId: string;
  targetKind: LinkTargetKind;
  targetId: string;
  /** Optional property id if the link belongs to a specific relation column. */
  propertyId: string | null;
  label: string | null;
  createdAt: number;
}
