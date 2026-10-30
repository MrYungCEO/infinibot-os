/**
 * Business profile & Notion integration RPC handlers.
 * Supports multiple businesses with Notion page content fetching.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { GatewayRequestHandlers } from "./types.js";
import { applySatelliteProxy } from "../../federation/satellite-context.js";
import {
  ensureBusinessRoleDatabase,
  getRowForBusinessRole,
  importLegacyRecordsToBusinessRole,
  upsertRowForBusinessRole,
} from "../../databases/system-role-bridge.js";
import { resolveStateDir } from "../../config/paths.js";
import { getAgencyOperationsStore } from "../../agency-operations/store.js";

// ── Types ────────────────────────────────────────────────────

/** Social media links for a business */
interface SocialMediaLinks {
  facebook?: string | null;
  instagram?: string | null;
  twitter?: string | null;
  linkedin?: string | null;
  youtube?: string | null;
  tiktok?: string | null;
  threads?: string | null;
  pinterest?: string | null;
  discord?: string | null;
  telegram?: string | null;
  whatsapp?: string | null;
  custom?: { name: string; url: string }[];
}

/** Product offering from Notion */
interface ProductOffering {
  id: string;
  notionPageId?: string;
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  category?: string;
  status?: string;
  tags?: string[];
  imageUrl?: string;
  data: Record<string, any>; // Full dynamic data
  lastSynced?: string;
}

/** Per-business brand identity used to theme sites and prime agent context. */
export interface BusinessBranding {
  colors: {
    primary?: string; // hex or CSS color
    secondary?: string;
    accent?: string;
    background?: string;
    text?: string;
  };
  fonts: {
    heading?: string; // CSS font-family stack
    body?: string;
  };
  /** Optional brand assets, in addition to top-level `logo`. */
  assets?: {
    coverImage?: string;
    favicon?: string;
    ogImage?: string;
  };
  /** Free-form voice/tone copy used by agents when speaking on behalf of this business. */
  voice?: {
    tone?: string;
    audience?: string;
    do?: string[];
    dont?: string[];
  };
}

interface BusinessProfile {
  id: string;
  name: string;
  industry: string;
  plan: string;
  planNotionUrl: string | null; // Notion page link for business plan
  planContent: string | null; // Fetched markdown from Notion page
  planContentFetchedAt: number | null;
  context: string;
  notionDatabaseId: string | null;
  notionDatabaseName: string | null;
  // ── Extended Business Details ──
  logo: string | null; // URL or data:image base64
  website: string | null; // Primary website URL
  email: string | null; // Primary contact email
  phone: string | null; // Primary contact phone
  address: string | null; // Physical address
  tagline: string | null; // Short tagline/slogan
  socialMedia: SocialMediaLinks | null;
  // ── Branding (theme tokens, voice/tone, extra assets) ──
  branding: BusinessBranding | null;
  // ── Product Offerings ──
  productOfferingsNotionDbId: string | null;
  productOfferingsNotionDbName: string | null;
  productOfferingsSchema: NotionDbSchema | null;
  products: ProductOffering[];
  productsLastSync: number | null;
  // ── CRM (per-business) ─────────────────────────────────
  /** Notion database backing this business's clients CRM. */
  crmDatabaseId: string | null;
  crmDatabaseName: string | null;
  /** Cached schema for the connected CRM DB — used by sync/import paths. */
  crmSchema: NotionDbSchema | null;
  /** Wall-clock ms of the last successful Notion import/sync for this CRM. */
  crmLastSync: number | null;
  /** Clients owned by this business. Was previously a single global array; */
  /** the loadState() migration moves any pre-existing global rows here. */
  clients: DynamicClientRecord[];
  /**
   * Top Priorities — ordered list of kanban project ids the user has
   * pinned as their focus list (max 5). Lives on the profile so it
   * survives a gateway restart; was previously localStorage-only and
   * could vanish when the browser cache was cleared or when an early
   * render auto-pruned ids before the kanban list had loaded.
   */
  priorities: string[];
  createdAt: string;
  updatedAt: string;
}

/** Dynamic client record — adapts to any Notion database schema */
interface DynamicClientRecord {
  id: string;
  notion_page_id?: string;
  data: Record<string, any>;
  created_at: string;
  updated_at: string;
  last_synced?: string;
  /** Backref to the funnel Lead this client was promoted from (set by `business.clients.fromLead`). */
  source_lead_id?: string;
}

/** Notion property schema entry */
interface NotionPropertySchema {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string; color: string }[];
  groups?: { id: string; name: string; color: string; option_ids: string[] }[];
}

/** Full Notion database schema */
interface NotionDbSchema {
  databaseId: string;
  databaseName: string;
  properties: Record<string, NotionPropertySchema>;
  fetchedAt: number;
}

interface BusinessState {
  businesses: BusinessProfile[];
  activeBusinessId: string | null;
  lastNotionSync: number | null;
  notionSyncError: string | null;
  // ── Legacy global CRM fields (kept for one-shot migration only) ──
  // Once migrated to per-business, these stop being read but are left on
  // disk as a safety backup until the user explicitly clears them.
  clients?: DynamicClientRecord[];
  clientsNotionDbId?: string | null;
  clientsNotionLastSync?: number | null;
  clientsNotionSchema?: NotionDbSchema | null;
  /** Wall-clock ms of the per-business CRM migration. Once set, the
   *  legacy global CRM fields above are ignored. */
  crmMigratedAt?: number | null;
}

// ── Helpers ──────────────────────────────────────────────────

function genId(): string {
  return `biz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getStateDir(): string {
  // Canonical resolver: honors INFINIBOT_STATE_DIR, falls back to
  // ~/.infinibot (and ~/.infinibot/users/<id> for non-default profiles).
  // The old bare `?? "state"` fallback read <cwd>/state, which is why
  // businesses/clients failed to load when the gateway booted without the
  // env var set.
  return resolveStateDir();
}

function getStatePath(): string {
  return join(getStateDir(), "business.json");
}

/**
 * Backfills the per-business CRM fields onto a profile. Called from
 * loadState() so every profile object the rest of the codebase touches has
 * the new shape — even if it was written before the per-business CRM split.
 */
function ensureProfileCrmShape(biz: any): BusinessProfile {
  return {
    ...biz,
    crmDatabaseId: biz?.crmDatabaseId ?? null,
    crmDatabaseName: biz?.crmDatabaseName ?? null,
    crmSchema: biz?.crmSchema ?? null,
    crmLastSync: biz?.crmLastSync ?? null,
    clients: Array.isArray(biz?.clients) ? biz.clients : [],
    priorities: Array.isArray(biz?.priorities)
      ? biz.priorities.filter((x: unknown): x is string => typeof x === "string").slice(0, 5)
      : [],
  } as BusinessProfile;
}

function loadState(): BusinessState {
  const p = getStatePath();
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      // Migrate from single-profile to multi-business
      if (raw.profile && !raw.businesses) {
        const profile = raw.profile;
        const biz: BusinessProfile = ensureProfileCrmShape({
          id: genId(),
          name: profile.name ?? "",
          industry: profile.industry ?? "",
          plan: profile.plan ?? "",
          planNotionUrl: null,
          planContent: null,
          planContentFetchedAt: null,
          context: profile.context ?? "",
          notionDatabaseId: profile.notionDatabaseId ?? null,
          notionDatabaseName: profile.notionDatabaseName ?? null,
          logo: null,
          website: null,
          email: null,
          phone: null,
          address: null,
          tagline: null,
          socialMedia: null,
          branding: null,
          productOfferingsNotionDbId: null,
          productOfferingsNotionDbName: null,
          productOfferingsSchema: null,
          products: [],
          productsLastSync: null,
          createdAt: profile.createdAt ?? new Date().toISOString(),
          updatedAt: profile.updatedAt ?? new Date().toISOString(),
        });
        const migrated = migrateGlobalCrmIntoBusinesses({
          businesses: [biz],
          activeBusinessId: biz.id,
          lastNotionSync: raw.lastNotionSync ?? null,
          notionSyncError: raw.notionSyncError ?? null,
          clients: raw.clients ?? [],
          clientsNotionDbId: raw.clientsNotionDbId ?? null,
          clientsNotionLastSync: raw.clientsNotionLastSync ?? null,
          clientsNotionSchema: raw.clientsNotionSchema ?? null,
          crmMigratedAt: raw.crmMigratedAt ?? null,
        });
        return migrated;
      }
      const businesses: BusinessProfile[] = (
        Array.isArray(raw.businesses) ? raw.businesses : []
      ).map(ensureProfileCrmShape);
      const state: BusinessState = {
        businesses,
        activeBusinessId: raw.activeBusinessId ?? null,
        lastNotionSync: raw.lastNotionSync ?? null,
        notionSyncError: raw.notionSyncError ?? null,
        clients: raw.clients ?? [],
        clientsNotionDbId: raw.clientsNotionDbId ?? null,
        clientsNotionLastSync: raw.clientsNotionLastSync ?? null,
        clientsNotionSchema: raw.clientsNotionSchema ?? null,
        crmMigratedAt: raw.crmMigratedAt ?? null,
      };
      return migrateGlobalCrmIntoBusinesses(state);
    } catch {
      /* fall through */
    }
  }
  return {
    businesses: [],
    activeBusinessId: null,
    lastNotionSync: null,
    notionSyncError: null,
    clients: [],
    clientsNotionDbId: null,
    clientsNotionLastSync: null,
    clientsNotionSchema: null,
    crmMigratedAt: Date.now(),
  };
}

/**
 * One-shot move of the legacy global CRM fields onto a single business
 * profile. Runs at most once per `business.json` (gated by `crmMigratedAt`).
 *
 * Targeting policy:
 * - Active business if set, otherwise the first business.
 * - If there are no businesses, does nothing — the migration runs again
 *   when the first business is created (the legacy fields stay on disk
 *   in the meantime).
 *
 * Non-destructive: legacy fields stay on disk after the migration as a
 * backup. They just stop being read.
 */
function migrateGlobalCrmIntoBusinesses(state: BusinessState): BusinessState {
  if (state.crmMigratedAt) return state;
  const target =
    state.businesses.find((b) => b.id === state.activeBusinessId) ?? state.businesses[0] ?? null;
  if (!target) return state;

  const legacyClients = state.clients ?? [];
  const legacyDbId = state.clientsNotionDbId ?? null;
  const legacySchema = state.clientsNotionSchema ?? null;
  const legacyLastSync = state.clientsNotionLastSync ?? null;

  // Only overwrite per-business fields when the legacy bucket has data —
  // a clean install with no global CRM history shouldn't trip this.
  if (legacyClients.length > 0 || legacyDbId || legacySchema) {
    if (target.clients.length === 0) target.clients = legacyClients;
    if (!target.crmDatabaseId && legacyDbId) target.crmDatabaseId = legacyDbId;
    if (!target.crmSchema && legacySchema) target.crmSchema = legacySchema;
    if (!target.crmLastSync && legacyLastSync) target.crmLastSync = legacyLastSync;
    if (!target.crmDatabaseName && legacySchema?.databaseName) {
      target.crmDatabaseName = legacySchema.databaseName;
    }
  }
  state.crmMigratedAt = Date.now();
  // Persist the migrated shape so subsequent reads skip the migration
  // path. Without this, every read of business.json would re-run the
  // copy in memory until something else triggered a save.
  try {
    saveState(state);
  } catch {
    /* non-fatal: writes happen on next mutation */
  }
  return state;
}

function saveState(state: BusinessState): void {
  const p = getStatePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

function getActive(state: BusinessState): BusinessProfile | null {
  if (!state.activeBusinessId) return state.businesses[0] ?? null;
  return (
    state.businesses.find((b) => b.id === state.activeBusinessId) ?? state.businesses[0] ?? null
  );
}

/**
 * Resolves the business profile a CRM RPC should target. Honors an explicit
 * `businessId` param when provided; otherwise falls back to the active
 * business. Returns null when neither resolves so callers can respond with
 * a clean "no business selected" error instead of mutating the wrong row.
 */
function getCrmBiz(state: BusinessState, params: any): BusinessProfile | null {
  const id =
    typeof params?.businessId === "string" && params.businessId.length > 0
      ? params.businessId
      : null;
  if (id) return state.businesses.find((b) => b.id === id) ?? null;
  return getActive(state);
}

/* ─── CRM bridge: per-business clients database (single source of truth) ───
 *
 * The user's design: each business owns a dedicated CRM database. Calls
 * to business.clients.* route through this helper, which:
 *   1. Ensures the business has a clients database mapped via
 *      business_role_databases ("clients" role).
 *   2. Migrates the business.json clients[] array into the database on
 *      first access (idempotent — re-running skips already-imported
 *      records).
 *   3. Returns the resolved database id for the caller.
 *
 * After this helper runs, the business.json clients[] array becomes a
 * read-only legacy archive. Writes go to db_rows only.
 */

const _bridgeBootstrapped = new Set<string>();

function bootstrapClientsBridge(biz: BusinessProfile): {
  databaseId: string;
  migrated: number;
} {
  // ensure mapping
  const resolved = ensureBusinessRoleDatabase(
    biz.id,
    "clients",
    `${biz.name || "Business"} — Clients`,
    `CRM for ${biz.name || biz.id}. Single source of truth — every business.clients.* write lands here.`,
  );
  // one-shot migration of biz.json clients[]
  let migrated = 0;
  if (!_bridgeBootstrapped.has(biz.id) && biz.clients?.length > 0) {
    const records = biz.clients.map((c) => {
      const data = c.data ?? {};
      // Best-effort title: name → email → id
      const title =
        (typeof data.name === "string" && data.name) ||
        (typeof data.email === "string" && data.email) ||
        c.id;
      return {
        legacyId: c.id,
        title,
        values: data as unknown as Record<string, import("../../databases/types.js").PropertyValue>,
        businessId: biz.id,
      };
    });
    const result = importLegacyRecordsToBusinessRole("clients", biz.id, records);
    migrated = result.imported;
    _bridgeBootstrapped.add(biz.id);
  } else {
    _bridgeBootstrapped.add(biz.id);
  }
  return { databaseId: resolved.databaseId!, migrated };
}

function rowToClientRecord(row: {
  id: string;
  title: string;
  values: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}): DynamicClientRecord {
  // The title was synthesized from data.name on import. Drop the bridge
  // marker and any internal fields before returning to callers.
  const data = { ...row.values };
  for (const key of Object.keys(data)) {
    if (key.startsWith("_infinibot_legacy_")) delete data[key];
  }
  return {
    id: row.id,
    data,
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

// ── Generic Client Importers (CSV / JSON / vCard) ────────────
// Used by the `business.clients.import` RPC. Each parser returns a list
// of plain rows; the RPC then runs them through the optional column
// remapping and writes them onto the active business's clients array.

/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields, embedded
 * commas/newlines inside quotes, and `""` escapes. Treats the first row
 * as the header. Empty rows are skipped.
 */
function parseCsv(text: string): Array<Record<string, any>> {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cur.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        cur.push(field);
        field = "";
        if (cur.some((c) => c.length > 0)) rows.push(cur);
        cur = [];
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    if (cur.some((c) => c.length > 0)) rows.push(cur);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Array<Record<string, any>> = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj: Record<string, any> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const val = row[c]?.trim() ?? "";
      if (val.length > 0) obj[key] = val;
    }
    if (Object.keys(obj).length > 0) out.push(obj);
  }
  return out;
}

/**
 * Parses a JSON document expected to be either an array of plain objects
 * or `{ clients: [...] }`. Each entry becomes one client row (its keys
 * are treated as property names).
 */
function parseJsonArray(text: string): Array<Record<string, any>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  let arr: unknown[];
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).clients)) {
    arr = (parsed as any).clients;
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).rows)) {
    arr = (parsed as any).rows;
  } else {
    throw new Error("JSON must be an array or { clients: [...] } / { rows: [...] }");
  }
  const out: Array<Record<string, any>> = [];
  for (const entry of arr) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      out.push(entry as Record<string, any>);
    }
  }
  return out;
}

/**
 * Tiny vCard 3.0/4.0 parser. Recognizes FN/N, EMAIL, TEL, ORG, TITLE,
 * NOTE, ADR, URL. Repeated lines (e.g. multiple emails) get joined with
 * "; ". Anything beyond these common fields is ignored — vCard is sprawling
 * and the goal here is "import contacts from your phone export," not full
 * RFC-6350 fidelity.
 */
function parseVCards(text: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  // Unfold continuation lines per RFC: a CRLF followed by space/tab is a soft wrap.
  const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  const blocks = unfolded.split(/BEGIN:VCARD/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/END:VCARD/i)[0];
    if (!body) continue;
    const card: Record<string, any> = {};
    const append = (key: string, value: string) => {
      if (!value) return;
      card[key] = card[key] ? `${card[key]}; ${value}` : value;
    };
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const left = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1);
      const propName = left.split(";")[0].toUpperCase();
      switch (propName) {
        case "FN":
          append("Name", value);
          break;
        case "N":
          // N is a structured name: Family;Given;Middle;Prefix;Suffix
          if (!card["Name"]) {
            const parts = value.split(";");
            const family = parts[0] ?? "";
            const given = parts[1] ?? "";
            const full = [given, family].filter(Boolean).join(" ").trim();
            if (full) append("Name", full);
          }
          break;
        case "EMAIL":
          append("Email", value);
          break;
        case "TEL":
          append("Phone", value);
          break;
        case "ORG":
          append("Company", value.split(";")[0]);
          break;
        case "TITLE":
          append("Title", value);
          break;
        case "NOTE":
          append("Notes", value);
          break;
        case "URL":
          append("Website", value);
          break;
        case "ADR": {
          const parts = value.split(";");
          const street = parts[2] ?? "";
          const city = parts[3] ?? "";
          const region = parts[4] ?? "";
          const postal = parts[5] ?? "";
          const country = parts[6] ?? "";
          const joined = [street, city, region, postal, country].filter(Boolean).join(", ");
          if (joined) append("Address", joined);
          break;
        }
        default:
          break;
      }
    }
    if (Object.keys(card).length > 0) out.push(card);
  }
  return out;
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

/** Extract page ID from a Notion URL */
function extractNotionPageId(url: string): string | null {
  // Formats: https://www.notion.so/Page-Title-abc123def456
  // or: https://www.notion.so/workspace/abc123def456?v=...
  // The ID is the last 32 hex chars (with or without dashes)
  const match = url.match(
    /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
  );
  return match ? match[1] : null;
}

/** Rich text array → plain markdown string */
function richTextToStr(rt: any[]): string {
  return (rt ?? [])
    .map((t: any) => {
      let text = t.plain_text ?? "";
      if (t.annotations?.bold) text = `**${text}**`;
      if (t.annotations?.italic) text = `*${text}*`;
      if (t.annotations?.code) text = `\`${text}\``;
      if (t.annotations?.strikethrough) text = `~~${text}~~`;
      if (t.annotations?.underline) text = `<u>${text}</u>`;
      if (t.href) text = `[${text}](${t.href})`;
      return text;
    })
    .join("");
}

/** Fetch ALL children blocks for a given block id (paginated) */
async function fetchAllChildBlocks(blockId: string): Promise<any[]> {
  const allBlocks: any[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const url = cursor
      ? `/blocks/${blockId}/children?start_cursor=${cursor}&page_size=100`
      : `/blocks/${blockId}/children?page_size=100`;
    const result = await notionFetch(url);
    allBlocks.push(...(result.results ?? []));
    hasMore = result.has_more;
    cursor = result.next_cursor;
  }
  return allBlocks;
}

/** Convert a table block's rows into markdown table */
async function tableBlockToMarkdown(block: any, indent: string): Promise<string[]> {
  const lines: string[] = [];
  const rows = await fetchAllChildBlocks(block.id);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cells = (row.table_row?.cells ?? []).map((cell: any[]) =>
      cell.map((t: any) => t.plain_text ?? "").join(""),
    );
    lines.push(`${indent}| ${cells.join(" | ")} |`);
    if (i === 0) {
      lines.push(`${indent}| ${cells.map(() => "---").join(" | ")} |`);
    }
  }
  return lines;
}

/**
 * Recursively convert Notion blocks to markdown.
 * - Follows has_children into nested blocks
 * - Follows child_page and child_database blocks
 * - Respects maxDepth to prevent infinite recursion
 * - Indents nested content for toggles, lists, etc.
 */
async function blocksToMarkdown(
  blocks: any[],
  depth: number = 0,
  maxDepth: number = 10,
  visitedPages: Set<string> = new Set(),
): Promise<string> {
  if (depth > maxDepth) return "*[max nesting depth reached]*\n";
  const lines: string[] = [];
  const indent = "  ".repeat(Math.max(0, depth - 1)); // indent nested content

  for (const block of blocks) {
    const type = block.type;
    const data = block[type];
    if (!data) continue;

    switch (type) {
      case "paragraph":
        lines.push(`${indent}${richTextToStr(data.rich_text)}`);
        break;
      case "heading_1":
        lines.push(`${indent}# ${richTextToStr(data.rich_text)}`);
        break;
      case "heading_2":
        lines.push(`${indent}## ${richTextToStr(data.rich_text)}`);
        break;
      case "heading_3":
        lines.push(`${indent}### ${richTextToStr(data.rich_text)}`);
        break;
      case "bulleted_list_item":
        lines.push(`${indent}- ${richTextToStr(data.rich_text)}`);
        break;
      case "numbered_list_item":
        lines.push(`${indent}1. ${richTextToStr(data.rich_text)}`);
        break;
      case "to_do": {
        const checked = data.checked ? "x" : " ";
        lines.push(`${indent}- [${checked}] ${richTextToStr(data.rich_text)}`);
        break;
      }
      case "toggle": {
        lines.push(`${indent}<details>`);
        lines.push(`${indent}<summary>${richTextToStr(data.rich_text)}</summary>`);
        lines.push("");
        // Toggle children are fetched below via has_children
        break;
      }
      case "quote":
        lines.push(`${indent}> ${richTextToStr(data.rich_text)}`);
        break;
      case "callout": {
        const icon = data.icon?.emoji ?? "💡";
        lines.push(`${indent}> ${icon} ${richTextToStr(data.rich_text)}`);
        break;
      }
      case "code": {
        const lang = data.language ?? "";
        lines.push(
          `${indent}\`\`\`${lang}`,
          `${indent}${richTextToStr(data.rich_text)}`,
          `${indent}\`\`\``,
        );
        break;
      }
      case "divider":
        lines.push(`${indent}---`);
        break;
      case "image": {
        const url = data.file?.url ?? data.external?.url ?? "";
        const caption = data.caption?.length ? richTextToStr(data.caption) : "";
        lines.push(caption ? `${indent}![${caption}](${url})` : `${indent}![image](${url})`);
        break;
      }
      case "video": {
        const url = data.file?.url ?? data.external?.url ?? "";
        lines.push(`${indent}[Video](${url})`);
        break;
      }
      case "file": {
        const url = data.file?.url ?? data.external?.url ?? "";
        const name = data.caption?.length ? richTextToStr(data.caption) : "File";
        lines.push(`${indent}[${name}](${url})`);
        break;
      }
      case "pdf": {
        const url = data.file?.url ?? data.external?.url ?? "";
        lines.push(`${indent}[PDF](${url})`);
        break;
      }
      case "bookmark":
        lines.push(`${indent}[${data.url ?? ""}](${data.url ?? ""})`);
        break;
      case "embed":
        lines.push(`${indent}[Embed](${data.url ?? ""})`);
        break;
      case "link_preview":
        lines.push(`${indent}[Link](${data.url ?? ""})`);
        break;
      case "equation":
        lines.push(`${indent}$$${data.expression ?? ""}$$`);
        break;
      case "table_of_contents":
        lines.push(`${indent}[TOC]`);
        break;
      case "breadcrumb":
        /* skip decorative */ break;
      case "column_list": {
        // Fetch columns and render each
        if (block.has_children) {
          const columns = await fetchAllChildBlocks(block.id);
          for (const col of columns) {
            if (col.has_children) {
              const colBlocks = await fetchAllChildBlocks(col.id);
              const colMd = await blocksToMarkdown(colBlocks, depth, maxDepth, visitedPages);
              lines.push(colMd);
            }
          }
        }
        break;
      }
      case "column":
        /* handled by column_list */ break;
      case "table": {
        const tableLines = await tableBlockToMarkdown(block, indent);
        lines.push(...tableLines);
        break;
      }
      case "table_row":
        /* handled by table */ break;
      case "synced_block": {
        // Synced blocks contain children or reference another block
        if (data.synced_from?.block_id) {
          // Reference to original — fetch the original's children
          try {
            const origChildren = await fetchAllChildBlocks(data.synced_from.block_id);
            const origMd = await blocksToMarkdown(origChildren, depth, maxDepth, visitedPages);
            lines.push(origMd);
          } catch {
            /* synced source may be inaccessible */
          }
        }
        // else: original synced block — children handled below via has_children
        break;
      }
      case "child_page": {
        // Recursively fetch nested page content
        const childPageId = block.id;
        const childTitle = data.title ?? "Untitled Page";
        if (!visitedPages.has(childPageId)) {
          visitedPages.add(childPageId);
          lines.push("");
          lines.push(`${indent}---`);
          lines.push(`${indent}### 📄 ${childTitle}`);
          lines.push("");
          try {
            const childBlocks = await fetchAllChildBlocks(childPageId);
            const childMd = await blocksToMarkdown(childBlocks, depth + 1, maxDepth, visitedPages);
            lines.push(childMd);
          } catch (e) {
            lines.push(`${indent}*[Error loading nested page: ${String(e).slice(0, 100)}]*`);
          }
          lines.push(`${indent}---`);
          lines.push("");
        } else {
          lines.push(`${indent}📄 ${childTitle} *(already included above)*`);
        }
        break;
      }
      case "child_database": {
        // Fetch database entries and render as a summary
        const dbTitle = data.title ?? "Untitled Database";
        lines.push("");
        lines.push(`${indent}#### 🗄️ ${dbTitle}`);
        lines.push("");
        try {
          const dbId = block.id;
          // Fetch first 100 entries from the child database
          const dbResult = await notionFetch(`/databases/${dbId}/query`, {
            method: "POST",
            body: JSON.stringify({ page_size: 100 }),
          });
          const entries = dbResult.results ?? [];
          if (entries.length === 0) {
            lines.push(`${indent}*(empty database)*`);
          } else {
            for (const entry of entries) {
              const props = entry.properties ?? {};
              // Find title property
              let entryTitle = "";
              for (const prop of Object.values(props) as any[]) {
                if (prop.type === "title") {
                  entryTitle = (prop.title ?? []).map((t: any) => t.plain_text ?? "").join("");
                  break;
                }
              }
              // Collect other visible property values
              const details: string[] = [];
              for (const [pName, pVal] of Object.entries(props) as [string, any][]) {
                if (pVal.type === "title") continue;
                const val = extractNotionPropertyValue(pVal);
                if (val !== null && val !== "" && !(Array.isArray(val) && val.length === 0)) {
                  const display = Array.isArray(val) ? val.join(", ") : String(val);
                  if (display.trim()) details.push(`${pName}: ${display}`);
                }
              }
              const detailStr = details.length > 0 ? ` — ${details.join(" | ")}` : "";
              lines.push(`${indent}- **${entryTitle || "Untitled"}**${detailStr}`);
            }
            if (dbResult.has_more) {
              lines.push(`${indent}- *(${entries.length}+ entries, showing first page)*`);
            }
          }
        } catch (e) {
          lines.push(`${indent}*[Error loading database: ${String(e).slice(0, 100)}]*`);
        }
        lines.push("");
        break;
      }
      case "link_to_page": {
        // Link to another page — follow it
        const linkedPageId = data.page_id ?? data.database_id ?? null;
        if (linkedPageId && !visitedPages.has(linkedPageId)) {
          visitedPages.add(linkedPageId);
          try {
            // Get page title
            const linkedPage = await notionFetch(`/pages/${linkedPageId}`);
            let linkedTitle = "";
            for (const prop of Object.values(linkedPage.properties ?? {}) as any[]) {
              if (prop.type === "title") {
                linkedTitle = (prop.title ?? []).map((t: any) => t.plain_text ?? "").join("");
                break;
              }
            }
            lines.push("");
            lines.push(`${indent}---`);
            lines.push(`${indent}### 🔗 ${linkedTitle || "Linked Page"}`);
            lines.push("");
            const linkedBlocks = await fetchAllChildBlocks(linkedPageId);
            const linkedMd = await blocksToMarkdown(
              linkedBlocks,
              depth + 1,
              maxDepth,
              visitedPages,
            );
            lines.push(linkedMd);
            lines.push(`${indent}---`);
          } catch (e) {
            lines.push(`${indent}*[Error loading linked page: ${String(e).slice(0, 100)}]*`);
          }
        } else if (linkedPageId) {
          lines.push(`${indent}🔗 *(linked page already included)*`);
        }
        break;
      }
      default: {
        if (data.rich_text) lines.push(`${indent}${richTextToStr(data.rich_text)}`);
      }
    }
    lines.push("");

    // ── Recurse into child blocks (for toggles, lists, callouts, etc.) ──
    if (
      block.has_children &&
      !["child_page", "child_database", "column_list", "table", "synced_block"].includes(type)
    ) {
      try {
        const children = await fetchAllChildBlocks(block.id);
        const childMd = await blocksToMarkdown(children, depth + 1, maxDepth, visitedPages);
        lines.push(childMd);
      } catch {
        /* non-fatal */
      }
    }

    // Close toggle details tag
    if (type === "toggle") {
      lines.push(`${indent}</details>`);
      lines.push("");
    }
  }
  return lines.join("\n").trim();
}

/** Fetch a Notion page's content as markdown (recursive — follows nested pages & databases) */
async function fetchNotionPageContent(
  pageIdOrUrl: string,
): Promise<{ title: string; content: string }> {
  const pageId = extractNotionPageId(pageIdOrUrl) ?? pageIdOrUrl;

  // Get page properties for title + all property values
  const page = await notionFetch(`/pages/${pageId}`);
  let title = "";
  const propLines: string[] = [];
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title?.length > 0) {
      title = prop.title.map((t: any) => t.plain_text).join("");
    }
    // Also extract property values for the page header
    const val = extractNotionPropertyValue(prop);
    if (val !== null && val !== "" && !(Array.isArray(val) && val.length === 0)) {
      const display = Array.isArray(val) ? val.join(", ") : String(val);
      if (display.trim() && prop.type !== "title") {
        propLines.push(`- **${key}:** ${display}`);
      }
    }
  }

  // Get all top-level blocks (paginated)
  const allBlocks = await fetchAllChildBlocks(pageId);

  // Track visited pages to prevent circular references
  const visited = new Set<string>();
  visited.add(pageId);

  // Recursively convert all blocks to markdown
  const bodyContent = await blocksToMarkdown(allBlocks, 0, 10, visited);

  // Build full page content with properties header
  const sections: string[] = [];
  if (propLines.length > 0) {
    sections.push(`**Page Properties:**\n${propLines.join("\n")}`);
    sections.push("");
  }
  sections.push(bodyContent);

  return { title: title || "Untitled", content: sections.join("\n").trim() };
}

// ── Notion Schema Helpers ────────────────────────────────────

const SKIP_PROPERTY_TYPES = new Set([
  "relation",
  "rollup",
  "formula",
  "button",
  "unique_id",
  "verification",
  "last_edited_by",
  "last_edited_time",
  "created_by",
  "people",
]);

/** Fetch and parse a Notion database schema */
async function fetchNotionDbSchema(databaseId: string): Promise<NotionDbSchema> {
  const db = await notionFetch(`/databases/${databaseId}`);
  const dbName = db.title?.[0]?.plain_text || "Untitled";
  const properties: Record<string, NotionPropertySchema> = {};

  for (const [name, prop] of Object.entries(db.properties ?? {})) {
    const p = prop as any;
    if (SKIP_PROPERTY_TYPES.has(p.type)) continue;

    const schema: NotionPropertySchema = { id: p.id, name, type: p.type };

    // Extract options for select/multi_select/status
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

/** Extract a normalized value from a Notion page property */
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

/** Build a Notion API property value from normalized data + schema type */
function buildNotionPropertyValue(type: string, value: any): any | null {
  if (value === undefined || value === null) {
    // Return null-clearing values for clearable types
    switch (type) {
      case "select":
        return { select: null };
      case "status":
        return null; // can't null status
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
    // Skip files, created_time (read-only)
    default:
      return null;
  }
}

/**
 * Every Notion database id this install knows about across all business
 * profiles. Used by the Notion import wizard to surface DBs the user has
 * already attached — Notion's `/search` endpoint silently omits child
 * databases shared via a parent page, so without this list those DBs
 * never appear in the picker even though the integration can read them.
 */
export function getAllBusinessNotionDbIds(): string[] {
  try {
    const state = loadState();
    const ids = new Set<string>();
    for (const biz of state.businesses ?? []) {
      if (biz.notionDatabaseId) ids.add(biz.notionDatabaseId);
      if (biz.crmDatabaseId) ids.add(biz.crmDatabaseId);
      if (biz.productOfferingsNotionDbId) ids.add(biz.productOfferingsNotionDbId);
    }
    // Legacy global CRM id from pre-multi-business installs — still on
    // disk for some users; harmless to include even when superseded.
    if (state.clientsNotionDbId) ids.add(state.clientsNotionDbId);
    return Array.from(ids);
  } catch {
    return [];
  }
}

// ── Handlers ─────────────────────────────────────────────────

const _rawBusinessHandlers: GatewayRequestHandlers = {
  /** List all businesses */
  "business.list": async ({ respond }) => {
    try {
      const state = loadState();
      respond(true, { businesses: state.businesses, activeId: state.activeBusinessId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Get active business (or by id) */
  "business.get": async ({ params, respond }) => {
    try {
      const state = loadState();
      const id = typeof params?.id === "string" ? params.id : null;
      let biz: BusinessProfile | null;
      if (id) {
        biz = state.businesses.find((b) => b.id === id) ?? null;
      } else {
        biz = getActive(state);
      }
      respond(true, {
        profile: biz,
        businesses: state.businesses,
        activeId: state.activeBusinessId,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Create a new business */
  "business.create": async ({ params, respond }) => {
    try {
      const state = loadState();
      const now = new Date().toISOString();
      const biz: BusinessProfile = {
        id: genId(),
        name: typeof params?.name === "string" ? params.name : "New Business",
        industry: typeof params?.industry === "string" ? params.industry : "",
        plan: typeof params?.plan === "string" ? params.plan : "",
        planNotionUrl: typeof params?.planNotionUrl === "string" ? params.planNotionUrl : null,
        planContent: null,
        planContentFetchedAt: null,
        context: typeof params?.context === "string" ? params.context : "",
        notionDatabaseId: null,
        notionDatabaseName: null,
        logo: null,
        website: null,
        email: null,
        phone: null,
        address: null,
        tagline: null,
        socialMedia: null,
        branding: null,
        productOfferingsNotionDbId: null,
        productOfferingsNotionDbName: null,
        productOfferingsSchema: null,
        products: [],
        productsLastSync: null,
        crmDatabaseId: null,
        crmDatabaseName: null,
        crmSchema: null,
        crmLastSync: null,
        clients: [],
        priorities: [],
        createdAt: now,
        updatedAt: now,
      };
      state.businesses.push(biz);
      state.activeBusinessId = biz.id;
      // Run the CRM migration in case this is the first business — global
      // legacy clients move onto it before we save.
      migrateGlobalCrmIntoBusinesses(state);
      saveState(state);
      respond(true, { profile: biz, businesses: state.businesses });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Save/update a business */
  "business.save": async ({ params, respond }) => {
    try {
      const state = loadState();
      const id = typeof params?.id === "string" ? params.id : state.activeBusinessId;
      let biz = state.businesses.find((b) => b.id === id);

      const now = new Date().toISOString();
      if (!biz) {
        // Auto-create if no businesses exist
        biz = {
          id: genId(),
          name: "",
          industry: "",
          plan: "",
          planNotionUrl: null,
          planContent: null,
          planContentFetchedAt: null,
          context: "",
          notionDatabaseId: null,
          notionDatabaseName: null,
          logo: null,
          website: null,
          email: null,
          phone: null,
          address: null,
          tagline: null,
          socialMedia: null,
          branding: null,
          productOfferingsNotionDbId: null,
          productOfferingsNotionDbName: null,
          productOfferingsSchema: null,
          products: [],
          productsLastSync: null,
          crmDatabaseId: null,
          crmDatabaseName: null,
          crmSchema: null,
          crmLastSync: null,
          clients: [],
          priorities: [],
          createdAt: now,
          updatedAt: now,
        };
        state.businesses.push(biz);
        state.activeBusinessId = biz.id;
      }

      if (typeof params?.name === "string") biz!.name = params.name;
      if (typeof params?.industry === "string") biz!.industry = params.industry;
      if (typeof params?.plan === "string") biz!.plan = params.plan;
      if (typeof params?.planNotionUrl === "string")
        biz!.planNotionUrl = params.planNotionUrl || null;
      if (typeof params?.context === "string") biz!.context = params.context;
      // Identity / contact (already supported in some forks)
      if (typeof params?.logo === "string" || params?.logo === null)
        biz!.logo = params.logo as string | null;
      if (typeof params?.tagline === "string" || params?.tagline === null)
        biz!.tagline = params.tagline as string | null;
      if (typeof params?.website === "string" || params?.website === null)
        biz!.website = params.website as string | null;
      if (typeof params?.email === "string" || params?.email === null)
        biz!.email = params.email as string | null;
      if (typeof params?.phone === "string" || params?.phone === null)
        biz!.phone = params.phone as string | null;
      if (typeof params?.address === "string" || params?.address === null)
        biz!.address = params.address as string | null;
      if (params?.socialMedia && typeof params.socialMedia === "object")
        biz!.socialMedia = params.socialMedia as SocialMediaLinks;
      // Branding tokens (colors, fonts, voice, extra assets) — partial merge
      if (params?.branding && typeof params.branding === "object") {
        const incoming = params.branding as Record<string, unknown>;
        const existing = biz!.branding ?? ({ colors: {}, fonts: {} } as BusinessBranding);
        biz!.branding = {
          colors: { ...existing.colors, ...((incoming.colors as object) ?? {}) },
          fonts: { ...existing.fonts, ...((incoming.fonts as object) ?? {}) },
          assets: { ...existing.assets, ...((incoming.assets as object) ?? {}) },
          voice: { ...existing.voice, ...((incoming.voice as object) ?? {}) },
        };
      }
      biz!.updatedAt = now;

      saveState(state);
      respond(true, { profile: biz });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Get a business's branding (colors, fonts, voice, assets). */
  "business.branding.get": async ({ params, respond }) => {
    try {
      const state = loadState();
      const id =
        typeof params?.id === "string"
          ? params.id
          : typeof params?.businessId === "string"
            ? params.businessId
            : null;
      const biz = id ? (state.businesses.find((b) => b.id === id) ?? null) : getActive(state);
      if (!biz) {
        respond(true, { branding: null, profile: null });
        return;
      }
      respond(true, {
        profile: {
          id: biz.id,
          name: biz.name,
          tagline: biz.tagline,
          logo: biz.logo,
          website: biz.website,
          email: biz.email,
          phone: biz.phone,
          address: biz.address,
          industry: biz.industry,
          socialMedia: biz.socialMedia,
        },
        branding: biz.branding,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Update a business's branding (colors, fonts, voice, assets) — partial merge. */
  "business.branding.set": async ({ params, respond }) => {
    try {
      const state = loadState();
      const id =
        typeof params?.id === "string"
          ? params.id
          : typeof params?.businessId === "string"
            ? params.businessId
            : state.activeBusinessId;
      const biz = state.businesses.find((b) => b.id === id);
      if (!biz) {
        respond(false, undefined, { code: "NOT_FOUND", message: "business not found" });
        return;
      }
      const incoming =
        params?.branding && typeof params.branding === "object"
          ? (params.branding as Record<string, unknown>)
          : {};
      const existing = biz.branding ?? ({ colors: {}, fonts: {} } as BusinessBranding);
      biz.branding = {
        colors: { ...existing.colors, ...((incoming.colors as object) ?? {}) },
        fonts: { ...existing.fonts, ...((incoming.fonts as object) ?? {}) },
        assets: { ...existing.assets, ...((incoming.assets as object) ?? {}) },
        voice: { ...existing.voice, ...((incoming.voice as object) ?? {}) },
      };
      biz.updatedAt = new Date().toISOString();
      saveState(state);
      respond(true, { branding: biz.branding });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Render a business's brand identity as a markdown system-prompt fragment for agent chat.
   * Agents call this when they need to ground a response in a specific business context.
   */
  "business.brandPrompt": async ({ params, respond }) => {
    try {
      const id =
        typeof params?.id === "string"
          ? params.id
          : typeof params?.businessId === "string"
            ? params.businessId
            : undefined;
      const { formatBusinessContextPrompt } = await import("../../business/branding.js");
      respond(true, { prompt: formatBusinessContextPrompt(id) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Delete a business */
  "business.delete": async ({ params, respond }) => {
    try {
      const state = loadState();
      const id = typeof params?.id === "string" ? params.id : null;
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
        return;
      }

      state.businesses = state.businesses.filter((b) => b.id !== id);
      if (state.activeBusinessId === id) {
        state.activeBusinessId = state.businesses[0]?.id ?? null;
      }
      saveState(state);
      respond(true, { businesses: state.businesses, activeId: state.activeBusinessId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Set active business */
  "business.setActive": async ({ params, respond }) => {
    try {
      const state = loadState();
      const id = typeof params?.id === "string" ? params.id : null;
      if (!id || !state.businesses.find((b) => b.id === id)) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "invalid business id" });
        return;
      }
      state.activeBusinessId = id;
      saveState(state);
      respond(true, { activeId: id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Top Priorities (per-business focus list) ──────────────
  // Stores up to 5 ordered project ids on the business profile so the
  // user's focus list survives a gateway restart. Was browser-localStorage-
  // only before, which meant pinned priorities looked "not persistent
  // across resets" any time the browser cache was cleared (or any time the
  // pre-load auto-prune fired against an empty kanban list).

  /** Get the active (or named) business's pinned priority project ids. */
  "business.priorities.get": async ({ params, respond }) => {
    try {
      const state = loadState();
      const biz = getCrmBiz(state, params);
      respond(true, {
        priorities: biz?.priorities ?? [],
        businessId: biz?.id ?? null,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Replace the priority list for the active (or named) business.
   * Truncates to 5 entries and dedupes; non-string entries are dropped so
   * a malformed client can't poison the array.
   */
  "business.priorities.set": async ({ params, respond }) => {
    try {
      const state = loadState();
      const biz = getCrmBiz(state, params);
      if (!biz) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "no business selected" });
        return;
      }
      const incoming = Array.isArray(params?.priorities) ? params.priorities : [];
      const cleaned = Array.from(
        new Set(
          incoming.filter((x: unknown): x is string => typeof x === "string" && x.length > 0),
        ),
      ).slice(0, 5);
      biz.priorities = cleaned;
      biz.updatedAt = new Date().toISOString();
      saveState(state);
      respond(true, { priorities: biz.priorities, businessId: biz.id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Fetch markdown content from a Notion page URL */
  "business.notion.fetchPage": async ({ params, respond }) => {
    try {
      if (!getNotionApiKey()) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "NOTION_API_KEY not set" });
        return;
      }
      const url = typeof params?.url === "string" ? params.url : "";
      const businessId = typeof params?.businessId === "string" ? params.businessId : null;
      if (!url) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "url required" });
        return;
      }

      const { title, content } = await fetchNotionPageContent(url);

      // If businessId provided, save the content to the business
      if (businessId) {
        const state = loadState();
        const biz = state.businesses.find((b) => b.id === businessId);
        if (biz) {
          biz.planNotionUrl = url;
          biz.planContent = content;
          biz.planContentFetchedAt = Date.now();
          biz.updatedAt = new Date().toISOString();
          saveState(state);
        }
      }

      respond(true, { title, content, fetchedAt: Date.now() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** List Notion databases */
  "business.notion.databases": async ({ respond }) => {
    try {
      if (!getNotionApiKey()) {
        respond(true, { databases: [], error: "NOTION_API_KEY not configured" });
        return;
      }
      const result = await notionFetch("/search", {
        method: "POST",
        body: JSON.stringify({
          filter: { value: "database", property: "object" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 100,
        }),
      });
      const databases = (result.results ?? []).map((db: any) => ({
        id: db.id,
        title: db.title?.[0]?.plain_text || "Untitled",
        icon: db.icon?.emoji || db.icon?.external?.url || null,
        url: db.url || "",
        createdTime: db.created_time || "",
      }));
      respond(true, { databases });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Create a new Notion database */
  "business.notion.create": async ({ params, respond }) => {
    try {
      if (!getNotionApiKey()) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "NOTION_API_KEY not set" });
        return;
      }
      const parentPageId =
        typeof params?.parentPageId === "string" ? params.parentPageId : undefined;
      const dbName = typeof params?.name === "string" ? params.name : "InfiniBot Business";
      const businessId = typeof params?.businessId === "string" ? params.businessId : null;

      const createBody: any = {
        title: [{ type: "text", text: { content: dbName } }],
        properties: {
          Name: { title: {} },
          Industry: { rich_text: {} },
          Plan: { rich_text: {} },
          Context: { rich_text: {} },
          Status: {
            select: {
              options: [
                { name: "Active", color: "green" },
                { name: "Planning", color: "yellow" },
                { name: "Archived", color: "gray" },
              ],
            },
          },
          "Last Synced": { date: {} },
        },
      };

      if (parentPageId) {
        createBody.parent = { type: "page_id", page_id: parentPageId };
      } else {
        const searchResult = await notionFetch("/search", {
          method: "POST",
          body: JSON.stringify({ filter: { value: "page", property: "object" }, page_size: 1 }),
        });
        const pages = searchResult.results ?? [];
        if (pages.length > 0) {
          createBody.parent = { type: "page_id", page_id: pages[0].id };
        } else {
          respond(false, undefined, {
            code: "INTERNAL_ERROR",
            message: "No pages found. Provide a parentPageId.",
          });
          return;
        }
      }

      const db = await notionFetch("/databases", {
        method: "POST",
        body: JSON.stringify(createBody),
      });

      // Connect to active or specified business
      const state = loadState();
      const biz = businessId ? state.businesses.find((b) => b.id === businessId) : getActive(state);
      if (biz) {
        biz.notionDatabaseId = db.id;
        biz.notionDatabaseName = dbName;
        biz.updatedAt = new Date().toISOString();
        saveState(state);
      }

      respond(true, { database: { id: db.id, title: dbName, url: db.url || "" }, profile: biz });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Connect an existing Notion database */
  "business.notion.connect": async ({ params, respond }) => {
    try {
      const databaseId = typeof params?.databaseId === "string" ? params.databaseId : null;
      const databaseName = typeof params?.databaseName === "string" ? params.databaseName : null;
      const businessId = typeof params?.businessId === "string" ? params.businessId : null;
      if (!databaseId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "databaseId required" });
        return;
      }

      const state = loadState();
      const now = new Date().toISOString();
      let biz = businessId ? state.businesses.find((b) => b.id === businessId) : getActive(state);

      if (!biz) {
        biz = {
          id: genId(),
          name: "",
          industry: "",
          plan: "",
          planNotionUrl: null,
          planContent: null,
          planContentFetchedAt: null,
          context: "",
          notionDatabaseId: databaseId,
          notionDatabaseName: databaseName,
          logo: null,
          website: null,
          email: null,
          phone: null,
          address: null,
          tagline: null,
          socialMedia: null,
          branding: null,
          productOfferingsNotionDbId: null,
          productOfferingsNotionDbName: null,
          productOfferingsSchema: null,
          products: [],
          productsLastSync: null,
          crmDatabaseId: null,
          crmDatabaseName: null,
          crmSchema: null,
          crmLastSync: null,
          clients: [],
          priorities: [],
          createdAt: now,
          updatedAt: now,
        };
        state.businesses.push(biz!);
        state.activeBusinessId = biz!.id;
      } else {
        biz.notionDatabaseId = databaseId;
        biz.notionDatabaseName = databaseName;
        biz.updatedAt = now;
      }

      saveState(state);
      respond(true, { profile: biz });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Sync active business to Notion */
  "business.notion.sync": async ({ params, respond }) => {
    try {
      const state = loadState();
      const businessId = typeof params?.businessId === "string" ? params.businessId : null;
      const biz = businessId ? state.businesses.find((b) => b.id === businessId) : getActive(state);

      if (!biz?.notionDatabaseId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "No Notion database connected",
        });
        return;
      }
      if (!getNotionApiKey()) {
        respond(false, undefined, { code: "INTERNAL_ERROR", message: "NOTION_API_KEY not set" });
        return;
      }

      const dbId = biz.notionDatabaseId;
      const existing = await notionFetch(`/databases/${dbId}/query`, {
        method: "POST",
        body: JSON.stringify({ page_size: 100 }),
      });

      let pageId: string | null = null;
      for (const page of existing.results ?? []) {
        if (page.properties?.Name?.title?.[0]?.plain_text === biz.name) {
          pageId = page.id;
          break;
        }
      }

      const properties: any = {
        Name: { title: [{ text: { content: biz.name || "Untitled" } }] },
        Industry: { rich_text: [{ text: { content: biz.industry || "" } }] },
        Plan: { rich_text: [{ text: { content: (biz.plan || "").slice(0, 2000) } }] },
        Context: { rich_text: [{ text: { content: (biz.context || "").slice(0, 2000) } }] },
        Status: { select: { name: "Active" } },
        "Last Synced": { date: { start: new Date().toISOString() } },
      };

      if (pageId) {
        await notionFetch(`/pages/${pageId}`, {
          method: "PATCH",
          body: JSON.stringify({ properties }),
        });
      } else {
        await notionFetch("/pages", {
          method: "POST",
          body: JSON.stringify({ parent: { database_id: dbId }, properties }),
        });
      }

      state.lastNotionSync = Date.now();
      state.notionSyncError = null;
      saveState(state);
      respond(true, {
        synced: true,
        lastSync: state.lastNotionSync,
        action: pageId ? "updated" : "created",
      });
    } catch (e) {
      const state = loadState();
      state.notionSyncError = String(e);
      saveState(state);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Get sync status */
  "business.notion.status": async ({ respond }) => {
    try {
      const state = loadState();
      const biz = getActive(state);
      respond(true, {
        connected: !!biz?.notionDatabaseId,
        databaseId: biz?.notionDatabaseId ?? null,
        databaseName: biz?.notionDatabaseName ?? null,
        lastSync: state.lastNotionSync,
        syncError: state.notionSyncError,
        notionConfigured: !!getNotionApiKey(),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Client CRM Operations (Dynamic Schema, per-business) ───
  // The clients array, connected Notion DB id/name, schema and last-sync
  // timestamp all live on the BusinessProfile now. Methods take an
  // optional `businessId` param; when omitted, they act on the active
  // business. Methods that operate on a single client (get/update/delete)
  // walk every business when no businessId is supplied so existing callers
  // that didn't carry the id keep working — the id space is still global.

  /** List clients + schema for the requested business. Reads from the
   *  business's dedicated CRM database (db_rows) — auto-creating the
   *  database and migrating the legacy biz.clients[] array on first call. */
  "business.clients.list": async ({ params, respond }) => {
    try {
      // Delegate to the canonical agency store (single source of truth)
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const agencyStore = getAgencyOperationsStore(resolveStateDir());
      const all = agencyStore.listClients(agencyId);
      const config = agencyStore.getClientsNotionConfig(agencyId);
      const schema = config?.schemaJson ? JSON.parse(config.schemaJson) : null;
      // Return DynamicClientRecord-compatible shape
      const clients = all.map((c) => {
        const data = c.data ?? {};
        return {
          id: c.id,
          notion_page_id: c.notionPageId ?? null,
          data: {
            Name: c.name,
            Email: c.email ?? c.billingEmail,
            Phone: c.phone,
            WhatsApp: c.whatsapp,
            Telegram: c.telegram,
            Discord: c.discord,
            Instagram: c.instagram,
            Notes: c.notes,
            ...data,
          },
          created_at: new Date(c.createdAt).toISOString(),
          updated_at: new Date(c.updatedAt).toISOString(),
          last_synced: c.lastSynced ? new Date(c.lastSynced).toISOString() : null,
          // Also include structured fields for agency-ops compat
          agencyId: c.agencyId,
          name: c.name,
          status: c.status,
          pipelineStatus: c.pipelineStatus,
          pipelineStatusLabel: c.pipelineStatusLabel,
          billingEmail: c.billingEmail,
          email: c.email,
          phone: c.phone,
          whatsapp: c.whatsapp,
          telegram: c.telegram,
          discord: c.discord,
          instagram: c.instagram,
          notes: c.notes,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        };
      });
      respond(true, {
        clients,
        schema,
        businessId: agencyId,
        databaseId: config?.notionDbId ?? null,
        source: "database",
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.create": async ({ params, respond }) => {
    try {
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const agencyStore = getAgencyOperationsStore(resolveStateDir());
      const data =
        params?.data && typeof params.data === "object" ? (params.data as Record<string, any>) : {};
      const name =
        (typeof data.name === "string" && data.name) ||
        (typeof data.Name === "string" && data.Name) ||
        (typeof data.email === "string" && data.email) ||
        `client-${Date.now()}`;
      const client = agencyStore.createClient(
        {
          name,
          email: data.Email ?? data.email,
          phone: data.Phone ?? data.phone,
          billingEmail: data.billingEmail,
          notes: data.Notes ?? data.notes,
          data,
        },
        { agencyId },
      );
      const formatted = {
        id: client.id,
        notion_page_id: null,
        data,
        created_at: new Date(client.createdAt).toISOString(),
        updated_at: new Date(client.updatedAt).toISOString(),
      };
      respond(true, { client: formatted, businessId: agencyId, source: "database" });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.get": async ({ params, respond }) => {
    try {
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const id = typeof params?.id === "string" ? params.id : null;
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
        return;
      }
      const agencyStore = getAgencyOperationsStore(resolveStateDir());
      let found = agencyStore.getClient(id, agencyId);
      if (!found) {
        // Walk other agencies as fallback
        const { DEFAULT_AGENCY_ID } = await import("../../agency-operations/types.js");
        found = agencyStore.getClient(id, DEFAULT_AGENCY_ID);
      }
      if (!found) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Client not found" });
        return;
      }
      const c = found;
      const formatted = {
        id: c.id,
        notion_page_id: c.notionPageId ?? null,
        data: { Name: c.name, Email: c.email ?? c.billingEmail, Phone: c.phone, ...c.data },
        created_at: new Date(c.createdAt).toISOString(),
        updated_at: new Date(c.updatedAt).toISOString(),
      };
      respond(true, { client: formatted, businessId: c.agencyId, source: "database" });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.update": async ({ params, respond }) => {
    try {
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const id = typeof params?.id === "string" ? params.id : null;
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
        return;
      }
      const agencyStore = getAgencyOperationsStore(resolveStateDir());
      const existing = agencyStore.getClient(id, agencyId);
      if (!existing) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Client not found" });
        return;
      }
      const dataUpdate =
        params?.data && typeof params.data === "object" ? (params.data as Record<string, any>) : {};
      const merged = { ...existing.data, ...dataUpdate };
      const client = agencyStore.updateClient(
        id,
        {
          name: dataUpdate.Name ?? dataUpdate.name ?? undefined,
          email: dataUpdate.Email ?? dataUpdate.email ?? undefined,
          phone: dataUpdate.Phone ?? dataUpdate.phone ?? undefined,
          notes: dataUpdate.Notes ?? dataUpdate.notes ?? undefined,
          data: merged,
        },
        { agencyId },
      );
      const formatted = {
        id: client.id,
        notion_page_id: client.notionPageId ?? null,
        data: { Name: client.name, Email: client.email, Phone: client.phone, ...client.data },
        created_at: new Date(client.createdAt).toISOString(),
        updated_at: new Date(client.updatedAt).toISOString(),
      };
      respond(true, { client: formatted, businessId: agencyId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.delete": async ({ params, respond }) => {
    try {
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const id = typeof params?.id === "string" ? params.id : null;
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
        return;
      }
      const agencyStore = getAgencyOperationsStore(resolveStateDir());
      agencyStore.deleteClient(id, { agencyId });
      try {
        const { purgeEntity } = await import("../../databases/relations-store.js");
        purgeEntity(resolveStateDir(), { type: "client", id });
      } catch {
        /* ignore */
      }
      respond(true, { deleted: true, id, businessId: agencyId, source: "database" });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Promote a funnel Lead to a Client record.
   *
   * Carry-over: name, email, phone, company, title, source, customFields.
   * Sets `source_lead_id` on the new client and writes back the new
   * `clientId` onto the lead's customFields so both sides know the link.
   *
   * Idempotent: if the lead already has a `clientId` on its customFields
   * pointing at an existing client, returns that client instead of
   * creating a duplicate.
   *
   * Out-of-scope (deferred): pushing the new client into Notion. The
   * existing notion sync path picks it up on the next cycle.
   */
  "business.clients.fromLead": async ({ params, respond }) => {
    const leadId = typeof params?.leadId === "string" ? params.leadId : "";
    if (!leadId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "leadId required" });
      return;
    }
    try {
      const { getFunnelStore } = await import("../../funnels/store.js");
      const funnelStore = getFunnelStore();
      const lead = funnelStore.getLead(leadId);
      if (!lead) {
        respond(false, undefined, { code: "NOT_FOUND", message: `lead ${leadId} not found` });
        return;
      }
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const agencyStore = getAgencyOperationsStore(resolveStateDir());

      // Idempotency: check if the lead was already promoted
      const existingClientId = (lead.customFields as Record<string, unknown> | undefined)?.clientId;
      if (typeof existingClientId === "string") {
        const existing = agencyStore.getClient(existingClientId, agencyId);
        if (existing) {
          const f = existing;
          respond(true, {
            client: {
              id: f.id,
              data: { Name: f.name, ...f.data },
              created_at: new Date(f.createdAt).toISOString(),
              updated_at: new Date(f.updatedAt).toISOString(),
            },
            leadId,
            alreadyLinked: true,
            businessId: agencyId,
          });
          return;
        }
      }

      const data: Record<string, any> = {};
      if (lead.name) data["Name"] = lead.name;
      if (lead.email) data["Email"] = lead.email;
      if (lead.phone) data["Phone"] = lead.phone;
      if (lead.company) data["Company"] = lead.company;
      if (lead.title) data["Title"] = lead.title;
      if (lead.source) data["Source"] = lead.source;
      if (lead.customFields && typeof lead.customFields === "object") {
        for (const [k, v] of Object.entries(lead.customFields as Record<string, unknown>)) {
          if (k === "clientId" || k === "rawPayload") continue;
          if (data[k] === undefined) data[k] = v;
        }
      }

      const client = agencyStore.createClient(
        { name: lead.name || lead.email || leadId, email: lead.email, phone: lead.phone, data },
        { agencyId },
      );

      try {
        funnelStore.updateLead(leadId, {
          customFields: {
            ...((lead.customFields as Record<string, unknown>) ?? {}),
            clientId: client.id,
          },
        });
      } catch {
        /* non-fatal */
      }

      respond(true, {
        client: {
          id: client.id,
          data,
          created_at: new Date(client.createdAt).toISOString(),
          updated_at: new Date(client.updatedAt).toISOString(),
        },
        leadId,
        alreadyLinked: false,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.linkedToLead": async ({ params, respond }) => {
    const leadId = typeof params?.leadId === "string" ? params.leadId : "";
    if (!leadId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "leadId required" });
      return;
    }
    try {
      const { getFunnelStore } = await import("../../funnels/store.js");
      const lead = getFunnelStore().getLead(leadId);
      const clientId = (lead?.customFields as Record<string, unknown> | undefined)?.clientId;
      if (typeof clientId !== "string") {
        respond(true, { client: null, businessId: null });
        return;
      }
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const c = getAgencyOperationsStore(resolveStateDir()).getClient(clientId, agencyId);
      respond(true, {
        client: c
          ? {
              id: c.id,
              data: { Name: c.name, ...c.data },
              created_at: new Date(c.createdAt).toISOString(),
              updated_at: new Date(c.updatedAt).toISOString(),
            }
          : null,
        businessId: c ? agencyId : null,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.sourceLead": async ({ params, respond }) => {
    const clientId = typeof params?.clientId === "string" ? params.clientId : "";
    if (!clientId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "clientId required" });
      return;
    }
    try {
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const c = getAgencyOperationsStore(resolveStateDir()).getClient(clientId, agencyId);
      // source_lead_id is stored in data blob
      const sourceLeadId =
        typeof c?.data?.source_lead_id === "string" ? c.data.source_lead_id : null;
      if (!sourceLeadId) {
        respond(true, { lead: null });
        return;
      }
      const { getFunnelStore } = await import("../../funnels/store.js");
      respond(true, { lead: getFunnelStore().getLead(sourceLeadId) ?? null });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Client Notion CRM Sync — delegate to canonical clients.notion.* ────────

  "business.clients.notion.schema": async ({ params, respond }) => {
    try {
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const config = getAgencyOperationsStore(resolveStateDir()).getClientsNotionConfig(agencyId);
      respond(true, {
        schema: config?.schemaJson ? JSON.parse(config.schemaJson) : null,
        businessId: agencyId,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Create a Notion CRM database and bind it to the requested business. */
  "business.clients.notion.create": async (opts) => {
    try {
      const { params, respond } = opts;
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const { clientsHandlers } = await import("./clients.js");
      await clientsHandlers["clients.notion.create"]({ ...opts, params: { ...params, agencyId } });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.notion.connect": async (opts) => {
    try {
      const { params, respond } = opts;
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const { clientsHandlers } = await import("./clients.js");
      await clientsHandlers["clients.notion.connect"]({ ...opts, params: { ...params, agencyId } });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.notion.disconnect": async (opts) => {
    try {
      const { params, respond } = opts;
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const { clientsHandlers } = await import("./clients.js");
      await clientsHandlers["clients.notion.disconnect"]({
        ...opts,
        params: { ...params, agencyId },
      });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.notion.sync": async (opts) => {
    try {
      const { params, respond } = opts;
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const { clientsHandlers } = await import("./clients.js");
      await clientsHandlers["clients.notion.sync"]({ ...opts, params: { ...params, agencyId } });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.notion.import": async (opts) => {
    try {
      const { params, respond } = opts;
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const { clientsHandlers } = await import("./clients.js");
      await clientsHandlers["clients.notion.import"]({ ...opts, params: { ...params, agencyId } });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.notion.status": async ({ params, respond }) => {
    try {
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const config = getAgencyOperationsStore(resolveStateDir()).getClientsNotionConfig(agencyId);
      respond(true, {
        connected: !!config?.notionDbId,
        databaseId: config?.notionDbId ?? null,
        databaseName: config?.notionDbName ?? null,
        lastSync: config?.lastSync ?? null,
        notionConfigured: true,
        businessId: agencyId,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "business.clients.import": async (opts) => {
    try {
      const { params, respond } = opts;
      const agencyId =
        (typeof params?.businessId === "string" && params.businessId) ||
        (typeof params?.agencyId === "string" && params.agencyId) ||
        "default";
      const { clientsHandlers } = await import("./clients.js");
      await clientsHandlers["clients.import"]({ ...opts, params: { ...params, agencyId } });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

// In satellite mode, proxy all business.* calls to master (business data is master-owned).
export const businessHandlers: GatewayRequestHandlers = applySatelliteProxy(_rawBusinessHandlers);
