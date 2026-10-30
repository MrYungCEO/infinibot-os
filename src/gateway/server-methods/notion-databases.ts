/**
 * Universal Notion Database Manager — backend handlers.
 * Standalone system for connecting ANY Notion database, auto-detecting schema,
 * and managing pages with full CRUD + sync.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { GatewayRequestHandlers } from "./types.js";
import { getDatabasesStore } from "../../databases/store.js";
import { backfillFromNotionManager } from "../../databases/notion-manager-backfill.js";

/**
 * Keep the generic databases store in lockstep with the legacy Notion DB
 * Manager. Called from notion.db.add / notion.db.refresh to mirror changes;
 * notion.db.remove calls `syncRemoveFromDatabasesStore` instead.
 * All failures are swallowed — the legacy store remains the source of truth
 * for these calls; the mirror is advisory and eventually-consistent.
 */
function syncToDatabasesStore(): void {
  try {
    backfillFromNotionManager(getDatabasesStore());
  } catch {
    /* best-effort mirror */
  }
}

function syncRemoveFromDatabasesStore(notionDatabaseId: string): void {
  try {
    const store = getDatabasesStore();
    const mirror = store
      .listDatabases()
      .find((d) => d.source === "notion-import" && d.meta?.notionDatabaseId === notionDatabaseId);
    if (mirror) store.deleteDatabase(mirror.id);
  } catch {
    /* best-effort mirror */
  }
}

// ── Types ────────────────────────────────────────────────────

interface NotionPropertySchema {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string; color: string }[];
  groups?: { id: string; name: string; color: string; option_ids: string[] }[];
}

interface NotionDbSchema {
  databaseId: string;
  databaseName: string;
  properties: Record<string, NotionPropertySchema>;
  fetchedAt: number;
}

interface NotionDatabaseEntry {
  id: string;
  databaseId: string;
  name: string;
  icon?: string;
  schema: NotionDbSchema;
  lastSync: number | null;
  addedAt: string;
  pageCount?: number;
}

interface NotionPage {
  id: string;
  databaseId: string;
  data: Record<string, any>;
  createdTime: string;
  lastEditedTime: string;
}

interface NotionBlock {
  id: string;
  type: string;
  hasChildren: boolean;
  children?: NotionBlock[];
  data: Record<string, any>;
}

interface NotionDatabasesState {
  databases: NotionDatabaseEntry[];
  pages: Record<string, NotionPage[]>;
  blocks: Record<
    string,
    {
      blocks: NotionBlock[];
      subPages: { id: string; title: string; type: string }[];
      fetchedAt: number;
    }
  >;
}

// ── Helpers ──────────────────────────────────────────────────

function genId(): string {
  return `ndb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR ?? "state";
}

function getStatePath(): string {
  return join(getStateDir(), "notion-databases.json");
}

function loadState(): NotionDatabasesState {
  const p = getStatePath();
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      return {
        databases: raw.databases ?? [],
        pages: raw.pages ?? {},
        blocks: raw.blocks ?? {},
      };
    } catch {
      /* fall through */
    }
  }
  return { databases: [], pages: {}, blocks: {} };
}

function saveState(state: NotionDatabasesState): void {
  const p = getStatePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

// ── Notion API ───────────────────────────────────────────────

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function getNotionApiKey(): string | null {
  return process.env.NOTION_API_KEY || null;
}

async function notionFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const apiKey = getNotionApiKey();
  if (!apiKey) throw new Error("NOTION_API_KEY not set");
  const url = `${NOTION_API_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...((opts.headers as Record<string, string>) || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Notion API ${res.status}: ${body}`);
  }
  return res.json();
}

function extractDatabaseId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  // UUID format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed))
    return trimmed;
  // 32 hex chars
  if (/^[0-9a-f]{32}$/i.test(trimmed)) return formatId(trimmed);
  // URL with 32 hex chars
  const urlMatch = trimmed.match(/([0-9a-f]{32})/i);
  if (urlMatch) return formatId(urlMatch[1]);
  // URL with UUID
  const uuidMatch = trimmed.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (uuidMatch) return uuidMatch[1];
  return null;
}

function formatId(hex: string): string {
  const h = hex.replace(/-/g, "");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── Schema ───────────────────────────────────────────────────

const SKIP_PROPERTY_TYPES = new Set([
  "rollup",
  "formula",
  "button",
  "unique_id",
  "verification",
  "last_edited_by",
  "created_by",
  "people",
]);

async function fetchNotionDbSchema(databaseId: string): Promise<NotionDbSchema> {
  const db = await notionFetch(`/databases/${databaseId}`);
  const dbName = db.title?.[0]?.plain_text || "Untitled";
  const properties: Record<string, NotionPropertySchema> = {};

  for (const [name, prop] of Object.entries(db.properties ?? {})) {
    const p = prop as any;
    if (SKIP_PROPERTY_TYPES.has(p.type)) continue;

    const schema: NotionPropertySchema = { id: p.id, name, type: p.type };

    if (p.type === "select" && p.select?.options) {
      schema.options = p.select.options.map((o: any) => ({
        id: o.id,
        name: o.name,
        color: o.color ?? "default",
      }));
    } else if (p.type === "multi_select" && p.multi_select?.options) {
      schema.options = p.multi_select.options.map((o: any) => ({
        id: o.id,
        name: o.name,
        color: o.color ?? "default",
      }));
    } else if (p.type === "relation" && p.relation) {
      // Store relation metadata (database_id it points to)
      (schema as any).relationDbId = p.relation.database_id;
    } else if (p.type === "status" && p.status) {
      schema.options = (p.status.options ?? []).map((o: any) => ({
        id: o.id,
        name: o.name,
        color: o.color ?? "default",
      }));
      if (p.status.groups?.length) {
        schema.groups = p.status.groups.map((g: any) => ({
          id: g.id,
          name: g.name,
          color: g.color ?? "default",
          option_ids: g.option_ids ?? [],
        }));
      }
    }

    properties[name] = schema;
  }

  return { databaseId, databaseName: dbName, properties, fetchedAt: Date.now() };
}

// ── Property Extraction / Building ───────────────────────────

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
    case "last_edited_time":
      return prop.last_edited_time ?? null;
    case "checkbox":
      return prop.checkbox ?? false;
    case "files":
      return (prop.files ?? []).map((f: any) => ({
        name: f.name ?? "",
        url: f.file?.url ?? f.external?.url ?? "",
      }));
    case "relation":
      return (prop.relation ?? []).map((r: any) => ({ id: r.id }));
    default:
      return null;
  }
}

function buildNotionPropertyValue(type: string, value: any): any | null {
  if (value === undefined || value === null) {
    switch (type) {
      case "select":
        return { select: null };
      case "status":
        return null;
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

/** Extract a NotionPage from a raw Notion API page result */
function extractPage(raw: any, databaseId: string, schema: NotionDbSchema): NotionPage {
  const data: Record<string, any> = {};
  for (const [name, prop] of Object.entries(raw.properties ?? {})) {
    if (schema.properties[name]) {
      data[name] = extractNotionPropertyValue(prop);
    }
  }
  return {
    id: raw.id,
    databaseId,
    data,
    createdTime: raw.created_time ?? new Date().toISOString(),
    lastEditedTime: raw.last_edited_time ?? new Date().toISOString(),
  };
}

// ── Handlers ─────────────────────────────────────────────────

export const notionDatabaseHandlers: GatewayRequestHandlers = {
  /** List all connected databases */
  "notion.db.list": async ({ respond }) => {
    try {
      const state = loadState();
      respond(true, { databases: state.databases });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Connect a new database by URL/ID */
  "notion.db.add": async ({ params, respond }) => {
    try {
      const url = typeof params?.url === "string" ? params.url : "";
      const dbId = extractDatabaseId(url);
      if (!dbId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Invalid Notion URL or database ID",
        });
        return;
      }

      const state = loadState();

      // Check if already connected
      if (state.databases.some((d) => d.databaseId === dbId)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Database already connected",
        });
        return;
      }

      // Fetch schema from Notion
      const schema = await fetchNotionDbSchema(dbId);

      // Get icon from Notion database
      const dbMeta = await notionFetch(`/databases/${dbId}`);
      const icon = dbMeta.icon?.emoji ?? undefined;

      const entry: NotionDatabaseEntry = {
        id: genId(),
        databaseId: dbId,
        name: schema.databaseName,
        icon,
        schema,
        lastSync: null,
        addedAt: new Date().toISOString(),
        pageCount: 0,
      };

      state.databases.push(entry);
      state.pages[dbId] = [];
      saveState(state);
      syncToDatabasesStore();
      respond(true, { database: entry });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Disconnect a database */
  "notion.db.remove": async ({ params, respond }) => {
    try {
      const id = typeof params?.id === "string" ? params.id : "";
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
        return;
      }

      const state = loadState();
      const entry = state.databases.find((d) => d.id === id);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Database not found" });
        return;
      }

      const removedNotionId = entry.databaseId;
      state.databases = state.databases.filter((d) => d.id !== id);
      delete state.pages[entry.databaseId];
      saveState(state);
      syncRemoveFromDatabasesStore(removedNotionId);
      respond(true, { databases: state.databases });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Re-fetch schema for a database */
  "notion.db.refresh": async ({ params, respond }) => {
    try {
      const id = typeof params?.id === "string" ? params.id : "";
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
        return;
      }

      const state = loadState();
      const entry = state.databases.find((d) => d.id === id);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Database not found" });
        return;
      }

      const schema = await fetchNotionDbSchema(entry.databaseId);
      entry.schema = schema;
      entry.name = schema.databaseName;

      // Refresh icon
      const dbMeta = await notionFetch(`/databases/${entry.databaseId}`);
      entry.icon = dbMeta.icon?.emoji ?? entry.icon;

      saveState(state);
      syncToDatabasesStore();
      respond(true, { database: entry });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** List pages for a database (from local cache) */
  "notion.db.pages.list": async ({ params, respond }) => {
    try {
      const databaseId = typeof params?.databaseId === "string" ? params.databaseId : "";
      if (!databaseId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "databaseId required" });
        return;
      }

      const state = loadState();
      const entry = state.databases.find((d) => d.databaseId === databaseId);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Database not found" });
        return;
      }

      const pages = state.pages[databaseId] ?? [];
      respond(true, { pages, schema: entry.schema, database: entry });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Pull/refresh pages from Notion */
  "notion.db.pages.pull": async ({ params, respond }) => {
    try {
      const databaseId = typeof params?.databaseId === "string" ? params.databaseId : "";
      if (!databaseId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "databaseId required" });
        return;
      }

      const state = loadState();
      const entry = state.databases.find((d) => d.databaseId === databaseId);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Database not found" });
        return;
      }

      // Query all pages with pagination
      const allPages: NotionPage[] = [];
      let hasMore = true;
      let startCursor: string | undefined;

      while (hasMore) {
        const body: any = { page_size: 100 };
        if (startCursor) body.start_cursor = startCursor;

        const result = await notionFetch(`/databases/${databaseId}/query`, {
          method: "POST",
          body: JSON.stringify(body),
        });

        for (const raw of result.results ?? []) {
          allPages.push(extractPage(raw, databaseId, entry.schema));
        }
        hasMore = result.has_more ?? false;
        startCursor = result.next_cursor;
      }

      state.pages[databaseId] = allPages;
      entry.lastSync = Date.now();
      entry.pageCount = allPages.length;
      saveState(state);

      respond(true, { pages: allPages, count: allPages.length, schema: entry.schema });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Create a new page */
  "notion.db.pages.create": async ({ params, respond }) => {
    try {
      const databaseId = typeof params?.databaseId === "string" ? params.databaseId : "";
      const data = (params?.data as Record<string, any>) ?? {};
      if (!databaseId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "databaseId required" });
        return;
      }

      const state = loadState();
      const entry = state.databases.find((d) => d.databaseId === databaseId);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Database not found" });
        return;
      }

      // Build Notion properties
      const properties: Record<string, any> = {};
      for (const [name, value] of Object.entries(data)) {
        const propSchema = entry.schema.properties[name];
        if (!propSchema) continue;
        const built = buildNotionPropertyValue(propSchema.type, value);
        if (built) properties[name] = built;
      }

      const result = await notionFetch("/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: databaseId },
          properties,
        }),
      });

      const page = extractPage(result, databaseId, entry.schema);
      if (!state.pages[databaseId]) state.pages[databaseId] = [];
      state.pages[databaseId].push(page);
      entry.pageCount = state.pages[databaseId].length;
      saveState(state);

      respond(true, { page });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Update a page */
  "notion.db.pages.update": async ({ params, respond }) => {
    try {
      const pageId = typeof params?.pageId === "string" ? params.pageId : "";
      const databaseId = typeof params?.databaseId === "string" ? params.databaseId : "";
      const data = (params?.data as Record<string, any>) ?? {};
      if (!pageId || !databaseId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "pageId and databaseId required",
        });
        return;
      }

      const state = loadState();
      const entry = state.databases.find((d) => d.databaseId === databaseId);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Database not found" });
        return;
      }

      // Build Notion properties for changed fields
      const properties: Record<string, any> = {};
      for (const [name, value] of Object.entries(data)) {
        const propSchema = entry.schema.properties[name];
        if (!propSchema) continue;
        const built = buildNotionPropertyValue(propSchema.type, value);
        if (built) properties[name] = built;
      }

      const result = await notionFetch(`/pages/${pageId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });

      const updatedPage = extractPage(result, databaseId, entry.schema);

      // Update local cache
      const pages = state.pages[databaseId] ?? [];
      const idx = pages.findIndex((p) => p.id === pageId);
      if (idx >= 0) pages[idx] = updatedPage;
      else pages.push(updatedPage);
      state.pages[databaseId] = pages;
      saveState(state);

      respond(true, { page: updatedPage });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Archive/delete a page */
  "notion.db.pages.delete": async ({ params, respond }) => {
    try {
      const pageId = typeof params?.pageId === "string" ? params.pageId : "";
      const databaseId = typeof params?.databaseId === "string" ? params.databaseId : "";
      if (!pageId || !databaseId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "pageId and databaseId required",
        });
        return;
      }

      const state = loadState();

      // Archive in Notion
      await notionFetch(`/pages/${pageId}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });

      // Remove from local cache
      if (state.pages[databaseId]) {
        state.pages[databaseId] = state.pages[databaseId].filter((p) => p.id !== pageId);
        const entry = state.databases.find((d) => d.databaseId === databaseId);
        if (entry) entry.pageCount = state.pages[databaseId].length;
      }
      saveState(state);

      respond(true, { deleted: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Fetch all blocks for a page (recursive) */
  "notion.db.pages.blocks": async ({ params, respond }) => {
    try {
      const pageId = typeof params?.pageId === "string" ? params.pageId : "";
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "pageId required" });
        return;
      }

      const maxDepth = typeof params?.maxDepth === "number" ? params.maxDepth : 5;

      const fetchBlocks = async (blockId: string, depth: number): Promise<NotionBlock[]> => {
        if (depth > maxDepth) return [];
        const blocks: NotionBlock[] = [];
        let hasMore = true;
        let startCursor: string | undefined;

        while (hasMore) {
          const qs = startCursor ? `?page_size=100&start_cursor=${startCursor}` : "?page_size=100";
          const result = await notionFetch(`/blocks/${blockId}/children${qs}`);

          for (const raw of result.results ?? []) {
            const blockType = raw.type as string;
            const blockData = raw[blockType] ?? {};
            const block: NotionBlock = {
              id: raw.id,
              type: blockType,
              hasChildren: raw.has_children ?? false,
              data: blockData,
            };

            if (block.hasChildren && depth < maxDepth) {
              block.children = await fetchBlocks(raw.id, depth + 1);
            }

            blocks.push(block);
          }

          hasMore = result.has_more ?? false;
          startCursor = result.next_cursor;
        }

        return blocks;
      };

      const blocks = await fetchBlocks(pageId, 0);

      // Extract sub-pages and sub-databases
      const subPages: { id: string; title: string; type: string }[] = [];
      const walkBlocks = (blockList: NotionBlock[]) => {
        for (const b of blockList) {
          if (b.type === "child_page") {
            subPages.push({ id: b.id, title: b.data?.title ?? "Untitled", type: "page" });
          } else if (b.type === "child_database") {
            subPages.push({ id: b.id, title: b.data?.title ?? "Untitled", type: "database" });
          }
          if (b.children) walkBlocks(b.children);
        }
      };
      walkBlocks(blocks);

      // Cache in state
      const state = loadState();
      if (!state.blocks) state.blocks = {};
      state.blocks[pageId] = { blocks, subPages, fetchedAt: Date.now() };
      saveState(state);

      respond(true, { blocks, subPages });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** List sub-pages found within a page's blocks (from cache) */
  "notion.db.pages.subpages": async ({ params, respond }) => {
    try {
      const pageId = typeof params?.pageId === "string" ? params.pageId : "";
      if (!pageId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "pageId required" });
        return;
      }

      const state = loadState();
      const cached = state.blocks?.[pageId];
      if (!cached) {
        respond(true, { subPages: [] });
        return;
      }
      respond(true, { subPages: cached.subPages });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Resolve relation page titles */
  "notion.db.pages.relations": async ({ params, respond }) => {
    try {
      const pageIds = Array.isArray(params?.pageIds) ? params.pageIds : [];
      if (pageIds.length === 0) {
        respond(true, { pages: [] });
        return;
      }

      const results: { id: string; title: string }[] = [];
      for (const id of pageIds.slice(0, 25)) {
        try {
          const page = await notionFetch(`/pages/${id}`);
          // Extract title from properties
          let title = "Untitled";
          for (const prop of Object.values(page.properties ?? {})) {
            const p = prop as any;
            if (p.type === "title") {
              title = (p.title ?? []).map((t: any) => t.plain_text ?? "").join("") || "Untitled";
              break;
            }
          }
          results.push({ id, title });
        } catch {
          results.push({ id, title: "Untitled" });
        }
      }

      respond(true, { pages: results });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Discover databases in workspace */
  "notion.db.discover": async ({ respond }) => {
    try {
      const results: any[] = [];
      let hasMore = true;
      let startCursor: string | undefined;

      while (hasMore) {
        const body: any = { filter: { value: "database", property: "object" }, page_size: 100 };
        if (startCursor) body.start_cursor = startCursor;

        const res = await notionFetch("/search", {
          method: "POST",
          body: JSON.stringify(body),
        });

        for (const item of res.results ?? []) {
          const title = item.title?.[0]?.plain_text || "Untitled";
          const icon = item.icon?.emoji ?? undefined;
          results.push({
            id: item.id,
            title,
            icon,
            url: item.url ?? null,
          });
        }
        hasMore = res.has_more ?? false;
        startCursor = res.next_cursor;
      }

      respond(true, { databases: results });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
