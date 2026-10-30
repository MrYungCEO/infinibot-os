/**
 * topology-model — pure data + layout logic for the native Agency Topology.
 *
 * A 1:1 port of the web page's projection (ui/src/ui/controllers/agency-topology.ts
 * + ui/src/ui/views/agency-topology.ts): the same scopes, the same semantic
 * encoding (shape = what it is, colour = health, size = weight), the same focus
 * rules and the same detail / summary / list derivations. Only the layout is
 * phone-shaped: bands stack vertically in portrait and sit side by side in
 * landscape, and project tiles wrap under their client instead of running off a
 * narrow screen.
 *
 * No React / React Native imports here — every function is unit-tested in
 * src/__tests__/agency-topology.test.js.
 *
 * Tones are kit tone NAMES ('primary' | 'success' | 'info' | 'warning' |
 * 'danger' | 'neutral'); the screen resolves them through the live theme.
 */

export const TOPOLOGY_TOP_CLIENTS = 12;
/** Hard ceiling on drawn nodes — past this the list view is the honest answer. */
export const MAX_GRAPH_NODES = 320;
/** Above this many drawn clients the delivery band becomes an unlabelled packed grid. */
export const DENSE_CLIENT_THRESHOLD = 26;
/** Unlinked projects beyond this collapse into their "No client" anchor (tap → focus). */
export const MAX_UNLINKED_TILES = 24;

export const SCOPE_LABELS = {
  active: 'Active clients only',
  top: `Top ${TOPOLOGY_TOP_CLIENTS} by revenue`,
  all: 'All clients (slow)',
  none: 'Hide clients',
};

export const SCOPE_OPTIONS = [
  { key: 'active', label: 'Active clients' },
  { key: 'top', label: `Top ${TOPOLOGY_TOP_CLIENTS}` },
  { key: 'all', label: 'All clients' },
  { key: 'none', label: 'Hide clients' },
];

export function createTopologyState() {
  return {
    agencies: [],
    agencyId: null,
    agencyName: '',
    clients: [],
    projects: [],
    workers: [],
    assignments: [],
    hierarchyPartial: false,
    failedRequests: [],
    lastLoadedAt: null,
    clientScope: 'active',
    showProjects: true,
    showWorkforce: true,
    search: '',
    focus: null,
  };
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function money(cents, currency = 'USD') {
  const value = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `$${Math.round(value)}`;
  }
}

export function relativeTime(value, now = Date.now()) {
  if (!value) return 'never';
  const delta = now - value;
  const abs = Math.abs(delta);
  const minutes = Math.round(abs / 60000);
  if (minutes < 1) return delta >= 0 ? 'just now' : 'in under a minute';
  if (minutes < 60) return delta >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return delta >= 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return delta >= 0 ? `${days}d ago` : `in ${days}d`;
}

export function shortDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Truncates to `max` characters with a trailing ellipsis character. */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (!max || s.length <= max) return s;
  if (max <= 1) return s.slice(0, 1);
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

export const statusLabel = (status) => String(status || 'unknown').replace(/_/g, ' ');

// ── Response normalisation ────────────────────────────────────────────────

/** `{ key: [...] }` or a bare value — older / newer gateways differ. */
export function unwrap(value, key, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value) && key in value) {
    const inner = value[key];
    return inner ?? fallback;
  }
  return value ?? fallback;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v, fallback = '') => (typeof v === 'string' && v ? v : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);

export function normalizeAgencies(raw) {
  return arr(unwrap(raw, 'agencies', []))
    .filter((a) => a && a.id)
    .map((a) => ({ id: String(a.id), name: str(a.name, 'Agency'), role: str(a.role, 'member') }));
}

export function normalizeClients(raw) {
  return arr(unwrap(raw, 'clients', []))
    .filter((c) => c && c.id)
    .map((c) => ({
      id: String(c.id),
      name: str(c.name, 'Unnamed client'),
      status: str(c.status, 'prospect'),
      pipelineStatus: typeof c.pipelineStatus === 'string' ? c.pipelineStatus : undefined,
      pipelineStatusLabel: typeof c.pipelineStatusLabel === 'string' ? c.pipelineStatusLabel : undefined,
      billingEmail: typeof c.billingEmail === 'string' && c.billingEmail ? c.billingEmail : null,
      projectCount: num(c.projectCount),
      invoiceCount: num(c.invoiceCount),
      lifetimeInvoicedCents: num(c.lifetimeInvoicedCents),
      outstandingCents: num(c.outstandingCents),
      mrrCents: num(c.mrrCents),
    }));
}

export function normalizeProjects(raw) {
  return arr(unwrap(raw, 'projects', []))
    .filter((p) => p && p.id)
    .map((p) => ({
      id: String(p.id),
      clientId: p.clientId ? String(p.clientId) : null,
      name: str(p.name, 'Untitled project'),
      status: str(p.status, 'planned'),
      budgetCents: num(p.budgetCents),
      mrrCents: num(p.mrrCents),
      targetEndAt: typeof p.targetEndAt === 'number' && p.targetEndAt > 0 ? p.targetEndAt : null,
    }));
}

export function normalizeEmployees(raw) {
  return arr(unwrap(raw, 'employees', []))
    .filter((e) => e && e.id)
    .map((e) => ({
      id: String(e.id),
      name: str(e.name, 'Unnamed'),
      kind: e.kind === 'ai' ? 'ai' : 'human',
      role: str(e.role, 'Worker'),
      department: str(e.department, 'General'),
      availability: str(e.availability, 'unknown'),
      capacityHours: num(e.capacityHours),
      allocatedHours: num(e.allocatedHours),
      utilizationPercent: num(e.utilizationPercent),
      activeWork: num(e.activeWork),
      managerName: typeof e.managerName === 'string' && e.managerName ? e.managerName : undefined,
      managerWorkerId: e.managerWorkerId ? String(e.managerWorkerId) : null,
    }));
}

export function normalizeAssignments(raw) {
  return arr(unwrap(raw, 'assignments', []))
    .filter((a) => a && a.id)
    .map((a) => ({
      id: String(a.id),
      title: str(a.title),
      status: str(a.status, 'planned'),
      members: arr(a.members)
        .filter((m) => m && m.workerId)
        .map((m) => ({ workerId: String(m.workerId), role: str(m.role) })),
    }));
}

/** `agency.ops.employee.detail` → the manager edge (only place it is exposed). */
export function managerFromDetail(raw) {
  const record = unwrap(raw, 'employee', {}) || {};
  return record.managerWorkerId ? String(record.managerWorkerId) : null;
}

/** Same choice as the web: preferred id, else the owned agency, else the first. */
export function pickAgency(agencies, preferredId) {
  return (
    agencies.find((a) => a.id === preferredId) ||
    agencies.find((a) => a.role === 'owner') ||
    agencies[0] ||
    null
  );
}

export function normalizeRelations(raw, key) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const linked = record.client && typeof record.client === 'object' ? record.client : null;
  return {
    key,
    loading: false,
    error: null,
    projects: arr(record.projects).map((p) => ({ id: str(p.id), name: str(p.name, 'Untitled project'), status: str(p.status, 'unknown') })),
    contacts: arr(record.contacts).map((c) => ({ id: str(c.id), name: str(c.name, 'Unnamed contact'), email: typeof c.email === 'string' ? c.email : null, isPrimary: c.isPrimary === true })),
    tasks: arr(record.tasks).map((t) => ({ id: str(t.id), title: str(t.title, 'Untitled task'), status: str(t.status, 'unknown') })),
    invoices: arr(record.invoices).map((i) => ({ id: str(i.id), status: str(i.status, 'unknown'), totalCents: num(i.totalCents) })),
    totals: record.totals && typeof record.totals === 'object' ? record.totals : null,
    clientId: linked ? str(linked.id) || null : null,
    clientName: linked ? str(linked.name) || null : null,
  };
}

export function relationsSummary(relations) {
  const openTasks = relations.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length;
  return `${relations.contacts.length} contacts · ${relations.tasks.length} tasks (${openTasks} open) · ${relations.invoices.length} invoices`;
}

// ── Scope ───────────────────────────────────────────────────────────────────

export function scopedClients(state) {
  if (state.clientScope === 'none') return [];
  if (state.clientScope === 'all') return state.clients;
  if (state.clientScope === 'active') {
    return state.clients.filter(
      (c) => c.pipelineStatus === 'in progress' || (c.pipelineStatus === undefined && c.status === 'active'),
    );
  }
  return [...state.clients]
    .sort(
      (a, b) =>
        b.mrrCents - a.mrrCents ||
        b.lifetimeInvoicedCents - a.lifetimeInvoicedCents ||
        b.projectCount - a.projectCount ||
        a.name.localeCompare(b.name),
    )
    .slice(0, TOPOLOGY_TOP_CLIENTS);
}

export function scopedProjects(state, clients) {
  if (!state.showProjects) return [];
  const visible = new Set(clients.map((c) => c.id));
  return state.projects.filter((p) => p.status !== 'cancelled' && (!p.clientId || visible.has(p.clientId)));
}

// ── Semantic encoding ──────────────────────────────────────────────────────

export function clientTone(client) {
  if (client.status === 'active') return 'success';
  if (client.status === 'prospect') return 'info';
  return 'neutral';
}

export function projectTone(project, now = Date.now()) {
  if (project.status === 'completed') return 'neutral';
  if (project.status === 'on_hold') return 'warning';
  if (project.targetEndAt && project.targetEndAt < now && project.status !== 'cancelled') return 'danger';
  if (project.status === 'active') return 'info';
  return 'neutral';
}

export function projectHealthLabel(project, now = Date.now()) {
  const tone = projectTone(project, now);
  if (tone === 'danger') return 'past target date';
  if (tone === 'warning') return 'on hold';
  if (tone === 'info') return 'active';
  return statusLabel(project.status);
}

export function utilizationTone(percent) {
  if (percent >= 100) return 'danger';
  if (percent >= 85) return 'warning';
  if (percent >= 35) return 'success';
  return 'neutral';
}

export function clientWeight(client, basis) {
  if (basis === 'projects') return client.projectCount;
  return Math.max(client.mrrCents, Math.round(client.lifetimeInvoicedCents / 12));
}

export function weightBasisFor(clients) {
  return clients.some((c) => clientWeight(c, 'revenue') > 0) ? 'revenue' : 'projects';
}

export function clientRadius(client, maxWeight, dense, basis) {
  const weight = clientWeight(client, basis);
  const min = dense ? 6 : 9;
  const span = dense ? 5 : 11;
  if (maxWeight <= 0) return min + span * 0.35;
  return min + span * Math.sqrt(Math.min(1, weight / maxWeight));
}

// ── Node ids ────────────────────────────────────────────────────────────────

export const nodeKey = (kind, id) => `${kind}:${id}`;
export const selectionKey = (selection) => (selection ? `${selection.kind}:${selection.id}` : '');

export function parseNodeId(id) {
  const index = String(id).indexOf(':');
  if (index < 0) return null;
  const kind = id.slice(0, index);
  if (!['agency', 'client', 'project', 'worker', 'aggregate'].includes(kind)) return null;
  return { kind, id: id.slice(index + 1) };
}

// ── Graph model ─────────────────────────────────────────────────────────────

function workerTree(workers) {
  const slots = new Map();
  const ids = new Set(workers.map((w) => w.id));
  const childrenOf = new Map();
  const roots = [];
  for (const worker of [...workers].sort((a, b) => a.name.localeCompare(b.name))) {
    const m = worker.managerWorkerId;
    if (m && ids.has(m) && m !== worker.id) childrenOf.set(m, [...(childrenOf.get(m) || []), worker]);
    else roots.push(worker);
  }
  let nextRow = 0;
  const assign = (worker, depth, guard) => {
    if (slots.has(worker.id)) return slots.get(worker.id).slot;
    const children = guard > 8 ? [] : childrenOf.get(worker.id) || [];
    if (!children.length) {
      const slot = nextRow++;
      slots.set(worker.id, { depth, slot });
      return slot;
    }
    slots.set(worker.id, { depth, slot: nextRow }); // cycle guard placeholder
    const childSlots = children.map((child) => assign(child, depth + 1, guard + 1));
    const slot = (Math.min(...childSlots) + Math.max(...childSlots)) / 2;
    slots.set(worker.id, { depth, slot });
    return slot;
  };
  for (const root of roots) assign(root, 0, 0);
  // A pure cycle has no root — give anything unplaced its own row.
  for (const worker of workers) if (!slots.has(worker.id)) slots.set(worker.id, { depth: 0, slot: nextRow++ });
  const maxDepth = Math.max(0, ...[...slots.values()].map((s) => s.depth));
  return { slots, roots, maxDepth, rows: Math.max(1, nextRow) };
}

/**
 * Projects the loaded agency onto nodes + edges (the web's buildGraph), honouring
 * scope, layers, the node ceiling and focus.
 */
export function buildTopology(state, now = Date.now()) {
  const nodes = [];
  const edges = [];
  const clients = scopedClients(state);
  const projects = scopedProjects(state, clients);
  const workers = state.showWorkforce ? state.workers : [];
  const agencyKey = nodeKey('agency', state.agencyId || 'agency');
  const dense = clients.length > DENSE_CLIENT_THRESHOLD;
  const weightBasis = weightBasisFor(clients);
  const maxWeight = clients.reduce((max, c) => Math.max(max, clientWeight(c, weightBasis)), 0);

  nodes.push({
    id: agencyKey,
    kind: 'agency',
    name: state.agencyName || 'Agency',
    shape: 'hexagon',
    size: 20,
    tone: 'primary',
    labelPlacement: 'below',
    description: `${state.clients.length} clients · ${state.projects.length} projects · ${state.workers.length} workers`,
  });

  const tree = workerTree(workers);
  const workerIds = new Set(workers.map((w) => w.id));
  for (const worker of workers) {
    if (nodes.length >= MAX_GRAPH_NODES) break;
    const key = nodeKey('worker', worker.id);
    const depth = tree.slots.get(worker.id)?.depth ?? 0;
    const reports = workers.filter((w) => w.managerWorkerId === worker.id).length;
    nodes.push({
      id: key,
      kind: 'worker',
      name: worker.name,
      shape: worker.kind === 'ai' ? 'diamond' : 'circle',
      size: depth === 0 ? 14 : depth === 1 ? 12 : 10,
      tone: utilizationTone(worker.utilizationPercent),
      accent: worker.kind === 'ai' ? 'primary' : 'info',
      labelPlacement: 'right',
      sublabel: `${worker.role}${reports ? ` · ${reports} report${reports > 1 ? 's' : ''}` : ''}`,
      description: `${worker.kind === 'ai' ? 'AI' : 'Human'} · ${worker.role} · ${worker.department} · ${Math.round(worker.utilizationPercent)}% utilised · ${worker.availability}`,
    });
    const m = worker.managerWorkerId;
    if (m && workerIds.has(m) && m !== worker.id) {
      edges.push({ id: `mgr-${key}`, kind: 'reports', source: nodeKey('worker', m), target: key });
    } else if (tree.roots.length <= 3) {
      edges.push({ id: `root-${key}`, kind: 'root', source: agencyKey, target: key });
    }
  }

  const drawnClients = new Set();
  for (const client of clients) {
    if (nodes.length >= MAX_GRAPH_NODES) break;
    const key = nodeKey('client', client.id);
    drawnClients.add(key);
    nodes.push({
      id: key,
      kind: 'client',
      name: client.name,
      shape: 'circle',
      size: clientRadius(client, maxWeight, dense, weightBasis),
      tone: clientTone(client),
      labelPlacement: dense ? 'none' : 'right',
      sublabel: dense
        ? undefined
        : `${weightBasis === 'revenue' ? `${money(client.mrrCents)}/mo · ` : ''}${client.projectCount} project${client.projectCount === 1 ? '' : 's'} · ${client.status}`,
      description: `${client.status} · ${client.projectCount} projects · ${money(client.mrrCents)} MRR · ${money(client.outstandingCents)} outstanding`,
    });
  }

  const unlinked = projects.filter((p) => !p.clientId);
  const unlinkedKey = nodeKey('aggregate', 'unlinked');
  if (unlinked.length && state.showProjects) {
    nodes.push({
      id: unlinkedKey,
      kind: 'aggregate',
      name: 'No client',
      shape: 'pill',
      size: 11,
      tone: 'warning',
      faint: true,
      labelPlacement: 'right',
      sublabel: `${unlinked.length} unassigned project${unlinked.length === 1 ? '' : 's'}`,
      description: `${unlinked.length} projects are not linked to a client`,
    });
  }

  for (const project of projects) {
    if (nodes.length >= MAX_GRAPH_NODES) break;
    const key = nodeKey('project', project.id);
    const parent = project.clientId ? nodeKey('client', project.clientId) : unlinkedKey;
    if (project.clientId && !drawnClients.has(parent)) continue;
    const tone = projectTone(project, now);
    nodes.push({
      id: key,
      kind: 'project',
      name: project.name,
      clientId: project.clientId,
      shape: 'roundedRect',
      size: 10,
      tone,
      labelPlacement: dense ? 'none' : 'below',
      description: `${projectHealthLabel(project, now)} · ${money(project.budgetCents)} budget${project.targetEndAt ? ` · target ${shortDate(project.targetEndAt)}` : ''}`,
    });
    edges.push({ id: `del-${key}`, kind: 'delivers', source: parent, target: key });
  }

  const hiddenClients = state.clients.length - clients.length;
  if (hiddenClients > 0) {
    nodes.push({
      id: nodeKey('aggregate', 'clients'),
      kind: 'aggregate',
      name: `+${hiddenClients} more clients`,
      shape: 'pill',
      size: 11,
      tone: 'neutral',
      faint: true,
      labelPlacement: 'right',
      sublabel: 'outside the current scope',
      description: `${hiddenClients} clients are outside “${SCOPE_LABELS[state.clientScope]}”`,
    });
  }

  // Assignment edges only when they resolve to a drawn project + worker.
  if (state.showWorkforce) {
    const drawnWorkers = new Set(nodes.filter((n) => n.kind === 'worker').map((n) => n.id));
    const projectByName = new Map(nodes.filter((n) => n.kind === 'project').map((n) => [n.name.toLowerCase(), n.id]));
    for (const assignment of state.assignments) {
      const projectId = projectByName.get((assignment.title || '').toLowerCase());
      if (!projectId) continue;
      for (const member of assignment.members || []) {
        const workerId = nodeKey('worker', member.workerId);
        if (!drawnWorkers.has(workerId)) continue;
        edges.push({ id: `asg-${assignment.id}-${member.workerId}`, kind: 'assigned', source: projectId, target: workerId, label: assignment.title });
      }
    }
  }

  const wanted = 1 + clients.length + projects.length + workers.length + (hiddenClients > 0 ? 1 : 0);
  const model = {
    nodes,
    edges,
    truncated: Math.max(0, wanted - nodes.length),
    clients,
    projects,
    workers,
    unlinkedProjects: unlinked.length,
    hiddenClients,
    dense,
    weightBasis,
    workerSlots: tree.slots,
    maxWorkerDepth: tree.maxDepth,
    workerRows: tree.rows,
  };

  const keep = focusedIds(state, model);
  if (keep) {
    model.nodes = model.nodes.filter((n) => keep.has(n.id));
    model.clients = model.clients.filter((c) => keep.has(nodeKey('client', c.id)));
    model.projects = model.projects.filter((p) => keep.has(nodeKey('project', p.id)));
    model.workers = model.workers.filter((w) => keep.has(nodeKey('worker', w.id)));
  }
  const drawn = new Set(model.nodes.map((n) => n.id));
  model.edges = model.edges.filter((e) => drawn.has(e.source) && drawn.has(e.target));
  return model;
}

/** The node ids a focus keeps (null = no focus). Same rules as the web. */
export function focusedIds(state, model) {
  const focus = state.focus;
  if (!focus) return null;
  const keep = new Set([nodeKey('agency', state.agencyId || 'agency')]);
  if (focus.kind === 'worker') {
    const byId = new Map(state.workers.map((w) => [w.id, w]));
    let cursor = byId.get(focus.id);
    let guard = 0;
    while (cursor && guard++ < 12) {
      keep.add(nodeKey('worker', cursor.id));
      cursor = cursor.managerWorkerId ? byId.get(cursor.managerWorkerId) : undefined;
    }
    const queue = [focus.id];
    while (queue.length) {
      const current = queue.shift();
      for (const worker of state.workers) {
        if (worker.managerWorkerId !== current) continue;
        if (keep.has(nodeKey('worker', worker.id))) continue;
        keep.add(nodeKey('worker', worker.id));
        queue.push(worker.id);
      }
    }
  } else if (focus.kind === 'client') {
    keep.add(nodeKey('client', focus.id));
    for (const p of model.projects) if (p.clientId === focus.id) keep.add(nodeKey('project', p.id));
  } else if (focus.kind === 'project') {
    keep.add(nodeKey('project', focus.id));
    const project = model.projects.find((p) => p.id === focus.id);
    if (project?.clientId) keep.add(nodeKey('client', project.clientId));
  } else if (focus.kind === 'aggregate' && focus.id === 'unlinked') {
    keep.add(nodeKey('aggregate', 'unlinked'));
    for (const p of model.projects) if (!p.clientId) keep.add(nodeKey('project', p.id));
  } else {
    return null;
  }
  return keep;
}

/** Toggle semantics of the web's setTopologyFocus: same node again clears it. */
export function toggleFocus(current, next) {
  if (!next) return null;
  if (current && current.kind === next.kind && current.id === next.id) return null;
  return next;
}

export function isFocusable(selection) {
  if (!selection) return false;
  return (
    selection.kind === 'client' ||
    selection.kind === 'project' ||
    selection.kind === 'worker' ||
    (selection.kind === 'aggregate' && selection.id === 'unlinked')
  );
}

export function focusLabel(state) {
  const focus = state.focus;
  if (!focus) return '';
  if (focus.kind === 'worker') return state.workers.find((w) => w.id === focus.id)?.name || 'worker';
  if (focus.kind === 'client') return state.clients.find((c) => c.id === focus.id)?.name || 'client';
  if (focus.kind === 'aggregate') return 'projects with no client';
  return state.projects.find((p) => p.id === focus.id)?.name || 'project';
}

export function scopeNote(state, model) {
  return `Showing ${model.clients.length} of ${state.clients.length} clients, ${model.projects.length} of ${state.projects.length} projects, ${model.workers.length} of ${state.workers.length} workers.`;
}

// ── Layout ──────────────────────────────────────────────────────────────────

/** Approximate advance of a 12px monospace glyph — label budgets use it. */
export const CHAR_W = 7.2;
/** Narrowest map that lays the workforce and delivery bands side by side. */
export const SIDE_BY_SIDE_MIN_WIDTH = 560;
const charsFor = (px, min = 4, max = 30) => Math.max(min, Math.min(max, Math.floor(px / CHAR_W)));

/**
 * Deterministic phone layout in world units (1 unit = 1px at zoom 1).
 *
 *   stacked (portrait)   agency on top, the workforce org tree, then the
 *                        delivery band — the map is as wide as the viewport and
 *                        as tall as it needs to be (pan vertically).
 *   side by side (landscape)  workforce band left (40%), delivery right, like the web.
 *
 * Returns { nodes, edges, regions, bounds } — fresh objects, the model is not mutated.
 * Every node gets x, y, labelMax (chars), showSub and a final labelPlacement;
 * every edge gets an SVG path `d` in world space.
 */
export function layoutTopology(model, { width = 390, height = 600, stacked = true } = {}) {
  const W = Math.max(300, width);
  const pad = 10;
  const nodes = model.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const regions = [];
  const top = 78;

  const workerNodes = model.workers.map((w) => byId.get(nodeKey('worker', w.id))).filter(Boolean);
  const showWorkforce = workerNodes.length > 0;
  const showDelivery = nodes.some((n) => n.kind === 'client' || n.kind === 'project' || n.kind === 'aggregate');

  // Side by side only when each band still gets room for labels; a narrow
  // landscape map stacks like portrait instead of truncating every name.
  const sideBySide = !stacked && showWorkforce && showDelivery && W >= SIDE_BY_SIDE_MIN_WIDTH;
  const split = Math.round(W * 0.4);
  let workforceBox = { x0: pad, x1: W - pad };
  let deliveryBox = { x0: pad, x1: W - pad };
  if (sideBySide) {
    workforceBox = { x0: pad, x1: split - 6 };
    deliveryBox = { x0: split + 6, x1: W - pad };
  }

  const agency = nodes.find((n) => n.kind === 'agency');
  if (agency) {
    agency.x = sideBySide ? (workforceBox.x0 + workforceBox.x1) / 2 : W / 2;
    agency.y = 30;
    agency.labelMax = charsFor(W - 40, 6, 32);
  }

  // ── Workforce band ──
  let workforceBottom = top;
  if (showWorkforce) {
    const rowStep = 46;
    const columns = model.maxWorkerDepth + 1;
    const boxW = workforceBox.x1 - workforceBox.x0;
    const columnWidth = Math.max(64, Math.min(170, (boxW - 40) / Math.max(1, columns - 0.25)));
    const y0 = top + 30;
    for (const worker of model.workers) {
      const node = byId.get(nodeKey('worker', worker.id));
      const slot = model.workerSlots.get(worker.id);
      if (!node || !slot) continue;
      node.x = workforceBox.x0 + 22 + slot.depth * columnWidth;
      node.y = y0 + slot.slot * rowStep + rowStep / 2 - 6;
      const isLast = slot.depth >= model.maxWorkerDepth;
      const room = isLast ? workforceBox.x1 - (node.x + node.size + 8) - 6 : columnWidth - node.size - 14;
      node.labelMax = charsFor(room, 4, 26);
      node.showSub = true;
    }
    workforceBottom = y0 + model.workerRows * rowStep + 4;
    regions.push({ id: 'workforce', label: 'WORKFORCE · REPORTING LINES', tone: 'primary', x: workforceBox.x0, y: top, width: workforceBox.x1 - workforceBox.x0, height: workforceBottom - top });
  }

  // ── Delivery band ──
  let deliveryBottom = top;
  if (showDelivery) {
    const y0 = sideBySide || !showWorkforce ? top : workforceBottom + 14;
    const bx0 = deliveryBox.x0;
    const bx1 = deliveryBox.x1;
    const bandW = bx1 - bx0;
    const projectsByOwner = new Map();
    for (const project of model.projects) {
      const node = byId.get(nodeKey('project', project.id));
      if (!node) continue;
      const owner = project.clientId || '__none__';
      projectsByOwner.set(owner, [...(projectsByOwner.get(owner) || []), node]);
    }
    const unlinkedAnchor = byId.get(nodeKey('aggregate', 'unlinked'));
    const aggregate = byId.get(nodeKey('aggregate', 'clients'));
    let unlinkedTiles = projectsByOwner.get('__none__') || [];
    // A huge unassigned bucket collapses into its anchor; focusing it shows the tiles.
    let dropped = new Set();
    if (unlinkedAnchor && unlinkedTiles.length > MAX_UNLINKED_TILES) {
      dropped = new Set(unlinkedTiles.map((n) => n.id));
      unlinkedAnchor.sublabel = `${unlinkedTiles.length} projects · tap to focus`;
      unlinkedTiles = [];
    }

    let y = y0 + 34;
    const tileStep = 108;
    const tileRow = 50;
    const wrapX0 = bx0 + 46;
    const perRow = Math.max(1, Math.floor((bx1 - 8 - wrapX0) / tileStep));
    const placeWrapped = (tiles, startY) => {
      tiles.forEach((node, i) => {
        node.x = wrapX0 + tileStep * (0.5 + (i % perRow));
        node.y = startY + tileRow * Math.floor(i / perRow) + 12;
        node.labelMax = charsFor(tileStep - 10, 4, 15);
        node.labelPlacement = 'below';
        node.wrapped = true;
      });
      return startY + tileRow * Math.ceil(tiles.length / perRow);
    };

    if (model.dense) {
      // Packed, unlabelled client grid; projects as a packed grid under it.
      const clientNodes = model.clients.map((c) => byId.get(nodeKey('client', c.id))).filter(Boolean);
      const step = 28;
      const cols = Math.max(1, Math.floor((bandW - 20) / step));
      clientNodes.forEach((node, i) => {
        node.x = bx0 + 14 + step * (0.5 + (i % cols));
        node.y = y + step * Math.floor(i / cols);
        node.labelPlacement = 'none';
      });
      y += step * Math.ceil(clientNodes.length / cols) + 8;
      const projectNodes = model.projects
        .map((p) => byId.get(nodeKey('project', p.id)))
        .filter((n) => n && !dropped.has(n.id));
      projectNodes.forEach((node, i) => {
        node.x = bx0 + 14 + step * (0.5 + (i % cols));
        node.y = y + step * Math.floor(i / cols);
        node.labelPlacement = 'none';
      });
      if (projectNodes.length) y += step * Math.ceil(projectNodes.length / cols) + 8;
      for (const anchor of [unlinkedAnchor, aggregate]) {
        if (!anchor) continue;
        anchor.x = bx0 + 24;
        anchor.y = y + 8;
        anchor.labelMax = charsFor(bandW - 60, 6, 34);
        anchor.showSub = true;
        y += 46;
      }
      deliveryBottom = y + 4;
    } else {
      const rowH = 46;
      const inlineOffset = Math.min(200, bandW * 0.46);
      const placeAnchorRow = (anchor, tiles) => {
        anchor.x = bx0 + 22;
        anchor.y = y + 6;
        anchor.showSub = true;
        const runX0 = bx0 + inlineOffset;
        const runW = bx1 - 10 - runX0;
        if (!tiles.length) {
          anchor.labelMax = charsFor(bx1 - (anchor.x + anchor.size + 8) - 8, 6, 34);
          y += rowH;
          return;
        }
        if (tiles.length * 96 <= runW) {
          // Inline: the client's projects read straight across its row.
          const step = Math.min(140, runW / tiles.length);
          anchor.labelMax = charsFor(inlineOffset - anchor.size - 34, 6, 30);
          tiles.forEach((node, i) => {
            node.x = runX0 + step * (0.5 + i);
            node.y = anchor.y;
            node.labelPlacement = 'below';
            node.labelMax = charsFor(step - 8, 4, 18);
          });
          y += rowH + 14;
          return;
        }
        anchor.labelMax = charsFor(bx1 - (anchor.x + anchor.size + 8) - 8, 6, 34);
        y = placeWrapped(tiles, y + rowH - 4) + 6;
      };

      for (const client of model.clients) {
        const anchor = byId.get(nodeKey('client', client.id));
        if (!anchor) continue;
        placeAnchorRow(anchor, projectsByOwner.get(client.id) || []);
      }
      if (unlinkedAnchor) {
        const regionY = y - 4;
        y += 22;
        placeAnchorRow(unlinkedAnchor, unlinkedTiles);
        regions.push({ id: 'unassigned', label: 'UNASSIGNED TO A CLIENT', tone: 'warning', x: bx0 + 6, y: regionY, width: bandW - 12, height: y - regionY + 2, nested: true });
        y += 8;
      }
      if (aggregate) placeAnchorRow(aggregate, []);
      deliveryBottom = y + 2;
    }

    if (dropped.size) {
      for (const node of nodes) if (dropped.has(node.id)) node.dropped = true;
    }
    regions.push({
      id: 'delivery',
      label: model.dense ? 'CLIENTS · DELIVERY (TAP A NODE FOR ITS NAME)' : 'CLIENTS · DELIVERY',
      tone: 'info',
      x: bx0,
      y: y0,
      width: bandW,
      height: deliveryBottom - y0,
    });
  }

  // Side by side: both bands share the full height so they read as one frame.
  if (sideBySide) {
    const bandBottom = Math.max(workforceBottom, deliveryBottom, height - pad);
    for (const r of regions) if (!r.nested) r.height = bandBottom - r.y;
  }

  const placed = nodes.filter((n) => !n.dropped && Number.isFinite(n.x) && Number.isFinite(n.y));
  const placedIds = new Set(placed.map((n) => n.id));
  for (const n of placed) {
    if (n.labelMax == null) n.labelMax = 18;
    if (n.showSub == null) n.showSub = false;
  }
  const laidEdges = model.edges
    .filter((e) => placedIds.has(e.source) && placedIds.has(e.target))
    .map((e) => ({ ...e, d: edgePath(e, byId.get(e.source), byId.get(e.target), { busX: workforceBox.x0 + 6 }) }));

  let maxY = 0;
  for (const n of placed) maxY = Math.max(maxY, n.y + n.size + (n.labelPlacement === 'below' ? 22 : 18));
  for (const r of regions) maxY = Math.max(maxY, r.y + r.height);
  const bounds = { minX: 0, minY: 0, maxX: W, maxY: maxY + pad, width: W, height: maxY + pad };
  return { nodes: placed, edges: laidEdges, regions, bounds };
}

const r1 = (v) => Math.round(v * 10) / 10;

/** World-space SVG path for an edge. */
export function edgePath(edge, a, b, opts = {}) {
  if (!a || !b) return '';
  const ax = r1(a.x);
  const ay = r1(a.y);
  const bx = r1(b.x);
  const by = r1(b.y);
  if (edge.kind === 'reports') {
    // Org-chart trunk: straight down (or up) out of the manager, then across
    // to the report — the manager's right-hand label is never crossed.
    if (Math.abs(ay - by) < 0.5) return `M${ax} ${ay}H${bx}`;
    const sy = r1(ay + (by > ay ? 1 : -1) * (a.size || 0));
    return `M${ax} ${sy}V${by}H${bx}`;
  }
  if (edge.kind === 'delivers') {
    if (Math.abs(ay - by) < 0.5) return `M${ax} ${ay}H${bx}`;
    // Wrapped tile under its owner: drop down the owner's spine, then across.
    return `M${ax} ${ay}V${by}H${bx}`;
  }
  if (edge.kind === 'root') {
    // A bus off the agency's flank, down the band edge, into the apex of the
    // org — never across the tree or through the agency's own label.
    const busX = r1(Number.isFinite(opts.busX) ? opts.busX : Math.min(ax, bx) - 16);
    const startX = r1(ax - (a.size || 0));
    return `M${startX} ${ay}H${busX}V${by}H${bx}`;
  }
  // assigned: a soft arc bowed off the straight line.
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.max(1, Math.hypot(dx, dy));
  const bow = Math.min(60, len * 0.2);
  return `M${ax} ${ay}Q${r1(mx - (dy / len) * bow)} ${r1(my + (dx / len) * bow)} ${bx} ${by}`;
}

/** SVG path for a node shape centred on (x, y) with "radius" s (circle → null, draw a Circle). */
export function shapePath(shape, x, y, s) {
  const f = (v) => r1(v);
  if (shape === 'hexagon') {
    const pts = [];
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push(`${f(x + s * Math.cos(a))} ${f(y + s * Math.sin(a))}`);
    }
    return `M${pts.join('L')}Z`;
  }
  if (shape === 'diamond') return `M${f(x)} ${f(y - s)}L${f(x + s)} ${f(y)}L${f(x)} ${f(y + s)}L${f(x - s)} ${f(y)}Z`;
  if (shape === 'pill' || shape === 'roundedRect') {
    const hw = shape === 'pill' ? s * 1.5 : s * 1.3;
    const hh = shape === 'pill' ? s * 0.62 : s * 0.8;
    const r = shape === 'pill' ? hh : Math.min(4, hh);
    const x0 = x - hw;
    const x1 = x + hw;
    const y0 = y - hh;
    const y1 = y + hh;
    return `M${f(x0 + r)} ${f(y0)}H${f(x1 - r)}Q${f(x1)} ${f(y0)} ${f(x1)} ${f(y0 + r)}V${f(y1 - r)}Q${f(x1)} ${f(y1)} ${f(x1 - r)} ${f(y1)}H${f(x0 + r)}Q${f(x0)} ${f(y1)} ${f(x0)} ${f(y1 - r)}V${f(y0 + r)}Q${f(x0)} ${f(y0)} ${f(x0 + r)} ${f(y0)}Z`;
  }
  return null;
}

/** Half-width of a shape — where a right-hand label starts. */
export function shapeHalfWidth(node) {
  if (node.shape === 'pill') return node.size * 1.5;
  if (node.shape === 'roundedRect') return node.size * 1.3;
  return node.size;
}

// ── Camera ──────────────────────────────────────────────────────────────────
// Camera { k, x, y }: screen = world * k + (x, y).

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
export const clampZoom = (k) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k));

export function fitCamera(bounds, w, h, pad = 12) {
  const bw = Math.max(1, bounds.width);
  const bh = Math.max(1, bounds.height);
  const k = clampZoom(Math.min((w - pad * 2) / bw, (h - pad * 2) / bh));
  return { k, x: w / 2 - k * (bounds.minX + bw / 2), y: h / 2 - k * (bounds.minY + bh / 2) };
}

/**
 * Opening camera: fit everything when that keeps labels readable (k >= 0.8),
 * otherwise fit the width and start at the top so the user pans down.
 */
export function initialCamera(bounds, w, h) {
  const full = fitCamera(bounds, w, h);
  if (full.k >= 0.8) return full;
  const k = clampZoom(Math.min(1.2, (w - 8) / Math.max(1, bounds.width)));
  return { k, x: w / 2 - k * (bounds.minX + bounds.width / 2), y: 4 - k * bounds.minY };
}

/** Zoom by `factor` keeping screen point (sx, sy) fixed. */
export function zoomAt(cam, sx, sy, factor) {
  const k = clampZoom(cam.k * factor);
  const f = k / cam.k;
  return { k, x: sx - f * (sx - cam.x), y: sy - f * (sy - cam.y) };
}

/** Fold a gesture delta (translate dx,dy then scale ds about the viewport centre) into the camera. */
export function commitGesture(cam, w, h, dx, dy, ds) {
  const cx = w / 2;
  const cy = h / 2;
  const s = clampZoom(cam.k * ds) / cam.k;
  return { k: cam.k * s, x: cx + dx + s * (cam.x - cx), y: cy + dy + s * (cam.y - cy) };
}

export function centerOnNode(node, cam, w, h) {
  return { k: cam.k, x: w / 2 - cam.k * node.x, y: h / 2 - cam.k * node.y };
}

/**
 * Which node is under screen point (sx, sy)? Shapes get a generous touch
 * radius (>= 22 screen px ≈ a 44px target) and visible labels are tappable too.
 */
export function hitTest(nodes, cam, sx, sy) {
  const wx = (sx - cam.x) / cam.k;
  const wy = (sy - cam.y) / cam.k;
  let best = null;
  let bestD = Infinity;
  for (const n of nodes) {
    const half = shapeHalfWidth(n);
    const reach = Math.max(half + 6, 22 / cam.k);
    const d = Math.hypot(n.x - wx, n.y - wy);
    let hit = d <= reach;
    if (!hit && n.labelPlacement === 'right') {
      const lx0 = n.x + half + 4;
      const lx1 = lx0 + Math.min(String(n.name).length, n.labelMax || 18) * CHAR_W;
      hit = wx >= lx0 && wx <= lx1 && wy >= n.y - 12 && wy <= n.y + (n.showSub ? 20 : 8);
    } else if (!hit && n.labelPlacement === 'below') {
      const hw = (Math.min(String(n.name).length, n.labelMax || 18) * CHAR_W) / 2;
      hit = wx >= n.x - hw && wx <= n.x + hw && wy >= n.y && wy <= n.y + n.size + 22;
    }
    if (hit && d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

// ── Search ──────────────────────────────────────────────────────────────────

export function searchMatches(nodes, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return null;
  const hits = new Set();
  for (const n of nodes) {
    const hay = `${n.name} ${n.sublabel || ''} ${n.description || ''}`.toLowerCase();
    if (hay.includes(needle)) hits.add(n.id);
  }
  return hits;
}

// ── Detail / summary / list ─────────────────────────────────────────────────

/**
 * Detail for the selected node (the web's detailFor). tone is a kit tone name.
 * rows: [label, value][]; meter: { label, percent } for workers.
 */
export function detailFor(state, selection, now = Date.now()) {
  if (!selection) return null;
  if (selection.kind === 'agency') {
    return {
      title: state.agencyName || 'Agency',
      kind: 'Agency',
      tone: 'primary',
      rows: [
        ['Clients', `${state.clients.length}`],
        ['Active', `${state.clients.filter((c) => c.status === 'active').length}`],
        ['Projects', `${state.projects.length}`],
        ['Workforce', `${state.workers.length}`],
      ],
    };
  }
  if (selection.kind === 'aggregate') {
    if (selection.id === 'unlinked') {
      const unlinked = state.projects.filter((p) => !p.clientId && p.status !== 'cancelled');
      return {
        title: 'Projects with no client',
        kind: 'Group',
        tone: 'warning',
        rows: [
          ['Count', `${unlinked.length}`],
          ['Budget', money(unlinked.reduce((sum, p) => sum + p.budgetCents, 0))],
          ['Fix', 'Attach them to a client in Agency Operations, Projects'],
        ],
        projects: unlinked,
      };
    }
    const hidden = state.clients.length - scopedClients(state).length;
    return {
      title: `${hidden} clients out of scope`,
      kind: 'Group',
      tone: 'info',
      rows: [
        ['Reason', SCOPE_LABELS[state.clientScope]],
        ['Total book', `${state.clients.length} clients`],
        ['Next step', 'Switch scope to All clients or use the list view'],
      ],
    };
  }
  if (selection.kind === 'client') {
    const client = state.clients.find((c) => c.id === selection.id);
    if (!client) return null;
    return {
      title: client.name,
      kind: 'Client',
      tone: client.status === 'active' ? 'success' : client.status === 'prospect' ? 'info' : 'warning',
      status: client.pipelineStatusLabel || client.status,
      rows: [
        ['Status', client.pipelineStatusLabel ? `${client.pipelineStatusLabel} (${client.status})` : client.status],
        ['Projects', `${client.projectCount}`],
        ['MRR', money(client.mrrCents)],
        ['Lifetime', money(client.lifetimeInvoicedCents)],
        ['Outstanding', money(client.outstandingCents)],
        ['Billing', client.billingEmail || '—'],
      ],
    };
  }
  if (selection.kind === 'project') {
    const project = state.projects.find((p) => p.id === selection.id);
    if (!project) return null;
    const owner = project.clientId
      ? state.clients.find((c) => c.id === project.clientId)?.name || project.clientId
      : 'Not linked to a client';
    const tone = projectTone(project, now);
    return {
      title: project.name,
      kind: 'Project',
      tone: tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info',
      status: projectHealthLabel(project, now),
      clientId: project.clientId,
      rows: [
        ['Health', projectHealthLabel(project, now)],
        ['Status', statusLabel(project.status)],
        ['Client', owner],
        ['Budget', money(project.budgetCents)],
        ['Target end', project.targetEndAt ? shortDate(project.targetEndAt) : 'No target date'],
      ],
    };
  }
  const worker = state.workers.find((w) => w.id === selection.id);
  if (!worker) return null;
  const manager = worker.managerWorkerId
    ? state.workers.find((w) => w.id === worker.managerWorkerId)?.name || worker.managerName || worker.managerWorkerId
    : worker.managerName || 'Reports to the agency';
  const reports = state.workers.filter((w) => w.managerWorkerId === worker.id);
  const tone = utilizationTone(worker.utilizationPercent);
  return {
    title: worker.name,
    kind: worker.kind === 'ai' ? 'AI worker' : 'Human worker',
    tone: tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'success',
    status: worker.availability,
    meter: { label: 'Utilisation', percent: worker.utilizationPercent },
    managerId: worker.managerWorkerId && state.workers.some((w) => w.id === worker.managerWorkerId) ? worker.managerWorkerId : null,
    reports: reports.map((w) => ({ id: w.id, name: w.name, role: w.role })),
    rows: [
      ['Role', worker.role],
      ['Department', worker.department],
      ['Availability', worker.availability],
      ['Manager', manager],
      ['Direct reports', reports.length ? reports.map((w) => w.name).join(', ') : 'None'],
      ['Utilization', `${Math.round(worker.utilizationPercent)}% of ${worker.capacityHours}h`],
      ['Active work', `${worker.activeWork}`],
    ],
  };
}

/** The "Agency at a glance" panel (the web's renderSummary). */
export function summarize(state, model, now = Date.now()) {
  const active = state.clients.filter((c) => c.status === 'active');
  const mrr = state.clients.reduce((s, c) => s + c.mrrCents, 0);
  const outstanding = state.clients.reduce((s, c) => s + c.outstandingCents, 0);
  const live = state.projects.filter((p) => p.status === 'active');
  const overdue = state.projects.filter((p) => projectTone(p, now) === 'danger');
  const onHold = state.projects.filter((p) => p.status === 'on_hold');
  const ai = state.workers.filter((w) => w.kind === 'ai').length;
  const utilisation = state.workers.length
    ? state.workers.reduce((s, w) => s + w.utilizationPercent, 0) / state.workers.length
    : 0;
  const stretched = state.workers.filter((w) => w.utilizationPercent >= 85).length;
  const basis = model?.weightBasis || weightBasisFor(state.clients);
  const topClients = [...state.clients]
    .sort((a, b) => clientWeight(b, basis) - clientWeight(a, basis) || a.name.localeCompare(b.name))
    .slice(0, 4)
    .map((c) => ({ id: c.id, name: c.name, meta: basis === 'revenue' ? `${money(c.mrrCents)}/mo` : `${c.projectCount} proj` }));
  const unlinked = model ? model.unlinkedProjects : state.projects.filter((p) => !p.clientId && p.status !== 'cancelled').length;
  return {
    book: {
      value: money(mrr),
      unit: '/mo',
      context: `${active.length} active of ${state.clients.length} clients · ${money(outstanding)} outstanding`,
      tone: 'success',
    },
    delivery: {
      value: `${live.length} in flight`,
      context: `${state.projects.length} projects · ${onHold.length} on hold · ${overdue.length} past target${unlinked ? ` · ${unlinked} with no client` : ''}`,
      tone: overdue.length ? 'warning' : 'info',
    },
    workforce: {
      value: `${Math.round(utilisation)}% utilised`,
      percent: utilisation,
      context: `${state.workers.length} workers · ${ai} AI / ${state.workers.length - ai} human · ${stretched} at or near capacity`,
      tone: stretched ? 'warning' : 'success',
    },
    mrrCents: mrr,
    inFlight: live.length,
    utilisation,
    topClients,
  };
}

/** The accessible list view (the web's renderList): clients with their projects, and the org tree. */
export function buildList(state, model, now = Date.now()) {
  const needle = String(state.search || '').trim().toLowerCase();
  const matches = (v) => !needle || String(v || '').toLowerCase().includes(needle);
  const byOwner = new Map();
  for (const p of model.projects) {
    const key = p.clientId || '__agency__';
    byOwner.set(key, [...(byOwner.get(key) || []), p]);
  }
  const clients = model.clients
    .filter((c) => matches(c.name) || (byOwner.get(c.id) || []).some((p) => matches(p.name)))
    .map((c) => ({
      client: c,
      projects: (byOwner.get(c.id) || []).map((p) => ({ project: p, tone: projectTone(p, now), health: projectHealthLabel(p, now) })),
    }));
  const unlinked = (byOwner.get('__agency__') || []).map((p) => ({ project: p, tone: projectTone(p, now), health: projectHealthLabel(p, now) }));
  const ids = new Set(model.workers.map((w) => w.id));
  const roots = model.workers.filter((w) => !w.managerWorkerId || !ids.has(w.managerWorkerId));
  const workers = [];
  const seen = new Set();
  const walk = (worker, depth) => {
    if (seen.has(worker.id) || depth > 12) return;
    seen.add(worker.id);
    workers.push({ worker, depth, tone: utilizationTone(worker.utilizationPercent), dim: Boolean(needle) && !matches(worker.name) && !matches(worker.role) });
    for (const report of model.workers.filter((w) => w.managerWorkerId === worker.id)) walk(report, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // Cycles with no root still get listed.
  for (const w of model.workers) if (!seen.has(w.id)) walk(w, 0);
  return { clients, unlinked, workers };
}
