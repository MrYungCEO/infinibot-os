/**
 * <agency-note-overlay>
 *
 * Floating overlay panel for editing sticky-note marks in the agency world.
 * Uses <moltbot-block-editor> for rich Notion-style editing. Positioned near
 * the clicked mark via the `position` property and anchored to screen coords.
 *
 * Events:
 *   save  → { noteId, value }
 *   close → (no detail)
 */

import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./block-editor.js";

export interface NoteOverlayPosition {
  x: number;
  y: number;
}

@customElement("agency-note-overlay")
export class AgencyNoteOverlay extends LitElement {
  @property({ type: String }) noteId = "";
  @property({ type: String }) value = "";
  @property({ type: Object }) position: NoteOverlayPosition = { x: 0, y: 0 };

  static styles = css`
    :host {
      display: block;
      position: fixed;
      z-index: 9999;
      font-family: "JetBrains Mono", "SF Mono", monospace;
    }

    .overlay-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9998;
    }

    .overlay-panel {
      position: fixed;
      width: 400px;
      height: 300px;
      background: rgba(10, 14, 26, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(212, 175, 55, 0.6);
      border-radius: 10px;
      box-shadow:
        0 0 0 1px rgba(212, 175, 55, 0.15),
        0 8px 32px rgba(0, 0, 0, 0.5),
        0 2px 8px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: overlay-in 0.2s ease-out;
    }

    @keyframes overlay-in {
      from {
        opacity: 0;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .overlay-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: rgba(212, 175, 55, 0.08);
      border-bottom: 1px solid rgba(212, 175, 55, 0.2);
      flex-shrink: 0;
    }

    .overlay-header .title {
      color: #d4af37;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .overlay-header .close-btn {
      appearance: none;
      border: 1px solid rgba(212, 175, 55, 0.3);
      background: transparent;
      color: #9aa2b1;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
      transition: all 0.15s;
    }

    .overlay-header .close-btn:hover {
      color: #d4af37;
      background: rgba(212, 175, 55, 0.1);
      border-color: rgba(212, 175, 55, 0.5);
    }

    .overlay-body {
      flex: 1;
      overflow: auto;
      padding: 0;
    }

    .overlay-body moltbot-block-editor {
      --me-bg: transparent;
      --me-border: transparent;
      --me-text: #f5f5f4;
      --me-muted: rgba(245, 245, 244, 0.55);
      display: block;
      height: 100%;
    }
  `;

  private handleSave(e: CustomEvent<{ value: string }>) {
    this.dispatchEvent(
      new CustomEvent("save", {
        detail: { noteId: this.noteId, value: e.detail.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleClose() {
    this.dispatchEvent(
      new CustomEvent("close", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") this.handleClose();
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.boundKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.boundKeydown);
  }

  private boundKeydown = this.handleKeydown.bind(this);

  private computePanelStyle(): string {
    const PAD = 12;
    let left = this.position.x + PAD;
    let top = this.position.y + PAD;
    const W = 400;
    const H = 300;
    if (left + W > window.innerWidth) left = Math.max(PAD, left - W - PAD * 2);
    if (top + H > window.innerHeight) top = Math.max(PAD, top - H - PAD * 2);
    return `left:${left}px;top:${top}px`;
  }

  override render() {
    return html`
      <div class="overlay-backdrop" @click=${this.handleClose}></div>
      <div class="overlay-panel" style=${this.computePanelStyle()}>
        <div class="overlay-header">
          <span class="title">Note: ${this.noteId.slice(0, 12)}</span>
          <button class="close-btn" @click=${this.handleClose} title="Close (Esc)">
            &#x2715;
          </button>
        </div>
        <div class="overlay-body">
          <moltbot-block-editor
            .value=${this.value}
            placeholder="Type / for commands…"
            @change=${this.handleSave}
          ></moltbot-block-editor>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agency-note-overlay": AgencyNoteOverlay;
  }
}