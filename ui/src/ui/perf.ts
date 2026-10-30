/**
 * Low-power mode — reduce GPU/CPU load on weak devices (older machines, ~8 GB
 * RAM, integrated graphics) that lag under the animated WebGL/canvas backgrounds
 * and heavy CSS effects.
 *
 * Auto-detection is best-effort: `navigator.deviceMemory` is coarse and caps at
 * 8 (so an 8 GB box and a 32 GB box both report 8), which is why we also weigh
 * CPU cores and `prefers-reduced-motion`, AND expose a manual override for the
 * exactly-8 GB case. When active:
 *   - app-branding forces the static `gradient` background (no WebGL effect)
 *   - the terminal matrix background skips its WebGL loop
 *   - low-power.css drops backdrop-filter / animations / transitions globally
 */

const KEY = "infinibot:perfMode"; // "auto" (default) | "on" | "off"
let cached: boolean | null = null;

function detectAuto(): boolean {
  try {
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const cores = navigator.hardwareConcurrency || 0;
    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* matchMedia unavailable */
    }
    return (
      reduced ||
      (typeof mem === "number" && mem > 0 && mem <= 4) ||
      (cores > 0 && cores <= 4)
    );
  } catch {
    return false;
  }
}

export function getPerfMode(): "auto" | "on" | "off" {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "on" || v === "off") return v;
  } catch {
    /* localStorage blocked */
  }
  return "auto";
}

/** True when the app should run in reduced-effects mode. Cached after first read. */
export function isLowPower(): boolean {
  if (cached !== null) return cached;
  const mode = getPerfMode();
  cached = mode === "on" ? true : mode === "off" ? false : detectAuto();
  return cached;
}

/** Set the user's preference. `auto` clears the override and re-detects. */
export function setPerfMode(mode: "auto" | "on" | "off"): void {
  try {
    if (mode === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* localStorage blocked */
  }
  cached = null;
  applyLowPowerClass();
}

/** Reflect the current state onto <html> so low-power.css can take effect. */
export function applyLowPowerClass(): void {
  try {
    document.documentElement.classList.toggle("low-power", isLowPower());
  } catch {
    /* no document */
  }
}

// Expose a manual switch for support/power users until a Settings control ships.
try {
  (window as unknown as { infinibotPerfMode?: typeof setPerfMode }).infinibotPerfMode = setPerfMode;
} catch {
  /* no window */
}
