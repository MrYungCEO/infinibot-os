/**
 * <walkthrough-overlay> — center-stage narrated presenter.
 *
 * The default response surface for voice-mode agents on any non-trivial reply.
 * Renders ONE scene at a time, large, with a fade+rise reveal animation. Each
 * scene carries its own narration chunk, shown as a caption and paced by
 * reading time (voice runs on Robovoice — there is no local text-to-speech);
 * the next scene advances after reading time + `holdMs`, or on manual next /
 * → key.
 *
 * Mounted by <proactive-overlay-host> as its own surface (full viewport, owns
 * the screen) — distinct from toasts / later-stack tiles. Walkthrough events
 * are filtered out of those collections so they don't double-render.
 *
 * Choice scenes emit `proactive.interact` frames with the chosen value so the
 * agent can branch. Live agent control (highlight/next/prev/dismiss) is routed
 * through the existing interactive-registry by eventId.
 *
 * Design language: strict black/gold glassmorphism (see feedback memory). No
 * cyan / rainbow accents. Variables follow the --g-* / --gold-* token family
 * already in use elsewhere in the overlay system.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  WalkthroughMedia,
  WalkthroughScene,
  WalkthroughChoiceContent,
  WalkthroughCodeContent,
  WalkthroughImageContent,
  PopupInteract,
} from "./proactive-popup-shared.js";
import {
  registerOverlay,
  unregisterOverlay,
  type InteractiveOverlay,
} from "./proactive-media/interactive-registry.js";
import {
  slideGlow,
  stagger,
  typeIn,
  kenBurns,
  pulse,
} from "./proactive-media/animations.js";

// Default per-scene reveal animation duration.
const DEFAULT_REVEAL_MS = 600;
// Default extra hold after audio ends before auto-advance.
const DEFAULT_HOLD_MS = 400;

@customElement("walkthrough-overlay")
export class WalkthroughOverlay extends LitElement implements InteractiveOverlay {
  /** The walkthrough payload. */
  @property({ attribute: false }) payload: WalkthroughMedia | null = null;
  /** Owning proactive event id — used by the interactive-registry. */
  @property({ type: String }) eventId = "";

  @state() private index = 0;
  @state() private revealedAt = 0;
  @state() private paused = false;
  @state() private audioPlaying = false;

  private audio: HTMLAudioElement | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  /** Live per-element reveal animations for the current scene — pausable /
   *  seekable via the interact channel (timeline.pause/play/seek). */
  private revealAnims: Animation[] = [];

  // ── lifecycle ─────────────────────────────────────────────────────────────
  connectedCallback(): void {
    super.connectedCallback();
    if (this.eventId) registerOverlay(this);
    window.addEventListener("keydown", this.keyHandler);
    this.revealedAt = performance.now();
    void this.speakCurrentScene();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.eventId) unregisterOverlay(this);
    window.removeEventListener("keydown", this.keyHandler);
    this.stopAudio();
    this.clearHoldTimer();
    for (const a of this.revealAnims) {
      try {
        a.cancel();
      } catch {
        /* ignore */
      }
    }
    this.revealAnims = [];
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("index")) {
      this.revealedAt = performance.now();
      this.runSceneReveal();
      void this.speakCurrentScene();
    }
  }

  protected firstUpdated(): void {
    this.runSceneReveal();
  }

  // ── per-element WAAPI reveal (pausable / seekable) ─────────────────────────
  /**
   * Animate the current scene's content elements with kind-specific presets,
   * tracking the live `Animation` handles so the interact channel can pause /
   * seek them in sync with narration. Runs after paint via rAF.
   */
  private runSceneReveal(): void {
    // Cancel any leftover animations from the previous scene.
    for (const a of this.revealAnims) {
      try {
        a.cancel();
      } catch {
        /* ignore */
      }
    }
    this.revealAnims = [];
    const scene = this.current;
    if (!scene) return;
    requestAnimationFrame(() => {
      const root = this.renderRoot.querySelector(".wt-scene");
      if (!root) return;
      const anims: Animation[] = [];
      switch (scene.kind) {
        case "markdown":
        case "diagram": {
          const heads = root.querySelectorAll("h1, h2, h3, .wt-diagram-label");
          heads.forEach((h) => anims.push(slideGlow(h)));
          const body = root.querySelectorAll("p, li, pre");
          anims.push(...stagger(body, { delayMs: 120, stepMs: 80 }));
          break;
        }
        case "code": {
          const code = root.querySelector(".wt-code code");
          if (code) anims.push(typeIn(code));
          const cap = root.querySelector(".wt-caption");
          if (cap) anims.push(slideGlow(cap, { delayMs: 300, durationMs: 400 }));
          break;
        }
        case "image": {
          const img = root.querySelector(".wt-image img");
          if (img) anims.push(kenBurns(img, { seed: this.index }));
          break;
        }
        case "choice": {
          const lead = root.querySelector(".wt-md-lead");
          if (lead) anims.push(slideGlow(lead));
          const choices = root.querySelectorAll(".wt-choice");
          anims.push(...stagger(choices, { delayMs: 200, stepMs: 110 }));
          break;
        }
      }
      this.revealAnims = anims;
      if (this.paused) for (const a of anims) a.pause();
    });
  }

  // ── interactive-registry contract ─────────────────────────────────────────
  applyInteract(interact: PopupInteract): boolean {
    switch (interact.op) {
      case "next":
      case "scene.next":
        this.next();
        return true;
      case "prev":
      case "scene.prev":
        this.prev();
        return true;
      case "scene.goto": {
        const i = interact.index ?? 0;
        if (i < 0 || i >= this.scenes.length) return false;
        this.index = i;
        return true;
      }
      case "revealAll":
        this.index = Math.max(0, this.scenes.length - 1);
        return true;
      case "timeline.pause":
        if (!this.paused) this.togglePause();
        return true;
      case "timeline.play":
        if (this.paused) this.togglePause();
        return true;
      case "timeline.seek": {
        const ms = interact.seekMs ?? 0;
        for (const a of this.revealAnims) {
          try {
            a.currentTime = ms;
          } catch {
            /* ignore */
          }
        }
        return true;
      }
      case "element.hold":
        // Pin the current scene: stop auto-advance until released (play).
        this.clearHoldTimer();
        this.stopAudio();
        return true;
      case "element.cue": {
        // Re-pulse the current scene stage to draw the eye.
        const stage = this.renderRoot.querySelector(".wt-scene");
        if (stage) pulse(stage, { count: 2 });
        return true;
      }
      case "dismiss":
        this.dispatchDismiss();
        return true;
      default:
        return false;
    }
  }

  // ── speech ────────────────────────────────────────────────────────────────
  private get scenes(): WalkthroughScene[] {
    return this.payload?.scenes ?? [];
  }
  private get current(): WalkthroughScene | null {
    return this.scenes[this.index] ?? null;
  }

  private async speakCurrentScene(): Promise<void> {
    this.stopAudio();
    this.clearHoldTimer();
    const scene = this.current;
    if (!scene) return;
    const text = (scene.narration || "").trim();
    if (!text) {
      // Silent scene — schedule advance after holdMs, unless the agent has
      // pinned the timeline (autoAdvance:false) or this is a choice scene.
      if (scene.kind === "choice") return;
      if (this.payload?.autoAdvance === false) return;
      this.scheduleHoldAdvance(scene.holdMs ?? DEFAULT_HOLD_MS);
      return;
    }
    if (this.paused) return;
    // Narration is shown as captions and paced by reading time: voice runs on
    // Robovoice, InfiniBot has no local text-to-speech to read it aloud.
    if (scene.kind === "choice") return;
    if (this.payload?.autoAdvance === false) return;
    this.scheduleHoldAdvance((scene.holdMs ?? DEFAULT_HOLD_MS) + estimateReadMs(text));
  }

  private stopAudio(): void {
    if (!this.audio) return;
    try {
      this.audio.pause();
    } catch {
      /* ignore */
    }
    this.audio = null;
    this.audioPlaying = false;
  }

  private scheduleHoldAdvance(ms: number): void {
    this.clearHoldTimer();
    if (this.paused) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.next();
    }, Math.max(0, ms));
  }
  private clearHoldTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  // ── navigation ────────────────────────────────────────────────────────────
  private next(): void {
    if (this.index >= this.scenes.length - 1) {
      // Past the last scene → dismiss the overlay.
      this.dispatchDismiss();
      return;
    }
    this.index = this.index + 1;
  }
  private prev(): void {
    if (this.index <= 0) return;
    this.index = this.index - 1;
  }
  private togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) {
      this.stopAudio();
      this.clearHoldTimer();
      for (const a of this.revealAnims) {
        try {
          a.pause();
        } catch {
          /* ignore */
        }
      }
    } else {
      for (const a of this.revealAnims) {
        try {
          a.play();
        } catch {
          /* ignore */
        }
      }
      void this.speakCurrentScene();
    }
  }
  private dispatchDismiss(): void {
    this.dispatchEvent(
      new CustomEvent("pmedia-dismiss", {
        bubbles: true,
        composed: true,
        detail: { eventId: this.eventId },
      }),
    );
  }
  private onKey(e: KeyboardEvent): void {
    // Don't trap typing into form fields outside the overlay.
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      this.next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.prev();
    } else if (e.key === " ") {
      e.preventDefault();
      this.togglePause();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.dispatchDismiss();
    }
  }

  // ── choices ───────────────────────────────────────────────────────────────
  private pickChoice(value: string): void {
    // Surface the user's selection to the agent via the interact channel.
    // The overlay-host owns the WS bridge; we just bubble a CustomEvent it
    // can forward through proactive.interact (op: appendElement) — but the
    // simpler primitive here is a dedicated event the host already maps onto
    // any registered interact callback.
    this.dispatchEvent(
      new CustomEvent("walkthrough-choice", {
        bubbles: true,
        composed: true,
        detail: { eventId: this.eventId, choice: value },
      }),
    );
    // Advance past the choice scene optimistically.
    this.next();
  }

  // ── render ────────────────────────────────────────────────────────────────
  render() {
    const scene = this.current;
    if (!scene || this.scenes.length === 0) return nothing;
    const title = this.payload?.title;
    const total = this.scenes.length;
    const idx = this.index;
    return html`
      <div
        class="wt-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label=${title || "Walkthrough"}
        @click=${(e: MouseEvent) => {
          if (e.target === e.currentTarget) this.dispatchDismiss();
        }}
      >
        <div class="wt-stage">
          <div class="wt-head">
            <div class="wt-title">${title || "Walkthrough"}</div>
            <button class="wt-x" aria-label="Close" @click=${() => this.dispatchDismiss()}>
              ✕
            </button>
          </div>

          <div
            class="wt-scene"
            style=${`--reveal-ms:${scene.revealMs ?? DEFAULT_REVEAL_MS}ms`}
            data-kind=${scene.kind}
            data-index=${idx}
          >
            ${this.renderScene(scene)}
          </div>

          <div class="wt-foot">
            <button class="wt-nav" aria-label="Previous" @click=${() => this.prev()} ?disabled=${idx === 0}>
              ←
            </button>
            <div class="wt-dots" role="tablist" aria-label="Scene progress">
              ${this.scenes.map(
                (_, i) =>
                  html`<span
                    class="wt-dot ${i === idx ? "active" : i < idx ? "past" : ""}"
                    aria-current=${i === idx ? "true" : "false"}
                  ></span>`,
              )}
            </div>
            <button
              class="wt-nav"
              aria-label=${this.paused ? "Play" : "Pause"}
              @click=${() => this.togglePause()}
              title=${this.paused ? "Resume (space)" : "Pause (space)"}
            >
              ${this.paused ? "▶" : "❚❚"}
            </button>
            <button
              class="wt-nav primary"
              aria-label="Next"
              @click=${() => this.next()}
            >
              ${idx >= total - 1 ? "Done" : "→"}
            </button>
          </div>

          <div class="wt-counter" aria-live="polite">${idx + 1} / ${total}</div>
        </div>
      </div>
    `;
  }

  private renderScene(scene: WalkthroughScene) {
    switch (scene.kind) {
      case "markdown":
        return html`<div class="wt-md">${unsafeMarkdown(String(scene.content))}</div>`;
      case "code": {
        const c = scene.content as WalkthroughCodeContent;
        return html`
          <pre class="wt-code"><code data-lang=${c.language ?? ""}>${c.code}</code></pre>
          ${c.caption ? html`<div class="wt-caption">${c.caption}</div>` : nothing}
        `;
      }
      case "image": {
        const c = scene.content as WalkthroughImageContent;
        return html`
          <div class="wt-image">
            <img src=${c.url} alt=${c.alt ?? ""} />
          </div>
          ${c.caption ? html`<div class="wt-caption">${c.caption}</div>` : nothing}
        `;
      }
      case "diagram": {
        // Mermaid is not bundled in the overlay path. Render the source in a
        // styled code surface; the agent can switch to image scenes with a
        // pre-rendered SVG when a real diagram engine is required.
        return html`
          <div class="wt-diagram">
            <div class="wt-diagram-label">DIAGRAM</div>
            <pre><code>${String(scene.content)}</code></pre>
          </div>
        `;
      }
      case "choice": {
        const c = scene.content as WalkthroughChoiceContent;
        return html`
          ${c.prompt ? html`<div class="wt-md wt-md-lead">${c.prompt}</div>` : nothing}
          <div class="wt-choices">
            ${c.choices.map(
              (ch) => html`
                <button class="wt-choice" @click=${() => this.pickChoice(ch.value)}>
                  <div class="wt-choice-label">${ch.label}</div>
                  ${ch.detail ? html`<div class="wt-choice-detail">${ch.detail}</div>` : nothing}
                </button>
              `,
            )}
          </div>
        `;
      }
      default:
        return nothing;
    }
  }

  static styles = css`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 9994;
      pointer-events: auto;
    }
    .wt-backdrop {
      position: fixed;
      inset: 0;
      background: radial-gradient(
          ellipse at center,
          rgba(8, 6, 2, 0.72) 0%,
          rgba(2, 2, 4, 0.92) 100%
        );
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
      animation: wt-fade 220ms ease-out;
    }
    @keyframes wt-fade {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    .wt-stage {
      position: relative;
      width: min(960px, 100%);
      max-height: calc(100vh - 64px);
      display: flex;
      flex-direction: column;
      gap: 22px;
      padding: 32px 36px 28px;
      background:
        linear-gradient(
          145deg,
          rgba(28, 22, 8, 0.78) 0%,
          rgba(14, 12, 8, 0.86) 60%,
          rgba(10, 8, 4, 0.92) 100%
        );
      border: 1px solid color-mix(in srgb, var(--gold-1, #d4af37) 38%, transparent);
      border-radius: 22px;
      box-shadow:
        0 0 0 1px rgba(212, 175, 55, 0.12),
        0 28px 80px -20px rgba(0, 0, 0, 0.8),
        0 0 80px -20px rgba(212, 175, 55, 0.18);
      color: var(--g-fg, #f5eacd);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      animation: wt-rise 320ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    @keyframes wt-rise {
      from {
        opacity: 0;
        transform: translateY(18px) scale(0.985);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
    .wt-head {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .wt-title {
      flex: 1;
      font-size: 0.74rem;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--gold-1, #d4af37);
    }
    .wt-x {
      background: transparent;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.6));
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      width: 30px;
      height: 30px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .wt-x:hover {
      color: var(--g-fg, #f5eacd);
      border-color: var(--gold-1, #d4af37);
    }

    /* The scene surface — one per index. Animation runs each time the keyed
       div is replaced. */
    .wt-scene {
      min-height: 320px;
      flex: 1;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
      animation: wt-reveal var(--reveal-ms, 600ms) cubic-bezier(0.2, 0.7, 0.2, 1) both;
    }
    @keyframes wt-reveal {
      from {
        opacity: 0;
        transform: translateY(14px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .wt-md {
      font-size: 1.15rem;
      line-height: 1.6;
      color: var(--g-fg, #f5eacd);
    }
    .wt-md-lead {
      font-size: 1.35rem;
      font-weight: 600;
      color: var(--gold-1, #d4af37);
    }
    .wt-md h1,
    .wt-md h2,
    .wt-md h3 {
      color: var(--gold-1, #d4af37);
      margin: 0.4em 0;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .wt-md h1 {
      font-size: 1.9rem;
    }
    .wt-md h2 {
      font-size: 1.45rem;
    }
    .wt-md h3 {
      font-size: 1.2rem;
    }
    .wt-md p {
      margin: 0.5em 0;
    }
    .wt-md ul,
    .wt-md ol {
      padding-left: 1.4em;
      margin: 0.5em 0;
    }
    .wt-md li {
      margin: 0.25em 0;
    }
    .wt-md code {
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 6px;
      border-radius: 5px;
      font-size: 0.92em;
    }
    .wt-md strong {
      color: var(--gold-1, #d4af37);
    }

    .wt-code {
      margin: 0;
      padding: 18px 20px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid rgba(212, 175, 55, 0.22);
      border-radius: 12px;
      overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.95rem;
      line-height: 1.5;
      color: #f5eacd;
    }
    .wt-code code {
      background: transparent;
      padding: 0;
    }

    .wt-image {
      display: flex;
      justify-content: center;
      align-items: center;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(212, 175, 55, 0.22);
      border-radius: 14px;
      padding: 12px;
      max-height: 60vh;
      overflow: hidden;
    }
    .wt-image img {
      max-width: 100%;
      max-height: 56vh;
      border-radius: 8px;
      object-fit: contain;
    }
    .wt-caption {
      font-size: 0.85rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.65));
      text-align: center;
    }

    .wt-diagram {
      background: rgba(0, 0, 0, 0.4);
      border: 1px dashed rgba(212, 175, 55, 0.34);
      border-radius: 12px;
      padding: 20px 18px 16px;
      position: relative;
      margin-top: 12px; /* clearance so the floating label isn't clipped */
    }
    .wt-diagram-label {
      position: absolute;
      top: -10px;
      left: 14px;
      font-size: 0.62rem;
      letter-spacing: 0.14em;
      font-weight: 800;
      color: var(--gold-1, #d4af37);
      background: rgba(10, 8, 4, 0.95);
      padding: 2px 8px;
      border-radius: 4px;
    }
    .wt-diagram pre {
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.82rem;
      color: var(--g-fg, #f5eacd);
      white-space: pre-wrap;
    }

    .wt-choices {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 8px;
    }
    .wt-choice {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      padding: 18px 22px;
      background: rgba(20, 16, 8, 0.6);
      border: 1px solid rgba(212, 175, 55, 0.28);
      border-left: 3px solid var(--gold-1, #d4af37);
      border-radius: 12px;
      cursor: pointer;
      color: var(--g-fg, #f5eacd);
      font: inherit;
      text-align: left;
      transition:
        background 140ms ease,
        border-color 140ms ease,
        transform 120ms ease;
    }
    .wt-choice:hover {
      background: rgba(40, 32, 14, 0.78);
      border-color: var(--gold-1, #d4af37);
      transform: translateX(2px);
    }
    .wt-choice-label {
      font-size: 1.05rem;
      font-weight: 700;
      color: var(--gold-1, #d4af37);
    }
    .wt-choice-detail {
      font-size: 0.85rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.7));
    }

    .wt-foot {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-top: 12px;
      border-top: 1px solid rgba(212, 175, 55, 0.16);
    }
    .wt-nav {
      background: rgba(20, 16, 8, 0.6);
      color: var(--g-fg, #f5eacd);
      border: 1px solid rgba(212, 175, 55, 0.28);
      border-radius: 9px;
      min-width: 44px;
      height: 38px;
      padding: 0 12px;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 120ms ease;
    }
    .wt-nav:hover:not(:disabled) {
      background: rgba(40, 32, 14, 0.78);
      border-color: var(--gold-1, #d4af37);
    }
    .wt-nav:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .wt-nav.primary {
      margin-left: auto;
      background: linear-gradient(135deg, var(--gold-1, #d4af37), #b8902f);
      color: #1a1206;
      border-color: var(--gold-1, #d4af37);
    }
    .wt-nav.primary:hover {
      filter: brightness(1.08);
    }
    .wt-dots {
      display: flex;
      gap: 6px;
      align-items: center;
      flex: 1;
      justify-content: center;
    }
    .wt-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: rgba(212, 175, 55, 0.22);
      transition: all 200ms ease;
    }
    .wt-dot.past {
      background: rgba(212, 175, 55, 0.55);
    }
    .wt-dot.active {
      width: 22px;
      border-radius: 4px;
      background: var(--gold-1, #d4af37);
      box-shadow: 0 0 8px rgba(212, 175, 55, 0.6);
    }
    .wt-counter {
      position: absolute;
      bottom: 10px;
      right: 16px;
      font-size: 0.66rem;
      letter-spacing: 0.1em;
      font-weight: 700;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.5));
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "walkthrough-overlay": WalkthroughOverlay;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Estimate read time (ms) so a TTS-less fallback still flows. */
function estimateReadMs(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.max(1500, Math.round((words / 2.7) * 1000));
}

/**
 * Lightweight inline markdown → HTML for walkthrough body text. We only need
 * headings, bold, italic, inline code, links, and lists — the heavy parser
 * lives in stylized-markdown's timeline. Output is rendered via lit's `html`
 * which auto-escapes — so we explicitly build a <span .innerHTML=...> safe
 * fragment from a tightly-restricted subset.
 *
 * Walkthrough payloads come from the agent itself (server-attributed), so the
 * trust model matches stylized-markdown — same surface, same constraints.
 */
function unsafeMarkdown(src: string) {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const lines = src.split(/\r?\n/);
  let out = "";
  let inList: "ul" | "ol" | null = null;
  const closeList = () => {
    if (inList) {
      out += `</${inList}>`;
      inList = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out += `<h${lvl}>${inline(escape(h[2]))}</h${lvl}>`;
      continue;
    }
    const ul = /^[-*]\s+(.+)$/.exec(line);
    if (ul) {
      if (inList !== "ul") {
        closeList();
        out += "<ul>";
        inList = "ul";
      }
      out += `<li>${inline(escape(ul[1]))}</li>`;
      continue;
    }
    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (ol) {
      if (inList !== "ol") {
        closeList();
        out += "<ol>";
        inList = "ol";
      }
      out += `<li>${inline(escape(ol[1]))}</li>`;
      continue;
    }
    closeList();
    out += `<p>${inline(escape(line))}</p>`;
  }
  closeList();

  const tpl = document.createElement("template");
  tpl.innerHTML = out;
  return tpl.content.cloneNode(true);
}

function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
