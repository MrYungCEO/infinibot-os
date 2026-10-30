/**
 * World-Map Active Agent Breakdown Overlay
 * ────────────────────────────────────────
 * A futuristic HUD panel pinned to the TOP-LEFT of the agent world map
 * (counterpart to the bottom-right `WorldMapPinboard`). Surfaces live agent
 * counts grouped by CLI backend, with each backend's logo prominent.
 *
 * Like the pin board it renders OUTSIDE the main Lit app tree — straight into
 * a DOM node appended to the map's host container, beside the Pixi canvas —
 * and is fed live agent data via `update()` from whoever owns the engine
 * (currently `agency-world-viz`).
 */

import { html, render, type TemplateResult } from "lit";
import {
  resolveAgentSpriteSlot,
  type MeshAgent,
} from "./activity-map";
import {
  FLOATING_AGENT_CARD_CSS,
  ZoomFadeController,
} from "../../components/floating-agent-card";

type Slot = ReturnType<typeof resolveAgentSpriteSlot>;

/** Max per-agent cards shown before truncating with a +N footer. */
const MAX_AGENT_CARDS = 6;

const COLLAPSED_KEY = "infinibot.worldmap.activeAgents.collapsed";

/** Persisted collapse state; defaults to collapsed on phone-width viewports. */
function readCollapsed(): boolean {
  try {
    const v = localStorage.getItem(COLLAPSED_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* storage blocked */
  }
  return typeof window !== "undefined" && window.innerWidth < 540;
}

type StatusBucket = "working" | "idle" | "blocked" | "completed";

/** Bucket a free-form agent status string into our four display buckets. */
function bucketStatus(status: string | undefined): StatusBucket {
  const s = (status || "").toLowerCase();
  if (s === "completed" || s === "complete" || s === "done") return "completed";
  if (s === "blocked" || s === "waiting" || s === "error" || s === "failed") return "blocked";
  if (s === "working" || s === "active" || s === "running" || s === "busy") return "working";
  return "idle";
}

const STATUS_LABEL: Record<StatusBucket, string> = {
  working: "WORKING",
  idle: "IDLE",
  blocked: "BLOCKED",
  completed: "DONE",
};

/** Sort key — working agents float to the top, blocked next, idle last. */
const STATUS_ORDER: Record<StatusBucket, number> = {
  working: 0,
  blocked: 1,
  idle: 2,
  completed: 3,
};

interface ActiveAgentCard {
  agentId: string;
  label: string;
  task: string;
  slot: Slot;
  bucket: StatusBucket;
  progress: number;
}

export class WorldMapActiveBreakdown {
  private readonly el: HTMLDivElement;
  private destroyed = false;
  private cards: ActiveAgentCard[] = [];
  private hiddenCount = 0;
  private total = 0;
  private readonly zoomFade: ZoomFadeController;
  private collapsed = false;

  /**
   * @param docked render in-flow inside the host's HUD column (toolbar → stats
   *   → this list) instead of absolutely pinned to the map's top-left corner,
   *   so it can never sit on top of the toolbar. The body scrolls and the
   *   header collapses it.
   */
  constructor(host: HTMLElement, opts: { docked?: boolean } = {}) {
    this.el = document.createElement("div");
    this.el.className = `wmab-overlay fac-floating-root${opts.docked ? " wmab-overlay--docked" : ""}`;
    this.el.setAttribute("aria-label", "Active agent breakdown");
    this.collapsed = readCollapsed();
    host.appendChild(this.el);
    this.render();
    // Fade the free-floating cards out when the map is zoomed in past the
    // threshold so they stop fighting the canvas (hysteresis avoids flicker).
    this.zoomFade = new ZoomFadeController(this.el, {
      fadeOutAbove: 1.3,
      fadeInBelow: 1.15,
    });
    this.zoomFade.start();
  }

  destroy(): void {
    this.destroyed = true;
    this.zoomFade?.stop();
    this.el.remove();
  }

  /** Project the live agent set into sortable per-agent cards and re-render. */
  update(agents: Iterable<MeshAgent>): void {
    if (this.destroyed) return;
    const all: ActiveAgentCard[] = [];
    let total = 0;
    for (const agent of agents) {
      const bucket = bucketStatus(agent.status);
      if (bucket === "completed") continue;
      total += 1;
      all.push({
        agentId: agent.agentId,
        label: agent.label || agent.agentId,
        task: agent.currentTask?.trim() || "",
        slot: resolveAgentSpriteSlot(agent),
        bucket,
        // subagents.list reports 0–100; older producers send 0–1.
        progress: Math.max(0, Math.min(1, (agent.progress ?? 0) > 1 ? (agent.progress ?? 0) / 100 : agent.progress ?? 0)),
      });
    }
    all.sort((a, b) => {
      const so = STATUS_ORDER[a.bucket] - STATUS_ORDER[b.bucket];
      if (so !== 0) return so;
      return b.progress - a.progress;
    });
    this.total = total;
    this.cards = all.slice(0, MAX_AGENT_CARDS);
    this.hiddenCount = Math.max(0, all.length - this.cards.length);
    this.render();
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    try {
      localStorage.setItem(COLLAPSED_KEY, this.collapsed ? "1" : "0");
    } catch {
      /* storage blocked — session-only */
    }
    this.render();
  }

  private render(): void {
    if (this.destroyed) return;
    render(this.template(), this.el);
  }

  private template(): TemplateResult {
    return html`
      ${this.styles()}
      <div class="wmab-frame">
        <button
          class="wmab-header"
          type="button"
          aria-expanded=${String(!this.collapsed)}
          title=${this.collapsed ? "Show active agents" : "Collapse active agents"}
          @click=${() => this.toggleCollapsed()}
        >
          <span class="fac-eyebrow">Active Agents</span>
          <span class="wmab-spacer"></span>
          <span class="wmab-total">${this.total}</span>
          <span class="wmab-chevron" aria-hidden="true">${this.collapsed ? "▸" : "▾"}</span>
        </button>

        ${this.collapsed
          ? null
          : html`<div class="wmab-body">
              ${this.cards.length === 0
                ? this.emptyState()
                : this.cards.map((c) => this.row(c))}
              ${this.hiddenCount > 0
                ? html`<div class="wmab-more">+${this.hiddenCount} more</div>`
                : null}
            </div>`}
      </div>
    `;
  }

  private row(card: ActiveAgentCard): TemplateResult {
    const pct = Math.round(card.progress * 100);
    const showBar = card.bucket === "working" && card.progress > 0;
    return html`
      <div
        class="fac-card wmab-row wmab-row--${card.bucket} ${card.bucket === "working" ? "fac-card--active" : ""}"
        title=${card.task || card.label}
      >
        <img
          class="wmab-logo"
          src="/agent-sprites/${card.slot}.png"
          alt=${card.slot}
          draggable="false"
        />
        <div class="wmab-meta">
          <span class="wmab-name">${card.label}</span>
          <span class="wmab-task">${card.task || "—"}</span>
          ${showBar
            ? html`<div class="wmab-bar"><span style="width:${pct}%"></span></div>`
            : null}
        </div>
        <span class="wmab-status-pill wmab-status-pill--${card.bucket}">
          ${STATUS_LABEL[card.bucket]}
        </span>
      </div>
    `;
  }

  private emptyState(): TemplateResult {
    return html`
      <div class="wmab-empty">
        <span class="wmab-empty-text">No active agents · awaiting orders</span>
      </div>
    `;
  }

  private styles(): TemplateResult {
    return html`<style>
      ${FLOATING_AGENT_CARD_CSS}

      @keyframes wmab-logo-pulse {
        0%   { transform: scale(1); }
        50%  { transform: scale(1.04); }
        100% { transform: scale(1); }
      }

      .wmab-overlay {
        position: absolute;
        top: 14px;
        left: 14px;
        width: min(320px, 26vw);
        z-index: 30;
        pointer-events: none; /* root is transparent; cards re-enable below */
        font-family: var(--g-mono-family, 'JetBrains Mono', 'SF Mono', monospace);
      }

      /* Free-floating — no panel box, no chrome. */
      .wmab-frame {
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: none;
        border: 0;
      }

      .wmab-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 4px;
        flex-shrink: 0;
        pointer-events: auto;
        cursor: pointer;
        background: none;
        border: 0;
        color: inherit;
        font: inherit;
        text-align: left;
        width: 100%;
      }
      .wmab-chevron {
        color: var(--gx-gold-lt, #e9c46a);
        font-size: 11px;
        width: 10px;
        opacity: 0.8;
      }

      /* Docked inside the host HUD column: in-flow, full column width, and the
         card list scrolls within whatever height the column leaves. */
      .wmab-overlay.wmab-overlay--docked {
        position: relative;
        top: auto;
        left: auto;
        width: 100%;
        min-height: 0;
        display: flex;
        flex-direction: column;
        z-index: auto;
      }
      .wmab-overlay--docked .wmab-frame {
        min-height: 0;
        flex: 1 1 auto;
      }
      .wmab-overlay--docked .wmab-body {
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        pointer-events: auto;
        padding-right: 2px;
      }
      .wmab-spacer { flex: 1; }
      .wmab-total {
        color: var(--gx-gold-lt, #e9c46a);
        font-size: 16px;
        font-weight: 700;
        line-height: 1;
        min-width: 16px;
        text-align: right;
      }

      .wmab-body {
        display: flex;
        flex-direction: column;
        gap: 9px;
      }

      /* Cards re-enable pointer events (the floating root is transparent). */
      .wmab-row {
        pointer-events: auto;
        display: grid;
        grid-template-columns: 30px 1fr auto;
        align-items: center;
        column-gap: 10px;
        padding: 8px 10px;
        min-width: 0;
      }
      /* Status left accents (the gold "active" accent comes from .fac-card--active). */
      .wmab-row--blocked { border-left: 2px solid #ef4444; }
      .wmab-row--idle    { border-left: 2px solid var(--gx-muted, rgba(113,113,122,0.6)); }
      /* Hover expands the truncated task to its full text. */
      .wmab-row:hover .wmab-task { white-space: normal; overflow: visible; opacity: 1; }

      .wmab-logo {
        width: 28px;
        height: 28px;
        flex-shrink: 0;
        object-fit: contain;
        image-rendering: pixelated;
        transform-origin: center;
        animation: wmab-logo-pulse 2s ease-in-out infinite;
        filter: drop-shadow(0 0 4px var(--gx-gold-30, rgba(212,175,55,0.35)));
      }
      .wmab-row--idle .wmab-logo,
      .wmab-row--blocked .wmab-logo { animation: none; opacity: 0.85; }

      .wmab-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .wmab-name {
        color: var(--gx-gold-lt, #e9c46a);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 10.5px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .wmab-task {
        color: var(--gx-text, #e4e4e7);
        font-size: 10.5px;
        line-height: 1.3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        opacity: 0.85;
      }
      .wmab-bar {
        height: 3px;
        margin-top: 4px;
        border-radius: 2px;
        background: var(--gx-gold-15, rgba(212,175,55,0.12));
        overflow: hidden;
      }
      .wmab-bar > span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, var(--gx-gold, #d4af37), var(--gx-accent2, #a855f7));
        transition: width 0.25s ease;
      }

      .wmab-status-pill {
        font-size: 8.5px;
        letter-spacing: 0.14em;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 999px;
        text-transform: uppercase;
        white-space: nowrap;
        align-self: center;
        border: 1px solid currentColor;
      }
      .wmab-status-pill--working {
        color: var(--gx-gold-lt, #e9c46a);
        background: var(--gx-gold-15, rgba(233,196,106,0.12));
      }
      .wmab-status-pill--idle {
        color: var(--gx-muted, #9ca3af);
        background: rgba(148,163,184,0.08);
      }
      .wmab-status-pill--blocked {
        color: #fca5a5;
        background: rgba(239,68,68,0.12);
        border-color: rgba(239,68,68,0.5);
      }
      .wmab-status-pill--completed {
        color: #86efac;
        background: rgba(34,197,94,0.12);
        border-color: rgba(34,197,94,0.5);
      }

      .wmab-more {
        text-align: center;
        font-size: 9.5px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--gx-muted, #71717a);
        padding: 4px 0 2px;
      }

      .wmab-empty {
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        margin: 4px;
        padding: 18px 12px;
        border: 1px dashed var(--gx-gold-30, rgba(212,175,55,0.4));
        border-radius: 6px;
      }
      .wmab-empty-text {
        color: var(--gx-muted, #71717a);
        font-size: 10.5px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        line-height: 1.5;
      }

      @media (prefers-reduced-motion: reduce) {
        .wmab-logo { animation: none !important; }
      }
    </style>`;
  }
}
