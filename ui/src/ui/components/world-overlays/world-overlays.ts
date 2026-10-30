/**
 * <world-overlays> — game-functional overlay band that stacks on top of the
 * Agency World map without ever touching the viz. Three layers:
 *
 *   1. Mission overlay  — gold rings/labels on critical-path agents + sectors.
 *   2. Heatmap          — credit-burn / activity / failure-rate colored field.
 *   3. Achievements     — earned-badge popups (top-right) + <achievements-modal>.
 *
 * ── DATA CONTRACT (identical box-space to <agent-fx-layer>) ─────────────────
 * Reads agent screen positions from `window.__agentFxState` (FxAgent[]). Mission
 * + heatmap data come via public methods OR window fallbacks
 * (`window.__worldMission`, `window.__worldHeatmap`).
 *
 * ── MOUNT ───────────────────────────────────────────────────────────────────
 *   <agency-world-viz></agency-world-viz>
 *   <agent-fx-layer></agent-fx-layer>
 *   <world-overlays></world-overlays>   ← sibling, last (highest z within band)
 *
 * ── PUBLIC API ───────────────────────────────────────────────────────────────
 *   setMissionEnabled(on, projectId?)   setMissionData(data)
 *   setHeatmapMode(mode | null)         setHeatmapWeights(weights)
 *   pushAchievement(ach)                setAchievements(list)   openAchievements()
 */

import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { MissionRenderer } from "./mission-overlay.js";
import { HeatmapRenderer } from "./heatmap-layer.js";
import { createBadgePopup, AchievementsModal } from "./achievements.js";
import "./achievements.js";
import type {
  HeatmapMode,
  HeatmapWeights,
  MissionData,
  OverlayAgent,
  UiAchievement,
} from "./types.js";

const HEATMAP_MODES: Array<{ mode: HeatmapMode; label: string; icon: string }> = [
  { mode: "credit_burn", label: "Burn", icon: "💰" },
  { mode: "activity_density", label: "Activity", icon: "⚡" },
  { mode: "failure_rate", label: "Failures", icon: "⚠️" },
];

@customElement("world-overlays")
export class WorldOverlays extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 3; /* above <agent-fx-layer> (z=2), below interactive HUD chrome */
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .picker {
      position: absolute;
      left: 14px;
      bottom: 14px;
      display: flex;
      gap: 4px;
      padding: 4px;
      border-radius: 12px;
      background: rgba(10, 12, 20, 0.72);
      border: 1px solid rgba(212, 175, 55, 0.28);
      backdrop-filter: blur(8px);
      pointer-events: auto;
      font: 11px/1 ui-sans-serif, system-ui, sans-serif;
    }
    .picker button {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 6px 9px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: transparent;
      color: #c9cfdd;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .picker button:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .picker button.active {
      color: #1a1205;
      background: linear-gradient(135deg, #e7c64b, #d4af37);
      border-color: rgba(255, 255, 255, 0.25);
    }
    .picker .sep {
      width: 1px;
      align-self: stretch;
      background: rgba(255, 255, 255, 0.1);
      margin: 2px 2px;
    }
    .trophy {
      position: absolute;
      right: 14px;
      bottom: 14px;
      width: 38px;
      height: 38px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      font-size: 18px;
      background: rgba(10, 12, 20, 0.72);
      border: 1px solid rgba(212, 175, 55, 0.28);
      backdrop-filter: blur(8px);
      pointer-events: auto;
      cursor: pointer;
    }
    .trophy:hover {
      border-color: rgba(212, 175, 55, 0.6);
    }
  `;

  @state() private heatmapMode: HeatmapMode | null = null;
  @state() private missionEnabled = false;

  private missionData: MissionData | null = null;
  private heatmapWeights: HeatmapWeights = {};

  private mission = new MissionRenderer();
  private heatmap = new HeatmapRenderer();

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D | null;
  private raf = 0;
  /** Set by the host map while another view of the world is on screen. */
  paused = false;
  private dpr = 1;
  private ro?: ResizeObserver;

  // Light-DOM hosts for fixed-position chrome (avoids transformed-ancestor rebasing).
  private popupHost?: HTMLDivElement;
  private modal?: AchievementsModal;

  render() {
    return html`
      <canvas></canvas>
      <div class="picker" role="group" aria-label="Heatmap mode">
        <button
          class=${this.heatmapMode === null ? "active" : ""}
          @click=${() => this.setHeatmapMode(null)}
          title="Heatmap off"
        >
          ◯ Off
        </button>
        <span class="sep"></span>
        ${HEATMAP_MODES.map(
          (m) => html`
            <button
              class=${this.heatmapMode === m.mode ? "active" : ""}
              @click=${() => this.setHeatmapMode(m.mode)}
              title=${m.label}
            >
              ${m.icon} ${m.label}
            </button>
          `,
        )}
      </div>
      <div class="trophy" title="Achievements" @click=${() => this.openAchievements()}>🏆</div>
    `;
  }

  firstUpdated(): void {
    this.canvas = this.renderRoot.querySelector("canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d");

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this);
    this.resize();

    // Fixed-position popup host + modal in light DOM.
    this.popupHost = document.createElement("div");
    this.popupHost.style.cssText =
      "position:fixed;top:14px;right:14px;z-index:65;display:flex;flex-direction:column;gap:10px;pointer-events:none";
    document.body.appendChild(this.popupHost);

    this.modal = document.createElement("achievements-modal") as AchievementsModal;
    document.body.appendChild(this.modal);
    if (this.pendingAchievements) this.modal.setAchievements(this.pendingAchievements);

    this.loop();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.popupHost?.remove();
    this.modal?.remove();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Enable/disable the mission overlay; optionally scope to a project. */
  setMissionEnabled(on: boolean, projectId?: string): void {
    this.missionEnabled = on;
    if (projectId && this.missionData) this.missionData = { ...this.missionData, projectId };
  }

  setMissionData(data: MissionData): void {
    this.missionData = data;
  }

  setHeatmapMode(mode: HeatmapMode | null): void {
    this.heatmapMode = mode;
  }

  setHeatmapWeights(weights: HeatmapWeights): void {
    this.heatmapWeights = weights;
  }

  private pendingAchievements?: UiAchievement[];

  /** Feed the modal's earned list. */
  setAchievements(list: UiAchievement[]): void {
    this.pendingAchievements = list;
    this.modal?.setAchievements(list);
  }

  /** Pop a top-right badge toast for a freshly unlocked achievement. */
  pushAchievement(ach: UiAchievement): void {
    if (!this.popupHost) return;
    const node = createBadgePopup(ach, () => this.openAchievements());
    this.popupHost.appendChild(node);
  }

  openAchievements(): void {
    this.modal?.open();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private resize(): void {
    if (!this.canvas || !this.ctx) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.clientWidth || 1;
    const h = this.clientHeight || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private agents(): OverlayAgent[] {
    return (window.__agentFxState as OverlayAgent[] | undefined) ?? [];
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused) return;
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    const now = performance.now() / 1000;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    ctx.clearRect(0, 0, w, h);

    const agents = this.agents();

    // Heatmap floor first (under mission rings).
    const mode = this.heatmapMode;
    const weights = Object.keys(this.heatmapWeights).length
      ? this.heatmapWeights
      : window.__worldHeatmap ?? {};
    this.heatmap.draw(ctx, agents, mode, weights, now, w, h);

    // Mission rings on top.
    if (this.missionEnabled) {
      const data = this.missionData ?? window.__worldMission ?? null;
      this.mission.draw(ctx, agents, data, now);
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "world-overlays": WorldOverlays;
  }
}
