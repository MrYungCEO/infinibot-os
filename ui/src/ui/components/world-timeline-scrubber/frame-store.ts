/**
 * frame-store.ts — ring buffer of world-replay frames + derived event markers,
 * with localStorage spill-over so a page reload keeps recent history.
 *
 * ── WHY NOT SQLITE ────────────────────────────────────────────────────────
 * The spec offers "sqlite table OR in-memory ring buffer". This module runs in
 * the *browser* Lit UI, which cannot open a sqlite file (no fs/native module).
 * We therefore take the ring-buffer branch and spill recent frames into
 * localStorage — that is the browser-native equivalent of sqlite spill-over and
 * satisfies the persistence requirement (reload keeps the last window).
 *
 * A frame is a 1 Hz snapshot of every on-screen agent's position + status,
 * mirroring the <agent-fx-layer> data contract (FxAgent = {id,x,y,status,backend}).
 * Events are *derived* by diffing consecutive snapshots per agent id:
 *   - spawn    : an id appears that we had no prior status for      → gold
 *   - complete : status transitions into the "completed" bucket     → mint
 *   - fail     : status transitions into the "failed" bucket        → crimson
 *   - blocked  : status transitions into the "blocked" bucket       → amber
 */

import { statusKey } from "../agent-fx-layer/colors.js";

/** One agent's screen-space state in a frame. Mirrors FxAgent. */
export interface ReplayAgent {
  id: string;
  x: number;
  y: number;
  status: string;
  backend?: string;
}

/** A single 1 Hz world snapshot. `t` is epoch ms. */
export interface ReplayFrame {
  t: number;
  agents: ReplayAgent[];
}

export type ReplayEventKind = "spawn" | "complete" | "fail" | "blocked";

export interface ReplayEvent {
  t: number;
  id: string;
  kind: ReplayEventKind;
  label?: string;
}

export interface FrameStoreOpts {
  /** Retention window in seconds (default 3600 = last hour). */
  windowSeconds?: number;
  /** Expected sample rate; capacity = windowSeconds * hz (default 1 Hz). */
  hz?: number;
  /** Persist a recent slice to localStorage (default true). */
  persist?: boolean;
  /** Max frames written to localStorage (default 1800 ≈ 30 min @1Hz). */
  persistCap?: number;
}

const LS_KEY = "infinibot.worldReplay.v1";

export class FrameStore {
  readonly windowSeconds: number;
  readonly capacity: number;
  private frames: ReplayFrame[] = [];
  private events: ReplayEvent[] = [];
  private prevStatus = new Map<string, string>();
  private persist: boolean;
  private persistCap: number;
  private saveTimer = 0;
  private listeners = new Set<() => void>();

  constructor(opts: FrameStoreOpts = {}) {
    this.windowSeconds = opts.windowSeconds ?? 3600;
    const hz = opts.hz ?? 1;
    this.capacity = Math.max(60, Math.round(this.windowSeconds * hz));
    this.persist = opts.persist ?? true;
    this.persistCap = opts.persistCap ?? 1800;
    if (this.persist) this.load();
  }

  /** Subscribe to mutations (new frame / events). Returns an unsubscribe fn. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* listener errors must not break collection */
      }
    }
  }

  /** Record a snapshot at time `t` (epoch ms) and derive any status events. */
  push(agents: ReplayAgent[], t: number): void {
    this.frames.push({ t, agents: agents.map((a) => ({ ...a })) });

    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.id);
      const prev = this.prevStatus.get(a.id);
      if (prev === undefined) {
        this.events.push({ t, id: a.id, kind: "spawn", label: a.id });
      } else {
        const pk = statusKey(prev);
        const k = statusKey(a.status);
        if (k !== pk) {
          if (k === "completed") this.events.push({ t, id: a.id, kind: "complete", label: a.id });
          else if (k === "failed") this.events.push({ t, id: a.id, kind: "fail", label: a.id });
          else if (k === "blocked") this.events.push({ t, id: a.id, kind: "blocked", label: a.id });
        }
      }
      this.prevStatus.set(a.id, a.status);
    }
    // Forget vanished agents so a re-appearance later counts as a fresh spawn.
    for (const id of [...this.prevStatus.keys()]) if (!seen.has(id)) this.prevStatus.delete(id);

    this.trim(t);
    this.emit();
    this.scheduleSave();
  }

  /** Bulk-seed frames+events (used by tests / backfill). Recomputes nothing. */
  seed(frames: ReplayFrame[], events: ReplayEvent[]): void {
    this.frames = frames.slice().sort((a, b) => a.t - b.t);
    this.events = events.slice().sort((a, b) => a.t - b.t);
    const last = this.frames[this.frames.length - 1];
    if (last) for (const a of last.agents) this.prevStatus.set(a.id, a.status);
    this.emit();
  }

  private trim(now: number): void {
    const cutoff = now - this.windowSeconds * 1000;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
    while (this.frames.length > this.capacity) this.frames.shift();
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
  }

  // ── Read API ──────────────────────────────────────────────────────────────

  /** Earliest retained frame time, or `now - window` if empty. */
  start(now: number): number {
    return now - this.windowSeconds * 1000;
  }

  framesInWindow(now: number): ReplayFrame[] {
    const cutoff = this.start(now);
    return this.frames.filter((f) => f.t >= cutoff);
  }

  eventsInWindow(now: number): ReplayEvent[] {
    const cutoff = this.start(now);
    return this.events.filter((e) => e.t >= cutoff);
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Nearest frame with frame.t <= t (binary search). null if none. */
  frameAt(t: number): ReplayFrame | null {
    const f = this.frames;
    if (!f.length) return null;
    if (t <= f[0].t) return f[0];
    if (t >= f[f.length - 1].t) return f[f.length - 1];
    let lo = 0;
    let hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return f[lo];
  }

  // ── Persistence (localStorage spill-over) ──────────────────────────────────

  private scheduleSave(): void {
    if (!this.persist || this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.save();
    }, 5000);
  }

  private save(): void {
    try {
      const frames = this.frames.slice(-this.persistCap);
      const payload = JSON.stringify({ v: 1, frames, events: this.events.slice(-2000) });
      localStorage.setItem(LS_KEY, payload);
    } catch {
      // Quota exceeded or storage disabled — degrade to in-memory only.
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { frames?: ReplayFrame[]; events?: ReplayEvent[] };
      if (Array.isArray(data.frames)) this.frames = data.frames;
      if (Array.isArray(data.events)) this.events = data.events;
      const last = this.frames[this.frames.length - 1];
      if (last) for (const a of last.agents) this.prevStatus.set(a.id, a.status);
    } catch {
      /* corrupt payload — ignore */
    }
  }
}

let singleton: FrameStore | null = null;
export function getFrameStore(): FrameStore {
  if (!singleton) singleton = new FrameStore();
  return singleton;
}
