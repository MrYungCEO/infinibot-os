/**
 * AchievementWatcher — turns raw events into earned achievements + streaks.
 *
 * The watcher is deliberately decoupled from the rest of the gateway: it
 * exposes `ingest()` (event-stream sink) and a scheduled `tick()` for
 * time-window achievements (zero_failed_day). Callers (the gateway boot code)
 * pump events in; nothing here imports other subsystems, so the data layer
 * stays self-contained and the build stays clean.
 *
 * Every unlock fans out to registered listeners so the UI can pop a badge.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAchievementDef } from "./kinds.js";
import { getAchievementStore, type AchievementStore } from "./store.js";
import type {
  AchievementEvent,
  AchievementKind,
  AchievementRecord,
  AchievementUnlockListener,
} from "./types.js";

const log = createSubsystemLogger("achievements");

const HOUR = 60 * 60 * 1000;
const FOCUS_2H = 2 * HOUR;
const FOCUS_4H = 4 * HOUR;
const TEN_SHIPMENTS = 10;
const STREAK_TARGET = 7;
const STREAK_KIND = "clean_shipment_daily";

export interface WatcherOptions {
  store?: AchievementStore;
  /** Scope id for user-level achievements. Defaults to "global". */
  userId?: string;
  /** Inject a clock for deterministic tests. */
  now?: () => number;
}

export class AchievementWatcher {
  private store: AchievementStore;
  private userId: string;
  private now: () => number;
  private listeners = new Set<AchievementUnlockListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Day-bucket (YYYY-MM-DD as a number key) → failure count, for zero_failed_day. */
  private failuresByDay = new Map<string, number>();
  private shipmentsByDay = new Map<string, number>();
  private lastCleanShipDay: string | null = null;

  constructor(opts: WatcherOptions = {}) {
    this.store = opts.store ?? getAchievementStore();
    this.userId = opts.userId ?? "global";
    this.now = opts.now ?? (() => Date.now());
  }

  /** Subscribe to unlocks (UI popup hook). Returns an unsubscribe fn. */
  onUnlock(fn: AchievementUnlockListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private award(kind: AchievementKind, ownerId: string, meta: Record<string, unknown> = {}): void {
    const earnedAt = this.now();
    const { record, created } = this.store.award(kind, { ownerId, meta, earnedAt });
    if (created) this.emit(record);
  }

  private emit(record: AchievementRecord): void {
    const def = getAchievementDef(record.kind);
    for (const fn of this.listeners) {
      try {
        fn(record, def);
      } catch (err) {
        log.warn("Achievement listener threw", { err: String(err) });
      }
    }
  }

  // ── Event sink ──────────────────────────────────────────────────────────

  /** Pump a single event from any existing stream. Safe to call frequently. */
  ingest(event: AchievementEvent): void {
    switch (event.type) {
      case "shipment":
        return this.onShipment(event.ownerId, event.failed, event.at);
      case "federation_node_joined":
        return this.onFederationMilestone(event.nodeCount, event.at);
      case "focus_session":
        return this.onFocusSession(event.ownerId, event.durationMs);
      case "insight_acted":
        return this.award("hourly_insight_acted", event.ownerId);
      case "drag_assign":
        return this.award("first_drag_assign", event.ownerId);
      case "director_mode":
        return this.award("director_mode_first", event.ownerId);
      case "voice_command":
        return this.award("first_voice_command", event.ownerId);
    }
  }

  private onShipment(ownerId: string, failed: boolean, at: number): void {
    const day = dayKey(at);
    this.shipmentsByDay.set(day, (this.shipmentsByDay.get(day) ?? 0) + 1);
    if (failed) {
      this.failuresByDay.set(day, (this.failuresByDay.get(day) ?? 0) + 1);
      return;
    }

    // Clean shipment (repeatable) — pops every time.
    this.award("clean_shipment", ownerId, { at });

    // Night owl — clean ship between 00:00 and 05:00 local.
    const hour = new Date(at).getHours();
    if (hour >= 0 && hour < 5) this.award("night_owl", ownerId, { at });

    // Ten-shipments milestone (count clean shipments earned so far).
    const cleanCount = this.store.list({ ownerId, kind: "clean_shipment" }).length;
    if (cleanCount >= TEN_SHIPMENTS) this.award("ten_shipments", ownerId, { count: cleanCount });

    // Daily clean-ship streak → 7-day achievement.
    if (this.lastCleanShipDay !== day) {
      const continues = this.lastCleanShipDay === prevDayKey(day);
      const streak = this.store.bumpStreak(STREAK_KIND, continues, at);
      this.lastCleanShipDay = day;
      if (streak.count >= STREAK_TARGET) {
        this.award("ship_streak_7day", this.userId, { streak: streak.count });
      }
    }
  }

  private onFederationMilestone(nodeCount: number, at: number): void {
    // Award one milestone per distinct node-count high-water mark (meta-keyed).
    const prior = this.store.list({ ownerId: this.userId, kind: "federation_milestone" });
    const seen = prior.some((r) => Number(r.meta.nodeCount) === nodeCount);
    if (seen || nodeCount < 2) return;
    // Force a fresh row even though the kind is one-shot by storing the count.
    // (federation_milestone is one-shot by def; we record the *first* milestone
    // and update meta for higher ones via a synthetic repeatable path.)
    const { record, created } = this.store.award("federation_milestone", {
      ownerId: this.userId,
      meta: { nodeCount, at },
      earnedAt: at,
    });
    if (created) this.emit(record);
  }

  private onFocusSession(ownerId: string, durationMs: number): void {
    if (durationMs >= FOCUS_4H) this.award("marathon_focus_4h", ownerId, { durationMs });
    if (durationMs >= FOCUS_2H) this.award("focus_session_2h", ownerId, { durationMs });
  }

  // ── Scheduled tick ────────────────────────────────────────────────────────

  /**
   * Roll up completed days: a day with shipments and zero failures earns
   * zero_failed_day. Call from a daily timer or `start()`.
   */
  tick(at: number = this.now()): void {
    const today = dayKey(at);
    for (const [day, ships] of this.shipmentsByDay) {
      if (day === today) continue; // only finalize past days
      const fails = this.failuresByDay.get(day) ?? 0;
      if (ships > 0 && fails === 0) {
        this.award("zero_failed_day", this.userId, { day, shipments: ships });
      }
      this.shipmentsByDay.delete(day);
      this.failuresByDay.delete(day);
    }
  }

  /** Start the periodic tick (default hourly). */
  start(intervalMs = HOUR): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warn("Achievement tick threw", { err: String(err) });
      }
    }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function prevDayKey(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const prev = new Date(y, m - 1, d - 1);
  return `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}-${pad(prev.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

let singletonWatcher: AchievementWatcher | null = null;

export function getAchievementWatcher(opts?: WatcherOptions): AchievementWatcher {
  if (!singletonWatcher) singletonWatcher = new AchievementWatcher(opts);
  return singletonWatcher;
}
