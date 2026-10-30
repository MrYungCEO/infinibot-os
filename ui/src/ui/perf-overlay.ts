/**
 * Live FPS / frame-time / draw-call overlay — `?perf=1`.
 *
 * A tiny, self-contained heads-up display for profiling the control UI in a
 * real browser (the headless rAF cap makes DevTools FPS unreliable; this reads
 * true wall-clock frame deltas instead). Mirrors the knowledge-graph
 * `window.__kgPerf` pattern: render loops publish their cost into
 * `window.__hudPerf` and this overlay surfaces it alongside an independently
 * measured frame rate.
 *
 * Activate with `?perf=1` (or `localStorage['infinibot:perfOverlay']='1'`).
 * App-wide: mounted once from main.ts, so it works on every route.
 */

import { rafLoop } from "./perf/visibility-scheduler";

export interface HudPerfStats {
  /** Engine/loop-reported last-draw cost in ms (e.g. PIXI ActivityMap tick). */
  drawMs?: number;
  /** Draw calls last frame, when the renderer can report it. */
  drawCalls?: number;
  /** Live agent/sprite count being rendered. */
  agents?: number;
  /** Free-form label for the active surface. */
  surface?: string;
}

declare global {
  interface Window {
    __hudPerf?: HudPerfStats;
    __perfOverlayMounted?: boolean;
  }
}

function perfEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = (params.get("perf") || "").trim().toLowerCase();
    if (raw === "1" || raw === "true" || raw === "on") return true;
    if (raw === "0" || raw === "off") return false;
  } catch {
    /* no location */
  }
  try {
    return localStorage.getItem("infinibot:perfOverlay") === "1";
  } catch {
    return false;
  }
}

export function mountPerfOverlay(): void {
  try {
    if (window.__perfOverlayMounted || !perfEnabled()) return;
    window.__perfOverlayMounted = true;
  } catch {
    return;
  }

  const el = document.createElement("div");
  el.id = "infinibot-perf-overlay";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "fixed",
    top: "8px",
    right: "8px",
    zIndex: "2147483647",
    font: "11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace",
    color: "#cfe9ff",
    background: "rgba(4,8,18,0.82)",
    border: "1px solid rgba(120,170,255,0.28)",
    borderRadius: "8px",
    padding: "6px 9px",
    pointerEvents: "none",
    whiteSpace: "pre",
    letterSpacing: "0.2px",
    boxShadow: "0 4px 18px rgba(0,0,0,0.45)",
    minWidth: "150px",
  } as Partial<CSSStyleDeclaration>);
  // Defer until <body> exists.
  const attach = () => (document.body || document.documentElement).appendChild(el);
  if (document.body) attach();
  else window.addEventListener("DOMContentLoaded", attach, { once: true });

  // Independent FPS measurement — true wall-clock deltas, EMA-smoothed, with a
  // 1s rolling min so brief hitches show up (the user's "low FPS" complaint).
  let last = performance.now();
  let emaDt = 16.7;
  let worstDt = 0;
  let worstWindowStart = last;
  let frames = 0;
  let displayFps = 0;
  let displayMin = 0;
  let lastPaint = 0;

  const fmt = (n: number, d = 0) => n.toFixed(d);

  const tick = (now: number) => {
    const dt = now - last;
    last = now;
    frames++;
    // Ignore the first frame and tab-switch gaps that blow up the average.
    if (dt > 0 && dt < 1000) {
      emaDt = emaDt * 0.9 + dt * 0.1;
      if (dt > worstDt) worstDt = dt;
    }
    // Roll the worst-frame window every second.
    if (now - worstWindowStart >= 1000) {
      displayMin = worstDt > 0 ? 1000 / worstDt : 0;
      worstDt = 0;
      worstWindowStart = now;
    }
    displayFps = emaDt > 0 ? 1000 / emaDt : 0;

    // Repaint the DOM at ~5Hz — cheap, and avoids the overlay itself becoming
    // a hotspot.
    if (now - lastPaint < 200) return;
    lastPaint = now;
    const p = window.__hudPerf || {};
    const lines = [
      `${fmt(displayFps)} fps  ${fmt(emaDt, 1)} ms`,
      `min ${fmt(displayMin)} fps (1s low)`,
    ];
    if (typeof p.drawMs === "number") lines.push(`draw ${fmt(p.drawMs, 2)} ms`);
    if (typeof p.drawCalls === "number") lines.push(`calls ${p.drawCalls}`);
    if (typeof p.agents === "number") lines.push(`agents ${p.agents}`);
    if (p.surface) lines.push(p.surface);
    // Colour the headline by health (90/60 thresholds).
    const c = displayFps >= 90 ? "#7dffb0" : displayFps >= 55 ? "#ffd479" : "#ff7a7a";
    el.style.color = "#cfe9ff";
    el.textContent = "";
    const head = document.createElement("div");
    head.style.color = c;
    head.style.fontWeight = "700";
    head.textContent = lines[0];
    el.appendChild(head);
    const rest = document.createElement("div");
    rest.textContent = lines.slice(1).join("\n");
    el.appendChild(rest);
  };
  rafLoop(tick);
}
