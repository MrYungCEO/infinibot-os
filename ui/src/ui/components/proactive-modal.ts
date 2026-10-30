/**
 * <proactive-modal> — CRITICAL blocker modal.
 *
 * Dims the foreground, traps focus, and ignores backdrop clicks — when the event
 * carries actions the operator must choose one (Esc is ignored). As a safety
 * fallback a small × close button is ALWAYS rendered so the user can never be
 * trapped, and Escape also dismisses BUT ONLY when the event has no actions:
 * rendering a CRITICAL pop with zero actions is always a producer bug, never an
 * intentional "no way out" — so the user gets an escape hatch in that case.
 * Renders the newest pending CRITICAL event; body is markdown-rendered via the
 * unified renderer. Action buttons (and the × / Esc fallback) emit `popup-action`.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown/render.js";
import "./proactive-media/index.js";
import {
  agentColor,
  whyChipTitle,
  type PopupAction,
  type PopupEvent,
} from "./proactive-popup-shared.js";

const EXIT_MS = 240;

@customElement("proactive-modal")
export class ProactiveModal extends LitElement {
  /** The CRITICAL event to block on (newest first), or null when none pending. */
  @property({ attribute: false }) event: PopupEvent | null = null;

  /** The event currently painted — kept alive through the exit animation even
   *  after `event` clears, so the modal animates OUT instead of vanishing. */
  @state() private shown: PopupEvent | null = null;
  /** True while playing the dismissal animation (drives the .pm-out class). */
  @state() private closing = false;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;

  protected willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("event")) return;
    if (this.event) {
      // New / replacement CRITICAL → snap to it and (re)play the entrance.
      if (this.exitTimer) {
        clearTimeout(this.exitTimer);
        this.exitTimer = null;
      }
      this.closing = false;
      this.shown = this.event;
    } else if (this.shown && !this.closing) {
      // Cleared → play the exit, then unmount.
      this.closing = true;
      this.exitTimer = setTimeout(() => {
        this.shown = null;
        this.closing = false;
        this.exitTimer = null;
      }, EXIT_MS);
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKeyDown);
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
  }

  /** Escape dismisses ONLY when the event has no actions — a no-action CRITICAL
   *  is a producer bug, so the user must not be trapped. When actions exist,
   *  CRITICAL behaviour is unchanged: Esc is ignored, the operator must choose. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    const ev = this.shown;
    if (!ev || this.closing) return;
    if ((ev.actions ?? []).length > 0) return;
    e.preventDefault();
    this.dismiss();
  };

  /** Fallback close: dispatch the same dismiss-kind popup-action the overlay
   *  host already handles (proactive.dismiss). Drives the × button and the
   *  no-action Escape fallback. */
  private dismiss(): void {
    this.act({
      id: "dismiss",
      kind: "dismiss",
      label: "Dismiss",
      payload: { reason: "dismissed via close button" },
    });
  }

  private act(action: PopupAction): void {
    if (!this.shown) return;
    this.dispatchEvent(
      new CustomEvent("popup-action", {
        detail: { event: this.shown, action },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private why(): void {
    if (!this.shown) return;
    this.dispatchEvent(
      new CustomEvent("popup-why", {
        detail: { event: this.shown },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const ev = this.shown;
    if (!ev) return nothing;
    const color = agentColor(ev.attribution.agentId);
    const bodyHtml = ev.body ? toSanitizedMarkdownHtml(ev.body) : "";
    const out = this.closing ? "pm-out" : "";
    // The backdrop has no @click — CRITICAL with actions still can't be dismissed
    // by clicking away. But a subtle × is ALWAYS reachable (and Esc works when
    // there are no actions) so a producer bug can never trap the user.
    return html`
      <div class="pm-backdrop ${out}"></div>
      <div class="pm-modal ${out}" role="alertdialog" aria-modal="true" aria-label=${ev.title}>
        <div class="pm-glow"></div>
        <button class="pm-close" aria-label="Dismiss" title="Dismiss" @click=${() => this.dismiss()}>
          ×
        </button>
        <div class="pm-head">
          <span class="pm-tier">🔴 CRITICAL</span>
          <span class="pm-chip" style="--ac:${color}" title=${whyChipTitle(ev)}>
            <span class="pm-dot"></span>${ev.attribution.agentName || ev.attribution.agentId}
          </span>
        </div>
        <div class="pm-title">${ev.title}</div>
        ${bodyHtml ? html`<div class="pm-body">${unsafeHTML(bodyHtml)}</div>` : nothing}
        ${ev.media
          ? html`<proactive-media .media=${ev.media} .eventId=${ev.id}></proactive-media>`
          : nothing}
        ${this.renderAttributionLinks(ev)}
        <div class="pm-actions">
          ${(ev.actions ?? []).map(
            (a) => html`<button
              class="pm-btn ${a.primary ? "pm-btn-primary" : ""}"
              @click=${() => this.act(a)}
            >
              ${a.label}
            </button>`,
          )}
          <button class="pm-why" @click=${() => this.why()}>Why am I seeing this?</button>
        </div>
      </div>
    `;
  }

  private renderAttributionLinks(ev: PopupEvent) {
    const a = ev.attribution;
    const links: unknown[] = [];
    if (a.cardId)
      links.push(html`<a class="pm-link" href="#/kanban?task=${a.cardId}">card ↗</a>`);
    if (a.goalId)
      links.push(html`<a class="pm-link" href="#/autonomy?goal=${a.goalId}">goal ↗</a>`);
    if (a.verifierEvidenceRef)
      links.push(html`<span class="pm-link" title=${a.verifierEvidenceRef}>evidence</span>`);
    if (links.length === 0) return nothing;
    return html`<div class="pm-links">${links}</div>`;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: block;
      /* Inert by default: when no CRITICAL event is pending, render() returns
       * the lit "nothing" sentinel (no children) and the host MUST NOT swallow
       * clicks across the whole viewport. The backdrop/modal re-enable
       * pointer-events when shown, preserving the intended click-blocking of an
       * active CRITICAL modal. */
      pointer-events: none;
    }
    .pm-backdrop {
      position: fixed;
      inset: 0;
      background:
        radial-gradient(
          ellipse 60% 50% at 50% 42%,
          rgba(212, 175, 55, 0.1),
          transparent 70%
        ),
        rgba(4, 5, 10, 0.78);
      backdrop-filter: blur(9px) saturate(135%);
      -webkit-backdrop-filter: blur(9px) saturate(135%);
      animation: pm-fade 0.22s ease-out both;
      pointer-events: auto;
    }
    @keyframes pm-fade {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    /* Centered premium glass modal — gold accent frame + black-gold glass body,
       consistent with the rest of the dashboard (theme-glass --g-* tokens). */
    .pm-modal {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(560px, 92vw);
      max-height: 84vh;
      overflow: auto;
      isolation: isolate;
      /* Literal gold accent frame so the black-gold look is theme-independent
         (some profile themes set --g-primary to a non-gold hue). */
      border: 1px solid rgba(212, 175, 55, 0.45);
      border-top: 2px solid #d4af37;
      border-radius: 18px;
      background:
        linear-gradient(165deg, rgba(212, 175, 55, 0.1), transparent 38%),
        rgba(16, 14, 10, 0.97),
        rgba(10, 10, 14, 0.98);
      box-shadow:
        0 28px 80px rgba(0, 0, 0, 0.66),
        0 0 0 1px rgba(212, 175, 55, 0.12),
        0 0 50px rgba(212, 175, 55, 0.18);
      padding: 24px 26px;
      transform-origin: center center;
      animation: pm-pop 0.34s cubic-bezier(0.16, 1, 0.3, 1) both;
      pointer-events: auto;
    }
    /* gold top accent bar / halo */
    .pm-glow {
      position: absolute;
      inset: -1px -1px auto -1px;
      height: 64px;
      border-radius: 18px 18px 0 0;
      background: linear-gradient(
        180deg,
        rgba(212, 175, 55, 0.16),
        transparent
      );
      pointer-events: none;
      z-index: 0;
    }
    .pm-modal > :not(.pm-glow) {
      position: relative;
      z-index: 1;
    }
    /* Always-reachable fallback close. Deliberately understated — a faint glyph
       in the corner — so it doesn't undercut the gravity of a CRITICAL alert,
       but it's always there so the user can never be trapped. */
    .pm-close {
      position: absolute;
      top: 10px;
      right: 12px;
      z-index: 2;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      border-radius: 7px;
      color: rgba(245, 234, 205, 0.4);
      font-size: 1.1rem;
      line-height: 1;
      cursor: pointer;
    }
    .pm-close:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #f5eacd;
    }
    @keyframes pm-pop {
      0% {
        opacity: 0;
        transform: translate(-50%, -46%) scale(0.9);
        box-shadow:
          0 28px 80px rgba(0, 0, 0, 0.66),
          0 0 0 1px rgba(212, 175, 55, 0.12),
          0 0 0 rgba(212, 175, 55, 0);
      }
      60% {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1.015);
      }
      100% {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
        box-shadow:
          0 28px 80px rgba(0, 0, 0, 0.66),
          0 0 0 1px rgba(212, 175, 55, 0.12),
          0 0 50px rgba(212, 175, 55, 0.18);
      }
    }
    /* exit animation — modal scales/fades OUT instead of vanishing */
    .pm-modal.pm-out {
      animation: pm-pop-out 0.24s ease-in both;
    }
    .pm-backdrop.pm-out {
      animation: pm-fade-out 0.24s ease-in both;
    }
    @keyframes pm-pop-out {
      from {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
      to {
        opacity: 0;
        transform: translate(-50%, -52%) scale(0.94);
      }
    }
    @keyframes pm-fade-out {
      from {
        opacity: 1;
      }
      to {
        opacity: 0;
      }
    }
    .pm-head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .pm-tier {
      font-size: 0.66rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      color: #f87171;
      background: rgba(239, 68, 68, 0.14);
      border-radius: 6px;
      padding: 3px 8px;
    }
    .pm-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 0.7rem;
      font-weight: 700;
      color: var(--ac, #d4af37);
      background: color-mix(in srgb, var(--ac, #d4af37) 16%, transparent);
      border-radius: 6px;
      padding: 2px 8px;
      cursor: help;
      margin-left: auto;
    }
    .pm-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--ac, #d4af37);
    }
    .pm-title {
      font-size: 1.3rem;
      font-weight: 800;
      color: #fff;
      line-height: 1.18;
    }
    .pm-body {
      font-size: 0.88rem;
      color: rgba(245, 234, 205, 0.85);
      margin-top: 12px;
      line-height: 1.5;
    }
    .pm-body :first-child {
      margin-top: 0;
    }
    .pm-body code {
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 5px;
      border-radius: 4px;
    }
    .pm-body pre {
      background: rgba(0, 0, 0, 0.4);
      padding: 10px;
      border-radius: 8px;
      overflow: auto;
    }
    .pm-links {
      display: flex;
      gap: 12px;
      margin-top: 12px;
    }
    .pm-link {
      font-size: 0.76rem;
      color: #60a5fa;
      text-decoration: none;
    }
    .pm-link:hover {
      text-decoration: underline;
    }
    .pm-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .pm-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.16);
      color: #f5eacd;
      border-radius: 9px;
      padding: 9px 16px;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
    }
    .pm-btn:hover {
      background: rgba(255, 255, 255, 0.14);
    }
    .pm-btn-primary {
      background: linear-gradient(135deg, var(--g-primary, #d4af37), #b8902f);
      color: #1a1206;
      border-color: var(--g-primary, #d4af37);
      box-shadow: 0 4px 18px rgba(212, 175, 55, 0.28);
    }
    .pm-btn-primary:hover {
      background: linear-gradient(135deg, #e6c252, var(--g-primary, #d4af37));
    }
    .pm-why {
      margin-left: auto;
      background: none;
      border: none;
      color: rgba(245, 234, 205, 0.55);
      font-size: 0.76rem;
      cursor: pointer;
      text-decoration: underline dotted;
    }
    .pm-why:hover {
      color: #f5eacd;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "proactive-modal": ProactiveModal;
  }
}
