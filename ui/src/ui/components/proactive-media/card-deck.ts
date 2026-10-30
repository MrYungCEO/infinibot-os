/**
 * <card-deck-overlay> — a swipeable / sequential deck of cards.
 *
 * Advances on tap (dots / arrows) or via the interact channel (next / prev /
 * dismiss). Each card supports a title, markdown body, and an image or video.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../markdown/render.js";
import { openLightbox } from "../proactive-lightbox.js";
import type { CardDeckMedia, PopupInteract } from "../proactive-popup-shared.js";
import {
  registerOverlay,
  unregisterOverlay,
  type InteractiveOverlay,
} from "./interactive-registry.js";
import { swipeReveal } from "./animations.js";

@customElement("card-deck-overlay")
export class CardDeckOverlay extends LitElement implements InteractiveOverlay {
  @property({ attribute: false }) payload: CardDeckMedia | null = null;
  @property({ type: String }) eventId = "";

  @state() private index = 0;
  /** Direction of the last navigation — drives the swipe-in direction. */
  private lastDelta = 1;

  connectedCallback(): void {
    super.connectedCallback();
    registerOverlay(this);
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    unregisterOverlay(this);
  }
  protected willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("eventId")) {
      unregisterOverlay(this);
      registerOverlay(this);
    }
  }

  private get count(): number {
    return this.payload?.cards.length ?? 0;
  }
  private go(delta: number): void {
    const n = this.count;
    if (n === 0) return;
    let next = this.index + delta;
    if (this.payload?.loop) next = (next + n) % n;
    else next = Math.max(0, Math.min(n - 1, next));
    if (next !== this.index) this.lastDelta = delta;
    this.index = next;
  }

  /** Swipe the new card in (WAAPI) when the index changes. */
  protected updated(changed: Map<string, unknown>): void {
    if (!changed.has("index")) return;
    requestAnimationFrame(() => {
      const card = this.renderRoot.querySelector(".deck-card");
      if (card) swipeReveal(card, { from: this.lastDelta < 0 ? "left" : "right" });
    });
  }

  applyInteract(interact: PopupInteract): boolean {
    switch (interact.op) {
      case "next":
      case "scene.next":
        this.go(1);
        return true;
      case "prev":
      case "scene.prev":
        this.go(-1);
        return true;
      case "scene.goto": {
        const i = interact.index ?? 0;
        if (i < 0 || i >= this.count) return false;
        this.lastDelta = i >= this.index ? 1 : -1;
        this.index = i;
        return true;
      }
      case "dismiss":
        this.dispatchEvent(
          new CustomEvent("pmedia-dismiss", {
            bubbles: true,
            composed: true,
            detail: { eventId: this.eventId },
          }),
        );
        return true;
      default:
        return false;
    }
  }

  render() {
    const cards = this.payload?.cards ?? [];
    if (cards.length === 0) return nothing;
    const c = cards[Math.min(this.index, cards.length - 1)];
    const body = c.bodyMarkdown ? toSanitizedMarkdownHtml(c.bodyMarkdown) : "";
    const accent = c.accent || "var(--gold-1, #d4af37)";
    return html`
      <div class="deck">
        <div class="deck-card" style="--accent:${accent}" key=${this.index}>
          ${c.imageUrl
            ? html`<button class="deck-media" @click=${() => openLightbox(c.imageUrl!, "image")}>
                <img class="deck-media-el" alt=${c.title ?? "card image"} src=${c.imageUrl} />
              </button>`
            : nothing}
          ${c.videoUrl
            ? html`<button class="deck-media" @click=${() => openLightbox(c.videoUrl!, "video")}>
                <video class="deck-media-el" muted playsinline preload="metadata" src=${c.videoUrl}></video>
                <span class="deck-play">▶</span>
              </button>`
            : nothing}
          ${c.title ? html`<div class="deck-title">${c.title}</div>` : nothing}
          ${body ? html`<div class="deck-body">${unsafeHTML(body)}</div>` : nothing}
        </div>
        <div class="deck-nav">
          <button class="deck-arrow" ?disabled=${!this.payload?.loop && this.index === 0} @click=${() => this.go(-1)}>‹</button>
          <div class="deck-dots">
            ${cards.map(
              (_, i) =>
                html`<button
                  class="deck-dot ${i === this.index ? "on" : ""}"
                  @click=${() => (this.index = i)}
                ></button>`,
            )}
          </div>
          <button
            class="deck-arrow"
            ?disabled=${!this.payload?.loop && this.index === cards.length - 1}
            @click=${() => this.go(1)}
          >
            ›
          </button>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
    }
    .deck {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .deck-card {
      border: 1px solid rgba(212, 175, 55, 0.26);
      border-top: 2px solid var(--accent, #d4af37);
      border-radius: 12px;
      background: linear-gradient(165deg, rgba(212, 175, 55, 0.07), transparent 45%),
        rgba(14, 16, 24, 0.7);
      padding: 11px 13px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      animation: deck-in 0.34s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .deck-title {
      font-weight: 800;
      font-size: 0.92rem;
      color: var(--g-fg, #f5eacd);
    }
    .deck-body {
      font-size: 0.8rem;
      line-height: 1.45;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.82));
    }
    .deck-media {
      position: relative;
      border: 0;
      padding: 0;
      border-radius: 9px;
      overflow: hidden;
      cursor: pointer;
      background: rgba(0, 0, 0, 0.35);
    }
    .deck-media-el {
      width: 100%;
      max-height: 220px;
      object-fit: cover;
      display: block;
    }
    .deck-play {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 1.4rem;
      text-shadow: 0 1px 6px rgba(0, 0, 0, 0.8);
    }
    .deck-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .deck-arrow {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--g-fg, #f5eacd);
      border-radius: 8px;
      width: 28px;
      height: 28px;
      font-size: 1rem;
      cursor: pointer;
    }
    .deck-arrow:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .deck-dots {
      display: flex;
      gap: 6px;
    }
    .deck-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      border: 0;
      background: rgba(245, 234, 205, 0.28);
      cursor: pointer;
      padding: 0;
    }
    .deck-dot.on {
      background: var(--gold-1, #d4af37);
    }
    @keyframes deck-in {
      from {
        opacity: 0;
        transform: translateX(14px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .deck-card {
        animation: none;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "card-deck-overlay": CardDeckOverlay;
  }
}
