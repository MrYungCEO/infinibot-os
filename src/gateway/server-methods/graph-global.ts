/**
 * Global Knowledge Graph aggregator.
 *
 * Walks the major InfiniBot data sources (kanban projects, CRM clients,
 * business objects, notes, agent runs, federation nodes, agents,
 * databases) and emits a normalized `{ nodes, edges, typeStats }` payload
 * the knowledge-graph view consumes.
 *
 * Projects are the primary anchors: each project node carries task
 * rollups (total/done/in-progress/blocked/overdue) computed with ONE
 * aggregate query, so the heavy `task` kind is off by default and only
 * collected when explicitly requested (optionally scoped to specific
 * projects via `taskProjectIds` for lazy expansion).
 *
 * Optimised for repeated polling: results are cached for `CACHE_TTL_MS`
 * per parameter set. Every source is optional — a missing/empty store
 * just contributes nothing.
 */

import { isBusinessAgencyActive } from "../../business-agency/runtime.js";
import { resolve } from "node:path";
import os from "node:os";

import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { getFederationHub } from "../../federation/index.js";
import {
  buildNameIndex,
  computeInsights,
  deriveProjectHealth,
  findMentions,
  type GraphInsight,
  type NameEntry,
} from "./graph-global-derive.js";
import {
  parseScopeParams,
  scopeSnapshotToProject,
  type ProjectScopeInfo,
  type ProjectScopeOpts,
} from "./graph-project-scope.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";

const CACHE_TTL_MS = 5_000;
/** In-progress tasks touched within this window count as live work. */
const HOT_WINDOW_MS = 30 * 60 * 1000;
/** Ended agent runs stay on the graph this long. */
const RECENT_RUN_MS = 60 * 60 * 1000;
/** Hard cap on task nodes when the full task layer is requested. */
const DEFAULT_MAX_TASKS = 3_000;
const DEFAULT_MAX_TASKS_PER_PROJECT = 250;
/** Chars of a note body scanned for project/client mentions. */
const NOTE_SCAN_CHARS = 1_500;

export type GraphNodeKind =
  | "project"
  | "task"
  | "note"
  | "agent"
  | "session"
  | "database"
  | "row"
  | "skill"
  | "node"
  | "user"
  | "client"
  | "opportunity"
  | "product"
  | "content"
  | "issue"
  | "decision"
  | "person"
  | "report"
  | "run"
  // Ideas (src/ideas). Collected only when asked for (`types: [..., "idea"]`),
  // so graph views that don't know the kind yet never receive it.
  | "idea"
  // Uploaded workspace files (local auto-OCR registry) and the entities /
  // topics their OCR + vision pass extracted.
  | "file"
  | "topic";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Free-form metadata for tooltips / detail pane. */
  meta?: Record<string, unknown>;
  /** 0..1 weighting used by the layout for sizing + force strength. */
  weight?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Relationship label (e.g. "contains", "client of", "mentions"). */
  rel: string;
  weight?: number;
  /** True when the edge was inferred (name mention) rather than stored. */
  inferred?: boolean;
}

export interface GraphSnapshot {
  generatedAt: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  typeStats: Record<GraphNodeKind, number>;
  /** Computed insights (stale/blocked/orphans/…) — additive. */
  insights?: GraphInsight[];
  /** Counts of entities that exist but were left out of `nodes`. */
  hidden?: Partial<Record<GraphNodeKind, number>>;
  /** Kinds actually collected for this snapshot. */
  kinds?: GraphNodeKind[];
  /** Set when the snapshot was cut down to one project (`projectId`). */
  scope?: ProjectScopeInfo;
}

type CachedSnapshot = {
  key: string;
  at: number;
  snapshot: GraphSnapshot;
};

let cached: CachedSnapshot | null = null;

export const ALL_KINDS: GraphNodeKind[] = [
  "project",
  "task",
  "note",
  "agent",
  "session",
  "database",
  "row",
  "skill",
  "node",
  "user",
  "client",
  "opportunity",
  "product",
  "content",
  "issue",
  "decision",
  "person",
  "report",
  "run",
  "idea",
  "file",
  "topic",
];

/** Collected when the caller doesn't pass `types` — heavy layers stay off. */
export const DEFAULT_KINDS: GraphNodeKind[] = [
  "project",
  "client",
  "opportunity",
  "product",
  "issue",
  "decision",
  "person",
  "note",
  "agent",
  "run",
  "report",
  "content",
  "file",
];

/** Kinds that only earn a place on the graph when connected to something. */
const PRUNE_IF_ISOLATED = new Set<GraphNodeKind>(["agent", "report"]);

/** CRM pipeline states that don't justify a node unless something links to them. */
const DORMANT_CLIENT_STATES = new Set(["cold", "cold archive", "archive", "archived", "lost"]);

function nid(kind: GraphNodeKind, raw: string): string {
  return `${kind}:${raw}`;
}

function makeStats(): Record<GraphNodeKind, number> {
  return ALL_KINDS.reduce(
    (acc, k) => {
      acc[k] = 0;
      return acc;
    },
    {} as Record<GraphNodeKind, number>,
  );
}

export type AggregateOpts = {
  kinds: Set<GraphNodeKind>;
  maxRowsPerDatabase: number;
  /** When set, only these projects' tasks are collected (lazy expansion). */
  taskProjectIds?: string[];
  maxTasks?: number;
  /** Include every CRM client, not just active/linked ones. */
  allClients?: boolean;
  /** Override the state dir (tests). */
  stateDir?: string;
  now?: number;
};

/** Mutable accumulator shared by every collector. */
class GraphBuilder {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  readonly stats = makeStats();
  readonly hidden: Partial<Record<GraphNodeKind, number>> = {};
  private readonly byId = new Map<string, GraphNode>();
  private readonly edgeKeys = new Set<string>();

  constructor(
    readonly stateDir: string,
    readonly opts: AggregateOpts,
    readonly now: number,
  ) {}

  has(kind: GraphNodeKind): boolean {
    return this.opts.kinds.has(kind);
  }

  add(node: GraphNode): void {
    if (this.byId.has(node.id)) return;
    this.byId.set(node.id, node);
    this.nodes.push(node);
    this.stats[node.kind] += 1;
  }

  get(id: string): GraphNode | undefined {
    return this.byId.get(id);
  }

  /** Add an edge once per (source, target, rel); self-loops are ignored. */
  link(source: string, target: string, rel: string, extra?: Partial<GraphEdge>): void {
    if (source === target) return;
    const key = `${source}|${target}|${rel}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({ source, target, rel, ...extra });
  }

  hide(kind: GraphNodeKind, n = 1): void {
    this.hidden[kind] = (this.hidden[kind] ?? 0) + n;
  }
}

function warnSkip(slice: string, err: unknown): void {
  // Stores are optional — if one isn't available we just skip its slice.
  // eslint-disable-next-line no-console
  console.warn(`[graph] ${slice} slice skipped: ${err instanceof Error ? err.message : err}`);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Project-name index shared by the mention passes (built once per snapshot). */
type Indexes = {
  projects: NameEntry[];
  clients: NameEntry[];
  projectByName: Map<string, string>;
  agentByKey: Map<string, string>;
};

type KanbanRollup = {
  total: number;
  done: number;
  inProgress: number;
  review: number;
  blocked: number;
  overdue: number;
  hot: number;
  lastActivityAt: number;
};
type KanbanProjectRow = {
  id: string;
  name?: string;
  status?: string;
  priority?: string;
  dueDate?: string;
  parentProjectId?: string | null;
  progress?: number;
  updatedAt?: number;
};
type KanbanTaskRow = {
  id: string;
  title?: string;
  status?: string;
  projectId?: string | null;
  assignedAgent?: string | null;
  dueDate?: string;
  updatedAt?: number;
  tags?: string[];
  done?: boolean;
  autonomousStatus?: string;
};
interface KanbanSource {
  projects(): Promise<KanbanProjectRow[]>;
  rollups(today: string, hotSince: number): Map<string, KanbanRollup>;
  recentTasks(limit: number, projectId?: string): KanbanTaskRow[];
  /** False when task tags aren't stored (local-first role tables). */
  hasTags: boolean;
}

/**
 * Where projects/tasks live. With Notion sync on, the KanbanStore mirror
 * (kanban.db) is authoritative and every write updates it. Local-first
 * installs write the role databases instead (src/databases/kanban-store-ops),
 * so read those — otherwise projects created or re-assigned on a Notion-less
 * install never reach the graph. Rows only present in the legacy kanban.db
 * are kept so older local data isn't hidden.
 */
async function resolveKanbanSource(stateDir: string): Promise<KanbanSource> {
  const { getKanbanStore } = await import("../../tasks/store.js");
  const store = getKanbanStore(stateDir);
  const legacy: KanbanSource = {
    projects: async () => (await store.getProjects()) as unknown as KanbanProjectRow[],
    rollups: (today, hotSince) =>
      store.getProjectTaskRollups(today, hotSince) as Map<string, KanbanRollup>,
    recentTasks: (limit, pid) => store.getRecentTasks(limit, pid) as unknown as KanbanTaskRow[],
    hasTags: true,
  };
  let notionOn = true;
  try {
    const { isNotionEnabled } = await import("../../databases/notion-config.js");
    notionOn = isNotionEnabled();
  } catch {
    /* config unreadable — keep the mirror path */
  }
  if (notionOn) return legacy;
  let ops: typeof import("../../databases/kanban-store-ops.js");
  try {
    ops = await import("../../databases/kanban-store-ops.js");
  } catch {
    return legacy;
  }
  const localTasks = (): KanbanTaskRow[] => {
    try {
      return ops.listTasks() as unknown as KanbanTaskRow[];
    } catch {
      return [];
    }
  };
  let taskCache: KanbanTaskRow[] | null = null;
  const tasks = () => (taskCache ??= localTasks());
  return {
    projects: async () => {
      let local: KanbanProjectRow[] = [];
      try {
        local = ops.listProjects() as unknown as KanbanProjectRow[];
      } catch {
        /* role table missing */
      }
      return [...local, ...legacyOnly(await legacy.projects(), local)];
    },
    rollups: (today, hotSince) => {
      const out = new Map<string, KanbanRollup>();
      for (const t of tasks()) {
        if (!t.projectId) continue;
        const r =
          out.get(t.projectId) ??
          out
            .set(t.projectId, {
              total: 0,
              done: 0,
              inProgress: 0,
              review: 0,
              blocked: 0,
              overdue: 0,
              hot: 0,
              lastActivityAt: 0,
            })
            .get(t.projectId)!;
        const done = t.status === "done" || t.done === true;
        const upd = Number(t.updatedAt ?? 0);
        r.total++;
        if (done) r.done++;
        if (t.status === "in_progress") {
          r.inProgress++;
          if (upd >= hotSince) r.hot++;
        }
        if (t.status === "review") r.review++;
        if (t.autonomousStatus === "blocked" || t.autonomousStatus === "failed") r.blocked++;
        if (t.dueDate && String(t.dueDate).slice(0, 10) < today && !done) r.overdue++;
        r.lastActivityAt = Math.max(r.lastActivityAt, upd);
      }
      // Projects whose tasks only exist in the legacy store keep their SQL rollup.
      for (const [pid, r] of legacy.rollups(today, hotSince)) if (!out.has(pid)) out.set(pid, r);
      return out;
    },
    recentTasks: (limit, pid) => {
      const local = tasks()
        .filter((t) => !pid || t.projectId === pid)
        .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
        .slice(0, limit);
      if (local.length >= limit) return local;
      return [...local, ...legacyOnly(legacy.recentTasks(limit - local.length, pid), tasks())];
    },
    hasTags: false,
  };
}

function legacyOnly<T extends { id: string }>(legacy: T[], local: T[]): T[] {
  const have = new Set(local.map((x) => x.id));
  return legacy.filter((x) => !have.has(x.id));
}

async function collectKanban(g: GraphBuilder): Promise<void> {
  if (!g.has("project") && !g.has("task")) return;
  try {
    const source = await resolveKanbanSource(g.stateDir);
    const today = new Date(g.now).toISOString().slice(0, 10);
    const rollups = source.rollups(today, g.now - HOT_WINDOW_MS);
    if (g.has("project")) {
      const projects = await source.projects();
      for (const p of projects) {
        const r = rollups.get(p.id);
        const total = r?.total ?? 0;
        const done = r?.done ?? 0;
        const lastActivityAt = Math.max(p.updatedAt ?? 0, r?.lastActivityAt ?? 0);
        const progress =
          total > 0
            ? done / total
            : typeof p.progress === "number"
              ? Math.max(0, Math.min(1, p.progress > 1 ? p.progress / 100 : p.progress))
              : 0;
        g.add({
          id: nid("project", p.id),
          kind: "project",
          label: p.name ?? p.id,
          weight: 0.55 + 0.45 * Math.min(1, Math.log10(total + 1) / 4),
          meta: {
            projectId: p.id,
            status: p.status,
            priority: p.priority,
            dueDate: p.dueDate,
            parentProjectId: p.parentProjectId ?? undefined,
            tasks: total,
            done,
            inProgress: r?.inProgress ?? 0,
            review: r?.review ?? 0,
            blocked: r?.blocked ?? 0,
            overdue: r?.overdue ?? 0,
            hotTasks: r?.hot ?? 0,
            progress,
            lastActivityAt,
          },
        });
      }
      for (const p of projects) {
        if (p.parentProjectId) {
          g.link(nid("project", p.id), nid("project", p.parentProjectId), "sub-project of");
        }
      }
    }
    if (g.has("task")) {
      let totalTasks = 0;
      for (const r of rollups.values()) totalTasks += r.total;
      const scoped = g.opts.taskProjectIds?.filter(Boolean) ?? [];
      const tasks = scoped.length
        ? scoped.flatMap((pid) => source.recentTasks(DEFAULT_MAX_TASKS_PER_PROJECT, pid))
        : source.recentTasks(g.opts.maxTasks ?? DEFAULT_MAX_TASKS);
      for (const t of tasks) {
        g.add({
          id: nid("task", t.id),
          kind: "task",
          label: t.title ?? t.id,
          weight: 0.3,
          meta: {
            status: t.status,
            projectId: t.projectId,
            assignedAgent: t.assignedAgent ?? undefined,
            // Tags travel with the node so bulk tagging can merge, not clobber
            // (omitted where the store doesn't keep tags, so the UI skips them).
            ...(source.hasTags ? { tags: Array.isArray(t.tags) ? t.tags : [] } : {}),
            dueDate: t.dueDate,
            updatedAt: t.updatedAt,
          },
        });
        if (t.projectId) g.link(nid("project", t.projectId), nid("task", t.id), "contains");
      }
      if (!scoped.length && totalTasks > tasks.length) g.hide("task", totalTasks - tasks.length);
    }
  } catch (err) {
    warnSkip("kanban", err);
  }
}

/** Kinds whose data belongs to the Business & Agency plugin (off → not graphed). */
const BUSINESS_AGENCY_KINDS: ReadonlySet<GraphNodeKind> = new Set([
  "client",
  "opportunity",
  "person",
  "decision",
] as GraphNodeKind[]);

async function collectClients(g: GraphBuilder): Promise<void> {
  if (!g.has("client") || !isBusinessAgencyActive()) return;
  try {
    const { getAgencyOperationsStore } = await import("../../agency-operations/store.js");
    const store = getAgencyOperationsStore(g.stateDir) as unknown as {
      db?: { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } };
      listClients?: (agencyId?: string) => Array<Record<string, unknown>>;
    };
    // One lean SELECT across every agency (the CRM can hold thousands of
    // rows; hydrating each row's JSON blob is wasted work here).
    const rows = store.db
      ? store.db
          .prepare(
            "SELECT id, agency_id AS agencyId, name, status, pipeline_status AS pipelineStatus, updated_at AS updatedAt FROM clients",
          )
          .all()
      : (store.listClients?.() ?? []);
    for (const c of rows) {
      const id = str(c.id);
      if (!id) continue;
      const pipeline = String(c.pipelineStatus ?? c.status ?? "").toLowerCase();
      g.add({
        id: nid("client", id),
        kind: "client",
        label: str(c.name) ?? id,
        weight: 0.6,
        meta: {
          clientId: id,
          agencyId: c.agencyId,
          status: c.status,
          pipelineStatus: pipeline,
          dormant: DORMANT_CLIENT_STATES.has(pipeline.replace(/[^a-z]+/g, " ").trim()),
          updatedAt: c.updatedAt,
        },
      });
    }
  } catch (err) {
    warnSkip("clients", err);
  }
}

type BusinessRecord = Record<string, unknown> & { id: string };

async function loadList(
  modPath: string,
  getter: string,
  stateDir: string,
): Promise<BusinessRecord[]> {
  const mod = (await import(modPath)) as Record<
    string,
    (dir: string) => { list: (p: Record<string, unknown>) => BusinessRecord[] }
  >;
  return mod[getter]?.(stateDir)?.list({ limit: 5_000 }) ?? [];
}

/** Common business-object FK fields → graph edges. */
function linkCommonFields(g: GraphBuilder, from: string, r: BusinessRecord): void {
  const pid = str(r.projectId);
  const cid = str(r.clientId);
  const oid = str(r.opportunityId);
  const prid = str(r.productId);
  if (pid) g.link(from, nid("project", pid), "for project");
  if (cid) g.link(from, nid("client", cid), "for client");
  if (oid) g.link(from, nid("opportunity", oid), "for opportunity");
  if (prid) g.link(from, nid("product", prid), "about product");
}

async function collectBusinessObjects(g: GraphBuilder): Promise<void> {
  const specs: Array<{
    kind: GraphNodeKind;
    mod: string;
    getter: string;
    label: (r: BusinessRecord) => string | undefined;
    status: (r: BusinessRecord) => unknown;
  }> = [
    {
      kind: "opportunity",
      mod: "../../opportunity/store.js",
      getter: "getOpportunityStore",
      label: (r) => str(r.name),
      status: (r) => r.stage ?? r.status,
    },
    {
      kind: "product",
      mod: "../../product/store.js",
      getter: "getProductStore",
      label: (r) => str(r.name),
      status: (r) => r.status ?? r.validationStage,
    },
    {
      kind: "person",
      mod: "../../person/store.js",
      getter: "getPersonStore",
      label: (r) => str(r.name),
      status: (r) => r.status,
    },
    {
      kind: "decision",
      mod: "../../decision/store.js",
      getter: "getDecisionStore",
      label: (r) => str(r.title),
      status: (r) => r.status,
    },
    {
      kind: "issue",
      mod: "../../issues/store.js",
      getter: "getIssuesStore",
      label: (r) => str(r.title),
      status: (r) => r.status,
    },
  ];
  const businessOn = isBusinessAgencyActive();
  for (const spec of specs) {
    if (!g.has(spec.kind)) continue;
    if (!businessOn && BUSINESS_AGENCY_KINDS.has(spec.kind)) continue;
    try {
      const list = await loadList(spec.mod, spec.getter, g.stateDir);
      for (const r of list) {
        if (!r?.id) continue;
        const id = nid(spec.kind, r.id);
        g.add({
          id,
          kind: spec.kind,
          label: spec.label(r) ?? r.id,
          weight: 0.45,
          meta: {
            status: spec.status(r),
            priority: r.priority ?? r.severity,
            blocked: r.blocked === true ? true : undefined,
            value: r.estimatedValue ?? r.financialValue ?? r.financialImpact,
            relatedProject: str(r.relatedProject),
            updatedAt: r.updatedAt,
          },
        });
        linkCommonFields(g, id, r);
        if (spec.kind === "decision" && str(r.issueId)) {
          g.link(id, nid("issue", str(r.issueId)!), "resolves");
        }
        if (spec.kind === "product" && str(r.parentProductId)) {
          g.link(id, nid("product", str(r.parentProductId)!), "variant of");
        }
      }
    } catch (err) {
      warnSkip(spec.kind, err);
    }
  }
}

const RELATION_KIND: Record<string, GraphNodeKind> = {
  project: "project",
  task: "task",
  client: "client",
  opportunity: "opportunity",
  product: "product",
  person: "person",
  decision: "decision",
  issue: "issue",
  note: "note",
  report: "report",
  // Graph-made links (knowledge-graph Ctrl+drag) can join any kind with a
  // stable id, so read those back too.
  agent: "agent",
  content: "content",
  idea: "idea",
};

function humaniseEdge(edge: string): string {
  const e = edge.replace(/_/g, " ").trim();
  // "client has opportunity" → "has opportunity"; keep verbs short.
  return e.replace(/^(client|project|opportunity|commitment|product|person|decision|issue)\s+/, "");
}

/** Ideas (src/ideas) and their links to projects / tasks / documents. */
async function collectIdeas(g: GraphBuilder): Promise<void> {
  if (!g.has("idea")) return;
  try {
    const { getIdeaStore } = await import("../../ideas/store.js");
    for (const i of getIdeaStore(g.stateDir).list({ limit: 1000 })) {
      const id = nid("idea", i.id);
      g.add({
        id,
        kind: "idea",
        label: i.title,
        weight: i.status === "promoted" ? 0.3 : 0.4,
        meta: {
          status: i.status,
          tags: i.tags.length ? i.tags : undefined,
          updatedAt: i.updatedAt,
          source: i.source,
        },
      });
      const became = i.promotedTo;
      for (const pid of i.projectIds)
        g.link(
          id,
          nid("project", pid),
          became?.kind === "project" && became.id === pid ? "became" : "about",
        );
      for (const tid of i.taskIds)
        g.link(
          id,
          nid("task", tid),
          became?.kind === "task" && became.id === tid ? "became" : "about",
        );
      for (const did of i.docIds)
        g.link(
          id,
          nid("note", did),
          became?.kind === "document" && became.id === did ? "became" : "about",
        );
    }
  } catch (err) {
    warnSkip("ideas", err);
  }
}

/** Typed edges from the business-object relation store (src/relations). */
async function collectRelations(g: GraphBuilder): Promise<void> {
  try {
    const { getRelationsStore } = await import("../../relations/store.js");
    const rels = getRelationsStore(g.stateDir).list({ limit: 20_000 });
    for (const r of rels) {
      const fk = RELATION_KIND[String(r.fromType)];
      const tk = RELATION_KIND[String(r.toType)];
      if (!fk || !tk) continue;
      g.link(nid(fk, r.fromId), nid(tk, r.toId), humaniseEdge(String(r.edge)) || "relates to");
    }
  } catch (err) {
    warnSkip("relations", err);
  }
}

type NoteLike = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  projectId?: string;
  updatedAt?: unknown;
};

async function loadNotes(stateDir: string): Promise<NoteLike[]> {
  try {
    const bridge = await import("../../databases/system-role-bridge.js");
    if (bridge.getRoleMode("notes").mode === "database") {
      return bridge.listRowsForRole("notes").map((row) => {
        const v = (row.values ?? {}) as Record<string, unknown>;
        return {
          id: row.id,
          title: row.title || "(untitled)",
          body: typeof row.body === "string" ? row.body : "",
          tags: Array.isArray(v.tags)
            ? v.tags.filter((t): t is string => typeof t === "string")
            : [],
          projectId: str(v.projectId),
          updatedAt: row.updatedAt,
        };
      });
    }
  } catch {
    /* fall through to the file store */
  }
  const { NoteStore } = await import("../../notes/store.js");
  const store = new NoteStore(stateDir);
  return store.list({}).map((li) => {
    const full = store.get(li.id);
    return {
      id: li.id,
      title: li.name ?? li.id,
      body: full?.body ?? "",
      tags: li.tags ?? [],
      projectId: li.projectId,
      updatedAt: li.updatedAt,
    };
  });
}

async function collectNotes(g: GraphBuilder, idx: Indexes): Promise<void> {
  if (!g.has("note")) return;
  try {
    const notes = await loadNotes(g.stateDir);
    const byTitle = new Map<string, string>();
    for (const n of notes) byTitle.set(n.title.trim().toLowerCase(), n.id);
    for (const n of notes) {
      const id = nid("note", n.id);
      g.add({
        id,
        kind: "note",
        label: n.title,
        weight: 0.35,
        meta: { updatedAt: n.updatedAt, tags: n.tags.length ? n.tags : undefined },
      });
      if (n.projectId) g.link(id, nid("project", n.projectId), "about");
      // [[wikilinks]] resolve to notes by title, then to projects by name.
      const linkRe = /\[\[([^\]]+)\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(n.body))) {
        const target = m[1].split("|")[0].trim().toLowerCase();
        if (!target) continue;
        const noteId = byTitle.get(target);
        if (noteId) g.link(id, nid("note", noteId), "links");
        else if (idx.projectByName.has(target)) {
          g.link(id, nid("project", idx.projectByName.get(target)!), "links");
        }
      }
      // Mentions of a project/client name in the title, tags or opening
      // of the body (bounded scan).
      const text = `${n.title} ${n.tags.join(" ")} ${n.body.slice(0, NOTE_SCAN_CHARS)}`;
      for (const pid of findMentions(text, idx.projects, 4)) {
        g.link(id, pid, "mentions", { inferred: true, weight: 0.6 });
      }
      for (const cid of findMentions(text, idx.clients, 4)) {
        g.link(id, cid, "mentions", { inferred: true, weight: 0.6 });
      }
    }
  } catch (err) {
    warnSkip("notes", err);
  }
}

const MAX_GRAPH_DOCUMENTS = 3_000;

/**
 * Documents-workspace docs that are not mirrors of a note (imported Obsidian
 * vaults, Notion pages, docs written in the Documents page) join the graph as
 * note nodes, with their `doc:<id>` and [[wikilink]] links as edges.
 */
async function collectDocuments(g: GraphBuilder, idx: Indexes): Promise<void> {
  if (!g.has("note")) return;
  try {
    const { DocumentStore, extractLinkTargets } = await import("../../documents/store.js");
    const store = DocumentStore.at(resolve(g.stateDir, "documents"));
    if (!store.hasIndex()) return;
    const live = store.tree();
    const docs = live
      .filter((n) => n.kind === "doc" && n.source?.type !== "note")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (docs.length > MAX_GRAPH_DOCUMENTS) g.hide("note", docs.length - MAX_GRAPH_DOCUMENTS);
    const kept = docs.slice(0, MAX_GRAPH_DOCUMENTS);
    const keptIds = new Set(kept.map((d) => d.id));
    // Note-mirror docs resolve to their note node so links into old notes still land.
    const noteIdForDoc = new Map<string, string>();
    for (const n of live) {
      if (n.source?.type === "note" && n.source.id) noteIdForDoc.set(n.id, n.source.id);
    }
    const target = (docId: string): string | null => {
      if (keptIds.has(docId)) return nid("note", `doc:${docId}`);
      const noteId = noteIdForDoc.get(docId);
      return noteId ? nid("note", noteId) : null;
    };
    for (const d of kept) {
      g.add({
        id: nid("note", `doc:${d.id}`),
        kind: "note",
        label: d.title,
        weight: 0.35,
        meta: {
          updatedAt: d.updatedAt,
          tags: d.tags?.length ? d.tags : undefined,
          documentId: d.id,
          source: d.source?.type,
        },
      });
    }
    for (const d of kept) {
      const id = nid("note", `doc:${d.id}`);
      const body = store.getBody(d.id);
      // Body links plus property links (Notion relations as `doc:<id>`,
      // Obsidian frontmatter [[links]]). resolveLink is an O(1) cached lookup.
      for (const t of extractLinkTargets(body, d.properties)) {
        const hit = store.resolveLink(t);
        const to = hit && hit.kind !== "folder" ? target(hit.id) : null;
        if (to && to !== id) g.link(id, to, "links");
        else if (!hit && idx.projectByName.has(t.toLowerCase())) {
          g.link(id, nid("project", idx.projectByName.get(t.toLowerCase())!), "links");
        }
      }
      const text = `${d.title} ${(d.tags ?? []).join(" ")} ${body.slice(0, NOTE_SCAN_CHARS)}`;
      for (const pid of findMentions(text, idx.projects, 4)) {
        g.link(id, pid, "mentions", { inferred: true, weight: 0.6 });
      }
      for (const cid of findMentions(text, idx.clients, 4)) {
        g.link(id, cid, "mentions", { inferred: true, weight: 0.6 });
      }
    }
  } catch (err) {
    warnSkip("documents", err);
  }
}

const MAX_GRAPH_FILES = 1_500;
const MAX_TOPICS_PER_FILE = 12;
const MAX_GRAPH_TOPICS = 800;

function fileKindOf(mime: string, ext: string): "image" | "document" | "video" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(ext)) return "video";
  if (
    /pdf|document|sheet|presentation|text|msword|rtf|epub/.test(mime) ||
    /\.(pdf|docx?|pptx?|xlsx?|odt|rtf|epub)$/i.test(ext)
  )
    return "document";
  return "other";
}

function topicSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Uploaded workspace files (normal lane of the local auto-OCR registry) as
 * `file` nodes linked to their project, uploading agent, Documents node and
 * mentioned clients/projects; OCR/vision entities + analyzer findings become
 * shared `topic` nodes. Secure-lane files never appear here (secure graph only).
 */
async function collectFiles(g: GraphBuilder, idx: Indexes): Promise<void> {
  if (!g.has("file")) return;
  try {
    const { NormalLaneStore } = await import("../../ocr/store.js");
    const store = new NormalLaneStore(resolve(g.stateDir, "ocr"));
    const { resolveFilesRoot } = await import("../../ocr/runtime.js");
    const root = resolve(resolveFilesRoot());
    const all = Object.values(store.loadRegistry())
      .filter((e) => e.lane === "normal")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (all.length > MAX_GRAPH_FILES) g.hide("file", all.length - MAX_GRAPH_FILES);
    const topics = new Map<string, { label: string; count: number }>();
    for (const e of all.slice(0, MAX_GRAPH_FILES)) {
      const id = nid("file", e.id);
      const relPath =
        e.path && e.path.startsWith(root + "/") ? e.path.slice(root.length + 1) : null;
      g.add({
        id,
        kind: "file",
        label: e.name,
        weight: 0.3 + Math.min(0.3, (e.chars ?? 0) / 20_000),
        meta: {
          fileId: e.id,
          lane: "normal",
          name: e.name,
          relPath,
          fileKind: fileKindOf(e.mime, e.ext),
          status: e.status,
          mime: e.mime,
          summary: e.summary,
          pages: e.pages,
          confidence: e.confidence ?? null,
          projectId: e.source.projectId,
          sessionKey: e.source.sessionKey,
          source: e.source.kind,
          updatedAt: new Date(e.updatedAt).toISOString(),
        },
      });
      if (e.source.projectId) g.link(id, nid("project", e.source.projectId), "in project");
      if (e.source.agentId) g.link(id, nid("agent", e.source.agentId), "uploaded by");
      if (e.source.docId) g.link(id, nid("note", `doc:${e.source.docId}`), "document");
      if (e.status !== "done") continue;
      const sc = store.readSidecar(e);
      if (!sc) continue;
      const text = `${e.name} ${e.summary ?? ""} ${sc.markdown.slice(0, NOTE_SCAN_CHARS)}`;
      for (const pid of findMentions(text, idx.projects, 4)) {
        g.link(id, pid, "mentions", { inferred: true, weight: 0.6 });
      }
      for (const cid of findMentions(text, idx.clients, 4)) {
        g.link(id, cid, "mentions", { inferred: true, weight: 0.6 });
      }
      // Specialist analyses (e.g. video analysts): link the analyzing agent.
      for (const agentId of new Set((sc.analyses ?? []).map((a) => a.agentId).filter(Boolean))) {
        g.link(id, nid("agent", agentId as string), "analyzed by");
      }
      if (!g.has("topic")) continue;
      // Interleave so analyzer findings are not crowded out by OCR/VL entities.
      const ents = sc.entities ?? [];
      const finds = (sc.analyses ?? []).flatMap((a) => (a.findings ?? []).map((f) => f.title));
      const labels = [
        ...ents.slice(0, 6),
        ...finds.slice(0, 8),
        ...ents.slice(6),
        ...finds.slice(8),
      ];
      const seen = new Set<string>();
      for (const raw of labels) {
        if (seen.size >= MAX_TOPICS_PER_FILE) break;
        const label = String(raw ?? "")
          .replace(/\*\*/g, "")
          .trim()
          .slice(0, 80);
        const slug = topicSlug(label);
        if (slug.length < 2 || seen.has(slug)) continue;
        seen.add(slug);
        const t = topics.get(slug) ?? { label, count: 0 };
        t.count++;
        topics.set(slug, t);
      }
      for (const slug of seen) g.link(id, nid("topic", slug), "mentions");
    }
    const ranked = [...topics.entries()].sort((a, b) => b[1].count - a[1].count);
    if (ranked.length > MAX_GRAPH_TOPICS) g.hide("topic", ranked.length - MAX_GRAPH_TOPICS);
    for (const [slug, t] of ranked.slice(0, MAX_GRAPH_TOPICS)) {
      g.add({
        id: nid("topic", slug),
        kind: "topic",
        label: t.label,
        weight: 0.2 + Math.min(0.5, t.count * 0.08),
        meta: { count: t.count },
      });
    }
  } catch (err) {
    warnSkip("files", err);
  }
}

async function collectDatabases(g: GraphBuilder): Promise<void> {
  if (!g.has("database") && !g.has("row")) return;
  try {
    const { getDatabasesStore } = await import("../../databases/store.js");
    const store = getDatabasesStore(g.stateDir);
    const dbs = (
      store as unknown as { listDatabases?: () => Array<Record<string, unknown>> }
    ).listDatabases?.();
    if (!dbs) return;
    for (const db of dbs) {
      const dbId = String(db.id ?? "");
      if (!dbId) continue;
      g.add({
        id: nid("database", dbId),
        kind: "database",
        label: String(db.name ?? dbId),
        meta: { kind: db.kind },
      });
      if (!g.has("row")) continue;
      const rows =
        (
          store as unknown as {
            listRows?: (dbId: string, opts: { limit: number }) => Array<Record<string, unknown>>;
          }
        ).listRows?.(dbId, { limit: g.opts.maxRowsPerDatabase }) ?? [];
      for (const r of rows) {
        const rid = String(r.id ?? "");
        if (!rid) continue;
        g.add({
          id: nid("row", `${dbId}:${rid}`),
          kind: "row",
          label: String(r.title ?? (r.props && (r.props as Record<string, unknown>).title) ?? rid),
          meta: { dbId },
          weight: 0.4,
        });
        g.link(nid("database", dbId), nid("row", `${dbId}:${rid}`), "contains");
      }
    }
  } catch (err) {
    warnSkip("db", err);
  }
}

async function collectFederation(g: GraphBuilder): Promise<void> {
  if (!g.has("node")) return;
  try {
    const hub = getFederationHub();
    const local = nid("node", "local");
    g.add({
      id: local,
      kind: "node",
      label: hub ? "master (this)" : os.hostname(),
      meta: { isMaster: !!hub, isLocal: true },
      weight: 0.9,
    });
    if (!hub) return;
    for (const n of hub.getConnectedNodes()) {
      const id = nid("node", n.id);
      g.add({
        id,
        kind: "node",
        label: n.manifest?.name ?? n.id,
        meta: { hostname: n.manifest?.hostname, state: n.state },
        weight: 0.8,
      });
      g.link(local, id, "federates");
    }
  } catch (err) {
    warnSkip("federation", err);
  }
}

function collectAgents(g: GraphBuilder, idx: Indexes): void {
  if (!g.has("agent")) return;
  try {
    const cfg = loadConfig() as {
      agents?: {
        list?: Array<{ id?: string; name?: string; identity?: { name?: string } }>;
        manifests?: Record<string, { name?: string }>;
      };
    };
    const entries: Array<[string, string | undefined]> = [];
    for (const a of cfg.agents?.list ?? []) {
      if (a?.id) entries.push([a.id, a.identity?.name ?? a.name]);
    }
    for (const [id, m] of Object.entries(cfg.agents?.manifests ?? {})) entries.push([id, m?.name]);
    for (const [agentId, name] of entries) {
      g.add({
        id: nid("agent", agentId),
        kind: "agent",
        label: name ?? agentId,
        meta: { agentId },
        weight: 0.5,
      });
      idx.agentByKey.set(agentId.toLowerCase(), nid("agent", agentId));
      if (name) idx.agentByKey.set(name.toLowerCase(), nid("agent", agentId));
    }
  } catch (err) {
    warnSkip("agents", err);
  }
}

/** Live + recently-ended sub-agent runs, linked to the task/project they work on. */
async function collectRuns(g: GraphBuilder, idx: Indexes): Promise<void> {
  if (!g.has("run")) return;
  try {
    const { listAllSubagentRuns, isSubagentRunActive } =
      await import("../../agents/subagent-registry.js");
    const runs = listAllSubagentRuns().filter(
      (r) => isSubagentRunActive(r) || (r.endedAt != null && g.now - r.endedAt < RECENT_RUN_MS),
    );
    if (!runs.length) return;
    const { getKanbanStore } = await import("../../tasks/store.js");
    const kanban = getKanbanStore(g.stateDir);
    for (const r of runs) {
      const id = nid("run", r.runId);
      const active = isSubagentRunActive(r);
      const agentId = (r as { agentId?: string }).agentId ?? r.childSessionKey?.split(":")[1];
      const task = r.kanbanTaskId ? kanban.getTaskById(r.kanbanTaskId) : null;
      g.add({
        id,
        kind: "run",
        label: r.label ?? (r.task ?? r.runId).slice(0, 60),
        weight: 0.45,
        meta: {
          runId: r.runId,
          status: active ? "running" : (r.outcome?.status ?? "ended"),
          active,
          agentId,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          kanbanTaskId: r.kanbanTaskId,
          projectId: task?.projectId,
        },
      });
      if (agentId) {
        const aid = idx.agentByKey.get(agentId.toLowerCase());
        if (aid) g.link(aid, id, "running");
      }
      if (task) {
        g.link(id, nid("task", task.id), "works on");
        if (task.projectId) g.link(id, nid("project", task.projectId), "works on");
        const p = g.get(nid("project", task.projectId));
        if (p?.meta && active) p.meta.activeRuns = Number(p.meta.activeRuns ?? 0) + 1;
      }
    }
  } catch (err) {
    warnSkip("runs", err);
  }
}

async function collectContent(g: GraphBuilder, idx: Indexes): Promise<void> {
  if (!g.has("content")) return;
  // Content pages belong to the content-studio plugin: no nodes while it's off.
  const { isContentStudioActive } = await import("../../content-studio/runtime.js");
  if (!isContentStudioActive()) return;
  try {
    const { getContentPagesStore } = await import("../../content/pages-store.js");
    const pages = getContentPagesStore(g.stateDir).list({});
    for (const p of pages) {
      const id = nid("content", p.id);
      g.add({
        id,
        kind: "content",
        label: p.name,
        weight: 0.4,
        meta: { status: p.status, surface: p.surface, handle: p.handle },
      });
      const owner = p.ownerAgentId ? idx.agentByKey.get(p.ownerAgentId.toLowerCase()) : undefined;
      if (owner) g.link(owner, id, "runs page");
      for (const pid of findMentions(p.name, idx.projects, 2)) {
        g.link(id, pid, "for project", { inferred: true, weight: 0.6 });
      }
      for (const cid of findMentions(p.name, idx.clients, 2)) {
        g.link(id, cid, "for client", { inferred: true, weight: 0.6 });
      }
    }
  } catch (err) {
    warnSkip("content", err);
  }
}

/** Linked reports collected beyond the newest-120 window (see collectReports). */
const MAX_LINKED_REPORTS = 600;

async function collectReports(g: GraphBuilder, idx: Indexes): Promise<void> {
  if (!g.has("report")) return;
  try {
    const { getReportsStore } = await import("../../reports/store.js");
    const store = getReportsStore(g.stateDir);
    const { reports } = store.listReports({ limit: 120 });
    // The newest-120 window turns over in hours (system reports are frequent),
    // so research reports and reports bound to an object through objrel are
    // collected on top of it — otherwise a research linked to a project would
    // drop off the graph the same day.
    const seen = new Set(reports.map((r) => r.id));
    const keep = (r: (typeof reports)[number] | null | undefined) => {
      if (!r || seen.has(r.id) || r.kind === "oversight_event") return;
      seen.add(r.id);
      reports.push(r);
    };
    for (const q of [
      { kind: "research_brief", limit: 300 },
      { category: "research", limit: 300 },
    ]) {
      for (const r of store.listReports(q).reports) keep(r);
    }
    try {
      const { getRelationsStore } = await import("../../relations/store.js");
      const rels = getRelationsStore(g.stateDir);
      const ids = new Set<string>();
      for (const rel of rels.list({ fromType: "report", limit: 5_000 })) ids.add(rel.fromId);
      for (const rel of rels.list({ toType: "report", limit: 5_000 })) ids.add(rel.toId);
      let added = 0;
      for (const rid of ids) {
        if (seen.has(rid)) continue;
        if (++added > MAX_LINKED_REPORTS) break;
        keep(store.getReport(rid));
      }
    } catch (err) {
      warnSkip("report-relations", err);
    }
    for (const r of reports) {
      const id = nid("report", r.id);
      g.add({
        id,
        kind: "report",
        label: r.title,
        weight: 0.35,
        meta: { reportId: r.id, status: r.status, category: r.category, createdAt: r.createdAt },
      });
      const agent = r.sourceAgent ? idx.agentByKey.get(r.sourceAgent.toLowerCase()) : undefined;
      if (agent) g.link(agent, id, "wrote");
      const text = `${r.title} ${r.summaryText?.slice(0, 400) ?? ""}`;
      for (const pid of findMentions(text, idx.projects, 3)) {
        g.link(id, pid, "reports on", { inferred: true, weight: 0.6 });
      }
      for (const cid of findMentions(text, idx.clients, 3)) {
        g.link(id, cid, "reports on", { inferred: true, weight: 0.6 });
      }
    }
  } catch (err) {
    warnSkip("reports", err);
  }
}

/**
 * Inferred project↔client links (client name inside a project name or
 * vice-versa) + issue→project via the free-text `relatedProject` field.
 */
function inferCrossLinks(g: GraphBuilder, idx: Indexes): void {
  if (g.has("project") && g.has("client")) {
    for (const n of g.nodes) {
      if (n.kind !== "project") continue;
      for (const cid of findMentions(n.label, idx.clients, 2)) {
        g.link(cid, n.id, "client of", { inferred: true, weight: 0.8 });
      }
    }
    for (const n of g.nodes) {
      if (n.kind !== "client") continue;
      for (const pid of findMentions(n.label, idx.projects, 2)) {
        g.link(n.id, pid, "client of", { inferred: true, weight: 0.8 });
      }
    }
  }
  for (const n of g.nodes) {
    if (n.kind !== "issue") continue;
    const rel = str(n.meta?.relatedProject);
    if (!rel) continue;
    const exact = idx.projectByName.get(rel.toLowerCase());
    if (exact) g.link(n.id, nid("project", exact), "affects");
    else
      for (const pid of findMentions(rel, idx.projects, 1)) {
        g.link(n.id, pid, "affects", { inferred: true });
      }
  }
}

/** Health, liveness and client rollups — needs the full edge set. */
function deriveRollups(g: GraphBuilder): void {
  const clientProjects = new Map<string, Set<string>>();
  for (const e of g.edges) {
    const s = g.get(e.source);
    const t = g.get(e.target);
    if (!s || !t) continue;
    if (s.kind === "client" && t.kind === "project") {
      (clientProjects.get(s.id) ?? clientProjects.set(s.id, new Set()).get(s.id)!).add(t.id);
    } else if (t.kind === "client" && s.kind === "project") {
      (clientProjects.get(t.id) ?? clientProjects.set(t.id, new Set()).get(t.id)!).add(s.id);
    }
  }
  for (const n of g.nodes) {
    if (n.kind !== "project" || !n.meta) continue;
    const live = Number(n.meta.activeRuns ?? 0) > 0 || Number(n.meta.hotTasks ?? 0) > 0;
    const h = deriveProjectHealth({
      status: n.meta.status as string | undefined,
      lastActivityAt: Number(n.meta.lastActivityAt ?? 0),
      overdue: Number(n.meta.overdue ?? 0),
      blocked: Number(n.meta.blocked ?? 0),
      live,
      now: g.now,
    });
    n.meta.health = h.health;
    n.meta.stale = h.stale;
    n.meta.live = live;
    if (h.reasons.length) n.meta.reasons = h.reasons;
  }
  for (const [cid, projects] of clientProjects) {
    const c = g.get(cid);
    if (!c?.meta) continue;
    let open = 0;
    for (const pid of projects) {
      const h = g.get(pid)?.meta?.health;
      if (h && h !== "done" && h !== "backlog") open++;
    }
    c.meta.projects = projects.size;
    c.meta.openProjects = open;
    c.weight = Math.min(1, 0.6 + projects.size * 0.08);
  }
}

export async function buildSnapshot(opts: AggregateOpts): Promise<GraphSnapshot> {
  const stateDir = resolve(opts.stateDir ?? resolveStateDir());
  const g = new GraphBuilder(stateDir, opts, opts.now ?? Date.now());
  const idx: Indexes = {
    projects: [],
    clients: [],
    projectByName: new Map(),
    agentByKey: new Map(),
  };

  // Anchors first so the mention passes can resolve names against them.
  await collectFederation(g);
  collectAgents(g, idx);
  await collectKanban(g);
  await collectClients(g);
  const named = (kind: GraphNodeKind) =>
    g.nodes.filter((n) => n.kind === kind).map((n) => ({ id: n.id, name: n.label }));
  idx.projects = buildNameIndex(named("project"));
  idx.clients = buildNameIndex(named("client"));
  for (const n of g.nodes) {
    if (n.kind === "project")
      idx.projectByName.set(n.label.trim().toLowerCase(), n.meta?.projectId as string);
  }

  await collectBusinessObjects(g);
  await collectRelations(g);
  await collectIdeas(g);
  await collectNotes(g, idx);
  await collectDocuments(g, idx);
  await collectFiles(g, idx);
  await collectDatabases(g);
  await collectRuns(g, idx);
  await collectContent(g, idx);
  await collectReports(g, idx);
  inferCrossLinks(g, idx);

  // Drop dangling edges (endpoint missing / not collected) up front so the
  // pruning + rollups below only see real connections.
  let edges = g.edges.filter((e) => g.get(e.source) && g.get(e.target));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  // Dormant CRM clients and hub-less agents/reports only earn a node when
  // something links to them — otherwise 1k+ cold leads drown the projects.
  const keep = (n: GraphNode): boolean => {
    if ((degree.get(n.id) ?? 0) > 0) return true;
    if (n.kind === "client") return opts.allClients === true || n.meta?.dormant !== true;
    return !PRUNE_IF_ISOLATED.has(n.kind);
  };
  const nodes: GraphNode[] = [];
  for (const n of g.nodes) {
    if (keep(n)) nodes.push(n);
    else {
      g.stats[n.kind] -= 1;
      g.hide(n.kind);
    }
  }
  const kept = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  (g.edges as GraphEdge[]).splice(0, g.edges.length, ...edges);
  deriveRollups(g);

  return {
    generatedAt: g.now,
    nodes,
    edges,
    typeStats: g.stats,
    insights: computeInsights(nodes, edges, g.now),
    hidden: g.hidden,
    kinds: [...opts.kinds],
  };
}

function parseKinds(input: unknown): Set<GraphNodeKind> {
  if (!Array.isArray(input)) return new Set(DEFAULT_KINDS);
  const out = new Set<GraphNodeKind>();
  for (const v of input) {
    if (typeof v === "string" && (ALL_KINDS as string[]).includes(v)) {
      out.add(v as GraphNodeKind);
    }
  }
  return out.size > 0 ? out : new Set(DEFAULT_KINDS);
}

function parseIds(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const ids = input.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, 20);
  return ids.length ? ids : undefined;
}

// ── Server-side aggregation (community detection) ───────────────────
//
// For very large graphs the client can't render every node at 60fps, so
// the gateway collapses the graph into community "super-nodes" and serves
// those. A single focused community can be expanded to full detail. This
// is a library-free label-propagation pass (O(rounds · edges)) — good
// enough for an interactive LOD and avoids pulling in a Louvain dep.

export interface GraphSuperNode {
  id: string; // "cluster:<n>" or a real node id when expanded
  kind: GraphNodeKind | "cluster";
  label: string;
  /** Member count for super-nodes (1 for expanded real nodes). */
  size: number;
  weight?: number;
  meta?: Record<string, unknown>;
}

export interface GraphSummary {
  generatedAt: number;
  mode: "full" | "clustered";
  /** Total nodes/edges in the underlying graph, before collapsing. */
  totals: { nodes: number; edges: number; clusters: number };
  nodes: GraphSuperNode[];
  edges: GraphEdge[];
  typeStats: Record<GraphNodeKind, number>;
}

/** One label-propagation pass over an adjacency list. Returns node→community. */
function detectCommunities(
  nodeIds: string[],
  adjacency: Map<string, string[]>,
  rounds: number,
): Map<string, number> {
  // Seed each node with its own integer label.
  const label = new Map<string, number>();
  nodeIds.forEach((id, i) => label.set(id, i));
  for (let r = 0; r < rounds; r++) {
    let changed = false;
    for (const id of nodeIds) {
      const neighbours = adjacency.get(id);
      if (!neighbours || neighbours.length === 0) continue;
      // Adopt the most common label among neighbours (ties → lowest label
      // for determinism).
      const counts = new Map<number, number>();
      for (const nb of neighbours) {
        const l = label.get(nb);
        if (l === undefined) continue;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(id)!;
      let bestCount = -1;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < best)) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

function summarize(snapshot: GraphSnapshot, maxNodes: number, focus: string | null): GraphSummary {
  const totalNodes = snapshot.nodes.length;
  const totalEdges = snapshot.edges.length;

  if (totalNodes <= maxNodes) {
    return {
      generatedAt: snapshot.generatedAt,
      mode: "full",
      totals: { nodes: totalNodes, edges: totalEdges, clusters: 0 },
      nodes: snapshot.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        size: 1,
        weight: n.weight,
        meta: n.meta,
      })),
      edges: snapshot.edges,
      typeStats: snapshot.typeStats,
    };
  }

  // Build adjacency for community detection.
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, string[]>();
  for (const e of snapshot.edges) {
    (adjacency.get(e.source) ?? adjacency.set(e.source, []).get(e.source)!).push(e.target);
    (adjacency.get(e.target) ?? adjacency.set(e.target, []).get(e.target)!).push(e.source);
  }
  const labels = detectCommunities(
    snapshot.nodes.map((n) => n.id),
    adjacency,
    6,
  );

  // Group members per community.
  const communities = new Map<number, string[]>();
  for (const n of snapshot.nodes) {
    const l = labels.get(n.id)!;
    (communities.get(l) ?? communities.set(l, []).get(l)!).push(n.id);
  }

  // Map a community label → stable cluster id.
  const clusterId = new Map<number, string>();
  let c = 0;
  for (const l of communities.keys()) clusterId.set(l, `cluster:${c++}`);

  // The focused cluster (if any) is expanded to its real member nodes.
  const focusLabel =
    focus != null
      ? focus.startsWith("cluster:")
        ? ([...clusterId.entries()].find(([, cid]) => cid === focus)?.[0] ?? null)
        : (labels.get(focus) ?? null)
      : null;

  const outNodes: GraphSuperNode[] = [];
  const stats = makeStats();
  for (const [l, members] of communities) {
    const cid = clusterId.get(l)!;
    if (l === focusLabel) {
      // Expand: emit each member as a real node.
      for (const id of members) {
        const n = nodeById.get(id)!;
        outNodes.push({
          id: n.id,
          kind: n.kind,
          label: n.label,
          size: 1,
          weight: n.weight,
          meta: n.meta,
        });
        stats[n.kind] += 1;
      }
    } else {
      // Collapse: one super-node, labelled by its dominant kind + size.
      const kindCounts = new Map<GraphNodeKind, number>();
      for (const id of members) {
        const k = nodeById.get(id)!.kind;
        kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
      }
      let domKind: GraphNodeKind = "note";
      let domCount = -1;
      for (const [k, n] of kindCounts) {
        if (n > domCount) {
          domKind = k;
          domCount = n;
        }
      }
      outNodes.push({
        id: cid,
        kind: "cluster",
        label: `${domKind} cluster · ${members.length}`,
        size: members.length,
        weight: Math.min(1, 0.4 + members.length / totalNodes),
        meta: { dominantKind: domKind, members: members.length },
      });
    }
  }

  // Aggregate edges between the emitted entities (cluster id or real id).
  const entityOf = (id: string): string => {
    const l = labels.get(id);
    if (l === undefined) return id;
    if (l === focusLabel) return id; // expanded → real node
    return clusterId.get(l)!;
  };
  const edgeAgg = new Map<string, GraphEdge>();
  for (const e of snapshot.edges) {
    const s = entityOf(e.source);
    const t = entityOf(e.target);
    if (s === t) continue; // intra-cluster edges collapse away
    const key = s < t ? `${s}|${t}` : `${t}|${s}`;
    const ex = edgeAgg.get(key);
    if (ex) ex.weight = (ex.weight ?? 1) + 1;
    else edgeAgg.set(key, { source: s, target: t, rel: "cluster-link", weight: 1 });
  }

  return {
    generatedAt: snapshot.generatedAt,
    mode: "clustered",
    totals: { nodes: totalNodes, edges: totalEdges, clusters: communities.size },
    nodes: outNodes,
    edges: [...edgeAgg.values()],
    typeStats: stats,
  };
}

export function parseOpts(params: Record<string, unknown>): AggregateOpts {
  const maxRowsPerDatabase =
    typeof params.maxRowsPerDatabase === "number" && Number.isFinite(params.maxRowsPerDatabase)
      ? Math.max(0, Math.min(5000, Math.floor(params.maxRowsPerDatabase)))
      : 200;
  const maxTasks =
    typeof params.maxTasks === "number" && Number.isFinite(params.maxTasks)
      ? Math.max(1, Math.min(20_000, Math.floor(params.maxTasks)))
      : undefined;
  return {
    kinds: parseKinds(params.types),
    maxRowsPerDatabase,
    maxTasks,
    taskProjectIds: parseIds(params.taskProjectIds),
    allClients: params.allClients === true,
  };
}

function cacheKeyOf(o: AggregateOpts): string {
  return [
    Array.from(o.kinds).sort().join(","),
    o.maxRowsPerDatabase,
    o.maxTasks ?? "",
    o.taskProjectIds?.join(",") ?? "",
    o.allClients ? 1 : 0,
  ].join("|");
}

function scopeKey(s: ProjectScopeOpts): string {
  return [s.projectId, s.hops, s.rels?.join(",") ?? "", s.inferred === false ? 0 : 1].join("~");
}

/** Cut a built snapshot to one project; stats/insights follow the scoped set. */
export function scopeGraphSnapshot(full: GraphSnapshot, scope: ProjectScopeOpts): GraphSnapshot {
  const scoped = scopeSnapshotToProject(full, { ...scope, includeSecure: false });
  const typeStats = makeStats();
  for (const n of scoped.nodes) typeStats[n.kind] += 1;
  return {
    generatedAt: full.generatedAt,
    nodes: scoped.nodes,
    edges: scoped.edges,
    typeStats,
    insights: computeInsights(scoped.nodes, scoped.edges, full.generatedAt),
    hidden: {},
    kinds: full.kinds,
    scope: scoped.scope,
  };
}

export const graphGlobalHandlers: GatewayRequestHandlers = {
  "graph.summary": async (opts: GatewayRequestHandlerOptions) => {
    const params = (opts.params ?? {}) as Record<string, unknown>;
    const maxNodes =
      typeof params.maxNodes === "number" && Number.isFinite(params.maxNodes)
        ? Math.max(100, Math.min(20_000, Math.floor(params.maxNodes)))
        : 1500;
    const focus = typeof params.focus === "string" && params.focus ? params.focus : null;
    try {
      const snapshot = await buildSnapshot(parseOpts(params));
      opts.respond(true, summarize(snapshot, maxNodes, focus));
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  "graph.global.snapshot": async (opts: GatewayRequestHandlerOptions) => {
    const params = (opts.params ?? {}) as Record<string, unknown>;
    const scope = parseScopeParams(params);
    const aggregate = parseOpts(params);
    if (scope) {
      // A project view always has its project anchor and, when tasks are on,
      // only this project's tasks (cheap — no 3k-task global layer).
      aggregate.kinds.add("project");
      if (aggregate.kinds.has("task"))
        aggregate.taskProjectIds = [scope.projectId.replace(/^project:/, "")];
    }
    const refresh = params.refresh === true;
    const cacheKey = cacheKeyOf(aggregate) + (scope ? `|scope:${scopeKey(scope)}` : "");

    const now = Date.now();
    if (!refresh && cached && cached.key === cacheKey && now - cached.at < CACHE_TTL_MS) {
      opts.respond(true, cached.snapshot);
      return;
    }

    try {
      const full = await buildSnapshot(aggregate);
      const snapshot = scope ? scopeGraphSnapshot(full, scope) : full;
      cached = { key: cacheKey, at: now, snapshot };
      opts.respond(true, snapshot);
    } catch (err) {
      opts.respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
