/**
 * voice-world-ambient/core.ts — shared primitives for the in-world ambient
 * visual layer mounted over the Voice Terminal's isometric agent mesh.
 *
 * Everything in this folder lives in the SAME world-space as <agency-world-viz>.
 * It does so by anchoring to the exact screen coordinates the iso map already
 * publishes every frame on `window.__agentFxState` (CSS px relative to the
 * agency-world-viz host box — see ActivityMap.publishFxState). Overlays here are
 * mounted as siblings of that host with identical geometry, so reading those
 * coords needs no re-projection: the curves and graph sit on the iso ground
 * plane, never on a second plane.
 *
 * This module is deliberately framework-free (no Lit) so both the connector and
 * graph engines can share one perf governor, one anchor resolver, and one theme
 * palette without dragging the render loop through React/Lit reactivity.
 */

// ── Agent feed contract (mirrors agent-fx-layer's) ──────────────────────────
export interface FxAgent {
  id: string;
  x: number;
  y: number;
  status: string;
  backend?: string;
}

// NB: `__agentFxState`, `__agentFxZoom`, `__worldReplayFrame` and
// `__worldSectors` are already declared on Window elsewhere (agent-fx-layer /
// activity-map). We read them through a local cast to avoid clashing global
// re-declarations while keeping our own narrow shape.
interface AmbientWindow {
  __agentFxState?: FxAgent[];
  __agentFxZoom?: number;
  __worldReplayFrame?: { agents?: FxAgent[] } | null;
  __worldSectors?: Array<{ id: string; name: string; x: number; y: number; w: number; h: number; kind: string }>;
}
function w(): AmbientWindow {
  return window as unknown as AmbientWindow;
}

// ── Reduced motion ──────────────────────────────────────────────────────────
export function reducedMotionQuery(): MediaQueryList {
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

// ── Theme palette ───────────────────────────────────────────────────────────
//
// Event-type colours are read from the live theme tokens once (cached) so the
// layer always matches the active glass theme. Each entry carries a hard hex
// fallback for the (rare) case where the token is unset on this surface.

export type EventKind =
  | "spawn"
  | "tool"
  | "edit"
  | "message"
  | "federation"
  | "complete"
  | "utterance";

interface PaletteEntry {
  token: string;
  fallback: string;
}

const PALETTE: Record<EventKind, PaletteEntry> = {
  spawn: { token: "--g-primary", fallback: "#fbbf24" }, // gold — a new agent
  tool: { token: "--g-metric-net", fallback: "#38bdf8" }, // cyan — a tool reach
  edit: { token: "--g-metric-gpu", fallback: "#34d399" }, // emerald — a file edit
  message: { token: "--g-accent", fallback: "#a855f7" }, // violet — agent talk
  federation: { token: "--g-accent", fallback: "#c084fc" }, // violet — cross-node
  complete: { token: "--g-metric-gpu", fallback: "#34d399" }, // emerald — success
  utterance: { token: "--g-primary-soft", fallback: "rgba(251,191,36,0.6)" }, // warm — voice
};

/** Resolve every event colour to a concrete `rgb()`/hex string against `el`. */
export function resolvePalette(el: Element): Record<EventKind, string> {
  const cs = getComputedStyle(el);
  const out = {} as Record<EventKind, string>;
  for (const k of Object.keys(PALETTE) as EventKind[]) {
    const raw = cs.getPropertyValue(PALETTE[k].token).trim();
    out[k] = raw || PALETTE[k].fallback;
  }
  return out;
}

/** Parse a CSS colour string into {r,g,b} for fast rgba() composition. */
export function toRGB(color: string): { r: number; g: number; b: number } {
  const probe = document.createElement("span");
  probe.style.color = color;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color; // → "rgb(r, g, b)" / "rgba(...)"
  probe.remove();
  const m = computed.match(/rgba?\(([^)]+)\)/);
  if (!m) return { r: 200, g: 164, b: 90 };
  const [r, g, b] = m[1].split(",").map((s) => parseFloat(s));
  return { r: r || 0, g: g || 0, b: b || 0 };
}

export function rgba(c: { r: number; g: number; b: number }, a: number): string {
  return `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;
}

// ── Perf governor ───────────────────────────────────────────────────────────
//
// Tracks a rolling estimate of per-frame cost and auto-degrades when the budget
// is blown. Three tiers:
//   0 FULL    — particles, dashes, glow, full node detail
//   1 REDUCED — fewer particles, no glow, simpler curves
//   2 MINIMAL — static-ish: thin lines, no particles (also forced by RMQ)
//
// Degrade trigger (non-negotiable per spec): frame cost > 16ms sustained for
// > 1s drops a tier. Recovery is conservative: cost must stay < 11ms for ~3s to
// climb back, so we never oscillate at the boundary.

export type PerfTier = 0 | 1 | 2;

export class PerfGovernor {
  private avg = 8; // ms, EWMA of measured frame cost
  private overBudgetSince = 0;
  private underBudgetSince = 0;
  private _tier: PerfTier = 0;
  private reduced = false;

  constructor(reducedMotion: boolean) {
    this.reduced = reducedMotion;
    if (reducedMotion) this._tier = 2;
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on;
    if (on) this._tier = 2;
  }

  get tier(): PerfTier {
    return this.reduced ? 2 : this._tier;
  }

  /** True when all non-essential motion should be suppressed. */
  get isMinimal(): boolean {
    return this.tier >= 2;
  }

  /** Feed one measured frame cost (ms) and the wall clock (s). */
  sample(frameMs: number, nowS: number): void {
    if (this.reduced) return; // tier pinned at 2
    // EWMA — react in a few frames without being twitchy.
    this.avg = this.avg * 0.85 + frameMs * 0.15;

    if (this.avg > 16) {
      this.underBudgetSince = 0;
      if (this.overBudgetSince === 0) this.overBudgetSince = nowS;
      else if (nowS - this.overBudgetSince > 1 && this._tier < 2) {
        this._tier = (this._tier + 1) as PerfTier;
        this.overBudgetSince = nowS; // re-arm before next demotion
      }
    } else if (this.avg < 11) {
      this.overBudgetSince = 0;
      if (this.underBudgetSince === 0) this.underBudgetSince = nowS;
      else if (nowS - this.underBudgetSince > 3 && this._tier > 0) {
        this._tier = (this._tier - 1) as PerfTier;
        this.underBudgetSince = nowS;
      }
    } else {
      this.overBudgetSince = 0;
      this.underBudgetSince = 0;
    }
  }

  get avgFrameMs(): number {
    return this.avg;
  }
}

// ── Anchor resolver ─────────────────────────────────────────────────────────
//
// One shared read of the iso map's published feed per frame. Resolves logical
// endpoints ("the tile for agent X", "the blob", "an edge-HUD card region") to
// canvas-local CSS px. All callers pass the overlay canvas' own bounding rect so
// DOM-sourced anchors (the edge HUD host) convert from viewport → local space.

export interface Pt {
  x: number;
  y: number;
}

export class AnchorResolver {
  private map = new Map<string, FxAgent>();
  zoom = 1;

  /** Refresh from the live (or replayed) feed. Call once per frame. */
  refresh(): void {
    const win = w();
    const replay = win.__worldReplayFrame;
    const feed =
      replay && Array.isArray(replay.agents) ? replay.agents : win.__agentFxState ?? [];
    this.map.clear();
    for (const a of feed) this.map.set(a.id, a);
    this.zoom = win.__agentFxZoom ?? 1;
  }

  agent(id: string): FxAgent | null {
    return this.map.get(id) ?? null;
  }

  get agentCount(): number {
    return this.map.size;
  }

  ids(): string[] {
    return [...this.map.keys()];
  }

  /** Centroid of currently working agents — "the active mesh", else box centre. */
  activeCentroid(box: { w: number; h: number }): Pt {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const a of this.map.values()) {
      if (a.status === "working" || a.status === "starting" || a.status === "finishing") {
        sx += a.x;
        sy += a.y;
        n++;
      }
    }
    if (n === 0) return { x: box.w / 2, y: box.h / 2 };
    return { x: sx / n, y: sy / n };
  }

  /** The voice blob sits centred in the panel; the box centre is its anchor. */
  blob(box: { w: number; h: number }): Pt {
    return { x: box.w / 2, y: box.h * 0.5 };
  }

  /** Nearest published sector whose `kind` matches, in canvas-local px. */
  sectorByKind(kind: string, near: Pt): Pt | null {
    const sectors = w().__worldSectors;
    if (!Array.isArray(sectors) || sectors.length === 0) return null;
    let best: Pt | null = null;
    let bestD = Infinity;
    for (const s of sectors) {
      if (s.kind !== kind) continue;
      const d = (s.x - near.x) ** 2 + (s.y - near.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: s.x, y: s.y };
      }
    }
    return best;
  }
}

/**
 * Resolve a DOM element's rect into canvas-local CSS px, returning the closest
 * point on its near edge to `toward`. Used for the edge-HUD lane region without
 * touching the (off-limits) edge HUD component. Returns null if the element is
 * absent or off-screen.
 */
export function edgePointOf(
  el: Element | null,
  canvasRect: DOMRect,
  toward: Pt,
): Pt | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  // Convert to canvas-local.
  const left = r.left - canvasRect.left;
  const top = r.top - canvasRect.top;
  const right = left + r.width;
  const bottom = top + r.height;
  // Clamp `toward` onto the rect → closest boundary point.
  const cx = Math.max(left, Math.min(toward.x, right));
  const cy = Math.max(top, Math.min(toward.y, bottom));
  return { x: cx, y: cy };
}
