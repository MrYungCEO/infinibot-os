/**
 * CameraDirector — autonomous "director" camera for the isometric world map.
 *
 * Runs alongside BroadcastDirector (the user-toggled "broadcast mode").
 * When broadcast is OFF (default), CameraDirector provides automatic camera
 * focus; when broadcast is ON, it yields so the two never fight.
 *
 * Unlike a simple "fly to the busiest agent" loop, this is a real director:
 *
 *  • Target set        — it tracks the set of *interesting* agents (recently
 *    active, alerting, freshly spawned, user-weighted), not just one.
 *  • Multi-target frame — it computes a weighted centroid + bounding box over
 *    that set and frames ALL of them with padding: tight clusters zoom in,
 *    spread-out crowds zoom out (see camera-targets.ts).
 *  • Critically-damped motion — center AND zoom are driven by a critically-
 *    damped spring integrated with delta-time (camera-easing.ts), so motion is
 *    smooth, frame-rate independent, never overshoots, and never jitters.
 *  • Single-target follow — focusAgent(id) pins the camera to one agent and
 *    trails it as it moves until released with focusAgent(null).
 *  • User override — setUserOverride(ms) (and the host's getPausedUntil) pause
 *    the director so it never fights a human panning/zooming.
 *  • Idle drift — with nothing interesting happening, it eases back to a slow
 *    cinematic overview orbit.
 *
 * The module is engine-agnostic — camera motion and agent lookups are injected
 * via CameraDirectorDeps, so there is no PIXI or Lit dependency.
 */

import {
  criticallyDampedStep,
  omegaForSettle,
  smoothstep as _smoothstep,
  type SpringState,
} from "./camera-easing";
import {
  computeFrame,
  type Frame,
  type ScaleFromSpreadOpts,
  type WeightedPoint,
} from "./camera-targets";

// Re-export so existing importers (`import { smoothstep } from "./camera-director"`)
// keep working unchanged.
export const smoothstep = _smoothstep;

// ── Config ─────────────────────────────────────────────────────────────────

export interface CameraDirectorConfig {
  /** Scale used when the target set is tightly clustered (zoomed in). Default 1.45. */
  focusScale: number;
  /** Scale used during idle orbit / very spread-out sets (zoomed out). Default 0.85. */
  idleScale: number;
  /** Legacy: engine ease for one-shot flights; also the commit-bridge base. Default 720. */
  focusEaseMs: number;
  /** Cadence + hold for each idle orbit step in ms. Default 9000. */
  idleOrbitMs: number;
  /** Legacy ping-pong guard window (ms). Now used as lead-switch hysteresis. Default 6000. */
  cooldownMs: number;
  /** Ms of inactivity before idle orbit starts. Default 12000. */
  idleTriggerMs: number;

  // ── Director additions ────────────────────────────────────────────────────
  /** Hard zoom-in clamp. Default 2.2. */
  maxScale: number;
  /** Hard zoom-out clamp. Default 0.4. */
  minScale: number;
  /** Padding (world px) kept around the framed set when fitting to viewport. Default 220. */
  framePaddingPx: number;
  /** Spread diagonal (world px) at which we fully zoom out to idleScale. Default 1400. */
  referenceSpanPx: number;
  /** How recent an event keeps an agent in the active target set (ms). Default 8000. */
  activeWindowMs: number;
  /** Spring settle time for normal multi-target pursuit (ms). Default 480. */
  followSettleMs: number;
  /** Spring settle time when pinned to a single followed agent (ms). Default 360. */
  pinSettleMs: number;
  /** Max camera pan speed in world px/sec (anti-fling). Default 3200. */
  maxPanSpeedPx: number;
  /** Min ms between flyTo dispatches (framerate cap). Default 110. */
  commitMinIntervalMs: number;
  /** Don't re-dispatch unless the eased center moved this far (anti-jitter px). Default 0.6. */
  reframeMinDistPx: number;
  /** Don't re-dispatch unless the eased scale changed this much (anti-jitter). Default 0.0025. */
  reframeMinScaleDelta: number;
  /** Default user-override pause length (ms) for setUserOverride(). Default 4000. */
  userOverrideMs: number;
  /** Tight zoom used when pinned to a single agent via focusAgent(). Default 1.7. */
  pinScale: number;
}

export const DEFAULT_CAMERA_CONFIG: CameraDirectorConfig = {
  focusScale: 1.45,
  idleScale: 0.85,
  focusEaseMs: 720,
  idleOrbitMs: 9000,
  cooldownMs: 6000,
  idleTriggerMs: 12000,

  maxScale: 2.2,
  minScale: 0.4,
  framePaddingPx: 220,
  referenceSpanPx: 1400,
  activeWindowMs: 8000,
  followSettleMs: 480,
  pinSettleMs: 360,
  maxPanSpeedPx: 3200,
  commitMinIntervalMs: 110,
  reframeMinDistPx: 0.6,
  reframeMinScaleDelta: 0.0025,
  userOverrideMs: 4000,
  pinScale: 1.7,
};

// ── Event type ────────────────────────────────────────────────────────────

export type CameraEventKind = "tool" | "complete" | "spawn" | "fed-hop" | "voice-handoff";

export interface CameraEvent {
  kind: CameraEventKind;
  /** Subject agent (camera target). Omit for world-position events. */
  sessionKey?: string;
  agentName?: string;
  action?: string;
  target?: string;
  toolKind?: string;
  /** For "complete" events — false = failure (gets a score boost). */
  success?: boolean;
  /** Explicit world-space target for subjectless events (e.g. fed-hop). */
  worldX?: number;
  worldY?: number;
  /** Override focus scale for subjectless events. */
  focusScale?: number;
  /** performance.now() timestamp when the event occurred. */
  ts: number;
}

// ── Deps ──────────────────────────────────────────────────────────────────

export interface CameraDirectorDeps {
  now: () => number;
  /** True if the agent is still on the map (so we don't chase ghosts). */
  agentExists: (sessionKey: string) => boolean;
  /** World-space position of an agent, or null if unknown. */
  agentWorldPos: (sessionKey: string) => { x: number; y: number } | null;
  /** Smoothly fly the camera to a world point at a target scale. */
  flyTo: (x: number, y: number, scale: number, timeMs: number) => void;
  /** Advance one slow cinematic ambient drift step (idle orbit). */
  ambientDrift: () => void;
  /**
   * Returns the fxPausedUntil timestamp from the host component.
   * While now() < getPausedUntil(), the director yields — user is driving.
   */
  getPausedUntil: () => number;
  /** Returns true when the BroadcastDirector is active. Director yields if so. */
  isBroadcastEnabled: () => boolean;
  /**
   * Optional: real viewport size (world units) for EXACT scale-to-fit framing.
   * When omitted, the director falls back to the spread heuristic. The current
   * host mount does not provide it, so the heuristic is the production path.
   */
  viewportSize?: () => { width: number; height: number } | null;
}

/** Per-agent weight multiplier — lets callers bias framing (default 1 each). */
export type WeightFn = (sessionKey: string) => number;

// ── Internal constants ────────────────────────────────────────────────────

const CANDIDATE_TTL_MS = 18000;
const MAX_CANDIDATES = 60;
/** Clamp per-tick dt so a backgrounded tab can't fling the spring. */
const MAX_TICK_DT_MS = 64;
const LS_KEY = "infinibot-camera-autofocus";

/** Base newsworthiness per event kind (user-attention axis). */
const KIND_BASE_WEIGHT: Record<string, number> = {
  spawn: 100,
  complete: 80,
  "voice-handoff": 60,
  "fed-hop": 55,
  tool: 35,
};

interface HeatRecord {
  events: number;
  lastEventTs: number;
}

// ── Class ─────────────────────────────────────────────────────────────────

export class CameraDirector {
  private readonly cfg: CameraDirectorConfig;
  private readonly deps: CameraDirectorDeps;
  private enabled: boolean;

  // Candidate pool — events scored at frame time, not at ingest.
  private candidates: CameraEvent[] = [];
  // Per-agent heat tracks activity volume (drives novelty scoring).
  private heat = new Map<string, HeatRecord>();

  // ── Camera spring state (the director owns the motion curve) ──────────────
  private springX: SpringState = { x: 0, v: 0 };
  private springY: SpringState = { x: 0, v: 0 };
  private springScale: SpringState = { x: 1, v: 0 };
  private springSeeded = false;
  private lastTickAt: number;

  // Last committed flyTo frame (for anti-jitter dispatch gating).
  private lastCommit: Frame | null = null;
  private lastCommitAt = 0;

  // Director state
  private currentSubject: string | null = null;
  private lastLeadSwitchAt = 0;
  private pinnedAgent: string | null = null;
  private userOverrideUntil = 0;
  private lastEventAt: number;
  private lastOrbitAt = 0;
  private weightFn: WeightFn = () => 1;

  private pillEl: HTMLButtonElement | null = null;

  constructor(deps: CameraDirectorDeps, config?: Partial<CameraDirectorConfig>) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_CAMERA_CONFIG, ...config };
    this.lastEventAt = deps.now();
    this.lastTickAt = deps.now();
    try {
      // Default ON — opt out by storing "0".
      this.enabled = localStorage.getItem(LS_KEY) !== "0";
    } catch {
      this.enabled = true;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    try {
      localStorage.setItem(LS_KEY, on ? "1" : "0");
    } catch { /* storage blocked */ }
    if (!on) {
      this.currentSubject = null;
      this.springSeeded = false;
      this.lastCommit = null;
    }
    this.refreshPill();
  }

  // ── Public API additions ──────────────────────────────────────────────────

  /**
   * Pin the camera to a single agent and follow it until released.
   * Pass null to release the pin and resume normal multi-target direction.
   */
  focusAgent(sessionKey: string | null): void {
    if (this.pinnedAgent === sessionKey) return;
    this.pinnedAgent = sessionKey;
    // Re-seed so the camera glides cleanly into (or out of) the pin.
    this.springSeeded = false;
    if (sessionKey) this.currentSubject = sessionKey;
  }

  /** The agent currently pinned via focusAgent(), or null. */
  getPinnedAgent(): string | null {
    return this.pinnedAgent;
  }

  /** Pause the auto-director for `ms` (default cfg.userOverrideMs) — user is driving. */
  setUserOverride(ms?: number): void {
    const dur = Math.max(0, ms ?? this.cfg.userOverrideMs);
    const until = this.deps.now() + dur;
    if (until > this.userOverrideUntil) this.userOverrideUntil = until;
  }

  /** True while a user override (or host pause) is suppressing the director. */
  isOverridden(): boolean {
    const now = this.deps.now();
    return now < this.userOverrideUntil || now < this.deps.getPausedUntil();
  }

  /**
   * Provide a per-agent weight multiplier used by the framing centroid/bbox.
   * Heavier agents pull the camera toward them. Pass null to reset to uniform.
   */
  setWeights(fn: WeightFn | null): void {
    this.weightFn = fn ?? (() => 1);
  }

  // ── Ingest ────────────────────────────────────────────────────────────────

  /**
   * Ingest a world event into the candidate pool.
   * Call this every time noteWorldEvents feeds an event to the BroadcastDirector.
   */
  noteEvent(ev: CameraEvent): void {
    this.lastEventAt = ev.ts;
    if (ev.sessionKey) {
      const h = this.heat.get(ev.sessionKey) ?? { events: 0, lastEventTs: ev.ts };
      h.events++;
      h.lastEventTs = ev.ts;
      this.heat.set(ev.sessionKey, h);
    }
    // Prune stale candidates before appending.
    const cutoff = ev.ts - CANDIDATE_TTL_MS;
    this.candidates = this.candidates.filter((c) => c.ts > cutoff);
    this.candidates.push(ev);
    if (this.candidates.length > MAX_CANDIDATES) {
      this.candidates.splice(0, this.candidates.length - MAX_CANDIDATES);
    }
  }

  // ── Per-frame tick ────────────────────────────────────────────────────────

  /**
   * Per-frame tick. Call this from the rAF loop (renderFx) every frame.
   * All timing is wall-clock based (deps.now), so behaviour is identical at any
   * refresh rate: the spring integrates against real delta-time.
   */
  tick(): void {
    if (!this.enabled) return;
    const now = this.deps.now();
    const dt = Math.min(MAX_TICK_DT_MS, Math.max(0, now - this.lastTickAt));
    this.lastTickAt = now;

    // Yield while the user is manually panning / zooming, or to BroadcastDirector.
    if (now < this.userOverrideUntil || now < this.deps.getPausedUntil() || this.deps.isBroadcastEnabled()) {
      // Re-seed on resume so we glide from wherever the user/broadcast left us.
      this.springSeeded = false;
      this.lastCommit = null;
      return;
    }

    const desired = this.computeDesiredFrame(now);

    if (!desired) {
      // Nothing interesting — idle orbit drift after the quiet threshold.
      const idleFor = now - this.lastEventAt;
      if (idleFor > this.cfg.idleTriggerMs && now - this.lastOrbitAt >= this.cfg.idleOrbitMs) {
        this.lastOrbitAt = now;
        this.currentSubject = null;
        this.springSeeded = false;
        this.lastCommit = null;
        this.deps.ambientDrift();
      }
      return;
    }

    // Seed the spring at the desired frame on first use so the opening move
    // lands cleanly on target instead of crawling from an arbitrary origin.
    if (!this.springSeeded) {
      this.springX = { x: desired.x, v: 0 };
      this.springY = { x: desired.y, v: 0 };
      this.springScale = { x: desired.scale, v: 0 };
      this.springSeeded = true;
    }

    // Advance the critically-damped spring toward the desired frame.
    const settleMs = this.pinnedAgent ? this.cfg.pinSettleMs : this.cfg.followSettleMs;
    const omega = omegaForSettle(settleMs);
    this.springX = criticallyDampedStep(this.springX, desired.x, omega, dt, this.cfg.maxPanSpeedPx);
    this.springY = criticallyDampedStep(this.springY, desired.y, omega, dt, this.cfg.maxPanSpeedPx);
    this.springScale = criticallyDampedStep(this.springScale, desired.scale, omega, dt);

    const eased: Frame = { x: this.springX.x, y: this.springY.x, scale: this.springScale.x };
    this.maybeCommit(eased, now);
  }

  /**
   * Dispatch a flyTo only when the eased frame has moved enough since the last
   * dispatch and the framerate cap allows it — kills jitter and flyTo spam.
   * The short bridge duration lets the engine's own easing smooth the gap
   * between successive spring samples without snapping.
   */
  private maybeCommit(frame: Frame, now: number): void {
    if (this.lastCommit) {
      if (now - this.lastCommitAt < this.cfg.commitMinIntervalMs) return;
      const movedFar =
        Math.hypot(frame.x - this.lastCommit.x, frame.y - this.lastCommit.y) > this.cfg.reframeMinDistPx;
      const scaleChanged = Math.abs(frame.scale - this.lastCommit.scale) > this.cfg.reframeMinScaleDelta;
      if (!movedFar && !scaleChanged) return;
    }
    // Bridge ~1.6× the dispatch cadence so consecutive eases overlap smoothly.
    const bridgeMs = Math.max(120, Math.round(this.cfg.commitMinIntervalMs * 1.6));
    this.deps.flyTo(frame.x, frame.y, frame.scale, bridgeMs);
    this.lastCommit = { ...frame };
    this.lastCommitAt = now;
  }

  // ── Framing ────────────────────────────────────────────────────────────────

  /**
   * Compute the desired camera frame for this tick:
   *  - pinned mode  → that one agent at pinScale,
   *  - active set   → weighted centroid + spread-fit over interesting agents,
   *  - otherwise    → null (caller handles idle).
   */
  private computeDesiredFrame(now: number): Frame | null {
    // Single-target follow.
    if (this.pinnedAgent) {
      if (this.deps.agentExists(this.pinnedAgent)) {
        const pos = this.deps.agentWorldPos(this.pinnedAgent);
        if (pos) {
          this.currentSubject = this.pinnedAgent;
          return { x: pos.x, y: pos.y, scale: this.clampScale(this.cfg.pinScale) };
        }
      } else {
        // The pinned agent left the map — release and fall through.
        this.pinnedAgent = null;
      }
    }

    const points = this.activeTargets(now);
    if (points.length === 0) return null;

    this.updateLead(now);

    const spread: ScaleFromSpreadOpts = {
      tightScale: this.cfg.focusScale,
      wideScale: this.cfg.idleScale,
      referenceSpanPx: this.cfg.referenceSpanPx,
      minScale: this.cfg.minScale,
      maxScale: this.cfg.maxScale,
    };
    const vp = this.deps.viewportSize?.() ?? null;
    const frame = computeFrame(points, {
      spread,
      fit: vp
        ? {
            viewportWidth: vp.width,
            viewportHeight: vp.height,
            paddingPx: this.cfg.framePaddingPx,
            minScale: this.cfg.minScale,
            maxScale: this.cfg.maxScale,
          }
        : undefined,
    });
    return frame;
  }

  /**
   * The current set of interesting agents, as weighted framing points.
   * An agent is "active" if it produced an event within activeWindowMs and is
   * still on the map. Subjectless world-point events (fed-hop) contribute a
   * point at their explicit world coordinates.
   */
  private activeTargets(now: number): WeightedPoint[] {
    const cutoff = now - this.cfg.activeWindowMs;
    const byAgent = new Map<string, number>();
    const worldPoints: WeightedPoint[] = [];

    for (const ev of this.candidates) {
      if (ev.ts < cutoff) continue;
      const w = this.eventScore(ev, now);
      if (w <= 0) continue;
      if (ev.sessionKey) {
        if (!this.deps.agentExists(ev.sessionKey)) continue;
        byAgent.set(ev.sessionKey, (byAgent.get(ev.sessionKey) ?? 0) + w);
      } else if (ev.worldX !== undefined && ev.worldY !== undefined) {
        worldPoints.push({ x: ev.worldX, y: ev.worldY, weight: w });
      }
    }

    const points: WeightedPoint[] = [...worldPoints];
    for (const [key, baseWeight] of byAgent) {
      const pos = this.deps.agentWorldPos(key);
      if (!pos) continue;
      const mult = this.safeWeightMult(key);
      points.push({ x: pos.x, y: pos.y, weight: baseWeight * mult });
    }
    return points;
  }

  /** Guard the user weight function against NaN / negative / throwing. */
  private safeWeightMult(key: string): number {
    try {
      const m = this.weightFn(key);
      return Number.isFinite(m) && m >= 0 ? m : 1;
    } catch {
      return 1;
    }
  }

  /** Pick the highest-weight agent as the reticle "lead", with mild hysteresis. */
  private updateLead(now: number): void {
    const cutoff = now - this.cfg.activeWindowMs;
    let best: string | null = null;
    let bestW = 0;
    let currentW = 0;
    const agg = new Map<string, number>();
    for (const ev of this.candidates) {
      if (ev.ts < cutoff || !ev.sessionKey) continue;
      if (!this.deps.agentExists(ev.sessionKey)) continue;
      const w = this.eventScore(ev, now) * this.safeWeightMult(ev.sessionKey);
      const total = (agg.get(ev.sessionKey) ?? 0) + w;
      agg.set(ev.sessionKey, total);
      if (total > bestW) { bestW = total; best = ev.sessionKey; }
      if (ev.sessionKey === this.currentSubject) currentW = total;
    }
    if (!best) return;
    if (best === this.currentSubject) return;
    // Hysteresis: only switch lead if the challenger clearly wins, or enough
    // time has passed since the last switch — prevents reticle flicker.
    const switchAllowed =
      now - this.lastLeadSwitchAt >= this.cfg.cooldownMs || bestW > currentW * 1.5;
    if (switchAllowed) {
      this.currentSubject = best;
      this.lastLeadSwitchAt = now;
    }
  }

  /**
   * Event score = userAttention × recency × novelty (no cooldown gating; the
   * framing uses the whole set, so there is no ping-pong to guard against).
   */
  private eventScore(ev: CameraEvent, now: number): number {
    const base = KIND_BASE_WEIGHT[ev.kind] ?? 40;
    const userAttn =
      ev.kind === "complete"
        ? ev.success === false
          ? base * 1.35
          : base * 1.1
        : base;

    const age = now - ev.ts;
    const recency = _smoothstep(Math.max(0, 1 - age / CANDIDATE_TTL_MS));

    const eventCount = ev.sessionKey ? (this.heat.get(ev.sessionKey)?.events ?? 1) : 1;
    const novelty = 1 / Math.max(1, Math.log2(eventCount + 1));

    return userAttn * recency * novelty;
  }

  private clampScale(s: number): number {
    return Math.min(this.cfg.maxScale, Math.max(this.cfg.minScale, s));
  }

  /** The agent the camera is currently locked to (for reticule rendering). */
  getCurrentSubject(): string | null {
    return this.enabled ? this.currentSubject : null;
  }

  // ── Pill DOM (unchanged surface) ───────────────────────────────────────────

  /**
   * Build (or return cached) the auto-focus toggle pill DOM element.
   * Append it to the bx-layer overlay after calling this.
   */
  buildPill(): HTMLButtonElement {
    if (this.pillEl) return this.pillEl;
    const btn = document.createElement("button");
    btn.className = "bx-btn bx-autofocus-pill";
    this.refreshPillEl(btn);
    btn.addEventListener("click", () => this.setEnabled(!this.enabled));
    this.pillEl = btn;
    return btn;
  }

  private refreshPill(): void {
    if (this.pillEl) this.refreshPillEl(this.pillEl);
  }

  private refreshPillEl(el: HTMLButtonElement): void {
    const on = this.enabled;
    // Icon + text spans so compact (phone) HUDs can show the icon alone;
    // textContent stays "🎯 Auto-focus: ON|OFF".
    const ico = document.createElement("span");
    ico.className = "bx-pill-ico";
    ico.setAttribute("aria-hidden", "true");
    ico.textContent = "🎯";
    const txt = document.createElement("span");
    txt.className = "bx-pill-txt";
    txt.textContent = on ? " Auto-focus: ON" : " Auto-focus: OFF";
    el.replaceChildren(ico, txt);
    el.setAttribute("aria-label", on ? "Auto-focus on" : "Auto-focus off");
    el.title = on
      ? "Auto-focus active — camera glides to active agents (click to disable)"
      : "Auto-focus disabled — click to enable";
    el.classList.toggle("on", on);
    if (on) {
      el.style.borderColor = "#7dd3fc";
      el.style.color = "#bae6fd";
      el.style.boxShadow = "0 0 0 1px rgba(125,211,252,0.4), 0 0 16px rgba(125,211,252,0.25)";
    } else {
      el.style.borderColor = "";
      el.style.color = "";
      el.style.boxShadow = "";
    }
  }

  destroy(): void {
    this.candidates = [];
    this.heat.clear();
    this.currentSubject = null;
    this.pinnedAgent = null;
    this.springSeeded = false;
    this.lastCommit = null;
    this.pillEl = null;
  }
}
