/**
 * <proactive-toast> — corner toast stack for NOTABLE + media-rich pop-ups.
 *
 * Per-event state machine (AC7):
 *   entering → visible(countdown) → questionnaire (media-rich, no interaction)
 *                                 → pinned | snoozed | dismissed
 *
 * Each card carries an SVG countdown ring, renders any rich `media` payload via
 * <proactive-media>, is draggable by its header (pinned cards persist their
 * position), and is fully keyboard-driven (Enter primary / S snooze / D dismiss
 * / E expand). When the timer elapses a media-rich card mutates into a "Keep on
 * screen?" questionnaire instead of vanishing; plain NOTABLE cards slide back to
 * the panel as before.
 *
 * The host (<proactive-overlay-host>) curates `events` (already capped) and
 * listens for `popup-action` / `popup-expire`. Voice-synced highlighting is
 * driven by {@link beginVoiceSequence}, called by the host.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./proactive-media/index.js";
import {
  agentColor,
  whyChipTitle,
  autoDismissMs,
  type PopupAction,
  type PopupEvent,
} from "./proactive-popup-shared.js";

type CardState = "visible" | "questionnaire";

interface VoiceSegment {
  startMs: number;
  endMs: number;
  highlightSelector: string;
}

const DRAG_KEY = "infinibot-proactive-toast-pos";

function loadPositions(): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(DRAG_KEY);
    const p = raw ? JSON.parse(raw) : {};
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}
function savePositions(m: Record<string, { x: number; y: number }>): void {
  try {
    localStorage.setItem(DRAG_KEY, JSON.stringify(m));
  } catch {
    /* storage disabled */
  }
}

@customElement("proactive-toast")
export class ProactiveToast extends LitElement {
  /** Pending NOTABLE / media events the host wants shown (already capped). */
  @property({ attribute: false }) events: PopupEvent[] = [];

  @state() private cardState = new Map<string, CardState>();
  @state() private positions: Record<string, { x: number; y: number }> = loadPositions();
  /** Event ids that have slid back to the panel (hidden from the toast view). */
  private slid = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Active voice-segment timers, so a new sequence can cancel the old. */
  private voiceTimers: ReturnType<typeof setTimeout>[] = [];

  // drag bookkeeping
  private dragId: string | null = null;
  private dragStart = { x: 0, y: 0, ox: 0, oy: 0 };

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.clearVoiceTimers();
    window.removeEventListener("keydown", this.onKey);
  }
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey);
  }

  protected updated(): void {
    // Arm the auto-dismiss timer for any newly-arrived event.
    for (const ev of this.events) {
      if (this.slid.has(ev.id) || this.timers.has(ev.id)) continue;
      if (this.cardState.get(ev.id) === "questionnaire") continue;
      if (ev.pinned) continue; // pinned = held until manually dismissed
      const t = setTimeout(() => this.onTimerElapsed(ev), autoDismissMs(ev));
      this.timers.set(ev.id, t);
    }
    // Drop timers for events that are gone.
    const live = new Set(this.events.map((e) => e.id));
    for (const [id, t] of this.timers) {
      if (!live.has(id)) {
        clearTimeout(t);
        this.timers.delete(id);
      }
    }
  }

  // ── state transitions ───────────────────────────────────────────────────────

  private onTimerElapsed(ev: PopupEvent): void {
    this.timers.delete(ev.id);
    if (ev.media) {
      // Media-rich → mutate into the "Keep on screen?" questionnaire.
      this.cardState.set(ev.id, "questionnaire");
      this.requestUpdate();
    } else {
      // Plain NOTABLE → slide back to the panel (legacy behaviour).
      this.expire(ev.id);
    }
  }

  private expire(id: string): void {
    this.slid.add(id);
    this.timers.delete(id);
    this.dispatchEvent(
      new CustomEvent("popup-expire", { detail: { id }, bubbles: true, composed: true }),
    );
    this.requestUpdate();
  }

  private act(ev: PopupEvent, action: PopupAction): void {
    this.dispatchEvent(
      new CustomEvent("popup-action", {
        detail: { event: ev, action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Questionnaire choices → synthesize a host action. */
  private pin(ev: PopupEvent): void {
    this.cardState.delete(ev.id);
    this.act(ev, { id: "pin", kind: "open", label: "Pin", payload: { __pin: true } });
    this.requestUpdate();
  }
  private snooze5(ev: PopupEvent): void {
    this.act(ev, { id: "snooze", kind: "snooze", label: "Snooze", payload: { duration: "5m" } });
  }
  private dismiss(ev: PopupEvent): void {
    this.act(ev, { id: "dismiss", kind: "dismiss", label: "Dismiss", payload: { reason: "dismissed from toast" } });
  }

  private why(ev: PopupEvent): void {
    this.dispatchEvent(
      new CustomEvent("popup-why", { detail: { event: ev }, bubbles: true, composed: true }),
    );
  }

  // ── voice-synced highlight (AC4) ────────────────────────────────────────────

  /**
   * Glow the matching `highlightSelector` inside the card for `eventId` while
   * the corresponding audio segment plays. When the last segment ends, the card
   * transitions to its questionnaire state. Called by the overlay host as voice
   * playback progresses.
   */
  beginVoiceSequence(eventId: string, segments: VoiceSegment[]): void {
    this.clearVoiceTimers();
    const card = this.renderRoot.querySelector<HTMLElement>(`[data-event-id="${eventId}"]`);
    if (!card) return;
    let lastEnd = 0;
    for (const seg of segments) {
      lastEnd = Math.max(lastEnd, seg.endMs);
      const onStart = setTimeout(() => {
        card.querySelectorAll<HTMLElement>(seg.highlightSelector).forEach((el) =>
          el.classList.add("pt-voice-glow"),
        );
      }, Math.max(0, seg.startMs));
      const onEnd = setTimeout(() => {
        card.querySelectorAll<HTMLElement>(seg.highlightSelector).forEach((el) =>
          el.classList.remove("pt-voice-glow"),
        );
      }, Math.max(0, seg.endMs));
      this.voiceTimers.push(onStart, onEnd);
    }
    // When the spoken sequence ends → questionnaire.
    const ev = this.events.find((e) => e.id === eventId);
    if (ev) {
      const finish = setTimeout(() => {
        this.cardState.set(eventId, "questionnaire");
        // Cancel the auto-dismiss timer; voice supersedes it.
        const t = this.timers.get(eventId);
        if (t) {
          clearTimeout(t);
          this.timers.delete(eventId);
        }
        this.requestUpdate();
      }, lastEnd + 250);
      this.voiceTimers.push(finish);
    }
  }

  private clearVoiceTimers(): void {
    for (const t of this.voiceTimers) clearTimeout(t);
    this.voiceTimers = [];
  }

  // ── keyboard model (AC5) ────────────────────────────────────────────────────

  private onKey = (e: KeyboardEvent): void => {
    const ev = this.visibleEvents()[0];
    if (!ev) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && /input|textarea/i.test(tgt.tagName)) return;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") {
      const primary = (ev.actions ?? []).find((a) => a.primary) ?? (ev.actions ?? [])[0];
      if (primary) {
        e.preventDefault();
        this.act(ev, primary);
      } else if (this.cardState.get(ev.id) === "questionnaire") {
        this.pin(ev);
      }
    } else if (k === "s") {
      this.snooze5(ev);
    } else if (k === "d") {
      this.dismiss(ev);
    } else if (k === "e") {
      this.why(ev);
    }
  };

  // ── drag (AC5) ──────────────────────────────────────────────────────────────

  private onDragStart(ev: PopupEvent, e: PointerEvent): void {
    if ((e.target as HTMLElement).closest("button")) return; // don't drag from a button
    this.dragId = ev.id;
    const cur = this.positions[ev.id] ?? { x: 0, y: 0 };
    this.dragStart = { x: e.clientX, y: e.clientY, ox: cur.x, oy: cur.y };
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
  }
  private onDragMove = (e: PointerEvent): void => {
    if (!this.dragId) return;
    const x = this.dragStart.ox + (e.clientX - this.dragStart.x);
    const y = this.dragStart.oy + (e.clientY - this.dragStart.y);
    this.positions = { ...this.positions, [this.dragId]: { x, y } };
  };
  private onDragEnd = (): void => {
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
    const id = this.dragId;
    this.dragId = null;
    // Persist position only for pinned cards (so they remember where you put them).
    if (id) {
      const ev = this.events.find((e) => e.id === id);
      if (ev?.pinned) savePositions(this.positions);
    }
  };

  // ── render ──────────────────────────────────────────────────────────────────

  private visibleEvents(): PopupEvent[] {
    return this.events.filter((e) => !this.slid.has(e.id));
  }

  render() {
    const all = this.visibleEvents();
    if (all.length === 0) return nothing;
    return html`<div class="pt-stack">${all.map((ev) => this.renderToast(ev))}</div>`;
  }

  private renderToast(ev: PopupEvent) {
    const color = agentColor(ev.attribution.agentId);
    const isQ = this.cardState.get(ev.id) === "questionnaire";
    const pos = this.positions[ev.id];
    const transform = pos ? `transform:translate(${pos.x}px,${pos.y}px)` : "";
    const dur = autoDismissMs(ev);
    return html`
      <div
        class="pt-toast ${ev.pinned ? "pinned" : ""} ${isQ ? "questionnaire" : ""}"
        role="status"
        data-event-id=${ev.id}
        style=${transform}
      >
        <div class="pt-head" @pointerdown=${(e: PointerEvent) => this.onDragStart(ev, e)}>
          <span class="pt-chip" style="--ac:${color}" title=${whyChipTitle(ev)}>
            <span class="pt-dot"></span>${ev.attribution.agentName || ev.attribution.agentId}
          </span>
          ${ev.pinned ? html`<span class="pt-pinbadge" title="Pinned">📌</span>` : nothing}
          ${!isQ ? this.renderRing(ev, dur) : nothing}
          <button
            class="pt-close"
            title="Slide back to panel"
            aria-label="Dismiss notification"
            @click=${() => this.expire(ev.id)}
          >
            ✕
          </button>
        </div>
        <div class="pt-title">${ev.title}</div>
        ${ev.body ? html`<div class="pt-body">${ev.body}</div>` : nothing}
        ${ev.media
          ? html`<proactive-media .media=${ev.media} .eventId=${ev.id} compact></proactive-media>`
          : nothing}
        ${isQ ? this.renderQuestionnaire(ev) : this.renderActions(ev)}
      </div>
    `;
  }

  /** SVG countdown ring — pure CSS dash animation over the auto-dismiss window. */
  private renderRing(ev: PopupEvent, durationMs: number) {
    return html`
      <span class="pt-ring" title="auto-review timer" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <circle class="pt-ring-track" cx="12" cy="12" r="9"></circle>
          <circle
            class="pt-ring-prog"
            cx="12"
            cy="12"
            r="9"
            style="animation-duration:${durationMs}ms"
          ></circle>
        </svg>
      </span>
    `;
  }

  private renderActions(ev: PopupEvent) {
    return html`
      <div class="pt-actions">
        ${(ev.actions ?? []).map(
          (a) => html`<button
            class="pt-btn ${a.primary ? "pt-btn-primary" : ""}"
            @click=${() => this.act(ev, a)}
          >
            ${a.label}
          </button>`,
        )}
        <button class="pt-why" @click=${() => this.why(ev)} aria-label="Why am I seeing this?">
          Why?
        </button>
      </div>
    `;
  }

  /** "Keep on screen?" prompt after the timer (or voice sequence) elapses. */
  private renderQuestionnaire(ev: PopupEvent) {
    return html`
      <div class="pt-quest" role="group" aria-label="Keep this on screen?">
        <span class="pt-quest-q">Keep on screen?</span>
        <div class="pt-quest-actions">
          <button class="pt-btn pt-btn-primary" @click=${() => this.pin(ev)} aria-label="Pin (Enter)">
            📌 Pin
          </button>
          <button class="pt-btn" @click=${() => this.snooze5(ev)} aria-label="Snooze 5 minutes (S)">
            Snooze 5m
          </button>
          <button class="pt-btn pt-btn-ghost" @click=${() => this.dismiss(ev)} aria-label="Dismiss (D)">
            Dismiss
          </button>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 9990;
      pointer-events: none;
    }
    .pt-stack {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 380px;
    }
    .pt-toast {
      pointer-events: auto;
      border: 1px solid var(--g-border, rgba(212, 175, 55, 0.4));
      border-left: 3px solid var(--gold-1, #fb923c);
      border-radius: 13px;
      background: var(--g-surface, rgba(18, 20, 30, 0.93));
      backdrop-filter: blur(12px);
      padding: 12px 14px;
      box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
      animation: pt-in 0.26s cubic-bezier(0.2, 0.7, 0.2, 1);
      will-change: transform, opacity;
    }
    .pt-toast.pinned {
      border-left-color: var(--gold-1, #d4af37);
      box-shadow: 0 14px 40px rgba(212, 175, 55, 0.22);
    }
    .pt-toast.questionnaire {
      border-left-color: #60a5fa;
    }
    @keyframes pt-in {
      from {
        opacity: 0;
        transform: translateX(24px);
      }
      to {
        opacity: 1;
      }
    }
    .pt-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      cursor: grab;
      touch-action: none;
    }
    .pt-head:active {
      cursor: grabbing;
    }
    .pt-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 0.68rem;
      font-weight: 700;
      color: var(--ac, #d4af37);
      background: color-mix(in srgb, var(--ac, #d4af37) 16%, transparent);
      border-radius: 6px;
      padding: 2px 7px;
    }
    .pt-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--ac, #d4af37);
    }
    .pt-pinbadge {
      font-size: 0.7rem;
    }
    .pt-ring {
      margin-left: auto;
      display: inline-flex;
    }
    .pt-ring-track {
      fill: none;
      stroke: rgba(255, 255, 255, 0.12);
      stroke-width: 2.5;
    }
    .pt-ring-prog {
      fill: none;
      stroke: var(--gold-1, #d4af37);
      stroke-width: 2.5;
      stroke-linecap: round;
      transform: rotate(-90deg);
      transform-origin: center;
      stroke-dasharray: 56.5;
      animation-name: pt-ring-spin;
      animation-timing-function: linear;
      animation-fill-mode: forwards;
    }
    @keyframes pt-ring-spin {
      from {
        stroke-dashoffset: 0;
      }
      to {
        stroke-dashoffset: 56.5;
      }
    }
    .pt-close {
      background: none;
      border: none;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.5));
      cursor: pointer;
      font-size: 0.8rem;
      padding: 0 2px;
    }
    .pt-ring + .pt-close {
      margin-left: 6px;
    }
    .pt-close:hover {
      color: var(--g-fg, #f5eacd);
    }
    .pt-title {
      font-weight: 800;
      color: var(--g-fg, #f5eacd);
      font-size: 0.92rem;
      line-height: 1.2;
    }
    .pt-body {
      font-size: 0.78rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.72));
      margin-top: 4px;
    }
    /* Voice-synced glow underline. */
    .pt-voice-glow {
      position: relative;
      color: var(--g-fg, #fff) !important;
      text-shadow: 0 0 10px rgba(212, 175, 55, 0.55);
      transition: text-shadow 0.18s ease;
    }
    .pt-voice-glow::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: -2px;
      height: 2px;
      border-radius: 2px;
      background: linear-gradient(90deg, transparent, var(--gold-1, #d4af37), transparent);
      box-shadow: 0 0 8px var(--gold-1, #d4af37);
      animation: pt-glow-pulse 0.9s ease-in-out infinite;
    }
    @keyframes pt-glow-pulse {
      0%,
      100% {
        opacity: 0.6;
      }
      50% {
        opacity: 1;
      }
    }
    .pt-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 10px;
      align-items: center;
    }
    .pt-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: var(--g-fg, #f5eacd);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 0.74rem;
      font-weight: 700;
      cursor: pointer;
    }
    .pt-btn:hover {
      background: rgba(255, 255, 255, 0.14);
    }
    .pt-btn:focus-visible {
      outline: 2px solid var(--gold-1, #d4af37);
      outline-offset: 1px;
    }
    .pt-btn-primary {
      background: var(--gold-1, #fb923c);
      color: #1a1206;
      border-color: var(--gold-1, #fb923c);
    }
    .pt-btn-ghost {
      background: none;
    }
    .pt-why {
      background: none;
      border: none;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.5));
      font-size: 0.72rem;
      cursor: pointer;
      text-decoration: underline dotted;
      margin-left: auto;
    }
    .pt-why:hover {
      color: var(--g-fg, #f5eacd);
    }
    /* questionnaire */
    .pt-quest {
      margin-top: 10px;
      padding-top: 9px;
      border-top: 1px dashed rgba(255, 255, 255, 0.14);
      animation: pt-in 0.2s ease-out;
    }
    .pt-quest-q {
      font-size: 0.74rem;
      font-weight: 700;
      color: #93c5fd;
    }
    .pt-quest-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 7px;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "proactive-toast": ProactiveToast;
  }
}
