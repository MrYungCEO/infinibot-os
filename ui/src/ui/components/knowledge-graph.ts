/**
 * Knowledge Graph viewer — a project-centric map of the business.
 *
 * Lit element + d3-force simulation rendered onto a `<canvas>`.
 *
 * What it shows: projects are the anchors, painted by STATUS (active / in
 * review / at risk / blocked / backlog / done) with a progress ring from
 * their task rollups and a soft pulse while an agent works on them. They sit
 * on concentric orbits — open work in the core, backlog in a belt, finished
 * work on the rim. Clients are secondary hubs; notes, opportunities, issues,
 * decisions, reports and agent runs hang off them, dimmed until focused.
 * Tasks are OFF by default (71k+ rows lag everything) — a project's tasks
 * are expanded lazily from its detail card.
 *
 * Performance architecture (tuned for thousands of nodes at 60fps):
 *   • Layout runs in a Web Worker (knowledge-graph-layout.worker.ts);
 *     positions stream back as transferable Float32Arrays. Falls back to a
 *     main-thread simulation if the worker can't be constructed.
 *   • The simulation settles and STOPS. A poll whose topology is unchanged
 *     only patches metadata (no reheat); a real change warm-restarts with
 *     surviving anchors pinned so the map doesn't reshuffle.
 *   • d3-quadtree hit-testing, rebuilt lazily only when a pick is needed.
 *   • Viewport culling, zoom LOD, and greedy screen-space label placement.
 *
 * Shared between the Memory → Knowledge graph sub-view and the masonry grid
 * panel (`compact`).
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  quadtree,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3";
import LayoutWorker from "./knowledge-graph-layout.worker.ts?worker";
import type { V3Layout } from "./knowledge-graph-layout-v3";
import { makeLiveShapedSnapshot } from "./knowledge-graph-synth";
import {
  groupHeights,
  planGalaxy,
  seedHeights,
  VELOCITY_DECAY,
  zIntegrateForce,
  zPlanForce,
  type ZPlan,
} from "./knowledge-graph-galaxy";
import { html, LitElement, nothing, svg, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import { icons } from "../icons";
import { inferBasePathFromPathname } from "../navigation";
import { webglAvailable } from "../lib/glow3d";
import {
  KnowledgeGraph3DStage,
  type QualityMode,
  type StageCallbacks,
  type StageGroup,
  type StageLink,
  type StageNode,
  type StageRing,
} from "./knowledge-graph-3d-stage";
import "./knowledge-graph-ai";
import {
  applyKgEmbedChrome,
  haptic,
  hasNativeHost,
  initialKgDeepLink,
  isKgEmbed,
  listenHostCommands,
  postNative,
  type HostCommand,
  type KgDeepLink,
} from "./knowledge-graph-embed";
import type { KgAiDrawer } from "./knowledge-graph-ai";
import { kgOverlayStyles } from "./knowledge-graph-styles";
import { drawMap2d, labelInfo2d, type LabelInfo, type Map2DLink } from "./knowledge-graph-map2d";
import {
  baseEmphasis,
  buildScene,
  isLiveNode,
  emphasisOf,
  highlightSetOf,
  layoutAspectFor,
  LOD_MINOR_LABELS_ABOVE,
  neighbourhoodOf,
  sceneInsights,
  stageEmphasis,
  stageGroupsOf,
  stageLayoutV3Of,
  stageLinksOf,
  stageRingsOf,
  truncate,
  type GraphEdgeIn,
  type GraphInsight,
  type GraphNodeIn,
  type GraphSnapshot,
  type Relation,
  type SceneNode,
} from "./knowledge-graph-scene";
import {
  CONNECTIONS_MODES,
  REL_LEGEND,
  REL_STYLES,
  linkStyle,
  type ConnectionsMode,
} from "./knowledge-graph-links";
import {
  buildUndo,
  captureOf,
  clusterSubProjects,
  describePlan,
  planConvertToTasks,
  planMergeDuplicates,
  resolveRefs,
  subProjectsOf,
  UNRESOLVED,
  type ConsolidateStep,
  type ConsolidationPlan,
  type RelationRow,
  type SubCluster,
  type SubDetail,
} from "./knowledge-graph-consolidate";
import {
  BULK_STATUSES,
  GROUP_MODES,
  UndoStack,
  buildAiContext,
  canReassign,
  diffActivity,
  groupTargets,
  isDocumentNode,
  planBulkDelete,
  planBulkLink,
  planBulkReassign,
  planBulkStatus,
  planBulkTag,
  planConsolidate,
  planLink,
  planReassign,
  sanitizeSnapshot,
  selectInLasso,
  spawnTask,
  storeIdOf,
  suggestLinks,
  unlinkCall,
  type ActivityItem,
  type AiIntent,
  type BulkStatus,
  type ConsolidatePlan,
  type GroupMode,
  type Grouping,
  type HudInsight,
  type InsightAction,
  type LinkPlan,
  type LinkSuggestion,
  type Plan,
  type PlannedOp,
  type RpcCall,
} from "./knowledge-graph-ops";
import {
  DEFAULT_KINDS,
  HEALTH_COLOR,
  HEALTH_LABEL,
  HEALTH_ORDER,
  healthOf,
  KIND_LABEL,
  KIND_ORDER,
  KIND_PALETTE,
  KIND_SINGULAR,
  loadEnabledHealth,
  loadEnabledKinds,
  loadPositions,
  loadPref,
  openTargetFor,
  relativeAge,
  saveEnabledHealth,
  saveEnabledKinds,
  savePositions,
  savePref,
  type GraphNodeKind,
  type ProjectHealth,
} from "./knowledge-graph-model";

/** Static SVG path for the legend icons (trusted literals only). */
function unsafeSvgPath(d: string) {
  return svg`<path d=${d} />`;
}

// d3 simulation augmentations
type SimNode = SimulationNodeDatum &
  SceneNode & {
    vz?: number;
    fz?: number | null;
    /** Seeded galaxy height plan (see knowledge-graph-galaxy.ts). */
    plan?: ZPlan;
  };

type MotionPref = "system" | "reduced" | "full";
type Dialog =
  | { type: "delete"; plan: Plan }
  | { type: "consolidate"; ids: string[]; loading: boolean; plan: ConsolidatePlan | null; error?: string; primaryId?: string; removeMode: "delete" | "archive"; title: string; body: string; bodies: Map<string, string> }
  | { type: "spawn"; ids: string[]; goal: string; agentId: string; busy?: boolean }
  | { type: "pick"; purpose: "move" | "link"; ids: string[]; query: string }
  | { type: "tag"; ids: string[]; value: string }
  | { type: "related"; ids: string[]; items: LinkSuggestion[] }
  | SubsDialog;

/** "Consolidate sub-projects" preview (dry run until the owner clicks Apply). */
type SubsDialog = {
  type: "subs";
  parentId: string;
  clusters: SubCluster[];
  /** Sub-projects in no duplicate cluster (offered, unchecked). */
  others: string[];
  checked: Set<string>;
  /** Per-cluster keeper override (merge mode). */
  keepers: Map<string, string>;
  mode: "tasks" | "merge";
  taskMode: "move" | "checklist";
  details: Map<string, SubDetail>;
  loading: number;
  batch: string;
  plan: ConsolidationPlan | null;
  running?: { done: number; total: number };
  error?: string;
  report?: string;
  showOthers?: boolean;
};

/** Live overlay geometry kept off the Lit render path (updated per frame). */
type DragLine = { fromId: string; x: number; y: number; targetId: string | null; ok: boolean; text: string };

/** Which renderer draws the stage: WebGL galaxy or the flat canvas map. */
type RendererMode = "3d" | "2d";
const RENDERER_KEY = "infinibot.kg.renderer";

/** `?kg2d=1` / `?kg3d=1` win, then the saved preference, then WebGL support. */
function detectRendererMode(): RendererMode {
  try {
    const sp = new URLSearchParams(location.search);
    if (sp.get("kg2d") === "1") return "2d";
    if (sp.get("kg3d") === "1") return webglAvailable() ? "3d" : "2d";
    const saved = globalThis.localStorage?.getItem(RENDERER_KEY);
    if (saved === "2d") return "2d";
  } catch {
    /* no location / storage */
  }
  return webglAvailable() ? "3d" : "2d";
}
type SimLink = SimulationLinkDatum<SimNode> & { rel: string; weight: number; inferred: boolean };

const MOTION_PREFS: MotionPref[] = ["system", "reduced", "full"];
const QUALITY_PREFS: QualityMode[] = ["auto", "high", "low"];
const GROUP_IDS = GROUP_MODES.map((g) => g.id);
const DISMISS_KEY = "infinibot.kg.dismissed.v1";
/** Hover a drop target this long before a plain drag re-assigns (no accidents). */
const DROP_ARM_MS = 320;

/** Heavy layers whose chips always show (so they can be switched on). */
const HEAVY_KINDS = new Set<GraphNodeKind>(["task", "database", "row", "session"]);
const SEVERITY_COLOR = { high: "#f0525f", medium: "#f5a524", info: "#d4af37" } as const;

type KgPerf = {
  nodes: number;
  edges: number;
  layoutMode: string;
  warmRestart: boolean;
  layoutStartedAt: number;
  firstPaintAt: number | null;
  settledAt: number | null;
  frames: number;
  lastDrawMs?: number;
  avgDrawMs?: number;
  maxDrawMs?: number;
  visibleCount?: number;
  rpcMs?: number;
  rpcBytes?: number;
};

function perfState(): KgPerf | undefined {
  return (globalThis as Record<string, unknown>).__kgPerf as KgPerf | undefined;
}

import { SecureModeController, friendlySecureError, isSecureLockedError } from "../secure-mode/store";
import "../secure-mode/secure-toggle";
import {
  ALL_HEALTH,
  LANG_COLORS,
  LANG_LABELS,
  REPO_KINDS,
  repoGraphsToSnapshot,
  repoLanguages,
  repoMetaOf,
  repoNodeBudget,
  type RepoGraphPayload,
  type RepoNodeMeta,
} from "./knowledge-graph-repos";
import "./knowledge-graph-repo-file";
import {
  DEFAULT_SCOPE_HOPS,
  SCOPE_HOP_CHOICES,
  readProjectScope,
  replaceScopeInUrl,
  scopeCountText,
  scopeInfoOf,
  scopeIsSparse,
  scopeRequestParams,
  type ProjectScope,
  type ProjectScopeInfo,
} from "./knowledge-graph-project-scope";
import {
  loadProjectRepos,
  listProjectRepos,
  openRepoPicker,
  relTime,
  type ProjectRepo,
} from "../project-repos/index";

/** At or below this many nodes the initial view frames every node, not just anchors. */
const SMALL_GRAPH_FIT_ALL = 80;

@customElement("infinibot-knowledge-graph")
export class KnowledgeGraph extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Number }) refreshIntervalMs = 30_000;
  /** When true, render a compact UI suited for masonry grid panels. */
  @property({ type: Boolean }) compact = false;
  /**
   * The Knowledge Graph PAGE sets this: it shows the Secure Mode toggle in the
   * header and, while Secure Mode is on, draws the encrypted secure graph
   * (secure.graph.snapshot) instead of the normal one. Grid panels / the
   * mobile embed leave it off and always show the normal graph.
   */
  @property({ type: Boolean }) secureCapable = false;
  /** Which lane the current snapshot came from (switching clears everything). */
  private lane: "normal" | "secure" = "normal";
  private refreshSeq = 0;
  @state() private secureForm = { label: "", kind: "note", summary: "", busy: false, error: null as string | null };
  @state() private secureSeeding = false;
  /** Secure graph panel: open on wide screens, collapsed on phones. */
  @state() private securePanelOpen = typeof window === "undefined" || window.innerWidth >= 720;
  private secureMode = new SecureModeController(this, {
    kinds: ["graph", "kanban", "docs"],
    onLane: () => {
      if (this.lane === "secure") void this.refresh(true);
    },
    onChange: () => this.syncLane(),
  });

  /** The secure lane is what this graph should show right now. */
  private get secureLane(): boolean {
    return this.secureCapable && this.secureMode.active;
  }

  /**
   * Swap lanes: drop every node, edge, selection and cache from the previous
   * lane so no secure node lingers in component state (and vice versa), then
   * load the new lane's snapshot.
   */
  /** Layer set the user had before entering the secure lane (restored on exit). */
  private kindsBeforeSecure: Set<GraphNodeKind> | null = null;

  private syncLane(): void {
    const want = this.secureLane ? "secure" : "normal";
    if (want === this.lane) return;
    this.lane = want;
    if (want === "secure" && this.repoMode) this.setRepoMode(false, false);
    if (want === "secure") {
      this.kindsBeforeSecure ??= new Set(this.enabledKinds);
    } else if (this.kindsBeforeSecure) {
      this.enabledKinds = this.kindsBeforeSecure;
      this.kindsBeforeSecure = null;
    }
    this.refreshSeq++;
    if (this.savePosTimer) {
      clearTimeout(this.savePosTimer);
      this.savePosTimer = null;
    }
    this.snapshot = null;
    this.prevSnapshotNodes = null;
    this.localEdges = [];
    this.expanded = new Map();
    this.expanding = new Set();
    this.selection = new Set();
    this.selectedId = null;
    this.hoveredId = null;
    this.hoverCardId = null;
    this.peekId = null;
    this.linkTapFrom = null;
    this.menu = null;
    this.dialog = null;
    this.aiOpen = false;
    this.activity = [];
    this.hudInsights = [];
    this.consolidatedIds = new Set();
    this.consolidatedAt = 0;
    this.error = null;
    this.rebuildSimulation();
    if (this.isConnected && this.synthCount === 0) void this.refresh(true);
  }

  private async addSecureNode(e: Event): Promise<void> {
    e.preventDefault();
    const label = this.secureForm.label.trim();
    if (!label || this.secureForm.busy) return;
    this.secureForm = { ...this.secureForm, busy: true, error: null };
    try {
      await this.client?.request("secure.graph.nodes.create", {
        label,
        kind: this.secureForm.kind,
        ...(this.secureForm.summary.trim() ? { summary: this.secureForm.summary.trim() } : {}),
      });
      this.secureForm = { label: "", kind: this.secureForm.kind, summary: "", busy: false, error: null };
      void this.refresh(true);
    } catch (err) {
      this.secureForm = { ...this.secureForm, busy: false, error: friendlySecureError(err) };
    }
  }

  private async seedSecureGraph(): Promise<void> {
    if (this.secureSeeding) return;
    const ok = window.confirm(
      "Copy the current knowledge graph into Secure Mode once?\n\nEvery node and link of the normal graph is copied into the encrypted secure graph. This can only be done one time.",
    );
    if (!ok) return;
    this.secureSeeding = true;
    try {
      const res = (await this.client?.request<{ nodes?: number; edges?: number }>("secure.graph.seed", { confirm: true })) ?? {};
      this.showToast(`Copied ${res.nodes ?? 0} nodes and ${res.edges ?? 0} links into the secure graph.`, "ok");
      void this.refresh(true);
    } catch (err) {
      this.showToast(friendlySecureError(err), "err");
    } finally {
      this.secureSeeding = false;
    }
  }

  private async deleteSecureNode(id: string): Promise<void> {
    if (!window.confirm("Delete this node from the secure graph?")) return;
    try {
      await this.client?.request("secure.graph.nodes.delete", { id });
      this.selectedId = null;
      void this.refresh(true);
    } catch (err) {
      this.showToast(friendlySecureError(err), "err");
    }
  }

  private renderSecurePanel() {
    if (this.lane !== "secure") return nothing;
    const seededAt = this.secureMode.state.status?.seededAt;
    const sel = this.selectedId;
    // Only free-standing secure graph nodes can be deleted here (projects /
    // tasks / docs are removed from their own secure board / docs page).
    const deletable = sel && !sel.startsWith("secure:") ? sel : null;
    return html`<style>
        .kg-host--secure { box-shadow: inset 0 0 0 1px var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); }
        .kg-host--secure .kg-title { color: var(--ib-secure, #34d399); }
        .kg-secure-toggle { flex: none; }
        .kg-secure-panel {
          position: absolute; left: 12px; bottom: 12px; z-index: 6; width: min(420px, calc(100% - 24px));
          display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 14px;
          background: var(--glass-solid, rgba(14, 16, 18, 0.88)); backdrop-filter: blur(14px);
          border: 1px solid var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); box-shadow: var(--ib-secure-glow, none), 0 16px 40px rgba(0, 0, 0, 0.35);
          color: var(--glass-fg, var(--text));
        }
        .kg-secure-panel--collapsed { padding-block: 6px; }
        .kg-secure-head { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; width: 100%; text-align: left; }
        .kg-secure-chev { margin-left: auto; display: inline-flex; opacity: 0.7; }
        .kg-secure-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--ib-secure, #34d399); text-transform: uppercase; letter-spacing: 0.05em; }
        .kg-secure-head svg { width: 13px; height: 13px; }
        .kg-secure-form { display: grid; grid-template-columns: 1fr 104px; gap: 6px; }
        .kg-secure-form .kg-secure-input:nth-of-type(3) { grid-column: 1 / 2; }
        .kg-secure-input {
          min-height: 30px; padding: 0 8px; border-radius: 8px; font: inherit; font-size: 12.5px; color: inherit; min-width: 0;
          border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.12)); background: color-mix(in srgb, currentColor 5%, transparent);
        }
        .kg-secure-input:focus-visible { outline: 2px solid var(--ib-secure, #34d399); outline-offset: 1px; }
        .kg-secure-err { font-size: 12px; color: #f87171; }
        .kg-secure-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .kg-secure-actions:empty { display: none; }
      </style>
      <div class="kg-secure-panel ${this.securePanelOpen ? "" : "kg-secure-panel--collapsed"}" data-secure-graph-panel>
      <button
        class="kg-secure-head"
        type="button"
        aria-expanded=${this.securePanelOpen ? "true" : "false"}
        @click=${() => (this.securePanelOpen = !this.securePanelOpen)}
      >${icons.lock}<span>Secure graph</span><span class="kg-secure-chev">${this.securePanelOpen ? icons.chevronDown : icons.chevronRight}</span></button>
      ${this.securePanelOpen ? html`<form class="kg-secure-form" @submit=${(e: Event) => void this.addSecureNode(e)}>
        <input
          class="kg-secure-input"
          placeholder="Add secure node"
          aria-label="Secure node label"
          .value=${this.secureForm.label}
          @input=${(e: Event) => (this.secureForm = { ...this.secureForm, label: (e.target as HTMLInputElement).value })}
        />
        <select
          class="kg-secure-input"
          aria-label="Secure node kind"
          .value=${this.secureForm.kind}
          @change=${(e: Event) => (this.secureForm = { ...this.secureForm, kind: (e.target as HTMLSelectElement).value })}
        >
          ${["note", "idea", "person", "client", "project", "task", "decision", "issue", "report", "content", "product", "opportunity"].map(
            (k) => html`<option value=${k} ?selected=${k === this.secureForm.kind}>${k}</option>`,
          )}
        </select>
        <input
          class="kg-secure-input"
          placeholder="Summary (optional)"
          aria-label="Secure node summary"
          .value=${this.secureForm.summary}
          @input=${(e: Event) => (this.secureForm = { ...this.secureForm, summary: (e.target as HTMLInputElement).value })}
        />
        <button class="kg-btn kg-btn--primary" type="submit" data-secure-add-node ?disabled=${!this.secureForm.label.trim() || this.secureForm.busy}>
          ${icons.plus}<span>Add</span>
        </button>
      </form>
      ${this.secureForm.error ? html`<div class="kg-secure-err" role="alert">${this.secureForm.error}</div>` : nothing}
      <div class="kg-secure-actions">
        ${deletable
          ? html`<button class="kg-btn" type="button" @click=${() => void this.deleteSecureNode(deletable)}>${icons.trash}<span>Delete selected</span></button>`
          : nothing}
        ${seededAt
          ? nothing
          : html`<button class="kg-btn" type="button" data-secure-seed ?disabled=${this.secureSeeding} @click=${() => void this.seedSecureGraph()}>
              ${icons.copy}<span>${this.secureSeeding ? "Copying…" : "Seed once from current graph"}</span>
            </button>`}
      </div>` : nothing}
    </div>`;
  }

  @state() private snapshot: GraphSnapshot | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private enabledKinds: Set<GraphNodeKind> = loadEnabledKinds();
  @state() private enabledHealth: Set<ProjectHealth> = loadEnabledHealth();
  @state() private search = "";
  @state() private selectedId: string | null = null;
  @state() private hoveredId: string | null = null;
  /** Insight currently highlighting its node set (null = none). */
  @state() private activeInsight: GraphInsight | null = null;
  /** Lazily expanded per-project task layers, keyed by project node id. */
  @state() private expanded = new Map<string, { nodes: GraphNodeIn[]; edges: GraphEdgeIn[] }>();
  @state() private expanding = new Set<string>();

  // ── Selection, HUD & actions ──────────────────────────────
  /** Multi-selection (Shift/Ctrl-click, lasso, Ctrl+A). */
  @state() private selection = new Set<string>();
  // "group.v2": the brain formation became the default; older saved picks are reset once.
  @state() private groupMode: GroupMode = loadPref("group.v2", GROUP_IDS, "brain");
  /** Repos mode: project repos as a project → repo → dir/file graph. */
  @state() private repoMode = false;
  /** Project-scoped view (`?project=<id>`): only what is connected to that project. */
  @state() private projectScope: ProjectScope | null = null;
  @state() private scopeInfo: ProjectScopeInfo | null = null;
  /** Layer set from before the scoped view, restored by "Show all". */
  private scopeSaved: { kinds: Set<GraphNodeKind>; group: GroupMode } | null = null;
  private scopeFocused: string | null = null;
  /** Phones: the scope focus rings + flies to the project without opening its card. */
  private scopeQuietFocus = false;
  /** "all" or one projectId. */
  @state() private repoSel = "all";
  @state() private repoProjects: ProjectRepo[] = [];
  /** projectId → repo-relative dirs the user expanded. */
  private repoExpand = new Map<string, Set<string>>();
  private repoSaved: { kinds: Set<GraphNodeKind>; health: Set<ProjectHealth>; group: GroupMode } | null = null;
  private repoUnsub: (() => void) | null = null;
  private repoEventTimer: ReturnType<typeof setTimeout> | null = null;
  @state() private motionPref: MotionPref = loadPref("motion", MOTION_PREFS, "system");
  @state() private qualityPref: QualityMode = loadPref("quality", QUALITY_PREFS, "auto");
  @state() private ambienceOn = loadPref("ambience", ["on", "off"] as const, "on") === "on";
  /** Toolbar "Connections": all links / only the selection's / none. */
  @state() private connectionsMode: ConnectionsMode = loadPref("connections", ["all", "selected", "none"] as const, "all");
  /** Grouping hulls (zone halos) on/off. */
  @state() private hullsOn = loadPref("hulls", ["on", "off"] as const, "on") === "on";
  /** Projects converted/merged by "Consolidate sub-projects" (store ids, from back-reference relations). */
  @state() private consolidatedIds = new Set<string>();
  @state() private showConsolidated = false;
  private consolidatedAt = 0;
  /** Phones keep their own HUD preference and start collapsed (the stage is small). */
  private readonly hudKey =
    (globalThis.innerWidth != null && globalThis.innerWidth < 700) || isKgEmbed() ? "hud-m" : "hud";
  @state() private hudOpen = loadPref(this.hudKey, ["open", "closed"] as const, this.hudKey === "hud-m" ? "closed" : "open") === "open";
  @state() private hudTab: "signals" | "activity" | "groups" = "signals";
  @state() private settingsOpen = false;
  @state() private linkMode = false;
  @state() private selectMode = false;
  @state() private menu: { x: number; y: number; nodeId: string | null } | null = null;
  private menuOpenedAt = 0;
  @state() private statusMenu = false;
  @state() private hoverCardId: string | null = null;
  @state() private dialog: Dialog | null = null;
  @state() private toast: { text: string; tone: "ok" | "warn" | "err"; undo: boolean } | null = null;
  @state() private activity: ActivityItem[] = [];
  @state() private hudInsights: HudInsight[] = [];
  @state() private busy = false;
  @state() private fps = 0;
  private undoStack = new UndoStack();
  private dismissed = new Set<string>();
  private prevSnapshotNodes: GraphNodeIn[] | null = null;
  /** Optimistic edges (just linked) until the next snapshot confirms them. */
  private localEdges: GraphEdgeIn[] = [];
  private grouping: Grouping | null = null;
  private dragLine: DragLine | null = null;
  private lassoPts: number[] | null = null;
  private dropTarget: { id: string; ok: boolean; armed: boolean; text: string; since: number } | null = null;
  private dragFrom: string | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverHideTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private fpsTimer: ReturnType<typeof setInterval> | null = null;
  private fpsFrames = 0;
  private savePosTimer: ReturnType<typeof setTimeout> | null = null;
  private overlayRaf: number | null = null;
  /** 2D-mode modifier drags. */
  private linkDrag2d: { node: SimNode } | null = null;
  private lasso2d: boolean = false;
  /** 2D touch: live fingers, the pinch in progress and the long-press timer. */
  private touch2d = new Map<number, { x: number; y: number }>();
  private pinch2d: { d0: number; k0: number; mx: number; my: number; vx: number; vy: number } | null = null;
  private longPress2d: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  private longPress2dFired = false;

  // ── Touch / embed (mobile app WebView) ────────────────────
  /** Chromeless mobile-app embed (`?embed=1` or a React Native WebView host). */
  private readonly embed = isKgEmbed();
  /** Pointer type of the last stage press (touch taps peek instead of opening the detail panel). */
  private lastPointerType = "mouse";
  /** Touch tap: the quick card is pinned for the selected node; the full detail panel waits for "Details". */
  @state() private touchPeek = false;
  /** Node whose detail panel stays closed after a touch peek (until "Details" or a mouse click). */
  @state() private peekId: string | null = null;
  /** Link mode by taps: the first tapped node, waiting for its target. */
  @state() private linkTapFrom: string | null = null;
  /** Deep link (`?focus=` / native `__kgEmbed.focus`) applied once the layout settles. */
  private pendingDeepFocus: { id: string; family: boolean } | null = null;
  private nativeReadySent = false;
  private readyFallback: ReturnType<typeof setInterval> | null = null;

  /** Main-thread fallback simulation (only used when the worker fails). */
  private simulation: Simulation<SimNode, SimLink> | null = null;
  /** Off-main-thread layout worker (preferred path). */
  private worker: Worker | null = null;
  private rafId: number | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private nodes: SimNode[] = [];
  private links: SimLink[] = [];
  private nodeById = new Map<string, SimNode>();
  /** Per-node degree (index-aligned with `nodes`). */
  private degree: number[] = [];
  private quad: ReturnType<typeof quadtree<SimNode>> | null = null;
  /** Quadtree is rebuilt lazily — set on every tick, cleared on rebuild. */
  private quadDirty = true;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private size = { w: 800, h: 600 };
  private viewport = { x: 0, y: 0, k: 1 };
  /** True until the first layout settles — the view auto-fits then. */
  private needsFit = true;
  private userMovedView = false;
  private resizeObserver: ResizeObserver | null = null;
  private dragging: { node: SimNode; index: number; moved: boolean } | null = null;
  private pan: { startX: number; startY: number; baseX: number; baseY: number } | null = null;
  /** Signature of the laid-out topology — an unchanged poll is a NO-OP for the sim. */
  private topoSig = "";
  private resizeDebounce: ReturnType<typeof setTimeout> | null = null;
  private lastSize = { w: 0, h: 0 };
  /** Coalesced drag → worker: at most one "drag" message per animation frame. */
  private dragRaf: number | null = null;
  private pendingDrag: { index: number; x: number; y: number; z?: number } | null = null;
  /** Warm-restart pins are released once the layout settles. */
  private pinsHeld = false;

  // ── 3D stage ──────────────────────────────────────────────
  /** Active renderer. Flips to "2d" when WebGL is missing or its context dies. */
  @state() private mode: RendererMode = "2d";
  /** Mode the live renderer was built for (null before first mount). */
  private rendererMode: RendererMode | null = null;
  private stage: KnowledgeGraph3DStage | null = null;
  /** Layout centre handed to the stage (layout px → world origin). */
  private center = { cx: 0, cy: 0 };
  /** Orbit radii of the current layout (guide rings in 3D). */
  private orbitRadii: number[] = [];
  /** Ids matching the current search (fly-to target once the layout settles). */
  private searchMatchIds: Set<string> | null = null;
  private pendingSearchFit = false;

  // ── Renderer state ────────────────────────────────────────
  /** Adjacency: node id → neighbour ids (for 1-hop focus highlight). */
  private adjacency = new Map<string, Set<string>>();
  /** Typed relations for the detail card. */
  private relations = new Map<string, Relation[]>();
  private focusNeighborhood: Set<string> | null = null;
  private focusNeighborhoodId: string | null = null;
  /** Insight highlight set (ids + their direct neighbours). */
  private highlightSet: Set<string> | null = null;
  /** Spring-animated hover scale, per the currently hovered node. */
  private hoverScale = 1;
  private hoverScaleTarget = 1;
  /** Marching-ants phase for active edges (advanced each anim frame). */
  private dashPhase = 0;
  private animId: number | null = null;
  private lastAnimDraw = 0;
  /** Any visible project/run is live → pulse animation needed. */
  private hasLive = false;
  private reducedMotion = false;
  private reducedMotionMql: MediaQueryList | null = null;
  /** Label width cache (px at the label font), keyed by font + text. */
  private labelWidths = new Map<string, number>();

  // ── LOD thresholds ────────────────────────────────────────
  /** Above this zoom: minor (non-anchor) nodes get labels too. */
  private static readonly LOD_MINOR_LABELS_ABOVE = 1.15;
  /** Synthetic-dataset size, set via `?kgsynth=N` for profiling. */
  private synthCount = 0;
  /** `?kgsynth=live|live-tasks`: live-shaped synthetic graph (verification). */
  private synthLive: string | null = null;
  /** Force the main-thread fallback layout (`?kglayout=main`) for A/B profiling. */
  private forceMainThreadLayout = false;

  // ── Lifecycle ─────────────────────────────────────────────
  override createRenderRoot() {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.compact) {
      this.hudOpen = false;
    }
    if (this.embed && !this.compact) {
      applyKgEmbedChrome();
      this.applyDeepLink(initialKgDeepLink(), false);
      (globalThis as Record<string, unknown>).__kgEmbed = {
        focus: (id: string, opts?: { family?: boolean }) => this.onHostCommand({ cmd: "focus", id, family: !!opts?.family }),
        apply: (link: Partial<KgDeepLink>) =>
          this.onHostCommand({
            cmd: "apply",
            link: { focus: link.focus ?? null, family: !!link.family, layer: link.layer ?? null, group: link.group ?? null },
          }),
        fit: () => this.onHostCommand({ cmd: "fit" }),
        back: () => this.onHostCommand({ cmd: "back" }),
        nodes: () => this.nodes.length,
      };
      this.unlistenHost = listenHostCommands((c) => this.onHostCommand(c));
      // The layout may never "settle" (restored positions, a slow GPU): once
      // nodes have been on screen for a beat, lift the app's veil anyway.
      let seen = 0;
      this.readyFallback = setInterval(() => {
        if (this.nativeReadySent) {
          if (this.readyFallback) clearInterval(this.readyFallback);
          this.readyFallback = null;
          return;
        }
        seen = this.nodes.length && !this.loading ? seen + 1 : 0;
        if (seen >= 2) this.notifyNativeReady();
      }, 700);
    }
    this.mode = detectRendererMode();
    this.lane = this.secureLane ? "secure" : "normal";
    try {
      this.reducedMotionMql = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.reducedMotion = this.effectiveReducedMotion(this.reducedMotionMql.matches);
      this.reducedMotionMql.addEventListener("change", this.onReducedMotionChange);
    } catch {
      this.reducedMotion = this.motionPref === "reduced";
    }
    try {
      const raw = globalThis.localStorage?.getItem(DISMISS_KEY);
      if (raw) this.dismissed = new Set((JSON.parse(raw) as string[]).filter((x) => typeof x === "string"));
    } catch {
      /* fresh */
    }
    // HUD frame-rate readout: count stage frames once a second (no extra rAF).
    this.fpsTimer = setInterval(() => {
      const f = perfState()?.frames ?? 0;
      const next = Math.max(0, f - this.fpsFrames);
      this.fpsFrames = f;
      if (this.hudOpen && !document.hidden && Math.abs(next - this.fps) >= 1) this.fps = next;
    }, 1000);
    window.addEventListener("keydown", this.onKeyDown);
    // Profiling hook: `?kgsynth=10000` injects a synthetic graph of N nodes
    // client-side, bypassing the gateway so the renderer can be benchmarked.
    try {
      const sp = new URLSearchParams(location.search);
      const raw = sp.get("kgsynth") ?? "";
      // `live` / `live-tasks`: a graph shaped like the live install (350
      // projects, 31 clients, 121 notes, 6 reports, ~110 orphans, ± 2,194 tasks).
      if (raw === "live" || raw === "live-tasks") {
        this.synthCount = 1;
        this.synthLive = raw;
      } else {
        const synth = Number(raw);
        if (Number.isFinite(synth) && synth > 0) this.synthCount = Math.min(50_000, Math.floor(synth));
      }
      if (sp.get("kglayout") === "main") this.forceMainThreadLayout = true;
    } catch {
      /* no-op */
    }
    if (!this.compact) {
      const sc = typeof location === "undefined" ? null : readProjectScope(location.search);
      if (sc) this.enterProjectScope(sc, false);
      window.addEventListener("popstate", this.onScopePopState);
    }
    if (this.synthCount > 0) {
      if (this.synthLive === "live-tasks") this.enabledKinds = new Set([...this.enabledKinds, "task"]);
      this.snapshot = this.synthLive ? makeLiveShapedSnapshot(this.synthLive === "live-tasks") : this.makeSyntheticSnapshot(this.synthCount);
    } else {
      void this.refresh();
      this.pollTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.repoUnsub?.();
    this.repoUnsub = null;
    if (this.repoEventTimer) clearTimeout(this.repoEventTimer);
    this.stopSimulation();
    this.stopAnimLoop();
    this.stage?.dispose();
    this.stage = null;
    this.worker?.terminate();
    this.worker = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
    this.resizeDebounce = null;
    if (this.dragRaf !== null) cancelAnimationFrame(this.dragRaf);
    this.dragRaf = null;
    this.pendingDrag = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.reducedMotionMql?.removeEventListener("change", this.onReducedMotionChange);
    this.reducedMotionMql = null;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("popstate", this.onScopePopState);
    if (this.longPress2d) clearTimeout(this.longPress2d.timer);
    if (this.readyFallback) clearInterval(this.readyFallback);
    this.readyFallback = null;
    if (this.embed && !this.compact) delete (globalThis as Record<string, unknown>).__kgEmbed;
    this.unlistenHost?.();
    this.unlistenHost = null;
    for (const t of [this.hoverTimer, this.hoverHideTimer, this.toastTimer, this.savePosTimer]) if (t) clearTimeout(t);
    if (this.fpsTimer) clearInterval(this.fpsTimer);
    this.fpsTimer = null;
    if (this.overlayRaf !== null) cancelAnimationFrame(this.overlayRaf);
    this.overlayRaf = null;
  }

  /** OS preference unless the user pinned motion in the graph's settings. */
  private effectiveReducedMotion(system: boolean): boolean {
    if (this.motionPref === "reduced") return true;
    if (this.motionPref === "full") return false;
    return system;
  }

  private applyMotion(): void {
    const sys = this.reducedMotionMql?.matches ?? false;
    const rm = this.effectiveReducedMotion(sys);
    if (rm === this.reducedMotion) return;
    this.reducedMotion = rm;
    this.stage?.setReducedMotion(rm);
    if (rm) {
      this.hoverScale = this.hoverScaleTarget;
      this.dashPhase = 0;
      this.stopAnimLoop();
    }
    this.scheduleDraw();
  }

  private onReducedMotionChange = (e: MediaQueryListEvent): void => {
    this.reducedMotion = this.effectiveReducedMotion(e.matches);
    this.stage?.setReducedMotion(this.reducedMotion);
    if (this.reducedMotion) {
      this.hoverScale = this.hoverScaleTarget;
      this.dashPhase = 0;
      this.stopAnimLoop();
    }
    this.scheduleDraw();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.isConnected || this.offsetParent === null) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "Escape") {
      if (this.menu || this.dialog || this.settingsOpen || this.statusMenu) {
        this.menu = null;
        this.dialog = null;
        this.settingsOpen = false;
        this.statusMenu = false;
        return;
      }
      if (this.linkMode || this.selectMode) {
        this.setModes(false, false);
        return;
      }
      if (this.selection.size || this.selectedId || this.activeInsight) {
        this.clearSelection();
        this.setInsight(null);
      }
      return;
    }
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      if (this.undoStack.size) {
        e.preventDefault();
        void this.undoLast();
      }
    } else if (mod && e.key.toLowerCase() === "a" && this.nodes.length) {
      e.preventDefault();
      this.setSelection(this.nodes.map((n) => n.id));
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.selection.size) {
      e.preventDefault();
      this.openDelete([...this.selection]);
    }
  };

  /** Deterministic synthetic graph for performance profiling. */
  private makeSyntheticSnapshot(count: number): GraphSnapshot {
    const kinds = DEFAULT_KINDS;
    const healths: ProjectHealth[] = ["active", "review", "at_risk", "blocked", "backlog"];
    const nodes: GraphNodeIn[] = [];
    const edges: GraphEdgeIn[] = [];
    const stats: Partial<Record<GraphNodeKind, number>> = {};
    const projects: number[] = [];
    for (let i = 0; i < count; i++) {
      // ~12% projects, ~5% clients, the rest spread over the minor kinds.
      const kind: GraphNodeKind =
        i % 8 === 0 ? "project" : i % 20 === 1 ? "client" : kinds[2 + (i % (kinds.length - 2))];
      const meta: Record<string, unknown> = {};
      if (kind === "project") {
        meta.health = healths[i % healths.length];
        meta.tasks = (i * 7) % 40;
        meta.done = Math.floor(((i * 7) % 40) * ((i % 10) / 10));
        meta.progress = (i % 10) / 10;
        meta.live = i % 97 === 0;
        projects.push(i);
      }
      nodes.push({ id: `${kind}:${i}`, kind, label: `${kind}-${i}`, weight: (i % 7) / 7, meta });
      stats[kind] = (stats[kind] ?? 0) + 1;
      if (i > 0) {
        const fanout = 1 + (i % 3);
        for (let f = 0; f < fanout; f++) {
          const t =
            kind !== "project" && projects.length
              ? projects[(i * 31 + f * 17) % projects.length]
              : Math.floor((i * 2654435761) % i);
          if (t !== i) edges.push({ source: nodes[i].id, target: nodes[t].id, rel: "synthetic" });
        }
      }
    }
    return { generatedAt: Date.now(), nodes, edges, typeStats: stats, kinds: [...kinds] };
  }

  override firstUpdated(): void {
    this.initRenderer();
  }

  override willUpdate(changed: PropertyValues): void {
    if (changed.has("secureCapable") && this.hasUpdated) this.syncLane();
  }

  override updated(changed: PropertyValues): void {
    // App embed: an empty graph or a load error still lifts the app's veil
    // (the page shows its own empty / error state).
    if (this.embed && !this.nativeReadySent && (changed.has("loading") || changed.has("error")) && !this.loading && (this.error || this.snapshot)) {
      if (this.error || this.snapshot?.nodes.length === 0) {
        this.nativeReadySent = true;
        postNative({ type: "ready", nodes: this.nodes.length, mode: this.mode });
      }
    }
    // Renderer flipped after mount (toolbar toggle / WebGL context loss).
    if (changed.has("mode") && this.rendererMode !== null && this.rendererMode !== this.mode) {
      this.initRenderer();
    }
    if (
      changed.has("snapshot") ||
      changed.has("enabledKinds") ||
      changed.has("enabledHealth") ||
      changed.has("search") ||
      changed.has("expanded") ||
      changed.has("groupMode")
    ) {
      this.rebuildSimulation();
    }
    if (
      this.stage &&
      (changed.has("selectedId") || changed.has("hoveredId") || changed.has("activeInsight") || changed.has("selection"))
    ) {
      this.stage.setFocus(this.selection.size > 1 ? (this.hoveredId ?? null) : (this.selectedId ?? this.hoveredId));
    }
    if (changed.has("hoverCardId") || changed.has("dialog") || changed.has("menu")) this.scheduleOverlay();
    if (changed.has("menu") && this.menu) this.fitMenu();
    if (changed.has("hudOpen") || changed.has("mode")) this.syncSafeInset();
  }

  /** Desktop: the Signals panel covers the stage's left edge — keep framed content out from under it. */
  private syncSafeInset(): void {
    if (!this.stage) return;
    const hud = this.querySelector<HTMLElement>(".kg-hud");
    const stageEl = this.querySelector<HTMLElement>(".kg-stage");
    if (!this.hudOpen || this.compact || this.isMobile() || !hud || !stageEl) {
      this.stage.setSafeInset(0);
      return;
    }
    // Rect units (same as the stage's own size, zoom included).
    const right = hud.getBoundingClientRect().right - stageEl.getBoundingClientRect().left;
    this.stage.setSafeInset(right > 0 ? right + 8 : 0);
  }

  // ── Renderer lifecycle (2D canvas or 3D stage) ────────────
  private initRenderer(): void {
    this.teardownRenderer();
    this.rendererMode = this.mode;
    if (this.mode === "3d") {
      const host = this.querySelector<HTMLElement>(".kg-3d-host");
      if (!host) return;
      try {
        this.stage = new KnowledgeGraph3DStage(host, this.stageCallbacks(), {
          reducedMotion: this.reducedMotion,
          mobile: this.isMobile(),
        });
        if (this.qualityPref !== "auto") this.stage.setQualityMode(this.qualityPref);
        if (!this.ambienceOn) this.stage.setAmbience(false);
        this.stage.setConnectionsMode(this.connectionsMode);
        requestAnimationFrame(() => this.syncSafeInset());
        if (!this.hullsOn) this.stage.setHullsVisible(false);
        if (this.linkMode || this.selectMode) this.stage.setInteractionModes({ link: this.linkMode, select: this.selectMode });
      } catch (err) {
        console.warn("[knowledge-graph] 3D stage unavailable, using the 2D map", err);
        this.stage = null;
        this.mode = "2d";
        return;
      }
      this.resizeObserver = new ResizeObserver(() => this.onResizeObserved());
      this.resizeObserver.observe(host);
      this.resizeCanvas();
      if (this.nodes.length) {
        this.syncStage();
        this.stage.resetView(this.anchorIds());
      }
      return;
    }
    this.canvas = this.querySelector<HTMLCanvasElement>(".kg-canvas");
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext("2d");
    this.attachCanvasEvents();
    this.resizeObserver = new ResizeObserver(() => this.onResizeObserved());
    this.resizeObserver.observe(this.canvas);
    this.resizeCanvas();
    this.refreshLiveFlag();
    this.scheduleDraw();
  }

  private teardownRenderer(): void {
    this.stage?.dispose();
    this.stage = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stopAnimLoop();
    this.canvas = null;
    this.ctx = null;
    this.lastSize = { w: 0, h: 0 };
  }

  private toggleRenderer(): void {
    const next: RendererMode = this.mode === "3d" ? "2d" : "3d";
    if (next === "3d" && !webglAvailable()) return;
    try {
      globalThis.localStorage?.setItem(RENDERER_KEY, next);
    } catch {
      /* preference just doesn't persist */
    }
    this.mode = next;
  }

  private isMobile(): boolean {
    try {
      const rect = this.getBoundingClientRect();
      return rect.width < 640 || window.matchMedia("(pointer: coarse)").matches;
    } catch {
      return false;
    }
  }

  private anchorIds(): string[] {
    // Sparse graphs (new installs, a few files + one project): frame everything,
    // otherwise a lone anchor zooms in and clips every other cluster.
    if (this.nodes.length <= SMALL_GRAPH_FIT_ALL) return this.nodes.map((n) => n.id);
    const ids = this.nodes.filter((n) => n.anchor).map((n) => n.id);
    return ids.length ? ids : this.nodes.map((n) => n.id);
  }

  /** Push the current graph (nodes, links, colours, orbits) to the 3D stage. */
  private syncStage(): void {
    if (!this.stage) return;
    this.stage.setGraph(this.nodes as StageNode[], stageLinksOf(this.links as never, this.v3) as StageLink[], this.center, this.orbitRadii);
    this.stage.setLayoutV3(stageLayoutV3Of(this.nodes, this.v3));
    this.syncGroups();
    this.syncRings();
    this.stage.setFocus(this.selectedId ?? this.hoveredId);
  }

  /** Halos for the active grouping (3D); the 2D map draws them in `draw()`. */
  private syncGroups(): void {
    if (!this.stage) return;
    this.stage.setGroups(stageGroupsOf(this.grouping, this.nodeById) as StageGroup[]);
  }

  /** Progress rings on every project + selection / drop-target bezels. */
  private syncRings(): void {
    if (!this.stage) return;
    this.stage.setRings(
      stageRingsOf(this.nodes, { selection: this.selection, selectedId: this.selectedId, dropTarget: this.dropTarget }) as StageRing[],
    );
  }

  private stageCallbacks(): StageCallbacks {
    return {
      onHover: (id) => this.setHovered(id),
      onSelect: (id, opts) => {
        this.menu = null;
        if (id && this.linkMode && this.tapLink(id)) return;
        if (id && opts?.additive) this.toggleSelected(id);
        else if (id) {
          this.selection = new Set([id]);
          this.selectNode(id, false);
          this.syncRings();
          this.peekOnTouch(id);
        } else this.clearSelection();
      },
      onDragOver: (index, target) => this.onDragOverNode(this.nodes[index], target >= 0 ? this.nodes[target] : undefined),
      onLinkStart: (index) => this.beginLinkDrag(this.nodes[index]),
      onLinkMove: (x, y, target) => this.moveLinkDrag(x, y, target >= 0 ? this.nodes[target] : undefined),
      onLinkEnd: (target) => void this.endLinkDrag(target >= 0 ? this.nodes[target] : undefined),
      onLasso: (pts, done) => this.onLasso(pts, done),
      onContextMenu: (id, x, y) => this.openMenu(id, x, y),
      onProjected: () => this.scheduleOverlay(),
      onOpen: (id) => {
        const n = this.nodeById.get(id);
        if (!n) return;
        this.selectedId = id;
        if (this.openRepoNode(n)) return;
        this.dispatchEvent(
          new CustomEvent("knowledge-graph:open", { detail: n, bubbles: true, composed: true }),
        );
      },
      onDragStart: (index) => {
        const n = this.nodes[index];
        if (!n) return;
        this.dragFrom = n.id;
        this.hideHoverCard();
        this.selectedId = n.id;
        if (this.worker) {
          this.worker.postMessage({ type: "drag", index, x: n.x, y: n.y, z: n.z });
          this.worker.postMessage({ type: "reheat", alpha: 0.2 });
        } else {
          this.simulation?.alphaTarget(0.2).restart();
        }
      },
      onDrag: (index, x, y, z) => {
        const n = this.nodes[index];
        if (!n) return;
        n.fx = x;
        n.fy = y;
        n.fz = z;
        n.z = z;
        this.quadDirty = true;
        if (this.worker) this.queueDrag(index, x, y, z);
      },
      onDragEnd: (index) => {
        const n = this.nodes[index];
        void this.finishNodeDrag(n);
        if (this.dragRaf !== null) {
          cancelAnimationFrame(this.dragRaf);
          this.dragRaf = null;
        }
        if (this.pendingDrag && this.worker) this.worker.postMessage({ type: "drag", ...this.pendingDrag });
        this.pendingDrag = null;
        if (n) {
          n.fx = null;
          n.fy = null;
          n.fz = null;
        }
        if (this.worker) this.worker.postMessage({ type: "dragEnd", index });
        else this.simulation?.alphaTarget(0);
        this.schedulePositionSave();
      },
      onUserMoved: () => {
        this.userMovedView = true;
      },
      onContextLost: () => {
        console.warn("[knowledge-graph] WebGL context lost — falling back to the 2D map");
        this.mode = "2d";
      },
      labelFor: (node, k) => {
        const n = node as SimNode;
        // The hover card already shows this node's title.
        if (n.id === this.hoverCardId) return null;
        const focusId = this.selectedId ?? this.hoveredId;
        const info = this.labelInfo(
          n,
          k,
          focusId,
          this.neighborhoodFor(focusId),
          k > LOD_MINOR_LABELS_ABOVE,
        );
        return info ? { text: info.text, pri: info.pri, cls: info.cls, scale: info.scale } : null;
      },
      emphasisFor: (node) => stageEmphasis(node as SimNode, this.focusState(), (id) => this.neighborhoodFor(id)),
      liveFor: (node) => isLiveNode(node as SimNode),
    };
  }

  // ── Data ──────────────────────────────────────────────────
  async refresh(force = false): Promise<void> {
    if (!this.client || this.synthCount > 0) return;
    if (this.repoMode && this.lane !== "secure") return this.refreshRepos(force);
    // Lanes never mix: a secure snapshot only ever loads into the secure lane.
    const secure = this.lane === "secure";
    const seq = ++this.refreshSeq;
    this.loading = true;
    this.error = null;
    const t0 = performance.now();
    try {
      const scoped = scopeRequestParams(this.projectScope);
      const raw = secure
        ? await this.client.request<unknown>("secure.graph.snapshot", scoped)
        : await this.client.request<unknown>("graph.global.snapshot", {
            types: Array.from(this.enabledKinds),
            ...scoped,
            ...(force ? { refresh: true } : {}),
          });
      if (seq !== this.refreshSeq || secure !== (this.lane === "secure")) return;
      this.scopeInfo = this.projectScope ? scopeInfoOf(raw) : null;
      const rpcMs = performance.now() - t0;
      const res = sanitizeSnapshot(raw) as (GraphSnapshot & { dropped: number }) | null;
      if (res) {
        if (res.dropped) console.debug(`[knowledge-graph] dropped ${res.dropped} malformed records`);
        // The secure graph is small and fully loaded: show every layer it
        // has (tasks are a lazy "heavy" layer in the normal graph).
        if (secure) {
          const missing = [...new Set(res.nodes.map((n) => n.kind))].filter((k) => !this.enabledKinds.has(k));
          if (missing.length) this.enabledKinds = new Set([...this.enabledKinds, ...missing]);
        }
        this.absorbSnapshot(res);
        this.queueScopeFocus();
        if (!secure && !this.projectScope) void this.refreshConsolidated(force);
        const perf = perfState();
        if (perf) perf.rpcMs = rpcMs;
        (globalThis as Record<string, unknown>).__kgRpcMs = rpcMs;
      }
    } catch (err) {
      if (seq !== this.refreshSeq) return;
      if (secure && isSecureLockedError(err)) {
        this.snapshot = null;
        this.rebuildSimulation();
      }
      this.error = secure ? friendlySecureError(err) : err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === this.refreshSeq) this.loading = false;
    }
  }

  /** Take a fresh snapshot: activity diff, optimistic edges reconciled, insights recomputed. */
  private absorbSnapshot(res: GraphSnapshot): void {
    const now = Date.now();
    const items = diffActivity(this.prevSnapshotNodes, res.nodes, now);
    if (items.length) this.activity = [...items, ...this.activity].slice(0, 40);
    this.prevSnapshotNodes = res.nodes;
    // Optimistic edges the gateway now reports (either direction) are done.
    if (this.localEdges.length) {
      const have = new Set(res.edges.map((e) => `${e.source}|${e.target}`));
      this.localEdges = this.localEdges.filter(
        (e) => !have.has(`${e.source}|${e.target}`) && !have.has(`${e.target}|${e.source}`) && now - Number(e.weight ?? now) < 120_000,
      );
    }
    this.snapshot = res;
  }

  /** Signals for the proactive HUD (gateway insights + graph-derived ones). */
  private recomputeInsights(): void {
    const t0 = performance.now();
    this.hudInsights = sceneInsights(
      { nodes: this.nodes, links: this.links as never, adjacency: this.adjacency, nodeById: this.nodeById },
      this.snapshot?.insights,
      Date.now(),
      this.dismissed,
    );
    const perf = perfState();
    if (perf) (perf as KgPerf & { insightsMs?: number }).insightsMs = performance.now() - t0;
  }

  /** Projects already consolidated (back-reference relations), so the map can hide them. */
  private async refreshConsolidated(force = false): Promise<void> {
    if (!this.client || this.synthCount > 0 || this.lane === "secure") return;
    const now = Date.now();
    if (!force && now - this.consolidatedAt < 60_000) return;
    this.consolidatedAt = now;
    try {
      const ids = new Set<string>();
      for (const q of [
        { fromType: "task", toType: "project", edge: "relates_to", limit: 20_000 },
        { fromType: "project", toType: "project", edge: "relates_to", limit: 20_000 },
      ]) {
        const r = (await this.client.request<{ relations?: RelationRow[] }>("objrel.list", q)) ?? {};
        for (const rel of r.relations ?? []) {
          const m = rel.meta ?? {};
          if (typeof m.convertedFromProjectId === "string") ids.add(m.convertedFromProjectId);
          if (typeof m.mergedIntoProjectId === "string" && rel.fromType === "project") ids.add(rel.fromId);
        }
      }
      const same = ids.size === this.consolidatedIds.size && [...ids].every((x) => this.consolidatedIds.has(x));
      if (!same) {
        this.consolidatedIds = ids;
        this.rebuildSimulation();
      }
    } catch {
      /* relations unavailable — show everything */
    }
  }

  /** Fetch one project's tasks and splice them into the graph. */
  private async expandProject(nodeId: string): Promise<void> {
    const node = this.snapshot?.nodes.find((n) => n.id === nodeId);
    const projectId = (node?.meta?.projectId as string | undefined) ?? nodeId.slice(8);
    if (!this.client || this.expanding.has(nodeId) || this.lane === "secure") return;
    this.expanding = new Set(this.expanding).add(nodeId);
    try {
      const raw = await this.client.request<unknown>("graph.global.snapshot", {
        types: ["project", "task"],
        taskProjectIds: [projectId],
        refresh: true,
      });
      const res = sanitizeSnapshot(raw);
      const nodes = (res?.nodes ?? []).filter((n) => n.kind === "task") as GraphNodeIn[];
      const ids = new Set(nodes.map((n) => n.id));
      const edges = (res?.edges ?? []).filter((e) => ids.has(e.target) && e.source === nodeId);
      const next = new Map(this.expanded);
      next.set(nodeId, { nodes, edges });
      this.expanded = next;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      const s = new Set(this.expanding);
      s.delete(nodeId);
      this.expanding = s;
    }
  }

  private collapseProject(nodeId: string): void {
    const next = new Map(this.expanded);
    next.delete(nodeId);
    this.expanded = next;
  }

  // ── Simulation ────────────────────────────────────────────
  private rebuildSimulation(): void {
    if (!this.snapshot) {
      this.stopSimulation();
      this.nodes = [];
      this.links = [];
      this.topoSig = "";
      return;
    }

    // Preserve positions of surviving nodes so refreshes relax IN PLACE.
    const prevPos = new Map<string, { x: number; y: number; z?: number }>();
    for (const n of this.nodes) {
      if (n.x != null && n.y != null) prevPos.set(n.id, { x: n.x, y: n.y, z: n.z });
    }

    const { w, h } = this.size;
    const cx = w / 2;
    const cy = h / 2;
    const q = this.search.trim().toLowerCase();
    // Filters, search, sizing, hierarchy, v3 layout and grouping — shared with
    // the native mobile graph (knowledge-graph-scene.ts).
    const scene = buildScene<SimNode>(
      {
        nodes: this.snapshot.nodes,
        edges: this.snapshot.edges,
        expanded: this.expanded.values(),
        localEdges: this.localEdges,
        enabledKinds: this.enabledKinds,
        // A project view shows every status and never hides the project itself.
        enabledHealth: this.projectScope ? new Set(ALL_HEALTH) : this.enabledHealth,
        search: this.search,
        consolidatedIds: this.projectScope ? new Set<string>() : this.consolidatedIds,
        showConsolidated: this.showConsolidated,
        groupMode: this.groupMode,
        aspect: this.layoutAspect(),
      },
      (base) => base as SimNode,
    );
    const { nodes, adjacency, relations, degree, orbits, v3, grouping, workerLinks } = scene;
    const links = scene.links as SimLink[];
    const nodeIndex = scene.nodeById;
    const mode = this.groupMode;
    this.searchMatchIds = scene.searchMatchIds;
    this.projectParent = scene.projectParent;
    this.grouping = grouping;
    this.v3 = v3;
    const sectored = false;
    const targets: Map<string, { x: number; y: number; r: number }> | null = sectored ? groupTargets(grouping.groups, { cx, cy }) : null;
    const newSig = scene.sig;

    // Refresh-driven data that doesn't change the layout.
    this.relations = relations;

    // ── Benign-refresh fast-path ──────────────────────────────────────────
    // Same topology: do NOT touch the simulation — just patch per-node
    // metadata (status colours, rollups, live pulse) and repaint once.
    if (
      newSig === this.topoSig &&
      this.nodes.length === nodes.length &&
      (this.worker || this.simulation)
    ) {
      for (const n of nodes) {
        const cur = this.nodeById.get(n.id);
        if (cur) {
          cur.meta = n.meta;
          cur.label = n.label;
          cur.color = n.color;
          cur.health = n.health;
        }
      }
      this.refreshLiveFlag();
      this.syncStage();
      this.recomputeInsights();
      this.requestUpdate();
      this.scheduleDraw();
      return;
    }

    // First build of this session: restore the saved layout (no reshuffle on
    // reload). v3 layouts are deterministic, so they need no saved positions.
    if (prevPos.size === 0 && !v3) {
      const saved = loadPositions();
      if (saved.size) {
        for (const n of nodes) {
          const p = saved.get(n.id);
          if (p) prevPos.set(n.id, { x: cx + p[0], y: cy + p[1], z: p[2] });
        }
      }
    }
    const hadLayout = prevPos.size > 0;
    this.topoSig = newSig;
    this.center = { cx, cy };
    // Every node has an absolute v3 target (brain space == world space).
    const brain = v3;
    for (const n of nodes) n.orbit = undefined;
    // Orbit guide rings only mean something in the status-orbit layout.
    this.orbitRadii = this.groupMode === "orbit" ? v3.orbitRadii : [];
    this.pendingSearchFit = !!q;

    // Seed positions: survivors keep theirs; new projects land on their
    // orbit, new satellites next to a positioned neighbour.
    let spiral = 0;
    for (const n of nodes) {
      const prev = prevPos.get(n.id);
      if (prev) {
        n.x = prev.x;
        n.y = prev.y;
        n.z = prev.z;
      } else if (brain) {
        const i = n.index!;
        n.x = cx + brain.target[i * 3];
        n.y = cy + brain.target[i * 3 + 2];
        n.z = brain.target[i * 3 + 1];
      } else if (n.orbit != null && n.kind === "project") {
        const angle = n.index! * 2.399963;
        n.x = cx + n.orbit * Math.cos(angle);
        n.y = cy + n.orbit * Math.sin(angle);
      }
    }
    for (const n of nodes) {
      if (n.x != null) continue;
      const nb = [...(adjacency.get(n.id) ?? [])]
        .map((id) => nodeIndex.get(id))
        .find((m) => m?.x != null);
      const j = (n.index! * 2654435761) >>> 0;
      if (nb) {
        const a = (j % 628) / 100;
        n.x = nb.x! + Math.cos(a) * (18 + (j % 20));
        n.y = nb.y! + Math.sin(a) * (18 + (j % 20));
      } else {
        const angle = spiral * 2.399963;
        const rad = (n.orbit ?? 40) + 6 * Math.sqrt(spiral);
        n.x = cx + rad * Math.cos(angle);
        n.y = cy + rad * Math.sin(angle);
        spiral++;
      }
    }

    this.adjacency = adjacency;
    this.focusNeighborhood = null;
    this.focusNeighborhoodId = null;
    // Drop selections that left the graph (filters / deletes).
    if (this.selection.size) {
      const kept = [...this.selection].filter((id) => nodeIndex.has(id));
      if (kept.length !== this.selection.size) this.selection = new Set(kept);
    }
    this.nodes = nodes;
    this.nodeById = nodeIndex;
    this.links = links;
    this.degree = degree;
    this.quadDirty = true;
    this.rebuildHighlight();
    this.refreshLiveFlag();
    // True 3D galaxy: seeded heights (hubs on tilted status shells, satellites
    // in clouds around their hub). Survivors keep their simulated height.
    const neighbors: number[][] = nodes.map((n) =>
      [...(adjacency.get(n.id) ?? [])].map((id) => nodeIndex.get(id)?.index).filter((i): i is number => i != null),
    );
    let ring = 0;
    if (targets) for (const t of targets.values()) ring = Math.max(ring, Math.hypot(t.x - cx, t.y - cy));
    // v3: every node has an absolute target (height = world Y).
    const plans: ZPlan[] = brain
      ? nodes.map((_, i) => ({ gz: brain.target[i * 3 + 1], parent: -1, zOff: 0, zs: 0.3 }))
      : planGalaxy(nodes, neighbors, {
          scale: targets ? Math.max(ring, 220) : orbits.backlog,
          groupZ: targets ? groupHeights(targets.keys(), ring) : undefined,
        });
    const heights = seedHeights(plans, nodes.map((n) => (prevPos.has(n.id) ? n.z : undefined)));
    nodes.forEach((n, i) => {
      n.plan = plans[i];
      n.z = heights[i];
      n.vz = 0;
    });
    const modeSwitch = this.groupChanged;
    this.syncStage();
    this.recomputeInsights();
    if (!hadLayout || modeSwitch) {
      // A new mode is a new map: frame it (the user asked for it).
      if (modeSwitch) this.userMovedView = false;
      if (this.stage) this.stage.resetView(this.anchorIds());
      else this.fitToOrbits(orbits.stray);
    }
    this.requestUpdate();

    // Profiling hook — lets a headless harness read layout/frame timings.
    const prevRpc = perfState()?.rpcMs;
    (globalThis as Record<string, unknown>).__kgPerf = {
      nodes: nodes.length,
      edges: links.length,
      layoutMode: this.forceMainThreadLayout ? "main" : "worker",
      warmRestart: hadLayout,
      layoutStartedAt: performance.now(),
      firstPaintAt: null,
      settledAt: null,
      frames: 0,
      rpcMs: prevRpc ?? ((globalThis as Record<string, unknown>).__kgRpcMs as number | undefined),
    } satisfies KgPerf;

    // Nodes glide from where they were to their v3 targets (a new mode or new
    // data); a fresh load starts on target and barely moves. No pins: the
    // layout is deterministic, the worker snaps to targets when it settles.
    const alpha = hadLayout ? 0.5 : 0.04;
    const pinned = nodes.map(() => false);
    this.groupChanged = false;
    this.pinsHeld = false;
    this.brainMode = mode === "brain";
    this.groupTargetsByIndex = brain
      ? nodes.map((_, i) => ({ gx: cx + brain.target[i * 3], gy: cy + brain.target[i * 3 + 2], gs: 0.3 }))
      : targets
      ? nodes.map((n) => {
          const t = n.group ? targets.get(n.group) : undefined;
          return t ? { gx: t.x, gy: t.y, gs: n.anchor ? 0.16 : 0.1 } : null;
        })
      : null;
    this.stopSimulation();
    if (!this.forceMainThreadLayout && this.startWorkerLayout(workerLinks, alpha, pinned)) {
      this.scheduleDraw();
      return;
    }
    this.startMainThreadLayout(nodes, links, alpha);
  }

  /** Sub-project index → parent project index (hierarchy links). */
  private projectParent = new Map<number, number>();
  /** v3 layout of the current graph (targets, units, regions, bundles). */
  private v3: V3Layout | null = null;
  /** Brain mode: 3D volume layout (no 2D collide — nodes are apart in 3D). */
  private brainMode = false;
  /** Per-node sector targets for the worker (null when not sector-grouped). */
  private groupTargetsByIndex: Array<{ gx: number; gy: number; gs: number } | null> | null = null;
  /** Set when the grouping mode changes so anchors aren't pinned in their old spots. */
  private groupChanged = false;

  /** Canvas aspect seen by the map camera (steep view ≈ 0.84 foreshortening). */
  private layoutAspect(): number {
    return layoutAspectFor(this.size.w, this.size.h);
  }

  private chargeFor(n: SimNode): number {
    if (n.kind === "project") return -240;
    if (n.kind === "client") return -200;
    if (n.kind === "task") return -35;
    return -70;
  }

  /** Spin up the layout worker. Returns false if construction failed. */
  private startWorkerLayout(
    workerLinks: { source: number; target: number; weight: number; distance: number; strength: number }[],
    alpha: number,
    pinned: boolean[],
  ): boolean {
    try {
      this.worker?.terminate();
      this.worker = new LayoutWorker();
    } catch (err) {
      console.warn("[knowledge-graph] layout worker unavailable, using main thread", err);
      this.worker = null;
      return false;
    }
    const { w, h } = this.size;
    this.worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type: string; positions?: Float32Array };
      if (msg.type === "tick" && msg.positions) {
        const p = msg.positions;
        const ns = this.nodes;
        for (let n = 0; n < ns.length; n++) {
          if (this.dragging && this.dragging.index === n) continue;
          ns[n].x = p[n * 3];
          ns[n].y = p[n * 3 + 1];
          ns[n].z = p[n * 3 + 2];
        }
        this.quadDirty = true;
        this.stage?.markPositionsDirty();
        this.scheduleDraw();
      } else if (msg.type === "end") {
        this.onLayoutSettled();
      }
    };
    this.worker.onerror = (err) => {
      console.warn("[knowledge-graph] worker error, falling back", err);
      this.worker?.terminate();
      this.worker = null;
      this.startMainThreadLayout(this.nodes, this.links);
    };
    this.worker.postMessage({
      type: "init",
      nodes: this.nodes.map((n, i) => ({
        r: n.r,
        x: n.x,
        y: n.y,
        z: n.z,
        plan: n.plan,
        orbit: n.orbit,
        orbitStrength: n.kind === "project" ? 0.09 : 0.03,
        charge: this.v3 ? -4 : this.chargeFor(n),
        pinned: pinned[i],
        ...(this.groupTargetsByIndex?.[i] ?? {}),
      })),
      // Brain: links pull hard inside a family (cluster) and barely across
      // families, so clusters stay compact and apart.
      // v3: targets place everything; links only add a whisper of springiness.
      links: this.v3 ? workerLinks.map((l) => ({ ...l, strength: l.strength * 0.02 })) : workerLinks,
      w,
      h,
      alpha,
      opts: this.v3 ? { centerStrength: 0, chargeRange: 24, collide: !this.brainMode, snap: true } : {},
    });
    return true;
  }

  /** Legacy main-thread simulation — graceful degradation only. */
  private startMainThreadLayout(nodes: SimNode[], links: SimLink[], alpha = 1): void {
    const { w, h } = this.size;
    this.simulation = forceSimulation<SimNode>(nodes)
      .alpha(alpha)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => ((l.source as SimNode).kind === "task" || (l.target as SimNode).kind === "task" ? 26 : 50))
          .strength((l) => (l.inferred ? 0.1 : 0.3)),
      )
      .force("charge", forceManyBody<SimNode>().strength((d) => this.chargeFor(d)).distanceMax(380).theta(0.9))
      .force("center", forceCenter(w / 2, h / 2).strength(0.05))
      .force("collide", forceCollide<SimNode>((d) => d.r + 2))
      .force(
        "orbit",
        forceRadial<SimNode>((d) => d.plan?.orbitXY ?? d.orbit ?? 0, w / 2, h / 2).strength((d) =>
          d.orbit == null ? 0 : d.kind === "project" ? 0.09 : 0.03,
        ),
      )
      .force("groupX", this.groupTargetsByIndex ? forceX<SimNode>((d) => this.groupTargetsByIndex?.[d.index!]?.gx ?? w / 2).strength((d) => this.groupTargetsByIndex?.[d.index!]?.gs ?? 0) : null)
      .force("groupY", this.groupTargetsByIndex ? forceY<SimNode>((d) => this.groupTargetsByIndex?.[d.index!]?.gy ?? h / 2).strength((d) => this.groupTargetsByIndex?.[d.index!]?.gs ?? 0) : null)
      // Height axis (2D links here, but z still follows the galaxy plan).
      .force("zPlan", zPlanForce() as never)
      .force("zIntegrate", zIntegrateForce(VELOCITY_DECAY) as never)
      .velocityDecay(VELOCITY_DECAY)
      .alphaDecay(0.04)
      .on("tick", () => {
        this.quadDirty = true; // lazy — tree rebuilt on next pick, not per tick
        this.stage?.markPositionsDirty();
        this.scheduleDraw();
      })
      .on("end", () => this.onLayoutSettled());
  }

  private onLayoutSettled(): void {
    const perf = perfState();
    if (perf && perf.settledAt == null) perf.settledAt = performance.now();
    // Main-thread fallback: land exactly on the v3 targets (the worker does this itself).
    if (!this.worker && this.v3 && this.v3.target.length === this.nodes.length * 3) {
      const t = this.v3.target;
      for (const n of this.nodes) {
        if (n.fx != null) continue;
        const i = n.index!;
        n.x = this.center.cx + t[i * 3];
        n.y = this.center.cy + t[i * 3 + 2];
        n.z = t[i * 3 + 1];
      }
      this.quadDirty = true;
    }
    this.schedulePositionSave();
    if (this.pinsHeld) {
      this.worker?.postMessage({ type: "unpin" });
      this.pinsHeld = false;
    }
    this.stage?.markPositionsDirty();
    if (this.pendingSearchFit) {
      // Search fly-to: frame the matches (their neighbours stay as context).
      this.pendingSearchFit = false;
      if (this.searchMatchIds?.size) {
        this.fitTo(this.searchMatchIds, 1.6);
        return;
      }
    }
    if (this.pendingDeepFocus && this.nodeById.has(this.pendingDeepFocus.id)) {
      const { id } = this.pendingDeepFocus;
      this.pendingDeepFocus = null;
      this.needsFit = false;
      this.focusDeepLinked(id);
      return;
    }
    if (this.needsFit && !this.userMovedView) {
      this.needsFit = false;
      this.resetView();
    }
    this.notifyNativeReady();
  }

  /**
   * Deep link / native request: turn on a layer, switch the grouping, then
   * fly to a node (now if it is laid out, else once the layout settles).
   */
  private applyDeepLink(link: KgDeepLink, live = true): void {
    if (link.group && GROUP_IDS.includes(link.group as GroupMode)) this.setGroupMode(link.group as GroupMode);
    const layer = link.layer as GraphNodeKind | null;
    if (layer && (KIND_ORDER as readonly string[]).includes(layer) && !this.enabledKinds.has(layer)) {
      // Before the first snapshot just widen the set (the first fetch picks it up).
      if (!live || !this.snapshot) this.enabledKinds = new Set([...this.enabledKinds, layer]);
      else this.toggleKind(layer);
    }
    let focus = link.focus;
    if (!focus && layer) {
      // A layer without a node: frame that layer once it is laid out.
      this.pendingLayerFit = layer;
    }
    if (!focus) return;
    if (!focus.includes(":") && this.nodeById.has(`project:${focus}`)) focus = `project:${focus}`;
    if (live && this.nodeById.has(focus) && this.nodes.length) this.focusDeepLinked(focus);
    else this.pendingDeepFocus = { id: focus, family: link.family };
  }

  private pendingLayerFit: GraphNodeKind | null = null;
  private unlistenHost: (() => void) | null = null;

  /** A command from the app (RN `__kgEmbed.*` or the web export's postMessage). */
  private onHostCommand(c: HostCommand): void {
    switch (c.cmd) {
      case "focus":
        this.applyDeepLink({ focus: c.id, family: c.family, layer: null, group: null });
        break;
      case "apply":
        this.applyDeepLink(c.link);
        break;
      case "fit":
        this.resetView();
        break;
      case "back":
        if (!this.closeTopmost()) postNative({ type: "back" });
        break;
    }
  }

  /**
   * Phone back: close the topmost layer (menu/dialog → AI drawer → settings →
   * HUD sheet → peek/detail → link/select mode). False when nothing was open.
   */
  private closeTopmost(): boolean {
    if (this.menu || this.dialog || this.statusMenu) {
      this.menu = null;
      this.dialog = null;
      this.statusMenu = false;
      return true;
    }
    if (this.aiOpen) {
      this.aiOpen = false;
      return true;
    }
    if (this.settingsOpen) {
      this.settingsOpen = false;
      return true;
    }
    if (this.hudOpen && this.isMobile()) {
      this.toggleHud();
      return true;
    }
    if (this.linkMode || this.selectMode) {
      this.setModes(false, false);
      return true;
    }
    if (this.hoverCardId || this.selection.size || this.selectedId || this.activeInsight) {
      this.hideHoverCard();
      this.clearSelection();
      this.setInsight(null);
      return true;
    }
    return false;
  }

  private focusDeepLinked(id: string): void {
    this.selection = new Set([id]);
    this.touchPeek = this.embed;
    this.peekId = this.embed ? id : null;
    this.selectNode(id, true);
    this.syncRings();
    if (this.scopeQuietFocus) {
      // Ring + camera only: the card would cover most of a phone's stage.
      this.scopeQuietFocus = false;
      this.peekId = id;
      this.hoverCardId = null;
      this.notifyNativeReady();
      return;
    }
    if (this.embed) {
      this.hoverCardId = id;
      this.scheduleOverlay();
    }
    this.notifyNativeReady();
  }

  /** Tell the app the graph is up (once): it hides its own loading veil. */
  private notifyNativeReady(): void {
    if (this.nativeReadySent || !this.embed || !this.nodes.length) return;
    this.nativeReadySent = true;
    postNative({ type: "ready", nodes: this.nodes.length, mode: this.mode });
    if (this.pendingLayerFit) {
      const kind = this.pendingLayerFit;
      this.pendingLayerFit = null;
      const ids = this.nodes.filter((n) => n.kind === kind).map((n) => n.id);
      if (ids.length) this.fitTo(ids, 1.6);
    }
  }

  private stopSimulation(): void {
    this.simulation?.stop();
    this.simulation = null;
    this.worker?.postMessage({ type: "stop" });
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  // ── Render ────────────────────────────────────────────────
  private scheduleDraw(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.draw();
    });
  }

  private onResizeObserved(): void {
    if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
    this.resizeDebounce = setTimeout(() => {
      this.resizeDebounce = null;
      this.resizeCanvas();
      // The canvas settled into a new size (phone layout, sidebar toggle):
      // re-frame the overview unless the user already moved the camera.
      if (this.stage && this.v3 && this.nodes.length && !this.userMovedView) this.stage.resetView(this.anchorIds());
    }, 120);
  }

  private resizeCanvas(): void {
    const el: HTMLElement | null = this.stage ? this.querySelector<HTMLElement>(".kg-3d-host") : this.canvas;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.max(rect.width, 100);
    const h = Math.max(rect.height, 100);
    if (Math.abs(w - this.lastSize.w) < 2 && Math.abs(h - this.lastSize.h) < 2 && this.lastSize.w) {
      return;
    }
    const firstSize = this.lastSize.w === 0;
    const prev = this.lastSize;
    this.lastSize = { w, h };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = { w, h };
    if (this.stage) {
      this.stage.resize();
      if (firstSize && this.nodes.length) this.rebuildSimulation();
      return;
    }
    if (!this.canvas) return;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    if (!firstSize) {
      // Keep the view centred instead of reheating the layout.
      this.viewport = {
        ...this.viewport,
        x: this.viewport.x + (w - prev.w) / 2,
        y: this.viewport.y + (h - prev.h) / 2,
      };
    } else if (this.nodes.length) {
      this.rebuildSimulation();
    }
    this.scheduleDraw();
  }

  /** Rebuild the hit-test quadtree only if positions changed since last pick. */
  private ensureQuadtree(): void {
    if (!this.quadDirty && this.quad) return;
    this.quad = quadtree<SimNode>()
      .x((d) => d.x ?? 0)
      .y((d) => d.y ?? 0)
      .addAll(this.nodes);
    this.quadDirty = false;
  }

  private refreshLiveFlag(): void {
    this.hasLive = this.nodes.some(
      (n) => (n.kind === "project" && n.meta?.live === true) || (n.kind === "run" && n.meta?.active === true),
    );
    if (this.hasLive) this.maybeStartAnimLoop();
  }

  private rebuildHighlight(): void {
    this.highlightSet = highlightSetOf(this.activeInsight, this.nodeById, this.adjacency);
  }

  /** Focus / multi-selection / insight state for the shared emphasis rules. */
  private focusState() {
    return {
      selection: this.selection,
      selectedId: this.selectedId,
      hoveredId: this.hoveredId,
      adjacency: this.adjacency,
      highlightSet: this.highlightSet,
      activeInsight: this.activeInsight,
    };
  }

  /** 0..1 visibility of a node given focus / highlight state. */
  private emphasis(n: SimNode, focusId: string | null, nbh: Set<string> | null): number {
    return emphasisOf(n, focusId, nbh, this.focusState());
  }

  private baseEmphasis(n: SimNode, focusId: string | null, nbh: Set<string> | null): number {
    return baseEmphasis(n, focusId, nbh, this.focusState());
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || this.stage) return;
    const drawStart = performance.now();
    const perf = perfState();
    if (perf) {
      perf.frames += 1;
      if (perf.firstPaintAt == null) perf.firstPaintAt = performance.now();
    }
    const { w, h } = this.size;
    // The flat map is shared with the native app (knowledge-graph-map2d).
    const { visible } = drawMap2d<SimNode>(ctx, {
      w,
      h,
      dpr: this.dpr,
      viewport: this.viewport,
      center: { cx: w / 2, cy: h / 2 },
      nodes: this.nodes,
      links: this.links as Array<Map2DLink<SimNode>>,
      nodeById: this.nodeById,
      grouping: this.grouping,
      groupMode: this.groupMode,
      search: this.search,
      connectionsMode: this.connectionsMode,
      selection: this.selection,
      dropTarget: this.dropTarget,
      selectedId: this.selectedId,
      hoveredId: this.hoveredId,
      hoverScale: this.hoverScale,
      dashPhase: this.dashPhase,
      reducedMotion: this.reducedMotion,
      now: performance.now(),
      emphasis: (n, focusId, nbh) => this.emphasis(n, focusId, nbh),
      neighbourhood: (id) => this.neighborhoodFor(id),
      labelInfo: (n, k, focusId, nbh, minorOk) => this.labelInfo(n, k, focusId, nbh, minorOk),
      labelWidth: (font, text, c) => this.labelWidth(font, text, c),
    });
    if (this.dragLine || this.dropTarget || this.hoverCardId || this.lassoPts) this.positionOverlays();

    if (perf) {
      const ms = performance.now() - drawStart;
      perf.lastDrawMs = ms;
      perf.avgDrawMs = perf.avgDrawMs == null ? ms : perf.avgDrawMs * 0.9 + ms * 0.1;
      perf.maxDrawMs = Math.max(perf.maxDrawMs ?? 0, ms);
      perf.visibleCount = visible.length;
    }
  }

  /** 1-hop neighbourhood (incl. the node itself) of the focused node, cached. */
  private neighborhoodFor(focusId: string | null): Set<string> | null {
    if (!focusId) return null;
    if (this.focusNeighborhoodId === focusId && this.focusNeighborhood) {
      return this.focusNeighborhood;
    }
    const set = neighbourhoodOf(this.adjacency, focusId);
    this.focusNeighborhood = set;
    this.focusNeighborhoodId = focusId;
    return set;
  }

  private labelWidth(font: string, text: string, ctx: CanvasRenderingContext2D): number {
    const key = `${font}|${text}`;
    let wv = this.labelWidths.get(key);
    if (wv == null) {
      ctx.font = font;
      wv = ctx.measureText(text).width;
      if (this.labelWidths.size > 5000) this.labelWidths.clear();
      this.labelWidths.set(key, wv);
    }
    return wv;
  }

  /**
   * Label text / priority / style for a node at zoom `k` (2D: viewport zoom;
   * 3D: per-node distance-derived zoom equivalent), or null when it earns no
   * label. Shared by the canvas renderer and the 3D stage's DOM label pool
   * so both views agree on what gets named.
   */
  private labelInfo(
    n: SimNode,
    k: number,
    focusId: string | null,
    nbh: Set<string> | null,
    minorOk: boolean,
  ): LabelInfo | null {
    return labelInfo2d(n, k, { focusId, nbh, highlightSet: this.highlightSet, minorOk, degree: this.degree, stage3d: !!this.stage });
  }

  // ── Continuous animation (hover spring, marching ants, live pulse) ──
  private maybeStartAnimLoop(): void {
    if (this.reducedMotion || this.stage) return; // the 3D stage runs its own loop
    if (this.animId !== null) return;
    const tick = (): void => {
      let busy = false;
      let smooth = false;
      if (Math.abs(this.hoverScale - this.hoverScaleTarget) > 0.001) {
        this.hoverScale += (this.hoverScaleTarget - this.hoverScale) * 0.25;
        busy = smooth = true;
      } else {
        this.hoverScale = this.hoverScaleTarget;
      }
      const focusId = this.selectedId ?? this.hoveredId;
      if (focusId && this.adjacency.has(focusId)) {
        this.dashPhase = (this.dashPhase + 0.6) % 1000;
        busy = smooth = true;
      }
      if (this.hasLive && this.isConnected) busy = true;
      // A pulse alone doesn't need 60fps — ~30fps keeps it smooth and cheap.
      const t = performance.now();
      if (smooth || t - this.lastAnimDraw > 33) {
        this.lastAnimDraw = t;
        this.draw();
      }
      this.animId = busy ? requestAnimationFrame(tick) : null;
    };
    this.animId = requestAnimationFrame(tick);
  }
  private stopAnimLoop(): void {
    if (this.animId !== null) cancelAnimationFrame(this.animId);
    this.animId = null;
  }

  // ── Interaction ───────────────────────────────────────────
  private attachCanvasEvents(): void {
    const c = this.canvas;
    if (!c) return;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    c.addEventListener("pointerleave", this.onPointerLeave);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("dblclick", this.onDoubleClick);
    c.addEventListener("contextmenu", this.onContextMenu2d);
  }

  private worldCoords(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas!.getBoundingClientRect();
    const x = (clientX - rect.left - this.viewport.x) / this.viewport.k;
    const y = (clientY - rect.top - this.viewport.y) / this.viewport.k;
    return { x, y };
  }

  private hitTest(x: number, y: number): SimNode | null {
    this.ensureQuadtree();
    if (!this.quad) return null;
    const found = this.quad.find(x, y, Math.max(10 / this.viewport.k, 20));
    if (!found) return null;
    const d = Math.hypot((found.x ?? 0) - x, (found.y ?? 0) - y);
    return d <= found.r + 6 / this.viewport.k ? found : null;
  }

  private canvasLocal(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /** Nearest node under (x, y) in world space, skipping `exclude`. */
  private hitTestExcept(x: number, y: number, exclude: SimNode | null): SimNode | null {
    this.ensureQuadtree();
    if (!this.quad) return null;
    const reach = Math.max(10 / this.viewport.k, 20) + 40;
    let best: SimNode | null = null;
    let bestD = Infinity;
    this.quad.visit((node, x0, y0, x1, y1) => {
      if (!("length" in node)) {
        let leaf: typeof node | undefined = node;
        while (leaf) {
          const d = leaf.data;
          if (d !== exclude) {
            const dist = Math.hypot((d.x ?? 0) - x, (d.y ?? 0) - y);
            if (dist <= d.r + 6 / this.viewport.k && dist < bestD) {
              best = d;
              bestD = dist;
            }
          }
          leaf = leaf.next;
        }
      }
      return x0 > x + reach || x1 < x - reach || y0 > y + reach || y1 < y - reach;
    });
    return best;
  }

  private onContextMenu2d = (e: MouseEvent): void => {
    e.preventDefault();
    const { x, y } = this.worldCoords(e.clientX, e.clientY);
    const l = this.canvasLocal(e);
    this.openMenu(this.hitTest(x, y)?.id ?? null, l.x, l.y);
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button === 2) return;
    this.canvas?.setPointerCapture(e.pointerId);
    this.menu = null;
    this.lastPointerType = e.pointerType || "mouse";
    this.longPress2dFired = false;
    if (e.pointerType === "touch") {
      this.touch2d.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touch2d.size >= 2) {
        this.startPinch2d();
        return;
      }
    }
    const { x, y } = this.worldCoords(e.clientX, e.clientY);
    const node = this.hitTest(x, y);
    if (e.pointerType !== "mouse") {
      // Touch long-press = right-click (context menu).
      if (this.longPress2d) clearTimeout(this.longPress2d.timer);
    if (this.readyFallback) clearInterval(this.readyFallback);
    this.readyFallback = null;
      const l = this.canvasLocal(e);
      const id = node?.id ?? null;
      this.longPress2d = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          this.longPress2d = null;
          this.longPress2dFired = true;
          this.cancel2dGesture();
          this.openMenu(id, l.x, l.y);
        }, 520),
      };
    }
    if (node && (e.ctrlKey || e.metaKey || this.linkMode)) {
      this.linkDrag2d = { node };
      this.beginLinkDrag(node);
      return;
    }
    if (!node && (e.shiftKey || this.selectMode)) {
      const l = this.canvasLocal(e);
      this.lasso2d = true;
      this.lassoPts = [l.x, l.y];
      return;
    }
    if (node) {
      this.dragging = { node, index: node.index ?? 0, moved: false };
      if (!e.shiftKey) {
        this.selectedId = node.id;
        if (!this.selection.has(node.id)) this.selection = new Set([node.id]);
      }
      this.focusNeighborhood = null;
      this.focusNeighborhoodId = null;
      this.maybeStartAnimLoop();
      this.scheduleDraw();
    } else {
      this.pan = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: this.viewport.x,
        baseY: this.viewport.y,
      };
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.touch2d.has(e.pointerId)) this.touch2d.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch2d) {
      this.movePinch2d();
      return;
    }
    if (this.longPress2d && Math.hypot(e.clientX - this.longPress2d.x, e.clientY - this.longPress2d.y) > 8) {
      clearTimeout(this.longPress2d.timer);
      this.longPress2d = null;
    }
    if (this.linkDrag2d) {
      const { x, y } = this.worldCoords(e.clientX, e.clientY);
      const l = this.canvasLocal(e);
      this.moveLinkDrag(l.x, l.y, this.hitTestExcept(x, y, this.linkDrag2d.node) ?? undefined);
      return;
    }
    if (this.lasso2d && this.lassoPts) {
      const l = this.canvasLocal(e);
      const n = this.lassoPts.length;
      if (Math.hypot(l.x - this.lassoPts[n - 2], l.y - this.lassoPts[n - 1]) >= 4) {
        this.lassoPts.push(l.x, l.y);
        this.onLasso(this.lassoPts, false);
      }
      return;
    }
    if (this.dragging) {
      const { x, y } = this.worldCoords(e.clientX, e.clientY);
      const node = this.dragging.node;
      if (!this.dragging.moved) {
        // Only start a real drag (and reheat) once the pointer actually moves,
        // so a plain click to select never jiggles the settled layout.
        if (Math.hypot(x - (node.x ?? 0), y - (node.y ?? 0)) < 3 / this.viewport.k) return;
        this.dragging.moved = true;
        this.dragFrom = node.id;
        this.hideHoverCard();
        if (this.worker) {
          this.worker.postMessage({ type: "drag", index: this.dragging.index, x, y });
          this.worker.postMessage({ type: "reheat", alpha: 0.2 });
        } else {
          this.simulation?.alphaTarget(0.2).restart();
        }
      }
      node.fx = x;
      node.fy = y;
      node.x = x;
      node.y = y;
      this.quadDirty = true;
      if (this.worker) this.queueDrag(this.dragging.index, x, y);
      this.onDragOverNode(node, this.hitTestExcept(x, y, node) ?? undefined);
      this.scheduleDraw();
    } else if (this.pan) {
      this.userMovedView = true;
      this.viewport = {
        ...this.viewport,
        x: this.pan.baseX + (e.clientX - this.pan.startX),
        y: this.pan.baseY + (e.clientY - this.pan.startY),
      };
      this.scheduleDraw();
      this.scheduleOverlay();
    } else {
      const { x, y } = this.worldCoords(e.clientX, e.clientY);
      const node = this.hitTest(x, y);
      this.setHovered(node?.id ?? null);
    }
  };

  private setHovered(id: string | null): void {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.queueHoverCard(id);
    if (this.canvas) this.canvas.style.cursor = id ? "pointer" : "grab";
    this.hoverScaleTarget = id ? 1.1 : 1;
    if (this.reducedMotion) {
      this.hoverScale = this.hoverScaleTarget;
      this.scheduleDraw();
    } else {
      this.maybeStartAnimLoop();
    }
  }

  private onPointerLeave = (): void => {
    if (!this.dragging && !this.pan) this.setHovered(null);
  };

  private queueDrag(index: number, x: number, y: number, z?: number): void {
    this.pendingDrag = { index, x, y, z };
    if (this.dragRaf !== null) return;
    this.dragRaf = requestAnimationFrame(() => {
      this.dragRaf = null;
      const d = this.pendingDrag;
      this.pendingDrag = null;
      if (d && this.worker) this.worker.postMessage({ type: "drag", ...d });
    });
  }

  private onPointerUp = (e: PointerEvent): void => {
    this.canvas?.releasePointerCapture(e.pointerId);
    this.touch2d.delete(e.pointerId);
    if (this.longPress2d) {
      clearTimeout(this.longPress2d.timer);
      this.longPress2d = null;
    }
    if (this.pinch2d) {
      // Lifting one finger ends the pinch; the other finger does nothing more.
      if (this.touch2d.size < 2) this.pinch2d = null;
      return;
    }
    if (this.longPress2dFired) {
      this.longPress2dFired = false;
      return;
    }
    if (this.linkDrag2d) {
      const from = this.linkDrag2d.node;
      this.linkDrag2d = null;
      const { x, y } = this.worldCoords(e.clientX, e.clientY);
      const target = this.hitTestExcept(x, y, from);
      if (this.dragLine && this.dragLine.targetId == null && !target) {
        this.dragLine = null;
        this.scheduleOverlay();
        // Link mode: a tap picks the source, the next tap the target.
        if (this.linkMode && !e.ctrlKey && !e.metaKey) this.tapLink(from.id);
        // A Ctrl+click without a drag toggles the node in the selection.
        else this.toggleSelected(from.id);
        return;
      }
      void this.endLinkDrag(target ?? undefined);
      return;
    }
    if (this.lasso2d) {
      this.lasso2d = false;
      const pts = this.lassoPts ?? [];
      if (pts.length >= 6) this.onLasso(pts, true);
      else {
        this.onLasso([], true);
        if (!e.shiftKey) this.clearSelection();
      }
      return;
    }
    if (this.dragging) {
      if (this.dragRaf !== null) {
        cancelAnimationFrame(this.dragRaf);
        this.dragRaf = null;
      }
      const node = this.dragging.node;
      if (this.dragging.moved) {
        if (this.pendingDrag && this.worker) {
          this.worker.postMessage({ type: "drag", ...this.pendingDrag });
        }
        node.fx = null;
        node.fy = null;
        if (this.worker) {
          this.worker.postMessage({ type: "dragEnd", index: this.dragging.index });
        } else {
          this.simulation?.alphaTarget(0);
        }
        void this.finishNodeDrag(node);
        this.schedulePositionSave();
      } else if (e.shiftKey) {
        this.toggleSelected(node.id);
      } else {
        this.setSelection([node.id]);
        this.peekOnTouch(node.id);
      }
      this.pendingDrag = null;
      this.dragging = null;
    } else if (this.pan) {
      const movedPx = Math.hypot(e.clientX - this.pan.startX, e.clientY - this.pan.startY);
      // A click on empty canvas clears the selection (a pan doesn't).
      if (movedPx < 4 && (this.selectedId || this.selection.size)) this.clearSelection();
    }
    this.pan = null;
  };

  /** Abort whatever one finger started (a second finger / long-press took over). */
  private cancel2dGesture(): void {
    if (this.linkDrag2d) {
      this.linkDrag2d = null;
      this.dragLine = null;
      this.dropTarget = null;
    }
    if (this.lasso2d) {
      this.lasso2d = false;
      this.lassoPts = null;
    }
    if (this.dragging) {
      const node = this.dragging.node;
      if (this.dragging.moved) {
        node.fx = null;
        node.fy = null;
        if (this.worker) this.worker.postMessage({ type: "dragEnd", index: this.dragging.index });
        else this.simulation?.alphaTarget(0);
        this.dragFrom = null;
        this.dropTarget = null;
        this.syncRings();
      }
      this.dragging = null;
    }
    this.pan = null;
    this.scheduleOverlay();
  }

  private startPinch2d(): void {
    if (this.longPress2d) {
      clearTimeout(this.longPress2d.timer);
      this.longPress2d = null;
    }
    this.cancel2dGesture();
    const [a, b] = [...this.touch2d.values()];
    const rect = this.canvas!.getBoundingClientRect();
    this.pinch2d = {
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      k0: this.viewport.k,
      mx: (a.x + b.x) / 2 - rect.left,
      my: (a.y + b.y) / 2 - rect.top,
      vx: this.viewport.x,
      vy: this.viewport.y,
    };
  }

  /** Two-finger pinch-zoom + pan around the fingers' midpoint. */
  private movePinch2d(): void {
    const p = this.pinch2d;
    if (!p || this.touch2d.size < 2) return;
    const [a, b] = [...this.touch2d.values()];
    const rect = this.canvas!.getBoundingClientRect();
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const k = Math.max(0.12, Math.min(6, p.k0 * (d / p.d0)));
    const mx = (a.x + b.x) / 2 - rect.left;
    const my = (a.y + b.y) / 2 - rect.top;
    // World point under the starting midpoint stays under the moving midpoint.
    const wx = (p.mx - p.vx) / p.k0;
    const wy = (p.my - p.vy) / p.k0;
    this.userMovedView = true;
    this.viewport = { x: mx - wx * k, y: my - wy * k, k };
    this.scheduleDraw();
    this.scheduleOverlay();
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.userMovedView = true;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.max(0.12, Math.min(6, this.viewport.k * factor));
    const rect = this.canvas!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const k0 = this.viewport.k;
    this.viewport = {
      x: px - (px - this.viewport.x) * (next / k0),
      y: py - (py - this.viewport.y) * (next / k0),
      k: next,
    };
    this.scheduleDraw();
    this.scheduleOverlay();
  };

  private onDoubleClick = (e: MouseEvent): void => {
    const { x, y } = this.worldCoords(e.clientX, e.clientY);
    const node = this.hitTest(x, y);
    if (!node) return;
    this.selectedId = node.id;
    if (this.openRepoNode(node)) return;
    this.dispatchEvent(
      new CustomEvent("knowledge-graph:open", { detail: node, bubbles: true, composed: true }),
    );
  };

  private toggleKind(kind: GraphNodeKind): void {
    const next = new Set(this.enabledKinds);
    const turningOn = !next.has(kind);
    if (turningOn) next.add(kind);
    else next.delete(kind);
    this.enabledKinds = next;
    if (!this.projectScope) saveEnabledKinds(next);
    // Turning a layer on that the last snapshot didn't collect needs a fetch;
    // turning one off is a client-side filter (the next poll gets lighter).
    if (turningOn && !(this.snapshot?.kinds ?? []).includes(kind)) void this.refresh();
  }

  private toggleHealth(hh: ProjectHealth): void {
    const next = new Set(this.enabledHealth);
    if (next.has(hh)) next.delete(hh);
    else next.add(hh);
    this.enabledHealth = next;
    saveEnabledHealth(next);
  }

  private setInsight(ins: GraphInsight | null): void {
    this.activeInsight = ins;
    this.rebuildHighlight();
    this.stage?.setFocus(this.selectedId ?? this.hoveredId);
    if (ins) {
      this.selectedId = null;
      this.fitTo(ins.nodeIds);
    }
    this.scheduleDraw();
  }

  /** Initial zoom that frames every orbit before the layout has settled. */
  private fitToOrbits(outer: number): void {
    if (this.userMovedView || this.stage) return;
    const { w, h } = this.size;
    const k = Math.max(0.15, Math.min(1.2, Math.min(w, h) / (2 * (outer + 40))));
    this.viewport = { x: w / 2 - (w / 2) * k, y: h / 2 - (h / 2) * k, k };
  }

  private fitTo(ids: Iterable<string>, maxK = 1.8): void {
    if (this.stage) {
      this.stage.fitIds(ids, { fill: maxK >= 1.8 ? 0.8 : 0.62 });
      this.userMovedView = true;
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let n = 0;
    for (const id of ids) {
      const node = this.nodeById.get(id);
      if (!node || node.x == null || node.y == null) continue;
      x0 = Math.min(x0, node.x - node.r);
      y0 = Math.min(y0, node.y - node.r);
      x1 = Math.max(x1, node.x + node.r);
      y1 = Math.max(y1, node.y + node.r);
      n++;
    }
    if (!n) return;
    const { w, h } = this.size;
    // Leave room for the side panels in the full-page layout.
    const leftPad = !this.compact && this.hudOpen ? 300 : 40;
    const rightPad = this.selectedId ? 330 : 40;
    const availW = Math.max(200, w - leftPad - rightPad);
    const pad = 60;
    const k = Math.max(0.12, Math.min(maxK, Math.min(availW / (x1 - x0 + pad * 2), h / (y1 - y0 + pad * 2))));
    this.viewport = {
      x: leftPad + availW / 2 - ((x0 + x1) / 2) * k,
      y: h / 2 - ((y0 + y1) / 2) * k,
      k,
    };
    this.userMovedView = true;
    this.scheduleDraw();
  }

  private resetView(): void {
    if (this.stage) {
      if (this.nodes.length) this.stage.resetView(this.anchorIds());
      return;
    }
    if (!this.nodes.length) {
      this.viewport = { x: 0, y: 0, k: 1 };
      this.scheduleDraw();
      return;
    }
    // Frame the anchors (projects + clients); unconnected strays on the rim
    // may spill past the edge — they're context, not the story.
    this.fitTo(this.anchorIds(), 2);
  }

  /** A workspace file node opens its OCR / extracted-context panel. */
  private async openFileContext(n: GraphNodeIn): Promise<void> {
    const client = this.client;
    const meta = (n.meta ?? {}) as Record<string, unknown>;
    const fileId = typeof meta.fileId === "string" && meta.fileId ? meta.fileId : n.id.slice(n.id.indexOf(":") + 1);
    if (!client || !fileId) return;
    const { openFileContextDialog } = await import("./file-context-panel");
    openFileContextDialog({
      client: { request: (m: string, p?: unknown) => client.request(m, p) },
      fileId,
      fileName: typeof meta.name === "string" && meta.name ? meta.name : n.label,
      secure: meta.lane === "secure",
    });
  }

  private openNode(n: GraphNodeIn): void {
    if (n.kind === "file") {
      void this.openFileContext(n);
      return;
    }
    const target = openTargetFor(n, inferBasePathFromPathname(window.location.pathname));
    if (hasNativeHost()) {
      // In the app: its native screens (project board, notes, reports…) open it.
      haptic("light");
      postNative({
        type: "open",
        node: { id: n.id, kind: n.kind, label: n.label, meta: n.meta as Record<string, unknown> | undefined },
        path: target && target.type !== "agent-focus" ? target.path : null,
      });
      return;
    }
    if (!target) return;
    if (target.type === "agent-focus") {
      window.dispatchEvent(new CustomEvent("infinibot:open-agent-focus", { detail: target.detail }));
      return;
    }
    window.history.pushState({}, "", target.path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  /** Select a node; in 3D the camera flies to it (`fly` false for a plain stage click). */
  private selectNode(id: string, fly = true): void {
    this.selectedId = id;
    this.focusNeighborhood = null;
    this.focusNeighborhoodId = null;
    if (this.stage) {
      if (fly || this.isMobile()) this.stage.flyToNode(id);
      return;
    }
    this.maybeStartAnimLoop();
    this.scheduleDraw();
  }

  // ── Selection ─────────────────────────────────────────────
  private setSelection(ids: Iterable<string>): void {
    const next = new Set<string>();
    for (const id of ids) if (this.nodeById.has(id)) next.add(id);
    this.selection = next;
    if (next.size === 1) this.selectedId = [...next][0];
    else if (next.size > 1) this.selectedId = null;
    this.syncRings();
    this.scheduleDraw();
  }

  private toggleSelected(id: string): void {
    const next = new Set(this.selection);
    if (this.selectedId && !next.size) next.add(this.selectedId);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.setSelection(next);
  }

  private clearSelection(): void {
    this.selection = new Set();
    this.selectedId = null;
    this.touchPeek = false;
    this.peekId = null;
    if (this.hoverCardId && this.lastPointerType !== "mouse") this.hideHoverCard();
    this.menu = null;
    this.statusMenu = false;
    this.syncRings();
    this.scheduleDraw();
  }

  /** The working set for an action: the multi-selection, else the clicked node. */
  private actionIds(nodeId?: string | null): string[] {
    if (nodeId && !this.selection.has(nodeId)) return [nodeId];
    if (this.selection.size) return [...this.selection];
    return nodeId ? [nodeId] : this.selectedId ? [this.selectedId] : [];
  }

  private nodesOf(ids: Iterable<string>): SimNode[] {
    const out: SimNode[] = [];
    for (const id of ids) {
      const n = this.nodeById.get(id);
      if (n) out.push(n);
    }
    return out;
  }

  private opEdges(): Array<{ source: string; target: string; rel: string; inferred?: boolean }> {
    return this.links.map((l) => ({
      source: (l.source as SimNode).id,
      target: (l.target as SimNode).id,
      rel: l.rel,
      inferred: l.inferred,
    }));
  }

  private setModes(link: boolean, select: boolean): void {
    this.linkMode = link;
    this.selectMode = select;
    this.linkTapFrom = null;
    if (link || select) haptic("selection");
    this.stage?.setInteractionModes({ link, select });
    if (this.canvas) this.canvas.style.cursor = link ? "crosshair" : select ? "cell" : "grab";
  }

  /**
   * Touch tap on a node = the hover card (the phone's hover): selection ring,
   * camera fly-to and the quick card with Chat / Select / Focus / Open /
   * Details. The full detail panel opens from "Details".
   */
  private peekOnTouch(id: string): void {
    if (this.lastPointerType === "mouse") {
      this.touchPeek = false;
      this.peekId = null;
      return;
    }
    haptic("selection");
    this.touchPeek = true;
    this.peekId = id;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.hoverHideTimer) clearTimeout(this.hoverHideTimer);
    this.hoverTimer = null;
    this.hoverHideTimer = null;
    this.hoverCardId = id;
    this.scheduleOverlay();
  }

  /** Detail panel for the peeked node (the hover card's "Details"). */
  private openDetails(id: string): void {
    this.hideHoverCard();
    this.touchPeek = false;
    this.peekId = null;
    this.selection = new Set([id]);
    this.selectedId = id;
    this.syncRings();
  }

  /**
   * Link mode by taps (no Ctrl key on a phone): tap the source, then the
   * target. Returns true when the tap was consumed.
   */
  private tapLink(id: string): boolean {
    const from = this.linkTapFrom;
    if (!from || from === id || !this.nodeById.has(from)) {
      this.linkTapFrom = id;
      if (!this.selection.has(id)) this.selection = new Set([id]);
      this.selectedId = id;
      this.peekId = id;
      this.syncRings();
      haptic("selection");
      const n = this.nodeById.get(id);
      const many = this.selection.size > 1;
      this.showToast(many ? `${this.selection.size} items — now tap the node to link them to.` : `${n ? truncate(n.label, 28) : "Node"} — now tap the node to link it to.`, "ok");
      return true;
    }
    this.linkTapFrom = null;
    const target = this.nodeById.get(id);
    if (!target) return true;
    const ids = this.selection.has(from) && this.selection.size > 1 ? [...this.selection] : [from];
    void this.linkTo(ids, target);
    return true;
  }

  // ── Live overlays (drag line, drop target, lasso, hover card) ──
  private scheduleOverlay(): void {
    if (this.overlayRaf !== null) return;
    this.overlayRaf = requestAnimationFrame(() => {
      this.overlayRaf = null;
      this.positionOverlays();
    });
  }

  /** Screen position of a node in stage-local px for either renderer. */
  private screenOfNode(id: string): { x: number; y: number; r: number } | null {
    if (this.stage) return this.stage.screenOf(id);
    const n = this.nodeById.get(id);
    if (!n || n.x == null || n.y == null) return null;
    const k = this.viewport.k;
    return { x: n.x * k + this.viewport.x, y: n.y * k + this.viewport.y, r: Math.max(4, n.r * k) };
  }

  /** Visual px per CSS px (the app shell may CSS-zoom the page). */
  private cssScale(): number {
    const st = this.querySelector<HTMLElement>(".kg-stage");
    if (!st || !st.offsetWidth) return 1;
    return st.getBoundingClientRect().width / st.offsetWidth || 1;
  }

  /** Imperative DOM updates — runs per frame during drags without re-rendering Lit. */
  private positionOverlays(): void {
    const svg = this.querySelector<SVGSVGElement>(".kg-overlay");
    const z = this.cssScale();
    if (svg) {
      // Geometry is in visual px; a matching viewBox maps it onto CSS px.
      const vw = Math.round(svg.clientWidth * z);
      const vh = Math.round(svg.clientHeight * z);
      const vb = `0 0 ${vw} ${vh}`;
      if (svg.getAttribute("viewBox") !== vb) svg.setAttribute("viewBox", vb);
      const line = svg.querySelector<SVGPathElement>(".kg-dl");
      const tip = this.querySelector<HTMLElement>(".kg-dl-tip");
      const dl = this.dragLine;
      const from = dl ? this.screenOfNode(dl.fromId) : null;
      if (dl && from && line) {
        const to = dl.targetId ? this.screenOfNode(dl.targetId) : null;
        const x2 = to ? to.x : dl.x;
        const y2 = to ? to.y : dl.y;
        const mx = (from.x + x2) / 2;
        const my = (from.y + y2) / 2 - Math.min(80, Math.hypot(x2 - from.x, y2 - from.y) * 0.18);
        line.setAttribute("d", `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`);
        line.setAttribute("class", `kg-dl ${dl.targetId ? (dl.ok ? "kg-dl--ok" : "kg-dl--bad") : ""}`);
        line.style.display = "";
        if (tip) {
          tip.textContent = dl.text;
          tip.style.display = dl.text ? "" : "none";
          tip.style.transform = `translate(${((x2 + 14) / z).toFixed(0)}px, ${((y2 + 14) / z).toFixed(0)}px)`;
          tip.className = `kg-dl-tip ${dl.targetId ? (dl.ok ? "ok" : "bad") : ""}`;
        }
      } else if (line) {
        line.style.display = "none";
        if (tip) tip.style.display = "none";
      }
      const lasso = svg.querySelector<SVGPolygonElement>(".kg-lasso");
      if (lasso) {
        if (this.lassoPts && this.lassoPts.length >= 4) {
          const pts: string[] = [];
          for (let i = 0; i < this.lassoPts.length; i += 2) pts.push(`${this.lassoPts[i].toFixed(0)},${this.lassoPts[i + 1].toFixed(0)}`);
          lasso.setAttribute("points", pts.join(" "));
          lasso.style.display = "";
        } else lasso.style.display = "none";
      }
      const drop = svg.querySelector<SVGCircleElement>(".kg-drop");
      const dropTip = this.querySelector<HTMLElement>(".kg-drop-tip");
      const dt = this.dropTarget;
      const dpos = dt ? this.screenOfNode(dt.id) : null;
      if (drop && dt && dpos) {
        drop.setAttribute("cx", dpos.x.toFixed(1));
        drop.setAttribute("cy", dpos.y.toFixed(1));
        drop.setAttribute("r", (dpos.r * 1.9 + 8).toFixed(1));
        drop.setAttribute("class", `kg-drop ${dt.ok ? (dt.armed ? "kg-drop--armed" : "kg-drop--ok") : "kg-drop--bad"}`);
        drop.style.display = "";
        if (dropTip) {
          dropTip.textContent = dt.text;
          dropTip.style.display = dt.text ? "" : "none";
          dropTip.style.transform = `translate(${((dpos.x - 4) / z).toFixed(0)}px, ${((dpos.y - dpos.r * 1.9) / z - 36).toFixed(0)}px) translateX(-50%)`;
          dropTip.className = `kg-drop-tip ${dt.ok ? (dt.armed ? "armed" : "ok") : "bad"}`;
        }
      } else {
        if (drop) drop.style.display = "none";
        if (dropTip) dropTip.style.display = "none";
      }
    }
    const card = this.querySelector<HTMLElement>(".kg-hovercard");
    if (card && this.hoverCardId) {
      const p = this.screenOfNode(this.hoverCardId);
      const host = this.querySelector<HTMLElement>(".kg-stage");
      if (!p || !host) {
        card.style.opacity = "0";
      } else {
        // Work in CSS px: card + host sizes are CSS, node position is visual.
        const W = host.clientWidth;
        const H = host.clientHeight;
        const cw = card.offsetWidth || 280;
        const ch = card.offsetHeight || 200;
        const px = p.x / z;
        const py = p.y / z;
        // Clear the halo + status ring and the node's own label.
        const pr = (p.r / z) * 2.1;
        let x = px + pr + 14;
        if (x + cw > W - 8) x = px - pr - 14 - cw;
        x = Math.max(8, Math.min(W - cw - 8, x));
        const y = Math.max(8, Math.min(H - ch - 8, py - ch / 2));
        card.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
        card.style.opacity = "1";
      }
    }
  }

  // ── Hover overlay ─────────────────────────────────────────
  private queueHoverCard(id: string | null): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    if (id) {
      if (this.hoverHideTimer) clearTimeout(this.hoverHideTimer);
      this.hoverHideTimer = null;
      if (this.dragFrom || this.dragLine || this.lassoPts || this.menu) return;
      this.hoverTimer = setTimeout(() => {
        this.hoverCardId = id;
        this.scheduleOverlay();
      }, this.hoverCardId ? 60 : 220);
    } else if (this.hoverCardId) {
      // Grace period so the pointer can travel onto the card's buttons.
      if (this.hoverHideTimer) clearTimeout(this.hoverHideTimer);
      this.hoverHideTimer = setTimeout(() => this.hideHoverCard(), 380);
    }
  }

  private hideHoverCard(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.hoverHideTimer) clearTimeout(this.hoverHideTimer);
    this.hoverTimer = null;
    this.hoverHideTimer = null;
    this.hoverCardId = null;
    this.touchPeek = false;
  }

  // ── Drag onto a project (re-assign) ───────────────────────
  private onDragOverNode(dragged: SimNode | undefined, target: SimNode | undefined): void {
    if (!dragged) return;
    if (!target) {
      if (this.dropTarget) {
        this.dropTarget = null;
        this.syncRings();
        this.scheduleOverlay();
      }
      return;
    }
    if (this.dropTarget?.id === target.id) return;
    const ids = this.selection.has(dragged.id) && this.selection.size > 1 ? [...this.selection] : [dragged.id];
    let ok = false;
    let text = "";
    if (target.kind === "project") {
      if (ids.length > 1) {
        const plan = planBulkReassign(this.nodesOf(ids), target, this.opEdges(), this.nodeById);
        ok = plan.ops.length > 0;
        text = ok ? `Move ${plan.ops.length} to ${target.label}` : (plan.skipped[0]?.reason ?? "Nothing to move");
      } else {
        const r = planReassign(dragged, target, this.opEdges(), this.nodeById);
        ok = r.ok || r.fallbackLink === true;
        text = r.ok ? r.op.label.replace(/^Moved /, "Move ").replace(/^Filed /, "File ").replace(/^Made /, "Make ") : r.fallbackLink ? `Link to ${target.label}` : r.reason;
      }
    } else {
      // Plain drag over a non-project: hint at Ctrl+drag instead of acting.
      if (this.dropTarget) {
        this.dropTarget = null;
        this.syncRings();
      }
      this.scheduleOverlay();
      return;
    }
    this.dropTarget = { id: target.id, ok, armed: false, text, since: performance.now() };
    const armedFor = target.id;
    setTimeout(() => {
      if (this.dropTarget?.id === armedFor && this.dropTarget.ok) {
        this.dropTarget = { ...this.dropTarget, armed: true };
        this.scheduleOverlay();
      }
    }, DROP_ARM_MS);
    this.syncRings();
    this.scheduleOverlay();
  }

  private async finishNodeDrag(n: SimNode | undefined): Promise<void> {
    const dt = this.dropTarget;
    this.dropTarget = null;
    this.dragFrom = null;
    this.syncRings();
    this.scheduleOverlay();
    if (!n || !dt || !dt.ok) return;
    if (!dt.armed && performance.now() - dt.since < DROP_ARM_MS) {
      this.showToast("Hold over a project a moment to move it there.", "warn");
      return;
    }
    const target = this.nodeById.get(dt.id);
    if (!target) return;
    const ids = this.selection.has(n.id) && this.selection.size > 1 ? [...this.selection] : [n.id];
    await this.reassignTo(ids, target);
  }

  // ── Ctrl/⌘ + drag to link ─────────────────────────────────
  private beginLinkDrag(n: SimNode | undefined): void {
    if (!n) return;
    this.hideHoverCard();
    const many = this.selection.has(n.id) && this.selection.size > 1;
    this.dragLine = { fromId: n.id, x: 0, y: 0, targetId: null, ok: false, text: many ? `Link ${this.selection.size} items…` : "Drop on a node to link" };
    const p = this.screenOfNode(n.id);
    if (p) {
      this.dragLine.x = p.x;
      this.dragLine.y = p.y;
    }
    this.scheduleOverlay();
  }

  private moveLinkDrag(x: number, y: number, target: SimNode | undefined): void {
    const dl = this.dragLine;
    if (!dl) return;
    dl.x = x;
    dl.y = y;
    const from = this.nodeById.get(dl.fromId);
    if (target && from) {
      const many = this.selection.has(from.id) && this.selection.size > 1;
      if (many) {
        const plan = planBulkLink(this.nodesOf(this.selection), target, this.adjacency);
        dl.ok = plan.links.length > 0;
        dl.text = dl.ok ? `Link ${plan.links.length} → ${target.label}` : (plan.skipped[0]?.reason ?? "Nothing to link");
      } else {
        const plan = planLink(from, target, this.adjacency);
        dl.ok = plan.ok;
        dl.text = plan.ok ? `Link → ${target.label}` : plan.reason;
      }
      dl.targetId = target.id;
      // Same ring as a drop target (tip text lives on the drag line).
      if (this.dropTarget?.id !== target.id || this.dropTarget.ok !== dl.ok) {
        this.dropTarget = { id: target.id, ok: dl.ok, armed: dl.ok, text: "", since: performance.now() };
        this.syncRings();
      }
    } else {
      if (this.dropTarget) {
        this.dropTarget = null;
        this.syncRings();
      }
      dl.targetId = null;
      dl.ok = false;
      dl.text = this.selection.has(dl.fromId) && this.selection.size > 1 ? `Link ${this.selection.size} items…` : "Drop on a node to link";
    }
    this.scheduleOverlay();
  }

  private async endLinkDrag(target: SimNode | undefined): Promise<void> {
    const dl = this.dragLine;
    this.dragLine = null;
    if (this.dropTarget) {
      this.dropTarget = null;
      this.syncRings();
    }
    this.scheduleOverlay();
    if (!dl || !target) return;
    const from = this.nodeById.get(dl.fromId);
    if (!from) return;
    const ids = this.selection.has(from.id) && this.selection.size > 1 ? [...this.selection] : [from.id];
    await this.linkTo(ids, target);
  }

  // ── Lasso ─────────────────────────────────────────────────
  private onLasso(pts: number[], done: boolean): void {
    this.hideHoverCard();
    if (!done) {
      this.lassoPts = pts;
      this.scheduleOverlay();
      return;
    }
    this.lassoPts = null;
    this.scheduleOverlay();
    if (pts.length < 6) return;
    const points = this.stage
      ? this.stage.screenPoints()
      : this.nodes.map((n) => {
          const p = this.screenOfNode(n.id);
          return { id: n.id, x: p?.x ?? -1e6, y: p?.y ?? -1e6, visible: !!p };
        });
    const hit = selectInLasso(pts, points).filter((id) => this.baseEmphasis(this.nodeById.get(id)!, null, null) > 0.05);
    if (!hit.length) return;
    const next = new Set(this.selection);
    for (const id of hit) next.add(id);
    this.setSelection(next);
    this.showToast(`${next.size} selected — act on them from the bar below.`, "ok");
  }

  // ── Context menu ──────────────────────────────────────────
  private openMenu(nodeId: string | null, x: number, y: number): void {
    this.hideHoverCard();
    if (nodeId && !this.selection.has(nodeId)) {
      this.selection = new Set([nodeId]);
      this.selectedId = nodeId;
      this.syncRings();
    }
    if (!nodeId && !this.selection.size) return;
    const z = this.cssScale();
    this.menuOpenedAt = performance.now();
    if (this.lastPointerType !== "mouse") haptic("medium");
    // Touch: open beside the finger so the lift doesn't land on an item.
    const touch = matchMedia?.("(pointer: coarse)")?.matches ?? false;
    this.menu = { x: x / z + (touch ? 18 : 0), y: y / z + (touch ? 18 : 0), nodeId };
  }

  // ── Executing plans ───────────────────────────────────────
  private showToast(text: string, tone: "ok" | "warn" | "err" = "ok", undo = false): void {
    this.toast = { text, tone, undo };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), undo ? 9000 : 4500);
  }

  private logActivity(text: string, nodeId: string, tone: ActivityItem["tone"] = "status"): void {
    const now = Date.now();
    this.activity = [{ id: `op:${now}:${nodeId}`, at: now, nodeId, text, tone }, ...this.activity].slice(0, 40);
  }

  private async call(c: RpcCall): Promise<unknown> {
    if (!this.client) throw new Error("Not connected to the gateway.");
    // Secure lane: graph edits here would write to the NORMAL stores (kanban,
    // notes, relations). Only secure.* RPCs may run.
    if (this.lane === "secure" && !c.method.startsWith("secure.")) {
      throw new Error("Not available in Secure Mode — use the secure graph tools (Add secure node).");
    }
    return this.client.request(c.method, c.params);
  }

  /** Run planned ops with modest concurrency; returns successes for undo. */
  private async runOps(ops: PlannedOp[]): Promise<{ done: PlannedOp[]; failed: Array<{ op: PlannedOp; error: string }> }> {
    const done: PlannedOp[] = [];
    const failed: Array<{ op: PlannedOp; error: string }> = [];
    const queue = [...ops];
    const worker = async () => {
      for (let op = queue.shift(); op; op = queue.shift()) {
        try {
          await this.call(op.call);
          done.push(op);
        } catch (err) {
          failed.push({ op, error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ops.length) }, worker));
    return { done, failed };
  }

  private recordOp(kind: string, detail: Record<string, unknown>): void {
    (globalThis as Record<string, unknown>).__kgLastOp = { kind, at: Date.now(), ...detail };
  }

  private async runPlan(plan: Plan, verb: string): Promise<boolean> {
    if (!plan.ops.length) {
      this.showToast(plan.skipped[0]?.reason ?? `Nothing to ${verb.toLowerCase()}.`, "warn");
      return false;
    }
    this.busy = true;
    try {
      const { done, failed } = await this.runOps(plan.ops);
      const undo = done.flatMap((o) => o.undo).reverse();
      this.undoStack.push(`${verb} ${done.length}`, undo);
      const skipped = plan.skipped.length ? ` · ${plan.skipped.length} skipped` : "";
      const fail = failed.length ? ` · ${failed.length} failed (${failed[0].error})` : "";
      this.showToast(`${verb} ${done.length}${skipped}${fail}`, failed.length ? "err" : "ok", undo.length > 0);
      for (const o of done.slice(0, 6)) this.logActivity(`${verb} · ${o.label}`, o.nodeId);
      this.recordOp(verb, { done: done.length, failed: failed.length, calls: done.map((o) => o.call) });
      await this.refresh(true);
      return done.length > 0;
    } finally {
      this.busy = false;
    }
  }

  private async undoLast(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.busy = true;
    let failed = 0;
    for (const c of entry.calls) {
      try {
        await this.call(c);
      } catch {
        failed++;
      }
    }
    this.busy = false;
    this.localEdges = [];
    this.showToast(failed ? `Undo partly failed (${failed})` : `Undone · ${entry.label}`, failed ? "err" : "ok");
    await this.refresh(true);
    await this.reloadExpanded();
  }

  /** Re-fetch expanded task layers (after moves the old/new project lists change). */
  private async reloadExpanded(extra: string[] = []): Promise<void> {
    const ids = new Set([...this.expanded.keys(), ...extra]);
    for (const id of ids) {
      if (!this.nodeById.has(id) && !this.snapshot?.nodes.some((n) => n.id === id)) continue;
      const next = new Map(this.expanded);
      next.delete(id);
      this.expanded = next;
      await this.expandProject(id);
    }
  }

  private async linkTo(ids: string[], target: SimNode): Promise<void> {
    const { links, skipped } = planBulkLink(this.nodesOf(ids), target, this.adjacency);
    if (!links.length) {
      this.showToast(skipped[0]?.reason ?? "Nothing to link.", "warn");
      return;
    }
    this.busy = true;
    const undo: RpcCall[] = [];
    let ok = 0;
    let lastErr = "";
    for (const { nodeId, plan } of links) {
      try {
        const rel = (await this.call(plan.call)) as { id?: string } | undefined;
        undo.push(unlinkCall(plan, rel?.id));
        ok++;
        // Optimistic edge until the gateway snapshot reports it.
        this.localEdges.push({ source: nodeId, target: target.id, rel: plan.edge.replace(/_/g, " "), weight: Date.now() });
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    this.busy = false;
    this.undoStack.push(`Link ${ok}`, undo.reverse());
    this.rebuildSimulation();
    await this.refresh(true);
    // Read-back: did the gateway's snapshot pick the new relation up?
    const confirmed = links.filter(({ nodeId }) =>
      (this.snapshot?.edges ?? []).some(
        (e) => (e.source === nodeId && e.target === target.id) || (e.source === target.id && e.target === nodeId),
      ),
    ).length;
    const first = this.nodeById.get(links[0].nodeId)?.label ?? "";
    const text = ok === 1 ? `Linked ${first} ↔ ${target.label}` : `Linked ${ok} to ${target.label}`;
    this.logActivity(text, target.id, "new");
    this.recordOp("link", { ok, confirmed, target: target.id, from: links.map((l) => l.nodeId), relationIds: undo.map((u) => u.params.id) });
    haptic(lastErr ? "error" : "success");
    this.showToast(
      `${text}${confirmed === ok ? " · saved" : ` · ${confirmed}/${ok} visible after refresh`}${lastErr ? ` · ${links.length - ok} failed` : ""}${skipped.length ? ` · ${skipped.length} skipped` : ""}`,
      lastErr ? "err" : "ok",
      ok > 0,
    );
  }

  private async reassignTo(ids: string[], target: SimNode): Promise<void> {
    const nodes = this.nodesOf(ids);
    // Kinds with no project field (issues, clients…) link instead.
    const reassignable = nodes.filter((n) => canReassign(n.kind) && !isDocumentNode(n));
    const linkOnly = nodes.filter((n) => !canReassign(n.kind) || isDocumentNode(n));
    const plan = planBulkReassign(reassignable, target, this.opEdges(), this.nodeById);
    const fromProjects = new Set<string>();
    for (const op of plan.ops) {
      const n = this.nodeById.get(op.nodeId);
      const pid = n?.kind === "task" ? (n.meta?.projectId as string | undefined) : undefined;
      if (pid) fromProjects.add(`project:${pid}`);
    }
    if (plan.ops.length) {
      // Optimistic: rewire expanded task layers so the node flies to its new hub now.
      for (const op of plan.ops) {
        for (const layer of this.expanded.values()) {
          for (const e of layer.edges) if (e.target === op.nodeId && e.rel === "contains") e.source = target.id;
        }
      }
      const ok = await this.runPlan(plan, "Moved");
      if (ok) {
        await this.reloadExpanded(target.kind === "project" && plan.ops.some((o) => o.nodeId.startsWith("task:")) ? [target.id, ...fromProjects] : []);
        await this.verifyReassign(plan.ops, target);
      }
    } else if (!linkOnly.length) {
      this.showToast(plan.skipped[0]?.reason ?? "Nothing to move.", "warn");
    }
    if (linkOnly.length) await this.linkTo(linkOnly.map((n) => n.id), target);
  }

  /** Read the moved items back from the gateway and say whether the move stuck. */
  private async verifyReassign(ops: PlannedOp[], target: SimNode): Promise<void> {
    if (!this.client || this.lane === "secure") return;
    const pid = storeIdOf(target);
    let verified = 0;
    try {
      const taskIds = ops.filter((o) => o.nodeId.startsWith("task:")).map((o) => o.nodeId);
      if (taskIds.length) {
        const raw = await this.client.request<unknown>("graph.global.snapshot", {
          types: ["project", "task"],
          taskProjectIds: [pid],
          refresh: true,
        });
        const snap = sanitizeSnapshot(raw);
        const inTarget = new Set((snap?.nodes ?? []).filter((n) => n.kind === "task" && n.meta?.projectId === pid).map((n) => n.id));
        verified += taskIds.filter((id) => inTarget.has(id)).length;
      }
      const other = ops.filter((o) => !o.nodeId.startsWith("task:"));
      for (const o of other) {
        const n = this.nodeById.get(o.nodeId);
        if (!n) continue;
        if (n.kind === "project" && n.meta?.parentProjectId === pid) verified++;
        else if (n.kind === "note" && (this.snapshot?.edges ?? []).some((e) => e.source === n.id && e.target === target.id)) verified++;
      }
    } catch {
      /* best effort — the toast already reported the write */
    }
    this.recordOp("reassign", { target: target.id, moved: ops.map((o) => o.nodeId), verified });
    if (verified) this.showToast(`Moved ${ops.length} to ${target.label} · verified ${verified}/${ops.length}`, "ok", true);
  }

  // ── Bulk actions (bar / menu / HUD) ───────────────────────
  private async bulkStatus(ids: string[], status: BulkStatus): Promise<void> {
    this.statusMenu = false;
    this.menu = null;
    await this.runPlan(planBulkStatus(this.nodesOf(ids), status), "Updated");
  }

  private async bulkTag(ids: string[], tag: string): Promise<void> {
    this.dialog = null;
    await this.runPlan(planBulkTag(this.nodesOf(ids), tag), "Tagged");
  }

  private openDelete(ids: string[]): void {
    this.menu = null;
    const plan = planBulkDelete(this.nodesOf(ids));
    if (!plan.ops.length) {
      this.showToast(plan.skipped[0]?.reason ?? "Nothing deletable selected.", "warn");
      return;
    }
    this.dialog = { type: "delete", plan };
  }

  private async confirmDelete(plan: Plan): Promise<void> {
    this.dialog = null;
    const ok = await this.runPlan(plan, "Deleted");
    if (ok) this.clearSelection();
  }

  private openPicker(purpose: "move" | "link", ids: string[]): void {
    this.menu = null;
    this.dialog = { type: "pick", purpose, ids, query: "" };
  }

  private async pickTarget(purpose: "move" | "link", ids: string[], targetId: string): Promise<void> {
    this.dialog = null;
    const target = this.nodeById.get(targetId);
    if (!target) return;
    if (purpose === "move") await this.reassignTo(ids, target);
    else await this.linkTo(ids, target);
  }

  private selectNeighbours(ids: string[]): void {
    this.menu = null;
    const next = new Set(ids);
    for (const id of ids) for (const nb of this.adjacency.get(id) ?? []) next.add(nb);
    this.setSelection(next);
  }

  // ── Consolidate ───────────────────────────────────────────
  private async openConsolidate(ids: string[]): Promise<void> {
    this.menu = null;
    const nodes = this.nodesOf(ids);
    const kinds = new Set(nodes.map((n) => n.kind));
    if (nodes.length < 2 || kinds.size !== 1 || !(kinds.has("note") || kinds.has("task"))) {
      // Mixed or non-mergeable selections still get an AI merge plan.
      this.showToast("Direct merge works on notes or tasks of one kind — asking the assistant for a plan instead.", "warn");
      void this.openAi("consolidate", ids);
      return;
    }
    const d: Extract<Dialog, { type: "consolidate" }> = {
      type: "consolidate",
      ids,
      loading: true,
      plan: null,
      removeMode: kinds.has("note") ? "delete" : "archive",
      title: "",
      body: "",
      bodies: new Map(),
    };
    this.dialog = d;
    try {
      for (const n of nodes) {
        const id = storeIdOf(n);
        if (n.kind === "note") {
          const r = (await this.call({ method: "notes.get", params: { id } })) as Record<string, unknown> | undefined;
          d.bodies.set(n.id, String(r?.body ?? r?.content ?? ""));
        } else {
          const r = (await this.call({ method: "kanban.tasks.content.getMarkdown", params: { taskId: id } })) as { markdown?: string } | undefined;
          d.bodies.set(n.id, String(r?.markdown ?? ""));
        }
      }
      this.replanConsolidate(d, {});
    } catch (err) {
      this.dialog = { ...d, loading: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private replanConsolidate(
    d: Extract<Dialog, { type: "consolidate" }>,
    opts: { primaryId?: string; removeMode?: "delete" | "archive"; keepText?: boolean },
  ): void {
    const nodes = this.nodesOf(d.ids);
    const items = nodes.map((n) => ({ node: n, body: d.bodies.get(n.id) ?? "", degree: this.adjacency.get(n.id)?.size ?? 0 }));
    const primaryId = opts.primaryId ?? d.primaryId;
    const removeMode = opts.removeMode ?? d.removeMode;
    const res = planConsolidate(items, this.opEdges(), this.nodeById, {
      primaryId,
      removeMode,
      ...(opts.keepText ? { title: d.title, body: d.body } : {}),
    });
    if (!res.ok) {
      this.dialog = { ...d, loading: false, plan: null, error: res.reason };
      return;
    }
    this.dialog = { ...d, loading: false, plan: res, primaryId: res.primaryId, removeMode, title: res.title, body: res.body, error: undefined };
  }

  private async confirmConsolidate(d: Extract<Dialog, { type: "consolidate" }>): Promise<void> {
    const nodes = this.nodesOf(d.ids);
    const items = nodes.map((n) => ({ node: n, body: d.bodies.get(n.id) ?? "", degree: this.adjacency.get(n.id)?.size ?? 0 }));
    const res = planConsolidate(items, this.opEdges(), this.nodeById, {
      primaryId: d.primaryId,
      removeMode: d.removeMode,
      title: d.title,
      body: d.body,
    });
    if (!res.ok) return;
    this.dialog = null;
    this.busy = true;
    let failed = 0;
    let firstErr = "";
    for (const c of res.calls) {
      try {
        await this.call(c);
      } catch (err) {
        failed++;
        firstErr ||= err instanceof Error ? err.message : String(err);
        // Never delete duplicates if the merged write itself failed.
        if (c === res.calls[0]) break;
      }
    }
    this.busy = false;
    const primary = this.nodeById.get(res.primaryId);
    this.recordOp("consolidate", { primary: res.primaryId, merged: res.mergedIds, calls: res.calls.length, failed });
    this.logActivity(`Merged ${res.mergedIds.length} into ${primary?.label ?? "one"}`, res.primaryId, "new");
    this.showToast(
      failed ? `Merge stopped: ${firstErr}` : `Merged ${res.mergedIds.length + 1} into “${res.title}”`,
      failed ? "err" : "ok",
    );
    this.setSelection([res.primaryId]);
    await this.refresh(true);
  }


  // ── Consolidate sub-projects ──────────────────────────────
  /** kanban.projects.list rows by store id (description / status / archived), read once per dialog. */
  private projectRows: Map<string, Record<string, unknown>> | null = null;

  private openSubConsolidate(parentId: string): void {
    this.menu = null;
    const parent = this.nodeById.get(parentId);
    if (!parent || parent.kind !== "project") return;
    const subs = subProjectsOf(parent, this.nodes, this.opEdges());
    if (!subs.length) {
      this.showToast(`${parent.label} has no sub-projects to consolidate.`, "warn");
      return;
    }
    const clusters = clusterSubProjects(parent, subs, (id) => this.adjacency.get(id)?.size ?? 0);
    const inCluster = new Set(clusters.flatMap((c) => c.ids));
    const others = subs
      .filter((x) => !inCluster.has(x.id))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((x) => x.id);
    this.projectRows = null;
    this.dialog = {
      type: "subs",
      parentId,
      clusters,
      others,
      checked: new Set(inCluster),
      keepers: new Map(),
      mode: "tasks",
      taskMode: "move",
      details: new Map(),
      loading: 0,
      batch: Date.now().toString(36),
      plan: null,
      showOthers: clusters.length === 0,
    };
    void this.loadSubDetails([...inCluster]);
  }

  private subsDialog(parentId?: string): SubsDialog | null {
    const d = this.dialog;
    return d?.type === "subs" && (!parentId || d.parentId === parentId) ? d : null;
  }

  /** Read-only: relations, tasks, page body and notes for each sub-project (preview + plan inputs). */
  private async loadSubDetails(ids: string[]): Promise<void> {
    const d0 = this.subsDialog();
    if (!d0) return;
    const parentId = d0.parentId;
    const need = ids.filter((id) => !d0.details.has(id) && this.nodeById.has(id));
    if (!need.length) {
      this.replanSubs();
      return;
    }
    this.dialog = { ...d0, loading: d0.loading + need.length };
    try {
      if (!this.projectRows) {
        const raw = await this.call({ method: "kanban.projects.list", params: { includeArchived: true } });
        const list = Array.isArray(raw) ? raw : ((raw as { projects?: unknown[] })?.projects ?? []);
        this.projectRows = new Map(
          (list as Array<Record<string, unknown>>).filter((r) => typeof r?.id === "string").map((r) => [r.id as string, r]),
        );
      }
    } catch {
      this.projectRows = new Map();
    }
    const queue = [...need];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const node = this.nodeById.get(id);
        if (!node) continue;
        const sid = storeIdOf(node);
        const [rels, tasks, md] = await Promise.all([
          this.call({ method: "objrel.list", params: { type: "project", id: sid } }).catch(() => null),
          this.call({ method: "kanban.tasks.list", params: { projectId: sid } }).catch(() => null),
          this.call({ method: "kanban.projects.content.getMarkdown", params: { projectId: sid } }).catch(() => null),
        ]);
        const taskList = (Array.isArray(tasks) ? tasks : ((tasks as { tasks?: unknown[] })?.tasks ?? [])) as Array<Record<string, unknown>>;
        const notes: SubDetail["notes"] = [];
        for (const r of this.relations.get(id) ?? []) {
          const o = this.nodeById.get(r.other);
          if (o?.kind === "note" && r.rel === "about" && !isDocumentNode(o)) notes.push({ id: storeIdOf(o), label: o.label });
        }
        const row = this.projectRows?.get(sid);
        const detail: SubDetail = {
          node,
          id: sid,
          description: typeof row?.description === "string" ? row.description : undefined,
          status: typeof row?.status === "string" ? row.status : String(node.meta?.status ?? ""),
          priority: typeof row?.priority === "string" ? row.priority : undefined,
          archived: row?.archived === true,
          markdown: typeof (md as { markdown?: unknown })?.markdown === "string" ? (md as { markdown: string }).markdown : "",
          tasks: taskList
            .filter((t) => typeof t?.id === "string" && (t.projectId == null || t.projectId === sid))
            .map((t) => ({ id: t.id as string, title: String(t.title ?? t.name ?? "Untitled"), status: typeof t.status === "string" ? t.status : undefined })),
          relations: (((rels as { relations?: RelationRow[] })?.relations ?? []) as RelationRow[]).filter((r) => typeof r?.id === "string"),
          notes,
        };
        const cur = this.subsDialog(parentId);
        if (!cur) return;
        cur.details.set(id, detail);
        this.dialog = { ...cur, loading: Math.max(0, cur.loading - 1) };
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, need.length) }, worker));
    this.replanSubs();
  }

  /** Rebuild the dry-run plan from the dialog's current choices. */
  private replanSubs(patch: Partial<SubsDialog> = {}): void {
    const d0 = this.subsDialog();
    if (!d0) return;
    const d: SubsDialog = { ...d0, ...patch };
    const parent = this.nodeById.get(d.parentId);
    if (!parent) return;
    const today = new Date().toISOString().slice(0, 10);
    const ready = [...d.checked].filter((id) => d.details.has(id));
    let plan: ConsolidationPlan;
    if (d.mode === "tasks") {
      plan = planConvertToTasks(parent, ready.map((id) => d.details.get(id)!), { taskMode: d.taskMode, batchId: d.batch, today });
    } else {
      const groups: Array<{ keeper: SubDetail; others: SubDetail[] }> = [];
      for (const c of d.clusters) {
        const keeperId = d.keepers.get(c.key) ?? c.keeperId;
        const keeper = d.details.get(keeperId);
        const others = c.ids.filter((id) => id !== keeperId && d.checked.has(id) && d.details.has(id)).map((id) => d.details.get(id)!);
        if (keeper && others.length) groups.push({ keeper, others });
      }
      plan = planMergeDuplicates(parent, groups, { batchId: d.batch, today });
    }
    const report = describePlan(plan, d.clusters, (id) => this.nodeById.get(id)?.label ?? id);
    (globalThis as Record<string, unknown>).__kgConsolidationDryRun = { parent: parent.label, report, plan, clusters: d.clusters };
    this.dialog = { ...d, plan, report, error: undefined };
  }

  private toggleSub(id: string, on: boolean): void {
    const d = this.subsDialog();
    if (!d) return;
    const checked = new Set(d.checked);
    if (on) checked.add(id);
    else checked.delete(id);
    this.dialog = { ...d, checked };
    if (on && !d.details.has(id)) void this.loadSubDetails([id]);
    else this.replanSubs();
  }

  /**
   * Execute the plan step by step (the owner's click). Refs from earlier steps
   * (new task ids, created relation ids) are resolved as we go. A failed
   * critical step rolls the whole batch back; the batch's undo goes on the
   * undo stack. Nothing is deleted — originals are archived.
   */
  private async applySubs(): Promise<void> {
    const d = this.subsDialog();
    const plan = d?.plan;
    if (!d || !plan || !plan.steps.length || d.running) return;
    const total = plan.steps.length;
    this.dialog = { ...d, running: { done: 0, total } };
    this.busy = true;
    const refs = new Map<string, string | null>();
    const executed: ConsolidateStep[] = [];
    const failures: Array<{ step: ConsolidateStep; error: string }> = [];
    let archivePending = 0;
    let aborted: string | null = null;
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const call = resolveRefs(step.call, refs);
      if (call === UNRESOLVED) {
        failures.push({ step, error: "skipped — an earlier step for this sub-project failed" });
        continue;
      }
      try {
        const res = await this.call(call);
        executed.push(step);
        if (step.capture) refs.set(step.capture, captureOf(step, call, res));
        if (call.method === "kanban.projects.update" && res && typeof res === "object") {
          const r = res as { localOnly?: boolean; notionSyncFailed?: boolean };
          if (r.localOnly || r.notionSyncFailed) archivePending++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (step.critical) {
          aborted = `${step.label}: ${msg}`;
          break;
        }
        failures.push({ step, error: msg });
      }
      if (i % 3 === 0) {
        const cur = this.subsDialog(d.parentId);
        if (cur) this.dialog = { ...cur, running: { done: i + 1, total } };
      }
    }
    const undo = buildUndo(executed, refs);
    if (aborted) {
      // Atomic-ish: put everything back before reporting.
      let undoFailed = 0;
      for (const c of undo) {
        try {
          await this.call(c);
        } catch {
          undoFailed++;
        }
      }
      this.busy = false;
      const cur = this.subsDialog(d.parentId);
      if (cur) this.dialog = { ...cur, running: undefined, error: `Stopped and rolled back${undoFailed ? ` (${undoFailed} undo steps failed)` : ""} — ${aborted}` };
      this.recordOp("consolidate-subs", { aborted, executed: executed.length, rolledBack: undo.length, undoFailed });
      return;
    }
    const n = plan.items.filter((it) => it.action !== "keep").length;
    this.undoStack.push(`${plan.mode === "tasks" ? "Converted" : "Merged"} ${n} sub-project${n === 1 ? "" : "s"}`, undo);
    this.recordOp("consolidate-subs", {
      mode: plan.mode,
      parent: plan.parentLabel,
      items: n,
      calls: executed.length,
      failed: failures.length,
      archivePending,
      undoCalls: undo.length,
    });
    this.logActivity(`${plan.mode === "tasks" ? "Converted" : "Merged"} ${n} sub-projects of ${plan.parentLabel}`, plan.parentId, "new");
    this.busy = false;
    this.dialog = null;
    const pending = archivePending ? ` · archive flag pending a gateway restart for ${archivePending}` : "";
    const fail = failures.length ? ` · ${failures.length} step${failures.length === 1 ? "" : "s"} failed (${failures[0].error})` : "";
    this.showToast(
      `${plan.mode === "tasks" ? `Converted ${n} sub-projects to tasks under ${plan.parentLabel}` : `Merged ${n} duplicates`}${pending}${fail}`,
      failures.length ? "warn" : "ok",
      undo.length > 0,
    );
    await this.refresh(true);
    await this.refreshConsolidated(true);
  }

  private async copySubsReport(d: SubsDialog): Promise<void> {
    try {
      await navigator.clipboard.writeText(d.report ?? "");
      this.showToast("Dry-run report copied", "ok");
    } catch {
      this.showToast("Clipboard unavailable", "warn");
    }
  }

  private renderSubsDialog(d: SubsDialog, wrap: (title: string, body: unknown, foot: unknown, wide?: boolean) => unknown) {
    const parent = this.nodeById.get(d.parentId);
    const p = d.plan;
    const label = (id: string) => this.nodeById.get(id)?.label ?? id;
    const row = (id: string, cluster?: SubCluster) => {
      const det = d.details.get(id);
      const keeperId = cluster ? (d.keepers.get(cluster.key) ?? cluster.keeperId) : null;
      const keep = d.mode === "merge" && keeperId === id;
      const meta = det
        ? `${det.status || "—"} · ${det.tasks.length} task${det.tasks.length === 1 ? "" : "s"} · ${det.relations.length} link${det.relations.length === 1 ? "" : "s"}${det.notes.length ? ` · ${det.notes.length} note${det.notes.length === 1 ? "" : "s"}` : ""}${det.archived ? " · archived" : ""}`
        : d.checked.has(id)
          ? "reading…"
          : "";
      return html`<label class="kg-subs-row ${keep ? "kg-subs-row--keep" : ""}">
        <input type="checkbox" .checked=${d.checked.has(id)} @change=${(e: Event) => this.toggleSub(id, (e.target as HTMLInputElement).checked)} />
        <span class="kg-subs-name">${label(id)}</span>
        <em>${meta}</em>
        ${cluster && d.mode === "merge"
          ? html`<button class="kg-subs-keep ${keep ? "on" : ""}" title="Keep this one; merge the others into it"
              @click=${(e: Event) => {
                e.preventDefault();
                const keepers = new Map(d.keepers);
                keepers.set(cluster.key, id);
                this.replanSubs({ keepers });
              }}>${keep ? "Keep" : "keep?"}</button>`
          : nothing}
      </label>`;
    };
    const counts = p ? Object.entries(p.counts).map(([m, c]) => `${m.replace(/^kanban\./, "")}×${c}`).join(" · ") : "";
    const changed = p ? p.items.filter((it) => it.action !== "keep").length : 0;
    return wrap(
      `Consolidate sub-projects · ${parent?.label ?? ""}`,
      html`
        <div class="kg-seg2 kg-subs-modes">
          <button class=${d.mode === "tasks" ? "on" : ""} @click=${() => this.replanSubs({ mode: "tasks" })}>Convert to tasks under ${truncate(parent?.label ?? "parent", 22)}</button>
          <button class=${d.mode === "merge" ? "on" : ""} @click=${() => this.replanSubs({ mode: "merge" })}>Merge duplicates into one</button>
        </div>
        ${d.mode === "tasks"
          ? html`<div class="kg-seg2 kg-subs-modes">
              <button class=${d.taskMode === "move" ? "on" : ""} @click=${() => this.replanSubs({ taskMode: "move" })}>Their tasks → ${truncate(parent?.label ?? "parent", 18)}</button>
              <button class=${d.taskMode === "checklist" ? "on" : ""} @click=${() => this.replanSubs({ taskMode: "checklist" })}>Nest their tasks as a checklist</button>
            </div>`
          : nothing}
        <p class="kg-subs-note">${icons.shield} Nothing is deleted: originals are archived with a back-reference, and Undo reverts the whole batch.</p>
        ${d.clusters.length
          ? d.clusters.map(
              (c) => html`<div class="kg-subs-cl">
                <div class="kg-subs-clh">
                  <span class="kg-tier kg-tier--${c.tier}">${c.tier === "duplicate" ? "Duplicates" : "Near-duplicates"} · ${Math.round(c.score * 100)}%</span>
                  <span class="kg-muted">${c.ids.length} sub-projects</span>
                </div>
                ${c.ids.map((id) => row(id, c))}
              </div>`,
            )
          : html`<p class="kg-muted">No look-alike sub-projects found — pick any below to convert.</p>`}
        ${d.others.length
          ? html`<button class="kg-link kg-subs-more" @click=${() => (this.dialog = { ...d, showOthers: !d.showOthers })}>
                ${d.showOthers ? "Hide" : "Show"} the other ${d.others.length} sub-projects
              </button>
              ${d.showOthers ? html`<div class="kg-subs-cl kg-subs-cl--others">${d.others.map((id) => row(id))}</div>` : nothing}`
          : nothing}
        <label class="kg-lbl">Preview ${d.loading ? html`<span class="kg-muted">· reading ${d.loading}…</span>` : nothing}</label>
        <div class="kg-subs-plan">
          ${p && p.items.length
            ? p.items.map(
                (it) => html`<div class="kg-subs-pi kg-subs-pi--${it.action}">
                  ${it.action === "to-task"
                    ? html`<b>${it.label}</b> → task under ${it.intoLabel} <span class="kg-subs-st">${it.taskStatus}</span>
                        <em>${it.movedTasks ? `${it.movedTasks} tasks moved · ` : ""}${it.checklist ? `${it.checklist} checklist items · ` : ""}${it.relationsCopied} links carried · ${it.notesMoved} notes · archived</em>`
                    : it.action === "merge-into"
                      ? html`<b>${it.label}</b> → merged into “${it.intoLabel}” <em>${it.movedTasks} tasks · ${it.relationsCopied} links re-pointed · archived</em>`
                      : html`<b>${it.label}</b> <span class="kg-subs-st kg-subs-st--keep">kept</span>`}
                </div>`,
              )
            : html`<span class="kg-muted">${d.loading ? "Reading sub-projects…" : "Tick sub-projects to plan."}</span>`}
        </div>
        ${p ? html`<div class="kg-merge-sum"><span>${changed} sub-project${changed === 1 ? "" : "s"}</span><span>${p.steps.length} gateway writes</span><span>${p.deletes} deletes</span><span class="kg-muted">${counts}</span></div>` : nothing}
        ${d.running ? html`<div class="kg-subs-prog"><i style="width:${Math.round((d.running.done / Math.max(1, d.running.total)) * 100)}%"></i><span>Applying ${d.running.done}/${d.running.total}…</span></div>` : nothing}
        ${d.error ? html`<p class="kg-warn">${d.error}</p>` : nothing}
      `,
      html`<button class="kg-btn" ?disabled=${!d.report} @click=${() => void this.copySubsReport(d)}>${icons.copy} Copy dry-run report</button>
        <span style="flex:1"></span>
        <button class="kg-btn" ?disabled=${!!d.running} @click=${() => (this.dialog = null)}>Cancel</button>
        <button class="kg-btn kg-btn--primary" data-ib-target="control:knowledge-graph/consolidate-apply"
          ?disabled=${!p || !changed || d.loading > 0 || !!d.running} @click=${() => void this.applySubs()}>
          ${icons.layers} ${d.mode === "tasks" ? `Convert ${changed} to tasks` : `Merge ${changed}`}
        </button>`,
      true,
    );
  }

  // ── AI + agents ───────────────────────────────────────────
  private async openAi(intent: AiIntent, ids: string[]): Promise<void> {
    this.menu = null;
    if (this.lane === "secure") {
      // The AI drawer runs on the normal lane (remote models, normal session).
      this.showToast("AI actions are off for the secure graph.", "warn");
      return;
    }
    const nodes = this.nodesOf(ids);
    if (!nodes.length) return;
    await this.updateComplete;
    const drawer = this.querySelector<KgAiDrawer>("kg-ai-drawer");
    if (!drawer) return;
    this.aiOpen = true;
    const title = nodes.length === 1 ? nodes[0].label : `${nodes.length} items`;
    await drawer.start({
      intent,
      title,
      context: buildAiContext(nodes, this.opEdges(), this.nodeById),
      count: nodes.length,
      nodeIds: nodes.map((n) => n.id),
    });
  }

  @state() private aiOpen = false;

  private openRelated(ids: string[]): void {
    this.menu = null;
    const focus = new Set(ids);
    const items = suggestLinks(this.nodes, this.opEdges(), { focus, limit: 10 });
    this.dialog = { type: "related", ids, items };
  }

  private openSpawn(ids: string[]): void {
    this.menu = null;
    const nodes = this.nodesOf(ids);
    if (!nodes.length) return;
    const goal =
      nodes.length === 1 && nodes[0].kind === "project"
        ? `Review the project "${nodes[0].label}": check its open, blocked and overdue tasks, unblock what you can, and report back with what changed.`
        : "";
    this.dialog = { type: "spawn", ids, goal, agentId: "" };
  }

  private async confirmSpawn(d: Extract<Dialog, { type: "spawn" }>): Promise<void> {
    const nodes = this.nodesOf(d.ids);
    const task = spawnTask(buildAiContext(nodes, this.opEdges(), this.nodeById, 5000), nodes.length, d.goal);
    this.dialog = { ...d, busy: true };
    try {
      const res = (await this.call({
        method: "sessions.spawn",
        params: {
          task,
          label: `Graph · ${nodes.length === 1 ? nodes[0].label : `${nodes.length} items`}`.slice(0, 80),
          ...(d.agentId ? { agentId: d.agentId } : {}),
        },
      })) as Record<string, unknown> | undefined;
      this.dialog = null;
      const run = String(res?.runId ?? res?.childSessionKey ?? res?.sessionKey ?? "");
      this.recordOp("spawn", { run, ids: d.ids });
      this.logActivity(`Agent spawned on ${nodes.length === 1 ? nodes[0].label : `${nodes.length} items`}`, nodes[0].id, "live");
      this.showToast(`Agent started${run ? ` · ${run.slice(0, 18)}` : ""} — watch it under Agents.`, "ok");
    } catch (err) {
      this.dialog = { ...d, busy: false };
      this.showToast(`Couldn't start the agent: ${err instanceof Error ? err.message : String(err)}`, "err");
    }
  }

  // ── HUD actions ───────────────────────────────────────────
  private async insightAction(ins: HudInsight, action: InsightAction): Promise<void> {
    switch (action) {
      case "focus":
        this.setInsight(this.activeInsight?.id === ins.id ? null : ins);
        break;
      case "select":
        this.setSelection(ins.nodeIds);
        break;
      case "consolidate":
        await this.openConsolidate(ins.nodeIds);
        break;
      case "subs":
        if (ins.nodeIds[0]) this.openSubConsolidate(ins.nodeIds[0]);
        break;
      case "link": {
        if (!ins.pair) break;
        const target = this.nodeById.get(ins.pair[1]);
        if (target) await this.linkTo([ins.pair[0]], target);
        this.dismissInsight(ins);
        break;
      }
      case "suggest":
        this.openRelated(ins.nodeIds.slice(0, 40));
        break;
      case "chat":
        await this.openAi("summarize", ins.nodeIds.slice(0, 40));
        break;
      case "spawn":
        this.openSpawn(ins.nodeIds.slice(0, 20));
        break;
      case "dismiss":
        this.dismissInsight(ins);
        break;
    }
  }

  private dismissInsight(ins: HudInsight): void {
    this.dismissed.add(ins.id);
    try {
      globalThis.localStorage?.setItem(DISMISS_KEY, JSON.stringify([...this.dismissed].slice(-300)));
    } catch {
      /* session-only dismissal */
    }
    this.hudInsights = this.hudInsights.filter((i) => i.id !== ins.id);
    if (this.activeInsight?.id === ins.id) this.setInsight(null);
  }

  /** HUD legend: each 3D node shape with its type (mirrors KIND_SHAPE). */
  private renderShapeLegend() {
    const g = (d: string) => html`<svg viewBox="0 0 20 20" aria-hidden="true">${unsafeSvgPath(d)}</svg>`;
    const items: Array<[string, ReturnType<typeof g>, string]> = [
      ["Project", g("M10 2 17 8 10 18 3 8Z M3 8H17 M7 8 10 2 13 8 10 18"), "kg-sl--main"],
      ["Sub-project", g("M10 6 14 9.5 10 15 6 9.5Z M6 9.5H14"), "kg-sl--sub"],
      ["Task", g("M4 4H16V16H4Z M7 7H13V13H7Z"), ""],
      ["Note · File", g("M6 3H15V15H6Z M4 5H13V17H4Z"), ""],
      ["Report", g("M4 3H16V17H4Z M7 14V11 M10 14V8 M13 14V6"), ""],
      ["Media", g("M3 5H17V15H3Z M9 8 12 10 9 12Z"), ""],
      ["Agent", g("M10 6.5A3.5 3.5 0 1 1 9.99 6.5Z M2 11C6 6 14 6 18 9"), ""],
      ["Person", g("M10 3.5A2.5 2.5 0 1 1 9.99 3.5Z M6 17V12A4 4 0 0 1 14 12V17Z"), ""],
      ["System", g("M10 3 16 6.5V13.5L10 17 4 13.5V6.5Z"), ""],
      ["Knowledge", g("M10 7.5A2.5 2.5 0 1 1 9.99 7.5Z M10 2V5 M10 15V18 M2 10H5 M15 10H18 M4.5 4.5 6.5 6.5 M15.5 15.5 13.5 13.5 M15.5 4.5 13.5 6.5 M4.5 15.5 6.5 13.5"), ""],
    ];
    return html`
      <div class="kg-shape-legend" role="list" aria-label="Node shapes">
        ${items.map(
          ([label, icon, cls]) => html`<span class="kg-sl ${cls}" role="listitem" title="${label}">${icon}<span class="kg-sl-t">${label}</span></span>`,
        )}
      </div>
    `;
  }

  // ── Settings ──────────────────────────────────────────────
  private setGroupMode(mode: GroupMode): void {
    if (mode === this.groupMode) return;
    this.groupMode = mode;
    this.groupChanged = true;
    savePref("group.v2", mode);
    if (mode !== "orbit" && mode !== "brain") this.hudTab = "groups";
  }

  private setMotionPref(p: MotionPref): void {
    this.motionPref = p;
    savePref("motion", p);
    this.applyMotion();
  }

  private setQualityPref(q: QualityMode): void {
    this.qualityPref = q;
    savePref("quality", q);
    this.stage?.setQualityMode(q);
  }

  private setConnectionsMode(m: ConnectionsMode): void {
    this.connectionsMode = m;
    savePref("connections", m);
    this.stage?.setConnectionsMode(m);
    this.scheduleDraw();
  }

  private setHulls(on: boolean): void {
    this.hullsOn = on;
    savePref("hulls", on ? "on" : "off");
    this.stage?.setHullsVisible(on);
    this.scheduleDraw();
  }

  private setAmbience(on: boolean): void {
    this.ambienceOn = on;
    savePref("ambience", on ? "on" : "off");
    this.stage?.setAmbience(on);
  }

  private resetLayout(): void {
    try {
      globalThis.localStorage?.removeItem("infinibot.kg.pos.v1");
    } catch {
      /* no storage */
    }
    this.nodes = [];
    this.topoSig = "";
    this.needsFit = true;
    this.userMovedView = false;
    this.settingsOpen = false;
    this.rebuildSimulation();
  }

  private schedulePositionSave(): void {
    // Secure lane: never persist secure node ids/positions to localStorage
    // (and never overwrite the normal graph's saved layout).
    if (this.synthCount > 0 || this.lane === "secure") return;
    if (this.savePosTimer) clearTimeout(this.savePosTimer);
    this.savePosTimer = setTimeout(() => {
      this.savePosTimer = null;
      savePositions(this.nodes, this.center);
    }, 800);
  }

  // ── UI ────────────────────────────────────────────────────
  override render() {
    const sel = this.selectedId ? (this.nodeById.get(this.selectedId) ?? null) : null;
    const shown = this.nodes.length;
    const total = this.snapshot?.nodes.length ?? 0;
    const multi = this.selection.size > 1;
    const highCount = this.hudInsights.filter((i) => i.severity === "high").length;
    return html`
      ${this.styles()} ${kgOverlayStyles}
      <div class="kg-host ${this.lane === "secure" ? "kg-host--secure" : ""} ${this.compact ? "kg-host--compact" : ""} ${this.embed && !this.compact ? "kg-host--embed" : ""} ${this.touchPeek ? "kg-host--peek" : ""}">
        <span class="kg-corner kg-corner--tl" aria-hidden="true"></span>
        <span class="kg-corner kg-corner--tr" aria-hidden="true"></span>
        <span class="kg-corner kg-corner--bl" aria-hidden="true"></span>
        <span class="kg-corner kg-corner--br" aria-hidden="true"></span>

        <div class="kg-toolbar">
          <span class="kg-scanline" aria-hidden="true"></span>
          ${this.embed && !this.compact && hasNativeHost()
            ? html`<button
                class="kg-btn kg-btn--icon kg-back"
                title="Back"
                aria-label="Back"
                data-ib-target="control:knowledge-graph/back"
                @click=${() => postNative({ type: "back" })}
              >
                ${icons.arrowLeft}
              </button>`
            : nothing}
          <span class="kg-title">${this.lane === "secure" ? "Secure Graph" : this.repoMode ? "Repo Graph" : "Knowledge Graph"}</span>
          ${this.secureCapable && !this.compact && !this.embed
            ? html`<ib-secure-toggle compact class="kg-secure-toggle" data-secure-surface="knowledge-graph"></ib-secure-toggle>`
            : nothing}
          ${total > 0
            ? html`<span class="kg-node-count" title="${shown} shown of ${total} collected">${shown}</span>`
            : nothing}
          <input
            class="kg-search"
            data-ib-target="control:knowledge-graph/search"
            type="search"
            placeholder="Search projects, clients, notes…"
            .value=${this.search}
            @input=${(e: Event) => {
              this.search = (e.target as HTMLInputElement).value;
            }}
          />
          <!-- display:contents on desktop (no layout change); the app embed makes it a swipeable strip. -->
          <div class="kg-tb-tools">
          ${this.compact
            ? nothing
            : html`
                <div class="kg-seg" role="group" aria-label="Interaction mode">
                  <button
                    class="kg-btn kg-btn--icon ${this.selectMode ? "kg-btn--on" : ""}"
                    title="Select mode — drag to lasso (or hold Shift)"
                    aria-pressed=${this.selectMode}
                    data-ib-target="control:knowledge-graph/select-mode"
                    @click=${() => this.setModes(false, !this.selectMode)}
                  >
                    ${icons.target}
                  </button>
                  <button
                    class="kg-btn kg-btn--icon ${this.linkMode ? "kg-btn--on" : ""}"
                    title="Link mode — drag from one node to another (or hold Ctrl/⌘)"
                    aria-pressed=${this.linkMode}
                    data-ib-target="control:knowledge-graph/link-mode"
                    @click=${() => this.setModes(!this.linkMode, false)}
                  >
                    ${icons.link}
                  </button>
                </div>
                <label class="kg-group-pick" title="Group nodes">
                  ${icons.layers}<span class="kg-hide-sm kg-group-lbl">Group</span>
                  <select
                    data-ib-target="control:knowledge-graph/group"
                    .value=${this.groupMode}
                    @change=${(e: Event) => this.setGroupMode((e.target as HTMLSelectElement).value as GroupMode)}
                  >
                    ${GROUP_MODES.map((g) => html`<option value=${g.id} ?selected=${g.id === this.groupMode}>${g.label}</option>`)}
                  </select>
                </label>
                <div class="kg-conn" role="group" aria-label="Connections" title="Connections — all / selected only / none">
                  <span class="kg-hide-sm kg-conn-lbl">${icons.network}</span>
                  ${CONNECTIONS_MODES.map(
                    (m) => html`<button
                      class="kg-conn-b ${this.connectionsMode === m.id ? "on" : ""}"
                      data-ib-target=${`control:knowledge-graph/connections-${m.id}`}
                      aria-pressed=${this.connectionsMode === m.id}
                      title=${m.id === "all" ? "Show every connection" : m.id === "selected" ? "Only the hovered/selected node's connections" : "Hide connections"}
                      @click=${() => this.setConnectionsMode(m.id)}
                    >${m.label}</button>`,
                  )}
                </div>
                <button
                  class="kg-btn kg-btn--icon ${this.hullsOn ? "kg-btn--on" : ""}"
                  title=${this.hullsOn ? "Hide grouping hulls" : "Show grouping hulls"}
                  aria-pressed=${this.hullsOn}
                  data-ib-target="control:knowledge-graph/hulls"
                  @click=${() => this.setHulls(!this.hullsOn)}
                >
                  ${icons.circle}
                </button>
                <button
                  class="kg-btn ${this.hudOpen ? "kg-btn--on" : ""}"
                  title="Toggle the signals HUD"
                  data-ib-target="control:knowledge-graph/hud"
                  @click=${() => this.toggleHud()}
                >
                  ${icons.radio}<span class="kg-hide-sm">Signals</span>${this.hudInsights.length
                    ? html`<span class="kg-btn-badge ${highCount ? "kg-btn-badge--hot" : ""}">${this.hudInsights.length}</span>`
                    : nothing}
                </button>
              `}
          <button class="kg-btn kg-btn--icon" ?disabled=${this.loading} title="Refresh" @click=${() => void this.refresh(true)}>
            <span class=${this.loading ? "kg-spin" : ""}>${icons.refresh}</span>
          </button>
          <button class="kg-btn kg-btn--icon" title="Fit all nodes into view" data-ib-target="control:knowledge-graph/fit" @click=${() => this.resetView()}>
            ${icons.maximize}
          </button>
          <button
            class="kg-btn kg-btn--mode ${this.mode === "3d" ? "kg-btn--on" : ""}"
            title=${this.mode === "3d" ? "3D galaxy — click for the flat map" : "Flat map — click for the 3D galaxy"}
            data-ib-target="control:knowledge-graph/renderer"
            @click=${() => this.toggleRenderer()}
          >
            ${this.mode === "3d" ? "3D" : "2D"}
          </button>
          ${this.lane === "secure" || this.compact ? nothing : this.renderRepoToolbar()}
          ${this.compact
            ? nothing
            : html`<button
                class="kg-btn kg-btn--icon ${this.settingsOpen ? "kg-btn--on" : ""}"
                title="Display settings"
                @click=${() => (this.settingsOpen = !this.settingsOpen)}
              >
                ${icons.sliders}
              </button>`}
          </div>
        </div>

        ${this.projectScope && !this.compact ? this.renderScopeBar() : nothing}
        ${this.compact ? nothing : this.renderLegend()}

        <div class="kg-stage ${this.mode === "3d" ? "kg-stage--3d" : ""}" @pointerdown=${this.onStagePointerDown}>
          ${this.mode === "3d"
            ? html`<div class="kg-3d-host" data-ib-target="control:knowledge-graph/stage"></div>`
            : html`<canvas class="kg-canvas" aria-label="Knowledge graph"></canvas>`}
          ${this.mode === "3d" && !this.compact ? this.renderShapeLegend() : nothing}
          <svg class="kg-overlay" aria-hidden="true">
            <defs>
              <linearGradient id="kg-dl-grad" x1="0" x2="1">
                <stop offset="0" stop-color="#f5c542" />
                <stop offset="1" stop-color="#5ee7ff" />
              </linearGradient>
            </defs>
            <polygon class="kg-lasso" style="display:none"></polygon>
            <circle class="kg-drop" style="display:none"></circle>
            <path class="kg-dl" style="display:none"></path>
          </svg>
          <div class="kg-dl-tip" style="display:none"></div>
          <div class="kg-drop-tip" style="display:none"></div>
          ${this.linkMode || this.selectMode
            ? html`<div class="kg-mode-hint">
                ${this.linkMode ? icons.link : icons.target}
                <span class="kg-mode-hint-t">${this.linkMode
                  ? this.linkTapFrom
                    ? `Linking ${truncate(this.nodeById.get(this.linkTapFrom)?.label ?? "", 22)} · tap the target`
                    : "Link mode · tap a node, then its target (or drag one onto another)"
                  : "Select mode · drag a lasso around nodes"}</span>
                <button class="kg-link" @click=${() => this.setModes(false, false)}>Done</button>
              </div>`
            : nothing}
          ${!this.compact ? this.renderHud() : nothing}
          ${sel && !multi && !this.aiOpen && sel.id !== this.peekId ? this.renderDetail(sel) : nothing}
          ${this.hoverCardId && !this.menu ? this.renderHoverCard() : nothing}
          ${this.menu ? this.renderMenu() : nothing}
          ${this.selection.size > 1 && !this.menu ? this.renderBulkBar() : nothing}
          ${this.settingsOpen ? this.renderSettings() : nothing}
          ${this.error ? html`<div class="kg-banner kg-banner-err">${this.error}</div>` : nothing}
          ${this.snapshot == null && this.loading
            ? html`<div class="kg-banner">Mapping projects…</div>`
            : nothing}
          ${this.projectScope && !this.repoMode && this.snapshot != null && !this.loading && scopeIsSparse(this.scopeInfo, this.nodes.length)
            ? this.renderScopeEmpty()
            : nothing}
          ${this.snapshot != null && this.nodes.length === 0 && !this.projectScope
            ? html`
                <div class="kg-empty">
                  <div class="kg-empty-text">
                    ${this.search
                      ? "No nodes match · clear search to see all"
                      : "Nothing to show · enable a layer or status above"}
                  </div>
                </div>
              `
            : nothing}
          ${this.renderSecurePanel()}
          <kg-ai-drawer
            .client=${this.lane === "secure" ? null : this.client}
            @kg-ai-close=${() => (this.aiOpen = false)}
          ></kg-ai-drawer>
          ${this.dialog ? this.renderDialog(this.dialog) : nothing}
          ${this.toast
            ? html`<div class="kg-toast kg-toast--${this.toast.tone}" role="status">
                ${this.toast.tone === "err" ? icons.alertCircle : this.toast.tone === "warn" ? icons.alert : icons.checkCircle}
                <span>${this.toast.text}</span>
                ${this.toast.undo && this.undoStack.size
                  ? html`<button class="kg-toast-undo" @click=${() => void this.undoLast()}>Undo</button>`
                  : nothing}
              </div>`
            : nothing}
          ${this.busy ? html`<div class="kg-busy" aria-hidden="true"></div>` : nothing}
        </div>

        <span class="kg-footer-strip" aria-hidden="true"></span>
      </div>
    `;
  }

  /** Keep the open context menu fully inside the stage using its measured size. */
  private fitMenu(): void {
    const el = this.querySelector<HTMLElement>(".kg-menu");
    const st = this.querySelector<HTMLElement>(".kg-stage");
    if (!el || !st || !this.menu) return;
    const W = st.clientWidth;
    const H = st.clientHeight;
    const w = el.offsetWidth;
    const h = Math.min(el.offsetHeight, H - 16);
    // Open beside the pointer; flip left/up when it would spill out.
    let x = this.menu.x + 14;
    if (x + w > W - 8) x = this.menu.x - w - 14;
    let y = this.menu.y - 12;
    if (y + h > H - 8) y = H - h - 8;
    el.style.transform = `translate(${Math.max(8, Math.min(W - w - 8, x)).toFixed(0)}px, ${Math.max(8, y).toFixed(0)}px)`;
  }

  /** Clicks on stage chrome close floating menus (the canvas handles its own). */
  private onStagePointerDown = (e: PointerEvent): void => {
    this.lastPointerType = e.pointerType || "mouse";
    const t = e.target as HTMLElement;
    if (this.touchPeek && this.hoverCardId && !t.closest(".kg-hovercard") && (t.closest(".kg-detail") || t.closest(".kg-toolbar"))) this.hideHoverCard();
    if (this.menu && !t.closest(".kg-menu")) this.menu = null;
    if (this.settingsOpen && !t.closest(".kg-settings")) this.settingsOpen = false;
    if (this.statusMenu && !t.closest(".kg-status-pop")) this.statusMenu = false;
  };

  private toggleHud(): void {
    this.hudOpen = !this.hudOpen;
    savePref(this.hudKey, this.hudOpen ? "open" : "closed");
  }

  // ── Proactive HUD ─────────────────────────────────────────
  private renderHud() {
    const projects = this.nodes.filter((n) => n.kind === "project");
    const count = (h: ProjectHealth) => projects.filter((p) => p.health === h).length;
    const stale = projects.filter((p) => p.meta?.stale === true).length;
    const live = this.nodes.filter((n) => (n.kind === "project" && n.meta?.live === true) || (n.kind === "run" && n.meta?.active === true)).length;
    const high = this.hudInsights.filter((i) => i.severity === "high").length;
    if (!this.hudOpen) {
      return html`<button class="kg-hud-pill ${high ? "kg-hud-pill--hot" : ""}" title="Open signals" @click=${() => this.toggleHud()}>
        ${icons.radio}<b>${this.hudInsights.length}</b><span>signals</span>
      </button>`;
    }
    const groups = this.grouping?.groups ?? [];
    return html`
      <aside class="kg-hud" aria-label="Signals">
        <div class="kg-hud-head">
          <span class="kg-hud-beacon ${high ? "hot" : ""}" aria-hidden="true"></span>
          <span class="kg-panel-title">Signals</span>
          <span class="kg-hud-fps" title="Frames rendered in the last second">${this.fps ? `${this.fps} fps` : ""}</span>
          <button class="kg-hud-x" title="Collapse" @click=${() => this.toggleHud()}>${icons.chevronDown}</button>
        </div>
        <div class="kg-hud-stats">
          <div><b style="color:${HEALTH_COLOR.active}">${count("active") + count("review")}</b><span>active</span></div>
          <div><b style="color:${HEALTH_COLOR.blocked}">${count("blocked")}</b><span>blocked</span></div>
          <div><b style="color:${HEALTH_COLOR.at_risk}">${count("at_risk")}</b><span>at risk</span></div>
          <div><b>${stale}</b><span>stale</span></div>
          <div><b class=${live ? "kg-live" : ""}>${live}</b><span>live</span></div>
        </div>
        <div class="kg-hud-tabs" role="tablist">
          <button role="tab" class=${this.hudTab === "signals" ? "on" : ""} @click=${() => (this.hudTab = "signals")}>
            Signals <i>${this.hudInsights.length}</i>
          </button>
          <button role="tab" class=${this.hudTab === "activity" ? "on" : ""} @click=${() => (this.hudTab = "activity")}>
            Activity <i>${this.activity.length}</i>
          </button>
          ${this.groupMode !== "orbit"
            ? html`<button role="tab" class=${this.hudTab === "groups" ? "on" : ""} @click=${() => (this.hudTab = "groups")}>
                Groups <i>${groups.length}</i>
              </button>`
            : nothing}
        </div>
        <div class="kg-hud-body">
          ${this.hudTab === "signals"
            ? this.hudInsights.length
              ? this.hudInsights.slice(0, 30).map((ins) => this.renderInsightCard(ins))
              : html`<div class="kg-muted">${this.snapshot ? "All clear — nothing needs attention." : "Scanning…"}</div>`
            : this.hudTab === "activity"
              ? this.activity.length
                ? this.activity.map(
                    (a) => html`<button class="kg-act kg-act--${a.tone}" @click=${() => this.nodeById.has(a.nodeId) && this.selectNode(a.nodeId)}>
                      <span class="kg-act-dot"></span><span class="kg-act-text">${a.text}</span><time>${relativeAge(a.at)}</time>
                    </button>`,
                  )
                : html`<div class="kg-muted">Changes since you opened the graph show up here — new items, status flips, agents starting, and your own edits.</div>`
              : groups.length
                ? groups.slice(0, 40).map(
                    (g) => html`<div class="kg-grp">
                      <span class="kg-grp-dot" style="--c:${g.color}"></span>
                      <button class="kg-grp-name" title="Select this group" @click=${() => this.setSelection(g.memberIds)}>${g.label}</button>
                      <span class="kg-chip-count">${g.memberIds.length}</span>
                      <button class="kg-mini" title="Chat about this group" @click=${() => void this.openAi("summarize", g.memberIds.slice(0, 40))}>${icons.messageSquare}</button>
                      <button class="kg-mini" title="Focus" @click=${() => this.fitTo(g.memberIds, 1.4)}>${icons.target}</button>
                    </div>`,
                  )
                : html`<div class="kg-muted">No groups under this mode.</div>`}
        </div>
      </aside>
    `;
  }

  private renderInsightCard(ins: HudInsight) {
    const active = this.activeInsight?.id === ins.id;
    const label: Record<InsightAction, [string, unknown]> = {
      focus: [active ? "Unfocus" : "Focus", icons.target],
      select: ["Select", icons.check],
      consolidate: ["Consolidate", icons.layers],
      subs: ["Consolidate", icons.layers],
      link: ["Link", icons.link],
      suggest: ["Suggest links", icons.network],
      chat: ["Ask AI", icons.sparkles],
      spawn: ["Send agent", icons.bot],
      dismiss: ["Dismiss", icons.x],
    };
    return html`
      <div class="kg-insight ${active ? "kg-insight--on" : ""}" style="--sev:${SEVERITY_COLOR[ins.severity]}">
        <button class="kg-insight-main" @click=${() => void this.insightAction(ins, "focus")}>
          <span class="kg-insight-title">${ins.title}</span>
          ${ins.detail ? html`<span class="kg-insight-detail">${ins.detail}</span>` : nothing}
        </button>
        <div class="kg-insight-actions">
          ${ins.actions
            .filter((a) => a !== "focus")
            .slice(0, 3)
            .map(
              (a) => html`<button class="kg-ia" title=${label[a][0] as string} @click=${() => void this.insightAction(ins, a)}>
                ${label[a][1]}<span>${label[a][0]}</span>
              </button>`,
            )}
          <button class="kg-ia kg-ia--x" title="Dismiss" @click=${() => this.dismissInsight(ins)}>${icons.x}</button>
        </div>
      </div>
    `;
  }

  // ── Hover overlay ─────────────────────────────────────────
  private renderHoverCard() {
    const n = this.nodeById.get(this.hoverCardId!);
    if (!n) return nothing;
    const m = n.meta ?? {};
    const isProject = n.kind === "project";
    const tasks = Number(m.tasks ?? 0);
    const progress = Math.round(Math.max(0, Math.min(1, Number(m.progress ?? 0))) * 100);
    const statusText = isProject ? HEALTH_LABEL[n.health ?? "backlog"] : String(m.pipelineStatus ?? m.status ?? "").replace(/_/g, " ");
    const statusColor = isProject ? HEALTH_COLOR[n.health ?? "backlog"] : n.color;
    const last = Number(m.lastActivityAt ?? 0) || Number(m.updatedAt ?? 0) || Date.parse(String(m.updatedAt ?? "")) || 0;
    const neighbours = [...(this.adjacency.get(n.id) ?? [])]
      .map((id) => this.nodeById.get(id)!)
      .filter(Boolean)
      .sort((a, b) => Number(b.anchor) - Number(a.anchor) || (this.adjacency.get(b.id)?.size ?? 0) - (this.adjacency.get(a.id)?.size ?? 0));
    const owners = neighbours.filter((x) => x.kind === "agent" || x.kind === "person").map((x) => x.label);
    if (typeof m.assignedAgent === "string" && m.assignedAgent) owners.unshift(m.assignedAgent);
    const runs = neighbours.filter((x) => x.kind === "run");
    const top = neighbours.filter((x) => x.kind !== "agent").slice(0, 4);
    const live = m.live === true || m.active === true;
    return html`
      <div
        class="kg-hovercard"
        style="opacity:0"
        role="tooltip"
        @pointerenter=${() => this.hoverHideTimer && clearTimeout(this.hoverHideTimer)}
        @pointerleave=${(e: PointerEvent) => {
          // A finger lifting off the card is not "leaving" it: a pinned touch peek stays.
          if (e.pointerType === "mouse" || !this.touchPeek) this.queueHoverCard(null);
        }}
      >
        <div class="kg-hc-head">
          <span class="kg-detail-dot ${n.kind === "client" ? "kg-chip-dot--hex" : ""}" style="background:${n.color}"></span>
          <span class="kg-detail-kind">${KIND_SINGULAR[n.kind] ?? n.kind}</span>
          ${statusText ? html`<span class="kg-pill" style="--c:${statusColor}">${statusText}</span>` : nothing}
          ${live ? html`<span class="kg-pill kg-pill--live" style="--c:#3ddc97">live</span>` : nothing}
        </div>
        <div class="kg-hc-title">${n.label}</div>
        ${isProject
          ? html`
              ${tasks > 0
                ? html`<div class="kg-progress"><span style="width:${progress}%"></span></div>
                    <div class="kg-hc-row"><b>${progress}%</b> · ${Number(m.done ?? 0).toLocaleString()} / ${tasks.toLocaleString()} tasks</div>
                    <div class="kg-hc-counts">
                      <span>${Number(m.inProgress ?? 0)} doing</span><span>${Number(m.review ?? 0)} review</span>
                      <span class=${Number(m.blocked ?? 0) ? "hot" : ""}>${Number(m.blocked ?? 0)} blocked</span>
                      <span class=${Number(m.overdue ?? 0) ? "warn" : ""}>${Number(m.overdue ?? 0)} overdue</span>
                    </div>`
                : html`<div class="kg-hc-row">No tasks yet</div>`}
            `
          : nothing}
        <div class="kg-hc-meta">
          ${owners.length ? html`<span>${icons.bot} ${owners.slice(0, 2).join(", ")}</span>` : nothing}
          ${runs.length ? html`<span>${icons.activity} ${runs.length} run${runs.length > 1 ? "s" : ""}</span>` : nothing}
          <span>${icons.clock} ${relativeAge(last)}</span>
          <span>${icons.link} ${neighbours.length}</span>
        </div>
        ${top.length
          ? html`<div class="kg-hc-links">
              ${top.map((x) => html`<span><i style="background:${x.color}"></i>${truncate(x.label, 30)}</span>`)}
            </div>`
          : nothing}
        <div class="kg-hc-actions">
          <button class="kg-mini" title="Chat with this" @click=${() => void this.openAi("chat", [n.id])}>${icons.messageSquare}<span>Chat</span></button>
          <button class="kg-mini" title="Add to selection" @click=${() => this.toggleSelected(n.id)}>${icons.check}<span>${this.selection.has(n.id) ? "Unselect" : "Select"}</span></button>
          <button class="kg-mini" title="Focus" @click=${() => this.selectNode(n.id)}>${icons.target}<span>Focus</span></button>
          ${openTargetFor(n) || hasNativeHost() ? html`<button class="kg-mini" title="Open" @click=${() => this.openNode(n)}>${icons.externalLink}<span>Open</span></button>` : nothing}
          ${this.touchPeek
            ? html`<button class="kg-mini kg-mini--details" title="Details" data-ib-target="control:knowledge-graph/details" @click=${() => this.openDetails(n.id)}>${icons.fileText}<span>Details</span></button>`
            : nothing}
        </div>
      </div>
    `;
  }

  // ── Context menu ──────────────────────────────────────────
  private renderMenu() {
    const menu = this.menu!;
    const ids = this.actionIds(menu.nodeId);
    const nodes = this.nodesOf(ids);
    if (!nodes.length) return nothing;
    const one = nodes.length === 1 ? nodes[0] : null;
    const kinds = new Set(nodes.map((n) => n.kind));
    const mergeable = nodes.length > 1 && kinds.size === 1 && (kinds.has("note") || kinds.has("task"));
    const deletable = nodes.some((n) => n.kind === "task" || n.kind === "note");
    const movable = nodes.some((n) => canReassign(n.kind));
    const statusable = nodes.some((n) => n.kind === "task" || n.kind === "project");
    const host = this.querySelector<HTMLElement>(".kg-stage");
    const W = host?.clientWidth ?? 800;
    const H = host?.clientHeight ?? 600;
    const x = Math.min(menu.x, W - 248);
    // The menu caps at the stage height (scrolls inside), so clamp to fit.
    const y = Math.min(menu.y, H - Math.min(470, H - 16) - 8);
    const item = (icon: unknown, label: string, fn: () => void, opts: { danger?: boolean; hint?: string; ai?: boolean } = {}) =>
      html`<button role="menuitem" class="kg-mi ${opts.danger ? "kg-mi--danger" : ""} ${opts.ai ? "kg-mi--ai" : ""}" @click=${() => {
        // Ignore the synthetic click from the finger lifting after a long-press.
        if (performance.now() - this.menuOpenedAt < 450) return;
        this.menu = null;
        fn();
      }}>${icon}<span>${label}</span>${opts.hint ? html`<kbd>${opts.hint}</kbd>` : nothing}</button>`;
    return html`
      <div class="kg-menu" role="menu" style="transform:translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)">
        <div class="kg-menu-head">${one ? truncate(one.label, 30) : `${nodes.length} selected`}</div>
        <div class="kg-menu-sec">AI</div>
        ${item(icons.messageSquare, "Chat with this", () => void this.openAi("chat", ids), { ai: true })}
        ${item(icons.fileText, "Summarize", () => void this.openAi("summarize", ids), { ai: true })}
        ${item(icons.network, "Find related & suggest links", () => this.openRelated(ids), { ai: true })}
        ${item(icons.layers, mergeable ? "Consolidate…" : "Consolidation plan (AI)", () => void this.openConsolidate(ids), { ai: true })}
        ${item(icons.magicWand, "Auto-group (cluster)", () => {
          this.setGroupMode("cluster");
          if (nodes.length > 1) void this.openAi("cluster", ids);
        }, { ai: true })}
        ${item(icons.bot, "Spawn agent on this…", () => this.openSpawn(ids), { ai: true })}
        <div class="kg-menu-sec">Graph</div>
        ${one && one.kind === "project"
          ? item(icons.layers, "Consolidate sub-projects…", () => this.openSubConsolidate(one.id))
          : nothing}
        ${item(icons.link, "Link to…", () => this.openPicker("link", ids), { hint: "Ctrl+drag" })}
        ${movable ? item(icons.folder, "Move to project…", () => this.openPicker("move", ids), { hint: "drag" }) : nothing}
        ${statusable
          ? html`<div class="kg-mi-row">${icons.checkCircle}<span>Status</span>
              ${BULK_STATUSES.map((st) => html`<button class="kg-mi-chip" @click=${() => void this.bulkStatus(ids, st.id)}>${st.label}</button>`)}
            </div>`
          : nothing}
        ${item(icons.tag, "Tag…", () => (this.dialog = { type: "tag", ids, value: "" }))}
        ${item(icons.users, "Select neighbours", () => this.selectNeighbours(ids))}
        ${one ? item(icons.target, "Focus", () => this.selectNode(one.id)) : item(icons.target, "Frame selection", () => this.fitTo(ids, 1.4))}
        ${one && openTargetFor(one) ? item(icons.externalLink, "Open", () => this.openNode(one)) : nothing}
        ${deletable ? item(icons.trash, "Delete…", () => this.openDelete(ids), { danger: true, hint: "Del" }) : nothing}
      </div>
    `;
  }

  // ── Bulk command bar ──────────────────────────────────────
  private renderBulkBar() {
    const ids = [...this.selection];
    const nodes = this.nodesOf(ids);
    const byKind = new Map<GraphNodeKind, number>();
    for (const n of nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
    const kinds = new Set(byKind.keys());
    const mergeable = kinds.size === 1 && (kinds.has("note") || kinds.has("task"));
    return html`
      <div class="kg-bulk" role="toolbar" aria-label="Selection actions" data-ib-target="control:knowledge-graph/bulk-bar">
        <div class="kg-bulk-count">
          <span><b>${nodes.length}</b><span class="kg-bulk-lbl"> selected</span></span>
          <span class="kg-bulk-kinds">
            ${[...byKind].slice(0, 4).map(([k, c]) => html`<span><i style="background:${KIND_PALETTE[k]}"></i>${c}</span>`)}
          </span>
        </div>
        <div class="kg-bulk-actions">
          <button class="kg-bb kg-bb--ai" title="Chat with the selection" @click=${() => void this.openAi("chat", ids)}>${icons.messageSquare}<span>Chat</span></button>
          <button class="kg-bb kg-bb--ai" title="Summarize the selection" @click=${() => void this.openAi("summarize", ids)}>${icons.fileText}<span>Summarize</span></button>
          <button class="kg-bb kg-bb--ai" title=${mergeable ? "Merge into one" : "Ask the assistant how to merge"} @click=${() => void this.openConsolidate(ids)}>${icons.layers}<span>Consolidate</span></button>
          <button class="kg-bb kg-bb--ai" title="Find related & suggest links" @click=${() => this.openRelated(ids)}>${icons.network}<span>Related</span></button>
          <button class="kg-bb kg-bb--ai" title="Spawn an agent on the selection" @click=${() => this.openSpawn(ids)}>${icons.bot}<span>Agent</span></button>
          <span class="kg-bb-sep"></span>
          <button class="kg-bb" title="Link all to…" @click=${() => this.openPicker("link", ids)}>${icons.link}<span>Link</span></button>
          <button class="kg-bb" title="Move to project…" @click=${() => this.openPicker("move", ids)}>${icons.folder}<span>Move</span></button>
          <span class="kg-status-pop">
            <button class="kg-bb ${this.statusMenu ? "on" : ""}" title="Set status" @click=${() => (this.statusMenu = !this.statusMenu)}>${icons.checkCircle}<span>Status</span></button>
          </span>
          <button class="kg-bb" title="Tag…" @click=${() => (this.dialog = { type: "tag", ids, value: "" })}>${icons.tag}<span>Tag</span></button>
          <button class="kg-bb" title="Add neighbours to the selection" @click=${() => this.selectNeighbours(ids)}>${icons.users}<span>Expand</span></button>
          <button class="kg-bb kg-bb--danger" title="Delete…" @click=${() => this.openDelete(ids)}>${icons.trash}<span>Delete</span></button>
          <button class="kg-bb" title="Clear selection (Esc)" @click=${() => this.clearSelection()}>${icons.x}</button>
        </div>
        ${this.statusMenu
          ? html`<div class="kg-pop kg-pop--bar kg-status-pop" role="menu">
              ${BULK_STATUSES.map((st) => html`<button role="menuitem" @click=${() => void this.bulkStatus(ids, st.id)}>${st.label}</button>`)}
            </div>`
          : nothing}
      </div>
    `;
  }

  // ── Settings popover ──────────────────────────────────────
  private renderSettings() {
    const seg = <T extends string>(value: T, opts: Array<[T, string]>, set: (v: T) => void) =>
      html`<div class="kg-seg2">${opts.map(([v, l]) => html`<button class=${v === value ? "on" : ""} @click=${() => set(v)}>${l}</button>`)}</div>`;
    return html`
      <div class="kg-settings kg-panel" role="dialog" aria-label="Display settings">
        <div class="kg-panel-title">Display</div>
        <label>Group by</label>
        ${seg(this.groupMode, GROUP_MODES.map((g) => [g.id, g.label] as [GroupMode, string]), (v) => this.setGroupMode(v))}
        <label>Motion</label>
        ${seg(this.motionPref, [["system", "System"], ["reduced", "Reduced"], ["full", "Full"]], (v) => this.setMotionPref(v))}
        <label>Quality</label>
        ${seg(this.qualityPref, [["auto", "Auto"], ["high", "High"], ["low", "Battery"]], (v) => this.setQualityPref(v))}
        <label>Ambience</label>
        ${seg(this.ambienceOn ? "on" : "off", [["on", "Nebula + grid"], ["off", "Off"]], (v) => this.setAmbience(v === "on"))}
        <div class="kg-settings-foot">
          <button class="kg-btn" @click=${() => this.resetLayout()}>${icons.refresh} Reset layout</button>
          <span class="kg-muted">Layout is saved on this device.</span>
        </div>
        <div class="kg-keys">
          <span><kbd>Ctrl</kbd>+drag link</span><span><kbd>Shift</kbd>+drag lasso</span>
          <span><kbd>Shift</kbd>+click multi</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</span>
          <span>Right-click actions</span><span>Drag onto project = move</span>
        </div>
      </div>
    `;
  }

  // ── Dialogs ───────────────────────────────────────────────
  private renderDialog(d: Dialog) {
    const close = () => (this.dialog = null);
    const wrap = (title: string, body: unknown, foot: unknown, wide = false) => html`
      <div class="kg-modal" @pointerdown=${(e: Event) => e.target === e.currentTarget && close()}>
        <div class="kg-dialog ${wide ? "kg-dialog--wide" : ""}" role="dialog" aria-modal="true" aria-label=${title}>
          <div class="kg-dialog-head"><span class="kg-panel-title">${title}</span><button class="kg-detail-x" @click=${close}>${icons.x}</button></div>
          <div class="kg-dialog-body">${body}</div>
          <div class="kg-dialog-foot">${foot}</div>
        </div>
      </div>
    `;
    switch (d.type) {
      case "subs":
        return this.renderSubsDialog(d, wrap);
      case "delete":
        return wrap(
          `Delete ${d.plan.ops.length} item${d.plan.ops.length > 1 ? "s" : ""}?`,
          html`<p class="kg-warn">This removes them from their stores and can't be undone from the graph.</p>
            <ul class="kg-list">${d.plan.ops.slice(0, 12).map((o) => html`<li>${o.label}</li>`)}${d.plan.ops.length > 12 ? html`<li>+${d.plan.ops.length - 12} more</li>` : nothing}</ul>
            ${d.plan.skipped.length ? html`<p class="kg-muted">${d.plan.skipped.length} skipped · ${d.plan.skipped[0].reason}</p>` : nothing}`,
          html`<button class="kg-btn" @click=${close}>Cancel</button>
            <button class="kg-btn kg-btn--danger" @click=${() => void this.confirmDelete(d.plan)}>${icons.trash} Delete ${d.plan.ops.length}</button>`,
        );
      case "tag":
        return wrap(
          `Tag ${d.ids.length} item${d.ids.length > 1 ? "s" : ""}`,
          html`<input class="kg-input" autofocus placeholder="e.g. launch" .value=${d.value}
            @input=${(e: Event) => (this.dialog = { ...d, value: (e.target as HTMLInputElement).value })}
            @keydown=${(e: KeyboardEvent) => e.key === "Enter" && void this.bulkTag(d.ids, d.value)} />
            <p class="kg-muted">Tags notes and tasks; existing tags are kept.</p>`,
          html`<button class="kg-btn" @click=${close}>Cancel</button>
            <button class="kg-btn kg-btn--primary" ?disabled=${!d.value.trim()} @click=${() => void this.bulkTag(d.ids, d.value)}>${icons.tag} Add tag</button>`,
        );
      case "pick": {
        const q = d.query.trim().toLowerCase();
        const selected = new Set(d.ids);
        const pool = this.nodes.filter(
          (n) => !selected.has(n.id) && (d.purpose === "move" ? n.kind === "project" : n.kind !== "run" && n.kind !== "session" && n.kind !== "row"),
        );
        const list = (q ? pool.filter((n) => n.label.toLowerCase().includes(q)) : pool)
          .sort((a, b) => Number(b.anchor) - Number(a.anchor) || a.label.localeCompare(b.label))
          .slice(0, 60);
        return wrap(
          d.purpose === "move" ? `Move ${d.ids.length} to project` : `Link ${d.ids.length} to…`,
          html`<input class="kg-input" autofocus placeholder=${d.purpose === "move" ? "Find a project…" : "Find a node…"} .value=${d.query}
              @input=${(e: Event) => (this.dialog = { ...d, query: (e.target as HTMLInputElement).value })} />
            <div class="kg-pick">
              ${list.length
                ? list.map(
                    (n) => html`<button class="kg-pick-item" @click=${() => void this.pickTarget(d.purpose, d.ids, n.id)}>
                      <i style="background:${n.color}"></i><span>${n.label}</span><em>${KIND_SINGULAR[n.kind]}</em>
                    </button>`,
                  )
                : html`<div class="kg-muted">No matches.</div>`}
            </div>`,
          html`<button class="kg-btn" @click=${close}>Cancel</button>`,
        );
      }
      case "related":
        return wrap(
          "Related & suggested links",
          html`${d.items.length
              ? html`<div class="kg-pick">
                  ${d.items.map((s) => {
                    const a = this.nodeById.get(s.a);
                    const b = this.nodeById.get(s.b);
                    if (!a || !b) return nothing;
                    return html`<div class="kg-sugg">
                      <div><b>${a.label}</b> ↔ <b>${b.label}</b><span class="kg-muted">${s.reason}</span></div>
                      <button class="kg-btn" @click=${async () => {
                        await this.linkTo([a.id], b);
                        if (this.dialog?.type === "related") this.dialog = { ...this.dialog, items: this.dialog.items.filter((x) => x !== s) };
                      }}>${icons.link} Link</button>
                    </div>`;
                  })}
                </div>`
              : html`<p class="kg-muted">No strong matches from titles and shared connections. The assistant can search your workspace for more.</p>`}`,
          html`<button class="kg-btn" @click=${close}>Close</button>
            <button class="kg-btn kg-btn--primary" @click=${() => {
              close();
              void this.openAi("related", d.ids);
            }}>${icons.sparkles} Ask the assistant</button>`,
          true,
        );
      case "spawn": {
        const agents = this.nodes.filter((n) => n.kind === "agent");
        return wrap(
          `Spawn an agent on ${d.ids.length === 1 ? (this.nodeById.get(d.ids[0])?.label ?? "this") : `${d.ids.length} items`}`,
          html`<label class="kg-lbl">Goal</label>
            <textarea class="kg-input" rows="4" placeholder="Review these items, move them forward, and report back what you changed."
              .value=${d.goal} @input=${(e: Event) => (this.dialog = { ...d, goal: (e.target as HTMLTextAreaElement).value })}></textarea>
            <label class="kg-lbl">Agent</label>
            <select class="kg-input" .value=${d.agentId} @change=${(e: Event) => (this.dialog = { ...d, agentId: (e.target as HTMLSelectElement).value })}>
              <option value="">Default (coder)</option>
              ${agents.map((a) => html`<option value=${String(a.meta?.agentId ?? storeIdOf(a))}>${a.label}</option>`)}
            </select>
            <p class="kg-muted">Runs a real sub-agent with the selection as context. It shows up on the Agents page and in the activity feed.</p>`,
          html`<button class="kg-btn" @click=${close}>Cancel</button>
            <button class="kg-btn kg-btn--primary" ?disabled=${d.busy} @click=${() => void this.confirmSpawn(d)}>${icons.rocket} ${d.busy ? "Starting…" : "Spawn agent"}</button>`,
        );
      }
      case "consolidate": {
        const nodes = this.nodesOf(d.ids);
        const p = d.plan;
        return wrap(
          `Consolidate ${nodes.length} ${KIND_LABEL[nodes[0]?.kind ?? "note"]?.toLowerCase() ?? "items"}`,
          d.loading
            ? html`<div class="kg-muted">Reading the items…</div>`
            : d.error && !p
              ? html`<p class="kg-warn">${d.error}</p>`
              : html`
                  <label class="kg-lbl">Keep</label>
                  <div class="kg-radio">
                    ${nodes.map(
                      (n) => html`<label><input type="radio" name="kg-primary" .checked=${n.id === d.primaryId}
                        @change=${() => this.replanConsolidate(d, { primaryId: n.id })} />
                        <span>${n.label}</span><em>${this.adjacency.get(n.id)?.size ?? 0} link${(this.adjacency.get(n.id)?.size ?? 0) === 1 ? "" : "s"}</em></label>`,
                    )}
                  </div>
                  <label class="kg-lbl">Title</label>
                  <input class="kg-input" .value=${d.title} @input=${(e: Event) => (this.dialog = { ...d, title: (e.target as HTMLInputElement).value })} />
                  <label class="kg-lbl">Merged content <span class="kg-muted">(editable · duplicate paragraphs removed)</span></label>
                  <textarea class="kg-input kg-mono" rows="9" .value=${d.body}
                    @input=${(e: Event) => (this.dialog = { ...d, body: (e.target as HTMLTextAreaElement).value })}></textarea>
                  <div class="kg-merge-sum">
                    <span>${icons.link} ${p?.relinks.length ?? 0} relation${(p?.relinks.length ?? 0) === 1 ? "" : "s"} carried over</span>
                    <span>${icons.copy} ${p?.mergedIds.length ?? 0} duplicate${(p?.mergedIds.length ?? 0) === 1 ? "" : "s"}</span>
                    <span>${p?.calls.length ?? 0} gateway writes</span>
                  </div>
                  <label class="kg-lbl">Duplicates</label>
                  <div class="kg-seg2">
                    <button class=${d.removeMode === "delete" ? "on" : ""} @click=${() => this.replanConsolidate(d, { removeMode: "delete", keepText: true })}>Delete</button>
                    <button class=${d.removeMode === "archive" ? "on" : ""} @click=${() => this.replanConsolidate(d, { removeMode: "archive", keepText: true })}>
                      ${nodes[0]?.kind === "task" ? "Mark done" : "Keep, tag merged"}
                    </button>
                  </div>
                  ${d.removeMode === "delete" ? html`<p class="kg-warn">Deleting duplicates can't be undone.</p>` : nothing}
                `,
          html`<button class="kg-btn" @click=${() => {
              close();
              void this.openAi("consolidate", d.ids);
            }}>${icons.sparkles} Ask AI for a plan</button>
            <span style="flex:1"></span>
            <button class="kg-btn" @click=${close}>Cancel</button>
            <button class="kg-btn kg-btn--primary" ?disabled=${!p || d.loading} @click=${() => void this.confirmConsolidate(d)}>
              ${icons.layers} Merge ${nodes.length} into 1
            </button>`,
          true,
        );
      }
    }
  }

  // ── Project scope ───────────────────────────────────────────────────

  /** Scope the graph to one project (project page button / `?project=` link). */
  private enterProjectScope(sc: ProjectScope, reload = true): void {
    const same = this.projectScope?.id === sc.id;
    if (!this.projectScope) {
      this.scopeSaved = { kinds: this.enabledKinds, group: this.groupMode };
      // A project view is small: show its tasks, runs and files by default, and
      // lay it out as clusters (brain lobes squeeze a handful of nodes into one
      // region). Neither is saved to prefs; "Show all" restores both.
      this.enabledKinds = new Set([...this.enabledKinds, "task", "run", "file", "report", "note"] as GraphNodeKind[]);
      if (this.groupMode === "brain" || this.groupMode === "orbit") {
        this.groupMode = "cluster";
        this.groupChanged = true;
      }
    }
    this.projectScope = { ...sc, name: sc.name ?? (same ? this.projectScope?.name ?? null : null) };
    if (!same) {
      this.scopeInfo = null;
      this.scopeFocused = null;
      this.selection = new Set();
      this.selectedId = null;
      this.expanded = new Map();
      this.prevSnapshotNodes = null;
      this.snapshot = null;
      if (this.repoMode) this.repoSel = sc.id;
    }
    void loadProjectRepos().then(() => this.requestUpdate()).catch(() => undefined);
    if (reload) void this.refresh(true);
  }

  /** "Show all": back to the full graph with the user's own layers. */
  private exitProjectScope(updateUrl = true): void {
    if (!this.projectScope) return;
    this.projectScope = null;
    this.scopeInfo = null;
    this.scopeFocused = null;
    if (this.scopeSaved) {
      this.enabledKinds = this.scopeSaved.kinds;
      if (this.groupMode !== this.scopeSaved.group) {
        this.groupMode = this.scopeSaved.group;
        this.groupChanged = true;
      }
    }
    this.scopeSaved = null;
    this.selection = new Set();
    this.selectedId = null;
    this.snapshot = null;
    if (this.repoMode) this.repoSel = "all";
    if (updateUrl) replaceScopeInUrl(null);
    void this.refresh(true);
  }

  private setScopeHops(hops: number): void {
    if (!this.projectScope || this.projectScope.hops === hops) return;
    this.projectScope = { ...this.projectScope, hops };
    replaceScopeInUrl(this.projectScope);
    void this.refresh(true);
  }

  /** Browser back/forward or an agent's ui_control navigation re-scopes the view. */
  private onScopePopState = (): void => {
    if (!this.isConnected || typeof location === "undefined") return;
    if (!/knowledge/.test(location.pathname)) return;
    const sc = readProjectScope(location.search);
    if (sc) {
      if (sc.id !== this.projectScope?.id || sc.hops !== this.projectScope?.hops) this.enterProjectScope(sc);
    } else if (this.projectScope) this.exitProjectScope(false);
  };

  /** Centre + highlight the project once per scope (after the layout settles). */
  private queueScopeFocus(): void {
    const root = this.scopeInfo?.projectNodeId;
    if (!this.projectScope || !root || this.scopeFocused === root || this.repoMode) return;
    this.scopeFocused = root;
    if (this.scopeInfo?.label && !this.projectScope.name) this.projectScope = { ...this.projectScope, name: this.scopeInfo.label };
    this.scopeQuietFocus = this.isMobile();
    this.pendingDeepFocus = { id: root, family: false };
  }

  private scopeName(): string {
    return this.projectScope?.name || this.scopeInfo?.label || this.projectScope?.id || "project";
  }

  private renderScopeBar() {
    const sc = this.projectScope!;
    const info = this.scopeInfo;
    const hasRepo = listProjectRepos().some((r) => r.projectId === sc.id);
    const shown = this.nodes.length;
    return html`
      <div class="kg-scope" data-kg-scope data-ib-target="control:knowledge-graph/project-scope">
        <span class="kg-scope-chip" title="Only nodes related or connected to this project">
          ${icons.folder}<span class="kg-scope-k">Project</span><span class="kg-scope-name">${this.scopeName()}</span>
        </span>
        ${this.repoMode
          ? nothing
          : html`<span class="kg-scope-count" data-kg-scope-count title=${info ? `${info.totalNodes} nodes in the full graph · ${info.hubs.length} shared hub(s) shown but not expanded` : ""}>${scopeCountText(info, shown)}</span>`}
        <div class="kg-scope-hops" role="group" aria-label="Hop depth" title="How many links away from the project to include">
          <span class="kg-scope-k">Depth</span>
          ${SCOPE_HOP_CHOICES.map(
            (h) => html`<button
              class="kg-conn-b ${sc.hops === h ? "on" : ""}"
              aria-pressed=${sc.hops === h}
              data-kg-scope-hops=${h}
              ?disabled=${this.repoMode}
              @click=${() => this.setScopeHops(h)}
            >${h}</button>`,
          )}
        </div>
        ${hasRepo && this.lane !== "secure"
          ? html`<button
              class="kg-btn ${this.repoMode ? "kg-btn--on" : ""}"
              data-kg-scope-repo
              aria-pressed=${this.repoMode}
              title=${this.repoMode ? "Back to the project's knowledge graph" : "This project's repo as a 3D file graph"}
              @click=${() => this.setRepoMode(!this.repoMode)}
            >${icons.fileCode}<span>Repo 3D</span></button>`
          : nothing}
        <span class="kg-scope-sp"></span>
        <button class="kg-btn" data-kg-scope-clear data-ib-target="control:knowledge-graph/show-all" title="Clear the project filter and show the whole graph" @click=${() => this.exitProjectScope()}>
          ${icons.network}<span>Show all</span>
        </button>
      </div>
    `;
  }

  private renderScopeEmpty() {
    const info = this.scopeInfo;
    const missing = info && !info.found;
    return html`<div class="kg-scope-empty" data-kg-scope-empty>
      <div class="kg-scope-empty-ic">${icons.network}</div>
      <div class="kg-scope-empty-t">${missing ? "Project not found in the graph" : `Not much is connected to ${this.scopeName()} yet`}</div>
      <div class="kg-scope-empty-d">
        ${missing
          ? "It may be archived, in another workspace, or only in the secure lane."
          : "Link tasks, notes, files, reports or clients to this project and they show up here."}
        ${!missing && (this.projectScope?.hops ?? DEFAULT_SCOPE_HOPS) < 4 ? html` Or look further out:` : nothing}
      </div>
      <div class="kg-scope-empty-a">
        ${!missing && (this.projectScope?.hops ?? DEFAULT_SCOPE_HOPS) < 4
          ? html`<button class="kg-btn" @click=${() => this.setScopeHops(Math.min(4, (this.projectScope?.hops ?? DEFAULT_SCOPE_HOPS) + 1))}>Depth ${(this.projectScope?.hops ?? DEFAULT_SCOPE_HOPS) + 1}</button>`
          : nothing}
        <button class="kg-btn" @click=${() => this.exitProjectScope()}>Show all</button>
      </div>
    </div>`;
  }

  // ── Repos mode ──────────────────────────────────────────────────────

  /** Toggle Repos mode; swaps in repo layers without persisting them. */
  private setRepoMode(on: boolean, reload = true): void {
    if (on === this.repoMode) return;
    if (on && this.lane === "secure") return;
    this.refreshSeq++;
    this.selection = new Set();
    this.selectedId = null;
    this.expanded = new Map();
    this.localEdges = [];
    this.prevSnapshotNodes = null;
    if (on) {
      this.repoSaved = { kinds: this.enabledKinds, health: this.enabledHealth, group: this.groupMode };
      this.enabledKinds = new Set(REPO_KINDS);
      this.enabledHealth = new Set(ALL_HEALTH);
      // Clusters group each directory with its files; brain lobes / health
      // orbits label regions with KG-only meanings, so start from clusters.
      this.groupMode = "cluster";
      this.snapshot = null;
      if (this.projectScope) this.repoSel = this.projectScope.id;
      this.repoMode = true;
      this.subscribeRepoEvents();
    } else {
      this.repoMode = false;
      if (this.repoSaved) {
        this.enabledKinds = this.repoSaved.kinds;
        this.enabledHealth = this.repoSaved.health;
        this.groupMode = this.repoSaved.group;
      }
      this.repoSaved = null;
      this.repoUnsub?.();
      this.repoUnsub = null;
      this.snapshot = null;
    }
    if (reload) void this.refresh(true);
  }

  private subscribeRepoEvents(): void {
    if (this.repoUnsub || !this.client) return;
    this.repoUnsub = this.client.subscribe((evt) => {
      if (evt.event !== "projects.repo.changed" || !this.repoMode) return;
      if (this.repoEventTimer) clearTimeout(this.repoEventTimer);
      this.repoEventTimer = setTimeout(() => void this.refresh(), 800);
    });
  }

  private async refreshRepos(force = false): Promise<void> {
    if (!this.client) return;
    const seq = ++this.refreshSeq;
    this.loading = true;
    this.error = null;
    try {
      await loadProjectRepos({ force });
      const all = listProjectRepos();
      this.repoProjects = all;
      if (this.repoSel !== "all" && !all.some((r) => r.projectId === this.repoSel)) this.repoSel = "all";
      const picked = this.repoSel === "all" ? all : all.filter((r) => r.projectId === this.repoSel);
      const budget = repoNodeBudget(picked.length);
      const results = await Promise.all(
        picked.map(async (r) => {
          try {
            const graph = await this.client!.request<RepoGraphPayload>("projects.repo.graph", {
              projectId: r.projectId,
              maxNodes: budget,
              expand: [...(this.repoExpand.get(r.projectId) ?? [])],
              ...(force ? { fresh: true } : {}),
            });
            return { projectId: r.projectId, projectName: r.projectName, graph };
          } catch (err) {
            console.warn(`[knowledge-graph] repo scan failed for ${r.projectName}`, err);
            return null;
          }
        }),
      );
      if (seq !== this.refreshSeq || !this.repoMode) return;
      const ok = results.filter((x): x is NonNullable<typeof x> => x !== null);
      this.snapshot = repoGraphsToSnapshot(ok);
      void this.loadRepoAttachable();
      if (!all.length) this.error = "No project has a repo attached yet — attach one from a project card or the Kanban header.";
    } catch (err) {
      if (seq !== this.refreshSeq) return;
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === this.refreshSeq) this.loading = false;
    }
  }

  /** Lazy expansion: ask the gateway for the next level under a collapsed dir. */
  private expandRepoDir(m: RepoNodeMeta): void {
    const set = new Set(this.repoExpand.get(m.projectId) ?? []);
    set.add(m.path);
    this.repoExpand.set(m.projectId, set);
    void this.refresh();
  }

  private collapseRepoDir(m: RepoNodeMeta): void {
    const set = new Set(this.repoExpand.get(m.projectId) ?? []);
    for (const p of [...set]) if (p === m.path || p.startsWith(`${m.path}/`)) set.delete(p);
    this.repoExpand.set(m.projectId, set);
    void this.refresh();
  }

  /** Double-click / open in Repos mode. Returns true when handled. */
  private openRepoNode(n: SimNode): boolean {
    if (!this.repoMode) return false;
    const m = repoMetaOf(n.meta);
    if (!m) return false;
    if (m.repoNode === "file") {
      const el = document.createElement("ib-repo-file-view");
      el.root = m.root;
      el.projectId = m.projectId;
      el.path = m.path;
      el.full = true;
      el.setAttribute("full", "");
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") close();
      };
      const close = () => {
        el.remove();
        window.removeEventListener("keydown", onKey);
      };
      el.addEventListener("repo-file-close", close);
      window.addEventListener("keydown", onKey);
      document.body.appendChild(el);
      return true;
    }
    if ((m.repoNode === "dir" || m.repoNode === "more") && m.expandable) {
      this.expandRepoDir(m);
      return true;
    }
    return m.repoNode !== "project" ? true : false;
  }

  private renderRepoToolbar() {
    return html`<button
        class="kg-btn ${this.repoMode ? "kg-btn--on" : ""}"
        title=${this.repoMode ? "Back to the knowledge graph" : "Repos — project repos as a 3D file graph"}
        aria-pressed=${this.repoMode}
        data-ib-target="control:knowledge-graph/repos"
        data-kg-repos-toggle
        @click=${() => this.setRepoMode(!this.repoMode)}
      >
        ${icons.fileCode}<span class="kg-hide-sm">Repos</span>
      </button>
      ${this.repoMode
        ? html`<label class="kg-group-pick" title="Which repo">
            <select
              data-kg-repo-select
              .value=${this.repoSel}
              @change=${(e: Event) => {
                this.repoSel = (e.target as HTMLSelectElement).value;
                void this.refresh();
              }}
            >
              <option value="all" ?selected=${this.repoSel === "all"}>All repos (${this.repoProjects.length})</option>
              ${this.repoProjects.map(
                (r) => html`<option value=${r.projectId} ?selected=${r.projectId === this.repoSel}>${r.projectName} · ${r.name}</option>`,
              )}
            </select>
          </label>`
        : nothing}`;
  }

  private renderRepoLegend() {
    const langs = repoLanguages(this.snapshot).slice(0, 10);
    const repos = (this.snapshot?.nodes ?? []).filter((n) => repoMetaOf(n.meta)?.repoNode === "repo");
    const files = repos.reduce((a, n) => a + Number(n.meta?.fileCount ?? 0), 0);
    return html`
      <div class="kg-legend" data-kg-repo-legend>
        <span class="kg-legend-label">Repos</span>
        <span class="kg-chip on" title="Repos shown">${repos.length}<span class="kg-chip-count">${files.toLocaleString()} files</span></span>
        <label class="kg-group-pick" title="Attach a local repo to a project">
          <select
            data-kg-repo-attach
            @focus=${() => void this.loadRepoAttachable()}
            @change=${(e: Event) => {
              const sel = e.target as HTMLSelectElement;
              const id = sel.value;
              sel.value = "";
              if (id) void this.attachRepoFromGraph(id);
            }}
          >
            <option value="">+ Attach repo to…</option>
            ${this.repoAttachable.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
          </select>
        </label>
        <span class="kg-legend-sep" aria-hidden="true"></span>
        <span class="kg-legend-label">Languages</span>
        ${langs.map(
          (l) => html`<span class="kg-chip on" title="${l.count} files">
            <span class="kg-chip-dot" style="background:${LANG_COLORS[l.lang] ?? LANG_COLORS.other}"></span>
            ${LANG_LABELS[l.lang] ?? l.lang}<span class="kg-chip-count">${l.count}</span>
          </span>`,
        )}
        <span class="kg-legend-sep" aria-hidden="true"></span>
        <span class="kg-legend-note" title="Files tint orange and grow with commits in the last 90 days">
          <span class="kg-size-dots" aria-hidden="true"><i></i><i></i><i></i></span>size + heat = recent commits
        </span>
        <span class="kg-legend-note" title="Double-click a folder to expand it, a file to open it">double-click: expand / open</span>
      </div>
    `;
  }

  /** Projects without a repo, for the legend's "Attach repo to…" select. */
  @state() private repoAttachable: Array<{ id: string; name: string }> = [];

  private async loadRepoAttachable(): Promise<void> {
    if (!this.client) return;
    try {
      const res = await this.client.request<unknown>("kanban.projects.list", {});
      const list = (Array.isArray(res) ? res : ((res as { projects?: unknown[] })?.projects ?? [])) as Array<{ id?: string; name?: string }>;
      const bound = new Set(this.repoProjects.map((r) => r.projectId));
      this.repoAttachable = list
        .filter((p): p is { id: string; name: string } => Boolean(p?.id && p?.name) && !bound.has(p.id as string))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      /* the select just stays empty */
    }
  }

  private async attachRepoFromGraph(projectId: string): Promise<void> {
    const project = this.repoAttachable.find((p) => p.id === projectId);
    if (!project) return;
    const done = await openRepoPicker({ mode: "attach", projectId: project.id, projectName: project.name });
    if (done) void this.refresh(true);
  }

  private renderRepoDetail(sel: SimNode, m: RepoNodeMeta) {
    const meta = sel.meta ?? {};
    const kindLabel = { project: "Project", repo: "Repository", dir: "Folder", file: "File", more: "More files" }[m.repoNode];
    const lc = meta.lastCommit as { subject?: string; at?: number } | undefined;
    const isExpandedDir = m.repoNode === "dir" && !m.expandable && m.path !== "";
    return html`
      <aside class="kg-panel kg-detail kg-detail--repo" aria-label="Details" data-kg-repo-detail=${m.repoNode}>
        <div class="kg-detail-head">
          <span class="kg-detail-dot" style="background:${sel.color}"></span>
          <span class="kg-detail-kind">${kindLabel}</span>
          <button class="kg-detail-x" title="Close" @click=${() => this.clearSelection()}>${icons.x}</button>
        </div>
        <div class="kg-detail-label">${sel.label}</div>
        <div class="kg-pills">
          ${m.lang ? html`<span class="kg-pill" style="--c:${LANG_COLORS[m.lang] ?? LANG_COLORS.other}">${LANG_LABELS[m.lang] ?? m.lang}</span>` : nothing}
          ${m.commits ? html`<span class="kg-pill" style="--c:#ff7830">${m.commits} commits · 90d</span>` : nothing}
          ${m.fileCount ? html`<span class="kg-pill" style="--c:#9b8cff">${m.fileCount} files</span>` : nothing}
          ${m.repoNode === "repo" && meta.branch ? html`<span class="kg-pill" style="--c:#d4af37">${String(meta.branch)}</span>` : nothing}
          ${m.repoNode === "repo"
            ? html`<span class="kg-pill" style="--c:${meta.dirty ? "#f5b041" : "#5ad19a"}">${meta.dirty ? `${meta.dirtyCount} changed` : "clean"}</span>`
            : nothing}
        </div>
        ${m.repoNode === "repo" && lc?.subject
          ? html`<div class="kg-detail-sub">Last commit: ${lc.subject} · ${relTime(lc.at)}</div>`
          : nothing}
        <div class="kg-detail-sub" style="font-family:var(--font-mono,monospace);word-break:break-all;opacity:.75">${m.root}${m.path ? `/${m.path}` : ""}</div>
        ${m.repoNode === "file"
          ? html`<ib-repo-file-view .root=${m.root} .projectId=${m.projectId} .path=${m.path}></ib-repo-file-view>`
          : nothing}
        <div class="kg-detail-actions" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          ${(m.repoNode === "dir" || m.repoNode === "more") && m.expandable
            ? html`<button class="kg-btn" data-kg-repo-expand @click=${() => this.expandRepoDir(m)}>Expand folder</button>`
            : nothing}
          ${isExpandedDir && this.repoExpand.get(m.projectId)?.has(m.path)
            ? html`<button class="kg-btn" @click=${() => this.collapseRepoDir(m)}>Collapse</button>`
            : nothing}
          ${m.repoNode === "repo" || m.repoNode === "project"
            ? html`<button class="kg-btn" @click=${() => {
                this.repoSel = m.projectId;
                void this.refresh();
              }}>Focus this repo</button>
              <button class="kg-btn" @click=${() => void openRepoPicker({ mode: "attach", projectId: m.projectId, projectName: String(this.repoProjects.find((r) => r.projectId === m.projectId)?.projectName ?? "") })}>Change repo…</button>`
            : nothing}
        </div>
      </aside>
    `;
  }

  private renderLegend() {
    if (this.repoMode) return this.renderRepoLegend();
    const stats = this.snapshot?.typeStats ?? {};
    const hidden = this.snapshot?.hidden ?? {};
    const healthCounts = new Map<ProjectHealth, number>();
    let taskTotal = 0;
    for (const n of this.snapshot?.nodes ?? []) {
      if (n.kind !== "project") continue;
      const hh = healthOf(n.meta);
      healthCounts.set(hh, (healthCounts.get(hh) ?? 0) + 1);
      taskTotal += Number(n.meta?.tasks ?? 0);
    }
    const kinds = KIND_ORDER.filter((k) => (stats[k] ?? 0) > 0 || HEAVY_KINDS.has(k));
    return html`
      <div class="kg-legend">
        <span class="kg-legend-label">Status</span>
        ${HEALTH_ORDER.map((hh) => {
          const on = this.enabledHealth.has(hh);
          return html`
            <button
              class="kg-chip kg-chip--status ${on ? "on" : "off"}"
              title="${HEALTH_LABEL[hh]} projects · click to toggle"
              @click=${() => this.toggleHealth(hh)}
            >
              <span class="kg-chip-ring" style="--c:${HEALTH_COLOR[hh]}"></span>
              ${HEALTH_LABEL[hh]}<span class="kg-chip-count">${healthCounts.get(hh) ?? 0}</span>
            </button>
          `;
        })}
        <span class="kg-legend-sep" aria-hidden="true"></span>
        <span class="kg-legend-label">Layers</span>
        ${kinds.map((k) => {
          const on = this.enabledKinds.has(k);
          let count: string | number = stats[k] ?? 0;
          if (k === "task" && !on) count = taskTotal ? taskTotal.toLocaleString() : "—";
          const extra = hidden[k] ? ` · ${hidden[k]} more not shown (dormant/unlinked)` : "";
          const heavy = k === "task" ? " · heavy layer — expand one project from its card instead" : "";
          return html`
            <button
              class="kg-chip ${on ? "on" : "off"}"
              title="${KIND_LABEL[k]}${extra}${heavy} · click to toggle"
              @click=${() => this.toggleKind(k)}
            >
              <span
                class="kg-chip-dot ${k === "client" ? "kg-chip-dot--hex" : ""}"
                style="background:${KIND_PALETTE[k]}"
              ></span>
              ${KIND_LABEL[k]}<span class="kg-chip-count">${count}</span>
            </button>
          `;
        })}
        <span class="kg-legend-sep" aria-hidden="true"></span>
        <span class="kg-legend-note" title="Node size grows with the number of connections; parent projects are always larger than their sub-projects">
          <span class="kg-size-dots" aria-hidden="true"><i></i><i></i><i></i></span>size = connections
        </span>
        <span class="kg-legend-links" title="Link colour = relation type">
          ${REL_LEGEND.slice(0, 5).map(
            (c) => html`<span class="kg-lk" title=${REL_STYLES[c].label}><i style="background:${REL_STYLES[c].color};height:${Math.max(2, Math.round(REL_STYLES[c].width))}px"></i>${REL_STYLES[c].label}</span>`,
          )}
        </span>
        ${this.consolidatedIds.size
          ? html`<button class="kg-chip ${this.showConsolidated ? "on" : "off"}" title="Sub-projects already consolidated into tasks are hidden · click to toggle"
              @click=${() => {
                this.showConsolidated = !this.showConsolidated;
                this.rebuildSimulation();
              }}>Consolidated<span class="kg-chip-count">${this.consolidatedIds.size}</span></button>`
          : nothing}
      </div>
    `;
  }

  private renderDetail(sel: SimNode) {
    const repoMeta = this.repoMode ? repoMetaOf(sel.meta) : null;
    if (repoMeta) return this.renderRepoDetail(sel, repoMeta);
    const meta = sel.meta ?? {};
    const rels = this.relations.get(sel.id) ?? [];
    const groups = new Map<GraphNodeKind, Array<{ node: SimNode; rel: string }>>();
    for (const r of rels) {
      const other = this.nodeById.get(r.other);
      if (!other) continue;
      const arr = groups.get(other.kind) ?? groups.set(other.kind, []).get(other.kind)!;
      if (!arr.some((x) => x.node.id === other.id)) arr.push({ node: other, rel: r.rel });
    }
    const orderedGroups = KIND_ORDER.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)!] as const);
    const isProject = sel.kind === "project";
    const expanded = this.expanded.has(sel.id);
    const expanding = this.expanding.has(sel.id);
    const canOpen = openTargetFor(sel) != null;
    const statusText = isProject
      ? HEALTH_LABEL[sel.health ?? "backlog"]
      : String(meta.pipelineStatus ?? meta.status ?? "");
    const statusColor = isProject ? HEALTH_COLOR[sel.health ?? "backlog"] : sel.color;
    const tasks = Number(meta.tasks ?? 0);
    const progress = Math.round(Math.max(0, Math.min(1, Number(meta.progress ?? 0))) * 100);
    return html`
      <aside class="kg-panel kg-detail" aria-label="Details">
        <div class="kg-detail-head">
          <span
            class="kg-detail-dot ${sel.kind === "client" ? "kg-chip-dot--hex" : ""}"
            style="background:${sel.color}"
          ></span>
          ${sel.kind === "file"
            ? html`<span class="kg-detail-glyph" style="color:${sel.color};display:inline-flex">${meta.fileKind === "image" ? icons.image : icons.fileText}</span>`
            : nothing}
          <span class="kg-detail-kind">${KIND_SINGULAR[sel.kind] ?? sel.kind}</span>
          <button class="kg-detail-x" title="Close" @click=${() => this.clearSelection()}>${icons.x}</button>
        </div>
        <div class="kg-detail-label">${sel.label}</div>
        <div class="kg-pills">
          ${statusText
            ? html`<span class="kg-pill" style="--c:${statusColor}">${statusText}</span>`
            : nothing}
          ${meta.live === true || meta.active === true
            ? html`<span class="kg-pill kg-pill--live" style="--c:#3ddc97">agent working</span>`
            : nothing}
          ${isProject && meta.status && String(meta.status) !== statusText
            ? html`<span class="kg-pill kg-pill--ghost">${String(meta.status)}</span>`
            : nothing}
        </div>
        ${isProject
          ? html`
              ${tasks > 0
                ? html`
                    <div class="kg-progress" title="${progress}% of tasks done">
                      <span style="width:${progress}%"></span>
                    </div>
                    <div class="kg-progress-cap">
                      ${progress}% · ${Number(meta.done ?? 0).toLocaleString()} / ${tasks.toLocaleString()} tasks
                    </div>
                    <div class="kg-stats">
                      ${this.stat("In progress", meta.inProgress)} ${this.stat("Review", meta.review)}
                      ${this.stat("Blocked", meta.blocked, "#f0525f")}
                      ${this.stat("Overdue", meta.overdue, "#f5a524")}
                    </div>
                  `
                : html`<div class="kg-muted">No tasks yet</div>`}
              <div class="kg-row">
                <span>Last activity</span><b>${relativeAge(Number(meta.lastActivityAt ?? 0))}</b>
              </div>
              ${Array.isArray(meta.reasons) && meta.reasons.length
                ? html`<div class="kg-reasons">
                    ${(meta.reasons as string[]).map((r) => html`<span>${r}</span>`)}
                  </div>`
                : nothing}
            `
          : this.renderMetaRows(sel)}
        ${orderedGroups.length
          ? html`<div class="kg-rels">
              ${orderedGroups.map(
                ([kind, items]) => html`
                  <div class="kg-rel-group">
                    <div class="kg-rel-head">
                      <span class="kg-chip-dot" style="background:${KIND_PALETTE[kind]}"></span>
                      ${KIND_LABEL[kind]} <span class="kg-chip-count">${items.length}</span>
                    </div>
                    ${items.slice(0, 6).map(
                      (it) => html`
                        <button class="kg-rel" @click=${() => this.selectNode(it.node.id)}>
                          <span class="kg-rel-name">${it.node.label}</span>
                          <span class="kg-rel-kind">${it.rel}</span>
                        </button>
                      `,
                    )}
                    ${items.length > 6
                      ? html`<div class="kg-muted">+${items.length - 6} more</div>`
                      : nothing}
                  </div>
                `,
              )}
            </div>`
          : html`<div class="kg-muted">No relations yet.</div>`}
        <div class="kg-ai-row">
          <button class="kg-bb kg-bb--ai" @click=${() => void this.openAi("chat", [sel.id])}>${icons.messageSquare}<span>Chat</span></button>
          <button class="kg-bb kg-bb--ai" @click=${() => void this.openAi("summarize", [sel.id])}>${icons.fileText}<span>Summarize</span></button>
          <button class="kg-bb kg-bb--ai" @click=${() => this.openRelated([sel.id])}>${icons.network}<span>Related</span></button>
          <button class="kg-bb kg-bb--ai" @click=${() => this.openSpawn([sel.id])}>${icons.bot}<span>Agent</span></button>
        </div>
        <div class="kg-actions">
          ${canOpen
            ? html`<button class="kg-btn kg-btn--primary" @click=${() => this.openNode(sel)}>
                ${sel.kind === "file" ? icons.fileText : icons.externalLink} ${sel.kind === "file" ? "Open context" : "Open"}
              </button>`
            : nothing}
          <button class="kg-btn" title="Link to another node (or Ctrl+drag)" @click=${() => this.openPicker("link", [sel.id])}>${icons.link} Link</button>
          ${canReassign(sel.kind)
            ? html`<button class="kg-btn" title="Move to a project (or drag onto one)" @click=${() => this.openPicker("move", [sel.id])}>${icons.folder} Move</button>`
            : nothing}
          ${isProject && tasks > 0
            ? html`<button
                class="kg-btn"
                ?disabled=${expanding}
                @click=${() => (expanded ? this.collapseProject(sel.id) : void this.expandProject(sel.id))}
              >
                ${expanding ? "Loading…" : expanded ? "Hide tasks" : `Show tasks`}
              </button>`
            : nothing}
          <button
            class="kg-btn"
            @click=${() => this.fitTo(this.neighborhoodFor(sel.id) ?? [sel.id], 1.4)}
          >
            Focus
          </button>
        </div>
      </aside>
    `;
  }

  private stat(label: string, value: unknown, alert?: string) {
    const n = Number(value ?? 0);
    return html`<div class="kg-stat">
      <b style=${n > 0 && alert ? `color:${alert}` : ""}>${n.toLocaleString()}</b><span>${label}</span>
    </div>`;
  }

  private renderMetaRows(sel: SimNode) {
    const m = sel.meta ?? {};
    const rows: Array<[string, string]> = [];
    if (sel.kind === "client") {
      if (m.projects != null) rows.push(["Projects", `${m.openProjects ?? 0} open / ${m.projects}`]);
    }
    if (sel.kind === "run") {
      if (m.agentId) rows.push(["Agent", String(m.agentId)]);
      if (m.startedAt) rows.push(["Started", relativeAge(Number(m.startedAt))]);
    }
    if (sel.kind === "file") {
      if (typeof m.fileKind === "string") rows.push(["Type", m.fileKind]);
      if (typeof m.pages === "number" && m.pages > 0) rows.push(["Pages", m.pages.toLocaleString()]);
      if (typeof m.confidence === "number") rows.push(["OCR confidence", `${Math.round(m.confidence <= 1 ? m.confidence * 100 : m.confidence)}%`]);
      if (typeof m.relPath === "string" && m.relPath) rows.push(["Path", m.relPath]);
    }
    if (sel.kind === "topic" && typeof m.count === "number") rows.push(["Mentions", m.count.toLocaleString()]);
    if (m.priority) rows.push(["Priority", String(m.priority)]);
    if (typeof m.value === "number" && m.value > 0) rows.push(["Value", m.value.toLocaleString()]);
    if (Array.isArray(m.tags) && m.tags.length) rows.push(["Tags", (m.tags as string[]).slice(0, 5).join(", ")]);
    const upd = Number(m.updatedAt ?? 0) || Date.parse(String(m.updatedAt ?? ""));
    if (upd) rows.push(["Updated", relativeAge(upd)]);
    const summary = sel.kind === "file" && typeof m.summary === "string" ? m.summary.trim() : "";
    if (!rows.length && !summary) return nothing;
    return html`${summary ? html`<div class="kg-muted kg-file-summary" style="white-space:pre-wrap;margin:4px 0 6px">${truncate(summary, 420)}</div>` : nothing}${rows.map(
      ([k, v]) => html`<div class="kg-row"><span>${k}</span><b>${v}</b></div>`,
    )}`;
  }

  private styles() {
    const minH = this.compact ? "320px" : "560px";
    return html`
      <style>
        @keyframes kg-scan {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }

        /* ── Outer frame ─────────────────────────────── */
        .kg-host {
          position: relative;
          display: flex;
          flex-direction: column;
          height: 100%;
          width: 100%;
          min-height: ${minH};
          background:
            repeating-linear-gradient(
              0deg,
              color-mix(in srgb, var(--g-primary, #d4af37) 3%, transparent) 0px,
              color-mix(in srgb, var(--g-primary, #d4af37) 3%, transparent) 1px,
              transparent 1px,
              transparent 5px
            ),
            linear-gradient(
              180deg,
              color-mix(in srgb, var(--g-primary, #d4af37) 8%, rgba(14,10,26,0.96)) 0%,
              color-mix(in srgb, var(--g-bg-deep, #060010) 80%, transparent) 100%
            );
          border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 28%, transparent);
          border-radius: 12px;
          overflow: hidden;
          color: var(--g-fg, #e4e4e7);
          font-family: "JetBrains Mono", "SF Mono", Consolas, monospace;
          box-shadow:
            inset 0 1px 0 color-mix(in srgb, var(--g-primary, #d4af37) 25%, transparent),
            inset 0 -1px 0 rgba(0,0,0,0.45),
            0 14px 44px rgba(0,0,0,0.55),
            0 0 0 1px color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent);
        }

        .kg-corner { position: absolute; width: 14px; height: 14px; pointer-events: none; z-index: 5; }
        .kg-corner--tl { top: 3px; left: 3px; border-top: 1.5px solid color-mix(in srgb, var(--g-primary, #d4af37) 85%, transparent); border-left: 1.5px solid color-mix(in srgb, var(--g-primary, #d4af37) 85%, transparent); }
        .kg-corner--tr { top: 3px; right: 3px; border-top: 1.5px solid color-mix(in srgb, var(--g-primary, #d4af37) 85%, transparent); border-right: 1.5px solid color-mix(in srgb, var(--g-primary, #d4af37) 85%, transparent); }
        .kg-corner--bl { bottom: 3px; left: 3px; border-bottom: 1.5px solid color-mix(in srgb, var(--g-primary, #d4af37) 85%, transparent); border-left: 1.5px solid color-mix(in srgb, var(--g-primary, #d4af37) 85%, transparent); }
        .kg-corner--br { bottom: 3px; right: 3px; border-bottom: 1.5px solid color-mix(in srgb, var(--g-primary, #d4af37) 85%, transparent); border-right: 1.5px solid color-mix(in srgb, var(--g-primary, #d4af37) 85%, transparent); }

        /* ── Toolbar ─────────────────────────────────── */
        .kg-toolbar {
          position: relative;
          display: flex; gap: 8px; align-items: center;
          padding: 9px 14px;
          background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent) 0%, transparent 100%);
          border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent);
          flex-shrink: 0;
          z-index: 2;
        }
        .kg-host--compact .kg-toolbar { padding: 6px 10px; }
        .kg-scanline { position: absolute; top: 0; left: 0; right: 0; height: 2px; pointer-events: none; z-index: 4; overflow: hidden; }
        .kg-scanline::before {
          content: ""; position: absolute; inset: 0;
          background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--g-primary, #d4af37) 50%, transparent) 50%, transparent 100%);
          animation: kg-scan 3s linear infinite;
        }
        .kg-title {
          font-size: 10.5px; font-weight: 700; letter-spacing: 0.38em; text-transform: uppercase;
          color: color-mix(in srgb, var(--g-primary, #d4af37) 90%, #fff);
          flex: 0 0 auto; white-space: nowrap;
        }
        .kg-host--compact .kg-title { font-size: 9.5px; }
        .kg-node-count {
          font-size: 13px; font-weight: 700; line-height: 1;
          color: color-mix(in srgb, var(--g-primary, #d4af37) 80%, #fff);
          min-width: 16px;
        }
        .kg-search {
          flex: 1; min-width: 0;
          background: color-mix(in srgb, var(--g-primary, #d4af37) 5%, rgba(0,0,0,0.4));
          border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 22%, transparent);
          color: var(--g-fg, #e4e4e7);
          padding: 5px 10px; border-radius: 6px; font-size: 0.82rem; font-family: inherit;
        }
        .kg-search::placeholder { color: var(--g-fg-dim, #71717a); }
        .kg-search:focus { outline: none; border-color: color-mix(in srgb, var(--g-primary, #d4af37) 60%, transparent); }
        .kg-btn {
          display: inline-flex; align-items: center; gap: 6px;
          background: color-mix(in srgb, var(--g-primary, #d4af37) 6%, rgba(0,0,0,0.35));
          border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 22%, transparent);
          color: var(--g-fg, #e4e4e7);
          padding: 5px 10px; border-radius: 6px;
          cursor: pointer; font-size: 0.78rem; font-family: inherit;
          transition: border-color 0.15s, background 0.15s, color 0.15s;
          white-space: nowrap;
        }
        .kg-btn:hover:not(:disabled), .kg-btn--on {
          border-color: color-mix(in srgb, var(--g-primary, #d4af37) 55%, transparent);
          background: color-mix(in srgb, var(--g-primary, #d4af37) 14%, transparent);
          color: color-mix(in srgb, var(--g-primary, #d4af37) 90%, #fff);
        }
        .kg-btn:disabled { opacity: 0.45; cursor: default; }
        .kg-btn:focus-visible, .kg-chip:focus-visible, .kg-insight:focus-visible, .kg-rel:focus-visible {
          outline: 2px solid color-mix(in srgb, var(--g-primary, #d4af37) 70%, transparent);
          outline-offset: 1px;
        }
        .kg-btn--primary {
          background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #d4af37) 32%, transparent), color-mix(in srgb, var(--g-primary, #d4af37) 16%, transparent));
          border-color: color-mix(in srgb, var(--g-primary, #d4af37) 60%, transparent);
          color: #fff3cf;
        }
        .kg-btn-badge {
          font-size: 0.65rem; padding: 0 5px; border-radius: 999px; line-height: 1.5;
          background: color-mix(in srgb, var(--g-primary, #d4af37) 30%, transparent);
          color: #fff3cf;
        }

        /* ── Legend strip ────────────────────────────── */
        .kg-legend {
          display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
          padding: 7px 12px;
          border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 12%, transparent);
          background: color-mix(in srgb, var(--g-primary, #d4af37) 2%, transparent);
          flex-shrink: 0; z-index: 2;
        }
        .kg-legend-label {
          font-size: 0.6rem; letter-spacing: 0.22em; text-transform: uppercase;
          color: color-mix(in srgb, var(--g-primary, #d4af37) 70%, #888);
          margin: 0 2px 0 4px;
        }
        .kg-legend-sep { width: 1px; height: 16px; margin: 0 6px; background: color-mix(in srgb, var(--g-primary, #d4af37) 22%, transparent); }
        .kg-chip {
          display: inline-flex; align-items: center; gap: 5px;
          background: transparent;
          color: var(--g-fg, #e4e4e7);
          border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent);
          padding: 3px 8px; border-radius: 999px; font-size: 0.7rem;
          font-family: inherit; cursor: pointer;
          transition: border-color 0.12s, opacity 0.12s, background 0.12s;
        }
        .kg-chip:hover { border-color: color-mix(in srgb, var(--g-primary, #d4af37) 45%, transparent); }
        .kg-chip.on { background: color-mix(in srgb, var(--g-primary, #d4af37) 5%, transparent); }
        .kg-chip.off { opacity: 0.38; }
        .kg-chip-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .kg-chip-dot--hex { border-radius: 0; clip-path: polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%); width: 9px; height: 9px; }
        .kg-chip-ring {
          width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
          background: radial-gradient(circle at 35% 35%, color-mix(in srgb, var(--c) 40%, #fff), var(--c) 60%);
          box-shadow: 0 0 6px color-mix(in srgb, var(--c) 60%, transparent);
        }
        .kg-chip-count { color: var(--g-fg-dim, #a1a1aa); margin-left: 3px; font-variant-numeric: tabular-nums; font-size: 0.65rem; }

        /* ── Stage (canvas area) ─────────────────────── */
        .kg-stage {
          position: relative; flex: 1; min-height: 0;
          background:
            radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--g-primary, #d4af37) 12%, transparent) 0.5px, transparent 1.2px) 0 0 / 8px 8px,
            radial-gradient(ellipse at 50% 50%, color-mix(in srgb, var(--g-primary, #d4af37) 8%, transparent) 0%, transparent 55%),
            radial-gradient(ellipse at 50% 50%, transparent 55%, color-mix(in srgb, #000 55%, transparent) 100%),
            var(--graph-bg, var(--g-bg-deep, #08060f));
        }
        .kg-canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
        .kg-canvas:active { cursor: grabbing; }

        /* ── 3D stage ────────────────────────────────── */
        .kg-stage--3d {
          background:
            radial-gradient(ellipse at 50% 60%, color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent) 0%, transparent 60%),
            linear-gradient(180deg, #0d0a22 0%, #030207 100%);
        }
        .kg-3d-host { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; }
        .kg-3d-host canvas:active { cursor: grabbing; }
        .kg3d-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
        .kg3d-label {
          position: absolute; left: 0; top: 0; white-space: nowrap; transform-origin: 0 0;
          font: 500 10.5px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          line-height: 15px; letter-spacing: 0.01em;
          color: rgba(214, 214, 222, 0.92);
          text-shadow: 0 0 8px rgba(3, 2, 8, 0.95), 0 0 2px rgba(3, 2, 8, 1), 0 1px 1px rgba(0,0,0,0.9);
          will-change: transform, opacity;
          transition: opacity 0.18s ease;
        }
        /* Dark halo behind every name so text reads over glow. */
        .kg3d-label { background: rgba(3, 2, 8, 0.7); border-radius: 4px; padding: 0 4px; box-shadow: 0 0 9px 2px rgba(3, 2, 8, 0.4); }
        .kg3d-label--tag {
          font: 700 10px Inter, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.2em; line-height: 18px; padding: 0 8px;
          color: color-mix(in srgb, var(--gc, #d4af37) 82%, #fff); background: rgba(5, 4, 12, 0.84);
          border: 1px solid color-mix(in srgb, var(--gc, #d4af37) 45%, transparent);
          text-shadow: 0 0 8px color-mix(in srgb, var(--gc, #d4af37) 50%, transparent);
        }
        .kg3d-label--pocket {
          font: 600 9px Inter, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0.16em; line-height: 16px; padding: 0 7px;
          color: color-mix(in srgb, var(--gc, #a1a1aa) 62%, #e7e5e4); background: rgba(5, 4, 12, 0.74);
          border: 1px dashed color-mix(in srgb, var(--gc, #a1a1aa) 40%, transparent); border-radius: 999px;
        }
        .kg3d-label--super {
          font: 700 11px Inter, -apple-system, "Segoe UI", sans-serif; line-height: 17px; padding: 0 8px; color: #fff7e0;
          background: rgba(5, 4, 12, 0.86); border: 1px solid color-mix(in srgb, var(--gc, #d4af37) 55%, transparent); border-radius: 999px;
        }
        .kg3d-leaders { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
        .kg3d-leaders line { stroke-width: 1; stroke-opacity: 0.6; stroke-dasharray: 3 3; }
        .kg3d-leaders circle { fill-opacity: 0.85; }
        .kg3d-label--anchor {
          font-weight: 700; font-size: 12.5px; color: #fbf6ea;
          text-shadow: 0 0 12px color-mix(in srgb, var(--g-primary, #d4af37) 45%, transparent), 0 0 3px rgba(3,2,8,1), 0 1px 1px rgba(0,0,0,0.9);
        }
        .kg3d-label--client {
          font-weight: 700; font-size: 11.5px; color: #fbf1d6; letter-spacing: 0.04em; text-transform: uppercase; font-size: 10.5px;
          text-shadow: 0 0 12px rgba(232, 197, 107, 0.55), 0 0 3px rgba(3,2,8,1);
        }
        .kg3d-label--quiet { font-weight: 600; font-size: 11.5px; color: rgba(214, 210, 200, 0.82); }
        .kg3d-label--focus {
          font-weight: 800; font-size: 12.5px; color: #ffe08a;
          text-shadow: 0 0 16px rgba(245, 197, 66, 0.9), 0 0 4px rgba(3,2,8,1), 0 1px 1px rgba(0,0,0,0.9);
        }
        .kg-btn--mode { font-weight: 800; letter-spacing: 0.08em; min-width: 38px; justify-content: center; }
        .kg-host--compact .kg3d-labels { font-size: 9.5px; }

        /* ── Floating glass panels ───────────────────── */
        .kg-panel {
          position: absolute; top: 12px;
          max-height: calc(100% - 24px); overflow: auto;
          background: color-mix(in srgb, var(--g-bg-deep, #08060f) 86%, transparent);
          border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 26%, transparent);
          border-radius: 10px; padding: 12px;
          font-size: 0.76rem;
          backdrop-filter: blur(14px) saturate(140%);
          -webkit-backdrop-filter: blur(14px) saturate(140%);
          box-shadow: 0 10px 30px rgba(0,0,0,0.55), inset 0 1px 0 color-mix(in srgb, var(--g-primary, #d4af37) 16%, transparent);
          scrollbar-width: thin;
          z-index: 3;
        }
        .kg-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .kg-panel-title {
          font-size: 0.62rem; letter-spacing: 0.3em; text-transform: uppercase; font-weight: 700;
          color: color-mix(in srgb, var(--g-primary, #d4af37) 90%, #fff);
        }
        .kg-link { background: none; border: none; color: color-mix(in srgb, var(--g-primary, #d4af37) 85%, #fff); cursor: pointer; font: inherit; font-size: 0.7rem; padding: 0; }
        .kg-muted { color: var(--g-fg-dim, #8b8b94); font-size: 0.7rem; margin: 4px 0; }

        .kg-insights { left: 12px; width: 268px; }
        .kg-insight {
          display: flex; flex-direction: column; gap: 3px; width: 100%;
          text-align: left; cursor: pointer; font: inherit; color: inherit;
          background: rgba(255,255,255,0.02);
          border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 12%, transparent);
          border-left: 2px solid var(--sev);
          border-radius: 7px; padding: 8px 10px; margin-bottom: 6px;
          transition: background 0.12s, border-color 0.12s;
        }
        .kg-insight:hover { background: color-mix(in srgb, var(--sev) 8%, transparent); }
        .kg-insight--on {
          background: color-mix(in srgb, var(--sev) 14%, transparent);
          border-color: color-mix(in srgb, var(--sev) 55%, transparent);
        }
        .kg-insight-title { font-weight: 700; font-size: 0.74rem; color: var(--g-fg, #ececef); }
        .kg-insight-detail {
          color: var(--g-fg-dim, #9a9aa3); font-size: 0.68rem; line-height: 1.35;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        }

        .kg-detail { right: 12px; width: 300px; max-width: 60%; animation: kg-slide-in 0.15s ease; }
        .kg-host--compact .kg-detail { width: 240px; }
        @keyframes kg-slide-in {
          from { opacity: 0; transform: translateY(-6px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .kg-detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .kg-detail-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
        .kg-detail-kind { color: var(--g-fg-dim, #a1a1aa); text-transform: uppercase; font-size: 0.64rem; letter-spacing: 0.16em; }
        .kg-detail-x { margin-left: auto; background: transparent; border: none; color: var(--g-fg-dim, #a1a1aa); cursor: pointer; font-size: 1.1rem; line-height: 1; padding: 0 2px; }
        .kg-detail-x:hover { color: var(--g-fg, #e4e4e7); }
        .kg-detail-label {
          font-family: Inter, -apple-system, "Segoe UI", sans-serif;
          font-weight: 700; font-size: 0.98rem; line-height: 1.25; margin-bottom: 8px; color: #f6f1e4;
        }
        .kg-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
        .kg-pill {
          font-size: 0.64rem; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 700;
          padding: 2px 8px; border-radius: 999px;
          color: color-mix(in srgb, var(--c) 80%, #fff);
          background: color-mix(in srgb, var(--c) 16%, transparent);
          border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
        }
        .kg-pill--ghost { --c: #9a9aa3; }
        .kg-pill--live::before { content: "●"; margin-right: 4px; }
        .kg-progress { height: 5px; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; }
        .kg-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #b8912a, #f5c542); box-shadow: 0 0 8px rgba(245,197,66,0.5); }
        .kg-progress-cap { font-size: 0.68rem; color: var(--g-fg-dim, #a1a1aa); margin: 5px 0 8px; font-variant-numeric: tabular-nums; }
        .kg-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 8px; }
        .kg-stat {
          display: flex; flex-direction: column; align-items: center; gap: 1px;
          padding: 6px 2px; border-radius: 6px;
          background: rgba(255,255,255,0.03);
          border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent);
        }
        .kg-stat b { font-size: 0.86rem; color: #f3eee0; font-variant-numeric: tabular-nums; }
        .kg-stat span { font-size: 0.56rem; color: var(--g-fg-dim, #9a9aa3); text-transform: uppercase; letter-spacing: 0.06em; }
        .kg-row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 0.72rem; color: var(--g-fg-dim, #a1a1aa); }
        .kg-row b { color: #ebe6d8; font-weight: 600; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .kg-reasons { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 2px; }
        .kg-reasons span { font-size: 0.64rem; padding: 2px 7px; border-radius: 5px; color: #f5c77a; background: rgba(245,165,36,0.1); border: 1px solid rgba(245,165,36,0.3); }
        .kg-rels { margin-top: 10px; border-top: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 14%, transparent); padding-top: 8px; }
        .kg-rel-group { margin-bottom: 8px; }
        .kg-rel-head { display: flex; align-items: center; gap: 6px; font-size: 0.62rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--g-fg-dim, #a1a1aa); margin-bottom: 3px; }
        .kg-rel {
          display: flex; align-items: baseline; justify-content: space-between; gap: 8px; width: 100%;
          background: transparent; border: none; border-radius: 5px; padding: 3px 6px; margin-left: -6px;
          color: #e9e4d6; font: inherit; font-size: 0.72rem; cursor: pointer; text-align: left;
        }
        .kg-rel:hover { background: color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent); }
        .kg-rel-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .kg-rel-kind { flex-shrink: 0; font-size: 0.62rem; color: var(--g-fg-dim, #8b8b94); }
        .kg-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }

        /* ── Status banners ──────────────────────────── */
        .kg-banner {
          position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
          background: color-mix(in srgb, var(--g-bg-deep, #08060f) 90%, transparent);
          border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 25%, transparent);
          padding: 5px 14px; border-radius: 999px; font-size: 0.78rem;
          white-space: nowrap; pointer-events: none;
        }
        .kg-banner-err { color: #fca5a5; border-color: rgba(239,68,68,0.4); }
        .kg-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
        .kg-empty-text {
          padding: 18px 24px; border-radius: 8px;
          border: 1px dashed color-mix(in srgb, var(--g-primary, #d4af37) 35%, transparent);
          color: var(--g-fg-dim, #71717a);
          font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase; text-align: center; line-height: 1.6;
        }
        .kg-footer-strip { height: 2px; flex-shrink: 0; background: linear-gradient(90deg, var(--g-primary, #d4af37), var(--g-accent, #a855f7)); opacity: 0.65; }

        @media (max-width: 900px) {
          .kg-insights { display: none; }
          .kg-detail { width: auto; left: 12px; right: 12px; max-width: none; top: auto; bottom: 12px; max-height: 55%; }
        }
        @media (prefers-reduced-motion: reduce) {
          .kg-scanline::before { animation: none; }
          .kg-detail { animation: none; }
        }
      </style>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "infinibot-knowledge-graph": KnowledgeGraph;
  }
}
