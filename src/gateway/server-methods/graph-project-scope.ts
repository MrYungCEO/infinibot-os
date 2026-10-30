/**
 * Project-scoped knowledge graph.
 *
 * Cuts a full graph snapshot down to what is actually related to ONE project:
 *
 *   1. Seeds — the project node, plus every node whose `meta.projectId` names
 *      it (tasks, files, runs). Seeds without a stored edge get an inferred
 *      "in project" edge so they stay attached.
 *   2. Expansion — breadth-first over real edges up to `hops` (default 2)
 *      from the project, optionally restricted to some relation types.
 *   3. Boundaries — global hubs (very high degree, owner / federation /
 *      database style nodes) and OTHER projects are included when reached but
 *      never expanded, so a shared hub can't pull the whole graph in and a
 *      sibling project's own tasks/files never leak in through it.
 *      Nodes owned by another project (meta.projectId ≠ this one) are never
 *      reached through a hub either.
 *   4. Secure items (meta.secure / meta.lane === "secure") are dropped unless
 *      the caller is the secure lane.
 *   5. Whatever is left is pruned to the project's connected component, so
 *      there are never orphan islands.
 *
 * Pure: no I/O, shared by graph.global.snapshot, secure.graph.snapshot and
 * the multi-user authz transform (which re-prunes after hiding records).
 */

export type ScopeNode = {
  id: string;
  kind: string;
  label?: string;
  meta?: Record<string, unknown>;
  weight?: number;
};

export type ScopeEdge = {
  source: string;
  target: string;
  rel: string;
  weight?: number;
  inferred?: boolean;
};

export type ProjectScopeOpts = {
  /** Raw project id (`abc`) or node id (`project:abc` / `secure:project:abc`). */
  projectId: string;
  /** Max hops from the project node. Default 2, clamped 0..4. */
  hops?: number;
  /** Only traverse edges whose relation is in this list (case-insensitive). */
  rels?: string[];
  /** Traverse inferred (name-mention) edges. Default true. */
  inferred?: boolean;
  /** Nodes with more connections than this never expand. Default 30. */
  hubDegree?: number;
  /** Max neighbours one node may pull in per hop. Default 60. */
  maxFanout?: number;
  /** Keep secure-lane nodes (only the secure lane passes true). */
  includeSecure?: boolean;
};

export type ProjectScopeInfo = {
  projectId: string;
  projectNodeId: string;
  label: string | null;
  found: boolean;
  hops: number;
  rels: string[] | null;
  /** Node / edge counts of the snapshot before scoping. */
  totalNodes: number;
  totalEdges: number;
  /** Ids of hubs that were included but not expanded. */
  hubs: string[];
  /** Nodes that matched but were cut by the fan-out cap. */
  capped: number;
  /** Secure nodes dropped because the caller isn't in the secure lane. */
  secureExcluded: number;
};

export const DEFAULT_SCOPE_HOPS = 2;
export const MAX_SCOPE_HOPS = 4;
const DEFAULT_HUB_DEGREE = 30;
const DEFAULT_MAX_FANOUT = 60;

/** Kinds that are global by nature: reachable, never expanded. */
const HUB_KINDS = new Set(["user", "node", "database", "skill", "session"]);

export function isSecureNode(n: ScopeNode): boolean {
  const m = n.meta;
  if (n.id.startsWith("secure:")) return true;
  if (!m) return false;
  return m.secure === true || m.lane === "secure" || m.secureLane === true;
}

export function clampHops(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_SCOPE_HOPS;
  return Math.max(0, Math.min(MAX_SCOPE_HOPS, Math.floor(n)));
}

/** Find the project node for a raw id or node id. */
export function resolveProjectNodeId(
  nodes: readonly ScopeNode[],
  projectId: string,
): string | null {
  const ids = new Set(nodes.map((n) => n.id));
  for (const c of [projectId, `project:${projectId}`, `secure:project:${projectId}`]) {
    if (ids.has(c)) {
      const n = nodes.find((x) => x.id === c);
      if (n?.kind === "project") return c;
    }
  }
  return null;
}

function rawProjectId(nodeId: string): string {
  return nodeId.replace(/^secure:/, "").replace(/^project:/, "");
}

/** Keep only the connected component containing `rootId`. */
export function pruneToComponent<
  N extends { id: string },
  E extends { source: string; target: string },
>(nodes: readonly N[], edges: readonly E[], rootId: string): { nodes: N[]; edges: E[] } {
  const present = new Set(nodes.map((n) => n.id));
  if (!present.has(rootId)) return { nodes: [], edges: [] };
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!present.has(e.source) || !present.has(e.target)) continue;
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
  }
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur) ?? []) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      queue.push(nb);
    }
  }
  return {
    nodes: nodes.filter((n) => seen.has(n.id)),
    edges: edges.filter((e) => seen.has(e.source) && seen.has(e.target)),
  };
}

export function scopeSnapshotToProject<N extends ScopeNode, E extends ScopeEdge>(
  snapshot: { nodes: readonly N[]; edges: readonly E[] },
  opts: ProjectScopeOpts,
): { nodes: N[]; edges: E[]; scope: ProjectScopeInfo } {
  const hops = clampHops(opts.hops);
  const rels = opts.rels?.length ? opts.rels.map((r) => r.toLowerCase()) : null;
  const relSet = rels ? new Set(rels) : null;
  const hubDegree = opts.hubDegree ?? DEFAULT_HUB_DEGREE;
  const maxFanout = opts.maxFanout ?? DEFAULT_MAX_FANOUT;
  const allowInferred = opts.inferred !== false;

  let secureExcluded = 0;
  const nodes = snapshot.nodes.filter((n) => {
    if (opts.includeSecure || !isSecureNode(n)) return true;
    secureExcluded++;
    return false;
  });
  const rootId = resolveProjectNodeId(nodes, opts.projectId);
  const pid = rootId ? rawProjectId(rootId) : rawProjectId(opts.projectId);
  const base: ProjectScopeInfo = {
    projectId: pid,
    projectNodeId: rootId ?? `project:${pid}`,
    label: null,
    found: false,
    hops,
    rels,
    totalNodes: snapshot.nodes.length,
    totalEdges: snapshot.edges.length,
    hubs: [],
    capped: 0,
    secureExcluded,
  };
  if (!rootId) return { nodes: [], edges: [], scope: base };

  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const root = byId.get(rootId)!;
  base.label = root.label ?? null;
  base.found = true;

  // Real edges between surviving nodes; degree is measured on the full graph.
  const edges = snapshot.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const traversable = (e: E): boolean =>
    (allowInferred || !e.inferred) && (!relSet || relSet.has(String(e.rel).toLowerCase()));
  const adj = new Map<string, Array<{ to: string; w: number }>>();
  for (const e of edges) {
    if (!traversable(e)) continue;
    const w = typeof e.weight === "number" ? e.weight : e.inferred ? 0.5 : 1;
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push({ to: e.target, w });
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push({ to: e.source, w });
  }

  // Other projects and anything they own are "foreign": reachable only via a
  // direct link from this project's own nodes.
  const ownedByOther = (n: N): boolean => {
    if (n.kind === "project") return n.id !== rootId;
    const owner = n.meta?.projectId;
    return typeof owner === "string" && owner !== "" && owner !== pid;
  };
  const isHub = (n: N): boolean => {
    if (n.id === rootId) return false;
    if (HUB_KINDS.has(n.kind) || n.meta?.hub === true) return true;
    return (degree.get(n.id) ?? 0) > hubDegree;
  };
  // Another project is a boundary: shown when linked, never expanded.
  const isBoundary = (n: N): boolean => n.id !== rootId && (n.kind === "project" ? true : isHub(n));

  // Seeds: everything that declares this project as its owner.
  const depth = new Map<string, number>([[rootId, 0]]);
  const extra: E[] = [];
  const direct = new Set((adj.get(rootId) ?? []).map((x) => x.to));
  for (const n of nodes) {
    if (n.id === rootId || n.meta?.projectId !== pid) continue;
    if (isSecureNode(n) && !opts.includeSecure) continue;
    depth.set(n.id, 1);
    if (!direct.has(n.id)) {
      extra.push({
        source: n.id,
        target: rootId,
        rel: "in project",
        inferred: true,
        weight: 0.5,
      } as E);
    }
  }

  const hubs = new Set<string>();
  let capped = 0;
  const ownsIt = (n: N): boolean => n.id === rootId || n.meta?.projectId === pid;
  let frontier: string[] = [rootId];
  for (let d = 0; d < hops && frontier.length; d++) {
    const next: string[] = d === 0 ? [...depth.keys()].filter((id) => id !== rootId) : [];
    for (const id of frontier) {
      const n = byId.get(id)!;
      if (isBoundary(n)) {
        if (isHub(n)) hubs.add(id);
        continue;
      }
      // Strongest links first so the fan-out cap keeps the meaningful ones.
      const nbs = [...(adj.get(id) ?? [])].sort((a, b) => b.w - a.w);
      let taken = 0;
      for (const { to } of nbs) {
        if (depth.has(to)) continue;
        // Another project (or its private nodes) only comes in through a direct
        // link from this project's own nodes — never via hubs, notes or clients.
        if (ownedByOther(byId.get(to)!) && !ownsIt(n)) continue;
        if (taken >= maxFanout) {
          capped++;
          continue;
        }
        taken++;
        depth.set(to, d + 1);
        next.push(to);
      }
    }
    frontier = next;
  }
  for (const id of frontier) {
    const n = byId.get(id);
    if (n && isHub(n)) hubs.add(id);
  }

  const kept = nodes.filter((n) => depth.has(n.id));
  const keptEdges = [...edges, ...extra].filter((e) => depth.has(e.source) && depth.has(e.target));
  const pruned = pruneToComponent(kept, keptEdges, rootId);
  const keptIds = new Set(pruned.nodes.map((n) => n.id));
  return {
    nodes: pruned.nodes.map((n) =>
      n.id === rootId ? ({ ...n, meta: { ...(n.meta ?? {}), scopeRoot: true } } as N) : n,
    ),
    edges: pruned.edges,
    scope: { ...base, hubs: [...hubs].filter((h) => keptIds.has(h)), capped },
  };
}

/** Parse `projectId` / `hops` / `rels` from RPC params; null when unscoped. */
export function parseScopeParams(params: Record<string, unknown>): ProjectScopeOpts | null {
  const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
  if (!projectId) return null;
  const rels = Array.isArray(params.rels)
    ? params.rels.filter((r): r is string => typeof r === "string" && r.trim() !== "").slice(0, 32)
    : undefined;
  return {
    projectId: projectId.slice(0, 200),
    hops: clampHops(params.hops),
    rels,
    inferred: params.inferred !== false,
  };
}
