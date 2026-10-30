/**
 * Periodic Notion → local pull, paired with the existing local → Notion
 * push that lives in `kanban-store-ops.ts` and `tasks/notion-sync.ts`.
 *
 * Driven by the `bindings` registry in `notion-config.ts` — each binding
 * carries a role (projects, tasks, …, custom), a field map, and a per-DB
 * `conflictPolicy`. The poller iterates every binding and routes each
 * page through the role-specific applier or the conflict queue if the
 * remote and local sides both edited the row since the last sync.
 *
 * Conflict policy:
 *   - "last-write-wins" (legacy): take whichever side has the newer
 *     timestamp; a clock-skew tolerance avoids fighting tiny drift.
 *   - "queue" (default for new bindings): when both sides edited the row
 *     since `binding.lastSyncedAt`, write a record to `notion-conflicts`
 *     and let the operator pick the winner via the conflict UI.
 *
 * Scope of this module:
 *   - Polls every binding whose role the kanban store understands
 *     (projects, tasks). Other roles (CRM, custom) are scanned so the
 *     cursor advances and conflicts can still queue, but row writes are
 *     deferred to whichever store eventually owns them.
 *   - Skips poll entirely when Notion isn't configured or syncMode === "off".
 *   - Idempotent: a no-op when no Notion edits exist since lastSyncAt.
 *   - Fail-open: any Notion error logs and reschedules; never crashes the
 *     gateway loop.
 *
 * Out of scope (intentionally):
 *   - Page bodies / blocks — only properties round-trip; agents can re-emit
 *     blocks if they need richer content sync.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getAllBindings,
  getBinding,
  getNotionApiKeyOrNull,
  getNotionConfig,
  upsertBinding,
  type NotionBinding,
} from "./notion-config.js";
import { enqueueConflict, type ConflictField } from "./notion-conflicts.js";
import {
  blocksToMarkdown,
  collectFileUrlsFromBlocks,
  fetchPageBlocksDeep,
} from "./notion-import.js";
import {
  collectFileUrlsFromProps,
  collectImagePropNames,
  extractPlainText,
  smartPickCategory,
  smartPickDescription,
  smartPickDueDate,
  smartPickExternalUrl,
  smartPickInventory,
  smartPickNumber,
  smartPickPriority,
  smartPickSku,
  smartPickStatus,
  smartPickTags,
  smartPickType,
  smartPickVendor,
} from "./notion-property-pickers.js";

const log = createSubsystemLogger("notion-bidir");

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const DEFAULT_POLL_MS = 60_000;
const CLOCK_SKEW_TOLERANCE_MS = 2_000;

interface PollState {
  /** Last-edited cursor for each db: any page edited after this is considered new. */
  lastSyncByDb: Map<string, number>;
}

const pollState: PollState = {
  lastSyncByDb: new Map(),
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

// ─────────────────────────────────────────────────────────────────────────
// Per-DB pull health: exponential backoff with jitter + a circuit breaker.
// A failing DB is skipped until `nextAttemptAt`; after PULL_CIRCUIT_THRESHOLD
// consecutive failures the breaker is "open" (still probed once per backoff
// window — half-open — so recovery is automatic). We log once per state
// change, never once per failed poll. The cursor (binding.lastSyncedAt) only
// advances on success, so the first good pull after an outage catches up on
// everything edited meanwhile.
// ─────────────────────────────────────────────────────────────────────────

export const PULL_BACKOFF_BASE_MS = 60_000;
export const PULL_BACKOFF_MAX_MS = 30 * 60_000;
export const PULL_CIRCUIT_THRESHOLD = 3;
const PULL_JITTER = 0.2;

export interface PullHealth {
  dbId: string;
  role: string;
  state: "ok" | "failing" | "open";
  failures: number;
  nextAttemptAt: number;
  lastError: string | null;
  lastFailureAt: number | null;
  lastOkAt: number | null;
  /** Pages pulled by the first successful poll after an outage. */
  lastCatchUpPages: number | null;
}

const pullHealth = new Map<string, PullHealth>();
let pullRandom: () => number = Math.random;
let pullNow: () => number = () => Date.now();

function healthFor(binding: NotionBinding): PullHealth {
  let h = pullHealth.get(binding.notionDbId);
  if (!h) {
    h = {
      dbId: binding.notionDbId,
      role: binding.role,
      state: "ok",
      failures: 0,
      nextAttemptAt: 0,
      lastError: null,
      lastFailureAt: null,
      lastOkAt: null,
      lastCatchUpPages: null,
    };
    pullHealth.set(binding.notionDbId, h);
  }
  return h;
}

/** Backoff for the Nth consecutive failure (1-based), with ±20% jitter. */
export function pullBackoffMs(failures: number): number {
  const raw = Math.min(PULL_BACKOFF_MAX_MS, PULL_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(raw * (1 - PULL_JITTER + pullRandom() * 2 * PULL_JITTER));
}

/** Should this DB be pulled now? Forced pulls ignore the backoff window. */
function pullAllowed(binding: NotionBinding, force: boolean): boolean {
  if (force) return true;
  const h = pullHealth.get(binding.notionDbId);
  return !h || h.failures === 0 || pullNow() >= h.nextAttemptAt;
}

function recordPullFailure(binding: NotionBinding, err: unknown): void {
  const h = healthFor(binding);
  const message = String(err);
  const prevState = h.state;
  h.failures += 1;
  h.lastError = message.slice(0, 300);
  h.lastFailureAt = pullNow();
  const delay = pullBackoffMs(h.failures);
  h.nextAttemptAt = pullNow() + delay;
  h.state = h.failures >= PULL_CIRCUIT_THRESHOLD ? "open" : "failing";
  if (prevState === "ok") {
    log.warn("pull failing; backing off", {
      dbId: binding.notionDbId,
      role: binding.role,
      err: h.lastError,
      retryInMs: delay,
    });
  } else if (prevState === "failing" && h.state === "open") {
    log.warn("pull circuit open; probing once per backoff window", {
      dbId: binding.notionDbId,
      role: binding.role,
      failures: h.failures,
      retryInMs: delay,
    });
  }
}

function recordPullSuccess(binding: NotionBinding, pages: number): void {
  const h = healthFor(binding);
  if (h.state !== "ok") {
    h.lastCatchUpPages = pages;
    log.info("pull recovered; caught up", {
      dbId: binding.notionDbId,
      role: binding.role,
      failuresWhileDown: h.failures,
      pagesCaughtUp: pages,
    });
  }
  h.state = "ok";
  h.failures = 0;
  h.nextAttemptAt = 0;
  h.lastOkAt = pullNow();
}

/** Snapshot of every DB's pull health (UI chip + diagnostics). */
export function getNotionPullHealth(): PullHealth[] {
  return [...pullHealth.values()].map((h) => ({ ...h }));
}

/** Test hook. */
export function resetNotionPullStateForTests(
  opts: { random?: () => number; now?: () => number } = {},
): void {
  pullHealth.clear();
  pollState.lastSyncByDb.clear();
  appliedEdits.clear();
  pullRandom = opts.random ?? Math.random;
  pullNow = opts.now ?? (() => Date.now());
  pollChain = Promise.resolve();
}

/**
 * Pages already applied in this process, keyed by page id → last_edited_time.
 * The cursor filter is `on_or_after` (Notion timestamps are minute-granular,
 * so a strict `after` would drop same-minute edits), which means every poll
 * re-returns the newest minute's pages; this memo skips re-applying them.
 */
const appliedEdits = new Map<string, string>();
const APPLIED_EDITS_MAX = 20_000;
const applyErrorsLogged = new Set<string>();

function alreadyApplied(page: NotionPage): boolean {
  return appliedEdits.get(page.id) === page.last_edited_time;
}

function markApplied(page: NotionPage): void {
  if (appliedEdits.size >= APPLIED_EDITS_MAX) appliedEdits.clear();
  appliedEdits.set(page.id, page.last_edited_time);
}

/** Polls never overlap (timer tick vs forced RPC pull) — overlap is how two
 *  passes could both miss a page and both create it. */
let pollChain: Promise<unknown> = Promise.resolve();

interface NotionPage {
  id: string;
  last_edited_time: string;
  archived?: boolean;
  /** Newer Notion API versions flag trashed pages here (archived may be false). */
  in_trash?: boolean;
  properties?: Record<string, unknown>;
  /** Page cover — Notion's gallery view uses this as the card image. */
  cover?: {
    type?: "external" | "file";
    external?: { url?: string };
    file?: { url?: string; expiry_time?: string };
  } | null;
  /** Page icon — emoji or image. Only image variants are usable as thumbnails. */
  icon?: {
    type?: "emoji" | "external" | "file";
    emoji?: string;
    external?: { url?: string };
    file?: { url?: string; expiry_time?: string };
  } | null;
  url?: string;
}

async function notionFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Notion ${res.status}: ${(body as { message?: string }).message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

/**
 * Page through a database, returning only pages edited after `since`.
 * Notion's filter uses `timestamp: "last_edited_time"` for this — much
 * cheaper than fetching everything and filtering client-side.
 */
async function fetchRecentlyEdited(
  apiKey: string,
  dbId: string,
  sinceMs: number,
): Promise<NotionPage[]> {
  const sinceIso = new Date(sinceMs).toISOString();
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = {
      page_size: 100,
      filter: {
        timestamp: "last_edited_time",
        last_edited_time: { on_or_after: sinceIso },
      },
      sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
    };
    if (cursor) body.start_cursor = cursor;
    const res = (await notionFetch(apiKey, `/databases/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    })) as { results?: NotionPage[]; has_more?: boolean; next_cursor?: string };
    if (Array.isArray(res.results)) pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

/**
 * Has the local row drifted enough behind the Notion edit that we should
 * just take the Notion version? True when no local row exists, or when
 * Notion is the only side that edited since the last sync.
 */
function shouldPullOver(localUpdatedAt: number | null, notionLastEditedMs: number): boolean {
  if (localUpdatedAt === null) return true;
  return notionLastEditedMs - localUpdatedAt > CLOCK_SKEW_TOLERANCE_MS;
}

/**
 * Detect a true conflict: both sides edited the row since the last
 * sync cursor. Returns true only when neither side is clearly newer
 * (timestamps within the skew window) AND both touched the row after
 * the binding's lastSyncedAt. Coarse-grained — the field-level diff is
 * computed only when this returns true.
 */
function isConcurrentEdit(
  localUpdatedAt: number | null,
  notionLastEditedMs: number,
  bindingLastSyncMs: number,
): boolean {
  if (localUpdatedAt === null) return false;
  if (localUpdatedAt <= bindingLastSyncMs) return false;
  if (notionLastEditedMs <= bindingLastSyncMs) return false;
  return Math.abs(notionLastEditedMs - localUpdatedAt) <= 30_000;
}

/**
 * Decide which side to take when not queueing. Returns "remote" when
 * Notion's edit beats the local one by more than the skew tolerance,
 * otherwise "local" so we leave the local row alone.
 */
function lastWriteWins(
  localUpdatedAt: number | null,
  notionLastEditedMs: number,
): "remote" | "local" {
  if (localUpdatedAt === null) return "remote";
  return notionLastEditedMs - localUpdatedAt > CLOCK_SKEW_TOLERANCE_MS ? "remote" : "local";
}

// ─────────────────────────────────────────────────────────────────────────
// Binding-aware property pickers. The first name tried is whatever the
// binding's fieldMap says; we fall back to the historical aliases so a
// pre-bindings install (whose synthesized binding has identity mappings)
// still hits real Notion property names from imported DBs.
// ─────────────────────────────────────────────────────────────────────────

function pickFromMap(
  binding: NotionBinding | null,
  canonical: string,
  fallbackAliases: readonly string[],
): string[] {
  const mapped = binding?.fieldMap?.[canonical];
  if (mapped && !fallbackAliases.includes(mapped)) return [mapped, ...fallbackAliases];
  return [...fallbackAliases];
}

function pickTitle(props: Record<string, any>, names: string[]): string {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "title" && Array.isArray(p.title)) {
      const text = p.title
        .map((t: { plain_text?: string }) => t?.plain_text ?? "")
        .join("")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

function pickRichText(props: Record<string, any>, names: string[]): string {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "rich_text" && Array.isArray(p.rich_text)) {
      return p.rich_text.map((t: { plain_text?: string }) => t?.plain_text ?? "").join("");
    }
  }
  return "";
}

function pickStatus(props: Record<string, any>, names: string[]): string | undefined {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "status") return p.status?.name;
    if (p?.type === "select") return p.select?.name;
  }
  return undefined;
}

function pickSelect(props: Record<string, any>, names: string[]): string | undefined {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "select") return p.select?.name;
  }
  return undefined;
}

function pickCheckbox(props: Record<string, any>, names: string[]): boolean | undefined {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "checkbox") return Boolean(p.checkbox);
  }
  return undefined;
}

function pickDate(props: Record<string, any>, names: string[]): string | undefined {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "date") return p.date?.start ?? undefined;
  }
  return undefined;
}

function pickNumber(props: Record<string, any>, names: string[]): number | undefined {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "number" && typeof p.number === "number") return p.number;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Smart pickers have moved to notion-property-pickers.ts — imported at
// the top of this file. Local single-purpose helpers (e.g. pickFileUrl
// for a specific file-prop-name list) stay here.
// ─────────────────────────────────────────────────────────────────────────

/**
 * First file URL from a Notion "files & media" property. Returns the
 * external URL if present, else the (signed, expiring) file.url. Notion
 * file URLs expire ~1 hour after the API call; for stable thumbnails
 * prefer external URLs or page covers.
 */
function pickFileUrl(props: Record<string, any>, names: string[]): string | undefined {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "files" && Array.isArray(p.files) && p.files.length > 0) {
      const f = p.files[0];
      const url = f?.external?.url ?? f?.file?.url;
      if (typeof url === "string" && url) return url;
    }
    if (p?.type === "url" && typeof p.url === "string" && p.url) return p.url;
  }
  return undefined;
}

/**
 * Notion's gallery view picks a card image from (in this order):
 *   1. a "Files & media" property the user picked as "Card preview"
 *   2. the page cover image
 *   3. the page content (first image block — we don't fetch blocks)
 * We mirror 1 & 2 here. Caller passes candidate property names to try
 * first; falls through to page.cover, then to a file/external icon.
 */
function pageImageUrl(page: NotionPage, fileProps: string[]): string | undefined {
  const props = (page.properties ?? {}) as Record<string, any>;
  const fromProp = pickFileUrl(props, fileProps);
  if (fromProp) return fromProp;
  const cover = page.cover;
  if (cover) {
    const url = cover.external?.url ?? cover.file?.url;
    if (typeof url === "string" && url) return url;
  }
  const icon = page.icon;
  if (icon && (icon.type === "external" || icon.type === "file")) {
    const url = icon.external?.url ?? icon.file?.url;
    if (typeof url === "string" && url) return url;
  }
  return undefined;
}

/** Multi-select option names — for tags. */
function pickMultiSelectNames(props: Record<string, any>, names: string[]): string[] {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "multi_select" && Array.isArray(p.multi_select)) {
      return p.multi_select
        .map((o: any) => (typeof o?.name === "string" ? o.name : null))
        .filter((s: string | null): s is string => Boolean(s));
    }
  }
  return [];
}

/**
 * First Notion relation page id from the named property. Used to resolve
 * Tasks → Projects so the local row can be created with a real projectId.
 */
function pickRelationFirstId(props: Record<string, any>, names: string[]): string | null {
  for (const n of names) {
    const p = props[n];
    if (p?.type === "relation" && Array.isArray(p.relation) && p.relation.length > 0) {
      const id = p.relation[0]?.id;
      if (typeof id === "string" && id) return id;
    }
  }
  return null;
}

/**
 * Build a coarse-grained list of fields that differ between local and
 * remote, used when a conflict is detected. We only include fields that
 * canonically map to the role — the operator doesn't care about hidden
 * Notion-only props, and resolving them isn't meaningful in this UI.
 */
function diffFields(
  binding: NotionBinding,
  remotePage: NotionPage,
  localRow: Record<string, any> | null,
  canonicalKeys: readonly {
    canonical: string;
    localKey: string;
    type: string;
    aliases: readonly string[];
  }[],
): ConflictField[] {
  const props = (remotePage.properties ?? {}) as Record<string, any>;
  const out: ConflictField[] = [];
  for (const def of canonicalKeys) {
    const names = pickFromMap(binding, def.canonical, def.aliases);
    let remote: unknown;
    switch (def.type) {
      case "title":
        remote = pickTitle(props, names);
        break;
      case "rich_text":
        remote = pickRichText(props, names);
        break;
      case "status":
        remote = pickStatus(props, names);
        break;
      case "select":
        remote = pickSelect(props, names);
        break;
      case "date":
        remote = pickDate(props, names);
        break;
      case "checkbox":
        remote = pickCheckbox(props, names);
        break;
      default:
        remote = undefined;
    }
    const local = localRow?.[def.localKey];
    // Normalize falsy/empty values so "" vs undefined doesn't fire as a conflict.
    const normRemote = remote === "" ? null : (remote ?? null);
    const normLocal = local === "" ? null : (local ?? null);
    if (normRemote === normLocal) continue;
    out.push({
      field: def.canonical,
      notionProperty: names[0] ?? def.canonical,
      local: {
        value: normLocal,
        type: def.type,
        updatedAt: new Date(localRow?.updatedAt ?? 0).toISOString(),
      },
      remote: { value: normRemote, type: def.type, updatedAt: remotePage.last_edited_time },
    });
  }
  return out;
}

const PROJECT_FIELD_DEFS = [
  { canonical: "Project", localKey: "name", type: "title", aliases: ["Project", "Name", "Title"] },
  {
    canonical: "Description",
    localKey: "description",
    type: "rich_text",
    aliases: ["Description", "Notes"],
  },
  { canonical: "Status", localKey: "status", type: "status", aliases: ["Status"] },
  { canonical: "Priority", localKey: "priority", type: "select", aliases: ["Priority"] },
  { canonical: "Due Date", localKey: "dueDate", type: "date", aliases: ["Due Date", "Due"] },
  {
    canonical: "Active Client Project",
    localKey: "active",
    type: "checkbox",
    aliases: ["Active Client Project", "Active"],
  },
] as const;

const TASK_FIELD_DEFS = [
  {
    canonical: "Task Name",
    localKey: "title",
    type: "title",
    aliases: ["Task Name", "Name", "Title"],
  },
  {
    canonical: "Description",
    localKey: "description",
    type: "rich_text",
    aliases: ["Description", "Notes"],
  },
  {
    canonical: "Status Update",
    localKey: "status",
    type: "status",
    aliases: ["Status Update", "Status"],
  },
  {
    canonical: "Priority Level",
    localKey: "priority",
    type: "select",
    aliases: ["Priority Level", "Priority"],
  },
  { canonical: "Due Date", localKey: "dueDate", type: "date", aliases: ["Due Date", "Due"] },
  { canonical: "Done", localKey: "done", type: "checkbox", aliases: ["Done"] },
] as const;

/**
 * Run one Notion → local pass over every binding. Mutates the local
 * kanban store via lazy import to dodge the cycle that exists between
 * kanban-store-ops.ts and notion-config.ts.
 */
async function runPollOnce(opts: { force?: boolean } = {}): Promise<{
  projects: number;
  tasks: number;
  conflicts: number;
  products: number;
  productsDebug: Array<{
    dbId: string;
    businessId: string | null;
    pages: number;
    added: number;
    skippedReason?: string;
  }>;
  skipped: boolean;
}> {
  const cfg = getNotionConfig();
  // syncMode gates the periodic background poller, but a forced pull
  // (e.g. the import-wizard's "commit → immediate backfill" path) needs
  // to run even when background sync is off — otherwise the operator
  // sees "✓ imported" but no rows land.
  if (!opts.force && cfg.syncMode === "off")
    return { projects: 0, tasks: 0, conflicts: 0, products: 0, productsDebug: [], skipped: true };
  // Forced pulls fall back to the import-style key getter so a key
  // configured-but-not-sync-enabled still works.
  const apiKey = opts.force ? (cfg.apiKey ?? null) : getNotionApiKeyOrNull();
  if (!apiKey)
    return { projects: 0, tasks: 0, conflicts: 0, products: 0, productsDebug: [], skipped: true };

  const bindings = getAllBindings();
  if (bindings.length === 0)
    return { projects: 0, tasks: 0, conflicts: 0, products: 0, productsDebug: [], skipped: true };

  // Lazy import — keeps this module loadable from contexts that don't have
  // SQLite available (e.g. CLI helpers that just want config helpers).
  const { getKanbanStore } = await import("../tasks/store.js");
  // Same resolution as every other kanban.db reader (the old `?? "state"`
  // fallback wrote to a cwd-relative dir when the env var was unset).
  const store = getKanbanStore(process.env.INFINIBOT_STATE_DIR || undefined);

  let projectCount = 0;
  let taskCount = 0;
  let conflictCount = 0;
  let productCount = 0;
  const productsDebug: Array<{
    dbId: string;
    businessId: string | null;
    pages: number;
    added: number;
    skippedReason?: string;
  }> = [];

  for (const binding of bindings) {
    // Products applier — writes rows into the per-business products
    // database via the system-role bridge. Requires binding.businessId
    // (set by the import wizard when launched from the Products page).
    // Without a businessId we have nowhere to write, so skip + log; the
    // operator should re-import from the per-business Products page.
    if (binding.role === "products") {
      const bizId = binding.businessId ?? null;
      if (!bizId) {
        log.warn("products binding has no businessId; skipping pull", {
          dbId: binding.notionDbId,
        });
        productsDebug.push({
          dbId: binding.notionDbId,
          businessId: null,
          pages: 0,
          added: 0,
          skippedReason:
            "binding has no businessId — re-import from the per-business Products page",
        });
        continue;
      }
      const dbId = binding.notionDbId;
      // On a forced pull (import-wizard initial backfill), reset the
      // cursor to 0 so we pull EVERY page in the Notion DB — the periodic
      // poller's cursor is for incremental sync, not the first import.
      const cursorMs = opts.force
        ? 0
        : (pollState.lastSyncByDb.get(dbId) ?? binding.lastSyncedAt ?? 0);
      if (!pullAllowed(binding, !!opts.force)) {
        productsDebug.push({
          dbId,
          businessId: bizId,
          pages: 0,
          added: 0,
          skippedReason: "backing off after fetch failures",
        });
        continue;
      }
      let pages: NotionPage[];
      try {
        pages = await fetchRecentlyEdited(apiKey, dbId, cursorMs);
        recordPullSuccess(binding, pages.length);
      } catch (err) {
        recordPullFailure(binding, err);
        productsDebug.push({
          dbId,
          businessId: bizId,
          pages: 0,
          added: 0,
          skippedReason: `fetch failed: ${String(err)}`,
        });
        continue;
      }
      // Lazy-load the bridge so this module stays SQLite-optional for
      // contexts that just want config helpers (CLI, tests, etc).
      const { upsertRowForBusinessRole, ensureBusinessRoleDatabase } =
        await import("./system-role-bridge.js");
      ensureBusinessRoleDatabase(bizId, "products", "Products");
      let added = 0;
      for (const page of pages) {
        if (page.archived || page.in_trash) continue;
        if (!opts.force && alreadyApplied(page)) continue;
        const props = (page.properties ?? {}) as Record<string, any>;
        const name = pickTitle(props, pickFromMap(binding, "Name", ["Name", "Title", "Product"]));
        if (!name) continue;
        // Smart pickers — name AND type fuzzy, so a Notion DB that uses
        // "Product Description" / "Price (1)" / "Status" as multi_select
        // doesn't drop every attribute. Binding fieldMap still takes
        // priority when explicitly set; otherwise falls back to fuzzy.
        const description =
          (binding.fieldMap?.Description &&
            extractPlainText(props[binding.fieldMap.Description])) ||
          smartPickDescription(props);
        const values: Record<string, import("./types.js").PropertyValue> = {};
        const sku = smartPickSku(props);
        const type = smartPickType(props);
        const status = smartPickStatus(props);
        const price = smartPickNumber(props, ["price", "msrp", "list price"]);
        const cost = smartPickNumber(props, ["cost", "wholesale"]);
        const inventory = smartPickInventory(props);
        const category = smartPickCategory(props);
        const vendor = smartPickVendor(props);
        const tags = smartPickTags(props);
        const externalUrl = smartPickExternalUrl(props);
        // Thumbnail: any "files & media" or URL prop with image-y names,
        // then the page cover, then an image-type icon. Matches what
        // Notion's gallery view shows on each card.
        const image = pageImageUrl(page, collectImagePropNames(props, binding.fieldMap?.Image));
        if (sku) values.SKU = { type: "richText", markdown: sku };
        if (type) values.Type = { type: "select", optionId: type };
        if (status) values.Status = { type: "select", optionId: status };
        if (typeof price === "number") values.Price = { type: "number", value: price };
        if (typeof cost === "number") values.Cost = { type: "number", value: cost };
        if (typeof inventory === "number") values.Inventory = { type: "number", value: inventory };
        if (category) values.Category = { type: "select", optionId: category };
        if (vendor) values.Vendor = { type: "richText", markdown: vendor };
        if (tags.length > 0) values.Tags = { type: "multiSelect", optionIds: tags };
        if (image) values.Image = { type: "url", url: image };
        if (externalUrl) values["External URL"] = { type: "url", url: externalUrl };

        // Pull page body content + sub-pages → markdown, and collect every
        // file URL the page references (block-level images/files plus any
        // files-property attachments) into a Gallery property. Best-effort:
        // a single page's content fetch failing shouldn't kill the import,
        // we just fall back to the description property as the body.
        let body: string | null = description || null;
        const galleryUrls: string[] = [];
        try {
          const blocks = await fetchPageBlocksDeep(page.id, apiKey, {
            maxDepth: 2,
            maxBlocksPerPage: 200,
          });
          const md = blocksToMarkdown(blocks);
          if (md && md.trim().length > 0) {
            body = description ? `${description}\n\n${md}` : md;
          }
          galleryUrls.push(...collectFileUrlsFromBlocks(blocks));
        } catch (err) {
          log.warn("products page body fetch failed", {
            pageId: page.id,
            err: String(err),
          });
        }
        // Pull URLs from every files-typed property too so attachments
        // live alongside block-embedded media in the gallery.
        galleryUrls.push(...collectFileUrlsFromProps(props));
        const uniqueGallery = Array.from(new Set(galleryUrls));
        if (uniqueGallery.length > 0) {
          values.Gallery = { type: "multiSelect", optionIds: uniqueGallery };
        }

        upsertRowForBusinessRole("products", bizId, {
          id: page.id,
          title: name,
          body,
          values,
          externalRef: {
            system: "notion",
            externalId: page.id,
            lastSyncedAt: Date.now(),
          },
        });
        markApplied(page);
        added++;
      }
      const newest = pages.reduce(
        (max, p) => Math.max(max, Date.parse(p.last_edited_time) || 0),
        cursorMs,
      );
      if (newest > cursorMs) {
        pollState.lastSyncByDb.set(dbId, newest);
        try {
          await upsertBinding({ ...binding, lastSyncedAt: newest });
        } catch (err) {
          log.warn("products binding cursor persist failed", { dbId, err: String(err) });
        }
      }
      log.info("products pull", { dbId, businessId: bizId, added, total: pages.length });
      productCount += added;
      productsDebug.push({ dbId, businessId: bizId, pages: pages.length, added });
      continue;
    }
    if (binding.role !== "projects" && binding.role !== "tasks") {
      // Other CRM / custom: cursor-only pass for now. Once each role's
      // applier exists, wire it here following the products pattern.
      continue;
    }
    const dbId = binding.notionDbId;
    if (!pullAllowed(binding, !!opts.force)) continue;
    const cursorMs = pollState.lastSyncByDb.get(dbId) ?? binding.lastSyncedAt ?? 0;
    let pages: NotionPage[];
    try {
      pages = await fetchRecentlyEdited(apiKey, dbId, cursorMs);
      recordPullSuccess(binding, pages.length);
    } catch (err) {
      recordPullFailure(binding, err);
      continue;
    }

    const tableName: "projects" | "tasks" = binding.role;

    for (const page of pages) {
      const lastEditedMs = Date.parse(page.last_edited_time);
      if (Number.isNaN(lastEditedMs)) continue;
      if (alreadyApplied(page)) continue;

      const existing = findLocalByNotionId(store, tableName, page.id);
      const localUpdatedAt = existing?.updatedAt ?? null;

      // Concurrent-edit check first. When the binding's policy is
      // "queue", a true conflict short-circuits the write and lands in
      // the conflict UI for the operator.
      if (
        existing &&
        binding.conflictPolicy === "queue" &&
        isConcurrentEdit(localUpdatedAt, lastEditedMs, binding.lastSyncedAt ?? 0)
      ) {
        const fieldDefs =
          binding.role === "projects"
            ? (PROJECT_FIELD_DEFS as unknown as typeof PROJECT_FIELD_DEFS)
            : (TASK_FIELD_DEFS as unknown as typeof TASK_FIELD_DEFS);
        const fields = diffFields(binding, page, existing, fieldDefs as never);
        if (fields.length > 0) {
          enqueueConflict({
            notionDbId: dbId,
            notionPageId: page.id,
            role: binding.role,
            title: existing?.name ?? existing?.title ?? "Untitled",
            fields,
          });
          conflictCount++;
          continue;
        }
      }

      const decision = lastWriteWins(localUpdatedAt, lastEditedMs);
      if (decision === "local") {
        // Local is authoritative or tied — nothing to pull.
        if (!shouldPullOver(localUpdatedAt, lastEditedMs)) continue;
      }

      try {
        if (binding.role === "projects") {
          await applyProjectFromNotion(store, page, binding);
          projectCount++;
        } else {
          await applyTaskFromNotion(store, page, binding);
          taskCount++;
        }
        markApplied(page);
      } catch (err) {
        // Once per page+error, not once per poll.
        const key = `${page.id}:${String(err).slice(0, 120)}`;
        if (!applyErrorsLogged.has(key)) {
          if (applyErrorsLogged.size > 5_000) applyErrorsLogged.clear();
          applyErrorsLogged.add(key);
          log.warn("apply failed", { dbId, pageId: page.id, role: binding.role, err: String(err) });
        }
      }
    }

    // Bump cursor + persist binding.lastSyncedAt so the next process boot
    // doesn't re-pull the same window.
    const newest = pages.reduce(
      (max, p) => Math.max(max, Date.parse(p.last_edited_time) || 0),
      cursorMs,
    );
    if (newest > cursorMs) {
      pollState.lastSyncByDb.set(dbId, newest);
      try {
        await upsertBinding({ ...binding, lastSyncedAt: newest });
      } catch (err) {
        // Non-fatal — in-memory cursor still advanced for this process.
        log.warn("binding cursor persist failed", { dbId, err: String(err) });
      }
    }
  }

  if (projectCount > 0 || taskCount > 0 || conflictCount > 0) {
    log.info("notion → local pull complete", {
      projects: projectCount,
      tasks: taskCount,
      conflicts: conflictCount,
    });
  }
  return {
    projects: projectCount,
    tasks: taskCount,
    conflicts: conflictCount,
    products: productCount,
    productsDebug,
    skipped: false,
  };
}

/**
 * The local row for a Notion page (any linking column, hyphenated or not).
 * This is the identity check that keeps pulls idempotent: the pre-fix code
 * looked only at `notionPageId`, which `createTask` never set (it ignored the
 * page id it was given), so every poll created another copy of the page.
 */
function findLocalByNotionId(store: any, table: "projects" | "tasks", pageId: string): any {
  if (typeof store.findByNotionId === "function") return store.findByNotionId(table, pageId);
  return store.getByNotionPageId ? store.getByNotionPageId(table, pageId) : null;
}

async function applyProjectFromNotion(
  store: any,
  page: NotionPage,
  binding: NotionBinding | null,
): Promise<void> {
  const props = (page.properties ?? {}) as Record<string, any>;
  // Title still uses the binding-mapped name first since "Project" is
  // the canonical Projects-DB title prop on legacy installs. Falls back
  // to common aliases.
  const name = pickTitle(props, pickFromMap(binding, "Project", ["Project", "Name", "Title"]));
  if (!name) return;
  // All other fields go through the smart fuzzy pickers — match by
  // substring + type-tolerance so a DB whose status is "Stage" or whose
  // due date is "Deadline" still imports correctly.
  const description = smartPickDescription(props) || undefined;
  const status = smartPickStatus(props);
  const priority = smartPickPriority(props);
  const dueDate = smartPickDueDate(props);

  const existing = findLocalByNotionId(store, "projects", page.id);
  if (existing) {
    if (page.archived || page.in_trash) {
      // Notion archived → local "Cancelled" so the kanban view reflects it.
      await store.updateProject(existing.id, { status: "Cancelled" as any, name, description });
      return;
    }
    await store.updateProject(existing.id, {
      name,
      description,
      status: status as any,
      priority: priority as any,
      dueDate,
      notionId: page.id,
    });
  } else if (!page.archived && !page.in_trash) {
    // Externally-created page — synthesize a local row with Notion's id as
    // the local id so future round-trips line up cleanly.
    await store.createProject({
      id: page.id,
      name,
      description,
      status: status as any,
      priority: priority as any,
      dueDate,
      notionId: page.id,
    });
    if (store.setNotionPageId) store.setNotionPageId("projects", page.id, page.id);
  }

  // Reconcile the local relations store with the Notion "Clients"
  // relation property. Best-effort — never blocks the row apply.
  try {
    const localProjectId = existing?.id ?? page.id;
    const { applyProjectClientsRelationFromNotion } = await import("./notion-relation-bridge.js");
    applyProjectClientsRelationFromNotion(localProjectId, props);
  } catch {
    /* relation bridge is best-effort */
  }
}

async function applyTaskFromNotion(
  store: any,
  page: NotionPage,
  binding: NotionBinding | null,
): Promise<void> {
  const props = (page.properties ?? {}) as Record<string, any>;
  const title = pickTitle(props, pickFromMap(binding, "Task Name", ["Task Name", "Name", "Title"]));
  if (!title) return;
  // Smart pickers — same robustness as products: status as multi_select,
  // priority as text or select, "Due Date"/"Deadline"/"Target" all match.
  const status = smartPickStatus(props);
  const done = pickCheckbox(props, pickFromMap(binding, "Done", ["Done", "Completed"]));
  const priority = smartPickPriority(props);
  const description = smartPickDescription(props) || undefined;
  const dueDate = smartPickDueDate(props);
  const projectRelationId = pickRelationFirstId(
    props,
    pickFromMap(binding, "Project", ["Project", "Parent project"]),
  );

  // Resolve Tasks → Projects via the bindings registry. The relation gives
  // us a Notion page id; we look up the matching local project row by
  // notionPageId. When the related Projects DB hasn't been imported, we
  // fall back to the local default project so the task isn't orphaned —
  // the import wizard's relation step is what closes this gap properly.
  let projectId = "";
  if (projectRelationId) {
    const localProject = findLocalByNotionId(store, "projects", projectRelationId);
    if (localProject?.id) projectId = localProject.id;
  }
  if (!projectId) {
    // Pick the first project as a parent so the task lands somewhere
    // visible. Safer than "" which violates the kanban store's NOT NULL
    // projectId constraint and would crash store.createTask.
    try {
      const projects = store.getProjects ? await store.getProjects() : [];
      projectId = projects[0]?.id ?? "default";
    } catch {
      projectId = "default";
    }
  }

  // Map Notion's status names → InfiniBot's task status enum. Mirrors the
  // map in tasks/notion-sync.ts; duplicating here avoids a circular import.
  const NOTION_TO_LOCAL_STATUS: Record<string, string> = {
    "Not started": "todo",
    "In progress": "in_progress",
    "Awaiting Response": "review",
    Revisit: "review",
    Done: "done",
    Backlog: "backlog",
    "To Do": "todo",
    "In Progress": "in_progress",
    Review: "review",
  };
  const localStatus = (status && NOTION_TO_LOCAL_STATUS[status]) || (done ? "done" : "todo");

  const existing = findLocalByNotionId(store, "tasks", page.id);
  if (existing) {
    if (page.archived || page.in_trash) {
      // Notion archive → soft delete locally if the store supports it,
      // otherwise mark done so it falls off the active board.
      if (store.deleteTask) {
        await store.deleteTask(existing.id);
      } else {
        await store.updateTask(existing.id, { status: "done", done: true });
      }
      return;
    }
    await store.updateTask(existing.id, {
      title,
      description,
      status: localStatus,
      done: done ?? localStatus === "done",
      priority: priority?.toLowerCase(),
      dueDate,
      notionId: page.id,
      projectId,
    });
  } else if (!page.archived && !page.in_trash) {
    await store.createTask({
      id: page.id,
      title,
      description,
      status: localStatus,
      done: done ?? localStatus === "done",
      priority: priority?.toLowerCase(),
      dueDate,
      notionId: page.id,
      projectId,
    });
    if (store.setNotionPageId) store.setNotionPageId("tasks", page.id, page.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public lifecycle controls
// ─────────────────────────────────────────────────────────────────────────

/**
 * Start the periodic poller. Safe to call multiple times — second call is
 * a no-op. Disabled when env `INFINIBOT_DISABLE_NOTION_PULL=1`.
 */
/** Run one poll after any in-flight one finishes (never concurrently). */
function runPollSerialized(opts: { force?: boolean } = {}): ReturnType<typeof runPollOnce> {
  const next = pollChain.then(
    () => runPollOnce(opts),
    () => runPollOnce(opts),
  );
  pollChain = next.catch(() => undefined);
  return next;
}

export function startNotionBidirectionalSync(opts?: { intervalMs?: number }): void {
  if (pollTimer) return;
  void import("./kanban-store-ops.js")
    .then((m) => m.registerNotionPullHealth(() => getNotionPullHealth() as never))
    .catch(() => undefined);
  if (process.env.INFINIBOT_DISABLE_NOTION_PULL === "1") {
    log.info("notion bidirectional sync disabled via INFINIBOT_DISABLE_NOTION_PULL");
    return;
  }
  const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_MS;
  pollTimer = setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    runPollSerialized()
      .catch((err) => log.warn("poll cycle failed", { err: String(err) }))
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
  // Fire-and-forget initial pass so a freshly-edited Notion change shows up
  // within seconds of gateway start instead of after a full interval.
  setTimeout(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    runPollSerialized()
      .catch((err) => log.warn("initial poll failed", { err: String(err) }))
      .finally(() => {
        pollInFlight = false;
      });
  }, 5_000).unref?.();
  log.info("notion bidirectional sync started", { intervalMs });
}

export function stopNotionBidirectionalSync(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Force a one-shot poll outside the timer cadence. Used by gateway RPCs and
 * tests that don't want to wait for the next tick.
 */
export async function pollNotionNow(opts: { force?: boolean } = {}): Promise<{
  projects: number;
  tasks: number;
  conflicts: number;
  skipped: boolean;
}> {
  return runPollSerialized(opts);
}

// Quiet unused-import warnings if the binding helper imports change shape.
void getBinding;
