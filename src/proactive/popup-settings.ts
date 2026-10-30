/**
 * Proactive Pop-Up System — operator settings (quiet hours + focus mode).
 *
 * Minimal `settings.proactive.*` schema, persisted as JSON under STATE_DIR
 * (mirrors the focus.json / proactive.json store pattern). The settings UI is
 * deferred to a follow-up pass; this module exists so the router can honour
 * quiet-hours + focus-mode overrides today, and so a future UI has RPCs to
 * bind to (proactive.settings.get / proactive.settings.set).
 */

import { resolve } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" local, inclusive start. */
  start: string;
  /** "HH:MM" local, exclusive end. May wrap past midnight. */
  end: string;
}

export interface FocusMode {
  /** Hyperfocus: only CRITICAL pops; everything else stays in the panel. */
  enabled: boolean;
}

export interface ProactivePopupSettings {
  quietHours: QuietHours;
  focusMode: FocusMode;
  updatedAt: number;
}

export const DEFAULT_POPUP_SETTINGS: ProactivePopupSettings = {
  // Quiet hours default OFF — the auto-suppression confused users who don't keep
  // a fixed sleep schedule. Times stay 22:00–08:00 as sensible defaults for when
  // someone opts in via the Settings toggle (proactive.settings.set). The
  // downgrade logic in proactive-router.ts is unchanged; it just no-ops while off.
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
  // Default Hyperfocus off; when on, CRITICAL-only.
  focusMode: { enabled: false },
  updatedAt: 0,
};

function settingsPath(stateDir: string): string {
  const dir = resolve(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolve(dir, "proactive-popup-settings.json");
}

export function loadPopupSettings(stateDir: string): ProactivePopupSettings {
  const path = settingsPath(stateDir);
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProactivePopupSettings>;
      return {
        quietHours: { ...DEFAULT_POPUP_SETTINGS.quietHours, ...raw.quietHours },
        focusMode: { ...DEFAULT_POPUP_SETTINGS.focusMode, ...raw.focusMode },
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
      };
    }
  } catch (e) {
    console.error("[ProactivePopup] Failed to load settings:", e);
  }
  return { ...DEFAULT_POPUP_SETTINGS };
}

export function savePopupSettings(
  stateDir: string,
  patch: Partial<Pick<ProactivePopupSettings, "quietHours" | "focusMode">>,
): ProactivePopupSettings {
  const current = loadPopupSettings(stateDir);
  const next: ProactivePopupSettings = {
    quietHours: { ...current.quietHours, ...patch.quietHours },
    focusMode: { ...current.focusMode, ...patch.focusMode },
    updatedAt: Date.now(),
  };
  writeFileSync(settingsPath(stateDir), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True when `now` falls inside the (possibly midnight-wrapping) quiet window. */
export function isWithinQuietHours(qh: QuietHours, now: Date = new Date()): boolean {
  if (!qh.enabled) return false;
  const start = parseHHMM(qh.start);
  const end = parseHHMM(qh.end);
  if (start == null || end == null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  // Wraps past midnight (e.g. 22:00 → 08:00).
  return cur >= start || cur < end;
}
