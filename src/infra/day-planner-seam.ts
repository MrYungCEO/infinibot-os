/**
 * Day-planner seam (core ⇄ Discipline plugin).
 *
 * A few core features read day-planner state: the Telegram completion
 * notifier and the agent-integration test message use its Telegram chat id,
 * and the CEO hourly report shows the current block. Core must build and run
 * with the Discipline plugin off, so they ask this seam instead of importing
 * the plugin. The plugin registers a provider when its service starts
 * (`api.runtime.host.setDayPlannerProvider`) and clears it when it stops.
 * No provider → every reader gets null and carries on without that data.
 */

import { isPluginActive } from "../plugins/core-tool-slots.js";

export type DayPlannerTelegramTarget = {
  /** Owner switched Telegram notifications on in the planner's settings. */
  enabled: boolean;
  chatId: string;
};

export type DayPlannerPosture = {
  dayStarted: boolean;
  /** Epoch ms the day was started, and how ("manual" | "auto" | …). */
  dayStartedAt?: number;
  dayStartSource?: string;
  currentBlock?: { label: string; category: string; intent?: string };
  militant: boolean;
};

export interface DayPlannerProvider {
  /** Plugin that registered the provider (for logs). */
  pluginId: string;
  telegramTarget(): DayPlannerTelegramTarget | null;
  /** Today's posture for a state dir (tenant-scoped), or null if unknown. */
  posture(stateDir: string, now: number): DayPlannerPosture | null;
}

let provider: DayPlannerProvider | null = null;

export function setDayPlannerProvider(next: DayPlannerProvider | null): void {
  provider = next;
}

/** The provider, only while its plugin is loaded in the active registry (a
 *  plugin turned off in-process leaves its registration behind). */
export function getDayPlannerProvider(): DayPlannerProvider | null {
  return provider && isPluginActive(provider.pluginId) ? provider : null;
}

/** Telegram target from the planner, or null when the plugin is off / errors. */
export function dayPlannerTelegramTarget(): DayPlannerTelegramTarget | null {
  try {
    return getDayPlannerProvider()?.telegramTarget() ?? null;
  } catch {
    return null;
  }
}
