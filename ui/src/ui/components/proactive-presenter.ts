/**
 * <proactive-presenter> — center-stage focus stage + seamless PRESENCE ROTATION.
 *
 * This is the PRIMARY surface for proactive pop-ups. It is NOT a corner toast:
 * it dims + blurs the entire viewport so the presenter IS the focus of the page,
 * and it floats one large draggable glass card that auto-rotates through every
 * pending NOTABLE / CRITICAL event (plain-text AND media-rich) with smooth WAAPI
 * cross-dissolves — a "presence rotation with no gaps". When a new event arrives
 * mid-rotation it slots into the queue without flicker; when an event is acted on
 * it drops out and the deck closes the gap. Only true FYI pops stay as small
 * corner toasts; `walkthrough` keeps its own narrated overlay.
 *
 * Surface contract:
 *   • full-viewport dim + blur backdrop (click-out dismisses the whole deck)
 *   • ≥60vw × 70vh card (responsive clamps; near-full on mobile), draggable
 *   • cross-dissolve rotation: outgoing scene fades over the already-present
 *     incoming scene → never a blank frame between scenes
 *   • auto-advance (content-aware dwell) + manual prev / next / pause, progress
 *     dots, "dismiss this" vs backdrop "dismiss all"
 *   • plain-text scenes render as a premium focus card; media scenes host the
 *     existing per-kind <proactive-media> renderers as the centrepiece
 *   • InteractiveOverlay: registers the CURRENT event's id and forwards live
 *     interact ops (timeline.pause/play/seek, element.cue/hold, next/prev…) to
 *     the nested interactive renderer; re-registers as the deck rotates.
 *
 * Design language: strict black/gold glassmorphism. Gold on borders / accents
 * only, never as a fill. 8px+ gap from the panel edge.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { PopupEvent, PopupAction, PopupInteract } from "./proactive-popup-shared.js";
import { agentColor } from "./proactive-popup-shared.js";
import "./proactive-media/index.js";
import {
  registerOverlay,
  unregisterOverlay,
  type InteractiveOverlay,
} from "./proactive-media/interactive-registry.js";
import { kenBurns, slideGlow } from "./proactive-media/animations.js";

@customElement("proactive-presenter")
export class ProactivePresenter extends LitElement implements InteractiveOverlay {
  /** The rotation queue — every pending NOTABLE/CRITICAL pop, newest first. */
  @property({ attribute: false }) events: PopupEvent[] = [];
  /** 1 = full focus stage; < 1 shrinks the card (kept for callers). */
  @property({ type: Number }) scale = 1;

  @state() private index = 0;
  @state() private outgoing: PopupEvent | null = null;
  @state() private paused = false;
  @state() private dragX = 0;
  @state() private dragY = 0;

  /** Track the focused event by id so a re-sorted/extended queue never jumps. */
  private currentId: string | null = null;
  private slideDir = 1;
  private rotateTimer: number | null = null;
  private registeredId: string | null = null;

  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private originX = 0;
  private originY = 0;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

  /** Live (non-walkthrough) scenes. */
  private get scenes(): PopupEvent[] {
    return this.events.filter((e) => e.media?.kind !== "walkthrough");
  }
  private get current(): PopupEvent | null {
    return this.scenes[this.index] ?? null;
  }
  get eventId(): string {
    return this.current?.id ?? "";
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.keyHandler);
    this.syncToQueue(true);
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearTimer();
    this.deregister();
    window.removeEventListener("keydown", this.keyHandler);
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("events")) this.syncToQueue(false);
  }
  protected firstUpdated(): void {
    this.registerCurrent();
    this.applyStagePresets();
    this.scheduleAdvance();
  }

  /** Reconcile internal index with a freshly-set queue (arrival / removal). */
  private syncToQueue(initial: boolean): void {
    const list = this.scenes;
    if (list.length === 0) {
      this.currentId = null;
      this.clearTimer();
      this.deregister();
      return;
    }
    // Keep the user on the same event if it survived; otherwise clamp.
    let idx = this.currentId ? list.findIndex((e) => e.id === this.currentId) : -1;
    if (idx < 0) idx = Math.min(this.index, list.length - 1);
    this.index = idx;
    this.currentId = list[idx].id;
    if (!initial) {
      this.registerCurrent();
      this.scheduleAdvance();
    }
  }

  // ── rotation ────────────────────────────────────────────────────────────────
  private clearTimer(): void {
    if (this.rotateTimer != null) {
      window.clearTimeout(this.rotateTimer);
      this.rotateTimer = null;
    }
  }

  /** Content-aware dwell: media kinds that animate get longer; text scales with
   *  length. Single-scene decks never auto-advance. */
  private dwellMs(e: PopupEvent | null): number {
    if (!e) return 8000;
    const kind = e.media?.kind;
    if (kind === "stylized-markdown" || kind === "card-deck") return 16000;
    if (kind === "video") return 18000;
    if (kind === "image" || kind === "pdf" || kind === "html") return 11000;
    if (kind) return 10000;
    const len = (e.body?.length ?? 0) + (e.title?.length ?? 0);
    return Math.min(13000, Math.max(5500, 70 * Math.sqrt(len)));
  }

  private scheduleAdvance(): void {
    this.clearTimer();
    if (this.paused || this.scenes.length <= 1) return;
    this.rotateTimer = window.setTimeout(() => this.go(1, false), this.dwellMs(this.current));
  }

  /** Advance the deck by `dir` (with wrap). `manual` resets the dwell clock. */
  private go(dir: number, manual: boolean): void {
    const list = this.scenes;
    if (list.length <= 1) return;
    const from = this.current;
    const next = (this.index + dir + list.length) % list.length;
    if (next === this.index) return;
    this.slideDir = dir >= 0 ? 1 : -1;
    this.outgoing = from;
    this.index = next;
    this.currentId = list[next].id;
    this.registerCurrent();
    this.runCrossfade();
    this.applyStagePresets();
    if (manual && this.paused) {
      // manual nav while paused: stay paused, no timer
    } else {
      this.scheduleAdvance();
    }
  }

  private gotoIndex(target: number): void {
    if (target === this.index) return;
    this.go(target > this.index ? 1 : -1, true);
  }

  private togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) this.clearTimer();
    else this.scheduleAdvance();
  }

  /** WAAPI cross-dissolve: the incoming scene is already painted underneath, so
   *  fading the outgoing layer out over it leaves NO blank frame. */
  private runCrossfade(): void {
    requestAnimationFrame(() => {
      const out = this.renderRoot.querySelector(".pp-layer.out") as HTMLElement | null;
      const inc = this.renderRoot.querySelector(".pp-layer.in") as HTMLElement | null;
      const dx = this.slideDir * 26;
      if (inc) {
        inc.animate(
          [
            { opacity: 0.35, transform: `translateX(${dx}px)` },
            { opacity: 1, transform: "translateX(0)" },
          ],
          { duration: 460, easing: "cubic-bezier(0.2,0.7,0.2,1)" },
        );
      }
      if (out) {
        const anim = out.animate(
          [
            { opacity: 1, transform: "translateX(0)", filter: "blur(0px)" },
            { opacity: 0, transform: `translateX(${-dx}px)`, filter: "blur(3px)" },
          ],
          { duration: 420, easing: "cubic-bezier(0.4,0,0.6,1)" },
        );
        anim.finished.then(() => {
          this.outgoing = null;
        }).catch(() => {
          this.outgoing = null;
        });
      } else {
        this.outgoing = null;
      }
    });
  }

  /** Cinematic entrance for the current static-media scene. */
  private applyStagePresets(): void {
    const kind = this.current?.media?.kind;
    requestAnimationFrame(() => {
      const layer = this.renderRoot.querySelector(".pp-layer.in");
      const title = layer?.querySelector(".pp-title") as HTMLElement | null;
      if (title) slideGlow(title, { durationMs: 460 });
      if (!kind || kind === "stylized-markdown" || kind === "card-deck") return;
      const img = layer?.querySelector("img") as HTMLElement | null;
      if (img) kenBurns(img, { seed: this.index });
    });
  }

  // ── interact registry ────────────────────────────────────────────────────────
  private registerCurrent(): void {
    const id = this.eventId;
    if (id === this.registeredId) return;
    this.deregister();
    if (id) {
      registerOverlay(this);
      this.registeredId = id;
    }
  }
  private deregister(): void {
    if (this.registeredId) {
      unregisterOverlay(this);
      this.registeredId = null;
    }
  }

  applyInteract(interact: PopupInteract): boolean {
    switch (interact.op) {
      case "dismiss":
        this.dispatchDismiss(this.current);
        return true;
      case "next":
        this.go(1, true);
        return true;
      case "prev":
        this.go(-1, true);
        return true;
      case "timeline.pause":
        this.paused = true;
        this.clearTimer();
        return this.forward(interact) || true;
      case "timeline.play":
        this.paused = false;
        this.scheduleAdvance();
        return this.forward(interact) || true;
      default:
        return this.forward(interact);
    }
  }

  private forward(interact: PopupInteract): boolean {
    const inner = this.innerOverlay();
    if (!inner) return false;
    try {
      return inner.applyInteract(interact);
    } catch {
      return false;
    }
  }

  /** Resolve the nested stylized-markdown / card-deck overlay of the IN layer. */
  private innerOverlay(): InteractiveOverlay | null {
    const media = this.renderRoot.querySelector(".pp-layer.in proactive-media") as
      | (HTMLElement & { renderRoot?: ParentNode })
      | null;
    const root = media?.renderRoot ?? media?.shadowRoot ?? null;
    if (!root) return null;
    const el = (root as ParentNode).querySelector(
      "stylized-markdown-overlay, card-deck-overlay",
    ) as unknown as InteractiveOverlay | null;
    return el && typeof el.applyInteract === "function" ? el : null;
  }

  // ── drag ───────────────────────────────────────────────────────────────────
  private onDragStart = (e: PointerEvent): void => {
    if ((e.target as HTMLElement)?.closest(".pp-x, .pp-ctl")) return;
    this.dragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.originX = this.dragX;
    this.originY = this.dragY;
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
  };
  private onDragMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragX = this.originX + (e.clientX - this.dragStartX);
    this.dragY = this.originY + (e.clientY - this.dragStartY);
  };
  private onDragEnd = (): void => {
    this.dragging = false;
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
  };

  // ── dismiss / actions ────────────────────────────────────────────────────────
  /** Dismiss one event (the deck closes the gap via the host re-feeding events). */
  private dispatchDismiss(ev: PopupEvent | null): void {
    if (!ev) return;
    this.dispatchEvent(
      new CustomEvent("pmedia-dismiss", {
        bubbles: true,
        composed: true,
        detail: { eventId: ev.id },
      }),
    );
  }
  /** Backdrop click → dismiss the whole deck. */
  private dismissAll(): void {
    for (const ev of [...this.scenes]) this.dispatchDismiss(ev);
  }
  private emitAction(ev: PopupEvent, action: PopupAction): void {
    this.dispatchEvent(
      new CustomEvent("popup-action", {
        bubbles: true,
        composed: true,
        detail: { event: ev, action },
      }),
    );
  }
  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.dispatchDismiss(this.current);
    } else if (e.key === "ArrowRight") {
      this.go(1, true);
    } else if (e.key === "ArrowLeft") {
      this.go(-1, true);
    } else if (e.key === " ") {
      e.preventDefault();
      this.togglePause();
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────
  render() {
    const list = this.scenes;
    const cur = this.current;
    if (!cur) return nothing;
    const cardTransform = `translate(${this.dragX}px, ${this.dragY}px) scale(${this.scale})`;
    const multi = list.length > 1;
    return html`
      <div
        class="pp-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label=${cur.title || "Focus presenter"}
        @click=${(e: MouseEvent) => {
          if (e.target === e.currentTarget) this.dismissAll();
        }}
      >
        <div class="pp-card" style=${`transform:${cardTransform}`}>
          <div class="pp-topbar" @pointerdown=${this.onDragStart}>
            <span class="pp-grip" aria-hidden="true">⠿</span>
            <span class="pp-deck-label"
              >${multi ? html`Presence rotation · ${this.index + 1}/${list.length}` : "Focus"}</span
            >
            ${this.paused ? html`<span class="pp-paused">paused</span>` : nothing}
            <button class="pp-x" aria-label="Dismiss this" title="Dismiss this" @click=${() => this.dispatchDismiss(cur)}>
              ✕
            </button>
          </div>

          <div class="pp-viewport">
            ${this.outgoing ? this.renderScene(this.outgoing, "out") : nothing}
            ${this.renderScene(cur, "in")}
          </div>

          <footer class="pp-foot">
            ${multi
              ? html`
                  <button class="pp-ctl" aria-label="Previous" @click=${() => this.go(-1, true)}>‹</button>
                  <div class="pp-dots">
                    ${list.map(
                      (_, i) =>
                        html`<button
                          class="pp-dot ${i === this.index ? "on" : ""}"
                          aria-label=${`Scene ${i + 1}`}
                          @click=${() => this.gotoIndex(i)}
                        ></button>`,
                    )}
                  </div>
                  <button class="pp-ctl" aria-label="Next" @click=${() => this.go(1, true)}>›</button>
                  <button class="pp-ctl" aria-label=${this.paused ? "Play" : "Pause"} @click=${() => this.togglePause()}>
                    ${this.paused ? "▶" : "❚❚"}
                  </button>
                `
              : html`<span class="pp-kind">${cur.media?.kind ?? "message"}</span>`}
            <span class="pp-hint">${multi ? "← → to navigate · esc dismisses" : "drag to move · esc to dismiss"}</span>
          </footer>
        </div>
      </div>
    `;
  }

  /** A single scene layer (plain-text focus card OR media stage). */
  private renderScene(ev: PopupEvent, role: "in" | "out") {
    const a = ev.attribution;
    const ac = agentColor(a.agentId);
    const isMedia = !!ev.media && ev.media.kind !== "walkthrough";
    return html`
      <div class="pp-layer ${role}">
        <header class="pp-head">
          <span class="pp-chip" style=${`--ac:${ac}`}>${a.agentName || a.agentId}</span>
          <span class="pp-tier pp-tier-${ev.appliedTier.toLowerCase()}">${ev.appliedTier}</span>
          <span class="pp-title">${ev.title}</span>
        </header>
        ${isMedia
          ? html`
              ${ev.body ? html`<div class="pp-body-text">${ev.body}</div>` : nothing}
              <div class="pp-stage">
                <proactive-media .media=${ev.media} .eventId=${""}></proactive-media>
              </div>
            `
          : html`
              <div class="pp-text-stage">
                <p class="pp-lead">${ev.body || ev.title}</p>
              </div>
            `}
        ${ev.actions?.length
          ? html`<div class="pp-actions">
              ${ev.actions.map(
                (act) =>
                  html`<button
                    class="pp-act ${act.primary ? "primary" : ""}"
                    @click=${() => this.emitAction(ev, act)}
                  >
                    ${act.label}
                  </button>`,
              )}
            </div>`
          : nothing}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 9992;
      pointer-events: auto;
    }
    .pp-backdrop {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: radial-gradient(
        ellipse at center,
        rgba(8, 6, 2, 0.62) 0%,
        rgba(2, 2, 4, 0.92) 100%
      );
      backdrop-filter: blur(14px) saturate(1.1);
      -webkit-backdrop-filter: blur(14px) saturate(1.1);
      animation: pp-fade 220ms ease-out;
    }
    @keyframes pp-fade {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .pp-card {
      position: relative;
      width: clamp(360px, 64vw, 1180px);
      height: clamp(440px, 72vh, 900px);
      display: flex;
      flex-direction: column;
      padding: 14px 18px 12px;
      background: linear-gradient(
        145deg,
        rgba(26, 21, 8, 0.76) 0%,
        rgba(14, 12, 8, 0.86) 60%,
        rgba(10, 8, 4, 0.92) 100%
      );
      border: 1px solid color-mix(in srgb, var(--gold-1, #d4af37) 38%, transparent);
      border-radius: 22px;
      box-shadow:
        0 0 0 1px rgba(212, 175, 55, 0.1),
        0 30px 90px -20px rgba(0, 0, 0, 0.82),
        0 0 90px -22px rgba(212, 175, 55, 0.18);
      color: var(--g-fg, #f5eacd);
      backdrop-filter: blur(22px);
      -webkit-backdrop-filter: blur(22px);
      animation: pp-rise 320ms cubic-bezier(0.2, 0.7, 0.2, 1);
      transform-origin: center center;
      overflow: hidden;
    }
    @keyframes pp-rise {
      from { opacity: 0; transform: translateY(20px) scale(0.97); }
      to { opacity: 1; }
    }
    /* drag handle */
    .pp-topbar {
      display: flex;
      align-items: center;
      gap: 10px;
      cursor: grab;
      user-select: none;
      padding: 2px 2px 10px;
      border-bottom: 1px solid rgba(212, 175, 55, 0.14);
    }
    .pp-topbar:active { cursor: grabbing; }
    .pp-grip {
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.4));
      font-size: 0.95rem;
      letter-spacing: -2px;
    }
    .pp-deck-label {
      flex: 1;
      font-size: 0.6rem;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--gold-1, #d4af37);
    }
    .pp-paused {
      font-size: 0.58rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.55));
    }
    .pp-x {
      background: transparent;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.6));
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      width: 28px;
      height: 28px;
      cursor: pointer;
      font-size: 0.78rem;
    }
    .pp-x:hover { color: var(--g-fg, #f5eacd); border-color: var(--gold-1, #d4af37); }

    /* rotation viewport — layers stack so cross-dissolve has no blank frame */
    .pp-viewport {
      position: relative;
      flex: 1;
      min-height: 0;
      margin-top: 12px;
    }
    .pp-layer {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 0;
      height: 100%;
    }
    .pp-layer.in { position: relative; z-index: 1; }
    .pp-layer.out {
      position: absolute;
      inset: 0;
      z-index: 2;
      pointer-events: none;
    }

    .pp-head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pp-chip {
      font-size: 0.6rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ac, var(--gold-1, #d4af37));
      border: 1px solid color-mix(in srgb, var(--ac, #d4af37) 44%, transparent);
      border-radius: 5px;
      padding: 2px 7px;
      white-space: nowrap;
    }
    .pp-tier {
      font-size: 0.52rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      border-radius: 4px;
      padding: 2px 6px;
      border: 1px solid currentColor;
      opacity: 0.85;
    }
    .pp-tier-critical { color: #ff8a6b; }
    .pp-tier-notable { color: var(--gold-1, #d4af37); }
    .pp-tier-fyi, .pp-tier-ambient { color: rgba(245, 234, 205, 0.5); }
    .pp-title {
      flex: 1;
      font-size: 1rem;
      font-weight: 700;
      color: var(--g-fg, #f5eacd);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pp-body-text {
      font-size: 0.84rem;
      line-height: 1.5;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.82));
    }
    .pp-stage {
      flex: 1;
      overflow: auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .pp-stage proactive-media { flex: 1; }

    /* plain-text focus scene */
    .pp-text-stage {
      flex: 1;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: auto;
      padding: 8px 6%;
    }
    .pp-lead {
      margin: 0;
      font-size: clamp(1.1rem, 2.2vw, 1.7rem);
      line-height: 1.5;
      font-weight: 500;
      text-align: center;
      letter-spacing: 0.01em;
      color: var(--g-fg, #f5eacd);
      text-shadow: 0 1px 24px rgba(212, 175, 55, 0.12);
    }

    .pp-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
    }
    .pp-act {
      background: transparent;
      color: var(--g-fg, #f5eacd);
      border: 1px solid rgba(212, 175, 55, 0.3);
      border-radius: 9px;
      padding: 7px 14px;
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .pp-act:hover { border-color: var(--gold-1, #d4af37); }
    .pp-act.primary {
      border-color: var(--gold-1, #d4af37);
      background: color-mix(in srgb, var(--gold-1, #d4af37) 14%, transparent);
    }

    /* footer: rotation controls */
    .pp-foot {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-top: 10px;
      margin-top: 10px;
      border-top: 1px solid rgba(212, 175, 55, 0.14);
    }
    .pp-ctl {
      background: transparent;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.7));
      border: 1px solid rgba(212, 175, 55, 0.22);
      border-radius: 8px;
      min-width: 30px;
      height: 28px;
      padding: 0 8px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .pp-ctl:hover { color: var(--g-fg, #f5eacd); border-color: var(--gold-1, #d4af37); }
    .pp-dots {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .pp-dot {
      width: 8px;
      height: 8px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid rgba(212, 175, 55, 0.4);
      background: transparent;
      cursor: pointer;
      transition: background 0.2s, transform 0.2s;
    }
    .pp-dot.on {
      background: var(--gold-1, #d4af37);
      transform: scale(1.25);
    }
    .pp-kind {
      font-size: 0.58rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--gold-1, #d4af37);
    }
    .pp-hint {
      margin-left: auto;
      font-size: 0.62rem;
      letter-spacing: 0.08em;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.45));
    }
    @media (max-width: 640px) {
      .pp-backdrop { padding: 10px; }
      .pp-card { width: 96vw; height: 88vh; }
    }
    @media (prefers-reduced-motion: reduce) {
      .pp-backdrop, .pp-card { animation: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "proactive-presenter": ProactivePresenter;
  }
}
