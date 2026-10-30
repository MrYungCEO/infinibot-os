/**
 * <mesh-world-3d> — the 3D Agent Mesh.
 *
 * Renders the SAME MeshWorldModel the 2D iso map is fed from (owned by
 * <agency-world-viz>, or by the mobile embed), so both views show every agent,
 * sub-agent/coder run, session, plugin building and federation node at the
 * same live state. This module is lazy-loaded (with three.js) only when the
 * owner picks 3D.
 *
 * Interaction: orbit / pan / zoom (mouse + touch), click an agent → side panel
 * (live task, progress, last activity; Details / Message / Stop / Follow /
 * Task — the 2D hover card's actions), click a building → plugin details,
 * hover tooltips, search + focus, follow camera, cinematic orbit, minimap,
 * reset view, activity ticker and keyboard shortcuts (press ? for the list).
 *
 * Emits `mesh3d-fallback` ({ reason }) when WebGL is unavailable or the
 * context is lost, so the host can drop back to 2D.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { icons } from "../../icons";
import { webglAvailable } from "../../lib/glow3d";
import type { MeshAgent } from "../../views/agent-ops/activity-map";
import { buildAgentHoverCardModel } from "../../views/agent-ops/agent-hover-card";
import {
  agentIsRunning,
  navigateToTab,
  openAgentDetails,
  openAgentTask,
  sendAgentMessage,
  stopAgent,
} from "../../views/agent-ops/mesh-agent-actions";
import type { MeshWorldLayout, MeshWorldModel, WorldEffect, WorldZone } from "../../views/agent-ops/mesh-world-model";
import { isTabAvailable } from "../../plugin-host";
import type { QualityMode } from "./quality";
import { AgentPanelLayer, agentPanelStyles, type PanelData } from "./agent-panels";
import { ACTIVITY_LABEL, MeshWorldScene, STATE_COLOR } from "./world-scene";
import { parseColor, type ThemeTokens } from "./world-theme";

export interface Mesh3DActions {
  /** Open the 2D map's Agent Focus panel. Returns false when it isn't mounted (the 3D panel shows instead). */
  openAgent(agent: MeshAgent): boolean | void;
  message(agent: MeshAgent, text: string): Promise<{ ok: boolean; error?: string }>;
  stop(agent: MeshAgent): Promise<{ ok: boolean; error?: string }>;
  openTask?(taskId: string): void;
  openZone(zone: WorldZone): void;
  canOpenZone?(zone: WorldZone): boolean;
}

/** Web actions: the same helpers the 2D hover card uses. */
export function webActions(client: unknown): Mesh3DActions {
  return {
    openAgent: (a) => openAgentDetails(a),
    message: (a, t) => sendAgentMessage(client, a, t),
    stop: (a) => stopAgent(client, a),
    openTask: (id) => openAgentTask(id),
    openZone: (z) => {
      if (z.openTab && isTabAvailable(z.openTab)) navigateToTab(z.openTab);
    },
    canOpenZone: (z) => !!z.openTab && isTabAvailable(z.openTab),
  };
}

const QUALITY_KEY = "infinibot.mesh3d.quality";
const MINIMAP_KEY = "infinibot.mesh3d.minimap";
const HUD_KEY = "infinibot.mesh3d.hud";
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");

/** Resolve any CSS colour (var(), color-mix(), named) to rgb via a probe element. */
function resolveCssColor(value: string, probe: HTMLElement): string | null {
  const v = value.trim();
  if (!v) return null;
  if (parseColor(v) != null) return v;
  probe.style.color = "";
  probe.style.color = v;
  if (!probe.style.color) return null;
  return getComputedStyle(probe).color || null;
}

/** The user's appearance theme as world tokens: data-theme + --g-primary / --g-accent. */
export function readThemeTokens(root: HTMLElement = document.documentElement, probe?: HTMLElement): ThemeTokens {
  const cs = getComputedStyle(root);
  const el = probe ?? document.createElement("span");
  const attach = !probe;
  if (attach) {
    el.style.display = "none";
    document.body.appendChild(el);
  }
  try {
    const primary = resolveCssColor(cs.getPropertyValue("--g-primary"), el) ?? resolveCssColor(cs.getPropertyValue("--c-accent"), el);
    const secondary = resolveCssColor(cs.getPropertyValue("--g-accent"), el);
    return { mode: root.dataset.theme ?? "dark", primary, secondary };
  } finally {
    if (attach) el.remove();
  }
}

function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

const BACKEND_MONO: Record<string, string> = { "claude-code": "CL", codex: "CX", opencode: "OC", gemini: "GE" };

interface TickerItem {
  id: number;
  text: string;
  tone: string;
  key?: string;
}

@customElement("mesh-world-3d")
export class MeshWorld3D extends LitElement {
  @property({ attribute: false }) model: MeshWorldModel | null = null;
  @property({ attribute: false }) actions: Mesh3DActions | null = null;
  /** Phone layout (bottom sheet, smaller minimap, conservative quality). */
  @property({ type: Boolean }) mobile = false;

  @state() private selected: string | null = null;
  @state() private zoneSel: string | null = null;
  @state() private following: string | null = null;
  @state() private tooltip: { x: number; y: number; title: string; sub: string; tone: string; below: boolean } | null = null;
  /** Phone HUD details (stats, ticker, minimap) expanded. */
  @state() private hudOpen = true;
  /** The Agent Focus modal opened for the selection (3D panel stays hidden). */
  @state() private focusOpened = false;
  @state() private searchQ = "";
  @state() private searchOpen = false;
  @state() private ticker: TickerItem[] = [];
  @state() private quality: QualityMode = "auto";
  @state() private tierLabel = "";
  @state() private fps = 0;
  @state() private counts = { agents: 0, working: 0, plugins: 0, nodes: 0 };
  @state() private minimap = true;
  @state() private help = false;
  @state() private cinematic = false;
  @state() private composeOpen = false;
  @state() private note: { text: string; err?: boolean } | null = null;
  @state() private failed: string | null = null;

  @query(".stage") private stageEl!: HTMLDivElement;
  @query(".mm") private mmCanvas!: HTMLCanvasElement;
  @query(".search input") private searchInput!: HTMLInputElement;

  private scene: MeshWorldScene | null = null;
  private layout: MeshWorldLayout | null = null;
  private lastFx = 0;
  private unsub: (() => void) | null = null;
  private syncRaf = 0;
  private lastSync = 0;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private hudTimer: ReturnType<typeof setInterval> | null = null;
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private onScreen = true;
  private mql: MediaQueryList | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private tickerSeq = 0;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private panels: AgentPanelLayer | null = null;
  private panelLayerEl: HTMLElement | null = null;
  private panelTimer: ReturnType<typeof setInterval> | null = null;
  private themeObs: MutationObserver | null = null;
  private themeProbe: HTMLSpanElement | null = null;
  /** Recent tool / lifecycle beats per agent (expanded panel history). */
  private readonly recent = new Map<string, Array<{ text: string; at: number }>>();
  /** Desktop: the classic side panel (compose) is open for the selection. */
  @state() private sheetOpen = false;

  static override styles = [agentPanelStyles, css`
    :host {
      position: relative;
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #030305;
      color: #ece6d6;
      font-family: Inter, "Space Grotesk", system-ui, sans-serif;
      --gold: var(--g-primary, #d4af37);
      --glass: color-mix(in srgb, #0b0b0d 78%, transparent);
      --line: color-mix(in srgb, var(--gold) 30%, transparent);
      contain: strict;
    }
    .stage {
      position: absolute;
      inset: 0;
    }
    .stage canvas {
      outline: none;
    }
    /* Depth: a soft vignette over the world (no GPU cost). */
    .vignette {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      background: radial-gradient(120% 95% at 50% 45%, transparent 55%, rgba(2, 2, 4, 0.55) 100%);
    }
    .glass {
      background: var(--glass);
      border: 1px solid var(--line);
      border-radius: 10px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
    }
    button {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 30px;
      padding: 5px 9px;
      border-radius: 7px;
      color: #ece6d6;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s, transform 0.12s;
    }
    button:hover,
    button:focus-visible {
      background: color-mix(in srgb, var(--gold) 16%, transparent);
      color: var(--gold);
    }
    button:active {
      transform: scale(0.96);
    }
    button[aria-pressed="true"] {
      background: color-mix(in srgb, var(--gold) 22%, transparent);
      color: var(--gold);
    }
    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    button svg,
    .ico svg {
      width: 15px;
      height: 15px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.8;
      flex: none;
    }
    .toolbar {
      position: absolute;
      top: 10px;
      right: 10px;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      z-index: 4;
    }
    .search {
      position: relative;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 8px;
      border-right: 1px solid var(--line);
      margin-right: 2px;
    }
    .search input {
      all: unset;
      width: 150px;
      font-size: 12px;
      padding: 6px 0;
      color: #f4efe2;
    }
    .search input::placeholder {
      color: rgba(236, 230, 214, 0.45);
    }
    .results {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      width: 260px;
      max-height: 300px;
      overflow: auto;
      padding: 4px;
    }
    .results button {
      display: flex;
      width: 100%;
      text-transform: none;
      letter-spacing: 0;
      font-size: 12.5px;
      justify-content: flex-start;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex: none;
      box-shadow: 0 0 8px currentColor;
      background: currentColor;
    }
    .stats {
      position: absolute;
      left: 10px;
      bottom: 46px;
      display: flex;
      gap: 12px;
      padding: 6px 10px;
      font-size: 10.5px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: rgba(236, 230, 214, 0.8);
      z-index: 3;
      font-variant-numeric: tabular-nums;
    }
    .stats b {
      color: var(--gold);
      font-weight: 700;
    }
    .ticker {
      position: absolute;
      left: 10px;
      right: 200px;
      bottom: 10px;
      height: 30px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 10px;
      overflow: hidden;
      z-index: 3;
      mask-image: linear-gradient(90deg, #000 85%, transparent);
    }
    .ticker .live {
      color: var(--gold);
      font-size: 10px;
      letter-spacing: 0.16em;
      font-weight: 700;
      flex: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tick {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: rgba(236, 230, 214, 0.86);
      cursor: pointer;
      animation: tickIn 0.45s ease-out;
    }
    .tick + .tick::before {
      content: "";
      width: 3px;
      height: 3px;
      border-radius: 50%;
      background: var(--line);
      margin-right: 4px;
    }
    @keyframes tickIn {
      from {
        opacity: 0;
        transform: translateX(-14px);
      }
    }
    .mm-wrap {
      position: absolute;
      right: 10px;
      bottom: 10px;
      padding: 5px;
      z-index: 3;
    }
    .mm {
      display: block;
      width: 176px;
      height: 176px;
      border-radius: 7px;
      cursor: crosshair;
    }
    .panel {
      position: absolute;
      top: 56px;
      right: 10px;
      width: 330px;
      max-height: calc(100% - 120px);
      overflow: auto;
      padding: 14px;
      z-index: 5;
      animation: panelIn 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    @keyframes panelIn {
      from {
        opacity: 0;
        transform: translateX(18px);
      }
    }
    .panel h3 {
      margin: 0 26px 2px 0;
      font-size: 16px;
      font-weight: 650;
      color: #f6f0de;
      word-break: break-word;
    }
    .panel .sub {
      font-size: 11.5px;
      color: rgba(236, 230, 214, 0.62);
      margin-bottom: 10px;
    }
    .panel .close {
      position: absolute;
      top: 8px;
      right: 8px;
      min-height: 26px;
      padding: 4px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 10.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      border: 1px solid currentColor;
    }
    .task {
      margin: 10px 0 8px;
      font-size: 13px;
      line-height: 1.45;
      color: #efe8d6;
    }
    .bar {
      height: 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      overflow: hidden;
      margin: 6px 0 10px;
    }
    .bar i {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, #a8862a, var(--gold), #f5d77a);
      box-shadow: 0 0 12px var(--gold);
      transition: width 0.6s ease;
    }
    dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 5px 12px;
      margin: 0 0 12px;
      font-size: 12px;
    }
    dt {
      color: rgba(236, 230, 214, 0.5);
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 0.12em;
      padding-top: 2px;
    }
    dd {
      margin: 0;
      color: #efe8d6;
      word-break: break-word;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .actions button {
      border: 1px solid var(--line);
    }
    .compose {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .compose input {
      all: unset;
      flex: 1;
      font-size: 12.5px;
      padding: 7px 9px;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: #f4efe2;
    }
    .note {
      margin-top: 8px;
      font-size: 12px;
      color: var(--gold);
    }
    .note.err {
      color: #f87171;
    }
    .occ {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-bottom: 12px;
    }
    .occ button {
      text-transform: none;
      letter-spacing: 0;
      font-size: 12.5px;
      justify-content: flex-start;
    }
    .tooltip {
      position: absolute;
      z-index: 6;
      pointer-events: none;
      padding: 7px 10px;
      font-size: 12px;
      width: max-content;
      max-width: 260px;
    }
    .tooltip strong {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #f6f0de;
      font-weight: 600;
    }
    .tooltip span {
      display: block;
      color: rgba(236, 230, 214, 0.68);
      margin-top: 2px;
    }
    .help {
      position: absolute;
      inset: 0;
      margin: auto;
      width: min(420px, calc(100% - 32px));
      height: fit-content;
      padding: 18px;
      z-index: 7;
      font-size: 12.5px;
    }
    .help h3 {
      margin: 0 0 10px;
      color: var(--gold);
      font-size: 13px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    .help kbd {
      display: inline-block;
      min-width: 20px;
      text-align: center;
      padding: 2px 6px;
      margin-right: 6px;
      border: 1px solid var(--line);
      border-radius: 5px;
      font-family: "JetBrains Mono", ui-monospace, monospace;
      font-size: 11px;
      color: var(--gold);
    }
    .help div {
      padding: 3px 0;
    }
    .follow-badge {
      position: absolute;
      top: 56px;
      left: 50%;
      transform: translateX(-50%);
      padding: 5px 12px;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--gold);
      z-index: 4;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .failed {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: rgba(236, 230, 214, 0.7);
      font-size: 13px;
    }
    .hud-toggle {
      display: none;
    }
    :host([mobile]) .toolbar {
      top: auto;
      bottom: 8px;
      right: 8px;
      left: 8px;
      justify-content: space-between;
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      padding: 2px;
    }
    :host([mobile]) .toolbar button {
      min-height: 34px;
      min-width: 34px;
      padding: 5px 7px;
      justify-content: center;
    }
    :host([mobile]) .hud-toggle {
      display: inline-flex;
    }
    :host([mobile]) .search {
      padding: 0 4px;
    }
    :host([mobile]) .search input {
      width: 74px;
    }
    :host([mobile]) .toolbar .lbl,
    :host([mobile]) .toolbar .kbd-help {
      display: none;
    }
    :host([mobile]) .panel {
      padding: 12px;
    }
    :host([mobile]) .panel dl {
      grid-template-columns: auto 1fr auto 1fr;
      gap: 4px 10px;
      margin-bottom: 10px;
    }
    :host([mobile]) .panel .actions button {
      padding: 5px 8px;
    }
    :host([mobile]) .panel {
      top: auto;
      left: 8px;
      right: 8px;
      bottom: 56px;
      width: auto;
      max-height: 46%;
      background: color-mix(in srgb, #0b0b0d 94%, transparent);
      animation-name: sheetIn;
    }
    @keyframes sheetIn {
      from {
        opacity: 0;
        transform: translateY(24px);
      }
    }
    :host([mobile]) .mm {
      width: 92px;
      height: 92px;
    }
    :host([mobile]) .mm-wrap {
      top: 52px;
      bottom: auto;
      right: 8px;
      padding: 3px;
    }
    :host([mobile]) .ticker {
      right: 8px;
      left: 8px;
      bottom: 54px;
      height: 26px;
    }
    :host([mobile]) .stats {
      bottom: auto;
      top: 52px;
      left: 8px;
      right: auto;
      max-width: calc(100% - 120px);
      flex-wrap: wrap;
      gap: 2px 8px;
      padding: 4px 8px;
      font-size: 9.5px;
    }
    :host([mobile]) .follow-badge {
      top: 52px;
    }
    :host([mobile][hud-collapsed]) .stats,
    :host([mobile][hud-collapsed]) .ticker,
    :host([mobile][hud-collapsed]) .mm-wrap {
      display: none;
    }
    :host([mobile]) .results {
      top: auto;
      bottom: calc(100% + 8px);
    }
    /* Light appearance theme: light glass chrome over the porcelain world. */
    :host-context([data-theme="light"]) {
      background: #dcd8cf;
      color: #22201c;
      --glass: color-mix(in srgb, #faf9f5 84%, transparent);
    }
    :host-context([data-theme="light"]) .glass {
      box-shadow: 0 8px 26px rgba(40, 34, 20, 0.14);
    }
    :host-context([data-theme="light"]) button,
    :host-context([data-theme="light"]) .search input,
    :host-context([data-theme="light"]) .tick,
    :host-context([data-theme="light"]) .stats,
    :host-context([data-theme="light"]) .task,
    :host-context([data-theme="light"]) .panel h3 {
      color: #26241f;
    }
    :host-context([data-theme="light"]) .search input::placeholder,
    :host-context([data-theme="light"]) .panel .sub,
    :host-context([data-theme="light"]) dt {
      color: rgba(40, 38, 34, 0.55);
    }
    :host-context([data-theme="light"]) .vignette {
      background: radial-gradient(120% 95% at 50% 45%, transparent 60%, rgba(120, 110, 90, 0.18) 100%);
    }
    @media (prefers-reduced-motion: reduce) {
      .panel,
      .tick {
        animation: none;
      }
    }
  `];

  // ── lifecycle ──

  override connectedCallback(): void {
    super.connectedCallback();
    try {
      const q = localStorage.getItem(QUALITY_KEY);
      if (q === "auto" || q === "high" || q === "medium" || q === "low") this.quality = q;
      this.minimap = localStorage.getItem(MINIMAP_KEY) !== "off";
      // Phones start with the HUD details collapsed: the map comes first.
      const hud = localStorage.getItem(HUD_KEY);
      this.hudOpen = hud ? hud === "open" : !this.mobile;
    } catch {
      /* storage unavailable */
    }
    window.addEventListener("keydown", this.onKey);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  override firstUpdated(): void {
    this.mount();
  }

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("mobile") && !changed.get("mobile") && this.mobile) {
      try {
        if (!localStorage.getItem(HUD_KEY)) this.hudOpen = false;
      } catch {
        this.hudOpen = false;
      }
    }
    this.toggleAttribute("hud-collapsed", !this.hudOpen);
  }

  override updated(changed: PropertyValues): void {
    if (changed.has("model") && this.scene) this.bindModel();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.teardown();
  }

  private mount(): void {
    if (this.scene || this.failed) return;
    if (!webglAvailable()) {
      this.fail("webgl-unavailable");
      return;
    }
    this.mql = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    try {
      this.scene = new MeshWorldScene(
        { container: this.stageEl, mobile: this.mobile, reducedMotion: !!this.mql?.matches, quality: this.quality, theme: this.themeTokens() },
        {
          onFrame: () => this.placePanels(),
          onAgentHover: (key, pt) => this.hoverAgent(key, pt),
          onZoneHover: (id, pt) => this.hoverZone(id, pt),
          onAgentClick: (key) => this.selectAgent(key, true, true),
          onZoneClick: (id) => this.selectZone(id),
          onTierChange: () => this.refreshHud(),
          onFollowEnd: () => (this.following = null),
          onReset: () => {
            this.selectAgent(null);
            this.zoneSel = null;
            this.tooltip = null;
          },
        },
      );
    } catch (err) {
      console.warn("[mesh-world-3d] WebGL init failed", err);
      this.fail("webgl-init-failed");
      return;
    }
    this.mql?.addEventListener?.("change", this.onMotionPref);
    this.stageEl.addEventListener("mesh3d-context-lost", this.onContextLost);
    this.ro = new ResizeObserver(() => this.scene?.resize());
    this.ro.observe(this);
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) this.onScreen = e.isIntersecting;
      this.applyActive();
    });
    this.io.observe(this);
    const layer = this.renderRoot.querySelector(".ap-layer") as HTMLElement | null;
    if (layer) {
      this.panels = new AgentPanelLayer(layer, {
        data: (key) => this.panelData(key),
        hover: (key) => this.scene?.setPanelHover(key),
        select: (key) => this.selectAgent(key, true),
        open: (key) => {
          const a = this.model?.agents.get(key);
          if (a && this.actions?.openAgent(a) !== true) {
            this.selectAgent(key);
            this.sheetOpen = true;
          }
        },
        focus: (key) => {
          this.selectAgent(key, true);
          this.toggleFollow(key);
        },
        stop: (key) => {
          const a = this.model?.agents.get(key);
          if (a) void this.doStop(a);
        },
        message: (key) => {
          this.selectAgent(key);
          this.sheetOpen = true;
          this.composeOpen = true;
        },
        task: (key) => {
          const a = this.model?.agents.get(key);
          if (a?.kanbanTaskId) this.actions?.openTask?.(a.kanbanTaskId);
        },
        measured: (box) => this.scene?.setPanelBox(box),
      });
      this.panelTimer = setInterval(() => this.panels?.refresh(), 1000);
    }
    // Follow the user's appearance theme live (palette picker, light / dark / hud).
    this.themeObs = new MutationObserver(() => this.scene?.setTheme(this.themeTokens()));
    this.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-theme-mode", "data-palette", "style", "class"] });
    this.bindModel();
    this.scene.resetView(0);
    this.resyncTimer = setInterval(() => this.scheduleSync(), 2500);
    this.hudTimer = setInterval(() => this.refreshHud(), 500);
    this.exposeProbe();
  }

  private teardown(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.syncRaf) cancelAnimationFrame(this.syncRaf);
    this.syncRaf = 0;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    if (this.resyncTimer) clearInterval(this.resyncTimer);
    this.resyncTimer = null;
    if (this.hudTimer) clearInterval(this.hudTimer);
    this.hudTimer = null;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.ro?.disconnect();
    this.ro = null;
    this.themeObs?.disconnect();
    this.themeObs = null;
    this.themeProbe?.remove();
    this.themeProbe = null;
    if (this.panelTimer) clearInterval(this.panelTimer);
    this.panelTimer = null;
    this.panels?.clear();
    this.panels = null;
    this.panelLayerEl = null;
    this.io?.disconnect();
    this.io = null;
    this.mql?.removeEventListener?.("change", this.onMotionPref);
    this.mql = null;
    this.stageEl?.removeEventListener("mesh3d-context-lost", this.onContextLost);
    this.scene?.dispose();
    this.scene = null;
    this.layout = null;
    const w = window as unknown as { __mesh3d?: unknown };
    if ((w.__mesh3d as { el?: unknown } | undefined)?.el === this) delete w.__mesh3d;
  }

  private themeTokens(): ThemeTokens {
    try {
      if (!this.themeProbe) {
        this.themeProbe = document.createElement("span");
        this.themeProbe.style.display = "none";
        this.themeProbe.setAttribute("aria-hidden", "true");
        document.body.appendChild(this.themeProbe);
      }
      return readThemeTokens(document.documentElement, this.themeProbe);
    } catch {
      return {};
    }
  }

  /** Move the HTML overlay panels to where the scene put them this frame. */
  private placePanels(): void {
    if (!this.panels || !this.scene) return;
    // Canvas px → layer CSS px (an ancestor may apply CSS zoom).
    const layer = this.panelLayerEl ??= this.renderRoot.querySelector(".ap-layer") as HTMLElement | null;
    const cw = this.scene.glow.size.w;
    const k = layer && cw > 2 && layer.clientWidth ? layer.clientWidth / cw : 1;
    this.panels.update(this.scene.panelAnchors(), Math.abs(k - 1) < 0.01 ? 1 : k);
  }

  private stateTone(state: keyof typeof STATE_COLOR): string {
    return hex((this.scene?.palette.state ?? STATE_COLOR)[state]);
  }

  /** Live content for one agent's overlay panel. */
  private panelData(key: string): PanelData | null {
    const a = this.model?.agents.get(key);
    if (!a) return null;
    const placed = this.layout?.agents.find((p) => p.key === key);
    const card = buildAgentHoverCardModel(a, this.model?.nodes.get(a.nodeId), null);
    const act = this.scene?.agentActivity(key);
    const zone = placed ? this.layout?.zones.find((z) => z.id === placed.zoneId) : undefined;
    const now = Date.now();
    const tool = placed?.tool?.label || a.activityLabel || (typeof a.lastActivity?.label === "string" ? a.lastActivity.label : "") || "";
    const end = a.endedAt ?? now;
    const progress = typeof a.progress === "number" && a.progress > 0 ? (a.progress <= 1 ? a.progress * 100 : a.progress) : null;
    return {
      name: card.name,
      stateLabel: card.statusLabel,
      tone: this.stateTone(placed?.state ?? "idle"),
      activity: act ? ACTIVITY_LABEL[act] : "",
      task: a.currentTask || "",
      tool: tool.slice(0, 80),
      progress,
      elapsed: a.startedAt ? fmtElapsed(end - a.startedAt) : "—",
      backend: a.coderBackend ? BACKEND_MONO[a.coderBackend] ?? "" : "",
      zone: zone?.name ?? "",
      recent: (this.recent.get(key) ?? []).slice(0, 4).map((r) => ({ text: r.text, ago: fmtAgo(now - r.at) })),
      running: agentIsRunning(a),
      following: this.following === key,
      canTask: !!a.kanbanTaskId && !!this.actions?.openTask,
    };
  }

  private fail(reason: string): void {
    this.failed = reason;
    this.dispatchEvent(new CustomEvent("mesh3d-fallback", { detail: { reason }, bubbles: true, composed: true }));
  }

  private readonly onContextLost = (): void => {
    this.teardown();
    this.fail("webgl-context-lost");
  };

  private readonly onMotionPref = (): void => this.scene?.setReducedMotion(!!this.mql?.matches);

  private readonly onVisibility = (): void => this.applyActive();

  private applyActive(): void {
    this.scene?.setActive(this.onScreen && document.visibilityState !== "hidden");
  }

  private bindModel(): void {
    this.unsub?.();
    this.unsub = null;
    const m = this.model;
    if (!m || !this.scene) return;
    this.lastFx = m.lastEffectId;
    this.unsub = m.subscribe(() => this.scheduleSync());
    this.sync();
  }

  /** Coalesce model changes: at most ~8 layout passes per second. */
  private scheduleSync(): void {
    if (this.syncRaf || this.syncTimer) return;
    const wait = Math.max(0, 120 - (performance.now() - this.lastSync));
    const go = () => {
      this.syncTimer = null;
      this.syncRaf = requestAnimationFrame(() => {
        this.syncRaf = 0;
        this.sync();
      });
    };
    if (wait > 0) this.syncTimer = setTimeout(go, wait);
    else go();
  }

  private sync(): void {
    const m = this.model;
    const scene = this.scene;
    if (!m || !scene) return;
    this.lastSync = performance.now();
    this.layout = m.layout();
    scene.setLayout(this.layout);
    const fx = m.effectsSince(this.lastFx);
    if (fx.length) {
      this.lastFx = fx[fx.length - 1].id;
      scene.playEffects(fx);
      this.pushTicker(fx);
    }
    const c = m.counts();
    this.counts = { agents: c.agents, working: c.working, plugins: c.plugins, nodes: c.nodes };
    if (this.selected && !m.agents.has(this.selected)) this.selected = null;
    if (this.zoneSel && !this.layout.zones.some((z) => z.id === this.zoneSel)) this.zoneSel = null;
    this.requestUpdate();
    this.drawMinimap();
  }

  /** Tell the scene where HUD chrome sits so labels never slide under it. */
  private syncLabelAvoid(): void {
    if (!this.scene) return;
    const host = this.getBoundingClientRect();
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const sel of [".toolbar", ".stats", ".ticker", ".mm-wrap", ".panel", ".follow-badge"]) {
      const el = this.renderRoot.querySelector(sel) as HTMLElement | null;
      if (!el || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) rects.push({ x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height });
    }
    // The page's own 2D/3D pill floats over the top-left corner.
    rects.push({ x: 0, y: 0, w: this.mobile ? 150 : 240, h: 48 });
    this.scene.setLabelAvoid(rects);
  }

  private refreshHud(): void {
    this.syncLabelAvoid();
    const s = this.scene?.stats();
    if (!s) return;
    this.fps = s.continuous ? Math.round(s.fps) : 0;
    this.tierLabel = s.tier;
    this.cinematic = this.scene?.autoRotating ?? false;
    this.drawMinimap();
  }

  // ── ticker ──

  private agentName(key: string): string {
    const a = this.model?.agents.get(key);
    return (a?.label || a?.agentId || key.split(":").pop() || key).slice(0, 28);
  }

  private pushTicker(fx: readonly WorldEffect[]): void {
    const items: TickerItem[] = [];
    const pal = this.scene?.palette;
    const accent = hex(pal?.accent ?? STATE_COLOR.working);
    const note = (key: string, text: string) => {
      const list = this.recent.get(key) ?? [];
      list.unshift({ text: text.slice(0, 60), at: Date.now() });
      if (list.length > 6) list.length = 6;
      this.recent.set(key, list);
    };
    for (const e of fx) {
      if (e.kind === "tool") note(e.key, e.label || e.tool);
      else if (e.kind === "complete") note(e.key, e.success ? "Finished" : "Failed");
      else if (e.kind === "spawn") note(e.key, "Joined the mesh");
      let text = "";
      let tone = accent;
      let key: string | undefined;
      switch (e.kind) {
        case "spawn":
          text = `${this.agentName(e.key)} joined`;
          key = e.key;
          break;
        case "complete":
          text = `${this.agentName(e.key)} ${e.success ? "finished" : "failed"}`;
          tone = this.stateTone(e.success ? "done" : "error");
          key = e.key;
          break;
        case "tool":
          text = `${this.agentName(e.key)} · ${e.label || e.tool}`;
          key = e.key;
          break;
        case "message":
          text = `${this.agentName(e.from)} → ${this.agentName(e.to)}`;
          tone = hex(pal?.tint ?? 0xc9d3e0);
          break;
        case "federation":
          text = `Federation ${e.type} · ${e.nodeId}`;
          tone = e.type === "fail" ? this.stateTone("error") : hex(pal?.accentHi ?? 0xf5d77a);
          break;
        case "task":
          text = `New task · ${e.title}`;
          break;
        default:
          continue;
      }
      items.push({ id: ++this.tickerSeq, text: text.slice(0, 64), tone, key });
    }
    if (items.length) this.ticker = [...items.reverse(), ...this.ticker].slice(0, 10);
  }

  // ── selection / hover ──

  private hoverAgent(key: string | null, pt: { x: number; y: number } | null): void {
    // Desktop: the agent's overlay panel expands on hover instead of a tooltip.
    if (!this.mobile && this.panels) {
      this.tooltip = null;
      return;
    }
    if (!key || !pt) {
      this.tooltip = null;
      return;
    }
    const a = this.model?.agents.get(key);
    if (!a) return;
    const card = buildAgentHoverCardModel(a, this.model?.nodes.get(a.nodeId), null);
    const act = this.scene?.agentActivity(key);
    // Below the agent's feet: the name tag sits above the head, so they never overlap.
    const feet = this.scene?.agentFeetScreen(key) ?? pt;
    this.tooltip = {
      x: feet.x,
      y: feet.y + 14,
      below: true,
      title: card.name,
      sub: `${act ? ACTIVITY_LABEL[act] + " · " : ""}${card.statusLabel} · ${card.activity}`.slice(0, 96),
      tone: this.toneOf(a),
    };
  }

  private hoverZone(id: string | null, pt: { x: number; y: number } | null): void {
    if (!id || !pt) {
      this.tooltip = null;
      return;
    }
    const z = this.layout?.zones.find((zz) => zz.id === id);
    if (!z) return;
    this.tooltip = {
      x: pt.x,
      y: pt.y + 22,
      below: true,
      title: z.name,
      sub: `${z.subtitle} · ${z.occupants} agent${z.occupants === 1 ? "" : "s"}${z.kind === "plugin" ? " · click for details" : ""}`,
      tone: hex(this.scene?.palette.accent ?? z.accent),
    };
  }

  private toneOf(a: MeshAgent): string {
    const st = this.layout?.agents.find((p) => p.key === a.sessionKey)?.state ?? "idle";
    return this.stateTone(st);
  }

  selectAgent(key: string | null, fly = false, openFocus = false): void {
    this.selected = key;
    this.zoneSel = null;
    this.composeOpen = false;
    this.note = null;
    this.focusOpened = false;
    if (key) this.tooltip = null;
    this.scene?.select(key);
    if (key && fly) this.scene?.flyToAgent(key, 10, this.mobile ? 0.28 : 0);
    this.searchOpen = false;
    if (this.focusTimer) clearTimeout(this.focusTimer);
    this.focusTimer = null;
    // Clicking an agent in the world opens the same Agent Focus panel as the
    // 2D map once the camera has arrived; the 3D panel is the fallback.
    if (!key) this.sheetOpen = false;
    if (key && openFocus && this.actions && (this.mobile || !this.panels)) {
      this.focusTimer = setTimeout(() => {
        this.focusTimer = null;
        const a = this.selected === key ? this.model?.agents.get(key) : undefined;
        if (a && this.actions?.openAgent(a) === true) this.focusOpened = true;
      }, fly ? 720 : 0);
    }
  }

  private selectZone(id: string): void {
    this.zoneSel = id;
    this.tooltip = null;
    this.selected = null;
    this.scene?.select(null);
    this.scene?.flyToZone(id);
  }

  private toggleFollow(key?: string | null): void {
    const k = key ?? this.selected;
    if (!this.scene) return;
    if (this.following && (!k || this.following === k)) {
      this.scene.setFollow(null);
      this.following = null;
      return;
    }
    if (!k) return;
    this.scene.setFollow(k);
    this.following = k;
  }

  private setQuality(mode: QualityMode): void {
    this.quality = mode;
    this.scene?.setQuality(mode);
    try {
      localStorage.setItem(QUALITY_KEY, mode);
    } catch {
      /* ignore */
    }
    this.refreshHud();
  }

  private cycleQuality(): void {
    const order: QualityMode[] = ["auto", "high", "medium", "low"];
    this.setQuality(order[(order.indexOf(this.quality) + 1) % order.length]);
  }

  private toggleMinimap(): void {
    this.minimap = !this.minimap;
    try {
      localStorage.setItem(MINIMAP_KEY, this.minimap ? "on" : "off");
    } catch {
      /* ignore */
    }
    void this.updateComplete.then(() => this.drawMinimap());
  }

  private toggleCinematic(): void {
    if (!this.scene) return;
    this.scene.setAutoRotate(!this.scene.autoRotating);
    this.cinematic = this.scene.autoRotating;
  }

  private flash(text: string, err = false): void {
    this.note = { text, err };
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => (this.note = null), 4000);
  }

  // ── keyboard ──

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.scene || !this.isConnected || !this.onScreen) return;
    const path = e.composedPath();
    const typing = path.some((n) => n instanceof HTMLElement && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.isContentEditable));
    if (typing) {
      if (e.key === "Escape") (path[0] as HTMLElement).blur?.();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    switch (k) {
      case "r":
      case "R":
        this.scene.resetView();
        break;
      case "f":
      case "F":
        this.toggleFollow();
        break;
      case "c":
      case "C":
        this.toggleCinematic();
        break;
      case "m":
      case "M":
        this.toggleMinimap();
        break;
      case "/":
        this.searchInput?.focus();
        this.searchOpen = true;
        break;
      case "?":
        this.help = !this.help;
        break;
      case "Escape":
        if (this.help) this.help = false;
        else if (this.following) this.toggleFollow(null);
        else if (this.selected || this.zoneSel) {
          this.selectAgent(null);
          this.zoneSel = null;
        } else handled = false;
        break;
      case "+":
      case "=":
        this.scene.zoomBy(0.8);
        break;
      case "-":
      case "_":
        this.scene.zoomBy(1.25);
        break;
      case "ArrowLeft":
        this.scene.panBy(-1, 0);
        break;
      case "ArrowRight":
        this.scene.panBy(1, 0);
        break;
      case "ArrowUp":
        this.scene.panBy(0, -1);
        break;
      case "ArrowDown":
        this.scene.panBy(0, 1);
        break;
      case "q":
      case "Q":
        this.scene.orbitBy(0.25);
        break;
      case "e":
      case "E":
        this.scene.orbitBy(-0.25);
        break;
      case "n":
      case "N":
      case "p":
      case "P": {
        const keys = this.layout?.agents.map((a) => a.key) ?? [];
        if (!keys.length) break;
        const i = this.selected ? keys.indexOf(this.selected) : -1;
        const next = keys[(i + (k.toLowerCase() === "n" ? 1 : keys.length - 1) + keys.length) % keys.length];
        this.selectAgent(next, true);
        break;
      }
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  // ── minimap ──

  private drawMinimap(): void {
    if (!this.minimap || !this.layout || !this.scene) return;
    const cv = this.mmCanvas;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = cv.clientWidth || 176;
    if (cv.width !== Math.round(size * dpr)) {
      cv.width = Math.round(size * dpr);
      cv.height = Math.round(size * dpr);
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const b = this.layout.bounds;
    const pad = 2;
    const span = Math.max(b.maxC - b.minC, b.maxR - b.minR) + pad * 2;
    const k = (size * dpr) / span;
    const ox = -b.minC + pad + (span - pad * 2 - (b.maxC - b.minC)) / 2;
    const oy = -b.minR + pad + (span - pad * 2 - (b.maxR - b.minR)) / 2;
    const X = (c: number) => (c + ox) * k;
    const Y = (r: number) => (r + oy) * k;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = this.scene.palette.mode === "light" ? "rgba(244,242,236,0.9)" : "rgba(5,5,8,0.85)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (const z of this.layout.zones) {
      const zc = hex(this.scene.palette.accent);
      ctx.fillStyle = zc + (z.kind === "plugin" ? "40" : z.busy ? "38" : "18");
      ctx.strokeStyle = zc + (z.busy ? "cc" : "70");
      ctx.lineWidth = dpr;
      ctx.fillRect(X(z.c) + dpr, Y(z.r) + dpr, z.w * k - 2 * dpr, z.h * k - 2 * dpr);
      ctx.strokeRect(X(z.c) + dpr, Y(z.r) + dpr, z.w * k - 2 * dpr, z.h * k - 2 * dpr);
    }
    for (const p of this.scene.positions()) {
      const sel = p.key === this.selected;
      ctx.fillStyle = sel ? "#ffffff" : this.stateTone(p.state);
      ctx.beginPath();
      ctx.arc(X(p.x + 12), Y(p.z + 12), (sel ? 3 : 1.8) * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    const v = this.scene.view();
    const vx = X(v.x + 12);
    const vy = Y(v.z + 12);
    const r = Math.max(6 * dpr, (v.distance * 0.45) * k);
    ctx.strokeStyle = "#f5d77a";
    ctx.lineWidth = 1.4 * dpr;
    ctx.beginPath();
    ctx.arc(vx, vy, r, -v.azimuth - Math.PI / 2 - 0.6, -v.azimuth - Math.PI / 2 + 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(vx, vy, 2.5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "#f5d77a";
    ctx.fill();
  }

  private onMinimapClick(e: PointerEvent): void {
    if (!this.layout || !this.scene) return;
    const cv = this.mmCanvas;
    const rect = cv.getBoundingClientRect();
    const b = this.layout.bounds;
    const pad = 2;
    const span = Math.max(b.maxC - b.minC, b.maxR - b.minR) + pad * 2;
    const k = rect.width / span;
    const ox = -b.minC + pad + (span - pad * 2 - (b.maxC - b.minC)) / 2;
    const oy = -b.minR + pad + (span - pad * 2 - (b.maxR - b.minR)) / 2;
    const c = (e.clientX - rect.left) / k - ox;
    const r = (e.clientY - rect.top) / k - oy;
    this.scene.lookAtGround(c - 12, r - 12);
  }

  // ── test / perf probe ──

  private exposeProbe(): void {
    const el = this;
    (window as unknown as { __mesh3d?: unknown }).__mesh3d = {
      el,
      stats: () => el.scene?.stats() ?? null,
      agentKeys: () => el.scene?.agentKeys() ?? [],
      zoneIds: (kind?: "core" | "plugin" | "island") => el.scene?.zoneIds(kind) ?? [],
      agentScreen: (key: string) => el.scene?.agentScreen(key) ?? null,
      zoneScreen: (id: string) => el.scene?.zoneScreen(id) ?? null,
      select: (key: string) => el.selectAgent(key, true),
      click: (key: string) => el.selectAgent(key, true, true),
      activity: (key: string) => el.scene?.agentActivity(key) ?? null,
      agentFeetScreen: (key: string) => el.scene?.agentFeetScreen(key) ?? null,
      setQuality: (m: QualityMode) => el.setQuality(m),
      setAutoRotate: (on: boolean) => el.scene?.setAutoRotate(on),
      resetView: () => el.scene?.resetView(0),
      selected: () => el.selected,
      zoneSelected: () => el.zoneSel,
    };
  }

  // ── render ──

  private searchResults(): Array<{ key: string; name: string; tone: string; sub: string }> {
    const q = this.searchQ.trim().toLowerCase();
    if (!q || !this.layout) return [];
    const out: Array<{ key: string; name: string; tone: string; sub: string }> = [];
    for (const p of this.layout.agents) {
      const a = p.agent;
      const hay = `${a.label} ${a.agentId} ${a.currentTask ?? ""} ${a.sessionKey} ${a.runId ?? ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
      out.push({ key: p.key, name: a.label || a.agentId || p.key, tone: this.stateTone(p.state), sub: p.state });
      if (out.length >= 12) break;
    }
    return out;
  }

  private renderAgentPanel() {
    const key = this.selected;
    const a = key ? this.model?.agents.get(key) : undefined;
    if (!a || !this.actions || this.focusOpened) return nothing;
    if (!this.mobile && this.panels && !this.sheetOpen) return nothing;
    const card = buildAgentHoverCardModel(a, this.model?.nodes.get(a.nodeId), null);
    const tone = this.toneOf(a);
    const placed = this.layout?.agents.find((p) => p.key === a.sessionKey);
    const zone = placed ? this.layout?.zones.find((z) => z.id === placed.zoneId) : undefined;
    const running = agentIsRunning(a);
    const act = this.actions;
    return html`
      <aside class="panel glass" role="dialog" aria-label="Agent ${card.name}" data-testid="mesh3d-agent-panel">
        <button class="close" title="Close (Esc)" aria-label="Close" @click=${() => (this.mobile || !this.panels ? this.selectAgent(null) : (this.sheetOpen = false))}>${icons.x}</button>
        <h3>${card.name}</h3>
        <div class="sub">${card.agentId} · ${card.node}</div>
        <span class="chip" style="color:${tone}"><span class="dot"></span>${card.statusLabel}</span>
        <div class="task">${card.task}</div>
        <div class="bar" aria-label="Progress ${Math.round(card.progress)}%"><i style="width:${card.progress}%"></i></div>
        <dl>
          <dt>Activity</dt><dd>${card.activity}</dd>
          <dt>Where</dt><dd>${zone ? zone.name : "—"}</dd>
          <dt>Engine</dt><dd>${card.backend}</dd>
          <dt>Runtime</dt><dd>${card.runtime}</dd>
          <dt>Tokens</dt><dd>${card.tokens}</dd>
          <dt>Signal</dt><dd>${card.updated}</dd>
          ${card.checkpoint ? html`<dt>Checkpoint</dt><dd>${card.checkpoint}</dd>` : nothing}
          ${card.plugin ? html`<dt>Plugin</dt><dd>${card.plugin}</dd>` : nothing}
          ${a.filesTouchedCount ? html`<dt>Files</dt><dd>${a.filesTouchedCount}</dd>` : nothing}
        </dl>
        <div class="actions">
          <button data-act="details" @click=${() => act.openAgent(a)}>${icons.externalLink}Agent focus</button>
          <button data-act="message" aria-pressed=${this.composeOpen ? "true" : "false"} @click=${() => (this.composeOpen = !this.composeOpen)}>${icons.messageSquare}Message</button>
          <button data-act="stop" ?disabled=${!running} title=${running ? "Stop this run" : "Not running"} @click=${() => this.doStop(a)}>${icons.stop}Stop</button>
          <button data-act="follow" aria-pressed=${this.following === a.sessionKey ? "true" : "false"} @click=${() => this.toggleFollow(a.sessionKey)}>${icons.target}Follow</button>
          ${a.kanbanTaskId && act.openTask ? html`<button data-act="task" @click=${() => act.openTask?.(a.kanbanTaskId!)}>${icons.kanban}Task</button>` : nothing}
        </div>
        ${this.composeOpen
          ? html`<form class="compose" @submit=${(e: Event) => this.doMessage(e, a)}>
              <input name="msg" placeholder="Message ${card.name}…" aria-label="Message" autocomplete="off" />
              <button type="submit" aria-label="Send">${icons.send}</button>
            </form>`
          : nothing}
        ${this.note ? html`<div class="note ${this.note.err ? "err" : ""}" role="status">${this.note.text}</div>` : nothing}
      </aside>
    `;
  }

  private renderZonePanel() {
    const z = this.zoneSel ? this.layout?.zones.find((zz) => zz.id === this.zoneSel) : undefined;
    if (!z || !this.actions) return nothing;
    const occ = (this.layout?.agents ?? []).filter((p) => p.zoneId === z.id);
    const canOpen = z.kind === "plugin" && (this.actions.canOpenZone ? this.actions.canOpenZone(z) : !!z.openTab);
    return html`
      <aside class="panel glass" role="dialog" aria-label="${z.name}" data-testid="mesh3d-zone-panel">
        <button class="close" title="Close (Esc)" aria-label="Close" @click=${() => (this.zoneSel = null)}>${icons.x}</button>
        <h3>${z.name}</h3>
        <div class="sub">${z.kind === "plugin" ? "Plugin building" : z.kind === "island" ? "Federation node" : "Station sector"} · ${z.subtitle}</div>
        <span class="chip" style="color:${hex(this.scene?.palette.accent ?? z.accent)}">${z.monogram ? html`<b>${z.monogram}</b>` : nothing}${occ.length} agent${occ.length === 1 ? "" : "s"} here</span>
        <dl style="margin-top:12px">
          ${z.pluginId ? html`<dt>Plugin</dt><dd>${z.pluginId}</dd>` : nothing}
          ${z.openTab ? html`<dt>Page</dt><dd>/${z.openTab}</dd>` : nothing}
          ${z.nodeId ? html`<dt>Node</dt><dd>${z.nodeId} · ${z.status}</dd>` : nothing}
          <dt>Footprint</dt><dd>${z.w}×${z.h} tiles</dd>
        </dl>
        ${occ.length
          ? html`<div class="occ">
              ${occ.map((p) => html`<button @click=${() => this.selectAgent(p.key, true)}><span class="dot" style="color:${this.stateTone(p.state)}"></span>${p.agent.label || p.agent.agentId}</button>`)}
            </div>`
          : nothing}
        ${z.kind === "plugin"
          ? html`<div class="actions">
              <button data-act="open-plugin" ?disabled=${!canOpen} @click=${() => this.actions?.openZone(z)}>${icons.externalLink}Open ${z.name}</button>
            </div>`
          : nothing}
      </aside>
    `;
  }

  /** Centre the tooltip under its anchor, clamped inside the view. */
  private tooltipStyle(t0: { x: number; y: number }): string {
    // Scene coordinates are canvas px; convert to this element's CSS px (ancestor CSS zoom).
    const cw = this.scene?.glow.size.w ?? 0;
    const k = cw > 2 && this.clientWidth ? this.clientWidth / cw : 1;
    const t = { x: t0.x * k, y: t0.y * k };
    const w = this.clientWidth || 800;
    const h = this.clientHeight || 600;
    const tw = 260;
    const left = Math.max(8, Math.min(w - tw - 8, t.x - tw / 2));
    const top = Math.max(8, Math.min(h - 70, t.y));
    return `left:${Math.round(left)}px;top:${Math.round(top)}px;max-width:${tw}px`;
  }

  private toggleHud(): void {
    this.hudOpen = !this.hudOpen;
    try {
      localStorage.setItem(HUD_KEY, this.hudOpen ? "open" : "closed");
    } catch {
      /* ignore */
    }
    if (this.hudOpen) void this.updateComplete.then(() => this.drawMinimap());
  }

  private async doMessage(e: Event, a: MeshAgent): Promise<void> {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement;
    const text = input.value.trim();
    if (!text || !this.actions) return;
    this.flash("Sending…");
    const r = await this.actions.message(a, text);
    if (r.ok) {
      input.value = "";
      this.composeOpen = false;
      this.flash("Message sent");
    } else this.flash(r.error || "Message not delivered", true);
  }

  private async doStop(a: MeshAgent): Promise<void> {
    if (!this.actions) return;
    if (!confirm(`Stop ${a.label || a.sessionKey}?`)) return;
    this.flash("Stopping…");
    const r = await this.actions.stop(a);
    this.flash(r.ok ? "Stop requested" : r.error || "Stop failed", !r.ok);
  }

  override render() {
    if (this.failed) {
      return html`<div class="failed">3D view unavailable on this device — showing the 2D map.</div>`;
    }
    const results = this.searchOpen ? this.searchResults() : [];
    const qLabel = this.quality === "auto" ? `Auto · ${this.tierLabel || "…"}` : this.quality;
    return html`
      <div class="stage" data-testid="mesh3d-stage"></div>
      <div class="vignette" aria-hidden="true"></div>
      <div class="ap-layer" data-testid="mesh3d-panels"></div>

      <div class="toolbar glass" role="toolbar" aria-label="3D mesh controls">
        <label class="search">
          <span class="ico" aria-hidden="true">${icons.search}</span>
          <input
            placeholder=${this.mobile ? "Find agent" : "Find agent ( / )"}
            aria-label="Find an agent"
            .value=${this.searchQ}
            @input=${(e: InputEvent) => {
              this.searchQ = (e.target as HTMLInputElement).value;
              this.searchOpen = true;
            }}
            @focus=${() => (this.searchOpen = true)}
            @blur=${() => setTimeout(() => (this.searchOpen = false), 150)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                const first = this.searchResults()[0];
                if (first) this.selectAgent(first.key, true);
              }
            }}
          />
          ${results.length
            ? html`<div class="results glass">
                ${results.map(
                  (r) => html`<button @mousedown=${(e: Event) => e.preventDefault()} @click=${() => this.selectAgent(r.key, true)}>
                    <span class="dot" style="color:${r.tone}"></span>${r.name}
                  </button>`,
                )}
              </div>`
            : nothing}
        </label>
        <button title="Reset view (R)" @click=${() => this.scene?.resetView()}>${icons.refresh}<span class="lbl">Reset</span></button>
        <button title="Follow the selected agent (F)" ?disabled=${!this.selected && !this.following} aria-pressed=${this.following ? "true" : "false"} @click=${() => this.toggleFollow()}>${icons.target}<span class="lbl">Follow</span></button>
        <button title="Cinematic orbit (C)" aria-pressed=${this.cinematic ? "true" : "false"} @click=${() => this.toggleCinematic()}>${icons.play}<span class="lbl">Orbit</span></button>
        <button title="Minimap (M)" aria-pressed=${this.minimap ? "true" : "false"} @click=${() => this.toggleMinimap()}>${icons.grid}<span class="lbl">Map</span></button>
        <button title="Render quality — click to change" data-testid="mesh3d-quality" @click=${() => this.cycleQuality()}>${icons.sliders}<span class="lbl">${qLabel}</span></button>
        <button class="kbd-help" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" @click=${() => (this.help = !this.help)}>${icons.lightbulb}</button>
        <button
          class="hud-toggle"
          data-testid="mesh3d-hud-toggle"
          title=${this.hudOpen ? "Hide stats, ticker and minimap" : "Show stats, ticker and minimap"}
          aria-label="Map details"
          aria-expanded=${this.hudOpen ? "true" : "false"}
          @click=${() => this.toggleHud()}
        >${this.hudOpen ? icons.chevronDown : icons.chevronUp}</button>
      </div>

      <div class="stats glass" aria-live="polite" data-testid="mesh3d-stats">
        <span><b>${this.counts.agents}</b> agents</span>
        <span><b>${this.counts.working}</b> working</span>
        <span><b>${this.counts.plugins}</b> plugins</span>
        ${this.counts.nodes > 1 ? html`<span><b>${this.counts.nodes}</b> nodes</span>` : nothing}
        ${this.fps ? html`<span><b>${this.fps}</b> fps</span>` : nothing}
      </div>

      ${this.following
        ? html`<div class="follow-badge glass">${icons.target} Following ${this.agentName(this.following)}
            <button style="min-height:22px;padding:2px 6px" @click=${() => this.toggleFollow(null)}>${icons.x}</button></div>`
        : nothing}

      <div class="ticker glass" aria-label="Live activity">
        <span class="live"><span class="dot" style="color:#d4af37"></span>LIVE</span>
        ${this.ticker.length
          ? this.ticker.map(
              (t) => html`<span class="tick" @click=${() => t.key && this.selectAgent(t.key, true)}><span class="dot" style="color:${t.tone}"></span>${t.text}</span>`,
            )
          : html`<span class="tick" style="opacity:.6">Watching the mesh…</span>`}
      </div>

      ${this.minimap
        ? html`<div class="mm-wrap glass"><canvas class="mm" aria-label="Minimap — click to move the camera" @pointerdown=${(e: PointerEvent) => this.onMinimapClick(e)}></canvas></div>`
        : nothing}

      ${this.renderAgentPanel()} ${this.renderZonePanel()}

      ${this.tooltip && !this.mobile
        ? html`<div class="tooltip glass" style=${this.tooltipStyle(this.tooltip)}>
            <strong><span class="dot" style="color:${this.tooltip.tone}"></span>${this.tooltip.title}</strong>
            <span>${this.tooltip.sub}</span>
          </div>`
        : nothing}

      ${this.help
        ? html`<div class="help glass" role="dialog" aria-label="Keyboard shortcuts" @click=${() => (this.help = false)}>
            <h3>3D mesh shortcuts</h3>
            <div><kbd>Drag</kbd>orbit · <kbd>Right-drag</kbd>pan · <kbd>Wheel</kbd>zoom</div>
            <div><kbd>/</kbd>find an agent · <kbd>N</kbd>/<kbd>P</kbd>next / previous agent</div>
            <div><kbd>F</kbd>follow selected · <kbd>R</kbd>reset view · <kbd>C</kbd>cinematic orbit</div>
            <div><kbd>←↑↓→</kbd>pan · <kbd>Q</kbd>/<kbd>E</kbd>rotate · <kbd>+</kbd>/<kbd>−</kbd>zoom</div>
            <div><kbd>M</kbd>minimap · <kbd>Esc</kbd>close / stop following · <kbd>?</kbd>this help</div>
          </div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mesh-world-3d": MeshWorld3D;
  }
}
