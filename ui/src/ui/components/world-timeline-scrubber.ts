/**
 * <world-timeline-scrubber> — TIME-SCRUB REPLAY TIMELINE (Game-Functional Layer #2)
 *
 * A glassmorphic black/gold bottom bar pinned over the Agency World view that
 * replays the last hour (configurable) of agent activity — positions, status
 * changes, spawns, completions. Drag the handle / click the track to scrub
 * through time; play/pause and 0.5×–4× speed control replay; the Live toggle
 * pins to now (scrubbing back drops into replay mode automatically).
 *
 * It is fully self-contained and NEVER edits <agency-world-viz> or any other
 * world-* / iso layer. It only *reads* the screen-space agent feed the viz
 * already publishes (`window.__agentFxState`) via the ReplayCollector, and
 * *writes* a replay frame other layers can consume.
 *
 * ── BROADCAST CONTRACT ─────────────────────────────────────────────────────
 * While scrubbing/replaying (mode === "replay") the element publishes the
 * reconstructed world state at the scrubbed time T:
 *
 *   window.__worldReplayFrame = {
 *     t: number,                 // epoch ms being shown
 *     agents: Array<{ id, x, y, status, backend }>,
 *   };
 *   window.dispatchEvent(new CustomEvent("world-replay-frame", { detail }));
 *
 * In Live mode the element clears the override:
 *
 *   window.__worldReplayFrame = null;
 *
 * Other layers (agent-fx, emotes, atmosphere) should render
 * `window.__worldReplayFrame` when it is non-null, else fall back to live
 * `window.__agentFxState`. The shape intentionally matches FxAgent so existing
 * consumers can swap feeds with a single null-check.
 *
 * Mount as a sibling *after* the viz inside the world-map band:
 *   <agency-world-viz></agency-world-viz>
 *   <world-timeline-scrubber></world-timeline-scrubber>
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { getFrameStore, type FrameStore, type ReplayEventKind } from "./world-timeline-scrubber/frame-store.js";
import { getReplayCollector, type ReplayCollector } from "./world-timeline-scrubber/replay-collector.js";

type Mode = "live" | "replay";
const SPEEDS = [0.5, 1, 2, 4] as const;

const EVENT_COLOR: Record<ReplayEventKind, string> = {
  spawn: "#d4af37", // gold
  complete: "#34d399", // mint
  fail: "#dc143c", // crimson
  blocked: "#f59e0b", // amber
};

declare global {
  interface Window {
    __worldReplayFrame?: { t: number; agents: Array<{ id: string; x: number; y: number; status: string; backend?: string }> } | null;
  }
  interface HTMLElementTagNameMap {
    "world-timeline-scrubber": WorldTimelineScrubber;
  }
}

@customElement("world-timeline-scrubber")
export class WorldTimelineScrubber extends LitElement {
  /** Replay window length in minutes (default 60 = last hour). */
  @property({ type: Number, attribute: "window-minutes" }) windowMinutes = 60;

  @state() private mode: Mode = "live";
  @state() private playing = false;
  @state() private speed: (typeof SPEEDS)[number] = 1;
  /** Absolute scrubbed time (epoch ms). Meaningful only in replay mode. */
  @state() private currentT = 0;
  @state() private now = 0;

  private store: FrameStore = getFrameStore();
  private collector: ReplayCollector = getReplayCollector();
  private unsub: (() => void) | null = null;
  private raf = 0;
  private lastFrameTs = 0;
  private dragging = false;
  private lastRenderTs = 0;

  static styles = css`
    :host {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 60px;
      z-index: 20;
      display: block;
      pointer-events: auto;
      font-family: var(--font-mono, ui-monospace, "SF Mono", monospace);
      color: #e8e0c8;
      user-select: none;
    }
    .bar {
      height: 100%;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 0 16px;
      box-sizing: border-box;
      background: linear-gradient(180deg, rgba(8, 4, 1, 0.72), rgba(4, 2, 0, 0.92));
      backdrop-filter: blur(14px) saturate(1.2);
      -webkit-backdrop-filter: blur(14px) saturate(1.2);
      border-top: 1px solid rgba(212, 175, 55, 0.4);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 -10px 30px -16px rgba(0, 0, 0, 0.9);
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
    }
    button {
      font: inherit;
      font-size: 11px;
      letter-spacing: 0.04em;
      color: #e8e0c8;
      background: rgba(212, 175, 55, 0.08);
      border: 1px solid rgba(212, 175, 55, 0.28);
      border-radius: 6px;
      padding: 5px 9px;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
      min-width: 30px;
    }
    button:hover {
      background: rgba(212, 175, 55, 0.18);
      border-color: rgba(212, 175, 55, 0.5);
    }
    button[disabled] {
      opacity: 0.45;
      cursor: default;
      pointer-events: none;
    }
    .bar.empty .readout .rel {
      color: rgba(232, 224, 200, 0.55);
      font-weight: 600;
    }
    .empty-track {
      cursor: default;
      opacity: 0.5;
    }
    button.active {
      background: rgba(212, 175, 55, 0.85);
      border-color: #d4af37;
      color: #1a1200;
      font-weight: 700;
    }
    button.live {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #34d399;
      box-shadow: 0 0 6px #34d399;
    }
    button.live.replaying .dot {
      background: #f59e0b;
      box-shadow: 0 0 6px #f59e0b;
      animation: none;
    }
    button.live:not(.replaying) .dot {
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    .play {
      font-size: 13px;
      min-width: 34px;
    }
    /* ── Track ── */
    .track {
      position: relative;
      flex: 1 1 auto;
      height: 30px;
      cursor: pointer;
      display: flex;
      align-items: center;
    }
    .rail {
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      height: 6px;
      border-radius: 3px;
      background: rgba(212, 175, 55, 0.12);
      border: 1px solid rgba(212, 175, 55, 0.2);
      overflow: hidden;
    }
    .fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      background: linear-gradient(90deg, rgba(212, 175, 55, 0.15), rgba(212, 175, 55, 0.5));
    }
    .marker {
      position: absolute;
      top: 50%;
      width: 6px;
      height: 6px;
      margin-left: -3px;
      border-radius: 50%;
      transform: translateY(-50%);
      pointer-events: none;
      box-shadow: 0 0 5px currentColor;
    }
    .handle {
      position: absolute;
      top: 50%;
      width: 3px;
      height: 26px;
      margin-left: -1.5px;
      transform: translateY(-50%);
      background: #f4e4b8;
      border-radius: 2px;
      box-shadow: 0 0 8px rgba(244, 228, 184, 0.9), 0 0 2px #000;
      pointer-events: none;
    }
    .handle::after {
      content: "";
      position: absolute;
      top: -5px;
      left: 50%;
      transform: translateX(-50%);
      border-left: 5px solid transparent;
      border-right: 5px solid transparent;
      border-top: 6px solid #f4e4b8;
    }
    /* ── Readout ── */
    .readout {
      flex: 0 0 auto;
      text-align: right;
      line-height: 1.25;
      min-width: 116px;
    }
    .readout .rel {
      font-size: 12px;
      font-weight: 700;
      color: #f4e4b8;
    }
    .readout .abs {
      font-size: 10px;
      color: rgba(232, 224, 200, 0.6);
      letter-spacing: 0.03em;
    }
    @media (prefers-reduced-motion: reduce) {
      button.live:not(.replaying) .dot { animation: none; }
    }
  `;

  // ── Lifecycle ───────────────────────────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback();
    this.now = Date.now();
    this.currentT = this.now;
    this.store = getFrameStore();
    this.collector.acquire();
    this.unsub = this.store.onChange(() => this.requestUpdate());
    window.addEventListener("world-resume-live", this.onResumeLive);
    this.loop();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    this.collector.release();
    this.unsub?.();
    this.unsub = null;
    window.removeEventListener("world-resume-live", this.onResumeLive);
    if (window.__worldReplayFrame) window.__worldReplayFrame = null;
  }

  /** The viz "▶ REPLAY @ …" badge fires this to drop back to Live. */
  private readonly onResumeLive = (): void => {
    if (this.mode !== "live") this.setLive();
  };

  private get windowMs(): number {
    return this.windowMinutes * 60 * 1000;
  }

  // ── Playback loop ─────────────────────────────────────────────────────────

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const ts = performance.now();
    const dtMs = this.lastFrameTs ? ts - this.lastFrameTs : 0;
    this.lastFrameTs = ts;
    this.now = Date.now();

    if (this.mode === "live") {
      this.currentT = this.now;
      if (window.__worldReplayFrame) window.__worldReplayFrame = null;
    } else {
      if (this.playing) {
        this.currentT += dtMs * this.speed;
        if (this.currentT >= this.now) {
          this.setLive();
          return;
        }
      }
      // Keep scrubbed time inside the retained window.
      const min = this.store.start(this.now);
      if (this.currentT < min) this.currentT = min;
      this.broadcast();
    }

    // Throttle re-render to ~20fps; the rest is silent state advancement.
    if (ts - this.lastRenderTs > 50) {
      this.lastRenderTs = ts;
      this.requestUpdate();
    }
  };

  private broadcast(): void {
    const frame = this.store.frameAt(this.currentT);
    const detail = { t: this.currentT, agents: frame ? frame.agents : [] };
    window.__worldReplayFrame = detail;
    window.dispatchEvent(new CustomEvent("world-replay-frame", { detail }));
  }

  // ── Mode / control handlers ─────────────────────────────────────────────

  private setLive(): void {
    this.mode = "live";
    this.playing = false;
    this.currentT = this.now = Date.now();
    if (window.__worldReplayFrame) window.__worldReplayFrame = null;
    // Notify consumers that replay ended (the live loop never dispatches the
    // event, so without this the viz's "▶ REPLAY @ …" badge would linger).
    window.dispatchEvent(new CustomEvent("world-replay-frame", { detail: null }));
    this.requestUpdate();
  }

  private enterReplay(t: number): void {
    this.mode = "replay";
    this.currentT = t;
    this.requestUpdate();
  }

  private togglePlay(): void {
    if (!this.hasHistory) return;
    if (this.mode === "live") {
      // Start replay from the oldest retained frame.
      this.enterReplay(this.store.start(Date.now()));
    }
    this.playing = !this.playing;
  }

  private cycleSpeed(): void {
    const i = SPEEDS.indexOf(this.speed);
    this.speed = SPEEDS[(i + 1) % SPEEDS.length];
  }

  // ── Track interaction ─────────────────────────────────────────────────────

  private ratioToTime(ratio: number): number {
    const r = Math.max(0, Math.min(1, ratio));
    return this.store.start(this.now) + r * this.windowMs;
  }

  private timeToRatio(t: number): number {
    const r = (t - this.store.start(this.now)) / this.windowMs;
    return Math.max(0, Math.min(1, r));
  }

  private ratioFromEvent(e: PointerEvent): number {
    const track = this.renderRoot.querySelector(".track") as HTMLElement | null;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return (e.clientX - rect.left) / Math.max(1, rect.width);
  }

  /** True once enough frames exist to actually replay something. */
  private get hasHistory(): boolean {
    return this.store.frameCount >= 2;
  }

  private onTrackDown = (e: PointerEvent): void => {
    if (!this.hasHistory) return;
    this.dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.enterReplay(this.ratioToTime(this.ratioFromEvent(e)));
    this.broadcast();
  };

  private onTrackMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.enterReplay(this.ratioToTime(this.ratioFromEvent(e)));
    this.broadcast();
  };

  private onTrackUp = (e: PointerEvent): void => {
    this.dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may already be released */
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  private fmtClock(t: number): string {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  private fmtRel(): string {
    if (this.mode === "live") return "LIVE";
    const back = Math.max(0, Math.round((this.now - this.currentT) / 1000));
    const m = Math.floor(back / 60);
    const s = back % 60;
    return m > 0 ? `−${m}m ${s}s` : `−${s}s`;
  }

  render() {
    if (!this.hasHistory) {
      return html`
        <div class="bar empty">
          <div class="controls">
            <button class="live" disabled title="Recording — history will appear shortly">
              <span class="dot"></span>LIVE
            </button>
          </div>
          <div class="track empty-track"><div class="rail"></div></div>
          <div class="readout"><div class="rel">No history yet</div><div class="abs">recording…</div></div>
        </div>
      `;
    }
    const ratio = this.mode === "live" ? 1 : this.timeToRatio(this.currentT);
    const fillPct = (ratio * 100).toFixed(2);
    const events = this.store.eventsInWindow(this.now);
    const replaying = this.mode === "replay";

    return html`
      <div class="bar">
        <div class="controls">
          <button
            class="live ${replaying ? "replaying" : ""}"
            title=${replaying ? "Return to live" : "Live — pinned to now"}
            @click=${() => this.setLive()}
          >
            <span class="dot"></span>${replaying ? "REPLAY" : "LIVE"}
          </button>
          <button class="play" title=${this.playing ? "Pause" : "Play"} @click=${() => this.togglePlay()}>
            ${this.playing ? "⏸" : "▶"}
          </button>
          <button title="Playback speed" @click=${() => this.cycleSpeed()}>${this.speed}×</button>
        </div>

        <div
          class="track"
          @pointerdown=${this.onTrackDown}
          @pointermove=${this.onTrackMove}
          @pointerup=${this.onTrackUp}
          @pointercancel=${this.onTrackUp}
        >
          <div class="rail"><div class="fill" style="width:${fillPct}%"></div></div>
          ${events.map((ev) => {
            const left = (this.timeToRatio(ev.t) * 100).toFixed(3);
            return html`<span
              class="marker"
              title=${`${ev.kind} · ${ev.label ?? ev.id} · ${this.fmtClock(ev.t)}`}
              style=${`left:${left}%;background:${EVENT_COLOR[ev.kind]};color:${EVENT_COLOR[ev.kind]}`}
            ></span>`;
          })}
          <div class="handle" style="left:${fillPct}%"></div>
        </div>

        <div class="readout">
          <div class="rel">${this.fmtRel()}</div>
          <div class="abs">${this.fmtClock(this.mode === "live" ? this.now : this.currentT)}</div>
        </div>
      </div>
    `;
  }
}
