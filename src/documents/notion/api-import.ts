/**
 * Notion API → Documents importer.
 *
 * Read-only: only GET endpoints plus the read-only POST endpoints
 * (`/search`, `/databases/:id/query`) are used. Nothing is ever written to
 * Notion.
 *
 * Mapping:
 *   - A page without child pages/databases      → one doc.
 *   - A page with child pages/databases         → a folder (`folder:<id>`)
 *     holding the page's own doc (sorted first) plus its children, recursively.
 *   - A database                                → a folder with `schema` and
 *     `view: {mode:"table"}`; each row is a doc with `properties` and a body
 *     from its blocks (rows with child pages follow the page rule).
 *
 * Idempotency: `source = {type:"notion", id:<32-hex>, url, remoteEditedAt,
 * syncedAt}`. When the remote `last_edited_time` equals the stored
 * `remoteEditedAt` (and !force) the page's blocks are not fetched at all.
 *
 * Linking is two-pass: discovery walks the whole import scope and assigns
 * node ids first, so bodies written afterwards can link child pages and
 * mentions as `doc:<id>`. Mentions of pages outside the scope fall back to
 * already-imported nodes, then to the Notion URL.
 */

import type { DocumentStore } from "../store.js";
import type { DocNode, DocPropertyValue } from "../types.js";
import {
  collectBlockAssets,
  notionBlocksToMarkdown,
  type BlocksToMdContext,
  type NotionBlock,
} from "./blocks-to-md.js";
import {
  collectPropertyAssets,
  notionPageProperties,
  notionSchemaToColumns,
  type NotionPropertyValue,
} from "./properties.js";
import {
  IdAllocator,
  decideParent,
  emptyReport,
  errorMessage,
  extFromMime,
  extFromName,
  finalizeReport,
  ImportCancelledError,
  isCancelled,
  normalizeNotionId,
  noteResolvedLink,
  noteUnresolvedLink,
  notionUrlFor,
  tally,
  throwIfCancelled,
  type NotionImportProgress,
  type NotionImportReport,
} from "./shared.js";

export type { NotionImportProgress, NotionImportReport } from "./shared.js";

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DEFAULT_MAX_ASSET_BYTES = 50 * 1024 * 1024;
/** Nested block depth guard (Notion itself caps nesting well below this). */
const MAX_BLOCK_DEPTH = 16;

/* eslint-disable @typescript-eslint/no-explicit-any -- raw Notion JSON payloads */
type NotionObject = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Client ───────────────────────────────────────────────────

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

export interface NotionClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Override with INFINIBOT_NOTION_API_URL (tests / mock servers). */
  baseUrl?: string;
  /** Retries for 429 / 5xx / network errors (default 5). */
  maxRetries?: number;
  /** Minimum spacing between requests; Notion allows ~3 req/s (default 340ms). */
  minIntervalMs?: number;
  /** Ceiling for the adaptive spacing after repeated 429s (default 5s). */
  maxIntervalMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Aborts in-flight requests and backoff waits (import cancellation). */
  signal?: AbortSignal;
  /** Called before each retry wait (429 / 5xx / network), e.g. to surface "rate limited". */
  onRetry?: (info: { status: number; attempt: number; delayMs: number }) => void;
}

export interface NotionClientStats {
  requests: number;
  retries: number;
  rateLimited: number;
  /** Current spacing between requests (grows after 429s, decays on success). */
  intervalMs: number;
}

export interface NotionClient {
  /** Single request. Only GET and the read-only POST endpoints are used. */
  request<T = NotionObject>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T>;
  /** Follow `has_more`/`next_cursor` and return all `results`. */
  paginate<T = NotionObject>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    opts?: { limit?: number },
  ): Promise<T[]>;
  stats?: () => NotionClientStats;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ImportCancelledError());
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ImportCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function notionApiBaseUrl(): string {
  return (process.env.INFINIBOT_NOTION_API_URL?.trim() || NOTION_API_URL).replace(/\/$/, "");
}

export function createNotionClient(opts: NotionClientOptions): NotionClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? notionApiBaseUrl()).replace(/\/$/, "");
  const maxRetries = opts.maxRetries ?? 5;
  const minInterval = opts.minIntervalMs ?? 340;
  const maxInterval = Math.max(minInterval, opts.maxIntervalMs ?? 5_000);
  const signal = opts.signal;
  const sleep = opts.sleep
    ? async (ms: number) => {
        await opts.sleep!(ms);
        throwIfCancelled(signal);
      }
    : (ms: number) => abortableSleep(ms, signal);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let lastAt = 0;
  // Adaptive pacing: every 429 doubles the spacing (up to maxInterval); a run
  // of successes walks it back down so a brief burst doesn't slow the whole job.
  let interval = minInterval;
  let okStreak = 0;
  const stats = { requests: 0, retries: 0, rateLimited: 0 };

  async function backoff(status: number, attempt: number, delayMs: number) {
    stats.retries += 1;
    opts.onRetry?.({ status, attempt, delayMs });
    await sleep(delayMs);
    // The backoff wait already spaced this retry out.
    lastAt = Date.now() - interval;
  }

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      throwIfCancelled(signal);
      const wait = lastAt + interval - Date.now();
      if (interval > 0 && wait > 0) await sleep(wait);
      lastAt = Date.now();
      stats.requests += 1;
      let res: Response;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        res = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw new ImportCancelledError();
        if (attempt < maxRetries) {
          await backoff(0, attempt, Math.min(30_000, 500 * 2 ** attempt));
          continue;
        }
        throw new NotionApiError(`Notion request failed: ${errorMessage(err)}`, 0);
      }
      if (res.status === 429 || res.status >= 500) {
        if (res.status === 429) {
          stats.rateLimited += 1;
          interval = Math.min(maxInterval, Math.max(interval * 2, minInterval, 340));
          okStreak = 0;
        }
        if (attempt < maxRetries) {
          const retryAfter = Number(res.headers.get("retry-after"));
          // Retry-After is authoritative; otherwise exponential backoff with a
          // little jitter so parallel clients don't retry in lockstep.
          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(60_000, retryAfter * 1000)
              : Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
          await res.body?.cancel().catch(() => undefined);
          await backoff(res.status, attempt, delay);
          continue;
        }
      }
      const text = await res.text();
      let json: NotionObject = {};
      try {
        json = text ? (JSON.parse(text) as NotionObject) : {};
      } catch {
        /* non-JSON error body */
      }
      if (!res.ok) {
        throw new NotionApiError(
          `Notion API ${res.status}: ${json.message ?? text.slice(0, 200)}`,
          res.status,
          json.code,
        );
      }
      if (interval > minInterval && ++okStreak >= 10) {
        interval = Math.max(minInterval, Math.floor(interval / 2));
        okStreak = 0;
      }
      return json as T;
    }
  }

  async function paginate<T>(
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> = {},
    popts: { limit?: number } = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    const limit = popts.limit ?? Infinity;
    do {
      let res: NotionObject;
      if (method === "GET") {
        const q = new URLSearchParams({ page_size: "100" });
        if (cursor) q.set("start_cursor", cursor);
        res = await request<NotionObject>("GET", `${path}${path.includes("?") ? "&" : "?"}${q}`);
      } else {
        res = await request<NotionObject>("POST", path, {
          ...body,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
      }
      out.push(...((res.results ?? []) as T[]));
      cursor = res.has_more && res.next_cursor ? String(res.next_cursor) : undefined;
    } while (cursor && out.length < limit);
    return out.slice(0, limit === Infinity ? undefined : limit);
  }

  return { request, paginate, stats: () => ({ ...stats, intervalMs: interval }) };
}

// ── Search (picker) ──────────────────────────────────────────

export interface NotionSearchResult {
  id: string;
  type: "page" | "database";
  title: string;
  icon: string | null;
  url: string | null;
  lastEditedTime: string | null;
  parentType: string | null;
}

function plainTitle(rich: Array<{ plain_text?: string }> | undefined): string {
  return (rich ?? [])
    .map((r) => r.plain_text ?? "")
    .join("")
    .trim();
}

/** Title of a page or database object. */
export function notionObjectTitle(obj: NotionObject): string {
  if (obj.object === "database") return plainTitle(obj.title) || "Untitled database";
  for (const prop of Object.values<NotionObject>(obj.properties ?? {})) {
    if (prop?.type === "title") return plainTitle(prop.title) || "Untitled";
  }
  return "Untitled";
}

function iconOf(obj: NotionObject): string | null {
  const icon = obj.icon;
  if (!icon) return null;
  if (icon.type === "emoji") return icon.emoji ?? null;
  if (icon.type === "external") return icon.external?.url ?? null;
  if (icon.type === "file") return icon.file?.url ?? null;
  return null;
}

/** Search pages + databases shared with the integration (for an import picker). */
export async function searchNotion(
  client: NotionClient,
  query: string,
  opts: { limit?: number } = {},
): Promise<NotionSearchResult[]> {
  const results = await client.paginate<NotionObject>(
    "POST",
    "/search",
    { query, sort: { direction: "descending", timestamp: "last_edited_time" } },
    { limit: opts.limit ?? 100 },
  );
  return results
    .filter((r) => (r.object === "page" || r.object === "database") && !r.archived && !r.in_trash)
    .map((r) => ({
      id: normalizeNotionId(r.id) ?? String(r.id),
      type: r.object as "page" | "database",
      title: notionObjectTitle(r),
      icon: iconOf(r),
      url: r.url ?? null,
      lastEditedTime: r.last_edited_time ?? null,
      parentType: r.parent?.type ?? null,
    }));
}

// ── Import ───────────────────────────────────────────────────

export interface FetchedAsset {
  data: Buffer;
  contentType?: string;
}

/**
 * - `full`: walk every requested page/database tree. Pages whose Notion
 *   `last_edited_time` matches the stored `remoteEditedAt` are not re-fetched
 *   (one GET per page instead of a full block walk), so repeats are fast.
 * - `changes`: ask Notion's search for pages edited since the last sync and
 *   refresh only those (plus pages new under them). Falls back to `full` for
 *   roots that were never imported.
 */
export type NotionSyncMode = "full" | "changes";

export interface NotionImportOptions {
  /** Page/database ids or URLs (any format). */
  ids: string[];
  /** Folder to import under (null = workspace root). */
  parentId: string | null;
  /** Re-fetch and rewrite even when `last_edited_time` is unchanged. */
  force?: boolean;
  mode?: NotionSyncMode;
  /** Child page nesting depth to follow (default 20). Database rows don't count. */
  maxDepth?: number;
  /** Download Notion-hosted (expiring) files into the asset store (default true). */
  downloadAssets?: boolean;
  onProgress?: (p: NotionImportProgress) => void;
  /** Called after each node is written (live tree refresh / job checkpoints). */
  onWrite?: (nodeId: string) => void;
  /** Injectable asset downloader (default: fetch with a size cap). */
  fetchAsset?: (url: string) => Promise<FetchedAsset>;
  maxAssetBytes?: number;
  /**
   * Stable id of this sync run (the import job id). Stamped on every node
   * written; a resumed run skips nodes it already wrote even under `force`.
   */
  syncRun?: string;
  /** Accumulate counts into this report (a resumed job passes its saved one). */
  report?: NotionImportReport;
  /** Cancellation: checked between requests; partial results are kept. */
  signal?: AbortSignal;
}

interface PageRef {
  id: string;
  kind: "page" | "database";
}

/** Fetch a block's children recursively (not descending into child pages/databases). */
export async function fetchBlockTree(
  client: NotionClient,
  blockId: string,
  depth = 0,
): Promise<NotionBlock[]> {
  const blocks = await client.paginate<NotionBlock>("GET", `/blocks/${blockId}/children`);
  if (depth >= MAX_BLOCK_DEPTH) return blocks;
  for (const b of blocks) {
    if (!b.has_children || b.type === "child_page" || b.type === "child_database") continue;
    // Duplicate synced blocks carry their content on the original block.
    const src: string =
      b.type === "synced_block" && b.synced_block?.synced_from?.block_id
        ? b.synced_block.synced_from.block_id
        : b.id;
    b.children = await fetchBlockTree(client, src, depth + 1);
  }
  return blocks;
}

/** Child pages / databases referenced anywhere in a block tree (document order). */
function childRefs(blocks: NotionBlock[]): PageRef[] {
  const out: PageRef[] = [];
  const walk = (list: NotionBlock[]) => {
    for (const b of list) {
      if (b.type === "child_page") out.push({ id: b.id, kind: "page" });
      else if (b.type === "child_database") out.push({ id: b.id, kind: "database" });
      else if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

async function defaultFetchAsset(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<FetchedAsset> {
  if (!/^https?:\/\//i.test(url)) throw new Error("unsupported asset URL");
  const timeout = AbortSignal.timeout(120_000);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`asset exceeds ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`asset exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return {
    data: Buffer.concat(chunks),
    contentType: res.headers.get("content-type") ?? undefined,
  };
}

/** Markdown link targets: `](target)` or `](<target>)`. */
const MD_LINK_TARGET_RE = /\]\((<[^>\n]+>|[^)\s]+)\)/g;
/** Search results older than the last sync by more than this are ignored (clock skew / indexing lag). */
const CHANGES_SKEW_MS = 10 * 60_000;
/** Upper bound on search results scanned by a `changes` sync before falling back to a full walk. */
const CHANGES_MAX_SCAN = 5_000;

/**
 * Streaming importer: walks the scope depth-first and writes each page as
 * soon as its blocks are fetched, so pages land (and a crash loses at most
 * the page in flight) instead of everything arriving at the very end.
 *
 * Link targets for child pages/databases are allocated before the parent
 * body is rendered; mentions of pages discovered later in the walk are
 * rewritten in a final relink pass.
 */
class ApiImporter {
  private readonly report: NotionImportReport;
  private readonly visited = new Set<string>();
  private readonly ids: IdAllocator;
  /** Allocations by source id, so a node pre-allocated for linking keeps its id when written. */
  private readonly allocs = new Map<string, { id: string; existing: DocNode | null }>();
  /** Notion id → doc id (pages) / folder id (databases) for link resolution. */
  private readonly linkMap = new Map<string, string>();
  private readonly titles = new Map<string, string>();
  private readonly assetMap = new Map<string, string>();
  private readonly createdThisRun = new Set<string>();
  /** Doc id → Notion ids its body linked to that weren't resolvable yet. */
  private readonly unresolved = new Map<string, Set<string>>();
  /** Doc id → relation property values (Notion ids) not resolvable when written. */
  private readonly pendingRelations = new Map<string, Set<string>>();
  private readonly syncedAt = new Date().toISOString();
  private readonly maxDepth: number;
  private readonly maxAssetBytes: number;
  private readonly mode: NotionSyncMode;
  private done = 0;
  private total = 0;

  constructor(
    private readonly store: DocumentStore,
    private readonly client: NotionClient,
    private readonly opts: NotionImportOptions,
  ) {
    this.ids = new IdAllocator(store);
    this.maxDepth = opts.maxDepth ?? 20;
    this.maxAssetBytes = opts.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
    this.mode = opts.mode ?? "full";
    this.report = opts.report ?? emptyReport();
  }

  async run(): Promise<NotionImportReport> {
    const roots: string[] = [];
    for (const raw of this.opts.ids) {
      const id = normalizeNotionId(raw);
      if (!id) this.report.errors.push({ id: raw, error: "Not a Notion page/database id or URL" });
      else roots.push(id);
    }
    const walk = this.mode === "changes" ? await this.runChanges(roots) : roots;
    this.total += walk.length;
    for (const id of walk) {
      throwIfCancelled(this.opts.signal);
      try {
        const obj = await this.retrieve(id);
        const nodeId = await this.processObject(
          obj,
          this.opts.parentId,
          0,
          obj.parent?.type === "database_id",
        );
        if (nodeId && !this.report.rootNodeIds.includes(nodeId)) {
          this.report.rootNodeIds.push(nodeId);
        }
      } catch (err) {
        if (isCancelled(err)) {
          this.annotateErrors();
          throw err;
        }
        this.report.errors.push({ id, error: errorMessage(err) });
      }
    }
    this.relink();
    this.annotateErrors();
    return this.report;
  }

  private annotateErrors(): void {
    for (const e of this.report.errors) {
      if (e.title) continue;
      const id = normalizeNotionId(e.id);
      const title = id ? this.titles.get(id) : undefined;
      if (title) e.title = title;
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  /** GET a page, falling back to a database when the id isn't a page. */
  private async retrieve(id: string, hint?: "page" | "database"): Promise<NotionObject> {
    const order: Array<"page" | "database"> =
      hint === "database" ? ["database", "page"] : ["page", "database"];
    let firstErr: unknown;
    for (const kind of order) {
      try {
        return await this.client.request(
          "GET",
          kind === "page" ? `/pages/${id}` : `/databases/${id}`,
        );
      } catch (err) {
        if (!(err instanceof NotionApiError) || (err.status !== 400 && err.status !== 404)) {
          throw err;
        }
        firstErr ??= err;
      }
    }
    throw firstErr;
  }

  private progress(title: string, phase: NotionImportProgress["phase"] = "import") {
    this.opts.onProgress?.({ phase, done: this.done, total: this.total, title });
  }

  private alloc(sourceId: string, title: string): { id: string; existing: DocNode | null } {
    let a = this.allocs.get(sourceId);
    if (!a) {
      a = this.ids.allocate({ type: "notion", id: sourceId }, title);
      this.allocs.set(sourceId, a);
    }
    return a;
  }

  /** Reserve link targets for objects about to be written (so earlier bodies can link them). */
  private reserveLink(obj: NotionObject): void {
    const id = normalizeNotionId(obj.id);
    if (!id) return;
    const title = notionObjectTitle(obj);
    this.titles.set(id, title);
    if (!this.linkMap.has(id)) this.linkMap.set(id, this.alloc(id, title).id);
  }

  private source(obj: NotionObject, id: string) {
    const nid = normalizeNotionId(obj.id)!;
    return {
      type: "notion" as const,
      id,
      url: obj.url ?? notionUrlFor(nid),
      remoteEditedAt: obj.last_edited_time,
      syncedAt: this.syncedAt,
      ...(this.opts.syncRun ? { syncRun: this.opts.syncRun } : {}),
    };
  }

  /** Written by this same (resumed) run already, and not edited remotely since. */
  private alreadySynced(existing: DocNode | null, lastEdited: string | undefined): boolean {
    return (
      !!this.opts.syncRun &&
      !!existing &&
      existing.source?.syncRun === this.opts.syncRun &&
      existing.source?.remoteEditedAt === lastEdited
    );
  }

  private wrote(node: DocNode | null) {
    if (node) this.opts.onWrite?.(node.id);
  }

  /** Notion children recorded under a page folder from a previous import. */
  private knownChildren(folderId: string, ownDocId: string | undefined): PageRef[] {
    const out: PageRef[] = [];
    for (const n of this.store.children(folderId)) {
      if (n.id === ownDocId || n.source?.type !== "notion" || !n.source.id) continue;
      const sid = n.source.id;
      if (sid.startsWith("folder:")) out.push({ id: sid.slice("folder:".length), kind: "page" });
      else out.push({ id: sid, kind: n.kind === "folder" ? "database" : "page" });
    }
    return out;
  }

  private processObject(
    obj: NotionObject,
    parentId: string | null,
    depth: number,
    isRow: boolean,
  ): Promise<string | null> {
    return obj.object === "database"
      ? this.processDatabase(obj, parentId, depth)
      : this.processPage(obj, parentId, depth, isRow);
  }

  // ── Pages ──────────────────────────────────────────────────

  private async processPage(
    obj: NotionObject,
    parentId: string | null,
    depth: number,
    isRow: boolean,
  ): Promise<string | null> {
    const id = normalizeNotionId(obj.id);
    this.done += 1;
    if (!id || this.visited.has(id) || obj.archived || obj.in_trash) return null;
    this.visited.add(id);
    throwIfCancelled(this.opts.signal);
    const title = notionObjectTitle(obj);
    this.titles.set(id, title);
    this.progress(title);
    const lastEdited: string | undefined = obj.last_edited_time;
    const existing = this.store.findBySource("notion", id);
    const existingFolder = this.store.findBySource("notion", `folder:${id}`);
    const resumed = this.alreadySynced(existing, lastEdited);
    const unchanged =
      resumed ||
      (!this.opts.force &&
        !!existing &&
        !!lastEdited &&
        existing.source?.remoteEditedAt === lastEdited);

    // `changes` mode: an unchanged page is left completely alone — any edited
    // descendant shows up in the search results on its own.
    if (unchanged && this.mode === "changes") {
      if (!resumed) tally(this.report, "unchanged");
      const nodeId = existingFolder?.id ?? existing?.id ?? null;
      if (existing) this.linkMap.set(id, existing.id);
      return nodeId;
    }

    let blocks: NotionBlock[] | null = null;
    let refs: PageRef[];
    if (unchanged) {
      // Blocks unchanged → child set unchanged; recover it from the last import.
      refs = existingFolder ? this.knownChildren(existingFolder.id, existing?.id) : [];
    } else {
      blocks = await fetchBlockTree(this.client, id);
      refs = childRefs(blocks);
    }

    const children: NotionObject[] = [];
    if (depth < this.maxDepth) {
      for (const ref of refs) {
        const childId = normalizeNotionId(ref.id);
        if (!childId || this.visited.has(childId)) continue;
        try {
          const child = await this.retrieve(childId, ref.kind);
          if (child.archived || child.in_trash) continue;
          children.push(child);
        } catch (err) {
          if (isCancelled(err)) throw err;
          this.report.errors.push({ id: childId, error: errorMessage(err) });
        }
      }
    }
    this.total += children.length;
    // Keep an existing folder layout even if the page lost its children.
    const asFolder = children.length > 0 || (!!existingFolder && !existingFolder.deletedAt);

    const docAlloc = this.alloc(id, title);
    this.linkMap.set(id, docAlloc.id);
    for (const c of children) this.reserveLink(c);

    let container = parentId;
    let folder: DocNode | null = null;
    if (asFolder) {
      const f = this.alloc(`folder:${id}`, title);
      folder =
        resumed && f.existing
          ? f.existing
          : this.upsertFolder(obj, `folder:${id}`, f, parentId, false);
      if (!folder) return null;
      container = folder.id;
    }
    // Children first, the page's own doc last: the doc carries the sync stamp
    // (`remoteEditedAt`/`syncRun`) that later runs use to skip this page, so it
    // must only land once the whole subtree has — an interrupted run then
    // re-walks the page instead of trusting a half-written child list.
    for (const child of children) {
      try {
        await this.processObject(child, container, depth + 1, false);
      } catch (err) {
        if (isCancelled(err)) throw err;
        const cid = normalizeNotionId(child.id) ?? String(child.id);
        this.report.errors.push({ id: cid, error: errorMessage(err) });
      }
    }
    throwIfCancelled(this.opts.signal);
    const doc = resumed
      ? existing
      : await this.writeDoc(obj, docAlloc, container, {
          blocks,
          unchanged,
          isRow,
          firstInFolder: asFolder,
        });
    return folder?.id ?? doc?.id ?? null;
  }

  // ── Databases ──────────────────────────────────────────────

  private async processDatabase(
    obj: NotionObject,
    parentId: string | null,
    depth: number,
  ): Promise<string | null> {
    const id = normalizeNotionId(obj.id);
    this.done += 1;
    if (!id || this.visited.has(id) || obj.archived || obj.in_trash) return null;
    this.visited.add(id);
    throwIfCancelled(this.opts.signal);
    const title = notionObjectTitle(obj);
    this.titles.set(id, title);
    this.progress(title);
    const alloc = this.alloc(id, title);
    this.linkMap.set(id, alloc.id);
    const resumed = this.alreadySynced(alloc.existing, obj.last_edited_time);
    const folder =
      resumed && alloc.existing
        ? alloc.existing
        : this.upsertFolder(obj, id, alloc, parentId, true);
    if (!folder) return null;
    this.progress(`${title} — listing rows`, "scan");
    const rows = await this.client.paginate<NotionObject>("POST", `/databases/${id}/query`);
    this.total += rows.length;
    // Rows can mention each other: reserve every row's link target first.
    for (const row of rows) this.reserveLink(row);
    for (const row of rows) {
      try {
        // Rows are the database's content: they don't consume nesting depth,
        // but their own child pages do.
        await this.processPage(row, folder.id, depth, true);
      } catch (err) {
        if (isCancelled(err)) throw err;
        this.report.errors.push({
          id: normalizeNotionId(row.id) ?? row.id,
          error: errorMessage(err),
        });
      }
    }
    return folder.id;
  }

  // ── `changes` mode ─────────────────────────────────────────

  /**
   * Refresh pages edited since the last sync of each root's subtree. Returns
   * the roots that still need a full walk (never imported / no sync stamp).
   */
  private async runChanges(roots: string[]): Promise<string[]> {
    const needWalk: string[] = [];
    /** Notion id → local node for everything already imported under the roots. */
    const scope = new Map<string, DocNode>();
    let since = Infinity;
    for (const id of roots) {
      const local =
        this.store.findBySource("notion", `folder:${id}`) ?? this.store.findBySource("notion", id);
      if (!local || local.deletedAt) {
        needWalk.push(id);
        continue;
      }
      if (!this.report.rootNodeIds.includes(local.id)) this.report.rootNodeIds.push(local.id);
      let oldest = Infinity;
      const stack: DocNode[] = [local];
      while (stack.length) {
        const n = stack.pop()!;
        if (n.source?.type === "notion" && n.source.id) {
          scope.set(n.source.id.replace(/^folder:/, ""), n);
          const t = Date.parse(n.source.syncedAt ?? "");
          oldest = Math.min(oldest, Number.isFinite(t) ? t : -Infinity);
        }
        if (n.kind === "folder") stack.push(...this.store.children(n.id));
      }
      if (oldest === -Infinity) {
        needWalk.push(id);
        continue;
      }
      since = Math.min(since, oldest);
    }
    if (!scope.size || since === Infinity) return needWalk;

    const cutoff = since - CHANGES_SKEW_MS;
    const changed: NotionObject[] = [];
    let cursor: string | undefined;
    let scanned = 0;
    for (;;) {
      throwIfCancelled(this.opts.signal);
      this.progress(`Looking for pages edited since ${new Date(since).toISOString()}`, "scan");
      const res = await this.client.request<NotionObject>("POST", "/search", {
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      let reachedOld = false;
      for (const r of (res.results ?? []) as NotionObject[]) {
        scanned += 1;
        const t = Date.parse(r.last_edited_time ?? "");
        if (Number.isFinite(t) && t < cutoff) {
          reachedOld = true;
          break;
        }
        changed.push(r);
      }
      cursor = res.has_more && res.next_cursor ? String(res.next_cursor) : undefined;
      if (reachedOld || !cursor) break;
      if (scanned >= CHANGES_MAX_SCAN) {
        // Too much changed to be worth the incremental path — walk everything.
        return [...needWalk, ...roots.filter((r) => !needWalk.includes(r))];
      }
    }

    const relevant: Array<{ obj: NotionObject; parentId: string | null; isRow: boolean }> = [];
    for (const obj of changed) {
      const id = normalizeNotionId(obj.id);
      if (!id || obj.archived || obj.in_trash) continue;
      const local = scope.get(id);
      const isRow = obj.parent?.type === "database_id";
      if (local) {
        relevant.push({ obj, parentId: local.parentId ?? null, isRow });
        continue;
      }
      // New row in an imported database (adding a row doesn't always touch the
      // database itself). New child pages arrive via their edited parent page.
      const dbId = isRow ? normalizeNotionId(obj.parent?.database_id) : null;
      const db = dbId ? scope.get(dbId) : undefined;
      if (db && db.kind === "folder") relevant.push({ obj, parentId: db.id, isRow: true });
    }
    this.total += relevant.length;
    for (const r of relevant) this.reserveLink(r.obj);
    for (const r of relevant) {
      throwIfCancelled(this.opts.signal);
      try {
        await this.processObject(r.obj, r.parentId, 0, r.isRow);
      } catch (err) {
        if (isCancelled(err)) throw err;
        this.report.errors.push({
          id: normalizeNotionId(r.obj.id) ?? String(r.obj.id),
          error: errorMessage(err),
        });
      }
    }
    return needWalk;
  }

  // ── Writes ─────────────────────────────────────────────────

  private mdContext(docId: string): BlocksToMdContext {
    return {
      resolveAsset: (url) => this.assetMap.get(url) ?? url,
      resolvePage: (notionId) => {
        const id = normalizeNotionId(notionId);
        if (!id) return null;
        const mapped = this.linkMap.get(id);
        if (mapped) {
          noteResolvedLink(this.report);
          return mapped;
        }
        const prior = this.store.findBySource("notion", id);
        if (prior && !prior.deletedAt) {
          noteResolvedLink(this.report);
          return prior.id;
        }
        let set = this.unresolved.get(docId);
        if (!set) this.unresolved.set(docId, (set = new Set()));
        set.add(id);
        return null;
      },
      titleOf: (notionId) => {
        const id = normalizeNotionId(notionId);
        if (!id) return undefined;
        return this.titles.get(id) ?? this.store.findBySource("notion", id)?.title;
      },
    };
  }

  /** Upsert a folder node (database or page folder). Returns null if trashed/failed. */
  private upsertFolder(
    obj: NotionObject,
    sourceId: string,
    alloc: { id: string; existing: DocNode | null },
    parentId: string | null,
    isDb: boolean,
  ): DocNode | null {
    const placement = decideParent(this.store, alloc.existing, parentId, this.createdThisRun);
    const res = this.store.upsertBySource(
      this.source(obj, sourceId),
      {
        kind: "folder",
        id: alloc.id,
        title: notionObjectTitle(obj),
        parentId: placement.parentId,
        icon: obj.icon?.type === "emoji" ? obj.icon.emoji : undefined,
        ...(isDb
          ? { schema: notionSchemaToColumns(obj.properties), view: { mode: "table" as const } }
          : {}),
      },
      { reparent: placement.reparent },
    );
    tally(this.report, res.status);
    if (res.status === "created") this.createdThisRun.add(res.node.id);
    const node = res.status === "skipped" ? null : res.node;
    this.wrote(node);
    return node;
  }

  private async downloadAssets(
    obj: NotionObject,
    blocks: NotionBlock[] | null,
    isRow: boolean,
  ): Promise<void> {
    if (this.opts.downloadAssets === false) return;
    const assets = [
      ...collectBlockAssets(blocks ?? []),
      ...(isRow ? collectPropertyAssets(obj.properties) : []),
    ];
    for (const a of assets) {
      if (!a.hosted || this.assetMap.has(a.url)) continue;
      throwIfCancelled(this.opts.signal);
      try {
        const got = this.opts.fetchAsset
          ? await this.opts.fetchAsset(a.url)
          : await defaultFetchAsset(a.url, this.maxAssetBytes, this.opts.signal);
        if (got.data.length > this.maxAssetBytes) {
          throw new Error(`asset exceeds ${this.maxAssetBytes} bytes`);
        }
        const ext =
          extFromName(a.name) || extFromName(a.url) || extFromMime(got.contentType) || ".bin";
        this.assetMap.set(a.url, this.store.addAsset(got.data, ext));
      } catch (err) {
        if (isCancelled(err) || this.opts.signal?.aborted) throw new ImportCancelledError();
        this.report.errors.push({
          id: normalizeNotionId(obj.id) ?? String(obj.id),
          error: `asset ${a.name}: ${errorMessage(err)}`,
        });
      }
    }
  }

  private async writeDoc(
    obj: NotionObject,
    alloc: { id: string; existing: DocNode | null },
    parentId: string | null,
    w: { blocks: NotionBlock[] | null; unchanged: boolean; isRow: boolean; firstInFolder: boolean },
  ): Promise<DocNode | null> {
    const id = normalizeNotionId(obj.id)!;
    const placement = decideParent(this.store, alloc.existing, parentId, this.createdThisRun);
    let body: string | undefined;
    let properties: Record<string, DocPropertyValue> | undefined;
    if (!w.unchanged) {
      await this.downloadAssets(obj, w.blocks, w.isRow);
      const ctx = this.mdContext(alloc.id);
      body = notionBlocksToMarkdown(w.blocks ?? [], ctx);
      if (w.isRow) {
        const raw = obj.properties as Record<string, NotionPropertyValue> | undefined;
        properties = notionPageProperties(raw, {
          resolveAsset: ctx.resolveAsset,
          titleOf: ctx.titleOf,
        }).properties;
        properties = this.linkRelations(alloc.id, raw, properties);
      }
    }
    const res = this.store.upsertBySource(
      this.source(obj, id),
      {
        kind: "doc",
        id: alloc.id,
        title: notionObjectTitle(obj),
        parentId: placement.parentId,
        icon: obj.icon?.type === "emoji" ? obj.icon.emoji : undefined,
        body,
        properties,
      },
      { reparent: placement.reparent },
    );
    tally(this.report, res.status);
    if (res.status === "created") this.createdThisRun.add(res.node.id);
    // A page's own doc sits first inside its folder.
    if (
      w.firstInFolder &&
      parentId &&
      (res.status === "created" || placement.reparent) &&
      res.node.parentId === parentId
    ) {
      this.store.move(res.node.id, parentId, 0);
    }
    const node = res.status === "skipped" ? null : res.node;
    this.wrote(node);
    return node;
  }

  /** Local doc for a Notion id (this run's allocations first, then earlier imports). */
  private localFor(nid: string): string | null {
    const mapped = this.linkMap.get(nid);
    if (mapped) return mapped;
    const prior = this.store.findBySource("notion", nid);
    return prior && !prior.deletedAt ? prior.id : null;
  }

  /**
   * Relation values (Notion ids) → `doc:<id>` when the target is imported (or
   * reserved in this run). Unresolved ids are kept and retried in relink().
   */
  private linkRelations(
    docId: string,
    raw: Record<string, NotionPropertyValue> | undefined,
    props: Record<string, DocPropertyValue>,
  ): Record<string, DocPropertyValue> {
    const out = { ...props };
    for (const [name, prop] of Object.entries(raw ?? {})) {
      if (prop?.type !== "relation" || !Array.isArray(out[name])) continue;
      out[name] = (out[name] as string[]).map((v) => {
        if (!HEX32_ONLY_RE.test(v)) return v;
        const local = this.localFor(v);
        if (local) {
          noteResolvedLink(this.report);
          return `doc:${local}`;
        }
        let set = this.pendingRelations.get(docId);
        if (!set) this.pendingRelations.set(docId, (set = new Set()));
        set.add(v);
        return v;
      });
    }
    return out;
  }

  /** Relation columns of the database folder a row doc sits in. */
  private relationKeys(node: DocNode): Set<string> {
    const parent = node.parentId ? this.store.getNode(node.parentId) : null;
    return new Set((parent?.schema ?? []).filter((c) => c.type === "relation").map((c) => c.key));
  }

  /**
   * Point Notion-URL links at pages that were imported later in the same run.
   * Candidates: docs whose render hit an unresolved in-scope id, plus every
   * doc stamped with this sync run — a resumed job skips pages written before
   * the restart, so their pending links are only recoverable from the store.
   */
  private relink(): void {
    const candidates = new Set([...this.unresolved.keys(), ...this.pendingRelations.keys()]);
    if (this.opts.syncRun) {
      for (const n of this.store.all()) {
        if (
          n.kind === "doc" &&
          !n.deletedAt &&
          n.source?.type === "notion" &&
          n.source.syncRun === this.opts.syncRun
        ) {
          candidates.add(n.id);
        }
      }
    }
    const resolve = (nid: string): string | null => {
      const mapped = this.linkMap.get(nid);
      if (mapped && this.store.getNode(mapped)) return mapped;
      const prior = this.store.findBySource("notion", nid);
      return prior && !prior.deletedAt ? prior.id : null;
    };
    for (const docId of candidates) {
      throwIfCancelled(this.opts.signal);
      const node = this.store.getNode(docId);
      if (!node || node.kind !== "doc" || node.deletedAt) continue;
      for (const nid of this.unresolved.get(docId) ?? []) {
        if (resolve(nid)) noteResolvedLink(this.report);
        else noteUnresolvedLink(this.report, node.title, nid);
      }
      this.relinkRelations(node, resolve);
      const body = this.store.getBody(docId);
      if (!/notion\.(so|site)\//i.test(body)) continue;
      const next = body.replace(MD_LINK_TARGET_RE, (whole, rawTarget: string) => {
        const target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
        if (!/^https?:\/\/(www\.)?notion\.(so|site)\//i.test(target)) return whole;
        const nid = normalizeNotionId(target);
        const mapped = nid ? resolve(nid) : null;
        return mapped && mapped !== docId ? `](doc:${mapped})` : whole;
      });
      if (next !== body) this.store.update({ id: docId, body: next });
    }
  }

  /** Second chance for relation ids whose target was written after the row. */
  private relinkRelations(node: DocNode, resolve: (nid: string) => string | null): void {
    if (!node.properties) return;
    let keys: Set<string> | null = null;
    let changed = false;
    const next: Record<string, DocPropertyValue> = { ...node.properties };
    for (const [k, v] of Object.entries(node.properties)) {
      if (!Array.isArray(v) || !v.some((x) => HEX32_ONLY_RE.test(x))) continue;
      keys ??= this.relationKeys(node);
      if (!keys.has(k)) continue;
      next[k] = v.map((x) => {
        if (!HEX32_ONLY_RE.test(x)) return x;
        const local = resolve(x);
        if (local) {
          noteResolvedLink(this.report);
          changed = true;
          return `doc:${local}`;
        }
        noteUnresolvedLink(this.report, node.title, x);
        return x;
      });
    }
    if (changed) this.store.update({ id: node.id, properties: next });
  }
}

const HEX32_ONLY_RE = /^[0-9a-f]{32}$/;

/**
 * Import Notion pages/databases (by id or URL) into the document store.
 * Per-page failures are collected in `report.errors`; the rest still imports.
 * Throws ImportCancelledError when `opts.signal` aborts (pages written so far stay).
 */
export async function importNotion(
  store: DocumentStore,
  client: NotionClient,
  opts: NotionImportOptions,
): Promise<NotionImportReport> {
  if (opts.parentId) {
    const parent = store.getNode(opts.parentId);
    if (!parent || parent.kind !== "folder") {
      throw new Error(`Parent folder "${opts.parentId}" not found`);
    }
  }
  const importer = new ApiImporter(store, client, opts);
  // Deferred index writes (flushed periodically and when the run settles).
  try {
    return finalizeReport(await store.batch(() => importer.run()));
  } catch (err) {
    if (opts.report) finalizeReport(opts.report);
    throw err;
  }
}
