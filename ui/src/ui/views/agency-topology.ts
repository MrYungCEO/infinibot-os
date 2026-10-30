/**
 * Agency Topology — the visual org + delivery map of the agency.
 *
 * Reuses the existing D3 graph (`components/systems-graph.ts`) rather than
 * growing a second graph engine; this file is the agency-specific projection:
 * which entity becomes which shape, what its colour and size *mean*, the
 * deterministic two-band layout, the scope controls that keep a 400-client book
 * renderable, and the accessible list fallback so the map is never mouse-only.
 *
 * The design rule here is that nothing is decorative. Shape says what a thing
 * is, colour says how healthy it is, size says how much it weighs, and the
 * legend states all three on screen — an operator should be able to read the
 * picture without being told how.
 */

import { html, nothing, type TemplateResult } from "lit";
import { baAurora } from "./ba-glass";
import "./ba-glass/agency.css";

import type { GatewayBrowserClient } from "../gateway";
import {
  SystemsGraph,
  type GraphRegion,
  type Relationship,
  type SystemNode,
} from "../components/systems-graph";
import { money, relativeTime } from "../controllers/agency-common";
import type { AgencyClient, AgencyProjectSummary } from "../controllers/agency-operations";
import {
  loadAgencyTopology,
  loadTopologyRelations,
  scopedClients,
  scopedProjects,
  selectTopologyNode,
  setTopologyClientScope,
  setTopologyFocus,
  setTopologySearch,
  setTopologyViewMode,
  toggleTopologyLayer,
  TOPOLOGY_TOP_CLIENTS,
  type AgencyTopologyHost,
  type AgencyTopologyState,
  type TopologyClientScope,
  type TopologySelection,
  type TopologyWorker,
} from "../controllers/agency-topology";
import { AGENCY_SURFACE_STYLES } from "./agency-surface-styles";
import { AGENCY_TOPOLOGY_STYLES } from "./agency-topology-styles";

const GRAPH_CONTAINER_ID = "agency-topology-graph";
/**
 * Hard ceiling on drawn nodes. Past this the list view is the honest answer,
 * and the truncation is stated on screen.
 */
const MAX_GRAPH_NODES = 320;
/**
 * Above this many client rows the delivery band stops being a row-per-client
 * chart (labels stop fitting) and becomes a packed grid with hover labels.
 */
const DENSE_CLIENT_THRESHOLD = 26;

const SCOPE_LABELS: Record<TopologyClientScope, string> = {
  active: "Active clients only",
  top: `Top ${TOPOLOGY_TOP_CLIENTS} by revenue`,
  all: "All clients (slow)",
  none: "Hide clients",
};

/** Every colour on the map resolves through a semantic token. No raw hex. */
const TONE = {
  primary: "var(--g-primary)",
  success: "var(--g-success)",
  warning: "var(--g-warning)",
  danger: "var(--g-danger)",
  info: "var(--g-info)",
  neutral: "var(--g-neutral)",
} as const;

type Tone = (typeof TONE)[keyof typeof TONE];

/** A dark rim in the fill's own hue: adjacent nodes separate without a halo. */
const rim = (tone: string): string => `color-mix(in srgb, ${tone} 42%, #04050a)`;
const faint = (tone: string, percent: number): string =>
  `color-mix(in srgb, ${tone} ${percent}%, transparent)`;

const nodeId = {
  agency: (id: string) => `agency:${id}`,
  client: (id: string) => `client:${id}`,
  project: (id: string) => `project:${id}`,
  worker: (id: string) => `worker:${id}`,
  aggregate: (id: string) => `aggregate:${id}`,
};

function parseNodeId(id: string): TopologySelection | null {
  const index = id.indexOf(":");
  if (index < 0) return null;
  const kind = id.slice(0, index);
  const rest = id.slice(index + 1);
  if (
    kind === "agency" ||
    kind === "client" ||
    kind === "project" ||
    kind === "worker" ||
    kind === "aggregate"
  ) {
    return { kind, id: rest };
  }
  return null;
}

const selectionKey = (selection: TopologySelection | null): string =>
  selection ? `${selection.kind}:${selection.id}` : "";

// ── Semantic encoding ───────────────────────────────────────
// Each of these answers one question, and each is stated in the legend.

/** Client health: is this relationship live, prospective, or lapsed? */
function clientTone(client: AgencyClient): Tone {
  if (client.status === "active") return TONE.success;
  if (client.status === "prospect") return TONE.info;
  return TONE.neutral;
}

/** Project health, including "should have shipped by now". */
function projectTone(project: AgencyProjectSummary): Tone {
  if (project.status === "completed") return TONE.neutral;
  if (project.status === "on_hold") return TONE.warning;
  if (
    project.targetEndAt &&
    project.targetEndAt < Date.now() &&
    project.status !== "cancelled"
  ) {
    return TONE.danger;
  }
  if (project.status === "active") return TONE.info;
  return TONE.neutral;
}

function projectHealthLabel(project: AgencyProjectSummary): string {
  const tone = projectTone(project);
  if (tone === TONE.danger) return "past target date";
  if (tone === TONE.warning) return "on hold";
  if (tone === TONE.info) return "active";
  return project.status.replace("_", " ");
}

/** Workforce load. The same ramp for humans and AI so the band reads as one. */
function utilizationTone(percent: number): Tone {
  if (percent >= 100) return TONE.danger;
  if (percent >= 85) return TONE.warning;
  if (percent >= 35) return TONE.success;
  return TONE.neutral;
}

/** Revenue weight, on a sqrt scale so one whale does not flatten everyone. */
function clientRadius(
  client: AgencyClient,
  maxWeight: number,
  dense: boolean,
  basis: WeightBasis,
): number {
  const weight = clientWeight(client, basis);
  const min = dense ? 5 : 9;
  const span = dense ? 6 : 13;
  if (maxWeight <= 0) return min + span * 0.35;
  return min + span * Math.sqrt(Math.min(1, weight / maxWeight));
}

type WeightBasis = "revenue" | "projects";

/**
 * How much of the agency this client is. Revenue is the honest measure, but a
 * book that records no revenue would collapse every circle to the same dot and
 * quietly make the size encoding a lie — so it falls back to delivery volume,
 * and the legend says which one is in play.
 */
function clientWeight(client: AgencyClient, basis: WeightBasis): number {
  if (basis === "projects") return client.projectCount;
  return Math.max(client.mrrCents, Math.round(client.lifetimeInvoicedCents / 12));
}

function weightBasisFor(clients: AgencyClient[]): WeightBasis {
  return clients.some((client) => clientWeight(client, "revenue") > 0) ? "revenue" : "projects";
}

// ── Model ───────────────────────────────────────────────────

interface WorkerSlot {
  depth: number;
  slot: number;
}

interface GraphModel {
  nodes: SystemNode[];
  relationships: Relationship[];
  regions: GraphRegion[];
  truncated: number;
  clients: AgencyClient[];
  projects: AgencyProjectSummary[];
  workers: TopologyWorker[];
  unlinkedProjects: number;
  hiddenClients: number;
  dense: boolean;
  /** What client radius is actually encoding on this dataset. */
  weightBasis: WeightBasis;
  /** Depth/row of each drawn worker, reused by the layout and the labels. */
  workerSlots: Map<string, WorkerSlot>;
  maxWorkerDepth: number;
  workerRows: number;
}

/**
 * Reduces the model to one node's neighbourhood, so "who is on this account"
 * is one click rather than a hunt across a full map.
 */
function focusedIds(state: AgencyTopologyState, model: GraphModel): Set<string> | null {
  const focus = state.focus;
  if (!focus) return null;
  const keep = new Set<string>();
  const agencyKey = nodeId.agency(state.agencyId ?? "agency");
  keep.add(agencyKey);
  if (focus.kind === "worker") {
    // A worker's neighbourhood is their whole reporting line: managers above,
    // every report below. Anything less is not an org chart.
    const byId = new Map(state.workers.map((worker) => [worker.id, worker] as const));
    let cursor: TopologyWorker | undefined = byId.get(focus.id);
    let guard = 0;
    while (cursor && guard++ < 12) {
      keep.add(nodeId.worker(cursor.id));
      cursor = cursor.managerWorkerId ? byId.get(cursor.managerWorkerId) : undefined;
    }
    const queue = [focus.id];
    while (queue.length) {
      const current = queue.shift() as string;
      for (const worker of state.workers) {
        if (worker.managerWorkerId !== current) continue;
        if (keep.has(nodeId.worker(worker.id))) continue;
        keep.add(nodeId.worker(worker.id));
        queue.push(worker.id);
      }
    }
  } else if (focus.kind === "client") {
    keep.add(nodeId.client(focus.id));
    for (const project of model.projects) {
      if (project.clientId === focus.id) keep.add(nodeId.project(project.id));
    }
  } else if (focus.kind === "project") {
    keep.add(nodeId.project(focus.id));
    const project = model.projects.find((entry) => entry.id === focus.id);
    if (project?.clientId) keep.add(nodeId.client(project.clientId));
  } else if (focus.kind === "aggregate" && focus.id === "unlinked") {
    // Focusing the unassigned bucket hands it the whole delivery band, which is
    // the only way its tiles get room to carry labels.
    keep.add(nodeId.aggregate("unlinked"));
    for (const project of model.projects) {
      if (!project.clientId) keep.add(nodeId.project(project.id));
    }
  } else {
    return null;
  }
  return keep;
}

/**
 * Projects the loaded agency onto the graph vocabulary. Shape carries identity,
 * fill carries health, radius carries weight — see the legend renderer, which
 * is generated from the same constants.
 */
function buildGraph(state: AgencyTopologyState): GraphModel {
  const nodes: SystemNode[] = [];
  const relationships: Relationship[] = [];
  const clients = scopedClients(state);
  const projects = scopedProjects(state, clients);
  const workers = state.showWorkforce ? state.workers : [];
  const agencyKey = nodeId.agency(state.agencyId ?? "agency");
  const dense = clients.length > DENSE_CLIENT_THRESHOLD;
  const weightBasis = weightBasisFor(clients);
  const maxWeight = clients.reduce(
    (max, client) => Math.max(max, clientWeight(client, weightBasis)),
    0,
  );

  nodes.push({
    id: agencyKey,
    name: state.agencyName || "Agency",
    type: "business",
    shape: "hexagon",
    size: 24,
    color: TONE.primary,
    accent: rim(TONE.primary),
    labelPlacement: "below",
    labelMaxChars: 24,
    description: `${state.clients.length} clients · ${state.projects.length} projects · ${state.workers.length} workers`,
  });

  // ── Workforce ───────────────────────────────────────────
  // Laid out as a real tree: leaves take sequential rows, a manager sits at the
  // midpoint of the rows its reports occupy, and depth becomes the column.
  const workerSlots = new Map<string, WorkerSlot>();
  const workerIds = new Set(workers.map((worker) => worker.id));
  const childrenOf = new Map<string, TopologyWorker[]>();
  const roots: TopologyWorker[] = [];
  for (const worker of [...workers].sort((a, b) => a.name.localeCompare(b.name))) {
    const managerId = worker.managerWorkerId;
    if (managerId && workerIds.has(managerId) && managerId !== worker.id) {
      childrenOf.set(managerId, [...(childrenOf.get(managerId) ?? []), worker]);
    } else {
      roots.push(worker);
    }
  }
  let nextRow = 0;
  const assignSlot = (worker: TopologyWorker, depth: number, guard: number): number => {
    if (workerSlots.has(worker.id)) return workerSlots.get(worker.id)?.slot ?? 0;
    const children = guard > 8 ? [] : (childrenOf.get(worker.id) ?? []);
    if (!children.length) {
      const slot = nextRow++;
      workerSlots.set(worker.id, { depth, slot });
      return slot;
    }
    // Placeholder first: a cycle in the data must not recurse forever.
    workerSlots.set(worker.id, { depth, slot: nextRow });
    const childSlots = children.map((child) => assignSlot(child, depth + 1, guard + 1));
    const slot = (Math.min(...childSlots) + Math.max(...childSlots)) / 2;
    workerSlots.set(worker.id, { depth, slot });
    return slot;
  };
  for (const root of roots) assignSlot(root, 0, 0);
  const maxWorkerDepth = Math.max(0, ...[...workerSlots.values()].map((slot) => slot.depth));

  for (const worker of workers) {
    if (nodes.length >= MAX_GRAPH_NODES) break;
    const key = nodeId.worker(worker.id);
    const depth = workerSlots.get(worker.id)?.depth ?? 0;
    const tone = utilizationTone(worker.utilizationPercent);
    const reports = workers.filter((entry) => entry.managerWorkerId === worker.id).length;
    nodes.push({
      id: key,
      name: worker.name,
      type: worker.kind === "ai" ? "priority" : "person",
      // Shape says human or AI; the outline repeats it so the two never merge
      // once the fill is being used for load.
      shape: worker.kind === "ai" ? "diamond" : "circle",
      size: depth === 0 ? 16 : depth === 1 ? 13 : 11,
      color: tone,
      accent: worker.kind === "ai" ? TONE.primary : TONE.info,
      labelPlacement: "right",
      sublabel: `${worker.role}${reports ? ` · ${reports} report${reports > 1 ? "s" : ""}` : ""}`,
      description: `${worker.kind === "ai" ? "AI" : "Human"} · ${worker.role} · ${worker.department} · ${Math.round(worker.utilizationPercent)}% utilised · ${worker.availability}`,
    });
    const managerId = worker.managerWorkerId;
    if (managerId && workerIds.has(managerId)) {
      relationships.push({
        id: `rel-mgr-${key}`,
        source: nodeId.worker(managerId),
        target: key,
        type: "supports",
        curve: "elbow",
        color: faint(TONE.primary, 70),
        width: 1.6,
        dash: "none",
        opacity: 0.9,
      });
    } else if (roots.length <= 3) {
      // One or two lines from the agency to the top of the org read as "this
      // is the apex". Six of them read as a starburst and say nothing the
      // workforce band does not already say, so past that they are dropped.
      relationships.push({
        id: `rel-root-${key}`,
        source: agencyKey,
        target: key,
        type: "attention_flow",
        curve: "arc",
        color: faint(TONE.primary, 45),
        width: 1.4,
        opacity: 0.6,
      });
    }
  }

  // ── Clients ─────────────────────────────────────────────
  const drawnClients = new Set<string>();
  for (const client of clients) {
    if (nodes.length >= MAX_GRAPH_NODES) break;
    const key = nodeId.client(client.id);
    const tone = clientTone(client);
    drawnClients.add(key);
    nodes.push({
      id: key,
      name: client.name,
      type: "revenue_stream",
      shape: "circle",
      glyph: "",
      size: clientRadius(client, maxWeight, dense, weightBasis),
      color: tone,
      accent: rim(tone),
      labelPlacement: dense ? "none" : "right",
      sublabel: dense
        ? undefined
        : `${weightBasis === "revenue" ? `${money(client.mrrCents)}/mo · ` : ""}${client.projectCount} project${client.projectCount === 1 ? "" : "s"} · ${client.status}`,
      description: `${client.status} · ${client.projectCount} projects · ${money(client.mrrCents)} MRR · ${money(client.outstandingCents)} outstanding`,
    });
  }

  // Projects that belong to nobody still have to live somewhere visible, so
  // they get a named anchor instead of a wire to the agency across the map.
  const unlinked = projects.filter((project) => !project.clientId);
  const unlinkedKey = nodeId.aggregate("unlinked");
  if (unlinked.length && state.showProjects) {
    nodes.push({
      id: unlinkedKey,
      name: "No client",
      type: "note",
      shape: "pill",
      size: 11,
      color: faint(TONE.warning, 26),
      accent: TONE.warning,
      labelPlacement: "right",
      labelMaxChars: 30,
      sublabel: `${unlinked.length} unassigned project${unlinked.length === 1 ? "" : "s"}`,
      description: `${unlinked.length} projects are not linked to a client`,
    });
  }

  for (const project of projects) {
    if (nodes.length >= MAX_GRAPH_NODES) break;
    const key = nodeId.project(project.id);
    const parent = project.clientId ? nodeId.client(project.clientId) : unlinkedKey;
    if (project.clientId && !drawnClients.has(parent)) continue;
    const tone = projectTone(project);
    nodes.push({
      id: key,
      name: project.name,
      type: "project",
      shape: "roundedRect",
      size: 11,
      color: tone,
      accent: rim(tone),
      labelPlacement: dense ? "none" : "below",
      labelMaxChars: 18,
      description: `${projectHealthLabel(project)} · ${money(project.budgetCents)} budget${project.targetEndAt ? ` · target ${new Date(project.targetEndAt).toLocaleDateString()}` : ""}`,
    });
    relationships.push({
      id: `rel-${key}`,
      source: parent,
      target: key,
      type: "feeds",
      // Elbows collapse to a plain horizontal line when owner and project share
      // a row, and form a tidy bus when they do not — either way the eye can
      // follow the line back to whoever the work belongs to.
      curve: "elbow",
      color: faint(TONE.neutral, 46),
      width: 1.2,
      opacity: dense ? 0.22 : 0.5,
    });
  }

  const hiddenClients = state.clients.length - clients.length;
  if (hiddenClients > 0) {
    nodes.push({
      id: nodeId.aggregate("clients"),
      name: `+${hiddenClients} more clients`,
      type: "note",
      shape: "pill",
      size: 11,
      color: faint(TONE.neutral, 22),
      accent: TONE.neutral,
      labelPlacement: "right",
      labelMaxChars: 30,
      sublabel: "outside the current scope",
      description: `${hiddenClients} clients are outside “${SCOPE_LABELS[state.clientScope]}”`,
    });
  }

  // Assignment edges are kept only when they resolve to a project that is
  // actually drawn. Hanging the rest off the agency produced a fan of lines
  // that said nothing — the list view still reports every assignment.
  if (state.showWorkforce) {
    const drawnWorkers = new Set(nodes.filter((node) => node.id.startsWith("worker:")).map((n) => n.id));
    const projectByName = new Map(
      nodes
        .filter((node) => node.id.startsWith("project:"))
        .map((node) => [node.name.toLowerCase(), node.id] as const),
    );
    for (const assignment of state.assignments) {
      const projectKey = projectByName.get((assignment.title ?? "").toLowerCase());
      if (!projectKey) continue;
      for (const member of assignment.members ?? []) {
        const workerKey = nodeId.worker(member.workerId);
        if (!drawnWorkers.has(workerKey)) continue;
        relationships.push({
          id: `rel-asg-${assignment.id}-${member.workerId}`,
          source: projectKey,
          target: workerKey,
          type: "resource_flow",
          curve: "arc",
          color: faint(TONE.info, 55),
          width: 1.4,
          opacity: 0.45,
          label: assignment.title,
        });
      }
    }
  }

  const wanted =
    1 + clients.length + projects.length + workers.length + (hiddenClients > 0 ? 1 : 0);
  const model: GraphModel = {
    nodes,
    relationships,
    regions: [],
    truncated: Math.max(0, wanted - nodes.length),
    clients,
    projects,
    workers,
    unlinkedProjects: unlinked.length,
    hiddenClients,
    dense,
    weightBasis,
    workerSlots,
    maxWorkerDepth,
    workerRows: Math.max(1, nextRow),
  };

  const keep = focusedIds(state, model);
  if (keep) {
    model.nodes = model.nodes.filter((node) => keep.has(node.id));
    model.clients = model.clients.filter((client) => keep.has(nodeId.client(client.id)));
    model.projects = model.projects.filter((project) => keep.has(nodeId.project(project.id)));
    model.workers = model.workers.filter((worker) => keep.has(nodeId.worker(worker.id)));
  }
  const drawn = new Set(model.nodes.map((node) => node.id));
  model.relationships = model.relationships.filter(
    (relationship) => drawn.has(relationship.source) && drawn.has(relationship.target),
  );
  return model;
}

// ── Deterministic layout ────────────────────────────────────
/**
 * Two labelled bands under the agency: the workforce as a left→right org tree,
 * and the delivery book as a client-per-row chart with that client's projects
 * on the same row.
 *
 * Containment is drawn as a *region*, not as edges. Wiring 400 clients back to
 * one hexagon is what turned the previous version into a starburst; a labelled
 * band says the same thing and costs no ink.
 */
function layoutGraph(model: GraphModel, width: number, height: number): void {
  const w = Math.max(720, width);
  const h = Math.max(420, height);
  const byId = new Map(model.nodes.map((node) => [node.id, node] as const));
  const top = 78;
  const bottom = h - 14;
  const showWorkforce = model.workers.length > 0;
  // Counted from the nodes actually drawn, not the raw totals: focusing a
  // worker leaves the delivery side empty, and an empty labelled band is worse
  // than no band at all.
  const showDelivery = model.nodes.some(
    (node) =>
      node.id.startsWith("client:") ||
      node.id.startsWith("project:") ||
      node.id.startsWith("aggregate:"),
  );

  let workforceBox = { x0: 12, x1: w - 12 };
  let deliveryBox = { x0: 12, x1: w - 12 };
  if (showWorkforce && showDelivery) {
    const split = Math.round(w * 0.38);
    workforceBox = { x0: 12, x1: split - 8 };
    deliveryBox = { x0: split + 8, x1: w - 12 };
  }

  const agency = model.nodes.find((node) => node.id.startsWith("agency:"));
  if (agency) {
    // Sits over the workforce band when there is one, so the few lines it does
    // draw stay short instead of crossing the whole map.
    agency.x = showWorkforce ? (workforceBox.x0 + workforceBox.x1) / 2 : w / 2;
    agency.y = 30;
  }

  // ── Workforce band ──────────────────────────────────────
  if (showWorkforce) {
    model.regions.push({
      id: "region-workforce",
      label: "Workforce · reporting lines",
      x: workforceBox.x0,
      y: top,
      width: workforceBox.x1 - workforceBox.x0,
      height: bottom - top,
      tone: faint(TONE.primary, 3),
      border: faint(TONE.primary, 20),
      labelColor: faint(TONE.primary, 62),
    });
    const usable = bottom - top - 40;
    const rowStep = Math.max(24, Math.min(52, usable / Math.max(1, model.workerRows)));
    const blockHeight = rowStep * Math.max(1, model.workerRows - 1);
    const originY = top + 30 + Math.max(0, (usable - blockHeight) / 2);
    const columns = model.maxWorkerDepth + 1;
    const columnWidth = Math.min(
      196,
      (workforceBox.x1 - workforceBox.x0 - 44) / Math.max(1, columns - 0.25),
    );
    for (const worker of model.workers) {
      const node = byId.get(nodeId.worker(worker.id));
      const slot = model.workerSlots.get(worker.id);
      if (!node || !slot) continue;
      node.x = workforceBox.x0 + 26 + slot.depth * columnWidth;
      node.y = originY + slot.slot * rowStep;
      const isLast = slot.depth >= model.maxWorkerDepth;
      const room = isLast
        ? workforceBox.x1 - (node.x + (node.size ?? 12) + 12)
        : columnWidth - (node.size ?? 12) - 14;
      node.labelMaxChars = Math.max(6, Math.min(26, Math.floor(room / 6.6)));
      // Rows this tight cannot carry a second line without colliding.
      if (rowStep < 30) node.sublabel = undefined;
    }
  }

  // ── Delivery band ───────────────────────────────────────
  if (!showDelivery) return;
  model.regions.push({
    id: "region-delivery",
    label: model.dense
      ? "Clients · delivery (labels on hover at this density)"
      : "Clients · delivery",
    x: deliveryBox.x0,
    y: top,
    width: deliveryBox.x1 - deliveryBox.x0,
    height: bottom - top,
    tone: faint(TONE.info, 3),
    border: faint(TONE.info, 18),
    labelColor: faint(TONE.info, 62),
  });

  const rowsX0 = deliveryBox.x0 + 20;
  const rowsX1 = deliveryBox.x1 - 18;
  const rowsY0 = top + 34;
  const rowsY1 = bottom - 14;
  const projectsByClient = new Map<string, SystemNode[]>();
  for (const project of model.projects) {
    const node = byId.get(nodeId.project(project.id));
    if (!node) continue;
    const key = project.clientId ?? "__none__";
    projectsByClient.set(key, [...(projectsByClient.get(key) ?? []), node]);
  }

  if (model.dense) {
    // Packed grids: clients on the left of the band, projects on the right.
    // Nothing is labelled at this density — the region caption says so and
    // hovering (or the list view) names any node.
    // Only split the band when project nodes were actually drawn — at this
    // scope the node ceiling is usually reached by the client book alone, and
    // reserving half the band for an empty grid wastes the space the clients
    // need.
    const projectNodes = model.projects
      .map((project) => byId.get(nodeId.project(project.id)))
      .filter((node): node is SystemNode => Boolean(node));
    const gridWidth = (rowsX1 - rowsX0) * (projectNodes.length ? 0.58 : 1);
    const placeGrid = (nodes: SystemNode[], x0: number, x1: number): void => {
      if (!nodes.length) return;
      const availableW = Math.max(40, x1 - x0);
      const availableH = Math.max(40, rowsY1 - rowsY0);
      const columns = Math.max(1, Math.round(Math.sqrt((nodes.length * availableW) / availableH)));
      const rows = Math.ceil(nodes.length / columns);
      const stepX = availableW / Math.max(1, columns);
      const stepY = Math.min(28, availableH / Math.max(1, rows));
      nodes.forEach((node, index) => {
        node.x = x0 + stepX * (0.5 + (index % columns));
        node.y = rowsY0 + stepY * (0.5 + Math.floor(index / columns));
      });
    };
    placeGrid(
      model.clients
        .map((client) => byId.get(nodeId.client(client.id)))
        .filter((node): node is SystemNode => Boolean(node)),
      rowsX0,
      rowsX0 + gridWidth - 12,
    );
    placeGrid(projectNodes, rowsX0 + gridWidth + 12, rowsX1);
    const aggregate = byId.get(nodeId.aggregate("clients"));
    if (aggregate) {
      aggregate.x = rowsX0 + 60;
      aggregate.y = rowsY1;
      aggregate.labelPlacement = "right";
    }
    const unlinkedAnchor = byId.get(nodeId.aggregate("unlinked"));
    if (unlinkedAnchor) {
      unlinkedAnchor.x = Math.min(rowsX0 + gridWidth + 40, rowsX1 - 150);
      unlinkedAnchor.y = rowsY1;
      unlinkedAnchor.labelPlacement = "right";
    }
    return;
  }

  // Row mode: one row per client, that client's projects on the same row, so
  // "who is this work for" is answered by reading straight across.
  const rows: Array<{ anchor: SystemNode; projects: SystemNode[] }> = [];
  for (const client of model.clients) {
    const anchor = byId.get(nodeId.client(client.id));
    if (!anchor) continue;
    rows.push({ anchor, projects: projectsByClient.get(client.id) ?? [] });
  }
  const unlinkedAnchor = byId.get(nodeId.aggregate("unlinked"));
  const unlinkedProjects = projectsByClient.get("__none__") ?? [];
  const aggregate = byId.get(nodeId.aggregate("clients"));

  const bandWidth = rowsX1 - rowsX0;
  const availableHeight = rowsY1 - rowsY0;
  /** Rows a single column can hold before they stop being readable. */
  const perColumn = (height: number): number => Math.max(1, Math.floor(height / 34));
  const maxColumns = Math.max(1, Math.floor(bandWidth / 300));

  // Work with no client is its own bucket, not a client row that happens to be
  // 20 projects wide. Where the band can afford it, it gets a wrapping strip at
  // the foot — a backlog you cannot miss. Where it cannot, the tiles collapse
  // into the anchor, which says how many there are and focuses them on click,
  // rather than being drawn as a row of unreadable dots.
  let rowsBottom = rowsY1;
  let stripPlaced = false;
  if (unlinkedAnchor && unlinkedProjects.length) {
    const runX0 = rowsX0 + 132;
    const perRow = Math.max(1, Math.floor((rowsX1 - runX0) / 116));
    const subRows = Math.ceil(unlinkedProjects.length / perRow);
    const wanted = 30 + subRows * 42;
    const stripHeight = Math.min(wanted, availableHeight * 0.5);
    const leftOver = availableHeight - stripHeight - 12;
    const fits =
      stripHeight >= 72 &&
      stripHeight >= wanted * 0.72 &&
      perColumn(leftOver) * maxColumns >= rows.length + (aggregate ? 1 : 0);
    if (fits) {
      stripPlaced = true;
      const stripY0 = rowsY1 - stripHeight;
      rowsBottom = stripY0 - 12;
      model.regions.push({
        id: "region-unassigned",
        label: "Unassigned to a client",
        x: deliveryBox.x0 + 8,
        y: stripY0,
        width: deliveryBox.x1 - deliveryBox.x0 - 16,
        height: stripHeight,
        tone: faint(TONE.warning, 4),
        border: faint(TONE.warning, 28),
        labelColor: faint(TONE.warning, 70),
      });
      unlinkedAnchor.x = rowsX0 + 22;
      unlinkedAnchor.y = stripY0 + stripHeight / 2 + 8;
      unlinkedAnchor.labelMaxChars = 13;
      const stepY = (stripHeight - 26) / subRows;
      unlinkedProjects.forEach((node, index) => {
        node.x = runX0 + 116 * (0.5 + (index % perRow));
        node.y = stripY0 + 26 + stepY * (0.5 + Math.floor(index / perRow));
        node.labelMaxChars = 15;
        if (stepY < 38) node.labelPlacement = "none";
      });
    } else {
      const drop = new Set(unlinkedProjects.map((node) => node.id));
      model.nodes = model.nodes.filter((node) => !drop.has(node.id));
      model.relationships = model.relationships.filter(
        (relationship) => !drop.has(relationship.target) && !drop.has(relationship.source),
      );
      unlinkedAnchor.sublabel = `${unlinkedProjects.length} projects · click to focus`;
      unlinkedProjects.length = 0;
    }
  }
  if (unlinkedAnchor && !stripPlaced) rows.push({ anchor: unlinkedAnchor, projects: [] });
  if (aggregate) rows.push({ anchor: aggregate, projects: [] });

  // A short, wide canvas fits far more client rows as two or three stacked
  // columns than as one long list that has to be squeezed to 20px a row.
  const rowsHeight = rowsBottom - rowsY0;
  const columns = Math.max(
    1,
    Math.min(maxColumns, Math.ceil(rows.length / perColumn(rowsHeight))),
  );
  const rowsPerColumn = Math.ceil(rows.length / columns);
  const rowStep = Math.max(22, Math.min(64, rowsHeight / Math.max(1, rowsPerColumn)));
  const columnWidth = bandWidth / columns;
  // With no project tiles to make room for, the whole column belongs to the
  // client label — truncating names to leave space for nothing is the kind of
  // detail that makes a map feel careless.
  const anyProjects = rows.some((row) => row.projects.length > 0);
  const projectOffset = anyProjects ? Math.min(214, columnWidth * 0.46) : columnWidth - 24;
  const anchorLabelChars = Math.max(6, Math.floor((projectOffset - 46) / 6.6));

  rows.forEach((row, index) => {
    const column = Math.floor(index / rowsPerColumn);
    const columnX = rowsX0 + column * columnWidth;
    const y = rowsY0 + rowStep * (0.5 + (index % rowsPerColumn));
    row.anchor.x = columnX + 22;
    row.anchor.y = y;
    row.anchor.labelMaxChars = Math.min(row.anchor.labelMaxChars ?? 99, anchorLabelChars);
    if (rowStep < 32) row.anchor.sublabel = undefined;

    const count = row.projects.length;
    if (!count) return;
    const runX0 = columnX + projectOffset;
    const runWidth = columnX + columnWidth - 14 - runX0;
    const step = Math.min(146, runWidth / count);
    row.projects.forEach((node, projectIndex) => {
      node.x = runX0 + step * (0.5 + projectIndex);
      node.y = y;
      if (step < 62 || rowStep < 40) node.labelPlacement = "none";
      else node.labelMaxChars = Math.max(5, Math.min(19, Math.floor(step / 6.6) - 2));
    });
  });
}

// ── Graph lifecycle ─────────────────────────────────────────
// The graph is imperative D3 inside a container Lit does not own. Mount it
// after paint, and rebuild only when the drawn data actually changes so
// selecting a node never resets the layout the user dragged into shape.
let graphInstance: SystemsGraph | null = null;
let graphContainer: HTMLElement | null = null;
let graphSignature = "";
let graphEmphasis = "";

function hasD3(): boolean {
  // D3 used to arrive as a global from a <script src="d3js.org"> tag, so this
  // probed `window.d3`. That CDN tag was removed (it blocked first paint and
  // broke the app offline) and systems-graph.ts now imports the bundled
  // package, which never defines a global — so this check reported "not
  // available" forever and the map silently degraded to the list view.
  // The graph module is a static import, so by the time this runs D3 is
  // linked; there is nothing left to feature-detect.
  return true;
}

function teardownGraph(): void {
  if (graphInstance) {
    try {
      graphInstance.destroy();
    } catch {
      /* container may already be gone */
    }
  }
  graphInstance = null;
  graphContainer = null;
  graphSignature = "";
  graphEmphasis = "";
}

/** Nodes whose name or subtitle matches the search box. */
function searchMatches(model: GraphModel, query: string): Set<string> | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const hits = new Set<string>();
  for (const node of model.nodes) {
    const haystack = `${node.name} ${node.sublabel ?? ""} ${node.description ?? ""}`.toLowerCase();
    if (haystack.includes(needle)) hits.add(node.id);
  }
  return hits;
}

function fitGraph(): void {
  try {
    graphInstance?.zoomToFit(28);
  } catch {
    /* fit is cosmetic */
  }
}

function syncGraph(host: AgencyTopologyHost, state: AgencyTopologyState, model: GraphModel): void {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    const element = document.getElementById(GRAPH_CONTAINER_ID);
    if (!element) {
      teardownGraph();
      return;
    }
    const signature = `${model.nodes.map((node) => node.id).join(",")}|${model.relationships.length}`;
    const emphasis = state.search.trim().toLowerCase();
    if (graphInstance && graphContainer === element && signature === graphSignature) {
      if (emphasis !== graphEmphasis) {
        graphEmphasis = emphasis;
        try {
          graphInstance.setEmphasis(searchMatches(model, emphasis));
        } catch {
          /* emphasis is cosmetic */
        }
      }
      if (state.selection) {
        try {
          graphInstance.selectNode(selectionKey(state.selection));
        } catch {
          /* selection is cosmetic */
        }
      }
      return;
    }
    teardownGraph();
    if (!hasD3() || model.nodes.length === 0) return;
    graphContainer = element;
    graphSignature = signature;
    graphEmphasis = emphasis;
    const width = element.clientWidth || 900;
    const height = element.clientHeight || 620;
    layoutGraph(model, width, height);
    try {
      graphInstance = new SystemsGraph({
        containerId: GRAPH_CONTAINER_ID,
        nodes: model.nodes,
        relationships: model.relationships,
        regions: model.regions,
        width,
        height,
        staticLayout: true,
        background: "transparent",
        labelMaxChars: 18,
        onNodeClick: (node) => selectTopologyNode(host, parseNodeId(node.id)),
      });
      graphInstance.render();
      const hits = searchMatches(model, emphasis);
      if (hits) graphInstance.setEmphasis(hits);
      if (state.selection) graphInstance.selectNode(selectionKey(state.selection));
    } catch (error) {
      console.error("[agency-topology] graph render failed", error);
      teardownGraph();
    }
  });
}

// ── Detail panel ────────────────────────────────────────────

interface DetailModel {
  title: string;
  kind: string;
  tone: "ok" | "warn" | "crit" | "info" | "gold";
  rows: Array<[string, string]>;
  meter?: { label: string; percent: number };
}

function detailFor(state: AgencyTopologyState, selection: TopologySelection): DetailModel | null {
  if (selection.kind === "agency") {
    return {
      title: state.agencyName || "Agency",
      kind: "Agency",
      tone: "gold",
      rows: [
        ["Clients", `${state.clients.length}`],
        ["Active", `${state.clients.filter((client) => client.status === "active").length}`],
        ["Projects", `${state.projects.length}`],
        ["Workforce", `${state.workers.length}`],
      ],
    };
  }
  if (selection.kind === "aggregate") {
    if (selection.id === "unlinked") {
      const unlinked = state.projects.filter(
        (project) => !project.clientId && project.status !== "cancelled",
      );
      return {
        title: "Projects with no client",
        kind: "Group",
        tone: "warn",
        rows: [
          ["Count", `${unlinked.length}`],
          ["Budget", money(unlinked.reduce((sum, project) => sum + project.budgetCents, 0))],
          ["Fix", "Attach them to a client in Agency Operations → Projects"],
        ],
      };
    }
    const hidden = state.clients.length - scopedClients(state).length;
    return {
      title: `${hidden} clients out of scope`,
      kind: "Group",
      tone: "info",
      rows: [
        ["Reason", SCOPE_LABELS[state.clientScope]],
        ["Total book", `${state.clients.length} clients`],
        ["Next step", "Switch scope to All clients or use the list view"],
      ],
    };
  }
  if (selection.kind === "client") {
    const client = state.clients.find((entry) => entry.id === selection.id);
    if (!client) return null;
    return {
      title: client.name,
      kind: "Client",
      tone: client.status === "active" ? "ok" : client.status === "prospect" ? "info" : "warn",
      rows: [
        ["Status", client.status],
        ["Projects", `${client.projectCount}`],
        ["MRR", money(client.mrrCents)],
        ["Lifetime", money(client.lifetimeInvoicedCents)],
        ["Outstanding", money(client.outstandingCents)],
        ["Billing", client.billingEmail || "—"],
      ],
    };
  }
  if (selection.kind === "project") {
    const project = state.projects.find((entry) => entry.id === selection.id);
    if (!project) return null;
    const owner = project.clientId
      ? (state.clients.find((entry) => entry.id === project.clientId)?.name ?? project.clientId)
      : "Not linked to a client";
    const tone = projectTone(project);
    return {
      title: project.name,
      kind: "Project",
      tone: tone === TONE.danger ? "crit" : tone === TONE.warning ? "warn" : "info",
      rows: [
        ["Health", projectHealthLabel(project)],
        ["Status", project.status.replace("_", " ")],
        ["Client", owner],
        ["Budget", money(project.budgetCents)],
        [
          "Target end",
          project.targetEndAt ? new Date(project.targetEndAt).toLocaleDateString() : "No target date",
        ],
      ],
    };
  }
  const worker = state.workers.find((entry) => entry.id === selection.id);
  if (!worker) return null;
  const manager = worker.managerWorkerId
    ? (state.workers.find((entry) => entry.id === worker.managerWorkerId)?.name ??
      worker.managerName ??
      worker.managerWorkerId)
    : (worker.managerName ?? "Reports to the agency");
  const reports = state.workers.filter((entry) => entry.managerWorkerId === worker.id);
  const tone = utilizationTone(worker.utilizationPercent);
  return {
    title: worker.name,
    kind: worker.kind === "ai" ? "AI worker" : "Human worker",
    tone: tone === TONE.danger ? "crit" : tone === TONE.warning ? "warn" : "ok",
    meter: { label: "Utilisation", percent: worker.utilizationPercent },
    rows: [
      ["Role", worker.role],
      ["Department", worker.department],
      ["Availability", worker.availability],
      ["Manager", manager],
      ["Direct reports", reports.length ? reports.map((entry) => entry.name).join(", ") : "None"],
      ["Utilization", `${Math.round(worker.utilizationPercent)}% of ${worker.capacityHours}h`],
      ["Active work", `${worker.activeWork}`],
    ],
  };
}

// ── Sub-renderers ───────────────────────────────────────────

function renderToolbar(
  host: AgencyTopologyHost,
  state: AgencyTopologyState,
  model: GraphModel,
  hits: number | null,
): TemplateResult {
  return html`
    <div class="agx-toolbar">
      <span class="agx-field">
        <label for="agx-scope">Client scope</label>
        <select
          id="agx-scope"
          class="agx-select"
          aria-label="Client scope drawn on the topology"
          .value=${state.clientScope}
          @change=${(event: Event) =>
            setTopologyClientScope(
              host,
              (event.target as HTMLSelectElement).value as TopologyClientScope,
            )}
        >
          ${(Object.keys(SCOPE_LABELS) as TopologyClientScope[]).map(
            (scope) => html`<option value=${scope}>${SCOPE_LABELS[scope]}</option>`,
          )}
        </select>
      </span>
      <button
        type="button"
        class="agx-btn ${state.showProjects ? "is-on" : ""}"
        aria-pressed=${state.showProjects ? "true" : "false"}
        aria-label="Toggle the project layer"
        @click=${() => toggleTopologyLayer(host, "projects")}
      >
        Projects
      </button>
      <button
        type="button"
        class="agx-btn ${state.showWorkforce ? "is-on" : ""}"
        aria-pressed=${state.showWorkforce ? "true" : "false"}
        aria-label="Toggle the workforce layer"
        @click=${() => toggleTopologyLayer(host, "workforce")}
      >
        Workforce
      </button>
      <span class="agx-field">
        <label for="agx-search">Find</label>
        <input
          id="agx-search"
          class="agt-input"
          type="search"
          placeholder="client, project or person"
          aria-label="Highlight nodes whose name matches"
          .value=${state.search}
          @input=${(event: Event) =>
            setTopologySearch(host, (event.target as HTMLInputElement).value)}
        />
      </span>
      ${state.search.trim()
        ? html`<span class="agt-hitcount ${hits ? "" : "none"}" role="status"
            >${hits ?? 0} match${hits === 1 ? "" : "es"}</span
          >`
        : nothing}
      ${state.viewMode === "graph"
        ? html`<button
            type="button"
            class="agx-btn"
            aria-label="Zoom the map to fit every node"
            @click=${() => fitGraph()}
          >
            Fit
          </button>`
        : nothing}
      <span class="agx-scope-note">
        Showing <strong>${model.clients.length}</strong> of ${state.clients.length} clients,
        <strong>${model.projects.length}</strong> of ${state.projects.length} projects,
        <strong>${model.workers.length}</strong> of ${state.workers.length} workers.
        ${model.truncated > 0
          ? html` <strong>${model.truncated}</strong> nodes were dropped at the
            ${MAX_GRAPH_NODES}-node graph ceiling — use the list view for the full set.`
          : nothing}
      </span>
      <span style="margin-left:auto;display:flex;gap:6px" role="group" aria-label="Topology view mode">
        <button
          type="button"
          class="agx-btn ${state.viewMode === "graph" ? "is-on" : ""}"
          aria-pressed=${state.viewMode === "graph" ? "true" : "false"}
          @click=${() => setTopologyViewMode(host, "graph")}
        >
          Graph
        </button>
        <button
          type="button"
          class="agx-btn ${state.viewMode === "list" ? "is-on" : ""}"
          aria-pressed=${state.viewMode === "list" ? "true" : "false"}
          @click=${() => setTopologyViewMode(host, "list")}
        >
          List
        </button>
      </span>
    </div>
  `;
}

function focusLabel(state: AgencyTopologyState): string {
  const focus = state.focus;
  if (!focus) return "";
  if (focus.kind === "worker") {
    return state.workers.find((entry) => entry.id === focus.id)?.name ?? "worker";
  }
  if (focus.kind === "client") {
    return state.clients.find((entry) => entry.id === focus.id)?.name ?? "client";
  }
  if (focus.kind === "aggregate") return "projects with no client";
  return state.projects.find((entry) => entry.id === focus.id)?.name ?? "project";
}

function renderFocusBar(host: AgencyTopologyHost, state: AgencyTopologyState): TemplateResult {
  return html`
    <div class="agt-focus-bar" role="status">
      <span
        >Focused on <strong>${focusLabel(state)}</strong> — showing only its
        ${state.focus?.kind === "worker" ? "reporting line" : "directly related nodes"}.</span
      >
      <button
        type="button"
        class="agx-btn tiny"
        style="margin-left:auto"
        @click=${() => setTopologyFocus(host, null)}
      >
        Show everything
      </button>
    </div>
  `;
}

/** Small SVG marks so the legend shows the actual shape, not a colour square. */
function legendMark(shape: "hexagon" | "circle" | "rect" | "diamond" | "pill", tone: string) {
  const common = `fill:${tone};stroke:${rim(tone)};stroke-width:1.5`;
  if (shape === "circle") {
    return html`<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" style=${common}></circle>
    </svg>`;
  }
  if (shape === "rect") {
    return html`<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="4" width="13" height="8" rx="2.5" style=${common}></rect>
    </svg>`;
  }
  if (shape === "diamond") {
    return html`<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z" style=${common}></path>
    </svg>`;
  }
  if (shape === "pill") {
    return html`<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="0.8" y="5" width="14.4" height="6" rx="3" style=${common}></rect>
    </svg>`;
  }
  return html`<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 1.2 L14 4.6 L14 11.4 L8 14.8 L2 11.4 L2 4.6 Z" style=${common}></path>
  </svg>`;
}

function legendSwatch(tone: string) {
  return html`<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="0" y="2" width="12" height="8" rx="2" style="fill:${tone};opacity:0.9"></rect>
  </svg>`;
}

/**
 * The legend is generated from the same tones the map uses, so the two can
 * never drift, and it names every encoding — shape, colour and size.
 */
function renderLegend(model: GraphModel): TemplateResult {
  const entity: Array<[TemplateResult, string]> = [
    [legendMark("hexagon", TONE.primary), "Agency"],
    [legendMark("circle", TONE.success), "Client"],
    [legendMark("rect", TONE.info), "Project"],
    [legendMark("diamond", TONE.primary), "AI worker"],
    [legendMark("circle", TONE.info), "Human worker"],
    [legendMark("pill", TONE.neutral), "Group"],
  ];
  return html`
    <div class="agt-legend" aria-label="How to read this map">
      <div class="agt-legend-group">
        <div class="agt-legend-title">Shape = what it is</div>
        <div class="agt-legend-items">
          ${entity.map(
            ([mark, label]) => html`<span class="agt-legend-item">${mark}${label}</span>`,
          )}
        </div>
      </div>
      <div class="agt-legend-group">
        <div class="agt-legend-title">Colour = health</div>
        <div class="agt-legend-items">
          <span class="agt-legend-item">${legendSwatch(TONE.success)}active</span>
          <span class="agt-legend-item">${legendSwatch(TONE.info)}in flight</span>
          <span class="agt-legend-item">${legendSwatch(TONE.warning)}on hold / near capacity</span>
          <span class="agt-legend-item">${legendSwatch(TONE.danger)}past target / over capacity</span>
          <span class="agt-legend-item">${legendSwatch(TONE.neutral)}dormant</span>
        </div>
      </div>
      <div class="agt-legend-group">
        <div class="agt-legend-title">Size &amp; lines</div>
        <div class="agt-legend-items">
          <span class="agt-legend-item"
            >client radius =
            ${model.weightBasis === "revenue" ? "revenue" : "project count (no revenue recorded)"}</span
          >
          <span class="agt-legend-item">worker size = seniority</span>
          <span class="agt-legend-item">gold elbow = reports to</span>
          <span class="agt-legend-item">grey line = delivers</span>
        </div>
      </div>
      ${model.dense
        ? html`<div class="agt-legend-note">
            Dense scope: labels are hidden — hover a node, or use the list view.
          </div>`
        : nothing}
    </div>
  `;
}

function renderSummary(state: AgencyTopologyState, model: GraphModel): TemplateResult {
  const active = state.clients.filter((client) => client.status === "active");
  const mrr = state.clients.reduce((sum, client) => sum + client.mrrCents, 0);
  const outstanding = state.clients.reduce((sum, client) => sum + client.outstandingCents, 0);
  const live = state.projects.filter((project) => project.status === "active");
  const overdue = state.projects.filter((project) => projectTone(project) === TONE.danger);
  const onHold = state.projects.filter((project) => project.status === "on_hold");
  const ai = state.workers.filter((worker) => worker.kind === "ai").length;
  const utilisation = state.workers.length
    ? state.workers.reduce((sum, worker) => sum + worker.utilizationPercent, 0) /
      state.workers.length
    : 0;
  const stretched = state.workers.filter((worker) => worker.utilizationPercent >= 85);
  const topClients = [...state.clients]
    .sort(
      (a, b) =>
        clientWeight(b, model.weightBasis) - clientWeight(a, model.weightBasis) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 4);
  const meterClass = utilisation >= 100 ? "crit" : utilisation >= 85 ? "warn" : "";

  return html`
    <div class="agt-summary">
      <div class="agt-stat ok">
        <span class="agt-stat-label">Book</span>
        <span class="agt-stat-value">${money(mrr)}<small style="font-size:10px"> /mo</small></span>
        <span class="agt-stat-context"
          >${active.length} active of ${state.clients.length} clients ·
          ${money(outstanding)} outstanding</span
        >
      </div>
      <div class="agt-stat ${overdue.length ? "warn" : "info"}">
        <span class="agt-stat-label">Delivery</span>
        <span class="agt-stat-value">${live.length} in flight</span>
        <span class="agt-stat-context"
          >${state.projects.length} projects · ${onHold.length} on hold ·
          ${overdue.length} past target${model.unlinkedProjects
            ? ` · ${model.unlinkedProjects} with no client`
            : ""}</span
        >
      </div>
      <div class="agt-stat ${stretched.length ? "warn" : "ok"}">
        <span class="agt-stat-label">Workforce</span>
        <span class="agt-stat-value">${Math.round(utilisation)}% utilised</span>
        <span class="agt-stat-context"
          >${state.workers.length} workers · ${ai} AI / ${state.workers.length - ai} human ·
          ${stretched.length} at or near capacity</span
        >
        <span class="agt-meter ${meterClass}"
          ><i style="width:${Math.max(2, Math.min(100, utilisation))}%"></i
        ></span>
      </div>
      ${topClients.length
        ? html`
            <div class="agt-subhead">Largest accounts</div>
            ${topClients.map(
              (client) => html`
                <div class="agt-link" style="cursor:default">
                  <span class="agt-link-text">${client.name}</span>
                  <span class="agt-link-meta"
                    >${model.weightBasis === "revenue"
                      ? `${money(client.mrrCents)}/mo`
                      : `${client.projectCount} proj`}</span
                  >
                </div>
              `,
            )}
          `
        : nothing}
      <div class="agt-stat-context" style="margin-top:2px">
        Pick any node on the map — or a row in the list view — to see who owns it, what it is
        worth and who reports to whom.
      </div>
    </div>
  `;
}

function renderRelations(
  host: AgencyTopologyHost,
  state: AgencyTopologyState,
  selection: TopologySelection,
): TemplateResult {
  const relations = state.relations;
  if (!relations || relations.key !== selectionKey(selection)) return html``;
  if (relations.loading) {
    return html`<div class="agt-stat-context" style="margin-top:6px">Loading related records…</div>`;
  }
  if (relations.error) {
    return html`<div class="agt-stat-context" style="margin-top:6px;color:var(--g-danger)">
      Related records unavailable: ${relations.error}
    </div>`;
  }
  const openTasks = relations.tasks.filter(
    (task) => task.status !== "done" && task.status !== "cancelled",
  ).length;
  return html`
    <div class="agt-subhead">Related records</div>
    <div class="agt-stat-context" style="margin-bottom:4px">
      ${relations.contacts.length} contacts · ${relations.tasks.length} tasks
      (${openTasks} open) · ${relations.invoices.length} invoices
    </div>
    ${relations.clientId && selection.kind === "project"
      ? html`<button
          type="button"
          class="agt-link"
          @click=${() =>
            selectTopologyNode(host, { kind: "client", id: relations.clientId as string })}
        >
          <span class="agt-link-text">↰ ${relations.clientName ?? "Client"}</span>
          <span class="agt-link-meta">client</span>
        </button>`
      : nothing}
    ${relations.projects.slice(0, 12).map(
      (project) => html`
        <button
          type="button"
          class="agt-link"
          @click=${() => selectTopologyNode(host, { kind: "project", id: project.id })}
        >
          <span class="agt-link-text">→ ${project.name}</span>
          <span class="agt-link-meta">${project.status.replace("_", " ")}</span>
        </button>
      `,
    )}
    ${relations.projects.length > 12
      ? html`<div class="agt-stat-context">+${relations.projects.length - 12} more projects</div>`
      : nothing}
  `;
}

function renderDetail(
  host: AgencyTopologyHost,
  state: AgencyTopologyState,
  model: GraphModel,
  client: GatewayBrowserClient,
): TemplateResult {
  const selection = state.selection;
  const detail = selection ? detailFor(state, selection) : null;
  if (
    selection &&
    (selection.kind === "client" || selection.kind === "project") &&
    (!state.relations || state.relations.key !== selectionKey(selection))
  ) {
    queueMicrotask(() => void loadTopologyRelations(host, client, selection));
  }
  const focusable =
    selection &&
    (selection.kind === "client" ||
      selection.kind === "project" ||
      selection.kind === "worker" ||
      (selection.kind === "aggregate" && selection.id === "unlinked"));
  const isFocused =
    focusable &&
    state.focus?.kind === selection.kind &&
    state.focus?.id === selection.id;

  return html`
    <section class="agx-panel agt-detail" aria-live="polite">
      <header class="agx-panel-head">
        <span>${detail ? detail.kind : "Agency at a glance"}</span>
        ${selection
          ? html`<button
              type="button"
              class="agx-btn ghost agx-count"
              aria-label="Clear the selected node"
              @click=${() => selectTopologyNode(host, null)}
            >
              clear
            </button>`
          : html`<span class="agx-count">${model.nodes.length} nodes drawn</span>`}
      </header>
      <div class="agx-panel-body">
        ${detail
          ? html`
              <div class="agx-row-title" style="font-size:13px;margin-bottom:8px">
                ${detail.title}
              </div>
              ${detail.meter
                ? html`<div class="agt-stat ${detail.tone === "crit"
                      ? "warn"
                      : detail.tone === "warn"
                        ? "warn"
                        : "ok"}">
                    <span class="agt-stat-label">${detail.meter.label}</span>
                    <span class="agt-stat-value">${Math.round(detail.meter.percent)}%</span>
                    <span
                      class="agt-meter ${detail.meter.percent >= 100
                        ? "crit"
                        : detail.meter.percent >= 85
                          ? "warn"
                          : ""}"
                      ><i style="width:${Math.max(2, Math.min(100, detail.meter.percent))}%"></i
                    ></span>
                  </div>`
                : nothing}
              ${focusable
                ? html`<div class="agt-actions" style="margin-top:8px">
                    <button
                      type="button"
                      class="agx-btn tiny ${isFocused ? "is-on" : ""}"
                      @click=${() => setTopologyFocus(host, selection)}
                    >
                      ${isFocused ? "Unfocus" : "Focus"}
                    </button>
                    <button type="button" class="agx-btn tiny" @click=${() => fitGraph()}>
                      Fit map
                    </button>
                  </div>`
                : nothing}
              <dl>
                ${detail.rows.map(
                  ([label, value]) => html`<dt>${label}</dt>
                    <dd>${value}</dd>`,
                )}
              </dl>
              ${selection ? renderRelations(host, state, selection) : nothing}
            `
          : renderSummary(state, model)}
      </div>
    </section>
  `;
}

function renderList(host: AgencyTopologyHost, state: AgencyTopologyState, model: GraphModel) {
  const selectedKey = selectionKey(state.selection);
  const needle = state.search.trim().toLowerCase();
  const matches = (value: string): boolean => !needle || value.toLowerCase().includes(needle);
  const projectsByClient = new Map<string, AgencyProjectSummary[]>();
  for (const project of model.projects) {
    const key = project.clientId ?? "__agency__";
    const bucket = projectsByClient.get(key) ?? [];
    bucket.push(project);
    projectsByClient.set(key, bucket);
  }
  const listClients = model.clients.filter(
    (client) =>
      matches(client.name) ||
      (projectsByClient.get(client.id) ?? []).some((project) => matches(project.name)),
  );
  const roots = model.workers.filter(
    (worker) =>
      !worker.managerWorkerId ||
      !model.workers.some((entry) => entry.id === worker.managerWorkerId),
  );
  const renderWorker = (worker: TopologyWorker, depth: number): TemplateResult => {
    const reports = model.workers.filter((entry) => entry.managerWorkerId === worker.id);
    const tone = utilizationTone(worker.utilizationPercent);
    return html`
      <button
        type="button"
        class="agx-row ${depth === 1 ? "agx-indent" : depth >= 2 ? "agx-indent-2" : ""} ${selectedKey ===
        `worker:${worker.id}`
          ? "is-selected"
          : ""}"
        style=${needle && !matches(worker.name) && !matches(worker.role) ? "opacity:0.4" : ""}
        @click=${() => selectTopologyNode(host, { kind: "worker", id: worker.id })}
      >
        <span class="agx-tag ${worker.kind === "ai" ? "gold" : ""}">${worker.kind}</span>
        <span class="agx-row-main">
          <span class="agx-row-title">${worker.name}</span>
          <span class="agx-row-meta"
            >${worker.role} · ${worker.department} · ${Math.round(worker.utilizationPercent)}%
            utilized</span
          >
        </span>
        <span
          class="agx-tag ${tone === TONE.danger ? "crit" : tone === TONE.warning ? "warn" : "ok"}"
          >${Math.round(worker.utilizationPercent)}%</span
        >
      </button>
      ${reports.map((report) => renderWorker(report, depth + 1))}
    `;
  };

  return html`
    <div class="agx-grid">
      <section class="agx-panel">
        <header class="agx-panel-head">
          <span>Clients &amp; delivery</span>
          <span class="agx-count">${listClients.length} shown</span>
        </header>
        <div class="agx-panel-body">
          ${listClients.length === 0
            ? html`<div class="agx-empty">
                <strong>No clients in this scope</strong>
                <span
                  >${state.clients.length
                    ? `The book has ${state.clients.length} clients but none match “${needle || SCOPE_LABELS[state.clientScope]}”. Widen the scope or clear the search.`
                    : "Add your first client in Agency Operations → Clients to populate the map."}</span
                >
              </div>`
            : listClients.map(
                (client) => html`
                  <button
                    type="button"
                    class="agx-row ${selectedKey === `client:${client.id}` ? "is-selected" : ""}"
                    @click=${() => selectTopologyNode(host, { kind: "client", id: client.id })}
                  >
                    <span class="agx-tag ${client.status === "active" ? "ok" : ""}"
                      >${client.status}</span
                    >
                    <span class="agx-row-main">
                      <span class="agx-row-title">${client.name}</span>
                      <span class="agx-row-meta"
                        >${client.projectCount} projects · ${money(client.mrrCents)} MRR ·
                        ${money(client.outstandingCents)} outstanding</span
                      >
                    </span>
                  </button>
                  ${(projectsByClient.get(client.id) ?? []).map(
                    (project) => html`
                      <button
                        type="button"
                        class="agx-row agx-indent ${selectedKey === `project:${project.id}`
                          ? "is-selected"
                          : ""}"
                        @click=${() =>
                          selectTopologyNode(host, { kind: "project", id: project.id })}
                      >
                        <span
                          class="agx-tag ${projectTone(project) === TONE.danger
                            ? "crit"
                            : projectTone(project) === TONE.warning
                              ? "warn"
                              : ""}"
                          >${projectHealthLabel(project)}</span
                        >
                        <span class="agx-row-main">
                          <span class="agx-row-title">${project.name}</span>
                        </span>
                      </button>
                    `,
                  )}
                `,
              )}
          ${(projectsByClient.get("__agency__") ?? []).length
            ? html`
                <div class="agx-row-meta" style="margin-top:10px">
                  ${(projectsByClient.get("__agency__") ?? []).length} projects are not linked to a
                  client — they hang off the agency:
                </div>
                ${(projectsByClient.get("__agency__") ?? []).map(
                  (project) => html`
                    <button
                      type="button"
                      class="agx-row ${selectedKey === `project:${project.id}` ? "is-selected" : ""}"
                      @click=${() => selectTopologyNode(host, { kind: "project", id: project.id })}
                    >
                      <span class="agx-tag warn">unlinked</span>
                      <span class="agx-row-main">
                        <span class="agx-row-title">${project.name}</span>
                        <span class="agx-row-meta">${project.status.replace("_", " ")}</span>
                      </span>
                    </button>
                  `,
                )}
              `
            : nothing}
        </div>
      </section>
      <section class="agx-panel">
        <header class="agx-panel-head">
          <span>Reporting lines</span>
          <span class="agx-count">${model.workers.length} workers</span>
        </header>
        <div class="agx-panel-body">
          ${model.workers.length === 0
            ? html`<div class="agx-empty">
                <strong>No workforce in view</strong>
                <span
                  >${state.workers.length
                    ? "The workforce layer is hidden or focused — clear the focus to see everyone."
                    : "Hire a human or AI worker in Agency Operations → Employees; managers set there become the reporting lines drawn here."}</span
                >
              </div>`
            : roots.map((worker) => renderWorker(worker, 0))}
        </div>
      </section>
    </div>
  `;
}

// ── Entry point ─────────────────────────────────────────────

function renderSkeleton(): TemplateResult {
  return html`
    ${AGENCY_SURFACE_STYLES} ${AGENCY_TOPOLOGY_STYLES}
    <main class="agx ba-glass">
      ${baAurora()}
      <div class="agx-skel" aria-busy="true" aria-label="Loading agency topology">
        <div class="agx-skel-bar" style="width:32%"></div>
        <div class="agx-skel-bar" style="width:60%"></div>
        <div class="agx-skel-bar tall"></div>
      </div>
    </main>
  `;
}

export function renderAgencyTopology(
  host: AgencyTopologyHost,
  client: GatewayBrowserClient,
): TemplateResult {
  const state = host.agencyTopologyState;
  if (!state) {
    queueMicrotask(() => void loadAgencyTopology(host, client));
    return renderSkeleton();
  }
  if (state.loading && !state.lastLoadedAt) return renderSkeleton();

  const model = buildGraph(state);
  if (state.viewMode === "graph") syncGraph(host, state, model);
  else teardownGraph();
  const hits = searchMatches(model, state.search);

  const graphSummary = `Topology map: ${model.nodes.length} nodes — ${model.clients.length} clients, ${model.projects.length} projects, ${model.workers.length} workers. Shape is entity type, colour is health, size is weight. Switch to the list view for a keyboard-navigable version of the same data.`;

  return html`
    ${AGENCY_SURFACE_STYLES} ${AGENCY_TOPOLOGY_STYLES}
    <main class="agx ba-glass">
      ${baAurora()}
      <header class="agx-head">
        <div>
          <h1>Agency Topology</h1>
          <div class="agx-sub">
            Who the agency serves, what is being delivered, and who reports to whom —
            ${state.agencyName || "no agency selected"}.
          </div>
        </div>
        <div class="agx-head-tools">
          <span class="agx-stamp"
            >${state.lastLoadedAt ? `synced ${relativeTime(state.lastLoadedAt)}` : "not synced"}</span
          >
          <button
            type="button"
            class="agx-btn"
            ?disabled=${state.refreshing}
            aria-label="Refresh the agency topology"
            @click=${() => void loadAgencyTopology(host, client, { background: true })}
          >
            ${state.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      ${state.error ? html`<div class="agx-banner" role="alert">${state.error}</div>` : nothing}
      ${state.failedRequests.length
        ? html`<div class="agx-banner" role="status">
            <strong>${state.failedRequests.length} request(s) failed — this map is incomplete.</strong>
            <ul>
              ${state.failedRequests.map((entry) => html`<li>${entry}</li>`)}
            </ul>
          </div>`
        : nothing}

      ${!state.agencyId
        ? html`<div class="agx-empty">
            <strong>No agency to map</strong>
            <span
              >Create an agency in Agency Operations first; every client, project and worker on
              this map hangs off it.</span
            >
            ${host.setTab
              ? html`<button
                  type="button"
                  class="agx-btn"
                  @click=${() => host.setTab?.("agency-operations")}
                >
                  Open Agency Operations
                </button>`
              : nothing}
          </div>`
        : html`
            ${renderToolbar(host, state, model, hits ? hits.size : null)}
            ${state.focus ? renderFocusBar(host, state) : nothing}
            ${state.viewMode === "graph"
              ? html`
                  <div class="agx-stage">
                    <section class="agx-panel">
                      <header class="agx-panel-head">
                        <span>Topology map</span>
                        <span class="agx-count"
                          >${model.nodes.length} nodes · drag, scroll to zoom, double-click to
                          reset</span
                        >
                      </header>
                      ${renderLegend(model)}
                      <div class="agx-graph-frame" role="img" aria-label=${graphSummary}>
                        <div id=${GRAPH_CONTAINER_ID} class="agx-graph-canvas"></div>
                        ${!hasD3()
                          ? html`<div class="agx-graph-note">
                              The graph library (d3) is not available in this build — switch to
                              the List view for the same data.
                            </div>`
                          : nothing}
                      </div>
                    </section>
                    ${renderDetail(host, state, model, client)}
                  </div>
                `
              : html`
                  ${renderList(host, state, model)}
                  <div class="agx-stage" style="grid-template-columns:minmax(0,1fr)">
                    ${renderDetail(host, state, model, client)}
                  </div>
                `}
          `}
    </main>
  `;
}
