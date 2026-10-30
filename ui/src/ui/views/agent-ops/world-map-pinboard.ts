/**
 * World-Map Pin Board Overlay
 * ───────────────────────────
 * A futuristic HUD "notice board" pinned to the bottom-right of the agent
 * world map (ActivityMap host container). Surfaces the live "recently
 * completed" kanban feed as pinned cards, sliding new entries in from the top.
 *
 * This is the 4th consumer of `recently-completed-feed.ts` (after
 * projects / activity / dashboard). It renders OUTSIDE the main Lit app tree —
 * straight into a DOM node appended to the map's host container, beside the
 * Pixi canvas — so it refreshes via `onRecentlyCompletedChange()` rather than
 * the app-level `requestUpdate`.
 *
 * The board reports its rendered height back to the host (onReservedChange) so
 * the Pixi zoom/fit/label controls can float ABOVE it instead of overlapping.
 */

import { html, nothing, render, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../gateway";
import {
  loadRecentlyCompleted,
  subscribeRecentCompleted,
  onRecentlyCompletedChange,
  getRecentlyCompletedEntries,
  getRecentlyCompletedTodayCount,
  renderRecentlyCompletedCompactList,
} from "../recently-completed-feed";
import {
  FLOATING_AGENT_CARD_CSS,
  ZoomFadeController,
} from "../../components/floating-agent-card";

const COLLAPSE_KEY = "infinibot.hq.pinboardCollapsed";
/** Breathing room between the board's top edge and the Pixi controls above it. */
const RESERVE_GAP = 10;
/** Newest-N entries to surface on the board. */
const PIN_LIMIT = 8;

export interface WorldMapPinboardOptions {
  /** Called with the board's reserved height (px, incl. gap) whenever it changes. */
  onReservedChange: (px: number) => void;
  /** Navigate to a completed task in the kanban board. */
  onNavigate: (taskId: string, projectId: string | null) => void;
  /** Optional gateway client to (re)warm + ensure the live subscription. */
  client?: GatewayBrowserClient | null;
  /** App-level re-render, forwarded to the shared feed loader. */
  requestUpdate?: () => void;
}

export class WorldMapPinboard {
  private readonly host: HTMLElement;
  private readonly opts: WorldMapPinboardOptions;
  private readonly el: HTMLDivElement;
  private collapsed: boolean;
  private resizeObserver: ResizeObserver | null = null;
  private unsubChange: (() => void) | null = null;
  private destroyed = false;
  private lastReserved = -1;
  private readonly zoomFade: ZoomFadeController;

  constructor(host: HTMLElement, opts: WorldMapPinboardOptions) {
    this.host = host;
    this.opts = opts;
    this.collapsed = this.readCollapsed();

    this.el = document.createElement("div");
    this.el.className = "wmpb-overlay fac-floating-root";
    this.el.setAttribute("aria-label", "Recently completed pin board");
    host.appendChild(this.el);

    // Fade the free-floating cards out when the map is zoomed in past the
    // threshold so they stop fighting the canvas (hysteresis avoids flicker).
    this.zoomFade = new ZoomFadeController(this.el, {
      fadeOutAbove: 1.3,
      fadeInBelow: 1.15,
    });
    this.zoomFade.start();

    // Warm the shared feed + ensure the (idempotent, app-global) WS
    // subscription. Both are no-ops if another surface already did it.
    if (opts.client) {
      void loadRecentlyCompleted(opts.client, opts.requestUpdate ?? (() => {}), {
        limit: 25,
      });
      subscribeRecentCompleted(opts.client);
    }

    // Re-render when feed data/animation state changes. We listen on our own
    // channel and DO NOT touch the shared WS subscription, so cleanup here
    // never starves the other mount points.
    this.unsubChange = onRecentlyCompletedChange(() => this.render());

    // Track our own rendered height → reserve space for the Pixi controls.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.reportReserved());
      this.resizeObserver.observe(this.el);
    }

    this.render();
    // Initial reserve once the first layout pass settles.
    requestAnimationFrame(() => this.reportReserved());
  }

  destroy(): void {
    this.destroyed = true;
    this.zoomFade?.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.unsubChange?.();
    this.unsubChange = null;
    // Hand the bottom space back so the controls drop to their default anchor.
    this.opts.onReservedChange(0);
    this.el.remove();
  }

  // ── Collapse persistence ──────────────────────────────────────

  private readCollapsed(): boolean {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  }

  private setCollapsed(value: boolean): void {
    this.collapsed = value;
    try {
      localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
    } catch {
      /* ignore quota / disabled storage */
    }
    this.render();
    // Height changes on collapse/expand; ResizeObserver will also catch this,
    // but report immediately so the controls don't lag a frame.
    requestAnimationFrame(() => this.reportReserved());
  }

  // ── Reserve reporting ─────────────────────────────────────────

  private reportReserved(): void {
    if (this.destroyed) return;
    const h = this.el.getBoundingClientRect().height;
    const reserved = h > 0 ? Math.round(h) + RESERVE_GAP : 0;
    if (reserved === this.lastReserved) return;
    this.lastReserved = reserved;
    this.opts.onReservedChange(reserved);
  }

  // ── Render ────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    render(this.template(), this.el);
  }

  private navigate(taskId: string, projectId: string | null): void {
    if (!taskId || taskId.startsWith("__")) return; // ignore feed sentinels
    this.opts.onNavigate(taskId, projectId);
  }

  private template(): TemplateResult {
    const todayCount = getRecentlyCompletedTodayCount();
    const entries = getRecentlyCompletedEntries(PIN_LIMIT);

    return html`
      ${this.styles()}
      <div class="wmpb-frame ${this.collapsed ? "wmpb-collapsed" : ""}">
        <div class="wmpb-header">
          <span class="fac-eyebrow">Recently Completed</span>
          <span class="wmpb-spacer"></span>
          ${todayCount > 0
            ? html`<span class="wmpb-count">${todayCount} today</span>`
            : nothing}
          <button
            class="wmpb-toggle"
            title=${this.collapsed ? "Expand" : "Collapse"}
            aria-label=${this.collapsed ? "Expand pin board" : "Collapse pin board"}
            aria-expanded=${!this.collapsed}
            @click=${() => this.setCollapsed(!this.collapsed)}
          >${this.collapsed ? "+" : "−"}</button>
        </div>

        ${this.collapsed
          ? nothing
          : html`
              <div class="wmpb-body">
                ${entries.length === 0
                  ? this.emptyState()
                  : renderRecentlyCompletedCompactList(PIN_LIMIT, (taskId, projectId) =>
                      this.navigate(taskId, projectId),
                    )}
              </div>
            `}
      </div>
    `;
  }

  private emptyState(): TemplateResult {
    return html`
      <div class="wmpb-empty">
        <span class="wmpb-empty-text">No completions yet — get to work, captain.</span>
      </div>
    `;
  }

  // ── Styles ────────────────────────────────────────────────────

  private styles(): TemplateResult {
    return html`<style>
      ${FLOATING_AGENT_CARD_CSS}

      .wmpb-overlay {
        position: absolute;
        right: 14px;
        bottom: 14px;
        width: min(320px, 28vw);
        z-index: 30;
        pointer-events: none; /* root is transparent; cards re-enable below */
        font-family: var(--g-mono-family, 'JetBrains Mono', 'SF Mono', monospace);
      }

      /* Free-floating — no panel box, no chrome. */
      .wmpb-frame {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: min(360px, 40vh);
        background: none;
        border: 0;
      }

      .wmpb-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 4px;
        flex-shrink: 0;
        pointer-events: none;
      }
      .wmpb-count {
        color: var(--gx-gold-lt, rgba(233,196,106,0.9));
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        text-shadow: 0 1px 5px rgba(0,0,0,0.7);
        white-space: nowrap;
      }
      .wmpb-spacer { flex: 1; }
      .wmpb-toggle {
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        flex-shrink: 0;
        background: var(--gx-gold-15, rgba(212,175,55,0.10));
        border: 1px solid var(--gx-gold-30, rgba(212,175,55,0.40));
        border-radius: 4px;
        color: var(--gx-gold-lt, #e9c46a);
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.15s, border-color 0.15s;
      }
      .wmpb-toggle:hover {
        background: var(--gx-gold-30, rgba(212,175,55,0.20));
        border-color: var(--gx-gold-50, rgba(212,175,55,0.70));
      }

      @keyframes wmpb-edge-flash {
        0%   { box-shadow: 0 0 0 0 var(--gx-gold-50, rgba(212,175,55,0.5)); }
        100% { box-shadow: 0 0 0 6px rgba(212,175,55,0); }
      }

      .wmpb-body {
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: var(--gx-gold-30, rgba(212,175,55,0.30)) transparent;
      }
      .wmpb-body::-webkit-scrollbar { width: 4px; }
      .wmpb-body::-webkit-scrollbar-thumb { background: var(--gx-gold-30, rgba(212,175,55,0.30)); border-radius: 2px; }

      /* Re-skin the shared compact rows as free-floating glass cards (matches
         .fac-card: glassmorphism, gold accent, soft glow + idle bob). */
      .wmpb-body .rcf-list--compact { padding: 2px; gap: 9px; display: flex; flex-direction: column; }
      .wmpb-body .rcf-row {
        position: relative;
        background:
          linear-gradient(
            150deg,
            color-mix(in srgb, var(--gx-gold, #d4af37) 7%, rgba(8,6,16,0.62)) 0%,
            rgba(6,4,14,0.58) 100%
          );
        border: 1px solid var(--gx-gold-15, rgba(212,175,55,0.16));
        border-left: 2px solid var(--rcf-status-color, var(--gx-gold, #d4af37));
        border-radius: 12px;
        padding: 8px 10px;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.05),
          0 10px 28px rgba(0,0,0,0.45);
        backdrop-filter: blur(14px) saturate(160%);
        -webkit-backdrop-filter: blur(14px) saturate(160%);
        transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
        animation: fac-card-in 0.4s ease-out both, fac-bob 5.6s ease-in-out infinite;
        will-change: transform;
      }
      .wmpb-body .rcf-row:nth-child(2n) { animation-duration: 0.4s, 6.3s; animation-delay: 0s, -1.5s; }
      .wmpb-body .rcf-row:nth-child(3n) { animation-duration: 0.4s, 5.1s; animation-delay: 0s, -2.7s; }
      .wmpb-body .rcf-row:hover {
        border-color: var(--gx-gold-50, rgba(212,175,55,0.55));
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.08),
          0 12px 34px rgba(0,0,0,0.55),
          0 0 22px var(--gx-gold-30, rgba(212,175,55,0.30));
      }
      .wmpb-body .rcf-row--new { animation: fac-card-in 0.4s ease-out, wmpb-edge-flash 0.6s ease-out, fac-bob 5.6s ease-in-out infinite 0.6s; }

      @media (prefers-reduced-motion: reduce) {
        .wmpb-body .rcf-row { animation: fac-card-in 0.4s ease-out both; }
        .wmpb-body .rcf-row--new { animation: fac-card-in 0.4s ease-out; }
      }

      .wmpb-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        margin: 12px;
        padding: 22px 14px;
        border: 1px dashed var(--gx-gold-30, rgba(212,175,55,0.4));
        border-radius: 6px;
      }
      .wmpb-empty-text {
        color: var(--gx-muted, #71717a);
        font-size: 10.5px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        line-height: 1.5;
      }

      @media (prefers-reduced-motion: reduce) {
        .wmpb-body .rcf-row--new { animation: none !important; }
        .wmpb-body .rcf-row:hover { transform: none; }
      }
    </style>`;
  }
}
