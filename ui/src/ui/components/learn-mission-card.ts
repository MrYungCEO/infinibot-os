/**
 * <learn-mission-card> — a single guided mission card.
 *
 * Cover art (gradient + glyph), title, ETA, a progress ring, and a CTA that
 * reads Start → / Resume / Replay depending on progress. Clicking the card (or
 * the CTA) fires a `mission-start` event with the mission id; the host (floating
 * pill / learn view) launches the coachmark sequence.
 *
 * Pure presentational element — progress is passed in, not read here.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { LearnMission } from "../../learn/extra-walkthroughs";
import type { MissionProgressView } from "../controllers/learn-missions";

@customElement("learn-mission-card")
export class LearnMissionCard extends LitElement {
  @property({ attribute: false }) mission!: LearnMission;
  @property({ attribute: false }) progress: MissionProgressView | null = null;
  @property({ type: Boolean }) recommended = false;

  static styles = css`
    :host {
      display: block;
      flex: 0 0 auto;
      width: 208px;
    }
    .card {
      display: flex;
      flex-direction: column;
      width: 100%;
      text-align: left;
      border-radius: 14px;
      overflow: hidden;
      cursor: pointer;
      border: 1px solid color-mix(in srgb, var(--g-fg, #fff) 10%, transparent);
      background: color-mix(in srgb, var(--g-surface, #14110a) 72%, transparent);
      color: var(--g-fg, #e7e3d6);
      transition: border-color 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease;
      padding: 0;
    }
    .card:hover {
      transform: translateY(-2px);
      border-color: color-mix(in srgb, var(--infinibot-gold, #d4af37) 55%, transparent);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4);
    }
    :host([recommended]) .card,
    .card.recommended {
      border-color: var(--infinibot-gold, #d4af37);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--infinibot-gold, #d4af37) 40%, transparent);
    }
    .cover {
      position: relative;
      height: 78px;
      display: grid;
      place-items: center;
    }
    .glyph {
      font-size: 30px;
      line-height: 1;
      color: rgba(255, 255, 255, 0.95);
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    }
    .reco-tag {
      position: absolute;
      top: 8px;
      left: 8px;
      font: 700 8.5px/1 system-ui, sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 3px 6px;
      border-radius: 999px;
      background: rgba(0, 0, 0, 0.42);
      color: var(--infinibot-gold-bright, #fff3c0);
    }
    .ring {
      position: absolute;
      top: 8px;
      right: 8px;
    }
    .body {
      padding: 11px 12px 13px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
    }
    .cat {
      font: 600 9px/1 system-ui, sans-serif;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #b9b2a0);
    }
    .title {
      margin: 0;
      font-size: 13.5px;
      font-weight: 650;
      line-height: 1.25;
    }
    .desc {
      margin: 0;
      font-size: 11px;
      line-height: 1.4;
      color: var(--g-fg-dim, #b9b2a0);
      flex: 1;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 6px;
    }
    .eta {
      font: 500 10.5px/1 ui-monospace, monospace;
      color: var(--g-fg-dim, #b9b2a0);
    }
    .cta {
      font: 700 11px/1 system-ui, sans-serif;
      padding: 6px 11px;
      border-radius: 7px;
      border: none;
      cursor: pointer;
      background: var(--infinibot-gold, #d4af37);
      color: #1a1505;
    }
    .cta--ghost {
      background: color-mix(in srgb, var(--g-fg, #fff) 10%, transparent);
      color: var(--g-fg, #e7e3d6);
    }
    .cta:hover {
      filter: brightness(1.08);
    }
    @media (prefers-reduced-motion: reduce) {
      .card {
        transition: none;
      }
      .card:hover {
        transform: none;
      }
    }
  `;

  private start(e: Event): void {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("mission-start", {
        detail: { id: this.mission.id },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderRing() {
    const pct = this.progress?.percent ?? 0;
    if (pct <= 0) return nothing;
    const r = 9;
    const c = 2 * Math.PI * r;
    const off = c * (1 - pct / 100);
    return html`
      <svg class="ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="${r}" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="3" />
        <circle
          cx="12"
          cy="12"
          r="${r}"
          fill="none"
          stroke="var(--infinibot-gold-bright, #fff3c0)"
          stroke-width="3"
          stroke-linecap="round"
          stroke-dasharray="${c}"
          stroke-dashoffset="${off}"
          transform="rotate(-90 12 12)"
        />
      </svg>
    `;
  }

  render() {
    if (!this.mission) return nothing;
    const m = this.mission;
    const p = this.progress;
    const cta = p?.done ? "Replay" : p?.started ? "Resume" : "Start →";
    return html`
      <div
        class="card ${this.recommended ? "recommended" : ""}"
        @click=${(e: Event) => this.start(e)}
        role="button"
        tabindex="0"
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") this.start(e);
        }}
      >
        <div class="cover" style="background:${m.cover};">
          ${this.recommended ? html`<span class="reco-tag">Next up</span>` : nothing}
          ${this.renderRing()}
          <span class="glyph">${m.icon}</span>
        </div>
        <div class="body">
          <span class="cat">${m.category}</span>
          <h4 class="title">${m.title}</h4>
          <p class="desc">${m.description}</p>
          <div class="foot">
            <span class="eta">~${m.etaMin} min</span>
            <button class="cta ${p?.done ? "cta--ghost" : ""}" @click=${(e: Event) => this.start(e)}>
              ${cta}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "learn-mission-card": LearnMissionCard;
  }
}
