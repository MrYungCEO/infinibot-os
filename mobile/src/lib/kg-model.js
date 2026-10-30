/**
 * kg-model — the pure model behind the native Knowledge Graph screen.
 *
 * Same data as the web /knowledge-graph: the gateway's `graph.global.snapshot`
 * RPC ({ types, taskProjectIds?, refresh? } → { nodes, edges, typeStats,
 * hidden, insights }). The palette, kind labels and kind→shape table mirror
 * ui/src/ui/components/knowledge-graph-model.ts so a project reads as the same
 * gold gem on the phone as on the desktop; the mutation planners mirror
 * knowledge-graph-ops.ts (objrel.link / kanban.tasks.update /
 * kanban.projects.update / notes.update) so a long-press action on the phone
 * makes exactly the call the web drag-and-drop does.
 *
 * Nothing in here touches React or the gateway — it is unit-tested in
 * src/__tests__/kg-model.test.js.
 */

// ── Kinds, palette, shapes (mirrors knowledge-graph-model.ts) ───────────────

export const KIND_ORDER = [
  'project', 'client', 'opportunity', 'product', 'issue', 'decision', 'person',
  'note', 'research', 'idea', 'report', 'content', 'agent', 'run', 'task',
  'database', 'row', 'session', 'skill', 'node', 'user',
];

/** Kinds the gateway knows (`research` is a derived visual kind, see visualKind). */
export const GATEWAY_KINDS = KIND_ORDER.filter((k) => k !== 'research');

export const KIND_PALETTE = {
  project: '#f5c542',
  client: '#f1e4c3',
  opportunity: '#f0abfc',
  product: '#5eead4',
  issue: '#fb7185',
  decision: '#c4b5fd',
  person: '#fde68a',
  note: '#7aa7e8',
  research: '#67e8f9',
  idea: '#fcd34d',
  report: '#93c5fd',
  content: '#fdba74',
  agent: '#f472b6',
  run: '#4ade80',
  task: '#86efac',
  session: '#fb923c',
  database: '#a78bfa',
  row: '#c084fc',
  skill: '#34d399',
  node: '#f87171',
  user: '#fbbf24',
};

export const KIND_LABEL = {
  project: 'Projects', client: 'Clients', opportunity: 'Opportunities', product: 'Products',
  issue: 'Issues', decision: 'Decisions', person: 'People', note: 'Notes', research: 'Research',
  idea: 'Ideas', report: 'Reports', content: 'Content', agent: 'Agents', run: 'Agent runs',
  task: 'Tasks', session: 'Sessions', database: 'Databases', row: 'Rows', skill: 'Skills',
  node: 'Federation', user: 'Users',
};

export const KIND_SINGULAR = {
  project: 'Project', client: 'Client', opportunity: 'Opportunity', product: 'Product',
  issue: 'Issue', decision: 'Decision', person: 'Person', note: 'Note', research: 'Research',
  idea: 'Idea', report: 'Report', content: 'Content page', agent: 'Agent', run: 'Agent run',
  task: 'Task', session: 'Session', database: 'Database', row: 'Row', skill: 'Skill',
  node: 'Federation node', user: 'User',
};

/** Shape per kind — the web legend (gem / block / pages / report / …). */
export const KIND_SHAPE = {
  project: 'gem', opportunity: 'gem', product: 'gem',
  task: 'block', row: 'block', issue: 'block',
  note: 'pages',
  research: 'lens',
  idea: 'bulb',
  report: 'report',
  content: 'media',
  agent: 'agent', run: 'agent', skill: 'agent', session: 'agent',
  person: 'person', client: 'person', user: 'person',
  node: 'chip', database: 'chip',
  decision: 'neuron',
};

export const HEALTH_ORDER = ['active', 'review', 'at_risk', 'blocked', 'backlog', 'done'];
export const HEALTH_COLOR = {
  active: '#3ddc97', review: '#a78bfa', at_risk: '#f5a524', blocked: '#f0525f', backlog: '#8a8474', done: '#56636b',
};
export const HEALTH_LABEL = {
  active: 'Active', review: 'In review', at_risk: 'At risk', blocked: 'Blocked', backlog: 'Backlog', done: 'Done',
};

/** Matches the gateway DEFAULT_KINDS: tasks/rows/sessions stay off. */
export const DEFAULT_KINDS = [
  'project', 'client', 'opportunity', 'product', 'issue', 'decision', 'person',
  'note', 'report', 'content', 'agent', 'run', 'idea',
];

/** Layers offered as filter chips on the phone (most useful first). */
export const FILTER_KINDS = [
  'project', 'task', 'note', 'research', 'idea', 'report', 'client', 'agent', 'run',
  'opportunity', 'decision', 'issue', 'content', 'product', 'person',
];

export const GROUP_MODES = [
  { key: 'type', label: 'Type' },
  { key: 'project', label: 'Project' },
  { key: 'status', label: 'Status' },
];

export function shapeFor(kind) {
  return KIND_SHAPE[kind] || 'orb';
}

export function healthOf(meta) {
  const h = meta && meta.health;
  return typeof h === 'string' && HEALTH_ORDER.includes(h) ? h : 'backlog';
}

/** Notes filed as research render as research (lens), like the web Research workspace. */
export function visualKind(node) {
  if (!node) return 'note';
  if (node.kind === 'note') {
    const tags = Array.isArray(node.meta?.tags) ? node.meta.tags : [];
    if (tags.some((t) => String(t).toLowerCase() === 'research')) return 'research';
    if (node.meta?.category === 'research') return 'research';
  }
  if (node.kind === 'report' && node.meta?.category === 'research') return 'research';
  return node.kind;
}

/** Fill colour — projects by health (the web paints projects by status). */
export function colorFor(node) {
  if (!node) return '#9ca3af';
  if (node.kind === 'project') return HEALTH_COLOR[healthOf(node.meta)];
  return KIND_PALETTE[visualKind(node)] || '#9ca3af';
}

// ── Snapshot sanitising ─────────────────────────────────────────────────────

/** Drop malformed records; returns null for an unusable payload. */
export function sanitizeSnapshot(raw, maxNodes = 60000) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null;
  const nodes = [];
  const ids = new Set();
  let dropped = 0;
  for (const n of raw.nodes) {
    if (nodes.length >= maxNodes) { dropped++; continue; }
    if (!n || typeof n.id !== 'string' || !n.id || typeof n.kind !== 'string' || ids.has(n.id)) { dropped++; continue; }
    ids.add(n.id);
    nodes.push({
      id: n.id,
      kind: n.kind,
      label: typeof n.label === 'string' && n.label.trim() ? n.label.trim() : n.id,
      weight: Number.isFinite(n.weight) ? n.weight : 0.5,
      meta: n.meta && typeof n.meta === 'object' ? n.meta : {},
    });
  }
  const edges = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!e || !ids.has(e.source) || !ids.has(e.target) || e.source === e.target) { dropped++; continue; }
    edges.push({ source: e.source, target: e.target, rel: String(e.rel || 'relates to'), inferred: !!e.inferred });
  }
  return {
    generatedAt: Number(raw.generatedAt) || Date.now(),
    nodes,
    edges,
    typeStats: raw.typeStats && typeof raw.typeStats === 'object' ? raw.typeStats : {},
    hidden: raw.hidden && typeof raw.hidden === 'object' ? raw.hidden : {},
    insights: Array.isArray(raw.insights) ? raw.insights : [],
    dropped,
  };
}

/** The `types` param for graph.global.snapshot from the enabled filter kinds. */
export function snapshotTypes(enabledKinds) {
  const out = new Set();
  for (const k of enabledKinds || []) {
    if (k === 'research') out.add('note').add('report');
    else if (GATEWAY_KINDS.includes(k)) out.add(k);
  }
  out.add('project'); // the family/focus logic always needs the project spine
  return [...out];
}

// ── Indexes ─────────────────────────────────────────────────────────────────

export function storeIdOf(n) {
  const m = n?.meta || {};
  if (n?.kind === 'project' && typeof m.projectId === 'string' && m.projectId) return m.projectId;
  if (n?.kind === 'client' && typeof m.clientId === 'string' && m.clientId) return m.clientId;
  const id = String(n?.id || '');
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

export function buildIndex(nodes, edges) {
  const byId = new Map();
  const projectByStoreId = new Map();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.kind === 'project') projectByStoreId.set(storeIdOf(n), n);
  }
  const adj = new Map();
  const add = (a, b, e) => {
    let l = adj.get(a);
    if (!l) adj.set(a, (l = []));
    l.push({ id: b, rel: e.rel, inferred: e.inferred, out: e.source === a });
  };
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    add(e.source, e.target, e);
    add(e.target, e.source, e);
  }
  return { byId, projectByStoreId, adj };
}

/** Parent project node id of a project (null at the top level). */
export function parentProjectOf(node, index) {
  const pid = node?.meta?.parentProjectId;
  if (typeof pid !== 'string' || !pid) return null;
  return index.projectByStoreId.get(pid)?.id || null;
}

/** Root (top-level) project id of a project node; guards against cycles. */
export function rootProjectOf(nodeId, index) {
  let cur = nodeId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = index.byId.get(cur);
    const p = parentProjectOf(n, index);
    if (!p) return cur;
    cur = p;
  }
  return cur;
}

const PROJECT_RELS = new Set(['about', 'contains', 'for project', 'has task', 'report documents project', 'sub-project of']);

/** The project a node belongs to (node id), via meta first, then stored edges, then inferred ones. */
export function owningProjectOf(node, index) {
  if (!node) return null;
  if (node.kind === 'project') return node.id;
  const m = node.meta || {};
  if (typeof m.projectId === 'string' && m.projectId) {
    const p = index.projectByStoreId.get(m.projectId);
    if (p) return p.id;
  }
  const links = index.adj.get(node.id) || [];
  let inferred = null;
  for (const l of links) {
    const o = index.byId.get(l.id);
    if (o?.kind !== 'project') continue;
    if (!l.inferred && PROJECT_RELS.has(l.rel)) return o.id;
    inferred = inferred || o.id;
  }
  return inferred;
}

// ── Filtering ───────────────────────────────────────────────────────────────

/** Normalised status bucket for the status filter / status grouping. */
export function statusOf(node) {
  if (node.kind === 'project') return healthOf(node.meta);
  const s = String(node.meta?.status || '').toLowerCase().replace(/\s+/g, '_');
  if (!s) return 'none';
  if (['done', 'complete', 'completed', 'shipped', 'won', 'decided', 'ready', 'sent', 'closed', 'promoted'].includes(s)) return 'done';
  if (['blocked', 'failed', 'error', 'lost', 'overdue'].includes(s)) return 'blocked';
  if (['review', 'reviewing', 'in_review', 'pending'].includes(s)) return 'review';
  if (['in_progress', 'active', 'running', 'open', 'exploring', 'discovery', 'rendering'].includes(s)) return 'active';
  if (['backlog', 'todo', 'not_started', 'new', 'parked', 'queued', 'prospect', 'lead'].includes(s)) return 'backlog';
  return 'none';
}

export const STATUS_FILTERS = [
  { key: 'active', label: 'Active' },
  { key: 'review', label: 'In review' },
  { key: 'at_risk', label: 'At risk' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'done', label: 'Done' },
  { key: 'none', label: 'No status' },
];

export const DEFAULT_STATUSES = ['active', 'review', 'at_risk', 'blocked', 'backlog', 'none'];

/** Lower-case token match over label + tags. */
export function matchesSearch(node, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return true;
  const hay = [node.label, ...(Array.isArray(node.meta?.tags) ? node.meta.tags : [])].join(' ').toLowerCase();
  return s.split(/\s+/).every((t) => hay.includes(t));
}

/**
 * The project-family member set for a focus project: the family root, every
 * descendant project, and every node owned by or linked to one of them.
 */
export function familyOf(focusId, nodes, index) {
  const focus = index.byId.get(focusId);
  if (!focus) return null;
  const projectId = focus.kind === 'project' ? focus.id : owningProjectOf(focus, index);
  if (!projectId) {
    // A non-project focus: the node and its 1-hop neighbourhood.
    const out = new Set([focusId]);
    for (const l of index.adj.get(focusId) || []) out.add(l.id);
    return out;
  }
  const root = rootProjectOf(projectId, index);
  const projects = new Set();
  for (const n of nodes) if (n.kind === 'project' && rootProjectOf(n.id, index) === root) projects.add(n.id);
  const out = new Set(projects);
  for (const n of nodes) {
    if (out.has(n.id)) continue;
    const own = owningProjectOf(n, index);
    if (own && projects.has(own)) { out.add(n.id); continue; }
    // Other projects merely "related to" a family member belong to their own family.
    if (n.kind === 'project') continue;
    for (const l of index.adj.get(n.id) || []) {
      if (projects.has(l.id)) { out.add(n.id); break; }
    }
  }
  return out;
}

/**
 * Apply layer / status / focus filters. Search does NOT remove nodes (the
 * screen dims non-matches and lists hits) unless `searchOnly` is set.
 */
export function filterGraph(snapshot, opts = {}) {
  const { kinds, statuses, focusId = null, search = '', searchOnly = false } = opts;
  const kindSet = kinds ? new Set(kinds) : null;
  const statusSet = statuses ? new Set(statuses) : null;
  const all = snapshot?.nodes || [];
  const index = buildIndex(all, snapshot?.edges || []);
  const family = focusId ? familyOf(focusId, all, index) : null;
  const nodes = all.filter((n) => {
    if (family) return family.has(n.id);
    // Research-filed notes/reports belong to the 'research' layer only.
    if (kindSet && !kindSet.has(visualKind(n))) return false;
    if (statusSet && !statusSet.has(statusOf(n))) return false;
    if (searchOnly && !matchesSearch(n, search)) return false;
    return true;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (snapshot?.edges || []).filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges, index: buildIndex(nodes, edges), fullIndex: index };
}

/** Search hits, best first (prefix match on the label beats a substring). */
export function searchNodes(nodes, q, limit = 30) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  const scored = [];
  for (const n of nodes) {
    if (!matchesSearch(n, s)) continue;
    const l = n.label.toLowerCase();
    const score = (l.startsWith(s) ? 0 : l.includes(s) ? 1 : 2) + (n.kind === 'project' ? -0.5 : 0);
    scored.push([score, n]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label));
  return scored.slice(0, limit).map((x) => x[1]);
}

// ── Grouping + super-node collapse ──────────────────────────────────────────

/**
 * Group key + human title for a node under a group mode.
 *   type    → its (visual) kind
 *   project → its top-level project family; nodes with no project fall into
 *             "Unlinked <kind>" so unlinked nodes still cluster by type
 *   status  → normalised status bucket
 */
export function groupOf(node, mode, index) {
  if (mode === 'project') {
    const own = owningProjectOf(node, index);
    if (own) {
      const root = rootProjectOf(own, index);
      return { key: `fam:${root}`, title: index.byId.get(root)?.label || 'Project', hub: root };
    }
    const vk = visualKind(node);
    return { key: `unlinked:${vk}`, title: `Unlinked ${String(KIND_LABEL[vk] || vk).toLowerCase()}`, kind: vk };
  }
  if (mode === 'status') {
    const s = statusOf(node);
    const label = HEALTH_LABEL[s] || (s === 'none' ? 'No status' : s);
    return { key: `status:${s}`, title: label, status: s };
  }
  const vk = visualKind(node);
  return { key: `type:${vk}`, title: KIND_LABEL[vk] || vk, kind: vk };
}

/** Per-kind collapse threshold: buckets above it become a count super-node. */
export const COLLAPSE_AT = { task: 24, run: 30, report: 40, note: 150, project: 500, client: 120 };
export const DEFAULT_COLLAPSE_AT = 80;
/** An expanded bucket still shows at most this many nodes (+ an overflow super-node). */
export const EXPAND_CAP = 400;

export function collapseLimit(kind, overrides) {
  const o = overrides && overrides[kind];
  if (Number.isFinite(o)) return o;
  return COLLAPSE_AT[kind] ?? DEFAULT_COLLAPSE_AT;
}

/**
 * Group nodes and collapse big same-kind buckets into super-nodes.
 *
 * Returns { groups: [{ key, title, hub?, items: [item] }], memberOf: Map<nodeId, itemId> }
 * where an item is either a real node `{ id, node, kind, r }` or a super-node
 * `{ id: 'super:<group>:<kind>', superKind, kind, count, memberIds, label }`.
 * `memberOf` maps every input node id to the item that represents it (itself
 * or its super-node), so edges can be re-routed onto super-nodes.
 */
export function groupAndCollapse(nodes, index, opts = {}) {
  const { mode = 'type', expanded = new Set(), collapseAt, focusId = null } = opts;
  const groups = new Map();
  for (const n of nodes) {
    const g = groupOf(n, mode, index);
    let grp = groups.get(g.key);
    if (!grp) groups.set(g.key, (grp = { ...g, buckets: new Map(), size: 0 }));
    const vk = visualKind(n);
    let b = grp.buckets.get(vk);
    if (!b) grp.buckets.set(vk, (b = []));
    b.push(n);
    grp.size++;
  }
  // Project mode: a family that is just its own project (nothing linked) joins
  // one "Standalone projects" cluster instead of floating as a lone disc —
  // hundreds of one-node families would scatter the map.
  if (mode === 'project' && !focusId) {
    let solo = null;
    for (const [key, grp] of [...groups]) {
      if (!key.startsWith('fam:') || grp.size !== 1) continue;
      if (!solo) solo = { key: 'solo:project', title: 'Standalone projects', kind: 'project', buckets: new Map([['project', []]]), size: 0 };
      solo.buckets.get('project').push(...grp.buckets.get('project'));
      solo.size++;
      groups.delete(key);
    }
    if (solo) groups.set(solo.key, solo);
  }
  const memberOf = new Map();
  const out = [];
  for (const grp of groups.values()) {
    const items = [];
    for (const kind of KIND_ORDER) {
      const bucket = grp.buckets.get(kind);
      if (!bucket) continue;
      bucket.sort(compareNodes);
      const superId = `super:${grp.key}:${kind}`;
      const limit = collapseLimit(kind, collapseAt);
      const isOpen = expanded.has(superId) || (focusId && bucket.some((n) => n.id === focusId) && bucket.length <= EXPAND_CAP);
      if (bucket.length > limit && !isOpen) {
        items.push(makeSuper(superId, kind, bucket, grp));
        for (const n of bucket) memberOf.set(n.id, superId);
        continue;
      }
      const shown = bucket.length > EXPAND_CAP ? bucket.slice(0, EXPAND_CAP) : bucket;
      for (const n of shown) {
        items.push({ id: n.id, node: n, kind });
        memberOf.set(n.id, n.id);
      }
      if (bucket.length > EXPAND_CAP) {
        const rest = bucket.slice(EXPAND_CAP);
        const restId = `${superId}:more`;
        items.push({ ...makeSuper(restId, kind, rest, grp), label: `+${rest.length} more ${String(KIND_LABEL[kind] || kind).toLowerCase()}` });
        for (const n of rest) memberOf.set(n.id, restId);
      }
    }
    // The family hub (the root project) sits first so it lands in the centre.
    if (grp.hub) {
      const i = items.findIndex((it) => it.id === grp.hub);
      if (i > 0) items.unshift(items.splice(i, 1)[0]);
    }
    out.push({ key: grp.key, title: grp.title, hub: grp.hub || null, kind: grp.kind || null, status: grp.status || null, size: grp.size, items });
  }
  // Biggest first; the unlinked / no-status buckets after the real families.
  out.sort((a, b) => (isLeftover(a) - isLeftover(b)) || b.size - a.size || a.title.localeCompare(b.title));
  return { groups: out, memberOf };
}

function isLeftover(g) {
  return g.key.startsWith('unlinked:') || g.key === 'status:none' || g.key === 'solo:project' ? 1 : 0;
}

function makeSuper(id, kind, members, grp) {
  return {
    id,
    superKind: true,
    kind,
    count: members.length,
    memberIds: members.map((n) => n.id),
    label: `${members.length} ${String(KIND_LABEL[kind] || kind).toLowerCase()}`,
    group: grp.key,
  };
}

/** Projects by size (task count / weight), everything else alphabetical. */
function compareNodes(a, b) {
  if (a.kind === 'project' && b.kind === 'project') {
    const da = a.meta?.parentProjectId ? 1 : 0;
    const db = b.meta?.parentProjectId ? 1 : 0;
    if (da !== db) return da - db;
    const ta = Number(a.meta?.tasks) || 0;
    const tb = Number(b.meta?.tasks) || 0;
    if (ta !== tb) return tb - ta;
  }
  return (b.weight || 0) - (a.weight || 0) || a.label.localeCompare(b.label);
}

/** Re-route edges onto the items that represent their endpoints; dedupes and caps. */
export function routeEdges(edges, memberOf, cap = 2500) {
  const seen = new Map();
  for (const e of edges) {
    const a = memberOf.get(e.source);
    const b = memberOf.get(e.target);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const prev = seen.get(key);
    if (prev) { prev.count++; continue; }
    seen.set(key, { source: a, target: b, rel: e.rel, inferred: e.inferred, count: 1 });
    if (seen.size >= cap) break;
  }
  return [...seen.values()];
}

// ── Layout (deterministic cluster layout, no force simulation) ──────────────

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** World radius of an item. */
export function radiusOf(item) {
  if (item.superKind) return 11 + Math.min(16, Math.log2(item.count + 1) * 2.6);
  const n = item.node;
  if (n.kind === 'project') return n.meta?.parentProjectId ? 8 : 12 + Math.min(4, (Number(n.meta?.tasks) || 0) / 120);
  if (n.kind === 'client') return 8;
  if (n.kind === 'task' || n.kind === 'row') return 4.5;
  return 5.5;
}

/**
 * Lay groups out as packed discs; inside a group, items sit on a phyllotaxis
 * (sunflower) spiral, so spacing is even and generous at any size and the
 * hub (index 0) is in the middle. Deterministic: same input → same picture.
 */
export function layoutClusters(groups, opts = {}) {
  const spacing = opts.spacing ?? 30;
  const groupGap = opts.groupGap ?? 70;
  // Stretch the packing spiral to the viewport's shape (h / w): tall on a
  // phone in portrait, wide in landscape, so "fit" uses the whole screen.
  const aspect = Math.max(0.45, Math.min(2.2, Number(opts.aspect) || 0.82));
  const ax = 1 / Math.sqrt(aspect);
  const ay = Math.sqrt(aspect);
  const discs = [];
  const positioned = [];
  for (const g of groups) {
    const items = g.items;
    let maxR = 0;
    for (const it of items) maxR = Math.max(maxR, radiusOf(it));
    const local = items.map((it, i) => {
      const r = i === 0 ? 0 : spacing * Math.sqrt(i + 0.6);
      const a = i * GOLDEN;
      return { it, x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
    const R = spacing * Math.sqrt(items.length + 0.6) + maxR + 26; // room for the title
    discs.push({ g, R, local });
  }
  // Greedy spiral packing: biggest disc at the origin, every next one at the
  // first spiral position that clears all placed discs by `groupGap`.
  const placed = [];
  // Discs arrive biggest first, so the spiral search resumes a little behind
  // where the previous disc landed instead of from the centre every time —
  // O(n·window) rather than O(n²·steps) for hundreds of small families.
  let cursor = 0;
  for (const d of discs) {
    let cx = 0;
    let cy = 0;
    if (placed.length) {
      let found = false;
      const from = Math.max(1, cursor - 160);
      for (let step = from; step < from + 20000 && !found; step++) {
        const rr = 24 * Math.sqrt(step);
        const a = step * GOLDEN;
        cx = Math.cos(a) * rr * ax;
        cy = Math.sin(a) * rr * ay;
        found = true;
        for (let i = placed.length - 1; i >= 0; i--) {
          const p = placed[i];
          if (Math.hypot(p.cx - cx, p.cy - cy) < p.R + d.R + groupGap) { found = false; break; }
        }
        if (found) cursor = step;
      }
    }
    placed.push({ cx, cy, R: d.R });
    for (const l of d.local) positioned.push({ ...l.it, x: cx + l.x, y: cy + l.y, r: radiusOf(l.it), group: d.g.key });
    d.cx = cx;
    d.cy = cy;
  }
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const d of discs) {
    minX = Math.min(minX, d.cx - d.R); maxX = Math.max(maxX, d.cx + d.R);
    minY = Math.min(minY, d.cy - d.R); maxY = Math.max(maxY, d.cy + d.R);
  }
  if (!discs.length) { minX = minY = -100; maxX = maxY = 100; }
  return {
    items: positioned,
    groups: discs.map((d) => ({ key: d.g.key, title: d.g.title, size: d.g.size, x: d.cx, y: d.cy, R: d.R, hub: d.g.hub, kind: d.g.kind, status: d.g.status })),
    bounds: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
  };
}

/** One call: filter → group/collapse → layout → routed edges. */
export function buildGraphView(snapshot, opts = {}) {
  const f = filterGraph(snapshot, opts);
  const { groups, memberOf } = groupAndCollapse(f.nodes, f.index, opts);
  const layout = layoutClusters(groups, opts);
  const edges = routeEdges(f.edges, memberOf, opts.edgeCap);
  return { ...layout, edges, memberOf, index: f.index, fullIndex: f.fullIndex, nodeCount: f.nodes.length };
}

// ── Camera + LOD ────────────────────────────────────────────────────────────

/** Fit the world bounds into a w×h viewport: screen = k·p + (x, y). */
export function fitCamera(bounds, w, h, pad = 24) {
  const bw = Math.max(1, bounds.width);
  const bh = Math.max(1, bounds.height);
  const k = Math.max(0.02, Math.min(4, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)));
  return { k, x: w / 2 - k * (bounds.minX + bw / 2), y: h / 2 - k * (bounds.minY + bh / 2) };
}

/** Camera centred on world point (px, py) at zoom k. */
export function centerOn(px, py, k, w, h) {
  return { k, x: w / 2 - k * px, y: h / 2 - k * py };
}

/**
 * Which labels to draw at an on-screen scale. Returns 'all' | 'anchors' |
 * 'hubs': hubs = top-level projects + super-nodes only, anchors = + every
 * project/client, all = every visible node (still collision-culled).
 */
export function labelTier(k) {
  if (k >= 1.1) return 'all';
  if (k >= 0.55) return 'anchors';
  return 'hubs';
}

export function wantsLabel(item, tier) {
  if (item.superKind) return true;
  const n = item.node;
  if (tier === 'all') return true;
  if (tier === 'anchors') return n.kind === 'project' || n.kind === 'client';
  return n.kind === 'project' && !n.meta?.parentProjectId;
}

/**
 * Greedy, priority-ordered label placement in screen space (mirrors the web
 * placeLabels). `cands` are { x, y, w, h } boxes; returns accepted indices.
 */
export function placeLabels(cands, budget = 160) {
  const placed = [];
  const out = [];
  for (let i = 0; i < cands.length && out.length < budget; i++) {
    const c = cands[i];
    let clash = false;
    for (const p of placed) {
      if (c.x < p.x + p.w && c.x + c.w > p.x && c.y < p.y + p.h && c.y + c.h > p.y) { clash = true; break; }
    }
    if (clash) continue;
    placed.push(c);
    out.push(i);
  }
  return out;
}

/** Nearest item to a screen point within its radius (+ a finger tolerance). */
export function hitTest(items, cam, sx, sy, tolerancePx = 14) {
  const wx = (sx - cam.x) / cam.k;
  const wy = (sy - cam.y) / cam.k;
  let best = null;
  let bestD = Infinity;
  for (const it of items) {
    const d = Math.hypot(it.x - wx, it.y - wy);
    const reach = it.r + tolerancePx / cam.k;
    if (d <= reach && d < bestD) { best = it; bestD = d; }
  }
  return best;
}

// ── Detail helpers ──────────────────────────────────────────────────────────

/** Connections of a node for the detail sheet, stored links first. */
export function connectionsOf(nodeId, index, limit = 40) {
  const out = [];
  for (const l of index.adj.get(nodeId) || []) {
    const n = index.byId.get(l.id);
    if (n) out.push({ node: n, rel: l.rel, inferred: !!l.inferred, out: l.out });
  }
  out.sort((a, b) => Number(a.inferred) - Number(b.inferred) || KIND_ORDER.indexOf(visualKind(a.node)) - KIND_ORDER.indexOf(visualKind(b.node)) || a.node.label.localeCompare(b.node.label));
  return out.slice(0, limit);
}

/** Facts for the detail sheet. */
export function detailFacts(node) {
  const m = node?.meta || {};
  const out = [];
  if (node.kind === 'project') {
    if (m.status) out.push({ label: 'Status', value: String(m.status) });
    out.push({ label: 'Health', value: HEALTH_LABEL[healthOf(m)] });
    if (Number.isFinite(m.tasks)) out.push({ label: 'Tasks', value: `${m.done || 0}/${m.tasks} done` });
    if (Number.isFinite(m.progress)) out.push({ label: 'Progress', value: `${Math.round(m.progress * 100)}%` });
    if (m.inProgress) out.push({ label: 'In progress', value: String(m.inProgress) });
    if (m.review) out.push({ label: 'In review', value: String(m.review) });
    if (m.blocked) out.push({ label: 'Blocked', value: String(m.blocked) });
  } else {
    if (m.status) out.push({ label: 'Status', value: String(m.status) });
    if (m.priority) out.push({ label: 'Priority', value: String(m.priority) });
    if (m.category) out.push({ label: 'Category', value: String(m.category) });
    if (m.pipelineStatus) out.push({ label: 'Pipeline', value: String(m.pipelineStatus) });
    if (m.surface) out.push({ label: 'Surface', value: String(m.surface) });
  }
  const ts = m.lastActivityAt || m.updatedAt || m.createdAt || m.endedAt || m.startedAt;
  if (Number.isFinite(ts)) out.push({ label: 'Updated', value: relativeAge(ts) });
  if (Array.isArray(m.reasons) && m.reasons.length) out.push({ label: 'Why', value: m.reasons.join('; ') });
  return out;
}

export function relativeAge(ms, now = Date.now()) {
  if (!ms) return 'never';
  const d = Math.max(0, now - ms);
  const min = Math.floor(d / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 60) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function slugify(label, id) {
  const s = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s ? `${s}--${id}` : id;
}

/** Web path for "Open on web" (mirrors openTargetFor in knowledge-graph-model.ts). */
export function webPathFor(node) {
  const raw = storeIdOf(node);
  switch (node.kind) {
    case 'project': return `/projects/${encodeURIComponent(slugify(node.label, raw))}`;
    case 'client': return `/clients/${encodeURIComponent(slugify(node.label, raw))}`;
    case 'note': return raw.startsWith('doc:') ? `/documents/${encodeURIComponent(raw.slice(4))}` : `/notes/${encodeURIComponent(slugify(node.label, raw))}`;
    case 'task': return `/tasks/${encodeURIComponent(slugify(node.label, raw))}`;
    case 'opportunity': return '/opportunities';
    case 'decision': return '/decisions';
    case 'person': return '/people';
    case 'product': return '/products';
    case 'issue': return '/issues';
    case 'report': return '/reports';
    case 'content': return '/content-pages';
    case 'agent': return '/agents';
    case 'run': return `/reviews?run=${encodeURIComponent(node.meta?.runId || raw)}`;
    case 'idea': return '/notes';
    default: return '/knowledge-graph';
  }
}

/**
 * Native destination for "Open in app" — a navigateToScreen() entry, or null
 * when the phone has no page for the kind (the web link still works).
 */
export function appTargetFor(node) {
  const raw = storeIdOf(node);
  switch (node.kind) {
    case 'project': return { tab: 'Board', params: { projectId: raw }, title: node.label };
    case 'task': return { tab: 'Board', params: { taskId: raw }, title: node.label };
    case 'idea': return { tab: 'Knowledge', params: { screen: 'Ideas' }, title: 'Ideas' };
    case 'note': return { tab: 'Knowledge', params: { screen: 'Notes' }, title: 'Notes' };
    case 'report': return { screen: 'ReportsScreen', params: { reportId: raw }, title: 'Reports' };
    case 'run': return { screen: 'OversightScreen', params: { runId: node.meta?.runId || raw }, title: 'Run' };
    case 'agent': return { screen: 'AgentsScreen', title: 'Agents' };
    case 'opportunity': return { businessScreen: 'Opportunities', title: 'Opportunities' };
    case 'decision': return { businessScreen: 'Decisions', title: 'Decisions' };
    case 'person': return { businessScreen: 'People', title: 'People' };
    case 'client': return { businessScreen: 'Clients', title: 'Clients' };
    default: return null;
  }
}

/** Prompt for "Ask AI about this" (chat draft), with the node's neighbourhood. */
export function aiPromptFor(node, index) {
  const lines = [`Tell me about this ${KIND_SINGULAR[visualKind(node)] || node.kind} from my knowledge graph: "${node.label}".`];
  const facts = detailFacts(node).map((f) => `${f.label}: ${f.value}`);
  if (facts.length) lines.push(facts.join(' · '));
  const conns = connectionsOf(node.id, index, 12);
  if (conns.length) {
    lines.push('Connected to: ' + conns.map((c) => `${c.node.label} (${KIND_SINGULAR[visualKind(c.node)] || c.node.kind}, ${c.rel})`).join('; ') + '.');
  }
  lines.push('Summarise where it stands, what is blocking it, and the next best actions.');
  return lines.join('\n');
}

// ── Mutation planners (mirror knowledge-graph-ops.ts) ───────────────────────

export const LINKABLE_KINDS = new Set(['project', 'task', 'client', 'opportunity', 'product', 'person', 'decision', 'issue', 'note', 'report', 'content', 'agent']);

const TYPED_EDGES = {
  'client>opportunity': 'client_has_opportunity',
  'opportunity>project': 'opportunity_becomes_project',
  'project>task': 'project_has_task',
  'project>product': 'project_delivers_product',
  'product>opportunity': 'product_offered_in_opportunity',
  'decision>task': 'decision_guides_task',
  'task>person': 'task_assigned_to_person',
  'issue>task': 'issue_relates_task',
  'report>client': 'report_documents_client',
  'report>opportunity': 'report_documents_opportunity',
  'report>project': 'report_documents_project',
};

/** objrel.link between two nodes, typed edge when the pair has one. */
export function planLink(a, b, index) {
  if (!a || !b) return { ok: false, reason: 'Pick two nodes to link.' };
  if (a.id === b.id) return { ok: false, reason: "A node can't link to itself." };
  if (!LINKABLE_KINDS.has(a.kind) || !LINKABLE_KINDS.has(b.kind)) {
    const bad = !LINKABLE_KINDS.has(a.kind) ? a : b;
    return { ok: false, reason: `${KIND_LABEL[bad.kind] || bad.kind} can't be linked from the graph.` };
  }
  if (index && (index.adj.get(a.id) || []).some((l) => l.id === b.id)) return { ok: false, reason: 'These are already linked.' };
  let from = a;
  let to = b;
  let edge = TYPED_EDGES[`${a.kind}>${b.kind}`];
  if (!edge && TYPED_EDGES[`${b.kind}>${a.kind}`]) {
    edge = TYPED_EDGES[`${b.kind}>${a.kind}`];
    from = b;
    to = a;
  }
  edge = edge || 'relates_to';
  return {
    ok: true,
    call: { method: 'objrel.link', params: { fromType: from.kind, fromId: storeIdOf(from), toType: to.kind, toId: storeIdOf(to), edge, createdBy: 'knowledge-graph' } },
    label: `Linked "${a.label}" and "${b.label}"`,
  };
}

/** Move a task / note / sub-project under another project. */
export function planMove(node, target, index) {
  if (!node || !target) return { ok: false, reason: 'Pick a project.' };
  if (target.kind !== 'project') return { ok: false, reason: 'Move onto a project.' };
  if (node.id === target.id) return { ok: false, reason: 'Same project.' };
  const id = storeIdOf(node);
  const to = storeIdOf(target);
  if (node.kind === 'note' && id.startsWith('doc:')) return { ok: false, reason: 'Documents are edited on the Documents page.' };
  if (node.kind === 'task') {
    const from = typeof node.meta?.projectId === 'string' ? node.meta.projectId : null;
    if (from === to) return { ok: false, reason: `Already in ${target.label}.` };
    return { ok: true, call: { method: 'kanban.tasks.update', params: { id, projectId: to } }, undo: { method: 'kanban.tasks.update', params: { id, projectId: from } }, label: `Moved "${node.label}" to ${target.label}` };
  }
  if (node.kind === 'note') {
    const own = index ? owningProjectOf(node, index) : null;
    const from = own ? storeIdOf(index.byId.get(own)) : null;
    if (from === to) return { ok: false, reason: `Already in ${target.label}.` };
    return { ok: true, call: { method: 'notes.update', params: { id, projectId: to } }, undo: { method: 'notes.update', params: { id, projectId: from || '' } }, label: `Filed "${node.label}" under ${target.label}` };
  }
  if (node.kind === 'project') {
    const from = typeof node.meta?.parentProjectId === 'string' && node.meta.parentProjectId ? node.meta.parentProjectId : null;
    if (from === to) return { ok: false, reason: `Already under ${target.label}.` };
    // Cycle guard: the target must not sit under the node being moved.
    if (index) {
      let cur = target.id;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        if (cur === node.id) return { ok: false, reason: `${target.label} sits under ${node.label} — that would make a loop.` };
        seen.add(cur);
        cur = parentProjectOf(index.byId.get(cur), index);
      }
    }
    return { ok: true, call: { method: 'kanban.projects.update', params: { id, parentProjectId: to } }, undo: { method: 'kanban.projects.update', params: { id, parentProjectId: from } }, label: `Made "${node.label}" a sub-project of ${target.label}` };
  }
  return { ok: false, reason: `${KIND_LABEL[node.kind] || node.kind} belong to their own pages — link instead.` };
}

export const SET_STATUSES = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'todo', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];
const PROJECT_STATUS_FOR = { backlog: 'Not started', todo: 'Not started', in_progress: 'In progress', review: 'Reviewing', done: 'Completed' };

/** Status change for a task (kanban vocabulary) or project (project vocabulary). */
export function planStatus(node, status) {
  if (!node) return { ok: false, reason: 'Nothing selected.' };
  if (!PROJECT_STATUS_FOR[status]) return { ok: false, reason: 'Unknown status.' };
  const id = storeIdOf(node);
  const prev = typeof node.meta?.status === 'string' ? node.meta.status : undefined;
  if (node.kind === 'task') {
    if (prev === status) return { ok: false, reason: `Already ${status.replace('_', ' ')}.` };
    return { ok: true, call: { method: 'kanban.tasks.update', params: { id, status } }, undo: prev ? { method: 'kanban.tasks.update', params: { id, status: prev } } : null, label: `"${node.label}" → ${status.replace('_', ' ')}` };
  }
  if (node.kind === 'project') {
    const next = PROJECT_STATUS_FOR[status];
    if (prev === next) return { ok: false, reason: `Already ${next}.` };
    return { ok: true, call: { method: 'kanban.projects.update', params: { id, status: next } }, undo: prev ? { method: 'kanban.projects.update', params: { id, status: prev } } : null, label: `"${node.label}" → ${next}` };
  }
  return { ok: false, reason: `${KIND_LABEL[node.kind] || node.kind} have no task status.` };
}

/** Run a planned call through `sendReq`, returning { ok, error? }. */
export async function runPlan(sendReq, plan) {
  if (!plan?.ok) return { ok: false, error: plan?.reason || 'Nothing to do.' };
  try {
    const res = await sendReq(plan.call.method, plan.call.params);
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
