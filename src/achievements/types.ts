/**
 * Achievements + streaks — shared types for the data layer.
 *
 * These mirror the two sqlite tables backing the system:
 *   achievements(id, kind, agent_or_user_id, earned_at, meta_json)
 *   streaks(id, kind, count, started_at, last_at)
 *
 * The UI consumes a serialized {@link AchievementRecord} (via the gateway / window
 * state) — it never imports the sqlite store directly.
 */

/** Stable identifiers for every trackable achievement. */
export type AchievementKind =
  | "clean_shipment"
  | "federation_milestone"
  | "focus_session_2h"
  | "marathon_focus_4h"
  | "hourly_insight_acted"
  | "zero_failed_day"
  | "first_drag_assign"
  | "director_mode_first"
  | "first_voice_command"
  | "ten_shipments"
  | "ship_streak_7day"
  | "night_owl";

/** Visual tier — drives badge colour ramp in the UI. */
export type AchievementTier = "bronze" | "silver" | "gold" | "legendary";

/** Static metadata describing a kind (label, copy, icon, tier). */
export interface AchievementDef {
  kind: AchievementKind;
  label: string;
  description: string;
  /** Emoji glyph rendered on the badge. */
  icon: string;
  tier: AchievementTier;
  /**
   * Whether the same (kind, owner) can be earned more than once. Most are
   * one-shot; clean_shipment is repeatable so each clean ship pops a badge.
   */
  repeatable?: boolean;
}

/** A single earned-achievement row. */
export interface AchievementRecord {
  id: string;
  kind: AchievementKind;
  /** Agent id, user id, or "global" depending on the kind's scope. */
  ownerId: string;
  earnedAt: number;
  meta: Record<string, unknown>;
}

/** A running streak row (e.g. consecutive clean-shipment days). */
export interface StreakRecord {
  id: string;
  kind: string;
  count: number;
  startedAt: number;
  lastAt: number;
}

/** Events the watcher consumes to award achievements. */
export type AchievementEvent =
  | { type: "shipment"; ownerId: string; failed: boolean; at: number }
  | { type: "federation_node_joined"; nodeCount: number; at: number }
  | { type: "focus_session"; ownerId: string; durationMs: number; at: number }
  | { type: "insight_acted"; ownerId: string; at: number }
  | { type: "drag_assign"; ownerId: string; at: number }
  | { type: "director_mode"; ownerId: string; at: number }
  | { type: "voice_command"; ownerId: string; at: number };

/** Fired by the watcher whenever a new badge is unlocked (for UI popups). */
export type AchievementUnlockListener = (record: AchievementRecord, def: AchievementDef) => void;

// ── Gamification (phase 1/2): XP, levels, quests ─────────────────────────────

/** Per-owner XP ledger row. ownerId is an agent id, user id, or "global". */
export interface XpRecord {
  ownerId: string;
  xp: number;
  /** Lifetime activity counters that earned XP. */
  tasks: number;
  tools: number;
  handshakes: number;
  updatedAt: number;
}

/** Stable identifiers for the catalogue of time-bounded quests (phase 2). */
export type QuestKind =
  | "daily_five_tasks"
  | "daily_three_tools"
  | "daily_clean_ship"
  | "weekly_federation_call"
  | "weekly_twenty_tasks";

/** Quest cadence — drives the period bucket (calendar day vs ISO week). */
export type QuestPeriod = "daily" | "weekly";

/** Static metadata describing a quest kind. Pure data, shared with the UI. */
export interface QuestDef {
  kind: QuestKind;
  label: string;
  description: string;
  icon: string;
  period: QuestPeriod;
  /** How many qualifying events complete the quest. */
  target: number;
  /** XP granted to the owner on completion. */
  rewardXp: number;
  /** Which XP/event source advances this quest. */
  metric: "task" | "tool" | "clean_ship" | "handshake";
}

/** A live quest row for an owner+period. progress is server-computed. */
export interface QuestRecord {
  id: string;
  defKind: string;
  ownerId: string;
  periodKey: string;
  target: number;
  progress: number;
  rewardXp: number;
  createdAt: number;
  completedAt: number | null;
}
