/**
 * overlay-card-base.ts — CANONICAL shared chrome for every overlay card (Agent B).
 *
 * Subclass this, provide a title (`cardTitle` getter OR `cardTitle()` method),
 * and implement `renderBody()`. The base provides the gold-glass frame plus drag
 * (header), resize (bottom-right handle), minimize, close, and
 * bring-to-front-on-focus.
 *
 * Geometry is owned by the card host (`:host{position:fixed}`) and seeded from
 * `record.position`. Drag/resize mutate `this.style` directly (no re-render mid
 * gesture) and report the final geometry to the store on pointer-up.
 *
 * Colors come exclusively from theme-glass tokens (gold `--g-primary`, ivory
 * `--g-fg`, glass surfaces) — no hardcoded hex.
 *
 * ── Integration contract ──────────────────────────────────────────────────────
 *  Set by <agent-overlay-layer> on each card:
 *    .record  : OverlayRecord                — full overlay record (canonical)
 *    .gateway : GatewayBrowserClient | null  — shared gateway client
 *    .store   : OverlayStore | null          — for position/close callbacks
 *  Back-compat getters for Agent C's business cards (read-only):
 *    .payload   → record.payload
 *    .overlayId → record.overlayId
 *    .client    → gateway
 *  Subclass API:
 *    get cardTitle()/cardTitle()  — header label (string or method, both work)
 *    get cardIcon()               — optional header glyph
 *    renderBody()                 — card body template
 *    headerMeta()                 — optional right-aligned header chip
 *    accent                       — optional header accent colour
 *  Compose styles via:  static styles = [OverlayCardBase.baseStyles, css`…`]
 */

import { LitElement, html, css, nothing, type CSSResult, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import type { OverlayRecord, OverlayPosition, OverlayStore } from "../controllers/overlay-store";

// Shared front-most z-index across all cards so focus brings one above the rest.
let TOP_Z = 60;

const MIN_W = 240;
const MIN_H = 120;

export class OverlayCardBase extends LitElement {
  @property({ attribute: false }) record!: OverlayRecord;
  @property({ attribute: false }) gateway: GatewayBrowserClient | null = null;
  @property({ attribute: false }) store: OverlayStore | null = null;
  @property({ type: Boolean }) compact = false;

  @state() protected minimized = false;

  /** Header accent colour. Subclasses may override. */
  protected accent = "var(--g-primary, #fbbf24)";

  // ── back-compat read-only accessors (Agent C cards use these) ───────────
  get payload(): Record<string, unknown> {
    return this.record?.payload ?? {};
  }
  get overlayId(): string {
    return this.record?.overlayId ?? "";
  }
  get client(): GatewayBrowserClient | null {
    return this.gateway;
  }

  /** Card title — override as a getter or a method; both resolve. */
  protected get cardTitle(): string {
    return this.record?.type ?? "Overlay";
  }

  /** Optional small glyph icon for the header. Override in subclasses. */
  protected get cardIcon(): string {
    return "◆";
  }

  /** The card-specific body. Override in subclasses. */
  protected renderBody(): TemplateResult | typeof nothing {
    return html`<pre class="ovc-raw">${JSON.stringify(this.record?.payload ?? {}, null, 2)}</pre>`;
  }

  /** Optional right-aligned header chip (status, count, …). */
  protected headerMeta(): unknown {
    return null;
  }

  /** Resolve title whether the subclass used a getter or a method. */
  private resolveTitle(): string {
    const t = (this as unknown as { cardTitle: unknown }).cardTitle;
    return typeof t === "function" ? String((t as () => string).call(this)) : String(t ?? "");
  }

  static baseStyles: CSSResult = css`
    :host {
      position: fixed;
      display: block;
      z-index: 60;
      width: 420px;
      box-sizing: border-box;
      color: var(--g-fg, #f5f5f4);
      font-family: var(--g-font, system-ui, -apple-system, sans-serif);
    }
    .ovc {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-width: ${MIN_W}px;
      min-height: 0;
      border-radius: var(--g-radius-lg, 16px);
      background: var(
        --g-gradient-surface,
        linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.03))
      );
      backdrop-filter: var(--g-blur-heavy, blur(22px) saturate(180%));
      -webkit-backdrop-filter: var(--g-blur-heavy, blur(22px) saturate(180%));
      border: 1px solid var(--g-border-strong, rgba(251, 191, 36, 0.3));
      box-shadow:
        0 18px 50px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.04) inset,
        0 0 22px color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
      overflow: hidden;
      position: relative;
    }
    :host([data-minimized]) .ovc {
      height: auto;
    }
    /* gold L-bracket corner accents */
    .ovc::before,
    .ovc::after {
      content: "";
      position: absolute;
      width: 12px;
      height: 12px;
      border: 1.5px solid var(--accent, var(--g-primary, #fbbf24));
      opacity: 0.7;
      pointer-events: none;
      z-index: 2;
    }
    .ovc::before {
      top: 6px;
      left: 6px;
      border-right: none;
      border-bottom: none;
    }
    .ovc::after {
      bottom: 6px;
      right: 6px;
      border-left: none;
      border-top: none;
    }
    .ovc-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      cursor: grab;
      user-select: none;
      background: var(--g-surface-strong, rgba(255, 255, 255, 0.06));
      border-bottom: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
      flex: 0 0 auto;
    }
    .ovc-head.dragging {
      cursor: grabbing;
    }
    .ovc-icon {
      color: var(--accent, var(--g-primary, #fbbf24));
      font-size: 13px;
      line-height: 1;
      flex: 0 0 auto;
    }
    .ovc-title {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--accent, var(--g-fg, #f5f5f4));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ovc-meta {
      font-size: 9px;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
      letter-spacing: 0.05em;
      flex: 0 0 auto;
    }
    .ovc-actions {
      display: flex;
      gap: 4px;
      flex: 0 0 auto;
    }
    .ovc-actions button {
      width: 22px;
      height: 22px;
      display: grid;
      place-items: center;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      transition:
        background 120ms ease,
        color 120ms ease;
    }
    .ovc-actions button:hover {
      background: var(--g-primary-soft, rgba(251, 191, 36, 0.12));
      color: var(--g-primary, #fbbf24);
    }
    .ovc-actions button.close:hover {
      background: rgba(248, 113, 113, 0.18);
      color: #fca5a5;
    }
    .ovc-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 12px;
      font-size: 13px;
      line-height: 1.5;
    }
    :host([data-minimized]) .ovc-body,
    :host([data-minimized]) .ovc-resize {
      display: none;
    }
    .ovc-raw {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--g-mono, ui-monospace, monospace);
      font-size: 12px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
    }
    .ovc-resize {
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      touch-action: none;
      z-index: 3;
    }
    .ovc-resize::after {
      content: "";
      position: absolute;
      right: 3px;
      bottom: 3px;
      width: 7px;
      height: 7px;
      border-right: 2px solid var(--g-primary, #fbbf24);
      border-bottom: 2px solid var(--g-primary, #fbbf24);
      opacity: 0.6;
    }
    .ovc-body::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    .ovc-body::-webkit-scrollbar-thumb {
      background: var(--g-primary-muted, rgba(251, 191, 36, 0.18));
      border-radius: 8px;
    }
  `;

  static styles = OverlayCardBase.baseStyles;

  connectedCallback(): void {
    super.connectedCallback();
    this.style.zIndex = String(++TOP_Z);
  }

  firstUpdated(): void {
    this.applyGeometry();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("record")) this.applyGeometry();
  }

  private applyGeometry() {
    const p = this.record?.position;
    if (!p) return;
    this.style.left = `${p.x}px`;
    this.style.top = `${p.y}px`;
    this.style.width = `${Math.max(MIN_W, p.w)}px`;
    if (!this.minimized) this.style.height = `${Math.max(MIN_H, p.h)}px`;
  }

  private bringToFront = () => {
    this.style.zIndex = String(++TOP_Z);
  };

  // ── drag ────────────────────────────────────────────────────────────────
  private onHeaderPointerDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    this.bringToFront();
    const header = e.currentTarget as HTMLElement;
    header.classList.add("dragging");
    header.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = this.offsetLeft;
    const startTop = this.offsetTop;

    const onMove = (ev: PointerEvent) => {
      const nx = Math.max(0, startLeft + (ev.clientX - startX));
      const ny = Math.max(0, startTop + (ev.clientY - startY));
      this.style.left = `${nx}px`;
      this.style.top = `${ny}px`;
    };
    const onUp = () => {
      header.classList.remove("dragging");
      try {
        header.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      header.removeEventListener("pointermove", onMove);
      header.removeEventListener("pointerup", onUp);
      this.commitGeometry();
    };
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", onUp);
  }

  // ── resize ──────────────────────────────────────────────────────────────
  private onResizePointerDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.bringToFront();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = this.offsetWidth;
    const startH = this.offsetHeight;

    const onMove = (ev: PointerEvent) => {
      const nw = Math.max(MIN_W, startW + (ev.clientX - startX));
      const nh = Math.max(MIN_H, startH + (ev.clientY - startY));
      this.style.width = `${nw}px`;
      this.style.height = `${nh}px`;
    };
    const onUp = () => {
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      this.commitGeometry();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  private commitGeometry() {
    const pos: OverlayPosition = {
      x: this.offsetLeft,
      y: this.offsetTop,
      w: this.offsetWidth,
      h: this.minimized ? this.record?.position.h ?? MIN_H : this.offsetHeight,
    };
    if (this.record) this.record.position = pos;
    if (this.record?.overlayId) this.store?.updatePosition(this.record.overlayId, pos);
  }

  private toggleMinimize() {
    this.minimized = !this.minimized;
    if (this.minimized) {
      this.setAttribute("data-minimized", "");
      this.style.height = "auto";
    } else {
      this.removeAttribute("data-minimized");
      this.style.height = `${Math.max(MIN_H, this.record?.position.h ?? 320)}px`;
    }
  }

  /** Close this overlay — store removes it; also emits `overlay-close`. */
  close() {
    if (this.store && this.record?.overlayId) this.store.close(this.record.overlayId);
    this.dispatchEvent(
      new CustomEvent("overlay-close", {
        detail: { overlayId: this.overlayId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div class="ovc" style=${`--accent:${this.accent}`} @pointerdown=${this.bringToFront}>
        <div class="ovc-head" @pointerdown=${(e: PointerEvent) => this.onHeaderPointerDown(e)}>
          <span class="ovc-icon">${this.cardIcon}</span>
          <span class="ovc-title" title=${this.resolveTitle()}>${this.resolveTitle()}</span>
          <span class="ovc-meta">${this.headerMeta()}</span>
          <div class="ovc-actions">
            <button
              class="min"
              title=${this.minimized ? "Restore" : "Minimize"}
              @click=${() => this.toggleMinimize()}
            >
              ${this.minimized ? "▢" : "—"}
            </button>
            <button class="close" title="Close" @click=${() => this.close()}>✕</button>
          </div>
        </div>
        <div class="ovc-body">${this.renderBody()}</div>
        <div class="ovc-resize" @pointerdown=${(e: PointerEvent) => this.onResizePointerDown(e)}></div>
      </div>
    `;
  }
}
