/**
 * Lead Engine controller.
 *
 * The server has carried a complete lead/CRM engine (`funnels.lead.*`,
 * `funnels.offer.*`, `funnels.task.*`, KPI metrics and an AI scoring/intent
 * engine) with no UI consumer at all — the only caller was the agent tool in
 * `src/agents/tools/funnel-tool.ts`. This controller is the browser-side
 * counterpart.
 *
 * Two conventions are load bearing here and are copied deliberately from
 * `agency-operations.ts` / `agency-funnel-ops.ts`:
 *
 *  1. Every request records its own failure. An empty panel and a panel we
 *     could not fetch must never render identically — that exact ambiguity
 *     previously hid a total data outage in this app.
 *  2. Responses are read through `unwrap()` rather than destructured, because
 *     the gateway sometimes nests payloads under `data`.
 *
 * ── A note on method names ───────────────────────────────────────────────────
 * Several names in `server-methods-list.ts` are declared but have NO handler in
 * `src/gateway/server-methods/funnels.ts`. Calling them returns
 * `INVALID_REQUEST: unknown method`. Each has a working equivalent that is
 * registered, so every call below goes through `callWithFallback()`: it tries
 * the canonical name first and falls back to the implemented one, recording the
 * substitution in `state.degraded` so the operator can see the surface is
 * running on a fallback. When the missing handlers are added server-side the
 * primary name starts winning with no UI change.
 *
 *   funnels.analyze        -> funnels.analytics
 *   funnels.stage.create   -> funnels.stage.add
 *   funnels.lead.activity  -> activities returned by funnels.lead.get
 *   funnels.task.list      -> funnels.task.getChecklist
 *   funnels.metric.log     -> funnels.kpi.log
 *   funnels.metric.get     -> funnels.kpi.get
 *
 * `funnels.generateSOP` and the four `funnels.ai.*` methods have no gateway
 * equivalent at all (the engine lives in `src/funnels/ai-engine.ts` and is only
 * reachable over MCP). They are still wired as explicit operator actions so the
 * failure is a visible, attributable error rather than a missing button.
 */

import type { GatewayBrowserClient } from "../gateway";

// ══════════════════════════════════════════════════════════════════════════════
// Types — mirror src/funnels/types.ts, kept browser-local on purpose
// ══════════════════════════════════════════════════════════════════════════════

export type LeadStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost"
  | "nurturing"
  | "disqualified";

export type LeadPriority = "low" | "medium" | "high" | "urgent";

export type LeadSource =
  | "website"
  | "referral"
  | "social"
  | "email"
  | "phone"
  | "advertisement"
  | "event"
  | "import"
  | "manual"
  | "other";

export type OfferType =
  | "lead_magnet"
  | "low_ticket"
  | "mid_ticket"
  | "high_ticket"
  | "product"
  | "service"
  | "subscription"
  | "bundle"
  | "custom";

export type OfferStatus = "draft" | "active" | "paused" | "expired" | "archived";

export type TaskType =
  | "follow_up"
  | "call"
  | "email"
  | "meeting"
  | "proposal"
  | "demo"
  | "review"
  | "custom";

export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Lead {
  id: string;
  businessId: string;
  funnelId: string;
  stageId: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  source: LeadSource;
  status: LeadStatus;
  priority: LeadPriority;
  score?: number;
  estimatedValue?: number;
  currency?: string;
  assignedTo?: string;
  tags?: string[];
  firstContactAt?: string;
  lastActivityAt?: string;
  expectedCloseDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadActivity {
  id: string;
  leadId: string;
  type: "note" | "email" | "call" | "meeting" | "task" | "stage_change" | "score_change" | "system";
  description: string;
  performedBy?: string;
  createdAt: string;
}

export interface Offer {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  type: OfferType;
  status: OfferStatus;
  price: number;
  currency: string;
  validUntil?: string;
  targetStages?: string[];
  targetTags?: string[];
  minScore?: number;
  features?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FunnelTask {
  id: string;
  businessId: string;
  funnelId?: string;
  leadId?: string;
  stageId?: string;
  title: string;
  description?: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo?: string;
  dueAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KpiMetric {
  id: string;
  businessId: string;
  funnelId?: string;
  stageId?: string;
  name: string;
  type: string;
  currentValue: number;
  previousValue?: number;
  changePercent?: number;
  unit?: string;
  period: string;
  calculatedAt: string;
}

export interface LeadStage {
  id: string;
  name: string;
  position: number;
  type?: string;
}

export interface LeadFunnelRef {
  id: string;
  name: string;
  businessId: string;
  status?: string;
}

export interface LeadBusinessRef {
  id: string;
  name: string;
}

/** Result of `funnels.lead.qualify` — the factor map is the whole point. */
export interface QualificationResult {
  leadId: string;
  isQualified: boolean;
  qualificationScore: number;
  maxScore: number;
  factors: Record<string, boolean>;
}

export interface FunnelAnalytics {
  totalLeads: number;
  newLeads: number;
  convertedLeads: number;
  lostLeads: number;
  overallConversionRate: number;
  totalValue: number;
  wonValue: number;
  lostValue: number;
  averageDealSize: number;
  leadsPerStage: Record<string, number>;
  valuePerStage: Record<string, number>;
  stageConversionRates: Record<string, number>;
}

export interface FunnelBottleneck {
  stageId: string;
  stageName: string;
  issue: string;
  severity: string;
}

export type LeadEngineSection = "pipeline" | "offers" | "tasks" | "metrics" | "intelligence";
export type PipelineLayout = "board" | "table";

export interface LeadDraft {
  name: string;
  email: string;
  phone: string;
  company: string;
  source: LeadSource;
  priority: LeadPriority;
  estimatedValue: string;
  tags: string;
  stageId: string;
}

export interface OfferDraft {
  id: string;
  name: string;
  description: string;
  type: OfferType;
  price: string;
  minScore: string;
  status: OfferStatus;
}

export interface TaskDraft {
  title: string;
  type: TaskType;
  priority: TaskPriority;
  dueAt: string;
  leadId: string;
}

export interface MetricDraft {
  name: string;
  value: string;
  type: string;
  period: string;
}

export interface LeadFilters {
  search: string;
  status: LeadStatus | "";
  priority: LeadPriority | "";
  source: LeadSource | "";
  minScore: string;
}

/** An operator-triggered AI/analysis run and whatever came back. */
export interface AiRunResult {
  method: string;
  label: string;
  ranAt: number;
  ok: boolean;
  detail: string;
  payload?: unknown;
}

export interface LeadEngineState {
  section: LeadEngineSection;
  layout: PipelineLayout;

  businesses: LeadBusinessRef[];
  funnels: LeadFunnelRef[];
  stages: LeadStage[];
  businessId: string | null;
  funnelId: string | null;

  leads: Lead[];
  leadTotal: number;
  offers: Offer[];
  tasks: FunnelTask[];
  metrics: KpiMetric[];
  analytics: FunnelAnalytics | null;
  bottlenecks: FunnelBottleneck[];

  selectedLeadId: string | null;
  selectedLeadActivities: LeadActivity[];
  qualification: QualificationResult | null;
  matchedOffers: Offer[];
  matchChecked: boolean;
  scoreDraft: string;

  filters: LeadFilters;
  leadDraft: LeadDraft | null;
  offerDraft: OfferDraft | null;
  taskDraft: TaskDraft | null;
  metricDraft: MetricDraft;

  aiRuns: AiRunResult[];

  loading: boolean;
  refreshing: boolean;
  detailLoading: boolean;
  busyId: string | null;
  error: string | null;
  notice: string | null;
  /** Methods that failed outright. Rendered so a panel is never silently empty. */
  failedRequests: string[];
  /** Canonical methods that are missing and are being served by a fallback. */
  degraded: string[];
  lastLoadedAt: number | null;
}

// ══════════════════════════════════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════════════════════════════════

function emptyFilters(): LeadFilters {
  return { search: "", status: "", priority: "", source: "", minScore: "" };
}

const state: LeadEngineState = {
  section: "pipeline",
  layout: "board",
  businesses: [],
  funnels: [],
  stages: [],
  businessId: null,
  funnelId: null,
  leads: [],
  leadTotal: 0,
  offers: [],
  tasks: [],
  metrics: [],
  analytics: null,
  bottlenecks: [],
  selectedLeadId: null,
  selectedLeadActivities: [],
  qualification: null,
  matchedOffers: [],
  matchChecked: false,
  scoreDraft: "",
  filters: emptyFilters(),
  leadDraft: null,
  offerDraft: null,
  taskDraft: null,
  metricDraft: { name: "", value: "", type: "count", period: "all_time" },
  aiRuns: [],
  loading: false,
  refreshing: false,
  detailLoading: false,
  busyId: null,
  error: null,
  notice: null,
  failedRequests: [],
  degraded: [],
  lastLoadedAt: null,
};

let client: GatewayBrowserClient | null = null;
let requestUpdate: (() => void) | null = null;
let loadGeneration = 0;

export function getLeadEngineState(): LeadEngineState {
  return state;
}

export function setLeadEngineClient(next: GatewayBrowserClient): void {
  client = next;
}

export function setLeadEngineRequestUpdate(fn: () => void): void {
  requestUpdate = fn;
}

function notify(): void {
  requestUpdate?.();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mutations are as fault isolated as panel loads: a rejected write must never
 * look like "nothing happened". The entry lands both on the inline error and in
 * the persistent failed-request list, which is the only place an operator can
 * see that a method is unavailable rather than merely returning nothing.
 */
function recordFailure(method: string, error: unknown): void {
  const entry = `${method} — ${message(error)}`;
  state.error = message(error);
  if (!state.failedRequests.includes(entry)) {
    state.failedRequests = [...state.failedRequests, entry];
  }
}

function recordDegraded(primary: string, fallback: string): void {
  const entry = `${primary} is not implemented on this gateway — served by ${fallback}`;
  if (!state.degraded.includes(entry)) state.degraded = [...state.degraded, entry];
}

/**
 * Reads a keyed payload out of a gateway response. Some handlers answer with
 * the value at the top level and some nest it under `data`, so both shapes are
 * probed before falling back.
 */
function unwrap<T>(value: unknown, key: string, fallback: T): T {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (key in record && record[key] !== undefined && record[key] !== null) {
      return record[key] as T;
    }
    const nested = record.data;
    if (nested && typeof nested === "object" && key in (nested as Record<string, unknown>)) {
      const inner = (nested as Record<string, unknown>)[key];
      if (inner !== undefined && inner !== null) return inner as T;
    }
  }
  return fallback;
}

function asArray<T>(value: unknown, key: string): T[] {
  const found = unwrap<unknown>(value, key, []);
  return Array.isArray(found) ? (found as T[]) : [];
}

function requireClient(): GatewayBrowserClient {
  if (!client) throw new Error("Lead engine gateway client is not initialised");
  return client;
}

/**
 * True when the failure means "nobody implements this method", as opposed to a
 * real error from a handler that does exist.
 *
 * There are two spellings and both must be caught. A standalone gateway answers
 * `unknown method: x`. A federation satellite proxies funnel writes to its
 * master first, so the same missing handler comes back as
 * `master has no handler for x` — miss that one and the fallback never fires,
 * which silently blanks every panel on a federated install.
 */
function isUnknownMethod(error: unknown): boolean {
  const text = message(error).toLowerCase();
  return (
    text.includes("unknown method") ||
    text.includes("method_not_found") ||
    text.includes("has no handler")
  );
}

/**
 * Calls `primary`, and if this gateway build simply does not register that
 * method, transparently retries the implemented equivalent. Any other error —
 * a real failure — propagates so the caller can record it.
 */
async function callWithFallback(
  primary: string,
  fallback: string | null,
  params: Record<string, unknown>,
): Promise<unknown> {
  const gateway = requireClient();
  try {
    return await gateway.request(primary, params);
  } catch (error) {
    if (!fallback || !isUnknownMethod(error)) throw error;
    recordDegraded(primary, fallback);
    return await gateway.request(fallback, params);
  }
}

/**
 * Issues one panel request, keeping a failure from rejecting the whole batch
 * while still recording it, so the view can say the panel is broken rather than
 * silently showing nothing.
 */
async function attempt(
  primary: string,
  fallback: string | null,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await callWithFallback(primary, fallback, params);
  } catch (error) {
    const entry = `${primary} — ${message(error)}`;
    if (!state.failedRequests.includes(entry)) {
      state.failedRequests = [...state.failedRequests, entry];
    }
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Normalisation
// ══════════════════════════════════════════════════════════════════════════════

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeLead(raw: unknown): Lead {
  const r = record(raw);
  return {
    ...(r as unknown as Lead),
    id: String(r.id ?? ""),
    businessId: String(r.businessId ?? ""),
    funnelId: String(r.funnelId ?? ""),
    stageId: String(r.stageId ?? ""),
    name: String(r.name ?? "Unnamed lead"),
    source: (r.source as LeadSource) ?? "manual",
    status: (r.status as LeadStatus) ?? "new",
    priority: (r.priority as LeadPriority) ?? "medium",
    score: typeof r.score === "number" ? r.score : undefined,
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : undefined,
    createdAt: String(r.createdAt ?? ""),
    updatedAt: String(r.updatedAt ?? ""),
  };
}

function normalizeOffer(raw: unknown): Offer {
  const r = record(raw);
  return {
    ...(r as unknown as Offer),
    id: String(r.id ?? ""),
    businessId: String(r.businessId ?? ""),
    name: String(r.name ?? "Untitled offer"),
    type: (r.type as OfferType) ?? "product",
    status: (r.status as OfferStatus) ?? "draft",
    price: typeof r.price === "number" ? r.price : 0,
    currency: String(r.currency ?? "USD"),
    createdAt: String(r.createdAt ?? ""),
    updatedAt: String(r.updatedAt ?? ""),
  };
}

function normalizeTask(raw: unknown): FunnelTask {
  const r = record(raw);
  return {
    ...(r as unknown as FunnelTask),
    id: String(r.id ?? ""),
    businessId: String(r.businessId ?? ""),
    title: String(r.title ?? "Untitled task"),
    type: (r.type as TaskType) ?? "follow_up",
    status: (r.status as TaskStatus) ?? "pending",
    priority: (r.priority as TaskPriority) ?? "normal",
    createdAt: String(r.createdAt ?? ""),
    updatedAt: String(r.updatedAt ?? ""),
  };
}

function normalizeMetric(raw: unknown): KpiMetric {
  const r = record(raw);
  return {
    ...(r as unknown as KpiMetric),
    id: String(r.id ?? ""),
    businessId: String(r.businessId ?? ""),
    name: String(r.name ?? "Unnamed metric"),
    type: String(r.type ?? "count"),
    currentValue: typeof r.currentValue === "number" ? r.currentValue : 0,
    period: String(r.period ?? "all_time"),
    calculatedAt: String(r.calculatedAt ?? ""),
  };
}

function normalizeStage(raw: unknown, index: number): LeadStage {
  const r = record(raw);
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? `Stage ${index + 1}`),
    position: typeof r.position === "number" ? r.position : index,
    type: typeof r.type === "string" ? r.type : undefined,
  };
}

function normalizeActivity(raw: unknown): LeadActivity {
  const r = record(raw);
  return {
    id: String(r.id ?? ""),
    leadId: String(r.leadId ?? ""),
    type: (r.type as LeadActivity["type"]) ?? "system",
    description: String(r.description ?? ""),
    performedBy: typeof r.performedBy === "string" ? r.performedBy : undefined,
    createdAt: String(r.createdAt ?? ""),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Loading
// ══════════════════════════════════════════════════════════════════════════════

function searchParams(): Record<string, unknown> {
  const f = state.filters;
  const params: Record<string, unknown> = {
    businessId: state.businessId ?? undefined,
    funnelId: state.funnelId ?? undefined,
    limit: 200,
    orderBy: "score",
    orderDir: "desc",
  };
  if (f.search.trim()) params.search = f.search.trim();
  if (f.status) params.status = f.status;
  if (f.priority) params.priority = f.priority;
  if (f.source) params.source = f.source;
  const min = Number(f.minScore);
  if (f.minScore.trim() && Number.isFinite(min)) params.minScore = min;
  return params;
}

/**
 * Loads every lead-engine panel for the selected funnel concurrently. A single
 * endpoint failing degrades one panel and is recorded; it never blanks the rest.
 */
export async function loadLeadEngine(options: { background?: boolean } = {}): Promise<void> {
  if (!client) return;
  const generation = ++loadGeneration;
  const background = options.background === true || state.lastLoadedAt !== null;
  state.loading = !background;
  state.refreshing = background;
  state.error = null;
  // A completed reload is the only honest signal that the surface is live
  // again, so stale failures are cleared here rather than accumulating forever.
  state.failedRequests = [];
  state.degraded = [];
  notify();

  try {
    if (!state.businessId || !state.funnelId) {
      await resolveScope();
      if (generation !== loadGeneration) return;
    }

    if (!state.businessId || !state.funnelId) {
      state.leads = [];
      state.offers = [];
      state.tasks = [];
      state.metrics = [];
      state.analytics = null;
      state.bottlenecks = [];
      state.stages = [];
      return;
    }

    const businessId = state.businessId;
    const funnelId = state.funnelId;

    const [funnelResult, leadsResult, offersResult, tasksResult, metricsResult, analyticsResult] =
      await Promise.all([
        attempt("funnels.get", null, { id: funnelId }),
        attempt("funnels.lead.search", null, searchParams()),
        attempt("funnels.offer.list", null, { businessId }),
        attempt("funnels.task.list", "funnels.task.getChecklist", { businessId, funnelId }),
        attempt("funnels.metric.get", "funnels.kpi.get", { businessId, funnelId }),
        attempt("funnels.analyze", "funnels.analytics", { id: funnelId }),
      ]);

    if (generation !== loadGeneration) return;

    const stages = asArray<unknown>(funnelResult, "stages");
    if (stages.length) state.stages = stages.map(normalizeStage);

    state.leads = asArray<unknown>(leadsResult, "leads").map(normalizeLead);
    state.leadTotal = unwrap<number>(leadsResult, "total", state.leads.length);
    state.offers = asArray<unknown>(offersResult, "offers").map(normalizeOffer);
    state.tasks = asArray<unknown>(tasksResult, "tasks").map(normalizeTask);
    state.metrics = asArray<unknown>(metricsResult, "metrics").map(normalizeMetric);
    state.analytics = unwrap<FunnelAnalytics | null>(analyticsResult, "analytics", null);
    state.bottlenecks = asArray<FunnelBottleneck>(analyticsResult, "bottlenecks");
    state.lastLoadedAt = Date.now();
  } catch (error) {
    // Not an RPC name: the batch itself failed before any request went out.
    recordFailure("lead engine load", error);
  } finally {
    if (generation === loadGeneration) {
      state.loading = false;
      state.refreshing = false;
      notify();
    }
  }
}

/** Picks a business and funnel to operate on when none has been chosen yet. */
async function resolveScope(): Promise<void> {
  const businessResult = await attempt("funnels.business.list", null, {});
  state.businesses = asArray<unknown>(businessResult, "businesses").map((raw) => {
    const r = record(raw);
    return { id: String(r.id ?? ""), name: String(r.name ?? "Untitled business") };
  });
  if (!state.businessId) state.businessId = state.businesses[0]?.id ?? null;

  const funnelResult = await attempt("funnels.list", null, {
    businessId: state.businessId ?? undefined,
    limit: 100,
  });
  state.funnels = asArray<unknown>(funnelResult, "funnels").map((raw) => {
    const r = record(raw);
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? "Untitled funnel"),
      businessId: String(r.businessId ?? ""),
      status: typeof r.status === "string" ? r.status : undefined,
    };
  });
  if (!state.funnelId) state.funnelId = state.funnels[0]?.id ?? null;
  // The funnel row carries the authoritative businessId; leads are FK-bound to
  // it, so a mismatched business selection would create orphan rows.
  const active = state.funnels.find((f) => f.id === state.funnelId);
  if (active?.businessId) state.businessId = active.businessId;
}

export function selectLeadBusiness(businessId: string): void {
  state.businessId = businessId || null;
  state.funnelId = null;
  state.selectedLeadId = null;
  notify();
  void loadLeadEngine({ background: true });
}

export function selectLeadFunnel(funnelId: string): void {
  state.funnelId = funnelId || null;
  const active = state.funnels.find((f) => f.id === funnelId);
  if (active?.businessId) state.businessId = active.businessId;
  state.selectedLeadId = null;
  state.stages = [];
  notify();
  void loadLeadEngine({ background: true });
}

export function setLeadSection(section: LeadEngineSection): void {
  state.section = section;
  notify();
}

export function setLeadLayout(layout: PipelineLayout): void {
  state.layout = layout;
  notify();
}

export function setLeadFilter<K extends keyof LeadFilters>(key: K, value: LeadFilters[K]): void {
  state.filters = { ...state.filters, [key]: value };
  notify();
}

export function clearLeadFilters(): void {
  state.filters = emptyFilters();
  notify();
  void searchLeads();
}

export function dismissLeadNotice(): void {
  state.notice = null;
  notify();
}

/** Re-runs only `funnels.lead.search`, so filtering does not refetch every panel. */
export async function searchLeads(): Promise<void> {
  if (!client || !state.funnelId) return;
  state.refreshing = true;
  notify();
  try {
    const result = await callWithFallback("funnels.lead.search", null, searchParams());
    state.leads = asArray<unknown>(result, "leads").map(normalizeLead);
    state.leadTotal = unwrap<number>(result, "total", state.leads.length);
  } catch (error) {
    recordFailure("funnels.lead.search", error);
  } finally {
    state.refreshing = false;
    notify();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Lead detail — get / activity timeline
// ══════════════════════════════════════════════════════════════════════════════

export async function selectLead(leadId: string | null): Promise<void> {
  state.selectedLeadId = leadId;
  state.qualification = null;
  state.matchedOffers = [];
  state.matchChecked = false;
  state.selectedLeadActivities = [];
  const lead = state.leads.find((l) => l.id === leadId);
  state.scoreDraft = lead?.score !== undefined ? String(lead.score) : "";
  notify();
  if (!leadId || !client) return;

  state.detailLoading = true;
  notify();
  try {
    // `funnels.lead.get` already returns the activity timeline alongside the
    // lead, which is why the never-implemented `funnels.lead.activity` can be
    // satisfied from the same round trip.
    const result = await callWithFallback("funnels.lead.get", null, { id: leadId });
    const fresh = unwrap<unknown>(result, "lead", null);
    if (fresh) {
      const normalized = normalizeLead(fresh);
      state.leads = state.leads.map((l) => (l.id === leadId ? normalized : l));
      state.scoreDraft = normalized.score !== undefined ? String(normalized.score) : "";
    }
    state.selectedLeadActivities = asArray<unknown>(result, "activities").map(normalizeActivity);
  } catch (error) {
    recordFailure("funnels.lead.get", error);
  } finally {
    state.detailLoading = false;
    notify();
  }
}

/** Explicit refresh of just the timeline, mapped to the declared activity RPC. */
export async function reloadLeadActivity(leadId: string): Promise<void> {
  if (!client) return;
  state.busyId = `activity:${leadId}`;
  notify();
  try {
    const result = await callWithFallback("funnels.lead.activity", "funnels.lead.get", {
      id: leadId,
      leadId,
    });
    state.selectedLeadActivities = asArray<unknown>(result, "activities").map(normalizeActivity);
    state.notice = `Timeline refreshed — ${state.selectedLeadActivities.length} entries.`;
  } catch (error) {
    recordFailure("funnels.lead.activity", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Lead create / update / score / qualify / match
// ══════════════════════════════════════════════════════════════════════════════

export function openLeadDraft(stageId?: string): void {
  state.leadDraft = {
    name: "",
    email: "",
    phone: "",
    company: "",
    source: "manual",
    priority: "medium",
    estimatedValue: "",
    tags: "",
    stageId: stageId ?? state.stages[0]?.id ?? "",
  };
  notify();
}

export function patchLeadDraft(patch: Partial<LeadDraft>): void {
  if (state.leadDraft) state.leadDraft = { ...state.leadDraft, ...patch };
  notify();
}

export function closeLeadDraft(): void {
  state.leadDraft = null;
  notify();
}

export async function createLead(): Promise<void> {
  const draft = state.leadDraft;
  if (!draft || !client || !state.businessId || !state.funnelId) return;
  if (!draft.name.trim()) {
    state.error = "A lead needs a name.";
    notify();
    return;
  }
  const stageId = draft.stageId || state.stages[0]?.id;
  if (!stageId) {
    state.error = "This funnel has no stages yet — add a stage before creating leads.";
    notify();
    return;
  }
  state.busyId = "lead:create";
  notify();
  const value = Number(draft.estimatedValue);
  try {
    const result = await callWithFallback("funnels.lead.create", null, {
      businessId: state.businessId,
      funnelId: state.funnelId,
      stageId,
      name: draft.name.trim(),
      email: draft.email.trim() || undefined,
      phone: draft.phone.trim() || undefined,
      company: draft.company.trim() || undefined,
      source: draft.source,
      estimatedValue: draft.estimatedValue.trim() && Number.isFinite(value) ? value : undefined,
      tags: draft.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    const created = unwrap<unknown>(result, "lead", null);
    if (created) {
      const lead = normalizeLead(created);
      state.leads = [lead, ...state.leads];
      state.leadTotal += 1;
      state.selectedLeadId = lead.id;
      state.notice = `Created lead “${lead.name}”.`;
      // The analytics snapshot in hand predates this lead, so the KPI row would
      // otherwise show a total that contradicts the board right next to it.
      void refreshAnalytics();
    }
    state.leadDraft = null;
  } catch (error) {
    recordFailure("funnels.lead.create", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

/** Re-reads the funnel analytics without disturbing any other panel. */
async function refreshAnalytics(): Promise<void> {
  if (!client || !state.funnelId) return;
  try {
    const result = await callWithFallback("funnels.analyze", "funnels.analytics", {
      id: state.funnelId,
    });
    const analytics = unwrap<FunnelAnalytics | null>(result, "analytics", null);
    if (analytics) state.analytics = analytics;
    state.bottlenecks = asArray<FunnelBottleneck>(result, "bottlenecks");
  } catch (error) {
    recordFailure("funnels.analyze", error);
  } finally {
    notify();
  }
}

/**
 * Optimistic patch with rollback: the row updates immediately and is restored
 * verbatim if the write is rejected, so the board never shows a value the
 * server refused.
 */
export async function updateLead(leadId: string, patch: Partial<Lead>): Promise<void> {
  if (!client) return;
  const previous = state.leads.find((l) => l.id === leadId);
  if (!previous) return;
  state.leads = state.leads.map((l) => (l.id === leadId ? { ...l, ...patch } : l));
  state.busyId = `lead:${leadId}`;
  notify();
  try {
    const result = await callWithFallback("funnels.lead.update", null, { id: leadId, ...patch });
    const fresh = unwrap<unknown>(result, "lead", null);
    if (fresh) {
      const lead = normalizeLead(fresh);
      state.leads = state.leads.map((l) => (l.id === leadId ? lead : l));
    }
    state.notice = "Lead updated.";
  } catch (error) {
    state.leads = state.leads.map((l) => (l.id === leadId ? previous : l));
    recordFailure("funnels.lead.update", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

export function setScoreDraft(value: string): void {
  state.scoreDraft = value;
  notify();
}

/** `funnels.lead.score` — writes a 0-100 score and logs a score_change activity. */
export async function scoreLead(leadId: string, score: number): Promise<void> {
  if (!client) return;
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    state.error = "Score must be a number between 0 and 100.";
    notify();
    return;
  }
  const previous = state.leads.find((l) => l.id === leadId);
  state.leads = state.leads.map((l) => (l.id === leadId ? { ...l, score } : l));
  state.busyId = `score:${leadId}`;
  notify();
  try {
    const result = await callWithFallback("funnels.lead.score", null, { id: leadId, score });
    const fresh = unwrap<unknown>(result, "lead", null);
    if (fresh) {
      const lead = normalizeLead(fresh);
      state.leads = state.leads.map((l) => (l.id === leadId ? lead : l));
    }
    state.notice = `Score set to ${score}.`;
    // The score is one of the qualification factors, so the previously shown
    // verdict is now stale rather than merely old.
    state.qualification = null;
    if (state.selectedLeadId === leadId) void reloadLeadActivity(leadId);
  } catch (error) {
    if (previous) state.leads = state.leads.map((l) => (l.id === leadId ? previous : l));
    recordFailure("funnels.lead.score", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

/** `funnels.lead.qualify` — returns the factor breakdown behind the verdict. */
export async function qualifyLead(leadId: string): Promise<void> {
  if (!client) return;
  state.busyId = `qualify:${leadId}`;
  state.error = null;
  notify();
  try {
    const result = await callWithFallback("funnels.lead.qualify", null, { id: leadId });
    const r = record(result);
    const payload = record(r.data && typeof r.data === "object" ? r.data : r);
    state.qualification = {
      leadId,
      isQualified: payload.isQualified === true,
      qualificationScore: Number(payload.qualificationScore ?? 0),
      maxScore: Number(payload.maxScore ?? 0),
      factors: record(payload.factors) as Record<string, boolean>,
    };
    // The handler promotes a passing "new" lead to "qualified", so the row in
    // hand is stale the moment the verdict comes back.
    if (state.qualification.isQualified) {
      state.leads = state.leads.map((l) =>
        l.id === leadId && l.status === "new" ? { ...l, status: "qualified" } : l,
      );
    }
    state.notice = state.qualification.isQualified
      ? "Lead qualified."
      : "Lead did not meet the qualification bar.";
  } catch (error) {
    recordFailure("funnels.lead.qualify", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

/** `funnels.lead.matchOffer` — active offers this lead is eligible for. */
export async function matchOffersForLead(leadId: string): Promise<void> {
  if (!client) return;
  state.busyId = `match:${leadId}`;
  notify();
  try {
    const result = await callWithFallback("funnels.lead.matchOffer", null, { id: leadId });
    state.matchedOffers = asArray<unknown>(result, "matchingOffers").map(normalizeOffer);
    state.matchChecked = true;
    state.notice = `${state.matchedOffers.length} offer(s) matched.`;
  } catch (error) {
    state.matchChecked = false;
    recordFailure("funnels.lead.matchOffer", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

/** Deletes nothing server-side; used by the E2E harness to clean up test rows. */
export async function archiveLead(leadId: string): Promise<void> {
  await updateLead(leadId, { status: "disqualified" });
}

// ══════════════════════════════════════════════════════════════════════════════
// Offers
// ══════════════════════════════════════════════════════════════════════════════

export function openOfferDraft(existing?: Offer): void {
  state.offerDraft = existing
    ? {
        id: existing.id,
        name: existing.name,
        description: existing.description ?? "",
        type: existing.type,
        price: String(existing.price ?? 0),
        minScore: existing.minScore !== undefined ? String(existing.minScore) : "",
        status: existing.status,
      }
    : {
        id: "",
        name: "",
        description: "",
        type: "product",
        price: "",
        minScore: "",
        status: "draft",
      };
  notify();
}

export function patchOfferDraft(patch: Partial<OfferDraft>): void {
  if (state.offerDraft) state.offerDraft = { ...state.offerDraft, ...patch };
  notify();
}

export function closeOfferDraft(): void {
  state.offerDraft = null;
  notify();
}

export async function saveOffer(): Promise<void> {
  const draft = state.offerDraft;
  if (!draft || !client || !state.businessId) return;
  if (!draft.name.trim()) {
    state.error = "An offer needs a name.";
    notify();
    return;
  }
  const price = Number(draft.price);
  if (!draft.id && !Number.isFinite(price)) {
    state.error = "Offer price must be a number.";
    notify();
    return;
  }
  const minScore = Number(draft.minScore);
  const params: Record<string, unknown> = {
    businessId: state.businessId,
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    type: draft.type,
    price: Number.isFinite(price) ? price : 0,
    minScore: draft.minScore.trim() && Number.isFinite(minScore) ? minScore : undefined,
  };
  state.busyId = "offer:save";
  notify();
  try {
    if (draft.id) {
      params.id = draft.id;
      params.status = draft.status;
      const result = await callWithFallback("funnels.offer.update", null, params);
      const fresh = unwrap<unknown>(result, "offer", null);
      if (fresh) {
        const offer = normalizeOffer(fresh);
        state.offers = state.offers.map((o) => (o.id === offer.id ? offer : o));
      }
      state.notice = "Offer updated.";
    } else {
      const result = await callWithFallback("funnels.offer.create", null, params);
      const fresh = unwrap<unknown>(result, "offer", null);
      if (fresh) state.offers = [normalizeOffer(fresh), ...state.offers];
      state.notice = "Offer created.";
    }
    state.offerDraft = null;
  } catch (error) {
    recordFailure(draft.id ? "funnels.offer.update" : "funnels.offer.create", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

/**
 * Activation goes through `funnels.offer.update` rather than the separate
 * `offer.toggle` handler so the status the operator sees is the status that was
 * sent, not a server-side flip we would have to guess at.
 */
export async function setOfferStatus(offerId: string, status: OfferStatus): Promise<void> {
  if (!client) return;
  const previous = state.offers.find((o) => o.id === offerId);
  if (!previous) return;
  state.offers = state.offers.map((o) => (o.id === offerId ? { ...o, status } : o));
  state.busyId = `offer:${offerId}`;
  notify();
  try {
    const result = await callWithFallback("funnels.offer.update", null, { id: offerId, status });
    const fresh = unwrap<unknown>(result, "offer", null);
    if (fresh) {
      const offer = normalizeOffer(fresh);
      state.offers = state.offers.map((o) => (o.id === offerId ? offer : o));
    }
    state.notice = `Offer ${status}.`;
  } catch (error) {
    state.offers = state.offers.map((o) => (o.id === offerId ? previous : o));
    recordFailure("funnels.offer.update", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Tasks
// ══════════════════════════════════════════════════════════════════════════════

export function openTaskDraft(leadId?: string): void {
  state.taskDraft = {
    title: "",
    type: "follow_up",
    priority: "normal",
    dueAt: "",
    leadId: leadId ?? "",
  };
  notify();
}

export function patchTaskDraft(patch: Partial<TaskDraft>): void {
  if (state.taskDraft) state.taskDraft = { ...state.taskDraft, ...patch };
  notify();
}

export function closeTaskDraft(): void {
  state.taskDraft = null;
  notify();
}

export async function createTask(): Promise<void> {
  const draft = state.taskDraft;
  if (!draft || !client || !state.businessId) return;
  if (!draft.title.trim()) {
    state.error = "A task needs a title.";
    notify();
    return;
  }
  state.busyId = "task:create";
  notify();
  try {
    const result = await callWithFallback("funnels.task.create", null, {
      businessId: state.businessId,
      funnelId: state.funnelId ?? undefined,
      leadId: draft.leadId || undefined,
      title: draft.title.trim(),
      type: draft.type,
      priority: draft.priority,
      // A date input yields YYYY-MM-DD; the store stores ISO strings.
      dueAt: draft.dueAt ? new Date(`${draft.dueAt}T00:00:00`).toISOString() : undefined,
    });
    const created = unwrap<unknown>(result, "task", null);
    if (created) state.tasks = [normalizeTask(created), ...state.tasks];
    state.taskDraft = null;
    state.notice = "Task created.";
  } catch (error) {
    recordFailure("funnels.task.create", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

export async function completeTask(taskId: string): Promise<void> {
  if (!client) return;
  const previous = state.tasks.find((t) => t.id === taskId);
  if (!previous) return;
  state.tasks = state.tasks.map((t) => (t.id === taskId ? { ...t, status: "completed" } : t));
  state.busyId = `task:${taskId}`;
  notify();
  try {
    const result = await callWithFallback("funnels.task.complete", null, { id: taskId });
    const fresh = unwrap<unknown>(result, "task", null);
    if (fresh) {
      const task = normalizeTask(fresh);
      state.tasks = state.tasks.map((t) => (t.id === taskId ? task : t));
    }
    state.notice = "Task completed.";
  } catch (error) {
    state.tasks = state.tasks.map((t) => (t.id === taskId ? previous : t));
    recordFailure("funnels.task.complete", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

export async function reloadTasks(): Promise<void> {
  if (!client || !state.businessId) return;
  state.busyId = "task:list";
  notify();
  try {
    const result = await callWithFallback("funnels.task.list", "funnels.task.getChecklist", {
      businessId: state.businessId,
      funnelId: state.funnelId ?? undefined,
    });
    state.tasks = asArray<unknown>(result, "tasks").map(normalizeTask);
  } catch (error) {
    recordFailure("funnels.task.list", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Metrics
// ══════════════════════════════════════════════════════════════════════════════

export function patchMetricDraft(patch: Partial<MetricDraft>): void {
  state.metricDraft = { ...state.metricDraft, ...patch };
  notify();
}

export async function logMetric(): Promise<void> {
  const draft = state.metricDraft;
  if (!client || !state.businessId) return;
  const value = Number(draft.value);
  if (!draft.name.trim() || !Number.isFinite(value)) {
    state.error = "A metric needs a name and a numeric value.";
    notify();
    return;
  }
  state.busyId = "metric:log";
  notify();
  try {
    const result = await callWithFallback("funnels.metric.log", "funnels.kpi.log", {
      businessId: state.businessId,
      funnelId: state.funnelId ?? undefined,
      name: draft.name.trim(),
      value,
      type: draft.type,
      period: draft.period,
    });
    const created = unwrap<unknown>(result, "metric", null);
    if (created) state.metrics = [normalizeMetric(created), ...state.metrics];
    state.metricDraft = { ...draft, name: "", value: "" };
    state.notice = "Metric logged.";
  } catch (error) {
    recordFailure("funnels.metric.log", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

export async function reloadMetrics(): Promise<void> {
  if (!client || !state.businessId) return;
  state.busyId = "metric:get";
  notify();
  try {
    const result = await callWithFallback("funnels.metric.get", "funnels.kpi.get", {
      businessId: state.businessId,
      funnelId: state.funnelId ?? undefined,
    });
    state.metrics = asArray<unknown>(result, "metrics").map(normalizeMetric);
  } catch (error) {
    recordFailure("funnels.metric.get", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Intelligence — analyze / generateSOP / AI engine
// ══════════════════════════════════════════════════════════════════════════════

function pushRun(run: AiRunResult): void {
  state.aiRuns = [run, ...state.aiRuns].slice(0, 12);
}

function summarize(payload: unknown): string {
  const r = record(payload);
  const body = record(r.data && typeof r.data === "object" ? r.data : r);
  const keys = Object.keys(body);
  if (!keys.length) return "The gateway accepted the call but returned no body.";
  return keys
    .slice(0, 6)
    .map((key) => {
      const value = body[key];
      if (Array.isArray(value)) return `${key}: ${value.length} item(s)`;
      if (value && typeof value === "object") return `${key}: object`;
      return `${key}: ${String(value)}`;
    })
    .join(" · ");
}

/**
 * Runs one operator-triggered intelligence method. Unlike the panel loads these
 * are explicit clicks, so both the success and the failure are appended to the
 * visible run log — including "unknown method", which is the honest answer for
 * the AI handlers that are registered but not implemented on this gateway.
 */
async function runIntelligence(
  method: string,
  fallback: string | null,
  label: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (!client) return;
  state.busyId = `ai:${method}`;
  state.error = null;
  notify();
  try {
    const result = await callWithFallback(method, fallback, params);
    pushRun({
      method,
      label,
      ranAt: Date.now(),
      ok: true,
      detail: summarize(result),
      payload: result,
    });
    state.notice = `${label} completed.`;
  } catch (error) {
    pushRun({ method, label, ranAt: Date.now(), ok: false, detail: message(error) });
    recordFailure(method, error);
  } finally {
    state.busyId = null;
    notify();
  }
}

export async function analyzeFunnel(): Promise<void> {
  if (!state.funnelId) return;
  await runIntelligence("funnels.analyze", "funnels.analytics", "Funnel analysis", {
    id: state.funnelId,
  });
  // Analysis is also the source of the KPI header, so fold the fresh numbers in.
  const latest = state.aiRuns[0];
  if (latest?.ok && latest.payload) {
    const analytics = unwrap<FunnelAnalytics | null>(latest.payload, "analytics", null);
    if (analytics) state.analytics = analytics;
    state.bottlenecks = asArray<FunnelBottleneck>(latest.payload, "bottlenecks");
    notify();
  }
}

export async function generateFunnelSOP(): Promise<void> {
  if (!state.funnelId) return;
  await runIntelligence("funnels.generateSOP", null, "SOP draft", { id: state.funnelId });
}

export async function suggestFunnelImprovements(): Promise<void> {
  if (!state.funnelId) return;
  await runIntelligence("funnels.ai.suggestImprovements", null, "Improvement suggestions", {
    funnelId: state.funnelId,
    id: state.funnelId,
  });
}

export async function classifyLeadIntent(leadId: string): Promise<void> {
  await runIntelligence("funnels.ai.classifyIntent", null, "Intent classification", {
    leadId,
    id: leadId,
  });
}

export async function generateLeadQuestions(leadId: string): Promise<void> {
  await runIntelligence("funnels.ai.generateQuestions", null, "Qualification questions", {
    leadId,
    id: leadId,
  });
}

export async function generateLeadResponse(leadId: string, type = "follow_up"): Promise<void> {
  await runIntelligence("funnels.ai.generateResponse", null, "Drafted response", {
    leadId,
    id: leadId,
    responseType: type,
  });
}

/** `funnels.stage.create` — adds a stage so an empty funnel can accept leads. */
export async function createStage(name: string): Promise<void> {
  if (!client || !state.funnelId || !name.trim()) return;
  state.busyId = "stage:create";
  notify();
  try {
    const result = await callWithFallback("funnels.stage.create", "funnels.stage.add", {
      funnelId: state.funnelId,
      name: name.trim(),
      type: "standard",
      position: state.stages.length,
    });
    const created = unwrap<unknown>(result, "stage", null);
    if (created) state.stages = [...state.stages, normalizeStage(created, state.stages.length)];
    state.notice = `Stage “${name.trim()}” added.`;
  } catch (error) {
    recordFailure("funnels.stage.create", error);
  } finally {
    state.busyId = null;
    notify();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Derived helpers used by the view
// ══════════════════════════════════════════════════════════════════════════════

export function getSelectedLead(): Lead | null {
  return state.leads.find((l) => l.id === state.selectedLeadId) ?? null;
}

export function leadsByStage(): Array<{ stage: LeadStage; leads: Lead[] }> {
  const ordered = [...state.stages].sort((a, b) => a.position - b.position);
  const columns = ordered.map((stage) => ({
    stage,
    leads: state.leads.filter((l) => l.stageId === stage.id),
  }));
  // Leads whose stage was deleted would otherwise vanish from the board with no
  // trace, which is the same silent-emptiness failure this surface exists to
  // avoid. They get an explicit column instead.
  const known = new Set(ordered.map((s) => s.id));
  const orphans = state.leads.filter((l) => !known.has(l.stageId));
  if (orphans.length) {
    columns.push({
      stage: { id: "__unassigned", name: "Unmapped stage", position: ordered.length },
      leads: orphans,
    });
  }
  return columns;
}

/** Moves a lead to another stage. Backs the board's keyboard move controls. */
export async function moveLeadToStage(leadId: string, stageId: string): Promise<void> {
  if (!client || !stageId || stageId === "__unassigned") return;
  const previous = state.leads.find((l) => l.id === leadId);
  if (!previous || previous.stageId === stageId) return;
  state.leads = state.leads.map((l) => (l.id === leadId ? { ...l, stageId } : l));
  state.busyId = `move:${leadId}`;
  notify();
  try {
    const result = await callWithFallback("funnels.lead.moveStage", null, {
      id: leadId,
      stageId,
    });
    const fresh = unwrap<unknown>(result, "lead", null);
    if (fresh) {
      const lead = normalizeLead(fresh);
      state.leads = state.leads.map((l) => (l.id === leadId ? lead : l));
    }
    const name = state.stages.find((s) => s.id === stageId)?.name ?? "stage";
    state.notice = `Moved “${previous.name}” to ${name}.`;
  } catch (error) {
    state.leads = state.leads.map((l) => (l.id === leadId ? previous : l));
    recordFailure("funnels.lead.moveStage", error);
  } finally {
    state.busyId = null;
    notify();
  }
}
