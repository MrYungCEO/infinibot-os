/**
 * Pure model helpers for `<infinibot-knowledge-graph>` — kind/status
 * palettes, persisted filter defaults, orbit radii, deep links and
 * screen-space label placement. No DOM/Lit imports beyond what the
 * navigation helpers need, so it runs under a plain node vitest.
 */

import { pathForEntity, pathForTab, type Tab } from "../navigation";
import { slugify } from "../lib/slugs";

export type GraphNodeKind =
  | "project"
  | "client"
  | "opportunity"
  | "product"
  | "issue"
  | "decision"
  | "person"
  | "note"
  | "report"
  | "content"
  | "file"
  | "topic"
  | "agent"
  | "run"
  | "task"
  | "session"
  | "database"
  | "row"
  | "skill"
  | "node"
  | "user";

export type ProjectHealth = "active" | "review" | "blocked" | "at_risk" | "backlog" | "done";

/** Legend/chip order: anchors first, heavy layers last. */
export const KIND_ORDER: GraphNodeKind[] = [
  "project",
  "client",
  "opportunity",
  "product",
  "issue",
  "decision",
  "person",
  "note",
  "report",
  "content",
  "file",
  "topic",
  "agent",
  "run",
  "task",
  "database",
  "row",
  "session",
  "skill",
  "node",
  "user",
];

/** Kind colours. Projects are painted by STATUS instead (see HEALTH_COLOR). */
export const KIND_PALETTE: Record<GraphNodeKind, string> = {
  project: "#f5c542",
  client: "#f1e4c3",
  opportunity: "#f0abfc",
  product: "#5eead4",
  issue: "#fb7185",
  decision: "#c4b5fd",
  person: "#fde68a",
  note: "#7aa7e8",
  report: "#93c5fd",
  content: "#fdba74",
  file: "#5ec8d8",
  topic: "#b49cff",
  agent: "#f472b6",
  run: "#4ade80",
  task: "#86efac",
  session: "#fb923c",
  database: "#a78bfa",
  row: "#c084fc",
  skill: "#34d399",
  node: "#f87171",
  user: "#fbbf24",
};

export const KIND_LABEL: Record<GraphNodeKind, string> = {
  project: "Projects",
  client: "Clients",
  opportunity: "Opportunities",
  product: "Products",
  issue: "Issues",
  decision: "Decisions",
  person: "People",
  note: "Notes",
  report: "Reports",
  content: "Content",
  file: "Files",
  topic: "Topics",
  agent: "Agents",
  run: "Agent runs",
  task: "Tasks",
  session: "Sessions",
  database: "Databases",
  row: "Rows",
  skill: "Skills",
  node: "Federation",
  user: "Users",
};

export const KIND_SINGULAR: Record<GraphNodeKind, string> = {
  project: "Project",
  client: "Client",
  opportunity: "Opportunity",
  product: "Product",
  issue: "Issue",
  decision: "Decision",
  person: "Person",
  note: "Note",
  report: "Report",
  content: "Content page",
  file: "File",
  topic: "Topic",
  agent: "Agent",
  run: "Agent run",
  task: "Task",
  session: "Session",
  database: "Database",
  row: "Row",
  skill: "Skill",
  node: "Federation node",
  user: "User",
};

export const HEALTH_ORDER: ProjectHealth[] = [
  "active",
  "review",
  "at_risk",
  "blocked",
  "backlog",
  "done",
];

export const HEALTH_COLOR: Record<ProjectHealth, string> = {
  active: "#3ddc97",
  review: "#a78bfa",
  at_risk: "#f5a524",
  blocked: "#f0525f",
  backlog: "#8a8474",
  done: "#56636b",
};

export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  active: "Active",
  review: "In review",
  at_risk: "At risk",
  blocked: "Blocked",
  backlog: "Backlog",
  done: "Done",
};

/** Anchors are always labelled + drawn at full strength. */
export const ANCHOR_KINDS = new Set<GraphNodeKind>(["project", "client"]);

/** Matches the gateway's DEFAULT_KINDS — tasks/rows/sessions stay off. */
export const DEFAULT_KINDS: GraphNodeKind[] = [
  "project",
  "client",
  "opportunity",
  "product",
  "issue",
  "decision",
  "person",
  "note",
  "report",
  "content",
  "file",
  "agent",
  "run",
];

export const DEFAULT_HEALTH: ProjectHealth[] = ["active", "review", "at_risk", "blocked", "backlog"];

const KINDS_KEY = "infinibot.kg.kinds.v2";
const HEALTH_KEY = "infinibot.kg.health.v1";

function readSet<T extends string>(key: string, allowed: readonly T[], fallback: T[]): Set<T> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return new Set(fallback);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set(fallback);
    return new Set(parsed.filter((v): v is T => (allowed as readonly string[]).includes(v)));
  } catch {
    return new Set(fallback);
  }
}

function writeSet(key: string, set: Set<string>): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify([...set]));
  } catch {
    /* storage unavailable / quota — the toggle still works for this session */
  }
}

/**
 * Kinds the user's stored filter set already "knew about". A kind introduced
 * later that is on by default (e.g. "file") is switched on ONCE for stored
 * sets that predate it; afterwards the user's choice sticks.
 */
const KINDS_SEEN_KEY = "infinibot.kg.kinds.seen.v1";
/** Kinds added after KINDS_KEY v2 shipped — absent from legacy "seen" lists. */
const LATER_KINDS: readonly GraphNodeKind[] = ["file", "topic"];

export function loadEnabledKinds(): Set<GraphNodeKind> {
  const set = readSet(KINDS_KEY, KIND_ORDER, DEFAULT_KINDS);
  try {
    const ls = globalThis.localStorage;
    if (!ls || !ls.getItem(KINDS_KEY)) return set;
    const rawSeen = ls.getItem(KINDS_SEEN_KEY);
    const seenArr = rawSeen ? (JSON.parse(rawSeen) as unknown) : null;
    const seen = new Set<string>(
      Array.isArray(seenArr) ? seenArr.filter((v): v is string => typeof v === "string") : KIND_ORDER.filter((k) => !LATER_KINDS.includes(k)),
    );
    let changed = false;
    for (const k of DEFAULT_KINDS) {
      if (!seen.has(k) && !set.has(k)) {
        set.add(k);
        changed = true;
      }
    }
    if (changed) writeSet(KINDS_KEY, set);
    if (changed || KIND_ORDER.some((k) => !seen.has(k))) writeSet(KINDS_SEEN_KEY, new Set(KIND_ORDER));
  } catch {
    /* storage unavailable — keep the parsed set */
  }
  return set;
}
export const saveEnabledKinds = (s: Set<GraphNodeKind>) => {
  writeSet(KINDS_KEY, s);
  writeSet(KINDS_SEEN_KEY, new Set(KIND_ORDER));
};
export const loadEnabledHealth = () => readSet(HEALTH_KEY, HEALTH_ORDER, DEFAULT_HEALTH);
export const saveEnabledHealth = (s: Set<ProjectHealth>) => writeSet(HEALTH_KEY, s);

export function healthOf(meta: Record<string, unknown> | undefined): ProjectHealth {
  const h = meta?.health;
  return typeof h === "string" && (HEALTH_ORDER as string[]).includes(h)
    ? (h as ProjectHealth)
    : "backlog";
}

/** Fill colour for a node — projects by status, everything else by kind. */
export function colorFor(kind: GraphNodeKind, meta?: Record<string, unknown>): string {
  // Repos mode colours files by language (normal snapshots never set this).
  if (typeof meta?.repoColor === "string") return meta.repoColor;
  if (kind === "project") return HEALTH_COLOR[healthOf(meta)];
  return KIND_PALETTE[kind] ?? "#9ca3af";
}

/** Base world radius: projects big (task-count scaled), clients hub-sized, rest small. */
export function radiusFor(kind: GraphNodeKind, weight: number | undefined): number {
  const w = Math.max(0, Math.min(1, weight ?? 0.5));
  // Projects are hubs: noticeably larger than everything else.
  if (kind === "project") return 15 + w * 15;
  if (kind === "client") return 9 + w * 6;
  if (kind === "task" || kind === "row") return 3.2;
  return 4.2 + w * 2;
}

/**
 * Node shape ids — mirrors glow3d `NODE_SHAPES` (kept as plain numbers so this
 * module stays three-free for node tests; a test asserts they match).
 */
export const SHAPE = {
  orb: 0,
  gem: 1,
  block: 2,
  pages: 3,
  report: 4,
  media: 5,
  agent: 6,
  person: 7,
  chip: 8,
  neuron: 9,
  lens: 10,
} as const;
export type NodeShape = (typeof SHAPE)[keyof typeof SHAPE];

/**
 * Shape per data type — iconic forms that say what a node IS:
 *
 *   kind                          shape    form
 *   project / opportunity / product gem     faceted crystal (main projects = large gem + status ring)
 *   task / row / issue            block    checkbox-like key block
 *   note / file                   pages    stack of page cards
 *   topic                         neuron   (shared with decision) extracted entity
 *   report                        report   page slab with a bar chart
 *   content (media, pages)        media    film / frame tile with a play mark
 *   agent / run / skill / session agent    orb with an orbiting ring
 *   person / client / user        person   person capsule (body + head)
 *   node / database               chip     hexagonal system chip
 *   decision                      neuron   neuron star (memory / knowledge)
 *   (research — reserved)         lens     magnifier
 */
export const KIND_SHAPE: Record<GraphNodeKind, NodeShape> = {
  project: SHAPE.gem,
  opportunity: SHAPE.gem,
  product: SHAPE.gem,
  task: SHAPE.block,
  row: SHAPE.block,
  issue: SHAPE.block,
  note: SHAPE.pages,
  report: SHAPE.report,
  content: SHAPE.media,
  file: SHAPE.pages,
  topic: SHAPE.neuron,
  agent: SHAPE.agent,
  run: SHAPE.agent,
  skill: SHAPE.agent,
  session: SHAPE.agent,
  person: SHAPE.person,
  client: SHAPE.person,
  user: SHAPE.person,
  node: SHAPE.chip,
  database: SHAPE.chip,
  decision: SHAPE.neuron,
};

export function shapeFor(kind: GraphNodeKind): NodeShape {
  return KIND_SHAPE[kind] ?? SHAPE.orb;
}

/** Main (top-level) project radius range — ≥ 2.6× a sub-project. */
export const MAIN_PROJECT_R = 15;
export const SUB_PROJECT_R = 6;

/**
 * Size by HIERARCHY depth, not by degree: a top-level project is always
 * much larger than its sub-projects, which are larger than leaves (tasks,
 * notes, reports, agents…). `depth` = project nesting (0 = top level).
 */
export function hierarchyRadius(kind: GraphNodeKind, depth: number, weight: number | undefined): number {
  const w = Math.max(0, Math.min(1, weight ?? 0.5));
  if (kind === "project") {
    if (depth <= 0) return MAIN_PROJECT_R + w * 2; // 15–17 → 2.5–2.8× a sub-project
    return depth === 1 ? SUB_PROJECT_R : SUB_PROJECT_R * 0.82;
  }
  if (kind === "client") return 8 + w * 2;
  if (kind === "task" || kind === "row") return 3;
  if (kind === "agent") return 4.6;
  if (kind === "report") return 4.2;
  return 3.6 + w * 0.8;
}

// ── Size by connections ─────────────────────────────────────────────

/** Degree growth: f(d) = 1 + DEGREE_K·√d, capped at DEGREE_MAX (sub-linear, steeper than log so the busiest hubs stand out). */
export const DEGREE_K = 0.16;
export const DEGREE_MAX = 3;
/** Extra multiplier for parent projects (projects with sub-projects or tasks). */
export const HUB_MULT = 1.15;
/** Absolute cap so the busiest hub never swallows its region. */
export const MAX_NODE_R = 56;
/** A parent is always at least this much larger than its largest child. */
export const PARENT_OVER_CHILD = 1.12;

/** Monotonic, sub-linear degree scale: 1 at d=0, ×1.22 at 1, ×1.66 at 7, ×2 at 22, capped at 2.6. */
export function degreeScale(degree: number): number {
  const d = Math.max(0, Number.isFinite(degree) ? degree : 0);
  return Math.min(DEGREE_MAX, 1 + DEGREE_K * Math.sqrt(d));
}

export interface SizeIn {
  kind: GraphNodeKind;
  /** Project nesting depth (0 = top level). */
  depth: number;
  weight: number | undefined;
  degree: number;
  /** Parent project: has sub-projects or tasks. */
  hub: boolean;
}

/**
 * Node size = max(hierarchy floor, base(type) × f(degree) × hub), clamped.
 * The hierarchy floor (`hierarchyRadius`) keeps main projects > sub-projects
 * > leaves; the degree term makes busy items grow so the largest hubs read at
 * a glance. Parent ≥ children is enforced afterwards by `enforceParentSize`.
 */
export function nodeRadius(s: SizeIn): number {
  const floor = hierarchyRadius(s.kind, s.depth, s.weight);
  const scaled = floor * degreeScale(s.degree) * (s.hub && s.kind === "project" ? HUB_MULT : 1);
  const cap = s.kind === "project" ? MAX_NODE_R : Math.max(floor, Math.min(MAX_NODE_R * 0.5, floor * DEGREE_MAX));
  return Math.max(floor, Math.min(cap, scaled));
}

/**
 * Lift every parent above its children: r(parent) ≥ PARENT_OVER_CHILD ×
 * max r(child), walking deepest-first so chains propagate. `parentOf[i]` is
 * the parent index or -1. Mutates and returns `radii`.
 */
export function enforceParentSize(radii: number[], parentOf: ArrayLike<number>, depth: ArrayLike<number>): number[] {
  const order = radii.map((_, i) => i).sort((a, b) => depth[b] - depth[a]);
  for (const i of order) {
    const p = parentOf[i];
    if (p == null || p < 0 || p === i) continue;
    const need = Math.min(MAX_NODE_R * 1.25, radii[i] * PARENT_OVER_CHILD);
    if (radii[p] < need) radii[p] = need;
  }
  return radii;
}

/** Label scale for a node radius: 1× up to a quiet project (r 16), rising to 1.65× at the largest hub (MAX_NODE_R). */
export function labelScaleFor(r: number): number {
  return Math.max(1, Math.min(1.65, 1 + ((r - 16) / (MAX_NODE_R - 16)) * 0.65));
}

export interface Orbits {
  open: number;
  backlog: number;
  done: number;
  stray: number;
}

/**
 * Concentric orbit radii: open work in the core, backlog in a belt around
 * it, finished work on the rim; unconnected strays outermost. Scales with
 * how many projects share each ring so bands don't overpack.
 */
export function computeOrbits(counts: { open: number; backlog: number; done: number }): Orbits {
  const open = 110 + 26 * Math.sqrt(counts.open);
  const backlog = open + 170 + 10 * Math.sqrt(counts.backlog);
  const done = backlog + 130 + 7 * Math.sqrt(counts.done);
  return { open, backlog, done, stray: done + 100 };
}

export function orbitFor(health: ProjectHealth, o: Orbits): number {
  if (health === "done") return o.done;
  if (health === "backlog") return o.backlog;
  return o.open;
}

export type OpenTarget =
  | { type: "path"; path: string }
  | { type: "agent-focus"; detail: Record<string, unknown> };

const TAB_FOR_KIND: Partial<Record<GraphNodeKind, Tab>> = {
  opportunity: "opportunities",
  decision: "decisions",
  person: "people",
  product: "products",
  issue: "issues",
  report: "reports",
  content: "content-pages",
  file: "files",
  agent: "agents",
  skill: "skills",
  node: "federation",
  session: "sessions",
};

/** Where the "Open" action on a node leads, or null when there's no page. */
export function openTargetFor(
  node: { id: string; kind: GraphNodeKind; label: string; meta?: Record<string, unknown> },
  basePath = "",
): OpenTarget | null {
  const rawId = node.id.slice(node.id.indexOf(":") + 1);
  switch (node.kind) {
    case "project":
      return {
        type: "path",
        path: pathForEntity({ kind: "project", slug: slugify(node.label, rawId), basePath }),
      };
    case "client":
    case "note":
    case "task":
      return {
        type: "path",
        path: pathForEntity({ kind: node.kind, slug: slugify(node.label, rawId), basePath }),
      };
    case "database":
      return { type: "path", path: pathForEntity({ kind: "database", slug: rawId, basePath }) };
    case "run":
      return { type: "agent-focus", detail: { runId: String(node.meta?.runId ?? rawId) } };
    default: {
      const tab = TAB_FOR_KIND[node.kind];
      return tab ? { type: "path", path: pathForTab(tab, basePath) } : null;
    }
  }
}

export function relativeAge(ms: number, now = Date.now()): string {
  if (!ms) return "never";
  const d = Math.max(0, now - ms);
  const min = Math.floor(d / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** Deterministic 0..1 hash of a node id (stable depth/phase across refreshes). */
export function hash01(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}


export interface LabelCandidate {
  /** Screen-space anchor (label starts to the right of the node). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Greedy, priority-ordered label placement: a candidate is accepted only
 * if its box doesn't overlap an already-placed one. Uses a uniform grid so
 * each test only touches nearby boxes. Returns the accepted indices.
 */
export function placeLabels(cands: LabelCandidate[], cell = 48, budget = 400): number[] {
  const grid = new Map<string, number[]>();
  const placed: LabelCandidate[] = [];
  const out: number[] = [];
  for (let i = 0; i < cands.length && out.length < budget; i++) {
    const c = cands[i];
    const x0 = Math.floor(c.x / cell);
    const x1 = Math.floor((c.x + c.width) / cell);
    const y0 = Math.floor((c.y - c.height / 2) / cell);
    const y1 = Math.floor((c.y + c.height / 2) / cell);
    let clash = false;
    for (let gx = x0; gx <= x1 && !clash; gx++) {
      for (let gy = y0; gy <= y1 && !clash; gy++) {
        for (const pi of grid.get(`${gx},${gy}`) ?? []) {
          const p = placed[pi];
          if (
            c.x < p.x + p.width &&
            c.x + c.width > p.x &&
            Math.abs(c.y - p.y) < (c.height + p.height) / 2
          ) {
            clash = true;
            break;
          }
        }
      }
    }
    if (clash) continue;
    const pi = placed.push(c) - 1;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = `${gx},${gy}`;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push(pi);
      }
    }
    out.push(i);
  }
  return out;
}

// ── Persistent layout ─────────────────────────────────────────────

const POS_KEY = "infinibot.kg.pos.v2";
/** Flat (x/y only) layouts from before the 3D galaxy — ignored and dropped,
 * so old saves can't pin every hub back onto one plane. */
const LEGACY_POS_KEYS = ["infinibot.kg.pos.v1"];
const POS_MAX = 4000;

/**
 * Layout positions relative to the layout centre, keyed by node id, so a
 * reload (or a resized window) restores the map instead of re-laying it
 * out from a spiral. Anchors are kept first when the cap bites.
 */
export function savePositions(
  nodes: Array<{ id: string; x?: number; y?: number; z?: number; anchor?: boolean }>,
  center: { cx: number; cy: number },
): void {
  try {
    const ordered = [...nodes].sort((a, b) => Number(!!b.anchor) - Number(!!a.anchor));
    const out: Record<string, [number, number, number]> = {};
    let n = 0;
    for (const nd of ordered) {
      if (n >= POS_MAX) break;
      if (nd.x == null || nd.y == null || !Number.isFinite(nd.x) || !Number.isFinite(nd.y)) continue;
      const z = nd.z != null && Number.isFinite(nd.z) ? Math.round(nd.z) : 0;
      out[nd.id] = [Math.round(nd.x - center.cx), Math.round(nd.y - center.cy), z];
      n++;
    }
    globalThis.localStorage?.setItem(POS_KEY, JSON.stringify(out));
  } catch {
    /* quota / no storage — layout just isn't restored */
  }
}

export function loadPositions(): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  try {
    for (const k of LEGACY_POS_KEYS) globalThis.localStorage?.removeItem(k);
    const raw = globalThis.localStorage?.getItem(POS_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return out;
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length === 3 && v.every((c) => Number.isFinite(c))) {
        out.set(id, [Number(v[0]), Number(v[1]), Number(v[2])]);
      }
    }
  } catch {
    /* corrupt entry — ignore */
  }
  return out;
}

/** Small persisted UI preferences (group mode, motion, quality, HUD state). */
export function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = globalThis.localStorage?.getItem(`infinibot.kg.${key}`);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(`infinibot.kg.${key}`, value);
  } catch {
    /* no storage */
  }
}
