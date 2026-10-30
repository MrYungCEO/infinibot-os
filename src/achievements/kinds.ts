/**
 * Static catalogue of achievement definitions.
 *
 * Twelve kinds spanning the four tiers. Pure data — no I/O — so both the
 * server watcher and (a serialized copy of) the UI can share label/icon/tier.
 */

import type { AchievementDef, AchievementKind } from "./types.js";

export const ACHIEVEMENT_DEFS: Record<AchievementKind, AchievementDef> = {
  clean_shipment: {
    kind: "clean_shipment",
    label: "Clean Shipment",
    description: "Shipped a task with zero failed sub-agent runs.",
    icon: "📦",
    tier: "bronze",
    repeatable: true,
  },
  ten_shipments: {
    kind: "ten_shipments",
    label: "Ten Down",
    description: "Completed 10 shipments.",
    icon: "🔟",
    tier: "silver",
  },
  ship_streak_7day: {
    kind: "ship_streak_7day",
    label: "Seven-Day Streak",
    description: "Shipped clean work seven days in a row.",
    icon: "🔥",
    tier: "gold",
  },
  federation_milestone: {
    kind: "federation_milestone",
    label: "Federation Online",
    description: "Grew the federation mesh to a new node milestone.",
    icon: "🛰️",
    tier: "gold",
  },
  focus_session_2h: {
    kind: "focus_session_2h",
    label: "In The Zone",
    description: "Held a focus session for two unbroken hours.",
    icon: "🎯",
    tier: "silver",
  },
  marathon_focus_4h: {
    kind: "marathon_focus_4h",
    label: "Marathon Mind",
    description: "Sustained a four-hour focus session.",
    icon: "🏃",
    tier: "gold",
  },
  hourly_insight_acted: {
    kind: "hourly_insight_acted",
    label: "Coachable",
    description: "Acted on a proactive hourly insight.",
    icon: "💡",
    tier: "bronze",
  },
  zero_failed_day: {
    kind: "zero_failed_day",
    label: "Flawless Day",
    description: "Closed a full day with zero failed runs.",
    icon: "✨",
    tier: "gold",
  },
  first_drag_assign: {
    kind: "first_drag_assign",
    label: "Hands On",
    description: "Assigned a task to an agent by drag-and-drop for the first time.",
    icon: "🖐️",
    tier: "bronze",
  },
  director_mode_first: {
    kind: "director_mode_first",
    label: "Take The Chair",
    description: "Entered Director Mode for the first time.",
    icon: "🎬",
    tier: "silver",
  },
  first_voice_command: {
    kind: "first_voice_command",
    label: "Speak & Ship",
    description: "Issued your first voice command to the fleet.",
    icon: "🎙️",
    tier: "bronze",
  },
  night_owl: {
    kind: "night_owl",
    label: "Night Owl",
    description: "Shipped clean work between midnight and 5am.",
    icon: "🦉",
    tier: "legendary",
  },
};

export function getAchievementDef(kind: AchievementKind): AchievementDef {
  return ACHIEVEMENT_DEFS[kind];
}

export const ALL_ACHIEVEMENT_KINDS = Object.keys(ACHIEVEMENT_DEFS) as AchievementKind[];

/** Tier → ramp colour, shared with the UI badge styling. */
export const TIER_COLORS: Record<AchievementDef["tier"], string> = {
  bronze: "#cd7f32",
  silver: "#c0c6d4",
  gold: "#d4af37",
  legendary: "#b06bff",
};
