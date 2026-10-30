/**
 * KgController — the native Knowledge Graph's state and actions.
 *
 * A framework-free port of the web host (ui/src/ui/components/
 * knowledge-graph.ts): the same snapshot RPCs, filters, selection rules,
 * signals, link / move / status / tag / delete / consolidate / sub-project
 * consolidation / spawn plans, undo stack, activity feed and deep links. The
 * planners and the snapshot → scene pipeline are the web's own code (bundled
 * in ./generated/kg-core.js); this file is the glue the Lit element has
 * inline — kept method-for-method so the two stay comparable.
 *
 * React reads it through useKgController (subscribe → version bump). Tests
 * drive it with a fake gateway and a fake stage.
 */
import * as core from './generated/kg-core';

const {
  BULK_STATUSES,
  GROUP_MODES,
  DEFAULT_HEALTH,
  DEFAULT_KINDS,
  HEALTH_ORDER,
  KIND_ORDER,
  UndoStack,
  baseEmphasis,
  buildAiContext,
  buildScene,
  buildUndo,
  canReassign,
  captureOf,
  clusterSubProjects,
  describePlan,
  diffActivity,
  highlightSetOf,
  isDocumentNode,
  isLiveNode,
  labelRuleFor,
  layoutAspectFor,
  LOD_MINOR_LABELS_ABOVE,
  neighbourhoodOf,
  planBulkDelete,
  planBulkLink,
  planBulkReassign,
  planBulkStatus,
  planBulkTag,
  planConsolidate,
  planConvertToTasks,
  planLink,
  planMergeDuplicates,
  planReassign,
  resolveRefs,
  sanitizeSnapshot,
  sceneInsights,
  selectInLasso,
  spawnTask,
  stageEmphasis,
  stageFocusId,
  stageGroupsOf,
  stageLayoutV3Of,
  stageLinksOf,
  stageRingsOf,
  storeIdOf,
  subProjectsOf,
  suggestLinks,
  truncate,
  unlinkCall,
  UNRESOLVED,
} = core;

export const PREFS_KEY = '@infinibot/kg_native_v1';
export const DROP_ARM_MS = 320;
const GROUP_IDS = GROUP_MODES.map((g) => g.id);
const MOTION_PREFS = ['system', 'reduced', 'full'];
const QUALITY_PREFS = ['auto', 'high', 'low'];

export const DEFAULT_PREFS = {
  kinds: [...DEFAULT_KINDS],
  health: [...DEFAULT_HEALTH],
  // "group.v2": the brain formation is the default (same as the web).
  group: 'brain',
  connections: 'all',
  hulls: true,
  ambience: true,
  motion: 'system',
  quality: 'auto',
  // The web's renderer toggle: '3d' galaxy or the '2d' flat map.
  renderer: '3d',
  // Filter legend: 'open' (the web strip) or 'closed' to one summary row.
  legend: 'open',
  dismissed: [],
};

export function cleanPrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const kinds = Array.isArray(p.kinds) ? p.kinds.filter((k) => KIND_ORDER.includes(k)) : DEFAULT_PREFS.kinds;
  const health = Array.isArray(p.health) ? p.health.filter((h) => HEALTH_ORDER.includes(h)) : DEFAULT_PREFS.health;
  return {
    kinds: kinds.length ? kinds : DEFAULT_PREFS.kinds,
    health: health.length ? health : DEFAULT_PREFS.health,
    group: GROUP_IDS.includes(p.group) ? p.group : DEFAULT_PREFS.group,
    connections: ['all', 'selected', 'none'].includes(p.connections) ? p.connections : 'all',
    hulls: p.hulls !== false,
    ambience: p.ambience !== false,
    motion: MOTION_PREFS.includes(p.motion) ? p.motion : 'system',
    quality: QUALITY_PREFS.includes(p.quality) ? p.quality : 'auto',
    renderer: p.renderer === '2d' ? '2d' : '3d',
    legend: p.legend === 'closed' ? 'closed' : 'open',
    dismissed: Array.isArray(p.dismissed) ? p.dismissed.filter((x) => typeof x === 'string').slice(-300) : [],
  };
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function newKey() {
  return `kg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const SCOPE_HOP_CHOICES = [1, 2, 3, 4];

export function clampScopeHops(raw) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(4, Math.floor(n)));
}

/** The gateway's `scope` block off a raw snapshot (sanitizeSnapshot drops it). */
export function scopeInfoOf(raw) {
  const s = raw && typeof raw === 'object' ? raw.scope : null;
  if (!s || typeof s !== 'object' || typeof s.projectNodeId !== 'string') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    projectId: String(s.projectId ?? ''),
    projectNodeId: s.projectNodeId,
    label: typeof s.label === 'string' ? s.label : null,
    found: s.found === true,
    hops: clampScopeHops(s.hops),
    totalNodes: num(s.totalNodes),
    hubs: Array.isArray(s.hubs) ? s.hubs.filter((h) => typeof h === 'string') : [],
  };
}

export class KgController {
  /**
   * @param {object} opts
   *  request(method, params) → Promise      gateway RPC
   *  storage { getItem, setItem }           AsyncStorage-like (optional)
   *  haptic(style)                          optional
   *  openNode(node)                         native "Open" (screen navigation)
   *  copy(text) → Promise                   clipboard (optional)
   *  now() / perfNow()                      clocks (tests)
   */
  constructor(opts) {
    this.opts = opts;
    this.request = opts.request;
    this.now = opts.now || (() => Date.now());
    this.perfNow = opts.perfNow || (() => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()));
    this.listeners = new Set();
    this.version = 0;
    this.stage = null;
    this.size = { w: 390, h: 700 };
    this.undoStack = new UndoStack();
    this.prefs = { ...DEFAULT_PREFS };
    this.dismissed = new Set();
    this.timers = new Set();

    // Data
    this.snapshot = null;
    this.loading = false;
    this.error = null;
    this.expanded = new Map();
    this.expanding = new Set();
    this.localEdges = [];
    this.consolidatedIds = new Set();
    this.showConsolidated = false;
    this.consolidatedAt = 0;
    this.prevSnapshotNodes = null;
    this.scene = null;
    this.nodes = [];
    this.links = [];
    this.nodeById = new Map();
    this.adjacency = new Map();
    this.relations = new Map();
    this.degree = [];
    this.v3 = null;
    this.grouping = null;
    this.topoSig = '';
    this.searchMatchIds = null;
    this.focusNbh = { id: null, set: null };

    // UI state (mirrors the Lit element's @state fields)
    this.search = '';
    this.selection = new Set();
    this.selectedId = null;
    this.hoveredId = null;
    this.activeInsight = null;
    this.highlightSet = null;
    this.hudInsights = [];
    this.activity = [];
    this.hudOpen = false;
    this.hudTab = 'signals';
    this.settingsOpen = false;
    this.linkMode = false;
    this.selectMode = false;
    this.linkTapFrom = null;
    this.menu = null;
    this.peekId = null;
    this.detailId = null;
    this.dialog = null;
    this.toast = null;
    this.busy = false;
    this.ai = null; // { intent, title, context, count, nodeIds, seq }
    this.dropTarget = null;
    this.dragLine = null;
    this.lassoPts = null;
    this.dragFrom = null;
    this.userMovedView = false;
    this.needsFit = true;
    this.groupChanged = false;
    this.pendingDeepFocus = null;
    this.pendingLayerFit = null;
    this.pendingSearchFit = false;
    this.projectRows = null;
    this.glide = null;
    this.systemReducedMotion = false;

    // Secure Mode: the graph shows the encrypted secure lane
    // (secure.graph.snapshot) and every non-secure write is refused.
    this.secure = false;
    this.laneSeq = 0;

    // Project scope (KanbanScreen "Knowledge Graph" button): the gateway cuts
    // the snapshot to one project (graph.global.snapshot { projectId, hops }).
    this.projectScope = null; // { id, name, hops }
    this.scopeInfo = null; // the gateway's `scope` block
    this.scopeKinds = null; // layer set while scoped (not saved to prefs)
    this.scopeFocused = null;
  }

  // ── Subscription ───────────────────────────────────────────

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.version++;
    for (const fn of this.listeners) fn(this.version);
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.glide?.raf) cancelAnimationFrame(this.glide.raf);
    this.stage = null;
    this.listeners.clear();
  }

  haptic(style) {
    try {
      this.opts.haptic?.(style);
    } catch {
      /* no haptics */
    }
  }

  // ── Preferences ────────────────────────────────────────────

  get enabledKinds() {
    // Secure lane: the graph is small and fully loaded, so every layer it has
    // is shown (tasks are a lazy "heavy" layer in the normal graph). Not saved
    // to prefs, so the normal graph keeps the user's own layer picks.
    if (this.projectScope && this.scopeKinds) return new Set(this.scopeKinds);
    if (this.secure && this.snapshot?.nodes?.length) {
      return new Set([...this.prefs.kinds, ...this.snapshot.nodes.map((n) => n.kind)]);
    }
    return new Set(this.prefs.kinds);
  }

  get enabledHealth() {
    // A project view shows every status (the project itself is never filtered out).
    if (this.projectScope) return new Set(HEALTH_ORDER);
    return new Set(this.prefs.health);
  }

  get groupMode() {
    // A project view is a handful of nodes: clusters, not brain lobes / orbits (web parity).
    if (this.projectScope && !this.scopeGroupPicked && (this.prefs.group === 'brain' || this.prefs.group === 'orbit')) return 'cluster';
    return this.prefs.group;
  }

  async loadPrefs() {
    try {
      const raw = await this.opts.storage?.getItem(PREFS_KEY);
      if (raw) this.prefs = cleanPrefs(JSON.parse(raw));
    } catch {
      /* fresh */
    }
    this.dismissed = new Set(this.prefs.dismissed);
    this.applyStageSettings();
    this.emit();
  }

  savePrefs(patch) {
    this.prefs = cleanPrefs({ ...this.prefs, ...patch, dismissed: [...this.dismissed] });
    try {
      this.opts.storage?.setItem(PREFS_KEY, JSON.stringify(this.prefs))?.catch?.(() => {});
    } catch {
      /* session-only */
    }
  }

  get reducedMotion() {
    if (this.prefs.motion === 'reduced') return true;
    if (this.prefs.motion === 'full') return false;
    return this.systemReducedMotion;
  }

  setSystemReducedMotion(on) {
    this.systemReducedMotion = !!on;
    this.stage?.setReducedMotion(this.reducedMotion);
  }

  // ── Stage binding ──────────────────────────────────────────

  /** The stage's callbacks (KnowledgeGraph3DStage → controller). */
  get stageCallbacks() {
    if (this._cb) return this._cb;
    this._cb = {
      onHover: (id) => {
        if (this.hoveredId === id) return;
        this.hoveredId = id;
        this.stage?.setFocus(this.stageFocus());
      },
      onSelect: (id, opts) => {
        this.menu = null;
        if (id && this.linkMode && this.tapLink(id)) return this.emit();
        if (id && opts?.additive) this.toggleSelected(id);
        else if (id) {
          this.selection = new Set([id]);
          this.selectNode(id, false);
          this.syncRings();
          this.peek(id);
        } else this.clearSelection();
        this.emit();
      },
      onOpen: (id) => {
        const n = this.nodeById.get(id);
        if (!n) return;
        this.selectedId = id;
        this.openNode(n);
      },
      onDragStart: (index) => {
        const n = this.nodes[index];
        if (!n) return;
        this.dragFrom = n.id;
        this.peekId = null;
        this.selectedId = n.id;
        this.emit();
      },
      onDrag: () => {},
      onDragOver: (index, target) => this.onDragOverNode(this.nodes[index], target >= 0 ? this.nodes[target] : undefined),
      onDragEnd: (index) => {
        const n = this.nodes[index];
        void this.finishNodeDrag(n);
        // The layout is deterministic: the node glides back to its place
        // (a successful move rebuilds the scene from the next snapshot).
        this.glideToTargets([index]);
      },
      onLinkStart: (index) => this.beginLinkDrag(this.nodes[index]),
      onLinkMove: (x, y, target) => this.moveLinkDrag(x, y, target >= 0 ? this.nodes[target] : undefined),
      onLinkEnd: (target) => void this.endLinkDrag(target >= 0 ? this.nodes[target] : undefined),
      onLasso: (pts, done) => this.onLasso(pts, done),
      onContextMenu: (id, x, y) => this.openMenu(id, x, y),
      onProjected: () => {
        if (this.dragLine || this.lassoPts) this.emit();
      },
      onUserMoved: () => {
        this.userMovedView = true;
      },
      onContextLost: () => {
        this.error = 'The 3D view lost its graphics context — tap Retry.';
        this.emit();
      },
      labelFor: (node, k) => {
        const focusId = this.selectedId ?? this.hoveredId;
        const rule = labelRuleFor(node, k, {
          focusId,
          nbh: this.nbhOf(focusId),
          highlightSet: this.highlightSet,
          minorOk: k > LOD_MINOR_LABELS_ABOVE,
          degree: this.degree,
          stage3d: true,
        });
        return rule ? { text: rule.text, pri: rule.pri, cls: rule.cls, scale: rule.scale } : null;
      },
      emphasisFor: (node) => stageEmphasis(node, this.focusState(), (id) => this.nbhOf(id)),
      // The 2D map's per-frame state (emphasis, labels, selection bezels).
      mapState: () => ({ ...this.focusState(), dropTarget: this.dropTarget, degree: this.degree }),
      liveFor: (node) => isLiveNode(node),
    };
    return this._cb;
  }

  attachStage(stage) {
    this.stage = stage;
    if (!stage) return;
    this.applyStageSettings();
    if (this.nodes.length) {
      this.syncStage();
      stage.resetView(this.anchorIds());
      // A deep link that landed before the stage existed: fly to it now.
      if (this.selectedId && this.peekId === this.selectedId) stage.flyToNode(this.selectedId);
    }
  }

  setSize(w, h) {
    const changed = Math.abs(w - this.size.w) > 1 || Math.abs(h - this.size.h) > 1;
    this.size = { w, h };
    if (!changed) return;
    // The map modes lay out to the screen's aspect (brain mode is aspect-free).
    if (this.snapshot && this.groupMode !== 'brain') this.rebuild();
    else if (this.stage && this.nodes.length && !this.userMovedView) this.stage.resetView(this.anchorIds());
  }

  applyStageSettings() {
    const s = this.stage;
    if (!s) return;
    s.setReducedMotion(this.reducedMotion);
    s.setQualityMode(this.prefs.quality);
    s.setAmbience(this.prefs.ambience);
    s.setConnectionsMode(this.prefs.connections);
    s.setHullsVisible(this.prefs.hulls);
    s.setInteractionModes({ link: this.linkMode, select: this.selectMode });
  }

  anchorIds() {
    const ids = this.nodes.filter((n) => n.anchor).map((n) => n.id);
    return ids.length ? ids : this.nodes.map((n) => n.id);
  }

  syncStage() {
    const s = this.stage;
    if (!s) return;
    s.setGraph(this.nodes, stageLinksOf(this.links, this.v3), { cx: 0, cy: 0 }, this.groupMode === 'orbit' && this.v3 ? this.v3.orbitRadii : []);
    s.setLayoutV3(stageLayoutV3Of(this.nodes, this.v3));
    s.setGroups(stageGroupsOf(this.grouping, this.nodeById));
    // The flat map draws the grouping's zones itself (the web 2D draw()).
    s.setGrouping?.(this.grouping, this.groupMode, this.search);
    this.syncRings();
    s.setFocus(this.selectedId ?? this.hoveredId);
  }

  syncRings() {
    this.stage?.setRings(stageRingsOf(this.nodes, { selection: this.selection, selectedId: this.selectedId, dropTarget: this.dropTarget }));
  }

  stageFocus() {
    return stageFocusId(this);
  }

  focusState() {
    return {
      selection: this.selection,
      selectedId: this.selectedId,
      hoveredId: this.hoveredId,
      adjacency: this.adjacency,
      highlightSet: this.highlightSet,
      activeInsight: this.activeInsight,
    };
  }

  nbhOf(id) {
    if (!id) return null;
    if (this.focusNbh.id === id && this.focusNbh.set) return this.focusNbh.set;
    const set = neighbourhoodOf(this.adjacency, id);
    this.focusNbh = { id, set };
    return set;
  }

  /** Selection / hover / insight changed: re-focus the stage. */
  refocus() {
    this.stage?.setFocus(this.stageFocus());
  }

  // ── Data ───────────────────────────────────────────────────

  async refresh(force = false) {
    if (!this.request) return;
    const lane = this.laneSeq;
    const secure = this.secure;
    this.loading = true;
    this.error = null;
    this.emit();
    try {
      const scoped = this.projectScope ? { projectId: this.projectScope.id, hops: this.projectScope.hops } : {};
      const raw = secure
        ? await this.request('secure.graph.snapshot', scoped)
        : await this.request('graph.global.snapshot', { types: [...this.enabledKinds], ...scoped, ...(force ? { refresh: true } : {}) });
      // The lane (or project scope) switched while this was in flight: never mix graphs.
      if (lane !== this.laneSeq) return;
      this.scopeInfo = this.projectScope ? scopeInfoOf(raw) : null;
      const res = sanitizeSnapshot(raw);
      if (!res) throw new Error('The gateway returned an unreadable graph.');
      this.absorbSnapshot(res);
      this.queueScopeFocus();
      if (!secure && !this.projectScope) void this.refreshConsolidated(force);
    } catch (err) {
      if (lane !== this.laneSeq) return;
      this.error = err?.code === 'SECURE_MODE_LOCKED' ? 'Secure Mode is off. Turn it on to see the secure graph.' : errText(err);
    } finally {
      if (lane === this.laneSeq) {
        this.loading = false;
        this.emit();
      }
    }
  }

  /**
   * Switch between the normal graph and the Secure Mode lane. Everything the
   * other lane loaded (nodes, expansions, local edges, selection, cards,
   * activity) is dropped before the new lane loads.
   */
  setSecure(on) {
    const next = Boolean(on);
    if (next === this.secure) return;
    this.secure = next;
    this.laneSeq++;
    this.snapshot = null;
    this.snapshotKey = null;
    this.prevSnapshotNodes = null;
    this.expanded = new Map();
    this.expanding = new Set();
    this.localEdges = [];
    this.consolidatedIds = new Set();
    this.consolidatedAt = 0;
    this.activity = [];
    this.hudInsights = [];
    this.selection = new Set();
    this.selectedId = null;
    this.hoveredId = null;
    this.activeInsight = null;
    this.highlightSet = null;
    this.menu = null;
    this.peekId = null;
    this.detailId = null;
    this.dialog = null;
    this.ai = null;
    this.toast = null;
    this.linkMode = false;
    this.selectMode = false;
    this.error = null;
    this.loading = false;
    this.needsFit = true;
    this.userMovedView = false;
    this.rebuild();
    this.syncStage();
    this.stage?.setInteractionModes({ link: false, select: false });
    this.emit();
    void this.refresh(true);
  }

  /** In the secure lane only secure.* RPCs may run (toast + false otherwise). */
  secureBlocked() {
    if (!this.secure) return false;
    this.showToast('Not available in Secure Mode: the secure graph is read-only here.', 'warn');
    return true;
  }

  absorbSnapshot(res) {
    const now = this.now();
    const items = diffActivity(this.prevSnapshotNodes, res.nodes, now);
    if (items.length) this.activity = [...items, ...this.activity].slice(0, 40);
    this.prevSnapshotNodes = res.nodes;
    if (this.localEdges.length) {
      const have = new Set(res.edges.map((e) => `${e.source}|${e.target}`));
      this.localEdges = this.localEdges.filter(
        (e) => !have.has(`${e.source}|${e.target}`) && !have.has(`${e.target}|${e.source}`) && now - Number(e.weight ?? now) < 120_000,
      );
    }
    // An unchanged poll (the common case every 30 s) skips the layout pass
    // entirely — buildScene is the costly part on Hermes.
    let key = null;
    try {
      key = JSON.stringify([res.nodes, res.edges, res.insights ?? null, res.kinds ?? null]);
    } catch {
      key = null;
    }
    if (key && key === this.snapshotKey && this.snapshot && !this.localEdges.length) {
      this.snapshot = res;
      return;
    }
    this.snapshotKey = key;
    this.snapshot = res;
    const t0 = this.perfNow();
    this.rebuild();
    this.lastRebuildMs = this.perfNow() - t0;
  }

  async refreshConsolidated(force = false) {
    if (!this.request) return;
    const now = this.now();
    if (!force && now - this.consolidatedAt < 60_000) return;
    this.consolidatedAt = now;
    try {
      const ids = new Set();
      for (const q of [
        { fromType: 'task', toType: 'project', edge: 'relates_to', limit: 20_000 },
        { fromType: 'project', toType: 'project', edge: 'relates_to', limit: 20_000 },
      ]) {
        const r = (await this.request('objrel.list', q)) ?? {};
        for (const rel of r.relations ?? []) {
          const m = rel.meta ?? {};
          if (typeof m.convertedFromProjectId === 'string') ids.add(m.convertedFromProjectId);
          if (typeof m.mergedIntoProjectId === 'string' && rel.fromType === 'project') ids.add(rel.fromId);
        }
      }
      const same = ids.size === this.consolidatedIds.size && [...ids].every((x) => this.consolidatedIds.has(x));
      if (!same) {
        this.consolidatedIds = ids;
        this.rebuild();
        this.emit();
      }
    } catch {
      /* relations unavailable — show everything */
    }
  }

  async expandProject(nodeId) {
    if (this.secureBlocked()) return;
    const node = this.snapshot?.nodes.find((n) => n.id === nodeId);
    const projectId = node?.meta?.projectId ?? nodeId.slice(8);
    if (!this.request || this.expanding.has(nodeId)) return;
    this.expanding = new Set(this.expanding).add(nodeId);
    this.emit();
    try {
      const raw = await this.request('graph.global.snapshot', { types: ['project', 'task'], taskProjectIds: [projectId], refresh: true });
      const res = sanitizeSnapshot(raw);
      const nodes = (res?.nodes ?? []).filter((n) => n.kind === 'task');
      const ids = new Set(nodes.map((n) => n.id));
      const edges = (res?.edges ?? []).filter((e) => ids.has(e.target) && e.source === nodeId);
      const next = new Map(this.expanded);
      next.set(nodeId, { nodes, edges });
      this.expanded = next;
      this.rebuild();
    } catch (err) {
      this.error = errText(err);
    } finally {
      const s = new Set(this.expanding);
      s.delete(nodeId);
      this.expanding = s;
      this.emit();
    }
  }

  collapseProject(nodeId) {
    const next = new Map(this.expanded);
    next.delete(nodeId);
    this.expanded = next;
    this.rebuild();
    this.emit();
  }

  /** Snapshot → scene (the web's rebuildSimulation, minus the force worker). */
  rebuild() {
    if (!this.snapshot) {
      this.nodes = [];
      this.links = [];
      this.topoSig = '';
      return;
    }
    const prevPos = new Map();
    for (const n of this.nodes) if (n.x != null && n.y != null) prevPos.set(n.id, { x: n.x, y: n.y, z: n.z });
    const scene = buildScene({
      nodes: this.snapshot.nodes,
      edges: this.snapshot.edges,
      expanded: this.expanded.values(),
      localEdges: this.localEdges,
      enabledKinds: this.enabledKinds,
      enabledHealth: this.enabledHealth,
      search: this.search,
      consolidatedIds: this.projectScope ? new Set() : this.consolidatedIds,
      showConsolidated: this.showConsolidated,
      groupMode: this.groupMode,
      aspect: layoutAspectFor(this.size.w, this.size.h),
    });
    const q = this.search.trim();
    this.scene = scene;
    this.searchMatchIds = scene.searchMatchIds;
    this.grouping = scene.grouping;
    this.v3 = scene.v3;
    this.relations = scene.relations;

    // Same topology: patch metadata only (status colours, rollups, live pulse).
    if (scene.sig === this.topoSig && this.nodes.length === scene.nodes.length) {
      for (const n of scene.nodes) {
        const cur = this.nodeById.get(n.id);
        if (cur) {
          cur.meta = n.meta;
          cur.label = n.label;
          cur.color = n.color;
          cur.health = n.health;
        }
      }
      this.syncStage();
      this.recomputeInsights();
      return;
    }
    const hadLayout = prevPos.size > 0;
    this.topoSig = scene.sig;
    const t = scene.v3.target;
    // Survivors glide from where they were to their new place; new nodes start on target.
    for (const n of scene.nodes) {
      const i = n.index;
      const prev = prevPos.get(n.id);
      if (prev && hadLayout) {
        n.x = prev.x;
        n.y = prev.y;
        n.z = prev.z;
      } else {
        n.x = t[i * 3];
        n.y = t[i * 3 + 2];
        n.z = t[i * 3 + 1];
      }
    }
    if (this.selection.size) {
      const kept = [...this.selection].filter((id) => scene.nodeById.has(id));
      if (kept.length !== this.selection.size) this.selection = new Set(kept);
    }
    this.nodes = scene.nodes;
    this.links = scene.links;
    this.nodeById = scene.nodeById;
    this.adjacency = scene.adjacency;
    this.degree = scene.degree;
    this.focusNbh = { id: null, set: null };
    this.rebuildHighlight();
    const modeSwitch = this.groupChanged;
    this.groupChanged = false;
    this.pendingSearchFit = !!q;
    this.syncStage();
    this.recomputeInsights();
    if (!hadLayout || modeSwitch) {
      if (modeSwitch) this.userMovedView = false;
      this.stage?.resetView(this.anchorIds());
    }
    if (hadLayout) this.glideToTargets(null);
    else this.onLayoutSettled();
  }

  /** Move nodes (all, or `only` indices) onto their v3 targets over ~0.6 s. */
  glideToTargets(only) {
    const t = this.v3?.target;
    if (!t || t.length !== this.nodes.length * 3) return;
    const idx = only ?? this.nodes.map((_, i) => i);
    const from = idx.map((i) => [this.nodes[i].x ?? 0, this.nodes[i].y ?? 0, this.nodes[i].z ?? 0]);
    if (this.glide?.raf) cancelAnimationFrame(this.glide.raf);
    const nodes = this.nodes;
    const done = () => {
      this.glide = null;
      if (!only) this.onLayoutSettled();
    };
    const place = (k) => {
      idx.forEach((i, j) => {
        const n = nodes[i];
        if (!n) return;
        const e = 1 - Math.pow(1 - k, 3);
        n.x = from[j][0] + (t[i * 3] - from[j][0]) * e;
        n.y = from[j][1] + (t[i * 3 + 2] - from[j][1]) * e;
        n.z = from[j][2] + (t[i * 3 + 1] - from[j][2]) * e;
      });
      this.stage?.markPositionsDirty();
    };
    if (this.reducedMotion || typeof requestAnimationFrame !== 'function') {
      place(1);
      done();
      return;
    }
    const start = this.perfNow();
    const ms = 650;
    const step = () => {
      if (nodes !== this.nodes) return;
      const k = Math.min(1, (this.perfNow() - start) / ms);
      place(k);
      if (k < 1) this.glide = { raf: requestAnimationFrame(step) };
      else done();
    };
    this.glide = { raf: requestAnimationFrame(step) };
  }

  onLayoutSettled() {
    this.stage?.markPositionsDirty();
    if (this.pendingSearchFit) {
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
    if (this.pendingLayerFit) {
      const kind = this.pendingLayerFit;
      this.pendingLayerFit = null;
      const ids = this.nodes.filter((n) => n.kind === kind).map((n) => n.id);
      if (ids.length) {
        this.fitTo(ids, 1.6);
        return;
      }
    }
    if (this.needsFit && !this.userMovedView) {
      this.needsFit = false;
      this.resetView();
    }
  }

  recomputeInsights() {
    this.hudInsights = sceneInsights(
      { nodes: this.nodes, links: this.links, adjacency: this.adjacency, nodeById: this.nodeById },
      this.snapshot?.insights,
      this.now(),
      this.dismissed,
    );
  }

  rebuildHighlight() {
    this.highlightSet = highlightSetOf(this.activeInsight, this.nodeById, this.adjacency);
  }

  // ── Filters & settings ─────────────────────────────────────

  setSearch(q) {
    this.search = q;
    this.rebuild();
    this.emit();
  }

  toggleKind(kind) {
    const next = new Set(this.enabledKinds);
    const turningOn = !next.has(kind);
    if (turningOn) next.add(kind);
    else next.delete(kind);
    if (this.projectScope) this.scopeKinds = [...next];
    else this.savePrefs({ kinds: [...next] });
    // A layer the last snapshot didn't collect needs a fetch; turning one off is client-side.
    if (turningOn && !(this.snapshot?.kinds ?? []).includes(kind)) void this.refresh();
    else this.rebuild();
    this.emit();
  }

  toggleHealth(h) {
    const next = new Set(this.enabledHealth);
    if (next.has(h)) next.delete(h);
    else next.add(h);
    this.savePrefs({ health: [...next] });
    this.rebuild();
    this.emit();
  }

  toggleConsolidated() {
    this.showConsolidated = !this.showConsolidated;
    this.rebuild();
    this.emit();
  }

  setGroupMode(mode) {
    if (mode === this.groupMode || !GROUP_IDS.includes(mode)) return;
    if (this.projectScope) this.scopeGroupPicked = true;
    this.savePrefs({ group: mode });
    this.groupChanged = true;
    if (mode !== 'orbit' && mode !== 'brain') this.hudTab = 'groups';
    this.rebuild();
    this.emit();
  }

  setConnectionsMode(m) {
    this.savePrefs({ connections: m });
    this.stage?.setConnectionsMode(m);
    this.emit();
  }

  setHulls(on) {
    this.savePrefs({ hulls: on });
    this.stage?.setHullsVisible(on);
    this.emit();
  }

  setAmbience(on) {
    this.savePrefs({ ambience: on });
    this.stage?.setAmbience(on);
    this.emit();
  }

  setMotionPref(p) {
    this.savePrefs({ motion: p });
    this.stage?.setReducedMotion(this.reducedMotion);
    this.emit();
  }

  setQualityPref(q) {
    this.savePrefs({ quality: q });
    this.stage?.setQualityMode(q);
    this.emit();
  }

  /** Active renderer: the saved choice, or the flat map when this build has no GL. */
  get renderer() {
    return this.can3d === false ? '2d' : this.prefs.renderer;
  }

  setLegendOpen(open) {
    this.savePrefs({ legend: open ? 'open' : 'closed' });
    this.emit();
  }

  /** The web's 2D / 3D toggle (remembered). The screen swaps the stage. */
  setRenderer(mode) {
    const next = mode === '2d' ? '2d' : '3d';
    if (next === '3d' && this.can3d === false) return;
    if (next === this.prefs.renderer) return;
    this.savePrefs({ renderer: next });
    this.userMovedView = false;
    this.haptic?.('selection');
    this.emit();
  }

  /** The web's "Reset layout" (v3 layouts are deterministic: re-frame + re-seat). */
  resetLayout() {
    this.settingsOpen = false;
    this.userMovedView = false;
    this.needsFit = true;
    this.glideToTargets(null);
    this.resetView();
    this.emit();
  }

  toggleHud() {
    this.hudOpen = !this.hudOpen;
    this.emit();
  }

  setHudTab(tab) {
    this.hudTab = tab;
    this.emit();
  }

  setModes(link, select) {
    if (link && this.secureBlocked()) return;
    this.linkMode = link;
    this.selectMode = select;
    this.linkTapFrom = null;
    if (link || select) this.haptic('selection');
    this.stage?.setInteractionModes({ link, select });
    this.emit();
  }

  // ── Camera ─────────────────────────────────────────────────

  resetView() {
    if (this.stage && this.nodes.length) this.stage.resetView(this.anchorIds());
  }

  fitTo(ids, maxK = 1.8) {
    if (!this.stage) return;
    this.stage.fitIds(ids, { fill: maxK >= 1.8 ? 0.8 : 0.62 });
    this.userMovedView = true;
  }

  // ── Selection ──────────────────────────────────────────────

  /** Select a node; on phones the camera always flies to it (web isMobile()). */
  selectNode(id, _fly = true) {
    this.selectedId = id;
    this.focusNbh = { id: null, set: null };
    this.stage?.flyToNode(id);
    this.refocus();
  }

  setSelection(ids) {
    const next = new Set();
    for (const id of ids) if (this.nodeById.has(id)) next.add(id);
    this.selection = next;
    if (next.size === 1) this.selectedId = [...next][0];
    else if (next.size > 1) this.selectedId = null;
    this.syncRings();
    this.refocus();
  }

  toggleSelected(id) {
    const next = new Set(this.selection);
    if (this.selectedId && !next.size) next.add(this.selectedId);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.setSelection(next);
    this.emit();
  }

  clearSelection() {
    this.selection = new Set();
    this.selectedId = null;
    this.peekId = null;
    this.detailId = null;
    this.menu = null;
    this.syncRings();
    this.refocus();
  }

  /** Touch tap = the quick card (the phone's hover): Chat / Select / Focus / Open / Details. */
  peek(id) {
    this.haptic('selection');
    this.peekId = id;
    this.detailId = null;
  }

  openDetails(id) {
    this.peekId = null;
    this.selection = new Set([id]);
    this.selectedId = id;
    this.detailId = id;
    this.syncRings();
    this.refocus();
    this.emit();
  }

  closeCard() {
    this.peekId = null;
    this.detailId = null;
    this.emit();
  }

  actionIds(nodeId) {
    if (nodeId && !this.selection.has(nodeId)) return [nodeId];
    if (this.selection.size) return [...this.selection];
    return nodeId ? [nodeId] : this.selectedId ? [this.selectedId] : [];
  }

  nodesOf(ids) {
    const out = [];
    for (const id of ids) {
      const n = this.nodeById.get(id);
      if (n) out.push(n);
    }
    return out;
  }

  opEdges() {
    return this.links.map((l) => ({ source: l.source.id, target: l.target.id, rel: l.rel, inferred: l.inferred }));
  }

  /** Link mode by taps: first tap = source, second = target. */
  tapLink(id) {
    const from = this.linkTapFrom;
    if (!from || from === id || !this.nodeById.has(from)) {
      this.linkTapFrom = id;
      if (!this.selection.has(id)) this.selection = new Set([id]);
      this.selectedId = id;
      this.peekId = null;
      this.syncRings();
      this.refocus();
      this.haptic('selection');
      const n = this.nodeById.get(id);
      const many = this.selection.size > 1;
      this.showToast(many ? `${this.selection.size} items — now tap the node to link them to.` : `${n ? truncate(n.label, 28) : 'Node'} — now tap the node to link it to.`, 'ok');
      return true;
    }
    this.linkTapFrom = null;
    const target = this.nodeById.get(id);
    if (!target) return true;
    const ids = this.selection.has(from) && this.selection.size > 1 ? [...this.selection] : [from];
    void this.linkTo(ids, target);
    return true;
  }

  selectNeighbours(ids) {
    this.menu = null;
    const next = new Set(ids);
    for (const id of ids) for (const nb of this.adjacency.get(id) ?? []) next.add(nb);
    this.setSelection(next);
    this.emit();
  }

  setInsight(ins) {
    this.activeInsight = ins;
    this.rebuildHighlight();
    if (ins) {
      this.selectedId = null;
      this.peekId = null;
      this.fitTo(ins.nodeIds);
    }
    this.refocus();
    this.emit();
  }

  /** Phone back: close the topmost layer. False when nothing was open. */
  closeTopmost() {
    if (this.menu || this.dialog) {
      this.menu = null;
      this.dialog = null;
    } else if (this.ai) this.ai = null;
    else if (this.settingsOpen) this.settingsOpen = false;
    else if (this.hudOpen) this.hudOpen = false;
    else if (this.linkMode || this.selectMode) return this.setModes(false, false), true;
    else if (this.peekId || this.detailId || this.selection.size || this.selectedId || this.activeInsight) {
      this.clearSelection();
      this.activeInsight = null;
      this.rebuildHighlight();
      this.refocus();
    } else return false;
    this.emit();
    return true;
  }

  // ── Project scope ──────────────────────────────────────────

  /** Only what's connected to one project — `{ id, name?, hops? }`. */
  setProjectScope(sc) {
    if (!sc?.id) return;
    const id = String(sc.id).replace(/^project:/, '');
    const hops = clampScopeHops(sc.hops);
    const cur = this.projectScope;
    if (cur && cur.id === id && cur.hops === hops) return;
    if (!cur) this.scopeKinds = [...new Set([...this.prefs.kinds, 'task', 'run', 'file', 'report', 'note'])];
    this.projectScope = { id, name: sc.name || (cur?.id === id ? cur.name : null), hops };
    this.resetForScope(cur?.id !== id);
    void this.refresh(true);
  }

  setScopeHops(hops) {
    if (!this.projectScope) return;
    this.setProjectScope({ ...this.projectScope, hops });
  }

  /** "Show all": back to the full graph with the user's own layers. */
  clearProjectScope() {
    if (!this.projectScope) return;
    this.projectScope = null;
    this.scopeKinds = null;
    this.resetForScope(true);
    void this.refresh(true);
  }

  resetForScope(clearSelection) {
    this.laneSeq++;
    if (clearSelection) this.scopeGroupPicked = false;
    this.groupChanged = true;
    this.scopeInfo = null;
    this.scopeFocused = null;
    this.snapshotKey = null;
    this.prevSnapshotNodes = null;
    this.expanded = new Map();
    this.localEdges = [];
    if (clearSelection) {
      this.snapshot = null;
      this.selection = new Set();
      this.selectedId = null;
      this.peekId = null;
      this.detailId = null;
      this.needsFit = true;
      this.userMovedView = false;
      this.rebuild();
    }
    this.emit();
  }

  /** Centre + highlight the project once per scope (when the layout settles). */
  queueScopeFocus() {
    const root = this.scopeInfo?.projectNodeId;
    if (!this.projectScope || !root || this.scopeFocused === root) return;
    this.scopeFocused = root;
    if (this.scopeInfo.label && !this.projectScope.name) this.projectScope = { ...this.projectScope, name: this.scopeInfo.label };
    // Flown to when the layout settles (onLayoutSettled consumes pendingDeepFocus);
    // ring + camera only — no card over the phone's stage (web parity).
    this.scopeQuietFocus = true;
    this.pendingDeepFocus = { id: root, family: false };
  }

  /** Chrome model for the scope bar (null when the graph isn't scoped). */
  scopeModel() {
    const sc = this.projectScope;
    if (!sc) return null;
    const info = this.scopeInfo;
    return {
      id: sc.id,
      name: sc.name || info?.label || sc.id,
      hops: sc.hops,
      hopChoices: SCOPE_HOP_CHOICES,
      shown: this.nodes.length,
      total: info?.totalNodes ?? 0,
      countText: info ? `${this.nodes.length.toLocaleString()} of ${info.totalNodes.toLocaleString()} nodes` : `${this.nodes.length} nodes`,
      found: info ? info.found : true,
      sparse: !!info && !this.loading && (!info.found || this.nodes.length <= 2),
      hubs: info?.hubs?.length ?? 0,
    };
  }

  // ── Deep links ─────────────────────────────────────────────

  /** `{ focus, family, layer, group }` from a route (infinibot://knowledge/…). */
  applyDeepLink(link, live = true) {
    if (!link) return;
    if (link.group && GROUP_IDS.includes(link.group)) this.setGroupMode(link.group);
    const layer = link.layer;
    if (layer && KIND_ORDER.includes(layer) && !this.enabledKinds.has(layer)) {
      if (!live || !this.snapshot) this.savePrefs({ kinds: [...this.prefs.kinds, layer] });
      else this.toggleKind(layer);
    }
    let focus = link.focus || null;
    if (!focus && layer) this.pendingLayerFit = layer;
    if (!focus) return;
    if (!focus.includes(':') && this.nodeById.has(`project:${focus}`)) focus = `project:${focus}`;
    if (live && this.nodeById.has(focus) && this.nodes.length) this.focusDeepLinked(focus);
    else this.pendingDeepFocus = { id: focus, family: !!link.family };
  }

  focusDeepLinked(id) {
    this.selection = new Set([id]);
    this.selectNode(id, true);
    this.syncRings();
    const quiet = this.scopeQuietFocus;
    this.scopeQuietFocus = false;
    this.peekId = quiet ? null : id;
    this.emit();
  }

  // ── Drag to re-assign / link ───────────────────────────────

  onDragOverNode(dragged, target) {
    if (!dragged) return;
    if (!target) {
      if (this.dropTarget) {
        this.dropTarget = null;
        this.syncRings();
        this.emit();
      }
      return;
    }
    if (this.dropTarget?.id === target.id) return;
    const ids = this.selection.has(dragged.id) && this.selection.size > 1 ? [...this.selection] : [dragged.id];
    let ok = false;
    let text = '';
    if (target.kind === 'project') {
      if (ids.length > 1) {
        const plan = planBulkReassign(this.nodesOf(ids), target, this.opEdges(), this.nodeById);
        ok = plan.ops.length > 0;
        text = ok ? `Move ${plan.ops.length} to ${target.label}` : (plan.skipped[0]?.reason ?? 'Nothing to move');
      } else {
        const r = planReassign(dragged, target, this.opEdges(), this.nodeById);
        ok = r.ok || r.fallbackLink === true;
        text = r.ok ? r.op.label.replace(/^Moved /, 'Move ').replace(/^Filed /, 'File ').replace(/^Made /, 'Make ') : r.fallbackLink ? `Link to ${target.label}` : r.reason;
      }
    } else {
      if (this.dropTarget) {
        this.dropTarget = null;
        this.syncRings();
      }
      this.emit();
      return;
    }
    this.dropTarget = { id: target.id, ok, armed: false, text, since: this.perfNow() };
    const armedFor = target.id;
    this.later(() => {
      if (this.dropTarget?.id === armedFor && this.dropTarget.ok) {
        this.dropTarget = { ...this.dropTarget, armed: true };
        this.haptic('light');
        this.emit();
      }
    }, DROP_ARM_MS);
    this.syncRings();
    this.emit();
  }

  async finishNodeDrag(n) {
    const dt = this.dropTarget;
    this.dropTarget = null;
    this.dragFrom = null;
    this.syncRings();
    this.emit();
    if (!n || !dt || !dt.ok) return;
    if (!dt.armed && this.perfNow() - dt.since < DROP_ARM_MS) {
      this.showToast('Hold over a project a moment to move it there.', 'warn');
      return;
    }
    const target = this.nodeById.get(dt.id);
    if (!target) return;
    const ids = this.selection.has(n.id) && this.selection.size > 1 ? [...this.selection] : [n.id];
    await this.reassignTo(ids, target);
  }

  beginLinkDrag(n) {
    if (!n) return;
    this.peekId = null;
    const many = this.selection.has(n.id) && this.selection.size > 1;
    this.dragLine = { fromId: n.id, x: 0, y: 0, targetId: null, ok: false, text: many ? `Link ${this.selection.size} items…` : 'Drop on a node to link' };
    const p = this.stage?.screenOf(n.id);
    if (p) {
      this.dragLine.x = p.x;
      this.dragLine.y = p.y;
    }
    this.emit();
  }

  moveLinkDrag(x, y, target) {
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
        dl.text = dl.ok ? `Link ${plan.links.length} → ${target.label}` : (plan.skipped[0]?.reason ?? 'Nothing to link');
      } else {
        const plan = planLink(from, target, this.adjacency);
        dl.ok = plan.ok;
        dl.text = plan.ok ? `Link → ${target.label}` : plan.reason;
      }
      dl.targetId = target.id;
      if (this.dropTarget?.id !== target.id || this.dropTarget.ok !== dl.ok) {
        this.dropTarget = { id: target.id, ok: dl.ok, armed: dl.ok, text: '', since: this.perfNow() };
        this.syncRings();
      }
    } else {
      if (this.dropTarget) {
        this.dropTarget = null;
        this.syncRings();
      }
      dl.targetId = null;
      dl.ok = false;
      dl.text = this.selection.has(dl.fromId) && this.selection.size > 1 ? `Link ${this.selection.size} items…` : 'Drop on a node to link';
    }
    this.dragLine = { ...dl };
    this.emit();
  }

  async endLinkDrag(target) {
    const dl = this.dragLine;
    this.dragLine = null;
    if (this.dropTarget) {
      this.dropTarget = null;
      this.syncRings();
    }
    this.emit();
    if (!dl || !target) return;
    const from = this.nodeById.get(dl.fromId);
    if (!from) return;
    const ids = this.selection.has(from.id) && this.selection.size > 1 ? [...this.selection] : [from.id];
    await this.linkTo(ids, target);
  }

  onLasso(pts, done) {
    this.peekId = null;
    if (!done) {
      this.lassoPts = pts.slice();
      this.emit();
      return;
    }
    this.lassoPts = null;
    this.emit();
    if (pts.length < 6 || !this.stage) return;
    const hit = selectInLasso(pts, this.stage.screenPoints()).filter((id) => baseEmphasis(this.nodeById.get(id), null, null, this) > 0.05);
    if (!hit.length) return;
    const next = new Set(this.selection);
    for (const id of hit) next.add(id);
    this.setSelection(next);
    this.showToast(`${next.size} selected — act on them from the bar below.`, 'ok');
  }

  openMenu(nodeId, x, y) {
    if (this.secureBlocked()) return;
    this.peekId = null;
    if (nodeId && !this.selection.has(nodeId)) {
      this.selection = new Set([nodeId]);
      this.selectedId = nodeId;
      this.syncRings();
      this.refocus();
    }
    if (!nodeId && !this.selection.size) return;
    this.haptic('medium');
    this.menuOpenedAt = this.perfNow();
    // The finger that long-pressed is still down: its lift (and the click a
    // browser synthesises from it) must not press whatever opened under it.
    this.menuLiftPending = true;
    this.menuLiftAt = 0;
    this.menu = { x, y, nodeId };
    this.emit();
  }

  /** The stage's touch ended (KgStageView → screen). */
  onStageRelease() {
    if (this.menuLiftPending) {
      this.menuLiftPending = false;
      this.menuLiftAt = this.perfNow();
    }
  }

  /** True while presses on the just-opened menu must be ignored (web: 450 ms guard). */
  menuGuarded() {
    const now = this.perfNow();
    if (this.menuLiftPending) return true;
    return now - (this.menuOpenedAt || 0) < 450 || now - (this.menuLiftAt || 0) < 350;
  }

  closeMenu() {
    if (this.menuGuarded()) return;
    this.menu = null;
    this.emit();
  }

  // ── Executing plans ────────────────────────────────────────

  showToast(text, tone = 'ok', undo = false) {
    this.toast = { text, tone, undo, at: this.now() };
    const mine = this.toast;
    this.later(() => {
      if (this.toast === mine) {
        this.toast = null;
        this.emit();
      }
    }, undo ? 9000 : 4500);
    this.emit();
  }

  dismissToast() {
    this.toast = null;
    this.emit();
  }

  logActivity(text, nodeId, tone = 'status') {
    const now = this.now();
    this.activity = [{ id: `op:${now}:${nodeId}`, at: now, nodeId, text, tone }, ...this.activity].slice(0, 40);
  }

  async call(c) {
    if (!this.request) throw new Error('Not connected to the gateway.');
    if (this.secure && !String(c?.method || '').startsWith('secure.')) {
      throw new Error('Not available in Secure Mode.');
    }
    return this.request(c.method, c.params);
  }

  async runOps(ops) {
    const done = [];
    const failed = [];
    const queue = [...ops];
    const worker = async () => {
      for (let op = queue.shift(); op; op = queue.shift()) {
        try {
          await this.call(op.call);
          done.push(op);
        } catch (err) {
          failed.push({ op, error: errText(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ops.length) }, worker));
    return { done, failed };
  }

  recordOp(kind, detail) {
    this.lastOp = { kind, at: this.now(), ...detail };
  }

  async runPlan(plan, verb) {
    if (!plan.ops.length) {
      this.showToast(plan.skipped[0]?.reason ?? `Nothing to ${verb.toLowerCase()}.`, 'warn');
      return false;
    }
    this.busy = true;
    this.emit();
    try {
      const { done, failed } = await this.runOps(plan.ops);
      const undo = done.flatMap((o) => o.undo).reverse();
      this.undoStack.push(`${verb} ${done.length}`, undo);
      const skipped = plan.skipped.length ? ` · ${plan.skipped.length} skipped` : '';
      const fail = failed.length ? ` · ${failed.length} failed (${failed[0].error})` : '';
      this.showToast(`${verb} ${done.length}${skipped}${fail}`, failed.length ? 'err' : 'ok', undo.length > 0);
      for (const o of done.slice(0, 6)) this.logActivity(`${verb} · ${o.label}`, o.nodeId);
      this.recordOp(verb, { done: done.length, failed: failed.length, calls: done.map((o) => o.call) });
      this.haptic(failed.length ? 'error' : 'success');
      await this.refresh(true);
      return done.length > 0;
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  get canUndo() {
    return this.undoStack.size > 0;
  }

  async undoLast() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.busy = true;
    this.emit();
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
    this.showToast(failed ? `Undo partly failed (${failed})` : `Undone · ${entry.label}`, failed ? 'err' : 'ok');
    await this.refresh(true);
    await this.reloadExpanded();
  }

  async reloadExpanded(extra = []) {
    const ids = new Set([...this.expanded.keys(), ...extra]);
    for (const id of ids) {
      if (!this.nodeById.has(id) && !this.snapshot?.nodes.some((n) => n.id === id)) continue;
      const next = new Map(this.expanded);
      next.delete(id);
      this.expanded = next;
      await this.expandProject(id);
    }
  }

  async linkTo(ids, target) {
    const { links, skipped } = planBulkLink(this.nodesOf(ids), target, this.adjacency);
    if (!links.length) {
      this.showToast(skipped[0]?.reason ?? 'Nothing to link.', 'warn');
      return;
    }
    this.busy = true;
    this.emit();
    const undo = [];
    let ok = 0;
    let lastErr = '';
    for (const { nodeId, plan } of links) {
      try {
        const rel = await this.call(plan.call);
        undo.push(unlinkCall(plan, rel?.id));
        ok++;
        this.localEdges.push({ source: nodeId, target: target.id, rel: plan.edge.replace(/_/g, ' '), weight: this.now() });
      } catch (err) {
        lastErr = errText(err);
      }
    }
    this.busy = false;
    this.undoStack.push(`Link ${ok}`, undo.reverse());
    this.rebuild();
    await this.refresh(true);
    const confirmed = links.filter(({ nodeId }) =>
      (this.snapshot?.edges ?? []).some((e) => (e.source === nodeId && e.target === target.id) || (e.source === target.id && e.target === nodeId)),
    ).length;
    const first = this.nodeById.get(links[0].nodeId)?.label ?? '';
    const text = ok === 1 ? `Linked ${first} ↔ ${target.label}` : `Linked ${ok} to ${target.label}`;
    this.logActivity(text, target.id, 'new');
    this.recordOp('link', { ok, confirmed, target: target.id, from: links.map((l) => l.nodeId), relationIds: undo.map((u) => u.params.id) });
    this.haptic(lastErr ? 'error' : 'success');
    this.showToast(
      `${text}${confirmed === ok ? ' · saved' : ` · ${confirmed}/${ok} visible after refresh`}${lastErr ? ` · ${links.length - ok} failed` : ''}${skipped.length ? ` · ${skipped.length} skipped` : ''}`,
      lastErr ? 'err' : 'ok',
      ok > 0,
    );
  }

  async reassignTo(ids, target) {
    const nodes = this.nodesOf(ids);
    const reassignable = nodes.filter((n) => canReassign(n.kind) && !isDocumentNode(n));
    const linkOnly = nodes.filter((n) => !canReassign(n.kind) || isDocumentNode(n));
    const plan = planBulkReassign(reassignable, target, this.opEdges(), this.nodeById);
    const fromProjects = new Set();
    for (const op of plan.ops) {
      const n = this.nodeById.get(op.nodeId);
      const pid = n?.kind === 'task' ? n.meta?.projectId : undefined;
      if (pid) fromProjects.add(`project:${pid}`);
    }
    if (plan.ops.length) {
      for (const op of plan.ops) {
        for (const layer of this.expanded.values()) {
          for (const e of layer.edges) if (e.target === op.nodeId && e.rel === 'contains') e.source = target.id;
        }
      }
      const ok = await this.runPlan(plan, 'Moved');
      if (ok) {
        await this.reloadExpanded(target.kind === 'project' && plan.ops.some((o) => o.nodeId.startsWith('task:')) ? [target.id, ...fromProjects] : []);
        await this.verifyReassign(plan.ops, target);
      }
    } else if (!linkOnly.length) {
      this.showToast(plan.skipped[0]?.reason ?? 'Nothing to move.', 'warn');
    }
    if (linkOnly.length) await this.linkTo(linkOnly.map((n) => n.id), target);
  }

  async verifyReassign(ops, target) {
    if (!this.request) return;
    const pid = storeIdOf(target);
    let verified = 0;
    try {
      const taskIds = ops.filter((o) => o.nodeId.startsWith('task:')).map((o) => o.nodeId);
      if (taskIds.length) {
        const raw = await this.request('graph.global.snapshot', { types: ['project', 'task'], taskProjectIds: [pid], refresh: true });
        const snap = sanitizeSnapshot(raw);
        const inTarget = new Set((snap?.nodes ?? []).filter((n) => n.kind === 'task' && n.meta?.projectId === pid).map((n) => n.id));
        verified += taskIds.filter((id) => inTarget.has(id)).length;
      }
      for (const o of ops.filter((x) => !x.nodeId.startsWith('task:'))) {
        const n = this.nodeById.get(o.nodeId);
        if (!n) continue;
        if (n.kind === 'project' && n.meta?.parentProjectId === pid) verified++;
        else if (n.kind === 'note' && (this.snapshot?.edges ?? []).some((e) => e.source === n.id && e.target === target.id)) verified++;
      }
    } catch {
      /* best effort */
    }
    this.recordOp('reassign', { target: target.id, moved: ops.map((o) => o.nodeId), verified });
    if (verified) this.showToast(`Moved ${ops.length} to ${target.label} · verified ${verified}/${ops.length}`, 'ok', true);
  }

  // ── Bulk actions (bar / menu) ──────────────────────────────

  async bulkStatus(ids, status) {
    this.menu = null;
    await this.runPlan(planBulkStatus(this.nodesOf(ids), status), 'Updated');
  }

  openTag(ids) {
    this.menu = null;
    this.dialog = { type: 'tag', ids, value: '' };
    this.emit();
  }

  async bulkTag(ids, tag) {
    this.dialog = null;
    await this.runPlan(planBulkTag(this.nodesOf(ids), tag), 'Tagged');
  }

  openDelete(ids) {
    this.menu = null;
    const plan = planBulkDelete(this.nodesOf(ids));
    if (!plan.ops.length) {
      this.showToast(plan.skipped[0]?.reason ?? 'Nothing deletable selected.', 'warn');
      return;
    }
    this.dialog = { type: 'delete', plan };
    this.emit();
  }

  async confirmDelete(plan) {
    this.dialog = null;
    const ok = await this.runPlan(plan, 'Deleted');
    if (ok) {
      this.clearSelection();
      this.emit();
    }
  }

  openPicker(purpose, ids) {
    this.menu = null;
    this.dialog = { type: 'pick', purpose, ids, query: '' };
    this.emit();
  }

  /** Picker candidates (same pool and order as the web dialog). */
  pickList(d) {
    const q = (d.query || '').trim().toLowerCase();
    const selected = new Set(d.ids);
    const pool = this.nodes.filter((n) => !selected.has(n.id) && (d.purpose === 'move' ? n.kind === 'project' : n.kind !== 'run' && n.kind !== 'session' && n.kind !== 'row'));
    return (q ? pool.filter((n) => n.label.toLowerCase().includes(q)) : pool)
      .sort((a, b) => Number(b.anchor) - Number(a.anchor) || a.label.localeCompare(b.label))
      .slice(0, 60);
  }

  async pickTarget(purpose, ids, targetId) {
    this.dialog = null;
    this.emit();
    const target = this.nodeById.get(targetId);
    if (!target) return;
    if (purpose === 'move') await this.reassignTo(ids, target);
    else await this.linkTo(ids, target);
  }

  updateDialog(patch) {
    if (!this.dialog) return;
    this.dialog = { ...this.dialog, ...patch };
    this.emit();
  }

  closeDialog() {
    if (this.dialog?.running) return;
    this.dialog = null;
    this.emit();
  }

  // ── Consolidate (notes / tasks) ────────────────────────────

  async openConsolidate(ids) {
    this.menu = null;
    const nodes = this.nodesOf(ids);
    const kinds = new Set(nodes.map((n) => n.kind));
    if (nodes.length < 2 || kinds.size !== 1 || !(kinds.has('note') || kinds.has('task'))) {
      this.showToast('Direct merge works on notes or tasks of one kind — asking the assistant for a plan instead.', 'warn');
      this.openAi('consolidate', ids);
      return;
    }
    const d = { type: 'consolidate', ids, loading: true, plan: null, removeMode: kinds.has('note') ? 'delete' : 'archive', title: '', body: '', bodies: new Map() };
    this.dialog = d;
    this.emit();
    try {
      for (const n of nodes) {
        const id = storeIdOf(n);
        if (n.kind === 'note') {
          const r = await this.call({ method: 'notes.get', params: { id } });
          d.bodies.set(n.id, String(r?.body ?? r?.content ?? ''));
        } else {
          const r = await this.call({ method: 'kanban.tasks.content.getMarkdown', params: { taskId: id } });
          d.bodies.set(n.id, String(r?.markdown ?? ''));
        }
      }
      this.replanConsolidate(d, {});
    } catch (err) {
      this.dialog = { ...d, loading: false, error: errText(err) };
      this.emit();
    }
  }

  replanConsolidate(d, opts) {
    const nodes = this.nodesOf(d.ids);
    const items = nodes.map((n) => ({ node: n, body: d.bodies.get(n.id) ?? '', degree: this.adjacency.get(n.id)?.size ?? 0 }));
    const primaryId = opts.primaryId ?? d.primaryId;
    const removeMode = opts.removeMode ?? d.removeMode;
    const res = planConsolidate(items, this.opEdges(), this.nodeById, { primaryId, removeMode, ...(opts.keepText ? { title: d.title, body: d.body } : {}) });
    if (!res.ok) this.dialog = { ...d, loading: false, plan: null, error: res.reason };
    else this.dialog = { ...d, loading: false, plan: res, primaryId: res.primaryId, removeMode, title: res.title, body: res.body, error: undefined };
    this.emit();
  }

  async confirmConsolidate(d) {
    const nodes = this.nodesOf(d.ids);
    const items = nodes.map((n) => ({ node: n, body: d.bodies.get(n.id) ?? '', degree: this.adjacency.get(n.id)?.size ?? 0 }));
    const res = planConsolidate(items, this.opEdges(), this.nodeById, { primaryId: d.primaryId, removeMode: d.removeMode, title: d.title, body: d.body });
    if (!res.ok) return;
    this.dialog = null;
    this.busy = true;
    this.emit();
    let failed = 0;
    let firstErr = '';
    for (const c of res.calls) {
      try {
        await this.call(c);
      } catch (err) {
        failed++;
        firstErr ||= errText(err);
        // Never delete duplicates if the merged write itself failed.
        if (c === res.calls[0]) break;
      }
    }
    this.busy = false;
    const primary = this.nodeById.get(res.primaryId);
    this.recordOp('consolidate', { primary: res.primaryId, merged: res.mergedIds, calls: res.calls.length, failed });
    this.logActivity(`Merged ${res.mergedIds.length} into ${primary?.label ?? 'one'}`, res.primaryId, 'new');
    this.showToast(failed ? `Merge stopped: ${firstErr}` : `Merged ${res.mergedIds.length + 1} into “${res.title}”`, failed ? 'err' : 'ok');
    this.setSelection([res.primaryId]);
    await this.refresh(true);
  }

  // ── Consolidate sub-projects ───────────────────────────────

  openSubConsolidate(parentId) {
    this.menu = null;
    const parent = this.nodeById.get(parentId);
    if (!parent || parent.kind !== 'project') return;
    const subs = subProjectsOf(parent, this.nodes, this.opEdges());
    if (!subs.length) {
      this.showToast(`${parent.label} has no sub-projects to consolidate.`, 'warn');
      return;
    }
    const clusters = clusterSubProjects(parent, subs, (id) => this.adjacency.get(id)?.size ?? 0);
    const inCluster = new Set(clusters.flatMap((c) => c.ids));
    const others = subs.filter((x) => !inCluster.has(x.id)).sort((a, b) => a.label.localeCompare(b.label)).map((x) => x.id);
    this.projectRows = null;
    this.dialog = {
      type: 'subs',
      parentId,
      clusters,
      others,
      checked: new Set(inCluster),
      keepers: new Map(),
      mode: 'tasks',
      taskMode: 'move',
      details: new Map(),
      loading: 0,
      batch: this.now().toString(36),
      plan: null,
      showOthers: clusters.length === 0,
    };
    this.emit();
    void this.loadSubDetails([...inCluster]);
  }

  subsDialog(parentId) {
    const d = this.dialog;
    return d?.type === 'subs' && (!parentId || d.parentId === parentId) ? d : null;
  }

  async loadSubDetails(ids) {
    const d0 = this.subsDialog();
    if (!d0) return;
    const parentId = d0.parentId;
    const need = ids.filter((id) => !d0.details.has(id) && this.nodeById.has(id));
    if (!need.length) {
      this.replanSubs();
      return;
    }
    this.dialog = { ...d0, loading: d0.loading + need.length };
    this.emit();
    try {
      if (!this.projectRows) {
        const raw = await this.call({ method: 'kanban.projects.list', params: { includeArchived: true } });
        const list = Array.isArray(raw) ? raw : (raw?.projects ?? []);
        this.projectRows = new Map(list.filter((r) => typeof r?.id === 'string').map((r) => [r.id, r]));
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
          this.call({ method: 'objrel.list', params: { type: 'project', id: sid } }).catch(() => null),
          this.call({ method: 'kanban.tasks.list', params: { projectId: sid } }).catch(() => null),
          this.call({ method: 'kanban.projects.content.getMarkdown', params: { projectId: sid } }).catch(() => null),
        ]);
        const taskList = Array.isArray(tasks) ? tasks : (tasks?.tasks ?? []);
        const notes = [];
        for (const r of this.relations.get(id) ?? []) {
          const o = this.nodeById.get(r.other);
          if (o?.kind === 'note' && r.rel === 'about' && !isDocumentNode(o)) notes.push({ id: storeIdOf(o), label: o.label });
        }
        const row = this.projectRows?.get(sid);
        const detail = {
          node,
          id: sid,
          description: typeof row?.description === 'string' ? row.description : undefined,
          status: typeof row?.status === 'string' ? row.status : String(node.meta?.status ?? ''),
          priority: typeof row?.priority === 'string' ? row.priority : undefined,
          archived: row?.archived === true,
          markdown: typeof md?.markdown === 'string' ? md.markdown : '',
          tasks: taskList
            .filter((t) => typeof t?.id === 'string' && (t.projectId == null || t.projectId === sid))
            .map((t) => ({ id: t.id, title: String(t.title ?? t.name ?? 'Untitled'), status: typeof t.status === 'string' ? t.status : undefined })),
          relations: (rels?.relations ?? []).filter((r) => typeof r?.id === 'string'),
          notes,
        };
        const cur = this.subsDialog(parentId);
        if (!cur) return;
        cur.details.set(id, detail);
        this.dialog = { ...cur, loading: Math.max(0, cur.loading - 1) };
        this.emit();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, need.length) }, worker));
    this.replanSubs();
  }

  replanSubs(patch = {}) {
    const d0 = this.subsDialog();
    if (!d0) return;
    const d = { ...d0, ...patch };
    const parent = this.nodeById.get(d.parentId);
    if (!parent) return;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const ready = [...d.checked].filter((id) => d.details.has(id));
    let plan;
    if (d.mode === 'tasks') {
      plan = planConvertToTasks(parent, ready.map((id) => d.details.get(id)), { taskMode: d.taskMode, batchId: d.batch, today });
    } else {
      const groups = [];
      for (const c of d.clusters) {
        const keeperId = d.keepers.get(c.key) ?? c.keeperId;
        const keeper = d.details.get(keeperId);
        const others = c.ids.filter((id) => id !== keeperId && d.checked.has(id) && d.details.has(id)).map((id) => d.details.get(id));
        if (keeper && others.length) groups.push({ keeper, others });
      }
      plan = planMergeDuplicates(parent, groups, { batchId: d.batch, today });
    }
    const report = describePlan(plan, d.clusters, (id) => this.nodeById.get(id)?.label ?? id);
    this.dialog = { ...d, plan, report, error: undefined };
    this.emit();
  }

  toggleSub(id, on) {
    const d = this.subsDialog();
    if (!d) return;
    const checked = new Set(d.checked);
    if (on) checked.add(id);
    else checked.delete(id);
    this.dialog = { ...d, checked };
    if (on && !d.details.has(id)) void this.loadSubDetails([id]);
    else this.replanSubs();
  }

  setSubKeeper(clusterKey, id) {
    const d = this.subsDialog();
    if (!d) return;
    const keepers = new Map(d.keepers);
    keepers.set(clusterKey, id);
    this.replanSubs({ keepers });
  }

  async applySubs() {
    const d = this.subsDialog();
    const plan = d?.plan;
    if (!d || !plan || !plan.steps.length || d.running) return;
    const total = plan.steps.length;
    this.dialog = { ...d, running: { done: 0, total } };
    this.busy = true;
    this.emit();
    const refs = new Map();
    const executed = [];
    const failures = [];
    let archivePending = 0;
    let aborted = null;
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const call = resolveRefs(step.call, refs);
      if (call === UNRESOLVED) {
        failures.push({ step, error: 'skipped — an earlier step for this sub-project failed' });
        continue;
      }
      try {
        const res = await this.call(call);
        executed.push(step);
        if (step.capture) refs.set(step.capture, captureOf(step, call, res));
        if (call.method === 'kanban.projects.update' && res && typeof res === 'object' && (res.localOnly || res.notionSyncFailed)) archivePending++;
      } catch (err) {
        if (step.critical) {
          aborted = `${step.label}: ${errText(err)}`;
          break;
        }
        failures.push({ step, error: errText(err) });
      }
      if (i % 3 === 0) {
        const cur = this.subsDialog(d.parentId);
        if (cur) {
          this.dialog = { ...cur, running: { done: i + 1, total } };
          this.emit();
        }
      }
    }
    const undo = buildUndo(executed, refs);
    if (aborted) {
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
      if (cur) this.dialog = { ...cur, running: undefined, error: `Stopped and rolled back${undoFailed ? ` (${undoFailed} undo steps failed)` : ''} — ${aborted}` };
      this.recordOp('consolidate-subs', { aborted, executed: executed.length, rolledBack: undo.length, undoFailed });
      this.emit();
      return;
    }
    const n = plan.items.filter((it) => it.action !== 'keep').length;
    this.undoStack.push(`${plan.mode === 'tasks' ? 'Converted' : 'Merged'} ${n} sub-project${n === 1 ? '' : 's'}`, undo);
    this.recordOp('consolidate-subs', { mode: plan.mode, parent: plan.parentLabel, items: n, calls: executed.length, failed: failures.length, archivePending, undoCalls: undo.length });
    this.logActivity(`${plan.mode === 'tasks' ? 'Converted' : 'Merged'} ${n} sub-projects of ${plan.parentLabel}`, plan.parentId, 'new');
    this.busy = false;
    this.dialog = null;
    const pending = archivePending ? ` · archive flag pending a gateway restart for ${archivePending}` : '';
    const fail = failures.length ? ` · ${failures.length} step${failures.length === 1 ? '' : 's'} failed (${failures[0].error})` : '';
    this.showToast(
      `${plan.mode === 'tasks' ? `Converted ${n} sub-projects to tasks under ${plan.parentLabel}` : `Merged ${n} duplicates`}${pending}${fail}`,
      failures.length ? 'warn' : 'ok',
      undo.length > 0,
    );
    await this.refresh(true);
    await this.refreshConsolidated(true);
  }

  async copySubsReport(d) {
    try {
      await this.opts.copy?.(d.report ?? '');
      this.showToast('Dry-run report copied', 'ok');
    } catch {
      this.showToast('Clipboard unavailable', 'warn');
    }
  }

  // ── AI + agents ────────────────────────────────────────────

  /** Opens the AI drawer (KgAiDrawer runs the doc_agent session). */
  openAi(intent, ids) {
    this.menu = null;
    if (this.secureBlocked()) return;
    const nodes = this.nodesOf(ids);
    if (!nodes.length) return;
    this.ai = {
      intent,
      title: nodes.length === 1 ? nodes[0].label : `${nodes.length} items`,
      context: buildAiContext(nodes, this.opEdges(), this.nodeById),
      count: nodes.length,
      nodeIds: nodes.map((n) => n.id),
      seq: (this.ai?.seq ?? 0) + 1,
    };
    this.peekId = null;
    this.emit();
  }

  closeAi() {
    this.ai = null;
    this.emit();
  }

  openRelated(ids) {
    this.menu = null;
    const items = suggestLinks(this.nodes, this.opEdges(), { focus: new Set(ids), limit: 10 });
    this.dialog = { type: 'related', ids, items };
    this.emit();
  }

  async linkSuggestion(s) {
    const a = this.nodeById.get(s.a);
    const b = this.nodeById.get(s.b);
    if (!a || !b) return;
    await this.linkTo([a.id], b);
    if (this.dialog?.type === 'related') {
      this.dialog = { ...this.dialog, items: this.dialog.items.filter((x) => x !== s) };
      this.emit();
    }
  }

  openSpawn(ids) {
    this.menu = null;
    if (this.secureBlocked()) return;
    const nodes = this.nodesOf(ids);
    if (!nodes.length) return;
    const goal =
      nodes.length === 1 && nodes[0].kind === 'project'
        ? `Review the project "${nodes[0].label}": check its open, blocked and overdue tasks, unblock what you can, and report back with what changed.`
        : '';
    this.dialog = { type: 'spawn', ids, goal, agentId: '' };
    this.emit();
  }

  spawnAgents() {
    return this.nodes.filter((n) => n.kind === 'agent').map((a) => ({ id: String(a.meta?.agentId ?? storeIdOf(a)), label: a.label }));
  }

  async confirmSpawn(d) {
    const nodes = this.nodesOf(d.ids);
    const task = spawnTask(buildAiContext(nodes, this.opEdges(), this.nodeById, 5000), nodes.length, d.goal);
    this.dialog = { ...d, busy: true };
    this.emit();
    try {
      const res = await this.call({
        method: 'sessions.spawn',
        params: { task, label: `Graph · ${nodes.length === 1 ? nodes[0].label : `${nodes.length} items`}`.slice(0, 80), ...(d.agentId ? { agentId: d.agentId } : {}) },
      });
      this.dialog = null;
      const run = String(res?.runId ?? res?.childSessionKey ?? res?.sessionKey ?? '');
      this.recordOp('spawn', { run, ids: d.ids });
      this.logActivity(`Agent spawned on ${nodes.length === 1 ? nodes[0].label : `${nodes.length} items`}`, nodes[0].id, 'live');
      this.showToast(`Agent started${run ? ` · ${run.slice(0, 18)}` : ''} — watch it under Agents.`, 'ok');
    } catch (err) {
      this.dialog = { ...d, busy: false };
      this.showToast(`Couldn't start the agent: ${errText(err)}`, 'err');
    }
  }

  // ── Signals ────────────────────────────────────────────────

  async insightAction(ins, action) {
    switch (action) {
      case 'focus':
        this.setInsight(this.activeInsight?.id === ins.id ? null : ins);
        break;
      case 'select':
        this.setSelection(ins.nodeIds);
        this.emit();
        break;
      case 'consolidate':
        await this.openConsolidate(ins.nodeIds);
        break;
      case 'subs':
        if (ins.nodeIds[0]) this.openSubConsolidate(ins.nodeIds[0]);
        break;
      case 'link': {
        if (!ins.pair) break;
        const target = this.nodeById.get(ins.pair[1]);
        if (target) await this.linkTo([ins.pair[0]], target);
        this.dismissInsight(ins);
        break;
      }
      case 'suggest':
        this.openRelated(ins.nodeIds.slice(0, 40));
        break;
      case 'chat':
        this.openAi('summarize', ins.nodeIds.slice(0, 40));
        break;
      case 'spawn':
        this.openSpawn(ins.nodeIds.slice(0, 20));
        break;
      case 'dismiss':
        this.dismissInsight(ins);
        break;
      default:
        break;
    }
  }

  dismissInsight(ins) {
    this.dismissed.add(ins.id);
    this.savePrefs({});
    this.hudInsights = this.hudInsights.filter((i) => i.id !== ins.id);
    if (this.activeInsight?.id === ins.id) this.setInsight(null);
    this.emit();
  }

  // ── Open ───────────────────────────────────────────────────

  openNode(n) {
    this.haptic('light');
    this.opts.openNode?.(n);
  }

  // ── HUD numbers ────────────────────────────────────────────

  hudStats() {
    const projects = this.nodes.filter((n) => n.kind === 'project');
    const count = (h) => projects.filter((p) => p.health === h).length;
    return {
      active: count('active') + count('review'),
      blocked: count('blocked'),
      atRisk: count('at_risk'),
      stale: projects.filter((p) => p.meta?.stale === true).length,
      live: this.nodes.filter((n) => isLiveNode(n)).length,
      high: this.hudInsights.filter((i) => i.severity === 'high').length,
    };
  }

  /** Legend counts (status chips + layer chips), as the web legend computes them. */
  legend() {
    const stats = this.snapshot?.typeStats ?? {};
    const hidden = this.snapshot?.hidden ?? {};
    const healthCounts = {};
    let taskTotal = 0;
    for (const n of this.snapshot?.nodes ?? []) {
      if (n.kind !== 'project') continue;
      const h = core.healthOf(n.meta);
      healthCounts[h] = (healthCounts[h] ?? 0) + 1;
      taskTotal += Number(n.meta?.tasks ?? 0);
    }
    const HEAVY = new Set(['task', 'database', 'row', 'session']);
    const kinds = KIND_ORDER.filter((k) => (stats[k] ?? 0) > 0 || HEAVY.has(k)).map((k) => {
      const on = this.enabledKinds.has(k);
      let count = stats[k] ?? 0;
      if (k === 'task' && !on) count = taskTotal ? taskTotal.toLocaleString() : '—';
      return { kind: k, on, count, hidden: hidden[k] ?? 0 };
    });
    return {
      health: HEALTH_ORDER.map((h) => ({ health: h, on: this.enabledHealth.has(h), count: healthCounts[h] ?? 0 })),
      kinds,
      consolidated: this.consolidatedIds.size,
    };
  }
}

export { BULK_STATUSES, GROUP_MODES };
