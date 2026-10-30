/**
 * Achievements + streaks data layer.
 *
 * Public surface for the gateway: a SQLite-backed {@link AchievementStore},
 * a decoupled {@link AchievementWatcher} that maps events → unlocks, and the
 * static {@link ACHIEVEMENT_DEFS} catalogue shared with the UI.
 */

export * from "./types.js";
export {
  ACHIEVEMENT_DEFS,
  ALL_ACHIEVEMENT_KINDS,
  TIER_COLORS,
  getAchievementDef,
} from "./kinds.js";
export {
  AchievementStore,
  getAchievementStore,
  closeAchievementStore,
  type AwardOptions,
  type AwardResult,
} from "./store.js";
export { AchievementWatcher, getAchievementWatcher, type WatcherOptions } from "./watcher.js";
export {
  GamificationEngine,
  getGamificationEngine,
  resetGamificationEngine,
  deriveProgression,
  levelForXp,
  xpForLevel,
  rankForLevel,
  RANKS,
  XP_REWARDS,
  QUEST_DEFS,
  ALL_QUEST_KINDS,
  getQuestDef,
  dailyKey,
  weeklyKey,
  type Progression,
  type Rank,
  type GamificationEvent,
  type GamificationListener,
} from "./gamification.js";
