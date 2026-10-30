/**
 * canvas.pro.enabled — gates the new layers/pages/templates/brand-kit
 * shell. While off, the canvas overlay renders exactly as before, so we
 * can ship and dogfood incrementally without regressing the existing
 * floating whiteboard.
 *
 * Stored in localStorage. Flip via DevTools:
 *   localStorage.setItem("canvas.pro.enabled", "1")
 */

const FLAG_KEY = "canvas.pro.enabled";

export function isCanvasProEnabled(): boolean {
  try {
    const raw = localStorage.getItem(FLAG_KEY);
    if (raw === null) return false;
    return raw === "1" || raw.toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function setCanvasProEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(FLAG_KEY, "1");
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    /* ignore */
  }
}
