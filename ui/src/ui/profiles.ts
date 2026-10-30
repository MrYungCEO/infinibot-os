/**
 * Client-side profile state for the gate screen.
 *
 * The authoritative profile registry lives server-side (profiles.* RPCs).
 * This module only tracks browser-local UX flags:
 *   • whether the gate is enabled (opt-in; off by default so existing
 *     single-profile installs see ZERO change),
 *   • whether the gate has already been passed this browser session,
 *   • the last profile picked on this device (for tile highlighting).
 *
 * Switching a profile re-points the gateway data layer (profiles.switch)
 * and then reloads the page so a fresh connection re-resolves every store
 * under the new profile. Shared services stay up.
 */

import { isSaasMode } from "./saas-clerk.js";
import { loadSettings, saveSettings } from "./storage.js";
import { isThemeMode } from "./theme.js";

const GATE_ENABLED_KEY = "infinibot.profiles.gateEnabled.v1";
const GATE_PASSED_KEY = "infinibot.profiles.gatePassed"; // sessionStorage
const GATE_REQUESTED_KEY = "infinibot.profiles.gateRequested"; // sessionStorage
const LAST_PICKED_KEY = "infinibot.profiles.lastPicked.v1";

export type SkillLevel = "beginner" | "intermediate" | "advanced";

export interface ProfileRecord {
  id: string;
  name: string;
  avatar: string;
  theme: string;
  wallpaper?: string;
  createdAt: number;
  // ── Operator context (Layer 1) — all optional, default undefined ──
  role?: string;
  goals?: string;
  notes?: string;
  preferredLanguage?: string;
  secondaryLanguage?: string;
  skillLevel?: SkillLevel;
  projectContext?: string;
  communicationStyle?: string;
}

/**
 * Gate is ON by default so first-launch users actually see the profile
 * chooser. The localStorage key is an explicit override: once the user
 * turns the gate off (value "0") that choice sticks; any other state
 * (key absent, or "1") means the gate shows.
 */
export function isGateEnabled(): boolean {
  // SaaS: Clerk is the only gate — the member's workspace comes from their
  // identity, not a local profile picker.
  if (isSaasMode()) return false;
  try {
    return localStorage.getItem(GATE_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setGateEnabled(on: boolean): void {
  try {
    localStorage.setItem(GATE_ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** True once the user has chosen a profile this browser session. */
export function isGatePassed(): boolean {
  try {
    return sessionStorage.getItem(GATE_PASSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markGatePassed(): void {
  try {
    sessionStorage.setItem(GATE_PASSED_KEY, "1");
    sessionStorage.removeItem(GATE_REQUESTED_KEY);
  } catch {
    /* ignore */
  }
}

/** Clear the session "passed" flag so the gate re-shows (manual switch). */
export function markGateUnpassed(): void {
  try {
    sessionStorage.removeItem(GATE_PASSED_KEY);
    // The user asked for the chooser — show it even on a one-profile install
    // (where the automatic start-of-session gate passes silently).
    sessionStorage.setItem(GATE_REQUESTED_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** True when the chooser was opened on purpose ("switch profile" / "Open chooser"). */
export function isGateExplicitlyRequested(): boolean {
  try {
    return sessionStorage.getItem(GATE_REQUESTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function getLastPicked(): string | null {
  try {
    return localStorage.getItem(LAST_PICKED_KEY);
  } catch {
    return null;
  }
}

export function setLastPicked(id: string): void {
  try {
    localStorage.setItem(LAST_PICKED_KEY, id);
  } catch {
    /* ignore */
  }
}

/**
 * Apply a profile's appearance (theme/wallpaper) into the browser-local
 * UI settings. Called on switch so the per-user appearance from the
 * profile record wins after reload.
 */
export function applyProfileAppearance(profile: ProfileRecord): void {
  const settings = loadSettings();
  if (isThemeMode(profile.theme)) settings.theme = profile.theme;
  saveSettings(settings);
}
