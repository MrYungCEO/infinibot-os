/**
 * Kanban task write ledger — the local, versioned record of every task write
 * that the Notion-backed board must not undo.
 *
 * The board list is a read of Notion (slow, eventually consistent, cached).
 * A write is recorded here the moment it is accepted (persisted to disk, so a
 * gateway restart keeps it), gets a monotonically increasing `version`, and is
 * pushed to Notion asynchronously with retry. Every list read is merged
 * through `apply`:
 *
 *   entry not yet pushed            → local wins (row patched, syncPending)
 *   pushed, source row agrees       → entry retired; the source is truth again
 *   pushed, source row disagrees    → local wins while the source may still be
 *                                     lagging (`settleMs` after the push), unless
 *                                     the row was edited in a later minute than
 *                                     our push (a genuinely newer remote edit)
 *
 * So an older Notion pull or a cache refresh can never overwrite a newer local
 * change, and a newer remote edit still comes through.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { coerceString } from "../shared/text/coerce.js";

export type LedgerFields = Record<string, unknown>;

export interface LedgerEntry {
  id: string;
  fields: LedgerFields;
  version: number;
  /** When the (latest) write was accepted. */
  at: number;
  /** When the latest version reached the source (Notion); absent = pending. */
  pushedAt?: number;
  /** Version the last successful push carried. */
  pushedVersion?: number;
  attempts: number;
  /** The task was deleted: every list drops the row until the entry expires. */
  deleted?: boolean;
  lastError?: string;
  source?: string;
}

export interface ApplyResult<T> {
  rows: T[];
  /** Ids whose source row was newer than our write (entry retired, remote wins). */
  remoteNewer: string[];
}

export interface WriteLedgerOptions {
  now?: () => number;
  /** JSON file the ledger persists to; omit for in-memory (tests). */
  persistPath?: string;
  /** How long a pushed entry keeps winning over a disagreeing (lagging) source. */
  settleMs?: number;
  /** Pending entries older than this are dropped (never pushed). */
  maxPendingAgeMs?: number;
}

const MINUTE = 60_000;

export const normTaskId = (v: unknown): string =>
  typeof v === "string" ? v.replace(/-/g, "").toLowerCase() : "";

/** done is the boolean twin of status — compare them as one fact. */
function fieldAgrees(row: Record<string, unknown>, k: string, v: unknown): boolean {
  if (k === "done") return (row.done === true) === (v === true);
  if (v === null || v === undefined || v === "") {
    const r = row[k];
    return r === null || r === undefined || r === "";
  }
  return row[k] === v;
}

function rowAgrees(row: Record<string, unknown>, fields: LedgerFields): boolean {
  return Object.entries(fields).every(([k, v]) => fieldAgrees(row, k, v));
}

/** Notion's last_edited_time is truncated to the minute. */
function editedAfterMinuteOf(rowUpdatedAt: unknown, t: number): boolean {
  const u =
    typeof rowUpdatedAt === "number" ? rowUpdatedAt : Date.parse(coerceString(rowUpdatedAt));
  if (!Number.isFinite(u)) return false;
  return u >= Math.floor(t / MINUTE) * MINUTE + MINUTE;
}

export function createWriteLedger(opts: WriteLedgerOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const settleMs = opts.settleMs ?? 10 * MINUTE;
  const maxPendingAgeMs = opts.maxPendingAgeMs ?? 7 * 24 * 60 * MINUTE;
  const entries = new Map<string, LedgerEntry>();
  let versionSeq = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function load(): void {
    if (!opts.persistPath || !existsSync(opts.persistPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(opts.persistPath, "utf8")) as {
        version?: number;
        entries?: LedgerEntry[];
      };
      versionSeq = Math.max(versionSeq, Number(parsed.version) || 0);
      for (const e of parsed.entries ?? []) {
        if (e && typeof e.id === "string" && e.fields && typeof e.version === "number") {
          entries.set(normTaskId(e.id), e);
          versionSeq = Math.max(versionSeq, e.version);
        }
      }
    } catch {
      /* corrupt ledger — start empty rather than block the board */
    }
  }

  function saveNow(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!opts.persistPath) return;
    try {
      mkdirSync(dirname(opts.persistPath), { recursive: true });
      const tmp = `${opts.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: versionSeq, entries: [...entries.values()] }));
      renameSync(tmp, opts.persistPath);
    } catch {
      /* best-effort — the in-memory ledger still guards this process */
    }
  }

  function save(): void {
    if (!opts.persistPath || saveTimer) return;
    saveTimer = setTimeout(saveNow, 250);
    saveTimer.unref?.();
  }

  function prune(): void {
    const t = now();
    for (const [k, e] of entries) {
      const pushedCurrent = e.pushedVersion === e.version && e.pushedAt !== undefined;
      if (pushedCurrent && t - (e.pushedAt as number) > settleMs) entries.delete(k);
      else if (!pushedCurrent && t - e.at > maxPendingAgeMs) entries.delete(k);
    }
  }

  /**
   * Record an accepted write. Fields merge over a still-tracked entry for the
   * same task; the version always increases. `pushed: true` for writes that
   * already reached the source synchronously (agent tool / verifier).
   */
  function record(
    id: string,
    fields: LedgerFields,
    meta: { pushed?: boolean; source?: string } = {},
  ): LedgerEntry | null {
    const key = normTaskId(id);
    if (!key || Object.keys(fields).length === 0) return null;
    const t = now();
    const prev = entries.get(key);
    // A late write to a deleted task must not resurrect it.
    if (prev?.deleted) return null;
    versionSeq = Math.max(versionSeq + 1, t);
    const entry: LedgerEntry = {
      id,
      fields: { ...prev?.fields, ...fields },
      version: versionSeq,
      at: t,
      attempts: 0,
      ...(meta.source ? { source: meta.source } : {}),
    };
    if (meta.pushed) {
      entry.pushedAt = t;
      entry.pushedVersion = entry.version;
    }
    entries.set(key, entry);
    save();
    return entry;
  }

  /**
   * Record a delete that already reached the source. Lists drop the row for
   * `settleMs` (by then the source's query no longer returns it).
   */
  function tombstone(id: string, meta: { source?: string } = {}): LedgerEntry | null {
    const key = normTaskId(id);
    if (!key) return null;
    const t = now();
    versionSeq = Math.max(versionSeq + 1, t);
    const entry: LedgerEntry = {
      id,
      fields: {},
      version: versionSeq,
      at: t,
      pushedAt: t,
      pushedVersion: versionSeq,
      attempts: 0,
      deleted: true,
      ...(meta.source ? { source: meta.source } : {}),
    };
    entries.set(key, entry);
    save();
    return entry;
  }

  function get(id: string): LedgerEntry | undefined {
    return entries.get(normTaskId(id));
  }

  function markPushed(id: string, version: number): void {
    const e = entries.get(normTaskId(id));
    if (!e) return;
    // A newer write landed while this push was in flight — it still needs one.
    if (e.version !== version) return;
    e.pushedAt = now();
    e.pushedVersion = version;
    e.lastError = undefined;
    saveNow();
  }

  function markFailed(id: string, version: number, err: string): void {
    const e = entries.get(normTaskId(id));
    if (!e || e.version !== version) return;
    e.attempts += 1;
    e.lastError = err;
    save();
  }

  /** Entries whose latest version has not reached the source yet. */
  function pending(): LedgerEntry[] {
    prune();
    return [...entries.values()].filter((e) => e.pushedVersion !== e.version);
  }

  /**
   * Merge source rows (matched on `id` / `notionId`, dashes ignored) with the
   * ledger. `fromSource: false` for lists that are not a fresh source read
   * (they never retire entries).
   */
  function apply<T>(rows: T[], applyOpts: { fromSource?: boolean } = {}): ApplyResult<T> {
    const fromSource = applyOpts.fromSource !== false;
    if (!Array.isArray(rows) || entries.size === 0) return { rows, remoteNewer: [] };
    prune();
    const remoteNewer: string[] = [];
    let changed = false;
    let retired = false;
    const keyOf = (r: Record<string, unknown>) =>
      entries.has(normTaskId(r.id)) ? normTaskId(r.id) : normTaskId(r.notionId);
    // Deleted tasks: a list read before (or lagging behind) the delete must
    // not bring the row back.
    let source = rows;
    if ([...entries.values()].some((e) => e.deleted)) {
      const kept = rows.filter((row) => {
        if (!row || typeof row !== "object") return true;
        const k = keyOf(row as unknown as Record<string, unknown>);
        return !(k && entries.get(k)?.deleted);
      });
      if (kept.length !== rows.length) {
        source = kept;
        changed = true;
      }
    }
    const out = source.map((row) => {
      if (!row || typeof row !== "object") return row;
      const r = row as unknown as Record<string, unknown>;
      const key = keyOf(r);
      const e = key ? entries.get(key) : undefined;
      if (!e) return row;
      const pushedCurrent = e.pushedVersion === e.version && e.pushedAt !== undefined;
      if (rowAgrees(r, e.fields)) {
        if (fromSource && pushedCurrent) {
          entries.delete(key);
          retired = true;
        }
        // A cached row stamped by an earlier merge may still carry the
        // pending flag from before the push landed.
        const staleFlag = pushedCurrent && r.version === e.version && r.syncPending === true;
        if (r.version === e.version && !staleFlag) return row;
        changed = true;
        return { ...r, version: e.version, ...(staleFlag ? { syncPending: false } : {}) } as T;
      }
      if (fromSource && pushedCurrent && editedAfterMinuteOf(r.updatedAt, e.pushedAt as number)) {
        // Someone edited the row at the source after our write reached it.
        entries.delete(key);
        retired = true;
        remoteNewer.push(e.id);
        return row;
      }
      changed = true;
      return {
        ...r,
        ...e.fields,
        version: e.version,
        syncPending: !pushedCurrent,
      } as T;
    });
    if (retired) save();
    return { rows: changed ? out : rows, remoteNewer };
  }

  /** A version above every version handed out so far (remote updates). */
  function nextVersion(): number {
    versionSeq = Math.max(versionSeq + 1, now());
    save();
    return versionSeq;
  }

  load();

  return {
    record,
    tombstone,
    nextVersion,
    get,
    apply,
    pending,
    markPushed,
    markFailed,
    flush: saveNow,
    size: () => entries.size,
    clear: () => {
      entries.clear();
      saveNow();
    },
  };
}

export type WriteLedger = ReturnType<typeof createWriteLedger>;

/** Retry delays for a pending push; the last one repeats. */
export const PUSH_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000, 5 * 60_000];

/**
 * Push pending ledger entries to the source, one task at a time, retrying
 * failures with backoff. `kick(id)` pushes one task now (after a write);
 * `start()` resumes everything left pending by a previous process.
 */
export function createLedgerPusher(
  ledger: WriteLedger,
  push: (entry: LedgerEntry) => Promise<void>,
  opts: {
    delays?: number[];
    onPushed?: (entry: LedgerEntry) => void;
    onFailed?: (entry: LedgerEntry, err: string) => void;
  } = {},
) {
  const delays = opts.delays ?? PUSH_RETRY_DELAYS_MS;
  const running = new Map<string, Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  function schedule(key: string, id: string, delay: number): void {
    if (stopped || timers.has(key)) return;
    const t = setTimeout(() => {
      timers.delete(key);
      void kick(id);
    }, delay);
    t.unref?.();
    timers.set(key, t);
  }

  async function kick(id: string): Promise<void> {
    const key = normTaskId(id);
    const inFlight = running.get(key);
    if (inFlight) {
      // Push again once the in-flight one ends (a newer version may be waiting).
      await inFlight.catch(() => undefined);
      return kick(id);
    }
    const entry = ledger.get(id);
    if (!entry || entry.pushedVersion === entry.version) return;
    const version = entry.version;
    const snapshot = { ...entry, fields: { ...entry.fields } };
    const p = (async () => {
      try {
        await push(snapshot);
        ledger.markPushed(id, version);
        opts.onPushed?.(snapshot);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ledger.markFailed(id, version, msg);
        const cur = ledger.get(id);
        opts.onFailed?.(cur ?? snapshot, msg);
        const attempts = cur?.attempts ?? 1;
        schedule(key, id, delays[Math.min(attempts - 1, delays.length - 1)]);
      }
    })();
    running.set(key, p);
    try {
      await p;
    } finally {
      running.delete(key);
    }
    // A newer write arrived during the push.
    const after = ledger.get(id);
    if (after && after.version !== version && after.pushedVersion !== after.version) {
      return kick(id);
    }
  }

  return {
    kick,
    start(): void {
      for (const e of ledger.pending()) void kick(e.id);
    },
    stop(): void {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    /** Test hook: resolves when no push is running. */
    async idle(): Promise<void> {
      while (running.size)
        await Promise.all([...running.values()].map((p) => p.catch(() => undefined)));
    },
  };
}
