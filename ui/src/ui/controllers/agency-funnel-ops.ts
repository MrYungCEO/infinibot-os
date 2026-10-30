import type { GatewayBrowserClient } from "../gateway";
import { getBizFilter } from "../lib/biz-filter";

export type FunnelHealth = "healthy" | "warning" | "critical" | "unknown";

export interface AgencyFunnelSummary {
  id: string;
  name: string;
  kind: "core" | "sub";
  parentFunnelId?: string | null;
  status: string;
  health: FunnelHealth;
  conversionRate?: number;
  revenue?: number;
  leads?: number;
}

export interface AgencyFunnelNode {
  id: string;
  funnelId: string;
  name: string;
  kind: string;
  status: string;
  health: FunnelHealth;
}

export interface AgencyFunnelEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  status?: string;
}

export interface AgencyFunnelConnection {
  id: string;
  name: string;
  kind: string;
  status: FunnelHealth | "connected" | "disconnected";
  required: boolean;
  lastCheckedAt?: number | null;
  message?: string | null;
}

export interface AgencyFunnelKpi {
  id: string;
  name: string;
  value: number | null;
  target?: number | null;
  unit?: string;
  status?: FunnelHealth;
  funnelId?: string | null;
}

export interface AgencyFunnelGap {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description?: string;
  recommendedAction?: string;
  ownerWorkerId?: string | null;
}

export interface AgencyFunnelOverview {
  agencyId: string;
  healthScore: number;
  setupPercent: number;
  coreFunnel: AgencyFunnelSummary | null;
  subFunnels: AgencyFunnelSummary[];
  nodes: AgencyFunnelNode[];
  edges: AgencyFunnelEdge[];
  connections: AgencyFunnelConnection[];
  kpis: AgencyFunnelKpi[];
  gaps: AgencyFunnelGap[];
  generatedAt?: number;
}

/** Minimal employee shape needed to own a gap; the full roster lives elsewhere. */
export interface AgencyFunnelWorker {
  id: string;
  name: string;
  kind: "human" | "ai";
  role: string;
}

/** Draft for the connection editor. An empty `id` creates a new connection. */
export interface AgencyFunnelConnectionDraft {
  id: string;
  provider: string;
  connectionKey: string;
  status: "disconnected" | "configuring" | "connected" | "degraded" | "error";
}

export interface AgencyFunnelOpsState {
  agencyId: string | null;
  loading: boolean;
  checking: boolean;
  error: string | null;
  /**
   * Methods that failed, mirroring the Agency Operations surface: an empty
   * panel and a panel we could not fetch must never look the same.
   */
  failedRequests: string[];
  overview: AgencyFunnelOverview | null;
  workers: AgencyFunnelWorker[];
  /** Id of the entity currently being mutated, so only its control disables. */
  busyId: string | null;
  connectionDraft: AgencyFunnelConnectionDraft | null;
  /** Per-KPI reading drafts, keyed by KPI id. */
  kpiDrafts: Record<string, string>;
  /** Per-gap owner selections, keyed by gap id. */
  gapOwners: Record<string, string>;
  notice: string | null;
}

const state: AgencyFunnelOpsState = {
  agencyId: null,
  loading: false,
  checking: false,
  error: null,
  failedRequests: [],
  overview: null,
  workers: [],
  busyId: null,
  connectionDraft: null,
  kpiDrafts: {},
  gapOwners: {},
  notice: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every mutation routes its failure here so a rejected write is visible both
 * inline and in the persistent failure list, rather than looking like nothing
 * happened.
 */
function recordMutationFailure(method: string, error: unknown): void {
  const entry = `${method} — ${message(error)}`;
  state.error = message(error);
  if (!state.failedRequests.includes(entry)) {
    state.failedRequests = [...state.failedRequests, entry];
  }
}

let requestUpdate: (() => void) | null = null;

export function getAgencyFunnelOpsState(): AgencyFunnelOpsState {
  return state;
}

export function setAgencyFunnelOpsRequestUpdate(callback: () => void): void {
  requestUpdate = callback;
}

function notify(): void {
  requestUpdate?.();
}

function normalizeOverview(raw: unknown, agencyId: string): AgencyFunnelOverview {
  const source =
    raw && typeof raw === "object" && "overview" in raw
      ? (raw as { overview?: unknown }).overview
      : raw;
  const value = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  const normalizeFunnel = (
    item: unknown,
    fallbackKind: "core" | "sub",
  ): AgencyFunnelSummary => {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      ...(record as unknown as AgencyFunnelSummary),
      id: String(record.id ?? ""),
      name: String(record.name ?? "Untitled funnel"),
      kind: record.kind === "core" || record.kind === "sub" ? record.kind : fallbackKind,
      status: String(record.status ?? "draft"),
      health: String(record.health ?? record.healthStatus ?? "unknown") as FunnelHealth,
    };
  };
  const normalizeNode = (item: unknown): AgencyFunnelNode => {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      ...(record as unknown as AgencyFunnelNode),
      id: String(record.id ?? ""),
      funnelId: String(record.funnelId ?? ""),
      name: String(record.name ?? "Untitled step"),
      kind: String(record.kind ?? record.type ?? "step"),
      status: String(record.status ?? "draft"),
      health: String(record.health ?? record.healthStatus ?? "unknown") as FunnelHealth,
    };
  };
  return {
    agencyId,
    healthScore: Number(value.healthScore ?? 0),
    setupPercent: Number(value.setupPercent ?? 0),
    coreFunnel: value.coreFunnel
      ? {
          ...normalizeFunnel(value.coreFunnel, "core"),
          health: String(
            (value.coreFunnel as Record<string, unknown>).health ??
              value.healthStatus ??
              "unknown",
          ) as FunnelHealth,
        }
      : null,
    subFunnels: Array.isArray(value.subFunnels)
      ? value.subFunnels.map((item) => normalizeFunnel(item, "sub"))
      : [],
    nodes: Array.isArray(value.nodes) ? value.nodes.map(normalizeNode) : [],
    edges: Array.isArray(value.edges) ? (value.edges as AgencyFunnelEdge[]) : [],
    connections: Array.isArray(value.connections)
      ? (value.connections as AgencyFunnelConnection[])
      : [],
    kpis: Array.isArray(value.kpis) ? (value.kpis as AgencyFunnelKpi[]) : [],
    gaps: Array.isArray(value.gaps) ? (value.gaps as AgencyFunnelGap[]) : [],
    generatedAt: typeof value.generatedAt === "number" ? value.generatedAt : Date.now(),
  };
}

export async function loadAgencyFunnelOverview(
  client: GatewayBrowserClient,
  options: { force?: boolean } = {},
): Promise<void> {
  const agencyId = getBizFilter();
  if (!agencyId) {
    state.agencyId = null;
    state.overview = null;
    state.error = "Select an agency to load its live funnel system.";
    notify();
    return;
  }
  if (!options.force && state.loading) return;
  state.agencyId = agencyId;
  state.loading = true;
  state.error = null;
  // A completed reload is the only honest signal that the surface is live
  // again, so stale failures are cleared here rather than accumulating forever.
  state.failedRequests = [];
  notify();
  try {
    const result = await client.request("agency.ops.funnels.overview", { agencyId });
    state.overview = normalizeOverview(result, agencyId);
  } catch (error) {
    recordMutationFailure("agency.ops.funnels.overview", error);
  } finally {
    state.loading = false;
    notify();
  }
  // The gap queue can only assign an owner if it knows who works here. Fetched
  // separately so a roster failure never blanks the funnel map.
  try {
    const roster = await client.request("agency.ops.employees.list", {
      agencyId,
      status: "active",
    });
    const list =
      roster && typeof roster === "object" && "employees" in roster
        ? (roster as { employees?: unknown }).employees
        : roster;
    state.workers = Array.isArray(list)
      ? list.map((item) => {
          const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          return {
            id: String(record.id ?? ""),
            name: String(record.name ?? "Unnamed employee"),
            kind: record.kind === "ai" ? "ai" : "human",
            role: String(record.role ?? ""),
          };
        })
      : [];
  } catch (error) {
    recordMutationFailure("agency.ops.employees.list", error);
  }
  notify();
}

export function setAgencyFunnelKpiDraft(kpiId: string, value: string): void {
  state.kpiDrafts = { ...state.kpiDrafts, [kpiId]: value };
  notify();
}

export function setAgencyFunnelGapOwner(gapId: string, workerId: string): void {
  state.gapOwners = { ...state.gapOwners, [gapId]: workerId };
  notify();
}

export function openAgencyFunnelConnectionDraft(
  existing?: { id: string; name: string; kind: string; status: string },
): void {
  state.connectionDraft = existing
    ? {
        id: existing.id,
        // The overview flattens a connection to name/kind; those are the
        // provider and connection key the upsert handler expects back.
        provider: existing.name,
        connectionKey: existing.kind,
        status: (["disconnected", "configuring", "connected", "degraded", "error"].includes(
          existing.status,
        )
          ? existing.status
          : "configuring") as AgencyFunnelConnectionDraft["status"],
      }
    : { id: "", provider: "", connectionKey: "", status: "configuring" };
  notify();
}

export function patchAgencyFunnelConnectionDraft(
  patch: Partial<AgencyFunnelConnectionDraft>,
): void {
  if (state.connectionDraft) state.connectionDraft = { ...state.connectionDraft, ...patch };
  notify();
}

export function closeAgencyFunnelConnectionDraft(): void {
  state.connectionDraft = null;
  notify();
}

/** Creates or updates an integration on the core funnel. */
export async function saveAgencyFunnelConnection(client: GatewayBrowserClient): Promise<void> {
  const draft = state.connectionDraft;
  const agencyId = getBizFilter();
  if (!draft || !agencyId || state.busyId) return;
  if (!draft.provider.trim() || !draft.connectionKey.trim()) return;
  state.busyId = draft.id || "connection-new";
  state.error = null;
  notify();
  try {
    await client.request("agency.ops.funnels.connection.upsert", {
      agencyId,
      connection: {
        id: draft.id || undefined,
        provider: draft.provider.trim(),
        connectionKey: draft.connectionKey.trim(),
        status: draft.status,
      },
    });
    state.connectionDraft = null;
    state.notice = "Connection saved.";
    await loadAgencyFunnelOverview(client, { force: true });
  } catch (error) {
    recordMutationFailure("agency.ops.funnels.connection.upsert", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

/** Probes one integration and records the result against the funnel. */
export async function checkAgencyFunnelConnection(
  client: GatewayBrowserClient,
  connectionId: string,
): Promise<void> {
  const agencyId = getBizFilter();
  if (!agencyId || state.busyId) return;
  state.busyId = connectionId;
  state.error = null;
  notify();
  try {
    await client.request("agency.ops.funnels.connection.check", { agencyId, connectionId });
    await loadAgencyFunnelOverview(client, { force: true });
  } catch (error) {
    recordMutationFailure("agency.ops.funnels.connection.check", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

/** Records a fresh reading against a KPI definition. */
export async function recordAgencyFunnelKpi(
  client: GatewayBrowserClient,
  kpiId: string,
): Promise<void> {
  const agencyId = getBizFilter();
  const raw = state.kpiDrafts[kpiId] ?? "";
  if (!agencyId || state.busyId || raw.trim() === "") return;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    state.error = "A KPI reading must be a number.";
    notify();
    return;
  }
  state.busyId = kpiId;
  state.error = null;
  notify();
  try {
    await client.request("agency.ops.funnels.kpi.record", { agencyId, kpiId, value });
    const { [kpiId]: _cleared, ...remaining } = state.kpiDrafts;
    state.kpiDrafts = remaining;
    await loadAgencyFunnelOverview(client, { force: true });
  } catch (error) {
    recordMutationFailure("agency.ops.funnels.kpi.record", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

/**
 * Gives a detected gap a real owner. The funnel store computes gaps rather than
 * storing an assignee, so ownership is expressed the way the rest of the agency
 * expresses it: as a work item in that employee's durable inbox. The gap id is
 * the idempotency key, so re-assigning the same gap does not pile up duplicates.
 */
export async function assignAgencyFunnelGap(
  client: GatewayBrowserClient,
  gap: AgencyFunnelGap,
): Promise<void> {
  const agencyId = getBizFilter();
  const workerId = state.gapOwners[gap.id] ?? "";
  if (!agencyId || !workerId || state.busyId) return;
  state.busyId = gap.id;
  state.error = null;
  notify();
  try {
    await client.request("agency.ops.employee.work-item.create", {
      agencyId,
      workerId,
      title: `Funnel gap: ${gap.title}`,
      instructions: gap.recommendedAction ?? gap.description ?? "Close this funnel readiness gap.",
      priority: gap.severity === "critical" || gap.severity === "high" ? "high" : "normal",
      scheduledFor: Date.now(),
      idempotencyKey: `funnel-gap:${gap.id}`,
      context: { source: "funnel-gap", gapId: gap.id, severity: gap.severity },
    });
    const owner = state.workers.find((worker) => worker.id === workerId);
    state.notice = `Assigned "${gap.title}" to ${owner?.name ?? workerId}.`;
  } catch (error) {
    recordMutationFailure("agency.ops.employee.work-item.create", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

export async function checkAgencyFunnelHealth(client: GatewayBrowserClient): Promise<void> {
  const agencyId = getBizFilter();
  if (!agencyId || state.checking) return;
  state.checking = true;
  state.error = null;
  notify();
  try {
    const result = await client.request("agency.ops.funnels.health.check", { agencyId });
    state.overview = normalizeOverview(result, agencyId);
  } catch (error) {
    recordMutationFailure("agency.ops.funnels.health.check", error);
  } finally {
    state.checking = false;
    notify();
  }
}

export async function bootstrapAgencyCoreFunnel(client: GatewayBrowserClient): Promise<void> {
  const agencyId = getBizFilter();
  if (!agencyId || state.checking) return;
  state.checking = true;
  state.error = null;
  notify();
  const sourceId = crypto.randomUUID();
  const nurtureId = crypto.randomUUID();
  const exitId = crypto.randomUUID();
  try {
    const result = await client.request("agency.ops.funnels.map.upsert", {
      agencyId,
      name: "Agency Core Client Journey",
      description: "The authoritative demand-to-delivery journey for this agency.",
      objective: "Turn qualified demand into successful, retained clients.",
      nodes: [
        { id: sourceId, nodeType: "source", name: "Qualified demand", sortOrder: 0 },
        { id: nurtureId, nodeType: "action", name: "Sales and trust sequence", sortOrder: 1 },
        { id: exitId, nodeType: "exit", name: "Client won and onboarded", sortOrder: 2 },
      ],
      edges: [
        { sourceNodeId: sourceId, targetNodeId: nurtureId },
        { sourceNodeId: nurtureId, targetNodeId: exitId },
      ],
    });
    state.overview = normalizeOverview(result, agencyId);
  } catch (error) {
    recordMutationFailure("agency.ops.funnels.map.upsert", error);
  } finally {
    state.checking = false;
    notify();
  }
}
