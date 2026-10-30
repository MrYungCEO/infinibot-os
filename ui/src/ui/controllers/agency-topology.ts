/**
 * Agency Topology controller.
 *
 * Builds one connected picture of the agency out of the live `agency.ops.*`
 * surface: the agency itself, its clients, the delivery projects under them, and
 * the workforce with its real manager hierarchy.
 *
 * Scale is the design constraint. A production agency here has 400+ client rows
 * and a force-directed layout dies long before that, so the graph is *scoped*
 * (active clients by default) and the scope is stated on screen rather than
 * silently applied — an operator must never think they are looking at
 * everything when they are looking at nine rows.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { Tab } from "../navigation";
import type {
  AgencyClient,
  AgencyEmployee,
  AgencyProjectSummary,
  WorkforceAssignment,
} from "./agency-operations";
import { attempt, errorMessage, resolveAgency, unwrap, type AgencyRef } from "./agency-common";

/** Which slice of the client book is drawn. Always surfaced in the UI. */
export type TopologyClientScope = "active" | "top" | "all" | "none";
export type TopologyViewMode = "graph" | "list";

export interface TopologyWorker extends AgencyEmployee {
  /** Real reporting line, read from `agency.ops.employee.detail`. */
  managerWorkerId: string | null;
}

export interface TopologySelection {
  kind: "agency" | "client" | "project" | "worker" | "aggregate";
  id: string;
}

/**
 * The referential neighbourhood of the selected node, read on demand from
 * `agency.ops.relations.*`. Only the fields the panel actually shows are typed;
 * the surface returns full rows.
 */
export interface TopologyRelations {
  key: string;
  loading: boolean;
  error: string | null;
  projects: Array<{ id: string; name: string; status: string }>;
  contacts: Array<{ id: string; name: string; email?: string | null; isPrimary?: boolean }>;
  tasks: Array<{ id: string; title: string; status: string }>;
  invoices: Array<{ id: string; status: string; totalCents?: number }>;
  totals: Record<string, number> | null;
  clientId: string | null;
  clientName: string | null;
}

export interface AgencyTopologyState {
  loadGeneration: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Methods that failed on the last load, so a blank panel is never ambiguous. */
  failedRequests: string[];
  lastLoadedAt: number | null;
  agencies: AgencyRef[];
  agencyId: string | null;
  agencyName: string;
  clients: AgencyClient[];
  projects: AgencyProjectSummary[];
  workers: TopologyWorker[];
  assignments: WorkforceAssignment[];
  /** True when at least one `employee.detail` call failed → hierarchy is partial. */
  hierarchyPartial: boolean;
  clientScope: TopologyClientScope;
  showProjects: boolean;
  showWorkforce: boolean;
  viewMode: TopologyViewMode;
  selection: TopologySelection | null;
  /** Free-text filter. Matches are highlighted; everything else is dimmed. */
  search: string;
  /** When set, the map is reduced to this node's neighbourhood. */
  focus: TopologySelection | null;
  /** Referential detail for the current selection (lazy, cached by key). */
  relations: TopologyRelations | null;
}

export interface AgencyTopologyHost {
  agencyTopologyState?: AgencyTopologyState | null;
  requestUpdate?: () => void;
  setTab?: (tab: Tab) => void;
}

/** How many clients the "top" scope keeps, ranked by revenue then activity. */
export const TOPOLOGY_TOP_CLIENTS = 12;

export function createAgencyTopologyState(): AgencyTopologyState {
  return {
    loadGeneration: 0,
    loading: false,
    refreshing: false,
    error: null,
    failedRequests: [],
    lastLoadedAt: null,
    agencies: [],
    agencyId: null,
    agencyName: "",
    clients: [],
    projects: [],
    workers: [],
    assignments: [],
    hierarchyPartial: false,
    clientScope: "active",
    showProjects: true,
    showWorkforce: true,
    viewMode: "graph",
    selection: null,
    search: "",
    focus: null,
    relations: null,
  };
}

export function ensureAgencyTopologyState(host: AgencyTopologyHost): AgencyTopologyState {
  if (!host.agencyTopologyState) host.agencyTopologyState = createAgencyTopologyState();
  return host.agencyTopologyState;
}

function notify(host: AgencyTopologyHost): void {
  host.requestUpdate?.();
}

export function setTopologyClientScope(
  host: AgencyTopologyHost,
  scope: TopologyClientScope,
): void {
  const state = ensureAgencyTopologyState(host);
  state.clientScope = scope;
  state.selection = null;
  state.focus = null;
  state.relations = null;
  notify(host);
}

export function setTopologyViewMode(host: AgencyTopologyHost, mode: TopologyViewMode): void {
  ensureAgencyTopologyState(host).viewMode = mode;
  notify(host);
}

export function toggleTopologyLayer(
  host: AgencyTopologyHost,
  layer: "projects" | "workforce",
): void {
  const state = ensureAgencyTopologyState(host);
  if (layer === "projects") state.showProjects = !state.showProjects;
  else state.showWorkforce = !state.showWorkforce;
  state.selection = null;
  state.focus = null;
  state.relations = null;
  notify(host);
}

export function selectTopologyNode(
  host: AgencyTopologyHost,
  selection: TopologySelection | null,
): void {
  const state = ensureAgencyTopologyState(host);
  state.selection = selection;
  const key = selection ? `${selection.kind}:${selection.id}` : "";
  if (state.relations && state.relations.key !== key) state.relations = null;
  notify(host);
}

export function setTopologySearch(host: AgencyTopologyHost, value: string): void {
  ensureAgencyTopologyState(host).search = value;
  notify(host);
}

/**
 * Isolates a node's neighbourhood, or clears the isolation. Focus is a view
 * concern, but it lives here so the list fallback can honour it too.
 */
export function setTopologyFocus(
  host: AgencyTopologyHost,
  focus: TopologySelection | null,
): void {
  const state = ensureAgencyTopologyState(host);
  state.focus =
    focus && state.focus && state.focus.kind === focus.kind && state.focus.id === focus.id
      ? null
      : focus;
  notify(host);
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

/**
 * Walks the selected client or project out to its real neighbours. This is the
 * cross-navigation the map itself cannot show: a client's tasks and invoices
 * are not nodes, but they are what tells you whether the client is healthy.
 */
export async function loadTopologyRelations(
  host: AgencyTopologyHost,
  client: GatewayBrowserClient,
  selection: TopologySelection,
): Promise<void> {
  const state = ensureAgencyTopologyState(host);
  const key = `${selection.kind}:${selection.id}`;
  if (!state.agencyId) return;
  if (state.relations && state.relations.key === key) return;
  if (selection.kind !== "client" && selection.kind !== "project") return;
  const agencyId = state.agencyId;
  state.relations = {
    key,
    loading: true,
    error: null,
    projects: [],
    contacts: [],
    tasks: [],
    invoices: [],
    totals: null,
    clientId: null,
    clientName: null,
  };
  notify(host);
  try {
    const raw =
      selection.kind === "client"
        ? await client.request("agency.ops.relations.client", { agencyId, clientId: selection.id })
        : await client.request("agency.ops.relations.project", {
            agencyId,
            projectId: selection.id,
          });
    // A newer selection (or agency) won the race — drop this answer.
    if (state.agencyId !== agencyId) return;
    if (!state.relations || state.relations.key !== key) return;
    const record = (raw ?? {}) as Record<string, unknown>;
    const linkedClient = (record.client ?? null) as Record<string, unknown> | null;
    state.relations = {
      key,
      loading: false,
      error: null,
      projects: asArray(record.projects).map((entry) => ({
        id: text(entry.id),
        name: text(entry.name, "Untitled project"),
        status: text(entry.status, "unknown"),
      })),
      contacts: asArray(record.contacts).map((entry) => ({
        id: text(entry.id),
        name: text(entry.name, "Unnamed contact"),
        email: typeof entry.email === "string" ? entry.email : null,
        isPrimary: entry.isPrimary === true,
      })),
      tasks: asArray(record.tasks).map((entry) => ({
        id: text(entry.id),
        title: text(entry.title, "Untitled task"),
        status: text(entry.status, "unknown"),
      })),
      invoices: asArray(record.invoices).map((entry) => ({
        id: text(entry.id),
        status: text(entry.status, "unknown"),
        totalCents: typeof entry.totalCents === "number" ? entry.totalCents : 0,
      })),
      totals:
        record.totals && typeof record.totals === "object"
          ? (record.totals as Record<string, number>)
          : null,
      clientId: linkedClient ? text(linkedClient.id) || null : null,
      clientName: linkedClient ? text(linkedClient.name) || null : null,
    };
  } catch (error) {
    if (state.relations && state.relations.key === key) {
      state.relations = { ...state.relations, loading: false, error: errorMessage(error) };
    }
  } finally {
    notify(host);
  }
}

/**
 * The clients drawn for the current scope. Kept here (not in the view) so the
 * graph, the list fallback and the "showing N of M" label can never disagree.
 */
export function scopedClients(state: AgencyTopologyState): AgencyClient[] {
  if (state.clientScope === "none") return [];
  if (state.clientScope === "all") return state.clients;
  if (state.clientScope === "active") {
    // Filter by the real pipeline status when the gateway provides it.
    // "in progress" is the canonical key from client-status.ts normalisation.
    // Older gateways omit pipelineStatus; fall back to the legacy rollup so
    // the view degrades gracefully rather than going blank.
    return state.clients.filter(
      (client) =>
        client.pipelineStatus === "in progress" ||
        (client.pipelineStatus === undefined && client.status === "active"),
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

/** Projects that belong to the visible clients, plus every unlinked project. */
export function scopedProjects(
  state: AgencyTopologyState,
  clients: AgencyClient[],
): AgencyProjectSummary[] {
  if (!state.showProjects) return [];
  const visible = new Set(clients.map((client) => client.id));
  return state.projects.filter(
    (project) =>
      project.status !== "cancelled" &&
      (!project.clientId || visible.has(project.clientId)),
  );
}

/**
 * Loads every layer concurrently. A partial failure keeps the previous snapshot
 * on screen and names the broken method instead of rendering an empty agency.
 */
export async function loadAgencyTopology(
  host: AgencyTopologyHost,
  client: GatewayBrowserClient,
  options: { background?: boolean } = {},
): Promise<void> {
  const state = ensureAgencyTopologyState(host);
  const generation = ++state.loadGeneration;
  const background = options.background === true || state.lastLoadedAt !== null;
  state.loading = !background;
  state.refreshing = background;
  state.error = null;
  notify(host);

  const failures: string[] = [];
  try {
    const { agencies, agencyId, agencyName } = await resolveAgency(client, failures);
    if (generation !== state.loadGeneration) return;
    state.agencies = agencies;
    state.agencyId = agencyId;
    state.agencyName = agencyName;
    if (!agencyId) {
      state.clients = [];
      state.projects = [];
      state.workers = [];
      state.assignments = [];
      state.failedRequests = failures;
      state.lastLoadedAt = Date.now();
      return;
    }

    const [clientsResult, projectsResult, employeesResult, assignmentsResult] = await Promise.all([
      attempt(client, failures, "agency.ops.clients.list", { agencyId }),
      attempt(client, failures, "agency.ops.projects.list", { agencyId }),
      attempt(client, failures, "agency.ops.employees.list", { agencyId, status: "active" }),
      attempt(client, failures, "agency.ops.assignments.list", { agencyId }),
    ]);
    if (generation !== state.loadGeneration || agencyId !== state.agencyId) return;

    state.clients = unwrap<AgencyClient[]>(clientsResult, "clients", state.clients);
    state.projects = unwrap<AgencyProjectSummary[]>(projectsResult, "projects", state.projects);
    state.assignments = unwrap<WorkforceAssignment[]>(
      assignmentsResult,
      "assignments",
      state.assignments,
    );

    const employees = unwrap<AgencyEmployee[]>(employeesResult, "employees", []);
    // employees.list resolves the manager's *name* but not their id, and an org
    // chart needs the edge. `employee.detail` is the only place the reporting
    // line is exposed, so fan out over the (small) workforce. Failures degrade
    // to a flat chart rather than losing the worker entirely.
    let hierarchyPartial = false;
    const workers = await Promise.all(
      employees.map(async (employee): Promise<TopologyWorker> => {
        try {
          const detail = await client.request("agency.ops.employee.detail", {
            agencyId,
            workerId: employee.id,
          });
          const record = unwrap<{ managerWorkerId?: string | null }>(detail, "employee", {});
          return { ...employee, managerWorkerId: record?.managerWorkerId ?? null };
        } catch {
          hierarchyPartial = true;
          return { ...employee, managerWorkerId: null };
        }
      }),
    );
    if (generation !== state.loadGeneration || agencyId !== state.agencyId) return;
    if (hierarchyPartial) {
      const entry = "agency.ops.employee.detail — reporting lines could not be read for every worker";
      if (!failures.includes(entry)) failures.push(entry);
    }
    state.hierarchyPartial = hierarchyPartial;
    state.workers = workers;
    state.failedRequests = failures;
    state.lastLoadedAt = Date.now();
  } catch (error) {
    if (generation === state.loadGeneration) {
      state.error = errorMessage(error);
      state.failedRequests = failures;
    }
  } finally {
    if (generation === state.loadGeneration) {
      state.loading = false;
      state.refreshing = false;
      notify(host);
    }
  }
}
