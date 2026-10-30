/**
 * <ib-chat-view-controls> — chat header controls for transcript width
 * (Full width / Centered) and text zoom (A− · % reset · A+).
 *
 * Stateless about storage: reads/writes chat-view-prefs, which broadcasts
 * so every mounted copy (1:1 header, group header) stays in sync.
 * `compact` (phones) hides the width toggle and tightens the zoom group.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import {
  CHAT_ZOOM_DEFAULT,
  CHAT_ZOOM_STEPS,
  loadChatViewPrefs,
  onChatViewPrefs,
  saveChatViewPrefs,
  stepZoom,
  type ChatViewPrefs,
} from "./chat-view-prefs";

const MIN = CHAT_ZOOM_STEPS[0];
const MAX = CHAT_ZOOM_STEPS[CHAT_ZOOM_STEPS.length - 1];

@customElement("ib-chat-view-controls")
export class ChatViewControls extends LitElement {
  @property({ type: Boolean, reflect: true }) compact = false;
  @state() private prefs: ChatViewPrefs = loadChatViewPrefs();
  private unsub: (() => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.prefs = loadChatViewPrefs();
    this.unsub = onChatViewPrefs((p) => (this.prefs = p));
  }

  disconnectedCallback() {
    this.unsub?.();
    this.unsub = null;
    super.disconnectedCallback();
  }

  private setWidth(width: ChatViewPrefs["width"]) {
    this.prefs = saveChatViewPrefs({ width });
  }

  private zoom(dir: 1 | -1 | 0) {
    this.prefs = saveChatViewPrefs({ zoom: dir === 0 ? CHAT_ZOOM_DEFAULT : stepZoom(this.prefs.zoom, dir) });
  }

  render() {
    const { width, zoom } = this.prefs;
    const mod = /Mac|iP(hone|ad|od)/.test(globalThis.navigator?.platform ?? "") ? "⌘" : "Ctrl";
    return html`
      ${this.compact
        ? nothing
        : html`<div class="seg" role="radiogroup" aria-label="Transcript width">
            <button
              class="btn ${width === "full" ? "on" : ""}"
              role="radio"
              aria-checked=${width === "full" ? "true" : "false"}
              title="Full width"
              data-testid="chat-width-full"
              @click=${() => this.setWidth("full")}
            >
              ${icons.maximize}<span class="lbl">Full width</span>
            </button>
            <button
              class="btn ${width === "centered" ? "on" : ""}"
              role="radio"
              aria-checked=${width === "centered" ? "true" : "false"}
              title="Centered"
              data-testid="chat-width-centered"
              @click=${() => this.setWidth("centered")}
            >
              ${icons.minimize}<span class="lbl">Centered</span>
            </button>
          </div>`}
      <div class="seg zoom" role="group" aria-label="Text size">
        <button
          class="btn a"
          title=${`Smaller text (${mod} −)`}
          aria-label="Smaller text"
          data-testid="chat-zoom-out"
          ?disabled=${zoom <= MIN}
          @click=${() => this.zoom(-1)}
        >
          <span class="a-glyph a-glyph--sm">A</span>${icons.minus}
        </button>
        <button
          class="btn pct ${zoom !== CHAT_ZOOM_DEFAULT ? "on" : ""}"
          title=${`Reset text size (${mod} 0)`}
          aria-label=${`Text size ${zoom}%, reset to 100%`}
          data-testid="chat-zoom-reset"
          @click=${() => this.zoom(0)}
        >
          ${zoom}%
        </button>
        <button
          class="btn a"
          title=${`Larger text (${mod} +)`}
          aria-label="Larger text"
          data-testid="chat-zoom-in"
          ?disabled=${zoom >= MAX}
          @click=${() => this.zoom(1)}
        >
          <span class="a-glyph">A</span>${icons.plus}
        </button>
      </div>
    `;
  }

  static styles = css`
    :host { display: inline-flex; align-items: center; gap: 6px; flex: none; }
    .seg {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border-radius: var(--glass-radius-sm, 10px);
      border: 1px solid var(--glass-stroke, var(--border));
      background: color-mix(in srgb, var(--glass-base, var(--bg)) 45%, transparent);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 28px;
      min-width: 28px;
      padding: 0 8px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--glass-fg-3, var(--muted));
      font: 500 12px/1 var(--glass-font, inherit);
      cursor: pointer;
      white-space: nowrap;
      transition: background-color 0.15s, color 0.15s;
    }
    .btn:hover:not(:disabled) { background: var(--glass-hover, var(--bg-hover)); color: var(--glass-fg, var(--text)); }
    .btn:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px var(--accent)); }
    .btn:disabled { opacity: 0.35; cursor: default; }
    .btn.on {
      color: var(--glass-gold, var(--accent));
      background: var(--glass-gold-a10, var(--accent-subtle));
      box-shadow: inset 0 0 0 1px var(--glass-stroke-gold, transparent);
    }
    .btn svg { width: 14px; height: 14px; flex: none; }
    .zoom .btn.a { padding: 0 6px; gap: 1px; }
    .zoom .btn.a svg { width: 10px; height: 10px; }
    .a-glyph { font: 600 15px/1 var(--font-ui-display, var(--glass-font, inherit)); }
    .a-glyph--sm { font-size: 12px; }
    .pct { min-width: 46px; font-variant-numeric: tabular-nums; }
    @media (max-width: 1280px) { .lbl { display: none; } }
    :host([compact]) .btn { height: 30px; min-width: 30px; }
    :host([compact]) .pct { min-width: 40px; padding: 0 4px; font-size: 11px; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-chat-view-controls": ChatViewControls;
  }
}
