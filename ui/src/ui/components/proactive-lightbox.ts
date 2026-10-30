/**
 * <proactive-lightbox> — single global media lightbox for the overlay system.
 *
 * No lightbox existed in the control-ui, so this is the canonical one for
 * embedded pop-up media. A module-level singleton element is lazily mounted on
 * <body>; call {@link openLightbox} from anywhere (e.g. a media thumbnail
 * click) to show an image or video full-screen. Esc / backdrop click closes.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

@customElement("proactive-lightbox")
export class ProactiveLightbox extends LitElement {
  @state() private url: string | null = null;
  @state() private type: "image" | "video" = "image";

  open(url: string, type: "image" | "video"): void {
    this.url = url;
    this.type = type;
  }
  close(): void {
    this.url = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey);
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
  }
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.url) {
      e.stopPropagation();
      this.close();
    }
  };

  render() {
    if (!this.url) return nothing;
    return html`
      <div class="lb-backdrop" @click=${() => this.close()}>
        <button class="lb-close" aria-label="Close" @click=${() => this.close()}>✕</button>
        <div class="lb-stage" @click=${(e: Event) => e.stopPropagation()}>
          ${this.type === "video"
            ? html`<video class="lb-media" src=${this.url} controls autoplay playsinline></video>`
            : html`<img class="lb-media" src=${this.url} alt="media preview" />`}
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 10010;
      display: contents;
    }
    .lb-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(4, 5, 10, 0.86);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
      animation: lb-fade 0.16s ease-out;
    }
    @keyframes lb-fade {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    .lb-stage {
      max-width: 92vw;
      max-height: 88vh;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.7);
      border: 1px solid var(--g-border, rgba(212, 175, 55, 0.3));
    }
    .lb-media {
      display: block;
      max-width: 92vw;
      max-height: 88vh;
      object-fit: contain;
    }
    .lb-close {
      position: fixed;
      top: 18px;
      right: 22px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.18));
      background: rgba(18, 20, 30, 0.8);
      color: var(--g-fg, #f5eacd);
      font-size: 1rem;
      cursor: pointer;
    }
    .lb-close:hover {
      background: rgba(255, 255, 255, 0.15);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "proactive-lightbox": ProactiveLightbox;
  }
}

let singleton: ProactiveLightbox | null = null;

/** Show a media URL full-screen in the shared lightbox (mounts lazily). */
export function openLightbox(url: string, type: "image" | "video" = "image"): void {
  if (!singleton) {
    singleton = document.createElement("proactive-lightbox") as ProactiveLightbox;
    document.body.appendChild(singleton);
  }
  singleton.open(url, type);
}
