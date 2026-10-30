/**
 * Stale-while-revalidate cache for the Notion-backed `kanban.projects.list` /
 * `kanban.tasks.list` responses.
 *
 * A full Notion read is slow on a real board (~4k tasks → 45 sequential pages
 * → 25–40 s; ~175 projects → 10–15 s). The previous cache dropped entries on
 * expiry (30 s) and on every write, so almost every page load paid the full
 * Notion round trip and the Home/Business HQ board sat on "Task board not
 * responding". Now:
 *
 *   fresh entry           → served from memory
 *   aged-out entry        → served stale immediately, refreshed in background
 *   write-invalidated     → wait up to `dirtyWaitMs` for the refresh (so a
 *                           reload after a write usually sees it), then serve
 *                           the last good list instead of blocking
 *   no entry (cold boot)  → wait for the fetch
 *
 * Concurrent callers for the same key share one in-flight fetch.
 *
 * Writes must never be undone by the cache. Two things used to do exactly
 * that ("I marked it done, it vanished, then came back"):
 *   1. a refresh that started BEFORE a write finished after it and stored the
 *      pre-write rows as a clean, fresh entry;
 *   2. an in-flight refresh that never settled wedged the key: every read
 *      re-joined it, waited `dirtyWaitMs` and served the pre-write list
 *      forever (seen live: one hour of a stale `tasks:all`).
 * So: every write bumps a generation and records a row overlay (`overlay`).
 * Results from a fetch that started before the latest write stay dirty and get
 * the write's patch re-applied; an in-flight fetch older than `maxInflightMs`
 * is abandoned (its late result is ignored) and a new one starts.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Entry<T> = { data: T; expiresAt: number; dirty: boolean; token: number };
type Flight = { promise: Promise<unknown>; startedAt: number; token: number; startGen: number };
type Overlay = {
  prefixes: string[];
  id: string;
  patch: Record<string, unknown>;
  gen: number;
  at: number;
};
type FetchCtx = { key: string; token: number; startGen: number };

export type ListCacheOptions = {
  now?: () => number;
  /** How long a write-invalidated read waits for fresh data before serving stale. */
  dirtyWaitMs?: number;
  /** An in-flight refresh older than this is abandoned and a new one started. */
  maxInflightMs?: number;
  /**
   * How long a write's patch is re-applied to lists fetched AFTER it (Notion's
   * query index can lag a fresh page write). Fetches that started before the
   * write always get the patch while it is retained.
   */
  overlayGraceMs?: number;
  /** How long a write overlay is retained at all. */
  overlayTtlMs?: number;
  onBackgroundError?: (key: string, err: unknown) => void;
};

const normId = (v: unknown): string =>
  typeof v === "string" ? v.replace(/-/g, "").toLowerCase() : "";

export function createListCache(opts: ListCacheOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const dirtyWaitMs = opts.dirtyWaitMs ?? 4_000;
  const maxInflightMs = opts.maxInflightMs ?? 120_000;
  const overlayGraceMs = opts.overlayGraceMs ?? 60_000;
  const overlayTtlMs = opts.overlayTtlMs ?? 10 * 60_000;
  const entries = new Map<string, Entry<unknown>>();
  const inflight = new Map<string, Flight>();
  const fetchCtx = new AsyncLocalStorage<FetchCtx>();
  /** Latest write generation per invalidated prefix ("" = everything). */
  const writeGens = new Map<string, number>();
  let overlays: Overlay[] = [];
  let gen = 0;
  let tokenSeq = 0;

  function lastWriteGen(key: string): number {
    let g = 0;
    for (const [prefix, pg] of writeGens) if (key.startsWith(prefix) && pg > g) g = pg;
    return g;
  }

  function patchRows<T>(data: T, ov: Overlay): T {
    if (!Array.isArray(data)) return data;
    const want = normId(ov.id);
    let hit = false;
    const next = data.map((row) => {
      if (
        row &&
        typeof row === "object" &&
        (normId(row.id) === want || normId(row.notionId) === want)
      ) {
        hit = true;
        return { ...row, ...ov.patch };
      }
      return row;
    });
    return (hit ? next : data) as T;
  }

  function applyOverlays<T>(key: string, data: T, startGen: number): T {
    const t = now();
    overlays = overlays.filter((o) => t - o.at < overlayTtlMs);
    let out = data;
    for (const o of overlays) {
      if (!o.prefixes.some((p) => key.startsWith(p))) continue;
      // Started before the write → certainly pre-write rows. Started after →
      // trust the source once the grace period for its index lag has passed.
      if (o.gen > startGen || t - o.at < overlayGraceMs) out = patchRows(out, o);
    }
    return out;
  }

  /**
   * One fetch per key at a time; the fetcher stores its own result via `set`.
   * A fetch that has been in flight longer than `maxInflightMs` is treated as
   * dead: a new one starts and the old one's eventual `set` is ignored.
   */
  function refresh<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key);
    if (existing && now() - existing.startedAt < maxInflightMs)
      return existing.promise as Promise<T>;
    const token = ++tokenSeq;
    const ctx: FetchCtx = { key, token, startGen: gen };
    const p = fetchCtx.run(ctx, fetcher).finally(() => {
      if (inflight.get(key)?.token === token) inflight.delete(key);
    });
    inflight.set(key, { promise: p, startedAt: now(), token, startGen: ctx.startGen });
    return p;
  }

  /**
   * What a reader gets once a refresh settles: the entry that fetch stored
   * (overlays already applied), else its raw result with the overlays applied
   * (fetchers that don't cache, e.g. a local fallback).
   */
  function settle<T>(key: string, flight: Flight | undefined): Promise<T> {
    const p = (flight?.promise ?? Promise.reject(new Error("no refresh"))) as Promise<T>;
    return p.then((r) => {
      const cur = entries.get(key);
      if (cur && flight && cur.token === flight.token) return cur.data as T;
      return applyOverlays(key, r, flight?.startGen ?? 0);
    });
  }

  function set<T>(key: string, data: T, ttlMs: number): void {
    const ctx = fetchCtx.getStore();
    const own = ctx && ctx.key === key ? ctx : undefined;
    if (own) {
      const prev = entries.get(key);
      // A newer fetch already landed for this key — drop the late result.
      if (prev && prev.token > own.token) return;
      const flight = inflight.get(key);
      if (flight && flight.token > own.token) return; // superseded (abandoned) fetch
    }
    const startGen = own ? own.startGen : gen;
    entries.set(key, {
      data: applyOverlays(key, data, startGen),
      expiresAt: now() + ttlMs,
      // Rows read before the latest write are servable but must refresh.
      dirty: lastWriteGen(key) > startGen,
      token: own ? own.token : ++tokenSeq,
    });
  }

  /** Fresh hit only (not expired, not write-invalidated). */
  function getFresh<T>(key: string): T | null {
    const e = entries.get(key);
    return e && !e.dirty && e.expiresAt >= now() ? (e.data as T) : null;
  }

  /** Mark entries stale without dropping them — they stay servable. */
  function invalidate(prefix?: string): void {
    gen += 1;
    writeGens.set(prefix ?? "", gen);
    for (const [key, e] of entries) {
      if (prefix === undefined || key.startsWith(prefix)) e.dirty = true;
    }
  }

  /**
   * Record a confirmed write to one row (matched on `id` / `notionId`, dashes
   * ignored) in every list under `prefixes`: cached lists are patched now, and
   * any list a refresh stores later gets the patch re-applied when that fetch
   * started before this write (or within the grace window after it). Also
   * invalidates the prefixes so the next read refreshes from the source.
   */
  function overlay(prefixes: string[], id: string, patch: Record<string, unknown>): void {
    if (!id || Object.keys(patch).length === 0) return;
    for (const p of prefixes) invalidate(p);
    const ov: Overlay = { prefixes, id, patch, gen, at: now() };
    overlays.push(ov);
    for (const [key, e] of entries) {
      if (prefixes.some((p) => key.startsWith(p))) e.data = patchRows(e.data, ov);
    }
  }

  async function get<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const e = entries.get(key) as Entry<T> | undefined;
    if (e && !e.dirty && e.expiresAt >= now()) return e.data;
    void refresh(key, fetcher);
    const pending = settle<T>(key, inflight.get(key));
    if (!e) return pending;
    // Never let a background refresh surface as an unhandled rejection.
    pending.catch((err) => opts.onBackgroundError?.(key, err));
    if (!e.dirty) return e.data;

    // Read the entry at resolve time: an overlay may have patched it since.
    const current = () => (entries.get(key)?.data ?? e.data) as T;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(current()), dirtyWaitMs);
    });
    try {
      return await Promise.race([pending.catch(current), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Whatever is cached for `key` (fresh, stale or dirty), without fetching. */
  function peek<T>(key: string): T | undefined {
    return entries.get(key)?.data as T | undefined;
  }

  return {
    get,
    peek,
    set,
    getFresh,
    invalidate,
    overlay,
    refresh,
    clear: () => {
      entries.clear();
      overlays = [];
    },
  };
}
