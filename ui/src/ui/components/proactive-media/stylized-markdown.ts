/**
 * <stylized-markdown-overlay> — a markdown document revealed as a TIMELINE of
 * element cards, in step with TTS.
 *
 * Each parsed element (heading / paragraph / bullet / code / callout / image)
 * gets its OWN entrance animation preset and, while it is "being spoken", a
 * highlight glow; it then settles and the next element animates in.
 *
 * TTS-sync choice (documented): the InfiniBot TTS pipeline exposes NO word /
 * sentence boundary events — only sentence-level enqueue + `audio.onended` and
 * an analyser node (see ui/.../views/voice-chat.ts). So the timeline cursor is
 * APPROXIMATED by word-rate: each element's dwell ≈ words / wordsPerSecond,
 * clamped to a sane range. An agent that IS speaking can override this exactly
 * via the interact channel (proactive.interact { op:'highlight'|'next', ... }),
 * which cancels the auto-advance and drives the cursor precisely.
 *
 * Honours prefers-reduced-motion: reveals everything at once, no glow pulsing,
 * no auto-advance.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { StylizedMarkdownMedia, PopupInteract } from "../proactive-popup-shared.js";
import {
  parseMarkdownTimeline,
  type TimelineElement,
} from "./markdown-timeline.js";
import {
  registerOverlay,
  unregisterOverlay,
  type InteractiveOverlay,
} from "./interactive-registry.js";
import { pulse } from "./animations.js";

const DEFAULT_WPS = 2.7; // ~165 wpm spoken pace
const MIN_DWELL_MS = 900;
const MAX_DWELL_MS = 6000;

@customElement("stylized-markdown-overlay")
export class StylizedMarkdownOverlay extends LitElement implements InteractiveOverlay {
  @property({ attribute: false }) payload: StylizedMarkdownMedia | null = null;
  @property({ type: String }) eventId = "";
  @property({ type: Boolean }) compact = false;

  @state() private elements: TimelineElement[] = [];
  @state() private revealedCount = 0;
  @state() private currentIndex = -1;

  private timer: number | null = null;
  private reducedMotion = false;
  private parsedFrom = "";

  connectedCallback(): void {
    super.connectedCallback();
    this.reducedMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    registerOverlay(this);
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearTimer();
    unregisterOverlay(this);
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("eventId")) {
      // Re-register under the new id (toast reuse across events).
      unregisterOverlay(this);
      registerOverlay(this);
    }
    const md = this.payload?.markdown ?? "";
    if (md && md !== this.parsedFrom) {
      this.parsedFrom = md;
      this.elements = parseMarkdownTimeline(md);
      this.startSequence();
    }
  }

  // ── sequence ────────────────────────────────────────────────────────────────
  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private get sequential(): boolean {
    return this.payload?.sequential !== false && !this.reducedMotion;
  }

  private startSequence(): void {
    this.clearTimer();
    if (!this.sequential || this.elements.length === 0) {
      this.revealedCount = this.elements.length;
      this.currentIndex = -1;
      return;
    }
    this.revealedCount = 1;
    this.currentIndex = 0;
    this.scheduleAdvance();
  }

  private dwellFor(el: TimelineElement | undefined): number {
    if (!el) return MIN_DWELL_MS;
    const fixed = this.payload?.autoAdvanceMs;
    if (fixed === 0) return Number.POSITIVE_INFINITY; // wait for interact
    if (typeof fixed === "number" && fixed > 0) return fixed;
    const wps = this.payload?.wordsPerSecond || DEFAULT_WPS;
    return Math.max(MIN_DWELL_MS, Math.min(MAX_DWELL_MS, (el.words / wps) * 1000));
  }

  private scheduleAdvance(): void {
    this.clearTimer();
    const el = this.elements[this.currentIndex];
    const dwell = this.dwellFor(el);
    if (!isFinite(dwell)) return; // autoAdvanceMs:0 — agent drives via interact
    this.timer = window.setTimeout(() => this.advance(), dwell);
    // Keep the spoken element scrolled into view as the timeline grows.
    this.scrollCurrentIntoView();
  }

  private advance(): void {
    if (this.currentIndex >= this.elements.length - 1) {
      this.currentIndex = -1; // settle final element (no lingering glow)
      this.clearTimer();
      return;
    }
    this.currentIndex += 1;
    if (this.currentIndex >= this.revealedCount) this.revealedCount = this.currentIndex + 1;
    this.scheduleAdvance();
  }

  private scrollCurrentIntoView(): void {
    requestAnimationFrame(() => {
      const el = this.renderRoot.querySelector(`[data-el-index="${this.currentIndex}"]`);
      el?.scrollIntoView({ block: "nearest", behavior: this.reducedMotion ? "auto" : "smooth" });
    });
  }

  // ── interact channel (server → client live control) ──────────────────────────
  applyInteract(interact: PopupInteract): boolean {
    const findIndex = (id?: string): number =>
      id ? this.elements.findIndex((e) => e.id === id) : -1;
    switch (interact.op) {
      case "highlight": {
        const idx = findIndex(interact.elementId);
        if (idx < 0) return false;
        this.clearTimer(); // agent is driving — stop auto-advance
        this.currentIndex = idx;
        if (idx >= this.revealedCount) this.revealedCount = idx + 1;
        this.scrollCurrentIntoView();
        return true;
      }
      case "scrollTo": {
        const idx = findIndex(interact.elementId);
        if (idx < 0) return false;
        if (idx >= this.revealedCount) this.revealedCount = idx + 1;
        requestAnimationFrame(() => {
          this.renderRoot
            .querySelector(`[data-el-index="${idx}"]`)
            ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
        return true;
      }
      case "replaceElement": {
        const idx = findIndex(interact.elementId);
        if (idx < 0 || typeof interact.markdown !== "string") return false;
        const parsed = parseMarkdownTimeline(interact.markdown);
        if (parsed.length) {
          const next = this.elements.slice();
          next[idx] = { ...parsed[0], id: this.elements[idx].id };
          this.elements = next;
        }
        return true;
      }
      case "appendElement": {
        if (typeof interact.markdown !== "string") return false;
        const parsed = parseMarkdownTimeline(interact.markdown).map((e, i) => ({
          ...e,
          id: `el-app-${this.elements.length + i}`,
        }));
        this.elements = [...this.elements, ...parsed];
        this.revealedCount = this.elements.length;
        return true;
      }
      case "next": {
        this.clearTimer();
        this.advance();
        return true;
      }
      case "prev": {
        this.clearTimer();
        if (this.currentIndex > 0) this.currentIndex -= 1;
        this.scrollCurrentIntoView();
        return true;
      }
      case "revealAll": {
        this.clearTimer();
        this.revealedCount = this.elements.length;
        this.currentIndex = -1;
        return true;
      }
      // ── scene-timeline orchestration ──────────────────────────────────────
      case "scene.next":
        this.clearTimer();
        this.advance();
        return true;
      case "scene.prev":
        this.clearTimer();
        if (this.currentIndex > 0) this.currentIndex -= 1;
        this.scrollCurrentIntoView();
        return true;
      case "timeline.pause":
        // Hold the cursor — stop auto-advance (agent drives manually).
        this.clearTimer();
        return true;
      case "timeline.play":
        // Resume word-rate auto-advance from the current element.
        if (this.currentIndex >= 0) this.scheduleAdvance();
        return true;
      case "element.hold": {
        // Pin auto-advance on a specific element and spotlight it.
        const idx = findIndex(interact.elementId);
        if (idx < 0) return false;
        this.clearTimer();
        this.currentIndex = idx;
        if (idx >= this.revealedCount) this.revealedCount = idx + 1;
        this.scrollCurrentIntoView();
        return true;
      }
      case "element.cue": {
        // Re-pulse a specific element (WAAPI) to draw the eye mid-narration.
        const idx = findIndex(interact.elementId);
        if (idx < 0) return false;
        if (idx >= this.revealedCount) this.revealedCount = idx + 1;
        this.currentIndex = idx;
        requestAnimationFrame(() => {
          const el = this.renderRoot.querySelector(`[data-el-index="${idx}"]`);
          if (el) pulse(el, { count: 2 });
        });
        return true;
      }
      case "dismiss": {
        this.dispatchEvent(
          new CustomEvent("pmedia-dismiss", {
            bubbles: true,
            composed: true,
            detail: { eventId: this.eventId },
          }),
        );
        return true;
      }
      default:
        return false;
    }
  }

  // ── render ────────────────────────────────────────────────────────────────────
  render() {
    if (!this.payload || this.elements.length === 0) return nothing;
    return html`
      <div class="tl">
        ${this.payload.title
          ? html`<div class="tl-doc-title">${this.payload.title}</div>`
          : nothing}
        ${this.elements.map((el, i) => this.renderEl(el, i))}
      </div>
    `;
  }

  private renderEl(el: TimelineElement, i: number) {
    const revealed = i < this.revealedCount;
    const current = i === this.currentIndex;
    const cls = [
      "tl-el",
      `tl-${el.kind}`,
      el.level ? `tl-h${el.level}` : "",
      revealed ? "tl-revealed" : "tl-hidden",
      current ? "tl-current" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <div class=${cls} data-el-id=${el.id} data-el-index=${i}>
        ${el.kind === "callout" ? html`<span class="tl-callout-bar"></span>` : nothing}
        <div class="tl-content">${unsafeHTML(el.html)}</div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
    }
    .tl {
      display: flex;
      flex-direction: column;
      gap: 7px;
      max-height: 52vh;
      overflow: auto;
      padding-right: 2px;
    }
    .tl-doc-title {
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--gold-1, #d4af37);
      margin-bottom: 2px;
    }
    .tl-el {
      position: relative;
      border-radius: 9px;
      padding: 5px 9px;
      color: var(--g-fg, #f5eacd);
      font-size: 0.82rem;
      line-height: 1.45;
      border: 1px solid transparent;
      transition:
        box-shadow 0.3s ease,
        border-color 0.3s ease,
        background 0.3s ease;
    }
    .tl-content :first-child {
      margin-top: 0;
    }
    .tl-content :last-child {
      margin-bottom: 0;
    }
    .tl-content code {
      background: rgba(255, 255, 255, 0.09);
      padding: 0 4px;
      border-radius: 4px;
      font-size: 0.92em;
    }

    /* Hidden until revealed (sequential mode). */
    .tl-hidden {
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
      height: 0;
      padding: 0;
      overflow: hidden;
      margin: -3px 0;
    }

    /* ── per-kind entrance presets (applied when .tl-revealed lands) ── */
    .tl-revealed {
      animation-duration: 0.42s;
      animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
      animation-fill-mode: both;
    }
    .tl-heading.tl-revealed {
      animation-name: tl-slide-glow;
      font-weight: 800;
      color: #fff;
    }
    .tl-h1 .tl-content {
      font-size: 1.12rem;
    }
    .tl-h2 .tl-content {
      font-size: 1rem;
    }
    .tl-paragraph.tl-revealed {
      animation-name: tl-fade-up;
    }
    .tl-bullet.tl-revealed {
      animation-name: tl-stagger-in;
    }
    .tl-bullet .tl-content {
      padding-left: 14px;
      position: relative;
    }
    .tl-bullet .tl-content::before {
      content: "";
      position: absolute;
      left: 2px;
      top: 0.62em;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--gold-1, #d4af37);
    }
    .tl-ordered.tl-revealed {
      animation-name: tl-stagger-in;
    }
    .tl-callout {
      background: rgba(212, 175, 55, 0.08);
      border: 1px solid rgba(212, 175, 55, 0.24);
      padding-left: 14px;
    }
    .tl-callout.tl-revealed {
      animation-name: tl-pulse-in;
    }
    .tl-callout-bar {
      position: absolute;
      left: 0;
      top: 6px;
      bottom: 6px;
      width: 3px;
      border-radius: 2px;
      background: var(--gold-1, #d4af37);
    }
    .tl-code {
      background: rgba(0, 0, 0, 0.42);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.74rem;
      overflow: auto;
    }
    .tl-code.tl-revealed {
      animation-name: tl-type-in;
    }
    .tl-code .tl-content pre {
      margin: 0;
      white-space: pre-wrap;
    }
    .tl-image.tl-revealed {
      animation-name: tl-zoom-in;
    }
    .tl-image .tl-content img {
      max-width: 100%;
      border-radius: 8px;
      display: block;
    }

    /* ── current "being spoken" highlight glow ── */
    .tl-current {
      border-color: rgba(212, 175, 55, 0.5);
      background: linear-gradient(
        180deg,
        rgba(212, 175, 55, 0.12),
        rgba(212, 175, 55, 0.03)
      );
      box-shadow: 0 0 0 1px rgba(212, 175, 55, 0.22), 0 0 22px rgba(212, 175, 55, 0.22);
      animation: tl-glow-pulse 1.8s ease-in-out infinite;
    }

    @keyframes tl-fade-up {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    @keyframes tl-slide-glow {
      0% {
        opacity: 0;
        transform: translateX(-14px);
        text-shadow: 0 0 0 rgba(212, 175, 55, 0);
      }
      60% {
        text-shadow: 0 0 16px rgba(212, 175, 55, 0.6);
      }
      100% {
        opacity: 1;
        transform: translateX(0);
        text-shadow: 0 0 0 rgba(212, 175, 55, 0);
      }
    }
    @keyframes tl-stagger-in {
      from {
        opacity: 0;
        transform: translateX(-10px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    @keyframes tl-pulse-in {
      0% {
        opacity: 0;
        transform: scale(0.96);
      }
      55% {
        transform: scale(1.015);
      }
      100% {
        opacity: 1;
        transform: scale(1);
      }
    }
    @keyframes tl-type-in {
      from {
        opacity: 0;
        clip-path: inset(0 100% 0 0);
      }
      to {
        opacity: 1;
        clip-path: inset(0 0 0 0);
      }
    }
    @keyframes tl-zoom-in {
      from {
        opacity: 0;
        transform: scale(0.9);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
    @keyframes tl-glow-pulse {
      0%,
      100% {
        box-shadow: 0 0 0 1px rgba(212, 175, 55, 0.22), 0 0 18px rgba(212, 175, 55, 0.18);
      }
      50% {
        box-shadow: 0 0 0 1px rgba(212, 175, 55, 0.4), 0 0 30px rgba(212, 175, 55, 0.34);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .tl-el,
      .tl-revealed,
      .tl-current {
        animation: none !important;
      }
      .tl-current {
        box-shadow: 0 0 0 1px rgba(212, 175, 55, 0.4);
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "stylized-markdown-overlay": StylizedMarkdownOverlay;
  }
}
