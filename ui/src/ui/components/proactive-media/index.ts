/**
 * <proactive-media> — renders a pop-up's rich-media payload.
 *
 * Dispatches to the per-kind renderer (agent-summary / note / workflow /
 * activity / custom), owns the shared black-gold glass styling, lazy-loads
 * thumbnails via IntersectionObserver, and opens clicked media in the shared
 * lightbox. Staggered entrance is driven purely by CSS animation-delay on
 * `.pmedia-stagger` children (transform/opacity only → cheap).
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { PopupMedia } from "../proactive-popup-shared.js";
import { openLightbox } from "../proactive-lightbox.js";
import type { MediaRenderCtx } from "./shared.js";
import { renderAgentSummary } from "./agent-summary.js";
import { renderAgentRunReview } from "../agent-run-review.js";
import { renderNote } from "./note.js";
import { renderWorkflow } from "./workflow.js";
import { renderActivity } from "./activity.js";
import { renderCustom } from "./custom.js";
import { renderImage } from "./image.js";
import { renderVideo } from "./video.js";
import { renderHtml } from "./html.js";
import { renderPdf } from "./pdf.js";
// Stateful interactive cards self-register their custom elements + the
// interactive-overlay registry entry on connect.
import "./stylized-markdown.js";
import "./card-deck.js";

@customElement("proactive-media")
export class ProactiveMedia extends LitElement {
  @property({ attribute: false }) media: PopupMedia | null = null;
  @property({ type: Boolean }) compact = false;
  /** Event id of the owning pop-up — lets interactive cards register for the
   *  live interact channel (stylized-markdown / card-deck). */
  @property({ type: String }) eventId = "";

  private observer: IntersectionObserver | null = null;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.observer?.disconnect();
    this.observer = null;
  }

  protected updated(): void {
    // Lazy-load any thumbnail flagged with data-lazy-src once it scrolls into
    // view (toasts are on-screen, but the modal/later-stack can be long).
    const lazy = this.renderRoot.querySelectorAll<HTMLElement>("[data-lazy-src]");
    if (lazy.length === 0) return;
    if (!this.observer) {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const el = e.target as HTMLImageElement | HTMLVideoElement;
            const src = el.getAttribute("data-lazy-src");
            if (src) {
              el.setAttribute("src", src);
              el.removeAttribute("data-lazy-src");
              this.observer?.unobserve(el);
            }
          }
        },
        { rootMargin: "120px" },
      );
    }
    lazy.forEach((el) => this.observer!.observe(el));
  }

  private get ctx(): MediaRenderCtx {
    return {
      compact: this.compact,
      onThumb: (url, type) => openLightbox(url, type),
      lazySrc: (url) => url,
    };
  }

  render() {
    const m = this.media;
    if (!m) return nothing;
    switch (m.kind) {
      case "agent-summary":
        return renderAgentSummary(m.payload, this.ctx);
      case "agent-review":
        // Full in-depth review inside the proactive completion modal. No gateway
        // client is available in this shadow-DOM surface, so forward actions and
        // "regenerate" fall back to the `infinibot:review-action` window event
        // (picked up by the app / overlay host). compact in a muted later-tile.
        return renderAgentRunReview(m.payload, {
          client: null,
          requestUpdate: () => this.requestUpdate(),
          compact: this.compact,
        });
      case "note":
        return renderNote(m.payload, this.ctx);
      case "workflow":
        return renderWorkflow(m.payload, this.ctx);
      case "activity":
        return renderActivity(m.payload, this.ctx);
      case "custom":
        return renderCustom(m.payload, this.ctx);
      case "image":
        return renderImage(m.payload, this.ctx);
      case "video":
        return renderVideo(m.payload, this.ctx);
      case "html":
        return renderHtml(m.payload);
      case "pdf":
        return renderPdf(m.payload);
      case "stylized-markdown":
        return html`<stylized-markdown-overlay
          .payload=${m.payload}
          .eventId=${this.eventId}
          ?compact=${this.compact}
        ></stylized-markdown-overlay>`;
      case "card-deck":
        return html`<card-deck-overlay
          .payload=${m.payload}
          .eventId=${this.eventId}
        ></card-deck-overlay>`;
      case "project-kanban": {
        // The full interactive board owns its own center-stage surface (the
        // overlay host renders <embedded-kanban-overlay> directly). Inside a
        // generic media slot (e.g. a muted later-tile) show a compact affordance
        // that re-surfaces the actionable board.
        const p = m.payload;
        return html`<button
          class="pmedia-kanban-stub"
          @click=${() =>
            this.dispatchEvent(
              new CustomEvent("pmedia-surface", {
                detail: { eventId: this.eventId },
                bubbles: true,
                composed: true,
              }),
            )}
        >
          <span class="pmedia-badge">Board</span>
          <span class="pmedia-name">${p.projectName || "Project"} — push progress ▸</span>
        </button>`;
      }
      default:
        return nothing;
    }
  }

  static styles = css`
    :host {
      display: block;
      margin-top: 8px;
    }
    .pmedia {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    /* Staggered entrance — transform/opacity only. */
    .pmedia-stagger {
      animation: pmedia-in 0.34s cubic-bezier(0.2, 0.7, 0.2, 1) both;
      will-change: transform, opacity;
    }
    @keyframes pmedia-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .pmedia-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .pmedia-badge {
      font-size: 0.6rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--gold-1, var(--g-accent, #d4af37));
      background: color-mix(in srgb, var(--gold-1, #d4af37) 16%, transparent);
      border: 1px solid color-mix(in srgb, var(--gold-1, #d4af37) 40%, transparent);
      border-radius: 5px;
      padding: 2px 6px;
    }
    .pmedia-badge-note {
      color: #c4b5fd;
      background: rgba(167, 139, 250, 0.16);
      border-color: rgba(167, 139, 250, 0.4);
    }
    .pmedia-badge-wf {
      color: #5eead4;
      background: rgba(45, 212, 191, 0.16);
      border-color: rgba(45, 212, 191, 0.4);
    }
    .pmedia-name {
      font-weight: 700;
      color: var(--g-fg, #f5eacd);
      font-size: 0.84rem;
    }
    .pmedia-kanban-stub {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      text-align: left;
      cursor: pointer;
      background: rgba(212, 175, 55, 0.08);
      border: 1px solid rgba(212, 175, 55, 0.28);
      border-left: 3px solid var(--gold-1, #d4af37);
      border-radius: 10px;
      padding: 9px 11px;
    }
    .pmedia-kanban-stub:hover {
      border-color: var(--gold-1, #d4af37);
      background: rgba(212, 175, 55, 0.14);
    }
    .pmedia-proj {
      font-size: 0.66rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.6));
      background: rgba(255, 255, 255, 0.06);
      border-radius: 5px;
      padding: 1px 6px;
    }
    .pmedia-md {
      font-size: 0.78rem;
      line-height: 1.45;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.82));
      overflow: hidden;
    }
    .pmedia-md :first-child {
      margin-top: 0;
    }
    .pmedia-md :last-child {
      margin-bottom: 0;
    }
    .pmedia-md code {
      background: rgba(255, 255, 255, 0.09);
      padding: 0 4px;
      border-radius: 4px;
      font-size: 0.92em;
    }
    .pmedia-md pre {
      background: rgba(0, 0, 0, 0.4);
      padding: 8px 10px;
      border-radius: 8px;
      overflow: auto;
    }
    .pmedia-note-body {
      max-height: 7.5em;
    }
    /* diff stats */
    .pmedia-diff {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.72rem;
      font-weight: 700;
    }
    .pmedia-diff-files {
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.7));
    }
    .pmedia-diff-add {
      color: #34d399;
    }
    .pmedia-diff-del {
      color: #f87171;
    }
    .pmedia-bar {
      display: inline-flex;
      gap: 2px;
    }
    .pmedia-bar i {
      width: 7px;
      height: 7px;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.12);
    }
    .pmedia-bar i.add {
      background: #34d399;
    }
    .pmedia-bar i.del {
      background: #f87171;
    }
    /* completion status chips (built / committed) */
    .pmedia-status {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 2px;
    }
    .pmedia-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 0.58rem;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      border-radius: 5px;
      padding: 2px 7px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.8));
    }
    .pmedia-chip-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .pmedia-chip.ok {
      color: #34d399;
      border-color: rgba(52, 211, 153, 0.4);
      background: rgba(52, 211, 153, 0.12);
    }
    .pmedia-chip.warn {
      color: #fbbf24;
      border-color: rgba(251, 191, 36, 0.4);
      background: rgba(251, 191, 36, 0.12);
    }
    /* workflow steps */
    .pmedia-wf-status {
      margin-left: auto;
      font-size: 0.6rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border-radius: 5px;
      padding: 1px 6px;
    }
    .pmedia-wf-running {
      color: #60a5fa;
      background: rgba(96, 165, 250, 0.18);
    }
    .pmedia-wf-done {
      color: #34d399;
      background: rgba(52, 211, 153, 0.18);
    }
    .pmedia-wf-failed {
      color: #f87171;
      background: rgba(248, 113, 113, 0.18);
    }
    .pmedia-wf-queued {
      color: #fbbf24;
      background: rgba(251, 191, 36, 0.18);
    }
    .pmedia-steps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .pmedia-step {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 0.76rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.72));
    }
    .pmedia-step-glyph {
      width: 1em;
      text-align: center;
    }
    .pmedia-step-done .pmedia-step-glyph {
      color: #34d399;
    }
    .pmedia-step-running .pmedia-step-glyph {
      color: #60a5fa;
    }
    .pmedia-step-failed .pmedia-step-glyph {
      color: #f87171;
    }
    .pmedia-step-done .pmedia-step-label {
      color: var(--g-fg, #f5eacd);
    }
    /* activity */
    .pmedia-activity {
      flex-direction: row;
      align-items: center;
      gap: 10px;
    }
    .pmedia-act-icon {
      font-size: 1.1rem;
      line-height: 1;
    }
    .pmedia-act-line {
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--g-fg, #f5eacd);
    }
    .pmedia-act-detail {
      font-size: 0.72rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.6));
    }
    /* thumbnails */
    .pmedia-thumbs {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .pmedia-thumb {
      position: relative;
      width: 64px;
      height: 64px;
      border-radius: 9px;
      overflow: hidden;
      border: 1px solid var(--g-border, rgba(212, 175, 55, 0.28));
      background: rgba(0, 0, 0, 0.35);
      padding: 0;
      cursor: pointer;
    }
    .pmedia-thumb-wide {
      width: 100%;
      height: 150px;
    }
    .pmedia-thumb:hover {
      border-color: var(--gold-1, #d4af37);
    }
    .pmedia-thumb-media {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .pmedia-play {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 1rem;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
      pointer-events: none;
    }
    /* image / video captions */
    .pmedia-caption {
      font-size: 0.72rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.62));
      line-height: 1.4;
    }
    .pmedia-dur {
      position: absolute;
      right: 6px;
      bottom: 6px;
      font-size: 0.62rem;
      font-weight: 700;
      color: #fff;
      background: rgba(0, 0, 0, 0.6);
      border-radius: 4px;
      padding: 1px 5px;
    }
    /* sanitized html fragment frame */
    .pmedia-htmlframe {
      border: 1px solid rgba(212, 175, 55, 0.2);
      border-radius: 9px;
      background: rgba(0, 0, 0, 0.28);
      padding: 9px 11px;
      max-height: 40vh;
      overflow: auto;
    }
    /* pdf card */
    .pmedia-pdfcard {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .pmedia-pdfframe {
      border: 1px solid rgba(212, 175, 55, 0.26);
      border-radius: 10px;
      overflow: hidden;
      background: #0c0c10;
      height: 320px;
    }
    .pmedia-pdfembed {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
    }
    .pmedia-pdfrow {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pmedia-pdfcard-stub {
      flex-direction: row;
      align-items: center;
      border: 1px solid rgba(212, 175, 55, 0.26);
      border-left: 3px solid var(--gold-1, #d4af37);
      border-radius: 10px;
      background: rgba(14, 16, 24, 0.7);
      padding: 11px 13px;
    }
    .pmedia-pdf-icon {
      font-size: 0.62rem;
      font-weight: 900;
      letter-spacing: 0.06em;
      color: #1a1206;
      background: linear-gradient(135deg, var(--gold-1, #d4af37), #b8902f);
      border-radius: 6px;
      padding: 8px 9px;
    }
    .pmedia-pdf-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
      min-width: 0;
    }
    .pmedia-pdf-name {
      font-weight: 700;
      font-size: 0.82rem;
      color: var(--g-fg, #f5eacd);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pmedia-pdf-btn {
      background: linear-gradient(135deg, var(--gold-1, #d4af37), #b8902f);
      color: #1a1206;
      border: 0;
      border-radius: 7px;
      padding: 5px 12px;
      font-size: 0.74rem;
      font-weight: 800;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "proactive-media": ProactiveMedia;
  }
}
