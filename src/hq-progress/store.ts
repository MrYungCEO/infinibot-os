/**
 * Business HQ progress log — the persisted record behind the dashboard's
 * "done today / streak / cleared this week / before→after" strip.
 *
 * Every number the dashboard shows as progress is derived from this log, and
 * the log only ever receives REAL state changes: a kanban task moving to done,
 * a decision being Decided, a risk being mitigated/closed, a commitment being
 * settled. Entries are written server-side from the update handlers (so a
 * completion made on the board, by an agent tool or from the dashboard all
 * count once), de-duplicated per object per day, and removed again when the
 * object is reopened the same day — so the count cannot be farmed.
 *
 * The file also carries the owner's dashboard settings (daily target, the
 * business parent project, snoozed items) and one metric snapshot per day
 * (first + latest), which is what the before→after deltas compare.
 *
 * Storage: `<stateDir>/hq-progress.json` (per user when profiles namespace the
 * state dir). Small, bounded, rewritten atomically.
 *
 * Bulk completions: an event whose origin is a script/automation (the
 * `source: "bulk" | "automation"` param on kanban.tasks.update), or that is
 * part of a burst of more than HQ_BULK_BURST_THRESHOLD completions from one
 * connection within HQ_BULK_BURST_WINDOW_MS, is still written to the log (so
 * it stays auditable) but carries `bulk: true` and is excluded from every
 * derived progress figure (done today, streak, cleared this week). One-off
 * corrections for past bulk runs live in ./bulk-correction.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type HqProgressKind =
  | "task.done"
  | "decision.decided"
  | "risk.resolved"
  | "commitment.settled";

export interface HqProgressEvent {
  id: string;
  /** Unix ms the state change was recorded. */
  at: number;
  kind: HqProgressKind;
  objectId: string;
  title: string;
  /** Where the change came from (kanban | decision | risk | commitment). */
  source: string;
  /** Who made the change, when the caller said so (RPC `source` param). */
  origin?: HqProgressOrigin;
  /**
   * Bulk/scripted completion: kept for audit, excluded from every progress
   * figure (today, streak, week). See isCountedHqEvent().
   */
  bulk?: boolean;
  /** Why the event is bulk: caller-declared origin, burst heuristic, or a boot correction. */
  bulkReason?: "origin" | "burst" | "correction";
}

/**
 * Who completed something. `user` / `agent` count normally; `bulk` /
 * `automation` are recorded but never counted as progress.
 */
export const HQ_PROGRESS_ORIGINS = ["user", "agent", "bulk", "automation"] as const;
export type HqProgressOrigin = (typeof HQ_PROGRESS_ORIGINS)[number];
const BULK_ORIGINS: ReadonlySet<string> = new Set<HqProgressOrigin>(["bulk", "automation"]);

/**
 * Validate the optional `source` param of task-complete RPCs. Omitted/null →
 * `{ ok: true, origin: undefined }` (a normal completion); anything that isn't
 * one of HQ_PROGRESS_ORIGINS is rejected.
 */
export function parseHqProgressOrigin(
  value: unknown,
): { ok: true; origin: HqProgressOrigin | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, origin: undefined };
  if (typeof value === "string" && (HQ_PROGRESS_ORIGINS as readonly string[]).includes(value)) {
    return { ok: true, origin: value as HqProgressOrigin };
  }
  return {
    ok: false,
    error: `source must be one of ${HQ_PROGRESS_ORIGINS.join(" | ")}`,
  };
}

/** True when the event counts toward progress (i.e. it isn't bulk). */
export function isCountedHqEvent(e: Pick<HqProgressEvent, "bulk">): boolean {
  return e.bulk !== true;
}

/**
 * Burst heuristic: more than THRESHOLD task completions from the same
 * connection inside WINDOW ms marks the whole burst (retroactively including
 * the first THRESHOLD events) as bulk.
 */
export const HQ_BULK_BURST_THRESHOLD = 20;
export const HQ_BULK_BURST_WINDOW_MS = 60_000;

/** Marker for a one-off bulk correction applied to the log (see bulk-correction.ts). */
export interface HqCorrectionMarker {
  file: string;
  sha256: string;
  ids: number;
  matched: number;
  marked: number;
  appliedAt: number;
}

export type HqMetrics = Record<string, number>;

export interface HqSnapshotPair {
  first: { at: number; metrics: HqMetrics };
  last: { at: number; metrics: HqMetrics };
}

export interface HqSettings {
  /** Completions per day the owner is aiming for. */
  dailyTarget: number;
  /** Kanban project that parents the business object boards; null = auto-detect. */
  parentProjectId: string | null;
  /** objectId → unix ms until which the item is hidden from Today's Focus. */
  snoozes: Record<string, number>;
}

export interface HqProgressFile {
  version: 1;
  settings: HqSettings;
  events: HqProgressEvent[];
  /** Local-date key (YYYY-MM-DD, as sent by the client) → first/last metrics. */
  snapshots: Record<string, HqSnapshotPair>;
  /** Applied one-off bulk corrections, keyed by task-id-set hash. */
  corrections?: Record<string, HqCorrectionMarker>;
}

export interface HqProgressStoreOptions {
  /** Clock used when a record has no explicit `at` (injectable for tests). */
  now?: () => number;
  burstThreshold?: number;
  burstWindowMs?: number;
}

export interface HqRecordInput extends Omit<HqProgressEvent, "id" | "at" | "bulk" | "bulkReason"> {
  at?: number;
  /**
   * Identifies the caller (WS connId, "agent-tool", …) for the burst
   * heuristic. Not persisted. Omitted → no burst tracking.
   */
  connKey?: string;
}

export const DEFAULT_DAILY_TARGET = 5;
const MAX_EVENTS = 5000;
const MAX_SNAPSHOT_DAYS = 120;
const DAY_MS = 86_400_000;

function emptyFile(): HqProgressFile {
  return {
    version: 1,
    settings: { dailyTarget: DEFAULT_DAILY_TARGET, parentProjectId: null, snoozes: {} },
    events: [],
    snapshots: {},
  };
}

export class HqProgressStore {
  private cache: HqProgressFile | null = null;
  private readonly now: () => number;
  private readonly burstThreshold: number;
  private readonly burstWindowMs: number;
  /** connKey → recent task.done events (in-memory only; bursts are short). */
  private readonly bursts = new Map<string, Array<{ at: number; id: string }>>();

  constructor(
    readonly file: string,
    opts: HqProgressStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.burstThreshold = opts.burstThreshold ?? HQ_BULK_BURST_THRESHOLD;
    this.burstWindowMs = opts.burstWindowMs ?? HQ_BULK_BURST_WINDOW_MS;
  }

  read(): HqProgressFile {
    if (this.cache) return this.cache;
    let data = emptyFile();
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<HqProgressFile>;
        data = {
          version: 1,
          settings: { ...data.settings, ...raw.settings },
          events: Array.isArray(raw.events) ? raw.events : [],
          snapshots: raw.snapshots && typeof raw.snapshots === "object" ? raw.snapshots : {},
          ...(raw.corrections && typeof raw.corrections === "object"
            ? { corrections: raw.corrections }
            : {}),
        };
        if (!data.settings.snoozes || typeof data.settings.snoozes !== "object")
          data.settings.snoozes = {};
      }
    } catch {
      data = emptyFile();
    }
    this.cache = data;
    return data;
  }

  private write(data: HqProgressFile): void {
    this.cache = data;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }

  /**
   * Record a completion. Returns the stored event, or null when the same
   * object already counted within the last 24h (idempotent re-saves).
   *
   * Bulk origins are stored with `bulk: true`. For `task.done` events with a
   * `connKey`, a burst of more than `burstThreshold` completions within
   * `burstWindowMs` marks the new event AND the earlier events of the burst as
   * bulk (they were recorded as normal before the threshold tripped).
   */
  record(input: HqRecordInput): HqProgressEvent | null {
    const data = this.read();
    const at = input.at ?? this.now();
    const dup = data.events.some(
      (e) => e.kind === input.kind && e.objectId === input.objectId && at - e.at < DAY_MS,
    );
    if (dup) return null;
    const ev: HqProgressEvent = {
      id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at,
      kind: input.kind,
      objectId: input.objectId,
      title: (input.title || "Untitled").slice(0, 200),
      source: input.source,
    };
    if (input.origin) ev.origin = input.origin;
    if (input.origin && BULK_ORIGINS.has(input.origin)) {
      ev.bulk = true;
      ev.bulkReason = "origin";
    }
    data.events.push(ev);

    if (input.kind === "task.done" && input.connKey) {
      const burst = this.trackBurst(input.connKey, at, ev.id);
      if (burst) {
        const ids = new Set(burst);
        for (const e of data.events) {
          if (ids.has(e.id) && e.bulk !== true) {
            e.bulk = true;
            e.bulkReason = "burst";
          }
        }
      }
    }

    if (data.events.length > MAX_EVENTS) data.events.splice(0, data.events.length - MAX_EVENTS);
    this.write(data);
    return ev;
  }

  /** Returns the ids of the current burst when it is over the threshold. */
  private trackBurst(connKey: string, at: number, id: string): string[] | null {
    const cutoff = at - this.burstWindowMs;
    const recent = (this.bursts.get(connKey) ?? []).filter((r) => r.at > cutoff);
    recent.push({ at, id });
    this.bursts.set(connKey, recent);
    // Drop idle connections so the map stays bounded.
    if (this.bursts.size > 256) {
      for (const [k, list] of this.bursts) {
        if (!list.some((r) => r.at > cutoff)) this.bursts.delete(k);
      }
    }
    return recent.length > this.burstThreshold ? recent.map((r) => r.id) : null;
  }

  /**
   * One-off correction: mark every `task.done` event whose objectId is in
   * `ids` as bulk and record `marker` under `key`. Never deletes events.
   * Idempotent — a key that is already recorded is a no-op.
   */
  applyBulkCorrection(
    key: string,
    ids: ReadonlySet<string>,
    meta: { file: string; sha256: string },
  ): { applied: boolean; matched: number; marked: number } {
    const data = this.read();
    const prev = data.corrections?.[key];
    if (prev) return { applied: false, matched: prev.matched, marked: 0 };
    let matched = 0;
    let marked = 0;
    for (const e of data.events) {
      if (e.kind !== "task.done" || !ids.has(e.objectId)) continue;
      matched++;
      if (e.bulk === true) continue;
      e.bulk = true;
      e.bulkReason = "correction";
      marked++;
    }
    data.corrections = {
      ...data.corrections,
      [key]: {
        file: meta.file,
        sha256: meta.sha256,
        ids: ids.size,
        matched,
        marked,
        appliedAt: this.now(),
      },
    };
    this.write(data);
    return { applied: true, matched, marked };
  }

  /** Undo: the object was reopened, so a completion from the last 24h no longer counts. */
  unrecord(kind: HqProgressKind, objectId: string, now = this.now()): number {
    const data = this.read();
    const before = data.events.length;
    data.events = data.events.filter(
      (e) => !(e.kind === kind && e.objectId === objectId && now - e.at < DAY_MS),
    );
    const removed = before - data.events.length;
    if (removed) this.write(data);
    return removed;
  }

  /** Keep the first metrics of a day (the baseline) and the latest. */
  snapshot(day: string, metrics: HqMetrics, at = Date.now()): HqSnapshotPair {
    const data = this.read();
    const clean: HqMetrics = {};
    for (const [k, v] of Object.entries(metrics)) {
      if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
    }
    const cur = data.snapshots[day];
    const pair: HqSnapshotPair = cur
      ? { first: cur.first, last: { at, metrics: clean } }
      : { first: { at, metrics: clean }, last: { at, metrics: clean } };
    data.snapshots[day] = pair;
    const days = Object.keys(data.snapshots).sort();
    for (const d of days.slice(0, Math.max(0, days.length - MAX_SNAPSHOT_DAYS)))
      delete data.snapshots[d];
    this.write(data);
    return pair;
  }

  setSettings(patch: Partial<HqSettings>): HqSettings {
    const data = this.read();
    const next: HqSettings = { ...data.settings };
    if (patch.dailyTarget !== undefined) {
      const n = Math.round(Number(patch.dailyTarget));
      if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error("dailyTarget must be 1–100");
      next.dailyTarget = n;
    }
    if (patch.parentProjectId !== undefined) {
      next.parentProjectId = patch.parentProjectId ? String(patch.parentProjectId) : null;
    }
    if (patch.snoozes !== undefined) next.snoozes = { ...patch.snoozes };
    data.settings = next;
    this.write(data);
    return next;
  }

  snooze(objectId: string, until: number | null): HqSettings {
    const data = this.read();
    const snoozes = { ...data.settings.snoozes };
    const now = Date.now();
    // Drop expired entries while we're here.
    for (const [k, v] of Object.entries(snoozes)) if (v <= now) delete snoozes[k];
    if (until && until > now) snoozes[objectId] = until;
    else delete snoozes[objectId];
    return this.setSettings({ snoozes });
  }

  /** Events since `sinceMs` (default: last 60 days — enough for streaks + week). */
  get(sinceMs = Date.now() - 60 * DAY_MS): HqProgressFile {
    const data = this.read();
    return { ...data, events: data.events.filter((e) => e.at >= sinceMs) };
  }
}

let singleton: { dir: string; store: HqProgressStore } | null = null;

export function getHqProgressStore(): HqProgressStore {
  const dir = resolveStateDir();
  if (!singleton || singleton.dir !== dir) {
    singleton = { dir, store: new HqProgressStore(join(dir, "hq-progress.json")) };
  }
  return singleton.store;
}

/** Best-effort hook for update handlers — never throws into the caller. */
export function recordHqProgress(input: HqRecordInput): HqProgressEvent | null {
  try {
    return getHqProgressStore().record(input);
  } catch {
    return null;
  }
}

export function unrecordHqProgress(kind: HqProgressKind, objectId: string): void {
  try {
    getHqProgressStore().unrecord(kind, objectId);
  } catch {
    /* best effort */
  }
}

// ── Status classifiers shared by the handler hooks ───────────────────────────
export function isRiskResolvedStatus(status: unknown): boolean {
  return /^(mitigated|closed)$/i.test(String(status ?? "").trim());
}
export function isCommitmentSettledStatus(status: unknown): boolean {
  return /^paid$/i.test(String(status ?? "").trim());
}
export function isDecisionDecidedStatus(status: unknown): boolean {
  return /^decided$/i.test(String(status ?? "").trim());
}
