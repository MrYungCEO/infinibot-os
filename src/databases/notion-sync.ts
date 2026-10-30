/**
 * Two-way Notion sync for individual databases.
 *
 * Opt-in per database via `meta.syncWithNotion = true` on the DatabaseRecord.
 * The database must have `meta.notionDatabaseId` set (true for notion-import
 * sources; native databases don't sync).
 *
 * Directions:
 *   pullDatabaseFromNotion — fetch pages, upsert local rows keyed by notion id.
 *   pushRowToNotion        — create (if no externalRef) or update a Notion page
 *                            from a local row.
 *   archiveRowInNotion     — soft-delete a Notion page when the local row is
 *                            deleted.
 *
 * Conflict policy: last-write-wins by timestamp. Notion's last_edited_time
 * vs local row.updatedAt. Symmetric and simple; no merge UI.
 *
 * Property coverage: title, richText, select, multiSelect, status, date,
 * number, checkbox, url, email, phone. Files/relation/person left read-only
 * on push (they round-trip via pull only).
 */

import type { DatabasesStore } from "./store.js";
import type {
  DatabaseProperty,
  DatabaseRecord,
  DatabaseRow,
  ExternalRef,
  PropertyValue,
} from "./types.js";

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const RATE_DELAY_MS = 350;

function resolveApiKey(override?: string): string {
  const key = override || process.env.NOTION_API_KEY;
  if (!key) throw new Error("No Notion API key provided.");
  return key;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchNotion(path: string, apiKey: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${body?.message ?? JSON.stringify(body)}`);
  }
  return body;
}

// ─── Pull helpers ────────────────────────────────────────────────

function richTextPlain(rich: any[] | undefined): string {
  if (!Array.isArray(rich)) return "";
  return rich.map((r) => r.plain_text ?? "").join("");
}

function mapNotionValueToLocal(nv: any): PropertyValue | null {
  if (!nv) return null;
  switch (nv.type) {
    case "title": return { type: "title", text: richTextPlain(nv.title) };
    case "rich_text": return { type: "richText", markdown: richTextPlain(nv.rich_text) };
    case "select": return { type: "select", optionId: nv.select?.id ?? null };
    case "status": return { type: "status", optionId: nv.status?.id ?? null };
    case "multi_select":
      return { type: "multiSelect", optionIds: (nv.multi_select ?? []).map((o: any) => o.id) };
    case "date":
      if (!nv.date) return { type: "date", iso: null };
      return { type: "date", iso: nv.date.start ?? null };
    case "number": return { type: "number", value: nv.number ?? null };
    case "checkbox": return { type: "checkbox", checked: Boolean(nv.checkbox) };
    case "url": return { type: "url", url: nv.url ?? null };
    case "email": return { type: "email", email: nv.email ?? null };
    case "phone_number": return { type: "phone", phone: nv.phone_number ?? null };
    case "files":
      return {
        type: "files",
        files: (nv.files ?? []).map((f: any) => ({
          name: f.name ?? "file",
          url: f.file?.url ?? f.external?.url ?? "",
        })),
      };
    case "relation": return { type: "relation", rowIds: (nv.relation ?? []).map((r: any) => r.id) };
    case "people": return { type: "person", personIds: (nv.people ?? []).map((p: any) => p.id) };
    case "created_time": return { type: "createdAt", iso: nv.created_time };
    case "last_edited_time": return { type: "updatedAt", iso: nv.last_edited_time };
    default: return null;
  }
}

// ─── Push helpers — local PropertyValue -> Notion property payload ───

function localValueToNotion(
  value: PropertyValue | undefined,
  notionPropName: string,
  notionPropType: string,
): any | null {
  if (!value) return null;
  switch (notionPropType) {
    case "title":
      if (value.type !== "title") return null;
      return { title: [{ type: "text", text: { content: value.text ?? "" } }] };
    case "rich_text":
      if (value.type !== "richText") return null;
      return { rich_text: [{ type: "text", text: { content: value.markdown ?? "" } }] };
    case "select":
      if (value.type !== "select") return null;
      return { select: value.optionId ? { id: value.optionId } : null };
    case "status":
      if (value.type !== "status") return null;
      return { status: value.optionId ? { id: value.optionId } : null };
    case "multi_select":
      if (value.type !== "multiSelect") return null;
      return { multi_select: value.optionIds.map((id) => ({ id })) };
    case "date":
      if (value.type === "date") return { date: value.iso ? { start: value.iso } : null };
      if (value.type === "dateRange") {
        return value.start ? { date: { start: value.start, end: value.end ?? undefined } } : { date: null };
      }
      return null;
    case "number":
      if (value.type !== "number") return null;
      return { number: value.value };
    case "checkbox":
      if (value.type !== "checkbox") return null;
      return { checkbox: value.checked };
    case "url":
      if (value.type !== "url") return null;
      return { url: value.url };
    case "email":
      if (value.type !== "email") return null;
      return { email: value.email };
    case "phone_number":
      if (value.type !== "phone") return null;
      return { phone_number: value.phone };
    default:
      // Skip read-only / advanced types (formula, rollup, files, relation, people, etc.)
      return null;
  }
}

/**
 * Build the Notion properties payload from a row + the database's property
 * schema. Notion keys properties by NAME, so we need property names from
 * the Notion schema (fetched alongside the database record).
 */
function buildNotionProperties(
  row: DatabaseRow,
  localProps: DatabaseProperty[],
  notionSchema: Record<string, { id: string; name: string; type: string }>,
): Record<string, any> {
  const out: Record<string, any> = {};

  // Title fallback: if no title PropertyValue, use row.title.
  const titleProp = localProps.find((p) => p.type === "title");
  if (titleProp) {
    const notionEntry = notionSchema[titleProp.name];
    if (notionEntry?.type === "title") {
      const val = row.values[titleProp.id];
      const text =
        val?.type === "title" ? val.text : row.title || "";
      out[titleProp.name] = { title: [{ type: "text", text: { content: text } }] };
    }
  }

  for (const p of localProps) {
    if (p.type === "title") continue; // handled above
    const notionEntry = notionSchema[p.name];
    if (!notionEntry) continue;
    const payload = localValueToNotion(row.values[p.id], p.name, notionEntry.type);
    if (payload) out[p.name] = payload;
  }

  return out;
}

// ─── Database Notion schema fetch (name -> {id, name, type}) ─────

async function fetchNotionDbSchema(
  notionDbId: string,
  apiKey: string,
): Promise<Record<string, { id: string; name: string; type: string }>> {
  const res = await fetchNotion(`/databases/${notionDbId}`, apiKey);
  const out: Record<string, { id: string; name: string; type: string }> = {};
  for (const [name, prop] of Object.entries(res.properties ?? {}) as Array<[string, any]>) {
    out[name] = { id: prop.id, name, type: prop.type };
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────

export interface SyncResult {
  databaseId: string;
  notionDatabaseId: string;
  pulled: number;
  pushed: number;
  archived: number;
  skipped: number;
  warnings: string[];
}

function databaseNotionId(db: DatabaseRecord): string | null {
  const raw = db.meta?.notionDatabaseId;
  return typeof raw === "string" ? raw : null;
}

export function isSyncEnabled(db: DatabaseRecord): boolean {
  return db.meta?.syncWithNotion === true;
}

export function markSyncEnabled(
  store: DatabasesStore,
  databaseId: string,
  enabled: boolean,
): DatabaseRecord | null {
  const db = store.getDatabase(databaseId);
  if (!db) return null;
  return store.updateDatabase(databaseId, {
    meta: { ...db.meta, syncWithNotion: enabled },
  });
}

/**
 * Pull all rows from Notion for a single database. Local rows not present
 * upstream are left alone (pull is non-destructive — use archive to delete).
 */
export async function pullDatabaseFromNotion(
  store: DatabasesStore,
  databaseId: string,
  apiKeyOverride?: string,
): Promise<SyncResult> {
  const db = store.getDatabase(databaseId);
  if (!db) throw new Error(`Database ${databaseId} not found`);
  const notionDbId = databaseNotionId(db);
  if (!notionDbId) throw new Error(`Database ${db.name} has no notionDatabaseId`);

  const apiKey = resolveApiKey(apiKeyOverride);
  const properties = store.listProperties(databaseId);
  const localPropByNotionId = new Map<string, DatabaseProperty>();
  for (const p of properties) {
    // imported properties are id'd as `notion_<notionPropId>`; parse out
    const match = /^notion_(.+)$/.exec(p.id);
    if (match) localPropByNotionId.set(match[1]!, p);
  }

  const result: SyncResult = {
    databaseId,
    notionDatabaseId: notionDbId,
    pulled: 0,
    pushed: 0,
    archived: 0,
    skipped: 0,
    warnings: [],
  };

  let cursor: string | undefined;
  do {
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetchNotion(`/databases/${notionDbId}/query`, apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    });

    for (const page of res.results ?? []) {
      try {
        const localValues: Record<string, PropertyValue> = {};
        let titleText = "";

        for (const [, notionValue] of Object.entries(page.properties) as Array<[string, any]>) {
          const localProp = localPropByNotionId.get(notionValue.id);
          if (!localProp) continue;
          const mapped = mapNotionValueToLocal(notionValue);
          if (!mapped) continue;
          localValues[localProp.id] = mapped;
          if (mapped.type === "title") titleText = mapped.text;
        }

        const rowId = `notion_${page.id}`;
        const existing = store.getRow(rowId);
        const remoteUpdated = new Date(page.last_edited_time).getTime();

        // last-write-wins: if the local row has been edited more recently,
        // skip the pull for it.
        if (existing && existing.updatedAt > remoteUpdated) {
          result.skipped++;
          continue;
        }

        store.upsertRow({
          id: rowId,
          databaseId,
          title: titleText || existing?.title || "Untitled",
          values: localValues,
          externalRef: {
            system: "notion",
            externalId: page.id,
            lastSyncedAt: Date.now(),
          },
        });
        result.pulled++;
      } catch (e) {
        result.warnings.push(
          `row ${page?.id ?? "?"}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    cursor = res.has_more ? res.next_cursor : undefined;
    await sleep(RATE_DELAY_MS);
  } while (cursor);

  store.updateDatabase(databaseId, {
    meta: { ...db.meta, notionLastPulledAt: Date.now() },
  });

  return result;
}

/**
 * Push a single row to Notion. Creates a page when the row has no externalRef,
 * updates otherwise. Returns the updated row with the refreshed externalRef.
 */
export async function pushRowToNotion(
  store: DatabasesStore,
  rowId: string,
  apiKeyOverride?: string,
): Promise<DatabaseRow | null> {
  const row = store.getRow(rowId);
  if (!row) return null;
  const db = store.getDatabase(row.databaseId);
  if (!db) return null;
  const notionDbId = databaseNotionId(db);
  if (!notionDbId) return null;

  const apiKey = resolveApiKey(apiKeyOverride);
  const notionSchema = await fetchNotionDbSchema(notionDbId, apiKey);
  const localProps = store.listProperties(db.id);
  const properties = buildNotionProperties(row, localProps, notionSchema);

  let pageId: string;
  if (row.externalRef?.externalId) {
    // Update
    pageId = row.externalRef.externalId;
    await fetchNotion(`/pages/${pageId}`, apiKey, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  } else {
    // Create
    const res = await fetchNotion(`/pages`, apiKey, {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: notionDbId },
        properties,
      }),
    });
    pageId = res.id;
  }

  const nextRef: ExternalRef = {
    system: "notion",
    externalId: pageId,
    lastSyncedAt: Date.now(),
  };

  return store.upsertRow({
    id: row.id,
    databaseId: row.databaseId,
    externalRef: nextRef,
  });
}

export async function archiveRowInNotion(
  row: DatabaseRow,
  apiKeyOverride?: string,
): Promise<boolean> {
  if (!row.externalRef?.externalId) return false;
  const apiKey = resolveApiKey(apiKeyOverride);
  try {
    await fetchNotion(`/pages/${row.externalRef.externalId}`, apiKey, {
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    });
    return true;
  } catch {
    return false;
  }
}
