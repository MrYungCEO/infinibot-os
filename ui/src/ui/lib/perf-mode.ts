// Central low-end-device detection + "Performance mode" resolution.
//
// Performance mode tones down the most expensive visual passes (cinematic
// color-grade, heavy backdrop blur, uncapped world-map agent count) WITHOUT
// changing the visual identity — same glass-morphism + gold-accent look, just
// quieter filters. It is resolved from a tri-state user setting:
//   "auto" (default) → on iff the device looks low-end
//   "on"             → always on
//   "off"            → always off
//
// Self-contained on purpose: it reads the settings key directly so any module
// (including non-Lit engines like ActivityMap / fx layers) can consult it
// without importing the settings store and risking an import cycle.

const KEY = "infinibot.control.settings.v1";

export type PerfModeSetting = "auto" | "on" | "off";

/** navigator.deviceMemory < 4 OR hardwareConcurrency < 4 → treat as low-end. */
export function isLowEndDevice(): boolean {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    // Unknown → assume capable (don't degrade desktops that don't expose the hint).
    const mem = typeof nav.deviceMemory === "number" ? nav.deviceMemory : 8;
    const cores =
      typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : 8;
    return mem < 4 || cores < 4;
  } catch {
    return false;
  }
}

function readSetting(): PerfModeSetting {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return "auto";
    const v = (JSON.parse(raw) as { performanceMode?: unknown }).performanceMode;
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

let cached: boolean | null = null;

/** Resolved on/off for the current session (cached; call refreshPerfMode after a toggle). */
export function isPerformanceMode(): boolean {
  if (cached !== null) return cached;
  const s = readSetting();
  cached = s === "on" ? true : s === "off" ? false : isLowEndDevice();
  return cached;
}

/** Re-read the setting, re-apply the root class, and return the new value. */
export function refreshPerfMode(): boolean {
  cached = null;
  const on = isPerformanceMode();
  applyPerfModeClass(on);
  return on;
}

/** Toggle a `perf-mode` class on <html> so CSS (theme-glass) can react. */
export function applyPerfModeClass(on: boolean = isPerformanceMode()): void {
  try {
    document.documentElement.classList.toggle("perf-mode", on);
  } catch {
    /* SSR / no-DOM — ignore */
  }
}

// Tunables consumed across the app. High-end values are intentionally no-ops
// (Infinity cap, color-grade allowed) so nothing changes on capable devices.
export const PERF = {
  /** Max world-map agents rendered. Uncapped on high-end. */
  agentCap(): number {
    return isPerformanceMode() ? 60 : Number.POSITIVE_INFINITY;
  },
  /** Whether the cinematic WebGL color-grade pass may run. */
  allowColorGrade(): boolean {
    return !isPerformanceMode();
  },
  /** Target FPS for background (document.hidden) animation loops. */
  hiddenFps(): number {
    return 4;
  },
};
