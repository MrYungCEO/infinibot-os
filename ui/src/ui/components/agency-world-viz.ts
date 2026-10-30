/**
 * Agency World Viz — Lit element wrapper for the 2D animated agency world.
 *
 * Mounts the PixiJS-based AgencyWorld engine, polls the gateway for the
 * federation/sessions/subagents triple, and feeds the engine a normalized
 * {nodes, agents} stream so its characters walk between work zones live.
 *
 * Drop into any view as <agency-world-viz .client=${gatewayClient}>.
 */

import { LitElement, html, css, render as litRender } from "lit";
import { icons } from "../icons";
import { customElement, property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import { ActivityMap, type MeshAgent, type MeshNode } from "../views/agent-ops/activity-map";
import { AgencyDataBridge, type WorldEvent } from "../controllers/agency-data-bridge";
import { getMeshState } from "../controllers/agent-mesh";
import { WorldMapPinboard } from "../views/agent-ops/world-map-pinboard";
import { openSubagentDetailModal } from "./subagent-detail-modal";
import { WorldMapActiveBreakdown } from "../views/agent-ops/world-map-active-breakdown";
import { HudStatsTracker, formatHudNumber } from "../views/agent-ops/hud-metrics";
import { WorldMapCoderBuilds } from "../views/agent-ops/world-map-coder-builds";
import { BroadcastDirector, type BroadcastEvent, type FocusInfo } from "../views/agent-ops/broadcast-director";
import { CameraDirector, type CameraEvent } from "../views/agent-ops/iso/camera-director";
import { accentCss } from "../views/agent-ops/iso/district-accents";
import { runLayoutTick, noteAgentActivity, noteAgentCompletion } from "../views/agent-ops/iso/layout-engine";
import { managedInterval, rafLoop, type SchedulerHandle } from "../perf/visibility-scheduler";
// ── Mesh upgrade: world FX layers (self-mounting custom elements that read
// window.__agentFxState / __agentFxZoom / __worldHeatmap / __worldMission,
// already published every frame by ActivityMap.publishFxState). Imported for
// their side-effect customElements.define; instantiated in mountWorldLayers(). ──
import "./holographic-overlay";
import "./agent-fx-layer";
import "./agent-emotes-layer";
import "./world-atmosphere";
import "./world-audio";
import "./world-overlays/world-overlays";
import "./world-interactions/index";
import "./queue-holding-zone";
import { startWorldFeeds, type WorldFeeds } from "../controllers/world-feeds";
import { onMilestone } from "../controllers/agent-biographies";
import { providerLogoFor, providerLogoUrl } from "../views/agent-ops/provider-logos";
import { PLUGIN_HOST_EVENT, isTabAvailable, pluginListSnapshot, syncPluginHost } from "../plugin-host";
import { inferBasePathFromPathname, pathForTab, type Tab } from "../navigation";
import { roomSpecsFromPluginList, type PluginRoomSpec } from "../views/agent-ops/iso/plugin-rooms";
import { buildPluginActivityIndex } from "../views/agent-ops/iso/plugin-activity";
import { buildAgentHoverCardModel, placeAgentHoverCard } from "../views/agent-ops/agent-hover-card";
import { buildHoverExtras } from "../views/agent-ops/agent-hover-extras";
import {
  OWNER_DECISION_EVENTS,
  decisionsForAgent,
  loadOwnerDecisions,
  resolveOwnerDecision,
  type OwnerDecision,
} from "../controllers/owner-decisions";
import { settleResumedOwnerDecisionAgent } from "./agency-world-viz-owner-decision-state";
import { sendAgentMessage, stopAgent } from "../views/agent-ops/mesh-agent-actions";
import { MeshWorldModel } from "../views/agent-ops/mesh-world-model";

/** Structural view of views/agent-ops/review-mesh-mount.ts ReviewMeshHandle (lazy-loaded). */
interface ReviewMeshHandleLike {
  setClient(c: unknown): void;
  destroy(): void;
  openThread(runId: string): void;
  openScreenshots(runId: string): void;
  feed: import("../lib/review-mesh/feed").ReviewFeed;
}

@customElement("agency-world-viz")
export class AgencyWorldViz extends LitElement {
  @property({ type: Object }) client: GatewayBrowserClient | null = null;
  @property({ type: Array }) sessions: any[] = [];
  @property({ type: Boolean }) demo = false;
  /** Suppress the recently-completed pinboard + active-agents breakdown HUD overlays
   * (dashboard band uses the bare world map; agent-ops keeps the overlays). */
  @property({ type: Boolean, attribute: "no-overlays" }) noOverlays = false;
  /** Mount the visible-review layer (Auditor on the Executive Suite, review
   *  packets, screenshot orbit + panels). Only the /mesh page sets this. */
  @property({ type: Boolean, attribute: "review-layer" }) reviewLayer = false;
  private reviewMesh: ReviewMeshHandleLike | null = null;
  private reviewMeshLoading = false;

  private engine: ActivityMap | null = null;
  private host: HTMLDivElement | null = null;
  // HUD overlays that render as DOM siblings of the Pixi canvas inside .host.
  private pinboard: WorldMapPinboard | null = null;
  /** HUD column footprint in host px (see layoutRightStack). */
  private chromeRects: Array<{ x: number; y: number; width: number; height: number }> = [];
  private breakdown: WorldMapActiveBreakdown | null = null;
  // Top-left HUD column: toolbar row → live stats → Active Agents list. One
  // in-flow stack so none of them can overlap at any width.
  private hudEl: HTMLDivElement | null = null;
  private hudToolbar: HTMLDivElement | null = null;
  private hudStatsEl: HTMLDivElement | null = null;
  /** Compact-HUD (phone / coarse pointer) toggle that hides the stats, the
   *  Holding Zone and the Active Agents list behind one button. */
  private hudDetailsToggle: HTMLButtonElement | null = null;
  private static readonly HUD_DETAILS_KEY = "infinibot.mesh.hudDetails.collapsed";
  private static readonly COMPACT_HUD_MQ = "(max-width: 640px), (pointer: coarse)";
  private hudStatsTimer: SchedulerHandle | null = null;
  private hudResizeObs: ResizeObserver | null = null;
  private readonly hudStats = new HudStatsTracker();
  // Running coder sub-agents drawn as build agents (ring + build tag). Mounted
  // on every surface — builds are core map state, not optional HUD chrome.
  private builds: WorldMapCoderBuilds | null = null;
  private forgetTimers: Map<string, ReturnType<typeof setTimeout>> | null = null;
  // Mesh upgrade FX layers (DOM siblings of the canvas, z-layered above it).
  private worldLayers: HTMLElement[] = [];
  private worldFeeds: WorldFeeds | null = null;
  private resizeObs: ResizeObserver | null = null;
  private themeObs: MutationObserver | null = null;
  private themeTimer: ReturnType<typeof setTimeout> | null = null;
  private fitTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  private bridge: AgencyDataBridge | null = null;
  private unsub: (() => void) | null = null;
  /** Plugin District: periodic plugins.list re-sync + host-event listener. */
  private pluginSyncTimer: SchedulerHandle | null = null;
  private pluginRoomsListening = false;
  private demoStop: (() => void) | null = null;

  // Local mirrors of engine state, kept in sync from batches.
  private agents = new Map<string, MeshAgent>();
  /** Shared world model (same batches + plugin list as the engine) — the 3D
   *  world renders from it, so 2D and 3D cannot drift. */
  readonly world = new MeshWorldModel();
  /** True while another view (the 3D world) is showing: the Pixi engine and
   *  FX loop pause, but batches keep flowing so toggling back is instant. */
  private suspended = false;
  private nodes = new Map<string, MeshNode>();

  // Connection watcher for lightning / reconnect chime.
  private connTimer: SchedulerHandle | null = null;
  private wasConnected = false;
  private mountError: Error | null = null;
  private reconnecting = false;
  /** HH:MM:SS being shown while time-scrubbing, or null when live. Drives the
   *  "▶ REPLAY @ …" badge top-right of the viz. */
  private replayClock: string | null = null;

  // ── Phase 1 holographic revamp: broadcast camera + zoom + highlights ──
  private static readonly BROADCAST_KEY = "infinibot-world-broadcast";
  private director: BroadcastDirector | null = null;
  private cameraDirector: CameraDirector | null = null;
  private bxLayer: HTMLDivElement | null = null;
  private bxFx: SVGSVGElement | null = null;
  private bxCaption: HTMLDivElement | null = null;
  private bxBroadcastBtn: HTMLButtonElement | null = null;
  private spreadUnsub: (() => void) | null = null;
  private bxTooltip: HTMLDivElement | null = null;
  private bxFollowBtn: HTMLButtonElement | null = null;
  private bxTooltipPinned = false;
  private bxTooltipAnchor: { x: number; y: number } | null = null;
  private bxCanvas: HTMLCanvasElement | null = null;
  private fxLoop: SchedulerHandle | null = null;
  // Last viewport zoom we broadcast on `infinibot:world-zoom`. Consumers (e.g.
  // the voice HUD blob) listen for this to react to mesh zoom. We only emit on
  // a meaningful change (epsilon) so the FX loop doesn't spam the event bus.
  private lastEmittedZoom = -1;
  private followLock: string | null = null;
  private followFlyAt = 0;
  private hoveredKey: string | null = null;
  private lastStatusByKey = new Map<string, string>();
  // Transient idle→active / tool pulses: {key, born, ttl, color}.
  private pulses: { key: string; born: number; ttl: number; color: string }[] = [];
  private fxCostEwma = 0; // rolling per-frame cost (ms) for the perf budget.
  private mobileLike = false;
  private fxPausedUntil = 0; // CameraDirector yields while performance.now() < this

  // ── Cross-device camera mirror (web → mobile) ──
  // When this (full-surface) viz's camera settles — from a manual pan/zoom OR
  // the auto-focus/auto-fit directors — publish a tiny {zoom,centerX,centerY}
  // beat on the gateway `world.camera` topic. Mobile subscribes and mirrors it.
  private cameraPublishUnsub: (() => void) | null = null;
  private cameraPublishTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPublishedCam: { zoom: number; centerX: number; centerY: number } | null = null;
  // Stable per-tab id so a publisher never reacts to its own echo.
  private readonly cameraPublisherId = `web-${Math.random().toString(36).slice(2, 10)}`;

  // ── Review / oversight integration ──
  private reviewCache = new Map<string, any>();
  private reviewPollTimer: SchedulerHandle | null = null;
  private ctxMenu: HTMLDivElement | null = null;
  private ctxMenuTarget: string | null = null;
  private panelVisibilityObserver: IntersectionObserver | null = null;
  private panelVisible = true;

  // ── Owner decision queue ───────────────────────────────────────────────
  private ownerDecisions: OwnerDecision[] = [];
  private decisionPollTimer: SchedulerHandle | null = null;
  private decisionEventUnsub: (() => void) | null = null;
  private decisionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private decisionChip: HTMLButtonElement | null = null;
  private decisionList: HTMLDivElement | null = null;
  private activeDecisionId: string | null = null;
  private decisionBusyId: string | null = null;
  private decisionError: string | null = null;
  private resumedAgents = new Map<string, number>();
  private decisionNotice: string | null = null;
  private decisionNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background: #0a0e1a;
      position: relative;
    }
    .host {
      position: absolute;
      inset: 0;
    }
    .replay-badge {
      position: absolute;
      top: 10px;
      right: 12px;
      z-index: 30;
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono, ui-monospace, "SF Mono", monospace);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: #1a1200;
      background: rgba(212, 175, 55, 0.92);
      border: 1px solid #f4e4b8;
      border-radius: 7px;
      padding: 5px 10px;
      cursor: pointer;
      box-shadow: 0 4px 14px -4px rgba(0, 0, 0, 0.7), 0 0 10px rgba(212, 175, 55, 0.4);
      animation: replay-badge-pulse 1.6s ease-in-out infinite;
    }
    .replay-badge:hover {
      background: #f4e4b8;
    }
    @keyframes replay-badge-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    @media (prefers-reduced-motion: reduce) {
      .replay-badge { animation: none; }
    }
    .empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #71717a;
      font-family: "JetBrains Mono", "SF Mono", monospace;
      font-size: 13px;
      pointer-events: none;
    }
    .error-overlay {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      align-content: center;
      color: #71717a;
      font-family: "JetBrains Mono", "SF Mono", monospace;
      font-size: 13px;
      background: #0a0e1a;
      z-index: 10;
      gap: 12px;
    }
    .error-msg {
      text-align: center;
      max-width: 320px;
      color: #ef4444;
    }
    .retry-btn {
      background: #27272a;
      border: 1px solid #3f3f46;
      color: #e4e4e7;
      padding: 6px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-family: "JetBrains Mono", "SF Mono", monospace;
      font-size: 12px;
    }
    .retry-btn:hover {
      background: #3f3f46;
    }

    /* ── Top-left HUD column (toolbar → stats → active agents list) ── */
    .awv-hud {
      position: absolute;
      top: 12px;
      left: 12px;
      z-index: 30;
      width: min(410px, calc(100% - 24px));
      /* Leave the bottom-left filter bar + zoom controls clear. */
      max-height: calc(100% - 88px);
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
      font-family: "JetBrains Mono", "SF Mono", monospace;
    }
    .awv-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 8px;
      flex-shrink: 0;
    }
    .awv-toolbar .bx-btn {
      position: static;
      white-space: nowrap;
    }
    /* Queue atrium lives in the column at every width (overrides its own
       absolute :host placement) — top-right it sat on the EXECUTIVE SUITE
       sign and on agent task pills. */
    .awv-hud > queue-holding-zone {
      position: relative;
      top: auto;
      right: auto;
      flex-shrink: 0;
      pointer-events: auto;
    }
    /* Compact-HUD details toggle: only shown on phones / coarse pointers. */
    .awv-hud-toggle {
      display: none;
      align-items: center;
      gap: 5px;
      color: var(--gx-gold-lt, #e9c46a);
      border-color: rgba(212, 175, 55, 0.5);
      font-weight: 700;
    }
    .awv-hud-toggle .awv-hud-toggle-chev {
      display: inline-block;
      transition: transform 0.16s ease;
    }
    .awv-hud-toggle[aria-expanded="true"] .awv-hud-toggle-chev {
      transform: rotate(180deg);
    }
    .awv-hud-toggle .awv-hud-toggle-count {
      font-size: 11px;
      min-width: 1ch;
    }
    @media (max-width: 640px), (pointer: coarse) {
      .awv-hud {
        /* Full-width backdrop strip: nothing on the map peeks between the pills. */
        top: 0;
        left: 0;
        width: 100%;
        box-sizing: border-box;
        padding: 8px 8px 10px;
        gap: 6px;
        max-height: calc(100% - 112px);
        background: linear-gradient(180deg, rgba(4, 4, 7, 0.95) 0%, rgba(4, 4, 7, 0.9) 78%, rgba(4, 4, 7, 0) 100%);
      }
      /* One compact row: no wrapping; overflow scrolls sideways instead. */
      .awv-toolbar {
        flex-wrap: nowrap;
        width: max-content;
        max-width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        overscroll-behavior-x: contain;
        scrollbar-width: none;
        padding: 1px;
        gap: 6px;
        pointer-events: auto;
      }
      .awv-toolbar::-webkit-scrollbar { display: none; }
      .awv-toolbar > * { flex-shrink: 0; order: 2; }
      .awv-toolbar > .awv-hud-toggle { order: 0; display: inline-flex; }
      /* Page-projected controls (2D/3D toggle) right after the toggle so they
         are never the part scrolled out of view. */
      ::slotted(*) { order: 1; flex-shrink: 0; }
      .awv-toolbar .bx-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 34px;
        min-height: 32px;
        padding: 0 8px;
        font-size: 13px;
      }
      .awv-toolbar .bx-pill-txt { display: none; }
      .awv-toolbar .od-chip { min-height: 32px; padding: 0 9px; }
      .awv-hud--collapsed > .awv-stats,
      .awv-hud--collapsed > queue-holding-zone,
      .awv-hud--collapsed > .wmab-overlay {
        display: none;
      }
      .awv-stat { padding: 4px 8px; }
      .awv-stat-label { font-size: 8px; letter-spacing: 0.1em; }
      .awv-stat-value { font-size: 13px; }
    }
    .awv-stats {
      flex-shrink: 0;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      border-radius: 8px;
      background: rgba(7, 7, 10, 0.66);
      border: 1px solid rgba(212, 175, 55, 0.45);
      border-left: 3px solid var(--gx-gold-lt, #e9c46a);
      backdrop-filter: blur(6px);
      pointer-events: auto;
    }
    .awv-stat {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 10px;
      min-width: 0;
    }
    .awv-stat + .awv-stat {
      border-left: 1px solid rgba(212, 175, 55, 0.18);
    }
    .awv-stat-label {
      color: #9ca3af;
      font-size: 8.5px;
      font-weight: 600;
      letter-spacing: 0.14em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .awv-stat-value {
      color: var(--gx-gold-lt, #e9c46a);
      font-size: 15px;
      font-weight: 700;
      line-height: 1.1;
    }
    @media (max-width: 540px) {
      .awv-toolbar .bx-btn {
        font-size: 11px;
        padding: 5px 8px;
      }
    }

    /* ── Phase 1 holographic revamp: broadcast + zoom + highlight overlay ── */
    .bx-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 5;
      font-family: "JetBrains Mono", "SF Mono", monospace;
    }
    .bx-fx {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    }
    .bx-caption {
      position: absolute;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%) translateY(8px);
      max-width: 80%;
      padding: 7px 16px;
      border-radius: 999px;
      background: rgba(10, 14, 26, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #e4e4e7;
      font-size: 12px;
      letter-spacing: 0.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      backdrop-filter: blur(6px);
      opacity: 0;
      transition: opacity 0.4s ease, transform 0.4s ease;
      pointer-events: none;
    }
    .bx-caption.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .bx-caption .bx-live {
      color: #f87171;
      font-weight: 700;
      margin-right: 8px;
    }
    .bx-btn {
      pointer-events: auto;
      cursor: pointer;
      background: rgba(10, 14, 26, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #d4d4d8;
      font-family: inherit;
      font-size: 12px;
      border-radius: 8px;
      padding: 6px 10px;
      backdrop-filter: blur(6px);
      user-select: none;
    }
    .bx-btn:hover {
      background: rgba(30, 41, 59, 0.85);
      color: #fff;
    }
    .bx-broadcast {
      position: absolute;
      top: 12px;
      left: 12px;
      letter-spacing: 0.06em;
      font-weight: 600;
    }
    .bx-spread {
      position: absolute;
      top: 12px;
      letter-spacing: 0.06em;
      font-weight: 600;
    }
    .bx-spread.on {
      border-color: rgba(212, 175, 55, 0.85);
      color: #f3d98a;
      box-shadow: 0 0 0 1px rgba(212, 175, 55, 0.35), 0 0 16px rgba(212, 175, 55, 0.2);
    }
    .bx-broadcast.on {
      border-color: #f87171;
      color: #fecaca;
      box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.4), 0 0 16px rgba(248, 113, 113, 0.25);
    }
    .bx-tooltip {
      position: absolute;
      box-sizing: border-box;
      width: min(340px, calc(100% - 24px));
      padding: 16px;
      border-radius: 16px;
      background:
        radial-gradient(circle at 12% 0%, rgba(212, 175, 55, 0.17), transparent 42%),
        linear-gradient(145deg, rgba(20, 22, 28, 0.97), rgba(7, 8, 12, 0.96));
      border: 1px solid rgba(232, 200, 104, 0.42);
      box-shadow: 0 22px 58px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.025) inset;
      backdrop-filter: blur(18px) saturate(1.2);
      color: #f4f4f5;
      font-size: 11px;
      line-height: 1.45;
      z-index: 66;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(7px) scale(0.985);
      transform-origin: center left;
      transition: opacity 0.16s ease, transform 0.16s ease, visibility 0s linear 0.16s;
    }
    .bx-tooltip.show {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translateY(0) scale(1);
      transition-delay: 0s;
    }
    .bx-tooltip:focus {
      outline: none;
    }
    .bx-tooltip:focus-visible {
      outline: none;
      border-color: rgba(244, 220, 139, 0.85);
    }
    .bx-tooltip::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      border-radius: 16px 0 0 16px;
      background: var(--tt-accent, #d4af37);
      box-shadow: 0 0 18px var(--tt-accent, #d4af37);
    }
    .bx-tooltip[data-tone="active"] { --tt-accent: #e9c46a; }
    .bx-tooltip[data-tone="waiting"] { --tt-accent: #7dd3fc; }
    .bx-tooltip[data-tone="success"] { --tt-accent: #86efac; }
    .bx-tooltip[data-tone="danger"] { --tt-accent: #fb7185; }
    .bx-tooltip[data-tone="idle"] { --tt-accent: #a1a1aa; }
    .bx-tt-head {
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      margin-bottom: 13px;
    }
    .bx-tt-logo-wrap {
      width: 38px;
      height: 38px;
      display: grid;
      place-items: center;
      border-radius: 11px;
      border: 1px solid rgba(212, 175, 55, 0.28);
      background: rgba(255, 255, 255, 0.045);
    }
    .bx-tooltip .bx-tt-logo {
      width: 22px;
      height: 22px;
      object-fit: contain;
    }
    .bx-tt-identity { min-width: 0; }
    .bx-tooltip .bx-tt-name {
      color: #fff;
      font-size: 13px;
      font-weight: 750;
      line-height: 1.3;
      letter-spacing: -0.01em;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .bx-tt-id {
      margin-top: 2px;
      color: #8b8b94;
      font-size: 9px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bx-tt-status {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--tt-accent);
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .bx-tt-status::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 8px currentColor;
    }
    .bx-tt-close {
      display: none;
      width: 28px;
      height: 28px;
      padding: 0;
      place-items: center;
      border: 0;
      border-radius: 8px;
      background: rgba(255,255,255,.055);
      color: #a1a1aa;
      cursor: pointer;
      font-size: 18px;
    }
    .bx-tooltip.is-pinned .bx-tt-close,
    .bx-tooltip.is-mobile .bx-tt-close { display: grid; }
    .bx-tt-work {
      padding: 11px 12px;
      border-radius: 11px;
      border: 1px solid rgba(255, 255, 255, 0.075);
      background: rgba(255, 255, 255, 0.035);
    }
    .bx-tt-kicker {
      margin-bottom: 5px;
      color: #d7bb67;
      font-size: 8px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .bx-tt-task {
      color: #f4f4f5;
      font-size: 11px;
      font-weight: 650;
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .bx-tt-activity {
      margin-top: 6px;
      font-size: 9.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bx-tt-activity-label { color: #71717a; }
    .bx-tt-activity-value { color: #a1a1aa; }
    .bx-tt-progress-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-top: 10px;
      color: #8b8b94;
      font-size: 9px;
    }
    .bx-tt-progress-value { color: #e9c46a; font-weight: 800; }
    .bx-tt-track {
      height: 3px;
      margin-top: 5px;
      overflow: hidden;
      border-radius: 99px;
      background: rgba(255,255,255,.08);
    }
    .bx-tt-fill {
      height: 100%;
      width: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, #9b7415, #f4dc8b);
      box-shadow: 0 0 10px rgba(233,196,106,.6);
      transition: width .25s ease;
    }
    .bx-tt-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      margin: 11px 0;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 10px;
      background: rgba(255,255,255,.07);
    }
    .bx-tt-metric {
      min-width: 0;
      padding: 8px 9px;
      background: rgba(9,10,14,.93);
    }
    .bx-tt-metric-label {
      color: #71717a;
      font-size: 7.5px;
      letter-spacing: .1em;
      text-transform: uppercase;
    }
    .bx-tt-metric-value {
      margin-top: 2px;
      color: #dedee2;
      font-size: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bx-tt-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px 12px;
      color: #8b8b94;
      font-size: 9px;
    }
    .bx-tt-meta span { color: #c8c8ce; }
    .bx-tt-review {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: 9px;
      border: 1px solid rgba(134,239,172,.17);
      background: rgba(22,101,52,.11);
      color: #a7f3d0;
      font-size: 9px;
      line-height: 1.4;
    }
    .bx-tt-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 12px;
    }
    .bx-tooltip .bx-tt-action {
      min-height: 34px;
      border-radius: 9px;
      font-size: 10px;
      font-weight: 750;
    }
    .bx-tooltip .bx-tt-details {
      border-color: rgba(212,175,55,.55);
      background: linear-gradient(135deg, rgba(212,175,55,.23), rgba(212,175,55,.09));
      color: #f4dc8b;
    }
    .bx-tooltip .bx-follow.on {
      border-color: #fbbf24;
      color: #fde68a;
    }
    .bx-tt-role {
      margin-top: 1px;
      color: #d7bb67;
      font-size: 9.5px;
      font-weight: 650;
      letter-spacing: 0.04em;
    }
    .bx-tt-activity-age {
      color: #71717a;
    }
    .bx-tt-metrics2 {
      margin-top: -4px;
    }
    .bx-tt-latest {
      margin-top: 10px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid rgba(212, 175, 55, 0.18);
      background: rgba(212, 175, 55, 0.05);
    }
    .bx-tt-latest .bx-tt-kicker {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .bx-tt-latest-row {
      display: flex;
      gap: 6px;
      align-items: baseline;
      min-width: 0;
    }
    .bx-tt-latest-kind {
      flex: none;
      font-size: 8.5px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--k, #f5c542);
      border: 1px solid currentColor;
      border-radius: 999px;
      padding: 0 6px;
    }
    .bx-tt-latest-title {
      color: #e4e4e7;
      font-size: 10.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .bx-tt-ico {
      display: inline-grid;
      place-items: center;
    }
    .bx-tt-ico svg {
      width: 12px;
      height: 12px;
    }
    .bx-tooltip .bx-tt-actions {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
    }
    .bx-tooltip .bx-tt-action {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      min-height: 40px;
      padding: 4px 2px;
      font-size: 9.5px;
      font-weight: 650;
    }
    .bx-tooltip .bx-tt-action:disabled {
      opacity: 0.38;
      cursor: not-allowed;
    }
    .bx-tooltip .bx-tt-action:focus-visible,
    .bx-tooltip .bx-tt-close:focus-visible {
      outline: 2px solid #f4dc8b;
      outline-offset: 1px;
    }
    .bx-tooltip .bx-tt-close {
      font-size: 0;
    }
    .bx-tt-compose {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .bx-tt-compose[hidden] {
      display: none;
    }
    .bx-tt-compose-input {
      flex: 1;
      min-width: 0;
      min-height: 32px;
      border-radius: 9px;
      border: 1px solid rgba(212, 175, 55, 0.35);
      background: rgba(255, 255, 255, 0.04);
      color: #f4f4f5;
      font: inherit;
      font-size: 11px;
      padding: 0 10px;
    }
    .bx-tt-note {
      margin-top: 6px;
      font-size: 9.5px;
      color: #86efac;
      min-height: 0;
    }
    .bx-tt-note:empty {
      display: none;
    }
    .bx-tt-note[data-tone="err"] {
      color: #fb7185;
    }
    .bx-tt-hint {
      margin-top: 8px;
      color: #62626b;
      font-size: 8px;
      text-align: center;
    }
    .od-chip {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 30px;
      padding: 5px 10px;
      border: 1px solid rgba(245, 197, 66, 0.58);
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(58, 43, 11, 0.94), rgba(22, 17, 8, 0.94));
      color: #fde68a;
      font: 700 10px/1 var(--font-mono, "JetBrains Mono", monospace);
      letter-spacing: 0.04em;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 0 18px rgba(245, 197, 66, 0.16);
    }
    .od-chip[hidden] { display: none; }
    .od-chip .bx-tt-ico { width: 14px; height: 14px; }
    .od-chip:hover, .od-chip[aria-expanded="true"] {
      border-color: #fde68a;
      background: linear-gradient(180deg, rgba(91, 66, 13, 0.98), rgba(31, 23, 8, 0.98));
    }
    .od-global {
      display: none;
      pointer-events: auto;
      width: min(390px, calc(100vw - 30px));
      max-height: min(58vh, 520px);
      overflow: auto;
      padding: 8px;
      border: 1px solid rgba(245, 197, 66, 0.38);
      border-radius: 14px;
      background: rgba(8, 8, 13, 0.97);
      box-shadow: 0 22px 60px rgba(0, 0, 0, 0.58), 0 0 28px rgba(212, 175, 55, 0.09);
      backdrop-filter: blur(18px);
    }
    .od-global.show { display: grid; gap: 6px; }
    .od-global-row {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr) auto;
      align-items: center;
      gap: 9px;
      width: 100%;
      padding: 9px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.025);
      color: #e8e6e3;
      text-align: left;
      cursor: pointer;
    }
    .od-global-row:hover { border-color: rgba(245, 197, 66, 0.4); background: rgba(245, 197, 66, 0.07); }
    .od-global-icon {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      color: #fde68a;
      background: rgba(245, 197, 66, 0.1);
    }
    .od-global-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 700; }
    .od-global-sub { display: block; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #b6b0a3; font-size: 10px; }
    .od-global-kind { color: #d8c98f; font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
    .bx-tt-decision {
      display: none;
      gap: 8px;
      padding: 10px;
      border: 1px solid rgba(245, 197, 66, 0.34);
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(245, 197, 66, 0.09), rgba(127, 29, 29, 0.08));
    }
    .bx-tt-decision.has-decisions { display: grid; }
    .od-card-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      justify-self: start;
      padding: 5px 8px;
      border: 1px solid rgba(245, 197, 66, 0.5);
      border-radius: 999px;
      background: rgba(245, 197, 66, 0.1);
      color: #fde68a;
      font: 700 10px/1 var(--font-mono, "JetBrains Mono", monospace);
      cursor: pointer;
    }
    .od-card-body[hidden] { display: none; }
    .od-card-body { display: grid; gap: 8px; }
    .od-card-question { color: #f8f5ec; font-size: 12px; font-weight: 700; line-height: 1.5; }
    details.od-context { color: #bbb5a8; font-size: 10.5px; line-height: 1.5; }
    details.od-context summary { color: #c9b978; cursor: pointer; }
    .od-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .od-action {
      min-height: 34px;
      padding: 7px 12px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      color: #e8e6e3;
      font: 700 10px/1 var(--font-mono, "JetBrains Mono", monospace);
      cursor: pointer;
    }
    .od-action.primary { border-color: rgba(245, 197, 66, 0.62); color: #fde68a; background: rgba(245, 197, 66, 0.1); }
    .od-action.danger { border-color: rgba(251, 113, 133, 0.48); color: #fda4af; background: rgba(127, 29, 29, 0.14); }
    .od-action:disabled { opacity: 0.48; cursor: wait; }
    .od-reply { display: flex; gap: 6px; }
    .od-reply input {
      min-width: 0;
      flex: 1;
      border: 1px solid rgba(245, 197, 66, 0.3);
      border-radius: 8px;
      padding: 7px 9px;
      background: rgba(0, 0, 0, 0.28);
      color: #f5f2e9;
      font: 10px/1.35 var(--font-mono, "JetBrains Mono", monospace);
    }
    .od-link {
      justify-self: start;
      padding: 3px 0;
      border: 0;
      background: transparent;
      color: #f2d77f;
      font: 700 10px/1.2 var(--font-mono, "JetBrains Mono", monospace);
      text-decoration: underline;
      cursor: pointer;
    }
    .od-error { color: #fb7185; font-size: 9px; line-height: 1.4; }
    .od-resumed {
      display: none;
      align-items: center;
      gap: 5px;
      color: #86efac;
      font: 700 9px/1 var(--font-mono, "JetBrains Mono", monospace);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .od-resumed.show { display: inline-flex; }
    @media (max-width: 540px), (pointer: coarse) {
      .bx-tooltip.is-mobile {
        position: absolute;
        width: calc(100% - 24px);
        max-height: min(72vh, 520px);
        overflow: auto;
        border-radius: 18px;
        transform-origin: bottom center;
      }
      .bx-tooltip.is-mobile .bx-tt-hint { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .bx-tooltip, .bx-tt-fill { transition: none; }
    }
  `;

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    // Defer engine instantiation until updated() (we need the host div).
    await this.updateComplete;
    this.mountEngine();
    void this.startData();
    if (this.reviewLayer && !this.noOverlays) void this.startOwnerDecisionFeed();
    this.startConnWatch();
    // The scrubber fires this whenever the user scrubs/plays — restart the FX
    // loop so replay keeps driving even if it had idled out (0 live agents).
    window.addEventListener("world-replay-frame", this.handleReplayFrame);
  }

  override updated(changed: Map<string, unknown>): void {
    super.updated?.(changed as never);
    if (changed.has("client")) {
      this.reviewMesh?.setClient(this.client);
      if (this.reviewLayer && !this.noOverlays) void this.startOwnerDecisionFeed();
    }
  }

  private mountReviewMesh(): void {
    if (this.reviewMesh || this.reviewMeshLoading || !this.engine || !this.host) return;
    this.reviewMeshLoading = true;
    const engine = this.engine;
    const host = this.host;
    void import("../views/agent-ops/review-mesh-mount")
      .then(({ mountReviewMesh }) => {
        this.reviewMeshLoading = false;
        if (this.engine !== engine || !this.isConnected) return;
        this.reviewMesh = mountReviewMesh({
          engine,
          host,
          client: this.client as never,
          // Auto-focus director yields while the user is looking at the review.
          holdCamera: (ms: number) => {
            this.fxPausedUntil = Math.max(this.fxPausedUntil, performance.now() + ms);
          },
          onOpenRun: (runId) => {
            if (!this.client) return;
            openSubagentDetailModal({ client: this.client, requestUpdate: () => this.requestUpdate(), runId });
          },
        }) as unknown as ReviewMeshHandleLike;
        // Feed updates refresh an open hover card (verdict / latest review message).
        this.reviewMesh.feed.on(() => {
          if (this.hoveredKey && this.bxTooltipAnchor) this.updateTooltip(this.hoveredKey, this.bxTooltipAnchor.x, this.bxTooltipAnchor.y);
        });
      })
      .catch((err) => {
        this.reviewMeshLoading = false;
        console.warn("[agency-world-viz] review layer failed to mount:", err);
      });
  }

  private readonly handleReplayFrame = (e: Event): void => {
    this.ensureFxLoop();
    // Drive the engine's own replay state machine. The scrubber publishes a
    // typed `world-replay-frame` CustomEvent: { detail: { t, agents } }.
    // When the override is cleared (window.__worldReplayFrame === null) the
    // scrubber is back in Live mode, so we resumeLive(); otherwise we pin
    // the engine to historical time `t` so room sprites + conduits replay.
    const engine = this.engine;
    if (!engine) return;
    const w = window as unknown as { __worldReplayFrame?: { t?: number } | null };
    const override = w.__worldReplayFrame;
    if (override && typeof override.t === "number") {
      engine.setReplayTime(override.t);
      // Drive the "▶ REPLAY @ …" badge from here (not renderFx) so it works on
      // the dashboard band too, where the no-overlays viz has no FX loop.
      const clk = this.fmtReplayClock(override.t);
      if (clk !== this.replayClock) {
        this.replayClock = clk;
        this.requestUpdate();
      }
    } else {
      if (engine.isReplaying()) engine.resumeLive();
      if (this.replayClock !== null) {
        this.replayClock = null;
        this.requestUpdate();
      }
    }
  };

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.teardownBroadcast();
    this.stopOwnerDecisionFeed();
    this.cameraPublishUnsub?.();
    this.cameraPublishUnsub = null;
    if (this.cameraPublishTimer) clearTimeout(this.cameraPublishTimer);
    this.cameraPublishTimer = null;
    this.lastPublishedCam = null;
    this.unsub?.();
    this.unsub = null;
    this.bridge?.destroy();
    this.bridge = null;
    if (this.pluginSyncTimer) {
      this.pluginSyncTimer.cancel();
      this.pluginSyncTimer = null;
    }
    if (this.pluginRoomsListening) {
      window.removeEventListener(PLUGIN_HOST_EVENT, this.handlePluginHostEvent);
      this.pluginRoomsListening = false;
    }
    this.demoStop?.();
    this.demoStop = null;
    if (this.connTimer) {
      this.connTimer.cancel();
      this.connTimer = null;
    }
    if (this.fitTimer) clearTimeout(this.fitTimer);
    this.fitTimer = null;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    if (this.resizeObs) {
      this.resizeObs.disconnect();
      this.resizeObs = null;
    }
    this.panelVisibilityObserver?.disconnect();
    this.panelVisibilityObserver = null;
    if (this.themeObs) {
      this.themeObs.disconnect();
      this.themeObs = null;
    }
    if (this.themeTimer) clearTimeout(this.themeTimer);
    this.themeTimer = null;
    window.removeEventListener("resize", this.handleWindowResize);
    window.removeEventListener("world-replay-frame", this.handleReplayFrame);
    if (this.pinboard) {
      this.pinboard.destroy();
      this.pinboard = null;
    }
    if (this.breakdown) {
      this.breakdown.destroy();
      this.breakdown = null;
    }
    this.builds?.destroy();
    this.builds = null;
    this.forgetTimers?.forEach((t) => clearTimeout(t));
    this.forgetTimers = null;
    this.reviewMesh?.destroy();
    this.reviewMesh = null;
    this.teardownWorldLayers();
    if (this.engine) {
      this.engine.setActive(false);
      this.engine.destroy();
      this.engine = null;
    }
    this.host = null;
    this.agents.clear();
    this.nodes.clear();
    this.world.clear();
    this.reconnecting = false;
    this.mountError = null;
    if (this.reviewPollTimer) {
      this.reviewPollTimer.cancel();
      this.reviewPollTimer = null;
    }
    this.reviewCache.clear();
    this.destroyCtxMenu();
  }

  private mountEngine() {
    if (this.engine) return;
    const host = this.renderRoot?.querySelector(".host") as HTMLDivElement | null;
    if (!host) return;
    this.host = host;
    try {
      this.engine = new ActivityMap(host, {
        worldTheme: "galactic",
        onAgentClick: (agent) => {
          if (this.mobileLike) {
            const pos = this.eng()?.agentScreenPos?.(agent.sessionKey);
            this.showAgentHoverCard(agent.sessionKey, true, pos ?? undefined);
            return;
          }
          // Primary: open the detailed Agent Focus modal mounted by app-render
          // (window.openAgentFocus). The legacy "agency-agent-select" CustomEvent
          // — which opens the bland federation node sidebar — is still
          // dispatched so any external consumer that depends on it keeps
          // working, but the modal is what the user sees.
          const open = (window as unknown as { openAgentFocus?: (t: unknown) => void })
            .openAgentFocus;
          const detail = this.agents.get(agent.sessionKey) ?? agent;
          if (typeof open === "function") {
            open(detail);
          }
          this.dispatchEvent(
            new CustomEvent("agency-agent-select", {
              detail: {
                sessionKey: agent.sessionKey,
                agent: detail,
                review: this.reviewCache.get(agent.sessionKey) ?? null,
              },
              bubbles: true,
              composed: true,
            }),
          );
        },
        onNodeClick: (node) => {
          this.dispatchEvent(
            new CustomEvent("agency-node-select", {
              detail: {
                nodeId: node.id,
                node: this.nodes.get(node.id) ?? node,
              },
              bubbles: true,
              composed: true,
            }),
          );
        },
        onPluginRoomClick: (spec) => this.openPluginRoom(spec),
      });
      this.installPanelVisibilityWatch(host);
      this.installResizeHandling(host);
      this.installThemeWatch();
      // Pull the app's dynamic theme tokens into the Pixi palette immediately.
      (this.engine as any).applyThemeFromCss?.();
      this.scheduleResize(host.clientWidth, host.clientHeight);
      // Auto-fit after some buildings come in
      this.fitTimer = setTimeout(() => this.engine?.zoomToFit(), 900);

      // ── Top-left HUD column (toolbar/stats/list slots) — before the
      // broadcast overlay, which drops its pills into the toolbar row. ──
      this.installHudColumn(host);

      // ── Broadcast camera + zoom + highlight overlay (both surfaces) ──
      this.installBroadcastOverlay(host);
      // Host pages can project their own controls into the toolbar row
      // (<x slot="hud-toolbar">) — after the built-in pills.
      if (this.hudToolbar) {
        const slot = document.createElement("slot");
        slot.name = "hud-toolbar";
        this.hudToolbar.appendChild(slot);
      }

      // ── Cross-device camera mirror: publish this surface's camera so the
      // mobile app can follow along. Only the full surface publishes (the
      // dashboard band is a passive embed) to avoid two publishers fighting. ──
      if (!this.noOverlays) this.installCameraPublish();

      // ── Mesh upgrade FX layers (holographic shader, particle trails, emotes,
      // day/night atmosphere — and, on the full surface, heatmap/mission/sound).
      // They read the per-frame window.__agentFxState the engine publishes. ──
      this.mountWorldLayers(host);

      // ── Coder build layer: anchors to each coder sub-agent sprite. ──
      {
        const eng = this.engine;
        this.builds = new WorldMapCoderBuilds(
          host,
          (key) => eng.agentScreenPos(key),
          // Keep build tags off the floor / room signs and out from under the HUD column.
          () => [
            ...[...((eng as any).signScreenRects?.() ?? []), ...((eng as any).agentChipScreenRects?.() ?? [])].map((r: { x: number; y: number; width: number; height: number }) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
            ...this.chromeRects.map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })),
          ],
        );
        for (const a of this.agents.values()) this.builds.upsert(a);
      }

      // ── Visible review: Auditor + packets + screenshot orbit (/mesh only). ──
      if (this.reviewLayer && !this.noOverlays) {
        this.mountReviewMesh();
        this.installHoverHook();
      }

      // ── HUD overlays (DOM siblings of the canvas inside .host) ──
      // host is position:absolute inset:0, so absolute children anchor to it.
      const engine = this.engine;
      if (this.noOverlays) {
        return;
      }
      // /mesh with the review layer: its "Recently completed" rail replaces the
      // kanban pin board in the same corner (one completed list, not two).
      if (!this.reviewLayer) this.pinboard = new WorldMapPinboard(host, {
        client: this.client,
        requestUpdate: () => this.requestUpdate(),
        onReservedChange: (px) => engine.setBottomReserved(px),
        onNavigate: (taskId, projectId) => {
          // Card click opens the full activity-page agent focus modal for the
          // agent that produced this completion. Falls back to the kanban
          // open-task event when the modal can't bind (no client) so the
          // existing flow isn't broken for non-gateway surfaces.
          if (this.client) {
            openSubagentDetailModal({
              client: this.client,
              requestUpdate: () => this.requestUpdate(),
              kanbanTaskId: taskId,
            });
            return;
          }
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("infinibot:kanban-open-task", {
                detail: { projectId: projectId ?? undefined, taskId },
              }),
            );
          }
        },
      });
      this.breakdown = new WorldMapActiveBreakdown(this.hudEl ?? host, { docked: !!this.hudEl });
      this.breakdown.update(this.agents.values());
    } catch (err) {
      console.error("[agency-world-viz] mount failed:", err);
      this.mountError = err instanceof Error ? err : new Error(String(err));
      this.requestUpdate();
    }
  }

  /**
   * Mount the mesh-upgrade FX layers as DOM siblings of the Pixi canvas inside
   * `host` (which is position:absolute inset:0, so each layer's `:host {inset:0}`
   * anchors to it). Each layer is a self-contained custom element that pulls the
   * per-frame `window.__agentFxState` / `__agentFxZoom` the engine publishes and
   * runs its own rAF — no per-frame wiring needed here.
   *
   * Always-on visual layers (holographic shader, particle trails + glow, emotes,
   * day/night atmosphere) mount on every surface. Interactive/cluttering layers
   * (heatmap + mission picker, sound toggle) mount only on the full surface — the
   * same `noOverlays` gate the pinboard/breakdown panels already respect.
   *
   * Each createElement is isolated so one failing layer can never blank the
   * world (per the §5 error-budget contract).
   */
  private mountWorldLayers(host: HTMLDivElement): void {
    const add = (tag: string): HTMLElement | null => {
      try {
        const el = document.createElement(tag);
        host.appendChild(el);
        this.worldLayers.push(el);
        return el;
      } catch (err) {
        console.warn(`[agency-world-viz] FX layer ${tag} failed to mount:`, err);
        return null;
      }
    };

    // Embedded surfaces (dashboard) opt out of every visual overlay layer.
    // Standalone full-surface mount still gets the ambient atmosphere + holo sheen.
    if (this.noOverlays) return;

    // Always-on visual atmosphere + holographic sheen (read-only, pointer-events:none).
    add("world-atmosphere");
    add("agent-fx-layer");
    add("agent-emotes-layer");
    add("holographic-overlay");

    // Full-surface only: spatial analytics + mission instrument + ambient sound.
    const overlays = add("world-overlays");
    add("world-audio");

    // Persistent queue holding-zone atrium. Lives off to the side of the main
    // concourse (top-right corner of the host) — dim gold sprites for queued
    // entries with phase pips, animating in/out on queue.* WS events. See
    // `src/queue/*` for the data plane; this is the iso-map companion.
    const qhz = add("queue-holding-zone");
    if (qhz) this.dockHoldingZone(qhz);

    // Phase 3 game-functional layer: drag-to-assign, right-click radial command
    // menu, and director (lasso) group-command. Self-attaches to the engine host
    // (.host) and reads window.__agentFxState / __worldSectors /
    // __infinibotGatewayClient. hostSelector must be set BEFORE connectedCallback
    // runs (attachToHost reads it once), and resolves within this shadow root.
    try {
      const interactions = document.createElement("world-interactions");
      interactions.setAttribute("hostselector", ".host");
      host.appendChild(interactions);
      this.worldLayers.push(interactions);
    } catch (err) {
      console.warn("[agency-world-viz] world-interactions failed to mount:", err);
    }

    // Drive the heatmap/mission overlays with real gateway data (credit burn,
    // failure rate, activity density, critical path). Publishes the window
    // globals the overlay reads as a fallback, and pushes data directly too.
    try {
      this.worldFeeds = startWorldFeeds({
        client: this.client,
        overlays: (overlays as unknown as {
          setHeatmapWeights?: (w: unknown) => void;
          setMissionData?: (d: unknown) => void;
        }) ?? null,
      });
    } catch (err) {
      console.warn("[agency-world-viz] world feeds failed to start:", err);
    }
  }

  private teardownWorldLayers(): void {
    this.worldFeeds?.stop();
    this.worldFeeds = null;
    for (const el of this.worldLayers) {
      try {
        el.remove();
      } catch {
        /* ignore */
      }
    }
    this.worldLayers = [];
  }

  /**
   * Watch the document root for theme changes (theme-glass.ts writes inline
   * style vars via applyThemeOverrides and a data-theme attr via setThemeMode)
   * and re-pull the palette. Debounced — applyThemeFromCss only rebuilds the
   * world when the primary accent actually changed.
   */
  private installThemeWatch(): void {
    if (this.themeObs || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    this.themeObs = new MutationObserver(() => {
      if (this.themeTimer) clearTimeout(this.themeTimer);
      this.themeTimer = setTimeout(() => {
        this.themeTimer = null;
        (this.engine as any)?.applyThemeFromCss?.();
      }, 120);
    });
    this.themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme", "data-theme-mode"],
    });
  }

  private retryMount() {
    this.mountError = null;
    this.requestUpdate();
    this.mountEngine();
  }

  private installResizeHandling(host: HTMLDivElement): void {
    this.resizeObs?.disconnect();
    this.resizeObs = new ResizeObserver((entries) => {
      const entry = entries[0];
      this.scheduleResize(entry?.contentRect.width ?? host.clientWidth, entry?.contentRect.height ?? host.clientHeight);
    });
    this.resizeObs.observe(host);
    window.removeEventListener("resize", this.handleWindowResize);
    window.addEventListener("resize", this.handleWindowResize);
  }

  private installPanelVisibilityWatch(host: HTMLDivElement): void {
    this.panelVisibilityObserver?.disconnect();
    this.panelVisibilityObserver = null;
    const update = (visible: boolean) => {
      this.panelVisible = visible;
      this.engine?.setActive(visible && !this.suspended);
      if (visible) this.ensureFxLoop();
      else this.stopFxLoop();
    };
    if (typeof IntersectionObserver !== "undefined") {
      this.panelVisibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.target === host) update(entry.isIntersecting);
        }
      }, { threshold: 0 });
      this.panelVisibilityObserver.observe(host);
    }
    const initiallyVisible = host.getClientRects().length > 0;
    update(initiallyVisible);
  }

  private readonly handleWindowResize = (): void => {
    if (!this.host) return;
    this.scheduleResize(this.host.clientWidth, this.host.clientHeight);
  };

  private scheduleResize(width: number, height: number): void {
    if (!this.engine) return;
    const nextWidth = Math.floor(width);
    const nextHeight = Math.floor(height);
    if (nextWidth <= 0 || nextHeight <= 0) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (!this.engine || !this.host) return;
      const currentWidth = Math.floor(this.host.clientWidth || nextWidth);
      const currentHeight = Math.floor(this.host.clientHeight || nextHeight);
      if (currentWidth <= 0 || currentHeight <= 0) return;
      this.engine.resize(currentWidth, currentHeight);
      this.engine.zoomToFit();
    }, 50);
  }

  /** Wire the live data path: demo source or gateway bridge. */
  private async startData(): Promise<void> {
    if (this.demo) {
      // Demo mode: never touch the gateway; drive from the synthetic source.
      const { startDemoSource } = await import("../views/agent-ops/agency-demo-source.js");
      if (!this.isConnected) return;
      this.demoStop = startDemoSource((events) => this.applyBatch(events));
      return;
    }
    if (!this.client) return;
    this.bridge = new AgencyDataBridge(this.client);
    this.unsub = this.bridge.subscribe((events) => this.applyBatch(events));
    // Plugin District: rooms for every enabled plugin, live on plugin changes.
    void this.refreshPluginRooms();
    if (!this.pluginRoomsListening) {
      window.addEventListener(PLUGIN_HOST_EVENT, this.handlePluginHostEvent);
      this.pluginRoomsListening = true;
    }
    this.pluginSyncTimer = managedInterval(() => void this.refreshPluginRooms(), 45_000, { hiddenMs: 180_000 });
    // Poll reviews every 15 s so badges stay fresh.
    void this.pollReviews();
    this.reviewPollTimer = managedInterval(() => void this.pollReviews(), 15_000, {
      hiddenMs: 60_000,
    });
  }

  // ── Plugin District ──────────────────────────────────────────────────

  private readonly handlePluginHostEvent = (): void => this.applyPluginRooms();

  /** Re-read plugins.list (shared plugin-host cache) and rebuild the rooms. */
  async refreshPluginRooms(): Promise<void> {
    if (!this.client) return;
    await syncPluginHost(this.client);
    this.applyPluginRooms();
  }

  /** Push the current plugin list into the engine: room specs + activity index. */
  applyPluginRooms(): void {
    const engine = this.engine;
    if (!engine) return;
    const items = pluginListSnapshot();
    this.world.setPluginItems(items as unknown[]);
    try {
      engine.setPluginActivityIndex(buildPluginActivityIndex(items as any));
      engine.setPluginRooms(roomSpecsFromPluginList(items as any));
    } catch (err) {
      console.warn("[agency-world-viz] plugin rooms failed:", err);
    }
  }

  /** Click on a plugin room → open the plugin's main page (app router). */
  private openPluginRoom(spec: PluginRoomSpec): void {
    this.dispatchEvent(
      new CustomEvent("agency-plugin-room-select", {
        detail: { pluginId: spec.pluginId, tab: spec.openTab ?? null },
        bubbles: true,
        composed: true,
      }),
    );
    const tab = spec.openTab;
    if (!tab || !isTabAvailable(tab)) return;
    try {
      const basePath = inferBasePathFromPathname(window.location.pathname);
      window.history.pushState({}, "", pathForTab(tab as Tab, basePath));
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch {
      /* navigation is best-effort (harness / embed hosts) */
    }
  }

  private remoteFederationPeer(fromNodeId: string, toNodeId: string): string {
    if (toNodeId && toNodeId !== "local") return toNodeId;
    if (fromNodeId && fromNodeId !== "local") return fromNodeId;
    return toNodeId || fromNodeId || "local";
  }

  /**
   * Pause / resume the 2D renderer while another view of the same world is on
   * screen. Data keeps flowing into the engine and the shared model.
   */
  setSuspended(on: boolean): void {
    if (this.suspended === on) return;
    this.suspended = on;
    this.engine?.setActive(!on && this.panelVisible);
    this.builds?.setPaused(on);
    // Canvas FX layers run their own rAF loops; idle them while hidden.
    for (const el of this.worldLayers) if ("paused" in el) (el as HTMLElement & { paused: boolean }).paused = on;
    if (on) this.stopFxLoop();
    else this.ensureFxLoop();
  }

  /** On-map agent keys as the 2D engine sees them (parity checks / tests). */
  engineAgentKeys(): string[] {
    return this.engine?.agentSessionKeys() ?? [];
  }

  /** Plugin rooms the 2D engine currently draws (parity checks / tests). */
  enginePluginRoomIds(): string[] {
    return this.engine?.pluginRooms().map((r) => r.id) ?? [];
  }

  /** Feed a synthetic WorldEvent batch through the live path (demo / replay harness). */
  injectWorldEvents(events: WorldEvent[]): void {
    this.applyBatch(events);
  }

  /** Apply a coalesced batch of WorldEvents to the engine + local mirrors. */
  private applyBatch(events: WorldEvent[]): void {
    if (!this.engine || !events.length) return;
    this.world.apply(events);
    const touchedNodes = new Set<string>();

    for (const e of events) {
      switch (e.kind) {
        case "node.upsert": {
          const existed = this.nodes.has(e.node.id);
          this.nodes.set(e.node.id, e.node);
          if (!existed) this.engine.addNode(e.node);
          this.engine.updateNode(e.node.id, e.node);
          touchedNodes.add(e.node.id);
          break;
        }
        case "node.remove": {
          this.nodes.delete(e.nodeId);
          this.engine.removeNode(e.nodeId);
          break;
        }
        case "agent.spawn": {
          const done = e.agent.status === "completed" || e.agent.status === "failed";
          if (done) {
            // Restored resting finished run (page reload): straight onto a bed,
            // kept out of the live mirror / counts / build tags.
            if (!this.engine.hasAgent(e.agent.sessionKey)) this.engine.addAgent(e.agent);
            break;
          }
          const seen = this.agents.has(e.agent.sessionKey);
          this.agents.set(e.agent.sessionKey, e.agent);
          // A resting finished agent (dropped from the local mirror, still on
          // its Concourse bed) that goes active again wakes in place.
          if (!seen && !this.engine.hasAgent(e.agent.sessionKey)) this.engine.addAgent(e.agent);
          else this.engine.updateAgent(e.agent.sessionKey, e.agent);
          this.builds?.upsert(e.agent);
          touchedNodes.add(e.agent.nodeId);
          this.ensureFxLoop(); // start idle-bob animation immediately
          break;
        }
        case "agent.progress": {
          const prev = this.agents.get(e.sessionKey);
          if (prev) this.agents.set(e.sessionKey, { ...prev, ...e.patch });
          this.engine.updateAgent(e.sessionKey, e.patch);
          this.builds?.patch(e.sessionKey, { ...e.patch, sessionKey: e.sessionKey });
          noteAgentActivity(e.sessionKey, performance.now());
          break;
        }
        case "agent.tool": {
          const patch = {
            lastActivityKind: e.tool.kind,
            lastActivity: { kind: e.tool.kind, label: e.tool.label, at: Date.now() },
            lastActivityAt: Date.now(),
          } as Partial<MeshAgent>;
          const prev = this.agents.get(e.sessionKey);
          if (prev) this.agents.set(e.sessionKey, { ...prev, ...patch });
          this.engine.updateAgent(e.sessionKey, patch);
          this.builds?.patch(e.sessionKey, { activityLabel: e.tool.label });
          // Pop a transient chat bubble over the agent sprite (optional-chained
          // so a swapped-in engine without the method stays safe).
          (this.engine as any).showToolBubble?.(e.sessionKey, e.tool.kind, e.tool.label);
          // Per-tool pulse ring + walk-trail arming; the HUD counts it for Tools/Min.
          this.hudStats.noteTool(performance.now());
          (this.engine as any).pulseToolAtRoom?.(e.sessionKey, e.tool.kind);
          // Walk the agent to the HQ sector that matches the tool category
          // (Part 1 — activity-driven movement).
          (this.engine as any).routeAgentToToolSector?.(e.sessionKey, e.tool.kind, e.tool.label);
          break;
        }
        case "agent.leave": {
          // Evicted from the recently-completed ring — walk off the map.
          this.agents.delete(e.sessionKey);
          this.engine.removeAgent(e.sessionKey);
          break;
        }
        case "agent.message": {
          this.engine.showMessage({
            id: `${e.from}>${e.to}:${Date.now()}`,
            from: e.from,
            to: e.to,
            type: e.type,
            timestamp: Date.now(),
          });
          break;
        }
        case "agent.complete": {
          const status: MeshAgent["status"] = e.success ? "completed" : "failed";
          const prev = this.agents.get(e.sessionKey);
          if (prev) {
            this.agents.set(e.sessionKey, { ...prev, status });
            touchedNodes.add(prev.nodeId);
          }
          this.engine.updateAgent(e.sessionKey, { status });
          this.builds?.finish(e.sessionKey, e.success, e.message);
          this.forgetFinishedAgent(e.sessionKey);
          // Glyph burst + heartbeat surge so the completion is impossible to miss.
          (this.engine as any).burstCompletion?.(e.sessionKey, e.success);
          noteAgentCompletion(e.sessionKey, performance.now(), e.success);
          // Phase 4 §agent biographies — auto-capture a milestone clip (opt-in via
          // window.__worldBiographies). No-op when disabled or capture in flight.
          onMilestone(e.sessionKey, e.success, this.agents.get(e.sessionKey)?.label);
          break;
        }
        case "task.ingest": {
          (this.engine as any).pushTask?.(e.title, 0xfbbf24, e.nodeId);
          // Send an agent on a trip to the task board (Part 1).
          (this.engine as any).routeTaskTrip?.(e.nodeId, e.id);
          break;
        }
        case "period.tick": {
          // No-op here; engine drives its own clock. Reserved for ticker sync.
          break;
        }
        case "fed.peer.connect": {
          (this.engine as any).ensureFederationConduit?.(e.peerNodeId, {
            displayName: this.nodes.get(e.peerNodeId)?.name,
          });
          (this.engine as any).surgeAtrium?.(1);
          break;
        }
        case "fed.peer.disconnect": {
          (this.engine as any).releaseFederationConduit?.(e.peerNodeId);
          break;
        }
        case "fed.msg.send": {
          const peerId = this.remoteFederationPeer(e.fromNodeId, e.toNodeId);
          (this.engine as any).ensureFederationConduit?.(peerId, {
            displayName: this.nodes.get(peerId)?.name,
          });
          (this.engine as any).pulseConduit?.(peerId, "send", { text: e.messageType });
          (this.engine as any).surgeAtrium?.(1);
          break;
        }
        case "fed.msg.ack": {
          const peerId = this.remoteFederationPeer(e.fromNodeId, e.toNodeId);
          (this.engine as any).ensureFederationConduit?.(peerId, {
            displayName: this.nodes.get(peerId)?.name,
          });
          (this.engine as any).pulseConduit?.(peerId, "ack", { text: "OK" });
          (this.engine as any).surgeAtrium?.(0.8);
          break;
        }
        case "fed.msg.fail": {
          const peerId = this.remoteFederationPeer(e.fromNodeId, e.toNodeId);
          (this.engine as any).ensureFederationConduit?.(peerId, {
            displayName: this.nodes.get(peerId)?.name,
          });
          (this.engine as any).pulseConduit?.(peerId, "fail", { text: e.reason });
          break;
        }
        case "ssh.connection.opened":
        case "ssh.open": {
          (this.engine as any).ensureSshConduit?.(e.deviceId, e.host);
          break;
        }
        case "ssh.connection.closed":
        case "ssh.close": {
          (this.engine as any).releaseSshConduit?.(e.deviceId);
          break;
        }
        case "ssh.command.executed":
        case "ssh.exec": {
          (this.engine as any).ensureSshConduit?.(e.deviceId, e.host);
          (this.engine as any).pulseConduit?.(e.deviceId, "command", { text: e.command });
          (this.engine as any).pulseConduit?.(e.deviceId, "ack", { text: e.exitCode === 0 ? "OK" : String(e.exitCode) });
          (this.engine as any).surgeAtrium?.(1);
          break;
        }
        case "ssh.connection.error":
        case "ssh.error": {
          (this.engine as any).ensureSshConduit?.(e.deviceId, e.host);
          (this.engine as any).pulseConduit?.(e.deviceId, "fail", { text: e.error });
          break;
        }
      }
    }

    if (this.hoveredKey && this.bxTooltipAnchor) {
      this.updateTooltip(this.hoveredKey, this.bxTooltipAnchor.x, this.bxTooltipAnchor.y);
    }

    // Recompute per-node agent counts and push into building labels.
    if (touchedNodes.size || events.some((e) => e.kind === "agent.spawn")) {
      this.recomputeNodeCounts();
    }

    // Refresh the top-left per-backend breakdown whenever the agent set or any
    // agent's status/backend changed.
    if (
      events.some(
        (e) =>
          e.kind === "agent.spawn" ||
          e.kind === "agent.progress" ||
          e.kind === "agent.complete",
      )
    ) {
      this.breakdown?.update(this.agents.values());
    }

    // Feed the live token total into the HUD's Tokens/Hr readout. The controller
    // mesh state carries per-agent token usage that the engine doesn't see.
    this.feedTokenTotal();

    // Phase 1: surface interesting beats to the broadcast camera + highlights.
    this.noteWorldEvents(events);
  }

  /**
   * Drop a finished agent from the local mirror once the engine has walked it
   * off (and its build tag has cleared), so the Active Agents breakdown and
   * node counts stop listing it. A re-spawn of the same key re-adds it.
   */
  private forgetFinishedAgent(sessionKey: string): void {
    const timers = (this.forgetTimers ??= new Map());
    const prior = timers.get(sessionKey);
    if (prior) clearTimeout(prior);
    timers.set(
      sessionKey,
      setTimeout(() => {
        timers.delete(sessionKey);
        const a = this.agents.get(sessionKey);
        if (!a || (a.status !== "completed" && a.status !== "failed")) return;
        this.agents.delete(sessionKey);
        this.recomputeNodeCounts();
        this.breakdown?.update(this.agents.values());
      }, 8000),
    );
  }

  /** Sum totalTokens across all live agents and hand it to the engine HUD. */
  private feedTokenTotal(): void {
    if (!this.engine) return;
    try {
      let total = 0;
      getMeshState().agents.forEach((a: any) => {
        const t = a?.totalTokens ?? ((a?.inputTokens ?? 0) + (a?.outputTokens ?? 0));
        if (Number.isFinite(t)) total += t;
      });
      (this.engine as any).noteTokensTotal?.(total);
    } catch {
      /* mesh state unavailable — HUD shows 0, no harm */
    }
  }

  /** Recompute agentCount per node from local mirror and push to engine. */
  private recomputeNodeCounts(): void {
    if (!this.engine) return;
    const counts = new Map<string, number>();
    for (const a of this.agents.values()) {
      counts.set(a.nodeId, (counts.get(a.nodeId) || 0) + 1);
    }
    for (const [id, node] of this.nodes) {
      const count = counts.get(id) || 0;
      if (node.agentCount !== count) {
        node.agentCount = count;
        this.engine.updateNode(id, { ...node, agentCount: count });
      }
    }
  }

  /** Watch the gateway connection for lightning / reconnect signalling. */
  private startConnWatch(): void {
    if (this.demo || !this.client) return;
    this.wasConnected = !!this.client.connected;
    this.reconnecting = !this.wasConnected;
    this.connTimer = managedInterval(() => {
      if (!this.client || !this.engine) return;
      const now = !!this.client.connected;
      if (this.wasConnected && !now) {
        this.reconnecting = true;
        this.requestUpdate();
        (this.engine as any).signalDisconnect?.();
      } else if (!this.wasConnected && now) {
        this.reconnecting = false;
        this.requestUpdate();
        (this.engine as any).signalReconnect?.();
      }
      this.wasConnected = now;
    }, 1000, { hiddenMs: 15_000 });
  }

  /** Imperative controls for parent UIs. */
  zoomToFit() {
    this.engine?.zoomToFit();
  }
  zoomIn() {
    this.engine?.zoomIn();
  }
  zoomOut() {
    this.engine?.zoomOut();
  }
  toggleLabels() {
    return this.engine?.toggleLabels();
  }
  setLabelsHidden(hidden: boolean) {
    this.engine?.setLabelsHidden(hidden);
  }

  /** Underlying PixiJS canvas (getView added by the engine integrator in Wave 2). */
  getCanvas(): HTMLCanvasElement | null {
    const eng: any = this.engine;
    return eng?.getView?.() ?? (eng?.app?.view as HTMLCanvasElement | undefined) ?? null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Cross-device camera mirror — publish camera beats on `world.camera`.
  // ──────────────────────────────────────────────────────────────────────────

  /** Subscribe to the engine's camera-settle and debounce-publish each beat. */
  private installCameraPublish(): void {
    const engine = this.eng();
    if (!engine || typeof engine.onCameraSettle !== "function") return; // unsupported engine
    this.cameraPublishUnsub = engine.onCameraSettle(() => this.scheduleCameraPublish());
  }

  private scheduleCameraPublish(): void {
    // Debounce 80ms so we publish once the transform settles, not every frame
    // of an animated fly-to / decelerating drag.
    if (this.cameraPublishTimer) clearTimeout(this.cameraPublishTimer);
    this.cameraPublishTimer = setTimeout(() => {
      this.cameraPublishTimer = null;
      this.publishCamera();
    }, 80);
  }

  private publishCamera(): void {
    const client = this.client;
    const engine = this.eng();
    if (!client || !client.connected || typeof engine?.getCamera !== "function") return;
    const cam = engine.getCamera() as { zoom: number; centerX: number; centerY: number } | null;
    if (!cam) return;
    // Skip near-identical beats (sub-pixel / sub-1% zoom jitter).
    const prev = this.lastPublishedCam;
    if (
      prev &&
      Math.abs(prev.zoom - cam.zoom) < 0.01 &&
      Math.abs(prev.centerX - cam.centerX) < 2 &&
      Math.abs(prev.centerY - cam.centerY) < 2
    ) {
      return;
    }
    this.lastPublishedCam = cam;
    void client
      .request("world.camera", {
        zoom: Math.round(cam.zoom * 1000) / 1000,
        centerX: Math.round(cam.centerX),
        centerY: Math.round(cam.centerY),
        easeMs: 600,
        source: "web",
        publisherId: this.cameraPublisherId,
      })
      .catch(() => {
        /* `world.camera` handler is unregistered until the gateway restarts —
           swallow so the viz never errors on older gateways. */
      });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Phase 1 holographic revamp — broadcast camera, zoom controls, highlights.
  // Pure DOM/SVG overlay; the Pixi engine is read only via additive accessors,
  // so a swapped-in / mobile engine without them simply yields no broadcast.
  // ──────────────────────────────────────────────────────────────────────────

  private eng(): any {
    return this.engine as any;
  }

  /**
   * Top-left HUD column: [toolbar pills] → [ONLINE AGENTS · TOOLS/MIN ·
   * TOKENS/HR] → [Active Agents list]. A single flex column so the pieces
   * stack instead of each being absolutely pinned to the same corner. The
   * stats replace the in-canvas Pixi card (hidden via the engine) and read the
   * live agent mirror, refreshed on a visibility-aware 1 s timer.
   */
  private installHudColumn(host: HTMLElement): void {
    if (this.hudEl) return;
    const hud = document.createElement("div");
    hud.className = "awv-hud";
    const toolbar = document.createElement("div");
    toolbar.className = "awv-toolbar";
    toolbar.dataset.testid = "mesh-hud-toolbar";
    // Compact HUD (phones / coarse pointers): one toggle collapses the stats,
    // the Holding Zone and the Active Agents list. Hidden by CSS on desktop,
    // where the class has no effect either.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "bx-btn awv-hud-toggle";
    toggle.dataset.testid = "mesh-hud-details-toggle";
    const chev = document.createElement("span");
    chev.className = "awv-hud-toggle-chev";
    chev.setAttribute("aria-hidden", "true");
    chev.textContent = "▾";
    const count = document.createElement("span");
    count.className = "awv-hud-toggle-count";
    count.textContent = "0";
    toggle.append(chev, count);
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setHudDetailsCollapsed(!hud.classList.contains("awv-hud--collapsed"), true);
    });
    toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
    toolbar.appendChild(toggle);
    this.hudDetailsToggle = toggle;
    const stats = document.createElement("div");
    stats.className = "awv-stats";
    stats.setAttribute("role", "status");
    stats.setAttribute("aria-label", "Live agent metrics");
    for (const [key, label, title] of [
      ["online", "ONLINE AGENTS", "Agents currently running (finished runs resting on the concourse are excluded)"],
      ["tools", "TOOLS / MIN", "Tool calls across all agents in the last 60 seconds"],
      ["tokens", "TOKENS / HR", "Token usage rate observed since this view opened (— = no usage reported)"],
    ] as const) {
      const cell = document.createElement("div");
      cell.className = "awv-stat";
      cell.dataset.stat = key;
      cell.title = title;
      const l = document.createElement("span");
      l.className = "awv-stat-label";
      l.textContent = label;
      const v = document.createElement("span");
      v.className = "awv-stat-value";
      v.textContent = "—";
      cell.append(l, v);
      stats.appendChild(cell);
    }
    stats.dataset.testid = "mesh-hud-stats";
    hud.append(toolbar, stats);
    hud.dataset.testid = "mesh-hud";
    host.appendChild(hud);
    this.hudEl = hud;
    this.hudToolbar = toolbar;
    this.hudStatsEl = stats;
    this.setHudDetailsCollapsed(this.readHudDetailsCollapsed(), false);
    (this.engine as any)?.setHudMetricsPanelVisible?.(false);
    if (typeof ResizeObserver !== "undefined") {
      this.hudResizeObs = new ResizeObserver(() => this.layoutRightStack(host));
      this.hudResizeObs.observe(hud);
      this.hudResizeObs.observe(host);
    }
    this.layoutRightStack(host);
    this.refreshHudStats();
    this.hudStatsTimer = managedInterval(() => this.refreshHudStats(), 1_000, { hiddenMs: 10_000 });
  }

  /** Persisted compact-HUD state; defaults to collapsed on phones. */
  private readHudDetailsCollapsed(): boolean {
    try {
      const v = localStorage.getItem(AgencyWorldViz.HUD_DETAILS_KEY);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch {
      /* storage blocked */
    }
    return typeof window !== "undefined" && !!window.matchMedia?.(AgencyWorldViz.COMPACT_HUD_MQ).matches;
  }

  private setHudDetailsCollapsed(collapsed: boolean, persist: boolean): void {
    const hud = this.hudEl;
    if (!hud) return;
    hud.classList.toggle("awv-hud--collapsed", collapsed);
    const t = this.hudDetailsToggle;
    if (t) {
      t.setAttribute("aria-expanded", String(!collapsed));
      const label = collapsed ? "Show agent stats and holding zone" : "Hide agent stats and holding zone";
      t.title = label;
      t.setAttribute("aria-label", label);
    }
    if (persist) {
      try {
        localStorage.setItem(AgencyWorldViz.HUD_DETAILS_KEY, collapsed ? "1" : "0");
      } catch {
        /* storage blocked */
      }
    }
  }

  /** Dock the queue Holding Zone into the HUD column (after the stats) at
   *  every width, so it never floats over the map's cards or signs. */
  private dockHoldingZone(qhz: HTMLElement): void {
    const hud = this.hudEl;
    if (!hud) return;
    qhz.setAttribute("docked", "");
    qhz.dataset.testid = "mesh-holding-zone";
    if (qhz.parentElement !== hud || qhz.previousElementSibling !== this.hudStatsEl) {
      hud.insertBefore(qhz, this.hudStatsEl?.nextSibling ?? null);
    }
  }

  /**
   * Keep the top-right Pixi chrome (orbital minimap + theme picker) clear of
   * the HUD column, and tell the engine which screen area the column covers
   * so zoomToFit frames the world beside (wide) or below (phones) it.
   */
  private layoutRightStack(host: HTMLElement): void {
    const hud = this.hudEl;
    if (!hud) return;
    const RIGHT_CLUSTER_W = 170; // minimap (150) + margins
    const hudRight = hud.offsetLeft + hud.offsetWidth;
    const hudBottom = hud.offsetTop + hud.offsetHeight;
    // The column's real footprint (host px): signs under it hide, build tags avoid it.
    const hb = hud.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    this.chromeRects = hb.width && hb.height ? [{ x: hb.left - hostBox.left, y: hb.top - hostBox.top, width: hb.width, height: hb.height }] : [];
    (this.engine as any)?.setChromeRects?.(this.chromeRects);
    const W = host.clientWidth;
    const H = host.clientHeight;
    const narrow = hudRight + 12 > W - RIGHT_CLUSTER_W;
    // No room for the Pixi orbital map / theme picker beside the column (and
    // below it they'd land on the zoom controls) — hide them on narrow hosts.
    (this.engine as any)?.setTopRightChromeHidden?.(narrow);
    // Reserve whichever edge leaves the larger free area for the world.
    if (W > 0 && H > 0) {
      const freeBeside = Math.max(0, W - hudRight - 12) * H;
      const freeBelow = W * Math.max(0, H - hudBottom - 12);
      (this.engine as any)?.setFitInsets?.(
        freeBeside >= freeBelow ? { left: hudRight + 12 } : { top: hudBottom + 12 },
      );
    }
  }

  private refreshHudStats(): void {
    const el = this.hudStatsEl;
    if (!el) return;
    const now = performance.now();
    this.hudStats.noteTokens(this.agents.values(), now);
    const s = this.hudStats.compute(this.agents.values(), now);
    const set = (key: string, text: string) => {
      const v = el.querySelector(`[data-stat="${key}"] .awv-stat-value`);
      if (v && v.textContent !== text) v.textContent = text;
    };
    set("online", String(s.online));
    const tc = this.hudDetailsToggle?.querySelector(".awv-hud-toggle-count");
    if (tc && tc.textContent !== String(s.online)) tc.textContent = String(s.online);
    set("tools", formatHudNumber(s.toolsPerMin));
    set("tokens", formatHudNumber(s.tokensPerHr));
  }

  private stopOwnerDecisionFeed(): void {
    this.decisionPollTimer?.cancel();
    this.decisionPollTimer = null;
    this.decisionEventUnsub?.();
    this.decisionEventUnsub = null;
    if (this.decisionRefreshTimer) clearTimeout(this.decisionRefreshTimer);
    this.decisionRefreshTimer = null;
    if (this.decisionNoticeTimer) clearTimeout(this.decisionNoticeTimer);
    this.decisionNoticeTimer = null;
  }

  private async startOwnerDecisionFeed(): Promise<void> {
    this.stopOwnerDecisionFeed();
    if (!this.client || !this.isConnected || !this.reviewLayer || this.noOverlays) return;
    const subscribable = this.client as GatewayBrowserClient & {
      subscribe?: (handler: (event: { event?: string; payload?: unknown }) => void) => () => void;
    };
    if (typeof subscribable.subscribe === "function") {
      this.decisionEventUnsub = subscribable.subscribe((event) => {
        if (!event.event || !OWNER_DECISION_EVENTS.has(event.event)) return;
        if (this.decisionRefreshTimer) clearTimeout(this.decisionRefreshTimer);
        this.decisionRefreshTimer = setTimeout(() => {
          this.decisionRefreshTimer = null;
          void this.refreshOwnerDecisions();
        }, 180);
      });
    }
    this.decisionPollTimer = managedInterval(() => void this.refreshOwnerDecisions(), 12_000, {
      hiddenMs: 60_000,
    });
    await this.refreshOwnerDecisions();
  }

  private async refreshOwnerDecisions(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await loadOwnerDecisions(this.client);
      this.ownerDecisions = result.decisions;
      if (this.activeDecisionId && !this.ownerDecisions.some((d) => d.id === this.activeDecisionId)) {
        this.activeDecisionId = null;
      }
      this.decisionError = null;
      this.renderDecisionHud();
      if (this.hoveredKey && this.bxTooltipAnchor) {
        this.updateTooltip(this.hoveredKey, this.bxTooltipAnchor.x, this.bxTooltipAnchor.y);
      }
    } catch (error) {
      // An older side gateway may not advertise the aggregate yet. Keep the
      // mesh usable and surface the error only after the owner opens the chip.
      this.decisionError = error instanceof Error ? error.message : String(error);
      this.renderDecisionHud();
    }
  }

  private installDecisionHud(): void {
    if (!this.hudEl || !this.hudToolbar || this.decisionChip) return;
    const chip = document.createElement("button");
    chip.className = "od-chip";
    chip.type = "button";
    chip.setAttribute("aria-expanded", "false");
    chip.setAttribute("aria-label", "Pending owner decisions");
    const icon = document.createElement("span");
    icon.className = "bx-tt-ico";
    litRender(icons.alertCircle, icon);
    const label = document.createElement("span");
    label.className = "od-chip-label";
    chip.append(icon, label);
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      const list = this.decisionList;
      if (!list) return;
      const show = !list.classList.contains("show");
      list.classList.toggle("show", show);
      chip.setAttribute("aria-expanded", String(show));
      if (show) this.renderGlobalDecisionList();
    });
    const list = document.createElement("div");
    list.className = "od-global";
    list.setAttribute("role", "dialog");
    list.setAttribute("aria-label", "Pending owner decisions");
    list.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.hudToolbar.appendChild(chip);
    this.hudEl.appendChild(list);
    this.decisionChip = chip;
    this.decisionList = list;
    this.renderDecisionHud();
  }

  private renderDecisionHud(): void {
    const chip = this.decisionChip;
    if (!chip) return;
    const count = this.ownerDecisions.length;
    const label = chip.querySelector(".od-chip-label");
    if (label) {
      const txt = document.createElement("span");
      txt.className = "bx-pill-txt";
      txt.textContent = "Decisions ";
      label.replaceChildren(txt, document.createTextNode(`(${count})`));
    }
    chip.hidden = count === 0 && !this.decisionError;
    if (this.decisionList?.classList.contains("show")) this.renderGlobalDecisionList();
  }

  private findDecisionAgent(decision: OwnerDecision): MeshAgent | undefined {
    return [...this.agents.values()].find((agent) => decisionsForAgent([decision], agent).length > 0);
  }

  private renderGlobalDecisionList(): void {
    const panel = this.decisionList;
    if (!panel) return;
    panel.replaceChildren();
    if (this.decisionNotice) {
      const notice = document.createElement("div");
      notice.className = "od-resumed show";
      const noticeIcon = document.createElement("span");
      noticeIcon.className = "bx-tt-ico";
      litRender(icons.checkCircle, noticeIcon);
      const noticeText = document.createElement("span");
      noticeText.textContent = this.decisionNotice;
      notice.append(noticeIcon, noticeText);
      panel.appendChild(notice);
    }
    if (this.decisionError && this.ownerDecisions.length === 0) {
      const error = document.createElement("div");
      error.className = "od-error";
      error.textContent = `Could not load decisions: ${this.decisionError}`;
      panel.appendChild(error);
      return;
    }
    for (const decision of this.ownerDecisions) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "od-global-row";
      const icon = document.createElement("span");
      icon.className = "od-global-icon";
      litRender(decision.kind === "approval" ? icons.shieldCheck : icons.alertCircle, icon);
      const copy = document.createElement("span");
      const title = document.createElement("span");
      title.className = "od-global-title";
      title.textContent = decision.title;
      const sub = document.createElement("span");
      sub.className = "od-global-sub";
      sub.textContent = decision.question;
      copy.append(title, sub);
      const kind = document.createElement("span");
      kind.className = "od-global-kind";
      kind.textContent = decision.risk
        ? `${decision.risk} risk`
        : decision.kind === "run_input"
          ? "input"
          : decision.kind.replace(/_/g, " ");
      row.append(icon, copy, kind);
      row.addEventListener("click", () => {
        this.activeDecisionId = decision.id;
        const agent = this.findDecisionAgent(decision);
        if (agent) {
          this.decisionList?.classList.remove("show");
          this.decisionChip?.setAttribute("aria-expanded", "false");
          this.showAgentHoverCard(agent.sessionKey, true);
          return;
        }
        this.renderGlobalDecisionList();
      });
      panel.appendChild(row);
      if (this.activeDecisionId === decision.id && !this.findDecisionAgent(decision)) {
        const detail = document.createElement("div");
        detail.className = "bx-tt-decision has-decisions";
        const badge = document.createElement("div");
        badge.className = "od-card-badge";
        const badgeIcon = document.createElement("span");
        badgeIcon.className = "bx-tt-ico";
        litRender(icons.alertCircle, badgeIcon);
        const badgeLabel = document.createElement("span");
        badgeLabel.textContent = `Decision needed${decision.risk ? ` · ${decision.risk} risk` : ""}`;
        badge.append(badgeIcon, badgeLabel);
        detail.appendChild(badge);
        const body = document.createElement("div");
        body.className = "od-card-body";
        detail.appendChild(body);
        this.renderDecisionBody(body, decision);
        panel.appendChild(detail);
      }
    }
  }

  private renderAgentDecisionPanel(tt: HTMLElement, agent: MeshAgent): void {
    const panel = tt.querySelector(".bx-tt-decision") as HTMLElement | null;
    if (!panel) return;
    const decisions = decisionsForAgent(this.ownerDecisions, agent);
    panel.classList.toggle("has-decisions", decisions.length > 0);
    panel.replaceChildren();
    const resumed = (this.resumedAgents.get(agent.sessionKey) ?? 0) > Date.now();
    tt.querySelector(".od-resumed")?.classList.toggle("show", resumed);
    if (!decisions.length) return;
    let selected = decisions.find((d) => d.id === this.activeDecisionId) ?? decisions[0];
    this.activeDecisionId = selected.id;
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = "od-card-badge";
    const icon = document.createElement("span");
    icon.className = "bx-tt-ico";
    litRender(icons.alertCircle, icon);
    const label = document.createElement("span");
    label.textContent = `Decision needed · ${decisions.length}${selected.risk ? ` · ${selected.risk} risk` : ""}`;
    badge.append(icon, label);
    const body = document.createElement("div");
    body.className = "od-card-body";
    body.hidden = false;
    badge.addEventListener("click", () => {
      body.hidden = !body.hidden;
      this.bxTooltipPinned = true;
      tt.classList.add("is-pinned");
    });
    panel.append(badge, body);
    this.renderDecisionBody(body, selected);
  }

  private renderDecisionBody(container: HTMLElement, decision: OwnerDecision): void {
    container.replaceChildren();
    const question = document.createElement("div");
    question.className = "od-card-question";
    question.textContent = decision.question || decision.title;
    container.appendChild(question);
    if (decision.context && decision.context !== decision.question) {
      const details = document.createElement("details");
      details.className = "od-context";
      const summary = document.createElement("summary");
      summary.textContent = "Context";
      const text = document.createElement("div");
      text.textContent = decision.context;
      details.append(summary, text);
      container.appendChild(details);
    }
    const reply = document.createElement("input");
    reply.type = "text";
    reply.placeholder = decision.kind === "run_input" ? "Reply to the agent…" : "Optional note…";
    reply.setAttribute("aria-label", reply.placeholder);
    const actions = document.createElement("div");
    actions.className = "od-actions";
    for (const choice of decision.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `od-action ${choice.tone ?? "neutral"}`;
      button.textContent = choice.label;
      button.disabled = this.decisionBusyId === decision.id;
      button.addEventListener("click", () => void this.submitOwnerDecision(decision, choice.action, reply.value));
      actions.appendChild(button);
    }
    if (decision.allowText) {
      const replyRow = document.createElement("div");
      replyRow.className = "od-reply";
      const send = document.createElement("button");
      send.type = "button";
      send.className = "od-action primary";
      send.textContent = decision.kind === "run_input" ? "Reply & resume" : "Send note";
      send.disabled = this.decisionBusyId === decision.id;
      send.addEventListener("click", () => {
        const fallback =
          decision.kind === "approval"
            ? "approve"
            : decision.kind === "kanban_blocked"
              ? "unblock"
              : decision.kind === "run_owner"
                ? "continue"
                : "reply";
        void this.submitOwnerDecision(decision, fallback, reply.value);
      });
      reply.addEventListener("keydown", (event) => {
        if (event.key === "Enter") send.click();
      });
      replyRow.append(reply, send);
      container.appendChild(replyRow);
    }
    if (decision.choices.length) container.appendChild(actions);
    const link = document.createElement("button");
    link.type = "button";
    link.className = "od-link";
    link.textContent = decision.link.label;
    link.addEventListener("click", () => this.openDecisionLink(decision));
    container.appendChild(link);
    if (this.decisionBusyId === decision.id) {
      const status = document.createElement("div");
      status.className = "od-global-sub";
      status.textContent = "Applying decision…";
      container.appendChild(status);
    }
    if (this.decisionError && this.activeDecisionId === decision.id) {
      const error = document.createElement("div");
      error.className = "od-error";
      error.textContent = this.decisionError;
      container.appendChild(error);
    }
  }

  private openDecisionLink(decision: OwnerDecision): void {
    if (decision.target.runId && this.client) {
      openSubagentDetailModal({
        client: this.client,
        requestUpdate: () => this.requestUpdate(),
        runId: decision.target.runId,
      });
      return;
    }
    if (decision.target.taskId) {
      window.dispatchEvent(
        new CustomEvent("infinibot:kanban-open-task", { detail: { taskId: decision.target.taskId } }),
      );
      try {
        const basePath = inferBasePathFromPathname(window.location.pathname);
        window.history.pushState({}, "", pathForTab("projects" as Tab, basePath));
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch {
        /* best effort */
      }
      return;
    }
    window.location.hash = decision.link.href.replace(/^#/, "");
  }

  private async submitOwnerDecision(
    decision: OwnerDecision,
    action: string,
    reply: string,
  ): Promise<void> {
    if (!this.client || this.decisionBusyId) return;
    this.activeDecisionId = decision.id;
    this.decisionBusyId = decision.id;
    this.decisionError = null;
    if (this.hoveredKey && this.bxTooltipAnchor) {
      this.updateTooltip(this.hoveredKey, this.bxTooltipAnchor.x, this.bxTooltipAnchor.y);
    } else {
      this.renderGlobalDecisionList();
    }
    try {
      const result = await resolveOwnerDecision(this.client, decision, action, reply);
      this.ownerDecisions = this.ownerDecisions.filter((item) => item.id !== decision.id);
      if (result.resumed) {
        // Reflect the successful continuation immediately. The gateway is
        // updated by resolveOwnerDecision as well, but the mesh data poll
        // can otherwise leave a stale BLOCKED pill beside RESUMED for a
        // full refresh interval.
        settleResumedOwnerDecisionAgent(
          this.findDecisionAgent(decision),
          this.resumedAgents,
        );
      }
      this.activeDecisionId = null;
      this.decisionNotice = result.message;
      if (this.decisionNoticeTimer) clearTimeout(this.decisionNoticeTimer);
      this.decisionNoticeTimer = setTimeout(() => {
        this.decisionNotice = null;
        this.decisionNoticeTimer = null;
        if (this.decisionList?.classList.contains("show")) this.renderGlobalDecisionList();
      }, 10_000);
      this.hoverNote(result.message);
      this.renderDecisionHud();
      if (this.hoveredKey && this.bxTooltipAnchor) {
        this.updateTooltip(this.hoveredKey, this.bxTooltipAnchor.x, this.bxTooltipAnchor.y);
      }
      this.decisionRefreshTimer = setTimeout(() => {
        this.decisionRefreshTimer = null;
        void this.refreshOwnerDecisions();
      }, 500);
    } catch (error) {
      this.decisionError = error instanceof Error ? error.message : String(error);
      if (this.hoveredKey && this.bxTooltipAnchor) {
        this.updateTooltip(this.hoveredKey, this.bxTooltipAnchor.x, this.bxTooltipAnchor.y);
      } else {
        this.renderGlobalDecisionList();
      }
    } finally {
      this.decisionBusyId = null;
      if (this.hoveredKey && this.bxTooltipAnchor) {
        this.updateTooltip(this.hoveredKey, this.bxTooltipAnchor.x, this.bxTooltipAnchor.y);
      } else if (this.decisionList?.classList.contains("show")) {
        this.renderGlobalDecisionList();
      }
    }
  }

  /** Build the overlay DOM, the BroadcastDirector, and the rAF FX loop. */
  private installBroadcastOverlay(host: HTMLElement): void {
    const engine = this.eng();
    if (!engine || typeof engine.getViewport !== "function") return; // unsupported engine
    if (this.bxLayer) return;

    this.mobileLike =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(pointer: coarse)").matches || window.innerWidth < 540);

    const svgNS = "http://www.w3.org/2000/svg";
    const layer = document.createElement("div");
    layer.className = "bx-layer";

    const svg = document.createElementNS(svgNS, "svg") as SVGSVGElement;
    svg.setAttribute("class", "bx-fx");
    layer.appendChild(svg);

    const caption = document.createElement("div");
    caption.className = "bx-caption";
    layer.appendChild(caption);

    const broadcastBtn = document.createElement("button");
    broadcastBtn.className = "bx-btn bx-broadcast";
    this.setPillLabel(broadcastBtn, "📡", " BROADCAST");
    broadcastBtn.setAttribute("aria-label", "Broadcast camera");
    broadcastBtn.addEventListener("click", () => this.toggleBroadcast());
    (this.hudToolbar ?? layer).appendChild(broadcastBtn);

    // Zoom +/−/fit already exist as in-engine Pixi UIControls (bottom-right);
    // we add cursor-centered wheel + pinch (engine), a wider zoom ceiling, and
    // double-click-to-fly below rather than a duplicate button cluster.

    const tooltip = document.createElement("div");
    tooltip.className = "bx-tooltip";
    tooltip.dataset.testid = "agent-mesh-hover-card";
    tooltip.setAttribute("role", "dialog");
    tooltip.setAttribute("aria-label", "Agent details");
    tooltip.innerHTML = `
      <div class="bx-tt-head">
        <div class="bx-tt-logo-wrap"><img class="bx-tt-logo" alt="" /></div>
        <div class="bx-tt-identity">
          <div class="bx-tt-name"></div>
          <div class="bx-tt-role"></div>
          <div class="bx-tt-id"></div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="od-resumed"><span data-icon="checkCircle"></span> resumed</div>
          <div class="bx-tt-status"></div>
          <button class="bx-tt-close" aria-label="Close agent details" data-icon="x"></button>
        </div>
      </div>
      <div class="bx-tt-work">
        <div class="bx-tt-kicker">Current task</div>
        <div class="bx-tt-task"></div>
        <div class="bx-tt-activity"><span class="bx-tt-activity-label">Latest action · </span><span class="bx-tt-activity-value"></span><span class="bx-tt-activity-age"></span></div>
        <div class="bx-tt-progress-row"><span>Run progress</span><span class="bx-tt-progress-value"></span></div>
        <div class="bx-tt-track"><div class="bx-tt-fill"></div></div>
      </div>
      <div class="bx-tt-metrics">
        <div class="bx-tt-metric"><div class="bx-tt-metric-label">Runtime</div><div class="bx-tt-metric-value bx-tt-runtime"></div></div>
        <div class="bx-tt-metric"><div class="bx-tt-metric-label">Tokens</div><div class="bx-tt-metric-value bx-tt-tokens"></div></div>
        <div class="bx-tt-metric"><div class="bx-tt-metric-label">Backend</div><div class="bx-tt-metric-value bx-tt-backend"></div></div>
      </div>
      <div class="bx-tt-metrics bx-tt-metrics2">
        <div class="bx-tt-metric"><div class="bx-tt-metric-label">Attempt · Round</div><div class="bx-tt-metric-value bx-tt-attempt"></div></div>
        <div class="bx-tt-metric"><div class="bx-tt-metric-label">Verdict</div><div class="bx-tt-metric-value bx-tt-verdict"></div></div>
        <div class="bx-tt-metric"><div class="bx-tt-metric-label">Files · Commits</div><div class="bx-tt-metric-value bx-tt-files"></div></div>
      </div>
      <div class="bx-tt-latest">
        <div class="bx-tt-kicker"><span data-icon="shield"></span> Latest review message</div>
        <div class="bx-tt-latest-row"><span class="bx-tt-latest-kind"></span><span class="bx-tt-latest-title"></span></div>
      </div>
      <div class="bx-tt-meta">
        <div class="bx-tt-parent-wrap">Parent · <span class="bx-tt-parent"></span></div>
        <div>Children · <span class="bx-tt-children"></span></div>
        <div>Node · <span class="bx-tt-node"></span></div>
        <div class="bx-tt-checkpoint-wrap">Checkpoint · <span class="bx-tt-checkpoint"></span></div>
        <div class="bx-tt-plugin-wrap">Plugin · <span class="bx-tt-plugin"></span></div>
        <div><span class="bx-tt-updated"></span></div>
      </div>
      <div class="bx-tt-review"></div>
      <div class="bx-tt-decision"></div>
      <div class="bx-tt-actions">
        <button class="bx-btn bx-tt-action bx-tt-details" data-icon="externalLink">Details</button>
        <button class="bx-btn bx-tt-action bx-tt-msg" data-icon="messageSquare">Message</button>
        <button class="bx-btn bx-tt-action bx-tt-stop" data-icon="stop">Stop</button>
        <button class="bx-btn bx-tt-action bx-tt-thread" data-icon="shield">Thread</button>
        <button class="bx-btn bx-tt-action bx-tt-shots" data-icon="camera">Screenshots</button>
        <button class="bx-btn bx-tt-action bx-tt-task-link" data-icon="kanban">Task</button>
        <button class="bx-btn bx-tt-action bx-follow" data-icon="target">Follow</button>
      </div>
      <form class="bx-tt-compose" hidden>
        <input class="bx-tt-compose-input" type="text" placeholder="Message this agent…" aria-label="Message this agent" />
        <button class="bx-btn bx-tt-send" type="submit" data-icon="send" aria-label="Send"></button>
      </form>
      <div class="bx-tt-note" role="status" aria-live="polite"></div>
      <div class="bx-tt-hint">Click an agent for its full timeline · Esc to close</div>
    `;
    const followBtn = tooltip.querySelector(".bx-follow") as HTMLButtonElement;
    followBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.hoveredKey) this.toggleFollow(this.hoveredKey);
    });
    (tooltip.querySelector(".bx-tt-details") as HTMLButtonElement).addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.hoveredKey) this.openFocusForAgent(this.hoveredKey);
    });
    (tooltip.querySelector(".bx-tt-close") as HTMLButtonElement).addEventListener("click", (e) => {
      e.stopPropagation();
      this.hideAgentHoverCard();
    });
    // Icons (icons.ts) into every [data-icon] slot.
    tooltip.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
      const name = el.dataset.icon as keyof typeof icons;
      const holder = document.createElement("span");
      holder.className = "bx-tt-ico";
      litRender(icons[name], holder);
      el.prepend(holder);
    });
    this.wireHoverActions(tooltip);
    tooltip.addEventListener("pointerdown", (e) => e.stopPropagation());
    // Directly on the host (not inside .bx-layer, z-index 5) so the card stacks
    // above the HUD column, coder build tags and the review layer.
    host.appendChild(tooltip);

    host.appendChild(layer);
    this.bxLayer = layer;
    this.bxFx = svg;
    this.bxCaption = caption;
    this.bxBroadcastBtn = broadcastBtn;
    this.bxTooltip = tooltip;
    this.bxFollowBtn = followBtn;
    this.bxCanvas = this.getCanvas();

    if (this.reviewLayer && !this.noOverlays) this.installDecisionHud();

    this.director = new BroadcastDirector({
      now: () => performance.now(),
      agentExists: (k) => !!this.eng()?.hasAgent?.(k),
      agentWorldPos: (k) => this.eng()?.agentWorldPos?.(k) ?? null,
      // Land the subject in the area the HUD column leaves free, not under it.
      flyTo: (x, y, scale, t) => {
        const e = this.eng();
        (e?.cameraFlyToFree ?? e?.cameraFlyTo)?.call(e, x, y, scale, t);
      },
      ambientDrift: () => this.eng()?.ambientDriftStep?.(),
      onFocus: (f) => this.applyCaption(f),
    });

    // ── CameraDirector composition point ──────────────────────────────────
    // Default-ON autofocus. Yields to BroadcastDirector and to manual pan/zoom.
    this.cameraDirector = new CameraDirector({
      now: () => performance.now(),
      agentExists: (k) => !!this.eng()?.hasAgent?.(k),
      agentWorldPos: (k) => this.eng()?.agentWorldPos?.(k) ?? null,
      // Land the subject in the area the HUD column leaves free, not under it.
      flyTo: (x, y, scale, t) => {
        const e = this.eng();
        (e?.cameraFlyToFree ?? e?.cameraFlyTo)?.call(e, x, y, scale, t);
      },
      ambientDrift: () => this.eng()?.ambientDriftStep?.(),
      getPausedUntil: () => this.fxPausedUntil,
      isBroadcastEnabled: () => !!this.director?.isEnabled(),
    });
    const afPill = this.cameraDirector.buildPill();
    if (this.hudToolbar) {
      afPill.style.cssText = "letter-spacing:0.06em;font-weight:600;";
      this.hudToolbar.appendChild(afPill);
    } else {
      afPill.style.cssText = "position:absolute;top:12px;left:148px;letter-spacing:0.06em;font-weight:600;";
      this.bxLayer?.appendChild(afPill);
    }
    this.mountSpreadPill(afPill);
    // ─────────────────────────────────────────────────────────────────────

    const target: HTMLElement = this.bxCanvas ?? host;
    target.addEventListener("wheel", this.handleFxWheel, { passive: false });
    target.addEventListener("pointerdown", this.handleFxPointerDown);
    target.addEventListener("dblclick", this.handleFxDblClick);
    target.addEventListener("contextmenu", this.handleCtxMenu);
    host.addEventListener("pointermove", this.handleFxPointerMove);
    host.addEventListener("pointerleave", this.handleFxPointerLeave);
    host.addEventListener("click", this.handleFxTap);
    window.addEventListener("keydown", this.handleHoverCardKeydown);

    let persisted = "0";
    try {
      persisted = localStorage.getItem(AgencyWorldViz.BROADCAST_KEY) ?? "0";
    } catch {
      /* storage blocked — default off */
    }
    if (persisted === "1") this.setBroadcast(true);
    this.refreshBroadcastBtn();
    this.ensureFxLoop();
  }

  private readonly handleFxWheel = (e: WheelEvent): void => {
    this.director?.notePointerInteraction();
    this.fxPausedUntil = performance.now() + 3000;
    // Apply cursor-anchored zoom directly to the pixi-viewport so the scale
    // changes synchronously. The canvas is inside shadow DOM — composed:false
    // events don't reach divWheel (document.body) where pixi-viewport listens,
    // and shadow retargeting breaks pixi-viewport's interactionDOMElement check.
    const vp = this.eng()?.getViewport?.();
    if (!vp) return;
    const rect = (this.bxCanvas ?? this.host)?.getBoundingClientRect();
    if (!rect) return;
    const MIN = (vp as any).options?.minScale ?? 0.05;
    const MAX = (vp as any).options?.maxScale ?? 10;
    const step = -e.deltaY * (e.deltaMode ? 40 : 1) / 500;
    const change = Math.pow(2, 1.1 * step);
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = vp.toWorld(sx, sy);
    const newScale = Math.min(MAX, Math.max(MIN, vp.scale.x * change));
    vp.scale.set(newScale);
    const newScreen = vp.toScreen(world.x, world.y);
    vp.x += sx - newScreen.x;
    vp.y += sy - newScreen.y;
    // Surface the new zoom synchronously so the voice HUD blob reacts on the
    // same wheel tick even if the FX loop is idle (no agents on the field).
    this.emitZoom(newScale);
    e.preventDefault();
    e.stopPropagation();
  };

  /** Broadcast viewport zoom on `infinibot:world-zoom` when it changes past an
   *  epsilon. Dispatched on `window` so cross-shadow-DOM listeners (voice HUD)
   *  can hook in without a direct reference to this element. */
  private emitZoom(scale: number): void {
    if (!Number.isFinite(scale)) return;
    if (Math.abs(scale - this.lastEmittedZoom) < 0.01) return;
    this.lastEmittedZoom = scale;
    try {
      window.dispatchEvent(
        new CustomEvent("infinibot:world-zoom", { detail: { scale } }),
      );
    } catch {
      /* dispatch unavailable — non-fatal */
    }
  }

  private readonly handleFxPointerDown = (e: PointerEvent): void => {
    this.director?.notePointerInteraction();
    this.fxPausedUntil = performance.now() + 1500;
    if (
      this.bxTooltipPinned &&
      this.bxTooltip &&
      !e.composedPath().includes(this.bxTooltip)
    ) {
      this.hideAgentHoverCard();
    }
  };

  private readonly handleFxPointerMove = (e: PointerEvent): void => {
    if (this.bxTooltipPinned || this.mobileLike) return;
    if (this.bxTooltip && e.composedPath().includes(this.bxTooltip)) return;
    const engine = this.eng();
    const vp = engine?.getViewport?.();
    if (!vp || !this.bxTooltip) return;
    const rect = (this.bxCanvas ?? this.host)?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = vp.toWorld(sx, sy);
    const key = engine.nearestAgentToWorld?.(world.x, world.y, 70);
    if (key) {
      this.hoveredKey = key;
      this.updateTooltip(key, sx, sy);
    } else if (this.hoveredKey) {
      this.hideAgentHoverCard();
    }
  };

  private readonly handleFxPointerLeave = (): void => {
    if (!this.bxTooltipPinned) this.hideAgentHoverCard();
  };

  /**
   * Phones: a tap on the canvas opens the nearest agent's card as a bottom
   * sheet. DOM-level (Pixi taps are unreliable on /mesh). Desktop keeps
   * hover + the Pixi click → focus modal.
   */
  private readonly handleFxTap = (e: MouseEvent): void => {
    if (!this.mobileLike) return;
    const target = e.composedPath()[0];
    if (!(target instanceof HTMLCanvasElement)) return;
    const engine = this.eng();
    const vp = engine?.getViewport?.();
    const rect = (this.bxCanvas ?? this.host)?.getBoundingClientRect();
    if (!vp || !rect || !this.host) return;
    // Under body `zoom`, client px and layout px differ; normalise.
    const f = this.host.clientWidth > 0 ? rect.width / this.host.clientWidth || 1 : 1;
    const sx = (e.clientX - rect.left) / f;
    const sy = (e.clientY - rect.top) / f;
    const world = vp.toWorld(sx, sy);
    const key = engine.nearestAgentToWorld?.(world.x, world.y, 70);
    if (key && this.agents.has(key)) this.showAgentHoverCard(key, true, { x: sx, y: sy });
  };

  private readonly handleHoverCardKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.hoveredKey) {
      this.hideAgentHoverCard();
      return;
    }
    // Keyboard access: with the map canvas focused, "." / "," cycle a pinned
    // card through the agents on the map (Tab then moves through its actions).
    if ((e.key === "." || e.key === ",") && this.bxCanvas && this.shadowRoot?.activeElement === this.bxCanvas) {
      const keys = [...this.agents.keys()].filter((k) => this.eng()?.hasAgent?.(k));
      if (!keys.length) return;
      const i = this.hoveredKey ? keys.indexOf(this.hoveredKey) : -1;
      const next = keys[(i + (e.key === "." ? 1 : keys.length - 1) + keys.length) % keys.length];
      this.showAgentHoverCard(next, true);
      e.preventDefault();
    }
  };

  /** Verification hook: pin the hover card on the n-th agent (or a key). */
  private installHoverHook(): void {
    (window as unknown as Record<string, unknown>).__meshHover = (which?: number | string) => {
      const keys = [...this.agents.keys()].filter((k) => this.eng()?.hasAgent?.(k));
      const key = typeof which === "string" ? which : keys[which ?? 0];
      if (key) this.showAgentHoverCard(key, true);
      return keys.length;
    };
  }

  private readonly handleFxDblClick = (e: MouseEvent): void => {
    const engine = this.eng();
    const vp = engine?.getViewport?.();
    const rect = (this.bxCanvas ?? this.host)?.getBoundingClientRect();
    if (!vp || !rect) return;
    const world = vp.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const key = engine.nearestAgentToWorld?.(world.x, world.y, 120);
    if (!key) return;
    const pos = engine.agentWorldPos?.(key);
    if (pos) engine.cameraFlyTo?.(pos.x, pos.y, 1.6, 700);
    this.director?.notePointerInteraction();
  };

  private toggleBroadcast(): void {
    this.setBroadcast(!this.director?.isEnabled());
  }

  private setBroadcast(on: boolean): void {
    this.director?.setEnabled(on);
    try {
      localStorage.setItem(AgencyWorldViz.BROADCAST_KEY, on ? "1" : "0");
    } catch {
      /* storage blocked */
    }
    this.refreshBroadcastBtn();
    if (on) this.ensureFxLoop();
  }

  private refreshBroadcastBtn(): void {
    const on = !!this.director?.isEnabled();
    this.bxBroadcastBtn?.classList.toggle("on", on);
    if (this.bxBroadcastBtn) {
      this.setPillLabel(this.bxBroadcastBtn, "📡", on ? " BROADCAST ON" : " BROADCAST");
      this.bxBroadcastBtn.setAttribute("aria-label", on ? "Broadcast camera on" : "Broadcast camera");
    }
  }

  private toggleFollow(key: string): void {
    this.followLock = this.followLock === key ? null : key;
    this.followFlyAt = 0;
    if (this.followLock) this.ensureFxLoop();
    if (this.hoveredKey === key && this.bxFollowBtn) {
      const following = this.followLock === key;
      this.setFollowLabel(following);
    }
  }

  /** Icon + text label; compact (phone) HUDs hide the text span. */
  private setPillLabel(btn: HTMLElement, icon: string, text: string): void {
    const ico = document.createElement("span");
    ico.className = "bx-pill-ico";
    ico.setAttribute("aria-hidden", "true");
    ico.textContent = icon;
    const txt = document.createElement("span");
    txt.className = "bx-pill-txt";
    txt.textContent = text;
    btn.replaceChildren(ico, txt);
  }

  /** "Spread: On/Off" pill beside Auto-focus — agents spread across every
   *  sector (engine AgentSpreadDriver) vs. the legacy home-room layout. */
  private mountSpreadPill(afterEl: HTMLElement): void {
    const eng = this.eng() as any;
    if (!eng || typeof eng.setSpreadEnabled !== "function" || !this.bxLayer) return;
    const btn = document.createElement("button");
    btn.className = "bx-btn bx-spread";
    const refresh = (on: boolean) => {
      this.setPillLabel(btn, "⇄", on ? " Spread: ON" : " Spread: OFF");
      btn.setAttribute("aria-label", on ? "Agent spread on" : "Agent spread off");
      btn.title = on
        ? "Agents work at desks across the whole office (click to keep them at home)"
        : "Agents stay in their home quarters — click to spread them across the office";
      btn.classList.toggle("on", on);
    };
    refresh(eng.isSpreadEnabled());
    btn.addEventListener("click", () => eng.setSpreadEnabled(!eng.isSpreadEnabled()));
    this.spreadUnsub = eng.onSpreadChange(refresh);
    if (this.hudToolbar) {
      // In-flow in the HUD toolbar row — wraps instead of being pixel-placed.
      this.hudToolbar.appendChild(btn);
      return;
    }
    const place = () => {
      btn.style.left = `${afterEl.offsetLeft + afterEl.offsetWidth + 8}px`;
    };
    btn.style.left = "380px";
    this.bxLayer.appendChild(btn);
    requestAnimationFrame(place);
    afterEl.addEventListener("click", () => requestAnimationFrame(place)); // its label width changes
  }

  /** Show an agent card programmatically. Mobile taps pin it as a bottom sheet. */
  public showAgentHoverCard(
    key: string,
    pinned = false,
    anchor?: { x: number; y: number },
  ): void {
    const fallback = {
      x: (this.host?.clientWidth ?? 0) / 2,
      y: (this.host?.clientHeight ?? 0) / 2,
    };
    const point = anchor ?? this.eng()?.agentScreenPos?.(key) ?? fallback;
    this.hoveredKey = key;
    this.bxTooltipPinned = pinned;
    this.updateTooltip(key, point.x, point.y);
    if (pinned && this.bxTooltip) {
      this.bxTooltip.tabIndex = -1;
      requestAnimationFrame(() => this.bxTooltip?.focus({ preventScroll: true }));
    }
  }

  private hideAgentHoverCard(): void {
    this.hoveredKey = null;
    this.bxTooltipPinned = false;
    this.bxTooltipAnchor = null;
    this.bxTooltip?.classList.remove("show", "is-pinned", "is-mobile");
  }

  private setHoverText(selector: string, value: string): void {
    const el = this.bxTooltip?.querySelector(selector);
    if (el && el.textContent !== value) el.textContent = value;
  }

  private setFollowLabel(following: boolean): void {
    const fb = this.bxFollowBtn;
    if (!fb) return;
    let label = fb.querySelector(".bx-tt-follow-label");
    if (!label) {
      for (const n of [...fb.childNodes]) if (n.nodeType === Node.TEXT_NODE) n.remove();
      label = document.createElement("span");
      label.className = "bx-tt-follow-label";
      fb.appendChild(label);
    }
    label.textContent = following ? "Following" : "Follow";
    fb.classList.toggle("on", following);
  }

  private hoverNote(text: string, tone: "ok" | "err" = "ok"): void {
    const el = this.bxTooltip?.querySelector(".bx-tt-note") as HTMLElement | null;
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = tone;
  }

  /** Hover-card quick actions: message, stop, thread, screenshots, kanban task. */
  private wireHoverActions(tt: HTMLElement): void {
    const q = <T extends HTMLElement>(sel: string) => tt.querySelector(sel) as T;
    const agentOf = () => (this.hoveredKey ? this.agents.get(this.hoveredKey) : undefined);
    const compose = q<HTMLFormElement>(".bx-tt-compose");
    const input = q<HTMLInputElement>(".bx-tt-compose-input");
    q<HTMLButtonElement>(".bx-tt-msg").addEventListener("click", (e) => {
      e.stopPropagation();
      compose.hidden = !compose.hidden;
      if (!compose.hidden) {
        this.bxTooltipPinned = true;
        tt.classList.add("is-pinned");
        input.focus();
      }
    });
    compose.addEventListener("submit", (e) => {
      e.preventDefault();
      const a = agentOf();
      const text = input.value.trim();
      if (!a || !text || !this.client) return;
      this.hoverNote("Sending…");
      void sendAgentMessage(this.client, a, text).then((r) => {
        if (!r.ok) this.hoverNote(r.error || "Message not delivered", "err");
        else {
          this.hoverNote("Message sent");
          input.value = "";
          compose.hidden = true;
        }
      });
    });
    q<HTMLButtonElement>(".bx-tt-stop").addEventListener("click", (e) => {
      e.stopPropagation();
      const a = agentOf();
      if (!a || !this.client) return;
      if (!confirm(`Stop ${a.label || a.sessionKey}?`)) return;
      this.hoverNote("Stopping…");
      void stopAgent(this.client, a).then((r) => (r.ok ? this.hoverNote("Stop requested") : this.hoverNote(r.error || "Stop failed", "err")));
    });
    q<HTMLButtonElement>(".bx-tt-thread").addEventListener("click", (e) => {
      e.stopPropagation();
      const a = agentOf();
      if (a?.runId) this.reviewMesh?.openThread(a.runId);
    });
    q<HTMLButtonElement>(".bx-tt-shots").addEventListener("click", (e) => {
      e.stopPropagation();
      const a = agentOf();
      if (a?.runId) this.reviewMesh?.openScreenshots(a.runId);
    });
    q<HTMLButtonElement>(".bx-tt-task-link").addEventListener("click", (e) => {
      e.stopPropagation();
      const taskId = agentOf()?.kanbanTaskId;
      if (!taskId) return;
      window.dispatchEvent(new CustomEvent("infinibot:kanban-open-task", { detail: { taskId } }));
      try {
        const basePath = inferBasePathFromPathname(window.location.pathname);
        window.history.pushState({}, "", pathForTab("projects" as Tab, basePath));
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch {
        /* navigation best-effort */
      }
    });
  }

  /** Fill the review/lineage rows and gate the quick actions for agent `a`. */
  private applyHoverExtras(tt: HTMLElement, a: MeshAgent): void {
    const feed = this.reviewMesh?.feed ?? null;
    const thread = a.runId && feed ? feed.store.get(a.runId) ?? null : null;
    const record = feed ? feed.completed.find((r) => (a.runId && r.runId === a.runId) || r.childSessionKey === a.sessionKey) ?? null : null;
    const x = buildHoverExtras(a, { now: Date.now(), agents: this.agents.values(), thread, record });
    this.setHoverText(".bx-tt-role", x.role);
    this.setHoverText(".bx-tt-activity-age", x.activityAge ? ` · ${x.activityAge}` : "");
    this.setHoverText(".bx-tt-attempt", x.attemptRound);
    this.setHoverText(".bx-tt-verdict", x.verdict);
    (tt.querySelector(".bx-tt-verdict") as HTMLElement | null)?.style.setProperty("color", x.verdictColor);
    this.setHoverText(".bx-tt-files", `${x.files} · ${x.commits}`);
    this.setHoverText(".bx-tt-parent", x.parent ?? "none");
    this.setHoverText(".bx-tt-children", String(x.children));
    const latest = tt.querySelector(".bx-tt-latest") as HTMLElement | null;
    if (latest) {
      latest.style.display = x.latest ? "" : "none";
      if (x.latest) {
        this.setHoverText(".bx-tt-latest-kind", x.latest.kind);
        this.setHoverText(".bx-tt-latest-title", x.latest.title);
        (tt.querySelector(".bx-tt-latest-kind") as HTMLElement).style.setProperty("--k", x.latest.color);
      }
    }
    const shots = a.runId && feed ? feed.screenshots.some((s) => s.runId === a.runId) : false;
    const gate = (sel: string, ok: boolean, why: string) => {
      const b = tt.querySelector(sel) as HTMLButtonElement | null;
      if (!b) return;
      b.disabled = !ok;
      b.title = ok ? "" : why;
    };
    gate(".bx-tt-msg", Boolean(this.client), "Not connected");
    gate(".bx-tt-stop", Boolean(this.client) && x.running, "Not running");
    gate(".bx-tt-thread", Boolean(a.runId && this.reviewMesh), "No review thread for this agent");
    gate(".bx-tt-shots", shots, "No screenshots for this run");
    gate(".bx-tt-task-link", Boolean(x.kanbanTaskId), "No kanban task linked");
  }

  private updateTooltip(key: string, sx: number, sy: number): void {
    const a = this.agents.get(key);
    const tt = this.bxTooltip;
    if (!tt || !a) return;
    this.bxTooltipAnchor = { x: sx, y: sy };
    const model = buildAgentHoverCardModel(a, this.nodes.get(a.nodeId), this.reviewCache.get(key));
    tt.dataset.tone = model.tone;
    tt.classList.toggle("is-pinned", this.bxTooltipPinned);
    tt.classList.toggle("is-mobile", this.mobileLike);
    this.setHoverText(".bx-tt-name", model.name);
    this.setHoverText(".bx-tt-id", model.runId ? `${model.agentId} · ${model.runId.slice(0, 8)}` : model.agentId);
    this.setHoverText(".bx-tt-status", model.statusLabel);
    this.setHoverText(".bx-tt-task", model.task);
    this.setHoverText(".bx-tt-activity-value", model.activity);
    this.setHoverText(".bx-tt-progress-value", `${Math.round(model.progress)}%`);
    this.setHoverText(".bx-tt-runtime", model.runtime);
    this.setHoverText(".bx-tt-tokens", model.tokens);
    this.setHoverText(".bx-tt-backend", model.backend);
    this.setHoverText(".bx-tt-node", model.node);
    this.setHoverText(".bx-tt-checkpoint", model.checkpoint ?? "—");
    this.setHoverText(".bx-tt-plugin", model.plugin ?? "Core");
    this.setHoverText(".bx-tt-updated", model.updated);
    this.applyHoverExtras(tt, a);
    const fill = tt.querySelector(".bx-tt-fill") as HTMLElement | null;
    if (fill) fill.style.width = `${model.progress}%`;
    const logo = tt.querySelector(".bx-tt-logo") as HTMLImageElement | null;
    if (logo) {
      logo.title = model.backend;
      logo.src = providerLogoUrl(providerLogoFor(a.coderBackend ?? a.model), true);
    }
    const review = this.reviewCache.get(key);
    const ttRev = tt.querySelector(".bx-tt-review") as HTMLElement | null;
    if (ttRev) {
      if (review) {
        const summarySnip = model.review?.slice(0, 120) || `Review status: ${model.reviewStatus || "available"}`;
        ttRev.textContent = summarySnip;
        ttRev.style.display = "";
      } else {
        ttRev.style.display = "none";
      }
    }
    this.renderAgentDecisionPanel(tt, a);
    const fb = this.bxFollowBtn;
    if (fb) {
      const following = this.followLock === key;
      this.setFollowLabel(following);
      fb.classList.toggle("on", following);
    }
    tt.classList.add("show");
    requestAnimationFrame(() => {
      if (!this.host || !this.bxTooltip || this.hoveredKey !== key) return;
      // Anchor to the agent's sprite ∪ name tag (not the raw pointer) and
      // keep clear of other name tags + floor signs, flipping as needed.
      const geo = this.eng()?.hoverCardGeometry?.(key) as
        | { anchor: { x: number; y: number; width: number; height: number } | null; obstacles: Array<{ x: number; y: number; width: number; height: number }> }
        | undefined;
      const place = placeAgentHoverCard({
        anchorX: sx,
        anchorY: sy,
        hostWidth: this.host.clientWidth,
        hostHeight: this.host.clientHeight,
        cardWidth: this.bxTooltip.offsetWidth,
        cardHeight: this.bxTooltip.offsetHeight,
        mobile: this.mobileLike,
        anchorRect: geo?.anchor ?? null,
        obstacles: geo?.obstacles,
      });
      this.bxTooltip.style.left = `${Math.round(place.left)}px`;
      this.bxTooltip.style.top = `${Math.round(place.top)}px`;
    });
  }

  private actionForTool(kind?: string, label?: string): string {
    if (label) return label.length > 40 ? label.slice(0, 38) + "…" : label;
    return kind ? `running ${kind}` : "working";
  }

  private escapeHtml(s: string): string {
    return s.replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
    );
  }

  private applyCaption(f: FocusInfo | null): void {
    const cap = this.bxCaption;
    if (!cap) return;
    if (f && f.caption) {
      cap.innerHTML = `<span class="bx-live">● LIVE</span>${this.escapeHtml(f.caption)}`;
      cap.classList.add("show");
    } else {
      cap.classList.remove("show");
    }
  }

  /** Forward a camera beat to both the BroadcastDirector and the CameraDirector. */
  private forwardBeat(ev: BroadcastEvent): void {
    this.director?.noteEvent(ev);
    this.cameraDirector?.noteEvent(ev as CameraEvent);
  }

  /** Map a coalesced WorldEvent batch into broadcast beats + highlight pulses. */
  private noteWorldEvents(events: WorldEvent[]): void {
    if (!this.director && !this.cameraDirector) return;
    const now = performance.now();
    for (const e of events) {
      switch (e.kind) {
        case "agent.tool": {
          const a: any = this.agents.get(e.sessionKey);
          this.forwardBeat({
            kind: "tool",
            sessionKey: e.sessionKey,
            agentName: a?.name,
            action: this.actionForTool(e.tool?.kind, e.tool?.label),
            target: a?.repo || a?.project || a?.cwd,
            toolKind: e.tool?.kind,
            ts: now,
          });
          this.addPulse(e.sessionKey, now);
          break;
        }
        case "agent.spawn": {
          const a: any = e.agent;
          // Restored resting (finished) agents aren't a spawn beat.
          if (a?.status === "completed" || a?.status === "failed") break;
          this.forwardBeat({
            kind: "spawn",
            sessionKey: a.sessionKey,
            agentName: a?.name,
            action: "spawned",
            target: a?.repo || a?.project,
            ts: now,
          });
          this.addPulse(a.sessionKey, now);
          break;
        }
        case "agent.progress": {
          const prev = this.lastStatusByKey.get(e.sessionKey);
          const next = (e.patch as any)?.status as string | undefined;
          if (next) {
            const wasIdle = !prev || prev === "idle" || prev === "queued";
            const isActive = next === "running" || next === "active" || next === "working";
            if (wasIdle && isActive) this.addPulse(e.sessionKey, now);
            this.lastStatusByKey.set(e.sessionKey, next);
          }
          break;
        }
        case "agent.complete": {
          const a: any = this.agents.get(e.sessionKey);
          this.forwardBeat({
            kind: "complete",
            sessionKey: e.sessionKey,
            agentName: a?.name,
            success: e.success,
            target: a?.repo || a?.project,
            ts: now,
          });
          this.addPulse(e.sessionKey, now);
          this.lastStatusByKey.set(e.sessionKey, e.success ? "completed" : "failed");
          break;
        }
        case "fed.peer.connect":
        case "fed.msg.send": {
          const peer =
            (e as any).peerNodeId || (e as any).toNodeId || (e as any).fromNodeId;
          // No agent subject — point the camera at the federation atrium so the
          // hop reads cinematically instead of leaving the camera parked.
          const atrium = this.eng()?.getSectorCenter?.("command-atrium");
          this.forwardBeat({
            kind: "fed-hop",
            action: "federation hop",
            target: this.nodes.get(peer)?.name || peer,
            worldX: atrium?.x,
            worldY: atrium?.y,
            focusScale: 0.95,
            ts: now,
          });
          break;
        }
      }
    }
    this.ensureFxLoop();
  }

  /** Register a district-tinted highlight pulse over an agent's position. */
  private addPulse(key: string, now: number): void {
    if (this.mobileLike && this.pulses.length > 6) return;
    const pos = this.eng()?.agentWorldPos?.(key);
    let color = "#7dd3fc";
    if (pos) color = accentCss(this.eng()?.sectorIdAtWorld?.(pos.x, pos.y));
    this.pulses = this.pulses.filter((p) => p.key !== key);
    this.pulses.push({ key, born: now, ttl: 1400, color });
    if (this.pulses.length > 24) this.pulses.splice(0, this.pulses.length - 24);
  }

  private ensureFxLoop(): void {
    if (this.fxLoop != null || !this.panelVisible || this.suspended) return;
    this.fxLoop = rafLoop(() => {
      if (!this.panelVisible || !this.renderFx()) this.stopFxLoop();
    });
  }

  private stopFxLoop(): void {
    this.fxLoop?.cancel();
    this.fxLoop = null;
  }

  /** Per-frame overlay render. Returns true while there's anything live to draw. */
  private renderFx(): boolean {
    const svg = this.bxFx;
    const engine = this.eng();
    const vp = engine?.getViewport?.();
    if (!svg || !vp) return false;
    const t0 = performance.now();

    // ── Broadcast viewport zoom on change ─────────────────────────────────────
    // The FX loop already runs every frame while agents exist, so this is a
    // free, naturally RAF-throttled place to surface the mesh zoom factor.
    // Emitted only when the scale moves past an epsilon so listeners (the voice
    // HUD blob's zoom-dock behavior) aren't woken every frame.
    this.emitZoom(vp.scale.x);

    // ── Time-scrub replay drive ───────────────────────────────────────────────
    // <world-timeline-scrubber> publishes the scrubbed timestamp on
    // window.__worldReplayFrame (non-null ⇒ replay). Hand it to the engine, which
    // freezes live motion and pins every sprite to its historical position.
    // Clearing it (Live) resumes live motion.
    const replay = (window as Window & { __worldReplayFrame?: { t: number } | null }).__worldReplayFrame;
    if (replay && typeof replay.t === "number") engine.setReplayTime?.(replay.t);
    else if (engine.isReplaying?.()) engine.resumeLive?.();

    this.director?.tick();
    this.cameraDirector?.tick();

    if (this.followLock) {
      if (!engine.hasAgent?.(this.followLock)) {
        this.followLock = null;
      } else if (t0 - this.followFlyAt > 600) {
        const p = engine.agentWorldPos?.(this.followLock);
        if (p) engine.cameraFlyTo?.(p.x, p.y, 1.5, 650);
        this.followFlyAt = t0;
      }
    }

    const svgNS = "http://www.w3.org/2000/svg";
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Layout engine: idle-bob + active-orbit halos + compact-mode overlay.
    // Drawn FIRST so the ambient underglow halos sit at the bottom of the SVG
    // paint order — every event burst (pulses, review badges, follow reticle)
    // and the sprite itself read on top of them.
    runLayoutTick(this.agents, engine as any, svg, t0);

    this.pulses = this.pulses.filter((p) => t0 - p.born < p.ttl);
    for (const p of this.pulses) {
      const pos = engine.agentWorldPos?.(p.key);
      if (!pos) continue;
      const s = vp.toScreen(pos.x, pos.y);
      const k = (t0 - p.born) / p.ttl;
      const halo = document.createElementNS(svgNS, "circle");
      halo.setAttribute("cx", String(s.x));
      halo.setAttribute("cy", String(s.y));
      halo.setAttribute("r", String(16 + 6 * k));
      halo.setAttribute("fill", p.color);
      halo.setAttribute("opacity", String(0.18 * (1 - k)));
      svg.appendChild(halo);
      const r1 = document.createElementNS(svgNS, "circle");
      r1.setAttribute("cx", String(s.x));
      r1.setAttribute("cy", String(s.y));
      r1.setAttribute("r", String(14 + 30 * k));
      r1.setAttribute("fill", "none");
      r1.setAttribute("stroke", p.color);
      r1.setAttribute("stroke-width", "2");
      r1.setAttribute("opacity", String(0.55 * (1 - k)));
      svg.appendChild(r1);
      const k2 = (k - 0.25) / 0.75;
      if (k2 > 0 && !this.mobileLike) {
        const r2 = document.createElementNS(svgNS, "circle");
        r2.setAttribute("cx", String(s.x));
        r2.setAttribute("cy", String(s.y));
        r2.setAttribute("r", String(14 + 30 * k2));
        r2.setAttribute("fill", "none");
        r2.setAttribute("stroke", p.color);
        r2.setAttribute("stroke-width", "1.5");
        r2.setAttribute("opacity", String(0.4 * (1 - k2)));
        svg.appendChild(r2);
      }
    }

    // ── Review badges — clickable status badge above each agent with a review.
    // Mirrors the oversight page data (status colour + blocker flag) and opens
    // the agent's focus panel on click, like clicking the sprite itself.
    if (this.reviewCache.size > 0) {
      const BADGE_COLORS: Record<string, string> = {
        completed: "#22c55e",
        partial: "#f59e0b",
        errored: "#ef4444",
        aborted: "#6b7280",
      };
      for (const [sk, review] of this.reviewCache) {
        const agent = this.agents.get(sk);
        if (!agent) continue;
        const pos = engine.agentWorldPos?.(sk);
        if (!pos) continue;
        const s = vp.toScreen(pos.x, pos.y);
        const bx = s.x + 14;
        const by = s.y - 22;
        const status: string = review?.status ?? "aborted";
        const color = BADGE_COLORS[status] ?? "#6b7280";
        const blockerCount = Array.isArray(review?.blockers)
          ? review.blockers.length
          : (review?.blockers_count ?? 0);
        const g = document.createElementNS(svgNS, "g");
        // Opt the badge back into pointer events (the bx-fx SVG is pointer-events:none).
        g.setAttribute("style", "pointer-events:auto;cursor:pointer;");
        const glow = document.createElementNS(svgNS, "circle");
        glow.setAttribute("cx", String(bx));
        glow.setAttribute("cy", String(by));
        glow.setAttribute("r", "6");
        glow.setAttribute("fill", color);
        glow.setAttribute("opacity", "0.25");
        g.appendChild(glow);
        const dot = document.createElementNS(svgNS, "circle");
        dot.setAttribute("cx", String(bx));
        dot.setAttribute("cy", String(by));
        dot.setAttribute("r", "4");
        dot.setAttribute("fill", color);
        dot.setAttribute("opacity", "0.92");
        g.appendChild(dot);
        // Blocker flag — a small red ring around the dot mirrors the oversight
        // page's "has blockers" indicator so it reads at a glance on the mesh.
        if (blockerCount > 0) {
          const ring = document.createElementNS(svgNS, "circle");
          ring.setAttribute("cx", String(bx));
          ring.setAttribute("cy", String(by));
          ring.setAttribute("r", "7.5");
          ring.setAttribute("fill", "none");
          ring.setAttribute("stroke", "#ef4444");
          ring.setAttribute("stroke-width", "1.5");
          ring.setAttribute("opacity", "0.9");
          g.appendChild(ring);
        }
        // Transparent hit target so the whole badge area is clickable.
        const hit = document.createElementNS(svgNS, "circle");
        hit.setAttribute("cx", String(bx));
        hit.setAttribute("cy", String(by));
        hit.setAttribute("r", "11");
        hit.setAttribute("fill", "transparent");
        g.appendChild(hit);
        const tip = blockerCount > 0
          ? `Review: ${status} · ${blockerCount} blocker${blockerCount === 1 ? "" : "s"} — open focus panel`
          : `Review: ${status} — open focus panel`;
        const title = document.createElementNS(svgNS, "title");
        title.textContent = tip;
        g.appendChild(title);
        g.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          this.openFocusForAgent(sk);
        });
        svg.appendChild(g);
      }
    }

    const subject = this.followLock ?? this.director?.getCurrentSubject() ?? null;
    if (subject) {
      const pos = engine.agentWorldPos?.(subject);
      if (pos) {
        const s = vp.toScreen(pos.x, pos.y);
        const color = this.followLock ? "#fbbf24" : accentCss(engine.sectorIdAtWorld?.(pos.x, pos.y));
        const rot = (t0 / 14) % 360;
        const g = document.createElementNS(svgNS, "g");
        g.setAttribute("transform", `translate(${s.x} ${s.y}) rotate(${rot})`);
        const ring = document.createElementNS(svgNS, "circle");
        ring.setAttribute("r", "26");
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", color);
        ring.setAttribute("stroke-width", "2");
        ring.setAttribute("stroke-dasharray", "10 8");
        ring.setAttribute("opacity", "0.9");
        g.appendChild(ring);
        for (const a of [0, 90, 180, 270]) {
          const rad = (a * Math.PI) / 180;
          const tick = document.createElementNS(svgNS, "line");
          tick.setAttribute("x1", String(Math.cos(rad) * 30));
          tick.setAttribute("y1", String(Math.sin(rad) * 30));
          tick.setAttribute("x2", String(Math.cos(rad) * 38));
          tick.setAttribute("y2", String(Math.sin(rad) * 38));
          tick.setAttribute("stroke", color);
          tick.setAttribute("stroke-width", "2");
          tick.setAttribute("opacity", "0.9");
          g.appendChild(tick);
        }
        svg.appendChild(g);
      }
    }

    const cost = performance.now() - t0;
    this.fxCostEwma = this.fxCostEwma * 0.9 + cost * 0.1;
    try {
      (window as any).__worldFxCost = this.fxCostEwma;
    } catch {
      /* ignore */
    }

    return !!(this.director?.isEnabled() || this.cameraDirector?.isEnabled() || this.followLock || this.pulses.length > 0 || this.agents.size > 0 || this.reviewCache.size > 0 || engine.isReplaying?.() || (window as Window & { __worldReplayFrame?: unknown }).__worldReplayFrame);
  }

  // ── Review / oversight methods ────────────────────────────────────────────

  private async pollReviews(): Promise<void> {
    if (!this.client) return;
    try {
      const res = await (this.client as any).request("subagent_reviews_list", { limit: 50 }) as any;
      const reviews: any[] = res?.reviews ?? [];
      for (const r of reviews) {
        const sk = r.sessionKey ?? r.session_key;
        if (sk) this.reviewCache.set(sk, r);
      }
      if (this.hoveredKey && this.bxTooltipAnchor) {
        this.updateTooltip(this.hoveredKey, this.bxTooltipAnchor.x, this.bxTooltipAnchor.y);
      }
      if (reviews.length) this.ensureFxLoop();
    } catch {
      // RPC not available yet — silently retry next tick
    }
  }

  private readonly handleCtxMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const engine = this.eng();
    const vp = engine?.getViewport?.();
    const rect = (this.bxCanvas ?? this.host)?.getBoundingClientRect();
    if (!vp || !rect) return;
    const world = vp.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const nearKey = engine?.nearestAgentToWorld?.(world.x, world.y, 90);
    this.ctxMenuTarget = nearKey ?? null;
    this.buildCtxMenu(e.clientX, e.clientY, nearKey ?? null);
  };

  private buildCtxMenu(cx: number, cy: number, sessionKey: string | null): void {
    this.destroyCtxMenu();
    const menu = document.createElement("div");
    menu.style.cssText = `
      position:fixed;left:${cx}px;top:${cy}px;z-index:99999;
      background:rgba(10,14,26,0.96);border:1px solid rgba(255,255,255,0.14);
      border-radius:8px;padding:4px 0;min-width:190px;
      font-family:"JetBrains Mono","SF Mono",monospace;font-size:12px;
      backdrop-filter:blur(8px);box-shadow:0 4px 24px rgba(0,0,0,0.5);
    `;
    const addItem = (label: string, fn: () => void, dim = false) => {
      const item = document.createElement("div");
      item.style.cssText = `padding:7px 14px;cursor:pointer;color:${dim ? "#71717a" : "#e4e4e7"};transition:background 0.1s;`;
      item.textContent = label;
      item.addEventListener("mouseenter", () => { item.style.background = "rgba(255,255,255,0.07)"; });
      item.addEventListener("mouseleave", () => { item.style.background = ""; });
      item.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); fn(); this.destroyCtxMenu(); });
      menu.appendChild(item);
    };
    const addSep = () => {
      const sep = document.createElement("div");
      sep.style.cssText = "margin:3px 0;border-top:1px solid rgba(255,255,255,0.08);";
      menu.appendChild(sep);
    };

    if (sessionKey) {
      const review = this.reviewCache.get(sessionKey);
      addItem("Spawn 3 review passes", () => void this.doSpawnReviewPasses(sessionKey, 3));
      addItem("Force re-review", () => void this.doForceReview(sessionKey));
      addSep();
      if (review) {
        addItem("Open review →", () => this.doOpenOversight(review.runId ?? review.run_id ?? sessionKey));
      } else {
        addItem("No review yet", () => {}, true);
      }
    } else {
      addItem("Bulk review last 5 completions", () => void this.doBulkReview(5));
    }

    document.body.appendChild(menu);
    this.ctxMenu = menu;
    const dismiss = (ev: PointerEvent) => {
      if (!menu.contains(ev.target as Node)) {
        this.destroyCtxMenu();
        document.removeEventListener("pointerdown", dismiss);
      }
    };
    setTimeout(() => document.addEventListener("pointerdown", dismiss), 0);
  }

  private destroyCtxMenu(): void {
    this.ctxMenu?.remove();
    this.ctxMenu = null;
  }

  private async doSpawnReviewPasses(sessionKey: string, n: number): Promise<void> {
    if (!this.client) return;
    const agent = this.agents.get(sessionKey);
    const runId = (agent as any)?.runId ?? sessionKey;
    const ANGLES = ["correctness", "security", "UX & usability"];
    await Promise.all(
      Array.from({ length: Math.min(n, ANGLES.length) }, (_, i) =>
        (this.client as any).request("sessions.spawn", {
          task: `Independently review sub-agent run ${runId} from the ${ANGLES[i]} angle. Check quality, edge cases, and correctness. Return findings as structured JSON.`,
          agentId: "coder",
          label: `Review · ${ANGLES[i]} · ${String(runId).slice(0, 8)}`,
        }).catch(() => null)
      )
    );
  }

  private async doForceReview(sessionKey: string): Promise<void> {
    if (!this.client) return;
    const agent = this.agents.get(sessionKey);
    const runId = (agent as any)?.runId ?? sessionKey;
    try {
      await (this.client as any).request("subagent_review_force", { runId });
      setTimeout(() => void this.pollReviews(), 2000);
    } catch { /* ignore */ }
  }

  /** Open the slide-in focus panel for an agent (same payload as a sprite click). */
  private openFocusForAgent(sessionKey: string): void {
    const agent = this.agents.get(sessionKey);
    const open = (window as unknown as { openAgentFocus?: (t: unknown) => void }).openAgentFocus;
    if (typeof open === "function") open(agent ?? { sessionKey });
    this.dispatchEvent(
      new CustomEvent("agency-agent-select", {
        detail: {
          sessionKey,
          agent: agent ?? { sessionKey },
          review: this.reviewCache.get(sessionKey) ?? null,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private doOpenOversight(runId: string): void {
    this.dispatchEvent(new CustomEvent("agency-open-oversight", {
      detail: { runId },
      bubbles: true,
      composed: true,
    }));
  }

  private async doBulkReview(n: number): Promise<void> {
    if (!this.client) return;
    const completed = Array.from(this.agents.values())
      .filter((a) => a.status === "completed" && !this.reviewCache.has(a.sessionKey))
      .slice(-n);
    await Promise.all(
      completed.map((a) => {
        const runId = (a as any).runId ?? a.sessionKey;
        return (this.client as any).request("subagent_review_force", { runId }).catch(() => null);
      })
    );
    setTimeout(() => void this.pollReviews(), 2000);
  }

  private teardownBroadcast(): void {
    this.stopFxLoop();
    const target: HTMLElement | null = this.bxCanvas ?? this.host;
    if (target) {
      target.removeEventListener("wheel", this.handleFxWheel);
      target.removeEventListener("pointerdown", this.handleFxPointerDown);
      target.removeEventListener("dblclick", this.handleFxDblClick);
      target.removeEventListener("contextmenu", this.handleCtxMenu);
    }
    this.destroyCtxMenu();
    if (this.host) {
      this.host.removeEventListener("pointermove", this.handleFxPointerMove);
      this.host.removeEventListener("pointerleave", this.handleFxPointerLeave);
      this.host.removeEventListener("click", this.handleFxTap);
    }
    window.removeEventListener("keydown", this.handleHoverCardKeydown);
    this.director?.destroy();
    this.director = null;
    this.cameraDirector?.destroy();
    this.cameraDirector = null;
    this.spreadUnsub?.();
    this.spreadUnsub = null;
    this.bxLayer?.remove();
    this.bxLayer = null;
    this.bxTooltip?.remove();
    this.hudStatsTimer?.cancel();
    this.hudStatsTimer = null;
    this.hudResizeObs?.disconnect();
    this.hudResizeObs = null;
    this.hudEl?.remove();
    this.hudEl = null;
    this.hudToolbar = null;
    this.hudStatsEl = null;
    this.hudDetailsToggle = null;
    this.decisionChip = null;
    this.decisionList = null;
    this.bxFx = null;
    this.bxCaption = null;
    this.bxBroadcastBtn = null;
    this.bxTooltip = null;
    this.bxFollowBtn = null;
    this.bxCanvas = null;
    this.pulses = [];
    this.followLock = null;
    this.hideAgentHoverCard();
    this.lastStatusByKey.clear();
  }

  private fmtReplayClock(t: number): string {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** Badge click → ask the scrubber to drop back to Live. The scrubber owns the
   *  replay mode (it re-publishes __worldReplayFrame each frame), so we can't
   *  just clear the global here; we fire an event it listens for. */
  private readonly resumeLiveFromBadge = (): void => {
    window.dispatchEvent(new CustomEvent("world-resume-live"));
  };

  override render() {
    return html`
      <div class="host"></div>
      ${this.replayClock
        ? html`<button
            class="replay-badge"
            title="Replaying past activity — click to return to live"
            @click=${this.resumeLiveFromBadge}
          >
            ▶ REPLAY @ ${this.replayClock}
          </button>`
        : null}
      ${this.mountError
        ? html`
            <div class="error-overlay">
              <div class="error-msg">Failed to initialise: ${this.mountError.message}</div>
              <button class="retry-btn" @click=${this.retryMount}>Retry</button>
            </div>`
        : this.reconnecting
          ? html`<div class="empty">Reconnecting…</div>`
          : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agency-world-viz": AgencyWorldViz;
  }
}
