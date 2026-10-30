/**
 * agent-overlay-layer.ts — single shadow-DOM host for the Agentic Overlay System.
 *
 * Mounted ONCE at the app root (see app-render.ts). Owns an OverlayStore, which
 * subscribes to the gateway WS topic `overlay.events`, hydrates via
 * `ui.overlay.list`, and also honours the devtools `overlay.spawn` hook. This
 * element reconciles the store's records into typed cards, lazy-loading each
 * card module on first use so the initial bundle stays lean.
 *
 * The highlight effect paints into a separate fixed light-DOM layer (see
 * overlay-highlight.ts) so it can overlay the whole page and be measured against
 * page geometry — it does not live inside this shadow root.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewayBrowserClient } from "../gateway";
import { OverlayStore, type OverlayRecord } from "../controllers/overlay-store";
import { OverlayCardBase } from "./overlay-card-base";

// Card types this agent owns, with their lazy module loaders. Business + live
// types (Agent C) are resolved at runtime if their elements are registered;
// otherwise they fall back to a generic card so nothing silently vanishes.
const OWNED_LOADERS: Record<string, () => Promise<unknown>> = {
  note: () => import("./overlay-card-note"),
  task: () => import("./overlay-card-task"),
  project: () => import("./overlay-card-project"),
  portfolio: () => import("./overlay-card-portfolio"),
  markdown: () => import("./overlay-card-markdown"),
  image: () => import("./overlay-card-image"),
  code: () => import("./overlay-card-code"),
  pdf: () => import("./overlay-card-pdf"),
  diagram: () => import("./overlay-card-diagram"),
};

const FALLBACK_TAG = "overlay-card-fallback";

@customElement("agent-overlay-layer")
export class AgentOverlayLayer extends LitElement {
  /** Shared gateway client (set from app-render: `.gateway=${state.client}`). */
  @property({ attribute: false }) gateway: GatewayBrowserClient | null = null;

  private store = new OverlayStore();
  private unsub: (() => void) | null = null;
  private loaded = new Set<string>();
  private loading = new Set<string>();

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 50;
    }
    /* Cards re-enable pointer events on themselves. */
    ::slotted(*),
    .cards > * {
      pointer-events: auto;
    }
    .clear-all {
      position: fixed;
      top: 76px;
      right: 18px;
      pointer-events: auto;
      border: 1px solid var(--g-primary-muted, rgba(251, 191, 36, 0.35));
      border-radius: 999px;
      padding: 6px 10px;
      background: color-mix(in srgb, var(--g-bg, #09090b) 88%, transparent);
      color: var(--g-fg, #f4f4f5);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
      cursor: pointer;
      font: 600 10px/1 var(--font-mono, ui-monospace, monospace);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsub = this.store.onChange(() => this.requestUpdate());
    this.store.startDevHook();
    this.store.connect(this.gateway);
    window.addEventListener("keydown", this.onKeydown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
    this.store.dispose();
    window.removeEventListener("keydown", this.onKeydown);
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("gateway")) this.store.connect(this.gateway);
  }

  // ── lazy module loading ────────────────────────────────────────────────
  private ensureLoaded(type: string) {
    if (this.loaded.has(type) || this.loading.has(type)) return;
    const loader = OWNED_LOADERS[type];
    if (!loader) {
      // Not an owned type. If an element is already registered (e.g. Agent C's
      // bundle), use it; otherwise it'll fall back. Either way nothing to load.
      this.loaded.add(type);
      return;
    }
    this.loading.add(type);
    void loader()
      .then(() => {
        this.loaded.add(type);
        this.loading.delete(type);
        this.requestUpdate();
      })
      .catch(() => {
        this.loading.delete(type);
        // Mark loaded so we fall back instead of retrying forever.
        this.loaded.add(type);
        this.requestUpdate();
      });
  }

  private tagFor(type: string): string {
    const tag = `overlay-card-${type}`;
    if (OWNED_LOADERS[type]) return this.loaded.has(type) ? tag : "";
    // Non-owned: use the registered element if present, else fallback.
    return customElements.get(tag) ? tag : FALLBACK_TAG;
  }

  private onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    // Let a foreground dialog/inspector consume Escape first. Checking after
    // propagation prevents one keypress from closing two stacked surfaces.
    queueMicrotask(() => {
      if (!event.defaultPrevented) this.store.closeNewest();
    });
  };

  private renderCard(rec: OverlayRecord) {
    this.ensureLoaded(rec.type);
    const tag = this.tagFor(rec.type);
    if (!tag) return nothing; // owned module still loading
    const tagLiteral = unsafeStatic(tag);
    return staticHtml`<${tagLiteral}
      .record=${rec}
      .gateway=${this.gateway}
      .store=${this.store}
    ></${tagLiteral}>`;
  }

  render() {
    const overlays = this.store.list();
    return html`
      <div class="cards">
        ${repeat(
          overlays,
          (r) => r.overlayId,
          (r) => this.renderCard(r),
        )}
      </div>
      ${overlays.length > 1
        ? html`<button class="clear-all" @click=${() => this.store.clearAll()}>
            Clear overlays (${overlays.length})
          </button>`
        : nothing}
    `;
  }
}

/**
 * Generic fallback card — shown for unknown/not-yet-loaded card types so an
 * overlay never silently disappears. Reuses the shared chrome.
 */
@customElement(FALLBACK_TAG)
export class OverlayCardFallback extends OverlayCardBase {
  protected get cardIcon() {
    return "◇";
  }
  protected get cardTitle() {
    return `${this.record?.type ?? "overlay"}`;
  }
  protected headerMeta() {
    return "unsupported";
  }
}
