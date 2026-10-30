/**
 * Canonical clients.* RPC surface — single source of truth.
 *
 * All client data lives in agency.db `clients` table. Notion is one optional
 * sync provider; it does NOT own the data. Both the /clients CRM page and the
 * Agency-Ops tab read from this same store via different RPC namespaces that
 * both delegate here.
 *
 * Migration v14 added:
 *   - clients.notion_page_id (Notion tracking)
 *   - clients.data            (full Notion property blob for dynamic schema rendering)
 *   - clients.last_synced     (last successful Notion sync timestamp)
 *   - clients_notion_config   (per-agency Notion DB connection + schema)
 */

import { getAgencyOperationsStore } from "../../agency-operations/store.js";
import { DEFAULT_AGENCY_ID } from "../../agency-operations/types.js";
import { resolveStateDir } from "../../config/paths.js";
import { getNotionApiKeyForImport } from "../../databases/notion-config.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

// ── Broadcaster ──────────────────────────────────────────────────────────────

type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
let _broadcast: BroadcastFn | null = null;

export function setClientsBroadcaster(broadcast: BroadcastFn): void {
  _broadcast = broadcast;
}

function broadcast(event: string, payload: unknown): void {
  _broadcast?.(event, payload, { dropIfSlow: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function store() {
  return getAgencyOperationsStore(resolveStateDir());
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParam(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${name} must be a number`);
  return value;
}

/**
 * Largest page a single `clients.list` call will serve. The UI pages through
 * the full set at this size, so it bounds the round-trip count (1300 clients =
 * 3 calls) without letting a caller ask for an unbounded response.
 */
const MAX_CLIENTS_PAGE_SIZE = 500;
const DEFAULT_CLIENTS_PAGE_SIZE = 10;

function pageParams(params: Record<string, unknown>): {
  page: number;
  pageSize: number;
  all: boolean;
} {
  const all = params.all === true;
  const page = typeof params.page === "number" && params.page >= 1 ? Math.floor(params.page) : 1;
  // Out-of-range sizes are CLAMPED, not silently dropped back to the default —
  // the old behaviour turned `pageSize: 500` into a 10-row response, which is
  // why callers that asked for everything only ever saw one page.
  const pageSize =
    typeof params.pageSize === "number" && Number.isFinite(params.pageSize) && params.pageSize >= 1
      ? Math.min(Math.floor(params.pageSize), MAX_CLIENTS_PAGE_SIZE)
      : DEFAULT_CLIENTS_PAGE_SIZE;
  return { page, pageSize, all };
}

async function run<T>(opts: GatewayRequestHandlerOptions, fn: () => T | Promise<T>): Promise<void> {
  try {
    opts.respond(true, await fn());
  } catch (error) {
    opts.respond(false, { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Resolve agencyId from params. Accepts both `agencyId` and `businessId`
 * (the legacy /clients page sent businessId). They are the same concept.
 */
function resolveAgencyId(params: Record<string, unknown>): string {
  return optionalString(params.agencyId) ?? optionalString(params.businessId) ?? DEFAULT_AGENCY_ID;
}

/**
 * Shape a Client row into a format compatible with both:
 *   - The /clients DynamicClientRecord schema (snake_case + data blob)
 *   - The agency-ops structured Client schema (camelCase + fixed fields)
 *
 * Consumers can read either form.
 */
type ClientRow = NonNullable<ReturnType<ReturnType<typeof store>["getClient"]>>;

/**
 * The fixed `clients` columns, exposed under the schema property name a
 * dynamic (Notion-shaped) renderer would look them up by.
 *
 * `Status` matters most: the CRM's canonical per-client status lives in the
 * fixed `pipeline_status_label` column and EVERY client has one, while only
 * Notion-imported rows ever carry a `data.Status`. Surfacing it here is what
 * lets the Kanban put a card in the right column instead of "uncategorised".
 */
function fixedFieldValues(c: ClientRow): Record<string, unknown> {
  return {
    Name: c.name,
    Status: c.pipelineStatusLabel ?? undefined,
    Email: c.email ?? c.billingEmail ?? undefined,
    Phone: c.phone ?? undefined,
    WhatsApp: c.whatsapp ?? undefined,
    Telegram: c.telegram ?? undefined,
    Discord: c.discord ?? undefined,
    Instagram: c.instagram ?? undefined,
    Notes: c.notes ?? undefined,
  };
}

/**
 * Merge the fixed columns into the dynamic `data` blob so the schema renderer
 * works for clients that pre-date Notion sync (blob would otherwise be `{}`).
 *
 * The blob wins wherever it actually holds a value — but an import writes an
 * explicit `null` for every property the source row left unset, so the old
 * `{ ...fixed, ...data }` spread blanked the fixed value straight back out
 * (898 of 1299 clients ended up with `Status: null`). Only genuinely empty
 * slots are filled.
 */
function mergeClientData(c: ClientRow, data: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...data };
  for (const [key, value] of Object.entries(fixedFieldValues(c))) {
    if (value === undefined || value === null || value === "") continue;
    const current = merged[key];
    if (current === undefined || current === null || current === "") merged[key] = value;
  }
  return merged;
}

function formatClient(
  c: ReturnType<ReturnType<typeof store>["getClient"]>,
): Record<string, unknown> | null {
  if (!c) return null;
  const data = (c.data && typeof c.data === "object" ? c.data : {}) as Record<string, unknown>;
  return {
    // Structured fixed fields (camelCase — agency-ops consumers)
    id: c.id,
    agencyId: c.agencyId,
    name: c.name,
    legalName: c.legalName,
    status: c.status,
    pipelineStatus: c.pipelineStatus,
    pipelineStatusLabel: c.pipelineStatusLabel,
    ownerId: c.ownerId,
    billingEmail: c.billingEmail,
    notes: c.notes,
    whatsapp: c.whatsapp,
    telegram: c.telegram,
    discord: c.discord,
    instagram: c.instagram,
    phone: c.phone,
    email: c.email,
    // Notion tracking
    notionPageId: c.notionPageId,
    lastSynced: c.lastSynced,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // DynamicClientRecord compat (snake_case — /clients page consumers)
    notion_page_id: c.notionPageId ?? null,
    last_synced: c.lastSynced ? new Date(c.lastSynced).toISOString() : null,
    created_at: new Date(c.createdAt).toISOString(),
    updated_at: new Date(c.updatedAt).toISOString(),
    data: mergeClientData(c, data),
  };
}

// ── Reconciliation from the bound business-role-bridge database ──────────────
// A business's client list is *bound* to a database via the role bridge
// (`business_role_databases` → falls back to global `system_databases`). Those
// rows live in databases.db; the CRM serves them from agency.db. We reconcile
// lazily on `clients.list` so a freshly-bound database shows up without a
// manual re-import.
//
// This used to be a strict one-shot: `dbRowsMigrated=1` was set forever, so
// REBINDING the role to a different database had no effect — the CRM kept
// serving whatever the first bound database happened to contain. Now the
// reconcile is keyed on the *currently bound* database id, so a rebind
// re-pulls, and the import is idempotent (deduped by Notion page id AND by
// normalised name) so re-running it can never duplicate rows.

/**
 * Per-process record of which database id we last reconciled each agency
 * against. Deliberately in-memory: it costs one reconcile pass per gateway
 * boot (cheap — two indexed reads plus a set diff) and needs no schema
 * change, while still catching a rebind that happens while we're running.
 */
const reconciledBindings = new Map<string, string | null>();

function normaliseClientName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function resolveBoundClientsDatabase(
  agencyId: string,
): Promise<{ databaseId: string | null; perBusiness: boolean }> {
  try {
    const { getRoleModeForBusiness } = await import("../../databases/system-role-bridge.js");
    const resolved = getRoleModeForBusiness("clients", agencyId);
    return {
      databaseId: resolved.mode === "database" ? resolved.databaseId : null,
      perBusiness: resolved.perBusiness,
    };
  } catch {
    return { databaseId: null, perBusiness: false };
  }
}

async function runDbRowsMigrationIfNeeded(agencyId: string): Promise<void> {
  const s = store();
  const { databaseId: boundDbId } = await resolveBoundClientsDatabase(agencyId);

  // Fast path: this process already reconciled this agency against exactly
  // this database, and the historical one-shot flag is set. Anything else
  // (first call after boot, or a rebind) falls through to a real reconcile.
  const config = s.getClientsNotionConfig(agencyId);
  if (config?.dbRowsMigrated && reconciledBindings.get(agencyId) === boundDbId) return;

  try {
    const { listRowsForBusinessRole } = await import("../../databases/system-role-bridge.js");
    const rows = listRowsForBusinessRole("clients", agencyId);
    if (!rows.length) {
      reconciledBindings.set(agencyId, boundDbId);
      s.setClientsNotionConfig(agencyId, { dbRowsMigrated: 1 });
      return;
    }

    // Build the dedupe indexes once instead of one SELECT per candidate row —
    // the bound database can hold thousands of rows and this runs inside a
    // list request.
    const existingRows = (s as any).db
      .prepare("SELECT notion_page_id, name FROM clients WHERE agency_id=?")
      .all(agencyId) as Array<{ notion_page_id: string | null; name: string | null }>;
    const seenPageIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const existing of existingRows) {
      if (existing.notion_page_id) seenPageIds.add(existing.notion_page_id);
      const n = normaliseClientName(existing.name);
      if (n) seenNames.add(n);
    }

    let imported = 0;
    for (const row of rows) {
      const data = (row.values ?? {}) as Record<string, unknown>;
      const name =
        (typeof data.name === "string" && data.name) ||
        (typeof data.Name === "string" && data.Name) ||
        (typeof data.email === "string" && data.email) ||
        (typeof data.Email === "string" && data.Email) ||
        row.title ||
        row.id;
      const notionPageId =
        row.externalRef?.system === "notion" ? (row.externalRef.externalId ?? null) : null;

      // Skip anything we already hold — by Notion page id first (exact), then
      // by normalised name. The name check is what keeps a re-pull after a
      // rebind (or a second bound database that overlaps) from doubling the
      // CRM, since rows imported by other paths carry no page id.
      if (notionPageId && seenPageIds.has(notionPageId)) continue;
      const nameKey = normaliseClientName(name);
      if (nameKey && seenNames.has(nameKey)) continue;

      const email =
        (typeof data.Email === "string" && data.Email) ||
        (typeof data.email === "string" && data.email) ||
        null;
      const phone =
        (typeof data.Phone === "string" && data.Phone) ||
        (typeof data.phone === "string" && data.phone) ||
        null;

      s.createClient(
        { name, email, phone, notionPageId, data: data as Record<string, unknown> },
        { agencyId },
      );
      if (notionPageId) seenPageIds.add(notionPageId);
      if (nameKey) seenNames.add(nameKey);
      imported++;
    }

    reconciledBindings.set(agencyId, boundDbId);
    s.setClientsNotionConfig(agencyId, { dbRowsMigrated: 1 });
    if (imported > 0) {
      broadcast("clients:updated", { action: "migrated", agencyId, count: imported });
    }
  } catch {
    // Non-fatal — db_rows system may not be present in all installations
  }
}

/**
 * Describe the database this agency's `clients` role is bound to, so the CRM
 * page can show which list it is actually serving instead of guessing from a
 * stale Notion binding on the business profile.
 */
async function describeBoundClientsDatabase(agencyId: string): Promise<{
  id: string;
  name: string;
  rowCount: number;
  perBusiness: boolean;
  /** Declared columns of the bound database — the schema source of record. */
  properties: BoundProperty[];
} | null> {
  try {
    const { databaseId, perBusiness } = await resolveBoundClientsDatabase(agencyId);
    if (!databaseId) return null;
    const { getDatabasesStore } = await import("../../databases/store.js");
    const dbStore = getDatabasesStore();
    const record = dbStore.getDatabase(databaseId);
    if (!record) return null;
    const rows = perBusiness
      ? dbStore.listRows(databaseId)
      : dbStore.listRows(databaseId, { businessId: agencyId });
    return {
      id: record.id,
      name: record.name,
      rowCount: rows.length,
      perBusiness,
      properties: dbStore.listProperties(databaseId) as BoundProperty[],
    };
  } catch {
    return null;
  }
}

// ── Clients schema, derived from the bound database ──────────────────────────
// The /clients page renders columns, group-by options and chips from a
// Notion-SHAPED schema (`{ properties: { <name>: { type, options } } }`). It
// used to come only from `clients_notion_config.schema_json` — which is empty
// for any business whose clients role is bound to a NATIVE database, so the
// Kanban had nothing to group by ("no property to group by") even though the
// bound database declares a Status column. We now derive the same shape from
// the bound database's `database_properties`.

/** Structural view of `DatabaseProperty` (the store is imported dynamically). */
interface BoundProperty {
  id: string;
  name: string;
  type: string;
  config: { options?: Array<{ id: string; name: string; color?: string }> } | null;
  hidden?: boolean;
}

interface ClientsSchemaOption {
  id: string;
  name: string;
  color: string;
}

interface ClientsSchemaProperty {
  id: string;
  name: string;
  type: string;
  options?: ClientsSchemaOption[];
}

interface ClientsSchema {
  databaseId: string;
  databaseName: string;
  properties: Record<string, ClientsSchemaProperty>;
  fetchedAt: number;
}

/**
 * The databases store uses camelCase property types; the /clients renderer
 * speaks Notion's snake_case vocabulary. Anything unmapped degrades to
 * `rich_text`, which renders as plain text rather than disappearing.
 */
const NOTION_TYPE_BY_STORE_TYPE: Record<string, string> = {
  title: "title",
  richText: "rich_text",
  select: "select",
  multiSelect: "multi_select",
  status: "status",
  date: "date",
  dateRange: "date",
  number: "number",
  checkbox: "checkbox",
  url: "url",
  email: "email",
  phone: "phone_number",
  files: "files",
  relation: "relation",
  person: "people",
  createdAt: "created_time",
  updatedAt: "last_edited_time",
};

const OPTION_BEARING_TYPES = new Set(["select", "multi_select", "status"]);

/**
 * The UI resolves option colours through a Notion colour-NAME table; a raw hex
 * falls through to grey. Native databases store hex, so map to the nearest
 * palette entry instead of flattening every chip to grey.
 */
const NOTION_PALETTE: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: "gray", rgb: [107, 114, 128] },
  { name: "brown", rgb: [146, 64, 14] },
  { name: "orange", rgb: [234, 88, 12] },
  { name: "yellow", rgb: [234, 179, 8] },
  { name: "green", rgb: [34, 197, 94] },
  { name: "blue", rgb: [59, 130, 246] },
  { name: "purple", rgb: [168, 85, 247] },
  { name: "pink", rgb: [236, 72, 153] },
  { name: "red", rgb: [239, 68, 68] },
];

/** Stable per-label colour so an option with no declared colour still reads. */
function paletteColorForLabel(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return NOTION_PALETTE[hash % NOTION_PALETTE.length]!.name;
}

function notionColorName(color: string | undefined, label: string): string {
  const raw = (color ?? "").trim().toLowerCase();
  if (!raw) return paletteColorForLabel(label);
  if (raw === "default" || NOTION_PALETTE.some((p) => p.name === raw)) return raw;
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (/^[0-9a-f]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    let best = NOTION_PALETTE[0]!;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of NOTION_PALETTE) {
      const distance = (entry.rgb[0] - r) ** 2 + (entry.rgb[1] - g) ** 2 + (entry.rgb[2] - b) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    }
    return best.name;
  }
  return paletteColorForLabel(label);
}

/**
 * Cap on options synthesised from row VALUES. Declared options are always
 * kept; this only stops a free-text column that happens to be typed `select`
 * from turning the board into a thousand columns.
 */
const MAX_DERIVED_OPTIONS = 60;

/**
 * Declared options first (they carry the intended label casing + colour), then
 * every value the rows ACTUALLY hold. A native database created from the
 * default template declares `Todo / In Progress / Done` while its imported
 * rows carry `Cold / Lead / Completed / …` — with declared options alone the
 * board renders three empty columns and dumps every card in "uncategorised".
 */
function collectSchemaOptions(
  prop: BoundProperty,
  rows: Array<Record<string, unknown>>,
): ClientsSchemaOption[] {
  const byLabel = new Map<string, ClientsSchemaOption>();
  const usedIds = new Set<string>();
  const uniqueId = (candidate: string): string => {
    let id = candidate;
    for (let n = 2; usedIds.has(id); n++) id = `${candidate}-${n}`;
    usedIds.add(id);
    return id;
  };
  const add = (name: unknown, id?: string, color?: string): void => {
    if (typeof name !== "string") return;
    const label = name.trim();
    if (!label) return;
    const key = label.toLowerCase();
    const existing = byLabel.get(key);
    if (existing) {
      // A declared option and a stored value can disagree on casing
      // ("In Progress" vs "In progress"). The board groups on the exact
      // string, so the value's casing has to win or the column splits in
      // two — the declared id and colour are still kept.
      if (!id && existing.name !== label) existing.name = label;
      return;
    }
    byLabel.set(key, {
      id: uniqueId(id || `opt_${key.replace(/[^a-z0-9]+/g, "-")}`),
      name: label,
      color: notionColorName(color, label),
    });
  };

  for (const option of prop.config?.options ?? []) add(option.name, option.id, option.color);

  const declared = byLabel.size;
  for (const row of rows) {
    if (byLabel.size - declared >= MAX_DERIVED_OPTIONS) break;
    const value = row[prop.name];
    if (Array.isArray(value)) {
      for (const entry of value) add(entry);
    } else {
      add(value);
    }
  }

  return [...byLabel.values()];
}

function buildBoundDatabaseSchema(
  database: { id: string; name: string; properties: BoundProperty[] },
  clients: ClientRow[],
): ClientsSchema | null {
  if (!database.properties.length) return null;
  // Merge fixed columns in once (not per property) — `Status` in particular
  // only exists on the merged view.
  const rows = clients.map((c) =>
    mergeClientData(
      c,
      (c.data && typeof c.data === "object" ? c.data : {}) as Record<string, unknown>,
    ),
  );
  const properties: Record<string, ClientsSchemaProperty> = {};
  for (const prop of database.properties) {
    const type = NOTION_TYPE_BY_STORE_TYPE[prop.type] ?? "rich_text";
    const entry: ClientsSchemaProperty = { id: prop.id, name: prop.name, type };
    if (OPTION_BEARING_TYPES.has(type)) entry.options = collectSchemaOptions(prop, rows);
    properties[prop.name] = entry;
  }
  return {
    databaseId: database.id,
    databaseName: database.name,
    properties,
    fetchedAt: Date.now(),
  };
}

function hasGroupableProperty(schema: ClientsSchema | null): boolean {
  if (!schema) return false;
  return Object.values(schema.properties ?? {}).some(
    (p) => p?.type === "status" || p?.type === "select",
  );
}

/**
 * The Notion config's schema stays authoritative whenever it has one. It only
 * gets topped up from the bound database when it carries nothing the Kanban
 * can group by — so a live Notion binding is never overwritten, and a rebound
 * (or never-synced) business still gets columns.
 */
function resolveClientsSchema(
  notionSchema: ClientsSchema | null,
  boundSchema: ClientsSchema | null,
): ClientsSchema | null {
  if (!notionSchema || !Object.keys(notionSchema.properties ?? {}).length)
    return boundSchema ?? notionSchema;
  if (!boundSchema || hasGroupableProperty(notionSchema)) return notionSchema;
  const properties = { ...notionSchema.properties };
  for (const [name, prop] of Object.entries(boundSchema.properties)) {
    if (!properties[name] && OPTION_BEARING_TYPES.has(prop.type)) properties[name] = prop;
  }
  return { ...notionSchema, properties };
}

/** A corrupt stored schema must not 500 the whole client list. */
function parseStoredSchema(raw: string | null | undefined): ClientsSchema | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ClientsSchema) : null;
  } catch {
    return null;
  }
}

// ── Notion transport helpers ─────────────────────────────────────────────────

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function getNotionKey(): string {
  const key = getNotionApiKeyForImport();
  if (!key)
    throw new Error("Notion is not configured — add NOTION_API_KEY or run the Notion wizard");
  return key;
}

async function notionFetch(key: string, path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${key}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...((opts.headers as Record<string, string>) ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Notion ${res.status}: ${body?.message ?? text.slice(0, 200)}`);
  return body;
}

function extractNotionPropertyValue(prop: any): any {
  if (!prop) return null;
  switch (prop.type) {
    case "title":
      return (prop.title ?? []).map((t: any) => t.plain_text ?? "").join("");
    case "rich_text":
      return (prop.rich_text ?? []).map((t: any) => t.plain_text ?? "").join("");
    case "select":
      return prop.select?.name ?? null;
    case "multi_select":
      return (prop.multi_select ?? []).map((o: any) => o.name);
    case "status":
      return prop.status?.name ?? null;
    case "email":
      return prop.email ?? null;
    case "phone_number":
      return prop.phone_number ?? null;
    case "url":
      return prop.url ?? null;
    case "number":
      return prop.number ?? null;
    case "date":
      return prop.date?.start ?? null;
    case "created_time":
      return prop.created_time ?? null;
    case "checkbox":
      return prop.checkbox ?? false;
    case "files":
      return (prop.files ?? []).map((f: any) => ({
        name: f.name ?? "",
        url: f.file?.url ?? f.external?.url ?? "",
      }));
    default:
      return null;
  }
}

function buildNotionPropertyValue(type: string, value: any): any | null {
  if (value === undefined || value === null) {
    switch (type) {
      case "select":
        return { select: null };
      case "email":
        return { email: null };
      case "phone_number":
        return { phone_number: null };
      case "url":
        return { url: null };
      case "number":
        return { number: null };
      case "date":
        return { date: null };
      default:
        return null;
    }
  }
  switch (type) {
    case "title":
      return { title: [{ text: { content: String(value).slice(0, 2000) } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: String(value).slice(0, 2000) } }] };
    case "select":
      return { select: { name: String(value) } };
    case "multi_select":
      return {
        multi_select: (Array.isArray(value) ? value : [value]).map((v: any) => ({
          name: String(v),
        })),
      };
    case "status":
      return { status: { name: String(value) } };
    case "email":
      return { email: String(value) || null };
    case "phone_number":
      return { phone_number: String(value) || null };
    case "url":
      return { url: String(value) || null };
    case "number":
      return { number: typeof value === "number" ? value : parseFloat(value) || null };
    case "date":
      return { date: value ? { start: String(value) } : null };
    case "checkbox":
      return { checkbox: !!value };
    default:
      return null;
  }
}

async function fetchNotionDbSchema(key: string, databaseId: string): Promise<any> {
  const db = await notionFetch(key, `/databases/${databaseId}`);
  const properties: Record<string, any> = {};
  for (const [name, def] of Object.entries((db.properties ?? {}) as Record<string, any>)) {
    const type = def?.type ?? "rich_text";
    const entry: any = { id: def?.id ?? "", name, type };
    if (def?.select?.options) entry.options = def.select.options;
    if (def?.multi_select?.options) entry.options = def.multi_select.options;
    if (def?.status?.groups) entry.groups = def.status.groups;
    properties[name] = entry;
  }
  return {
    databaseId: String(db.id ?? databaseId),
    databaseName:
      ((db.title ?? []) as any[]).map((t: any) => t.plain_text ?? "").join("") || "Clients",
    properties,
    fetchedAt: Date.now(),
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const clientsHandlers: GatewayRequestHandlers = {
  // ── CRUD ───────────────────────────────────────────────────────────────────

  "clients.list": async (opts) =>
    run(opts, async () => {
      const agencyId = resolveAgencyId(opts.params);
      const s = store();

      // One-shot migration from the legacy business-role-bridge system
      await runDbRowsMigrationIfNeeded(agencyId);

      const { page, pageSize, all: wantAll } = pageParams(opts.params);
      const status = optionalString(opts.params.status) as
        | "prospect"
        | "active"
        | "inactive"
        | undefined;
      const pipelineStatus = optionalString(opts.params.pipelineStatus);

      const all = s.listClients(agencyId, { status, pipelineStatus });

      const activeClients = all.filter((c) => c.status === "active");
      const revenueRows = s.listClientRevenue(null, agencyId, 2000);
      const mrrByClient = new Map<string, number>();
      for (const r of revenueRows) {
        mrrByClient.set(r.clientId, (mrrByClient.get(r.clientId) ?? 0) + r.amountCents);
      }
      const totalMrrCents = [...mrrByClient.values()].reduce((a, b) => a + b, 0);
      const avgDealCents =
        activeClients.length > 0 ? Math.round(totalMrrCents / activeClients.length) : 0;
      const churnCount = all.filter((c) => c.pipelineStatus === "churned").length;

      const total = all.length;
      // `all: true` returns the entire set in one response. Pagination is still
      // fully supported (and remains the default) — this is the explicit
      // opt-out for callers that need the complete list to filter/sort locally.
      const effectivePageSize = wantAll ? Math.max(total, 1) : pageSize;
      const totalPages = Math.max(1, Math.ceil(total / effectivePageSize));
      const safePage = wantAll ? 1 : Math.min(page, totalPages);
      const start = (safePage - 1) * effectivePageSize;
      const items = all.slice(start, start + effectivePageSize).map(formatClient);

      const notionConfig = s.getClientsNotionConfig(agencyId);

      // Which database this business's `clients` role is actually bound to.
      // The CRM bar used to fall back to the business profile's stale Notion
      // `crmDatabaseId`, which could name a database the list no longer comes
      // from — this is the authoritative answer.
      const bound = await describeBoundClientsDatabase(agencyId);
      const clientsDatabase = bound
        ? {
            id: bound.id,
            name: bound.name,
            rowCount: bound.rowCount,
            perBusiness: bound.perBusiness,
          }
        : null;

      // Schema: the stale Notion config first, then the bound database's own
      // columns. A rebound business has an empty `schema_json`, which is what
      // left the Kanban with "no property to group by".
      const schema = resolveClientsSchema(
        parseStoredSchema(notionConfig?.schemaJson),
        bound ? buildBoundDatabaseSchema(bound, all) : null,
      );

      return {
        clients: items,
        schema,
        clientsDatabase,
        notionConfig: notionConfig
          ? {
              connected: !!notionConfig.notionDbId,
              databaseId: notionConfig.notionDbId,
              databaseName: notionConfig.notionDbName,
              lastSync: notionConfig.lastSync,
              notionConfigured: !!getNotionApiKeyForImport(),
            }
          : {
              connected: false,
              databaseId: null,
              databaseName: null,
              lastSync: null,
              notionConfigured: !!getNotionApiKeyForImport(),
            },
        pagination: { page: safePage, pageSize: effectivePageSize, total, totalPages },
        stats: { total, active: activeClients.length, totalMrrCents, avgDealCents, churnCount },
        pipelineStatuses: s.listClientPipelineStatusCounts(agencyId),
        // Legacy compat fields for consumers that still read from the old response shape
        businessId: agencyId,
        databaseId: notionConfig?.notionDbId ?? null,
        source: "database",
      };
    }),

  "clients.get": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const id = stringParam(opts.params.id, "id");
      const client = store().getClient(id, agencyId);
      if (!client) throw new Error("client not found");
      return { client: formatClient(client), businessId: agencyId, source: "database" };
    }),

  "clients.create": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const s = store();
      const data =
        opts.params?.data && typeof opts.params.data === "object"
          ? (opts.params.data as Record<string, unknown>)
          : {};

      // Extract known fixed fields from the data blob (DynamicClientRecord compat)
      const nameFromData =
        (typeof data.Name === "string" && data.Name) ||
        (typeof data.name === "string" && data.name) ||
        (typeof data.Email === "string" && data.Email) ||
        null;

      const client = s.createClient(
        {
          name: optionalString(opts.params.name) ?? nameFromData ?? `client-${Date.now()}`,
          billingEmail:
            optionalString(opts.params.billingEmail) ??
            (typeof data.Email === "string" ? data.Email : undefined),
          email:
            optionalString(opts.params.email) ??
            (typeof data.Email === "string" ? data.Email : undefined),
          phone:
            optionalString(opts.params.phone) ??
            (typeof data.Phone === "string" ? data.Phone : undefined),
          whatsapp: optionalString(opts.params.whatsapp),
          telegram: optionalString(opts.params.telegram),
          discord: optionalString(opts.params.discord),
          instagram: optionalString(opts.params.instagram),
          pipelineStatus: optionalString(opts.params.pipelineStatus),
          notes: optionalString(opts.params.notes),
          data,
        },
        { agencyId },
      );
      broadcast("clients:updated", { action: "created", client: formatClient(client) });
      return { client: formatClient(client), businessId: agencyId, source: "database" };
    }),

  "clients.update": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const id = stringParam(opts.params.id, "id");
      const s = store();
      const nullableStr = (v: unknown) => (v === null ? null : optionalString(v));
      const data =
        opts.params?.data && typeof opts.params.data === "object"
          ? (opts.params.data as Record<string, unknown>)
          : undefined;

      const client = s.updateClient(
        id,
        {
          name: optionalString(opts.params.name),
          pipelineStatus: nullableStr(opts.params.pipelineStatus),
          billingEmail: nullableStr(opts.params.billingEmail),
          email: nullableStr(opts.params.email),
          notes: nullableStr(opts.params.notes),
          whatsapp: nullableStr(opts.params.whatsapp),
          telegram: nullableStr(opts.params.telegram),
          discord: nullableStr(opts.params.discord),
          instagram: nullableStr(opts.params.instagram),
          phone: nullableStr(opts.params.phone),
          data,
        },
        { agencyId },
      );
      broadcast("clients:updated", { action: "updated", client: formatClient(client) });
      return { client: formatClient(client), businessId: agencyId, source: "database" };
    }),

  "clients.delete": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const id = stringParam(opts.params.id, "id");
      store().deleteClient(id, { agencyId });
      broadcast("clients:updated", { action: "deleted", id });
      return { ok: true };
    }),

  /**
   * Resolve the client a lead turned into.
   *
   * `leads.saveToCRM` creates a CRM page and stamps its id onto the lead, but
   * writes nothing back the other way — so the /leads surface could show an
   * "In CRM" badge and still not know WHICH client that was. This closes the
   * loop: give it the stamped page id (or, for hand-created clients, an email)
   * and it returns the client row, so the badge becomes a link.
   *
   * A scan rather than an index: the client table is small enough that the
   * lookup is free, and an index would have to be maintained across the Notion
   * sync paths that already rewrite these rows.
   */
  "clients.findByOrigin": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const notionPageId = optionalString(opts.params.notionPageId);
      const email = optionalString(opts.params.email)?.toLowerCase();
      const name = optionalString(opts.params.name)?.toLowerCase();
      if (!notionPageId && !email && !name) {
        throw new Error("one of notionPageId, email or name is required");
      }
      // A lead knows nothing about which business its CRM page landed in, so
      // widen to every agency when the scoped lookup misses.
      const s = store();
      const rows = [
        ...s.listClients(agencyId),
        ...s
          .listAgencies()
          .filter((a) => a.id !== agencyId)
          .flatMap((a) => s.listClients(a.id)),
      ];
      const match =
        (notionPageId ? rows.find((c) => c.notionPageId === notionPageId) : undefined) ??
        (email
          ? rows.find(
              (c) =>
                (c.email ?? "").toLowerCase() === email ||
                (c.billingEmail ?? "").toLowerCase() === email,
            )
          : undefined) ??
        (name ? rows.find((c) => (c.name ?? "").toLowerCase() === name) : undefined) ??
        null;
      return {
        client: match ? { id: match.id, name: match.name } : null,
        matchedOn: match
          ? notionPageId && match.notionPageId === notionPageId
            ? "notionPageId"
            : email
              ? "email"
              : "name"
          : null,
      };
    }),

  // ── Notion CRM sync ────────────────────────────────────────────────────────

  "clients.notion.status": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const config = store().getClientsNotionConfig(agencyId);
      return {
        connected: !!config?.notionDbId,
        databaseId: config?.notionDbId ?? null,
        databaseName: config?.notionDbName ?? null,
        lastSync: config?.lastSync ?? null,
        notionConfigured: !!getNotionApiKeyForImport(),
        schemaPropertyCount: config?.schemaJson
          ? Object.keys(JSON.parse(config.schemaJson).properties ?? {}).length
          : 0,
        schemaFetchedAt: config?.schemaJson
          ? (JSON.parse(config.schemaJson).fetchedAt ?? null)
          : null,
        businessId: agencyId,
      };
    }),

  "clients.notion.schema": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const config = store().getClientsNotionConfig(agencyId);
      return {
        schema: config?.schemaJson ? JSON.parse(config.schemaJson) : null,
        businessId: agencyId,
      };
    }),

  "clients.notion.connect": async (opts) =>
    run(opts, async () => {
      const agencyId = resolveAgencyId(opts.params);
      const databaseId = stringParam(opts.params.databaseId, "databaseId");
      const databaseName = optionalString(opts.params.databaseName);
      const key = getNotionKey();

      const schema = await fetchNotionDbSchema(key, databaseId);
      const s = store();

      // If swapping databases, drop Notion-sourced clients so next import is clean
      const existing = s.getClientsNotionConfig(agencyId);
      if (existing?.notionDbId && existing.notionDbId !== databaseId) {
        const clients = s.listClients(agencyId);
        for (const c of clients) {
          if (c.notionPageId) {
            s.updateClient(c.id, { notionPageId: null, data: c.data }, { agencyId });
          }
        }
      }

      s.setClientsNotionConfig(agencyId, {
        notionDbId: databaseId,
        notionDbName: databaseName ?? schema.databaseName,
        schemaJson: JSON.stringify(schema),
        lastSync: null,
      });

      return {
        connected: true,
        databaseId,
        schema,
        databaseName: databaseName ?? schema.databaseName,
        businessId: agencyId,
      };
    }),

  "clients.notion.disconnect": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const dropClients = opts.params?.dropClients === true;
      const s = store();

      s.setClientsNotionConfig(agencyId, {
        notionDbId: null,
        notionDbName: null,
        schemaJson: null,
        lastSync: null,
      });

      if (dropClients) {
        const clients = s.listClients(agencyId);
        for (const c of clients) {
          if (c.notionPageId) s.deleteClient(c.id, { agencyId });
        }
      } else {
        // Strip notion_page_id so rows stop trying to round-trip
        const clients = s.listClients(agencyId);
        for (const c of clients) {
          if (c.notionPageId) {
            s.updateClient(c.id, { notionPageId: null }, { agencyId });
          }
        }
      }

      broadcast("clients:updated", { action: "notion_disconnected", agencyId });
      return { disconnected: true, businessId: agencyId };
    }),

  "clients.notion.import": async (opts) =>
    run(opts, async () => {
      const agencyId = resolveAgencyId(opts.params);
      const s = store();
      const config = s.getClientsNotionConfig(agencyId);
      if (!config?.notionDbId)
        throw new Error("No Notion CRM database connected — call clients.notion.connect first");

      const key = getNotionKey();
      const dbId = config.notionDbId;

      // Refresh schema before import
      let schema: any;
      try {
        schema = await fetchNotionDbSchema(key, dbId);
        s.setClientsNotionConfig(agencyId, {
          schemaJson: JSON.stringify(schema),
          notionDbName: config.notionDbName ?? schema.databaseName,
        });
      } catch {
        schema = config.schemaJson ? JSON.parse(config.schemaJson) : null;
      }

      let imported = 0,
        updated = 0;
      let cursor: string | undefined;
      let hasMore = true;

      while (hasMore) {
        const queryBody: any = { page_size: 100 };
        if (cursor) queryBody.start_cursor = cursor;
        const result = await notionFetch(key, `/databases/${dbId}/query`, {
          method: "POST",
          body: JSON.stringify(queryBody),
        });

        for (const page of result.results ?? []) {
          const pageId: string = page.id;
          const props = page.properties ?? {};
          const data: Record<string, any> = {};

          if (schema) {
            for (const [propName, propSchema] of Object.entries(
              schema.properties as Record<string, any>,
            )) {
              const propVal = props[propName];
              if (propVal) data[propName] = extractNotionPropertyValue(propVal);
            }
          } else {
            for (const [propName, propVal] of Object.entries(props)) {
              data[propName] = extractNotionPropertyValue(propVal);
            }
          }

          const name =
            (typeof data.Name === "string" && data.Name) ||
            (typeof data.name === "string" && data.name) ||
            (typeof data.Email === "string" && data.Email) ||
            pageId;
          const email = (typeof data.Email === "string" && data.Email) || null;
          const phone = (typeof data.Phone === "string" && data.Phone) || null;
          const pipelineStatus = (typeof data.Status === "string" && data.Status) || undefined;

          const existingCheck = s.listClients(agencyId).find((c) => c.notionPageId === pageId);
          s.upsertClientByNotionPageId(
            agencyId,
            pageId,
            { name, email, phone, pipelineStatus, data },
            { agencyId },
          );
          if (existingCheck) updated++;
          else imported++;
        }

        hasMore = result.has_more;
        cursor = result.next_cursor;
      }

      s.setClientsNotionConfig(agencyId, { lastSync: Date.now() });
      broadcast("clients:updated", { action: "notion_imported", agencyId, imported, updated });
      return { imported, updated, total: imported + updated, businessId: agencyId };
    }),

  "clients.notion.sync": async (opts) =>
    run(opts, async () => {
      const agencyId = resolveAgencyId(opts.params);
      const s = store();
      const config = s.getClientsNotionConfig(agencyId);
      if (!config?.notionDbId) throw new Error("No Notion CRM database connected");

      const key = getNotionKey();
      const dbId = config.notionDbId;
      const schema = config.schemaJson ? JSON.parse(config.schemaJson) : null;
      const clients = s.listClients(agencyId);

      // Build set of existing Notion page IDs
      const existingPageIds = new Set<string>();
      let cursor: string | undefined;
      let hasMore = true;
      while (hasMore) {
        const queryBody: any = { page_size: 100 };
        if (cursor) queryBody.start_cursor = cursor;
        const result = await notionFetch(key, `/databases/${dbId}/query`, {
          method: "POST",
          body: JSON.stringify(queryBody),
        });
        for (const page of result.results ?? []) existingPageIds.add(page.id);
        hasMore = result.has_more;
        cursor = result.next_cursor;
      }

      let created = 0,
        synced = 0;
      for (const client of clients) {
        const data = client.data ?? {};
        const properties: Record<string, any> = {};
        if (schema) {
          for (const [propName, propSchema] of Object.entries(
            schema.properties as Record<string, any>,
          )) {
            if (propSchema.type === "created_time" || propSchema.type === "files") continue;
            const value = data[propName];
            const built = buildNotionPropertyValue(propSchema.type, value);
            if (built !== null) properties[propName] = built;
          }
        } else {
          // No schema — just push name/email/phone as basic properties
          if (client.name) properties["Name"] = buildNotionPropertyValue("title", client.name);
          if (client.email) properties["Email"] = buildNotionPropertyValue("email", client.email);
        }

        if (client.notionPageId && existingPageIds.has(client.notionPageId)) {
          await notionFetch(key, `/pages/${client.notionPageId}`, {
            method: "PATCH",
            body: JSON.stringify({ properties }),
          });
          s.updateClient(client.id, { lastSynced: Date.now() } as any, { agencyId });
          synced++;
        } else {
          const page = await notionFetch(key, "/pages", {
            method: "POST",
            body: JSON.stringify({ parent: { database_id: dbId }, properties }),
          });
          s.updateClient(client.id, { notionPageId: page.id }, { agencyId });
          created++;
        }
      }

      const lastSync = Date.now();
      s.setClientsNotionConfig(agencyId, { lastSync });
      broadcast("clients:updated", { action: "notion_synced", agencyId });
      return { synced, created, total: clients.length, lastSync, businessId: agencyId };
    }),

  "clients.notion.create": async (opts) =>
    run(opts, async () => {
      const agencyId = resolveAgencyId(opts.params);
      const key = getNotionKey();
      const parentPageId = optionalString(opts.params.parentPageId);

      const createBody: any = {
        title: [{ type: "text", text: { content: "Clients CRM" } }],
        properties: {
          Name: { title: {} },
          Email: { email: {} },
          Phone: { phone_number: {} },
          Company: { rich_text: {} },
          Status: {
            select: {
              options: [
                { name: "Lead", color: "yellow" },
                { name: "Prospect", color: "blue" },
                { name: "Active", color: "green" },
                { name: "Inactive", color: "gray" },
              ],
            },
          },
          Tags: { multi_select: { options: [] } },
          Notes: { rich_text: {} },
        },
      };

      if (parentPageId) {
        createBody.parent = { type: "page_id", page_id: parentPageId };
      } else {
        const searchResult = await notionFetch(key, "/search", {
          method: "POST",
          body: JSON.stringify({ filter: { value: "page", property: "object" }, page_size: 1 }),
        });
        const pages = searchResult.results ?? [];
        if (!pages.length) throw new Error("No Notion pages found — provide parentPageId");
        createBody.parent = { type: "page_id", page_id: pages[0].id };
      }

      const db = await notionFetch(key, "/databases", {
        method: "POST",
        body: JSON.stringify(createBody),
      });

      const schema = await fetchNotionDbSchema(key, db.id);
      store().setClientsNotionConfig(agencyId, {
        notionDbId: db.id,
        notionDbName: schema.databaseName,
        schemaJson: JSON.stringify(schema),
      });

      return {
        databaseId: db.id,
        databaseName: schema.databaseName,
        url: db.url ?? "",
        schema,
        businessId: agencyId,
      };
    }),

  // ── Revenue log ────────────────────────────────────────────────────────────

  "clients.revenue.list": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const clientId = optionalString(opts.params.clientId) ?? null;
      const entries = store().listClientRevenue(clientId, agencyId);
      const totalCents = entries.reduce((a, e) => a + e.amountCents, 0);
      return { entries, totalCents };
    }),

  "clients.revenue.log": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const clientId = stringParam(opts.params.clientId, "clientId");
      const amountCents = Math.round(numberParam(opts.params.amount, "amount") * 100);
      const entry = store().logClientRevenue(
        {
          clientId,
          amountCents,
          currency: optionalString(opts.params.currency) ?? "USD",
          note: optionalString(opts.params.note),
          loggedAt: typeof opts.params.loggedAt === "number" ? opts.params.loggedAt : undefined,
        },
        { agencyId },
      );
      broadcast("clients:updated", { action: "revenue_logged", clientId, entry });
      return { entry };
    }),

  // ── Activity log ───────────────────────────────────────────────────────────

  "clients.activity.list": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const clientId = stringParam(opts.params.clientId, "clientId");
      const entries = store().listClientActivity(clientId, agencyId);
      return { entries };
    }),

  "clients.activity.log": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const clientId = stringParam(opts.params.clientId, "clientId");
      const entry = store().logClientActivity(
        {
          clientId,
          type: optionalString(opts.params.type),
          note: stringParam(opts.params.note, "note"),
        },
        { agencyId },
      );
      broadcast("clients:updated", { action: "activity_logged", clientId, entry });
      return { entry };
    }),

  // ── Contact block ──────────────────────────────────────────────────────────

  "clients.contacts.get": async (opts) =>
    run(opts, () => {
      const agencyId = resolveAgencyId(opts.params);
      const s = store();

      let client = null;
      if (opts.params.clientId) {
        client = s.getClient(stringParam(opts.params.clientId, "clientId"), agencyId);
      } else if (opts.params.clientName) {
        const name = stringParam(opts.params.clientName, "clientName");
        const all = s.listClients(agencyId);
        const lower = name.toLowerCase();
        client =
          all.find((c) => c.name.toLowerCase() === lower) ??
          all.find((c) => c.name.toLowerCase().includes(lower)) ??
          null;
      }
      if (!client) throw new Error("client not found");
      return {
        clientId: client.id,
        name: client.name,
        contacts: {
          whatsapp: client.whatsapp,
          telegram: client.telegram,
          discord: client.discord,
          instagram: client.instagram,
          phone: client.phone,
          email: client.email,
          billingEmail: client.billingEmail,
        },
      };
    }),

  // ── Generic import (CSV / JSON / vCard) ────────────────────────────────────

  "clients.import": async (opts) =>
    run(opts, async () => {
      const agencyId = resolveAgencyId(opts.params);
      const format =
        typeof opts.params?.format === "string" ? opts.params.format.toLowerCase() : "";
      const rawData = typeof opts.params?.data === "string" ? opts.params.data : "";
      const mapping =
        opts.params?.mapping && typeof opts.params.mapping === "object"
          ? (opts.params.mapping as Record<string, string>)
          : {};
      if (!rawData.trim()) throw new Error("data is empty");

      let rows: Array<Record<string, any>> = [];
      {
        if (format === "csv") {
          const lines = rawData.split(/\r?\n/).filter(Boolean);
          const headers = lines[0]?.split(",").map((h) => h.trim().replace(/^"|"$/g, "")) ?? [];
          rows = lines.slice(1).map((line) => {
            const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
            return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
          });
        } else if (format === "json") {
          try {
            const parsed = JSON.parse(rawData);
            rows = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            throw new Error("Invalid JSON");
          }
        }
      }

      const remap = (row: Record<string, any>): Record<string, any> => {
        if (!Object.keys(mapping).length) return row;
        const out: Record<string, any> = {};
        for (const [from, value] of Object.entries(row)) {
          const to = mapping[from] ?? from;
          if (to) out[to] = value;
        }
        return out;
      };

      const s = store();
      let imported = 0;
      for (const rawRow of rows) {
        const row = remap(rawRow);
        const name =
          (typeof row.name === "string" && row.name) ||
          (typeof row.Name === "string" && row.Name) ||
          (typeof row.email === "string" && row.email) ||
          null;
        if (!name) continue;
        s.createClient(
          {
            name,
            email: typeof row.email === "string" ? row.email : undefined,
            phone: typeof row.phone === "string" ? row.phone : undefined,
            notes: typeof row.notes === "string" ? row.notes : undefined,
            data: row,
          },
          { agencyId },
        );
        imported++;
      }

      broadcast("clients:updated", { action: "imported", agencyId, count: imported });
      return { imported, total: rows.length, businessId: agencyId };
    }),
};
