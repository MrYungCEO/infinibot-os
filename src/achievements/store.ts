/**
 * Achievements + streaks — SQLite-backed data layer.
 *
 * Two tables:
 *   achievements(id, kind, agent_or_user_id, earned_at, meta_json)
 *   streaks(id, kind, count, started_at, last_at)
 *
 * The store is intentionally dumb persistence — qualifying-event detection
 * lives in {@link AchievementWatcher}. A process-wide singleton is exposed via
 * {@link getAchievementStore} (mirrors the ssh-devices / vault store pattern).
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDir } from "../config/paths.js";
import { getAchievementDef } from "./kinds.js";
import type {
  AchievementKind,
  AchievementRecord,
  StreakRecord,
  XpRecord,
  QuestRecord,
} from "./types.js";

const log = createSubsystemLogger("achievements");

interface AchievementRow {
  id: string;
  kind: string;
  agent_or_user_id: string;
  earned_at: number;
  meta_json: string | null;
}

interface StreakRow {
  id: string;
  kind: string;
  count: number;
  started_at: number;
  last_at: number;
}

export interface AwardOptions {
  ownerId: string;
  meta?: Record<string, unknown>;
  earnedAt?: number;
  /**
   * When the kind is not repeatable, awarding is a no-op if (kind, ownerId)
   * already exists — `award` returns the existing record and `created=false`.
   */
}

export interface AwardResult {
  record: AchievementRecord;
  created: boolean;
}

export class AchievementStore {
  private db: Database.Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "achievements.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();

    const count = (this.db.prepare("SELECT COUNT(*) AS c FROM achievements").get() as { c: number })
      .c;
    log.info("Achievement store loaded", { earned: count });
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS achievements (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        agent_or_user_id TEXT NOT NULL,
        earned_at INTEGER NOT NULL,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ach_kind ON achievements(kind);
      CREATE INDEX IF NOT EXISTS idx_ach_owner ON achievements(agent_or_user_id);
      CREATE INDEX IF NOT EXISTS idx_ach_earned ON achievements(earned_at);

      CREATE TABLE IF NOT EXISTS streaks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_streak_kind ON streaks(kind);

      -- === gamification: phase 1/2 ===
      -- Per-owner XP ledger. owner_id is an agent id, user id, or "global".
      CREATE TABLE IF NOT EXISTS agent_xp (
        owner_id TEXT PRIMARY KEY,
        xp INTEGER NOT NULL DEFAULT 0,
        tasks INTEGER NOT NULL DEFAULT 0,
        tools INTEGER NOT NULL DEFAULT 0,
        handshakes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_xp_value ON agent_xp(xp DESC);

      -- Time-bounded quests (phase 2). period_key buckets dailies/weeklies so a
      -- new period spawns a fresh row. progress is server-computed, never trusted.
      CREATE TABLE IF NOT EXISTS quests (
        id TEXT PRIMARY KEY,
        def_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        period_key TEXT NOT NULL,
        target INTEGER NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        reward_xp INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_quest_unique ON quests(def_kind, owner_id, period_key);
      CREATE INDEX IF NOT EXISTS idx_quest_owner ON quests(owner_id);
    `);
  }

  // ── XP ledger (gamification) ────────────────────────────────────────────────

  /** Add XP to an owner and bump the matching activity counter. Returns the new total. */
  addXp(
    ownerId: string,
    amount: number,
    source: "task" | "tool" | "handshake" | "bonus" = "task",
    at: number = Date.now(),
  ): XpRecord {
    const col =
      source === "task"
        ? "tasks"
        : source === "tool"
          ? "tools"
          : source === "handshake"
            ? "handshakes"
            : null;
    const existing = this.db.prepare("SELECT * FROM agent_xp WHERE owner_id = ?").get(ownerId) as
      | XpRow
      | undefined;
    if (!existing) {
      const row: XpRow = {
        owner_id: ownerId,
        xp: Math.max(0, Math.round(amount)),
        tasks: source === "task" ? 1 : 0,
        tools: source === "tool" ? 1 : 0,
        handshakes: source === "handshake" ? 1 : 0,
        updated_at: at,
      };
      this.db
        .prepare(
          "INSERT INTO agent_xp (owner_id, xp, tasks, tools, handshakes, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(row.owner_id, row.xp, row.tasks, row.tools, row.handshakes, row.updated_at);
      return rowToXp(row);
    }
    const inc = col ? `, ${col} = ${col} + 1` : "";
    this.db
      .prepare(`UPDATE agent_xp SET xp = xp + ?${inc}, updated_at = ? WHERE owner_id = ?`)
      .run(Math.round(amount), at, ownerId);
    const updated = this.db
      .prepare("SELECT * FROM agent_xp WHERE owner_id = ?")
      .get(ownerId) as XpRow;
    return rowToXp(updated);
  }

  getXp(ownerId: string): XpRecord {
    const row = this.db.prepare("SELECT * FROM agent_xp WHERE owner_id = ?").get(ownerId) as
      | XpRow
      | undefined;
    return row ? rowToXp(row) : { ownerId, xp: 0, tasks: 0, tools: 0, handshakes: 0, updatedAt: 0 };
  }

  /** Top owners by XP — powers the leaderboard. Excludes the "global" bucket. */
  listXpLeaderboard(limit = 20): XpRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM agent_xp WHERE owner_id != 'global' ORDER BY xp DESC LIMIT ?")
        .all(Math.max(1, Math.floor(limit))) as XpRow[]
    ).map(rowToXp);
  }

  // ── Quests (gamification phase 2) ────────────────────────────────────────────

  /** Upsert a quest for the current period; returns the (possibly fresh) row. */
  ensureQuest(opts: {
    defKind: string;
    ownerId: string;
    periodKey: string;
    target: number;
    rewardXp: number;
    at?: number;
  }): QuestRecord {
    const at = opts.at ?? Date.now();
    const existing = this.db
      .prepare("SELECT * FROM quests WHERE def_kind = ? AND owner_id = ? AND period_key = ?")
      .get(opts.defKind, opts.ownerId, opts.periodKey) as QuestRow | undefined;
    if (existing) return rowToQuest(existing);
    const row: QuestRow = {
      id: randomUUID(),
      def_kind: opts.defKind,
      owner_id: opts.ownerId,
      period_key: opts.periodKey,
      target: opts.target,
      progress: 0,
      reward_xp: opts.rewardXp,
      created_at: at,
      completed_at: null,
    };
    this.db
      .prepare(
        "INSERT INTO quests (id, def_kind, owner_id, period_key, target, progress, reward_xp, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.def_kind,
        row.owner_id,
        row.period_key,
        row.target,
        row.progress,
        row.reward_xp,
        row.created_at,
        row.completed_at,
      );
    return rowToQuest(row);
  }

  /**
   * Advance a quest's progress. Returns the updated record + a `justCompleted`
   * flag (true exactly once, when progress first crosses target).
   */
  advanceQuest(
    defKind: string,
    ownerId: string,
    periodKey: string,
    by = 1,
    at: number = Date.now(),
  ): { quest: QuestRecord; justCompleted: boolean } | null {
    const row = this.db
      .prepare("SELECT * FROM quests WHERE def_kind = ? AND owner_id = ? AND period_key = ?")
      .get(defKind, ownerId, periodKey) as QuestRow | undefined;
    if (!row) return null;
    const wasComplete = row.completed_at != null;
    const progress = Math.min(row.target, row.progress + by);
    const nowComplete = progress >= row.target;
    const completedAt = nowComplete ? (row.completed_at ?? at) : null;
    this.db
      .prepare("UPDATE quests SET progress = ?, completed_at = ? WHERE id = ?")
      .run(progress, completedAt, row.id);
    return {
      quest: rowToQuest({ ...row, progress, completed_at: completedAt }),
      justCompleted: nowComplete && !wasComplete,
    };
  }

  listQuests(ownerId: string, periodKey?: string): QuestRecord[] {
    const sql = periodKey
      ? "SELECT * FROM quests WHERE owner_id = ? AND period_key = ? ORDER BY created_at DESC"
      : "SELECT * FROM quests WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50";
    const params = periodKey ? [ownerId, periodKey] : [ownerId];
    return (this.db.prepare(sql).all(...params) as QuestRow[]).map(rowToQuest);
  }

  // ── Achievements ──────────────────────────────────────────────────────────

  /**
   * Award an achievement. Idempotent for non-repeatable kinds: a second award
   * for the same (kind, ownerId) returns the existing row with created=false.
   */
  award(kind: AchievementKind, opts: AwardOptions): AwardResult {
    const def = getAchievementDef(kind);
    const earnedAt = opts.earnedAt ?? Date.now();

    if (!def.repeatable) {
      const existing = this.db
        .prepare("SELECT * FROM achievements WHERE kind = ? AND agent_or_user_id = ? LIMIT 1")
        .get(kind, opts.ownerId) as AchievementRow | undefined;
      if (existing) return { record: rowToRecord(existing), created: false };
    }

    const record: AchievementRecord = {
      id: randomUUID(),
      kind,
      ownerId: opts.ownerId,
      earnedAt,
      meta: opts.meta ?? {},
    };
    this.db
      .prepare(
        "INSERT INTO achievements (id, kind, agent_or_user_id, earned_at, meta_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(record.id, record.kind, record.ownerId, record.earnedAt, JSON.stringify(record.meta));

    log.info("Achievement unlocked", { kind, ownerId: opts.ownerId });
    return { record, created: true };
  }

  /** True if (kind, ownerId) has ever been earned. */
  hasEarned(kind: AchievementKind, ownerId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM achievements WHERE kind = ? AND agent_or_user_id = ? LIMIT 1")
      .get(kind, ownerId);
    return !!row;
  }

  list(
    opts: { ownerId?: string; kind?: AchievementKind; limit?: number } = {},
  ): AchievementRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.ownerId) {
      where.push("agent_or_user_id = ?");
      params.push(opts.ownerId);
    }
    if (opts.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    const sql =
      "SELECT * FROM achievements" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY earned_at DESC" +
      (opts.limit ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : "");
    return (this.db.prepare(sql).all(...params) as AchievementRow[]).map(rowToRecord);
  }

  // ── Streaks ───────────────────────────────────────────────────────────────

  getStreak(kind: string): StreakRecord | undefined {
    const row = this.db.prepare("SELECT * FROM streaks WHERE kind = ?").get(kind) as
      | StreakRow
      | undefined;
    return row ? rowToStreak(row) : undefined;
  }

  /**
   * Advance a streak. `continues` decides whether the existing run extends
   * (count+1) or resets to 1. Returns the updated streak.
   */
  bumpStreak(kind: string, continues: boolean, at: number = Date.now()): StreakRecord {
    const existing = this.getStreak(kind);
    if (!existing) {
      const fresh: StreakRecord = { id: randomUUID(), kind, count: 1, startedAt: at, lastAt: at };
      this.db
        .prepare(
          "INSERT INTO streaks (id, kind, count, started_at, last_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(fresh.id, fresh.kind, fresh.count, fresh.startedAt, fresh.lastAt);
      return fresh;
    }
    const count = continues ? existing.count + 1 : 1;
    const startedAt = continues ? existing.startedAt : at;
    this.db
      .prepare("UPDATE streaks SET count = ?, started_at = ?, last_at = ? WHERE kind = ?")
      .run(count, startedAt, at, kind);
    return { ...existing, count, startedAt, lastAt: at };
  }

  resetStreak(kind: string): void {
    this.db.prepare("DELETE FROM streaks WHERE kind = ?").run(kind);
  }

  listStreaks(): StreakRecord[] {
    return (this.db.prepare("SELECT * FROM streaks ORDER BY count DESC").all() as StreakRow[]).map(
      rowToStreak,
    );
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

function rowToRecord(row: AchievementRow): AchievementRecord {
  let meta: Record<string, unknown> = {};
  if (row.meta_json) {
    try {
      meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }
  return {
    id: row.id,
    kind: row.kind as AchievementKind,
    ownerId: row.agent_or_user_id,
    earnedAt: row.earned_at,
    meta,
  };
}

function rowToStreak(row: StreakRow): StreakRecord {
  return {
    id: row.id,
    kind: row.kind,
    count: row.count,
    startedAt: row.started_at,
    lastAt: row.last_at,
  };
}

// === gamification: phase 1/2 ===

interface XpRow {
  owner_id: string;
  xp: number;
  tasks: number;
  tools: number;
  handshakes: number;
  updated_at: number;
}

interface QuestRow {
  id: string;
  def_kind: string;
  owner_id: string;
  period_key: string;
  target: number;
  progress: number;
  reward_xp: number;
  created_at: number;
  completed_at: number | null;
}

function rowToXp(row: XpRow): XpRecord {
  return {
    ownerId: row.owner_id,
    xp: row.xp,
    tasks: row.tasks,
    tools: row.tools,
    handshakes: row.handshakes,
    updatedAt: row.updated_at,
  };
}

function rowToQuest(row: QuestRow): QuestRecord {
  return {
    id: row.id,
    defKind: row.def_kind,
    ownerId: row.owner_id,
    periodKey: row.period_key,
    target: row.target,
    progress: row.progress,
    rewardXp: row.reward_xp,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

// ── Singleton ───────────────────────────────────────────────────────────────

let singleton: AchievementStore | null = null;

export function getAchievementStore(stateDir?: string): AchievementStore {
  if (!singleton) {
    singleton = new AchievementStore(stateDir ?? resolveStateDir());
  }
  return singleton;
}

/** Test/teardown helper. */
export function closeAchievementStore(): void {
  singleton?.close();
  singleton = null;
}
