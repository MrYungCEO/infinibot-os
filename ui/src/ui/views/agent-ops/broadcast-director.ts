/**
 * BroadcastDirector — "e-sports" auto-camera for the Galactic HQ world map.
 *
 * Phase 1 of the holographic revamp. The director consumes a stream of
 * "interesting" world events (tool calls, completions, federation hops, voice
 * handoffs, spawns), scores each for newsworthiness, then drives the camera to
 * smoothly pan + zoom to the subject of the top-scoring event, holds for a few
 * seconds, and bounces to the next. When nothing interesting happens for a
 * while it slips into a slow cinematic ambient drift.
 *
 * It is deliberately engine-agnostic: all camera motion + agent lookups are
 * injected, so it has no PIXI dependency and can be unit-reasoned in isolation.
 * Mobile / degraded surfaces can simply never construct one.
 */

export type BroadcastEventKind =
  | "tool"
  | "complete"
  | "fed-hop"
  | "voice-handoff"
  | "spawn";

export interface BroadcastEvent {
  kind: BroadcastEventKind;
  /** Subject agent (camera target). Optional for non-agent events. */
  sessionKey?: string;
  agentName?: string;
  /** Human action phrase, e.g. "running build", "completed task". */
  action?: string;
  /** Action target, e.g. "InfiniBot-fresh". */
  target?: string;
  toolKind?: string;
  success?: boolean;
  /** Optional explicit camera target for subjectless events (e.g. fed hops). */
  worldX?: number;
  worldY?: number;
  focusScale?: number;
  ts: number;
}

export interface FocusInfo {
  sessionKey?: string;
  agentName: string;
  action: string;
  target: string;
  /** Caption line: "<agent> · <action> · <target>". */
  caption: string;
}

export interface BroadcastDeps {
  now: () => number;
  /** True if the agent is still on the map (so we don't chase ghosts). */
  agentExists: (sessionKey: string) => boolean;
  /** World-space position of an agent, or null if unknown. */
  agentWorldPos: (sessionKey: string) => { x: number; y: number } | null;
  /** Smoothly fly the camera to a world point at a target scale. */
  flyTo: (x: number, y: number, scale: number, timeMs: number) => void;
  /** Advance one slow cinematic ambient drift step (no specific subject). */
  ambientDrift: () => void;
  /** Called whenever the focused subject (or caption) changes; null = clear. */
  onFocus: (focus: FocusInfo | null) => void;
}

// ── Tunables ────────────────────────────────────────────────────────────────
const HOLD_MIN_MS = 4000;
const HOLD_MAX_MS = 7000;
const FOCUS_SCALE = 1.45; // caption-readable zoom for a single agent
const IDLE_AMBIENT_MS = 15000; // no events this long → cinematic drift
const AMBIENT_STEP_MS = 6000; // cadence of ambient drift nudges
const PAUSE_MS = 10000; // pause after the user grabs the camera
const CANDIDATE_TTL_MS = 20000; // events older than this are stale
const MAX_CANDIDATES = 24;
const FLY_TIME_MS = 900; // eased pan/zoom duration
const TRACK_DRIFT_PX = 140; // re-center the held subject once it drifts this far
const TRACK_MIN_INTERVAL_MS = 600; // throttle re-centers so the ease never restarts mid-flight

// Base newsworthiness per kind.
const BASE_SCORE: Record<BroadcastEventKind, number> = {
  complete: 62,
  "fed-hop": 50,
  "voice-handoff": 56,
  spawn: 44,
  tool: 30,
};

export class BroadcastDirector {
  private deps: BroadcastDeps;
  private enabled = false;

  private candidates: BroadcastEvent[] = [];
  /** Rolling frequency of event "signatures" for rarity scoring. */
  private freq = new Map<string, number>();

  private currentSubject: string | null = null;
  /** World pos the camera last flew to for the current subject (drift anchor). */
  private lastFocusPos: { x: number; y: number } | null = null;
  private lastTrackAt = 0;
  private holdUntil = 0;
  private lastEventAt = 0;
  private lastAmbientAt = 0;
  private pausedUntil = 0;
  private lastFocusKey: string | null = null;

  constructor(deps: BroadcastDeps) {
    this.deps = deps;
    this.lastEventAt = deps.now();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      this.currentSubject = null;
      this.lastFocusPos = null;
      this.holdUntil = 0;
      this.lastFocusKey = null;
      this.deps.onFocus(null);
    } else {
      // Re-arm so we re-select promptly when switched on.
      this.holdUntil = 0;
      this.lastAmbientAt = 0;
    }
  }

  /** The user grabbed the camera — back off so we never fight their gesture. */
  notePointerInteraction(): void {
    this.pausedUntil = this.deps.now() + PAUSE_MS;
  }

  /** Feed an interesting world event into the candidate pool. */
  noteEvent(ev: BroadcastEvent): void {
    this.lastEventAt = ev.ts;
    const sig = ev.kind + ":" + (ev.toolKind ?? ev.action ?? "");
    this.freq.set(sig, (this.freq.get(sig) ?? 0) + 1);
    this.candidates.push(ev);
    if (this.candidates.length > MAX_CANDIDATES) {
      this.candidates.splice(0, this.candidates.length - MAX_CANDIDATES);
    }
  }

  /**
   * Score an event. Rare > common, failures > successes > starts, completions >
   * tool starts, with a recency decay and an anti-repeat penalty so the camera
   * doesn't sit on one agent.
   */
  private score(ev: BroadcastEvent, now: number): number {
    let s = BASE_SCORE[ev.kind] ?? 20;

    // Rarity: signatures seen rarely get a boost, common ones get damped.
    const sig = ev.kind + ":" + (ev.toolKind ?? ev.action ?? "");
    const count = this.freq.get(sig) ?? 1;
    s += Math.max(0, 26 - (count - 1) * 6); // +26 for first sighting → 0 by ~5th

    // Failures are extra newsworthy.
    if (ev.kind === "complete") s += ev.success === false ? 16 : 6;

    // Recency decay over the TTL window.
    const age = now - ev.ts;
    s *= Math.max(0, 1 - age / CANDIDATE_TTL_MS);

    // Anti-repeat: discourage re-focusing the agent we're already on.
    if (ev.sessionKey && ev.sessionKey === this.currentSubject) s *= 0.4;

    return s;
  }

  private pickTop(now: number): BroadcastEvent | null {
    let best: BroadcastEvent | null = null;
    let bestScore = -Infinity;
    for (const ev of this.candidates) {
      if (now - ev.ts > CANDIDATE_TTL_MS) continue;
      if (ev.sessionKey && !this.deps.agentExists(ev.sessionKey)) continue;
      const sc = this.score(ev, now);
      if (sc > bestScore) {
        bestScore = sc;
        best = ev;
      }
    }
    return best;
  }

  private holdMsFor(score: number): number {
    // Map score (~10..110) to hold duration; juicier events linger longer.
    const t = Math.max(0, Math.min(1, (score - 30) / 70));
    return HOLD_MIN_MS + t * (HOLD_MAX_MS - HOLD_MIN_MS);
  }

  private buildCaption(ev: BroadcastEvent): FocusInfo {
    const agentName = ev.agentName || ev.sessionKey || "Agent";
    let action = ev.action || "";
    if (!action) {
      if (ev.kind === "tool") action = `running ${ev.toolKind || "tool"}`;
      else if (ev.kind === "complete") action = ev.success === false ? "task failed" : "completed task";
      else if (ev.kind === "fed-hop") action = "federation hop";
      else if (ev.kind === "voice-handoff") action = "voice handoff";
      else if (ev.kind === "spawn") action = "spawned";
    }
    const target = ev.target || "";
    const caption = [agentName, action, target].filter(Boolean).join("  ·  ");
    return { sessionKey: ev.sessionKey, agentName, action, target, caption };
  }

  /**
   * Per-frame tick. Time-driven (not frame-driven) so behaviour is identical at
   * any refresh rate. Cheap: it only acts at selection boundaries.
   */
  tick(): void {
    if (!this.enabled) return;
    const now = this.deps.now();
    if (now < this.pausedUntil) return; // user is driving

    // Still holding on the current subject? Keep it framed as it walks around
    // (re-center only on meaningful drift so the camera trails smoothly).
    if (now < this.holdUntil) {
      this.trackSubject(now);
      return;
    }

    const top = this.pickTop(now);
    const idleFor = now - this.lastEventAt;

    if (!top || idleFor > IDLE_AMBIENT_MS) {
      // Cinematic ambient drift at a relaxed cadence.
      if (now - this.lastAmbientAt >= AMBIENT_STEP_MS) {
        this.lastAmbientAt = now;
        this.currentSubject = null;
        this.lastFocusPos = null;
        if (this.lastFocusKey !== null) {
          this.lastFocusKey = null;
          this.deps.onFocus(null);
        }
        this.deps.ambientDrift();
        this.holdUntil = now + AMBIENT_STEP_MS;
      }
      return;
    }

    // Fly to the top event's subject (an agent), or its explicit world target
    // for subjectless beats like federation hops.
    const sc = this.score(top, now);
    if (top.sessionKey) {
      const pos = this.deps.agentWorldPos(top.sessionKey);
      if (pos) {
        this.currentSubject = top.sessionKey;
        this.lastFocusPos = pos;
        this.lastTrackAt = now;
        this.deps.flyTo(pos.x, pos.y, FOCUS_SCALE, FLY_TIME_MS);
      }
    } else if (typeof top.worldX === "number" && typeof top.worldY === "number") {
      this.currentSubject = null;
      this.lastFocusPos = null;
      this.deps.flyTo(top.worldX, top.worldY, top.focusScale ?? 0.9, FLY_TIME_MS);
    }
    const focus = this.buildCaption(top);
    const focusKey = (top.sessionKey ?? "") + "|" + focus.caption;
    if (focusKey !== this.lastFocusKey) {
      this.lastFocusKey = focusKey;
      this.deps.onFocus(focus);
    }
    this.holdUntil = now + this.holdMsFor(sc);

    // Consume the chosen candidate so we advance to fresh news next bounce.
    this.candidates = this.candidates.filter((c) => c !== top);
  }

  /**
   * While holding on a subject, trail it: re-center the camera only after it
   * drifts beyond TRACK_DRIFT_PX from the last fly target, throttled so the ease
   * never restarts mid-flight (no jitter, no fighting a stationary agent).
   */
  private trackSubject(now: number): void {
    if (!this.currentSubject) return;
    if (now - this.lastTrackAt < TRACK_MIN_INTERVAL_MS) return;
    const pos = this.deps.agentWorldPos(this.currentSubject);
    if (!pos) return;
    const anchor = this.lastFocusPos;
    if (anchor && Math.hypot(pos.x - anchor.x, pos.y - anchor.y) < TRACK_DRIFT_PX) {
      return;
    }
    this.lastFocusPos = pos;
    this.lastTrackAt = now;
    this.deps.flyTo(pos.x, pos.y, FOCUS_SCALE, FLY_TIME_MS);
  }

  /** Subject the camera is currently following (for the reticule), or null. */
  getCurrentSubject(): string | null {
    return this.enabled ? this.currentSubject : null;
  }

  destroy(): void {
    this.candidates = [];
    this.freq.clear();
    this.currentSubject = null;
    this.deps.onFocus(null);
  }
}
