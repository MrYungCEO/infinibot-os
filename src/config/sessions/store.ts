import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import JSON5 from "json5";
import { getFileMtimeMs, isCacheEnabled, resolveCacheTtlMs } from "../cache-utils.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
  type DeliveryContext,
} from "../../utils/delivery-context.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import { pinSecureTranscriptPaths } from "../../secure-mode/transcripts.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

// ============================================================================
// Session Store Cache with TTL Support
// ============================================================================

type SessionStoreCacheEntry = {
  store: Record<string, SessionEntry>;
  loadedAt: number;
  storePath: string;
  mtimeMs?: number;
};

const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds (between 30-60s)

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getSessionStoreTtl(): number {
  return resolveCacheTtlMs({
    envValue: process.env.INFINIBOT_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_SESSION_STORE_TTL_MS,
  });
}

function isSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getSessionStoreTtl());
}

function isSessionStoreCacheValid(entry: SessionStoreCacheEntry): boolean {
  const now = Date.now();
  const ttl = getSessionStoreTtl();
  return now - entry.loadedAt <= ttl;
}

function invalidateSessionStoreCache(storePath: string): void {
  SESSION_STORE_CACHE.delete(storePath);
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields(entry);
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) return entry;
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  // Secure Mode: secure sessions' transcripts live in RAM, never on disk.
  pinSecureTranscriptPaths(store);
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) continue;
    const normalized = normalizeSessionEntryDelivery(entry);
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

export function clearSessionStoreCacheForTest(): void {
  SESSION_STORE_CACHE.clear();
}

type LoadSessionStoreOptions = {
  skipCache?: boolean;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function readSessionStoreFromDisk(storePath: string): {
  store: Record<string, SessionEntry>;
  mtimeMs: number | undefined;
} {
  let store: Record<string, SessionEntry> = {};
  let mtimeMs = getFileMtimeMs(storePath);
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    // The store is always written with JSON.stringify, so the native parser
    // handles it (an 8 MB store: ~40 ms native vs ~700 ms JSON5, on the event
    // loop). JSON5 stays as the fallback for a hand-edited file.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = JSON5.parse(raw);
    }
    if (isSessionStoreRecord(parsed)) {
      store = parsed as Record<string, SessionEntry>;
    }
    mtimeMs = getFileMtimeMs(storePath) ?? mtimeMs;
  } catch {
    // ignore missing/invalid store; we'll recreate it
  }

  pinSecureTranscriptPaths(store);

  // Best-effort migration: message provider → channel naming.
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
    } else if ("room" in rec) {
      delete rec.room;
    }
  }
  return { store, mtimeMs };
}

/**
 * The cached, deep-frozen snapshot for `storePath` (loaded from disk on a
 * miss, an expired TTL or an mtime change). Undefined when caching is off.
 */
function getCachedSessionStoreSnapshot(
  storePath: string,
): Readonly<Record<string, SessionEntry>> | undefined {
  if (!isSessionStoreCacheEnabled()) return undefined;
  const cached = SESSION_STORE_CACHE.get(storePath);
  if (cached && isSessionStoreCacheValid(cached)) {
    if (getFileMtimeMs(storePath) === cached.mtimeMs) return cached.store;
    invalidateSessionStoreCache(storePath);
  }
  const { store, mtimeMs } = readSessionStoreFromDisk(storePath);
  // Frozen so the snapshot can be shared with read-only callers without a
  // copy; any accidental write through it throws instead of corrupting it.
  deepFreeze(store);
  SESSION_STORE_CACHE.set(storePath, { store, loadedAt: Date.now(), storePath, mtimeMs });
  return store;
}

/**
 * Load the session store for mutation: returns a private deep copy the caller
 * may change and pass to a save. Read-only callers should use
 * {@link loadSessionStoreReadonly} instead — on a busy gateway the store is
 * many MB and polled every few seconds, so a copy per read was the dominant
 * source of garbage (GBs/min) and of the RSS high-water mark.
 */
export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  if (!opts.skipCache) {
    const snapshot = getCachedSessionStoreSnapshot(storePath);
    if (snapshot) return structuredClone(snapshot) as Record<string, SessionEntry>;
  }
  // Cache disabled/skipped: a fresh parse that nothing else holds.
  return readSessionStoreFromDisk(storePath).store;
}

/**
 * Read-only view of the session store. Shares the cached snapshot (no copy);
 * the returned object and every entry in it are frozen. Use for lookups,
 * listings and summaries; use {@link loadSessionStore} to modify.
 */
export function loadSessionStoreReadonly(
  storePath: string,
): Readonly<Record<string, Readonly<SessionEntry>>> {
  return getCachedSessionStoreSnapshot(storePath) ?? readSessionStoreFromDisk(storePath).store;
}

export function readSessionUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
}): number | undefined {
  try {
    const store = loadSessionStoreReadonly(params.storePath);
    return store[params.sessionKey]?.updatedAt;
  } catch {
    return undefined;
  }
}

async function saveSessionStoreUnlocked(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  // Invalidate cache on write to ensure consistency
  invalidateSessionStoreCache(storePath);

  normalizeSessionStore(store);

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const json = JSON.stringify(store, null, 2);

  // Windows: avoid atomic rename swaps (can be flaky under concurrent access).
  // We serialize writers via the session-store lock instead.
  if (process.platform === "win32") {
    try {
      await fs.promises.writeFile(storePath, json, "utf-8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") return;
      throw err;
    }
    return;
  }

  const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
    await fs.promises.rename(tmp, storePath);
    // Ensure permissions are set even if rename loses them
    await fs.promises.chmod(storePath, 0o600);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : null;

    if (code === "ENOENT") {
      // In tests the temp session-store directory may be deleted while writes are in-flight.
      // Best-effort: try a direct write (recreating the parent dir), otherwise ignore.
      try {
        await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
        await fs.promises.writeFile(storePath, json, { mode: 0o600, encoding: "utf-8" });
        await fs.promises.chmod(storePath, 0o600);
      } catch (err2) {
        const code2 =
          err2 && typeof err2 === "object" && "code" in err2
            ? String((err2 as { code?: unknown }).code)
            : null;
        if (code2 === "ENOENT") return;
        throw err2;
      }
      return;
    }

    throw err;
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await withSessionStoreLock(storePath, async () => {
    await saveSessionStoreUnlocked(storePath, store);
  });
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
): Promise<T> {
  return await withSessionStoreLock(storePath, async () => {
    // Always re-read inside the lock to avoid clobbering concurrent writers.
    const store = loadSessionStore(storePath, { skipCache: true });
    const result = await mutator(store);
    await saveSessionStoreUnlocked(storePath, store);
    return result;
  });
}

type SessionStoreLockOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
};

// In-process queue per store path. Without it every concurrent writer in the
// gateway polls the lock file on its own, and under load (many agents updating
// sessions at once) waiters hit the file-lock timeout even though the lock is
// held by this same process. Callers here take turns; the file lock then only
// arbitrates between processes.
const SESSION_STORE_LOCK_TAILS = new Map<string, Promise<void>>();

async function withSessionStoreLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  const key = path.resolve(storePath);
  const prev = SESSION_STORE_LOCK_TAILS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => mine);
  SESSION_STORE_LOCK_TAILS.set(key, tail);
  await prev;
  try {
    return await withSessionStoreFileLock(storePath, fn, opts);
  } finally {
    release();
    if (SESSION_STORE_LOCK_TAILS.get(key) === tail) SESSION_STORE_LOCK_TAILS.delete(key);
  }
}

async function withSessionStoreFileLock<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: SessionStoreLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 25;
  const staleMs = opts.staleMs ?? 30_000;
  const lockPath = `${storePath}.lock`;
  const startedAt = Date.now();

  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
          "utf-8",
        );
      } catch {
        // best-effort
      }
      await handle.close();
      break;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        // Store directory may be deleted/recreated in tests while writes are in-flight.
        // Best-effort: recreate the parent dir and retry until timeout.
        await fs.promises
          .mkdir(path.dirname(storePath), { recursive: true })
          .catch(() => undefined);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }
      if (code !== "EEXIST") throw err;

      const now = Date.now();
      if (now - startedAt > timeoutMs) {
        throw new Error(`timeout acquiring session store lock: ${lockPath}`);
      }

      // Best-effort stale lock eviction (e.g. crashed process).
      try {
        const st = await fs.promises.stat(lockPath);
        const ageMs = now - st.mtimeMs;
        if (ageMs > staleMs) {
          await fs.promises.unlink(lockPath);
          continue;
        }
      } catch {
        // ignore
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}

export async function updateSessionStoreEntry(params: {
  storePath: string;
  sessionKey: string;
  update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, update } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
    const existing = store[sessionKey];
    if (!existing) return null;
    const patch = await update(existing);
    if (!patch) return existing;
    const next = mergeSessionEntry(existing, patch);
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store);
    return next;
  });
}

export async function recordSessionMetaFromInbound(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { storePath, sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  return await updateSessionStore(storePath, (store) => {
    const existing = store[sessionKey];
    const patch = deriveSessionMetaPatch({
      ctx,
      sessionKey,
      existing,
      groupResolution: params.groupResolution,
    });
    if (!patch) return existing ?? null;
    if (!existing && !createIfMissing) return null;
    const next = mergeSessionEntry(existing, patch);
    store[sessionKey] = next;
    return next;
  });
}

export async function updateLastRoute(params: {
  storePath: string;
  sessionKey: string;
  channel?: SessionEntry["lastChannel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
}) {
  const { storePath, sessionKey, channel, to, accountId, threadId, ctx } = params;
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath);
    const existing = store[sessionKey];
    const now = Date.now();
    const explicitContext = normalizeDeliveryContext(params.deliveryContext);
    const inlineContext = normalizeDeliveryContext({
      channel,
      to,
      accountId,
      threadId,
    });
    const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
    const merged = mergeDeliveryContext(mergedInput, deliveryContextFromSession(existing));
    const normalized = normalizeSessionDeliveryFields({
      deliveryContext: {
        channel: merged?.channel,
        to: merged?.to,
        accountId: merged?.accountId,
        threadId: merged?.threadId,
      },
    });
    const metaPatch = ctx
      ? deriveSessionMetaPatch({
          ctx,
          sessionKey,
          existing,
          groupResolution: params.groupResolution,
        })
      : null;
    const basePatch: Partial<SessionEntry> = {
      updatedAt: Math.max(existing?.updatedAt ?? 0, now),
      deliveryContext: normalized.deliveryContext,
      lastChannel: normalized.lastChannel,
      lastTo: normalized.lastTo,
      lastAccountId: normalized.lastAccountId,
      lastThreadId: normalized.lastThreadId,
    };
    const next = mergeSessionEntry(
      existing,
      metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
    );
    store[sessionKey] = next;
    await saveSessionStoreUnlocked(storePath, store);
    return next;
  });
}
