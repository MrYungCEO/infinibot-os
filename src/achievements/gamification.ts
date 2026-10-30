/**
 * Gamification engine — XP economy, levels/ranks, and time-bounded quests.
 *
 * Layered on top of the existing {@link AchievementStore} + {@link AchievementWatcher}
 * (achievements/streaks). This module owns the *new* mechanics from the Agent
 * Neural Mesh upgrade plan: agents earn XP for real work, derive a level/rank,
 * and chip away at daily/weekly quests. Everything here is server-authoritative —
 * the UI only ever reads computed state; it never writes XP or quest progress.
 *
 * Pure helpers (rank derivation, quest catalogue, period keys) have no I/O so the
 * UI can import a serialized copy. The {@link GamificationEngine} is the stateful
 * facade the gateway pumps real events into.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAchievementStore, type AchievementStore } from "./store.js";
import { getAchievementWatcher, type AchievementWatcher } from "./watcher.js";
import type { AchievementRecord, QuestDef, QuestKind, QuestRecord, XpRecord } from "./types.js";

const log = createSubsystemLogger("achievements").child("gamification");

// ── XP economy ────────────────────────────────────────────────────────────────

/** XP granted per qualifying event. Kept small + legible. */
export const XP_REWARDS = {
  task: 50,
  tool: 5,
  handshake: 100,
  cleanShipBonus: 25,
} as const;

// ── Levels & ranks ──────────────────────────────────────────────────────────

/** Cumulative XP needed to *reach* a level: 50·L². Level 1 = 0 XP floor. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return 50 * (level - 1) * (level - 1);
}

/** Highest level whose XP floor is satisfied. */
export function levelForXp(xp: number): number {
  if (xp <= 0) return 1;
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

export interface Rank {
  key: string;
  label: string;
  /** Colour ramp for the badge (matches TIER_COLORS vibe). */
  color: string;
  minLevel: number;
}

/** Six ranks. Derived purely from level so the UI can compute it too. */
export const RANKS: Rank[] = [
  { key: "recruit", label: "Recruit", color: "#8b95a7", minLevel: 1 },
  { key: "operator", label: "Operator", color: "#4ea8de", minLevel: 3 },
  { key: "specialist", label: "Specialist", color: "#39d98a", minLevel: 6 },
  { key: "veteran", label: "Veteran", color: "#d4af37", minLevel: 10 },
  { key: "elite", label: "Elite", color: "#ff8c42", minLevel: 15 },
  { key: "legend", label: "Legend", color: "#b06bff", minLevel: 25 },
];

export function rankForLevel(level: number): Rank {
  let rank = RANKS[0];
  for (const r of RANKS) if (level >= r.minLevel) rank = r;
  return rank;
}

/** Fully-derived progression snapshot for one owner. */
export interface Progression {
  ownerId: string;
  xp: number;
  level: number;
  rank: Rank;
  /** XP into the current level and XP needed for the next (for a progress ring). */
  xpIntoLevel: number;
  xpForNextLevel: number;
  tasks: number;
  tools: number;
  handshakes: number;
}

export function deriveProgression(rec: XpRecord): Progression {
  const level = levelForXp(rec.xp);
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return {
    ownerId: rec.ownerId,
    xp: rec.xp,
    level,
    rank: rankForLevel(level),
    xpIntoLevel: rec.xp - floor,
    xpForNextLevel: Math.max(1, next - floor),
    tasks: rec.tasks,
    tools: rec.tools,
    handshakes: rec.handshakes,
  };
}

// ── Quest catalogue (phase 2) ─────────────────────────────────────────────────

export const QUEST_DEFS: Record<QuestKind, QuestDef> = {
  daily_five_tasks: {
    kind: "daily_five_tasks",
    label: "Daily Driver",
    description: "Complete 5 tasks today.",
    icon: "✅",
    period: "daily",
    target: 5,
    rewardXp: 150,
    metric: "task",
  },
  daily_three_tools: {
    kind: "daily_three_tools",
    label: "Toolsmith",
    description: "Use 3 distinct MCP tools today.",
    icon: "🛠️",
    period: "daily",
    target: 3,
    rewardXp: 90,
    metric: "tool",
  },
  daily_clean_ship: {
    kind: "daily_clean_ship",
    label: "Clean Sweep",
    description: "Land a clean shipment today.",
    icon: "📦",
    period: "daily",
    target: 1,
    rewardXp: 120,
    metric: "clean_ship",
  },
  weekly_federation_call: {
    kind: "weekly_federation_call",
    label: "Reach Across",
    description: "Make a cross-node federation call this week.",
    icon: "🛰️",
    period: "weekly",
    target: 1,
    rewardXp: 250,
    metric: "handshake",
  },
  weekly_twenty_tasks: {
    kind: "weekly_twenty_tasks",
    label: "Workhorse",
    description: "Complete 20 tasks this week.",
    icon: "🐎",
    period: "weekly",
    target: 20,
    rewardXp: 400,
    metric: "task",
  },
};

export const ALL_QUEST_KINDS = Object.keys(QUEST_DEFS) as QuestKind[];

export function getQuestDef(kind: string): QuestDef | undefined {
  return QUEST_DEFS[kind as QuestKind];
}

// ── Period keys ───────────────────────────────────────────────────────────────

export function dailyKey(ts: number): string {
  const d = new Date(ts);
  return `D${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO-ish week bucket: year + zero-padded week number. */
export function weeklyKey(ts: number): string {
  const d = new Date(ts);
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
  return `W${d.getFullYear()}-${pad(week)}`;
}

function periodKeyFor(def: QuestDef, ts: number): string {
  return def.period === "daily" ? dailyKey(ts) : weeklyKey(ts);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// ── Events + listeners ──────────────────────────────────────────────────────

export type GamificationEvent =
  | { type: "xp"; record: XpRecord; delta: number; source: string }
  | { type: "quest_complete"; quest: QuestRecord; def: QuestDef }
  | { type: "level_up"; ownerId: string; level: number; rank: Rank };

export type GamificationListener = (event: GamificationEvent) => void;

// ── Engine ────────────────────────────────────────────────────────────────────

export interface GamificationEngineOptions {
  store?: AchievementStore;
  watcher?: AchievementWatcher;
  /** Scope id for user-level rollups. Defaults to "global". */
  userId?: string;
  now?: () => number;
}

export class GamificationEngine {
  private store: AchievementStore;
  private watcher: AchievementWatcher;
  private userId: string;
  private now: () => number;
  private listeners = new Set<GamificationListener>();
  /** owner → distinct tool names seen this daily period (for "3 distinct tools"). */
  private toolsSeen = new Map<string, Set<string>>();

  constructor(opts: GamificationEngineOptions = {}) {
    this.store = opts.store ?? getAchievementStore();
    this.watcher = opts.watcher ?? getAchievementWatcher();
    this.userId = opts.userId ?? "global";
    this.now = opts.now ?? (() => Date.now());
  }

  onEvent(fn: GamificationListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: GamificationEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (err) {
        log.warn("Gamification listener threw", { err: String(err) });
      }
    }
  }

  /** Idempotently materialize the current period's quests for an owner. */
  ensureQuestsFor(ownerId: string, at: number = this.now()): QuestRecord[] {
    const out: QuestRecord[] = [];
    for (const def of Object.values(QUEST_DEFS)) {
      out.push(
        this.store.ensureQuest({
          defKind: def.kind,
          ownerId,
          periodKey: periodKeyFor(def, at),
          target: def.target,
          rewardXp: def.rewardXp,
          at,
        }),
      );
    }
    return out;
  }

  private awardXp(
    ownerId: string,
    amount: number,
    source: "task" | "tool" | "handshake" | "bonus",
    at: number,
  ): XpRecord {
    const before = this.store.getXp(ownerId);
    const beforeLevel = levelForXp(before.xp);
    const rec = this.store.addXp(ownerId, amount, source, at);
    this.emit({ type: "xp", record: rec, delta: amount, source });
    const afterLevel = levelForXp(rec.xp);
    if (afterLevel > beforeLevel) {
      this.emit({ type: "level_up", ownerId, level: afterLevel, rank: rankForLevel(afterLevel) });
    }
    return rec;
  }

  /** Advance any quests matching a metric, awarding reward XP on completion. */
  private advanceQuests(ownerId: string, metric: QuestDef["metric"], at: number): void {
    for (const def of Object.values(QUEST_DEFS)) {
      if (def.metric !== metric) continue;
      const res = this.store.advanceQuest(def.kind, ownerId, periodKeyFor(def, at), 1, at);
      if (res?.justCompleted) {
        this.awardXp(ownerId, def.rewardXp, "bonus", at);
        this.emit({ type: "quest_complete", quest: res.quest, def });
        log.info("Quest complete", { kind: def.kind, ownerId });
      }
    }
  }

  // ── Public event hooks (called from the gateway's existing streams) ─────────

  /** A task/shipment completed. failed=false also feeds the achievement watcher. */
  recordTaskCompletion(ownerId: string, opts: { failed?: boolean } = {}): void {
    const at = this.now();
    this.ensureQuestsFor(ownerId, at);
    this.awardXp(ownerId, XP_REWARDS.task, "task", at);
    this.advanceQuests(ownerId, "task", at);
    if (!opts.failed) {
      this.awardXp(ownerId, XP_REWARDS.cleanShipBonus, "bonus", at);
      this.advanceQuests(ownerId, "clean_ship", at);
    }
    // Feed the existing achievement/streak watcher too.
    this.watcher.ingest({ type: "shipment", ownerId, failed: !!opts.failed, at });
  }

  /** An MCP tool was invoked. Distinct-tool dedupe per daily period for quests. */
  recordToolUse(ownerId: string, toolName: string): void {
    const at = this.now();
    this.ensureQuestsFor(ownerId, at);
    this.awardXp(ownerId, XP_REWARDS.tool, "tool", at);
    const bucket = `${ownerId}:${dailyKey(at)}`;
    let seen = this.toolsSeen.get(bucket);
    if (!seen) {
      seen = new Set();
      this.toolsSeen.set(bucket, seen);
    }
    if (!seen.has(toolName)) {
      seen.add(toolName);
      this.advanceQuests(ownerId, "tool", at);
    }
  }

  /** A cross-node federation call succeeded. */
  recordFederationHandshake(ownerId: string, nodeCount = 2): void {
    const at = this.now();
    this.ensureQuestsFor(ownerId, at);
    this.awardXp(ownerId, XP_REWARDS.handshake, "handshake", at);
    this.advanceQuests(ownerId, "handshake", at);
    this.watcher.ingest({ type: "federation_node_joined", nodeCount, at });
  }

  // ── Read API (powers the gateway RPCs) ──────────────────────────────────────

  getProgression(ownerId: string): Progression {
    return deriveProgression(this.store.getXp(ownerId));
  }

  getQuests(ownerId: string, at: number = this.now()): Array<QuestRecord & { def: QuestDef }> {
    this.ensureQuestsFor(ownerId, at);
    // Only current-period quests.
    const keys = new Set(Object.values(QUEST_DEFS).map((d) => periodKeyFor(d, at)));
    return this.store
      .listQuests(ownerId)
      .filter((q) => keys.has(q.periodKey) && getQuestDef(q.defKind))
      .map((q) => ({ ...q, def: getQuestDef(q.defKind)! }));
  }

  /** Local-node leaderboard (federation aggregation happens in the RPC layer). */
  getLeaderboard(limit = 20): Progression[] {
    return this.store.listXpLeaderboard(limit).map(deriveProgression);
  }

  recentUnlocks(limit = 10): AchievementRecord[] {
    return this.store.list({ limit });
  }
}

let singleton: GamificationEngine | null = null;

export function getGamificationEngine(opts?: GamificationEngineOptions): GamificationEngine {
  if (!singleton) singleton = new GamificationEngine(opts);
  return singleton;
}

/** Test/teardown helper. */
export function resetGamificationEngine(): void {
  singleton = null;
}
